"""Body-pose features shared by the AI Markets video recipes.

Each video becomes a sequence of COCO-17 keypoints (YOLO pose on the GPU), normalized so that
position in frame, distance to camera and body size do not matter:
  origin = mid-hip, scale = median torso length, x/y in torso units.
"""
import os
import subprocess
import sys

import numpy as np

KP = 17
# 0 nose, 1/2 eyes, 3/4 ears, 5/6 shoulders, 7/8 elbows, 9/10 wrists, 11/12 hips, 13/14 knees, 15/16 ankles (L/R)
FLIP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]
ANGLES = [(5, 7, 9), (6, 8, 10), (7, 5, 11), (8, 6, 12), (11, 13, 15), (12, 14, 16), (5, 11, 13), (6, 12, 14)]
ANGLE_NAMES = [
    'left_elbow', 'right_elbow', 'left_shoulder', 'right_shoulder',
    'left_knee', 'right_knee', 'left_hip', 'right_hip',
]
FEATURE_DIM = KP * 2 * 2 + len(ANGLES)
FEATURE_VERSION = 'coco17-v1'
MIN_CONF = 0.3


def ensure_deps():
    try:
        import cv2  # noqa: F401
        import ultralytics  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'ultralytics>=8.3', 'opencv-python-headless'])


_model = None


def pose_model():
    global _model
    if _model is None:
        from ultralytics import YOLO

        _model = YOLO(os.environ.get('AIM_POSE_MODEL', 'yolo11m-pose.pt'))
    return _model


def _main_person(result):
    """Keypoints (17, 3) of the largest detected person, or None."""
    kps = getattr(result, 'keypoints', None)
    if kps is None or kps.data is None or len(kps.data) == 0:
        return None
    data = kps.data.cpu().numpy()
    if result.boxes is not None and len(result.boxes) == len(data):
        wh = result.boxes.xywh.cpu().numpy()[:, 2:4]
        idx = int(np.argmax(wh[:, 0] * wh[:, 1]))
    else:
        idx = 0
    return data[idx]


def extract(video_path, fps=30, cache_dir=None, batch=16):
    """Returns (keypoints (T, 17, 3) [x, y, conf] in pixels, effective fps)."""
    cache = None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        cache = os.path.join(cache_dir, f'{os.path.basename(video_path)}.{fps}.npz')
        if os.path.exists(cache):
            z = np.load(cache)
            return z['kp'], float(z['fps'])

    import cv2
    import torch

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f'Cannot open video {os.path.basename(video_path)}')
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    out_fps = min(float(fps), src_fps)
    step = src_fps / out_fps
    device = 0 if torch.cuda.is_available() else 'cpu'
    model = pose_model()

    frames, out = [], []

    def flush():
        if not frames:
            return
        for r in model.predict(frames, verbose=False, device=device):
            kp = _main_person(r)
            out.append(kp if kp is not None else np.full((KP, 3), np.nan, dtype=np.float32))
        frames.clear()

    idx, next_t = 0, 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx + 1e-6 >= next_t:
            frames.append(frame)
            next_t += step
            if len(frames) >= batch:
                flush()
        idx += 1
    flush()
    cap.release()

    kp = np.asarray(out, dtype=np.float32).reshape(-1, KP, 3)
    if cache:
        np.savez_compressed(cache, kp=kp, fps=out_fps)
    return kp, out_fps


def _interpolate(arr):
    """Linear fill of NaN gaps per column; columns with no data stay NaN."""
    t = np.arange(arr.shape[0])
    flat = arr.reshape(arr.shape[0], -1)
    for c in range(flat.shape[1]):
        col = flat[:, c]
        good = ~np.isnan(col)
        if good.sum() == 0:
            continue
        flat[:, c] = np.interp(t, t[good], col[good])
    return flat.reshape(arr.shape)


def normalize(kp):
    """(T, 17, 3) pixels → (T, 17, 2) torso units, or None when no person was found."""
    if kp.size == 0:
        return None
    xy = kp[:, :, :2].astype(np.float32).copy()
    conf = np.nan_to_num(kp[:, :, 2], nan=0.0)
    xy[conf < MIN_CONF] = np.nan
    seen = ~np.isnan(xy[:, :, 0])
    if seen[:, [5, 6, 11, 12]].mean() < 0.3:
        return None
    xy = _interpolate(xy)
    hip = np.nanmean(xy[:, [11, 12]], axis=1)
    shoulder = np.nanmean(xy[:, [5, 6]], axis=1)
    torso = np.linalg.norm(shoulder - hip, axis=1)
    scale = float(np.nanmedian(torso)) if np.isfinite(np.nanmedian(torso)) else 0.0
    if scale <= 1e-6:
        return None
    norm = (xy - hip[:, None, :]) / scale
    return np.nan_to_num(norm, nan=0.0).astype(np.float32)


def mirror(norm):
    """Left/right mirror of a normalized sequence (same move performed with the other side)."""
    m = norm[:, FLIP].copy()
    m[:, :, 0] *= -1
    return m


def joint_angles(norm):
    """(T, 17, 2) → (T, 8) inner joint angles in radians."""
    out = np.zeros((norm.shape[0], len(ANGLES)), dtype=np.float32)
    for k, (a, b, c) in enumerate(ANGLES):
        v1 = norm[:, a] - norm[:, b]
        v2 = norm[:, c] - norm[:, b]
        cos = (v1 * v2).sum(1) / (np.linalg.norm(v1, axis=1) * np.linalg.norm(v2, axis=1) + 1e-6)
        out[:, k] = np.arccos(np.clip(cos, -1.0, 1.0))
    return out


def frame_features(norm, fps=30):
    """(T, 17, 2) → (T, FEATURE_DIM): positions, velocities (per 1/30 s) and joint angles / π."""
    t = norm.shape[0]
    pos = norm.reshape(t, -1)
    vel = np.vstack([np.zeros((1, pos.shape[1]), dtype=np.float32), np.diff(pos, axis=0)]) * (fps / 30.0)
    ang = joint_angles(norm) / np.pi
    return np.concatenate([pos, vel, ang], axis=1).astype(np.float32)


def windows(seq, size, stride):
    """Sliding windows over the first axis; short clips are edge-padded to one window."""
    if seq.shape[0] < size:
        pad = np.repeat(seq[-1:], size - seq.shape[0], axis=0)
        seq = np.concatenate([seq, pad], axis=0)
    return [seq[s:s + size] for s in range(0, seq.shape[0] - size + 1, stride)]
