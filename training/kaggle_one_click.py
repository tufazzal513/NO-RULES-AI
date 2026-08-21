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

import os, sys, subprocess, glob, shutil, gc

# OOM guard: must be set before torch is imported anywhere in this session.
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

# ─── ১) সেটিংস ──────────────────────────────────────────────
PLAN     = 'balanced'   # basic | balanced | advanced
HOURS    = 5            # 1 / 3 / 5 ঘণ্টা
MODEL    = 'unsloth/Qwen2.5-1.5B-Instruct'   # শক্তিশালী: unsloth/Qwen2.5-3B-Instruct
ASSISTANT_NAME = 'MY-AI'
OWNER_NAME     = ''     # আপনার নাম
EXPORT_GGUF    = True

# ─── লাইভ মনিটরিং: MY-AI কন্ট্রোল প্যানেলে progress দেখুন ────
PANEL_URL      = ''   # যেমন: 'https://no-rules-ai.onrender.com'
PANEL_TOKEN    = ''   # প্যানেলের ADMIN_PASSWORD (সেট করা থাকলে)
RUN_ID = os.environ.get('MYAI_RUN_ID') or f'kaggle-{int(__import__("time").time())}'

OUTPUT_DIR = '/kaggle/working/my-ai-model'
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ─── ২) GPU চেক ──────────────────────────────────────────────
import torch
assert torch.cuda.is_available(), '❌ GPU OFF! Settings → Accelerator → GPU T4 x2 / P100'
VRAM_GB = torch.cuda.get_device_properties(0).total_memory / 1e9
print('✅ GPU OK:', torch.cuda.get_device_name(0), f'({VRAM_GB:.1f} GB VRAM)')
try:
    RAM_GB = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / 1e9
except Exception:
    RAM_GB = 0
print(f'🧠 সিস্টেম RAM: {RAM_GB:.1f} GB')
# T4 x2 হলেও ট্রেনিং এক GPU-তেই হয় — দ্বিতীয়টা লুকিয়ে রাখলে
# accelerate অযথা মডেল দুই কার্ডে ভাগ করতে গিয়ে OOM করে না।
os.environ.setdefault('CUDA_VISIBLE_DEVICES', '0')


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

# ─── ৬) ট্রেনিং (কাটা পড়া থাকলে resume, OOM হলে নিজেই হালকা করে) ────
ckpts = sorted(glob.glob(os.path.join(OUTPUT_DIR, 'checkpoint-*')))
final = os.path.isfile(os.path.join(OUTPUT_DIR, 'adapter_config.json'))

SEQ = 1024 if VRAM_GB >= 14 else (768 if VRAM_GB >= 11 else 512)
if VRAM_GB and VRAM_GB < 14:
    print(f'⚙️  ছোট GPU ({VRAM_GB:.1f} GB) — max-seq-length {SEQ} করা হলো')
ROWS_CAP = None
if RAM_GB and RAM_GB < 14:
    ROWS_CAP = min(int(HOURS * 9000), 12000)
    print(f'⚙️  RAM {RAM_GB:.1f} GB — ডাটা-পুল সর্বোচ্চ {ROWS_CAP} রো রাখা হলো')

OOM_HINT = ('out of memory', 'cuda oom', 'defaultcpuallocator', "can't allocate memory")


def run_training(extra_args, resume):
    cmd = ['python', 'train_lora.py',
           '--model', MODEL, '--recipe', PLAN,
           '--time-budget-hours', str(HOURS), '--max-seq-length', str(SEQ),
           '--assistant-name', ASSISTANT_NAME, '--owner-name', OWNER_NAME,
           '--extra-jsonl', 'bangla-english-banglish-chat.jsonl',
           '--output', OUTPUT_DIR,
           '--run-id', RUN_ID, '--platform', 'kaggle'] + extras + extra_args
    if PANEL_URL:
        cmd += ['--report-url', PANEL_URL, '--report-token', PANEL_TOKEN]
    if ROWS_CAP:
        cmd += ['--rows', str(ROWS_CAP)]
    if EXPORT_GGUF:
        cmd.append('--export-gguf')
    if resume:
        cmd.append('--resume')
    env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF='expandable_segments:True',
               TOKENIZERS_PARALLELISM='false', CUDA_VISIBLE_DEVICES='0')
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
    print('✅ ট্রেনিং আগেই শেষ — শুধু প্যাকেজ করা হচ্ছে')
else:
    gc.collect()
    extra, resume, rc = [], bool(ckpts), 1
    for attempt in range(1, 4):
        rc, saw_oom = run_training(extra, resume)
        if rc == 0:
            break
        killed = rc in (-9, 137, 247)   # RAM শেষ — প্রসেস kill হয়েছে
        if not (saw_oom or killed) or attempt == 3:
            break
        print('\n🛟 মেমোরি শেষ হয়েছিল — হালকা সেটিংসে আবার চালাচ্ছি…'
              if not killed else f'\n🧠 RAM শেষ (exit {rc}) — হালকা সেটিংসে আবার চালাচ্ছি…')
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

শেষ উপায়:
  1) উপরে MODEL বদলান:  MODEL = 'unsloth/Qwen2.5-0.5B-Instruct'
  2) অথবা HOURS = 1 করে আবার Run All দিন''')
        raise SystemExit(rc)


# ─── ৭) zip ─────────────────────────────────────────────────
zpath = '/kaggle/working/my-ai-model.zip'
if os.path.exists(zpath):
    os.remove(zpath)
shutil.make_archive('/kaggle/working/my-ai-model', 'zip', OUTPUT_DIR)
print('✅ শেষ! এখন Output ট্যাব → my-ai-model.zip → Download')
print('   খুলে Modelfile + .gguf নিন →  ollama create my-ai -f Modelfile')
