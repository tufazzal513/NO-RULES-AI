# 🎓 নিজের AI ট্রেন করুন — সম্পূর্ণ গাইড

> ⭐ **সবচেয়ে সহজ পথ:** [`colab_one_click.py`](./colab_one_click.py)-এর পুরো কোডটা
> Colab-এর একটা সেলে পেস্ট করে **Run** চাপুন। **১ থেকে ৫ ঘণ্টার টাইম-বাজেট** দিন —
> বাংলা+ইংরেজি ডাটা অটো নামবে, মিশবে, ট্রেনিং হবে, OOM হলে নিজেই সামলাবে আর
> সময় শেষ হওয়ার আগেই মডেল সেভ + GGUF এক্সপোর্ট হয়ে যাবে।
> 🐣 একদম নতুন? [`BEGINNER_GUIDE_BN.md`](./BEGINNER_GUIDE_BN.md) ধাপে ধাপে দেখাবে।
> 🎮 Colab-এর বদলে Kaggle? [`KAGGLE_GUIDE_BN.md`](./KAGGLE_GUIDE_BN.md) দেখুন —
> RAM বেশি (~২৯–৩২ GB), সাপ্তাহিক ~৩০ ঘণ্টা ফ্রি GPU, ব্যাকগ্রাউন্ড রান।

এই ফোল্ডারে আপনার **নিজের পার্সোনাল AI** ট্রেন করার সবকিছু আছে। এখানে কোনো কোম্পানির API ব্যবহার হয় না — আপনি একটা ওপেন-সোর্স মডেলকে (Qwen/Llama/Gemma/Sarvam) **আপনার নিজের ডেটায়** ফাইন-টিউন করে নেবেন, ফলে সেটা আপনার ঢঙে কথা বলবে, আপনার তথ্য জানবে এবং ১০০% আপনারই থাকবে।

## 📁 কোন ফাইল কী করে

| ফাইল | কাজ |
|---|---|
| `colab_one_click.py` | ⭐ **এক সেলে পুরো ট্রেনিং** (Colab-এ পেস্ট → Run) |
| `colab_bangla_english.ipynb` | ⭐ উপরের স্ক্রিপ্টটাই নোটবুক আকারে (অটো-জেনারেটেড) |
| `kaggle_one_click.py` | Kaggle ভার্সন — সপ্তাহে ~৩০ ঘণ্টা ফ্রি GPU, RAM ~২৯–৩২ GB |
| `KAGGLE_GUIDE_BN.md` | 🎮 Kaggle-এ ট্রেনিংয়ের পুরো গাইড (ব্যাকগ্রাউন্ড রান, কোটা, ট্রাবলশুটিং) |
| `BEGINNER_GUIDE_BN.md` | 🐣 একদম নতুনদের জন্য সবচেয়ে সহজ পথ |
| `train_lora.py` | ট্রেনিং ইঞ্জিন (টাইম-বাজেট, OOM অটো-রিকভারি, resume, GGUF, লাইভ রিপোর্ট) |
| `build_mix.py` | বাংলা+ইংরেজি ডাটা মিক্সার (ভাষা ব্যালান্স, ডিডুপ, ফিল্টার) |
| `make_notebook.py` | `colab_one_click.py` → `.ipynb` রি-জেনারেট করে (দুটো যেন আলাদা না হয়) |

> ✏️ `colab_one_click.py` বদলালে `python training/make_notebook.py` চালিয়ে
> নোটবুকটা আবার বানিয়ে নিন — ওটাই একমাত্র সোর্স অফ ট্রুথ।

## ⚡ এক কমান্ডে অটো ট্রেনিং — ঘড়ি ধরে

`train_lora.py`-কে শুধু বলে দিন কত ঘণ্টা সময় আছে:

```bash
python train_lora.py \
    --model unsloth/Qwen2.5-1.5B-Instruct \
    --recipe balanced \
    --time-budget-hours 3 \
    --extra-jsonl myai-dataset.jsonl \
    --extra-jsonl ../data/import/bangla-english-banglish-chat.jsonl \
    --output ./my-ai-model --export-gguf
```

একটা কমান্ডেই: ① বাংলা+ইংরেজি HF ডাটা ডাউনলোড ② নিজের ডাটা মিশানো
③ কনভার্ট (`data/train.jsonl`-এও সেভ) ④ GPU-র স্পিড মেপে স্টেপ হিসাব
⑤ LoRA ট্রেনিং (সময় শেষ হলে ক্লিনলি থেমে সেভ) ⑥ GGUF + Modelfile
⑦ বাংলা/ইংরেজি/বাংলিশ টেস্ট প্রশ্নের উত্তর দেখানো।

| অপশন | কাজ |
|---|---|
| `--time-budget-hours 3` | ⏱️ কত ঘণ্টা ট্রেন হবে — বাকিটা স্ক্রিপ্ট হিসাব করে |
| `--recipe basic/balanced/advanced` | ডাটা মিক্স: দৈনন্দিন কথা → রিজনিংসহ অ্যাডভান্স |
| `--model unsloth/Qwen2.5-1.5B-Instruct` | 🇧🇩 বাংলা+ইংরেজি ডিফল্ট মডেল |
| `--rows 40000` | মিক্সে ঠিক কতগুলো উদাহরণ থাকবে |
| `--extra-jsonl <file>` | নিজের এক্সপোর্ট/সিড ডাটা (একাধিকবার, ফাইল না থাকলে skip) |
| `--resume` | ডিসকানেক্টের পর শেষ চেকপয়েন্ট থেকে শুরু |
| `--test-prompt "..."` | বাড়তি টেস্ট প্রশ্ন |
| `--train data/train.jsonl` | ক্লাসিক পদ্ধতি — রেডি train.jsonl দিয়ে ট্রেন |
| `--time-budget-hours 0 --epochs 2` | পুরনো ধাঁচে epoch-ভিত্তিক ট্রেনিং |

শুধু ডাটাসেট বানাতে চাইলে:

```bash
python build_mix.py --recipe balanced --budget-hours 3 --output data
```

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
python build_mix.py --recipe balanced --budget-hours 5 \
    --extra-jsonl myai-dataset.jsonl --output data
```
→ `data/train.jsonl` আর `data/val.jsonl` তৈরি হবে (বাংলা+ইংরেজি মিশিয়ে)।

### 🌐 বিকল্প — Hugging Face ডেটাসেট (যেমন UltraChat 200k)

> ⚠️ **মনে রাখুন:** শুধু `load_dataset()` করলে ডেটা মডেলের মাথায় ঢুকে **না** — সেটা শুধু ডাউনলোড। মাথায় ঢুকাতে হলে রূপান্তর (এই স্ক্রিপ্ট) + ট্রেনিং (`train_lora.py`) দুটোই লাগবে।

আপনার নিজের ডেটার পাশাপাশি (বা পরিবর্তে) যেকোনো Hugging Face চ্যাট ডেটাসেট দিয়ে ট্রেন করতে পারেন:

```bash
# নিজের PC-তে (বা Colab সেলে ! দিয়ে)
python train_lora.py --hf-dataset HuggingFaceH4/ultrachat_200k \
    --hf-split train_sft --hf-limit 5000 --output ./my-ai-model
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

## 🛟 মেমোরি / OOM — স্ক্রিপ্ট নিজেই সামলায়

ফ্রি Colab T4 (১৫ GB VRAM + ১২.৭ GB RAM) আর Kaggle P100-এ OOM যেন ট্রেনিং না
থামায়, সেজন্য `train_lora.py`-তে কয়েক স্তরের সুরক্ষা আছে:

| স্তর | কী করে |
|---|---|
| অ্যালোকেটর | `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` — ফ্র্যাগমেন্টেশনজনিত OOM বন্ধ |
| অটো-টিউন | GPU-র আসল VRAM দেখে `--batch-size` / `--max-seq-length` নামিয়ে দেয় (কখনো বাড়ায় না)। effective batch ঠিক রাখতে grad-accum বাড়ে |
| স্পিড-প্রোব | আসল রানের আগেই ছোট প্রোব চালিয়ে OOM ধরে ফেলে; প্রোব শেষে optimizer/grad পুরোপুরি ফ্রি করে (`gc` + `empty_cache`) |
| রিট্রাই ল্যাডার | OOM হলে ধাপে ধাপে হালকা করে চেকপয়েন্ট থেকে আবার চালায়: eval বন্ধ → batch ১ → packing বন্ধ → seq ছোট → grad-accum কম |
| eval | `per_device_eval_batch_size=1`, `prediction_loss_only`, সর্বোচ্চ ২০০ রো — eval-ই সবচেয়ে বড় মেমোরি স্পাইক |
| RAM | ডাটা এক পাসেই `text`-এ রূপান্তর (কর্পাস দুবার RAM-এ থাকে না), `dataset_num_proc=1` (CUDA init-এর পর fork করলে Colab-এর RAM ডাবল হয়ে সেশন মরে) |
| GGUF এক্সপোর্ট | RAM বাজেট ৬০% → ৪০% → ২৫% নামিয়ে রিট্রাই; না পারলেও LoRA adapter সেভ থাকে |

হাতে নিয়ন্ত্রণ চাইলে:

```bash
python train_lora.py --recipe balanced --time-budget-hours 3 \
    --batch-size 1 --grad-accum 16 --max-seq-length 512 \
    --no-eval --no-packing --no-autotune
```

`colab_one_click.py` / `kaggle_one_click.py` চাইল্ড প্রসেসের exit code দেখে:
`-9` / `137` মানে RAM শেষ হয়ে প্রসেস kill হয়েছে — তখন নিজে থেকেই হালকা সেটিংসে
(`--no-eval --batch-size 1`, তারপর `--no-packing` + ছোট seq) সর্বোচ্চ ৩ বার আবার
চালায়, প্রতিবারই শেষ চেকপয়েন্ট থেকে।
