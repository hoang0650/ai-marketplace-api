"""Recipe: supervised fine-tuning of a chat / instruct LLM with LoRA.

Data (uploaded JSONL / JSON / CSV / Parquet / TXT, or a Hugging Face dataset), one example per row:
  {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
  {"prompt": "...", "completion": "..."}
  {"instruction": "...", "input": "...", "output": "..."}
  {"question": "...", "answer": "..."}
  {"text": "..."}                       (plain text / continued pre-training)

Output (/workspace/output/adapter): LoRA adapter + tokenizer, loadable with peft.PeftModel.
"""
import glob
import json
import os
import subprocess
import sys

subprocess.check_call([
    sys.executable, '-m', 'pip', 'install', '-q',
    'transformers>=4.45', 'peft>=0.13', 'datasets>=3.0', 'accelerate>=1.0',
])

import torch  # noqa: E402
from datasets import concatenate_datasets, load_dataset  # noqa: E402
from peft import LoraConfig, get_peft_model  # noqa: E402
from transformers import (  # noqa: E402
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
cfg = manifest.get('config', {})
DATA = os.environ.get('AIM_DATA', '/workspace/data')
OUT = os.environ.get('AIM_OUTPUT', '/workspace/output')
HOME = os.environ.get('AIM_HOME', '/workspace/aim')
BASE = manifest['modelId']
MAX_LEN = int(cfg.get('maxSeqLength', 1024))

print('AIM_STAGE loading', flush=True)


def load_rows():
    if manifest.get('hfDataset'):
        return load_dataset(manifest['hfDataset'], split='train')
    parts = []
    kinds = {'jsonl': 'json', 'json': 'json', 'csv': 'csv', 'parquet': 'parquet', 'txt': 'text'}
    for path in sorted(glob.glob(os.path.join(DATA, 'raw', '*'))):
        ext = path.rsplit('.', 1)[-1].lower()
        if ext in kinds:
            parts.append(load_dataset(kinds[ext], data_files=path, split='train'))
    if not parts:
        sys.exit('No JSONL / JSON / CSV / Parquet / TXT files found.')
    return concatenate_datasets(parts) if len(parts) > 1 else parts[0]


tok = AutoTokenizer.from_pretrained(BASE, use_fast=True)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token


def to_messages(row):
    if row.get('messages'):
        return row['messages']
    if row.get('prompt') is not None and row.get('completion') is not None:
        return [{'role': 'user', 'content': str(row['prompt'])}, {'role': 'assistant', 'content': str(row['completion'])}]
    if row.get('instruction') is not None and row.get('output') is not None:
        user = str(row['instruction']) + (f"\n\n{row['input']}" if row.get('input') else '')
        return [{'role': 'user', 'content': user}, {'role': 'assistant', 'content': str(row['output'])}]
    if row.get('question') is not None and row.get('answer') is not None:
        return [{'role': 'user', 'content': str(row['question'])}, {'role': 'assistant', 'content': str(row['answer'])}]
    return None


def to_text(row):
    msgs = to_messages(row)
    if msgs is not None:
        if tok.chat_template:
            return tok.apply_chat_template(msgs, tokenize=False)
        return '\n'.join(f"{m['role']}: {m['content']}" for m in msgs) + tok.eos_token
    if row.get('text') is not None:
        return str(row['text']) + tok.eos_token
    return None


rows = load_rows()
print(f'{len(rows)} rows, columns: {rows.column_names}', flush=True)
texts = [t for t in (to_text(r) for r in rows) if t]
if not texts:
    sys.exit('Rows must have messages / prompt+completion / instruction+output / question+answer / text columns.')
print(f'{len(texts)} usable examples', flush=True)

from datasets import Dataset  # noqa: E402

ds = Dataset.from_dict({'text': texts}).map(
    lambda b: tok(b['text'], truncation=True, max_length=MAX_LEN),
    batched=True,
    remove_columns=['text'],
)

print('AIM_STAGE training', flush=True)
bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
model = AutoModelForCausalLM.from_pretrained(
    BASE,
    torch_dtype=torch.bfloat16 if bf16 else torch.float16,
    device_map='auto',
)
model.gradient_checkpointing_enable()
model.enable_input_require_grads()
rank = int(cfg.get('loraRank', 16))
model = get_peft_model(model, LoraConfig(
    r=rank,
    lora_alpha=rank * 2,
    lora_dropout=0.05,
    target_modules='all-linear',
    task_type='CAUSAL_LM',
))
model.print_trainable_parameters()


class Progress(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if state.max_steps:
            print(f'AIM_PROGRESS {int(100 * state.global_step / state.max_steps)}', flush=True)
        if logs and 'loss' in logs:
            print('AIM_METRICS ' + json.dumps({'loss': round(float(logs['loss']), 4), 'step': state.global_step}), flush=True)


batch = int(cfg.get('batchSize', 4))
trainer = Trainer(
    model=model,
    train_dataset=ds,
    data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
    callbacks=[Progress()],
    args=TrainingArguments(
        output_dir=os.path.join(HOME, 'checkpoints'),
        num_train_epochs=float(cfg.get('epochs', 2)),
        per_device_train_batch_size=batch,
        gradient_accumulation_steps=max(1, 16 // batch),
        learning_rate=float(cfg.get('learningRate', 2e-4)),
        lr_scheduler_type='cosine',
        warmup_ratio=0.03,
        logging_steps=10,
        save_strategy='no',
        bf16=bf16,
        fp16=not bf16 and torch.cuda.is_available(),
        report_to=[],
    ),
)
result = trainer.train()

print('AIM_STAGE export', flush=True)
adapter_dir = os.path.join(OUT, 'adapter')
model.save_pretrained(adapter_dir)
tok.save_pretrained(adapter_dir)
metrics = {'examples': len(texts), 'trainLoss': round(float(result.training_loss), 4), 'baseModel': BASE}
json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w', encoding='utf-8'), indent=2)
with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8') as f:
    f.write(
        f'# LoRA adapter for {BASE} (AI Markets)\n\n'
        '```python\nfrom transformers import AutoModelForCausalLM, AutoTokenizer\nfrom peft import PeftModel\n\n'
        f'base = AutoModelForCausalLM.from_pretrained("{BASE}", device_map="auto")\n'
        'model = PeftModel.from_pretrained(base, "adapter")\n'
        'tok = AutoTokenizer.from_pretrained("adapter")\n```\n'
    )
print('AIM_METRICS ' + json.dumps(metrics), flush=True)
print('AIM_PROGRESS 100', flush=True)
