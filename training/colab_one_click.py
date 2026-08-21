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

import os, sys, subprocess, glob, shutil, gc

# OOM guard: fragmentation is the #1 cause of "CUDA out of memory" on a T4.
# Must be set before torch is imported anywhere in this session.
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

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
    VRAM_GB = torch.cuda.get_device_properties(0).total_memory / 1e9
    print('✅ GPU OK:', torch.cuda.get_device_name(0), f'({VRAM_GB:.1f} GB VRAM)')
except Exception:
    VRAM_GB = 0
    print('❌ GPU নেই! Runtime → Change runtime type → T4 GPU → Save, তারপর আবার Run দিন')
    raise SystemExit()

try:
    RAM_GB = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / 1e9
except Exception:
    RAM_GB = 0
print(f'🧠 সিস্টেম RAM: {RAM_GB:.1f} GB')


# ─── ৩) (ঐচ্ছিক) নিজের ডাটা আপলোড ───────────────────────────
try:
    from google.colab import files
    up = files.upload()          # Cancel চাপলে স্কিপ হবে
    if up:
        print('✅ আপলোড:', list(up.keys()))
    else:
        print('ℹ️ নিজের ডাটা স্কিপ (ফাইন, ডিফল্ট ডাটা দিয়েই হবে)')
    del up                        # আপলোড করা ফাইলটা RAM-এ ধরে রাখার দরকার নেই
    gc.collect()
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

# ─── ৭) ট্রেনিং (কাটা পড়া থাকলে নিজেই resume, OOM হলে নিজেই হালকা করে) ──
ckpts = sorted(glob.glob(os.path.join(OUTPUT_DIR, 'checkpoint-*')))
final = os.path.isfile(os.path.join(OUTPUT_DIR, 'adapter_config.json'))

# VRAM অনুযায়ী নিরাপদ সিকোয়েন্স-লেংথ (train_lora.py নিজেও আরেকবার চেক করে)
SEQ = 1024 if VRAM_GB >= 14 else (768 if VRAM_GB >= 11 else 512)
if VRAM_GB and VRAM_GB < 14:
    print(f'⚙️  ছোট GPU ({VRAM_GB:.1f} GB) — max-seq-length {SEQ} করা হলো')

# RAM কম হলে ডাটা-পুল ছোট রাখি: ১৭ হাজার রো টোকেনাইজ করতেই Colab-এর
# ১২.৭ GB RAM ভরে যেতে পারে, আর তখন সেশনটাই মারা যায় (exit -9)।
ROWS_CAP = None
if RAM_GB and RAM_GB < 14:
    ROWS_CAP = min(int(HOURS * 9000), 12000)
    print(f'⚙️  RAM {RAM_GB:.1f} GB — ডাটা-পুল সর্বোচ্চ {ROWS_CAP} রো রাখা হলো')

OOM_HINT = ('out of memory', 'cuda oom', 'defaultcpuallocator', "can't allocate memory")


def run_training(extra_args, resume):
    """ট্রেনিং চালায়। ফেরত দেয়: (exit_code, oom_hoyeche?)"""
    cmd = ['python', 'train_lora.py',
           '--model', MODEL, '--recipe', PLAN,
           '--time-budget-hours', str(HOURS), '--max-seq-length', str(SEQ),
           '--assistant-name', ASSISTANT_NAME, '--owner-name', OWNER_NAME,
           '--extra-jsonl', 'myai-dataset.jsonl',
           '--extra-jsonl', '/content/myai-dataset.jsonl',
           '--extra-jsonl', os.path.join(TRAIN_DIR, 'bangla-english-banglish-chat.jsonl'),
           '--output', OUTPUT_DIR] + extra_args
    if ROWS_CAP:
        cmd += ['--rows', str(ROWS_CAP)]
    if EXPORT_GGUF:
        cmd.append('--export-gguf')
    if resume:
        cmd.append('--resume')
    env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF='expandable_segments:True',
               TOKENIZERS_PARALLELISM='false')
    print('🚀 ট্রেনিং শুরু… (লগ নিচে আসছে)')
    saw_oom = False
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1, env=env)
    for line in p.stdout:
        print(line, end='', flush=True)
        low = line.lower()
        if any(h in low for h in OOM_HINT):
            saw_oom = True
    p.wait()
    return p.returncode, saw_oom


if final and not ckpts:
    print('✅ ট্রেনিং আগেই শেষ — শুধু প্যাকেজ করে নামানো হচ্ছে')
else:
    gc.collect()
    extra, resume, rc = [], bool(ckpts), 1
    for attempt in range(1, 4):
        rc, saw_oom = run_training(extra, resume)
        if rc == 0:
            break
        # exit -9 / 137 = কার্নেল প্রসেসটাকে মেরে ফেলেছে = RAM শেষ
        killed = rc in (-9, 137, 247)
        if not (saw_oom or killed) or attempt == 3:
            break
        if killed:
            print(f'''
┌─────────────────────────────────────────────────────────────┐
│ 🧠 RAM শেষ হয়ে প্রসেস বন্ধ হয়ে গেছে (exit {rc})              │
│ চিন্তা নেই — এবার হালকা সেটিংসে নিজে থেকেই আবার চলবে।       │
└─────────────────────────────────────────────────────────────┘''')
        else:
            print('\n🛟 GPU মেমোরি শেষ হয়েছিল — হালকা সেটিংসে আবার চালাচ্ছি…')
        # প্রতি চেষ্টায় এক ধাপ হালকা: eval বন্ধ → packing বন্ধ + ছোট seq
        if attempt == 1:
            extra = ['--no-eval', '--batch-size', '1', '--grad-accum', '16']
        else:
            SEQ = max(384, SEQ - 256)
            extra = ['--no-eval', '--no-packing', '--batch-size', '1',
                     '--grad-accum', '16', '--max-seq-length', str(SEQ),
                     '--dataset-num-proc', '1']
            ROWS_CAP = min(ROWS_CAP or 12000, 8000)
        resume = bool(sorted(glob.glob(os.path.join(OUTPUT_DIR, 'checkpoint-*'))))
        gc.collect()
        print(f'♻️  চেষ্টা {attempt + 1}/3: ' + ' '.join(extra))

    if rc != 0:
        print(f'''❌ ট্রেনিং ব্যর্থ (exit {rc})

শেষ উপায় — নিচের দুটোর যেকোনো একটা করুন:
  1) উপরে MODEL বদলে দিন:  MODEL = 'unsloth/Qwen2.5-0.5B-Instruct'
  2) HOURS কমিয়ে 1 করুন, তারপর আবার Run দিন
তবু না হলে উপরের লাল লেখা কপি করে পাঠান।''')
        raise SystemExit(rc)


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
