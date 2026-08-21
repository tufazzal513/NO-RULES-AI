# ══════════════════════════════════════════════════════════════════
#  MY-AI এক-ক্লিক ট্রেনিং (Google Colab) — পুরো নোটবুক এক সেলে
#
#  ব্যবহার:
#    1) colab.research.google.com → File → New notebook
#    2) Runtime → Change runtime type → T4 GPU → Save
#    3) এই পুরো কোডটা পেস্ট করুন → ▶ Run (একবারই চাপুন)
#
#  এটাই সব: ডাটা নামবে → মিশবে → ট্রেন হবে → GGUF হবে → zip নামবে।
#  মাঝপথে ডিসকানেক্ট হলে আবার Run চাপলেই আগের জায়গা থেকে resume।
# ══════════════════════════════════════════════════════════════════

import os, sys, subprocess, glob, shutil

# ─── ১) সেটিংস (এখানেই বদলান) ───────────────────────────────
PLAN     = 'balanced'   # basic | balanced | advanced
HOURS    = 3            # 1 / 3 / 5 ঘণ্টা
MODEL    = 'unsloth/Qwen2.5-1.5B-Instruct'   # শক্তিশালী: unsloth/Qwen2.5-3B-Instruct
ASSISTANT_NAME = 'MY-AI'
OWNER_NAME     = ''     # আপনার নাম লিখুন — মডেল আপনার নাম জানবে
EXPORT_GGUF    = True   # Ollama-র .gguf ফাইল চান

# ─── ২) GPU চেক ──────────────────────────────────────────────
try:
    import torch
    assert torch.cuda.is_available()
    print('✅ GPU OK:', torch.cuda.get_device_name(0))
except Exception:
    print('❌ GPU নেই! Runtime → Change runtime type → T4 GPU → Save, তারপর আবার Run দিন')
    raise SystemExit()

# ─── ৩) (ঐচ্ছিক) নিজের ডাটা আপলোড ───────────────────────────
try:
    from google.colab import files
    up = files.upload()          # Cancel চাপলে স্কিপ হবে
    if up:
        print('✅ আপলোড:', list(up.keys()))
    else:
        print('ℹ️ নিজের ডাটা স্কিপ (ফাইন, ডিফল্ট ডাটা দিয়েই হবে)')
except Exception as e:
    print('ℹ️ নিজের ডাটা স্কিপ:', e)

# ─── ৪) (ঐচ্ছিক) Google Drive — ফেল করলেও সমস্যা নেই ────────
OUTPUT_DIR = '/content/my-ai-model'
try:
    from google.colab import drive
    drive.mount('/content/drive')
    if os.path.isdir('/content/drive/MyDrive'):
        OUTPUT_DIR = '/content/drive/MyDrive/my-ai-model'
except Exception:
    pass
os.makedirs(OUTPUT_DIR, exist_ok=True)
print('📁 মডেল সেভ হবে:', OUTPUT_DIR)

# ─── ৫) ট্রেনিং ফাইল নামাও (git-এর দরকার নেই — সরাসরি ডাউনলোড) ─
# রিপোটা PUBLIC হলে এই ফাইলগুলো raw.githubusercontent থেকে নামবে।
import urllib.request

TRAIN_DIR = '/content/NO-RULES-AI/training'
RAW_BASE = 'https://raw.githubusercontent.com/tufazzal513/NO-RULES-AI/main'
REQUIRED = {
    'training/train_lora.py': os.path.join(TRAIN_DIR, 'train_lora.py'),
    'training/build_mix.py':  os.path.join(TRAIN_DIR, 'build_mix.py'),
    'data/import/bangla-english-banglish-chat.jsonl': os.path.join(TRAIN_DIR, 'bangla-english-banglish-chat.jsonl'),
}
os.makedirs(TRAIN_DIR, exist_ok=True)
all_ok = True
for rel, dest in REQUIRED.items():
    try:
        urllib.request.urlretrieve(RAW_BASE + '/' + rel, dest)
        size = os.path.getsize(dest)
        if size < 1000:
            raise RuntimeError(f'ছোট/ভুল ফাইল ({size} bytes)')
        print('✅', rel, f'({size/1024:.0f} KB)')
    except Exception as e:
        all_ok = False
        print('❌', rel, '→', e)

if not all_ok:
    print('''
┌─────────────────────────────────────────────────────────────┐
│ 🚨 রিপোতে অ্যাক্সেস হচ্ছে না!                              │
│                                                             │
│ কারণ: tufazzal513/NO-RULES-AI রিপোটা PRIVATE —             │
│ Colab থেকে private রিপোর ফাইল নেওয়া যায় না।              │
│                                                             │
│ সমাধান (১ মিনিট):                                           │
│   GitHub → NO-RULES-AI → Settings → General →              │
│   Danger Zone → Change repository visibility →              │
│   Change to public → তারপর এই সেলটা আবার Run করুন           │
└─────────────────────────────────────────────────────────────┘
''')
    raise SystemExit(1)
os.chdir(TRAIN_DIR)

# ─── ৬) প্যাকেজ ইনস্টল (একবারই, ৩–৫ মিনিট) ──────────────────
try:
    from unsloth import FastLanguageModel
    print('✅ unsloth আগে থেকেই আছে')
except Exception:
    print('📦 unsloth ইনস্টল হচ্ছে (৩–৫ মিনিট)…')
    subprocess.run(['pip', 'install', '-q', '-U', 'unsloth'], check=True)
    subprocess.run(['pip', 'install', '-q', '-U', 'trl>=0.9', 'transformers>=4.44',
                    'datasets', 'accelerate', 'peft', 'bitsandbytes'], check=True)

# ─── ৭) ট্রেনিং (কাটা পড়া থাকলে নিজেই resume) ───────────────
ckpts = sorted(glob.glob(os.path.join(OUTPUT_DIR, 'checkpoint-*')))
final = os.path.isfile(os.path.join(OUTPUT_DIR, 'adapter_config.json'))

if final and not ckpts:
    print('✅ ট্রেনিং আগেই শেষ — শুধু প্যাকেজ করে নামানো হচ্ছে')
else:
    cmd = ['python', 'train_lora.py',
           '--model', MODEL, '--recipe', PLAN,
           '--time-budget-hours', str(HOURS), '--max-seq-length', '1024',
           '--assistant-name', ASSISTANT_NAME, '--owner-name', OWNER_NAME,
           '--extra-jsonl', 'myai-dataset.jsonl',
           '--extra-jsonl', '/content/myai-dataset.jsonl',
           '--extra-jsonl', os.path.join(TRAIN_DIR, 'bangla-english-banglish-chat.jsonl'),
           '--output', OUTPUT_DIR]
    if EXPORT_GGUF:
        cmd.append('--export-gguf')
    if ckpts:
        cmd.append('--resume')   # ডিসকানেক্টের পর আবার Run চাপলেই resume
    print('🚀 ট্রেনিং শুরু… (লগ নিচে আসছে)')
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1)
    for line in p.stdout:
        print(line, end='', flush=True)
    p.wait()
    if p.returncode != 0:
        print(f'❌ ট্রেনিং ব্যর্থ (exit {p.returncode}) — উপরের লাল লেখা কপি করে পাঠান')
        raise SystemExit(p.returncode)

# ─── ৮) zip + ডাউনলোড ───────────────────────────────────────
zpath = '/content/my-ai-model.zip'
if os.path.exists(zpath):
    os.remove(zpath)
shutil.make_archive('/content/my-ai-model', 'zip', OUTPUT_DIR)
print('📦 zip তৈরি:', zpath)
from google.colab import files
files.download(zpath)
print('🎉 শেষ! zip নামছে → খুলে Modelfile + .gguf নিন →')
print('   ollama create my-ai -f Modelfile  &&  ollama run my-ai')
