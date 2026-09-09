# E2E-B 실측 — 독립 셀프호스팅(로컬 경로, VPS 대역) 2026-09-09 · planner(Fable) 집행

> 1차 목표 두 케이스(`2026-09-07-first-goal-two-cases.md`) §4 G1'-4 **E2E-B**. Railway 경로는 성재 결재(09-08)대로 최종 검증 단계에 두고, 오늘은 문서 `docs/SELF_HOST.md`(main `586b6580`→`4959566b`) 문장을 **그대로** 따라 로컬 Docker(Colima)에서 실행했다. 실측 원문은 `claudedocs/e2e-b-2026-09-09/LOG.md`(세션 로컬).

## 1. 결과 요약
| 단계 | 판정 | 핵심 실측 |
|---|---|---|
| 전제·클론·env 생성(§1~2, +`--allow-local-provider`) | PASS | 사용 중 포트 자동 회피(8089/8081/8001), 비밀번호 stdout 미출력 |
| bring-up(§3) | **FAIL → 우회** | 웹 스테이지 `MOMO_BUILD_SHA` 미전달로 실패(**D2**, ##2258). `--compose build --build-arg` 우회 뒤 PASS: 스탬프 40자, doctor PASS(27/0/5) |
| 로그인(§4) | PASS(REST) | 2인째는 초대 코드 → `POST /v1/join` 201 |
| AI 연결(§5, 로컬 mock hermes) | **PASS** | `PUT /v1/provider/link` 200 — SH-6a-e opt-in 성립 |
| 에이전트 생성·초대·첫 멘션·답장 | **PASS** | 멘션 seq 1 → 답장 seq 2(10s) · 사람 합류 킥오프 seq 5 |
| Agent Port 합류(§3.3.16 curl) | **PASS** | pairing→detected→confirm→active; 무인증 401 |
| 합류 에이전트 멘션→인박스→답장(§3.3.17.4 도구 3종) | **PASS(D9 뒤)** | `MOMO_HOSTED_DELIVERY_ENABLED=true` 필요 — 문서 공백 |
| day-2 upgrade(`oort upgrade --local-build`) | **FAIL** | 백업 PASS 뒤 `compose pull`로 실패(**D10**, #2260) |
| day-2 backup | PASS | upgrade의 백업 단계로 실측 |
| 폰 QR·푸시 | 보류 | 성재 결재(APNs는 데스크톱 뒤) |

## 2. 이탈 → 처리
| # | 종류 | 내용 | 처리 |
|---|---|---|---|
| D1 | 문서 | 생성기가 옛 `oort-pgdata` 볼륨을 「채택」할 때 확인 안내 없음 | #2263 |
| D2 | **결함** | 로컬 빌드 경로 웹 스테이지 스탬프 검사 실패(오버레이 args 부재) | **#2258**(워커 진행) |
| D3 | 환경/문서 | Docker VM 미공유 경로 클론 시 bind mount 실패 → 홈 아래 클론 안내 | #2263 |
| D4 | 후속 | 플러그인 경로 검증기가 Swift 패키지를 띄움(문서가 자인) | 후속 티켓(SH-9 승계분) |
| D5 | 문서 | OpenAPI `CreateAgentRequest.baseUrl` 설명이 SH-6a-e 이전 규칙 | #2263 |
| D6 | 문서 | §5 「새 멤버 join」 트리거 = 사람 합류(ADR-0181 D2), 에이전트 초대 아님 | #2263 |
| D7 | 계약 | `POST /channels/{ch}/members`가 OpenAPI에 없음(본문 `memberId` 단수) | #2263 |
| D8/D11 | 판정 | doctor 첫 실행 outbox skip(postgres exec) · status가 relay 미구성 `push_candidate` pending을 fail | **#2264** |
| D9 | **결정** | 셀프호스트 env 기본 `MOMO_HOSTED_DELIVERY_ENABLED` off → Agent Port 합류 뒤 도구 0. 문서(케이스 B) 공백 | 문서 #2263 + **성재 결정**: 생성 env 기본 `true`로 할지 |
| D10 | **결함** | `oort upgrade --local-build`가 build 대신 pull → 실패, 롤백 안내가 같은 명령 | **#2260** |

## 3. 판정
케이스 B의 **핵심 폐곡선(설치 → 로그인 → 본인 provider → 킥오프/멘션 답장 → 외부 에이전트 Agent Port 합류 → 멘션 답장 → 2인 합류)은 문서 명령만으로 닫혔다.** 출시 전 반드시 고칠 것 = D2·D10(설치·업그레이드 경로 결함) + D9(게이트 기본값 결정). 나머지는 문서·판정 정확성.
