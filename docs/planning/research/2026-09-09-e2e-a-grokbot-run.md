# E2E-A 실측 — 그록봇 VM 설치·합류·답장·해제 (2026-09-09, planner Fable 제어)

> 1차 목표 두 케이스 §4 G1'-4 **E2E-A**(#1361). 제어 = CDP 읽기/쓰기(SH-8 하네스) + OS Return 키(성재 `Bash(osascript:*)` 허용, 로컬 테스트 한정 결재) + chrome-devtools 브라우저 세션(사람 단계 대행). 실측 원문 `claudedocs/e2e-a-2026-09-09/LOG.md`(세션 로컬). 앱 Grok Bot 0.44.0(`com.anysphere.sand`).

## 1. 결과
| 단계 | 판정 | 실측 |
|---|---|---|
| README 붙여넣기 블록 → 봇이 §0 계약대로 설치 | **PASS** | 16:37 전송 → 즉시 착수(Docker Engine+Compose → 스냅샷 → `/workspace` pgdata → claim env) |
| VM 환경 | 이탈 A1·A3·A4 | overlayfs 불가 → `vfs` · bridge/iptables 차단 → host network 우회 · env DB 호스트 손수정 |
| doctor PASS · 공개 주소 · 핸드오프(§3.3.10~14) | **PASS** | 16:52 doctor PASS · cloudflared quick tunnel(로컬 테스트 고지) · Tunnel+Claim URL 한 메시지 · 첫 백업 dump |
| 외부 도달(planner Mac) | PASS | `/healthz` 200 · `/v1/centrifugo/*` 403 · index 스탬프 `e39e9427` |
| claim → 로그인 | PASS | 첫 비밀번호 설정 → 앱 셸(데모 워크스페이스·데모 사용자 = **제로베이스 아님**, §3) |
| Agent Port 합류(§3.3.16) | **PASS** | 위저드 연결 값 → 봇 discover 200 → `detected`(10초) → 사람 확인(채널 2·권한 4) → active 자격 → discover 200 → **`active`** 17:08:08 |
| 멘션 → 인박스 → 답장(§3.3.17.4 도구) | **PASS** | 게이트 true → `@grokbot` seq 1 → inbox event 2 → **답장 seq 2** 17:12:32 |
| 스케줄 트리거(§3.3.17.5) | **미발화 — A8** | `oort-inbox-sweep` @every 15m enabled 17:17 → 24분간 run history 비어 있음(봇 보고) |
| 도어벨(§3.3.17.1~3) | 보류 — A7 | 루틴 생성됨, URL·sender key는 앱 Info pane 전용(봇 이행 불가) |
| disconnect(HAP-E6) | 진행 | `POST …/disconnect` 200 → `cleanup_pending`, 매니페스트 10행 → 봇 정리 → acknowledge → complete → 잔여 확인(옛 자격 401) — 결과는 §4 |
| VM Update/Reset 복구 | 미실행 | 후속 |

## 2. 이탈 → 처리
| # | 종류 | 내용 | 처리 |
|---|---|---|---|
| A1/A3/A4 | 문서 | 그록봇 VM Docker 전제(overlayfs·bridge) 미기술, 봇이 vfs·host network·env 손수정으로 우회 | §3.3 「VM Docker 점검·대안」 절 + env 손수정 금지 규율과의 정합 → 티켓 |
| **A5** | **릴리스** | 그록봇 경로 = 발행 이미지 **v0.1.4(09-02 main)** → SH-6a-w 자격 화면·UX-R2c·D9 기본값 미포함 | **v0.1.5 발행**(성재: 제로베이스 온보딩 구조로 작업 뒤) |
| A6 | 카피 | v0.1.4 위저드 4단계 이름 보간 공백 | 현행 main 확인 후 잔여 티켓 |
| A7 | 문서 | §3.3.17.1 「afterwards tell me the webhook URL, sender key」 — 앱 UI 전용이라 봇 이행 불가 | 사람 승인 지점으로 정정(ADR-0184 D2) |
| **A8** | **벤더** | 스케줄 루틴 24분 미발화 | #1361 지침대로 **제품 카피를 manual-run 수준으로 제한**, 재실측 |
| 전송 | 도구 | OS Return은 Grok Bot 창의 Space가 다르면 실패 → `open -a` 뒤 Return | 하네스 README 메모 |
| 온보딩 | **방향** | 데모 워크스페이스/데모 사용자 경유 = 제로베이스 온보딩 아님(성재 지적) | **SH-12 제로베이스 온보딩** 패킷 |

## 3. #1361 수용 기준 대조
1 Provenance: 앱 0.44.0·bundle 기록, 구매/과금 변경 0. **2 Pair: 충족**(modern era, pairing→detected→사람 확인→별도 active→active; raw secret은 문서가 정한 자리에서만). **3 Reply: 수동 왕복 충족**, 스케줄 자발 발화 **미충족(A8)** → 카피 제한. 4 Disconnect: §4.

## 4. disconnect 결과
(랜딩 시점 갱신 — LOG 21행 이후)
