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

---

## 증보 1 — 첨부 capability URL의 same-origin 파생 (2026-08-26)

- Status: **Proposed** (성재 결재 대기). 근거: `docs/planning/research/2026-08-26-selfhost-product-model-review.md` 급소 3 · #1788 · #1790.

### 발단
로컬 보관소의 업로드 capability URL이 **부팅 시 고정된 env 값**으로 조립된다 — `server-rust/crates/momo-drive/src/local.rs:229`가 `format!("{}/__momo_stub/drive/uploads/{token}", self.base_url)`이고, `base_url`은 `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL`(부재 시 루프백 기본)이다.

그 결과 **터널/원격 주소로 붙은 클라이언트는 `http://localhost:<port>/...`로 PUT하라는 URL을 받는다** — 자기 자신의 루프백이므로 업로드가 실패한다. 그록봇 VM 셀프호스팅(claim + quick tunnel)이 정확히 이 배치다.

`--public-origin`이 이 키를 갱신하기는 한다(`scripts/self_host_env.sh:436-446`, #1696). 그러나 두 조건에서 결함이 살아 있다:
1. **claim 모드에서는 그 갱신 경로 자체가 도달 불가**(#1790 — 비밀번호 검증이 앞을 막는다).
2. **quick tunnel URL은 재기동마다 바뀐다** — env 고정 방식은 회전마다 "생성기 재실행 + 재기동"을 요구하므로 구조적으로 따라갈 수 없다.

### Decision — capability URL은 요청 오리진에서 파생한다
`MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL`에 **`same-origin` 센티널**을 도입하고, 그 값일 때 capability URL을 **요청 오리진에서 파생**한다. 절대 URL이 명시되면 **verbatim 유지**한다(ADR-0167과 대칭).

**이것은 새 설계가 아니라 이미 문서화된 의도의 구현이다** — 셀프호스트 엣지가 `/__momo_stub/*`를 api로 프록시하며 주석에 이렇게 적어 뒀다(`infra/rust/Caddyfile.local:36-42`):
> ADR-0169 — local archive PUT is **same-origin**. The capability URL the client is handed is `$origin/__momo_stub/...`

구현만 부팅 고정 env로 어긋나 있었다.

### 신뢰 경계 — ADR-0167을 준용한다
Host 스푸핑 우려는 **ADR-0167이 이미 Accepted로 정리했다**: 파생 기준은 신뢰 프록시(Caddy)가 정규화한 `X-Forwarded-Proto`/`Host`이고, 악의 Host로 오염된 광고는 **그 요청자 자신의 응답에만** 실린다.

capability URL도 정확히 같은 모양이다 — 광고되는 것은 **요청자 자신의 업로드 목적지**이므로, 오염의 피해자는 오염시킨 자신뿐이다(자해 외 피해자 없음). 따라서 **신규 ADR이 아니라 본 증보로 충분하다.**

### Consequences
- (+) **터널 URL 회전을 흡수한다** — 재생성·재기동 없이 원격 첨부가 성립한다. env 고정 방식이 구조적으로 못 하던 일이다.
- (+) 엣지 주석이 선언한 same-origin 계약과 구현이 일치한다.
- (+) #1790(claim 모드 유지보수 경로)의 수리는 여전히 필요하되, **더 이상 첨부 정상 동작의 전제가 아니다** — Centrifugo 오리진 등록을 위해 독립적으로 필요하다.
- (−) 절대 URL 명시 배포는 동작 불변이므로 마이그레이션 부담은 없으나, `same-origin` 센티널을 쓰지 않는 기존 env는 이득도 없다 — 생성기 기본값을 센티널로 옮길지는 구현 티켓의 판정.
