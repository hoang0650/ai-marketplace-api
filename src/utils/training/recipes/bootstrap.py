#!/usr/bin/env python3
"""AI Markets training bootstrap (runs on the GPU workspace, stdlib only).

1. Downloads the job manifest, recipe scripts and dataset files into /workspace.
2. Runs the recipe, streaming its log and progress markers back to the AI Markets API:
     AIM_PROGRESS <0-100>   AIM_STAGE <name>   AIM_METRICS <json>
3. Zips /workspace/output, uploads it as the job artifact and reports success / failure.

Safe to re-run: finished downloads are skipped and a finished job does nothing (pod restarts).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque

ROOT = os.environ.get('AIM_TRAINING_ROOT', '/workspace')
AIM = os.path.join(ROOT, 'aim')
DATA = os.path.join(ROOT, 'data')
OUT = os.path.join(ROOT, 'output')
STATE_FILE = os.path.join(AIM, 'state.json')
MANIFEST_FILE = os.path.join(AIM, 'manifest.json')
RECIPES = os.path.join(AIM, 'recipes')
REPORT_EVERY_S = 20


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


def read_env():
    env = {}
    try:
        with open(os.path.join(AIM, 'job.env'), encoding='utf-8') as f:
            for line in f:
                key, _, value = line.strip().partition('=')
                if key:
                    env[key] = value
    except FileNotFoundError:
        pass
    return env


ENV = {**read_env(), **{k: os.environ[k] for k in ('AIM_JOB_TOKEN', 'AIM_TRAINING_MANIFEST_URL') if k in os.environ}}
TOKEN = ENV.get('AIM_JOB_TOKEN', '')


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def save_json(path, value):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def api_post(url, payload, retries=5):
    data = json.dumps(payload).encode('utf-8')
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                data=data,
                method='POST',
                headers={'Content-Type': 'application/json', 'X-Job-Token': TOKEN},
            )
            with urllib.request.urlopen(req, timeout=30) as res:
                body = res.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as err:
            if err.code in (400, 401, 404, 409):
                log(f'API refused {url}: HTTP {err.code}')
                return {'_status': err.code}
            log(f'API HTTP {err.code}, retrying')
        except Exception as err:  # network blips while the pod boots
            log(f'API error: {err}, retrying')
        time.sleep(min(30, 2 ** attempt))
    return None


def download(url, dest, size=0, retries=4):
    if size and os.path.exists(dest) and os.path.getsize(dest) == size:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + '.part'
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=60) as res, open(part, 'wb') as f:
                shutil.copyfileobj(res, f, length=1024 * 1024)
            os.replace(part, dest)
            return
        except Exception as err:
            log(f'Download failed ({os.path.basename(dest)}): {err}')
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f'Could not download {os.path.basename(dest)}')


def upload(url, path, content_type='application/zip', retries=4):
    size = os.path.getsize(path)
    for attempt in range(retries):
        try:
            with open(path, 'rb') as f:
                req = urllib.request.Request(
                    url,
                    data=f,
                    method='PUT',
                    headers={'Content-Type': content_type, 'Content-Length': str(size)},
                )
                with urllib.request.urlopen(req, timeout=600):
                    return
        except Exception as err:
            log(f'Upload failed: {err}')
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError('Could not upload the model archive')


class Reporter:
    def __init__(self, manifest):
        self.url = manifest['api']['report']
        self.lines = deque(maxlen=200)
        self.stage = ''
        self.progress = 0
        self.metrics = {}
        self.last = 0.0
        self.cancelled = False
        self.lock = threading.Lock()

    def add(self, line):
        line = line.rstrip()
        if line:
            with self.lock:
                self.lines.append(line[:500])

    def send(self, force=False, **extra):
        now = time.time()
        if not force and now - self.last < REPORT_EVERY_S:
            return None
        self.last = now
        with self.lock:
            body = {'stage': self.stage, 'progress': self.progress, 'logs': '\n'.join(self.lines)}
        if self.metrics:
            body['metrics'] = self.metrics
        body.update(extra)
        res = api_post(self.url, body)
        if res and res.get('_status') in (401, 404, 409):
            self.cancelled = True
        return res


def load_manifest(state):
    if state.get('downloaded') and os.path.exists(MANIFEST_FILE):
        return load_json(MANIFEST_FILE, None)
    url = ENV.get('AIM_TRAINING_MANIFEST_URL', '')
    if not url:
        raise RuntimeError('Missing job manifest link')
    with urllib.request.urlopen(url, timeout=60) as res:
        manifest = json.loads(res.read())
    save_json(MANIFEST_FILE, manifest)
    return manifest


def fetch_bundle(manifest, rep):
    os.makedirs(RECIPES, exist_ok=True)
    for recipe in manifest.get('recipes', []):
        download(recipe['url'], os.path.join(RECIPES, recipe['name']))
    files = manifest.get('files', [])
    total = sum(f.get('size') or 0 for f in files) or 1
    done = 0
    for f in files:
        dest = os.path.join(DATA, f['path'])
        download(f['url'], dest, f.get('size') or 0)
        done += f.get('size') or 0
        rep.progress = 1 + int(9 * done / total)
        rep.add(f'Downloaded {f["path"]}')
        rep.send()
    labels = sorted({f['label'] for f in files if f.get('label')})
    rep.add(f'Dataset ready: {len(files)} files' + (f', labels: {", ".join(labels)}' if labels else ''))


MARKER = re.compile(r'^AIM_(PROGRESS|STAGE|METRICS)\s+(.*)$')


def run_recipe(manifest, rep):
    entry = os.path.join(RECIPES, manifest['entry'])
    os.makedirs(OUT, exist_ok=True)
    env = dict(
        os.environ,
        PYTHONUNBUFFERED='1',
        PYTHONPATH=RECIPES + os.pathsep + os.environ.get('PYTHONPATH', ''),
        AIM_DATA=DATA,
        AIM_OUTPUT=OUT,
        AIM_HOME=AIM,
    )
    proc = subprocess.Popen(
        [sys.executable, entry, MANIFEST_FILE],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    with open(os.path.join(AIM, 'train.log'), 'a', encoding='utf-8') as lf:
        for line in proc.stdout:
            lf.write(line)
            lf.flush()
            m = MARKER.match(line.strip())
            if m:
                kind, value = m.groups()
                if kind == 'PROGRESS':
                    try:
                        rep.progress = 10 + int(min(100.0, float(value)) * 0.85)
                    except ValueError:
                        pass
                elif kind == 'STAGE':
                    rep.stage = value.strip()[:40]
                    rep.add(f'== {rep.stage} ==')
                    rep.send(force=True)
                    continue
                else:
                    try:
                        rep.metrics.update(json.loads(value))
                    except ValueError:
                        pass
            else:
                rep.add(line)
            rep.send()
            if rep.cancelled:
                proc.terminate()
                break
    return proc.wait()


def package_and_upload(manifest, rep):
    rep.stage = 'uploading'
    rep.progress = 96
    rep.add('Packaging /workspace/output')
    rep.send(force=True)
    base = os.path.join(AIM, 'model')
    archive = shutil.make_archive(base, 'zip', OUT)
    res = api_post(manifest['api']['artifactUrl'], {'filename': f'{manifest["jobId"]}-model.zip'})
    if not res or 'url' not in res:
        raise RuntimeError('Could not get an upload link for the model')
    upload(res['url'], archive)
    return res['objectName'], os.path.getsize(archive)


def main():
    os.makedirs(AIM, exist_ok=True)
    state = load_json(STATE_FILE, {})
    if state.get('done'):
        log('Job already finished; nothing to do.')
        return
    manifest = load_manifest(state)
    rep = Reporter(manifest)
    rep.stage = 'downloading'
    rep.progress = 1
    rep.add(f'Job {manifest["jobId"]}: {manifest["source"]} / {manifest["task"]}')
    rep.send(force=True, status='running')
    if rep.cancelled:
        return

    try:
        if not state.get('downloaded'):
            fetch_bundle(manifest, rep)
            state['downloaded'] = True
            save_json(STATE_FILE, state)
    except Exception as err:
        rep.add(f'ERROR: {err}')
        rep.stage = 'failed'
        rep.send(force=True, status='failed')
        return

    if not manifest.get('entry'):
        rep.stage = 'ready'
        rep.progress = 10
        rep.add('Data is ready in /workspace/data. Open JupyterLab or the terminal to train with your own code.')
        rep.send(force=True)
        return

    rep.stage = 'training'
    rep.send(force=True)
    code = run_recipe(manifest, rep)
    if rep.cancelled:
        log('Job was cancelled on AI Markets; stopping.')
        return
    if code != 0:
        rep.add(f'Recipe exited with code {code}. Full log: /workspace/aim/train.log')
        rep.stage = 'failed'
        rep.send(force=True, status='failed')
        return

    try:
        object_name, size = package_and_upload(manifest, rep)
    except Exception as err:
        rep.add(f'ERROR: {err}. The model is still in /workspace/output.')
        rep.stage = 'failed'
        rep.send(force=True, status='failed')
        return

    state['done'] = True
    save_json(STATE_FILE, state)
    rep.stage = 'done'
    rep.add(f'Model uploaded ({size // 1024} KB).')
    rep.send(force=True, status='succeeded', artifact=object_name)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        log(f'Bootstrap crashed: {exc}')
        raise
