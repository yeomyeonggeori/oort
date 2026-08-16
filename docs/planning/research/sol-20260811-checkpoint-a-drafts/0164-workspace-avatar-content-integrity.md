# ADR-0164: 워크스페이스 아바타 콘텐츠 무결성·회수 계약

- Status: **Proposed**
- Date: 2026-08-11
- 관련: ADR-0161 D5(워크스페이스 아바타), ADR-0151(Drive 업로드/인가 프록시), ADR-0128(멤버십·권한 수명주기), `docs/planning/research/2026-08-11-server-security-selfhost-review.md` W-H1·W-M1·W-M2·W-M4·W-M5·W-M6
- 승인 전 경계: 본 ADR이 Accepted 되기 전에는 `immutable` 보장 확대나 스키마/API 구현을 발주하지 않는다.

## Context

ADR-0161은 “Drive로 업로드하고 인가 프록시로 읽으며, 교체 때 URL이 바뀌는 캐시 가능한 아바타”를 선택했다. 구현 실측에서는 그 약속을 아직 만족하지 못한다.

- owner/admin 검사를 Drive 왕복 **전에만** 한다. 그 사이 self-leave·강등이 먼저 끝나도 최종 트랜잭션이 pending 행·audit·`workspace.avatar_media_id`를 커밋할 수 있다(W-H1).
- 완료 때 비교한 5MiB/mime은 읽기 때 고정되지 않는다. Drive의 live 객체가 바뀌면 attachment용 100MiB 상한과 live mime으로 같은 origin에서 다른 바이트가 서비스된다(W-M1).
- `?v=`를 검증하지 않고 media UUID를 버전처럼 쓴다. 임의 `v`도 1년 `immutable` 응답을 받고, pending id를 아는 업로더가 선캐시할 수 있다(W-M2).
- 교체된 객체와 abandoned pending을 회수하는 실행체가 없고(W-M4), uploader·workspace pointer의 tenant 일치가 단일-column FK라 DB 불변식이 아니다(W-M5). 세 avatar operation과 `Workspace.avatarUrl`도 OpenAPI에 없다(W-M6).

## Options

1. **현행 유지 + `immutable` 제거**: `no-store` 또는 짧은 ETag 재검증으로 거짓 캐시 약속만 없앤다. 가장 작지만 Drive 변조·TOCTOU·회수·tenant FK는 남는다.
2. **SHA-256 결속 + 보수적 raster 프록시(권고)**: 완료와 읽기에서 5MiB/mime/바이트를 검증하고, digest가 결속된 URL만 장기 캐시한다. 기존 Drive 비대칭을 유지하면서 약속을 실제 보장한다.
3. **서버가 decode/re-encode 후 별도 object store/CDN에 저장**: 가장 강한 정규화·격리지만 ADR-0151의 Drive v0 결정과 “두 번째 저장 백엔드 금지”를 재개봉한다. v0에서 기각한다.

## Decision

### D1. 외부 왕복 뒤 최종 트랜잭션에서 다시 인가하고 직렬화한다

`create_upload`과 `complete` 모두 Drive 왕복 뒤 열리는 **최종 tenant transaction**의 첫 단계에서 워크스페이스 membership-mutation lock을 잡고, 요청자가 여전히 active human owner/admin인지 다시 읽는다. self-leave·역할 변경·정지/추방도 같은 workspace-scoped lock을 사용한다. 따라서 lock 순서상 owner/admin capability 상실이 먼저면 avatar pointer·성공 business audit은 0이고, avatar commit이 먼저면 그 완료 뒤 capability 변경이 진행된다. owner↔admin처럼 capability가 유지되는 전이는 final 재검사를 통과한다. pending/media row도 같은 트랜잭션에서 잠그고 상태·uploader·Drive id를 재검사한다. `platform:read`만으로 tenant avatar를 바꾸는 override는 본 ADR이 승인하지 않는다.

Drive보다 먼저 짧은 tenant transaction에서 재인가하고 `status='allocating'` cleanup intent/media row를 UUID로 만든다. 이 row는 immutable `uploader_membership_id_snapshot`, `uploader_authority_episode_id_snapshot`, `uploader_avatar_operator_generation_snapshot`을 저장하고 episode snapshot은 same-tenant ledger에 FK로 결속한다. `workspace_membership.avatar_operator_generation`은 owner/admin capability를 잃는 전이에서만 정확히 +1하고 owner↔admin·member→admin/owner에서는 바뀌지 않는다. final create/complete는 current membership ID+active episode+avatar-operator generation이 세 snapshot과 모두 같고 요청자가 active human owner/admin인지 확인한다. current membership을 nullable child FK로 두거나 delete 때 cascade하지 않는다. Drive 객체에는 서버 correlation만 넣고 사용자 filename은 DB에만 둔다. 네트워크 왕복 동안 DB lock을 쥐지 않는다. 성공 응답의 Drive id는 최종 transaction에서 결속한다. timeout처럼 **그 요청 자신의 한 pre-intent**에서 Drive 성공 여부가 모호하거나 최종 재인가가 실패하면 그 한 row를 `abandoned`로 닫는다. 반면 leave/suspend/remove와 owner/admin role 상실은 child를 bulk UPDATE하지 않는다. authority episode 또는 `avatar_operator_generation` 회전+schema-constant cursor head만 원자 commit하고 worker가 해당 snapshot의 `allocating|pending`을 최대 500/page로 `abandoned`+GC job materialize한다. complete는 cursor 전에도 즉시 실패하므로 demotion→cleanup 정지→재승격에도 과거 upload가 부활하지 않고, capability를 계속 가진 owner↔admin 변경은 진행 중 upload를 불필요하게 닫지 않는다.

### D2. `immutable`은 실제 SHA-256과 안전 raster에만 허용한다

- 허용 형식은 `image/png`, `image/jpeg`, `image/webp` 세 가지다. SVG·GIF·animated WebP와 기타 `image/*`는 거절한다. 요청 mime, Drive live mime, signature/decode 판정이 모두 같아야 한다.
- decode는 단일 frame, width/height 각각 최대 4096px, total pixels 최대 16,777,216로 제한하고 decoder memory·CPU budget을 둔다. encoded 5MiB만으로 압축 해제 폭탄을 안전하다고 보지 않는다.
- 5MiB 상한은 요청, complete의 live metadata·실제 바이트, 모든 content read에서 각각 적용한다. 읽기는 최대 `5MiB + 1`까지만 받아 응답 전 검증하며, metadata 누락·불일치·초과·digest 불일치 때 **본문과 cache header 없이 fail-closed** 한다.
- complete가 검증한 실제 바이트의 SHA-256을 DB에 저장한다. `Workspace.avatarUrl`은 `/v1/workspaces/{ws}/avatar/content?v={sha256-hex}`이고, handler는 `v`가 현재 complete row의 digest와 정확히 일치할 때만 그 row를 읽는다. 누락·형식 오류·다른 digest는 content를 반환하지 않는다.
- 읽기 때 live metadata와 capped body를 다시 검증하고 SHA-256이 DB 값과 같을 때만 `Content-Type`을 저장된 allowlist 값으로 반환한다. 성공 응답만 `ETag`(digest), `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=31536000, immutable`을 갖는다.

### D3. 교체·실패 객체는 durable GC와 audit로 닫는다

새 complete row와 pointer 교체는 한 트랜잭션이다. 그 트랜잭션이 기존 current row를 단조 상태 `superseded`로 바꾸고 `old_media_id`, `new_media_id`, digest를 audit에 기록하며 이전 객체의 GC 작업을 durable queue에 넣는다. media 상태는 `allocating→pending→complete→superseded→deleting→deleted` 또는 `allocating/pending→failed|abandoned→deleting→deleted`만 허용한다. API는 `superseded/deleting/deleted` media를 다시 current로 붙일 수 없고, DB의 deferrable constraint trigger(또는 동등한 composite state FK)가 workspace pointer는 same-tenant `complete` row만 가리키게 한다.

외부 Drive 삭제 직전 worker는 tenant transaction에서 workspace+media row를 잠근다. current면 작업을 no-op/requeue하고, noncurrent terminal row면 `deleting`으로 원자 전이해 commit한다. `deleting`은 다시 pointer가 될 수 없으므로 lock을 푼 뒤 Drive delete와 경합해도 current bytes를 지우지 않는다. delete는 retry/backoff·멱등이며 성공/최종실패 audit를 남긴다. TTL을 넘긴 allocating/pending/failed/abandoned와 correlation-tagged orphan도 같은 reconciler가 회수한다.

실행체는 전용 **NOBYPASSRLS `momo-media-gc`**다. 신규 queue는 `workspace_id`, RLS FORCE, same-tenant composite FK와 정본 RLS 등록을 갖는다. 전 테넌트 discovery는 raw table SELECT나 새 BYPASS role이 아니라 `search_path=''`, 고정 projection·batch size·`SKIP LOCKED`만 허용하는 좁은 `SECURITY DEFINER claim_avatar_gc_batch` 함수로 수행한다. 함수 EXECUTE는 이 role에만 주고, worker는 반환된 각 workspace마다 `SET LOCAL app.workspace_id` tenant transaction으로 상태를 재검사·settle한다. 이 예외 함수와 Drive delete credential의 배포 topology가 함께 승인되지 않으면 GC goal은 착수하지 않는다.

### D4. 테넌트 일치는 DB와 OpenAPI 모두의 계약이다

`workspace_avatar_media`는 `(workspace_id, id)`를 UNIQUE FK target으로 제공한다. `(workspace_id, uploader_member_id) → member(workspace_id, id)`, immutable `(workspace_id, uploader_authority_episode_id_snapshot) → workspace_authority_episode(workspace_id,id)`, `(workspace.id, workspace.avatar_media_id) → workspace_avatar_media(workspace_id, id)` composite FK로 BYPASSRLS 경로에서도 cross-tenant uploader/episode/pointer를 거부한다. membership row snapshot은 삭제 뒤 감사용 값이고 final transition query가 current `workspace_membership.id+authority_episode_id`와 두 snapshot의 일치를 강제한다. membership delete cascade/update는 0이다. 모든 avatar path·DTO·오류·cache header와 `Workspace.avatarUrl`은 `docs/api/openapi.yaml`에 성문화하고 runtime route와 drift gate로 비교한다.

## Consequences

- (+) URL이 digest에 결속되어 pending 선캐시와 “같은 URL, 다른 바이트”가 불가능해진다.
- (+) 권한 회수와 avatar commit의 순서가 하나의 lock 계약으로 결정되고, 교체/유기 객체가 추적 가능한 수명주기를 갖는다.
- (+) RLS뿐 아니라 FK가 tenant 오염을 막고, 공개 API가 실제 runtime과 일치한다.
- (-) complete와 read가 최대 5MiB를 검증·해시하므로 Drive I/O와 메모리/CPU가 늘어난다. digest 검증 없이 더 싼 CDN 직결은 v0에서 허용하지 않는다.
- (-) 오래 캐시된 과거 아바타는 클라이언트 캐시에 남을 수 있다. 다만 새 DTO는 새 digest URL을 내며 서버는 과거 URL을 새 바이트로 재사용하지 않는다.

## Schema / API impact

- **Serialized expand:** 적용된 migration을 고치지 않고 goal별 새 번호를 순차 예약한다. current-capability floor는 기존 `pending`을 terminalize할 최소 `abandoned` 상태와 `workspace_id`·RLS FORCE를 가진 durable cleanup-intent queue/enqueue primitive를 먼저 추가한다. avatar security floor는 그 queue를 재사용해 `allocating`과 immutable membership/authority-episode snapshots을 추가하고 새 row에 persistent episode FK를 필수화한다. content expand는 nullable `content_sha256 bytea`+pixel/frame metadata, dormant legacy-writer contract mode/trigger와 **기본 off인 bounded/resumable backfill 도구**를, GC worker goal은 기존 queue의 제한 claim function·NOBYPASS consumer를, tenant-integrity goal은 사전 orphan 감사 뒤 D4의 composite UNIQUE/FK를 각각 forward migration으로 추가한다. generation-2 writer는 새 complete부터 digest/metadata를 채우고, generation-2 reader는 digest URL과 legacy UUID URL을 dual-read한다. legacy `v`도 **current media UUID와 정확히 일치할 때만** 읽고, NULL-digest/legacy URL에는 `immutable`을 절대 주지 않으며 `private, no-store`로 capped live 검증한다. 이 단계의 canonical `Workspace.avatarUrl` output은 아직 legacy UUID다.
- **Writer/reader fence:** 모든 API/avatar writer와 reader를 generation 2로 교체하고 old instance·background lease 0을 확인한다. DB trigger/contract mode는 그 뒤 legacy writer가 NULL digest complete를 새로 만드는 것을 fail-closed하고, old binary rollback은 금지한다. rollback은 generation-2 binary의 digest output flag만 내린다.
- **Backfill/cutover:** current complete 행을 dormant tool로 Drive live metadata+최대 `5MiB+1` body까지 다시 검증해 digest/pixel metadata를 채운다. 검증 실패·객체 부재는 UUID URL을 계속 서비스하지 않고 avatar를 unavailable로 표면화해 운영 보수 대상으로 보낸다. noncurrent legacy `complete` 행은 GC worker가 `superseded`로 정규화하고 회수 queue에 넣어 current가 아닌 NULL-digest complete를 남기지 않는다. current NULL-digest 0, noncurrent complete 0과 writer fence를 증명한 뒤에만 canonical URL output을 SHA-256으로 flip한다. 기존 complete 행은 이 검증/정규화 전 `immutable` URL을 발급하지 않는다.
- **Soak/contract:** digest output과 rollback flag를 정한 soak 기간 동안 관측한 뒤 별도 goal/PR의 forward migration으로 모든 `status='complete'` 행의 digest NOT NULL, allowlist mime/5MiB/단조 status constraint를 `NOT VALID → VALIDATE`한다. D4의 pointer/tenant constraint는 tenant-integrity goal이 소유한다. contract goal은 GC landing과 historical normalization 없이 backfill/cutover PR에 미리 섞지 않는다.
- 기존 세 경로의 shape는 유지한다: `POST .../avatar/uploads`, `POST .../avatar/{id}/complete`, `GET .../avatar/content?v=<version>`. expand 동안 `<version>`은 row 계약에 따라 legacy UUID(no-store) 또는 SHA-256(검증된 immutable)을 dual-read하고, cutover 뒤 canonical version은 SHA-256만 쓴다. create의 413, 권한 403, complete의 metadata mismatch 409, content의 잘못된 version/무결성·Drive 장애 응답과 성공 headers를 OpenAPI에 명시한다.
- cutover 뒤 `Workspace.avatarUrl`은 media UUID가 아니라 lowercase SHA-256 version을 담는다. Drive file id와 capability URL은 계속 wire에 노출하지 않는다.

## Verification

1. barrier Drive stub으로 create/complete 각각을 멈춘 뒤 self-leave·강등을 먼저 commit하면 current pointer·pending 전이·성공 business audit는 0이다. create의 pre-intent는 `abandoned`와 cleanup job으로 남고 반대 순서는 정상 완료한다.
2. upload create는 사용자 filename과 declared allowlist mime/size만 검증하고, 아직 받지 않은 bytes의 signature/frame/decode를 판정했다고 주장하지 않는다. complete와 content read는 SVG/GIF/animated WebP·mime/signature 불일치·5MiB 초과·4096px/16M pixel 초과·decoder budget 초과를 실제 bytes로 거절한다. content reader는 악성 length/무한 stream에서도 `5MiB + 1`보다 더 읽거나 buffer하지 않고 body를 먼저 내보내지 않는다.
3. complete 뒤 Drive의 mime·size·bytes를 각각 바꾸면 content가 body/cache header 없이 실패한다. missing/wrong `v`와 pending id 선캐시도 실패하고, 정상 digest만 ETag/immutable을 받는다.
4. Drive create 응답 유실과 최종 재인가 실패에서도 pre-intent correlation으로 객체를 찾고 그 요청의 한 row만 같은 transaction에서 abandoned할 수 있다. lifecycle/role-loss에는 0/1/500/501/5,000 pending upload를 두어 authority/role mutation child UPDATE 0+cursor head 상수, cleanup page 최대 500을 검증한다. cursor를 멈춰도 같은 member ID 재가입, same-row reinstate 또는 role 재상승 뒤 complete는 즉시 0이고, resume 뒤 abandoned+GC가 누락 없이 끝난다. 두 번 교체, Drive delete 일시 실패에서 old 객체가 retry 후 회수되고 old/new·GC audit가 결속된다. stale GC job과 pointer 교체를 barrier로 경합시켜 `deleting` media 재부착과 current media 삭제가 모두 0임을 증명한다.
5. RLS를 우회하는 migration test에서도 cross-workspace uploader/pointer INSERT·UPDATE가 FK로 실패한다.
6. NOBYPASS worker의 raw cross-tenant SELECT는 실패하고 제한 claim function만 job을 반환한다. 다른 workspace settle/Drive id 읽기는 실패하며 queue가 RLS registry에 포함된다.
7. OpenAPI와 runtime 세 operation/DTO/header가 일치하고 `[rust]` gate + PG18 ignored suite가 green이다.
8. generation-2 reader는 expand 동안 UUID URL을 no-store로만 읽고 digest URL은 검증된 row만 immutable이다. 혼합 창의 generation-1 reader가 UUID에 주는 기존 immutable은 별도 metric으로 계수하며 이 시점에 fleet 전체 `immutable=0`을 주장하지 않는다. dormant backfill dry-run/resume은 중복·누락 없이 checkpoint되고, old writer/reader instance·lease가 하나라도 남으면 actual backfill·writer fence·global UUID no-immutable claim·digest output flip이 거부된다. old reader 0 뒤 모든 UUID response의 immutable 0을 먼저 증명하고, backfill 전후 current row count가 보존되며 invalid/missing Drive object는 fail-closed한다. GC가 historical noncurrent complete를 `superseded`로 정규화해 `status='complete' AND digest IS NULL` 전역 count가 0이고 soak가 끝난 뒤에만 contract constraint validation이 성공한다.

## Rollback

업로드/complete를 먼저 닫고, generation-2 reader에서 digest output flag를 내려 UUID `no-store` 또는 `Workspace.avatarUrl` 생략/이니셜 fallback으로 돌린다. DB writer fence를 낮춰 구 writer를 되살리거나 UUID URL에 `immutable`을 다시 주지 않는다. 검증된 content read는 참조가 사라질 때까지 유지하고 GC worker는 pause할 수 있다. digest·audit·GC/FK 행은 증거이므로 삭제하거나 unchecked 경로로 되돌리지 않는다. 이미 GC된 외부 객체를 복원하려 하지 않는다.

## ADR-0161 부분 supersede

본 ADR이 Accepted 되면 **ADR-0161 D5 중 cache version, mime/size 검증, 교체 회수, schema/API 상세를 대체**하고, D5가 열어 둔 `owner` 대 `owner/admin` setter 선택은 **active human owner/admin**으로 해소한다. ADR-0161의 Drive 전송 프리미티브 재사용, workspace-member read scope와 워크스페이스당 현재 아바타 1개 결정은 유지한다. ADR-0151의 attachment 계약과 S3 v1 유보도 재개봉하지 않는다.
