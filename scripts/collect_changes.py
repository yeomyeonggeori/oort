#!/usr/bin/env python3
"""업데이트(승격)마다 바뀐 점 모으기 (#5053).

두 트랙(`track/engine`·`track/uxui`)에서 기준 커밋 뒤에 합쳐진 PR을 모아 PR 본문의 **요약 칸**을 읽고
Markdown 초안 한 파일을 만든다.

  1. CHANGELOG `[Unreleased]` 영어 줄 초안
  2. 사용자에게 보이는 변화 후보 (주제별, 한국어)
  3. 요약 없는 PR 목록 (경고일 뿐 막지 않는다)

영어 문장은 이 도구가 만들 수 없다(번역이 아니라 결정적 도구라서). 줄 틀(구역·화면 접두사·이슈 번호)과 한국어
원문을 두고 `[en 번역 필요]` 표지를 붙인다. 요약이 이미 영어면 그대로 쓴다.

PR 목록은 git에서(트랙의 첫째 부모 줄에 있는 `Merge pull request #N from …` 합치기), 본문은 `gh`로 받는다.
네트워크는 `gh`뿐이다. 이 도구는 `git fetch`를 하지 않는다 — 끝 ref가 없으면 먼저 `git fetch origin`을 한다.

요약 칸은 두 모양을 읽는다.
  * `## 요약`(제목 1~6단계) — 같거나 높은 단계의 다음 제목까지
  * `**요약**`(줄 머리의 굵은 글씨, 뒤에 `:`·`—`로 같은 줄 내용이 이어져도 된다) — 다음 제목·다음 굵은 칸 이름·`---`까지
`**요약에 더할 것**`은 요약 뒤에 이어 붙인다. PR 템플릿의 안내 주석(`<!-- … -->`)은 먼저 지운다 — 제목만
있고 내용이 비어 있으면 요약이 없는 것이다. 요약 없이 「N/A — 이유」·「사용자에게 보이는 변화 없음」만 적은 PR은
경고하지 않고 따로 센다.

사용:
  scripts/collect_changes.py --since <지난 승격의 main 커밋> --output <결과 파일>
  scripts/collect_changes.py --since-engine <이전 핀> --since-uxui <이전 핀> \\
      --engine-head <새 핀> --uxui-head <새 핀> --output <결과 파일>
  <본문> | scripts/collect_changes.py --check-summary      (goal_release.sh가 쓴다)

종료 코드: 0 정상 · 1 PR 본문을 가져오지 못한 것이 있음(파일은 쓴다) · 2 사용 오류·ref 없음
`--check-summary`: 0 요약 있음(또는 N/A) · 3 요약 없음.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Set, Tuple

DEFAULT_REPO = "yeomyeonggeori/oort"
TRACKS = ("engine", "uxui")
GH_FIELDS = "number,title,body,url,mergedAt,baseRefName,headRefName,labels,closingIssuesReferences"
EN_MARKER = "[en 번역 필요]"
MAX_PRS_DEFAULT = 600


class ToolError(Exception):
    """사용 오류·ref 없음처럼 사람이 고쳐야 하는 문제(종료 코드 2)."""


# ---------------------------------------------------------------------------
# 1. 요약 칸 읽기
# ---------------------------------------------------------------------------

_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
# 제목은 `#` 뒤에 공백이 있어야 한다. `#4985 후속…`처럼 이슈 번호로 시작하는 줄은 제목이 아니다.
_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+\S")
_SUMMARY_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+요약[ \t]*(?:[(（][^)）]*[)）])?[ \t]*[:：]?[ \t]*$")
_BOLD_LABEL_RE = re.compile(r"^[ \t]{0,3}\*\*(?P<label>[^*\n]{1,60}?)\*\*(?P<after>.*)$")
_LABEL_SEP_RE = re.compile(r"^[ \t]*(?:[:：—–·|]|-(?=[ \t]))[ \t]*")
_HR_RE = re.compile(r"^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$")
_ADDENDUM_LABEL_RE = re.compile(r"요약에[ \t]*(?:더할|덧붙일|추가할)[ \t]*것")
_NONE_RE = re.compile(
    r"^(?:N/?A|해당[ \t]*없음|없음|변화[ \t]*없음"
    r"|사용자(?:에게)?[ \t]*(?:보이는[ \t]*)?(?:변화|영향)[ \t]*(?:은|는|이|가)?[ \t]*없(?:음|어요|습니다))"
    r"(?![0-9A-Za-z가-힣])",
    re.I,
)
NONE_MAX_CHARS = 160
_PLACEHOLDER_WORDS = {"tbd", "todo", "미작성", "작성예정", "추후작성", "작성중"}


@dataclass
class Summary:
    """kind: text(요약 있음) · none(N/A를 적음) · missing(없음 또는 비어 있음)."""

    kind: str
    shape: str = ""  # heading · bold (kind가 missing이면 빈 문자열)
    text: str = ""
    empty_marker: bool = False  # missing인데 요약 칸 표지는 있었다(내용이 비었다)


def _parse_bold_label(line: str) -> Optional[Tuple[str, str]]:
    """줄 머리의 `**이름**` 칸 이름이면 (이름, 같은 줄에 이어진 내용). 문장 속 강조는 칸 이름이 아니다."""
    m = _BOLD_LABEL_RE.match(line)
    if not m:
        return None
    after = m.group("after")
    sep = _LABEL_SEP_RE.match(after)
    rest = after[sep.end():] if sep else after
    if after.strip() and not sep and not after.strip().startswith(("(", "（")):
        return None
    label = m.group("label").strip().rstrip(":：").strip()
    return label, rest.strip()


def _is_summary_label(label: str) -> bool:
    return label == "요약"


def _is_addendum_label(label: str) -> bool:
    return bool(_ADDENDUM_LABEL_RE.fullmatch(label))


def _clean_block(lines: Sequence[str]) -> str:
    text = "\n".join(line.rstrip() for line in lines).strip()
    squeezed = re.sub(r"[\s\-–—_.…*•·`]+", "", text)
    if squeezed == "" or squeezed.lower() in _PLACEHOLDER_WORDS:
        return ""
    return text


def _heading_block_ends(line: str, level: int) -> bool:
    heading = _HEADING_RE.match(line)
    if heading and len(heading.group(1)) <= level:
        return True
    return bool(_HR_RE.match(line)) or _parse_bold_label(line) is not None


def _bold_block_ends(line: str) -> bool:
    return bool(_HEADING_RE.match(line)) or bool(_HR_RE.match(line)) or _parse_bold_label(line) is not None


def _first_line(text: str) -> str:
    first = text.strip().split("\n", 1)[0]
    first = re.sub(r"^[ \t]*(?:[-*+•][ \t]+)?", "", first)
    return first.strip().strip("*").strip()


def is_none_sentinel(text: str) -> bool:
    """전체가 짧고 첫 줄이 「N/A」·「해당 없음」·「사용자에게 보이는 변화 없음」으로 시작할 때만."""
    return len(text.strip()) <= NONE_MAX_CHARS and bool(_NONE_RE.match(_first_line(text)))


def extract_summary(body: Optional[str]) -> Summary:
    text = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    text = _COMMENT_RE.sub("", text)  # 템플릿 안내 주석만 남은 칸은 비어 있는 칸이다
    lines = text.split("\n")
    blocks: List[Tuple[str, str, str]] = []  # (main|addendum, shape, cleaned text)
    i = 0
    while i < len(lines):
        line = lines[i]
        head = _SUMMARY_HEADING_RE.match(line)
        if head:
            level = len(head.group(1))
            j = i + 1
            while j < len(lines) and not _heading_block_ends(lines[j], level):
                j += 1
            blocks.append(("main", "heading", _clean_block(lines[i + 1:j])))
            i = j
            continue
        label = _parse_bold_label(line)
        if label and (_is_summary_label(label[0]) or _is_addendum_label(label[0])):
            j = i + 1
            while j < len(lines) and not _bold_block_ends(lines[j]):
                j += 1
            content = ([label[1]] if label[1] else []) + lines[i + 1:j]
            kind = "main" if _is_summary_label(label[0]) else "addendum"
            blocks.append((kind, "bold", _clean_block(content)))
            i = j
            continue
        i += 1
    primary = next(((shape, t) for kind, shape, t in blocks if kind == "main" and t), None)
    addenda = [t for kind, _shape, t in blocks if kind == "addendum" and t]
    if primary is None and not addenda:
        return Summary(kind="missing", empty_marker=bool(blocks))
    parts = ([primary[1]] if primary else []) + addenda
    full = "\n".join(parts)
    shape = primary[0] if primary else "bold"
    return Summary(kind="none" if is_none_sentinel(full) else "text", shape=shape, text=full)


# ---------------------------------------------------------------------------
# 2. PR 제목·화면·구역·주제
# ---------------------------------------------------------------------------

_TITLE_RE = re.compile(
    r"^(?P<type>[A-Za-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?[ \t]*:[ \t]*(?P<subject>.+)$"
)
_TRAILING_REFS_RE = re.compile(r"[ \t]*\(#(?P<nums>\d+(?:[ \t]*[,·][ \t]*#?\d+)*)\)[ \t]*$")
_BODY_REFS_RE = re.compile(r"(?im)^[ \t]*(?:Closes|Closing|Fixes|Resolves|Refs?)[ \t]+#(\d+)")
_HANGUL_RE = re.compile(r"[ㄱ-ㆎ가-힣]")
INTERNAL_TYPES = {"test", "ci", "build", "chore", "style", "refactor"}

_SCOPE_SURFACE = {
    "phone": "phone", "mobile": "phone", "ios": "phone",
    "web": "web", "desktop": "desktop", "tauri": "desktop",
    "core": "shared",
    "engine": "server", "server": "server", "api": "server", "push": "server", "hermes": "server",
    "unfurl": "server", "infra": "server", "relay": "server", "notifier": "server", "worker": "server",
    "db": "server", "rust": "server", "agent": "server",
}
_SURFACE_TAG = {"phone": "폰", "web": "웹", "desktop": "데스크탑", "shared": "코어", "server": "서버"}
_SURFACE_ORDER = ("phone", "web", "desktop", "shared", "server")

CHANGELOG_SECTIONS = ("Added", "Changed", "Fixed", "Security", "Docs")

# 주제는 제목·요약 첫 줄의 낱말로 고르는 **후보**다. 먼저 맞는 규칙이 이긴다(제목 → 요약 첫 줄 순; 요약 전체는
# 안 본다 — 본문 끝의 곁다리 낱말에 끌려가는 것이 실측에서 나왔다). 맞는 것이 없으면 「기타」.
# 맞지 않는 주제는 사람이 옮긴다 — 이 표만 고치면 된다.
TOPIC_RULES: Tuple[Tuple[str, str], ...] = (
    ("AI 도우미·에이전트", r"에이전트|도우미|agent|hermes|헤르메스|byok|\bAI\b|\bMCP\b"),
    ("승인·결정 카드", r"승인|결정|거부|approval"),
    ("알림·푸시", r"알림|푸시|\bpush\b|notification|방해 금지"),
    ("이모지·스티커·GIF", r"이모지|이모티콘|스티커|\bGIF\b|emoji|sticker|표현"),
    ("대화·스레드·입력", r"스레드|답글|입력창|입력 ?칸|composer|메시지|대화|멘션|링크 카드|링크 미리보기|반응|\bDM\b|읽음|작성 중"),
    ("사진·파일·첨부", r"사진|첨부|파일|이미지|드라이브|attachment|\bPDF\b"),
    ("온보딩·초대·계정", r"온보딩|초대|가입|로그인|계정|프로필|onboarding|invite"),
    ("설정·테마·언어", r"설정|테마|언어|다국어|i18n|접근성|햅틱|글자 크기"),
    ("보안·권한", r"보안|권한|\bRLS\b|암호|토큰|security"),
    ("운영·배포·셀프호스트", r"배포|셀프호스트|compose|railway|migration|마이그레이션|docker|릴리스"),
)
TOPIC_OTHER = "기타"
_TOPIC_RES = tuple((name, re.compile(pattern, re.I)) for name, pattern in TOPIC_RULES)


@dataclass
class ParsedTitle:
    type: str  # 소문자. 관례 제목이 아니면 빈 문자열
    scopes: List[str]
    subject: str  # 끝의 `(#이슈)`를 뗀 제목 본문
    issue_refs: List[int]


def parse_title(title: str) -> ParsedTitle:
    title = title.strip()
    m = _TITLE_RE.match(title)
    ptype, scopes, rest = "", [], title
    if m:
        ptype = m.group("type").lower()
        scopes = [s for s in re.split(r"[,/+&\s]+", (m.group("scope") or "").lower()) if s]
        rest = m.group("subject").strip()
    refs: List[int] = []
    t = _TRAILING_REFS_RE.search(rest)
    if t:
        refs = [int(n) for n in re.findall(r"\d+", t.group("nums"))]
        rest = rest[:t.start()].rstrip()
    return ParsedTitle(type=ptype, scopes=scopes, subject=rest, issue_refs=refs)


def surfaces_of(scopes: Sequence[str]) -> Set[str]:
    return {_SCOPE_SURFACE[s] for s in scopes if s in _SCOPE_SURFACE}


def surface_prefix(surfaces: Set[str]) -> str:
    """CHANGELOG가 쓰는 접두사: Phone · Web and desktop · Phone, web and desktop · Server …"""
    clients = set()
    if "phone" in surfaces or "shared" in surfaces:
        clients.add("phone")
    if "web" in surfaces or "shared" in surfaces:
        clients.update({"web", "desktop"})  # 웹 화면은 데스크탑 셸 안에서도 돈다
    if "desktop" in surfaces:
        clients.add("desktop")
    names = (["Server"] if "server" in surfaces else []) + [c for c in ("phone", "web", "desktop") if c in clients]
    if not names:
        return "Other"
    names = [names[0]] + [n.lower() for n in names[1:]]
    names[0] = names[0][0].upper() + names[0][1:]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def changelog_section(parsed: ParsedTitle) -> str:
    """Added·Changed·Fixed·Security·Docs, 또는 CHANGELOG에 싣지 않을 가능성이 큰 「내부」."""
    if parsed.type == "docs":
        return "Docs"
    if {"security", "sec"} & set(parsed.scopes):
        return "Security"
    if parsed.type == "feat":
        return "Added"
    if parsed.type == "fix":
        return "Fixed"
    if parsed.type in INTERNAL_TYPES:
        return "내부"
    return "Changed"


def exclusion_reason(parsed: ParsedTitle, head_ref: str) -> str:
    """일을 담지 않은 PR(트랙 동기화·승격·릴리스 기록)이면 이유, 아니면 빈 문자열."""
    if parsed.type == "sync" or head_ref.startswith("sync/"):
        return "트랙 동기화(main → 트랙)"
    if head_ref.startswith("track/"):
        return "트랙 합치기·승격 PR(head가 track/…)"
    if head_ref.startswith("chore/release-") or (parsed.type == "chore" and "release" in parsed.scopes):
        return "릴리스 기록"
    return ""


def pick_topic(subject: str, summary_text: str) -> str:
    for source in (subject, _first_line(summary_text)):
        for name, regex in _TOPIC_RES:
            if source and regex.search(source):
                return name
    return TOPIC_OTHER


def first_unit(text: str, limit: int = 220) -> str:
    """요약의 첫 줄(목록 기호를 뗀 것). 길면 문장 끝에서, 없으면 `…`로 자른다."""
    line = _first_line(text)
    if len(line) <= limit:
        return line
    window = line[:limit]
    ends = [window.rfind(mark) for mark in ("요.", "다.", ". ", "! ", "? ", "。")]
    cut = max(ends)
    if cut >= 60:
        return window[:cut + (2 if window[cut:cut + 2] in ("요.", "다.") else 1)].rstrip()
    return window.rstrip() + "…"


# ---------------------------------------------------------------------------
# 3. git에서 PR 목록, gh에서 본문
# ---------------------------------------------------------------------------

_MERGE_SUBJECT_RE = re.compile(r"^Merge pull request #(?P<num>\d+) from (?P<head>\S+)")


@dataclass
class Landing:
    number: int
    track: str
    head_ref: str  # 합치기 제목의 `org/branch`에서 org/를 뗀 것
    merge_sha: str


def _git(repo_dir: str, *args: str) -> str:
    proc = subprocess.run(["git", "-C", repo_dir, *args], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise ToolError("git %s 실패: %s" % (" ".join(args[:2]), (proc.stderr or proc.stdout).strip()[-200:]))
    return proc.stdout


def resolve_commit(repo_dir: str, rev: str, what: str) -> str:
    proc = subprocess.run(
        ["git", "-C", repo_dir, "rev-parse", "--verify", "--quiet", rev + "^{commit}"],
        capture_output=True, text=True, check=False,
    )
    sha = proc.stdout.strip()
    if proc.returncode != 0 or not sha:
        hint = " — `git fetch origin`을 먼저 해요(이 도구는 fetch하지 않아요)" if rev.startswith("origin/") else ""
        raise ToolError("%s `%s`를 찾지 못했어요%s" % (what, rev, hint))
    return sha


def landed_merges(repo_dir: str, track: str, since_sha: str, head_sha: str) -> Tuple[List[Landing], List[Tuple[str, str]]]:
    """기준 커밋의 조상이 아닌, 끝 커밋의 **첫째 부모 줄** 커밋들(오래된 것부터).

    기준의 조상은 모든 부모를 따라 계산한다(승격이 트랙을 합친 위상에서도 옛 PR이 새지 않게). 첫째 부모 줄에서
    기준의 조상을 처음 만나면 그 뒤는 모두 조상이라 멈춘다. `Merge pull request #N`이 아닌 커밋은 둘째 값으로 돌려준다.
    """
    ancestors = set(_git(repo_dir, "rev-list", since_sha).split())
    merges: List[Landing] = []
    others: List[Tuple[str, str]] = []
    for line in _git(repo_dir, "log", "--first-parent", "--format=%H%x1f%s", head_sha).splitlines():
        sha, subject = line.split("\x1f", 1)
        if sha in ancestors:
            break
        m = _MERGE_SUBJECT_RE.match(subject)
        if m:
            head = m.group("head")
            merges.append(Landing(int(m.group("num")), track, head.split("/", 1)[1] if "/" in head else head, sha))
        else:
            others.append((sha[:9], subject))
    merges.reverse()
    others.reverse()
    return merges, others


def fetch_prs(gh: str, repo: str, numbers: Sequence[int], jobs: int) -> Tuple[Dict[int, dict], Dict[int, str]]:
    """PR 하나씩 `gh pr view`. 한 번 더 시도하고도 못 받으면 이유와 함께 실패로 돌려준다(조용히 빼지 않는다)."""

    def one(number: int) -> Tuple[int, Optional[dict], str]:
        problem = ""
        for _attempt in range(2):
            try:
                proc = subprocess.run(
                    [gh, "pr", "view", str(number), "--repo", repo, "--json", GH_FIELDS],
                    capture_output=True, text=True, check=False, timeout=120,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                problem = "gh 실행 실패: %s" % exc
                continue
            if proc.returncode != 0:
                problem = ((proc.stderr or proc.stdout).strip().splitlines() or ["gh 실패"])[-1][:160]
                continue
            try:
                data = json.loads(proc.stdout)
            except ValueError as exc:
                problem = "JSON을 읽지 못했어요: %s" % exc
                continue
            if isinstance(data, dict):
                return number, data, ""
            problem = "JSON이 객체가 아니에요"
        return number, None, problem

    found: Dict[int, dict] = {}
    failed: Dict[int, str] = {}
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        for number, data, problem in pool.map(one, numbers):
            if data is None:
                failed[number] = problem
            else:
                found[number] = data
    return found, failed


# ---------------------------------------------------------------------------
# 4. 기록과 보고서
# ---------------------------------------------------------------------------


@dataclass
class Record:
    number: int
    track: str
    title: str
    url: str
    merged_at: str
    head_ref: str
    parsed: ParsedTitle
    summary: Summary
    issue_refs: List[int]
    excluded: str = ""

    @property
    def section(self) -> str:
        return changelog_section(self.parsed)

    @property
    def tag(self) -> str:
        names = [_SURFACE_TAG[s] for s in _SURFACE_ORDER if s in surfaces_of(self.parsed.scopes)]
        return "·".join(names) if names else "화면 미정"


def build_record(landing: Landing, data: dict) -> Record:
    title = str(data.get("title") or "")
    parsed = parse_title(title)
    body = str(data.get("body") or "")
    refs = list(parsed.issue_refs)
    for item in data.get("closingIssuesReferences") or []:
        number = item.get("number") if isinstance(item, dict) else None
        if isinstance(number, int):
            refs.append(number)
    refs += [int(n) for n in _BODY_REFS_RE.findall(body)]
    ordered = list(dict.fromkeys(refs))
    head_ref = str(data.get("headRefName") or landing.head_ref)
    return Record(
        number=landing.number,
        track=landing.track,
        title=title,
        url=str(data.get("url") or ""),
        merged_at=str(data.get("mergedAt") or ""),
        head_ref=head_ref,
        parsed=parsed,
        summary=extract_summary(body),
        issue_refs=ordered,
        excluded=exclusion_reason(parsed, head_ref),
    )


@dataclass
class TrackRun:
    track: str
    since: str
    head: str
    since_sha: str
    head_sha: str
    landings: List[Landing] = field(default_factory=list)
    others: List[Tuple[str, str]] = field(default_factory=list)


def _order_key(rec: Record) -> Tuple[str, int]:
    return (rec.merged_at, rec.number)


def _refs_text(rec: Record) -> str:
    return ", ".join("#%d" % n for n in rec.issue_refs[:4]) or "PR #%d" % rec.number


def draft_line(rec: Record) -> str:
    seed = first_unit(rec.summary.text)
    marker = EN_MARKER + " " if _HANGUL_RE.search(seed) else ""
    if rec.section == "Docs":  # 기존 CHANGELOG의 Docs 칸은 화면 접두사 없이 쓴다
        return "- %s%s (%s) <!-- PR #%d -->" % (marker, seed, _refs_text(rec), rec.number)
    prefix = surface_prefix(surfaces_of(rec.parsed.scopes))
    return "- %s: %s%s (%s) <!-- PR #%d -->" % (prefix, marker, seed, _refs_text(rec), rec.number)


def classify(records: Sequence[Record]) -> Dict[str, List[Record]]:
    groups: Dict[str, List[Record]] = {"excluded": [], "text": [], "none": [], "missing": []}
    for rec in sorted(records, key=_order_key):
        key = "excluded" if rec.excluded else rec.summary.kind
        groups[key].append(rec)
    return groups


def render_report(runs: Sequence[TrackRun], records: Sequence[Record], failed: Dict[int, str],
                  repo: str, now: Optional[datetime] = None) -> str:
    groups = classify(records)
    total = sum(len(r.landings) for r in runs)
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    shapes = {"heading": 0, "bold": 0}
    for rec in groups["text"] + groups["none"]:
        shapes[rec.summary.shape] = shapes.get(rec.summary.shape, 0) + 1
    out: List[str] = []
    add = out.append

    add("# 바뀐 점 수집 초안 (#5053)")
    add("")
    add("> `scripts/collect_changes.py`가 만든 **초안**이에요. 저장소에 커밋하지 않아요. 영어 줄은 번역이 필요하고"
        "(`%s`) 주제는 낱말로 고른 후보라서, 맞지 않으면 사람이 옮겨요." % EN_MARKER)
    add("")
    add("## 수집 조건")
    add("- 생성: %s · 저장소 `%s`" % (stamp, repo))
    for run in runs:
        add("- %s: 기준 `%s`(`%s`) → 끝 `%s`(`%s`) · 첫째 부모 합치기 %d건%s" % (
            run.track, run.since, run.since_sha[:9], run.head, run.head_sha[:9], len(run.landings),
            (" · PR 번호 없는 커밋 %d건" % len(run.others)) if run.others else ""))
    add("- 건수 검산: **%d** = 요약 있음 %d + 변화 없음 명시 %d + 요약 없음 %d + 수집에서 뺌 %d + 가져오지 못함 %d" % (
        total, len(groups["text"]), len(groups["none"]), len(groups["missing"]), len(groups["excluded"]), len(failed)))
    add("- 요약 칸 모양: 제목형(`## 요약`) %d · 굵은 글씨형(`**요약**`) %d" % (shapes["heading"], shapes["bold"]))
    add("- 목록의 (engine)·(uxui)는 PR이 합쳐진 트랙이에요(제목의 화면 범위와 다를 수 있어요).")
    add("- 영어 줄 구역·접두사는 제목 `type(scope):`에서 정한 규칙이에요: feat→Added · fix→Fixed · docs→Docs · "
        "`security` 범위→Security · 그 밖→Changed · test/ci/build/chore/style/refactor→내부. "
        "phone→Phone · web→Web and desktop · core→Phone, web and desktop · engine/server/push/hermes 등→Server.")
    add("")

    add("## 1. CHANGELOG `[Unreleased]` 영어 줄 초안")
    add("")
    add("한국어 원문을 줄 안에 두었어요. 영어로 옮겨 쓴 뒤 `%s` 표지와 `<!-- PR -->` 주석은 지워요(영어 요약은 그대로 들어와요)." % EN_MARKER)
    add("")
    by_section: Dict[str, List[Record]] = {}
    for rec in groups["text"]:
        by_section.setdefault(rec.section, []).append(rec)
    for name in CHANGELOG_SECTIONS:
        recs = by_section.get(name, [])
        if recs:
            add("### %s" % name)
            out.extend(draft_line(rec) for rec in recs)
            add("")
    internal = by_section.get("내부", [])
    if internal:
        add("### (내부) CHANGELOG에 싣지 않을 가능성이 큰 PR — 요약이 있는 것만")
        for rec in internal:
            add("- %s: %s — %s (PR #%d)" % (rec.parsed.type, rec.parsed.subject, first_unit(rec.summary.text, 120), rec.number))
        add("")
    if not by_section:
        add("(요약이 있는 PR이 없어요.)")
        add("")

    add("## 2. 사용자에게 보이는 변화 후보 — 주제별")
    add("")
    add("글·테스트·CI·chore 같은 내부 PR은 뺐어요. 서버만 바뀐 것은 `[서버]`로 표시해요.")
    add("")
    by_topic: Dict[str, List[Record]] = {}
    for rec in groups["text"]:
        if rec.section in ("내부", "Docs"):
            continue
        by_topic.setdefault(pick_topic(rec.parsed.subject, rec.summary.text), []).append(rec)
    for name in [n for n, _ in TOPIC_RULES] + [TOPIC_OTHER]:
        recs = by_topic.get(name, [])
        if not recs:
            continue
        add("### %s (%d)" % (name, len(recs)))
        for rec in recs:
            add("- [%s] %s — %s (%s · PR #%d)" % (rec.tag, rec.parsed.subject, first_unit(rec.summary.text, 140), rec.track, rec.number))
        add("")
    if not by_topic:
        add("(후보가 없어요.)")
        add("")

    add("## 3. 요약 없는 PR — 경고(막지 않아요)")
    add("")
    if groups["missing"]:
        add("PR 본문에 `## 요약` 또는 `**요약**` 아래 내용을 채우면 다음 수집에서 사라져요. 바뀐 것이 없으면 「N/A — 이유」를 적어요.")
        add("")
        for rec in groups["missing"]:
            reason = "칸은 있는데 비어 있어요" if rec.summary.empty_marker else "칸이 없어요"
            add("- #%d (%s) `%s` %s — %s — %s" % (rec.number, rec.track, rec.parsed.type or "제목 형식 아님", rec.parsed.subject, reason, rec.url))
    else:
        add("없어요.")
    add("")

    add("## 4. 「N/A」를 적은 PR (경고 아님)")
    add("")
    if groups["none"]:
        for rec in groups["none"]:
            add("- #%d (%s) %s — 「%s」" % (rec.number, rec.track, rec.parsed.subject, first_unit(rec.summary.text, 80)))
    else:
        add("없어요.")
    add("")

    add("## 5. 수집에서 뺀 PR")
    add("")
    if groups["excluded"]:
        for rec in groups["excluded"]:
            add("- #%d (%s) %s — %s" % (rec.number, rec.track, rec.title, rec.excluded))
    else:
        add("없어요.")
    add("")

    problems = bool(failed) or any(r.others for r in runs)
    add("## 6. 점검할 것")
    add("")
    if not problems:
        add("없어요.")
    for number in sorted(failed):
        add("- **가져오지 못한 PR**: #%d — %s" % (number, failed[number]))
    for run in runs:
        for sha, subject in run.others:
            add("- **PR 번호 없는 커밋**(%s 첫째 부모 줄): `%s` %s" % (run.track, sha, subject))
    add("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 5. 명령줄
# ---------------------------------------------------------------------------


def run_check_summary() -> int:
    summary = extract_summary(sys.stdin.read())
    if summary.kind == "missing":
        print("kind=missing empty=%d" % (1 if summary.empty_marker else 0))
        return 3
    print("kind=%s shape=%s" % (summary.kind, summary.shape))
    return 0


def parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="두 트랙에서 기준 커밋 뒤에 합쳐진 PR의 요약 칸을 모아 바뀐 점 초안을 만든다(#5053).")
    p.add_argument("--since", help="두 트랙 공통 기준 커밋(지난 승격의 main 커밋 등)")
    p.add_argument("--since-engine", help="engine만 다른 기준(직전 핀)")
    p.add_argument("--since-uxui", help="uxui만 다른 기준(직전 핀)")
    p.add_argument("--engine-head", default="origin/track/engine", help="engine 끝(기본 origin/track/engine, 핀 SHA도 된다)")
    p.add_argument("--uxui-head", default="origin/track/uxui", help="uxui 끝(기본 origin/track/uxui, 핀 SHA도 된다)")
    p.add_argument("--output", help="결과 Markdown 파일 경로")
    p.add_argument("--repo", default=os.environ.get("ORG_REPO", DEFAULT_REPO), help="ORG/REPO (기본 %s)" % DEFAULT_REPO)
    p.add_argument("--repo-dir", default=".", help="git 저장소 폴더(기본 현재 폴더)")
    p.add_argument("--jobs", type=int, default=6, help="gh를 동시에 부르는 수(기본 6)")
    p.add_argument("--max-prs", type=int, default=MAX_PRS_DEFAULT,
                   help="기준이 너무 멀면 멈추는 상한(기본 %d)" % MAX_PRS_DEFAULT)
    p.add_argument("--check-summary", action="store_true",
                   help="표준입력의 PR 본문에 요약 칸이 있는지만 본다(0 있음 · 3 없음)")
    return p.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if args.check_summary:
        return run_check_summary()
    try:
        if not args.output:
            raise ToolError("--output 파일 경로가 필요해요")
        if not (args.since or (args.since_engine and args.since_uxui)):
            raise ToolError("--since(또는 --since-engine과 --since-uxui 둘 다)가 필요해요")
        gh = shutil.which("gh")
        if not gh:
            raise ToolError("gh가 필요해요(PR 본문을 gh로 받아요)")
        runs: List[TrackRun] = []
        landings: List[Landing] = []
        for track in TRACKS:
            since = getattr(args, "since_" + track) or args.since
            head = getattr(args, track + "_head")
            run = TrackRun(track, since, head,
                           resolve_commit(args.repo_dir, since, "%s 기준" % track),
                           resolve_commit(args.repo_dir, head, "%s 끝" % track))
            run.landings, run.others = landed_merges(args.repo_dir, track, run.since_sha, run.head_sha)
            landings.extend(run.landings)
            runs.append(run)
        if len(landings) > args.max_prs:
            raise ToolError("PR이 %d건이에요(상한 %d). 기준이 너무 먼 것 같아요 — 정말이면 --max-prs를 올려요" % (len(landings), args.max_prs))
        found, failed = fetch_prs(gh, args.repo, [m.number for m in landings], args.jobs)
        records = [build_record(m, found[m.number]) for m in landings if m.number in found]
    except ToolError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    report = render_report(runs, records, failed, args.repo)
    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(report)
    groups = classify(records)
    print("wrote %s: PR %d건 = 요약 있음 %d · N/A %d · 요약 없음 %d · 뺌 %d · 가져오지 못함 %d" % (
        args.output, len(landings), len(groups["text"]), len(groups["none"]), len(groups["missing"]),
        len(groups["excluded"]), len(failed)))
    if groups["missing"]:
        print("warning: 요약 없는 PR %d건 — 파일 3절을 봐요(막지 않아요): %s" % (
            len(groups["missing"]), ", ".join("#%d" % r.number for r in groups["missing"][:12])), file=sys.stderr)
    if failed:
        print("error: PR 본문을 가져오지 못한 것 %d건: %s" % (len(failed), ", ".join("#%d" % n for n in sorted(failed))), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
