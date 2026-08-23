# #1696 셀프호스트 로컬 파일 보관소 패킷 (ADR-0169 집행)

> Status: `ready`(게이트=ADR-0169 Accepted — 충족 2026-08-23) · Planner: Fable · Integrator: momo-main
> 트랙=engine(base=origin/track/engine, T-9=462efd67 포함) · 워커=grok · 검수=Fable

## 계약 (ADR-0169 Decision 전문이 정본 — 이슈 #1696 본문에 전문 인용됨)

1. **`LocalDriveArchive` 신설**(`server-rust/crates/momo-drive`): `MOMO_DRIVE_ARCHIVE_BACKEND=local` + `MOMO_DRIVE_LOCAL_DIR`. `DriveArchive` trait 구현 — 기존 계약 전부 재사용: 100MB 상한, 업로드 세션/서명 URL 의미(stub의 in-process 업로드 라우트 패턴 참조 — `accepts_stub_uploads` 동형의 local 업로드 수용), `DriveError` 표(403/404/413/503) 불변. **클라 변경 0.**
2. **경로 안전**: 저장 키=서버 생성 불투명 id만(사용자 파일명은 메타로만 — 디스크 경로에 비유입). 디렉터리 이탈 원천 불가 단정 테스트(../ 조작·절대경로·심링크 거부).
3. **deployed env에서 허용**(stub과 달리 재시작 생존이므로 부팅 거부 없음). 디렉터리 미존재 시 부팅에서 생성, 쓰기 불가면 부팅 거부(명확한 메시지).
4. **생성기**: `self_host_env.sh`가 `MOMO_DRIVE_ARCHIVE_BACKEND=local`+경로 기본 생성, compose(셀프호스트 계열)에 명명 볼륨 추가. 기존 env 재생성 경로 정합.
5. **문서**: SELF_HOST.md(보관소 절 신설 — 백업 대상 명시), SELF_HOST_AGENT.md 동기, pg_dump 런북에 보관소 디렉터리 동반 백업 1줄. check_docs_commands 그린.

## AC
- 단위: 경로 안전(이탈 거부 3계열)·저장/조회/삭제 왕복·상한 초과 413.
- 통합(pg 스모크 스타일): 업로드 세션 생성→PUT→complete→content GET 왕복이 local 백엔드로 성립. 미구성(기본값 무설정) 503 no-archive 불변 회귀 가드. google/stub 경로 비접촉 단정.
- 생성기 셸 테스트(scripts/tests/ 관례).

## 함정
- 스트리밍/청크는 v0 비목표 — stub과 같은 바이트 수용이면 족하다. S3·마이그레이션 도구 비목표.
- schema·마이그레이션 비접촉(보관소는 파일시스템, DB는 기존 attachment 행 그대로). 시크릿 커밋 금지.
- worker는 PR(base=track/engine) 생성 후 정지 — merge/close 금지. docker 게이트=오케스트레이터.
