#!/usr/bin/env bash
#
# design_preflight_web.sh: mechanical design pre-flight for the momo web client
# (MOMO-597, ADR-0133 P1).
#
# Executable form of `.claude/skills/momo-design-taste-web/SKILL.md` §10. Where
# the mac counterpart (scripts/verify_design_preflight.sh) needs a ratchet
# baseline because the v0 SwiftUI demo surface shipped with violations, this one
# is a HARD ZERO gate: clients/web was converted to the Dawn tokens in one pass
# (MOMO-597), so every category below starts and stays at 0.
#
# Categories (SKILL §10.1 .. §10.10):
#   1  emdash        em-dash (—/–) inside a user-visible string
#   2  raw_color     hex / rgb() / hsl() literal outside the token definition
#   3  inline_style  style={{...}} or style= (house rule, SKILL §1)
#   4  arbitrary_tw  arbitrary Tailwind value: className="... [13px] ..."
#   5  ai_gradient   bg-gradient / indigo-violet family (AI-tell)
#   6  toast         toast / snackbar stack instead of an inline banner
#   7  naked_focus   outline-none with no focus-visible: replacement
#   8  external_font webfont / CDN / <link href="http (CSP + offline)
#   9  hype          filler-hype vocabulary in user-visible copy
#   10 pure_bw       pure #000000 / #ffffff / bg-black / bg-white
#
# Excluded by design:
#   - src/design/tokens.css          the token definition; raw hex is its job
#   - src/design/tokens.contrast.test.ts  the verifier; the hex IS the assertion
#   - any line carrying the marker `design-preflight-allow` (deliberate,
#     reviewed exception, justify it in the PR body)
#   - a GitHub issue reference inside raw_color (`#1137`); see ISSUE_REF_RE
#
# ---- 코어 단계 (이슈 #1141) --------------------------------------------------
#
# 위 열 분류는 `clients/web/src` 만 훑는다. 그런데 이 클라가 화면에 내놓는 문장의
# 상당수는 거기 없다 — `packages/momo-core` 에 있고, 웹과 폰이 **그것을 그대로**
# 렌더한다. 그래서 코어에 em-dash 를 적으면 두 클라가 함께 출하하는데 어느 게이트도
# 붉지 않았다. #1138 B2(출하 직전에 사람이 발견한 em-dash 3건)의 원인이 이 구멍이다.
#
# 코어는 순수 TS 라 「렌더되는 글자」와 「산문(주석·독스트링·테스트 이름)」을 가르는
# 문법적 표지가 없어서 줄 기반 grep 이 성립하지 않는다. 그 분리 규칙은 AST 로
# `scripts/design_preflight_core.mjs` 가 들고 있고(규칙과 세 후보의 비교 근거는 그
# 머리말, 케이스는 그 `--selftest`), 여기서는 마지막 단계로 부른다. 이 파일 이름이
# 여전히 web 인 이유: 이 게이트가 답하는 질문은 「이 클라가 화면에 무엇을 내놓는가」
# 이고, 그 답에 코어의 문장이 포함될 뿐이다.
#
# Usage:
#   scripts/design_preflight_web.sh            check, exit 0 pass / 1 violation
#   scripts/design_preflight_web.sh --list     print every hit, never gates
#   scripts/design_preflight_web.sh --selftest prove both discriminators
#                                              (web raw_color + core separation)
#
# Compatible with /bin/bash 3.2 (macOS system bash): no associative arrays, no
# mapfile. LC_ALL=C keeps grep byte-oriented so counts are deterministic.

set -u
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to repo root $REPO_ROOT" >&2; exit 2; }

WEB="clients/web"
SRC="$WEB/src"
HTML="$WEB/index.html"

if [ ! -d "$SRC" ]; then
  echo "design pre-flight (web): $SRC not found (run from the momo repo)" >&2
  exit 2
fi

# Token definition + its verifier are the two files allowed to name raw values.
TOKEN_FILE_RE='src/design/(tokens\.css|tokens\.contrast\.test\.ts):'
# Deliberate reviewed exception marker.
ALLOW_RE='design-preflight-allow'

# ---- raw_color: what a color is, and what only looks like one ----------------
#
# `#1137` is an issue number, not a color. Every one of its four characters is a
# hex digit, so the naive `#[0-9a-fA-F]{3,8}\b` claimed it — and this repo has
# now been hit by that three times (#1060 was the third). Each time it was
# settled by a convention ("don't write issue numbers in comments") and each time
# the convention failed to reach the next author, because a convention that is
# not compiled is not a convention. So the exception moves INTO the gate.
#
# The rule: strip issue-reference tokens from the line first, then ask whether a
# color is still there. An issue reference is `#` + 3..5 DECIMAL digits + a
# non-hex boundary. One letter anywhere (`#fff`, `#1a2740`) means it was never an
# issue number, so it is not stripped and stays caught. Six and eight digit forms
# (`#000000`, `#12345678`) never satisfy the 3..5 rule either, because the digit
# that follows is itself hex, so they stay caught too.
#
# One hole is left open knowingly: a real color whose 3..5 digits are ALL decimal
# (`#1234`). No such literal exists outside tokens.css in this client, and if one
# appeared, `pure_bw` (#000/#fff) and `arbitrary_tw` (class="[#1234]") still hold
# their own ground. Knowing about that hole is cheaper than the alternative this
# gate actually produced, which was authors deleting the issue reference — the
# one piece of provenance a reviewer needs — to get a green run.
#
# `--selftest` carries every one of those decisions as a case. BSD sed has no
# `\b`, hence the explicit non-hex character class plus a separate end-of-line
# pass (verified on /usr/bin/sed, macOS 15).
COLOR_RE='#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\('
ISSUE_REF_RE='#[0-9]{3,5}'

# stdin: candidate lines. stdout: the ones that still hold a color once every
# issue reference is removed.
drop_issue_refs() {
  while IFS= read -r line; do
    if printf '%s\n' "$line" \
      | sed -E "s/${ISSUE_REF_RE}([^0-9a-fA-F])/\\1/g; s/${ISSUE_REF_RE}\$//" \
      | grep -qE "$COLOR_RE"; then
      printf '%s\n' "$line"
    fi
  done
}

KEYS="emdash raw_color inline_style arbitrary_tw ai_gradient toast naked_focus external_font hype pure_bw"

label_for() {
  case "$1" in
    emdash)        echo "em-dash (—/–) in a user-visible string (SKILL §7: binary fail, use , : ( ) or a line break)" ;;
    raw_color)     echo "raw color literal outside src/design/tokens.css (use a Dawn token utility)" ;;
    inline_style)  echo "inline style attribute (SKILL §1: the shipped style-src carries 'unsafe-inline' for xterm.js only, components author no styles)" ;;
    arbitrary_tw)  echo "arbitrary Tailwind value (spacing is {4,8,12,16,24,32}px, radius is sm/md/lg)" ;;
    ai_gradient)   echo "gradient / indigo-violet family on a product surface (AI-tell, SKILL §8)" ;;
    toast)         echo "toast or snackbar stack (use an inline banner in context, SKILL §8)" ;;
    naked_focus)   echo "outline-none without a focus-visible: replacement on the same class list" ;;
    external_font) echo "external font or CDN reference (breaks CSP and offline, SKILL §1)" ;;
    hype)          echo "filler-hype vocabulary in user-visible copy (SKILL §7)" ;;
    pure_bw)       echo "pure black/white (use the surface tokens, they adapt to scheme)" ;;
    *)             echo "$1" ;;
  esac
}

# Drop token-definition files and explicitly allowed lines from any result set.
filter_common() {
  grep -vE "$TOKEN_FILE_RE" | grep -vF "$ALLOW_RE"
}

# Drop whole-line comments (`// ...` / ` * ...`): a comment is not user-visible.
drop_comment_lines() {
  grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|\*|/\*)'
}

scan_category() {
  case "$1" in
    emdash)
      # An em-dash inside a quoted literal (", ' or `), plus anything in the
      # HTML shell, where the title and body text are user-visible as authored.
      {
        grep -rnE '"[^"]*(—|–)[^"]*"|'\''[^'\'']*(—|–)[^'\'']*'\''|`[^`]*(—|–)[^`]*`' \
          "$SRC" --include='*.tsx' --include='*.ts' 2>/dev/null | drop_comment_lines
        grep -nE '—|–' "$HTML" 2>/dev/null | sed "s|^|$HTML:|"
      } | filter_common
      ;;
    raw_color)
      grep -rnE "$COLOR_RE" \
        "$SRC" --include='*.tsx' --include='*.ts' --include='*.css' 2>/dev/null \
        | drop_issue_refs \
        | filter_common
      ;;
    inline_style)
      grep -rnE 'style=\{|style="' "$SRC" --include='*.tsx' 2>/dev/null | filter_common
      ;;
    arbitrary_tw)
      # `[13px]`, `[#fff]`, `w-[237px]`. Radix/Tailwind selector variants such as
      # `[&_svg]:size-4` start with & and are intentionally not matched.
      grep -rnE 'class(Name)?=.*\[[0-9#]' "$SRC" --include='*.tsx' 2>/dev/null \
        | filter_common
      ;;
    ai_gradient)
      grep -rnE 'bg-gradient|(from|via|to)-(purple|indigo|violet|fuchsia|blue)' \
        "$SRC" --include='*.tsx' --include='*.ts' --include='*.css' 2>/dev/null \
        | filter_common
      ;;
    toast)
      grep -rniE 'sonner|useToast|showToast|toast\(' \
        "$SRC" --include='*.tsx' --include='*.ts' 2>/dev/null | filter_common
      ;;
    naked_focus)
      # Focus indication may be replaced, never removed: a class list that turns
      # the outline off must re-add one in the same list.
      grep -rn 'outline-none' "$SRC" --include='*.tsx' 2>/dev/null \
        | grep -v 'focus-visible:' | filter_common
      ;;
    external_font)
      grep -rniE 'fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg\.|jsdelivr|@font-face|<link[^>]+href="http' \
        "$SRC" "$HTML" 2>/dev/null | filter_common
      ;;
    hype)
      grep -rniE 'seamless|effortless|unleash|elevate|원활한|손쉽게|매끄러운' \
        "$SRC" --include='*.tsx' --include='*.ts' 2>/dev/null \
        | drop_comment_lines | filter_common
      ;;
    pure_bw)
      grep -rniE 'bg-black|bg-white|#000000|#ffffff|#000\b|#fff\b' \
        "$SRC" "$HTML" --include='*.tsx' --include='*.ts' --include='*.css' --include='*.html' 2>/dev/null \
        | filter_common
      ;;
  esac
}

count_category() {
  # `grep -c .` prints 0 on empty input and exits 1; only stdout is read.
  scan_category "$1" | grep -c . || true
}

# ---- raw_color self-test -----------------------------------------------------
#
# The red proof, kept executable instead of retold. Each case is one line of
# would-be source and the verdict it must get: 1 = violation, 0 = clean. A
# change to COLOR_RE or ISSUE_REF_RE that quietly stops catching `#fff` fails
# here, in this file, without anyone remembering to re-run the injection by hand.
run_selftest() {
  echo "== raw_color discriminator self-test =="
  local fails=0 want line got
  while IFS='|' read -r want line; do
    [ -z "${want:-}" ] && continue
    case "$want" in \#*) continue ;; esac
    got=0
    if printf '%s\n' "$line" | grep -E "$COLOR_RE" | drop_issue_refs | grep -q .; then
      got=1
    fi
    if [ "$got" = "$want" ]; then
      echo "OK    want=$want  $line"
    else
      echo "FAIL  want=$want got=$got  $line"
      fails=1
    fi
  done <<'CASES'
# a real color is still a real color
1|src/features/work/A.tsx:9:  <div className="text-[#fff]" />
1|src/features/work/A.tsx:9:  const accent = "#1a2740";
1|src/design/x.css:9:  background: #000000;
1|src/design/x.css:9:  border: 1px solid rgba(12, 18, 28, 0.2);
1|src/design/x.css:9:  color: hsl(210 40% 96%);
1|src/features/work/A.tsx:9:  const c = "#12345678";
# an issue reference is not a color
0|src/features/work/A.tsx:9:// 부분 복원 고지 (ADR-0154 D3, #1137).
0|src/features/work/A.tsx:9:              고칠 자리는 한 곳이다(#1137). */}
0|src/features/work/A.tsx:9:// #1060 세 번째 적중 — 전파되지 않는 규약은 규약이 아니다.
0|src/features/work/A.tsx:9:// 이슈 #12345 와 #97 을 나란히 적어도 색은 없다.
# both on one line: the color survives the strip and is still reported
1|src/features/work/A.tsx:9:// #1137 이 금지한 색이 바로 이것이다: #1a2740
CASES
  echo ""
  if [ "$fails" -ne 0 ]; then
    echo "RESULT: FAIL, the raw_color discriminator does not hold."
    return 1
  fi
  echo "RESULT: PASS, raw_color tells issue references from colors."
  return 0
}

# ---- 코어 단계 (이슈 #1141) --------------------------------------------------
#
# node 가 없으면 **건너뛰지 않고 실패한다**. "안 돌린 것"과 "초록"이 구별되지 않는
# 상태를 만들지 않는 것이 이 레포의 게이트 규칙이다(verify_merge_tree.sh 머리말).
CORE_SCAN="$SCRIPT_DIR/design_preflight_core.mjs"

run_core_stage() {
  # $1: "" | --list | --selftest
  if [ ! -f "$CORE_SCAN" ]; then
    echo "design pre-flight (core): $CORE_SCAN 없음" >&2
    return 2
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "design pre-flight (core): node 가 없다 — 코어 단계를 돌릴 수 없다." >&2
    echo "  (이 단계는 건너뛰지 않는다: 안 돈 것을 초록으로 세지 않기 위해서다)" >&2
    return 2
  fi
  if [ -n "${1:-}" ]; then
    node "$CORE_SCAN" "$1"
  else
    node "$CORE_SCAN"
  fi
}

MODE="check"
case "${1:-}" in
  --list) MODE="list" ;;
  --selftest)
    run_selftest
    web_rc=$?
    echo ""
    run_core_stage --selftest
    core_rc=$?
    echo ""
    if [ "$web_rc" -ne 0 ] || [ "$core_rc" -ne 0 ]; then
      echo "SELFTEST: FAIL (web raw_color=$web_rc, core separation=$core_rc)"
      exit 1
    fi
    echo "SELFTEST: PASS (web raw_color + core separation rule)"
    exit 0
    ;;
  --help|-h)
    echo "usage: scripts/design_preflight_web.sh [--list|--selftest]"
    echo "  (no args)  hard-zero check: web 10 categories + core string literals"
    echo "  --list     print every current hit per category, no gating"
    echo "  --selftest raw_color: prove issue refs pass and real hex fails, and"
    echo "             core: prove render strings fail while prose/tests pass"
    echo ""
    echo "rules: .claude/skills/momo-design-taste-web/SKILL.md §10"
    echo "tokens: .claude/skills/momo-design-taste-web/references/tokens.md"
    echo "core:  scripts/design_preflight_core.mjs (이슈 #1141 — 분리 규칙과 근거)"
    exit 0
    ;;
  "") ;;
  *)
    echo "unknown argument: $1 (see --help)" >&2
    exit 2
    ;;
esac

if [ "$MODE" = "list" ]; then
  echo "== design pre-flight (web): all current hits =="
  for key in $KEYS; do
    n="$(count_category "$key")"
    echo "-- $key ($n): $(label_for "$key")"
    scan_category "$key" | sed 's/^/   /'
  done
  echo ""
  run_core_stage --list
  exit 0
fi

echo "== design pre-flight (web), SKILL momo-design-taste-web §10 =="
echo "   scanned: $SRC, $HTML"
echo "   excluded: src/design/tokens.css, src/design/tokens.contrast.test.ts"
echo ""

overall=0
for key in $KEYS; do
  cur="$(count_category "$key")"
  if [ "$cur" -gt 0 ]; then
    echo "FAIL  $key: $cur hit(s)"
    echo "        rule: $(label_for "$key")"
    scan_category "$key" | sed 's/^/          /'
    overall=1
  else
    echo "OK    $key: 0"
  fi
done

echo ""
if [ "$overall" -ne 0 ]; then
  echo "FAIL  web: 위 분류에 위반이 있다."
else
  echo "OK    web: 10/10 categories clean."
fi

# 코어 단계는 웹이 붉어도 **돈다**. 한 번의 실행이 두 층을 다 말해야 고치는 사람이
# 두 번 왕복하지 않는다.
echo ""
run_core_stage
core_rc=$?
if [ "$core_rc" -ne 0 ]; then
  overall=1
fi

echo ""
if [ "$overall" -ne 0 ]; then
  echo "RESULT: FAIL, design pre-flight violation."
  echo "  Fix it with a Dawn token utility or a shadcn/Radix primitive. If the hit"
  echo "  is a deliberate, reviewed exception, mark that line with the comment"
  echo "  marker design-preflight-allow and justify it in the PR body."
  exit 1
fi

echo "RESULT: PASS, web 10/10 + core 3/3 categories clean."
echo "  Still manual (SKILL §10 checklist): light AND dark reviewed, four states"
echo "  present, keyboard path exists, long Korean strings do not overflow."
exit 0
