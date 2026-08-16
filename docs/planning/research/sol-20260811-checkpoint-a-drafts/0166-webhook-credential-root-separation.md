# ADR-0166 — 웹훅 자격증명 root 분리와 점진 회전

- Status: **Proposed** (2026-08-11 · sol 보안 재리뷰, 성재 승인 대기)
- 관련: ADR-0100(보안 경계는 Accepted 선행) · ADR-0115(inbound native/Slack-compatible) · migration 014/033 · #1222(Rust webhook sender) · `docs/planning/DEVIATION_LOG.md` 2026-07-17 pending · `docs/planning/research/2026-08-11-server-security-selfhost-review.md`
- 발단: 서로 다른 두 운영 결합이 확인됐다. inbound native secret은 `JWT_HMAC`에서 직접 파생되고, outbound event-subscription secret은 `OUTBOUND_WEBHOOK_MASTER_KEY`가 없으면 `JWT_HMAC`으로 fallback한다. 전자는 pending 이탈이고 후자는 기본 self-host 생성기가 전용 key를 만들지 않아 실제로 선택되는 경로다.

## Context

웹훅 원문 secret은 저장하지 않고 `HMAC(master, domain || secret_ref)`로 재구성한다. DB 유출만으로 secret을 복원하지 못한다는 장점이 있지만, row에는 **어느 master root로 발급했는지 기록이 없다**.

- inbound native: `webhook_secret_key.secret_ref`, 관리 API가 `JWT_HMAC`으로 `momo_whsec_v1.*`을 발급하며 예정 ingress 검증도 같은 root를 소비하는 계약이다. Slack-compatible token은 random token hash라 이 결정의 KDF 대상이 아니다.
- outbound: `event_subscription.secret_ref`, API와 sender가 전용 key 또는 JWT fallback으로 `momo_evtsec_v1.*`을 재구성한다.
- 현행 `momo-webhook-sender`는 전 테넌트 queue를 읽기 위해 BYPASSRLS role을 요구하지만, 리포 하드 불변식은 BYPASS를 relay·agent-worker 두 실행체로 한정한다. root를 분리해도 sender가 unrestricted tenant read를 유지하면 보안 경계는 닫히지 않는다.
- strict production compose/preflight는 outbound 전용 key를 요구하지만 source self-host helper는 만들지 않는다. 동일 소스 배포라도 경로에 따라 trust-domain posture가 다르다.
- master를 한 번에 바꾸면 저장된 raw secret이 없어 기존 자격증명을 새 root로 재발급할 수 없다. row 구분 없이 global cutover하면 모든 publisher/subscriber가 동시에 깨진다.

## Options

1. **현 fallback 유지.** 암호학적 domain separation은 유지되지만 JWT 회전이 웹훅을 끊고, webhook sender가 불필요하게 JWT root까지 소유한다.
2. **전용 key로 global cutover.** 단순하지만 이미 발급한 secret 전부를 예고 없이 무효화한다. 기각.
3. **row별 KDF root version + 점진 회전.** 기존 row는 legacy root를 유지하고 신규·회전 row부터 전용 root를 사용한다. 운영은 길어지지만 무중단에 가장 가깝고 실패 범위를 subscription/installation 하나로 제한한다. **채택 권고.**

## Decision

### D1. 방향별 master root를 JWT와 분리한다

- inbound native active-write ID의 root: 신규 `WEBHOOK_INGRESS_MASTER_KEY`.
- outbound event subscription active-write ID의 root: 기존 `OUTBOUND_WEBHOOK_MASTER_KEY`를 필수 root로 승격.
- 각 root는 CSPRNG 최소 32 random bytes이고 placeholder·빈 값·동일값을 boot에서 거부한다. 두 key는 서로, 그리고 `JWT_HMAC`·provider/realtime root와 달라야 한다. 값은 env/secret manager에만 있고 DB·로그·audit·evidence에 들어가지 않는다.
- 회전 중에는 방향별 `kdf_key_id → root` **다중 keyring**을 secret manager/file mount에서 로드하고, 별도 non-secret active-write ID를 둔다. 단일 env 이름은 fresh install의 v1 convenience mapping일 뿐 과거 ID의 root를 덮어쓰지 않는다. 어떤 root도 그 ID를 참조하는 row와 rollback window가 0이 되기 전에 keyring에서 제거하지 않는다.
- 신규 self-host env 생성기는 두 root를 독립 난수로 만든다. 기존 env 파일은 자동 덮어쓰기/자동 회전하지 않는다.

### D2. 발급 row에 비밀이 아닌 KDF key ID를 결속한다

- native `webhook_secret_key`와 outbound `event_subscription`에 내부 `kdf_key_id`를 둔다. 예: `legacy.jwt.v1`, `webhook.ingress.v1`, `webhook.outbound.v1`. 이 값은 공개 management 응답의 credential-row UUID `keyId`를 대체하거나 wire에 노출하지 않는다.
- contract 단계의 `webhook_secret_key`는 `mode='native' ⇒ kdf_key_id NOT NULL`, `mode='slack_compatible' ⇒ kdf_key_id IS NULL` CHECK를 갖는다. expand 창에는 native NULL을 허용하고 D2 순서로 닫는다. Slack-compatible URL token hash는 KDF keyring을 사용하지 않는다. contract 단계의 outbound row도 모두 `kdf_key_id NOT NULL`이다.
- 기존 native row는 코드상 root가 항상 JWT였으므로 `legacy.jwt.v1`로 분류할 수 있다. 기존 outbound row는 배포에 따라 전용 key 또는 JWT fallback으로 발급됐으므로 **일괄 backfill하지 않는다**. upgrade preflight가 운영자의 발급 당시 root provenance를 확인해 `legacy.jwt.v1` 또는 기존 dedicated key ID로 분류한다. env에 지금 key가 있다는 사실만으로 과거 발급 root를 추측하지 않는다.
- secret 생성·검증·delivery는 row의 `kdf_key_id`로 root를 고른다. 알 수 없는 ID나 필요한 root 부재는 fail-closed이고 다른 root를 추측하지 않는다.

outbound sender는 전용 **NOBYPASSRLS** role로 전환한다. 전 테넌트 delivery discovery/lease는 `search_path=''`, 고정 ID projection·batch size·`SKIP LOCKED`만 허용하는 좁은 `SECURITY DEFINER claim_webhook_delivery_batch`로만 하고 EXECUTE는 sender role에만 준다. 반환된 각 delivery는 workspace별 `SET LOCAL app.workspace_id` tenant transaction에서 subscription의 current key ID/state를 재검사하고 settle한다. raw cross-tenant SELECT/UPDATE, 범용 SECURITY DEFINER, sender BYPASS role은 허용하지 않는다. root-generation fence와 claim-role cutover는 같은 rollout fence로 증명한다.

기존 설치의 migration은 **nullable expand → key-aware reader 배포(active-write legacy 유지) → 구 writer/sender fence·drain → NULL row별 classify 또는 개별 재발급 → dedicated active-write flip → per-row rotate → contract**다. inbound native와 outbound가 같은 안전 순서를 따르되 Slack-compatible row는 계속 KDF ID가 NULL이다.

1. 첫 migration은 native와 outbound `kdf_key_id NULL`을 허용한다. key-aware API/sender는 row ID를 읽을 수 있지만 active-write root는 계속 방향별 legacy root(native=`JWT_HMAC`, outbound=설치 provenance)다. 이 혼합 창에서 신 writer는 명시 legacy ID를 쓰고 구 writer는 NULL을 만들 수 있으며, 어떤 writer도 dedicated row를 만들지 않는다. 구 sender가 process-global legacy root로 claim해도 서명이 유지된다.
2. 모든 API writer와 sender를 key-aware generation으로 배포하고 NOBYPASS bounded-claim path를 shadow 검증한 뒤 old process/lease 0을 확인한다. DB claim permission·writer-generation fence와 sender role을 함께 전환해 구 BYPASS sender가 delivery를 claim하거나 구 API가 native/outbound credential row를 쓰지 못하게 한다. 이후 rollback은 NOBYPASS key-aware binary+legacy active-write ID로만 하며 구 binary/BYPASS role은 허용하지 않는다.
3. native NULL은 코드상 `legacy.jwt.v1`로 backfill한다. outbound에는 설치 전역 `LEGACY_OUTBOUND_ROOT_MODE` 같은 일괄 분류를 두지 않는다. 같은 설치도 env 변경 전후 row가 섞일 수 있으므로 운영자는 subscription ID별 provenance manifest로 각 row의 발급 root를 명시하고, migration은 manifest의 exact row set·중복·누락·현재 NULL 집합을 대조한 뒤 row별 ID만 갱신한다. 현재 env 존재나 설치 단위 동질성을 추측 근거로 쓰지 않는다. 행별 provenance를 증명할 수 없는 row는 NULL로 남겨 dedicated flip을 막고, compatibility mode에서 D3의 prepare→test→activate로 개별 재발급해 explicit dedicated ID를 얻은 뒤 다시 감사한다.
4. 방향별 대상 NULL 0과 old generation 0 뒤에만 active-write ID를 각각 `webhook.ingress.v1`, `webhook.outbound.v1`로 flip해 신규 native/outbound row를 dedicated/non-NULL로 만든다. 기존 row는 D3 상태기계로 개별 회전한다. Slack-compatible NULL은 이 카운트에서 분리한다. legacy/rollback window 0 뒤 별도 contract migration에서 native/outbound NOT NULL CHECK와 legacy code/root 제거를 수행한다.

### D3. 기존 credential은 자동 재파생하지 않고 개별 회전한다

- fresh install과 D2의 dedicated active-write flip 이후 신규 row는 전용 root만 사용한다. 기존 설치의 mixed-generation 창에는 신규 row도 legacy root만 사용한다.
- 기존 native installation은 현재 overlap rotation 모델을 사용해 전용-root key를 추가한 뒤 legacy key를 revoke한다.
- outbound는 단일 `X-Momo-Signature` 프로토콜을 유지하며 다음 **prepare→test→drain→activate** 상태기계를 사용한다. `prepare`는 pending `secret_ref+kdf_key_id`를 저장하고 새 secret을 한 번만 reveal하되 normal delivery는 계속 old active secret으로 서명한다. `test`는 명시적인 test event 한 건만 pending secret으로 서명하고 endpoint의 2xx와 operator 확인을 기록한다. normal claim은 subscription의 `credential_generation`을 delivery lease에 snapshot하고 send 직전 current generation/state를 재확인한다. `drain`은 그 subscription의 신규 normal claim을 멈추고 old-generation active lease·in-flight HTTP가 0이 될 때까지 기다린다. timeout이면 activate하지 않고 old active로 claim을 재개한다. `activate`는 test 확인+drain marker+old lease 0을 같은 transaction에서 재확인한 뒤 generation을 올리고 active/pending을 원자 교체하며 old tuple을 rollback window에 보존한다. 따라서 activate commit 뒤 old signature 요청이 늦게 도착해 401 permanent로 유실되는 창이 없다. window는 inbound 선례와 같은 기본 24시간, 허용 0~7일이며 그 뒤 명시 retire한다. normal request에 두 signature를 섞거나 “새 secret을 보여줬으니 적용됐다”고 추측하지 않는다.
- global env 교체만으로 row 의미를 바꾸는 절차는 금지한다. 같은 subscription에서 rotate operation은 하나만 진행하고 모든 상태 전이는 audit·idempotency key를 갖는다.
- legacy row count가 0이 되기 전에는 API가 legacy inbound root를, sender가 legacy outbound root를 좁게 소비할 수 있다. 0이 되면 sender에서 `JWT_HMAC` 전달을 제거하고 fallback code도 삭제한다.

### D4. boot posture를 설치 세대별로 구분한다

- 신규 설치·fresh production: legacy row와 구 binary가 없으므로 두 전용 root가 없거나 서로 재사용되면 boot/preflight 실패하고 dedicated active-write로 바로 시작한다.
- 기존 설치 upgrade: additive schema와 legacy-compatible binary를 먼저 배포한다. key-aware binary는 NULL row를 compatibility mode로 읽되 dedicated active-write를 금지하고, row backfill/classification은 old generation fence 뒤 per-row manifest 또는 개별 재발급으로만 수행한다. 명시적인 legacy keyring과 실제 legacy/NULL row가 있을 때만 제한적으로 허용하며 단순한 env 부재나 설치 전역 mode를 영구 fallback·일괄 provenance 승인으로 해석하지 않는다.
- startup에는 secret 값이 아닌 `{configured key ids, active write id, legacy/null row counts}`만 기록한다. 운영자는 NULL 0, 이어 legacy 0 도달을 확인한 뒤 순서대로 compatibility mode와 legacy root를 제거한다.

### D5. inbound route 제공 여부와 분리한다

이 결정은 key lifecycle만 정한다. 현재 runtime에 없는 `POST /v1/webhooks/{ws}/{id}`와 `POST /hooks/{token}`을 구현·공개할 권한은 주지 않는다. ingress 제공은 #1265/API 정직성 goal이 별도로 닫아야 한다.

## Consequences

- (+) JWT 회전과 webhook credential 회전이 분리되고, sender의 JWT 보유를 최종 제거할 수 있다.
- (+) 대량 무효화 대신 installation/subscription 단위의 관측 가능한 migration이 된다.
- (+) source self-host와 strict production의 보안 기본값이 같아진다.
- (-) 두 컬럼, key resolver/keyring, outbound rotation 표면과 운영 migration이 추가된다.
- (-) legacy row가 남은 동안 API 일부와 sender가 두 root를 보유한다. 기간을 계측·runbook으로 제한해야 한다.

## 검증 계약

1. fresh install은 서로 다른 32-byte 이상 두 webhook root를 만들며 placeholder/재사용을 거부하고 git tracked 파일과 stdout에 값이 없다.
2. 신규 native/outbound row는 전용 `kdf_key_id`만 갖고 JWT로 같은 secret을 만들 수 없다.
3. 기존 native는 deterministic backfill된다. outbound NULL row의 per-row manifest가 현재 NULL 집합과 정확히 일치하지 않거나 provenance가 모호하면 classification/dedicated flip이 red이고, 설치 전역 mode만으로 여러 row를 backfill하는 시도도 거부된다. 모호한 row는 prepare→test→activate 개별 재발급으로만 NULL을 벗어난다. key-aware/legacy active-write 혼합 창에는 dedicated 신규 row가 0이고 구 sender도 정상 서명한다. old writer/sender generation이 한 개라도 남으면 dedicated flip이 거부된다. 분류 뒤에는 전용 key를 설정해도 회전 전까지 기존 secret/signature가 유지된다.
4. outbound prepare 뒤 normal delivery는 old signature, test만 pending signature다. slow old-signature HTTP와 activate를 barrier로 경합시키면 activate는 old-generation lease/in-flight 0까지 대기하고, commit 뒤 시작·도착하는 normal delivery는 new signature뿐이다. test 2xx/확인·drain marker·old lease 0 없이는 activate가 거부되며 timeout은 old active claim 재개로 복귀하고 rollback window 동안 명시 역회전이 가능하다.
5. 회전 완료 row는 legacy root를 제거해도 정상이고, legacy root로는 검증/서명되지 않는다. 참조 중인 key ID 제거는 boot에서 거부된다.
6. unknown key ID, missing configured root, key 재사용, Slack-compatible row의 non-NULL KDF ID, native/outbound contract row의 NULL ID는 fail-closed다.
7. legacy outbound row 0 이후 webhook sender 환경·Debug·process inspection에 `JWT_HMAC`이 없다.
8. secret value는 API one-time response 외 로그/audit/error/gate evidence 어디에도 없다.
9. sender role의 raw cross-tenant `event_subscription`/delivery SELECT·UPDATE는 실패하고 bounded claim 함수만 고정 ID batch를 반환한다. 각 workspace settle은 다른 tenant row를 읽거나 변경하지 못하며 old BYPASS sender process/lease와 role grant가 0이다.

## 되돌리기

전용 root row를 legacy로 조용히 바꾸지 않는다. 배포 rollback이 필요하면 row별 key ID를 이해하는 직전 binary와 동일 keyring으로 돌아간다. 이미 전용 root로 회전한 credential은 그 root를 보존하고, 필요하면 다시 개별 회전한다. master key 자체의 분실은 복구가 아니라 영향받은 credential 재발급 사안이다.
