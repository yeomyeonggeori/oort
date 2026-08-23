# ADR-0169: 셀프호스트 파일 보관소 — 로컬 볼륨 백엔드 신설

- Status: **Accepted** (2026-08-23 성재 승인 — "수동 QA 제외 전부 승인" 위임 집행. 기안 같은 날, #1696)
- 관련: ADR-0168(M-2 picker — 클라 표면, 본 ADR과 분리 결정 명시), ADR-0004(provider 자격증명 비유입 — 본 백엔드는 외부 자격증명 자체가 없음), ADR-0166/0167(셀프서브 퍼널 계열)
- 실측 근거: 2026-08-23 재연 QA — D8 셀프호스트 첨부 업로드 503 `no-archive`(`claudedocs/uxui-qa-d8-20260823/`). 원인 좌표: `momo-drive` 백엔드가 `stub`(deployed env 부팅 거부)·`google`(SA+공유드라이브)뿐, `self_host_env.sh`가 `MOMO_DRIVE_*` 미생성 → 기본 `UnavailableDriveArchive`.

## Context

1. 셀프호스트 기본 배포에서 첨부를 켤 유일한 길이 Google Workspace 공유드라이브+SA 발급 — 오픈소스 셀프호스터·그록봇 원클릭 퍼널에 과도한 허들이고 SELF_HOST.md에 요구 명시도 없다(문서 갭).
2. 이 공백은 첨부 전 계열(M-1 표시 E2E·M-2 전송·U-3 라이트박스)의 셀프호스트 수용 검증을 원천 차단한다.
3. `DriveArchive` trait이 이미 백엔드 치환 경계다(stub/google 치환 실증) — 세 번째 구현의 자리가 마련돼 있다.

## Decision (요청)

1. **`MOMO_DRIVE_ARCHIVE_BACKEND=local` 신설**: 서버 프로세스가 지정 디렉터리(`MOMO_DRIVE_LOCAL_DIR`, compose 볼륨)에 콘텐츠를 저장하는 `LocalDriveArchive`. 기존 계약 전부 재사용 — 100MB 상한, 업로드 세션/서명 URL 의미, `DriveError` 표(403/404/413/503 매핑) 불변. 클라 변경 0.
2. **경로 안전**: 저장 키는 서버 생성 불투명 id만(사용자 입력 파일명 비사용 — 파일명은 메타로만). 디렉터리 이탈 원천 불가 단정 테스트.
3. **셀프호스트 기본값 = local**: `self_host_env.sh`가 `MOMO_DRIVE_ARCHIVE_BACKEND=local`+볼륨 경로를 생성, compose에 명명 볼륨 추가. pg_dump 백업 런북(T-4)에 보관소 디렉터리 동반 백업 문구 추가.
4. **stub 부팅 거부 불변**(인메모리 유실 방지) · google 백엔드 불변(호스티드 경로).

## 대안 기각

- S3 호환(minio 동봉): 컨테이너 1개·자격증명·수명주기 관리가 늘어 셀프서브 퍼널 취지 역행. 필요 시 후속 ADR.
- 문서만(현행+SELF_HOST 명시): 허들 자체가 남는다 — 최소안으로 기각(#1696 제안 2안).

## Consequences

- 셀프호스트 업그레이드 계약에 보관소 볼륨이 추가된다(플레이북 §백업 갱신 필요).
- 라이브(호스티드)는 무영향 — google 경로 그대로.
