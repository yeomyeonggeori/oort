# 워커 브리프 — SH-4b README 「Paste this into your agent」 프롬프트 블록 + `SELF_HOST`·`FIRST_DAY` 영문 정본 (engine · SH-4a 후 · ADR 불요)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `README.md`·`docs/SELF_HOST*.md`·`llms.txt`만. `scripts/**`·`.github/**` 무수정(드리프트 게이트가 새 `.ko.md`를 못 보면 NOTES). 시크릿·실호스트 값 기록 금지.
> 근거: 편성 정본 §5 SH-4b · SH-4a 랜딩(영문 정본 `docs/SELF_HOST_AGENT.md` + `.ko.md`) · README §Self-host(현행: 3명령 + `releases/latest.json` 안내 + 은퇴 런북 링크[SH-2가 교체]) · `llms.txt`.

## 구현 계약
1. **README 「Paste this into your agent」 블록**(§Self-host 맨 위, 코드 펜스 1개, ≤ 10줄, 영문): 에이전트에게 「이 기계에서, 이 사용자의 계정으로만, `https://raw.githubusercontent.com/yeomyeonggeori/oort/main/docs/SELF_HOST_AGENT.md`를 읽고 그 계약(§0)대로 설치하고 `scripts/oort doctor`가 PASS일 때만 완료로 보고하라」는 프롬프트. 하네스 이름 없음. 아래에 「사람이 직접 하려면 → `docs/SELF_HOST.md`」 1줄.
2. **`docs/SELF_HOST.md` → 영문 정본** + `docs/SELF_HOST.ko.md`(현행 한국어 내용을 옮김, 구조·절 번호 동일). **`docs/SELF_HOST_FIRST_DAY.md` → 영문 정본** + `.ko.md` 동일 규칙. 「검증 상태」 절의 실측 날짜·버전은 옮기되 새로 재지 않는다(재측정은 SH-5a).
3. 상호 링크 정합: README ↔ SELF_HOST ↔ SELF_HOST_AGENT ↔ FIRST_DAY ↔ `llms.txt` — 죽은 링크 0(스크립트로 대조, PR 본문에 출력). SH-2가 바꾼 「공개 오리진으로 열기」 절은 영문 정본에도 같은 절로.
4. digest·버전 하드코딩 0(`releases/latest.json` 명령만).

## red proof (선행 커밋)
- `grep -rn '@sha256:' README.md docs/SELF_HOST*.md llms.txt` = 0 · 링크 대조 스크립트 출력(깨진 링크 0) · 영/한 절 번호 집합 동일(2쌍) · README 블록이 하네스 이름을 포함하지 않음(grep 0).

## 완료 절차
markdown lint(있으면) · `scripts/check_release_manifest.sh` 초록 → 커밋 → `git push -u origin feat/sh4b-readme-paste-block` → `gh pr create --base track/engine` → 정지.

## 규율
번역은 구조 동일·요약 금지. 프롬프트 블록은 문서를 가리키지 절차를 복제하지 않는다(이중 정본 금지). 막히면 우회 말고 보고 후 정지.
