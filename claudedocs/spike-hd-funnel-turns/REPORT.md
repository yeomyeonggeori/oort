# SPIKE-HD 실행 리포트 — Funnel TLS 종단 TCP로 LiveKit 내장 TURN (#1792)

> 실행 체계(성재 승인 2026-08-27): VM 내부=그록봇(자연어 릴레이, grok.com D8 대화) · 외부 망 관측=Fable(로컬 맥, tailnet 밖) · 최종 2대 왕복=성재 폰 LTE.
> 시크릿·연결 값은 이 문서에 싣지 않는다. VM 호스트명은 이미 릴레이 킷 정본(claudedocs/e2e-d8-desktop-20260823)에 기재된 값을 따른다.

## 단계 현황

| # | 단계 | 상태 | 실측 |
|---|---|---|---|
| 0 | VM oort 도달성 | ✅ | `GET /healthz` 200, `database: ok` (외부 망, 1.77s) — 8/26 "D8 응답 없음"은 해소 |
| 1 | Funnel 8443 수락 | ✅ | 그록봇 관측(릴레이 1): `<host>:8443 → tcp://127.0.0.1:8443` 매핑 실존(HTTP Funnel `/`→8088 별도 유지). 로컬 8443 리스너 = **예전 TLS 프로브 파이썬 더미**(내 2단계 악수를 받아준 정체) — 백엔드만 더미→LiveKit 교체하면 됨 |
| 2 | **외부 망 TLS 악수 (급소)** | ✅ **PASS** | `openssl s_client -connect <host>:8443 -servername <host>` → `subject=CN=<host>` · `issuer=Let's Encrypt YE2` · `TLSv1.3, Cipher TLS_AES_128_GCM_SHA256` · `Verify return code: 0 (ok)` (2026-08-27, 로컬 맥 외부 망) |
| 3a | VM 배선 완료 | ✅ | 릴레이 2(그록봇): 더미 철거·turn 활성(`portTLS: 8443, externalTLS: true` 로그 실측)·livekit 127.0.0.1:8443/7880 바인드·**시그널=Funnel :10000**(Caddy /livekit 불가 — 컨테이너가 호스트 Caddyfile 미가독+7880 루프백 한정) · `MOMO_LIVEKIT_URL=wss://<host>:10000` · livekit healthy · curl 7880→200 |
| 3b | 시그널 외부 도달 + CSP | ✅ | 외부 curl :10000 → 200 "OK". CSP가 :10000 차단(connect-src에 부재) 실측 → **Fable 자율 릴레이 3**(Grok Bot 데스크탑 앱 직접 제어 — 성재 지시 2026-08-27)로 그록봇이 connect-src에 해당 오리진 1개만 추가·리로드 → 외부 재검증: 헤더에 `wss://<host>:10000` 실림(와일드카드 0) |
| 3c | JoinResponse `turns:` 광고 | 🟠 **마찰 발견** | 그록봇 VM 루프백 join(로그인 불요) 실측: ice_servers에 `turns:cursor.tailb1aad3.ts.net:443?transport=tcp`(username·credential 있음) + stun 3종. **8443 아님, :443으로 광고.** = LiveKit `external_tls:true`가 클라에 443 고정 광고(tls_port는 내부 리슨). 그러나 Funnel 443은 웹(→8088) 점유 → 외부 클라가 turns:443으로 붙으면 TURN이 아니라 웹에 도착. **광고를 8443으로 맞춰야 relay 성립.** 정합 릴레이 발신 |
| 3d | **터널이 TURN 미디어를 나르는가 (스파이크 핵심)** | ✅ **PASS** | Fable 로컬 맥(터널 밖)에서 인증 없는 TURN ALLOCATE over TLS→8443: `type=0x0113`(TURN Allocate Error Resp)·magic 정상·**ERROR-CODE 401**·**REALM=livekit**·NONCE. 웹은 이런 STUN 응답 불가 → **LiveKit 내장 TURN이 Funnel 터널 너머에서 응답 확정**. 401=자격만 있으면 relay 할당. 로그인·계정자격 불요, 순수 프로토콜 증명 |
| 3e | LiveKit 광고 포트 하드코딩 판정 | 🔴 **구조적 제약 확정** | 그록봇: **LiveKit v1.13.3 `external_tls:true`가 `iceServersForParticipant`에서 `tls_port>0`이면 무조건 `turns:<domain>:443?transport=tcp` 방출**(tls_port는 서버 리슨 전용, advertise 필드 없음, 업스트림 #4542=의도된 동작). **8443 광고 불가.** 443은 Funnel 웹 점유 → 광고대로면 브라우저가 웹에 도착. **∴ P1 "zero 코드" 전제 falsified** |
| 4 | 외부 브라우저 candidate pair=relay/tls | ⏸ **차단(구조)** | 광고가 :443이라 실브라우저 join은 웹으로 감. 해소=클라 ICE URL 리라이트(443→8443, 아래 결론) 후에야 가능. 미디어 PATH 자체는 3d로 증명됨 |
| 5 | 서로 다른 망 2대 오디오 왕복 | ⏳ | Fable 맥 + 성재 폰 LTE |
| 6 | 60분 soak (1001 드롭 재현 여부) | ⏳ | Fable 관측 루프 |
| 7 | 3·5인 대역폭 | ⏳ | 5 성립 후 |

## 릴레이 1 관측 (그록봇, 2026-08-27 저녁)

- livekit.yaml turn = 주석 예시만(`tls_port: 5349`). **rust 스택에 LiveKit 컨테이너 미기동**(compose huddle 프로파일 실존·미사용) · `MOMO_LIVEKIT_URL` 미설정 — 이 스파이크가 VM 허들의 첫 기동이 된다.
- 시그널 경로: 웹은 join 응답 `livekitUrl`로 시그널에 직결(Caddy는 /v1·/healthz·/connection만 프록시). → **릴레이 2 설계 = 같은 오리진 `/livekit` handle_path 프록시(CSP 무변경) 우선, 폴백 funnel :10000(+CSP)**.
- 그록봇 규율 관측: 5~8 자가 중단·보고("더미가 8443을 잡고 있어 yaml 안 고침") — 관측/적용 분리 정확.

## 스파이크 결론 (2026-08-28)

**P1(Funnel TLS 종단 TCP → LiveKit 내장 TURN)은 미디어 도달 경로로 성립한다** — 터널이 TURN을 나르는 것을 외부에서 로그인·자격 없이 증명(3d, REALM=livekit·401). 급소(2)·시그널(3b)·TURN 프로토콜(3d) 전부 그린.

**단, 원래 "서버 0줄·웹 0줄" 전제는 깨졌다**(3e): LiveKit v1.13.3가 클라 광고 TURN 포트를 443으로 하드코딩하는데 443은 웹이 점유한다. 해소 후보(구현 티켓 대상):

1. **클라 ICE URL 리라이트(권장·최소)**: 웹 클라가 JoinResponse의 `turns:<host>:443` 항목 포트를 `8443`으로 리라이트(같은 host·같은 credential — TURN long-term cred는 포트 비종속, 서버는 8443에서 실응답). `huddleRuntime.ts`가 현재 ICE 미주입(RA-8 §6.3)이라 주입점 신설 = 소규모 웹 변경 1건.
2. **443 TCP 디먹서(zero 앱코드 유지·인프라 1개 추가)**: 443에서 첫 바이트로 HTTP vs STUN magic cookie(0x2112A442) 분기 → 웹/TURN 분리. 컴포넌트 추가 비용.
3. LiveKit 업그레이드로 advertise 포트 필드가 생기면 설정만으로 해소(상류 의존).

**결정 입력**: P1은 폐기가 아니라 **"소규모 클라 리라이트 1건이 붙는 P1"**이다. 성재 사전결재(P1 실패→P2 운영자 TURN)의 "실패" 조건에 해당하지 않음 — P1이 P2(셀프호스터가 TURN을 별도 기동)보다 여전히 가볍다(후보 1은 웹 1커밋). ADR/구현 티켓에서 후보 1 vs 2 택일.

**미완(구조 차단분)**: 4·5(실브라우저 relay/tls·2대 오디오 왕복)는 광고 :443 때문에 리라이트 전에는 불가 — 미디어 PATH는 3d로 증명됐으므로 구현 티켓의 검증 단계로 이월.

## 판정 메모

- 2단계 선통과의 의미: "turns:는 진짜 TLS라 Funnel을 통과할 수 있다"는 P1의 핵심 가설 중 **엣지 물리는 실증**됐다. 남은 불확실성은 ①엣지→VM 로컬 8443 포워딩이 LiveKit TURN TCP와 정합하는가(external_tls 계약) ②TURN allocate/permission 왕복이 TLS 종단 뒤에서 성립하는가 ③soak 안정성.
- 8443이 스파이크 전부터 열려 있던 점은 릴레이 1의 관측 항목(기존 매핑이 있으면 그 용도 확인 후 진행 — 덮어쓰기 금지).

## 증거

- 2단계 openssl 원출력: 세션 로그(2026-08-27). 재실행 명령은 실행 시트(RELAY.md) §외부 관측 참조.
