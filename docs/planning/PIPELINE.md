# oort 파이프라인 설정 정본 (PIPELINE.md)

> **레인(역할)과 현재 값(모델·도구)을 분리한다.** 모델·하네스가 바뀌면 이 문서의 §1 표만 갱신하고, 다른 문서는 이 문서를 가리킨다(§4 목록의 문서에 모델명을 다시 적지 않는다). 신설 2026-09-02(편성 정본 P1 — `docs/planning/2026-09-02-launch-program-plan.md` §7).
> 운영 규율 자체(트랙·머지·게이트·패킷)는 여기가 아니라 `docs/TRACKS.md`·`docs/planning/README.md`·`AGENTS.md`·`docs/MULTI_SESSION_OPS.md`가 정본이다.

## 1. 레인 표 (현재 값 기준일: 2026-09-02)

| 레인 | 역할 | 현재 값 | 계약·스킬 |
|---|---|---|---|
| **product-owner** | ADR Accept/Reject · 로드맵 정본 반영 승인 · 우선순위 · track→main 승격 승인 | 메인테이너(성재) | ADR-0100 · `docs/TRACKS.md` §3 |
| **planner / momo-main** | 리서치 · ADR 기안 · 티켓/패킷 발급 · 워커 검수 재판정 · 순차 머지 · 승격+sync 짝 집행(상시 위임 범위) · CURRENT_STATE/JOURNAL 플러시 | Claude **Fable**(2026-09-04~, 성재 「Fable + opus5으로 가자」 — 한도 소진 시 Opus 5로 강하, `FABLE_DOWNGRADE_ROUTINE.md`). **서브에이전트(design-review 등)는 Opus 5**(`model: opus`). 단일 세션이 planner와 momo-main 겸임 | `CLAUDE.md` · `docs/planning/README.md` · `.claude/skills/momo-planning` |
| **worker** | goal(=GitHub Issue+패킷) 구현 · 게이트 · PR · 정지 | **grok 4.6 (Cursor CLI, non-fast)** — `cursor-agent --model cursor-grok-4.6-high`. 구 grok build CLI(`~/.grok/bin/grok`)는 **잔액 소진(402)으로 정지**(2026-09-03). | `AGENTS.md` · `~/.claude/skills/grok-fleet`(spawn 계약 — 호출부만 아래 §3으로 대체) |
| **reviewer-design** | UI 변경의 fresh-context 리뷰(캡처+프리플라이트+루브릭, Blocker 0·High 0 폐곡선) | `.claude/agents/design-review.md` 에이전트 | `.claude/skills/momo-design-taste` 라우터 |
| **reviewer-code** | 보안·정합·스코프·테스트 정직성 리뷰 · 정책 무결성 감사 | planner 본인(+필요 시 grok 독립 렌즈 "리뷰어 C") | `docs/MULTI_SESSION_OPS.md` §7 · `scripts/verify_policy_integrity_from_base.sh` |

## 2. 상한·경로·승인

| 항목 | 값 |
|---|---|
| 워커 병렬 상한 | **2** (동시 2기 조기 종료 전례 시 1로 보수 — 2026-08-20 실측) |
| 트랙 워크트리 루트 | `$TRACKS_ROOT` — 메인테이너 로컬 관례 `~/projects/momo-tracks/{uxui,engine}`; goal 워크트리는 `$TRACKS_ROOT/momo-worktrees/<slug>` |
| 트랙 브랜치 | `track/uxui` · `track/engine` (`docs/TRACKS.md` §1) |
| 승격 경로 | track→main = product-owner 명시 승인. 2026-08-27 상시 위임: 게이트 그린 전제로 랜딩 단위 승격 + sync 짝(main→uxui·main→engine)을 planner가 자율 집행 |
| 기획 문서 플러시 랜딩 | main 직행 시 **직후 sync 짝 필수**(트랙이 main보다 뒤지면 모든 열린 트랙 PR의 alignment가 붉어진다 — `docs/TRACKS.md` §3.1.1) |
| UI 랜딩 조건 | design-review B0·H0 폐곡선 후 트랙 머지 |
| 엔진 랜딩 후속 | `docs/planning/ENGINE_HANDOFF.md` ready 행 |

## 3. worker spawn 계약 (현재 값)

- **입력**: 브리프(`docs/planning/handoffs/YYYY-MM-DD-<slug>-brief.md`) + GitHub Issue. 브리프는 워커·base·시작 절차(`git merge origin/main --no-edit`)·정지 조건·정본·구현 계약·red proof·완료 절차·규율을 담는다(예: `2026-09-02-bt5-section-interactions-brief.md`).
- **공통 정지 조건**: 머지·이슈 close 금지 · MCP 금지 · `schema_v0.sql` 무접촉 · 게이트/정책 파일(`scripts/**`·`.github/**`) 무수정(허용 시 브리프 명시 + planner 감사) · 시크릿 비유입(ADR-0004).
- **출력 형식**(마지막 출력): `DONE / COMMITS / GATES / PR / NOTES(계획 이탈)`.
- **현재 값 명령**:
  ```sh
  cd <goal 워크트리> && cursor-agent -p "$(cat <mission.md>)" \
    --model cursor-grok-4.6-high -f --output-format text > <scratch>/cursor-<slug>.out 2>&1; echo $? > <scratch>/cursor-<slug>.rc
  ```
  백그라운드(nohup) + 진행·정지·종료 감시(커밋 수·dirty·rc 파일). 재개는 같은 cwd에서 **`--continue`**(2026-09-04 정정: cursor-agent 2026.09.02에서 `-c`는 폐기된 `--cloud`로 해석돼 즉시 exit 1). 워커가 Cursor API `[resource_exhausted]`로 죽으면 커밋은 남는다 — 재개 미션은 「게이트·PR 본문·푸시만」. **spawn은 세션 분리**(2026-09-05 사고: 런처를 돌리던 오케스트레이터 Bash 태스크가 정지되자 같은 프로세스 그룹의 nohup 워커 2기가 함께 죽고 rc 파일도 안 남았다) — `python3 subprocess.Popen([...], start_new_session=True)`(setsid)로 띄우고(`claudedocs/resume-2026-09-04/spawn-worker.sh`), 감시는 rc 파일뿐 아니라 **워커 프로세스 부재**도 이벤트로 낸다. 죽은 워커의 재개 = 같은 cwd `--continue` + 상황 재개 노트 **파일**(`-p "$(cat …)"`를 unquoted heredoc 안에 두면 셸이 먼저 평가해 빈 프롬프트로 발사된다).
- **워커 상습 6축(리뷰 지시문에 상설)**: 증명 없는 초록 시험 · 픽스처 맞춤 규칙 인하 · 짧은 픽스처 뒤에 숨는 규칙 · 수리가 만드는 회귀 · 자 부분상속 · **실패할 수 없는 단정**(2026-09-03 신설 — 수리는 옳은데 그것을 지키는 자가 헛돈다: 한 번도 디코드하지 않는 QR 스위트, jsdom 폴백으로 항상 참인 하한, `try{}catch{}`에 싸인 스캔, 파일 이름 허용목록, 속성만 보는 렌더 가드, 발화하지 않는 스크롤 단정).
- **리뷰 지시문 필수 문구**: 「각 단정을 스크래치 사본에서 되돌려 붉어지는지 증명하라(사보타주)」 — 2026-09-03 회차의 모든 발견이 여기서 나왔다. 수리 미션에는 **무엇을 숫자로 재는지**를 적는다(예: 링-채움 대비 ≥3:1, 렌더된 모듈 피치 ≥floor, 표본의 셀 내 가시 비율 ≥0.9).
- **병렬 상한 2는 워커+검수 합산**(2026-09-04): design-review 서브에이전트도 캡처·스위트·프로브를 돌리는 무거운 잡이고, dwell ms·프레임 수·버스트 재생 같은 타이밍 측정은 CPU 경합에 흔들린다. 검수 프롬프트에는 「스크래치 사본 생성 직후 `.git` 파일 삭제」(사본의 `.git`이 실제 워크트리 gitdir을 가리킨다)와 사용 포트 배정을 명시한다.
- **미션에 형제 형태를 이름 대어 적는다**(2026-09-04): 워커가 옆 파일의 `warn + skipIf`를 두고 throw를 골라 CI가 구조적으로 붉었다(UX-R1c R2-B1). 수리 미션은 「무엇을 재라」에 더해 「어느 파일의 어느 형태를 따르라」를 적는다.
- **게이트 동시 실행 금지**: 병합 트리 게이트를 둘 이상 동시에 돌리면 폰 스위트가 비결정적으로 붉어진다(#2018 — `workConsole`·`composerAttachments`·`deviceLink` 3파일 실측, 순차 재실행 시 전부 PASS).

## 4. 이 문서를 참조해야 하는 자리 (모델명 하드코딩 금지 목록)

`CLAUDE.md` · `AGENTS.md` 머리말 · `docs/planning/README.md` §0·§3 · `docs/TRACKS.md` 머리말 · `docs/MULTI_SESSION_OPS.md`(다음 개정 시) · `.claude/skills/momo-planning/SKILL.md` · `.github/ISSUE_TEMPLATE/`(P4·SH-9에서 일반화) · `ROADMAP.md` 운영 파이프라인 절.

## 5. 변경 이력 (현재 값)

| 날짜 | 레인 | 변경 |
|---|---|---|
| 2026-09-03 | worker | **grok 4.6 — Cursor CLI non-fast**(`cursor-grok-4.6-high`, 성재 지시). 구 grok build CLI 잔액 소진(402)으로 교체 |
| 2026-09-03 | planner/momo-main | **Opus 5**(Fable 한도 소진, 성재가 `/model` 전환) — 서브에이전트도 `model: opus`로 발사 |
| 2026-09-02 | worker | **grok 4.6**(성재 지시, grok build CLI) |
| 2026-09-01 | worker | Opus 5 Agent 레인(하루 운용, BT-1~5) |
| 2026-08-29 | worker | grok build CLI grok-4.6(병렬 2 실증) |
| 2026-08-26 | worker | cursor-agent grok-4.6(Codex CLI 공식 은퇴) |
| ~2026-08-25 | worker | Codex CLI(codex-fleet) / GPT 5.6 sol |
| 2026-08-27 | planner | main 정본화 상시 위임(승격+sync 짝 자율) |
