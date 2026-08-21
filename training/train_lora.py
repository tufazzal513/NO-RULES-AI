#!/usr/bin/env python3
"""
train_lora.py — fine-tune YOUR OWN personal AI (one command, fully automatic).

This is the "big brain" step. It fine-tunes an open-source model (Qwen, Llama,
Gemma, Sarvam-1 …) with LoRA/QLoRA on Bangla + English chat data, so the result
speaks like you and runs 100% on your own hardware. No company's API involved.

⏱️  TIME BUDGET — the headline feature
    --time-budget-hours 3
Give it the hours you have (1–5 on a free Colab T4). The script measures the
real speed of your GPU on your data, computes how many steps fit, sets the
learning-rate schedule to that number, and stops on the clock — so training
always finishes cleanly with a saved, usable model inside your budget.

ONE command can do ALL of this:
  1. Build a Bangla+English mix from Hugging Face   (--recipe balanced)
  2. Merge your own exported chats into it          (--extra-jsonl, repeatable)
  3. Convert everything to train/val JSONL          (saved to data/ for reuse)
  4. LoRA/QLoRA fine-tune inside a wall-clock budget (--time-budget-hours)
  5. Save adapter + merged model + GGUF for Ollama  (--export-gguf)
  6. Answer test prompts in বাংলা / English / Banglish so you SEE it works

Examples
--------
  # Recommended — 3 hours, Bangla+English, own data merged, Ollama export:
  python train_lora.py --recipe balanced --time-budget-hours 3 \
      --extra-jsonl myai-dataset.jsonl \
      --extra-jsonl bangla-english-banglish-chat.jsonl \
      --output ./my-ai-model --export-gguf

  # Fast first try (about 1 hour):
  python train_lora.py --recipe basic --time-budget-hours 1 --model unsloth/Qwen2.5-1.5B-Instruct

  # Classic mode — train from a ready train.jsonl:
  python train_lora.py --train data/train.jsonl --val data/val.jsonl --time-budget-hours 2

Prerequisites (run once):
    pip install unsloth "unsloth[colab-new]" datasets trl transformers
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import random
import shutil
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 0. OOM guards — these MUST be set before torch/unsloth is imported
# ---------------------------------------------------------------------------
# `expandable_segments` lets the CUDA allocator grow/shrink a single arena
# instead of fragmenting into unusable blocks. On a 16 GB T4 this alone is the
# difference between "CUDA out of memory" at step ~40 and a clean 3-hour run.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# HF tokenizers forking after CUDA init is a classic Colab RAM killer.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# ---------------------------------------------------------------------------
# Model presets — what actually fits in 1–5 hours on a free Colab T4
# ---------------------------------------------------------------------------

MODEL_PRESETS = {
    # name                              params  note
    "unsloth/Qwen2.5-1.5B-Instruct": "🇧🇩+🇬🇧 fast, solid Bangla — default",
    "unsloth/Qwen2.5-3B-Instruct": "🇧🇩+🇬🇧 better answers, ~2× slower",
    "unsloth/Qwen2.5-0.5B-Instruct": "tiny + very fast, basic chat only",
    "unsloth/gemma-2-2b-it": "good multilingual alternative",
    "unsloth/Llama-3.2-1B-Instruct": "lightest, weaker Bangla",
    "sarvamai/sarvam-1": "Indic base model (no chat template, needs more data)",
}

DEFAULT_TEST_PROMPTS = [
    "তোমার নাম কী এবং তুমি কী কী করতে পারো?",
    "বাংলাদেশের রাজধানী কোথায়? দুই লাইনে বলো।",
    "Explain photosynthesis to a 10-year-old in 3 sentences.",
    "amar mon kharap, ki korte pari?",
    "একটি ইমেইল লিখো: অফিসে এক দিনের ছুটি চেয়ে।",
]

CHATML_TEMPLATE = (
    "{% for message in messages %}"
    "{{'<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n'}}"
    "{% endfor %}"
    "{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}"
)

SYSTEM_PROMPT = (
    "You are the user's own personal AI assistant. You understand and reply in "
    "English, বাংলা and Banglish (romanised Bangla) — always answer in the same "
    "language and script the user wrote in. Be accurate, concise and helpful. "
    "If you do not know something, say so honestly."
)


def load_unsloth():
    try:
        from unsloth import FastLanguageModel
        import torch
        from datasets import Dataset
        return FastLanguageModel, torch, Dataset
    except ImportError as exc:
        raise SystemExit(
            "Unsloth is not installed. Run:\n"
            "  pip install unsloth 'unsloth[colab-new]' datasets trl\n\n" + str(exc)
        )


# ---------------------------------------------------------------------------
# 0b. MEMORY — everything that keeps a free T4 / P100 from dying with OOM
# ---------------------------------------------------------------------------

OOM_MARKERS = (
    "out of memory",
    "cuda oom",
    "cublas_status_alloc_failed",
    "cudnn_status_alloc_failed",
    "not enough memory",
    "can't allocate memory",
    "defaultcpuallocator",
)


def is_oom_error(exc: BaseException) -> bool:
    """True for CUDA *and* host-RAM allocation failures, on any torch version."""
    if isinstance(exc, MemoryError):
        return True
    name = type(exc).__name__.lower()
    if "outofmemory" in name:
        return True
    text = f"{exc}".lower()
    return any(marker in text for marker in OOM_MARKERS)


def free_memory(torch=None, label: str = "") -> None:
    """Release everything Python and CUDA are still holding on to.

    `del trainer` on its own is NOT enough: the optimizer states, the gradient
    buffers and the autograd graph sit in reference cycles, so they only go
    away after an explicit gc pass. Skipping this is why a second trainer
    (the speed probe → the real run) used to OOM on a 16 GB card.
    """
    for _ in range(2):
        gc.collect()
    if torch is not None:
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
                torch.cuda.reset_peak_memory_stats()
        except Exception:
            pass
    gc.collect()
    if label:
        print(f"🧹 memory freed ({label}){gpu_memory_note(torch)}")


def gpu_memory_note(torch=None) -> str:
    if torch is None:
        return ""
    try:
        if not torch.cuda.is_available():
            return ""
        free_b, total_b = torch.cuda.mem_get_info()
        return f" — GPU {free_b / 1e9:.1f} GB free of {total_b / 1e9:.1f} GB"
    except Exception:
        return ""


def gpu_total_gb(torch) -> float:
    try:
        if not torch.cuda.is_available():
            return 0.0
        return torch.cuda.get_device_properties(0).total_memory / 1e9
    except Exception:
        return 0.0


def host_ram_gb() -> float:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
    except Exception:
        return 0.0


# Safe ceilings per GPU size. These are CAPS, never upgrades: an explicit
# --batch-size / --max-seq-length is respected unless it cannot possibly fit.
VRAM_CAPS = [
    # (max GB this rule applies to, batch, seq-len, note)
    (9.0, 1, 512, "small GPU (<10 GB)"),
    (13.0, 1, 768, "12 GB class GPU"),
    (17.0, 2, 1024, "T4 / V100 16 GB"),
    (25.0, 4, 1536, "L4 / A10 24 GB"),
    (10 ** 6, 8, 2048, "big GPU"),
]


def apply_memory_caps(args, torch) -> None:
    """Lower (never raise) batch/seq to what this specific GPU can hold."""
    if not args.autotune:
        return
    total = gpu_total_gb(torch)
    if total <= 0:
        return
    batch_cap, seq_cap, note = next(
        (b, s, n) for limit, b, s, n in VRAM_CAPS if total <= limit
    )
    # A 3B+ model in 4-bit needs roughly twice the activation room of a 1.5B.
    name = args.model.lower()
    if any(tag in name for tag in ("-3b", "-4b", "-7b", "-8b", "-9b", "-12b")):
        batch_cap = max(1, batch_cap // 2)
        if total <= 17.0:
            seq_cap = min(seq_cap, 768)
    if not args.load_in_4bit:
        batch_cap = max(1, batch_cap // 2)

    changed = []
    if args.batch_size > batch_cap:
        # Keep the effective batch (and therefore the LR schedule) identical.
        factor = max(1, args.batch_size // batch_cap)
        args.grad_accum = max(1, args.grad_accum * factor)
        changed.append(f"batch {args.batch_size}→{batch_cap} (grad-accum ×{factor})")
        args.batch_size = batch_cap
    if args.max_seq_length > seq_cap:
        changed.append(f"max-seq-length {args.max_seq_length}→{seq_cap}")
        args.max_seq_length = seq_cap

    print(f"\n🧠 GPU: {torch.cuda.get_device_name(0)} — {total:.1f} GB VRAM"
          f" · RAM {host_ram_gb():.1f} GB  [{note}]")
    if changed:
        print("   ⚙️  OOM-safe auto-tune: " + ", ".join(changed))
        print("   (বন্ধ করতে: --no-autotune)")
    else:
        print(f"   ✅ settings fit: batch {args.batch_size} × grad-accum "
              f"{args.grad_accum} × seq {args.max_seq_length}")


def shrink_for_oom(args) -> str | None:
    """One rung down the memory ladder. Returns a description, or None if we
    are already at the smallest possible configuration.

    Ordered cheapest-loss-first: monitoring, then throughput, then the things
    that actually change what the model sees.
    """
    if args.eval_enabled:
        args.eval_enabled = False
        return "evaluation off (eval is the biggest single memory spike)"
    if args.batch_size > 1:
        args.grad_accum *= 2
        args.batch_size //= 2
        return (f"batch → {args.batch_size} (grad-accum → {args.grad_accum}, "
                "effective batch unchanged)")
    if args.packing:
        args.packing = False
        return "packing off (shorter, padded sequences use less peak memory)"
    if args.max_seq_length > 384:
        args.max_seq_length = max(384, args.max_seq_length - 256)
        return f"max-seq-length → {args.max_seq_length}"
    if args.grad_accum > 1:
        args.grad_accum = max(1, args.grad_accum // 2)
        return f"grad-accum → {args.grad_accum} (smaller effective batch)"
    return None




# ---------------------------------------------------------------------------
# 1. DATA
# ---------------------------------------------------------------------------

def _import_helpers():
    import sys
    script_dir = str(Path(__file__).resolve().parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)


def _rows_from_jsonl(path: str, required: bool = False) -> list[dict]:
    _import_helpers()
    from build_mix import rows_from_record, detect_lang
    p = Path(path)
    if not p.exists():
        if required:
            raise SystemExit(f"Training file not found: {path}")
        print(f"⚠️  Skipping missing file: {path}")
        return []
    rows: list[dict] = []
    with p.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            for row in rows_from_record(record):
                row.setdefault("lang", detect_lang(row["instruction"] + " " + row["output"]))
                row.setdefault("src", p.name)
                rows.append(row)
    print(f"📄 {path}: {len(rows)} rows")
    return rows


def collect_rows(args) -> tuple[list[dict], list[dict]]:
    """Build (train_rows, val_rows) from a recipe and/or explicit files."""
    _import_helpers()

    # A) Recipe mode — download + mix Bangla/English automatically.
    if args.recipe:
        import types
        from build_mix import build as build_mix, summarise, write_jsonl
        ns = types.SimpleNamespace(
            recipe=args.recipe,
            budget_hours=args.time_budget_hours or 3.0,
            rows=args.rows,
            extra_jsonl=args.extra_jsonl,
            own_repeat=args.own_repeat,
            assistant_name=args.assistant_name,
            owner_name=args.owner_name,
            val_ratio=args.val_ratio,
            seed=args.seed,
        )
        train_rows, val_rows = build_mix(ns)
        out = Path(args.dataset_out)
        write_jsonl(train_rows, out / "train.jsonl")
        write_jsonl(val_rows, out / "val.jsonl")
        summarise(train_rows, "📊 TRAIN")
        return train_rows, val_rows

    # B) Explicit files / legacy HF flags.
    rows: list[dict] = []
    if args.train:
        rows += _rows_from_jsonl(args.train, required=True)
    if args.hf_dataset:
        from build_mix import load_source, RECIPES
        rows += load_source(
            {"id": args.hf_dataset, "split": args.hf_split, "weight": 1.0},
            args.hf_limit, "any", RECIPES["balanced"]["max_output_chars"], set(),
        )
    for extra in args.extra_jsonl or []:
        rows += _rows_from_jsonl(extra)

    if not rows:
        raise SystemExit(
            "No training data! Use one of:\n"
            "  --recipe balanced                 (auto Bangla+English mix)\n"
            "  --train data/train.jsonl\n"
            "  --extra-jsonl myai-dataset.jsonl"
        )

    if args.val:
        val_rows = _rows_from_jsonl(args.val)
        train_rows = rows
    else:
        random.Random(args.seed).shuffle(rows)
        n_val = min(500, max(1, int(len(rows) * args.val_ratio))) if len(rows) > 20 else 0
        val_rows, train_rows = rows[:n_val], rows[n_val:]

    out = Path(args.dataset_out)
    out.mkdir(parents=True, exist_ok=True)
    for name, data in (("train.jsonl", train_rows), ("val.jsonl", val_rows)):
        with (out / name).open("w", encoding="utf-8") as fh:
            for row in data:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"✅ Dataset: {len(train_rows)} train / {len(val_rows)} val → {out}/")
    return train_rows, val_rows


def to_chat_dataset(rows, Dataset, use_system: bool):
    def convert(row):
        messages = []
        if use_system:
            messages.append({"role": "system", "content": SYSTEM_PROMPT})
        user = row.get("instruction", "")
        context = row.get("input", "")
        if context:
            user = f"{user}\n\n{context}"
        messages.append({"role": "user", "content": user})
        messages.append({"role": "assistant", "content": row.get("output", "")})
        return {"messages": messages}

    return Dataset.from_list([convert(r) for r in rows])


def to_text_dataset(rows, tokenizer, Dataset, use_system: bool, drain: bool = True):
    """Rows → a single-column {"text": ...} Dataset, in ONE low-memory pass.

    The old path built a `messages` column, wrapped it in a Dataset and then
    `.map()`-ed it into `text` — three full copies of the corpus in RAM at the
    same time, which is what killed Colab's 12.7 GB before training even
    started. Here each row is templated immediately and (with `drain`) dropped
    from the source list, so peak RAM stays close to one copy.
    """
    texts: list[str] = []
    total = len(rows)
    for i in range(total):
        row = rows[i]
        if drain:
            rows[i] = None  # free the source row as soon as it is templated
        messages = []
        if use_system:
            messages.append({"role": "system", "content": SYSTEM_PROMPT})
        user = row.get("instruction", "")
        context = row.get("input", "")
        if context:
            user = f"{user}\n\n{context}"
        messages.append({"role": "user", "content": user})
        messages.append({"role": "assistant", "content": row.get("output", "")})
        try:
            texts.append(tokenizer.apply_chat_template(messages, tokenize=False))
        except Exception:
            texts.append("".join(f"{m['role']}: {m['content']}\n" for m in messages))
        if drain and i % 2000 == 0:
            gc.collect()
    if drain:
        del rows[:]
    ds = Dataset.from_dict({"text": texts})
    del texts
    gc.collect()
    return ds



# ---------------------------------------------------------------------------
# 2. TIME BUDGET
# ---------------------------------------------------------------------------

def make_time_callback(deadline_ts: float, label: str = "budget"):
    """Stop training cleanly when the wall-clock budget is spent."""
    from transformers import TrainerCallback

    class TimeBudgetCallback(TrainerCallback):
        def __init__(self):
            self.start = time.time()
            self.last_report = 0.0

        def on_step_end(self, args, state, control, **kwargs):
            now = time.time()
            if now >= deadline_ts:
                print(f"\n⏰ Time {label} reached at step {state.global_step} — "
                      "stopping cleanly and saving the model.")
                control.should_training_stop = True
                control.should_save = True
            elif now - self.last_report > 300:  # every 5 minutes
                self.last_report = now
                left = (deadline_ts - now) / 60
                done = state.global_step
                total = state.max_steps or 0
                pct = f"{done * 100 // total}%" if total else "?"
                print(f"   ⏳ step {done}/{total} ({pct}) — {left:.0f} min left in budget")
            return control

    return TimeBudgetCallback()


def measure_seconds_per_step(model, tokenizer, dataset, args, torch, probe_steps: int) -> float:
    """Run a handful of throwaway steps to learn how fast THIS GPU really is.

    Doubles as an OOM canary: if the configuration cannot fit, we find out in
    ~30 seconds instead of 40 minutes into the real run.
    """
    print(f"\n⏱️  Speed probe — running {probe_steps} steps to measure your GPU…"
          f"{gpu_memory_note(torch)}")
    probe_ds = dataset.select(range(min(len(dataset), probe_steps * 16 + 32)))
    cfg = build_sft_config(args, torch, max_steps=probe_steps, output_dir=str(Path(args.output) / "_probe"),
                           warmup_steps=0, save_steps=10 ** 9, eval_dataset=None, logging_steps=probe_steps)
    trainer = make_trainer(model, tokenizer, probe_ds, None, cfg)
    start = time.time()
    try:
        trainer.train()
        elapsed = time.time() - start
    finally:
        # Order matters: kill the optimizer/grad state BEFORE the gc pass,
        # otherwise several GB stay pinned on the GPU for the real run.
        try:
            trainer.model.zero_grad(set_to_none=True)
        except Exception:
            pass
        for attr in ("optimizer", "lr_scheduler", "accelerator", "model_wrapped"):
            try:
                setattr(trainer, attr, None)
            except Exception:
                pass
        del trainer, cfg, probe_ds
        free_memory(torch, "after speed probe")
        shutil.rmtree(Path(args.output) / "_probe", ignore_errors=True)
    per_step = elapsed / max(1, probe_steps)
    print(f"⏱️  ≈{per_step:.2f} s/step on this GPU "
          f"(batch {args.batch_size} × grad-accum {args.grad_accum})")
    return per_step



# ---------------------------------------------------------------------------
# 3. TRAINING CONFIG
# ---------------------------------------------------------------------------

def _filter_kwargs(cls, kwargs: dict) -> dict:
    """Keep only the arguments this installed version of TRL/transformers knows.

    TRL renames things between releases (eval_strategy/evaluation_strategy,
    max_seq_length moving into SFTConfig, tokenizer → processing_class …).
    Filtering by the real signature keeps the script working on every version.
    """
    import inspect
    try:
        params = inspect.signature(cls.__init__).parameters
    except (TypeError, ValueError):
        return kwargs
    if any(p.kind == p.VAR_KEYWORD for p in params.values()):
        # **kwargs in the signature (dataclass wrappers) — try a real instantiation.
        return kwargs
    accepted = {name for name in params if name != "self"}
    dropped = sorted(set(kwargs) - accepted)
    if dropped:
        print(f"ℹ️  {cls.__name__}: ignoring unsupported options {dropped}")
    return {k: v for k, v in kwargs.items() if k in accepted}


def make_trainer(model, tokenizer, train_dataset, eval_dataset, cfg):
    """SFTTrainer across TRL versions (tokenizer= became processing_class=)."""
    from trl import SFTTrainer
    base = dict(model=model, train_dataset=train_dataset,
                eval_dataset=eval_dataset, args=cfg)
    for key in ("processing_class", "tokenizer"):
        try:
            return SFTTrainer(**base, **{key: tokenizer})
        except TypeError as exc:
            last = exc
    raise SystemExit(f"Could not create SFTTrainer: {last}")


def build_sft_config(args, torch, max_steps: int, output_dir: str,
                     warmup_steps: int = 20, save_steps: int = 200,
                     eval_dataset=None, logging_steps: int = 10):
    from trl import SFTConfig
    bf16 = bool(torch.cuda.is_bf16_supported())
    kwargs = dict(
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        warmup_steps=warmup_steps,
        max_steps=max_steps,
        learning_rate=args.learning_rate,
        lr_scheduler_type="cosine",
        fp16=not bf16,
        bf16=bf16,
        logging_steps=logging_steps,
        optim=args.optim,
        weight_decay=0.01,
        seed=args.seed,
        output_dir=output_dir,
        save_strategy="steps",
        save_steps=save_steps,
        save_total_limit=1,           # each checkpoint is ~100 MB of disk + RAM
        report_to="none",
        max_seq_length=args.max_seq_length,
        packing=args.packing,
        dataset_text_field="text",
        # --- memory guards -------------------------------------------------
        # >1 proc forks the process AFTER CUDA is initialised: on Colab that
        # duplicates a ~4 GB parent and takes the whole session down.
        dataset_num_proc=args.dataset_num_proc,
        dataloader_num_workers=0,
        dataloader_pin_memory=False,
        gradient_checkpointing=True,
        # Periodically hand fragmented blocks back to the allocator.
        torch_empty_cache_steps=args.empty_cache_steps or None,
    )
    if eval_dataset is not None:
        kwargs.update(
            eval_strategy="steps",
            eval_steps=max(50, max_steps // 4),
            # Evaluation is the single biggest memory spike in a run: batch 1,
            # stream the losses out, and never keep logits (vocab 150k × seq
            # 1024 × float32 is ~600 MB *per sample*).
            per_device_eval_batch_size=1,
            eval_accumulation_steps=1,
            prediction_loss_only=True,
        )
    # TRL renamed max_seq_length → max_length in 0.13+. Silently dropping it
    # would fall back to a LONGER default sequence and OOM the card.
    import inspect
    try:
        fields = set(inspect.signature(SFTConfig.__init__).parameters)
        if "max_seq_length" not in fields and "max_length" in fields:
            kwargs["max_length"] = kwargs.pop("max_seq_length")
    except (TypeError, ValueError):
        pass

    kwargs = _filter_kwargs(SFTConfig, kwargs)
    try:
        return SFTConfig(**kwargs)
    except TypeError as exc:
        # Last resort: drop whatever the constructor complained about.
        for key in ("max_seq_length", "max_length", "packing", "dataset_num_proc",
                    "dataset_text_field", "eval_strategy", "eval_steps",
                    "torch_empty_cache_steps", "eval_accumulation_steps",
                    "prediction_loss_only", "gradient_checkpointing",
                    "dataloader_pin_memory", "dataloader_num_workers"):
            kwargs.pop(key, None)
        print(f"ℹ️  Falling back to a minimal SFTConfig ({exc})")
        return SFTConfig(**kwargs)



def latest_checkpoint(output_dir: str):
    p = Path(output_dir)
    if not p.exists():
        return None
    checkpoints = sorted(p.glob("checkpoint-*"), key=lambda d: int(d.name.split("-")[-1]))
    return str(checkpoints[-1]) if checkpoints else None


# ---------------------------------------------------------------------------
# 4. TEST + EXPORT
# ---------------------------------------------------------------------------

def chat_once(model, tokenizer, torch, prompt: str, max_new_tokens: int = 256) -> str:
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt}]
    try:
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        text = f"User: {prompt}\nAssistant:"
    inputs = tokenizer([text], return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=True,
                             temperature=0.7, top_p=0.9, repetition_penalty=1.1,
                             use_cache=True, pad_token_id=tokenizer.eos_token_id)
    full = tokenizer.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
    return full.strip()


def run_tests(model, tokenizer, torch, prompts: list[str], output_dir: str) -> None:
    free_memory(torch, "before tests")
    try:
        from unsloth import FastLanguageModel
        FastLanguageModel.for_inference(model)
    except Exception:
        pass
    print("\n" + "=" * 70)
    print("🧪 TEST — মডেল এখন কেমন উত্তর দেয় (বাংলা / English / Banglish)")
    print("=" * 70)
    transcript = []
    for prompt in prompts:
        try:
            reply = chat_once(model, tokenizer, torch, prompt)
        except Exception as exc:
            if is_oom_error(exc):
                free_memory(torch)
                try:
                    reply = chat_once(model, tokenizer, torch, prompt, max_new_tokens=96)
                except Exception as exc2:
                    reply = f"(test skipped — out of memory: {exc2})"
            else:
                reply = f"(test failed: {exc})"
        print(f"\n👤 {prompt}\n🤖 {reply}")
        transcript.append({"prompt": prompt, "reply": reply})
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    (Path(output_dir) / "test_results.json").write_text(
        json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + "=" * 70)



def write_modelfile(output_dir: str, name: str) -> None:
    gguf = next((p.name for p in Path(output_dir).glob("*.gguf")), "model.gguf")
    content = (
        f"FROM ./{gguf}\n\n"
        f'SYSTEM """{SYSTEM_PROMPT}"""\n\n'
        "PARAMETER temperature 0.7\n"
        "PARAMETER top_p 0.9\n"
        "PARAMETER repeat_penalty 1.1\n"
        "PARAMETER num_ctx 4096\n"
    )
    (Path(output_dir) / "Modelfile").write_text(content, encoding="utf-8")
    print(f"📝 Modelfile written → ollama create {name.lower()} -f {output_dir}/Modelfile")


def export_gguf(model, tokenizer, torch, out: Path, args) -> None:
    """GGUF export, retried with a smaller memory footprint on OOM.

    This step merges the LoRA back into fp16 weights on the CPU, so it is the
    RAM peak of the whole script — on Colab's 12.7 GB it is the most common
    place for the session to die *after* a successful training run. Unsloth
    exposes `maximum_memory_usage`; we walk it down instead of giving up.
    """
    import inspect
    try:
        supports_budget = "maximum_memory_usage" in inspect.signature(
            model.save_pretrained_gguf).parameters
    except (TypeError, ValueError):
        supports_budget = False

    budgets = [0.6, 0.4, 0.25] if supports_budget else [None]
    for i, budget in enumerate(budgets):
        free_memory(torch, "before GGUF export")
        try:
            extra = f" (RAM budget {budget:.0%})" if budget else ""
            print(f"📦 Exporting GGUF{extra} — this can take 5–15 minutes…")
            kwargs = {"quantization_method": args.gguf_quant}
            if budget is not None:
                kwargs["maximum_memory_usage"] = budget
            model.save_pretrained_gguf(str(out), tokenizer, **kwargs)
            write_modelfile(str(out), args.assistant_name)
            return
        except Exception as exc:
            if is_oom_error(exc) and i + 1 < len(budgets):
                print(f"⚠️  GGUF export ran out of memory — retrying with a "
                      f"smaller RAM budget ({budgets[i + 1]:.0%}).")
                continue
            print(f"⚠️  GGUF export failed: {exc}")
            if is_oom_error(exc):
                print("   💡 মেমোরি শেষ। LoRA adapter সেভ হয়ে গেছে — সেটাই নামান, "
                      "পরে আলাদা সেশনে GGUF বানানো যাবে:\n"
                      "      python train_lora.py --resume --max-steps 1 --export-gguf "
                      f"--output {out}")
            else:
                print("   The LoRA adapter is still saved and usable.")
            return


# ---------------------------------------------------------------------------
# 5. MAIN
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(
        description="LoRA fine-tune your personal Bangla+English AI inside a time budget.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Models:\n" + "\n".join(f"  {k:<34}{v}" for k, v in MODEL_PRESETS.items()),
    )
    # model
    ap.add_argument("--model", default="unsloth/Qwen2.5-1.5B-Instruct",
                    help="Base model (default: %(default)s)")
    ap.add_argument("--max-seq-length", type=int, default=1024)
    ap.add_argument("--load-in-4bit", dest="load_in_4bit", action="store_true", default=True)
    ap.add_argument("--no-4bit", dest="load_in_4bit", action="store_false")
    # data
    ap.add_argument("--recipe", choices=["basic", "balanced", "advanced"], default=None,
                    help="Auto-build a Bangla+English mix (basic/balanced/advanced)")
    ap.add_argument("--rows", type=int, default=None, help="Exact rows for the mix")
    ap.add_argument("--train", default=None, help="Ready-made train.jsonl")
    ap.add_argument("--val", default=None, help="Ready-made val.jsonl")
    ap.add_argument("--extra-jsonl", action="append", default=None,
                    help="Your own JSONL to merge (repeatable, missing files skipped)")
    ap.add_argument("--own-repeat", type=int, default=8)
    ap.add_argument("--assistant-name", default="MY-AI")
    ap.add_argument("--owner-name", default="")
    ap.add_argument("--dataset-out", default="data")
    ap.add_argument("--val-ratio", type=float, default=0.02)
    ap.add_argument("--no-system-prompt", dest="use_system", action="store_false", default=True)
    # legacy HF flags (kept for backwards compatibility)
    ap.add_argument("--hf-dataset", default=None)
    ap.add_argument("--hf-split", default="train_sft")
    ap.add_argument("--hf-limit", type=int, default=5000)
    ap.add_argument("--hf-streaming", action="store_true")
    # training
    ap.add_argument("--time-budget-hours", type=float, default=3.0,
                    help="Wall-clock hours to train (default: %(default)s). 0 = use --epochs")
    ap.add_argument("--epochs", type=float, default=2.0,
                    help="Used only when --time-budget-hours 0")
    ap.add_argument("--max-steps", type=int, default=0, help="Override the computed step count")
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--learning-rate", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=32)
    ap.add_argument("--lora-alpha", type=int, default=None)
    ap.add_argument("--packing", action="store_true", default=True)
    ap.add_argument("--no-packing", dest="packing", action="store_false")
    ap.add_argument("--probe-steps", type=int, default=6)
    ap.add_argument("--no-probe", dest="probe", action="store_false", default=True)
    ap.add_argument("--resume", action="store_true", help="Resume from the last checkpoint")
    ap.add_argument("--seed", type=int, default=42)
    # memory / OOM
    ap.add_argument("--no-autotune", dest="autotune", action="store_false", default=True,
                    help="Do not cap batch/seq-length to what the GPU can hold")
    ap.add_argument("--oom-retries", type=int, default=4,
                    help="On OOM, shrink the config and retry this many times (default: %(default)s)")
    ap.add_argument("--max-eval-rows", type=int, default=200,
                    help="Cap the eval set — evaluation is the biggest memory spike")
    ap.add_argument("--no-eval", dest="eval_enabled", action="store_false", default=True,
                    help="Skip evaluation entirely (saves the most memory)")
    ap.add_argument("--dataset-num-proc", type=int, default=1,
                    help="Dataset workers. >1 forks after CUDA init and can OOM Colab's RAM")
    ap.add_argument("--empty-cache-steps", type=int, default=100,
                    help="Release cached CUDA blocks every N steps (0 = never)")
    ap.add_argument("--optim", default="adamw_8bit",
                    help="Optimizer (adamw_8bit keeps optimizer states ~4× smaller)")

    # output
    ap.add_argument("--output", default="./my-ai-model")
    ap.add_argument("--export-gguf", action="store_true")
    ap.add_argument("--gguf-quant", default="q4_k_m")
    ap.add_argument("--save-merged-16bit", action="store_true",
                    help="Also save a merged fp16 model (big, needed for some runtimes)")
    ap.add_argument("--test-prompt", action="append", default=None,
                    help="Extra test prompt (repeatable)")
    ap.add_argument("--skip-tests", action="store_true")
    args = ap.parse_args()

    if args.lora_alpha is None:
        args.lora_alpha = args.lora_r * 2

    overall_start = time.time()
    budget_seconds = args.time_budget_hours * 3600 if args.time_budget_hours else 0
    # Reserve time for saving + GGUF export + tests at the end.
    reserve = 900 if args.export_gguf else 300
    train_deadline = overall_start + max(300, budget_seconds - reserve) if budget_seconds else None

    print("=" * 70)
    print("🎓 MY-AI — বাংলা + English LoRA ট্রেনিং")
    print("=" * 70)
    print(f"  model          : {args.model}")
    print(f"  recipe         : {args.recipe or 'files'}")
    print(f"  time budget    : {args.time_budget_hours or '—'} h "
          f"(training stops with {reserve // 60} min to spare for saving/export)")
    print(f"  output         : {args.output}")

    FastLanguageModel, torch, Dataset = load_unsloth()
    apply_memory_caps(args, torch)

    print("\n===== STEP 1/4 — DATA =====")
    train_rows, val_rows = collect_rows(args)
    n_train_rows, n_val_rows = len(train_rows), len(val_rows)

    # Evaluation is the biggest single memory spike of a run; keep it tiny.
    if not args.eval_enabled:
        val_rows = []
    elif args.max_eval_rows and len(val_rows) > args.max_eval_rows:
        print(f"ℹ️  Eval set capped {len(val_rows)} → {args.max_eval_rows} rows (memory).")
        val_rows = val_rows[:args.max_eval_rows]

    print("\n===== STEP 2/4 — MODEL =====")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_length,
        dtype=None,
        load_in_4bit=args.load_in_4bit,
    )
    if not getattr(tokenizer, "chat_template", None):
        print("ℹ️  Base model has no chat template — using ChatML.")
        tokenizer.chat_template = CHATML_TEMPLATE
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        lora_alpha=args.lora_alpha,
        lora_dropout=0.0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=args.seed,
        use_rslora=False,
    )

    # One pass, one copy: rows → "text". The lists are drained as we go so the
    # corpus never exists twice in RAM (Colab free only has ~12.7 GB).
    train_ds = to_text_dataset(train_rows, tokenizer, Dataset, args.use_system)
    eval_ds = (to_text_dataset(val_rows, tokenizer, Dataset, args.use_system)
               if val_rows else None)
    del train_rows, val_rows
    free_memory(torch, "dataset built")

    print("\n===== STEP 3/4 — TRAINING =====")
    effective_batch = args.batch_size * args.grad_accum
    steps_per_epoch = max(1, len(train_ds) // effective_batch)

    if args.max_steps:
        max_steps = args.max_steps
        why = "--max-steps"
    elif budget_seconds:
        per_step = 1.6  # fallback guess
        if args.probe:
            while True:
                try:
                    per_step = measure_seconds_per_step(model, tokenizer, train_ds, args,
                                                        torch, args.probe_steps)
                    break
                except Exception as exc:
                    if is_oom_error(exc):
                        # The canary died — shrink now, before the real run.
                        step_down = shrink_for_oom(args)
                        free_memory(torch, "probe OOM")
                        if step_down:
                            print(f"⚠️  Probe hit OOM — {step_down}; retrying the probe.")
                            effective_batch = args.batch_size * args.grad_accum
                            steps_per_epoch = max(1, len(train_ds) // effective_batch)
                            continue
                    print(f"⚠️  Speed probe failed ({exc}); assuming {per_step}s/step.")
                    break
        remaining = max(120.0, (train_deadline or time.time()) - time.time())
        per_step = max(0.05, per_step)   # never divide by ~0 on a fast/stubbed run
        max_steps = max(30, int(remaining / per_step))
        why = f"{remaining / 3600:.2f}h left ÷ {per_step:.2f}s/step"
    else:
        max_steps = int(steps_per_epoch * args.epochs)
        why = f"{args.epochs} epochs"

    epochs_covered = max_steps / steps_per_epoch
    print(f"\n📐 Plan: {max_steps} steps ({why})")
    print(f"   effective batch {effective_batch} · {len(train_ds)} samples · "
          f"{steps_per_epoch} steps/epoch → ≈{epochs_covered:.2f} epochs")
    if epochs_covered > 4:
        print("   ⚠️  Budget covers >4 epochs of this data — increase --rows / --budget "
              "so the model sees MORE data instead of memorising the same rows.")

    resume_from = latest_checkpoint(args.output) if args.resume else None
    if resume_from:
        print(f"↩️  Resuming from {resume_from}")

    # ---- train, shrinking the configuration on every OOM ------------------
    attempt = 0
    trainer = None
    while True:
        if not args.eval_enabled:
            eval_ds = None
        cfg = build_sft_config(
            args, torch, max_steps=max_steps, output_dir=args.output,
            warmup_steps=min(50, max(5, max_steps // 20)),
            save_steps=max(50, max_steps // 6),
            eval_dataset=eval_ds,
        )
        trainer = make_trainer(model, tokenizer, train_ds, eval_ds, cfg)
        if train_deadline:
            trainer.add_callback(make_time_callback(train_deadline))

        print(f"🚀 Training…{gpu_memory_note(torch)}\n")
        try:
            trainer.train(resume_from_checkpoint=resume_from)
            break
        except KeyboardInterrupt:
            print("\n⏹️  Interrupted — saving what has been learned so far…")
            break
        except Exception as exc:
            if not is_oom_error(exc) or attempt >= args.oom_retries:
                if is_oom_error(exc):
                    print("\n❌ Still out of memory at the smallest safe settings.\n"
                          "   পরের ধাপ: ছোট মডেল নিন —\n"
                          "     --model unsloth/Qwen2.5-0.5B-Instruct\n"
                          "   অথবা: --max-seq-length 512 --batch-size 1 --no-eval --no-packing")
                raise
            attempt += 1
            # Free the dead trainer FIRST, then shrink and rebuild.
            try:
                trainer.model.zero_grad(set_to_none=True)
            except Exception:
                pass
            for attr in ("optimizer", "lr_scheduler", "accelerator", "model_wrapped"):
                try:
                    setattr(trainer, attr, None)
                except Exception:
                    pass
            del trainer, cfg
            trainer = None
            free_memory(torch, f"OOM recovery {attempt}/{args.oom_retries}")
            step_down = shrink_for_oom(args)
            if step_down is None:
                print("\n❌ Out of memory and nothing left to shrink.")
                raise
            # Pick up from the newest checkpoint so no training time is lost.
            resume_from = latest_checkpoint(args.output) or resume_from
            effective_batch = args.batch_size * args.grad_accum
            steps_per_epoch = max(1, len(train_ds) // effective_batch)
            print(f"\n🛟 OOM ধরা পড়েছে (চেষ্টা {attempt}/{args.oom_retries}) — "
                  f"{step_down}, তারপর আবার চলছে"
                  + (f" ({resume_from} থেকে)" if resume_from else "") + ".")

    print("\n===== STEP 4/4 — SAVE + EXPORT =====")
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out))
    tokenizer.save_pretrained(str(out))
    print(f"✅ LoRA adapter + tokenizer → {out}")

    # The optimizer states are several GB and are useless from here on. Drop
    # them before the merge/GGUF step, which is the most memory-hungry part.
    if trainer is not None:
        for attr in ("optimizer", "lr_scheduler", "accelerator", "model_wrapped"):
            try:
                setattr(trainer, attr, None)
            except Exception:
                pass
        del trainer
    free_memory(torch, "before export")

    meta = {
        "base_model": args.model,
        "recipe": args.recipe,
        "train_rows": n_train_rows,
        "val_rows": n_val_rows,
        "max_steps": max_steps,
        "effective_batch": effective_batch,
        "epochs_covered": round(epochs_covered, 3),
        "time_budget_hours": args.time_budget_hours,
        "elapsed_minutes": round((time.time() - overall_start) / 60, 1),
        "max_seq_length": args.max_seq_length,
        "batch_size": args.batch_size,
        "grad_accum": args.grad_accum,
        "packing": args.packing,
        "oom_retries_used": attempt,
        "gpu": (torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"),
        "lora_r": args.lora_r,
        "system_prompt": SYSTEM_PROMPT if args.use_system else None,
    }
    (out / "training_info.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                            encoding="utf-8")

    if args.save_merged_16bit:
        free_memory(torch, "before merge")
        try:
            model.save_pretrained_merged(str(out / "merged-16bit"), tokenizer,
                                         save_method="merged_16bit")
            print(f"✅ Merged fp16 model → {out / 'merged-16bit'}")
        except Exception as exc:
            print(f"⚠️  Merged save failed: {exc}"
                  + ("\n   (মেমোরি শেষ — GGUF এক্সপোর্টই যথেষ্ট, এটা বাদ দিন)"
                     if is_oom_error(exc) else ""))
        free_memory(torch, "after merge")

    if args.export_gguf:
        export_gguf(model, tokenizer, torch, out, args)


    if not args.skip_tests:
        prompts = DEFAULT_TEST_PROMPTS + (args.test_prompt or [])
        run_tests(model, tokenizer, torch, prompts, str(out))

    total_min = (time.time() - overall_start) / 60
    print(f"\n🎉 DONE in {total_min:.0f} minutes ({total_min / 60:.2f} h).")
    print(f"   Model: {out}")
    print("   Next: zip it, download it, then →  ollama create my-ai -f Modelfile")


if __name__ == "__main__":
    main()
