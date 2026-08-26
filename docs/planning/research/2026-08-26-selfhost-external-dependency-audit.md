# 셀프호스트 외부 의존 전수 감사 (2026-08-26)

> 발제: 성재 — "그록봇 VM에 셀프 호스트 이미지로 허들이나 모든 기능이 가능한 구조인거지? **우리 서버를 사용자가 타야하는 부분이 있는지 진단해줘.**"
> 감사 범위: `infra/rust/*`(현행 셀프호스트 스택) · `server-rust/` · `clients/` · `packages/momo-core/` · `scripts/self_host_env.sh` · `docs/SELF_HOST*.md`.
> 코드 수정 0건 (read-only 감사).

## 한 줄 답

**"우리 서버를 타야 하는 부분"은 4곳이고, 그중 런타임에 강제되는 것은 실질 1곳(데스크톱 자동 업데이트)뿐이다.** 이미지 pull은 local-build 대안이 있고, 푸시는 기본 스택에 아예 없으며(우리 앱을 쓸 때만 구조적으로 강제), display TURN은 문면만 oort 전용이고 코드는 이미 자기 coturn을 받는다. **허들은 oort를 타지 않는다 — 대신 TURN이 없다.** 텔레메트리·분석·에러 리포팅·과금 콜백은 **한 건도 없다.**

---

## ① 판정표

분류: ①완전 자립 · ②제3자 필요(우리 아님) · ③**oort 서버/도메인 필요** · ④불명

| # | 기능 | 판정 | 근거 |
|---|---|---|---|
| 1 | **허들(음성/LiveKit)** | ①자립 (단, TURN **부재**) | `infra/rust/docker-compose.rust.yml:110-149` (profile `huddle`, `livekit/livekit-server:v1.13.3`). `infra/livekit.yaml:15-19` — **TURN 블록 전체가 주석**: "TURN is deferred until a public domain and TLS certificate exist". 자격은 운영자 env(`MOMO_LIVEKIT_API_KEY/SECRET/URL`), 셋 중 하나라도 비면 허들 REST 4개가 503 `허들 미구성`. **oort 주소 0** |
| 2 | **실시간(Centrifugo)** | ①자립 | `docker-compose.rust.yml:73-107` — `centrifugo/centrifugo:v6`, in-memory 엔진. `app.oor7.com`이 `infra/centrifugo.json:84` allowed_origins에 있으나 **우리 배포용 허용목록**이고 셀프호스트는 env `CENTRIFUGO_ALLOWED_ORIGINS`가 덮어쓴다 |
| 3 | **푸시(APNs)** | ③oort 필요 (구조적·조건부) | ADR-0120 D1-A: `.p8`는 App Store 배포자만 → "모든 셀프호스트 서버는 Dawn 운영 relay 경유". **단 코드상 강제 아님**: `PUSH_RELAY_URL` 자기 relay 지정 가능(`docs/PUSH_RELAY_RUNBOOK.md:78-82`), relay는 레포 안 오픈소스(`relay/PushRelay/`). 기본 스택엔 푸시 오버레이 자체가 **없음**. Android/FCM 미구현 |
| 4 | **데스크톱 자동 업데이트** | ③**oort 필요 (하드 배선)** | `clients/desktop/src-tauri/tauri.conf.json:33-40` — endpoints = `https://yeomyeonggeori.github.io/momo-alpha/update-next.json`, pubkey는 우리 minisign 키. **빌드타임 baked — env로 못 바꾼다** |
| 5 | **컨테이너 이미지 pull** | ③oort 필요 (선택 — 대안 있음) | `scripts/self_host_env.sh:90,201` — `--published-image`는 정규식 `^ghcr\.io/yeomyeonggeori/oort@sha256:[0-9a-f]{64}$`로 **우리 레지스트리만 수용**. **대안이 1급**: `--local-build`가 현재 checkout을 굽는다 |
| 6 | **링크 언퍼얼** | ①자립 (fetch 대상만 제3자) | 기본 OFF. fetch 주체는 셀프호스트 `webhook-sender` 자신(UA `oort-unfurl/1`), 이미지도 **자기 서버 프록시**. **oort 프록시 0** |
| 7 | **첨부/Drive** | ①자립이 **기본** | 기본 = `MOMO_DRIVE_ARCHIVE_BACKEND=local` + 볼륨. google 백엔드는 옵트인 — **제3자, 우리 아님** |
| 8 | **그록봇/에이전트 연동** | ①자립 (우리 서버 **비경유**) | Agent Port = 셀프호스트 api 자신의 `/v1/mcp/agent-port`. 도어벨은 **우리 서버 → 사용자 루틴 webhook** POST(ADR-0171). LLM은 사용자가 넣은 endpoint를 자기 DB에 암호화 저장 후 agent-worker가 직접 호출. 벤더 의존은 그록봇(xAI/Cursor) 쪽이고 **oort 서버는 안 탄다** |
| 9 | **터널** | ②제3자 / A트랙은 **미구현** | 현행 v1 = cloudflared quick tunnel(계정 불요, URL 기동마다 변동). **A트랙(oort 릴레이)은 코드에 전무** — `tailscale|funnel|cloudflared` 문자열이 배선으로 없고 문서에만 존재 |
| 10 | **텔레메트리/분석/에러 리포팅** | ①**없음** | sentry/posthog/GA/amplitude/mixpanel 배선 **0건**. 메트릭은 pull-only·compose 사설, 셀프호스트 스택엔 prometheus 자체가 없음 |
| 11 | **라이선스/인증/과금 콜백** | ①**없음** | 외부 라이선스·활성화 콜백 0. `billing`은 T3 내부 사용량 원장 |
| 12 | 초대/딥링크 | ①자립 | `oort://join?server=<자기 서버>&code=`. ADR-0121의 LinkShort는 **prod compose에만** 존재 |
| 13 | **화면 관측·원격조작(display/T3)** | ③oort 필요 (**문면상**) | ADR-0165 D3 + 증보 1·2: 대칭 NAT 실측으로 relay가 유일 ICE 경로, "제3자 TURN 금지 · oort 운영分만 · required". **단 코드는 열려 있다**: `MOMO_TURN_URLS` 등 셋 다 운영자 env고 **호스트 allow-list 검증도 없다**(`config.rs:1521` "not validated against a host allow-list"). 클라 기본 ICE는 **빈 배열**. 우리 TURN 좌표는 **런북에만** 있고 코드 기본값엔 없다 |
| 14 | cubesandbox(클라우드 워크 호스트) | ②제3자/운영자 지정 | `MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL` 필수·기본값 없음. 미설정이면 어댑터 자체가 생성 안 됨 |

### 허들 TURN에 관한 사실 정정
TC-2 문서의 "oort 운영 TURN"은 **허들이 아니라 display(화면) 평면**이다. 허들(LiveKit)과 display(coturn)는 **완전히 별개의 WebRTC 경로**이며, 허들 쪽엔 TURN 배선 자체가 없다. 성재 질문의 "허들"에 대한 답은 **oort TURN을 타지 않는다**이고, 정확히는 **TURN이 아예 없다**.

---

## ② 사용자가 oort를 타는 자리 — 4곳

### (1) 데스크톱 자동 업데이트 — 가장 단단한 배선
`endpoints`+`pubkey`가 빌드타임에 박히므로, **우리 배포 dmg를 쓰는 순간 그 앱은 우리 채널을 폴링한다.** 끊으려면 셀프호스터가 자기 Tauri 앱을 직접 빌드해야 하고, 그러면 자동 업데이트 + 우리 공증 dmg를 잃는다.

### (2) 공개 컨테이너 이미지 pull (GHCR)
`self_host_env.sh:201`이 우리 digest 외 어떤 ref도 거절한다 — **미러·자체 레지스트리 경로가 없다.** `--local-build`로 끊을 수 있으나 불변 digest·SLSA provenance·attestation 검증·multi-arch를 잃는다. 미러를 쓰려면 정규식 완화가 필요하다(**현재는 구조적으로 막혀 있음**).

### (3) iOS/macOS 푸시 relay — 구조적 필연, 다만 기본 스택엔 없음
APNs `.p8`는 App Store 배포자만 보유. 자기 Apple 계정 + 자기 빌드 앱 + 자기 `.p8`이면 `PUSH_RELAY_URL`로 끊을 수 있다. **기본 셀프호스트는 푸시 오버레이를 붙이지 않으므로 기본 상태에서는 우리를 타지도 않는다.**

### (4) display TURN — 문면과 코드의 괴리
ADR-0165가 "oort 운영分만 · required"로 못박았으나 **코드는 이미 자기 coturn을 받는다**(호스트 검증 없음). 즉 "제3자 금지"는 **정책 문면일 뿐 코드 강제가 아니다.** ⇒ **미결 판정 대상(M7).**

---

## ③ 제3자 의존 (우리 아님)

Docker Hub 이미지 4종(`pgvector/pgvector:0.8.5-pg18`·`centrifugo/centrifugo:v6`·`livekit/livekit-server:v1.13.3`·`caddy:2-alpine`, 전부 pin) · GitHub(설치 시점) · cloudflared quick tunnel(계정 불요) · Tailscale Funnel(RA-7 B트랙 = 사용자 자기 tailnet; oort tailnet 모델은 약관 적색) · Let's Encrypt(공개 도메인 시) · Apple APNs(푸시 오버레이 시) · Google Drive API(옵트인) · LLM provider(사용자 지정, ADR-0004 비유입) · ChatGPT OAuth(사용자 선택).

---

## ④ 완전 자립(air-gapped 유사)

**산다**: 메시징 전량(로그인·채널·DM·스레드·멘션·읽음·검색·실시간) · 첨부(local) · 초대/딥링크 · LAN mDNS 발견 · 에이전트 왕복(사설망에 OpenAI 호환 엔드포인트가 있다면) · webhook·도어벨·Agent Port(사설 대상) · 허들(같은 망에서 SFU 도달 가능하면) · 백업/복원/PITR.

**죽는다**: 언퍼얼(기본 OFF라 무변화) · Drive google · 푸시 · 자동 업데이트 · 터널/외부 노출 · display/T3 · 이미지 pull(사전 로드·local-build 필요) · **LLM provider — 현행 코드는 외부 `https://`만 받는다**(`SELF_HOST.md` §5: 로컬 모델 `http://127.0.0.1:...` 경로는 아직 열려 있지 않다) ⇒ **완전 air-gapped에서 에이전트는 사실상 죽는다.**

---

## ⑤ 그록봇 VM만으로 전 기능 테스트 가능한가 — **부분 가능 (전 기능은 불가)**

**가능**: 코어 기동·마이그레이션 59본·claim 부팅·헬스체크 · quick tunnel 외부 도달성 · 메신저 전량 + 첨부(local) + 에이전트 합류 + 도어벨 · 데스크톱 접속(Tauri origin 2종이 기본 허용목록).

**불가 / 제약**
1. **허들 — 사실상 불가.** compose가 signalling 7880·RTC TCP 7881을 **127.0.0.1에만** 바인드하고 UDP 50000-50100만 0.0.0.0. quick tunnel은 HTTP 하나만 나른다 ⇒ 클라가 닿을 `wss://` LiveKit 주소를 만들 수 없고 **UDP 미디어를 나를 수 없다**. 그록봇 VM은 공인 inbound 없음. TURN도 없다.
2. **푸시 — 불가.** APNs 키 + 서명 앱 필요.
3. **display/T3 — 불가.** cubesandbox 호스트 + 별도 공인 coturn 호스트가 전제.
4. **공개 도메인/TLS — 불가.** `infra/rust/Caddyfile:1`이 `app.oor7.com`을 하드코딩해 부팅 즉시 실 ACME 주문이 나간다(2026-08-10 실패 챌린지 4건 실측). 사이트 주소 파라미터화는 **#1239 미결**.
5. 자동 업데이트 — 테스트는 되지만 우리 채널을 탄다.

⇒ **판정**: 그록봇 VM은 **메신저 코어 + 에이전트 + 도어벨의 전 기능 폐곡선**을 낼 수 있다. **허들·푸시·display·공개 TLS는 공인 IP 호스트 없이는 검증 불가.**

---

## ⑥ 미확인 항목

| # | 미확인 | 확인 방법 |
|---|---|---|
| M1 | LiveKit v1.13.3의 `use_external_ip` 기본값과 **내장 STUN 호출 여부**. `infra/livekit.yaml`에 키가 없다 — 기본이 공개 STUN을 부르면 "제3자 의존 0" 판정이 흔들린다 | `--profile huddle up` 후 egress 관측(`tcpdump port 19302`) |
| M2 | 우리 App Store 앱의 device token을 셀프호스터 자체 relay로 발송 가능한가(Team ID/topic 결속) | Apple 문서/실측 |
| M3 | `momo-turn`의 정적 자격 은퇴 여부 — 런북이 "§6 교체 절차는 **아직 수행되지 않았다**"로 표기 | 호스트 `turnserver.conf`의 `user=` 확인 |
| M4 | GHCR 이미지의 재현 빌드 가능성 | 같은 커밋 2회 빌드 digest 비교 |
| M5 | 그록봇 VM에서 LiveKit TCP 7881 강제 경로를 두 번째 터널로 세울 수 있는가 — 성립하면 ⑤-1이 "제약"으로 완화 | 7881을 0.0.0.0 바인드 + 별도 터널 + `verify_huddle_livekit.sh` |
| **M6** | ⚠️ **첨부 업로드가 터널 접속에서 깨질 가능성 — 코드 경로 명확, 런타임 미실측.** 생성기가 `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=http://localhost:<port>`를 **고정 기록**하고 서버가 그 값으로 capability URL을 조립한다(`momo-drive/src/local.rs:229` — **요청 Host에서 파생하지 않는다**). ⇒ 터널로 붙은 원격 클라는 `http://localhost:8088/...`로 PUT하라는 URL을 받는다. `--public-origin`은 이 키를 갱신하지 않는다 | 터널 URL 로그인 → 첨부 업로드 1회. 실패 시 same-origin 파생 티켓 |
| M7 | ADR-0165 D3 "oort 운영分만" vs `config.rs:1521`(호스트 미검증) 괴리 — 정책 미결인지 의도된 유연성인지 | **성재 판정 필요** |
