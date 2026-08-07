# oort UX 바이블 — Slack 레퍼런스 기반 원칙 v0

> 생성: 2026-07-10 · 근거: Slack UX/엔지니어링 코퍼스 36선 (34건 본문 검증) · 관리: ADR-0100 삼분법의 "계획/기준" 문서
> 사용법: **UI/UX 티켓의 수용기준은 이 문서의 원칙 번호(P1~P15)를 인용한다.** 원칙 수정은 ADR로.

## 원칙 15개조

| # | 원칙 | oort 번역 | 근거 |
|---|---|---|---|
| P1 | 소프트웨어가 아니라 "더 나은 팀"을 판다 | "에이전트가 1급 동료인 조직"이라는 변화를 판다. 기능 목록 금지 | A1, A2 |
| P2 | 고객이 아직 원할 줄 모르는 제품은 결함 관용이 0 — 모든 디테일이 마케팅 | 속도·카피·모션이 곧 설득. "동작함"과 "쓰고 싶음"의 격차를 craft로 메움 | A1, A3, A5 |
| P3 | 제품의 인격(voice & tone)은 장식이 아니라 기능 | 에이전트 발화 톤 = 제품 인격. "무엇처럼 들리지 않을지"까지 문서화 | A3, A6, A7, A9 |
| P4 | 원칙은 계층으로 쌓는다 | 조직 원칙 → 영역 원칙 → 기능 가드레일("에이전트 알림은 회사가 아니라 사용자를 돕는다") | A4, A5, B9 |
| P5 | 온보딩은 제품이 제품 안에서 스스로를 가르치는 것 | 첫 실행 = 에이전트와의 첫 대화(Slackbot 패턴). 활성화 매직넘버 1개를 정해 소유 | B1, B2, A2, A10 |
| P6 | 부팅은 즉시처럼: 최소 페이로드 + lazy backfill + 예측 프리페치 | 활성 채널만 먼저, 나머지는 뒤에서. 부트 페이로드가 성능 예산의 1순위 | C4, C10, C11, C3, C9 |
| P7 | **Unread 상태가 곧 제품이다** | 읽음/안읽음은 서버 단일 진실 + 경량 카운트 API 일괄 점등. read_state 스키마는 준비됨, UI가 없음 → ADR-0109 | C11, B6, B12, C5 |
| P8 | 알림은 예산이다 — 보내지 않을 이유가 기본값 | 에이전트가 알림을 만들 수 있는 oort는 Slack보다 더 엄격해야 함 | B6, B8, B9, B10 |
| P9 | 알림 판정 로직은 서버에 단 하나, 단순한 멘탈모델로 | 목표: 6-노드 수준의 합성 가능한 결정 트리. 플랫폼별 재구현 금지 | B6, B7, B8 |
| P10 | 알림에는 관측 가능성을 내장 | trigger→sent→opened 트레이스. "알림이 안 와요"를 디버깅 가능하게 | C12, B8 |
| P11 | 키보드 우선 내비게이션이 파워유저 리텐션의 뼈대 | Cmd+K 퀵 스위처 + unread 순회를 1급 문법으로 | B12, C10 |
| P12 | 스레드는 "메인 뷰 가독성"이 제1제약 — 숨긴 정보의 발견 가능성을 보상하라 | 채널 밖 답글 + All Threads 뷰. 검색·알림 없는 스레드는 접근성 부채(반례 포함) | B3, B4, B5, B11 |
| P13 | 내부 도그푸딩으로 6번 버릴 각오 | 실사용 없이 검증되는 메시징 UX 결정은 없다. 현 로컬 솔로 dogfood는 이 원칙과 부합 | B3, A2 |
| P14 | 프레즌스 같은 ambient 신호가 가장 비싼 트래픽 | 처음부터 "보이는 유저만 구독" 모델로 → ADR-0104 | C5, C2, C3, C1 |
| P15 | 빅뱅 재작성 금지 — 지루한 마이그레이션이 좋은 마이그레이션, 안정성 자체가 UX | 레거시 옆 모던 섹션, 앞단에 내구층 추가, 가중치 점진 전환 | C9, C7, C6, C8, C14 |

## 코퍼스

### A — UX 철학 / 제품 사상

| ID | 소스 | 저자/연도 | 핵심 |
|---|---|---|---|
| A1 | [We Don't Sell Saddles Here](https://medium.com/@stewart/we-dont-sell-saddles-here-4c59524d650d) | Butterfield, 2013 | 안장이 아니라 승마를 판다; 모든 디테일이 마케팅 |
| A2 | [From 0 to $1B — Launch Strategy](https://review.firstround.com/from-0-to-1b-slacks-founder-shares-their-epic-launch-strategy/) | First Round, 2015 | 팀 크기별 단계 확장; "2,000 메시지" 활성화 지표 |
| A3 | [Slack's $2.8B Secret Sauce](https://awilkinson.medium.com/slack-s-2-8-billion-dollar-secret-sauce-5c5ec7117908) | Wilkinson, 2015 | 차별화는 기능이 아니라 인격 |
| A4 | [Why Your Organization Needs Product Principles](https://slack.design/articles/why-your-organization-needs-product-principles/) | Eismann, 2021 | 5대 제품 원칙 공식 문서 |
| A5 | [Craft in Design](https://slack.design/articles/craft-in-design-what-it-is-why-it-matters/) | Eismann | utility–usability–craft 3층 |
| A6 | [The Voice of the Brand](https://slack.design/articles/thevoiceofthebrand-5principles/) | Drugay, 2021 | 카피 5원칙 |
| A7 | [Being Human, Being Slack](https://bradfrost.com/blog/post/clarity-conf-being-human-being-slack/) | Pickard 발표, 2016 | courtesy·craftsmanship·playfulness 실전 해설 |
| A8 | [Diógenes Brito 인터뷰](https://slack.design/articles/design-leadership-and-ambiguity-an-interview-with-diogenes-brito/) | slack.design | 디자인 가치의 문화화 |
| A9 | [Just a Brown Hand](https://medium.com/@uxdiogenes/just-a-brown-hand-313db35230c5) | Brito, 2015 | 사소한 기본값이 가치 선언 |
| A10 | [Going from 0 to 1 in Product Discovery](https://www.mindtheproduct.com/going-from-0-to-1-in-product-discovery-by-merci-grace/) (영상) | Grace, 2023 | NUX 팀 리드의 발굴 프레임 |
| A11 | [Slack Brand Guidelines PDF](https://a.slack-edge.com/4d5bb/marketing/img/media-kit/slack_brand_guidelines_september2020.pdf) ⚠️부분검증 | Slack, 2020 | 브랜드 시스템 벤치마크 |

### B — 사용자 플로우 / UX 메커니즘

| ID | 소스 | 저자/연도 | 핵심 |
|---|---|---|---|
| B1 | [How Slack Onboards New Users](https://www.useronboard.com/how-slack-onboards-new-users/) | Hulick, 2014 | 원조 온보딩 티어다운 |
| B2 | [Slack 온보딩의 진화](https://www.appcues.com/blog/slack-user-onboarding-experience) | Appcues | 온보딩은 지표 따라 계속 깎는 대상 |
| B3 | [Threads: A Long Design Journey 1/2](https://slack.design/articles/threads-in-slack-a-long-design-journey-part-1-of-2/) | Florin, 2016 | 사내 6개 버전 폐기 기록 |
| B4 | [Threads: A Long Design Journey 2/2](https://slack.design/articles/threads-in-slack-a-long-design-journey-part-2-of-2/) | Florin, 2020 | "답글을 채널에서 숨긴 것"이 최대 결정 |
| B5 | [Weaving Threads](https://slack.engineering/weaving-threads/) | Rosania, 2017 | 인라인 답글 실패의 1차 기록 |
| B6 | [Reducing Slack's Memory Footprint](https://slack.engineering/reducing-slacks-memory-footprint/) | Rodgers 외, 2017 | 알림 플로차트 원출처; 판정 로직 서버 이관 |
| B7 | [Everyone Is Wrong About That Slack Flowchart](https://sophiebits.com/2024/10/30/everyone-is-wrong-about-that-slack-flowchart) | Alpert, 2024 | 6-노드 재설계 시연 |
| B8 | [How Slack Rebuilt Notifications](https://slack.engineering/how-slack-rebuilt-notifications/) | Coronel & Kannan, 2026 | 4개 상충 멘탈모델 → 3택 + what/how 분리 |
| B9 | [Layered Product Principles for Notifications](https://slack.design/articles/how-we-layered-product-principles-to-refresh-slack-notifications/) | Au, 2021 | 알림 원칙 + Slackbot 가드레일 |
| B10 | [Slack, I'm Breaking Up with You](https://medium.com/@samuelhulick/slack-i-m-breaking-up-with-you-54600ace03ea) | Hulick, 2016 | 실패 모드 카탈로그 (#Slacklash) |
| B11 | [Threads Are Terrible for Accessibility](https://becca.ooo/blog/slack-threads-are-terrible-for-accessibility/) | rebecca®, 2020 | 스레드 설계의 그림자 |
| B12 | [Keyboard Shortcuts 공식](https://slack.com/help/articles/201374536-Slack-keyboard-shortcuts) | Slack Help | 키보드 문법 전체 표면 |

### C — UX를 지탱하는 엔지니어링

| ID | 소스 | 저자/연도 | 핵심 |
|---|---|---|---|
| C1 | [How Slack Works — QCon SF 2016](https://www.infoq.com/presentations/slack-infrastructure/) (영상 49분, [슬라이드](https://qconsf.com/sf2016/system/files/presentation-slides/how_slack_works_-_qcon_sf_2016.pdf)) | Keith Adams | 전체 스택 투어의 고전; 메시지 순서/전달 보장 다루는 유일 소스 |
| C2 | [Scaling Slack — QCon SF 2017](https://www.infoq.com/presentations/slack-scalability/) (영상, [슬라이드](https://qconsf.com/sf2017/system/files/presentation-slides/slack_qcon-bing_wei.pdf)) | Bing Wei | 프레즌스 = 이벤트 볼륨 60% |
| C3 | [Scaling Slack — QCon 2018](https://www.infoq.com/presentations/slack-scalability-2018/) (영상) | Demmer | DAU 4M→8M 3대 전환 |
| C4 | [Flannel: Edge Cache](https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/) | Wei, 2017 | lazy backfill의 원전; 부트 페이로드 44배 감소 |
| C5 | [Real-time Messaging](https://slack.engineering/real-time-messaging/) | Thangudu, 2023 | GS/CS/PS 분리; oort Centrifugo 계층의 참조 사양 |
| C6 | [Websockets to Envoy](https://slack.engineering/migrating-millions-of-concurrent-websockets-to-envoy/) | van der Stelt & Kumari, 2021 | 무중단 인그레스 교체 절차 |
| C7 | [Scaling Slack's Job Queue](https://slack.engineering/scaling-slacks-job-queue/) | Yadav 외, 2017 | Redis 교체 대신 Kafka 전치 |
| C8 | [Vitess Datastores](https://slack.engineering/scaling-datastores-at-slack-with-vitess/) | Ganguli 외, 2020 | 샤딩 키가 제품 로드맵을 결정 |
| C9 | [When a Rewrite Isn't](https://slack.engineering/rebuilding-slack-on-the-desktop/) | Christian & Rodgers, 2019 | 빅뱅 없는 클라 재건의 교본 |
| C10 | [Faster By Being Lazy 1](https://slack.engineering/making-slack-faster-by-being-lazy/) | Schiller, 2017 | 클라 성능 4원칙 |
| C11 | [Faster By Being Lazy 2](https://slack.engineering/making-slack-faster-by-being-lazy-part-2/) | Schiller, 2017 | users.counts 일괄 unread + LocalStorage 캐싱 실패담 |
| C12 | [Tracing Notifications](https://slack.engineering/tracing-notifications/) | Karumuri & Luong, 2023 | 알림 = 분산 트레이스 |
| C13 | [Slack at the Edge — SREcon19](https://www.usenix.org/conference/srecon19asia/presentation/pemberton) ⚠️초록검증 | Pemberton, 2019 | 리전 정전에도 세션 생존 |
| C14 | [Disasterpiece Theater](https://slack.engineering/disasterpiece-theater-slacks-process-for-approachable-chaos-engineering/) | Crowley, 2019 | 접근 가능한 카오스 엔지니어링 |

## 확인된 리서치 갭 (= oort의 실험 기회)

- **프레즌스·타이핑 전용** 1차 문서 부재 (C5·C2가 최선) — 에이전트 프레즌스는 우리가 직접 정의해야 하는 공백.
- **드래프트/컴포저 동작**의 양질 분석 부재 — oort 클라의 채널별 드래프트 설계는 자체 실험 영역.
- QCon 영상 3건(C1·C2·C3)과 A10은 NotebookLM 노트북에 넣어 발표 전문 기반 Q&A로 보조 학습 권장.
