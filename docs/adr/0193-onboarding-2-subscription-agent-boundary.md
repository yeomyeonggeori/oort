# ADR-0193: 온보딩 2.0 — 한 화면 한 질문·코메토 안내, 구독은 소유자 1인의 개인 에이전트로

- Status: **Accepted** (2026-09-26 성재 결재. 근거는 아래 인용)
- Date: 2026-09-26
- Deciders: 성재
- 결재 인용: 온보딩 2.0 제안서 §6의 질문 Q1~Q8에 권장안을 붙여 올렸고, 성재가 「정할사항은 권장으로 가고, 캡쳐는 귀찮으니까 너가 업계의 다른 사이트나 앱들 화면이나 엔지니어 아티클을 보고 작업해」라고 답했다. Q1~Q8은 전부 권장안으로 확정됐고, 제안서 §7의 레퍼런스 캡처 요청은 철회됐다.
- 기안: Opus 5.5 worker(#2805)
- 근거 자료: 제안서 `claudedocs/onboarding-2.0/brief.md`(§1 현황 감사, §2 Buzz·Aside 조사, §3 구독 연동과 약관, §4 흐름, §5 이슈 후보)와 시안 `claudedocs/onboarding-2.0/mockups.html`. 둘 다 gitignore 대상이라 로컬에만 있다. owner 공유본 시안은 https://claude.ai/artifact/6FQJ6LbTEXNN1j4uYE5nGz 이다. 이 ADR이 결정에 필요한 내용을 옮겨 적었다.
- 증보: ADR-0190 D3(Q4), ADR-0147(Q2), ADR-0185 §5-2·§6(Q6·Q8). 각 파일 끝 「증보 2026-09-26 — 온보딩 2.0」 절이 이 ADR을 가리킨다.
- 증보(이 ADR): 2026-09-27 AI 계정(#2876, #2816 결재) — D2 로그인 버튼 이름, D3 목록 확장 가리킴, Anthropic 약관 판단. 파일 끝 「증보 2026-09-27 — AI 계정」 절
- 증보(이 ADR): 2026-10-03 AI 허브 서버 계약(#3392 AIH-2) — D14 에이전트 읽기 계약(`brain`·`callableBy`·`owner`·`hostOnline`·`brainUnavailableReason`), D15 로그인 직후 대행 등록 엔드포인트, D16 연결 값의 두 단계, D17 Claude 구독 에이전트 등록 기본 꺼짐(#3397 결재). 파일 끝 「증보 2026-10-03 — AI 허브 서버 계약」 절. CLI 실행 허용은 ADR-0190 D3-h
- 증보(이 ADR): 2026-10-03 Claude 구독 에이전트 런타임 차단(#3397) — D18. 같은 날 D17이 미뤄 둔 기존 에이전트의 전달 차단을 닫는다. 파일 끝 「증보 2026-10-03 (2) — Claude 구독 에이전트 런타임 차단」 절
- 참조: ADR-0162 「증보 2 — hosted 1:1 DM 승인」(2026-09-27, #2915)이 D4의 DM 규칙을 잇는다. 소유자와 자기 구독 에이전트의 1:1 DM은 자동 승인되어 전달되고, 타인 DM 승인은 서버가 거부한다.
- 관계: ADR-0004(provider 자격 비유입), ADR-0101(에이전트 = 1급 멤버, 봇 래핑 금지), ADR-0180(기기 연결 QR), ADR-0181(웰컴 킥오프, D5 정적 문구 경로), ADR-0182(토스트 금지), ADR-0187(목표 A, 실기기 푸시 필수), ADR-0188(원격 결정자 = 소유자), ADR-0189(DS2 새벽하늘), ADR-0191 D2(공식 바이너리, 토큰 비열람), ADR-0192 D5(로그인이 든 체크포인트는 소유자 1인 것)

## Context

- 데스크탑·웹 온보딩은 진입점마다 흐름이 따로 있다. 필수 입력 화면은 로그인 2, 초대 3, claim 2이고, 총 화면은 3·7·6이다. 진행 표시는 로그인 전 `n/4`, claim 뒤 `n/2`, first-run은 없음으로 한 흐름 안에서 숫자 체계가 바뀐다. 로그인 경로의 카운터는 `3/4`에서 끝난다.
- 코메토는 첫 화면(S0) 히어로에만 있다. 그다음부터는 카드 폼과 C2-04 작은 락업뿐이다.
- 폰 첫 화면 한 장에 QR, 서버 주소, 초대 코드, 이메일, 비밀번호가 모두 있다. 알림 권한은 로그인 직후 설명 없이 iOS 시스템 창으로 묻는다. iOS는 이 창을 한 번만 띄운다.
- 「첫 에이전트 연결」은 **에이전트가 oort에 멤버로 붙는 일**과 **그 에이전트가 어떤 AI 계정으로 생각하는지**를 한 화면에 섞는다. 구독 연동이 들어갈 자리가 없다.
- 약관(2026-09-26 확인). Anthropic Claude Code 법무 문서는 제3자가 claude.ai 로그인을 제공하거나 Free·Pro·Max 자격으로 요청을 중개하는 것을 금지하고, claude.ai 자격·세션 토큰을 수집·저장·중개하지 말라고 적는다. 최종 사용자가 **수정하지 않은 공식 Claude Code 바이너리**에 자기 구독으로 로그인하는 것은 허용한다. Pro·Max 한도는 개인 사용을 전제한다. OpenAI는 계정 자격 공유를 금지하고, Codex 인증 문서는 프로그램 흐름에 API 키를 권한다. Anthropic의 구독·제3자 정책은 2026년 상반기에 세 번 바뀌었다.
  - https://code.claude.com/docs/en/legal-and-compliance
  - https://code.claude.com/docs/en/agent-sdk/overview
  - https://www.anthropic.com/legal/consumer-terms
  - https://help.openai.com/en/articles/10471989-openai-account-sharing-policy

## Options (구독 연동 경로)

| 선택지 | 내용 | 판단 |
|---|---|---|
| **(a) 이 맥의 공식 CLI 로그인 감지·안내** | oort 데스크탑이 `claude`·`codex` 설치와 CLI가 스스로 보고하는 로그인 상태만 본다. 로그인은 공식 CLI가 끝낸다 | **채택. 구독의 유일한 경로.** 범위는 한 사람의 자기 계정, 자기 맥, 자기가 부르는 에이전트 |
| (b) 서버 금고에 구독 OAuth(ADR-0147 확장) | provider_link 금고가 구독 토큰을 봉인하고 서버가 대신 호출 | **기각.** Claude는 명시 금지(수집·저장·중개), OpenAI는 셀프호스트 서버가 여러 사람 대신 호출하는 것이 공유 금지와 부딪힌다. ADR-0191 옵션 B 기각과 같은 이유 |
| **(c) API 키(BYOK)** | 콘솔에서 발급한 키를 설정 › AI 연결에 넣는다 | **채택. 팀 공용 에이전트의 기본** |
| (d) Claude 공식 원격 위임(ADR-0192 D4) | Claude의 원격 기능으로 넘긴다 | 온보딩에 넣지 않는다. 작업 공간 기능으로 남는다 |

## Decision

### D1. 「구독 연동」은 Claude·ChatGPT 구독을 에이전트의 두뇌로 붙이는 것이다 (Q1)
- oort 자체 유료 플랜(Aside의 자체 플랜 같은 것)은 이 결정의 범위가 아니다. 목표 A는 셀프호스트 팀 인스턴스이고 과금 표면이 없다. 필요해지면 가격·결제·세금·환불을 다루는 별도 ADR을 낸다.
- 그록봇 합류는 지금처럼 「AI 연결」 목록의 한 줄로 남는다. 추론은 그록봇 쪽에서 일어난다.

### D2. 구독은 내 개인 에이전트의 1순위, 팀 공용 에이전트는 API 키가 기본이다 (Q2)
- 2026-08-22 계획 E2의 「구독 연동 1순위, BYOK 폴백」을 대체한다. 약관의 「중개 금지」와 「개인 사용」이 이유다.
- 구독 경로는 (a)만 연다. 서버 금고는 구독 토큰을 받지 않는다(ADR-0147 증보).
- 화면에 「Claude로 로그인」「ChatGPT로 로그인」 버튼을 그리지 않는다. 버튼 이름은 「터미널에서 로그인」이다. 상태 알약은 「CLI가 로그인됨이라고 알렸다」는 뜻이다.
- 로그인은 공식 CLI가 끝낸다. PTY가 서기 전(Phase 1)에는 「터미널에서 `claude` 실행」 복사 버튼과 macOS 터미널 열기를 준다. PTY 뒤(Phase 2, ADR-0190 M1)에는 앱 안 로컬 칸에서 공식 CLI의 로그인이 돈다.

### D3. 데스크탑은 CLI 로그인 상태 확인 명령 두 개를 실행할 수 있다 (Q4)
- 결정 본문은 ADR-0190 파일 끝 「증보 2026-09-26 — 온보딩 2.0」 절이다. 요지: `claude auth status`, `codex login status` 두 명령만 허용목록에 두고, **종료 코드만** 본다. stdout·stderr는 읽지 않고 버린다. 토큰과 자격 파일은 열지 않는다.

### D4. 구독 에이전트는 소유자만 부를 수 있다 (Q3, #2815 OB2-9)
- **대상.** D2의 구독 경로(「이 맥의 Claude Code·Codex」 줄)로 합류한 에이전트다. 합류할 때 서버가 이 에이전트에 호출 범위 `owner_only`를 기록한다. 소유자는 `agent.owner_human_id`(schema_v0)다. 저장 모양(컬럼 또는 기존 JSONB 설정)은 OB2-9가 정하고, 컬럼이면 `server/Migrations/` 신규 migration과 RLS 대상 확인을 따른다.
- **호출의 뜻.** 멘션, DM, 그 에이전트가 참여한 스레드의 답글, 그 에이전트를 향한 작업 요청이 전부 호출이다. 비소유자에게서 비롯된 호출은 에이전트에게 **전달하지 않는다.** 강제 지점은 서버의 전달 경로다. 클라이언트가 멘션 자동완성에서 숨기는 것은 보조일 뿐 경계가 아니다.
- **비소유자에게 보이는 안내.**
  - 멘션이 달린 자리의 스레드에 에이전트 명의로 한 번 답한다. 문구: 「{소유자 표시 이름}의 개인 에이전트예요. 팀이 함께 부르는 에이전트는 설정 › AI 연결에서 붙일 수 있어요.」
  - 같은 스레드에서 같은 사람에게는 10분에 한 번만 답한다. 멱등 키로 잠근다. **planner 판정(2026-09-26, 위임 범위):** 10분 값은 Q3 권장안의 구현 세부다.
  - 게시 경로는 ADR-0181 D5와 같은 **정적 문구 경로**(모델 호출 0, 소유자 구독 사용 0)다. 서버 시스템 라인으로 에이전트 명의를 흉내 내지 않는다(ADR-0181이 기각한 봇 래핑). 쓰기는 channel_seq 증가 + message INSERT + outbox INSERT 단일 tx다.
- **소유자는 바꿀 수 없다.** 설정에 「팀에게 열기」 스위치를 두지 않는다. Anthropic의 사전 승인을 받거나 약관이 바뀌면 새 결정으로 다시 연다. 팀이 함께 부를 에이전트는 API 키로 따로 붙인다.
- **요구 사항 — conformance와 red proof.** 아래 시험이 없으면 구현(#2815)을 머지하지 않는다. 격리 PG에서 실제 전달 경로를 돌린다. 각 시험은 해당 분기를 지우면 실패해야 하고, 그 RED를 PR 본문에 남긴다.
  - 비소유자 멘션·DM 각각 → 에이전트 전달 0건, 안내 메시지 1건. 소유자 검사를 지우면 전달이 1건이 되어 RED.
  - 작업 요청: 전달 0건, 스레드가 없으므로 안내 대신 403(비소유자)/409(킬 스위치)로 거절(planner 판정 2026-09-26).
  - 멘션 없는 스레드 답글: 전달 0건(안내 없음, planner 판정 2026-09-26). 그런 답글마다 안내를 달면 채널 스팸이 되므로 전달 0건만 보장한다.
  - 같은 스레드·같은 사람의 10분 안 재호출 → 전달 0건, 안내 추가 0건. 스로틀(멱등 키)을 지우면 안내가 2건이 되어 RED.
  - 10분 뒤 재호출 → 안내 1건 추가(스로틀이 영구 침묵이 아님).
  - 소유자 호출 → 전달 1건, 안내 0건(가드가 전부를 막지 않음).
  - 안내 게시는 channel_seq 증가 + message + outbox가 한 tx에 있고, 다른 워크스페이스 GUC면 0행.

### D5. 소유자의 맥이 꺼져 있을 때 채널에 보이는 문구
- 구독 에이전트의 두뇌는 소유자 맥의 CLI 세션이다. 세션이 없으면 답이 오지 않는다. 조용히 기다리게 하지 않는다.
- **planner 판정(2026-09-26, 위임 범위):** 이 절의 문구와 규칙은 Q3 권장안(소유자 전용)의 구현 세부다.
- 소유자가 부른 호출이 도착했는데 에이전트의 연결이 오프라인이면, 그 스레드에 에이전트 명의로 한 번 답한다. 문구: 「지금은 오프라인이에요. 맥에서 Claude Code를 다시 열면 답할 수 있어요.」(Codex면 「Codex」). 경로와 멱등 규칙은 D4와 같다. 재연결 뒤 밀린 호출을 이어서 처리한다고 확인되면 「이어서 답할게요」로 바꿀 수 있다.
- 채널의 다른 사람에게 보이는 정보는 「오프라인」까지다. 기기 이름, 위치, 마지막 접속 시각을 문구에 넣지 않는다. 멤버 목록의 상태 점은 기존 presence를 따른다.
- 호출 자체는 버리지 않는다. 연결이 돌아왔을 때 이어서 처리하는지는 기존 hosted 전달 계약을 따르고, OB2-9가 확인해 PR에 적는다. 이 ADR은 새 대기열을 만들지 않는다.
- 비소유자의 호출에는 D5가 아니라 D4의 안내만 간다. 비소유자는 소유자의 맥 상태를 알 필요가 없다.

### D6. 킬 스위치
- 구독 경로는 서버 설정 한 줄로 끈다(이름은 OB2-9가 정한다. 기본은 켬). 약관이 반년에 세 번 바뀌었기 때문이다.
- 끄면: 온보딩 「AI 연결」에서 구독 줄이 사라지고 API 키 줄이 맨 위에 온다. 구독 경로 합류 요청은 서버가 거부한다. 이미 있는 `owner_only` 에이전트에게는 소유자의 호출도 전달하지 않고, 에이전트 명의로 「지금은 이 서버에서 구독 에이전트를 쓸 수 없어요. 설정 › AI 연결에서 API 키로 연결할 수 있어요.」라고 한 번 답한다(D4와 같은 경로·스로틀).
- 다시 켜면 전달이 재개된다. 재개를 알리는 별도 메시지는 쓰지 않는다.
- **planner 판정(2026-09-26, 위임 범위):** 킬 스위치의 존재는 제안서 권장(§3.4-5)이고, 끔 안내 문구와 재개 동작은 그 구현 세부다.
- **요구 사항 — conformance와 red proof.** 아래 시험이 없으면 구현(#2815)을 머지하지 않는다. 각 시험은 해당 분기를 지우면 실패해야 한다.
  - 킬 스위치 꺼짐 + 소유자 호출 → `owner_only` 에이전트 전달 0건, 안내 1건. 스위치 검사를 지우면 전달이 1건이 되어 RED.
  - 킬 스위치 꺼짐 + 구독 경로 합류 요청 → 거부, `owner_only` 에이전트 생성 0건.
  - 킬 스위치 꺼짐 → 클라가 읽는 값이 꺼짐(구독 줄 숨김 근거).
  - 다시 켬 → 소유자 호출 전달 1건.

### D7. 흐름을 줄인다 (Q5)
- 필수 입력 화면은 로그인 1(서버 칩 + 이메일 + 비밀번호), 초대 1(이메일 + 새 비밀번호 + 표시 이름, 링크에서 서버·코드를 채움), claim 2(비밀번호 + 「우리 팀 이름」, ADR-0185 그대로)다.
- 링크(초대·claim·기기)를 열었으면 첫 화면을 건너뛴다. 저장된 서버가 있으면 첫 화면을 건너뛴다.
- 「폰에서도 쓰기」는 전체 화면 단계에서 빼서 첫 대화 채널 안 카드로 내린다. 「나중에」의 재진입 위치는 설정 › 기기다. ADR-0180의 기기 연결 계약은 그대로다.
- 초대 경로에서 워크스페이스에 활성 에이전트가 이미 있으면 「AI 연결」을 건너뛰고 곧장 첫 대화다.
- 「AI 연결」은 기존 「첫 에이전트 연결」 자리를 바꾸는 것이다. ADR-0185 D-C 자리 안이고 스텝 수가 늘지 않는다.

### D8. 폰에 알림 미리 안내 화면을 둔다 (Q6)
- 기기 연결(확인 번호) 뒤, 시스템 알림 창 앞에 한 화면을 둔다. 질문: 「에이전트가 나를 부를 때 알려 드릴까요?」 설명 한 줄: 「계속하면 iOS 알림 허용 창이 떠요. 나중에 설정 › 알림에서 바꿀 수 있어요.」
- **버튼은 [계속] 하나다.** Apple HIG(Privacy › Requesting permission)는 시스템 창 앞의 사용자 화면에 버튼을 하나만 두고, 시스템 창을 거치지 않고 빠져나가는 길을 두지 말며, 「허용」처럼 시스템 버튼과 헷갈리는 라벨 대신 「계속」을 쓰라고 한다. 제안서 시안의 [알림 켜기]/[나중에] 두 버튼은 이 권고와 부딪혀서 고쳤다. 거절은 시스템 창의 「허용 안 함」이 받는다.
- 거절해도 앱은 온전히 쓸 수 있다(App Store 심사 지침 4.5.4). 거절 뒤에는 설정 › 알림에 iOS 설정으로 가는 줄을 둔다.
- https://developer.apple.com/design/human-interface-guidelines/privacy
- ADR-0185 §6의 해석 주석은 ADR-0185 파일 끝 증보 절에 있다.

### D9. 코메토 플랫 표정 6종을 만든다 (Q7)
- 대기, 생각, 기쁨, 당황, 작업 중, 졸림. owner가 고른 **K6 플랫** 캐릭터를 유지하고 플랫 라인아트로 옮긴다. 3D 클레이 표정 시트(`claudedocs/brand-2.0/round3/K6-expressions.png`)는 참고로만 쓴다.
- 제작은 기존 브랜드 파이프라인(`docs/brand/kometto/`, #2732·#2733·#2752)과 codex-image 생성 경로를 쓴다. 정본은 `docs/brand/kometto/`로 승격한다.
- 3D를 다시 여는 것은 이 결정에 들어 있지 않다. 필요하면 따로 정한다.

### D10. 진행 점은 AI 연결까지 한 줄로 잇는다 (Q8)
- 숫자 카운터(`2/4`, `1/2`) 대신 점을 쓴다. 로그인 전, claim 뒤, AI 연결을 하나의 점 줄로 합친다. 첫 화면과 첫 대화에서는 숨긴다.
- ADR-0185 §5-2의 「전체 스텝 = 2」 단정과 `OWNER_ONBOARDING_STAGES` 2칸은 그대로다. 바뀌는 것은 보이는 점뿐이다. 해석 주석은 ADR-0185 파일 끝 증보 절에 있다.

### D11. 온보딩 문법
- **한 화면 한 질문.** 두 선택이 필요한 곳은 첫 화면뿐이다.
- **코메토가 말한다.** 모든 온보딩 화면 머리에 코메토 72px와 말풍선 한 문장(= 그 화면의 질문)을 둔다. 첫 화면·완료·첫 대화만 히어로 크기(데스크탑 280px, 폰 200px)다.
- **상태와 표정은 1:1이다.** 대기 = 질문을 기다림, 생각 = 감지·확인·연결 중, 기쁨 = 완료·감지 성공, 당황 = 오류·오프라인, 작업 중 = 에이전트가 준비 중, 졸림 = 건너뛰고 나중에 할 때. 표정만으로 상태를 전하지 않고 문장이 함께 간다.
- **바닥과 버튼.** DS2 새벽하늘 `canvas` 3정지점(ADR-0189, 값은 `docs/design-system/themes-2.0.md` §2) 위에 질문을 바로 둔다. 입력 그릇만 `surface`다. 주 행동은 잉크 채움, 보조는 테두리, 신호색 오렌지는 진행 점과 포커스에만.
- **모션.** 화면 전환은 line-slide 650ms `cubic-bezier(0.22,1,0.36,1)`, 첫 화면에서 다음 화면은 mask-reveal이다. 코메토는 제자리에서 표정만 바꾼다(120ms 크로스페이드). 감지 성공 때 기쁨 + 꼬리 한 번 흔들기(360ms). reduced-motion이면 전부 끈다.
- **문구.** 코메토의 말은 해요체 한 문장이다. 폼 라벨과 오류는 합니다체다. 건너뛰기 문장은 재진입 위치를 말한다(ADR-0185 §5-3 규율 유지).

### D12. 성공은 에이전트의 첫 말로 잰다
- 단일 활성화 지표: 가입(또는 claim) 완료부터 에이전트 첫 말(오프너 run 게시)까지 걸린 시간. 초대 경로 목표 60초 이내, claim 경로 10분 이내(AI 연결 포함).
- 보조 지표는 단계별 도달·이탈이다. 셀프호스트이므로 서버 로컬 집계만 한다. 외부 원격 측정으로 보내지 않는다.

### D13. 레퍼런스는 공개 자료로 조사한다
- owner에게 레퍼런스 앱 캡처를 요청하지 않는다. 구현 이슈마다 Buzz 소스, 공개 화면 갤러리, 엔지니어링 블로그·아티클을 조사해 「레퍼런스」 절에 2~5개 링크를 적는다. 본문을 직접 확인한 것은 [V], 2차 출처는 [S]로 표기한다.
- oort **구현 결과**의 캡처와 독립 design-review(Blocker 0·High 0)는 그대로 요구한다. 실기기 캡처를 못 하면 `runtime-unverified`로 기록한다.

## 착수 전 확인 항목
- **로컬 CLI 에이전트가 오프너를 말할 수 있는가.** `resolve_welcome_target_in_tx`(`momo-agent/src/welcome.rs`)는 전달 가능한 hosted 에이전트도 웰컴 대상으로 고른다. 그러나 답은 소유자 맥의 CLI 세션이 살아 있을 때만 온다. 세션이 없을 때 첫 대화의 코메토 띠 문구(기본안: 「터미널에서 Claude Code를 열어 두면 인사해요」)와 120초 백스톱은 #2814(OB2-8)·#2817(OB2-11)이 착수 전에 확인해 정한다. D12의 claim 경로 10분 목표는 이 확인에 달려 있다.
- **ACP 어댑터 경로의 약관 위치.** 이 ADR은 공식 CLI 바이너리를 사람이 실행하는 경로만 허용한다. 어댑터(`claude-agent-acp` 등)로 구독 세션을 돌리는 경로는 ADR-0192 「확인 항목」과 같은 질문으로 남는다.
- **소비자 약관의 공유 금지가 소유자 전용 호출에도 걸리는가.** D4는 보수적으로 소유자 한 사람만 부르게 했다. 해석이 바뀌면 D4를 다시 연다.
- OpenAI 약관 원문은 조사 때 403이라 검색 스니펫으로만 확인했다.

## Consequences
- (+) 필수 입력 화면이 로그인 2→1, 초대 3→1로 준다. 초대 경로에서 팀 에이전트가 있으면 가입 한 화면 뒤 곧바로 에이전트가 말을 건다.
- (+) 구독 경로가 약관이 명시 허용한 모양(공식 바이너리, 자기 계정, 자기 사용)에 머문다. 서버는 구독 토큰을 한 번도 보지 않는다.
- (+) 한 번뿐인 iOS 알림 창을 미리 안내 뒤에 쓴다. 목표 A의 실기기 푸시 필수 조건과 맞는다.
- (−) 팀원은 동료의 구독 에이전트를 부를 수 없다. 팀 에이전트는 API 키 비용이 따로 든다.
- (−) 구독 에이전트는 소유자의 맥이 꺼져 있으면 답하지 않는다. D5 문구로 드러내지만 가용성 자체는 소유자에게 달려 있다.
- (−) 데스크탑이 다른 앱(공식 CLI)을 실행하는 첫 사례다. 허용목록 두 줄과 소스 시험으로 가둔다(ADR-0190 증보).
- 파생 이슈(OB2-0~16, 레퍼런스 절 포함):

| OB2 | 이슈 | 내용 | 트랙 |
|---|---|---|---|
| 0 | #2806 | 코메토 플랫 표정 6종·규격 시트 | uxui |
| 1 | #2807 | 공통 틀(KomettoGuide·점 진행·모션) | uxui |
| 2 | #2808 | D0 환영, 링크·주소 한 칸 판별 | uxui |
| 3 | #2809 | D1 로그인 한 화면 | uxui |
| 4 | #2810 | D1' 초대 수락 한 화면 | uxui |
| 5 | #2811 | claim·S1·S2 겉 교체 | uxui |
| 6 | #2812 | 데스크탑 claim 딥링크 | uxui |
| 7 | #2813 | 로컬 하네스 감지(상태 명령 종료 코드) | engine |
| 8 | #2814 | D4 AI 연결 Phase 1 | uxui |
| 9 | #2815 | 소유자 전용 호출·오프라인 문구·킬 스위치 | engine |
| 10 | #2816 | D4 Phase 2 앱 안 PTY 로그인 | uxui |
| 11 | #2817 | D5 첫 대화 코메토 띠 | uxui |
| 12 | #2818 | 폰 연결을 채널 카드로 | uxui |
| 13 | #2819 | 폰 M0 환영 분리 | uxui |
| 14 | #2820 | 폰 M3 알림 미리 안내 | uxui |
| 15 | #2821 | 활성화 지표 로컬 집계 | engine |
| 16 | #2822 | 통합 design-review·실기기 캡처 | uxui |

- 착수 순서: #2806·#2807 → 화면 교체 병렬(#2808~#2812, #2819) ∥ #2813 → #2814 → #2817·#2818·#2820 → #2815(구독 줄 팀 노출 전 필수) → #2816(PTY 뒤) → #2822. #2821은 독립.

## 결재 기록
- **2026-09-26 성재:** 「정할사항은 권장으로 가고, 캡쳐는 귀찮으니까 너가 업계의 다른 사이트나 앱들 화면이나 엔지니어 아티클을 보고 작업해」. 이 ADR에 들어간 권장안:
  - Q1 구독 연동 = Claude·ChatGPT 구독을 에이전트 두뇌로. 자체 유료 구독은 목표 A 밖.
  - Q2 구독 = 내 개인 에이전트 1순위, 팀 공용 에이전트 = API 키 기본.
  - Q3 구독 에이전트는 소유자만 부른다. 팀원 멘션에는 에이전트가 안내 문장으로 답한다.
- **planner 판정(2026-09-26, 위임 범위):** D4의 10분 스로틀, D5의 소유자 맥 오프라인 문구, D6의 끔 안내 문구와 재개 동작은 Q1~Q8에 따로 묻지 않은 세부다. 권장안의 구현 세부로 수용한다.
  - Q4 상태 명령 두 개만 허용목록으로 실행, 종료 코드만, 토큰·자격 파일 비열람(ADR-0190 D3 증보).
  - Q5 로그인·초대 필수 화면을 각 1로, 폰 연결은 첫 대화 채널 안 카드로.
  - Q6 폰 알림 미리 안내 화면을 넣는다(ADR-0185 §6 해석 주석). 버튼 구성은 Apple HIG에 맞춰 [계속] 하나로 기안 때 고쳤다(D8). 화면을 넣는다는 결정은 그대로다.
  - Q7 코메토 플랫 표정 6종을 만든다. 3D 시트는 참고로만.
  - Q8 진행 점을 AI 연결까지 한 줄로. 필수 화면 수와 `OWNER_ONBOARDING_STAGES`는 그대로(ADR-0185 §5-2 주석).
  - 레퍼런스 캡처 요청 철회, 공개 자료 조사로 대체(D13).

---

## 증보 2026-09-27 — AI 계정: 로그인 버튼 이름(D2)·실행 목록 확장(D3)·약관 판단

- Status: **Accepted** (2026-09-27 성재 결재)
- 결재 인용: (1) #2816 최신 코멘트, 성재 2026-09-27 「claude code 구독을 붙일 때 어사이드나 실제 클로드 앱처럼 구글 로그인처럼 클로드 로그인 모달을 띄우고 웹에서 로그인하고 redirect시키면 연동되는 구조를 채택해 줘」. (2) AI 계정 제안서 §6 Q1~Q7, 성재 2026-09-27 「전부 권장대로」. 시안 https://claude.ai/artifact/Y8GWHyaW2Z41bKxKB2uutB
- 기안: Opus 5.5 worker(#2876)
- 근거 자료: 제안서 `claudedocs/ai-accounts/brief.md` §2.3·§4.3·§8·§9(gitignore, 로컬). 아래 약관 인용은 2026-09-27에 1차 출처에서 다시 읽은 원문이다.

### D2 개정 — 로그인 버튼과 모달
- D2의 「화면에 「Claude로 로그인」「ChatGPT로 로그인」 버튼을 그리지 않는다. 버튼 이름은 「터미널에서 로그인」이다」를 이렇게 바꾼다.
  - 버튼은 **「Claude Code로 로그인」**, **「Codex로 로그인」**이다. 누르면 앱 모달이 뜨고, 앱이 숨은 PTY에서 공식 CLI 로그인 명령을 수정 없이 돌리며, CLI가 시스템 브라우저로 claude.ai(또는 ChatGPT) 로그인을 열고 localhost 콜백으로 끝난다(#2816). 명령 목록은 ADR-0190 D3-f다.
  - 「Claude로 로그인」「ChatGPT로 로그인」처럼 **oort가 claude.ai·ChatGPT 로그인을 제공하는 것으로 읽히는 이름은 여전히 쓰지 않는다.** 로그인하는 주체가 공식 CLI라는 것이 이름에 드러나야 한다.
  - 「터미널에서 로그인」은 모달 안의 「터미널로 보기」 접힘 링크로 남는다.
- oort 자체 OAuth 클라이언트로 claude.ai 로그인을 띄우거나 구독 토큰을 받는 구조는 금지다(D2 본문 그대로).

### D3 — 목록 확장
- D3의 결정 본문은 ADR-0190 파일 끝에 있다. 2026-09-27 증보로 D3-d(구조화 출력 허용 필드), D3-e(앱 명령 로컬 실행기, Codex만), D3-f(프로필 로그인·로그아웃 실행), D3-g(시험)가 더해졌다. D3의 「두 명령만」「종료 코드만」은 그 목록들과 함께 읽는다.

### 약관 판단 (2026-09-27, 1차 출처)
출처: https://code.claude.com/docs/en/legal-and-compliance (「Can customers offer Claude Code in their products?」「Using the Claude Code name and logo」「Authentication and credential use」), https://code.claude.com/docs/en/agent-sdk/overview (Note, 「Branding guidelines」, 「License and terms」)

**1. 앱이 `claude -p`(headless)를 사용자 구독으로 띄우는 것 — 예외 밖으로 판단한다. 열지 않는다.**
- 원문(legal-and-compliance): “Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.”
- 원문(같은 절, 예외): “Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.”
- 원문(Agent SDK overview, Note): “Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.”
- 원문(Agent SDK overview): “To drive the same agent loop from a language other than Python or TypeScript, run the CLI as a subprocess with the `-p` flag and `--output-format json`.”
- 판단: 예외가 허용하는 것은 **최종 사용자가 수정 없는 바이너리에 자기 구독으로 로그인하는 것**이다. 앱이 자기 기능(앱 명령)을 풀려고 `claude -p`를 프로그램으로 띄우면, 문서가 Agent SDK와 같은 루프라고 적은 모양이 되고, 그 경우 「제3자 제품에 claude.ai 로그인이나 rate limit을 제공하지 않는다」에 걸린다. 사용자 본인의 기기·본인 결과라는 점은 완화 사유지만, 문서가 그 구분을 두지 않으므로 보수적으로 읽는다. 그래서 ADR-0190 D3-e의 로컬 실행기는 Claude 구독으로 열지 않는다. Anthropic의 사전 승인(“Unless previously approved”)을 받거나 문서가 바뀌면 새 증보로 다시 연다.
- 이 판단은 사람이 로컬 칸에서 직접 `claude`를 쓰는 것(ADR-0190 D2)과 로그인 자체(D3-f)를 막지 않는다. 둘 다 「최종 사용자가 수정 없는 바이너리에 자기 구독으로 로그인해 쓰는」 예외 안이다. 로그인은 “sign-in to a Claude account must complete through Anthropic's own flow”를 따른다. 공식 CLI가 claude.ai 로그인 화면을 열고, oort는 URL·코드·토큰을 보지 않는다.

- **A 레인과의 구분(worker 해석).** workd가 소유자의 구독 프로필로 `claude`를 띄우는 A 레인(ADR-0188·0191 D1, 이 ADR D1·D2)은 이 판단과 다르게 본다. A 레인은 **사용자가 자기 코딩 작업을 원격에서 시키고 결과도 자기 것**이다(Claude Code Remote Control과 같은 모양, 소유자만 부름 D4). 앱 명령 실행기는 **oort 제품 기능이 모델을 백엔드로 쓰는 것**이다. 이 구분은 worker의 해석이고 Anthropic 문서의 문장이 아니다. 더 엄격하게 읽으면 A 레인의 구독 사용도 같은 조항에 닿을 수 있다. 이 위험은 이 증보가 풀지 않고 기록만 한다. 확실히 하려면 Anthropic에 사전 승인·해석을 묻는다(문서의 “contact sales” 경로).

**2. 버튼 문구 「Claude Code로 로그인」 — 조건부로 쓸 수 있다고 판단한다.**
- 원문(legal-and-compliance, 「Using the Claude Code name and logo」): “You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo, or in a way that suggests Anthropic built, endorses, or is partnered with your product.”
- 원문(Agent SDK overview, 「Branding guidelines」, Not permitted): “"Claude Code" or "Claude Code Agent"” / “Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product.”
- 판단: 이 버튼은 「공식 Claude Code가 로그인한다」는 사실을 **평문으로 정확히 말하는 행동 문구**이고, oort의 기능·화면·제품 이름이 아니다. 아래 조건을 지키면 쓸 수 있다고 본다.
  - 평문만 쓴다. Claude·Anthropic 로고, 브랜드 색, 「Sign in with …」식 연합 로그인 버튼 모양을 쓰지 않는다.
  - 기능·섹션·메뉴 이름으로 쓰지 않는다. 설정 섹션은 「AI 연결」, 계정 줄은 「Claude · 개인」처럼 하네스 이름 + 사용자 라벨이다.
  - 모달 문장이 사실을 적는다: 공식 Claude Code가 브라우저에서 로그인을 처리하고, oort는 로그인 정보를 보지 않는다는 것. 제휴·보증으로 읽히는 문장(「Anthropic 공식 연동」 등)은 쓰지 않는다.
- 남는 위험(이 증보 범위 밖, 기록만): ADR-0188 D4의 에이전트 멤버 이름 「성재의 Claude Code · MacBook」은 Agent SDK 브랜딩 지침의 “"Claude Code" or "Claude Code Agent"” 금지와 닿을 수 있다. 에이전트 이름은 기능 이름에 가깝기 때문이다. 이름 규칙을 다시 볼지는 별도 판단으로 넘긴다.

**3. Codex(ChatGPT 구독).** OpenAI의 「제3자 도구 안 ChatGPT 로그인」 명시 조항은 찾지 못했다(제안서 §2.3). 공식 `codex` 바이너리를 app-server로 부리는 것은 OpenAI가 「제품 안 깊은 통합(인증 포함)」용으로 문서화한 경로라(https://learn.chatgpt.com/docs/app-server) 가장 안전한 해석으로 받아들인다. `auth.json` 토큰을 꺼내 직접 부르는 길은 계속 금지다.

### 결재 기록(증보)
- **2026-09-27 성재:** #2816 로그인 모달 결재(위 인용 1), AI 계정 Q1~Q7 「전부 권장대로」(인용 2).
- worker 판단: 약관 1·2·3은 2026-09-27 1차 출처 재확인 결과다. 1(Claude headless 실행기 닫음)은 제안서 Q4 권장안이 「Commercial Terms 확인 뒤에 연다」고 건 조건의 결과이며, 2의 조건은 #2816 구현의 머지 조건이다.

## 증보 2026-10-03 — AI 허브 서버 계약: 읽기 계약(D14)·로그인 직후 대행 등록(D15)·연결 값의 두 단계(D16)·Claude 등록 기본 꺼짐(D17)

- Status: **Accepted** (2026-10-03 성재 결재, 아래 인용)
- 기안: Sonnet 5.5 worker(#3392 AIH-2). 상위 #3388·#3389, 약관 #3390
- 결재 인용(이슈 #3389, 진단 `claudedocs/diag-ai-connect-2026-10-03/report.md` 뒤 AskUserQuestion): 「①AI 입구=사이드바 「AI」 최상위(내 AI 계정·팀 AI 키·에이전트·외부 연결 한 흐름, 설정은 링크) ②「Claude Code로 로그인」 완료 뒤 앱이 합류(공식 CLI `mcp add`)까지 대행해 한 단계로(ADR-0190 D3 허용목록 증보) ③Claude 구독 에이전트=현행 유지(본인 1인·공식 CLI) + Anthropic 해석 문의 ④ChatGPT 구독=내 맥 경로만 유지(서버 보관 닫은 채) + OpenAI 약관 원문 확인해 ADR 기록.」
- 결재 인용(이슈 #3392): 「결재(성재 2026-10-03): 시안대로 구현, 사이드바 「에이전트」 행 유지, 에이전트 이름 기본 `<내이름>-claude`/`-codex`(중복 -2, 만들기 전 편집, 여러 맥이면 -기기).」 시안·계획은 로컬 `claudedocs/ai-hub-2026-10/`(gitignore)이고 이 절이 결정에 필요한 내용을 옮겼다.
- 결재 인용(이슈 #3397, 2026-10-03, 이 증보 작업 중 전달됨): 「Claude 구독 에이전트를 oort가 ACP/`claude -p`로 대신 구동하는 경로는 Anthropic 회신 전까지 「회색·문의 중」, 기본 꺼짐이에요. Codex는 유지.」 이 PR에서는 등록 경로와 상태 필드까지만 반영한다(D17). 이미 등록된 Claude `owner_only` 에이전트의 런타임 차단·안내는 #3397이 맡는다.
- 관계: D2·D4·D5·D6(이 절은 하나도 풀지 않는다), ADR-0162(hosted pairing lifecycle), ADR-0190 D3-h, PR #2940(#2924 차단 — 아래 「유지하는 보장」)

### D14. 에이전트 읽기 계약 — 필드를 명부와 연결 목록에 더한다
- **대상 응답.** `GET /v1/workspaces/{ws}/roster`(별칭 `…/members`)의 에이전트 행, 그리고 `GET …/hosted-agent-connections`와 `…/{connection}`의 연결 행. 사람 행에는 아무것도 붙지 않는다. 서버가 더 오래되면 네 필드가 없고, 클라이언트는 보조 줄을 그리지 않는다(필드 부재 = 「모름」).
- **필드(전부 additive, 에이전트에만, 비밀 없음).**

| 필드 | 값 | 도출(기존 컬럼만, 저장 없음) |
|---|---|---|
| `brain` | `subscription` \| `team_key` \| `external` \| `instance_default` | `agent.invocation_scope = 'owner_only'` → `subscription`(**항상 우선**: 구독 에이전트도 hosted라서 `external`로 읽히면 안 된다). 아니면 hosted 연결이 있거나 `config.execution_mode = 'hosted_dial_in'`이거나 확정된 A2A 카드가 있으면 `external`. 아니면 `agent.model_source = 'instance_default'` → `instance_default`. 그 밖은 `team_key` |
| `callableBy` | `owner_only` \| `everyone` | `invocation_scope`. **보고일 뿐이다.** 강제는 D4의 전달 경로이고 이 필드는 그것을 바꾸지 않는다 |
| `owner` | `{id, displayName}` | **`brain = subscription`일 때만.** `agent.owner_human_id`의 표시 이름 |
| `hostOnline` | boolean | hosted 연결로 들어오는 에이전트(`subscription`·`external`)에만 |
| `brainUnavailableReason` | `claude_subscription_agent_paused` | 두뇌를 이 서버에서 쓸 수 없을 때만(D17) |

- **`hostOnline`은 휴리스틱이다.** 활성 연결의 credential이 최근 10분 안에 Agent Port에 닿았는가(`token.last_used_at`, D5의 `SUBSCRIPTION_AGENT_ONLINE_WINDOW_SECONDS`)다. 열려 있지만 한가한 CLI 세션은 포트를 부르지 않으면 false로 읽힌다. 접속·presence가 아니다. 화면은 「오프라인」이 아니라 「최근 10분 안에 응답이 없어요」 수준으로 쓰고, 이 값으로 호출을 막지 않는다. 질의문은 `momo_agent::HOSTED_RECENTLY_SEEN_SQL` 하나이고, D5 문구를 고르는 후보 질의(`mention.rs`)와 같은 글자임을 단위 시험이 단정한다(둘이 갈라지면 같은 에이전트에 두 말을 하게 된다).
- **게스트.** 게스트는 자기가 채널을 공유하는 에이전트만 본다(명부 질의가 정한다). 이 필드들 중 `owner`는 **소유자가 게스트의 명부에도 보일 때만**, `hostOnline`은 **게스트에게 내지 않는다**(게스트는 이미 `ownerHumanId`도 받지 못하는 경계라서 이 증보가 넓히지 않는다). `brain`·`callableBy`는 구조 정보라 그대로다.
- **새 노출이 아닌 근거.** 명부는 이미 워크스페이스 활성 멤버 모두에게 `ownerHumanId`·`paused`를 준다. 비소유자가 멘션하면 D4 안내가 소유자의 표시 이름을 이미 말한다. D5는 채널의 다른 사람에게 「오프라인」까지를 허용했다. 그래서 `owner`는 구독 에이전트에만(범위를 줄여 둔다), `hostOnline`은 불리언 하나로 둔다. 기기 이름·위치·마지막 접속 시각은 이 필드들에 없다. 워크스페이스 비멤버는 명부 자체가 403이라 아무것도 보지 못한다(교차 테넌트 시험). 게스트의 가시 범위는 명부 질의가 정하고 사실 조회는 그 보이는 에이전트에만 돈다.
- OpenAPI(`RosterMember`, `HostedAgentConnection`)와 DTO가 같은 글자임을 계약 시험이 단정한다.

### D15. 로그인 직후 대행 등록 — `POST /v1/workspaces/{ws}/subscription-agents/register`
- **누가.** 데스크탑 앱이 「Claude Code로 로그인」「Codex로 로그인」 성공 직후 부른다. 게이트는 오늘의 「구독 추가」(`POST …/hosted-agent-connections` + `owner_only`)와 **같다**: 사람 + 워크스페이스 owner/admin. 아니면 403이고, 서버 설정과 무관하게 403이 먼저다. 에이전트의 소유자는 호출한 사람이다(D4: 소유자는 바꿀 수 없다).
- **같은 몸통.** 정체·일시정지 프로필·`owner_only` 표식·pairing 연결·감사 한 줄은 hosted 연결 생성과 **같은 함수**(`provision_hosted_agent_in_tx`)가 한 트랜잭션에서 쓴다. 그래서 PR #2940의 보장(`owner_only` 에이전트는 팀 키로 돌지 않는다. 연결 없는 구독 에이전트의 호출은 작업이 되지 않는다)이 새 경로에서도 같은 행으로 지켜진다. 이 보장의 회귀 시험을 새 경로로 만든 에이전트에 대해서도 둔다.
- **요청.** `harness`(`claude_code` 또는 `codex`), `deviceId`(앱이 만든 임의 설치 id, 8-64자 `[A-Za-z0-9._-]`, 하드웨어 id·비밀 아님), 선택 `deviceLabel`·`displayName`·`handle`(만들기 전 편집). 알 수 없는 필드는 거절한다.
- **이름(결재 2026-10-03).** 기본 표시 이름은 `<내 표시 이름>-claude` / `-codex`, 핸들은 `<내 핸들>-claude` / `-codex`(32자 안). 겹치면 `-2`, `-3`… (최대 20번). 같은 CLI의 에이전트가 이미 다른 맥에 있고 `deviceLabel`이 있으면 `-<기기>`(소문자 영숫자 12자 이내)가 먼저 붙는다. 사람이 `handle`을 직접 정했으면 그대로 쓰고 겹치면 코드 없는 409다(남의 선택을 몰래 바꾸지 않는다).
- **멱등 키 (호출자, 하네스, 기기).** 이 조합에 살아 있는 에이전트가 있으면 같은 에이전트를 돌려준다(`reused: true`, 200). 새 행 0건. 연결 상태에 따라: `pairing_pending`·`detected`·`expired` → 새 값을 만들고 이전 값은 죽인다(`regenerate`). `active` → 값 없이 돌려준다(「이미 있음=질문 생략」). `disconnected` → 같은 에이전트에 새 pairing(ADR-0162 D6의 순차 재연결). `cleanup_pending` → 409 `subscription_agent_cleanup_pending`. 에이전트가 이미 죽었으면(멤버가 비활성) 그 기기 자리를 풀고 새로 만든다. 동시 호출은 advisory lock으로 한 줄이 된다. 저장은 migration 116의 `agent.subscription_device_id`와 `(workspace, owner, harness, device)` 부분 유니크 인덱스다(백스톱).
- **상한.** 호출자·하네스당 살아 있는 구독 에이전트 5개. 6번째는 409 `subscription_agent_limit`. 「본인 1인」(D2)을 문자 그대로 두고 연결 값 발급을 무한히 열지 않는다. 재사용은 상한에 걸리지 않는다.
- **끔(D6).** `MOMO_SUBSCRIPTION_AGENTS_ENABLED`가 꺼져 있으면 409 `error.code = subscription_agents_disabled`이고 아무것도 쓰지 않는다. 클라이언트는 이 코드로 「이 서버에서는 꺼져 있어요」를 말하고 선택지를 숨기지 않는다(계획 §9의 「조용한 숨김이 망가진 느낌의 원인」). 문장 정규식이 아니라 코드로 분류한다.
- **응답.** 201(새로) 또는 200(재사용), `Cache-Control: no-store`. `agent{id,handle,displayName}`, `connection`(비밀 없음), `reused`, 그리고 값을 새로 만들었을 때만 `pairingCredential`·`pairingExpiresAtMs`. 이 `pairingCredential`이 앱이 공식 CLI에 건네는 「연결 값」이다. 서버에는 sha256만 남고 응답에서 한 번만 나간다.
- **감사.** `subscription_agent.registered` 한 줄: 하네스, 재사용 여부, 값 발급 여부. 값·기기 id는 넣지 않는다.
- **약관 선을 넘지 않는 이유.** 연결 값은 **oort 자신의** Agent Port 자격이지 Anthropic·OpenAI 자격이 아니다. 서버는 구독 토큰을 받지도 저장하지도 중계하지도 않는다(D2 (a)). 이 엔드포인트는 「이 맥의 CLI가 이 에이전트의 Agent Port 클라이언트」라는 사실만 서버에 둔다. 한 사람 · 자기 맥 · 자기가 부르는 에이전트 · 소유자만 호출(D4)은 그대로다. 흐름이 한 단계로 줄면 쓰기 쉬워져 노출이 늘 수 있다는 위험(계획 §9)은 상한 5, 끄는 스위치, 감사 한 줄, 본인 1인 고정으로 줄이고, Anthropic 해석 문의는 별도로 진행한다(#3390).

### D16. 연결 값은 두 단계이고, 두 번째는 CLI 명령이 아니다
- ADR-0162 D6은 pairing 값과 active 자격을 **다른 비밀**로 둔다. pairing 값은 15분·1회·핸드셰이크만(대화 읽기·쓰기 없음)이고, 소유자가 `detected` 연결을 확인(`confirm`)하면 별도의 active 자격이 한 번 나간다. 이 증보는 그 구조를 바꾸지 않는다.
- 앱이 쓰는 순서: 등록(D15) → pairing 값을 앱의 자격 저장소에 둔다 → 공식 CLI 등록(ADR-0190 D3-h, 값 없는 고정 템플릿) → CLI가 핸드셰이크해 `detected` → 소유자가 기존 `confirm`으로 승인 → **앱이 저장소의 값을 active 자격으로 바꾼다. CLI 명령을 다시 부르지 않는다**(CLI의 설정에는 값이 없고 헬퍼가 저장소에서 읽는다. ADR-0190 D3-h).
- 구현은 AIH-5다. 이 증보는 서버가 이미 가진 `confirm` 응답(`credential`, 한 번만)이 그 교체에 쓰인다는 사실만 못 박는다. 서버 쪽 새 코드는 없다.

### D17. Claude 구독 에이전트 등록은 기본 꺼짐이고 켜는 것은 인스턴스 운영자다 (#3397 결재)
- **설정.** `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`. **기본 off, 정확히 `true`만 on**이다(없음·빈 값·`True`·`1`·오타는 전부 off). 일반 킬 스위치 `MOMO_SUBSCRIPTION_AGENTS_ENABLED`(D6, 기본 on)와 별개이고, 서버 전체 설정이다(약관 문의 결과를 기다리는 인스턴스 단위 결정이라 워크스페이스 관리자가 다시 열 수 없다).
- **등록.** 구독 에이전트를 만드는 **모든 경로**(D15의 대행 등록 엔드포인트와 `POST …/hosted-agent-connections`의 `owner_only` 생성)가 `harness: claude_code`이고 이 설정이 off이면 409 `error.code = claude_subscription_agent_paused`를 돌려주고 아무것도 쓰지 않는다. 순서: 사람·owner/admin(403) → 일반 킬 스위치(409 `subscription_agents_disabled`) → 이 코드(레거시 생성 경로는 기존 관례대로 트랜잭션 전에 두 스위치를 본다). 클라이언트는 이 코드로 「이 서버에서는 Claude 구독 에이전트가 잠시 멈춰 있어요」를 말하고 선택지를 숨기지 않는다. **Codex(`codex`)는 영향이 없다.**
- **상태 필드.** D14의 명부·연결 목록 행에 `brainUnavailableReason`을 더한다. 값은 `claude_subscription_agent_paused` 하나이고, **Claude 구독 에이전트이면서 이 설정이 off일 때만** 나온다(그 밖의 에이전트·사람 행에는 없다). 상태 보고일 뿐 이 필드가 호출을 막지는 않는다.
- **이 증보가 하지 않는 것.** 이미 등록된 Claude `owner_only` 에이전트에 대한 전달 차단과 채널 안내 문장은 #3397이 구현한다(D4·D6 경로). 이 PR은 그 경로를 건드리지 않는다. 따라서 이 설정이 off인 인스턴스에 기존 Claude 에이전트가 있으면 상태 필드는 「멈춤」을 말하지만 런타임은 #3397 전까지 기존 동작 그대로다.
- 이 증보의 회색 판단은 ADR-0193 약관 판단(2026-09-27 증보)을 바꾸지 않는다. 같은 위험을 기본값으로 먼저 닫는 것이다. Anthropic 회신 뒤 새 증보로 기본값을 다시 정한다.

### 유지하는 보장 — PR #2940 (#2924)
- 연결 행이 없는 구독 에이전트의 소유자 호출, 작업 요청, 환영 대사는 작업을 만들지 않고, 팀 키 실행(`agent_run`)도 만들지 않는다. 시험 `an_owner_call_to_a_subscription_agent_with_no_connection_row_is_never_a_worker_job`는 그대로이고, 새 경로로 만든(연결은 `pairing_pending`) 에이전트에 대한 `a_registered_but_unconnected_subscription_agent_is_never_a_worker_job`를 더했다.

### 시험으로 잠근다
- 격리 PG 적합성(`subscription_agent_conformance_pg.rs`, 컨테이너 `3392-*`): 읽기 계약(네 상태 + 사람 행 무 필드 + 10분 휴리스틱 + 연결 목록 + 다른 워크스페이스 0건), 등록(이름 규칙, 재사용, 값 재발급 시 이전 값 무효, `active`는 값 없음, 감사에 비밀 없음), 게이트(멤버 403·잘못된 입력 400·명시 핸들 409·상한 409), 끔(코드, 쓰기 0, 비관리자는 403), 교차 테넌트, 죽은 에이전트, 4중 동시 호출 → 1행. Claude 등록 기본 꺼짐(409 코드·쓰기 0·Codex 201·상태 필드·켜면 해제)을 포함한다. 각 가드는 지우면 실패하며 PR에 RED를 남긴다.
- 단위: `derive_brain`(owner_only 우선), 기본 이름 후보(32자 안, 적대적 핸들), `HOSTED_RECENTLY_SEEN_SQL` ≡ `mention.rs`.

### 미검증(runtime-unverified)
- 실제 CLI와의 왕복(로그인 → 등록 → `add-json` → 핸드셰이크 → 확인 → 교체)은 AIH-5가 실기기에서 닫는다. 이 증보는 서버 계약만 검증했다.
- OpenAI의 계정 공유 정책 원문 확인과 ChatGPT 구독 경로 기록은 #3390에서 따로 한다.

## 증보 2026-10-03 (2) — Claude 구독 에이전트 런타임 차단(D18)

- Status: **Accepted** (2026-10-03 성재 결재, 아래 인용). 보안·정책 경계 변경이며 수용 근거는 이 결재다.
- 기안: Sonnet 5.5 worker(#3397 engine). UI 표시(「문의 중」 칩)는 #3416이 맡는다.
- 결재 인용(이슈 #3397, 성재 2026-10-03 AskUserQuestion): 「Claude 구독은 답 오기 전까지 보수적 — 사람이 직접 PTY·공식 Remote Control만 「허용」, oort가 ACP/`claude -p`로 대신 구동하는 @내-claude는 「회색·문의 중」 표시·기본 꺼짐, Anthropic 문의 발송.」
- 관계: D17(등록 기본 꺼짐)이 「#3397이 구현한다」며 남긴 부분을 닫는다. D4·D5·D6은 풀지 않는다. 근거 판단은 2026-09-27 증보의 약관 판단이다.

### D18. 설정이 off이면 기존 Claude 구독 에이전트에도 전달하지 않고, 이유를 말한다
- **기준.** 전달 시점마다 에이전트 행에서 판단한다: `invocation_scope = 'owner_only'`이고 `subscription_harness`가 `claude_code`(기록 없음도 같음)이며 `uses_owner_key`가 아닐 때, `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`가 정확히 `true`가 아니면 막는다. 설정이 생기기 전에 등록된 행도 같다(등록 시점·마이그레이션에 의존하지 않는다). Codex와 개인 API 키(`uses_owner_key`) 에이전트는 영향이 없다.
- **이유 코드.** 읽기 계약의 `brainUnavailableReason`과 같은 `claude_subscription_agent_paused`를 쓴다(D17). 새 코드는 만들지 않았다. 멘션 건너뜀 감사(`agent.mention.skipped`)의 reason, 작업 요청 응답의 `error.code`도 이 값이다.
- **막는 경로(서버).**
  1. 멘션·1:1 DM 규칙·스레드 안 멘션: `owner_only_gate`의 새 갈래. 작업(job)을 만들지 않고, D6과 같은 쓰로틀(스레드·사람·문장당 10분 1회)로 에이전트 이름의 한 문장을 남긴다. 「Claude 구독으로 대신 답하는 기능은 Anthropic 확인이 끝날 때까지 쉬고 있어요. 내 작업에서 직접 쓰거나, 설정 › AI 연결에서 API 키로 연결할 수 있어요.」 소유자가 아닌 사람은 기존 D4 문장을 먼저 듣는다.
  2. 일반 메시지의 hosted 수신함 fan-out, 환영 대사 발화자 선택(`resolve_welcome_target_in_tx`), 에이전트 완료 응답의 fan-out: 대상에서 뺀다.
  3. 작업 요청(`POST …/agent-runs`): 409 `claude_subscription_agent_paused`.
  4. 1:1 DM 전달 상태 조회(`hosted_dm_delivery`): `subscription_disabled`로 답한다.
  5. Agent Port: 켜지기 전 쌓인 작업과 수신함까지 막도록 도구 목록을 비운다(D6의 `tool_view_for`와 같은 문). 설정을 다시 켜면 다음 요청부터 복구되고 되돌릴 것이 없다. 조회 실패는 닫는 쪽으로 처리한다.
- **영향이 없는 것.** 「내 작업」의 직접 PTY와 공식 Remote Control은 서버가 구동하지 않으므로 이 설정과 무관하다. 사람이 터미널에서 직접 쓰는 것은 막지 않는다.
- **켤 때.** 인스턴스 운영자가 `true`로 켜면 서버가 시작할 때 경고 로그를 한 번 남긴다(회색 판단·ADR 번호·이슈). 시크릿·토큰은 로그와 사용자 문장에 넣지 않는다.
- **허용하는 것(성재 결재 2026-10-03, AskUserQuestion, 답 원문 「본인 사용이라 허용」).** 멤버 소유 데스크탑 host의 원격 작업 세션(momo-workd → `claude-agent-acp`, ADR-0188 A 레인)은 본인 사용으로 **허용**한다. 소유자가 서명한 지시만 받고, 팀원은 일으킬 수 없으며, 구독 토큰은 서버에 닿지 않는다. 그래서 이 설정이 막지 않고 이 PR도 그 경로를 건드리지 않는다(앞선 「#2786 확인 대기」 서술은 이 결재로 대체됐다). **워크스페이스 단위 host**(팀원 승인으로 남의 구독이 쓰일 수 있는 경우)는 이 결재의 범위 밖이고 후속 이슈 #3431에서 다룬다.
- **DM 전달 상태.** `GET …/agent-dm-delivery`의 `state`는 이 경우 `subscription_disabled`가 아니라 `claude_subscription_agent_paused`로 답한다(멘션 건너뜀 reason·작업 요청 409·`brainUnavailableReason`과 같은 단어). 클라이언트는 `packages/momo-core`의 `dmComposerHint`가 이 값을 「Claude 구독 에이전트는 Anthropic 확인 중이라 지금은 답하지 않습니다」로 읽는다.
- **한계.**
  - 다시 켜면 막혀 있던 작업이 그대로 넘어간다. 켜진 동안 쌓였거나 꺼지기 전에 쌓인 job과 수신함 항목은 이 PR이 만료시키지 않는다(별도 만료 규칙이 없다). 켜기 전에 정리가 필요하면 운영자가 job을 비운다.
  - 사용자의 Claude 구독으로 도는 외부 hosted 에이전트(자기 기기에서 Agent Port에 접속하는 CLI)가 실제로 어떤 구동 방식인지는 서버가 볼 수 없다. 서버가 막는 것은 oort가 전달하는 일뿐이고, 에이전트 행의 `subscription_harness` 기록에 의존한다.
  - 꺼지는 순간 이미 임대(lease)돼 처리 중인 job은 끝까지 진행되고 완료 보고도 받는다. 새 job과 새 수신함 전달만 멈춘다.
  - 에이전트가 쓴 답(게이트웨이 완료)의 수신함 fan-out은 수신자 술어(`owner_only`이면 작성자가 소유자여야 함)상 에이전트 작성 메시지가 `owner_only` 수신함에 닿지 않으므로 이 설정의 관측 가능한 효과가 없다. 같은 설정을 넘겨 두었으나 이 문은 시험으로 잠글 수 없다.
- **시험.** `subscription_agent_conformance_pg.rs`의 `an_existing_claude_subscription_agent_is_not_driven_until_the_instance_opts_in`(기존 Claude 에이전트 + 설정 off → 멘션 job 0·이유 코드·문장 1회·수신함 0·Agent Port 도구 0·작업 요청 409, Codex는 전달, 설정 on → 전달)와 `owner_only_gate` 단위 시험. 게이트가 Claude 설정을 무시하게 바꾸면 첫 단정에서 실패함을 확인했다. 수신함 fan-out은 같은 시험의 수신함 단정(멘션 직전 기준선 대비)으로, 환영 대사 발화자·DM 전달 상태·켜져 있을 때 쌓인 job의 Agent Port 미전달은 `the_claude_pause_also_covers_welcome_dm_state_and_queued_work`로 잠겼고, 각 문을 임시로 열면 실패함을 확인했다. 새 `SendExtras::default()`는 Claude 설정을 켠 것으로 읽히므로 실제 전송 경로(REST 전송·Agent Port 게시)는 설정에서 값을 채우고, 그 밖의 쓰기가 수신함 참조를 만들더라도 Agent Port 도구 목록 차단이 읽기를 막는다.
