#!/usr/bin/env python3
"""
build_mix.py — build a Bangla + English (+ Banglish) chat-training mix.

এই স্ক্রিপ্টটা একাধিক Hugging Face ডেটাসেট থেকে ডাটা নামায়, সবগুলোকে এক
ফরম্যাটে আনে (instruction / input / output), ভাষা অনুযায়ী ব্যালান্স করে,
ডুপ্লিকেট বাদ দেয় এবং `train.jsonl` + `val.jsonl` লিখে দেয়।

Design goals
------------
* **Never crash.** A dataset that is gated, renamed or offline is skipped with
  a warning — the mix is still built from whatever loaded.
* **Schema-agnostic.** messages / conversations (ShareGPT) / instruction+output /
  instruction+response / prompt+completion / question+answer are all detected
  automatically.
* **Language aware.** Every row is tagged `bn` / `en` / `banglish` from its
  characters, so the recipe can hit an exact Bangla:English ratio.
* **Time aware.** A recipe knows roughly how many rows fit in a GPU-hour, so
  `--budget-hours` picks the sample count for you.

Usage
-----
    python build_mix.py --recipe balanced --budget-hours 3 --output data
    python build_mix.py --recipe advanced --budget-hours 5 \
        --extra-jsonl myai-dataset.jsonl --assistant-name "MY-AI"

Output rows:
    {"instruction": "...", "input": "", "output": "...", "lang": "bn", "src": "..."}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import unicodedata
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. Source catalogue
# ---------------------------------------------------------------------------
# Each source: id, split, weight inside its language bucket, and a note.
# `lang` is what we EXPECT; rows that disagree are dropped by the language
# filter, so a mislabelled source can never poison the mix.

BN_SOURCES = [
    # Native Bangla instructions (not translated) — best quality, ACL 2025.
    {"id": "md-nishat-008/Bangla-Instruct", "split": "train", "weight": 3.0,
     "note": "native Bangla instruction/response (TigerLLM)"},
    # Translated Alpaca + OpenOrca — broad task coverage.
    {"id": "BanglaLLM/bangla-alpaca-orca", "split": "train", "weight": 2.5,
     "note": "Bangla Alpaca + Orca (172k)"},
    {"id": "iamshnoo/alpaca-cleaned-bengali", "split": "train", "weight": 1.5,
     "note": "cleaned Alpaca translated to Bangla"},
    {"id": "OdiaGenAI/all_combined_bengali_252k", "split": "train", "weight": 1.5,
     "note": "252k combined Bengali instructions"},
]

BN_ADVANCED_SOURCES = [
    # Reasoning / exam-style Bangla — this is what lifts the model from
    # "chit-chat" to "moderately advanced".
    {"id": "KillerShoaib/DeepSeek-r1-Distill-Bangla-MMLU-Reasoning-Data",
     "split": "train", "weight": 1.0, "note": "Bangla reasoning (MMLU distill)"},
]

EN_SOURCES = [
    {"id": "HuggingFaceH4/ultrachat_200k", "split": "train_sft", "weight": 2.0,
     "note": "multi-turn English chat"},
    {"id": "yahma/alpaca-cleaned", "split": "train", "weight": 1.0,
     "note": "cleaned Alpaca (English instructions)"},
]

EN_ADVANCED_SOURCES = [
    {"id": "teknium/OpenHermes-2.5", "split": "train", "weight": 1.5,
     "note": "reasoning / coding / advanced English chat"},
]

# ---------------------------------------------------------------------------
# 2. Recipes — how many rows and in what proportion
# ---------------------------------------------------------------------------
# ROWS_PER_HOUR is a conservative estimate for a free Colab T4 with a ~1.5B
# 4-bit model, packing on, seq-len 1024. train_lora.py measures the real speed
# anyway and stops on the clock, so this only sets the *pool* size.

ROWS_PER_HOUR = 9000

RECIPES = {
    # basic conversation, fastest useful result
    "basic": {
        "bn": 0.55, "en": 0.35, "own": 0.10,
        "advanced_share": 0.0,
        "max_output_chars": 1200,
        "note": "দৈনন্দিন কথাবার্তা — সবচেয়ে দ্রুত (১–২ ঘণ্টা)",
    },
    # everyday chat + a slice of reasoning — the default
    "balanced": {
        "bn": 0.50, "en": 0.35, "own": 0.15,
        "advanced_share": 0.25,
        "max_output_chars": 2000,
        "note": "কথাবার্তা + কিছুটা রিজনিং (২–৩ ঘণ্টা)",
    },
    # heavier reasoning share, longer answers
    "advanced": {
        "bn": 0.45, "en": 0.40, "own": 0.15,
        "advanced_share": 0.40,
        "max_output_chars": 3000,
        "note": "অ্যাডভান্স উত্তর, রিজনিং বেশি (৪–৫ ঘণ্টা)",
    },
}

# ---------------------------------------------------------------------------
# 3. Language detection (Bengali script vs Latin vs Banglish)
# ---------------------------------------------------------------------------

BENGALI_RANGE = re.compile(r"[\u0980-\u09FF]")
LATIN_RANGE = re.compile(r"[A-Za-z]")

# Very common Banglish tokens — enough to separate "amar nam ki" from English.
BANGLISH_HINTS = {
    "ami", "amar", "amake", "tumi", "tomar", "apni", "apnar", "kemon", "acho",
    "achen", "achi", "ki", "kire", "keno", "kothay", "kobe", "kivabe", "kise",
    "bhalo", "valo", "kharap", "hoye", "hobe", "korbo", "korte", "koro",
    "bolo", "bolben", "jante", "chai", "lagbe", "nam", "din", "raat", "aaj",
    "kal", "onek", "ektu", "dhonnobad", "shudhu", "jonno", "ache", "nai",
    "hocche", "korchi", "bujhi", "bujhte", "shikhte", "bangla", "banglish",
}


def detect_lang(text: str) -> str:
    """Return 'bn' (Bengali script), 'banglish' (romanised Bangla) or 'en'."""
    if not text:
        return "en"
    bn = len(BENGALI_RANGE.findall(text))
    la = len(LATIN_RANGE.findall(text))
    if bn > max(4, la * 0.15):
        return "bn"
    words = re.findall(r"[a-z]+", text.lower())
    if words:
        hits = sum(1 for w in words if w in BANGLISH_HINTS)
        if hits >= 2 and hits / len(words) > 0.12:
            return "banglish"
    return "en"


# ---------------------------------------------------------------------------
# 4. Row normalisation — any schema in, one schema out
# ---------------------------------------------------------------------------

MESSAGE_FIELDS = ("messages", "conversations", "conversation", "chat", "turns")
INSTRUCTION_FIELDS = ("instruction", "prompt", "question", "input_text",
                      "query", "user", "human", "inputs", "Instruction")
OUTPUT_FIELDS = ("output", "response", "answer", "completion", "assistant",
                 "gpt", "chosen", "targets", "Response", "Output", "text_output")
CONTEXT_FIELDS = ("input", "context", "system", "Input")

ROLE_MAP = {"human": "user", "user": "user", "prompter": "user",
            "gpt": "assistant", "assistant": "assistant", "bot": "assistant",
            "chatgpt": "assistant", "system": "system"}


def _clean(text) -> str:
    if not isinstance(text, str):
        return ""
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\u200b", "").replace("\ufeff", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_messages(raw) -> list[dict]:
    out = []
    for m in raw or []:
        if not isinstance(m, dict):
            continue
        if "role" in m and "content" in m:
            role, content = m.get("role"), m.get("content")
        elif "from" in m and "value" in m:
            role, content = m.get("from"), m.get("value")
        else:
            continue
        role = ROLE_MAP.get(str(role).lower().strip(), None)
        content = _clean(content)
        if role and content:
            out.append({"role": role, "content": content})
    return out


def pairs_from_messages(messages, system: str = "") -> list[dict]:
    """Turn a conversation into (user → assistant) instruction rows."""
    rows = []
    sys_txt = system
    pending_user = None
    for m in messages:
        if m["role"] == "system":
            sys_txt = m["content"]
        elif m["role"] == "user":
            pending_user = m["content"]
        elif m["role"] == "assistant" and pending_user:
            rows.append({"instruction": pending_user, "input": sys_txt,
                         "output": m["content"]})
            pending_user = None
    return rows


def _first_field(row: dict, names) -> str:
    for n in names:
        if n in row:
            v = row[n]
            if isinstance(v, str) and v.strip():
                return _clean(v)
            if isinstance(v, list) and v and isinstance(v[0], dict):
                # e.g. "chosen": [{"role": ..., "content": ...}]
                msgs = normalize_messages(v)
                if msgs:
                    return msgs[-1]["content"]
    return ""


def rows_from_record(record: dict) -> list[dict]:
    """Convert ONE dataset record into 0..n instruction rows, whatever its schema."""
    if not isinstance(record, dict):
        return []
    for field in MESSAGE_FIELDS:
        if isinstance(record.get(field), list) and record[field]:
            msgs = normalize_messages(record[field])
            if msgs:
                return pairs_from_messages(msgs, _first_field(record, ("system",)))
    instruction = _first_field(record, INSTRUCTION_FIELDS)
    output = _first_field(record, OUTPUT_FIELDS)
    context = _first_field(record, CONTEXT_FIELDS)
    if instruction and output:
        return [{"instruction": instruction, "input": context, "output": output}]
    return []


# ---------------------------------------------------------------------------
# 5. Quality filter
# ---------------------------------------------------------------------------

BAD_PATTERNS = re.compile(
    r"(as an ai language model|i cannot fulfill|i'm sorry, but i can|"
    r"openai|chatgpt|<\|im_start\|>|\[/?INST\]|http://localhost)",
    re.IGNORECASE,
)


def acceptable(row: dict, max_output_chars: int, min_output_chars: int = 8) -> bool:
    ins, out = row.get("instruction", ""), row.get("output", "")
    if len(ins) < 3 or len(out) < min_output_chars:
        return False
    if len(ins) > 4000 or len(out) > max_output_chars:
        return False
    if BAD_PATTERNS.search(out) or BAD_PATTERNS.search(ins):
        return False
    if out.count("\ufffd") or ins.count("\ufffd"):
        return False
    # A reply that just repeats the question teaches nothing.
    if out.strip().lower() == ins.strip().lower():
        return False
    return True


def row_key(row: dict) -> str:
    return hashlib.md5(
        (row.get("instruction", "")[:200] + "||" + row.get("output", "")[:200])
        .lower().encode("utf-8")
    ).hexdigest()


# ---------------------------------------------------------------------------
# 6. Hugging Face loading (streaming, fault tolerant)
# ---------------------------------------------------------------------------

def _split_candidates(ds_id: str, split: str, probe_hub: bool = False) -> list[str]:
    """The requested split first, then sensible fallbacks, then whatever exists.

    Dataset owners rename splits ('train_sft' → 'train', 'train' → 'default');
    that must never cost us a whole source. The Hub is only queried (one extra
    request) when every static guess has already failed.
    """
    candidates = [split]
    for fallback in ("train", "train_sft", "default", "all"):
        if fallback not in candidates:
            candidates.append(fallback)
    if probe_hub:
        try:
            from datasets import get_dataset_split_names
            for name in get_dataset_split_names(ds_id):
                if name not in candidates:
                    candidates.append(name)
        except Exception:
            pass
    return candidates


def load_source(source: dict, limit: int, expect_lang: str,
                max_output_chars: int, seen: set) -> list[dict]:
    """Stream `limit` usable rows out of one HF dataset. Never raises."""
    ds_id, split = source["id"], source["split"]
    print(f"  ↓ {ds_id} [{split}] — target {limit} rows … ", end="", flush=True)
    try:
        from datasets import load_dataset
    except ImportError:
        print("datasets not installed — skipped")
        return []
    stream = None
    last_error = ""
    tried: list[str] = []
    for probe_hub in (False, True):
        for candidate in _split_candidates(ds_id, split, probe_hub):
            if candidate in tried:
                continue
            tried.append(candidate)
            try:
                stream = load_dataset(ds_id, split=candidate, streaming=True)
                if candidate != split:
                    print(f"(split '{split}'→'{candidate}') ", end="", flush=True)
                break
            except Exception as exc:  # gated / renamed / offline / bad split
                last_error = str(exc).splitlines()[0][:110]
        if stream is not None:
            break
    if stream is None:
        print(f"skipped ({last_error})")
        return []

    kept: list[dict] = []
    scanned = 0
    try:
        for record in stream:
            scanned += 1
            for row in rows_from_record(record):
                if not acceptable(row, max_output_chars):
                    continue
                lang = detect_lang(row["instruction"] + " " + row["output"])
                if expect_lang == "bn" and lang != "bn":
                    continue
                if expect_lang == "en" and lang == "bn":
                    continue
                key = row_key(row)
                if key in seen:
                    continue
                seen.add(key)
                row["lang"] = lang
                row["src"] = ds_id
                kept.append(row)
                if len(kept) >= limit:
                    raise StopIteration
            if scanned > limit * 60 + 20000:  # give up on a very sparse source
                break
    except StopIteration:
        pass
    except Exception as exc:
        print(f"partial ({str(exc).splitlines()[0][:60]}) ", end="")
    print(f"got {len(kept)}")
    return kept


def take_from_bucket(sources: list[dict], total: int, expect_lang: str,
                     max_output_chars: int, seen: set) -> list[dict]:
    """Split `total` rows across sources by weight, refilling from whoever has data."""
    if total <= 0 or not sources:
        return []
    weight_sum = sum(s["weight"] for s in sources) or 1.0
    rows: list[dict] = []
    for i, src in enumerate(sources):
        remaining_sources = len(sources) - i
        share = int(total * src["weight"] / weight_sum)
        # Ask for the shortfall too, so one dead source doesn't shrink the mix.
        shortfall = total - len(rows) - share * (remaining_sources - 1)
        want = max(share, min(shortfall, total - len(rows)))
        if want <= 0:
            continue
        rows.extend(load_source(src, want, expect_lang, max_output_chars, seen))
        if len(rows) >= total:
            break
    return rows[:total]


# ---------------------------------------------------------------------------
# 7. Local JSONL (your own exported chats / repo seed data)
# ---------------------------------------------------------------------------

def load_local_jsonl(path: str, max_output_chars: int, seen: set) -> list[dict]:
    p = Path(path)
    if not p.exists():
        print(f"  ⚠️  {path} নেই — বাদ দেওয়া হলো")
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
                if not acceptable(row, max_output_chars, min_output_chars=2):
                    continue
                key = row_key(row)
                if key in seen:
                    continue
                seen.add(key)
                row["lang"] = detect_lang(row["instruction"] + " " + row["output"])
                row["src"] = p.name
                rows.append(row)
    print(f"  📄 {path}: {len(rows)} rows")
    return rows


# ---------------------------------------------------------------------------
# 8. Identity / persona rows — so the model knows who it is, in 3 languages
# ---------------------------------------------------------------------------

def identity_rows(name: str, owner: str = "") -> list[dict]:
    owner_bn = f" আমাকে বানিয়েছেন {owner}।" if owner else ""
    owner_en = f" I was built by {owner}." if owner else ""
    pairs = [
        ("তোমার নাম কী?", f"আমার নাম {name}। আমি আপনার নিজের AI সহকারী।{owner_bn}", "bn"),
        ("তুমি কে?", f"আমি {name} — আপনার ব্যক্তিগত AI। বাংলা, ইংরেজি আর বাংলিশ তিনটাতেই কথা বলতে পারি।", "bn"),
        ("তুমি কী কী করতে পারো?", f"আমি প্রশ্নের উত্তর দিতে পারি, লেখা লিখতে ও ঠিক করতে পারি, অনুবাদ করতে পারি, "
                                   f"অঙ্ক কষতে পারি, কোড লিখতে পারি আর যেকোনো বিষয় সহজ করে বুঝিয়ে দিতে পারি।", "bn"),
        ("কেমন আছো?", "আমি ভালো আছি, ধন্যবাদ! আপনি কেমন আছেন? কী নিয়ে সাহায্য করতে পারি?", "bn"),
        ("তুমি কি বাংলা বলতে পারো?", "হ্যাঁ, পারি। আপনি বাংলায় লিখলে আমি বাংলায় উত্তর দেব, "
                                      "ইংরেজিতে লিখলে ইংরেজিতে, আর বাংলিশে লিখলে বাংলিশেই।", "bn"),
        ("What is your name?", f"My name is {name}. I'm your personal AI assistant.{owner_en}", "en"),
        ("Who are you?", f"I'm {name}, your own AI. I can talk in English, বাংলা and Banglish.", "en"),
        ("What can you do?", "I can answer questions, write and edit text, translate between Bangla and "
                             "English, do maths, write code and explain things step by step.", "en"),
        ("How are you?", "I'm doing well, thank you! How are you? What would you like help with?", "en"),
        ("tomar nam ki?", f"Amar nam {name}. Ami apnar nijer AI assistant.", "banglish"),
        ("kemon acho?", "Ami bhalo achi! Apni kemon achen? Ki niye help korte pari?", "banglish"),
        ("tumi ki banglish bujho?", "Hae, bujhi. Apni jevabe likhben ami sevabei uttor debo — "
                                    "Bangla, English ba Banglish.", "banglish"),
    ]
    rows = []
    for q, a, lang in pairs:
        rows.append({"instruction": q, "input": "", "output": a,
                     "lang": lang, "src": "identity"})
    return rows


# ---------------------------------------------------------------------------
# 9. Main
# ---------------------------------------------------------------------------

def build(args) -> tuple[list[dict], list[dict]]:
    recipe = RECIPES[args.recipe]
    total = args.rows or int(args.budget_hours * ROWS_PER_HOUR)
    total = max(400, total)
    max_out = recipe["max_output_chars"]

    print(f"\n🍳 Recipe: {args.recipe} — {recipe['note']}")
    print(f"🎯 Target pool: {total} rows "
          f"(≈{args.budget_hours}h budget, {ROWS_PER_HOUR} rows/GPU-hour estimate)\n")

    seen: set = set()
    rows: list[dict] = []

    # --- your own data first: it must never be crowded out -----------------
    own_target = int(total * recipe["own"])
    own_rows: list[dict] = []
    for path in args.extra_jsonl or []:
        own_rows.extend(load_local_jsonl(path, max_out, seen))
    ident = identity_rows(args.assistant_name, args.owner_name)
    for row in ident:
        seen.add(row_key(row))
    # Repeat the small, high-value sets so they actually register during training.
    repeat = max(1, min(args.own_repeat, (own_target // max(1, len(own_rows) + len(ident))) or 1))
    own_block = (own_rows + ident) * repeat
    print(f"  🧬 own + identity data: {len(own_rows) + len(ident)} unique × {repeat} = {len(own_block)}")
    rows.extend(own_block)

    remaining = max(0, total - len(rows))
    bn_target = int(remaining * recipe["bn"] / max(1e-9, recipe["bn"] + recipe["en"]))
    en_target = remaining - bn_target

    adv = recipe["advanced_share"]
    print(f"\n🇧🇩 বাংলা ডেটা ({bn_target} rows):")
    rows += take_from_bucket(BN_SOURCES, int(bn_target * (1 - adv)), "bn", max_out, seen)
    if adv > 0:
        rows += take_from_bucket(BN_ADVANCED_SOURCES, int(bn_target * adv), "bn", max_out, seen)

    print(f"\n🇬🇧 English data ({en_target} rows):")
    rows += take_from_bucket(EN_SOURCES, int(en_target * (1 - adv)), "en", max_out, seen)
    if adv > 0:
        rows += take_from_bucket(EN_ADVANCED_SOURCES, int(en_target * adv), "en", max_out, seen)

    rng = random.Random(args.seed)
    rng.shuffle(rows)

    n_val = min(500, max(1, int(len(rows) * args.val_ratio))) if len(rows) > 20 else 0
    return rows[n_val:], rows[:n_val]


def summarise(rows: list[dict], title: str) -> None:
    if not rows:
        print(f"{title}: (empty)")
        return
    langs: dict[str, int] = {}
    srcs: dict[str, int] = {}
    chars = 0
    for r in rows:
        langs[r.get("lang", "?")] = langs.get(r.get("lang", "?"), 0) + 1
        srcs[r.get("src", "?")] = srcs.get(r.get("src", "?"), 0) + 1
        chars += len(r.get("instruction", "")) + len(r.get("output", ""))
    print(f"\n{title}: {len(rows)} rows, ~{chars // max(1, len(rows))} chars/row")
    for lang, n in sorted(langs.items(), key=lambda kv: -kv[1]):
        print(f"   {lang:<9} {n:>6}  ({n * 100 // len(rows)}%)")
    print("   sources:")
    for src, n in sorted(srcs.items(), key=lambda kv: -kv[1]):
        print(f"     - {src}: {n}")


def write_jsonl(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a Bangla+English training mix.")
    ap.add_argument("--recipe", choices=sorted(RECIPES), default="balanced")
    ap.add_argument("--budget-hours", type=float, default=3.0,
                    help="GPU hours you plan to train for (sets the pool size)")
    ap.add_argument("--rows", type=int, default=None,
                    help="Exact row count (overrides --budget-hours)")
    ap.add_argument("--extra-jsonl", action="append", default=None,
                    help="Your own ShareGPT/instruction JSONL. Repeatable, missing files skipped.")
    ap.add_argument("--own-repeat", type=int, default=8,
                    help="How many times to repeat your own+identity rows (default: %(default)s)")
    ap.add_argument("--assistant-name", default="MY-AI")
    ap.add_argument("--owner-name", default="")
    ap.add_argument("--val-ratio", type=float, default=0.02)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output", default="data")
    args = ap.parse_args()

    train_rows, val_rows = build(args)
    if not train_rows:
        sys.exit("❌ কোনো ডাটা পাওয়া যায়নি — ইন্টারনেট/ডেটাসেট আইডি চেক করুন।")

    out = Path(args.output)
    write_jsonl(train_rows, out / "train.jsonl")
    write_jsonl(val_rows, out / "val.jsonl")

    summarise(train_rows, "📊 TRAIN")
    summarise(val_rows, "📊 VAL")
    print(f"\n✅ Saved → {out / 'train.jsonl'} ({len(train_rows)}), "
          f"{out / 'val.jsonl'} ({len(val_rows)})")
    print("👉 এরপর: python train_lora.py --train data/train.jsonl --val data/val.jsonl "
          "--time-budget-hours 3 --export-gguf")


if __name__ == "__main__":
    main()
