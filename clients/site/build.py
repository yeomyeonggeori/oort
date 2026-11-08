#!/usr/bin/env python3
"""oort 내려받기 페이지 빌드 (#5562). 표준 라이브러리만 쓴다.

  python3 clients/site/build.py            # -> clients/site/dist/
  python3 clients/site/build.py --out DIR  # 다른 폴더로

src/index.html 하나에 언어별 문구(i18n/<lang>.json)와 값(values.json)을 채워 언어마다 정적 페이지를 만든다.
CSS·스크립트는 페이지 안에 담는다(요청 하나). 다음 중 하나라도 있으면 빌드가 실패한다(exit 1):
  - 어느 언어에 키가 빠졌거나 남는 키가 있다(기준: 모든 언어 키의 합집합) · 값이 비었다
  - 문구에 줄표(U+2014, U+2013)가 있다(디자인 규칙)
  - 채우지 못한 {{자리}}가 남았다 · values.json 의 키가 빠졌다
  - 페이지가 가리키는 로컬 파일(src·href·srcset)이 결과 폴더에 없다
"""
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LANGS = ["ko", "en", "ja", "zh-Hans", "zh-Hant", "es", "fr"]
APP_LANGS = {"ko", "en"}  # 앱 화면이 나오는 언어. 나머지 언어 페이지는 영어 화면을 쓴다.
# 앱의 영어는 아직 일부 화면만 있다(clients/web 의 직접 문구). 그래서 한국어 페이지 말고는 모두 안내 한 줄을 단다.
NO_NOTE = {"ko"}
ROOT_LANG = "en"  # 루트(/)는 영어 페이지이고, 첫 방문이면 브라우저 언어로 옮긴다.
VALUE_KEYS = ["DMG_ARM_URL", "DMG_X64_URL", "VERSION", "APP_VERSION", "MIN_MACOS", "WEB_URL", "SITE_HOST"]
STORE_KEY = "oort.site.lang"
DASHES = ("—", "–")


def fail(msg):
    sys.stderr.write("build.py: " + msg + "\n")
    sys.exit(1)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        fail(f"{path.relative_to(HERE)} 를 읽지 못했어요: {e}")


def load_values():
    values = load_json(HERE / "values.json")
    missing = [k for k in VALUE_KEYS if not isinstance(values.get(k), str) or not values[k].strip()]
    if missing:
        fail("values.json 에 값이 없어요: " + ", ".join(missing))
    return values


def load_catalogs():
    cats = {lang: load_json(HERE / "i18n" / f"{lang}.json") for lang in LANGS}
    every = set()
    for cat in cats.values():
        every |= set(cat)
    problems = []
    for lang, cat in cats.items():
        lack = sorted(every - set(cat))
        if lack:
            problems.append(f"{lang}: 빠진 키 {', '.join(lack)}")
        for key, val in cat.items():
            if not isinstance(val, str) or not val.strip():
                problems.append(f"{lang}.{key}: 빈 값")
            elif any(d in val for d in DASHES):
                problems.append(f"{lang}.{key}: 줄표(U+2014/U+2013)는 쓰지 않아요")
    if problems:
        fail("문구 사전이 맞지 않아요\n  " + "\n  ".join(problems))
    return cats


def strip_css(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def strip_js(text):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("//"):
            continue
        out.append(s)
    return "\n".join(out)


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def root_redirect():
    # 루트에서만 돈다: 고른 언어 → 브라우저 언어 → 그대로(영어). 언어 페이지는 옮기지 않는다.
    langs = json.dumps(LANGS)
    return (
        "<script>(function(){var L=" + langs + ",s=null;"
        "try{s=localStorage.getItem(\"" + STORE_KEY + "\")}catch(e){}"
        "if(L.indexOf(s)<0){s=null;var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||\"\"];"
        "for(var i=0;i<n.length&&!s;i++){var x=String(n[i]).toLowerCase();"
        "if(x.indexOf(\"ko\")==0)s=\"ko\";else if(x.indexOf(\"ja\")==0)s=\"ja\";"
        "else if(x.indexOf(\"zh\")==0)s=/hant|-tw|-hk|-mo/.test(x)?\"zh-Hant\":\"zh-Hans\";"
        "else if(x.indexOf(\"es\")==0)s=\"es\";else if(x.indexOf(\"fr\")==0)s=\"fr\";else if(x.indexOf(\"en\")==0)s=\"en\";}}"
        "if(s)location.replace(s+\"/\"+location.hash)})();</script>"
    )


def render(lang, is_root, template, cats, values, parts, shot_size):
    t = cats[lang]
    base = "" if is_root else "../"
    host = values["SITE_HOST"]
    hreflang = [f'<link rel="alternate" hreflang="{code}" href="https://{host}/{code}/">' for code in LANGS]
    hreflang.append(f'<link rel="alternate" hreflang="x-default" href="https://{host}/">')
    items, foot = [], []
    for code in LANGS:
        cur = ' aria-current="page"' if code == lang else ""
        name = esc(cats[code]["lang_name"])
        attrs = f'href="{base}{code}/" hreflang="{code}" lang="{code}" data-lang="{code}"{cur}'
        items.append(f'        <li><a {attrs}>{name}<svg class="i tick" aria-hidden="true"><use href="#i-check"/></svg></a></li>')
        foot.append(f"    <a {attrs}>{name}</a>")
    shot = lang if lang in APP_LANGS else "en"
    note = "" if lang in NO_NOTE else ' <span class="note">{{t.app_lang_note}}</span>'
    page = template
    fills = {
        "{{lang}}": lang,
        "{{hreflang}}": "\n".join(hreflang),
        "{{root_redirect}}": root_redirect() if is_root else "",
        "{{lang_items}}": "\n".join(items),
        "{{foot_langs}}": "\n".join(foot),
        "{{app_lang_note}}": note,
        "{{shot}}": shot,
        "{{shot_w}}": str(shot_size["width"]),
        "{{shot_h}}": str(shot_size["height"]),
        "{{css}}": parts["css"],
        "{{js}}": parts["js"],
        "{{sky}}": parts["sky"],
    }
    for k, v in fills.items():
        page = page.replace(k, v)
    page = re.sub(r"\{\{t\.([a-z0-9_]+)\}\}", lambda m: esc(t[m.group(1)]) if m.group(1) in t else m.group(0), page)
    page = re.sub(r"\{\{v\.([A-Z0-9_]+)\}\}", lambda m: esc(values[m.group(1)]) if m.group(1) in values else m.group(0), page)
    page = page.replace("{{b}}", base)
    left = sorted(set(re.findall(r"\{\{[^{}]*\}\}", page)))
    if left:
        fail(f"{'/' if is_root else lang}: 채우지 못한 자리 {', '.join(left)}")
    return page


LOCAL_REF = re.compile(r'(?:src|href|srcset)="([^"#][^"]*)"')


def check_refs(out, page_path, html):
    missing = []
    for ref in LOCAL_REF.findall(html):
        for one in ref.split(","):
            url = one.strip().split(" ")[0]
            if not url or re.match(r"^[a-z]+:", url) or url.startswith("//"):
                continue
            target = (page_path.parent / url).resolve()
            if url.endswith("/"):
                target = target / "index.html"
            inside = target == out.resolve() or out.resolve() in target.parents
            if not inside or not target.exists():
                missing.append(url)
    return missing


def main(argv):
    out = HERE / "dist"
    if "--out" in argv:
        out = Path(argv[argv.index("--out") + 1]).resolve()
    values = load_values()
    cats = load_catalogs()
    shot_size = load_json(HERE / "assets" / "app-shots.json")
    template = (HERE / "src" / "index.html").read_text(encoding="utf-8")
    parts = {
        "css": strip_css((HERE / "src" / "site.css").read_text(encoding="utf-8")),
        "js": strip_js((HERE / "src" / "site.js").read_text(encoding="utf-8")),
        "sky": strip_js((HERE / "src" / "sky.js").read_text(encoding="utf-8")),
    }
    # 폴더는 두고 안만 비운다(미리 보기 서버가 이 폴더를 띄운 채로 다시 빌드해도 된다).
    out.mkdir(parents=True, exist_ok=True)
    for child in out.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    shutil.copytree(HERE / "assets", out / "assets", ignore=shutil.ignore_patterns("*.json", ".DS_Store"))
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    (out / "CNAME").write_text(values["SITE_HOST"] + "\n", encoding="utf-8")

    pages = [(ROOT_LANG, True, out / "index.html")] + [(lang, False, out / lang / "index.html") for lang in LANGS]
    report = []
    for lang, is_root, path in pages:
        html = render(lang, is_root, template, cats, values, parts, shot_size)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        report.append((path.relative_to(out).as_posix(), len(html.encode("utf-8"))))
    broken = []
    for lang, is_root, path in pages:
        broken += [f"{path.relative_to(out).as_posix()} -> {r}" for r in check_refs(out, path, path.read_text(encoding="utf-8"))]
    if broken:
        fail("결과 폴더에 없는 파일을 가리켜요\n  " + "\n  ".join(sorted(set(broken))))

    script_bytes = len(parts["js"].encode("utf-8")) + len(parts["sky"].encode("utf-8"))
    asset_bytes = sum(p.stat().st_size for p in (out / "assets").rglob("*") if p.is_file())
    print(f"build.py: {len(pages)} pages -> {out}")
    for name, size in report:
        print(f"  {name:<22} {size:>7} B")
    print(f"  inline script (site.js + sky.js) {script_bytes} B · css {len(parts['css'].encode('utf-8'))} B · assets {asset_bytes} B")


if __name__ == "__main__":
    main(sys.argv[1:])
