"""Score a performance against an AI Markets motion template (DTW on joint angles).

  python score_motion.py video.mp4 [--template template.npz]

Score 0-100 per joint and overall; `weakSegments` lists the time ranges that differ most
from the reference performance.
"""
import argparse
import json
import os

import numpy as np

import pose_features as pf

HERE = os.path.dirname(os.path.abspath(__file__))


def angle_diff(a, b):
    """Absolute angle difference (radians), broadcasting over the last axis."""
    return np.abs(a - b)


def dtw_path(cost):
    """Classic DTW over a (N, M) cost matrix → list of (i, j) index pairs."""
    n, m = cost.shape
    inf = float('inf')
    acc = [[inf] * (m + 1) for _ in range(n + 1)]
    acc[0][0] = 0.0
    rows = cost.tolist()
    for i in range(1, n + 1):
        prev, cur, ci = acc[i - 1], acc[i], rows[i - 1]
        for j in range(1, m + 1):
            best = prev[j - 1]
            if prev[j] < best:
                best = prev[j]
            if cur[j - 1] < best:
                best = cur[j - 1]
            cur[j] = ci[j - 1] + best
    i, j, path = n, m, []
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        options = ((acc[i - 1][j - 1], i - 1, j - 1), (acc[i - 1][j], i - 1, j), (acc[i][j - 1], i, j - 1))
        _, i, j = min(options, key=lambda o: o[0])
    path.reverse()
    return path


def align(template, angles):
    """DTW alignment of a performance (T, 8) to a template (N, 8)."""
    cost = angle_diff(template[:, None, :], angles[None, :, :]).mean(axis=2)
    return dtw_path(cost)


def score_angles(mean, tol, angles, fps):
    path = align(mean, angles)
    ti = np.array([p[0] for p in path])
    si = np.array([p[1] for p in path])
    err = angle_diff(mean[ti], angles[si])
    closeness = np.exp(-0.5 * (err / tol[ti]) ** 2)
    per_joint = {name: round(float(closeness[:, k].mean() * 100), 1) for k, name in enumerate(pf.ANGLE_NAMES)}

    # Joints that actually move in the reference decide the score; near-static ones barely count.
    weight = mean.std(axis=0) + np.deg2rad(3.0)
    weight = weight / weight.sum()
    frame_score = (closeness * weight).sum(axis=1)
    per_template_frame = np.zeros(mean.shape[0])
    counts = np.zeros(mean.shape[0])
    np.add.at(per_template_frame, ti, frame_score)
    np.add.at(counts, ti, 1)
    per_template_frame = per_template_frame / np.maximum(counts, 1)

    weak, start = [], None
    for k, s in enumerate(per_template_frame):
        if s < 0.6 and start is None:
            start = k
        if (s >= 0.6 or k == len(per_template_frame) - 1) and start is not None:
            end = k
            if end - start >= max(2, int(0.3 * fps)):
                worst = int(np.argmin(closeness[(ti >= start) & (ti <= end)].mean(axis=0)))
                weak.append({
                    'from': round(start / fps, 2),
                    'to': round(end / fps, 2),
                    'joint': pf.ANGLE_NAMES[worst],
                })
            start = None

    return {
        'score': round(float(frame_score.mean() * 100), 1),
        'joints': per_joint,
        'tempo': round(float(angles.shape[0] / max(1, mean.shape[0])), 2),
        'weakSegments': weak[:10],
    }


def score_video(video, template_path):
    z = np.load(template_path)
    fps = float(z['fps'])
    kp, real_fps = pf.extract(video, int(round(fps)))
    norm = pf.normalize(kp)
    if norm is None:
        raise SystemExit('No clear person found in the video.')
    return score_angles(z['mean'], z['tol'], pf.joint_angles(norm), real_fps)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--template', default=os.path.join(HERE, 'template.npz'))
    args = ap.parse_args()
    print(json.dumps(score_video(args.video, args.template), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
