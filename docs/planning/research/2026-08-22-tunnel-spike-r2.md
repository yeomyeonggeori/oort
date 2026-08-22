# R-2 터널 실측 스파이크 — cloudflared quick tunnel × 로컬 oort 스택 (PLN-20260822-01)

> 2026-08-22 Fable 직접 실측. 로컬 셀프호스트 스택(momo-tracks/engine, `self_host_env.sh --compose up -d --wait`, 전 컨테이너 healthy) + `cloudflared tunnel --url http://localhost:8088`(quick tunnel, 계정 불요).

## 실측 결과

| 항목 | 결과 | 판정 |
|---|---|---|
| HTTP 루트(로그인 화면) | 200, 0.86s | GREEN |
| `/v1/mcp/agent-port` POST | **401**(표면 정상 — 에이전트 합류 경로가 터널을 통과) | GREEN |
| WS 핸드셰이크+프레임 (`/connection/websocket`) | 무Origin·`http://localhost:8088` Origin → **101+프레임 왕복 성립** | GREEN |
| WS with 터널 Origin | **403 Forbidden**(Caddy 경유 우리 스택 도달 후 거부 — Centrifugo `allowed_origins`) | 설정 사안(아래) |
| WS 왕복 지연 | 터널 중앙값 **13ms**(로컬 0ms, CF ICN 엣지) | GREEN — 메시징 무시 가능 |

## Origin 판정 (결정적)

- Centrifugo `CENTRIFUGO_ALLOWED_ORIGINS` 기본값에 **`tauri://localhost`·`http://tauri.localhost` 포함**(infra/rust/docker-compose.rust.yml:87) + API CORS는 #1614(T-A)가 셀프호스트 env에 tauri 2종 기본 반영.
- ⇒ **데스크탑 앱(Tauri)으로 터널 URL 접속 = 무설정 통과 예상**(Origin이 터널 도메인이 아니라 tauri://localhost).
- **웹 브라우저로 터널 URL 접속만** Origin 주입 필요(`CENTRIFUGO_ALLOWED_ORIGINS`+`MOMO_CORS_ALLOWED_ORIGINS`에 터널 URL 추가) — quick tunnel URL은 기동마다 무작위라 T-2 플레이북에 "터널 기동 후 URL을 env에 주입하고 해당 서비스 재기동" 순서 또는 v1은 데스크탑 전용으로 한정.

## 후보 비교 (요약)

| 후보 | 계정 | URL 고정 | TLS | 실측 | 권고 |
|---|---|---|---|---|---|
| **cloudflared quick tunnel** | 불요 | ✗(기동마다 변경) | 자동 | **본 스파이크 전면 GREEN** | **v1 채택** — 체험 위상과 정합 |
| cloudflared named tunnel | CF 계정+도메인 | ✓ | 자동 | 미실측 | 상시 호스트 승격 시 |
| tailscale funnel | TS 계정 | ✓ | 자동 | 미실측 | 계정 마찰로 v1 제외 |

## 함의

1. **R-2 게이트 GREEN**: quick tunnel로 데스크탑 클라이언트 E2E가 전송 계층에서 성립. D4 결정 충족.
2. URL 휘발성(터널 재기동·VM 재시작 시 변경)은 체험 위상 고지+T-4 백업 경로와 결합해 수용. 데스크탑 앱의 "서버 주소 변경" UX가 부드러워야 함(재접속 화면) — T-5/T-6 설계 입력.
3. 검증 잔여: 실 데스크탑 앱 빌드로 터널 URL 로그인 1회(수용 런에 포함, 전송 계층 근거는 본 스파이크로 충분).

## 위생

실측 후 tunnel 프로세스 종료·스택 down(볼륨 보존 — 성재 8/21 상태로 복원).
