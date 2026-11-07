# ADR-0151 — 첨부 v0: Drive 계약 동결 이식 + 클라 최소 표면

- Status: **Accepted** (2026-08-06 성재 승인 — 실행 지시 "작업 진행해줘"와 함께. 방향은 2026-08-04 결정 D로 사전 승인)
- Date: 2026-08-05
- 관련: ADR-0145 증보 1(attachments 3경로=이식 대상 v0 — 본 ADR이 그 "선행 ADR"이다) · 2026-07 재설계 확정(파일 저장=Drive 공유드라이브+SA 멤버) · U1 감사 `docs/planning/research/2026-08-05-chat-ui-audit.md` H-10/U4-f(컴포저에 첨부 진입점 0)
- 역방향: 2026-11-05 [ADR-0201](0201-team-ai-fast-path-for-simple-workspace-requests.md) 증보 v4(#5342) P6은 도우미가 맡긴 Hermes 그림을 대화에 올리려 **워커→api 첨부 쓰기 길**(격리 디코더 재인코딩, 한 메시지에 묶기)을 요구한다. 이 ADR의 [증보 8](#증보-8-2026-11-06-5371-워커의-첨부-쓰기---api의-사설-주소로-단일-사용-쓰기-주소-하나)(Proposed, #5371, P14-S3. v4가 말하는 「ADR-0151 증보」가 이것이다)이 그 길을 정하되 증보 3의 (a)식(단일 사용 발급, api가 소유 재판정)을 따르고 (c)식(내부 전용 경로 + 서비스 간 비밀)은 뒤집을 이유를 적지 않는 한 쓰지 않는다. 그 증보는 v4 검수와 별개로 자체 등급 2 독립 보안 검수 뒤에만 구현·머지하며, 그 전에는 `image` 종류가 광고되지 않는다. 본문 결정은 바꾸지 않았다(D3의 「에이전트 업로드는 v0 제외」는 그 증보 W10이 이 한 길에 한해서만 푼다).
- 증보 9: 2026-11-07 (#5469, **Accepted** 2026-11-07 planner — 등급 2 보안 검수 1회차 PASS, Medium 1 문구 수리) 사진·GIF의 가로세로 요약 — 보내는 기기가 선언하고 서버는 범위만 본다. `AttachmentMedia`에 `kind: image`(가로·세로만)가 더해지고, 같은 `PUT …/media` 길과 `attachment_media` 표(길이 열을 널 허용)를 쓴다. 처음 보는 사진도 첫 프레임부터 칸이 선다 — 파일 끝 「증보 9」. D5의 영상 결정과 증보 5~8의 본문 결정은 바꾸지 않는다.

## Context

- **서버 계약은 이미 존재하고 스펙에 성문화돼 있다** — Swift 시대 구현: `POST …/attachments/uploads`(Drive resumable 세션 생성 — 바이트는 서버 우회, PG가 인가·수명 소유), `POST …/attachments/{id}/complete`(Drive 메타데이터로 크기·mime 검증 후 완료 전이), `GET …/attachments/{id}/content`(인가 프록시). `openapi.yaml:2991,3041,3080` · `AttachmentRoutes.swift:33-34`(바이트 우회 원칙) · mime 검증(:66)·pending 행(:101)·검증 불일치 거절(:159,188).
- 메시지 바인딩도 계약 완결: 전송 DTO `attachmentIds` → 업로더 검증 링크(`MessageRoutes.swift:173-183`) → 응답·페이지에 `attachments` 동봉(:205,251).
- **server-rust에는 이 3경로가 없다**(routes/ 실측 — attachment 계열 0). 클라 표면도 양쪽 0(웹 컴포저 버튼 없음·모바일 없음).
- 즉 "첨부"는 신규 설계가 아니라 **이식 갭 + 클라 표면 갭**이다.

## Options

1. **계약 동결 이식(권고)** — 스펙 3경로를 형상 그대로 rust로. 저장 백엔드 Drive 유지.
2. S3 호환(MinIO)로 갈아타며 이식 — OSS 셀프호스트 친화적이나, 커토버 중 계약 정답이 두 곳이 되고 2026-07 Drive 확정을 뒤집는다. **기각(v0에서)**.
3. 클라 표면만 먼저(Swift 서버로) — 죽을 서버에 클라를 배선. **기각**.

## Decision

- **D1 · 계약 동결 이식**: 스펙의 3경로+메시지 바인딩을 와이어 무변경으로 rust 이식(표기는 #1040 camelCase 규율). Drive resumable·검증 로직 동등. 이식 완료 시 ADR-0145 증보 1 판정표의 attachments 행이 닫힌다.
- **D2 · 클라 v0 = 웹 먼저**: 컴포저 첨부 버튼(파일 선택→resumable 업로드→진행률→전송 시 `attachmentIds` 바인딩), 렌더 = 이미지 인라인 프리뷰 + 그 외 파일 카드(이름·크기·다운로드=content proxy 경유, 직링크 금지). 모바일(사진 picker 포함)은 후속 배치.
- **D3 · 경계**: content 접근은 인가 프록시 단일 경로(채널 멤버십·RLS — Drive URL 클라 비노출). 크기·mime 정책은 서버 스펙 값 유지. 바이러스 스캔 없음은 v0 한계로 명시. **에이전트 업로드는 v0 제외**(사람만 — 에이전트 산출물 첨부는 작업 패널/Drive 산출 경로와 함께 v1 결정). → [증보 8](#증보-8-2026-11-06-5371-워커의-첨부-쓰기---api의-사설-주소로-단일-사용-쓰기-주소-하나)의 W10이 **워커의 쓰기 주소 한 길에 한해서만** 푼다(사람 업로드 라우트는 에이전트에게 계속 닫혀 있다).

## Slack·업계 비교

Slack 초기 파일 업로드는 서버 경유 단순 POST였고, 이후 외부 공유 링크의 인가 우회 사고(공개 S3 URL 추측 가능)로 프록시·만료 토큰 체계로 회귀했다. momo는 처음부터 "바이트는 우회(업로드), 접근은 프록시(다운로드)" 비대칭을 계약에 고정 — 업로드 대역폭은 Drive에 넘기되 읽기 인가는 PG/RLS가 소유한다. Mattermost는 로컬/S3 저장 옵션을 두는데, 우리의 S3 옵션은 v1 보류로 남긴다(OSS 배포 마찰은 인정하되 v0 범위 밖).

## Consequences

- Drive가 장애 도메인에 추가된다(업로드·다운로드 모두). 헬스 신호는 연결 상태 표면(U3 계열)의 후속.
- OSS 셀프호스트는 당분간 Google SA 필수 — README에 명시할 것. S3 호환 백엔드는 v1 재론(폐기 아님).
- e2e의 minio는 이 계약과 무관한 잔재인지 이식 배치에서 실측·판정(잔재면 제거 티켓).

## 증보 1 (2026-10-25, #4233): 내용 읽기 경계 - 메시지에 묶인 첨부 또는 업로더 본인

- Status: **Accepted** (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」). 독립 보안 검수 r1 PASS(Blocker 0·High 0). 결정의 근거는 [ADR-0208](0208-scheduled-messages.md)(Accepted) 「남는 위험 8」과 planner 확인 ⑦(2026-10-22 수용)이다. 이 증보는 그 후속을 D3에 옮겨 적는 기록이고 새 방향을 정하지 않는다. 구현은 보안 후속 #4233이다.
- **변경 전(D3)**: content는 채널 멤버십만 본다. 완료된 첨부는 업로더가 아니어도 채널 활성 멤버가 읽었고, 아직 메시지에 묶이지 않은 초안 첨부도 같았다. 예약 메시지(ADR-0208)는 그 기간을 마감 시각까지(최대 120일) 늘린다.
- **결정**: content 읽기는 **활성 채널 멤버이면서, 첨부가 메시지에 묶여 있거나 읽는 사람이 업로더 본인**일 때만 성립한다. 묶이지 않은 첨부는 업로더만 읽고, 묶인 뒤에는 지금처럼 채널 멤버가 읽는다. 업로더도 채널 멤버십이 먼저다(채널을 나간 사람은 자기 초안도 못 읽는다). 워크스페이스 owner·admin의 예외는 없다.
- **거절의 모양**: 남의 초안은 **404이고 문장도 없는 id와 같다**(`completed attachment not found`). 403으로 답하지 않는다. 403이면 남의 초안이 있다는 사실이 새고, 이 경로는 처음부터 pending·failed·다른 채널·다른 테넌트를 한 문장으로 숨겨 왔다.
- **이슈 #4233 문구와 다른 두 곳**: ① 이슈는 「업로더 본인 항상 200」이라 적었지만 업로더도 **활성 채널 멤버일 때만** 200이다. 읽기 경로 전체가 멤버십을 먼저 본다는 현행 계약을 이 한 곳에서만 깨지 않으려는 것이고, 나간 채널의 초안은 읽을 이유가 없다(시험으로 못 박았다: 나간 업로더는 403). ② 이슈는 거절을 404 또는 403으로 열어 뒀고 여기서는 404로 정했다(위).
- **바뀌지 않는 것**: 묶인 뒤 채널 멤버의 읽기, 업로드·완료·묶기 경로, 컴포저 썸네일(서버를 거치지 않는다: 웹 `createImageBitmap(File)`, 폰 로컬 uri), 보낸 사람의 낙관 행(전송 중인 메시지의 첨부 카드는 작성자 = 업로더라 읽힌다), 에이전트 아바타 원본 선택(`find_visible_image_attachment_in_tx`·`find_requester_attachment_in_tx`는 이미 메시지에 묶인 첨부만 쓴다).
- **이 증보가 닫지 않는 것**: 감사 행 `attachment.upload_started`의 detail에 첨부 id와 이름이 남는다(내용은 아니다). 삭제된(soft) 메시지에 묶인 첨부는 `message_id`가 남아 채널 멤버가 계속 읽는다. 메시지를 hard delete하면 `ON DELETE SET NULL`로 첨부가 업로더 전용으로 돌아간다. 완료됐지만 묶이지 않은 첨부를 거두는 청소기는 여전히 없다(ADR-0208 남는 위험 5). 이 셋(지운 메시지의 첨부 읽기 차단, 청소기, 감사 detail의 이름)은 이 증보의 범위 밖이고 후속 #4443이 맡는다. → [증보 2](#증보-2-2026-10-25-4443-첨부의-수명)가 셋을 닫는다(청소기는 Google 백엔드는 notifier가, 로컬 볼륨은 api 프로세스가 돌고, 기본 꺼짐이다).

## 증보 2 (2026-10-25, #4443): 첨부의 수명

지운 메시지의 첨부는 아무도 읽지 못한다. 묶이지 않은 완료 첨부는 30일 뒤 거두되, **켜기 전에 사람이 같은 숫자를 다른 길로 확인하는 점검을 거치고 기본은 꺼짐이다**. 감사 detail에는 파일 이름을 싣지 않고, 이미 쓰인 행의 이름도 지운다.

- Status: **Accepted** (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」). 2026-10-26 owner가 「안전하게 처리 가능한지, 청소하거나 지우더라도 문제없는 녀석들인지 더블체크 후 진행」을 조건으로 세 가지를 승인했다: **A** 「지워도 되는 첨부」의 정의를 참조 전수로 증명한다, **B** 로컬 볼륨 청소기를 만든다(가능하면 새 SECURITY DEFINER 없이), **C** 이미 쓰인 감사 v1 행의 파일 이름을 정정한다(무결성 장치가 있으면 멈춘다). **독립 보안 검수: PASS (Blocker 0 · High 0)** — 2026-10-26, fresh Sonnet 읽기 전용 검수 세 라운드(r1 Medium 3·Low 13을 모두 고치거나 사실대로 문서화했고, r2·r3는 Medium 0). 지적과 처리는 구현 PR 본문에 있다. 결정의 근거는 증보 1이 「닫지 않는 것」으로 남긴 셋과 [ADR-0208](0208-scheduled-messages.md) 「남는 위험 5·8」이다. 새 방향을 정하지 않고 증보 1의 원칙(없는 id와 같은 404, 역할 예외 없음)을 같은 모양으로 잇는다. 구현은 보안 후속 #4443이다.
- **변경 전(증보 1 뒤)**: 메시지를 soft delete해도 첨부 행의 `message_id`는 남는다(`interaction.rs:1183-1186`은 메시지의 `state`·`body`·`deleted_at`만 바꾼다). 그래서 채널 멤버는 지운 메시지의 파일을 content로 계속 읽었고(`attachments.rs:367`), 기록 투영(채널 history·스레드 답)과 보내기 재시도의 echo가 그 파일의 이름·크기·id를 무덤 행에 계속 실었다. 완료됐지만 어떤 메시지에도 묶이지 않은 첨부를 거두는 곳은 없어 보관소는 늘기만 했다. 감사 `attachment.upload_started`의 detail에는 파일 이름이 있었다.

### 결정

- **D1 · 지운 메시지의 첨부 읽기는 404이고 예외가 없다.** content 읽기는 **활성 채널 멤버이면서, 첨부가 살아 있는 메시지에 묶여 있거나(`state <> 'deleted'` 그리고 `deleted_at IS NULL`) 어떤 메시지에도 묶이지 않았고 읽는 사람이 업로더**일 때만 성립한다. 작성자·업로더·워크스페이스 owner·admin의 예외는 없다. 근거: ① 작성자의 삭제가 대화가 그 파일에 가진 몫을 끝낸다. 지운 메시지는 업로더가 아직 쓰고 있는 초안이 아니라서, 증보 1이 업로더에게 준 읽기(보내는 중인 낙관 행)의 이유가 여기에는 없다. ② 파일이 필요한 작성자는 원본을 갖고 있다. 프록시를 보관함으로 쓰게 둘 이유가 없다. ③ 메시지를 지울 수 있는 사람은 작성자뿐이다(`interaction.rs:1164`). admin에게 지운 메시지를 읽는 길은 제품에 없고, 있어야 한다면 준법·신고용 읽기로 따로 결정할 일이다. 거절은 증보 1과 같다: 없는 id와 문장이 같은 404이고 바이트까지 같다(403 아님).
  - **술어의 모양이 결정의 일부다.** `(묶임 AND 살아 있음) OR 업로더`로 쓰면 지운 메시지의 파일이 지운 본인에게 돌아간다. 구현은 `(message_id IS NOT NULL AND 살아 있음) OR (message_id IS NULL AND 업로더)`다(`attachment.rs:364`).
  - **반쪽 무덤도 무덤이다.** `state`와 `deleted_at`은 둘 다 쓰이고 어느 하나만 있는 행이 옛 경로에서 생길 수 있다(`LockedMessage::is_deleted`, `interaction.rs:182`). 둘 다 본다. 에이전트 아바타 원본을 고르는 두 함수(`find_visible_image_attachment_in_tx`·`find_requester_attachment_in_tx`)도 같다(시험 `a_workspace_image_can_be_the_avatar_only_if_the_agent_could_read_it`·`member_avatar_set_a_run_names_its_requester_only_when_that_is_a_live_human`).
  - **soft와 hard의 비대칭을 인정한다.** soft delete는 아무도 못 읽게 하고, 메시지 행 자체를 지우면(`ON DELETE SET NULL`) 파일이 초안으로 돌아가 업로더가 읽는다(증보 1). 코드 경로에는 메시지를 hard delete하는 곳이 없어 운영·CASCADE에서만 생기고, 그렇게 돌아온 파일은 D4 청소기가 거둔다.
- **D2 · 기록 투영은 지운 메시지의 첨부를 싣지 않는다.** 무덤 행은 그대로 보인다(재접속한 클라이언트가 삭제로 수렴해야 한다). 첨부 키만 없다. 세 곳을 SQL에서 막는다: `PAGED_ATTACHMENT_JOIN`(채널 history·스레드 답, `attachment.rs:636`), `message_attachments_in_tx`(보내기 재시도가 저장된 행을 되돌려줄 때의 echo, `attachment.rs:595`), `image_attachments_for_messages_in_tx`(에이전트 포트 대화 읽기의 이미지 목록, `agent_avatar.rs:851`). 마지막은 핸들러가 이미 삭제 행의 `imageAttachments`를 거르므로(`agent_port_tools.rs:859`) SQL이 둘째가 아니라 첫째 겹이 되고 핸들러 가드는 둘째 겹으로 남는다. 실시간 `message.deleted` 프레임은 처음부터 첨부를 싣지 않는다.
- **D3 · 감사 detail에서 파일 이름을 빼고(schema v2), 이미 쓰인 v1 행의 이름은 마이그레이션 151이 지운다.** `attachment.upload_started`의 detail은 `channel_id`·`mime`·`size_bytes`만 가진다. 이름은 사람의 것일 수 있고, 감사는 파일보다 오래 남는다. D4 청소기가 행을 지우면 감사 detail의 이름이 이름의 마지막 사본이 된다. **해시는 기각한다**: 파일 이름은 짧고 추측하기 쉬워서 키 없는 해시는 사전 대입 한 번이면 이름이 되고, 키 있는 해시는 새 비밀과 회전 문제를 만든다. 조사에는 attachment id(행이 있는 동안 조인 키)·mime·크기·채널이면 된다.
  - **소급 정정(owner 승인 2026-10-26, 조건 C)**: 감사 행을 고치는 일이라 **무결성 장치를 먼저 확인했다.** 해시 체인·이전 행 해시 열: 없다. `UPDATE`/`DELETE`를 막는 트리거·규칙·정책: 없다(사용자 정의 트리거 0, 규칙 0, 정책은 `ws_isolation` 하나; 격리 PG에 모든 마이그레이션을 적용해 `pg_trigger`·`pg_rules`·`pg_policies`·`relacl`로 확인했다). 런타임 역할 `momo_app`은 이 표에 SELECT·INSERT·UPDATE·DELETE를 가진다(`bootstrap_runtime_roles.sql`). 문서에 「추가 전용」 약속이 없다(오히려 `write_audit`는 행동이 롤백되면 감사 행도 함께 사라진다고 적는다, `docs/security/README.ko.md`). 관리자가 감사 행을 읽는 REST 경로가 없고, `detail.name`을 읽는 코드도 없다(서버는 action·target의 존재만 읽는다). **그래서 이 정정은 어떤 보장도 깨지 않는다.**
  - **범위**: `action = 'attachment.upload_started'`이고 detail에 최상위 `name`이 있는 행에서 그 키 하나만 지운다(`151_audit_attachment_name_scrub.sql`). `schema` 문자열은 고치지 않고(v1 행은 v1로 남고 이름만 없다), 옛 서버가 `schema` 키 없이 쓴 행도 지운다. 다른 action의 행은 `name` 키가 있어도(`member.renamed`) 건드리지 않는다. 아바타 업로드 감사(`member/workspace.avatar_upload_started`)의 `name`은 별개 표면(ADR-0161)이라 범위 밖이다. 멱등이고, 감사 행을 수정하는 **유일한** 마이그레이션이다. 앞뒤 행 수는 `RAISE NOTICE`로 남는다(행은 사라지지 않는다).
  - **배포 창**: 배포 중 아직 도는 이전 버전 api가 v1 행을 쓰면 정정 뒤에도 이름 있는 행이 한두 개 생길 수 있다. 그래서 마이그레이션은 「0이어야 한다」고 단정하지 않고(거짓 실패로 배포를 멈추지 않는다) 숫자만 남기며, 점검 SQL(8절)이 남은 수를 센다. 배포가 끝난 뒤에도 0이 아니면 같은 UPDATE 한 문장을 다시 돌린다. 운영 적용은 배포의 사전 덤프 뒤에 일어난다.
- **D4 · 묶이지 않은 완료 첨부 청소기.**
  - **대상**: `status = 'complete'`, `message_id IS NULL`, `NOT reserved`, `GREATEST(created_at, unreserved_at)`가 30일(`UNBOUND_TTL`) 전보다 오래된 행, **그리고 아래 「지워도 되는 첨부의 정의」 표의 어떤 참조도 없는 행**. 30일은 inbox 읽은 항목·run 이벤트 원장의 보존과 같은 값이다(ADR-0199 D4, ADR-0200 D2). 컴포저에 남은 초안 첨부는 그보다 오래 쓰이지 않는다. 예약이 쥔 파일은 `reserved`로 빠지므로 예약의 120일 한도가 이 숫자를 정하지 않는다. `pending`·`failed` 행은 이 청소기의 대상이 아니다(남는 위험).
  - **시계**: 업로드(`created_at`)와 마지막 점유 해제(`unreserved_at`) 중 늦은 때부터 센다. ADR-0208 D11 「취소하면 점유를 풀고 파일은 남는다(초안과 같은 상태)」를 지키려는 것이다. 100일 묵은 예약을 취소하는 순간 다음 틱에 파일이 사라지면 「초안과 같은 상태」가 아니다. 한 가지 예외가 있다: **마이그레이션 150보다 앞서 풀린 점유**는 `unreserved_at`이 비어 있어 업로드 시각으로만 판정한다(예약 기능 145가 나온 뒤 150이 배포되기까지의 며칠에 한정되고 청소기는 꺼진 채 나온다). 그런 파일은 점검 SQL의 후보 수에 처음부터 안 풀린 파일과 섞여 구별되지 않는다(켜기 전에 후보 수가 예상과 맞는지로 판단한다).
  - **점유는 attachment 행에 비춘다.** 예약 점유 표 `scheduled_message_attachment`는 작성자 범위 RLS이고 BYPASSRLS 역할에는 봉인돼 있다(ADR-0208 D3, `145_scheduled_message.sql:124-131`). 청소기가 점유를 직접 보려면 남의 `app.member_id`를 묶어야 하는데 그것은 ADR-0208 D14-4가 이름 있는 세 함수로 고정한 예외이고, 새 definer를 만들 수도 없다. 그래서 마이그레이션 150이 `attachment.reserved`·`unreserved_at`을 더하고 **SECURITY INVOKER 트리거**가 점유 행의 INSERT·DELETE를 거기에 비춘다. 예약 생성·취소·발송·정리·CASCADE가 어느 경로로 점유를 만들고 지우든 한 곳에서 맞는다. 청소기는 이 열만 본다. ADR-0208의 점유 표에는 이 트리거 하나만 더하고 표 권한·RLS 정책·봉인은 바꾸지 않는다. 비춘 표시가 실제 점유 행과 어긋나면(트리거를 우회한 복원이나 버그) 점검 SQL의 5절이 센다.
  - **RLS 경계: 교차 테넌트 읽기는 워크스페이스 id뿐이다.** notifier의 BYPASSRLS는 「백그라운드 소비자의 문서화된 예외」로 이미 있고(`bootstrap_runtime_roles.sql:40`, 표는 FORCE RLS 그대로, DELETE 없음), 이 증보는 그 읽기에 **컬럼 여섯 개**(`workspace_id`·`status`·`message_id`·`reserved`·`unreserved_at`·`created_at`)를 더할 뿐이다. 첨부 id·`drive_file_id`·이름·mime·크기·업로더는 주지 않는다. 그 읽기는 `SELECT workspace_id … GROUP BY workspace_id` 하나이고, **후보 목록·참조 재판정·건수와 바이트 집계·삭제는 전부 워크스페이스별 `momo_app` RLS-bound 테넌트 tx**(`SET LOCAL app.workspace_id`)가 한다. `ensure_write_pool_rls_bound`가 BYPASSRLS 풀을 거절한다. 전례: 아바타 회수(`avatar_reclaim.rs:10-23`, ADR-0161 D5 증보 2)와 inbox·share·run event 보존 청소가 같은 모양이고, 컬럼 단위 notifier GRANT는 #3377 블록이 #2862 공유 보존·#3284 아바타 회수·#3553·#4284에서 이미 쓴다(`bootstrap_runtime_roles.sql`). 예약 메시지 틱(`scheduler.rs:1-14`)은 교차 테넌트 읽기를 id만 돌려주는 definer 두 개로 한다. 같은 방식을 첨부에 쓰면 새 definer가 필요하므로 택하지 않았다. **새 예외는 notifier 컬럼 SELECT 여섯 개뿐이고 전례의 가족 안이다. 새 BYPASSRLS 쓰기 경로·새 SECURITY DEFINER·남의 owner GUC 묶기는 없다.**
  - **두 러너, 하나의 결정(owner 승인 B)**: 보관소에 바이트를 쥔 프로세스가 지운다. **Google Drive**는 notifier가 돈다(`momo-notifier` `attachment_reclaim.rs`). **로컬 볼륨**(셀프호스트·Railway의 기본)은 api 프로세스만 볼륨을 쥐고 `LocalDriveArchive::open`이 연 프로세스의 보류 세션을 지우므로 다른 프로세스가 열 수 없다(`avatar_reclaim.rs:33-36`의 한계와 같다). 그래서 **api 프로세스가 같은 두 단계를 돈다**(`momo-server` `attachment_reclaim.rs`, `backend == local`일 때만, 둘 다 돌면 같은 행을 두 프로세스가 보게 되므로). 「무엇을 지워도 되는가」와 「건조 실행이 무엇을 세는가」는 하나의 함수(`momo_messaging::attachment_reclaim::reclaim_pass`)라 두 러너가 다르게 판정할 수 없다. api 러너는 `scheduler`처럼 자기 두 연결 풀(`momo_app`)로 돌고 BYPASSRLS 역할이면 돌지 않는다.
    - **교차 테넌트 읽기가 없다.** `momo_app`은 GUC 없이 `workspace` 행을 하나도 못 본다(`workspace`는 FORCE RLS이고, 격리 DB에서 `SELECT count(*) FROM workspace`가 0임을 확인했다). 워크스페이스를 열거하려면 api 프로세스에 BYPASSRLS 읽기 연결을 두거나(AGENTS.md가 막는다) **새 SECURITY DEFINER**를 만들어야 한다. owner가 새 정의자를 가능하면 피하라고 했고, 새 definer는 149→150에서 이미 겪은 업그레이드 순서 위험(부트스트랩이 마이그레이션 앞에도 돈다)과 세 파일 잠금 동기화를 부른다. **그래서 이번에는 만들지 않는다.**
    - **대신 「이 프로세스가 업로드를 받은 워크스페이스」를 본다.** `create_upload`가 성공하면 principal의 워크스페이스(`workspace_scope`가 검증한 값, 요청 본문이 아니다)를 메모리 집합에 적고(`TouchedWorkspaces`, 최대 10,000개, id만), 틱이 그 집합을 `SET LOCAL app.workspace_id` 테넌트 tx로 하나씩 돈다(틱당 100개 상한). **큰 백로그가 예산을 독점하지 못하게 순서를 돌린다**: 다음 틱은 이번 틱이 **마지막으로 본 워크스페이스 다음**부터 이어 본다(예산이 끊긴 워크스페이스는 줄의 맨 뒤로 가고, 100개를 넘는 집합은 창 단위로 걷는다. 시험: 백로그 4건인 워크스페이스와 1건인 워크스페이스를 예산 2로 두 틱 돌리면 두 번째 틱에 작은 쪽 파일이 사라지고, 150개가 넘는 집합에서 둘째 틱이 둘째 창에 닿는다). 집합의 내용은 어떤 파일도 이름도 멤버도 아니고 「다음에 열 테넌트 tx」를 정하는 데만 쓰인다.
    - **커버리지는 계약이다(각주가 아니다).** 업로드가 계속 오는 워크스페이스는 쓸린다(자격 되는 것을 배치 단위로 전부). **재시작 뒤 업로드가 없던 워크스페이스는 누가 올리기 전까지 보지 않는다**: 거기 묵은 초안은 지금처럼 바이트도 행도 남는다. 업로드가 없는 워크스페이스에서는 보관소가 늘지 않으므로 이 공백은 누수가 아니라 한정된 잔여분이다. 완전 커버리지가 필요하면 id만 돌려주는 최소 definer(ADR-0208 145 모양, 고정 `search_path`·전용 소유 역할·EXECUTE는 청소기 역할만)가 후속이고, owner가 그때 다시 결정한다. 시험이 이 공백을 고정한다(`the_tick_follows_the_workspaces_this_process_served_…`: 이 프로세스가 본 적 없는 워크스페이스의 묵은 파일은 남는다).
  - **순서**: 행을 `FOR UPDATE`로 잠그고 → 새 문장으로 자격을 다시 판정하고 → `SAVEPOINT` 안에서 **행 DELETE와 감사 INSERT를 먼저** 하고 → 보관소 객체를 지우고 → 성공이면 COMMIT, 실패면 `ROLLBACK TO SAVEPOINT`다. 행을 먼저 지우는 이유는 `huddle_transcription_*`가 `attachment`를 참조하는 FK(`046_huddle_transcription.sql`) 때문이다. FK가 삭제를 거절하면 바이트를 지우기 전에 tx가 선다(술어가 그 행을 먼저 거르므로 거절에 기대지는 않는다). 잠금이 경쟁도 정리한다: 메시지 묶기(`link_attachments_in_tx`)와 예약 점유(`reserve_attachments_in_tx`)는 둘 다 먼저 같은 행을 `FOR UPDATE`로 잡으므로, 그쪽이 먼저 커밋하면 재판정이 보고 건너뛰고, 나중이면 잠금을 기다렸다가 행이 없는 것을 본다.
  - **업그레이드 순서**: 운영 역할 파일(`bootstrap_runtime_roles.sql`)은 한 릴리스의 마이그레이션 **앞에도** 돈다(Railway pre-deploy, compose `runtime-roles`; `momo-migrate`는 `ON_ERROR_STOP`으로 파일 전체를 적용한다). 150이 `reserved`·`unreserved_at`을 더하므로 149→150 업그레이드의 첫 패스는 표는 있고 컬럼은 없는 상태에서 notifier GRANT를 만나 `column "reserved" of relation "attachment" does not exist`로 파일 전체와 배포를 멈춘다(149 상태 DB에서 실측했다. 아바타 회수의 `drive_reclaimed_at`은 컬럼(마이그레이션 112, #3284, 2026-10-02)이 GRANT(#3377 수리, 2026-10-03)보다 먼저 배포돼 이 순서 문제를 겪지 않았다). 그래서 부트스트랩의 GRANT는 컬럼이 있을 때만 치고(`pg_attribute` 확인), 마이그레이션 150이 컬럼을 더하면서 같이 grant하며, 둘째 패스가 한 번 더 한다. 새 설치는 첫 패스에 표 자체가 없어 기존 시험이 이 경로를 볼 수 없었으므로 업그레이드 시험을 따로 둔다(아래 red proof). **마이그레이션 151은 데이터만 고치고 컬럼·함수·권한을 더하지 않으므로 이 위험이 없다.**
  - **실패와 재시도**: 보관소 일시 실패는 아무것도 쓰지 않고 다음 틱이 다시 한다(연속 세 번 실패하면 틱이 멈춘다). 보관소 404는 성공이다(`delete_file`은 멱등이라 「보관소는 지웠고 COMMIT 전에 죽은」 경우가 다음 틱에 수렴한다). 영구 거절(`AccessDenied`·잘못된 id)은 행도 객체도 건드리지 않고 건수만 센다. 우리 드라이브의 객체가 아니면 우리가 지울 것이 아니고, 행을 지우면 객체가 어디 있는지를 잊는다.
  - **감사**: 지운 행마다 `attachment.expired`(행위자 없음, 대상 멤버는 업로더(시스템 행의 기존 관례), 대상 attachment id, `reason: unbound_ttl`, mime·크기·채널. 이름·Drive id 없음)를 같은 tx에 쓴다. 로그에는 건수만 남긴다.
  - **기본 꺼짐과 켜는 절차(owner 승인 2026-10-26 + planner 결정 1)**: 이 잡은 파일을 지우므로 **`MOMO_ATTACHMENT_RECLAIM`이 정확히 `1`일 때만 지운다**(`delete_switch_is_on`, 두 러너가 부르는 정의가 하나다. `true`·`yes`·` 1`·`01`·빈 값은 모두 꺼짐). 꺼진 채로도 틱마다 같은 읽기 경로를 돌아 **고정된 한 줄**을 남긴다: `attachment reclaim dry-run: delete_enabled=false scope=<all|touched> looked_at=N workspaces=W candidates=C bytes=B …`. `candidates`·`bytes`는 삭제와 같은 술어로 센 값이고, 꺼진 틱은 보관소 클라이언트를 만들지도 부르지도 않는다. 켜는 것은 owner가 배포 뒤 아래를 확인한 다음이다:
    1. 배포하고(마이그레이션 150·151 적용), 틱 몇 번의 dry-run 줄을 본다.
    2. 슈퍼유저로 `infra/rust/sql/attachment_reclaim_check.sql`을 돌린다(읽기 전용, 한 문장·한 스냅샷). 후보 수·바이트(1절), 이유별 분포(2절), 워크스페이스별 후보(3절), 새 FK 감지(4절), 후보 중 참조 있는 행과 점유 표시 어긋남(5절, 0이어야 함), 후보 id를 글자로 담은 json 열(6절), 같은 보관소 객체를 가리키는 다른 행(7절, 0), 감사에 남은 이름·청소 기록(8절).
    3. 대조: 로그의 `candidates`·`bytes`는 1절의 값 **이하**여야 한다(`scope=touched`는 이 프로세스가 재시작 뒤 업로드를 받은 워크스페이스만 보고, `scope=all`은 한 틱에 100개 워크스페이스까지 본다). 로그가 1절보다 **크면** 청소기가 점검이 모르는 파일을 세는 것이니 켜지 않는다. 4절에 `UNKNOWN`이 있어도 켜지 않는다. 점검 SQL의 술어는 청소기 소스의 것과 글자까지 같다는 것을 단위 시험이, 두 숫자가 같은 파일을 세는지를 PG 시험이 잰다.
    4. 켠 뒤 같은 SQL을 다시 돌려 1절이 줄었는지, 지운 행마다 남는 감사 `attachment.expired` 수가 늘었는지(8절)를 본다. 끄려면 변수를 `1`이 아닌 값으로 돌린다(Drive 값은 건드리지 않는다).
    - 업그레이드 뒤 첫 틱들은 쌓여 있던 묶이지 않은 30일 넘은 완료 첨부를 틱당 `batch`건(기본 50, 10분 간격)씩 거둔다. 그러니 켜기 전 확인이 이 일의 안전 장치다.

### 지워도 되는 첨부의 정의 — 첨부 id를 가리키는 곳 전수 (owner 승인 A)

방법은 둘이다. ① 마이그레이션을 전부 적용한 격리 DB에서 `pg_constraint`(들어오는 FK 4개, `attachment`가 내보내는 FK 4개)와 `information_schema.columns`(`json`·`jsonb` 열 32개, 이름에 `attach`가 든 열, `uuid[]` 열 8개)를 질의했다. ② 코드는 `rg -i attachment server-rust`(Rust 파일 50개)와 `rg attachmentIds|attachment_ids packages clients`, 클라이언트 저장소 키 목록을 훑고 각 쓰기 자리를 읽었다. 청소기 후보 술어는 **구조가 막는 참조(A)가 모두 없음**을 요구하고, 소프트 참조(B)는 「누가 이 id를 읽어 첨부를 찾는가」를 자리마다 적어 읽는 이가 없음을 보였다.

**A. 구조가 막는 참조 — 술어에 들어가고 시험이 하나씩 고정한다**

| # | 참조 | 정의 | 누가 쓰나 | 술어·시험 |
|---|---|---|---|---|
| A1 | 메시지 묶임 | `017_attachment.sql:14` `message_id … ON DELETE SET NULL` | 단 한 곳 `link_attachments_in_tx`(`attachment.rs:515`)가 보내기 척추에서 호출된다. 예약 발송·에이전트 deliver도 같은 척추다. 묶임을 푸는 코드는 없고(`rg 'message_id = NULL'`=0) 메시지 행을 hard delete하는 곳도 없다(`rg 'DELETE FROM message'`=0, 핀·리마인더만) | `message_id IS NULL` — 묶인 행(지운 메시지 포함)은 후보가 아니다. `old_unbound_complete_…`·`a_file_something_else_holds_…`(지운 메시지) |
| A2 | 예약 점유 | `145_scheduled_message.sql:91-99` `attachment_id … ON DELETE CASCADE`, UNIQUE. 표는 작성자 범위 FORCE RLS(`:124-131`), BYPASSRLS에 봉인(ADR-0208 D3) | `reserve_attachments_in_tx`(`scheduled.rs:601`, 행을 `FOR UPDATE`로 잠근 뒤 INSERT) | 점유된 파일을 지우면 CASCADE로 점유가 사라져 예약이 파일 없이 나간다. `NOT reserved` + `GREATEST(…unreserved_at…)`, 트리거가 표시를 맞춘다 — `a_held_file_is_never_reclaimed_and_a_released_one_is_a_draft_for_a_full_ttl` |
| A3 | huddle 전사 합본 | `046_huddle_transcription.sql:56,62-63` `merged_transcript_attachment_id` FK `(workspace_id, id)` | 지금 Rust에는 이 열을 채우는 곳이 없다(`rg merged_transcript_attachment_id`는 술어뿐). 이전 서버가 남긴 행·앞으로의 파이프라인 | `NOT EXISTS (… huddle_transcription_job …)` — `a_file_something_else_holds_…` |
| A4 | huddle 전사 트랙 | `046…:79-86` `source_attachment_id`·`transcript_attachment_id` FK | A3과 같다 | A3과 같다(두 열 각각) |

**A5(술어 밖, #4820 C2a 2026-10-31)**: 원본 사진 짧은 주소 `self_media_token.attachment_id`(`160_self_media_token.sql`, `ON DELETE CASCADE`). 쓰는 곳은 agent-worker의 `self_media::mint_for_run_in_tx` 하나이고, 런 요청자가 같은 대화에 올린 완료·미삭제 이미지 첨부만 가리킨다. 그 첨부는 메시지에 묶여 있어(A1) 후보가 아니므로 술어에 넣지 않는다. 묶임이 풀린 뒤 회수되면 5분·1회용 토큰은 CASCADE로 함께 지워지고, Hermes의 받기는 다른 거절과 같은 404다. 점검 SQL 4절은 이 FK를 `(known)`으로 센다.

**A6(술어 밖, #4673 C5 2026-11-02)**: 영상 메타·포스터 `attachment_media (workspace_id, attachment_id)` (`173_attachment_media.sql`, 복합 FK `attachment_media_attachment_fkey` → `attachment (workspace_id, id)` `ON DELETE CASCADE`). 쓰는 곳은 `momo_messaging::attachment_media::set_attachment_media_in_tx` 하나이고(`PUT …/media`: 업로더가, 완료됐고 아직 메시지에 묶이지 않은 영상 첨부에만), 읽는 곳은 포스터 라우트와 메시지 투영의 `LEFT JOIN`이다. 첨부 행이 지워지면 회수 청소기의 삭제도 CASCADE로 이 행을 함께 지우므로(청소기는 `momo_app`으로 돌고 이 표의 DELETE 권한이 없어도 된다: FK 동작은 표 소유자 권한이다) 후보 술어에 넣지 않는다. 이 행은 첨부를 붙잡는 참조가 아니라 첨부에 딸린 부속이다. 점검 SQL 4절은 이 FK를 `(known)`으로 센다.

**B. FK 없는 소프트 참조 — 읽는 이가 있는가**

| # | 자리 | 무엇이 들어가나 | 누가 첨부를 찾는 데 쓰나 | 판정 |
|---|---|---|---|---|
| B1 | `message.props` (jsonb, 열린 객체) | 서버 소유 키와 생산자 임의 키 | **없다.** 읽기 인가는 `attachment.message_id`로 정해지고 props를 첨부로 풀어 주는 코드가 없다. 1급 클라이언트도 props에 첨부 id를 넣지 않는다(`rg attachmentIds packages clients`는 보내기 요청 본문뿐) | 참조 아님 |
| B2 | `approval.payload`·아바타 제안(`member.avatar.set`·`agent.profile.update`) | 제안은 `{attachmentId}`(`action_resolve.rs:1356-1374`) | **제안 때 한 번** 파일을 읽어 바이트를 `agent_avatar_image`에 복사하고, 저장되는 형태에는 id가 없다(`actions.rs:1787` `bytes_and_attachment_ids_never_reach_the_stored_form`). 제안 때의 조회는 항상 묶인 살아 있는 메시지를 요구한다(`agent_avatar.rs`) — 묶이지 않은 행은 애초에 후보가 아니다 | 참조 아님 |
| B3 | `agent_run.input/output`·`agent_run_event` | 실행 입력·도구 호출 | 기록·표시만. 에이전트 문맥에 첨부는 들어가지 않는다(아바타 도구 스키마 설명뿐). 포트 대화 읽기의 이미지는 묶인 살아 있는 메시지의 행에서 나온다(`agent_avatar.rs:851`) | 참조 아님 |
| B4 | `outbox.payload` | `message.new`의 첨부 요약 | 릴레이가 내보낼 뿐 첨부를 찾지 않는다. 담긴 첨부는 이미 묶인 행이다 | 참조 아님 |
| B5 | `audit_log.detail` | 첨부 id(`target_id`)와 mime·크기·채널 | 조사자가 읽는다. 행이 사라진 뒤에도 남는 것이 설계다(`attachment.expired`) | 참조 아님(역사 기록) |
| B6 | agent memory(`mem_*`) | 대화 요약·사실 | 파일을 읽지 않는다(`memory.rs:1169` `NOTICE_NEVER_SENDS`에 `attachments`) | 참조 아님 |
| B7 | Slack 호환 웹훅의 `attachments` | 텍스트로 푼 카드 필드 | 우리 첨부 표와 무관한 같은 이름(`momo-webhook/src/payload.rs`) | 혼동 방지 |
| B8 | 아바타 미디어 `member_avatar_media`·`workspace_avatar_media` | 자기 `drive_file_id` | 아바타 회수가 지운다. attachment의 `drive_file_id`를 복사하는 코드가 없다(두 모듈에 `FROM attachment`가 없다) | 참조 아님이지만 **같은 객체를 두 행이 가리키면** 한쪽 삭제가 다른 쪽을 부수므로 술어가 같은 `drive_file_id`를 가진 아바타 미디어 행이 있으면 거른다(`a_file_something_else_holds_…`, 두 표) |
| B9 | 이름만 비슷한 열 | `cloud_box.last_attached_at`·`work_session.attach_endpoint`, 옛 `file` 표 | 무관 | 혼동 방지 |
| B10 | 보관소 객체 id | `attachment_workspace_drive_file_uniq (workspace_id, drive_file_id)`(044) | 세션 생성이 id를 정한다. 클라이언트가 고르지 못하고 `complete`는 요청 때 저장한 id와 대조한다 | 다른 워크스페이스가 같은 객체를 가리키면 RLS가 청소기 시야를 막는다. 점검 SQL 7절이 0임을 운영 데이터로 보인다 |

**C. 서버가 모르는 참조 — 클라이언트 초안**: 첨부 초안은 **세션 메모리뿐**이고 디스크에 남지 않는다(웹 `features/attachments/draftStore.ts:36-46`은 `File`을 들고 있어 localStorage로 갈 수 없다; 폰 `features/attachments/draftStore.ts`는 모듈 전역 `Map`, 로그아웃은 `clearAllAttachmentDrafts`; 폰 MMKV `composerDrafts`와 웹 localStorage 초안은 **본문 글자만**이고 첨부 id가 없다, 30일 `DRAFT_TTL_MS`). 서버가 모르는 유일한 참조는 열려 있는 컴포저의 메모리다. 업로드 세션은 길어야 일주일이고 `created_at`은 세션 시작이며 `complete`는 그 안에 일어나므로 **완료된 파일은 최소 23일의 유예**를 갖는다. 30일 넘게 같은 컴포저 탭을 열어 둔 채 첨부를 안 보낸 경우에만 보낼 때 「첨부를 찾을 수 없음」을 만나고 다시 올리면 된다. 원본은 올린 사람의 기기에 있으므로 지우는 쪽에서 데이터를 잃는 일은 없다. 30일은 이 위험을 덮는다.

**전수가 계속 맞는지**: 첨부를 가리키는 FK가 새로 생기면 점검 SQL 4절이 `UNKNOWN`을 내고, PG 시험이 FK 여섯 개(A1~A4, A5, A6)가 전부 `(known)`임을 단정하므로 CI가 빨개진다. 그때 이 표와 술어와 점검 SQL을 함께 고친다.

### 이슈 #4443 문구와 다른 곳

① 이슈는 청소기를 「notifier 스윕」이라 적었다. Google Drive는 그대로 notifier이고, **로컬 볼륨은 api 프로세스가 돈다**(위). ② 이슈의 「감사 detail에서 파일 이름 제거 또는 해시화」는 제거로 정했고 이미 쓰인 행은 소급해 지운다. ③ 이슈는 「작성자·관리자 예외 여부는 ADR 근거」라 적었고 예외 없음으로 정했다. ④ 이슈 코멘트의 「기록 투영의 첨부 메타 비우기」는 무덤 행을 지우지 않고 첨부 키만 뺀다. ⑤ 청소기는 기본 꺼짐이다(이슈에 없던 안전 조건).

### 기각한 대안

- **청소기가 점유 표를 직접 본다**: 남의 owner GUC 묶기는 ADR-0208 D14-4가 고정한 예외를 늘리고, notifier에 점유 표를 GRANT하면 D3의 봉인을 푼다. 새 definer는 이 일의 범위가 아니다. 그래서 점유를 attachment 행에 비췄다.
- **로컬 볼륨을 위해 api 프로세스에 BYPASSRLS 읽기 연결을 둔다**: 인터넷에 면한 프로세스에 교차 테넌트 읽기 권한이 생긴다. AGENTS.md가 쓰기 경로의 BYPASSRLS를 막고, 읽기라 해도 새 경계를 이 일 하나로 여는 것은 과하다.
- **워크스페이스를 열거하는 새 SECURITY DEFINER(`momo_schedule_private` 모양)**: 커버리지는 완전해지지만 새 정의자가 생기고, 149→150에서 겪은 부트스트랩 순서 위험과 세 파일 잠금 동기화를 부른다. owner가 「가능하면 새 정의자 없이」라고 했고 「업로드를 받은 워크스페이스」로 가능했으므로 후속 선택지로 둔다.
- **notifier가 볼륨을 같이 마운트한다**: `LocalDriveArchive::open`이 연 프로세스의 보류 세션을 지우므로 두 프로세스가 열면 업로드 중인 세션을 지운다.
- **기본 켜짐 + 끄기 스위치(1단계 설계)**: 업그레이드 뒤 첫 틱들이 쌓인 첨부를 한꺼번에 거둔다. 운영 데이터(파일)를 지우는 잡이라 켜기 전에 사람이 같은 숫자를 다른 길로 확인하는 편이 맞다. 그래서 기본 꺼짐 + 건조 실행 줄 + 점검 SQL로 바꿨다.
- **TTL을 180일로 늘려 `reserved` 없이 가기**: 170일 묵은 초안을 예약에 쥐면 여전히 말없이 잃는다. 실패한 예약을 다시 걸 수 있어(ADR-0208 D9) 한 파일이 예약에 매이는 기간은 120일로 끝나지 않을 수 있다.
- **아바타 회수처럼 행을 지우지 않고 표시만 하기**: `drive_file_id`가 남아 content 경로가 Drive 404(「Drive attachment was not found」)를 돌려주고, 없는 id의 문장과 달라진다. 행 수도 줄지 않는다.
- **보관소를 먼저 지우고 행을 나중에 지우기**: FK가 행 삭제를 거절하는 때 바이트는 이미 없다.
- **지운 메시지의 파일을 업로더·작성자에게는 열어 두기**: D1의 근거 ①②. 지운 사람이 그 파일을 프록시로 계속 받는 길이 된다.
- **파일 이름을 해시로 남기기·감사 v1 행을 그대로 두기**: D3. 해시는 사전 대입 한 번이고, 그대로 두면 청소기가 파일을 지운 뒤에도 이름이 감사에 마지막 사본으로 남는다.
- **pending·failed 행까지 청소하기**: 이 일의 대상(완료됐지만 묶이지 않은 첨부)이 아니고, `failed`는 보관소 쪽 사정(크기·mime 불일치)이 달라 따로 판단할 일이다.

### 남는 위험

- **로컬 러너의 커버리지**: 재시작 뒤 업로드를 받지 못한 워크스페이스의 묵은 초안은 청소되지 않는다(위 D4). 완전 커버리지는 id만 돌려주는 최소 definer 후속이다. 건조 실행 줄의 `scope=touched`가 이 한계를 이름으로 드러낸다.
- **지운 메시지에 묶인 파일의 바이트**: `message_id`가 남으므로 청소기는 건드리지 않는다. 읽을 수는 없지만(D1) 행과 바이트는 남는다. 점검 SQL 2절의 「bound to a deleted message」가 그 수를 보인다. 거두려면 따로 결정한다.
- **`pending`·`failed` 행과 그 바이트**는 거두지 않는다(`attachment_pending_cleanup_idx`는 쓰는 곳이 없다).
- **영구 거절 행이 후보 창을 차지한다.** 후보는 오래된 순으로 틱당 `batch`(기본 50)건이라, 보관소가 영구 거절하는 행(우리 드라이브에 없는 객체, 잘못된 id)이 그만큼 쌓이면 그 뒤의 새 후보가 처리되지 않는다. 백엔드를 바꾼 인스턴스가 아니면 생기지 않고(읽기도 함께 깨진다), 건수는 로그의 `refused`로 드러난다. 생기면 후보를 돌려가며 읽어서 푼다.
- **다른 워크스페이스가 같은 보관소 객체를 가리키는 경우**는 청소기(테넌트 tx, RLS가 시야를 막는다)가 볼 수 없다. 지금 코드에는 그런 경로가 없고 점검 SQL 7절이 0임을 운영 데이터로 보인다.
- **채널·워크스페이스를 지우면(FK CASCADE) 첨부 행이 사라져 보관소 객체가 고아가 된다.** 행을 따라가는 이 청소기는 못 찾는다.
- **30일을 넘긴 컴포저 초안**은 보낼 때 404(첨부를 못 찾음)를 만나 다시 올려야 한다.
- **배포 중 이전 버전 api가 쓴 감사 v1 행**은 정정 뒤에도 이름을 가질 수 있다(D3). 점검 SQL 8절이 센다.
- **클라이언트**: 코어의 `applyTombstone`(`packages/momo-core/src/features/timeline/model.ts`)은 무덤으로 바꿀 때 메모리의 `attachments`를 남긴다. 웹·모바일 `MessageRow`는 무덤 행에서 첨부 카드를 그리지 않으므로(검수 r3가 읽어서 확인) 메모리의 카드가 404를 맞는 일은 거의 없지만, 메모리 정리는 UXUI 후속이다.
- **아바타 업로드 감사**(`member.avatar_upload_started`·`workspace.avatar_upload_started`)의 `name`도 같은 모양이다. 별개 표면(ADR-0161)이라 이 증보는 건드리지 않았다.
- **빈 볼륨·마운트되지 않은 볼륨**: 로컬 아카이브는 없는 객체의 삭제를 성공으로 치고(`local.rs`의 `delete_file`) 없는 디렉터리는 만들어 준다. 볼륨 마운트가 실패한 채 부팅한 api에서 스위치가 켜져 있으면 묵은 초안의 **행**이 지워지고 실제 바이트는 마운트되지 않은 볼륨에 고아로 남는다(지워질 후보였던 행이라 사용자 데이터의 추가 손실은 없다). 켜기 전에 api 컨테이너 안에서 볼륨에 파일이 실제로 있는지(`oort exec api sh -c 'ls "$MOMO_DRIVE_LOCAL_DIR/objects" | head'`) 직접 확인한다(시작 로그는 마운트 여부를 말해 주지 않는다). 틱 시작 때 볼륨 표식을 확인하는 보강은 후속이다.
- **두 서비스의 백엔드 변수는 같은 값이어야 한다**: api가 `local`인데 notifier에 Google 키·공유드라이브 id가 있고 notifier의 백엔드 변수가 비어 있으면 notifier도 청소기를 구성해 `local-…` id에 Google 삭제를 부르고, 프로브 404를 성공으로 처리해 행만 지워질 수 있다(스위치가 켜진 때만). Railway는 notifier에 Drive 변수를 주지 않아 해당 없다.
- **셀프호스트 compose에서는 Google 백엔드의 청소를 켤 수 없다.** Google Drive는 notifier가 청소하는데, compose의 notifier 서비스(`huddle-notifier`, 푸시 오버레이)는 Drive 변수와 `MOMO_ATTACHMENT_RECLAIM*`를 받지 않고 notifier는 셀프호스트 기본 스택에도 없다(ADR-0208). 그래서 청소도 dry-run 줄도 없고 안전한 쪽으로 실패한다. 지금 켤 수 있는 경로는 `local` 백엔드(api가 청소: Railway 팀 인스턴스와 셀프호스트 compose)다.
- **`complete` 라우트의 응답**은 업로더 범위로 읽고 이미 `complete`이면 그대로 200을 돌려준다. 지운 메시지에 묶였던 파일도 업로더 본인은 이름·mime·크기·`messageId`를 받는다(남에게는 새지 않는 본인 데이터). 「아무도 읽지 못한다」는 파일 내용(content)에 대한 말이다.
- **runtime-unverified**: 한 줄짜리 전달들은 시험이 닿지 않는다 — `main.rs`가 `config.attachment_reclaim`을 `start`에 넘기는 호출과 기동·종료 배선(결정 함수 `runs_in_this_process`는 시험한다), api `AttachmentReclaimSettings::from_env`·`Config::from_env`와 `NotifierConfig::from_env`가 각각 `from_lookup`·`attachment_reclaim_from`을 부르는 줄(그 안의 스위치 읽기는 시험한다), notifier `lib.rs`가 청소 루프를 띄우는 한 번의 `from_config` 호출(`from_config_with`는 시험한다). 틱 한가운데에서의 프로세스 종료와 실제 Google Drive 호출(기록용 대역으로 시험했다)도 시험이 닿지 않는다. api 러너의 타이머 루프는 짧은 주기로 실제 `start`를 돌려 시험한다.

### red proof

| 결정 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| D1 | `attachment_conformance_pg::a_deleted_messages_attachment_is_nobodys_to_read` | 읽기 술어에서 `m.state <> 'deleted'`만 지우면 `state`만 쓰인 반쪽 무덤이 200, `m.deleted_at IS NULL`만 지우면 `deleted_at`만 쓰인 반쪽 무덤이 200, 둘 다 지우면 방·작성자·admin이 200, `OR 업로더`를 괄호 밖으로 빼면 작성자 본인이 200 |
| D2 | `a_deleted_messages_attachments_are_not_listed_anywhere` | `PAGED_ATTACHMENT_JOIN`에서 지우면 채널 history가 카드를 싣고(스레드 답은 같은 상수를 읽는다), `message_attachments_in_tx`에서 지우면 재시도 echo가 싣고, `image_attachments_for_messages_in_tx`에서 지우면 직접 호출이 이미지를 돌려준다 |
| D3 | `the_audit_trail_never_holds_a_file_name` | detail에 `"name": name`을 되돌리면 |
| D3(소급) | `prod_role_conformance_pg::the_audit_scrub_removes_a_file_name_from_old_upload_rows_and_touches_nothing_else` | `action` 조건을 지우면(다른 action의 `name`이 사라진다), 다른 키를 지우면, v1 schema만 고르면(schema 없는 옛 행이 남는다), `detail ? 'name'`을 지우면(둘째 실행이 이름 없는 행의 행 버전을 바꾼다) |
| D4 | `a_held_file_is_never_reclaimed_and_a_released_one_is_a_draft_for_a_full_ttl` | `NOT a.reserved`를 지우면 2단계, `GREATEST`의 `unreserved_at` 항을 지우면 3단계, 트리거 INSERT 가지를 비우면 1단계, DELETE 가지를 비우면 3단계가 빨강 |
| D4 | `attachment_reclaim_conformance_pg`(notifier) | 자격 항 다섯(`status`·`message_id`·`reserved`·`unreserved_at`·나이)을 하나씩, `NO_OTHER_HOLD_SQL`의 `NOT EXISTS` 넷을 하나씩(huddle 세 열·아바타 두 표), 저장점 롤백(실패 팔 / 저장점을 늦게 열기), 404=성공, 거절 시 행 유지, 잠금 뒤 재판정, 잠금 없이 먼저 부른 보관소, 테넌트 술어 셋 모두(RLS 없는 둘째 모드), BYPASSRLS 쓰기 풀 거절, 꺼진 틱이 지우는 것(건조 실행이 삭제 경로에 닿으면) |
| D4 · 점검 SQL | `the_operators_check_sql_agrees_with_the_sweep_and_would_notice_a_reference_it_does_not_know` + 단위 `the_operators_check_sql_embeds_the_sweeps_predicate_word_for_word` | 점검 SQL의 후보 술어 한 항을 바꾸면(청소기의 건수와 어긋난다), 이유 분포가 아바타 공유 객체를 놓치면, FK 목록을 다른 표로 바꾸면(새 FK가 안 보인다), 점유 표시 어긋남 탐침을 막으면, json 열 스캔에서 jsonb를 빼면, 같은 객체 탐침을 막으면 |
| D4 · api 러너 | `attachment_reclaim_local_pg`(6개) + `attachment_reclaim` 단위 시험 | `create_upload`가 워크스페이스를 적지 않으면, 요청을 모양·멤버십 검사 전에 적으면(거절된 요청이 적힌다), `sweep_once`·`start`가 RLS-bound 풀 확인을 빼면, 꺼진 틱에 보관소를 건네면(단위 시험과, 실제 루프를 짧은 주기로 돌리는 시험 둘 다), 커서가 마지막으로 본 워크스페이스 다음으로 가지 않으면(큰 백로그가 예산을 독점하거나 둘째 창에 닿지 못한다), 틱이 예산을 쓰지 않으면, 이미 없는 객체를 실패로 분류하면, `local`이 아닌 백엔드도 도는 것으로 판정하면 |
| D4 · 기본 꺼짐 결선 | api `config` 단위 시험 · notifier `config` 단위 시험 · `from_config_with` 단위 시험 | `MOMO_ATTACHMENT_RECLAIM`이 `delete_enabled`에 닿는 줄(api `from_lookup`, notifier `attachment_reclaim_from`)을 고정값으로 바꾸거나 다른 변수를 읽게 하면 |
| D4 · 마지막 방어선 | `a_hold_that_appears_after_the_listing_is_seen_by_the_recheck_under_the_lock` · `an_unknown_reference_stops_the_delete_before_any_byte_goes` | 재판정을 핵심 항만으로 바꾸면(목록 뒤에 생긴 huddle·아바타 점유를 놓친다), 보관소 호출을 행 삭제 앞으로 옮기면(아직 술어에 없는 FK가 행을 거절해도 바이트가 이미 사라진다) |
| D4 | `prod_role_conformance_pg::every_notifier_job_iteration_runs_as_its_production_role` | notifier 컬럼 GRANT를 지우거나(부트스트랩과 마이그레이션 둘 다) `name`으로 넓히면, 점유 표를 notifier에 열면, 후보 읽기가 GRANT 밖 컬럼(`drive_file_id`)을 부르면(`attachment_reclaim::tests` 단위 시험도 빨강) |
| D4 | `prod_role_conformance_pg::an_upgrade_survives_the_pre_migrate_roles_pass_and_ends_with_the_attachment_grant` | 부트스트랩 GRANT의 컬럼 존재 확인을 지우면(첫 패스가 없는 컬럼을 GRANT) 빨강, 백필이 `false`를 쓰면 실제 점유 행의 플래그 단정이, 점유 행을 놓치면 마이그레이션 자신의 행 수 단정이 빨강 |
| D4 | `scripts/tests/test_notifier_role_grants.sh` | 같은 GRANT의 정적 판정: 표 단위 SELECT·빠진 컬럼·`drive_file_id` 추가가 모두 빨강 |

사보타주를 실제로 돌린 결과(어떤 되돌림이 어떤 시험을 빨갛게 했는지)는 PR 본문이 정본이다.

## 증보 3 (2026-10-31, #4934): 워커의 첨부 읽기 - api의 사설 주소로, 단일 사용 주소 하나

Railway는 api와 agent-worker를 다른 서비스로 띄우고, `local` 저장소는 api 볼륨에만 붙는다(볼륨은 서비스 하나에만 붙는다). 그래서 팀 서버의 워커는 요청자가 대화로 보낸 사진을 읽지 못했고(`UnavailableDriveArchive`, 오류 줄 없음) 「사진으로 프로필 사진 바꾸기」(#4791·#4808)가 열리지 않았다. 이 증보는 워커가 그 사진을 **api의 사설 주소로** 읽게 한다. 새 길을 만들지 않는다. [ADR-0218 증보 G4·G8(C2a)](0218-workspace-expressions.md)이 이미 열고 보안 검수를 마친 「1회용·짧은 만료·소유 재판정」 주소 `GET /v1/self-media/{ws}/{token}`을 워커가 **자기 요청에** 쓴다.

- Status: **Accepted** (2026-11-01 planner — 독립 보안 검수 1회차 Blocker 0·High 0. Medium·Low는 후속 이슈로 남긴다. 2026-10-31 #4934 worker 기안). 새 내부 호출이라 등급 2다(ADR-0100: 보안 경계 변경은 Accepted ADR 참조가 머지 조건). 이슈가 요구한 방식 비교는 아래 표다.
- **변경 전**: 워커의 사진 제안(`profile_avatar::prepare`)은 소유 조회 뒤 `MOMO_DRIVE_*`로 연 **자기 보관소**에서 바이트를 읽었다. api와 같은 볼륨이나 같은 SA 키가 워커에도 있어야 했다(셀프호스트 compose는 `local.override.yml`의 읽기 전용 마운트, Google 백엔드는 키 복제). Railway는 둘 다 안 돼서 읽기가 조용히 닫혔다.

### 결정

- **D1 · 방식 (a).** 워커가 DB에서 토큰을 만들고(`mint_for_attachment_in_tx`, 같은 `self_media_token`, 해시만 저장) **자기가** `{OORT_API_INTERNAL_ORIGIN}/v1/self-media/{워크스페이스}/{토큰}`을 한 번 부른다. api는 이미 있는 라우트로 소유를 다시 재판정하고 바이트를 내준다. **migration은 없다**(160의 표가 이미 런·에이전트·요청자·대화·첨부에 묶는다).
- **D2 · 소유 재판정은 세 번이고 같은 술어다.** ① `prepare`의 조회(`find_requester_attachment_in_tx`, 지금 그대로), ② 발급(같은 함수를 행을 쓰기 **전에** 다시 묻는다. 그 대화에 요청자와 에이전트가 아직 있어야 하는 조건이 더해진다), ③ 풀기(`redeem_in_tx`, 변경 없음: 런 진행 중·두 사람의 멤버십·같은 함수). 남의 첨부, 지운 메시지, 다른 대화, 다른 워크스페이스, 미완료, 이미지가 아닌 것, 크기 초과, 없는 id, 만료, 재사용은 모두 같은 거절이다. 발급에서 거절되면 api에는 요청조차 가지 않는다.
- **D3 · 이 증보가 넓히는 것은 하나뿐이다: 발급이 첨부 id를 받는다.** C2a의 주소(`mint_for_run_in_tx`)는 id를 받지 않는다(서버가 트리거 메시지의 첫 이미지를 고른다). 워커의 읽기 주소는 제안 인자의 `attachmentId`를 받는다. 노출이 넓어지지 않는다: 같은 id가 지금도 직접 읽기 길에서 같은 술어를 통과해야 바이트가 된다. 그리고 이 주소는 **모델이 읽는 어떤 글에도 실리지 않는다**. 워커가 한 요청에 쓰고 버리며, 페이로드·메시지·감사·오류·로그 어디에도 쓰지 않는다. 그래서 모델이 말로 이 라우트에 닿을 방법은 늘지 않는다.
- **D4 · 수명은 60초**(C2a의 5분과 따로: `SELF_MEDIA_INTERNAL_TTL_SECS`). 발급 직후 쓰므로 읽기 마감(10초)에 여유만 둔다. 표의 10분 천장 안이다.
- **D5 · 설정과 선택.** `OORT_API_INTERNAL_ORIGIN`(워커 전용)이 있으면 **api 길 하나**, 없거나 모양이 틀리면 **자기 보관소 길(`MOMO_DRIVE_*`) 하나**로 읽는다. 폴백은 없다: api 길이 실패했을 때 몰래 보관소를 읽으면 끊어진 사설망이 가려진다. 값의 모양은 `http(s)://<소문자 호스트>[:포트]`뿐이다(경로·슬래시·사용자 정보·질의·대문자·비ASCII·IPv6 괄호 거절. `canonical_origin`의 공개 출처 문법과 다른 값이다). 이 값은 요청도 모델도 정하지 않는 배포 설정이다. 그래서 사람이 GUI에 적는 공급자 URL용 egress 가드(`momo-egress`)를 거치지 않는다(사설 주소가 정상이다). 대신 클라이언트가 **리디렉션을 따르지 않고 프록시를 무시한다**. 잘못 적은 값은 기동 때 변수 이름만 경고한다(값은 찍지 않는다).
- **D6 · 읽는 법.** 선언된 크기와 정확히 같은 바이트만, 응답의 `Content-Type`이 png·jpeg·webp이고 바이트가 그 형식으로 시작할 때만 받는다. 200만 사진이고, 404는 api의 하나뿐인 거절(`attachment_not_available`), 그 밖의 상태·전송 오류·모양 불일치는 `drive_unavailable`이다. **전송 오류 문장은 돌려주지 않는다**(감사의 `reason`은 고정 코드다). 조용히 닫히던 것이 이 이슈의 불만이어서 원인 한 줄은 로그에 남기되, 그 원인은 **고정 낱말뿐이다**(#4974가 정정: `timeout`·`connect`·`body`·`request`. reqwest의 오류 문장은 요청 URL, 곧 api의 사설 출처·워크스페이스·토큰을 담으므로 아예 쓰지 않는다. 첫 판은 그 문장을 `redact_self_media_urls`로 가려 남겼는데, 가려도 출처와 워크스페이스가 남았다. 아래 후속 F3).
- **D7 · 기본 배선.** Railway 템플릿의 agent-worker에 `OORT_API_INTERNAL_ORIGIN=http://api.railway.internal:8080`(api의 `privateHostname`+`port`), 셀프호스트 compose에 `${OORT_API_INTERNAL_ORIGIN-http://api:8080}`(빈 값으로 끄고 `MOMO_DRIVE_*` 길로 돌아갈 수 있다), host-network 오버레이는 `127.0.0.1:${MOMO_RUST_API_PORT:-8080}`. 카탈로그 검사가 값을 api의 선언에서 도출해 못 박고(공개 엣지나 다른 포트는 빨강) agent-worker 말고 다른 서비스가 가지면 빨강이다. 운영 값은 배포 때 planner가 넣는다.

### 비교한 방식

| 방식 | 판단 |
|---|---|
| (a) 워커가 api의 자기 주소 길을 쓴다 (**채택**) | 이미 검수한 길(1회용·해시만·짧은 수명·소유 재판정). 새 비밀도 새 라우트도 없고 저장소 종류(local·Google)와 무관하다. 대가: 워커가 처음으로 api를 부른다 |
| (b) 팀 서버 저장소를 Google Drive 백엔드로 | SA 키와 공유 드라이브가 필요해 owner의 손이 들어가고, 기존 첨부 이전이 따라온다(이슈의 범위 밖). 워커에도 SA 키가 들어가 공유 드라이브 전체를 읽는 권한이 생긴다. 이 길이 필요한 배포는 `OORT_API_INTERNAL_ORIGIN`을 비우면 지금처럼 직접 읽는다 |
| (c) 내부 전용 경로 + 서비스 간 비밀 | 새 라우트, 새 비밀(회전·유출 범위), 소유 판정의 두 번째 구현, 1회용이 아니다. (a)에 없는 이점이 없다 |
| (d) 한 볼륨을 두 서비스에 | Railway 볼륨은 서비스 하나에만 붙는다 |

### 바뀌지 않는 것

`GET /v1/self-media/{ws}/{token}`(라우트·헤더·거절·예산), C2a의 호스팅 주소(`mint_for_run_in_tx`, 5분)와 Hermes 가드, `find_requester_attachment_in_tx`, `self_media_token` 표와 권한, `drive_file_id`가 워커 메모리에만 있는 것(조회 tx가 읽는다, 지금과 같다), 사진을 디코드·재인코드하는 `process_avatar_image`와 승인 카드, 자기 보관소로 읽는 길(설정이 없을 때).

### 남는 위험

1. 워커(`momo_worker`, BYPASSRLS)가 **api를 통해** 첨부 바이트를 읽을 수 있게 된다. Railway에서는 처음 생기는 능력이다. 손상된 워커가 `self_media_token` 행을 직접 써도 풀 때의 재판정(진행 중인 런의 요청자가 쓴 완료 이미지, 그 대화)이 막으므로 범위는 migration 160 L6이 이미 수용한 것과 같다(「진행 중인 런이 있어야 하지만 첨부는 고를 수 있다」). 워커는 이미 모든 테넌트의 메시지와 기억을 읽는 역할이다.
2. 사설망에서 토큰이 평문 http로 간다. Railway 사설망(프로젝트·환경 단위로 격리)을 믿는 선택이다. 템플릿 규칙이 공개 엣지로 나가는 값을 막는다.
3. api의 거절 예산은 호출 주소와 경로의 워크스페이스 단위(기본 30/창)다. 워커의 거절이 그것을 다 쓰면 그 창 동안 그 워크스페이스의 사진 제안이 닫힌다(429, `drive_unavailable`). 소유 거절은 발급에서 끝나 api에 가지 않으므로, 워커 자신이 예산을 쓰는 것은 발급 직후의 경쟁(메시지 삭제)과 api 쪽 저장소 오류뿐이었다. **→ 증보 6 A(#5072, Proposed) 뒤로 저장소 오류는 502이고 예산을 쓰지 않는다.** 다만 api는 `X-Forwarded-For`의 첫 값을 있는 그대로 믿는다(`rate_limit::client_ip`, 문서화된 v0 한계). 워커의 사설 주소를 알아맞힌 외부 호출자는 그 헤더를 위조한 가짜 주소 요청(모양만 맞으면 404)으로 워커 주소의 예산, 곧 주소 전체 상한(한도의 10배)까지 써서 모든 워크스페이스의 사진 제안을 그 창 동안 닫을 수 있다. 가용성만이고 제안은 일반 답으로 떨어진다. C2a가 Hermes의 주소에 대해 이미 적은 한계와 같은 부류이고, 근본 해결(신뢰하는 프록시 목록)은 이 증보의 범위 밖이다.
4. 소비 뒤 api의 저장소 오류는 토큰을 태운다(C2a의 약속). 이 읽기는 한 번만 시도하고 제안은 일반 답으로 떨어진다.
5. 로그: reqwest·hyper의 `log` 기록까지 TRACE로 잡아 토큰이 없음을 쟀지만 현재 의존성 버전에서의 관찰이다. 의존성을 올리면 같은 시험이 다시 잰다.
6. 사설 호스트 해석: 레거시 Railway 환경은 IPv6 전용 사설망이다. 다른 모든 사설 연결(`HERMES_BASE_URL`·`CENT_API_URL`)과 같은 조건이다.
7. 워커와 api의 두 번째 결합이다(첫 번째는 같은 DB). api가 내려가 있으면 사진 제안이 `drive_unavailable`로 닫히고 일반 답으로 떨어진다. 워커의 다른 일은 영향이 없다.

### runtime-unverified

실제 Railway 사설망 위의 호출(`api.railway.internal` 해석·연결), 실제 볼륨과 실제 Google Drive, 실제 배포. 시험은 127.0.0.1 TCP, 실 PG18(두 테넌트, `momo_app`·`momo_worker`), 진짜 라우터로 했다. 또 실제 워커 한 턴과 진짜 라우터를 한 시험에서 잇는 시험은 없다(루프 시험은 `running`으로 심은 런에 읽기를 직접 부르고, 팀 AI 한 턴 시험은 풀지 않는 대역을 쓴다). 읽기 시점에 런이 진행 중이라는 사실(`redeem_in_tx`의 `queued`·`running` 조건)은 시작 전이가 `run_team_ai_turn`보다 먼저라는 코드 읽기로만 확인했고, 스택 검증의 첫 장면이 그 접점이다.

### red proof

| 결정 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| D1 | `attachment_via_api_conformance_pg::a_requesters_picture_goes_worker_to_api_to_worker_and_becomes_the_proposal_image`, `team_ai_conformance_pg::a_picture_request_is_read_through_the_apis_private_address_and_the_model_never_sees_the_token` | `team_ai.rs`가 `attachment_reader()` 대신 `self.drive`를 읽으면(요청이 api에 가지 않고 그림이 쌓이지 않는다) |
| D2 발급 | `self_media_pg::the_workers_read_address_is_refused_for_everything_that_is_not_the_requesters_image_here`, `attachment_via_api_conformance_pg::a_refused_attachment_never_reaches_the_api_and_every_refusal_is_the_same` | `mint_for_attachment_with_ttl_in_tx`에서 `find_requester_attachment_in_tx`를 지우면(남의 첨부가 토큰을 받고 요청이 api에 간다) |
| D2 풀기 | `self_media_pg::the_workers_read_address_stops_working_when_it_expires_is_spent_or_stops_holding` | `redeem_in_tx`에서 소유 재판정을 지우면(지운 메시지·남의 파일 행) |
| D2 1회용·만료 | 같은 시험, `attachment_via_api_conformance_pg::the_address_the_worker_mints_is_single_use_and_short_lived_on_the_wire` | `used_at IS NULL`을 지우면(재사용), `expires_at > clock_timestamp()`를 지우면(만료) |
| D4 | `self_media_pg::the_workers_read_address_names_any_image_the_requester_wrote_in_the_conversation` | `SELF_MEDIA_INTERNAL_TTL_SECS`를 바꾸면(수명을 잰다) |
| D5 | `attachment_via_api_conformance_pg::a_worker_whose_api_is_unreachable_fails_closed_and_does_not_fall_back_to_the_archive`, `…::a_worker_with_no_private_address_keeps_reading_its_own_archive`, `self_media::tests::the_internal_origin_is_a_bare_http_origin_and_nothing_else` | 폴백을 넣으면, 설정을 무시하면, 문법의 한 항을 느슨하게 하면 |
| D6 리디렉션 | `self_media::tests::a_redirect_is_an_answer_not_a_place_to_go` | 클라이언트의 `redirect(Policy::none())`를 지우면 |
| D6 길이 | `self_media::tests::a_body_that_never_ends_is_cut_at_the_declared_length` | 청크 길이 검사를 지우면 |
| D6 로그 | `attachment_via_api_conformance_pg::a_failed_fetch_logs_a_cause_and_never_the_token`, `self_media::tests::a_transport_failure_holds_a_kind_and_nothing_the_transport_said`, `self_media::tests::no_log_line_names_the_address_the_token_or_the_drive_id` | 실패 줄에 reqwest의 문장·출처·워크스페이스·토큰을 쓰면, tracing 호출에 주소·토큰을 쓰면(#4974: 가림에서 고정 낱말로 바뀜) |
| D7 | `scripts/tests/check_railway_catalog.py --prove-mutations`의 5건(`worker-api-internal-dropped`·`-wrong-port`·`-public-edge`, `relay-api-internal-origin`, `readme-row-missing-api-internal`) | 값을 api 선언에서 도출하는 규칙, 다른 서비스 금지, README 행 |

사보타주를 실제로 돌린 결과는 PR 본문이 정본이다.

### 후속 (2026-11-01, #4974): 독립 보안 검수 1회차 Medium 1·Low 4의 처리

결정(D1~D7)은 바뀌지 않는다. 검수가 남긴 것은 시험이 재지 못하던 줄과 운영 위생이고, 아래 다섯으로 닫는다. D6의 「원인은 `redact_self_media_urls`를 지난다」는 F3이 대신한다.

- **F1 · 워커가 실제로 쓰는 읽기 클라이언트의 배선을 잰다(Medium).** 워커의 클라이언트를 `attachment_client()` 대신 기본 클라이언트(리디렉션 10회·프록시 환경변수·시간 한도 없음)로 바꿔도 모든 시험이 초록이었다. 단위 시험은 생성 함수만 재고, 워커가 쓰는 필드는 아무 시험도 건드리지 않았다. 이제 루프 시험이 `attachment_reader()`로 읽는다. 302를 주는 스텁이 진짜 사진을 내주는 둘째 서버를 가리키게 하고, 그 둘째 서버에 요청이 0건임을 잰다. 프록시 무시(`.no_proxy()`)는 이 시험이 재지 않는다. 시험에서 프로세스 환경을 바꾸지 않는 규칙 때문이고, `HTTP(S)_PROXY`를 준 자식 프로세스로 재는 CI 한 줄은 정책 파일이라 별도 결정이다.
- **F2 · 읽기 주소의 수명 60초를 워커가 쓴 행에서 잰다(Low).** D4의 60초는 상수와 도메인 함수만 재고, 워커의 실제 호출이 다른 수명을 줘도 초록이었다. 첫 루프 시험이 이미 읽는 토큰 행에서 `expires_at - created_at`이 60초(이 문서의 숫자이지 상수가 아니다)임을 단정한다.
- **F3 · 실패 로그에는 오류의 종류만 남는다(Low, D6 정정).** 가린 줄에도 api의 사설 출처와 워크스페이스 id가 남았고(`error sending request for url (http://…/v1/self-media/<워크스페이스>/<redacted>)`), reqwest 0.12의 문장은 원인(연결 거절인지 시간 초과인지)을 말하지도 않았다. 이제 전송 실패는 고정 낱말 하나(`timeout`·`connect`·`body`·`request`)만 남기고, reqwest의 문장은 어디에도 쓰지 않는다(가리지도 않는다. 남기지 않으니 샐 것이 없다). 시험은 실제 실패가 쓴 로그 줄을 붙잡아 그 줄에 종류가 있고 출처·워크스페이스·토큰이 없음을 잰다. 한 가지는 그대로다. DEBUG 이하로 켠 reqwest·hyper의 자체 기록(`starting new connection: http://…/`, `connecting to …`)은 접속하는 상대의 출처를 적는다. 경로와 토큰은 적지 않고(전체 캡처에서 토큰이 없음을 잰다, 남는 위험 5), 이 줄들은 라이브러리의 것이며 운영 기본(`info`)에는 나오지 않는다.
- **F4 · 사설망 주소 모양이 아닌 값은 기동 때 한 줄 경고한다(Low, D5 보강).** 문법은 출처의 모양만 판정하고(`http://example.com`도 통과) 어디를 가리키는지는 판정하지 않는다. 이 값은 요청도 모델도 정하지 않는 운영 설정이지만, 1회용 토큰이 그 호스트로 간다. 값이 문법을 통과했는데 사설망 주소처럼 보이지 않으면 기동 로그에 변수 이름만 든 경고 한 줄을 남긴다(값은 찍지 않는다). 사설 모양은 루프백·사설 IPv4(`10/8`·`172.16/12`·`192.168/16`, 공유 주소 `100.64/10`), 한 낱말 이름(compose의 `api`), `.internal`(Railway의 `api.railway.internal`)·`.local`·`.localhost`·`.home.arpa` 접미사다. 공개 이름·공개 IP·링크 로컬 `169.254/16`(클라우드 메타데이터 주소)·해석기가 주소로 읽을 수 있는 숫자 모양(`2130706433`·`0x7f.1`)은 아니다. 스킴은 보지 않는다(`https://`로 공개 호스트를 가리켜도 공개 호스트다). 막지는 않는다. 모양 검사일 뿐이고 이름은 어디로든 풀릴 수 있다.
- **F5 · 셀프호스트 워커의 읽기 전용 마운트는 남기고 이유를 적는다(Low).** 기본(`OORT_API_INTERNAL_ORIGIN` 미설정 = `http://api:8080`)은 이 마운트를 읽지 않는다. 그러나 같은 스위치의 다른 가지가 읽는다. 값을 비우면(또는 출처가 아닌 값이면) 워커는 `MOMO_DRIVE_LOCAL_DIR`의 자기 보관소를 읽고, 마운트가 없으면 조용히 닫힌다(`open_reader` 실패 → `UnavailableDriveArchive`, 로그 없음). #4934가 없앤 침묵이다. 그래서 지우지 않고, 이유와 지워도 되는 조건(그 값을 끄지 않을 스택)을 `local.override.yml` 주석에 적었다. 대가는 워커가 모든 워크스페이스의 첨부를 읽기 전용으로 쥔다는 것이다. 기본 오버레이에서 빼고 끄는 스택 전용 오버레이로 옮기는 길은 canonical compose 파일 집합(생성기·셀프호스트 시험)을 건드려 이 후속에서 하지 않는다. 필요하면 별도 결정이다.

| 후속 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| F1 | `attachment_via_api_conformance_pg::the_client_the_worker_reads_with_follows_no_redirect` | `lib.rs`가 `attachment_client()` 대신 `reqwest::Client::new()`를 쓰면(둘째 서버에 요청이 간다. 이 사보타주에서 단위 시험 `a_redirect_is_an_answer_not_a_place_to_go`는 초록이어서 이 시험이 메운다) |
| F2 | `attachment_via_api_conformance_pg::a_requesters_picture_goes_worker_to_api_to_worker_and_becomes_the_proposal_image` | `SELF_MEDIA_INTERNAL_TTL_SECS`를 바꾸면, 워커의 발급 호출이 다른 수명을 주면 |
| F3 | `attachment_via_api_conformance_pg::a_failed_fetch_logs_a_cause_and_never_the_token`, `self_media::tests::a_transport_failure_holds_a_kind_and_nothing_the_transport_said` | 실패 줄에 출처·워크스페이스를 쓰면, `transport()`가 reqwest의 문장을 남기면, 종류 분기(`timeout`·`connect`·`body`)를 지우면 |
| F4 | `self_media::tests::an_origin_is_private_shaped_only_when_it_names_a_place_on_a_private_network`, `self_media::tests::the_boot_line_for_an_origin_that_is_not_private_names_the_variable_and_never_the_value`, `boot_origin_warning::the_booting_worker_warns_once_by_name_for_an_origin_that_is_not_private_and_never_prints_it` | 판정의 한 항(접미사·사설 범위·숫자 모양)을 지우면, 경고에 값을 쓰면, 경고를 내지 않으면, `main.rs`가 호출하지 않으면 |

F5는 설정 주석이라 시험이 없다. `docker compose config`가 기본 구성·기본+host-network 구성 모두 통과하고, 렌더된 워커의 마운트(`drive-archive` → `/var/lib/oort/drive`, 읽기 전용)가 그대로임을 확인했다. 사보타주를 실제로 돌린 결과는 PR 본문이 정본이다.

## 증보 4 (2026-11-01, #4970): 워커의 첨부 읽기를 글·PDF·그림까지 — 읽기용 발급, 같은 길, 같은 상한

[ADR-0201 증보 v3 B6-1](0201-team-ai-fast-path-for-simple-workspace-requests.md)(Accepted)이 도우미의 읽기 도구 `read_attachment`를 정했고, 바이트는 증보 3의 길(api 사설 주소, 1회용 주소)을 그대로 쓰라고 했다. 그런데 증보 3의 길은 **발급·풀기·라우트·워커 읽기 네 곳 모두가 세 그림(png·jpeg·webp)만** 통과시킨다(D2·D6). 그대로는 글 파일과 PDF가 발급에서 거절되므로, 이 증보가 그 네 곳을 같은 모양으로 넓힌다. 새 길·새 라우트·새 비밀·migration은 없다.

- Status: **Accepted** (2026-11-02, planner — 독립 보안 검수 1회차 High 1·Medium 1·Low 5 → 수리, 2회차 Blocker 0·High 0·Medium 1·Low 4 → R2-1·R2-5 코드 수리·R2-2~R2-4 문서 반영, planner Linux 실측 PASS: 스레드 64개 설정에서도 자식이 PDF를 읽고(`{"ok":true}`·종료 0) N=2·16·64의 `VmSize` 102,968 kB·스레드 2로 같음, `--memory=1g` 자식 시험 15/15, `--memory=300m`에서 커널이 자식을 먼저 끝냄(`oom_kill` 1)). 등급 2: 공개 라우트가 내주는 종류가 늘어난다(ADR-0100).
- **변경 전**: `mint_for_attachment_in_tx`와 `redeem_in_tx`가 `find_requester_attachment_in_tx`(아바타 용도: png·jpeg·webp)로 판정했고, 라우트와 워커의 `fetch`가 `bytes_match_mime`(세 그림)으로 끝에서 한 번 더 걸렀다.

### 결정

- **D1 · 용도 하나가 늘고, 판정 문장은 그대로 하나다.** `RequesterAttachmentUse::Read` = 세 그림 + `text/plain`·`text/markdown`·`text/csv`·`application/json` + `application/pdf`(닫힌 목록 여덟). 소유 판정의 SQL은 용도만 바꿔 같은 한 문장을 쓴다(작성자 본인·이 대화·완료·살아 있는 메시지·보관 안 된 채널·크기). 도구의 **첫 겹(조회)**만 `ReadAnyType`을 쓴다: 종류를 가리지 않고 「누구 것인가」만 묻는다(빈 목록 = 어떤 종류든. 다른 용도가 빈 목록이면 시험이 빨개진다). 그래서 요청자 본인의 파일이 읽지 않는 종류면 「그 종류는 못 읽어요」, 너무 크면 「너무 커요」라고 정직하게 말하고(본인 것이라 새는 것이 없다), **남의 파일은 크기·종류와 무관하게 같은 `not_found`**다. 발급·풀기에는 `ReadAnyType`을 쓰지 않는다.
- **D2 · 발급.** `mint_for_read_in_tx`(60초·1회용·해시만, D4 그대로)는 `Read`로 행을 쓰기 **전에** 판정한다. 기존 `mint_for_attachment_in_tx`(아바타)는 세 그림만 그대로다. 아바타 용도로 PDF·글의 id를 내밀어도 주소를 받지 못한다(시험으로 못 박음).
- **D3 · 풀기.** `redeem_in_tx`는 `Read`로 다시 판정한다. 그림은 지금까지와 같은 질문이고, 글·PDF를 가리키는 토큰은 읽기용 발급만 만든다. 위조한 행이 있어도 풀 때의 같은 술어(진행 중인 런, 두 사람의 멤버십, 요청자가 쓴 완료 파일)가 막는다 — 증보 3 「남는 위험 1」과 같은 범위다.
- **D4 · sniff.** `bytes_match_mime`이 세 그림에 더해 `application/pdf`는 `%PDF-`로 시작할 때, 글 종류는 **비어 있지 않고 NUL 바이트가 없을 때**만 맞다고 한다(글에는 매직이 없다. UTF-8인지 한글 옛 인코딩인지는 읽는 쪽의 몫이다). 목록 밖의 종류는 어떤 바이트여도 내주지 않는다. 라우트의 응답 헤더(`Content-Disposition: attachment`, `nosniff`, `no-store`, 리디렉션 없음)는 그대로다.
- **D5 · 상한은 하나, 5 MiB.** ADR-0201 B6-1의 「10MB」는 **[추정]**이었고, 라우트의 상한은 `SELF_MEDIA_MAX_BYTES`로 아바타 입력 상한과 한 숫자임을 시험이 못 박고 있다. 숫자를 둘로 쪼개면 조회가 받은 파일을 라우트가 거절하는 틈이 생기므로 하나로 둔다. 더 큰 파일은 요청자 본인에게 「너무 커요」다.
- **D6 · 워커의 읽기.** `RequesterAttachment`가 용도를 싣고(`usage`), `ApiAttachmentBytes`가 그 용도로 발급을 고르며, `fetch_as`가 응답의 `Content-Type`이 **그 용도의 종류이고** 바이트가 그 종류일 때만 받는다(아바타는 여전히 세 그림). 어느 읽기 길(api 또는 보관소)이든 워커가 길이와 sniff를 한 번 더 본다. **읽기 용도의 이유 코드가 하나 더 있다**(독립 보안 검수 1회차 수리, 2회차 정정): 발급이 성공한 **뒤** api의 라우트가 내는 404는 `attachment_not_readable`이고, 요청자에게는 「읽을 수 없는 형식이에요」라고 말한다. 발급 자체의 거절(지워진 파일 등)은 그대로 `attachment_not_available`(→ 없는 파일과 같은 `not_found`)이고, 아바타 용도의 코드는 바뀌지 않는다. **이 404가 한 코드로 읽는 원인은 넷이다**(증보 3의 「거절은 한 모양」이라 워커는 가르지 못한다): ① 요청자 본인의 파일이 종류와 달리 읽을 수 없는 모양이다(라우트가 바이트를 sniff한다. 영구 원인이고 이 문구가 맞는 경우다). ② 발급과 읽기 사이 1초 안쪽에 파일이 지워졌다. ③ 라우트 뒤의 보관소(Drive) 읽기가 실패했다. ④ 행이 말한 길이와 보관소의 바이트 길이가 다르다. ②~④는 파일의 영구한 성질이 아니고 다시 해 보면 읽힐 수 있는데도 「다시 만들어 올려 주세요」가 나간다. 본인 파일이라 새는 것은 없고 문구만 틀리다(남는 위험 7). 같은 보관소 실패가 길에 따라 다르게 말해지기도 한다: 워커가 보관소를 직접 읽는 길은 `drive_unavailable`(→ 「잠시 뒤에」)이고, api 길은 라우트가 404로 덮어서 위 문구가 된다. **→ 증보 6 A(#5072, Proposed)가 ②~④를 404 밖의 502로 나눠 이 문장의 ②~④를 대신한다.**
- **D7 · 글자 뽑기는 이 증보의 길 밖이지만 같은 PR이 한다.** 글 파일은 UTF-8(BOM 제거) 아니면 EUC-KR(오류 0일 때만), PDF는 lopdf(MIT)로 뽑되 **워커 프로세스 안에서 파싱하지 않는다.** 워커 바이너리를 `--attachment-text-child`로 **빈 환경**에서 다시 띄우고(DB 주소·마스터 키·공급자 키를 상속하지 않는다), 표준입력으로 바이트를 주고 표준출력의 JSON 한 줄(≤512KiB)을 읽는다. 마감(8초) 뒤에는 죽이고 거두며, 동시에 둘까지다(`momo-expressions`의 그림 해독 자식과 같은 모양). **메모리는 셋으로 가둔다**(독립 보안 검수 1회차 수리): ① 자식이 파일을 읽기 전에, 그리고 **어떤 스레드 풀도 뜨기 전에**(2회차 수리: 바이너리의 `main`이 동기 함수라 `--attachment-text-child` 갈래가 비동기 런타임을 만들기 앞에 있다) 스스로 주소 공간 상한을 건다(Linux `RLIMIT_AS` 4GiB, `momo-expressions`가 이미 쓰는 안전한 `rlimit` 래퍼라 `unsafe`도 새 crate도 없다). 같은 자리에서 `oom_score_adj`를 1000으로 올리고(권한이 필요 없다. best effort다: 남는 위험 2), 코어 덤프 한도를 0으로 낮춘다(`RLIMIT_CORE`, 소프트·하드 모두, 유닉스 전체). 순서가 설계의 일부인 까닭: 상한은 가상 주소 공간이라 스레드 스택과 할당자 영역(glibc는 스레드마다 가상 영역을 따로 잡는다)도 셈에 들어간다. 런타임이 먼저 떠 있으면 보이는 코어 수만큼의 일꾼이 이미 상한 안에 들어가 있어서, 코어가 많은 호스트에서는 파일을 한 바이트 읽기 전에 상한이 차거나 거의 찬다. 그래서 자식은 스레드 하나(와 자기 워치독)일 때 구속하고, 진짜 바이너리로 그 스레드 수를 재는 시험이 있다. ② 감독자가 50ms마다 자식의 상주 메모리(RSS, Linux `/proc/<pid>/status`, 그 밖은 `ps`)를 읽다가 512MiB를 넘으면 그 PID를 kill하고 회수한 뒤에 슬롯을 돌려준다. ③ 감독자가 사라져도 자식은 자기 마감(10초)에 스스로 끝낸다. 상한·주기는 `attachment_text`의 상수다. 문서 글자는 줄바꿈을 지키고, 제어 문자·보이지 않는 서식 문자(너비 0, 방향, BOM, 유니코드 태그 블록)를 지우고, 코드 울타리를 무력화한 뒤 **20,000자**에서 자른다.
- **D8 · 그림은 다시 인코딩해서 모델에 간다.** 바이트가 정하는 종류(png·jpeg·정지 webp), 헤더 크기를 먼저 보고(4096×4096·1,600만 화소 상한) 디코더 한도 아래에서 해독, EXIF 방향을 반영해 긴 변 1568px로 맞춘 뒤 JPEG(투명하면 PNG)로 새로 인코딩한다. 위치·기기 같은 메타데이터는 남지 않는다. 모델 호출에는 **구조 부품**(Anthropic `image` 블록, Responses `input_image`)으로 실리고, 한 요청에 하나다. chat/completions 와이어는 같은 와이어가 텍스트 전용 게이트웨이와도 이야기하므로 닫아 두고 「이 연결로는 이미지를 못 봐요」라고 말한다.

### 바뀌지 않는 것

라우트의 경로·헤더·거절 한 모양·예산, `self_media_token` 표와 권한, C2a의 호스팅 주소(`mint_for_run_in_tx`, 5분)와 Hermes 가드, 아바타 흐름(세 그림만, `prepare_with`), `OORT_API_INTERNAL_ORIGIN`과 폴백 없음(D5), 토큰이 모델이 읽는 글에 실리지 않는 것(D3). 첨부 내용·추출한 글자·이미지는 감사·로그·행 어디에도 남지 않는다 — 감사에는 도구 이름과 닫힌 결과 코드만 있다(ADR-0201 B13-I6).

### 남는 위험

1. **라우트가 내주는 종류가 늘었다**(글·PDF). 토큰 하나는 첨부 하나·요청자 하나·대화 하나·런 하나에 묶이고, 1회용·60초이며, 풀 때 같은 소유 술어가 다시 걷는다. 그래도 손상된 워커가 위조한 행으로 읽을 수 있는 파일의 범위가 요청자의 그림에서 요청자의 글·PDF까지 넓어졌다(증보 3의 위험 1과 같은 부류).
2. **PDF 파서는 공격자가 쓸 수 있는 형식을 읽는다.** lopdf는 스트림을 상한 없이 풀고(작은 파일이 큰 메모리를 쓰게 할 수 있다), 입력 5 MiB 상한은 그 메모리를 막지 못한다. 자식 프로세스 + 빈 환경 + 마감 뒤 kill·회수 + 동시 2 + 출력 상한에 **메모리 상한 셋**(D7)을 더해 가둔다. 처음 이 항목은 두 문장으로 상한이 없음을 받아들였고, 둘 다 사실이 아니어서 고친다. (가) 「자원 한도를 걸려면 `unsafe`가 필요하다」는 틀렸다 — 안전한 `rlimit` 래퍼로 자식이 자기 프로세스에 건다. (나) 「OOM killer가 받침이고 죽는 쪽은 가장 큰 자식이다」는 배포 한도에 따라 맞기도 틀리기도 했다 — 커널은 **상주 메모리가 가장 큰 프로세스**를 고르는데, 워커가 모델을 올리면 약 0.9GiB가 상주해서(`config.rs`의 측정 주석) 한도가 약 1.5~1.9GiB인 구간에서는 한도가 찼을 때 자식이 워커보다 작아 **워커가 먼저 죽을 수 있다**. 그래서 자식이 `oom_score_adj`를 1000으로 올려 한도가 차면 커널이 자식을 먼저 고르도록 돕는다. **이것은 best effort다**(2회차 수리): 쓰기가 막힌 환경(`/proc`을 쓸 수 없는 컨테이너)에서는 조용히 실패하고, 그 환경에서는 위 한도 약 1.5~1.9GiB 구간의 문제가 그대로 돌아온다. 일부러 구속 실패(종료 상태 2)로 닫지 않았다. 읽기 상한은 이 쓰기에 기대지 않고, 닫으면 그런 환경에서 모든 PDF가 「잠시 뒤에」가 된다. 남는 것: 감독자의 읽기는 표본이라(50ms) 그 사이에 늘린 만큼은 주소 공간 상한만 막고, macOS는 `RLIMIT_AS`가 적용되지 않아 감독자의 읽기만 작동한다(이미지는 Linux). **`env_clear`는 가둠이 아니다**(2회차 수리): 자식은 워커와 같은 사용자 번호·같은 파일 시스템·같은 네트워크·같은 `/proc`으로 돈다. 환경 변수를 넘기지 않을 뿐이라, 파서가 장악되면(lopdf는 `unsafe`를 금지하고 압축 풀기도 안전한 Rust라 가능성은 아주 낮다) 그 자식이 읽을 수 있는 것은 워커 프로세스가 읽을 수 있는 것과 같고, 워커 프로세스의 환경 변수도 거기에 든다. 그 틈을 닫으려면 자식에게 다른 사용자 번호·네임스페이스·시스템 호출 필터가 필요하고, 이는 **후속**이다(이월). **→ 증보 6 B(#5072, Proposed)가 시스템 호출 필터로 닫는다(다른 사용자 번호와 네임스페이스는 비 root 컨테이너에서 되지 않음을 측정해 기각).** **코어 덤프**(2회차 수리): 자식은 `RLIMIT_CORE`를 0으로 건다(소프트·하드, 유닉스 전체). 악성 파일이 자식을 죽이는 일은 흔하고(너무 깊은 중첩의 스택 소진, 할당 실패) 덤프에는 요청자 문서의 글자와 파서 상태가 남기 때문이다. 코어를 파일로 쓰는 호스트는 이것으로 막힌다. `core_pattern`이 호스트의 처리기로 가는 배포에서는 그 한도를 처리기가 따르는지에 달려 있어 코드가 보장하지 못한다. 더 강한 수단(프로세스를 덤프 불가로 표시하는 `PR_SET_DUMPABLE`)은 `unsafe`나 새 의존이 필요해 **후속**이다(이월). **→ 증보 6 B(#5072, Proposed)가 이미 락 파일에 있는 `rustix`의 안전한 래퍼로 닫는다.** 슬롯 둘은 프로세스 공용이라 한 계정이 둘 중 하나를 오래 붙잡을 수 있다 — 워크스페이스·요청자당 슬롯 상한은 **후속**이다. 같은 시각의 요청자 수는 도우미의 일일·10분 상한이 막는다. 한글 PDF의 글자는 글꼴의 ToUnicode에 달려 있어 못 뽑으면 「글자를 뽑지 못했어요」라고 말한다(실측 안 함).
3. **파일 내용·그림이 팀 키 공급자로 간다.** 이것이 ADR-0201 B3의 고지 대상이다. 그림은 다시 인코딩해도 그림 속 글자는 간다.
4. **요청자 규칙은 「본인이 올린 파일, 이 대화」다**(B6-1 문장 그대로). 같은 방 동료가 올린 파일은 `not_found`다. 넓히려면 소유 술어에서 작성자 조건을 빼고 청중 규칙이 일하게 하면 되는 한 줄이며, owner가 정할 일이다.
5. **청중 규칙은 오늘 요청자 규칙 뒤에서 홀로 거절할 일이 없다**(회신 채널이 곧 파일의 채널이다). 파일 찾기(F2)가 생겨 다른 채널의 파일 id를 대는 길이 열리는 날을 위한 줄이고, 손으로 만든 범위로 거절함을 시험이 증명한다.
6. **이미지 입력은 Anthropic Messages·OpenAI Responses 와이어만** 연다. 실제 공급자 호출은 하지 않았다(`runtime-unverified`). 와이어별·모델별 능력표가 생기면 chat/completions도 열 수 있다.
7. **발급 뒤의 404는 네 원인을 한 코드로 읽는다**(D6): ① 본인 파일이 종류와 달리 읽을 수 없는 모양(영구), ② 발급·읽기 사이 1초 안쪽에 지워진 파일, ③ 라우트 뒤 보관소(Drive)의 읽기 실패, ④ 행이 말한 길이와 보관소 바이트 길이의 불일치. 요청자에게는 「읽을 수 없는 형식이에요… 다시 만들어 올려 주세요」로 말하므로 ②~④(보관소가 잠깐 아프거나 행과 보관소가 어긋난 본인 파일)에서는 문구가 틀리다. 본인 파일이라 새는 것은 없고, ②의 창은 아주 좁지만 ③은 보관소 장애가 계속되는 동안 이어질 수 있다. 워커가 직접 읽는 길(`drive_unavailable` → 「잠시 뒤에」)과 같은 보관소 실패가 다르게 말해지는 것도 이 때문이다. **이월(후속 이슈)**: 라우트가 **토큰을 푼 뒤**의 거절만 모양을 나눈다. 보관소 읽기 실패·길이 불일치를 404가 아닌 상태로 답하면, 워커는 이미 404 밖의 상태를 `drive_unavailable`로 읽으므로(증보 3 D6) 워커 쪽은 바꿀 것이 없다. 풀기에 성공한 호출자는 토큰을 이미 증명했으므로 이 신호가 존재·크기 판정을 새게 하지는 않는다. 다만 이것은 증보 3이 Accepted로 못 박은 라우트의 「거절 한 모양·예산」(404만 호출 주소의 거절 예산을 쓴다)을 바꾸고, 적합성 시험 `self_media_conformance_pg::every_refusal_is_one_identical_404_that_never_reads_drive`가 보관소 miss까지 같은 404임을 단정한다. 공개 라우트의 계약 변경이라 이 증보의 범위 밖이다. **→ 이 이월은 증보 6 A(#5072, Proposed)가 닫는다.**

### runtime-unverified

실제 공급자(Anthropic·OpenAI)에 그림을 실은 호출, 실제 Railway 사설망 위의 글·PDF 읽기, 한글 글꼴 PDF의 글자 뽑기, 컨테이너 메모리 한도(`docker run --memory`) 아래에서 워커가 사는지 — Linux에서 `/proc`·`RLIMIT_AS`·`oom_score_adj`·`RLIMIT_CORE`(`/proc/<pid>/limits`의 `Max core file size` 행)를 읽는 시험은 CI(Linux)가 처음 돌리고, macOS 개발 기계에서는 감독자의 읽기와 자식의 스레드 수(`ps -M`)와 코어 한도(자기 재실행 프로브)를 진짜 프로세스로 쟀다. **코어가 많은 호스트에서 자식이 실제로 읽히는지**(`TOKIO_WORKER_THREADS`를 크게 준 수동 실행의 종료 상태, `/proc/<pid>/status`의 `VmSize`·`Threads`)는 Linux 컨테이너에서 재지 않았다. 스레드가 둘뿐인 것은 이 Mac에서 쟀고, 그것이 상한 안에 들어온다는 것은 계산이다. 시험은 127.0.0.1 TCP, 실 PG18(두 테넌트, `momo_app`·`momo_worker`·`momo_helper_read`), 진짜 라우터, 진짜 자식 프로세스(워커 바이너리)로 했다.

### red proof

| 결정 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| D1 소유·한 문장 | `team_ai_files_conformance_pg::every_refusal_of_a_file_that_is_not_the_requesters_is_the_same_not_found_and_reads_no_byte`, `…::a_file_the_requester_owns_but_cannot_have_read_gets_an_honest_sentence`, `…::the_audience_rule_is_a_line_of_its_own`, `…::the_lookup_refuses_to_run_as_anything_but_the_helper_read_role`, `…::a_server_that_cannot_read_the_file_says_so_honestly` | 작성자·대화·살아 있는 메시지·완료 술어 중 하나를 지우면, 크기·종류 갈래를 지우면, 청중 규칙 줄을 지우면, `momo_helper_read` 확인을 지우면, api 실패를 다른 문구로 매기면 |
| D1 용도 | `agent_avatar::read_use_tests::only_the_lookup_use_has_no_type_narrowing` | 다른 용도의 목록을 비우면 |
| D2·D3·D4·D6 | `attachment_via_api_conformance_pg::a_text_file_a_pdf_and_a_picture_come_back_through_the_route_for_a_read`, `…::the_read_use_refuses_what_the_mint_the_route_and_the_worker_must_refuse`, `self_media::tests::the_avatar_read_takes_pictures_only_and_the_helpers_read_takes_its_own_types`, `team_ai_files_conformance_pg::the_archive_path_is_sniffed_too` | 읽기 발급을 아바타 판정으로 하면, 풀기를 아바타로 하면, `%PDF-`·NUL 규칙을 지우면, 워커 fetch가 종류를 안 보면, 워커의 길이·sniff 재확인(보관소 길)을 지우면, 아바타 발급을 넓히면 |
| D4 단위 | `self_media::tests::the_sniff_checks_pdf_and_text_too` | `bytes_match_mime`의 PDF·글 갈래를 지우면 |
| D7 | `team_ai_files_conformance_pg::a_pdf_is_read_by_the_supervised_child_and_a_scan_or_a_broken_one_says_so`, `…::a_pdf_is_never_parsed_in_the_workers_own_process`, `attachment_text_child::*`(진짜 자식 프로세스), `attachment_text::tests::*`, `team_ai_attachments::tests::*`, `team_ai_tools::tests::a_document_renders_to_twenty_thousand_characters_and_cannot_close_the_fence` | 자식을 못 띄울 때 워커 안에서 파싱하면, 자식의 빈 환경·마감 뒤 kill·회수·슬롯 둘 중 하나를 지우면, 문서 글자의 줄바꿈·제어·울타리·20,000자 중 하나를 지우면 |
| D7 메모리 | `attachment_text_child::a_stream_that_inflates_far_past_its_size_is_ended_by_the_memory_watch`(진짜 자식·진짜 스트림), `attachment_text::tests::the_resident_size_is_read_from_what_the_platform_prints`, `…::a_live_process_has_a_resident_size_and_a_gone_one_has_none`, `attachment_text_child::a_child_confines_itself_before_it_reads_a_byte`(Linux: `/proc`에서 `oom_score_adj`·주소 공간 상한을 읽는다), `…::a_child_ends_itself_at_its_own_deadline_when_nothing_ends_it`, `attachment_text::tests::the_watchdog_fires_at_its_deadline_and_not_before` | 감독자의 감시를 경주에서 빼면, 상한 비교를 지우면, 자식의 자기 구속·워치독을 지우면, 읽기 파서를 틀리게 하면 |
| D7 순서(런타임 앞, 2회차) | `attachment_text_child::the_child_confines_itself_before_any_thread_pool_exists_and_still_reads`(진짜 워커 바이너리를 `TOKIO_WORKER_THREADS=64`로 자식으로 띄워, 입력을 기다리는 동안의 스레드 수가 둘이고 평범한 PDF는 읽힌다) | 자식 갈래를 런타임을 만든 뒤로 옮기면(스레드 66) |
| D7 코어 덤프(2회차) | `attachment_text::tests::a_child_leaves_itself_no_core_dump`(자기 재실행 프로브, 소프트·하드 0), Linux: `attachment_text_child::a_child_confines_itself_before_it_reads_a_byte`의 `Max core file size` 행 | `RLIMIT_CORE` 줄을 지우거나 소프트만 낮추면 |
| D7 출력·슬롯 | `attachment_text_child::a_well_formed_answer_over_the_output_cap_is_refused`, `…::both_slots_stay_taken_while_two_real_children_run` | 출력 상한(`take`와 길이 검사)을 지우면, 슬롯을 자식 회수 전에 돌려주면 |
| D8 | `team_ai_files_conformance_pg::a_picture_reaches_the_model_as_a_structural_part_once_and_never_as_text`, `…::a_wire_that_cannot_see_pictures_says_so_and_reads_nothing`, `attachment_image::tests::*`, 와이어 단위 시험 | 부품이 아니라 글로 실으면, 한 요청 한 그림 규칙을 지우면, 다시 인코딩을 지우면(메타데이터 시험), chat/completions를 열면 |

사보타주를 실제로 돌린 결과는 PR 본문이 정본이다.

## 증보 5 (2026-11-02, #4585): 큰 파일·영상 — 개당 300 MiB, 이어 올리기, 구간 읽기(206), 스트림 주소, 포스터

개당 한도를 100 MiB에서 300 MiB로(메시지당 합계 600 MiB) 올리되 **순서를 지켜서** 올린다. 구간 읽기와 스트리밍(C3) → 데스크탑 청크 전송(#4639)·청크 이어 올리기(C4)·폰 청크(#5121) → 회수·사용량(C6) → 마지막에 기본값 스위치다. 업로드는 로컬 보관소가 Google 재개 업로드의 모양(8 MiB 청크, `Content-Range`, `308`)을 따라 하고, 읽기는 `Range`·`HEAD`(206·416)를 받으며, 웹·데스크탑의 영상 재생은 10분짜리 스트림 주소(요청마다 읽기 술어를 다시 판정)로 한다. 포스터와 길이는 보내는 기기가 만들어 PG에 두고, 회수는 증보 2의 청소기에 가지 둘(지운 메시지의 파일, 7일 넘은 미완료·실패 행)을 더한다. **이 증보는 문서뿐이고 구현은 하지 않는다.** 뒤 칸 #4671·#4672·#4673·#4674·#4675가 이것을 계약으로 쓴다. 이슈·계획 본문이 말하는 「증보 3」은 이 증보다(번호는 착륙 순서라 #4934·#4970이 3·4를 먼저 썼다).

- Status: **Accepted** (2026-11-02, #4585 worker 기안 → planner 수락. [ADR-0100](0100-decision-governance.md)의 위임으로 planner가 결정했다. 독립 설계 검토 1회차는 Blocker 0·High 0·Medium 10·Low 12에 「Accepted 가능」 의견이었고, Medium 1·2·3·5·6·10은 이 본문에 반영했으며(`64cf59794`) 나머지는 아래 「슬라이스별 수용 기준」으로 옮겼다. C3b의 정책 파일(`claims.yaml`) 변경과 보안 경계 확장은 #5120에서 owner의 exact-head 감사를 받은 뒤에만 머지한다). 근거: owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」와 10-27 「권장대로 해봐」가 **개당 300MB·메시지당 600MB, 만료 없는 보관 + 회수·사용량, 웹 서명 주소, 데스크탑 앱 안 재생**을 정했다. 아래에서 **(owner 결정)**은 그 넷이고 **[권장]**은 그 틀 안에서 이 문서가 고른 세부라 검토에서 뒤집을 수 있다. 등급 2: 공개 API 계약·보안 경계·DB 계약이 바뀐다.
- **변경 전**: 2026-11-02, track/engine `195c304f3`의 코드를 읽어 확인한 사실이다.

  | 항목 | 지금 | 자리 |
  |---|---|---|
  | 한도 | 개당 100 MiB, 메시지당 20개. **합계 한도는 없다**(20×100 MiB가 된다) | `attachment.rs:67,71` |
  | 업로드 | 한 번의 PUT이 한 업로드다. 세션은 1회용·1시간이고 재시작이 `sessions/`·`incoming/`를 지운다 | `momo-drive/lib.rs:91`, `local.rs` 머리말(#2615·#2628), `routes/attachments.rs` `stub_upload` |
  | 엣지 | Railway는 요청 본문이 5분 안에 끝나야 하고 한 요청은 데이터가 흐르면 최대 15분이다(공식 문서, 2026-11-02 확인). 300 MiB 단일 PUT은 지속 약 8.4 Mbit/s가 필요하고, 같은 크기의 응답은 2.8 Mbit/s 아래로 받으면 15분을 넘긴다 | `momo-drive/lib.rs:80-84`의 같은 기록 |
  | 읽기 | content는 200 전체뿐이다. `Range`를 읽지 않고 `HEAD`는 axum 0.8이 GET 핸들러를 돌려 본문만 버린다 | `routes/attachments.rs` `content`, `lib.rs:989` |
  | 로컬 보관소 | `file_content`가 **아카이브 락 안에서** `fs::read`로 파일 전체를 메모리에 올린다. 한도가 300 MiB면 동시 읽기마다 300 MiB다 | `local.rs:511` |
  | Google 보관소 | 메타 호출과 `alt=media`, 상류 호출이 둘이고 `Range`를 넘기지 않는다 | `google.rs:472` |
  | 재생·포스터 | 앱 안 영상 재생이 없고 폰 picker는 사진 전용이며 `expo-video`가 없다. `attachment` 행에는 길이·치수·포스터가 없다 | `clients/mobile/package.json`, `attachment.rs` |
  | CSP | 웹 엣지 Caddyfile 넷은 `default-src 'self'`이고 `media-src`가 없다. 데스크탑은 번들 오리진이라 서버의 영상이 `default-src 'self'`에 막힌다 | `infra/rust/Caddyfile`·`.local`·`.host-network`, `infra/railway/Caddyfile.railway`, `tauri.conf.json:32` |
  | CORS | 허용 요청 헤더는 고정 목록(`content-range` 없음)이고 노출 헤더는 `retry-after` 하나다. 이 층은 `build_app` 맨 바깥이라 업로드 PUT에도 닿는다 | `cors.rs:68,75`, `lib.rs:2471` |
  | 회수 | 묶이지 않은 완료 첨부만 거둔다(30일, 기본 꺼짐). 지운 메시지에 묶인 바이트와 `pending`·`failed`는 안 거둔다 | 증보 2 |
  | 데스크탑 | 다운로드는 IPC 한 덩이 100 MiB이고 64 MiB 한 건에 메모리가 +569 MiB 선다(실측) | [ADR-0133](0133-ui-stack-tauri-react-migration.md) 증보 D7, `downloads.rs:76` |

### 결정

- **D1 · 한도: 천장 300 MiB, 기본값은 마지막에 올린다, 메시지당 합계 600 MiB** (개당 300·합계 600은 owner 결정, 나머지는 [권장]).
  - **천장은 코드·DB·계약의 한 값이다: 300 MiB(314,572,800 B).** DB CHECK `attachment_size_ck`, Rust 상수, openapi `maximum`, TS 상수가 같은 값이다. 화면 표기는 「300MB」다(`model.ts`의 관례: 100 MiB가 「100 MB」로 찍힌다).
  - **기본값(`DEFAULT`)은 스위치 전까지 100 MiB다.** 능력(천장·청크·구간 읽기)과 노출(기본값)을 나눈다. 실효 개당 한도는 `MOMO_ATTACHMENT_MAX_BYTES`(운영자 값, 선택) 또는 `DEFAULT`다. 운영자 값은 [1 MiB, 천장] 안이어야 하고 해석할 수 없거나 범위 밖이면 무시하며 기동 때 변수 **이름**만 경고한다(값은 찍지 않는다. 증보 3 D5와 같은 규칙). 운영자는 스위치 전에도 값을 올려 먼저 켜 보고, 셀프호스터는 낮출 수 있다. **스위치**는 `DEFAULT`를 300 MiB로 바꾸는 한 줄 PR이고 D8의 순서가 끝난 뒤 planner가 올린다.
  - **메시지당 합계 600 MiB(천장의 2배), 개수 20은 그대로다.** 합계는 `link_attachments_in_tx`와 `reserve_attachments_in_tx`가 **둘 다**, 행을 `FOR UPDATE`로 잠근 뒤 같은 함수 하나로 판정하고, 넘으면 어떤 `UPDATE`·`INSERT`도 하기 전에 413으로 거절한다(예약 발송·에이전트 deliver는 같은 척추다). 먼저 모두 잠그고 합산한 뒤 쓴다(지금의 `link`·`reserve`는 행 하나씩 잠그며 검사와 갱신을 섞으므로 바꾸는 일이 따라오고, `ORDER BY id`로 잠그면 데드락도 줄어든다). 운영자 값 `MOMO_ATTACHMENT_MAX_MESSAGE_BYTES`(선택)는 [실효 개당 한도, 600 MiB] 안이다. **합계는 스위치 전에도 적용된다**(지금은 20×100 MiB가 된다).
  - **클라이언트가 한도를 아는 길**: `GET /v1/workspaces/{ws}/attachment-limits`(인증된 멤버 누구나. 설정 가방 `getWorkspaceSettings`는 owner·admin 전용이라 못 쓴다)가 `maxFileBytes`·`maxMessageBytes`·`maxFiles`·`chunkBytes`(없으면 `null`)를 준다. 값은 실제 거절에 쓰는 **같은 함수**에서 나온다(광고와 집행이 어긋날 수 없다). 413의 문장도 그 함수가 숫자를 찍는다. 이 응답이 없는 서버에서는 클라이언트가 100 MiB·20개로 돌아간다.
  - **DB CHECK는 천장과 같은 300 MiB로 넓힌다**(새 migration, 번호는 착수 때 planner가 준다). 넓히기만 하므로 기존 행이 모두 통과하고, 마이그레이션이 앱보다 먼저 도는 기존 배포 순서에서 안전하다. 300 MiB 행이 생긴 뒤에는 좁힐 수 없으니 되돌릴 때 CHECK는 그대로 둔다. 다음 상향도 새 ADR과 migration이다(CHECK를 더 크게 두는 안은 비교표).
  - **「팀 설정」은 두지 않는다.** 한도는 인스턴스(운영자) 값이고 워크스페이스별 값은 저장할 자리도 화면도 없다. 필요해지면 `workspace.settings` 키로 **내리는** 값만 더할 수 있다(천장·운영자 값을 못 넘는다). 이월.
  - **TS에는 값이 둘이다.** 천장(`ATTACHMENT_CEILING_BYTES`, 300 MiB)과 서버가 알려 주지 않을 때의 기본(`MAX_ATTACHMENT_BYTES`가 100 MiB로 남는다)이다. 데스크탑 IPC 상한을 TS 상수에 묶는 기존 시험(`downloadsContract.test.ts`)은 지금 `MAX_ATTACHMENT_BYTES`와 `MAX_DOWNLOAD_BYTES`가 같다고만 잰다. C4가 천장을 새 상수로 들이면 이 시험은 초록 그대로이고 가드가 조용히 사라지며, 그 「같음」을 맞추는 가장 쉬운 길이 `MAX_DOWNLOAD_BYTES`를 300 MiB로 올리는 것인데 그것이 +2.6 GiB 메모리(남는 위험 15)를 여는 수정이다. 그래서 **#4639 PR이** TS 천장 상수를 먼저 들이고(값은 아직 100 MiB) 이 시험을 그 상수에 다시 묶는다(IPC가 한 덩이가 아니라 청크 전송이라는 사실도 시험이 읽는다). 그 뒤 천장을 300 MiB로 올리는 C4-2 PR은 IPC가 청크가 되기 전에는 이 시험에서 빨개진다. **순서는 슬라이스 의존(C4-2 ← #4639)으로 지키고, 시험은 그 의존을 뒷받침하는 장치이지 단독으로 순서를 강제하지는 않는다.**
  - **읽기와 회수는 천장 기준이다.** 운영자가 실효 한도를 300 MiB에서 100 MiB로 낮춰도 이미 `complete`인 200 MiB 파일은 읽히고 회수된다. 실효 한도는 **올리기(create·PUT 본문·`complete`의 재측정)에만** 적용하고 `content`와 청소기는 천장을 쓴다. 지금 `content`가 `file_content(.., MAX_ATTACHMENT_BYTES)`를 쓰므로, 구현이 실효 한도를 거기에 넘기면 낮춘 순간 큰 파일이 `ContentTooLarge`가 된다.
  - **한도가 박힌 곳 전수** (상향 때 한 묶음으로 바뀐다):

  | # | 자리 | 값 | 상향 때 |
  |---|---|---|---|
  | 1 | `server/Migrations/017_attachment.sql:23` `attachment_size_ck` | 104857600 | 새 migration으로 300 MiB |
  | 2 | `momo-messaging/src/attachment.rs:67` | 100 MiB | 천장 상수와 실효 한도 함수 |
  | 3 | `momo-drive/src/lib.rs:63`과 사용처(`ReceivedLength`, `local.rs`, `stub.rs:121`, `google.rs`, `routes/attachments.rs`) | 100 MiB | 같은 값. 보관소가 상수 대신 실효 한도를 설정으로 받는다 |
  | 4 | `routes/attachments.rs:132`의 문장 「at most 100 MB」와 시험 `attachment_conformance_pg.rs:1674,1679` | 문장 | 한도 함수가 숫자를 찍는다 |
  | 5 | `momo-workspace-actions/src/team_ai_attachments.rs:57` `TABLE_MAX_BYTES` | 104_857_600 | 같은 값. 안 올리면 요청자 본인의 큰 파일이 「너무 커요」 대신 「못 찾아요」가 된다 |
  | 6 | `docs/api/openapi.yaml`: `CreateAttachmentUploadRequest.size`(25947)·`Attachment.size`(26026)·`MessageAttachment.sizeBytes`(26318)의 `maximum`, 413 설명 둘(11442·11495), `size` 설명의 「100 MB」 | 104857600 | 같은 값 |
  | 7 | `packages/momo-core/src/features/attachments/model.ts:52` `MAX_ATTACHMENT_BYTES`와 `:231`의 「100MB를 초과함」 | 100 MiB | 천장과 기본으로 나눈다. 문구는 숫자를 받는다 |
  | 8 | `clients/desktop/src-tauri/src/downloads.rs:76` `MAX_DOWNLOAD_BYTES`(IPC 한 덩이) | 100 MiB | #4639가 청크 전송으로 바꾼 뒤 |
  | 9 | `clients/desktop/src-tauri/src/pdf_viewer.rs:61` `MAX_PDF_BYTES` | 100 MiB | **올리지 않는다.** 뷰어 메모리 한도이지 첨부 계약이 아니다. 더 큰 PDF는 내려받기로 간다. 주석·시험의 「첨부 상한과 같다」를 고친다 |
  | 10 | `clients/web/gates/gate-attachment.mjs:1021` | 시험 값 | 천장 + 1 |

  - **한 시험이 이 자리들을 같이 잰다.** 지금의 `the_ceilings_agree_with_the_check_constraint`는 Rust 상수 둘과 리터럴 하나만 맞추고 SQL·openapi·TS를 읽지 않는다. 새 시험은 마이그레이션 SQL의 CHECK, openapi `maximum` 셋, TS 천장, Rust 상수 둘을 읽어 **같은 천장**임을 단정한다(한 곳만 바꾸면 빨강).
- **D2 · 이어 올리기** (로컬 백엔드, C4) [권장]. Railway는 요청 본문이 5분 안에 끝나야 해서 300 MiB 단일 PUT은 지속 8.4 Mbit/s가 필요하다. 8 MiB 조각은 5분 안에 끝나는 데 0.22 Mbit/s면 된다. 규약은 Google 재개 업로드의 모양이다(상태 조회와 `308`·`Range`). 같은 클라이언트 코드가 두 백엔드를 다루게 하려는 것이다.

  | 업로드 주소로 보내는 `PUT` | 응답 |
  |---|---|
  | `Content-Range` 없음 | 지금과 같다. 한 번의 전체 본문(옛 클라이언트, 아바타·이모지 조립 흐름). 성공은 `200`, 빈 본문. 이미 조각을 받기 시작한 세션에는 `409`(그 세션은 조각으로만 끝낸다) |
  | 올바른 조각: `Content-Range: bytes a-b/N`에서 `a`가 받은 길이, `N`이 선언 크기, 본문이 `b-a+1` 바이트이고, 마지막 조각이 아니면 `b-a+1`이 `chunkBytes`다 | 마지막이 아니면 `308` + `Range: bytes=0-b`. 받은 길이가 `N`이 되면 공개(세션 소진 → 메타 → 객체, 현행 순서) 뒤 `200` |
  | `a`가 받은 길이와 다르다(앞 조각의 응답이 유실된 경우) | 바이트를 쓰지 않고 `308` + 실제로 받은 만큼의 `Range`. 받은 것이 없으면 `Range` 헤더가 없다 |
  | `Content-Range: bytes */N`, 빈 본문(상태 조회) | `308` + 받은 만큼의 `Range` |
  | `Content-Range`의 문법 오류, `b`가 `N` 이상, 본문 길이가 `b-a+1`과 다름, 마지막이 아닌 조각의 크기가 `chunkBytes`가 아님, 선언 크기가 0(모르는 크기)인 세션에 `Content-Range` | `400`, 바이트를 쓰지 않는다(쓰던 조각은 되감는다). 청크는 선언 크기가 있어야 한다 |
  | 모르는·만료된·소진된 세션 | `404`, 현행과 같은 한 모양 |
  | 세션 주소로 `DELETE` | 성공은 `204`(세션·파트 삭제, 진행 중인 조각 PUT은 404로 끝난다). 모르는·만료·소진된 세션은 같은 `404`이고 클라이언트는 둘 다 끝난 것으로 읽는다 |
  | 같은 세션의 동시 둘째 `PUT` | `409`. 앞 조각이 끝나거나 조각 본문 유휴 제한(30초)이 지나야 한다. 클라이언트는 백오프(1·2·4초, 상한 30초)로 다시 시도한다 |

  - **`chunkBytes`는 8 MiB**(256 KiB × 32. Google의 256 KiB 배수 규칙을 지킨다). 마지막 조각만 더 작을 수 있다. `createAttachmentUpload` 응답의 선택 필드 `chunkBytes`가 있을 때만 클라이언트가 조각으로 올리고, **로컬 백엔드만 이것을 광고한다.** Google·stub은 광고하지 않아 단일 PUT이다. 브라우저가 Google 세션 주소에 `Content-Range` PUT을 보낼 때의 CORS 프리플라이트를 확인하지 못했기 때문이다(Google 청크는 이월).
  - **단일 PUT은 그대로 받는다.** 옛 클라이언트와, `putAttachmentBytes`로 단일 PUT을 보내는 아바타·이모지 조립 흐름(웹 `makeFlow.ts`·`uploadMyAvatar.ts`·`WorkspaceSection.tsx`)이 있다. `chunkBytes`는 첨부 `createAttachmentUpload`의 응답에만 더하고 아바타 업로드 응답은 그대로다. 응답 필드는 가산이라 옛 클라이언트는 모른다.
  - **순서와 되감기.** 조각은 순서대로, 세션당 한 번에 하나다. 조각 하나가 끝까지 도착하지 못하면(연결 끊김·길이 불일치) 파트 파일을 이전 길이로 되돌리고 받은 길이는 늘지 않는다. 응답은 파트에 다 쓴 뒤에만 나간다. 아카이브 락은 세션 상태 전이와 공개에만 쓰고 본문을 쓰는 동안은 쥐지 않는다(현행 `stream_into`와 같다). 공개는 파트 `sync_all` 뒤 rename이다(현행 `stream_into`는 `flush`만 하고 300 MiB는 더러운 페이지 창이 커서, 호스트가 갑자기 죽으면 PG가 `complete`로 믿는 객체가 잘려 있을 수 있다).
  - **조각 본문 유휴 제한.** `axum::serve`에는 요청 본문 읽기 시간 제한이 없다(`main.rs:470`, 요청 시간 제한 층이 없다). 연결이 끊겼는데 서버가 모르는 동안 앞의 PUT이 세션을 「바쁨」으로 쥐면 클라이언트의 상태 조회와 재시도가 409를 받는다. 이어 올리기가 있는 이유가 바로 그 순간이므로, 조각 본문의 **바이트 사이 침묵이 30초**(권장, 30~60초)를 넘으면 그 조각을 되감고 세션을 놓는다. 총 시간 제한이 아니라 유휴 제한이다(느린 회선의 8 MiB가 5분 걸려도 바이트가 흐르는 동안은 산다). 409는 재시도할 수 있고 클라이언트는 백오프한다(1·2·4초, 상한 30초).
  - **세션 수명은 두 마감이다.** 유휴 1시간(조각이 받아질 때마다 미끄러진다. 첫 조각 전에도 만든 뒤 1시간이라 단일 PUT 클라이언트에게는 지금과 같다)과 절대 6시간(만든 때부터. 300 MiB를 지속 0.12 Mbit/s로도 끝낼 수 있는 값이다). 만료·소진·모르는 세션은 모두 같은 404다. 세션 파일은 절대 마감 필드를 더하고, 그 필드가 없는 옛 세션 파일은 조각을 받지 않는다.
  - **308에는 `Location`이 없다.** HTTP에서 308은 영구 리디렉션이라 `Location`이 붙으면 `fetch`·XHR·URLSession이 따라간다. Google의 「308 Resume Incomplete」도 `Location` 없이 `Range`만 싣는다. 308 응답의 헤더 목록을 고정하고 시험이 `Location` 없음을 단정한다.
  - **CORS.** `cors.rs`의 허용 요청 헤더는 의도적으로 고정이라(요청 헤더를 반사하지 않는다) 데스크탑(번들 오리진이 API 오리진과 다르다)의 청크 PUT은 프리플라이트에서 막힌다. 허용 목록에 `content-range`·`range`를, 노출 목록에 `range`·`content-range`·`accept-ranges`를 더한다(지금 노출은 `retry-after`뿐이라 교차 오리진 클라이언트가 308의 `Range`를 읽지 못한다). 고정 목록의 변경이므로 C4의 독립 보안 검수 범위다. 같은 오리진인 웹은 해당 없다.
  - **멤버당 열린 세션 4개.** 보관소가 **살아 있는 세션**을 센다(세션 파일에 만든 멤버를 적고, `create_resumable_upload`가 멤버를 받도록 시그니처가 바뀐다. 로컬만이고 아바타 업로드의 세션도 몫에 든다). 상한에 닿았을 때 같은 멤버의 세션 중 **마지막 바이트 뒤 60초가 넘은 가장 오래된 세션**이 있으면 그것을 접고(세션·파트 삭제) 새 세션을 만든다. 그런 세션이 없으면(넷 모두 60초 안에 움직였다) 429(`too many open uploads`)이고 행도 파일도 만들지 않는다. 남의 세션은 접지 않는다. 만료·소진·재시작·접기·`DELETE`로 사라진 세션은 세지 않으므로 끊긴 시도가 몫을 쥐지 않는다. `pending` 행으로 세지 않는 까닭: 재시작이 세션을 지워도 행은 남아 정상 사용자를 막고, 행이 오래돼도 조각으로 살려 둔 세션은 상한을 빠져나간다. 지금의 시작 예산(분당 60)과 별개다. 클라이언트는 파일을 하나씩 올리므로 정상 사용은 1~2개다.
  - **중단한 세션은 곧 돌려준다.** 웹은 칩을 지우면 `abort`로 세션을 버리고(`dropDraft`) 실패한 칩을 다시 시도하면 새 세션을 만든다(`retryDraft`). 지금은 상한이 없어 문제가 없지만 상한이 생기면, 중단한 시도가 유휴 1시간을 다 채우는 동안 불안정한 회선에서 다섯째가 막히는 회귀가 된다. 그래서 둘을 함께 둔다. ① **세션 주소 `DELETE`**(Google 재개 업로드의 취소와 같은 모양): 성공은 `204`이고 모르는·만료·소진된 세션은 같은 `404`다. 클라이언트는 중단·실패 때 부른다. `DELETE`는 CORS 허용 메서드에 이미 있다(`cors.rs`). ② 위의 **접기**가 `DELETE`를 부르지 못한 중단(앱이 죽음)을 받는다.
  - **디스크 예약(로컬만).** 새 세션은 `여유 − 열린 세션들의 남은 바이트(선언 − 받은) ≥ 선언 + 1 GiB`일 때만 만든다. 선언이 0(모름)인 세션은 실효 한도를 선언으로 쳐서 예약한다. 아니면 507(`storage is full`, 새 `DriveError`)이고 `attachment` 행도 세션 파일도 만들지 않는다. 조각을 쓰다 `ENOSPC`가 나도 507이고 파트는 되감는다. 여유는 볼륨의 `statvfs`다(D7). 시험이 결정적이도록 여유를 읽는 함수를 주입할 수 있어야 한다.
  - **파트는 요청을 넘어 산다 → 청소가 필요해진다.** 지금의 `PartFile`은 요청이 끝나면 지워진다. 청크의 파트는 세션과 같이 살고 세션이 만료·소진되면 지운다. 접근 때 지우는 현행 방식에 더해 60초 주기 청소가 만료된 세션의 파트와 세션 파일을 지운다(보관소 안의 일이라 DB가 필요 없다).
  - **재시작은 세션과 파트를 지운다(#2628 그대로).** 배포가 업로드를 끊으면 클라이언트는 상태 조회에서 404를 받고 0부터 다시 한다(남는 위험). **이월**: 재시작을 건너는 이어 올리기. 그 모양이라면 세션은 살리지 않고 파트만 살리며, 새 주소는 PG가 첨부를 `pending`으로 확인한 **인증 호출**로만 내준다. 주소가 파트를 새로 만들 수 없으므로 복원된 스냅샷이 이미 `complete`인 파일 id를 채우는 위험(`local.rs` 머리말, #2628)은 다시 열리지 않는다. 이 증보는 이것을 정하지 않는다.
  - **`complete`는 그대로**다(측정 크기·mime 대조). 다만 실효 한도로 다시 잰다. **마지막 조각의 응답이 유실되면** 클라이언트는 상태 조회에서 404를 받는다(세션이 소진됐다). 그때는 `complete`를 부른다. 멱등이라 객체가 있으면 200, 없으면 404 또는 409이고 그러면 처음부터 한다.
  - **바뀌는 불변식**: `momo-drive/lib.rs:80-91`의 「한 요청이 한 업로드」 전제와 「요청이 끝나면 파트를 지운다」는 규칙은 이 절이 **청크에 한해** 바꾼다(단일 PUT은 그대로). 바뀌지 않는 것은 재시작이 세션을 지우는 규칙, 공개된 객체를 어떤 세션으로도 덮어쓰지 않는 규칙, 공개 때 세션이 소진되는 규칙이다. `UPLOAD_SESSION_TTL`의 주석(「이 경로에는 재개 프로토콜이 없다」)은 C4가 고친다.
- **D3 · 구간 읽기와 HEAD** (C3) [권장]. Bearer content 경로가 `Range`와 `HEAD`를 받는다.
  - **판정 순서가 계약이다.** ① 인증 ② 활성 채널 멤버 ③ 읽기 술어(`load_readable_attachment_in_tx`) ④ `status = complete`를 지난 **다음에** `Range`를 해석한다. ①~④가 실패하면 `Range`가 있어도 지금의 응답(비멤버 403, 그 밖은 같은 404)과 상태·본문이 같다. 416은 **읽을 수 있는 파일에만** 나가므로 `Range`가 파일의 존재·크기를 묻는 오라클이 되지 못한다.

  | 요청 | 응답 |
  |---|---|
  | `Range` 없음 | `200`, 전체, `Content-Length`와 `Accept-Ranges: bytes` |
  | 단일 범위 `bytes=a-b`·`bytes=a-`·`bytes=-n`이고 만족할 수 있다 | `206`, `Content-Range: bytes s-e/크기`, `Content-Length: e-s+1`, 그 구간의 바이트만. `e`가 크기를 넘으면 `크기-1`로 줄이고 `-n`의 n이 크기 이상이면 전체 구간이다 |
  | 만족할 수 없다(`a`가 크기 이상, `-0`) | `416`, `Content-Range: bytes */크기`, 본문은 오류 JSON |
  | 다중 범위, 모르는 단위, 문법 오류, `If-Range`가 붙은 요청, 크기 0 | `Range`를 무시하고 `200` 전체. RFC 9110이 무시를 허용한다. 검증자(ETag·Last-Modified)를 내지 않으니 `If-Range`는 맞을 수 없다. 다중 범위를 멀티파트로 풀면 겹치는 범위로 응답이 부풀 수 있어 풀지 않는다 |
  | `HEAD` | 같은 판정 뒤 같은 헤더에 본문 0바이트. 보관소를 읽지 않는다 |
  | 그 밖의 메서드 | `405` |

  - **정수는 검사된 산술로 읽는다.** `Range`의 수와 `Content-Range`의 `a`·`b`·`N`은 u64를 넘는 자릿수와 `b-a+1`의 덧셈 넘침이 가능하다. 자릿수 상한(20자리)과 검사된 산술로 읽고, 넘으면 `Range`는 문법 오류로 보고 무시하며(200) `Content-Range`는 400이다.
  - **헤더.** 200·206·416·HEAD 모두 `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store, no-transform`, `Accept-Ranges: bytes`다. **인라인 렌더 금지는 그대로다.** 206도 `attachment`다. 미디어 요소는 보통 disposition을 무시해 재생은 되고 주소창으로 열면 내려받기가 된다(미검증). `no-transform`은 엣지의 압축·변형을 막으려는 새 항목이다(아래 엣지).
  - **헤더의 크기·mime은 DB 행에서 나온다**(`size_bytes`, `mime`). GET·HEAD·206이 한 곳에서 나온다. `complete`가 측정 크기를 기록하고 보관소가 같은 크기를 말해야 완료되므로 행이 곧 보관소의 사실이다. 보관소가 말하는 총 길이가 행과 다르면 502로 닫는다(Google은 상류 `Content-Range`의 총량과 대조한다).
  - **보관소에 구간 읽기를 더한다**(`DriveArchive`, 세 백엔드). 로컬은 파일을 열어 시크한 뒤 구간만 청크 단위(64 KiB~1 MiB)로 흘리고 **스트림 동안 아카이브 락을 쥐지 않는다**(지금은 락 안에서 `fs::read`로 전체를 읽는다). Google은 상류에 **서버가 파싱·정규화한 `bytes=s-e` 하나**만 넘기고(클라이언트 원문·다중 범위·긴 값은 상류로 가지 않는다) 상류의 206·416을 옮기며, 크기를 DB가 알려 주므로 지금의 선행 메타 호출을 생략한다. 지금의 `CONTENT_TIMEOUT`(60초, `google.rs:62,491`)는 요청 전체 시간 제한이라 본문을 다 받을 때까지를 덮는다. 300 MiB는 지속 약 42 Mbit/s가 아니면 60초에 끝나지 않으므로, `Range` 없는 전체 요청과 `bytes=N-`는 이미 `Content-Length`를 보낸 뒤 중간에서 잘린다. **전체 시간 제한을 없애고 연결 시간 제한 + 청크 사이 무응답 제한으로 바꾼다.** stub은 메모리 슬라이스다. 모든 GET이 구간 읽기 하나를 쓴다(구간 없음 = 전체). HEAD는 보관소를 열지 않으므로 HEAD가 200이어도 GET이 보관소 오류일 수 있다(남는 위험). 시그니처는 C3의 몫이고 위의 동작이 계약이다.
  - **메모리는 파일 크기와 무관하다.** 300 MiB 객체 넷을 동시에 읽는 동안 프로세스 RSS 증가가 64 MiB 이하여야 한다(수용기준. Linux `/proc/self/status`, 소비자는 받은 바이트를 버리며 읽는다).
  - **엣지.** Caddyfile 넷이 모두 `encode zstd gzip`을 전역으로 두는데 206·`Content-Range`·영상 mime을 어떻게 다루는지는 확인하지 못했다. `no-transform`으로 막는다. 영상 mime은 Caddy 기본 matcher(텍스트 계열) 밖이라 `no-transform` 없이도 압축되지 않는 것으로 알려져 있다(미확인). 그래서 시험은 **압축되는 mime(`text/plain`) 첨부로 200과 206을 둘 다** Caddy를 앞에 두고 재서(`Content-Encoding` 없음, 206의 `Content-Range`·`Content-Length` 그대로) `no-transform`이 실제로 일을 함을 보인다. Caddy가 필요한 실행 증거라 **스택 검증 줄 몫**이다. 부작용: `text/*` 첨부의 엣지 압축이 꺼진다(의도).
  - **요율.** content 읽기에는 멤버별 요율 제한이 없다(`MemberWrite`는 쓰기 예산이다). 영상이 분당 수십 번 보내는 `Range`가 재생을 막지 않는다. 반대로 한 멤버의 큰 반복 읽기를 막는 장치도 없다(남는 위험). 스트림 주소는 IP가 아니라 **멤버(토큰의 멤버)·인스턴스 단위의 동시 열린 스트림 자리**를 두는 쪽이 맞다(링크 미리보기 프록시의 자리와 환불 `ProxyError::Busy`가 전례, `rate_limit.rs`). 15분 넘게 열려 있는 정지한 `<video>` 연결은 `axum::serve` 종료도 붙잡으므로(`main.rs:470`) 응답당 최대 시간을 둘지 C3b가 정한다.
  - **15분.** Railway는 한 응답을 15분 넘게 두지 않는다. 300 MiB를 2.8 Mbit/s 아래로 받는 클라이언트는 구간으로 받아야 한다(#4639·C7). 서버는 구간 응답을 지원한다.
- **D4 · 스트림 주소** (웹·데스크탑 재생, C3b) (웹 서명 주소·데스크탑 앱 안 재생은 owner 결정, 모양은 [권장]). ADR-0151 D3의 「인가 프록시 단일 경로」에 이 증보가 더하는 **유일한 예외**다. D3는 이제 「단일 인가 함수」로 읽는다. Bearer 경로(`content`)와 능력 경로(`stream`)가 같은 두 함수(`is_attachment_channel_member`, `load_readable_attachment_in_tx`)를 부르므로 두 경로의 판정이 어긋날 길이 없다.
  - **왜 필요한가.** `<video src>`는 `Authorization` 헤더를 못 싣는다. blob은 CSP가 `media-src`에 `blob:`을 열지 않고 300 MiB를 메모리에 올려야 해서 못 쓴다. self-media 주소(1회용)는 `<video>`가 `Range` 요청을 되풀이하므로 둘째 요청에서 죽는다.
  - **발급**: `POST /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/stream-url`, 본문 `{kind}`(`play` 또는 `save`). 사람 bearer만이고(좁은 토큰·에이전트는 403) 멤버당 분당 120회다. 읽기 술어를 **발급 때도** 판정하고(안 되면 content와 같은 403·404), `play`는 저장된 mime이 닫힌 목록일 때만 발급한다. 응답은 `{path, expiresAtMs}`이고 `path`는 `/v1/stream/{ws}/{token}`이다. 클라이언트가 자기 API 기준 주소에 붙인다(서버가 오리진을 만들지 않으므로 Host 파생을 믿을 일이 없다).
  - **공개 경로** `GET`·`HEAD /v1/stream/{ws}/{token}`: 능력 주소가 유일한 권한이다(self-media와 Drive 스텁의 전례). 다른 메서드는 405다. 경로의 `{ws}`는 canonical 소문자 id여야 한다(self-media와 같다).
  - **토큰**은 상태 없는 HMAC-SHA256이다. 키는 서버 비밀(JWT 서명 키)에서 도메인 라벨로 **파생한 전용 키**다(서명 키를 그대로 쓰지 않고 새 비밀 변수도 만들지 않는다). MAC은 {버전, 종류, 워크스페이스, 채널, 첨부, 멤버, 만료}를 덮는다(채널이 들어 있어 판정 함수가 content 경로와 인자까지 같고 추가 질의가 없다). **TTL은 10분이고 그 안에서 여러 번** 쓸 수 있다. 서명은 32바이트 전체를 상수 시간으로 비교하고(잘라 쓰지 않는다) 필드는 고정 폭 바이트로 직렬화한다. 경로의 `{ws}`가 토큰의 워크스페이스와 다르면 DB 전에 404다.
  - **긴 재생.** `<video src>`는 재생 중 다음 구간을 같은 주소로 요청하므로 만료 뒤의 요청은 404다. 클라이언트(C7의 웹·데스크탑, F1의 폰)는 **만료 전(TTL의 80%, 8분)에 새 주소를 받아 `src`를 바꾸고 재생 위치와 재생·일시정지 상태를 복원한다.** 만료를 오류로 알게 된 때도 같은 길로 다시 받는다. TTL을 30분으로 늘리는 쪽은 로그에 남는 주소의 값이 커지므로(비교표) 10분을 유지한다.
  - **요청마다 판정한다.** 서명·만료를 확인하고(DB 앞), 토큰의 멤버·채널로 두 함수와 `status = complete`를 판정하고, 구간 응답(D3과 같은 한 함수)을 낸다. 멤버가 떠나거나 정지·삭제되고, 메시지가 지워지고, 채널이 보관되면 **다음 요청부터** 404다. 이것이 회수 장치이고 TTL은 상한일 뿐이다. **로그아웃·세션 폐기는 이 주소를 끊지 않는다(최대 10분).** 좁은 토큰의 전례(push_fetch·push_action)는 세션 계보에 묶었지만 그 토큰들은 6시간이고, 이 주소는 10분에 파일 한 개 읽기라 행·계보 조회·상한의 비용이 이득보다 크다고 본다(비교표). TTL을 30분 넘게 늘리면 이 판단을 다시 한다.
  - **거절은 한 모양이다.** 모양 틀림·서명 불일치·만료·종류 불일치·비멤버·지운 메시지·남의 초안·없는 파일·허용 목록 밖 mime이 모두 같은 404다(바이트까지 같다. 공개 경로가 멤버십을 말하지 않으므로 403은 없다). 위조 토큰은 DB를 건드리지 않고, 404만 호출 주소(per-IP) 예산을 쓴다. Drive 스텁 게이트(`per_ip_drive_upload`)의 전례를 따라 핸들러가 먼저 판정하고 **살아 있는 주소는 예산이 바닥나도 거절하지 않는다**(엣지 주소 하나가 인스턴스 전체일 수 있어, 가짜 토큰 홍수가 정상 재생을 막으면 안 된다. 핸들러 앞에서 막는 `per_ip_self_media`식은 택하지 않는다).
  - **응답**은 구간 읽기와 같은 함수·같은 헤더에 `Referrer-Policy: no-referrer`가 더해지고 리디렉션은 없다. `play`는 저장된 mime이 `video/mp4`·`video/quicktime`·`video/webm`일 때만 나가고 `Content-Type`은 저장된 mime이다. 이 목록 덕에 주소를 주소창에 열어도 문서가 렌더되지 않는다(`attachment`·`nosniff`에 더한 둘째 겹이다). 목록을 늘리는 것은 이 ADR의 증보 사안이다. `save`(웹의 큰 파일 내려받기: blob 메모리 없이 브라우저 내장 다운로드)는 모든 mime을 받되 `Content-Type: application/octet-stream`으로 고정하고 `Content-Disposition: attachment; filename*=UTF-8''<퍼센트 인코딩한 이름>`을 낸다(이름이 헤더로 쓸 수 없는 값이면 `attachment`만). `save`는 C7이 구현한다. **C3b는 `save` 발급을 400으로 닫아 두고** C7이 연다(종류 바이트는 있는데 동작이 없는 상태를 열어 두지 않는다).
  - **로그·감사.** 토큰은 어떤 로그·감사·오류에도 없다. API에는 공통 요청 로그 층(`TraceLayer`)이 없고(경로를 찍는 줄은 옛 게이트웨이 비밀 경로의 `auth.rs:718` 하나다) Caddyfile 넷에는 접근 로그 지시어가 없다. **Railway의 HTTP 로그는 경로를 남긴다고 전제한다.** 공식 문서의 HTTP 로그 필드에 `path`·`srcIp`·`clientUa`가 있고 보존은 플랜별 3~30일(Enterprise는 최대 90일)이다(공개 도메인 트래픽이 이 로그에 든다는 문장은 문서에 명시돼 있지 않지만 필드가 엣지 트래픽을 가리킨다). 만료된 주소는 로그에 남아도 쓸모가 없고 그래서 TTL 상한이 방어선이다. 셀프호스트가 Caddy `log`를 켤 때의 `request>uri` 삭제 안내(`infra/railway/README.md`)에는 스트림 경로(`/v1/stream/`)도 같이 적는다(C3b). 발급은 감사 행으로 남기지 않는다(분당 120회 재생이 감사를 부풀린다). 대신 **표본 로그 한 줄**(멤버·첨부 id만, 토큰 없음)을 남겨 유출 조사 때 누가 주소를 만들었는지 찾을 수 있게 한다(C3b).
  - **폰**은 같은 주소를 쓰는 것이 [권장]이다. 헤더로 보내는 길(`expo-video`의 `headers`)은 access 토큰이 15분이라 긴 재생·탐색 중에 만료되고, 네이티브 플레이어는 헤더를 에셋을 만들 때 고정한다(미검증).
  - **CSP.** 웹은 같은 오리진이라 `default-src 'self'`가 `media-src`를 덮으므로 **변경이 없다**(웹 Caddyfile 넷과 `gate-csp-deploy.mjs`는 `media-src` 없이 그대로). 데스크탑은 `tauri.conf.json`에 **`media-src 'self' http: https:`**를 더한다. `connect-src`와 같은 모양이다(서버 주소는 사용자가 정하고 셀프호스트는 http일 수 있다). `blob:`은 택하지 않는다(영상 전체를 메모리에 올려야 한다, 300 MiB). `img-src 'self' data:`는 그대로다. `media-src`가 넓어지는 대가로 **앱이 `<video>`·`<audio>` 요소를 만드는 곳은 재생기 컴포넌트 하나뿐**임을 정적 시험으로 못 박는다(메시지 본문이 원격 미디어를 부르는 길이 없다는 근거다). 이 CSP 변경의 기록은 ADR-0133 증보로 C7이 같은 PR에서 쓴다(값은 여기서 정한다).
  - **공개 보안 문장.** `docs/security/claims.yaml`의 ATT-1(147행, 「익명 요청은 401」)은 스트림 주소가 생기면 그대로는 거짓이다(능력 주소는 Bearer 없이 바이트를 준다). C3b(#5120)는 같은 PR에서 ATT-1을 「Bearer가 필요한 content 경로는 익명이면 401」로 **좁히고**, **새 claim id**(다음 빈 번호. 지금은 ATT-1~ATT-8이 있어 ATT-9)로 「스트림 주소는 서명·만료·요청마다 재판정이고 거절은 같은 404」를 세워 증명을 `a_stream_address_is_the_same_authorization_as_the_content_route`와 `a_forged_or_foreign_address_is_refused_before_the_database`에 건다. `check_security_claims.py`는 증명이 있는지·실재하는지·레인이 맞는지(E1~E5)만 보고 문장이 스트림 주소를 말하는지는 못 보므로, 문장만 고치고 증명을 안 달면 ATT-1의 기존 증명이 남아 있는 한 린트가 초록이다. 새 id가 필요한 까닭이다. 같은 PR에서 `docs/security/README.ko.md`의 「첨부」 절과 `README.md`의 「downloads pass the server's channel-membership check」 문장도 스트림 주소를 말하도록 고친다. 이 PR은 정책 파일(`scripts/verify_policy_integrity.sh`의 `policy_path`) 변경이자 **보안 경계 확대**라 지정 owner의 exact-head 감사와 승인 라벨이 필요하고, planner 위임 감사의 범위를 벗어날 수 있어 owner 승인 대기를 일정에 넣는다.
- **D5 · 영상 메타와 포스터** (C5) [권장].
  - **만드는 곳은 보내는 기기다.** 폰이 첫 구현이다. 웹·데스크탑은 로컬 파일을 `<video>`로 읽어야 해서 `media-src blob:`이 필요하므로 이월한다(그때까지 웹·데스크탑이 올린 영상은 포스터 없이 카드로 보인다). **서버는 영상을 파싱하지도 변환하지도 않는다.** ffmpeg는 이미지에 없고 라이선스·공격면·CPU가 문제이며, 증보 4 D7이 파서를 자식 프로세스에 가둔 전례처럼 적대 형식의 파싱은 가둬야 한다. HLS·서버 변환은 아이디어로만 둔다.
  - **저장은 PG다.** 첨부 id에 1:1인 표 `attachment_media`(`workspace_id` 열과 `ws_isolation` 정책을 명시하고 `ON DELETE CASCADE`, RLS FORCE)에 `duration_ms`(1..86,400,000), `width`·`height`(1..16,384), 포스터 `poster_mime`(`image/jpeg`·`image/webp`), `poster_width`·`poster_height`(1,280 이하), `poster_bytes`(`bytea`, 256 KiB 이하)를 둔다. 보관소에는 서버가 바이트를 쓰는 API가 없고(131 아바타 이미지가 같은 이유로 PG에 둔다), 포스터를 둘째 첨부 행으로 두면 「묶이지 않은 초안은 업로더만 읽고 30일 뒤 청소된다」는 규칙에 걸려 다른 멤버에게 안 보이거나 지워진다.
  - **쓰기**: `PUT /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/media`, JSON `{durationMs, width, height, poster: {mime, dataBase64}}`(본문 상한 512 KiB). **업로더 본인이 `complete`이고 아직 메시지에 묶이지 않은 첨부에만** 쓴다(멱등 교체). 서버 검증: 저장된 mime이 닫힌 영상 목록(`video/mp4`·`video/quicktime`·`video/webm`)이고 `read_prefix`로 읽은 첫 바이트에 `ftyp`(mp4·mov, 오프셋 4) 또는 EBML(`1A 45 DF A3`, webm) 매직이 있다. **새 파서 crate는 쓰지 않는다**(이슈 #4673의 「mp4 헤더 검사」는 이 매직 확인으로 줄인다). 포스터는 `sniff_image_mime`(JPEG·WebP 매직)·`image_dimensions`(헤더 치수)·크기로 바이트를 검증한다. 길이·치수는 **선언값의 범위만** 검증한다(클라이언트가 거짓이면 레이아웃만 틀어진다).
  - **예산**(검수 1회차 M-1): 이 쓰기는 호출 하나가 PG에 최대 256 KiB를 쓰고(재쓰기도 새로 쓴다) 보관소에서 첫 바이트를 읽으므로 업로드 시작처럼 멤버 × 표면 예산을 쓴다: 표면 `media_write`, 기본 60/창, `RATE_LIMIT_MEDIA_WRITE_PER_MEMBER`(0이면 끔), 키는 업로드 시작과 따로 둔다. 게이트는 본문을 읽기 전에 거절하고 거절된 요청도 센다. 멤버별 **묶이지 않은 media 행 수 상한**은 C6·후속이다(그때까지는 이 예산과 초안 회수가 상한이다).
  - **읽기**: `GET …/attachments/{id}/poster`가 content와 같은 인가·같은 헤더 셋·같은 404를 쓴다. 메시지 투영의 `attachments[]`에는 영상일 때만 `media: {kind, durationMs, width, height, hasPoster}`를 **더한다**(가산). (정지 그림의 요약 `{kind: "image", width, height}`는 파일 끝 증보 9가 같은 자리에 더한다. 영상 요약은 그대로다.) 포스터 바이트는 투영·`message.new` 프레임·outbox 페이로드 어디에도 싣지 않고, 목록 질의는 `poster_bytes`를 고르지 않는다.
  - **신뢰**: 포스터가 그 영상의 실제 프레임이라는 보장은 없다(남는 위험). 클라이언트는 선언한 길이·치수를 믿지 않고 자리 높이·비율을 clamp한다(16,384까지 선언할 수 있다). `ftyp`로 시작하지 않는 오래된 `.mov`는 매직 때문에 media를 못 받고 카드로 남는다(의도). 쓰기는 감사한다(`attachment.media_set`, 종류만이고 내용·이름은 없다). 회수는 행 CASCADE가 따라간다.
- **D6 · 폰 영상 압축 기본값** (구현은 F1 #4586, 값은 여기서 정한다) [권장].
  - 기본은 「일반 화질」이다. `expo-image-picker`의 내보내기 프리셋 `H264_1280x720`(H.264·AAC, 해상도가 정해져 있어 어디서나 재생되고 크기를 가늠할 수 있다. `MediumQuality`는 해상도가 기기에 달렸다). 「원본」은 `Passthrough`이고 **보낼 때마다 직접 고른다**(기억하지 않는다. 셀룰러에서 원본 300 MiB를 실수로 올리지 않게 한다).
  - 줄인 결과도 한도를 넘으면 「너무 커요」로 거절하고, 자동으로 더 줄여 다시 시도하지 않는다. 웹·데스크탑은 영상을 변환하지 않는다. 안드로이드는 이 프리셋이 없어(iOS 옵션) 원본만 올린다.
  - **미검증 셋.** ① 설치된 타입 정의(`expo-image-picker` 57)가 `videoExportPreset`을 deprecated로 표시한다(Apple `UIImagePickerController` 문서를 가리킨다). 라이브러리(PHPicker) 경로에서 프리셋이 실제로 적용되는지 실기로 확인한다. ② **위치 메타가 지워지는지** 모르므로 화면 문구는 위치 제거를 약속하지 않는다. ③ 안 되면 `AVAssetExportSession` 직접 사용이 대안이다(용량 상한·faststart·메타 필터가 정밀하지만 [ADR-0168](0168-mobile-photo-picker-native-dependency.md)급 네이티브 결정이다).
  - **폰 청크 읽기**: `expo-file-system` 57의 `File.slice(start, end)`(Blob)와 `FileHandle.readBytes(length)`·`offset`이 타입에 있다. 8 MiB 단위로 읽을 수는 있다. 실기의 성능·메모리와 Blob을 `fetch`로 PUT할 때의 거동은 미검증이다. 폰 청크 업로드는 이슈 #5121이 맡고 스위치 전제다(D8).
  - 폰의 올리기 순서는 고름 → 줄임 → 포스터·길이 뽑기 → create → 조각 → complete → `PUT …/media`(실패해도 보내기는 진행) → 전송이다.
- **D7 · 보관·회수·사용량** (C6) (만료 없는 보관 + 회수·사용량은 owner 결정, 나머지는 [권장]).
  - **살아 있는 메시지에 묶인 파일은 기간으로 지우지 않는다**(owner 결정).
  - **회수**: 증보 2 D4 청소기에 **가지 둘**을 더한다. 첫째는 지운 메시지에 묶인 완료 첨부 중 `COALESCE(m.deleted_at, a.created_at)`이 30일보다 오래된 것이다(`state`만 또는 `deleted_at`만 쓰인 반쪽 무덤도 포함하고, 시각이 비면 업로드 시각이 기준이라 더 늦게 거둔다). 같은 `NO_OTHER_HOLD_SQL`(huddle 세 열·아바타 두 표), 같은 저장점 순서(행 삭제와 감사를 먼저, 보관소는 나중), `attachment.expired` + `reason: deleted_message`다. 이 가지가 열리면 증보 2의 참조 전수 표 A1(「묶인 행은 후보가 아니다」)이 바뀌므로 A1과 점검 SQL(청소기의 술어와 **글자까지 같다**는 단위 시험)을 같은 PR에서 고친다. 표에 **A6: `attachment_media`(CASCADE)**를 더하고 FK 목록의 `(known)` 단정과 점검 SQL 4절을 갱신하는 일은 `attachment_media`를 만드는 **C5가** 맡는다(C5의 PR이 FK 전수 시험을 빨갛게 만들기 때문이다). C6은 C5 뒤에서 시작한다. 기본 꺼짐·건조 실행 줄·점검 SQL 절차는 그대로이고 **켜기는 owner가 새 가지의 건조 실행 숫자를 본 뒤** 한다.
  - **미완료·실패 객체**(둘째 가지): 업로드가 끝까지 도착해 객체가 공개됐는데 `complete`가 오지 않거나(`pending`) 크기·mime 불일치로 `failed`가 되면 보관소 객체가 남는다(`routes/attachments.rs`의 `complete`는 불일치를 `failed`로 커밋하고 409만 답하며 `delete_file`을 부르지 않는다). 증보 2는 이 둘을 청소 대상에서 뺐고(증보 2 D4와 남는 위험) 아래 사용량의 `complete` 합에도 들어가지 않는다. 개당 한도가 3배라 이 구멍도 3배 커지고, 인증된 멤버 한 명이 볼륨을 채울 수 있는 크기도 같이 커진다(디스크 예약 507은 1 GiB 바닥에서 멈출 뿐 비워 주지 않는다). 그래서 사용량에 **「미완료·실패」 칸**(`status IN ('pending', 'failed')`의 `size_bytes` 합)을 더하고, **[권장] 7일보다 오래된 `pending|failed` 행은 행 삭제 + 보관소 삭제**를 둘째 가지로 둔다(같은 hold·저장점 순서·기본 꺼짐. 객체가 없으면 보관소 삭제는 성공으로 친다). 이 숫자는 스위치 전제다(D8).
  - **사용량**: 워크스페이스별 `SUM(size_bytes)`(`status = 'complete'`)를 RLS-bound 테넌트 tx로 센다. 이유별(살아 있음, 지운 메시지, 초안)로 나누고 **미완료·실패**(`status IN ('pending', 'failed')`) 칸을 따로 세어 owner·admin 화면에 보인다. **로컬 백엔드는 볼륨 사용률을 `statvfs`로 재어 80%에서 경고**한다(owner·admin 알림과 로그 한 줄, 반복은 억제). 안전한 래퍼로 읽는다. 새 `unsafe`는 금지이고(`unsafe-allowlist.tsv`), `rustix`가 이미 `Cargo.lock`에 있으며 그 라이선스를 `deny.toml`이 허용한다. Google 백엔드에는 볼륨 경고가 없고 사용량(DB 합계)만 있다. **하드 쿼터는 두지 않는다**(작은 팀이고 실제 한도는 디스크이며, 만들기 전 거절은 D2의 디스크 예약이 맡는다).
  - **비용**: 요금표·플랜 한도·볼륨 크기는 운영 값이라 여기 적지 않는다. 읽기가 모두 api를 지나므로 전송 요금이 사용량과 같이 늘 수 있다는 사실과 계산식만 남긴다: 300 MiB × N개, 100개면 약 29 GiB다.
  - 진행 중 업로드의 파트는 D2의 청소가 맡는다. 사용자가 초안 첨부를 지울 때 곧바로 거두는 API(`DELETE …/attachments/{id}`)는 이월한다(30일 청소가 거둔다).
- **D8 · 순서와 스위치** (안전 장치).
  1. C3(읽기)는 독립으로 먼저 선다.
  2. #4639(데스크탑 큰 파일 청크 전송)는 C4-2(천장을 올리는 한도 PR)보다 앞이다. #4639 PR이 TS 천장 상수를 들이고 `downloadsContract.test.ts`를 그 상수에 다시 묶는다(D1). 순서는 의존으로 지키고 시험은 그 뒷받침이다.
  3. C4 1단계(청크 서버·CORS·조각 유휴 제한·세션 `DELETE`·열린 세션 상한과 접기·디스크 예약·파트 청소) → 2단계(한도 함수·천장·CHECK·`attachment-limits`·메시지 합계).
  4. C3b는 C3 뒤다. C5는 C3와 독립이고 **C6은 C5 뒤**다(둘이 같은 FK 목록·점검 SQL·`NO_OTHER_HOLD_SQL`을 건드려 동시에 발사하면 같은 파일이 충돌한다). C7은 C3·C3b·C4·C5 뒤이고 폰 F1은 C3·C3b·C5 뒤이며 폰 청크(#5121)는 C4 1단계 뒤다.
  5. **스위치**는 C3·C4·#4639·C6·C7(웹·코어)·**폰 청크 업로드(#5121)**가 착륙하고 스택 검증(실기기 포함)이 끝난 뒤 planner가 `DEFAULT`를 300 MiB로 올리는 것이다. 폰 청크가 아직 없으면 스위치를 미룬다. 스위치 직후 폰도 `attachment-limits`로 300 MiB를 알게 되는데, Railway의 로컬 보관소에서 폰의 단일 PUT은 본문이 5분 안에 끝나야 해서 지속 8.4 Mbit/s가 없으면 큰 파일이 엣지에서 끊긴다. 폰 청크가 늦는 경우의 차선은 폰이 `chunkBytes`를 광고받아도 청크를 못 하면 개당 100 MiB로 스스로 제한하는 것이다(#5121이 정한다). 그 전에 owner 인스턴스는 `MOMO_ATTACHMENT_MAX_BYTES`로 먼저 시험할 수 있다. **스위치 PR 본문에 적을 숫자(볼륨 여유·80% 경고·회수 건조 실행·미완료 객체)는 아래 수용 기준에 있다.**

### 비교한 방식

| 결정 | 방식 | 판단 |
|---|---|---|
| 천장·CHECK | **[권장]** CHECK = 천장 300 MiB, 운영자 값은 [1 MiB, 천장], 기본값은 마지막에 스위치 | 능력과 노출을 나눠 순서를 지킨다. 같은 값이 여러 자리라 한 시험이 읽는다 |
| | CHECK를 1 GiB처럼 더 크게 두고 env 기본만 300 | 기각. CHECK가 계약의 한 자리가 아니게 되어 「의도한 여유」와 어긋남을 시험이 구별하지 못한다. 다음 상향은 어차피 ADR이다(ADR-0100) |
| | 100 MiB 유지, 500 MiB, 1 GiB | owner 결정이 300 MiB다 |
| | 스위치 없이 한 번에 올림 | 기각. 데스크탑 IPC(64 MiB에 +569 MiB), 로컬의 전체 메모리 읽기, Railway 5분이 먼저 풀려야 한다 |
| 업로드 규약 | **[권장]** Google 모양(`Content-Range`·`308`·상태 조회) | 같은 클라이언트 코드가 두 백엔드를 다룬다 |
| | tus(HEAD로 오프셋, PATCH로 잇기) | 기각. 둘째 프로토콜이고 Google 백엔드와 모양이 달라 클라이언트가 둘이 된다 |
| | S3 멀티파트 | 기각. Rust에 S3 백엔드가 없다(ADR-0151 옵션 2) |
| 재시작 | **[권장]** 세션·파트를 지운다(#2628 그대로) | 0부터. 남는 위험으로 둔다 |
| | 세션을 살린다 | 기각. 복원된 스냅샷이 이미 `complete`인 파일 id를 채우는 위험이 돌아온다 |
| | 파트만 살리고 인증 호출로 새 주소를 낸다 | 안전하지만 상태 파일·인증 경로·청소가 는다. 쓰다가 판단한다(이월) |
| 재생 인증 | **[권장]** 상태 없는 서명 주소(10분, 다회) + 요청마다 재판정 | 회수는 재판정이 맡고 TTL은 상한이다 |
| | self-media식 1회용 DB 토큰 | 기각. `<video>`의 둘째 `Range` 요청에서 죽는다 |
| | push_fetch식 세션 계보에 묶은 좁은 토큰 | 로그아웃이 즉시 끊지만 행·계보 조회·상한이 는다. 10분에 파일 하나라 이득이 작다. TTL이 30분을 넘으면 다시 본다 |
| | 쿠키 | 기각. API가 쿠키 인증이 아니고 데스크탑은 교차 사이트라 WKWebView가 막는 것으로 보인다(미검증) |
| | 서비스워커로 헤더 주입 | 기각. 데스크탑 CSP가 `worker-src 'none'`이고 토큰 갱신이 복잡하다 |
| | blob 재생 | 기각. `media-src blob:` CSP 변경에 300 MiB 메모리 |
| TTL | 5분 | 노출은 줄지만 탐색 때마다 갱신이 잦다 |
| | **[권장]** 10분 | `<video>`가 탐색·재연결 때 새 요청을 내는 빈도와 오류 때 다시 받는 경로 사이의 값 |
| | 30분 이상 | 갱신은 줄지만 경로·HTTP 로그에 남은 주소의 값이 커진다 |
| 서명 키 | **[권장]** JWT 서명 키에서 도메인 라벨로 파생 | 새 비밀 변수의 회전·배포 부담이 없다 |
| 포스터 저장 | **[권장]** PG `bytea` 표(131 전례) | 회수가 CASCADE로 따라가고 같은 읽기 술어를 쓴다 |
| | 둘째 첨부 행 | 기각. 초안 규칙·30일 청소와 부딪힌다 |
| | 서버 생성(ffmpeg) | 기각. 이미지에 없고 라이선스·공격면·CPU가 문제다 |
| 영상 검증 | **[권장]** 선언값 범위 + 첫 바이트 매직 | 파서가 없으니 공격면이 늘지 않는다 |
| | `mp4` crate로 헤더 파싱(길이·코덱·faststart) | 기각(v1). 적대 형식 파서와 새 의존의 NOTICE. 필요하면 자식 프로세스에 가두는 별도 결정 |
| 폰 압축 | **[권장]** picker 프리셋 `H264_1280x720` | 새 네이티브 코드가 없다 |
| | `AVAssetExportSession` 직접 | 정밀하지만 ADR-0168급 네이티브 결정이다. 프리셋이 안 통하면 대안이다 |
| 데스크탑 CSP | **[권장]** `media-src 'self' http: https:` | `connect-src`와 같은 모양이고 한 줄이다 |
| | 커스텀 프로토콜 + Rust 프록시(Authorization·Range) | 더 좁지만 새 네이티브 코드와 보안 면이다 |
| 회수 기본값 | **[권장]** 기본 꺼짐 유지, 켜기는 owner | 영상이 쌓인 인스턴스가 업그레이드 직후 한꺼번에 거두는 일을 막는다 |

### C3~C7 슬라이스

등급은 이슈 계약의 등급이다(2 = 보안 경계·공개 API 계약을 바꾼다). migration 번호는 이 증보가 쓰지 않는다(착수 때 planner가 준다).

| 슬라이스 | 이슈 | 일 | 의존 | 크기 | 등급 | migration | 검수 |
|---|---|---|---|---|---|---|---|
| C3 | #4671 | 로컬 스트리밍 읽기, `Range`·`HEAD`, Google 전달(전체 시간 제한 제거), `no-transform`, 모든 GET을 구간 읽기 하나로 | 이 증보 Accepted | M | 2 | 없음 | 독립 보안 검수(인가 경계 불변) |
| C3b | #5120 | 스트림 주소: 발급·공개 경로·토큰·per-IP 예산·새 claim과 문장 | C3 | M | 2 | 없음 | 독립 보안 검수 + 정책 파일 PR(지정 owner의 exact-head 감사·승인 라벨) |
| C4 | #4672 | 1단계: 청크 서버·CORS 목록·조각 유휴 제한·세션 `DELETE`·열린 세션 4개와 접기·디스크 예약·파트 청소. 2단계: 실효 한도 함수·천장·CHECK·`attachment-limits`·메시지 합계·한도 표의 모든 자리(**스위치 제외**) | 1단계는 없음(C3와 같은 모듈이라 순서는 통합자), **2단계는 #4639 뒤** | L(2단계) | 2 | 1(CHECK 넓힘) | 독립 보안 검수 B0·H0 |
| C5 | #4673 | `attachment_media` 표, `PUT …/media`, `GET …/poster`, 투영, **A6·FK `(known)` 목록·점검 SQL 4절 갱신** | 이 증보(C3와 독립) | M | 2 | 1 | 보안 검수 |
| C6 | #4674 | 지운 메시지 가지, 미완료·실패 객체 회수·계상, 점검 SQL, 사용량, 80% 경고 | #4443, **C5 뒤** | M | 2 | 없음 | 독립 보안 검수 |
| C7 | #4675(+#4588) | 웹·코어 청크 클라이언트, 스트림 주소 재생(웹·데스크탑), 데스크탑 `media-src`와 ADR-0133 증보, `save` 선택 | C3·C3b·C4·C5 | M | 1 | 없음 | design-review + 보안 검수(데스크탑 CSP 완화·주소 취급) |
| F1 | #4586 | 폰 영상 고르기·줄이기·포스터·재생 | C3·C3b·C5, [ADR-0168](0168-mobile-photo-picker-native-dependency.md) 증보(`expo-video`·저장 문구·마이크. **쓸 칸이 아직 없다**) | L | 1 | 없음 | design-review |
| 폰 청크 | #5121 | 폰 청크 업로드·이어 올리기(8 MiB, `File.slice` → PUT, 상태 조회 재개) | C4 1단계 | M | 1 | 없음 | design-review(실기 메모리) |
| 스위치 | C4의 마지막 줄 또는 소 PR | `DEFAULT` 100 MiB → 300 MiB | D8의 5(폰 청크 포함) | S | 2 | 없음 | planner |
| #4639 | UXUI | 데스크탑 큰 파일 청크 전송, TS 천장 상수와 시험 재결속 | 없음(`Range` 없이도 된다) | M | 1 | 없음 | design-review |

### 슬라이스별 수용 기준 (검토 1회차 반영)

- **C3 (#4671)**
  - Google 읽기는 전체 시간 제한(`CONTENT_TIMEOUT` 60초)을 없애고 연결 시간 제한 + 청크 사이 무응답 제한으로 바꾼다. 상류에는 서버가 정규화한 `bytes=s-e` 하나만 넘긴다. 시험은 60초 넘게 천천히 읽는 소비자도 끝까지 받고 다중·이상한 `Range`가 상류에 닿지 않음을 잰다(D3).
  - 읽기와 회수는 천장 기준이다(D1). `Range`·`Content-Range`의 정수는 검사된 산술이다(D3). 공개는 파트 `sync_all` 뒤 rename이다(D2).
  - 엣지 시험은 압축되는 mime(`text/plain`)으로 200과 206을 둘 다 잰다. Caddy가 필요한 실행 증거라 스택 검증 줄 몫으로 분리한다(D3).
  - openapi에 206·416·HEAD와 새 헤더를 더한다.
- **C3b (#5120)**
  - ATT-1을 좁히고 새 claim id(ATT-9)를 세우며 `docs/security/README.ko.md`·`README.md` 문장을 고친다. 정책 파일·보안 경계 확대 PR이라 owner 승인 대기를 일정에 넣는다(D4).
  - 서명은 32바이트 전체를 상수 시간으로 비교하고 필드는 고정 폭으로 직렬화한다. 경로 `{ws}`가 토큰과 다르면 DB 전에 404다.
  - `save` 발급은 400으로 닫아 둔다(C7이 연다). 동시 열린 스트림 자리와 응답당 최대 시간을 정한다(D3 요율).
  - 표본 로그 한 줄과 `infra/railway/README.md`의 `request>uri` 안내에 스트림 경로를 더한다(D4).
  - 발급 자격 시험은 HTTP 시험(문이 먼저 막는다)에 더해 핸들러를 `Principal{kind: Agent}`로 직접 부르는 단위 시험을 둔다. 핸들러의 `require_human`을 지우면 그 시험이 빨개야 한다.
- **C4 (#4672)**
  - 1단계: 조각 본문 유휴 제한(30초)과 시험 `a_stalled_chunk_releases_the_session_within_the_idle_limit`. 세션 `DELETE`와 상한의 접기와 시험 `an_abandoned_session_is_handed_back_in_time`. 수명 시험은 「조각 하나 → 61분 침묵 → 404」(6시간 전)를 따로 둔다. `Content-Range` 없는 PUT이 조각이 시작된 세션이면 409이고 선언 0 세션의 예약은 실효 한도로 한다.
  - 새 환경변수 둘(`MOMO_ATTACHMENT_MAX_BYTES`·`MOMO_ATTACHMENT_MAX_MESSAGE_BYTES`)을 Railway 템플릿·compose·`oort doctor` 표와 운영 문서에 더하고 openapi에 `chunkBytes`·`attachment-limits`·`DELETE`·308·507·429를 더한다.
  - 2단계: 실효 한도 시험은 선언·문장·`attachment-limits`뿐 아니라 PUT 본문 바이트(선언 0 포함)·`complete`의 재측정·낮춘 뒤의 읽기까지 잰다. 의존은 #4639다(1단계는 없다).
  - 정책 파일 변경: Rust 시험이 `model.ts`·openapi·SQL을 읽으면 `.github/workflows/pr-ci.yml`의 rust 필터에 `packages/momo-core/src/features/attachments/model.ts`를 더해야 한다(#4055 가드, 지정 owner 감사).
- **C5 (#4673)**: A6·FK `(known)`·점검 SQL 4절 갱신은 C5가 한다. `attachment_media`의 `workspace_id`와 `ws_isolation`을 시험이 단정한다. 포스터 검증 시험은 SOF 뒤에서 잘린 JPEG를 400으로 단정하지 않는다(헤더만 읽는 `image_dimensions`의 한계, 서버가 디코드하지 않아 위험은 없다).
- **C6 (#4674)**: C5 뒤에서 시작한다. 미완료·실패 객체는 사용량 「미완료·실패」 칸과 7일 회수 가지(권장)이고 숫자는 스위치 전제다. 점검 SQL의 「글자까지 같다」 시험을 갱신한다.
- **C7 (#4675·#4588)**: 만료 전 재발급과 재생 위치·상태 복원이다. 재생이 TTL을 넘겨도 끊기지 않음을 시계 주입 시험으로 재고 실기로 메모한다. 미디어 요소 정적 시험은 `createElement("video")`·`jsx("video"` 패턴도 본다. 데스크탑 CSP 완화와 주소 취급이 들어 있어 보안 검수 한 줄을 둔다.
- **폰 청크 (#5121)**: 8 MiB 조각을 `File.slice`로 읽어 PUT하고 상태 조회로 재개한다. red proof는 SHA-256 왕복·끊김 복구이고 실기 메모리를 잰다. 폰도 스트림 주소와 만료 전 재발급을 쓴다. 청크를 못 하면 개당 100 MiB로 스스로 제한하는 차선을 정한다(D8).
- **스위치 PR**: 본문에 ① 대상 인스턴스의 볼륨 총량·사용량·증가율 ② 80% 경고가 실제로 울린 증거 ③ 회수 건조 실행 숫자(`candidates`·`bytes`) ④ 미완료·실패 객체 바이트를 적는다. 하드 쿼터가 없고 회수가 기본 꺼짐이므로 볼륨 크기가 곧 상한이다.
- **#4639**: TS 천장 상수 `ATTACHMENT_CEILING_BYTES`(그때는 값이 아직 100 MiB)를 들이고 `downloadsContract.test.ts`를 그 상수에 다시 묶는다. IPC가 청크 전송이라는 사실을 시험이 읽는다.

### 바뀌지 않는 것

인가의 두 함수와 그 술어(활성 채널 멤버, 살아 있는 메시지에 묶였거나 묶이지 않은 업로더 본인의 초안, `complete`), Bearer content 경로의 거절 모양(비멤버 403, 그 밖은 404), 인라인 렌더 금지(`attachment`·`nosniff`·`no-store`), Drive 주소 비노출, 에이전트 업로드 제외, 바이러스 스캔 없음, 종류 제한 없음(영상은 표시를 키울 뿐 첨부의 정의를 바꾸지 않는다. 재생이 안 되면 내려받기 카드로 남는다), `complete`·묶기의 업로더 규칙, 증보 2의 회수 안전 규칙(같은 hold·저장점 순서·기본 꺼짐), 워커의 읽기 길(증보 3·4의 `self-media`와 1회용 주소), 단일 PUT 경로(옛 클라이언트·아바타·이모지), 재시작이 세션을 지우는 규칙(#2628).

### 이슈·리서치 문구와 다른 곳

① 이슈 #4585 코멘트와 #4671~#4675 본문의 「증보 3」은 이 증보(5)다. ② 이슈 코멘트의 「Accepted로 써요」는 칸 지시대로 Proposed다(독립 설계 검토 뒤 Accepted). ③ #4673의 「mp4 헤더 검사」는 첫 바이트 매직 확인으로 줄였다(D5). ④ #4672의 「한도 상향 마이그레이션(CHECK)·openapi·상수 한 곳」은 천장을 넓히는 일(C4)과 기본값을 올리는 일(스위치)로 나눴고, 한 시험이 여러 자리를 읽는다(D1). ⑤ #4584의 「앱 플레이어는 인증 헤더로 받아요」는 웹·데스크탑은 주소(헤더를 못 싣는다), 폰도 주소를 권장한다(access 토큰 15분). ⑥ 서버 쪽 스트림 주소(발급·공개 경로)를 맡은 이슈가 없었다 → #5120(C3b)로 발행했다. ⑦ 폰 청크 업로드를 맡은 이슈가 없었다 → #5121로 발행했고 스위치 전제다.

### 남는 위험

1. **스트림 주소는 Bearer 없이 바이트를 준다.** 10분·파일 하나·요청마다 재판정이지만 로그아웃·세션 폐기는 이 주소를 끊지 않는다.
2. Railway의 HTTP 로그는 경로(토큰)를 남긴다(공식 문서의 `path` 필드, 보존은 플랜별 3~30일, Enterprise 최대 90일). 만료된 주소는 쓸모가 없으므로 짧은 TTL이 방어선이다.
3. `Content-Disposition: attachment` 아래의 `<video>` 재생과 `Range` 탐색, `no-store`가 재생 캐시에 미치는 영향이 WebKit(Safari·WKWebView)에서 미검증이다.
4. `Location` 없는 308을 `fetch`·XHR·URLSession이 정상 응답으로 돌려주는지, Railway 엣지·Caddy를 그대로 지나는지 미검증이다.
5. 배포가 업로드를 끊으면 0부터 다시 한다(재시작을 건너는 이어 올리기는 이월).
6. Google 백엔드의 브라우저 청크는 CORS 프리플라이트를 확인하지 못해 광고하지 않는다. Google은 단일 PUT 300 MiB다.
7. 클라이언트가 보낸 포스터·길이·치수는 믿지 않고 범위와 바이트만 잰다. 포스터가 그 영상의 프레임이라는 보장은 없다.
8. 메시지당 합계 600 MiB는 스위치 전에도 적용된다(지금의 20×100 MiB가 줄어든다).
9. 한 멤버의 반복 대용량 읽기(전송 요금)를 막는 장치가 없다. 이상 징후가 보이면 멤버별 바이트 예산을 더한다.
10. 데스크탑 `media-src`가 http·https 전체로 넓다. 미디어 요소를 만드는 곳이 하나뿐이라는 정적 시험에 기댄다.
11. HEAD는 보관소를 읽지 않아 200 뒤에 GET이 보관소 오류일 수 있다.
12. 폰 영상 내보내기가 위치 메타를 지우는지 모른다. 문구가 약속하지 않는다.
13. 채널·워크스페이스를 지우는 CASCADE는 보관소 객체를 고아로 남긴다(증보 2의 위험이 큰 파일에서 더 비싸진다).
14. 열린 업로드 4개와 디스크 예약은 정상 사용자를 막을 수 있다. 예약은 보수적이라 60초 청소 주기 사이에 만료된 세션의 남은 바이트가 계산에 남는다.
15. 데스크탑 IPC가 선형으로 늘면 300 MiB 한 건에 메모리가 약 +2.6 GiB다(64 MiB에서 +569 MiB를 잰 값에서 늘린 추정이며 측정이 아니다). #4639 전에는 올리지 않는다(순서는 C4-2 ← #4639 의존이 지킨다).
16. 웹·데스크탑이 올린 영상은 포스터가 없다(이월).
17. **포스터는 EXIF·덧붙은 바이트까지 그대로 저장·전달한다.** 서버는 그림을 디코드·재인코딩하지 않으므로(D5) 검증을 통과한 포스터의 EXIF·XMP와 헤더 뒤에 덧붙은 바이트(256 KiB 이내)가 열람자 모두에게 그대로 가고, 포스터 가로세로는 헤더가 선언한 값이다. `nosniff`·`attachment`로 렌더 위험은 닫혀 있다. 올리는 클라이언트(F1)가 EXIF를 벗겨 보낸다.

### runtime-unverified

이 증보는 문서뿐이라 코드를 실행하지 않았다. 읽은 코드 사실은 track/engine `195c304f3` 기준이고, Railway의 5분·15분과 Google 재개 업로드의 규칙(256 KiB 배수, 세션 1주, 상태 조회, 308)은 공식 문서를 2026-11-02에 읽은 값이다. 실행으로 확인하지 못한 것: 실제 Railway 엣지 위의 206·308·`Content-Range`, Caddy `encode`의 206 처리(검수 1회차가 소스로 읽은 바로는 텍스트 계열만 압축하고 `no-transform`을 존중하지만 실행으로 재지 않았다), 브라우저·WKWebView의 `attachment` 아래 `<video>` 재생과 `Range` 탐색, `fetch`·XHR·URLSession의 Location 없는 308 처리, 폰 `videoExportPreset`의 실제 적용과 위치 메타, `expo-file-system` 구간 읽기와 Blob PUT, Google 브라우저 청크의 CORS, 300 MiB 동시 읽기의 실제 RSS(수용기준은 C3의 몫).

### red proof

시험 이름은 제안이고 구현 칸이 정한다. 단정은 실제 바이트 수·헤더 값·행 수를 재야 하고(실 PG는 두 테넌트와 비우회 역할), 컴파일 실패는 RED로 세지 않는다.

| 결정 | 시험(제안) | 분기를 지우면 빨강 | 칸 |
|---|---|---|---|
| D1 천장 | `attachment_ceilings_agree`(파일을 읽는 단위 시험) | 마이그레이션 SQL의 CHECK·openapi `maximum` 셋·TS 천장·Rust 상수 둘·`TABLE_MAX_BYTES`가 한 값이다. 한 곳만 300 MiB로 바꾸거나 한 곳만 100 MiB로 남기면 빨강 | C4 |
| D1 실효 한도 | `the_effective_limit_is_one_function` | 운영자 값 120 MiB에서 120 MiB 선언은 통과하고 120 MiB + 1 B는 413이며, 413 문장이 120을 찍고 `GET attachment-limits`가 같은 값을 준다. **PUT 본문이 120 MiB + 1 B면(선언 0 포함) `ReceivedLength`가 끊고 `complete`가 측정 크기를 실효 한도로 다시 잰다.** 한 곳을 상수로 되돌리면(문장·`attachment-limits`·본문 바이트·재측정 어느 쪽이든) 어긋나서 빨강이다. **실효 한도를 300에서 100으로 낮춘 뒤 이미 `complete`인 200 MiB 행은 읽히고 청소기 후보가 된다**(읽기·회수가 실효 한도를 쓰면 빨강) | C4 |
| D1 범위 | `an_operator_value_outside_its_range_is_ignored` | 0·음수·문자열·천장 초과·1 MiB 미만은 `DEFAULT`로 돌아가고 기동 로그가 변수 이름만 담는다(값 없음). 클램프를 지우면 빨강 | C4 |
| D1 스위치 | `the_default_is_100_until_the_switch` | 기본 설정에서 100 MiB + 1 B 선언은 413이고 운영자 값 300 MiB에서는 통과한다. 스위치가 바꾸는 것은 `DEFAULT` 한 줄이고 CHECK·천장·openapi는 그대로다(위 `attachment_ceilings_agree`가 초록으로 남는다). 스위치가 천장을 건드리면 빨강 | C4·스위치 |
| D1 합계 | `a_message_over_the_total_is_refused_before_any_row_changes`(실 PG) | 300 + 300 MiB는 통과하고 + 1 B는 413이며 어떤 `attachment` 행의 `message_id`도 바뀌지 않고 메시지는 롤백된다. 예약(`reserve`)도 같다. `link`에서 판정을 지우면 보내기가, `reserve`에서 지우면 예약이 통과해 빨강 | C4 |
| D2 왕복 | `a_chunked_upload_round_trips_to_the_same_bytes`(실 라우터·실 소켓) | 64 MiB(8조각)를 올린 객체의 SHA-256이 원본과 같고 마지막 조각 뒤 `200`이며 `complete`가 측정 크기를 기록한다. 오프셋 계산이나 이어붙이기를 틀리게 하면 해시가 달라 빨강 | C4 |
| D2 오프셋·크기 | `a_chunk_at_the_wrong_offset_writes_nothing_and_reports_what_is_held` | 다른 오프셋의 조각은 파트 길이를 바꾸지 않고 `308` + 실제로 받은 만큼의 `Range`다(받은 것이 없으면 `Range` 헤더가 없다). 선언 크기 0인 세션에 `Content-Range`는 400이고 그 세션의 단일 PUT은 지금처럼 통과한다. `bytes 0-18446744073709551615/…`처럼 u64를 넘기는 값은 덧셈이 넘치지 않고 400이다. 검사를 지우면 겹쳐 써서 해시가 달라, 검사된 산술을 지우면 넘침이 통과해 빨강 | C4 |
| D2 되감기 | `an_interrupted_chunk_is_rewound` | 조각 본문을 반만 보내고 연결을 닫으면(서버가 닫힘을 본 뒤) 상태 조회가 끊기기 전의 `Range`를 주고, 같은 조각을 다시 보내면 성공해 해시가 같다. 되감기를 지우면 파트가 길어져 다음 오프셋이 어긋나 빨강 | C4 |
| D2 308 | `a_308_never_carries_a_location` | 조각 확인·상태 조회의 모든 308에 `Location`이 없다. 넣으면 빨강(`fetch`·URLSession의 실제 추종은 runtime-unverified) | C4 |
| D2 수명 | `the_session_ends_at_its_idle_and_absolute_deadlines`(시계 주입) | 50분 간격 조각 일곱 개(5시간 50분)는 끝까지 산다. 조각 하나를 받고 61분 침묵하면(6시간 전) 404이고, 생성 뒤 6시간 1분은 어느 때든 404다. 소진·만료·모르는 세션은 같은 상태·같은 본문이다. 유휴를 고정으로 바꾸면 앞이, 유휴 마감을 지우면(61분 침묵이 안 끊긴다) 가운데가, 절대 마감을 지우면 뒤가 빨강 | C4 |
| D2 동시 | `one_chunk_at_a_time_per_session` | 같은 세션의 동시 둘째 PUT은 409이고 파트가 섞이지 않는다(해시 같음). 세션 잠금을 지우면 빨강 | C4 |
| D2 회귀 | 기존 `drive_upload_edge`·`local.rs` 단위 시험·아바타·이모지 업로드 시험 | `Content-Range` 없는 PUT이 그대로 통과한다. 청크 분기가 단일 PUT을 깨면 빨강 | C4 |
| D2 상한·예약 | `the_open_upload_cap_and_the_disk_reservation_refuse_before_any_row` | 멤버당 살아 있는 세션 4개가 모두 60초 안에 움직였을 때 다섯째가 429이고 행이 없다. 세션 하나가 만료·소진되면 다시 만들 수 있고 재시작 뒤에는 0개다. 주입한 작은 볼륨에서 열린 세션들이 쥔 남은 바이트 때문에 다음 세션이 507이고 `attachment` 행도 세션 파일도 없다. 남은 바이트 항을 빼면 둘째 세션이 통과해, 1 GiB 바닥 항을 지우면 빨강 | C4 |
| D2 멈춘 조각 | `a_stalled_chunk_releases_the_session_within_the_idle_limit`(시계 주입) | 본문을 반만 보내고 멈춘 PUT 뒤 31초에 같은 세션의 상태 조회가 `308`(되감긴 `Range`)이고 409가 아니다. 이어서 새 조각을 보내 성공한다. 바이트가 계속 흐르는 느린 조각(조각당 5분)은 끊기지 않는다. 유휴 제한을 지우면 상태 조회가 409에 걸려, 총 시간 제한으로 바꾸면 느린 조각이 끊겨 빨강 | C4 |
| D2 반납 | `an_abandoned_session_is_handed_back_in_time` | `DELETE`는 204이고 바로 다섯째 세션을 만들 수 있다(둘째 `DELETE`는 같은 404). 네 세션 중 하나가 마지막 바이트 뒤 60초를 넘겼으면 다섯째 요청이 그것을 접고 통과한다. 넷 모두 60초 안에 움직였으면 429이고 어떤 세션도 접히지 않는다. 남의 세션은 접히지 않는다. `DELETE`를 지우면 앞이, 접기를 지우면 가운데가, 유휴 조건(60초)을 지우면(활동 중인 세션이 접힌다) 뒤가 빨강 | C4 |
| D2 청소 | `a_stale_part_is_swept_and_a_live_one_is_not` | 만료 세션의 파트와 세션 파일은 청소 뒤 없고 받는 중인 세션의 파트는 그대로다. 살아 있는 파트를 지우면 받는 중 업로드가 깨져, 만료 파트를 안 지우면 빨강 | C4 |
| D2 재시작 | `a_restart_clears_sessions_and_parts_but_keeps_objects`(기존 `open_clears_pending_sessions_and_partial_writes_but_keeps_objects`의 청크판) | 청크 중간에 아카이브를 다시 열면 세션·파트가 없고 객체는 그대로이며 옛 주소는 404다. 지우는 규칙을 지우면 빨강(스냅샷 재생 위험이 돌아온다) | C4 |
| D2 CORS | `cors_allows_content_range_and_exposes_range` | 허용 목록에 `content-range`·`range`, 노출 목록에 `range`·`content-range`·`accept-ranges`가 있고 요청 헤더를 반사하지 않는다. 반사로 바꾸면 빨강 | C4 |
| D3 오라클 | `a_range_never_asks_whether_a_file_exists`(실 PG) | 남의 초안·지운 메시지(반쪽 무덤 둘)·없는 id·다른 채널·`pending`에 `Range`(만족 가능·불가능·다중)를 보내도 `Range` 없는 요청의 응답과 상태·본문이 같다. `Range` 해석을 인가 앞으로 옮기면 416이 존재를 말해 빨강 | C3 |
| D3 응답표 | `the_range_table` | 표의 줄마다 상태와 `Content-Range`·`Content-Length`·`Accept-Ranges` 값을 단정한다(경계: `a-`, `-n`, n이 크기 이상, `b`가 크기 이상, 마지막 한 바이트, 크기 0, 다중 범위, `If-Range`, `bytes=0-99999999999999999999999`처럼 u64 밖 자릿수는 문법 오류로 무시하고 200). 줄 하나를 틀리게 하면 빨강 | C3 |
| D3 HEAD | `head_reads_no_byte_of_the_archive` | 호출·읽은 바이트를 세는 보관소에서 HEAD의 보관소 읽기는 0이고 크기·mime은 DB 행의 값이다. HEAD가 본문 스트림을 열면 빨강 | C3 |
| D3 메모리 | `a_local_read_is_flat_in_memory`(Linux) | 300 MiB 객체(희소 파일) 넷을 동시에 읽는 동안 RSS 증가가 64 MiB 이하다. `fs::read`로 되돌리면 1 GiB를 넘어 빨강 | C3 |
| D3 락 | `a_slow_reader_does_not_hold_the_archive_lock` | 읽기 스트림을 멈춘 채 `file_metadata`와 새 세션 생성이 제때 끝난다. 스트림 동안 락을 쥐면 빨강 | C3 |
| D3 백엔드 | `a_range_read_returns_only_those_bytes_on_every_backend` | 로컬·stub·Google(기록용 대역, 127.0.0.1)이 같은 구간 바이트를 준다. Google 대역이 행과 다른 총량의 `Content-Range`를 주면 502다. `Range` 전달을 지우면(전체를 보내고 206이라 우긴다) 빨강, 총량 대조를 지우면 빨강. Google 대역에 `bytes=0-1,5-9`·`bytes=-0`·긴 헤더를 보내도 상류가 받는 `Range`는 정규화한 `bytes=s-e` 하나이고(원문 전달이면 빨강), 60초 넘게 천천히 읽는 소비자도 끝까지 받는다(전체 시간 제한이 남아 있으면 중간에서 잘려 빨강) | C3 |
| D3 헤더 | `content_responses_keep_the_headers` | 200·206·416·HEAD가 모두 `attachment`·`nosniff`·`no-store, no-transform`·`Accept-Ranges`를 낸다. 206에서 `attachment`를 빼면 빨강(공개 보안 문장 `claims.yaml:147`의 증명) | C3 |
| D3 엣지 | `the_edge_passes_a_206_untouched`(실행 증거. Caddy가 필요하므로 **스택 검증 줄 몫**) | Caddy(`encode zstd gzip`)를 앞에 두고 **압축되는 mime(`text/plain`) 첨부로 200과 206을 둘 다** 잰다. `Content-Encoding`이 없고 206의 `Content-Range`·`Content-Length`가 그대로다. `no-transform`을 지우면 `text/plain`이 압축되어 빨강이다(영상 mime으로만 재면 `no-transform`이 없어도 압축되지 않아 초록이라 실패할 수 없는 가드다) | C3·스택 검증 |
| D4 같은 인가 | `a_stream_address_is_the_same_authorization_as_the_content_route`(실 PG) | 비멤버·나간 멤버·정지·다른 테넌트·지운 메시지(반쪽 무덤 둘)·남의 초안·`pending`·없는 id·보관된 채널의 매트릭스에서 stream이 모두 같은 404를 같은 바이트로 낸다. 술어 하나를 지우면 그 칸이 200이라 빨강 | C3b |
| D4 회수 | `a_revoked_reader_loses_the_address_at_the_next_request` | 발급 뒤 206을 받고 멤버가 채널을 떠나거나 메시지가 지워지면 **같은 주소**의 다음 요청이 만료 전에 404다. 요청마다 판정을 지우고 발급 때만 판정하면 빨강 | C3b |
| D4 다회·만료 | `the_address_serves_many_requests_within_its_ttl_and_none_after` | 같은 주소로 구간 요청 다섯 번이 성공하고 만료 1초 전은 200, 만료 뒤는 404다(시계 주입). 1회용으로 만들면 둘째가, TTL 비교를 지우면 만료 뒤가 빨강 | C3b |
| D4 위조 | `a_forged_or_foreign_address_is_refused_before_the_database` | 서명 한 바이트·다른 첨부 id·다른 채널·다른 워크스페이스 경로·다른 멤버·다른 종류로 바꾼 주소는 같은 404이고 **DB 질의가 0회**이며 per-IP 예산을 쓴다. 예산을 다 쓴 주소에서도 살아 있는 주소는 206이다. MAC이 필드 하나를 안 덮으면 그 치환이 통과해, 서명 확인을 DB 뒤로 옮기면, 게이트를 핸들러 앞으로 옮기면(살아 있는 주소가 429) 빨강 | C3b |
| D4 닫힌 목록 | `play_serves_only_the_closed_video_list` | mime이 `text/html`·`image/svg+xml`·`application/octet-stream`인 첨부(바이트는 HTML)는 `play` 발급이 거절이고 직접 서명한 토큰도 404다. `video/mp4`는 200·206이다. 목록을 와일드카드로 넓히거나 지우면 빨강 | C3b |
| D4 헤더·메서드 | `the_stream_route_has_a_fixed_header_list_and_no_redirect` | `Referrer-Policy: no-referrer`·`attachment`·`nosniff`·`no-store`가 있고 `Location`이 없으며 POST·PUT·DELETE는 405다. 헤더 하나를 지우면 빨강 | C3b |
| D4 로그 | `a_token_is_in_no_log_audit_or_error` | 성공·실패 요청 전후의 모든 로그 줄·감사 행·오류 본문에 토큰 문자열이 없다. 핸들러가 토큰이나 경로를 로그에 쓰면 빨강 | C3b |
| D4 발급 자격 | `only_a_person_mints_an_address`와 핸들러 단위 시험 | push-fetch·push-action 좁은 토큰·에이전트 bearer·개발자 토큰은 HTTP로는 문(미들웨어의 닫힌 표)에서 먼저 403이고 사람 bearer는 200이다. 핸들러의 사람 확인(`require_human`)은 문이 먼저 막아 HTTP 시험으로는 빨개지지 않으므로, 핸들러를 `Principal{kind: Agent}`로 직접 부르는 단위 시험이 따로 있어야 하고 그 확인을 지우면 그 시험이 빨강 | C3b |
| D4 save | `save_forces_octet_stream_and_encodes_the_name`(구현할 때) | 이름에 CR·LF·따옴표·한글이 있어도 헤더가 깨지지 않고 `filename*`로 인코딩되며 `Content-Type`은 `application/octet-stream`이다. 인코딩을 지우면 빨강 | C7 |
| D4 공개 문장 | `check_security_claims.py`(기존 린트) | ATT-1이 조건부로 좁혀지고 새 claim(ATT-9)이 스트림 시험 둘을 증명으로 건다. 증명 이름이 틀리거나 비면 E1·E2가 빨강이다. 린트는 문장이 스트림 주소를 말하는지는 못 보므로 새 id 없이 ATT-1 문장만 고치는 방식은 초록이라 잡지 못한다 | C3b |
| D4 CSP | `desktopShellContract.test.ts` 확장, `gate-csp-deploy.mjs` | 데스크탑 `media-src`가 `'self' http: https:`이고 `blob:`이 없으며 `img-src 'self' data:`는 그대로다. 웹은 `media-src` 없이 `default-src 'self'`다. `blob:`을 더하면 빨강 | C7 |
| D4 미디어 요소 | `only_the_player_creates_media_elements`(정적) | `<video`·`<audio`·`new Audio(`에 더해 `createElement("video")`·`createElement("audio")`·`jsx("video"` 패턴이 재생기 컴포넌트 하나 밖에 없다. 다른 컴포넌트가 만들면 빨강 | C7 |
| D5 권한 | `the_media_write_is_the_uploaders_before_the_send_only` | 업로더 본인·`complete`·미묶임에서만 200이다. 남의 첨부·묶인 뒤·`pending`은 같은 404다(영상 아닌 mime은 이 행이 아니라 아래 「영상 확인」 행의 400이다: 인가가 먼저라 업로더 본인만 보는 400이다). 술어 하나를 지우면 빨강 | C5 |
| D5 포스터 검증 | `a_poster_is_validated_by_its_bytes_not_its_label` | `image/jpeg`로 선언한 HTML·PNG·GIF·SVG·**헤더(SOF) 앞에서 자른 JPEG**·256 KiB + 1 B·치수 1,281은 각각 400이고 정상 JPEG·WebP는 200이다. 매직·치수·크기 검사 하나를 지우면 그 케이스가 통과해 빨강. 헤더만 읽는 `image_dimensions`는 SOF 뒤에서 잘린 JPEG를 통과시킨다(서버가 디코드하지 않아 위험은 없고 클라이언트 디코더 몫이라 이 시험은 그것을 400으로 단정하지 않는다) | C5 |
| D5 영상 확인 | `a_non_video_or_a_fake_video_cannot_hold_media` | 저장된 mime이 닫힌 목록 밖이거나 첫 바이트에 `ftyp`·EBML이 없으면 400이다(인가 뒤라 그 파일의 업로더 본인만 본다. 남의 파일이면 위 「권한」 행의 404다). 길이 0·24시간 + 1 ms·치수 16,385도 400이고 이 셋은 요청의 모양이라 인가 앞에서 누구에게나 400이다. 매직 검사나 범위 검사를 지우면 빨강 | C5 |
| D5 읽기 | `the_poster_route_is_the_content_route_for_everyone_else` | 포스터 GET이 content와 같은 인가 매트릭스를 같은 404로 내고(지운 메시지 포함) 헤더 셋이 같다. 술어를 지우면 빨강 | C5 |
| D5 페이로드 | `a_poster_is_never_in_a_payload` | 메시지 투영·`message.new` 프레임·outbox 페이로드에 `media`(길이·치수·`hasPoster`)만 있고 포스터 바이트·base64가 없으며 `PAGED_ATTACHMENT_JOIN`이 `poster_bytes`를 고르지 않는다. 포스터를 실으면 빨강 | C5 |
| D5 회수 | `media_rows_follow_the_attachment` | 첨부 행이 지워지면 `attachment_media`도 CASCADE로 사라지고 FK 전수 시험이 새 FK를 `(known)`으로 센다. CASCADE를 지우면 빨강 | C5 |
| D6 기본값 | 폰 Jest `the_default_video_choice_is_the_normal_quality` | 기본 선택이 `H264_1280x720`이고 「원본」은 `Passthrough`이며 기억되지 않아 다음 선택은 다시 기본이다. 기본을 `Passthrough`로 바꾸면 빨강 | F1 |
| D6 실기 | 위치 메타가 있는 영상을 내보내 재는 실기 확인(F1이 잰다) | 내보낸 파일에 위치 atom이 없고 크기가 줄었는지 잰다. 안 되면 문구 장부에 위치 제거 문구가 없음을 단정한다 | F1 |
| D7 회수 가지 | `a_deleted_messages_file_is_reclaimed_only_after_the_grace_and_only_when_nothing_holds_it`(실 PG) | 지운 지 29일은 후보가 아니고 31일은 후보다. 반쪽 무덤(상태만·시각만)도 같고(시각이 비면 업로드 시각 기준), huddle 세 열·아바타 두 표가 쥔 파일은 후보가 아니며, 살아 있는 메시지에 묶인 파일은 나이와 무관하게 후보가 아니다. 날짜 항·무덤 반쪽 하나·hold 하나를 지우면 각각 빨강(증보 2의 `a_file_something_else_holds_…`·`old_unbound_complete_…`의 짝) | C6 |
| D7 점검 SQL | `the_operators_check_sql_embeds_the_sweeps_predicate_word_for_word`(갱신) | 점검 SQL의 후보 술어가 새 가지까지 청소기의 것과 글자까지 같다. 한쪽만 바꾸면 빨강 | C6 |
| D7 사용량 | `usage_counts_what_the_sweep_would_count` | 이유별 합이 `SUM(size_bytes)`와 같고 두 테넌트가 섞이지 않는다. 분류 하나를 빼면 합이 어긋나 빨강 | C6 |
| D7 경고 | `the_volume_warning_fires_at_80_and_only_for_the_local_backend` | 주입한 `statvfs` 값에서 79%는 경고 없음, 80%는 한 번(반복 억제), Google 백엔드는 없음이다. 임계값을 바꾸면 빨강 | C6 |
| D7 미완료 | `abandoned_pending_and_failed_objects_are_counted_and_reclaimed_after_seven_days`(실 PG) | `pending`이거나 `failed`인 6일 된 행은 후보가 아니고 8일은 후보다. 사용량의 「미완료·실패」 칸이 그 바이트를 센다. 행과 보관소 객체가 같이 지워지고 `complete` 행·메시지에 묶인 행은 건드리지 않는다. 날짜 항을 지우면(6일 행이 지워진다)·status 항을 지우면(`complete`가 지워진다)·사용량 칸을 지우면 빨강 | C6 |
| D7 감사 | `the_reclaim_audit_names_no_file` | `attachment.expired` + `reason: deleted_message`에 이름·Drive id가 없다. 이름을 실으면 빨강 | C6 |
| D8 순서 | `downloadsContract.test.ts`(#4639가 TS 천장 상수에 다시 묶는다) | 시험이 천장 상수의 이름·값을 읽는다. 지금처럼 `MAX_ATTACHMENT_BYTES`(기본 100 MiB)에 묶여 있으면 천장을 올려도 초록이라 이 행이 못 선다. #4639 뒤에는 천장을 300 MiB로 올리는 PR이 IPC가 청크 전송이 되기 전에 빨갛고, `MAX_DOWNLOAD_BYTES`만 올리고 청크 전송으로 바꾸지 않아도 빨갛다 | #4639·C4 |

사보타주를 실제로 돌린 결과(어떤 되돌림이 어떤 시험을 빨갛게 했는지)는 각 구현 PR 본문이 정본이다. 이 증보는 문서뿐이라 시험을 돌리지 않았다(`runtime-unverified`).

## 증보 6 (2026-11-02, #5072): 풀기 뒤의 거절을 둘로 나눈다 · PDF 자식을 가둔다 · 코어 덤프를 끈다

증보 4의 독립 보안 검수 2회차(Blocker 0·High 0·Medium 1·Low 4)가 **이월**한 셋을 닫는다. 막는 결함은 아니었고, 증보 4의 「남는 위험」이 「후속」으로 적어 둔 것들이다: ① 토큰을 푼 **뒤**의 실패가 「읽을 수 없는 형식」 404 하나로 말해지는 것(R2-2, 남는 위험 7), ② PDF 자식이 워커와 같은 사용자 번호·파일 시스템·네트워크·`/proc`으로 도는 것(R2-4, 남는 위험 2), ③ 코어를 호스트 처리기로 보내는 배포에서 `RLIMIT_CORE`가 듣지 않는 것(R2-5의 남은 절반, 남는 위험 2). 새 길·새 라우트·새 비밀·migration은 없다.

- Status: **Accepted** (2026-11-02, planner 위임 결정, ADR-0100 — #5072 worker 기안). 등급 2: A는 증보 3이 Accepted로 못 박은 라우트의 「거절 한 모양」을 풀기 **뒤에 한해** 바꾸고, B는 프로세스 가둠 경계를 넓히며 새 의존을 들인다. 독립 보안 검수 1회차 Blocker 0·High 0·Medium 1·Low 5의 R1-1(x32 번호 거절)·R1-2(단계별 닫힘 시험)·R1-3(열린 호출을 목록·인자 규칙으로 막음)·R1-4(SIGSYS는 「잠시 뒤에」)·R1-5를 반영했고(R1-6은 #5175), Linux aarch64(uid 10001·root·`seccomp=unconfined`) 실측이 통과했다. **남은 조건**: 배포 직후 Railway agent-worker에서 서비스와 같은 사용자 번호(10001)로 자식을 한 번 돌려 `exit=0`을 확인한다(실패하면 PDF 읽기는 닫히고 「잠시 뒤에」로 답한다).
- 증보 4의 D6(「이 404가 한 코드로 읽는 원인은 넷이다」)과 남는 위험 7·2의 「후속」 문장은 이 증보가 대신한다. 증보 4 본문은 고치지 않고 아래 「증보 4·ADR-0201 문장의 정정」이 가리킨다.

### A. 풀기 뒤의 거절을 둘로 나눈다 (R2-2)

- **변경 전**: 라우트(`GET /v1/self-media/{ws}/{token}`)는 풀기에 성공한 **뒤**에도 보관소의 읽기 실패·읽다가 끊김·파일 없음·행과 바이트의 길이 불일치·바이트가 선언한 종류가 아님을 모두 같은 404 한 모양으로 답했다. 워커는 읽기 용도에서 발급이 성공한 뒤의 404를 `attachment_not_readable`(「읽을 수 없는 형식이에요… 다시 만들어 올려 주세요」, 영구 문구)로, 아바타 용도에서는 `attachment_not_available`(없는 파일)로 읽었다. 그래서 보관소가 잠깐 아프거나 행과 보관소가 어긋난 **본인 파일**에 틀린 문구가 나갔고(증보 4 남는 위험 7), 같은 보관소 실패를 워커가 직접 읽을 때는 `drive_unavailable`(「잠시 뒤에」)로 말해 api 길과 직접 길이 같은 실패를 다르게 말했다. 또 그 404들이 호출 주소의 거절 예산을 써서, 보관소 장애가 이어지는 동안 그 워크스페이스의 읽기가 429로 닫혔다(증보 3 남는 위험 3의 자기 유발 형태).

#### 결정

- **A1 · 풀기 뒤에만 모양이 둘이 된다.** 라우트가 토큰을 푼 뒤(`redeem_in_tx`가 원본을 돌려준 뒤)의 실패는 둘로 나뉜다. ① 보관소가 바이트를 주지 못했거나(열기 실패·읽다가 끊김·파일 없음) 행이 선언한 길이와 읽은 바이트의 길이가 다르면 **502 하나, 고정 본문 하나**(`{"error":{"message":"the stored file could not be read"}}`). ② 바이트가 선언한 종류가 아니면 지금까지처럼 **404 한 모양**(본인 파일의 영구한 성질이고 워커는 읽기 용도에서 이를 「읽을 수 없는 형식」으로 말한다). 길이 검사가 종류 검사보다 앞이다(길이가 어긋난 바이트의 종류는 판정하지 않는다). 풀기 **전**의 모든 거절(형식 오류·모르는 토큰·다른 워크스페이스·만료·사용됨·런 종료·남의 파일·지운 메시지)은 지금까지처럼 같은 404 한 모양이다 — **존재를 알리지 않는 성질은 풀기 전에 모두 남는다.**
- **A2 · 왜 새지 않는가.** 502를 받는 호출자는 풀기에 성공한 토큰(256비트, 1회용, 워크스페이스·런·요청자·첨부 하나에 묶임)을 이미 증명했다. 그 토큰으로는 요청자 **본인의** 파일 하나만 닿고, 502는 그 하나의 보관소 상태 말고 아무것도 새로 알려 주지 않는다. 남의 파일의 존재·크기를 묻는 길은 풀기 전 거절이고, 그것은 한 모양 그대로다. 본문은 고정 문장이다 — 어떤 원인도, 파일 id도, 보관소 문자열도 담지 않는다(원인은 로그에 고정 낱말 하나로만 남는다: `size`·`archive_open`·`archive_read`·`length`).
- **A3 · 거절 예산.** 거절 예산은 404만 센다(`per_ip_refused_by`의 `refused` 상태). 502는 추측이 아니라 증명한 호출자의 보관소 실패이므로 예산을 쓰지 않는다. 보관소 장애가 그 워크스페이스의 사진·파일 읽기를 429로 잠그지 않는다.
- **A4 · 워커는 바뀌지 않는다.** 워커는 이미 404 밖의 상태를 `drive_unavailable`로 읽는다(증보 3 D6). 읽기 용도는 보관소 실패와 길이 불일치에서 영구 문구가 「잠시 뒤에」 문구로 바뀐다. 아바타 용도는 감사의 이유 코드가 `attachment_not_available`에서 `drive_unavailable`로 바뀐다(`prepare`의 모든 오류는 같은 폴백 `CouldNotPropose`로 가므로 사용자 문장은 같다). 이제 직접 읽기와 api 읽기가 같은 보관소 실패를 같은 코드로 말한다.
- **A5 · `consume-then-fetch`는 그대로다.** 보관소 오류가 토큰을 태우는 것은 단일 사용 계약(증보 3 D1)의 일부이고 502도 같다. 워커는 한 번만 시도한다.
- **A6 · 적합성 시험.** `self_media_conformance_pg::every_refusal_is_one_identical_404_that_never_reads_drive`는 풀기 전 거절과 종류 불일치 열둘이 같은 404임을 계속 단정하고(보관소 miss는 이 목록에서 빠졌다), 보관소가 실패하는 다섯 방식(열기 실패·읽다가 끊김·파일 없음·한 바이트 짧음·한 바이트 김)이 **같은 502 하나**이고 어떤 보관소 흔적도 담지 않으며 거절 예산을 쓰지 않음은 새 시험 `after_the_token_is_spent_a_failing_archive_is_one_502_that_names_nothing_and_spends_no_budget`가 단정한다. 길이 시험 `a_stream_one_byte_short_or_long_is_refused_and_never_truncated`은 404가 아니라 502를 단정하고, 길이가 틀린 데다 **종류도 틀린** 바이트(HTML 한 바이트 짧음·김)도 404가 아니라 502임을 함께 단정해 A1의 「길이 검사가 종류 검사보다 앞」을 잰다(검수 1회차 R1-5: 이 순서는 처음에 시험이 없었다).

#### 바뀌지 않는 것

경로·메서드·200의 헤더 목록, 풀기 전 거절의 한 모양과 그 예산 키, 토큰의 수명·단일 사용·해시만 저장, 발급과 풀기의 소유 재판정, 리디렉션 없음, `Drive` 흔적 없음(502도 같다).

#### 남는 위험 (A)

1. **풀기에 성공한 호출자는 자기 파일의 보관소 상태를 안다.** 502와 200과 종류 불일치 404를 가를 수 있다. 호출자는 워커나 같은 호스트의 Hermes(C2a)이고 토큰이 요청자 본인의 파일 하나에 묶여 있어 새는 것이 없다. 풀기 **전**의 거절은 한 모양이라 이 신호로 남의 파일을 짚을 수 없다.
2. **발급 뒤의 404는 이제 원인이 둘이다.** ① 본인 파일이 종류와 달리 읽을 수 없는 모양(영구, 이 문구가 맞다). ② 발급과 풀기 사이, 요청 하나의 길이 안에 주소 자체가 무효가 된 경우(런이 끝났다·메시지가 지워졌다·1분이 지났다). ②는 풀기 **전** 거절이라 라우트가 ①과 가르면 낯선 사람에게 알리게 되므로 가르지 않는다. 읽기 용도는 이때도 「읽을 수 없는 형식」이라 말한다. 창은 요청 하나의 시간이고 시험이 이 창을 재지는 않는다.
3. **영구한 길이 불일치는 계속 「잠시 뒤에」로 말해진다.** 행과 보관소의 바이트 길이가 영구히 어긋난 파일은 502이고 사람은 같은 말을 되풀이해 듣는다. 정직한 문장(「이 파일은 저장소에 온전히 없어요」)은 보관소의 상태를 진단하는 일이라 이 증보의 밖이다. 증보 4 남는 위험 7에서 틀린 문구를 낸 길이 이제는 덜 틀린 문구(재시도 가능성을 말하는)를 낸다.
4. **보관소 장애의 로그는 요청마다 한 줄이다.** 고정 낱말 하나이고 주소·토큰·워크스페이스·파일 id를 담지 않는다. 장애가 길면 줄이 쌓이는 것은 `warn!` 수준의 운영 신호다.

### B. PDF 자식을 가둔다 · 코어 덤프를 끈다 (R2-4·R2-5)

- **변경 전**: 자식은 빈 환경, 주소 공간·코어 한도, 자기 마감을 스스로 걸었다. 그 밖에는 워커와 같은 사용자 번호·같은 파일 시스템·같은 네트워크·같은 `/proc`으로 돌았다(증보 4 남는 위험 2 「`env_clear`는 가둠이 아니다」). 코어는 `RLIMIT_CORE`로만 막았는데, 이 한도는 코어를 파일로 쓰는 호스트에서만 확실하다. `core_pattern`이 파이프(`|`)인 호스트에서는 한도를 따를지가 처리기 몫이라 코드가 보장하지 못한다.

#### 비교한 방식 — 실측

측정한 곳은 **Docker 기본 프로파일의 비 root 컨테이너**다(이미지의 `momo`와 같은 uid 10001, `CapEff` 0, 기본 seccomp. Colima VM: Linux 6.8, aarch64). Railway의 agent-worker는 `RAILWAY_RUN_UID`를 주지 않아 같은 모양으로 돈다(api만 root로 시작해 `setpriv`로 내려간다. `infra/railway/railway.json`). **Railway 런타임 자체는 측정하지 못했다**(미확인). 그래서 고르는 기준은 「Railway가 무엇을 허락하는지 몰라도 되는 길」이다.

| 방식 | 측정 | 비용 | 판단 |
|---|---|---|---|
| 자식을 다른 사용자 번호로 | `setresuid`가 `Operation not permitted`. 되려면 워커가 root(`CAP_SETUID`)로 돌아야 한다 | 워커를 root로 올려야 한다 — 최소 권한의 후퇴이고 api만 그렇게 돈다 | 기각 |
| 네임스페이스(`unshare`) | 사용자·네트워크·마운트·PID 넷 모두 `Operation not permitted` | | 기각 |
| 시스템 호출 필터(seccomp) | 설치된다: root와 uid 10001 모두에서, `no_new_privs`만으로 | 새 의존 `seccompiler` 하나 | **채택** |
| 덤프 불가 표시(`PR_SET_DUMPABLE`) | 권한이 필요 없다 | `rustix`(이미 락 파일에 있다) | **채택** |
| Landlock(경로 기반 파일 시스템 제한) | 커널 5.13+, LSM 목록, 런타임의 seccomp 허용에 달려 있다 — Railway 미확인 | 새 crate 셋 | 후속(플랫폼을 확인한 뒤) |

덤프 불가 표시의 구현 비교(이슈가 묻는 「`unsafe` 한 줄 vs 새 의존」): `unsafe { libc::prctl(..) }`는 `unsafe_code = "allow"`를 **워커 crate 전체**에 주어야 한다(비밀을 가장 많이 쥔 바이너리의 `forbid`를 푼다)이고 `server-rust/unsafe-allowlist.tsv` 항목이 따라온다. 별도 crate로 빼도 새 crate와 같은 항목이다. `rustix::process::set_dumpable_behavior`는 안전한 함수이고 `rustix`는 이미 락 파일에 있다(`tempfile`·`oort-cli` 경유) — 새 crate가 아니라 새 간선 하나다. 라이선스 `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`. 필터는 `seccomp(2)`를 직접 불러야 해서 `unsafe` 없이는 쓸 수 없고, 같은 이유로 `seccompiler`(Firecracker·rust-vmm 프로젝트의 것, `Apache-2.0 OR BSD-3-Clause`, 의존은 이미 있는 `libc`뿐, 기본 기능 없음)를 들인다. `deny.toml`의 라이선스 문(`scripts/check_cargo_licenses.sh`)이 통과하고 NOTICE·`legal/THIRD_PARTY_NOTICES.md`·생성 묶음에 반영했다.

#### 결정

- **B1 · 덤프 불가 표시(Linux).** 자식은 `PR_SET_DUMPABLE`을 0으로 한다. 두 가지를 얻는다. ① 코어가 만들어지지 않는다: 커널은 코어를 파일로 쓰든 호스트 처리기로 보내든 먼저 덤프 가능 여부를 묻고(`fs/coredump.c`의 `do_coredump`), `RLIMIT_CORE`와 달리 처리기가 따를지에 달려 있지 않다. 이 Mac의 Colima에서 `RLIMIT_CORE`를 무제한으로 둔 채 자기 자신을 `SIGABRT`로 끝내면 기본 상태는 `core` 파일이 남고 `PR_SET_DUMPABLE` 0 뒤에는 남지 않았다(root와 uid 10001 모두). ② `/proc/<pid>/`가 root 소유가 되어 같은 사용자의 워커가 자식의 `environ`·`mem`·`fd`를 읽거나 ptrace하지 못한다(uid 10001에서 소유자 `10001`→`0`으로 측정, 개인 박스의 `verify-m3.sh`가 같은 방식으로 잰다). **순서가 설계의 일부다**: 이 표시는 가둠의 마지막 한도다. 표시를 한 뒤에는 자식 자신의 `/proc/self/*`도 root 소유라 권한 없는 쓰기가 거절되므로 `oom_score_adj`의 쓰기를 그 앞에 한다. 감독자의 RSS 읽기(`/proc/<자식>/status`)는 누구나 읽는 파일이라 덤프 불가인 자식에도 그대로 된다(Linux 시험이 잰다).
- **B2 · 시스템 호출 필터.** 한도와 감시 스레드가 선 뒤 자식은 **모든 스레드에** 필터를 건다(`apply_filter_all_threads`, 감시 스레드 포함). 거절하는 것은 여덟 군이고 모두 `EPERM`이다. ① 파일 이름으로 열기(`openat`·`openat2`·핸들 기반·`open_tree`, x86-64의 `open`·`creat`·`uselib`). ② 이름으로 파일 바꾸기(`unlinkat`·`mkdirat`·`renameat`·`renameat2`·`linkat`·`symlinkat`·`truncate`·`fchmodat`·`fchmodat2`·`fchownat`·`utimensat`·`mknodat`·경로형 xattr, x86-64의 옛 철자 `unlink`·`rmdir`·`mkdir`·`rename`·`link`·`symlink`·`chmod`·`chown`·`lchown`·`utime`·`utimes`·`futimesat`·`mknod`). ③ 소켓과 메시지 큐(`socket`·`connect`·`bind`·`listen`·`accept`·`accept4`·`mq_open`·`mq_unlink`). ④ 다른 프로그램(`execve`·`execveat`). ⑤ 다른 프로세스: 들여다보기(`ptrace`·`process_vm_*`·`pidfd_open`·`pidfd_getfd`·`kcmp`·`perf_event_open`), 신호 보내기(`kill`·`tkill`·`rt_sigqueueinfo`·`rt_tgsigqueueinfo`·`pidfd_send_signal`, 그리고 `tgkill`은 **자기 프로세스가 아닌 쪽에만** — `abort()`가 `tgkill(getpid(), …)`로 자기에게 `SIGABRT`를 보내므로 그 한 가지는 열어 둔다. `kill`만 막고 `tgkill`을 아무 pid에나 열어 두면 워커를 죽이는 길이 그대로라 의미가 없다), 한도 바꾸기(`prlimit64`는 pid 0, 곧 자기 자신만). ⑥ 앞의 ①③을 필터 모르게 해 주는 `io_uring_*` 셋. ⑦ 파서가 쓸 일 없는 커널 인터페이스(`bpf`·`userfaultfd`·`keyctl`·`add_key`·`request_key`·`unshare`·`setns`·마운트 계열). ⑧ 덤프를 도로 켜는 `prctl(PR_SET_DUMPABLE, …)`(자식은 필터를 걸기 **전에** 스스로 껐고, 그 안에서 도는 코드가 되돌릴 수 없어야 한다).
  - **컨테이너 런타임의 프로파일에 기대지 않는다**(검수 1회차 R1-3). 처음 판에는 이 필터가 아니라 Docker의 기본 프로파일이 막고 있던 호출이 있었다(`perf_event_open`·`bpf`·`keyctl`·`unshare`가 그랬다). 위 군은 프로파일이 없는 런타임(`seccomp=unconfined`, 프로파일을 안 건 쿠버네티스 파드)에서도 모두 거절이다. 자식이 쓰는 기술자는 이미 열린 stdin·stdout·stderr뿐이다. 그래서 파서가 어떤 말에 속아 실행되어도 `/proc/<워커>/environ`(또는 어떤 파일이든)을 열지도, DB나 사설망에 닿지도, 셸을 띄우지도, 워커를 죽이거나 이 목록이 이름 붙인 길로 들여다보지도 못한다(남는 위험 2·3이 목록 밖의 열린 것을 적는다).
  - **구조는 거부 목록이다**(허용 목록은 「올해 glibc가 부르는 것의 목록」이라 이미지가 바뀌면 PDF 하나가 읽히지 않는 모양으로 깨지는 대가가 크다). 거절은 죽이는 것이 아니라 `EPERM`이다(실수로 부른 호출은 오류로 보고되고, 부른 쪽이 공격자면 거절을 볼 뿐 충돌을 탐침으로 쓰지 못한다).
  - **어느 ABI로 오는 호출인가**(검수 1회차 R1-1). 필터는 이 바이너리가 빌드된 구조(`std::env::consts::ARCH`)의 호출만 판정한다. 다른 구조의 호출(32비트 `int 0x80`은 `AUDIT_ARCH_I386`)은 필터 자신의 구조 검사로 프로세스가 끝난다. **x86-64의 x32 ABI는 다르다**: `CONFIG_X86_X32_ABI`로 빌드된 커널에서 x32 호출은 x86-64와 **같은 구조 값**에 번호의 30번 비트(`0x4000_0000`)만 켜서 오고, 그러면 목록의 어떤 번호와도 맞지 않아 거부 목록 전체가 통과한다(`seccomp(2)`가 거부 목록 필터의 함정으로 이름 붙인 것이다. 검수 1회차가 처음 목록 24개가 모두 통과함을 모델로 쟀고, 이 규칙을 지운 채 돌리면 넓힌 목록의 aarch64 62개도 모두 통과한다). 그래서 프로그램의 첫 규칙이 **30번 비트가 켜진 번호를 모두** 거절한다(`EPERM`). x32 번호의 목록을 따로 두지 않는다 — x32에는 `n | 0x4000_0000`이 아닌 고유 번호 512–547도 있고, 목록을 두면 이 문제를 한 번 더 겪는다. 64비트 빌드는 그런 호출을 하지 않는다.
  - 구조는 이 바이너리가 빌드된 구조다. aarch64는 컨테이너에서 컴파일하고 실행했으며, x86-64는 이 모듈만 컴파일(`--lib --tests`)했다(아래 runtime-unverified).
- **B3 · 단계마다 닫힌 이름을 갖는다.** 한도 둘(`core_limit`·`address_space`), `dumpable`, `watchdog`, `filter` — 닫힌 목록이다. 한 단계라도 걸 수 없으면 자식은 아무것도 읽지 않고, 단계 낱말 하나를 담은 JSON 한 줄(`{"ok":false,"code":"confine_failed","step":"filter"}`)을 쓰고 종료 상태 2로 끝낸다. 감독자는 이를 지금까지처럼 「서버 탓」(`Unavailable`)으로 읽고, **목록에 있는 낱말만** 경고 한 줄로 남긴다(자식은 공격자의 바이트를 파싱하므로 자기가 만든 글은 로그에 가지 못하고 `unknown`이 된다). **다섯 단계 모두를 시험이 잰다**(검수 1회차 R1-2): 호스트가 단계마다 호출 **하나만** 거절하게 하고(`prlimit64`의 자원 하나·`prctl`의 `PR_SET_DUMPABLE`·스레드 만들기·`seccomp(2)`) 진짜 워커 바이너리를 자식으로 띄워, 자식이 문서를 한 글자도 읽지 않고 종료 2와 그 단계의 낱말을 내는지 본다. 처음 판의 시험은 `filter` 하나만 재서 나머지 넷의 오류를 `let _ =`로 무시해도 모든 시험이 초록이었다.
- **B4 · 닫는다 — 그 대가를 이름 붙인다.** 증보 4 남는 위험 2는 `oom_score_adj` 쓰기를 일부러 best effort로 두었다: 닫으면 `/proc`을 쓸 수 없는 환경에서 모든 PDF가 「잠시 뒤에」가 되기 때문이었다. 이 증보의 두 단계는 반대로 **닫는다**. ① 그 쓰기는 읽기 상한이 기대지 않는 거드는 일이지만 이 두 단계는 R2-4·R2-5의 **전부**다 — 풀려 있으면 가둠이 닫힌 것이 아니다. ② 둘 다 특권도 파일도 필요 없는 호출(`prctl`·`seccomp(2)`)이라 실패한다면 호스트가 막은 것이다(Docker의 기본 프로파일은 허용한다 — 측정. 다른 런타임은 미확인). 그것을 조용히 건너뛰면 가장 약한 호스트에서 가장 약한 가둠으로 공격자의 바이트를 읽는다. **대가**: 그런 호스트에서는 모든 PDF가 「잠시 뒤에」이고 사람이 보는 증상만으로는 일시 장애와 구별되지 않는다. **완화**: 걸 수 없었던 단계가 경고 한 줄에 단어로 남는다(B3). ③ **호스트가 이 호출들에 오류가 아니라 프로세스를 죽이는 프로파일**(`SCMP_ACT_KILL`)을 걸면 자식은 말 한마디 못 하고 `SIGSYS`로 죽는다(검수 1회차 R1-4: 처음 판에서는 이것이 「읽을 수 없는 형식」이라는 영구 문구로 나가고 어디에도 단계가 남지 않았다 — 위 ②가 설명한 실패보다 나쁜 모양이다). 감독자는 `SIGSYS`로 죽은 자식을 파일 탓이 아니라 이 기계 탓으로 읽고(「잠시 뒤에」) 같은 형식의 경고 한 줄(`step="host_killed"`)을 남긴다. 파일이 자식을 `SIGSYS`로 죽일 길은 없다(자식 자신의 필터가 프로세스를 끝내는 것은 낯선 ABI뿐). **다른 신호는 파일의 몫으로 둔다**: `SIGABRT`는 파서 자신의 스택 넘침 처리기와 실패한 할당이 끝나는 모양이라 영구 문구가 맞다(#4970의 검수가 악성 PDF 14종 중 3종이 그렇게 끝남을 쟀다). 모든 신호를 호스트 탓으로 읽으면 서버가 파일의 일을 떠안는다. 시험은 `SIGSYS`가 서버 탓이고 `SIGABRT`·`SIGSEGV`·`SIGKILL`은 파일 탓임을 둘 다 잰다. **배포 직후 planner가 하는 첫 확인**(Railway의 agent-worker 서비스에서, **서비스와 같은 사용자 번호(10001)로** — `railway ssh`의 셸이 root면 덤프 불가·`/proc` 소유의 뜻이 달라 root의 통과는 서비스의 증거가 못 된다): `momo-agent-worker --attachment-text-child < 평범한.pdf; echo $?`가 `{"ok":true,…}`와 `0`이면 이 증보의 가둠이 그 런타임에서 걸린 것이고, `2`와 로그의 `step=`이면 어느 단계를 그 런타임이 막는지 알려 준다.
- **B5 · 의존.** `seccompiler`(리눅스 한정 목표 의존, 새 crate 하나)와 `rustix`·`libc`(이미 락 파일에 있고 이제 워커의 직접 의존, 리눅스 한정). `unsafe_code = "forbid"`는 그대로이고 `unsafe-allowlist.tsv`는 바뀌지 않는다(`check_unsafe_policy.py` 초록).

#### 바뀌지 않는 것

자식의 프로토콜(stdin → 한 줄 JSON), 빈 환경, 감독자의 kill·회수·슬롯 둘·출력 상한·메모리 감시·자기 마감, 워커 프로세스의 설정과 권한, 라우트·토큰·소유 판정.

#### 남는 위험 (B)

1. **같은 사용자 번호·같은 파일 시스템·같은 네트워크 네임스페이스는 그대로다.** 필터는 새 손잡이를 얻는 길을 막을 뿐이고 이미 열려 있는 기술자는 건드리지 않는다. 자식에게 상속되는 다른 기술자가 있으면(워커의 close-on-exec가 아닌 기술자) 그 위의 `sendto`·`write`류는 막지 않았다. 시험 부모(tokio `Command`, 빈 환경, 파이프)가 띄운 자식은 0·1·2뿐임을 쟀지만(검수 1회차), 실제 워커는 C 라이브러리(ONNX 런타임)를 들고 있어 그렇지 않은 기술자가 생길 수 있고 그것은 시험 부모로 재지 못한다. **후속 이슈**: 자식이 필터 앞에서 `/proc/self/fd`를 읽어 3 이상이 있으면 닫힘(새 단계 낱말)으로 끝낸다(R1-6, 이 증보에서 하지 않는다).
2. **거부 목록은 본질상 열거한 것만 막는다.** 새 커널이 더하는 호출과 같은 일을 하는 **다른 철자**가 목록에 없으면 열린다. 이 증보에서 실제로 있었다: aarch64에서 glibc의 `rename`은 `renameat`이고 처음 목록에는 `renameat2`만 있었다 — 실 커널 프로브가 찾았다(그래서 프로브는 시스템 호출 번호가 아니라 `std`로 부른다. 철자는 구조마다 다르다). 군(파일 열기·파일 바꾸기·네트워크·실행·다른 프로세스·`io_uring`) 단위로 의미를 유지하고 커널 기준이 바뀔 때 목록을 다시 본다. x86-64의 철자(`rename`·`unlink` 등)는 CI의 첫 실행이 처음 잰다. **목록 밖에서 측정한 열린 호출**(검수 1회차 R1-3, 진짜 필터 뒤 uid 10001): 메타데이터(`readlinkat`·`newfstatat`·`statx`·`faccessat` — 경로의 존재·크기·모드를 알려 줄 뿐 내용은 아니다), `socketpair`·`memfd_create`·SysV 공유 메모리(프로세스 안의 통로), `prctl`의 다른 선택지, 같은 사용자 프로세스를 방해하는 `setpriority`·`sched_setaffinity` 계열(파일도 내용도 건드리지 않는 방해 수준), 그리고 `clone`·`clone3`로 만드는 네임스페이스(`clone3`의 플래그는 메모리 안이라 필터가 못 본다. 파일 열기·소켓·실행·마운트가 모두 거절이라 새 네임스페이스에서 얻는 것이 없다).
3. **이름으로 파일을 바꾸는 호출과 신호는 이제 막는다**(검수 1회차 R1-3 이전에는 열려 있었다: 측정에서 `unlinkat`이 파일을 실제로 지우고, `truncate`가 크기를 0으로 만들고, `kill`이 같은 사용자의 옆 프로세스를 죽였다). 위 B2의 ②·⑤다. 남는 것은 메타데이터 읽기와 이미 열린 기술자 위의 일뿐이다.
4. **워커 프로세스 자신은 덤프 불가로 표시하지 않았다.** 워커의 코어 덤프(비밀을 담는다)와 `/proc/<워커>`의 보호는 자식의 필터(워커의 `/proc`을 열지 못한다)가 지금 막고 있다. 장기 실행 서비스인 워커를 덤프 불가로 하면 `/proc/self/*`의 소유가 root로 바뀌고 장애 때의 진단이 달라지므로 별도 결정이다(후속).
5. **「두 PDF 자리의 공정성」(한 사람이 두 자리를 다 쓰는 경우)은 #5042와 합쳐 다음으로 넘긴다.** 슬롯 둘이 프로세스 공용인 것(증보 4 남는 위험 2)은 그대로다.
6. **Railway 런타임, x86-64 실행, 파이프 처리기로 가는 실제 덤프는 미확인이다**(아래 runtime-unverified). 가장 큰 모름은 B4의 대가가 Railway에서 나타나는지다.

### 증보 4·ADR-0201 문장의 정정

- 증보 4 D6의 「이 404가 한 코드로 읽는 원인은 넷이다」와 남는 위험 7은 A가 대신한다(404에 남는 원인은 본인 파일이 종류와 다른 모양과 요청 하나의 길이 안에 주소가 무효가 된 경우의 둘).
- 증보 4 남는 위험 2의 「`env_clear`는 가둠이 아니다」 뒤의 「후속(이월)」 둘은 B가 대신한다. 「`oom_score_adj`는 best effort」는 그대로 맞고, 이제 그 앞에 닫히는 단계 둘(덤프 불가·필터)이 있다.
- ADR-0201 증보 v3.1의 검수 1회차 ①(「api 길에서는 … `unreadable_format`으로 읽힌다」)과 2회차 ③은 A 뒤로 보관소 실패·길이 불일치에 한해 사실이 아니다. ADR-0201 본문에 포인터를 달았다.
- 증보 3 남는 위험 3의 「api 쪽 저장소 오류」가 예산을 쓴다는 문장은 A 뒤로 사실이 아니다.
- (검수 1회차) 이 증보의 처음 판이 쓴 두 문장을 고쳤다: B2의 「다른 ABI는 필터 자신의 구조 검사로 끝난다」는 x86-64의 x32에는 맞지 않았고(위 B2), B 남는 위험 2의 「데이터로 가는 길은 그대로 닫혀 있다」와 모듈 문서의 「워커의 메모리를 들여다보지 못한다」는 이 필터가 아니라 Docker의 기본 프로파일이 막던 길까지 세고 있었다(위 B2).

### runtime-unverified

- **Railway 런타임에서 필터가 걸리는지.** Docker 기본 프로파일(Linux 6.8, aarch64)에서 root와 uid 10001 모두 걸리는 것만 쟀다. 걸리지 않으면 B4의 대가가 나타난다. 배포 직후의 첫 확인이 위 B4에 있다.
- **x86-64 실행.** `attachment_lockdown`을 x86-64 목표로 컴파일(`cargo check --target x86_64-unknown-linux-gnu --lib --tests`)했을 뿐이다. 호출 번호는 `libc`의 구조별 상수이고 BPF 구조 검사가 그 구조를 쓴다. 첫 실행은 CI(Linux)다.
- **x32 ABI를 켠 커널에서의 실제 호출.** 모델(같은 crate가 만든 BPF를 시험이 커널처럼 돌린다)로만 쟀고 모델은 커널이 아니다. x86-64 러너 대부분은 x32가 꺼져 있어 CI도 그 호출을 만들지 못한다.
- **호스트가 `SIGSYS`로 끝내는 프로파일에서의 실제 자식.** 감독자의 읽기는 신호로 끝나는 쉘 스크립트로 쟀고(모든 unix), 진짜 자식이 `seccomp(2)`에서 `SCMP_ACT_KILL_PROCESS`로 죽는 것은 Docker 프로파일을 직접 만들어 한 번 실행했다(인계 기록).
- **호스트 처리기로 코어를 보내는 배포(`core_pattern`이 파이프)에서의 실제 덤프.** `core_pattern`은 커널 전역 설정이라 공유 VM에서 바꾸지 않았다. 파일 코어에서 `PR_SET_DUMPABLE` 0이 `RLIMIT_CORE` 무제한에서도 덤프를 막는 것(위 B1)과, 파이프 처리기 앞에서 덤프 가능 여부를 먼저 묻는 커널 코드 읽기로 갈음했다.
- **`io_uring_*`·`ptrace`·`process_vm_*`·`pidfd_getfd`·`kcmp`·`openat2` 등 실행으로 못 잰 필터 항목.** 안전한 Rust로 부를 수 없거나(`unsafe` 필요) 기본 프로파일이 이미 막아서 대조가 안 된다. 컴파일된 필터가 각 항목에 `EPERM`을 답하는 것은 시험이 잰다.
- **덤프 불가·`oom_score_adj` 순서의 단정은 권한 없는 사용자의 실행이 잰다**(root는 모든 `/proc` 파일을 소유하고 root 소유 파일에 쓸 수 있어 통과해 버린다). CI 실행기는 root가 아니다. 시험이 root 실행에서 이를 출력한다.

### red proof (B)

| 결정 | 시험 | 분기를 지우면 빨강 (사보타주 결과는 PR 본문이 정본) |
|---|---|---|
| B1 덤프 불가 | `attachment_text::tests::a_locked_down_child_is_refused_…`(커널의 `PR_GET_DUMPABLE`), `attachment_text_child::a_child_confines_itself_before_it_reads_a_byte`(`/proc/<자식>/environ` 소유자 0 — 권한 없는 실행) | `set_dumpable_behavior` 호출을 지우면 |
| B1 순서 | 같은 시험의 `oom_score_adj` 1000(권한 없는 실행) | `oom_score_adj` 쓰기를 덤프 불가 표시 뒤로 옮기면 |
| B2 설치 | 위 프로브의 「한 뒤」 열여덟 줄과 `a_child_confines_itself_…`의 필터 개수(시험 프로세스보다 하나 더, 모든 스레드) | `lock_down`이 필터를 설치하지 않으면 |
| B2 모든 스레드 | `a_child_confines_itself_…`(스레드마다 필터 개수), 진짜 자식의 `the_child_confines_itself_before_any_thread_pool_exists_and_still_reads` | `apply_filter_all_threads`를 `apply_filter`로 바꾸면(감시 스레드가 걸리지 않는다) |
| B2 목록 | `attachment_lockdown::tests::every_refused_call_is_answered_eperm_and_the_calls_a_read_needs_are_allowed`(컴파일된 필터를 호출마다 실행), 그리고 **실 커널** 프로브(`socket`은 `UnixDatagram::unbound()`로 `socket(2)`만, 파일 바꾸기·신호·`prctl`은 `std`로 불러 libc가 구조의 철자를 고른다) | 거부 목록에서 호출을 지우면 — `socket`·`kill`·`unlinkat`·aarch64 `renameat`을 실제로 하나씩 지워 보았다 |
| B2 인자 규칙 | `attachment_lockdown::tests::prctl_prlimit_and_tgkill_are_refused_for_their_dangerous_arguments_only`, 프로브의 「turn the dump back on」·`dumpable` 읽기, 프로브가 `abort()`로 끝나며 `SIGABRT`임을 단정 | `tgkill`·`prlimit64`·`prctl` 규칙을 지우면(모델), `tgkill`을 모든 pid에 막으면(모델과 프로브의 `SIGABRT`: `abort()`가 자기에게 신호를 못 보낸다) |
| B2 x32 | `attachment_lockdown::tests::every_call_through_the_x32_door_is_refused_and_the_native_ones_keep_their_answers`, `…::a_program_that_does_not_open_with_the_architecture_check_is_not_given_a_door_to_leave_open` | 30번 비트 규칙(`refuse_x32`)을 지우면(고치기 전: 거부 목록의 모든 번호가 x32 짝으로 통과) |
| B2 읽기 | 진짜 자식의 PDF 읽기 시험 전부(`the_real_child_…`·`a_long_pdf_reads_under_the_filter_and_the_limits`·메모리 폭탄·`the_shipped_ceiling_…`) | 필터가 할당기·시계·감시 스레드를 깨면 |
| B3·B4 닫힘 | `a_host_that_refuses_any_one_step_gets_a_child_that_reads_nothing_and_names_it`(다섯 단계, 단계마다 호스트가 호출 하나만 거절), `a_child_that_could_not_confine_itself_is_the_servers_fault_not_the_files` | 한 단계의 오류를 `let _ =`로 무시하면(글자가 나오고 종료 0), 종료 상태나 단계 낱말이 바뀌면 |
| B4 호스트가 죽임 | `a_child_the_host_ended_with_sigsys_is_the_servers_fault_and_every_other_signal_is_the_files` | `SIGSYS` 가지를 지우면(영구 문구로 나간다), 모든 신호를 호스트 탓으로 읽으면(`SIGABRT`가 「잠시 뒤에」로 나간다) |
| A1 순서 | `self_media_conformance_pg::a_stream_one_byte_short_or_long_is_refused_and_never_truncated`의 「not an image」 둘 | 종류 검사를 길이 검사 앞으로 옮기면 |
| B3 로그 | `a_child_that_could_not_confine_itself_is_named_by_one_warning_line_and_by_nothing_it_made_up`, `attachment_text::tests::the_step_a_child_names_is_a_word_of_the_closed_list_and_nothing_else` | 감독자가 단계를 남기지 않으면, 자식이 만든 글을 그대로 남기면 |

사보타주를 실제로 돌린 결과(어떤 되돌림이 어떤 시험을 빨갛게 했는지, 어느 것이 권한 없는 사용자의 실행에서만 빨간지)는 PR 본문이 정본이다.

## 증보 7 (2026-11-05, #5223): 보관소 오류에 구분 코드를 싣는다 · 점검·재시작 신호가 닿는 곳

연결 끊김 UX 감사(#5201 1단계, [감사 문서](../planning/research/2026-11-03-connection-lost-ux-audit.md) §2.3·§4·§8 S-E)가 서버에 남긴 두 가지를 정한다. ① 보관소(Drive) 오류의 502·503에 코드가 없어 클라이언트가 「이 인스턴스에 보관소가 없다」와 「길 위의 장비가 낸 502·503」을 가르지 못한다. ② 서버가 점검·재시작 중임을 알리는 신호가 없다. ①은 `error.code`([ADR-0188](0188-phone-remote-work-host.md) R0가 연 칸)에 `drive_` 접두의 닫힌 낱말 셋을 싣고, 기다리면 풀리는 한 경우에만 `Retry-After`를 더한다. ②는 **api가 보낼 수 없다**는 것을 소스로 확인했고, 보낼 수 있는 곳과 쓸 낱말을 정해 두되 보내는 일은 후속으로 넘긴다. 새 라우트·새 상태 코드·새 비밀·migration은 없고, 상태와 문장은 그대로다.

- Status: **Accepted** (2026-11-05, #5223 worker 기안, planner 확인. 점검·재시작 신호는 api가 보낼 수 없어 이름만 예약하고 엣지 후속으로 넘긴 판단을 받아들였다). 등급 1: 공개 API의 가산이다(ADR-0100). **owner 결정(인용): 2026-11-03 「나머진 권장이고」** — #5201에서 고를 것 다섯을 감사 문서의 권장대로 가기로 한 결정이다. 감사 문서가 S-E를 독립 슬라이스(없어도 S-A~S-D는 「서버에 닿지 못했어요」로 동작)로 편성했고, 이 증보는 그 편성을 서버에서 구현하는 기록이다. 아래 코드 낱말과 `Retry-After` 초는 worker의 제안이고 owner가 고른 값이 아니다. 구현은 #5223이다.
- **변경 전**: `drive_error`(`routes/attachments.rs`)는 `DriveError`를 상태 코드로만 옮겼다(`Unavailable`→503, `AccessDenied`·`UpstreamFailure`→502, 그 밖은 400·404·413). 코드도 `Retry-After`도 없었고(`ApiError::new`), 이 한 함수를 쓰는 길은 모두 같았다: 업로드 시작·완료, 내용 읽기(전체·구간·스트림 주소), 멤버·워크스페이스 아바타. 그래서 클라이언트 코어는 502·503을 상태만 보고 한 문장(「파일 보관소가 연결돼 있지 않습니다… 서버 관리자에게 알리세요」)으로 말했고(`attachments/model.ts` `issueForStatus`), 배포 중 길 위의 장비가 낸 502도 같은 문장이 되었다(감사 §2.3). 코어의 「서버에 닿지 못함」 판정(`connection/restSignal.ts` `isUnreachableOutcome`)은 502·504와 **코드 없는** 503을 세므로, 코드가 붙은 503은 서버가 직접 답한 것으로 읽힌다.

### 결정

**D1 · 구분 코드 셋.** `drive_error`가 `error.code`를 싣는다.

| `DriveError` | 상태 | `error.code` | 뜻 | `Retry-After` |
|---|---|---|---|---|
| `Unavailable` | 503 | `drive_not_configured` | 이 인스턴스에 쓸 수 있는 보관소가 없다(설정하지 않았거나 시작할 때 열지 못해 닫혔다). 운영자가 고쳐야 풀린다 | 없음 |
| `AccessDenied` | 502 | `drive_access_denied` | 보관소가 인스턴스 **자신의** 자격을 거절했다(Google 403, 로컬 볼륨의 경로·읽기 전용 가드). 호출자 잘못이 아니고 운영자가 고쳐야 풀린다 | 없음 |
| `UpstreamFailure` | 502 | `drive_upstream_failed` | 보관소 요청이 실패했다(Google의 그 밖의 오류 상태·429·연결 끊김, 행의 길이와 보관소 바이트가 어긋남). 기다리면 풀릴 수 있다 | 5초 |

그 밖의 보관소 답(`InvalidArguments` 400, `FileNotFound` 404, `ContentTooLarge` 413)은 코드를 받지 않는다. 특히 404는 증보 1·2가 「없는 id와 바이트까지 같은 404」로 못 박았으므로 키 하나도 더하지 않는다. 문장(`safe_message`)과 상태는 그대로다.

**D2 · 코드가 있다는 것의 뜻.** 502·503에 코드가 있으면 그 답은 **자기 원인에 이름을 붙인 것**이다(지금은 api가 낸 것이고, D5 ②의 엣지 응답 `server_restarting`도 후속에서 같은 뜻으로 더해진다). 코드가 없으면 api가 낸 것일 수도, 길 위의 장비가 낸 것일 수도 있고 원인을 말하지 않는다. 클라이언트는 코드 있는 502·503을 「서버에 닿지 못함」 증거로 세지 않는다(이름 붙은 원인은 그 이름으로 말한다). 이 증보부터 api가 **새로** 내는 502·503은 코드를 붙인다. 이미 있는 코드 없는 5xx(허들 미구성 503, T3 비활성 503, 실시간 미구성 503, 건강 확인 503, `ApiError::busy`의 503, 워커용 `self_media` 502 …)는 건드리지 않는다. 그 허용 범위는 코어의 「서로 다른 요청 3건 연속」 규칙이 가린다(감사 §4). 코어의 `isUnreachableOutcome`은 지금 502를 코드와 무관하게 세므로, 이 규칙대로 502에도 코드 없음을 요구하는 한 줄이 후속이다(아래 「후속」).

**D3 · `Retry-After`.** 정수 초이고 `drive_upstream_failed`에만 싣는다(5초). 서버가 「기다리면 풀릴 수 있다」고 아는 유일한 보관소 답이다. `drive_not_configured`·`drive_access_denied`에 싣는 것은 거짓이다(운영자가 고칠 때까지 풀리지 않는다). RFC 9110은 이 헤더를 503·429·3xx에 정의하고 다른 상태에서의 사용을 금하지 않는다. 502에 싣는 것은 이 증보의 선택이다. 상태를 503으로 바꾸지 않는다. 502·503 한 쌍은 본 ADR D1(와이어 무변경 이식)이 굳힌 모양이고 코어도 그 둘을 안다. 값은 권고다: 클라이언트는 자기 백오프를 써도 된다. 길이가 어긋난 행은 기다려도 안 풀릴 수 있는데 같은 값이 붙는다(남는 위험 3).

**D4 · 이름.** 워커의 감사 이유 `drive_unavailable`(증보 3 D6, 증보 6 A4)은 같은 원인(`UpstreamFailure`)을 다른 곳(워커의 감사 이유)에서 부르는 낱말이다. 이 증보의 REST 코드는 그것을 대신하지도 따르지도 않는다(`drive_unavailable` ≙ `drive_upstream_failed`). 503의 「미구성」이 `drive_unavailable`을 빌리지 않는 것은 그 이름이 「일시적」으로 읽혀 클라이언트가 기다리게 만들기 때문이다.

**D5 · 점검·재시작 신호: api는 보낼 수 없고, 보낼 곳은 엣지다.** 감사가 재지 못했다고 적은 질문(§9.2 「서버가 점검·재시작 중 `Retry-After`나 구분 코드를 주는지」)을 소스로 닫는다.

1. **api는 종료 신호 뒤 새 요청에 답하지 않는다.** `main.rs`의 `with_graceful_shutdown`(axum 0.8.9 `serve/mod.rs` 287-297: 신호를 받으면 수신 소켓을 닫고 새 연결을 받지 않는다; 408-409: 열린 연결마다 `graceful_shutdown`)은 hyper 1.11(`proto/h1/conn.rs` 876-884)에서 놀고 있는 연결을 곧바로 닫고 처리 중인 요청만 끝낸다. 그래서 api 안에 「종료 중이면 503 `Retry-After`」를 답하는 층을 두어도 거기에 닿는 새 요청이 없다(발동하지 않는 가드가 된다).
2. **교체 중 클라이언트가 받는 502는 api가 만들지 않는다.** api 앞의 장비가 만든다(Railway 템플릿의 Caddy `reverse_proxy api.railway.internal:8080`, `handle_errors` 없음: `infra/railway/Caddyfile.railway`; 셀프호스트 `infra/rust/Caddyfile`도 같다). api가 내려가 있는 틈(종료 뒤 새 api가 뜨기까지)은 api가 아니라 이 장비만 덮을 수 있다.
3. **api가 살아서 `Retry-After`로 「잠시 뒤」를 말하는 5xx는 둘뿐이다**: `ApiError::busy`(503, 코드 없음)와 이 증보의 `drive_upstream_failed`(502). DB가 내려가 있으면 `/health`·`/healthz`는 503 `database unavailable`(코드·`Retry-After` 없음)이고 라우트들은 불투명한 500이다. 이 증보는 이 셋을 바꾸지 않는다.

결정: ① 점검·재시작을 알리는 답의 모양을 **`503` + `error.code` `server_restarting` + `Retry-After`(정수 초)**로 예약한다. 아직 어떤 길도 보내지 않으므로 OpenAPI의 「현재 코드」 목록에는 넣지 않는다(보내기 시작하는 PR이 넣는다). ② 보내는 곳은 **엣지**를 권한다(후속 이슈): Caddy의 `handle_errors`가 `reverse_proxy`의 도달 실패(502·503·504)에 위 모양을 답한다. api가 내려가 있는 전 구간을 덮고, api 코드와 종료 순서를 바꾸지 않는다. `handle_errors`는 Caddy 자신이 만든 오류에만 걸리고 api가 직접 답한 502·503(`drive_*`)은 지나가므로 둘이 섞이지 않는다(Caddy 설명서 기준이며 돌려 보지 않았다: `runtime-unverified`). ③ api 안의 대기 구간(lame-duck: 신호 뒤에도 수신 소켓을 N초 더 열고 503 `server_restarting`)은 **보류**한다. 종료가 N초 늘어 플랫폼의 종료 유예(Railway)·`stop_grace_period`와 맞물리고, 신호 뒤 틈의 앞부분만 덮는다. 엣지로 부족하다고 확인될 때만 다시 연다.

### 바뀌지 않는 것

- 상태 코드와 문장(`safe_message`). 시험이 못 박는다(`the_archive_error_table_matches_swift`, `an_unconfigured_archive_answers_503_from_a_mounted_route`).
- 코드 없는 기존 클라이언트의 동작. 코드 없는 답의 바이트는 그대로이고(`error::tests::an_uncoded_error_keeps_the_original_envelope`: 키 생략 규칙), 코드가 있는 답은 `error` 객체에 키 하나가 늘 뿐이다.
- 400·404·413의 보관소 답(위 D1), `self_media`의 502(워커가 404 밖의 모든 상태를 같은 이유로 읽는다: 증보 3 D6, 증보 6 A), `ApiError::busy`와 그 밖의 코드 없는 5xx.
- 이 길들의 권한·RLS·멤버십 검사 순서와 거절의 모양(증보 1·2). 코드는 보관소를 부른 **뒤**의 실패에만 붙는다.
- 이 한 함수를 쓰는 모든 길이 코드를 상속한다: 업로드 시작·완료, 내용 읽기(전체·구간·스트림 주소·미디어 앞부분), 멤버·워크스페이스 아바타. 행과 보관소의 길이가 어긋나 내는 502(`attachment_bytes`·`attachment_media`)도 `UpstreamFailure`라 `drive_upstream_failed`를 받는다.

### 이슈·감사 문구와 다른 곳

- 이슈는 「점검·재시작 신호를 `Retry-After`와 코드로 보내요」라 적었다. 위 D5가 보인 대로 **api는 그 신호를 보낼 수 없고**, 이 증보는 모양과 낱말만 정하고 보내는 일을 엣지 후속으로 넘겼다. api가 낼 수 있는 `Retry-After`는 D3의 한 경우뿐이다. 이 차이는 planner의 결정이 필요하다(엣지 후속을 열지, 보류로 둘지).
- 감사 §4의 판정(`NetworkError`·502·504·코드 없는 503)은 502에 코드 조건이 없다. 이 증보 전에는 api가 코드 붙은 502를 낸 적이 없어 맞았고, 이 증보 뒤에는 D2와 어긋나므로 한 줄 후속이 된다(아래 「후속」).

### 남는 위험

1. **엣지가 502·504 본문을 바꿔치기할 수 있다.** 일부 CDN·프록시는 원본의 502·504를 자기 오류 페이지로 바꾼다. 그러면 클라이언트는 코드를 못 보고 이 증보 전과 같은 동작(상태만)으로 떨어진다. 안전한 방향이다. Railway 엣지·Caddy를 지난 도착은 돌려 보지 않았다.
2. **코어가 코드 있는 502를 아직 세는 것.** 보관소가 서로 다른 세 요청에서 연달아 502를 내면 「서버에 닿지 못함」이 선언되어 보내기·올리기가 잠긴다(감사 §4의 게이트). 후속 한 줄이 닫는다.
3. **`Retry-After`가 기다려도 안 풀리는 502에 붙는다.** 행과 보관소의 길이 불일치는 `UpstreamFailure`와 같은 코드·같은 5초를 받는다. 값은 권고이고 클라이언트의 자동 재시도가 한도를 가져야 한다(감사 선택 5: 한 글 3회·5분).
4. **코드 없는 기존 5xx가 길게 남는다**(D2). 이 증보는 새 502·503의 규칙을 세울 뿐 옛것을 고치지 않는다.

### runtime-unverified

- Railway에서 교체 중 클라이언트가 실제로 받는 응답(Caddy·플랫폼 엣지)과, `handle_errors`가 위 모양을 낼 수 있는지. 둘 다 재지 못했다.
- `drive_upstream_failed`의 코드와 `Retry-After`가 Railway 엣지를 지나 그대로 도착하는지. 시험은 api의 응답(단위·실제 HTTP)까지다.
- Google을 실제로 장애 상태로 만들어 이 코드를 내 본 일. 시험은 가짜 보관소가 `UpstreamFailure`를 내는 것까지다.

### red proof

| 결정 | 시험 | 이 분기를 바꾸면 빨개질 곳 (실제로 깬 줄과 결과는 PR 본문이 정본) |
|---|---|---|
| D1 코드 | `routes::attachments::tests::an_archive_fault_names_itself_and_only_a_passing_one_says_when_to_come_back` | `drive_error`의 세 코드 중 하나를 지우거나 `AccessDenied`와 `UpstreamFailure`의 코드를 바꾸면 |
| D1 400·404·413 | 같은 시험(코드 없음, 404 본문 바이트) | 404에 코드를 달면 |
| D3 헤더 | 같은 시험(`into_response`로 헤더를 읽는다) + `error::tests::a_retry_after_rides_with_a_code_and_only_when_asked` | `drive_upstream_failed`의 `with_retry_after`를 지우면, `into_response`의 헤더 넣기를 지우면, 「미구성」에 붙이면 |
| 실제 HTTP | `attachment_conformance_pg::an_unconfigured_archive_answers_503_from_a_mounted_route`(코드, `Retry-After` 없음), `attachment_range_conformance_pg::an_archive_that_disagrees_with_the_row_is_refused_before_any_byte`(코드, `Retry-After` 5) | 같은 분기를 지우면(라우터와 미들웨어를 지난 뒤의 값을 잰다) |
| 스펙의 이름 | `routes::attachments::tests::the_openapi_names_the_archive_codes_where_the_server_sends_them` | 오류 코드 등록부에서 세 코드 중 하나를 지우면, 세 연산 중 하나의 `Retry-After` 헤더 줄을 지우면 |

### 후속 (범위 밖, 인계)

- **엣지 후속 이슈**(D5 ②): `infra/railway/Caddyfile.railway`·`infra/rust/Caddyfile`의 `handle_errors`와 `caddy validate`, 그 뒤 OpenAPI `error.code` 목록에 `server_restarting`을 더한다. 엔진 트랙이다(`infra/**`).
- **코어 한 줄 둘**(UXUI 표면, 이 증보는 고치지 않는다): `packages/momo-core/src/features/connection/restSignal.ts`의 `isUnreachableOutcome`이 502에도 `outcome.code === undefined`를 요구한다. `packages/momo-core/src/features/attachments/model.ts`의 `issueForStatus`와 `connection/uploadFailure.ts`가 코드를 보고 가른다: `drive_not_configured`·`drive_access_denied`는 지금의 `no-archive`(관리자에게 알리세요), `drive_upstream_failed`는 `unavailable`(잠시 뒤 다시 올리기), 코드 없는 502·503은 연결 원인 분류(지금처럼).

## 증보 8 (2026-11-06, #5371): 워커의 첨부 쓰기 - api의 사설 주소로, 단일 사용 쓰기 주소 하나

도우미가 팀 Hermes에 맡긴 그림([ADR-0201 증보 v4](0201-team-ai-fast-path-for-simple-workspace-requests.md) P6)과 평소 Hermes 턴의 그림은 최종 답에 `data:image/…;base64` 주소로 온다. 워커는 그 주소를 잘라 내고 문장 하나로 바꾼다(`PICTURE_REMOVED_SENTENCE`, `bins/momo-agent-worker/src/lib.rs:295`). 그림을 첨부로 바꿔 대화에 올리려면 워커가 api의 보관소에 써야 한다. 그런데 Railway에서 `local` 보관소는 api 볼륨뿐이고 Google 백엔드의 SA 키는 워커에 없다(증보 3과 같은 사정). 이 증보는 증보 3의 **거울**이다. 읽기 길이 api가 바이트를 내주는 일이었다면 쓰기 길은 api가 워커의 바이트를 **처음으로 받아** 해독하고 보관하는 일이다. 새 길을 만들지 않았던 읽기와 달리 새 표 하나, 새 공개 경로 하나, 보관소 메서드 하나, 에이전트 답 척추의 새 입구 하나가 생긴다. 그래서 등급 2다.

- Status: **Accepted** (2026-11-06, planner — 독립 보안 검수 등급 2 PASS, Blocker 0·High 0·Medium 3·Low 7·Info 4, 대상 커밋 `f7a229935`. Medium 셋(M1~M3)과 Low·Info는 이 판이 고쳤다: 아래 「검수 수리 기록」. 구현 검수 1회(2026-11-07, 대상 `732bae063`)도 PASS — Blocker 0·High 0·Medium 1·Low 2·Info 6, 수리는 「구현 검수 수리 기록」. 2회차(대상 `3df03f9d3`)도 PASS — Blocker 0·High 0·Medium 0·Low 1·Info 4, L-3 수리는 같은 절). ADR-0100: 공개 경로(`PUT /v1/agent-media/{ws}/{token}`)·보안 경계(워커가 처음으로 api 보관소에 바이트를 씀, 에이전트가 업로더인 첨부 행)·DB 계약(표 하나)이 바뀌므로 이 증보가 구현 머지 조건이다. 이 증보가 Accepted가 되었으므로 구현(같은 PR의 뒤 커밋)이 시작됐고, 구현은 수용 기준 `WA1`~`WA25`를 이름으로 댄다. 이 증보는 ADR-0201 v4 검수와 별개로 자체 독립 보안 검수 1회를 받았다(판정 원문은 재현 세부가 있어 이 저장소에 두지 않는다).
- 번호: 브리프와 ADR-0201 v4 P6·P14-S3, 이슈 #5371 본문이 말하는 「ADR-0151 증보」(브리프는 「증보 4」)는 **이 증보 8**이다. 증보 4는 #4970(읽기 확장)이 먼저 썼고 번호는 착륙 순서다(증보 5 머리말과 같은 사정).
- 기안: Sonnet 5.5 worker (#5371). 검수 수리 판(2026-11-06 밤)도 같은 worker가 고쳤다. 아래 사실·결정은 1단계(2026-11-06)에 쓴 것이고 그때는 문서뿐이었다. 코드·migration·정책 파일을 바꾸지 않았고 Hermes·모델·API·보관소·DB를 실행하거나 부르지 않았다(`runtime-unverified` 전부). 코드 사실은 `track/engine` `078283146`을 읽기만 했다.
- 표기는 앞 증보와 같다: [V] 코드·문서를 직접 읽어 확인 · **[추정]** 이 증보가 정한 숫자·해석 · [확인 필요] 구현 전 확인 · `runtime-unverified` 실행 안 함.
- **구현이 인용할 절 id**: 사실 `K1`~`K15`, 결정 `W1`~`W12`, 위협 `T1`~`T14`, 수용 기준 `WA1`~`WA25`, 슬라이스 `WS1`~`WS7`, 검수가 볼 곳 `R1`~`R7`, 검수 수리 「검수 수리 기록」 표. 이름·숫자 중 「제안」·**[추정]**이 붙은 것은 구현이 정하되 어기려면 이 증보를 고친다.
- **한 줄 요지**: 워커가 DB에 단일 사용 쓰기 토큰(해시만, 60초, run당 슬롯 1)을 만들고 **자기가** api의 사설 주소로 그림 한 장을 한 번 `PUT`한다. api는 토큰을 풀 때와 행을 쓸 때 두 번, **run에서 도출한** 요청자·채널·에이전트로 다시 판정하고, 본문은 토큰이 증명된 뒤에야 읽으며, 바이트는 기존 격리 디코더(`--prepare`, 자식 불변)로 다시 인코딩한 출력만 보관소에 쓴다. 첨부 행의 업로더는 그 run의 에이전트 멤버이고, 한 run의 그림은 그 run의 최종 답 **한 메시지**에 묶인다. 이 길을 부르는 호출자는 S3에 없다(S4·#5334가 붙는다).

### 변경 전 — 확인한 사실 [V]

| # | 사실 | 출처 |
|---|---|---|
| K1 | Railway에서 워커는 api의 `local` 볼륨도 Google SA 키도 갖지 못한다(볼륨은 서비스 하나에만, 키를 복제하면 공유 드라이브 전체의 권한이 생긴다). 그래서 읽기는 api의 사설 주소로 간다 | 증보 3 서두·D5·「비교한 방식」(b)(d) |
| K2 | Hermes 그림은 비스트리밍 최종 답의 `data:image/…` 주소(≤5 MiB)로 온다. 워커는 평소 턴에서 그 주소를 자르고 고정 문장을 쓴다. 코드 주석이 「첨부로 바꾸는 것은 후속 — 워커가 api 저장소에 쓰는 길이 따로 필요」라고 적고 있다 | `momo-agent-worker/src/lib.rs:287-295`, `hosted_door.rs:9`, ADR-0218 G4 |
| K3 | 읽기 토큰 표 `self_media_token`의 `attachment_id`는 `NOT NULL REFERENCES attachment`이고, 가드 트리거는 `used_at` 한 번 외의 모든 UPDATE를 거절한다. 잠금 블록 `self-media-token-lockdown`이 migration과 두 bootstrap 파일에 같은 글자로 있고 정적 시험이 비교한다. 쓰기에는 첨부가 아직 없다 | `server/Migrations/160_self_media_token.sql:48,65-76,85-`, `infra/rust/sql/bootstrap_roles.sql:441`, `bootstrap_runtime_roles.sql:448` |
| K4 | `pending` 첨부 행은 `drive_file_id`가 필요하고(`status='failed'`만 예외), 그 id는 보관소의 세션 생성이 정한다. 워커는 Railway에서 세션을 만들 수 없다 | `server/Migrations/017_attachment.sql:25-27`, `routes/attachments.rs:180-211` |
| K5 | `DriveArchive`에는 서버가 바이트를 직접 쓰는 메서드가 없다. `create_resumable_upload`는 주소를 돌려주고(바이트는 클라이언트가 보관소로 직접 올린다), 서버 안에서 바이트를 받는 것은 stub·local의 `accept_stub_upload`뿐이다. `momo-server`는 reqwest를 갖지 않고 Google 클라이언트는 `momo-drive`에 있다 | `momo-drive/src/lib.rs:449-552`(458·543), `local.rs:546·698`, `google.rs:456`, `routes/attachments.rs:27-28` |
| K6 | **에이전트 답 척추는 첨부를 묶지도 싣지도 않는다.** `send_message_in_tx`와 `send_thread_notice_in_tx`는 `AttachmentPolicy::Skip`이다. 묶고 투영하는 곳은 REST 보내기 한 곳(`send_message_with_mentions_via_in_tx`)이고, 주석이 「agent replies」를 Skip 쪽에 명시한다. 도우미의 최종 답은 `send_thread_notice_in_tx`로 쓴다(`client_msg_id = run_id`) | `momo-messaging/src/message.rs:590-601·939-955·981-997·1155-1180`, `momo-agent-worker/src/team_ai.rs:1499` |
| K7 | `link_attachments_in_tx`는 행을 `FOR UPDATE`로 잠그고 `complete`·**업로더 = 작성자**·같은 채널·미묶임을 판정한다(어긋나면 닫힌 거절 일곱). 한 메시지 ≤20개다. 그래서 에이전트 답에 묶을 첨부의 업로더는 **에이전트 멤버**여야 한다 | `momo-messaging/src/attachment.rs:71·549-558·561-629(596-604)` |
| K8 | 기본 결정 D3: 「에이전트 업로드는 v0 제외(사람만)」. 사람 업로드 라우트의 멤버십 판정 `is_attachment_channel_member`는 멤버 **종류**를 보지 않는다(에이전트 멤버도 통과하는 술어다). 그래서 D3의 「제외」가 지켜지는 곳은 판정이 아니라 라우트 앞이다 [V, 독립 보안 검수 확인]: 에이전트 bearer는 DB를 보기 **전에** 닫힌 허용 목록을 지나야 하고 그 목록에 `attachments` 경로가 없다(문자열 0). App JWT 주체는 늘 사람이고 work-host 서명은 work-hosts 경로에서만 인증된다. 테스트 밖의 `INSERT INTO attachment`는 `create_pending_upload_in_tx` 한 곳이고 호출자는 `create_upload` 하나다 | 이 문서 25행, `attachment.rs:252-279·300`, `momo-server/src/auth.rs:996`(허용 목록 호출, 머리 주석 53), `momo-auth/src/agent_scope.rs:88-`, `momo-auth/src/jwt.rs:94`, `momo-server/src/work_host_auth.rs:189-` |
| K9 | **격리 디코더의 한도.** 입력 ≤`INPUT_BYTES` 5 MiB(`momo-expressions/src/model.rs:38`). `open()`: 가장자리 ≤4096, 화소 ≤16,000,000, `total_bytes + 16 + 5 + 8 MiB ≤ 192 MiB`(`ALLOCATION_LIMIT`), 마감 10초, 자식은 `env_clear`. **GIF 매직은 통과하고 한 프레임이면 정지 그림으로 열린다**(`prepare`는 움직이는 것만 거절). 출력 모양은 셋: 기본(small 128·large 512·thumb — 표현 렌디션), `--prepare`(긴 변 ≤1024, ≤4 MiB, 픽셀에서 다시 인코딩해 EXIF·GPS·ICC·주석·꼬리 바이트 제거, EXIF 방향 반영, 알파가 있으면 PNG 아니면 JPEG q90), `--cutout` | `momo-expressions/src/media.rs:19·21·257·621-631·817-873(845-847·857·862-868)·892-983(944-946)` |
| K10 | 대기 방식 `process_waiting`은 **기본 모양(표현 렌디션)만** 낸다. `--prepare`의 `prepare_photo`는 `try_acquire`로 즉시 `Busy`를 낸다. 줄서기는 ≤3초(`WAIT_MAX`)·대기자 2(`WAITERS_MAX`, 프로세스 공용)이고 사람의 직접 올리기는 줄서지 않는다. 「돈이 든 그림」용 끈질긴 변형(`permit_patiently`, 250ms마다 다시 물음)은 기본 모양·`--cutout`에만 있다 | `media.rs:70-73·82-110·178-195·326-334·357-420` |
| K11 | 읽기 라우트 `GET /v1/self-media/{ws}/{token}`: GET 전용(그 밖은 405), 거절은 한 모양 404, 거절만 호출 주소·경로 워크스페이스별 예산(기본 30)과 주소 전체 상한을 쓴다. 계약 파일 둘에는 없고 공개·스펙 밖 목록에 오른다. 로그 가림 `redact_self_media_urls`는 글자 `self-media` 뒤에 `/워크스페이스/토큰`이 오는 모양만 안다 | `routes/self_media.rs`, `momo-server/src/lib.rs:2457-2468`, `rate_limit.rs:649·684·715`, `tests/dev_token_door_conformance_pg.rs:160·2464`, `self_media.rs:659-694` |
| K12 | 워커의 읽기 클라이언트는 리디렉션 없음·프록시 없음·시간 한도이고 `OORT_API_INTERNAL_ORIGIN`은 출처 문법(`internal_origin`)을 지나야 한다. 오류는 고정 낱말(`timeout`·`connect`·`body`·`request`)만 남기고 reqwest 문장은 쓰지 않는다 | `momo-agent-worker/src/self_media.rs:35·114·216-221·369`, 증보 3 D5·D6·후속 F3 |
| K13 | 디코더 바이너리는 서버·워커와 같은 한 이미지의 `/usr/local/bin/`에 함께 있고(서비스는 시작 명령만 다르다), 호스팅 문은 워커 **프로세스 안**에서 `process_waiting`을 이미 쓴다. 슬롯 둘은 **프로세스마다** 있다: api의 둘은 사람의 직접 올리기·링크 가져오기·에이전트 포트 후보가 나눠 쓰고, 워커의 둘은 호스팅 문이 쓴다 | `server-rust/Dockerfile:239·350`, `momo-workspace-actions/src/hosted_expression.rs:695`, `media.rs:66-73` |
| K14 | `momo_worker`는 BYPASSRLS이고 일반 표에는 SELECT·INSERT·UPDATE·DELETE 기본 권한이 있다(잠긴 표만 예외). `momo_app`은 RLS를 따르는 비우회 역할이다. 이미 워커는 모든 테넌트의 메시지·기억을 읽는 역할이다 | `infra/rust/sql/bootstrap_runtime_roles.sql:53-59`, 증보 3 남는 위험 1 |
| K15 | 묶이지 않은 완료 첨부는 업로더만 읽고(증보 1) 30일 뒤 청소기가 거둔다(증보 2 D4, **기본 꺼짐**). `pending`·`failed` 행은 거두지 않는다 | 증보 1·증보 2 D1·D4 |

### 결정

- **W1 · 방식: 증보 3 (a)식의 거울.** 워커가 DB에 쓰기 토큰을 만들고(`mint`, `momo_worker`의 테넌트 tx) 그 tx를 **커밋한 뒤**(네트워크를 트랜잭션을 연 채 기다리지 않는다) `{OORT_API_INTERNAL_ORIGIN}`의 쓰기 주소를 **자기가** 한 번 부른다. api는 토큰을 풀 때와 행을 쓸 때 소유를 다시 판정한다. 새 표 하나 `attachment_write_token`(이름은 제안)과 **migration 하나**가 든다(증보 3은 없었다). **번호는 175다**(planner 배정, 2026-11-06. 다른 칸이 먼저 착륙하면 planner가 착륙 때 맞춘다). `discovers_contiguous_migrations_001_to_174`를 175로 바꾼다.
  - 열: `workspace_id`·`token_hash`(정확히 32바이트)·`run_id`(`agent_run` FK, ON DELETE CASCADE)·`agent_member_id`·`slot`(smallint, CHECK 1~4)·`created_at`·`expires_at`(CHECK 0 < 수명 ≤ 10분)·`used_at`·`attachment_id`(NULL 허용, **행을 쓴 tx가 한 번만** 기록한다 — W9 L2. CHECK: `used_at`이 선 뒤에만. 참조 열이 아니라서 FK를 두지 않는다: 증보 2 D4의 「첨부 id를 가리키는 곳 전수」와 점검 SQL 4절을 늘리지 않는다). 키 `(workspace_id, token_hash)`, **`UNIQUE (workspace_id, run_id, slot)`**: 한 run이 쓸 수 있는 그림 수를 DB가 쥔다. 쓰이지 않고 만료된 슬롯도 되살리지 않는다(한 번만 시도한다, W3). 행은 만료 하루 뒤에 청소되므로(아래) 이 보장은 「그 run이 사는 동안」이다 — run은 그보다 훨씬 짧게 끝난다(작업 모드 60분 한도, ADR-0201 R3). v1의 코드 상수 `AGENT_PICTURES_PER_RUN`(제안)은 **1**이고 표의 CHECK는 4까지 열어 둬서 넓힐 때 migration이 필요 없다(코드 상수와 이 증보의 개정만).
  - **요청자·채널 열을 두지 않는다**(160과 다른 점). 풀 때 run에서 도출한다(W3). 열이 없으면 위조할 것도 없다.
  - 가드 트리거(`used_at` NULL→값 한 번, 그리고 `used_at`이 선 뒤 `attachment_id` NULL→값 한 번 외의 UPDATE·되돌리기 거절), RLS ENABLE+FORCE `ws_isolation`, 잠금 블록 `attachment-write-token-lockdown`(제안 이름; `momo_worker` SELECT·INSERT·DELETE, `momo_app` SELECT·UPDATE, relay·notifier·platform_admin 없음)을 160과 같은 모양으로 migration과 두 bootstrap 파일에 **같은 글자**로 두고 정적 시험이 비교한다. 만들 때마다 같은 워크스페이스의 하루 지난 행을 지운다(160과 같음).
- **W2 · 주소 모양: 새 접두 `PUT {origin}/v1/agent-media/{ws}/{token}`.** 읽기 접두와 섞지 않는 까닭: ① 읽기 라우트의 「GET 전용·405·거절 한 모양」을 시험이 못 박고 있다 ② Hermes 가드 플러그인이 `/v1/self-media/` 접두를 고정한다 ③ 공개·스펙 밖 목록에 따로 오른다(K11) ④ 접두가 갈리면 엣지가 쓰기 접두만 막을 수 있다 — **S3이 두 Caddyfile에서 `/v1/agent-media/*`를 403으로 막는다**(WS4, 검수 M3). 정당한 호출자는 사설망의 워커 하나뿐이고 워커는 엣지를 지나지 않는다. 대가: 로그 가림(`redact_self_media_urls`)과 거절 예산의 경로 함수(`self_media_scope`)를 새 접두까지 넓힌다(WS4). 토큰 형식(43자 URL-safe)·SHA-256 해시·`token_is_well_formed`는 재사용한다. PUT이 아닌 메서드는 경로·DB를 보기 전에 405(`Allow: PUT`)다. **토큰은 어떤 글에도 실리지 않는다**: 모델 문맥·Hermes 요청·메시지·props·감사·오류·로그·job payload 어디에도 없고 워커가 한 요청에 쓰고 버린다(증보 3 D3).
- **W3 · 소유 재판정은 세 번이고 같은 함수 하나가 한다**(증보 3 D2와 같은 모양, 검수 M1). 그 함수(`agent_picture_binding_in_tx`, 제안 이름)는 **한 곳**에 있고 발급·풀기·행 쓰기가 모두 그것을 부른다: run이 `queued`·`running`이고 `agent_member_id`가 그 에이전트이며, **그 에이전트 자리가 실제 에이전트**(`member.kind = 'agent'` — `agent_run.agent_member_id`는 `member`를 가리킬 뿐이라 run 행이 사람을 거기 앉힐 수 있고, 그러면 첨부의 업로더가 그 사람이 되어 에이전트 업로더만 세는 상한 셈에서 빠진다, 구현 검수 M-1 (a))이고, 트리거 작성자가 살아 있는 사람이고, 에이전트와 요청자가 모두 그 대화의 활성 멤버이며 **채널이 보관되지 않았을 것**(첨부 쪽의 `is_attachment_channel_member`가 `archived_at IS NULL`·멤버 활성·`left_at IS NULL`을 한 문장으로 이미 쥔다. 둘에게 한 번씩 부른다). 읽기 길의 `requester_in_conversation_in_tx`(`self_media.rs:361-379`)는 이 함수의 재료가 아니다: 그 함수는 run 상태도 `archived_at`도 보지 않고(`requester_of_run_in_tx`와 `is_channel_member` 두 번뿐, `agent_avatar.rs:801-819`·`identity.rs:130-145`) 읽기 길의 보관 채널 거절은 첨부 판정 SQL(`agent_avatar.rs:928-938`)에서 왔다. 쓰기에는 첨부가 아직 없으므로 이 함수가 그 조건을 **직접** 건다. 아래 1~3은 같은 함수에 각자의 몫을 더한다.
  1. **발급**(워커, 행을 쓰기 **전에**): 위 함수가 통과하고 그 run의 이 슬롯이 아직 없으며 슬롯 번호가 `AGENT_PICTURES_PER_RUN`(v1 = 1) 이하일 때만. 거절은 `None`이고 표에 아무것도 쓰지 않는다.
  2. **풀기**(api, 경로의 워크스페이스로 묶은 `momo_app` tx, 한 문장): `UPDATE … SET used_at … WHERE 워크스페이스 AND 해시 AND used_at IS NULL AND expires_at > now AND slot <= AGENT_PICTURES_PER_RUN AND EXISTS(그 run이 진행 중이고 에이전트가 같다) RETURNING run_id, agent_member_id, slot`(M2: 위조한 행의 슬롯 번호가 v1 상한을 넘지 못한다). 이어 **같은 tx에서** 위 함수로 요청자와 채널을 run에서 도출하고(트리거 메시지의 작성자, run의 채널) 멤버십·보관 여부를 다시 본다. 업로더·채널·요청자를 요청의 어떤 값(헤더·쿼리·본문)도 정하지 못한다.
  3. **행을 쓸 때**(api, 해독·보관 뒤의 tx): 위 함수를 한 번 더 부르고 일일 상한(W12)을 센다. 그동안 run이 끝났거나(취소·완료·실패) 누가 대화를 나갔을 수 있다. 어긋나면 보관한 객체를 지우고 거절한다(W6의 `run_over`).
  - **토큰에 기대는 거절은 같은 404 한 문장이다**(형식 틀림·없는 토큰·다른 워크스페이스·만료·재사용·끝난 run·멤버 아님·보관된 채널·슬롯 번호 상한 밖). 이 404만 거절 예산을 쓴다(읽기 라우트처럼 404만 센다). **메서드(405)·`Content-Length`(411·413)·쓰기 자리(503) 거절은 DB 전이고 토큰과 무관하며** 토큰을 태우지도 예산을 쓰지도 않는다(W4, 검수 L4). 풀기 뒤에는 호출자가 토큰을 증명했으므로 닫힌 상태 코드를 쓴다(W6, 증보 6 A와 같은 이유).
  - **한 번만 시도한다.** 소비가 본문 읽기보다 먼저라 본문이 나빠도 토큰은 탄다. 워커는 재시도하지 않는다(실패는 호출자의 실패 문장으로 끝난다, W6·W11).
- **W4 · 요청 처리 순서가 곧 논거다**(ADR-0218 H11 (b)와 같은 방식). 어느 단계의 실패도 다음 단계를 열지 않는다.
  1. 메서드(PUT 아니면 405) → 2. 경로 모양(canonical 소문자 UUID + 43자 토큰, DB 없이) → 3. **`Content-Length` 필수, ≤5 MiB**(없으면 411, 넘으면 413 — 본문을 읽기 **전**이고 DB 전이며 토큰도 안 타고 거절 예산도 안 쓴다). `Content-Type`·그 밖 헤더·쿼리는 어떤 값이어도 무시한다(종류는 바이트가 정한다) → 4. 쓰기 자리: api 프로세스당 동시 `WRITE_IN_FLIGHT` **[추정] 4**, 넘으면 토큰을 쓰기 **전에** 503 + `Retry-After` → 5. **풀기**(소비) → 6. **본문 읽기**: 선언한 길이와 정확히 같은 바이트만, 총 읽기 마감 **[추정] 10초**, 모자라거나 더 오면 끊고 400 → 7. **sniff**: png·jpeg·webp 매직일 때만(`bytes_match_mime`의 세 그림 갈래, `self_media.rs:260`) — GIF·APNG·SVG·HTML·PDF·HEIC·빈 본문은 여기서 422이고 **디코더 자식은 뜨지 않는다**. K9가 말한 대로 한 프레임 GIF는 `open()`이 받아 주므로 이 sniff가 GIF를 막는 유일한 곳이다 → 8. 격리 디코더(W5) → 9. 보관소 쓰기(W7) → 10. tx: 재판정(W3 3) + 행 INSERT + 감사(W8) → 11. 201.
  - 본문 상한은 한 숫자다: `AGENT_PICTURE_MAX_INPUT_BYTES` = `INPUT_BYTES` = `SELF_MEDIA_MAX_BYTES` = 5 MiB(증보 4 D5와 같은 이유로 시험이 같음을 못 박는다). 원시 본문은 핸들러가 직접 읽는다(`stub_upload`와 같은 방식, `momo-server/src/lib.rs:2470-2487` 주석: 추출기 한도가 아니라 읽는 쪽이 상한을 쥔다).
- **W5 · 격리 디코더 재사용 — 자식 코드는 한 줄도 바꾸지 않는다.** 출력 모양은 `--prepare`다(K9: 긴 변 ≤1024·≤4 MiB·메타데이터 제거·알파면 PNG 아니면 JPEG q90). ADR-0201 P6의 「다시 인코딩(메타데이터 제거·크기 상한)」과 같은 일이고, P6이 이름을 든 `process_waiting`의 **출력**(표현 렌디션 ≤512 px)은 대화 그림에 작아서 쓰지 않는다(P6의 「대기 방식」은 줄서기를 뜻하는 것으로 읽는다). 필요한 코드는 호출 쪽 얇은 함수 하나뿐이다: `prepare_photo_waiting(bytes, wait)`(제안 이름) = `permit_waiting(decoder_slots(), &Line::process_wide(), wait)` + `job(bytes, "--prepare", permit)`(`media.rs:178-195·310-321`).
  - **대기**는 P6 그대로 ≤3초·대기자 2다(`WAIT_MAX`·`WAITERS_MAX`). 못 얻으면 `Busy` → 503 `busy`. 슬롯은 api 프로세스의 둘이라 사람의 직접 올리기·링크 가져오기와 나눈다(P6의 문장). 해제된 슬롯은 줄 선 쪽이 먼저 받고(`media.rs:84`) 사람의 올리기는 줄서지 않고 즉시 `Busy`를 받으므로, 에이전트 쓰기 넷(해독 2 + 대기 2)이 이어지면 사람의 올리기는 **에이전트 해독이 슬롯을 쥔 동안**(장당 ≤10초, 몰리면 약 20초) `Busy`일 수 있다(검수 L5). 빈도는 run당 1장·일일 상한(W12)·`WRITE_IN_FLIGHT`가 쥔다.
  - **상한**: 입력 5 MiB, 가장자리 ≤4096, 화소 ≤16,000,000, 해독 마감 10초, 출력 ≤4 MiB·긴 변 ≤1024. P6이 「S3이 디코더의 할당 한도에서 도출한다」던 **화소 상한은 1,600만**이다(증보 4 D8과 같은 숫자). 도출 [V 계산]: 할당 식에서 해독 버퍼는 `192 − 16 − 5 − 8 = 163 MiB` 이하여야 하는데, 가장 넓은 깊이(RGBA16, 화소당 8바이트)도 1,600만 × 8 = 약 122 MiB라서 화소 규칙이 먼저 걸리는 구속 항이다. 헤더만 큰 폭탄은 `dimensions`·`preflight`(`media.rs:621-631`: 가장자리 4096·1,600만 화소를 헤더의 선언값으로 먼저 본다)가 어떤 코덱 생성자보다 **앞서** 거절한다(P15-A10의 「작은 파일에 큰 선언 크기」).
  - **보관소와 DB에 가는 바이트는 항상 자식이 인코딩한 출력이다.** 입력 바이트는 보관소·DB·로그 어디에도 가지 않는다. 출력 mime은 `image/png`·`image/jpeg`뿐이다.
- **W6 · 응답과 실패 문장.** **DB 전(토큰과 무관)**: 405 `Allow: PUT`, 411 `length_required`, 413 `too_large`, 503 `busy`(쓰기 자리 가득, `Retry-After`) — 토큰이 안 타고 예산도 안 쓴다. **토큰에 기대는 거절**: 404 한 모양(+ 거절 예산, W12). **풀기 뒤**(호출자가 증명함): **201** `{"attachmentId","mime","sizeBytes"}`(그 밖의 필드 없음), 400 `length_mismatch`, 422 `unsupported_format`·`invalid_picture`(sniff 밖·해독 불가·화소 상한·APNG·GIF), 503 `busy`(줄서기 실패) 또는 `drive_not_configured`(보관소 없음), 504 `timeout`(해독 마감), 502 `storage_failed`, 409 `run_over`(행을 쓸 때의 재판정 실패), 429 `cap_reached`(api가 세는 일일 상한, W12). 본문은 닫힌 낱말 코드 하나뿐이고 사람이 읽는 문장은 없다.
  - **사람에게 보이는 문장은 하나다** — 위임 호출자는 ADR-0201 P9의 `picture_failed` 「그림은 만들어졌지만 올리지 못했어요.」를 그대로 쓴다(원인은 감사의 닫힌 낱말로만 남는다). 위임이 아닌 호출자(평소 Hermes 턴, #5334의 대화)는 현행 `PICTURE_REMOVED_SENTENCE`(「그림은 이 메시지에 실을 수 없어서 뺐어요.」)를 그대로 쓴다: 쓰기 길이 닫혀 있거나 실패해도 오늘보다 나빠지지 않는다. 새 사전 키는 없다.
  - reqwest의 오류 문장·URL·상태 본문은 어디에도 쓰지 않는다. 실패 로그는 고정 낱말(`timeout`·`connect`·`body`·`request`·상태 숫자)뿐이다(증보 3 D6·후속 F3).
- **W7 · 보관소 쓰기: `DriveArchive`의 새 메서드 하나(와 감사용 고정 낱말 `backend_kind`).** `put_object(channel_id, name, mime, bytes) -> Result<DriveFile, DriveError>`(제안 이름). 이름·mime·바이트는 서버가 정한 값 그대로다. 백엔드별: **stub·local** = 기본 구현이 `create_resumable_upload`와 `accept_stub_upload`를 서버 안에서 이어 부른다(바이트는 메모리 조각 스트림; `stream_into`가 길이·상한을 이미 쥔다, `local.rs:459`). 읽기 전용으로 연 보관소는 `AccessDenied`. **google** = 세션을 만든 뒤 서버(`momo-drive`)가 세션 주소에 한 번 PUT하고 `file_metadata`로 길이·mime을 대조한다. **세션 주소는 기대한 Google 업로드 호스트·경로로 고정한다**(스킴 https, 세션을 만든 API와 같은 호스트, `/upload/` 경로가 아니면 `UpstreamFailure`). 리디렉션을 따르지 않고 오류는 고정 낱말만 남긴다(증보 3 D6·후속 F3과 같게, 검수 L6) — `runtime-unverified`(가짜 구글로만 시험). **`UnavailableDriveArchive`** = `Unavailable`(→ 503 `drive_not_configured`). 이는 ADR-0201 P18 ⑧의 「첨부 쓰기의 저장소 백엔드(local/Drive)별 길」을 닫는다.
  - **`pending` 행을 만들지 않는다.** 객체가 쓰이고 검증된 **뒤에** 행이 `complete`로 한 번에 태어난다(K4가 말하는 id는 `put_object`가 돌려준다). 그래서 증보 2 D4가 거두지 않는 `pending`·`failed` 행이 남지 않는다.
  - 객체를 쓴 뒤 행 tx가 실패하거나 W3 3이 거절하면 `delete_file`(멱등, `lib.rs:518`)로 객체를 지운다. 지우기도 실패하면 행이 없는 고아 객체가 남고 행을 따라가는 청소기는 그것을 찾지 못한다(남는 위험 4).
  - **시간** [추정]: 읽기 10 + 줄서기 3 + 해독 10 + 보관 10 = 최악 약 33초 → 라우트 총 마감 35초, 워커 클라이언트 마감 40초.
- **W8 · 첨부 행과 감사.** 행: `uploader_member_id` = run의 **에이전트 멤버**(도출. 그 자리가 `member.kind = 'agent'`임은 W3의 공용 판정이 증명한다), `channel_id` = run의 채널(도출), `message_id` NULL, `name` = 서버 고정 `picture-{슬롯}.png`·`.jpg`(출력 mime에 맞춤. 모델·Hermes·요청의 어떤 글도 이름이 되지 않는다), `mime` = 출력 mime, `size_bytes` = 출력 길이, `status` = `complete`, `drive_file_id` = 보관소 id. 감사의 `backend`는 보관소가 스스로 말하는 고정 낱말(`DriveArchive::backend_kind()`)이다.
  - 감사 `attachment.agent_picture_written`(schema `momo.attachment.agent_picture_written.v1`): 행위자 = 에이전트 멤버, 대상 = 첨부 id, detail = `channel_id`·`run_id`·`slot`·`mime_in`(sniff 결과)·`mime`·`bytes_in`·`bytes`·`decode_ms`·`backend`(`local`·`google`·`stub`). 풀기 **뒤**의 실패는 `attachment.agent_picture_refused`(대상 = run, detail = `run_id`·`slot`·`reason`(W6의 닫힌 낱말)·`bytes_in`) 한 줄이다(풀기 앞의 404는 호출자가 증명하지 않았으니 기록하지 않는다 — 예산만 쓴다).
  - **이름·바이트·토큰·주소·요청 문장·Hermes 모델 이름은 감사·로그·메시지·props·job payload 어디에도 없다**(증보 2 D3의 「감사에 파일 이름 없음」과 같은 줄). 위임 쪽 감사 `team_ai.delegate`(P11)는 S4가 쓰고 이 증보는 거기에 「그림 바이트 수」 필드를 대 준다.
- **W9 · 한 메시지에 묶기.**
  - **규칙**: 한 run의 그림은 그 run의 **최종 답 메시지 하나**에 슬롯 순서로 묶인다. 그림마다 메시지를 만들지 않고, 사람의 메시지나 다른 run의 메시지에는 묶지 않는다. **묶을 첨부 id는 호출자가 정하지 않는다**(검수 L2): 쓰기 토큰 행이 행을 쓴 tx에서 만든 첨부 id를 한 번 기록하고(W1의 `attachment_id`), 새 입구는 `input.run_id`의 기록된 id만 슬롯 순서로 묶는다. 같은 에이전트·같은 채널의 묶이지 않은 **다른 run**의 그림은 그 run의 기록에 없으므로 이 입구가 묶지 않는다.
  - **구현**(K6의 틈을 메운다): 답 척추에 새 입구 하나(제안 이름 `send_thread_notice_with_attachments_in_tx`)를 둔다 = `insert_message_in_tx` → `!deduped`이면 `link_attachments_in_tx(…, 업로더 = 작성자 = 에이전트, 슬롯 순서의 id 목록)` → `finish_send_in_tx(멘션 Skip, 스레드 Maintain, **AttachmentPolicy::Project**)`. 투영을 **broadcast 앞에** 하므로 `message.new`의 payload와 기록 투영이 `attachments`를 싣는다. 새 입구를 부르는 호출자만 첨부를 갖고 `send_message_in_tx`·`send_thread_notice_in_tx`·run line은 `Skip` 그대로다. 이 입구는 `link_attachments_in_tx`를 BYPASSRLS 역할(`momo_worker`)에서 처음 부르므로 그 함수의 조회(`SELECT … FOR UPDATE`)·갱신(`UPDATE`)에 **`workspace_id` 조건을 더한다**(지금은 RLS에 기댄 주석뿐이다, 검수 L1).
  - **v1은 한 장이다**(`AGENT_PICTURES_PER_RUN` = 1, ADR-0201 R10). 두 장 이상은 호출자(S4)가 광고 단계와 추출에서 거절하고(P15-A10: 첨부 0 + `picture_failed`), 이 길은 슬롯으로 상한을 지킨다. **일반형**(#5334·B6-4가 넓힐 때, N ≤ 4 **[추정]**, 표의 CHECK 상한): N개 토큰 → N개 첨부 → 한 목록으로 한 메시지(≤20, K7).
  - **부분 실패 규칙**(한 번만 쓴다): 쓰기가 실패한 슬롯은 첨부가 없다. 성공한 슬롯은 묶는다. 하나라도 실패하면 답 끝에 `picture_failed` 문장 한 줄(N=1이면 「첨부 0 + 그 문장」). **묶기 거절**(`AttachmentLinkRejected` 어느 것이든)은 메시지를 지우지도 평문으로 새로 보내지도 않는다: 저장점으로 되돌려 **첨부 없이 같은 답 + `picture_failed` 문장**으로 한 번 다시 쓴다(`client_msg_id = run_id` 멱등, 반쪽 묶임 0).
  - 묶이지 않은 첨부(워커가 쓰기와 묶기 사이에 죽음·tx 실패)는 증보 1(업로더만 읽음)과 증보 2 D4(30일, 기본 꺼짐)가 그대로 적용된다. 업로더가 에이전트 멤버라 사람은 읽지 못한다. **호출자(S4)는 PUT을 합치는 호출 뒤, 마지막 tx 직전에 한다**(ADR-0201 P4-7의 순서에서 PUT 위치만 바꾼다. 합치는 호출 동안 사람이 중지해도 행이 아직 없고, 행을 쓰는 순간의 재판정(W3 3)이 거절한다 — 검수 L3). 남는 창은 행을 쓴 뒤 묶기 전의 한 tx 사이뿐이다.
  - 스트리밍 답(여는 쓰기 + 패치)에 첨부를 싣는 길은 정하지 않는다. 이 증보는 도우미가 한 번에 쓰는 최종 답(ADR-0201 P4-8의 모양)만 다룬다 — 열어 둔다.
- **W10 · D3 뒤집기는 이 한 길에 한한다.** 기본 결정 D3의 「에이전트 업로드는 v0 제외」를 W2의 길 하나에 한해 푼다: **업로더가 에이전트 멤버인 첨부 행은 이 길만 만든다.** 사람 업로드 라우트(`create_upload`·`complete`)는 에이전트에게 열리지 않는다(그대로). **읽기 쪽 술어는 넓히지 않는다**: `find_requester_attachment_in_tx`(요청자 본인이 올린 첨부)가 그대로라서 도우미의 `read_attachment`는 에이전트가 쓴 그림을 읽지 못한다(`not_found`). 의도다: 자기 출력을 다시 읽지 않고, ADR-0218 §12 L3.1 B가 걱정한 「도우미 자기 것」으로의 소유 술어 확대가 없다. 채널 멤버가 읽는 길(content)은 「묶인 살아 있는 메시지의 첨부」 규칙 그대로다.
- **W11 · 워커 쪽 규칙.**
  1. **발급 전 선행 거절**: base64 디코드 ≤5 MiB, 매직 png·jpeg·webp, 그림 수 ≤ 슬롯 상한(v1은 정확히 1). 어긴 요청은 토큰을 만들지 않는다. api는 같은 검사를 다시 한다(워커를 믿지 않는다).
  2. 클라이언트는 증보 3의 `attachment_client()`와 같은 설정(리디렉션 없음·프록시 없음)에 **쓰기용 마감 40초**다. `OORT_API_INTERNAL_ORIGIN`이 없거나 모양이 틀리면 **쓰기 길은 닫힌다**. 읽기와 달리 폴백이 없다(워커는 보관소에 쓸 수 없다, K1) → 호출자의 실패 문장.
  3. **한 번만 시도한다.** 재시도도 둘째 토큰도 없다.
  4. 토큰·주소·응답 본문·바이트는 로그·감사·오류·메시지·props·job payload에 쓰지 않는다(W2).
  5. 모델은 「그림 n장 받음」만 안다(P6).
  - **S3은 호출자를 더하지 않는다.** 이 길은 어느 도구·모델·HTTP 표면에서도 불리지 않는 워커 안 함수이고, `image` 광고와 코드 상수(`ATTACHMENT_WRITE_PATH_READY`, P6)는 S4가 바꾼다. S3 착륙 뒤 사용자에게 달라지는 것은 0이다.
- **W12 · 한도와 거절 예산.** 한 run ≤ 슬롯 상한(UNIQUE), api 프로세스당 동시 쓰기 4 **[추정]**. **풀기 전 거절만** 호출 주소·경로 워크스페이스별 예산(읽기 라우트와 같은 방식)을 쓴다. 성공과 풀기 뒤의 거절은 쓰지 않는다. 한도 값은 기존 `RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE`(기본 30, 0이면 끔)를 같이 쓰되 **버킷은 접두별로 따로**다(읽기 쪽 거절이 쓰기 쪽을, 그 반대가 닫지 않는다). 주소 전체 상한(한도의 10배)도 따로 둔다. 새 환경 변수는 없다. 일일 총량은 호출자 쪽 한도(ADR-0201 P7: 위임 일일 기본 30)가 1차로 쥐고, **api도 행 쓰기 tx에서 워크스페이스별 일일 상한을 스스로 센다**(검수 M2): 업로더가 에이전트 멤버인 `complete` 첨부의 최근 24시간 수 ≥ `AGENT_PICTURES_DAILY_CEILING`(제안 이름, **[추정] 200** = P7의 설정 상한과 같은 숫자라 정상 경로에서는 걸리지 않는 방어선)이면 429 `cap_reached`로 거절하고 객체를 지운다. **이 숫자는 `attachment` 행에서 세는데 `momo_worker`는 그 표에 `UPDATE`·`DELETE`가 있으므로, 이 상한이 막는 상대는 토큰·run·멤버십 행을 위조하는 워커까지다**(T2, 구현 검수 M-1 (b)). 풀기는 `slot ≤ AGENT_PICTURES_PER_RUN`(v1 = 1)을 본다(표 CHECK는 4까지 열려 있다).

### 비교한 방식과 기각한 대안

| 방식 | 판단 |
|---|---|
| (a) 워커가 쓰기 토큰을 발급하고 api의 쓰기 라우트를 부른다 (**채택**) | 증보 3의 검수된 모양(1회용·해시만·짧은 수명·재판정)을 그대로 쓴다. 저장소 종류와 무관하다. 대가: 새 표·새 공개 경로·보관소 메서드·답 척추 입구 |
| (b) 내부 전용 경로 + 서비스 간 비밀 | **기각 유지**(증보 3 (c), ADR-0201 P6). 새 비밀(회전·유출 범위)·소유 판정의 두 번째 구현·1회용 아님. 쓰기에서는 더 나쁘다: 비밀 하나로 어느 run에든 쓸 수 있다. 뒤집을 이유가 없다 |
| (c) 읽기 표 `self_media_token`을 재사용(`attachment_id`를 NULL 허용으로, 방향 열 추가) | **기각.** 160의 `NOT NULL`·「모든 열 불변」 가드·읽기 라우트의 `RETURNING attachment_id`가 걸려 있다. 방향 술어를 한 곳만 빠뜨려도 쓰기 토큰이 읽기에(또는 반대로) 통하고 표 하나의 계약이 둘이 된다 |
| (d) 워커가 `pending` 첨부 행을 먼저 만들고 첨부에 묶인 토큰 | **기각.** `drive_file_id`는 보관소 세션이 정하므로 워커가 못 만들고(K4), BYPASSRLS 역할이 사용자 표에 행을 쓰는 새 길이 생긴다 |
| (e) 무상태 서명 토큰(HMAC) | **기각.** (b)와 같다: 새 비밀, 1회용을 지키려면 어차피 표가 필요하다 |
| (f) 워커가 해독하고 보관소에 직접 | **기각.** 워커는 api 볼륨·SA 키를 가질 수 없다(증보 3 (b)(d)). 가지면 증보 3이 기각한 권한 확대다 |
| (g) 워커가 해독하고 api는 받은 바이트를 믿고 쓴다 | **기각.** 손상된 워커가 임의 바이트를 보관소에 쓴다. api가 입력을 믿지 않고 자식 출력만 쓴다(W5) |
| (h) 워커가 PG `bytea`에 올려 두고 api·notifier가 가져가 처리 | **기각.** 5 MiB 덩어리를 PG에 쌓고, 가져갈 폴러(새 BYPASSRLS 읽기나 definer)가 생긴다 |
| (i) 내부 전용 리스너(별도 포트)에만 쓰기 라우트를 둔다 | **별도 포트는 기각.** 템플릿·카탈로그·헬스체크 변경이 따른다. **대신 엣지 차단을 S3에 넣는다**(검수 M3): `/v1/centrifugo/*`가 이미 하는 것과 같은 모양(`respond 403`)이라 템플릿 변경 없이 공개 도달성이 0이 된다(Railway는 caddy만 공개이고 워커는 `api.railway.internal`로 엣지를 지나지 않는다) |
| (j) 자식에 새 모드(긴 변 2048·PNG 유지) | **기각(S3), 열어 둔다.** 코덱 코드 변경이라 별도 디코더 검수가 필요하다. `--prepare`의 1024 px·JPEG q90은 AI 그림에 충분하다고 본다 **[추정]** |
| (k) 「돈이 든 그림」용 끈질긴 대기(`permit_patiently`, 최대 15초) | **기각.** 사람의 올리기가 「바쁨」을 맞는 시간이 늘고 api 요청이 5 MiB 본문을 쥐는 시간도 늘어난다. P6이 ≤3초·2칸으로 정했다 |
| (l) 그림마다 메시지를 하나씩 | **기각.** 한 run의 답이 여러 메시지로 쪼개지고 `client_msg_id = run_id` 멱등이 깨진다 |
| (m) 사람이 승인하는 카드 뒤에 올린다 | **기각.** owner Q2 가(묻지 않음, ADR-0201 P16-답). 이 길은 승인 없이 올린다 — 위험은 고지·일일 상한·run당 1장이 쥔다 |

### 위협과 막는 곳

| # | 위협 | 막는 곳 | 시험 |
|---|---|---|---|
| T1 | 토큰 위조·도용·재사용 | 32바이트 난수, DB에는 해시만, 60초, 단일 사용(UPDATE 한 문장), 풀 때 run 진행 중·에이전트 일치. 위조한 행이 있어도 요청자·채널·업로더는 run에서 도출하고 슬롯은 UNIQUE | WA1·WA2·WA3 |
| T2 | 손상된 워커(BYPASSRLS)가 임의 (run, 에이전트) 행을 직접 넣는다 | 표 권한이 마지막 문이다(`momo_worker` SELECT·INSERT·DELETE, UPDATE 없음). **토큰 행만 위조할 때**는 풀 때 run이 **진행 중이고 그 에이전트의 것**이어야 하며 도출한 채널·요청자 멤버십이 맞고 슬롯 번호가 상한 안이어야 해서, 효과는 진행 중인 run의 에이전트가 자기 대화에 재인코딩된 그림 ≤슬롯 수만큼 쓰는 것이다. **DB 수준으로 뚫린 워커**는 `agent_run`·`message`·`membership`과 토큰 표 DELETE에도 쓰기 권한이 있어(`bootstrap_runtime_roles.sql:52-59`) run·멤버십·슬롯을 모두 위조할 수 있다. 다만 run의 에이전트 자리는 `member.kind = 'agent'`여야 풀린다(W3의 공용 판정, 구현 검수 M-1 (a)): run 행만 위조해 사람 멤버를 에이전트 자리에 앉혀서는 풀리지 않는다(그림이 사람 이름으로 올라가 상한 셈에서 빠지는 길이다). `member`·`attachment` 행 자체를 고치는 워커는 아래 상한의 사정과 같은 부류다. 그에게 남는 경계는 「다시 인코딩한 png·jpeg만, api 프로세스당 동시 4」다. **api가 세는 일일 상한(W12)은 `attachment` 행을 세는데 `momo_worker`는 그 표에 `UPDATE`·`DELETE`가 있어서**(`created_at`·`status`를 고치거나 행을 지우면 숫자가 되돌아간다) **토큰·run·멤버십 행을 위조하는 워커에게만 걸리고 `attachment` 행을 고치는 워커에게는 걸리지 않는다**(구현 검수 M-1 (b), planner 결정: 이 PR은 코드를 바꾸지 않는다). 이 PR에는 호출자가 없고, 워커가 줄일 수 없는 원본에서 세는 일(안: 하루 지난 토큰 청소를 api 쪽으로 옮기고 `momo_worker`의 DELETE를 거둔 뒤 `attachment_write_token`의 `attachment_id IS NOT NULL` 행을 센다)은 호출자를 붙이는 S4(#5372)가 함께 정한다 | WA3·WA18·WA24 |
| T3 | 모델·프롬프트 주입이 그림 쓰기를 부른다 | 토큰을 만드는 것은 워커 코드뿐이고 도구·모델·HTTP 표면이 없다. 토큰은 어떤 글에도 안 실린다. 호출자의 문(G1~G10)·일일 상한·run당 1장이 총량을 쥔다 | WA15·WA20 |
| T4 | 악성 그림 바이트(디코더 악용·폭탄·다형 파일·SVG/HTML 위장·GIF·APNG) | sniff는 세 형식뿐, 자식은 빈 환경·할당 192 MiB·마감 10초, **출력만 저장**, 입력은 어디에도 가지 않음 | WA6·WA7·WA8 |
| T5 | 자원 고갈(디코더 슬롯·메모리·보관소·행) | 동시 쓰기 4, 줄서기 ≤3초·대기자 2, 본문 ≤5 MiB와 읽기 마감, 출력 ≤4 MiB, run당 슬롯, 일일 위임 상한. 사람의 올리기는 줄서지 않으므로 에이전트 해독이 슬롯을 쥔 동안(장당 ≤10초) `Busy`일 수 있다(W5) | WA5·WA9·WA19 |
| T6 | 다른 워크스페이스·대화에 쓴다 | 풀기 tx는 경로의 워크스페이스로 묶이고(RLS FORCE, 비우회 역할), 채널·업로더는 run에서 도출한다. 묶기도 같은 채널·업로더 = 작성자를 요구한다(K7) | WA3·WA12·WA14 |
| T7 | 사칭: 사람의 메시지에 에이전트의 그림을 붙이거나 그 반대 | 업로더 = 그 run의 에이전트 멤버, 묶기는 `uploader == author`·미묶임·같은 채널(K7). 사람의 REST 보내기가 그 첨부를 지목하면 `ForeignUploader` | WA12 |
| T8 | 토큰·주소의 새는 곳(로그·오류·감사·props·Hermes 기록·엣지 로그) | W2의 「어떤 글에도 안 실림」, 가림 확장(`redact_self_media_urls`의 새 접두), 워커는 고정 낱말만 로그, 라우트는 경로를 로그에 쓰지 않는다. **Hermes는 이 토큰을 보지 못한다**(읽기 토큰과 달리 요청 맥락에 안 실린다) | WA15 |
| T9 | SSRF·리디렉션 | 워커→api 사설 주소 하나, 리디렉션 없음·프록시 없음. api는 나가는 요청이 없다(Google은 자기가 만든 세션 주소 하나) | WA16 |
| T10 | 고아: 쓰고 묶기 전에 워커가 죽음 | 행은 묶이지 않은 완료 첨부 = 업로더(에이전트)만 읽음 → 증보 2 D4의 30일(기본 꺼짐). 더 짧은 청소를 만들지 않는다. 합치는 호출 동안의 중지 창은 호출자가 PUT을 마지막 tx 직전에 두어 닫는다(W9, 남는 위험 1) | WA21 |
| T11 | 중단·취소 뒤에도 그림이 올라온다 | 풀 때와 행을 쓸 때 두 번 run 진행 중을 본다. 어긋나면 객체를 지우고 409 | WA10 |
| T12 | 그림 내용(부적절·얼굴·민감) | 막지 못한다. 사람의 요청이 부른 같은 방의 그림이고 공급자의 안전 장치에 기댄다. D3의 「바이러스 스캔 없음」과 같은 급의 한계 | 남는 위험 3 |
| T13 | 사설 주소가 닿지 않음·틀림 | 쓰기 길이 닫히고(폴백 없음) 호출자의 실패 문장. 기동 때 값의 모양만 경고(증보 3 D5·F4) | WA16 |
| T14 | 동시성·이중 쓰기 | 단일 사용 UPDATE, `UNIQUE (run, slot)`, 묶기의 `FOR UPDATE`, 메시지 재시도 멱등(`!deduped`) | WA2·WA12 |

### #5442(ADR-0218 증보 6)와 겹치는 점

[ADR-0218 §12](0218-workspace-expressions.md)(이모티콘 세트 제안, #5442, Proposed)를 읽기만 했고 고치지 않았다. 확인한 것:

1. **세트의 후보 그림은 이 길로 올라오지 않는다.** §12 L3.1 B가 「대화 첨부를 운반체로(#5371)」를 기각했다(승인 전 40장이 대화에 영구히 올라오고, 첨부 소유 술어를 「도우미 자기 것」으로 넓혀야 하며, 대화에 보이는 것과 카드가 보이는 것이 갈린다). L3.3의 표가 겹침을 정한다. 한 Hermes 그림은 **정확히 한 길**로만 간다: 사람이 대화에서 그림 한 장을 부탁하면 이 증보의 길이고, 세트의 어떤 칸도 대화 첨부가 되지 않으며 이 길은 `expression_set`에 쓰지 않는다.
2. **공유하는 것**(L3.3과 같다): Hermes 답에서 그림 한 장을 뽑는 함수(#5372: `data:image/` 주소 하나·png·jpeg·webp·≤5 MiB·GIF 불가), 격리 디코더, 위임 실패 어휘(`picture_failed` 등). **공유하지 않는 것**: 쓰기 주소·`attachment` 행·답 메시지에 묶기(이 증보), 세트의 `expression_set` 보관·세 렌디션(§12).
3. **디코더 슬롯은 겹치지 않는다.** 세트의 `put_still`은 워커 안의 도메인 함수라 **워커 프로세스의** 슬롯 둘을 쓰고(§12 L3.2, K13), 이 길은 **api 프로세스의** 슬롯 둘을 쓴다(사람의 올리기·링크 가져오기와 나눔). 어느 쪽이든 해독을 다른 프로세스로 옮기면 슬롯 경쟁이 생기므로 그때 다시 잰다.
4. **바이트 예산은 따로 센다.**

| | 이 증보(대화 첨부) | §12 L4(세트) |
|---|---|---|
| 입력 한 장 | ≤5 MiB(`INPUT_BYTES`) | ≤5 MiB(같은 숫자) |
| 저장 한 장 | ≤4 MiB(`--prepare` 출력), 긴 변 ≤1024 | 칸당 ≤1.5 MiB(세 렌디션 합) |
| 한 단위 | run당 1장(v1), 일반형 ≤4 **[추정]** → ≤16 MiB | 세트당 ≤24 MiB, 40칸 |
| 하루 | 워크스페이스 위임 일일 30(P7) × ≤4 MiB ≈ **≤120 MiB 보관소**/일 **[추정, 최악]** | 미결정 세트 에이전트당 1, 보관 2시간 |
| 어디에 | 보관소(Drive·local 볼륨) + `attachment` 행 | PG 표 `expression_set`(승인·만료·거절 때 회수) |

두 예산은 서로 더해지지 않는다(한 Hermes 그림은 한 길이다).
5. **ADR-0201의 위임 한도와 세트의 충돌**(요청당 위임 1회 G10·그림 1장 R10 대 세트의 정지 N장)은 §12 L16 O1이 다룬다. 이 증보는 그 숫자를 바꾸지 않는다.
6. **읽기 술어는 넓히지 않는다**(W10). §12 L3.1 B가 걱정한 소유 술어 확대는 이 증보에 없다.

### 수용 기준 (구현이 내야 할 사보타주 단정 — 각 항목은 해당 분기를 지우면 빨개져야 하고 단정은 응답이 아니라 **실제 값**(보관소의 바이트, 표의 행, 자식 시작 횟수, 읽힌 본문 바이트)을 잰다)

- **WA1** 발급: 다음 중 **하나만** 어긴 run에서 `mint`는 `None`이고 표에 행이 0이다 — run 끝남·없음 / 에이전트 불일치 / 트리거 작성자가 에이전트·삭제됨·비활성 / 요청자 또는 에이전트가 대화에서 나감 / 채널 보관됨 / 같은 슬롯의 둘째 발급 / 다른 워크스페이스의 run. 술어를 하나씩 지우면 해당 사례가 행을 쓴다. 둘째 발급은 직접 INSERT로도 `UNIQUE`가 거절한다(DB가 쥠).
- **WA2** 풀기: 한 토큰을 **진짜 TCP로 동시에** 둘이 PUT해도 정확히 하나만 201이고 나머지는 404이며 첨부 행·보관소 객체가 각각 1이다(`used_at IS NULL`을 지우면 둘 다 201). 만료·다른 워크스페이스 경로·끝난 run(`awaiting_approval`·`paused` 포함)·나간 멤버·**보관된 채널**·위조한 행의 슬롯 번호가 상한 밖인 경우는 모두 **바이트까지 같은** 404다.
- **WA3** 도출: 위조한 행(시험이 `momo_worker`로 직접 INSERT)의 에이전트가 run의 에이전트와 다르면 404이고, 같으면 **run의 채널·run의 에이전트**로만 쓰인다. 요청에 가짜 채널·업로더 값(헤더 `X-Channel`·`X-Uploader`, 쿼리 `?channel=`)을 실어도 행의 채널·업로더가 안 바뀐다. 두 대화에 걸친 에이전트로 시험한다. 도출을 다른 run에 대고 부르면 빨강.
- **WA4** 순서: 나쁜 토큰·만료·재사용·끝난 run의 PUT은 **본문을 한 바이트도 읽지 않고**(읽으면 카운터가 오르는 본문을 준다) 디코더 자식을 띄우지 않으며(시작 카운터 0) 보관소 쓰기 0이다. 길이 선언 없음(411)과 5 MiB+1 선언(413)도 본문 0바이트·**토큰 소비 0**이다(이어 같은 토큰으로 정상 PUT이 201). 소비를 헤더 검사 앞으로 옮기면 빨강.
- **WA5** 길이: 선언 N에 N보다 **적은** 바이트만 보내고 끊으면 400 `length_mismatch`이고 자식 0·행 0이다(토큰은 탄다). 선언보다 많이 보낸 바이트는 HTTP 프레임이 본문으로 넘기지 않으므로 그림의 입력은 선언한 N바이트뿐이다(시험이 N+1을 보내 읽힌 길이가 N임을 단정한다). 정확히 5 MiB(5,242,880)는 통과하고 5 MiB+1 선언은 413이다. 한 바이트씩 느리게 오는 본문은 읽기 마감(시험에서는 줄인 값)에서 끊기고 행 0이다.
- **WA6** 형식: **진짜 디코더 자식으로** GIF(한 프레임·움직임)·APNG·SVG·HTML·PDF·움직이는 WebP·HEIC·빈 본문·매직만 png인 쓰레기는 모두 422이고 첨부 행 0·객체 0이다. 정지 png·jpeg·webp는 201이다. 라우트의 sniff를 지우면 **한 프레임 GIF가 201이 된다**(K9의 틈) — 이 사보타주가 빨개야 한다.
- **WA7** 폭탄: 헤더만 큰 PNG(1,600만+1 화소, 가장자리 4097)·압축 폭탄·잘린 파일은 422이고, **자식 시작 횟수는 1만큼 늘고 부모 프로세스 안의 코덱 시작은 0으로 남는다**(셀 수 있는 값, 검수 L7: `momo_expressions::media`의 읽기 전용 카운터 `decoder_children_started()`·`in_process_codec_starts()`). 한도 자체는 기존 해독 시험이 재므로 이 시험은 **라우트 연결이 자식을 거침**을 잰다.
- **WA8** 다시 인코딩: 보관소에서 **저장된 바이트를 꺼내**(응답이 아니라) 단정한다 — 입력과 바이트가 다르다, 입력에 심은 EXIF(GPS·기기)·ICC·텍스트 청크·꼬리 바이트의 표지 문자열이 0이다, EXIF 방향이 반영됐다, mime은 png·jpeg뿐이고 알파 입력은 PNG·아닌 입력은 JPEG, 긴 변 ≤1024·≤4 MiB. 라우트가 자식을 건너뛰고 입력을 저장하면 빨강.
- **WA9** 슬롯: 두 슬롯을 쥔 채 줄이 비면 최대 3초 뒤 503 `busy`·자식 0, 대기자 둘이 차면 셋째는 **즉시** 503, 슬롯이 풀리면 줄 선 둘이 처리된다. 같은 때 사람의 직접 올리기는 줄서지 않고 즉시 `Busy`다. `WAIT_MAX`·`WAITERS_MAX`를 안 쓰면 빨강. 동시 쓰기 4를 넘는 다섯째는 **토큰 소비 0**의 503이다.
- **WA10** 보관·재판정: 보관소가 쓰기를 거절하면 502 `storage_failed`, 행 0, `agent_picture_written` 0·`agent_picture_refused` 1이다. 객체를 쓴 뒤 행 tx가 실패하면(주입) `delete_file`이 불리고 보관소 객체가 0이다. 해독 중 run을 끝내거나 채널을 보관하면 409 `run_over`·객체 삭제·행 0이다 — W3 3의 재판정을 지우면 행이 생긴다.
- **WA11** 행·감사: 업로더 = 에이전트 멤버, 채널 = run의 채널, `complete`, `message_id` NULL, 이름 = `picture-1.png`·`.jpg`, mime = 출력 mime, 크기 = 보관소 객체 길이(`file_metadata`로 대조). 감사 한 줄에 W8의 필드가 있고 이름·바이트·토큰·주소·요청 문장은 문자열 검색으로 0이다. `Content-Type: text/html`·긴 가짜 파일 이름 헤더를 보내도 이름·mime이 안 바뀐다.
- **WA12** 묶기: 새 입구가 한 번에 N장(N=1과 일반형 N=3, 단위 시험)을 한 메시지에 슬롯 순서로 묶고 `message.new`의 outbox payload와 기록 투영이 `attachments`를 싣는다(`Project` 분기를 지우면 payload의 첨부가 0 = 안 보임). 같은 첨부를 사람이 REST 보내기로 묶으려 하면 `ForeignUploader`다. **같은 에이전트·같은 채널의 묶이지 않은 다른 run의 그림은 이 입구가 묶지 않는다**(그 run의 토큰 기록에 없다: 토큰 행의 `attachment_id` 기록을 지우고 호출자가 id를 정하게 하면 빨강, 검수 L2). 이미 묶인 첨부를 다시 묶으려 하면 `AlreadyLinked`이고 다른 채널의 것이면 `ForeignChannel`이다. 메시지 재시도(`client_msg_id = run_id`)는 다시 묶지 않는다(`!deduped`).
- **WA13** 묶기 거절: 일부러 거절시키면(다른 채널의 첨부 id) 메시지는 첨부 없이 `picture_failed` 문장과 함께 **정확히 한 번** 남고(중복 0·반쪽 묶임 0) run은 정상 종료한다. 거절을 평문 재전송이나 삭제로 바꾸면 빨강.
- **WA14** 테넌트: 두 테넌트(비우회 `momo_app`)로 A의 토큰을 B의 경로에 대면 404이고 B에 행 0이다. A의 첨부는 B의 어떤 읽기에도 안 보인다. `momo_app`이 GUC 없이 토큰 표에서 0행을 본다. **BYPASSRLS 길**(`momo_worker`)에서 다른 테넌트의 첨부 id를 묶으려 하면 `link_attachments_in_tx`가 `NotFound`로 거절한다(`workspace_id` 조건을 지우면 거절 사유가 `ForeignChannel`로 바뀐다, 검수 L1).
- **WA15** 새는 곳 0: 성공과 **모든** 실패 경로에서 캡처한 `tracing` 출력·`audit_log`·`outbox.payload`·`agent_run.error`·메시지 `props`·job payload 어디에도 토큰 원문·`agent-media/` 경로·입력 바이트 조각·`Content-Type` 선언이 없다(로그 줄은 고정 낱말뿐). `redact_self_media_urls`가 새 접두를 가린다(`\/`·`%2F` 변형 포함, 접두 하나를 지우면 빨강).
- **WA16** 워커 클라이언트: 리디렉션을 따르지 않는다(302 스텁이 가리키는 둘째 서버에 요청 0). `OORT_API_INTERNAL_ORIGIN`이 없거나 틀리면 호출 0·폴백 0이고 호출자의 실패 문장이 나간다. 한 번만 시도한다(실패 뒤 둘째 PUT 0, 토큰 행 1). 마감 40초(시험에서는 줄인 값). 프록시 무시는 증보 3 후속 F1처럼 자식 프로세스로 재야 하므로 측정하지 못하면 **미측정으로 기록**한다.
- **WA17** 발급 전 거절: 5 MiB+1 base64·GIF 매직·2장은 토큰 행 0·api 요청 0이다.
- **WA18** 잠금: 정적 시험이 세 곳(migration·두 bootstrap)의 잠금 블록이 같은 글자임을 잰다(한 곳을 고치면 빨강). 격리 PG에서 `momo_worker`는 SELECT·INSERT·DELETE만, `momo_app`은 SELECT·UPDATE만, 나머지 역할은 0이다. 가드 트리거가 `used_at` 외 UPDATE와 되돌리기를 거절하고 CHECK(해시 32바이트·수명 ≤10분·슬롯 1~4)가 선다. `momo_app`의 INSERT·DELETE와 `momo_worker`의 UPDATE는 거절된다.
- **WA19** 예산·계약: 풀기 전 거절만 호출 주소·경로 워크스페이스의 예산을 쓰고(성공·풀기 뒤 거절은 안 씀) 주소 전체 상한이 선다. 읽기 라우트의 버킷과 섞이지 않는다. 새 경로가 공개·스펙 밖 목록에 오르고 PUT 외 6개 메서드는 405이며 **예산을 쓰지 않는다**(라우터 층의 405는 예산 층을 지나지 않는다, `dev_token_door_conformance_pg`의 두 목록).
- **WA20** 사용자 영향 0: S3 착륙 빌드에서 어떤 도구·카드·메시지도 이 길을 부르지 않는다(워커 소스에서 호출 자리가 시험 코드뿐임을 정적 검사로 잰다). 평소 Hermes 턴의 `PICTURE_REMOVED_SENTENCE`가 그대로다.
- **WA21** 청소: 만들 때 같은 워크스페이스의 하루 지난 토큰 행이 지워지고 다른 워크스페이스의 행은 남는다. 묶이지 않은 에이전트 첨부가 증보 2 D4의 후보 술어를 그대로 따른다(보관소 복구 포함).
- **WA22** 상수가 한 숫자: `AGENT_PICTURE_MAX_INPUT_BYTES` = `INPUT_BYTES` = `SELF_MEDIA_MAX_BYTES`, 토큰 수명 60초 = 증보 3의 `SELF_MEDIA_INTERNAL_TTL_SECS`와 같은 값(표에서 `expires_at − created_at`으로 잰다).
- **WA23** 세 판정이 같은 함수를 부른다(검수 M1): 끝난 run·`awaiting_approval`·`paused`(검수 I2: 심은 `running`이 아니라 **실제 재개 걸음의 상태**로도 잰다)·나간 멤버·**보관된 채널**·삭제된 요청자·**run의 에이전트 자리가 사람 멤버**(구현 검수 M-1 (a): 같은 run·같은 채널에서 그 에이전트의 `member.kind`만 `human`이다, 사람을 에이전트 자리에 앉힌 위조 run 칸 포함) 각각이 발급·풀기·행 쓰기 **셋 모두에서** 거절된다. 함수의 `archived_at`·`kind = 'agent'`·멤버십 조건을 지우면 세 곳의 같은 사례가 한꺼번에 빨개진다(함수가 둘로 갈라지면 한 곳만 빨갛다). run 상태 조건만은 풀기의 소비 문장이 같은 목록의 사본을 하나 더 쥐고 있어(토큰을 헛되이 태우지 않으려는 것, 구현 검수 I-1) 판정에서만 지우면 발급·행 쓰기의 칸이 빨개지고 풀기의 칸은 남는다 — 둘은 같은 목록이어야 한다(코드 주석이 짝을 표시한다).
- **WA24** 위조 상한(검수 M2): 시험이 `momo_worker`로 run·트리거 메시지·멤버십·토큰 행(슬롯 2)을 직접 만들어도 풀기가 `slot ≤ AGENT_PICTURES_PER_RUN`으로 404이고, api가 세는 일일 상한(시험에서는 줄인 값)을 넘으면 429 `cap_reached`이며 보관소 객체가 늘지 않고(객체 수를 센다) 감사 `agent_picture_refused`가 한 줄 남는다. 상한 검사를 지우면 객체가 늘어난다.
- **WA25** 공개 엣지(검수 M3): 추적되는 엣지 Caddyfile 넷(`infra/rust/Caddyfile`·`infra/railway/Caddyfile.railway`·`infra/rust/Caddyfile.local`·`infra/rust/Caddyfile.host-network`)이 모두 `/v1/agent-media/*`에 `respond 403`을 `/v1/*` 앞에서 낸다. `scripts/tests/test_public_edge.sh`가 네 파일을 재고 로컬 엣지를 실제로 띄워 PUT이 403임을 보며, `scripts/tests/test_railway_template.sh`가 Railway 파일의 순서·모양(`assert_403_order`)을 잰다. 한 줄을 지우면 빨강. 워커의 `OORT_API_INTERNAL_ORIGIN` 배선이 엣지를 거치지 않는 사설 주소임(카탈로그 검사가 이미 못 박고 있다)은 그대로다.

### 구현 슬라이스 (한 이슈 #5371 = 한 브랜치·한 PR, 아래는 그 안의 커밋 단위)

기반 브랜치 `track/engine`. 크기·예상 시간은 Sonnet 워커 기준 **[추정]**이고 S3 전체는 L·등급 2다.

| ID | 내용 | 파일 소유 | 크기·시간 | 선행 |
|---|---|---|---|---|
| WS1 | DB: 토큰 표·가드·RLS·잠금·정적 시험·연속 번호 시험 | `server/Migrations/175_attachment_write_token.sql`, `infra/rust/sql/bootstrap_roles.sql`·`bootstrap_runtime_roles.sql`(잠금 블록 한 곳씩), `momo-db/src/migrate.rs:796`(`discovers_contiguous_migrations_001_to_174`를 175로), `momo-messaging/tests/agent_picture_static_guards.rs`(새) | S·1시간 | 번호 175 배정·증보 Accepted(둘 다 완료) |
| WS2 | messaging: 발급·풀기·행 쓰기·재판정, 답 척추 새 입구, 로그 가림 확장 | `momo-messaging/src/agent_picture.rs`(새), `lib.rs`(내보내기), `message.rs`(새 입구 1개), `attachment.rs`(`complete` 행 INSERT 함수 1개), `self_media.rs`(`redact_self_media_urls` 접두 확장만) | M·2시간 | WS1 |
| WS3 | 디코더 대기 함수와 보관소 쓰기 | `momo-expressions/src/media.rs`(`prepare_photo_waiting` 한 함수, **자식·한도 불변**), `momo-drive/src/{lib,local,stub,google,fake_google}.rs`(`put_object`) | M·2시간 (google은 +1시간, `runtime-unverified`) | — |
| WS4 | api 라우트와 예산·계약 목록 | `bins/momo-server/src/routes/agent_media.rs`(새), `routes/mod.rs`(+1), `lib.rs`(경로 마운트 +1), `rate_limit.rs`(접두 확장·버킷 분리), `tests/dev_token_door_conformance_pg.rs`(공개·스펙 밖 목록 둘), **엣지 Caddyfile 넷(`infra/rust/Caddyfile`·`infra/railway/Caddyfile.railway`·`infra/rust/Caddyfile.local`·`infra/rust/Caddyfile.host-network`)의 `/v1/agent-media/*` 403과 그것을 재는 `scripts/tests/test_public_edge.sh`·`scripts/tests/test_railway_template.sh`(검수 M3)** | M·2.5시간 | WS2·WS3 |
| WS5 | 워커 클라이언트와 선행 거절(호출자 없음) | `bins/momo-agent-worker/src/agent_picture.rs`(새), `lib.rs`(mod 선언 1줄). `team_ai.rs`·`hosted_door.rs`의 호출 자리는 **건드리지 않는다**(S4) | M·1.5시간 | WS2·WS4 |
| WS6 | 실 PG·실 디코더 적합성 시험과 사보타주 | `bins/momo-server/tests/agent_picture_conformance_pg.rs`(새: 두 테넌트·비우회 역할·진짜 디코더 자식·진짜 로컬 보관소·진짜 TCP), `momo-messaging/tests/agent_picture_pg.rs`(새), 워커 시험 | L·3시간 | WS1~WS5와 같이 |
| WS7 | PR 본문(증거·사보타주 표·`runtime-unverified`)·Status 갱신 요청 | PR 본문, 이 증보 Status(planner) | S | WS6 |

- **정책 파일 변경은 없다** [V]: 새 환경 변수가 없고(`OORT_API_INTERNAL_ORIGIN`은 워커에 이미 있다) `check_railway_catalog.py`·compose 템플릿을 바꾸지 않는다. 새 시험이 읽는 `infra/rust/sql/`·`server/Migrations/`는 PR 검사의 rust 필터에 이미 있다(`.github/workflows/pr-ci.yml:226`). 계약 파일(`docs/api/openapi.yaml`)은 읽기 라우트처럼 「공개·스펙 밖」으로 두므로 바꾸지 않는다. 엣지 Caddyfile 넷과 `scripts/tests/test_public_edge.sh`·`test_railway_template.sh`는 `verify_policy_integrity.sh`의 정책 파일 목록(`policy_path()`)에 없다(이 판에서 확인). 이 시험들은 `docker run caddy:2-alpine`이 필요하다.
- 파일 충돌 주의: `media.rs`는 #5442의 후속 슬라이스(세트 보관)도 건드릴 수 있고 `message.rs`·`self_media.rs`는 다른 칸과 겹칠 수 있다. 두 곳 모두 이 증보의 변경은 **함수 추가와 접두 확장**뿐이라 착륙 때 맞추기 쉽다.
- **2단계 분할 제안**: 2단계-가 = WS1~WS4 + WS6의 서버 쪽 시험(약 6~7시간), 2단계-나 = WS5 + google 쓰기 + 워커 시험 + 사보타주 표 + PR 본문(약 4~5시간). 한 세션은 50만 토큰 한도가 있으므로 가·나 사이에 체크포인트를 커밋한다.

### 구현 기록 (2단계, #5371 — 구현이 설계에 더한 것)

설계(W1~W12)는 바뀌지 않았다. 구현하며 코드에서 확인해 더한 것만 적는다.

1. **워커의 답 투영은 미디어 요약이 없는 짝을 쓴다(W9).** 워커의 DB 역할 `momo_worker`는 `attachment_media`에 아무 권한이 없고(`attachment-media-lockdown`), 기존 `message_attachments_in_tx`는 그 표를 `LEFT JOIN`한다. 표 이름이 문장에 있으면 권한 없는 역할은 맞는 행이 없어도 실패한다. 그래서 `message_attachments_without_media_in_tx`(같은 행·같은 네 키, `media` 없음)와 `AttachmentPolicy::ProjectWithoutMedia`를 새로 두었고 새 입구만 쓴다. 에이전트 그림은 영상이 아니라서(`attachment_media` 행은 사람이 올린 영상에만 쓰인다) 잃는 것이 없다. 이 사실은 설계 단계의 검수가 보지 못했고 구현 중 코드 읽기와 시험이 잡았다.
2. **소비 뒤의 일은 별도 task가 끝까지 돈다(W4).** 호출자가 연결을 끊으면 hyper가 핸들러 future를 버린다. 보관소 쓰기와 행 쓰기 사이에서 버려지면 행 없는 객체가 남으므로, 토큰을 푼 뒤의 6~11단계는 `land()`로 떼어 낸다(해독 감독자가 이미 쓰는 방식, `media::run_with_permit`). 요청은 그 결과를 기다리기만 한다.
3. **인프로세스 업로드를 못 받는 보관소는 세션을 만들기 전에 `Unavailable`이다(W7).** 읽기 전용으로 연 로컬 볼륨과 설정 없는 보관소가 그렇다. `DriveArchive::backend_kind()`는 감사의 `backend`에 쓰는 고정 낱말(`local`·`google`·`stub`·`unavailable`)이다.
4. **엣지 Caddyfile은 둘이 아니라 넷이다(M3).** `infra/rust/Caddyfile`·`infra/railway/Caddyfile.railway` 말고 `Caddyfile.local`·`Caddyfile.host-network`도 같은 `/v1/centrifugo/*` 403을 갖고 있어서(터널 뒤 원점과 호스트 네트워크 배치) 넷에 같은 블록을 둔다. 시험(`test_public_edge.sh`)은 `git ls-files`로 넷을 찾아 모두 잰다.
5. **알림 역할 시험이 새 잠금 표를 안다.** `prod_role_conformance_pg::the_other_runtime_roles_reach_every_table_the_migrations_created`는 「모든 표에 app·relay·worker가 닿는다」를 재므로 잠금 표는 그 규칙 밖으로 빼고 따로 권한을 잰다(`attachment_write_token`을 `self_media_token`과 같은 방식으로).
6. **시험이 낮추는 값은 `AppState`에 있다.** 쓰기 자리(`with_agent_media_slots`)·24시간 상한(`with_agent_media_daily_ceiling`)·본문 마감(`with_agent_media_body_deadline`). 정적 변수가 아니라서 시험이 쥐고 풀 수 있다. 자식·부모 코덱 시작 횟수(WA7)는 `momo_expressions::media`의 읽기 전용 카운터 둘(`decoder_children_started`·`in_process_codec_starts`)로 잰다.
7. **호출자가 없다는 것을 시험이 지킨다(WA20).** `momo-agent-worker/tests/agent_picture_static_guards.rs`가 워커의 다른 소스와 서버·크레이트가 쓰기 길의 입구(`PictureWriter`·답 helper·발급)를 부르지 않음을 잰다. 호출자를 붙이는 S4(#5372)·#5334의 PR이 이 시험을 같은 PR에서 고친다.
8. **run의 에이전트 자리는 에이전트여야 한다(W3, 구현 검수 M-1 (a)).** 공용 판정에 `a.kind = 'agent'`(run의 `agent_member_id`가 가리키는 멤버의 종류) 한 줄을 더했다. 이 줄이 없으면 `momo_worker`가 만든 run이 사람 멤버를 에이전트 자리에 앉혀 발급·풀기·행 쓰기를 모두 통과하고, 첨부의 업로더가 그 사람이 되어 `m.kind = 'agent'`만 세는 일일 상한 셈에서 영원히 빠진다. 에이전트 멤버의 활성·삭제는 `is_attachment_channel_member`가 이미 쥐므로 판정에 같은 조건을 중복하지 않았다.
9. **일일 상한이 막는 상대를 좁혔다(T2·남는 위험 2·W12, 구현 검수 M-1 (b)).** 상한은 `attachment` 행을 세고 `momo_worker`는 그 표에 `UPDATE`·`DELETE`가 있다. 이 PR은 코드를 바꾸지 않고(planner 결정) 문장을 실제 범위로 좁혔다. 줄일 수 없는 원본에서 세는 일은 호출자를 붙이는 S4(#5372)가 정한다.
10. **`momo_messaging::agent_picture`는 비공개 모듈이다(WA20, 구현 검수 L-1).** 바깥 크레이트가 쓰는 이름만 크레이트 뿌리에서 재수출한다(판정 함수와 그 반환 구조체는 모듈 안에 남는다). 「호출자 0」 가드는 그 이름들에 더해 모듈 경로(`agent_picture::`)를 바늘로 삼고, 재수출 목록의 함수가 모두 가드의 표에 있는지와 모듈이 비공개인지를 재는 시험을 따로 갖는다.
11. **미디어 요약 없는 투영은 `workspace_id`를 받는다(L-2).** 이 함수는 RLS를 건너뛰는 워커 역할이 부르므로 `link_attachments_in_tx`처럼 문장 안에서 워크스페이스를 건다. 다른 테넌트의 id로 물으면 아무것도 읽지 않는다는 칸이 시험에 있다.
12. **지운 트리거 메시지는 그대로 둔다(구현 검수 6번 결정).** 지운 요청에 답하지 않기는 판정 함수가 아니라 run 척추에서 정할 일이고(후속, 열린 확인 ⑧), 그때 세 판정이 run 상태 조건으로 따라온다.
13. **Google `put_object`의 조립은 가짜 구글로 끝까지 잰다(구현 검수 2회차 L-3).** 세션을 요청할 곳과 허용할 세션 주소(스킴·호스트·포트)를 `UploadEndpoint` 값 하나로 묶었다(`momo-drive/src/google.rs`). 운영 보관소는 언제나 `UploadEndpoint::google()`(`https://www.googleapis.com/upload/drive/v3`·`www.googleapis.com`·포트 없음·`Location` 접두 `https://www.googleapis.com/`)이고 값은 이전과 같다. `#[cfg(test)]` 생성자만 다른 값을 넣으므로 `Location` 접두 검사·`pinned_session_url`·PUT·읽어 온 메타데이터 대조·되돌려 지우기가 **같은 코드**로 루프백 가짜 구글(폴더 조회·파일 id·세션·PUT·메타데이터·삭제를 한 서버가 맡고 받은 요청을 순서대로 기록)을 상대로 끝까지 돈다. 시험 둘: 올린 뒤 Drive가 가진 크기·형식·파일 id가 다르면 실패하고 그 객체 삭제 요청이 정확히 한 번 간다 / 세션 주소가 고정 밖이면 PUT 0건이고 실패한다. 세 번째 시험이 운영 값을 글자로 못 박는다. `Location` 접두 검사와 고정은 같은 주소를 두 번 판정하는 의도한 겹침이라 접두 검사만 지워서는 빨개지지 않는다(고정 호출을 지우면 경로 규칙이 사라져 빨개진다).

### 이슈·문서 문구와 다른 곳

1. **증보 번호**: 브리프의 「증보 4」·ADR-0201의 「ADR-0151 증보」는 이 증보 8이다(위 번호 줄).
2. **ADR-0201 P6의 `process_waiting`**: 대기 방식(≤3초·대기자 2)은 그대로이고 **출력 모양은 `--prepare`**다. `process_waiting`의 출력은 표현 렌디션(≤512 px)이라 대화 그림에 작다(K10·W5). 그 함수를 직접 부르라는 뜻으로 읽지 않는다.
3. **P6의 「S3이 픽셀 상한을 정한다」**: 1,600만 화소·가장자리 4096·할당 192 MiB(W5)로 정했다.
4. **migration**: P14-S3 행은 migration을 말하지 않았다. 이 길은 표 하나가 든다(W1, K3·K4). 번호는 175다(planner 배정).
5. **임대 계산**(ADR-0201 P4-5): 위임 걸음의 임대는 「Hermes 마감 + 합치는 호출 2회 + 여유」(최악 약 160초)로 잡혀 있다. 그림 위임은 거기에 **업로드 마감 40초**(W7·W11)가 더해져 최악 약 200초다. S2·S4가 임대를 이 숫자로 계산해야 한다 — 이 증보는 숫자만 준다.
6. **P15-A10의 「첨부는 도우미가 쓴 메시지에 묶인다」**: 지금 답 척추는 첨부를 묶지 못하므로(K6) 새 입구가 먼저 필요하다(W9). P6이 암묵 전제한 것이다.
7. **기본 결정 D3**: 「에이전트 업로드는 v0 제외」를 이 한 길에 한해 푼다(W10).
8. **ADR-0201 P4-7의 PUT 위치**(검수 L3): 증보 v4는 PUT을 합치는 호출(#2) 앞에 둔다. 그 창에서 사람이 중지하면 고아가 결정적으로 남으므로 **PUT을 합치는 호출 뒤, 마지막 tx 직전**으로 옮긴다(P4-7의 「그림이 이미 첨부로 저장됐으면」 문장은 그 뒤 PUT으로도 같다). S4가 지킨다.

### 검수 수리 기록 (2026-11-06 밤, 독립 보안 검수 1회 PASS → 이 판)

Blocker 0 · High 0 · Medium 3 · Low 7 · Info 4. 판정 원문은 재현 세부가 있어 이 저장소에 두지 않는다. 아래는 발견마다 어디서 닫았는지의 색인이다.

| 발견 | 닫은 곳 |
|---|---|
| M1 보관 채널·run 상태가 풀기·행 쓰기에서 빠짐 | W3(세 판정이 부르는 함수 하나)·WA1·WA2·WA10·WA23 |
| M2 손상된 워커의 범위 문장·api 쪽 수량 상한 0 | T2·남는 위험 2·W3 풀기의 슬롯 상한·W12 일일 상한·WA24(범위는 구현 검수 M-1에서 좁혔다) |
| M3 공개 엣지로 열린 내부 호출 경로 | W2 ④·기각 (i)·WS4·WA25·열린 확인 ⑦ 해소 |
| L1 묶기 조회에 `workspace_id` 없음 | W9·WA14 |
| L2 묶기에 run 묶음 없음 | W1(`attachment_id` 한 번 기록)·W9·WA12 |
| L3 합치는 호출 동안의 중지 고아 | W9(PUT은 합치는 호출 뒤)·남는 위험 1·T10·문구와 다른 곳 8 |
| L4 거절 분류 문장(411·413은 DB 전) | W3·W4·W6·WA19 |
| L5 「바쁨 최대 3초」 | W5·T5·남는 위험 5 |
| L6 Google 세션 주소 | W7(google) |
| L7 WA7의 측정 방법 | WA7 |
| I1 K8의 [확인 필요] | K8 [V]·열린 확인 ① |
| I2 재개 걸음의 run 상태 | 열린 확인 ①·WA23 |
| I3 그림은 도구 출력에서만 뽑기 | S4(#5372) 몫으로 인계 — 이 증보의 길은 호출자를 더하지 않는다 |
| I4 토큰이 경로에 있음 | 그대로 둔다(읽기 길과 같은 모양·가림 확장). `Authorization` 헤더로 옮기는 선택은 하지 않았다: api에 요청 경로를 찍는 층이 없고(TraceLayer 0) 워커는 고정 낱말만 찍는다 |

### 구현 검수 수리 기록 (2026-11-07, 독립 보안 검수 구현 1회차 PASS → 이 판)

Blocker 0 · High 0 · Medium 1 · Low 2 · Info 6, 대상 커밋 `732bae063`. 판정 원문은 재현 세부가 있어 이 저장소에 두지 않는다. 아래는 발견마다 어디서 닫았는지의 색인이다.

| 발견 | 닫은 곳 |
|---|---|
| M-1 (a) run의 에이전트 자리가 사람이어도 통과 | W3 공용 판정의 `member.kind = 'agent'`·WA23의 `AgentSeatIsHuman` 칸과 사람을 에이전트 자리에 앉힌 위조 run 칸·구현 기록 8 |
| M-1 (b) 세는 표를 워커가 고칠 수 있음 | T2·남는 위험 2·W12의 범위 문장(코드는 바꾸지 않았다, planner 결정)·구현 기록 9 — 줄일 수 없는 원본에서 세는 일은 S4(#5372) |
| L-1 「호출자 0」 가드를 모듈 경로로 피함 | `mod agent_picture;`(비공개)·루트 재수출 정리·워커 정적 가드의 표와 `agent_picture::` 바늘·재수출 점검 시험·구현 기록 10 |
| L-2 투영 함수에 `workspace_id`가 없음 | `message_attachments_without_media_in_tx(conn, workspace_id, message_id)`·다른 테넌트 칸·구현 기록 11 |
| I-1 풀기 UPDATE의 run 상태 사본 | 코드 주석으로 짝을 표시, WA23 문장을 풀기의 사정까지 정확하게 고침 |
| I-2 `Content-Length: 0`을 소비 전에 거절 | 열어 둔다(후속, 공짜 개선) |
| I-3 워커 발급 실패 로그의 `cause = %error` | 열어 둔다(후속: 고정 낱말로) |
| I-4~I-6 | 변경 없음(받아들일 만함·확인된 판단) |
| 6번 지운 트리거 메시지 | 그대로 둔다(권고대로)·구현 기록 12·열린 확인 ⑧ |

**2회차**(2026-11-07, 대상 커밋 `3df03f9d3`): Blocker 0 · High 0 · Medium 0 · Low 1 · Info 4. 1회차 지적 셋은 코드로 닫혔다고 확인됐고 M-1 (b)·지운 트리거 문장은 범위와 맞다고 확인됐다.

| 발견 | 닫은 곳 |
|---|---|
| L-3 Google `put_object`의 조립 순서와 읽어 온 메타데이터 대조를 재는 시험이 없음 | 고쳤다: 구현 기록 13의 시험 둘(가짜 구글로 끝까지)과 운영 값을 못 박는 시험 하나 |
| I-7 PUT 시간 초과·메타데이터 읽기 실패 뒤 남을 수 있는 객체 | 열어 둔다(후속: 세션을 만든 뒤의 모든 실패 길에서 한 번 지워 보기, 공격자가 일으킬 길은 아님) |
| I-8 「호출자 0」 가드가 첫 재수출 블록만 읽는 빈틈 둘 | 열어 둔다(후속, 지금 그런 줄은 없다) |
| I-9 W7의 오래된 낱말 하나(읽기 전용 보관소를 `AccessDenied`로 적었으나 코드·구현 기록 3은 `Unavailable`) | 열어 둔다(문서만, 닫히는 쪽) |
| I-10 메타데이터 응답의 바이트 한도 없음(이 PR 이전부터 있던 코드) | 변경 없음 |

### 첫 호출자 (2026-11-07, #5372 — ADR-0201 증보 v4.3)

S3의 「호출자 0」은 끝났다. 이 길의 호출자는 **하나**다: 팀 AI의 Hermes 위임 걸음(`bins/momo-agent-worker/src/team_ai/delegate.rs`가 `PictureWriter::write`를 한 번, `team_ai.rs`의 마무리 트랜잭션이 `send_answer_with_run_pictures_in_tx`로 그 run의 그림을 묶는다). 정적 가드(`tests/agent_picture_static_guards.rs`)는 「호출자 없음」에서 **누가 어느 이름을 부를 수 있는가의 허용표**로 바뀌었고, #5334가 자기 호출자를 더할 때 자기 행을 더한다. L3의 순서는 그대로 구현됐다(합치는 호출 뒤, 정지 확인, 쓰기, 마무리 트랜잭션). 위임 걸음의 임대는 업로드 마감(`WRITE_DEADLINE` 40초)을 더한 값으로 늘고(기본 230초), `send_answer_with_run_pictures_in_tx`는 묶기가 거절돼 그림 없이 나갔는지(`PostedAnswer.pictures_bound`)를 돌려준다. **넘어온 것 중 하지 않은 것**: M-1 (b)(줄일 수 없는 원본에서 세기)는 migration과 역할 SQL(`momo_worker`의 DELETE를 거둠)을 함께 바꾸는 일이라 후속 이슈 **#5530**으로 남겼고(위 T2·남는 위험 2가 그대로 맞다), 지운 트리거 메시지는 planner가 「답하지 않기」로 정해(열린 확인 ⑧ 해소) run 척추 공통 **#5533**이 하고, I-2는 남았고, I-3(워커 발급 실패 로그를 고정 낱말로)은 호출자가 생긴 이 칸이 닫았다. 자세한 것은 ADR-0201 증보 v4.3.

### 바뀌지 않는 것

읽기 라우트 `GET /v1/self-media/{ws}/{token}`(경로·헤더·거절·예산·405), `self_media_token` 표와 권한, 증보 3·4의 읽기 길 전부, 사람 업로드 세 라우트와 `Content-Disposition: attachment`·`nosniff`·`no-store`로 내주는 content 라우트, 격리 디코더의 자식 코드와 한도, `find_requester_attachment_in_tx`(읽기 술어), 증보 2의 청소기 술어, `link_attachments_in_tx`의 판정, `send_message_in_tx`·`send_thread_notice_in_tx`·run line의 `Skip`, ADR-0201 v4의 문(G1~G10)·한도·P9의 문장·P15의 기준, ADR-0218 §12의 세트 계약.

### 남는 위험

1. **고아 창.** api가 쓴 뒤 워커가 묶기 전에 죽으면 묶이지 않은 에이전트 첨부가 남고 청소기는 기본 꺼짐이다(증보 2 D4). 사람은 읽지 못하지만(업로더가 에이전트) 보관소는 늘 수 있다. 상한은 run당 슬롯·api가 세는 일일 상한·위임 일일 상한이 쥔다. 더 짧은 청소는 만들지 않는다. **합치는 호출 동안의 중지**는 호출자(S4)가 PUT을 합치는 호출 뒤에 두면 창이 없다(W9, 검수 L3). 어기는 호출자에서는 중지마다 고아가 하나 남는다.
2. **워커가 api를 통해 보관소에 바이트를 쓸 수 있게 된다.** Railway에서 처음 생기는 능력이다(증보 3 남는 위험 1의 거울). **토큰 행만 위조하는** 워커는 풀 때 run·에이전트·멤버십·슬롯을 다시 보므로 범위가 「진행 중인 run의 에이전트가 자기 대화에 재인코딩된 그림 슬롯 수만큼」이다. **DB 수준으로 뚫린 워커**는 run·멤버십·슬롯도 쓸 수 있다(`bootstrap_runtime_roles.sql:52-59`: `agent_run`·`message`·`membership`·토큰 표 DELETE) — 그에게는 어느 채널에든 쓸 길이 열려 있다(에이전트 자리는 `member.kind = 'agent'`여야 한다, M-1 (a)). 남는 경계는 재인코딩된 png·jpeg와 동시 4다. api가 세는 일일 상한(W12)은 `attachment` 행을 세므로 그 표를 고칠 수 있는 이 워커는 숫자를 되돌릴 수 있다(구현 검수 M-1 (b), 이 PR은 코드를 바꾸지 않는다 — 줄일 수 없는 원본에서 세는 일은 호출자를 붙이는 S4가 정한다). 더해지는 것은 「보관소의 새 바이트」와 「대화의 그림」이고, 워커는 이미 모든 테넌트의 메시지를 쓰고 지울 수 있는 역할이다(160 L6의 「BYPASSRLS 역할에게는 표 권한이 마지막 문」과 같은 원칙으로 api가 스스로 상한을 세지만 그 상한이 막는 상대는 위 범위까지다).
3. **그림 내용을 검열하지 않는다.** 얼굴·부적절한 그림·바이러스 스캔 없음은 D3의 v0 한계와 같은 급이다. 요청자가 부른 같은 방의 그림이고 공급자의 안전 장치에 기댄다.
4. **고아 객체.** 객체를 쓴 뒤 행 tx와 `delete_file`이 모두 실패하면 행 없는 객체가 남고, 행을 따라가는 청소기는 찾지 못한다(채널·워크스페이스 삭제의 고아와 같은 부류, 증보 2 남는 위험).
5. **사람의 올리기에 「바쁨」을 더할 수 있다**(W5, 검수 L5): 에이전트 쓰기 넷이 이어지면 에이전트 해독이 슬롯을 쥔 동안(장당 ≤10초, 몰리면 약 20초). 일일 상한이 빈도를 쥔다.
6. **Google 쓰기 길은 가짜 구글로만 시험한다**(`runtime-unverified`). 실제 Drive 세션 PUT·권한·할당량은 재지 않았다. 문제가 있으면 Google 백엔드 인스턴스에서만 `drive_not_configured`처럼 닫는 선택지가 있다.
7. **사설망 평문.** 토큰이 사설망에서 평문 http로 간다(증보 3 남는 위험 2와 같다). 본문 5 MiB도 같은 길로 간다.
8. **1024 px·JPEG q90**은 AI 그림에 충분하다고 **[추정]**했다. 더 큰 출력이 필요하면 새 디코더 모드(기각 (j))와 그 검수가 먼저다.

### runtime-unverified

실제 Railway 사설망 위의 5 MiB PUT(프록시·엣지 본문 한도가 닿는지), 실제 Hermes 그림을 이 길로 올리는 왕복, 실제 Google Drive 쓰기, 로컬 볼륨의 `fsync`·디스크 가득 때의 오류 모양, 해독 자식의 Linux 한도(`--prepare`는 ADR-0218 H11에서도 Linux 한도를 재지 않았다), 한 프레임 GIF가 `open()`을 통과한다는 K9의 사실(코드 읽기만, 실행 안 함), 팀 AI 답이 스트리밍으로 쓰일 때의 묶기. 시험은 127.0.0.1 TCP·실 PG18(두 테넌트, 비우회 역할)·진짜 디코더 자식·진짜 로컬 보관소로 한다(구현 PR).

### 열린 확인 [확인 필요]

① **재개 걸음의 run 상태**(검수 I2): 풀기·행 쓰기의 `queued`·`running` 조건이 작업 모드 재개 걸음(상태 목록에 `awaiting_approval`·`paused`가 있다)에서 실제로 성립하는지 — 시험은 심은 `running`이 아니라 실제 재개 걸음의 상태로(WA23). (에이전트 토큰의 사람 업로드 라우트 접근은 K8에서 [V]로 해소됐다) ② `attachment`를 `complete`로 직접 INSERT할 때 걸린 트리거(예약 점유 표시 트리거는 점유 표에 걸린 것이라 무관할 것이다 — 착수 때 PG로 확인) ③ Google 세션 PUT의 `Content-Range`·본문 길이 규칙 ④ 라우트의 총 마감 35초와 엣지(Caddy·Railway)의 요청 시간 한도 ⑤ 스트리밍 답에 첨부를 싣는 길 ⑥ 일반형 N 상한 4와 일일 바이트 상한(필요하면 증보) ⑦ (해소: S3이 두 Caddyfile에서 막는다, W2 ④·WA25) ⑧ **지운 요청에 답하지 않기**(구현 검수 6번): 요청자가 요청을 지운 run에서도 글 답은 그대로 나가고 그림도 판정이 막지 않는다. 막기로 정한다면 자리는 판정 함수가 아니라 run 척추(트리거가 지워지면 run을 취소하거나 최종 답 척추가 지운 트리거를 거절)이고, S4 착수 전에 planner가 정한다.

### 검수가 먼저 볼 곳

**R1** 풀기 술어가 읽기(증보 3 D2)를 온전히 거울로 삼는가, 그리고 요청자·채널·업로더를 run에서 **도출**해서 위조 행의 범위가 「진행 중인 run의 그 에이전트」로 닫히는가(W3·T2). **R2** 본문 한도가 본문 **앞**에, 소비가 본문 읽기 **앞**에 있어 나쁜 토큰이 한 바이트도 읽히게 하지 못하는가(W4). **R3** 보관소에 가는 것이 자식의 출력뿐이고, GIF가 `open()`을 통과하는 틈을 sniff가 막는가(W4·W5, K9). **R4** 토큰이 어떤 글에도 없다는 증명(W2·T8)과 새 접두의 로그 가림. **R5** D3 뒤집기가 한 길에 한정되고 읽기 술어가 안 넓어졌는가(W10). **R6** 고아 창과 청소기 의존, 객체를 쓴 뒤 실패할 때의 정리(W7·T10). **R7** 새 공개 경로의 계약·예산·405 처리가 읽기 라우트와 같은 방어를 갖는가(W12·WA19).

### 역방향 줄 대상(각 문서 머리에 한 줄씩, 본문 결정은 바꾸지 않는다)

**이 PR이 단 줄**: ADR-0201 머리 한 줄(P6·P14-S3·P18 ⑧ 링크, `process_waiting` 문장·임대 계산·PUT 위치 정정, 「증보 4」 표기 → 증보 8) · ADR-0151 본문 D3 한 줄(이 증보 W10). **이 PR이 달지 않은 것**: ADR-0218(§12 L3.3에 이 증보의 겹침 절 링크, H9.2의 「따로」가 이 증보 위) — #5442 브랜치가 §12를 고치는 중이라 그 착륙 뒤 planner가 단다. ADR-0203은 해당 없음(이 길은 Hermes에 새 자격을 주지 않는다).

## 증보 9 (2026-11-07, #5469): 사진·GIF의 가로세로 요약 — 보내는 기기가 선언하고, 서버는 범위만 본다

#5451(폰 채팅 진입 흔들림 수리)이 남긴 한 가지다. 첨부 사진·GIF의 가로세로를 서버가 주지 않아서(`AttachmentMedia.kind`는 `video`뿐이다) **처음 보는 사진은 받는 동안 칸 크기를 모른다.** 웹은 높이 180의 자리 상자에서, 폰은 16:9 자리표시에서 서고, 디코드가 끝나야 제 비율이 된다. 왕복 500ms에서 그 한 걸음이 약 80pt이고, 한 번 본 사진은 기기가 크기를 기억해서 제자리에 선다(#5451 §1). 이 증보는 영상 요약(증보 5 D5)과 **같은 길**로 사진·GIF의 가로세로를 실어, 처음 보는 사진도 첫 프레임부터 제 칸에 서게 한다.

- Status: **Accepted** (2026-11-07 planner — 등급 2 독립 보안 검수 1회차 PASS: Blocker 0 · High 0 · Medium 1 · Low 1, 대상 `92985c622`; Medium(롤백 정리 SQL 문구)은 남는 위험 5에서 고쳤다) (2026-11-07, Sonnet 5.5 worker 기안. 독립 보안 검수 등급 2 전이다). ADR-0100: 공개 API(`setAttachmentMedia` 요청·`AttachmentMedia` 투영)와 DB 계약(migration 178)이 바뀌므로 이 증보가 구현 머지 조건이다. 구현은 같은 PR에 있고 Accepted 전에는 머지하지 않는다. **M7-I 「다시 재는 조건」(서버 API·DB 계약)에 해당한다.**
- 표기는 앞 증보와 같다: [V] 코드·문서를 직접 읽어 확인 · **[추정]** 이 증보가 정한 숫자·해석 · `runtime-unverified` 실행 안 함. 구현이 인용할 절 id: 사실 `F1`~`F8`, 결정 `I1`~`I9`, 수용 기준 `IA1`~`IA11`.
- **한 줄 요지**: `PUT …/attachments/{id}/media`가 `kind: "image"`와 `width`·`height`만 받는다(영상은 `kind`가 없거나 `video`). 서버는 사진을 열지 않고 범위(1~16,384)·저장된 종류(JPEG·PNG·GIF·WebP)·첫 12바이트의 매직만 본다. 값은 `attachment_media`에 길이 없이(널) 저장되고, 모든 투영이 `media: {kind: "image", width, height}`를 더한다. 받는 쪽은 그 크기로 첫 프레임부터 칸을 잡고, 그림이 디코드되면 **실제 크기가 이긴다.** 요약이 없는 옛 메시지는 지금처럼 기기 기억을 쓴다.

### 변경 전 — 확인한 사실 [V]

- **F1** openapi `AttachmentMedia`는 `kind: [video]`에 필수 키 다섯(`kind`·`durationMs`·`width`·`height`·`hasPoster`)이고, `MessageAttachment.media` 설명이 「사진·문서는 `media` 키가 없다」고 말한다. 요청 `SetAttachmentMediaRequest`는 `durationMs`·`width`·`height`가 필수이고 `additionalProperties: false`다.
- **F2** 쓰기 길 `routes/attachment_media.rs::set_media`: ① 요청 모양(숫자 범위·포스터)을 연결을 잡기 전에 판정 → ② 업로더 본인·`complete`·메시지에 안 묶인 첨부만(`may_hold_media`, 멤버십은 content 라우트의 두 함수) → ③ 저장된 mime이 닫힌 영상 목록이고 `ftyp`·EBML 매직(범위 읽기 12바이트) → ④ 둘째 tx에서 첨부 행을 `FOR UPDATE`로 잡고 다시 판정한 뒤 쓴다. 표 `media_write` 예산, 감사 `attachment.media_set`(`kind`는 종류만).
- **F3** `attachment_media` 표(173): `duration_ms integer NOT NULL`(1~86,400,000), `width`·`height` NOT NULL(1~16,384), 포스터 네 열은 모두 있거나 모두 없다. RLS ENABLE+FORCE+`ws_isolation`, 복합 FK CASCADE. 권한은 `attachment-media-lockdown` 블록이 **세 파일(173·`bootstrap_roles.sql`·`bootstrap_runtime_roles.sql`)에 같은 글자로** 쥐고, 팀 AI 읽기 역할(`momo_helper_read`)은 열 이름을 나열한 `GRANT SELECT (…)`로 포스터 바이트만 뺀 열을 읽는다. 정적 시험이 블록의 글자와 그 열 목록을 못 박는다.
- **F4** `media`를 싣는 투영은 둘이다: `message_attachments_in_tx`(보내기 응답·재생 echo·`message.new` 프레임·outbox)와 `PAGED_ATTACHMENT_JOIN`(채널·스레드 페이지, 팀 AI 읽기 역할도 같은 문장). 에이전트 워커의 답은 표 권한이 없어 `media` 없는 투영(`message_attachments_without_media_in_tx`)을 쓴다.
- **F5** 받는 쪽 거름: 코어 `attachmentMediaFromWire`는 `kind !== "video"`이면 **요약만 버리고**, `attachmentsFromWire`는 그 첨부를 남긴다. REST 페이지는 응답을 그대로 통과시키고 화면이 `attachmentMediaOf`로 다시 거른다. 이 거름은 v0.1.42(#5208)부터 나갔고(`git tag --contains 3248e7eeb`), 그 앞 판은 `media`를 읽지 않는다. 메시지 페이지·`message.new` 프레임을 `additionalProperties: false`·enum으로 거르는 엄격한 스키마 거름은 웹·폰·코어에 없다(zod·ajv 등 의존이 `package.json`에 없고, 첨부를 만드는 길은 위 두 곳뿐이다. 데스크탑은 웹 번들이다). 그래서 어느 출시 판도 `kind: "image"` 요약 때문에 **첨부나 메시지를 버리지 않는다.**
- **F6** 받는 쪽 칸: 웹 `AttachmentList`의 한 장 사진은 받는 동안 높이 `preview-frame`(180) 상자, 디코드 뒤(`onLoad`) 규칙 상자(`inlineImageBox`)이고 자연 크기를 메모리에만 기억한다. 폰 `ImageTile`은 16:9 자리표시, `Image.getSize` 뒤 비율이고 잰 크기를 기기에 기억한다(#5451 `attachmentSizeMemory`). 처음 보는 사진은 한 번 자란다(왕복 500ms에서 약 80pt).
- **F7** 보내는 쪽: 웹·폰 모두 `PUT …/media`를 부르는 코드가 **이 트리에 없다**(`media`를 읽는 폰의 영상 카드·재생은 있고, 영상을 재서 올리는 쪽은 없다 — 코드 전체 검색으로 확인). 사진용이 첫 호출자다.
- **F8** 서버에는 머리 바이트만 읽는 크기 읽기(`member_avatar::image_dimensions`)와 매직 판별(`sniff_image_mime`)이 이미 있다(아바타·포스터용). 단 JPEG의 크기 표지(SOF)는 앞의 APPn·ICC 조각을 **걸어서** 찾으므로 읽어야 할 앞 바이트 수가 입력에 달렸고(영상 매직은 12바이트), EXIF 방향은 읽지 않는다.

### 결정

- **I1 · 설계 (a): 보내는 기기가 선언한다.** 사진·GIF를 올리는 기기는 자기가 이미 아는 가로세로를 `PUT …/media`로 보낸다(영상과 같은 시점: `complete` 뒤, 전송 전). 서버는 사진을 파싱하지도 디코드하지도 않는다. 증보 5 D5의 원칙(「서버는 영상을 파싱하지도 변환하지도 않는다」, 적대 형식의 파싱은 가둬야 한다)이 사진에도 그대로다.
- **I2 · 와이어.** 요청은 `oneOf`다. 영상: 지금과 같다(`durationMs`·`width`·`height` 필수, `poster` 선택, `kind`는 없거나 `video`). 사진: `{kind: "image", width, height}` 셋이 전부이고 `durationMs`·`poster`는 모르는 키다. 둘 다 닫힌 객체다. 응답과 모든 투영의 `media`도 `oneOf`다: `{kind: "video", durationMs, width, height, hasPoster}`(그대로) 또는 `{kind: "image", width, height}`(`hasPoster`·`durationMs` 키 없음). 포스터는 사진에 없다.
- **I3 · 서버 검증은 영상과 같은 네 걸음이다.** ① 모양: `width`·`height`가 정수 1~16,384(`MEDIA_MAX_DIMENSION`, 영상과 한 숫자)이고 연결을 잡기 전에 누구에게나 400. ② 누구·무엇: 같은 멤버십·읽기 함수·`may_hold_media`(업로더 본인·`complete`·미묶임), 같은 403/404 문장, 같은 `media_write` 예산, 사람만(`require_human`). ③ 파일: 저장된 mime이 `image/jpeg`·`image/png`·`image/gif`·`image/webp`(`sniff_image_mime`이 아는 넷, 닫힌 목록)이고 첫 12바이트의 매직이 그 종류다(`sniff_image_mime(prefix) == 저장된 mime`). 아니면 업로더 본인에게만 400. 영상 모양을 사진 파일에, 사진 모양을 영상 파일에 보내도 400이다. ④ 둘째 tx에서 `FOR UPDATE`로 다시 판정하고 쓴다(멱등 교체). 감사는 `attachment.media_set`에 `kind: "image"`·`has_poster: false`.
- **I4 · DB는 한 열을 풀고 한 줄을 더한다 (migration 178).** `attachment_media.duration_ms`의 NOT NULL을 풀고, `CHECK (duration_ms IS NOT NULL OR poster_mime IS NULL)`(길이 없는 행 = 정지 그림 = 포스터 없음)를 더한다. 길이·치수 범위 CHECK는 널이면 통과하므로 그대로다. **`kind` 열을 만들지 않는다**: 길이가 없으면 정지 그림이다. 새 열·새 표·새 권한이 없으므로 RLS 정책·FK·`attachment-media-lockdown` 블록(세 파일의 같은 글자)·점검 SQL은 그대로다. 투영은 `am.duration_ms IS NULL`로 종류를 가른다.
- **I5 · 투영.** 두 투영이 같은 모양을 낸다: 행이 있고 길이가 없으면 `{kind: "image", width, height}`. 행이 없으면 지금처럼 `media` 키가 없다. 에이전트 워커의 투영은 그대로 `media`가 없다(표 권한이 없다). Rust의 `AttachmentMedia`는 `kind`로 가른 enum이다(`Video{…}`·`Image{width, height}`).
- **I6 · 받는 쪽.** 요약이 있으면(코어가 범위 1~16,384 정수를 다시 막은 값, 그리고 첨부의 mime이 이미지일 때만) 그 크기로 **첫 프레임부터** 칸을 잡는다. 웹은 받는 동안의 자리를 이 크기(`inlineImageBox`)로 세우고 폰은 첫 상태를 이 크기로 둔다. **그림이 디코드되면 실제 크기가 이긴다**: 같으면 칸은 움직이지 않고(정직한 선언이 계약이다), 다르면 한 번 고쳐 선다(선언은 그림이 오기 전까지의 자리일 뿐이다). 요약이 없으면(옛 메시지, 옛 판이 보낸 사진) 지금과 같다: 기기 기억, 없으면 자리표시.
- **I7 · 보내는 쪽.** 웹·폰은 `complete` 응답을 받은 **뒤, 그 첨부를 보내기 가능으로 바꾸기 전에** `PUT …/media`를 부른다(그 사이에 전송이 묶으면 `may_hold_media`가 거절한다). 실패·시간 초과는 보내기를 막지 않는다(요약 없이 간다). 가로세로는 **받는 쪽이 같은 바이트에서 재는 것과 같은 자**로 잰다: 웹은 `createImageBitmap(file)`(방향을 적용한 표시 크기), 폰은 `Image.getSize(파일 주소)`. 닫힌 목록 밖의 종류(HEIC 등)와 **인라인 미리보기 상한(8 MiB, `INLINE_PREVIEW_MAX_BYTES`)을 넘는 사진**은 선언하지 않고 재지도 않는다: 받는 쪽이 그런 파일은 칸이 아니라 파일 카드로 그리므로 크기가 쓰일 곳이 없고, 큰 그림을 디코드하는 비용만 든다.
- **I8 · 옛 판.** 위 F5 그대로다. 새 서버가 `kind: "image"` 요약을 실어도 v0.1.42 이상은 요약만 버리고 첨부를 지금처럼 그리며, 그 앞 판은 `media`를 읽지 않는다. 옛 클라이언트의 사진 보내기(선언 없음)는 지금처럼 요약 없이 간다. 새 클라이언트가 옛 서버에 `kind: "image"`를 보내면 옛 서버는 `kind`를 모르는 키로 422하고(`deny_unknown_fields`) 클라이언트는 그 실패를 무시한다(I7).
- **I9 · 이번에 하지 않는 것.** 링크 카드 높이(#5469 선택 2), 에이전트가 올린 그림(증보 8, 요약 없음 — api가 재인코딩한 바이트를 알고 있으므로 후속에서 채울 수 있다), 서버가 사진을 열어 재는 길, 포스터의 사진 확장.

### 비교한 방식

| 방식 | 판단 | 근거 |
|---|---|---|
| **(a) 보내는 기기가 선언, 서버는 범위·종류·매직만** | **채택 [권장]** | 영상과 같은 길·같은 권한·같은 예산이고 서버가 사진을 열지 않는다. 기기는 받는 쪽과 같은 자로 표시 크기를 이미 안다. |
| (b) 서버가 `complete`에서 머리 바이트를 읽어 잰다 | 기각 | ① `complete`가 보관소 내용 읽기가 되어(지금은 메타 호출뿐) 업로드 완료의 실패 모양이 늘고, JPEG는 F8대로 12바이트로 모자라 읽는 바이트가 입력에 달린다. ② 헤더 파서가 적대 입력을 만나는 자리가 사람 업로드 전부로 넓어진다(증보 5 D5·증보 4 D7의 원칙). ③ **EXIF 방향을 읽지 않으므로** 세로로 찍은 사진의 헤더는 가로세로가 뒤바뀐 값이라 가장 흔한 사진에서 힌트가 틀린다 — 방향까지 읽으려면 파서가 하나 더 든다. ④ 선언이 거짓일 수 있다는 점은 (a)와 같아 (b)가 신뢰를 더하지 못한다. 장점(옛 클라이언트가 올린 사진에도 요약이 생긴다)은 인정한다: 새 클라이언트가 퍼질수록 (a)의 범위가 같아진다. |
| (c) 서버가 사진을 디코드 | 기각 | 모든 멤버의 업로드를 api가 디코드(CPU·메모리 공격면). 증보 8의 격리 디코더는 워커용 5 MiB 한 장이다. |
| (d) 새 표 `attachment_image_media` | 기각 | 새 테넌트 표 = RLS·복합 FK·권한 블록 세 파일·점검 SQL 4절·증보 2 참조 전수 표(A7)가 한꺼번에 는다. 한 열의 NOT NULL을 푸는 것이 같은 일을 더 작게 한다. |
| (e) `kind` 열을 더한다 | 기각 | 새 열이 팀 AI 읽기 역할의 열 단위 `GRANT SELECT (…)`에 들어가야 해서(안 넣으면 페이지 문장이 42501) 세 파일의 블록 글자와 그 정적 시험을 고치게 된다. 길이의 유무가 같은 정보를 준다(I4). |

### 수용 기준과 red proof

각 줄은 그 줄을 **지우면 붉어지는 시험**이다(단정은 응답 모양이 아니라 실제 값 — 저장된 행, 읽힌 바이트 수, 실제 SQL 결과, 칸의 치수 — 을 잰다). 서버 시험은 실 PG18(비우회 역할, 두 테넌트)이다.

| 기준 | 시험 | 지우면 붉어지는 줄 |
|---|---|---|
| **IA1** JPEG·PNG·GIF·WebP의 선언을 받고, 답은 세 키 요약이며, 행은 길이·포스터가 없고, 받은 쓰기는 객체를 한 번(12바이트) 읽는다 | `a_photo_or_gif_holds_its_size_before_the_send_only` ① | 닫힌 목록, 세 키 응답, migration 178의 `DROP NOT NULL` |
| **IA2** 범위 밖(0·16,385·음수)은 연결을 잡기 전에 400(다른 멤버에게도 같은 400)이고, 소수·문자·빠진 값은 422이며, 보관소 읽기는 0이다 | 같은 시험 ③, 단위 `a_picture_size_is_range_checked_at_both_ends`, 라우트 단위 `the_shape_step_builds_the_write_and_range_checks_it` | `validate_image_declaration`의 범위 |
| **IA3** 목록 밖(PDF·SVG·HEIC·영상)과 종류와 매직이 다른 파일(글→png, png→jpeg, gif→webp), 영상 모양을 사진에·사진 모양을 영상에 보낸 것은 업로더에게만 400이고, 목록 밖은 읽기 0이다 | 같은 시험 ⑤, 단위 `only_the_four_picture_types_may_hold_a_size`·`the_picture_magic_is_the_one_the_stored_type_names`·`a_write_asks_the_questions_of_its_own_kind` | `require_image_mime`, `image_magic_matches`의 종류 대조, 라우트의 매직 질문 |
| **IA4** 쓰기는 업로더 본인·`complete`·미묶임뿐이다. 다른 멤버·pending·보낸 뒤·지운 뒤·다른 테넌트는 영상과 같은 404(없는 id의 404와 바이트까지 같다), 비멤버·남의 자격은 403이다 | 같은 시험 ⑥⑦⑨ | `may_hold_media`의 항, 두 트랜잭션의 재판정 |
| **IA5** 사진 모양은 닫힌 객체(길이·포스터·`hasPoster`는 422)이고, `kind`가 없는 본문은 영상이며, 모르는 `kind`(다른 낱말·대소문자·타입)는 422이다 | 같은 시험 ④, 라우트 단위 `the_kind_picks_one_of_two_closed_shapes`·`the_request_is_closed_and_its_poster_is_optional` | `ImageMediaRequest`의 `deny_unknown_fields`, 영상 `kind` 필드의 단일 값 |
| **IA6** 보내기 응답·같은 보내기의 재생·채널 페이지·스레드 페이지·outbox 프레임·팀 AI 읽기 역할이 모두 **세 키** 요약을 싣고(영상 요약은 다섯 키 그대로), 선언 없는 사진은 `media` 키가 없다 | `an_image_summary_rides_every_projection`, 단위 `a_picture_summary_is_three_keys_and_never_a_length_or_a_poster`·`a_row_without_a_length_is_a_picture_and_no_row_is_no_summary`·`the_page_projection_reads_the_lateral_aggregate_and_hides_incomplete_rows` | `PAGED_ATTACHMENT_JOIN`의 `WHEN am.duration_ms IS NULL` 가지, `from_joined`의 사진 갈래 |
| **IA7** `duration_ms`만 널 허용이고, 길이 없는 행에 포스터가 못 붙고(CHECK), 길이 범위·가로세로 범위가 그대로이며, 178을 두 번 적용해도 무해하고, 새 권한이 없다 | `a_picture_row_has_no_length_and_no_poster_and_the_migration_reapplies` | `attachment_media_still_ck`, `DROP NOT NULL` |
| **IA8** openapi `oneOf` 두 갈래가 서버가 직렬화하는 키·`kind`·범위와 같고, 문서가 말하는 요청 두 모양만 라우트가 읽는다 | `attachment_media_image_contract`의 시험 넷 | 스펙과 서버 한쪽만 바꾸기 |
| **IA9** 받는 쪽 코어: 사진 요약은 통과하고 범위 밖·모르는 `kind`는 요약만 버리며(첨부는 남는다), 영상 읽기(`attachmentMediaOf`)는 사진 요약을 읽지 않고, 사진 크기(`attachmentImageSizeOf`)는 이미지 첨부에서만 믿는다. **나간 v0.1.42~0.1.44의 거름(글자 그대로 얼린 사본)은 사진 요약만 버리고 첨부를 남긴다** | 코어 `attachmentMedia.test.ts`·`legacyMediaFilter.test.ts`·`attachmentFrames.test.ts`·`video.test.ts` | 거름의 범위·`kind` 갈래·키 목록, `attachmentImageSizeOf`의 mime 확인 |
| **IA10** 보내는 쪽: 선언은 `complete` 뒤 보내기 가능으로 바꾸기 **전**이고, 닫힌 목록 밖·인라인 상한(8 MiB) 위는 재지도 보내지도 않으며, 재지 못하거나 범위 밖이면 보내지 않고, 실패·429·예산 초과는 보내기를 막지 않으며, 본문은 `{kind: "image", width, height}`이다 | 코어 `declareImageSize.test.ts`·`attachmentMediaApi.test.ts`, 웹·폰 선언 시험(아래 구현 기록) | 호출 순서, 닫힌 목록·상한 확인, 던지지 않음, 예산, `PUT` 경로 |
| **IA11** 받는 쪽 칸: 요약 있는 처음 보는 사진의 첫 프레임 칸은 디코드 뒤의 칸과 같고(이동 0), 디코드된 크기가 다르면 한 번 고쳐 서며 선언은 기억되지 않고, 요약이 없으면 지금과 같다 | 웹·폰 칸 시험(아래 구현 기록) | 선언으로 첫 칸 세우기, 선언을 기억에 쓰지 않기, 잰 값이 이기기 |

### 구현 기록 (같은 PR — 코어·웹·폰·재는 도구)

- **코어**: `lib/attachmentMedia.ts`(`attachmentMediaFromWire` 영상|사진, `canDeclareImageSize`, `imageSizeDeclaration`), `features/attachments/model.ts`(`attachmentMediaOf`는 영상만, `attachmentImageSizeOf`는 이미지 첨부의 사진 요약만), `features/attachments/declareImageSize.ts`(선언 한 걸음: 던지지 않고 예산 4초), `lib/api.ts`(`setAttachmentMedia`).
- **웹**: 받는 쪽 `timeline/AttachmentList.tsx`(`ImageTile`의 칸 = 잰 크기 ?? 선언, 오는 동안 같은 상자를 `<canvas>` 자리로 — `<svg>`는 `iconSystem.test`가 막는다) · 시험 `attachments/inlineImageDeclared.test.tsx`. 보내는 쪽 `attachments/draftStore.ts`(`uploadOne`: 완료 뒤·칩이 「올림」이 되기 전 `declareImageSize`, 닫힌 목록 밖·8 MiB 위는 재지 않음), `attachments/imageDimensions.ts`(`decodeDisplayBitmap`: `imageOrientation: "from-image"`를 직접 청하고, 그 값을 모르는 엔진의 `TypeError`에서만 기본값으로 한 번 다시 푼다), `attachments/draftThumbnail.ts`(트레이 썸네일이 같은 디코드를 나눠 쓴다 — 재기를 업로드 시작이 아니라 바이트가 다 올라간 뒤에 시작하는 까닭이다: 큰 사진을 두 번 풀지 않는다) · 시험 `draftStore.declareSize.test.ts`·`imageDimensions.test.ts`·`draftThumbnail.sharedDecode.test.tsx`.
- **폰**: 받는 쪽 `attachments/AttachmentList.tsx`(`ImageTile`의 상태는 **잰 값만**이고 칸은 `measured ?? declared`다. 그래서 `Image.getSize`가 실패해도 선언 칸으로 남고 16:9로 되튀지 않는다) · 시험 `__tests__/attachmentPhotoRow.test.tsx`. 보내는 쪽 `attachments/draftStore.ts`, `attachments/imageSize.ts`(`measurePickedImage`: 받는 쪽과 같은 `Image.getSize`로 잰다. 고르개가 알려 주는 가로세로는 쓰지 않는다 — 플랫폼에 따라 방향을 적용하기 전의 값일 수 있다) · 시험 `__tests__/composerAttachments.test.tsx`.
- **재는 도구**: `clients/mobile/measure/seed-media-lab.py`가 사진·GIF를 올린 뒤 가로세로를 선언한다(`--no-declare-sizes`는 선언 없이 올리는 기준선). 선언이 없는 시드로는 이 기능 경로가 돌지 않아 #5451 측정 흐름이 여전히 약 80pt 자람을 보인다.

### 신뢰와 공격면

- 값은 **보내는 기기의 선언**이고 서버는 범위만 본다. 쓰임은 **그림이 오기 전의 자리**뿐이며, 받는 쪽은 범위를 다시 막고(1~16,384 정수) 그림이 디코드되면 실제 크기를 쓴다(I6). 거짓 선언(극단적으로 납작한 값 포함)이 만드는 것은 그림이 올 때까지의 잘못된 자리와 한 번의 자리 고침이고, 그림을 가리거나 영구히 가는 띠로 두지 못한다.
- 서버가 더하는 일은 **저장된 mime 비교, 첫 12바이트 범위 읽기 한 번(영상과 같은 `file_range`, 보관소 락 없이), 정수 두 개 저장**이다. 파서·디코더·새 crate·자식 프로세스가 없다. 매직이 맞는 가짜(헤더만 사진인 파일)는 통과한다 — 받는 쪽 디코더가 「미리보기를 못 불러왔어요」로 받고, 서버는 이 파일을 지금도 `attachment`·`nosniff`로만 내준다. 영상의 같은 한계(증보 5 D5 「신뢰」)와 같다.
- 쓰기 권한은 영상과 **글자까지 같은 두 함수**(`may_hold_media`, content 라우트의 멤버십·읽기)가 쥔다. 사진이라고 넓어지지 않는다: 업로더 본인·`complete`·미묶임, 에이전트·개발자 토큰은 문이 없다. 예산도 `media_write` 하나를 영상과 나눈다(첨부 20개 한도에서 한 메시지의 선언 20번이 기본 60/창 안이다).
- 테넌트: 같은 표·같은 RLS FORCE·복합 FK다. 다른 워크스페이스의 첨부 id는 그 요청의 `app.workspace_id` 아래에서 보이지 않아 같은 404다.

### 바뀌지 않는 것

증보 5 D5의 영상 요약·포스터(저장·읽기·헤더·예산·감사 모양), 업로드 세 라우트와 content 라우트의 헤더(`attachment`·`nosniff`·`no-store`), 증보 1·2의 읽기·수명 술어(청소기는 첨부 행을 따라가고 media 행은 CASCADE다), `attachment-media-lockdown`의 글자·열 목록·권한, `message_attachments_without_media_in_tx`(워커), 에이전트 업로드 금지(D3, 증보 8 W10의 한 길만 예외).

### 남는 위험

1. 새 클라이언트가 보낸 사진부터 요약이 있다(I8). 옛 판이 올린 사진·옛 메시지는 지금처럼 한 번 자란다.
2. 선언이 틀리면(거짓·플랫폼 차이) 그 사진은 한 번 자리를 고친다(I6). 같은 바이트를 같은 자로 재므로 정직한 기기에서는 일어나지 않아야 하나, 폰 `Image.getSize`가 방향을 적용하는지는 실기기로 재지 못했다(`runtime-unverified`).
3. 에이전트가 올린 그림에는 요약이 없다(I9).
4. 한 멤버가 묶이지 않은 media 행을 쌓는 상한은 영상과 같이 예산·초안 회수가 쥔다(증보 5 D5 「예산」).
5. **서버를 이 증보 이전 판으로 되돌리면(롤백) 길이 없는 행이 옛 서버의 페이지 읽기를 깬다.** 옛 `PAGED_ATTACHMENT_JOIN`은 길이를 그대로 JSON에 실어 `durationMs: null`을 만들고 옛 디코더(`i64`)가 그것을 거절하므로, 사진 요약이 든 메시지가 있는 채널의 페이지가 500이 된다(옛 per-message 투영은 요약만 빠뜨린다). 요약은 힌트일 뿐이라 지워도 잃는 것이 없다: 롤백 **전에** 소유자 권한으로 `DELETE FROM attachment_media WHERE duration_ms IS NULL`을 한 번 돌린다. 앞으로 가는 방향(새 서버·새 DB, 옛 클라이언트)은 안전하다. 같은 이유로 사진 요약을 쓰는 클라이언트는 이 서버가 배포된 **뒤에** 나가야 한다(옛 서버에는 `kind`가 422다 — I8). **이 정리는 슈퍼유저 연결로 실행한다**: 표가 FORCE RLS라 슈퍼유저가 아닌 소유자로 돌리면 오류 없이 0행을 지운다(보안 검수 1회차 Medium, 실측: 소유자 0행 · 슈퍼유저 7행 · `momo_app` 권한 거부). 실행 뒤 `SELECT count(*) FROM attachment_media WHERE duration_ms IS NULL`이 0인지 확인한다.

### runtime-unverified

실기기·실제 팀 서버의 왕복 500ms 처음 진입 흔들림(≤1pt) 실측(#5451 측정 흐름 재사용은 스택 검증 몫), 폰 `Image.getSize`·웹 `createImageBitmap`의 방향 처리와 큰 GIF·WebP의 크기 값, HEIC 등 닫힌 목록 밖 종류.

### 검수가 먼저 볼 곳

**R1** 사진 쓰기가 영상과 같은 두 함수·같은 404/403·같은 예산을 거치는가(I3). **R2** 서버가 사진 바이트를 읽는 곳이 첫 12바이트 한 번뿐이고 파서가 없는가(I3·F8). **R3** migration 178이 새 열·권한을 만들지 않고, 사진 행에 포스터가 들어갈 수 없는가(I4). **R4** 두 투영이 같은 모양이고 팀 AI 읽기 역할이 여전히 페이지를 읽는가(I5). **R5** 받는 쪽이 어떤 요약이 와도 첨부를 버리지 않고, 범위 밖·이미지가 아닌 첨부의 요약을 믿지 않는가(I6·I8).
