"""Recipe: action recognition from real-world videos (e.g. martial-arts moves).

Each uploaded clip carries the label of the move performed. The recipe extracts body pose per frame,
cuts sliding windows, and trains a small GRU classifier on the keypoint features. Validation holds
out whole videos when a label has several, so the score reflects unseen performers/takes.

Output (/workspace/output): model.pt (TorchScript), labels.json, config.json, metrics.json,
predict_action.py + pose_features.py for inference on new videos.
"""
import json
import os
import random
import shutil
import sys

import numpy as np

import pose_features as pf

pf.ensure_deps()

import torch  # noqa: E402
import torch.nn as nn  # noqa: E402

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
cfg = manifest.get('config', {})
DATA = os.environ.get('AIM_DATA', '/workspace/data')
OUT = os.environ.get('AIM_OUTPUT', '/workspace/output')
CACHE = os.path.join(os.environ.get('AIM_HOME', '/workspace/aim'), 'pose_cache')
FPS = int(cfg.get('fps', 30))
WIN = max(4, int(round(float(cfg.get('windowSec', 2)) * FPS)))
STRIDE = max(1, int(round(float(cfg.get('strideSec', 0.5)) * FPS)))
EPOCHS = int(cfg.get('epochs', 60))
LR = float(cfg.get('learningRate', 1e-3))
MIRROR = bool(cfg.get('mirror', True))
SEED = 7

random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
device = 'cuda' if torch.cuda.is_available() else 'cpu'

files = [f for f in manifest['files'] if f.get('label')]
labels = sorted({f['label'] for f in files})
label_idx = {name: i for i, name in enumerate(labels)}
print(f'{len(files)} videos, {len(labels)} labels: {", ".join(labels)}', flush=True)

# ---------- 1. pose extraction ----------
print('AIM_STAGE pose', flush=True)
clips = []
for i, f in enumerate(files):
    path = os.path.join(DATA, f['path'])
    kp, fps = pf.extract(path, FPS, cache_dir=CACHE)
    norm = pf.normalize(kp)
    if norm is None:
        print(f'WARNING: no clear person in {f["filename"]}, skipped', flush=True)
    else:
        clips.append({'label': label_idx[f['label']], 'name': f['filename'], 'norm': norm, 'fps': fps})
        print(f'{f["filename"]}: {norm.shape[0]} frames @ {fps:.0f} fps', flush=True)
    print(f'AIM_PROGRESS {int(40 * (i + 1) / len(files))}', flush=True)

present = {c['label'] for c in clips}
if len(present) < 2:
    sys.exit('Need usable videos for at least 2 labels (people must be fully visible).')

# ---------- 2. windows + split by video ----------
by_label = {}
for c in clips:
    by_label.setdefault(c['label'], []).append(c)

train, val = [], []
for lab, group in by_label.items():
    random.shuffle(group)
    if len(group) >= 2:
        n_val = max(1, int(round(len(group) * 0.2)))
        for j, c in enumerate(group):
            target = val if j < n_val else train
            target.extend((w, lab) for w in pf.windows(c['norm'], WIN, STRIDE))
    else:
        ws = pf.windows(group[0]['norm'], WIN, STRIDE)
        cut = max(1, int(len(ws) * 0.8)) if len(ws) > 1 else len(ws)
        train.extend((w, lab) for w in ws[:cut])
        val.extend((w, lab) for w in ws[cut:])

if MIRROR:
    train.extend([(pf.mirror(w), lab) for w, lab in train])
print(f'windows: train {len(train)}, val {len(val)} (window {WIN} frames, stride {STRIDE})', flush=True)


def to_tensor(items, augment=False):
    feats = []
    for w, _ in items:
        if augment:
            theta = np.random.uniform(-0.15, 0.15)
            rot = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]], dtype=np.float32)
            w = (w @ rot.T) * np.random.uniform(0.9, 1.1) + np.random.normal(0, 0.01, w.shape).astype(np.float32)
        feats.append(pf.frame_features(w, FPS))
    x = torch.tensor(np.stack(feats), dtype=torch.float32)
    y = torch.tensor([lab for _, lab in items], dtype=torch.long)
    return x, y


class MoveClassifier(nn.Module):
    def __init__(self, in_dim, n_classes, hidden=128):
        super().__init__()
        self.norm = nn.LayerNorm(in_dim)
        self.gru = nn.GRU(in_dim, hidden, num_layers=2, batch_first=True, dropout=0.2, bidirectional=True)
        self.head = nn.Sequential(nn.Dropout(0.3), nn.Linear(hidden * 2, n_classes))

    def forward(self, x):
        out, _ = self.gru(self.norm(x))
        return self.head(out.mean(dim=1))


# ---------- 3. training ----------
print('AIM_STAGE training', flush=True)
model = MoveClassifier(pf.FEATURE_DIM, len(labels)).to(device)
opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-3)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)
loss_fn = nn.CrossEntropyLoss(label_smoothing=0.05)
val_x, val_y = to_tensor(val) if val else (None, None)
best_acc, best_state = float('-inf'), None
BATCH = 64

for epoch in range(EPOCHS):
    model.train()
    random.shuffle(train)
    total = 0.0
    for s in range(0, len(train), BATCH):
        x, y = to_tensor(train[s:s + BATCH], augment=True)
        x, y = x.to(device), y.to(device)
        opt.zero_grad()
        loss = loss_fn(model(x), y)
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        total += loss.item() * len(y)
    sched.step()

    acc = None
    if val_x is not None:
        model.eval()
        with torch.no_grad():
            pred = model(val_x.to(device)).argmax(1).cpu()
        acc = float((pred == val_y).float().mean())
    score = acc if acc is not None else -total
    if score > best_acc:
        best_acc = score
        best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    print(f'epoch {epoch + 1}/{EPOCHS} loss {total / max(1, len(train)):.4f}' + (f' val_acc {acc:.3f}' if acc is not None else ''), flush=True)
    print(f'AIM_PROGRESS {40 + int(55 * (epoch + 1) / EPOCHS)}', flush=True)

model.load_state_dict(best_state)
model.eval()

# ---------- 4. evaluation + export ----------
print('AIM_STAGE export', flush=True)
metrics = {'labels': len(labels), 'videos': len(clips), 'trainWindows': len(train), 'valWindows': len(val)}
if val_x is not None:
    with torch.no_grad():
        pred = model(val_x.to(device)).argmax(1).cpu().numpy()
    truth = val_y.numpy()
    metrics['valAccuracy'] = round(float((pred == truth).mean()), 4)
    per = {}
    confusion = np.zeros((len(labels), len(labels)), dtype=int)
    for t, p in zip(truth, pred):
        confusion[t, p] += 1
    for i, name in enumerate(labels):
        n = int((truth == i).sum())
        if n:
            per[name] = round(float(confusion[i, i] / n), 3)
    metrics['perLabelAccuracy'] = per
    metrics['confusion'] = {'labels': labels, 'matrix': confusion.tolist()}

os.makedirs(OUT, exist_ok=True)
cpu_model = model.to('cpu')
example = torch.zeros(1, WIN, pf.FEATURE_DIM)
torch.jit.trace(cpu_model, example).save(os.path.join(OUT, 'model.pt'))
json.dump(labels, open(os.path.join(OUT, 'labels.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
json.dump(
    {
        'task': 'action-recognition',
        'feature': pf.FEATURE_VERSION,
        'fps': FPS,
        'windowFrames': WIN,
        'strideFrames': STRIDE,
        'inputDim': pf.FEATURE_DIM,
        'poseModel': os.environ.get('AIM_POSE_MODEL', 'yolo11m-pose.pt'),
    },
    open(os.path.join(OUT, 'config.json'), 'w', encoding='utf-8'),
    indent=2,
)
json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
here = os.path.dirname(os.path.abspath(__file__))
for name in ('predict_action.py', 'pose_features.py'):
    shutil.copy(os.path.join(here, name), os.path.join(OUT, name))
with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8') as f:
    f.write(
        '# Action recognition model (AI Markets)\n\n'
        f'Labels: {", ".join(labels)}\n\n'
        '```bash\npip install torch ultralytics opencv-python-headless numpy\n'
        'python predict_action.py my_video.mp4\n```\n\n'
        'Prints the move detected in each window and the overall top move.\n'
    )

summary = {k: v for k, v in metrics.items() if k != 'confusion'}
print('AIM_METRICS ' + json.dumps(summary, ensure_ascii=False), flush=True)
print('AIM_PROGRESS 100', flush=True)
