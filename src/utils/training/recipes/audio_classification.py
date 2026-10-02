"""Recipe: voice / audio classification — who is speaking, which command, which emotion…

Each clip carries a label (e.g. speaker name, "bật đèn", "vui"). Fine-tunes a pretrained speech
encoder (wav2vec2 by default) with a classification head.

Output (/workspace/output/model): model + feature extractor, usable with
transformers.pipeline("audio-classification", model="model").
"""
import json
import os
import random
import sys

import numpy as np

import audio_utils as au

au.ensure_ffmpeg()
au.ensure_deps('transformers>=4.45', 'accelerate>=1.0')

import torch  # noqa: E402
from transformers import (  # noqa: E402
    AutoFeatureExtractor,
    AutoModelForAudioClassification,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
cfg = manifest.get('config', {})
OUT = os.environ.get('AIM_OUTPUT', '/workspace/output')
HOME = os.environ.get('AIM_HOME', '/workspace/aim')
BASE = manifest.get('modelId') or 'facebook/wav2vec2-base'
MAX_S = float(cfg.get('maxSeconds', 10))
random.seed(7)
device = 'cuda' if torch.cuda.is_available() else 'cpu'

rows = [i for i in au.items(manifest) if i['label']]
labels = sorted({r['label'] for r in rows})
label2id = {name: i for i, name in enumerate(labels)}
print(f'{len(rows)} clips, {len(labels)} labels: {", ".join(labels)}', flush=True)

by_label = {}
for r in rows:
    by_label.setdefault(r['label'], []).append(r)
train_rows, val_rows = [], []
for group in by_label.values():
    random.shuffle(group)
    n_val = int(round(len(group) * 0.2)) if len(group) >= 3 else 0
    val_rows += group[:n_val]
    train_rows += group[n_val:]
print(f'train {len(train_rows)} / val {len(val_rows)} clips', flush=True)

print('AIM_STAGE loading', flush=True)
fe = AutoFeatureExtractor.from_pretrained(BASE)
SR = getattr(fe, 'sampling_rate', au.SR)


class Clips(torch.utils.data.Dataset):
    def __init__(self, data, train):
        self.data = data
        self.train = train

    def __len__(self):
        return len(self.data)

    def __getitem__(self, idx):
        row = self.data[idx]
        audio = au.load_audio(row['path'], sr=SR, max_seconds=MAX_S * 3 if self.train else MAX_S)
        limit = int(MAX_S * SR)
        if self.train and len(audio) > limit:
            start = random.randint(0, len(audio) - limit)
            audio = audio[start:start + limit]
        if self.train:
            audio = audio * random.uniform(0.7, 1.2) + np.random.normal(0, 0.002, audio.shape).astype(np.float32)
        return {'audio': audio[:limit], 'label': label2id[row['label']]}


def collate(batch):
    inputs = fe(
        [b['audio'] for b in batch],
        sampling_rate=SR,
        padding=True,
        truncation=True,
        max_length=int(MAX_S * SR),
        return_tensors='pt',
    )
    return {**inputs, 'labels': torch.tensor([b['label'] for b in batch])}


def accuracy(pred):
    return {'accuracy': float((pred.predictions.argmax(-1) == pred.label_ids).mean())}


class Progress(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if state.max_steps:
            print(f'AIM_PROGRESS {int(95 * state.global_step / state.max_steps)}', flush=True)
        if logs:
            keep = {k: round(float(v), 4) for k, v in logs.items() if k in ('loss', 'eval_accuracy')}
            if keep:
                print('AIM_METRICS ' + json.dumps(keep), flush=True)


print('AIM_STAGE training', flush=True)
model = AutoModelForAudioClassification.from_pretrained(
    BASE,
    num_labels=len(labels),
    label2id=label2id,
    id2label={i: n for n, i in label2id.items()},
    ignore_mismatched_sizes=True,
)
batch = int(cfg.get('batchSize', 16))
trainer = Trainer(
    model=model,
    train_dataset=Clips(train_rows, True),
    eval_dataset=Clips(val_rows, False) if val_rows else None,
    data_collator=collate,
    compute_metrics=accuracy,
    callbacks=[Progress()],
    args=TrainingArguments(
        output_dir=os.path.join(HOME, 'checkpoints'),
        per_device_train_batch_size=batch,
        per_device_eval_batch_size=batch,
        learning_rate=float(cfg.get('learningRate', 3e-5)),
        warmup_ratio=0.1,
        num_train_epochs=float(cfg.get('epochs', 20)),
        eval_strategy='epoch' if val_rows else 'no',
        save_strategy='no',
        logging_steps=10,
        fp16=device == 'cuda',
        report_to=[],
        remove_unused_columns=False,
        dataloader_num_workers=2,
    ),
)
result = trainer.train()

print('AIM_STAGE export', flush=True)
metrics = {'labels': len(labels), 'clips': len(rows), 'baseModel': BASE, 'trainLoss': round(float(result.training_loss), 4)}
if val_rows:
    pred = trainer.predict(Clips(val_rows, False))
    guess = pred.predictions.argmax(-1)
    metrics['valAccuracy'] = round(float((guess == pred.label_ids).mean()), 4)
    per = {}
    for i, name in enumerate(labels):
        mask = pred.label_ids == i
        if mask.any():
            per[name] = round(float((guess[mask] == i).mean()), 3)
    metrics['perLabelAccuracy'] = per
model_dir = os.path.join(OUT, 'model')
trainer.save_model(model_dir)
fe.save_pretrained(model_dir)
json.dump(labels, open(os.path.join(OUT, 'labels.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8') as f:
    f.write(
        '# Voice classification model (AI Markets)\n\n'
        f'Labels: {", ".join(labels)}\n\n'
        '```python\nfrom transformers import pipeline\n'
        'clf = pipeline("audio-classification", model="model")\nprint(clf("clip.wav"))\n```\n'
    )
print('AIM_METRICS ' + json.dumps(metrics, ensure_ascii=False), flush=True)
print('AIM_PROGRESS 100', flush=True)
