"""Audio helpers shared by the AI Markets voice recipes (16 kHz mono loading, dataset items)."""
import os
import shutil
import subprocess
import sys

import numpy as np

SR = 16000


def ensure_ffmpeg():
    """MP3 / M4A / OPUS decoding goes through ffmpeg; GPU images do not always ship it."""
    if shutil.which('ffmpeg'):
        return
    subprocess.run(['apt-get', 'update', '-qq'], check=False)
    subprocess.check_call(['apt-get', 'install', '-y', '-qq', 'ffmpeg'])


def ensure_deps(*extra):
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'librosa>=0.10', 'soundfile', *extra])


def load_audio(path, sr=SR, max_seconds=None):
    """Mono float32 waveform resampled to `sr`, optionally truncated."""
    import librosa

    y, _ = librosa.load(path, sr=sr, mono=True, duration=max_seconds)
    return y.astype(np.float32)


def items(manifest, data_dir=None):
    """Dataset entries from the job manifest with absolute paths on the workspace."""
    base = data_dir or os.environ.get('AIM_DATA', '/workspace/data')
    return [
        {
            'path': os.path.join(base, f['path']),
            'filename': f.get('filename', ''),
            'label': f.get('label', ''),
            'transcript': f.get('transcript', ''),
        }
        for f in manifest.get('files', [])
    ]
