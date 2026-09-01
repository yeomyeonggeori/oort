# 셀프호스팅 레벨 핵심 피쳐 완결성 감사 (2026-09-01, read-only)

> 실사 대상: `~/projects/momo-tracks/engine`(track/engine @ `c43b1d31`) · `~/projects/momo-tracks/uxui`(track/uxui @ `a6693e3d`) · `gh issue`.
> 판정 기준: **"셀프호스트 오퍼레이터가 `docs/SELF_HOST.md`를 그대로 따라 compose로 띄웠을 때 온전히 동작하는가"**.
> 정본 스택 = `scripts/self_host_env.sh --compose` → `infra/rust/docker-compose.rust.yml` + `docker-compose.rust.build.yml` + `local.override.yml`(`SELF_HOST.md:167-180`).
> **문서 주장과 코드가 다르면 코드가 정본**. 그런 자리는 §정정 목록에 따로 모았다.

---

## 축별 판정 요약

| 축 | 판정 | 한 줄 |
|---|---|---|
| 1. 터미널 | **부분** | 서버 폐곡선은 진짜로 닫혔다(#1777/#1778 실수리 확인). 그러나 **셀프호스트 compose에 PTY 생산자(work host)가 없다** — 도크는 여전히 붙을 데가 없다 |
| 2. 허들(음성) | **부분** | 로컬 브라우저 2자 통화는 성립(실측 PASS). **박스 밖(외부 접속)은 4중 결손** — 생성기 키 미생성·TURN 부재·CSP 하드코딩·공개 TLS 엣지 부재 |
| 3. 도어벨 | **온전(−ε)** | 서명·재시도·게이트·등록 UI·compose 배선 전부 실물. 남은 것은 ADR 스케치의 「벨 테스트」 버튼 하나 |
| 4. 웹훅 인바운드 | **결손** | 공개 ingress 2경로가 Rust 서버에 **없다**. 관리 UI가 발급하는 주소를 서빙할 라우트가 0 |
| 5. 셀프호스트 운영 | **부분** | 로컬 폐곡선(부트스트랩→초대→에이전트 자격)은 발행 이미지로 실측 PASS. **공개 도메인/TLS 경로는 막혀 있다** |
| 6. 기타 결손 후보 | **혼재** | #1300·#1275는 **이미 코드 랜딩**(이슈만 열림) · #1274는 미수리 · 푸시는 구조적 제3자 의존 |

---

## 축 1 — 터미널

### 판정: **부분** (서버 ○ / 클라 ○ / **셀프호스트 실동 ✗**)

#### 닫힌 것 (코드 실물로 확인 — 이슈 주장이 맞다)

**#1777 host-signed 세션 변이 — 실제로 이식됐다.** 이슈 본문의 "400 거절" 상태는 과거형이다.
- `server-rust/bins/momo-server/src/routes/work_sessions.rs:469-527` — PATCH 디스패처가 bindRemotePTY / ACP(#1785) / observation(#1778) 세 팔로 갈라진다.
- `:502` → `bind_remote_pty(...)`, 본체 `:1300-1400`. `write_remote_pty_binding_in_tx` `:1391`.
- `:1346` 타 호스트 서명 거부, `:1380-1387` 호스트 상태/attach 지원 검증.
- `remote_attach_available` 생산: `crates/momo-t3/src/lifecycle.rs:529,534` (`pty_id IS NOT NULL AND attach_endpoint IS NOT NULL`), 소비: `routes/work_sessions.rs:166`, `routes/reattach.rs:139`.
- 랜딩 PR #1786. 클로징 코멘트가 "실 데몬·실 `/bin/sh` PTY에서 `remote_attach_available=true` · controller replay 10011B → send_stdin → live 출력 도달"을 기록.

**#1778 관전 차단 토글 — 실제로 이식됐다.**
- `work_sessions.rs:834-905` `update_observation` — `:841` `require_human`, `:892` "only the session owner can change observation", `:902` `set_work_session_observation_in_tx`, `:905` 감사.
- `:121-126` `validated_observation` — `open` | `owner_only` 외 400.
- `:524` observation과 lifecycle 필드 혼용 400.
- 소비 측 강제: `routes/display_attach.rs:308-310` "session observation is owner-only".
- 랜딩 PR #1787. owner_only 전이 시 같은 tx에서 observer capability 회수.

**terminal-attach 제어평면** — `routes/terminal_attach.rs:1-10`: `POST …/work-sessions/{s}/terminal-attach`(bearer·human) + `POST …/work-hosts/{h}/terminal-attach/validate`(PUBLIC·host-signed, `work_host_auth` v2 요청 서명).

**TC-1 관전 도크(#1758/PR #1766) 클라 실물** — `clients/web/src/features/work/`에 `TerminalDock.tsx` · `ObserverTerminal.tsx` · `WorkPanel.tsx` · `terminalRuntime.ts` · `observerStream.test.ts` · `displayStream.ts`.

#### 결손 (blocker) — **셀프호스트 compose에 work host가 없다**

PTY의 생산자는 `momo-workd` 데몬인데, 셀프호스트 정본 스택에서 그것을 얻을 경로가 없다:

1. **정본 compose가 명시적으로 배제** — `infra/rust/docker-compose.rust.yml:26`
   > `Still deliberately absent everywhere: redis (…), prometheus, linkshort, workd.`
2. **Rust 이미지에 workd 바이너리가 없다** — `server-rust/bins/` = `momo-server` · `momo-relay` · `momo-agent-worker` · `momo-webhook-sender` · `momo-notifier` · `momo-migrate` (6종). workd는 **Swift**다: `workers/WorkHostDaemon/Sources/WorkHostDaemon`.
3. **workhost 프로파일은 Swift prod 스택에만** — `infra/prod/docker-compose.prod.yml:480-489` `profiles: ["workhost"]`. 그 파일은 `MOMO_API_IMAGE`/`command:["api"]`/linkshort/minio/prometheus를 쓰는 **Swift 스택**이고, 셀프호스트 정본 경로(`infra/rust/*`)와 다른 계보다.
4. **그 사이드카 이미지는 발행되지 않는다** — `.github/workflows/publish-images.yml:37-38`이 발행하는 것은 `ghcr.io/yeomyeonggeori/oort`와 `oort-postgres` 둘뿐. `ghcr.io/yeomyeonggeori/momo-workhost`(`docs/WORK_HOST_QUICKSTART.md`가 요구하는 값)를 만드는 CI가 **레포에 없다**. 즉 문서의 절차를 따라도 pull할 이미지가 없다.
5. **레포가 스스로 자백** — `scripts/verify_workd_rust.sh:6-9`:
   > `The daemon is a Mac-local momo-workd process — rust compose has no Swift toolchain, a real PTY is native, and the machine under test is the maintainer Mac.`
6. **문서 부재** — `docs/SELF_HOST.md`에 `work host` / `워크호스트` / `터미널` / `workd` 문자열이 **0건**. 목차(§전제~§운영) 어디에도 터미널 절이 없다.

⇒ #1777이 연 것은 **서버 계약**이고, 셀프호스트 오퍼레이터 관점에서 터미널 축은 여전히 **생산자 없는 소비자**다. 다만 성격이 바뀌었다: 전에는 "원리적으로 PTY가 없다"(서버가 거절), 지금은 "PTY를 만들 데몬을 오퍼레이터가 얻을 방법이 없다"(패키징·배포 갭).

**TC-2 작업 콘솔(#1759)**: OPEN, 기획 단계. Accepted ADR 없음 → 착수 금지 상태 유지. 정상.

#### "온전"까지 남은 조각
- (a) workd를 Rust로 이식하거나, workhost 사이드카를 `infra/rust`에 `profiles:["workhost"]`로 편입
- (b) `momo-workhost` 이미지 발행 레인(digest pin + attestation) — 지금 CI에 없음
- (c) `SELF_HOST.md`에 터미널 절 신설(호스트 등록 토큰 → 데몬 기동 → 세션 → 도크)
- (d) TC-2 ADR 기안(원격 조작 권한/감사 경계)

---

## 축 2 — 허들(음성)

### 판정: **부분** (로컬 ○ / **외부 접속 ✗**)

#### 닫힌 것
- 서버: `routes/huddles.rs`, 세 env 유닛(`MOMO_LIVEKIT_API_KEY/SECRET/URL`)이 `docker-compose.rust.yml` api 블록에 `${VAR:-}`로 배선. 하나라도 비면 허들 REST **503 `허들 미구성`**(fail-closed).
- LiveKit 서비스: `docker-compose.rust.yml` `livekit` (profile `huddle`, `livekit/livekit-server:v1.13.3`), 7880/7881은 `127.0.0.1` 바인딩, UDP 50000-50100은 전 인터페이스 공개.
- **#1859(#1856a) 노브 랜딩 확인** — livekit entrypoint가 `MOMO_LIVEKIT_NODE_IP` 비어있지 않으면 `--node-ip` 부착(compose entrypoint 스크립트), `environment`에 passthrough, `scripts/self_host_env.sh:1204`가 신규 생성 env에 `MOMO_LIVEKIT_NODE_IP=127.0.0.1`. `SELF_HOST.md:434-439`에 로컬/LAN/미설정 3분기 문서화.
- 클라: `clients/web/src/features/huddles/` — `huddleRuntime.ts` · `useHuddle.ts` · `HuddleMicMenu.tsx` · `micDeviceStore.ts` · `huddleTurnRewrite.ts`(#1825/#1849 Funnel TURN 광고 포트 443→8443 리라이트, host-match 게이트).
- **로컬 실측 PASS** — `claudedocs/comprehensive-test-20260828/S1-lite-local-huddle.md`: v0.1.3 발행 digest + huddle 프로파일에서 2컨텍스트 양방향 오디오, inbound-rtp 4,934B / 6,807B. node_ip 없으면 `could not establish pc connection`, `127.0.0.1` 주면 즉시 연결 — **#1856 진단(광고 IP가 병인)의 메커니즘 절반 입증**.

#### 결손 1 (major) — 생성기가 허들을 켜 주지 않는다
`scripts/self_host_env.sh` 생성 env(1130-1205행 블록)에 **`MOMO_LIVEKIT_API_KEY` · `MOMO_LIVEKIT_API_SECRET` · `MOMO_LIVEKIT_URL` · `COMPOSE_PROFILES=huddle` 이 한 줄도 없다**(grep 0건). 있는 것은 `MOMO_LIVEKIT_NODE_IP` 한 줄뿐.
⇒ SELF_HOST.md를 그대로 따른 스택은 **허들 REST가 전부 503**이고, 화면의 허들 버튼은 이유를 말하지 않는다.
증거(우연이 아님): S1-lite 실측 보고서가 배선 체인 1번을 *"env 3종 유닛 추가, `--compose up -d livekit api`"* 라는 **수동 단계**로 기록. 로컬 개발자 파일 `infra/rust/local.secrets.env:86`에 `COMPOSE_PROFILES=huddle`이 있는데 이 파일은 **git 미추적**(`git ls-files` 미스) — 즉 손으로 넣은 것이다.
`SELF_HOST.md:434-439` 허들 절은 node_ip 한 문단뿐 — 키 생성법도, 프로파일 기동 명령도 없다.

#### 결손 2 (blocker) — TURN이 아예 없다
`infra/livekit.yaml:15-19` — TURN 블록 **전량 주석**:
> `# TURN is deferred until a public domain and TLS certificate exist.`
7880/7881은 루프백 바인딩이라 외부 시그널링도 프록시 없이는 불가. 대칭 NAT·모바일 LTE에서 relay 없이 도달 불가. #1792(SPIKE-HD Funnel TLS TURN) OPEN, #1856(VM relay↔SFU 페어 무응답) OPEN — **#1859는 "로컬 기본값" 절반만 닫았고 VM/외부 절반은 그대로 남았다**(PR #1859 본문이 스스로 그렇게 적고 있다).

#### 결손 3 (blocker) — CSP 하드코딩, 생성기가 못 건드린다
- `infra/rust/Caddyfile.local:57` `connect-src 'self' ws://localhost:* ws://127.0.0.1:* https://www.googleapis.com` — **`wss:` 토큰 없음**, 외부 호스트 없음.
- `infra/rust/Caddyfile:113` `connect-src 'self' wss://app.oor7.com …` — 죽은 도메인 하드코딩.
- `scripts/self_host_env.sh --public-origin`(:146-148)은 `CENTRIFUGO_ALLOWED_ORIGINS`와 `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL`만 고친다. **CSP를 템플릿하는 코드가 레포에 0건**(`grep Content-Security-Policy scripts/ infra/rust/` = Caddyfile 2줄 + 검증 스크립트뿐).
⇒ LiveKit endpoint가 루프백 밖(터널·LAN·클라우드 SFU)이 되는 순간 브라우저가 WebSocket을 차단한다. 이 갭은 `docs/planning/JOURNAL.md:2779`에 "티켓 후보"로만 적립돼 있고 티켓이 없다.

#### 결손 4 (blocker) — 공개 TLS 엣지가 없다
`SELF_HOST.md:529` §운영이 공개 배포로 안내하는 파일 `infra/rust/Caddyfile:1-5`는 스스로 이렇게 적는다:
> `⚠️ 은퇴한 배포의 파일 — NCP 프로덕션은 2026-08-26 완전 철수(#1803). 이 파일을 그대로 재기동하면 존재하지 않는 배포를 향해 ACME 인증서 발급을 시도한다.`
사이트 주소가 `app.oor7.com` 하드코딩이라 셀프호스터가 이 경로를 따르면 **남의 도메인 앞으로 ACME 주문**을 낸다(2026-08-10 실측 4건). #1239 OPEN. ⇒ **공개 도메인 셀프호스트는 지금 문서화된 경로가 없다.**

#### 결손 5 (major, 다만 범위 정정 필요) — #1895 Permissions-Policy
`infra/prod/Caddyfile:11` `Permissions-Policy "camera=(), microphone=(), geolocation=()"` 실재 확인.
**다만 코드 실사 결과 이슈 문면의 영향 범위가 과대하다**: 이 파일은 **Swift prod 스택**(`infra/prod/docker-compose.prod.yml`)의 엣지이고, 현행 셀프호스트 정본 경로(`infra/rust/Caddyfile` / `Caddyfile.local`)에는 **Permissions-Policy 헤더 자체가 없다**(repo 전역 grep 결과 이 1줄이 유일). 따라서 "브라우저 prod 허들 마이크 전면 차단"은 **infra/prod 경로를 쓰는 배포에만** 해당한다. 수리는 여전히 필요(AC의 "3종 Caddyfile 정합" 점검 포함)하나, 셀프호스트 허들의 현재 blocker는 이것이 아니라 결손 1~4다.

#### "온전"까지 남은 조각
- (a) 생성기가 LiveKit 3키 생성 + huddle 프로파일 선택 노브 + SELF_HOST.md 허들 기동 절차
- (b) TURN 활성 경로 결정(#1792 스파이크 완주 또는 클라우드 SFU 옵트인)
- (c) CSP 템플릿화 — `--public-origin`이 CSP connect-src도 갱신(와일드카드 금지)
- (d) #1239 사이트 주소 파라미터화(공개 엣지 부활)
- (e) #1856 VM relay 페어 · #1895 헤더 교정

---

## 축 3 — 메시지 도어벨(ADR-0171)

### 판정: **온전 (−ε)**

#### 폐곡선 확인
| 조각 | 실물 |
|---|---|
| D1 등록 REST | `routes/hosted_agent_doorbell.rs:1-6` PUT/DELETE `…/hosted-agent-connections/{id}/doorbell`, `require_human`, `no_store` 헤더, 게이트-off는 빈 404(프로브 표면 아님) |
| 시크릿 봉인·마스킹 | `crates/momo-webhook/src/crypto.rs` `seal_doorbell_secret`/`open_doorbell_secret`/`masked_doorbell_secret`. `DoorbellProjection`에 **평문/봉인 필드 없음**(`doorbell.rs:22` 주석이 명시) |
| D2 상수 페이로드 | `crates/momo-webhook/src/doorbell.rs:18` `DOORBELL_BODY = {"kind":"oort.doorbell.v1"}` |
| D3 outbox 생산자 신설 없음 | `doorbell.rs:3-5` — `hosted_agent_inbox_counter` BYPASSRLS 폴, `Nothing here inserts into outbox` |
| D4 코얼레싱 | `CoalesceAction{Leading,MarkTrailing,Trailing,Idle}` |
| D5 재시도·백오프·관측 | `bins/momo-webhook-sender/src/doorbell.rs:166-181` 재시도 루프, `:314-315` `doorbell_backoff = 200ms · 2^n`, `:172/:182` audit, `finish(…, last_status)` → projection `doorbellLastFiredAtMs`/`doorbellLastStatus` |
| SSRF 가드 | `parse_outbound_url` (OutboundHTTPPolicy 재사용) → 거부 시 `invalid_url` |
| D6 게이트 | `MOMO_DOORBELL_ENABLED` 정확히 소문자 `true`. 드레인 idle 로그 `doorbell drain idle (MOMO_DOORBELL_ENABLED!=true)` |
| **compose 배선 (#1747 갭1)** | **수리 확인** — `docker-compose.rust.yml` api 블록·webhook-sender 블록 **양쪽에** `MOMO_DOORBELL_ENABLED`와 선행 게이트 `MOMO_HOSTED_DELIVERY_ENABLED` 둘 다 배선 |
| **drive 볼륨 권한 (#1747 갭2)** | **수리 확인** — `infra/rust/local.override.yml` `drive-init` 원샷 서비스(`user: "0:0"`, `chown 10001:10001`), api가 `depends_on: drive-init(completed)` |
| WD-2 등록 UI (#1735) | **랜딩** — `clients/web/src/features/hostedAgents/DoorbellSection.tsx`, `HostedConnectionSection.tsx:350`에 마운트. 4상태 이상(loading/gate-off/empty/registered/failure/offline/busy/not-active) + 마스킹 + last-fired 상대시각. PR #1744 (커밋 `819c38ab`, design-review 수리 `b5010f2e`) |
| WD-3 문서 | `docs/SELF_HOST_AGENT.md §4`(도어벨) + `§4.5`(15분 스윕 폴백) + 게이트 2종 철자 경고 + 등록 REST 문면 |
| E2E | `claudedocs/e2e-doorbell-20260824/REPORT.md` — 멘션→inbox→drain→도어벨 발화→Agent Port pull→응답 랜딩 **서버 절반 전 구간 GREEN**. RED는 cursor 벤더 엔드포인트 500(우리 밖) |

#### 남은 조각 (minor)
- **「벨 테스트」 버튼 부재.** ADR-0171 WD-2 수용기준이 요구한 *"벨 테스트 버튼(서버 경유 시험 발화)"*이 `DoorbellSection.tsx`에 없고(파일 내 "테스트" 문자열 0건, `data-testid`만 매치), 서버에도 test-fire 라우트가 없다(`lib.rs` grep 0건). #1735가 아직 OPEN인 이유로 보인다. #1745(도어벨 UI 후속 적립)도 OPEN.
- 기본 셀프호스트는 두 게이트가 off라 도어벨 라우트가 404다 — 이것은 D6 설계대로이고, 켜는 절차가 `SELF_HOST_AGENT.md §4.3`에 있으므로 결손 아님. 단 `SELF_HOST.md`(정본 quickstart)에는 도어벨 언급이 없다.

#### 용어 정정
임무 브리프의 "메시지 **시그니처** 기반 서버리스"는 도어벨과 다른 것이다. 도어벨은 **아웃바운드 Bearer(sender key) 모델**이지 HMAC 서명 인바운드가 아니다(`transport.ring(&url, &secret, body)`). **서명 검증이 걸린 곳은 축 4(웹훅 인바운드)이고, 그쪽이 미이식이다.**

---

## 축 4 — 웹훅 인바운드 공개 ingress (#1265)

### 판정: **결손 (blocker)**

레포가 스스로 자백한다 — `server-rust/bins/momo-server/src/routes/webhooks.rs:15-23`:
> `## What is NOT here` … `The public ingress half (POST /v1/webhooks/{ws}/{id}, POST /hooks/{token}) is out of #1222's stated scope … an admin can install, rotate and revoke a webhook, and the credential they are shown will not be accepted by this server until the ingress routes land.`

코드 실사로 재확인:
- 라우터 `bins/momo-server/src/lib.rs`에 걸린 webhook 경로는 관리 4연산뿐 — `:1144` `/v1/workspaces/{ws}/webhooks/{installation}/rotate`, `:1148` `/v1/workspaces/{ws}/webhooks/{installation}`. **`/hooks/{token}` 라우트 0건**(`grep '"/hooks'` = 테스트 문자열과 크레이트 내부 생성기만).
- **그런데 서버는 그 주소를 계속 발급한다**: `crates/momo-webhook/src/installations.rs:528` `format!("/hooks/{token}")`, `bins/momo-server/src/dto.rs:3894` — *"Relative ingress path — `/v1/webhooks/{ws}/{id}` or `/hooks/{token}`"*. 설정 › 웹훅 화면이 자격증명과 수신 주소를 사용자에게 보여주는데, **그 주소로 POST하면 404다.**
- #1265 OPEN, 2026-08-10 이후 무변동.

이것은 축 1과 정반대 형태의 같은 병이다: 축 1은 소비자만 있고 생산자가 없었고, 여기는 **자격 발급자만 있고 수신자가 없다**.

#### "온전"까지 남은 조각
- 2라우트를 인증 미들웨어 **밖에** 마운트(`terminal_attach::validate`·`work-hosts/heartbeat`와 같은 자리)
- 서명 검증(`momo-webhook::crypto` 파생 공유 — Swift `WebhookRoutes.swift` 계약 보존)
- 레이트리밋 + 본문 크기 가드(`MAX_SIGNED_BODY_BYTES` 계열 재사용)
- 회전/폐기된 자격의 거부 red proof
- (연관 OPEN) #1208 — 웹훅 비밀 게이트 4레인이 전부 '발급'만 지나고 회전 레인이 없음

---

## 축 5 — 셀프호스트 운영 축

### 판정: **부분** (로컬 폐곡선 ○ / 공개 배포 ✗)

#### 온전한 것
- **compose 스택 실동**: postgres(PG18+pgvector, digest pin) · centrifugo v6(digest pin) · runtime-roles → migrate(2패스 멱등) → api · relay · agent-worker · webhook-sender + `local.override.yml`의 drive-init · web-init · web(Caddy `:80`, 루프백).
- **발행 파이프라인**: `.github/workflows/publish-images.yml` — main ref 수동 dispatch + release Environment owner 승인 + amd64/arm64 아키별 push → manifest list 합성 → **SLSA v1 provenance attestation을 아키별 digest와 list digest 양쪽에** 부착. `SELF_HOST.md:88-140`이 v0.1.3 list digest(`sha256:e0faed22…c48688`)와 `gh attestation verify` 절차를 문서화. 생성기가 `^ghcr\.io/yeomyeonggeori/oort@sha256:[0-9a-f]{64}$` 정규식으로 형식 강제.
- **부트스트랩→초대→에이전트 자격 폐곡선 = 발행 이미지로 실측 PASS**: `claudedocs/comprehensive-test-20260828/S4-local-selfhost.md` — owner 로그인(`MOMO_INITIAL_OWNER_*`) → invite(role=member, maxUses=1) → 둘째 사용자 join → `PATCH /members/{id}/role` admin 승격 → generic 에이전트 생성 → 자격 발급(`messages:read`+`messages:write`) → 채널 투입 → 에이전트 Bearer로 POST 201 / GET 200 / 닫힌 표면 403. **성재 개입 0회 완주.**
- 부트스트랩 2모드: `MOMO_INITIAL_OWNER_PASSWORD`(migrate set-owner) 또는 ADR-0166 `MOMO_BOOTSTRAP_CLAIM=1`(claim-pending owner + 1회용 `/claim/<token>`). 둘 다 compose에 배선.
- 인스턴스 운영자 문제 해결: `PLATFORM_ADMIN_EMAILS`를 생성기가 첫 owner 주소로 자동 기입 — #1526 "에이전트를 만들었는데 영영 대답 없음" 클래스 봉쇄.
- **첨부/보관소 자립**: 생성 env가 `MOMO_DRIVE_ARCHIVE_BACKEND=local` + `MOMO_DRIVE_LOCAL_DIR` + `DRIVE_VOLUME_NAME` 기본. Google SA 불요. `drive-init` chown으로 첫 기동 재시작 루프 봉쇄.
- **원격 접속 실시간**: ADR-0167 `MOMO_CENTRIFUGO_WS_URL=same-origin` + `--public-origin` 멱등 추가 → 터널 뒤 `wss://<host>/connection/websocket` 파생(`SELF_HOST.md:508-527`).

#### #1607 (데스크탑 로그인 실기동 + CORS) — **배선 절반 랜딩, 검증 미완**
- 랜딩: 생성 env가 `MOMO_CORS_ALLOWED_ORIGINS`에 tauri origin 2종(`tauri://localhost`, `http://tauri.localhost`)을 기본 기입, `CENTRIFUGO_ALLOWED_ORIGINS`도 동일. compose 기본값은 빈 값 유지(운영 형상 무영향).
- 미완: 이슈 OPEN `status:in-progress`. AC의 "릴리스 빌드 로그인+메시지 왕복 **실기동** 증거"와 "desktop README Known gaps stale 0"이 남아 있다.

#### #1608 (첫 하루 런북) — **문서는 랜딩, 실기동 검증 미완**
- `docs/SELF_HOST_FIRST_DAY.md` 실물 존재. 부트스트랩→로그인→워크스페이스→**웹 GUI 초대**(최초 문서화)→둘째 사용자 합류(웹 + `oort://join`)→AI 연결→첫 멘션.
- 그러나 문서 스스로 검증등급을 매기는데(§검증 상태), GUI 클릭 경로는 **「실기동 필요」**로 표시 — *"이 워크트리는 headless라 브라우저/데스크탑을 누르지 않았다"*. 이슈 OPEN.

#### 결손 (blocker) — 공개 도메인/TLS
축 2 결손 4와 동일 사안. `SELF_HOST.md:529` §운영이 안내하는 공개 배포 파일이 은퇴 도메인 하드코딩(#1239 OPEN). ⇒ **로컬 루프백까지가 현재 셀프호스트가 문서로 보증하는 전부다.**

#### 결손 (minor) — 이미지 미러 불가
`self_host_env.sh`의 `--published-image` 정규식이 `ghcr.io/yeomyeonggeori/oort@sha256:…`만 수용 → 사내 미러·에어갭 레지스트리 경로가 구조적으로 없다. 대안은 `--local-build`(불변 digest·attestation·multi-arch를 잃음).

---

## 축 6 — 기타 결손 후보

| 항목 | 판정 | 근거 |
|---|---|---|
| **#1300** Centrifugo subscribe proxy 403 | **코드 이미 수리됨 — 이슈만 OPEN** | `infra/rust/Caddyfile:48-50` `handle /v1/centrifugo/* { respond 403 }`이 generic `/v1/*`(:51) **앞에** 존재. 게이트 3본: `scripts/verify_ncp_centrifugo_contract.sh:43-46`(deny 존재·순서 검사) · `scripts/tests/test_ncp_centrifugo_boundary.sh`(local_gate:660) · `scripts/verify_web_serving.sh:143-144`(실 403). `infra/prod/Caddyfile:25-27`도 동일. **잔여**: `Caddyfile.local`에는 deny가 없다 — 루프백 전용이고 API 자체 상수시간 시크릿 검사가 2차 경계라 위험은 낮으나, 이 엣지를 공개 노출하면 심층방어 1겹이 빈다 |
| **#1275** 채널 self-leave | **코드 이미 수리됨 — 이슈만 OPEN** | `lib.rs:643` `/v1/workspaces/{ws}/channels/{ch}/members/me` → `routes::member_lifecycle::leave_channel`(`member_lifecycle.rs:475-519`, `leave_channel_in_tx`). admin 게이트와 분리된 self 경로가 생겼다 |
| **#1274** 채널 rename | **미수리 (major)** | `routes/channels.rs`의 pub fn = `list:116` · `create:179` · `notification_pref:240` · `add_member:306` · `remove_member:361` — **rename 없음**. `lib.rs:622-647`에 `PATCH /v1/workspaces/{ws}/channels/{ch}` 없음. **브리프 가정 정정: BZ-4e(#1873)는 채널 rename이 아니라 「자기 표시 이름 변경」**(`PATCH …/members/me {displayName}`, STATUS.md). `channel_renamed` 이벤트 소비자만 있고 생산 라우트는 여전히 없다 |
| **푸시(NSE/APNs)** | **구조적 제3자 의존, 기본 스택엔 부재** | `infra/rust/docker-compose.push.yml`은 **오버레이**(base에 없음, `-f` 명시로만 활성) + notifier `MOMO_PUSH_NOTIFIER_ENABLED` 기본 0 = 이중 default-off. `.p8`는 App Store 배포자만 보유(ADR-0120 D1-A) → 셀프호스터는 Dawn 운영 relay 경유 또는 자기 Apple 계정+자기 빌드+자기 키(`push-relay.env.example:18-21`). Android/FCM 미구현. **기본 셀프호스트는 푸시가 없고, 우리 서버도 타지 않는다** |
| **첨부/보관소** | **자립 ○** | 위 축 5 |
| 데스크탑 자동 업데이트 | oort 하드 배선 | `clients/desktop/src-tauri/tauri.conf.json:33-40` 빌드타임 baked endpoints+pubkey — env로 못 바꾼다(`docs/planning/research/2026-08-26-selfhost-external-dependency-audit.md` ②(1)) |
| 텔레메트리/분석/과금 콜백 | **0건** | 같은 감사 ①-10, ①-11 |

---

## 정정 목록 — 문서/이슈 주장 ≠ 코드 실물

1. **#1777·#1778은 이미 수리됐다.** 이슈 본문의 "400 거절 / 항상 false"는 과거 상태다(PR #1786·#1787). 터미널 축의 현재 blocker는 **서버 계약이 아니라 work host 패키징**이다.
2. **#1300은 코드상 이미 닫혀 있다.** `infra/rust/Caddyfile:48-50`에 순서까지 맞는 deny와 게이트 3본이 있다. 이슈가 `status:blocked`로 열려 있는 것은 부기 드리프트다(+ NCP 배포 자체가 #1803으로 철수).
3. **#1275도 코드상 닫혀 있다.** `members/me` self-leave 라우트 존재.
4. **#1274는 BZ-4e로 랜딩되지 않았다.** BZ-4e(#1873)는 **자기 표시 이름** 변경이고 채널 rename과 무관하다.
5. **#1895의 영향 범위가 이슈 문면보다 좁다.** `Permissions-Policy: microphone=()`은 `infra/prod/Caddyfile`(Swift prod 스택)에만 있고, 셀프호스트 정본 경로(`infra/rust/*`)에는 Permissions-Policy 헤더 자체가 없다.
6. **#1747은 실제로 두 갭 모두 수리됐다.** compose 양 서비스 배선 + `drive-init` chown 원샷 확인.
7. **#1735(도어벨 UI)는 사실상 랜딩했다.** PR #1744 머지. 이슈가 열려 있는 잔여는 「벨 테스트」 버튼으로 보인다.
8. **`SELF_HOST.md`의 §운영 표는 현재 따를 수 없는 절차를 가리킨다.** 그 표가 지목하는 `infra/rust/Caddyfile`이 파일 첫 줄에서 스스로 "은퇴한 배포의 파일"이라 선언한다.
9. **허들은 "compose로 띄우면 되는" 상태가 아니다.** 문서·이슈가 "#1859로 셀프호스트 기본값 해소"로 읽히지만, 생성기는 LiveKit **자격 3종을 만들지 않는다** — 노브 하나만 채웠을 뿐이라 기본 상태는 여전히 503이다.

---

## 심각도순 결손 총목록

### Blocker (셀프호스트 오퍼레이터가 그 기능에 **도달할 수 없음**)

| # | 결손 | 축 | 좌표 | 티켓 |
|---|---|---|---|---|
| B1 | 웹훅 인바운드 공개 ingress 2경로 부재 — 발급된 자격/주소가 404 | 4 | `routes/webhooks.rs:15-23` · `lib.rs`(라우트 0) · `dto.rs:3894` | #1265 |
| B2 | 셀프호스트 compose에 work host 없음 + workhost 이미지 발행 레인 없음 → 터미널 축 도달 불가 | 1 | `docker-compose.rust.yml:26` · `workers/WorkHostDaemon`(Swift) · `publish-images.yml:37-38` · `verify_workd_rust.sh:6-9` | **없음(신규 필요)** |
| B3 | 공개 도메인/TLS 엣지 부재 — 안내된 파일이 은퇴 도메인 하드코딩, ACME 오발사 | 2·5 | `infra/rust/Caddyfile:1-5` · `SELF_HOST.md:529-545` | #1239 |
| B4 | 허들 TURN 전량 주석 — 박스 밖 도달 불가 | 2 | `infra/livekit.yaml:15-19` | #1792 / #1856 |
| B5 | CSP 하드코딩 — 외부 LiveKit 오리진 브라우저 차단, 생성기가 갱신 못함 | 2 | `Caddyfile.local:57` · `Caddyfile:113` · `self_host_env.sh:146-148` | **없음(JOURNAL:2779 적립만)** |

### Major (기능이 존재하나 **기본 형상에서 조용히 죽어 있음**)

| # | 결손 | 축 | 좌표 | 티켓 |
|---|---|---|---|---|
| M1 | 생성기가 `MOMO_LIVEKIT_API_KEY/SECRET/URL`·huddle 프로파일을 만들지 않음 → 기본 허들 503, 문서에 기동 절차 없음 | 2 | `self_host_env.sh`(3키 0건) · `SELF_HOST.md:434-439` | **없음(신규 필요)** |
| M2 | #1607 데스크탑 릴리스 빌드 로그인 실기동 증거 미확보(배선만 랜딩) | 5 | 이슈 `status:in-progress` | #1607 |
| M3 | #1608 첫 하루 런북 GUI 경로 실기동 미검증(문서 자체가 「실기동 필요」 표기) | 5 | `SELF_HOST_FIRST_DAY.md §검증 상태` | #1608 |
| M4 | 채널 이름 수정 라우트 부재 — `channel_renamed` 소비자만 존재 | 6 | `routes/channels.rs`(rename 0) · `lib.rs:622-647` | #1274 |
| M5 | prod Caddyfile `microphone=()` (범위: infra/prod 배포 한정) | 2 | `infra/prod/Caddyfile:11` | #1895 |

### Minor

| # | 결손 | 좌표 | 티켓 |
|---|---|---|---|
| m1 | 도어벨 「벨 테스트」 버튼·서버 test-fire 라우트 부재(ADR-0171 WD-2 AC 잔여) | `DoorbellSection.tsx` · `lib.rs` | #1735 / #1745 |
| m2 | 부기 드리프트 — #1300·#1275는 코드 랜딩됐는데 이슈 OPEN | — | #1300 · #1275 |
| m3 | 이미지 미러/에어갭 레지스트리 경로 없음(정규식이 우리 GHCR만 수용) | `self_host_env.sh` `--published-image` 정규식 | **없음** |
| m4 | `Caddyfile.local`에 `/v1/centrifugo/*` deny 없음(심층방어 1겹) | `Caddyfile.local:33-35` | — |
| m5 | `SELF_HOST.md`에 도어벨·터미널 절 0건(정본 quickstart가 두 축을 언급하지 않음) | `SELF_HOST.md` 목차 | — |

---

## 권고 착수 순서

1. **B1 웹훅 인바운드(#1265)** — 가장 값싼 blocker. 계약·서명 원본이 Swift와 `momo-webhook` 크레이트에 전부 있고, 다른 축과 의존이 없다. 2라우트로 "자격은 발급되는데 받는 곳이 없다"는 제품 거짓말이 사라진다.
2. **M1 허들 생성기 3키 + 프로파일 + 문서** — 코드 몇 줄. 이걸 안 하면 B4/B5를 고쳐도 기본 사용자는 여전히 503만 본다. **B4/B5보다 먼저** 해야 하는 순서다.
3. **B3 + B5 를 한 티켓으로 묶어 「공개 엣지 파라미터화」** — 사이트 주소(#1239)와 CSP connect-src를 같은 템플릿 레이어에서 env로 뽑는다. 둘은 같은 파일의 같은 병이고, 이 하나가 공개 셀프호스트와 외부 허들 CSP를 동시에 연다. 와일드카드 금지 규율(#1792 본문)을 수용기준에 박는다.
4. **B4 허들 TURN(#1792 스파이크 완주)** — 3번이 선행이어야 CSP 때문에 스파이크가 헛돌지 않는다. 중단 조건(2단계 TLS 악수) 이미 성문화돼 있음.
5. **B2 work host 셀프호스트 편입** — 가장 무겁다(Swift 데몬 이식 여부 = 방향 결정이라 ADR 가능성). 결정 전이라면 최소 조치로 **`SELF_HOST.md`에 "터미널은 현재 셀프호스트 미지원"을 정직하게 명시**해 소비자-없는-생산자 상태를 문서에서라도 닫는다.
6. **부기 정리 (m2, 정정 목록 1·3·5)** — #1300·#1275 close, #1777/#1778 상태 반영, #1895 범위 정정, #1274를 BZ-4e 랜딩 목록에서 분리. 감사 비용이 계속 여기서 새고 있다.
7. **M2/M3 실기동 검증(#1607/#1608)** — 3번 랜딩 후에 하면 공개 오리진 경로까지 한 번에 잰다.
8. **m1 벨 테스트 버튼** — 도어벨 축을 형식적으로도 "온전"으로 닫는 마지막 조각.
