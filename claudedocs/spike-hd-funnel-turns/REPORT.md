# SPIKE-HD 실행 리포트 — Funnel TLS 종단 TCP로 LiveKit 내장 TURN (#1792)

> 실행 체계(성재 승인 2026-08-27): VM 내부=그록봇(자연어 릴레이, grok.com D8 대화) · 외부 망 관측=Fable(로컬 맥, tailnet 밖) · 최종 2대 왕복=성재 폰 LTE.
> 시크릿·연결 값은 이 문서에 싣지 않는다. VM 호스트명은 이미 릴레이 킷 정본(claudedocs/e2e-d8-desktop-20260823)에 기재된 값을 따른다.

## 단계 현황

| # | 단계 | 상태 | 실측 |
|---|---|---|---|
| 0 | VM oort 도달성 | ✅ | `GET /healthz` 200, `database: ok` (외부 망, 1.77s) — 8/26 "D8 응답 없음"은 해소 |
| 1 | Funnel 8443 수락 | ✅ | 그록봇 관측(릴레이 1): `<host>:8443 → tcp://127.0.0.1:8443` 매핑 실존(HTTP Funnel `/`→8088 별도 유지). 로컬 8443 리스너 = **예전 TLS 프로브 파이썬 더미**(내 2단계 악수를 받아준 정체) — 백엔드만 더미→LiveKit 교체하면 됨 |
| 2 | **외부 망 TLS 악수 (급소)** | ✅ **PASS** | `openssl s_client -connect <host>:8443 -servername <host>` → `subject=CN=<host>` · `issuer=Let's Encrypt YE2` · `TLSv1.3, Cipher TLS_AES_128_GCM_SHA256` · `Verify return code: 0 (ok)` (2026-08-27, 로컬 맥 외부 망) |
| 3 | livekit.yaml turn + JoinResponse `turns:` 광고 | ⏳ | 릴레이 1 (VM 내부) |
| 4 | 외부 브라우저 candidate pair=relay/tls | ⏳ | Fable 브라우저 자동화 (릴레이 1 완료 후) |
| 5 | 서로 다른 망 2대 오디오 왕복 | ⏳ | Fable 맥 + 성재 폰 LTE |
| 6 | 60분 soak (1001 드롭 재현 여부) | ⏳ | Fable 관측 루프 |
| 7 | 3·5인 대역폭 | ⏳ | 5 성립 후 |

## 릴레이 1 관측 (그록봇, 2026-08-27 저녁)

- livekit.yaml turn = 주석 예시만(`tls_port: 5349`). **rust 스택에 LiveKit 컨테이너 미기동**(compose huddle 프로파일 실존·미사용) · `MOMO_LIVEKIT_URL` 미설정 — 이 스파이크가 VM 허들의 첫 기동이 된다.
- 시그널 경로: 웹은 join 응답 `livekitUrl`로 시그널에 직결(Caddy는 /v1·/healthz·/connection만 프록시). → **릴레이 2 설계 = 같은 오리진 `/livekit` handle_path 프록시(CSP 무변경) 우선, 폴백 funnel :10000(+CSP)**.
- 그록봇 규율 관측: 5~8 자가 중단·보고("더미가 8443을 잡고 있어 yaml 안 고침") — 관측/적용 분리 정확.

## 판정 메모

- 2단계 선통과의 의미: "turns:는 진짜 TLS라 Funnel을 통과할 수 있다"는 P1의 핵심 가설 중 **엣지 물리는 실증**됐다. 남은 불확실성은 ①엣지→VM 로컬 8443 포워딩이 LiveKit TURN TCP와 정합하는가(external_tls 계약) ②TURN allocate/permission 왕복이 TLS 종단 뒤에서 성립하는가 ③soak 안정성.
- 8443이 스파이크 전부터 열려 있던 점은 릴레이 1의 관측 항목(기존 매핑이 있으면 그 용도 확인 후 진행 — 덮어쓰기 금지).

## 증거

- 2단계 openssl 원출력: 세션 로그(2026-08-27). 재실행 명령은 실행 시트(RELAY.md) §외부 관측 참조.
