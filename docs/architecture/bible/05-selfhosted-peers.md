# 05 · 셀프호스팅 계열의 패턴 — momo와 같은 체급이 푼 방법

> 최종 대조: 2026-07-15 · 출처: Mattermost/Rocket.Chat/Zulip/Matrix 공식 문서(각 절 링크) · 상세 비교표는 `research/15-platform-expansion/` 참조

Slack/Discord(03·04장)는 "우리가 커지면 만날 문제"를 가르쳐 준다. 이 장의 네 제품 — Mattermost, Rocket.Chat, Zulip, Matrix(Synapse+Element) — 은 **momo가 지금 당장 풀어야 하는 문제**를 이미 푼 동체급 선례다: 사용자가 자기 서버를 파고, 멤버를 초대하고, 스토어 앱과 웹에서 자기 서버 URL로 접속하는 모델.

네 제품이 서로 다른 스택으로 **완전히 같은 구조적 결론**에 도달한 지점이 4개 있다. 수렴한 답은 업계 정답으로 간주해도 된다.

---

## 1. 수렴 결론 ① 모바일 푸시 = "서버 → 벤더 운영 relay → APNs/FCM" 3-hop (M6)

**왜 다른 길이 없는가**: APNs에 푸시를 보낼 열쇠(인증서/키)는 App Store에 앱을 배포한 주체만 가진다. 셀프호스팅 서버 각각이 Apple과 계약할 수 없으므로, 셀프호스트 서버는 반드시 **앱 배포자(벤더)가 운영하는 push relay**를 경유해야 한다. Zulip 문서의 표현: "Google과 Apple의 보안 모델상 셀프호스트 서버가 직접 모바일 알림을 보낼 수 없다."

네 제품의 구현과 과금:

| | relay | 페이로드 프라이버시 | 무료 정책 |
|---|---|---|---|
| Mattermost | HPNS (push.mattermost.com, 미국/독일 2곳) | id-only 지원하나 **유료 플랜 한정** | 무료는 SLA 없는 테스트용(TPNS)뿐 |
| Rocket.Chat | gateway.rocket.chat (등록 필수) | 내용 숨김 토글 | **월 1만 건 제한** — 커뮤니티 반발·우회 생태계 유발 |
| Zulip | push.zulipchat.com (bouncer, 등록제) | **Server 12+: E2E 암호화** — relay도 Apple도 내용 못 봄 | 10인 이하 무료, OSS/학술 무료 |
| Matrix | Sygnal (앱 벤더가 운영) | event_id_only + 클라 fetch | 무료·무제한 |

**momo 번역** (research/15에서 상술):
- momo push relay는 **선택이 아니라 구조적 필연**이다. momo가 iOS 앱을 App Store에 내는 순간, momo(Dawn)가 운영하는 relay 서비스가 셀프호스팅 배포판의 유일한 공유 인프라가 된다.
- 페이로드는 처음부터 **id-only(내용 비유입)**로 — 셀프호스터의 대화 내용이 momo 인프라를 지나지 않는다. ADR-0004("provider 자격증명 비유입")와 같은 결의 "content 비유입" 원칙.
- 과금은 Zulip 모델(관대한 무료 + 남용 방지 rate limit)이 정답, Mattermost/Rocket.Chat의 유료 게이팅은 반면교사.

- https://zulip.readthedocs.io/en/stable/production/mobile-push-notifications.html
- https://spec.matrix.org/latest/push-gateway-api/

## 2. 수렴 결론 ② 모바일 온보딩 = 스토어 단일 앱 + 서버 URL 입력 + universal link 초대

네 제품 모두: App Store에 앱은 **하나**, 첫 화면에서 서버 URL을 입력받는다. 이 방식 자체로 앱 심사가 거절된 사례는 확인되지 않는다. 유일한 대형 사고는 Element의 Google Play 일시 정지(2021)인데, 원인은 URL 입력 UX가 아니라 **앱에 내장된 기본 공개 서버(matrix.org)의 콘텐츠 모더레이션 책임**이었다.

가장 완성된 초대 흐름은 Rocket.Chat: `go.rocket.chat/invite?...` universal link 하나가 "앱 미설치 → 스토어 → 설치 → 서버 자동 등록 → 가입"을 끝까지 이어준다. Mattermost는 v2부터 멀티 서버 동시 접속을 지원한다(서버 추가가 1급 화면).

**momo 번역**: iOS/웹 온보딩의 정답 형태가 이미 있다 — ① 앱은 서버 URL 입력이 루트 화면 ② 초대 링크는 universal link로 설치까지 관통 ③ 앱에 기본 공개 서버를 내장하지 않는다(심사 리스크 회피) ④ 데이터 모델은 처음부터 멀티 서버 계정을 전제(ADR-0117과 합류). 심사 대비 리뷰어용 데모 서버·계정 준비는 관례(App Review 2.1).

- https://developer.rocket.chat/docs/deep-linking · https://element.io/blog/element-on-google-play-store/

## 3. 수렴 결론 ③ 웹 클라이언트는 서버가 같은 도메인에서 직접 서빙 (M10)

Mattermost/Rocket.Chat/Zulip: 서버 프로세스가 웹 SPA를 직접 서빙 — 셀프호스터는 "설치하면 웹까지 끝"이고, 서버 URL이 곧 웹 접속 URL이다. Element만 정적 SPA 분리 배포인데, 셀프호스터가 배포물 2개를 관리해야 하는 마찰이 있다. 데스크톱 앱은 넷 다 Electron으로 웹앱을 감싼 것이다.

한 가지 보안 유보(Element의 분리 근거): 사용자 업로드 파일과 앱을 같은 오리진에서 서빙하면 XSS 위험 — 이건 배포 분리가 아니라 **첨부 파일만 별도 서브도메인/강한 CSP로 격리**하면 해결된다.

**momo 번역**: momo 웹 클라이언트는 momo 서버(또는 같은 compose의 정적 서빙)가 같은 도메인에서 내주는 형태가 정답. "본인 서버 URL을 웹에 입력하면 확인할 수 있다"는 요구는 자연 충족된다 — 서버 URL 자체가 웹앱 주소이므로, 별도의 "URL 입력 웹 포털"조차 필요 없다. 첨부 서빙만 오리진 격리.

- https://github.com/element-hq/element-web/blob/develop/docs/install.md

## 4. 수렴 결론 ④ 1~50인 팀 = 2~4GB RAM 단일 노드, 멀티 리전은 아무도 안 한다 (M10)

- 최소 사양: Rocket.Chat 1vCPU/2GB(≤50 동시), Zulip 2GB(+swap), Synapse ~2GB, Mattermost는 2,000 동시 사용자까지 단일 서버 공식 안내.
- 월 비용: 2~4GB VPS = **월 $5~25** (Hetzner €4~8, DO $12~24) + 도메인 + Let's Encrypt(무료).
- **멀티 리전 active-active를 지원하는 제품은 없다.** Mattermost HA는 같은 데이터센터 필수를 명문화했고, Zulip은 HA조차 warm standby 수동 승격이 공식 답변이다. 지역성은 relay 엔드포인트 수준(Mattermost 푸시 서버 미국/독일)에서만 다룬다.

**momo 번역**: momo의 단일 EC2 전략은 업계 표준 그 자체다. 리전 대응은 "서버를 세울 때 가까운 리전을 고른다" + "momo relay 엔드포인트를 훗날 지역 분산"이면 충분하고, 그 이상은 Slack도 안 하는 일(03장 §7)이다.

## 5. 각 제품에서 하나씩 더 배울 것

- **Zulip — 라이선스/BM의 모범**: 코어 전부 Apache 2.0, 기능 게이팅 없음, 수익은 클라우드 호스팅 + push relay 플랜 + 지원. momo의 permissive 원칙과 유일하게 완전 정합하는 선례. 초대 보안도 가장 정교하다(만료 기본 10일, 역할 바인딩, revoke). 반면교사 CVE-2022-21706: 재사용 초대 링크가 **다른 조직 가입을 허용**했던 사고 — 초대 토큰의 워크스페이스·역할 바인딩 검증은 필수(momo는 invite hash가 워크스페이스에 바인딩되어 이미 충족, `003_onboarding.sql`).
- **Zulip — presence 폴링**: websocket 대신 REST 폴링 + 증분(`last_update_id`)으로 presence 비용을 예측 가능하게 만들었다. "정확한 presence는 채팅앱에서 가장 비싼 기능 중 하나"라는 문서 문장은 ux-bible P14의 독립 검증.
- **Mattermost — 스케일 문서의 정직함**: "2,000 동시 사용자까지 단일 서버"처럼 **단일 노드 상한을 숫자로 명시**하는 문서 관행. momo 배포 문서에 그대로 차용할 것.
- **Rocket.Chat — 반면교사**: 단일 노드조차 MongoDB replica set 필수라는 운영 복잡성이 셀프호스터 이탈 요인. momo의 "PG 하나면 된다"를 지켜야 하는 이유.
- **Matrix — 참조만, 차용 금지**: Synapse/Sygnal은 2023-12부터 AGPLv3 — momo 하드 룰(AGPL 백본 금지)상 아키텍처만 참조하고 코드는 금지. presence를 꺼두는 것이 공식 튜닝 1순위라는 점도 P14의 방증.

## 6. 웹훅/연동의 인증 문법 (M11 인접)

- Mattermost: incoming=비밀 URL, outgoing=token 대조.
- Rocket.Chat: `/hooks/{id}/{token}` + V8 격리 스크립트.
- Zulip: bot 계정 + api_key.
- Matrix: Application Service의 `as_token`/`hs_token` **상호 인증** + 관리자 수동 등록.

momo의 ADR-0115(signed webhook ingress) 예약은 이들보다 강한 per-install HMAC 서명을 이미 권고안으로 갖고 있다 — 업계 대비 상향 표준이며 그대로 진행하면 된다.

## 7. 이 장의 요약 — momo 배포 모델의 뼈대는 이미 검증돼 있다

1. **푸시**: momo 운영 relay + id-only 페이로드 + 관대한 무료 (Zulip 모델).
2. **온보딩**: 스토어 단일 앱 + 서버 URL 루트 화면 + universal link 초대 (Rocket.Chat 흐름) + 기본 서버 비내장 (Element 교훈).
3. **웹**: 서버가 같은 도메인에서 직접 서빙 — 서버 URL이 곧 웹 주소.
4. **사양**: 2~4GB 단일 노드, 월 $5~25. 멀티 리전은 하지 않는 것이 표준.
5. **BM**: 코어 전부 무료·완전 기능, 수익은 호스팅/relay/지원 (Zulip 모델) — "오픈소스지만 우리가 호스팅한 서버로 무료 서버 파기"와 정확히 이 지점이 맞물린다.
