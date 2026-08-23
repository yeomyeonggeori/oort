# E2E D8 — 데스크탑 실접속 검증 증거 (2026-08-23, Fable 대행)

성재 지시("너가 직접 데스크탑 제어해서 수행")로 Fable이 로컬 맥에서 직접 수행한 D8 런의 전 과정 스크린샷.
대상 서버: `https://cursor.tailb1aad3.ts.net` (그록봇 VM 셀프호스트 스택 + Tailscale Funnel).

## 판정 요약
- **GREEN**: dmg 공증(Notarized Developer ID·stapler PASS) → 설치 → 실행 → 서버 주소 입력 → claim 비번 설정(1회용 토큰 소비) → owner 로그인 → 첫 메시지 REST 전송·렌더 → **T-5 그록봇 감지 CTA 실환경 노출**.
- **P1 발견(실시간 레일 RED)**: 로그인 응답 `realtimeWebSocketUrl=ws://localhost:8088/connection/websocket` — `self_host_env.sh:796` 기본값이 터널 모드를 모름. 클라는 ADR-0110대로 verbatim 사용 → 원격 데스크탑이 자기 localhost로 WS 시도 → 실패("다시 연결하지 못했습니다"). R-2에서는 스택이 검증 머신과 동일 호스트라 우연히 통과(가림막). **Funnel 자체는 WS 101 통과 실측** — VM env `MOMO_CENTRIFUGO_WS_URL=wss://cursor.tailb1aad3.ts.net/connection/websocket` 재설정+api 재기동으로 수리 가능.
- 소견(폴리시): 셀프호스트 owner 계정 표시명이 시드 기본값 "데모 사용자/@demo"로 노출 — 첫 소유자 온보딩에서 이름 설정 단계 부재.

## 샷 목록 (번호순)
| 파일 | 내용 |
|---|---|
| d8-01-dmg-mounted | 릴리스 v0.1.1 dmg 마운트(oort.app) |
| d8-02-first-launch | 설치 후 첫 실행 — 기존 로컬 데모 세션 잔존 상태(테스트 머신 특수성) |
| d8-03-add-server | 좌측 "+"는 서버 추가가 아니라 워크스페이스 추가임을 확인(탐색 기록) |
| d8-04-login-screen | 로그아웃 후 로그인 화면(서버 주소·이메일·비밀번호·desktop 0.1.0) + 로컬네트워크 시스템 권한 |
| d8-05-server-entered | Funnel URL 입력 완료 상태 |
| d8-06-claim-page | claim URL 접속 — 첫 비밀번호 설정 폼(토큰 유효) |
| d8-07-claim-submitted | claim 제출 직후 — 웹 세션 성립·워크스페이스 진입 |
| d8-07b-claim-web-session | 웹 계정 화면 — owner 세션(데모 사용자/@demo 시드명) |
| d8-08-login-filled | 데스크탑 로그인 폼(이메일+비밀번호 채움) |
| d8-09-logged-in | **데스크탑 owner 로그인 성공** — Funnel 서버 워크스페이스 렌더 |
| d8-09b-general-channel-ws-banner | general 채널 + 실시간 연결 실패 배너(P1 증거) |
| d8-10-first-message | 첫 메시지 입력 상태(Enter 미전송 — 전송은 버튼 클릭) |
| d8-10b-first-message-sent | **첫 메시지 전송·렌더 성공**(REST 경로 GREEN) |
| d8-11-agents-tab | 에이전트 0명 + **"그록봇을 팀에 초대할까요?" 감지 CTA**(T-5 실환경 작동) |
| d8-12-grokbot-relay-sent | 그록봇 릴레이 전송(성재 지시 — WS 수리+온보딩 단계별 캡처) |
| d8-13-realtime-reconnected | 수리 직후 재연결 시도(구 세션은 구 WS URL 보유 — 재로그인 필요 확인) |
| d8-14-relogin-realtime | 재로그인 성공 — **실시간 실패 배너 소멸** |
| d8-15-live-delivery | **폐곡선 증명**: REST 201로 쏜 메시지가 열려있는 데스크탑 채널에 라이브 도착(15:59)+프레즌스 점등 |
| d8-16-grokbot-fix-and-captures-reply | 그록봇 회신 전문 — env 2줄 수리·재생성·healthz 200 + 온보딩 캡처 01~18 목록·INDEX.md |

## P1 즉석 완화 폐곡선 (2026-08-23 15:53~15:59)
릴레이(15:53) → 그록봇 env 수리+컨테이너 재생성(≈1분) → 로그인 응답 `wss://cursor.tailb1aad3.ts.net/connection/websocket` 실측(15:54) → 데스크탑 재로그인 → **REST 발신 메시지 라이브 도착**(15:59). 원천 수리는 ADR-0167(Proposed)·T-9=#1678로 별도 트랙.

크레덴셜·claim 토큰 원문은 소비 후 무효화된 것만 화면에 존재(ADR-0004 정합). 비밀번호는 별도 채널로 성재에게 전달.
