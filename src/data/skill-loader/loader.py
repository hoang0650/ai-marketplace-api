#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI Markets online skill loader (thin client, MIT).

The skill logic is NOT in this package: every run is executed on the AI Markets server and checked
against your own license key. When the license expires the command stops with a clear message.

Config: AIMARKETS_LICENSE_KEY (AIM-...) and AIMARKETS_API_KEY (mk_live_...), as env vars or in
~/.config/aimarkets/skills.json -> {"<slug>": {"licenseKey": "...", "apiKey": "..."}}.
Optional: AIMARKETS_API_BASE (default https://api.aimarkets.vn/v1).
"""
import base64, json, os, sys, urllib.error, urllib.request

SLUG = "__SLUG__"
SCRIPT = "__SCRIPT__"
PRODUCT_URL = "https://www.aimarkets.vn/products/" + SLUG
MAX_UPLOAD = 20 * 1024 * 1024
API = os.environ.get("AIMARKETS_API_BASE", "https://api.aimarkets.vn/v1").rstrip("/")


def _config():
    lic = os.environ.get("AIMARKETS_LICENSE_KEY", "").strip()
    key = os.environ.get("AIMARKETS_API_KEY", "").strip()
    path = os.path.expanduser("~/.config/aimarkets/skills.json")
    if (not lic or not key) and os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                row = (json.load(f) or {}).get(SLUG) or {}
            lic = lic or str(row.get("licenseKey", "")).strip()
            key = key or str(row.get("apiKey", "")).strip()
        except Exception:
            pass
    return lic, key


def _die(code, vi, en):
    sys.stderr.write("[AI Markets] " + vi + "\n[AI Markets] " + en + "\n")
    sys.exit(code)


def _map_args(argv):
    """Local files/dirs in argv are uploaded; absolute output paths are mapped and written back."""
    files, out_map, total, mapped = {}, {}, 0, []

    def add(local, remote):
        nonlocal total
        size = os.path.getsize(local)
        total += size
        if total > MAX_UPLOAD:
            _die(5, "Tổng dung lượng file đầu vào vượt 20 MB.", "Input files exceed 20 MB in total.")
        with open(local, "rb") as f:
            files[remote] = base64.b64encode(f.read()).decode("ascii")

    for i, tok in enumerate(argv):
        prefix, val = "", tok
        if tok.startswith("--") and "=" in tok:
            prefix, val = tok.split("=", 1)
            prefix += "="
        if val.startswith("-") or not val:
            mapped.append(tok)
            continue
        if os.path.isfile(val):
            remote = "in/%d/%s" % (i, os.path.basename(val))
            add(val, remote)
            mapped.append(prefix + remote)
        elif os.path.isdir(val):
            base = "in/%d/%s" % (i, os.path.basename(os.path.normpath(val)) or "dir")
            for root, _dirs, names in os.walk(val):
                for n in names:
                    full = os.path.join(root, n)
                    rel = os.path.relpath(full, val).replace(os.sep, "/")
                    add(full, base + "/" + rel)
            mapped.append(prefix + base + "/")
        elif os.path.isabs(val) or ".." in val.replace("\\", "/").split("/"):
            remote = "out/%d/%s" % (i, os.path.basename(val) or "output")
            out_map[remote] = val
            mapped.append(prefix + remote)
        else:
            mapped.append(tok)
    return mapped, files, out_map


def _write_outputs(outputs, out_map):
    for item in outputs or []:
        remote, b64 = str(item.get("path", "")), item.get("data", "")
        if remote.startswith("in/"):
            continue
        local = None
        for r, l in out_map.items():
            if remote == r or remote.startswith(r):
                local = l + remote[len(r):]
        if local is None:
            parts = remote.replace("\\", "/").split("/")
            if remote.startswith("/") or ".." in parts:
                continue
            local = remote
        d = os.path.dirname(local)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(local, "wb") as f:
            f.write(base64.b64decode(b64))
        sys.stderr.write("[AI Markets] wrote %s\n" % local)


def main():
    lic, key = _config()
    if not lic or not key:
        _die(3, "Thiếu AIMARKETS_LICENSE_KEY / AIMARKETS_API_KEY. Lấy ở trang sản phẩm → Dùng online: " + PRODUCT_URL,
             "Missing AIMARKETS_LICENSE_KEY / AIMARKETS_API_KEY. Get them on the product page → Use online: " + PRODUCT_URL)
    argv, files, out_map = _map_args(sys.argv[1:])
    body = json.dumps({"script": SCRIPT, "argv": argv, "files": [{"path": k, "data": v} for k, v in files.items()]}).encode("utf-8")
    req = urllib.request.Request(API + "/skills/" + SLUG + "/run", data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key, "X-License-Key": lic,
        "User-Agent": "aimarkets-skill-loader/1 (" + SLUG + ")"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8"))
        except Exception:
            err = {}
        code = err.get("code") or str(e.code)
        msg = err.get("message") or ""
        if e.code in (401, 402, 403):
            if code == "LICENSE_EXPIRED":
                _die(3, "License đã hết hạn — skill dừng. Gia hạn tại " + PRODUCT_URL, "License expired — the skill is stopped. Renew at " + PRODUCT_URL)
            _die(3, "Không dùng được skill (%s): %s Gia hạn/mua license tại %s" % (code, msg, PRODUCT_URL), "Skill unavailable (%s): %s %s" % (code, msg, PRODUCT_URL))
        if e.code == 429:
            _die(4, "Vượt hạn mức sử dụng, thử lại sau %ss." % err.get("retryAfterSec", 60), "Quota exceeded, retry in %ss." % err.get("retryAfterSec", 60))
        _die(6, "Lỗi máy chủ AI Markets (%s): %s" % (e.code, msg), "AI Markets server error (%s): %s" % (e.code, msg))
    except urllib.error.URLError as e:
        _die(6, "Không kết nối được AI Markets: %s" % e.reason, "Cannot reach AI Markets: %s" % e.reason)
    if res.get("stdout"):
        sys.stdout.write(res["stdout"])
    if res.get("stderr"):
        sys.stderr.write(res["stderr"])
    _write_outputs(res.get("files"), out_map)
    sys.exit(int(res.get("exitCode") or 0))


if __name__ == "__main__":
    main()
