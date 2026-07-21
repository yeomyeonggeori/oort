# ADR-0127: 첨부 저장 어댑터 — 셀프호스트용 S3 호환 백엔드

- Status: **Proposed** (2026-07-21, Fable 기안 — 성재 승인 대기. 오픈소스화 우선순위 2)
- 관련: MOMO-474(Drive workspace archive — 현행), ADR-0121(셀프호스트 배포 — D5 Zulip 모델), docs/planning/2026-07-21-opensource-cowork-diagnosis.md §4-1
- 발단: 셀프호스팅 진단 — 첨부 저장이 `GoogleDriveArchiveClient` 유일 실구현이라 Google Workspace 없는 셀프호스터는 첨부 기능 자체가 불가(하드 블로커).

## Context

1. 서버는 이미 `DriveArchiveClient` 프로토콜(세션 발급→직송 PUT→complete→메타)로 저장 계층이 추상화돼 있고, 실구현은 Google Drive 1종 + Unavailable/Stub. REST 계약(AttachmentRoutes)·capability URL 경계·100MB 상한은 백엔드 불문 동일.
2. Dawn 내부 운영은 Drive(공유드라이브+SA)가 확정(2026-07 성재) — 이 결정은 바꾸지 않는다. 셀프호스터에게 **추가 선택지**를 주는 가산 결정.
3. 업계 수렴: Mattermost/Zulip/Rocket.Chat 전부 S3 호환(+로컬FS)이 셀프호스트 표준. MinIO가 사실상 셀프호스트 S3 대체재.

## Decisions

### D1. 백엔드 선택지
- **A (권고) — S3 호환 어댑터 1종 추가**(AWS S3·MinIO·R2·B2 전부 커버): `S3ArchiveClient` — presigned PUT/GET으로 기존 "직송 업로드·capability URL" 문법이 그대로 성립(서버가 바이트를 중계하지 않는 기존 경계 유지). env로 endpoint/region/bucket/자격증명 주입, 시크릿은 기존 .env 규율.
- B — 로컬 파일시스템 어댑터: 직송 PUT 문법이 깨지고(서버 경유 업로드) 다중 레플리카에서 공유 볼륨 요구. compose 단일 노드에선 유효하나 v0 범위 밖 — **보류(v1, 수요 확인 후)**.
- C — 백엔드 N종 동시: 유지비 과대. **기각.**

### D2. 선택 방식
- **A (권고)** — 부팅 env `MOMO_ARCHIVE_BACKEND=drive|s3`(기본 drive, 미설정+미자격 시 기존 Unavailable fail-closed 유지). 워크스페이스별 혼합은 하지 않는다(운영 단순성 — Mattermost 동일).

### D3. 계약 불변
- REST/OpenAPI/클라이언트 무변경 — 어댑터는 서버 내부 결정. capability URL 비유출·ephemeral 세션·100MB 상한·RLS 경계 전부 동일. verifier: 기존 `verify_attachment_upload.sh`에 S3 백엔드 모드(MinIO 컨테이너) 추가.

## Consequences
- (+) 셀프호스트 하드 블로커 해소 — compose에 MinIO 옵션 프로파일 1개면 "설치 즉시 첨부 동작".
- (+) Dawn 운영(Drive)과 오픈소스 배포(S3)의 분리가 env 1줄 — 코드 분기 최소.
- 파생(Accepted 시): **MOMO-521**(엔진 — S3ArchiveClient+presign+env 선택+verifier MinIO 모드) · **MOMO-522**(infra — compose minio 프로파일+DEPLOY.md 갱신).
