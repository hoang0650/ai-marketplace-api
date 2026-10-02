"""Recipe: tabular prediction (CSV / TSV / Parquet) with gradient-boosted trees.

config.target = column to predict (default: last column); taskType = auto | classification | regression.
Output (/workspace/output): model.joblib (full sklearn pipeline), columns.json, metrics.json.
"""
import glob
import json
import os
import subprocess
import sys

subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'scikit-learn>=1.3', 'pandas', 'pyarrow', 'joblib'])

import joblib  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.compose import ColumnTransformer  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor  # noqa: E402
from sklearn.metrics import accuracy_score, f1_score, mean_absolute_error, r2_score  # noqa: E402
from sklearn.model_selection import train_test_split  # noqa: E402
from sklearn.pipeline import Pipeline  # noqa: E402
from sklearn.preprocessing import OrdinalEncoder  # noqa: E402

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
cfg = manifest.get('config', {})
DATA = os.environ.get('AIM_DATA', '/workspace/data')
OUT = os.environ.get('AIM_OUTPUT', '/workspace/output')

print('AIM_STAGE loading', flush=True)
frames = []
for path in sorted(glob.glob(os.path.join(DATA, 'raw', '*'))):
    ext = path.rsplit('.', 1)[-1].lower()
    if ext == 'csv':
        frames.append(pd.read_csv(path))
    elif ext == 'tsv':
        frames.append(pd.read_csv(path, sep='\t'))
    elif ext == 'parquet':
        frames.append(pd.read_parquet(path))
if not frames:
    sys.exit('No CSV / TSV / Parquet files found.')
df = pd.concat(frames, ignore_index=True)
target = cfg.get('target') or df.columns[-1]
if target not in df.columns:
    sys.exit(f'Target column "{target}" not found. Columns: {", ".join(map(str, df.columns))}')
df = df.dropna(subset=[target])
y = df[target]
X = df.drop(columns=[target])
print(f'{len(df)} rows, {X.shape[1]} features, target "{target}"', flush=True)
print('AIM_PROGRESS 20', flush=True)

task = cfg.get('taskType', 'auto')
if task == 'auto':
    is_class = y.dtype == object or y.dtype == bool or (pd.api.types.is_integer_dtype(y) and y.nunique() <= 20)
    task = 'classification' if is_class else 'regression'

cat_cols = [c for c in X.columns if X[c].dtype == object or str(X[c].dtype) == 'category' or X[c].dtype == bool]
num_cols = [c for c in X.columns if c not in cat_cols]
X[cat_cols] = X[cat_cols].astype(str)
pre = ColumnTransformer(
    [
        ('cat', OrdinalEncoder(handle_unknown='use_encoded_value', unknown_value=-1, encoded_missing_value=-1), cat_cols),
        ('num', 'passthrough', num_cols),
    ]
)
# Native categorical splits need <= 255 levels; wider columns stay ordinal-encoded numbers.
cat_mask = [X[c].nunique() <= 250 for c in cat_cols] + [False] * len(num_cols)
est = (
    HistGradientBoostingClassifier(categorical_features=cat_mask, max_iter=400, early_stopping=True, random_state=7)
    if task == 'classification'
    else HistGradientBoostingRegressor(categorical_features=cat_mask, max_iter=400, early_stopping=True, random_state=7)
)
pipe = Pipeline([('pre', pre), ('model', est)])

print('AIM_STAGE training', flush=True)
stratify = y if task == 'classification' and y.value_counts().min() >= 2 else None
X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=7, stratify=stratify)
pipe.fit(X_tr, y_tr)
pred = pipe.predict(X_te)
print('AIM_PROGRESS 80', flush=True)

if task == 'classification':
    metrics = {'task': task, 'accuracy': round(float(accuracy_score(y_te, pred)), 4),
               'f1Macro': round(float(f1_score(y_te, pred, average='macro')), 4), 'classes': int(y.nunique())}
else:
    metrics = {'task': task, 'r2': round(float(r2_score(y_te, pred)), 4),
               'mae': round(float(mean_absolute_error(y_te, pred)), 4),
               'rmse': round(float(np.sqrt(np.mean((np.asarray(y_te) - pred) ** 2))), 4)}
metrics.update({'rows': int(len(df)), 'features': int(X.shape[1]), 'target': str(target)})
print(f'holdout metrics: {metrics}', flush=True)

print('AIM_STAGE export', flush=True)
pipe.fit(X, y)
os.makedirs(OUT, exist_ok=True)
joblib.dump(pipe, os.path.join(OUT, 'model.joblib'))
json.dump({'features': list(map(str, X.columns)), 'categorical': cat_cols, 'target': str(target)},
          open(os.path.join(OUT, 'columns.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w', encoding='utf-8'), indent=2)
with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8') as f:
    f.write(
        '# Tabular model (AI Markets)\n\n'
        '```python\nimport joblib, pandas as pd\nmodel = joblib.load("model.joblib")\n'
        'print(model.predict(pd.read_csv("new_rows.csv")))\n```\n'
        'Categorical columns must be passed as strings, same column names as training.\n'
    )
print('AIM_METRICS ' + json.dumps(metrics), flush=True)
print('AIM_PROGRESS 100', flush=True)
