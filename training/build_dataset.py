#!/usr/bin/env python3
"""
build_dataset.py — turn your exported chat data into a fine-tuning dataset.

Usage:
    # 1) Export your data from the MY-AI dashboard:
    #    AI Brain -> Export Dataset  (downloads myai-dataset.jsonl)
    #
    # 2) Convert it:
    python build_dataset.py --input myai-dataset.jsonl --output data

    # This writes data/train.jsonl and data/val.jsonl in a ShareGPT-style
    # format ready for train_lora.py / Unsloth.
"""

import argparse
import json
import random
from pathlib import Path


def build_instruction_rows(messages: list[dict]) -> list[dict]:
    """Convert a ShareGPT conversation (user/assistant turns) into
    instruction-style rows (instruction = user, output = assistant)."""
    rows = []
    for i in range(len(messages) - 1):
        user = messages[i]
        assistant = messages[i + 1]
        if user.get("role") == "user" and assistant.get("role") == "assistant":
            rows.append(
                {
                    "instruction": user.get("content", "").strip(),
                    "input": "",
                    "output": assistant.get("content", "").strip(),
                }
            )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a fine-tuning dataset from exported chat JSONL.")
    parser.add_argument("--input", required=True, help="Path to myai-dataset.jsonl")
    parser.add_argument("--output", default="data", help="Output directory (default: data)")
    parser.add_argument("--val-split", type=float, default=0.1, help="Validation fraction (default: 0.1)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    src = Path(args.input)
    if not src.exists():
        raise SystemExit(f"Input file not found: {src}")

    rows: list[dict] = []
    with src.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            msgs = obj.get("messages", [])
            rows.extend(build_instruction_rows(msgs))

    if not rows:
        raise SystemExit("No user→assistant pairs found. Chat with your AI first, then export again.")

    random.seed(args.seed)
    random.shuffle(rows)
    split = int(len(rows) * (1 - args.val_split))
    train, val = rows[:split], rows[split:]

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    def write(path: Path, data: list[dict]) -> None:
        with path.open("w", encoding="utf-8") as f:
            for row in data:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    write(out_dir / "train.jsonl", train)
    write(out_dir / "val.jsonl", val)

    print(f"✅ Done! {len(train)} train rows, {len(val)} val rows -> {out_dir}/")


if __name__ == "__main__":
    main()
