#!/usr/bin/env python3
"""
train_lora.py — fine-tune YOUR OWN personal AI (one command, fully automatic).

This is the "big brain" step. It fine-tunes an open-source model (Llama,
Sarvam-1, Qwen…) on data you choose using LoRA/QLoRA, so the result is a
model that speaks like you and knows your information — and it runs 100% on
your own hardware. No company's API is involved.

The pipeline is fully automatic. ONE command can do ALL of this:
  1. Download a Hugging Face chat dataset   (--hf-dataset)
  2. Merge your own exported chats into it  (--extra-jsonl, repeatable)
  3. Convert everything to train/val JSONL  (also saved to data/ for reuse)
  4. Fine-tune with LoRA/QLoRA (Unsloth)
  5. Save the model + export GGUF for Ollama (--export-gguf)
  6. Run a test prompt to prove it works    (--test-prompt)

Where to run it:
  - Google Colab (free GPU) — recommended, see training/myai_training_colab.ipynb
  - Your own PC with an NVIDIA GPU (8GB+ VRAM recommended)

Prerequisites (run once):
    pip install unsloth "unsloth[colab-new]" datasets

Examples:
  # A) Hugging Face data ONLY (general English chat):
  python train_lora.py --model sarvamai/sarvam-1 \
      --hf-dataset HuggingFaceH4/ultrachat_200k --hf-split train_sft --hf-limit 5000 \
      --output ./my-ai-model --export-gguf

  # B) Your OWN exported data ONLY:
  python train_lora.py --model sarvamai/sarvam-1 \
      --extra-jsonl myai-dataset.jsonl \
      --output ./my-ai-model --export-gguf

  # C) BOTH together (recommended) + auto test after training:
  python train_lora.py --model sarvamai/sarvam-1 \
      --hf-dataset HuggingFaceH4/ultrachat_200k --hf-split train_sft --hf-limit 5000 \
      --extra-jsonl bangla-english-banglish-chat.jsonl \
      --extra-jsonl myai-dataset.jsonl \
      --output ./my-ai-model --export-gguf \
      --test-prompt "আপনি কেমন আছেন?"

  # D) Classic mode — train from ready-made train.jsonl/val.jsonl files:
  python train_lora.py --model unsloth/Llama-3.2-1B-Instruct \
      --train data/train.jsonl --val data/val.jsonl \
      --output ./my-ai-model --export-gguf
"""

import argparse
import json
import random
from pathlib import Path


# Lazy import so this file stays runnable as a template even without Unsloth.
def load_unsloth():
    try:
        from unsloth import FastLanguageModel
        import torch
        from datasets import Dataset
        return FastLanguageModel, torch, Dataset
    except ImportError as e:
        raise SystemExit(
            "Unsloth is not installed. Run:\n"
            "  pip install unsloth 'unsloth[colab-new]' datasets\n\n" + str(e)
        )


CHAT_TEMPLATE = """{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}"""


# ---------------------------------------------------------------------------
# Data collection — everything merged into one list of rows automatically.
# ---------------------------------------------------------------------------

def _import_build_from_hf():
    """Import build_from_hf.py no matter how this script was launched."""
    import sys
    script_dir = str(Path(__file__).resolve().parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    try:
        from build_from_hf import collect_rows, normalize_messages, pairs_from_messages
        return collect_rows, normalize_messages, pairs_from_messages
    except ImportError:
        raise SystemExit(
            "build_from_hf.py not found next to train_lora.py. "
            "Keep both files in the same folder."
        )


def hf_rows(args):
    """Download + convert a Hugging Face dataset via build_from_hf.py."""
    collect_rows, _, _ = _import_build_from_hf()
    import types
    ns = types.SimpleNamespace(
        dataset=args.hf_dataset,
        split=args.hf_split,
        limit=args.hf_limit,
        messages_field=args.messages_field,
        prompt_field=args.prompt_field,
        response_field=args.response_field,
        min_chars=args.min_chars,
        seed=args.seed,
        streaming=args.hf_streaming,
    )
    return collect_rows(ns)


def own_jsonl_rows(path):
    """Read a ShareGPT-style JSONL (myai-dataset.jsonl export, seed files…)
    and turn it into instruction rows. Missing files are skipped with a
    warning instead of crashing the whole pipeline."""
    _, normalize_messages, pairs_from_messages = _import_build_from_hf()
    p = Path(path)
    if not p.exists():
        print(f"⚠️  Skipping missing file: {path}")
        return []
    rows = []
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows.extend(pairs_from_messages(normalize_messages(obj.get("messages"))))
    print(f"📄 {path}: {len(rows)} rows")
    return rows


def instruction_jsonl_rows(path):
    """Read an existing train.jsonl-style file (instruction/input/output)."""
    p = Path(path)
    if not p.exists():
        raise SystemExit(f"Training file not found: {path}")
    rows = []
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def collect_train_rows(args):
    rows = []
    if args.train:
        rows.extend(instruction_jsonl_rows(args.train))
        print(f"📄 {args.train}: {len(rows)} rows")
    if args.hf_dataset:
        hf = hf_rows(args)
        print(f"🌐 Hugging Face {args.hf_dataset}: {len(hf)} rows")
        rows.extend(hf)
    for extra in args.extra_jsonl or []:
        rows.extend(own_jsonl_rows(extra))

    if not rows:
        raise SystemExit(
            "No training data! Give at least one of:\n"
            "  --train data/train.jsonl\n"
            "  --hf-dataset HuggingFaceH4/ultrachat_200k\n"
            "  --extra-jsonl myai-dataset.jsonl"
        )

    random.Random(args.seed).shuffle(rows)
    n_val = max(1, int(len(rows) * args.val_ratio)) if len(rows) > 1 else 0
    val_rows, train_rows = rows[:n_val], rows[n_val:]

    # Always save the merged dataset to disk so it can be reused.
    out_dir = Path(args.dataset_out)
    out_dir.mkdir(parents=True, exist_ok=True)
    train_path = out_dir / "train.jsonl"
    val_path = out_dir / "val.jsonl"
    with train_path.open("w", encoding="utf-8") as f:
        for r in train_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with val_path.open("w", encoding="utf-8") as f:
        for r in val_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"✅ Merged dataset: {len(train_rows)} train rows → {train_path}")
    print(f"✅                {len(val_rows)} val rows   → {val_path}")
    return train_rows, val_rows


def load_dataset(rows, val_rows, Dataset):
    def to_chat(row):
        return {
            "messages": [
                {"role": "user", "content": row.get("instruction", "")},
                {"role": "assistant", "content": row.get("output", "")},
            ]
        }

    train_ds = Dataset.from_list([to_chat(r) for r in rows])
    val_ds = Dataset.from_list([to_chat(r) for r in val_rows]) if val_rows else None
    return train_ds, val_ds


def run_test_prompt(model, tokenizer, torch, prompt):
    """After training, generate one reply so you can SEE it works."""
    try:
        from unsloth import FastLanguageModel
        FastLanguageModel.for_inference(model)
        if getattr(tokenizer, "chat_template", None):
            text = tokenizer.apply_chat_template(
                [{"role": "user", "content": prompt}],
                tokenize=False, add_generation_prompt=True,
            )
        else:
            text = prompt
        inputs = tokenizer([text], return_tensors="pt").to("cuda")
        with torch.no_grad():
            outputs = model.generate(**inputs, max_new_tokens=256, use_cache=True)
        reply = tokenizer.batch_decode(outputs, skip_special_tokens=True)[0]
        print("\n🧪 TEST — আপনি:", prompt)
        print("🤖 TEST — মডেলের উত্তর:", reply)
    except Exception as e:  # never break the pipeline because of the test
        print(f"⚠️  Test prompt skipped ({e}). Model files are still saved.")


def main():
    parser = argparse.ArgumentParser(description="LoRA fine-tune your personal AI.")
    parser.add_argument("--model", default="sarvamai/sarvam-1",
                        help="Base model on HuggingFace (default: %(default)s). "
                             "Bangla+English: sarvamai/sarvam-1. "
                             "English-only: unsloth/Llama-3.2-1B-Instruct.")
    parser.add_argument("--train", default=None,
                        help="Path to a ready train.jsonl (optional)")
    parser.add_argument("--hf-dataset", default=None,
                        help="HuggingFace dataset id, e.g. HuggingFaceH4/ultrachat_200k")
    parser.add_argument("--hf-split", default="train_sft",
                        help="HF dataset split (default: %(default)s)")
    parser.add_argument("--hf-limit", type=int, default=5000,
                        help="Max HF conversations to read (default: %(default)s)")
    parser.add_argument("--hf-streaming", action="store_true",
                        help="Stream HF data instead of downloading it fully")
    parser.add_argument("--messages-field", default="messages",
                        help="Chat field name inside the HF dataset")
    parser.add_argument("--prompt-field", default=None,
                        help="Plain-text prompt column (alternative to messages)")
    parser.add_argument("--response-field", default=None,
                        help="Plain-text response column (alternative to messages)")
    parser.add_argument("--extra-jsonl", action="append", default=None,
                        help="Extra ShareGPT JSONL to merge (own export / seed data). "
                             "Repeatable. Missing files are skipped.")
    parser.add_argument("--dataset-out", default="data",
                        help="Where to save merged train.jsonl/val.jsonl (default: %(default)s)")
    parser.add_argument("--val-ratio", type=float, default=0.05,
                        help="Validation fraction (default: %(default)s)")
    parser.add_argument("--min-chars", type=int, default=3,
                        help="Drop turns shorter than this (default: %(default)s)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--val", default=None,
                        help="Path to val.jsonl (only used with --train)")
    parser.add_argument("--output", default="./my-ai-model", help="Output directory")
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--export-gguf", action="store_true",
                        help="Export GGUF (for Ollama)")
    parser.add_argument("--test-prompt", default=None,
                        help="Ask the trained model a question right after training "
                             "(e.g. \"আপনি কেমন আছেন?\")")
    args = parser.parse_args()

    FastLanguageModel, torch, Dataset = load_unsloth()

    print("\n===== STEP 1/3 — DATA (auto download + merge + convert) =====")
    train_rows, val_rows = collect_train_rows(args)

    print("\n===== STEP 2/3 — TRAINING (LoRA fine-tune) =====")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_length,
        dtype=None,  # auto
        load_in_4bit=True,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=args.lora_r,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )

    # Keep the model's native chat template when it has one (Sarvam-1 uses
    # [INST]...[/INST], Qwen/Gemma have their own). Only fall back to the
    # generic template when the tokenizer ships without one.
    if not getattr(tokenizer, "chat_template", None):
        tokenizer.chat_template = CHAT_TEMPLATE
    train_ds, val_ds = load_dataset(train_rows, val_rows, Dataset)

    def formatting(examples):
        convos = examples["messages"]
        texts = [tokenizer.apply_chat_template(c, tokenize=False, add_generation_prompt=False) for c in convos]
        return {"text": texts}

    train_ds = train_ds.map(formatting, batched=True)
    eval_ds = val_ds.map(formatting, batched=True) if val_ds is not None else None

    from trl import SFTTrainer
    from transformers import TrainingArguments

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        dataset_text_field="text",
        max_seq_length=args.max_seq_length,
        args=TrainingArguments(
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            warmup_steps=5,
            num_train_epochs=args.epochs,
            learning_rate=2e-4,
            fp16=not torch.cuda.is_bf16_supported(),
            bf16=torch.cuda.is_bf16_supported(),
            logging_steps=1,
            optim="adamw_8bit",
            seed=42,
            output_dir=args.output,
            report_to="none",
        ),
    )

    print("🚀 Starting training on your data…")
    trainer.train()

    print("\n===== STEP 3/3 — SAVE + EXPORT =====")
    # Save LoRA adapter + tokenizer
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"✅ Model saved to {args.output}")

    if args.export_gguf:
        model.save_pretrained_gguf(args.output, tokenizer, quantization_method="q4_k_m")
        print(f"✅ GGUF exported to {args.output} — load it in Ollama with:\n"
              f"   ollama create my-ai -f {args.output}/Modelfile")

    if args.test_prompt:
        run_test_prompt(model, tokenizer, torch, args.test_prompt)

    print("\n🎉 ALL DONE! Next: training/myai_training_colab.ipynb → download model →")
    print("   ollama create my-ai -f Modelfile && ollama run my-ai")


if __name__ == "__main__":
    main()
