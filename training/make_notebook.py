#!/usr/bin/env python3
"""
make_notebook.py — regenerate the Colab notebook from `colab_one_click.py`.

There is exactly ONE source of truth for the training cell: the plain Python
file `training/colab_one_click.py`. The notebook is generated from it, so the
two can never drift apart (which is how people end up running a stale script
that still has a bug you already fixed).

Run after editing colab_one_click.py:

    python training/make_notebook.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "colab_one_click.py"
NOTEBOOK = HERE / "colab_bangla_english.ipynb"

INTRO = """# 🎓 MY-AI — বাংলা + English ট্রেনিং (Google Colab)

**একটাই সেল। একবার Run। ব্যস।**

1. উপরে **Runtime → Change runtime type → T4 GPU → Save**
2. নিচের সেলটা **▶ Run** করুন (একবারই চাপুন)
3. চাইলে নিজের `myai-dataset.jsonl` আপলোড করুন — না চাইলে **Cancel** চাপুন

এটাই সব করবে: ডাটা নামাবে → মিশাবে → LoRA ট্রেন করবে → GGUF বানাবে → zip নামাবে।

---

### 🔴 ডিসকানেক্ট হয়ে গেলে?

ভয় নেই। **শুধু সেলটা আবার Run দিন** — শেষ checkpoint থেকেই চালু হবে।
Google Drive mount করা থাকলে checkpoint নিরাপদ থাকে, তাই Drive-এ হ্যাঁ বলুন।

### 📡 কন্ট্রোল প্যানেলে লাইভ দেখতে চান?

MY-AI প্যানেলের **Training** ট্যাবে **“Copy Colab cell”** চাপুন — ওখান থেকে কপি করা
সেলে `PANEL_URL` আর `PANEL_TOKEN` আগে থেকেই বসানো থাকে। তখন step, loss, ETA সব
প্যানেলেই লাইভ দেখতে পাবেন।

### ⚠️ সত্যি কথা

ফাইন-টিউনিং মডেলকে আপনার **স্টাইল/ভাষা** শেখায় — নতুন **তথ্য** নয়।
ফ্যাক্টের জন্য MY-AI-এর **Knowledge** ট্যাব (RAG) ব্যবহার করুন।
"""

OUTRO = """## ✅ শেষ হলে

`my-ai-model.zip` নামবে। আনজিপ করে:

```bash
ollama create my-ai -f Modelfile
ollama run my-ai
```

তারপর MY-AI-এর `.env`-এ যোগ করুন:

```
ACTIVE_MODEL=ollama:my-ai
MODEL_PATH=http://localhost:11434
```
"""


def build() -> dict:
    code = SCRIPT.read_text(encoding="utf-8")
    # nbformat wants a list of lines, each keeping its trailing newline.
    lines = code.splitlines(keepends=True)
    return {
        "cells": [
            {"cell_type": "markdown", "metadata": {}, "source": INTRO.splitlines(keepends=True)},
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {"id": "myai-one-click"},
                "outputs": [],
                "source": lines,
            },
            {"cell_type": "markdown", "metadata": {}, "source": OUTRO.splitlines(keepends=True)},
        ],
        "metadata": {
            "accelerator": "GPU",
            "colab": {"gpuType": "T4", "provenance": [], "toc_visible": True},
            "kernelspec": {"display_name": "Python 3", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 0,
    }


def main() -> None:
    if not SCRIPT.exists():
        raise SystemExit(f"Not found: {SCRIPT}")
    NOTEBOOK.write_text(json.dumps(build(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"✅ {NOTEBOOK.name} regenerated from {SCRIPT.name}")


if __name__ == "__main__":
    main()
