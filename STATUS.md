# momo 진행 현황

## UXUI MOMO-550 에이전트 주소 온보딩 (#638, 2026-07-22)

- macOS 멤버 디렉터리와 워크스페이스 설정에 관리자용 에이전트 주소 입력→공개 능력·인증 방식 동의→등록 흐름을 연결했다. 서버 4xx 사유는 인라인으로 표시하고 카드 제공 인증정보 입력란은 두지 않는다.
- confirm 뒤 서버 명부를 다시 읽어 새 에이전트를 반영하며, 기존 roster의 `origin=card|local`을 주소로 추가/직접 생성 뱃지로 투영한다. 한국어 동의 화면 light/dark snapshot과 REST·오류·카피 집중 테스트, 디자인 프리플라이트 3종, 독립 design-review(Blocker 0), macOS Swift build가 PASS했다.
- 기준 `track/uxui`에 남아 있던 Memory Plane·멤버 lifecycle 병합 충돌 표식 6곳은 양 계약을 모두 보존해 최소 해소했다. 실서버 UI 왕복은 momo-main 검수 전까지 `runtime-unverified`다.

## MOMO-548 외부 provider 추출 동의 게이트 (#625, 2026-07-22)

- migration 035에 기존 memory enabled 정책과 별도인 워크스페이스 외부 provider 명시 동의(기본 false)를 추가했다. 서버 admin REST/OpenAPI는 동의·공유 provider trust 판정·최종 추출 허용 여부를 투영한다.
- AgentWorker 추출/임베딩은 external 미동의 시 원문 provider 호출을 건너뛰고 `memory.extraction.consent_required`를 워크스페이스당 1회 기록한다. local-mock과 loopback/사설 self-host는 현행 유지한다.
- 공유 trust 정책·worker 동의 판정 유닛과 Swift/OpenAPI 정적 게이트를 수행하며, Docker `verify_memory_plane.sh` 동의 전이·회귀는 오케스트레이터 인수 전까지 `runtime-unverified`다.
## MOMO-538 셀프호스트 eve 옵션 프로파일 (#619, 2026-07-22)

- dev/prod compose에 기본 비활성 `eve` profile을 추가했다. Node 24.4.1 digest, eve 0.27.0, Postgres world 5.0.0-beta.27을 고정하고 MOMO-534 채널 프리셋과 모든 자격증명은 read-only mount/env 경계로만 주입한다.
- `eve-db-roles`는 momo PostgreSQL 클러스터 안에 별도 `eve_world` DB와 NOBYPASSRLS role을 만들되 momo schema object 권한은 부여하지 않는다. `verify_eve_profile.sh`가 dev/prod profile off/on drift, 기본 서비스 불변, 28140~28142 포트 선점, eve health·프리셋 load 로그·world durable table·momo table 접근 거부를 단정한다.
- 실제 provider credential을 사용하는 eve 세션 왕복만 `runtime-unverified(external eve model credentials)`다.

## MOMO-535 outbound 이벤트 구독 (#617, 2026-07-22)

- migration 033에 `event_subscription` FORCE RLS 원장과 mention·approval_request·work 상태 전이 transactional outbox 투영을 추가하고, 관리자 CRUD·감사·one-time HMAC secret 발급을 OpenAPI와 동기화했다. 평문 secret은 저장·재조회하지 않는다.
- OutboxRelay가 MOMO-536에서 분리한 공용 DNS/IP SSRF 정책으로 목적지를 재검증·IP 고정하고 exact-body HMAC-SHA256 POST, 지수 재시도, 누적 5xx 5회 자동 disable+system audit을 수행한다. 공용 정책은 Darwin/Glibc 분기를 포함한다.
- 전체 Swift 10개 패키지 build, 공용 정책 3·server 162·OutboxRelay 7 tests와 verifier bash/OpenAPI·compose YAML 정적 검증이 PASS했다. `verify_event_subscription.sh`는 28130~28134(run-tag 격리, 28132 선점 회피)에서 CRUD·서명·재시도·자동 disable·RLS를 단정하며 Docker 실런은 오케스트레이터 수행 전까지 `runtime-unverified`다.
## MOMO-547 ACP/PTY 자식 env 스크럽 옵션 (#624, 2026-07-22)

- WorkHostDaemon의 PTY·ACP·ACP terminal 자식 환경을 기본 allowlist(`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `COLORTERM`, `TMPDIR`)로 제한하고 `MOMO_WORKD_ENV_PASSTHROUGH`에 호스트 운영자가 명시한 이름만 추가한다. `MOMO_WORKD_*` 제어 변수는 항상 제외하며, 전역 legacy와 프로파일 legacy 모두 호스트의 명시적 옵트인이 필요하다.
- migration 034에 값이 아닌 환경변수 이름만 담는 `work_tool_profile.env_policy` JSON object를 추가했다. 서버 CRUD·workd 투영·OpenAPI는 `mode`/`passthrough`만 최소 검증하며, 프로파일 정책은 호스트 패스스루 allowlist를 넓히지 않고 좁힐 수만 있다. 동시 MOMO-535가 사용할 수 있는 033은 비워 두었다.
- WorkHostDaemon 15 tests(allowlist·패스스루 및 mock ACP 6 포함), MomoServer 161 tests, 전 9개 Swift 패키지 `swift build --disable-sandbox`, OpenAPI/YAML·bash 정적 검증은 PASS했다. 일반 `make build`는 관리형 환경의 중첩 `sandbox-exec` 거부로 코드 컴파일 전에 실패했다. `verify_work_tool_profile.sh`·기존 workd/acp verifier의 Docker 런타임 회귀는 오케스트레이터 수행 전까지 `runtime-unverified`다.
## MOMO-539 추출·임베딩 워커 실패 백오프와 포이즌 격리 (#620, 2026-07-22)

- memory extraction과 embedding 배치 실패에 기본 poll 간격부터 최대 5분까지 지수 백오프를 적용하고, 성공 시 지연을 리셋한다. `MEMORY_POISON_THRESHOLD` 기본값은 5이며 실패 카운트는 동일 워터마크/ID 배치별로 유지한다.
- 추출은 N회째 lease·워터마크를 검증해 커서를 전진시키며 `memory.extraction.poisoned` audit 1행을 같은 트랜잭션에 기록한다. 임베딩은 배치 전체 provider 성공 후 트랜잭션 반영하고, `memory.embedding.poisoned` audit의 ID 목록을 영속 skip marker로 사용해 스키마 변경 없이 다음 배치로 전진한다.
- AgentWorker 50 tests와 집중 10 tests가 실패 0이며 주입 sleeper로 실제 대기 없는 백오프·상한·성공 리셋·배치별 N회 격리를 단정했다. `verify_memory_plane.sh` 실제 PG18 회귀는 지시대로 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-546 workd ACP 이벤트 서버 릴레이 (#623, 2026-07-22)

- workd의 ACP sink를 mode 0600 raw JSONL + 서버 요약 relay 복합 sink로 바꾸고 progress/plan/승인 요청·결정/terminal 생성·종료를 기존 signed work-session PATCH로 보낸다. 서버는 신규 스키마·라우트 없이 세션 thread `message` 원장과 `message.new` + ACP envelope outbox를 한 트랜잭션에 투영한다.
- event UUID 멱등성, 65,536-byte 상한, 세션별 240건/60초, 최대 3회 backoff 재시도를 적용했다. `_meta.acp`, command/env/path, credential 및 raw terminal output은 allowlist에서 제거·서버에서도 거부하며 relay 실패 시 로컬 JSONL은 유지한다.
- WorkHostDaemon 13 tests(ACP 집중 6 포함), MomoServer 149 tests, 전체 9개 Swift 패키지 build, OpenAPI/YAML·bash 정적 검증과 `verify_acp_host.sh`의 28110~28113 PG18/Centrifugo mock ACP→thread message 5행+outbox 5행 실제 E2E가 PASS했다. 실 opencode/claude-agent-acp credential 왕복만 `runtime-unverified(external ACP agent credentials)`다.
## MOMO-536 에이전트 명부 + A2A 카드 URL 온보딩 (#616, 2026-07-22)

- migration 032에 `agent_card_registration` 원장(raw public card JSON·display-only security 요약·pending/confirmed 상태)과 workspace_id 기반 FORCE RLS를 추가했다. 관리자 `from-card`는 5초/256KB/최대 2홉 제한, 홉별 DNS 전체 IP 검사와 검증 IP 연결 고정, 기본 HTTPS 강제로 fail-closed fetch한 뒤에만 pending 원장을 쓴다.
- confirm은 기존 agent member/workspace membership 및 gateway bearer 발급 기계장치를 한 tenant transaction에서 재사용하고 `agent.created`·`agent.credential.issued`·`agent.card.confirmed` audit을 남긴다. roster에는 기존 필드를 유지한 채 agent `origin=card|local`을 가산했고 OpenAPI를 동기화했다.
- SSRF/redirect/card parser·요청 폐쇄성·migration 경계 집중 유닛 8건, 서버 전체 156 테스트, Swift 전 패키지 9개 빌드는 PASS했다. `verify_agent_card_onboarding.sh`는 28124~28128 격리 포트의 Python card mock으로 pending→confirm·credential digest·audit·origin·SSRF 400 무기록·RLS를 단정하며, Docker 실런은 오케스트레이터 수행 전까지 `runtime-unverified`다.
## MOMO-545 memory_refs 모델 실주입 (#622, 2026-07-22)

- worker와 Hermes gateway가 Context Packet의 `memory_refs` 세 payload 별칭을 fail-closed로 정규화해 시스템 프롬프트 뒤 `워크스페이스 메모리` 모델 컨텍스트로 주입하고, 기존 history 역할·채널 경계·`AGENT_CONTEXT_MAX_CHARS` 절사를 유지하되 메모리를 trigger보다 먼저 제거한다.
- 실제 모델 전달 시 `agent_run.input.memory_delivery={included_count,injected}` receipt를 기록하며, `/memories/search?agent=`가 호출자 아닌 agent scope를 차용하면 `memory.search.agent_scope_borrowed` audit 1행을 같은 tenant transaction에 남긴다. 스키마·기존 payload 필드는 변경하지 않았다.
- AgentWorker 47·server 150·Hermes adapter 60 tests와 focused 회귀가 실패 0이며, 격리 PG18+Centrifugo에서 `verify_agent_context.sh`가 mock Hermes 요청 덤프의 memory excerpt·별도 system 블록·budget/history 회귀·receipt `1|true`·차용 감사행·source DB digest 보존을 PASS했다.

## MOMO-534 eve/Cloudflare momo 채널 어댑터 2종 (#615, 2026-07-22)

- `examples/eve-momo-channel`은 eve 0.27.0 `defineChannel`/`routeAuth`/`send`/workspace·channel continuation token으로, `examples/cloudflare-agent-momo`는 permissive·audit 경계를 지키는 Agents SDK 0.3.10 인증 fetch로 기존 per-agent bearer gateway pending→event→complete 계약만 소비한다. 코어 서버·OpenAPI·스키마·루트 npm은 변경하지 않았다.
- 두 예제 TypeScript build와 Node 3 tests, `verify_momo_channel_adapter.sh` bash 문법이 PASS했다. 28120~28123 e2e stack의 mock eve pending→momo 메시지→완료 callback 실왕복은 오케스트레이터 실행 전까지, eve 실런타임은 beta 외부 런타임 설치 전까지 `runtime-unverified`다.

## UXUI MOMO-532 macOS 도구 프로파일·ACP 세션 카드 (#604, 2026-07-22)

- Work Console의 고정 도구 enum을 임의 registry key를 보존하는 동적 모델로 바꾸고, 관리자용 `work_tool_profile` 등록·수정·삭제 UI와 등록된 enabled 프로파일만 표시·실행하는 fail-closed 목록을 연결했다. 일반 멤버는 앱의 Ed25519 Work Host 신원으로 enabled projection을 서명 조회하며, launch template에는 command key와 인자만 허용하고 절대경로·자격증명 형태를 클라이언트에서도 거부한다.
- 로컬 ACP 세션의 plan·tool progress·permission 이벤트를 구조화 카드로 투영했다. 엔진이 제시한 `allow_once`·`allow_always`·`reject_once`·`reject_always`만 노출하고, 결정 이벤트 뒤에는 제어를 제거한 불변 결과 카드를 유지한다. ACP raw·stderr·terminal bytes는 계속 호스트 로컬 경계 밖으로 보내지 않는다.
- Core 동적 tool key, 관리자 CRUD/호스트 서명 projection, ACP 4방향 승인·결정 불변성 집중 테스트와 한국어 라이트·다크 ACP/설정 snapshot이 PASS했다. design preflight, 전 Swift 패키지 build/test와 macOS 462 tests(1 skip, 0 failure), iOS Simulator 무서명 build, Docker 기동·migration 031 멱등 적용까지 PASS했다. `macos-ui`의 마지막 기존 real-backend roster verifier는 이 변경이 건드리지 않은 seed fixture에서 `agent-lab` 활성 human/agent membership을 찾지 못해 실패했으며(evidence: `local-gate-macos-ui-20260722T063508Z-pid94487-ns1784702108326888000-wt28dc727668fb-rd6dbab8bd522.md`), workd의 ACP plan/progress/승인 이벤트를 서버 thread/realtime 카드로 전달하는 MOMO-546(#623)과 함께 해당 실왕복만 `runtime-unverified`다.
- PR #632 디자인 리뷰 후속으로 원장 우회 `start(tool:)` 경로를 제거하고, ACP 실패·종료·결정 불가 상태, 프로파일 로딩/빈/오류와 에디터 저장 재시도, 승인 문법·도구 정체성·접근성 카피를 정합했다. Work Console 라이트·다크 18 snapshot과 집중 33 tests(1 sandbox skip), macOS build, 디자인 프리플라이트 3종, 독립 design-review(Blocker 0)는 PASS했다. 전체 macOS suite 재실행에서는 기존 `AgentCredentialSnapshotTests`의 headless 1x↔2x SnapshotTesting crash와 이미 STATUS에 기록된 attachment UTI/MIME 4단정만 남았다.

## UXUI MOMO-529 메모리 브라우저·서빙 인스펙터 (#603, 2026-07-22)

- macOS 워크스페이스 메뉴와 에이전트 프로필에 "에이전트가 아는 것" 브라우저를 추가했다. 스코프·에이전트·무효 상태 필터, 검색, 열람·편집·무효화, 출처 메시지 이동, 관리자 정책 스위치는 모두 서버 Memory REST를 권위로 사용하며 기존 데이터를 로딩·오류 중에도 유지한다.
- Work run 상세에는 저장된 불변 Context Packet을 여는 읽기 전용 인스펙터를 추가해 히스토리·memory refs·tool grants·budget·redactions·만료 상태를 표시한다. packet은 클라이언트에서 재조립하지 않고 기존 run/message props에서 식별자를 발견한 경우에만 GET으로 조회한다.
- MomoCore·macOS build와 메모리 브라우저·인스펙터 집중 8 tests, 한국어 브라우저 및 인스펙터 라이트·다크 스냅샷 4종이 PASS했다. design-review 지적에 따라 내부 packet 어휘·원시 UUID를 제거하고 필터/정책/빈 상태 카피와 자연어 seq·budget 단위·출처 접근성 표기를 정리했다. macOS 전체 suite는 변경과 무관한 기존 `AgentCredentialSnapshotTests`의 headless `NSImage` nil unwrap(signal 5)에서 2회 중단됐다. 서버에 아직 없는 visibility grant 목록/회수, run→packet 식별자 투영, `memory.updated` Core realtime 소비, cache 밖 source_ref 메시지 단건 이동은 ENGINE_HANDOFF X-11로 역요청했으며 그 전까지 해당 동작은 거짓 개방하지 않는다. 실서버 편집→realtime 수렴은 momo-main 검증 전까지 `runtime-unverified`다.

## UXUI MOMO-525 macOS·iOS 멤버 lifecycle·audit (#609, 2026-07-22)

- ADR-0128/A-15의 workspace 역할·suspend/reinstate/remove+ban·self-leave·audit cursor 계약을 macOS와 iOS 인증 REST 클라이언트에 연결했다. owner/admin 역할 서열은 클라이언트에서도 fail-closed하고 서버가 최종 권한·마지막 owner 409를 판정한다. audit은 action prefix·대상 멤버·24시간/7일/30일 시간 범위와 cursor를 정본 query로 전달한다.
- macOS workspace 멤버 inspector에는 guest/suspended 표시, 역할 메뉴, 정지·복원 확인, 선택적 사유와 재가입 차단이 있는 삭제 sheet, agent credential 재발급 안내, 필터·cursor audit sheet를 추가했다. iOS Profile에는 Members and audit, 동일 관리 상세, workspace self-leave를 추가했고 양 플랫폼의 일반 채널 메뉴에는 self-leave를 추가하되 DM은 노출하지 않는다.
- PR #610 반려 후 신규 멤버 관리·self-leave·audit 카피를 macOS `MomoWorkspaceCopy`와 iOS `IOSWorkspaceCopy` 정본으로 이관했고, 사용자 문구의 token 어휘를 로그인 세션으로 교체했다. 제거 실패는 양 플랫폼 sheet 내부에, macOS 채널 나가기 실패는 타임라인 인라인 배너에 표시하며 audit 행은 날짜·시간과 행위자→대상을 함께 노출한다.
- MomoiOSKit XCTest 2 + Swift Testing 69 tests와 macOS 컴파일·MOMO-525 한국어 light/dark real-window 집중 테스트는 PASS했다. macOS 전체 459 tests 중 457 PASS·1 loopback skip이며 이번 diff와 무관한 기존 Work Console terminal preset canonical 2종만 현재 렌더와 불일치한다. momo-main이 확인한 공식 iOS 빌드 PASS는 지시대로 재실행하지 않았고, 인증된 owner/admin/guest 계정의 실제 403·409·audit cursor 왕복과 iPhone Dynamic Type/VoiceOver는 오케스트레이터 확인 전까지 `runtime-unverified`다.
## MOMO-528 Context Packet v0 불변 승격 (#598, 2026-07-22)

- migration 030에 불변 `context_packet` 원장·FORCE RLS와 기본 actor/agent/workspace 스코프 ∪ 유효 visibility grant 검색 필터를 추가하고, mention 트랜잭션이 profile 상시+fact/episode 질의 memory refs와 실제 plugin capability grant를 동결한다.
- worker/gateway 공통 payload에 `context_packet_id`·`context_packet`·`memory_refs`를 가산하고 기존 projection alias를 유지했으며, 현재 run-channel 멤버만 저장 packet을 열람하는 GET과 OpenAPI/런타임 스펙을 추가했다.
- 전 9개 Swift 패키지 `swift build --disable-sandbox`와 Core 38·server 145·OutboxRelay 2·PushRelay 6·AgentWorker 44·WorkHostDaemon 6·NotifierWorker 4·LinkShort 5 unit, docs local gate, `verify_context_packet.sh` bash 문법과 `git diff --check`가 PASS했다. 일반 Swift local gate는 관리형 환경의 중첩 `sandbox-exec` 거부로 코드 컴파일 전에 실패해 동일 패키지를 `--disable-sandbox`로 검증했다. 28100~28103 격리 Docker의 불변성·만료 재발급·grant revoke·scope·RLS 실제 왕복은 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-531 momo-acp-host v0 (#601, 2026-07-22)

- 재사용 가능한 `MomoACPHost`가 ACP JSON-RPC/stdio `initialize`→`session/new`→`session/prompt`, `session/update`의 `agent.partial`/`agent.status` 카드 투영, `_meta.acp` host-local 보존, `session/request_permission` 승인 정지점과 `terminal/*` PTY 위임을 구현했다. 앱 세션 매니저는 기존 승인 카드 결정과 PTY 소유자를 주입하며, 결정 전 continuation을 보류하고 누락·잘못된 option은 거부한다.
- workd는 `work_tool_profile.tier_defaults.transport=acp` 투영으로만 ACP를 선택하고 launch_template의 command/arguments를 그대로 소비한다. 일반 도구는 Pipe 대신 실제 PTY로 실행해 R4를 복구했으며, ACP raw·stderr·terminal bytes는 mode 0600 host-local 파일 밖으로 보내지 않는다. 서버·OpenAPI·migration·`schema_v0.sql`은 변경하지 않았다.
- `scripts/verify_acp_host.sh`의 credential-free mock ACP approve/reject·plan/progress·terminal 분기와 WorkHostDaemon 11 tests, macOS SwiftPM build가 PASS했다. opencode native ACP와 claude-agent-acp 실 credential 왕복은 `runtime-unverified(external ACP agent credentials)`이며 오케스트레이터 opt-in 검증이 남았다.

## MOMO-533 work_tool_profile 원장 (#600, 2026-07-22)

- ADR-0130 D3에 따라 migration 028에 workspace별 `work_tool_profile` FORCE RLS 원장과 기본 4종 시드를 추가하고, 관리자 CRUD·audit 및 spawn/승인 dispatch/session/resume의 미등재·disabled fail-closed 검증을 OpenAPI와 서버에 반영했다. launch template은 command key+인자만 허용하며 절대경로·credential 형태를 거부한다.
- workd는 하드코딩 프로파일 대신 signed GET enabled 투영을 소비해 호스트 로컬에서 executable을 해석하고 spawn 직전 투영을 갱신한다. 전 9개 Swift 패키지 build와 macOS 외 8개 패키지 test, server 146 tests·workd 7 tests, OpenAPI/YAML·bash/docs 정적 검증은 PASS했다. macOS 전체 test는 변경하지 않은 기존 스냅샷의 headless `NSImage` nil(signal 5)과 attachment UTI/MIME 기대 4건으로 미통과했으며, 비스냅샷 352건 중 347 PASS·1 SKIP·4 FAIL이다. `verify_work_tool_profile.sh`의 사전검사된 28080~28083 PG18 실왕복 및 `runtime-db` 회귀는 Docker 실행 금지 지시에 따라 오케스트레이터 게이트 전까지 `runtime-unverified`다.
## MOMO-527 pgvector·FTS·RRF 하이브리드 메모리 검색 (#597, 2026-07-22)

- dev/e2e/prod PostgreSQL 서비스를 digest 고정 `pgvector/pgvector:0.8.5-pg18` 이미지로 통일하고, migration 028에 `vector` extension·384차원 embedding/HNSW·generated `tsv`/GIN·SECURITY INVOKER RRF 함수를 추가했다. 기존 컨테이너는 새 이미지를 pull한 뒤 재생성이 필요하다.
- `GET /v1/workspaces/:ws/memories/search`는 정상 tenant connection에서 membership·source channel 가시성을 fail-closed 재검증하고 scope/agent 필터와 전용 30/60초 rate limit을 적용한다. 임베딩 실패·미생성 항목은 FTS-only로 계속 검색되며, AgentWorker가 결정적 mock 또는 기존 Hermes BYOA `/embeddings` 경계로 비동기 벡터를 채운다.
- 전 9개 Swift 패키지 `swift build --disable-sandbox`가 PASS했고 Core 42·server 144·OutboxRelay 2·PushRelay 6·AgentWorker 42·WorkHostDaemon 6·NotifierWorker 4·LinkShort 5 tests가 실패 0이다. macOS 테스트 코드는 컴파일됐으나 headless 환경의 첫 NSImage snapshot nil unwrap으로 xctest signal 5가 발생했다. 일반 `make build`는 관리형 환경의 중첩 `sandbox-exec` 거부로 코드 컴파일 전에 실패해 동일 패키지를 `--disable-sandbox`로 검증했다.
- `verify_pgvector_contract.sh`, OpenAPI YAML parse, verifier bash 문법과 `git diff --check`는 PASS했다. 지시대로 Docker를 실행하지 않아 `verify_memory_search.sh`의 FTS-only·vector-only·RRF·scope·RLS·rate-limit 실제 PG18 왕복과 `runtime-db` 회귀는 오케스트레이터 실행 전까지 `runtime-unverified`이며, external Hermes embedding도 credential opt-in 전까지 `runtime-unverified`다.

## W-6 웹 Work 관전 v0 (#605, 2026-07-21)

- 웹에 credential-free Work 세션 목록, 기존 Timeline 기반 root thread read-only 관전, 메모리 전용 observer capability를 HTTPS direct stream에만 전달하는 lazy xterm 터미널을 추가했다. 입력·resize·kill UI/전송은 없으며 WSS-only·query-bearing·비HTTPS 원격 endpoint는 fail-closed한다.
- MomoCore와 같은 `artifact_kind=diff|commit|pr` 우선순위·상한·안전한 HTTPS 링크 규칙으로 웹 타입드 카드를 렌더한다. Vitest 71 tests(artifact 11, observer 상태기계 13), eslint, typecheck, Vite build, npm permissive license gate가 PASS했다.
- 실제 server→remote host observer HTTPS stream, CORS/CSP, capability 만료·회수 왕복은 지시대로 Docker·브라우저를 실행하지 않아 오케스트레이터 검증 전까지 `runtime-unverified`다.

## MOMO-526 Memory Plane 스키마·추출 워커 v0 (#596, 2026-07-21)

- ADR-0129 D1·D2·D5에 따라 migration 027에 Memory Plane 원장·채널 워터마크·정책 스위치를 FORCE RLS로 추가하고, source_ref는 message/channel 식별자만 저장한다. 메모리 CRUD·무효화·admin 정책-off 일괄 삭제 REST와 `memory.updated` transactional outbox를 OpenAPI 정본에 반영했다.
- AgentWorker는 기존 BYOA Hermes transport 또는 결정적 mock으로 후보 추출→기존 유사 대조→ADD/UPDATE/INVALIDATE/NOOP를 수행하며 후보·메모리·lifecycle·audit·outbox·watermark를 한 트랜잭션에 반영한다. server 141 tests·AgentWorker 41 tests와 전 9개 Swift 패키지 build, OpenAPI YAML, verifier bash/ShellCheck 정적 검증은 PASS했다.
- `verify_memory_plane.sh`의 28030~28033 격리 PG18 왕복과 `runtime-db` 회귀는 오케스트레이터 실행 전까지 `runtime-unverified`다. 실제 external Hermes 추출은 repo 밖 credential opt-in 전까지 `runtime-unverified`이며 provider 자격증명은 worker process 밖으로 유입하지 않는다.

## W-5 초대 링크 웹 합류 (#593, 2026-07-21)

- `/join?code=...`와 `/i/<code>` SPA 폴백이 같은 가입 폼을 사용하고, 표시명·handle·이메일·비밀번호를 현재 오리진의 `POST /v1/join`으로만 보낸다. 만료·소진·차단 403을 종결 카피로 구분하고 가입 성공 후 `history.replaceState`로 초대 코드 URL을 제거한다.
- pinned `momo-linkshort` 이미지를 prod install/upgrade·rollback에 편입하고 Caddy `/i/*`를 SPA보다 먼저 LinkShort로 프록시했다. LinkShort는 `https://${APP_DOMAIN}/join?code=...`만 조립하며 코드를 저장·검증하지 않는다.
- 웹 47 tests(신규 초대 파싱·검증·오류 9), lint, typecheck, build와 LinkShort 5 tests, publish/install 정적 계약 및 bash 문법은 PASS했다. Docker/Caddy/브라우저는 지시대로 실행하지 않았으며 초대 생성→단축링크→가입→메시지 1건 실왕복은 오케스트레이터 게이트 전까지 `runtime-unverified`다.

## MOMO-530 gateway work tool 원장 경로 (2026-07-21)

- Gateway BYOA adapter가 host 설정 시 `work.spawn|input|read|kill` 닫힌 스키마를 provider에 노출하고, 서버는 `status=tool_call` callback의 run/lease/actor/`work:control` scope를 재검증한 뒤 기존 `WorkControlRoutes` 승인·auto-approve·host·lineage·audit/outbox 트랜잭션을 그대로 재사용한다. host UUID는 provider arguments 밖의 adapter 설정에서만 주입하며 call_id 재시도는 멱등, 다른 입력 재사용은 409다.
- server 138 tests, AgentWorker 35 tests, Hermes adapter 56 tests, Python compile, verifier bash 정적 검증은 PASS했다. `verify_hermes_gateway_adapter.sh`의 gateway spawn→승인→dispatch→ack 실왕복과 기존 worker runtime 경로 회귀는 Docker 실행 금지 지시에 따라 오케스트레이터 게이트 전까지 `runtime-unverified`다.

## W-3 Caddy APP_DOMAIN 웹 서빙 (#576, 2026-07-21)

- ADR-0119 D1-A에 따라 `momo-web`의 실제 Vite `dist`를 pinned 이미지에서 named volume으로 복사하는 `web-init`과 Caddy의 같은 오리진 SPA·`/v1/*`·`/health` 라우팅, Centrifugo callback 403, 지정 CSP를 완성했다. 당시 예약한 LinkShort `/i/*` 위치는 W-5 #593에서 실행됐다.
- npm production build와 YAML/bash 정적 검증은 PASS했다. `verify_web_serving.sh`는 W-5에서 `/join`·`/i/*`를 더해 8개 HTTP 단정으로 확장됐으며, 지시대로 Docker/Caddy runtime과 공인 DNS·ACME·prod TLS는 오케스트레이터 검증 전까지 `runtime-unverified`다.
## W-4 웹 승인·read-state·recovery 왕복 (#577, 2026-07-21)

- 웹 타임라인 승인 카드는 `props.approval_status`와 `approval.*` 이벤트를 소비하고, pending/approved/rejected/expired 상태 칩과 멱등 결정 재시도를 제공한다. `resume_offer`는 결정 버튼 없이 데스크톱 재개 안내만 표시한다.
- 가시 메시지 기반 300ms read-state debounce, 비활성 채널 unread/mention 즉시 갱신과 REST 재조회, `recovered:false`·seq gap REST reconcile, 지수 백오프 재연결 배너, 오프라인 컴포저 비활성화를 추가했다.
- Vitest 38 tests, eslint, TypeScript typecheck, Vite build는 PASS했다. 승인 결정 상태 전이와 2탭 read-state의 실서버 왕복은 지시대로 Docker·브라우저를 실행하지 않아 오케스트레이터 게이트 전까지 `runtime-unverified`다.

## MOMO-524 self-leave·에이전트 대칭·audit 조회 (2026-07-21)

- ADR-0128 D4~D6에 따라 public/private 채널과 workspace self-leave, private 최종 멤버 archive, 마지막 owner 409, agent suspend/remove credential 즉시 revoke와 banned-handle 생성/pairing 차단, owner/admin audit 필터·cursor REST를 기존 FORCE RLS 원장 위에 가산했다. migration과 `schema_v0.sql` 변경은 없다.
- server 136 tests, Swift build, OpenAPI YAML parse, verifier bash/ShellCheck 정적 검증은 PASS했다. `verify_lifecycle_completion.sh`(28060~28063)와 기존 membership/agent-create verifier의 실제 PG18 왕복은 오케스트레이터 게이트 전까지 `runtime-unverified`다.

## MOMO-523 멤버십 수명주기 코어 (2026-07-21)

- ADR-0128 D1~D3에 따라 migration 026의 `workspace_membership`·`workspace_ban` FORCE RLS 원장, 중앙 `WorkspaceAuthorization`, 워크스페이스/채널 역할 변경과 suspend/reinstate/remove/ban REST·audit, suspend 로그인 403 및 token revoke, ban join/redeem 차단, guest roster 교집합 투영을 추가했다.
- server 130 tests, Swift build, OpenAPI YAML, verifier/local-gate bash 정적 검증은 PASS했다. `verify_membership_lifecycle.sh`(28050~28053)와 requireWorkspaceAdmin 회귀의 실제 PG18 왕복은 지시대로 실행하지 않아 오케스트레이터 게이트 전까지 `runtime-unverified`다.
## MOMO-521 S3 호환 첨부 archive + MinIO 프로파일 (#563, 2026-07-21)

- ADR-0127에 따라 `MOMO_ARCHIVE_BACKEND=drive|s3` 부팅 선택과 SDK 없는 AWS SigV4 `S3ArchiveClient`를 추가했다. S3는 15분 presigned PUT/GET, signed HEAD 메타 확정, signed DELETE를 지원하며 불완전한 자격은 기존 unavailable 구현으로 fail-closed한다.
- e2e/prod compose에 opt-in `s3` MinIO+bucket init 프로파일과 public HTTPS Caddy data plane을 추가했다. REST/OpenAPI/클라이언트와 `schema_v0.sql`은 변경하지 않았다.
- AWS 공식 SigV4 vector·presign 만료·path-style 집중 테스트와 server 130 tests, verifier bash/ShellCheck·compose YAML 정적 검증이 PASS했다. 지시대로 Docker를 실행하지 않아 Drive stub 및 MinIO 28040~28044 실제 왕복은 오케스트레이터 게이트 전까지 `runtime-unverified`다.
## UXUI MOMO-518 macOS·iOS 산출물 카드 표준 (#592, 2026-07-21)

- ADR-0126 D2의 공용 `artifact_kind=diff|commit|pr` 해석을 MomoCore의 닫힌 표현 모델로 추가했다. unified diff는 200KB·2,000줄·100파일 상한 안에서만 파일별 경로와 추가/삭제 수를 계산하며, 일반 코드·malformed·oversized 입력은 기존 메시지 렌더로 fail-safe한다. commit/PR 링크는 HTTPS만 허용하고 credential 계열 query key·userinfo를 거부한다.
- macOS·iOS 타임라인에 파일별 DisclosureGroup, 총/파일별 +/− 요약, 모노스페이스 시맨틱 diff 라인과 제목·브랜치·상태·repository·안전한 링크 카드를 추가했다. agent 개발자 모드와 무관하게 검토 대상 산출물은 같은 타입드 카드로 보이고, URL이 거부돼도 메타데이터 카드는 유지된다.
- Core 42 tests, macOS 457 tests(관리형 loopback WebSocket 1 skip), MomoiOSKit 69 tests가 실패 0으로 PASS했고, 전체 `make build`·`make test`도 구성된 Core·서버·relay·workers·service·macOS 패키지에서 PASS했다. iOS generic Simulator `xcodebuild`는 package resolution 뒤 Xcode build-service의 package-loading 단계에서 60초 이상 산출물 갱신 없이 정체돼 중단했다. 실제 iOS 타깃 컴파일, real-window/Simulator 라이트·다크, Dynamic Type/VoiceOver, 키보드 DisclosureGroup·링크 동작 및 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-514 iOS 토큰 자동 리프레시·비파괴 오류 UX (#554, 2026-07-21)

- iOS의 인증 REST·realtime token·다운로드·허들 요청을 하나의 actor executor로 통합했다. 401은 single-use refresh token을 단 한 번 회전한 뒤 원 요청을 한 번만 재시도하며, 이미 회전된 뒤 늦게 도착한 401은 새 access token으로만 재시도해 refresh replay를 만들지 않는다. 회전 실패 또는 재시도 401만 `sessionExpired`로 분류한다.
- access/refresh token과 NSE fetch session을 App/NSE 공유 `AfterFirstUnlockThisDeviceOnly` Keychain으로 옮겼다. 기존 App Group·legacy UserDefaults의 평문 세션은 1회 migration 후 성공 여부와 무관하게 삭제하고, Keychain 일부 쓰기 실패는 두 값을 모두 제거해 fail-closed한다. 토큰은 URL query·로그·UserDefaults에 새로 기록하지 않는다.
- 이미 표시한 타임라인의 history 갱신이 실패해도 기존 메시지와 갱신 중 수신한 realtime 이벤트를 유지하고 인라인 재시도 배너만 표시한다. session refresh가 실제로 실패한 경우에만 Profile 재로그인 안내를 노출한다. MomoiOSKit 69 tests(보안 저장·migration·staggered 401 single-flight·비파괴 타임라인 신규 4)가 PASS했고, 앱+Notification Service generic iOS Simulator 무서명 `xcodebuild build`가 PASS했다. 실제 15분 만료·토큰 회전, 서명된 실기기의 App↔NSE 공유 Keychain, 라이트/다크·Dynamic Type 및 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-502 iOS 검색·활동 실데이터화 (#589, 2026-07-21)

- Search 탭을 채널명 로컬 필터와 서버 FTS `GET /search/messages`의 300ms debounce·opaque cursor 결과로 통합했다. 서버 snippet의 문자 offset을 Unicode-safe하게 강조하고, 결과의 channel/message/seq를 사용해 `before=seq+1` history를 불러온 뒤 정확한 메시지 행으로 이동·강조한다. 검색 갱신 실패는 기존 결과를 지우지 않고 인라인 오류와 재시도를 제공한다.
- Activity 탭은 별도 서버 피드가 없는 v0 경계를 명시하고, 각 대화의 최근 200개 history와 reaction snapshot을 기기에서 집계해 나를 멘션한 메시지와 내 메시지에 다른 멤버가 남긴 반응을 최신순으로 표시한다. `mention_member_ids` UUID는 소문자로 정규화하고 자기 반응·삭제·thread reply를 제외하며, 항목을 누르면 동일한 정확한 메시지 점프를 사용한다.
- MomoiOSKit 67 tests(신규 검색 debounce/Unicode offset·정확한 before cursor·활동 UUID/자기반응 경계 3)가 PASS했고 generic iOS Simulator 무서명 `xcodebuild build`가 PASS했다. 인증 서버 FTS cursor·membership 격리, 실제 멘션/반응의 Mac↔iPhone 반영, 라이트/다크·Dynamic Type 스냅샷과 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-501 iOS 첨부 송수신 (#587, 2026-07-21)

- iOS 컴포저 `+` 메뉴에 사진 보관함·파일·카메라를 연결하고, 100MB 경계 검증 뒤 서버 upload session 발급 → capability URL 직접 PUT → complete → 메시지 `attachmentIds` 전송을 구현했다. 업로드 상태·개별 실패·재시도·삭제를 유지하며 첨부만 있는 메시지도 보낼 수 있고, 메시지 REST 실패는 같은 idempotency key와 완료된 첨부 ID로 재시도한다.
- 수신 `Message.attachments`는 이미지를 인증 content proxy로 내려받아 인라인 미리보기하고, 일반 파일은 진행·실패·재시도 카드에서 Quick Look을 연다. 완료 파일은 iOS 공유 시트로 저장/공유할 수 있다. upload capability는 ephemeral URLSession의 지역 변수에서만 소비하고 Authorization header·URL query·로그·UserDefaults·메시지 모델에 넣지 않으며, 완료 응답 UUID 비교는 소문자로 정규화한다.
- MomoiOSKit 64 tests(신규 첨부 전송·실패 재시도 2)가 PASS했고, generic iOS Simulator 무서명 `xcodebuild build`가 PASS했다. 실제 iPhone→Mac 사진, Mac→iPhone 일반 파일, 카메라 권한·Quick Look/저장, 라이트/다크·Dynamic Type 스냅샷과 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-500 iOS 스레드 1급 (#585, 2026-07-21)

- 채널 타임라인은 서버 `Message.thread`의 답글 수를 실제 롤업으로 표시하고, replies REST 첫 페이지에서 확인한 실제 참여자만 아바타로 노출한다. 롤업을 열면 root 원문과 cursor 답글 전 페이지를 한 화면에 복원하며 `thread.updated`를 즉시 반영하고, 컴포저는 일반 메시지 REST에 동일 `rootId`·`reply_to_id`를 보존한다. 상위 타임라인에는 답글 realtime 행이 별도 메시지처럼 섞이지 않는다.
- 홈 Threads는 채널별 최근 200개 root와 replies cursor를 로컬 집계해 내가 root를 작성했거나 답글에 참여한 스레드만 마지막 답글순으로 제공한다. 새 서버 follow 원장을 가장하지 않으며, 갱신 실패 시 기존 목록을 유지하고 인라인 오류를 표시한다. 알림으로 직접 연 스레드에서도 컴포저가 열려 정확한 root로 답장한다.
- Design Read: iPhone 팀 메신저의 고밀도 native List, Mattermost식 replies 문법, 장식 모션 없음. 시맨틱 색상·Dynamic Type·4/8/12/16/24/32 스페이싱 pre-flight와 MomoiOSKit 62 tests가 PASS했고, `xcodebuild` generic iOS Simulator 무서명 앱 빌드가 PASS했다. 이 게이트에서 직전 MOMO-504의 누락된 `MomoiOSPushKit` import도 보정했다. 시뮬레이터 라이트/다크·Dynamic Type 스냅샷과 인증된 Mac↔iPhone 스레드 왕복은 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-504 iOS 알림 UX v2 (#583, 2026-07-21)

- `momo.push.notification.v2`의 APNs `thread-id`, 4개 category, 승인 전용 `approval_id`, 서버 badge를 닫힌 파서로 소비한다. 잠금화면 빠른 답장은 기존 메시지 REST에 같은 root/reply 대상을 유지하고, 승인·거부는 기존 approval decision REST를 재사용한다. UUID는 비교·딥링크·요청 경계에서 소문자로 정규화하며 NSE의 id-only 본문 fetch 경계는 넓히지 않았다.
- 알림 탭은 정확한 채널·메시지·스레드로 이동하고 Work category는 Work 탭의 동일 root 세션 상세로 이동한다. Profile에는 잠금화면 액션 등록 설정과 서버 채널 음소거를 분리해 제공하며, 후자는 멘션 포함 전달만 억제하고 unread는 바꾸지 않음을 명시했다. 카테고리별 서버 전달 억제 API는 없어 거짓 토글을 만들지 않고 ENGINE_HANDOFF X-10으로 역요청했다.
- MomoiOSKit 60 tests(신규 v2 파서·승인 경계·중복 쿼리 거부·빠른 답장·승인 결정·비자격 설정 5건)가 PASS했다. `verify_ios_build.sh`와 package-resolution 고정 재시도는 모두 Xcode build service의 package-loading 단계에서 산출물 갱신 없이 정체돼 중단했으며, 실 APNs 빠른답장·승인·딥링크·badge, iOS 앱 타깃 재빌드 및 시뮬레이터 육안은 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-520 macOS 호스트 상실 전환·티어 정책 (#579, 2026-07-21)

- Work Console이 서버의 `orphaned`·`endReason`·`resumedFromSessionId` projection을 소비하고, `resume_offer` 메시지를 일반 승인과 구분된 전환 카드로 렌더한다. 카드에서 Work 서랍의 원 세션으로 이동해 online·미revoke이면서 본인 또는 workspace 소유인 다른 host를 선택하고 resume REST로 새 세션을 만든다. 새 세션은 같은 root thread와 이전 세션 계보를 카드·상세에 표시한다.
- Work 설정에 본인 override와 owner/admin용 workspace 기본 `t1_only`/`ask`/`auto` 정책을 추가했다. auto target은 `cloud` 또는 서버가 허용하는 등록 host만 전송하고 UUID는 소문자로 정규화한다. 재개 UI에는 v0가 마지막 push commit부터 새 세션을 만들며 PTY·프로세스·미커밋 변경을 옮기지 않는다는 손실 경계를 명시한다.
- 선재 terminal color-vision/high-contrast 기준 이미지 드리프트 2건을 제외한 macOS 전체 455 tests와 Work Console 집중 29 tests가 PASS했다(관리형 sandbox loopback WebSocket 1 skip). policy GET/PUT, resume POST, UUID 정규화, orphan/reason/lineage decode 및 `resume_offer` light/dark 카드와 설정 light/dark snapshot을 자동 검증한다. ask 카드 실왕복, t1_only 카드 미생성, auto 재디스패치, 실제 host 전환·동일 스레드 계보, real-window 라이트/다크·접근성 및 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-517 macOS 관전 터미널 (#575, 2026-07-21)

- 비소유 채널 멤버는 서버 projection이 `remoteAttachAvailable=true`, `observation=open`인 running 세션에서만 observer capability를 발급받아 기존 SwiftTerm을 읽기 전용으로 연다. observer 세션은 입력·resize·kill을 네트워크로 보내지 않고, 화면 상단에 관전 모드와 제어 불가를 명시한다. owner 세션은 기존 controller 모드를 유지한다.
- 세션 상세에 `관전 N` projection과 소유자 전용 `팀 관전 허용`/`소유자만` 토글을 추가했다. `owner_only`, ended, 미결속, 로컬 PTY, 현재 멤버 미확정 상태는 fail-closed하며 열린 observer 연결도 다음 projection 갱신에서 즉시 정리한다. attach capability는 메모리의 Authorization header에만 머물고 URL query·로그·UserDefaults에 저장하지 않는다.
- macOS 전체 454 tests와 Work Console 집중 27 tests가 PASS했다(관리형 sandbox loopback WebSocket 1 skip). observer 정책, controller/observer attach body, observation PATCH, observer stdin·resize·kill 0건을 자동 검증한다. 실제 2계정 owner↔observer PTY, real-window 라이트/다크·접근성 육안 및 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-506 iOS Work 세션 상세 (#571, 2026-07-21)

- iOS Work 세션 카드에서 서버의 root thread replies cursor를 끝까지 읽어 중간보고·결과를 기존 타임라인 문법으로 표시하고, 선택한 active agent에게 공개 스레드 답글로 `work_input`·`work_read`를 요청한다. 세션 ID는 소문자로 정규화하며 human iOS가 agent 전용 `work-controls`를 직접 호출하지 않는다.
- pending `work_control_approval` 카드를 Work 탭에 모아 기존 승인/거부 UI를 재사용하고, 도구별 auto-approve GET/PUT/DELETE 현재값과 최초 조회 실패·재시도를 명시했다. 선택한 agent와 현재 channel의 active run에만 `AgentPartial` 텍스트·tool 이름·비용을 메모리 투영하고 tool args는 버리며, durable thread message 또는 terminal status가 도착하면 임시 카드를 제거한다.
- MomoiOSKit 55 tests(신규 Work 상세 5)가 PASS했고 디자인 pre-flight도 PASS했다. `scripts/verify_ios_build.sh`는 Xcode 26.5가 generic Simulator build description에서 10분간 CPU 0%로 멈춰 중단했으며 소스 컴파일 오류는 출력되지 않았다. 인증된 폰 승인→Mac PTY 실행→폰 개입→검토 발췌 1왕복, iOS Xcode 게이트 재실행, 시뮬레이터 라이트/다크·Dynamic Type 스냅샷과 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI MOMO-505 iOS Work 세션 관제 (#569, 2026-07-21)

- iOS Work 탭이 `work-sessions`·`work-hosts`·`work-pool` REST projection과 채널별 `work.session.*` realtime hint를 소비한다. 진행 세션 우선 목록, 전체/진행 중 필터, 정적 상태 칩, 도구 아이콘, host 표시명·online, 시작·경과 시간, pool 사용량을 추가했으며 realtime 수신 뒤에는 REST를 다시 읽어 정본 projection을 유지한다.
- 프로필의 Developer Mode가 꺼져 있으면 진행/완료 수만 보여주는 요약 카드로 축소하고, 켰을 때만 host·pool·개별 세션을 노출한다. Work 탭이 활성일 때만 realtime 구독을 유지하며 모델에는 PTY raw 출력·로컬 경로·attach capability/endpoint를 포함하지 않는다. 초기 실패는 명시적 empty/error, 갱신 실패는 기존 데이터를 유지한 인라인 배너로 처리한다.
- `scripts/verify_ios_build.sh`의 generic Simulator build, build-for-testing, 부팅된 iPhone 17 Pro test-without-building과 MomoiOSKit 50 tests(신규 Work 3)가 PASS했고 디자인 pre-flight도 PASS했다. 인증 실데이터의 Mac→iPhone realtime 반영, 라이트/다크·Dynamic Type 스냅샷과 design-review는 Fable 오케스트레이터 확인 전까지 `runtime-unverified`다.

## UXUI 511-U remoteAttachAvailable 실데이터 개방 (#567, 2026-07-21)

- macOS `MomoWorkSession`이 서버의 credential-free `remoteAttachAvailable` projection을 소비한다. owner의 running 세션이 `true`일 때만 기존 SwiftTerm 터미널 액션을 열고, `false` 또는 필드 누락은 fail-closed하며 기존 명시적 `ptyId` fixture는 후방 호환한다. capability와 attach endpoint의 메모리 전용 경계는 변경하지 않았다.
- Work Console focused 24 tests(실패 0, managed sandbox loopback 1 skip), 터미널 테마 스냅샷 suite를 제외한 macOS 445 tests(실패 0, 동일 1 skip), 디자인 pre-flight가 PASS했다. 전체 451 tests의 terminal color-vision/high-contrast snapshot 2건은 변경 전 clean `track/uxui@4e41132`에서도 같은 pixel ratio로 재현되는 선재 기준 이미지 드리프트이며, Fable 오케스트레이터의 snapshot/design-review 재기록 전까지 해당 2건만 `runtime-unverified`다.

## MOMO-519 호스트 상실 티어 폴백 서버 계약 (2026-07-21)

- ADR-0125 D11에 따라 workspace 기본/member override `work_tier_policy`(t1_only/ask/auto), stale heartbeat의 orphan 전이, ask `resume_offer` 카드와 `momo.work` 알림, t1_only terminal 정리, auto 재디스패치를 기존 PG→outbox 및 Notifier 폴링 경로에 추가했다.
- human owner의 resume REST는 같은 root thread를 유지한 새 running session과 `resumed_from_session_id` 계보·기존 spawn control을 한 tenant transaction에 기록하고 원 세션을 ended(resumed)로 닫는다. 경로·자격증명·PTY/프로세스 상태는 유입하지 않는다.
- server 127 tests·NotifierWorker 4 tests·PushRelay 6 tests·WorkHostDaemon 6 tests와 OpenAPI YAML/operationId·verifier bash/ShellCheck 정적 검증이 PASS했다. `verify_tier_fallback.sh`의 28020~28023 격리 Docker 런타임은 오케스트레이터 실행 전까지 `runtime-unverified`다.

## W-2 웹 read-only 클라이언트 정비 (#557, 2026-07-21)

- 기존 `clients/web` 위에 서버 URL `/health` 확인, HTTPS/localhost 정책, 메모리 access·회전 refresh 인증, 채널 unread/mention·muted, 200건 타임라인과 과거 cursor, 5분 저자 그룹·날짜·멘션·edited/tombstone·링크/코드·반응 snapshot을 가산했다. `message.new/edited/deleted`와 `reaction.added/removed`는 cold-load 버퍼 뒤 적용하며 Centrifugo recovery를 요청한다.
- empty/loading/error/offline과 세션 만료 인라인 상태를 추가했고, 만료 시 기존 메시지를 유지한다. Vitest 20 tests, eslint, TypeScript typecheck, Vite build는 PASS했다. Docker·브라우저 라이트/다크·한국어 장문·200+ 스크롤 육안은 오케스트레이터 게이트 전까지 `runtime-unverified`다.
## MOMO-516 observer terminal attach + X-8 projection (#558, 2026-07-21)

- terminal attach에 기본 `controller`와 채널 멤버용 read-only `observer` capability 등급, owner-only observation 토글, 검증 응답 mode, count-only `work.session.observer` projection을 추가했다. 세션 응답은 유효 `observerGrantCount`와 credential-free `remoteAttachAvailable`만 투영하며 raw PTY 스트림은 계속 client↔host 직결이다.
- migration 024·OpenAPI·server 126 tests와 verifier bash/ShellCheck 정적 검증은 PASS했다. 지정대로 Docker verifier는 실행하지 않아 `verify_observer_attach.sh`와 기존 terminal attach 회귀의 실제 PG18/Centrifugo 왕복은 오케스트레이터 게이트 전까지 `runtime-unverified`다.

## UXUI MOMO-511-U macOS 원격 터미널 attach (2026-07-21)

- macOS Work 서랍이 owner의 running 원격 `work_session`에서 exact 3-field attach grant를 메모리에서만 소비하고, capability를 Authorization header로 전달해 SwiftTerm과 remote PTY를 직접 연결한다. stdout 렌더, byte stdin, 문자 단위 resize, kill 프레임은 `connect/send_stdin/resize/kill` 최소 계약만 사용하며 capability와 endpoint를 URL query, UserDefaults, 로그, 원장에 남기지 않는다.
- 로컬·원격 터미널은 같은 SwiftTerm 표면을 사용한다. 원격 호스트 표시명 배지 하나, 발급/연결/만료/403/409/429/네트워크 단절 인라인 상태와 재연결, ended read-only 출력 선택·스크롤, 카드→서랍 진입, 서랍·앱 종료 소켓 정리를 추가했다. 서버 목록 응답은 remote PTY 결속 여부를 투영하지 않으므로 액션은 `ptyId`가 명시된 세션에만 fail-closed한다. 정확한 사전 판별용 `remoteAttachAvailable` 또는 `ptyId` read projection은 엔진 후속 요청이며, 랜딩 전 실데이터 액션 노출은 `runtime-unverified`다.
- Design Read: Work 서랍 terminal surface for internal team users on macOS, HIG-first, density 7/10, motion 2/10. 정적 디자인 리뷰는 Blocker 0으로 PASS했고 High 2건(ended 출력 상호작용, 미결속 세션 액션)을 반영했다.
- `swift build --disable-sandbox`와 Work Console 24 tests(실패 0)가 PASS했다. in-process mock은 grant→stdout/stdin/resize/kill 및 오류 상태를 검증했다. 실제 URLSession loopback WebSocket은 managed sandbox가 연결을 차단해 1 test skip이며, 실 E2B/원격 host와 loopback socket 재실행은 오케스트레이터 수동 게이트 전까지 `runtime-unverified`다.

## UXUI iOS 메시지 상호작용 MOMO-499 (2026-07-21)

- iOS 타임라인의 확정 `seq` 메시지 롱프레스에 시스템 시트를 연결하고 최근 반응·반응 피커, 기존 답글 경로, 작성자 전용 수정·삭제 확인, 복사를 추가했다. 반응 pill은 그룹 경계와 무관하게 해당 메시지 행에 귀속되며 서버 응답 전에는 화면을 바꾸지 않는다.
- iOS REST 클라이언트가 반응 스냅샷, 반응 PUT/DELETE, 메시지 PATCH/DELETE를 소비하고 `reaction.added/removed`·`message.edited/deleted`를 reducer에 반영한다. cold load 중 realtime 이벤트는 스냅샷 위에 순서대로 재적용하며 삭제 시 반응 projection도 제거한다.
- MomoiOSKit 47 tests가 PASS했다(기존 41 + 상호작용 6). 지시대로 `xcodebuild`·시뮬레이터·실기기 왕복은 실행하지 않았으며, 시뮬레이터 스냅샷과 맥→폰 반응 실시간 반영은 오케스트레이터/성재 게이트 전까지 `runtime-unverified`다.
## MOMO-513 message.new realtime props 정합 (#553, 2026-07-21)

- 메시지 전송 REST 응답과 같은 최종 props(서버가 투영한 `mention_member_ids` 포함)를 transactional outbox의 `message.new` payload에도 전달해 라이브 수신과 콜드 로드의 멘션·답장·승인 표시를 일치시켰다.
- `message.edited`가 기존 props를 보존하는 경로를 상호작용 verifier로 재확인하고, 멘션 verifier에 REST↔outbox props 일치 단정을 추가했다. Swift 테스트와 verifier 정적 검증은 PASS했으며 Docker runtime verifier는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-503 푸시 페이로드 v2 (2026-07-21)

- NotifierWorker→PushRelay 닫힌 계약을 `momo.push.dispatch.v2`로 올리고, APNs `thread-id`(`root_id ?? channel_id`)·4개 category(`momo.message|mention|approval|work`)·승인 전용 `approval_id`를 id-only 경계 안에서 가산했다. 기존 DM/멘션/승인 수신자 판정, 자기 메시지·채널 음소거 억제는 바꾸지 않았다.
- badge는 unread 채널 수 근사치 대신 ADR-0109의 채널별 `max(latest_seq-last_read_seq, 0)` 합계를 수신자별 계산한다. server 126 tests·NotifierWorker 4 tests·PushRelay 5 tests와 verifier bash/ShellCheck 정적 검증은 PASS했다.
- `verify_push_notifier.sh`는 전용 27990~27994 포트에서 4 category, channel/root 그룹핑, 승인 ID 단독 노출, unread 합계 일치, 음소거 회귀를 검사한다. Docker 실런은 오케스트레이터 담당이라 현재 `runtime-unverified`다.

## UXUI MOMO-512 NativeTextView 포커스 복원 (2026-07-20)

- MOMO-508 네이티브 컴포저의 포커스 상태를 SwiftUI `.focused`와 연결되지 않은 `@FocusState` 대신 representable 갱신을 보장하는 `@State`로 소유하게 했다. 루트 뷰 교체 시 들어온 최초 focus 요청도 소비하고, AppKit window 부착 시 재동기화하며 제거된 text view의 지연 콜백은 first responder를 탈취하지 못한다.
- 실제 WindowServer에서 rootView 교체 후 `MomoMessageComposerNativeTextView` first responder 복원 테스트를 반복 PASS했고, 컴포저 집중 4 tests·real-window 주변 4 tests·macOS 전체 445 tests가 PASS했다.

## UXUI iOS 타임라인 v2 MOMO-498 (2026-07-20)

- iOS 타임라인에 동일 작성자 5분 단위 그룹핑, 날짜 구분선, 서버 `mention_member_ids` 기반 내 멘션 강조, 수정 배지와 삭제 tombstone, Markdown 링크 및 가로 스크롤 코드 블록 렌더를 추가했다. 메시지는 각각 독립적인 List 행과 안정 ID를 유지해 답장 스와이프·컨텍스트 메뉴·200건 이상 지연 렌더 경계를 보존한다.
- iOS history DTO가 엔진 X-5의 `state`·`editedAtMs`·`deletedAtMs`를 버리던 갭을 닫아 cold load에서도 수정/삭제 상태가 복원된다. realtime `message.edited`·`message.deleted`는 기존 reducer를 그대로 소비하며 삭제 본문은 UI에 노출하지 않는다.
- MomoiOSKit 41 tests와 iPhone Simulator 무서명 build, build-for-testing, test-without-building이 PASS했다. 인증 실데이터를 사용한 라이트/다크·접근성 Dynamic Type·한국어 장문 스냅샷과 200건 스크롤 육안 판정은 Fable/성재 수동 게이트 전까지 `runtime-unverified`다.

## UXUI iOS v1 모바일 기반 MOMO-496/497 (2026-07-20)

- MOMO-496은 macOS 브랜드 원본과 정렬한 iOS AppIcon 일반·다크·틴트 1024 자산, 적응형 AccentColor·런치 배경, 재현 가능한 CoreGraphics 생성기를 추가했다. 세 PNG는 sRGB·불투명 1024 정사각형이며 asset catalog 컴파일이 PASS했다.
- MOMO-497은 시스템 TabView 기반 홈·검색·활동·Work·프로필 5탭과 탭별 독립 NavigationStack을 도입했다. 홈은 Threads·채널·DM, unread/mention, 음소거, 읽음 처리, 실제 값이 있을 때만 보이는 DM presence를 제공하며 기존 타임라인·답장·승인·허들 경로를 재사용한다. 푸시는 다른 탭에서 수신해도 Home 경로로 전환한다.
- iPhone 17 시뮬레이터 build/run, `scripts/verify_ios_build.sh` build-for-testing/test-without-building, MomoiOSKit 37 tests, 디자인 재리뷰 Blocker/High 0이 PASS했다. 인증 후 홈·5탭 라이트/다크·Dynamic Type 스냅샷과 실기기 아이콘 표면은 Fable/성재 수동 게이트로 남는다. 현재 roster REST는 presence를 투영하지 않으므로 실데이터 DM 점은 엔진 realtime/REST 계약이 열릴 때까지 `runtime-unverified`이며, 앱은 거짓 offline 상태를 표시하지 않는다.

## MOMO-511 원격 인터랙티브 터미널 attach 서버 계약 (2026-07-20)

- ADR-0125 D10에 따라 running `work_session`에 remote `pty_id`·credential-free HTTPS/WSS endpoint를 결속하고, 세션 소유자 human bearer 전용 `POST .../terminal-attach`가 exact `{attach_endpoint,capability_token,pty_id}` 60초 grant를 발급한다. capability 원장은 SHA-256 digest와 발급·만료·소유자만 저장·audit하며 raw token은 남기지 않는다.
- host의 Ed25519-signed validation은 매 요청 capability 만료, running session, PTY binding, `work_host.revoked_at`을 다시 확인해 이미 발급된 grant도 revoke 즉시 무효화한다. E2B-compatible `create/connect/send_stdin/resize/kill` 추상 계약만 서버에 고정했고 실제 host adapter·SwiftTerm UX는 후속이다. MomoServer/relay에는 터미널 stream/outbox/publish route가 없어 raw는 client↔host 직결이다.
- server 124 tests, OpenAPI/YAML, verifier bash·ShellCheck(error) 정적 검증이 PASS했다. `verify_terminal_attach.sh`는 27980~27983 전용 포트에서 발급·만료·비소유자/agent 403·revoke·digest/audit/RLS·raw/token 무유입을 검사하며 runtime-db에 편입했다. 오케스트레이터가 격리 Docker 실런을 수행해(2026-07-21, main c953322) 발급·만료·비소유자/agent 403·revoke·raw 직결 우회·audit/RLS가 PASS했다 — `runtime-verified`.

## MOMO-509 관리자 에이전트 생성 API (2026-07-20)

- human owner/admin 전용 `POST /v1/workspaces/:ws/agents`를 추가했다. 기존 `001_init.sql` 계약만 재사용해 `member(kind=agent)`·`agent`·`agent.created` audit를 한 tenant transaction에서 생성하며, workspace handle 중복은 partial row 없이 409로 닫는다. `baseUrl`은 HTTPS 기본·명시적 local loopback opt-in만 허용하고 userinfo/query/fragment 및 config의 credential형 키를 거부해 ADR-0004 provider credential 비유입 경계를 유지한다.
- 생성 API는 채널 membership과 credential을 자동 발급하지 않는다. OpenAPI와 RUN 문서에 기존 `POST .../channels/:channel/members` → `POST .../agents/:agent/credentials`를 명시적인 pairing 후속 흐름으로 기록했다. 공유 Core 계약 변경은 필요하지 않았다.
- server 124 tests, OpenAPI/YAML·bash/ShellCheck·local-gate drift 정적 검증이 PASS했다. `verify_agent_create.sh`는 seed-none fresh DB와 충돌 사전검사한 27970~27973 격리 포트에서 생성·중복 409·비admin 403·pairing/credential·audit·FORCE RLS를 단정하며 runtime-db에 편입했다. 오케스트레이터가 fresh DB Docker 실런을 수행해(2026-07-21, main c953322) 생성·중복 409·비admin 403·pairing·credential·audit·RLS가 PASS했다 — `runtime-verified`.

## MOMO-491 PushRelay OpenSSL 리졸버 하드닝 (2026-07-20)

- `verify_work_host.sh`의 Ed25519 capability probe를 `verify_push_relay.sh`와 `push_relay_keygen.sh`에 이식하고, 두 스크립트의 모든 `genpkey`/`pkey`/`pkeyutl`/`base64` 호출을 리졸브된 `OPENSSL_BIN`으로 통일했다.
- 로그인 셸이 `/usr/bin/openssl` LibreSSL 3.3.6을 우선하는 실제 환경에서 keygen과 `bash -lc 'scripts/verify_push_relay.sh'`가 PASS했고 docs local gate 21/21도 PASS했다. Docker를 포함한 전체 `runtime-relay` 프로필은 지시대로 오케스트레이터 실행 대상으로 남겼다.

## UXUI A-11 Work Host 자기등록 (2026-07-20)

- macOS 앱이 로그인한 workspace/member별 로컬 Ed25519 신원을 생성해 개인키를 Application Support에 0600으로 보관하고, 공개키만 `work-hosts` 등록 REST에 전달한다. 동일 공개키의 활성 app host는 재사용하며 revoke되었거나 없을 때만 새로 등록해 서버가 반환한 `host_id`를 Work Console의 유일한 라우팅 ID로 채택한다.
- Work Console은 등록 전·실패 시 세션 시작과 원격 control 소비를 fail-closed한다. 설정에는 등록/online 상태와 복사 가능한 host ID, AgentWorker `MOMO_WORK_HOST_ID` 조율 안내를 표시하며, 정확한 heartbeat payload를 로컬 키로 서명한다. private key·capability URL·cwd·자격증명은 서버 요청·로그·UI·커밋에 포함하지 않는다.
- macOS 전체 테스트, 디자인 pre-flight·라이트/다크/고대비 큰 글자 및 실패/offline raster 검수, `macos-ui` local gate를 검증 대상으로 한다. 실제 서버 로그인→등록→AgentWorker spawn/control→ack 한 사이클은 성재 환경 수동 QA 전까지 `runtime-unverified`다.
## MOMO-489 work_pool 동적 세션 슬롯·쿼터 원장 (2026-07-20)

- ADR-0125 D5에 따라 workspace PK의 `work_pool` FORCE RLS 설정 원장과 멤버 GET/admin PUT REST를 추가했다. 사용량은 `work_session.status='running'` 집계만 사용하며 PUT과 `work.pool.updated` 감사는 한 tenant transaction에서 커밋한다.
- `POST /work-sessions`는 같은 트랜잭션에서 work_pool 행을 `FOR UPDATE` 잠그고 workspace hard cap과 member soft limit을 검사한다. 초과는 세션·카드·outbox 없이 `pool_exhausted`/`member_limit` 409만 반환하며, 종료는 집계에서 자동 회복한다. 자동 대기열 시작·대기 카드는 UXUI 후속이고 웜 인스턴스 풀은 프로비저너 후속이다.
- server 122 tests와 OpenAPI/YAML·verifier bash 정적 검증이 PASS했다. `verify_work_pool.sh`는 27960~27963 격리 포트에서 기본행/acquire/두 한도/동시 경쟁/종료 회복/admin audit/RLS를 단정하며 runtime-db에 편입했다. 지시대로 격리 Docker 실런은 오케스트레이터 담당이라 실행 전까지 `runtime-unverified`다.

## MOMO-493 auto-approve 현재값 조회 계약 (2026-07-20)

- human active member만 호출할 수 있는 `GET /v1/workspaces/:ws/work-auto-approvals`를 추가했다. 응답은 호출자 자신의 tool 문자열만 사전순으로 반환하며 host·경로·프로세스 환경·자격증명은 포함하지 않는다.
- OpenAPI operation/closed response를 가산하고 drift sample을 연결했다. `verify_work_control.sh`는 PUT→GET 정렬 snapshot→DELETE→GET 부재, agent 거부, 다른 human 설정 격리와 기존 cross-tenant FORCE RLS를 한 시나리오로 단정한다.
- server 121 tests와 docs local gate 20/20가 PASS했다. 격리 `verify_work_control.sh`와 전체 `runtime-db` Docker 실런은 지시대로 오케스트레이터 담당이라 실행 전까지 `runtime-unverified`다.

## UXUI A-10 Interactive Work Console (2026-07-20)

- macOS 중앙 패널 하단에 Control+backtick으로 여는 Work 서랍을 추가했다. SwiftTerm(MIT) 기반 로컬 PTY에서 Claude Code·Codex CLI·OpenCode·로그인 셸을 실행하고, 세션 목록/상태/종료, 서버가 만든 채널 카드, 세션 스레드 열기, 사용자가 검토한 출력 발췌 공유를 연결했다.
- MOMO-483/484 REST와 `work.session.*`·`work.control.dispatched`를 소비해 로컬 spawn/input/read/kill 및 ack를 처리한다. 기존 `approval_request` 카드를 그대로 사용하고 tool별 auto-approve PUT/DELETE UI를 제공한다. 서버에 현재 설정을 읽는 계약은 없어 앱 시작 시 거짓 기본값 대신 `unknown`을 표시하며 X-6 역핸드오프로 기록했다.
- ADR-0114 D3 경계를 따라 PTY raw·실제 cwd·프로세스 환경/자격증명은 서버 요청, 로그, UI 상태, 영속 상태에 넣지 않는다. `work.read`는 자동 전송하지 않고 사람이 발췌를 검토·편집·승인한 뒤에만 일반 thread reply로 보낸다. REST 계약 테스트는 `/Users`, `PATH`, `TOKEN`, terminal output이 요청에 없음을 단정한다.
- macOS 420 tests, unsigned Xcode build, 디자인 pre-flight와 `macos-ui` local gate를 검증한다. 실제 서버에서 Codex↔momo 승인/제어/스레드 한 사이클은 C-2 수동 QA 전까지 `runtime-unverified`다. Xcode 배포 타깃의 App Sandbox는 별도 보안 승인 없이 변경하지 않았으며, 해당 빌드에서는 로컬 CLI 시작을 fail-closed하고 SwiftPM 개발 빌드에서만 PTY를 허용한다.
## MOMO-488 momo-workd v0 사용자 호스트 데몬 (2026-07-20)

- ADR-0125 D2에 따라 macOS/Linux Swift 실행 패키지 `workers/WorkHostDaemon`(`momo-workd`)을 추가했다. 데몬은 로컬 0600 Ed25519 신원으로 workd host를 1회 등록하고 heartbeat 및 허용된 REST action을 서명하며, 자기 앞 dispatched control만 outbound poll한다.
- spawn/input/kill은 기존 work_session/work_control REST를 통해 Foundation.Process·stdin pipe·terminate에 연결된다. 명령 템플릿과 raw stdout/stderr는 호스트 로컬에만 있고, 실패 ack는 고정 error label만 보낸다. launchd/systemd 사용자 서비스, SSH `scripts/momo host add` 초안, prod `--with-workd` 예약 훅을 추가했다.
- server 121 tests와 WorkHostDaemon 6 tests, bootstrap/verifier bash·ShellCheck·plist 정적 검증이 PASS했다. `verify_workd.sh`는 27950~27953에서 등록/heartbeat→spawn echo→ack→running/ended→위조 401→RLS→raw 서버 미유입을 단정하며 runtime-db에 편입됐다. 지시대로 격리 Docker 실런은 오케스트레이터 담당이라 실행 전까지 `runtime-unverified`다.

## MOMO-487 work_host 레지스트리 + control 라우팅 (2026-07-20)

- ADR-0125 D1/D8에 따라 Ed25519 공개키·member/workspace scope·app/workd/cloud type을 갖는 `work_host` FORCE RLS 원장과 등록/목록/서명 heartbeat/revoke REST를 추가했다. 등록·revoke audit는 같은 tenant transaction에 기록하며 capabilities는 boolean availability flag만 받는다.
- `work_session.host_id`·`work_control.target_host_id`를 검증된 FK로 묶고, control 생성은 등록·미철회·workspace·scope를 검증해 404/403으로 닫는다. 승인 대기 중 host가 revoke되면 dispatch 대신 control을 `failed`로 전이하고 no-version `work.control.acked(ok=false,error_label=host_revoked)`를 발행한다. Core는 REST `WorkHost`만 디코드하며 신규 realtime kind는 추가하지 않았다.
- server 120 tests와 Core 38 tests, relay/worker/LinkShort tests 및 8개 Swift 패키지 `--disable-sandbox` build가 PASS했고 docs local gate는 19/19 PASS했다. macOS test runner는 선재 AppKit snapshot의 `NSImage` nil 강제 언랩(signal 5)으로 종료했으며, managed sandbox 안의 `make build`는 중첩 `sandbox-exec`가 거부되어 동일 패키지 build를 직접 검증했다. OpenAPI 및 기존 work-session/control/AgentWorker verifier는 선행 host 등록을 사용하고, 신규 `verify_work_host.sh`를 `runtime-db`에 편입했다. 격리 Docker 실런은 오케스트레이터 담당이라 실행 전까지 `runtime-unverified`다.

## MOMO-486 AgentWorker work.* dispatch + chat-to-session E2E (2026-07-20)

- AgentWorker가 Hermes OpenAI-compatible tool call의 `work_spawn|work_input|work_read|work_kill`을 strict schema로 파싱해 기존 MOMO-484 `POST work-controls`로 per-agent bearer 호출한다. channel/host는 run·프로세스 설정에 고정하고 UUID, label 120자, text 4000자를 worker 경계에서 먼저 검증한다.
- spawn `pending_approval`은 “승인 대기” thread 응답으로 현재 run을 종료하고, work-control approval은 일반 tool approval의 AgentWorker resume/cancel 흐름을 타지 않는다. input/spawn/kill 성공은 카드·control event만 쓰며 중복 채팅 회신을 만들지 않고, read만 REST 결과를 본문에 포함한다. 계보 밖 input의 서버 403 문구는 HTTP status와 함께 그대로 durable thread 답글에 남긴다.
- AgentWorker 35 tests와 server 118 tests, mock Hermes Python 문법/fixture, 새 verifier bash/ShellCheck 정적 검증은 PASS했다. `verify_work_agent_e2e.sh`는 27930~27933 격리 포트에서 mention→pending→승인→dispatch→host session/ack→thread input→비계보 403→RLS를 단정하며 `runtime-db`에 편입됐다. Docker 실런은 오케스트레이터 담당이라 실행 전까지 `runtime-unverified`다.

## MOMO-484 Work Console control + approval gate (2026-07-19)

- ADR-0114 D4/D5에 따라 `work_control`·`work_auto_approve` FORCE RLS 원장과 closed payload CHECK를 추가했다. agent bearer만 자기 active run에서 control을 요청할 수 있고, spawn은 owner의 tool whitelist hit 때만 즉시 dispatch되며 miss는 기존 approval/card decision transaction을 재사용한다. input/kill은 같은 requester의 running session 계보, read는 같은 계보만 요구한다.
- `work.control.dispatched|acked`는 `message.seq`와 분리된 no-version·고유 idempotency-key outbox다. human host-owner ack가 성공한 spawn을 owner/channel/host가 일치하는 running `work_session` FK에 결속하며 pending/denied ack는 409로 닫힌다. Core는 두 kind를 `WorkControlDelta`로 왕복 디코드하고 replay cursor를 전진시키지 않는다.
- server 117 tests, Core 37 tests, iOS MomoiOSKit 27 tests, macOS 컴파일과 docs 정적 게이트 17개 항목, OpenAPI/YAML·work-control/OpenAPI verifier bash/ShellCheck 검증은 PASS했다. 격리 `verify_work_control.sh`와 전체 `runtime-db` Docker 실런은 오케스트레이터 담당이라 실행 전까지 `runtime-unverified`다.

## MOMO-483 Interactive Work Console session ledger (2026-07-19)

- ADR-0114의 host-owned 경계를 따라 `work_session` FORCE RLS 원장과 create/active-list/owner-end REST를 추가했다. create는 system card·session·`message.new`·`work.session.started`를 한 tenant transaction에 기록하고, end는 기존 card의 props와 `work.session.ended`만 갱신해 `message.seq`/`channel_seq`를 재발급하지 않는다. cwd/path/process/provider credential은 저장하지 않는다.
- lifecycle 두 이벤트는 card의 기존 seq를 재사용하되 Centrifugo publish `version` 없이 고유 idempotency key로 발행한다. Core는 두 kind를 `WorkSessionDelta`로 디코드해 replay cursor를 전진시키지 않고 전달하며, 기존 card thread는 일반 답글 API를 그대로 사용한다.
- server 115 tests, Core 35 tests, iOS MomoiOSKit 27 tests와 macOS 컴파일, OpenAPI/YAML·verifier bash/ShellCheck 정적 검증은 PASS했다. 격리 `verify_work_session.sh`와 전체 `runtime-db` Docker 실런은 오케스트레이터 담당이라 실행 전까지 `runtime-unverified`다.

## UXUI A-6 첨부 실업로드·수신·다운로드 완성 (2026-07-19)

- macOS 컴포저는 파일당 100MB·메시지당 20개 경계에서 업로드 세션 발급→capability URL 직송 PUT→complete→`attachmentIds` 메시지 전송을 수행한다. capability URL은 전용 ephemeral 세션 내부에서만 소비하고 인증 헤더·로그·UI·영속 상태에 남기지 않는다.
- 수신 메시지와 스레드는 서버 `Message.attachments`를 파일 카드로 표시하고 기존 content proxy를 통해 선택한 다운로드 폴더에 저장한다. 진행·실패·재시도·열기 상태, 안전한 파일명/중복 이름, 실제 첨부 이름 검색을 함께 연결했다.
- macOS 416 tests와 디자인 pre-flight에서 REST 전 계약·capability URL 비노출·라이트/다크/고대비 큰 글자 스냅샷을 검증했다. 실 Google Drive archive를 사용한 서버 왕복은 성재 환경 수동 검수 전까지 `runtime-unverified`다.

## MOMO-482 첨부 메타데이터 수신 투영 (2026-07-19)

- complete 상태로 메시지에 바인딩된 첨부만 생성순 `{id,name,mime,sizeBytes}`로 send/history 3변형/replies와 같은 트랜잭션의 `message.new`에 가산했다. 0건은 생략하고 모든 목록 경로는 lateral `jsonb_agg` 단일 쿼리를 사용하며 업로드 capability URL과 Drive 식별자는 투영하지 않는다.
- Core `Message.attachments`와 `DraftMessage.attachmentIds`는 하위호환 optional 계약으로 추가했다. verifier는 send·history 3변형·Centrifugo history의 동일 배열, 강제 바인딩 pending/failed 미노출, 기존 content proxy·RLS를 검사하며 격리 Docker `runtime-db` 실행은 오케스트레이터 담당이라 그 실행 전까지 `runtime-unverified`다.
- 전체 Swift 패키지 build, Core 33 tests, server 113 tests 및 나머지 relay·worker·LinkShort tests와 docs/OpenAPI/verifier 정적 검증이 PASS했다. macOS test runner는 선재 AppKit snapshot의 `NSImage` nil 강제 언랩(signal 5)으로 종료했다.

## MOMO-481 상호작용 Core replay + history 재시작 수렴 (2026-07-19)

- Core replay는 `message.edited`/`message.deleted`/`reaction.added`/`reaction.removed`를 `thread.updated`와 같은 비순번 projection으로 커서 대조 전에 전달한다. 동일 seq `message.new` 순번·중복 방어와 replay 커서는 그대로이며, Core 테스트가 구 seq 4종 전달·커서 불변과 edit 치환/delete tombstone/reaction 집합 중복 적용 멱등을 단정한다.
- 서버 history의 after/before/기본 세 변형은 삭제 행을 tombstone으로 유지하고 저장된 `state`/`editedAtMs`/`deletedAtMs`를 투영한다. OpenAPI와 `verify_message_interaction.sh`도 수정 cold-load 및 세 cursor 모드의 삭제 cold-load 수렴을 확인하도록 정렬했다.
- Core 32 tests와 server 112 tests PASS. verifier bash 정적 검증은 이 goal에서 수행하며 격리 Docker `runtime-db` 실행은 오케스트레이터 담당이라 그 실행 전까지 `runtime-unverified`다. 실 2-client WebSocket E2E는 수용기준대로 C-4 후속 범위다.

## MOMO-480 상호작용 realtime Centrifugo version 드랍 수정 (2026-07-19)

- 기존 메시지 `seq`를 재사용하는 `message.edited`/`message.deleted`/`reaction.added`/`reaction.removed` outbox envelope에서 Centrifugo `version`을 제거했다. 이벤트의 `data.seq`와 고유 `idempotency_key`는 유지하며, `message.new`가 이미 같은 version을 등록한 뒤 projection이 무언 드랍되던 경로만 닫았다.
- `verify_message_interaction.sh`는 relay를 함께 기동하고 첫 `message.new`가 history에 나타나 채널 version이 상승한 뒤, 동일 메시지의 상호작용 4종이 실제 Centrifugo history에 모두 전달됐는지 폴링한다. server build와 112 tests, bash/ShellCheck 정적 검증은 PASS; 격리 Docker 실런은 오케스트레이터 담당이라 `runtime-unverified`다.

## MOMO-479 스레드 투영 + 답글 조회 + AgentWorker root 보존 (2026-07-19)

- 톱레벨 메시지 history/멱등 send 응답에 옵셔널 `thread` 롤업을 가산하고, 오래된 답글을 `seq ASC` cursor로 복원하는 멤버십 강제 REST와 `thread.updated` transactional outbox/Core 이벤트를 추가했다. 답글 0건은 필드를 생략하며 교차채널 root는 404, reply-as-root는 400, tombstone은 답글 페이지에 남는다.
- AgentWorker의 durable message INSERT 4곳은 트리거가 답글일 때 같은 `root_id`를 보존하고, 같은 트랜잭션에서 MessageRoutes와 동일한 participant 포함 롤업 upsert 및 `thread.updated`를 기록한다. 톱레벨 트리거는 계속 NULL이며 `message.seq` 추가 발급은 없다.
- server 111 tests, Core 30 tests, AgentWorker 31 tests, iOS 27 tests와 macOS 전체 컴파일이 PASS했다. macOS test runner는 선재 AppKit snapshot의 `NSImage` nil 강제 언랩(signal 5)으로 종료했다. `verify_thread_projection.sh`의 bash/ShellCheck 및 runtime-db 편입은 검증했으며, 격리 Docker 실런은 오케스트레이터 담당이라 `runtime-unverified`다. (후속: 오케스트레이터 실런 verify_thread_projection 전 항목 PASS — BUILD_TICKETS MOMO-479 랜딩 노트)

## UXUI A-4 스레드 롤업·과거 답글 실연동 (2026-07-19)

- macOS는 답글 배지를 서버 `Message.thread.replyCount`로만 표시하고, replies REST의 배타적 seq cursor를 통해 과거 답글을 오름차순 페이지 로드한다. 열린 패널은 `thread.updated`와 실시간 새 답글을 즉시 반영하며 로딩·오류·재시도·추가 로드 상태를 제공한다.
- tombstone 포함 REST 계약, 롤업과 로드 범위 분리, cursor 페이지, 실패 후 재시도, 실시간 3번째 답글을 집중 검증했다. 전체 macOS 411 tests, 디자인 pre-flight, 스레드 패널 라이트·다크 snapshot이 PASS했다. 실서버 세션의 수동 왕복은 `runtime-unverified`다.

## UXUI A-8 채널 음소거 + A-9 메시지 상호작용 실연동 (2026-07-19)

- A-8은 채널/DM `muted` 응답을 목록 아이콘·컨텍스트 메뉴·채널 설정 토글에 연결하고, 낙관 갱신 실패/취소 롤백과 세션 전환 격리, unread 불변식을 적용했다. A-9는 macOS REST backend의 수정·삭제·반응 추가/제거·스냅샷 501을 실제 서버 계약으로 교체해 기존 capability-gated UI를 개방했다.
- 같은 클라이언트의 REST/local UI는 검증 대상이다. 타 클라이언트 realtime은 원본 message seq/version 재사용으로 drop될 수 있고 history가 수정 상태·삭제 tombstone을 복원하지 못하므로 X-5 `needs-engine-contract`로 남겼다. 이 범위는 runtime-unverified이며 완료로 주장하지 않는다.

## 엔진 준비 UXUI 큐 A-1~A-7 소비 (2026-07-18)

- A-1 마켓플레이스, A-2 채널 웹훅, A-3 초대 단축 링크, A-5 허들 폴리시, A-7 워크스페이스 서버 검색을 실제 엔진 REST 계약에 연결했다. one-time credential은 확인 전 이탈을 잠그고 확인 즉시 메모리에서 폐기하며, 세션·workspace 변경 시 비영속 상태를 전부 무효화한다.
- A-4는 `rootId`를 포함한 1단계 답글 실전송까지 완료했다. 정확한 thread 롤업/오래된 답글 조회(X-3)와 A-6 첨부 수신 투영(X-4)은 엔진 계약 대기로 역핸드오프했으며, durable 동작처럼 보이는 로컬 위장은 추가하지 않았다.
- macOS 전체 388 tests와 독립 계약 리뷰(Blocker/High/Medium 0), 플러그인 real-window artifact 검증이 PASS했다. 실서버 세션 왕복과 허들 2-클라이언트 실오디오는 별도 runtime/manual 검증으로 남는다.

## MOMO-478 메시지 상호작용 REST + realtime (2026-07-18)

- 작성자 전용 메시지 수정·body NULL soft-delete, 채널 멤버 반응 추가/제거와 직접 집계 스냅샷을 기존 tenant transaction + outbox + audit 경계에 추가했다. 수정·삭제는 기존 `message.seq`를 유지하고, 반응 멱등 재시도는 중복 outbox를 만들지 않으며 삭제 audit에는 원문을 남기지 않는다.
- 서버 109 tests, Core 27 tests(4종 서버 envelope 디코드), 격리 `verify_message_interaction.sh`, OpenAPI live drift 55/55 samples·44 operations가 PASS했다. 신규 migration은 필요하지 않았다(`001_init.sql`의 reaction UNIQUE·edited_at/deleted_at·FORCE RLS 재사용).

## iOS v0 실기기 푸시 E2E PASS (2026-07-18)

- 실기기(iPhone, Debug 케이블 빌드)에서 전 체인 실증: 디바이스 등록(env 자동판별 sandbox, MOMO-467) → PushRelay(Ed25519 서명 dispatch) → 실 APNs(.p8, apns_id 발급 200) → 실기기 알림 표시 → **NSE가 REST로 실제 메시지 본문 fetch·교체 성공**. ADR-0120 P-1~P-4 + ADR-0123 IOS-1~5의 최종 evidence.
- 발견 1건: 알림 탭 deep link가 채널 목록에서 멈춤 → MOMO-469(`#487`) 발급.

# momo — Phase 0 빌드 STATUS

> 생성: 2026-06-24 · 빌드 워크플로우 `momo-phase0-build`(T01~T10) + 로컬 `swift build` 재검증
> 검증 환경: Swift 6.2.3 (arm64-apple-macosx), Docker Desktop 29.4.3, PostgreSQL client 18.4(`/opt/homebrew/opt/libpq/bin/psql`). 실제 hermes는 없지만 MOMO-004에서 OpenAI-compatible SSE mock으로 AgentWorker e2e를 검증함.

## MOMO-477 채널 알림 음소거 (2026-07-18)

- ADR-0124에 따라 `notification_pref` FORCE RLS 원장과 채널 멤버 전용 `PUT {muted}`(false=삭제), 채널/DM 응답의 `muted` projection을 추가했다. NotifierWorker는 매 판정 시 preference를 LEFT JOIN해 DM·멘션·승인요청을 모두 후보에서 제외하며 unread/read-state는 변경하지 않는다.
- server 109 tests, NotifierWorker 3 tests, OpenAPI live drift 50/50 samples·39 operations, 격리 compose `verify_notification_mute.sh`(음소거 전/후/해제·멘션·페어 격리·suppressed 로그 무기록·audit·RLS)가 PASS했다.

## MOMO-476 스레드 답글 전송 + thread 롤업 (2026-07-18)

- 기존 메시지 단일 쓰기 트랜잭션에 같은 채널의 미삭제 톱레벨 `rootId` 검증, `message.root_id`, 원자적 `thread.reply_count` 증가와 last-reply/participant 롤업을 추가했다. 교차채널 root는 404로 존재를 숨기고 삭제 root·대댓글은 400으로 거부하며, 응답/history/realtime payload가 root를 노출한다.
- server 107 tests, 격리 compose `verify_thread_reply.sh`(정상·멱등 outbox/롤업·동시 2답글·RLS), OpenAPI live drift 48/48 samples·37 operations가 PASS했다.

## MOMO-475 워크스페이스 메시지 검색 FTS v0 (2026-07-18)

- 활성 채널 멤버십으로 하드 필터된 `GET /v1/workspaces/:ws/search/messages`를 추가했다. 기존 partial GIN trigram 인덱스로 ILIKE 한영 혼합 검색을 수행하며, 최신순 keyset cursor·매치 주변 bounded snippet/offset·검색 전용 멤버 30/min 제한을 제공한다.
- 신규 migration/outbox/audit 없이 OpenAPI와 격리 `verify_workspace_search.sh`를 runtime-db에 편입했다. verifier는 비멤버/DM/삭제/커서 삽입 안정성/429/RLS와 EXPLAIN trigram index 사용을 검증한다.

## MOMO-474 첨부 업로드 v0 — Drive workspace archive (2026-07-18)

- migration 017의 attachment FORCE RLS lifecycle과 100 MB 상한, `DriveArchiveClient`(SA `drive.file` Google resumable + strict-env 거부 stub), 업로드 발급·metadata complete·권한 강제 content stream proxy를 추가했다. 메시지 `attachmentIds`는 최초 전송의 seq/message/outbox tenant transaction 안에서 complete·본인·같은 채널을 잠금 검증하고 연결/audit한다.
- stub verifier는 직접 PUT→complete→메시지 연결→content→비멤버 403→pending 방치/RLS를 검증하며 실 Google 왕복은 계약대로 오케스트레이터 전용이다.

## MOMO-464 macOS shell/detail polish (2026-07-18)

- 다운로드 화면을 앱 경계를 벗어날 수 있는 시스템 popover에서 가운데 pane 우측 상단의 bounded card panel로 변경했다. 일반 창과 전체화면에서 같은 앱 내부 위치를 유지하고, 표시·해제 animation은 비활성화했으며 닫기 버튼과 Escape 경로를 제공한다.
- 승인 inspector 헤더 여백을 확대하고 action strip을 `모두 승인`(0건 disabled) + `항상 승인` switch로 재구성했다. `항상 승인`은 이 Mac·현재 workspace에 저장되며 명시적으로 reversible인 요청만 자동 처리한다. irreversible/미분류 요청은 fail-closed하고 `모두 승인`에도 추가 확인을 요구한다.
- 최신 `/private/tmp/momo-464-three-zone` dev app 실창에서 일반 창·전체화면을 확인했고, focused macOS test와 design preflight가 PASS했다.
## MOMO-471 macOS 허들 UI + LiveKit audio (2026-07-18)

- 채널 헤더의 시작/참가/live 참가자 표시와 오디오 전용 미니패널(말하는 중, 음소거, 나가기), 503 미구성 상태, JWT 재발급 재연결, 창/로그아웃/채널 전환 leave+disconnect 수명주기를 추가했다. LiveKit Swift SDK 2.15.2를 exact pin했다.
- Core는 huddle 3종 실시간 이벤트를 강타입으로 전달하고 미지 envelope type을 디버그 로그 후 스킵해 스트림을 유지한다. Core/macOS focused tests와 light/dark/increased-contrast/large-type 렌더는 PASS; compose 2-client 실오디오 왕복은 오케스트레이터 검증 전까지 `runtime-unverified`다.

## MOMO-470 LiveKit compose + 실 JWT 수락 verifier (2026-07-18)

- 고정 버전 LiveKit을 기본 stack과 분리된 `huddle` compose profile로 추가하고 signaling/TCP RTC/제한 UDP range, env 기반 API key/secret, healthcheck와 TURN 후속 운영 계약을 문서화했다.
- `verify_huddle_livekit.sh`는 V-1 start/join JWT를 실제 LiveKit `/rtc/validate` 200과 무효 JWT 401/403으로 관통한다. worker는 Docker를 실행하지 않아 실기동은 `runtime-unverified`; bash/YAML/정적 계약만 검증한다.

## MOMO-468 huddle 수명주기 + LiveKit JWT (2026-07-18)

- migration 016에 채널당 단일 활성 huddle과 재입장 이력 participant를 추가하고 FORCE RLS를 적용했다. 시작/참가/퇴장/active REST는 tenant tx 안에서 lifecycle·audit·outbox를 함께 커밋하며 마지막 참가자 퇴장이 huddle을 종료한다.
- LiveKit HS256 video grant는 별도 API secret으로 10분만 발급하고 세 env가 완비되지 않으면 전 허들 API가 503 `허들 미구성`으로 fail-closed한다. 서버 build와 105 tests, shell/YAML 정적 검증은 PASS; Docker `verify_huddle_lifecycle.sh`는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-466 iOS TestFlight internal 배포 준비 (2026-07-17)

- Xcode 26 단일 1024px AppIcon을 생성하는 CoreGraphics 스크립트와 절제된 단색 `m` 모노그램 PNG를 추가하고, 앱 asset catalog·Team `YWQQFQM38J`·NSE bundle `app.momo.ios.NotificationService`·Debug/Release APNs 환경을 배포 계약에 맞췄다.
- `docs/IOS_TESTFLIGHT_RUNBOOK.md`에 App ID/App Group, 자동 서명, Organizer 업로드, internal tester, LAN/AWS 연결, 실기기 APNs/NSE/deep-link/device-row E2E를 `[manual]`로 정리했다. 실제 서명·archive·업로드·실기기 E2E는 성재 수행 전이며 manual-unverified다.
- `docs` local gate와 아이콘 1024x1024 RGB·alpha 없음·결정적 재생성 검사는 PASS했다. Release 시뮬레이터 sanity는 worker sandbox가 CoreSimulatorService와 `~/Library/Caches` 쓰기를 차단해 컴파일 진입 전 종료됐으므로 runtime-unverified이며, 런북 §4 명령을 sandbox 밖에서 재실행해야 한다.

## MOMO-457 hosted read-only Drive MCP (2026-07-17)

- `POST /v1/mcp/drive`에 agent bearer+위임 채널 binding, 매 호출 활성 `drive:read` grant 잠금 재검증, 결과 audit를 묶은 stateless MCP initialize/tools.list/tools.call과 공유 드라이브 read-only 3도구를 추가했다. Drive backend는 명시 local stub과 env 기반 Google SA 구현으로 분리되고 키 바이트는 DB·응답·audit·로그에 유입되지 않는다.
- hosted 상대 endpoint manifest/절대 descriptor, migration 015 seed, stub 격리 verifier를 추가했다. 오케스트레이터 실런(2026-07-17): `verify_drive_mcp.sh` PASS + registry 시드 5개 기대 갱신 후 `runtime-db` 게이트 PASS — runtime 검증 완료. **실 SA smoke도 완료(2026-07-17, 런북 §7.1)**: 실 공유 드라이브(`momo-dawn`)에 drives.get/files.list(2건)/changes.startPageToken 3종 200 — scope는 `drive.file` 403 실증 후 `drive.readonly` 확정(백엔드 기구현과 일치). Drive 경로 C 전 구간 실검증 종결.

## MOMO-456 macOS center-pane plugin marketplace UX (2026-07-17)

- 사이드바 `플러그인`, 워크스페이스 메뉴, composer `+ > 플러그인 둘러보기`가 모두 대화 영역을 대체하는 하나의 가운데 카탈로그로 연결된다. 검색, 워크스페이스/개인 범위, 분류, 설치됨 필터와 Drive/Calendar/Gmail/GitHub/Notion 후보를 제공한다.
- 설치/제거 선택은 서버 credential 없이 이 Mac에만 저장하는 UX shell이다. 실제 registry grant/OAuth 연결은 기존 엔진 계약을 그대로 이어받으며, Codex 화면의 브랜드 에셋을 복제하지 않고 공식 제공사 에셋을 받을 때까지 semantic SF Symbol을 사용한다.

## MOMO-449 GitHub grant → Context Packet tool policy (2026-07-17)

- Hermes adapter가 packet마다 agent job의 위임 사용자·채널을 이용해 plugin projection을 재조회하고, 유효 grant의 allowlisted MCP descriptor만 `context_packet_projection.tool_policy`에 포함한다. revoke는 다음 packet에 즉시 반영되고 조회/descriptor 오류는 플러그인 단위 또는 전체 기본 거부한다.
- 서버 plugin 목록은 agent bearer에 대해 같은 채널의 위임 사용자 binding을 검증한 뒤 credential-free tool policy를 추가 응답한다. mock REST Python 계약 테스트와 실서버 install→grant→조회→revoke verifier를 추가했다. 오케스트레이터 실런으로 grant 왕복 verifier·plugin registry 회귀·runtime-agent 게이트 모두 PASS(2026-07-17) — runtime 검증 완료.

## MOMO-455 macOS composer action icon optical alignment (2026-07-17)

- composer의 시작 작업·전송 SF Symbol에 1pt 상향 optical correction을 적용하되, 동일한 32pt 정사각 클릭 영역과 접근성 label, 기존 action을 유지했다. focused macOS tests가 PASS했고 server/schema/engine 변경은 없다.

## MOMO-451 macOS full-height window shell (2026-07-17)

- production `NSWindow`에 `fullSizeContentView`를 적용해 좌측·가운데·우측 shell이 별도 제목 표시줄 아래가 아니라 트래픽라이트 영역까지 이어지도록 했다. 시스템 창 제목과 native toolbar separator/baseline은 숨기되 AppKit이 트래픽라이트 상호작용을 계속 소유한다.
- 창 속성 적용은 layout 반복 호출에서 값이 달라질 때만 수행한다. composer의 시작 작업·전송 아이콘은 입력 surface 기준 수직 중앙으로 맞췄고, focused chrome tests 21/21 및 real-window snapshots 6/6가 PASS했다. server/schema/engine 변경은 없다.

## MOMO-411/412 게이트 리소스 가드 + signed webhook ingress (2026-07-17)

- **MOMO-411**(`710a069`): local_gate runtime-* 프로파일이 게이트 종료 시 자기 compose 스택을 down(성공/실패/HUP 모두), 시작 전 load>12 차단(§9), momo240 local-alpha는 PID-liveness 보호, pre-existing 스택(momo_main)은 무접촉. 2026-07-17 발열 사고(게이트 잔재 증식)의 구조적 봉합 — teardown 잔재 0 두 런 실증.
- **MOMO-412**(`5ff5161`, ADR-0115 SE-04B): signed webhook ingress — native HMAC-SHA256(signature base=version+method+endpoint+install+timestamp+delivery+bodyhash, constant-time, replay window, 키 회전 overlap, one-time secret custody) + **Slack-호환 모드**(URL-시크릿, MM 검증 부분집합 화이트리스트, 미지원 필드 무시로 Grafana/Alertmanager가 URL 교체만으로 동작 — 독립 리뷰 H1 반영, blocks만 400, username/icon 무시로 author 사칭 차단). 수신=한 tenant 트랜잭션(receipt+deterministic client_msg_id+seq+message+outbox). 리뷰가 암호학·secret custody·단일 쓰기 경로를 "흠 없음" 확정.
- 공통: 게이트의 macOS 스냅샷 FAIL은 UX 트랙 선재 결함(origin/main HEAD 격리 재현) — DEVIATION_LOG. M1/M2(per-install rate limit·WEBHOOK_MASTER_KEY 분리)는 pending.

## MOMO-447 macOS dogfood interaction shells completion (2026-07-17)

- `⌘F`/toolbar 검색을 채널·활성 멤버·현재 클라이언트에 로드된 메시지·명시적 첨부 메타데이터 이름을 찾는 로컬 검색 surface로 교체했다. 검색 결과는 채널 이동 또는 멤버 프로필로 연결되며, 서버 FTS가 준비되면 같은 destination 계약 뒤에서 교체한다.
- 다이렉트 메시지 `+`는 검색 가능한 사람/에이전트 선택 sheet로 연결하고 기존 실제 DM 생성 경로를 재사용한다. 프로필 surface는 demo/local 모드에서 로컬 초안 편집을 제공하고, real-server 모드에서는 서버 값의 read-only 표시로 fail-closed한다.
- 승인 inspector의 중복 헤더를 제거하고 요청 수·되돌릴 수 있는 요청 일괄 승인 action을 한 줄에 배치했다. 플러그인 카탈로그는 Drive·Calendar·Gmail·GitHub·Notion의 로컬 선택/해제 상태를 앱 재실행과 채널 이동 사이에 유지하며, 실제 registry/grant/OAuth 연결 전에는 미리보기임을 명시한다.
- 파일 선택·timeline DnD·첨부 chip은 MOMO-409의 local draft 경로를 유지한다. durable upload 성공은 주장하지 않으며 storage API 연결 경계는 `docs/planning/handoffs/2026-07-17-momo-447-dogfood-interaction-shells.md`에 기록했다.

## MOMO-445 macOS single-owner inspector boundary (2026-07-17)

- 가운데 타임라인과 붙어 있는 우측 승인·멤버 패널 사이의 이중 경계를 제거했다. 가운데 본문은 경계를 소유하지 않고, 레이아웃의 단일 `Divider`만 경계를 그리며 붙어 있는 패널은 semantic fill만 사용한다.
- 좁은 창에서 떠 있는 inspector는 기존 card outline과 shadow를 유지한다. focused `MomoChannelChromeTests` 20/20 PASS이며 server/schema/engine 변경은 없다.

## MOMO-414 macOS unified flat sidebar shell (2026-07-17)

- 좌측 패널의 내부 수평 구분선·수동 우측선과 네이티브 타이틀바 기준선 중첩을 제거했다. `NavigationSplitView`의 resize/collapse 동작은 유지하면서 sidebar와 unified titlebar를 하나의 평면으로 연결하고, 가운데 본문과는 네이티브 세로 경계 하나만 남긴다.
- AppKit 창 크롬 정책을 macOS 14 호스트에 좁게 적용하고 SwiftUI의 지연 toolbar 설치 뒤 한 번 재적용한다. focused `MomoChannelChromeTests` 19/19 PASS, design/correctness review Blocker 0이다.

## MOMO-410 plugin manifest registry + install/grant 런타임 (2026-07-17)

- ADR-0113 D2/D5/D6에 따라 migration 013의 catalog/install/grant 4-튜플/Capability projection, 화이트리스트 manifest validator, owner/admin install·본인 grant/revoke REST, GitHub/Notion/Linear 오피셜 시드와 custody-A 비밀정보 무저장 경계를 추가했다. 서버 Swift build와 91 tests, fixture JSON·verifier shell syntax는 worker 검증 완료; Docker `runtime-db`는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-409 macOS composer action launcher + local draft surfaces (2026-07-17)

- composer의 단일 목적 hammer 버튼을 가운데 정렬된 `+` action launcher로 바꾸고 파일 업로드·새 작업·스레드·투표·플러그인 5개 경로를 native anchored popover로 제공한다. 기존 Agent Work 실행 경로와 `⇧⌘W`는 유지한다.
- 파일 선택과 timeline file URL drag/drop은 전송 전 local attachment draft chip으로만 표시하며 중복 제거·개별 제거·전체 비우기를 지원한다. 서버 storage 계약 전에는 durable upload 성공을 주장하지 않는다.
- 스레드·투표·플러그인은 동작 가능한 local draft sheet로 제공한다. 플러그인 surface는 Drive·Calendar·Gmail·GitHub·Notion 후보를 미리 탐색·선택할 수 있고, 실제 install/grant는 엔진 계약 연결 전까지 명확히 `연결 준비`로 표시한다. focused tests와 전체 macOS suite 303 tests, design preflight, 실창 launcher/plugin preview를 검증했다. 최종 `macos-ui`와 fresh design-review evidence는 PR에 기록한다.

## MOMO-408 prod 시드 password fail-closed (2026-07-16)

- migration 012가 seed-none/prod의 시드 owner에 남은 결정론적 `dev-password` 해시만 NULL로 잠그고, 명시적 demo/e2e seed는 기존 로그인 fixture를 유지한다. production/e2e 격리 DB HTTP verifier를 `runtime-db`에 연결했다. Swift 6개 패키지 build와 Core/server/relay/worker/notifier test, macOS non-snapshot 224 test, shell syntax·정적 seed 계약은 worker 검증 완료; Docker `runtime-db`는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-396 macOS Composer + Mention Overlay Polish (2026-07-16)

- composer를 최소 56pt의 단일 native surface로 정리하고 내부 `TextField`의 중첩 rounded-border ring과 별도 outer focus ring을 제거한다. 삽입 caret, keyboard navigation, VoiceOver 상태는 유지하고 시작 작업과 전송 action은 같은 surface 안에 두며 한국어/영어 전송 label을 제공한다.
- 현재 채널에 실제로 초대된 사람/에이전트만 `@` 후보로 표시한다. 후보 목록은 timeline을 밀지 않는 composer 위 overlay이며 최대 6행, 콘텐츠 실측 기반 8pt 간격, keyboard-selected/hover highlight와 VoiceOver 선택 위치를 제공한다. 위/아래 순환, Tab/Return 선택, Escape 닫기와 mouse 선택을 지원한다.
- focused mention selection test와 전체 macOS suite를 자동 회귀로 사용하고, Light/Dark 실제 macOS window artifact를 별도 디자인 리뷰 증거로 기록한다. 파일 DnD/첨부 기록은 storage·credential 계약이 선행되어야 하는 MOMO-394 범위이며 이번 UI가 가짜 첨부 성공을 만들지 않는다.

## MOMO-407 초대 보안 계약 (2026-07-16)
- regenerate 의미론(review #428 M1 명문화): regenerate는 **신규 코드 발급**이므로 만료를 구 invite의 잔여 TTL이 아니라 **기본 7일로 재설정**한다. 잔여 TTL 보존이 필요해지면 후속 티켓으로 분리한다.

- 초대 미지정 만료를 DB transaction 기준 7일로 고정하고 owner role을 fail-closed로 유지했다. 원자 regenerate 경로는 기존 코드를 즉시 revoke한 뒤 role/maxUses/metadata를 바인딩한 새 코드를 발급하며 create/revoke/regenerate audit를 같은 tenant transaction에 기록한다. 기존 스키마가 계약을 수용하므로 migration과 OpenAPI 응답 shape는 변경하지 않았다.
- `verify_join.sh`에 기본 만료·owner 거부·admin 생성 role 바인딩·regenerate 구 코드 무효화/audit 왕복을 추가했다. Swift build/test와 verifier `bash -n`은 worker 검증 완료; Docker `runtime-db`는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-405 Signal Architecture 반응형 온보딩 (2026-07-16)

- 첫 화면을 초대 참여·기존 로그인·로컬 체험·설치된 self-hosted 서버 연결의 실제 제품 경로로 재구성하고, 자격정보 입력은 선택 이후에만 노출한다. 680pt compact부터 1600pt bounded split까지 같은 SwiftUI `Canvas` 신호 배경과 native list/form을 사용하며 한국어/영어, 키보드 포커스, Light/Dark를 지원한다.
- 실패 후에도 선택 경로가 보존되고, Return 제출은 유효한 자격정보에서만 동작하며 성공 전에는 Keychain/UserDefaults를 갱신하지 않는다. 실패한 수동·환경 자동접속 ViewModel은 실시간 구독과 세션 민감 상태를 정리한다. 일반 모드에서는 `local alpha` 구현 표식을 숨기고, self-host 경로가 서버를 새로 프로비저닝하는 것처럼 말하지 않는다.
- compact/default/large Light/Dark 정본 스냅샷 6종을 현재 중립 signal rail로 기록했다. focused onboarding 19/19, 전체 macOS 301/301, `macos-ui` local gate가 PASS했고, fresh design-review는 Blocker/Major 0, correctness review는 Blocker/High/Medium 0으로 승인됐다. 최종 clean evidence는 issue #423의 PR에 기록한다.

## MOMO-402 macOS Top Chrome / Roster / Dock / Downloads Polish (2026-07-16)

- `NavigationSplitView`가 이미 unified toolbar 아래에서 시작하는데 AppKit content inset을 다시 더하던 이중 보정과 pane별 border/rounding/shadow를 제거했다. 좌측 workspace row, 가운데 channel header, 우측 member inspector가 각각 독립된 한 줄 header로 정렬되고 경계에는 separator 하나만 남는다. profile menu는 이동 animation 없이 즉시 열리며 footer button 위 약 16pt 간격을 유지한다.
- 우측 roster는 전체/사람/에이전트 탭 대신 관리자·에이전트·온라인·자리 비움·오프라인으로 그룹화하고 search/profile/DM 경로를 보존했다. 채널 unread 합계를 Dock badge에 `1...99+`로 표시하고 0 또는 logout에서 지운다.
- Downloads는 채널 선택과 무관한 앱 상단 우측 icon popover로 이동했다. security-scoped bookmark를 사용하는 폴더 열기·변경, 최대 50건의 영속 이력, 항목별 열기·Finder 보기·삭제를 제공하고 Updates는 profile menu에 유지한다. MOMO-394가 실제 채팅 첨부파일 전송 기록을 공급하기 전에는 가짜 이력을 만들지 않는다.
- macOS build와 전체 296 tests가 0 failure로 PASS했다. 표준·좁은·light/dark real-window artifact에서 flat sidebar, pane header 정렬, grouped roster와 영문 inspector header를 재검증했고 실행 앱에서 downloads popover와 animation 없는 profile menu 동작을 확인했다. 다운로드 이력은 실제 폴더 경계와 symlink를 해석해 폴더 밖 파일을 거부하며, 삭제 성공 후에만 이력을 제거한다. 최종 clean `macos-ui`와 fresh design-review evidence는 PR에 기록한다.

## MOMO-392 Channel Chrome + Contextual Navigation Polish (2026-07-15)

- 채널 헤더를 48pt 한 줄 이름 중심으로 압축하고 주제는 tooltip/VoiceOver 보조 설명으로 내렸다. 창은 `unifiedCompact` 단일 타이틀바와 `NSWindow.contentLayoutRect` 기반 inset을 유지하며, 좁은 창의 member inspector도 측정된 채널 헤더 아래에서만 시작한다. 표준 1180x760, 좁은 980x620, wide 1800x900 실창 캡처에서 traffic light/sidebar/header/inspector 겹침이 없음을 확인했다.
- 헤더 우측 Downloads는 기존 로컬 앱 업데이트/다운로드 폴더 surface를 열며, 채팅 첨부파일 다운로드가 아님을 한국어/영어 화면과 VoiceOver hint에 명시했다. MOMO-386 server search가 아직 없으므로 toolbar/`⌘F` 검색은 가짜 결과 대신 localized unavailable popover와 현재 채널/멤버만 찾는 `⌘K` 대안을 제공한다.
- 헤더의 상시 channel gear는 제거했다. sidebar channel 행은 선택/hover 때 invite/settings를 노출하고 context menu·VoiceOver·`⇧⌘I`/`⇧⌘,` 동등 경로, notification planned disabled state, copy ID를 제공한다. 기존 생성 sheet/unread/DM/right roster는 보존했다. focused tests와 real-window artifacts는 PASS했으며 최종 `swift`/`macos-ui`/design-review evidence는 PR handoff에 기록한다.

## MOMO-391 clients/web 스캐폴드 + 로그인/타임라인 v0 (2026-07-15)

- ADR-0119 W-2: `clients/web` 신설(Vite+React+TS+centrifuge-js, 전 의존성 permissive — 전이 포함 인벤토리는 게이트가 생성). 로그인(email/password/workspace 옵션 — 미지정 시 서버 demo 폴백) → 채널 목록 → 타임라인 읽기(seq desc head + `before` 페이지네이션 + `?after=` ASC backfill) → centrifuge-js websocket-only 실시간 구독(recovered:false 및 seq 갭에서 REST `?after=` 폴백). websocket 주소는 login 응답 `realtimeWebSocketUrl`만 사용(ADR-0110), 연결 토큰은 `POST /v1/auth/realtime-token`, 구독 인가는 subscribe proxy 서버 재검증. 토큰 정책 D3-A(access 메모리/refresh localStorage 회전/로그아웃 revoke) + 공개 배포 전 httpOnly 승격 게이트를 `clients/web/README.md`에 명문화.
- REST 타입은 `docs/api/openapi.yaml`에서 openapi-typescript로 생성·커밋하고, `web` 게이트가 재생성 diff로 스펙 동기화를 강제한다. 구독 채널명은 relay publish와 동일한 대문자 `ch:ws<WS>.<CH>` 정규화, UUID 비교는 case-insensitive.
- `web` 게이트 프로파일 신설(`scripts/local_gate.sh --profile web`): npm ci → eslint → tsc → 생성 타입 동기화 → vite build → permissive-only 라이선스 게이트 → `web_serving_smoke.sh`(APP_DOMAIN sentinel fail-closed 회귀) → `verify_web_login_smoke.sh`(격리 e2e compose `momo391web` + 실제 prod Caddyfile 엄격 CSP 뒤 Chromium 로그인→타임라인→실시간 수신 스모크) → `verify_openapi_contract.sh` runtime drift 게이트. `clients/macOS`·`server` 소스 무변경.
- runtime-unverified: 공개 호스트 DNS/ACME/TLS 뒤 실서빙, Safari/Firefox(스모크는 Chromium), 멀티 탭 refresh 회전 경쟁(README 한계 명시). 작성/read-state/승인 카드(W-4), 초대 웹 합류(W-5)는 후속.

## MOMO-410 plugin registry — 플러그인 플랫폼 물리 기반 (2026-07-17)

- ADR-0113 SE-04A 랜딩(PR #435, `1809551`) — migration 013(registry/install/**grant 4-튜플**(self-grant DB CHECK)/capability projection, RLS FORCE), manifest validator(전면 화이트리스트 fail-closed — unknown 키 자체 거부·GPL/AGPL 배제·digest·risk↔tier 매트릭스), PluginRoutes(카탈로그/install/grant/revoke — serverPolicy 게이트), **오피셜 시드 3종**(GitHub `api.githubcopilot.com/mcp/`·Notion `mcp.notion.com/mcp`·Linear `mcp.linear.app/mcp` — 16-03 실검증 그대로, egressDomains 실도메인).
- 커스터디 A 실증: raw credential이 테이블·응답·audit detail 어디에도 없음을 verifier가 마커 3면 단정. 리뷰 H1(read-path 403/404/409→500)을 트랜잭션 언랩으로 수정 — MOMO-403과 같은 패턴 2회째(3회 시 공용 헬퍼 티켓).
- 게이트: plugin verifier 전체 PASS(RLS 단정은 라이브 projection 보장 후 — M2 강화) + runtime-db PASS. 크로스트랙 사고 수습 기록: 통합자 add -A 오커밋이 main macOS 빌드를 깨뜨림 → MessageListView revert(e1a9b78)로 복구, UX 작업분 working tree 보존.

## MOMO-408 prod 시드 fail-closed (2026-07-16)

- migration 012(PR #431, `8193734`): seed-none(prod) 경로에서 dev-password 백필을 차단하고 **기존 백필 행을 전 human 범위로 소급 잠금**(H1 — 리뷰가 pre-MOMO-217 join 행·문서 안내 잔존 노출을 발견). 오잠금 벡터 없음: bcrypt verify 술어가 운영자 변경 비밀번호를 통과시키지 않음(리뷰 확정 + 매트릭스 verifier 단정). 모드 판별은 002/006 동일 컨벤션, 미설정 기본값=잠금(fail-closed).
- 로컬 도그푸드 무회귀(H2): local_alpha_runner가 migrate 직후 **명시적** owner 부트스트랩(MOMO_LOGIN_PASSWORD, 기본 dev-password) — 암묵 백필 금지·명시 provisioning이라는 티켓 철학 그대로. prod(install.sh)는 부트스트랩 없음 → DEPLOY.md 인수 절차 전 로그인 401.
- evidence: seed verifier 4/4 PASS(prod 401/인수 200/확장 잠금 매트릭스/e2e 무회귀), 수정 전 runtime-db 전체 PASS + 델타 등가 논증(PR #431 코멘트). 후속: INTERNAL_ALPHA/RUN dev-password 안내 정비 티켓 후보.

## MOMO-406/407 셀프호스팅 배치 1 — install/upgrade + 초대 보안 (2026-07-16)

- ADR-0121 S-1/S-2가 랜딩(PR #429 `bb3efc6` / #428 `4a8b288`) — **codex-fleet 복귀 1호 배치**(worker=gpt-5.6-sol medium 병렬 2기, 오케스트레이터=Fable 리뷰·게이트·머지).
- S-1: `infra/prod/install.sh`/`upgrade.sh`(pinned digest 강제·preflight 재사용·app-only 롤백+forward-only migration 비대칭 명시) + DEPLOY.md "5분 설치"(단일노드 상한 500 계획값). 리뷰 H1로 **시드 owner의 공개 dev-password 창**을 경고+필수 인수 스텝으로 승격 — prod fail-closed 시드는 후속 서버 티켓 후보. 정적 verifier+shellcheck+staging-smoke PASS.
- S-2: 초대 기본 만료 7일(명시 경로 무회귀)·owner 초대 3중 fail-closed·regenerate 원자 CTE(revoke+재발급+audit 한 문장 — 구 코드 유효 창 없음). openapi/schema 무변경. runtime-db 게이트 PASS(1차 FAIL=verifier UUID 대소문자 strict 비교 → case-insensitive 수정).
- 잔여 후속 후보: prod 시드 fail-closed(신규 서버 티켓), install 실경로 fake-docker trace, regenerate 404/409 분기, 초대 부정 경로 verifier 2콜.

## MOMO-461 PushRelay v0 (2026-07-17)

- ADR-0120 P-3 PushRelay를 repo 내 Swift 패키지로 추가했다. env 공개키 등록제, raw-body Ed25519 검증, 서버별 60/min sliding-window, 닫힌 `momo.push.dispatch.v1` 필드 집합과 id-only APNs payload, APNSSender Stub/실 ES256 provider JWT+AsyncHTTPClient 경계를 구현했다. Notifier 서명은 개인키 env 설정 때만 첨부해 기존 mock 호환을 유지한다.
- `verify_push_relay.sh`는 실 키/APNs/Docker 없이 정상 200+Stub capture, bad signature/미등록 403, 429, content 비유입을 검증한다. 실 `.p8` sandbox `400 BadDeviceToken` passthrough smoke와 Dawn 배포는 오케스트레이터 작업으로 남는다(`runtime-unverified: real APNs relay smoke`).

## MOMO-404 NotifierWorker — ADR-0120 서버측 절반 완성 (2026-07-16)

- P-2 랜딩(PR #424, `a8a1089`) — migration 011의 message AFTER INSERT 트리거가 같은 트랜잭션에서 outbox `push_candidate`를 기록(생산자 트리거는 이 1건이 유일 — overview.md 정본화), NotifierWorker(momo_notifier BYPASSRLS)가 SKIP LOCKED 소비, 판정 v0(DM 전건/멘션 projection 재사용/승인→active human)을 한 곳에 고정, id-only 페이로드로 mock relay dispatch + push_dispatch_log.
- 독립 리뷰: 트리거 = 불변식 정합(같은 트랜잭션 — 일회용 PG18에서 RLS 경유 발화 독립 재현), 3-소비자 kind 상호 배제·dispatch 멱등(exactly-once log/at-least-once relay+collapse_id) 확인. High(overview 동PR 갱신)·Medium(relay 실패를 실 HTTP status+relay_http: reason으로 settle — P-3 오무효화 차단) 반영 후 verifier 재PASS.
- **ADR-0120 서버측 절반(P-1 등록 REST + P-2 notifier) 완성.** 잔여: P-3 PushRelay 실발송(Dawn 운영 결정 — Apple Developer 계정/relay 배포), P-4 iOS Notification Extension(M5). 후속 기록: push_candidate pending prune 티켓 후보(L3), relay 장기 다운 시 failed 종결(L4 — P-3 재검토), D2 문언-필드 목록 정합(L2 — ADR-0120 반영).

## MOMO-403 device/push_token 등록·해지 REST (2026-07-16)

- ADR-0120 P-1 랜딩(PR #422, `36c0d70`) — DeviceRoutes(등록 멱등 upsert+토큰 회전, device+env당 단일 ACTIVE 토큰은 migration 010 partial unique로 DB 강제, 해지=invalidated_at 행 보존, suffix-only receipt). App.swift 배선 1줄.
- 독립 리뷰 Medium(등록 upsert TOCTOU — 혼합 소유 row 가능성)을 RETURNING member_id 원자 재검증으로 봉합하고, 동시 등록 23505→409, list active 멤버 요구, revoke 응답 raw 토큰 단정까지 반영. 반영본으로 verifier 전체 재실행 PASS(등록/회전/타인 403/cross-tenant/revoke 수명주기/reclaim rebind/audit/RLS).
- runtime-db 프로파일에 push registration verifier 편입. 다음: MOMO-404 NotifierWorker(판정 v0 + id-only mock relay).

## MOMO-401 초대 링크 웹 합류 — 웹 v0 완주 (2026-07-16)

- `/join/<code>`가 랜딩(PR #419, `9616c67`)하며 **ADR-0119 웹 v0 스코프("초대받은 사람이 브라우저로 합류해 대화한다") 7티켓 완주**: 389 계약 정본 → 390 서빙 → 391 읽기 → 398 prod realtime 개통 → 399 게이트 복구 → 400 대화 왕복 → 401 초대 합류.
- join은 스펙 정본(JoinResponse required accessToken/refreshToken)대로 가입 즉시 세션 진입 — 독립 리뷰가 스펙·서버(JoinRoutes) 양쪽 대조로 판정 확인. 초대 코드는 모듈 로드 시 즉시 history.replace로 비잔류, 만료/소진/무효 구분 카피는 서버 안정 문자열 대조 완료. 미인식 409는 결합 폴백(리뷰 M1 반영).
- 스모크 32 PASS(코드 비유출·가입→재로그인 왕복·오류 3케이스 포함), 격리 게이트 잔여물 0. 게이트 경화 부산물: api/relay staggered boot(공용 스크립트 — Docker VM 메모리 압박 대응).

## MOMO-400 웹 작성·read-state·승인 카드 + realtime 왕복 (2026-07-16)

- ADR-0119 W-4가 랜딩(PR #414, `4a06ec5`) — composer(clientMsgId 멱등, 실패 후 편집 시 새 키), read-state 단조 파이프라인(max-merge 후퇴 불가 논증을 리뷰가 검증, 서버 공식과 동일식), 승인 카드 receipt 상태 전이(409 settled=조용한 전이, idempotency_conflict만 오류 — 서버 시맨틱 1:1), DM 목록/열기. `user:read-state#<ID>` 대문자 채널명은 서버 4개 지점 코드 대조로 확정.
- 리뷰 Medium 반영: 스모크 픽스처를 실제 gateway 형태(arguments/tool_grant/estimated_micro_usd+고유 마커)로 강화하고 무누출 단정을 타임라인+패널 양 표면에 적용. stall된 음성 대조 패스가 남긴 의도적 누출을 강화 단정이 DOM 레벨에서 실검출 — 단정 실효성의 경험적 증명. 최종 스모크 25 PASS/0 FAIL, eslint/tsc/build PASS.
- 유령 게이트 스택 5벌 정리(janitor+수동)로 콜드 컴파일 OOM 재발 조건 제거. 웹 v0 잔여는 MOMO-401(초대 웹 합류)뿐.

## MOMO-398 prod Centrifugo allowed_origins — 웹 realtime 개통 (2026-07-15)

- prod compose가 `CENTRIFUGO_CLIENT_ALLOWED_ORIGINS=${APP_DOMAIN:+https://${APP_DOMAIN}}`를 파생 주입(PR #413) — operator knob 없이 단일 오리진 계약, unset/빈값은 기존 fail-closed 완전 무변화(Centrifugo v6 "빈 env=unset" 문서+실이미지 실증). 네이티브 클라(Origin 미전송)는 양 모드 무영향. preflight strict가 파생 모순 2종을 fail-fast. 웹 W-4/W-5의 prod 개통 선행 조건 충족.

## MOMO-399 staging/internal smoke namespace drift 수정 (2026-07-15)

- main 기저에서 FAIL하던 `verify_staging_smoke.sh`/`verify_internal_hosting_smoke.sh`를 수정(PR #412, `5e034fa`). 하드코딩 namespace 목록을 dev config 파싱 대조로 전환(추가형 drift 자동 검출 + core 5종 보호), MOMO-390의 APP_DOMAIN site 추가로 생긴 Caddyfile 403 false-PASS 가능성도 개수 대조로 봉합. merge 후 main `staging-smoke` 프로파일 PASS — DEVIATION_LOG 2026-07-15 항목 종결.

## MOMO-391 clients/web v0 — 웹 첫 배치 종결 (2026-07-15)

- ADR-0119 W-2가 랜딩하며 웹 첫 배치(389→390→391)가 종결됐다. PR #407(+리뷰 반영 `b499d32`) merge `63e7d51`. 독립 리뷰 Blocker 0/High 0/Medium 1 — Medium(만료 access 로그아웃 시 서버 revoke 무산)은 회전 1회 재시도로 수정하고, 스모크가 "401→회전 1회→재시도 revoke, 회전 전·후 refresh 모두 서버측 사망"을 실증했다.
- `clients/web`(Vite+React+TS+centrifuge-js, 전이 포함 permissive-only 라이선스 게이트), `web` 게이트 프로파일(npm ci→lint→tsc→타입 동기화→build→라이선스→web_serving_smoke→실 Chromium 로그인/타임라인/실시간/`?after=` catch-up/CSP 0→drift 게이트)이 신설됐고, merge 후 main에서 `--profile web` 전체 PASS.
- 리뷰어가 relay 채널명(`MessageRoutes.swift:153` uuidString 대문자) ↔ 웹 구독 채널명 일치를 서버 코드 대조로 실증했다. DM도 서버가 `ch:`로 publish함을 확인.
- 계획 이탈: prod Centrifugo `allowed_origins` 공백 시 브라우저 wss 403(현재 fail-closed라 무해) → MOMO-398로 발급. dev/e2e allowed_origins만 이번에 수정.

## MOMO-389/390 웹 트랙 첫 배치 — OpenAPI 계약 정본 + APP_DOMAIN 서빙 (2026-07-15)

- ADR-0119(웹 클라이언트 트랙) 첫 배치를 Fable 구현·독립 리뷰·순차 머지로 랜딩했다(엔진/인프라 트랙 Fable momo-main 겸임 — 성재 승인). MOMO-389=PR #404(`6fe746f`), MOMO-390=PR #403(`5ecd645`), 두 PR 모두 독립 리뷰 Blocker 0/High 0.
- MOMO-389: `docs/api/openapi.yaml` 17개 오퍼레이션이 클라이언트 계약의 스펙 정본이 됐다. drift 게이트(`verify_openapi_contract.sh`+`openapi_shape_check.py`)는 격리 e2e compose를 자체 기동해 20/20 표본 shape 일치 PASS, 리뷰어가 합성 drift 5종 검출과 잔여물 0을 독립 재현했다. 스펙을 서버에 맞춘 판정 5건은 PR #404 이탈 섹션이 정본.
- MOMO-390: `{$APP_DOMAIN}` site(SPA file_server+`/v1` proxy 같은 오리진+SPA CSP)가 랜딩했다. 미설정 하위호환은 sentinel `momo-app-domain-unset.localhost` fail-closed(전 경로 404, ACME 무발생 — 리뷰어 adapt/런타임 실측)로 보장하고, 기본 e2e 렌더는 byte-identical. `web_serving_smoke.sh` 전 항목 PASS.
- 머지 후 리뷰 후속 반영: MOMO-391 수용기준에 `web_serving_smoke.sh` 게이트 포함(fail-closed 회귀 방어), drift 게이트 픽스처 비밀번호 랜덤화, CSP `img-src data:` 의도 주석, LOCAL_PR_GATE spec-first 문구. 선재 발견(staging smoke의 `agentwork` namespace 불일치 — main 기저 FAIL)은 DEVIATION_LOG `pending`.

## MOMO-385 Member Inspector + Canonical DM Navigation (2026-07-15)

- current-channel roster를 Discord식 right inspector로 옮기고 search/people/agent filter, avatar/presence/status/role/capability, copy/mention/context menu를 제공한다. 최신 screenshot 지시에 맞춰 member row는 compact native profile popover를 열고 그 안의 단일 DM action이 canonical DM을 선택한다. 표준 창은 264pt attached inspector, 좁은 창은 scrim 위 320pt overlay로 전환해 timeline과 겹치거나 폭을 밀지 않는다.
- `ChatViewModel`은 self/inactive/in-flight를 차단하고 typed DM outcome과 global navigation intent generation으로 A/B 동시 open·직접 선택·history back/forward·channel create success 뒤 stale success/error가 최신 화면 의도나 readable error를 덮지 못하게 한다. user-driven channel selection은 공통 navigation 경로에서 intent를 무효화한다. stale success는 canonical channel cache까지만 허용하고, 취소를 무시하는 backend 응답도 post-await cache/navigation 전에 `Task` cancellation로 차단한다. REST 응답은 raw participant가 정확히 2개의 서로 다른 valid ID이며 Set이 exact current+target인지 검증하고, current member 미확정·self·추가·중복·invalid participant를 POST 전후에서 fail-closed한다. server는 transaction 내부 target miss를 결과값으로 반환해 cross-workspace member를 500이 아닌 RLS-safe 404로 변환한다.
- narrow overlay는 timeline/composer를 hit-test와 AX tree에서 숨기고 search initial focus·close 뒤 composer focus 복귀를 실창 테스트로 검증한다. DM loading은 label/width를 유지하며 AX value만 `DM 여는 중`/`Opening DM`으로 보강한다. 캡처 하네스는 production `MomoMemberProfilePopoverView`를 직접 사용한다. DM focused 21건과 profile/focus 실창 3건, design preflight, standard/narrow light/dark+profile light/dark WindowServer 6건, fresh design review(Blocker 0/High 0/Medium 0)가 PASS했으며 final clean local gate 증거는 PR handoff에 기록한다.

## MOMO-384 Native Channel Creation + Window Tooltip (2026-07-15)

- sidebar inline form을 public/private, name, topic을 받는 native SwiftUI sheet로 교체했다. server와 같은 trim+lowercase+regex validation, 첫 name focus, Esc/Return, localized retry/error를 제공하고 기존 REST create 경로 성공 시 sheet를 닫아 새 channel을 선택한다. local 실패는 bounded issue만 보관하며 raw error 문자열은 장기 `Published` state에 남기지 않는다. 401/not-connected는 sheet를 닫고 기존 전역 session-expired 로그인 복구 CTA로 전달한다.
- channel create는 view-model operation/session generation과 시작 workspace, REST backend connection generation/workspace/access token을 await 전후로 대조한다. clear/rebootstrap/input cancel 뒤 도착한 success/error/defer는 channel·membership·selection·issue·in-flight/cache를 갱신하지 않으며, sheet Task도 disappear/session/input revision 변경에서 취소한다.
- icon control help는 root named coordinate space의 비차단 overlay presenter로 옮겼다. 0.12s 표시, intrinsic short width/최대 280pt 3-line wrap, edge clamp, hover/focus source 복원과 live copy 갱신을 적용했다. visual tooltip은 AX tree에서 숨기고 원래 icon-only button에 action label을 둔다. narrow/standard/fullscreen·light/dark·attached inspector의 screenshot/AX frame과 Tab/Space/Esc는 **local manual/AX evidence**이며, generation/auth/tooltip transition·contrast/large-text는 commit된 자동 test/snapshot evidence로 구분한다. native sheet는 별도 modal surface이므로 부모 tooltip을 그 위에 강제 노출하지 않는다.
- independent correctness/security/performance 반려의 session-transition admission, sheet pre-start cancellation, REST stale guard ordering, initial auth-expired 항목을 회귀 테스트로 닫았다. focused 27건과 macOS 전체 265건이 0 failure이며 fresh correctness/security/performance와 design review 모두 Blocker 0/High 0/Medium 0이다. PR #394는 worker `status:needs-review` handoff까지만 진행하고 merge/close는 momo-main이 수행한다.

## MOMO-383 Workspace-first Navigation (2026-07-15)

- toolbar의 떠 있는 workspace capsule을 제거하고 sidebar 최상단에 icon/name/member identity를 배치했다. native popover 메뉴에서 서버 설정, 멤버 초대, workspace ID 복사를 제공하며 표준 1180x760·좁은 900x650 실창에서 traffic light/channel header 겹침이 없음을 확인했다.
- `GET/PATCH /v1/workspaces/{workspaceId}`와 macOS binding을 추가했다. read는 active member, rename은 owner/admin만 허용하고 일반 member/cross-workspace 요청은 403으로 닫는다. rename은 row lock 아래 durable update와 `workspace.name.updated` audit를 남기며 두 번째 client read로 영속성을 검증했다.
- 공개 API와 권한 경계는 ADR-0118로 고정했다. 독립 security/design 리뷰 반려를 반영해 workspace cache를 server-origin+authenticated-member+workspace로 격리하고 401/403/404에서는 cache를 노출하지 않으며, transient 5xx/transport 실패만 명시적 "저장된 이름" 상태와 재시도를 제공한다. 409 lost-update 충돌은 최신 identity/version을 다시 읽어 다음 저장이 영구 stale에 빠지지 않는다.
- 최종 correctness 리뷰를 반영해 `ChatViewModel.bootstrap`의 channels/read-state/runtime/approval/subscription await마다 session/workspace generation을 재검증하고, 409 reload도 재검증 뒤에만 오류를 기록한다. 401/403/404는 exact server+member+workspace의 memory/UserDefaults cache를 삭제해 이후 5xx가 stale identity를 되살리지 못하게 한다. unknown error fallback은 default-deny이고 REST cancellation은 `CancellationError`로 보존한다. demo backend는 persistent cache scope를 제공하지 않으며 verifier의 workspace 이름은 `psql -v` stdin binding으로 audit/cleanup하고 apostrophe rename 뒤 원래 fixture를 다시 GET해 확인한다.
- migration 009는 workspace root에 `ENABLE/FORCE RLS`와 exact `app.workspace_id` policy를 추가했다. public join의 invite hash→workspace UUID lookup은 `momo_join_private` locked schema의 fixed-path `SECURITY DEFINER` 함수 하나로 제한한다. private object는 exact create라 preseed/drift 시 transaction이 실패하고 ACL은 owner+app만 허용한다. internal smoke의 roles absent→migrate→test bootstrap과 production의 externally provisioned roles→migrate 순서를 각각 isolated PG18에서 검증하며, production은 역할 누락/속성 drift를 migration 전에 거부한다.
- 설정은 1-80자 validation, owner/admin 전용 이유, conflict/permission/connection별 한국어·영어 오류를 제공한다. no-cache load 실패도 sidebar에 keyboard(`⇧⌘R`)/VoiceOver 가능한 retry를 노출하고 semantic primary text로 고대비를 보장한다. settings는 streaming `ChatViewModel` 대신 좁은 projection만 관찰하며 counter/validation/save는 같은 trimmed 문자열을 사용한다. 전체 Swift 테스트는 Core 24·Server 80·Relay 2·Worker 29·macOS 234, 총 369건 0 failure로 통과했다.
- workspace icon과 invite policy는 계속 이 Mac의 local display draft다. 다중 workspace rail은 ADR-0117 전 구현하지 않는다. 후속은 MOMO-384 `#390`, MOMO-385 `#391`, MOMO-386 `#392`다.
- final review fix는 delayed login→clear·overlapping A/B connect뿐 아니라 delayed members/channels 응답도 connection generation+exact workspace guard로 폐기해 reconnect 뒤 cache를 덮지 못하게 했다. normal/error realtime resubscribe cleanup, guarded parallel bootstrap, one-query workspace membership read, narrow settings invalidation을 포함해 focused 신규 macOS 8 + server 1과 raster 2종이 PASS했다. PR #389는 main `9c1fc7a`로 merge됐다.

## MOMO-388 Auth-Hardening Realtime Credential Binding Verifier (2026-07-15)

- 레거시 verifier가 멤버·채널만 담은 callback을 보낸 drift에 더해, 1차 수정이 `meta.token_id`를 임의 active UUID로만 검증하고 human의 active refresh row도 realtime liveness로 인정하던 review gap을 닫았다. human realtime credential은 이제 `session` 중 `label='access'` row만 허용하며 RLS와 `schema_v0.sql`은 변경하지 않았다.
- verifier의 token-row lookup은 raw bearer를 SQL·psql argv·log에 넣지 않고 로컬 SHA-256 digest로 access·refresh row를 각각 찾은 뒤, `POST /v1/auth/realtime-token`의 server-minted JWT `meta.token_id`가 exact access row와 일치함을 증명한다. callback fixture는 active access만 허용하고 active refresh row·누락·임의·다른 멤버·logout/revoke binding은 모두 `result == null && error.code == 403`으로 거부한다.
- JWT payload synthetic decode는 `sub`, optional `ws`, `exp`/optional `nbf`/`iat` 시간 경계를 확인하지만 Centrifugo websocket의 signature acceptance 자체를 독립 증명하지는 않는다. `umask 077`+`mktemp -d`, auth/refresh 실패 body 비노출, 안전한 cleanup을 적용했고 focused verifier PASS; review 반영 최종 clean `runtime-db`·`docs` evidence는 PR #393에 첨부한다.

## MOMO-382 Workspace-first UX + Superapp Shell Planning (2026-07-15)

- 2026-07-14 실창 QA 12건과 PLN-20260714-02를 대조해 workspace/server → channel/DM → timeline → governed Work 위계를 정본화했다. UX builder는 MOMO-383 → 384/385 → 386으로 분할했다.
- 전체 검색은 현재 recent-200 client scan을 확장하지 않고 RLS server search로 교체하며, multi-workspace는 ADR-0117, interactive command console은 ADR-0114 선행으로 동결했다.
- 엔진 다음 planning queue는 ADR-0113/0116 병렬 draft → ADR-0114 → ADR-0115다. ADR draft는 Accepted/구현 승인이 아니며 engine PR은 기본적으로 `clients/macOS/**`를 수정하지 않는다.

## MOMO-381 Superapp Engine Planning Integration (2026-07-14)

- PLN-20260714-02 gap audit/proposal/handoff를 security·architecture 독립 리뷰 후 정리했다. ADR-0113~0116, Capability/Memory/Context/action executor, MCP/plugin/webhook, Codex app-server, GWS read/citation의 buildable dependency graph와 UX-owned file lock을 제안 상태로 고정했다.
- 기존 MOMO-307/308/310/320/321/322 충돌을 정리했다. MOMO-308은 non-claimable umbrella로 전환해 auth/read/write-proposal 새 ID 3개로 분할하고, MOMO-320은 완료된 env drift guard 전용으로 유지한다. 오래된 handoff/research/INDEX 포인터에도 superseded 경고를 추가했다. 실제 Codex/GWS credentialed runtime은 여전히 `runtime-unverified`이며 Accepted ADR 전 구현 이슈를 ready로 올리지 않는다.
- 최종 review diff 기준 dirty docs local gate PASS(`20260714T145941Z-pid33813-ns1784041181992158000-wtc32931bd803d-r05b2e1251fbd`). final clean commit과 main post-merge docs gate는 PR 검수 단계에서 다시 실행한다.

## MOMO-379 macOS Chrome Hotfix (2026-07-14)

- SwiftPM/Xcode 두 host의 unified toolbar 기본 system title과 custom workspace identity가 함께 그려지던 중복은 공용 title-hidden scene style로 제거했다. 실창 AX 재검토에서 `NavigationSplitView` 각 칼럼의 `GeometryProxy.safeAreaInsets.top`이 0임을 확인해 그 경로를 폐기하고, hosting `NSWindow.contentLayoutRect`를 content-view 좌표로 변환한 실제 titlebar band를 루트 환경으로 전파해 sidebar와 detail 칼럼을 함께 내렸다.
- 트래픽라이트를 덮은 빨간 요소는 하단 승인 배지가 아니라 toolbar로 이동한 workspace header의 물리 공간을 잃은 첫 채널 mention 배지였고, 채널 헤더의 멤버/설정도 같은 0 inset 때문에 toolbar 뒤 y=0에서 시작했다. overlay scrim/pane은 실제 band 아래의 보이는 채널 헤더 측정값에, attached inspector는 같은 헤더 높이의 연속 surface/divider에 앵커한다. 헤더 높이 상태는 추정 64pt 대신 측정 전 0에서 시작한다.
- canonical harness는 production과 같은 full-size content view+unified toolbar+전체 root shell로 바꾸고, `momo/상준` fixture와 standard overlay light·narrow dark·attached dark를 기록 대상으로 삼았다. headless `cacheDisplay`는 NavigationSplitView material을 잘못 합성하므로 검토 artifact에만 허용하고 정본 기록은 WindowServer 합성본만 허용한다. 정본 3건은 오케스트레이터 재기록 대기이며 worker PNG 변경은 0건이다.
- 5개 Swift package build, Core 24·Server 76·Relay 2·Worker 29 전체와 macOS non-snapshot 146, MOMO-379 기능 10+artifact 1 tests가 PASS했고 canonical 3건은 재기록 대기로 정상 skip했다. fresh D6는 구현 6/7(Blocker 0, High 1=실창 AX 증거 미완료)이다. 무필터 macOS suite는 기존 첫 `AgentCredentialSnapshotTests` headless `NSImage` signal 5를 재현했다. Computer Use의 custom dev app 접근 거부와 관리 shell의 WindowServer 부재로 worker 쪽 표준/좁은/attached 실창 AX 재측정은 완료하지 못해 `runtime-unverified`; 오케스트레이터 재측정이 필요하다. DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행했다.

## MOMO-372 Member Directory + DM (2026-07-14)

- RLS tenant transaction 안에서 active 멤버 권한을 검사하고, 정렬한 두 member ID의 SHA-256 `dm_key`·partial unique index·pair advisory lock으로 동시 요청도 같은 1:1 DM에 수렴시키는 GET/POST REST를 추가했다. channel/channel_seq/두 membership을 함께 보장하며 archived DM은 재개한다. `schema_v0.sql`과 migration은 변경하지 않았다.
- macOS는 roster 기반 네이티브 멤버 디렉터리(검색·사람/에이전트·프로필·복구 상태·DM), 사이드바/⌘K의 상대 이름·표시 이름→channel ID 결정적 DM 정렬, DM unread 숫자 배지, 멤버 context menu/VoiceOver DM 액션을 제공한다. 사이드바 이름은 1줄 tail truncation+전체 tooltip/a11y이며 멤버 제목의 보이지 않는 버튼을 제거했다. `origin/main@c9ed890` rebase 후 채널 헤더의 `멤버 N명` optional hook은 production root의 같은 디렉터리 sheet fallback에 연결된다. 메시지 카드/타임라인은 건드리지 않았다.
- rebase 후 5개 Swift package build, Core 전체 24·macOS non-snapshot 전체 143·371/372 비정본 raster 7 tests가 PASS했고 fresh D6 design-review는 Blocker/High/Medium/Nitpick 0이다. 디렉터리 list/detail 분리 light/dark 4건과 DM unread 사이드바 2건은 신규 정본, 기존 ChannelRoster 6건은 무효화되어 모두 오케스트레이터 재기록 대기이며 worker PNG 변경은 0건이다. 필터 없는 macOS 전체 suite는 기존 canonical `AgentCredentialSnapshotTests`의 headless `NSImage` signal 5에서 중단돼 재기록 대상으로 남겼다. DB/Docker/verifier/`local_gate.sh` 및 실창 hit-test·resize는 지시대로 미실행(`runtime-unverified`).

## MOMO-371 Channel Header + macOS Chrome (2026-07-14)

- 채널명·주제·멤버 수·설정 진입점을 한 헤더로 묶고, 이름/주제·멤버 관리·연동 placeholder 시트와 MOMO-372가 주입할 멤버 디렉터리 훅을 추가했다. 서버 채널 수정 계약이 없어 이름/주제는 이 Mac의 표시값으로만 저장하며 앱 안에서 동기화 범위를 명시한다.
- 런타임 A/B 프로브로 죽은 상세 닫기 버튼의 원인이 구버전 타이틀바 밴드의 콘텐츠 침범임을 확인했다. 중복 사이드바 헤더를 표준 unified toolbar의 워크스페이스 identity로 옮겨 이 침범을 제거하고, 상세 패널 열림/닫힘을 단일 상태로 고정했다. surface stroke의 `allowsHitTesting(false)`는 원인 수정이 아닌 무해한 방어로 유지한다.
- Theme의 15pt급 row/message body와 Dynamic Type/increased contrast 대응, 프로덕션 session root까지의 optional MOMO-372 훅, 공용 로컬 채널 표시값을 헤더·사이드바·퀵스위처에 적용했다. `origin/main@6f4090c` rebase에서 새 헤더의 `showsCosts`와 Alpha Command Center 개발자 gate를 보존하고, 개발자 모드를 끌 때 닫힌 상세 패널이 다시 열리지 않도록 pane redirect를 분리했다. 5개 Swift package build, Core 23·macOS 기능 135·실행 가능 snapshot 39 tests(신규 정본 대기 2 skip), 비정본 light/dark/contrast/large-type 래스터와 fresh design-review(Blocker/High/Medium/Nitpick 0)가 PASS했다. 무필터 macOS suite와 별도 MessageBubble canonical은 기존 headless `NSImage` signal 5를 재현했으며, 정본 light/dark PNG 재기록과 실창 titlebar/fullscreen/click 검증은 오케스트레이터 대기(`runtime-unverified`). DB/Docker/verifier/`local_gate.sh`는 미실행했다.

## MOMO-370 Dual-density Developer Mode (2026-07-14)

- 기본 off 개발자 모드와 그 안의 비용 표시 토글을 추가했다. 기본 타임라인·partial·Work·승인 인박스는 사람 언어 요약/승인 문장만 보이고 프로토콜·tool JSON·비용·진단 도구·Alpha Command Center·로컬 알파 채우기·세션 상세를 숨기며, 개발자 모드는 Work 지시문을 포함한 기존 밀도를 유지한다. 접힌 에이전트 카드는 2줄 뒤 펼침 시 전문+detail을 중복 없이 표시하고, 동적 이름 조사는 마지막 한글 음절 종성에 맞춘다.
- 표준 모드 초대 fallback은 Alpha 대신 초대 안내로 라우팅한다. 371 채널 헤더/툴바/상세 레이아웃과 372 디렉터리/DM/server, `schema_v0.sql`, 기존 정본 PNG는 변경하지 않았다. 신규 timeline standard/developer light/dark 정본 PNG 4종은 오케스트레이터 재기록 대기다.
- 5개 Swift package build, Core 23·Server 73·Relay 2·Worker 29·macOS 비이미지 130 tests, 기존 AgentWorkSurface canonical light/dark, 표준 ApprovalInbox 포함 최종 검토 raster 13종이 PASS했다. fresh design-review는 6.5/7, Blocker/High/Medium/Nitpick 0이다. 무필터 macOS suite는 기존 headless `NSImage` nil(signal 5)이 `AgentCredentialSnapshotTests` 및 누적 실행의 `MessageBubbleSnapshotTests`에서 재현됐으며, 실창 상호작용과 DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행(`runtime-unverified`).

## MOMO-369 App Shell Visual Polish W3 (2026-07-13)

- Theme에 양 스킴 background/panel/card 표면 세트와 타이포·radius·≤0.16s motion 토큰을 추가하고 사이드바·타임라인·Work/승인 카드·팝오버에 적용했다. 401은 원문 없는 단일 `다시 로그인` 배너, realtime REST fallback은 헤더 칩으로 정리했다.
- partial 블록 커서 제거, 선택 언어 기반 day divider, 멘션 행의 AGENT 이중 신호 제거, `+N` 전체 capability 도움말을 구현했다. 온보딩 파일과 `schema_v0.sql`, 기존 정본 PNG는 변경하지 않았다.
- fresh review High 2건을 반영해 루트·사이드바·타임라인 fill의 safe-area bleed를 복원하고, 인증/불러오기/보내기/작업 오류 문법과 동일 `clientMsgId` send 재시도·에이전트 멘션 실패 신호를 분리했다. MOMO-368을 union rebase한 뒤 5개 Swift package build, Core 23·Server 73·Relay 2·Worker 29·macOS 기능 127 tests 및 비정본 raster 6(W3 5+온보딩 1) tests가 PASS했고 fresh design-review는 Blocker/High/Medium/Nitpick 0이다. 필터 없는 macOS suite는 기존 headless `SnapshotTesting/NSImage.swift` signal 5로 중단됐고, W3 light/dark 정본 PNG 재기록과 DB/Docker/verifier/`local_gate.sh`는 지시대로 오케스트레이터 대기(`runtime-unverified`).

## MOMO-368 Onboarding/Login Raycast Redesign (2026-07-13)

- macOS 온보딩을 560pt 중앙 max-width의 압축 hero+단일 로그인 카드로 재구성하고 1/2/3 디버그 단계를 제거했다. 자격 정보 완성 전에는 데모, 완성 후에는 로그인이 유일한 primary이며 초대 참여·Keychain·로컬 알파 채우기는 낮은 위계로 정렬했다.
- 네이티브 입력 동작을 유지한 focus ring과 Tab/Enter/Esc 경로, 고정 accent, transport/auth 분류 및 서버 없이 데모를 여는 오프라인 복구를 추가했다. 리뷰 반영으로 primary 라벨을 시스템 비활성 표현에 위임하고 네 필드 Enter를 현재 primary에 연결했으며, 필드는 불투명 semantic 배경을 쓴다. 실효 없는 high-contrast/large-type 산출은 제거해 default/large/compact/light/dark/focus/sign-in/invite/offline 9종 검토용 래스터만 남겼다. 정본 light/dark PNG 4건은 오케스트레이터 재기록 대기다.
- Core·server·OutboxRelay·AgentWorker·macOS 5개 `swift build --disable-sandbox`와 Core 23·server 73·relay 2·worker 29·macOS 비이미지 122 tests가 PASS했다. 온보딩 snapshot 클래스는 검토용 래스터 PASS+정본 4건 정상 skip이고 review-fix fresh design-review도 PASS(Blocker/High/Medium/Nitpick 0)했다. 필터 없는 macOS 전체 test는 main 기지선인 `AgentCredentialSnapshotTests` headless `NSImage` signal 5를 재현했다. DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행(`runtime-unverified`).

## MOMO-367 Wave 2 Unread UI + Keyboard Navigation (2026-07-13)

- macOS 부팅 벌크 read-state 점등과 개인 realtime 동기화, 로컬 unread/mention 즉시 추정 후 서버 재동기화, 뷰포트 debounce mark-read 재시도와 own-send 하단 추적을 구현했다. 사이드바에는 unread 굵기·mention 숫자 배지·동기화 오류 복구 UI를 추가했다.
- `⌥⇧↑↓`는 357 사이드바 정렬의 다른 unread 채널을 순환하며 destination이 없으면 비활성화된다. 초기 리뷰 High 1(`⇧⌘↑↓`의 macOS 텍스트 선택 충돌)은 planner 승인 Slack 문법으로 해소했고, fresh 재검토는 Blocker/High/Medium 0이다. 에러 행·VoiceOver·light/dark 배지 픽셀 검증을 갱신했으며 `schema_v0.sql`은 변경하지 않았다.
- `origin/main`의 MOMO-364와 union rebase 후 Core·server·OutboxRelay·AgentWorker·macOS 5개 `swift build --disable-sandbox` 및 Core 23 tests, macOS 비이미지 116 tests가 PASS했다. MOMO-367 관련 snapshot 15 tests는 기존 정본 11 PASS+신규 정본 4 정상 skip이며 재기록은 오케스트레이터 대기다. 필터 없는 macOS 전체 test는 main에도 기록된 `AgentCredentialSnapshotTests`의 headless 1x `NSImage`와 2x 정본 불일치로 `SnapshotTesting/NSImage.swift` signal 5 중단; DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행(`runtime-unverified`).

## MOMO-365 Work Capability Badges + Target Filter (2026-07-13)

- roster가 `agent.config.capabilities` 문자열 배열만 read-through하고 MomoCore `Member`에 보존한다. 공용 AGENT/capability 배지를 사이드바·Cmd+K·멘션 후보·멤버 상세에 적용했으며 `schema_v0.sql`과 migration은 변경하지 않았다.
- Work 후보는 MOMO-354의 선택 채널 active roster를 재사용해 capability 보유 에이전트만 명시 선택용으로 반환한다. 자동 라우팅과 MOMO-364의 Work 카드/컴포저는 추가하지 않았다.
- 검증: Core/Server/macOS `swift build --disable-sandbox` PASS, Core 19·Server 68·macOS 비스냅샷 95 tests PASS, capability light/dark 래스터와 fresh static design-review PASS(Blocker/High/Medium 0). 신규 sidebar/Cmd+K light·dark 정본 PNG 4건 재기록과 DB/Docker/verifier/`local_gate.sh`/실 codex 실행은 오케스트레이터 대기(`runtime-unverified`).

## MOMO-363 Work v0 Codex Workbench Gateway Adapter (2026-07-13)

- `adapters/codex-workbench/`가 scoped agent bearer로 Work job을 claim하고 host Codex `exec`/`resume`을 감싼다. read-only는 즉시 실행하며 workspace-write는 read-only 계획 세션 ID를 mode-0600 host state에 보존한 뒤 MOMO-362 승인 전에는 workspace-write로 실행하지 않고, network/danger 경로는 제공하지 않는다.
- Codex JSONL은 bounded gateway status/partial로만 전달하고 최종 completion은 diff·변경 파일 수·exit·PR 링크 자리의 `momo.agent_work.result.v0` 카드다. 운영 공지 durable send 및 Codex/provider 자격증명 momo 유입 경로는 없다.
- 검증: repo-local mock Codex 기반 DB 비접속 Python 계약 테스트, py_compile, launcher `bash -n`, `git diff --check` 대상. 실 Codex·DB/Docker/verifier/`local_gate.sh`·clean/root `runtime-agent`는 오케스트레이터 대기(`runtime-unverified`).

## MOMO-366 Wave 2 Read-State Server Contract (2026-07-13)

- actor-bound bulk GET과 단조 증가 PUT read-state API를 추가했다. unread는 channel head와 cursor의 차이로 계산하고, text message 저장 시점의 stable member ID mention을 `message.props`와 `read_state.mention_count`에 같은 트랜잭션으로 반영한다.
- cursor가 실제 전진할 때만 transactional outbox에 exact actor용 `user:read-state#<member-id>` 이벤트를 기록하며, Centrifugo `user` namespace는 user-limited channel을 허용한다. `schema_v0.sql`은 변경하지 않았다.
- 검증: 5개 Swift 패키지 build, Core 18·Server 68·Relay 2·AgentWorker 29·macOS 비스냅샷 94 tests, JSON/shell/whitespace 정적 검사 PASS. macOS 전체 snapshot suite는 기존 host-dependent `SnapshotTesting/NSImage.swift` signal 5로 중단됐다. 지시된 경계에 따라 DB/Docker/verifier/`local_gate.sh`는 미실행이며 clean/root runtime-agent delivery 검증은 오케스트레이터 대기(`runtime-unverified`).

## MOMO-364 Work v0 macOS Surface (2026-07-13)

- MomoCore에 MOMO-362 `agent_run` Work projection을 추가하고 macOS REST/인메모리 backend와 ViewModel을 연결했다. `/work` 및 컴포저 버튼으로 시작하며, 채널 타임라인의 접힌 partial 로그·공용 승인 컨트롤·diff/exit/PR 결과 카드와 우측 전체 transcript 상세 pane을 제공한다. 리뷰 반영으로 durable terminal 상태 우선, 이중언어 오류, cancelled 중립 결과, Esc draft 복원, ⇧⌘W 도움말을 고정했다. MOMO-359 메시지 그루핑과 MOMO-365 사이드바·스위처·capability 배지 파일 경계는 유지했다.
- 검증: Core/macOS `swift build --disable-sandbox` PASS, Core 20 tests PASS, macOS 비스냅샷 106 tests PASS, MOMO-364 light/dark snapshot 2 tests compile 후 정본 재기록 대기 skip, 변경 파일 design pre-flight PASS. 전체 macOS test는 기존 `AgentCredentialSnapshotTests` headless `NSImage` fatal로 중단되어 비스냅샷과 신규 snapshot을 분리 검증했다.
- 지시대로 DB/Docker/verifier/`local_gate.sh`/실 codex 실행은 하지 않았다. 실제 MOMO-362 서버 및 codex-workbench 왕복과 신규 Work·keyboard-help 정본 PNG 재기록은 오케스트레이터 대기(`runtime-unverified`).

## MOMO-362 Work v0 Run Contract + Approval Tiers (2026-07-13)

- `agent_run.input`의 정확한 Work v0 shape를 트랜잭션 전에 검증하고, active human/channel-agent 결속·멱등·동시성 한도를 지키는 Work 생성 및 channel 목록/상세 REST를 기존 gateway outbox 경로에 추가했다. `schema_v0.sql`과 migration은 변경하지 않았다.
- gateway 승인 요청은 `read_only|workspace_write|network_write` tier를 approval payload/card metadata에 보존하며, legacy MOMO-349 요청은 보수적 `workspace_write`로 유지하고 danger 상당은 400으로 닫는다. callback actor binding과 agent bearer allowlist는 유지했다.
- 검증: server `swift build --disable-sandbox` PASS, 68 tests PASS. 지시된 DB/Docker/verifier/`local_gate.sh` 및 clean/root `runtime-agent`는 오케스트레이터 대기(`runtime-unverified`).

## MOMO-358 UI W1 Quick Switcher + Keyboard Navigation (2026-07-13)

- macOS 앱에 즉시 포커스되는 `Cmd+K` 퀵 스위처를 추가해 최근 채널 우선 fuzzy 검색과 현재 채널의 active roster 멤버 검색을 제공한다. 채널 선택은 타임라인으로, 멤버 선택은 프로필로 이동하며 invited active membership만 노출한다.
- `Cmd+1...9`는 공용 사이드바 정책이 만든 non-archived 일반 채널→DM 표시 순서를 그대로 열고, `Cmd+K` 재입력은 스위처를 닫는다. `Cmd+[`/`Cmd+]` 채널 히스토리와 `Cmd+/` 단축키 도움말을 두 앱 host의 scene commands에 연결했으며 화살표/Enter/Esc와 VoiceOver 선택 포커스도 지원한다.
- 검증: macOS `swift build --disable-sandbox` PASS, 비스냅샷 94 tests PASS, quick switcher/help light·dark snapshot 4 tests compile+reference-wait skip, 변경 파일 design pre-flight PASS, fresh static design-review PASS(Blocker/High/Medium/Nitpick 0). 신규 정본 PNG 재기록과 DB/Docker/verifier/`local_gate.sh`는 오케스트레이터 대기(`runtime-unverified`).

## MOMO-357 UI W1 App Shell + Sidebar (2026-07-13)

- macOS 앱 셸을 `NavigationSplitView`와 min/ideal/max Theme 폭 토큰으로 전환하고, 사이드바 주 계층을 워크스페이스/채널/DM/멤버로 재구성했다. 승인함과 개발 도구는 하단 유틸리티로 내렸고 멤버 액션은 hover/context menu에서만 노출한다.
- 기존 roster SoT만 사용하며 real-server roster의 합성 `.online` 점은 숨기고 실제 agent working 상태만 유지한다. 새 REST/스키마는 없고 `MessageListView`/`MessageBubble`은 변경하지 않았다.
- fresh review 반영: 멤버 add/remove를 context menu와 VoiceOver 비마우스 경로로 복원하고, workspace gear의 비가시 hit-test/accessibility를 차단했으며, 개명 전 고아 snapshot PNG 2장을 제거했다.
- 검증: macOS `swift build --disable-sandbox` PASS, 비스냅샷 83 tests PASS, light/dark sidebar snapshot 2종 compile+reference-wait skip, light/dark raster agent-badge test PASS, fresh static design-review PASS(Blocker/High/Medium 0). 전체 snapshot suite는 기존 host-dependent `SnapshotTesting/NSImage.swift` signal 5로 중단됐고 정본 PNG 재기록과 DB/Docker/verifier/`local_gate.sh`는 오케스트레이터 대기(`runtime-unverified`).

## MOMO-359 Message Timeline Density + Grouping (2026-07-13)

- macOS 타임라인은 기존 `message.seq` 입력 순서를 바꾸지 않는 표시 전용 5분 작성자 그룹과 day divider를 사용하며, 그룹 첫 행만 아바타·이름·상시 타임스탬프를 표시하고 compact 행은 hover 타임스탬프를 표시한다.
- 새 내용은 사용자가 이미 하단에 있을 때만 따라가고 위를 읽는 중에는 위치를 유지한다. hover/키보드 포커스 액션은 실제 pasteboard 복사만 제공하며 AGENT 배지와 status/partial 카드는 독립 행으로 유지한다.
- 검증: macOS build, 비스냅샷 85 tests, 신규 timeline snapshot 3 tests(light/dark 정본 대기 2 skip + 양 모드 agent/status raster 1 PASS), 변경 표면 design pre-flight PASS. hover 복사 칩의 material까지 전체 opacity 범위에 포함했다. 기존 전체 image snapshot suite는 sandbox `NSImage` signal 5로 중단됐고 `MessageBubbleSnapshotTests`·`MessageTimelineSnapshotTests` light/dark 정본 재기록, clean `macos-ui`·런타임은 오케스트레이터 대기(`runtime-unverified`).

## MOMO-361 Phase A Deploy Bundle + Operator Runbooks (2026-07-13)

- source checkout·populated `.env`를 고정 allowlist에서 배제하고 symlink/실 secret template을 fail-closed하는 deploy bundle packer와 합성 fixture 회귀 테스트를 추가했다. AWS provision→두 preflight→bundle 반입→pull/migrate/up→verify→digest rollback 및 10인 invite/Hermes 승인 운영 절차를 runbook 두 개로 고정했다.
- 검증: 신규 shell `bash -n`/shellcheck, 합성 fixture bundle test, 실제 repo allowlist archive 검사 PASS. 지시된 범위에 따라 Docker/DB/verifier/`local_gate.sh`/AWS API와 실제 host deploy는 미실행(`runtime-unverified(aws-host)`).

## MOMO-360 GHCR Image Publication + Pull-and-Up Contract (2026-07-13)

- 수동 `workflow_dispatch` 전용 GHCR workflow가 api/relay/worker/migrate 4종을 `linux/arm64`, `sha-<gitsha>`로 발행하며, prod compose는 동일 release tag 또는 per-image digest로 고정된 migrate-first pull&up/rollback 계약을 사용한다.
- actionlint, shell syntax/shellcheck, Python preflight 정적 계약, YAML 구문 검사와 `git diff --check`는 PASS. 지시상 Docker/AWS API/image build·push/compose config/verifier/local gate는 미실행(`runtime-unverified`). `schema_v0.sql`은 변경하지 않았다.

## MOMO-354 Real-Server Roster SoT + Invite-Gated Visibility (2026-07-13)

- macOS REST backend의 demo member/channel fixture fallback과 이름 기반 agent 숨김을 제거하고, 서버 `/roster`의 active `channelIds`를 멤버 사이드바·멘션 후보·메시지 작성자·agent realtime 구독의 공통 권위로 사용한다. offline demo fixture는 `LiveChatBackend`에만 남는다.
- login/join 응답의 `realtimeWebSocketUrl`을 서버가 광고하고 앱은 이를 환경값보다 우선해 SwiftCentrifuge transport를 구성한다. API 계약은 Accepted ADR-0110에 기록했고 prod/e2e env를 정렬했다.
- 검증: server build + 63 tests PASS, macOS build + 비스냅샷 79 tests PASS, 신규 roster light/dark snapshot 2종은 정본 PNG 부재로 명시적 skip, Python no-network/no-DB contract + 수정 shell `bash -n`/실행권한 PASS, design-review PASS(Blocker 0/High 0/Medium 1). 지시된 경계에 따라 Docker/DB/verifier/`local_gate.sh`는 미실행이며 clean `macos-ui`와 snapshot 재기록은 오케스트레이터 대기(`runtime-unverified`).
- fresh-context 반려 High 2건 수정: server-SoT 세션의 로컬 프로필 편집 진입점과 `applyLocalProfile`을 동일 경계로 차단하고 안내 카피를 추가했다. roster snapshot은 `NSHostingView` 2x 래스터로 교체하고 light/dark 모두 Hermes `AGENT` accent 픽셀 100개 초과를 강제한다. macOS 비스냅샷 79 tests + roster snapshot 3 tests(정본 대기 2 skip, pixel 보장 1 PASS), static contract/design pre-flight PASS, fresh design-review PASS(Blocker 0/High 0/Medium 0/Low 0). 정본 PNG 재기록은 오케스트레이터 대기.

## MOMO-355 Dogfood Agent Seed Opt-in (2026-07-13)

- `scripts/migrate.sh` 기본값을 `MOMO_AGENT_SEED_MODE=none`으로 고정하고, `002_seed.sql`의 김인턴 행과 `006_local_hermes_agent_seed.sql` 전체를 demo/e2e 명시 opt-in으로 제한했다. local-alpha는 caller env와 무관하게 none을 강제하며 fresh bootstrap은 human + 기본 채널, agent 0으로 시작한다. `schema_v0.sql`은 변경하지 않았다.
- `scripts/momo hermes-gateway-init`을 pre-pairing template → 앱 초대 → credential 1회 발급 → env 기록 순서로 재작성했다. 기존 고정 김인턴/Hermes는 `scripts/momo cleanup-seeded-agents --yes`에서만 exact identity/DB-owner guard 후 membership·work·credential을 중단하고 handle을 해제한다; 신규 destructive migration은 없다.
- runtime-agent/macOS verifier migration은 agent seed none을 명시하고 기존 marker/OID-owned DB·자체 fixture·per-run uppercase transport channel·exit 96/source 보존 계약을 Python 정적 테스트로 고정했다. shell `bash -n`, Python contract, `git diff --check`, 5개 Swift 패키지 `swift build --disable-sandbox` PASS; Core 18/Server 61/Relay 1/AgentWorker 29/macOS 비스냅샷 78 tests PASS. 변경하지 않은 기존 macOS image snapshot suite는 sandbox `NSImage` signal 5로 중단되어 reference PNG를 재기록하지 않았다. DB/Docker/verifier/local gate는 지시상 미실행이며 clean/root `runtime-agent` + `macos-ui`는 오케스트레이터 merge 전 대기(`runtime-unverified`).
- 리뷰 게이트에서 context verifier가 seed-none DB의 고정 human/Hermes FK를 자체 생성하지 않는 계획 이탈이 확인됐다. workspace·human(…101)·agent(…103)·두 채널/seq·membership을 verifier-owned fixture로 보강하고 정적 계약에 고정했다. 다른 seed-none verifier의 고정 seed ID 참조도 전수 점검했으며, DB/Docker/verifier 재실행은 오케스트레이터 대기(`runtime-unverified`).

## MOMO-356 Gateway Operational Notice Suppression (2026-07-13)

- Hermes platform `send()`는 명시적 momo `run_id`가 있는 실제 에이전트 최종 응답만 REST durable message로 허용한다. session reset, home-channel, `/resume`·`/sethome`, model/provider 등 run-unbound 운영 공지는 성공 처리 후 본문을 남기지 않는 로컬 이벤트 로그로만 기록한다. native gateway 최종 응답은 기존 `/gateway/complete` server-owned commit을 유지한다.
- `scripts/momo hermes-gateway-init`이 Hermes 정식 `MOMO_HOME_CHANNEL`/이름을 새 env에 기록하고 기존 env의 `MOMO_DEFAULT_CHANNEL_ID`에서 보강해, 홈 채널 요구를 gateway 기동 전에 해결한다. verifier에는 fresh marker/OID DB·per-run channel·대문자 transport·source digest·exit 96 경계를 유지한 채 운영 공지 전후 agent message count 불변 assertion을 추가했다. `schema_v0.sql`과 UI/스냅샷은 변경하지 않았다.
- 검증: adapter contract 54 tests, smoke, py_compile, 실제 Hermes SDK `SendResult` 호환, 신규·기존 임시 env의 home-channel init, 수정 shell `bash -n`/실행권한, `git diff --check` PASS. 지시된 worker 경계에 따라 Docker/DB/verifier/`local_gate.sh`는 실행하지 않았고 clean/root `runtime-agent`는 오케스트레이터 merge 전 수행 대기(`runtime-unverified`).

## MOMO-352 Agent Path Equivalence Verifier (2026-07-12)

- 신규 `scripts/verify_agent_path_equivalence.sh`가 worker(managed)와 gateway(BYOA)의 정본 verifier를 각각 fresh marker/OID-owned DB와 per-run 대문자 transport channel에서 실행하고, trigger→approval→resume→final의 run 상태·approval·usage/audit·durable message·realtime publication 보장 manifest를 비교한다. 허용 차이는 timing/provider metadata/gateway lease/path-channel identity로 코드 안에 한정했다.
- 양 경로의 pre-marker COMMENT 실패 exit 96 exact-OID rollback과 source dogfood DB digest EXIT trap을 동등성 verifier 자체가 강제한다. `verify_hermes_gateway_adapter.sh`에는 부모 verifier가 per-run marker/channel을 결속할 수 있는 검증 전용 marker UUID override만 추가했으며 `schema_v0.sql`은 변경하지 않았다.
- 검증: 신규/수정 shell `bash -n` + `git diff --check` PASS. 지시된 worker 경계에 따라 Docker/DB/verifier/`local_gate.sh`는 실행하지 않았고, clean/root `runtime-agent`와 실제 두 경로 비교는 오케스트레이터 merge 전 수행 대기(`runtime-unverified`).

## MOMO-341 Gateway Pending Durable Claim/Lease (2026-07-12)

- 신규 `008_gateway_job_lease.sql`이 gateway `agent_job` outbox row에 단일 owner/acquired/expiry를 멱등 추가한다. actor-bound pending recovery는 tenant transaction의 `FOR UPDATE SKIP LOCKED`로 원자 claim하며, 만료된 pending row만 새 lease로 takeover한다. `schema_v0.sql`은 변경하지 않았다.
- events/complete/renew/release는 exact job+lease+run+agent 결속을 강제하고 lease 부재·non-owner·expired·takeover 뒤 stale owner를 명시적 409로 닫는다. transaction closure의 예상 가능한 lease 거부는 결과값으로 반환한 뒤 transaction 밖에서 409로 매핑해 PostgresNIO error wrapping이 500으로 새지 않게 했다. Hermes adapter는 realtime을 wake-up으로 유지하고 한 row씩 claim해 provider 실행 중 lease를 renew하며, renew 상실 시 provider task를 취소한다. provider credential은 계속 사용자 Hermes 내부에만 있다.
- 리뷰 반영: approval callback이 job을 정산한 `awaiting_approval` run의 late complete는 lease DTO/DB 검증보다 human-decision guard를 먼저 적용해 항상 409로 닫는다. queued/running/terminal callback의 exact-owner lease 검증은 유지한다.
- 검증: server build + 61 tests PASS(approval-held pre-lease 409, 동시 consumer 단일 claim, crash expiry/takeover, stale owner event/complete/renew/release 409, expiry reclaim 단위 회귀 포함), adapter contract 52 tests PASS, adapter py_compile + verifier `bash -n`/실행권한 PASS. DB/Docker/verifier/clean-root `runtime-agent` 재검증은 worker 금지 범위로 실행하지 않았으며 오케스트레이터 수행 대기(`runtime-unverified`).

## MOMO-350 Gateway Status/Partial Broadcast (2026-07-12)

- actor/run-bound `/gateway/events`가 bounded `thinking`/`streaming` callback을 받아 macOS wire shape의 `agent.status`/`agent.partial`을 observable `agent:` outbox에 기록한다. gateway bearer는 기존 sliding-window per-member rate limit을 공유하고 progress에는 별도 run당 240 events/minute 하드캡, detail 2 KiB, text delta 8 KiB 상한을 둔다.
- Hermes adapter는 provider stream을 512-byte/250ms 단위로 샘플링해 callback하고, macOS REST backend는 exact workspace/channel/agent `agent:` subscription을 기존 `AgentPartialView` state에 합친다. `agentwork:` private job namespace와 progress는 계속 분리된다.
- 검증: server build + 54 tests PASS, adapter contract 49 tests PASS, macOS 비스냅샷 78 tests PASS(그중 gateway progress/실렌더 상태 타깃 3), adapter py_compile + verifier `bash -n`/실행권한 PASS. DB/Docker/verifier/clean-root `runtime-agent`는 worker에서 실행하지 않았으며 오케스트레이터 수행 대기(`runtime-unverified`).

## MOMO-351 이중 실행 경로 문서 재정렬 (2026-07-12)

- ADR-0102를 근거로 adapter contract·L4 §6·README·architecture를 gateway=BYOA / worker=managed 이중 경로와 서버 소유 보장 매트릭스로 정렬하고, SD-5 API 표면 및 ADR-0101 bearer/legacy 폐기 연결을 문서화했다. 코드·shell·schema 변경 없음.
- 변경 Markdown 11종의 상대 링크·코드펜스·필수 앵커 검사 PASS, `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS (`local-gate-docs-20260712T053631Z-pid49234-ns1783834591549328000-wt0ded8bfeb542-r86afa3415f59.md`).
- runtime/DB/Docker 기동 검증은 worker 금지 범위로 실행하지 않았다. clean docs gate와 acceptance 체크박스 확정은 오케스트레이터 merge 전 대기한다.

## 0. Repo Bootstrap Hardening (2026-06-24)

- Centrifugo/server 계약을 `/v1/centrifugo/subscribe` + `ch:ws<workspaceUUID>.<channelUUID>` / exact-channel observable `agent:ws<workspaceUUID>.<channelUUID>.<agentMemberUUID>` / private `agentwork:ws<workspaceUUID>.<agentMemberUUID>`로 정렬하고, legacy GitHub bootstrap은 guard 처리.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build` 및 `make test` 모두 5개 Swift 패키지 green. `adapters/hermes/momo_adapter.py` py_compile, JSON/shell syntax, GitHub bootstrap dry-run 통과.
- MOMO-001 이전에는 런타임 e2e가 미검증이었으나, 현재는 아래 Runtime Gate에서 compose/migrate/server health/seq gapless, relay→Centrifugo publish 왕복, RLS 테넌트 격리, AgentWorker↔OpenAI-compatible SSE + 비용 reserve/reconcile까지 검증됨.

## MOMO-349 Gateway Approval Roundtrip (2026-07-12)

- agent bearer actor/run binding 뒤 `approval_request` callback을 받아 기존 `approval`/`agent_run.awaiting_approval`/`approval_request` message/audit/outbox 상태머신을 한 tenant transaction에서 기록한다. callback 재시도는 같은 `tool_call.call_id`의 pending approval을 재사용하며 초기 gateway job을 정산한다.
- human approve/reject는 원 run의 gateway delivery를 DB에서 판별해 private `agentwork:` resume `agent.job`을 만든다. 어댑터는 approved payload를 `resume_momo_job`(지원 시)으로 재개하고 rejected payload는 provider를 호출하지 않은 채 cancellation ack로 정산한다. 승인 대기·거부 후 late `/gateway/complete`는 409로 막아 human 결정을 우회/되살리지 못하게 했다.
- macOS 기존 승인 인박스가 읽는 `/approvals?status=pending` projection과 durable timeline message를 그대로 재사용한다. diff 보안/correctness 리뷰에서 callback JSON 크기 상한, terminal/held 상태 결속, reject ack 결속, Swift UUID 대문자 채널 정규화를 확인했다(Blocker 0). 검증: server build + 51 tests PASS, adapter contract 46 tests PASS, 수정 verifier `bash -n`/실행권한 PASS. DB/Docker/verifier/`runtime-agent`는 worker에서 실행하지 않았으며 clean/root gate evidence는 오케스트레이터가 merge 전 수행 대기(`runtime-unverified`).

## MOMO-353 Local Gate Drift Guard (2026-07-12)

- `make up`이 repo `infra/centrifugo.json` SHA-256을 컨테이너 생성 시 fingerprint로 고정하고, `ensure_runtime_env.sh`가 실행 컨테이너와 현재 repo fingerprint를 대조해 drift를 fail-closed하거나 `MOMO_CENTRIFUGO_AUTO_RECREATE=1` opt-in으로 Centrifugo 서비스만 재생성한다.
- local gate는 run별 marker를 자식 verifier에 상속하고 유효 marker+repo command를 함께 증명한 프로세스만 pre-clean/EXIT reaping한다. unmarked dogfood MomoServer(합성 28180 포트)와 사용자 프로세스를 kill set에서 배제하는 격리 테스트 PASS; Docker running-config 및 clean/root runtime gate는 오케스트레이터 수행 대기(`runtime-unverified`).

## MOMO-347 Pairing Popover Credential Embedding Hardening (2026-07-11)

- 340pt pairing popover를 최대 640pt 높이의 `ScrollView`로 제한하고 24pt inset(유효 폭 약 292pt)에서 자격증명 행이 좁은 헤더/메타데이터 레이아웃으로 전환되게 했다. popover의 material/accent/GroupBox 3중 카드는 flat 자격증명 섹션으로 줄였다.
- 폐기 피드백은 대상 credential 행에 귀속하고, 발급/폐기 직후 refresh는 기존 in-flight 조회를 합친 뒤 mutation 이후 최신 조회를 한 번 더 수행한다. 명목상 large-type 스냅샷은 기존 PNG 바이트를 보존한 채 constrained-window 검증으로 정직화하고 신규 290pt 스냅샷을 추가했다.
- 검증: macOS `swift build --disable-sandbox` PASS, snapshot suite 제외 77 tests PASS, 신규 290pt snapshot PASS, refresh 경합/manifest secret 비포함/issue-rotate-revoke 타깃 3 tests PASS, fresh-context design-review **PASS Blocker 0/High 0**. 기존 snapshot 참조 재기록과 `macos-ui` gate는 오케스트레이터 정본 머신에서 merge 전 수행 대기.

## MOMO-339 macOS Agent Credential Pairing UI (2026-07-11)

- 페어링 초대 완료를 per-agent bearer 발급 API에 연결하고, 원문을 transient one-time reveal sheet에서만 표시한다. 프로필과 페어링 패널은 configured/active/expiring/revoked 메타데이터, 24시간 grace 회전, 확인 후 폐기, 401 복구 안내를 공유한다.
- 매니페스트는 env 위치와 `MOMO_AGENT_TOKEN` 키 이름만 포함하며 bearer 원문은 계속 제외한다. 앱은 `~/.momo/hermes-gateway.env`를 직접 쓰지 않고 mode 600 확인과 gateway 재시작을 안내한다.
- 검증: `swift build --disable-sandbox` PASS, credential 계약/스냅샷 포함 `swift test --disable-sandbox --skip MessageBubbleSnapshotTests` 82 tests PASS, design-review Blocker 0. 기존 MessageBubble ImageRenderer 테스트 2개는 이 샌드박스에서 SnapshotTesting 내부 signal 5로 단독 재현되며, `macos-ui` 런타임 게이트 evidence는 오케스트레이터가 merge 전에 수행한다.
- 2026-07-11 오케스트레이터 검수: worker 샌드박스에서 기록된 스냅샷 참조 6종이 정본 게이트 머신에서 전부 불일치 → 재기록(레이아웃 동일, 렌더링 환경 교정) 후 84 tests green(worker 환경의 MessageBubble signal 5는 재현 안 됨). fresh-context design-review 재판정 **PASS Blocker 0** (High 2·Medium 4는 MOMO-347 `#324`로 후속). main 위 rebase 후 PR #323 merge (`881518b`).
- worktree clean `macos-ui` gate full PASS: `local-gate-macos-ui-20260711T133015Z-…-r5dda86359a9b.md`. root post-merge `macos-ui`는 선재하던 `verify_macos_real_backend_ui.sh`의 dogfood 결합(hermes 멤버십 drift로 mention→agent_job count=0 + shared DB mutation)에서 중단 → MOMO-348 `#325` 발급 (MOMO-346 후속, macos-ui 프로파일 격리).

## MOMO-348 macOS Real-Backend Verifier DB 격리 (2026-07-12)

- `verify_macos_real_backend_ui.sh`를 매 실행 unique marker/OID-owned migrated DB로 분리하고 marker-bound app(NOBYPASSRLS)·worker/relay(BYPASSRLS) role, per-run #agent-lab UUID, demo/Hermes·approval/cost fixture를 자체 seed한다.
- source dogfood DB의 로그인/초대/채널/멤버십/메시지/agent queue 관련 digest를 EXIT trap에서 성공·실패 전후 비교하고, exact OID+marker DB와 marker-bound role만 fail-closed 정리한다. pre-marker COMMENT 실패(exit 96) rollback 회귀를 `macos-ui`에 추가했다.
- worker 검증은 DB/Docker/verifier 접속 없이 수정·신규 shell의 `bash -n` PASS. fresh login/invite/join/member/send/mention→agent_job/history와 clean/root `macos-ui` evidence는 오케스트레이터가 merge 전 수행 대기(`runtime-unverified`).

## MOMO-342 AgentWorker Persistent DB Fixture Hardening (2026-07-11)

- MOMO-338 merge 후 root main의 오래 유지된 DB에서 사용자가 제거한 Hermes channel membership 때문에 `verify_agent_worker.sh`의 positive mention route가 run 없이 끝나는 main gate 간섭을 확인했다. 제품 runtime 회귀가 아니라 migration seed가 영구히 유지된다고 가정한 verifier 결함이었다.
- verifier runtime 전체를 source DB와 물리적으로 분리된 migration DB 및 deterministic 전용 workspace/human/channel/agent/member/membership/budget으로 분리했다. DB와 app/relay/worker role은 generation marker 소유권을 fail-closed 검증하고, source/system/unmarked DB는 거부한다. server/relay/worker가 모두 같은 `POSTGRES_HOST`의 verifier DB와 marker-bound role만 바라보므로 전역 claim consumer도 user-owned queue를 가져갈 수 없다.
- cleanup은 exact client message에서 유도한 run/message만 정리하고 UUID JSON 비교를 정규화한다. DB generation marker에서 fixture UUID를 파생해 DB 재생성 후 Centrifugo version stream과도 충돌하지 않는다. unrelated message/pending job sentinel, 비-fixture membership digest, user-owned Hermes digest를 전후 비교하며 `runtime-agent` gate가 같은 verifier DB에서 두 번 실행한다. MomoServer는 사전 build한 executable을 직접 실행해 SwiftPM planning lock이 health timeout으로 오인되는 경로도 제거했다.
- 검증: 같은 persistent verifier DB에서 `scripts/verify_agent_worker.sh` 연속 2회 PASS. 두 실행 모두 REST mention route, SSE/tool progress, final outbox publish, 비용 reserve/reconcile, approval resume, budget circuit breaker, G1/G2/G3/depth guard와 프로세스 cleanup을 닫았고 source database는 untouched로 보고됐다.

### MOMO-343 fresh DB marker bootstrap 후속

- PR #315 merge 후 root main의 새 verifier DB 생성 분기에서 psql `-c`가 `:'marker'`를 치환하지 않아 syntax error가 났다. 기존 verifier DB를 재사용한 worktree gate에서는 생성 분기가 실행되지 않아 놓친 bootstrap 회귀다.
- marker COMMENT를 psql stdin SQL로 옮기고, 새 DB 생성부터 marker/migration/전용 role bootstrap 완료 전까지 실패하면 exact generation marker를 재확인한 verifier DB와 동일 marker의 전용 role만 정리하도록 lifecycle guard를 추가했다. role bootstrap은 트랜잭션이며 기존 unmarked/source/system DB의 fail-closed 경계는 유지한다.
- fresh worktree의 Swift dependency materialization이 health timeout에 포함되던 경로도 확인해 server/relay/worker 바이너리를 동기적으로 먼저 build한 뒤 process timeout을 시작하도록 분리했다.

### MOMO-344 context verifier DB 격리

- MOMO-343 merge 후 root `runtime-agent`에서 context verifier Worker가 source dogfood DB의 unrelated pending `resume_approval`을 먼저 claim하는 격리 결함을 확인했다.
- context verifier는 이제 매 실행마다 별도 migrated DB와 marker-bound app/worker role을 사용하고, source DB의 agent queue/run/approval/message digest를 전후 비교한다. cleanup은 exact DB OID+marker와 role marker가 일치할 때만 수행한다.
- 2026-07-11 PR #319 merge (`0b2c94a`). worktree clean runtime-agent gate PASS, root post-merge에서 MOMO-344 범위 verifier 전부 PASS + source digest 보존 확인.
- root post-merge full gate에서 두 가지 선재 문제를 발견했다: ① `verify_agent_live_channel.sh`가 dogfood DB의 demo 시드 상태(agent `…102`의 채널 `…202` 멤버십, 2026-07-08 left_at 처리됨)에 의존해 authorized observer 케이스가 403으로 실패 → MOMO-345 `#320` 발급. ② momo_main Centrifugo 컨테이너가 MOMO-338 이전 config로 기동된 채 남아 `agent:` 3-파트 regex/`agentwork:` namespace가 없었음 → 컨테이너 재시작으로 해소, running-config drift guard는 후속 티켓 제안.

### MOMO-345 live channel verifier DB 격리

- live channel verifier를 매 실행마다 생성하는 marker/OID-owned migrated DB로 분리하고, marker-bound app(NOBYPASSRLS)·worker/relay(BYPASSRLS) role과 deterministic authorized/unauthorized fixture를 연결했다. source dogfood DB는 agent queue/run/approval/message 관련 digest 전후 비교만 수행한다.
- pre-marker COMMENT 실패 시 exact OID DB만 롤백하는 bootstrap 회귀를 `runtime-agent`에 추가했다.
- 2026-07-11 오케스트레이터 검증 완료 후 PR #321 merge (`5854c2f`): worktree clean runtime-agent gate full PASS, root post-merge에서 live channel verifier가 drift 있는 dogfood DB 위에서 PASS + source digest 보존 실증.
- root post-merge full gate는 다음 선재 결함에서 중단: `verify_local_hermes_bridge.sh`(엔진 `verify_external_agent_provider.sh`)가 dogfood DB의 Hermes(`…103`) #agent-lab 멤버십(2026-07-08 left_at drift)을 전제하고 roundtrip에서 dogfood 채널에 실제 메시지를 작성한다. `verify_hermes_gateway_adapter.sh`도 shared DB 사용 → 잔여 두 갈래를 MOMO-346 `#322`로 발급 (캐스케이드 종결 티켓).

### MOMO-346 Hermes bridge/gateway verifier DB 격리

- external-provider 엔진과 local bridge wrapper를 매 실행 unique marker/OID-owned migrated DB로 분리하고 marker-bound app(NOBYPASSRLS)·worker/relay(BYPASSRLS) role 및 Hermes/#agent-lab fixture를 연결했다. gateway verifier도 별도 fresh DB와 marker-bound app role을 사용한다.
- 두 경로 모두 source dogfood DB의 agent queue/run/approval/message 관련 digest를 EXIT trap에서 성공/실패 전후 비교하고, exact OID+marker DB 및 marker-bound role만 fail-closed 정리한다. external/gateway pre-marker COMMENT 실패(exit 96) rollback 회귀를 `runtime-agent`에 추가했다.
- worker 검증은 DB/Docker/verifier 접속 없이 수정·신규 shell의 `bash -n`만 PASS. invite/roundtrip/bearer assertions, 성공·실패 digest 및 clean/root `runtime-agent` evidence는 오케스트레이터가 merge 전 수행 대기(`runtime-unverified`).
- 2026-07-12 오케스트레이터 검수에서 순서 의존 결함 2건을 규명·수정: ① relay가 `version=message.seq`를 전달하는데 격리 DB는 seq를 리셋하고 채널명이 고정이라, 공유 Centrifugo가 이전 verifier 세션의 저장 version과 비교해 **성공 응답을 주면서 조용히 drop**(stale skip, TTL 없음) → per-run 채널 UUID로 수정(worker resume). ② per-run UUID 도입 후 서버(Swift UUID, 대문자)와 verifier(python, 소문자)의 채널명 케이스 불일치 → `CENT_CHANNEL` 대문자 정규화(오케스트레이터). 고정 fixture UUID(숫자만)에서는 둘 다 잠복 불가능했던 결함.
- PR #326 merge (`beceaa1`). worktree clean full gate PASS + **root main post-merge runtime-agent full gate PASS** (`local-gate-runtime-agent-20260711T155410Z-…-re2f9b4903131.md`, 4-verifier source digest 보존) — **verifier 격리 캐스케이드(MOMO-342→346) 종결**. 잔여는 macos-ui 프로파일의 MOMO-348.

## 0-2. MOMO-186 Deterministic E2E Compose Stack (2026-06-29)

- `infra/docker-compose.e2e.yml`을 추가해 local gate 전용 api/relay/worker/mock-Hermes/PostgreSQL 18/Centrifugo v6 경계를 dev compose 및 prod compose와 분리했다. e2e는 source checkout + local Swift build를 허용하고, prod는 계속 image-based/source-checkout-free 계약을 유지한다.
- `infra/e2e/bootstrap_roles.sql`은 api=`momo_app`(NOBYPASSRLS), relay=`momo_relay`/worker=`momo_worker`(BYPASSRLS) test role boundary를 deterministic하게 준비한다. 실제 e2e stack boot/full runtime path는 후속 verifier에서 닫고, 이번 goal은 compose config/static validation 범위다.
- 검증: `docker compose --env-file .env.worktree -f infra/docker-compose.e2e.yml config` PASS. `scripts/local_gate.sh --profile docs`에 e2e compose config validation을 연결했다.

## 0-3. MOMO-216 Internal Single-Node Hosting Smoke Gate (2026-06-30)

- `infra/prod/docker-compose.internal-smoke.yml`과 `infra/prod/internal-smoke.env.example`을 추가해 prod compose의 image-based api/relay/worker 계약을 유지하면서 내부 테스트용 single-node smoke override를 제공한다.
- `scripts/verify_internal_hosting_smoke.sh`를 추가하고 `scripts/local_gate.sh --profile staging-smoke`에 연결했다. 이 verifier는 compose config, env template guard, Caddy/TLS static wiring, Centrifugo Redis engine, explicit migration path, MomoServer `/health` route, relay/worker enablement, pgBackRest placeholder boundary를 검증한다.
- 실제 public DNS/TLS, registry image pull/run, SOPS production secret injection, pgBackRest backup/PITR restore rehearsal은 `runtime-unverified(public TLS/DNS)` host-runtime으로 남는다. 검증: `scripts/local_gate.sh --profile staging-smoke` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.

## 0-3. MOMO-220 Internal Host-Runtime Smoke v0 (2026-06-30)

- `infra/prod/docker/`에 internal smoke용 Swift service/migrate/mock-Hermes Dockerfile을 추가해 prod compose의 source-checkout-free image boundary를 유지하면서 local image build path를 고정했다.
- `scripts/verify_internal_host_runtime.sh`와 `scripts/local_gate.sh --profile host-runtime`을 추가했다. 이 gate는 local api/relay/worker/migrate/mock-Hermes image build, prod+internal-smoke boot, migration one-shot+idempotency, `/health`, REST login/message send, relay publish, mock Hermes `@김인턴` 왕복을 실제 compose stack에서 검증한다.
- Public DNS/TLS, real registry pull, SOPS production secret injection, pgBackRest PITR restore rehearsal은 계속 `runtime-unverified(public host)`로 남는다. 검증: `scripts/local_gate.sh --profile host-runtime` 및 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상.

## 0-3a. MOMO-221 Production Secret/Bootstrap Hardening v0 (2026-06-30)

- `scripts/prod_env_preflight.sh`를 추가해 `staging`/`prod`/`internal-host` env에서 `change-me-*`, `dev-insecure-*`, `example.com`, `localhost`, `mock-hermes`, local DB password, `internal-smoke`/`latest` image tag를 fail-fast로 거부한다.
- `internal-smoke`/`local` 모드는 `infra/prod/internal-smoke.env.example`와 verifier-generated temp env에서만 허용되는 placeholder 경계로 고정했다. `verify_staging_smoke`, `verify_internal_hosting_smoke`, `verify_internal_host_runtime`이 같은 preflight를 호출한다.
- `docs/RUN.md`, `docs/DEPLOY.md`, `docs/SECRETS_BACKUP_RUNBOOK.md`에 required env, secret generation/import path, SOPS `exec-env` preflight, operator checklist를 반영했다. Public DNS/TLS, real registry pull, real SOPS secret injection, pgBackRest PITR restore rehearsal은 계속 `runtime-unverified(public host)`다.
- 검증: `scripts/local_gate.sh --profile docs` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS, `scripts/local_gate.sh --profile staging-smoke` PASS. Sandbox 제한으로 최초 Swift gate는 `.build`/clang cache 쓰기에서 실패했고, 동일 명령을 승인된 환경에서 재실행해 PASS했다.

## 0-4. MOMO-222 Backup/PITR Restore Rehearsal Gate v0 (2026-06-30)

- `scripts/verify_backup_restore_rehearsal.sh`와 `scripts/local_gate.sh --profile backup`을 추가했다. Repo-local gate는 임시 PostgreSQL 18 source container에서 marker write → `pg_dump -Fc` → 별도 restore container `pg_restore` → marker fingerprint equality를 검증하고 markdown/json evidence를 생성한다.
- `host-runtime` profile에도 같은 restore rehearsal verifier를 포함해 내부 테스트 호스팅 전 "복원 리허설 evidence 없는 백업은 검증된 백업이 아님"을 local/host-runtime 계약으로 고정했다.
- 실제 production pgBackRest stanza/check/full backup, WAL archive push, SOPS decrypt, object-store repository, time-target PITR restore rehearsal은 계속 `runtime-unverified(public host)`다. 검증: `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift`, `scripts/local_gate.sh --profile backup` 대상.

## 0-4a. MOMO-227 Kim Intern Runtime Config + Health Visibility v0 (2026-07-01)

- `AGENT_PROVIDER_MODE`를 `local-mock` / `internal-host-mock` / `external-hermes` 계약으로 문서화하고, MomoServer·AgentWorker가 staging/prod/internal-host에서 unsafe/missing external Hermes config를 fail-fast 처리하도록 정렬했다.
- `/health`와 read-only `/v1/agent-runtime/status`가 secret-redacted Kim Intern provider mode/availability/status projection을 반환한다. token/key 원문은 logs, diagnostics, status response에 노출하지 않는다.
- macOS sidebar Local AI section에 compact Kim Intern availability surface를 추가해 사용자가 agent path의 `available`/`degraded`/`mock`/`unknown` 상태를 볼 수 있게 했다. internal host-runtime verifier는 `internal-host-mock`/`mock` status projection과 secret non-leak를 검사한다.
- Real external provider side effect evidence는 실제 credentialed provider host에서 닫아야 하므로 계속 `runtime-unverified(external provider host)`다. 검증: `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift`, `scripts/local_gate.sh --profile host-runtime` 대상.

## 0-4b. MOMO-230 External Kim Intern/Hermes Provider Smoke Gate v0 (2026-07-01)

- `scripts/verify_external_agent_provider.sh`와 `scripts/local_gate.sh --profile external-agent-provider`를 추가했다. 기본 local/mock 환경에서는 Docker/provider side effect를 실행하지 않고 `runtime-unverified(external provider credentials)` evidence로 explicit skip한다.
- `AGENT_PROVIDER_MODE=external-hermes`와 non-placeholder `HERMES_BASE_URL=https://.../v1`, `HERMES_API_KEY`가 있는 환경에서는 OpenAI-compatible SSE preflight, local MomoServer/AgentWorker/OutboxRelay boot, `/v1/agent-runtime/status` redacted availability, `@김인턴` 1왕복을 검증한다.
- verifier evidence는 redacted artifact만 참조하며 `HERMES_API_KEY`, bearer token, DB password, app token 원문을 stdout/evidence에 남기지 않는다. 실제 provider credential이 이 환경에 없으면 real provider side effect는 계속 `runtime-unverified(external provider credentials)`다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS, `scripts/local_gate.sh --profile external-agent-provider` PASS(no-credential explicit skip). Credentialed real provider PASS는 아직 `runtime-unverified(external provider credentials)`.

## 0-4b-1. MOMO-236 Hermes Internal Alpha Invite Smoke v0 (2026-07-01)

- 내부 알파에서 "김인턴 초대됨"을 provider 연결과 분리해 고정했다: seeded/admin path는 active `member.kind='agent'` + display name `김인턴` + handle `kim-intern` + `#agent-lab` active channel membership이고, 사람 `/v1/join` invite code가 아니라 channel membership API/admin UI로 기존 agent member를 초대한다.
- `scripts/verify_external_agent_provider.sh` credentialed path가 real-provider `@김인턴` smoke 전에 Kim Intern active agent + `#agent-lab` membership precondition JSON evidence를 생성한다. no-credential path는 Docker/provider side effect 없이 explicit `runtime-unverified(external provider credentials)` skip PASS를 유지한다.
- `docs/INTERNAL_ALPHA.md`, `docs/RUN.md`, `docs/LOCAL_PR_GATE.md`, `ROADMAP.md`, `BUILD_TICKETS.md`에 mock/internal-host와 credentialed real-provider-required 경계, macOS/API status visibility, smoke 절차를 반영했다. 실제 credentialed external runtime side effect는 credential 없는 환경에서는 계속 `runtime-unverified(external provider credentials)`다.
- 검증: `scripts/local_gate.sh --profile external-agent-provider` PASS(no-credential explicit skip, evidence `/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-external-agent-provider-20260701T070401Z-pid82381-ns1782889441663040000-wt1f57f61d7b34-rf512aebfd297.md`), `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS(evidence `/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-swift-20260701T070421Z-pid86990-ns1782889461792630000-wt1f57f61d7b34-r0fa3cd968c72.md`).

## 0-4b-2. MOMO-234 Hermes Codex OAuth Provider Boundary v0 (2026-07-01)

- `docs/adr/0004-codex-oauth-hermes-provider-boundary.md`를 추가해 Codex OAuth access/refresh token은 external runtime provider 소유이고 momo app/API/DB/Context Packet/Memory/diagnostics/local gate가 직접 보관하지 않는다는 credential boundary를 정본화했다.
- `scripts/verify_external_agent_provider.sh`는 credentialed smoke에 필요한 momo-side env를 `AGENT_PROVIDER_MODE=external-hermes`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `AGENT_MODEL`로 명확히 출력하고, 알려진 Codex/OpenAI OAuth token env var가 momo smoke process에 있으면 fail-fast한다. secret 없는 기본 경로는 계속 safe skip/pass로 `runtime-unverified(external provider credentials)` evidence를 남긴다.
- 실제 Codex OAuth-backed provider credentialed PASS는 provider host secret이 있는 환경에서만 닫을 수 있으므로 계속 `runtime-unverified(external provider credentials)`다. 검증: `scripts/local_gate.sh --profile external-agent-provider` PASS(no-credential explicit skip), `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상.

## 0-4b-3. MOMO-238 Local Hermes GPT Provider Loopback Contract (2026-07-01)

- `docs/external-agent-provider/local-hermes-gpt.md`를 추가해 local Hermes + GPT provider 개발 루프는 `MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 AGENT_PROVIDER_MODE=external-hermes` opt-in일 때만 `http://127.0.0.1:<port>/v1` 또는 `http://localhost:<port>/v1`를 허용하도록 정리했다.
- MomoServer/AgentWorker/verifier가 non-loopback `http://...`, staging/prod/internal-host loopback, `mock-hermes`, placeholder Hermes bearer, Codex/OpenAI OAuth token/API key env를 fail-fast 처리한다. GPT/OpenAI credential은 Hermes local process/provider host 소유이며 momo app/API/DB/evidence에는 들어오지 않는다.
- credential 없는 기본 환경은 `scripts/local_gate.sh --profile external-agent-provider`에서 explicit `runtime-unverified(external provider credentials)` skip PASS를 유지한다. 검증: `scripts/local_gate.sh --profile docs`, `scripts/local_gate.sh --profile external-agent-provider`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상.

## 0-4b-4. MOMO-242 External Agent Runtime Smoke (2026-07-01)

- `docs/external-agent-provider/README.md`를 추가해 provider-neutral external agent runtime secret env, mock/local/external runtime 차이, credentialed smoke 명령, provider token/Codex OAuth/OpenAI key 비저장 boundary를 고정했다.
- `/v1/agent-runtime/status`와 macOS Kim Intern chip이 degraded 상태에서 redacted `degradedReason`을 노출한다. `scripts/verify_external_agent_provider.sh`는 credentialed PASS에서 `degradedReason`이 비어 있음을 확인한다.
- `scripts/local_alpha_runner.sh execute --hermes external --external-smoke --secret-env <outside-repo-env>`가 기존 `external-agent-provider` verifier로 위임해 `channel message -> agent run -> external runtime call -> durable agent response` smoke를 실행할 수 있게 했다. Credentialed real provider side effect는 이 환경에 provider secret이 없으면 계속 `runtime-unverified(external provider credentials)`다. 검증: `scripts/local_gate.sh --profile docs` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.

## 0-4b-5. MOMO-256 Local Hermes Agent Bridge v0 (2026-07-02)

- `server/Migrations/006_local_hermes_agent_seed.sql`로 내부 알파 기본 agent member를 `member.kind='agent'`, display name `Hermes`, handle `hermes`, membership `#general`/`#agent-lab`로 seed한다. 기존 Kim Intern 시드는 backward-compatible fixture로 남기고, dogfood 기본 호출명은 `@hermes`다.
- MomoServer/AgentWorker/macOS 기본 agent runtime config를 Hermes 중심으로 정렬했다. `MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 AGENT_PROVIDER_MODE=external-hermes`일 때만 loopback OpenAI-compatible endpoint를 허용하며, non-loopback HTTP와 provider/Codex/OpenAI credential leakage fail-closed 경계는 유지한다.
- `scripts/verify_local_hermes_bridge.sh`를 추가해 repo-local mock Hermes provider fallback으로 `@hermes` mention -> `agent_job` -> AgentWorker SSE -> usage ledger/reserve -> durable channel response -> relay history를 검증한다. 실제 local Hermes/GPT provider는 같은 env contract에 endpoint/token을 꽂아 검증하고, mock fallback과 별도 evidence로 구분한다.
- AgentWorker provider 실패가 반복되면 같은 channel timeline에 사람이 읽을 수 있는 degraded Hermes error message를 남긴다. macOS 앱은 roster/command center/demo fallback에서 `@hermes` alias를 기본으로 삽입하고 표시한다.

## 0-4b-6. MOMO-257 Local Hermes/Codex OAuth Provider Setup (2026-07-02)

- `docs/external-agent-provider/local-hermes-codex-oauth-setup.md`와 placeholder-only `local-hermes-provider.env.example`를 추가해 사용자가 local Hermes-compatible provider에서 Codex/OpenAI OAuth 또는 provider token 설정을 직접 수행하고, momo는 loopback `HERMES_BASE_URL` + Hermes-facing bearer만 받아 검증하는 경계를 고정했다.
- `scripts/verify_local_hermes_credentialed_smoke.sh`를 추가해 기본 실행은 `NEEDS_USER_CREDENTIAL` evidence로 안전하게 종료하고, out-of-repo env 파일 또는 inline momo-facing endpoint/key가 있으면 기존 external-provider verifier로 위임해 `@hermes` credentialed roundtrip을 검증한다. 알려진 Codex/OpenAI OAuth/API key env가 momo smoke process에 있으면 fail-fast한다.
- macOS Alpha Command Center에 `Provider Setup` 상태, `Connect real local Hermes` 체크리스트, provider credential boundary capability를 추가했다. 실제 provider login/token 입력은 사람이 provider에서 수행해야 하며, 이 환경의 real credentialed provider PASS는 사용자가 런타임을 띄운 뒤 별도 evidence로 닫는다.
- 검증: `scripts/local_gate.sh --profile external-agent-provider` PASS(`NEEDS_USER_CREDENTIAL` no-secret path), `scripts/local_gate.sh --profile runtime-agent` PASS(mock/local Hermes bridge), `scripts/local_gate.sh --profile macos-ui` PASS, `LOCAL_GATE_LAUNCH_UI=1 scripts/verify_macos_real_backend_ui.sh` PASS(window_count=1). 실제 Codex/OAuth credentialed provider PASS는 사용자가 provider 로그인/env를 준비한 뒤 `scripts/verify_local_hermes_credentialed_smoke.sh`로 닫는다.

## 0-4b-6a. LSA-005 Local Hermes operator helper (2026-07-07)

- MOMO-257의 credentialed Hermes boundary/runbook/verifier는 존재하지만, 실제 1인 dogfood 사용자는 out-of-repo env 생성, placeholder 확인, 금지된 OpenAI/Codex provider credential env 확인, smoke 실행 순서를 기억해야 했다. 이 후속은 사용자가 provider login 이후 momo에서 무엇을 해야 하는지 CLI가 바로 안내하게 만든다.
- `scripts/momo`에 `hermes`/`hermes-status`, `hermes-init`, `hermes-smoke` 명령을 추가했다. `hermes-init`은 `~/.momo/local-hermes-provider.env`를 safe template에서 만들고 `chmod 600`을 적용한다. `hermes`는 env file path, file mode, provider mode/model, query/fragment가 제거된 endpoint label, Hermes-facing bearer configured 여부, 현재 shell의 금지된 OpenAI/Codex credential env 존재 여부, local MomoServer `/v1/agent-runtime/status` 요약을 보여준다. secret 값은 출력하지 않는다.
- 검증: `bash -n scripts/momo` PASS. `/private/tmp` 임시 env로 `scripts/momo hermes-init` → `scripts/momo hermes`가 placeholder를 secret 없이 표시하고, `OPENAI_API_KEY`가 현재 shell에 있을 때 boundary FAIL을 표시하는 것을 확인했다. 실제 credentialed provider PASS는 사용자가 provider login/env를 준비한 뒤 `scripts/momo hermes-smoke`로 닫는다.

## 0-4b-6b. MOMO-325 Hermes Gateway Native Platform Integration v1 (2026-07-07)

- AgentWorker SSE 경로를 유지하면서, `AGENT_GATEWAY_MODE=gateway`일 때 Hermes gateway가 momo를 Slack/Telegram-style messaging platform으로 보고 `agent.job` realtime event를 받아 처리하는 native path를 추가했다. `AgentWorker`는 `outbox.method='gateway'` job을 claim하지 않으며, final response/usage/audit는 gateway callback을 받은 MomoServer가 REST→Postgres→outbox 경로로만 기록한다.
- 새 public callback route는 `POST /v1/workspaces/:workspace/agent-runs/:run/gateway/events`와 `/gateway/complete`이며, `X-Momo-Agent-Gateway-Secret` 없이는 401 fail-closed다. Gateway completion은 durable channel message, `usage_ledger`, `audit_log(agent.gateway.*)`, channel broadcast outbox, gateway job `done`을 같은 DB transaction에서 정리한다.
- `adapters/hermes/PLUGIN.yaml`, `adapter.py`, `momo_adapter.py`를 최신 Hermes plugin path에 맞춰 정렬하고 `register(ctx)`/legacy `register_platform`을 모두 제공한다. `scripts/momo hermes-gateway-init/status/smoke`와 `scripts/verify_hermes_gateway_adapter.sh`는 local pairing env, status check, mock gateway harness를 제공한다.
- 검증: `swift build --package-path server` PASS, `swift build --package-path workers/AgentWorker` PASS, `python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS, `scripts/verify_hermes_gateway_adapter.sh` PASS(mock gateway; `@hermes`→`agent_run`→`agent_job(method=gateway)`→`agent.job` outbox→secret 401 guard→gateway callbacks→durable message/usage/audit/job done). 실제 Hermes gateway CLI/plugin load와 provider side effect는 `runtime-unverified(real hermes gateway missing)`로 남는다.

## 0-4b-6c. MOMO-326 Real Hermes Gateway Credentialed Smoke Prep (2026-07-07)

- 실제 Hermes gateway 런타임을 대상으로 한 설치/플러그인/credentialed smoke 레이어를 추가했다. `scripts/momo hermes-gateway-install-plugin`은 `adapters/hermes/`를 로컬 Hermes plugin directory(`$HERMES_HOME/plugins/momo`)에 symlink/copy하고, `scripts/momo hermes-gateway-smoke --real [--trigger]`는 Hermes CLI, plugin load files, 사용자 provider OAuth/login marker, momo gateway-mode `/health`, `@hermes` same-channel response를 단계별 evidence로 분리한다.
- `adapters/hermes/plugin.yaml`을 Hermes 공식 platform manifest 형태(`kind: platform`, `requires_env`, `optional_env`)로 정렬했고, `momo_adapter.py`는 최신 `gateway.platforms.base.BasePlatformAdapter(config, platform)` 경로와 legacy registry를 모두 지원한다. MOMO-338에서 operator login을 제거하고 per-agent bearer로 private `agentwork:ws<workspace>.<agentMember>`를 구독하도록 대체했다.
- 검증: `python3 -m py_compile adapters/hermes/momo_adapter.py adapters/hermes/adapter.py` PASS, `python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS, `bash -n scripts/momo scripts/verify_hermes_gateway_real_smoke.sh` PASS, `scripts/momo hermes-gateway-smoke --real` PASS with evidence state `NEEDS_USER_INSTALL`, `scripts/local_gate.sh --profile docs` PASS, `scripts/local_gate.sh --profile runtime-agent` PASS (`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-runtime-agent-20260707T115936Z-pid70974-ns1783425576779580000-wt9a510db2fbf3-ra293c905ef49.md`). 이 머신에는 아직 Hermes CLI가 없어 실제 provider OAuth 및 `@hermes` real gateway roundtrip은 `runtime-unverified(real hermes gateway missing; user install/login required)`로 남는다.

## 0-4b-6d. MOMO-327 Hermes v0.18 plugin load compatibility (2026-07-07)

- 실제 Hermes Agent v0.18 CLI-only 설치 후 user-installed directory plugin은 `~/.hermes/plugins/momo` 파일 링크만으로는 로드되지 않고 `~/.hermes/config.yaml`의 `plugins.enabled`에 `momo`가 있어야 함을 확인했다. `scripts/momo hermes-gateway-install-plugin`이 symlink/copy 후 config enable까지 수행하고, `scripts/momo hermes-gateway-status`가 plugin enabled 여부를 표시하도록 보강했다.
- Hermes v0.18 `BasePlatformAdapter`가 `get_chat_info(chat_id)`를 필수 추상 메서드로 요구해 momo adapter construction이 실패하던 문제를 수정했다. `MomoAdapter.get_chat_info`는 로그인 후 momo REST channel list에서 이름/타입을 조회하고, gateway boot/degraded smoke에서는 env/default fallback으로 fail-open 대신 platform construction을 유지한다.
- 검증: `python3 -m py_compile adapters/hermes/__init__.py adapters/hermes/momo_adapter.py adapters/hermes/adapter.py adapters/hermes/tests/test_momo_adapter_contract.py` PASS, `python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS(11 tests), `bash -n scripts/momo` PASS, `scripts/momo hermes-gateway-install-plugin && scripts/momo hermes-gateway-status` PASS(`plugin enabled: yes`, momo server reachable), `scripts/momo hermes-gateway-smoke --real` PASS with evidence state `NEEDS_PROVIDER_LOGIN`(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-hermes-gateway-real/20260707T150741Z/summary.md`). 실제 provider OAuth 및 `@hermes` real gateway roundtrip은 사용자가 Hermes/provider login을 완료한 뒤 닫는다.

## 0-4b-6f. MOMO-334 Dogfood Hermes Invite Roster UX v0 (2026-07-08)

- macOS dogfood UI에서 Hermes가 앱 최초 진입부터 자동 초대된 것처럼 보이지 않도록 `@hermes` 서버/fixture member를 초대 전에는 숨기고, 멤버 `+` → 사람/에이전트 초대 분기 → 에이전트 초대 완료 후 roster/channel member에 표시되는 흐름으로 바꿨다.
- 에이전트 초대 팝오버는 Hermes display name, alias, endpoint label, local avatar, pairing status를 dogfood v0 수준으로 관리한다. 프로필 저장 후 roster row는 프로필 이미지와 presence badge를 표시하며, `@hermes` mention은 기존 MOMO-333/MOMO-325 real gateway path를 그대로 사용한다.
- 기존 Kim Intern/buildbot/mock fixture는 기본 dogfood roster에서 숨기고 dev tools/diagnostics 경계로 밀었다. 서버의 Hermes agent seed/runtime contract는 유지하되, 사용자가 초대하기 전에는 제품 UI에서 “이미 초대됨”으로 보이지 않는다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS(63 tests), `scripts/local_gate.sh --profile docs` PASS, `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui` PASS.

## 0-4b-6e. MOMO-328 Local launcher login readiness hotfix (2026-07-08)

- 로그인 버튼이 `internal server error`를 보인 원인은 7월 3일에 뜬 오래된 host-run `MomoServer`가 `:28180`을 계속 점유한 상태에서 `/health`만 200을 반환하고, DB-backed `/v1/auth/login`은 Postgres connection timeout으로 500을 내던 것이다. `scripts/momo start`가 `/health`만 보고 ready로 판단해 stale server를 정상으로 착각했다.
- `scripts/momo`가 local alpha ready 판정에 `/health` + demo login/logout smoke를 함께 사용하도록 바꿨다. `/health`는 되지만 login smoke가 실패하면 stale/degraded server로 보고 restart path를 탄다. credentialed smoke는 기본적으로 loopback base URL에서만 수행하고, 성공 직후 `/v1/auth/logout`으로 발급된 토큰을 revoke한다. `scripts/momo stop/stop-stack`은 configured API port의 현재 repo 내부 `MomoServer` listener만 안전하게 종료하도록 보강했다.
- 검증: `bash -n scripts/momo` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS. 실제 dogfood operator는 `scripts/momo stop && scripts/momo start`를 다시 실행하면 stale 28180 listener가 정리되고 로그인 smoke를 통과한 서버만 ready로 간주된다.

## 0-4b-6f. MOMO-329 Local alpha gateway mode env passthrough hotfix (2026-07-08)

- `AGENT_GATEWAY_MODE=gateway AGENT_GATEWAY_SECRET=... scripts/momo up`로 실행해도 `/v1/agent-runtime/status`가 계속 `local-mock`으로 뜨던 원인을 확인했다. `scripts/momo`까지는 env를 받았지만, `scripts/local_alpha_runner.sh`가 host-run `MomoServer`를 시작할 때 explicit `env ... swift run` allowlist에 `AGENT_GATEWAY_MODE`/`AGENT_GATEWAY_SECRET`을 넣지 않아 서버 프로세스가 gateway mode를 보지 못했다.
- `local_alpha_runner`가 gateway mode/secret을 로드·export·redacted summary 기록·MomoServer env 주입까지 전달하도록 수정했다. provider OAuth/Codex/OpenAI token은 여전히 momo env에 전달하지 않고, 이 secret은 momo↔Hermes gateway callback 인증용이다.
- 검증: `bash -n scripts/local_alpha_runner.sh` 대상. 실제 operator는 `scripts/momo stop-stack` 후 `AGENT_GATEWAY_MODE=gateway AGENT_GATEWAY_SECRET="$MOMO_AGENT_GATEWAY_SECRET" scripts/momo up`를 다시 실행하면 `agentRuntime.mode=gateway`를 확인할 수 있어야 한다.

## 0-4b-6g. MOMO-330 Agent runtime status gateway delivery hotfix (2026-07-08)

- MOMO-329 후 MomoServer 실행 env에는 `AGENT_GATEWAY_MODE=gateway`가 들어갔지만, `/health`와 `/v1/agent-runtime/status`가 `AgentProviderConfig`만 반환해 실제 gateway delivery path를 `local-mock`처럼 보이게 했다. 이는 real Hermes gateway 연결 단계에서 운영자가 잘못된 경로를 보고 있다고 판단하게 만드는 상태 표시 버그다.
- `Config.agentRuntimeStatusResponse()`를 추가해 gateway mode에서는 `mode=gateway`, `endpointLabel=Hermes gateway platform adapter`, gateway callback secret configured/degraded 상태를 반환하도록 정리했다. worker/direct provider mode에서는 기존 provider status를 그대로 유지한다.
- 검증: `swift test --package-path server --filter MomoServerTests/testAgentRuntimeStatusReportsGatewayDeliveryModeWhenEnabled` PASS, `swift test --package-path clients/macOS --filter MomoMacTests/testRESTBackendLoadsGatewayRuntimeStatus` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-docs-20260707T162918Z-pid25103-ns1783441758419039000-wt9a510db2fbf3-rb493e10783f9.md`). 실제 gateway roundtrip은 사용자가 Hermes gateway 프로세스를 켠 뒤 `MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger`로 닫는다.

## 0-4b-6h. MOMO-331 Hermes adapter Centrifugo ping/pong hotfix (2026-07-08)

- 실제 `hermes gateway run`에서 momo platform adapter가 연결되고 `Gateway running with 1 platform(s)`까지 갔지만, 잠시 후 realtime listen loop가 Centrifugo close code `3012 no pong`으로 종료됐다. 원인은 adapter가 Centrifugo JSON protocol heartbeat frame을 push가 아니라는 이유로 무시해 server-side heartbeat에 응답하지 못한 것이다.
- `MomoAdapter._listen_loop()`가 빈 heartbeat frame에는 빈 pong command를, 명시적 `ping` frame에는 `{"pong": {}}`를 보내도록 수정했다. connect/subscribe ack와 publish push 처리는 그대로 유지한다.
- 검증: `python3 -m py_compile adapters/hermes/momo_adapter.py && python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS(12 tests), `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-docs-20260708T004604Z-pid62511-ns1783471564069844000-wt9a510db2fbf3-r90750a762add.md`). 실제 gateway roundtrip도 `MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger` PASS(`same-channel Hermes gateway response observed`, evidence `/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-hermes-gateway-real/20260708T005622Z/summary.md`).

## 0-4b-6i. MOMO-333 Local alpha Hermes gateway agent stream subscribe unblock (2026-07-08)

- 당시 실제 앱에서 `@hermes hi`를 보냈을 때 `message`와 `agent_job(method=gateway)` 생성, OutboxRelay publish까지는 성공했지만 stale local-alpha Centrifugo config 때문에 구독이 거부됐다. MOMO-333에서 최초 복구했고, MOMO-338은 private job을 `agentwork:ws<workspace>.<agentMember>`로 분리해 실제 agent-bearer WebSocket 수신까지 검증한다.
- `scripts/local_alpha_runner.sh`의 generated Centrifugo config를 `infra/centrifugo.json`과 맞춰 `agent` namespace도 `subscribe_proxy_enabled=true`와 workspace-qualified `channel_regex`를 갖도록 수정했다. `docs/RUN.md`와 Hermes gateway native platform runbook에는 local alpha에서도 `agent:` stream proxy가 필수라는 진단 기준을 추가했다.
- 검증: generated config 확인(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T/momo-local-alpha/20260708T033819Z/centrifugo.local-alpha.json`: `agent.subscribe_proxy_enabled=true`, regex `^ws...\\....$`), 서버 `GET /v1/agent-runtime/status` = `mode=gateway`, `docker logs momo240_72373-centrifugo-1`에서 `namespace=agent subscribe proxy enabled` 및 `agent:ws... permission denied` 없음. 사용자-owned Hermes gateway(`openai-codex gpt-5.5`, provider token은 momo에 저장/로그하지 않음) 연결 상태에서 `MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-hermes-gateway-real/20260708T034009Z/summary.md`). DB evidence: `outbox(kind=agent_job, method=gateway)=done`, `agent_run.status=succeeded`, `audit_log`에 `agent.gateway.status/completed`, `usage_ledger` 1건, Hermes final response가 같은 channel `message.seq=4`로 기록됨. 정적 gate: `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-docs-20260708T034450Z-pid17038-ns1783482290079413000-wt9a510db2fbf3-r5e9aa29fc209.md`).

## 0-4b-6j. MOMO-335 Mention Autocomplete + Hermes Working Indicator (2026-07-08)

- macOS composer에서 `@`를 입력하면 현재 선택 채널에 active membership이 있는 사람/에이전트 후보를 표시한다. 에이전트 후보는 위로 정렬되며, Hermes는 MOMO-334 초대/채널 멤버 등록 이후에만 후보로 나타난다.
- 후보 선택은 composer의 현재 `@...` token을 `@handle `로 치환한다. 기존 에이전트 직접 호출 버튼과 `@hermes` gateway path는 유지한다.
- `@hermes` 전송 직후 또는 `agent.status` running/thinking/streaming 이벤트 수신 시 Hermes working state를 켜고, 같은 channel timeline의 final agent message 또는 terminal/error 상태에서 해제한다. 멤버 row는 working presence badge와 `WORKING` chip을 표시한다. 전송 실패 시 connection error와 mention notice를 남겨 침묵하지 않는다.
- 검증: `swift test --package-path clients/macOS` PASS(65 tests). `macos-ui` local gate는 PR 최종 gate에서 실행한다.

## 0-4b-6k. MOMO-260 Workspace/Member/Agent Profile Settings v0 (2026-07-08)

- macOS 설정 레이어를 분리했다. 개인 profile footer의 `Settings`는 언어/appearance만 다루고, workspace/server 이름·아이콘·초대 정책 초안은 sidebar workspace header의 server settings inspector에서 관리한다.
- member/agent profile editor v0를 추가했다. roster의 멤버/에이전트 row에서 로컬 표시 이름, avatar image, presence badge draft를 편집할 수 있으며, 이미지는 `Application Support/momo/avatars/`로 복사하고 local path만 저장한다.
- Hermes는 기존 dogfood invite key와 profile draft를 동기화해 초대 후 `@hermes` 표시 이름/avatar/status가 roster와 mention 후보에 일관되게 반영된다. 김인턴/legacy fixture는 기존 숨김 정책을 유지한다.
- 서버 영속 workspace/profile API, object storage upload, full account settings는 후속 범위다. 이번 변경은 dogfood용 local display draft다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS(68 tests), `LOCAL_GATE_ALLOW_DIRTY=1 LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS(evidence: `local-gate-macos-ui-20260708T071921Z-pid13710-ns1783495161811154000-wtcc364397ce1e-r216c670d7444.md`). 코드리뷰에서 stale profile editor state, avatar decode/cache 비용, STATUS evidence 문구를 지적했고 `.id(member.id)`, avatar PNG normalization+cache, evidence 문구 갱신으로 반영했다.

## 0-4b-6l. MOMO-262 Agent Pairing Wizard v0 (2026-07-08)

- macOS 멤버 `+` → 에이전트 초대 흐름을 pairing wizard로 확장했다. 사용자는 `@hermes` alias, 표시 이름, local endpoint, model label, permission scope, avatar를 확인하고 Hermes를 현재 채널 roster에 추가한다.
- 앱은 pairing manifest와 invite code를 생성하고 copy/export affordance를 제공한다. manifest에는 momo-facing API/workspace/channel metadata, helper command, `$HOME/.momo/hermes-gateway.env:MOMO_AGENT_GATEWAY_SECRET` secret source만 들어가며 Codex/OpenAI OAuth token, refresh token, provider API key 값은 포함하지 않는다.
- endpoint policy는 loopback HTTP를 기본 허용하고, non-loopback `http://...`는 명시 opt-in 없이는 fail-closed guidance를 보여주며 초대/manifest copy/export를 막는다. userinfo/query/fragment가 붙은 credential-bearing endpoint는 reject하고 manifest에 토큰/API key shaped 값이 들어가지 않도록 테스트로 고정했다. 실제 provider OAuth/login은 계속 Hermes/provider runtime 내부에서 사용자가 수행한다.
- `@hermes` mention, working indicator, profile draft, Hermes gateway real path는 MOMO-333/MOMO-335/MOMO-260 계약을 유지한다. 실제 credentialed provider smoke는 user-owned Hermes/provider login 이후 `scripts/momo hermes-gateway-smoke --real --trigger`로 별도 evidence를 남긴다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS(72 tests), `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-agent` PASS(evidence: `local-gate-runtime-agent-20260708T080156Z-pid72693-ns1783497716611283000-wt6092ab556fc7-rf9116ebf5514.md`), `LOCAL_GATE_ALLOW_DIRTY=1 LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS(evidence: `local-gate-macos-ui-20260708T080507Z-pid91159-ns1783497907345665000-wt6092ab556fc7-r31e0192f5346.md`). 코드리뷰에서 endpoint secret leakage, blocked endpoint manifest export, unstable invite code, editable-but-unsupported custom alias를 지적했고 endpoint sanitization/draft persistence, copy/export gating, stable invite code, `@hermes` fixed alias로 반영했다.

## 0-4b-6m. MOMO-261 Approval/Command Center/Typing Activity UX (2026-07-08)

- macOS sidebar의 `승인 요청` 표기를 `에이전트 승인함` 의미로 정리하고, 승인함이 “에이전트가 외부 작업을 하기 전 확인이 필요한 요청”이라는 점을 앱 copy와 empty state에서 설명하게 했다. Approval cards의 approve/reject/risk/cost/delegation copy도 한국어/영어 localization 경로로 옮겼다.
- Command Center와 Approvals의 right inspector는 모호한 segmented debug switch 대신 현재 surface title/description과 관련 pane 이동 버튼을 보여준다. `#general`/`#agent-lab`은 채널 topic을 sidebar row에 표시해 일반 대화와 agent 실험 채널의 역할이 드러나게 했다.
- typing activity v0를 추가했다. composer 입력 중에는 현재 human member의 local typing indicator가 하단에 보이고, realtime typing delta도 `ChatViewModel` visible state로 반영된다. Agent working state는 기존 Hermes gateway/agent status path를 유지하면서 member row에 icon-only working badge와 tooltip을 보여준다. Production typing fanout은 후속 범위이며 현재는 local/demo fallback + backend hook 기반이다. 코드리뷰에서 REST fallback final reply 시 working badge가 남을 수 있는 점과 채널별 typing timeout이 서로 취소될 수 있는 점을 지적했고, history reconciliation + per-channel typing timeout으로 반영했다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS(75 tests), `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS(evidence: `local-gate-macos-ui-20260708T091923Z-pid13209-ns1783502363493497000-wt68ef6fc88556-r0ef6467b1a91.md`).

## 0-4b-7. MOMO-258 macOS UI Smoke Fixture Seq Hotfix (2026-07-02)

- MOMO-257 merge 후 reused local Docker DB에서 `scripts/local_gate.sh --profile macos-ui`가 실패했다. 원인은 `verify_macos_real_backend_ui.sh`가 approval/cost fixture message seq를 `205901`로 고정했고, 같은 channel의 `channel_seq`가 이미 더 높게 진행되어 최신 `messages?limit=20` history에 fixture가 보이지 않은 것이다.
- smoke fixture가 현재 `channel_seq`와 기존 message max를 기준으로 새 seq를 예약하도록 수정했다. 제품 runtime behavior 변경은 없고, repeated local gate/long-lived dogfood DB에서도 approval/cost structured props 검증이 안정적으로 유지되도록 한 test harness hotfix다.
- 검증: `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui` PASS, 같은 local DB에서 `scripts/verify_macos_real_backend_ui.sh` 재실행 PASS, `scripts/local_gate.sh --profile docs` PASS.

## 0-4b-8. MOMO-264 macOS Native Profile/Settings/Downloads UX (2026-07-03)

- macOS profile footer를 기술 세부 popover가 아니라 `Profile`, `Settings`, `Downloads`, `Updates` 우측 설정 surface로 이동하는 launcher로 정리했다. 프로필 편집은 표시 이름/프로필 이미지만 다루고, 언어/화면 모드/워크스페이스 표시/초대 정책은 별도 Settings surface로 분리했다.
- 서버 아이콘은 더 이상 텍스트 입력으로 편집하지 않고 이미지 선택/제거만 제공한다. 다운로드 surface는 다운로드 폴더 열기/변경과 update manifest 기반 이력/성공·실패 상태를 표시한다. Updates surface는 최신/업데이트 가능/설정 필요/실패 상태를 앱 chrome 다국어 문구로 표시한다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS. `macos-ui` launch smoke는 PR gate에서 최종 evidence로 닫는다.

## 0-4c. MOMO-229 Public Host Preflight + Deploy Evidence Packet v0 (2026-07-01)

- `scripts/prod_env_preflight.sh`를 보강해 public/staging strict mode에서 DNS/TLS env shape, pinned registry image tags, SOPS/age 또는 host-local secret source, DB/Redis named volume, pgBackRest stanza/check/full backup/WAL/PITR required env를 fail-fast로 검사한다.
- `--evidence-dir` 옵션이 secret 값을 redacted 처리한 `prod-env-preflight-<mode>.md`와 `.json`을 생성한다. `scripts/verify_staging_smoke.sh`는 tracked placeholder env의 expected fail과 synthetic public/staging env shape PASS evidence를 함께 검증한다.
- internal-smoke/local mode는 계속 `infra/prod/internal-smoke.env.example`의 localhost/mock/local image placeholder만 허용한다. 실제 public DNS/TLS, registry pull, SOPS decrypt, production pgBackRest stanza/check/full backup/WAL/PITR restore rehearsal은 계속 `runtime-unverified(public host)`다.
- 검증: `scripts/local_gate.sh --profile docs` 및 가능하면 `scripts/local_gate.sh --profile staging-smoke` 대상.

## 0-4d. MOMO-233 AWS Internal Alpha Stack v0 (2026-07-01)

- `docs/AWS_INTERNAL_ALPHA.md`를 추가해 1주일 팀 테스트용 AWS 최소/권장/분리 topology, Lightsail vs EC2 추천안, 비용 추정, 보안그룹, DNS/TLS, volume/backup/restore, image-based deploy/rollback을 고정했다.
- `infra/prod/aws-internal-alpha.env.example`와 `scripts/aws_internal_alpha_preflight.sh`를 추가하고 `scripts/local_gate.sh --profile docs`에 fixture preflight를 연결했다. 권장안은 EC2 `t4g.large` single-node + encrypted gp3 data volume + pgBackRest/S3 + EBS snapshot이다.
- 실제 AWS host creation, DNS propagation, Caddy ACME issuance, registry pull, SOPS decrypt, pgBackRest backup, EBS snapshot, PITR restore rehearsal은 계속 `runtime-unverified(aws-host)`다. 검증: `scripts/local_gate.sh --profile docs` 대상.

## 0-4e. MOMO-239 Local One-Person Alpha Gate + AWS Promotion Threshold (2026-07-01)

- `docs/INTERNAL_ALPHA.md`에 로컬 1인 dogfood 체크리스트를 추가해 login, channel load, message send/receive, invite/join, Kim Intern mention, restart/reconnect, diagnostics, feedback filing을 evidence 기반 PASS/FAIL로 판정하게 했다.
- AWS 승격은 `local gate PASS + 1인 soak + credentialed external agent runtime smoke + open P0/P1 0 + diagnostics evidence`가 모두 PASS일 때만 `AWS_READY`로 기록한다. no-credential `external-agent-provider` skip은 로컬 dogfood에는 허용되지만 AWS 승격은 막는다.
- `docs/AWS_INTERNAL_ALPHA.md`, `docs/LOCAL_PR_GATE.md`, `ROADMAP.md`, `BUILD_TICKETS.md`가 이 threshold를 참조하도록 갱신했다. 실제 AWS host creation/DNS/TLS/SOPS/registry/pgBackRest/PITR는 계속 `runtime-unverified(aws-host)`다. 검증: `scripts/local_gate.sh --profile docs` 대상.

## 0-4f. MOMO-245 Local Soak/Resource Monitor (2026-07-01)

- `scripts/local_soak_monitor.sh`를 추가해 72시간 local dogfood 동안 API/Centrifugo health, DB connectivity, outbox pending backlog, relay/worker status, Docker container/resource snapshot, disk free, macOS launch evidence를 repo 밖 evidence directory에 주기적으로 남길 수 있게 했다.
- `docs/INTERNAL_ALPHA.md`에 monitor 실행법, `summary.md` PASS/WARN/FAIL 판정, P0/P1 감지 기준, Docker Desktop CPU/memory/disk 권장값을 추가했다. AWS 승격은 실제 72h `PASS` summary 또는 모든 `WARN`의 follow-up 없이는 진행하지 않는다.
- 실제 72h soak 완료와 AWS monitoring/Prometheus/Grafana/Kubernetes는 out of scope다. 검증: `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상.

## 0-4g. MOMO-336 Local Solo Hermes Dogfood Start Gate (2026-07-08)

- MOMO-246/MOMO-252의 full 72h soak을 첫 로컬 1인 Hermes dogfood의 진입조건에서 내렸다. full 72h soak은 AWS/pre-production promotion evidence로 유지하되, 첫 local solo loop는 reduced start gate로 시작한다.
- PR #253은 momo-main review에서 merge하지 않고 닫았다. 이유는 host API/Centrifugo/Postgres 접근 실패를 Docker 내부 fallback PASS로 바꿀 수 있어 evidence 신뢰도를 떨어뜨리고, 현재 Hermes-native gateway local-solo 경로와도 stale했기 때문이다.
- `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`와 `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`는 이제 local stack, fresh login, Hermes invite, `@hermes` same-channel roundtrip PASS, working indicator, diagnostics/resource evidence, open P0/P1 0을 reduced start gate로 본다. readable failure는 `START_SOLO`가 아니라 `BLOCKED` 또는 `NEEDS_FIX` evidence로 남긴다.
- 남은 runtime-unverified: 실제 사용자가 provider-owned Hermes/Codex OAuth를 완료한 뒤 장시간 dogfood를 계속하는 것과 AWS host provisioning은 후속 실행/운영 단계다.

## 0-4h. MOMO-337 Agent bearer 인증 v1 서버 (2026-07-10)

- 기존 `token(kind='agent_bearer')` 스키마를 사용해 human admin 발급/목록/24h overlap 회전/폐기 API와 AuthMiddleware agent principal·4-scope fail-closed 검증을 추가했다. 원문은 1회 반환하고 DB에는 sha256만 저장한다.
- agent 명의 REST 메시지, realtime token, pending-job 폴백, gateway event/complete에 token actor binding과 `audit_log.via_token_id`를 강제했다. 공유 시크릿은 `MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1`인 이관 케이스에서만 deprecation 로그와 함께 수용한다.
- momo-main 보안/성능 리뷰에서 1회 토큰 응답에 `Cache-Control: no-store`/`Pragma: no-cache`, 토큰 `created_by` 발급자 추적, pending fallback의 `available_at <= now()` 예약 준수를 추가했다.
- 검증: `swift test --package-path server` PASS(47 tests), clean commit `cb47b54`에서 `scripts/local_gate.sh --profile runtime-agent` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-runtime-agent-20260710T000557Z-pid30082-ns1783641957942474000-wtec169ce4b610-r13a2e73e660f.md`). Hermes adapter의 bearer 단일화는 MOMO-338에서 이어받았고 페어링 UI는 MOMO-339 후속이다.

## 0-4i. MOMO-340 Planning Sync Authority + Compaction-Safe Context (2026-07-10)

- `docs/planning/CURRENT_STATE.md`와 `scripts/planning_context.sh`를 추가해 Fable/GPT 5.6 병렬 planning owner, Accepted/Proposed ADR, 구현 handoff, 다음 체크포인트를 컨텍스트 압축 뒤에도 repo에서 복원한다. `--github` 옵션은 live Issue/PR/worktree 보드를 붙이고 기본 실행은 네트워크 없이 동작한다.
- planning 계약을 제품 오너·planner·`momo-main`·Codex worker 4개 역할로 정리하고, 한 planning ID당 한 owner, `momo-main` 순차 통합, 기준 커밋이 있는 versioned handoff/supersede, 구현 deviation 환류를 고정했다. MOMO-337 완료 및 MOMO-338/339 ready 상태와 첫 accepted deviation을 반영했다.
- 검증: clean commit `adfa43c`에서 `scripts/local_gate.sh --profile docs` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. 제품 runtime 경계 변경은 없으며 ADR-0102 결정과 MOMO-338/339 구현은 후속이다.

## 0-4j. MOMO-338 Hermes Adapter Per-Agent Bearer 단일화 (2026-07-10)

- Hermes platform adapter의 human email/password 로그인, refresh token 보관, 전역 gateway shared-secret 헤더를 제거했다. 이제 `MOMO_AGENT_TOKEN` 하나가 realtime-token, private `agentwork:` stream, bounded pending recovery, gateway event/complete, agent message REST에 동일하게 쓰인다.
- pending endpoint는 connect/reconnect/publication-gap/realtime wake-up에서만 조회하며 idle polling loop는 없다. realtime payload를 직접 실행하지 않고 bearer-authenticated pending REST에서 Postgres-backed job을 재조회한다. realtime transport drop은 capped exponential backoff+jitter로 재연결하고, 취소·부분 재연결 실패는 listener/WS를 정리한다. 일시적 recovery 실패는 bounded retry하고, 401은 fail-closed로 재연결을 멈춘다.
- 보안/성능 리뷰에서 Context Packet이 user-visible `agent:` progress와 같은 stream에 섞인 문제와 채널 간 progress 노출 가능성을 발견했다. `agent:`는 이벤트가 발생한 정확한 채널의 멤버만 status/partial을 관찰하도록 channel id를 포함하고, `agentwork:`는 exact agent actor만 subscribe 가능하게 분리했다. connection JWT의 server-only `meta.token_id`를 발급 credential에 묶어 회전 후 폐기된 JWT가 다른 active bearer에 기대어 재구독하지 못한다. agent 메시지는 run의 workspace/channel/actor가 일치해야 하며 gateway error의 token shape도 server/adapter 양쪽에서 redaction한다.
- `scripts/momo hermes-gateway-init/status`와 real smoke는 chmod-600 env의 token configured 여부만 표시하고 legacy keys를 private backup 후 active env에서 제거한다. 실행 안내는 env를 subshell에만 로드하며 verifier도 credential을 process argv에 싣지 않고 종료 시 세션/테스트 credential을 폐기한다. provider OAuth는 계속 Hermes 내부 소유다.
- 검증: adapter contract 40 tests PASS(실시간 payload wake-only + recovery 단일 provider worker + full-page completion barrier + terminal 401/4xx unblock + reconnect/shutdown race + provider token redaction 포함), server 49 tests PASS(server-side implicit-error/conflicting-status fail-closed 포함). `scripts/verify_agent_live_channel.sh`는 exact-channel progress, private `agentwork:` WebSocket/OutboxRelay, revoked exact credential JWT deny, cross-channel run deny를 검증하고, `scripts/verify_hermes_gateway_adapter.sh`는 actor-bound REST/callback/rotation/revoke path를 검증한다. 동일 agent gateway 다중 인스턴스의 durable claim/lease는 MOMO-341 후속이다.

## MOMO-179 Realtime Client Subscription Contract (2026-06-29)

- `research/11-agent-runtime/14-realtime-client-subscription-contract-v0.md`와 fixtures를 추가해 connection token source, channel derivation, subscribe authorization, event envelope, `message.seq` replay/gap-fill, reconnect/resubscribe, agent namespace boundary를 고정했다.
- `message.new` server broadcast payload와 AgentWorker `agent.status`/`agent.partial` progress payload를 MomoCore snake_case decode 계약에 맞췄다. MOMO-192에서 `/v1/auth/realtime-token` endpoint가 추가됐고, MOMO-193에서 Core/macOS replay driver seam이 추가됐다. 실제 SwiftCentrifuge adapter/live e2e는 후속이다.
- 검증: `scripts/local_gate.sh --profile docs` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.

## 0-2. MOMO-192 Server realtime-token endpoint (2026-06-29)

- `POST /v1/auth/realtime-token`을 protected auth group에 추가했다. App access JWT 검증 후 RLS tenant read로 `member.status='active'`를 재확인하고, `sub=member_id`/`ws=workspace_id`/JSON `info`가 담긴 short-lived Centrifugo connection JWT를 발급한다.
- 일반 `ch:`/`dm:` 구독 권한은 계속 `/v1/centrifugo/subscribe` membership guard가 맡는다. 클라이언트 direct publish 금지와 tenant write path NOBYPASSRLS 원칙은 변경 없음.
- 검증: `cd server && swift build` PASS, `cd server && swift test` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. Docker smoke: `make up` + `make migrate`, server `:20830`, login → realtime-token 발급 PASS(`ttlSeconds=300`, token_len=506), invalid bearer 401 PASS. Full Centrifugo WebSocket connect/subscribe는 SwiftCentrifuge driver ticket에서 계속 검증.

## 0-3. MOMO-193 RealtimeSubscriptionDriver v0 (2026-06-29)

- `clients/Core`에 `RealtimeSubscriptionDriver`, `RealtimeEnvelopeSubscriptionTransport`, `RealtimeReplayController`를 추가해 `message.seq` duplicate drop, gap buffering, REST backfill, buffered replay drain을 deterministic하게 처리한다.
- `MomoServerRESTChatBackend.subscribe(channel:)`는 optional realtime driver를 주입받아 마지막 REST history seq 이후부터 live stream을 시작할 수 있다. driver 미주입 시 기존 empty stream/demo fallback은 유지된다.
- SwiftCentrifuge 실제 dependency는 아직 추가하지 않았다. 따라서 NOTICE/THIRD_PARTY 변경은 없으며, live SwiftCentrifuge adapter/reconnect/recovery e2e는 계속 `runtime-unverified` 후속이다. 검증: `swift test --package-path clients/Core` PASS, `swift test --package-path clients/macOS` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS.

## 0-4. MOMO-195 AgentWorker verifier hotfix (2026-06-29)

- PR #145/#146/#147/#148 merge 후 main `scripts/local_gate.sh --profile all`이 `scripts/verify_agent_worker.sh`에서 실패했다. DB 상태는 `agent_run=succeeded`, `outbox=done`, `usage_ledger`/`budget_window` PASS였고, 원인은 AgentWorker/MomoCore realtime v0 계약이 `payload.run_id` snake_case로 정렬된 뒤 verifier가 legacy `payload.runId`만 조회한 계약 drift였다.
- verifier를 v0 정본 `payload.run_id` 우선 + legacy `payload.runId` fallback으로 수정했다. 제품 runtime protocol 변경은 없고, post-merge gate 복구용 hotfix다.

## 0-5. MOMO-196 Realtime WebSocket Live Subscribe Gate (2026-06-29)

- `scripts/verify_realtime_live.sh`를 추가해 Docker dev compose PG/Centrifugo + host MomoServer/OutboxRelay + compose-network `api:8080` proxy에서 demo login → `/v1/auth/realtime-token` → `ch:ws<workspace>.<channel>` WebSocket subscribe → REST message send → live `message.new` publication 수신까지 검증한다.
- `scripts/local_gate.sh --profile runtime-live`가 static/Swift gate와 repo-local live verifier를 연결한다. evidence는 REST `message.seq`, `payload.message.seq`, Centrifugo publication offset, invalid connection token reject를 남긴다.
- `infra/docker-compose.e2e.yml`의 `db-roles` command는 container env `DATABASE_URL`을 쓰도록 `$$DATABASE_URL`로 escape했고, Swift e2e services는 read-only source mount를 보존하면서 `/tmp/momo-src` package copy에서 빌드하도록 정리했다.
- SwiftCentrifuge macOS adapter UX, reconnect/recovery UX, presence, APNs는 계속 후속 `runtime-unverified`다.

## 0-6. MOMO-198 M3 D/B/C Readiness Cleanup (2026-06-29)

- `research/11-agent-runtime/15-m3-dbc-real-data-readiness.md`를 추가해 MOMO-170/171/174/177/179/192/193 이후 현재 코드 기준의 D/B/C 실데이터 readiness와 기존 MOMO-020/021/022 unblock 조건을 재정리했다.
- 다음 builder-friendly 후보를 ROADMAP/BUILD_TICKETS에 반영했다: MOMO-200 SwiftCentrifuge live adapter, MOMO-201 D fixture/gate, MOMO-202 cost projection, MOMO-203 approval pending projection, MOMO-204 combined M3 D/B/C gate.
- 이번 PR은 docs/spec 변경만 수행한다. 실제 SwiftCentrifuge adapter, D/B/C runtime gate, external Hermes/provider side-effect evidence는 계속 `runtime-unverified` 후속 범위다.

## 0-7. MOMO-203 Approval Pending Projection + Inbox Gate (2026-06-30)

- `GET /v1/workspaces/{ws}/approvals?status=pending` server-owned projection을 추가하고, tenant token + active channel membership으로 pending approval rows를 제한한다. Projection은 `approval` SoT와 payload-derived cost/reversibility/on-behalf metadata를 반환한다.
- MomoMac REST backend와 `ChatViewModel` bootstrap이 pending approval projection을 읽어 C Approval Inbox initial load를 seed-only가 아닌 server data로 채운다. Approve/reject는 기존 decision endpoint + caller-provided `client_decision_id`를 유지하고, receipt/`approval.decided` event는 `approval_id` keyed state로 reconcile한다.
- `scripts/verify_approval_decision.sh`가 projection read path, same-workspace nonmember channel guard, two-workspace token isolation, approve/reject/idempotency/expired paths를 함께 검증한다. Real external provider write는 계속 out of scope이며 deterministic resume/tool_result/audit path만 local gate에서 검증한다.

## 0-8. MOMO-202 B Cost Projection + CostSnapshot Binding (2026-06-30)

- `GET /v1/workspaces/{ws}/channels/{ch}/cost-snapshots`를 추가해 `agent_run`/`usage_ledger`/`budget_window` 기반 server-owned `CostSnapshot` projection을 제공한다. 계약 필드: `reserved_micro_usd`, `spent_micro_usd`, `is_reconciled`, `was_estimated`, `soft_limit_micro_usd`, `hard_limit_micro_usd`, `limit_state`.
- macOS `ChatBackend`/`MomoServerRESTChatBackend`/`ChatViewModel`/`CostBreathingRing`이 demo seed 계산 대신 `CostSnapshot` projection을 우선 소비한다. `MOMO_SERVER_BASE_URL`이 없으면 `LiveChatBackend` projection fixture fallback은 유지한다.
- `scripts/verify_agent_worker.sh`가 AgentWorker reserve/reconcile DB evidence와 MomoServer cost projection endpoint evidence를 같은 runtime-agent gate에서 검증하도록 확장됐다. 외부 hermes/staging provider 연결은 계속 `runtime-unverified`.
- 검증: `scripts/local_gate.sh --profile swift` PASS, `scripts/local_gate.sh --profile runtime-agent` PASS, `scripts/local_gate.sh --profile macos-ui` PASS.

## 0-9. MOMO-205 macOS Real-Backend Dev App Smoke Gate (2026-06-30)

- `scripts/verify_macos_real_backend_ui.sh`를 추가하고 `scripts/local_gate.sh --profile macos-ui`에 연결했다. 이 gate는 Docker compose+migrate+host MomoServer를 준비한 뒤 REST login/channel list/history/send와 approval/cost structured fixture evidence를 남긴다.
- MomoServer message history/send DTO가 `props`/`runId`/`clientMsgId`를 반환하고, MomoMac REST backend가 이를 디코드해 approval inbox/cost sidecar state를 REST history만으로 hydrate한다. `MOMO_CHANNEL_ID` dev env도 dynamic channel loading 후 선택된다.
- UI launch는 계속 opt-in이다. 기본 `macos-ui`는 REST/backend evidence로 PASS하고, `LOCAL_GATE_LAUNCH_UI=1`이면 `MOMO_SERVER_BASE_URL` 등 env를 직접 실행된 `MomoMacDevApp`에 주입해 process/window/log evidence까지 요구한다. SwiftCentrifuge live adapter와 full M3 combined D/B/C exit gate는 후속 `runtime-unverified`.

## 0-10. MOMO-200 macOS SwiftCentrifuge live adapter (2026-06-30)

- `clients/macOS`에 SwiftCentrifuge 0.9.0(MIT) dependency와 `SwiftCentrifugeRealtimeSubscriptionTransport`를 추가해 `/v1/auth/realtime-token` connection token getter → `ch:ws<workspace>.<channel>` subscribe → publication `RealtimeEnvelope` decode → `DefaultRealtimeSubscriptionDriver` 경로를 연결했다.
- `MomoMacDevApp` REST mode는 `MOMO_CENTRIFUGO_WS_URL` 또는 worktree `CENT_PORT`가 있으면 optional live driver를 주입한다. 검증: `swift test --package-path clients/macOS` PASS, `scripts/local_gate.sh --profile swift` PASS, `scripts/local_gate.sh --profile runtime-live` PASS. `agent:` live boundary는 MOMO-212에서 닫고, production reconnect UX polish는 후속이다.

## 0-11. MOMO-206 Local Gate All-Profile Runtime Cleanup Hotfix (2026-06-30)

- PR #163/#166/#164/#165 merge 후 main `scripts/local_gate.sh --profile all`에서 개별 runtime profile은 통과했지만, `verify_relay.sh`가 남긴 host `MomoServer` listener 때문에 다음 `verify_agent_worker.sh`가 같은 worktree `PORT`를 보고 fail-fast하는 all-profile 조합 버그를 확인했다.

- `scripts/local_gate.sh --profile all`은 runtime verifier 사이에 worktree env의 `PORT`를 읽고 해당 포트의 `MomoServer` listener만 정리하는 cleanup command를 삽입한다. standalone profile의 포트 점유 fail-fast 동작과 제품 runtime 코드는 변경하지 않았다.
- 검증: `scripts/local_gate.sh --profile docs` PASS. main post-merge `scripts/local_gate.sh --profile all`은 이 hotfix merge 후 재실행한다.

## 0-12. MOMO-209 Worktree Docker Compose Janitor (2026-06-30)

- `scripts/compose_janitor.sh`를 추가해 병렬 local gate 후 남은 stale `momo_` worktree Docker Compose project/container/network를 dry-run 기본값으로 목록화한다.
- cleanup은 `--cleanup` 명시 시에만 수행하며, root `momo` project, `momo_default`, `supabase`, active git worktree project, non-momo Docker resource는 보호한다. Volume 삭제는 의도적으로 범위 밖이다.
- 검증: `bash -n scripts/compose_janitor.sh` PASS, `scripts/compose_janitor.sh` dry-run PASS, `scripts/local_gate.sh --profile docs` PASS.

## 0-13. MOMO-208 M4 macOS Packaging Architecture ADR (2026-06-30)

- `docs/adr/0003-macos-packaging-architecture.md`를 추가해 SwiftPM `MomoMacDevApp`은 개발/로컬 게이트용, M4 Xcode `MomoMac.app`은 릴리스 번들/서명/공증용으로 분리했다.
- build-macos-apps plugin 사용 범위는 SwiftPM GUI 실행/진단, Xcode 설정 점검, signing/Gatekeeper/notary 실패 분류로 제한하고, Apple 계정·인증서·API key·Sparkle private key는 사람/운영자 소유 secret boundary로 고정했다.
- M4 후속은 #15(MOMO-030 Xcode host), #16(MOMO-031 codesign/notary/DMG), #17(MOMO-032 Sparkle) 순서로 진행한다. 실제 Xcode project 생성, signing/notary/DMG/Sparkle 구현은 이번 goal out of scope다.

## 0-14. MOMO-201 D Live Tool-Call fixture/local gate (2026-06-30)

- `scripts/mock_hermes.py`가 OpenAI-compatible SSE `tool_calls` delta를 내보내고, `scripts/verify_agent_worker.sh` runtime-agent gate가 `agent.partial`의 `tool_call_name` + bounded JSON `tool_call_args`와 final `tool_result`/`message.new` broadcast evidence를 검증한다.
- MomoMac `ChatViewModel`은 final `tool_result` 또는 같은 `message_id`의 committed message가 들어오면 in-flight progress card를 제거하고 `message.seq` 기준 timeline으로 reconcile한다. Fixture stream 테스트가 duplicate final/late partial을 중복 없이 처리함을 검증한다.
- 검증: `scripts/local_gate.sh --profile swift` PASS, `scripts/local_gate.sh --profile runtime-agent` PASS, `scripts/local_gate.sh --profile macos-ui` PASS. 실제 external Hermes/provider side effect는 out of scope이며 mock OpenAI-compatible gateway local evidence로 닫는다.

## 0-15. MOMO-207 macOS Realtime Reconnect Status UX (2026-06-30)

- `MomoCore`에 `RealtimeConnectionStatus` 모델을 추가하고, connection/subscription/reconnect/error/REST fallback 상태를 `RealtimeSubscriptionDriver`와 backend status stream으로 노출했다.
- SwiftCentrifuge channel live adapter가 connect/subscribe/reconnect/disconnect/error lifecycle을 status stream으로 보고하고, `ChatViewModel`은 selected channel status와 `retryRealtime()`을 제공한다. `MessageListView`는 Live/Connecting/Reconnecting/REST fallback/Error banner와 수동 retry affordance를 표시한다.
- 검증: `swift test --package-path clients/macOS` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS, `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS. `agent:` live boundary는 MOMO-212에서 닫고, presence/APNs는 후속 범위다.

## 0-16. MOMO-212 Agent Channel Live Subscription Verifier v0 (2026-06-30)

- Centrifugo `agent` namespace에 subscribe proxy와 `agent:ws<workspaceUUID>.<channelUUID>.<agentMemberUUID>` regex를 적용하고, `/v1/centrifugo/subscribe`가 exact-channel membership을 fail-closed로 파싱/인가한다.
- v0 agent live boundary는 observer와 target agent가 같은 workspace의 active member이고 이벤트가 발생한 정확한 active channel에 함께 속할 때만 구독을 허용한다. 일반 channel `ch:`/`dm:` membership guard와 client direct publish 금지, REST→Postgres→outbox publish 경로는 유지한다.
- `scripts/verify_agent_live_channel.sh`를 추가해 Docker dev compose + host MomoServer/AgentWorker/OutboxRelay + mock Hermes + Centrifugo subscribe proxy에서 exact-channel live `agent.status`/`agent.partial`, private `agentwork:` 수신, invalid token, same-workspace different-channel member, other-workspace token/member, client direct publish deny를 검증한다.
- `agent.status`/`agent.partial`은 ephemeral progress projection이며 `message.seq` ordering authority가 아니다. 최종 durable 결과는 기존 channel timeline의 `message.new`/`message.seq`로 reconcile한다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path server` PASS, `scripts/verify_agent_live_channel.sh` PASS. 전체 `swift`/`runtime-agent` local gate evidence는 PR에 첨부한다. Presence/APNs, external Hermes staging connection, production reconnect UX polish는 계속 후속 범위다.

## 0-17. MOMO-215 Agent Mention Routing E2E v0 (2026-06-30)

- `POST /messages` send transaction이 text body의 active agent mention(`@김인턴`, `@handle`, `<@id>`)을 감지해 same-channel agent에만 `agent_run` + `outbox(kind='agent_job')`를 생성한다. 동일 `client_msg_id` 재전송은 기존 message/seq와 job 1개를 유지하고, 채널 멤버가 아닌 agent mention은 job 없이 `agent.mention.skipped` audit로 남긴다.
- AgentWorker final text 응답은 `run_id`/source attribution을 보존한 durable channel `message.new`로 기록되고, mock SSE의 `agent.partial`/tool-call progress는 기존 `agent:` live channel에 남는다. 다른 workspace agent는 tenant RLS 범위에서 resolve하지 않아 cross-workspace job을 만들지 않는다.
- 검증: `swift test --package-path server` PASS, `swift test --package-path workers/AgentWorker` PASS, `scripts/verify_agent_worker.sh` PASS. External Hermes/provider side effect는 계속 `runtime-unverified`이며 repo-local OpenAI-compatible mock path로 닫는다.

## 0-18. MOMO-219 macOS Agent Mention UX v0 (2026-06-30)

- macOS agent roster row click/context action이 composer draft에 `@김인턴` 또는 `@kim-intern`을 삽입한다. 선택 channel이 없거나 inactive agent면 action은 disabled/notice로 fail-clear하며, 최종 same-channel membership guard는 서버 mention routing이 유지한다.
- `ChatViewModel.send`가 실제 optimistic local echo를 먼저 표시하고, mention + REST fallback 상태에서는 agent progress placeholder와 delayed durable history refresh로 final agent message를 `message.seq` timeline에 reconcile한다. `AgentPartialView`는 status의 agent member를 author로 표시한다.
- `LiveChatBackend` demo fallback은 김인턴(`kim-intern`) mention에 deterministic progress/tool-call/final text response를 제공한다. `scripts/verify_macos_real_backend_ui.sh`는 real-backend `@kim-intern` source send/read와 `agent_job` 생성 smoke를 포함한다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` PASS. Required local gates: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-agent` PASS. External Hermes/provider side effect는 계속 out of scope이며 repo-local mock OpenAI-compatible path로 닫는다.

## 0-18a. MOMO-224 Internal Alpha Diagnostics Bundle v0 (2026-06-30)

- `scripts/collect_diagnostics.sh`를 추가해 server/relay/worker verifier logs, Centrifugo compose logs, macOS unified logs, env shape, git commit/status, local gate evidence를 redacted directory + `.tar.gz` + `summary.md`로 묶는다. 수집은 best-effort라 Docker/log/app 부재나 실패 상황에서도 가능한 evidence를 남긴다.
- `scripts/local_gate.sh --profile diagnostics`를 추가해 diagnostics redaction smoke를 PR gate로 실행한다. secrets/password/token/API key/HMAC/database URL credentials는 bundle write 전에 `[REDACTED]`로 치환한다.
- 검증: `scripts/collect_diagnostics.sh --smoke` PASS, 실제 bundle 생성 PASS. Required local gates: `scripts/local_gate.sh --profile docs`, `scripts/local_gate.sh --profile diagnostics`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift`.

## 0-18b. MOMO-228 Internal Alpha Runbook + Feedback Packet v0 (2026-07-01)

- `docs/INTERNAL_ALPHA.md`를 추가해 팀원이 local stack, seeded demo 계정, invite/join, `MomoMacDevApp` real-server launch, 김인턴 mock path, diagnostics bundle, bug report template, known limitations를 한 흐름으로 따라 할 수 있게 했다.
- `docs/INDEX.md`, `docs/RUN.md`, `docs/LOCAL_PR_GATE.md`, `ROADMAP.md`, `BUILD_TICKETS.md`에 internal alpha packet 위치와 docs gate 기준을 연결했다.
- 이번 goal은 문서/운영 런북 변경이다. Actual public staging DNS/TLS, external Hermes/provider side effect, notarized macOS release app, iOS/APNs는 계속 별도 milestone 범위이며 `runtime-unverified(public host/external Hermes)`로 남는다.

## 0-18c. MOMO-231 Internal Alpha Feedback Intake + Triage Workflow v0 (2026-07-01)

- GitHub `Internal alpha feedback` issue template과 `docs/INTERNAL_ALPHA_FEEDBACK.md`를 추가해 raw tester feedback을 `status:needs-triage` intake issue로 받고, severity/evidence/labels/milestone을 정리한 뒤 buildable Codex goal로 전환하는 절차를 고정했다.
- `.github/labels.json`, `scripts/github/labels.tsv`, `scripts/goal_status.sh`, `docs/GITHUB_OPS.md`, `docs/LOCAL_PR_GATE.md`, `docs/INTERNAL_ALPHA.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 `type:feedback`/`area:alpha`/`status:needs-triage` 운영에 맞췄다.
- 이번 goal은 docs/tooling 변경이다. 제품 기능 수정, GitHub Project 자동화, Slack/Discord 알림 봇, runtime e2e 신규 구현은 out of scope이며 새 runtime 검증은 수행하지 않는다.

## 0-16. MOMO-211 M4 MomoMac Xcode thin host app v0 (2026-06-30)

- `clients/macOS/MomoMac.xcodeproj`와 shared scheme `MomoMac`을 추가했다. Xcode host target은 SwiftPM `MomoMacDevApp`과 분리되어 있고, `MomoMac`/`MomoCore`를 local SwiftPM dependency로 소비해 기존 `MomoMacRootView` + `MomoMacDemo` bootstrap을 호스트한다.
- Bundle ID는 `com.dawnkim.momo`이며 Debug/Release 모두 hardened runtime build setting과 sandbox/network-client entitlements file을 갖는다. `CODE_SIGNING_ALLOWED=NO` local build에서는 Xcode가 hardened runtime signing step을 비활성화한다. Developer ID signing/notarytool/DMG/Sparkle은 계속 후속 M4 범위다.
- 검증: `xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` PASS(in `clients/macOS`), `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. GUI smoke는 Xcode build 산출 `MomoMac.app` launch 후 `MomoMac` process와 `window_count=1`을 확인했다.

## 0-16. MOMO-204 Combined M3 D/B/C Local Gate Profile (2026-06-30)

- `scripts/local_gate.sh --profile m3-dbc`를 추가해 docs/static + Swift build/test + D mock SSE tool-call/final `tool_result` evidence + B cost reserve/reconcile/projection evidence + C pending approval/decision/audit/resume evidence + macOS real-backend REST/UI data smoke를 한 PR evidence block으로 수집한다.
- `LOCAL_GATE_LAUNCH_UI=1`이면 기존 MomoMacDevApp process/window/log smoke까지 요구하고, 기본값은 headless local gate를 위해 GUI launch opt-in을 유지한다. External Hermes/staging provider side effects, M4 packaging/signing/notary, iOS/APNs는 계속 out of scope다.
- 검증: `scripts/local_gate.sh --profile docs` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc` PASS.
- #12(MOMO-020) 판정: `m3-dbc` profile PASS를 PR에 첨부하면 오래된 staging/Hermes 문구는 MOMO-204 local-gate 기준으로 대체 가능하므로 **merge 후 momo-main이 #12를 닫아도 됨**. 이 worker branch는 PR 생성 + `status:needs-review`에서 멈추고 #12를 직접 닫지 않는다.

## 0-17. MOMO-213 macOS Real-Server Session Onboarding UI v0 (2026-06-30)

- `MomoMacDevApp`과 Xcode host가 `MomoMacSessionRootView`를 통해 server URL/email/password/optional invite code를 입력받고, `/v1/auth/login` 또는 `/v1/join` 성공 토큰으로 기존 `MomoServerRESTChatBackend` + D/B/C UI에 진입한다.
- Demo/stub backend는 `Open Demo`로 명시 분리했고, empty channel list/인증 실패/서버 연결 실패를 UI에 표시한다. 저장 전략은 UserDefaults(server URL/email/invite code) + optional Keychain(password)으로 제한한다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS.

## 0-18. MOMO-214 Channel Create + Membership Management Runtime v0 (2026-06-30)

- `POST /v1/workspaces/{ws}/channels`, `POST /v1/workspaces/{ws}/channels/{ch}/members`, `DELETE /v1/workspaces/{ws}/channels/{ch}/members/{member}`를 추가해 owner/admin이 public/private channel을 만들고 human/agent member를 추가/제거할 수 있게 했다. 생성 write는 기존 `channel`/`membership`/`channel_seq`만 사용하며 신규 migration은 없다.
- write path는 `momo_app` NOBYPASSRLS + `SET LOCAL app.workspace_id` tenant transaction으로 검증했다. `scripts/verify_channel_management.sh`가 channel create, creator membership, `channel_seq`, member/admin 권한, cross-workspace 차단, remove 후 write 차단, re-add 후 message send까지 확인한다.
- 검증: `swift build --package-path server` PASS, `scripts/verify_channel_management.sh` PASS. Rich channel settings UI, archival/search, external directory sync, enterprise fine-grained RBAC는 out of scope.

## 0-19. MOMO-217 Auth Password Verification Runtime Hardening v0 (2026-06-30)

- `POST /v1/auth/login` password stub을 제거하고 PostgreSQL `pgcrypto` 기반 `momo_password_hash`/`momo_password_verify` 함수로 DB-backed password verification을 수행한다. Demo seed 및 runtime fixture의 deterministic dev password는 `dev-password`다.
- `/v1/join` 신규 human 생성은 raw password를 저장하지 않고 `momo_password_hash(password)`만 저장한다. 잘못된 password, 빈 password, unknown email은 401이며, platform admin scope는 일반 password 검증 후 별도 `platformAdminSecret` + allowlisted email 조건에서만 부여된다.
- `scripts/verify_join.sh`와 `scripts/verify_platform_admin.sh`가 wrong/empty/platform-secret-only rejection 및 joined-account login을 검증한다. Raw password/hash는 API 응답, audit payload, STATUS에 기록하지 않는다.

## 0-20. MOMO-218 macOS Channel Management UI v0 (2026-06-30)

- `MomoCore.ChatBackend`와 macOS `MomoServerRESTChatBackend`에 channel create + member add/remove 계약을 추가하고, sidebar에서 public/private channel 생성 및 selected channel roster add/remove를 수행할 수 있게 했다. Roster projection은 active `channelIds`를 내려 macOS가 human/agent membership state와 agent badge를 즉시 반영한다.
- `LiveChatBackend` demo fallback은 deterministic create/add/remove 및 duplicate/not-found error behavior를 제공한다. `scripts/verify_macos_real_backend_ui.sh`는 기존 REST login/channel/history/send smoke에 private channel create + 김인턴 add/remove evidence를 추가했다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS. Full channel settings/preferences, archive/search, enterprise RBAC, directory sync, iOS UI는 out of scope.

## 0-21. MOMO-223 macOS Session Switch + Logout Polish v0 (2026-06-30)

- `MomoMacSessionRootView` 상단 session bar가 현재 server/workspace/member/session mode와 selected channel realtime 상태(Live/Reconnecting/REST fallback)를 표시하고, details popover로 non-secret session context를 확인할 수 있게 했다.
- `Switch`/`Log Out` 동선을 분리했다. 두 경로 모두 active `ChatViewModel` subscription을 취소하고 REST/demo backend의 token/workspace/channel/realtime cache를 지운다. `Log Out`은 in-memory password와 saved-password preference/Keychain entry까지 지워 chooser로 돌아간다.
- secret boundary: access/refresh token은 저장하지 않고 status UI/details/STATUS에 노출하지 않는다. UserDefaults 저장은 server URL/email/invite code에 한정되며, password는 optional Keychain 저장만 허용하고 logout에서 삭제한다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` PASS. 전체 `swift` 및 가능하면 `macos-ui` local gate evidence는 PR에 첨부한다.

## 0-22. MOMO-226 macOS Invite/Admin Onboarding Real-Backend Polish v0 (2026-07-01)

- macOS real-server session bar에 compact `Invites` popover를 추가했다. Owner/admin token으로 `POST/GET /v1/workspaces/{ws}/invites` 및 `POST /v1/workspaces/{ws}/invites/{invite}/revoke`를 호출해 role/max uses/expiry create, active/revoked/used list, revoke state를 표시한다.
- `MOMO_SERVER_BASE_URL` 환경 실행도 email/password login을 거쳐 real access token + invite-admin context를 만들도록 정렬했다. Demo backend의 legacy invite stub은 유지하지만 server-configured mode는 실제 REST path를 우선한다.
- `scripts/verify_macos_real_backend_ui.sh`가 invite create/list/revoke, fresh invite second-user `/v1/join`, joined token으로 channel/member state load evidence를 추가로 남긴다. Email delivery, SSO/OAuth, billing/team plan, signing/notarization은 out of scope다.
- 검증: `swift test --package-path clients/macOS` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS, `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS. SwiftCentrifuge live adapter/presence/APNs, email delivery, SSO/OAuth, billing/team plan, signing/notarization은 out of scope다.

## 0-23. MOMO-232 macOS Internal Alpha Usability Polish v0 (2026-07-01)

- `Invites` popover가 create/list/revoke 중복 submit을 막고, 진행 상태·실패 후 retry·생성 직후 raw code `Copy Code` 흐름과 복구 불가 안내를 제공한다.
- session chooser/sidebar/timeline이 login/join/channel/message 실패를 recoverable error로 표시하고 retry/dismiss 경로를 제공한다. `Switch`/`Log Out`의 stale channel/member/invite/realtime state reset은 focused test로 고정했다.
- Kim Intern chip/details가 `Local mock` / `Internal host mock` / `External Hermes`, key 준비 여부, redacted endpoint/degraded diagnostics를 내부 알파 사용자가 구분 가능하게 표시한다.
- 검증: `swift test --package-path clients/macOS` PASS. Required local gates: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift`, `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui`, 가능하면 `LOCAL_GATE_LAUNCH_UI=1 ... scripts/local_gate.sh --profile internal-alpha`. Public host deploy, real external Hermes quality evaluation, signing/notarization, iOS UI는 out of scope다.

## 0-24. MOMO-235 macOS Alpha Update Channel v0 (2026-07-01)

- Sparkle 2 우선 + manual fallback alpha update channel 결정을 `docs/adr/0005-macos-alpha-update-channel-v0.md`로 고정하고, operator runbook `docs/MACOS_ALPHA_UPDATE_CHANNEL.md`에 appcast/signing key/Developer ID/notarytool/DMG secret boundary를 정리했다.
- `MomoMacSessionRootView` session bar에 `Updates` popover를 추가했다. SwiftPM dev app/Xcode host 공용 surface이며 `MOMO_UPDATE_*` non-secret hints만 읽고, real install 전에는 `signing-unverified`/placeholder 상태를 표시한다.
- 검증: `swift test --package-path clients/macOS` PASS, `scripts/local_gate.sh --profile docs` PASS. Real Sparkle framework install, appcast generation, Developer ID signing, notarization, DMG upload, old-version-to-new-version update proof는 M4 후속으로 남는다(`runtime-unverified(update install)`).

## 0-25. MOMO-243 In-App Alpha Command Center (2026-07-01)

- `MomoMacRootView` detail pane에 `Alpha Command Center`를 추가해 Server / Realtime / Agent Runtime / Invites / Diagnostics / Updates 상태, 오늘 테스트할 항목, 현재 가능한 기능과 known limitations를 앱 안에서 확인할 수 있게 했다.
- 새 `AlphaCommandCenterSnapshot` projection은 기존 `ChatViewModel` 상태(`LiveChatBackend`/REST backend, realtime status, Kim Intern status, invite state, update readiness)를 재사용하며, failed/degraded 상태에는 recovery hint를 붙인다.
- 검증 대상: `swift test --package-path clients/macOS`, `scripts/local_gate.sh --profile macos-ui`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift`. Real Sparkle install, AWS/public host, iOS/APNs, credentialed external Hermes side effects는 계속 out of scope/runtime-unverified 경계다.

## 0-26. MOMO-244 Dev Update Channel v0 (2026-07-01)

- `Updates` popover를 local/file manifest 기반 Dev Update Channel v0로 업그레이드했다. `MOMO_UPDATE_MANIFEST_PATH` 또는 `file://` `MOMO_UPDATE_MANIFEST_URL`을 읽어 current/available version, channel, manifest/download target을 표시하고 `Up to date` / `Update available` / `Update check failed` 상태를 구분한다.
- `clients/macOS/Fixtures/update-manifest-alpha-v0.json` 예시 fixture와 focused macOS tests를 추가했다. 새 빌드가 있으면 `Open Download`/release notes/설치 후 relaunch 안내를 제공하되, Sparkle/Developer ID/notary/DMG/완전 무인 self-replace updater는 out of scope로 유지한다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` PASS. Required PR gates: `scripts/local_gate.sh --profile macos-ui`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift`.

## 0-27. MOMO-253 macOS Dogfood UX Shell Polish (2026-07-02)

- macOS post-login shell에서 과밀한 상단 session/debug bar를 제거하고, session/profile/language/update/invite/logout controls를 좌측 sidebar 하단 profile menu로 이동했다. 기본 sidebar는 channel, approval, member 중심으로 넓고 읽기 쉽게 유지하며 Local AI/Context/diagnostics는 접힌 diagnostics 영역으로 숨긴다.
- `MomoMacRootView` detail pane은 기본 숨김으로 시작하고, 숨김 상태에서는 실제 2-column layout으로 전환해 채널 타임라인이 빈 우측 패널에 밀리지 않게 했다. Command Center/Approvals는 필요할 때만 Slack thread/inspector처럼 열리며 로그인 첫 화면의 prefilled local alpha UX, 한국어/영어 앱 chrome localization, `m` 로고 기반 dev app icon은 유지한다.
- `scripts/momo` friendly launcher를 추가했다. dogfood 사용자는 `scripts/momo start/status/stop`만 기억하면 local alpha stack, macOS dev app launch, 종료 흐름을 처리할 수 있다.
- 좌측 sidebar를 custom glass panel로 재구성했다. `작업함 → 채널 → 멤버 → 개발 도구` 순서로 정리하고, 에이전트는 별도 섹션이 아니라 현재 채널 membership에 속한 first-class member로만 표시한다. 멤버 `+`는 사람 초대와 에이전트 초대를 분기하고, 에르메스는 `@hermes` 별칭/endpoint/초대코드 네트워크 핸드셰이크를 준비하는 UI 경로로만 노출한다.
- 하단 profile menu에 서버 설정 로컬 드래프트를 추가했다. 서버명/아이콘 문자/멤버 초대 정책/에이전트 초대 승인 필요 여부를 dogfood 앱 표시값으로 저장할 수 있으며, 실제 server-persisted workspace settings/RBAC API는 후속 goal로 남긴다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS(58 tests), `bash -n scripts/macos_dev_run.sh` PASS, `scripts/macos_dev_run.sh --launch --verify --wait 20 --terminate` PASS(window_count=1), clean commit 기준 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS.

## 0-28. MOMO-259 macOS Shell/Layout/Performance Polish (2026-07-03)

- `MomoMacRootView`의 2-pane/3-pane `NavigationSplitView` root swap을 제거하고, 항상 안정적인 sidebar + timeline split 안에서 우측 inspector만 slide-in/out 하도록 정렬했다. 우측 inspector에는 명시적인 닫기 버튼과 현재 surface 설명을 추가했다.
- toolbar는 command center/approvals/detail/language/appearance를 고정된 primary action group으로 유지하고, language menu는 `언어 >` submenu 없이 `한국어`/`English`를 바로 선택한다. Light/Dark/System appearance preference는 `@AppStorage`로 저장된다.
- 하단 profile footer는 무거운 custom popover 대신 lightweight macOS `Menu`로 바꿔 open/close 체감 지연을 줄였다. 좌측 sidebar 버튼 크기와 quick tooltip을 보강하고 sidebar material을 더 독립적인 glass 영역처럼 조정했다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS(58 tests), clean commit 기준 `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS(window_count=1).

## 0-29. MOMO-263 macOS Responsive Drawer/Profile/Downloads UX (2026-07-03)

- Slack thread UX와 Mattermost right-hand sidebar 패턴을 기준으로 작은 창에서 approval/command center가 sidebar/timeline을 밀어내는 문제를 재정리했다. `MomoMacRootView`는 top-level `NavigationSplitView` 교체 대신 고정 sidebar + timeline + responsive inspector 구조를 사용하고, 창 폭이 좁으면 우측 패널을 center 위 overlay drawer로 열어 좌측 glass sidebar가 찌그러지지 않게 했다.
- 상단 toolbar의 command/approval/language/theme/download 기능을 줄이고, profile footer의 sidebar-local panel로 숨겼다. 언어와 appearance는 한 번에 바꾸는 segmented action으로 노출하고, 다운로드는 v0에서 update channel 상태와 Finder Downloads 열기를 제공한다.
- 서버 설정은 explicit `서버 이름`/`서버 아이콘` 입력으로 정리했고, macOS dogfood v0에서는 선택한 이미지를 `Application Support/momo/avatars/`에 복사해 local display draft로 사용한다. 실제 server-persisted workspace icon/profile upload API는 후속이다.
- dogfood 기본 roster는 legacy Kim Intern fixture를 숨기고, Hermes/`@hermes` 초대 이후 표시되는 first-class agent member 모델을 우선한다. Agent pairing/credentialed Hermes smoke 자체는 MOMO-257/후속 provider setup 범위다.
- `verify_macos_real_backend_ui.sh`의 GUI smoke는 direct executable launch 대신 `launchctl setenv`로 필요한 `MOMO_*` dev env만 임시 주입하고 정상 `.app` LaunchServices path로 실행하도록 안정화했다. 이전 direct launch는 process는 떴지만 System Events window count가 0으로 잡히는 flake가 있었다.
- 검증: `swift build --package-path clients/macOS --product MomoMacDevApp` PASS, `swift test --package-path clients/macOS` PASS(58 tests), `bash -n scripts/momo scripts/macos_dev_run.sh scripts/local_gate.sh scripts/verify_macos_real_backend_ui.sh` PASS, `LOCAL_GATE_LAUNCH_UI=1 scripts/verify_macos_real_backend_ui.sh` PASS(evidence `/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-macos-real-backend/evidence-20260703T051343Z-28686.md`). Visual smoke: `/private/tmp/momo-267-1120.png`, `/private/tmp/momo-267-profile.png`.

## 0a. MOMO-001 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo_momo_001`, `POSTGRES_PORT=15432`, `CENT_PORT=18001`로 기동하고 Docker health가 둘 다 green.
- `make migrate` pass: `001_init.sql` + `002_seed.sql` 적용 성공, 재실행 시 `적용 0, 스킵 2`로 멱등 통과. `scripts/migrate.sh`는 keg-only Homebrew `libpq`의 `psql`도 자동 감지한다.
- MomoServer runtime pass: `PORT=18080 swift run MomoServer` 후 `GET /health` 200. `POST /v1/.../messages`가 실제 DB에 `message` + `outbox`를 쓰고 `seq=1` 반환.
- seq gapless 검증: 같은 채널에 동시 10건 송신 결과 `seq=2...11`, DB 집계 `message_count=11`, `max_seq=11`, `missing_seq=NULL`, `outbox_count=11`, `version=1...11`.
- 후속 완료: MOMO-002/003/004에서 relay publish, RLS 격리, AgentWorker SSE + 비용 회계까지 검증됨.

## 0b. MOMO-002 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo002`, `POSTGRES_PORT=55432`, `CENT_PORT=58000`으로 기동하고 Docker health가 둘 다 green.
- `make migrate` pass: 재실행 시 `적용 0, 스킵 2`로 멱등 통과. MomoServer는 `GET /health` 200.
- Centrifugo v6 contract fix: compose에서 `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` / `CENTRIFUGO_HTTP_API_KEY` env override를 사용하고, subscribe proxy 설정을 `channel.proxy.subscribe.endpoint` + namespace `subscribe_proxy_enabled`로 정렬.
- OutboxRelay runtime pass: relay 중지 상태에서 메시지 송신 → outbox `id=4`가 `pending`, `version=4`, `idempotency_key=<channel>:4`로 생성됨. relay 재기동 후 SKIP LOCKED claim → Centrifugo `/api/publish` → outbox `status=done`, `attempts=1`, `last_error=NULL`.
- Centrifugo history pass: `/api/history` 최신 publication이 `data.seq=4`, `payload.seq=4`를 반환. relay 로그에도 `channel=ch:ws...`, `version=4`, `idempotencyKey=...:4`가 남음.
- 남은 runtime-unverified: WebSocket live subscribe/presence/recovery 세부 UX.

## 0c. CI Hotfix (2026-06-25)

- `main`의 `ci-build / swift build + test (5 packages)` 실패 원인은 GitHub Actions macOS runner의 Xcode 16.4 / Swift 6.1.2와 `jwt-kit` 최신 해상도 간 MLDSA API 불일치였다.
- `server/Package.swift`에서 `jwt-kit`을 `exact: "5.2.0"`으로 고정해 CI runner가 지원하지 않는 `MLDSA65`/`MLDSA87` 참조를 피하도록 했다.

## 0d. MOMO-003 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo003`, `POSTGRES_PORT=35432`, `CENT_PORT=38003`으로 기동하고 Docker health가 둘 다 green.
- `make migrate` pass: `001_init.sql` + `002_seed.sql` 적용 성공, 재실행 시 `적용 0, 스킵 2`로 멱등 통과.
- RLS runtime pass: `scripts/verify_rls.sh`가 `momo_app`(non-superuser/NOBYPASSRLS), `momo_relay`/`momo_worker`(non-superuser/BYPASSRLS) 역할을 만들고 두 워크스페이스 fixture를 검증했다. `app.workspace_id` 미설정 시 member/channel/membership/message 0건, A/B 교차 조회 0건, relay/worker BYPASSRLS 전 테넌트 조회가 통과했다.
- MomoServer membership gate pass: 서버를 `momo_app` 역할로 실행해 `/health` 200, channel member read 200/write 201, 같은 워크스페이스 nonmember read/write 403, workspace B token의 workspace A path 접근 403, workspace B 정상 member read 200을 확인했다.
- 코드 보강: REST message send/history도 Centrifugo subscribe proxy와 동일하게 active membership을 확인한다. RLS는 테넌트 경계, membership guard는 채널 접근권 경계로 분리된다.
- 남은 runtime-unverified: WebSocket live subscribe/presence/recovery 세부 UX, APNs.

## 0e. MOMO-004 Runtime Gate (2026-06-25)

- `make up` pass: PostgreSQL 18 + Centrifugo v6가 `.env.worktree`의 `COMPOSE_PROJECT_NAME=momo004`, `POSTGRES_PORT=45432`, `CENT_PORT=48004`로 기동하고 Docker health가 green.
- `make migrate` pass: `001_init.sql` + `002_seed.sql` 적용 성공, 재실행 시 `적용 0, 스킵 2`로 멱등 통과.
- AgentWorker SSE runtime pass: `scripts/mock_hermes.py`가 OpenAI-compatible `/v1/chat/completions` SSE delta + final usage chunk를 제공하고, `scripts/verify_agent_worker.sh`가 김인턴 멘션 fixture → `outbox(kind='agent_job')` → AgentWorker claim → Centrifugo `agent.partial` history 수신을 확인했다.
- 비용 회계 pass: 성공 run `00000000-0000-7000-8000-000000000904`가 `agent_run.status=succeeded`, `usage_ledger(prompt=11, completion=7, cost_micro_usd=6, was_estimated=false)`, `budget_window(reserved=0, spent=6)`으로 기록됐다.
- G5 circuit breaker pass: low-limit `agent_channel` budget fixture가 hermes 호출 전 `G5 budget trip (agent_channel)`로 실패하고, 해당 run의 `usage_ledger` spend는 0건임을 확인했다.
- 코드 보강: `CostAccounting`이 `model_pricing` numeric 단가를 읽어 integer micro_usd로 reserve/reconcile하고, `budget_window` reserve를 `ON CONFLICT DO UPDATE ... WHERE spent+reserved+estimate<=limit` 원자 경로로 처리한다. `WorkerService`의 `agent_run.error` JSONB 저장도 `to_jsonb(text)`로 정리했다. 실제 hermes 대신 repo-local mock을 사용했으므로 외부 hermes 연동은 staging에서 재확인한다.
- 남은 runtime-unverified: WebSocket live subscribe/presence/recovery 세부 UX, APNs.

## 0f. MOMO-110 Local LLM · Agent Protocol · Trust Roadmap (2026-06-25)

- Apple Foundation Models는 서버 에이전트 대체가 아니라 intent/summarization/context compaction/PII redaction/offline draft 같은 온디바이스 context work에 우선 적용하기로 정리했다. 구현은 `#if canImport(FoundationModels)` + OS availability + server fallback 원칙.
- 새 연구 정본: `research/10-local-ai-protocol-trust/01-local-llm-context-broker.md`, `02-agent-protocol-google-workspace.md`, `03-enterprise-trust-local-ops.md`.
- 새 운영 정본: `docs/LOCAL_PR_GATE.md`(GitHub Actions 비주요 기간 로컬 PR gate), `docs/MULTI_SESSION_OPS.md`(5개+ Codex 세션/worktree 운영).
- build-macos-apps 플러그인은 SwiftPM build/test/triage와 macOS dev app 실행 표준화에 적극 사용하되, SwiftUI GUI는 raw `swift run`만 의존하지 않고 후속 `MOMO-134`에서 `.app` bundle staging + Codex Run action으로 보강하기로 했다.
- 런타임 코드 변경 없음. 이번 PR은 docs/spec 변경이며, M1 runtime-unverified 잔여 범위(WebSocket live subscribe/presence/recovery, APNs)는 그대로 유지된다.

## 0g. MOMO-150 Agent Runtime Research + Roadmap (2026-06-25)

- Hermes agent / internkim(Kim Intern) / openclaw를 기준으로 momo가 agent runtime의 단순 채널 어댑터가 아니라 context, memory, cache, approval, audit, cost를 소유하는 agent host가 되어야 한다는 결정을 문서화했다.
- 새 연구 정본: `research/11-agent-runtime/01-three-agent-runtime-analysis.md`, `02-memory-cache-protocol-gaps.md`, `03-roadmap-and-methodology.md`.
- 새 후속 로드맵: MOMO-151 Context Packet v0 deep spec, MOMO-152 Memory Plane v0, MOMO-153 Capability Cache v0, MOMO-160~163 backend protocol, MOMO-170~172 macOS/LLM UX.
- 런타임 코드 변경 없음. 이번 PR은 docs/spec 변경이며, M1 runtime-unverified 잔여 범위(WebSocket live subscribe/presence/recovery, APNs)는 그대로 유지된다.

## 0h. MOMO-151 Context Packet v0 Spec + Fixtures (2026-06-25)

- Context Packet v0 정본을 `research/11-agent-runtime/04-context-packet-v0.md`에 추가하고, request/scope/goal/source/memory/tool/budget/redaction/runtime envelope와 금지 필드를 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/context-packet-v0/`에 추가했다: mention thread summary, slash command ticket create, message context action ERM risk.
- 런타임 코드/스키마 변경 없음. `context_packet_id`의 DB 연결, Memory Plane, Capability Cache, approval pause/resume 구현은 후속 MOMO-152/153/160/161 범위다.

## 0i. MOMO-154 GitHub Actions Disabled + Local Gate Priority (2026-06-26)

- 조직 과금/결제 이슈로 `ci-build`, `release-ios`, `release-macos` 원격 workflow를 `disabled_manually` 상태로 전환했다. GitHub Actions green은 당분간 merge gate가 아니다.
- `.github/workflows/*.yml`의 자동 `push`/`pull_request`/tag 트리거를 제거하고 `workflow_dispatch` 전용으로 바꿨다. owner approval 전에는 workflow 재활성/수동 실행을 하지 않는다.
- PR 품질 기준은 `docs/LOCAL_PR_GATE.md`의 local evidence + review pass + no unrelated dirty files로 유지한다. 후속 `MOMO-111`은 이 흐름을 `scripts/local_gate.sh`로 자동화한다.

## 0j. MOMO-111 Local Gate Script + Evidence Flow (2026-06-26)

- `scripts/local_gate.sh`를 추가해 GitHub Actions disabled/manual-only 기간의 PR gate를 `docs`, `swift`, `runtime-db`, `runtime-relay`, `runtime-agent`, `macos-ui`, `all` profile로 실행하고 PR-ready `## Local Gate` evidence를 출력한다.
- `docs/LOCAL_PR_GATE.md`, `docs/GITHUB_OPS.md`, PR template, AGENTS/CODEX, ROADMAP/BUILD_TICKETS/INDEX가 모두 local gate script 우선 운영으로 정렬됐다.
- MOMO-115에서 `runtime-relay` 자동 검증 스크립트가 추가되어, 이제 relay/realtime PR은 `scripts/local_gate.sh --profile runtime-relay`로 Docker compose/migrate/server send/outbox/relay/Centrifugo history evidence를 남긴다.

## 0j-1. MOMO-115 Runtime Relay Local Gate Automation (2026-06-26)

- `scripts/verify_relay.sh`를 추가했다. seeded demo user로 MomoServer에 로그인해 REST message send를 수행하고, relay 시작 전 outbox `pending` + `payload.version=message.seq`를 확인한 뒤 OutboxRelay를 실행한다.
- 검증 범위: worktree별 `.env.worktree` 포트/compose project, `make up`, `make migrate` 멱등, server send, outbox pending, OutboxRelay SKIP LOCKED claim(`attempts>=1`), Centrifugo `/api/history` publication, outbox `done`, `version=message.seq` evidence.
- `scripts/local_gate.sh --profile runtime-relay`가 `scripts/verify_relay.sh`를 필수 shell syntax 및 runtime command로 포함한다. 남은 runtime-unverified 범위(WebSocket live subscribe/presence/recovery, APNs, Inbound MCP runtime)는 그대로다.

## 0k. MOMO-112 Multi-session Worktree Orchestration (2026-06-26)

- `scripts/goal_status.sh` status board를 추가해 ready/in-progress/needs-review/blocked issue와 branch/PR/local worktree/local gate evidence 상태를 한눈에 확인한다.
- `scripts/goal_claim.sh`, `scripts/goal_release.sh`, `.conductor/setup.sh`를 정본 운영 흐름으로 추가하고 `docs/MULTI_SESSION_OPS.md`를 5세션(`momo-main` + runtime/macOS/docs/infra workers) 운영 계약으로 확장했다.
- 런타임 e2e 범위는 변경하지 않았다. 이번 티켓은 운영/문서/스크립트 정본화이며, 신규 server/relay/agent runtime 검증은 후속 goal 범위다.

## 0l. MOMO-105 macOS SwiftPM Dev App (2026-06-26)

- `clients/macOS`에 `MomoMacDevApp` SwiftPM executable target과 SwiftUI `@main` App entrypoint를 추가했다. `swift run --package-path clients/macOS MomoMacDevApp`로 `MomoMacRootView`를 실제 macOS window에 호스트한다.
- `LiveChatBackend.seedDemo()`가 첫 채널에 `approval_request` 메시지, `agent.status`, `agent.partial`, pending approval 이벤트를 seed한다. 개발 앱 첫 화면에서 channel list, message list, Approval Inbox, cost UI가 함께 표시되는 경로다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build` pass, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test` pass, `swift run --package-path clients/macOS MomoMacDevApp` launch 후 WindowServer에서 `MomoMacDevApp` layer 0 window `window_count=1` 확인.
- Out of scope 유지: Developer ID signing, notarytool, DMG, Sparkle, App Store 배포.

## 0m. MOMO-152 Memory Plane v0 Spec + Permission Model (2026-06-26)

- Memory Plane v0 정본을 `research/11-agent-runtime/05-memory-plane-v0.md`에 추가하고, 장기 메모리를 `decision/preference/artifact_ref/task_state/external_source_ref/agent_skill_note` 6개 typed memory로 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/memory-plane-v0/`에 추가했다: typed memory catalog, retrieval 허용 Context Packet projection, retrieval 거부 permission examples.
- 검증: `jq empty research/11-agent-runtime/fixtures/memory-plane-v0/*.json`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` pass.
- 런타임 코드/스키마 변경 없음. memory DB migration, retrieval runtime, memory inspector, local LLM compaction 구현은 후속 MOMO-160/161/171/172 및 별도 migration 범위다.

## 0n. MOMO-153 Capability Cache v0 Spec + Fixtures (2026-06-26)

- Capability Cache v0 정본을 `research/11-agent-runtime/06-capability-cache-v0.md`에 추가하고, agent/plugin/MCP capability discovery를 `agent_capability/plugin_tool_schema/mcp_tool_list/model_pricing` 4개 cache kind로 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/capability-cache-v0/`에 추가했다: capability list snapshot, plugin tool schema projection, invalidation/audit examples.
- 검증: `jq empty research/11-agent-runtime/fixtures/capability-cache-v0/*.json` pass, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile docs` pass, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` pass.
- 런타임 코드/스키마 변경 없음. capability DB migration, MCP tool discovery runtime, plugin registry, macOS tool-call card 렌더는 후속 MOMO-160/161/163/170 범위다.

## 0o. MOMO-160 Agent Run Lifecycle v0 (2026-06-26)

- Agent Run Lifecycle v0 정본을 `research/11-agent-runtime/07-agent-run-lifecycle-v0.md`에 추가하고, A2A-style Task/Message/Artifact/status mapping과 `queued/running/input-required/awaiting-approval/succeeded/failed/cancelled` 7상태 의미를 고정했다.
- `input-required`는 추가 입력 요청, `awaiting-approval`은 `approval(status='pending')` 기반 side-effect gate로 분리했다. `clients/Core`에는 current DB `RunStatus`를 public lifecycle로 투영하는 `AgentRunLifecycleStatus`를 추가했다.
- 런타임 코드/스키마 변경은 하지 않았다. DB enum `input_required`, active index, AgentWorker `{phase, run_status}` event payload, approval pause/resume은 후속 migration/runtime goal에서 `runtime-unverified`로 닫아야 한다.

## 0p. MOMO-170 macOS Agent Protocol Cards UX (2026-06-26)

- macOS timeline card 정본을 `research/11-agent-runtime/07-macos-agent-protocol-cards-v0.md`에 추가했다. `tool_call`, `approval_request`, `tool_result`, `artifact`, cost, memory citation, source badge가 Context Packet/Memory Plane/Capability Cache projection으로 표시되는 계약이다.
- `clients/macOS`의 `MessageBubble`에 shared protocol metadata strip을 추가하고, `LiveChatBackend.seedDemo()`가 agent protocol card 4종과 context/source/memory/capability/cost props를 seed하도록 확장했다. `MomoMacRootView` API 변경은 없다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` pass. 런타임 DB/wire alignment, approval pause/resume executor, memory inspector는 후속 MOMO-132/MOMO-161/MOMO-171 범위이며 이번 티켓의 신규 runtime-unverified 항목은 없다(런타임 변경 없음).

## 0q. MOMO-161 Approval Pause/Resume Runtime (2026-06-26)

- Approval Pause/Resume Runtime v0 정본을 `research/11-agent-runtime/08-approval-pause-resume-runtime.md`에 추가하고, fixture를 `research/11-agent-runtime/fixtures/approval-pause-resume-v0/`에 추가했다. 핵심 흐름은 `tool_call → approval_request → approval_decision → resume/deny → tool_result/audit`이며, resume은 새 run이 아니라 같은 `agent_run.id`를 참조하는 새 `outbox(kind='agent_job')`로 정의했다.
- AgentWorker 최소 pause slice를 추가했다. approval-required `tool_call`은 단일 DB tx로 `approval(status='pending')`, `message(type='approval_request')`, `agent_run.status='awaiting_approval'`, `outbox(broadcast)`, `audit_log(action='approval.requested')`를 기록하고 현재 job을 종료해 `succeeded`로 흘러가지 않는다.
- 검증: AgentWorker smoke test가 approval pause plan과 approve/reject/expire outcome을 고정한다. Server approval decision endpoint는 MOMO-167, approved deterministic resume executor는 MOMO-178에서 후속 구현됐다. Expiry sweeper runtime은 계속 후속 `runtime-unverified`.

## 0r. MOMO-163 Inbound MCP Server v0 Spec + Fixtures (2026-06-26)

- Inbound MCP Server v0 정본을 `research/11-agent-runtime/09-inbound-mcp-server-v0.md`에 추가하고, 외부 Claude/Codex/Cursor류 host가 momo를 쓰는 최소 surface를 `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call`로 고정했다.
- JSON fixture 2종을 `research/11-agent-runtime/fixtures/inbound-mcp-server-v0/`에 추가했다: tools/resources/prompts discovery snapshot, approval-safe tool-call proposal.
- 런타임 코드/스키마 변경 없음. MCP server runtime, RLS/idempotency integration test, approval executor 연결은 후속 구현 범위다.

## 0r2. MOMO-172 Inbound MCP Server v0 Skeleton (2026-06-26)

- `server` package에 inbound MCP registry/model/route skeleton을 추가했다. `/v1/mcp`, `/v1/mcp/tools`, `/v1/mcp/tools/call`은 app JWT + `mcp.*` scope + workspace match + RLS `SET LOCAL` + member/channel membership preflight를 공유한다.
- `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call` descriptor와 policy를 Swift 코드로 고정하고, docs/INBOUND_MCP.md 및 RUN.md에 endpoint/security/permission model을 기록했다. `search_messages`는 v0에서 1-10개 `channel_ids`를 필수로 받고, 모든 채널 멤버십을 DB 실행 전 검증한다.
- 실제 MCP JSON-RPC transport, canonical `post_message` 실행, approval-safe `create_tool_call` transaction, RLS/idempotency runtime e2e는 `runtime-unverified` 후속 구현이다. 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test` in `server` pass.

## 0s. MOMO-164 Approval Gate Tool Policy Hotfix (2026-06-26)

- MOMO-161 사후 리뷰에서 발견한 approval gate stub 정책을 보강했다. `github.create_issue` 같은 write-like tool name은 approval-required로 처리하고, `github.search_issues`/`docs.search` 같은 read-only name만 v0 stub에서 직접 통과한다.
- unknown tool name은 Capability Cache risk metadata가 AgentWorker job payload에 연결되기 전까지 approval-required로 fail-closed 처리한다.
- AgentWorker가 생성하는 `approval_request` props에 `action_type`, `title`, `summary`를 추가해 macOS protocol card 렌더와 맞췄다.

## 0t. MOMO-165 Capability Cache Approval Metadata Gate (2026-06-26)

- AgentWorker `agent_job.payload`가 Context Packet / Capability Cache projection의 `tool_grants` metadata를 받을 수 있게 하고, G6 approval gate가 `approval_policy`/`risk`/`risk_level`을 tool-name heuristic보다 우선 사용하도록 연결했다.
- `approval_policy=require_approval`/`always`는 approval pause, `approval_policy=never/none/read_only`는 검증된 read-only grant(`grant=read`, `risk=read`)일 때만 직접 진행, metadata 없음/불일치/중복/unknown policy/source/risk alias 충돌은 approval-required로 fail-closed 처리한다.
- approval pause payload/props에 sanitized `tool_grant` evidence를 포함한다. 기존 MOMO-164 name heuristic은 legacy fallback으로만 남겼다. 검증: `swift test` — `workers/AgentWorker` pass. 실제 Hermes runtime e2e와 DB migration은 out of scope.

## 0t. MOMO-171 macOS approval_request Card Decisions (2026-06-26)

- `MomoCore.ChatBackend`에 `ApprovalDecisionRequest`/`ApprovalDecisionReceipt` 기반 approval decision 계약을 추가했다. `AgentTransport.decideApproval`은 호환 shim으로 남기고, macOS `ChatViewModel`의 승인/거절 intent는 `ChatBackend`를 통해 전달한다.
- macOS timeline `approval_request` 카드에 Approve / Reject 액션과 처리중 중복 클릭 방지를 추가했다. `LiveChatBackend.seedDemo()`는 card props와 approval inbox event가 같은 `approval_id`를 공유하며, decision receipt 후 `approval_status`/decision metadata를 message timeline에 반영한다.
- 검증: `swift test --package-path clients/macOS` pass(8 tests), `swift run --package-path clients/macOS MomoMacDevApp` build+launch 후 `MomoMacDevApp` process 및 window 1개 확인. 실제 server approval decision endpoint wiring은 out of scope이며 runtime-unverified.

## 0t2. MOMO-166 Approval Decision Server Contract v0 (2026-06-26)

- Approval Decision Server Contract v0 정본을 `research/11-agent-runtime/10-approval-decision-server-contract-v0.md`에 추가했다. MOMO-161 AgentWorker pause checkpoint, server approval decision endpoint, MOMO-171 macOS `ChatBackend.decideApproval` 흐름을 하나의 API/DB/event 계약으로 연결한다.
- JSON fixture를 `research/11-agent-runtime/fixtures/approval-decision-server-contract-v0/`에 추가했다: approve/reject request/response, expiry sweeper result, same-run resume `agent_job` payload, `approval.decided` realtime envelope.
- 검증: `jq empty research/11-agent-runtime/fixtures/approval-decision-server-contract-v0/*.json`, `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` pass. 런타임 코드/스키마 변경 없음. 실제 decision endpoint, idempotency migration, expiry sweeper, resume execution e2e는 후속 runtime ticket으로 분리하며 `runtime-unverified`.

## 0t3. MOMO-167 Approval Decision Endpoint Runtime (2026-06-29)

- `POST /v1/workspaces/{ws}/approvals/{approval}/decision`과 호환 경로 `POST /v1/agent-runs/{run}/approval-decisions`를 추가했다. app-role tenant transaction + active human/channel membership guard를 통과한 approve/reject만 `approval_decision` ledger, `audit_log`, `approval.decided` outbox를 남긴다.
- approve는 같은 `agent_run.id`를 `queued`로 돌리고 `outbox(kind='agent_job', method='resume_approval')`에 `resume_from_approval_id`/`approved_tool_call`/`policy_evidence`/`approval_decision` payload를 넣는다. reject는 run을 `cancelled`로 닫고 `tool_result` message를 남긴다. expired click은 409 receipt와 durable expired decision/audit을 남긴다.
- 검증: `swift test --package-path server`, `swift test --package-path workers/AgentWorker`, `scripts/verify_approval_decision.sh`, `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-db` pass. 실제 approved tool execution/provider side-effect 재개는 후속 AgentWorker runtime에서 계속 검증한다.

## 0t4. MOMO-178 AgentWorker Approved Tool Resume Executor v0 (2026-06-29)

- AgentWorker가 `outbox(kind='agent_job', method='resume_approval')` 또는 `payload.resume_from_approval_id`를 hermes 호출과 분리해 처리한다. Worker는 `approval.status='approved'`, same-run/channel/agent 일치, frozen `approved_tool_call`과 `approval.payload.tool_call` 일치, approval-required `policy_evidence`, approved decision payload를 fail-closed로 검증한다.
- v0 executor는 외부 write/plugin runtime 없이 `mock.echo`/`momo.mock.echo`/`deterministic.echo`만 실행한다. 성공 시 같은 `agent_run.id`에 `message(type='tool_result')`, `audit_log(action='approval.resume'/'tool.executed')`, broadcast outbox를 기록하고 resume job을 `done`으로 닫는다. 실패/unsupported/rejected-expired-cancelled approval은 실행하지 않고 `approval.resume_failed`/`tool.failed` audit와 failed outbox `last_error`를 남긴다.
- 검증: `swift test --package-path workers/AgentWorker` pass(22 tests). `scripts/verify_agent_worker.sh`에 approved deterministic resume smoke를 추가해 `tool_result`/audit/job-done/broadcast-outbox를 확인한다. Real GitHub/Jira/Google/provider side-effect execution은 out of scope이며 계속 `runtime-unverified`.

## 0u. MOMO-173 Worker PR Handoff Boundary (2026-06-26)

- worker 종료점을 PR 생성 + `status:needs-review` + `momo-main` handoff로 고정했다. worker는 merge/close/post-merge main gate/로드맵 조정을 하지 않고, 해당 권한은 `momo-main` 전용이다.
- AGENTS/CODEX, multi-session ops, local PR gate, PR template, goal release/status 스크립트가 같은 handoff 계약을 표시한다. `scripts/verify_relay.sh`는 여전히 runtime-relay 전용 미구현 verifier로 남기되 docs gate shell syntax에서만 optional 처리했다. 런타임 코드 변경은 없으며 검증 범위는 docs/script/Swift local gate다.

## 0v. MOMO-005 staging/prod compose skeleton (2026-06-26)

- `infra/prod/docker-compose.prod.yml`, `Caddyfile`, `centrifugo.prod.json`, `.env.example`를 추가해 단일 VPS용 staging/prod skeleton을 준비했다. 구성은 Caddy 자동 TLS, PostgreSQL 18, Redis, Centrifugo v6 Redis engine, api/relay/worker 서비스다.
- 실제 시크릿은 커밋하지 않고 `.env.example` placeholder와 `.gitignore` prod env ignore 규칙만 제공한다. 운영 시크릿 암호화(SOPS/age), pgBackRest, staging 실기동은 MOMO-006/007 후속 범위다.
- 검증: `jq empty infra/prod/centrifugo.prod.json`, `docker compose --env-file infra/prod/.env.example -f infra/prod/docker-compose.prod.yml config`, `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상. 실제 VPS 배포/TLS 발급은 수행하지 않아 `runtime-unverified`.

## 0w. MOMO-010 Onboarding Invite Code Migration (2026-06-26)

- `server/Migrations/003_onboarding.sql`을 추가해 `schema_v0.sql` 정본 변경 없이 `invite_code` + `invite_code_redemption` 테이블, high-entropy code generator/hash helper, expiry/revoke/usage constraints, same-workspace member FKs, active lookup indexes, RLS FORCE 정책을 준비했다.
- `scripts/verify_rls.sh`의 runtime fixture가 `invite_code` FORCE RLS 및 A/B workspace 교차 미노출을 함께 검증하도록 확장됐다.
- 검증: `scripts/local_gate.sh --profile runtime-db` PASS(001/002/003 적용 + 재실행 skip 3 + invite_code RLS), `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. `platform_admin`, onboarding REST, self-signup e2e는 후속 MOMO-011~013 범위다.

## 0x. MOMO-006 SOPS/age + pgBackRest Skeleton (2026-06-26)

- SOPS+age secret lifecycle과 pgBackRest PITR 운영 skeleton을 추가했다: `.sops.yaml.example`, `infra/prod/secrets.env.example`, `infra/prod/pgbackrest*.example`, `docs/SECRETS_BACKUP_RUNBOOK.md`.
- 실제 production secret, age private key, object-store credential은 추가하지 않았다. MOMO-005 prod compose skeleton은 존재하지만 실제 staging host/stanza/check/full backup/PITR restore rehearsal은 `runtime-unverified`로 남는다.

## 0y. MOMO-080 Legal L0/L1 Registration Readiness (2026-06-26)

- `docs/legal/01-entity-apple-runbook.md`를 L0/L1 등록 준비 런북으로 확장했다. 등록주체(개인/조직), D-U-N-S, Apple Developer Program 등록, 필요한 정보/증빙, 사람 handoff와 Codex repo 산출물 경계를 분리했다.
- `docs/legal/00-prelaunch-admin-legal-checklist.md`, `docs/cicd/01-setup-runbook.md`, `docs/INDEX.md`, `ROADMAP.md`가 이 런북을 법무/CI 선행 경로로 참조한다.
- 실제 D-U-N-S 조회/신청, Apple 계약 동의, $99/년 결제, Team ID/API Key/인증서 확보는 사람 `[manual]` 절차로 남아 있다. 이번 티켓은 런타임/코드 변경 없음.

## 0z. MOMO-007 Local/Staging Smoke Gate (2026-06-26)

- `scripts/verify_staging_smoke.sh`를 추가해 실제 VPS 시크릿 없이 prod compose config, Caddyfile 구조, Centrifugo Redis prod config, prod secret template/real-secret guard, SOPS/pgBackRest checklist를 검증한다.
- `scripts/local_gate.sh --profile staging-smoke`를 추가하고 `docs/LOCAL_PR_GATE.md`, `docs/RUN.md`, `docs/DEPLOY.md`, `docs/SECRETS_BACKUP_RUNBOOK.md`, `ROADMAP.md`, `BUILD_TICKETS.md`를 local gate + host-runtime 경계로 정렬했다.
- 검증: `scripts/verify_staging_smoke.sh`, `scripts/local_gate.sh --profile staging-smoke`, `scripts/local_gate.sh --profile docs`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. PR evidence는 clean worktree에서 재확인한다.
- `runtime-unverified`: 실제 staging URL/TLS, Caddy parser/healthcheck(로컬 caddy binary 부재 시), SOPS 복호화, pgBackRest stanza/check/full backup/PITR restore rehearsal, 외부 hermes staging 연결.

## 0aa. MOMO-011 Invite Code REST API Slice (2026-06-26)

- `InviteRoutes`를 추가해 `POST/GET /v1/workspaces/{ws}/invites`, `POST /v1/workspaces/{ws}/invites/{invite}/revoke`, `POST /v1/workspaces/{ws}/invites/redeem` 최소 slice를 구현했다. raw invite code는 create 응답에서만 반환하고 DB에는 MOMO-010의 `momo_invite_code_hash()` 결과만 저장한다.
- 권한 guard는 path workspace와 JWT workspace 일치 확인 + owner/admin active membership(create/list/revoke) + active member redeem으로 닫았다. 모든 invite DB 접근은 `withTenantTransaction`의 `SET LOCAL app.workspace_id` 아래에서 수행해 RLS와 same-workspace FK를 유지한다.
- 검증: `LOCAL_GATE_ALLOW_DIRTY=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile runtime-db` PASS(전체 swift build/test + Docker compose + migrate 2회 + RLS tenant isolation). 로컬 HTTP smoke도 login 200 → invite create 201 → list 200 → redeem 200 → revoke 200으로 PASS. self-signup의 member/human/membership 생성과 audit_log 기록은 MOMO-014 후속 범위다.

## 0ab. MOMO-012 macOS Onboarding Invite UI (2026-06-26)

- `MomoMacDevApp` sidebar에 invite code 입력/상태 UI를 추가하고, `ChatViewModel`이 `OnboardingInviteBackend`를 통해 join 상태를 게시하도록 했다.
- 실제 서버 `/v1/join`이 완성되기 전까지 `LiveChatBackend`가 `MOMO-012`/`MOMO-DEV` 성공, `EXPIRED`/`USED-UP`/기타 실패를 결정적으로 시뮬레이션한다. 기존 channel/message/approval/cost UI와 `MomoMacRootView` API는 유지했다.
- 검증: `swift test --package-path clients/macOS` pass(10 tests), `scripts/local_gate.sh --profile macos-ui` PASS, `scripts/local_gate.sh --profile swift` PASS. Production invite REST/e2e는 후속 MOMO-014 범위다.

## 0ac. MOMO-130 macOS Foundation Models Capability Probe (2026-06-26)

- `clients/macOS`에 Foundation Models capability probe를 추가했다. Apple framework 접근은 `MomoMac` target 안의 `#if canImport(FoundationModels)` + `#available(macOS 26.0, *)` guard에만 있으며, `MomoCore`는 Foundation-only를 유지한다.
- `SystemLanguageModel.default.availability`를 `available` 또는 server fallback state로 매핑하고, `MomoMacDevApp` sidebar에 Local LLM capability state surface를 추가했다. 미지원 OS/toolchain, device ineligible, Apple Intelligence off, model-not-ready는 모두 fallback으로 표시된다.
- 검증: `swift test --package-path clients/macOS` pass(12 tests), `swift run --package-path clients/macOS MomoMacDevApp` launch 후 System Events window count 1 확인, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui` PASS, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS. Local summarization/classification runtime은 후속 MOMO-131/174 범위다.


## 0ad. MOMO-162 Hermes Adapter Contract Verification (2026-06-26)

- 당시 Hermes integration mode를 AgentWorker product default + platform adapter optional ingress/interop로 고정했다. 이 경로 우열 결정은 2026-07-12 ADR-0102 Option C가 gateway=BYOA / worker=managed 두 공식 경로로 supersede했고, 서버 소유 보장 매트릭스는 유지·확장됐다.
- 새 정본: `research/11-agent-runtime/11-hermes-adapter-contract-v0.md`. JSON fixture 2종: `agentworker_openai_sse_input.json`, `platform_adapter_event_mapping.json`. Hermes SDK 없이 도는 `adapters/hermes/tests/test_momo_adapter_contract.py` lightweight contract test를 추가했다.
- Swift-facing contract는 변경하지 않았다. 실제 Hermes gateway plugin load/live adapter e2e는 여전히 `runtime-unverified`; MOMO-004의 repo-local OpenAI-compatible mock 기반 AgentWorker SSE 검증은 유지된다.

## 0ae. MOMO-014 Public Invite Join Runtime (2026-06-26)

- Public `POST /v1/join`을 추가했다. invite code + email/display name/handle로 human/member를 생성 또는 재사용하고, workspace의 public channel membership, invite redemption, `audit_log(action='invite.join')`, access/refresh token receipt를 한 tenant transaction 경로로 만든다.
- invite lookup은 별도 RLS 우회 helper 없이 workspace id를 열거한 뒤 각 workspace에서 `SET LOCAL app.workspace_id` tenant read로 code hash를 확인한다. 실제 write path는 계속 `withTenantTransaction` + FORCE RLS 아래에서 수행한다.
- `scripts/verify_join.sh`와 `runtime-db` local gate coverage를 추가했다. 검증 대상: invite create → public join → login/bootstrap/channel read, invalid/expired/revoked/exhausted/duplicate/role-escalation 실패. `schema_v0.sql` 변경 없음.

## 0af. MOMO-013 Platform Admin Read-Only Inspection (2026-06-27)

- `GET /v1/platform/workspaces`, `/v1/platform/members`, `/v1/platform/invites`를 추가했다. `platform:read` scope가 있는 v0 platform admin token만 접근 가능하고, 일반 tenant token은 403이다. v0 login stub의 위험을 줄이기 위해 `PLATFORM_ADMIN_EMAILS` allowlist와 `PLATFORM_ADMIN_LOGIN_SECRET`이 모두 맞을 때만 `platform:read`을 발급한다.
- platform read path는 `PLATFORM_ADMIN_DATABASE_URL`의 별도 BYPASSRLS + SELECT-only role로만 실행되며 `SET TRANSACTION READ ONLY`를 적용한다. 일반 tenant write/read path는 계속 `DATABASE_URL` + `withTenantTransaction`/`SET LOCAL app.workspace_id` 경로를 사용한다.
- `scripts/verify_platform_admin.sh`를 `runtime-db` local gate에 연결했다. 두 개 이상 workspace fixture에서 일반 token 거부, platform 전역 workspace/member/invite usage 조회, invite raw/hash secret 미노출을 검증한다. `schema_v0.sql` 변경 없음.

## 0ag. MOMO-168 Hermes Adapter Repo-Local Smoke Harness (2026-06-27)

- `adapters/hermes/tests/smoke_momo_adapter.py`를 추가해 Hermes SDK/네트워크 없이 `platform_adapter_event_mapping.json` Centrifugo fixture → adapter event unwrap → REST invoke/final-message capture를 검증한다.
- `scripts/local_gate.sh --profile docs`가 adapter `py_compile`, contract unittest, repo-local smoke를 모두 실행하도록 연결했다. adapter docs/contract/ROADMAP/BUILD_TICKETS도 live Hermes boundary를 갱신했다.
- 실제 Hermes gateway plugin load 및 live momo+Centrifugo+Postgres platform-adapter e2e는 여전히 `runtime-unverified` 후속 범위다.


## 0ah. MOMO-122 Google Workspace Connector v0 Spec + Fixtures (2026-06-27)

- Google Workspace Connector v0 정본을 `research/11-agent-runtime/12-google-workspace-connector-v0.md`에 추가했다. v0 기본 경로는 per-user OAuth + Drive/Gmail/Calendar read-mostly sync이며, token boundary, scopes, revocation/delete, Context Packet `sources`, Memory Plane `external_source_ref`, Capability Cache `tool_grants` projection을 고정한다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/google-workspace-connector-v0/`에 추가했다: Drive selected-file source ref/context projection, Gmail thread/search source ref, Calendar availability/events projection.
- Gmail send, Calendar create/update, Drive share/upload/permission change 같은 external write는 approval-gated 또는 v0 out of scope로 명시했다. 런타임 코드/스키마 변경 없음. 실제 Google OAuth/API sync runtime은 후속 구현 범위이며 `runtime-unverified`.

## 0ah2. MOMO-123 Google Workspace Enterprise Admin v0 (2026-06-29)

- Google Workspace Enterprise Admin v0 정본을 `research/11-agent-runtime/13-google-workspace-enterprise-admin-v0.md`에 추가했다. MOMO-122 per-user OAuth 기본값과 분리해 enterprise admin install / domain-wide delegation을 enterprise-only option으로 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/google-workspace-enterprise-admin-v0/`에 추가했다: admin install scope inventory, DWD delegated Context Packet/Memory Plane/Capability Cache projection, audit export + revoke/delete flow.
- admin consent, service account boundary, user delegation, scope inventory, audit export, revoke/delete, Context Packet/Memory/Capability invalidation을 문서화했다. 실제 Google Workspace admin 승인/API Controls/OAuth verification/service account credential setup은 사람 `[manual]` 범위이며 runtime/schema 구현은 없다.

## 0ai. MOMO-131 macOS Local Context Copilot v0 (2026-06-27)

- `clients/macOS`에 `LocalContextCopilotService`/preview model과 sidebar `Context Copilot` surface를 추가했다. visible channel messages에서 summary, intent/risk classification, compact context packet preview, PII/secret redaction hint, `S1`-style source/citation hints를 생성한다.
- Foundation Models capability가 available이면 local route로 표시하고, unsupported OS/toolchain/device/model-not-ready 계열은 deterministic fallback route로 같은 preview UI를 유지한다. 실제 Foundation Models generation/session call은 MOMO-174 follow-up 범위이며 v0 shell은 fallback-safe deterministic preview로 검증한다.
- 검증: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS` pass(16 tests). `scripts/local_gate.sh --profile macos-ui`와 `scripts/local_gate.sh --profile swift` evidence는 PR 전 재확인한다.

## 0aj. MOMO-174 Source-Preserving Local Context Compaction v1 (2026-06-29)

- `LocalContextCopilotService`를 Context Packet 스타일 compact output v1으로 확장했다. summary/classification/redaction/source hints가 `momo.context_packet.compaction.v1` packet에서 파생되고, source id/URI/citation은 compaction 후에도 `sourceReferences`에 보존된다.
- Foundation Models 실제 generation route는 `#if canImport(FoundationModels)` + `#available(macOS 26.0, *)` wrapper 뒤에 두었다. 호출 실패나 미지원 환경은 deterministic fallback packet으로 같은 테스트가 통과한다.
- macOS sidebar는 전체 URI가 들어간 compact packet 대신 짧은 `sidebarPreview`와 2줄 source row를 표시해 preview가 과하게 넘치지 않도록 했다. 검증: `swift test --package-path clients/macOS` pass(16 tests), `scripts/local_gate.sh --profile macos-ui` PASS, `scripts/local_gate.sh --profile swift` PASS.

## 0ak. MOMO-134 macOS SwiftPM Dev Run Loop (2026-06-29)

- `scripts/macos_dev_run.sh`를 추가해 build-macos-apps SwiftPM GUI workflow에 맞춘 dev-only run loop를 고정했다. `MomoMacDevApp`을 빌드하고 `dist/MomoMacDevApp.app`으로 staging한 뒤 `/usr/bin/open -n`으로 실행한다.
- 옵션: `--verify` process/window smoke, `--logs` unified log capture, `--telemetry` subsystem log capture, `--debug` lldb, `--terminate`/`--terminate-only` cleanup. Xcode `.app` 패키징, Developer ID signing, 공증, DMG/Sparkle은 M4 범위로 유지한다.
- `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui`는 새 dev run script로 launch→verify→logs→terminate evidence를 만들고, 기본 `macos-ui` profile은 계속 GUI launch opt-in으로 유지한다. 검증: `scripts/local_gate.sh --profile macos-ui` PASS, `scripts/local_gate.sh --profile swift` PASS.

## 0al. MOMO-175 AgentWorker Local Gate Isolation Hotfix (2026-06-29)

- post-merge `scripts/local_gate.sh --profile all`에서 MOMO-167 approval decision 검증이 생성한 same-run resume `agent_job`가 MOMO-004 AgentWorker verifier 전에 정상 처리되면서 같은 workspace budget window를 함께 소비하는 조합을 확인했다.
- 실제 product/runtime 회귀는 아니었다. DB상 approval resume run과 AgentWorker success fixture run은 모두 `succeeded`, 각 `usage_ledger`는 prompt=11/completion=7/cost=6으로 정확했지만, 공유 `budget_window.spent_micro_usd`가 단독 실행 기대값 `6`이 아니라 `12`가 되어 gate assertion만 실패했다.
- `scripts/verify_agent_worker.sh`는 target run의 `agent_run`/`outbox`/`usage_ledger`/Centrifugo partial 검증은 그대로 엄격하게 유지하고, 공유 workspace budget window는 reservation release와 최소 target spend(`spent_micro_usd>=6`)를 확인하도록 정리했다.

## 0am. MOMO-180 Agentic Work OS Market + Repo Topology ADR (2026-06-29)

- Paca/OpenHands/Linear/Rovo/GitHub Copilot/Slack/MCP/A2A 흐름을 기준으로 momo의 포지션을 "agent execution ledger가 있는 messenger / enterprise agent host / protocol surface"로 문서화했다. 정본: `research/12-agentic-work-os/01-agentic-work-os-market-analysis.md`.
- repo split 판단을 ADR로 고정했다. M3/M4까지 `momo` core monorepo를 유지하고, 안정화 후 `momo-plugins`, first-party plugin repos, plugin SDK repos, `momo-mcp`, `momo-landing`, private `momo-signing` 경계부터 분리한다. 정본: `docs/adr/0001-agentic-work-os-repo-topology.md`.
- Docker/deploy layering은 dev/e2e/prod/install/upgrade/backup으로 나누되, 실제 repo split, plugin runtime, prod installer 구현은 MOMO-181~184 후속으로 남겼다. 코드/스키마/런타임 변경 없음.

## 0an. MOMO-181 Plugin Manifest v0 + Catalog Split Criteria (2026-06-29)

- Plugin Manifest v0 정본을 `research/12-agentic-work-os/02-plugin-manifest-v0.md`에 추가했다. 최소 manifest fields, capability grants, approval/source/audit/signature policy, Compatibility matrix, `momo-plugins` catalog split 기준, first-party plugin repo/SDK repo split 기준을 고정했다.
- JSON fixture 3종을 `research/11-agent-runtime/fixtures/plugin-manifest-v0/`에 추가했다: GitHub Issues plugin manifest, Google Workspace read-mostly source plugin manifest, high-risk write action approval policy example.
- Context Packet `tool_grants`, Capability Cache `plugin_tool_schema`, Memory Plane permission/policy_version 연결을 문서화했다. 검증: `scripts/local_gate.sh --profile docs` PASS. 실제 plugin runtime, repo split, WASM runtime, marketplace UI, external OAuth implementation은 out of scope이며 런타임/스키마 변경 없음.

## 0an-1. MOMO-181/#178 Plugin Manifest/Catalog v0 Clarification (2026-06-30)

- Plugin Manifest v0를 GitHub issue #178 수용기준에 맞춰 재정본화했다. `plugin_id`, `tools`, `scopes`, `audit_surface`, `ui_surfaces`, `runtime_boundary`, `license`, `provenance`를 명시하고, 기존 compact fixture fields에서 catalog admission이 도출해야 할 항목으로 고정했다.
- `momo-plugins`를 Paca식 app catalog가 아니라 core bundled / first-party repo / third-party custom / private enterprise plugin의 signed capability evidence catalog로 정의했다. 모든 class는 Manifest/Catalog evidence → Capability Cache `plugin_tool_schema` → Context Packet `tool_grants` → approval metadata gate → channel timeline/audit result 경로를 공유한다.
- 런타임/스키마/repo split 구현은 out of scope다. 검증: `scripts/local_gate.sh --profile docs` PASS(clean worktree, dirty files 0). 실제 plugin runtime/external signing/marketplace UI/OAuth execution은 계속 후속 `runtime-unverified` 범위다.

## 0an2. MOMO-183 First-Party Plugin Repo Strategy (2026-06-29)

- First-party plugin repo strategy 정본을 `research/12-agentic-work-os/03-first-party-plugin-repo-strategy.md`에 추가했다. 우선순위는 GitHub/GitHub Issues → Google Workspace → Jira-like work items → Docs connector이며, repo split 순서와 public/private visibility 기준을 고정했다.
- 각 plugin의 slash command, message context action, approval card, source provider, audit event를 표로 정의하고 Plugin Manifest v0, Context Packet `tool_grants`, Capability Cache `plugin_tool_schema`, Memory Plane permission/revalidation model과 연결했다.
- 런타임/스키마 변경 없음. 실제 plugin runtime, repo split 생성, external OAuth/provider API execution, WASM runtime, marketplace UI는 out of scope다. 검증: `scripts/local_gate.sh --profile docs` PASS.

## 0ao. MOMO-182 Docker Compose Layer ADR (2026-06-29)

- Docker compose/deploy layer 정본을 `docs/adr/0002-docker-compose-layering.md`에 추가했다. dev(`infra/docker-compose.yml`), future e2e(`infra/docker-compose.e2e.yml`), prod(`infra/prod/docker-compose.prod.yml`), install/upgrade, backup/PITR 책임 경계를 고정했다.
- Prod는 source checkout 없는 image-based deploy를 원칙으로 두고, Caddy 기본 TLS, optional external DB/TLS, optional agent runtime 경계를 문서화했다. 실제 prod deploy, image publish pipeline, install/upgrade 구현, pgBackRest restore rehearsal, staging/prod secret 입력은 out of scope이며 필요한 부분은 `runtime-unverified`로 유지한다.
- 코드/스키마/런타임 변경 없음. 검증: `scripts/local_gate.sh --profile docs` PASS.

## 0ap. MOMO-177 macOS MomoServer REST ChatBackend v0 (2026-06-29)

- `clients/macOS`에 `MomoServerRESTChatBackend`를 추가해 `MomoMacDevApp`이 `MOMO_SERVER_BASE_URL` 설정 시 MomoServer REST `/v1/auth/login` + message history/send 경로를 사용한다. 설정이 없으면 기존 `LiveChatBackend.seedDemo()` fallback을 유지한다.
- REST mode는 `server/Migrations/002_seed.sql` demo workspace/channel/member fixture를 dev-safe 기본값으로 쓰고, unauthorized/offline/decoding 실패는 `ChatViewModel.connectionError` banner로 표시한다.
- 검증: `swift test --package-path clients/macOS` pass(19 tests). WebSocket/Centrifugo live subscription, full auth/session UI, server approval endpoint 변경은 out of scope이며 `runtime-unverified`.

## 0ap2. MOMO-197 Server channel list + macOS dynamic loading v0 (2026-06-29)

- `GET /v1/workspaces/{ws}/channels`를 추가했다. 일반 tenant token + active workspace membership guard + active channel membership filter + `SET LOCAL app.workspace_id` RLS 경로만 사용하며, tenant read path에 BYPASSRLS는 쓰지 않는다.
- `MomoCore.ChatBackend.channels(workspace:)` 계약을 추가하고, `MomoServerRESTChatBackend`가 REST mode bootstrap에서 서버 channel list를 읽어 `ChatViewModel.channels`를 채운다. 실패는 `connectionError`에 남기며, `MOMO_SERVER_BASE_URL` 미설정 시 기존 `LiveChatBackend.seedDemo()` fallback은 유지된다.
- 검증: `swift test --package-path server` PASS, `swift test --package-path clients/macOS` PASS. `scripts/verify_channel_list.sh`를 runtime-db local gate에 연결했다.

## 0aq. MOMO-185 AgentWorker All-Profile Gate Isolation Hotfix (2026-06-29)

- post-merge `scripts/local_gate.sh --profile all`에서 `verify_approval_decision.sh`가 남긴 `resume_approval` agent_job을 `verify_agent_worker.sh`가 먼저 claim하는 verifier 간섭을 확인했다.
- 제품 회귀는 아니었다. MOMO-178 v0 executor는 `github.create_issue` 같은 외부 write tool을 deterministic mock allowlist 밖으로 보고 fail-closed 처리했으며, 실패 지점은 all-profile fixture isolation이었다.
- `scripts/verify_agent_worker.sh`는 demo workspace의 pending/processing `agent_job` queue를 시작 전에 비워 자기 fixture만 검증하도록 정리했다. 또한 all-profile에서 직전 OutboxRelay가 tool_result broadcast를 즉시 `done`으로 소비할 수 있으므로, broadcast 검증은 `pending|done` non-failed row 존재로 고정했다. MOMO-178의 unsupported tool fail-closed 동작은 유지한다.

## 0aq. MOMO-184 Agent Host Product Messaging (2026-06-29)

- `research/12-agentic-work-os/03-agent-host-positioning.md`를 추가해 momo 제품 문장을 **channel timeline execution ledger** 중심으로 고정했다. Slack/Discord/Mattermost/Paca/OpenHands 대비 1페이지 비교와 website/README/sales deck reusable copy block을 포함한다.
- `README.md`, `ROADMAP.md`, `BUILD_TICKETS.md`, `docs/INDEX.md`에 정본 링크와 상태를 반영했다. agent host, protocol surface, self-hosted trust boundary, local LLM future 방향을 제품 copy에 연결했다.
- 코드/스키마/runtime 변경은 없으며 runtime 영향 없음. 검증: `scripts/local_gate.sh --profile docs` PASS.

## 0ar. MOMO-194 Parallel-Safe Local Gate Evidence Filenames (2026-06-29)

- `scripts/local_gate.sh` evidence/log 파일명을 `profile + UTC second + pid + nanosecond timestamp + worktree hash + random suffix` 기반 run id로 생성하도록 바꿔, 같은 초에 같은 profile gate를 병렬 실행해도 파일 충돌을 피한다.
- PR body에 붙이는 `## Local Gate` block에 `Run ID`, 정확한 `Evidence markdown`, `Evidence log` 경로를 함께 출력한다.
- 런타임/스키마 변경은 없으며 검증 대상은 docs local gate와 병렬 docs smoke다.

## 0as. MOMO-199 Worktree Stale Audit (2026-06-29)

- `scripts/goal_status.sh`가 open goal board 뒤에 closed issue 또는 merged/closed PR에 연결된 local worktree를 read-only로 audit하는 stale/done 섹션을 출력한다.
- clean + pushed/merged 상태만 `done-candidate`로 copy-paste 가능한 `git worktree remove ...` 안내를 표시하고, dirty/current/unpushed/upstream-unknown worktree는 `stale-warning`으로 cleanup command를 숨긴다.
- 런타임/스키마 변경 없음. 검증 대상은 shell syntax, real GitHub/local worktree read-only board smoke, docs local gate다.

## 0at. MOMO-225 Internal Alpha Combined Local Gate (2026-07-01)

- `scripts/local_gate.sh --profile internal-alpha`를 추가해 host-runtime, backup restore, macOS real-backend UI, diagnostics를 한 PR-ready evidence packet으로 묶는다. 이 profile은 `LOCAL_GATE_LAUNCH_UI=1`을 필수로 요구하며, 각 verifier artifact를 local gate output directory의 run-specific `internal-alpha-<run-id>/{host-runtime,backup-restore,macos-real-backend,diagnostics}/` 아래에 모은다.
- evidence packet에는 prod+internal-smoke image boot/health/migrate/message/relay/mock Kim Intern, repo-local `pg_dump`→separate restore, `MomoMacDevApp` real-backend process/window/log, redacted diagnostics directory/archive path를 포함한다.
- 실제 public TLS/DNS, real registry pull, SOPS production secret injection, external Hermes staging, production pgBackRest stanza/check/full backup/WAL/PITR restore는 계속 `runtime-unverified(public host)`다. 검증: 구현 중 `LOCAL_GATE_ALLOW_DIRTY=1 LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha` PASS; PR evidence는 commit 후 clean worktree에서 재실행한다.

## 0au. MOMO-237 Local Docker Alpha RC Gate (2026-07-01)

- AWS 리소스를 만들기 전에 닫는 1인 local Docker RC profile로 `scripts/local_gate.sh --profile local-alpha`를 추가했다. 이 profile은 local image host-runtime boot, migration idempotency, `/health`, REST message, OutboxRelay publish, mock Hermes/Kim Intern roundtrip, backup restore rehearsal, macOS real-backend smoke, redacted diagnostics bundle을 run-specific `local-alpha-<run-id>/` packet에 모은다.
- `local-alpha`는 AWS API 호출/리소스 생성 없이 local Docker, local Swift packages, repo-local mock Hermes, local diagnostics만 사용한다. foreground `MomoMacDevApp` process/window/log evidence는 `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile local-alpha`로 opt-in한다.
- 실제 AWS host creation, public DNS/TLS, registry pull, SOPS decrypt, production pgBackRest WAL/PITR, real external Hermes credentialed side effect, notarized macOS release app, iOS/APNs는 out of scope이며 계속 `runtime-unverified(public host/external provider/release)`. 검증: `scripts/local_gate.sh --profile docs` 및 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상.

## 0av. MOMO-240 Local Alpha Runner (2026-07-01)

- `scripts/local_alpha_runner.sh`를 추가해 plan/dry-run과 execute를 분리했다. execute는 repo 밖 evidence 디렉터리에 dev env/임시 Centrifugo config/compose override/log/summary/stop script를 만들고, PG18+Centrifugo → migrate → RLS role prep → mock 또는 external Hermes env 확인 → MomoServer/OutboxRelay/AgentWorker → `MomoMacSmoke` 순서로 내부 알파 stack을 띄운다. `execute --hermes mock --stop-after-smoke`는 로컬 Docker/Swift runtime에서 통과했다.
- secret env는 `--secret-env /absolute/path`만 받으며 repo 내부 경로를 거부한다. AWS 리소스 생성은 없고, 실행 결과는 `summary.md`에 URL(`MomoServer`, `Centrifugo`, Hermes), redacted env, logs/evidence path, macOS dev launch command로 남긴다.
- 현재 main의 macOS dev app surface는 Xcode `.app`이 아니라 SwiftPM `MomoMacSmoke`이므로 runner는 해당 launch command를 출력한다. external Hermes 실연결과 packaged `.app` 런치는 각각 제공자/ M4 Xcode 프로젝트가 필요하다.

## 0aw. MOMO-241 Local 3-Day Alpha Test Pack (2026-07-01)

- `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`를 추가해 72시간 로컬 dogfood의 Day 0 readiness, Day 1 messenger, Day 2 agent runtime, Day 3 soak/final decision 체크리스트를 정본화했다.
- 최종 판정값을 `AWS_READY` / `BLOCKED` / `NEEDS_MORE_LOCAL`로 고정하고, P0/P1/P2/P3 triage, daily report, evidence directory layout, start/stop/restart/recovery, MOMO-246 final report template을 추가했다.
- `docs/INTERNAL_ALPHA.md`, `docs/AWS_INTERNAL_ALPHA.md`, `docs/LOCAL_PR_GATE.md`, `docs/INDEX.md`, `ROADMAP.md`, `BUILD_TICKETS.md`가 새 72h local dogfood contract를 참조한다. 실제 72시간 실행, credentialed external agent runtime side effect, local soak/resource monitor는 MOMO-242~246에서 계속 검증한다.

## 0ax. 재설계 2026-07 기획 정본화 — MOMO-300~323 (2026-07-06)

- 전체 코드베이스 진단(클라/서버/기획 3트랙) + 외부 레퍼런스 리서치(astryx/openagents/Codex app/Slack Kit/Discord/Compass/Apple on-device AI/pgvector/GWS)를 `research/13-redesign/01~03`으로 정본화했다. 핵심 진단: 디자인 시스템 부재, 메신저 테이블스테이크스 미티켓화, AgentWorker 단일 메시지 컨텍스트(히스토리 미전달), MCP 스텁/프로토콜 고립, 보안 갭(subscribe proxy 미인증/token revocation 미검사/rate limit 부재/BYOK 부재), 스키마 안전장치 누락(`agent_run` depth/round, `reversibility_tier`).
- 재설계 티켓 24건(MOMO-300~323)을 `docs/BACKLOG.md` §4 재설계 섹션에 Phase 0(게이트/도구)→1(P0 코어)→2(P1 확장)→3(P2 마감) 순서로 기재하고, `ROADMAP.md` §1.3 overlay와 실행 팔로업 보드 `research/13-redesign/00-execution-tracker.md`를 추가했다. 파일 저장은 자체 오브젝트 스토리지 대신 Google Drive workspace archive 모드(공유 드라이브 + SA `shared_drive_member`, internal-consent 검증 면제)로 확정했다.
- UI 품질 자동화 도구를 설치했다: `.claude/skills/momo-design-taste/`(SwiftUI anti-slop 하드 룰 + mechanical pre-flight + MomoDS 토큰 계약 시드) + `.claude/agents/design-review.md`(스크린샷 rubric 리뷰, Blocker 자동 반송). UI PR은 design-review 리포트(Blocker 0)를 evidence로 포함한다.
- 문서/기획만 변경 — 코드/스키마/게이트 스크립트 변경 없음, 빌드 영향 없음. 다음 착수 = **MOMO-316(게이트 Wave 1)** → MOMO-300/301/302/303 병렬. 재설계 티켓 종료 시 이 STATUS와 tracker를 함께 갱신한다.

## 0ay. MOMO-316 Local Gate Wave 1 — --auto 프로파일 + compose --wait + 멱등 1-run (2026-07-06)

- `scripts/local_gate.sh --auto` 추가: `git diff --name-only <base>...HEAD`(base=`LOCAL_GATE_BASE_REF`/origin/main, 폴백 local main) + uncommitted 변경을 보수적 경로 매핑으로 프로파일 자동 선택(docs/clients/server/Migrations/relay/workers/infra(prod)/scripts 매핑, 모호·미매핑 경로는 `all`로 넓힘 — 좁히는 추측 금지). `--profile` 명시가 항상 우선(동시 지정 시 override 로그), 제안 프로파일과 per-path 이유는 evidence markdown의 "Auto profile selection" 섹션에 기록된다.
- compose 기동 대기를 healthcheck 기반 `docker compose up -d --wait`로 교체: `make up`(postgres/centrifugo healthcheck), `scripts/verify_internal_host_runtime.sh`(internal-smoke override에 api `/health` healthcheck + caddy 짧은 간격 healthcheck 추가, `swift-service.Dockerfile` 런타임에 curl 추가), `scripts/local_alpha_runner.sh`(`wait_compose_healthy` 폴링 제거). host-runtime의 Caddy edge `/health` wait_http 1건은 유지 — edge 라우팅(host port 매핑 + local-TLS redirect)은 in-container healthcheck로 표현이 brittle하고, api HTTP 준비는 --wait가 이미 보장(주석으로 명시).
- 마이그레이션 멱등성 검증을 2-run → 1-run으로: `scripts/migrate.sh`가 한 실행 안에서 apply→verify 2패스(동일 skip 판정 루프 재실행)를 돌고 두 번째 패스에서 신규 적용이 나오면 즉시 실패, 성공 시 `[migrate] IDEMPOTENCY_OK second-pass applied=0 skipped=<N>` 마커를 남긴다(`MIGRATE_IDEMPOTENCY_CHECK=0` opt-out). local gate runtime 부트스트랩은 `make migrate` 1회로, host-runtime은 별도 `compose run migrate` 없이 `compose logs migrate`의 마커 캡처로 evidence를 대체 — 판정 경로가 동일해 증명력 유지, 기존 grep '스킵'보다 강한 단정(전 파일 SKIP + 신규 적용 0).
- 검증: `--profile docs` PASS, `--profile runtime-db` PASS(리뷰 반영 후 재실행 — compose --wait + 강제 env/마커 단정 migrate 스텝 실측), `--profile host-runtime` PASS(이미지 5개 빌드 → `up -d --wait`로 api /health healthy + migrate 완주 → Caddy edge 200 → `compose logs migrate`의 IDEMPOTENCY_OK 캡처 → relay/mock 김인턴 왕복 e2e), `--profile local-alpha` PASS(host-runtime+backup+macOS real-backend+diagnostics packet — `local_alpha_runner --wait` 전환 포함), `--profile runtime-relay`/`--profile runtime-agent` PASS(공유 부트스트랩 경유). `--auto` 자체 테스트에서 이 브랜치의 scripts/infra 변경이 `all`로 넓게 매핑되고 `--profile` 명시가 override함을 확인.
- 3-lens 코드리뷰 반영(blocker 1 + high 4): ① `infra/*`(non-prod)·`server/*`(non-Migrations) 매핑을 staging-smoke/runtime-db 단독에서 **all로 확대**(로컬 런타임 compose와 relay/live/agent 표면의 silent coverage loss 차단) ② diff 베이스 부재/merge-base 실패 시 dirty-only로 좁히지 않고 all로 확대(fail-open 차단) ③ 분류 루프 `set -f`로 glob 확장 차단 ④ 게이트 migrate 스텝이 `MIGRATE_IDEMPOTENCY_CHECK=1` 강제 + `IDEMPOTENCY_OK` 마커 직접 grep 단정(env로 verify 패스가 조용히 꺼져도 게이트 FAIL).
- 알려진 잔여(정직 표기): host-runtime 1-run 전환으로 기존 2번째 `compose run migrate`가 증명하던 컨테이너 entrypoint(internal-smoke-migrate.sh + bootstrap_roles.sql) 전체의 fresh 재실행 멱등성은 게이트가 더 이상 단정하지 않는다(마이그레이션 파일 skip 증명은 동일 경로+강화 유지, bootstrap_roles는 IF NOT EXISTS 가드). prod 정본 compose(docker-compose.prod.yml)에는 api healthcheck 미추가(핀 이미지의 curl 보장 불가 — 필요 시 이미지 계약 확정 후 별도 티켓).

## 0az. MOMO-323 GWS 스펙 정정 3건 + Internal consent 셋업 런북 (2026-07-06)

- MOMO-122 스펙(`research/11-agent-runtime/12-google-workspace-connector-v0.md`) 정정: §4.2 scope 표에서 `drive.metadata.readonly`가 **restricted-class**임을 명기(기존 표는 가벼운 metadata tier처럼 읽혔음 — `drive.file`만 non-sensitive), self-hosted 배포는 배포 조직 소유 GCP 프로젝트 + OAuth consent **Internal**(같은 Workspace 조직) 전제에서 Google 검증/CASA가 면제됨을 배포 전제로 반영. §2 "no full Drive mirrors" 규칙에 **momo 관리 공유 드라이브 한정 revocable 파생 인덱스**(임베딩+청크, 행마다 permission snapshot version, tombstone 시 삭제) carve-out을 추가 — 사용자 개인 Drive(`drive.file` 선택 파일)는 기존대로 excerpt-only.
- MOMO-123 스펙(`13-google-workspace-enterprise-admin-v0.md`)에 `service_account_boundary.boundary_kind` 도입: 기존 DWD 경로는 `dwd_delegation`(필드 부재 시 기본으로 읽음 — backward compatible), 제3모드 `shared_drive_member` 추가(**DWD 아님** — SA가 자기 자신으로서 momo 관리 공유 드라이브 1개의 Content Manager 멤버로만 동작, 사칭/delegated token 금지, Admin console API Controls 등록 불필요). §3 install mode 표·§5 scope inventory(`drive.file` SA-as-itself)·§6 boundary JSON/규칙·revoke 경로를 함께 갱신하고, fixtures 3종(`admin_install_scope_inventory`/`dwd_delegated_context_projection`/`audit_export_revoke_flow`)에 `boundary_kind` 필드 + `shared_drive_member` boundary 예시를 additive로 확장(jq green).
- 신규 `docs/GWS_INTERNAL_CONSENT_RUNBOOK.md`: 배포 조직용 GCP 프로젝트 생성 → OAuth consent Internal → SA 생성/키 발급(시크릿 저장소 only, 키 바이트 비커밋) → 공유 드라이브 생성 + SA Content Manager 멤버 추가 → boundary 기록값 → 검증 스모크/철회 경로까지, 사람 단계는 전부 `[manual]` 표기. `docs/INDEX.md` §2에 등록.
- 검증: `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS(fixtures JSON jq 포함). 문서/fixture만 변경 — 코드/스키마 변경 없음. 정직 표기: 런북의 `[manual]` 단계(GCP/consent/SA/드라이브)는 미실행이며, SA `drive.file` scope의 changes.list/다운로드 충분성은 **runtime-unverified**(MOMO-320 착수 시 실증 — tracker 실증 항목 유지). 실행 트래커에서 MOMO-323 → `review`.

## 0b0. MOMO-301 agent_run depth/round 스키마 + 루프가드 G1~G4 실쿼리 (2026-07-06)

- `server/Migrations/007_agent_run_a2a_guards.sql` 추가: `agent_run`에 `round_count`/`consecutive_auto_count`(integer NOT NULL DEFAULT 0) + L4 §3.4 캡 CHECK(`depth <= 4`, `0 <= round_count <= 4`, `consecutive_auto_count >= 0`). `depth` 컬럼은 schema_v0에 이미 존재(`>= 0`만 있었음)라 캡 CHECK만 추가. 기존 테이블 ALTER라 RLS DO-block 신규 등록 불필요(`agent_run`은 schema_v0 RLS ARRAY에 이미 등록 — 확인함). schema_v0.sql 불변.
- AgentWorker 루프가드를 스텁 → **실제 Postgres 쿼리(SoT)** 로 교체: 단일 tx에서 `agent` 행 `FOR UPDATE`(에이전트별 게이트 뮤텍스) → 자기 `agent_run` 행 FOR UPDATE → G1 라이브 run 카운트(`running/awaiting_approval/paused`; `queued`는 outbox partition_key가 직렬화하므로 제외) → G2 채널 테일 연속 에이전트 발화 streak(`type<>'system'` 제외 — 사람 발화가 구조적으로 리셋, 트립 메시지 자기증폭 차단) → G3 step 캡(`min(run.max_steps, MAX_STEPS)`) → G4 depth 캡(§3.4). proceed 시 같은 tx에서 run을 `running`으로 전이해 동시 클레임 레이스에 안전(뮤텍스 해제 전에 세마포어 가시화). 페이로드 시드 평가는 fast-fail 보완으로 유지(DB가 항상 우선).
- 게이트 트립 처리(한 tx): run `failed` + `error={code:'loop_guard_tripped',gate,reason}` + `audit_log(action='agent.guard.tripped', snapshot 포함)` + 채널에 사람이 읽을 수 있는 degraded **system** 메시지(MOMO-256 패턴 — seq bump + message INSERT + outbox broadcast) + job done + `agent.status=error`.
- `scripts/verify_agent_worker.sh`에 결정론적 트립 시나리오 3종(페이로드 게이트 시드는 전부 0으로 두고 DB 값만 트립 조건 — DB SoT 증명): G4(depth=4), G3(step_count=max_steps=12), G1(같은 에이전트 decoy running run, 검증 후 cancel). 각각 failed run + audit + degraded system 메시지 + broadcast(version=seq) + no-spend(usage_ledger 0행)를 단정. fixture 시작 시 데모 에이전트의 잔존 활성 run을 cancel해 공유 볼륨에서 macos-ui fixture와의 G1 간섭을 차단. local gate `runtime-agent` 커버리지 노트 갱신.
- 스코프 밖(정직 표기): §3.4 라운드 배리어의 라운드 스케줄러(=A2A, MOMO-313)와 G2 트립 시나리오, §3.3 SimHash 시맨틱 루프 감지는 미구현 — `round_count`는 이번에 저장/CHECK까지만. `consecutive_auto_count`는 게이트 평가 시 관측 streak을 기록(SoT는 메시지 테일).
- 검증: `--profile docs` PASS, `--profile swift` PASS(AgentWorker 단위테스트 27개 — G1~G4 스냅샷 verdict 포함), `--profile runtime-db` PASS(007 적용 + 1-run 멱등 IDEMPOTENCY_OK), `--profile runtime-agent` PASS(G4/G3/G1 트립 시나리오 포함, 프로파일 사이 포트 가드로 누수 MomoServer kill).
- **코드리뷰 High 반영(2026-07-06 라운드):**
  - G1을 `status='running'` 단독 계수로 축소(`awaiting_approval`/`paused`는 사람 대기 상태 — 승인 대기 중 재멘션 영구 차단 경로 제거) + stale running 제외(`updated_at`이 `G1_STALE_RUNNING_SECONDS`(기본 600s) 초과한 run은 워커 크래시 잔재로 보고 카운트 제외, 제외 발생 시 `audit_log(action='agent.guard.stale_running_observed')` 관찰 기록 — 실제 fail 전이는 후속 reaper 티켓 필요, 코드 주석 명시).
  - 클레임 상태 가드: proceed UPDATE에 `WHERE status IN ('queued','running','failed')` + RETURNING(0행이면 실행 스킵 + `audit_log(action='agent.run.claim_skipped')` no-op — 취소된 run 부활 방지; `failed` 포함은 transient 재시도 경로 유지 목적, 주석 명시).
  - §3.4 depth 게이트를 스펙 문언("MAX_DEPTH=4 **초과** 시 차단")과 007 CHECK(`depth<=4`)에 정렬: `depth > MAX_DEPTH`로 수정(depth=4는 유효). durable 라벨(audit detail/message props/agent_run.error)의 depth 캡 표기를 `G4` → **`a2a_depth`**로 교체(§3.3 정본 G4=SimHash와 충돌 해소; A2A 스폰 도입 시 실집행점은 child 생성 시 `parent.depth >= MAX_DEPTH` 검사임을 주석 명시).
  - G2를 스펙 의미(per-agent counter)로 재작성: 채널 전체 에이전트 테일 합산 → **해당 에이전트의** 마지막 사람 메시지 이후 auto 발화만 계수(`type='text'`만 — tool_call/tool_result/system 제외, run당 1계수 = `DISTINCT run_id`; 다른 에이전트 발화는 계수도 리셋도 안 함 — 라운드 배리어 호환).
  - G3 실집행: proceed 클레임 UPDATE에 `step_count = step_count + 1`(클레임당 1스텝 소모 — 기존엔 런타임 writer 부재로 G3가 시드값 전용이었음).
  - payload 시드 fast-fail 평가 삭제(`evaluatePreInvoke`/`RunGateState` 제거) — DB snapshot이 유일한 게이트 authority(계약 모순 제거). degraded 메시지를 게이트별 실제 해제 조건에 맞게 수정(G1: "다른 run 실행 중, 끝나면 재멘션" / G2: "사람 메시지가 카운터 리셋").
  - verifier: G2 트립 e2e 추가(`MAX_CONSECUTIVE_AUTO=2` env + 에이전트 연속 text 2건 시드 → 트립 + audit evidence, 검증 후 사람 메시지로 카운터 리셋), depth 트립을 env 정렬(`MAX_DEPTH=1` + depth=2 시드 — CHECK `depth<=4`와 무충돌), 트립 라벨 grep `a2a_depth` 갱신. 4종(a2a_depth/G3/G1/G2) 전부 failed run + audit + degraded system 메시지 + no-spend 단정.
  - 남은 honest gap: stale-running 제외의 e2e 시나리오는 verifier에 없음(단위/코드 경로만 — reaper 티켓에서 함께), SimHash G4·라운드 스케줄러는 계속 미구현(MOMO-313).

## 0b1. MOMO-302 Agent Context Assembly v1 (2026-07-07)

- @mention 시 트리거 메시지 1개만 hermes에 넘기던 에이전트 기억상실을 해소했다. 서버가 `agent_job` payload에 같은 채널의 최근 히스토리 윈도(`recent_messages`)를 실체화한다: `AGENT_CONTEXT_MAX_MESSAGES`(기본 30, 1..200) 개를 seq DESC 조회→ASC 정렬, 항목 shape `{message_id, channel_id, seq, author_member_id, author_kind, author_display, type, body(2000자 트리밍/tool은 요약), created_at, source_id}`. 트리거가 스레드(root_id 비NULL) 안이면 스레드(root+replies)를 우선 포함하고 잔여 예산을 채널 최근 메시지로 보충한다(스레드=세션 경계). `type='system'`·`state='deleted'`·`deleted_at` 메시지는 제외하고 RLS는 기존 `withTenantTransaction`(SET LOCAL app.workspace_id) 경계를 그대로 쓴다. Context Packet v0 fixture의 `recent_messages` 필드는 제거 없이 additive 확장했고, `context_packet_projection.recent_messages`도 실제 히스토리+source attribution을 담는다.
- AgentWorker는 `recent_messages`를 OpenAI chat 배열로 조립한다(`ContextAssembler`): 에이전트 자신의 과거 발화=`assistant`, 사람·타 에이전트=`user`(`[표시이름] ` prefix), `agent.system_prompt`는 첫 `system` 메시지. 문자 예산 `AGENT_CONTEXT_MAX_CHARS`(기본 24000) 초과 시 오래된 것부터 드랍하되 트리거 메시지는 항상 포함하고, 드랍 발생 시 개수만 info 로깅(본문 비노출). `recent_messages`가 없는 구형 payload는 기존 단일 메시지 경로를 유지한다(하위호환). 세션 키 (workspace, agent, channel) 경계는 서버 쿼리가 same-channel만 보장하고 worker 단위 테스트로 고정했다.
- 검증 하네스: `scripts/mock_hermes.py`에 opt-in 요청 덤프(`MOCK_HERMES_REQUEST_DUMP=<path>`, 기본 비활성)를 추가하고, 신규 `scripts/verify_agent_context.sh`를 `local_gate.sh --profile runtime-agent`에 연결했다. 시나리오: 채널에 사전 메시지 시드("파인애플 재고는 7개다" + 에이전트 발화 + 오래된 패딩)와 타 채널 off-topic 메시지 → @hermes 트리거 → 덤프에서 (a) 시드 히스토리 전달 (b) 에이전트 자신=assistant (c) 타 채널 미포함 (d) 작은 `AGENT_CONTEXT_MAX_CHARS`로 오래된 패딩 드랍/트리거 유지 검증.
- 퀵 검증(PASS): `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build --package-path server`, `swift test --package-path workers/AgentWorker`(29 tests, role 매핑/예산 절단/하위호환 신규 3개 포함), server 순수 유닛 `swift test --package-path server --filter "AgentMention|Broadcast"`, `python3 -m py_compile scripts/mock_hermes.py` + `adapters/hermes/tests/test_momo_adapter_contract.py`(5 tests), `bash -n`/`/bin/bash -n scripts/verify_agent_context.sh scripts/local_gate.sh`, mock 덤프 기능 스모크. runtime-unverified(Docker Postgres/Centrifugo 기동이 필요한 `scripts/verify_agent_context.sh` 실 실행은 이번 웨이브의 역할 분리상 풀 게이트 `--profile runtime-agent`에서 momo-main이 실행) — SKIPPED+사유.

- 3-lens 리뷰(2026-07-07) PASS, blocker 0. 리뷰 반영: diff/artifact/approval_request(body=NULL 구조화 타입)를 서버 `recentMessageBody`가 `[diff: path]`/`[artifact: title]`/`[approval_request]`로 요약(빈 content로 실제 hermes 호출이 거부되는 것 방지), ContextAssembler가 비-트리거 빈-content 턴을 스킵(방어). Follow-up(비-blocker): recent_messages의 non-trigger `source_id`가 `sources` 배열로 완전 resolve되는 것은 **MOMO-307(Context Broker)** 스코프; 스레드 우선 브랜치는 코드상 정확하나 send()가 아직 root_id/reply_to_id를 기록하지 않아 live 경로 미도달 → **MOMO-305(스레드 UI)**에서 재검증.

- runtime-agent 게이트 검증(2026-07-07): verify_agent_worker / **verify_agent_context**(302 전용 — "system+history assembled, self=assistant/others=user, cross-channel excluded, budget trimmed" 단정) / verify_agent_live_channel / **verify_local_hermes_bridge**(실제 SSE 스트리밍 mock으로 @hermes→agent_job→AgentWorker→durable message.new 왕복) **개별 전부 PASS**. 풀 시퀀스 게이트는 verifier들이 자기 `swift run` child MomoServer/mock/worker를 누수시켜(300에서 확인된 패턴) 4번째 verifier 시점 누적 누수→메모리 고갈로 워커가 OOM-kill(`agent_run.error=unknown`, "worker exited before roundtrip")되는 환경/인프라 이슈가 있다 — **302 코드 회귀 아님**(bridge를 격리 실행하면 PASS). verifier leaked-process 정리(process-group kill/포트 가드)는 게이트 하드닝 후속(**MOMO-319**). 리뷰 반영 픽스: verify_agent_context가 트리거 전 자기 채널/에이전트의 non-workspace grain 예산을 정리(공유 DB volume에 남은 verify_agent_worker의 agent_channel 트립 예산 leftover가 서킷브레이커를 트립시켜 hermes 호출 전 abort시키던 것 해소).
## 0b2. MOMO-300 Realtime subscribe proxy 인증 + token revocation + rate limit (2026-07-06)

- **Subscribe proxy 인증(CentrifugoRoutes TODO 해소):** Centrifugo가 subscribe proxy 콜백에 `X-Centrifugo-Proxy-Secret` static header를 붙이고(`infra/centrifugo.json` dev 파일값 + dev/e2e/prod compose의 `CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS` env override, `infra/prod/centrifugo.prod.json`은 change-me placeholder + prod compose `:?` env 강제), API가 constant-time 비교로 검증한다 — 없거나 틀리면 **401**(fail closed, 네트워크 위치만으로는 더 이상 인증되지 않음). env는 `CENT_PROXY_SECRET`(`.env.example`/`internal-smoke.env.example`/`secrets.env.example`/`prod .env.example` placeholder + `.conductor/setup.sh` passthrough). 비-local(staging/prod/internal-host)에서 missing/placeholder면 **부팅 fail-fast**(`Config.validateSecurityForBoot`) + `scripts/prod_env_preflight.sh` strict/internal-smoke 검사 연계.
- **Token revocation:** login/join이 발급한 access/refresh JWT를 `token` 테이블(kind='session', `token_hash=sha256` — pgcrypto `digest()`, 원문 비저장)에 기록하고, AuthMiddleware가 요청마다 `revoked_at`/`expires_at`/row 존재를 검사(**unknown/revoked/expired → 401, fail-closed** — 배포 이전 발급 토큰은 재로그인 필요). `POST /v1/auth/logout` 신설(presented access + 선택 refresh revoke, **멱등** — 재호출 200 `alreadyRevoked`, 실제 전환 시에만 `audit_log(auth.logout)`), `POST /v1/auth/refresh` 신설(rotation: 이전 refresh 즉시 revoke, 재사용 401). subscribe proxy 멤버 확인도 "active session token ≥1"을 요구해 로그아웃이 신규 realtime subscribe를 차단한다(**coarse per-member v0** — 기기별 eviction은 `include_connection_meta` 후속, TokenStore에 TODO).
- **Rate limit:** per-IP(전 라우트) + per-member(인증 라우트) 미들웨어 — **in-memory sliding window(단일 노드 v0, 프로세스 재시작 리셋/레플리카 비공유 문서화, docs/RUN.md §2.2)**. env `RATE_LIMIT_WINDOW_SECONDS`/`RATE_LIMIT_PER_MEMBER`/`RATE_LIMIT_PER_IP`(0=비활성), `/health`·subscribe proxy 제외, 초과 시 **429 + Retry-After + `audit_log(rate_limit.exceeded)`(버스트당 1회, member 축만)** — **per-IP 축 위반은 인증 여부와 무관하게 audit_log 미기록**(IP 미들웨어가 AuthMiddleware 앞의 전역 계층이라 principal/tenant 부재), 서버 로그로만 남는다(문서화). 비용 서킷브레이커(budget_window)와 독립.
- **검증:** `scripts/verify_auth_hardening.sh` 신설(runtime-db 프로파일 + --auto 매핑 + shell syntax 목록 등록): proxy secret 401/allow 경계, login→token rows, revoked-token **401 evidence**, logout 멱등+audit, 로그아웃 후 subscribe deny, refresh rotation replay 401, member **429+Retry-After+audit evidence**, /health 제외. `verify_realtime_live.sh`에 미인증 proxy 401 네거티브 스텝 추가, 두 live verifier에 `CENT_PROXY_SECRET` 전달. 게이트: docs/swift/runtime-db/runtime-live/runtime-agent PASS(각 프로파일 사이 API 포트 누수 가드 실행). 스키마 변경 없음(schema_v0 `token`/`audit_log` 그대로) — 신규 마이그레이션 불필요.
- 알려진 잔여(정직 표기): ① revocation 검사로 인증 요청마다 tenant-scoped SELECT 1회 추가(v0 허용, 캐시는 후속) ② per-IP 축은 `X-Forwarded-For` 첫 hop을 신뢰(직노출 배포에선 스푸핑 가능 — Caddy 뒤 전제 문서화) ③ 기기별 realtime eviction은 coarse(전 세션 revoke 시에만 subscribe 차단) ④ Centrifugo `dm:` namespace는 dev/prod 모두 subscribe_proxy_enabled 미설정(user-limited 채널 정책 기존 그대로 — 본 티켓 스코프 밖).
- **코드리뷰 High 반영(2026-07-06):** ① refresh 회전 TOCTOU 제거 — `TokenStore.revoke`의 `UPDATE … WHERE revoked_at IS NULL RETURNING` 결과(`revokedNow`)를 단일사용 원자 게이트로 사용, 동시 재사용 요청은 정확히 1개만 200(패자 401 — `verify_auth_hardening.sh`에 동시 6-refresh race 스텝 추가) ② 앱 access/refresh JWT에 랜덤 `jti`(UUID) 클레임 추가 — iat/exp 초 단위 때문에 같은 초 로그아웃→재로그인이 byte-identical JWT(이미 revoked된 token_hash row)를 재발급하던 버그 원천 제거(pre-jti 토큰은 fail-closed 401→재로그인, Centrifugo connection token은 별도 키라 불변) ③ subscribe proxy 공개 노출 차단 — prod `Caddyfile`이 `/v1/centrifugo/*`를 엣지에서 403 deny(handle 블록), staging-smoke/internal-hosting-smoke 구조 검사 + host-runtime 엣지 403 런타임 스텝 추가(rate limit 제외 라우트의 `CENT_PROXY_SECRET` brute-force 표면 제거) ④ platform-admin 시크릿 비교를 공용 `ConstantTime.equals`로 교체(평문 `==` 타이밍 누수 제거, CentrifugoRoutes 헬퍼를 `Auth/ConstantTime.swift`로 승격) ⑤ per-IP rate limit audit 서술 정확화(위 bullet + docs/RUN.md + 미들웨어 주석).
- **게이트 hang 원인 확정 + 하드닝(2026-07-07):** `scripts/verify_auth_hardening.sh`의 동시-refresh race 스텝이 6개 백그라운드 curl 뒤에 **인자 없는 `wait`**를 호출했는데, 이 `wait`는 셸의 **모든** 백그라운드 잡(=`start_server`가 `&`로 띄운 장수(長壽) MomoServer 서브셸 `SERVER_PID` 포함)을 기다린다. 서버가 버스트를 정상 통과하면(=충분한 메모리의 일반 경로) `wait`가 영원히 반환되지 않아 게이트가 무한 hang → watchdog(900s) kill. **실코드 결함**(OOM 아님)으로 확정 — 조용히 재현 시 서버가 버스트/해머를 끝까지 생존(free≈850MB, swap가 흡수)했고 hang은 순전히 `wait`였다(초기 진단의 `Killed:9`는 재현되지 않음; 환경엔 dogfood 스택+48개 compose 컨테이너로 상시 메모리 압박이 있으나 이 hang의 원인은 아님). **수정:** (a) race 루프가 6개 curl PID만 수집해 각 PID를 개별 `wait`(서버 서브셸 배제) — 결정적 hang 제거, (b) 방어적으로 모든 curl 7곳에 `--max-time`/`--connect-timeout` 부여 + api()·해머 루프는 실패 시 `http_code=000`으로 강등해 죽거나 느린 서버를 **무한 hang 대신 명확한 FAIL**로 전환(해머는 000 감지 시 즉시 fail-fast). **결과:** 하드닝 후 verifier 격리 실행 PASS(watchdog EXIT_0), 그리고 clean HEAD 위에서 4개 게이트 프로파일 모두 watchdog+포트가드로 PASS — runtime-db(21/21, auth-hardening=#21)·runtime-live(14/14)·runtime-agent(16/16)·staging-smoke(11/11), 각 프로파일 종료 시 자기 compose down --remove-orphans --volumes + API 포트 정리(dogfood 스택 불가침).

## 0b3. MOMO-318 디자인 pre-flight → swift 프로파일 + snapshot testing (2026-07-07)

- `scripts/verify_design_preflight.sh` 신규: `momo-design-taste` SKILL §5의 mechanical grep을 게이트 명령으로. 검사 4종(view 코드 = `clients/macOS/Sources`+`clients/Core/Sources`, Theme/Tokens 정의 파일·`Tests/` 제외) — (a) raw `Color(red:` (b) `Font.custom` (c) `.font(.system(size:` 고정 포인트 (d) 사용자 노출 문자열 리터럴 내 em-dash(`—`/`–`, 전체주석 라인 제외). `/bin/bash` 3.2 호환(연관배열/mapfile 미사용), `LC_ALL=C` 바이트 매칭으로 로케일 무관 결정론.
- **Ratchet 방식(수용기준 ① 방식 변경 사유):** SKILL 원문은 "zero hits"지만 v0 데모 표면에 기존 위반이 다수 존재(`.font(.system(size:` 81건, `CostBreathingRing.swift`의 `"—"` 1건 등) — 하드 0 게이트는 MomoDS 마이그레이션(MOMO-303) 전까지 무관한 PR을 전부 막는다. 그래서 항목별 카운트 baseline(`scripts/design_preflight_baseline.txt`: color_red=0/font_custom=0/font_system_size=81/emdash_string=1, 실측 기록)을 커밋하고 **current>baseline이면 FAIL(신규 위반 유입 차단, 위반 목록 file:line evidence 출력)**, current<baseline이면 PASS+baseline 하향 안내. 신규 위반만 막고 baseline은 토큰 도입 시 조이는 구조.
- `scripts/local_gate.sh`: `add_swift_commands()`에 design pre-flight를 build 앞에 연결(빠른 fail-fast) → `swift` 및 swift 포함 전 프로파일(runtime-*, macos-ui, m3-dbc)에서 위반=FAIL. shell-syntax 체크 목록에도 신규 스크립트 등록.
- `swift-snapshot-testing`(pointfreeco, MIT, 1.19.2) 테스트 전용 의존성 추가(`clients/macOS/Package.swift` — `SnapshotTesting` product만 import → 전이 타깃(swift-syntax 등) 미컴파일, `swift build` 비용 무영향). `MessageBubbleSnapshotTests`: 고정 fixture(한국어+영어 혼합 본문, seq=128, em-dash 없음)를 `ImageRenderer`로 오프스크린 래스터화(윈도/NSHostingView 플레이키니스 회피) + `NSAppearance.performAsCurrentDrawingAppearance`로 light/darkAqua 강제 → `assertSnapshot(of:as:.image(precision:0.98, perceptualPrecision:0.98))`. 레퍼런스 PNG 2종 커밋(`__Snapshots__/MessageBubbleSnapshotTests/`), light≠dark 확인. `Package.resolved` 비커밋(AGENTS §5, `.gitignore` `*.resolved` 확인).
- `legal/THIRD_PARTY_NOTICES.md`: swift-snapshot-testing(MIT, 테스트 전용/앱 번들 미포함) + 테스트 전용 전이(swift-custom-dump·xctest-dynamic-overlay MIT, swift-syntax Apache-2.0) 귀속 추가. permissive만, copyleft 없음.
- `docs/LOCAL_PR_GATE.md` §6 신규: ratchet 규칙표 + baseline 갱신 절차 + **UI PR은 design-review 에이전트 리포트(Blocker 0)를 evidence로 포함**(AGENTS §5 재확인) + 스냅샷 결정론/precision/CI 부재 명문화. swift 프로파일 표 2곳 갱신. 기존 §6(Worker Handoff)→§7.
- 검증(퀵 범위, DEVELOPER_DIR=Xcode): `verify_design_preflight.sh` 단독 PASS(baseline 일치, env bash + `/bin/bash` 3.2 exit 0), 4항목 각각 위반 1개 주입 시 FAIL(exit 1) 후 probe 제거 재PASS 확인. `clients/macOS` `swift build` green + `swift test` green(60개 = 기존 58 + 스냅샷 2), 스냅샷 재실행 2회 결정론 PASS. `clients/Core` swift build green. `bash -n`/`/bin/bash -n` 양쪽(신규 스크립트 + 편집된 local_gate.sh) OK.
- 정직 표기(honest gap): `local_gate.sh --profile swift` **풀 실행은 미수행**(Fable 후속 배비싯 — 웨이브 역할분리) → runtime-unverified(swift 프로파일 풀런). 스냅샷은 **이 머신(macOS 26 / Swift 6.3.2 / retina @2x)에서만** 결정론 확인 — 다른 macOS point release에서 perceptualPrecision 0.98을 넘는 폰트 렌더 차이가 나면 재기록 필요(로컬 전용 evidence, repo에 CI 없음). em-dash 검사는 더블쿼트 문자열 리터럴 + 비주석 라인 휴리스틱(멀티라인/블록주석 내 문자열 em-dash는 미포착 — ratchet이 카운트 드리프트로 흡수).

## 0b4. 재설계 2026-07 실행 세션 요약 + Codex 인수 (2026-07-07)

- **머지 완료(main, 6티켓, 전부 3-lens 리뷰 + 게이트 검증):** MOMO-316(게이트 --auto/wait/멱등) · 323(GWS 스펙/런북) · 301(루프가드 G1~G4 실쿼리) · 302(컨텍스트 조립 v1) · 300(proxy 인증/revocation/rate limit) · 318(디자인 pre-flight ratchet + 스냅샷). 각 §0ay/0az/0b0/0b1/0b2/0b3.
- **브랜치 대기(Codex 완료):** MOMO-317 = `feat/MOMO-317-buildkit-cache`(재작성 Dockerfile 단일이미지 검증됨, 잔여=main 머지 build-infra 충돌 해소 + host-runtime 게이트, 이 세션 머신 메모리 압박으로 미실행).
- **실행 주체 전환:** Opus 세션 오케스트레이션 → **Codex/GPT goal 기반 자율실행**. 인수인계·진입점(MOMO-303 MomoDS 우선, 병렬 308/309)·게이트 배비싯 함정은 `docs/HANDOFF_2026-07.md`, 상태는 `research/13-redesign/00-execution-tracker.md`.
- **게이트가 잡아준 실이슈(하드닝 반영):** ① 300 verifier bare `wait`가 서버 서브셸 대기 → 무한 hang(PID 한정+curl 타임아웃 수정) ② 302 verifier가 공유 DB budget leftover에 서킷브레이커 트립(채널 예산 정리) ③ verifier 누적 프로세스 누수 → 메모리 OOM(302 full-sequence 실패 근본원인, 개별 verifier 전부 PASS — MOMO-319 하드닝 후속) ④ 머지 커밋 worktree gitlink 혼입(.gitignore 등록). **전부 인프라/verifier 이슈이며 제품코드 회귀 아님.**

## 0b5. LSA-001 Redesign-aligned local solo alpha readiness (2026-07-07)

- **목표/로드맵 정리:** `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`를 추가해 로컬 1인 테스트 DoD를 “Docker Desktop stack + macOS app + loopback Hermes-compatible runtime + 3-day evidence”로 고정했다. AWS/Kubernetes는 out of scope이며, 다음 순서는 **MOMO-319 게이트 누수 하드닝 → MOMO-303 MomoDS → MOMO-304 core messenger UX → credentialed Hermes rehearsal → short dogfood gate**다.
- **재설계 반영:** `scripts/local_alpha_runner.sh`가 repo 밖 evidence dir에 0600 env 파일을 만들고 `CENT_TOKEN_HMAC`/`CENT_API_KEY`/`CENT_PROXY_SECRET`/`JWT_HMAC`/`HERMES_API_KEY`를 64-char 랜덤값으로 생성한다. `CENT_PROXY_SECRET`이 비면 fail-closed하고, `AGENT_CONTEXT_MAX_MESSAGES=30`/`AGENT_CONTEXT_MAX_CHARS=24000`를 명시한다. `scripts/verify_internal_host_runtime.sh` generated env에도 `CENT_PROXY_SECRET`을 추가했다.
- **앱/문서 정렬:** macOS real-backend demo credential을 `demo@momo.local / dev-password`로 통일했고, `scripts/momo` help도 같은 값으로 맞췄다. `docs/RUN.md`·`docs/INTERNAL_ALPHA.md`·`docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`는 foreground app launch, old-token 401→fresh login, migration 007 `IDEMPOTENCY_OK`, local rate-limit override, MOMO-302 recent-history context 기대값을 설명한다.
- **검증:** docs gate PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-docs-20260707T053148Z-pid17670-ns1783402308691257000-wt9a510db2fbf3-re9c071fded7c.md`), swift gate PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-swift-20260707T051032Z-pid55939-ns1783401032709813000-wt9a510db2fbf3-r54cc9b2aee90.md`), local-alpha gate PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-local-alpha-20260707T051139Z-pid60262-ns1783401099180296000-wt9a510db2fbf3-r4f6c27c3d523.md`). Runner 직접 smoke도 `PORT=28280 POSTGRES_PORT=28232 CENT_PORT=28200 HERMES_PORT=28288 scripts/local_alpha_runner.sh execute --hermes mock --stop-after-smoke` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T/momo-local-alpha/20260707T053154Z/summary.md`), 생성된 secret 길이 64자, env `0600`, summary redaction, foreground `MomoMacDevApp` 실행 명령 포함을 확인했다.
- **리뷰 후속:** security reviewer는 블로커는 없다고 판단했다. 바로 반영한 수정은 provider URL query/fragment redaction과 `docs/RUN.md` legacy password 문구 제거다. 남은 local-only hardening인 child process env least-privilege는 credentialed Hermes rehearsal(LSA-005) acceptance로 넘겼다.
- **남은 runtime-unverified:** 실제 credentialed Hermes/Codex OAuth provider login, foreground `MomoMacDevApp` launch with `LOCAL_GATE_LAUNCH_UI=1`, 72h dogfood, AWS provisioning은 후속 goal에서 닫는다.

## 0b6. MOMO-319 Local gate/verifier hardening for solo alpha (2026-07-07)

- **목표:** 로컬 1인 테스트 전에 `runtime-agent` 계열 verifier를 반복 실행해도 이전 검증의 host process, port listener, stale `agent_run`/`agent_job` 상태가 다음 검증을 오염시키지 않도록 하드닝했다. 제품 runtime 프로토콜은 변경하지 않고 test harness/cleanup boundary만 좁게 수정했다.
- **구현:** `scripts/runtime_process_guard.sh`를 추가해 repo-local MomoServer/AgentWorker/OutboxRelay/mock-Hermes verifier process만 tree cleanup 대상으로 삼는다. `verify_agent_worker.sh`, `verify_agent_context.sh`, `verify_agent_live_channel.sh`, `verify_external_agent_provider.sh`, `verify_local_hermes_bridge.sh`가 이 guard를 사용한다. `verify_agent_context.sh`와 local bridge는 worktree 기본 port quartet과 충돌하지 않도록 `.conductor` 10-port block 내부의 `base+4..6` 전용 포트를 쓴다.
- **반복 실행 DB hygiene:** external/local Hermes smoke는 deterministic `client_msg_id`/run/message fixture만 cleanup한다. `verify_agent_worker.sh` loop-guard fixture cleanup은 FK 순서를 바로잡아 `agent_run.trigger_message_id`가 남은 상태에서 trigger message를 먼저 삭제하지 않는다.
- **리뷰 반영:** security/performance review에서 나온 blocker를 수정했다. 추가 verifier 포트는 `.conductor` 10-port block 내부(`base+4..6`)로 제한했고, raw process command logging은 제거했으며, final cleanup은 gate 실패 후에도 always-run으로 분리했다. 포트 스캔 cleanup은 repo-local verifier/mock/server만 정리하고, user-owned Hermes/provider는 기본 fail-closed로 남긴다. DB cleanup도 deterministic verifier fixture/client_msg_id/run id 범위로 축소해 로컬 dogfood의 실제 pending agent job을 중립화하지 않는다.
- **검증:** 타겟 bridge smoke PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-hermes-bridge/external-agent-provider-evidence-20260707T062812Z-74847.md`), AgentWorker verifier 단독 PASS, `LOCAL_GATE_ALLOW_DIRTY=1 ENV_FILE=.env.worktree scripts/local_gate.sh --profile runtime-agent` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-runtime-agent-20260707T063018Z-pid88947-ns1783405819010789000-wtbc6bfebdfa56-r30ee5c6b2403.md`). 해당 full gate는 docs/static, `make build`, `make test`, Docker compose health, 007 migration idempotency, AgentWorker, Context assembly, Agent live channel, Local Hermes bridge, final cleanup까지 모두 통과했다.
- **남은 최적화:** runtime-db 부분 병렬화와 warm volume opt-in은 1인 테스트 필수 안정성은 아니므로 후속 build-infra/performance 티켓으로 남긴다. 실제 credentialed Hermes provider login과 72h dogfood evidence는 여전히 LSA-005/LSA-006 범위다.

## 0b7. MOMO-320 Local runtime env drift guard (2026-07-07)

- **발견:** MOMO-319 merge 후 main `runtime-agent` gate가 `verify_agent_worker.sh`에서 실패했다. Swift/build/test/migration은 통과했지만, stale `.env.worktree`가 `CENT_API_KEY`/`CENT_TOKEN_HMAC`/`CENT_PROXY_SECRET`/`JWT_HMAC`를 누락해 Centrifugo `/api/publish`가 relay/worker에 401을 반환했다.
- **구현:** `scripts/ensure_runtime_env.sh`를 추가하고 Docker/runtime gate profiles가 static checks 뒤에 이를 호출한다. generated `.env.worktree`는 stale key 누락 시 `.conductor/setup.sh`로 재생성하고, custom `ENV_FILE`은 덮어쓰지 않은 채 secret 값을 출력하지 않는 fail-fast 메시지를 낸다. 리뷰 반영으로 `external-agent-provider`도 guard를 타며, custom `DATABASE_URL`은 local/loopback Postgres만 허용하고, shell source 전에 command substitution/metachar env syntax를 거부한다. progress-only `verify_agent_live_channel.sh`는 자기 verifier run을 종료 전에 취소해 다음 Hermes bridge 검증의 G1 semaphore를 오염시키지 않는다. `verify_agent_context.sh`는 request dump assertion 뒤 raw dump를 제거하고, cleanup은 verifier-owned run/outbox/budget 범위로 축소했다. 오래 실행한 local alpha DB에서 Centrifugo history가 100개를 넘으면 최신 publish가 기본 history 방향에서 밀릴 수 있어 AgentWorker/external-provider smoke는 `reverse=true` history 조회로 최신 `agent.partial`/`message.new`를 확인한다.
- **검증:** negative guard smoke PASS(custom `ENV_FILE` non-loopback `DATABASE_URL` 거부, shell command substitution env syntax 거부), direct verifier smoke PASS(`verify_agent_context.sh`, `verify_agent_live_channel.sh`), `ENV_FILE=.env.worktree bash scripts/verify_agent_worker.sh` PASS, `ENV_FILE=.env.worktree bash scripts/verify_local_hermes_bridge.sh` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-hermes-bridge/external-agent-provider-evidence-20260707T080723Z-99099.md`). Clean full `runtime-agent` gate PASS at code commit `799fb79`(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-runtime-agent-20260707T081557Z-pid44111-ns1783412157994867000-wt94de7b3d021b-rd36a236827a9.md`): docs/static, `make build`, `make test`, Docker compose health, migration 007 idempotency, AgentWorker/context/live-channel/local-Hermes bridge, final cleanup까지 모두 통과했다.

## 0b8. MOMO-324 AgentWorker verifier cleanup FK rerun hardening (2026-07-07)

- **발견:** MOMO-320 merge 후 main `runtime-agent` gate가 Swift build/test, Docker compose health, 006/007 migration idempotency까지 통과한 뒤 `verify_agent_worker.sh` fixture cleanup에서 실패했다. 오래 유지된 로컬 DB에 이전 `@김인턴` verifier run이 같은 deterministic `client_msg_id`를 쓰고 있었고, cleanup이 `agent_run.trigger_message_id`가 남은 상태에서 trigger message를 먼저 삭제하려 해 `agent_run_trigger_message_id_fkey`에 걸렸다.
- **구현:** 제품 runtime/schema 변경 없이 `scripts/verify_agent_worker.sh` cleanup만 보강했다. verifier-owned deterministic `client_msg_id`로 시작된 과거 run은 agent id가 바뀌어도 응답 메시지와 audit/run 참조를 먼저 정리하고, trigger message는 해당 `agent_run` 삭제 뒤 마지막 단계에서 지운다. cleanup 범위는 고정 verifier client id/trigger message로 한정해 실제 dogfood Hermes job을 지우지 않는다.
- **검증:** `bash -n scripts/verify_agent_worker.sh` PASS, `ENV_FILE=.env.worktree bash scripts/verify_agent_worker.sh` PASS. Full `runtime-agent` local gate는 PR/main evidence로 재실행한다.

## 1. 패키지별 빌드 상태 (로컬 `swift build` 실측)

| 패키지 | 경로 | 빌드 | 비고 |
|---|---|---|---|
| **MomoCore** | `clients/Core` | ✅ **pass** | 공유 모델 + `ChatBackend`/`AgentTransport` 프로토콜. 외부 의존 0(순수 Foundation). |
| **MomoServer** | `server` | ✅ **pass** | Hummingbird 2 + PostgresNIO + JWTKit + AsyncHTTPClient + public `/v1/join` + platform admin read-only inspection + workspace roster/channel read. |
| **OutboxRelay** | `relay/OutboxRelay` | ✅ **pass** | SKIP LOCKED 폴링 → Centrifugo publish. |
| **AgentWorker** | `workers/AgentWorker` | ✅ **pass** | OpenAI 호환 `/v1/chat/completions` SSE + 루프가드 + 비용 reserve/reconcile. |
| **MomoMac** | `clients/macOS` | ✅ **pass** | SwiftUI 라이브러리(뷰+VM) + `MomoMacSmoke` 실행 스모크 + `MomoMacDevApp` window + invite onboarding stub UI + Foundation Models capability fallback surface + REST ChatBackend dynamic channel loading dev mode. |

> ⚠️ SourceKit(IDE) 진단이 `MomoCore`의 일부 파일에 "Cannot find type …"을 표시했으나, 이는 모듈 그래프 없이 파일 단위로 분석한 **stale 경고**다. 실제 `swift build`는 5개 패키지 모두 **clean(exit 0)**.

## 2. 비-Swift 산출물 (정적 + M1 런타임 점검)

| 산출물 | 점검 | 상태 |
|---|---|---|
| `adapters/hermes/momo_adapter.py` | `python3 -m py_compile` | ✅ OK |
| `adapters/hermes/tests/smoke_momo_adapter.py` | fixture 기반 REST invoke/final-message capture smoke(no network) | ✅ OK |
| `infra/centrifugo.json` | JSON 파싱 + `history_meta_ttl > history_ttl`(4 ns) | ✅ OK |
| `infra/docker-compose.yml` | YAML 파싱(postgres:18 + centrifugo:v6 + healthcheck/volume) | ✅ OK |
| `server/Migrations/001_init.sql` | 괄호 290/290 균형, schema_v0.sql 정본 복사 | ✅ OK |
| `server/Migrations/002_seed.sql` | INSERT 구조 정상(괄호 불균형은 `--`주석 내 한글 괄호 → 무해) | ✅ OK |
| `scripts/migrate.sh` | `sh -n` | ✅ OK |
| `scripts/verify_rls.sh` | `sh -n` + Docker PG18 RLS runtime | ✅ OK |
| `scripts/verify_roster.sh` | `bash -n` + Docker PG18 workspace roster runtime | ✅ OK |
| `scripts/verify_channel_list.sh` | `bash -n` + Docker PG18 workspace channel list runtime | ✅ OK |
| `scripts/verify_join.sh` | `bash -n` + Docker PG18 public join runtime | ✅ OK |
| `scripts/verify_platform_admin.sh` | `bash -n` + Docker PG18 platform admin read-only runtime | ✅ OK |
| `scripts/verify_relay.sh` | `bash -n` + Docker PG18/Centrifugo/MomoServer/OutboxRelay runtime | ✅ OK |
| `scripts/mock_hermes.py` | `python3 -m py_compile` + MOMO-004 SSE runtime | ✅ OK |
| `scripts/verify_agent_worker.sh` | `bash -n` + Docker PG18/Centrifugo/AgentWorker runtime | ✅ OK |
| `scripts/verify_agent_live_channel.sh` | `bash -n` + Docker PG18/Centrifugo/MomoServer/AgentWorker/mock-Hermes live agent channel runtime | ✅ OK |
| `infra/prod/*` + `scripts/verify_staging_smoke.sh` | prod compose/Caddy/Centrifugo/secrets/pgBackRest local smoke | ✅ OK (runtime-unverified: staging deploy/TLS/PITR host rehearsal 미실행) |
| `scripts/local_alpha_runner.sh` | `sh -n` + plan mode + `execute --hermes mock --stop-after-smoke` | ✅ OK |

> **MOMO-001에서 검증됨:** PG18+Centrifugo compose health, SQL 001/002 적용 및 멱등 재실행, MomoServer `/health`, 메시지 송신의 `channel_seq` gapless 발급과 `message`/`outbox` 기록.
> **MOMO-002에서 검증됨:** OutboxRelay SKIP LOCKED claim, Centrifugo `/api/publish`, outbox `pending→done`, Centrifugo history의 `seq=message.seq`.
> **MOMO-003에서 검증됨:** non-superuser app role 기준 RLS FORCE + `SET LOCAL app.workspace_id` 테넌트 격리, relay/worker BYPASSRLS 역할 분리, REST message send/history active membership guard.
> **MOMO-004에서 검증됨:** OpenAI-compatible SSE mock 기반 AgentWorker one roundtrip, Centrifugo `agent.partial`, `usage_ledger` reconcile, `budget_window` reserve/release, G5 budget trip.
> **MOMO-168에서 검증됨:** Hermes optional platform-adapter path의 Centrifugo fixture unwrap과 REST invoke/final-message mapping을 repo-local smoke로 검증(no Hermes/network).
> **MOMO-013에서 검증됨:** 일반 tenant token의 platform endpoint 403, platform read token의 2개+ workspace/member/invite usage 전역 조회, platform BYPASSRLS role의 SELECT-only/read-only transaction, invite raw/hash secret 미노출.
> **MOMO-176에서 검증됨:** `GET /v1/workspaces/{ws}/roster`/`members`는 일반 tenant token + `SET LOCAL app.workspace_id` + active membership guard로 human/agent roster를 반환한다. `scripts/verify_roster.sh`가 demo human+agent, active-membership 없는 member 제외, nonmember 403, workspace A/B 교차 403을 runtime-db profile에서 검증했다.
> **MOMO-197에서 검증됨:** `GET /v1/workspaces/{ws}/channels`는 일반 tenant token + `SET LOCAL app.workspace_id` + active workspace/channel membership guard로 visible channel list를 반환한다. `scripts/verify_channel_list.sh`가 demo active channels, left/archived filtering, nonmember 403, workspace A/B 교차 403을 runtime-db profile에서 검증한다.
> **MOMO-196에서 검증됨:** repo-local live WebSocket verifier가 demo login → realtime-token → Centrifugo subscribe → REST send → live `message.new` publication 수신과 invalid connection token reject를 검증한다.
> **MOMO-212/MOMO-338에서 검증됨:** `agent:ws<workspace>.<channel>.<agentMember>` live subscription boundary가 그 정확한 채널의 authorized member에게 `agent.status`/`agent.partial`을 전달하고, invalid token/different-channel/other-workspace/direct publish 경로를 차단한다. `agentwork:`는 agent bearer WebSocket + OutboxRelay 실제 publication으로 self-only 수신을 검증한다.
> **남은 runtime-unverified:** presence, APNs, external Hermes staging connection, Inbound MCP JSON-RPC transport/tool execution/canonical write path/RLS-idempotency e2e.

## 3. 생성 파일 트리 (핵심)

```
momo/
├─ schema_v0.sql                 # 정본 스키마(24 테이블, RLS FORCE)
├─ BUILD_TICKETS.md              # 의존순 빌드 백로그 (Phase0 + v1 P1~P6)
├─ Makefile / README.md / docs/RUN.md
├─ infra/  docker-compose.yml · centrifugo.json · .env.example · prod/docker-compose.prod.yml
├─ server/ (MomoServer, Hummingbird 2)
│   ├─ Migrations/{001_init,002_seed}.sql
│   └─ Sources/MomoServer/{Main,App,Config,AppRequestContext}.swift
│       ├─ DB/Database.swift              # PostgresClient 풀
│       ├─ Auth/{JWT,AuthMiddleware}.swift
│       ├─ Realtime/CentrifugoClient.swift
│       └─ Routes/{Message,Auth,Join,Invite,Roster,PlatformAdmin,Centrifugo,DTOs}.swift
│                                                    # 핵심 쓰기경로: seq+outbox tx + public join + roster read
├─ relay/OutboxRelay/   (SKIP LOCKED → publish)
├─ workers/AgentWorker/ (HermesTransport SSE · LoopGuards · CostAccounting · WorkerService)
├─ clients/Core/        (MomoCore: 모델 + ChatBackend/AgentTransport)
├─ clients/macOS/       (MomoMac: ChannelList/MessageList/MessageBubble/AgentPartial/
│                         CostBreathingRing/ApprovalInbox + ChatViewModel/LiveChatBackend)
├─ adapters/hermes/     (momo_adapter.py: BasePlatformAdapter · plugin.yaml)
└─ scripts/{migrate,verify_rls,verify_roster,verify_join,verify_platform_admin,verify_relay,verify_agent_worker,verify_agent_live_channel,mock_hermes,local_alpha_runner}.*
```

## 4. 컴파일 검증됨 vs 런타임 미검증

- ✅ **컴파일 검증됨**: 5개 Swift 패키지 전부 `swift build` 통과 → 타입·API 계약·시그니처 정합.
- ⛔ **남은 런타임 미검증**:
  - presence, APNs, external Hermes staging connection.
  - Inbound MCP JSON-RPC transport/tool execution, canonical `post_message` write path, approval-safe `create_tool_call` transaction/audit, RLS/idempotency e2e.

## 5. 남은 작업

**M1 런타임 후속:**
1. ✅ MOMO-001: docker 환경에서 `make up` → `make migrate`(001→002) → `swift run`(server) 로 헬스체크 + 메시지 송신(seq 발급) 통합 테스트 완료.
2. ✅ MOMO-002: OutboxRelay 기동 + outbox→Centrifugo publish 왕복 e2e 완료.
3. ✅ MOMO-003: RLS 테넌트 격리 + REST message membership guard 런타임 검증 완료.
4. ✅ MOMO-004: AgentWorker↔OpenAI-compatible SSE mock 연결로 김인턴 멘션→`agent.partial` 1회 + 비용 reserve/reconcile + G5 trip 검증 완료.
5. ✅ MOMO-005/006/007: prod compose skeleton, SOPS/age+pgBackRest skeleton, local/staging smoke gate 준비 완료.
6. ✅ MOMO-182: dev/e2e/prod/install/backup compose/deploy layer ADR 완료. 실제 prod deploy/image publish/install script/upgrade script/pgBackRest restore rehearsal은 후속으로 유지.
7. 남은 M1 host-runtime 배포 축: 실제 staging URL/TLS, SOPS 복호화, pgBackRest stanza/check/full backup/PITR restore rehearsal, 외부 hermes staging 연결.
8. ✅ MOMO-111/112/115: local gate script, 5세션 worktree 운영 자동화, runtime-relay local gate 자동화 완료.

**v0 데모(D/B/C) UI 완성:**
4. `clients/macOS`의 SwiftPM dev app을 기반으로 **Xcode `.app` 번들**로 확장(Developer ID signing/notarytool/DMG/Sparkle은 M4 범위). Live Tool-Call 카드 / Cost Breathing 링 / Approval Inbox 실데이터 바인딩 고도화.

**v1 경험 — 신규 프리미티브(05 경험 문서):**
7. P1 `branch_id`(분기 타임라인, 최대 작업) · P2 reversibility_tier · P3 belief 타입 · P4 autonomy_level · P5 TIE-BREAK decision_ledger · P6 scheduled trigger.

## 5b. QA/릴리스 게이트 (스토어 제출 선행 — 문서/티켓 추가됨, 실행 미진행)

> 추가: 2026-06-24 · "사용 가능 완전 판명" 객관 통과기준 + 베타/크래시계측/e2e·접근성·성능 게이트를 문서·시드이슈로 정의. **측정/판정은 미진행(게이트 OPEN).**

- `docs/cicd/05-qa-release-gate.md` — 게이트 정본. G-A 크래시-free(세션≥99.5/유저≥99.0%) · G-B 핵심플로우 e2e 8/8 · G-C 접근성 치명0 · G-D 성능(런치 p90<2s, hang≈0) · G-E 베타 · G-F 피드백 P0/P1 잔여0 · G-G 릴리스준비 · G-H Enterprise Trust · PASS 기록양식.
- `docs/cicd/06-beta-testflight-plan.md` — TestFlight 내부(≤100)/외부(≤10,000, 첫빌드 Beta App Review) + macOS 공증 .dmg 비공개 베타 + ASC API 피드백 수집.
- `docs/cicd/07-crash-analytics-spec.md` — Sentry Cocoa(1순위, self-host) + MetricKit(보조, 0의존). Crashlytics는 선택지.
- `docs/cicd/08-e2e-accessibility-performance.md` — XCUITest + performAccessibilityAudit(Xcode15+) + XCTMetric.
- `docs/cicd/09-qa-codex-tickets.md` — Q0~Q7 의존순 실행 티켓.
- `docs/cicd/03-store-readiness-gate.md` — G-5 객관기준 + PASS 판정을 05로 링크.
- `scripts/github/issues.tsv` — M3에 QA 시드이슈 7건 추가(gate:qa). 라벨/마일스톤 정합 검증 통과.
- ⛔ 미진행(게이트 OPEN): Sentry/MetricKit 계측 코드, XCUITest/접근성/성능 테스트, qa-gate.yml, 베타 배포·실측·PASS 기록. 선결 = M0 런타임 + C1/C2 Xcode 프로젝트.

## 6. 다음 실행 명령

```bash
# 컴파일 검증(로컬, 지금 가능)
make build                  # 또는 각 패키지에서 swift build

# 런타임(MOMO-001 검증 완료; .env.worktree 또는 .env 사용)
cp infra/.env.example .env
make up                     # postgres:18 + centrifugo:v6
make migrate                # 001_init → 002_seed
(cd server && swift run)    # MomoServer
(cd relay/OutboxRelay && swift run)
(cd workers/AgentWorker && swift run)

# MOMO-004 AgentWorker 런타임 재검증(실제 hermes 없을 때 mock 사용)
scripts/verify_agent_worker.sh

# MOMO-240 내부 알파 runner
scripts/local_alpha_runner.sh plan
scripts/local_alpha_runner.sh execute --hermes mock
```

> 라이선스: 전 의존성 permissive(Apache/MIT) 타깃. 외부 배포/상용 전 법무 검토 1회 필수(L4 §10).
## MOMO-406 install/upgrade + 5분 설치 (2026-07-16)

- prod compose를 변경하지 않고 소비하는 `install.sh`/`upgrade.sh`를 추가했다. 네 momo 이미지의 per-service sha256 digest, 기존 strict preflight, one-shot migrate, 순차 재기동, mode-0600 이전 이미지 상태와 app-only rollback(DB migration 전방 전용)을 강제하며 시크릿 값은 출력하지 않는다.
- 정적 인자/rollback 매트릭스와 shellcheck/bash syntax는 worker에서 PASS. Docker가 필요한 `staging-smoke` compose render와 실제 VPS DNS/TLS·registry pull·SOPS·pgBackRest·Hermes는 오케스트레이터/실호스트 검증 대기(`runtime-unverified(public host)`).
