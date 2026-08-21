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
#
#  🔴 ডিসকানেক্ট হলে কী করবেন: শুধু এই সেলটা আবার Run দিন। ডাটা,
#     মডেল আর checkpoint সব Drive-এ আছে — শেষ checkpoint থেকেই চলবে।
# ══════════════════════════════════════════════════════════════════

import os, sys, subprocess, glob, shutil, re, gc, json, time

# OOM guard — torch import হওয়ার আগেই সেট হতে হবে।
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

# ─── ১) সেটিংস (এখানেই বদলান) ───────────────────────────────
PLAN  = 'balanced'   # basic | balanced | advanced
HOURS = 5            # 1 / 3 / 5 ঘণ্টা
ROWS  = 20000        # ডাটা-পুল (RAM কম হলে স্ক্রিপ্ট নিজেই কমাবে)
MODEL = 'unsloth/Qwen2.5-1.5B-Instruct'   # শক্তিশালী: unsloth/Qwen2.5-3B-Instruct
ASSISTANT_NAME = 'MY-AI'
OWNER_NAME     = ''  # আপনার নাম লিখুন — মডেল আপনার নাম জানবে
EXPORT_GGUF    = True

# ─── লাইভ মনিটরিং: MY-AI কন্ট্রোল প্যানেলে progress দেখুন ────
# প্যানেলের Training পেজে "Copy Colab cell" চাপলে ওই সেলে MYAI_*
# এনভায়রনমেন্ট ভ্যারিয়েবলগুলো বসানো থাকে — নিচের লাইনগুলো সেই
# মানগুলো নিয়ে নেয় (খালি থাকলে উপরের সেটিংসই থাকবে)।
PANEL_URL      = ''   # যেমন: 'https://no-rules-ai.onrender.com'
PANEL_TOKEN    = ''   # প্যানেলের ADMIN_PASSWORD (সেট করা থাকলে)

# env-এ মান থাকলে সেগুলো প্রাধান্য পায় (প্যানেলের কপি-করা সেলে এভাবেই আসে)।
PANEL_URL   = PANEL_URL   or os.environ.get('MYAI_PANEL_URL', '')
PANEL_TOKEN = PANEL_TOKEN or os.environ.get('MYAI_ADMIN_TOKEN', '')
PLAN        = os.environ.get('MYAI_PLAN')  or PLAN
MODEL       = os.environ.get('MYAI_MODEL') or MODEL
OWNER_NAME  = os.environ.get('MYAI_OWNER') or OWNER_NAME
try:
    HOURS = float(os.environ.get('MYAI_HOURS') or HOURS)
    HOURS = int(HOURS) if HOURS == int(HOURS) else HOURS
except (TypeError, ValueError):
    pass

RUN_ID = os.environ.get('MYAI_RUN_ID') or f'colab-{int(time.time())}'


def run_live(cmd, label, env=None):
    """সাবপ্রসেস চালায়, লগ লাইভ দেখায়, OOM লাইন ধরে রাখে।"""
    print(f'🚀 {label}…')
    saw_oom = False
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1, env=env or os.environ.copy())
    for line in p.stdout:
        print(line, end='', flush=True)
        low = line.lower()
        if any(h in low for h in ('out of memory', 'cuda oom', 'defaultcpuallocator',
                                  "can't allocate memory")):
            saw_oom = True
    p.wait()
    return p.returncode, saw_oom


def panel(**fields):
    """প্যানেলে ছোট একটা হার্টবিট পাঠায়। ব্যর্থ হলেও কিছু যায় আসে না।"""
    if not PANEL_URL:
        return
    import urllib.request
    url = PANEL_URL.rstrip('/') + '/api/v1/training/gpu/report'
    body = dict(fields, runId=RUN_ID, platform='colab')
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    if PANEL_TOKEN:
        req.add_header('x-admin-token', PANEL_TOKEN)
    try:
        urllib.request.urlopen(req, timeout=8)
    except Exception:
        pass


# ─── ২) GPU চেক ──────────────────────────────────────────────
import torch
assert torch.cuda.is_available(), 'GPU লাগবে: Runtime → Change runtime type → T4 GPU'
VRAM_GB = torch.cuda.get_device_properties(0).total_memory / 1e9
print('✅ GPU OK:', torch.cuda.get_device_name(0), f'({VRAM_GB:.1f} GB VRAM)')
try:
    RAM_GB = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / 1e9
except Exception:
    RAM_GB = 0
print(f'🧠 সিস্টেম RAM: {RAM_GB:.1f} GB')
if PANEL_URL:
    print(f'📡 লাইভ progress দেখুন: {PANEL_URL.rstrip("/")}  → Training ট্যাব')
panel(phase='starting', gpu=torch.cuda.get_device_name(0),
      vramGb=round(VRAM_GB, 1), ramGb=round(RAM_GB, 1), model=MODEL, recipe=PLAN,
      event='Colab সেশন শুরু হলো')

# ─── ৩) (ঐচ্ছিক) নিজের ডাটা আপলোড ───────────────────────────
UPLOADED = []
try:
    from google.colab import files
    up = files.upload()          # Cancel চাপলে স্কিপ হবে
    for k in list(up):
        clean = re.sub(r'\s*\(\d+\)(?=\.)', '', k)   # "data (1).jsonl" → "data.jsonl"
        src, dst = '/content/' + k, '/content/' + clean
        if os.path.abspath(src) != os.path.abspath(dst):
            shutil.move(src, dst)
        UPLOADED.append(dst)
    del up
    gc.collect()
    if UPLOADED:
        print('✅ আপলোড:', UPLOADED)
    else:
        print('ℹ️ নিজের ডাটা স্কিপ (ফাইন, ডিফল্ট ডাটা দিয়েই হবে)')
except Exception as e:
    print('ℹ️ নিজের ডাটা স্কিপ:', e)

# আগের রানে আপলোড করা ফাইল থাকলে সেগুলোও নিয়ে নিই (resume-এর সময় কাজে লাগে)
for jl in sorted(glob.glob('/content/*.jsonl')):
    if jl not in UPLOADED:
        UPLOADED.append(jl)

# ─── ৪) Drive (ঐচ্ছিক, কিন্তু জোরালো সুপারিশ) ────────────────
# Drive-এ সেভ করলে Colab ডিসকানেক্ট হলেও checkpoint বেঁচে থাকে।
OUTPUT_DIR = '/content/my-ai-model'
try:
    from google.colab import drive
    drive.mount('/content/drive')
    if os.path.isdir('/content/drive/MyDrive'):
        OUTPUT_DIR = '/content/drive/MyDrive/my-ai-model'
except Exception:
    print('⚠️ Drive mount হয়নি — ডিসকানেক্ট হলে checkpoint হারাতে পারে')
os.makedirs(OUTPUT_DIR, exist_ok=True)
print('📁 মডেল সেভ হবে:', OUTPUT_DIR)

# ─── ৫) ট্রেনিং ফাইল (রিপো আগে থেকে থাকলে স্কিপ) ─────────────
TRAIN_DIR = '/content/NO-RULES-AI/training'
RAW = 'https://raw.githubusercontent.com/tufazzal513/NO-RULES-AI/main/'
NEEDED = {
    'training/train_lora.py': os.path.join(TRAIN_DIR, 'train_lora.py'),
    'training/build_mix.py':  os.path.join(TRAIN_DIR, 'build_mix.py'),
    'data/import/bangla-english-banglish-chat.jsonl':
        os.path.join(TRAIN_DIR, 'bangla-english-banglish-chat.jsonl'),
}
if not os.path.isfile(NEEDED['training/train_lora.py']):
    import urllib.request
    os.makedirs(TRAIN_DIR, exist_ok=True)
    ok = True
    for rel, dest in NEEDED.items():
        try:
            urllib.request.urlretrieve(RAW + rel, dest)
            size = os.path.getsize(dest)
            if size < 1000:
                raise RuntimeError(f'ছোট/ভুল ফাইল ({size} bytes)')
            print('✅', rel, f'({size/1024:.0f} KB)')
        except Exception as e:
            ok = False
            print('❌', rel, '→', e)
    if not ok:
        print('''
┌─────────────────────────────────────────────────────────────┐
│ 🚨 রিপোতে অ্যাক্সেস হচ্ছে না!                              │
│ কারণ: রিপোটা PRIVATE — Colab থেকে private রিপো পড়া যায় না। │
│ সমাধান: GitHub → NO-RULES-AI → Settings → General →         │
│   Danger Zone → Change visibility → Public → আবার Run       │
└─────────────────────────────────────────────────────────────┘''')
        panel(phase='failed', eventLevel='error', event='রিপো private — ফাইল নামানো যায়নি')
        raise SystemExit(1)
else:
    print('✅ ট্রেনিং ফাইল আগে থেকেই আছে')
os.chdir(TRAIN_DIR)

# ─── ৬) unsloth (আগে ইনস্টল থাকলে স্কিপ) ────────────────────
try:
    from unsloth import FastLanguageModel
    print('✅ unsloth আগে থেকেই আছে')
except Exception:
    print('📦 unsloth ইনস্টল হচ্ছে (৩–৫ মিনিট)…')
    subprocess.run(['pip', 'install', '-q', '-U', 'unsloth'], check=True)
    subprocess.run(['pip', 'install', '-q', '-U', 'trl>=0.9', 'transformers>=4.44',
                    'datasets', 'accelerate', 'peft', 'bitsandbytes'], check=True)

# ─── ৭) ধাপ A: ডাটা বিল্ড (আগে থেকে থাকলে স্কিপ) ─────────────
DATA_DIR = os.path.join(TRAIN_DIR, 'data')
train_file = os.path.join(DATA_DIR, 'train.jsonl')
val_file = os.path.join(DATA_DIR, 'val.jsonl')
if os.path.isfile(train_file) and not os.path.isfile(val_file):
    os.remove(train_file)          # অসম্পূর্ণ বিল্ড — আবার বানাই

if os.path.isfile(train_file):
    print('✅ রেডিমেড ডাটা আছে — ডাউনলোড স্কিপ')
else:
    panel(phase='data', event='HF থেকে বাংলা+English ডাটা নামছে…')
    cmd = ['python', 'build_mix.py', '--recipe', PLAN, '--budget-hours', str(HOURS),
           '--rows', str(ROWS), '--assistant-name', ASSISTANT_NAME,
           '--owner-name', OWNER_NAME, '--output', DATA_DIR]
    for p in UPLOADED:
        cmd += ['--extra-jsonl', p]
    cmd += ['--extra-jsonl', os.path.join(TRAIN_DIR, 'bangla-english-banglish-chat.jsonl')]
    rc, _ = run_live(cmd, 'ধাপ A: ডাটা বিল্ড')
    if rc != 0:
        panel(phase='failed', eventLevel='error', event=f'ডাটা বিল্ড ব্যর্থ (exit {rc})')
        raise SystemExit(rc)
    # HF cache ~10 GB পর্যন্ত হতে পারে — ট্রেনিংয়ে আর দরকার নেই।
    subprocess.run(['rm', '-rf', os.path.expanduser('~/.cache/huggingface/hub')],
                   stderr=subprocess.DEVNULL)
    gc.collect()
    du = shutil.disk_usage('/content')
    print(f'💾 ডিস্ক ফ্রি: {du.free/1e9:.1f} GB / {du.total/1e9:.1f} GB')

# ─── ৮) ধাপ C: ট্রেনিং (resume + OOM অটো-রিকভারি) ────────────
SEQ = 1024 if VRAM_GB >= 14 else (768 if VRAM_GB >= 11 else 512)
if VRAM_GB < 14:
    print(f'⚙️  ছোট GPU ({VRAM_GB:.1f} GB) — max-seq-length {SEQ}')

ckpts = sorted(glob.glob(os.path.join(OUTPUT_DIR, 'checkpoint-*')))
done = os.path.isfile(os.path.join(OUTPUT_DIR, 'adapter_config.json'))

if done and not ckpts:
    print('✅ ট্রেনিং আগেই শেষ — শুধু প্যাকেজ করা হচ্ছে')
else:
    if ckpts:
        print(f'↩️  {len(ckpts)} টা checkpoint পাওয়া গেছে — শেষটা থেকে resume হবে')
    base = ['python', 'train_lora.py', '--train', train_file, '--val', val_file,
            '--model', MODEL, '--time-budget-hours', str(HOURS),
            '--assistant-name', ASSISTANT_NAME, '--owner-name', OWNER_NAME,
            '--output', OUTPUT_DIR, '--run-id', RUN_ID, '--platform', 'colab']
    if PANEL_URL:
        base += ['--report-url', PANEL_URL, '--report-token', PANEL_TOKEN]
    if EXPORT_GGUF:
        base.append('--export-gguf')

    env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF='expandable_segments:True',
               TOKENIZERS_PARALLELISM='false')
    extra, rc = ['--max-seq-length', str(SEQ)], 1
    for attempt in range(1, 4):
        cmd = base + extra
        if sorted(glob.glob(os.path.join(OUTPUT_DIR, 'checkpoint-*'))):
            cmd.append('--resume')
        rc, saw_oom = run_live(cmd, f'ধাপ C: ট্রেনিং (চেষ্টা {attempt}/3)', env)
        if rc == 0:
            break
        killed = rc in (-9, 137, 247)     # RAM শেষ → প্রসেস kill
        if not (saw_oom or killed) or attempt == 3:
            break
        print(f'''
┌─────────────────────────────────────────────────────────────┐
│ 🧠 {'RAM শেষ হয়ে প্রসেস বন্ধ' if killed else 'GPU মেমোরি শেষ'} (exit {rc})
│ চিন্তা নেই — হালকা সেটিংসে checkpoint থেকে আবার চলবে।       │
└─────────────────────────────────────────────────────────────┘''')
        panel(phase='oom-recovery', oomRetries=attempt, eventLevel='warn',
              event=f'মেমোরি শেষ (exit {rc}) — হালকা সেটিংসে চেষ্টা {attempt+1}/3')
        if attempt == 1:
            extra = ['--max-seq-length', str(SEQ), '--no-eval',
                     '--batch-size', '1', '--grad-accum', '16']
        else:
            SEQ = max(384, SEQ - 256)
            extra = ['--max-seq-length', str(SEQ), '--no-eval', '--no-packing',
                     '--batch-size', '1', '--grad-accum', '16', '--dataset-num-proc', '1']
        gc.collect()

    if rc != 0:
        panel(phase='failed', eventLevel='error', event=f'ট্রেনিং ব্যর্থ (exit {rc})')
        print(f'''❌ ট্রেনিং ব্যর্থ (exit {rc})

শেষ উপায় — যেকোনো একটা:
  1) উপরে MODEL বদলান:  MODEL = 'unsloth/Qwen2.5-0.5B-Instruct'
  2) HOURS = 1 করে আবার Run দিন
তবু না হলে উপরের লাল লেখা কপি করে পাঠান।''')
        raise SystemExit(rc)

# ─── ৯) zip + ডাউনলোড ───────────────────────────────────────
zpath = '/content/my-ai-model.zip'
if os.path.exists(zpath):
    os.remove(zpath)
shutil.make_archive('/content/my-ai-model', 'zip', OUTPUT_DIR)
print('📦 zip তৈরি:', zpath, f'({os.path.getsize(zpath)/1e6:.0f} MB)')
try:
    from google.colab import files
    files.download(zpath)
except Exception as e:
    print('⚠️ অটো-ডাউনলোড হয়নি:', e, '— বাঁ পাশের Files প্যানেল থেকে নামিয়ে নিন')
print('🎉 শেষ! zip খুলে Modelfile + .gguf নিন →')
print('   ollama create my-ai -f Modelfile  &&  ollama run my-ai')
