# ADR-0122: 음성 허들과 회의 지능 — LiveKit 미디어 + 에이전트 Work 회의록

- Status: **Accepted** (2026-07-18, 성재 — D1-A(LiveKit)+D2-A(임시 허들)+D3(v0→v1→v2) 승인 "ㄱㄱ". V-1부터 순차 발급)
- 증보: 2026-09-26 허들 2.0(성재 「전부 권장대로 가자」) — 미디어 위치, 목표 A 범위(P0·P1), 유령 정리 스윕, 기록 메시지·사이드바 필드 계약. 파일 끝 「증보 2026-09-26」 절
- 관련: `research/15-platform-expansion/05-voice-huddles-meeting-intelligence.md`(조사 원문·출처), `04-threads-reactions-audit.md`(허들 스레드 게시의 전제), ADR-0111(Work=agent_run — v2 요약의 실행 개체), ADR-0002(compose 레이어링), ADR-0113/0116(녹음 산출물 저장은 Drive 트랙 동결 계약과 합류), ux-bible P8·P14
- 발단: 성재 발제(2026-07-15) "스레드 허들이나 디스코드처럼 음성 채널 + 가능하면 메신저 레벨에서 회의록과 요약 기반 액션아이템 도출"

## Context (요지 — 근거는 research/15-05)

1. **Slack 허들조차 Amazon Chime SDK 위탁**이다. 허들의 본질은 미디어 기술이 아니라 "채널에 바인딩된 임시 룸 + 수명주기의 채널 환류"라는 데이터 모델이고, 그 데이터 모델은 oort가 이미 잘하는 것(PG SoT + outbox + 채널 원장)이다.
2. 동체급 선례가 수렴한 분업: **메신저가 룸 수명주기·권한·토큰을 소유하고 SFU는 미디어만**(Element Call 패턴). Mattermost Calls는 "메신저+미디어 데몬+job 오프로더+whisper.cpp 전사"라는 파이프라인 전체의 동형 선례다(단 rtcd/offloader는 AGPL — 코드 참조 금지).
3. permissive 제약에서 미디어 백본 후보는 사실상 **LiveKit(Apache-2.0)** 하나로 압축된다: 단일 노드 의존성 0, TURN 내장(기업망 60~85% relay 필요 — 필수), Swift/JS SDK·녹음(Egress)까지 같은 라이선스. Janus(GPL-3)는 금지 대상, ion-sfu는 중단, Jitsi는 풀스택 과대, mediasoup은 반자작 경로.
4. 15인 음성 worst case ≈ 6.7Mbps — 기존 단일 VPS에 컨테이너 하나로 충분. 요약/액션아이템은 **신규 인프라 0** — oort의 기존 agent_run(승인/비용/감사)이 실행 개체다. Slack이 유료 add-on으로 게이트한 지점을 oort는 원장 게이트로 자연 흡수하며, 수행 주체가 1급 멤버 에이전트라 agent-native 원칙(봇 래핑 금지)과 정합.

## 착수 조건 충족 실측 (2026-07-18 재기안)

초안의 착수 조건("웹 첫 배치(0119 W)와 푸시 서버측(0120 P) 뒤")이 충족됐고, 전제를 코드로 재확인했다:

1. **선행 트랙 완료**: 웹 v0 완주(MOMO-401 종결), 푸시는 서버·relay·iOS 클라이언트(P-1~P-4)까지 전 체인 랜딩. **PushRelay가 실물**이므로 "허들 시작" 알림을 기존 notifier 판정에 후속으로 얹을 수 있다(v0 필수 아님 — 후보 기록).
2. **스레드 전제 성립**: `message.root_id` + `thread` 테이블 + thread 인덱스가 001부터 기존재하고 컨텍스트 조립이 이미 소비 중 — D2-A의 "산출물 허들 스레드 게시"는 스키마 신설 없이 가능(전송 REST의 root_id 개방 범위는 V-1에서 실측·필요 시 동티켓 개방).
3. **클라이언트 3종 시대**: 초안 이후 iOS v0(ADR-0123)가 랜딩 — V-3(macOS 허들 UI) 뒤에 **V-3b(iOS 참가 UI, livekit swift SDK 공용)** 를 예약한다. iOS는 참가·청취 우선(시작은 후속).
4. **인프라 전제**: compose에 Redis 없음(v1 Egress 때 추가 — 예상대로), huddle 스키마 없음(V-1 신규 migration), ADR-0121 S-1 install.sh가 랜딩돼 있어 V-2의 "설치 반영 지점"이 실물로 존재.
5. **파이프라인**: 구현=codex worker(5.6 sol medium), 리뷰·게이트·머지=Fable(현행 계약). V-3/V-3b는 clients 파일군이라 UX 트랙과 발급 시점 조율(현재 UX는 worktree 분리 안착 — 충돌 리스크 낮음).

## Options

### D1. 미디어 백본
- **A (권고) — LiveKit 채택**: compose에 livekit-server 컨테이너 1개(v0), 내장 TURN 활성화. 시그널링은 LiveKit 자체 WS+JWT — Centrifugo는 대체하지 않는다(전송전용 불변 유지: 허들 시작/참가자 변동/녹음 이벤트만 outbox→relay 브로드캐스트).
- B — Galene(MIT): 초경량이나 공식 Swift SDK 부재. **기각.** / C — 외부 통화 링크 위임(Zulip식): 녹음·회의록을 제품이 통제 불가 — agent-native 회의록 목표와 충돌. **기각.** / D — 자체 SFU: Discord 반증(전담 조직 다년 투자). **기각.**

### D2. 세션 모델
- **A (권고) — Slack형 임시 허들**: 채널/DM에 바인딩된 ad-hoc 세션, 마지막 퇴장 시 소멸, 세션 이력·참가 기록은 PG `huddle` 레코드(REST 단일 쓰기 경로)로 원장화, 산출물은 허들 스레드에 게시(스레드 REST 개방이 전제 — 15-04 제안과 합류).
- B — Discord형 상시 voice 채널: 상시 룸 상태 관리 비용. **기각(v0)** — 수요 확인 후 재검토.

### D3. 단계
- **v0 음성 허들(N≤15)**: livekit-server + REST 수명주기/JWT 발급 + macOS UI(UX 트랙 조율). 신규 인프라: 컨테이너 1, TURN 서브도메인+TLS 1. E2EE 시도 금지(WebRTC 기본 DTLS-SRTP 전송 암호화) — E2EE는 별도 ADR.
- **v1 녹음+사후 전사**: LiveKit Egress(+Redis — 기존 Centrifugo Redis 공유/분리 검토) + whisper.cpp(MIT) 배치 job(참가자별 Track egress → 트랙별 전사 → 타임스탬프 병합 = 화자분리 회피). **동의 UX 필수**(전원 고지+Continue/Leave+채널 시스템 메시지). 산출물 저장은 파일 트랙(ADR-0113/0116) 동결 계약과 합류 — 앞지르지 않는다. 실시간 캡션 제외.
- **v2 요약/액션아이템 Work**: 신규 인프라 0 — 전사 완료 → 채널 초대 에이전트의 agent_run → 승인/비용/감사 게이트 → 액션아이템(담당자·기한·원문 anchor 스키마)을 허들 스레드에 아티팩트 게시. 실체는 프롬프트/출력 스키마/UX 설계.

## Decision (Proposed 권고안)

D1-A + D2-A + D3(v0→v1→v2). 착수 시점은 **웹 첫 배치(ADR-0119 W)와 푸시 서버측(ADR-0120 P) 뒤** — 이 ADR은 방향 고정용이며 Accepted가 즉시 착수를 의미하지 않는다. macOS 허들 UI는 `clients/macOS` — **UX 트랙(성재·momo-main)과 발급 시점 조율 필수.**

## 파생 후보 (Accepted + 착수 결정 후)

| 후보 | 내용 | 비고 |
|---|---|---|
| V-1 | `huddle` 스키마 migration(세션/참가 이력/동의 기록/아티팩트 연결, RLS) + 수명주기 REST + LiveKit JWT 발급 | 서버만 |
| V-2 | compose livekit-server + TURN 도메인/TLS + 버전 핀 + DEPLOY 델타 | infra |
| V-3 | macOS 허들 UI(채널 헤더 시작/참가, live 배지) — livekit client-sdk-swift | **UX 트랙 조율** |
| V-4 | Egress+전사 job 파이프라인(v1) | ADR-0113/0116 랜딩 후 |
| V-5 | 회의록 Work 자동화(v2) | ADR-0114 경계 무관(BYOA 기존 경로) |

## Consequences

- (+) "채널에서 바로 말 걸기"가 permissive 스택으로 성립. 라이선스 리스크 0(전 구성 Apache-2.0/MIT/BSD).
- (+) 회의록·액션아이템이 oort 차별화(실행 원장)의 자연 연장이 된다 — 게이트·감사·비용이 공짜로 따라옴.
- (−) 컨테이너 1개·포트(7880/7881 TCP, UDP range, TURN 443/5349)·도메인 1개 증가 — 셀프호스팅 설치 난이도 소폭 상승(ADR-0121 install.sh에 반영 필요).
- (−) v1 전사 job의 CPU 스파이크(스레드 상한으로 통제)와 한국어 품질 불확실성(staging 실측 게이트).
- 보류: E2EE 음성(별도 ADR), 화상/화면공유(수요 확인 후), 상시 voice 채널, 실시간 캡션.

---

## 증보 2026-09-26 — 허들 2.0: 미디어 위치, 목표 A 범위, 유령 정리·기록 메시지·사이드바 계약

- Status: **Accepted** (2026-09-26 성재 결재). 허들 2.0 계획 초안 §4 Q1~Q5에 권장안을 붙여 올렸고, 성재가 「전부 권장대로 가자」고 답했다.
- 기안: Opus 5.5 worker(#2754)
- 근거 자료: `claudedocs/huddle-2.0/audit-and-plan.md`(현황 감사, Slack·Buzz 조사, DS2 사양 초안, 이슈 H-1~H-15). gitignore 대상이라 로컬에만 있다. 이 절이 결정에 필요한 내용을 옮겨 적었다.
- 발단: 감사 결과 oort-team(Railway)에서는 허들이 동작하지 않는다(템플릿이 LiveKit을 뺐고 api가 503). 일상 사용을 막는 결함이 셋 있다. 모든 허들이 10분에 끊기고, 채널을 옮기면 나가지고, 비정상 종료 뒤 유령 참가자가 허들을 끝나지 않게 한다.

### D-H1. 기본은 Railway 안 LiveKit(TCP 전용), 권장 옵션은 UDP 호스트 분리 (Q1, R1 개정)
- **성재(2026-09-26, 첫 결재 뒤 추가 결정):** 「railway로 먼저 진행하고, 두가지 옵션을 두자. 통화품질에 이슈가 있거나 더 좋은 품질 및 여유가 있는 팀을 위해 vultr도 추천해주는 거지. 그걸 위한 작업까진 진행해도 좋아. 상황에 따라 후속작업으로 진행해도 되고.」 이 결정이 처음 권장안 (b)를 대체한다.
- **기본 경로:** LiveKit(내장 TURN 포함)을 팀 인스턴스와 같은 Railway 프로젝트에 둔다. Railway는 UDP를 라우팅하지 않으므로 **TCP 전용**이다. 시그널링은 HTTPS·WSS, 미디어는 ICE-TCP와 TURN/TLS를 Railway TCP 프록시로 낸다.
  - 알려진 비용: 실시간 오디오에서 head-of-line blocking과 재전송이 생긴다. 공개 포트와 LiveKit이 광고하는 포트를 맞추는 엔트리포인트가 필요할 수 있다. 음질과 설정은 #2759에서 실측해 PR에 적는다.
- **권장 옵션:** 통화 품질에 문제가 있거나 여유가 있는 팀은 LiveKit과 내장 TURN을 **UDP가 되는 별도 호스트**(예: Vultr 서울 소형 VPS)로 분리한다. api는 Railway에 남는다. 문서·템플릿·설치 스크립트는 #2799에서 준비한다. 실제 계정·결제는 owner가 한다.
- **음질 기준과 전환 판단(planner 판정, 위임 범위 안):** 아래 중 하나가 생기면 planner가 owner에게 UDP 옵션 전환을 제안한다. 결제가 따르므로 결정은 owner가 한다.
  - 팀원의 음질 불만이 1주에 2건 이상
  - 계측한 RTT가 300ms를 넘거나, 패킷 손실·재전송으로 음성 지연이 체감될 때(`webrtc-internals` 또는 LiveKit 통계)
  - #2759 실측에서 기본 경로가 서지 않을 때(TURN/TLS 인증서 도메인이나 광고 포트를 맞출 수 없는 경우 포함). 이때는 ICE-TCP만으로 먼저 운영할 수 있는지 보고, 안 되면 같은 절차로 UDP 옵션을 제안한다.
- **전환:** 두 경로는 api의 `MOMO_LIVEKIT_URL`·`MOMO_LIVEKIT_API_KEY`·`MOMO_LIVEKIT_API_SECRET`(와 그에 따른 CSP `connect-src` 오리진)만 바꾸면 오간다. 클라이언트와 스키마는 같다.
- 두 경로 모두 TURN은 oort 운영자가 소유한 서버다. ADR-0165 D3 「제3자 TURN 금지」와 맞는다.
- 기각: LiveKit Cloud. 미디어가 제3자를 거쳐 0165 D3과 셀프호스팅 기둥에 어긋난다.

### D-H2. iOS는 백그라운드 오디오와 잠금 화면까지, CallKit은 후속 (Q3)
- 폰 허들은 참가·음소거·나가기와 함께 `UIBackgroundModes: audio`, 잠금 화면·제어 센터 제어까지 한다(#2768).
- CallKit·LiveCommunicationKit·PushKit VoIP 벨은 후속이다. App Store 심사 요건과 VoIP 푸시 의무(받을 때마다 통화 보고)가 따라오므로 **새 ADR 뒤에만** 착수한다(#2769, 보류).
- 「A님이 허들을 시작했습니다」는 일반 푸시다(#2767).

### D-H3. 목표 A에 P0·P1을 넣는다 (Q2)
- **P0**(허들을 쓸 수 있게): #2757 H-1 10분 종료 제거, #2758 H-2 유령 정리, #2759 H-3 oort-team 배치, #2761 H-5 데스크탑 DMG 마이크 권한.
- **P1**(Slack·Buzz급 경험): #2760 H-4 생성기 노브, #2762 H-6 기록 메시지, #2763 H-7 사이드바 live, #2764 H-8 셸 허들 바, #2765 H-9 참가자·말하는 중, #2766 H-10 사이드바·타임라인·단축키, #2767 H-11 시작 푸시, #2768 H-12 폰 허들.
- **후속(목표 A 밖):** #2799 H-3b UDP 호스트 옵션 준비. 성재 원문 「상황에 따라 후속작업으로 진행해도 되고」에 따른 planner 판정이다. 음질 기준(D-H1)에 걸리면 앞당긴다.
- **P2는 목표 A 밖이다:** #2770 H-14 녹음·전사, #2771 H-15 요약. #2769 H-13 CallKit은 D-H2에 따라 보류.
- 이로써 이 ADR 본문의 「착수 시점」과 Railway 템플릿의 「huddle deferred」는 대체된다. 템플릿 문구는 H-3에서 고친다.
- UX는 계획 초안 §3의 DS2(ADR-0189)·모션(ADR-0179) 사양을 따른다. 진입·사이드바·기록의 아이콘은 lucide `Headphones`로 통일한다. live 신호는 `ok`/`ok-soft`, 말하는 중은 2px `ok` 링이며 반복 pulse를 쓰지 않는다.

### D-H4. 유령 참가자 정리는 notifier 스윕이 LiveKit 방 상태와 대조한다 (H-2, R1 개정)
**결정:** notifier가 LiveKit 참가자 목록과 대조하는 스윕만 쓴다. 새 공개 라우트를 만들지 않는 편이 경계가 좁다. LiveKit 웹훅 수신은 후속이며, 채택하면 이 ADR을 별도로 증보한다.
- 근거: 스윕은 서버 → LiveKit 방향 HTTPS만 쓴다. 배치 형상(D-H1 두 경로)과 무관하게 같다. 웹훅은 인증 없는 새 공개 라우트와 재전송 방어를 요구한다.
- **판정 규칙:**
  - 대상은 활성 허들이다. LiveKit RoomService `ListParticipants`를 API key·secret으로 서명한 서버 토큰으로 부른다. 방 이름은 지금 코드처럼 `huddle_id`(대문자 UUID, `livekit.rs`)다.
  - **유예:** `started_at`에서 2분이 지나지 않은 허들은 판정하지 않는다. 참가자도 `joined_at`에서 2분이 지나지 않았으면 판정하지 않는다. 서버는 LiveKit 방을 만들지 않고(토큰만 발급) 방은 첫 참가자가 접속해야 생기기 때문이다.
  - **연속 두 번 관찰:** 「방 없음」과 「참가자가 목록에 없음」은 **둘 다** 연속 두 번의 스윕에서 관찰해야 행동한다. 한 번의 관찰로는 아무것도 쓰지 않는다. 짧은 끊김 뒤 LiveKit `empty_timeout`으로 방이 잠깐 사라지는 경우를 견딘다.
  - 행동: 방 없음이 확정되면 허들을 끝낸다. 없는 참가자는 `left_at`을 쓴다. 마지막 참가자가 빠지면 사람의 leave와 같은 종료 경로(`huddle_ended` outbox, 단일 tx)를 탄다.
  - LiveKit에 닿지 못하거나 오류가 나면 아무것도 바꾸지 않고 경고만 남긴다.
  - **관찰 상태는 스윕 프로세스 메모리에만 둔다.** notifier가 재시작하면 초기화된다. 오류가 난 회차는 연속을 끊는다(0부터 다시 센다). 둘 다 종료를 늦추는 보수적 방향이고, DB에 새 쓰기를 더하지 않는다.
- **DB 경계(owner 확인 O5 판정):**
  - notifier에 새 RLS 우회 쓰기를 더하지 않는다. 스윕의 **쓰기**(허들 종료, `left_at`, outbox)는 NOBYPASSRLS `momo_app` 역할 연결로, 워크스페이스마다 tx를 열고 `SET LOCAL app.workspace_id`를 한 뒤 한다. RLS가 실제로 그 쓰기를 가둔다.
  - 대상 목록을 찾는 **읽기**(어느 워크스페이스에 활성 허들이 있나)는 전 테넌트를 봐야 하므로 notifier의 기존 `momo_notifier` 연결로 한다. 쓰지 않는다. `approval_sweep.rs` 1단계와 같은 모양이다.
  - AGENTS.md의 예외 목록은 바꾸지 않는다.
  - notifier에 LiveKit key·secret과 `momo_app` 연결 문자열을 새로 배포해야 한다. 배포 템플릿 변경은 #2758의 범위다.
- **시험으로 잠그는 요구 사항**(#2758, 없으면 머지하지 않는다):
  - 시작 직후 방이 아직 없는 허들이 유예 안에서 스윕을 여러 번 겪어도 끝나지 않는다.
  - 유예 뒤 「방 없음」 한 번 관찰로는 끝나지 않고, 두 번째 연속 관찰에서만 끝난다.
  - LiveKit 연결 실패는 관찰로 세지 않는다.
  - 쓰기가 `momo_app` 연결에서 일어나고, GUC가 다른 워크스페이스면 0행이다.
  - 각 조건을 지우면 해당 시험이 실패한다.

### D-H5. 허들 기록 메시지 payload 계약 (H-6)
- 허들을 시작하는 tx 안에서 channel_seq 증가 + `type='system'`(enum `message_type`) 메시지 INSERT + outbox INSERT를 한 번에 한다(단일 쓰기 경로 불변식). 아래 JSON은 기존 `props jsonb` 컬럼에 담는다. 새 컬럼을 만들지 않는다. `huddle`은 이 메시지 id를 가진다(새 migration, 기존 RLS 대상 테이블).
- 종료 때는 **같은 메시지**의 `props`를 갱신하고 기존 `message.edited` 봉투(`momo_messaging::emit_message_edited_in_tx`)로 outbox에 낸다. 새 메시지를 쓰지 않는다. 이 갱신은 사람의 편집이 아니므로 클라이언트는 「편집됨」 표시를 붙이지 않는다(`props.kind='huddle'`로 판별).
- 이 메시지는 허들 스레드의 root다. 산출물(전사, 요약)은 이 스레드에 붙는다.
- `props`(v1):

  ```json
  {
    "kind": "huddle",
    "v": 1,
    "huddle_id": "uuid",
    "state": "live",
    "started_by": "member uuid",
    "started_at": "RFC 3339",
    "ended_at": null,
    "duration_s": null,
    "participant_count": 1,
    "participant_ids": ["member uuid"]
  }
  ```

  - `state`는 `live` 또는 `ended`. 종료 때 `ended_at`, `duration_s`, 최종 `participant_count`를 채운다.
  - `participant_ids`는 한 번이라도 참가한 멤버를 참가 순서로, 최대 50개. 에이전트 멤버도 멤버 id로 들어간다.
  - 메시지 `body`에는 구 클라이언트용 평문(「허들을 시작했습니다」 / 「허들 · 32분」)을 둔다. 클라이언트는 모르는 `kind`나 더 높은 `v`를 만나면 body를 기존 system 행으로 그린다.
  - 필드 추가는 하위 호환(모르는 필드 무시)이다. 의미를 바꾸면 `v`를 올리고 이 절을 증보한다.
  - 녹음 고지(v1 녹음)는 별도 system 메시지이고 H-14에서 정한다.

### D-H6. 사이드바 live 필드 계약 (H-7)
- 채널 목록과 채널 단건 DTO에 아래 필드를 싣는다. 활성 허들이 없으면 `null`이다.

  ```json
  "active_huddle": {
    "huddle_id": "uuid",
    "started_at": "RFC 3339",
    "participant_count": 3,
    "member_ids": ["최대 3개, 참가 순서"]
  }
  ```

- 값은 채널 목록과 같은 RLS·멤버십 필터를 거친다. 보이지 않는 채널의 허들은 드러나지 않는다.
- 실시간 갱신은 기존 허들 수명주기 이벤트(`huddle_started`/`participants_changed`/`ended`)로 한다. 사이드바가 채널별 레일을 구독하지 않으면 같은 모양을 user 레일로 보낸다. 선택은 H-7 PR에 적는다.
- user 레일로 보낼 때는 fan-out 시점에도 채널 멤버십으로 받는 사람을 거른다. 비공개 채널의 허들이 비멤버 레일에 나가지 않는다.
- `packages/momo-core` `serverSurfaces.ts`의 huddles 행 「라우터에 없음(404)」 오기를 H-7에서 고친다.

### D-H7. 영상·화면 공유와 음성 참가 에이전트는 계속 보류한다 (Q5)
- 본문 「보류」 목록을 유지한다. 에이전트는 오디오에 들어오지 않고, 전사 뒤 `agent_run`으로 요약한다(D3 v2).
- Buzz식 음성 참가 에이전트(STT/TTS, barge-in)는 다시 열려면 새 ADR이 필요하다.

### D-H8. 폰 허들의 새 네이티브 의존과 권한 문구 (owner 확인 O3 판정: 이 증보로 충분하다)
- **의존:** 폰 허들은 `@livekit/react-native`와 그 WebRTC 포크(`@livekit/react-native-webrtc`)를 쓴다. D1-A(LiveKit)의 RN 클라이언트 연장이다.
- **라이선스:** SDK는 Apache-2.0, WebRTC 포크는 react-native-webrtc 계열(MIT)로 예상한다. 둘 다 permissive다. 도입 PR이 실제 라이선스를 확인하고 NOTICE 귀속을 반영한다. 예상과 다르면(copyleft 등) 도입하지 않고 이 절을 다시 연다.
- **착수 전 스파이크(#2768 수용기준):** 버전, 라이선스, Expo config plugin과 prebuild 필요 여부, 백그라운드 오디오 지원을 먼저 확인해 이슈에 적는다. 그 뒤에 구현을 시작한다.
- **마이크 문구의 의미 변경:** iOS `NSMicrophoneUsageDescription`의 지금 문구 「oort는 소리를 녹음하지 않습니다…」와 `projectShape.test.ts`의 「마이크 요청 코드 없음」 단정은 허들을 넣으면 거짓이 된다. #2768이 문구를 「허들에서 말하려면 마이크가 필요합니다」 취지로 바꾸고, 시험을 「허들 경로만 마이크를 요청한다」로 고친다. 계획된 변경이다.
- `UIBackgroundModes`에 `audio`가 더해진다(D-H2).
- 스토어 등급 항목(App Privacy, PrivacyInfo, 개인정보처리방침)은 ADR-0187 증보가 정한 대로 M7-S에서 다룬다.

### D-H9. 녹음은 기본 꺼짐, 전사·요약은 P2 (Q4)
- 녹음은 기본 꺼짐이다. 동의 UX(전원 고지, 계속/나가기, 채널 system 메시지) 없이는 켜지 않는다(본문 D3 v1 유지).
- 전사(whisper 배치 self-host 기본)와 요약은 P2이고 목표 A 밖이다. 외부 ASR은 옵트인이며, 켜려면 이 ADR을 다시 증보한다.
- 보존기간과 열람 범위는 H-14 착수 전에 정한다. `legal/privacy-policy.md`가 아직 비어 있다.

### 결재 기록
- **2026-09-26 성재:** 「전부 권장대로 가자」.
  - Q1 (b) UDP가 되는 별도 호스트에 LiveKit과 TURN, api는 Railway(같은 날 추가 결정으로 D-H1처럼 바뀜)
  - Q2 목표 A에 P0·P1 포함
  - Q3 iOS는 백그라운드 오디오와 잠금 화면까지, CallKit은 후속
  - Q4 녹음 기본 꺼짐, 전사·요약은 P2
  - Q5 영상·화면 공유, 음성 에이전트 보류
- **2026-09-26 성재 추가 결정:** Q1을 「Railway 기본 + Vultr 등 UDP 호스트 권장 옵션」으로 바꿨다(D-H1 인용).
- **R1 개정(PR #2794 독립 검수 뒤, planner 판정):** 판정은 위임 범위 안이다.
  - O1: D-H4는 notifier 대조 방식을 유지하고, 웹훅은 후속으로 내렸다.
  - O2: planner가 성재에게 보낸 채팅 원문은 「폰 허들은 어디까지 할까요? 권장은 앱이 켜져 있을 때와 백그라운드 음성, 잠금 화면 제어까지입니다. 전화처럼 울리는 CallKit은 나중으로 미룹니다.」였고, 성재 답은 「전부 권장대로 가자」였다. 그래서 #2768을 P1로 둔다.
  - O3(D-H8 증보로 충분), O5(D-H4 DB 경계, 쓰기는 `momo_app`), D-H1 음질 기준, #2799 후속 판정은 planner가 위임 범위 안에서 판정했다. AGENTS.md는 바꾸지 않는다. 금지 대상은 쓰기 경로의 BYPASSRLS이고, notifier 읽기는 기존 역할 범위 안이다.
  - 방 없음 판정에 유예와 연속 관찰을 더했다(H2).
- 기존 이슈 정리: #1895는 HEAD에서 재현되지 않아 증거와 함께 닫았다. #850은 범위가 구현되어 닫고 잔여를 #2757·#2764로 옮겼다. #1925는 #2760으로, #854는 #2770으로 흡수한다.
