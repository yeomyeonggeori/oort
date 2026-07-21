# ADR-0126: 협업 관전 표면 — 에이전트 작업을 팀이 함께 보고 논의한다

- Status: **Proposed** (2026-07-21, Fable 기안 — 성재 승인 대기)
- 관련: ADR-0114(Interactive Work Console — D2 세션=채널 스레드, D6 터미널+스레드 브리지), ADR-0125(D10 원격 attach — owner-only 계약), ADR-0119(웹 — v1+ Work 표면), docs/planning/2026-07-21-opensource-cowork-diagnosis.md §5
- 발단: 외부 개발자 피드백(성재 전달, 2026-07-21) — "Figma가 패러다임을 바꾼 지점은 개발자·PM·디자이너가 하나의 화면을 보며 논의하는 cowork 시스템. claude/codex도 에이전트니까 hermes처럼 호스팅해 결과물을 모두가 공유·확인하며 작업·논의할 수 있으면 큰 메리트."

## Context

1. momo의 기존 설계는 이미 절반을 달성했다: **세션=채널 스레드**(0114 D2)라 spawn 승인·중간보고·개입 입력·결과 발췌가 전부 팀 공개 원장에 남는다. "에이전트 작업 과정이 개인 블랙박스"가 되는 구조적 문제는 없다.
2. 그러나 **실시간 화면 공유의 핵심인 터미널 attach가 소유자 전용**이다(0125 D10 / MOMO-511 계약: human bearer + session owner only). 팀원은 발췌가 스레드에 올라오기 전까지 실제 진행을 볼 수 없다 — Figma의 "같은 캔버스를 본다"에 해당하는 표면이 없다.
3. 산출물 논의 표면도 빈약하다: 발췌 코드블록·커밋/PR 링크 수준. diff를 카드로 보고 특정 라인에 코멘트를 다는 문법(Figma 코멘트 핀·GitHub 리뷰의 대화 버전)이 없다.
4. 세션 소유는 개인(member)에 고정 — 소유자가 자리를 비우면 팀이 개입을 승계할 수 없다.

## Decisions

### D1. read-only 관전 attach (v0 — 이 ADR의 핵심)
- **A (권고)**: terminal-attach capability에 `mode: observer|controller` 등급 추가.
  - **controller** = 기존 계약 그대로(소유자 전용, stdin/resize/kill 가능).
  - **observer** = 같은 워크스페이스에서 그 세션 스레드를 볼 수 있는 human 멤버라면 발급 가능. **stdout 스트림만** — send_stdin/resize/kill 프레임은 발급 자체가 불가(capability 등급에 각인, 호스트 validation에서 재검증). 동시 N명.
  - 서버는 관전자 수를 세션 realtime에 투영(`observer_count`) → 터미널 뷰에 "관전 3" 배지(Figma 아바타 스택 문법, 정적).
  - 소유자 통제: 세션 단위 `observation: open|owner-only` 토글(기본 open — 채널에 스레드가 이미 공개인 것과 정합). RLS·revoke는 기존 그대로.
- B — 채널 공개 스트림 프록시(서버가 stdout을 채널로 중계): momo 서버 raw 비경유 불변식 위반. **기각.**
- C — 관전은 발췌 카드로 충분: 피드백이 정확히 지적한 갭을 방치. **기각.**

### D2. 산출물 카드 표준 (v0)
- **A (권고)**: 세션 스레드의 산출물을 타입드 카드로 승격 —
  - **diff 카드**: unified diff 렌더(파일별 접기·추가/삭제 라인 수 요약·모노스페이스). 소스는 work.read 발췌와 동일 경로(사용자 검토 후 공유 — D3 경계 유지), 에이전트가 `git diff`를 발췌하면 클라가 diff로 감지·렌더.
  - **커밋/PR 링크 카드**: 기존 링크 렌더를 제목·브랜치·상태 메타가 있는 카드로 승격(GitHub API 조회는 클라 opt-in).
  - 카드 렌더는 macOS·iOS·웹(0119 v1+) 공통 계약 — props 스키마(`artifact_kind: diff|commit|pr`)로 정본화.
- B — 전용 산출물 저장소 신설: 첨부·메시지 원장이 이미 있다. 과설계 **기각.**

### D3. 발췌 앵커 코멘트 (v1 예약)
- 발췌/diff 카드의 특정 라인에 앵커된 답글(`props.anchor: {artifact_message_id, line}`). 스레드 UI는 앵커 배지→해당 라인 하이라이트 점프. 서버는 props 통과만(스키마 검증) — 원장 변경 없음. **v1로 예약**(D1·D2 랜딩 후).

### D4. 워크스페이스 소유 세션 (v1 예약)
- `work_session.owner_kind: member|workspace`. workspace 소유 세션은 admin이 operator를 위임/교대 가능(controller capability가 operator에게 발급). 공유 에이전트 계정(BYOA 워크스페이스 크레덴셜, 0125 D7 L-cred)과 결합하면 "hermes처럼 호스팅되는 claude/codex"가 완성된다. 승인·감사 원장은 기존 그대로(operator가 승인 주체로 기록). **v1로 예약** — v0는 D1 관전만으로 "함께 본다"를 먼저 세운다.

## Consequences

- (+) "에이전트 작업 = 팀의 공개 캔버스" 포지셔닝 완성 — 과정(D1)·산출물(D2)·논의(D3)·소유(D4)의 4층.
- (+) 서버 raw 비경유·자격증명 비유입·RLS 불변식 전부 유지(D1은 capability 등급 추가일 뿐).
- (−) observer 스트림도 클라↔호스트 직결이므로 방화벽 제약 망에서는 D10의 폴백 논의(암호화 중계)를 공유한다.
- 파생(Accepted 시): **MOMO-516**(엔진 — capability mode 등급+observer_count 투영+verifier), **MOMO-517**(macOS — read-only 터미널 뷰+관전 배지+observation 토글), **MOMO-518**(diff/링크 카드 v0 — macOS·iOS 공용 props 계약), iOS 515(관전 뷰)와 합류.
