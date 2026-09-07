# 워커 브리프 — LS-4 문서 로테이션: 닫힌 핸드오프·비인용 리서치·claudedocs·docs/archive 삭제 + STATUS 월 로테이션 + D6 규칙 성문 (engine/docs · #2143 · ADR-0183 D6 Accepted)

> 워커: grok 4.6 · base=origin/track/engine · 워크트리 `momo-worktrees/wls4`(`feat/ls4-docs-rotation`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. **`scripts/**`·`.github/**` 무접촉**(문서 전용). ADR 본문 무수정(링크 경로 포함 — 인용 대상은 보존하므로 깨질 일이 없다). `docs/SELF_HOST*`·`SELF_HOST_AGENT*`·`RELEASING`·`NEXT_CHANNEL`·`AGENTS.md`·`TRACKS.md`·`PIPELINE.md`·`CLAUDE.md` 무접촉. 루트 은퇴 문서(RUN/DEPLOY/BACKLOG/INDEX 재작성)는 LS-3 — 이 PR은 그 안의 **깨진 링크 행만** 제거한다. 시크릿 금지.
> 근거: ADR-0183 D6 + 결재 기록(③ `research/` 제자리 보존 ④ `claudedocs/` gitignore) · 인벤토리 §5(문서 참조 그래프) · 후보 §1 #7·#8·#12·#13·#14·#16.

## 구현 계약
1. **핸드오프 `docs/planning/handoffs/`(302본)** — keep-set을 세 규칙의 합집합으로 계산해 PR 본문에 표로 남기고, 나머지는 `git rm`:
   - (a) `gh issue list --state open --limit 500 --json number,body`의 본문이 파일명(basename)을 언급
   - (b) 파일 머리 15줄의 `#NNNN` 중 하나라도 `gh issue view NNNN --json state`가 OPEN
   - (c) `README.md`·`docs/planning/README.md`·`PIPELINE.md`·`docs/TRACKS.md`·`docs/planning/CURRENT_STATE.md`(현재 파일 전체)·`ENGINE_HANDOFF.md`·`BUILD_TICKETS.md`가 링크
   예상: 삭제 ≈196 · 보존 ≈106(실측치를 보고 — 예상과 ±15 이상 어긋나면 NOTES에 원인).
2. **`docs/planning` 루트(69본)와 `docs/planning/research`(110본+)** — 파일명이 다음을 **제외한** 어디서도 참조되지 않으면 삭제: 자기 자신 · `docs/planning/handoffs/**` · `docs/archive/**` · `docs/planning/archive/**` · `docs/planning/JOURNAL.md` · `STATUS.md` · `docs/planning/CURRENT_STATE.md` · `claudedocs/**`. ADR·architecture·design-system·README·AGENTS·SELF_HOST가 인용하면 보존. `2026-09-07-clean-slate-*`·`2026-09-07-lightening-program.md`·`2026-09-02-launch-program-plan.md`·`2026-09-02-launch-rediagnosis-two-pillars-brief.md`는 정본(보존). 예상 22 · 35.
3. **`research/` 루트(112본)** — `docs/adr/**`·`docs/architecture/**`·`docs/design-system/**`·`README.md`·`AGENTS.md`가 경로 또는 파일명으로 인용하는 파일만 **제자리 보존**(이동·개명 금지), 나머지 `git rm`(빈 디렉터리 소멸). 예상 삭제 ≈90. `docs/INDEX.md` §4·`docs/BACKLOG.md`·`.gitleaksignore`·`deny.toml`·`adapters/prime/*` 주석·`clients/web/gates/*.mjs` 주석에 남는 링크 중 **삭제된 파일을 가리키는 행만** 제거(코드 주석은 한 줄 정정, 논리 무변화; `.gitleaksignore`는 삭제 파일 행만 제거).
4. **`claudedocs/`** — 추적 39본 `git rm` + `.gitignore`의 `claudedocs/**/*.png` 행을 `claudedocs/`로 교체. `STATUS.md`의 REPORT 경로 인용은 히스토리 문장이라 그대로 둔다.
5. **`docs/archive/` 해체** — `git mv docs/archive/STATUS-2026-06.md docs/archive/STATUS-2026-07.md docs/planning/archive/` · `BUILD_TICKETS-2026H1-legacy.md`·`ROADMAP-2026H1-M0-M8.md`·`README.md` `git rm` · `BUILD_TICKETS.md` 머리·`README.md`·`docs/INDEX.md`·`docs/planning/archive/README.md`의 링크 행 정정. **`STATUS.md` 2026-08 절**(헤더 날짜가 2026-08-xx인 `## ` 절 전부)을 원문 그대로 `docs/planning/archive/STATUS-2026-08.md`(새 파일, 머리 2줄 안내)로 이동 — 절 순서·본문 불변, 잘라낸 줄 수를 PR에 기록.
6. **규칙 성문** — `docs/planning/README.md` §2(산출물 체인) 끝에 「문서 수명 규칙(ADR-0183 D6)」 4행: ①핸드오프 패킷은 이슈가 열려 있는 동안만 존재(close 뒤 다음 플러시에서 삭제, git 히스토리가 아카이브) ②리서치는 Accepted ADR·architecture·design-system이 인용하는 것만 보존 ③`STATUS`·`JOURNAL`·`CURRENT_STATE`는 월 단위 1파일로 `docs/planning/archive/` 로테이션 ④`claudedocs/`는 세션 스크래치, 추적 금지.

## red proof (계수 + 링크 0)
- PR 본문 계수 표(전/후): handoffs 302→? · planning 루트 69→? · planning/research 110→? · research 112→? · claudedocs 39→0 · docs/archive 5→0 · `docs/planning/archive` 파일 수.
- 삭제된 모든 파일명(basename)에 대해 `git grep -lF <name> -- . ':!docs/planning/JOURNAL.md' ':!docs/planning/archive' ':!STATUS.md' ':!docs/adr'` = 0 (ADR·JOURNAL·archive·STATUS의 히스토리 언급만 허용). 결과를 스크립트 한 줄로 재현 가능하게 PR에 적는다.
- 보존 규칙 사보타주 1회: ADR이 인용하는 research 파일 하나를 임시로 삭제 목록에 넣어 검사가 **붉어지는지** 스크래치에서 증명(제출 커밋에는 미포함).
- `scripts/local_gate.sh --profile docs` PASS 원문.

## 완료 절차
커밋 순서: ①handoffs ②planning 루트·research ③`research/` 루트+링크 행 ④claudedocs+gitignore ⑤archive 해체+STATUS 로테이션 ⑥README 규칙. → `git push -u origin feat/ls4-docs-rotation` → PR(base `track/engine`) 본문에 계수 표·keep-set 표·grep 0 재현 명령. 마지막 출력: `DONE / COMMITS / GATES / PR / NOTES`.

## 규율
규칙으로 지운다 — 판단으로 지우지 않는다(규칙 밖 파일은 NOTES에 후보로만). 이동은 `git mv`, 삭제는 `git rm`. 원문을 「정리」하며 고치지 않는다(이동 파일 본문 불변). 예상 계수와 어긋나면 규칙을 바꾸지 말고 원인을 보고. 막히면 우회 말고 보고 후 정지.

## R2 규칙 개정
Keep-set은 열린 이슈 합집합만이 아니라 **살아 있는 정본 문서·코드의 경로 인식 인용**을 포함한다(handoffs/archive/JOURNAL/claudedocs/리서치↔리서치는 제외). basename 일치는 그 이름이 트리에서 유일할 때만 센다.
