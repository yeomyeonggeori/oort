# 15-03 · 결정 제안 — ADR 분해, 로드맵 배치, 실행 순서 (성재 승인 대기)

> Planning ID: `PLN-20260715-02` (Fable) · 2026-07-15 · 상태: **proposal** — 이 문서의 어떤 항목도 승인 전에는 티켓/Issue가 되지 않는다.
> 근거: `00-current-facts-and-gaps.md`(코드 사실), `01-slack-discord-infra.md`·`02-selfhosted-distribution-patterns.md`(업계), `docs/architecture/bible/06-momo-vs-world.md`(대조).

## 0. 한 장 요약

성재의 세 고민에 대한 이 리서치의 답:

1. **이해도** → 바이블 초판 6장 완성(`docs/architecture/bible/`). 남은 4개 예고 장은 해당 ADR 승격 후 집필.
2. **슈퍼앱 수용성** → 재결정 불요. ADR-0112("하나의 타임라인, 두 개의 밀도")가 정본이며, 부족한 것은 모드 2개 사이의 **경사로 정의**뿐 — §4에 제안.
3. **인프라** → 신규 결정이 필요한 것은 정확히 3개(푸시 relay, 웹 트랙, 배포판·온보딩). 나머지는 기존 큐(ADR-0104 presence, ADR-0105 검색, ADR-0113/0116 파일, ADR-0115 웹훅, ADR-0117 멀티WS)에 입력만 얹으면 된다. **그룹채팅 인프라는 이미 완비**(channel/membership/seq/DM/read_state)로 신규 결정이 없다. **멀티 리전은 안 하는 것이 업계 표준**(Slack도 코어는 단일 리전) — "리전 잘 고르기 + 훗날 relay 엔드포인트 지역화"로 충분.

## 1. 신규 ADR 후보 3건 (번호는 승인 후 0119+에서 발급)

### ADR-α · 푸시 알림 경계와 oort push relay — **권고 1순위**

- **왜 지금**: iOS(M5)의 전제조건이면서 리드타임이 가장 길다(Dawn 운영 인프라 + Apple Developer 계정 + relay 서비스). APNs 구조상 **셀프호스팅 oort 서버는 Dawn이 운영하는 relay를 경유해야만 푸시를 보낼 수 있다**(02 §2-1 — 4사 공통 구조적 필연). 스키마(`device`/`push_token`/`push_dispatch_log`)는 이미 있다.
- **결정 범위**: ① Dawn 운영 push relay(서버 등록제, rate limit, 남용 차단) ② 페이로드 등급 — **id-only 기본**(대화 내용이 Dawn 인프라를 지나지 않음; ADR-0004의 "자격증명 비유입"과 같은 결의 content 비유입, Zulip E2E 봉투는 v2 후보) ③ 서버측 notifier — outbox 소비 단일 worker, unread(ADR-0109)·멘션·DND 판정을 한 곳에(ux-bible P9, Slack activity/delivery 분리 교훈) ④ device/push_token 등록 REST ⑤ 무료 정책 — **관대한 무료 + rate limit**(Zulip 모델; Mattermost/Rocket.Chat 유료 게이팅은 반면교사).
- **옵션**: A) relay 운영 + id-only(권고) / B) A + 자체 빌드 앱용 BYO-push 병행(later 후보) / C) 푸시 없는 iOS 출시(기각 — 메신저 성립 불가).
- **승계**: MOMO-040~043(EP-IOS)의 APNs 항목이 이 ADR의 파생 배치로 흡수·확장된다. 서버측(③④)은 iOS 앱 이전에 선행 착수 가능.

### ADR-β · 웹 클라이언트 트랙 신설

- **왜**: "본인 서버 URL을 웹에 입력하면 접속"이 성재 요구인데 로드맵에 웹 트랙 자체가 없다(트랙 정의가 🖥/📱/⚙️뿐). 업계 정답이 명확하다: **서버가 같은 도메인에서 SPA를 직접 서빙** — 서버 URL이 곧 웹 주소가 되어 "URL 입력 포털"조차 필요 없다(02 §2-3).
- **결정 범위**: ① 로드맵에 웹 트랙(🌐) 신설과 마일스톤 위치 ② 스택(permissive: TypeScript SPA + centrifuge-js; REST/이벤트 계약은 기존 `/v1/*` 재사용) ③ 서빙(같은 compose에서 Caddy가 정적 서빙, 첨부만 오리진 격리 — Element XSS 교훈의 한정 적용) ④ v0 스코프(추천: 읽기+대화+승인 카드 — Work 상세/개발자 모드는 v1) ⑤ **계약 이중화 방지** — MomoCore(Swift)와 웹 클라가 같은 REST 계약을 쓰므로 계약 문서/스키마 export를 정본화.
- **옵션**: A) 서버 동일 도메인 서빙 SPA(권고) / B) 분리 배포(기각 — 셀프호스터 배포물 2배) / C) 데스크톱 웹뷰 우선(기각 — macOS 네이티브 기보유).
- **열린 질문(성재)**: 웹 v0을 iOS(M5)보다 **앞에** 둘 것인가? 웹은 스토어 심사가 없어 리드타임이 짧고, 초대받은 신규 멤버의 최소 진입 장벽이다(앱 설치 없이 초대 링크 → 브라우저 합류). 초대 관통률 관점에서 웹 선행에 무게를 두되 결정은 성재.

### ADR-γ · 셀프호스팅 배포판과 온보딩 모델

- **왜**: "오픈소스지만 우리가 호스팅한 서버 기반으로 무료로 서버 파고 멤버 초대"가 제품 방향인데, 현재 배포는 운영자(성재) 수동 런북 단계다. ADR-0002가 install/upgrade 경계를 이미 예약했고, 이 ADR은 그 위의 **제품화 결정**이다.
- **결정 범위**: ① install/upgrade 스크립트(ADR-0002 승계 — pinned image + 마이그레이션 + 롤백) ② **universal link 초대**(초대 링크 하나로 웹 합류/앱 설치 관통 — Rocket.Chat 완성형) ③ 서버 개설 시 relay 등록 온보딩(ADR-α 연동) ④ 단일노드 상한 숫자 명시(Mattermost 관행; oort는 "동시 수백 명" 보수 명시로 시작) ⑤ BM 경계 — **셀프호스팅 전 기능 무료**, 수익은 Dawn 호스팅(oort Cloud)·relay 대량 사용·지원(Zulip 모델; permissive 원칙과 유일하게 완전 정합) ⑥ 앱에 기본 공개 서버 비내장(Element Play 정지 교훈).
- **옵션(포장 수준)**: A) compose + install.sh(권고 v1) / B) 클라우드 마켓플레이스 원클릭 이미지(v1.5) / C) oort Cloud managed(별도 트랙).

## 2. 기존 큐에 얹는 입력 (신규 ADR 불요)

| 대상 | 이번 리서치의 입력 |
|---|---|
| **ADR-0104 presence** (unclaimed) | 설계 원칙 3개 확정 근거: 연결 기반(Centrifugo presence 재사용) + **처음부터 구독 문법**(Slack 공개 후퇴 교훈) + "안 보는 사람에겐 안 보냄"(Discord passive 90%). 에이전트 존재감(실행 중/대기)은 `agent:` status 기반 기존 자산과 통합. typing은 DB 비경유 브로드캐스트(Slack 동형). 이 ADR은 claim 가능 상태 — 리서치 입력 완료. |
| **ADR-0105 검색** | 배포판 관점 제약 추가: 외부 검색엔진 컨테이너는 셀프호스터 설치 난이도를 올린다(Rocket.Chat replica set 반면교사) — PG 확장(PGroonga 계열) 우선 검토 권고. |
| **ADR-0113/0116 파일·컨텍스트** | 질문 1건 제출: **가벼운 첨부(스크린샷/이미지)와 Drive 문서 협업의 분리 여부.** 협상불가 항목 등재 요청: 첨부 서빙은 처음부터 인증 게이트 + **만료형 서명 URL**(Discord 사후 전환 교훈). 썸네일은 Zulip 워커 패턴. |
| **ADR-0115 웹훅** | 기존 per-install HMAC 권고안이 업계(token 대조/api_key) 대비 상향 표준임을 확인 — 그대로 진행. |
| **ADR-0117 멀티WS** | 모바일/웹 온보딩과 합류: 클라이언트 데이터 모델은 처음부터 "서버 URL + 계정" 복수 보유를 전제(Mattermost v2 교훈). |
| **ADR-0107/0108 CI·스택** | 단일 노드 전략이 업계 표준임을 확인(Slack 코어 단일 리전, 4사 단일노드 안내). in-process rate limiter의 다중화 시 한계(`App.swift:37`)를 0108 검토 항목에 기록. outbox 깊이 모니터링(Slack job queue 교훈)을 운영 지표 티켓 후보로. |

## 3. 로드맵 배치 제안 (승인 후 momo-main이 반영)

```
지금            ┌ ADR-α 푸시 (draft 착수 — 서버측 notifier·등록 REST는 iOS 앞 선행 가능)
결정 큐 순서 유지 ┼ ADR-0104 presence (claim만 하면 착수 가능 — 입력 완비)
                ├ ADR-γ 배포판 (Phase A AWS 운영 단계와 연동 — GHCR→EC2 경험이 install.sh의 재료)
                └ ADR-β 웹 (γ의 초대 관통 흐름과 합류; iOS 선행 여부는 성재 결정)
불변            M0~M8 backbone 불변 — 위 항목은 전부 overlay로 배치
```

- 엔진 큐(ADR-0113/0116 → 0114 → 0115)와 이 큐는 **파일군이 겹치지 않아 병렬 가능**(엔진은 server 연동·인증 경계, 이쪽은 배포·클라이언트 플랫폼). 단 동시 draft 수는 성재의 검토 대역폭이 상한.
- 슈퍼앱 shell 체인(MOMO-383→384/385→386)과도 독립 — 이 리서치는 그 체인의 어떤 파일도 건드리지 않는다.

## 4. 슈퍼앱 경사로 — ADR-0112의 후속 제안 (비개발자→개발자 전환)

ADR-0112는 "기본 모드 vs 개발자 모드" 양 끝을 정의했다. 성재의 고민("비개발자도 따라오면서 개발자는 더 어려운 작업까지")의 남은 절반은 **그 사이의 경사로**다. 제안:

| 단계 | 표면 | 게이트 |
|---|---|---|
| L0 기본 | Slack처럼 — 에이전트 발화는 요약 1줄 + 접힌 카드 | (기본값) |
| L1 펼침 | 카드 클릭 → 무엇을 했는지 사람 언어로 (도구 이름·diff 요약) | 클릭 한 번 |
| L2 개발자 모드 | 프로토콜 칩·비용·tool JSON | 설정 토글 (ADR-0112 D1) |
| L3 드로어 | ⌃` transcript/활동 라이브 뷰 | MOMO-375 (Accepted 범위) |
| L4 개입 | 실행 중 명령 입력·정책 조정 | ADR-0114 승인 후 |

- **핵심 원칙(ux-bible 개정 후보)**: "모든 단계는 바로 아래 단계에서 한 클릭/한 토글이면 도달한다. 어떤 단계도 아래 단계의 문법을 깨지 않는다." — 비개발자가 개발자가 되는 경로가 UI 안에 존재하게 하는 장치. 원칙 번호 부여(P16)는 ux-bible 관리 규약상 ADR로 — ADR-0112 amendment 또는 L4를 결정할 ADR-0114에 함께 싣는 것을 권고(별도 ADR 불요).
- 용어 규율: 기본 모드에서 "터미널/PTY/stdout" 금지 — "작업 기록/무엇을 했는지"로. dev 모드에서만 원어.

## 5. 티켓 후보 (전부 승인 후 MOMO-389+에서 발급)

| 후보 | 내용 | 선행 |
|---|---|---|
| T-α1 | notifier worker 골격 + device/push_token 등록 REST + 판정 v0(멘션/DM) | ADR-α Accepted |
| T-α2 | oort push relay 서비스 v0(등록·전달·rate limit) + APNs .p8 운영 | ADR-α Accepted |
| T-γ1 | `infra/prod/install.sh`/`upgrade.sh` + 단일노드 상한 문서 | ADR-γ Accepted (ADR-0002 계약) |
| T-γ2 | universal link 초대(웹 합류 관통) | ADR-γ + (권장) ADR-β v0 |
| T-β1 | 웹 클라 v0 스캐폴드 + compose 정적 서빙 + 로그인/타임라인 읽기 | ADR-β Accepted |
| T-ops1 | outbox 깊이·relay lag 운영 지표 노출 (ADR 불요 — 순수 관측) | 없음 — 즉시 발급 가능 |
| (기획) | 바이블 07~10장 집필 | 각 ADR 승격 후, 기획 레이어 작업(티켓 불요) |

## 6. 성재 결정 요청 목록

1. 신규 ADR 3건(α 푸시 relay / β 웹 트랙 / γ 배포판·온보딩)의 **번호 발급(0119+)과 draft 착수 승인** — 권고 순서: α → (0104 병렬) → γ → β.
2. **웹 vs iOS 순서** — 초대 관통(무설치 합류) 관점에서 웹 선행 권고에 동의하는지.
3. **첨부 vs Drive 분리 질문**을 ADR-0113/0116 논의 범위에 포함할지.
4. T-ops1(outbox 관측 지표)은 ADR 불요 판단 — 바로 발급해도 되는지.
5. 바이블 초판의 `docs/INDEX.md` 등재(이 세션에서 반영) 확인 + 후속으로 docx/웹북 export가 필요한지(pandoc 변환 티켓 또는 세션 작업).
