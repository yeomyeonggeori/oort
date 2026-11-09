#!/usr/bin/env python3
"""oort 내려받기 페이지와 문서 빌드 (#5562 · 문서 #5590). 표준 라이브러리만 쓴다(Python 3.9 이상).

  python3 clients/site/build.py                          # -> clients/site/dist/ (어느 폴더에서 돌려도 이 파일 기준)
  python3 clients/site/build.py --out DIR                # 다른 폴더로(확인·사보타주용)
  python3 clients/site/build.py --out DIR --docs-src D   # 문서 마크다운을 D 에서 읽는다(check.mjs 의 모르는 문법 시험용)

배포는 Vercel 프로젝트 oort 가 저장소 루트에서 이 스크립트를 돌리고 clients/site/dist 를 올린다(설치 명령·프레임워크 없음).

src/index.html 하나에 언어별 문구(i18n/<lang>.json)와 값(values.json)을 채워 언어마다 정적 페이지를 만든다.
문서는 docs/<lang>/<쪽>.md(ko·en)를 아래 「문서 마크다운」 문법만으로 HTML 로 바꿔 src/docs.html 틀에 채운다(/docs/...).
CSS·스크립트는 페이지 안에 담는다(요청 하나). 다음 중 하나라도 있으면 빌드가 실패한다(exit 1):
  - 어느 언어에 키가 빠졌거나 남는 키가 있다(기준: 모든 언어 키의 합집합) · 값이 비었다
  - 문구에 줄표(U+2014, U+2013)가 있다(디자인 규칙)
  - 구절 힌트(|)가 PHRASE_LANGS 밖 언어에 있거나, 속성·<title> 안에 들어가는 키에 있다
  - 채우지 못한 {{자리}}가 남았다 · values.json 의 키가 빠졌다
  - 페이지가 가리키는 로컬 파일(src·href·srcset)이 결과 폴더에 없다
  - 문서: 모르는 마크다운 문법(파일:줄로 알린다), 머리 칸이 빠졌거나 틀렸다, 출처 경로가 저장소에 없다,
    쪽이 언어마다 하나씩 있지 않다, 없는 쪽·제목 id 로 가는 링크, ko·en 의 상태·날짜·출처가 다르다,
    페이지 상태가 done 인데 제목 옆 상태에 partial·planned 가 있다

문서 마크다운(이것만 안다. 나머지는 모두 빌드 실패):
  머리 칸  맨 위 --- 와 --- 사이에 title · description · status(done|partial|planned) · checked(YYYY-MM-DD) ·
           sources(다음 줄부터 「- 저장소 루트 기준 경로」, 저장소에 있어야 한다)
  제목     「## 글자」 「### 글자」. 끝에 {done}·{partial}·{planned} 를 붙이면 그 부분의 상태 표지
  문단     빈 줄로 나눈다(한 문단은 한 줄로 쓰기를 권한다)
  목록     「- 항목」 또는 「1. 항목」(번호는 1부터 차례로). 한 단계만, 한 항목은 한 줄
  코드     `글자` · ```언어(영문 소문자 또는 없음) … ```
  링크     [글자](https://…) · [글자](/docs/<같은 언어>/<쪽>/) · [글자](/<언어>/) · 뒤에 #제목id 를 붙일 수 있다
  표       | 머리 | 머리 | → |---|---| → 내용 줄. 칸 수가 같아야 한다. 칸 전체가 {done} 같은 상태면 표지
  금지 예  > 인용 · * _ 강조 · ~ · <HTML> · ![그림] · 각주·참조 링크 · # 하나·#### 이상 · 들여쓰기·중첩 목록 ·
           ---·=== 줄 · \\ 이스케이프 · &이름; · 줄 끝 빈칸·탭 · 표 밖 | · 제목 끝·표 칸 밖 { } · 체크 상자
"""
import datetime
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LANGS = ["ko", "en", "ja", "zh-Hans", "zh-Hant", "es", "fr"]
APP_LANGS = {"ko", "en"}  # 앱 화면이 나오는 언어. 나머지 언어 페이지는 영어 화면을 쓴다.
# 앱의 영어는 아직 일부 화면만 있다(clients/web 의 직접 문구). 그래서 한국어 페이지 말고는 모두 안내 한 줄을 단다.
NO_NOTE = {"ko"}
ROOT_LANG = "en"  # 루트(/)는 영어 페이지이고, 첫 방문이면 브라우저 언어로 옮긴다.
VALUE_KEYS = ["DMG_ARM_URL", "DMG_X64_URL", "VERSION", "MIN_MACOS", "WEB_URL", "SITE_HOST"]
STORE_KEY = "oort.site.lang"
DASHES = ("—", "–")
# 브라우저가 구절을 모르는(WebKit 은 word-break: auto-phrase 가 없다) 언어: 문구의 | 자리에 <wbr> 를 넣고
# CSS 가 word-break: keep-all 로 그 자리(와 문장 부호·빈칸)에서만 줄을 바꾼다. 조사 앞에서 끊기지 않게.
# 중국어는 첫 화면 제목에만 쓴다(본문은 글자 사이 줄바꿈이 관례라 힌트 없이 둔다. keep-all 도 제목에만).
PHRASE_LANGS = {"ja", "zh-Hans", "zh-Hant"}
PHRASE_MARK = "|"

# 문서(#5590): ko·en 두 언어, 쪽 여섯. 이 순서가 옆 목록과 이전·다음 순서다. overview 는 /docs/<lang>/ 이다.
DOCS_LANGS = ["ko", "en"]
DOCS_ROOT_LANG = "en"  # /docs/ 는 영어 개요이고, 고른 언어·브라우저 언어가 한국어면 /docs/ko/ 로 옮긴다.
DOCS_PAGES = ["overview", "concepts", "quickstart", "agents", "webhooks", "security"]
DOCS_STATUS = ["done", "partial", "planned"]  # 됨 · 부분 · 계획
DOCS_FRONT = ["title", "description", "status", "checked", "sources"]
DOCS_DESC_MAX = 160
REPO_WEB = "https://github.com/yeomyeonggeori/oort"
REPO_BRANCH = "main"
# 틀이 이미 쓰는 id(본문 제목 id 가 겹치면 뒤에 번호를 붙인다)
DOCS_RESERVED_IDS = {"doc", "doc-title", "lang-list", "docs-side-title"}


def fail(msg):
    sys.stderr.write("build.py: " + msg + "\n")
    sys.exit(1)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        fail(f"{path} 를 읽지 못했어요: {e}")


def load_values():
    values = load_json(HERE / "values.json")
    missing = [k for k in VALUE_KEYS if not isinstance(values.get(k), str) or not values[k].strip()]
    if missing:
        fail("values.json 에 값이 없어요: " + ", ".join(missing))
    return values


def attr_keys(template):
    # 속성 값·<title> 안에 들어가는 문구 키: 여기에는 <wbr> 를 넣을 수 없다
    keys = set(re.findall(r'="[^"]*?\{\{t\.([a-z0-9_]+)\}\}', template))
    keys |= set(re.findall(r"<title>[^<]*?\{\{t\.([a-z0-9_]+)\}\}", template))
    return keys | {"lang_name"}  # 언어 메뉴·꼬리 링크도 빌드가 직접 쓴다


def load_catalogs(template):
    cats = {lang: load_json(HERE / "i18n" / f"{lang}.json") for lang in LANGS}
    in_attr = attr_keys(template)
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
            elif PHRASE_MARK in val and (lang not in PHRASE_LANGS or key in in_attr):
                problems.append(f"{lang}.{key}: 구절 힌트({PHRASE_MARK})는 {', '.join(sorted(PHRASE_LANGS))}의 본문 글자에만 써요")
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


def docs_lang_for(lang):
    """내려받기 페이지 언어 → 「문서」 링크가 가는 문서 언어. 문서가 없는 언어(ja·zh·es·fr)는 영어 문서로."""
    return lang if lang in DOCS_LANGS else DOCS_ROOT_LANG


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
        "{{docs_lang}}": docs_lang_for(lang),
        "{{shot}}": shot,
        "{{shot_w}}": str(shot_size["width"]),
        "{{shot_h}}": str(shot_size["height"]),
        "{{css}}": parts["css"],
        "{{js}}": parts["js"],
        "{{sky}}": parts["sky"],
    }
    for k, v in fills.items():
        page = page.replace(k, v)
    page = re.sub(r"\{\{t\.([a-z0-9_]+)\}\}", lambda m: esc(t[m.group(1)]).replace(PHRASE_MARK, "<wbr>") if m.group(1) in t else m.group(0), page)
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
            url = one.strip().split(" ")[0].split("#")[0]
            if not url or re.match(r"^[a-z]+:", url) or url.startswith("//"):
                continue
            # 문서는 /docs/... 처럼 루트 기준 주소를 쓴다(app.oor7.com/docs 처럼 끝 / 없이 열려도 링크가 맞게)
            target = (out / url.lstrip("/")).resolve() if url.startswith("/") else (page_path.parent / url).resolve()
            if url.endswith("/"):
                target = target / "index.html"
            inside = target == out.resolve() or out.resolve() in target.parents
            if not inside or not target.exists():
                missing.append(url)
    return missing


# ---------------------------------------------------------------------------
# 문서 마크다운 (#5590): 작은 부분 집합만 안다. 모르는 문법은 파일:줄과 함께 빌드를 멈춘다.
# ---------------------------------------------------------------------------


class MdError(Exception):
    def __init__(self, line, msg):
        super().__init__(msg)
        self.line = line
        self.msg = msg


LINK_RE = re.compile(r"\[((?:[^\[\]`]|`[^`]+`)+)\]\(([^()\s]+)\)")
ENTITY_RE = re.compile(r"&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);")
INLINE_BAD = {
    "*": "강조(*)는 쓰지 않아요",
    "_": "강조(_)는 쓰지 않아요. 이름·경로는 `코드`로 써요",
    "~": "취소선(~)은 쓰지 않아요",
    "<": "HTML·자동 링크(<)는 쓰지 않아요. 자리 표시는 `코드`로 써요",
    ">": "인용·HTML(>)은 쓰지 않아요",
    "\\": "이스케이프(\\)는 쓰지 않아요",
    "{": "중괄호는 제목 끝 상태와 표 칸 상태, `코드` 안에만 써요",
    "}": "중괄호는 제목 끝 상태와 표 칸 상태, `코드` 안에만 써요",
    "|": "| 는 표 줄에서만 써요",
    "]": "짝 없는 ] 예요",
}
HEADING_RE = re.compile(r"(#+)( ?)(.*)")
STATUS_TAIL = re.compile(r"(.*\S) \{(done|partial|planned)\}")
STATUS_CELL = re.compile(r"\{(done|partial|planned)\}")
OL_RE = re.compile(r"([0-9]+)\. (.*)")
SEP_CELL = re.compile(r"-{3,}")
RULE_RE = re.compile(r"(-{3,}|\*{3,}|_{3,}|={3,})")
BAD_START = [
    (">", "인용(>)"),
    ("* ", "목록 기호 *"),
    ("+ ", "목록 기호 +"),
    ("<", "HTML"),
    ("![", "그림"),
    ("[^", "각주"),
]
SOURCE_RE = re.compile(r"[A-Za-z0-9._/-]+")


class DocCtx:
    """한 쪽을 읽는 동안의 언어·문구와 나중에 맞춰 볼 링크(쪽 id, 줄, 대상 쪽, #id)."""

    def __init__(self, lang, strings):
        self.lang = lang
        self.strings = strings
        self.links = []

    def link(self, url, line):
        if url.startswith("https://"):
            return url
        if url.startswith("#"):
            if len(url) < 2:
                raise MdError(line, "빈 # 링크예요")
            self.links.append((line, None, url[1:]))
            return url
        m = re.fullmatch(r"/docs/([a-zA-Z-]+)/(?:([a-z]+)/)?(?:#(.+))?", url)
        if m:
            lang, slug, frag = m.group(1), m.group(2), m.group(3)
            if lang != self.lang:
                raise MdError(line, f"다른 언어 문서({lang})로 가는 링크예요. 같은 언어 쪽(/docs/{self.lang}/…)을 가리켜요")
            if slug is not None and (slug not in DOCS_PAGES or slug == "overview"):
                raise MdError(line, f"없는 문서 쪽이에요: {url} (쪽: {', '.join(DOCS_PAGES[1:])}, 개요는 /docs/{self.lang}/)")
            self.links.append((line, slug or "overview", frag))
            return url
        m = re.fullmatch(r"/(?:([a-zA-Z-]+)/)?", url)
        if m and (m.group(1) is None or m.group(1) in LANGS):
            return url  # 내려받기 페이지
        raise MdError(line, f"링크 주소 「{url}」: https://, /docs/{self.lang}/<쪽>/, /<언어>/, #제목id 만 써요")


def status_badge(status, strings, hidden_label=True):
    label = esc(strings["status_" + status])
    lead = f'<span class="vh">{esc(strings["status_label"])}: </span>' if hidden_label else ""
    return f'<span class="status status-{status}">{lead}{label}</span>'


def render_inline(text, ctx, line, in_link=False):
    out = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "`":
            j = text.find("`", i + 1)
            if j < 0:
                raise MdError(line, "닫히지 않은 코드(`)예요")
            code = text[i + 1:j]
            if not code.strip():
                raise MdError(line, "빈 코드(``)는 모르는 문법이에요")
            out.append("<code>" + esc(code) + "</code>")
            i = j + 1
            continue
        if ch == "[":
            if in_link:
                raise MdError(line, "링크 안에 링크는 못 넣어요")
            m = LINK_RE.match(text, i)
            if not m:
                raise MdError(line, "링크는 [글자](주소) 모양만 써요(참조 링크·각주·체크 상자는 모르는 문법)")
            href = ctx.link(m.group(2), line)
            out.append(f'<a href="{esc(href)}">' + render_inline(m.group(1), ctx, line, True) + "</a>")
            i = m.end()
            continue
        if ch == "!" and text.startswith("![", i):
            raise MdError(line, "그림(![…](…))은 모르는 문법이에요")
        if ch == "&" and ENTITY_RE.match(text, i):
            raise MdError(line, "HTML 엔티티(&이름;)는 모르는 문법이에요. 글자를 그대로 써요")
        if ch in INLINE_BAD:
            raise MdError(line, f"모르는 문법 「{ch}」: {INLINE_BAD[ch]}")
        out.append(esc(ch))
        i += 1
    return "".join(out)


def plain_title(text, line, what):
    if "`" in text or "[" in text or any(ch in INLINE_BAD for ch in text):
        raise MdError(line, f"{what}에는 마크다운 기호를 쓰지 않아요")
    return text


def slugify(text, ids):
    base = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text).replace("`", "")
    base = re.sub(r"[^\w\s-]", "", base.strip().lower())
    base = re.sub(r"[\s_]+", "-", base).strip("-") or "s"
    hid, k = base, 2
    while hid in ids:
        hid = f"{base}-{k}"
        k += 1
    ids.add(hid)
    return hid


def is_block_start(line):
    return (
        line.startswith(("#", "- ", "|", "```", " ", ">", "* ", "+ ", "<", "![", "[^"))
        or OL_RE.match(line) is not None
        or RULE_RE.fullmatch(line) is not None
    )


def split_cells(row, line):
    if len(row) < 2 or not row.endswith("|"):
        raise MdError(line, "표 줄은 | 로 시작하고 | 로 끝나요")
    cells, cur, code = [], [], False
    for ch in row[1:-1]:
        if ch == "`":
            code = not code
        if ch == "|" and not code:
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    cells.append("".join(cur).strip())
    return cells


def parse_front(lines):
    if not lines or lines[0] != "---":
        raise MdError(1, "맨 위에 --- 로 여는 머리 칸(title·description·status·checked·sources)이 있어야 해요")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise MdError(1, "머리 칸을 닫는 --- 가 없어요")
    front, key = {}, None
    for no in range(2, end + 1):
        line = lines[no - 1]
        if line.startswith("- "):
            if key != "sources":
                raise MdError(no, "「- 」 줄은 sources 아래에만 써요")
            front["sources"].append((no, line[2:]))
            continue
        m = re.fullmatch(r"([a-z]+):(?: (.*))?", line)
        if not m:
            raise MdError(no, "머리 칸 줄은 「키: 값」이거나 sources 아래 「- 경로」예요")
        key, value = m.group(1), (m.group(2) or "")
        if key not in DOCS_FRONT:
            raise MdError(no, f"모르는 머리 칸 키 「{key}」예요({', '.join(DOCS_FRONT)})")
        if key in front:
            raise MdError(no, f"머리 칸 키 「{key}」가 두 번 나와요")
        if key == "sources":
            if value:
                raise MdError(no, "sources 는 다음 줄부터 「- 경로」로 적어요")
            front["sources"] = []
        elif not value.strip():
            raise MdError(no, f"{key} 값이 비었어요")
        else:
            front[key] = (no, value)
    missing = [k for k in DOCS_FRONT if k not in front]
    if missing:
        raise MdError(end + 1, "머리 칸에 빠진 키가 있어요: " + ", ".join(missing))
    no, status = front["status"]
    if status not in DOCS_STATUS:
        raise MdError(no, f"status 는 {' · '.join(DOCS_STATUS)} 중 하나예요(지금 「{status}」)")
    no, checked = front["checked"]
    try:
        day = datetime.date.fromisoformat(checked) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", checked) else None
    except ValueError:
        day = None
    if day is None:
        raise MdError(no, f"checked 는 YYYY-MM-DD 날짜예요(지금 「{checked}」)")
    if day > datetime.date.today():
        raise MdError(no, f"checked({checked})가 오늘보다 뒤예요")
    if not front["sources"]:
        raise MdError(end + 1, "출처(sources)가 하나도 없어요")
    seen = set()
    for no, src in front["sources"]:
        if not SOURCE_RE.fullmatch(src) or src.startswith("/") or ".." in src.split("/"):
            raise MdError(no, f"출처 「{src}」: 저장소 루트 기준 경로만 써요(줄 번호·#·빈칸 없이)")
        if src in seen:
            raise MdError(no, f"출처 「{src}」가 두 번 나와요")
        seen.add(src)
        if not (REPO / src).exists():
            raise MdError(no, f"출처 「{src}」가 저장소에 없어요")
    no, title = front["title"]
    plain_title(title, no, "title")
    no, desc = front["description"]
    plain_title(desc, no, "description")
    if len(desc) > DOCS_DESC_MAX:
        raise MdError(no, f"description 은 {DOCS_DESC_MAX}자 이하예요(지금 {len(desc)}자)")
    return {
        "title": title,
        "description": desc,
        "status": status,
        "checked": checked,
        "sources": [s for _, s in front["sources"]],
    }, end + 1


def end_of_block(lines, i, what):
    if i < len(lines) and lines[i] != "":
        raise MdError(i + 1, f"{what} 뒤에는 빈 줄을 둬요(이어지는 줄·중첩·섞인 목록은 모르는 문법)")


def parse_body(lines, first, ctx):
    html, ids, statuses = [], set(DOCS_RESERVED_IDS), []
    i, n = first, len(lines)
    while i < n:
        line = lines[i]
        if line == "":
            i += 1
            continue
        if line.startswith("```"):
            lang = line[3:]
            if not re.fullmatch(r"[a-z]*", lang):
                raise MdError(i + 1, "코드 블록 언어는 영문 소문자 한 낱말이거나 비워요")
            j = i + 1
            while j < n and lines[j] != "```":
                if lines[j].startswith("```"):
                    raise MdError(j + 1, "코드 블록은 ``` 한 줄로 닫아요")
                j += 1
            if j >= n:
                raise MdError(i + 1, "닫히지 않은 코드 블록(```)이에요")
            code = "\n".join(lines[i + 1:j])
            if not code.strip():
                raise MdError(i + 1, "빈 코드 블록이에요")
            cls = f' class="lang-{lang}"' if lang else ""
            html.append(f'<pre tabindex="0"><code{cls}>{esc(code)}</code></pre>')
            i = j + 1
            end_of_block(lines, i, "코드 블록")
            continue
        if line.startswith("#"):
            m = HEADING_RE.fullmatch(line)
            level = len(m.group(1))
            if level not in (2, 3):
                raise MdError(i + 1, f"제목은 ## 와 ### 만 써요({m.group(1)} 는 모르는 문법)")
            if m.group(2) != " " or not m.group(3).strip():
                raise MdError(i + 1, "제목은 「## 글자」 모양이에요")
            text, status = m.group(3), None
            sm = STATUS_TAIL.fullmatch(text)
            if sm:
                text, status = sm.group(1), sm.group(2)
                statuses.append(status)
            hid = slugify(text, ids)
            badge = " " + status_badge(status, ctx.strings) if status else ""
            html.append(f'<h{level} id="{hid}"><span class="h-t">{render_inline(text, ctx, i + 1)}</span>{badge}</h{level}>')
            i += 1
            end_of_block(lines, i, "제목")
            continue
        if line.startswith("- "):
            items = []
            while i < n and lines[i].startswith("- "):
                item = lines[i][2:]
                if re.match(r"\[[ xX]\]", item):
                    raise MdError(i + 1, "체크 상자 목록은 모르는 문법이에요")
                if not item.strip():
                    raise MdError(i + 1, "빈 목록 항목이에요")
                items.append("<li>" + render_inline(item, ctx, i + 1) + "</li>")
                i += 1
            end_of_block(lines, i, "목록")
            html.append("<ul>" + "".join(items) + "</ul>")
            continue
        if OL_RE.match(line):
            items, k = [], 1
            while i < n and OL_RE.match(lines[i]):
                mm = OL_RE.match(lines[i])
                if int(mm.group(1)) != k:
                    raise MdError(i + 1, f"번호 목록은 1부터 차례로 적어요(여기는 {k}.)")
                if not mm.group(2).strip():
                    raise MdError(i + 1, "빈 목록 항목이에요")
                items.append("<li>" + render_inline(mm.group(2), ctx, i + 1) + "</li>")
                k += 1
                i += 1
            end_of_block(lines, i, "번호 목록")
            html.append("<ol>" + "".join(items) + "</ol>")
            continue
        if line.startswith("|"):
            start, rows = i, []
            while i < n and lines[i].startswith("|"):
                rows.append((i + 1, split_cells(lines[i], i + 1)))
                i += 1
            end_of_block(lines, i, "표")
            if len(rows) < 3:
                raise MdError(start + 1, "표는 머리 줄, 나눔 줄(|---|---|), 내용 줄이 있어야 해요")
            head, sep, body = rows[0], rows[1], rows[2:]
            if not all(SEP_CELL.fullmatch(c) for c in sep[1]):
                raise MdError(sep[0], "표 둘째 줄은 |---|---| 모양이에요(정렬 : 은 모르는 문법)")
            width = len(head[1])
            for no, cells in [sep] + body:
                if len(cells) != width:
                    raise MdError(no, f"표 칸 수가 머리 줄({width})과 달라요({len(cells)})")
                if any(not c for c in cells):
                    raise MdError(no, "빈 표 칸이에요")
            if any(not c for c in head[1]):
                raise MdError(head[0], "빈 표 머리 칸이에요")

            def cell(text, no):
                sm = STATUS_CELL.fullmatch(text)
                return status_badge(sm.group(1), ctx.strings, hidden_label=False) if sm else render_inline(text, ctx, no)

            ths = "".join(f'<th scope="col">{render_inline(c, ctx, head[0])}</th>' for c in head[1])
            trs = "".join("<tr>" + "".join(f"<td>{cell(c, no)}</td>" for c in cells) + "</tr>" for no, cells in body)
            html.append(f'<div class="table-wrap"><table><thead><tr>{ths}</tr></thead><tbody>{trs}</tbody></table></div>')
            continue
        if line[0] == " ":
            raise MdError(i + 1, "들여쓰기(중첩 목록·들여쓴 코드)는 모르는 문법이에요")
        for prefix, name in BAD_START:
            if line.startswith(prefix):
                raise MdError(i + 1, f"모르는 문법 「{prefix.strip()}」: {name}")
        if RULE_RE.fullmatch(line):
            raise MdError(i + 1, "가로줄·밑줄 제목(---·===)은 모르는 문법이에요")
        para = [(i + 1, line)]
        i += 1
        while i < n and lines[i] != "":
            if is_block_start(lines[i]):
                raise MdError(i + 1, "제목·목록·표·코드 블록 앞에는 빈 줄을 둬요(밑줄 제목·이어진 들여쓰기는 모르는 문법)")
            para.append((i + 1, lines[i]))
            i += 1
        html.append("<p>" + " ".join(render_inline(t, ctx, no) for no, t in para) + "</p>")
    return "\n".join(html), ids, statuses


def parse_doc(text, lang, strings):
    """마크다운 한 쪽 → 머리 칸·본문 HTML·제목 id·제목 옆 상태·링크. 모르는 문법은 MdError(줄)."""
    if "\r" in text:
        raise MdError(text[: text.index("\r")].count("\n") + 1, "CR(\\r) 줄 끝은 쓰지 않아요")
    if not text.endswith("\n"):
        raise MdError(text.count("\n") + 1, "파일 끝에 줄바꿈 하나가 있어야 해요")
    lines = text[:-1].split("\n")
    for no, line in enumerate(lines, 1):
        if "\t" in line:
            raise MdError(no, "탭은 쓰지 않아요")
        if line != line.rstrip():
            raise MdError(no, "줄 끝 빈칸은 쓰지 않아요(git diff --check)")
        if any(d in line for d in DASHES):
            raise MdError(no, "줄표(U+2014/U+2013)는 쓰지 않아요")
    if lines and lines[-1] == "":
        raise MdError(len(lines), "파일 끝 빈 줄은 쓰지 않아요")
    front, first = parse_front(lines)
    ctx = DocCtx(lang, strings)
    body, ids, statuses = parse_body(lines, first, ctx)
    return {"front": front, "body": body, "ids": ids, "statuses": statuses, "links": ctx.links}


def load_doc_strings(docs_src):
    strings = load_json(docs_src / "strings.json")
    if sorted(strings) != sorted(DOCS_LANGS):
        fail(f"{docs_src / 'strings.json'}: 언어는 {', '.join(DOCS_LANGS)} 이어야 해요")
    every = set()
    for cat in strings.values():
        every |= set(cat)
    problems = []
    for lang, cat in strings.items():
        lack = sorted(every - set(cat))
        if lack:
            problems.append(f"{lang}: 빠진 키 {', '.join(lack)}")
        for key, val in cat.items():
            if not isinstance(val, str) or not val.strip():
                problems.append(f"{lang}.{key}: 빈 값")
            elif any(d in val for d in DASHES):
                problems.append(f"{lang}.{key}: 줄표(U+2014/U+2013)는 쓰지 않아요")
    if problems:
        fail("문서 문구(strings.json)가 맞지 않아요\n  " + "\n  ".join(problems))
    return strings


def load_docs(docs_src, strings):
    pages, problems = {}, []
    for lang in DOCS_LANGS:
        folder = docs_src / lang
        found = sorted(p.stem for p in folder.glob("*.md")) if folder.is_dir() else []
        extra = sorted(set(found) - set(DOCS_PAGES))
        lack = [s for s in DOCS_PAGES if s not in found]
        if extra or lack:
            problems.append(f"docs/{lang}: 쪽은 {', '.join(DOCS_PAGES)} 여섯이에요" + (f" · 없음 {', '.join(lack)}" if lack else "") + (f" · 모르는 쪽 {', '.join(extra)}" if extra else ""))
            continue
        for slug in DOCS_PAGES:
            rel = f"docs/{lang}/{slug}.md"
            try:
                pages[(lang, slug)] = parse_doc((folder / f"{slug}.md").read_text(encoding="utf-8"), lang, strings[lang])
            except MdError as e:
                problems.append(f"{rel}:{e.line}: {e.msg}")
            except (OSError, UnicodeDecodeError) as e:
                problems.append(f"{rel}: 읽지 못했어요: {e}")
    if problems:
        fail("문서 마크다운이 맞지 않아요\n  " + "\n  ".join(problems))
    for (lang, slug), page in pages.items():
        rel = f"docs/{lang}/{slug}.md"
        # 링크가 가리키는 제목 id 가 그 쪽에 있어야 한다
        for line, target, frag in page["links"]:
            ids = pages[(lang, target)]["ids"] if target else page["ids"]
            if frag is not None and frag not in ids:
                problems.append(f"{rel}:{line}: #{frag} 제목이 {target or slug} 쪽에 없어요")
        # 페이지 상태가 done 이면 제목 옆 상태도 모두 done 이다(부분을 됨으로 부풀리지 않는다)
        if page["front"]["status"] == "done" and any(s != "done" for s in page["statuses"]):
            problems.append(f"{rel}: 페이지 상태가 done 인데 제목 옆 상태에 {', '.join(sorted(set(page['statuses']) - {'done'}))} 가 있어요")
    for slug in DOCS_PAGES:
        a, b = pages[("ko", slug)], pages[("en", slug)]
        for key in ("status", "checked"):
            if a["front"][key] != b["front"][key]:
                problems.append(f"docs/*/{slug}.md: ko·en 의 {key} 가 달라요({a['front'][key]} · {b['front'][key]})")
        if sorted(a["front"]["sources"]) != sorted(b["front"]["sources"]):
            problems.append(f"docs/*/{slug}.md: ko·en 의 출처가 달라요")
        if a["statuses"] != b["statuses"]:
            problems.append(f"docs/*/{slug}.md: ko·en 의 제목 옆 상태 순서가 달라요({a['statuses']} · {b['statuses']})")
    if problems:
        fail("문서가 맞지 않아요\n  " + "\n  ".join(problems))
    return pages


def docs_href(lang, slug):
    return f"/docs/{lang}/" if slug == "overview" else f"/docs/{lang}/{slug}/"


def docs_root_redirect():
    # /docs/ 에서만 돈다: 고른 언어가 ko 면 → 아니면 고른 언어가 없을 때 브라우저 언어의 첫 지원 언어가 ko 면 → /docs/ko/
    langs = json.dumps(LANGS)
    return (
        "<script>(function(){var L=" + langs + ",s=null;"
        "try{s=localStorage.getItem(\"" + STORE_KEY + "\")}catch(e){}"
        "if(L.indexOf(s)<0){s=null;var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||\"\"];"
        "for(var i=0;i<n.length&&!s;i++){var x=String(n[i]).toLowerCase().split(\"-\")[0];"
        "if(x==\"zh\"||L.indexOf(x)>=0)s=x}}"
        "if(s==\"ko\")location.replace(\"/docs/ko/\"+location.hash)})();</script>"
    )


def render_doc(lang, slug, is_root, template, pages, strings, cats, values, parts):
    d, t = strings[lang], cats[lang]
    page = pages[(lang, slug)]
    front = page["front"]
    host = values["SITE_HOST"]
    hreflang = [f'<link rel="alternate" hreflang="{code}" href="https://{host}{docs_href(code, slug)}">' for code in DOCS_LANGS]
    x_default = "/docs/" if slug == "overview" else docs_href(DOCS_ROOT_LANG, slug)
    hreflang.append(f'<link rel="alternate" hreflang="x-default" href="https://{host}{x_default}">')
    langs, foot = [], []
    for code in DOCS_LANGS:
        cur = ' aria-current="page"' if code == lang else ""
        name = esc(cats[code]["lang_name"])
        attrs = f'href="{docs_href(code, slug)}" hreflang="{code}" lang="{code}" data-lang="{code}"{cur}'
        langs.append(f'        <li><a {attrs}>{name}<svg class="i tick" aria-hidden="true"><use href="#i-check"/></svg></a></li>')
        foot.append(f"    <a {attrs}>{name}</a>")
    side = []
    for s in DOCS_PAGES:
        cur = ' aria-current="page"' if s == slug else ""
        side.append(f'      <li><a href="{docs_href(lang, s)}"{cur}>{esc(pages[(lang, s)]["front"]["title"])}</a></li>')
    at = DOCS_PAGES.index(slug)
    pager = []
    if at > 0:
        prev = DOCS_PAGES[at - 1]
        pager.append(f'<a class="pager-prev" href="{docs_href(lang, prev)}" rel="prev"><span>{esc(d["prev"])}</span><b>{esc(pages[(lang, prev)]["front"]["title"])}</b></a>')
    if at < len(DOCS_PAGES) - 1:
        nxt = DOCS_PAGES[at + 1]
        pager.append(f'<a class="pager-next" href="{docs_href(lang, nxt)}" rel="next"><span>{esc(d["next"])}</span><b>{esc(pages[(lang, nxt)]["front"]["title"])}</b></a>')
    sources = []
    for src in front["sources"]:
        kind = "tree" if (REPO / src).is_dir() else "blob"
        sources.append(f'<li><a href="{REPO_WEB}/{kind}/{REPO_BRANCH}/{esc(src)}"><code>{esc(src)}</code></a></li>')
    title = esc(front["title"])
    fills = {
        "{{lang}}": lang,
        "{{page_title}}": f"{title} · {esc(d['site_title'])}",
        "{{description}}": esc(front["description"]),
        "{{hreflang}}": "\n".join(hreflang),
        "{{root_redirect}}": docs_root_redirect() if is_root else "",
        "{{lang_items}}": "\n".join(langs),
        "{{foot_langs}}": "\n".join(foot),
        "{{side_items}}": "\n".join(side),
        "{{brand_href}}": f"/{lang}/",
        "{{docs_home}}": docs_href(lang, "overview"),
        "{{doc_title}}": title,
        "{{doc_status}}": status_badge(front["status"], d, hidden_label=False),
        "{{doc_checked}}": f'<time datetime="{front["checked"]}">{front["checked"]}</time>',
        "{{doc_sources_count}}": esc(d["sources_count"].replace("{n}", str(len(front["sources"])))),
        "{{doc_sources}}": "\n".join(sources),
        "{{doc_pager}}": "\n".join(pager),
        "{{slug}}": slug,
        "{{css}}": parts["docs_css"],
        "{{js}}": parts["js"],
    }
    html = template
    for k, v in fills.items():
        html = html.replace(k, v)
    html = re.sub(r"\{\{t\.([a-z0-9_]+)\}\}", lambda m: esc(t[m.group(1)]) if m.group(1) in t else m.group(0), html)
    html = re.sub(r"\{\{d\.([a-z0-9_]+)\}\}", lambda m: esc(d[m.group(1)]) if m.group(1) in d else m.group(0), html)
    html = re.sub(r"\{\{v\.([A-Z0-9_]+)\}\}", lambda m: esc(values[m.group(1)]) if m.group(1) in values else m.group(0), html)
    left = sorted(set(re.findall(r"\{\{[^{}]*\}\}", html)) - {"{{doc_body}}"})
    if left:
        fail(f"docs/{lang}/{slug}: 채우지 못한 자리 {', '.join(left)}")
    # 본문은 마지막에 넣는다(코드 블록 안의 {{…}} 글자를 틀 자리로 읽지 않게)
    return html.replace("{{doc_body}}", page["body"])


def build_docs(out, docs_src, cats, values, parts):
    strings = load_doc_strings(docs_src)
    pages = load_docs(docs_src, strings)
    template = (HERE / "src" / "docs.html").read_text(encoding="utf-8")
    written = []
    targets = [(DOCS_ROOT_LANG, "overview", True, out / "docs" / "index.html")]
    for lang in DOCS_LANGS:
        for slug in DOCS_PAGES:
            path = out / "docs" / lang / ("index.html" if slug == "overview" else f"{slug}/index.html")
            targets.append((lang, slug, False, path))
    for lang, slug, is_root, path in targets:
        html = render_doc(lang, slug, is_root, template, pages, strings, cats, values, parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        written.append(path)
    return written


def main(argv):
    out = HERE / "dist"
    if "--out" in argv:
        out = Path(argv[argv.index("--out") + 1]).resolve()
    docs_src = HERE / "docs"
    if "--docs-src" in argv:
        docs_src = Path(argv[argv.index("--docs-src") + 1]).resolve()
    values = load_values()
    template = (HERE / "src" / "index.html").read_text(encoding="utf-8")
    cats = load_catalogs(template)
    shot_size = load_json(HERE / "assets" / "app-shots.json")
    site_css = strip_css((HERE / "src" / "site.css").read_text(encoding="utf-8"))
    parts = {
        "css": site_css,
        "docs_css": site_css + "\n" + strip_css((HERE / "src" / "docs.css").read_text(encoding="utf-8")),
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
    # M7-S 전까지 팀 한정: 검색 엔진은 모든 경로를 읽지 않는다(페이지마다 noindex 도 있다).
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")

    pages = [(ROOT_LANG, True, out / "index.html")] + [(lang, False, out / lang / "index.html") for lang in LANGS]
    report = []
    for lang, is_root, path in pages:
        html = render(lang, is_root, template, cats, values, parts, shot_size)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        report.append((path.relative_to(out).as_posix(), len(html.encode("utf-8"))))
    doc_paths = build_docs(out, docs_src, cats, values, parts)
    report += [(p.relative_to(out).as_posix(), p.stat().st_size) for p in doc_paths]
    broken = []
    for path in [p for _, _, p in pages] + doc_paths:
        broken += [f"{path.relative_to(out).as_posix()} -> {r}" for r in check_refs(out, path, path.read_text(encoding="utf-8"))]
    if broken:
        fail("결과 폴더에 없는 파일을 가리켜요\n  " + "\n  ".join(sorted(set(broken))))

    script_bytes = len(parts["js"].encode("utf-8")) + len(parts["sky"].encode("utf-8"))
    asset_bytes = sum(p.stat().st_size for p in (out / "assets").rglob("*") if p.is_file())
    print(f"build.py: {len(pages)} pages + {len(doc_paths)} docs pages -> {out}")
    for name, size in report:
        print(f"  {name:<30} {size:>7} B")
    print(f"  inline script (site.js + sky.js) {script_bytes} B · css {len(parts['css'].encode('utf-8'))} B · docs css {len(parts['docs_css'].encode('utf-8'))} B · assets {asset_bytes} B")


if __name__ == "__main__":
    main(sys.argv[1:])
