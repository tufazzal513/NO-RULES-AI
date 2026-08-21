#!/usr/bin/env python3
"""
build_from_hf.py — turn ANY Hugging Face chat dataset into a fine-tuning
dataset (train.jsonl / val.jsonl) ready for train_lora.py.

Just downloading with load_dataset() does NOT teach your model anything —
this script converts the data AND you then run train_lora.py to actually
put it into your model's brain.

Examples (works the same on your PC or in a Google Colab cell):

    # UltraChat 200k — first 5,000 conversations
    python build_from_hf.py \
        --dataset HuggingFaceH4/ultrachat_200k \
        --split train_sft \
        --limit 5000 \
        --output data

    # Low disk / slow net? Stream instead of downloading gigabytes:
    python build_from_hf.py --dataset HuggingFaceH4/ultrachat_200k \
        --split train_sft --limit 5000 --streaming --output data

    # Then train (GPU needed — free Colab T4 works):
    python train_lora.py --model unsloth/Llama-3.2-1B-Instruct \
        --train data/train.jsonl --val data/val.jsonl \
        --output ./my-ai-model --export-gguf

Output format matches train_lora.py exactly:
    {"instruction": "<user turn>", "input": "", "output": "<assistant turn>"}

Supported datasets: any dataset whose rows contain a chat field like
"messages": [{"role": "user", "content": ...}, {"role": "assistant", ...}]
(ShareGPT style). Legacy {"from": "human"/"gpt", "value": ...} fields are
handled too. Datasets with a plain prompt/response column pair can be used
with --prompt-field / --response-field.
"""

import argparse
import json
import random
from itertools import islice
from pathlib import Path


def normalize_messages(raw_messages):
    """Return a list of {"role": ..., "content": ...} from either the modern
    role/content format or the legacy ShareGPT from/value format."""
    msgs = []
    for m in raw_messages or []:
        if "role" in m and "content" in m:
            role, content = m["role"], m["content"]
        elif "from" in m and "value" in m:
            role = {"human": "user", "gpt": "assistant", "system": "system"}.get(
                str(m["from"]).lower(), str(m["from"]).lower()
            )
            content = m["value"]
        else:
            continue
        if not isinstance(content, str):
            continue
        msgs.append({"role": role, "content": content.strip()})
    return msgs


def pairs_from_messages(messages, min_chars=3):
    """Every user->assistant adjacent pair becomes one training row."""
    rows = []
    for i in range(len(messages) - 1):
        u, a = messages[i], messages[i + 1]
        if u["role"] == "user" and a["role"] == "assistant":
            if len(u["content"]) >= min_chars and len(a["content"]) >= min_chars:
                rows.append(
                    {"instruction": u["content"], "input": "", "output": a["content"]}
                )
    return rows


def row_from_prompt_response(example, prompt_field, response_field, min_chars=3):
    u = str(example.get(prompt_field) or "").strip()
    a = str(example.get(response_field) or "").strip()
    if len(u) >= min_chars and len(a) >= min_chars:
        return [{"instruction": u, "input": "", "output": a}]
    return []


def collect_rows(args):
    try:
        from datasets import load_dataset
    except ImportError:
        raise SystemExit(
            "The 'datasets' package is not installed. Run:\n"
            "  pip install datasets"
        )

    print(f"📥 Loading {args.dataset} (split={args.split})"
          + (" [streaming]" if args.streaming else ""))

    if args.streaming:
        ds = load_dataset(args.dataset, split=args.split, streaming=True)
        ds = ds.shuffle(seed=args.seed, buffer_size=10_000)
        examples = islice(ds, args.limit)
    else:
        ds = load_dataset(args.dataset, split=args.split)
        if args.limit and args.limit < len(ds):
            ds = ds.shuffle(seed=args.seed).select(range(args.limit))
        examples = ds

    rows = []
    for ex in examples:
        if args.prompt_field and args.response_field:
            rows.extend(
                row_from_prompt_response(
                    ex, args.prompt_field, args.response_field, args.min_chars
                )
            )
        else:
            rows.extend(
                pairs_from_messages(
                    normalize_messages(ex.get(args.messages_field)), args.min_chars
                )
            )

    if not rows:
        raise SystemExit(
            "❌ No training rows produced. Check --split / --messages-field, "
            "or use --prompt-field + --response-field for plain text datasets."
        )
    return rows


def main():
    p = argparse.ArgumentParser(
        description="Convert a Hugging Face chat dataset into train/val JSONL "
                    "for train_lora.py."
    )
    p.add_argument("--dataset", default="HuggingFaceH4/ultrachat_200k",
                   help="Hugging Face dataset id (default: %(default)s)")
    p.add_argument("--split", default="train_sft",
                   help="Dataset split to read (default: %(default)s)")
    p.add_argument("--limit", type=int, default=10_000,
                   help="Max conversations to read (default: %(default)s). "
                        "Full UltraChat is ~200k — start small!")
    p.add_argument("--messages-field", default="messages",
                   help="Chat field name (default: %(default)s)")
    p.add_argument("--prompt-field", default=None,
                   help="Plain-text prompt column (alternative to messages)")
    p.add_argument("--response-field", default=None,
                   help="Plain-text response column (alternative to messages)")
    p.add_argument("--val-ratio", type=float, default=0.05,
                   help="Fraction of rows kept for validation (default: %(default)s)")
    p.add_argument("--min-chars", type=int, default=3,
                   help="Drop turns shorter than this (default: %(default)s)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--streaming", action="store_true",
                   help="Stream rows instead of downloading the whole dataset")
    p.add_argument("--output", default="data",
                   help="Output folder for train.jsonl/val.jsonl (default: %(default)s)")
    args = p.parse_args()

    rows = collect_rows(args)
    random.Random(args.seed).shuffle(rows)

    n_val = max(1, int(len(rows) * args.val_ratio)) if len(rows) > 1 else 0
    val_rows, train_rows = rows[:n_val], rows[n_val:]

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    train_path = out_dir / "train.jsonl"
    val_path = out_dir / "val.jsonl"

    with open(train_path, "w", encoding="utf-8") as f:
        for r in train_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(val_path, "w", encoding="utf-8") as f:
        for r in val_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"✅ Done! {len(train_rows)} training rows → {train_path}")
    print(f"✅        {len(val_rows)} validation rows → {val_path}")
    print()
    print("Next step — put the data INTO the model (fine-tune):")
    print("  python train_lora.py --model unsloth/Llama-3.2-1B-Instruct \\")
    print(f"      --train {train_path} --val {val_path} \\")
    print("      --output ./my-ai-model --export-gguf")


if __name__ == "__main__":
    main()
