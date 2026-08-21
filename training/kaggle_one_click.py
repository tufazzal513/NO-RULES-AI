# ══════════════════════════════════════════════════════════════════
#  MY-AI এক-ক্লিক ট্রেনিং (Kaggle) — Colab-এর চেয়েও স্থিতিশীল
#
#  কেন Kaggle?
#   • ফ্রি GPU (T4×2 / P100), সপ্তাহে ৩০ ঘণ্টা
#   • সেশন ডিসকানেক্ট হয় না, ব্রাউজার বন্ধ করলেও ট্রেনিং চলে
#   • আউটপুট অটো-সেভ থাকে (Output ট্যাবে)
#
#  ব্যবহার:
#    1) kaggle.com এ লগইন → Create → New Notebook
#    2) Settings → Accelerator = GPU T4 x2 (বা P100), Internet = ON
#    3) এই কোডটা পেস্ট → Run All → ঘুম দিয়ে আসুন 😴
#    4) শেষে: Output ট্যাব → my-ai-model.zip → Download
#
#  নিজের ডাটা দিতে: + Add input → upload dataset → .jsonl ফাইল দিন
#  (/kaggle/input-এ যত .jsonl থাকবে সব অটো যুক্ত হবে)
# ══════════════════════════════════════════════════════════════════

import os, sys, subprocess, glob, shutil

# ─── ১) সেটিংস ──────────────────────────────────────────────
PLAN     = 'balanced'   # basic | balanced | advanced
HOURS    = 3            # 1 / 3 / 5 ঘণ্টা
MODEL    = 'unsloth/Qwen2.5-1.5B-Instruct'   # শক্তিশালী: unsloth/Qwen2.5-3B-Instruct
ASSISTANT_NAME = 'MY-AI'
OWNER_NAME     = ''     # আপনার নাম
EXPORT_GGUF    = True

OUTPUT_DIR = '/kaggle/working/my-ai-model'
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ─── ২) GPU চেক ──────────────────────────────────────────────
import torch
assert torch.cuda.is_available(), '❌ GPU OFF! Settings → Accelerator → GPU T4 x2 / P100'
print('✅ GPU OK:', torch.cuda.get_device_name(0))

# ─── ৩) প্যাকেজ ইনস্টল ──────────────────────────────────────
print('📦 unsloth ইনস্টল হচ্ছে (৩–৫ মিনিট)…')
subprocess.run(['pip', 'install', '-q', '-U', 'unsloth'], check=True)
subprocess.run(['pip', 'install', '-q', '-U', 'trl>=0.9', 'transformers>=4.44',
                'datasets', 'accelerate', 'peft', 'bitsandbytes'], check=True)

# ─── ৪) ট্রেনিং ফাইল নামাও (git-এর দরকার নেই — সরাসরি ডাউনলোড) ─
# রিপোটা PUBLIC হলে এই ফাইলগুলো raw.githubusercontent থেকে নামবে।
import urllib.request

TRAIN_DIR = '/kaggle/working/NO-RULES-AI/training'
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
│ Kaggle থেকে private রিপোর ফাইল নেওয়া যায় না।             │
│                                                             │
│ সমাধান (১ মিনিট):                                           │
│   GitHub → NO-RULES-AI → Settings → General →              │
│   Danger Zone → Change repository visibility →              │
│   Change to public → তারপর Run All আবার দিন                 │
└─────────────────────────────────────────────────────────────┘
''')
    raise SystemExit(1)
os.chdir(TRAIN_DIR)

# ─── ৫) নিজের ডাটা: /kaggle/input-এ যত .jsonl আছে সব নেবে ───
extras = []
for jl in sorted(glob.glob('/kaggle/input/**/*.jsonl', recursive=True)):
    extras += ['--extra-jsonl', jl]
    print('📥 ডাটা পাবে:', jl)

# ─── ৬) ট্রেনিং (কাটা পড়া থাকলে নিজেই resume) ───────────────
ckpts = sorted(glob.glob(os.path.join(OUTPUT_DIR, 'checkpoint-*')))
final = os.path.isfile(os.path.join(OUTPUT_DIR, 'adapter_config.json'))

if final and not ckpts:
    print('✅ ট্রেনিং আগেই শেষ — শুধু প্যাকেজ করা হচ্ছে')
else:
    cmd = ['python', 'train_lora.py',
           '--model', MODEL, '--recipe', PLAN,
           '--time-budget-hours', str(HOURS), '--max-seq-length', '1024',
           '--assistant-name', ASSISTANT_NAME, '--owner-name', OWNER_NAME,
           '--extra-jsonl', 'bangla-english-banglish-chat.jsonl',
           '--output', OUTPUT_DIR] + extras
    if EXPORT_GGUF:
        cmd.append('--export-gguf')
    if ckpts:
        cmd.append('--resume')
    print('🚀 ট্রেনিং শুরু… (লগ নিচে আসছে)')
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1)
    for line in p.stdout:
        print(line, end='', flush=True)
    p.wait()
    if p.returncode != 0:
        print(f'❌ ট্রেনিং ব্যর্থ (exit {p.returncode}) — উপরের লাল লেখা কপি করে পাঠান')
        raise SystemExit(p.returncode)

# ─── ৭) zip ─────────────────────────────────────────────────
zpath = '/kaggle/working/my-ai-model.zip'
if os.path.exists(zpath):
    os.remove(zpath)
shutil.make_archive('/kaggle/working/my-ai-model', 'zip', OUTPUT_DIR)
print('✅ শেষ! এখন Output ট্যাব → my-ai-model.zip → Download')
print('   খুলে Modelfile + .gguf নিন →  ollama create my-ai -f Modelfile')
