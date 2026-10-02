"""Recipe: speech recognition — fine-tunes Whisper on your voice clips + transcripts.

Each clip (≤ 30 s, longer clips are skipped) carries the exact text spoken in it. Useful for accents,
dialects, domain vocabulary (medical, hotel, product names…) or a specific speaker.

Output (/workspace/output/model): Whisper model + processor, usable with
transformers.pipeline("automatic-speech-recognition", model="model").
"""
import json
import os
import random
import sys

import audio_utils as au

au.ensure_ffmpeg()
au.ensure_deps('transformers>=4.45', 'accelerate>=1.0', 'jiwer')

import jiwer  # noqa: E402
import torch  # noqa: E402
from transformers import (  # noqa: E402
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    TrainerCallback,
    WhisperForConditionalGeneration,
    WhisperProcessor,
)

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
cfg = manifest.get('config', {})
OUT = os.environ.get('AIM_OUTPUT', '/workspace/output')
HOME = os.environ.get('AIM_HOME', '/workspace/aim')
BASE = manifest.get('modelId') or 'openai/whisper-small'
LANG = cfg.get('language', 'vi')
MAX_S = 30.0
random.seed(7)
device = 'cuda' if torch.cuda.is_available() else 'cpu'

print('AIM_STAGE loading', flush=True)
processor = WhisperProcessor.from_pretrained(BASE, language=LANG, task='transcribe')
rows = [i for i in au.items(manifest) if i['transcript']]
usable, skipped = [], 0
for i, row in enumerate(rows):
    audio = au.load_audio(row['path'])
    if len(audio) == 0 or len(audio) > MAX_S * au.SR:
        skipped += 1
        continue
    usable.append({**row, 'seconds': len(audio) / au.SR})
    print(f'AIM_PROGRESS {int(10 * (i + 1) / len(rows))}', flush=True)
if skipped:
    print(f'WARNING: skipped {skipped} clips that are empty or longer than 30 s (cut them shorter).', flush=True)
if not usable:
    sys.exit('No usable clips (each clip must be ≤ 30 s and have a transcript).')
hours = sum(r['seconds'] for r in usable) / 3600
print(f'{len(usable)} clips, {hours:.2f} h of speech, language={LANG}, base={BASE}', flush=True)

random.shuffle(usable)
n_eval = max(2, len(usable) // 10) if len(usable) >= 20 else 0
eval_rows, train_rows = usable[:n_eval], usable[n_eval:]


class Clips(torch.utils.data.Dataset):
    def __init__(self, data):
        self.data = data

    def __len__(self):
        return len(self.data)

    def __getitem__(self, idx):
        row = self.data[idx]
        audio = au.load_audio(row['path'])
        feats = processor.feature_extractor(audio, sampling_rate=au.SR).input_features[0]
        return {'input_features': feats, 'labels': processor.tokenizer(row['transcript']).input_ids}


model = WhisperForConditionalGeneration.from_pretrained(BASE)
model.config.use_cache = False
model.config.forced_decoder_ids = None
model.generation_config.forced_decoder_ids = None
model.generation_config.language = LANG
model.generation_config.task = 'transcribe'


def collate(batch):
    feats = processor.feature_extractor.pad([{'input_features': b['input_features']} for b in batch], return_tensors='pt')
    labels = processor.tokenizer.pad([{'input_ids': b['labels']} for b in batch], return_tensors='pt')
    ids = labels['input_ids'].masked_fill(labels['attention_mask'].ne(1), -100)
    if (ids[:, 0] == model.config.decoder_start_token_id).all():
        ids = ids[:, 1:]
    return {'input_features': feats['input_features'], 'labels': ids}


def wer(data):
    """Word error rate of the current model on held-out clips (lower is better)."""
    if not data:
        return None
    model.eval()
    preds, refs = [], []
    for s in range(0, len(data), 8):
        chunk = data[s:s + 8]
        feats = processor.feature_extractor(
            [au.load_audio(r['path']) for r in chunk], sampling_rate=au.SR, return_tensors='pt'
        ).input_features.to(device, dtype=model.dtype)
        with torch.no_grad():
            out = model.generate(feats, language=LANG, task='transcribe', max_new_tokens=225)
        preds += processor.batch_decode(out, skip_special_tokens=True)
        refs += [r['transcript'] for r in chunk]
    return round(float(jiwer.wer([r.lower() for r in refs], [p.lower().strip() for p in preds])), 4)


model.to(device)
wer_before = wer(eval_rows)
if wer_before is not None:
    print(f'WER before fine-tuning: {wer_before}', flush=True)
    print('AIM_METRICS ' + json.dumps({'werBefore': wer_before}), flush=True)


class Progress(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if state.max_steps:
            print(f'AIM_PROGRESS {10 + int(80 * state.global_step / state.max_steps)}', flush=True)
        if logs and 'loss' in logs:
            print('AIM_METRICS ' + json.dumps({'loss': round(float(logs['loss']), 4)}), flush=True)


print('AIM_STAGE training', flush=True)
batch = int(cfg.get('batchSize', 8))
trainer = Seq2SeqTrainer(
    model=model,
    train_dataset=Clips(train_rows),
    data_collator=collate,
    callbacks=[Progress()],
    args=Seq2SeqTrainingArguments(
        output_dir=os.path.join(HOME, 'checkpoints'),
        per_device_train_batch_size=batch,
        gradient_accumulation_steps=max(1, 16 // batch),
        learning_rate=float(cfg.get('learningRate', 1e-5)),
        warmup_ratio=0.1,
        num_train_epochs=float(cfg.get('epochs', 5)),
        gradient_checkpointing=True,
        fp16=device == 'cuda',
        logging_steps=10,
        save_strategy='no',
        report_to=[],
        remove_unused_columns=False,
        dataloader_num_workers=2,
    ),
)
result = trainer.train()

print('AIM_STAGE export', flush=True)
model.config.use_cache = True
wer_after = wer(eval_rows)
model_dir = os.path.join(OUT, 'model')
model.save_pretrained(model_dir)
processor.save_pretrained(model_dir)
metrics = {
    'clips': len(usable),
    'hours': round(hours, 2),
    'language': LANG,
    'baseModel': BASE,
    'trainLoss': round(float(result.training_loss), 4),
}
if wer_after is not None:
    metrics.update({'werBefore': wer_before, 'werAfter': wer_after, 'evalClips': len(eval_rows)})
json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w', encoding='utf-8'), indent=2)
with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8') as f:
    f.write(
        f'# Whisper speech recognition ({LANG}) fine-tuned on AI Markets\n\n'
        '```python\nfrom transformers import pipeline\n'
        'asr = pipeline("automatic-speech-recognition", model="model")\n'
        f'print(asr("audio.wav", generate_kwargs={{"language": "{LANG}", "task": "transcribe"}})["text"])\n```\n'
    )
print('AIM_METRICS ' + json.dumps(metrics), flush=True)
print('AIM_PROGRESS 100', flush=True)
