"""Recipe: image classification (fine-tunes an ImageNet ResNet-50).

Data: ZIP / TAR archives with one folder per class (cat/xxx.jpg, dog/yyy.jpg), optionally split into
train/ and val/ folders; or a Hugging Face dataset with `image` + `label` columns.

Output (/workspace/output): model.pt (TorchScript), labels.json, config.json, metrics.json.
"""
import glob
import json
import os
import random
import subprocess
import sys
import tarfile
import zipfile

import torch
import torch.nn as nn

try:
    import torchvision  # noqa: F401
except ImportError:
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'torchvision'])

from torch.utils.data import DataLoader, Subset  # noqa: E402
from torchvision import datasets, models, transforms  # noqa: E402

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
cfg = manifest.get('config', {})
DATA = os.environ.get('AIM_DATA', '/workspace/data')
OUT = os.environ.get('AIM_OUTPUT', '/workspace/output')
IMAGES = os.path.join(DATA, 'images')
SIZE = int(cfg.get('imageSize', 224))
EPOCHS = int(cfg.get('epochs', 10))
BATCH = int(cfg.get('batchSize', 32))
EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.bmp')
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
random.seed(7)
torch.manual_seed(7)
device = 'cuda' if torch.cuda.is_available() else 'cpu'

print('AIM_STAGE preparing', flush=True)


def safe_extract(path, dest):
    """Extracts an archive, refusing entries that escape `dest`."""
    root = os.path.realpath(dest)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                if not os.path.realpath(os.path.join(dest, name)).startswith(root + os.sep):
                    raise SystemExit(f'Unsafe path in archive: {name}')
            z.extractall(dest)
    elif tarfile.is_tarfile(path):
        with tarfile.open(path) as t:
            for m in t.getmembers():
                if m.issym() or m.islnk() or not os.path.realpath(os.path.join(dest, m.name)).startswith(root + os.sep):
                    raise SystemExit(f'Unsafe entry in archive: {m.name}')
            t.extractall(dest)


def class_root(base):
    """Deepest single-child chain until a folder with ≥2 class folders of images."""
    cur = base
    while True:
        subs = [d for d in sorted(os.listdir(cur)) if os.path.isdir(os.path.join(cur, d)) and not d.startswith(('.', '__'))]
        if len(subs) == 1:
            cur = os.path.join(cur, subs[0])
            continue
        return cur


os.makedirs(IMAGES, exist_ok=True)
if manifest.get('hfDataset'):
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'datasets>=3.0', 'pillow'])
    from datasets import load_dataset

    ds = load_dataset(manifest['hfDataset'], split='train')
    names = ds.features['label'].names if hasattr(ds.features.get('label'), 'names') else None
    for i, row in enumerate(ds):
        lab = names[row['label']] if names else str(row['label'])
        os.makedirs(os.path.join(IMAGES, lab), exist_ok=True)
        row['image'].convert('RGB').save(os.path.join(IMAGES, lab, f'{i}.jpg'))
else:
    for path in sorted(glob.glob(os.path.join(DATA, 'raw', '*'))):
        safe_extract(path, IMAGES)

root = class_root(IMAGES)
split_dirs = {d.lower(): os.path.join(root, d) for d in os.listdir(root)}
train_dir = split_dirs.get('train')
val_dir = split_dirs.get('val') or split_dirs.get('valid') or split_dirs.get('validation') or split_dirs.get('test')

train_tf = transforms.Compose([
    transforms.RandomResizedCrop(SIZE, scale=(0.6, 1.0)),
    transforms.RandomHorizontalFlip(),
    transforms.ColorJitter(0.2, 0.2, 0.2),
    transforms.ToTensor(),
    transforms.Normalize(MEAN, STD),
])
eval_tf = transforms.Compose([
    transforms.Resize(int(SIZE * 1.14)),
    transforms.CenterCrop(SIZE),
    transforms.ToTensor(),
    transforms.Normalize(MEAN, STD),
])

valid = lambda p: p.lower().endswith(EXTS)  # noqa: E731
if train_dir and val_dir:
    train_set = datasets.ImageFolder(train_dir, transform=train_tf, is_valid_file=valid)
    val_set = datasets.ImageFolder(val_dir, transform=eval_tf, is_valid_file=valid)
    classes = train_set.classes
else:
    full_train = datasets.ImageFolder(root, transform=train_tf, is_valid_file=valid)
    full_eval = datasets.ImageFolder(root, transform=eval_tf, is_valid_file=valid)
    classes = full_train.classes
    idx = list(range(len(full_train)))
    random.shuffle(idx)
    cut = max(1, int(len(idx) * 0.15))
    train_set, val_set = Subset(full_train, idx[cut:]), Subset(full_eval, idx[:cut])

if len(classes) < 2:
    sys.exit('Need at least 2 class folders with images.')
print(f'{len(classes)} classes, {len(train_set)} train / {len(val_set)} val images', flush=True)

train_dl = DataLoader(train_set, batch_size=BATCH, shuffle=True, num_workers=4, pin_memory=True)
val_dl = DataLoader(val_set, batch_size=BATCH, num_workers=4)

print('AIM_STAGE training', flush=True)
model = models.resnet50(weights=models.ResNet50_Weights.DEFAULT)
model.fc = nn.Linear(model.fc.in_features, len(classes))
model = model.to(device)
opt = torch.optim.AdamW(model.parameters(), lr=float(cfg.get('learningRate', 1e-3)) * 0.1, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=float(cfg.get('learningRate', 1e-3)), total_steps=EPOCHS * max(1, len(train_dl)))
scaler = torch.amp.GradScaler(enabled=device == 'cuda')
loss_fn = nn.CrossEntropyLoss(label_smoothing=0.1)


def evaluate():
    model.eval()
    correct = total = 0
    with torch.no_grad():
        for x, y in val_dl:
            pred = model(x.to(device)).argmax(1).cpu()
            correct += int((pred == y).sum())
            total += len(y)
    return correct / max(1, total)


best, best_state = -1.0, None
for epoch in range(EPOCHS):
    model.train()
    for x, y in train_dl:
        x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
        opt.zero_grad()
        with torch.autocast(device_type='cuda', enabled=device == 'cuda'):
            loss = loss_fn(model(x), y)
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        sched.step()
    acc = evaluate()
    if acc > best:
        best = acc
        best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    print(f'epoch {epoch + 1}/{EPOCHS} val_acc {acc:.3f}', flush=True)
    print(f'AIM_PROGRESS {int(100 * (epoch + 1) / EPOCHS)}', flush=True)
    print('AIM_METRICS ' + json.dumps({'valAccuracy': round(best, 4), 'epoch': epoch + 1}), flush=True)

print('AIM_STAGE export', flush=True)
model.load_state_dict(best_state)
model = model.to('cpu').eval()
os.makedirs(OUT, exist_ok=True)
torch.jit.trace(model, torch.zeros(1, 3, SIZE, SIZE)).save(os.path.join(OUT, 'model.pt'))
json.dump(classes, open(os.path.join(OUT, 'labels.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
json.dump({'task': 'image-classification', 'arch': 'resnet50', 'imageSize': SIZE, 'mean': MEAN, 'std': STD},
          open(os.path.join(OUT, 'config.json'), 'w'), indent=2)
metrics = {'classes': len(classes), 'trainImages': len(train_set), 'valImages': len(val_set), 'valAccuracy': round(best, 4)}
json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w'), indent=2)
print('AIM_METRICS ' + json.dumps(metrics), flush=True)
print('AIM_PROGRESS 100', flush=True)
