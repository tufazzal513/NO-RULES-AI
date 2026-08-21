# 🎓 নিজের AI ট্রেন করুন — সম্পূর্ণ গাইড

এই ফোল্ডারে আপনার **নিজের পার্সোনাল AI** ট্রেন করার সবকিছু আছে। এখানে কোনো কোম্পানির API ব্যবহার হয় না — আপনি একটা ওপেন-সোর্স মডেলকে (Llama/Gemma/Qwen) **আপনার নিজের ডেটায়** ফাইন-টিউন করে নেবেন, ফলে সেটা আপনার ঢঙে কথা বলবে, আপনার তথ্য জানবে এবং ১০০% আপনারই থাকবে।

## 🧠 MY-AI-তে দুটো brain আছে

| Brain | কী করে | কোথায় চলে |
|---|---|---|
| **Small brain** (Markov) | আপনার মেসেজ থেকে আপনার ভাষা শেখে, সাথে সাথে অফলাইনে উত্তর দেয় | MY-AI সার্ভারেই চলে (কোনো GPU লাগে না) |
| **Big brain** (Neural) | আসল নিউরাল মডেল — আপনার ডেটায় LoRA ফাইন-টিউন | আপনার PC-র GPU বা Google Colab |

Small brain এখনই কাজ করে। Big brain বানাতে এই গাইড ফলো করুন।

## 📦 ধাপ ১ — ডেটা এক্সপোর্ট

1. MY-AI ড্যাশবোর্ডে **AI Brain** ট্যাবে যান
2. **Export Dataset** চাপুন → `myai-dataset.jsonl` ডাউনলোড হবে
3. ফাইলটা এই `training/` ফোল্ডারে রাখুন

## 🔧 ধাপ ২ — ডেটা প্রস্তুত

```bash
python build_dataset.py --input myai-dataset.jsonl --output data
```
→ `data/train.jsonl` আর `data/val.jsonl` তৈরি হবে।

## ☁️ ধাপ ৩ — ট্রেন (Google Colab — ফ্রি GPU, সবচেয়ে সহজ)

1. [colab.research.google.com](https://colab.research.google.com)-এ নতুন notebook খুলুন
2. **Runtime → Change runtime type → T4 GPU** সিলেক্ট করুন
3. এই কোডগুলো সেলে পেস্ট করে চালান:

```python
# Install
!pip install -r requirements.txt

# Upload your training folder
from google.colab import files
uploaded = files.upload()   # train.jsonl + val.jsonl + train_lora.py আপলোড করুন

# Train
!python train_lora.py --model unsloth/Llama-3.2-1B-Instruct \
    --train train.jsonl --val val.jsonl \
    --output ./my-ai-model --export-gguf
```

4. শেষ হলে `my-ai-model` ফোল্ডারটা ডাউনলোড করে নিন (বিশেষ করে GGUF ফাইলটা)

## 🖥️ নিজের PC-তে ট্রেন (NVIDIA GPU থাকলে)

```bash
pip install -r requirements.txt
python train_lora.py --model unsloth/Llama-3.2-1B-Instruct \
    --train data/train.jsonl --val data/val.jsonl \
    --output ./my-ai-model --export-gguf
```

## 🐑 ধাপ ৪ — ট্রেন করা মডেল চালান (Ollama)

1. [ollama.com](https://ollama.com) থেকে Ollama ইনস্টল করুন
2. GGUF ফাইল দিয়ে মডেল তৈরি করুন:

```bash
ollama create my-ai -f Modelfile   # Modelfile আউটপুট ফোল্ডারে আছে
ollama run my-ai
```

## 🔌 ধাপ ৫ — MY-AI-এর সাথে যুক্ত করুন

ট্রেন করা মডেল চালু থাকলে MY-AI-এর `.env`-তে সেট করুন (পরের রিলিজে পূর্ণ ইন্টিগ্রেশন আসছে):

```env
ACTIVE_MODEL=ollama:my-ai
MODEL_PATH=http://localhost:11434
```

## 📝 মডেল বাছাই (আপনার হার্ডওয়্যার অনুযায়ী)

| মডেল | VRAM দরকার | মান |
|---|---|---|
| `unsloth/Llama-3.2-1B-Instruct` | ~4-6 GB | হালকা, দ্রুত, Colab ফ্রি T4-তে ঠিকঠাক |
| `unsloth/Qwen2.5-1.5B-Instruct` | ~5-7 GB | ভালো মান, বহুভাষী (বাংলাও কিছুটা) |
| `unsloth/gemma-2-2b-it` | ~6-8 GB | Google-এর ওপেন মডেল, ভালো মান |
| `unsloth/Llama-3.1-8B-Instruct` | ~16 GB | বেশি শক্তিশালী, বেশি VRAM লাগবে |

> ⚠️ **সত্যি কথা:** ছোট ডেটাসেটে (কয়েকশো কথোপকথন) ফাইন-টিউন করলে মডেল আপনার **স্টাইল/ফরম্যাট** শিখবে, কিন্তু বিশ্ব-জ্ঞান বাড়বে না। সেটার জন্য RAG (MY-AI-এর Knowledge ট্যাব) ব্যবহার করুন — সেটাই সবচেয়ে কার্যকর।
