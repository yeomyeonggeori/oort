# oort 진행 현황

## Rust PG18 pgBackRest/WAL/PITR 폐곡선 · signed migration gate (#1330, 2026-08-12)

- 기존 PG18 단일 named volume·`archive_mode=off` 경로와 logical `pg_dump` smoke를 production backup 증거로 보지 않는다. pinned PostgreSQL 18+pgBackRest image와 encrypted POSIX/S3-compatible overlay가 exact wrapper archive command·60초 timeout·secret-file-only 경계를 고정하고, app/database 두 image는 각각 SBOM·max provenance·returned-digest SLSA attestation 뒤에만 release summary를 낸다.
- 로컬 closed loop는 marker A → online full backup → backup 이후 target UTC → marker B+강제 WAL archive → source와 다른 새 volume의 time-target restore → A=1/B=0·같은 system identifier·promote·archive off를 실측한다. active/used/nonempty restore target, repo/cipher/archive drift와 labeled resource leak은 evidence 생성 전에 RED다.
- `momo-migrate`는 production/staging SQL 전에 strict `momo-pitr-evidence/v1` HMAC, 15분 freshness, caller nonce·commit, source/restore/repo, 두 image digest, candidate migration bytes, live system identifier, backup/LSN/WAL/A-B/cleanup을 재검증하고, live migration 이력이 candidate set을 벗어난 schema downgrade도 거절한다. runner의 daemon-wide fixed-name lock container가 첫 lineage 검사부터 최종 healthy rollout까지 모든 signed migrate를 직렬화해 newer-schema/older-image 교차 배포를 막는다. 첫 install의 empty-bootstrap만 실제 빈 DB에서 별도 허용하고 local quickstart는 명시적 development warning posture다. 실제 NCP attach/S3 object-store/첫 GHCR database image publish·pull·attestation, scheduled full/differential host timer·실패 알림, #1332 귀속·사람 법무는 attended 후속 전까지 각각 `runtime-unverified(public host/schedule/legal)`다.

## Rust/NCP Centrifugo internal-only edge · secret rotation evidence (#1329, 2026-08-12)

- `infra/rust/Caddyfile`이 일반 `/v1/*` 프록시보다 먼저 `/v1/centrifugo/*`를 explicit 403으로 끝내므로 no-header/wrong/current secret 어느 요청도 공개 엣지에서 API 인증 표면에 닿지 않는다. compose-private API의 기존 constant-time 경계(no/old 401, current + malformed body 400)는 바꾸지 않았고 schema/API/DB/제품 동작 변경은 없다.
- 정적 contract와 mutation/redaction fixture가 deny 누락·순서 역전·API/Centrifugo secret source drift·회전/rollback 문서 누락·과거 공개 401/401/400·hash 불일치·current 401·원문 evidence 유출을 fail-closed로 고정한다. H1 재리뷰 뒤 운영 verifier의 공개 origin은 canonical `infra/rust/Caddyfile` 단일 site에서만 파생하며, attacker/오타/포트/userinfo/path/query/fragment/punycode 불일치는 secret read·Docker exec·network 전에 거절한다. curl은 redirect를 따르지 않고 3xx를 RED로 본다. test-only loopback은 env-file `MOMO_ENV=test` + exact loopback allowlist + synthetic fixture secret을 모두 요구한다.
- `docs/runbooks/ncp-rust-deploy.md`에 같은 창의 api+centrifugo recreate, old-env 검증, rollback을 고정했다. 이 goal은 운영 secret·NCP 배포를 변경하지 않으므로 실제 `app.oor7.com` reload/403/hash equality/회전 증거는 승인된 배포 창 전까지 `runtime-unverified(public host)`다.

## Shell layout gate exact-source · 인셋 포커스 계약 (#1314, 2026-08-12)

- `gate:shell` 실행 파일 자체가 매번 현재 checkout의 build를 spawn·await하고, build 실패 또는 산출물 부재는 기존 `dist`가 있어도 preview 전에 fail-closed한다. 수리 전에는 source를 `-2px`로 복구한 뒤에도 앞서 `+2px`로 만든 산출물을 그대로 읽어 전체 gate가 거짓 PASS하는 것을 실측했고, package entrypoint 배선·stale 산출물 + 실패 build·실제 child-process exit 23 fixture가 재발을 RED로 고정한다.
- 포커스 단정은 값을 복사하지 않고 `tokens.css`의 `@utility focus-ring`을 읽어 `outline-offset == -outline-width`인 인셋 관계를 강제한다. `+2px` fixture는 RED, 실제 `2px/-2px`는 1280/900/760 전 구간과 기존 keyboard/layout 단정에서 PASS했다. 제품 CSS와 시각 디자인은 바꾸지 않았고 이 goal의 별도 `runtime-unverified`는 없다.

## GHCR 발행·셀프호스팅을 현행 Rust 스택으로 일치 (#1266, 2026-08-12)

- 수동 `publish-images` 경로가 은퇴 중인 Swift/QEMU arm64 이미지 대신 라이브와 같은 `server-rust/Dockerfile` 단일 이미지를 native `linux/amd64`로 짓는다. `MOMO_BUILD_SHA=github.sha`를 SPA·OCI revision에 동시에 각인하고 digest 보고·max provenance·SBOM·Apache-2.0 메타데이터를 유지한다. 모든 action은 full commit SHA로 pin됐고, `main` ref 검사와 GitHub `release` Environment owner 승인 경계를 통과한 pushed digest에 `actions/attest` SLSA provenance를 OCI referrer로 발급한다. `sha-<gitsha>`는 이동 가능한 commit locator이며 digest만 불변이다. arm64 공개 artifact는 아직 지원하지 않는다.
- `scripts/self_host_env.sh`는 `local-build`와 `published-digest`를 env에 기록하는 배타적 모드로 나뉘었다. 발행 모드는 `ghcr.io/yeomyeonggeori/oort@sha256:<64hex>`만 받고 build 오버레이·`--build`를 빼며, mutable tag·잘못된 digest·기존 env의 mode/digest 교체를 쓰기 전에 거절한다. 외부 env-file 값의 LF/CR을 공용 scalar guard로 차단하고 owner email/password는 dotenv-safe literal만 받으며 기존 파일도 재검증한다. 중복 키는 거절하고 포트는 ASCII 10진수 1..65535로 정규화한 뒤에만 산술·연결에 사용한다. 모든 실제 env key·canonical Compose interpolation·Compose control env를 실행 시 process env에서 제거하는 `--compose` launcher가 정본 file set만 호출하고, config-source 교체 argv도 거절한다. 실제 `docker compose config`에서 secret·DB URL·WS URL·3개 port·project/image ambient 충돌이 모두 파일 값으로 수렴하고 앱 소비자 7개가 exact digest임을 확인하며 시크릿은 stdout/오류에 출력하지 않는다.
- 구조·행동 계약은 main-ref guard, full-SHA action, registry push↔attestation subject name+digest+OCI referrer, deploy-lib의 exact repository+SLSA v1 검증, env newline/dotenv-metachar/duplicate/process override·Compose argv 우회와 산술 주입 RED fixture를 고정한다. 로컬 `buildx --platform linux/amd64 --load`는 실제 이미지를 완성했고, inspect에서 amd64·`momo` 사용자·entrypoint·build SHA/Apache label, 컨테이너 안에서 바이너리 6종+엔트리포인트·LICENSE/NOTICE·SPA SHA stamp, 잘못된 role의 exit 2, 이미지 env의 시크릿 키 0개를 확인했다. `release` Environment는 attended readback으로 required reviewer `kwakseongjae`(id `87296259`)·`prevent_self_review=false`·custom branch policy `main` 하나를 확인했다(무 dispatch). 첫 GHCR publish·실 digest 핀·익명 pull·실 attestation 검증은 owner/M7 후속이라 `runtime-unverified`다. 이미지에 `NOTICE`는 동봉되지만 공개 재배포 전 의존성 귀속 완전성과 사람 법무 검토는 별도 게이트이며 이 티켓이 완결을 주장하지 않는다(법률 자문 아님).

## GitHub branch protection live payload 호환 (#1318, 2026-08-12)

- 첫 attended bootstrap에서 GitHub가 `required_status_checks.contexts=[]`와 app-pinned `checks`를 함께 받은 요청을 서로 다른 OpenAPI `oneOf` 형상에 동시에 맞는 HTTP 422로 거절했다. 보호 PUT은 이제 `strict: true`와 `checks`만 내보내며, 기존 legacy `contexts`는 의미를 버리지 않고 `{context, app_id: -1}` check로 정규화한다.
- 오프라인 transport가 혼합 형상을 live 422처럼 거절하고, 혼합 필드를 되살린 mutation이 첫 PUT에서 RED·성공 write 0인지와 stronger policy를 포함한 exact checks-only payload를 함께 고정한다. 원격 attended apply/readback은 이 수정의 track/engine→main 랜딩 뒤 새 bootstrap provenance로 재시도하므로 아직 `runtime-unverified`다.

## Canonical track 정렬 가드레일 (#1297, 2026-08-12)

- `main`은 두 `track/*`의 조상이어야 하고 track-ahead는 정상이라는 topology를 `scripts/check_track_alignment.sh`로 기계화했다. remote/local behind·divergence, canonical upstream 오배선, ref 누락, non-fast-forward candidate는 이름을 대고 실패하며, 격리 fixture가 각 RED와 ahead PASS를 고정한다.
- local gate·pre-push·merge-tree가 같은 checker를 소비하고, `track-alignment` workflow가 세 canonical branch push + 매일 + 수동 실행에서 remote drift를 감시한다. `pr-ci`는 이제 `main`·`track/engine`·`track/uxui` 모두에서 돌며, branch protection은 `PR CI gate`와 #1302의 `Policy integrity gate` 두 context를 요구한다.
- #1295 재발 방지로 OpenAPI 또는 `clients/web-legacy` 생성 계약이 바뀌면 전용 CI lane이 legacy lockfile을 검사한 뒤 permissive license와 generated-type 정합을 함께 검증한다. GitHub 보호는 `scripts/github_track_guardrails.sh`가 정상 track-ahead에서도 동작하는 기본 read-only check와 bootstrap-only `--apply`로 PR-only·conversation resolution·GitHub Actions app-ID 고정 context·force/delete 금지와 Actions 기본 read·PR 승인 금지를 관리한다. 다만 app-ID만으로 후보 workflow 자기변조를 막을 수 없으므로 trusted policy-integrity gate #1302가 main에 랜딩하기 전에는 보호를 적용하지 않는다. 실제 apply는 #1297·#1302 main 랜딩, 세 트랙 동일 SHA 정렬, 두 context 생성 후 통합자 몫이다.

## Trusted policy integrity (#1302, 2026-08-12)

- public/Free 환경에서 Enterprise ruleset을 가정하지 않고, base-only `pull_request_target` evaluator가 후보 checkout·실행·의존성 설치 없이 API metadata만 검증해 exact PR head/run attempt에 `Policy integrity gate`를 게시한다(ADR-0153 D5). 같은 Actions App/name status는 충분하지 않으므로 통합 직전 **현재 PR의 exact canonical base branch/HEAD에서 wrapper bytes가 그 base와 일치하는 checkout**으로 `scripts/verify_policy_integrity_from_base.sh --repo yeomyeonggeori/oort --pr <PR>`를 실행한다. wrapper는 PR API exact base object의 verifier를 추출하며 worktree/candidate verifier bytes는 무시하고 실행하지 않는다. 그런 다음 head/base·current default-main workflow authority·workflow ID/path·event·attempt·base run-name·check-suite app·evaluator job·live policy evidence와 최종 재읽기를 묶는다.
- 정책 변경은 지정 policy owner `kwakseongjae`/GitHub user id `87296259` author, 같은 지정 owner의 exact `Policy-Integrity-Audit: <40sha>` comment, 그 뒤 같은 owner가 적용한 현재 `policy-change-approved` label을 모두 요구하고 head/comment/label transition 변경 후 재승인한다. workflow가 아직 base에 없는 **#1302의 track/engine→main 최초 랜딩 체인**과 기존 verifier의 live status-user/App identity 결함을 고치는 **#1307의 track/engine→main 수리 체인**만 reviewed bootstrap 예외이며, #1307 main 랜딩·갱신 wrapper 재검증 뒤부터는 예외가 없다. 그때 target별 docs-only unmerged bootstrap PR을 `--policy-pr main=N,track/engine=N,track/uxui=N` verify → apply → check로 처리한다. workflow_dispatch seeding은 쓰지 않는다. 첫 live PR에서 status bot, run/suite/job App, bare workflow path와 PR-head 내부 SHA 형상을 관측했으며, 아직 관측하지 않은 대체 API 형상은 의미를 추정하지 않고 내부 SHA 일치로 fail-closed한다.

## Policy status live provenance (#1307, 2026-08-12)

- 첫 live `pull_request_target`에서 commit status creator는 GitHub Actions App id가 아니라 `github-actions[bot]`/user id `41898282`/`Bot`으로, check-suite는 별도 App id `15368`/slug `github-actions`로 실측됐다. verifier와 RED fixture가 status bot identity와 run/suite/job App identity를 분리해 각각 exact 결속하며 provenance JSON도 두 축을 따로 기록한다.
- PR #1306에서 #1307 구현을 사용한 read-only 진단은 live status→run attempt→suite→job 결속과 provenance JSON을 끝까지 확인했다. 다만 이것은 후보 구현 진단이지 merge 권위가 아니며, 기존 exact-base verifier 자체의 live-shape 결함을 고치는 #1307 track/engine→main 랜딩 체인만 독립 리뷰·두 required context·local gate를 근거로 한 reviewed bootstrap 예외다. main 랜딩 뒤 갱신된 exact-base wrapper로 새 #1306 head를 재검증하는 것이 이 예외의 폐쇄 조건이며 결과는 PR #1306 evidence에 기록한다. 남은 `runtime-unverified`는 원격 branch-protection apply/readback과 아직 관측하지 않은 대체 run-head 형상이다.

## Secret gate RED proof 결정화 (#1296, 2026-08-12)

- 확률적으로 entropy 임계값을 못 넘던 random-hex fixture를 완성 literal 없이 런타임 조립되는 gitleaks 내장 AWS 형상으로 교체했다. 실제 history scan·비노출·fingerprint baseline·nonmatching baseline·missing-scanner fail-closed 계약은 그대로다.

## OpenAPI 생성 타입 재동기화 — web-legacy 게이트 복구 (#1295, 2026-08-12)

- lockfile에 고정된 `openapi-typescript 7.13.0`으로 `docs/api/openapi.yaml`을 다시 생성해 `clients/web-legacy/src/api/schema.d.ts`를 byte-identical하게 맞췄다. 빠졌던 notification-rules 경로·DTO와 human `presenceStatus`, 그 사이 추가된 run binding/refine 계약도 정본에서 그대로 복구됐다.
- `verify_web_generated_types.sh` green과 임시 dummy path의 이름 있는 `types-stale` red proof·생성물 bytes 복원을 확인했다. 정적 생성물 동기화라 별도 runtime 미검증 범위는 없다.

## React Native 작업 콘솔 — T1/T2/T3 위치·읽기 전용 상세 (#1292, 2026-08-11)

- 모바일 하단 탭에 워크스페이스 범위 `작업` 목록을 추가했다. 최근 최대 200개를 진행 우선으로 보여 주고 `전체`/`진행`(`running|idle`)을 가르며, 호스트·채널·담당자·도구·시작/종료 시각과 공유 `workExecutionLocation`의 정확한 `T1 · 데스크톱 앱` / `T2 · 셀프호스트` / `T3 · 클라우드` / `실행 위치 확인 필요` 표식을 함께 쓴다. 기존 AgentDetail의 눈에 보이는 실행 위치도 같은 정본 mapper로 통일했다.
- 폰 전용 상세는 durable typed lifecycle·tool·ACP 요약과 발원 대화 이동만 제공한다. raw PTY·명령 입력/출력·cwd/env·controller/owner 제어·observer attach·새 native/WebView 의존성은 추가하지 않았고, 숨은 작업 탭은 polling/realtime을 유지하지 않는다.
- 검증: review 보정 뒤 mobile typecheck·lint(오류 0)·전체 Jest 1,144/1,144와 core typecheck·lint·전체 Vitest 1,173/1,173, lane/measure shell syntax·Maestro YAML parse, `verify_merge_tree.sh --base origin/track/uxui --head HEAD --install`의 웹·폰·코어 8레인이 green이다. 좁은 4탭은 Dynamic Type 줄바꿈, 필터는 3:1 경계, 상세↔대화↔목록은 VoiceOver 초점 복귀, 긴 상세는 rotor heading을 보장하며 light/dark·긴 한국어·접근성 글자 캡처가 measure lane에 포함됐다. 현재 booted Simulator가 없어 캡처·Maestro 실주행은 `runtime-unverified`다.

## Work Console v1 — 전용 작업 관제와 T1/T2/T3 위치 표식 (#1289, 2026-08-11)

- 웹과 같은 번들을 쓰는 Tauri 데스크톱에 `/work` 전용 master-detail 진입점을 추가했다. 워크스페이스 작업 세션을 상태·담당자·채널·도구·명시 시각과 함께 보고, `?session=` 주소로 같은 기존 세션 상세에 다시 들어가며 목록을 접어 상세·터미널을 전체 route 폭으로 볼 수 있다.
- 실행 위치는 서버 정본 `work_host.type`만으로 `T1 · 데스크톱 앱`·`T2 · 셀프호스트`·`T3 · 클라우드`를 판정하며 상태와 별도 icon+text로 표시한다. Project/repo/worktree/cwd는 현 계약에 없으므로 추론하지 않는다.
- 터미널은 기존 host-direct observer를 그대로 재사용한 **읽기 전용** 표면이다. 실제 Tauri↔Rust workd 관전 폐곡선, controller 입력 PTY, Project 계층과 GUI preview는 후속 계약·goal이며 `runtime-unverified`다.

## 데스크톱 셸 집중 모드 — 56px 레일 유지 + 184px 탐색 패널 접기 (#1291, 2026-08-11)

- **웹/Tauri 공용 AppShell에 비지속 접기를 추가했다.** 텍스트+아이콘 `탐색 패널 접기`와 레일의 `열기`가 왕복하고, 채널/프로필 패널만 빠져 채팅과 같은 주 표면이 정확히 184px 넓어진다. 이미 열린 WorkPanel의 subtree와 wide 상태는 왕복 중 유지된다. `/work`도 #1290 합류 뒤 같은 두 번째 shell track을 그대로 받으며 별도 레이아웃 분기는 없다.
- **포커스와 모바일 경계를 닫았다.** 숨은 패널의 모든 포커스 대상은 탭/AX 트리에서 빠지고 포커스는 살아 있는 토글로 이동한다. 데스크톱 토글을 쥔 채 `<600px`로 가면 현재 route의 모바일 opener가 이어받되, route에 이미 가시 포커스가 있으면 빼앗지 않는다. 서랍·스크림·Escape는 독립이며 새 AppShell 마운트에는 접힘 상태가 남지 않는다.
- **검증.** typecheck · build · web 891 tests · lint 0 errors(기존 warning 7) · design pre-flight 10/10+3/3 · #1291 집중 shell gate 1280/900/760 + 390px, light/dark 전부 PASS. 양 스킴 캡처 직접 검수 Blocker 0; 전체 `gate:shell`의 기존 플러그인 포커스 링 offset 단정 3건은 이 변경과 무관한 baseline RED로 별도 관측했다.

## ADR-0158 서버 축 — `runId` 서비스 개시 · refine 공지 · 어댑터 스트림 (#1130 W-N, 2026-08-08)

- **`POST …/messages`의 `runId` 거절이 풀렸다(D5).** 검증 3종은 전송 트랜잭션 **안**에서 fail-closed다(`momo_agent::authorize_run_binding_in_tx`): run 실재 · 같은 워크스페이스 · 요청 주체가 그 run의 에이전트(`agent_run.agent_member_id == principal.member_id`). 안 보이는 run은 **404**(RLS가 타 테넌트 행을 감추므로 더 구체적인 답은 존재 확인이 된다), 보이지만 남의 것이면 **403**. 통과하면 `message.run_id` 컬럼과 `props.run_id` 사본을 **함께** 쓴다 — 전자는 서버측 닫기가 미완성 답을 찾는 키, 후자는 히스토리 페이지가 `runEnded`를 정하는 키라, 하나만 쓰면 두 독자 중 하나가 못 본다.
- **취소가 어댑터가 연 스트림을 닫는다(ADR-0155 완전체).** 종전엔 REST로 연 메시지에 `run_id`가 없어 `open_stream_message_for_run_in_tx`가 아무것도 못 찾았고, 닫는 PATCH는 정확히 prime/hermes 경로에서만 조용히 무동작이었다. 신규 conformance가 in-process 스위트의 **여섯 단정을 같은 순서로** 재현한다(동결된 본문 · `outcome: cancelled` · `streaming: false` · `state='sent'`·`editedAt` NULL · 메시지 1행·seq 불변 · 두 번째 닫기는 no-op).
- **자기수정 공지가 채널 사건이 됐다(D1~D4).** `type: "system"` + 서버 소유 `props["momo.harnessRefine"]`(refinementId·trigger·scope·edits·summary·rollbackId). 멱등 키는 **파생**이다 — `client_msg_id`가 uuid 컬럼(동결층)이라 `RefinementResult.id` 문자열을 `uuidv5(momo.harnessRefi, id)`로 해싱한다(`tool_result` 키와 같은 전례). 다른 값을 보내면 400이 **기대값을 이름 대고** 거절한다. RPC 유래와 파일 관찰 유래가 같은 키로 모여 한 줄이 된다.
- **유출 금지가 기계적이다.** `harnessRefine`과 그 `edits[]`가 `deny_unknown_fields`라, 하네스 본문(`before`/`after`)을 실은 공지는 **422로 거절**된다 — 조용히 잘려 발신자가 배달됐다고 믿는 경로가 없다. `scope`는 `workspace` 외 전부 400(어댑터는 워크스페이스별 HOME이라 하네스의 `global`을 그대로 옮기면 거짓말이다). `momo.harnessRefine`은 서버 소유 키 목록에 올라 클라이언트 props로는 절대 안 들어간다.
- **어댑터가 자기 자격증명으로 슬라이스를 쓴다(증보 1 D7 — 성재 승인).** W-N이 적발한 공백: `required_agent_scope` 표가 메시지 라우트를 `POST` **하나만** 매핑해 agent bearer의 `PATCH …/messages/{id}`가 403이었다. Swift 원본에도 없었고 #1152/#1173 conformance는 **사람 로그인**으로 증명해서 아무도 이 질문을 안 했다 — 스파이크가 턴당 17 메시지였던 실제 이유가 이것이다(POST만 열려 있었다). D7이 PATCH 행을 추가했다. **새 스코프는 안 만들었다** — 여는 write와 잇는 write는 같은 행위이고(#1152: 한 턴 = 자라는 한 메시지), 스코프를 가르면 어댑터가 한 문장 쓰는 데 두 개가 필요하고 이미 발급된 `messages:write` 토큰을 전부 재발급해야 한다.
- **범위를 좁히는 것은 스코프가 아니라 저자 검사다 — 그리고 그건 이미 있었다.** `stream_message_body_in_tx`·`edit_message_in_tx` 둘 다 비저자를 `NotAuthorForEdit`로 **다른 무엇을 보기 전에** 거절하고, 비교 대상 actor는 요청 본문이 주장할 수 없는 자격증명의 멤버다. 그래서 검사는 **추가하지 않고 실측으로 확인만** 했다 — 같은 `messages:write`를 든 두 번째 에이전트의 PATCH가 403이고 본문이 그대로다. 에이전트가 지키는 규칙이 사람이 지키는 규칙과 **같은 하나**이지 병렬 사본이 아니다. `DELETE`는 같은 경로에서 계속 닫혀 있다(메서드로 매칭 — 잇는 것과 무르는 것은 다른 행위이고 스트리밍에 후자는 필요 없다).
- **red proof 5종 전부 실주행 반전 확인.** ① 소유권 체크 제거 → 남의 run에 대한 POST가 403 대신 **201**. ② 검증 블록 제거 → 타 워크스페이스 run이 404 대신 **201**로 테넌트 타임라인에 들어간다(`message.run_id` FK는 워크스페이스 쌍이 없는 전역 FK이고, uuid를 컬럼에 넣는 것은 그 행을 읽는 게 아니라 RLS가 안 잡는다 — 스위트가 검증 없는 경로를 **실제로 실행해** 커밋을 단정한다). ③ 파생 키 검증 제거 → 한 refinement의 재시도가 **두 줄**이 된다. ④ D7 스코프 행 제거 → 슬라이스가 **403 회귀**. ⑤ 저자 검사 제거 → 남의 답 안에 다른 에이전트의 문장이 **200으로 들어간다**.
- **검증.** `cargo fmt --check` green · `cargo clippy --workspace --all-targets -D warnings` 0 · `cargo test --workspace` 실패 0 · `run_binding_refine_conformance_pg` 3/3(실 PG18+`momo_app` NOBYPASSRLS) · 인접 실DB 스위트 무회귀(`stream_edit` 9 · `stream_message` 6 · `mention_routing` 13 · `agent_run_cancel` 4 · `run_terminal_backfill` 6 · `http_smoke` 3 · `client_rewire` 4 · `gateway_mode` 2) · `verify_openapi_contract_rust.sh` **PASS 55/55** · `verify_merge_tree.sh` **7레인 green**.

## 게이트 위생 — 14단계가 게이트 경유에서만 빨갛던 이유는 **드리프트한 사본** (#1185, 2026-08-08)

- **증상은 환경 차이였지만 원인은 코드였다.** `local_gate.sh`는 모든 단계를 `bash -lc`(로그인 셸)로 돌린다. 이 기계의 로그인 PATH는 `/usr/bin`을 `/opt/homebrew/bin`보다 앞에 두므로 `ruby`가 **2.6.10**으로 잡히고, psych 3은 `YAML.load_file(..., aliases: true)`의 `aliases:` 키워드를 모른다(`unknown keyword: aliases (ArgumentError)`). 같은 명령을 직접 실주행하면 ruby 4.0.6이 잡혀 초록이었다 — #1181·#1184의 14단계 초록이 전부 직접 실주행이었던 이유.
- **정작 죽은 자리는 2차 패스였다.** 1차 패스(`verify_openapi_contract.sh`)에는 `aliases:` 없이 재시도하는 psych 3 갈래가 **이미 있었다**. #1042가 만든 2차 패스(`verify_openapi_contract_rust.sh`)는 그 변환을 "1차 패스와 같은 변환"이라 주석 달고 **복사**했는데 재시도만 빠져 있었고, 그래서 곧장 python 갈래로 떨어졌다. 그 python은 `PYTHON_BIN`(≥3.10 기준으로 고른 python3.13)이고 PyYAML이 없다. Swift 패스가 기본 off인 지금 2차 패스는 **유일한 기본 패스**이므로 14단계 전체가 죽었다.
- **수리: 사본을 지웠다.** `scripts/openapi_spec_to_json.sh` 신설 — 소스 전용 라이브러리 한 벌을 두 패스가 같이 부른다. 인터프리터의 **자격을 실측**해서 갈래를 고르고(psych 4+면 `aliases: true`, psych 3-면 무키워드 — `RUBY_VERSION` 숫자 비교는 psych 백포트에 거짓말한다), **어느 갈래로 뛰었는지 언제나 한 줄 출력한다**(`spec->json reader: ruby 2.6.10 (psych 3-, …)`). 조용한 강등 금지(#1089·#1181 전례).
- **실패도 정직해졌다.** 종전 ruby 갈래는 `2>/dev/null`로 이유를 삼키고 "need ruby or python yaml"이라는 일반문으로 죽었다. 이제 갈래별로 실격 사유를 이름 댄다: `ruby : ruby 2.6.10 has no aliases: keyword…` / `python: python3.13 has no PyYAML (import yaml failed)`.
- **로그인 셸 PATH 고정은 기각했다.** 게이트가 PATH를 다시 쓰는 것은 레포 밖 기계 전역을 건드리는 수리이고, 고쳐도 "이 기계에서 어떤 ruby가 먼저 잡히는가"에 초록이 계속 매달린다. `OPENSSL_BIN`(LibreSSL은 Ed25519를 못 한다)·`PYTHON_BIN`(MOMO-458, Xcode 3.9 회피) 선택이 이미 **자격 실측** 규율이고, 이번 수리는 그 규율을 ruby로 넓힌 것이다. 기각 사유는 새 파일 헤더에 남겼다.
- **두 ruby 갈래는 오늘의 스펙에서 동등하다.** ruby 4.0.6 `aliases: true`와 ruby 2.6.10 무키워드의 JSON이 **263332 바이트 동일**. `docs/api/openapi.yaml`에는 현재 앵커/별칭이 0개라 `aliases: true`는 미래 대비이고, psych 4에서 키워드를 뺀 채 별칭이 등장하면 Psych가 예외를 던지므로 **조용히 틀린 JSON이 나오는 경로는 없다**.
- **red proof를 영구화했다.** `scripts/tests/test_local_gate_hardening.sh`에 `aliases:`만 거부하는 가짜 ruby를 PATH 앞에 세우는 픽스처를 추가했다 — 변환 성공 + **갈래 고지 문자열**을 함께 단정하므로 조용한 강등이 초록으로 통과하지 못한다. 두 번째 픽스처는 리더가 하나도 없을 때 갈래별 이유를 대고 죽는지를 단정한다. 실측: psych 3 갈래를 제거하면 이 테스트가 빨개지고 로그인 셸 변환이 다시 `no qualified YAML reader`로 죽는다.
- **`local_gate.sh` shell syntax 목록에 3개를 넣었다** — 신설 라이브러리와, 그동안 빠져 있던 `verify_openapi_contract_rust.sh`까지.

## 게이트 위생 — Swift 패스 강등·병합 트리 게이트·선재 FAIL 규명 (#1089/#1099/#1108/#1057, 2026-08-06)

- **1차(스펙 ↔ Swift) 패스를 기본 off 로 강등했다(ADR-0145 증보 2-②).** `OPENAPI_GATE_SWIFT_PASS=1` 로만 켜진다. 강등 자체보다 중요한 것은 **대가를 이름 붙인 것**이다: 1차가 꺼지면 `openapi_sampled_on_rust.txt` 밖의 연산은 "스펙에 있으나 어느 패스도 보지 않는" 상태가 되므로, 게이트가 그 목록을 매 실행 경고로 **전부** 출력한다(실측 **125/128**, 매니페스트가 덮는 것은 3). 커버리지가 조용히 사라지는 상태를 만들지 않는다 — 목록은 매니페스트가 자랄수록 줄고, 0이 되는 날 1차 패스는 되살릴 이유가 사라진다(#1042 잠식 완료).
- **불변으로 둔 것.** `known-unsampled`의 의미는 그대로 **1차 패스만의 부채 장부**이고, 1차가 꺼진 실행에서는 아예 참조되지 않는다(그 패스가 안 도니 그 패스의 부채도 성립하지 않는다). 두 패스를 동시에 끄는 조합은 **거부**한다 — 아무도 샘플하지 않는 초록은 게이트가 아니다.
- **`scripts/verify_merge_tree.sh` 신설(#1108).** 재는 것이 브랜치가 아니라 **병합 결과**다: `git merge-tree --write-tree` → 임시 커밋 → 임시 워크트리 → 거기서 웹·폰·코어 3종 typecheck + 스위트. 브랜치 HEAD는 한 번도 체크아웃되지 않는다(그것이 이미 초록인 판이므로). 기본은 이 체크아웃의 `node_modules`를 심볼릭 링크로 빌려 써 **20초**에 끝나고, 병합 결과의 락파일이 다르면 자동으로 `npm ci` 모드로 전환한다(코어는 npm workspace라 락파일·node_modules가 레포 루트에 있다 — 그걸 틀리면 빌려 쓰기 경로가 죽은 코드가 된다).
- **선재 FAIL 4건은 원인이 하나였다(#1089).** `gate:shell`(=`gate:shell-layout`, 같은 스크립트다)·`gate:my-sessions`·`gate:huddle` 셋 다 로그인 직후 **토큰 회전 스텁 부재**로 죽고 있었다. 실측 로그: 로그인 200 → `POST /v1/auth/refresh` → 포괄 스텁의 `{channels:[]...}` → 코어 `refreshResponseFromWire` throw → `markAuthExpired()` → 앱이 스스로 로그아웃 → `channel-list`/`open-work-panel`/`nav[워크스페이스 탐색]` 30초 타임아웃. 형제 게이트 12개는 전부 이 스텁을 갖고 있었고 이 셋만 빠져 있었다. 세 줄로 셋 다 초록.
- **`gate:scroll`은 자격증명 요구 자체가 근거 없었다(#1089).** `?stress=N`은 행을 클라이언트에서 만들고 네트워크를 타지 않는다 — 라이브 서버가 필요했던 것은 로그인 왕복 하나였고 그건 스텁으로 대체된다. 자체 preview + 스텁 세션으로 재배선하고 `npm run gate:scroll`을 등록했다(실측 1000행·최대 DOM 36행·120.3fps·33ms 초과 프레임 0). 가상화가 무너진 판에서 "빠르다"고 통과하던 구멍도 함께 막았다(행 수 단정 추가). 라이브 측정은 `SCROLL_GATE_BASE`+자격증명을 **함께** 줄 때만.
- **`capture:design`이 118프레임 중 95에서 죽던 이유(#1099): 길게 누르기의 손 떼는 동작이 자기가 연 시트를 닫고 있었다.** 실측 이벤트 로그가 `touchEnd` 직후 `mousedown/click target=sheet-react-👍`를 보여 준다 — Chrome은 취소되지 않은 터치의 touchEnd 뒤에 호환용 마우스 이벤트를 **놓았던 좌표에** 합성하고, 화면 아래에 붙는 시트가 그 좌표를 덮는다. 실제 Chrome은 700ms 홀드를 GestureLongPress로 인식해 그 탭을 소비하지만 `Input.dispatchTouchEvent`로 낸 터치는 그 인식기를 거치지 않는다 — 즉 **원시 터치 디스패치의 산물**이다. `touchCancel`로 바꿔 모델링을 맞췄고(앱 쪽에서도 `pointercancel`로 눌림 상태가 깨끗이 풀린다), 첫 열기가 우연히 살아남던 자리의 **조용한 초록**(시트가 닫혀 행 0개인데 44px 단정이 무사통과)도 함께 막았다.
- **설정 표면 6개가 캡처 레인에 들어왔다(#1057).** 계정·알림 규칙·워크스페이스·앱·사용량·멤버와 초대. 라우트가 없어 프리뷰 서버로 새면 404 → 에러 경계였으므로 "안 찍힌" 것이 아니라 "찍으면 빨간 판"이었다 — 픽스처(사용량·구독 잔여량은 모델 테스트가 계약으로 붙잡는 그 JSON)를 붙이고, **에러 경계가 그려진 판은 캡처가 아니라 실패**가 되게 단정을 넣었다. 전체 실행 **130 프레임 완주**(baseline은 95에서 중단).
- **같은 자폭 로그아웃이 캡처 하네스 셋에 더 있었다.** `capture:usage`·`capture:standalone`·`capture:honesty`도 `/v1/auth/refresh` 스텁이 없었다. 셋 다 고쳤고 red proof도 세웠다(스텁을 빼면 `capture:usage`가 `channel-list`에서 다시 죽는다). 앞의 둘은 초록으로 완주. **`capture:honesty`는 로그인을 통과한 뒤 진짜 단정에서 멈춘다** — 아래 관측 2.
- **검증.** 웹 750 tests(40 files)·typecheck 0·eslint error 0(warning 11, base 동일) · `cargo test --workspace` **740 passed / 0 failed / 145 ignored**(러스트 무변경) · `bash -n` green, shellcheck 신규 경고 0(잔존 SC1007 2건은 base와 같은 `CDPATH=` 관용구) · openapi 게이트 강등 경로 **PASS**(경고 125/128 → 2차 패스 3/3 샘플 일치) · `verify_merge_tree.sh` 자기 브랜치 대상 **6/6 green**(20초).
- **웹 게이트 전판 실행표 (2026-08-06, 이 브랜치).** 자체 완결 게이트 **17/17 green**: `gate:shell` · `gate:scroll`(신규 등록) · `gate:wire` · `gate:csp` · `gate:boot` · `gate:huddle` · `gate:my-sessions` · `gate:agent-hub` · `gate:workstream` · `gate:approvals` · `gate:work-panel` · `gate:ailink` · `gate:quote` · `gate:typing` · `gate:borders` · `gate:fold` · `gate:composer`. **skip 3**: `gate:inject`·`gate:seq`·`gate:resume` — 라이브 momowebqa와 `MOMO_EMAIL`/`MOMO_PASSWORD`가 필요해 워커 세션에서 실행 불가(자격증명 취급 금지). `gate:scroll`은 그 셋과 같은 이유로 묶여 있었는데, 요구가 근거 없음이 드러나 이번에 스텁으로 풀렸다 — 남은 셋은 실서버 왕복 자체가 대상이라 같은 방식으로 풀리지 않는다. 캡처 하네스: `capture:design` 130프레임 완주 · `capture:usage` green · `capture:standalone` 6샷 green · `capture:honesty` **RED(관측 2 — 제품 단정)**.
- **red proof 4종.** ①#1108: 코어 API를 재편한 브랜치와 그 API를 새로 소비하는 폰 브랜치를 각각 초록으로 만든 뒤 병합 → **폰만 RED, `TS2353`**(U4-6 B1과 같은 오류 코드·같은 자리). ②openapi: `OPENAPI_GATE_SWIFT_PASS=1`이면 다시 1차 패스 경로로 들어간다(스테이지 2 도달을 BASE_URL 모드의 이름 있는 실패로 확인). ③`SWIFT_PASS=0 + RUST_PASS=0`은 거부되고 exit 1. ④`capture:usage` 회전 스텁 제거 시 `channel-list` 타임아웃 재현.
- **관측 1 (반경 밖 · 차단 요인).** `server-rust/Dockerfile`이 **origin/track/engine에서 빌드되지 않는다.** 의존성 레이어의 하드코딩된 매니페스트 COPY 목록에 `crates/momo-drive/Cargo.toml`(#1111 신설)이 빠져 `cargo build`가 `failed to load manifest for workspace member .../bins/momo-server`로 죽는다. 강등 뒤 2차(Rust) 패스가 **유일한 기본 패스**이므로 이건 openapi 게이트 전체를 막는다. `server-rust/`는 이 워커의 반경 밖이라 손대지 않았고, 검증은 같은 base commit으로 오늘 만들어진 `momo-rust:laneA-724b772d` 이미지를 `MOMO_RUST_IMAGE`로 재사용해 수행했다(레인 워커가 이미 같은 벽을 넘은 것으로 보인다). **머지 전에 이 한 줄이 닫혀야 한다.**
- **관측 2 (별건 티켓 필요).** `capture:honesty`가 회전 스텁 수리 뒤 로그인을 통과하고 나서 `죽은 결정 대기 탭이 아직 서 있다`로 멈춘다 — 승인 표면이 없다고 답하는 서버에서 인박스의 `결정 대기` 탭이 접히지 않는다는 **제품 단정**이다(W-AP1이 `approvals.provided`를 뒤집은 뒤 이 분기가 갱신되지 않은 것으로 보인다). 의미 없는 빨강(로그인 타임아웃)이 의미 있는 빨강으로 바뀐 것이므로 되돌리지 않았다.
- **관측 3 (후속).** `capture:design`의 설정 > 앱은 **빈 카탈로그**로 찍는다. 출하 시드 매니페스트를 한 줄 얹으면 그 프레임 자체는 나오는데 **그 다음 섹션 전환이 무너진다**(다음 섹션에서 `settings-route`가 30초 안에 안 돌아오고, 클릭으로 넘기는 판에서는 `사용량` nav 버튼 클릭이 같은 자리에서 죽는다). `앱` 패널의 `wide` 마켓플레이스 레이아웃 쪽으로 보이며 카탈로그가 비면 재현되지 않는다. 카탈로그가 있는 판은 `gate:shell`이 두 매니페스트로 이미 측정하므로, 이 하네스에 넣는 것은 위 전환 결함을 규명한 뒤의 일이다.

## MOMO-680 자사 플러그인 매니페스트 도구 설명 한국어화 (#921, 2026-07-30)

- **웹 레인(#914/#917)이 인계한 데이터 변경을 닫았다.** `server/Fixtures/plugin-manifests/{github,notion,linear,drive}.json`의 `tools[].description` 7건이 한국어가 되고, 마이그레이션 **059**가 같은 문자열을 `plugin_registry`에 재시드한다. 서버 코드 변경 0 · 웹/맥 클라이언트 변경 0.
- **웹이 세운 원칙은 그대로다.** 결정 표면(동의 다이얼로그)은 배포자 자유 문구를 결정 문구로 승격하지 않고 도구 이름으로 식별하며, 배포자 산문은 증거 표면(앱 상세 > 도구와 권한)에만 남는다. 제3자 매니페스트는 어떤 언어로도 들어올 수 있어 데이터 번역이 근본 해법이 아니고, 그래서 이 티켓은 **자사 픽스처 4종의 문구 품질만** 다룬다. 그 판단을 마이그레이션 헤더와 새 테스트 주석에 붙여 다음 사람이 "왜 4개뿐인가"를 다시 묻지 않게 했다.
- **번역은 "무엇을 허용하는지"를 보존한다.** 원문의 안전 정보 두 축을 문장에 그대로 남겼다 — 위임 경계("권한을 위임한 사용자가 접근할 수 있는 …")와 드라이브 경계("설정된 공유 드라이브 **안에서**", 개인 Drive 전체가 아니라는 사실). 도구 이름(`github.search_issues` 등)은 번역하지 않았고, 과장어·명령형 없음.
- **digest를 함께 회전시키지 않으면 카탈로그가 전부 닫힌다.** `plugin_registry.manifest_digest`는 런타임 admission의 expected 값이고 `PluginRoutes.registryRow`가 `'sha256:' || encode(sha256(convert_to(pr.manifest::text,'UTF8')),'hex')`를 computed로 계산해 대조한다(불일치 = 409 `plugin manifest rejected`). 059는 **런타임과 같은 식**을 그대로 써서 회전시키고, 새 테스트가 두 문자열이 같음을 잠근다 — 한쪽만 리팩터링되면 테스트가 먼저 깨진다.
- **대상은 3-튜플 매칭이라 배포자 편집을 덮지 않는다.** `(plugin_id, 도구 이름, 013/015/031 원문 영문 description)`이 정확히 일치하는 도구만 다시 쓰고, 배열은 **이름으로** 매칭한다(031이 github에 `search_issues`를 덧붙인 뒤라 인덱스 고정은 깨지기 쉽고, 배열 순서는 배포자가 선언한 제품 순서라 보존한다). 실측 검증: 한 도구를 원문 영문으로, 다른 도구를 배포자 문구로 바꿔 놓고 059를 재실행하면 **영문만 한국어로 복구되고 배포자 문구는 그대로**이며 digest는 계속 일치했다.
- **재시드는 두 층에서 멱등이다.** 러너 2-pass가 `IDEMPOTENCY_OK second-pass applied=0 skipped=59`를 남기고(파일명 skip), 059 파일을 **직접 재실행하면 `UPDATE 0`**이다(`IS DISTINCT FROM` + 위 3-튜플 가드) — 러너를 우회해도 무해하다.
- **검증(실주행).** `swift build` green · MomoServer **359 tests** green(신규 1 포함) · `check_migration_numbers.sh` PASS(59 files) · 픽스처 4종 JSON 파싱 green. 격리 PG18(`pgvector:0.8.5-pg18-trixie`, 임시 컨테이너·작업 후 회수)에 **001~059 전량 적용 실주행**: 도구 7건 전부 한국어로 저장, `manifest_digest = computed`가 5행 전부 `t`(자사 4종 + `external_webhook`), 059 직접 재실행 `UPDATE 0`.
- 새 테스트 `testOfficialPluginManifestToolDescriptionsAreKoreanAndMatchReseedMigration`는 픽스처를 파싱해 도구별 문자열을 대조하고, **모든 도구 description에 한글이 있어야** 통과한다 — 나중에 영문 도구가 하나 추가되면 표를 갱신하지 않고는 green이 안 된다(자매 도구 누락 방지).
- **관측(이 PR 범위 밖, 판단 필요).** `external_webhook`(014 seed) 매니페스트의 `tools[0].description`은 여전히 영문이다("Registry-only marker; ingress is available only through the webhook REST surface"). 픽스처 파일이 없는 서버 소유 마커 행이고 `installAllowed:false`/`approvalPolicy:"deny"`라 허용 가능한 동작의 설명이 아니며, 맥 클라이언트는 `isChannelIntegration`으로 상세를 **아예 로드하지 않아**(`MomoPluginMarketplaceStore.loadDetail`) 도구 행으로 노출되지 않는다. 다만 **웹에는 그 채널-통합 예외가 없어** 앱 상세에서 이 문장이 보일 수 있다 — 데이터 번역보다 웹의 예외 처리 쪽 문제로 보여 손대지 않았다.

## MOMO-678 local_gate 웹 타입 동기화 단계를 다시 의미 있게 만든다 (#919, 2026-07-30)

- **먼저 판단: `clients/web-legacy`는 살아 있다.** UI 개발은 `clients/web`으로 옮겨 갔지만(ADR-0133, 최근 8커밋 대 legacy 1커밋) legacy는 죽은 코드가 아니라 **알파가 실제로 서빙하는 산출물**이다 — `infra/prod/Dockerfile.web:8-17`이 이 디렉터리를 빌드해 `/opt/momo-web/`에 넣고, `infra/docker-compose.e2e.yml:354`의 `web-init`이 그 dist를 볼륨에 복사하며, `scripts/verify_web_login_smoke.sh:89-97`·`scripts/verify_web_serving.sh`가 그 dist를 실제 브라우저로 몬다. `clients/web-legacy/README.md:5-7`이 같은 말을 정본으로 적어 뒀다("이 v0는 폐기되지 않았다"). `.github/dependabot.yml`도 여전히 추적한다. **그래서 제거가 아니라 수리다.**
- **제거를 기각한 이유는 대체 신호가 없다는 것이다.** `clients/web`에는 생성 타입 자체가 없고(`find clients/web/src -name schema*` 0건) `--auto`가 `all`로 넓힐 뿐 전용 프로파일이 없다. `scripts/verify_openapi_contract.sh`는 **스펙 대 라이브 서버**를 보지 스펙 대 클라이언트 타입을 보지 않는다. 이 단계를 지우면 "배포되는 웹 클라이언트가 스펙과 맞는가"를 컴파일 타임에 확인하는 곳이 레포에서 **0개**가 된다.
- **생성물 갱신.** `openapi-typescript 7.13.0`으로 재생성 — `/v1` 경로 64 → 100(+`/health` = 문서 경로 101, 스펙과 일치). provider 경로가 처음으로 들어왔다.
- **재생성이 실제 결손 두 개를 드러냈다.** ① `WorkObserverView.tsx`의 `STATUS_LABEL`은 `Record<WorkSession["status"], string>`이라 ADR-0139가 추가한 `idle`이 빠져 `tsc`가 TS2741로 잡았다 — 이것이 타입 동기화 단계가 지키려던 바로 그 부작용이다. 라벨은 `clients/web/src/features/work/workSessionModel.ts:154`의 정본 문구 `완료 · 대기 중`을 그대로 썼고, `.work-status-idle`은 `--text`(전체 강도)로 뒀다: idle 세션은 work-pool 슬롯을 물고 있고 재개 가능하므로 `ended`의 muted와 같이 보이면 **살아 있는 세션을 끝난 것으로 표시**하게 된다. 초록(`--ok`)은 `running` 전용으로 남긴다.
- ② **같은 누락이 타입이 아니라 조건문에도 있었다.** `ObserverTerminal.tsx`의 `available`이 `status === "running"`만 봐서, **서버가 내주는 관전을 클라이언트가 숨기고 있었다** — 스펙(`issueTerminalAttachCapability`: "The running or idle session must carry a MomoHost-signed remote PTY binding")과 서버(`TerminalAttachRoutes.swift:209` `guard (status == "running" || status == "idle")`, 그리고 209행과 같은 쌍을 쓰는 343행 SQL)가 둘 다 running-or-idle이다. 조건과 함께 안내 문구도 넓혔다(`실행 중이거나 대기 중이고 …`) — 코드만 넓히고 문구를 두면 화면이 자기 동작을 부정한다. 타입 결손만 고치고 이 분기를 두는 것이 이 레포에서 가장 흔한 재발 형태라 같이 처리했다.
- **단계 자체를 수리했다 — 상시 red는 무신호였다.** 기존 인라인 한 줄은 ⓐ 생성기 실패와 드리프트를 **같은 "stale" 문구**로 뭉갰고(스펙이 안 파싱돼도 "클라이언트가 낡았다"고 말한다), ⓑ 실패 시 재생성된 파일을 워크트리에 **남겨** 다음 실행이 무관한 `worktree clean`에서 죽게 만들었다 — 진짜 드리프트 신호가 혼란스러운 신호로 세탁된다. `scripts/verify_web_generated_types.sh`로 뽑아 실패마다 이름을 붙이고(`generator-failed`·`types-stale`·`spec-missing`/`client-missing`) 모든 종료 경로에서 `src/api/schema.d.ts`를 복원한다. 개발자가 실행하는 것과 **같은 명령**(`npm run generate:types`)을 돌린다 — 게이트가 다른 호출을 검증하면 안 되기 때문이다. 스펙 경로는 `package.json`의 `gen:api`가 하드코딩하므로 env 오버라이드를 일부러 두지 않았다(생성기가 읽지도 않을 두 번째 입력을 흉내내게 된다).
- **red proof 2종(Docker 불필요, 실주행).** ① 스펙에 `/v1/momo678-red-proof` 한 경로 추가 → `FAIL: types-stale`, exit 1, 진단에 `committed: 101 / regenerated: 102`와 해당 diff 블록, 실행 후 워크트리 복원 확인. ② 스펙 끝에 깨진 YAML 추가 → `FAIL: generator-failed ... This is NOT a staleness failure`, exit 1 — 두 실패가 서로 다른 이름으로 갈린다. 둘 다 뒤에 스펙·생성물 원복 확인(`git diff --stat` 공백).
- **검증.** 웹 프로파일의 Docker 무관 단계 전부 실주행 green: `npm ci`(212 pkgs) · `eslint` · `vitest` 9 files/73 tests · `tsc --noEmit` · 새 검증기 PASS(101 paths) · `vite build` · 라이선스 게이트 PASS(272 pkgs). `bash -n` green, `shellcheck -S warning`은 신규 스크립트 0건이고 `local_gate.sh`는 base와 **동일 프로파일**(양쪽 0건). `swift build --product MomoServer` green(서버 파일 무변경). **Docker 의존 3단계(`web_serving_smoke.sh`·`verify_web_login_smoke.sh`·`verify_openapi_contract.sh`)는 `runtime-unverified`** — 오케스트레이터 실행 대기다.

## MOMO-679 Workstream 표면 R1 잔여 — 피커 위계·말줄임·역링크·소유자 병기 (#920, 2026-07-30)

- **M3 피커: 컨트롤을 두 벌 두지 않는다.** 같은 act를 제안하는 표면이 둘인데(작업 세션 패널의 재개, 작업 흐름 상세의 이어받기) 그 아래 두 문장은 이미 글자 그대로 같게 쓰기로 한 것이었고 컨트롤만 두 벌이었다. `features/work/HostPicker.tsx` 하나로 합치고 어휘만 호출자가 준다 — FilterTabs가 인박스/작업 흐름 사이에 세운 형태다. 바뀐 것 셋: ① 위계 — 호스트 버튼이 채움(`default`)이고 그것을 접는 토글은 열린 뒤 `ghost`로 물러난다(v1은 `호스트 선택 닫기`와 `성재 맥북`이 같은 outline·같은 size였다). ② 그룹 라벨이 **눈에 보인다** — `role="group" aria-label`은 스크린리더 전용이었다. `aria-labelledby` + 실제 텍스트로 바꾸고, 토글은 `aria-controls`로 그 그룹을 가리킨다. ③ **폭이 상태를 따라 흔들리지 않는다** — `flex-wrap justify-end` 줄에서 라벨을 `성재 맥북`에서 `이어받는 중`으로 바꾸면 누른 버튼이 넓어져 형제가 포인터 아래에서 미끄러진다. `--spacing-action-sm`(96px) 바닥만으로는 부족하다(size="sm" 실측: 이름 84px vs 스피너 단 진행 문구 120px). 그래서 글자를 바꾸지 않고 **아이콘 자리를 상설**로 둔다 — 평소 기기 아이콘, 진행 중 같은 16px 상자의 스피너. 상태는 `aria-busy`와 접근성 이름이 나른다. 실측 결과 96/127/170px가 진행 중에도 그대로다.
- **M3의 나머지 절반은 픽스처였다.** 게이트가 자격 호스트를 언제나 하나만 줘서 **다중 호스트 화면을 아무도 본 적이 없었다**. workspace scope 하나와 읽는 사람 소유 member scope 하나를 더해 자격 3·비자격 3으로 만들고, 자격 판정이 여전히 서버 경계와 같은지(죽은 원본 호스트·꺼진 러너·남의 개인 호스트 제외) 정렬 순서까지 잠갔다. 피커가 열린 화면은 양 스킴 캡처(`picker-{light,dark}.png`)로 남는다.
- **M4 목록 목표: 두 줄까지 접는다.** 055가 200자를 허용하는데 한 줄 말줄임은 640px 읽기 폭에서 40자만 남겼고, 행의 나머지 사실은 채널 이름뿐이라 접두사가 같은 두 목표는 같은 행이 됐다. `line-clamp-2`로 60자 이상 읽히게 하고, 목표 문장만으로 갈리지 않는 두 행을 실제로 가르는 두 번째 사실 — **시작한 사람** — 을 메타 줄에 더했다(상세가 이미 같은 이름 규칙으로 말하는 값이다). `title` 툴팁은 쓰지 않는다: 키보드로 열 수 없고, 전체 목표는 이 행이 이미 링크하는 상세에서 잘리지 않고 읽힌다.
- **M5 원장과 세션 사이 왕복.** 실행 이력 `<li>`가 링크가 됐다(`/c/{channel}?work={runId}`). 작업 세션은 라우트가 아니라 채널 표면 안의 패널이라 링크가 채널과 세션을 함께 말하고, ChatShell이 그 열쇠를 한 번 읽고 주소에서 지운다(패널의 열림·닫힘은 컴포넌트 상태이므로, 남겨두면 사람이 닫은 뒤에도 주소가 열려 있다고 말한다). 반대 방향은 `GET /workstreams?sessionId=`(이미 있는 질의)로 세션 상세 위에 목표 한 줄을 놓는다 — 이 링크가 없어서 작업 흐름 표면은 사이드바에서 출발할 때만 도달 가능했다. 서버 변경 0.
- **M6 에이전트 소유자 병기.** agent actor에 `--agent` 토큰만 얹혀 있고 "누가 책임지는가"가 없었다(skill §9). 문장은 멤버 디렉터리·타임라인이 이미 쓰는 `managed by {owner}` 그대로다 — 같은 사실을 세 표면이 다른 말로 부르면 읽는 사람이 셋을 다른 사실로 읽는다. 오너를 로스터에서 못 찾으면 비운다(MemberRow와 동일). 이름 규칙 자체는 `workstreamActor`로 model에 올려 목록·상세가 함께 쓴다.
- **함께 볼 것 — `aria-controls`는 형제 표면과 같이 고쳤다.** 비활성 탭이 문서에 없는 id를 가리키던 것은 이 셸의 탭 위젯이 활성 패널만 렌더하기 때문이고, 인박스도 같은 성질이었다. 워크스트림만 고치면 갈라지므로 **두 호출자가 공유하는 `FilterTabs` 한 곳**에서 선택된 탭에만 관계를 둔다. 같은 형태를 이 레포가 이미 두 곳에서 쓴다(WorkPanel의 peek, WorkSessionDetail의 발췌 폼). 작업 세션 패널의 재개 토글에도 같은 규칙을 적용했다.
- **Low 7종 처리.** ① `?msg=`·`?seq=`가 URL로 무동작이던 것을 **함께** 고쳤다 — 점프는 인박스 행의 onClick으로만 일어나서 주소를 복사해 새 탭에 붙여넣으면 채널만 열렸다. ChatShell이 두 열쇠를 한 곳에서 읽되 행이 마운트된 뒤에 워처를 건다(가상 목록이라 첫 페이지 전에는 DOM에 행이 없고 3초 창이 그 사이 지나간다). ② `messageIdSelector`가 CSS 선택자에 값을 그대로 끼워 넣던 것 — 이제 그 값이 주소창에서 오므로 따옴표 하나가 `querySelector` SyntaxError로 채널 표면 전체를 넘어뜨린다. 인용된 속성값이 담을 수 없는 셋(`"`·`\`·raw newline)만 이스케이프하고 유닛 테스트로 잠갔다(`CSS.escape`는 식별자 문법용이고 DOM 전역이라, 그 분기를 쓰면 테스트가 도는 가지와 제품이 도는 가지가 갈린다). ③ 칩 기하 인라인 5중을 `features/common/chip.ts`의 `CHIP_CLASS` 한 줄로(타임라인 포함, 만진 파일의 나머지 분기까지). ④ 404 분기 h1 부재 → `EmptyInvite`·`InlineBanner`에 `heading` opt-in을 더해 **페이지를 대신한 분기**에만 h1을 준다(목록의 빈 상태들은 헤더 h1이 살아 있으므로 받지 않는다). 상세의 오류 분기에도 같이 적용했다. ⑤ `작업 흐름 목록` → `작업 흐름 목록 보기`(동사, skill §7). ⑥ `retry:false` → 앱 기본(`retry:1`): 이 목록에는 서둘러야 할 404가 없고, 한 번 흔들린 GET이 형제 목록들과 달리 바로 오류 문구를 그렸다. ⑦ 게이트 캡처가 전환 중 촬영하던 것 → `settle()`(2 프레임 + `getAnimations()` 정지 확인)을 모든 샷 앞에 붙였다. 사이드바 현재 표시가 캡처에서 살아났다.
- **게이트가 7종에서 10종으로.** 신규: ⑧ 피커 위계와 폭(채움 유무·보이는 라벨·`aria-controls`·**진행 중 형제 좌표 1px 불변**, 포인터를 치우고 전환이 끝난 뒤 계산된 스타일로 잰다) · ⑨ 목록 목표 두 줄 접힘(`webkitLineClamp`와 잘린 높이를 함께 확인해, 픽스처가 짧아 접힐 일이 없으면 "이 단정이 아무것도 재지 않는다"로 실패한다) · ⑩ 원장과 세션 사이 왕복(목표 → 실행 → 같은 목표). 에이전트 소유자 병기는 ②에 붙였다. 되돌림 증명은 **이름 있는 seam 4종**으로 늘었다(`_LEDGER` 신규: 두 투영이 같은 실행을 다른 id로 부르게 만든다). ⑧·⑨는 제품 성질이라 픽스처로 붉힐 수 없으므로 되돌릴 제품 한 줄을 게이트 머리말에 적어뒀다(HostPicker의 상설 아이콘 자리를 v1 라벨 스왑으로, `line-clamp-2`를 `truncate`로).
- **검증(전부 로컬 실주행, docker 비의존).** `npm run typecheck` · `npm run lint`(기존 경고 4건, 무증가) · `npm test` **959 passed**(기준 950 + 9) · `npm run build` · `scripts/design_preflight_web.sh` **10/10 PASS**. `npm run gate:workstream` **GATE PASS**(단정 10종), red proof 4종 전부 이름 있는 실패로 재현: `_RUNS`는 `실행 이력 A·B 병기…`, `_RESUME`은 `이어받기 왕복…`, `_DENIAL`은 `비멤버 404/403 분기…`, `_LEDGER`는 `원장 역링크…`. 기존 게이트 무회귀: `gate:shell` · `gate:wire` · `gate:csp` · `gate:huddle` · `gate:my-sessions`(WorkPanel 피커 교체분 포함) · `gate:agent-hub` 전부 PASS.
- **runtime-unverified**: `gate:seq` · `gate:resume`는 라이브 momowebqa 자격증명(`MOMO_EMAIL`·`MOMO_PASSWORD`)이 필요해 이 워커 범위 밖이다 — 실행 전 `must be set in the environment`로 종료하며 이 변경과 무관한 기존 조건이다. design-review도 오케스트레이터 몫이고, 양 스킴 캡처는 게이트가 `clients/web/artifacts/workstream/{list,detail,picker,closed}-{light,dark}.png`로 남긴다.
- 손대지 않은 것: 서버·데몬·마이그레이션 · #918이 세운 것 전부(측정 폭 `MEASURE_CLASS`·FilterTabs 재사용·break-keep·끝난 목표 분기·성공 후 포커스 이동·기존 단정 7종) · `--danger`/`--danger-fill` 위계 · `--spacing-action`/`-sm` 정의.

## MOMO-675 provider link/chain·effort-table 응답 스키마 승격 — 자리표시자 제거 (#913, 2026-07-30)

- **#904가 남긴 관측을 닫았다.** `GET/PUT/DELETE /v1/provider/link/chain`과 `GET /v1/provider/effort-table`의 응답이 `{type: object, additionalProperties: true}`였다. shape check는 스키마에 적힌 것만 대조하고 `additionalProperties: true`는 **명시적 opt-out**이므로(`openapi_shape_check.py:150-152`), 이 네 연산은 샘플이 있어도 필드가 사라지든 새 키가 생기든 통과했다. 서버 코드 변경 0 — 스펙이 코드를 따라간 방향이다.
- **스키마는 DTO에서 그대로 읽었다.** `ProviderChainResponse`/`ProviderChainEntryDTO`(`ProviderLinkChainRoutes.swift:341-367`), `ProviderEffortTableResponse` 계열(`ProviderEffortTableRoutes.swift:176-197`). entry의 `bearerLast4`·`updatedAtMs`·`updatedBy`만 optional로 두고 나머지 8개는 required다. Swift 합성 `Encodable`은 nil을 `encodeIfPresent`로 **생략**하므로 `nullable: true`가 아니라 "부재"로 적었다 — 게이트가 null을 거부하는 정책과 같은 방향이고, 여기서 nullable을 붙였으면 서버가 실제로는 낼 수 없는 값을 계약이 허용했을 것이다.
- **enum을 비워 두면 승격이 절반이다.** `type: string`만으로는 값 드리프트가 안 잡히므로 세 축을 코드에서 확인해 채웠다: `source`는 `database|environment|chain`(position 0은 `ResolvedProviderConfig.Source`, hop은 `ProviderCascadeHop.Source.chain`), `mode`는 `local-mock|internal-host-mock|external-hermes`(`Config.swift:502-505`의 `AgentProviderMode`와 migration 042의 `provider_link_chain_mode_ck`가 같은 3값), `schema` 문자열은 상수 그대로 단일값 enum. effort 레벨은 스펙이 이미 3곳에서 인라인으로 쓰던 `[low, medium, high, xhigh, max]`를 그대로 따랐다.
- **PUT 요청 본문도 같이 승격했다.** `PutProviderChainRequest`는 서버가 **closed-world 디코더**로 미지 키를 400으로 던지는 DTO다(`ProviderLinkChainRoutes.swift:406-423`). 응답만 승격하고 요청을 자리표시자로 두면 "아무 키나 받는다"고 문서가 거짓말한다 — ADR-0004 Rules #1-#2가 API 표면에서 지켜진다는 사실 자체가 계약이므로 `additionalProperties: false` + `maxItems: 8` + `position` `minimum: 1`로 적었다.
- **`security:`는 코드가 정본이다.** 두 경로 모두 `App.swift`의 `authed` 그룹(AuthMiddleware + MemberRateLimitMiddleware)이라 `bearerAuth` + 401/429다. chain 3종은 추가로 `requireOperator`를 지나므로 403을 **전용 컴포넌트 `ProviderOperatorForbidden`**으로 뒀다: 공용 `Forbidden`("활성 워크스페이스 멤버 아님, 또는 워크스페이스 스코프 불일치")은 이 경계를 틀리게 설명하고, "워크스페이스 admin만으로는 부족하다"가 MOMO-583의 요점이다. `effort-table`은 `requirePrincipal()`만 거치므로 403을 적지 않았다 — 나지 않는 상태코드를 적는 것도 드리프트다.
- **red proof (Docker 불필요, 실주행).** DTO가 내는 본문을 그대로 재구성해 `scripts/openapi_shape_check.py`에 직접 물렸다. green(4/4 PASS, exit 0) 뒤 네 가지 red가 전부 **연산 이름으로** 실패한다: `attemptableCount` 제거 → `FAIL provider-chain-get [GET /v1/provider/link/chain -> 200] $: required key 'attemptableCount' is missing`, `bearerUnavailable` 제거 → `provider-chain-put`의 `$.entries[0]`/`[1]`, `fallback` 제거 → `provider-effort-table`, 미선언 키 추가 → `provider-chain-delete`의 `undeclared key`. 승격 전 스키마로는 넷 다 PASS였다.
- 검증: spec YAML 파싱 green(ruby 2.6 fallback 형태·python-yaml 둘 다), `$ref` 미해결 0건, 연산 수 128 불변(paths 101), 네 연산 블록에 `additionalProperties` 잔존 0. `scripts/verify_openapi_contract.sh`는 **무변경**이라 `bash -n` green·shellcheck 새 경고 0(잔존 SC1007 2건은 base와 동일). **게이트 완주(128 연산·142 샘플)는 Docker 스택이 필요해 `runtime-unverified`** — 오케스트레이터가 `scripts/verify_openapi_contract.sh` PASS를 확인해야 한다.
- 별건 보고(이 PR 범위 밖): `clients/web-legacy/src/api/schema.d.ts`가 스펙과 이미 어긋나 있다 — 생성물에 `/v1` 경로 64개뿐인데 스펙은 101개이고 provider 경로는 아예 없다. `local_gate.sh:855`의 "web generated API types in sync" 단계는 이 변경 이전부터 red다. → **MOMO-678(#919)에서 닫았다**(위 섹션).

## MOMO-677 Workstream 웹 표면 v1 — 목록·이력·이어받기 (#915, ADR-0143 이행 3, 2026-07-30)

- **서버는 한 줄도 건드리지 않았다.** #898이 랜딩한 세 투영(`GET /workstreams`, `/workstreams/{id}`, `/workstreams/{id}/runs`)만 소비하고, 이어받기는 **기존 계보 재개 REST**(`POST /work-sessions/{id}/resume`)를 그대로 재사용한다. 새 라우트·새 동사·새 권한 문법 0건이므로 openapi 부채 목록도 그대로 0건이다.
- **진입점은 사이드바 전역 목적지**(`/workstreams`, 인박스·활동·멤버·에이전트 옆). 근거는 #860이 에이전트 허브에 쓴 것과 같은 판단에 하나를 더한 것이다: 작업 흐름은 "가는 곳"이고, 무엇보다 **채널 서랍에 있을 수 없는 유일한 작업 표면**이다 — 작업 세션 패널은 지금 있는 채널과 (가장 많이 쓰는 범위에서는) 내 세션으로 좁혀져 있는데, 이어받을 것을 찾는 사람은 정의상 **내 것이 아닌 일**을 찾는다. 상세는 별도 라우트(`/workstreams/:id`)다: 멈춘 목표를 남에게 넘기는 것이 이 표면의 목적이고 그 부탁은 URL로 이동한다.
- **A·B 병기가 증거다.** 실행 이력은 서버 순서(오래된 것부터) 그대로 한 목표 아래 실행자를 전원 병기하고, 에이전트 Run은 `--agent` 토큰으로 자기 정체를 유지하며, 계보를 이은 Run은 `이어받음`을 단다. 상세 메타의 `참여자 N명`은 이력이 실제로 도착한 뒤에만 말한다(그 목록에 대한 주장이므로).
- **거부의 비대칭을 뒤집지 않는다.** 비멤버는 목록 0건 + 상세/이력 404이고 재개만 403이라는 서버 계약(최소 노출)을 UI가 그대로 옮긴다: 404는 "이 작업 흐름을 찾을 수 없습니다"로만 말하고 **권한을 입에 담지 않는다**(그 순간 서버가 거부한 존재 신호를 클라이언트가 돌려준다). 멤버십을 말하는 곳은 403을 실제로 답하는 재개 경로 하나뿐이고, 409/404/그 외는 각각 다른 문장을 갖는다.
- **미커밋 WIP는 약속하지 않는다**(ADR-0143 D3). 이어받기 문구는 작업 세션 패널이 쓰는 두 문장을 글자 그대로 재사용한다("Git 계보만 새 호스트로 이어집니다. 이전 호스트의 터미널 상태와 미커밋 변경은 옮겨지지 않습니다"). 막힌 분기 문구 전체가 "가져옵니다"를 말하지 않는지 유닛 테스트가 잰다. 라이브 PTY takeover(ADR-0141 보류)·명시 생성/분리/병합(P2)·Task 계층은 만들지 않았다.
- **호스트 자격은 한 곳에서만 판정한다.** `workSessionResumeTargets`의 파라미터를 구조적 타입으로 넓혀 작업 세션 패널과 작업 흐름이 같은 함수를 부른다(죽은 원본 호스트·오프라인·남의 개인 호스트 제외). 같은 행위에 대해 두 표면이 서로 다른 호스트를 제안하는 길을 남기지 않기 위해서다.
- **앵커 스레드 링크**(대화가 정본, ADR-0114): 워크스트림 투영에는 seq가 없고 `rootMessageId`만 있으므로, 기존 인박스 점프 문법에 **두 번째 신원**을 더했다 — `MessageRow`가 `data-message-id`를 함께 게시하고 `anchor.ts`가 `messageAnchorPath`/`watchForMessageId`를 추가한다(감시기 본체는 하나로 합쳤다). 카드가 로드된 머리보다 오래됐으면 기존 seq 감시기와 똑같이 조용히 만료되고, 독자는 어쨌든 맞는 채널에 있다.
- **디자인 규율.** 4상태 전부(빈/로딩/오류/오프라인) + 필터가 0건인 빈 상태를 별도 문구로. 상태 칩 4값 중 **액센트는 `멈춤` 하나**뿐이다 — 나머지가 평시이고, 평시에 색을 쓰면 상태판이 "아무 일도 없음"을 보고하게 된다(tokens.md §5a). 실행 시각은 `{7월 29일}{22:23}`로 쪼개 **숫자만 mono·tabular**로 둔다: 한글 산문을 mono에 넣으면 음절 사이가 벌어지는 것이 이 레포의 실측 규칙이다(§4). 행은 헤더·상세와 같은 `max-w-pane-lg` 읽기 폭을 쓴다.
- **검증(전부 로컬 실주행, docker 비의존).** `npm run typecheck` · `npm run lint`(기존 경고 4건, 무증가) · `npm test` **944 passed**(기준 923 + 21) · `npm run build` · `scripts/design_preflight_web.sh` **10/10 PASS**. 신규 `npm run gate:workstream` **GATE PASS**(목록·서버측 필터·A·B 이력·에이전트 토큰·계보 표식·이어받기 왕복·404/403 분기·760px 가로 스크롤 0), 되돌림 증명 3종 전부 **이름 있는 실패**로 재현: `_RUNS`→`실행 이력 A·B 병기: expected both actors under one goal, got ["김서연"]`, `_RESUME`→`이어받기 왕복: waited for this and it never happened`, `_DENIAL`→`비멤버 404/403 분기: a 404 workstream did not render the not-found state`. 기존 게이트 무회귀: `gate:shell` · `gate:my-sessions` · `gate:agent-hub` · `gate:huddle` · `gate:csp` 전부 PASS.
- **runtime-unverified**: `gate:seq` · `gate:resume` · `gate:wire` · `gate:scroll`은 라이브 momowebqa와 자격증명이 필요해 이 워커 범위 밖이다(오케스트레이터 실행 대기). design-review도 오케스트레이터 몫 — 양 스킴 캡처는 게이트가 `clients/web/artifacts/workstream/{list,detail}-{light,dark}.png`로 남긴다.

## MOMO-676 동의 모달 R1 Medium 5종 + #849 잔여 8·9·10 (#914, 2026-07-30)

- **M-1 카탈로그 `설치됨` 칩을 중립으로 내렸다.** MOMO-642 ⑦이 다이얼로그의 같은 문자열을 ok 초록에서 내리면서 카탈로그 행을 남긴 근거는 "위험 칩과 경쟁하지 않는 다른 표면"이었는데, `plugin-marketplace-layout`은 1200px 이상에서 2컬럼이라 그 행과 상세의 위험도·승인 칩이 **한 뷰포트에 함께 선다**. 게다가 같은 문장이 행에서 초록, 다이얼로그에서 회색이면 사실 진술이 아니라 상태가 변한 것처럼 읽힌다. `StatusChip`은 색에만 의미를 싣지 않으므로(설치됨/비활성/미설치는 세 문자열이 이미 구분한다) 잃은 정보는 없다. 이 표면에서 색은 위험 신호의 것이다.
- **M-2 진행 중 커서 `not-allowed` -> `wait`.** 같은 조건(이 뮤테이션의 쓰기 진행 중)에 커서가 둘이었다 — 카탈로그 행은 `disabled:cursor-wait`, 다이얼로그 체크박스는 `cursor-not-allowed`. 주석이 밝힌 의도는 "지금은 못 바꿈"(쓰기가 끝나면 풀린다)이므로 `wait`가 맞다. 레포에 남은 `not-allowed`는 전부 진짜 `disabled` 컨트롤의 `disabled:` 변형(input/select/textarea/checkbox)이라 같은 규칙에 걸리지 않는다: **실제 disabled면 not-allowed, aria-disabled 일시 잠김이면 wait**.
- **M-3 다이얼로그 푸터는 한 폭을 공유한다.** 규칙은 "한 푸터의 두 버튼은 같은 폭이고, 그 폭은 **그 푸터가** 보일 수 있는 가장 긴 라벨이 정한다". 설치 해제 확인 다이얼로그가 동의 다이얼로그의 144px(= "권한을 하나 이상 선택" 실측 127px 기준)를 빌려 쓰면서 취소 47px 옆에 144px가 서서 3:1이 됐다. 이 푸터의 Chromium 실측은 취소 47px · 설치 해제 69px · 스피너를 단 "변경 중" 82px(스왑 13px)이므로 신규 토큰 `--spacing-action-sm`(96px, 14px 여유)을 **양쪽 버튼이 함께** 쓴다. 같은 규칙을 동의 다이얼로그에도 적용해 그쪽 취소도 `min-w-action`(144px)을 갖는다 — 강조는 채움이 하지 폭이 하지 않는다. 실측 결과 두 푸터 모두 96/96, 144/144.
- **M-4 다중 원인 배너가 진짜 목록이 됐다.** `"• " + 문장`을 `\n`으로 이어 하나의 `<span>`에 넣던 것을 `InlineBanner`의 `items` opt-in으로 바꿔 `ul`/`li`로 그린다(`list-disc list-outside`). 타이핑한 불릿은 목록이 아니었다: 리스트 시맨틱이 없고, `role="alert"`가 전체를 한 문장으로 읽고, 소프트 랩된 줄이 불릿 아래로 붙었다. 실측(빌드된 CSS, 512px 다이얼로그): 4줄로 접힌 항목의 **모든 줄이 x=49px에서 시작**(행잉 인덴트 성립), 4-scope/2-원인 배너 높이 201px < 스크롤박스 272px(직전 문자열 판 171px 대비 +30px — 항목 간 `gap-1`과 마커 들여쓰기 값이고, #849 ⑤가 세운 높이 예산 안이다). `list-style: none`이 아니라 `list-disc`인 이유는 Safari가 마커 없는 목록에서 list role을 떨어뜨리기 때문이다(데스크톱 셸이 WKWebView). `whitespace-pre-line`은 공유 컴포넌트에서 완전히 사라졌다(#849 ④의 잔재 해소).
- **M-5 한국어 산문은 어절에서 끊는다.** `break-keep`(word-break: keep-all)을 **산문 표면의 뿌리에만** 건다: `InlineBanner`·`EmptyInvite`(공유 4대 상태 문구), `SectionShell` 헤더 블록, 앱 카탈로그 목록·상세 패널·두 다이얼로그. 전역 선언은 하지 않았고 코드·id·수치 표면은 제외다 — 식별자 자식(스코프 id, URL, 도메인)은 자기 자리의 `break-all`로 이 규칙을 덮고, ASCII는 `keep-all`의 영향을 받지 않는다. **함정 하나를 실측으로 피했다**: tailwind-merge v2는 `break-words`와 `break-keep`을 한 그룹으로 묶어 마지막 하나만 남기므로(`twMerge("break-words break-keep")` -> `break-keep`) 같은 엘리먼트에 두면 overflow-wrap이 조용히 사라진다. word-break는 상속되므로 부모가 keep-all, 자식이 break-words를 갖게 나눴고 브라우저에서 두 속성이 함께 계산됨을 확인했다.
- **#849 ⑧ 회수 다이얼로그에서 배포자·라이선스·출처·도메인·약관을 걷어냈다.** 그것들은 **허용하는** 결정의 근거이고, 끊는 결정을 하나도 바꾸지 않으면서 "무엇을 잃는가"를 여섯 줄 아래로 민다. 앱 상세 패널이 같은 증거를 그대로 보여주므로 사라지는 정보는 없다.
- **#849 ⑨ 결정 문구는 이 클라이언트의 문장이다.** 동의 다이얼로그 권한 행에서 매니페스트 `tools[].description`(배포자가 자기 언어로 쓴 자유 문구, 출하 시드 4종 전부 영문)을 승격하지 않고, 그 권한이 여는 도구를 `연결된 도구: {name}` 형태로 **식별**한다 — 무엇을 허용하는지는 위의 권한 문장과 아래의 위험도·승인 칩이 한국어로 말한다. 배포자 산문은 증거 표면(앱 상세 > 도구와 권한)에 그대로 남는다. **남은 절반은 이 레인 밖이다**: 시드 매니페스트 자체의 한국어화는 `server/Fixtures/plugin-manifests/*.json` + 그것을 DB에 심는 마이그레이션(013/031) 재시드 + `MomoServerTests`의 문자열 단정이 함께 움직여야 하고, 마이그레이션 번호는 중앙 예약 대상이라 웹 레인이 만들면 다른 레인과 충돌한다. 엔진 레인 티켓으로 넘긴다.
- **#849 ⑩ 채움은 커밋의 것이다.** 한 표면에 제거가 둘인데 하나(`내 권한 회수`)는 조용한 아웃라인 오프너, 다른 하나(`설치 해제`)는 파괴 채움이었다. 둘 다 확인 다이얼로그를 여는 **오프너**이므로 `설치 해제`를 `outline`으로 내리고, 무게는 실제로 쓰는 버튼(각자의 확인 버튼)에 남긴다 — 내 정책만 바꾸는 회수는 액센트 채움, 워크스페이스 전원의 권한을 함께 거두는 설치 해제는 파괴 채움. `--danger`/`--danger-fill` 토큰과 `destructive` variant 정의는 한 글자도 건드리지 않았다(직전 배치 랜딩분 보존). 바뀐 것은 그 채움을 누가 입느냐다.
- 신규 토큰 `--spacing-action-sm`은 `references/tokens.md` §4에 "한 푸터, 한 폭" 규칙과 실측치까지 적었고, `break-keep` 하우스 룰(뿌리에만·상속·tailwind-merge 함정·코드/수치 제외)도 같은 절에 명문화했다.
- 검증(전부 로컬 실주행, docker 비의존): `npm run typecheck` · `npm run lint`(기존 경고 4건, 무증가) · `npm test` **923 passed**(기준 923, 무회귀) · `npm run build` · `scripts/design_preflight_web.sh` **10/10 PASS**. 폭·행잉 인덴트·word-break/overflow-wrap 공존·760x480 첫 권한 칩 위치는 빌드된 CSS를 Chromium(playwright)에 물려 직접 실측했다(수치는 위 항목에 인용). 첫 권한 칩은 스크롤박스 상단에서 191px에 앉아 그대로 폴드 위다 — ⑨가 도구 줄을 N줄에서 1줄로 줄여 오히려 여유가 늘었고, M-5는 이 스택의 어떤 줄도 접지 않는다(전부 이미 한 줄). **`npm run gate:shell`과 design-review는 오케스트레이터 몫**이다 — 기존 단정 중 이 변경이 닿는 것은 `checkboxLabelCursor`(이제 `wait`, 단정은 `!== "pointer"`라 그대로 통과)·`policyCauseCount 1`(단일 원인 경로는 한 문단이라 그대로 1회)·설치 신호 가시성(다이얼로그 칩 문자열 무변경)이다. 손대지 않은 것: 서버·데몬·마이그레이션, 토큰 위험 위계, #839 5R 원칙(조건부 마운트·opener·Escape 소유·pending 가드·aria-busy 풀 컨트라스트·8KiB 바이트 카운터).

## MOMO-674 attach 후속 3종 — 상설 실왕복 검증기·스트림 중 재검증·mac 마커 필터 (#908, 2026-07-29)

- **① 실왕복 검증기를 정식화했다.** #906 검수 하니스를 `scripts/verify_workd_attach.sh`로 승격하되 **복제가 아니라 `verify_workd.sh` 확장**이다(`WORKD_GATE_ATTACH=1`, `verify_acp_host.sh`가 이미 쓰는 모양). attach 단정에 필요한 픽스처 — 격리 스택·실제 Ed25519 신원·서명 폴링·승인된 spawn·**이미 출력을 낸 실제 로그인 셸 PTY** — 가 정확히 그 파일이고, 사본은 계속 참으로 유지해야 할 두 번째 대상이 된다. 브라우저 경로(자가서명 TLS 프록시 뒤 평문 리스너 + `Sec-WebSocket-Protocol: momo.terminal.v1, <token>`)를 고른 이유는 mac의 Authorization 헤더가 실 소켓 XCTest로 이미 덮여 있고 서브프로토콜 베어러는 여기 말고 어디서도 실행되지 않기 때문이다. 프록시는 TLS만 끊고 HTTP를 파싱하지 않으므로 "subprotocol을 그대로 중계"가 약속이 아니라 구조다.
  - 단정: 리스너 ready 1회 · `terminal_attach` 호스트 capability · 데몬이 PATCH로 올린 `pty_id`/`attach_endpoint` · 서버 발급 capability + 감사 행 · **직전 출력(binary) → `replay_end`(text) 정확히 1개 → `send_stdin` → 라이브 출력** · 열린 observer 스트림이 소유자의 관전 차단에 1008로 끊기고 observer capability 행이 사라짐 · attach 키스트로크/출력/원문 토큰의 서버 원장 부재. 실패는 전부 단계 이름(`replay_end`·`replay_end_exactly_once`·`live`·`revoked_close`)으로 난다.
  - 라이브 단정은 입력과 기대 출력을 셸이 제거하는 `''`로 갈라 두어 **터미널 에코만으로는 통과할 수 없다**(죽은 셸이 "라이브"로 읽히던 함정).
  - red proof 두 겹: 매 실행 `terminal_attach_probe.py --selftest`(마커 없음·overflow로 대체·라이브 중 두 번째 마커 3종이 각자 이름으로 실패, Docker 불필요) + 선택 `WORKD_ATTACH_PROVE_RED=replay-marker`(레포 **사본**에서 `PTYReplayEndFrame.type`을 바꿔 재빌드한 데몬으로 검증기가 반드시 실패해야 통과, 워크트리 무수정).
  - 포트 28430~28433 + `API_PORT+71`(wss)/`+72`(리스너), 충돌 grep 선행. `local_gate.sh` runtime-db·shell/python 문법 목록·auto-classification 등록 완료.
- **② 스트림 중 capability 재검증 — 작은 쪽을 구현했다.** 열린 소켓마다 데몬이 이미 하는 서명 `validate`를 주기적으로 한 번 더 하고(`stream: true`), 거절이면 1008 `capability revoked`로 끊는다. 서버는 그 플래그로 **만료 절만** 건너뛴다: 60초 TTL은 발급~다이얼 창을 좁히는 값이고 그 창은 호스트가 이미 전량 검증으로 닫았기 때문이다. 세션 상태·호스트 revoke·grantee 생존·observer의 채널 멤버십/`observation='open'`은 매 호출 그대로 걸린다 — 완화된 것은 "다이얼 창"이지 "누가 볼 수 있는가"가 아니며, 서버 계약 테스트가 그 문자열을 잠근다(다른 절에 `revalidating`이 붙으면 실패). 신규 라우트·스키마·마이그레이션 0개. 재검증은 pump/read와 나란한 세 번째 태스크라 **스트림을 끊지 않는다**.
  - 주기는 capability TTL과 별개인 스트림 수명 정책: `MOMO_WORKD_ATTACH_REVALIDATE_INTERVAL_MS`(기본 30000, 범위 1000~3600000). 이 값이 곧 **회수 지연 상한**이다.
  - 부수 수정: issue 경로의 만료 observer 행 GC가 즉시 삭제였는데, 이제 같은 행을 스트림 수명 동안 재검증하므로 팀원 한 명의 관전 시작이 다른 관전자를 한 주기 안에 끊었다. 보존창을 1시간으로 넓혔다 — 관전 권한 배지는 스스로 `expires_at > clock_timestamp()`를 세므로 **사용자에게 보이는 수는 그대로**다.
  - **기각: 서버발 revoke 신호.** 지연은 0에 가깝지만 데몬은 outbound 폴링만 하므로(ADR-0125 D2) ⓐ 새 인증 표면 + 스펙/샘플, ⓑ 그 채널의 재시도·중복 억제, ⓒ 신호를 놓친 데몬용 **결국 같은 주기 재검증** 폴백이 함께 온다. ⓒ가 필요한 이상 큰 쪽은 작은 쪽의 상위집합이고, 회수 지연 30초→0의 대가로는 표면이 과하다. 근거는 `docs/runbooks/workd-terminal-attach.md`.
- **③ mac 마커 필터.** 스트림 원소를 `MomoTerminalHostFrame`(output/replayEnd/replayOverflow)으로 바꿔 프레임 종류를 전송 계층에서 잃지 않게 했다. **binary는 정의상 PTY 출력이라 절대 분류하지 않는다** — 마커와 똑같은 바이트를 출력하는 프로그램이 있어도 화면에 가야 한다. text만 분류하고, 마커가 아닌 text와 `byte_offset` 없는 마커는 그대로 출력으로 흘린다(웹 `classifyHostFrame`과 동일). overflow는 기존 재동기화 계약(배너의 다시 연결)을 쓰되 `networkDisconnected`로 접지 않고 `outputOverflowed`를 새로 뒀다 — 네트워크는 멀쩡한데 "연결 상태를 확인하세요"는 유일하게 정상인 곳을 보게 만든다.
- **검증.** WorkHostDaemon 56 tests(3 skip, 기준 53에서 +3: 실 소켓·실 PTY로 성공 중 스트림 무중단 + revoke 1008 + grant 교체 거절, 주기 경계값) · MomoServer 357 tests · MomoMac 710 tests(+3) green. MomoMac의 기존 실패 3건(invite mail·터미널 팔레트 스냅샷 2)은 base에서도 동일하게 실패하며 이 변경과 무관하다. `bash -n`·shellcheck(`-S warning`) clean, `py_compile`, `--selftest` PASS, 프록시+프로브 TLS 왕복 로컬 실측. **`scripts/verify_workd_attach.sh` 실주행은 Docker가 필요해 `runtime-unverified`** — 오케스트레이터 실행 대기다.
  - 오케스트레이터 실행 목록: `scripts/verify_workd_attach.sh` · `WORKD_ATTACH_PROVE_RED=replay-marker scripts/verify_workd_attach.sh` · 무회귀로 `scripts/verify_workd.sh`(attach 미설정 경로 = 리스너 미개방).

## MOMO-673 OpenAPI 계약 게이트 미샘플 44건 백필 — 부채 목록 소거 (#904, 2026-07-29)

- `scripts/openapi_known_unsampled.txt`의 44건이 전부 **실샘플**로 대체돼 목록이 비었다. 스펙 128개 연산 전부가 샘플러를 갖는다(정적 대조로 확인). 파일은 지우지 않고 남긴다 — 게이트가 `--known-unsampled`로 계속 읽고, "빈 목록"이 곧 부채 0의 정본이며, 여기에 줄이 다시 생기면 리뷰에서 즉시 보이기 때문이다. 서버 코드 변경 0.
- **부채가 부채였던 이유는 게으름이 아니라 환경이었다.** 44건 대부분은 게이트 스택이 켜지 않던 세 조건에 걸려 있었다: ① provider chain·크레딧 topup의 MOMO-583 운영자 신원, ② T3(`MOMO_T3_ENABLED`), ③ Agent Card·event-subscription의 SSRF 검증기가 요구하는 **공인 형태 목적지**. 그래서 백필의 절반은 샘플이 아니라 compose override다.
  - 운영자 신원은 `PLATFORM_ADMIN_EMAILS`에 그 런의 일회용 게이트 이메일을 넣어 얻는다. 게이트 로그인은 `platformAdminSecret`을 보내지 않으므로 **토큰 스코프는 그대로 messages:read/write다** — 허용목록은 신원을 인가할 뿐 토큰 권한을 넓히지 않는다(`AuthRoutes.shouldGrantPlatformRead`).
  - T3는 `MOMO_T3_PROVIDER`를 **일부러 비워** BYOC 어댑터를 기본으로 둔다(ADR-0142 D1). 자격증명도, 호스트측 mock provider 프로세스도 필요 없고, BYOC가 인스턴스 수명을 소유하지 않는다는 사실 자체가 create/pause/resume의 문서화된 409를 만든다 — 거절이 곧 계약이다. register는 BYOC 등록 토큰으로 통과하고, destroy는 BYOC가 실제로 구현하는 유일한 수명주기 동사라 200이다.
  - 공인 형태 목적지는 compose override의 `mock-public-endpoint`(기본 11.38.0.0/24, `<prefix>.2:8089`)다. 프로덕션 SSRF 주소 검사는 그대로 살아 있고 HTTPS 요구만 완화한다(`MOMO_AGENT_CARD_ALLOW_HTTP`/`MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP`). 이 mock 하나가 Agent Card 2건과 event-subscription 4건을 함께 연다.
- **파괴적 연산은 순서로 풀었다.** 메모리 평면은 PATCH→invalidate→workspace purge 순이어야 하고(무효화된 항목은 편집 409, purge는 정책 자체를 끈다), `DELETE .../members/me`·`.../channels/{ch}/members/me`는 호출자 세션을 revoke하므로 게이트 토큰이 아니라 `/v1/join` 멤버 토큰으로 맨 뒤에서 돈다. cloud destroy는 pause/resume 409가 아무 상태도 바꾸지 않는다는 것(`beginLifecycleIntent`가 capability 검사에서 UPDATE 이전에 던진다)을 읽고 그 뒤에 배치했다.
- **SQL 지름길은 두 곳뿐이고 둘 다 "REST로 만들 수 없는 선행 상태"다.** resume은 `orphaned` 세션을 요구하는데 그 상태는 NotifierWorker sweep만 만들고 이 게이트는 그 프로필을 띄우지 않는다(`verify_workstream_continuity.sh`와 동일한 처방). context packet id는 어떤 REST 읽기에도 투영되지 않아 원장에서 꺼낸다. 두 경우 모두 **샘플 자체는 라이브 HTTP**다.
- 관측(드리프트 아님, 별건 후보): `/v1/provider/link/chain` 3종과 `/v1/provider/effort-table`은 `security:` 선언이 없고 응답 스키마가 `additionalProperties: true` 자리표시자라, 샘플이 생겨도 게이트가 이 네 연산의 본문 드리프트를 구조적으로 감지하지 못한다. 이번 PR은 스키마를 건드리지 않고 인가 경계만 `description`으로 적었다.
- 검증: `bash -n` green, shellcheck는 base 대비 **새 경고 0**(잔존 SC1007 2건은 무변경 라인), compose override YAML 렌더+파싱·내장 mock 파이썬 컴파일 green, `docs/api/openapi.yaml`은 description을 제거하면 base와 구조 동일(스키마 무변경). 게이트 완주는 Docker 스택이 필요해 **`runtime-unverified`** — 오케스트레이터가 `scripts/verify_openapi_contract.sh` PASS(및 `[openapi-shape] PASS operation coverage`에서 부채 주석이 사라진 것)를 확인해야 한다.

## MOMO-661① T3 interval 과금 마이크로초 정밀도 — floor는 정산에서 1회 (#879, 2026-07-29)

- **Σfloor(구간) → floor(Σ구간).** Migration 058이 `work_host_usage_interval.active_seconds`(045:66-72)를 `active_micros`로 재정의하고, `t3_terminate`가 마이크로초 합계를 **한 번만** 초로 절사한다. 실측: 1.9초 active × 12회 + pause 왕복 12회 세션에서 **058 이전 12초 / 058 이후 22초**(참값 22.8초) — 경계마다 버려지던 10초가 회복되고 잔여 절사는 세션당 0.8초 1회다. 이 12초는 시뮬레이션이 아니라 001~057만 적용한 DB에서 **실제 pre-058 `t3_terminate`를 호출해 측정**한 값이다.
- **pause 0 계상 보장은 그대로 GENERATED다.** 정밀도 변경은 `THEN` 가지 안에서만 일어났고 `state = 'active'` 가드와 `ELSE 0`, `STORED` 생성성은 그대로다 — 어떤 문장도 `active_micros`를 쓸 수 없다(PostgreSQL 428C9로 거절, 검증기가 단정). 4주짜리 열린 pause 구간을 정산이 닫아도 0을 청구한다.
- **밀리초가 아니라 마이크로초인 이유:** PostgreSQL timestamptz/interval의 해상도 자체가 마이크로초다. ms로 두면 경계마다 더 작은 2차 절사를 새로 만들 뿐이라, us에서는 generated 컬럼이 근사가 아니라 구간의 정확한 재진술이 되고 원장에 남는 반올림은 정산 1회뿐이다.
- **`work_host_usage.active_seconds`의 의미 변화(문서화 대상):** 이름·타입·과금 역할은 그대로(단가가 초당이므로)지만 값의 정의가 Σfloor(구간) → floor(Σ구간)으로 바뀌었다. 새 `active_micros` 결과 컬럼과 `work_host_usage_active_micros_ck`가 `active_seconds = active_micros / 1000000`을 **제약으로** 고정해 "절사 1회"가 관행이 아니라 스키마다. **058 이전에 정산된 행은 재계산하지 않는다** — `credit_entry`는 트리거로 append-only이고 과거 청구는 사실이다. 그 행들은 `active_micros IS NULL`로 식별된다.
- **경계의 seam도 닫았다.** interval을 닫는 문과 여는 문이 갈라져 있어 그 사이가 미청구(REST)이거나 `now()`(트랜잭션 시각) 때문에 겹쳐 이중청구(reconciler)될 수 있었다 — 초 단위 floor가 가리던 오차다. `CloudUsageLedger.transitionInterval`과 reconciler `confirm()`이 한 문장에서 닫고 열며 새 구간의 `started_at`을 직전 `ended_at`으로 못박고, 058이 컬럼 default를 `clock_timestamp()`로 바꿔 구조적으로 역전을 막는다.
- 049의 `one_unsettled` partial unique·052 advisory·053의 봉인 트리거/잠금 사다리/멱등/`settled_reason`·057 deadline은 손대지 않았다(058은 `t3_terminate`의 산술만 교체한 `CREATE OR REPLACE`).
- **검증.** server 358 tests(기준 357 + 058 구조 단정 1)·NotifierWorker 7 tests·server/NotifierWorker `swift build`·`check_migration_numbers.sh` 58 files green. 신규 `scripts/verify_t3_interval_precision.sh` **실주행 green**(격리 PG18에 001~057 적용 → pre-058 손실 실측 → 러너로 058 적용 + 멱등 마커 → 기존 settled 행 불변 단정 → 동일 픽스처 재정산 → 10초 회복·잔여 800000us·차감 550 단정), red proof `T3_PRECISION_PROVE_RED=interval-floor` **실주행 red**(exit 1, `interval-floor truncation loss: ... billed 12s where the microsecond ledger owes 22s`). Docker 스택이 필요한 `scripts/verify_t3_provisioner.sh`(active_micros·seam 단정으로 갱신)와 나머지 T3 검증기 무회귀는 `runtime-unverified` — 오케스트레이터 실행 대기.

## MOMO-642 R1 리뷰 반영 — 막힌 결정의 가독 + 채움 위계 (#849 #848, 2026-07-30)

- **H-1: 0선택에서 "왜 못 하는가"를 말하는 유일한 문장이 흐렸다.** 후속 ⑥이 3중 announce를 하나로 줄인 판단은 옳았지만, 살아남은 하나가 셋 중 가장 안 읽히는 것이었다: `opacity-50`이 채움과 라벨을 함께 50%로 합성해 요구 문장이 **라이트 2.20:1 / 다크 3.21:1**까지 내려갔다(이 PR 이전 같은 요구가 서 있던 `text-ink-muted` 본문은 5.7:1). WCAG는 비활성 컨트롤을 면제하므로 테스트 실패는 아니지만, 이 클라이언트가 스스로 지키는 기준 아래로 내려간 유일한 문장이 하필 그것인 건 설계 결함이다. **흐리게 하는 대신 강조를 거둔다**: 결정이 불가능한 동안 버튼은 주 액션의 채움을 잃고 조용한 액센트 표면(`bg-accent-soft` + `text-ink`)에 앉는다. 실측 **라이트 13.17:1 / 다크 12.45:1**(브라우저에서 `rgb(36 33 28)` on `rgb(244 231 214)` / `rgb(236 236 241)` on `rgb(51 38 26)`로 재확인). announce는 늘리지 않았다 — 요구는 여전히 라벨에만, 카운트는 하나뿐인 live region에만 있다.
- **H-2: 채도를 순서의 자로 세워놓고 채움 버튼을 그 자 밖에 뒀다.** `--danger`가 그대로 `bg-danger`로 칠해져, 설정 > 앱 상세 행에서 `설치 해제`가 주 버튼 `내 사용 허용`보다 채도가 높았다 — **이 팔레트 자신의 자로 재면 파괴 보조가 주 액션을 이겼다**(라이트 0.178 vs 0.136 = 1.31x, 다크 0.166 vs 0.134 = 1.24x. 리뷰는 다크만 실측했으나 **라이트가 더 심했다**). MOMO-641이 고친 역전과 같은 종류가 방향만 바뀐 것이다. 해결은 토큰 분리(`--danger-fill` / `--on-danger-fill`)이고, 그건 취향이 아니라 산술의 결과다: 다크에서 전경 톤은 `--warn`(C 0.141)을 1.15배 이겨야 하니 C >= 0.162, 주 액션 `--accent`(C 0.134)를 이기지 않으려면 C <= 0.116 — **교집합이 공집합**이라 하나의 빨강으로 두 순서를 동시에 만족시킬 수 없다.
- 새 값은 `light-dark(#8c393d, #dc817e)`. 같은 위험 계열을 유지한 채(hue 차 9 / 6도) 채도만 accent 아래로 내리고 명도를 낮췄고, 그 결과 두 채움은 **전보다 오히려 멀어졌다**(OKLab dE 라이트 0.073 -> 0.092, 다크 0.122 -> 0.131). 라벨 AA는 7.52 / 6.42. 파급은 `destructive` variant 한 줄이므로 파괴 채움 7곳(앱 상세 행·앱 설치 해제 확인·에이전트 메모리 무효화·작업 세션 종료 확정·관전 닫기·설정 2단 확인·승인 카드 거부 확정)이 함께 따라간다.
- **자동 단정 4종**을 `tokens.contrast.test.ts`에 추가했다(두 스킴 x 3 it = 6 테스트): `accent / danger-fill` 채도비 >= 1.15 · 두 채움의 dE >= 0.08 · `danger-fill`이 `--danger` 계열 안(hue 차 <= 15도) · `danger-fill` 채도 >= `--ink-muted`의 2배. red proof ①: `--danger-fill`을 `--danger` 값으로 되돌리면 `accent vs danger-fill chroma (light): expected 0.76 to be >= 1.15`(다크 0.8)와 `danger-fill vs accent deltaE (light): expected 0.073 to be >= 0.08`로 실패. red proof ②: 중립 회색으로 두면 `danger-fill vs danger hue gap (light): expected 44 to be <= 15`(다크 89)로 실패.
- H-1도 게이트로 잠갔다. `gate:shell`의 0선택 단정은 라벨 텍스트만 보던 것이라 문장이 2.20:1로 내려가도 통과했다 — 이제 `opacity`·`dimmed`·계산된 전경/배경 쌍의 WCAG 대비(>= 4.5)를 함께 잰다. red proof: `opacity-50`을 되돌리면 세 창 크기 x 두 스킴 전부 `{"opacity":"0.5","dimmed":true}`로 FAIL. 이 단정을 쓰면서 `transition-colors`가 `getComputedStyle`에 **보간된 중간 프레임**을 돌려준다는 것도 실측해(해제 직후 `rgb(240 168 80)` = `--accent`) 측정 전 전이 종료를 기다리게 했다.
- `references/tokens.md` §3a를 **표 A(전경 톤: 위험끼리 겨루는 자리) / 표 B(액션 채움: 주 액션과 겨루는 자리)** 두 개로 나누고, 어떤 자로 어떤 표면을 재는지와 표면 전수를 파일 경로까지 적었다. 막대가 표 A인 이유(막대는 다른 막대와 겨루지 주 버튼과 겨루지 않는다)도 함께.
- 검증: `npm run typecheck` · `npm run lint`(기존 경고 4건, 무증가) · `npm test` **923 passed**(기준 917 + 채움 단정 6) · `npm run build` · `scripts/design_preflight_web.sh` **10/10 PASS** · `npm run gate:shell` **GATE PASS**(다크·라이트 양 스킴 각각 3개 창 크기 전 단정). 라이트·다크 스크린샷으로 앱 상세 행과 0선택 다이얼로그를 눈으로도 확인. 손대지 않은 것: M-1~M-5(후속 티켓), 서버·데몬·다른 트랙 파일.

## MOMO-642 동의 모달 후속 7종 + MOMO-641 다크 danger 위계 (#849 #848, 2026-07-29)

- **다크 `--danger` 역전은 대비 문제가 아니었다(#848).** 옛 `#f2b8b5`는 `--warn`보다 대비가 **높은데도**(10.55 vs 8.03 on `--surface`) 조용하게 읽혔다 — 둘 다 AA를 한참 넘겨 가독성으로는 구분되지 않고, 남는 차이가 채도였다(OKLab C 0.068 vs 0.141, 역전). 라이트는 처음부터 채도 순서가 맞아서(0.178 > 0.108 > 0.011) 위계도 맞았다. 그래서 **순서의 자를 채도로 고정**하고 `#ff796b`(C 0.166, hue 28 — 라이트 danger의 29와 같은 계열)로 바꿨다. sRGB에서 빨강은 노랑만큼 밝아질 수 없으므로 "채도도 높고 대비도 warn보다 높은 다크 danger"는 존재하지 않는다: 대비는 순서의 자가 아니라 **바닥선**으로 남긴다(모든 표면 AA + 모든 표면에서 `--ink-muted`보다 높음, 최악 5.72:1 on `--accent-soft`). 라이트 토큰은 한 글자도 건드리지 않았다.
- 세 조건 전부 `tokens.contrast.test.ts`가 두 스킴에서 잰다(채도비 >= 1.15x / >= 2x, danger > muted 대비, 기존 AA 표). red proof: 다크 danger를 `#f2b8b5`로 되돌리면 `danger vs warn chroma (dark): expected 0.48 to be >= 1.15`로 실패한다. 위계 순서와 그 근거는 `references/tokens.md` §3a에 명문화했고, 두 톤을 함께 쓰는 표면 전수(앱 동의 다이얼로그·`ToolRow` 칩·설정 > 사용량 칩과 `<progress>` 막대·AI 연결 체인·워크스페이스 레일 연결 점)를 같은 곳에 적었다.
- **#849 후속 1~7.** ① 악수 글리프는 설명 문장 옆으로 옮겨 그 문장을 캡션으로 갖고, 방향이 반대인 **회수 다이얼로그에서는 그리지 않는다**. ② 다이얼로그 결정 버튼에 `min-w-action`(144px, 신규 이름)을 줘 라벨이 바뀌어도 푸터가 움직이지 않는다 — 실측 `취소` left가 세 선택 상태(전체/0개/1개)에서 420px로 동일, 이전에는 24px 이동했다. 같은 이유가 성립하는 `설치 해제` 확인 다이얼로그에도 함께 적용했다. ③ 진행 중 체크박스는 `cursor-not-allowed`로 포인터에도 사실대로 말한다(체크 표시 자체는 흐리지 않는다 — 지금 전송 중인 선택이 무엇인지가 그 상태다). ④ `InlineBanner`의 `whitespace-pre-line`을 `lines` caller opt-in으로 되돌렸다(실측상 `\n`을 담는 배너 메시지는 여전히 그 하나뿐). ⑤ 다중 원인 실패 배너를 **원인 기준 그룹핑**으로 바꿔 원인 문장이 scope 수만큼 반복되지 않는다 — 760x480 4-scope/2-원인 실측 **171px vs 스크롤박스 272px**(이전 281 vs 272, 13px 넘침). ⑥ 0개 선택 3중 announce를 하나로 정리했다: 중복 힌트 `<p>`와 `aria-describedby`를 지우고, 요구는 막힌 액션의 라벨에, 카운트는 하나뿐인 live region에 남겼다. ⑦ 폴드 위 유일한 색이던 `워크스페이스 설치됨` 칩을 중립 톤으로 내렸다 — 이 화면에서 색은 위험 신호의 것이다.
- 범위 밖으로 남긴 것: #849 8~10(회수 다이얼로그의 배포자/라이선스, 매니페스트 영문 description, 파괴 버튼 톤)과 카탈로그 목록 행의 `설치됨` ok 칩(위험 칩과 경쟁하지 않는 다른 표면).
- 검증(전부 로컬 실주행, docker 비의존): `npm run typecheck` · `npm run lint`(기존 경고 4건 외 무증가) · `npm test` **917 passed**(기준 912 + 대비 4 + 모델 1) · `npm run build` · `scripts/design_preflight_web.sh` **10/10 PASS** · `npm run gate:shell` **GATE PASS**(1280x800·900x600·760x480 전 단정, `momoMarkFits`·설치 신호 가시성·`policyCauseCount 1`·첫 권한 칩 가시성·포커스 링 4px 포함, `checkboxLabelCursor`는 `not-allowed`로 관측). 라이트·다크 양 스킴 스크린샷 확인. **design-review는 오케스트레이터 몫**(토큰 변경이므로 필수).

## MOMO-655 데몬 public WSS attach 어댑터 + create ptyId/attachEndpoint 배선 (#869, 2026-07-29)

- #857이 남긴 seam(셸 래핑·256KiB 링·`PTYReplayBuffer.connect()`의 retained→`replayEnd`→live 순서)에 **inbound 리스너**를 붙였다. `momo-workd`는 `MOMO_WORKD_ATTACH_PUBLIC_URL`이 설정된 경우에만 RFC 6455 서버를 열고, 미설정이면 소켓 자체를 열지 않는다(기존 동작 무변경). 서버·웹·mac 계약은 전부 기존 것을 그대로 소비했다 — 새 인증 문법·새 프레임 어휘·서버 raw-byte 경유는 없다(ADR-0125 D10).
- **capability 판정은 데몬이 하지 않는다.** 업그레이드 요청의 bearer(mac=`Authorization: Bearer`, 브라우저=서브프로토콜 `momo.terminal.v1, <token>`)를 문법만 검사한 뒤 호스트 서명으로 `POST .../work-hosts/{host}/terminal-attach/validate`를 호출하고, 만료·세션 종료·호스트 revoke·채널 멤버십·controller/observer 등급을 그 한 번의 서버 답에서 받는다. observer의 `send_stdin`은 UI가 아니라 이 층에서 1008로 끊긴다.
- replay 마커가 wire를 그대로 탄다: PTY 바이트는 **binary** 프레임, `replay_end`/`replay_overflow`는 `PTYReplayEndFrame`/`PTYReplayOverflowFrame`이 고정한 JSON **text** 프레임이다. 웹 `ObserverTerminal`은 text 프레임을 xterm에 쓰지 않고 마커로 소비한다(이전 코드였다면 화면에 JSON이 그대로 찍혔을 경로다).
- create 응답 배선은 **PATCH 한 갈래**로 통일했다(신규 라우트 0개). 서버가 세션 id를 발급하므로 `pty_id = session id`인 호스트는 create 시점에 바인딩을 알 수 없고, tier fallback resume은 애초에 create를 호출하지 않아 재개 세션은 영구히 attach 불가였다. `PATCH /work-sessions/{id}`에 work-host 서명 전용 `ptyId`/`attachEndpoint` 분기를 두어 두 경로를 함께 닫았다 — running/idle에서만, 자기 host 세션에만, 빈 바인딩에만 쓰고 동일 쌍 재전송은 멱등, 다른 쌍은 409.
- TLS는 데몬이 하지 않는다(self-host 현실). 리스너는 평문 TCP이고 기본 바인드는 `127.0.0.1`이라, 프록시 미구성은 "LAN 평문 노출"이 아니라 "닿지 않음"으로 실패한다. 리버스 프록시 구성·재등록 절차(capability 갱신 REST가 없어 `terminal_attach` 플래그는 재등록 필요)·알려진 한계(capability는 접속 시 1회 검증, `resize`/`kill` 무시, IPv4 바인드)는 `docs/runbooks/workd-terminal-attach.md`.
- WorkHostDaemon 53 tests(3 skip, 기준 38에서 +15) green. 그중 하나는 실제 루프백 소켓·실제 PTY·실제 핸드셰이크로 **직전 출력(binary) → `replay_end`(text) → controller stdin → 라이브 출력**을 왕복 단정한다. server 357 tests(+1: 빈 host `wss:///path` 거절 — Foundation이 nil이 아닌 빈 문자열을 돌려줘 기존 `host != nil`만으로는 통과했다)·server/daemon `swift build`·웹 typecheck+vitest green. 데몬↔서버↔브라우저 xterm 실왕복은 Docker 스택이 필요해 `runtime-unverified` — PR 본문의 절차대로 오케스트레이터가 확인해야 한다.

## MOMO-668 T3 T-4 수렴 — deadline 필수화·국면별 수렴 규칙·낡은 응답 폐기 (#892, 2026-07-29)

- **deadline을 구조로 만들었다.** Migration 057이 `lifecycle_operation_deadline_at`을 추가하고, BEFORE 트리거가 누락 시 kind별 정본 상한(pause/resume 120s·destroy 300s)을 채우며 CHECK가 `*ing` + deadline NULL 조합을 아예 표현 불가로 만든다. 즉 "미래의 어떤 경로가 deadline을 빼먹으면?"이라는 질문이 성립하지 않는다 — 2차 리뷰의 영구 교착은 규약이 아니라 스키마로 닫혔다. 기존 `*ing` 행은 자기가 이미 기록한 `started_at` 기준으로 소급되어(지금 기준이 아니라) 오래 멈춰 있던 행은 즉시 만기다. **052/053은 손대지 않았다** — `t3_terminate`가 deadline 없이 `destroy_pending`을 써도 트리거가 채우므로 봉인된 정산 단일 문을 다시 열 필요가 없었다.
- **수렴 규칙표를 코드 한 곳으로 옮겼다.** `CloudProviderKit/CloudLifecycleConvergence.swift`가 ADR-0140 D4 표 그대로를 소유하고 reconciler·REST가 각자 판단하지 않는다. 실패한 pause는 `running`으로 돌아가고 **정산은 아무것도 하지 않아서** 계속된다(active interval을 애초에 닫지 않으므로 보정 연산이 없다). 실패한 resume은 `paused`로 돌아가며 interval을 열지 않는다. destroy는 유일하게 포기하지 않고 `t3_lifecycle_backoff`(2배씩·300s 상한)로 재시도한다. deadline 초과는 타이머가 아니라 **probe 답이 판정**하고, `unknown`은 절대 `absent`로 승격되지 않는다.
- **표에서 한 칸 넓혔고 그 근거를 남긴다(계획 이탈 후보).** ADR 표는 `pausing` 실패를 무조건 `running` 복귀로 적지만, provider가 인스턴스 **부재**를 답한 경우까지 `running`으로 두면 존재하지 않는 샌드박스에 계속 과금하게 된다 — 그 행이 존재하는 이유("사실에 맞는 쪽")를 뒤집는다. 따라서 `pausing` + `instanceMissing`도 `t3_terminate('provider_missing')`으로 수렴시킨다. 규칙 자체가 아니라 규칙의 근거를 따른 확장이다.
- **낡은 응답 폐기를 DB 술어로 강제한다.** `t3_lifecycle_intent_is_current(host, operation_id, version, expected_state)`가 행을 잠그고 `(operation_id, version, state)` 일치를 판정하며, MomoServer·NotifierWorker는 이 함수를 부르기만 한다(T3LifecycleLock의 이중 사본 전례를 반복하지 않는다). 재검증이 잠금을 쥔 채 참을 답했으므로 이후 확정 UPDATE는 id로만 건다. 불일치는 예외가 아니라 폐기다 — reconciler는 `discarded stale provider response`로 로그만 남기고, REST는 409로 답한다. 새 claim 함수 `t3_claim_lifecycle_operation`이 advisory 잠금·version bump·attempt 카운트·backoff 예약을 한 문장에 묶어, 재청구 자체가 이전 응답을 낡은 것으로 표시한다.
- **호스트 pause의 idempotency key를 durable operation으로 고쳤다.** `WorkSessionRoutes`가 `cloudHostID`를 키로 쓰고 있어 서로 다른 두 pause 의도가 provider 쪽에서 같은 연산으로 접혔다(ADR-0140 D4 ② 위반). 이제 `lifecycle_operation_id`다.
- **검증.** server 357·NotifierWorker 7·CloudProviderKit 17 tests green(수렴표는 셀 단위 유닛 테스트로 ADR 문구와 대조). `check_migration_numbers.sh` 57 files green. 격리 PG18에 001~057 전량 적용 후 deadline 자동 충전·NULL 불가·claim의 version bump/backoff·guard의 stale version/other operation 거부·신규 전이 2종 합법을 SQL로 직접 단정했다. `verify_t3_lifecycle_concurrency.sh`·`verify_t3_migration_repair.sh`는 실주행 green. 신규 `scripts/verify_t3_convergence.sh`(수렴 국면 5종 + deadline→probe→수렴 실주행 + red proof)와 기존 T3/T1·T2 검증기 실주행은 **`runtime-unverified`** — 오케스트레이터 실행 대기다.
  - 오케스트레이터 실행 목록: `scripts/verify_t3_convergence.sh` · `T3_CONVERGENCE_PROVE_RED=stale-response scripts/verify_t3_convergence.sh` · `scripts/verify_t3_provider_continuity.sh`(+ dishonest-probe red) · `scripts/verify_t3_provisioner.sh` · `scripts/verify_tier_fallback.sh` · `scripts/verify_work_session_idle.sh`.

## MOMO-672 verify_workd spawn ack 회귀 — 원인 커밋 확정 + 검증기 수리 (#903, 2026-07-29)

- 원인은 서버·데몬 회귀가 아니라 **검증기가 낡은 종단 상태를 기다린 것**이다. `68d6ca91` "feat(workd): 로그인 셸 도구 idle 수명주기 연결 (#857)"이 `pty` transport를 "도구를 직접 실행하고 종료하면 세션 ended"에서 "영속 로그인 셸이 도구를 함수로 감싸고, 도구가 끝나면 OSC 마커로 **idle** 보고"로 바꿨다. `verify_workd.sh`는 여전히 `work_control acked` + `work_session ended`를 함께 기다렸으므로 데몬이 더 이상 하지 않는 전이에서 240초 타임아웃했다. bisect 대신 실런 증거로 확정: base 실패 시점 원장은 `work_control=acked` · `work_session=idle` · `exit_code=0`(즉 spawn·dispatch·ack·로컬 출력은 전부 정상).
- 수리(검증기 픽스처): 종단 대기를 `acked:idle` 또는 `acked:ended`로 넓히고, idle로 정착한 경우 ① `work.session.idle` outbox 1건(호스트가 보고한 running→idle 사실)을 단정한 뒤 ② 소유자 `PATCH /work-sessions/{id}` `{"status":"ended"}`로 idle→ended 구간을 명시 주행한다. `kill` control은 running 세션만 허용하므로(#526 계보 가드) 소유자 PATCH가 notifier 없이 idle을 빠져나가는 유일한 경로다. exit code는 서버 `COALESCE`로 보존되어 기존 `1:1:1:1` 원장 단정(acked / ended+exit_code 0 / work.session.started / work.session.ended)이 그대로 유지된다. ACP 모드(`WORKD_GATE_ACP=1`)는 자연 종료가 여전히 `ended`라 이 분기를 타지 않는다.
- red proof: 종단 대기를 `*:acked:ended:*` 단독으로 되돌리면 base와 동일하게 `[workd] spawn ack/session end timeout`으로 실패한다(이번 조사에서 실측한 base 실패가 그 증거 자체다).
- `scripts/verify_workd.sh`는 **이미 `local_gate.sh` 런타임 목록(라인 685)에 포함**돼 있다 — 빠져나간 곳은 핸드오프 패킷들이 관행적으로 나열하던 무회귀 세트(`verify_work_session_idle`·`verify_work_session`·`verify_work_host`)였다. 검수 절차 문서는 이 PR에서 건드리지 않았고, 대신 local_gate coverage note를 실제 계약(running→idle→ended)으로 갱신했다.
- 검증: `scripts/verify_workd.sh` 실측 green(docker 직접 실행, compose 프로젝트 `momo488workd` 전용 사용 후 `down -v`) · WorkHostDaemon·MomoServer swift 테스트 무회귀.

## MOMO-654 OpenAPI 계약 게이트 remote-create 409 해소 + 완주 구조 (#865, 2026-07-29)

- `work-session-remote-create` 409(`spawn control is not dispatchable by this host`)는 서버 회귀가 아니라 게이트 픽스처 결함이다. `requireDispatchedSpawnControl`은 `wc.payload->>'tool'`과 `wc.payload->>'label'` 동시 일치를 요구하는데(#526에서 도입), #545가 이 샘플을 host 서명 생성으로 바꾸면서 세션 label만 `OpenAPI remote PTY`로 두고 control payload는 `OpenAPI control`로 남겨 두 리터럴이 갈라졌다. 즉 #545 이후 이 샘플은 통과한 적이 없으며 base에서도 동일하게 재현된다(JOURNAL 2026-07-27 기록과 일치).
- 수리는 SQL 지름길 없이 실제 REST 경로만 쓴다. 세션 생성 body의 tool/label을 `work-control-create` 201 응답이 돌려준 `.workControl.payload`에서 유도해 리터럴 중복을 제거했고, 생성 결과를 label·hostId·status로 단정하는 guard를 추가했다.
- 샘플 하나가 나머지 전체를 막던 fail-fast 구조를 실패 누적형으로 바꿨다. 상태/shape 단정 실패는 기록 후 계속 진행하고(잘못된 body는 manifest에 넣지 않아 역방향 커버리지에서 미샘플로 드러난다), 후속 요청이 의존하는 id 추출 실패만 즉시 중단하되 EXIT trap이 그때까지 누적된 실패를 항상 출력한다. `OPENAPI_GATE_FAIL_FAST=1`로 기존 동작을, `OPENAPI_GATE_MAX_FAILURES`(기본 30)로 연쇄 잡음 상한을 제어한다. 최종 shape/커버리지 검사는 단정 실패가 있어도 실행된다.
- 서버 코드 변경 없음(`swift build` green). 스크립트는 `bash -n`·shellcheck에서 base 대비 새 경고 분류 없음(추가된 SC2016 1건은 jq `--arg` 관용구). 게이트 자체는 Docker 스택이 필요하므로 `runtime-unverified` — 오케스트레이터가 `scripts/verify_openapi_contract.sh` 완주 PASS를 확인해야 한다.

## MOMO-656/661 데몬 재시작 reconciliation + replay 구독자 큐 상한 (#870 #879, 2026-07-29)

- 데몬은 기동 시 `GET .../work-hosts/{host}/live-sessions`로 원장이 아직 자기 것으로 보는 running/idle 세션을 읽고, 자기 프로세스 표에 없는 것(재시작 직후에는 전부)을 서명 REST `POST .../reconcile`로 명시 보고한다. 부팅 스냅샷은 1회만 뜨고 실패 시 그대로 재시도해, 재개가 같은 호스트로 내려온 새 세션을 자기 보고가 다시 잡는 일이 없다.
- 서버는 전이를 하지 않는다. Migration 054의 `work_session.host_lost_at`은 sweep 적격화 표식일 뿐이며 orphaned 상태·재개 카드·계보·tier policy 분기는 기존 ADR-0125 D11 sweep이 그대로 소유한다. `end_reason`은 늘리지 않았다 — 사용자에게는 같은 사실이고 그 값은 클라이언트가 렌더하는 어휘라서, 출처 구분은 `audit_log`(`momo.work_session.host_lost.v1` + orphan 감사의 `orphan_source`)에만 남겼다. host가 보고한 세션은 idle timeout 분기에서 제외해 host loss가 항상 먼저 처리된다.
- PTY replay 구독자 큐에 구성 가능한 바이트 상한을 두고(`MOMO_WORKD_PTY_SUBSCRIBER_QUEUE_BYTES`, 기본 ring×4·ring 미만 불가), 초과 구독자는 프레임을 조용히 버리는 대신 `.overflow(byteOffset:)` 종단 프레임으로 절단한다. PTY는 연속 바이트라 드롭이 xterm에 무증상 깨짐으로 나타나고, 절단은 재연결→ring replay→새 `replay_end`라는 기존 계약을 그대로 재사용하기 때문이다. 큐 계정은 `AsyncStream(unfolding:)`으로 소비 시점에만 감소해 정확하다.
- WorkHostDaemon 38 tests(3 skip, 기준 32에서 +6: 재시작 보고·서비스중 세션 제외·전송 실패 재시도, 정지 구독자 red proof·정상 소비자·overflow 프레임 형태), server `testWorkHostRestartReconciliationReusesTheOrphanSweepWithoutNewUX`, server·NotifierWorker 빌드 무회귀는 green이다. `scripts/verify_workd_reconcile.sh`(실제 SIGKILL 재기동 → 보고 → orphaned + resume_offer, grace 1시간으로 heartbeat 경로 배제, SQL 지름길 없음)는 오케스트레이터 실행 대기(`runtime-unverified`)다.

## MOMO-671 workstream 계층 — 암시 생성·계보 연결·재개 자격 확장 (#898, 2026-07-29)

- Migration 055가 스레드 root message에 앵커되는 `workstream`(목표 문장·`active|paused|done|cancelled`·workspace/channel FK)과 `work_session.workstream_id` 복합 FK(`(workspace_id, id)` 참조)를 추가하고, 기존 세션을 스레드 기준으로 소급 생성·연결한 뒤 `SET NOT NULL`로 미연결 Run을 이름 있는 실패로 막는다.
- 암시 생성은 REST 핸들러가 아니라 `BEFORE INSERT` 트리거가 소유한다 — human create·human resume·NotifierWorker 자동 resume·픽스처까지 모든 insert 경로가 같은 스레드의 workstream에 붙으므로 미부착 Run을 만들 수 있는 코드 경로가 없다. 동시 첫 Run은 `ON CONFLICT (root_message_id) DO UPDATE`로 승자 row를 채택한다.
- 계보 재개 자격을 '소유자 본인'에서 **앵커 채널 활성 멤버**로 확장했다(ADR-0143 D2/D3). `work_session.member_id`는 그 Run의 실행자로 남아 이전되지 않고, 새 Run은 `resumed_from_session_id` 계보와 같은 workstream을 함께 유지한다. 이 변경에 맞춰 `verify_tier_fallback.sh`의 거부 케이스를 채널 비멤버로 교체했다.
- 조회 REST 3종(`GET /workstreams`(status·channelId·sessionId·limit), `/workstreams/{id}`, `/workstreams/{id}/runs`)과 OpenAPI 스펙을 함께 넣었다. 노출 최소(#831): host-local·자격증명 표면 없음, 비멤버는 목록 0건과 상세/이력 404(존재 탐지 불가), 재개만 403.
- server 351 tests(기준 349 + workstream 2)·`check_migration_numbers.sh`(54 files)·OpenAPI 라우트 역커버리지 green. Docker 격리 검증기 `scripts/verify_workstream_continuity.sh`(암시 생성 → 비멤버 403/404 → 같은 채널 멤버 B 이어받기 → A·B 병기 이력 → 트리거·FORCE RLS 단정)와 스크립트 헤더에 적은 red proof(자격 술어를 옛 소유자 가드로 되돌리면 `[workstream] FAIL channel-member takeover: expected HTTP 201, got 403`), 기존 verifier 회귀는 오케스트레이터 실행 대기(`runtime-unverified`)다.

## MOMO-670 T3 provider 어댑터 + E2B 제거 + BYOC 등록 공식화 (#897, 2026-07-29)

- `services/CloudProviderKit`이 `create/pause/resume/destroy/probe` 어댑터 계약과 capability 선언을 소유하고 MomoServer·NotifierWorker가 같은 정의를 컴파일한다. 정책 코드는 provider 상수를 알지 못하고 `capabilities`만 읽으며, 미지원 연산은 흉내내지 않고 선언·거부한다. `probe`는 존재/부재/**불명** 3값이라 "물어보지 못했다"가 "사라졌다"로 승격되지 않는다.
- Migration 054가 `work_cloud_host.provider`의 단일 벤더 CHECK와 default를 걷어내고 어댑터 레지스트리 식별자로 바꾼다. reconciler·REST는 프로세스 기본값이 아니라 **행에 적힌 provider**로 어댑터를 해석하므로, 운영자가 기본 provider를 바꿔도 기존 호스트가 계속 조작 가능하다. 레지스트리에 없는 이름은 설정 로드에서 fail closed.
- BYOC를 REST로 공식화했다(`POST /v1/workspaces/:ws/work-hosts/byoc/enrollments`, 워크스페이스 공용만 — personal은 스키마가 아니라 REST에서 이름 있게 거절). 기존 1회 부트스트랩 토큰·자체 Ed25519 등록 흐름을 그대로 재사용하며, 토큰은 digest만 저장하므로 같은 ref 재요청은 409다. 셀프호스트 2단 가이드는 `docs/BYOC_CLOUD_HOST.md`.
- 검증 fixture를 mock provider 2종으로 일반화했다(`scripts/mock_provider.py`: mock-a=pause 지원/메모리 보존, mock-b=pause 거부/cold boot). mock은 정직성이 계약이다 — pause된 인스턴스는 실행이 필요한 호출을 409로 거절하고, 죽은 인스턴스는 probe에 `absent`를 답한다. 정책 코드·검증기·인프라·문서의 벤더 문자열 잔존은 0이며 `verify_t3_provisioner.sh`가 `provider-neutral-policy-code` 이름으로 이를 상시 감시한다(needle을 런타임 조립해 자기 텍스트에 매칭되지 않는다).
- 연속성 무상태 검증기 `scripts/verify_t3_provider_continuity.sh`를 추가했다: mock-a 사망 → 어댑터의 정직한 보고 → reconciler의 이름 있는 `provider_missing` 수렴 → **기존 resume REST 그대로** mock-b의 새 Run 재개 → `resumed_from_session_id` 계보·단일 정산 단정. red proof는 `T3_CONTINUITY_PROVE_RED=dishonest-probe` — probe가 죽음을 숨기면 oort가 자기모순 provider 위에서 정산하기를 거부하므로 수렴이 없고, 검증기는 유한 deadline에서 `provider-missing-convergence` 이름으로 빨개진다(행·타임아웃 아님).
- 서버 354·NotifierWorker 7·CloudProviderKit 9·WorkHostDaemon 32(3 skip) 테스트, `check_migration_numbers.sh`, 두 T3 검증기의 정적 절반, compose/OpenAPI YAML 파싱이 green이다. Docker 행동 검증(연속성 정상/red proof, 기존 T3 provisioner·동시성 gate, T1/T2 무회귀)은 오케스트레이터 실행 대기(`runtime-unverified`)다.

## MOMO-667 T3 수명주기 정본화 (#891, 2026-07-29)

- Migration 053이 정산을 이유 보존형 `t3_terminate` 한 문으로 모으고 직접 `settled_at` 변경과 비실재 cloud-host 전이를 이름 있는 트리거 예외로 봉인한다. 기존 `settle_t3_work_session`은 설치 DB·운영 도구 호환 shim만 유지하며 런타임·repair는 명시 reason 경유로 이행했다.
- 서버와 NotifierWorker의 공용 prelude가 advisory → work_pool/workspace_credit → cloud host 순서를 소유하고, 종료·provider missing·idle/orphan sweep·계보 resume가 usage → interval → session → host 사다리를 따른다. T1/T2는 cloud host가 없으므로 이 prelude 비용을 지지 않는다.
- 서버 349·NotifierWorker 6 테스트, migration 번호·T3 정적 gate·shellcheck는 green이다. 기존 2개와 workspace 축을 포함한 Docker 동시성 시나리오, 두 red proof, T1/T2 및 기존 T3 행동 검증기는 오케스트레이터 실행 대기(`runtime-unverified`)다.

## MOMO-666 T3 수명주기 교착 안전망 (#890, 2026-07-29)

- T3 수명주기 쓰기는 정규화한 cloud-host UUID와 `momo.t3` 네임스페이스의 2-int transaction advisory key를 첫 SQL로 획득한다. T1/T2와 고빈도 heartbeat는 이 직렬화 경계에 들어오지 않는다.
- stale-host·idle-timeout sweep은 후보 조회 뒤 세션마다 독립 transaction으로 재확인·처리해 한 세션 실패가 배치 전체를 되감지 않으며, 실패 로그는 session ID와 이름을 남긴다.
- 두 PostgreSQL 연결의 advisory 보유/대기를 `pg_locks`·`pg_stat_activity`로 단정하는 reconciler×REST 종료 및 reconciler×sweep 하니스를 추가했다. server 349·NotifierWorker 6 테스트와 기존 verifier 9종 셸 정적 계약은 green이며 Docker 정상/40P01 red proof 및 기존 행동 검증기 9종은 오케스트레이터 실행 대기(`runtime-unverified`)다.

## MOMO-665 migration 049 fail-closed 탈출구 (#886, 2026-07-29)

- Migration 049를 정산 primitive 전용으로 축소하고, 050 운영자 repair 함수와 051 이름 있는 fail-closed/unique 강제를 분리했다. 기존 049 적용 DB는 파일명 기반 `schema_migrations`로 049를 skip하며 051의 `IF NOT EXISTS` 인덱스를 안전하게 통과한다.
- `docs/runbooks/t3-unsettled-usage-repair.md`와 `scripts/verify_t3_migration_repair.sh`가 host/count 진단 → repair → 재적용/2-pass 멱등 → MomoServer health, repair 생략 red proof와 기존 049 DB를 한 흐름으로 증명한다. Docker 행동 gate는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## privileged refresh 차단 + T3 기본 비활성 (#884+#887, 2026-07-28)

- refresh는 현재 verified human email·allowlist·운영자 secret 설정을 다시 확인해 자격 상실 시 `platform:read`와 `platform:credits:write`만 제거하고 일반 messages scope는 유지한다. 기존 로그인 경로가 같은 멤버의 privileged session token을 일괄 revoke해 allowlist/secret 변경 뒤 재로그인을 rotation 경계로 쓴다.
- T3는 `MOMO_T3_ENABLED=1` 명시 옵트인 없이는 provisioning/register/조회/pause/resume/destroy/topup을 읽히는 503으로 닫고 NotifierWorker reconciler에 진입하지 않는다. T1/T2 계약은 이 설정을 읽지 않으며 기존 T3 verifier는 opt-in으로 유지한다.
- Migration 049의 중복 미정산 usage fail-closed는 비활성 여부와 무관한 과금 원장 무결성 경계라 완화하지 않았다. 중복 설치의 복구 도구는 #886 범위다. 서버 349·NotifierWorker 6·WorkHostDaemon 32 테스트(3 skip)와 T3 정적 gate는 green이고, Docker 검증기 9종은 오케스트레이터 실행 대기(`runtime-unverified`)다.

## T3 2차 수리 (#882, 2026-07-28)

- topup을 `platform:credits:write` human scope로 분리해 `platform:read` 전용 토큰의 유료 실행 권한 획득을 차단했다. 같은 provider-link 가드의 mutation 사용처는 전수 조사했으며 기존 운영자 GUI/ADR 계약과 결합된 provider link·chain 및 quota credential 발급은 후속 권한 재설계 대상으로 남겼다.
- lifecycle reconciler는 provider 호출 뒤 host row lock+operation/state 재검증을 선행하고 최종 CAS 1행을 단정한다. resume 404/410은 정산·slot 해제·host revoke·orphan 적격화를 한 transaction에 확정하며, stale provider 결과는 종속 상태를 바꾸지 않는다.
- concurrent create ref는 advisory transaction lock으로 직렬화하고 Migration 049는 기존 중복 미정산 usage의 lowercased host 목록을 읽히는 오류로 제시한다. server 347 tests와 정적 T3 fixture gate PASS; Docker 행동 gate 2회(terminal missing / reconciler race) 및 전체 8종 verifier는 오케스트레이터 실행 대기(`runtime-unverified`).

## T3 수명주기·정산 수리 (#876+#877+#878, 2026-07-28)

- Migration 049의 단일 terminal 정산 primitive가 interval 종료·generated active 합계·멱등 차감·cloud slot 해제·destroy intent를 한 transaction에 묶고, host당 미정산 usage 1건을 partial unique로 강제한다. paused cloud host는 정상 heartbeat 부재로 stale sweep에서 제외하되 idle timeout은 heartbeat 없이 정산한다.
- pause/resume/destroy는 provider 호출 전 durable intent+version CAS를 기록하고 NotifierWorker가 provider idempotency key로 미확정 lifecycle/provisioning을 수렴한다. resume는 human REST가 provider→session/cloud/interval을 완료하며 signed host report는 시작 조건이 아니다.
- instance-operator 전용 양수 topup REST와 workspace 0-balance 초기화, create idempotency ref·결정적 one-shot bootstrap token을 추가했다. server 346 tests, NotifierWorker 4 tests, WorkHostDaemon 32 tests와 정적 T3/OpenAPI/migration gate를 worker에서 확인하며 Docker mock 8종·실 E2B smoke는 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-657 WorkHost 서명 body 결속 + replay 차단 (#875, 2026-07-28)

- WorkHost 요청 서명을 v2로 즉시 절단해 raw body SHA-256와 UUID request ID를 결속하고, request ID는 FORCE RLS 원장에서 원자적으로 1회 소비·10분 보존하며 매 인증 시 만료분을 정리한다. workd·macOS app host·검증 스크립트를 함께 전환했다.
- server 344 tests, WorkHostDaemon 32 tests, macOS Work Console 33 focused tests와 shell 정적 검증 PASS. 격리 Docker verifier의 body 교체·request ID replay·정상 경로·digest 제거 red proof 및 요청된 7개 회귀는 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-653 에이전트별 전역 run 이력 REST (#861, 2026-07-28)

- `GET /v1/workspaces/:ws/agents/:agent/runs`를 추가해 active human workspace member가 자신이 현재 속한 채널의 해당 agent run만 `(created_at,id)` 최신순 cursor로 조회한다. 채널 목록과 공통 요약 선택을 공유하고 id/status/time/channel/최대 200자 trigger summary만 노출하며 input/output/error·gateway payload·전문 transcript는 배제한다.
- OpenAPI·역방향 route gate sample·엔진→UXUI handoff와 격리 verifier를 동반했다. verifier는 실제 REST 로그인 nonmember 403, cursor 경계/빈 페이지/삽입 안정성, target agent·채널·타 workspace/FORCE RLS 불가시, 채널/전역 같은 run 요약 동일성을 단정한다.
- server build·342 tests와 shell/OpenAPI 정적 검증 PASS. 격리 Docker verifier와 두 red proof(OpenAPI 경로 제거, target-agent predicate 되돌림)는 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-651 T3 idle pause + 활성시간 미계상 실배선 (#859, 2026-07-28)

- cloud host의 signed `running→idle` 전이만 E2B pause와 `active→paused` interval 경계를 호출하고, `idle→running`은 E2B resume 뒤 `paused→active`를 재개한다. 일반 workd/desktop 호스트는 cloud 설정·프로비저너·원장을 건드리지 않는다.
- E2B가 resume에 404/410을 답하면 paused 원장을 정산하고 cloud host를 `destroyed`·revoke한 뒤 기존 offline sweep이 `orphaned` 이벤트·감사·resume fallback을 수행한다. pause/resume provider 지연은 lifecycle audit의 `cloud_provisioner_latency_ms`로 조회 가능하다.
- 서버 build·339 tests와 T3 verifier 정적 검증 PASS. signed REST→mock E2B→원장→Notifier sweep Docker gate, idle hook 제거 red proof, 실 E2B pause/resume smoke는 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-649 daemon shell PTY + host-local replay core (#857, 2026-07-28)

- PTY 도구는 로그인 셸의 canonical profile-command wrapper로 실행되어 종료 뒤 같은 PTY·workdir을 보존하고 signed lifecycle PATCH로 `idle(exitCode)`을 보고한다. 일반 셸 명령은 상태 소음에서 제외하며 같은 canonical command 재실행만 `running` 복귀를 만든다.
- PTY별 기본 256KiB bounded host-local ring과 원자적 `replay bytes → replay_end(byte_offset) → live bytes` attach 계약을 추가했다. kill/end는 셸·ring·subscriber를 정리하고 observer input은 거부한다. WorkHostDaemon 32 tests PASS(외부 mock 부재 3 skip).
- 기존 repo에는 public WSS workd adapter와 create의 `ptyId/attachEndpoint` 배선이 없어 데몬↔서버↔웹 xterm 실왕복 및 빠른 동일-host daemon 재시작 orphan 정리는 `runtime-unverified`이며 후속 계약이 필요하다. 서버/relay에는 raw PTY byte 경로를 추가하지 않았다.

## MOMO-648 work_session idle 상태 + 수명주기 (#856, 2026-07-28)

- Migration 047로 `running ↔ idle`과 `idle_timeout` 종료를 열고 `exit_code`를 마지막 도구 실행 결과로 재정의했다. 호스트 서명 REST 전이는 `work.session.idle`/`work.session.resumed-to-running` outbox·감사를 같은 트랜잭션에 기록하며, idle 완료 메시지는 소유자에게 id-only `momo.work` 푸시로 전달한다.
- NotifierWorker sweep는 host 단절을 idle timeout보다 먼저 처리하고, 워크스페이스 `settings.work_session_idle_timeout_seconds` 한 키만 읽어 기본 24시간 뒤 `ended(idle_timeout)`로 전이한다. T3 pause/resume 호출은 #859용 훅 주석만 두었다.
- server build·339 tests와 NotifierWorker build·4 tests, shell/YAML/migration 정적 검증 PASS. 격리 Docker verifier·timeout sweep 제거 red proof는 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-647 T3 프로비저너 + 활성시간 크레딧 원장 (#855, 2026-07-28)

- `usage_ledger`의 토큰 요청 의미를 보존하고 T3 전용 `work_host_usage`/active·paused interval, `workspace_credit`/append-only `credit_entry`, E2B lifecycle binding을 migration 045로 신설했다. paused interval의 generated active seconds는 구조적으로 0이며 session 종료가 active 합계×시작 시 단가를 한 번만 차감한다.
- 유료 cloud 명시 opt-in + balance/slot gate 뒤 E2B create, cloud workd의 1회 token digest·자체 Ed25519 등록, pause/resume/destroy를 `work_host` 표면에 연결했다. `E2B_API_KEY` 부재는 T3만 읽기 쉬운 503으로 닫고 T1/T2는 무영향이다.
- 서버 337 tests·WorkHostDaemon 27 tests(환경 mock 부재 3 skip) PASS. 격리 PG18/mock-E2B verifier는 키/잔액/슬롯 거부·원장/차감·pause 미계상·RLS·destroy PASS, pause를 wall-time 과금으로 되돌린 red proof는 의도대로 exit 1. 실 E2B smoke는 운영자 키 주입으로 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-646 허들 녹음·전사 실측 하니스 (#854, 2026-07-28)

- small/medium/large-v3-turbo의 고정 모델 snapshot을 같은 한국어 코퍼스에 실행해 CER·처리시간·RTF를 내는 하니스와 더미 무음 mock 셀프테스트를 추가했다. 참가자 Track별 전사→타임스탬프 병합→화자 라벨만 수행하며 모델 판정은 비워뒀다.
- `transcription` compose profile에 pinned LiveKit Egress+dev Redis를 옵트인으로 추가했고, 전사 queue/track은 기존 attachment FK만 쓴다. 녹음 동의 원장·전원 동의 fail-closed REST·채널 시스템 고지·종료 시 queued job을 추가했다.
- server build/test와 정적·mock 검증은 worker에서 수행한다. Docker Egress 기동, 실오디오 3모델 실측, 동의 없는 녹음 409 red 증명은 오케스트레이터 전까지 `runtime-unverified`다.

## MOMO-652 웹 에이전트 허브 탭 v1 (#860, 2026-07-28)

- 웹 사이드바의 워크스페이스 전역 `에이전트` 표면에 roster 기반 목록, agentWorkingSignal 현재 작업, 프로필·지시문·모델·pause, 읽기 전용 capability/도구 제한, 메모리 list/search·invalidate·visibility grants, #861 cursor run 이력·기존 상세를 통합했다. 기존 빠른 라우팅 프로필 다이얼로그 진입점은 유지하고 같은 query/save 로직을 재사용한다.
- 메모리 policy·전체 삭제·외부 제공자 동의와 schedule 실행기는 범위 밖으로 유지했으며, 예약 데이터는 "실행기 미구현"으로 표시한다. typecheck·Vitest 909·production build·lint(기존 warning 4)·design preflight 10/10·design-review(Blocker 0, High 0) PASS; `gate:agent-hub`와 기존 Playwright 게이트는 오케스트레이터 실행 대기(`runtime-unverified`).
- 2R은 900px 아래 roster/detail 단일 컬럼, 비례형 상세 라벨 축과 shrink 불가 탭을 적용했다. 프로필 404는 공용 `missing` 판정으로 실패와 분리하고, sidebar/허브 작업 칩은 rail 연결 신뢰도를 공유하며 stale 만료는 오프라인에도 전진한다. 빈 alert·내부 run 문구·오프라인 지시문 대비·메모리 kind/무효 상태·cron 문구와 effort-table gate 목을 함께 고쳤다.
- 2R 검증: typecheck·Vitest 909·production build·lint(기존 warning 4)·design preflight 10/10 PASS. `gate:agent-hub`에는 760x480 `dd` 실폭, 긴 이름 탭 한 줄, profile 404 비실패, effort ready 단정을 추가했으며 Playwright 실행과 기존 red proof 3종은 오케스트레이터 대기(`runtime-unverified`).

## MOMO-650 웹 idle 표시 + 재부착 동선 (#858, 2026-07-28)

- 웹 Work 세션 모델·목록·상세·관전 attach에 `idle`을 살아 있는 중립 상태(`완료 · 대기 중`)로 추가하고, `exitCode`는 종료 판정이 아닌 `마지막 실행 결과`로 표시한다. `work.session.idle`·`work.session.resumed-to-running`은 전 필드 타입을 방어적으로 파싱한 뒤 REST 원장을 다시 읽으며, 목록 응답 전후 어느 순서로 도착해도 stale 응답을 폐기한다.
- online `running|idle`의 `이어서 보기`는 기존 상세→읽기 전용 관전 attach를 재사용한다. orphaned의 `새 호스트에서 재개`는 별도 호스트 선택기를 열고 기존 resume API로 git 계보만 이어가며, 선택 전에 이전 PTY·미커밋 변경이 옮겨지지 않음을 고지한다. `work_session_idle` 채널 메시지는 과거 이벤트 문법의 클릭 가능한 `대기 전환` 카드로 렌더해 현재 상태와 충돌하지 않는다.
- typecheck·Vitest 902·production build·lint(기존 warning 4)·design preflight 10/10 PASS. `gate:my-sessions` 번들은 성공했으나 worker의 Chromium Mach-port 권한 거부로 브라우저 단정·red proof와 기존 wire/shell/csp/huddle/resume 게이트는 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-644 내 세션 연속성 표면 (#851, 2026-07-28)

- 웹 작업 세션 패널에 기존 채널·전체 범위를 보존한 `내 세션` 관점을 추가했다. 본인 소유의 종료되지 않은 세션만 호스트 이름·online·도구·채널·시작 시각·원장 상태와 함께 표시하며, 터미널 상세와 `rootMessageId` 스레드로 바로 이동한다.
- `online:false + running`은 서버 상태를 orphaned로 추정하지 않고 `호스트 응답 없음`으로 표시하며 관전을 막는다. 호스트 응답이 늦는 동안 활성 행을 그리지 않고, 호스트 0건·세션 0건·로드 오류를 분리했다.
- 2R에서 범위 칩의 축소 우선순위를 고정하고 세 관점 모두 host projection을 기다리게 했다. 오프라인 세션도 상세에는 진입하되 터미널만 거부하며, 호스트 0건이어도 원장 세션 행과 중립 미지 폴백을 보존한다.
- typecheck·Vitest 897·production build·design preflight 10/10 PASS. `gate:my-sessions`와 red proof 2종은 오케스트레이터 실행 대기(`runtime-unverified`).

## MOMO-643 웹 허들 복원 (#850, 2026-07-28)

- 웹 채널 헤더에 허들 미구성(503)·활성 없음·Live 참가자·참가 중·오류/오프라인 상태와 시작·참가·마이크·나가기를 복원했다. `huddle_started`·`huddle_participants_changed`·`huddle_ended`는 방어적으로 파싱하며, 종료 tombstone이 늦은 active 응답의 Live 배지 부활을 막는다.
- `livekit-client`(Apache-2.0)는 참가 동작 뒤에만 lazy-load되고 join 응답의 `livekitUrl`만 사용한다. pagehide/beforeunload keepalive leave, 로컬 disconnect, 토큰 만료 안내를 추가했다. Tauri WKWebView 마이크 권한과 실오디오는 오케스트레이터 실측 대기(`runtime-unverified`).
- 2R: 허들 헤더 표면을 320px 계약 안에서 참가자 요약부터 축소하고 오류·오프라인 문장을 아래 `InlineBanner` 행으로 옮겼다. joined의 Live·마이크·나가기는 REST 프로젝션 500/503과 분리했으며, LiveKit `connect-src` CSP 거부와 마이크 캡처 `SecurityError`를 서로 다른 국면으로 분류한다.

## MOMO-637 플러그인 연결 동의 모달 + 다중 scope (#839, 2026-07-27)

- 웹 앱 권한 변경은 명시 동의 모달을 거친 뒤에만 scope별 grant/revoke POST를 만들며, 선언된 scope의 체크박스 선택·관리자 승인·발행자/출처·egress·위험도/승인 티어·선택 약관 링크를 실제 manifest 데이터로 표시한다. 부분 실패는 성공한 scope와 실패한 scope를 분리해 표시하고, 현재 유효 tool policy에서 scope별 권한 상태를 다시 계산한다.
- `npm run typecheck`·Vitest 877·`npm run build`·lint(기존 warning 4)·design preflight 10/10 PASS. Playwright `gate:wire`·`gate:shell`은 이 worker sandbox에서 Chromium이 런치 직후 종료되어 runtime-unverified이며, fresh design-review는 오케스트레이터 실행 대기다.
- 3R: scope 포커스 완료를 실제 `activeElement` 도착으로 판정하고 160ms catalog/detail 편차 게이트를 추가했다. 동의 모달은 고정 헤더·스크롤 본문·고정 푸터로 분리했으며 진행 버튼 대비, 포커스 링 추종, 위험 칩, 혼합 실패·취소 후 receipt를 보강했다. typecheck·Vitest 881·build·preflight 10/10 PASS, `gate:shell`은 Chromium Mach-port 권한 거부로 오케스트레이터 실행 대기(`runtime-unverified`).
- 4R: 짧은 창의 고정 헤더를 제목만 남기고 권한 위험·승인 칩을 첫 프레임에 노출했다. 설치자 데이터가 없는 관리자 명단은 문의 대상 역할로만 표현하며, 패널 도구 칩·scope 식별 폴백·scope별 오류·진행 중 체크박스 어포던스를 국소 정리했다. typecheck·Vitest 881·build·preflight 10/10 PASS, `gate:shell`은 Chromium Mach-port 권한 거부로 오케스트레이터 실행 대기(`runtime-unverified`).
- **5R + 오케스트레이터 실측 완료(2026-07-28)**: 단일 원인 실패는 원인을 한 번만 말하고 영향받은 권한을 나열한다(403×N이 가장 흔한 실패 모양이라 4R의 권한별 반복이 자기모순이었다). `워크스페이스 설치됨` 칩을 제목 블록으로 올려 위조 불가능한 신호가 폴드 위에 남는다. **게이트 실행·red proof 4종 성립**: 포커스 핸드오프(160ms 편차에서 무조건-true 복원 시 타임아웃 FAIL) · 스크롤 상자(제거 시 버튼 top 878 vs 패널 568) · 링 여백(`scroll-pt-1` 제거 시 gap 0) · 단일 원인(분기 해제 시 `policyCauseCount:4`로 FAIL). 881 tests · `gate:wire`·`gate:shell` PASS · preflight 10/10. design-review **5R PASS(Blocker 0·High 0)**.

## MOMO-640 웹 세션 저장 경계 + Tauri CSP (#842, 2026-07-27)

- Tauri 셸 번들은 `tauri.conf.json`의 CSP로 same-origin script·font·asset만 허용하고, xterm의 검증된 런타임 style 쓰기와 런타임 API/realtime/관전 host 연결만 제한적으로 연다. `gate:csp`는 이 설정값을 직접 읽어 preview 헤더로 적용한 뒤 로그인→셸→xterm 관전 경로의 CSP 위반 0건을 단정한다.
- 브라우저 refresh token의 현행 localStorage 경계는 이번 범위에서 변경하지 않았다. httpOnly cookie 전환은 임의 API origin·Tauri `tauri://localhost`·HTTP LAN 서버를 함께 다시 설계해야 하므로 별도 ADR 사안이다. 서버가 `allowCredentials: false`로 쿠키 경로를 **표현 불가능하게** 설계해 둔 것을 코드에서 확인했다(`CORSMiddleware.swift:88`, `Config.swift:316-318`) — 쿠키 전환은 그 결정을 되돌리는 일이다.
- **오케스트레이터 실측 완료(2026-07-27)**: `gate:csp` PASS(exit 0)·**red proof 성립**(`CSP_GATE_PROVE_RED_STYLE=1` → style-src-elem 위반 22건 관측 후 exit 1). `gate:wire`·`gate:shell` 무회귀 PASS. 두 게이트를 **패키징된 CSP 헤더 아래에서 재실행해도 PASS**이고 `default-src 'none'`으로 바꾸면 둘 다 exit 1 — 헤더가 실제로 서빙된다는 증명이자 `gate:csp` 단일 경로보다 넓은 커버리지다(절차는 `clients/web/README.md`·게이트 헤더 주석에 고정).
- **Tauri 실빌드 실측**: `cargo tauri build --bundles app --ci` exit 0, 번들 실행 시 **연결 화면이 WKWebView에서 정상 렌더**(스타일·폰트 적용). CSP 문자열이 바이너리에 그대로 포함됨을 확인. **IPC도 이 CSP 아래에서 동작한다** — 키체인 조회 프롬프트와 mDNS로 프리필된 서버 주소가 각각 웹뷰→Rust 왕복의 산 증거다. 한계: 릴리스 번들은 devtools가 없어 **런타임 콘솔 위반 목록은 읽지 못했고**, 로그인 이후 실서버 왕복은 자격증명 취급 범위 밖이라 미수행.

## MOMO-636 웹 플러그인 마켓플레이스 복원 (#838, 2026-07-27)

- 설정의 `앱` 섹션에 catalog·원본 manifest 상세·egress 도메인·tool risk/approval tier·설치/해제와 본인 단일 scope grant 회수를 복원했다. 관리자 판정은 roster의 내 role이 owner/admin으로 확인될 때만 열며, 다중 scope는 원문 표시만 하고 변경하지 않는다.
- 웹 API는 `lib/wire.ts` helper로 plugin 6개 엔드포인트를 파싱하고 `null`·빈 객체·타입 전도는 해당 패널의 inline 오류로 내린다. typecheck·Vitest 861·build·design preflight 10/10 PASS, Playwright gate:wire/gate:shell은 이 worker sandbox의 Chromium Mach-port 권한 거부로 runtime-unverified다.
- 4R design-review 반영: 확인 다이얼로그는 열릴 때만 마운트되어 opener를 복귀하고 Esc를 소비해 설정 라우트 이탈을 막는다. 오류 닫기는 원래 액션에 되돌리며, 상세 scroll은 열 수 대신 설정 패널 안의 실제 가시성으로 판정하고 진행 중인 형제 액션을 잠근다.
- `npm run typecheck`·Vitest 871·`npm run build`·design preflight 10/10 PASS. Playwright `gate:wire`·`gate:shell`은 동일 Chromium Mach-port 권한 거부로 `runtime-unverified`다.

## MOMO-639 한국어 보안 판단 자료 + 신뢰 경계 다이어그램 (#841, 2026-07-27)

- `docs/security/README.ko.md`에 Dawn 비경유/선택 push relay, RLS 부트 가드, 감사·첨부·Drive 위임 경계와 코드·ADR 행 단위 근거를 정리하고 Mermaid 신뢰 경계 다이어그램을 추가했다. 영문 `SECURITY.md`는 한국어 판단 자료로 연결하되 신고 절차의 정본으로 유지한다.
- 알려진 한계(첨부 악성코드·MIME sniffing 부재, 브라우저 refresh token localStorage, Tauri CSP 없음, 외부 인증 없음, 구 alpha 미서명, 개인 Drive 미지원)를 같은 문서에 명시했다. Mermaid browser renderer는 worker sandbox의 Chrome process launch 제약으로 `runtime-unverified`; 링크·행 앵커·문서 gate는 확인했다.

## MOMO-638 첨부 tenant unique + manifest 표시 메타데이터 (#840, 2026-07-27)

- Migration 044는 전역 `attachment.drive_file_id` unique를 `(workspace_id, drive_file_id)` partial unique로 원자 교체하고, 기존 tenant 내부 중복을 삭제 없이 fail-closed한다. `verify_attachment_upload.sh`는 두 테넌트의 같은 Drive ID 삽입 성공·상호 RLS 비가시를 단정하며 `ATTACHMENT_GATE_LEGACY_UNIQUE_PROOF=1`은 격리 Compose에서 의도적 red proof를 만든다.
- 플러그인 manifest `plugin`에 선택 `termsURL`·`privacyPolicyURL`(HTTPS)·`iconText`(최대 8 문자)를 허용해 catalog/detail API와 OpenAPI에 투영한다. 공식 4종 시드는 출처 없는 값을 추가하지 않아 모두 생략되고, 클라이언트는 링크 행·아이콘을 각각 생략/이름 기반 문자 폴백한다.
- `bash -n`·migration 번호·YAML/JSON·diff 정적 검증만 완료; 이 worker sandbox에서는 Swift build/test·psql·Docker verifier가 `runtime-unverified`이며 오케스트레이터 실행 대기다.


## MOMO-634 워크스페이스 허용 모델 REST + 웹 교집합 (#831, 2026-07-27)

- `GET /v1/workspaces/:ws/agents/:agent/allowed-models`는 활성 워크스페이스 멤버에게만 `agent.model ∪ workspace.settings.allowed_agent_models`를 결정적으로 투영한다. 설정 JSON·프로필·자격증명은 내보내지 않으며, 기존 `MessageRoutes.allowedAgentModels` 단일 소스를 재사용한다.
- 웹 모델 피커는 유효한 응답을 받았을 때만 교집합으로 좁히고, 404·네트워크·`null`/타입 전도 응답에서는 기존 넓은 목록·고지로 폴백한다. 이미 저장된 허용목록 밖 model preference의 base-model 폴백도 경고로 보존한다. Docker `verify_run_routing.sh`와 Playwright `gate:wire`·`gate:shell`은 오케스트레이터 검증 대기(`runtime-unverified`).

## MOMO-633 리뷰 잔여 묶음 (#828, 2026-07-27)

- instance-global quota ingest scope는 provider-link와 같은 instance-operator 경계에서만 발급되고, 각 ingest는 actor/token·provider/window·적용 여부를 감사한다. 200 error envelope은 typed cascade terminal failure가 되고, 복호화 불가 cascade hop은 로그와 `bearerUnavailable` 표식으로 GET에 남아 replace-all PUT에서 보존된다. 24~31자 credential-shape도 거부한다.
- 웹 quota reset 판단은 `observedAt + elapsed` 서버 앵커를 사용하고 `ageSeconds`/schema 결측을 지어내지 않는다. Python adapter는 ADR-0135대로 408/425를 fallback하지 않으며 reset 없는 ratio도 JSON null로 ingest한다. Swift 전체 build·Docker verifier 및 web Vitest는 현 sandbox의 Xcode manifest/미설치 node_modules 제약으로 runtime-unverified; 오케스트레이터 명령은 PR에 기록한다.

## MOMO-632 웹 와이어 검증 레이어 + 백스크린 차단 (#827, 2026-07-27)

- 웹 REST 두 퍼널이 `null`/배열/원시 JSON을 명시적 wire 오류로 전환하고, 목록·진단·정책 언랩은 total helper로 빈 상태 또는 query 오류로 내린다. 앱 루트와 설정 본문에는 재시도 가능한 오류 경계를 추가해 설정 한 섹션의 렌더 실패가 사이드바·탐색을 언마운트하지 않는다.
- `npm run typecheck`, `npm test`(841), `npm run build`, `npm run lint`(기존 warning 4), `scripts/design_preflight_web.sh` PASS. 신규 `npm run gate:wire`는 `null`·`{}`·타입 전도 fixture로 root child와 sidebar를 단정하도록 준비했다. 이 워커 sandbox의 Chromium은 macOS Mach-port 권한에서 실행 불가여서 gate:shell/gate:wire와 의도적 pre-fix red proof는 오케스트레이터 실행 대기(runtime-unverified).

## MOMO-630 캐스캐이드 실패 분기 + 총 예산 (#825, 2026-07-27)

- `ProviderCascadeRunner`는 이제 `ProviderCascadeFailure(reason, disposition, underlying)`를 경계 밖으로 전달한다. 워커는 **모든 홉의 가용성 소진만** 재큐잉하며, 4xx·cancelled·undecodable·부분 출력 후 실패·총 예산 초과는 `markJobFailed`와 동일한 사용자 실패 안내로 끝낸다. 원본 오류는 진단 문자열에 보존되어 401 등 원인을 `agent_run.error`에서 확인할 수 있다.
- `PROVIDER_CASCADE_TOTAL_TIMEOUT_MS`(기본 60000ms)는 체인 전체 wall-clock 상한이다. 각 hop은 남은 시간만 요청 timeout으로 받고, 남은 hop 전에 또는 in-flight timeout 뒤 예산이 소진되면 `provider_cascade_total_timeout`으로 끝난다. Hermes 논스트림 재요청은 콘텐츠를 아직 내보내지 않은 decoding/protocol 실패로 한정해 부분 출력+전체 답변의 본문 오염을 막는다.
- 검증: focused `ProviderCascadeTests`에 propagate/content-emitted/availability-exhausted/total-budget worker terminal 분기와 실제 소켓 회귀를 추가했고, `scripts/verify_provider_cascade.sh` B6은 401 job의 `status=failed, attempts=1`을 확인한다. Docker runtime gate는 오케스트레이터 실행 대상: `PROVIDER_CASCADE_RUN_DOCKER=1 scripts/verify_provider_cascade.sh` (기본 포트 28330–28333).

## MOMO-631 iOS message send camelCase repair + live-wire gate (#826, 2026-07-27)

- `IOSSendMessageRequest` now emits the server's closed-world `clientMsgId`/`runId` keys; `scripts/verify_ios_wire.sh` adds the isolated compose + disposable-fixture gate that drives the public MomoiOSKit login → send → history → identical-id replay path. Docker execution and the intentional pre-fix red proof remain orchestrator-owned in this worker sandbox.

## MOMO-625 profile effort_pref writer + 멘션 경로 routing (ADR-0134 D1·D3, #816, 2026-07-26)

- 배경: MOMO-621(#808)은 `agent_profile.effort_pref` 컬럼(마이그레이션 041)과 요청 단위 `routing`을 **run 생성 표면 하나에만** 붙였다. 남은 두 구멍이 이번 범위 — ①`effort_pref`를 쓰는 REST writer가 없어 SQL로만 채울 수 있었고 ②에이전트 run을 시작하는 **다른** 표면인 멘션 경로에는 요청 단위 오버라이드가 없었다. 마이그레이션 신규 없음(041 컬럼 기존재).
- **① 프로필 writer**(`AgentProfileRoutes.swift`): `AgentProfileInput`이 closed-world를 유지한 채 `effortPref` 한 키만 늘었다(`AgentProfileValidation.normalizedEffortPref`). 검증 강도는 **본문이 모델을 확정했는지**에 따라 좁아진다 — `modelPref`가 있으면 provider×model 테이블까지 적용(`hermes-fast`+`max` → 400), 없으면 해석 모델이 런타임 속성이므로 **정규 레벨 검증만**(`low|medium|high|xhigh|max`, 32바이트 = 041 CHECK 미러). 위반 400은 ADR-0134 D1 비대칭 그대로다: **쓰기는 명시 선택이라 즉시 보여야** 하고, 저장된 뒤 해석 모델이 못 쓰는 선호는 여전히 조용히 무시된다(`ignoredEffortPref`). GET/PUT 응답 DTO와 `agent.profile.created|updated` 감사(`has_effort_pref`)에 반영. 에이전트 생성 시 인라인 `profile` 경로도 같은 validator를 타 자동 승계.
- **② 멘션 경로 routing**(`MessageRoutes.swift`, `DTOs.swift`): `SendMessageRequest`가 **closed-world가 되고**(미지 top-level 필드 400) `routing { model?, effort? }` 한 키만 늘었다. 위치는 기존 메시지 확장 필드 관례(top-level 선택 키 `runId`/`rootId`/`attachmentIds`)를 따랐고, 자유형식 `props`는 **의도적으로 캐리어가 아니다**(ADR-0134 D1 B 기각 그대로 — 게이트에서 실측). closed-world가 없으면 `routting` 오타가 조용히 무시돼 상속 모델로 도는, D1이 막으려던 바로 그 비가시 실패가 남는다. 1st-party 발신자(macOS `MomoServerRESTChatBackend`·iOS `MomoServerConversationClient`·웹 `client.ts`·`adapters/hermes/momo_adapter.py`)는 모두 기존 키만 보낸다(전수 확인).
- **단일 해석 체인**: 멘션 후보(`AgentMentionCandidate`)는 이제 `baseModel`/`modelPref`/`effortPref`/`workspaceSettingsJSON`을 **원본 그대로** 들고, 해석은 `enqueueMentionJob`에서 run 생성 경로와 **같은 `RunRoutingResolution.resolve`**를 호출한다(두 표면이 갈라질 여지 제거). 순서도 동일 — 자격(멤버십/일시정지/깊이캡 403·409) 먼저, 라우팅 게이트(400) 나중. 400은 멘션 라우팅이 공유하는 send 트랜잭션(MOMO-215)을 통째로 롤백한다: **잘못된 모델을 고른 메시지는 다른 모델로 조용히 배달되지 않는다**(실측: 400 후 message 0행·agent_run 0행).
- **에코·payload·감사 관례 일치**: `agent_run.input.routing`은 `WorkRunInput.jsonValue`와 같이 **요청값만** 에코하고(상속은 키 자체 생략) → `usage_ledger.effort`의 요청 tier(`input->'routing'->>'effort'`)가 멘션 run에도 자동으로 붙는다. `agent_job` payload의 `model`/`effort`는 해석값(ADR-0134 D4 "선택된 모델은 항상 노출"), context packet의 `agent_profile.model`도 해석 모델로 정정. `agent.mention.queued` 감사 detail이 `agent.work.queued`와 **동일 키**(`routing`·`resolved_model`·`resolved_effort`·`ignored_model_pref`·`ignored_effort_pref`)를 기록 → 감사 질의 하나로 두 표면을 답할 수 있다.
- 검증: `make build` 전 패키지 green(**신규 경고 0**), `make test` 전 패키지 PASS(server **324/324**, AgentWorker 86/86, Core 45/45, relay 7/7, macOS 649/649 — server 신규 12개: 메시지 계약 closed-world·props 비캐리어·양 표면 shape 게이트 동치·상속 우선순위 매트릭스·effortPref 정규화/400 매트릭스). `scripts/verify_run_routing.sh`에 layer 6(프로필 writer)·layer 7(멘션 경로) 관문을 추가해 **워크트리 compose 실측 54관문 전부 PASS**(포트 26820/26822, `infra/docker-compose.e2e.yml` + `AGENT_GATEWAY_MODE=gateway` 오버레이, 종료 시 `down -v` — 잔여 컨테이너/볼륨 0): 프로필 PUT 정규화·영속·감사 + 400 3종 후 무변경 · 멘션 상속(hermes-fast/low, `input.routing` 생략) · 멘션 명시 routing 201 + 에코 + payload + 감사 · 허용목록 밖 400 + **send 롤백** · 400 매트릭스 4종 · props 스머글링 무효 · 모델 변경으로 무효해진 effort 조용히 드롭 + `ignored_effort_pref` 감사.
- 미구현(후속): 워크스페이스 기본 tier(D3 최상위)와 auto 정책(D4)은 여전히 범위 밖. `docs/api/openapi.yaml`은 ADR-0134 표면(`routing`·`/v1/provider/effort-table`·`effortPref`)을 아직 담고 있지 않다(MOMO-621에서도 미갱신) — 웹 클라 생성 타입이 뒤처지므로 계약 문서 갱신 티켓이 필요하다.

## MOMO-621 요청 단위 model·effort 라우팅 + effort 축 (ADR-0134 D1·D2·D3, #808, 2026-07-26)

- 배경: run 생성 API는 closed-world라 "이 요청만 무겁게/가볍게"가 불가능했고, `effort` 개념은 1st-party 코드 전역에 부재했다(ADR-0134 Context). 정본 = `docs/adr/0134-request-level-model-effort-routing.md`(Accepted).
- **D1 routing 블록**: `CreateAgentRunRequest`가 closed-world가 되고(`allowedKeys`에 `routing`만 추가, 미지 top-level 필드 400) 선택적 `routing { model?, effort? }`를 받는다. `WorkRunInput.allowedKeys`도 `routing` 하나만 늘려 `input.routing` 철자를 함께 허용하되 **둘이 불일치하면 400**(조용한 승자 없음). routing 객체 내부도 closed-world. 신규 파일 `server/Sources/MomoServer/Routes/RunRouting.swift`.
- 게이트 비대칭(ADR 결정 그대로): **명시 요청**의 `routing.model`이 `workspace.settings.allowed_agent_models`(∪ `agent.model`) 밖이거나 `routing.effort`를 해석된 모델이 지원하지 않으면 **400**. **상속된** agent profile 선호는 사용 불가 시 조용히 무시 + `agent.work.queued` 감사행에 `ignored_model_pref`/`ignored_effort_pref` 기록(ADR-0131 D2 관례 유지). 허용목록 판정은 `MessageRoutes.allowedAgentModels`로 단일화해 두 표면이 갈라지지 않게 했다.
- **D2 effort 축**: `GET /v1/provider/effort-table`(신규 `ProviderEffortTableRoutes.swift`, `authed` 그룹, 인증만 요구 — 테넌트 데이터·자격증명 0). 유효값은 **provider×model 테이블**(v0는 코드 상수, wire 모양은 provider→models→efforts로 확장 가능): `hermes-agent`/`hermes-default`는 low~max, `hermes-fast`/`hermes-lite`는 low/medium, 미등재 모델은 보수적 fallback low/medium/high. 정규 레벨 = `low|medium|high|xhigh|max`.
- **마이그레이션 041**(`041_run_routing_effort.sql`, `schema_v0.sql` 무변경): `usage_ledger.effort text NULL` + `agent_profile.effort_pref text NULL`, 각각 길이 1~32 CHECK만(값 집합은 DB enum이 아니라 테이블 정본). 신규 테이블 없음 → RLS DO-block 등록 불필요, 두 테이블 모두 기존 FORCE RLS 유지.
- **원장 2경로**: ①gateway `AgentGatewayRoutes.reconcileUsage` — `AgentGatewayUsage.effort`(어댑터 보고) → run의 요청 effort(`input.routing`) → agent profile `effort_pref` 순으로 `ledgerEffort`가 결정. 보고값은 provider가 실행 권위이므로 known level이면 채택, 추정 tier(요청/선호)는 해석 모델이 지원할 때만 채택하고 아니면 **NULL**(틀린 분석 축을 쓰지 않는다). ②worker `CostAccounting.reconcile(effort:)` — job payload의 해석된 effort를 기록(길이 초과/공백은 NULL로 정규화해 원장 tx 자체를 잃지 않는다).
- **D3 상속 + adapter 전달**: routing 부재 시 agent profile `model_pref`(기존) + `effort_pref`(신규)를 적용한다. 해석된 `model`/`effort`는 `agent_job` outbox payload에 실려 gateway pending 응답으로 어댑터에 그대로 전달된다(ADR-0130 payload 관례). mention 경로도 같은 payload 키를 채워 worker 원장이 의미를 갖는다. `adapters/hermes/momo_adapter.py`는 payload effort를 정규화해 usage에 되돌려준다(런타임이 직접 보고하면 그 값이 우선).
- 검증: `swift build` green(server·AgentWorker·`make build` 전 패키지, **신규 경고 0**) + server `swift test` **278/278 PASS**(신규 `RunRoutingTests` 27개: closed-world 400 매트릭스·effort 테이블 자기정합·허용목록/모델×effort 400 게이트·상속 폴백·무시 규칙·원장 effort 우선순위), AgentWorker `swift test` 72/72 PASS, hermes 어댑터 계약 61 tests PASS. `scripts/verify_run_routing.sh`(신설) **30관문 전부 PASS**(워크트리 compose 포트 21050/21052, `infra/docker-compose.e2e.yml` + `AGENT_GATEWAY_MODE=gateway` 오버레이, 종료 시 `down -v`): 041 컬럼/CHECK/FORCE RLS 실측 · effort-table 401/200/모양/무자격증명 · routing 400 5종 + 롤백(agent_run 0행) · 상속 및 무시 감사 · **에이전트 bearer로 gateway job claim → complete 실왕복으로 `usage_ledger.effort` 기록**(보고 우선 `medium`, 미보고 시 요청값 폴백 `medium`, 지원 불가 선호는 NULL) · 교차 테넌트 격리(own=2, foreign=0).
- 미구현(후속): `agent_profile.effort_pref`를 쓰는 REST writer는 없다(프로필 PUT 본문은 closed-world 유지) — ADR-0134 D3 UI 티켓 소관. 워크스페이스 기본 tier(D3 최상위)와 auto 정책(D4)도 이번 범위 밖이다.

## MOMO-623 provider 잔여량 스냅샷 ingest+조회 (ADR-0135 D2, #810, 2026-07-26)

- 배경: ADR-0135 D2-A — 프로브 실행 주체를 **자격증명 보유 측(hermes adapter)**로 옮기면 OAuth 잔여량 대시보드와 ADR-0004(자격증명 비유입)가 충돌하지 않는다. oort는 provider API를 **직접 조회하지 않고 숫자만 받는다.**
- 마이그레이션 **043** `server/Migrations/043_quota_snapshot.sql` — `quota_snapshot(provider_ref, quota_window, remaining_ratio, resets_at, probed_at, ingested_at)`, `PRIMARY KEY (provider_ref, quota_window)`로 게이지당 1행(ADR-0135 "최신 스냅샷만"). CHECK: window ∈ short|weekly · ratio 0..1 · provider_ref 슬러그(`^[a-z0-9][a-z0-9._-]{0,63}$`). **`window`는 PostgreSQL 예약어라 컬럼명은 `quota_window`, 와이어 필드는 ADR대로 `window` 유지**(REST 계층에서 매핑). `schema_v0.sql` 무변경.
- RLS FORCE 2정책(provider_link 039 패턴 변형, workspace_id 없는 instance-global 테이블): 쓰기 = `app.provider_quota_admin` GUC 게이트(REST가 scope 검증 **후에만** 세팅), 읽기 = `app.workspace_id`가 바인딩된 테넌트 세션만 SELECT. GUC 없는 세션은 default-deny.
- 신규 표면 `server/Sources/MomoServer/Routes/ProviderQuotaSnapshotRoutes.swift`:
  - `POST /v1/provider/quota-snapshots` — 발신 인증은 **기존 adapter/gateway 자격 관례 재사용**: 에이전트 베어러(ADR-0101 phase 1) + 전용 scope `provider:quota:write`. `AuthMiddleware.requiredAgentScope`가 이 경로에만 scope를 고정하고, `TokenStore.authenticateAgentBearer`가 이미 활성 `member.kind='agent'`임을 증명한다. scope는 `AgentCredentialRoutes.grantableScopes`에만 있고 **defaultScopes에는 없다** — 기존 에이전트 자격이 재발급만으로 instance-global ingest를 얻지 못한다.
  - `GET /v1/provider/quota-snapshots` — usage/summary 인가 관례(활성 워크스페이스 멤버 전원). 에이전트 베어러는 GET scope 매핑이 없어 접근 불가(403).
- ADR-0004 스키마 폴리싱(3단): ①closed-world 키 — ADR-0135 snake_case(`provider_ref` 등)를 camelCase 별칭으로만 허용하고 그 밖의 키/중복 별칭은 400 ②credential-shape 스크리닝 — `WorkToolProfileRoutes.containsCredentialShape`(private→internal로 단일화 재사용) + provider 키 접두(`sk-`/`ghp_`/JWT `eyJ`/momo agent bearer/`Bearer ` 등)·고엔트로피 블롭 검사를 키·문자열값 전부에 적용 ③타입 폴리싱 — ratio는 JSON 숫자 0..1(따옴표 숫자는 강제변환 없이 400), 두 시각은 ISO8601(+300s 스큐 허용·30일 초과 거부).
- 최신성 upsert: `ON CONFLICT (provider_ref, quota_window) DO UPDATE ... WHERE quota_snapshot.probed_at <= EXCLUDED.probed_at`로 **probed_at 단조** — 재전송/역순 프로브는 기존 값을 유지하고 응답이 `applied:false` + 보존된 스냅샷을 돌려준다. 응답에 `ageSeconds`(스냅샷 나이) 포함 → 대시보드 "마지막 확인값" 폴백 재료. 신규 realtime 이벤트 없음(outbox 경유 대상 없음), audit 미기록(프로브는 고빈도).
- 계약 문서: `docs/api/openapi.operator.yaml`에 두 오퍼레이션 + 4개 스키마 + `agentBearerAuth` 시큐리티 스킴 추가(#811 adapter 다형화의 입력 계약).
- 검증: `swift build` green(server, **신규 경고 0**) + `swift test` **268/268 PASS**(251→268, 신규 `ProviderQuotaSnapshotTests` 17개: 별칭·중복·credential-shape 거부·범위/타입 거부 매트릭스·시각 스큐·scope 고정·043 계약). `scripts/verify_quota_snapshot.sh` **전관문 PASS**(워크트리 compose 포트 20560/20562, `infra/docker-compose.e2e.yml`, 종료 시 `down -v`): 043 적용+FORCE RLS 메타 · ingest 인증 401/403/403(익명·scope 없는 에이전트·human JWT) · credential-shape 8종 400 · 스키마 400 6종 + 거부 후 테이블 0행 · 최신성 upsert(신규 probe 적용, 과거 probe `applied:false`로 0.2 보존, 게이지 3행) · 멤버 GET 200/비멤버 403/에이전트 403/익명 401 · RLS(무-GUC 0행, `app.workspace_id` 3행, 테넌트 INSERT 거부, `app.provider_quota_admin` INSERT 허용) · api 로그에 베어러·거부된 자격증명형 값 비유출.

## MOMO-615 워크스페이스 사용량 요약 REST (AX-7 1층, #791, 2026-07-25)

- 배경: `usage_ledger`는 `workspace_id` 축 + `usage_ledger_ws_time_idx (workspace_id, created_at DESC)`가 이미 완비돼 있고 **노출만 부재**했다. 계약 정본 = `docs/planning/handoffs/2026-07-25-usage-summary-contract.md`(MOMO-615 엔진 ↔ MOMO-616 웹 공유).
- 신규 표면: `GET /v1/workspaces/:ws/usage/summary?from=<ISO8601>&to=<ISO8601>&bucket=day|week|month` — `server/Sources/MomoServer/Routes/UsageSummaryRoutes.swift`(라우트 + 7개 wire DTO), `App.swift`의 `authed` 그룹에 mount. **읽기 전용이라 마이그레이션 없음, `schema_v0.sql` 무변경.**
- 인가: `InviteRoutes.workspaceID`(path ws == JWT ws, 불일치 403) + `WorkspaceAuthorization.activeRole`(활성 워크스페이스 멤버 전원 조회 가능 — "워크스페이스에서 발생하는 과금은 사용자가 전부 트래킹"). 테넌트 커넥션(RLS FORCE)만 사용, BYPASSRLS·`row_security = off` 미사용, 쓰기 0.
- 집계: totals(`was_estimated` 부분합을 `FILTER`로 분리) · buckets(`date_trunc(unit, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` — DB 세션 TZ와 무관하게 UTC 고정, week = ISO 월요일) · byModel · byAgent(`member` LEFT JOIN으로 displayName, **UUID는 소문자**) 모두 `costMicroUsd` 내림차순. 기간 필터는 `AuditRoutes`의 기존 from/to 관례대로 **양끝 포함**.
- budget: `CostProjectionRoutes`의 grain 매칭 중 `workspace` arm + MIN(limit) 채택(`ORDER BY b.limit_micro_usd ASC, b.id ASC LIMIT 1`)으로 한 budget 행에서 grain/limit/spent/reserved/periodStart를 일관되게 뽑고, 상태는 `CostProjectionRoutes.limitState`를 그대로 재사용. 매칭 없으면 `"budget": null`(키 유지 — 합성 `Encodable`의 `encodeIfPresent` 누락을 커스텀 `encode(to:)`로 방지).
- 계약 기본값: `from=to-30d`·`bucket=day`, 최대 93일 초과 400, 빈 기간은 **200 + 0값**(404 아님).
- 검증: `swift build` green(server, 신규 경고 0) + `swift test` **251/251 PASS**(신규 `UsageSummaryRoutesTests` 13개: 범위 검증 400 매트릭스·93일 경계·계약 wire 키 집합·빈 기간 0값/`budget: null`·시드 원장 손계산 라운드트립·소스 계약). `scripts/verify_usage_summary.sh` **30관문 전부 PASS**(워크트리 compose 포트 24650/24652, `infra/docker-compose.e2e.yml`, 종료 시 `down -v`): 비-멤버 403 · 교차 워크스페이스 403 · 비인증 401 · 400 4종 · 빈 워크스페이스 200/0값/budget null · 시드 원장 4행 손계산 일치(cost 186000, estimated 66000, prompt 6100, completion 1210) · day/week/month 버킷 경계(`2026-07-05T23:59:59Z`/`2026-07-06T00:00:00Z` 쌍이 day·week 모두에서 분리, week는 `2026-06-29`로 롤백) · 범위 밖 2행 제외 · budget MIN(limit) 채택(200000 채택, 500000·agent grain 1000 미채택) + soft_limit→hard_limit 전이 · 기본 30일 창.

## MOMO-605 서버 CORS 오리진 allowlist — Tauri 데스크톱 (P2, #768, 2026-07-25)

- 배경(ADR-0133 P2 스파이크 발견): 웹은 같은 오리진 서빙(ADR-0119 D1-A)이라 CORS가 필요 없지만, 패키징된 Tauri 릴리스는 webview 오리진이 `tauri://localhost`(Windows/Android는 `http://tauri.localhost`)라 `/v1/*` 호출이 진짜 교차 오리진이 되어 브라우저 규칙에 막힌다. 어떤 도메인으로도 파생할 수 없는 값이라 operator 명시 env로 연다.
- 신규 계약: `MOMO_CORS_ALLOWED_ORIGINS`(쉼표 구분, **완전일치** allowlist). 파싱은 `server/Sources/MomoServer/Config.swift`의 `CORSConfig`, 게이트는 `server/Sources/MomoServer/Middleware/CORSMiddleware.swift`의 `OriginAllowlistCORSMiddleware`(Hummingbird 내장 `CORSMiddleware`의 헤더 기계장치를 위임 사용 — 내장 `.oneOf`가 가변인자 전용이라 런타임 배열로 만들 수 없기 때문).
- **기본 빈=완전 무변경**: `config.cors.isEnabled`가 false면 `App.swift`가 미들웨어를 아예 mount하지 않는다 → `Access-Control-*`/`Vary` 헤더 0개, OPTIONS 단락 없음. 기존 게이트 전부 무회귀.
- 와일드카드 금지: `*`·`https://*.example.com`·리터럴 `null`·경로/트레일링 슬래시·userinfo·불량 포트는 파싱 단계에서 거부하고 부팅 시 warning 1회를 남긴다(오타는 허용범위를 좁힐 뿐 넓히지 않는다 — 실측: `MOMO_CORS_ALLOWED_ORIGINS=*` 기동 시 표면 완전 폐쇄 + warning). credentials 정합: oort는 쿠키 미발급(서버 `Set-Cookie` 0건)·Authorization 베어러 전용이라 `Access-Control-Allow-Credentials`를 절대 보내지 않는다 → `Allow-Origin: *` + credentials 조합이 표현 불가다.
- 미허용 Origin은 403이 아니라 **헤더 없이 통과**시킨다(브라우저가 차단; Origin을 보내지 않는 네이티브 클라·curl·work host·subscribe proxy는 무영향). 미들웨어는 rate limiter 바깥이라 429/4xx 응답도 CORS 헤더를 유지한다(브라우저가 불투명 오류 대신 실제 상태를 읽는다).
- Centrifugo: `infra/centrifugo.json` `client.allowed_origins`에 `tauri://localhost`·`http://tauri.localhost` 추가 — e2e와 내부알파(`momowebqa`, `scripts/internal_alpha_stack.sh`)가 같은 파일을 쓴다. prod는 MOMO-398 `APP_DOMAIN` 단일 파생 계약 **무변경**.
- 배선/문서: e2e·prod compose api 서비스가 `MOMO_CORS_ALLOWED_ORIGINS: ${MOMO_CORS_ALLOWED_ORIGINS:-}` passthrough, 두 env 템플릿(`infra/.env.example`·`infra/prod/.env.example`) 동시 갱신(주석 상태 유지 = 기본 무변경), `scripts/prod_env_preflight.sh` strict가 와일드카드/`null` 값을 compose 기동 전에 fail-fast, `docs/RUN.md` §2.2 + `docs/DEPLOY.md` 갱신. 마이그레이션 없음, `schema_v0.sql` 무변경.
- 검증: `swift build` green(server) + `swift test --filter CORSAllowlistTests` **18/18 PASS**(파싱·정규화·와일드카드/`null`/malformed 거부·중복제거·게이트 판정·헤더 정책 상수). `scripts/verify_cors_allowlist.sh` **전관문 PASS** — 정적 계약 + **실 MomoServer 프로세스 3회 기동 preflight 실왕복**(28300 포트 블록, Docker 불요: DB 미접속 상태에서 미들웨어와 `/health`만 사용): ①knob unset → `Access-Control-*`/`Vary` 0개·OPTIONS 비단락 ②knob set → `OPTIONS /v1/auth/login` 204 + 정확 echo·methods/headers·`Vary: Origin`·credentials 헤더 부재·wildcard 부재, 미허용 오리진 무헤더, Origin 없는 요청 무헤더, 4xx도 헤더 유지 ③`*` → 부팅 거부 warning + 표면 폐쇄.

## MOMO-589 인앱 워크스페이스 생성 REST — POST /v1/workspaces (W-S1, #731, 2026-07-24)

- 셀프서브 여정 배치 W-S1. `infra/prod/create_workspace.sql`(MOMO-571 migrate 서브커맨드)의 시딩 로직을 REST로 서버화했다. 신규 로직은 `server/Sources/MomoServer/Routes/WorkspaceRoutes.swift`의 `create` 핸들러 + `DTOs.swift`의 `CreateWorkspaceRequest`/`CreateWorkspaceResponse`. `App.swift`에서 `WorkspaceRoutes`에 `platformAdminEmails`를 주입한다. 신규 마이그레이션 불필요(기존 테이블만 사용).
- 인가 = 등재 인스턴스 운영자(MOMO-583 모델 재사용): `ProviderLinkRoutes.isProviderLinkOperatorAuthorized`를 그대로 호출 — `platform:read` scope 또는 owner/admin+검증 이메일이 `PLATFORM_ADMIN_EMAILS`에 등재. 일반 워크스페이스 owner(미등재)·비운영자·비-human 토큰은 403(테넌트 신설은 인스턴스 운영자 권한이지 워크스페이스 소유권이 아니다).
- 한 tx 시딩(신규 WS GUC 경유): 트랜잭션은 운영자 홈 워크스페이스로 열어 인가 판정 + 자격 스냅샷을 RLS 안에서 읽고, `set_config('app.workspace_id', 신규ID)`로 재바인딩한 뒤 workspace + owner member/human + workspace_membership(owner) + `#general` 채널 + channel_seq(0) + owner 채널 membership + `workspace.created`(source=momo-rest) 감사행을 모두 INSERT한다. slug 중복 = `workspace_slug_uniq` 23505 포착 → 409(부분 워크스페이스 없음).
- D5-A 계정 복제: owner의 email·password_hash를 `momo_password_hash` 재해시 없이 `ON COMMIT DROP` 임시테이블로 SQL 내부에서만 복사(해시가 앱으로 유입되지 않음, momo_password_* 규율 준수) → 운영자가 동일 이메일/비번으로 신규 WS에 owner로 즉시 로그인 가능.
- 검증: `swift build` green(server) + `swift test`(신규 `WorkspaceCreateTests` 5개: slug 정규화·거부 매트릭스, name 경계, 생성 표면 운영자 인가 매트릭스). 생성→201→풀테넌트 시딩→신규 WS owner 로그인(D5-A)→403 매트릭스(member·미등재 owner)→slug 중복 409→400 검증의 Docker/psql 왕복은 `scripts/verify_workspace_rest_create.sh`(28290 포트 블록, `WORKSPACE_CREATE_RUN_DOCKER=1`) — **런타임 왕복은 오케스트레이터 실행 대기(runtime-unverified)**.

## MOMO-588 신규 멤버 첫 입장 에이전트 인사 (W-O3, #723, 2026-07-24)

- 온보딩 와우 배치 W-O3. `JoinRoutes.join` 성공 경로 끝에서 워크스페이스 에이전트가 신규 멤버에게 **실제 발화 경로로** 먼저 인사한다(봇 래핑 금지 철학, 가짜 클라 연출 없음). 신규 로직은 `server/Sources/MomoServer/Routes/OnboardingGreeting.swift`.
- 단일 쓰기경로 재사용: 직접 INSERT 없이 `channel_seq` bump + `message` INSERT + `outbox` INSERT를 한 tenant tx(RLS FORCE, BYPASSRLS 미사용)로 수행하고, mention 부기는 `ReadStateMentions.record`, 브로드캐스트 payload는 `MessageRoutes.broadcastPayload`를 재사용한다. 대상 채널=#general 우선(없으면 가장 오래된 public), 작성자=활성 agent 멤버 handle 사전순 첫 번째.
- 결정론 템플릿(LLM 무호출): 고정 한국어(+`Accept-Language: en*`이면 영어) — 환영 + 할 수 있는 것 2가지(대화 요약·자료 조사) + "저를 한번 멘션해보세요" + 신규 멤버 `@handle` 멘션. em-dash 0·이모지 0·내부 어휘 0.
- 멱등((workspace, member)당 1회): 결정론 `client_msg_id`(RFC 4122 v5, 네임스페이스+워크스페이스+멤버) + `NOT EXISTS`(작성자 변경 대비) + `ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING`. 재입장 시 seq 미소모·중복 없음. props 마커 `onboarding_greeting=v1`도 기록.
- 조용한 skip(불침): 활성 agent 없음 또는 public 채널 없음이면 인사 생략, 어떤 예외도 삼켜(로그만) join은 항상 성공 — 인사 실패가 join을 깨지 않는다.
- 검증: `swift build` green(server) + `swift test`(215 tests, 신규 `OnboardingGreetingTests` 10개: 템플릿 계약·Accept-Language 선택·UUIDv5 RFC 벡터·멱등키 결정성·서버 mention 파서 정합). join→인사 존재+작성자=agent+멘션+outbox 1행+재입장 멱등+무-agent skip의 Docker/psql 왕복은 `scripts/verify_onboarding_greeting.sh` — **오케스트레이터 실행 11관문 PASS**(클린 볼륨+`MOMO_AGENT_SEED_MODE=demo` migrate 필수, outbox id 비교는 uuidString 대문자 정합으로 케이스 무관). 신규 마이그레이션 불필요(기존 message/props 관례 재사용).

## MOMO-583 provider_link 권한 재조임 — 등재 인스턴스 운영자만 (#716, 2026-07-24, 576 후속 집행)

- 조치: MOMO-576의 any-owner/admin 폴백 제거(instance-global 표면의 멀티WS 크로스테넌트 통제 누출). 새 인가 = **platform:read scope OR 등재 인스턴스 운영자**(owner/admin + `email_verified` + `PLATFORM_ADMIN_EMAILS` 등재, 요청 시점 DB 판정 — 재로그인 불필요).
- scope-only가 아닌 이유: `platform:read` 발급은 `platformAdminSecret` 로그인(MOMO-300 상수시간 비교)이 전제인데 macOS 앱 로그인에 그 필드가 없어, scope 전용 조임은 운영자 GUI를 영구 403으로 만든다. allowlist는 배포 env 통제자=인스턴스 운영자라는 ADR-0004 증보1 D3의 신뢰 경계와 일치.
- 분리 유지: per-WS 표면(`WorkHostEngineRoutes`, RLS-scoped)은 owner/admin 인가 유지 — instance-global ⇒ 등재 운영자, per-workspace ⇒ owner/admin.
- 배선: e2e compose `PLATFORM_ADMIN_EMAILS` passthrough, `internal_alpha_stack.sh` 기본 성재 이메일 주입.
- 검증: verifier 9관문 PASS — **동일 owner 롤 미등재 신원(WSOWNER) GET/PUT/DELETE 403 회귀 단정 신설**(폴백 제거 증명) + 등재 운영자 전체 왕복·마스킹·RLS·평문 비유출 유지. server 16 tests(매트릭스 2벌). PR #717→track/engine→#718→main.

## MOMO-576 provider link 권한을 owner/admin에 개방 (#700, 2026-07-24, ADR-0004 증보1 D3) — 후속 집행됨(583)

- 결함: MOMO-572 `ProviderLinkRoutes.requireOperator`가 `platform:read` scope만 요구해, owner의 일반 로그인 토큰(그 scope는 `PLATFORM_ADMIN_EMAILS`로만 발급)이 403 — 성재(owner)가 MOMO-574 'AI 연결' GUI를 열면 GET부터 403이라 GUI가 안 열렸다.
- 수정: `requireOperator`를 async 인스턴스 메서드로 바꿔 **platform:read scope OR 워크스페이스 owner/admin role**을 허용한다. platform scope가 있으면 DB 조회 없이 통과(플랫폼 admin 경로), 없으면 principal 자기 워크스페이스의 membership role을 `WorkspaceAuthorization.activeRole`로 조회해 `owner||admin`(`WorkspaceRole.isAdmin`)이면 통과·아니면 403. 판정 로직은 순수 함수 `isOperatorAuthorized(kind:scopes:workspaceRole:)`로 분리해 DB 없이 유닛 테스트(owner/admin 200·member/guest 403·platform 200·비human 403).
- RLS 정합: role 조회는 별도 `withTenantConnection`(app.workspace_id만 세팅, provider_link_admin 미세팅)에서 수행 — **권한 판정 완료 후에야** GET/test는 `withProviderLinkReadConnection`, PUT/DELETE는 `withProviderLinkTransaction`로 provider_link_admin GUC를 열어 행을 unlock한다("권한 판정 → GUC 세팅" 순서 유지).
- 부수 버그 수정: PUT/DELETE가 `InviteRoutes.workspaceID(context,principal:)`(=`:ws` path param 요구)를 호출했는데 `/v1/provider/link`엔 `:ws`가 없어 항상 실패했을 경로 — 인스턴스-글로벌이라 audit 귀속 워크스페이스를 `principal.workspaceID`로 직접 사용(원 함수도 검증 후 `principal.workspaceID`만 반환했으므로 등가·안전).
- 불변식: ADR-0004 OAuth/원본키 비유입·bearer write-only·마스킹 그대로. GUI 입력 필드/DTO closed-world 불변.
- ~~후속 티켓 후보~~ → **집행 완료(2026-07-24, MOMO-583/#716)**: 등재 인스턴스 운영자 allowlist로 재조임(위 583 항목). 원안의 platform:read-only는 macOS 로그인 경로 부재로 변형 채택.
- 검증: `swift build` + `swift test --filter ProviderLinkTests`(순수 유닛, DB 없음) — 라이브 200/403 REST 왕복은 orchestrator(포트 28260s)로 handoff, runtime-unverified.

## MOMO-571 momo-ops workspace-create + role 능력 매트릭스 감사 (#687, 2026-07-23, ADR-0117)

- W-1: migrate 이미지에 env-only `workspace-create` 서브커맨드를 추가했다(`infra/prod/create_workspace.sql` + `internal-smoke-migrate.sh` 분기). 워크스페이스 이름/slug·초기 owner 이메일/비밀번호를 psql `\getenv`로만 받아 한 트랜잭션에 workspace 행 + owner human/member/workspace_membership(role=owner) + `#general` 채널 + channel_seq + owner 채널 membership + `workspace.created` 감사행을 만든다. 비밀번호는 `momo_password_hash`로 해시되며 argv/stdout에 노출되지 않는다(ADR-0004). **slug 재실행 정책 = 명시적 거부**(부분 워크스페이스 없음; 재프로비저닝은 별도 slug 또는 `set-owner` 사용). `momo-ops.sh workspace-create`는 env-only fail-closed 래퍼로 연결했다.
- W-3: `create_invite.sql`의 owner 역할 거부(≤admin만 허용)를 재확인했고, 정적 verifier에 owner 거부 grep + 런타임 verifier에 owner 역할 초대 거부·행 미생성 negative 테스트를 보강했다.
- W-2: ADR-0117 §D3 능력 매트릭스를 서버 집행 지점과 대조 감사했다. 명백한 role 검증 누락(가드 부재)은 **없다** — 감사한 4개 파일의 모든 변경 엔드포인트에 명시 가드가 있다. 아래는 매트릭스와 구현의 **정책 divergence**로, 스코프 폭발 방지를 위해 수정하지 않고 티켓 후보로 등재한다:
  - **GAP-1 (에이전트 관리 범위)**: `AgentProfileRoutes.requireEditor`는 `role.isAdmin || owner_human_id == principal`을 허용해, admin 미만 member(또는 guest)라도 자기가 소유한 agent를 관리·pause할 수 있다. D3는 "에이전트 생성/관리·pause = owner/admin, member ❌"로 명시. ADR-0131 소유권 경로와 D3의 조정 필요(소유 human의 관리 허용 여부 결정 → requireEditor 조임 또는 D3 개정). *보안 완화 아님(소유권 스코프 한정).*
  - **GAP-2 (채널 생성 정책 토글 부재)**: `ChannelRoutes.create`는 `requireWorkspaceAdmin`(owner/admin)만 허용. D3는 "채널 생성 = owner/admin/**member(정책 토글)**". 즉 구현이 매트릭스보다 엄격(member 생성 불가, 토글 미존재). member-생성 정책 토글 추가 또는 D3를 admin-only로 개정.
  - **GAP-3 (채널 아카이브 미구현)**: D3는 "채널 생성·아카이브"를 능력으로 명시하나 `ChannelRoutes`에 아카이브 엔드포인트가 없다(list/create/notification-pref/addMember/removeMember만). 아카이브 엔드포인트 + owner/admin(+member 토글) 집행 구현 필요.
  - 정합 확인(가드 일치): `AuditRoutes.list`=requireAdmin ✅; `MemberLifecycleRoutes`의 role변경/제거/suspend/reinstate/bans=requireAdmin + `requireCanManage`(≤자기 role·equal/higher 금지·admin은 admin/owner 부여 금지) ✅; 채널 멤버 add/remove=requireWorkspaceAdmin ✅; updateNotificationPref=자기 채널 멤버십(개인 설정) ✅.
  - 스코프 밖: D3의 "메시지·멘션·Work 실행" 및 "guest=초대된 채널만" 집행은 지정 4개 파일이 아닌 Message/Work 라우트 소관 — 이번 감사 범위 아님(별도 후속 감사 후보).
- 검증: `bash -n`/`sh -n` + 정적 verifier PASS. `scripts/verify_workspace_create.sh`(예약 포트 28250) 및 `verify_momo_ops_runtime.sh` 보강분의 Docker 왕복은 오케스트레이터 실행 전까지 `runtime-unverified`다. 신규 마이그레이션은 불필요했다(스키마가 이미 멀티 워크스페이스 전제 — ADR-0117 Context 1).

## MOMO-564 공개용 README + SECURITY.md (#656, 2026-07-23)

- 공개 README를 영어 우선 단일본으로 재작성해 단일 이미지 5분 설치, Dawn 비경유 신뢰 경계, RLS FORCE, 에이전트 온보딩 3경로, 공개 예제·Apache-2.0/DCO를 현재 구현에 맞춰 정리했다.
- SECURITY.md에 최신 v0.x 지원 정책, 비공개 Security Advisory 신고·응답 목표, 역할 분리/부트 가드/fail-closed/attestation 하드닝과 ADR-0004 시크릿 경계를 추가했다.

## MOMO-565 멀티바이너리 이미지 통합 (#681, 2026-07-23)

- `api/relay/worker/migrate/linkshort/web-assets`를 하나의 `ghcr.io/dawn-kim-official/momo` 이미지와 argv 서브커맨드로 통합했다. prod compose 토폴로지와 기존 migrate의 `set-owner/member-list/invite-create`, runtime-role 분기는 유지하며, 여섯 `MOMO_*_IMAGE` 별칭은 canonical `MOMO_IMAGE`로 수렴한다.
- publish workflow·digest/attestation·LICENSE/NOTICE·install/upgrade/preflight/rollback 상태를 단일 이미지 기준으로 갱신했다. 기존 집중 verifier Dockerfile은 공개 발행에서 제외하고, host-runtime과 신규 28240~28243 verifier가 통합 이미지를 소비한다.
- 정적 검증과 macOS Swift gate는 worker에서 수행한다. `swift:6.2-noble` 통합 이미지 실빌드 및 여섯 명령 Docker 기동은 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-563 공급망 실물 위생 (#655, 2026-07-23)

- prod install이 여섯 GHCR digest에 GitHub SLSA provenance 검증을 수행한다. 기본은 `gh` 부재·attestation 미발행을 이미지 키별로 경고하는 soft-fail이며, 릴리스 게이트는 `MOMO_ATTESTATION_POLICY=required`로 pull 전 fail-closed할 수 있다.
- prod/e2e compose 전 서비스에 조정 가능한 `mem_limit`과 janitor 관리 라벨을 추가하고 외부 tag-only 이미지를 registry digest로 고정했다. 정적 verifier는 Compose 표준 project 라벨 매칭·이 계약·두 prod env 템플릿 동기화를 검사하며, Docker compose 실제 기동·메모리 상한·attestation 실조회는 오케스트레이터 수행 전까지 `runtime-unverified`다.

## MOMO-562 관측 실물화 v0 (#677, 2026-07-23)

- API·OutboxRelay·AgentWorker·PushRelay에 공개 서비스 포트와 분리된 Prometheus text 0.0.4 `/metrics`를 추가했다. relay는 pending broadcast 최고 연령 게이지와 commit→publish histogram, worker는 budget trip counter와 mention enqueue→정상 terminal histogram, PushRelay는 닫힌 `code_class` 6값 APNs 실패 counter를 소유한다. 테넌트/콘텐츠/식별자 라벨은 없다.
- prod compose는 metrics 포트를 host/public network에 publish하지 않고 `--profile observability`일 때만 private Prometheus를 기동한다. Caddy의 API·앱 도메인 `/metrics`는 명시적으로 404이며 web-serving gate가 단정한다.
- MomoMetrics 3 tests와 API/relay/worker/PushRelay Swift build, verifier bash 정적 검증은 PASS했다. 28210~28213 Docker endpoint/profile verifier는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-560 day-2 운영 단일 진입 (#653, 2026-07-23)

- prod `momo-ops.sh`에 status/logs/기존 upgrade 래핑/backup-hint/member list/invite-create를 모았다. status 외 명령은 기존 prod preflight를 재사용해 placeholder를 fail-closed하고, 멤버·초대는 migrate 이미지의 env-only DB 경로로 실행하며 원본 초대 코드는 mode-0600 파일에만 1회 기록한다.
- 정적·mock operator 계약 검증은 PASS했다. 예약 포트 28220의 격리 PG18/migrate-image verifier는 준비했으며 실제 멤버 조회·초대 hash/audit Docker 왕복은 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-561 owner 부트스트랩 set-owner (#654, 2026-07-23)

- migrate 이미지에 env-only `set-owner` one-shot을 추가하고 install이 migration 직후 이를 자동 실행하도록 연결했다. bootstrap owner 정확성·이메일 검증·세션 폐기형 credential rotation을 한 트랜잭션으로 처리하며 upgrade는 기존 owner를 덮어쓰지 않는다.
- prod `.env.example`/`secrets.env.example`과 DEPLOY 런북에서 psql heredoc을 제거했다. 정적 설치/secret 비유입 검증은 worker가 수행하며, 28200 전용 Docker verifier는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## UXUI MOMO-558 Stop/Pause 클라이언트 표면 (#651, 2026-07-23)

- macOS run 카드·스트리밍 헤더·상세에 human cancel REST 기반 Stop과 `⌘.` 경로를 연결하고, 권한 있는 owner/admin·agent human owner의 멤버 인스펙터에 Pause 토글을 추가했다. `agent_run_cancelled`·`agent_paused`는 에이전트 발화가 아닌 시스템 라인으로 렌더한다.
- REST·ViewModel·권한·키보드 집중 테스트와 macOS Swift build가 PASS했다. light/dark 스냅샷 테스트 코드는 추가했지만 기준 PNG는 계약대로 기록하지 않았으며, 실서버 Stop/Pause 표면 E2E·Docker 게이트와 스냅샷 기준 기록은 오케스트레이터 확인 전까지 `runtime-unverified`다.

## MOMO-556 공급망 게이트 (#649, 2026-07-22)

- remote SwiftPM 의존성이 있는 9개 패키지 루트를 자동 탐색·resolve하고 전이 checkout LICENSE 원문을 판독해 permissive SPDX만 허용하며, copyleft 계열은 예외보다 먼저 fail-closed로 거부한다.
- `legal/THIRD_PARTY_NOTICES.md`의 SwiftPM 37종 표를 `--write`로 결정적 재생성하고 `--check` 드리프트 검사를 swift local gate에 편입했다. 격리 픽스처는 MIT와 SPDX OR/AND 통과, AGPL 주입 실패를 재현한다.
- Dependabot은 npm 3루트·Docker 2루트·GitHub Actions를 주간 감시하되 기존 workflow_dispatch-only 정책을 변경하지 않는다. Docker/verifier 게이트는 계약에 따라 오케스트레이터 인계(`runtime-unverified`)다.

## MOMO-554 prod RLS 실집행 태세 (#647, 2026-07-22)

- prod install/upgrade가 migration 전에 `momo_app`(NOBYPASSRLS)·`momo_relay`/`momo_worker`(BYPASSRLS)를 멱등 프로비저닝하고, compose의 API/migrate/relay/worker URL과 outbound webhook master key를 역할·키별로 분리한다. migration 037은 `plugin_registry`의 API 쓰기 권한을 회수한다.
- MomoServer strict 환경은 실제 DB `current_user=momo_app`·NOSUPERUSER·NOBYPASSRLS를 확인하지 못하면 기동을 거부한다. 서버 176 tests, prod preflight·install/upgrade 정적 verifier가 PASS했다.
- `scripts/verify_prod_rls_posture.sh`는 28170~28173에서 prod compose API RLS 0행·catalog 쓰기 거부·수퍼유저 URL fail-closed를 최종 단정한다. Docker 실런과 `runtime-db`/`internal-alpha` 회귀는 오케스트레이터 실행 전까지 `runtime-unverified`다.

## MOMO-555 local gate 하드닝 3종 (#648, 2026-07-22)

- 모든 local gate 프로파일과 선택적 pre-push 훅에 merge-base 이후 `origin/main`↔현재 브랜치 변경 파일 overlap 차단을 추가했다. 검토된 예외는 `MOMO_GATE_SKIP_SKEW=사유`만 허용하고 최종 evidence에 사유를 남긴다.
- `migrate.sh`의 psql 탐색 전과 local gate 정적 검사에서 정규화된 마이그레이션 번호 중복(`037`=`37`)을 거부한다. gate 로그·Markdown·run 전용 산출물은 종료 시 파일별 SHA-256 매니페스트로 고정한다.
- disjoint/overlap/override skew, 고유/중복 migration, 정상/변조 manifest 격리 셀프 테스트와 docs 프로파일이 PASS했다. Docker 런타임 변경은 없으며 전체 Swift 패키지 build도 통과했다(`make build`의 중첩 sandbox 제약 때문에 동일 명령을 `--disable-sandbox`로 수행).

## MOMO-557 휴먼 run 취소 + agent pause (#650, 2026-07-22)

- ADR-0132 D1·D2에 따라 활성 human 채널 멤버의 run 취소 REST를 추가했다. run 취소·pending agent_job/approval 무효화·감사·채널 시스템 라인이 한 tenant transaction에 기록되며, 연결 work_session ID는 원장/응답에 남기되 세션은 종료하지 않는다.
- migration 038의 `agent_profile.paused`와 owner/admin pause REST가 mention/work 신규 enqueue를 막고 시스템 라인으로 설명한다. AgentWorker는 실행 단계에서 cancelled SoT를 재확인하며 cancelled run의 durable agent 응답·상태 부활을 차단한다.
- server/worker build·unit 및 verifier 정적 검증은 worker가 수행한다. `scripts/verify_agent_run_cancel.sh`의 28184~28187 격리 Docker E2E는 momo-main 실행 전까지 `runtime-unverified`다.

## MOMO-559 agent interaction safety D3/D4/D5 (#652, 2026-07-22)

- agent가 다른 agent를 mention할 때 source run을 강제하고 `parent_run_id`와 `depth=parent+1`을 run input·job payload까지 전파한다. 사람 발화는 기존 root depth 0을 유지하며, 외부 A2A 카드 런타임에도 동일 D3 구조 가드를 적용한다.
- 내부 AgentWorker 경로에는 profile instructions보다 앞선 서버 권위 D4 publication preamble을 항상 삽입하고, adapter와 provider 최종 요청까지 전달되는 유닛·격리 verifier를 추가했다. 외부 A2A 카드 런타임에는 D4를 적용하지 않는다.
- G2 차단은 기존 원자적 run 실패·`agent.guard.tripped` 감사·broadcast 경로에 정확한 사람 개입 시스템 라인을 남긴다. 전체 Swift 패키지 build, server 176·AgentWorker 55·Hermes adapter 61 tests와 verifier 정적 검증은 PASS했으며, 28191~28194 격리 Docker verifier 실런은 오케스트레이터 수행 전까지 `runtime-unverified`다.

## UXUI MOMO-553 메모리 접근 허용 UI (#645, 2026-07-22)

- macOS 메모리 상세에 접근 허용 원장 목록, 활성 roster 기반 멤버·에이전트 피커, 기록을 보존하는 접근 회수 확인을 MOMO-549 GET/POST/DELETE 계약으로 연결했다. 회수 이력은 회색 `회수됨` 상태와 부여자·부여/회수 시각을 함께 표시한다.
- 관리자·멤버 범위 주체·에이전트 사람 소유자만 변경 제어를 보고, 그 외에는 읽기 전용 표면을 유지한다. 4xx 사유는 내부 계약 어휘 없이 한국어 인라인 카피로 매핑하며 loading/empty/error/offline 상태를 갖춘다.
- macOS 집중 로직·REST 테스트 8건과 고정 이름·날짜 기반 한국어 목록/부여 라이트·다크 스냅샷 4종을 추가했다. 인증된 실서버 부여→회수 UI 왕복은 momo-main 검수 전까지 `runtime-unverified`다.

## UXUI MOMO-550 에이전트 주소 온보딩 (#638, 2026-07-22)

- macOS 멤버 디렉터리와 워크스페이스 설정에 관리자용 에이전트 주소 입력→공개 능력·인증 방식 동의→등록 흐름을 연결했다. 서버 4xx 사유는 인라인으로 표시하고 카드 제공 인증정보 입력란은 두지 않는다.
- confirm 뒤 서버 명부를 다시 읽어 새 에이전트를 반영하며, 기존 roster의 `origin=card|local`을 주소로 추가/직접 생성 뱃지로 투영한다. 한국어 동의 화면 light/dark snapshot과 REST·오류·카피 집중 테스트, 디자인 프리플라이트 3종, 독립 design-review(Blocker 0), macOS Swift build가 PASS했다.
- 기준 `track/uxui`에 남아 있던 Memory Plane·멤버 lifecycle 병합 충돌 표식 6곳은 양 계약을 모두 보존해 최소 해소했다. 실서버 UI 왕복은 momo-main 검수 전까지 `runtime-unverified`다.
## UXUI MOMO-551 발신 이벤트 구독 설정 (#639, 2026-07-22)

- 채널 설정의 연동 탭에 워크스페이스 범위 발신 이벤트 구독을 연결했다. 목록은 이벤트 종류·URL·4종 상태·중지 사유를 표시하고, 생성·사용·중지·삭제를 MOMO-535 REST 계약으로 수행한다.
- 생성 응답의 HMAC 시크릿은 별도 일회성 화면에서만 표시·복사하며 목록 DTO와 분리했다. 화면 이탈·세션 변경 뒤에는 폐기하고 재조회하지 않으며 모든 관리 요청은 `no-store` 경계를 사용한다.
- macOS build, 모델·REST 집중 7 tests, 한국어 목록/일회성 시크릿 라이트·다크 snapshot 4종, design preflight 3종이 PASS했다. 인증된 실서버 owner/admin CRUD 왕복은 오케스트레이터 확인 전까지 `runtime-unverified`다. 트랙 기저에 커밋돼 있던 MOMO-529/525 충돌 마커는 양 기능을 보존하는 최소 합집합으로 해소했다.
## MOMO-549 memory visibility grant CRUD REST (#636, 2026-07-22)

- migration 027의 `memory_visibility_grant` 원장에 admin/member-scope subject/agent human owner 관리 GET·POST·DELETE를 가산했다. active human/agent grantee 검증, 회수 마킹·멱등 재회수, 부여/회수 audit, FORCE RLS와 OpenAPI를 동기화했다.
- `verify_memory_grant.sh`는 28160~28163 격리 포트에서 부여→030 검색/Context Packet 가시→회수→검색 비가시·재발급 `memory_refs` 제외, 권한·감사·RLS를 단정한다. Docker 실런은 오케스트레이터 수행 전까지 `runtime-unverified`다.

## MOMO-537 agent_profile 원장 + oort 네이티브 간편 생성 (#618, 2026-07-22)

- ADR-0131 Accepted를 정본화하고 migration 036(035는 진행 PR #625와 충돌 회피)에 `agent_profile` 복합 agent FK·FORCE RLS 원장을 추가했다. 관리자/agent human owner GET·PUT, 8KB instructions·credential-shaped field 거부, version 증가·audit와 기존 agent 생성 요청의 optional profile 동시 커밋을 OpenAPI에 반영했다.
- 528 mention 경로는 profile이 있을 때만 서버 정책 프리앰블→기존 시스템 지시→profile instructions를 packet/payload에 가산하고, 실제 grant∩enabled_tools만 투영한다. model_pref는 `workspace.settings.allowed_agent_models`와 기존 agent.model 안에서만 적용하며 불허 preference는 run당 audit 1회 후 무시한다. 기존 profile 없는 agent payload는 유지된다.
- 전체 Swift 패키지 build, 엔진 패키지 tests, server 171 tests(profile 집중 7 포함), OpenAPI YAML·verifier bash/ShellCheck는 PASS했다. `verify_agent_profile.sh`는 28150~28153 격리 포트에서 CRUD·owner/admin·RLS·packet·tool/model·mock Hermes 요청 덤프를 단정하며 Docker 실런과 `verify_context_packet.sh` 회귀는 오케스트레이터 수행 전까지 `runtime-unverified`다.

## MOMO-548 외부 provider 추출 동의 게이트 (#625, 2026-07-22)

- migration 035에 기존 memory enabled 정책과 별도인 워크스페이스 외부 provider 명시 동의(기본 false)를 추가했다. 서버 admin REST/OpenAPI는 동의·공유 provider trust 판정·최종 추출 허용 여부를 투영한다.
- AgentWorker 추출/임베딩은 external 미동의 시 원문 provider 호출을 건너뛰고 `memory.extraction.consent_required`를 워크스페이스당 1회 기록한다. local-mock과 loopback/사설 self-host는 현행 유지한다.
- 공유 trust 정책·worker 동의 판정 유닛과 Swift/OpenAPI 정적 게이트를 수행하며, Docker `verify_memory_plane.sh` 동의 전이·회귀는 오케스트레이터 인수 전까지 `runtime-unverified`다.
## MOMO-538 셀프호스트 eve 옵션 프로파일 (#619, 2026-07-22)

- dev/prod compose에 기본 비활성 `eve` profile을 추가했다. Node 24.4.1 digest, eve 0.27.0, Postgres world 5.0.0-beta.27을 고정하고 MOMO-534 채널 프리셋과 모든 자격증명은 read-only mount/env 경계로만 주입한다.
- `eve-db-roles`는 oort PostgreSQL 클러스터 안에 별도 `eve_world` DB와 NOBYPASSRLS role을 만들되 oort schema object 권한은 부여하지 않는다. `verify_eve_profile.sh`가 dev/prod profile off/on drift, 기본 서비스 불변, 28140~28142 포트 선점, eve health·프리셋 load 로그·world durable table·oort table 접근 거부를 단정한다.
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

## UXUI MOMO-552 메모리 주입 표시 (#640, 2026-07-22)

- macOS가 `agent_run.input.memory_delivery` 영수증을 fail-closed sidecar로 소비해 `injected=true`이고 `included_count>0`이며 저장 packet ID를 확인한 에이전트 응답·Work 실행 카드에만 "메모리 n건 반영" 메타 버튼을 표시하고, 기존 서빙 내역 인스펙터로 연결한다. 0건·미주입·malformed 영수증과 packet ID 없는 실행은 거짓 액션 없이 무표시다.
- macOS build와 집중 로직·REST 계약 테스트, 표시/무표시 라이트·다크 스냅샷 4장이 PASS했다. 시작점 `track/uxui`에 커밋돼 있던 충돌 마커 6개도 양쪽 protocol conformance를 보존해 정리했다.

## MOMO-534 eve/Cloudflare oort 채널 어댑터 2종 (#615, 2026-07-22)

- `examples/eve-momo-channel`은 eve 0.27.0 `defineChannel`/`routeAuth`/`send`/workspace·channel continuation token으로, `examples/cloudflare-agent-momo`는 permissive·audit 경계를 지키는 Agents SDK 0.3.10 인증 fetch로 기존 per-agent bearer gateway pending→event→complete 계약만 소비한다. 코어 서버·OpenAPI·스키마·루트 npm은 변경하지 않았다.
- 두 예제 TypeScript build와 Node 3 tests, `verify_momo_channel_adapter.sh` bash 문법이 PASS했다. 28120~28123 e2e stack의 mock eve pending→oort 메시지→완료 callback 실왕복은 오케스트레이터 실행 전까지, eve 실런타임은 beta 외부 런타임 설치 전까지 `runtime-unverified`다.

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
- macOS 420 tests, unsigned Xcode build, 디자인 pre-flight와 `macos-ui` local gate를 검증한다. 실제 서버에서 Codex↔oort 승인/제어/스레드 한 사이클은 C-2 수동 QA 전까지 `runtime-unverified`다. Xcode 배포 타깃의 App Sandbox는 별도 보안 승인 없이 변경하지 않았으며, 해당 빌드에서는 로컬 CLI 시작을 fail-closed하고 SwiftPM 개발 빌드에서만 PTY를 허용한다.
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

# oort — Phase 0 빌드 STATUS

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
- Codex JSONL은 bounded gateway status/partial로만 전달하고 최종 completion은 diff·변경 파일 수·exit·PR 링크 자리의 `momo.agent_work.result.v0` 카드다. 운영 공지 durable send 및 Codex/provider 자격증명 oort 유입 경로는 없다.
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

- Hermes platform `send()`는 명시적 oort `run_id`가 있는 실제 에이전트 최종 응답만 REST durable message로 허용한다. session reset, home-channel, `/resume`·`/sethome`, model/provider 등 run-unbound 운영 공지는 성공 처리 후 본문을 남기지 않는 로컬 이벤트 로그로만 기록한다. native gateway 최종 응답은 기존 `/gateway/complete` server-owned commit을 유지한다.
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

- `docs/adr/0004-codex-oauth-hermes-provider-boundary.md`를 추가해 Codex OAuth access/refresh token은 external runtime provider 소유이고 oort app/API/DB/Context Packet/Memory/diagnostics/local gate가 직접 보관하지 않는다는 credential boundary를 정본화했다.
- `scripts/verify_external_agent_provider.sh`는 credentialed smoke에 필요한 oort-side env를 `AGENT_PROVIDER_MODE=external-hermes`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `AGENT_MODEL`로 명확히 출력하고, 알려진 Codex/OpenAI OAuth token env var가 oort smoke process에 있으면 fail-fast한다. secret 없는 기본 경로는 계속 safe skip/pass로 `runtime-unverified(external provider credentials)` evidence를 남긴다.
- 실제 Codex OAuth-backed provider credentialed PASS는 provider host secret이 있는 환경에서만 닫을 수 있으므로 계속 `runtime-unverified(external provider credentials)`다. 검증: `scripts/local_gate.sh --profile external-agent-provider` PASS(no-credential explicit skip), `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` 대상.

## 0-4b-3. MOMO-238 Local Hermes GPT Provider Loopback Contract (2026-07-01)

- `docs/external-agent-provider/local-hermes-gpt.md`를 추가해 local Hermes + GPT provider 개발 루프는 `MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 AGENT_PROVIDER_MODE=external-hermes` opt-in일 때만 `http://127.0.0.1:<port>/v1` 또는 `http://localhost:<port>/v1`를 허용하도록 정리했다.
- MomoServer/AgentWorker/verifier가 non-loopback `http://...`, staging/prod/internal-host loopback, `mock-hermes`, placeholder Hermes bearer, Codex/OpenAI OAuth token/API key env를 fail-fast 처리한다. GPT/OpenAI credential은 Hermes local process/provider host 소유이며 oort app/API/DB/evidence에는 들어오지 않는다.
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

- `docs/external-agent-provider/local-hermes-codex-oauth-setup.md`와 placeholder-only `local-hermes-provider.env.example`를 추가해 사용자가 local Hermes-compatible provider에서 Codex/OpenAI OAuth 또는 provider token 설정을 직접 수행하고, oort는 loopback `HERMES_BASE_URL` + Hermes-facing bearer만 받아 검증하는 경계를 고정했다.
- `scripts/verify_local_hermes_credentialed_smoke.sh`를 추가해 기본 실행은 `NEEDS_USER_CREDENTIAL` evidence로 안전하게 종료하고, out-of-repo env 파일 또는 inline oort-facing endpoint/key가 있으면 기존 external-provider verifier로 위임해 `@hermes` credentialed roundtrip을 검증한다. 알려진 Codex/OpenAI OAuth/API key env가 oort smoke process에 있으면 fail-fast한다.
- macOS Alpha Command Center에 `Provider Setup` 상태, `Connect real local Hermes` 체크리스트, provider credential boundary capability를 추가했다. 실제 provider login/token 입력은 사람이 provider에서 수행해야 하며, 이 환경의 real credentialed provider PASS는 사용자가 런타임을 띄운 뒤 별도 evidence로 닫는다.
- 검증: `scripts/local_gate.sh --profile external-agent-provider` PASS(`NEEDS_USER_CREDENTIAL` no-secret path), `scripts/local_gate.sh --profile runtime-agent` PASS(mock/local Hermes bridge), `scripts/local_gate.sh --profile macos-ui` PASS, `LOCAL_GATE_LAUNCH_UI=1 scripts/verify_macos_real_backend_ui.sh` PASS(window_count=1). 실제 Codex/OAuth credentialed provider PASS는 사용자가 provider 로그인/env를 준비한 뒤 `scripts/verify_local_hermes_credentialed_smoke.sh`로 닫는다.

## 0-4b-6a. LSA-005 Local Hermes operator helper (2026-07-07)

- MOMO-257의 credentialed Hermes boundary/runbook/verifier는 존재하지만, 실제 1인 dogfood 사용자는 out-of-repo env 생성, placeholder 확인, 금지된 OpenAI/Codex provider credential env 확인, smoke 실행 순서를 기억해야 했다. 이 후속은 사용자가 provider login 이후 oort에서 무엇을 해야 하는지 CLI가 바로 안내하게 만든다.
- `scripts/momo`에 `hermes`/`hermes-status`, `hermes-init`, `hermes-smoke` 명령을 추가했다. `hermes-init`은 `~/.momo/local-hermes-provider.env`를 safe template에서 만들고 `chmod 600`을 적용한다. `hermes`는 env file path, file mode, provider mode/model, query/fragment가 제거된 endpoint label, Hermes-facing bearer configured 여부, 현재 shell의 금지된 OpenAI/Codex credential env 존재 여부, local MomoServer `/v1/agent-runtime/status` 요약을 보여준다. secret 값은 출력하지 않는다.
- 검증: `bash -n scripts/momo` PASS. `/private/tmp` 임시 env로 `scripts/momo hermes-init` → `scripts/momo hermes`가 placeholder를 secret 없이 표시하고, `OPENAI_API_KEY`가 현재 shell에 있을 때 boundary FAIL을 표시하는 것을 확인했다. 실제 credentialed provider PASS는 사용자가 provider login/env를 준비한 뒤 `scripts/momo hermes-smoke`로 닫는다.

## 0-4b-6b. MOMO-325 Hermes Gateway Native Platform Integration v1 (2026-07-07)

- AgentWorker SSE 경로를 유지하면서, `AGENT_GATEWAY_MODE=gateway`일 때 Hermes gateway가 oort를 Slack/Telegram-style messaging platform으로 보고 `agent.job` realtime event를 받아 처리하는 native path를 추가했다. `AgentWorker`는 `outbox.method='gateway'` job을 claim하지 않으며, final response/usage/audit는 gateway callback을 받은 MomoServer가 REST→Postgres→outbox 경로로만 기록한다.
- 새 public callback route는 `POST /v1/workspaces/:workspace/agent-runs/:run/gateway/events`와 `/gateway/complete`이며, `X-Momo-Agent-Gateway-Secret` 없이는 401 fail-closed다. Gateway completion은 durable channel message, `usage_ledger`, `audit_log(agent.gateway.*)`, channel broadcast outbox, gateway job `done`을 같은 DB transaction에서 정리한다.
- `adapters/hermes/PLUGIN.yaml`, `adapter.py`, `momo_adapter.py`를 최신 Hermes plugin path에 맞춰 정렬하고 `register(ctx)`/legacy `register_platform`을 모두 제공한다. `scripts/momo hermes-gateway-init/status/smoke`와 `scripts/verify_hermes_gateway_adapter.sh`는 local pairing env, status check, mock gateway harness를 제공한다.
- 검증: `swift build --package-path server` PASS, `swift build --package-path workers/AgentWorker` PASS, `python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS, `scripts/verify_hermes_gateway_adapter.sh` PASS(mock gateway; `@hermes`→`agent_run`→`agent_job(method=gateway)`→`agent.job` outbox→secret 401 guard→gateway callbacks→durable message/usage/audit/job done). 실제 Hermes gateway CLI/plugin load와 provider side effect는 `runtime-unverified(real hermes gateway missing)`로 남는다.

## 0-4b-6c. MOMO-326 Real Hermes Gateway Credentialed Smoke Prep (2026-07-07)

- 실제 Hermes gateway 런타임을 대상으로 한 설치/플러그인/credentialed smoke 레이어를 추가했다. `scripts/momo hermes-gateway-install-plugin`은 `adapters/hermes/`를 로컬 Hermes plugin directory(`$HERMES_HOME/plugins/momo`)에 symlink/copy하고, `scripts/momo hermes-gateway-smoke --real [--trigger]`는 Hermes CLI, plugin load files, 사용자 provider OAuth/login marker, oort gateway-mode `/health`, `@hermes` same-channel response를 단계별 evidence로 분리한다.
- `adapters/hermes/plugin.yaml`을 Hermes 공식 platform manifest 형태(`kind: platform`, `requires_env`, `optional_env`)로 정렬했고, `momo_adapter.py`는 최신 `gateway.platforms.base.BasePlatformAdapter(config, platform)` 경로와 legacy registry를 모두 지원한다. MOMO-338에서 operator login을 제거하고 per-agent bearer로 private `agentwork:ws<workspace>.<agentMember>`를 구독하도록 대체했다.
- 검증: `python3 -m py_compile adapters/hermes/momo_adapter.py adapters/hermes/adapter.py` PASS, `python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS, `bash -n scripts/momo scripts/verify_hermes_gateway_real_smoke.sh` PASS, `scripts/momo hermes-gateway-smoke --real` PASS with evidence state `NEEDS_USER_INSTALL`, `scripts/local_gate.sh --profile docs` PASS, `scripts/local_gate.sh --profile runtime-agent` PASS (`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-runtime-agent-20260707T115936Z-pid70974-ns1783425576779580000-wt9a510db2fbf3-ra293c905ef49.md`). 이 머신에는 아직 Hermes CLI가 없어 실제 provider OAuth 및 `@hermes` real gateway roundtrip은 `runtime-unverified(real hermes gateway missing; user install/login required)`로 남는다.

## 0-4b-6d. MOMO-327 Hermes v0.18 plugin load compatibility (2026-07-07)

- 실제 Hermes Agent v0.18 CLI-only 설치 후 user-installed directory plugin은 `~/.hermes/plugins/momo` 파일 링크만으로는 로드되지 않고 `~/.hermes/config.yaml`의 `plugins.enabled`에 `momo`가 있어야 함을 확인했다. `scripts/momo hermes-gateway-install-plugin`이 symlink/copy 후 config enable까지 수행하고, `scripts/momo hermes-gateway-status`가 plugin enabled 여부를 표시하도록 보강했다.
- Hermes v0.18 `BasePlatformAdapter`가 `get_chat_info(chat_id)`를 필수 추상 메서드로 요구해 oort adapter construction이 실패하던 문제를 수정했다. `MomoAdapter.get_chat_info`는 로그인 후 oort REST channel list에서 이름/타입을 조회하고, gateway boot/degraded smoke에서는 env/default fallback으로 fail-open 대신 platform construction을 유지한다.
- 검증: `python3 -m py_compile adapters/hermes/__init__.py adapters/hermes/momo_adapter.py adapters/hermes/adapter.py adapters/hermes/tests/test_momo_adapter_contract.py` PASS, `python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS(11 tests), `bash -n scripts/momo` PASS, `scripts/momo hermes-gateway-install-plugin && scripts/momo hermes-gateway-status` PASS(`plugin enabled: yes`, oort server reachable), `scripts/momo hermes-gateway-smoke --real` PASS with evidence state `NEEDS_PROVIDER_LOGIN`(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-hermes-gateway-real/20260707T150741Z/summary.md`). 실제 provider OAuth 및 `@hermes` real gateway roundtrip은 사용자가 Hermes/provider login을 완료한 뒤 닫는다.

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
- `local_alpha_runner`가 gateway mode/secret을 로드·export·redacted summary 기록·MomoServer env 주입까지 전달하도록 수정했다. provider OAuth/Codex/OpenAI token은 여전히 oort env에 전달하지 않고, 이 secret은 oort↔Hermes gateway callback 인증용이다.
- 검증: `bash -n scripts/local_alpha_runner.sh` 대상. 실제 operator는 `scripts/momo stop-stack` 후 `AGENT_GATEWAY_MODE=gateway AGENT_GATEWAY_SECRET="$MOMO_AGENT_GATEWAY_SECRET" scripts/momo up`를 다시 실행하면 `agentRuntime.mode=gateway`를 확인할 수 있어야 한다.

## 0-4b-6g. MOMO-330 Agent runtime status gateway delivery hotfix (2026-07-08)

- MOMO-329 후 MomoServer 실행 env에는 `AGENT_GATEWAY_MODE=gateway`가 들어갔지만, `/health`와 `/v1/agent-runtime/status`가 `AgentProviderConfig`만 반환해 실제 gateway delivery path를 `local-mock`처럼 보이게 했다. 이는 real Hermes gateway 연결 단계에서 운영자가 잘못된 경로를 보고 있다고 판단하게 만드는 상태 표시 버그다.
- `Config.agentRuntimeStatusResponse()`를 추가해 gateway mode에서는 `mode=gateway`, `endpointLabel=Hermes gateway platform adapter`, gateway callback secret configured/degraded 상태를 반환하도록 정리했다. worker/direct provider mode에서는 기존 provider status를 그대로 유지한다.
- 검증: `swift test --package-path server --filter MomoServerTests/testAgentRuntimeStatusReportsGatewayDeliveryModeWhenEnabled` PASS, `swift test --package-path clients/macOS --filter MomoMacTests/testRESTBackendLoadsGatewayRuntimeStatus` PASS, `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-docs-20260707T162918Z-pid25103-ns1783441758419039000-wt9a510db2fbf3-rb493e10783f9.md`). 실제 gateway roundtrip은 사용자가 Hermes gateway 프로세스를 켠 뒤 `MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger`로 닫는다.

## 0-4b-6h. MOMO-331 Hermes adapter Centrifugo ping/pong hotfix (2026-07-08)

- 실제 `hermes gateway run`에서 oort platform adapter가 연결되고 `Gateway running with 1 platform(s)`까지 갔지만, 잠시 후 realtime listen loop가 Centrifugo close code `3012 no pong`으로 종료됐다. 원인은 adapter가 Centrifugo JSON protocol heartbeat frame을 push가 아니라는 이유로 무시해 server-side heartbeat에 응답하지 못한 것이다.
- `MomoAdapter._listen_loop()`가 빈 heartbeat frame에는 빈 pong command를, 명시적 `ping` frame에는 `{"pong": {}}`를 보내도록 수정했다. connect/subscribe ack와 publish push 처리는 그대로 유지한다.
- 검증: `python3 -m py_compile adapters/hermes/momo_adapter.py && python3 adapters/hermes/tests/test_momo_adapter_contract.py` PASS(12 tests), `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-docs-20260708T004604Z-pid62511-ns1783471564069844000-wt9a510db2fbf3-r90750a762add.md`). 실제 gateway roundtrip도 `MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger` PASS(`same-channel Hermes gateway response observed`, evidence `/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-hermes-gateway-real/20260708T005622Z/summary.md`).

## 0-4b-6i. MOMO-333 Local alpha Hermes gateway agent stream subscribe unblock (2026-07-08)

- 당시 실제 앱에서 `@hermes hi`를 보냈을 때 `message`와 `agent_job(method=gateway)` 생성, OutboxRelay publish까지는 성공했지만 stale local-alpha Centrifugo config 때문에 구독이 거부됐다. MOMO-333에서 최초 복구했고, MOMO-338은 private job을 `agentwork:ws<workspace>.<agentMember>`로 분리해 실제 agent-bearer WebSocket 수신까지 검증한다.
- `scripts/local_alpha_runner.sh`의 generated Centrifugo config를 `infra/centrifugo.json`과 맞춰 `agent` namespace도 `subscribe_proxy_enabled=true`와 workspace-qualified `channel_regex`를 갖도록 수정했다. `docs/RUN.md`와 Hermes gateway native platform runbook에는 local alpha에서도 `agent:` stream proxy가 필수라는 진단 기준을 추가했다.
- 검증: generated config 확인(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T/momo-local-alpha/20260708T033819Z/centrifugo.local-alpha.json`: `agent.subscribe_proxy_enabled=true`, regex `^ws...\\....$`), 서버 `GET /v1/agent-runtime/status` = `mode=gateway`, `docker logs momo240_72373-centrifugo-1`에서 `namespace=agent subscribe proxy enabled` 및 `agent:ws... permission denied` 없음. 사용자-owned Hermes gateway(`openai-codex gpt-5.5`, provider token은 oort에 저장/로그하지 않음) 연결 상태에서 `MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-hermes-gateway-real/20260708T034009Z/summary.md`). DB evidence: `outbox(kind=agent_job, method=gateway)=done`, `agent_run.status=succeeded`, `audit_log`에 `agent.gateway.status/completed`, `usage_ledger` 1건, Hermes final response가 같은 channel `message.seq=4`로 기록됨. 정적 gate: `LOCAL_GATE_ALLOW_DIRTY=1 scripts/local_gate.sh --profile docs` PASS(`/var/folders/zj/v6yd5tj104l14xhlpn1bx1r80000gn/T//momo-local-gate/local-gate-docs-20260708T034450Z-pid17038-ns1783482290079413000-wt9a510db2fbf3-r5e9aa29fc209.md`).

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
- 앱은 pairing manifest와 invite code를 생성하고 copy/export affordance를 제공한다. manifest에는 oort-facing API/workspace/channel metadata, helper command, `$HOME/.momo/hermes-gateway.env:MOMO_AGENT_GATEWAY_SECRET` secret source만 들어가며 Codex/OpenAI OAuth token, refresh token, provider API key 값은 포함하지 않는다.
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

- Hermes agent / internkim(Kim Intern) / openclaw를 기준으로 oort가 agent runtime의 단순 채널 어댑터가 아니라 context, memory, cache, approval, audit, cost를 소유하는 agent host가 되어야 한다는 결정을 문서화했다.
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

- Inbound MCP Server v0 정본을 `research/11-agent-runtime/09-inbound-mcp-server-v0.md`에 추가하고, 외부 Claude/Codex/Cursor류 host가 oort를 쓰는 최소 surface를 `momo.search_messages`, `momo.fetch_thread`, `momo.post_message`, `momo.create_tool_call`로 고정했다.
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
- 실제 Hermes gateway plugin load 및 live oort+Centrifugo+Postgres platform-adapter e2e는 여전히 `runtime-unverified` 후속 범위다.


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

- Paca/OpenHands/Linear/Rovo/GitHub Copilot/Slack/MCP/A2A 흐름을 기준으로 oort의 포지션을 "agent execution ledger가 있는 messenger / enterprise agent host / protocol surface"로 문서화했다. 정본: `research/12-agentic-work-os/01-agentic-work-os-market-analysis.md`.
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

- `research/12-agentic-work-os/03-agent-host-positioning.md`를 추가해 oort 제품 문장을 **channel timeline execution ledger** 중심으로 고정했다. Slack/Discord/Mattermost/Paca/OpenHands 대비 1페이지 비교와 website/README/sales deck reusable copy block을 포함한다.
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

- MOMO-122 스펙(`research/11-agent-runtime/12-google-workspace-connector-v0.md`) 정정: §4.2 scope 표에서 `drive.metadata.readonly`가 **restricted-class**임을 명기(기존 표는 가벼운 metadata tier처럼 읽혔음 — `drive.file`만 non-sensitive), self-hosted 배포는 배포 조직 소유 GCP 프로젝트 + OAuth consent **Internal**(같은 Workspace 조직) 전제에서 Google 검증/CASA가 면제됨을 배포 전제로 반영. §2 "no full Drive mirrors" 규칙에 **oort 관리 공유 드라이브 한정 revocable 파생 인덱스**(임베딩+청크, 행마다 permission snapshot version, tombstone 시 삭제) carve-out을 추가 — 사용자 개인 Drive(`drive.file` 선택 파일)는 기존대로 excerpt-only.
- MOMO-123 스펙(`13-google-workspace-enterprise-admin-v0.md`)에 `service_account_boundary.boundary_kind` 도입: 기존 DWD 경로는 `dwd_delegation`(필드 부재 시 기본으로 읽음 — backward compatible), 제3모드 `shared_drive_member` 추가(**DWD 아님** — SA가 자기 자신으로서 oort 관리 공유 드라이브 1개의 Content Manager 멤버로만 동작, 사칭/delegated token 금지, Admin console API Controls 등록 불필요). §3 install mode 표·§5 scope inventory(`drive.file` SA-as-itself)·§6 boundary JSON/규칙·revoke 경로를 함께 갱신하고, fixtures 3종(`admin_install_scope_inventory`/`dwd_delegated_context_projection`/`audit_export_revoke_flow`)에 `boundary_kind` 필드 + `shared_drive_member` boundary 예시를 additive로 확장(jq green).
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

- prod compose를 변경하지 않고 소비하는 `install.sh`/`upgrade.sh`를 추가했다. 네 oort 이미지의 per-service sha256 digest, 기존 strict preflight, one-shot migrate, 순차 재기동, mode-0600 이전 이미지 상태와 app-only rollback(DB migration 전방 전용)을 강제하며 시크릿 값은 출력하지 않는다.
- 정적 인자/rollback 매트릭스와 shellcheck/bash syntax는 worker에서 PASS. Docker가 필요한 `staging-smoke` compose render와 실제 VPS DNS/TLS·registry pull·SOPS·pgBackRest·Hermes는 오케스트레이터/실호스트 검증 대기(`runtime-unverified(public host)`).
