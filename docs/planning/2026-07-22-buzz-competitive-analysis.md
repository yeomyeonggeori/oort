# block/buzz 경쟁 분석 — 철학·프로토콜·UX·상흔 발굴 (2026-07-22, Fable — 성재 발제)

> 발단: 성재 지시 — "탈중앙 AI-native 메신저를 표방하는 block/buzz를 0-tier부터 뜯어, 가져갈 철학/인프라/로직/프로토콜 요소, 커뮤니티 반응, 겹치는 포지션과 우리 강점, 그리고 시간적 경험에서만 나오는 숨은 노하우를 확인하라."
> 방법: 레포 전체 clone(커밋 1,767개, 2026-03-06~07-21) 후 병렬 4축 분석 — ①아키텍처/프로토콜(ARCHITECTURE·NOSTR·NIP 14종·crate 26개) ②git 고고학(반복 수정 클러스터·회고 문서·게이트 체계) ③커뮤니티 반응(HN·X·GitHub 정량) ④UX 패턴(스크린샷·desktop/web/mobile 코드).
> **한 줄 결론: buzz는 oort와 동일한 신념(에이전트=1급 멤버, PG=SoT, provider 키 비유입, self-hosted 주권)을 Nostr 프로토콜 우선으로 구현한 거울상이다. 프로토콜은 가져올 것이 없고(오히려 oort의 seq/outbox/RLS가 구조적 우위), 그 위의 로직 계층(오너 위임·페이지네이션 계약·에이전트 상태 데이터플레인·wake-only 푸시·승인 체인)과 4개월치 상흔(에이전트 루프·킬스위치·RLS 공리·게이트 운영)이 금광이다.**

중요 타임라인: repo 생성 2026-03-06 → 조용한 Show HN 2026-06-22(21pt) → **공식 런칭 2026-07-21(어제)** — jack 트윗 2.61M views, HN 316pt/272cmt, star 1,380→2,733(+12h). "최근에 핫한" 이유는 런칭 직후이기 때문이다.

---

## 1. buzz는 무엇인가

- Block(구 Square)의 오픈소스(Apache-2.0). 공식 명분(jack): *"built to reduce our dependency on slack and github. model-agnostic, decentralized, self-sovereign, open source."* 사내 Slack+GitHub 대체가 1차 목표.
- **Nostr relay가 곧 워크스페이스**: 메시지·리액션·워크플로 스텝·리뷰 승인·git 이벤트 전부가 하나의 로그에 담긴 서명 이벤트(커스텀 kind 81개, 자체 NIP 14종). 배치는 중앙형(클라→단일 relay WS→Postgres 17), 프로토콜만 탈중앙.
- 스택: Rust crate 26개 + Tauri 데스크톱 + web(레포 브라우저 전용) + Flutter 모바일(부분). 에이전트는 ACP(Agent Client Protocol)로 goose/Claude Code/Codex 아무거나 접속.
- goose(51.4K stars)와의 관계: goose=에이전트 그 자체, buzz=에이전트가 일하는 장소. "agent 시대 개발 스택"의 오픈소스 표준 선점 투트랙.
- 개발 방식이 그 자체로 데이터: 4.5개월에 1,767커밋, PR 1,799개 머지, 커밋 서명자 다수가 npub — **에이전트로 에이전트 워크스페이스를 만드는 도그푸딩**. 외부 기여자 거의 없음(상위 기여자 전원 Block 직원 추정), Discussions 미사용.

## 2. 핵심 철학 (그들의 문장 + 판정)

| 그들의 문장 | 판정 |
|---|---|
| "The relay is the single source of truth. All reads and writes flow through it." | oort의 PG=SoT·단일 쓰기경로와 동일 신념 |
| Human/Agent 모두 secp256k1 keypair·서명 이벤트·동일 감사추적 — "humans and agents are just colleagues" | oort의 에이전트=`member` 불변식과 동일. **양사가 독립적으로 같은 결론에 도달** |
| "Buzz is the pipe — not the brain." 플랫폼은 지능을 갖지 않고, 지능은 키를 가진 에이전트가 멤버로서 가져온다 | oort의 봇 래핑 금지와 동형 |
| LLM 키는 하네스 env에만, relay 비유입 | ADR-0004와 동형 |
| "Zero is the default. You opt in to noise, not out." (알림 기본 0 + 통합 Inbox 보상) | oort P8/P9보다 급진적 — 참고 가치 |
| "facts decide, timers are a last-resort backstop" / "Never go dark." / "the agent did [verb] to [object] → [outcome]" | 에이전트 감독 UX의 지배 프레임 — §6 상흔에서 도출된 원칙 |
| "Isolation is proven, not asserted" — 멀티테넌시를 TLA+/Tamarin+런타임 conformance로 증명 | 형식기법을 게이트로 쓰는 태도 — §7 게이트 갭 참조 |
| "New message type? New kind integer. Zero breaking changes." | 실제로는 kind별 특례가 relay에 축적되며 침식 — oort의 REST+스키마가 더 싸다 |

## 3. 구조 비교 — 겹치는 포지션과 oort의 강점

같은 결정: PG=SoT(둘 다 "이벤트 로그는 PG, P2P 아님") · 에이전트=1급 멤버 · provider 자격증명 비유입 · self-hosted 주권 · 데스크톱 우선(buzz의 web은 레포 브라우저+초대 수락 전용).

다른 결정과 oort 우위(아키텍처 분석 확증):

| 축 | buzz | oort 우위 |
|---|---|---|
| **순서** | 서버 seq 발급 불가(서명이 created_at을 덮음) — 클라 자기신고 1초 해상도±900s 수용창, 복합 커서·커밋타임 fence 트리거·CLI의 `sleep 1` 보정이 겹겹이 필요 | `message.seq` 전역 단조가 이 문제 전체를 원천 제거 |
| **전달 보장** | outbox 없음 — 저장 후 fan-out·검색·감사·워크플로 트리거 전부 fire-and-forget, `delivery_log`는 "Rust module pending", 푸시는 명시적 lossy | REST→PG→outbox→relay가 seq 기반 resume/replay를 결정론 제공 |
| **격리 집행** | RLS 스키마는 증명된 '목표 상태', 현행 집행은 앱 레이어. 인증 성공 시 14 scope 전부 부여, rate limit은 trait만 존재 | RLS FORCE가 DB 레벨에서 이미 집행 중 |
| **불변 이벤트 세금** | 편집·삭제·스레드 요약·DM 숨김까지 이벤트/overlay/kind로 — "메시지 페이지 하나"에 300줄 NIP | SQL UPDATE와 REST 계약으로 같은 결과를 훨씬 싸게 |
| **identity** | 키 분실=계정 소멸("no forgot password"), 디바이스 추가에 전용 사이드카 relay+SAS 페어링 필요 | 서버 관리 identity — 팀 메신저 맥락에서 운영상 압도적 단순. 대신 이식 가능한 평판·서명 증명은 포기하는 트레이드 |
| **전송** | fan-out이 relay 인프로세스 → 멀티노드가 Redis 왕복+local-echo dedup+iroh QUIC 메시 자체 3층 | Centrifugo 분리로 기성품에 위임 |
| **클라 품질** | Tauri — day-1에 WebKitGTK 코어덤프·AppImage 크래시 이슈 유입, 랜딩 페이지 CPU 폭주 조롱 | 네이티브 Swift가 이 리스크 회피 |
| 비전-구현 갭 | 승인 게이트가 UI까지 있는데 executor가 suspend 미영속 → 해당 런 Failed 처리(정직하게 문서화는 함) | oort 거버넌스(Accepted ADR 없이 경계 머지 금지)가 반쪽 기능 배포를 구조적으로 방지 |

## 4. 커뮤니티 반응 (2026-07-22, 런칭+36h)

- 체감 논조: 회의/냉소 ~60%(상당수는 제품이 아닌 Dorsey 불신+AI 버블 피로), 호기심/호의 ~30%. HN 런칭 스레드 316pt/272cmt.
- **칭찬**: ①셀프호스팅/주권("We dropped Slack because we couldn't self-host") ②에이전트 신원·감사추적이 실존 문제라는 인정(Slack 직원도 동의) ③"미래의 엔지니어링 조직" 방향성 ④Slack 피로 대안 갈증 ⑤무한 중첩 스레드 — *"깊은 스레드는 사람에겐 고통이지만 자율 에이전트 간 장시간 협업에는 거대한 승리"*(Block 개발자).
- **비판**: ①**Nostr 회의론이 최대 기술 쟁점** — "crypto on top of my crypto", "no team chat ever has this issue" ②"결국 챗방의 봇" 반사 반응(README 스스로 "We're sorry" 자조) ③**멀티 에이전트 권한/정보누출** — Slack 직원의 "그룹 A·B에 걸친 에이전트는 A 멤버에게 뭘 말해도 되나"에 설득력 있는 답 못함 ④스코프 비대("incremental adoption 불가") ⑤"slopfest" 품질 우려+랜딩 성능 조롱.
- **oort 시사점**: buzz가 맞는 지점이 oort 차별화 지점 — (1) 프로토콜을 이념으로 팔지 말고 "지루하고 검증된 스택 + seq/감사/운영 단순성"이라는 결과로 어필 (2) "bots in chat rooms" 반박은 문구가 아니라 구체 데모(receipts) (3) **RLS FORCE+member 권한 모델이 커뮤니티 최상위 미해결 질문에 대한 구조적 답** — 문서/데모 전면에 세울 것 (4) 메신저 집중+기존 도구 연동이 도입 경로 우위 (5) 마감 품질 자체가 신뢰 신호 — taste/design-review Blocker 0 게이트 유지 근거 (6) 셀프호스팅 수요는 실존하고 과소어필되고 있다.

## 5. 가져갈 프로토콜/인프라/로직 요소 Top 10

1. **페이지네이션 계약(NIP-CW)**: `limit+1` 프로브로 서버가 `has_more`를 사실로 선언(클라 추론 금지), 한 페이지의 반응·삭제·편집·스레드 요약을 2-hop closure로 동봉(1왕복), **"페이지=불변 이력, 라이브 이벤트=별도 구독 렌더타임 머지, 재연결 시 page 0만 재요청"**. oort는 seq 덕에 커서는 더 단순 — closure·has_more·불변페이지+라이브오버레이 분리를 Swift 클라 계약으로 이식.
2. **오너 위임·회수 캐스케이드(NIP-OA/AA)**: 에이전트 키≠오너 키(폭발 반경 격리), 오너 서명 능력 태그로 에이전트에 **영속 레코드 없는 가상 멤버십** — 오너 멤버십 회수=그 오너의 모든 에이전트 접근 즉시 소멸, 별도 정리 불필요. ADR-0131 agent_profile 원장에 owner→agent 위임·회수 캐스케이드를 넣을 근거 모델.
3. **에이전트 상태의 데이터플레인화(NIP-AE/AP/AM/AO)**: 기억(오너-에이전트 대칭 암호화 — "오너는 에이전트가 기억하는 모든 것을 항상 읽을 수 있다")·페르소나 블루프린트·턴당 토큰/비용 정산·실시간 텔레메트리를 전부 메시지와 같은 저장/구독 경로에. oort Memory Plane·비용 계정에 "오너 가독성 보장" 속성을 동형 구현.
4. **푸시=인가 객체, 전송은 wake-only(NIP-PL)**: 페이로드는 고정 wake 신호뿐("no event content transits Apple or Google") — 깨어난 클라가 relay에서 정본 fetch. 필터 fail-closed·회수 가능 리스·승인 게이트만 urgent 클래스. oort 푸시의 "relay=SoT, 푸시=손실 허용 wake" 등급 분리로 채택.
5. **Ephemeral 이벤트 클래스**: typing/presence가 DB에 닿지 않는 별도 서브파이프라인(검증→Redis→fan-out만). presence TTL 90s=하트비트 30s×3(1회 유실 무깜빡임). oort에서 "PG 미기록·Centrifugo 직행" 클래스 명시 분리+TTL 비율 참고.
6. **승인의 암호학 체인**: 승인 토큰=CSPRNG UUID를 SHA-256 해시로만 저장, 단일 사용은 `AND status='pending'` UPDATE로 강제, 승인 자체가 서명 이벤트("who said yes and when"). oort 휴먼 게이트에 토큰 해시 저장+승인 레코드+감사 연결 이식.
7. **해시체인 감사 로그**: per-테넌트 `(tenant, seq)` 체인, prev_hash 포함 canonical JSON SHA-256, advisory lock 단일 작성자. 에이전트 행위 추적에 변조 증거성을 붙일 때의 레퍼런스.
8. **RLS 공리 체크리스트 A-RLS-1~5** (§6 참조 — 가장 즉시 실행 가능).
9. **읽음 상태 단조 머지(NIP-RS)**: 디바이스별 슬롯+컨텍스트→timestamp 맵+단조 머지, 읽음 receipt(타인 노출)와 분리, 파생 상태는 서버가 계산해 단일 이벤트로 투영. ADR-0109 계약의 교차 검증 자료.
10. **MCP 라이프사이클 훅 + 에이전트 주권 제약**: `_` 접두 도구로 LLM 비가시 훅(`_Stop`=end_turn 거부권, `_PostCompact`=압축 후 재주입), 단 2.5s 타임아웃·프롬프트당 거부 3회 예산으로 악성 훅이 에이전트를 가두지 못하게. oort 하네스 정지/압축 로직에 대응.

(차점: git refs를 S3 CAS 포인터+조건부 PUT으로 올린 무상태 git 호스팅+TLA+ 증명 — oort 범위 밖이나 방법론 기억. "브랜치=채널, 머지 시 아카이브=코드가 존재하는 이유의 영구 기록"은 제품 아이디어로 강력.)

## 6. 시간적 경험의 노하우 — 상흔 카탈로그 (성재 예감 적중)

`docs/welcome-kickoff-silent-failures.md`(그들의 실패 회고 정본)와 git 고고학에서 발굴. **관통 원칙: "부재(무응답·타이머 만료·캐시 미스·트레이스 미방출)를 사실로 승격하지 마라 — 사실은 즉시 행동, 부재는 fail-closed 또는 백스톱."**

### (a) 에이전트 채널 참여 실패 모드 — oort가 곧 밟을 지뢰밭
- **타이머가 사실을 이기면 거짓 스토리가 영구 기록된다**: 킥오프 리드 에이전트가 15초 타이머 만료로 "팀원들이 늦네요"를 terminal marker와 함께 게시 → 45초 뒤 정상 인사가 와도 정정 불가. 콜드 에이전트 첫 발화 실측 ~60s인데 프로세스 부팅엔 60s를 주고 그보다 어려운 일에 15s를 준 예산 오류까지 회고. → oort 온보딩 연출(P5)의 수용기준에 "facts decide" 반례 3종(거짓 서사/무한루프/침묵) 명기.
- **"반드시 답하라"+"완료 시 멘션하라" = 영구기관**: 두 안전 규칙이 합성돼 21+깊이 "Got it" 무한 루프. Codex에서만 발현 — Claude가 규칙을 재량 위반한 것이 루프를 막은 유일한 요인, 즉 **루프는 전 런타임에 잠복, 한 런타임의 좋은 행동은 운**. 해법=의무의 축소("새 정보를 더할 때만 MUST publish, 침묵이 명시적 성공, bare acknowledgement 금지")를 per-turn 로컬 테스트로. "루프에 빠지지 마라"는 전역 속성이라 에이전트가 따를 수 없어 기각. → oort는 A→B→A 멘션 루프가 1급 위협 — `ignore_self`로 못 잡는다. relay/하네스 계층에 스레드당 연속 에이전트 턴 예산(높게+tracing)을 처음부터.
- **킬스위치가 어떤 제품 표면에서도 도달 불가능했다**: `!cancel`이 정확 매칭 content+p 태그 동시 요구 — 모든 실제 UI 경로에서 상호 배타. **유닛 테스트는 제품이 만들 수 없는 입력 형태로 통과**. → 에이전트 정지/취소는 실제 클라 표면 E2E로 검증, 취소의 의미론(1턴/세션/팀)을 스펙에 선명기.
- **리드 에이전트가 죽으면 아무도 말하지 못한다**: 실패 고지가 실패한 컴포넌트(에이전트 사칭 메시지)에 의존 → 실패 통보 채널은 실패 가능 컴포넌트와 독립(클라 UI 상태로), retryable/actionable 구분.
- **멤버십 0 에이전트는 조용히 유휴**: 스폰 후 멤버십 부여 시 라이브 픽업 검증 + "채널 멤버십 0"을 로그가 아닌 가시 상태로.
- **턴 타임아웃은 시스템이다**: LLM 스톨/도구 실행/취소 드레인/하드캡 하위 상태 구분, 스티어링 도착 시 타임아웃 갱신(운영해야만 나오는 요구), 채널당 pending 캡+지수백오프+dead-letter.
- **하네스 재시작=이벤트 유실 → 부트 리커버리 원장**: 복구 이벤트에 "복구됨" 마커 없이 밀어넣으면 에이전트가 과거를 새 것처럼 응답. oort 에이전트 커서/재개 의미론은 별도 설계 대상.

### (b) 순서/중복/유실
- **하나의 사실이 세 갈래 길로 온다**: 답글 수 배지(relay recount)·패널(React Query)·타임라인(별도 store)이 독립 경로 → "배지는 늘었는데 패널은 빈" 미해결 버그. **oort는 카운트·리스트·타임라인을 전부 같은 seq 스트림에서 파생시키는 구조를 유지하라** — "카운터는 서버가 따로 재계산해 쏜다"는 최적화가 이 계열의 근원.
- **dedup 키에 스코프 누락 → 정당한 전달을 죽임**: bare event id 키잉이 테넌트 간 전달 60초 억제. 모든 dedup/캐시/Redis 키에 워크스페이스/채널 스코프 기본. 캐시 키에 신원 누락 → 암호문 5분 렌더 사건도 동계열("신원 의존 파생 데이터의 캐시 키에는 신원이 들어간다").
- **쓰기 직후 읽기가 인덱싱을 앞지름**: create 응답 후 realtime 반영 전 윈도우의 클라 규약(낙관 캐시 삽입 or bounded poll) 필요.
- **TOCTOU 규율화**: "load-bearing"이라는 단어가 코드베이스 30회+ — 중요 불변식을 주석으로 이름 붙여 병렬 에이전트 워커의 리팩터링 삭제를 막는 최후 방어선. oort 워커 체계에 채택 가치.

### (c) relay 운영
- **재시도 루프+쿼터=세션 전체 마비**: 에이전트 1개의 타이트 재시도가 42KB 로그+전 세션 발행 실패. rate limit을 넣는 순간 **모든 클라(특히 에이전트 하네스)가 rate-limit-aware여야 한다** — 오류 분류(terminal/transient/DNS)+프레임 페이싱+게이트 중 큐 캡+가시적 드롭 계정이 한 세트.
- **존재 유무 자체가 유출**: COUNT 쿼리가 per-event 게이트 우회, 신규 kind의 게이트 레지스트리 미등록 — 읽기 보조 경로는 메인 경로의 게이트를 안 물려받는다. oort도 PG 밖 경로(Centrifugo presence/집계 캐시)가 생기는 순간 같은 클래스 — "새 이벤트 종류 추가 시 게이트 등록" 체크리스트화.
- **재연결 `since-5s`**: 시계 스큐 세금 — oort는 마지막 확인 seq로 재구독(더 강함).

### (d) RLS 공리 체크리스트 (이 보고서에서 가장 즉시 실행 가능)
oort "RLS FORCE" 한 줄 뒤에 있어야 할 실체: **A-RLS-1** 모든 테이블 restrictive policy · **A-RLS-2** non-superuser+NOBYPASSRLS+소유자면 FORCE 필수 · **A-RLS-3** `SET LOCAL` 트랜잭션-로컬 — **커넥션 풀의 tenant 컨텍스트 잔류 금지** · **A-RLS-4** `SECURITY DEFINER`/`leakproof` 함수는 RLS 이전에 평가될 수 있음 — 감사 대상 · **A-RLS-5** unique/FK 제약에 스코프 포함(충돌 결과가 타 테넌트 존재를 누설하지 않게). A-RLS-3·4는 RLS FORCE만으로 안 막힌다. + 미매핑 호스트는 기본 테넌트 폴백 금지·generic reject.

### (e) 푸시/배포
푸시 게이트웨이는 relay와 물리 분리(ADR-0004 동형), **모든 레플리카가 단일 PG 공유로 쿼터 예약이 트랜잭션 — 레플리카 수가 남용 한도를 곱하지 않게**. SQLx `_sqlx_migrations` 테이블이 public 스키마에서 충돌하는 함정, K8s Secret 변경은 파드 재시작 안 함(키 로테이션=명시 rollout), 메트릭 라벨은 닫힌 집합만(카디널리티+PII).

### (f) AI 에이전트 개발 파이프라인 운영 (oort 체계와 직접 비교 가능)
- **AGENTS.md=상흔의 침전층**: 스크린샷 세트 SHA-256 해시 유일성 게이트(같은 뷰 반복 캡처=byte-identical PNG가 "가장 흔한 회귀"), 애니메이션 완료 대기 헬퍼 의무화, 모듈 싱글턴 리셋 레지스트리, 재렌더 상습범 목록. oort CLAUDE.md는 절차 중심 — "실제 일어난 실수+검출법" 층을 축적할 것.
- **게이트 운영 규율**: flaky를 재시도로 마스킹 금지(표면화), 1000줄 파일 ratchet("한도를 올리지 말고 쪼개라" — override마다 사유+쪼개기 예약 주석), **pre-push branch-skew 가드**(origin/main이 이 브랜치가 만진 파일을 바꿨으면 push 차단 — "로컬 통과, CI 실패"의 사전 차단, 20줄 스크립트 그대로 복사 가능), 마이그레이션 버전 충돌(병렬 에이전트의 고전 — oort는 순번 예약제로 이미 방어 중이나 게이트 중복 체크 추가 가치).
- **공급망**: `evalexpr` v13이 MIT→**AGPL 재라이선스된 실제 사건** — oort "AGPL 백본 금지" 하드 룰은 사후 재라이선스 경로를 기계 게이트(cargo-deny/license-checker 상당) 없이는 못 잡는다. **현행 oort 게이트에 없음 — 법무 패키지 후속으로 제안.**
- **반복 수정 클러스터가 예고하는 oort의 5대 예산 지대**: ①경계(IPC/mock/타입 — 최다 수정 파일이 테스트 더블 e2eBridge 231회) ②**에이전트 프로세스 수명주기(managed_agents 클러스터 284회 — 설정 스냅샷 vs 라이브 편집, 스폰/복원 레이스, 실패한 reconcile의 정상 UI 커밋)** — oort agent_profile 원장+스폰 경로가 정확히 이 지대 진입 중 ③타임라인 렌더링(역방향 무한 스크롤+실시간 append+스레드 오버레이 조합=어느 스택이든 수십 커밋 늪, 396회) ④조립점(composition root/셸/사이드바) ⑤게이트 그 자체(한 번 만드는 게 아니라 운영하는 것).
- **프로덕션 스택 그대로의 멀티에이전트 벤치**: 오케스트레이터+워커 팀을 실제 relay/PG/하네스로 돌리고 채널을 삭제 대신 아카이브해 forensic 보존, 성능 주장은 미달 시 non-zero 실패("주장을 load-bearing하게"). 격리 하네스 compose는 별도 프로젝트명+고정 container_name 금지 — oort Docker 발열 문제의 정석 처방과 일치.

## 7. UX 참고 (UXUI 트랙 제안 후보 — 성재 승인 대기)

buzz IA: Slack 기본기(채널/DM/스레드/⌘K) 위에 **글로벌 표면(Inbox·Pulse·Projects·Agents·Workflows)을 채널보다 위에** 배치, 알림 기본 0+통합 Inbox(Needs Action/Agents 필터), 채널마다 Canvas·Huddle·repo 바인딩. 모바일은 에이전트 **관리를 자르고 감독(activity 열람)만 남김** — oort iOS 축소 우선순위와 동일 판단.

제안 Top 5 (에이전트 원보고서 우선순위 채택):
1. **에이전트 작업신호 3종 세트 (최우선)**: ①사이드바 채널행 working 배지+경과시간 ②컴포저 하단 "{김인턴}: {현재 작업 헤드라인}" 회전 바(2.2s) ③typing과 구분되는 턴 liveness 마크. 모든 표면이 단일 `agentWorkingSignal` 모듈을 소비(관측 이벤트 1차, typing 폴백)하는 패턴째로. ADR-0104(프레즌스) 공백을 정확히 채우는 저비용·고체감.
2. **활동 피드 분류학**: verb/object/outcome 문장화+12 렌더 클래스(spine 5/판단 4/안전망 3), "Failures rise; reads recede", "Never go dark", polished/raw 2단 줌 — oort 에이전트 활동 피드 ADR의 골격으로 채택하면 티켓이 잘게 쪼개진다.
3. **소유자 표기+수신 게이트**: 에이전트 메시지 헤더 "managed by 성재"(owner 프로필 팝오버), 생성 다이얼로그 "Who can talk to this agent"(owner-only 기본/Anyone/Allowlist). agent_profile 원장에 owner가 있으니 UI 비용 최소 — **책임과 통제의 가시화**이자 커뮤니티 최대 쟁점(§4-③)에 대한 표면 답변.
4. **빈 채널 인트로에 'Create agent'를 'Add people'과 동급 배치** + 첫 실행 스타터 에이전트 연출(단 §6-(a) 반례 3종을 수용기준에).
5. **diff 카드 1급 메시지 타입**(파일경로 헤더·400px 스크롤·truncation 정직 배너·확대 뷰). 브랜치=채널(Forge)은 후순위, "머지 시 채널 아카이브=결정의 영구 기록"만 김인턴 작업 스레드 종결 UX로 축소 이식 검토.

반면교사: buzz의 read state는 클라 로컬+replaceable 이벤트 동기화 — 멀티디바이스 unread가 구조적으로 약함(oort ADR-0109 서버 단일 진실이 정답임을 역증명). 에이전트 관리 UI 200+ 파일(EnvVars/Provider/MCP 패널)은 "운영자=개발자" 제품이라 허용되는 복잡도 — oort는 ADR-0131 간편 생성 노선 유지, 가져올 것은 패널이 아니라 **페르소나 카탈로그(에이전트 구성=복제 가능한 자산, 스냅샷 export/import/URL 공유)라는 상위 추상**.

## 8. 제안 액션 (전부 성재 결정 대기 — 티켓/정본 반영 없음)

1. **[게이트] RLS 공리 A-RLS-1~5 검증 스크립트** — §6-(d). 특히 커넥션 풀 잔류(A-RLS-3)·SECURITY DEFINER(A-RLS-4)는 현행 RLS FORCE가 못 잡는 갭. 게이트 티켓 1장 후보.
2. **[게이트] 라이선스/공급망 게이트** — AGPL 사후 재라이선스 검출(evalexpr 실사건). 법무 패키지 후속으로 자연 편입.
3. **[게이트] branch-skew pre-push 가드** — 병렬 워커 5 체제 즉효약, 20줄.
4. **[설계] 에이전트 상호작용 안전 계약** — A→B→A 멘션 루프 예산(relay 계층)+킬스위치 실표면 E2E+발화 의무의 per-turn 테스트화. 에이전트 온보딩 배치(534~539) 후속으로 자연 연결.
5. **[UXUI] §7 Top 5를 ENGINE_HANDOFF/UXUI 큐 제안으로** — 1·3번이 최소비용 최대체감.
6. **[전략] 포지셔닝 문서에 §4 시사점 반영** — "멀티 에이전트 권한 질문에 대한 구조적 답=RLS FORCE+member 모델"을 공개 서사의 전면에.
7. **[관찰] buzz 추적 유지** — 런칭 36h 시점 분석이므로 4~6주 후 재방문(외부 기여 유입·Nostr 세금 논쟁의 향방·승인 executor 완성 여부).

원자료: 이 문서는 4축 병렬 분석(아키텍처/고고학/커뮤니티/UX) 보고서의 종합 요약이다. 상세 근거(파일 경로·커밋 해시·인용 URL)는 각 절에 압축 반영했다.
