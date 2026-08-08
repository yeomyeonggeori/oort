# GWS Internal Consent 셋업 런북 — GCP 프로젝트 · OAuth Internal · SA · 공유 드라이브

> **티켓:** MOMO-323 · **마일스톤:** M2 · 근거: `research/13-redesign/03` §2·§5, 정본 스펙 `research/11-agent-runtime/12-google-workspace-connector-v0.md`(MOMO-122) + `13-google-workspace-enterprise-admin-v0.md`(MOMO-123).
> **대상:** oort를 self-host하는 배포 조직의 운영자 1인. Google Workspace 조직 + 관리자(또는 공유 드라이브 생성 권한자) 접근이 필요하다.
> **핵심 전제:** GCP 프로젝트를 **배포 조직이 직접 소유**하고 OAuth consent screen을 **Internal**(같은 Workspace 조직 사용자 한정)로 설정하면 Google 앱 검증·CASA 평가가 **면제**된다. 이 런북의 모든 절차는 이 전제 위에서만 유효하다 — External consent로 바꾸는 순간 restricted scope에 검증/CASA 부담이 생기며, 그 경로는 이 런북 범위 밖이다.
> 사람이 직접 해야 하는 단계는 `[manual]`로 표기한다(AGENTS.md §3 검증 등급). momo/Codex는 이 단계들을 대신 완료한 것처럼 기록하면 안 된다.

---

## 0. 결과물 (이 런북을 끝내면 손에 있는 것)

| 산출물 | 소비처 |
|---|---|
| 배포 조직 소유 GCP 프로젝트 (Drive API enabled) | 모든 GWS 연동 |
| OAuth consent screen = **Internal** | per-user OAuth 모드 A (MOMO-122) |
| (선택) OAuth 클라이언트 ID/secret | 모드 A connect 플로우 |
| 서비스 계정(SA) + 시크릿 저장소의 credential | 모드 B workspace archive (MOMO-320/321) |
| 공유 드라이브 `momo — {workspace}` + SA **Content Manager** 멤버십 | 모드 B 저장소/인덱싱 크레덴셜 |
| `service_account_boundary` 기록값 (`boundary_kind = shared_drive_member`) | MOMO-123 boundary + MOMO-320 구현 |

**모드 요약(정본은 MOMO-122/123):** A = per-user OAuth `drive.file`(기본, 불변) · B = 공유 드라이브 1개 + SA 멤버십(**DWD 아님** — SA는 자기 자신으로서 그 드라이브 1개만 접근) · C = DWD overlay(≤10인 팀엔 과잉, 이 런북 범위 밖).

## 1. 사전 체크

- [ ] 배포 조직이 Google Workspace를 사용 중이고, 조직 구성원 계정으로 GCP 콘솔(`console.cloud.google.com`)에 접근 가능하다.
- [ ] GCP 프로젝트 생성 권한(조직 정책에 따라 관리자 요청 필요할 수 있음)이 있다.
- [ ] 공유 드라이브 생성 권한이 있다(Workspace 에디션/관리자 설정에 따라 다름 — 막혀 있으면 Workspace 관리자에게 생성 위임).
- [ ] 시크릿 저장 경로가 준비돼 있다(SOPS+age 또는 배포 환경의 secret manager — `docs/SECRETS_BACKUP_RUNBOOK.md`). **SA 키/OAuth secret을 리포·`.env*`에 커밋하는 것은 금지**(AGENTS.md §5).

## 2. GCP 프로젝트 + API

1. `[manual]` GCP 콘솔에서 새 프로젝트 생성 — 예: `momo-{org}`. **반드시 배포 조직(Workspace 조직) 하위**로 생성한다(No organization 아님). 조직 소속이 아니면 consent screen에서 Internal 옵션 자체가 나오지 않는다.
2. `[manual]` APIs & Services → Library에서 **Google Drive API** 활성화. (per-user OAuth로 Gmail/Calendar 소스까지 쓸 계획이면 Gmail API, Google Calendar API도 함께.)

## 3. OAuth consent — Internal

3. `[manual]` APIs & Services → OAuth consent screen에서 **User type = Internal** 선택 후 앱 이름(`momo`), 지원 이메일, 개발자 연락처를 입력하고 저장. Internal이므로 scope 등록은 동작에 필수는 아니지만, oort가 실제 요청하는 scope(모드 A: `drive.file` 등)를 기재해 두면 조직 감사에 유리하다.
   - 확인: consent screen 요약에 "User type: Internal"이 보여야 한다. 이 상태에서는 Google 검증 제출 버튼/CASA 요구가 없다.
4. `[manual]` (모드 A를 쓸 때만) APIs & Services → Credentials → Create credentials → **OAuth client ID** (Web application). Redirect URI는 oort 서버의 OAuth 콜백(배포 도메인 기준, 예: `https://momo.example.com/v1/connectors/google/callback` — 구현 티켓에서 확정). client id/secret은 시크릿 저장소로만 보관.

## 4. 서비스 계정 (모드 B — workspace archive)

5. `[manual]` IAM & Admin → Service Accounts → Create service account — 예: `momo-archive@momo-{org}.iam.gserviceaccount.com`. GCP 프로젝트 수준 IAM role은 **부여하지 않아도 된다**(Drive 접근은 IAM이 아니라 공유 드라이브 멤버십으로 나온다).
   - **하지 말 것:** Admin console API Controls의 domain-wide delegation에 이 SA client id를 등록하지 마라. 모드 B는 **DWD가 아니다** — SA는 자기 자신으로서만 동작한다(MOMO-123 §6 `shared_drive_member`).
6. `[manual]` SA 키 발급: Service account → Keys → Add key → JSON. 다운로드 즉시 시크릿 저장소(SOPS/age 또는 secret manager)에 넣고 **로컬 다운로드 파일은 삭제**한다. oort에는 `credential_storage_ref`(경로 참조)만 기록되며 키 바이트는 어떤 DB/픽스처/로그에도 저장되지 않는다(MOMO-123 boundary). 배포 환경이 지원하면 keyless(workload identity federation)가 우선이고, static key를 쓰면 회전 주기(예: 90일)와 삭제 경로를 함께 기록한다.

## 5. 공유 드라이브 + SA 멤버십

7. `[manual]` Google Drive에서 공유 드라이브 생성 — 이름 규약: `momo — {workspace}` (레이아웃 정본: `research/13-redesign/03` §3, `channels/{channel_slug}/YYYY/MM/`는 oort가 생성).
8. `[manual]` 공유 드라이브 → Manage members → SA 이메일(`momo-archive@…gserviceaccount.com`)을 멤버로 추가하고 역할을 **Content Manager(콘텐츠 관리자)** 로 지정. Manager(관리자) 권한은 주지 않는다 — 멤버십/드라이브 설정 변경 권한은 사람에게만.

## 6. oort 쪽 기록 (배포 설정)

9. `[manual]` 아래 값을 배포 시크릿/설정으로 기록한다(소비 구현은 MOMO-320 — 그 전까지는 준비 상태로 보관):

| 값 | 예시 | 비고 |
|---|---|---|
| GCP project id | `momo-{org}` | |
| SA email | `momo-archive@momo-{org}.iam.gserviceaccount.com` | redacted 형태로 boundary에 기록 |
| `credential_storage_ref` | `secret://google-workspace-enterprise/{install}/shared-drive-archive-sa` | 키 바이트 금지, 참조만 |
| `shared_drive_id` | Drive URL의 `0A…` id | 드라이브 1개만 |
| `boundary_kind` | `shared_drive_member` | MOMO-123 §6 제3모드 |
| `shared_drive_role` | `content_manager` | |
| scope 계획 | ~~`drive.file`~~ → **`drive.readonly`(SA만, 2026-07-17 실증 확정)** | 실증: `drive.file` 토큰으로 `drives.get`/`files.list`가 403(insufficient scopes) — 공유 드라이브 메타·목록 접근에 불충분. SA 한정 `drive.readonly` 채택(서버 `GoogleDriveSABackend`도 동일 scope). Internal consent라 검증 부담 없음 |

### 6.1 dawn 배포 기록 (2026-07-17, 성재 수행)

GCP project `momo-dawn`(dawn.kim 조직 하위) · SA `momo-archive@momo-dawn.iam.gserviceaccount.com` · 키는 운영자 로컬 시크릿 경로(레포 밖, 0600) · 공유 드라이브 `momo-dawn` = `0AHKTseTvG-mpUk9PVA`(SA=콘텐츠 관리자) · `boundary_kind=shared_drive_member` · scope=`drive.readonly`(§6 실증). 참고: 조직 기본 정책 `iam.disableServiceAccountKeyCreation`(legacy+managed, Google secure-by-default)이 키 발급을 차단 — momo-dawn 프로젝트 한정 상위 정책 재정의로 해제(조직 정책 관리자 역할 필요).

## 7. 검증 체크리스트

### 7.1 oort-hosted read-only Drive MCP (MOMO-457)

서버에는 repo 밖 시크릿 경로의 `MOMO_DRIVE_SA_KEY_PATH`, 대상 1개인 `MOMO_DRIVE_SHARED_DRIVE_ID`, `MOMO_DRIVE_BACKEND=google`을 주입한다. 키 JSON 원문은 `.env*`, DB, fixture, audit evidence에 복사하지 않는다. `scripts/verify_drive_mcp.sh`는 `MOMO_DRIVE_BACKEND=stub`으로 계약만 검증하며 Google에 접속하지 않는다. 실제 SA smoke는 아래 `[manual]` 절차로만 evidence를 남기고, 응답 본문이나 access token/키 바이트는 evidence에 첨부하지 않는다.

10. `[manual]` SA credential로 1회 스모크(런타임 구현 전이므로 수동, 결과는 runtime-unverified 해소 evidence로 기록):
    - SA로 access token 발급(scope `https://www.googleapis.com/auth/drive.file`) 후
      `GET https://www.googleapis.com/drive/v3/drives/{shared_drive_id}` → 200이면 멤버십/크레덴셜 OK.
    - `GET https://www.googleapis.com/drive/v3/files?corpora=drive&driveId={shared_drive_id}&includeItemsFromAllDrives=true&supportsAllDrives=true` → 200 + 항목 나열.
    - `GET https://www.googleapis.com/drive/v3/changes/startPageToken?driveId={shared_drive_id}&supportsAllDrives=true` → 200이면 MOMO-321 폴러 전제 확인.
    - `drive.file` scope로 위 호출이 403이면: SA만 `drive.readonly`로 재시도하고, 채택 시 scope inventory에 justification을 남긴다(Internal consent라 검증 부담은 없음 — oort 자체 최소권한 정책 문제).
11. 롤백/철회 경로 확인(실행은 하지 않음): 공유 드라이브 멤버에서 SA 제거 `[manual]` → 키 비활성/삭제 `[manual]` → oort boundary `status=revoked` → 그 드라이브에서 파생된 인덱스 행 삭제(MOMO-122 §2 carve-out은 revocable이 계약이다).

## 8. 운영 주의

- **한도(공식, ≤10인 여유):** 공유 드라이브당 500k 아이템 · 멤버 600 · 업로드 사용자당 750GB/일 · API 쿼터 프로젝트당 1M units/min.
- ⚠️ Google이 무료 임계 초과 API 사용량의 **2026년 과금 전환을 예고**(90일 노티) — 배포 조직 결제 알림을 켜 두고 워처를 유지한다(`research/13-redesign/03` §3).
- 이 런북은 배포 조직마다 1회. 같은 조직의 워크스페이스가 늘면 §5~§6(드라이브+boundary)만 워크스페이스별로 반복한다.

## 9. 참조

- OAuth consent screen 설정(Internal/External): https://support.google.com/cloud/answer/10311615
- OAuth 앱 검증 요건(Internal 면제): https://support.google.com/cloud/answer/13463073
- Drive API scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- 공유 드라이브 생성/멤버 역할: https://support.google.com/a/answer/7212025
- 서비스 계정 키 관리 모범사례: https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys
