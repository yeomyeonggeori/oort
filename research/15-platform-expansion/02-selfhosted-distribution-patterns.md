# 15-02 · 셀프호스팅 메신저 4종 비교 — oort 배포 모델 선행 사례

> Planning ID: `PLN-20260715-02` · 수집: 2026-07-15 deep-research (공식 문서/블로그 우선)
> 용도: "사용자가 자기 서버를 무료로 파고, 멤버를 초대하고, iOS/웹에서 자기 서버 URL로 접속" 모델의 업계 근거. 바이블 05장의 원자료. 월 비용은 사양 기반 추정치(Hetzner/DO 2026 요금).

## 0. 핵심 결론

네 제품(Mattermost, Rocket.Chat, Zulip, Matrix/Synapse+Element) 모두 동일한 구조적 결론: **(a)** 모바일 푸시는 "셀프호스트 서버 → 벤더 운영 push relay → APNs/FCM" 3-hop이 유일한 해법(APNs 키는 앱 배포자만 보유), 프라이버시는 id-only 페이로드 + 클라 fetch. **(b)** 모바일 온보딩은 스토어 단일 앱 + 서버 URL 입력 + universal link 초대가 표준이며 이 방식 자체의 앱 심사 거절 사례 없음. **(c)** 웹은 서버가 같은 도메인에서 직접 서빙하는 쪽이 마찰 최소(Element만 분리 배포). **(d)** 1~50인 팀은 2~4GB RAM 단일 노드로 충분, 멀티 리전은 단일 워크스페이스 규모에서 아무도 안 한다.

## 1. 제품×주제 비교표

| 주제 | Mattermost | Rocket.Chat | Zulip | Matrix/Synapse+Element |
|---|---|---|---|---|
| 배포판 | Docker Compose(평가용), K8s Operator/Helm(프로덕션 권장), .deb | Docker Compose(공식), **MongoDB replica set 필수**, Helm | 전용 install 스크립트(서버 전유 전제), docker-zulip | pip/deb/Docker + PostgreSQL; 사실상 표준은 커뮤니티 ansible |
| 최소 사양(1~50인) | 소규모 단일서버 (1~2천 동시도 4–8vCPU/16–32GB 단일) | 1vCPU/2GB/40GB (≤50 동시) | 1CPU/2GB(+swap) | ~2GB (연방 룸 조인 시 폭증) |
| 월 비용(추정) | $6–24 | $6–24 | $5–15 | $5–15 |
| 푸시 relay | HPNS(미국/독일) — **유료 플랜**; 무료는 TPNS(SLA 없음) | gateway.rocket.chat — 등록 필수, **Community 월 1만 건** | push.zulipchat.com — 등록제, **10인 초과 유료**($3.50/인/월), OSS/학술 무료 | Sygnal — **앱 벤더 운영**, 무료·무제한 |
| 푸시 프라이버시 | generic/full/**id-only(유료 게이팅)** | 내용 숨김 토글(id-only+fetch) | **Server 12+: E2E 암호화 봉투**(relay/Apple/Google 열람 불가) | **event_id_only** + 클라 fetch |
| 모바일 온보딩 | "Add a Server" URL, v2부터 멀티서버 | "Join a workspace" URL + go.rocket.chat universal link + rocketchat:// | 서버 URL 입력 | Element X: 기본 matrix.org + 서버 변경(.well-known), QR 로그인(MSC4108) |
| 웹 클라이언트 | 서버 동일 도메인 서빙, 데스크톱=Electron | Meteor 서버 서빙, Electron | 서버 서빙, Electron(코드 공유) | **분리 배포**(정적 SPA, 홈서버 동일 도메인 금지 권고) |
| 파일 저장 | 로컬 FS / S3호환(MinIO) / NFS | GridFS(기본)/로컬/S3/GCS | LOCAL_UPLOADS_DIR / S3+로컬캐시+**썸네일 워커** | 로컬 media store + S3 provider 모듈 |
| 웹훅 인증 | incoming=비밀 URL, outgoing=token 대조 | /hooks/{id}/{token} + V8 격리 스크립트 | bot api_key 쿼리 | AS **as_token/hs_token 상호 인증** + YAML 등록 |
| 라이선스 | 오픈코어(AGPLv3 소스+MIT 바이너리+enterprise SAL) | 오픈코어(CE=MIT + ee/ 상업) | **전부 Apache 2.0, 게이팅 없음** | Synapse **AGPLv3**(2023-12~), 클라 SDK Apache 2.0 |
| 단일노드 상한 안내 | **~2,000 동시 사용자** 명문화; HA는 같은 DC 필수 | 수백 동시, 이후 EE 마이크로서비스 | 수백 DAU, 수천부터 Tornado 샤딩 | workers 수평 확장(단일 PG) |

## 2. 주제별 상세

### 2-1. 푸시 — 전원이 같은 구조, 과금만 다르다

구조적 이유: APNs 인증서/키는 App Store 배포자만 보유 → 셀프호스트 서버는 벤더 운영 relay 경유가 유일 경로. Zulip 문서: "Google과 Apple의 보안 모델상 셀프호스트 서버가 직접 모바일 알림을 보낼 수 없다."

- Mattermost: 서버→HPNS(push.mattermost.com/hpns-de)→APNs/FCM. 자체 빌드 앱이면 자체 push proxy(MPNS) 운영 가능. id-only(`id_loaded`)는 유료 플랜 한정 — 커뮤니티 비판 지점. https://docs.mattermost.com/administration-guide/configure/push-notification-server-configuration-settings.html · https://docs.mattermost.com/deployment-guide/mobile/host-your-own-push-proxy-service.html
- Rocket.Chat: 워크스페이스 클라우드 등록+약관 동의 필수. Community 월 10,000건 — 2020년 제한 도입 때 반발(issue #17461)과 우회 게이트웨이(Planet.Chat 등) 생태계 발생. https://docs.rocket.chat/docs/push
- Zulip: `manage.py register_server` 등록제 + rate limit(1000 req/min). **Server 12+부터 XSalsa20-Poly1305 E2E 봉투로 bouncer/Apple/Google 전부 내용 열람 불가.** 10인 이하 무료, Basic $3.50/인/월, OSS/학술/커뮤니티 무료. https://zulip.readthedocs.io/en/stable/production/mobile-push-notifications.html · https://zulip.com/plans/
- Matrix: 홈서버→푸시 게이트웨이(`POST /_matrix/push/v1/notify`)→APNs/FCM. 게이트웨이는 앱 벤더 운영(포크 앱은 자체 Sygnal 필수). event_id_only 포맷. 무료·무제한. 단 게이트웨이 운영자는 pushkey/활동 패턴은 본다. https://spec.matrix.org/latest/push-gateway-api/ · https://github.com/element-hq/sygnal

### 2-2. 모바일 "서버 URL" 온보딩과 앱 심사

- Rocket.Chat 딥링크가 가장 발달: `https://go.rocket.chat/invite?...`(앱 미설치→스토어→설치→서버 등록→가입 관통), room/서버 추가 링크, `rocketchat://` 스킴. https://developer.rocket.chat/docs/deep-linking
- Mattermost v2: 멀티서버 동시 접속(서버 추가가 1급). https://docs.mattermost.com/end-user-guide/preferences/connect-multiple-workspaces.html
- Element X: .well-known 디스커버리 + QR 로그인(MSC4108, MAS 필요). https://matrix.org/blog/2024/10/29/matrix-2.0-is-here/
- 심사: "서버 URL 입력" 자체의 거절 사례 미확인. 유일 대형 사고 = 2021-01 Google Play의 Element 일시 정지 — 원인은 **기본 공개 서버(matrix.org)의 UGC 모더레이션**, 곧 복구. 교훈: 리스크는 URL UX가 아니라 기본 서버 콘텐츠 책임. Apple 실무는 리뷰어용 데모 서버/계정 제공 관례(Guideline 2.1). https://element.io/blog/element-on-google-play-store/

### 2-3. 웹 클라이언트

- Mattermost/Zulip/Rocket.Chat: 서버가 같은 도메인에서 SPA 직접 서빙 — "설치하면 웹까지 끝". 데스크톱은 셋 다 Electron(Zulip은 웹앱 코드 공유 명시).
- Element Web: 정적 SPA 분리 배포 + `config.json` 기본 홈서버. README가 홈서버 동일 도메인 회피 권고(XSS 격리) — 근거는 **사용자 업로드 콘텐츠와 앱의 오리진 분리**로 한정 적용 가능. https://github.com/element-hq/element-web/blob/develop/docs/install.md

### 2-4. 파일 저장

- Mattermost: 로컬/S3호환(MinIO)/NFS. https://docs.mattermost.com/configure/file-storage-configuration-settings.html
- Zulip: 기본 LOCAL_UPLOADS_DIR(단일 서버 전용) ↔ S3(+로컬 캐시). **썸네일: 업로드 즉시 원본 저장 후 전용 워커가 포맷×사이즈 조합 비동기 생성** — 가장 잘 문서화된 파이프라인. https://zulip.readthedocs.io/en/latest/production/upload-backends.html · https://zulip.readthedocs.io/en/latest/subsystems/thumbnailing.html
- Synapse: 로컬 media store 1차 + S3 storage provider(비동기 오프로드). https://github.com/matrix-org/synapse-s3-storage-provider
- 공통: 파일 접근은 인증 API 경유가 기본(공개 URL 직결 아님).

### 2-5. 초대 모델

- Zulip(가장 정교): 1회용 이메일 vs 재사용 링크 구분, 기본 10일 만료, 역할 바인딩, 관리자 취소/재발송. **CVE-2022-21706: 재사용 링크로 타 조직 가입 가능했던 사고** → 초대 토큰의 조직·역할 바인딩 검증 필수 교훈. https://zulip.com/help/invite-new-users · https://github.com/zulip/zulip/security/advisories/GHSA-6xmj-2wcm-p2jc
- Mattermost: 이메일 48h/1회용, 팀 링크 무기한 + regenerate 일괄 무효화. Rocket.Chat: universal link 관통이 강점. Matrix: registration token.

### 2-6. Presence

- Zulip: **REST 폴링 + 증분(last_update_id)** — "정확한 presence는 채팅앱에서 가장 비싼 기능 중 하나"(문서 명시). 비용 예측 가능, 셀프호스팅 친화. https://zulip.com/api/update-presence
- Matrix: 연방 조합 폭발 — 주요 배포는 꺼둠(`presence.enabled: false`), matrix.org도 비활성화 이력. https://github.com/matrix-org/synapse/issues/9478
- Mattermost: 연결+활동 기반 단순 처리(전용 최적화 문서 없음 = 팀 규모에선 문제가 안 된다는 방증). Rocket.Chat: 내장 → 규모 시 EE 마이크로서비스 분리.

### 2-7. 멀티 리전

**단일 팀/워크스페이스 규모에서 멀티리전 active-active를 지원하는 제품 없음.** Mattermost HA는 동일 DC 명문화, Zulip은 warm standby 수동 승격(`pg_ctl promote`)이 공식 답, Rocket.Chat 마이크로서비스도 단일 클러스터 전제, Matrix "분산"은 서버 간 연방이지 한 홈서버의 멀티리전이 아님. 지역성은 relay 엔드포인트 수준만(Mattermost 푸시 미국/독일).

### 2-8. 라이선스/BM

- Mattermost: 오픈코어, LDAP/SAML/HA 유료, 경계는 `einterfaces`. https://docs.mattermost.com/product-overview/faq-license.html
- Rocket.Chat: CE=MIT + `ee/` 상업. Zulip: **전부 Apache 2.0 — 4사 중 가장 깨끗한 FOSS**, 수익=클라우드+push 플랜+지원. https://zulip.com/plans/
- Matrix: Synapse AGPLv3(Element 상업 이중) — **oort 하드 룰(AGPL 백본 금지)상 코드 차용 금지, 참조만.** https://element.io/blog/element-to-adopt-agplv3/

## 3. oort가 차용할 패턴 vs 피할 패턴

### 차용
1. **push relay는 oort가 직접 운영(구조적 필연)** — Zulip 모델: 서버 등록제 + rate limit + id-only(또는 E2E 봉투) + 클라 fetch. ADR-0004의 "자격증명 비유입"과 같은 결의 "content 비유입".
2. **온보딩 = 스토어 단일 앱 + 서버 URL 루트 + universal link 초대**(Rocket.Chat 완성형) + 멀티서버 데이터 모델 선반영(ADR-0117 합류). QR 로그인은 초기 과설계.
3. **웹은 서버 동일 도메인 직접 서빙** + 첨부만 오리진 격리(서브도메인/CSP).
4. **초대 보안 3종**: 만료 기본값 + regenerate/revoke + 워크스페이스·역할 바인딩 검증(oort invite hash는 이미 워크스페이스 바인딩 — `003_onboarding.sql`).
5. **presence는 비용 예측 가능한 설계**(Zulip 폴링+증분 참조, oort는 Centrifugo presence 활용 + 느슨한 offline threshold).
6. **BM = Zulip 모델**: 코어 전부 permissive·완전 기능 무료 셀프호스팅, 수익은 relay/호스팅/지원.
7. **단일 노드 상한을 숫자로 명시**(Mattermost 방식) — HA 후순위 정당화.
8. 파일: 백엔드 스위치 인터페이스 + Zulip 워커식 썸네일 파이프라인(Drive 결정은 동결 계약 승계).

### 회피
1. **푸시 유료 게이팅**(Mattermost HPNS/id-only 유료, Rocket.Chat 월 1만 건) — 반발·우회 생태계 전례.
2. **AGPL 코드 차용**(Synapse/Sygnal/Dendrite).
3. **운영 복잡성 강제**(Rocket.Chat의 단일 노드 MongoDB replica set) — oort PG 단일 의존 유지.
4. **클라-서버 분리 배포 강제**(Element Web) — 배포물 2배.
5. **기본 공개 서버 내장**(Element Play 정지 교훈) — oort 앱은 "자기 서버 입력"이 1급, 데모는 읽기 전용.

## 4. 남은 불확실성

- 월 비용은 추정치 — 과금 벤치마크 시점에 특정 클라우드 요금표로 재계산.
- Mattermost HPNS의 플랜 포함 범위는 개편이 잦음 — oort 과금 설계 시 재확인.
- Rocket.Chat 파일 백엔드 목록은 통용 사실이나 이번 조사에서 원문 페이지 미확인.
- App Store의 셀프호스트 메신저 거절 공식 기록 없음 — "확인되지 않음"으로 유지.
