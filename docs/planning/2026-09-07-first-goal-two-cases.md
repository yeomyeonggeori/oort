# 1차 최종 목표 구체화 — 두 설치 케이스 × 에이전트 합류 경로 (2026-09-07, Fable · momo-main · 성재 지시)

> 성재(2026-09-07 오후): 「케이스는 두 개. ①그록봇 VM 안에 설치하고 그록봇 중심으로 연동 ②그록봇과 별개로 셀프호스팅하고 본인의 에르메스 에이전트나 별도 에이전트들을 연동. 두 케이스 모두 커버되어야 한다. 그걸 염두에 두고 1차 목표를 구체화하라. 애매한 지점은 지금 구체화·결정.」
> 이 문서는 출시 편성 정본(`2026-09-02-launch-program-plan.md`)의 **G1 정의를 두 케이스의 E2E 2본으로 대체**하고, 경량화 프로그램(`2026-09-07-lightening-program.md`) §5의 질문 3건을 결정한다. 실측은 `docs/SELF_HOST_AGENT.md`·`SELF_HOST.md`·ADR-0162·#1361·메모리(그록봇 약관·durable-but-resettable) 기준.

## 0. 한 줄 정의

**1차 목표(G1') = 「README의 프롬프트 하나로 설치된 oort에 팀이 로그인하고, 설치한 하네스와 내가 쓰던 에이전트가 멤버로 합류해 멘션→답장이 도는 것」을 두 케이스 각각에서 1회 폐곡선으로 증명.** G2(출시 = 외부 셀프호스터 3: 하네스 복붙 1·그록봇 1·Railway 1)는 이 두 케이스를 외부인이 재현하는 것이므로 정의 불변.

## 1. 매트릭스

| | **케이스 A — 그록봇 VM 안에 설치, 그록봇 중심** | **케이스 B — 독립 셀프호스팅 + 본인 에이전트** |
|---|---|---|
| 설치 주체 | 그록봇(자연어 지시, 사람이 앱에 전달 — CDP 은퇴 결재 2026-08-22) | Claude Code/Codex 복붙(무개입) 또는 사람 |
| 호스트 | 그록봇 VM(durable-but-resettable: `/workspace`만 영속, Docker 이미지·패키지는 Update 시 증발) | 로컬 맥 · VPS(도메인) · Railway(SH-5a) |
| 공개 엣지 | Tailscale Funnel(`https://<machine>.<tailnet>.ts.net`, 상태 `/workspace/oort/ts-state`) | `--public-origin` + `OORT_SITE_ADDRESS`/`OORT_CSP_CONNECT_SRC`(SH-2) / Railway 도메인 |
| 설치한 하네스의 합류 | **그록봇 자신이 Agent Port로 dial-in**(ADR-0162: pairing → 사람 확인 → active credential, static bearer v0 / provider가 OAuth 요구 시 #1368·#1369) · 루틴으로 깨어남(ADR-0171 도어벨) | Claude Code/Codex가 Agent Port 자격으로 합류(SH-6a 자격 발급 GUI → UX-R2c 퍼널) |
| 내가 쓰던 에이전트의 합류 | 동일(그록봇이 곧 그 에이전트) + 선택: OpenAI 호환 provider | **본인 hermes** = 설정 › AI 연결(OpenAI 호환 SSE, `PUT /v1/provider/link`, `PROVIDER_LINK_MASTER_KEY`) → 웰컴 채널 킥오프에 김인턴 답장(UX-R2b/R2s) · 선택: hermes 게이트웨이 플러그인(`adapters/hermes`, 멤버 ingress) · 별도 에이전트 = Agent Port |
| 영속·day-2 | `/workspace` bind(pgdata·backups·ts-state) + Update/Reset 뒤 복구 절차(§3.3.2·3.3.6) | `scripts/oort` status/logs/upgrade/doctor(SH-3b) + pg_dump/pgBackRest(선택) |
| 약관·계정 | Cursor ToS: Beta·개인 비상업·자동화 제한 → **본인 계정/VM 전용**(Q-STRUCT). 트라이얼 상태에 좌우(편성 D-4 「복구 시」) | 없음(플랫폼 계정만) |

## 2. 수용 기준 — E2E 2본 (각 1회, 증거 = doctor JSON·redacted 로그·화면)

**E2E-A(그록봇 VM)**: README 「Paste this into your agent」 → 그록봇이 `SELF_HOST_AGENT.md` §1 표에서 「Grok Bot VM」을 고르고 §2 코어 + §3.3 수행 → `scripts/oort doctor --json` PASS(`public.healthz`·`public.websocket`) → 성재 브라우저·데스크톱에서 Funnel URL 로그인 → **그록봇이 Agent Port에 pair → 사람 확인 → active 자격 → 채널 멘션 → 그록봇 답장**(#1361 폐곡선, 자연어 릴레이) → VM **Update/Reset 1회** 뒤 §3.3 복구 절차로 재기동, 데이터·URL·멤버십 유지 → disconnect 시 잔여 0(#1361 cleanup manifest).

**E2E-B(독립 셀프호스팅)**: README 블록을 Claude Code에 붙여넣기 → Railway(SH-5a) 또는 VPS에서 무개입 설치 → doctor PASS(public) → 팀원 2인 로그인(웹+데스크톱) → **설정 › AI 연결에 본인 hermes(OpenAI 호환) 등록 → 웰컴 채널 킥오프에 김인턴 답장** → **SH-6a 자격으로 Claude Code(또는 Codex)를 Agent Port에 합류 → 멘션 → 답장** → `scripts/oort upgrade` 1회 왕복 + 백업 1회 → (선택) hermes 게이트웨이 플러그인 경로 1회 실측.

두 E2E 모두 폰은 QR 연결(M0)까지 + **폰 푸시 1회**(2026-09-07 저녁 결재: SH-10 Rust push relay를 셀프호스트에 동봉 — 케이스 B는 stub 또는 자체 relay, 케이스 A·Dawn 공용 relay는 TestFlight 기기 실수신). 폰 UI 패리티는 G3 유지, 단 **iOS 앱스토어 v0 출시 의도**(성재)에 따라 출시 정의 개정 제안은 §7.

## 3. 현행 자산과 갭 (실측)

| 케이스 | 이미 있는 것 | 갭(1차 목표 안에서 닫을 것) |
|---|---|---|
| A | `SELF_HOST_AGENT.md` §3.3(916줄: Funnel·`/workspace` bind·ts-state·Update/Reset 복구) · Agent Port Rust(ADR-0162, modern+legacy 2025-11-25 adapter #1363) · 도어벨(ADR-0171) · 그록봇 E2E 코어 계층 GREEN(8/23) | **A-1** §3.3에 「설치 뒤 그록봇 자신의 dial-in 합류」 절이 없다(pairing·루틴 지시문) → SH-8(루틴 지시문 정본화 + §3.3.x 합류 절) · **A-2** #1361 E2E 미완(blocked, 성재 손·자연어 릴레이, 그록봇 계정 복구 전제) · **A-3** Reset 뒤 복구 실측 0회 |
| B | `SELF_HOST.md`(en/ko)·`FIRST_DAY`·`scripts/oort` day-2 · 설정 › AI 연결(provider link) · 웰컴 킥오프(UX-R2b/R2s) · SH-4a Claude Code 복붙 무개입 설치 1회 실측 완료 · Agent Port | **B-1** Railway 템플릿 부재(§3.4 stub → SH-5a) · **B-2** Agent Port 자격 발급이 GUI에 없다(SH-6a) · **B-3** 온보딩 S5 「첫 에이전트 연결」 퍼널 부재(UX-R2c) · **B-4** hermes 게이트웨이 플러그인 문서(`docs/external-agent-provider/*`)가 Swift 스택 전제(8곳) — 삭제 금지, Rust 현행으로 재작성(SH-9) · **B-5** upgrade+백업 왕복은 SH-3b 하네스로 실측됐으나 외부 호스트(Railway)에서 0회 |

## 4. G1' 편성 (확정 — 경량화 프로그램 §4 제안을 이 표로 대체)

| 파도 | 엔진 | UXUI/문서 | 케이스 |
|---|---|---|---|
| **G1'-1** | **SH-6a** Agent Port 자격 발급 GUI(설정 › 에이전트 › 자격) + 로컬 OpenAI 호환 opt-in (M) | **SH-5a** Railway 템플릿 1회 E2E (M, 엔진 두 번째 자리) | B-2 · B-1 |
| **G1'-2** | **SH-10 #1255** momo-push-relay Rust(같은 이미지·compose push·3 모드) + TestFlight 실수신 (M~L) · **#1265** 웹훅 인바운드 (M, 두 번째 자리) | **UX-R2c** 첫 에이전트 연결 퍼널 — 카드 4종(Claude Code/Codex/**Grok Bot**/OpenAI 호환=hermes) → 1회용 자격(SH-6a) → 감지 → 첫 멘션 (L) | 푸시(A·B) · B-3 · A(카드) |
| **G1'-3** | **SH-8** 그록봇 루틴 지시문 정본화 + §3.3 「합류」 절(A-1) (M, 문서·성재 확인) | **SH-9** hermes 합류 런북 Rust 현행화(`external-agent-provider/*` 재작성 + 플러그인 1회 실측) (M) | A-1 · B-4 |
| **G1'-4 E2E** | **E2E-B** Railway + hermes + Claude Code 합류 + upgrade/백업 + 폰 QR+푸시(stub)(planner 집행, 성재 로그인) | **E2E-A** #1361 그록봇 pair→reply→disconnect + Reset 복구(A-2·A-3) — **CDP 하네스로 자동화**(2026-09-07 결재: 로컬 테스트 한정 허용, 계정 살아 있음) | 둘 다 |
| → **ITO(G1)** | 성재+1인 내부 테스트(웹+데스크톱+폰 QR) | | |

**연기(ITO 뒤)**: UX-R3a~c ⌘K 팔레트 · DS-1(·3·4) 잔여(R2c에 필요한 Card/Field/Banner만 R2c 안에서) · UX-R2d 온보딩 재진입 · #1925 허들 자격 3종 · #1792 TURN · M1 폰 UI 패리티 · #1927 work host(출시 후 ADR). (#1255는 SH-10으로 G1'-2 승격.) **G2 정의는 §7 제안 전까지 불변.**

의존: LS-α(LS-0·LS-4) 랜딩 뒤 G1'-1 발사 가능(LS-β·γ와 워커 병렬 2 안에서 교차 — 순서: LS-1 → SH-6a → LS-2 → SH-5a → …는 발사 시점에 편성). 티켓·패킷은 파도 착수 시 발급.

## 5. 결정 3건 (경량화 프로그램 §5 질문 → 결정)

1. **출시 잔여 재편성 = §4 확정.** 기준은 「두 케이스 E2E에 필요한가」. 팔레트·DS-1 잔여·R2d·허들·TURN은 어느 케이스에도 필요 없어 ITO 뒤로.
2. **work 표면 = 숨긴다.** 두 케이스 모두 work host(T3 데몬)를 쓰지 않는다. LS-2(uxui)에서 사이드바 `work`·`workConsole`·`workstreams`·`ade` 항목을 셀프호스트 기본 플래그 off로 숨기고 라우트·코드는 유지(플래그 1행 + 회귀 시험 1본).
3. **G3 스토어/TestFlight 게이트 문서 2건 = LS-3에서 삭제.** 두 케이스 모두 스토어 제출과 무관. G3 진입 때 RN 기준으로 새로 쓴다(git 히스토리 참조). 단 **`docs/external-agent-provider/*`는 삭제 금지**(B-4 재작성 대상 — LS-3 브리프에 명시).

## 6. 이 문서가 바꾸는 정본

- `2026-09-02-launch-program-plan.md` §1 G1 정의 → §2 E2E 2본 · §3·§9 파도 → 본 문서 §4 (개정은 LS-γ 랜딩 뒤 스냅샷 92와 함께 1회 — 그 전까지 본 문서가 우선).
- `2026-09-07-lightening-program.md` §4·§5 → 본 문서 §4·§5로 대체(포인터).
- LS-2·LS-3 브리프에 §5-2·§5-3 반영.

## 7. 2026-09-07 저녁 결재 반영 — 푸시·CDP·iOS (성재)

- **셀프호스팅 레벨 폰 푸시 = 1차 목표 안.** SH-10(#1255) momo-push-relay Rust: 같은 멀티커맨드 이미지, `docker-compose.push.yml` 이미지 = `MOMO_RUST_IMAGE`, 운영 모드 ①Dawn 공용(App Store 앱 기본, 셀프호스트 서버가 서버 ID+Ed25519 공개키로 등록 — v0는 정적 레지스트리 `MOMO_RELAY_SERVERS`, 자기등록 API는 후속) ②자체 relay(자기 Apple 계정·자기 빌드 앱, 같은 바이너리에 자기 .p8) ③stub(로컬). 계약(id-only 봉투 `momo.push.dispatch.v2`·raw-body Ed25519·상태 분류·영수증)은 Rust `momo-notifier`에 이미 있는 클라이언트 절반과 Swift 원본(`f399e417:relay/PushRelay/**`, ~700 LOC)에서 그대로. 크기 M~L(워커 1~2회전) + TestFlight 실수신 S(APNs 자산 확보됨).
- **케이스 A 전제 해소**: 계정 살아 있음 · 로컬 테스트 한정 CDP 허용 → E2E-A 자동화(#1361을 CDP 하네스로 재편, SH-8에 하네스 복구 포함).
- **출시 정의 개정(성재 확인 2026-09-08 — 「1번 진행」)**: G2 = 외부 셀프호스터 3 + **iOS 앱스토어 v0**(셀프호스트 서버에 QR로 붙는 폰 + 푸시 relay 경유 알림 + M1 중 출시 필수분만: 로그인·채널·타임라인·멘션·알림). 폰 UI 전체 패리티(M1 잔여)는 G3 유지. 순서: SH-10 → M0 QR(완료) → TestFlight internal(M2) → 스토어 심사는 G2 뒤.

## 8. 2026-09-08 결재 — 실기기 APNs 실수신은 다음 진행으로 보류(2번), 출시 정의 개정(1번)·G1'-1 브리프(3번) 진행. 남은 작업 지도: `docs/planning/2026-09-08-remaining-work-map.md`.
