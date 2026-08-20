#!/usr/bin/env python3
"""
train_lora.py — fine-tune YOUR OWN personal AI.

This is the "big brain" step. It fine-tunes an open-source model (Llama,
Gemma, Qwen…) on YOUR data using LoRA/QLoRA, so the result is a model that
speaks like you and knows your information — and it runs 100% on your own
hardware. No company's API is involved.

Where to run it:
  - Google Colab (free GPU) — recommended, see training/README.md
  - Your own PC with an NVIDIA GPU (8GB+ VRAM recommended)

Prerequisites (run once):
    pip install unsloth "unsloth[colab-new]" datasets

Usage:
    python train_lora.py \
      --model unsloth/Llama-3.2-1B-Instruct \
      --train data/train.jsonl \
      --val data/val.jsonl \
      --output ./my-ai-model \
      --export-gguf
"""

import argparse
import json
import os
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


CHAT_TEMPLATE = """{% for message in messages %}{{'<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}"""


def load_dataset(train_path: str, val_path: str, FastLanguageModel, torch, Dataset):
    def read_jsonl(path: str):
        rows = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        return rows

    train_rows = read_jsonl(train_path)

    def to_chat(row):
        return {
            "messages": [
                {"role": "user", "content": row.get("instruction", "")},
                {"role": "assistant", "content": row.get("output", "")},
            ]
        }

    train_ds = Dataset.from_list([to_chat(r) for r in train_rows])
    val_ds = None
    if val_path and Path(val_path).exists():
        val_ds = Dataset.from_list([to_chat(r) for r in read_jsonl(val_path)])
    return train_ds, val_ds


def main():
    parser = argparse.ArgumentParser(description="LoRA fine-tune your personal AI.")
    parser.add_argument("--model", default="unsloth/Llama-3.2-1B-Instruct", help="Base model (HuggingFace id)")
    parser.add_argument("--train", required=True, help="Path to train.jsonl")
    parser.add_argument("--val", default=None, help="Path to val.jsonl (optional)")
    parser.add_argument("--output", default="./my-ai-model", help="Output directory")
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--export-gguf", action="store_true", help="Export GGUF (for Ollama)")
    args = parser.parse_args()

    if not Path(args.train).exists():
        raise SystemExit(f"Training file not found: {args.train}\nRun build_dataset.py first.")

    FastLanguageModel, torch, Dataset = load_unsloth()

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

    tokenizer.chat_template = CHAT_TEMPLATE
    train_ds, val_ds = load_dataset(args.train, args.val, FastLanguageModel, torch, Dataset)

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

    # Save LoRA adapter + full model
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"✅ Model saved to {args.output}")

    if args.export_gguf:
        model.save_pretrained_gguf(args.output, tokenizer, quantization_method="q4_k_m")
        print(f"✅ GGUF exported to {args.output} — load it in Ollama with:\n"
              f"   ollama create my-ai -f {args.output}/Modelfile")


if __name__ == "__main__":
    main()
