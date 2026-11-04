#!/usr/bin/env python3
"""scripts/collect_changes.py 와 scripts/goal_release.sh 의 요약 칸 경고 시험 (#5053).

가짜 PR 본문과 임시 git 저장소, 가짜 `gh`만 쓴다. GitHub·네트워크 없이 돌고 저장소 안 파일을 쓰지 않는다.
실행: python3 scripts/tests/test_collect_changes.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "collect_changes.py"
GOAL_RELEASE = REPO / "scripts" / "goal_release.sh"

_spec = importlib.util.spec_from_file_location("collect_changes", SCRIPT)
cc = importlib.util.module_from_spec(_spec)
sys.modules["collect_changes"] = cc
_spec.loader.exec_module(cc)

# ---- 가짜 PR 본문 (실제 이름·대화 원문 없음) ---------------------------------------------------------------

BOLD_SAME_LINE = "Closes #901 · 등급 0\n\n**요약** — 설정에 「테마」 줄을 더해요. 고르면 바로 바뀌어요.\n\n**검증** — 시험 3개 통과\n"
BOLD_BULLETS = "**요약**\n- 알림 진단 화면을 더해요.\n- 시험 알림은 내 기기에만 가요.\n\n**검증**\n- 시험 12개 통과\n**후속**: 없음\n"
BOLD_COLON = "**요약**: 입력창이 길어져도 잘리지 않아요.\n**검증**: 통과 7개\n"
HEADING = "## 한 일\n내부 설명이에요\n\n## 요약\n스레드 요약 줄이 겹친 얼굴로 바뀌어요.\n\n- 웹은 20px, 폰은 22pt예요.\n\n## 검증\n시험 통과 9개\n"
HEADING_PLUS_BOLD = "### 요약\n**요약**\n- 링크 카드에 상한을 더해요.\n\n**검증**\n통과 5개\n"
TEMPLATE_UNFILLED = "Closes #1\n\n## 요약\n<!-- 사용자·운영자가 알아야 할 변화 1–3줄. 릴리스 노트와 CHANGELOG의 재료다. -->\n\n## 계획 이탈\n없음\n"
BOLD_EMPTY = "**요약**\n\n**검증**\n- 통과\n"
NO_SUMMARY = "Closes #1\n\n## 한 일\n문제와 변경.\n\n## 검증\n통과\n"
ADDENDUM = "**요약**\n- 시험 알림을 더해요.\n\n**보안 검수**\n- 1회차: High 1 → 수리(아래).\n\n**요약에 더할 것**\n- 기기는 최근 5대로 묶어요.\n\n**검증**: 통과\n"
NA_BODY = "**요약**: N/A — 문서만 바뀌었어요.\n\n**검증**: 문서 게이트\n"
ENGLISH_BODY = "**요약**: The composer grows with long text instead of clipping.\n\n**검증**: ok\n"


class ExtractSummaryTests(unittest.TestCase):
    def test_two_shapes_stop_at_the_next_section(self):
        cases = [
            ("bold same line", BOLD_SAME_LINE, "bold", "설정에 「테마」 줄을 더해요. 고르면 바로 바뀌어요."),
            ("bold bullets", BOLD_BULLETS, "bold", "- 알림 진단 화면을 더해요.\n- 시험 알림은 내 기기에만 가요."),
            ("bold colon", BOLD_COLON, "bold", "입력창이 길어져도 잘리지 않아요."),
            ("heading", HEADING, "heading", "스레드 요약 줄이 겹친 얼굴로 바뀌어요.\n\n- 웹은 20px, 폰은 22pt예요."),
            ("heading then bold label", HEADING_PLUS_BOLD, "bold", "- 링크 카드에 상한을 더해요."),
        ]
        for name, body, shape, text in cases:
            with self.subTest(name):
                got = cc.extract_summary(body)
                self.assertEqual((got.kind, got.shape, got.text), ("text", shape, text))

    def test_unfilled_template_and_absent_summary_are_missing(self):
        for name, body, empty in [("template comment only", TEMPLATE_UNFILLED, True), ("bold label with nothing", BOLD_EMPTY, True),
                                  ("no summary block", NO_SUMMARY, False), ("empty body", "", False), ("none body", None, False),
                                  ("placeholder word", "**요약**: TBD\n", True)]:
            with self.subTest(name):
                got = cc.extract_summary(body)
                self.assertEqual((got.kind, got.empty_marker), ("missing", empty))

    def test_addendum_is_appended_but_other_labels_are_not(self):
        got = cc.extract_summary(ADDENDUM)
        self.assertEqual(got.kind, "text")
        self.assertIn("시험 알림을 더해요", got.text)
        self.assertIn("기기는 최근 5대로 묶어요", got.text)
        self.assertNotIn("High 1", got.text)

    def test_na_is_declared_none_only_when_short_and_anchored(self):
        self.assertEqual(cc.extract_summary(NA_BODY).kind, "none")
        self.assertEqual(cc.extract_summary("## 요약\n사용자에게 보이는 변화 없음\n").kind, "none")
        long_text = "N/A — " + "운영자가 알아야 할 설명이 길게 이어져요. " * 8  # 첫머리는 N/A여도 길면 요약이다
        self.assertEqual(cc.extract_summary("**요약**: " + long_text).kind, "text")
        self.assertEqual(cc.extract_summary("**요약**: 없음으로 바뀌는 값이 있어요").kind, "text")


class ClassificationTests(unittest.TestCase):
    def test_title_gives_surface_prefix_section_and_issue_refs(self):
        cases = [
            ("feat(phone): 알림 화면 (#901)", "Phone", "Added", [901]),
            ("fix(web): 줄바꿈", "Web and desktop", "Fixed", []),
            ("feat(core,web,phone): 묶음 카드 (#4882, #4883)", "Phone, web and desktop", "Added", [4882, 4883]),
            ("feat(engine,web): 새 값", "Server, web and desktop", "Added", []),
            ("fix(server): 상한 (#9)", "Server", "Fixed", [9]),
            ("feat(desktop): 창", "Desktop", "Added", []),
            ("perf(web): 빠르게", "Web and desktop", "Changed", []),
            ("feat(engine,security): 막기", "Server", "Security", []),
            ("docs(adr): 기록", "Other", "Docs", []),
            ("chore(i18n): 장부", "Other", "내부", []),
            ("제목 형식이 아닌 PR", "Other", "Changed", []),
        ]
        for title, prefix, section, refs in cases:
            with self.subTest(title):
                parsed = cc.parse_title(title)
                self.assertEqual(cc.surface_prefix(cc.surfaces_of(parsed.scopes)), prefix)
                self.assertEqual(cc.changelog_section(parsed), section)
                self.assertEqual(parsed.issue_refs, refs)

    def test_work_free_prs_are_excluded_with_a_reason(self):
        cases = [
            ("sync: main → track/engine (x)", "sync/main-into-engine", "트랙 동기화"),
            ("feat(x): 제목은 평범해도", "sync/foo", "트랙 동기화"),
            ("chore(release): v9.9.9 발행 기록", "chore/release-999", "릴리스 기록"),
            ("feat(x): 트랙 합치기", "track/uxui", "트랙 합치기"),
            ("feat(phone): 평범한 PR", "feat/1-x", ""),
        ]
        for title, head, reason in cases:
            with self.subTest(title):
                got = cc.exclusion_reason(cc.parse_title(title), head)
                self.assertEqual(got, reason) if reason == "" else self.assertTrue(got.startswith(reason), got)

    def test_topic_reads_the_title_first_then_only_the_first_summary_line(self):
        self.assertEqual(cc.pick_topic("알림 진단 화면", "스티커를 더해요"), "알림·푸시")
        self.assertEqual(cc.pick_topic("작은 개선", "스티커 크기를 바꿔요\n- 알림도 있어요"), "이모지·스티커·GIF")
        self.assertEqual(cc.pick_topic("작은 개선", "첫 줄은 상관없어요\n둘째 줄에 스티커가 나와요"), "기타")
        self.assertEqual(cc.pick_topic("Composer height", ""), "대화·스레드·입력")


# ---- 임시 git 저장소 + 가짜 gh ---------------------------------------------------------------------------

FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
data = os.environ["FAKE_GH_DIR"]
fields = args[args.index("--json") + 1].split(",") if "--json" in args else None


def emit(path):
    doc = json.load(open(path, encoding="utf-8"))
    if fields:  # 진짜 gh처럼 요청한 필드만 돌려준다
        doc = {key: value for key, value in doc.items() if key in fields}
    sys.stdout.write(json.dumps(doc))
    sys.exit(0)


if args[:2] == ["pr", "view"]:
    path = os.path.join(data, "pr-%s.json" % args[2])
    if os.environ.get("FAKE_GH_FLAKY") == args[2]:  # 첫 호출만 실패(일시 오류)
        marker = os.path.join(data, "flaky-%s.seen" % args[2])
        if not os.path.exists(marker):
            open(marker, "w").close()
            sys.stderr.write("HTTP 502: transient\\n")
            sys.exit(1)
    if os.path.exists(path):
        emit(path)
    sys.stderr.write("Could not resolve to a PullRequest with the number of %s.\\n" % args[2])
    sys.exit(1)
if args[:2] == ["issue", "view"]:
    emit(os.path.join(data, "issue.json"))
sys.stderr.write("unexpected gh call: %s\\n" % " ".join(args))
sys.exit(1)
"""


def install_fake_gh(root: Path) -> dict:
    (root / "bin").mkdir()
    (root / "data").mkdir()
    gh = root / "bin" / "gh"
    gh.write_text(FAKE_GH, encoding="utf-8")
    gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
    return dict(os.environ, PATH=str(root / "bin") + os.pathsep + os.environ["PATH"], FAKE_GH_DIR=str(root / "data"))


def git(repo: Path, *args: str) -> str:
    env = dict(os.environ, GIT_AUTHOR_NAME="fixture", GIT_AUTHOR_EMAIL="fixture@oort.invalid",
               GIT_COMMITTER_NAME="fixture", GIT_COMMITTER_EMAIL="fixture@oort.invalid",
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise AssertionError("git %s: %s" % (" ".join(args), proc.stderr))
    return proc.stdout.strip()


def land(repo: Path, track: str, number: int, head: str) -> None:
    """track 가지에 GitHub 합치기 제목 모양의 PR 합치기 하나를 만든다."""
    git(repo, "checkout", "-q", "-b", "pr%d" % number, track)
    (repo / ("f%d.txt" % number)).write_text(str(number))
    git(repo, "add", "f%d.txt" % number)
    git(repo, "commit", "-q", "-m", "work for %d" % number)
    git(repo, "checkout", "-q", track)
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #%d from fixture-org/%s" % (number, head), "pr%d" % number)


def build_repo(repo: Path) -> str:
    """승격 위상: 옛 PR → 두 트랙을 main에 합침(P) → main을 두 트랙에 동기화 → 새 PR들. P의 SHA를 돌려준다."""
    git(repo, "init", "-q", "-b", "main")
    (repo / "base.txt").write_text("base")
    git(repo, "add", "base.txt")
    git(repo, "commit", "-q", "-m", "init")
    git(repo, "branch", "track/engine")
    git(repo, "branch", "track/uxui")
    land(repo, "track/engine", 90, "feat/90-old")
    land(repo, "track/uxui", 190, "feat/190-old")
    git(repo, "checkout", "-q", "main")
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #95 from fixture-org/track/engine", "track/engine")
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #195 from fixture-org/track/uxui", "track/uxui")
    promotion = git(repo, "rev-parse", "HEAD")
    for track, number in (("engine", 96), ("uxui", 97)):
        git(repo, "checkout", "-q", "track/" + track)
        git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #%d from fixture-org/sync/main-into-%s" % (number, track), "main")
    for number, head in ((101, "feat/101-notif"), (102, "fix/102-web"), (103, "feat/103-engine"),
                         (104, "docs/104-adr"), (105, "chore/release-999"), (106, "docs/106-adr-note"), (107, "chore/107-tests")):
        land(repo, "track/engine", number, head)
    git(repo, "commit", "-q", "--allow-empty", "-m", "docs(planning): 직접 올린 기록 (#5031)")
    land(repo, "track/uxui", 201, "feat/201-ux")
    land(repo, "track/uxui", 202, "fix/202-core")
    return promotion


def pr_json(number: int, title: str, head: str, body: str, minute: int) -> dict:
    return {"number": number, "title": title, "body": body, "headRefName": head, "baseRefName": "track/engine",
            "url": "https://github.com/fixture-org/oort/pull/%d" % number, "labels": [],
            "mergedAt": "2026-11-01T10:%02d:00Z" % minute, "closingIssuesReferences": []}


FIXTURE_PRS = [
    pr_json(96, "sync: main → track/engine (fixture)", "sync/main-into-engine", "정합", 1),
    pr_json(97, "sync: main → track/uxui (fixture)", "sync/main-into-uxui", "정합", 2),
    pr_json(101, "feat(phone): 알림 진단 화면을 더해요 (#901)", "feat/101-notif", BOLD_BULLETS, 3),
    pr_json(102, "fix(web,core): 스레드 요약 줄이 겹친 얼굴로 바뀌어요 (#902)", "fix/102-web", HEADING, 4),
    pr_json(103, "feat(engine): 링크 미리보기 API (#903)", "feat/103-engine", NO_SUMMARY, 5),
    pr_json(104, "docs(adr): 기록 정리 (#904)", "docs/104-adr", NA_BODY, 6),
    pr_json(105, "chore(release): v9.9.9 발행 기록", "chore/release-999", "기록", 7),
    pr_json(106, "docs(adr): 결정 기록을 정리해요 (#906)", "docs/106-adr-note", "**요약**: ADR 하나에 증보 절을 더했어요.\n\n**검증**: 문서 게이트\n", 8),
    pr_json(107, "test(core): 시험을 줄여요 (#907)", "chore/107-tests", "**요약**: 겹치는 시험 둘을 하나로 합쳤어요.\n\n**검증**: 통과\n", 9),
    pr_json(201, "feat(phone,web): 입력창 보기 (#911)", "feat/201-ux", TEMPLATE_UNFILLED, 10),
    # 가장 먼저 합쳐진 것 — 영어 줄 초안의 차례가 PR 번호·트랙 차례가 아니라 합친 시각임을 잰다
    pr_json(202, "fix(core): Composer height no longer clips (#912)", "fix/202-core", ENGLISH_BODY, 0),
]


def listed_prs(report: str) -> set:
    return {int(n) for n in re.findall(r"PR #(\d+)", report)} | {int(n) for n in re.findall(r"(?m)^- #(\d+) ", report)}


def section(report: str, heading: str) -> str:
    match = re.search(r"(?ms)^## %s.*?(?=^## |\Z)" % re.escape(heading), report)
    assert match, heading
    return match.group(0)


class CollectEndToEndTests(unittest.TestCase):
    def run_collect(self, tmp: Path, prs, since=None, extra=(), env_extra=None):
        repo = tmp / "repo"
        repo.mkdir()
        promotion = build_repo(repo)
        env = dict(install_fake_gh(tmp), **(env_extra or {}))
        for pr in prs:
            (tmp / "data" / ("pr-%d.json" % pr["number"])).write_text(json.dumps(pr), encoding="utf-8")
        out = tmp / "out" / "changes.md"
        since_args = since(repo) if since else ["--since", promotion]
        args = [sys.executable, str(SCRIPT), *since_args, "--engine-head", "track/engine", "--uxui-head", "track/uxui",
                "--repo-dir", str(repo), "--repo", "fixture-org/oort", "--output", str(out), *extra]
        proc = subprocess.run(args, capture_output=True, text=True, env=env)
        return proc, (out.read_text(encoding="utf-8") if out.exists() else "")

    def test_report_counts_sections_and_promotion_topology(self):
        with tempfile.TemporaryDirectory() as raw:
            proc, report = self.run_collect(Path(raw), FIXTURE_PRS)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # 승격 앞의 PR(#90·#190·합친 #95·#195)과 PR 가지 안 커밋은 새지 않고, 뒤의 11건이 정확히 나온다.
        self.assertEqual(listed_prs(report), {96, 97, 101, 102, 103, 104, 105, 106, 107, 201, 202})
        self.assertIn("**11** = 요약 있음 5 + 변화 없음 명시 1 + 요약 없음 2 + 수집에서 뺌 3 + 가져오지 못함 0", report)
        self.assertIn("제목형(`## 요약`) 1 · 굵은 글씨형(`**요약**`) 5", report)
        self.assertEqual(listed_prs(section(report, "3.")), {103, 201})
        self.assertIn("칸이 없어요", re.search(r"- #103 .*", report).group(0))
        self.assertIn("칸은 있는데 비어 있어요", re.search(r"- #201 .*", report).group(0))
        self.assertEqual(listed_prs(section(report, "4.")), {104})
        self.assertEqual(listed_prs(section(report, "5.")), {96, 97, 105})
        self.assertIn("요약 없는 PR 2건", proc.stderr)  # 경고뿐 — 종료 코드는 0
        # 영어 줄 초안: 구역·접두사·번역 표지(한국어 원문만), 영어 요약은 그대로, 차례는 합친 시각
        draft = section(report, "1.")
        self.assertRegex(draft, r"### Added\n- Phone: \[en 번역 필요\] 알림 진단 화면을 더해요\. \(#901\) <!-- PR #101 -->\n")
        fixed = draft[draft.index("### Fixed"):draft.index("### Docs")]
        self.assertEqual(re.findall(r"PR #(\d+) -->", fixed), ["202", "102"])
        self.assertIn("- Phone, web and desktop: The composer grows with long text instead of clipping. (#912) <!-- PR #202 -->", fixed)
        self.assertIn("- Phone, web and desktop: [en 번역 필요] 스레드 요약 줄이 겹친 얼굴로 바뀌어요. (#902) <!-- PR #102 -->", fixed)
        self.assertIn("### Docs\n- [en 번역 필요] ADR 하나에 증보 절을 더했어요. (#906) <!-- PR #106 -->", draft)  # Docs는 화면 접두사 없이
        internal = draft[draft.index("### (내부)"):]
        self.assertIn("- test: 시험을 줄여요 — 겹치는 시험 둘을 하나로 합쳤어요. (PR #107)", internal)
        self.assertNotIn("PR #104", draft)  # N/A는 초안에 들어가지 않는다
        # 주제별 후보: 같은 주제 한 칸에 묶이고, 문서·내부 PR은 빠진다
        topics = section(report, "2.")
        self.assertIn("### 알림·푸시 (1)", topics)
        self.assertIn("### 대화·스레드·입력 (2)", topics)
        self.assertEqual(listed_prs(topics), {101, 102, 202})
        # 직접 올라온 커밋 하나만 점검 목록에 남고, PR 가지 안 커밋은 새지 않는다
        checks = section(report, "6.")
        self.assertEqual(checks.count("PR 번호 없는 커밋"), 1)
        self.assertIn("직접 올린 기록", checks)
        self.assertNotIn("work for", report)

    def test_failed_fetch_is_listed_and_exits_nonzero_but_a_transient_one_is_retried(self):
        with tempfile.TemporaryDirectory() as raw:
            proc, report = self.run_collect(Path(raw), [p for p in FIXTURE_PRS if p["number"] != 102])
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("**가져오지 못한 PR**: #102", section(report, "6."))
        self.assertIn("**11** = 요약 있음 4 + 변화 없음 명시 1 + 요약 없음 2 + 수집에서 뺌 3 + 가져오지 못함 1", report)
        with tempfile.TemporaryDirectory() as raw:
            proc, report = self.run_collect(Path(raw), FIXTURE_PRS, env_extra={"FAKE_GH_FLAKY": "101"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("가져오지 못함 0", report)

    def test_per_track_pins_limit_each_track(self):
        def pins(repo):
            return ["--since-engine", git(repo, "rev-parse", "track/engine~4"), "--since-uxui", git(repo, "rev-parse", "track/uxui~1")]

        with tempfile.TemporaryDirectory() as raw:
            proc, report = self.run_collect(Path(raw), FIXTURE_PRS, since=pins)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(listed_prs(report), {105, 106, 107, 202})
        self.assertIn("**4** = 요약 있음 3 + 변화 없음 명시 0 + 요약 없음 0 + 수집에서 뺌 1 + 가져오지 못함 0", report)

    def test_usage_errors_exit_2_with_a_next_step(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            repo = tmp / "repo"
            repo.mkdir()
            promotion = build_repo(repo)
            env = install_fake_gh(tmp)
            base = [sys.executable, str(SCRIPT), "--repo-dir", str(repo), "--output", str(tmp / "out.md")]
            heads = ["--engine-head", "track/engine", "--uxui-head", "track/uxui"]
            cases = [
                ("origin ref missing", ["--since", promotion], "git fetch origin"),
                ("too many PRs", ["--since", promotion, *heads, "--max-prs", "3"], "--max-prs"),
                ("no base", heads, "--since"),
            ]
            for name, extra, hint in cases:
                with self.subTest(name):
                    proc = subprocess.run(base + extra, capture_output=True, text=True, env=env)
                    self.assertEqual(proc.returncode, 2, proc.stderr)
                    self.assertIn(hint, proc.stderr)
            self.assertFalse((tmp / "out.md").exists())

    def test_check_summary_exit_codes(self):
        for body, code, expect in [(BOLD_BULLETS, 0, "kind=text"), (HEADING, 0, "kind=text"), (NA_BODY, 0, "kind=none"),
                                   (NO_SUMMARY, 3, "kind=missing empty=0"), (TEMPLATE_UNFILLED, 3, "kind=missing empty=1")]:
            with self.subTest(expect):
                proc = subprocess.run([sys.executable, str(SCRIPT), "--check-summary"], input=body, capture_output=True, text=True)
                self.assertEqual(proc.returncode, code)
                self.assertIn(expect, proc.stdout)

    def test_first_unit_cuts_at_a_sentence_end_or_with_an_ellipsis(self):
        cut = cc.first_unit("이 문장은 요약의 첫 문장이에요. " * 20)
        self.assertTrue(cut.endswith("에요."), cut)
        self.assertTrue(60 <= len(cut) <= 220, len(cut))
        self.assertEqual(cc.first_unit("가" * 300), "가" * 220 + "…")
        self.assertEqual(cc.first_unit("- 목록 기호는 떼요\n- 둘째 줄"), "목록 기호는 떼요")


class GoalReleaseWarningTests(unittest.TestCase):
    def run_goal_release(self, body: str):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            env = install_fake_gh(tmp)
            (tmp / "data" / "issue.json").write_text(json.dumps({"title": "fixture issue", "assignees": []}), encoding="utf-8")
            (tmp / "data" / "pr-777.json").write_text(json.dumps({
                "number": 777, "url": "https://github.com/fixture-org/oort/pull/777", "state": "OPEN",
                "headRefName": "chore/5053-fixture", "closingIssuesReferences": [{"number": 5053}], "body": body}), encoding="utf-8")
            return subprocess.run(["bash", str(GOAL_RELEASE), "--dry-run", "--repo", "fixture-org/oort", "5053", "--review", "--pr", "777"],
                                  capture_output=True, text=True, env=env)

    def test_review_handoff_warns_without_a_summary_but_never_blocks(self):
        for name, body, warns in [("no summary block", NO_SUMMARY, True), ("unfilled template", TEMPLATE_UNFILLED, True),
                                  ("bold summary", BOLD_BULLETS, False), ("heading summary", HEADING, False), ("N/A summary", NA_BODY, False)]:
            with self.subTest(name):
                proc = self.run_goal_release(body)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("would add label: status:needs-review", proc.stdout)  # 인계는 그대로 간다
                if warns:
                    self.assertIn("warning: PR 본문에 요약 칸이 없거나 비어 있어요", proc.stderr)
                    self.assertIn("https://github.com/fixture-org/oort/pull/777", proc.stderr)
                else:
                    self.assertNotIn("요약 칸", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
