"""Recipe: motion scoring against reference performances (e.g. a master performing a kata / bài quyền).

Reference clips (role = reference) are aligned with DTW and averaged into a template of joint angles;
the spread between references sets how strict each moment is. Sample clips are then scored 0-100.

Output (/workspace/output): template.npz, report.json (scores of the uploaded samples), metrics.json,
score_motion.py + pose_features.py to score new videos.
"""
import json
import os
import shutil
import sys

import numpy as np

import pose_features as pf

pf.ensure_deps()

import score_motion as sm  # noqa: E402

manifest = json.load(open(sys.argv[1], encoding='utf-8'))
cfg = manifest.get('config', {})
DATA = os.environ.get('AIM_DATA', '/workspace/data')
OUT = os.environ.get('AIM_OUTPUT', '/workspace/output')
CACHE = os.path.join(os.environ.get('AIM_HOME', '/workspace/aim'), 'pose_cache')
FPS = int(cfg.get('fps', 15))
MIN_TOL = np.deg2rad(12.0)
SINGLE_REF_TOL = np.deg2rad(18.0)

files = manifest['files']
refs = [f for f in files if f.get('role') == 'reference']
samples = [f for f in files if f.get('role') != 'reference']
print(f'{len(refs)} reference videos, {len(samples)} sample videos', flush=True)

print('AIM_STAGE pose', flush=True)
seqs = {}
for i, f in enumerate(files):
    kp, fps = pf.extract(os.path.join(DATA, f['path']), FPS, cache_dir=CACHE)
    norm = pf.normalize(kp)
    if norm is None:
        print(f'WARNING: no clear person in {f["filename"]}, skipped', flush=True)
    else:
        seqs[f['path']] = (pf.joint_angles(norm), fps)
        print(f'{f["filename"]}: {norm.shape[0]} frames', flush=True)
    print(f'AIM_PROGRESS {int(50 * (i + 1) / len(files))}', flush=True)

ref_seqs = [seqs[f['path']][0] for f in refs if f['path'] in seqs]
if not ref_seqs:
    sys.exit('No usable reference video (the performer must be fully visible).')

# ---------- template ----------
print('AIM_STAGE template', flush=True)
anchor = max(ref_seqs, key=len)
stack = [[row] for row in anchor]
for other in ref_seqs:
    if other is anchor:
        continue
    for ti, si in sm.align(anchor, other):
        stack[ti].append(other[si])
mean = np.stack([np.mean(rows, axis=0) for rows in stack]).astype(np.float32)
if len(ref_seqs) > 1:
    spread = np.stack([np.std(rows, axis=0) for rows in stack])
    tol = np.maximum(spread * 2.0, MIN_TOL).astype(np.float32)
else:
    tol = np.full_like(mean, SINGLE_REF_TOL)
print(f'template: {mean.shape[0]} frames from {len(ref_seqs)} reference(s)', flush=True)
print('AIM_PROGRESS 70', flush=True)

# ---------- score uploaded samples ----------
print('AIM_STAGE scoring', flush=True)
report = []
for i, f in enumerate(samples):
    if f['path'] not in seqs:
        continue
    angles, fps = seqs[f['path']]
    result = sm.score_angles(mean, tol, angles, fps)
    report.append({'file': f['filename'], 'label': f.get('label', ''), **result})
    print(f'{f["filename"]}: score {result["score"]}', flush=True)
    print(f'AIM_PROGRESS {70 + int(25 * (i + 1) / max(1, len(samples)))}', flush=True)

os.makedirs(OUT, exist_ok=True)
np.savez_compressed(os.path.join(OUT, 'template.npz'), mean=mean, tol=tol, fps=FPS, angles=np.array(pf.ANGLE_NAMES))
json.dump(report, open(os.path.join(OUT, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
metrics = {
    'references': len(ref_seqs),
    'samples': len(report),
    'templateSeconds': round(mean.shape[0] / FPS, 1),
}
if report:
    metrics['meanScore'] = round(float(np.mean([r['score'] for r in report])), 1)
    metrics['scores'] = {r['file']: r['score'] for r in report[:30]}
json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
here = os.path.dirname(os.path.abspath(__file__))
for name in ('score_motion.py', 'pose_features.py'):
    shutil.copy(os.path.join(here, name), os.path.join(OUT, name))
with open(os.path.join(OUT, 'README.md'), 'w', encoding='utf-8') as f:
    f.write(
        '# Motion scoring template (AI Markets)\n\n'
        '```bash\npip install ultralytics opencv-python-headless numpy torch\n'
        'python score_motion.py my_performance.mp4\n```\n\n'
        'Returns an overall score (0-100), per-joint scores and the weakest time ranges.\n'
    )

print('AIM_METRICS ' + json.dumps(metrics, ensure_ascii=False), flush=True)
print('AIM_PROGRESS 100', flush=True)
