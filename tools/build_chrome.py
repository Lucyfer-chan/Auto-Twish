"""Monta a variante do Chrome a partir do codigo (src/, o mesmo do Firefox) + chrome/.
Uso: python3 tools/build_chrome.py [origem] [destino]
     (padrao: src/ -> dist/chrome/)"""
import json, shutil, sys, os, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "src")
dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "dist", "chrome")
extra = os.path.join(ROOT, "chrome")
if os.path.exists(dst):
    shutil.rmtree(dst)
os.makedirs(dst)
for f in ["shared.js", "background.js", "market.js", "protection.js", "shop.js", "kit.js", "invdump.js", "board.js", "upgrade.js", "remedy.js", "content.js",
          "popup.html", "popup.js", "options.html", "options.js", "options-market.js", "ui.css", "stats.html", "stats.js",
          "browser-polyfill.js"]:
    shutil.copy(os.path.join(src, f), dst)
shutil.copy(os.path.join(extra, "chrome-compat.js"), dst)
shutil.copy(os.path.join(extra, "sw.js"), dst)
shutil.copytree(os.path.join(extra, "icons"), os.path.join(dst, "icons"))
# README proprio do Chrome (instalacao do Chrome, sem as instrucoes do Firefox)
import subprocess
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "chrome_readme.py"),
                os.path.join(src, "README.md"), os.path.join(dst, "README.md")], check=True)

m = json.load(open(os.path.join(src, "manifest.json")), object_pairs_hook=collections.OrderedDict)
m["background"] = {"service_worker": "sw.js"}
m.pop("browser_specific_settings", None)
m["minimum_chrome_version"] = "120"  # alarmes de 30 s e Promises nas APIs
icons = {"16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png"}
m["icons"] = icons
m["action"]["default_icon"] = icons
out = collections.OrderedDict()
for k, v in m.items():
    out[k] = v
json.dump(out, open(os.path.join(dst, "manifest.json"), "w"), ensure_ascii=False, indent=2)
open(os.path.join(dst, "manifest.json"), "a").write("\n")
print("ok", dst)
