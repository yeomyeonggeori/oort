# ADR-0121: 셀프호스팅 배포판과 온보딩 — "무료로 서버를 파고, 링크 하나로 초대한다"

- Status: **Accepted** (2026-07-15, 성재 — 권고안 D1-A/D2-A/D3/D4/D5-A/D6-A 전체 승인. S 배치는 웹 W 배치 랜딩 후 순차 발급)
- 관련: ADR-0002(compose 레이어링 — install/upgrade 경계 예약분 승계), ADR-0107(CI 신뢰 경계, queued)·ADR-0108(서버 스택, queued), ADR-0119(웹 — 초대 링크의 1차 랜딩 표면), ADR-0120(relay 등록 온보딩), ADR-0112 D4(초대→가입→첫 대화 여정), `research/15-platform-expansion/02`(4사 배포·초대·BM 비교), `docs/DEPLOY.md`·`docs/AWS_INTERNAL_ALPHA.md`(현행 수동 런북)
- 발단: 성재 발제(2026-07-15) "오픈소스지만 우리가 호스팅한 서버를 바탕으로 서버를 무료로 파고, 멤버를 초대하고, 기능을 사용하게" — 배포판의 제품화 결정.

## Context

1. **현행 배포는 운영자 수동 런북 단계다**: prod compose 8서비스 + SOPS 시크릿 + pgBackRest + GHCR 수동 발행 + preflight까지 뼈대는 동체급 표준을 충족하지만(`research/15-platform-expansion/00`), `install.sh`/`upgrade.sh`는 ADR-0002가 예약만 해둔 미구현 레이어다(`docs/adr/0002-docker-compose-layering.md:28,99-123`). "비개발자 친화 포장"은 없다.
2. **초대는 서버 안에서 끝난다**: invite hash 발급/redeem/revoke + 공개 `/v1/join`(`server/Sources/MomoServer/Routes/JoinRoutes.swift:20-57`)은 견고하나, 앱 미설치자·미가입자를 관통하는 링크(universal link) 표면이 없다. ADR-0119의 웹 합류가 이 관통의 1차 랜딩이 된다 — 성재의 "웹 먼저"와 맞물리는 지점.
3. **업계 검증 완료**(15-02): 온보딩 완성형은 Rocket.Chat(`go.rocket.chat/invite` — 링크 하나로 설치→서버 등록→가입 관통), BM 완성형은 Zulip(전부 permissive·전 기능 무료 셀프호스팅·수익은 호스팅/relay/지원), 반면교사는 Rocket.Chat 운영 복잡성(단일 노드도 replica set 강제)과 Element(기본 공개 서버 내장이 스토어 정지 유발). 단일 노드 상한 숫자 명시는 Mattermost 관행("2,000 동시까지 단일 서버").
4. **초대 보안 교훈**: Zulip CVE-2022-21706(재사용 초대 링크의 타 조직 가입) — momo invite hash는 워크스페이스 바인딩이 이미 있으나(`server/Migrations/003_onboarding.sql`), universal link 도입 시 만료·역할 바인딩·regenerate 계약을 명문화해야 한다.

## Options

### D1. 배포 포장 수준
- **A (권고, v1) — compose + `install.sh`/`upgrade.sh`**: ADR-0002 계약 그대로 — pinned image digest, 마이그레이션 순서, 롤백, preflight 통합. 대상 사용자는 "터미널을 열 수 있는 운영자 1명"(팀마다 1명이면 된다). 설치 문서는 "5분 설치" 기준으로 재작성하고 **단일 노드 상한을 숫자로 명시**(v1 문서 기준 "동시 수백 명" 보수 표기 — Mattermost 관행).
- B (v1.5) — 클라우드 마켓플레이스 원클릭 이미지(DO/Lightsail 등): A의 스크립트가 안정된 뒤 그 위에 포장. **순서상 후속** — A 없이 B를 먼저 만들면 upgrade 경로가 사유화된다.
- C — momo Cloud(Dawn 호스팅 managed): BM상 필요하지만 배포판 ADR의 범위 밖 별도 트랙. **범위 제외**(BM 절에서만 언급).

### D2. 초대 관통 (universal link)
- **A (권고) — `momo.app/i/<code>`형 Dawn 운영 단축 링크 + 웹 우선 랜딩**: 링크 하나가 ① 웹(ADR-0119)에서 즉시 합류(무설치 — 1차 경로) ② 앱 보유 시 딥링크(`momo://join?...`)로 앱 합류 ③ iOS 출시 후 스토어 유도까지 관통. Dawn이 단축 도메인만 운영하고 **초대 코드 검증·가입은 전부 대상 셀프호스트 서버에서** 일어난다(코드가 Dawn에 저장되지 않음 — 링크는 `서버 URL + hash`의 포장일 뿐).
- B — 서버 자체 도메인 링크만(`https://<server>/join/<code>`): Dawn 의존 0이라는 장점. 앱 딥링크 연결(universal link 도메인 검증)이 서버마다 불가능해 앱 관통이 죽는다. **웹 전용 폴백으로는 항상 지원**(A의 부분집합).
- C — QR 로그인(Matrix MSC4108류): v0 과설계. **보류.**

### D3. 초대 보안 계약 (D2와 한 몸)
- 만료 기본값(링크 초대 7일·이메일 48h 제안), 사용 횟수 상한, regenerate=일괄 무효화, 초대의 역할 바인딩(admin이 만든 링크도 member로만 가입) — Zulip 사고 교훈의 성문화. 기존 `invite_code` 스키마(max_uses/expires_at/revoked_at/role — `003_onboarding.sql:43-91`)가 전부 수용 가능, 계약 명문화만 필요.

### D4. relay 등록 온보딩 (ADR-0120 연동)
- install.sh가 마지막 단계에서 서버를 Dawn relay에 등록(서버 ID+공개키 발급)하고 실패해도 설치는 성공(푸시만 비활성 — 나머지 기능은 relay 없이 완전 동작). 오프그리드 설치를 1급으로 지원한다는 선언.

### D5. BM 경계
- **A (권고) — Zulip 모델**: 셀프호스팅은 전 기능 무료·기능 게이팅 없음(permissive 하드 룰과 유일 정합). 수익원은 ① momo Cloud(managed 호스팅) ② relay 대량 사용·SLA ③ 지원/컨설팅. **기능을 파는 게 아니라 운영을 판다.**
- B — 오픈코어(EE 폴더): Mattermost/Rocket.Chat 모델 — momo의 신뢰 포지셔닝·permissive 원칙과 충돌. **기각.**

### D6. 앱의 기본 서버 정책
- **A (권고) — 기본 공개 서버 비내장**: 모든 클라이언트(웹 랜딩 제외)는 "서버 URL 입력/초대 링크"가 루트. 데모가 필요하면 읽기 전용 데모 서버를 명시 분리(Element Play 정지 교훈 — UGC 모더레이션 책임 회피).

## Decision (Proposed 권고안)

D1-A(→B 후속) + D2-A(B는 상시 폴백) + D3 + D4 + D5-A + D6-A.

## 파생 배치 후보 (Accepted 후 발급)

| 후보 | 내용 | 프로파일 | 의존 |
|---|---|---|---|
| S-1 | `infra/prod/install.sh`/`upgrade.sh` + preflight/롤백 통합 + "5분 설치" 문서(단일노드 상한 명시) | infra/docs | 없음 (ADR-0002 계약) |
| S-2 | 초대 보안 계약 구현(만료 기본값·role 바인딩 검증·regenerate) + 발급 UI 연동 노트 | swift/runtime-db | 없음 |
| S-3 | 웹 합류 랜딩(`/join/<code>`) — ADR-0119 W-5와 동일 티켓으로 합류 | web | 0119 W-2/W-3 |
| S-4 | Dawn 단축 링크 서비스(`momo.app/i/<code>`) + 앱 universal link 검증 | infra | S-3, (앱 관통은 iOS 시점) |
| S-5 | relay 등록 스텝(install.sh 통합, 실패 허용) | infra | ADR-0120 P-3 |

## Consequences

- (+) "서버 파기"가 런북에서 제품이 된다 — 초대 링크 하나로 무설치 합류까지의 전 관통이 성립(웹 우선 결정과 정합).
- (+) BM이 신뢰 포지셔닝을 강화하는 방향으로 고정된다(기능 게이팅 없음) — 커뮤니티 반발 리스크 원천 차단.
- (+) 오프그리드(relay 미등록) 설치가 1급 — 폐쇄망 수요 수용.
- (−) Dawn 운영 표면 확대: 단축 링크 도메인 + relay(0120) — 소규모지만 상시 운영 의무.
- (−) upgrade 경로의 하위 호환 부담이 공식화된다(마이그레이션 순서 보장은 이미 규율 — `scripts/migrate.sh`).
- 보류: 마켓플레이스 이미지(D1-B), momo Cloud(별도 트랙), Android 관통(FCM 이후).
