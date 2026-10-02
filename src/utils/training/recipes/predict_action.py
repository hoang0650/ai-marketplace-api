"""Run a trained AI Markets action-recognition model on a new video.

  python predict_action.py video.mp4 [--threshold 0.5]
"""
import argparse
import json
import os

import numpy as np
import torch

import pose_features as pf

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--threshold', type=float, default=0.5)
    args = ap.parse_args()

    cfg = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))
    labels = json.load(open(os.path.join(HERE, 'labels.json'), encoding='utf-8'))
    model = torch.jit.load(os.path.join(HERE, 'model.pt'), map_location='cpu').eval()

    kp, fps = pf.extract(args.video, cfg['fps'])
    norm = pf.normalize(kp)
    if norm is None:
        raise SystemExit('No clear person found in the video.')
    wins = [pf.frame_features(w, fps) for w in pf.windows(norm, cfg['windowFrames'], cfg['strideFrames'])]
    with torch.no_grad():
        probs = torch.softmax(model(torch.tensor(np.stack(wins))), dim=1).numpy()

    segments = []
    for i, p in enumerate(probs):
        k = int(p.argmax())
        name = labels[k] if p[k] >= args.threshold else '?'
        start = i * cfg['strideFrames'] / fps
        if segments and segments[-1]['label'] == name:
            segments[-1]['end'] = start + cfg['windowFrames'] / fps
        else:
            segments.append({'label': name, 'start': round(start, 2), 'end': round(start + cfg['windowFrames'] / fps, 2)})
    overall = probs.mean(0)
    top = int(overall.argmax())
    print(json.dumps({
        'top': labels[top],
        'confidence': round(float(overall[top]), 3),
        'segments': segments,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
