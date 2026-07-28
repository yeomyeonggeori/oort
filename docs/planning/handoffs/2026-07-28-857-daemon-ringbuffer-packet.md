# goal #857 — MOMO-649: 데몬 셸 래핑 PTY + 링버퍼 + attach replay (ADR-0139 D1/D2)

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`** (#856 랜딩분 포함 — 최신에서 시작해라). 모델: gpt-5.6-sol medium.

## 0. 착수 전 필수
1. `git status` clean. 2. 자격증명·`.env` 금지. 3. **PR 후 STOP.** 4. docker·실왕복은 오케스트레이터. 5. **심볼은 grep으로 실재 확인.**

## 1. 결정 정본 (ADR-0139 D1/D2 — 바꾸지 마라)
- **셸 래핑**: `create`가 도구를 로그인 셸 안에서 실행. 도구 종료 → 셸 프롬프트 유지 + 세션 `idle` 보고. 재부착 후 재기동 → `running` 보고.
- **링버퍼**: PTY별 256KiB(상한 설정 가능). `connect(ptyID)` 시 **replay 후 라이브** — 중복·유실 없는 이음새를 **프로토콜로 계약 고정**(replay 종료 마커 등, 설계 근거를 커밋에).
- **서버·relay는 바이트 비경유 유지**(ADR-0125 D10). 링버퍼 서버 영속 금지(기각된 안).
- 소유자만 입력 — 기존 observation 규칙 재사용.

## 2. 검증된 출발점
- 데몬: `workers/WorkHostDaemon/Sources/WorkHostDaemon/`(ProcessManager·WorkDaemon·WorkHostAPIClient) + `MomoACPHost/LocalPTYTerminalManager.swift`(PTY 관리 실체) + `CMomoPTY`(C shim). **현재 스크롤백 버퍼 0건.**
- PTY 계약 정본: `TerminalAttachRoutes.swift` 주석 — `create`/`connect(ptyID)`/`send_stdin`/`resize`/`kill`. `connect`는 재spawn 없이 attach.
- **#856이 랜딩한 전이 REST**: 호스트 서명(PATCH `/v1/workspaces/:ws/work-sessions/:session`)으로 `{"status":"idle","exitCode":N}` / `{"status":"running"}`. `WorkHostAPIClient.swift:176,189`에 PATCH 선례. 서명 페이로드 형식은 `verify_work_session_idle.sh:160`이 실동 예시다.
- 웹 소비자: `ObserverTerminal.tsx`/`observerStream.ts` — 이음새에서 xterm이 깨지면 안 된다.

## 3. 할 일 (커밋 분리)
1. **셸 래핑**: 도구 종료를 감지해(자식 프로세스 exit, 셸은 생존) idle 보고 + exit code 전달. 재부착 세션에서 새 명령/도구 시작 감지 → running 보고. **무엇을 "도구"로 보는가의 판정 규칙을 주석으로**(셸 내 ls 한 번에 running 왕복이 나면 소음이다 — 판단하고 근거를 적어라).
2. **링버퍼**: PTY별 256KiB 링. `connect` 시 버퍼 replay → 종료 마커 → 라이브. 상한 초과 시 오래된 것부터 탈락.
3. **idle 유지·정리**: idle 중 PTY·workdir 보존. kill/end 시 정리. **데몬 재시작으로 살릴 수 없는 세션은 정직하게** — 서버에 보고할 수단이 있는지 확인하고 없으면 orphan sweep에 맡기는 판단을 적어라.
4. T3 pause 접합 자리는 **주석만**(#859).

## 4. 검증
- 데몬 테스트: 도구 종료→idle 보고 · 재부착 replay가 종료 직전 출력 포함 · 이음새 무중복·무유실 · 링 상한 탈락 · 소유자 외 입력 거부.
- **red proof**: replay를 끄면 재부착 단정이 빨개진다. 절차 명시.
- 실왕복(데몬↔서버↔웹 xterm)은 오케스트레이터 — 절차를 PR에.
- **주의(오케스트레이터가 이번에 확인한 것)**: 서버 payload의 UUID는 대문자다. 셸/검증에서 텍스트 비교 시 lower() 정규화해라.

## 5. PR
`feat/857-momo-649-daemon-ringbuffer` → `track/engine`. 본문: 도구 판정 규칙, 이음새 프로토콜, 재시작 의미론, 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
