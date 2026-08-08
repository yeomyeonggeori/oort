# 재개 세팅 2 — 2026-07-28 (성재 "잠시 작업 중단" 지점)

> 이 문서 하나로 재개한다. 이전 재개 문서는 `2026-07-27-resume-batch.md`(완료된 배치), 상위 계획은
> `2026-07-28-huddle-meeting-continuity-plan.md`·`2026-07-28-buzz-agents-tab-delta.md`.
> **워커 모델 = `gpt-5.6-sol` medium**(성재 지시). design-review는 오케스트레이터가 fresh context로.

## 0. 성재에게 이렇게 시키시면 됩니다

| 하고 싶은 것 | 지시 문장 |
|---|---|
| 멈춘 지점 그대로 재개 | **"재개 문서 2 읽고 이어서 해줘"** |
| #857만 검수 | **"857 검수해줘"** |
| main 반영(승인) | **"트랙 main에 반영해줘"** |

## 1. 지금 상태 한 줄

**연속성·허들 배치 6장 랜딩 완료**(#855·#854·#850·#851·#856 + 이전 5장), **#857(데몬 링버퍼) 워커가 가동 중인 채 중단**. 트랙 두 개가 main보다 앞서 있고 **main 동기화는 성재 승인 대기**.

## 2. 재개 시 바로 할 일 (순서대로)

### (1) #857 워커 결과 확인 ⟵ **여기서 멈췄다**

```sh
R=/Users/kwakseongjae/.codex-fleet/runs/goal-857-ringbuffer-20260728T092159
cat $R/exit-code 2>/dev/null && tail -20 $R/last-message.md || echo "아직 실행 중(ps -p 38188)"
```
- 끝났으면: 워크트리 `~/projects/momo-tracks/momo-worktrees/857-momo-649-ringbuffer`에서 검수.
  **검증 절차**(이번 배치 표준): ①`swift build`+데몬/서버 테스트 ②워커가 신설한 검증기 실행(**exit code를 파이프로 가리지 말 것** — 파일 리다이렉트+`echo $?`) ③red proof(replay 끄면 재부착 단정 FAIL — PR 본문 절차) ④**실왕복**: 데몬↔서버↔웹 xterm(replay 이음새에서 xterm 무파손) ⑤이음새 프로토콜(중복·유실 없음)과 "무엇을 도구로 보는가" 판정 규칙을 PR 본문에서 확인.
- 죽었으면(exit-code 없이 프로세스 소멸): 로그 크기 확인 후 같은 패킷으로 재spawn(`handoffs/2026-07-28-857-daemon-ringbuffer-packet.md`).

### (2) #857 랜딩 후 → #859 (T3 pause 접합)
패킷 **미작성** — #857 랜딩분(링버퍼·idle 훅 위치)을 보고 쓴다. 티켓 #859에 요구사항 완비
(idle→pause·재부착→resume·pause 미계상 실배선·resume 실패→orphaned·red proof). 원장의 pause 구간 표현은 #855가 선반영해뒀다.

### (3) uxui 레인 → #858 (웹 idle 표시·재부착 동선)
선행 #856(랜딩됨)+#857(대기). 패킷 미작성 — 티켓 #858에 요구 완비. **#856 PR #867 본문의
`work.session.idle`/`work.session.resumed-to-running` 프레임 스키마가 소비 계약이다.**
#851이 미지 상태 안전 렌더로 자리를 만들어뒀다.

### (4) 그 뒤 → #860(에이전트 허브 탭)·#861(전역 run REST) — 패킷 미작성, 티켓에 상세 완비.

## 3. 랜딩 완료 (재검증 불필요) — 전부 트랙, main 미반영

| # | 내용 | 트랙 | 비고 |
|---|---|---|---|
| #855 | T3 프로비저너+크레딧 원장 (PR #863) | engine | pause 미계상=GENERATED 컬럼. **실 E2B 왕복은 D4 리허설 준비물**(momo-workd template+공개 서버) 필요 |
| #854 | 전사 v1 (PR #864) | engine | 동의 게이트 실서버 관통(409→200→201→409). **모델 확정은 실코퍼스 후**(성재) |
| #856 | idle 수명주기 (PR #867, ADR-0139 D1) | engine | 완료 푸시 id-only·24h sweep·검증기 전관문+red proof |
| #850 | 웹 허들 (PR #862, 2R PASS) | uxui | Tauri 마이크 실측·실 LiveKit joined 캡처는 셸 실빌드 시점 |
| #851 | 내 세션 표면 (PR #866, 2R PASS) | uxui | — |

**main 동기화 대상**: `track/engine`(+#855·#854·#856) · `track/uxui`(+#850·#851). **성재 승인 필요.**
머지 후 원점 검증 표준: server swift build+test · 웹 typecheck+test+게이트 6종(wire/shell/csp/huddle/my-sessions/preflight) · 마이그레이션 번호 유일성(현재 47).

## 4. 이번 구간에서 수리한 선존재 결함 (재발 방지 근거)

- **검증기 픽스처 드리프트 4종**(#856 브랜치에서 수리·랜딩): 07-21 fffe303b(#564) 이후 authz가
  `workspace_membership`을 요구하는데 work_session·terminal_attach·observer_attach·push_notifier
  픽스처가 채널 membership만 심어 **일주일간 403**. SQL 지름길 픽스처 패턴 6번째 사례.
- **gate:shell의 waitForFunction**(CSP 재실행에서 EvalError — #850 브랜치에서 수리·랜딩): 술어를
  페이지 월드에서 eval → `page.evaluate` 폴링으로 교체.
- **#865 티켓**: `work-session-remote-create` 409가 전체 계약 게이트를 3배치째 차단(fail-fast 구조 재고 포함).

## 5. 성재 몫 (대기 중)

- **track→main 머지 승인 2건**(§3). 이후 라이브 통합·next 발행 여부 판단.
- **ADR-0136 D4 리허설**: 대본 랜딩됨(`2026-07-28-t1-t2-t3-work-rehearsal.md`). 준비물 = momo-workd E2B template + 공개 HTTPS 서버(오케스트레이터와 함께).
- **전사 모델 확정**: 실회의 한국어 코퍼스로 하니스 실행(사용법 PR #864 본문). 하니스는 3모델 실완주 검증됨.
- `legal/privacy-policy.md` 빈칸 · #837 RN 스파이크 실기기 · ADR-0138(온보딩)/0113 증보(3자 OAuth) · ADR-0140 기안 예정(schedule 실행기) · #839 grant 기본 전체선택 제품 판단.

## 6. 파이프라인 교훈 (이번 구간 추가분)

- **결함은 워커가 검증 못 하는 계층에 몰린다** — #856의 FK 500, #850의 셸 통합 Blocker 전부 docker/실렌더 계층. 첫 실행자(오케스트레이터)가 곧 그 계층의 테스터다.
- **서버 outbox payload의 UUID는 대문자**(Swift uuidString). 셸 텍스트 비교는 lower() 정규화 — 감사(uuid 타입)만 통과하는 비대칭이 진단 단서였다.
- **exit code를 파이프로 가리지 말 것** — `| tail`이 검증기 실패를 0으로 만든 재범 1회. red proof는 "빨간 이유"까지 확인(포트 충돌 exit 1을 성립으로 오기했다 정정한 사례).
- design-review 지적의 반복 형태: **"자기 원칙을 자기가 만진 나머지 분기에 미적용"**(#851) · **"기존 셸과의 통합 지점"**(#850). 패킷에 "새 표면이 앉는 자리의 기존 계약"을 명시하는 것이 라운드를 줄인다.

## 7. main 반영 완료 (2026-07-28, 성재 "main 반영해줘")

**결과: `main` = `track/engine` = `track/uxui` = `b3797eb6`** (engine +34, uxui +19 흡수).

- **머지 장소**: `main` 워크트리에 **병렬 GPT 5.6 · momo-main 세션의 미커밋 편집**(`CURRENT_STATE.md`·`JOURNAL.md`·
  `2026-07-28-fable-agent-platform-redteam-review.md`)이 있어, 공유 워크트리를 건드리지 않으려고 **detached 임시
  워크트리에서 머지**한 뒤 push하고 워크트리를 제거했다. 남의 작업물을 stash/커밋하지 않았다 — 그 6개 파일은
  ff-only pull 이후에도 그대로 남아 있다.
- **충돌 1건**: `STATUS.md` — 두 트랙이 각자 앞머리에 섹션을 덧붙인 형태라 **양쪽 전부 보존**(engine 블록 → uxui 블록).
  rerere에 해상이 기록됐다.
- **머지 지점 원점 검증(전부 green)**: server build + **349 tests** · NotifierWorker build + tests ·
  WorkHostDaemon build + **32 tests(3 skip)** · web typecheck + **Vitest 909** + production build ·
  **Playwright 게이트 6종**(wire·shell·csp·huddle·my-sessions·agent-hub) · 마이그레이션 번호 043–049 유일.
- **미실행 3종**: `gate:resume`·`gate:seq`·`gate:inject`는 실행 스택 + `MOMO_EMAIL/PASSWORD`가 필요한 통합
  게이트라 자격증명 부재로 즉시 종료(코드 실패 아님). 실스택 검증은 별도 구간에서.
- **JOURNAL 항목은 의도적으로 보류** — 병렬 세션이 같은 파일을 편집 중이라 덮어쓰기를 피했다. 그 세션의 편집이
  랜딩된 뒤 이 기록을 `JOURNAL.md`로 옮긴다.
- **주의(병렬 세션 어긋남)**: 그 세션의 재계획은 #876~#878을 "유일한 active 배치"로 잡고 있으나 해당 배치는 이미
  랜딩됐고 후속 #882·#887까지 main에 들어왔다. 중복 착수 위험 — 통합 전 정합 확인 필요.

## 8. 2차 main 반영 (2026-07-29, 성재 "main 반영도 가능하면 같이")

**결과: `main` = `track/engine` = `track/uxui` = `ff1e9066`** (engine의 #886·#890·#891 + ADR-0140~0144 흡수).

- 머지 지점 검증(전부 green): server build + **349 tests** · NotifierWorker · WorkHostDaemon · 마이그레이션 번호 043~053 유일. **웹은 diff 0이라 게이트 생략**(근거: `git diff origin/main..HEAD -- clients/web` 빈 결과).
- ADR 상태: **0142·0143 Accepted**(성재 승인) · **0144 Proposed**(oort Cloud substrate — Kata microVM·이미지/캐시·샌드박스 내 LLM 로그인). 0141은 계속 보류.
- 병렬 GPT 세션의 미커밋 6건은 이번에도 detached 워크트리 머지로 보존.
- 다음 배치 후보(성재 트리거 대기): ①ADR-0142 이행+#892 재개(어댑터·E2B 제거·T-4 수렴 한 배치) ②ADR-0143 이행(workstream 마이그레이션+재개 자격 확장) ③ADR-0144 승인 시 PoC(베어메탈 1노드 Kata 실측). 워커 모델 = **Claude Opus medium**.
