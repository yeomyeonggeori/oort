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
#   3  inline_style  style={{...}} or style= (CSP style-src 'self' blocks it)
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
#
# Usage:
#   scripts/design_preflight_web.sh            check, exit 0 pass / 1 violation
#   scripts/design_preflight_web.sh --list     print every hit, never gates
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

KEYS="emdash raw_color inline_style arbitrary_tw ai_gradient toast naked_focus external_font hype pure_bw"

label_for() {
  case "$1" in
    emdash)        echo "em-dash (—/–) in a user-visible string (SKILL §7: binary fail, use , : ( ) or a line break)" ;;
    raw_color)     echo "raw color literal outside src/design/tokens.css (use a Dawn token utility)" ;;
    inline_style)  echo "inline style attribute (CSP style-src 'self' blocks it at runtime)" ;;
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
      grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' \
        "$SRC" --include='*.tsx' --include='*.ts' --include='*.css' 2>/dev/null \
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

MODE="check"
case "${1:-}" in
  --list) MODE="list" ;;
  --help|-h)
    echo "usage: scripts/design_preflight_web.sh [--list]"
    echo "  (no args)  hard-zero check of all 10 categories (exit 0 pass, 1 fail)"
    echo "  --list     print every current hit per category, no gating"
    echo ""
    echo "rules: .claude/skills/momo-design-taste-web/SKILL.md §10"
    echo "tokens: .claude/skills/momo-design-taste-web/references/tokens.md"
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
  echo "RESULT: FAIL, design pre-flight violation."
  echo "  Fix it with a Dawn token utility or a shadcn/Radix primitive. If the hit"
  echo "  is a deliberate, reviewed exception, mark that line with the comment"
  echo "  marker design-preflight-allow and justify it in the PR body."
  exit 1
fi

echo "RESULT: PASS, 10/10 categories clean."
echo "  Still manual (SKILL §10 checklist): light AND dark reviewed, four states"
echo "  present, keyboard path exists, long Korean strings do not overflow."
exit 0
