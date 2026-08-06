# ADR-0151 — 첨부 v0: Drive 계약 동결 이식 + 클라 최소 표면

- Status: **Accepted** (2026-08-06 성재 승인 — 실행 지시 "작업 진행해줘"와 함께. 방향은 2026-08-04 결정 D로 사전 승인)
- Date: 2026-08-05
- 관련: ADR-0145 증보 1(attachments 3경로=이식 대상 v0 — 본 ADR이 그 "선행 ADR"이다) · 2026-07 재설계 확정(파일 저장=Drive 공유드라이브+SA 멤버) · U1 감사 `docs/planning/research/2026-08-05-chat-ui-audit.md` H-10/U4-f(컴포저에 첨부 진입점 0)

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
- **D3 · 경계**: content 접근은 인가 프록시 단일 경로(채널 멤버십·RLS — Drive URL 클라 비노출). 크기·mime 정책은 서버 스펙 값 유지. 바이러스 스캔 없음은 v0 한계로 명시. **에이전트 업로드는 v0 제외**(사람만 — 에이전트 산출물 첨부는 작업 패널/Drive 산출 경로와 함께 v1 결정).

## Slack·업계 비교

Slack 초기 파일 업로드는 서버 경유 단순 POST였고, 이후 외부 공유 링크의 인가 우회 사고(공개 S3 URL 추측 가능)로 프록시·만료 토큰 체계로 회귀했다. momo는 처음부터 "바이트는 우회(업로드), 접근은 프록시(다운로드)" 비대칭을 계약에 고정 — 업로드 대역폭은 Drive에 넘기되 읽기 인가는 PG/RLS가 소유한다. Mattermost는 로컬/S3 저장 옵션을 두는데, 우리의 S3 옵션은 v1 보류로 남긴다(OSS 배포 마찰은 인정하되 v0 범위 밖).

## Consequences

- Drive가 장애 도메인에 추가된다(업로드·다운로드 모두). 헬스 신호는 연결 상태 표면(U3 계열)의 후속.
- OSS 셀프호스트는 당분간 Google SA 필수 — README에 명시할 것. S3 호환 백엔드는 v1 재론(폐기 아님).
- e2e의 minio는 이 계약과 무관한 잔재인지 이식 배치에서 실측·판정(잔재면 제거 티켓).
