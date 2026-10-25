#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI Markets online skill resources (thin client, MIT).

  python3 aim_resource.py --check                  # license + connection check
  python3 aim_resource.py prompts/<file>           # print a prompt / schema / example from the server
"""
import json, os, sys, urllib.error, urllib.parse, urllib.request

SLUG = "__SLUG__"
PRODUCT_URL = "https://www.aimarkets.vn/products/" + SLUG
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


def main():
    lic, key = _config()
    if not lic or not key:
        sys.stderr.write("[AI Markets] Thiếu AIMARKETS_LICENSE_KEY / AIMARKETS_API_KEY — " + PRODUCT_URL + "\n")
        sys.exit(3)
    arg = (sys.argv[1:] or ["--check"])[0]
    url = API + "/skills/" + SLUG if arg == "--check" else API + "/skills/" + SLUG + "/resources/" + urllib.parse.quote(arg)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "X-License-Key": lic, "User-Agent": "aimarkets-skill-loader/1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8"))
        except Exception:
            err = {}
        if err.get("code") == "LICENSE_EXPIRED":
            sys.stderr.write("[AI Markets] License đã hết hạn — skill dừng. Gia hạn tại " + PRODUCT_URL + "\n[AI Markets] License expired.\n")
        else:
            sys.stderr.write("[AI Markets] %s %s: %s\n" % (e.code, err.get("code", ""), err.get("message", "")))
        sys.exit(3 if e.code in (401, 402, 403) else 6)
    if arg == "--check":
        meta = json.loads(data)
        print("OK · %s · access=%s · license expires %s" % (meta.get("skill"), meta.get("access"), (meta.get("license") or {}).get("expiresAt")))
    else:
        sys.stdout.write(data)


if __name__ == "__main__":
    main()
