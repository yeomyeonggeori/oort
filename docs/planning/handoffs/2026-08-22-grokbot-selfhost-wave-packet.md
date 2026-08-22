# 그록봇 원클릭 셀프호스트 파도 통합 패킷 — T-1~T-6 · V-1

> Status: `ready` · Planning ID: `PLN-20260822-01` · Planner owner: Fable · Integrator: momo-main
> 발급: 2026-08-22 · 기준 커밋: `b1bf46e98f54`(main) · Supersedes: 없음
> 근거 ADR: T-1=**ADR-0166 (Accepted 2026-08-22)** · 그 외=ADR not required(문서·릴리스·검증·기존 Accepted ADR 범위 내 UI) · 계획 정본: `docs/planning/research/2026-08-22-grokbot-one-click-selfhost-plan.md`(D1~D10·§9 성재 결재) + `research/2026-08-22-aside-onboarding-three-axis-plan.md`(E1~E10)
> GitHub binding: T-1=#1651 · T-2=#1652 · T-3=#1653 · T-4=#1654 · T-5=#1655 · T-6=#1656 · V-1=#1650
> 워커: grok 4.6 **병렬 1 순차** · 검수: Fable · **발사는 성재 명시 신호 대기**

## 0. 성재 결재 반영 (2026-08-22 — 이 파도의 전제)

1. **Q-STRUCT 확정: 체험자 본인 그록봇 계정/VM 전용.** 사용자가 자기 그록봇에게 지시해 자기 VM에 oort를 구동한다. 성재/팀 계정 VM을 공용 데모 호스트로 쓰는 변형은 **금지**. T-2 플레이북·핸드오프 문면에 이 구조를 명시한다.
2. **Q-CDP 확정: 검증 = 자연어 지시 릴레이.** 우리 쪽 E2E 검증에서 그록봇 CDP 자동 제어는 **은퇴**(Cursor ToS 자동화 접근 금지 조항). 그록봇에 보내는 지시문은 Fable이 작성하고 전달은 사람(성재)이 한다. 이 파도의 어떤 티켓도 그록봇 앱을 프로그램으로 제어하는 코드/절차를 만들지 않는다.
3. **Q-LEGAL 계류:** 조력 리스크(베타 무보증·개인 비상업·경쟁서비스) 법무 검토 여부는 성재 판단 대기. **T-2의 정본 머지 전 판단 권장** — 공개 플레이북이 조력의 실물이므로. 착수는 비차단.

## 1. 결정 요약 (왜 이 파도인가)

llms.txt URL 하나로 그록봇이 자기 VM에 oort를 구동하고, 사용자에게 접속 주소+앱 링크+1회용 셋업 링크를 회신하며, 자신은 에이전트 멤버로 합류한다(D1~D10). R-1(VM 영속성 — durable-but-resettable 공식 확증)·R-2(quick tunnel 전면 GREEN) 관문 통과. 1차 런칭 게이트 = PLN E2E + 그록봇 감지·등록(T-5) + 첫 왕복 온보딩(T-6) (E1~E6).

## 2. Goal 체인·순서

| 순서 | goal | 이슈 | 트랙 | 파일군 | 게이트 |
|---|---|---|---|---|---|
| G1 | V-1 digest agent-port 실측 | #1650 | engine | (검증만 — 코드 무변경) | 없음 |
| G2 | T-4 pg_dump 리커버리 | #1654 | engine | `scripts/`·`docs/` | 없음 |
| G3 | T-5 그록봇 감지·원클릭 초대 | #1655 | uxui | `clients/web/`·`packages/momo-core/` | 없음 |
| G4 | T-6 첫 왕복 게이트 계측 | #1656 | uxui | `clients/web/`·`scripts/bench_onboarding.sh` | T-5 후 권장 |
| G5 | T-1 claim-token 부트스트랩 | #1651 | engine | `server-rust/`·`clients/web/`(claim 폼) | ~~ADR-0166 Accept~~ **해제**(2026-08-22 성재 승인) |
| G6 | T-2 llms.txt+SELF_HOST_AGENT.md | #1652 | engine | 루트 `llms.txt`·`docs/` | T-1 계약 확정 후(§T-2 참조)·Q-LEGAL 판단 권장 |
| G7 | T-3 데스크탑 dmg 공개 릴리스 | #1653 | uxui+오케스트레이터 | `clients/desktop/`·릴리스 집행 | 실발행은 성재/오케스트레이터 |

머지 순서: **G1→G7 순차**(워커 병렬 1이라 자연 순차). 유일한 강한 의존은 T-1→T-2(claim URL 계약)와 ADR-0166 Accept→T-1. T-5·T-6은 uxui 트랙이라 engine 건과 파일 충돌 없음.

## 3. 티켓별 계약

### T-1 (#1651) claim-token 부트스트랩 — `[server]` ADR-0166

**사실**: 현행 부트스트랩은 `MOMO_INITIAL_OWNER_EMAIL/_PASSWORD` env 평문 → `momo-migrate` `bootstrap_owner`(`server-rust/bins/momo-migrate/src/main.rs:531`, `infra/prod/bootstrap_owner_if_absent.sql:20-21` 멱등) → 사람이 env 파일 grep(`docs/SELF_HOST.md:195`). 1회용 claim 개념 부재.
**작업**: ADR-0166 Decision 1~6 그대로 — ①토큰=해시 저장·원문 1회 유출(`routes/invites.rs:11-15` 동형) ②TTL+원자적 단회 소비(`momo-auth/src/hosted_connection.rs:155,188` 동형) ③무인증 claim 라우트(`routes/join.rs:1-20`·`lib.rs:1068` 마운트 방식+per-IP rate limit 동형) ④migrate claim 모드(opt-in, 기존 env 경로 불변) ⑤웹 `/claim/<token>` 비밀번호 설정 폼(로그인 표면 인접 — 데스크탑은 같은 번들).
**AC**: ADR-0166 「검증 계약」 전문 — 발급→미소비 로그인 거부→claim 설정→로그인 성공→재사용 거부→TTL 만료 거부→DB 원문 부재→로그 원문 비출현, 전부 단정 테스트. openapi 스펙 동기화.
**함정**: auth 미들웨어 바깥 마운트 근거 주석은 `lib.rs:396-403` 관례를 따를 것. 비밀번호 검증 3-상태는 `momo-messaging/src/identity.rs:301,365`.

### T-2 (#1652) llms.txt + SELF_HOST_AGENT.md 3계층 플레이북 — `[docs=제품]`

**사실**: 루트 `llms.txt`·`docs/SELF_HOST_AGENT.md` 둘 다 부재(레포 전수 확인). digest 정본은 `docs/SELF_HOST.md:65-152`(§2-B — app digest `:78-79`, 표 `:87-90`, amd64 경고 `:92-95`, attestation `:104-108`). R-2 실측: quick tunnel GREEN·데스크탑 Tauri Origin 무설정 통과·웹-경유-터널만 Origin 주입 필요(`research/2026-08-22-tunnel-spike-r2.md`).
**작업**: D2 이중 구조 — ①루트 `llms.txt`=에이전트 진입 stub(GitHub raw URL 링크) ②`docs/SELF_HOST_AGENT.md`=3계층 플레이북(D3): 코어 설치(멱등·digest 고정·헬스체크) / 환경 분기(공인 IP 판단→cloudflared quick tunnel→외부 도달성 자가검증) / 사용자 핸드오프(터널 주소+데스크탑 dmg 링크(Releases latest)+**claim URL(T-1 계약)**+첫날 사용법+영속성 고지). 에이전트 합류는 VM 내부 curl로 agent-port 왕복(#1361 커넥터 미지수 우회).
**필수 문면(성재 결재 반영)**: ⓐ"본인 그록봇 계정/VM에서 구동" 구조 명시(Q-STRUCT) ⓑ**멱등 재기동 섹션**(Update 시 이미지 증발 전제 — re-pull+볼륨 재부착, 소실 시 T-4 복원 경로) ⓒPostgres 데이터를 `/workspace` 하위 bind mount로 배치(RA-4 §8.3 — durable 층. 마커 실측이 볼륨 생존을 증명하면 완화 가능, 현재는 보수적 기본) ⓓ터널 URL=사실상 공개 주소 고지 ⓔ첫날 백업 안내(B7 트라이얼 잠김 대비 — T-4 결속).
**AC**: 플레이북만 읽고 (사람 개입 없이) 설치→터널→핸드오프 회신→에이전트 합류까지 도달 가능한 자기완결성 · 각 계층에 검증 게이트 명시(D3) · digest는 §2-B 실값과 일치 · `check_docs_commands` 그린. 최종 수용은 E2E 런(D7)에서.

### T-3 (#1653) 데스크탑 dmg 공개 릴리스 — `[release]`

**사실**: 서버 v0.1.0 태그+Release는 존재(2026-08-21, dmg 자산 없음). 데스크탑 현행 `0.1.0-next.1`(`clients/desktop/src-tauri/tauri.conf.json:4`), bundle target `["app"]`(`:45` — **dmg 아님**), 발행 체인=`scripts/publish_next_build.sh`(`:114` build → `:121` codesign → `:136` notarytool → `:142` staple → `:161-163` 재다운로드 검증)+`.github/workflows/release-desktop.yml`(dispatch 3모드). 서명 자산 전부 확보(`docs/NEXT_CHANNEL.md:145-150`). 현 배포는 next 채널(momo-alpha 저장소 updater)뿐 — **공개 다운로드 링크 부재**.
**작업**: ①bundle target에 dmg 추가(next 채널 `.app` 경로 불변 확인) ②dmg 빌드→서명→공증→스테이플 절차를 publish 체인에 가산(dry-run 검증) ③산출 dmg를 oort 저장소 v0.1.0 Release 자산으로 첨부하는 절차 문서화(RELEASING.md 가산). **실발행(공증·업로드)은 워커 아닌 성재/오케스트레이터 집행** — 워커는 build-only+dry-run까지.
**AC**: dry-run에서 dmg 산출+codesign strict 통과 · next 채널 발행 경로 회귀 없음(관련 검사 그린) · RELEASING 문면에 dmg 절차 1절 · T-2가 참조할 안정 다운로드 URL(Releases latest 패턴) 확정.
**함정**: 시크릿 3종 비유출 규칙(`NEXT_CHANNEL.md:141`). 버전 문자열은 next 채널과 계열 충돌 없게 택일 상신(v0.1.0 자산 vs 별도 desktop 태그).

### T-4 (#1654) pg_dump 리커버리 — `[scripts+docs]`

**사실**: 레포에서 실제 `pg_dump -Fc`를 도는 유일 코드=`scripts/verify_backup_restore_rehearsal.sh:102`(dump→별도 DB restore→marker 대조 — 재사용 원본). PITR 계열(`docs/runbooks/pgbackrest-pitr.md`)은 프로덕션 운영자용. **셀프호스터 "내 데이터 가져가기" 문서 부재.**
**작업**: D9 — ①오퍼레이터용 pg_dump 스크립트(VM 안에서 실행: 컨테이너 exec `pg_dump -Fc` → 덤프를 `/workspace` 하위에 배치 → 사용자 다운로드 안내 출력) ②복원 문서(새 oort 스택에 `pg_restore` — 다른 VPS/로컬로의 마이그레이션 경로, 그록 이탈·구독 해지 시나리오 명시) ③T-2 '데이터 가져가기' 섹션과 상호 링크 ④앱 UI export 버튼은 **후속 티켓 예약만**(본 파도 발급 안 함 — 컨텍스트 델타에 기록).
**AC**: 로컬 스택에서 dump→신규 스택 restore→메시지/멤버 잔존 단정 1회 실측 · 스크립트는 rehearsal.sh와 검증 로직 공유(중복 구현 금지) · 문서가 B7(트라이얼 잠김) 시나리오를 명시.

### T-5 (#1655) 그록봇 감지·원클릭 초대 — `[uxui]` E4·E5

**사실**: 페어링 위저드 랜딩 완료(#1360) — `clients/web/src/features/hostedAgents/HostedAgentWizard.tsx:165`(6단계 상태머신), 진입 `features/agentHub/AgentHubRoute.tsx:582`. 위저드는 Agent Port 주소+1회용 pairingCredential을 **출력**(`HostedAgentWizard.tsx:948-990`, `OneTimeSecretCard`). 감지 레지스트리 부재.
**작업**: ①감지 레지스트리(확장 가능 구조 — v1 시그니처는 Grok Bot 단일): **수동적 시그니처만** — 앱 번들 존재(`/Applications/Grok Bot.app`·`com.anysphere.sand`)·실행 프로세스. ⚠E4 원문의 "CDP 포트" 시그니처는 **Q-CDP 결재 취지(자동화 접근 회피)에 따라 제외** — 이탈로 보면 택일 상신 ②감지 시 "그록봇을 팀에 초대할까요?" 원클릭 → 위저드 자동 채움(identity 단계 프리필: 이름/핸들)+pairing 단계로 점프 ③pairing 출력 화면에 "이 값을 그록봇에게 자연어로 전달" 안내 문면 ④**재페어링 복구 경로**(VM Reset/Update 후) — regenerate(`server-rust/bins/momo-server/src/routes/hosted_agent_connections.rs:613`) 소비.
**AC**: E5 — best-effort 감지+**매끄러운 수동 폴백**(감지 실패 시 기존 위저드 경로 그대로, 수치 게이트 없음) · 미설치 환경에서 감지 UI 완전 침묵 · 4-상태 규율(`docs/design-system/README.md:271` — 빈/로딩/오류/오프라인) · momo-design-taste-web 프리플라이트+design-review 에이전트 Blocker 0.

### T-6 (#1656) 온보딩 첫 왕복 게이트 계측 — `[uxui+bench]` E6

**사실**: 첫 멘션→응답 왕복 계측은 **이미 존재** — `scripts/bench_onboarding.sh:712-760`(M5 first-reply: 멘션 POST→에이전트-author 메시지 폴링, ANSWERED/NOTICE/BLOCKED 3분기 `:29-40`). M1~M5 정의 `:12-16`. 클라이언트에 "첫 왕복" 온보딩 표면은 부재.
**작업**: ①클라이언트: 그록봇 초대 완료 직후 "첫 멘션을 보내보세요" 온보딩 표면 — 왕복 판정(응답 도착=완료)·4-상태(빈/로딩/오류/오프라인, 대표 구현 `clients/web/src/features/routing/AgentProfileDialog.tsx:65-72` 템플릿)·에이전트 뱃지 표시 필수 ②bench: `bench_onboarding.sh` 반복 실행 집계 모드(M5 p50/p95 산출 — 게이트 아닌 측정 항목).
**AC**: E6 — 미도착=불합격 판정 가능·무음 실패 불가(오류 상태 실존)·에이전트 뱃지 누락=불합격 · bench 집계 산출물에 p50/p95 · design-review Blocker 0.

### V-1 (#1650) GHCR 고정 digest에 agent-port 포함 실측 — `[verify]`

**사실**: 401 경로=`server-rust/bins/momo-server/src/routes/agent_port.rs:288`(MissingCredential→401)+`:303-305`(`WWW-Authenticate: Bearer scope="agent:port:connect"` 부착). 발행 digest는 `docs/SELF_HOST.md:87-90`.
**작업**: 고정 digest 컨테이너 부팅(§2-B 절차 그대로)→무인증 `POST /v1/mcp/agent-port` → **401 + WWW-Authenticate 헤더 둘 다** 확인. 증거(커맨드+응답 헤더)를 이슈에 기록.
**AC**: 401+헤더 실측 증거 1벌 · 스택 잔재 회수(`momo-docker-reclaim.sh`). 코드 무변경 — 실패 시(=발행 이미지에 agent-port 부재) 티켓을 blocked로 멈추고 보고(재발행 판단은 기획).
**함정(발사 시 가산 — 계약 불변)**: 로컬 맥=Apple Silicon, 발행 digest=amd64 단일 manifest라 native pull 불가(2026-08-21 실측). `--platform linux/amd64` 명시+Docker Desktop Rosetta 에뮬레이션 부팅 **허용** — V-1의 증명 대상은 이미지 내용물(agent-port 표면)이지 호스트 아키가 아니므로 유효. 증거에 에뮬레이션 사실 명기.

## 4. 지켜야 할 계약 (파도 공통)

- **본인 계정/VM 구조**(§0-1) — 어떤 산출물도 "우리 계정 VM을 남에게 개방"하는 절차를 만들지 않는다.
- **그록봇 앱 프로그램 제어 금지**(§0-2) — 검증·데모 절차 문서에 CDP/자동화 접근을 넣지 않는다.
- ADR-0004: pairing/claim 원문·비밀번호는 대화로그·이슈·스크린샷 비유입. V-1/T-4 증거에도 크레덴셜 마스킹.
- 불변식: Postgres=SoT·단일 쓰기경로·`message.seq`·에이전트=member·RLS FORCE. `schema_v0.sql` 수정 금지.
- 트랙 규율(`docs/TRACKS.md`): PR은 자기 트랙 브랜치로, main 머지는 성재 승인. 워커 merge/close 금지.

### 4.1 공통 함정 (검수 실측 축적분)

1. nil String?/UUID? 바인딩 → `::text`/`::uuid` 명시 캐스트. 2. 트랜잭션 내 HTTPError는 중앙 unwrap. 3. verifier 규율(bash 3.2 배열·api 컨테이너 curl 없음·`psql -q`·UUID lower()·포트 신규 대역·비동기=폴링). 4. compose/infra 변경 후 컨테이너 재시작. 5. openssl 직접 호출 금지(내부 Crypto). 6. Centrifugo payload props 일치 단정. 7. 게이트 후 docker 회수(`momo-docker-reclaim.sh`).

## 5. 검증

- 게이트: `scripts/local_gate.sh` 해당 프로파일 + 티켓별 AC(§3). UI 건(T-5·T-6)은 momo-design-taste-web 프리플라이트+design-review 에이전트.
- 파도 전체의 수용은 **E2E 런(D7·D8)** — 자연어 지시 릴레이로 수행(§0-2), 성재 입회.

## 6. 이탈 보고 의무

수용기준·ADR과 다르게 구현하게 되면 PR `## 계획 이탈` 섹션에 기록, 판단 필요 시 `scripts/goal_release.sh <issue> --blocked "<사유>"`로 정지. 임의 재설계 금지.

## 7. 착수 절차 (워커가 그대로 실행)

```bash
scripts/goal_status.sh                                  # 충돌 확인
scripts/goal_claim.sh --base track/engine <이슈번호>     # T-5·T-6은 --base track/uxui
# 구현 → 게이트 → PR(이슈 1개, 이탈 섹션 포함) →
scripts/goal_release.sh <이슈번호> --review --pr <PR URL>
# 여기서 정지. merge/close/로드맵은 momo-main 몫.
```

## 8. 컨텍스트 델타 (오케스트레이터/다음 planner용)

- **새로 고정한 것**: Q-STRUCT(본인 계정 전용)·Q-CDP(자연어 릴레이) 성문화(§0). T-3 스코프=dmg 공개 릴리스(서버 v0.1.0 태그·Release는 8/21 기존재). T-5 감지 시그니처에서 CDP 포트 제외(E4 원문과의 의도적 차이 — §T-5).
- **의도적으로 결정하지 않은 것**: Q-LEGAL(성재 계류) · T-3 버전 택일(자산 첨부 vs 별도 태그 — 워커 상신) · pgdata `/workspace` 배치의 완화 여부(마커 실측 후).
- **예약(발급 안 함)**: 앱 UI export 버튼(T-4 후속) · T-7 Slack import(RA-2 상신 대기) · T-8 구독 연동/BYOK(RA-3 상신 대기).
- **재기획 트리거**: V-1 실패(발행 이미지에 agent-port 부재) → 재발행 기획 · 마커 2종 소실 실측 → T-2 pgdata 계약 재확인 · ADR-0166 반려 → T-1·T-2 재설계.
