# 🎓 নিজের AI ট্রেন করুন — সম্পূর্ণ গাইড

> 🐣 **একদম নতুন?** `BEGINNER_GUIDE_BN.md` পড়ুন — এক ধাপ করে শেখানো আছে।
> ⚡ **Colab-এ চাইলে?** `myai_training_colab.ipynb` নোটবুকটা Colab-এ আপলোড করুন — একটা কমান্ডেই ডাটা ডাউনলোড → মিশানো → কনভার্ট → ট্রেনিং → GGUF → টেস্ট সব অটো হবে।

এই ফোল্ডারে আপনার **নিজের পার্সোনাল AI** ট্রেন করার সবকিছু আছে। এখানে কোনো কোম্পানির API ব্যবহার হয় না — আপনি একটা ওপেন-সোর্স মডেলকে (Llama/Gemma/Qwen/Sarvam) **আপনার নিজের ডেটায়** ফাইন-টিউন করে নেবেন, ফলে সেটা আপনার ঢঙে কথা বলবে, আপনার তথ্য জানবে এবং ১০০% আপনারই থাকবে।

## ⚡ সবচেয়ে সহজ পথ — এক কমান্ডে অটো ট্রেনিং

`train_lora.py` এখন সবকিছু নিজে করে — আলাদা করে ডাটা প্রসেসের দরকার নেই:

```bash
python train_lora.py \
    --model sarvamai/sarvam-1 \
    --hf-dataset HuggingFaceH4/ultrachat_200k --hf-split train_sft --hf-limit 5000 \
    --extra-jsonl bangla-english-banglish-chat.jsonl \
    --extra-jsonl myai-dataset.jsonl \
    --output ./my-ai-model --export-gguf \
    --test-prompt "আপনি কেমন আছেন?"
```

একটা কমান্ডেই: ① HF ডাটা ডাউনলোড ② নিজের ডাটা মিশানো ③ কনভার্ট (`data/train.jsonl`-এও সেভ হয়)
④ LoRA ট্রেনিং ⑤ GGUF এক্সপোর্ট ⑥ ট্রেনিং শেষে একটা টেস্ট প্রশ্নের উত্তর দেখানো।

| অপশন | কাজ |
|---|---|
| `--model sarvamai/sarvam-1` | 🇧🇩 বাংলা+ইংরেজি মডেল (Apache 2.0) — ডিফল্ট |
| `--hf-dataset <id>` | HF থেকে ডাটা নামিয়ে অটো কনভার্ট |
| `--extra-jsonl <file>` | নিজের এক্সপোর্ট/সিড ডাটা মিশানো (একাধিকবার দেওয়া যায়, ফাইল না থাকলে skip) |
| `--test-prompt "..."` | ট্রেনিং শেষে মডেলকে প্রশ্ন করে উত্তর দেখানো |
| `--train data/train.jsonl` | ক্লাসিক পদ্ধতি — রেডি train.jsonl দিয়ে ট্রেন |

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

### 🌐 বিকল্প — Hugging Face ডেটাসেট (যেমন UltraChat 200k)

> ⚠️ **মনে রাখুন:** শুধু `load_dataset()` করলে ডেটা মডেলের মাথায় ঢুকে **না** — সেটা শুধু ডাউনলোড। মাথায় ঢুকাতে হলে রূপান্তর (এই স্ক্রিপ্ট) + ট্রেনিং (`train_lora.py`) দুটোই লাগবে।

আপনার নিজের ডেটার পাশাপাশি (বা পরিবর্তে) যেকোনো Hugging Face চ্যাট ডেটাসেট দিয়ে ট্রেন করতে পারেন:

```bash
# নিজের PC-তে (বা Colab সেলে ! দিয়ে)
python build_from_hf.py \
    --dataset HuggingFaceH4/ultrachat_200k \
    --split train_sft \
    --limit 5000 \
    --output data
```

→ `data/train.jsonl` + `data/val.jsonl` তৈরি হবে — তারপর ধাপ ৩-এ চালান।

**দরকারি অপশন:**

| অপশন | কাজ |
|---|---|
| `--limit 5000` | কতগুলো কথোপকথন নেবেন (পুরো UltraChat ~200k — শুরুতে ৫–১০ হাজারই ভালো) |
| `--streaming` | পুরো ডেটাসেট (গিগাবাইট!) ডাউনলোড না করে স্ট্রিম করে — ধীর নেটে দারুণ |
| `--dataset <id>` | অন্য যেকোনো চ্যাট ডেটাসেট (ShareGPT স্টাইল `messages` ফিল্ড থাকলেই চলবে) |
| `--seed 42` | একই র‍্যান্ডম স্যাম্পল বারবার পেতে |

> 💡 UltraChat দিয়ে ট্রেন করলে মডেল **জেনারেল চ্যাট** শিখবে। "আপনার" AI বানাতে চাইলে আপনার এক্সপোর্ট করা ডেটার সাথে মিশিয়ে নিন — দুটোই একই `instruction/output` ফরম্যাট, তাই ফাইল দুটো একসাথে জোড়া দিলেই হবে।

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
