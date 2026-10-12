"""Gera os pacotes da versao atual nas duas variantes, em dist/:
  dist/Auto Twish v X/                 (Firefox)  + "Auto Twish v X dd-mm-aa hh-mm.zip"
  dist/Auto Twish v X Chrome/          (Chrome)   + "Auto Twish v X Chrome dd-mm-aa hh-mm.zip"
Uso: python3 tools/build.py"""
import json, os, shutil, subprocess, sys, time, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")
version = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))["version"]
stamp = time.strftime("%d-%m-%y %H-%M")
ff = os.path.join(DIST, f"Auto Twish v {version}")
ch = os.path.join(DIST, f"Auto Twish v {version} Chrome")


def zipdir(folder, out):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(folder):
            for f in sorted(files):
                p = os.path.join(base, f)
                z.write(p, os.path.relpath(p, folder))


os.makedirs(DIST, exist_ok=True)
if os.path.exists(ff):
    shutil.rmtree(ff)
shutil.copytree(SRC, ff)
subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_chrome.py"), SRC, ch], check=True)
zipdir(ff, os.path.join(DIST, f"Auto Twish v {version} {stamp}.zip"))
zipdir(ch, os.path.join(DIST, f"Auto Twish v {version} Chrome {stamp}.zip"))
print(f"ok: v {version} ({stamp}) em {DIST}")
