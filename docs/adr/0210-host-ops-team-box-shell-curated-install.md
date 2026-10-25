# ADR-0210: Host Ops — 팀 박스의 셸 세션과 큐레이션 설치 (「박스 안만」 셸 · oort 본체는 타입 있는 동작만 · Railway 먼저, 같은 틀로)

- Status: **Proposed** (2026-10-25, 독립 설계 검토 r2 대기. r1은 FAIL(Blocker 0·High 4)이었고 전량 반영했다 — 끝의 「독립 설계 검토 기록」). 보안 경계·공개 API·DB 계약을 바꾸므로 ADR-0100에 따라 Accepted가 구현 머지 조건이다. **Accepted는 배치 승인이 아니다**: 실제 Railway 박스는 #4348 실측이 통과한 뒤에만 올리고, 과금·프로젝트 생성은 owner 승인이다.
- Date: 2026-10-25
- Deciders: 성재
- 기안: Sonnet 5.5 엔진 워커 (#4347, r4 HO-01). 근거 리서치는 `claudedocs/resume-2026-09-23/handoff-1021/research-1021/r4-vm-host-report.md`(gitignore 대상이라 로컬에만 있다. 이 ADR이 결정에 필요한 내용을 옮겨 적었다).
- 결재 인용: 성재 2026-10-21 「적어도 오르트가 호스팅되어 있는 VM에 대해서는 사용자의 허가를 받으면 조금 쉽게 뭔가를 거기에 설치 및 사용할 수 있게 하면 좋을 거 같아.」 · 셸 범위(같은 날 미션 문서에는 「셸 전체」, 이후 결재는 **「박스 안만」**) · 대상 「둘 다 한 틀로」(Railway 먼저, 2026-10-21) · 정정 2026-10-22 「남은 VM의 자원을 활용하는 차원… 박스 실험용 프로젝트를 왜 굳이 만들고」 · 위임 2026-10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 — 원문과 결정별 성격(owner/권장)은 끝의 「결재 기록」.
- 관계: ADR-0100(거버넌스) · ADR-0125(D1·D8·D10·D11 호스트 직물) · ADR-0146(D-4·D-5·D-8·D-10·D-11 사람 기기 키 서명) · ADR-0157(D1~D3 샌드박스 네트워크) · ADR-0184(D2 승인 지점) · ADR-0186(D2·D3 제안·승인·실행) · ADR-0188(D3·D5·D7, §3 불변식) · ADR-0190 · ADR-0191(D2) · ADR-0192(D2·D7 A4 예약) · ADR-0193(D18) · ADR-0197(D1~D3·D5·D9·증보 1) · ADR-0198(서명 요구 플래그 절) · ADR-0200(D1 run 상태 어휘) · ADR-0201(D2·H4-2) · ADR-0203(D6·D7) · ADR-0204(D6·D7) · ADR-0208(두 풀 정리 스위프) · ADR-0004 · ADR-0101 · ADR-0144(D1, ADR-0156이 대체한 D1의 원칙) · ADR-0214(D1)
- 역방향 줄(증보 대상 11개 문서): ADR-0188 · 0192 · 0125 · 0190 · 0191 · 0197 · 0203 · 0157 · 0146 · 0186 · 0204. 각 문서 머리에 한 줄만 달았고 본문 결정은 바꾸지 않았다(아래 「증보 대상」).
- 번호 확인 [V, 2026-10-25]: `origin/main`·`origin/track/engine`·`origin/track/uxui`와 모든 원격 브랜치의 `docs/adr/`는 0206 이상으로는 0208과 0214뿐이고(0206·0207·0209~0213은 파일이 없다), 0210은 이슈 #4347·#4348·#4351 본문에만 나온다. ADR-0208 머리는 0210을 Host Ops로 예약했다고 적고, ADR-0113 증보는 0211을 #4238(개인 앱 토큰 금고)로 참조한다. 이 ADR은 **0210**만 쓴다(PR을 올리기 직전에 다시 확인한다).
- 표기: [V] 이 세션에서 저장소 코드·문서를 직접 읽어 확인(줄 번호는 `track/engine` `5bdecd348` 기준) · [웹] r4 리서치가 2026-10-21에 연 외부 문서(요약 모델을 거친 것이 많아 **설계 규칙의 근거로만** 쓰고 결정의 증명으로 쓰지 않는다) · [추정] 해석 · [권장] 성재의 위임(2026-10-22)에 따라 planner가 확정하는 결정 · [미확인] 실측이 필요한 것(닫는 슬라이스를 함께 적는다) · `runtime-unverified` 실행하지 않음. 이 문서는 설계이고 코드·마이그레이션·인프라를 바꾸지 않았다.
- 용어와 번호: **박스** = Ops 호스트가 도는 에이전트 전용 컴퓨터 · **박스 데몬**(uid A) · **헬퍼**(uid H, `CAP_SETUID/SETGID`만) · **셸 uid**(U) · **세션** = 승인으로 열린 시간 제한 창 · **컨트롤 플레인** = oort api·DB·relay·notifier·push 등 oort 스택. 번호 접두는 하나씩만 쓴다: D1~D12 결정 · I1~I10 박스가 넘지 않는 선 · RULE-1~9 업계 규칙 · RISK-1~10 위험 · R-a~R-d Railway 배치 후보 · RP-n 수용 기준 · HO-nn 구현 슬라이스. 「0125 D10」처럼 다른 ADR의 번호에는 ADR 번호를 붙인다.

## 맥락

### 성재의 요청과 결정 (원문)
- 2026-10-21 요청: 「적어도 오르트가 호스팅되어 있는 VM에 대해서는 사용자의 허가를 받으면 조금 쉽게 뭔가를 거기에 설치 및 사용할 수 있게 하면 좋을 거 같아. 마치 그록봇이나 뮤즈, 닷츠 같은 것들이 그러하듯이 말이야. 그래야 조금 뭔가를 자유롭게할 수 있을 거 같다는 생각이야.」
- 2026-10-21 결재: 셸 범위는 **「박스 안만」**(에이전트 전용 컴퓨터 안에서만 자유로운 셸, oort 본체는 타입 있는 동작만). 같은 날 미션 문서(r4)에는 처음 「셸 전체」가 적혀 있었다. 대상은 **「둘 다 한 틀로」**(Railway를 먼저 실측하고 일반 VM은 같은 인터페이스).
- 2026-10-22 정정: 「남은 VM의 자원을 활용하는 차원… 박스 실험용 프로젝트를 왜 굳이 만들고」. Railway에는 공유 VM이 없고 「설치」는 지금 프로젝트에 서비스를 더하는 일(Hermes 방식)이다. 그래서 **새 Railway 프로젝트를 만들지 않고** oort-team 안 임시 환경에서 망 격리부터 재고, 격리가 안 될 때만 분리를 owner에게 묻는다(#4347·#4348 본문).
- 2026-10-22 위임: 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」

### 풀려는 문제
요구는 서로 다른 두 가지다.
1. **에이전트가 자유롭게 쓰는 컴퓨터(박스).** 도우미 에이전트가 설치·실행을 자유롭게 한다.
2. **사용자 허가로 oort 스택 자체를 바꾸는 일(컨트롤 플레인 변경).** Hermes·MCP 서버·봇 템플릿을 더하고 스택을 올린다. 에이전트가 oort의 마스터 키·DB 관리자 자격·푸시 서명키에 닿는 셸을 가지면 안 된다.

레퍼런스 제품(그록봇·뮤즈·닷츠·마누스)은 모두 컴퓨터를 벤더 제어면과 분리하고, 안전을 승인 횟수가 아니라 **컴퓨터가 닿지 못하는 것**(시크릿·내부망·egress)에서 얻는다 [웹, r4 §2.2, 요약 경유]. oort에서는 그 벤더 자리에 **인스턴스 운영자**가 서므로 남용(스팸·채굴·스캔)의 책임도 운영자에게 온다. **업계 비교 — 레퍼런스에서 가져오는 설계 규칙**은 다음과 같다(r4 §2.3).

| 규칙 | 근거(요약 경유) | 이 ADR의 자리 |
|---|---|---|
| RULE-1 컴퓨터는 제어면과 분리하고 결정 권한은 에이전트 밖에 둔다 | 뮤즈 Sentinel, Claude Code 프록시, Beams | D4 I1~I3, D5 |
| RULE-2 자격은 에이전트가 못 본다 | 뮤즈 authd, Managed Agents vault, Docker 자격 프록시 | D4 I1·I6 (자격 부여는 이 ADR이 열지 않는다) |
| RULE-3 승인은 「밖으로 나가는 결과가 있는 행동」에 걸고, 컴퓨터 안은 대체로 자유 | 그록봇 7범주, 뮤즈 allow/deny/ask | D5 (세션 승인 한 번 → 박스 안 자유) |
| RULE-4 승인 UI는 에이전트 대화 밖이다 | 뮤즈 | D5 (oort는 이미 같은 구조: ADR-0188 D5) |
| RULE-5 승인에는 범위와 시간이 있다 | 뮤즈 5종 범위, 그록봇 10분 만료, E2B·Docker 1~24h | D5 TTL |
| RULE-6 컴퓨트는 소모품, 디스크는 내구 | 그록봇 durable disk, Sprites 체크포인트 | D11 |
| RULE-7 이그레스 통제는 선택 기능이다 → 능력으로 선언하고 정직하게 표시 | 그록봇 Enterprise 전용, Railway Sandboxes 수단 없음 | D4 I7, D8 |
| RULE-8 킬과 감사는 부가 기능이 아니라 1급 | dots 문서 공백 지적 | D6·D7 |
| RULE-9 실패 사례: 프롬프트 지시는 경계가 아니다 | Replit 프로덕션 DB 삭제, OpenClaw 공개 게이트웨이 | D4 I10, D12 |

### 지금 있는 것 [V, track/engine `5bdecd348`]
| 사실 | 근거 | 이 ADR에서의 뜻 |
|---|---|---|
| 호스트 레지스트리: `scope`는 member·workspace, `type`은 app·workd·cloud만 허용, `capabilities`는 불리언 맵, RLS FORCE. 클라이언트 코어는 모르는 `type`을 그대로 표시하고 tier를 `unknown`으로 둔다 | `server/Migrations/021_work_host.sql:10-34`(`:22-23` 두 CHECK), `work_hosts.rs:206-213`, `packages/momo-core/src/features/settings/model.ts:79-85`, `features/agents/agentOps.ts:288-300` | Ops 호스트는 새 `type` 값이 필요하고(가산 변경) 서버가 `capabilities` 자기 보고를 믿지 않는다(D1) |
| workspace-scope 호스트 등록은 owner·admin만 | `work_hosts.rs:504-510`, 모듈 문서 `:27-45` | 팀 박스의 등록 주체와 같은 선 |
| 서명 호스트 요청 v2는 method·path·workspace·host·시각·본문 해시·request id를 덮고 request id는 서명 검증과 같은 tx에서 1회 소비된다. 요청의 주체는 **소유자가 활성 사람인 동안만** 행동한다(역할은 보지 않는다) | `momo-auth/src/work_host_request.rs:1-30`, `:54-72`, `work_host_auth.rs:372-396` | 박스 데몬의 유일한 자격. 등록한 admin이 비활성이면 박스가 조용히 죽고, **강등**은 인증을 막지 못한다(D1-5) |
| 호스트가 서명으로 부를 수 있는 경로는 `is_allowed_signed_path`의 **닫힌 목록**(10개 형태)이고 승인 결정 라우트는 일부러 넣지 않았다. 서명자와 경로의 호스트를 맞추는 **핀은 경로가 `work-hosts/{host}`일 때만 인증기가 건다**. 그 밖의 경로는 핸들러가 핀하고, 인증 결과 `SignedHostRequest`는 host id·owner만 싣고 type·scope는 싣지 않는다 | `work_host_auth.rs:41-45`, `:60-87`(핀 문서), `:130-136`, `:189-287`, `:297-303`(`scoped_host_id_from_path`) | 박스용 서명 경로를 정확히 둘만 더하고 **핀과 type 검사를 새 경로에 직접 건다**(D6-1) |
| R0 방어(소유자만 결정, 에이전트 컨트롤은 `kill`만, `work_auto_approve` 불가, 셸 거절)는 **`scope='member'`에만** 걸려 있다. workspace-scope 호스트는 「이전과 똑같이」 받는다 | `work_controls.rs:32-50`, `work_control.rs:537-575`, `:1268`(셸 거절은 remote=member만) | 팀 박스를 일반 workspace 호스트로 두면 R0이 꺼진 채 셸이 열린다 → 별도 레인(D1) |
| spawn 승인 게이트는 **승인 채널의 활성 멤버**면 누구나 통과한다(결정자 = 소유자는 member 호스트에서만 강제) | `approvals.rs:766`, `work_control.rs:571-575` | 일반 spawn 경로가 팀 박스에 닿으면 채널 멤버 누구나 박스 명령을 승인하는 길이 된다(D1, RP-7) |
| spawn 후보는 revoke되지 않은 **모든** workspace-scope 호스트다(`scope = 'workspace' OR 소유자`) | `work_control.rs:2038-2060`, 미지의 `type`의 tier는 `unknown`(`:116-126`) | 팀 박스가 모든 멤버의 호스트 선택기에 뜬다 → 후보에서 제외(D1) |
| 서명이 필요한 사람 지시의 R2 패턴은 **둘로 갈린다**: 새 작업 spawn은 요청마다 R2를 보고 R2 없이는 403 `signed_spawn_disabled`로 닫히지만, 권한 허락(allow)은 서명이 오면 검증하고 R2에서만 필수다. 끄는 쪽(`kill`·`reject`)은 서명이 필요 없다 | `work_spawns.rs:22-26`, `work_permissions.rs:39-49`, `work_kill.rs:32-37`, `momo-server/src/config.rs:1387-1435` | 세션 열기는 **spawn 쪽**(요청마다 R2 재확인, 꺼지면 닫힘)을 따른다(D2) |
| 서명 문장은 `momo.human.control.v1~v4`이고 **스키마를 넘나들지 않는다**. 웹 브라우저는 지시 표면이 아니라 보기·거부·중단만. `host_register` 본문이 `{host_public_key_b64}\n{host_id}\n{NFC(label)}`다 | `momo-wire/src/human_control.rs:55-66`, `:130-135`, `:147-156`, `:289-329`, ADR-0146 D-4 | 새 kind는 새 스키마 문자열이 필요하고 웹에서는 열 수 없다(D5) |
| 개인 박스 계보: 러너 동사 5개 고정, docker 연산 9개 고정, 고정 템플릿(컨테이너가 root로 시작해 `CAP_SETUID/SETGID`만 남긴다), 박스 데몬 uid 분리·preflight, **박스 데몬 크레이트에는 `pty`·`host`·`register` 모듈이 있고 ACP 코드만 없다**, 셸을 띄우는 `spawn_helper`는 별도 프로세스, 눈먼 PTY 중계(서버 라우트 미배선), 박스 host는 `scope='member'`·`type='cloud'`, 기본 닫힘 `MOMO_CLOUD_BOX_ENABLED` | `momo-box-runner/src/verbs.rs:1-6`, `docker.rs:1-12`, `template.rs:1-11`, `momo-box-agent/src/lib.rs:1-15`, `preflight.rs:1-30`, `register.rs:16-19`, `momo-blind-pty/src/lib.rs:1-9`, `momo-server/src/config.rs:98-109`·`:1325-1346`, 마이그레이션 `118_cloud_box.sql`·`119_cloud_box_runner.sql` | 부품은 재사용하되 **Ops 데몬은 별도 바이너리**다(D12). 결정자·플래그·테이블·라우트도 별개다(D1) |
| 푸시 어휘는 닫혀 있고 `momo.approval.open`(버튼 없음)이 있다. 「앱에서 열어야 하는 승인」은 `opens_in_app` 한 곳이 정한다: 워크스페이스 **행동**은 레지스트리에 없는 id를 열고, **툴 호출**은 `OPEN_IN_APP_TOOL_NAMES`에 이름이 있어야만 연다. 잠금 화면 토큰의 허용 경로는 승인 결정 하나뿐 | `momo-push-relay/src/dispatch.rs:51-74`, `momo-agent/src/actions.rs:310-319`, `:333-406`, `approvals.rs:803`, `momo-auth/src/push_action_token.rs:17-24` | `host.*`는 행동 id와 툴 이름 **두 갈래 모두** 앱에서 연다(D5, D9) |
| 관리형 에이전트의 도구는 `CATALOG` 한 곳(여섯 개, 그중 `WORKSPACE_ACTION_PROPOSE`가 ADR-0186 행동을 제안한다)이고 호출마다 승인이 필요한지는 DB를 보지 않는 순수 함수 `approval_reason`이 정한다. **한 턴에 도구 한 번**이고, 실행하는 도구는 결과를 채널 `tool_result` 메시지(본문·props에 출력 전체)로 쓰고 턴을 끝낸다. 호출 카드(`tool_call`)도 인자 전체를 props로 채널에 쓴다 | `momo-agent/src/tools.rs:220-227`, `:829`, `:912`, `momo-agent-worker/src/tool_exec.rs:89-150`, `:1165-1202`, `momo-agent-worker/src/lib.rs:1446-1520`, `:1861-1880` | 현행 도구 경로를 `host.*`에 그대로 쓰면 명령·출력 전문이 채널 메시지에 영속된다 → **별도 경로**(D9) |
| agent-worker는 BYPASSRLS `momo_worker`로 붙고, 선례는 tx마다 `SET LOCAL ROLE`로 우회 비트를 내린다: 팀 기억 `momo_memory`(SECURITY DEFINER 함수만), 도우미 `momo_helper_read`(NOLOGIN NOBYPASSRLS, 테이블 직접 SELECT, `ws_isolation` 정책이 그대로 적용) | ADR-0201 H4-2, `momo-agent/src/memory.rs:80`, `server/Migrations/100_mem_digest.sql:26-50` | `host.*` 실행기도 같은 모양의 새 역할을 쓴다(D9) |
| 에이전트가 자기 답에 쓴 `@mention`은 **자식 run**을 만들고(`parent_run_id`, 깊이 상한 4), `RunTrigger`는 Mention·ThreadReply·Work·Welcome 넷이다 | `momo-agent/src/a2a.rs:1-40`, `run.rs:161-205`, `server/Migrations/007_agent_run_a2a_guards.sql:33` | 박스 명령은 **사람이 건 루트 run**에서만 나온다(D5-4) |
| `momo-egress`는 **provider·OAuth 호출용 아웃바운드 가드**다(연결 시점 resolver, redirect·프록시 없음). 박스의 egress 통제가 아니다 | `momo-egress/src/lib.rs:1-45` | 박스 egress는 드라이버가 선언한다(D8) |
| Railway 카탈로그는 서비스 10개(postgres·centrifugo·api·relay·webhook-sender·agent-worker·hermes·notifier·push-relay·caddy)이고 api는 변수 **41개**를 가진다. 마스터 키·DB 관리자 URL·APNs 서명키·릴레이 서명키가 서비스별 변수로 있다(이름만 읽었다). api 시작 명령은 root로 시작해 `setpriv`로 `momo`로 내려가며 앱 프로세스 env에서 DDL URL·역할 비밀번호를 지운다(**서비스 변수 자체는 남는다**) | `infra/railway/railway.json:27`(services)·`:62-`(api, `:65` 시작 명령)·`:158-`(hermes)·`:179-`(notifier)·`:197-`(push-relay), README `:387-427` | 박스는 이 변수들을 **만들지 않는 것**으로 막는다(부재 > 필터, D4 I1). 같은 서비스에서 새 `railway ssh`가 변수를 보는지는 [추정] |
| Railway 실측(S1): 프로젝트 토큰은 스코프를 못 좁히고 root exec·변수 읽기/쓰기·시작 명령 변경·서비스 생성이 된다. 같은 프로젝트(같은 환경)의 서비스는 서로 닿고 **별도 프로젝트**는 `postgres.railway.internal`이 NXDOMAIN. 서비스 egress 통제 없음(SMTP 25/465/587 열림). 볼륨은 서비스당 1개, 크기 지정 불가(기본 50GB), 볼륨 백업은 토큰 보유자가 만들 수 있다. **교차 *환경*은 재지 않았다** | `docs/research/S1-personal-box-placement-spike.md`(② 표, 프로젝트 토큰 표) | D8의 승격 조건과 #4348의 입력 |
| Hermes 컨테이너는 도구가 잠겨 있고(`lockgate.py` fail-closed) `/opt/data`에 구독 OAuth와 대화 기록이 있다 | ADR-0203 D6·D7·증보 2026-10-19, `infra/hermes/lockgate.py:184`, README `:186-242` | Hermes에는 셸을 붙이지 않는다(D9) |
| 「launch needs root」: 로그인 중계는 root가 아니면 uid 분리를 못 해 꺼진다. Railway에서 start 명령이 uid를 둘로 나눌 수 있는지는 `runtime-unverified` | `infra/hermes/login_relay.py:1034`, README `:210-216` | 박스 uid 분리의 Railway 성립은 #4348 실측 항목(D8) |
| 설정 › 실행 호스트(목차 `code`)가 워크스페이스 호스트 목록과 기본 재개 정책의 자리이고 `HostPicker`는 재개·인수 때 호스트를 고르는 폼이다 | `clients/web/src/features/settings/WorkHostSection.tsx:22-32`, `settingsNav.ts:104-110`, `features/work/HostPicker.tsx` | 「팀 박스」 카드가 얹힐 자리와 capability 필터 지점(HO-13) |

### r4 보고서와 달라진 곳
- **배치(10-22 정정):** r4 §5.3·§6 D-2는 「별도 Railway 프로젝트(권장)」였다. 성재의 정정으로 **같은 프로젝트의 빈 임시 환경을 먼저 재고, 실패할 때만 별도 프로젝트를 묻는다**(D8). r4의 「별도 프로젝트」는 이제 대체 경로 R-b다.
- **새로 확인한 코드 사실(r4에 없었다):** ① 일반 spawn 후보가 모든 workspace-scope 호스트를 내놓고 workspace-scope 호스트가 R0 밖이라는 점 → 별도 `type`·어휘·DB 트리거(D1). ② 현행 도구 경로가 출력·인자 전문을 채널 메시지로 영속하고 한 턴에 도구 한 번이라는 점, 워커가 BYPASSRLS라는 점, A2A 자식 run이 있다는 점 → `host.*` 별도 경로·새 DB 역할·run 출처 조건(D9, D5-4). ③ 서명 호스트 인증기가 `work-hosts/{host}` 밖 경로의 핀을 걸지 않는다는 점(D6-1).
- **r4의 권장보다 좁히거나 바꾼 결정:** D-6 결정자는 r4 (a) 「워크스페이스 owner·admin 누구나」가 아니라 **요청이 올라온 방의 owner·admin**이다. 서명 필수는 r4처럼 「R2 켜진 인스턴스에서만」이 아니라 **R2가 꺼지면 Ops 자체가 닫힌다**(D2). D-5 동시 세션은 r4의 3이 아니라 **1**이다(D5-5). 박스는 한 신뢰 영역이라 세션 사이 데이터 경계가 없고, 자격 부여 2층 승인은 보류한다(I6).
- api 변수는 40개가 아니라 41개다. 서명 문장은 v4까지 있다(r4는 v3).

## 결정

결정 앞의 태그: **[owner]**는 성재가 직접 정한 것, **[권장]**은 2026-10-22 위임에 따라 이 ADR이 정한 것(PR 본문의 「권장으로 정한 것」 표와 끝의 「결재 기록」에 모두 있다).

### D1. 레인 — Ops 호스트는 `scope='workspace'`·`type='ops'`이고 일반 작업 어휘를 받지 않는다 [권장 — owner 「박스 안만」의 구체화]
1. **정의.** Ops 호스트 = `work_host` 행(`scope='workspace'`, 새 `type='ops'`) + 그 행을 가리키는 `host_ops_box` 행 정확히 하나. 이 쌍은 Ops 등록 경로(D5-9의 페어링)로만 생긴다. 서버는 「Ops인가」를 **이 쌍으로만** 판정하고 호스트가 스스로 올리는 `capabilities`(`021_work_host.sql:28-33`)는 쓰지 않는다. 일반 `POST …/work-hosts`의 허용 값은 그대로(app·workd·cloud)이고 `ops`는 이름 있는 400이다. 반대 방향도 막는다: `type='ops'` 행은 `host_ops_box` 없이 존재할 수 없다(지연 제약 트리거).
2. **닫힌 어휘.** Ops 호스트는 `work_control`의 대상이 될 수 없다(작업 세션 `spawn·input·read·permission`도, `kill`도). 이유는 [V] 위 표의 두 줄이다: workspace-scope 호스트는 R0 밖이라 채널 멤버 누구나 승인한 spawn이 도달하고 `work_auto_approve`가 적용되며 셸 거절이 없다. 집행은 다섯이고 하나라도 빠지면 시험이 빨개진다(수용 기준 RP-7·RP-8·RP-15).
   - ① **DB 트리거**: `work_control.target_host_id`가 Ops 호스트면 INSERT·UPDATE 모두 거부한다. 규율이 아니라 DB가 보장한다(`work_controls.rs:15-31`이 spawn 경로에 대해 자랑하는 성질과 같은 종류다).
   - ② 후보·적격: `spawn_host_candidates_in_tx`(`work_control.rs:2038`)와 `spawn_host_ineligible_reason_in_tx`(`:2217`)가 `type='ops'`를 제외한다.
   - ③ 폴: `pending_controls_for_host_in_tx`(`:576`)는 Ops 호스트에 빈 목록을 준다(이중 방어).
   - ④ 표시: 재개 대상 목록과 `HostPicker`는 같은 필터를 클라이언트에도 둔다(서버가 최종이고 클라이언트는 표시 문제다).
   - ⑤ 서명 경로: Ops 호스트의 키는 heartbeat와 박스 경로 둘 외의 기존 서명 경로에서 거절된다(D6-1).
3. **Ops 호스트의 명령은 별도 어휘로만 오간다**(D6: 세션·명령·이벤트). 이 어휘의 서버 표는 닫힌 컬럼이고 자유 jsonb payload가 없다(`118_cloud_box.sql` 머리말의 방식).
4. **한 워크스페이스에 활성 박스 하나**(Phase 1). 둘째 등록은 409. Railway에서는 **환경 하나에 박스 하나**다: 같은 환경의 서비스는 서로 닿으므로(S1) 한 환경에 박스를 둘 두지 않고, 워크스페이스가 여럿이면 박스마다 환경을 나눈다. [권장]
5. **소유자 규칙.** 박스 호스트의 `owner_member_id`는 **확인 서명을 한 owner·admin**이다. 페어링 코드는 발급한 owner·admin에게 결속되고, 발급자와 확인자는 달라도 되지만 **둘 다 활성 owner·admin**이어야 한다. 서명 요청은 소유자가 활성 사람인 동안만 인증되고 역할은 보지 않으므로(`work_host_request.rs:54-72`), 박스 경로의 핸들러가 **매 요청 소유자가 여전히 활성 owner·admin인지 같은 tx에서 다시 본다**. 소유자가 비활성·탈퇴·강등되면 박스는 「소유자 필요」가 되고 열린 세션은 닫힌다. 다른 owner·admin이 서명(`ops_box`, D5-3)으로 소유자를 **승계**하면 복구된다. [권장]
6. 개인 박스(ADR-0197)와 코드는 재사용하되 **플래그·테이블·라우트·결정자 규칙이 별개**다. `MOMO_CLOUD_BOX_ENABLED` 경로와 섞이지 않는다(r4 리스크 6).

### D2. 문 세 개 — 인스턴스 · 워크스페이스 · 세션 [권장]
- **인스턴스 문**: `MOMO_HOST_OPS_ENABLED`는 정확히 `true`만 연다(`momo-server/src/config.rs:1325-1346`의 `cloud_box_gate_open`과 같은 모양). 닫혀 있으면 **host-ops의 모든 라우트(박스 서명 경로와 끄는 쪽 라우트 포함)가 DB를 읽기 전에 404**다. 기본은 닫힘이고, 열려 있는데 `MOMO_INSTANCE_ID`가 없으면 기동 오류다(`DeviceKeySettings::boot_error`와 같은 방식). 이 문은 운영자의 **전면 스위치**다: 닫으면 열린 세션은 박스의 dead-man이 ≤90초 안에 닫고(D7), 문이 다시 열릴 때 서버가 모든 `open` 세션을 `expired`로 정리한다.
- **워크스페이스 문**: 설정 「호스트 작업」, 기본 꺼짐, owner·admin만 켠다. 켜는 조건은 ① 인스턴스가 R2 서명 요구를 켠 상태(`MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED=true`와 `MOMO_INSTANCE_ID`, `momo-server/src/config.rs:1387-1435`)이고 ② 켜는 사람의 동의 기록(누가·언제·문구 버전)이 남는 것이다. 문구는 「박스는 인터넷에 나가고 남용 책임은 이 인스턴스의 운영자에게 있어요」를 포함한다(ADR-0197 D11의 기록 방식).
- **R2 재확인(매 요청).** 세션 열기·박스 확인·소유자 승계는 **요청마다** `human_control_signature_required`와 `MOMO_INSTANCE_ID`를 다시 확인한다(`work_spawns.rs:22-25`의 spawn 패턴을 따른다. 서명 선택·R2에서만 필수인 `work_permissions.rs:47-49`의 allow 패턴을 쓰지 않는다). R2가 꺼져 있으면 요청은 403 `device_signature_required`이고 열린 세션은 닫힌다. **서명 자체는 R2 상태와 무관하게 상시 필수**다(서명 없는 요청은 R2가 켜져 있어도 꺼져 있어도 403).
- **R2를 켜는 일은 이 ADR의 몫이 아니다.** 서명 요구 플래그는 ADR-0146 D-11(R1 재검수·E10 PASS 뒤)과 ADR-0198 「서명 요구 플래그 — 보안 검수 뒤에 켠다」(oort-team에서 T5 보안 검수 뒤)와 owner 승인에 걸려 있고, 래칫이라 켜면 서명 없는 클라이언트의 허락·재개도 막힌다(HO-28). **켜기 전까지 Ops는 이 문 때문에 닫혀 있다.**
- **세션 문**: 열 때마다 서명된 승인(D5).
- **끄는 쪽**(세션 끊기·모두 끊기·박스 revoke·스위치 끄기)은 서명이 필요 없다(ADR-0146 D-8). 워크스페이스 스위치 off·박스 revoke·세션 끊기는 인스턴스 문이 열려 있는 한 즉시 동작하고, 스위치가 꺼지면 열린 세션은 모두 닫힌다(D7).

### D3. 평면 세 개 — 관찰 · 설치 · 셸 [owner 「박스 안만」, 경계 문장은 권장]
| 평면 | 하는 일 | 방식 | 승인 | 셸이 닿는 곳 |
|---|---|---|---|---|
| 관찰 | 상태·버전·doctor·박스 온라인·마지막 하트비트 | **oort가 스스로 아는 것만** 읽는다. Railway·VM API를 부르지 않는다(네트워크 호출 0) | 없음(읽기, owner·admin) | 없음 |
| 설치(타입 있는 동작) | Hermes·MCP 서버·봇 템플릿을 oort 스택에 더하기, 스택 올리기 | 서명된 매니페스트(digest·sha256 핀, `undo` 선언, 값 없는 이름만) → 계획 카드(서비스·변수 **이름**·digest 차이) → 승인 → **Phase 1은 oort가 아무것도 실행하지 않는다**: 승인 기록과 오너 실행 레시피를 남기고 doctor·상태로 검증한다. 실행기는 별도 ADR(HO-23) | 건별 owner·admin(ADR-0186 승인 카드, 앱에서 열기). oort가 실행하지 않으므로 Phase 1에는 기기 서명 kind를 더하지 않고, 실행기 ADR이 정한다 | 컨트롤 플레인 변경은 드라이버만. 셸이 아니다 |
| 셸 | 박스 안에서 자유롭게 실행 | 세션 승인 한 번 → 박스 데몬이 서명 poll로 받은 명령을 셸 uid로 실행(D6) | 세션 단위(D5) | **박스 안뿐** |

- **비목표(박스 밖 셸).** 컨트롤 플레인 컨테이너(api·DB·relay·push)나 VM 호스트 OS에 대한 에이전트 셸은 만들지 않는다. 그 일은 오너 본인의 `railway ssh`·ssh·Tailscale SSH(오너 직접 도구, D10)다.
- 박스 **안**에서 하는 설치(apt·pip·npm)는 셸 평면이다. 컨트롤 플레인에 서비스를 더하는 설치만 설치 평면이다.
- 설치 평면은 ADR-0184 D2의 「승인 지점 규율」(에이전트가 사용자 대신 플랫폼 콘솔을 조작하지 않는다)을 그대로 잇는다. oort는 Railway 토큰을 쥐지 않으므로 Phase 1에서는 구조적으로 실행할 수 없다. 이것은 owner 요청의 「조금 쉽게 설치」 중 **실행 자동화가 Phase 1에서 뒤로 밀린다**는 뜻이고 결재 기록에 따로 적었다.

### D4. 박스가 넘지 않는 선 열 개 [owner 「박스 안만」의 집행, 세부는 권장]
집행은 **부재와 구조가 먼저, 필터는 보조**다(Meta Rule of Two: 프롬프트 주입은 풀리지 않았다 [웹, r4 §2.6]). 아래는 설정으로 바꿀 수 없다.
| # | 선 | 집행 |
|---|---|---|
| I1 | 박스에는 **oort 비밀이 없다**: 마스터 키·DB 자격·푸시 서명키·JWT·Railway 토큰·`HERMES_API_KEY`, 구독 로그인, 모델 API 키(ADR-0004·0191 D2) | 박스 환경에 그 변수를 **만들지 않는다**. 시작 때 환경 이름과 값, 파일시스템 이름·패턴을 검사(`leakscan`, `infra/personal-box/momo-box-leakscan`)해 걸리면 박스 데몬이 exec 채널을 열지 않는다(fail-closed) |
| I2 | 컨트롤 플레인 네트워크에 **닿지 않는다** | 배치에 따라 다르다(D8): Railway는 환경 분리 실측, VM은 별도 데몬·nft·`docker.sock` 미마운트. **실측 전에는 박스를 올리지 않는다** |
| I3 | oort로는 **공개 HTTPS 한 문**으로만 간다(ADR-0157 D1: 문이 하나면 감사도 하나) | 박스는 서명 요청 v2로 outbound만. 인바운드 포트가 없다. oort가 박스로 다이얼하지 않는다(Hermes 방식과 방향이 반대) |
| I4 | 승인은 **사람이, 대화 밖에서, 범위·시간과 함께** | D5 |
| I5 | 감사는 셸이 못 지운다 | 박스 데몬(uid A)·헬퍼(uid H)·셸(uid U)을 나누고 preflight 실패 시 exec 채널이 열리지 않는다, 해시 체인(D6-5, D12) |
| I6 | 자격은 대리·부여로만 | **이 ADR은 부여 경로를 열지 않는다.** ADR-0211(#4238)·ADR-0212(#4239)·ADR-0205 증보가 정하는 부여가 착륙하기 전의 박스는 자격 없는 컴퓨터다 |
| I7 | egress는 **능력으로 선언**하고 정직하게 표시 | 드라이버가 `egress: enforced 또는 advisory`를 보고하고 승인 카드가 그대로 보인다(D8) |
| I8 | 인프라 비밀 외의 민감 데이터는 박스로 **oort가 옮기지 않는다** | oort가 박스에 넣는 것은 세션 범위·명령뿐이다(채널 기록·Drive·기억 주입 경로는 만들지 않는다. ADR-0157 D3 「세션 스레드 요약만」). **한계**: 에이전트가 자기 컨텍스트에서 본 내용을 `host.write`·`exec`으로 박스에 옮기는 것은 oort가 중개하지 않아도 일어나고 막을 수 없다(RISK-3) |
| I9 | 킬은 **oort가 없어도** 작동한다 | TTL·dead-man은 박스 데몬이 로컬로 집행하고, 셸 uid의 프로세스는 헬퍼가 전부 정리한다(D7) |
| I10 | 컨트롤 플레인 셸은 **에이전트의 능력이 아니다** | 드라이버 어휘에 `exec`가 없다. 러너 동사 5개가 `exec`·`cp`·`commit`·`export`·`snapshot`을 일부러 갖지 않는 설계(`verbs.rs:1-6`)를 컨트롤 플레인 쪽에 유지한다. 「박스 안 exec」가 이 ADR이 의식적으로 여는 유일한 어휘다 |

### D5. 승인과 세션 [권장 — 결정자·서명·숫자]
1. **요청.** ① owner·admin이 데스크탑·폰에서 직접 연다. ② **관리형 에이전트**가 `host.session.open`을 **제안**한다(ADR-0186 D2의 propose → approve → execute, 레지스트리 등록은 HO-15의 0186 증보). 제안자는 관리형 에이전트로 한정한다(레지스트리 속성). 팀 AI는 제안만 하고 셸 도구가 없으며(ADR-0201 D2 유지), 외부 Agent Port 에이전트는 Phase 1에서 제안도 박스 도구도 없다(D9). `agent_member_id`는 제안한 에이전트 자신으로 서버가 핀한다(ADR-0186 `pins.target`).
2. **결정자.** 워크스페이스 **owner·admin인 활성 사람** 한 명. 에이전트·웹훅·도어벨·서명 호스트·채널의 일반 멤버·`work_auto_approve`는 결정하지 못한다. 에이전트가 요청한 경우의 결정은 ADR-0186의 승인 카드 경로라서 **요청이 올라온 방의 멤버인 owner·admin**이 결정자다(비공개 방의 내용이 방 밖 admin에게 새지 않는다). 요청한 방의 멤버가 아닌 admin은 그 요청을 결정할 수 없다. 그 admin이 열어 주려면 **자기가 속한 방을 골라** 데스크탑·폰에서 직접 연다(직접 열 때도 방의 활성 멤버여야 하고 묶는 에이전트는 그 방의 활성 멤버여야 한다). ADR-0188 D3의 「소유자 본인만」을 쓰지 않는 이유: 팀 박스는 특정 멤버의 기계가 아니라 워크스페이스 자원이다(소유자 한 명이 빠지면 아무도 승인하지 못한다). 이 규칙은 `scope='member'` 레인을 바꾸지 않는다.
3. **서명.** `ops_session`(세션 열기)·`ops_box`(박스 확인·소유자 승계) 두 본문을 **새 스키마 문자열 하나**(가칭 `momo.human.control.v5`)에 둔다. 다른 kind는 이 스키마로 만들 수 없고 기존 v1~v4로 이 본문을 만들 수 없다(`momo-wire/src/human_control.rs:130-135`의 규칙).
   - `ops_session` 본문은 `{box host_id, agent_member_id, channel_id, ttl_minutes, driver, 선언된 egress 모드, 선언된 uid 분리, 선언된 hardening, secrets:none, tools:shell+fs, approval_id 또는 -}`를 묶는다(세션 id 줄은 `-`: 세션은 열릴 때 생긴다). **`driver`는 이 에이전트에게 박스 명령을 시킬 수 있는 사람**이다: 멤버 id 하나 또는 `room`(방의 활성 멤버 모두). 카드의 기본값은 에이전트가 제안한 경우 그 요청을 한 사람, 직접 열 때는 승인자 본인이다(D5-6).
   - `ops_box` 본문은 `{동작(confirm 또는 succeed), host_id, 박스 공개키(또는 지문), NFC(label), 박스가 보고한 능력 값 전체, succeed면 구 소유자·새 소유자}`를 묶는다(`host_register` 본문의 선례).
   - 연장은 **새 세션 = 새 서명**이다. 정확한 직렬화는 구현이 공유 테스트 벡터(Rust·Swift·TS)로 고정한다(ADR-0146 D-5 방식).
   - 서명한 기기 키는 ADR-0146 사슬(뿌리 맥 키 또는 승인된 폰 키)이어야 하고 **웹 브라우저는 서명 표면이 아니라서 열 수 없다**(ADR-0146 D-4).
   - **검증 위치.** 서명 검증은 라우트가 아니라 **세션을 만드는 한 함수**에 둔다. 직접 열기 라우트와 `host.session.open` 승인 실행기(`execute_workspace_action`, `approvals.rs:1429`)가 그 함수를 부른다. 두 결정 라우트(`POST …/approvals/{id}/decision`, `POST /v1/agent-runs/{run}/approval-decisions`)는 같은 `decide_in_tx`를 지나므로, 결정 입력(`DecisionInput`, `approvals.rs:608`)에 더하는 서명 필드를 실행기가 검증한다. 서명 없이는 세션이 생기지 않는다.
4. **세션 범위와 명령의 출처.** 한 세션은 **에이전트 멤버 하나·방 하나·driver 하나**에 묶인다. 박스 명령이 되는 도구 호출은 **아래를 모두 만족하는 run**에서만 나온다(서버 실행기가 세션을 만들 때가 아니라 **호출 때마다** 다시 본다).
   - 그 에이전트의 run이고 그 방에서 섰다(다른 방의 run은 거절: 다른 방의 프롬프트 주입이 승인된 세션을 빌려 쓰지 못한다).
   - **루트 run이다**: `parent_run_id IS NULL AND depth = 0`(A2A 자식 run 거절), `RunTrigger`는 Mention·ThreadReply·Work(Welcome 거절), 트리거 메시지의 작성자(Work는 `actor_member_id`)가 **활성 사람 멤버**다. 사람이 아닌 작성자(에이전트·웹훅·도어벨·시스템)와 예약 전송(ADR-0208)이 만든 run은 Phase 1에서 거절한다(그 시각에 보내는 사람이 앞에 없다. 구분 표식이 없으면 HO-18이 ADR-0208 쪽에 표식을 요청한다).
   - 그 작성자가 **driver**다(`room`이면 방의 활성 멤버).
   - 세션은 승인한 사람에게도 묶인다: 소비 때마다 R2 서명 요구·`MOMO_INSTANCE_ID`가 켜져 있는지, 승인자가 **활성 owner·admin**인지, 묶인 에이전트가 활성인지, 박스가 확인 서명과 같은 능력 값을 보고하는지를 같은 tx에서 다시 본다. 하나라도 어긋나면 세션이 닫힌다.
5. **숫자 [권장]** (상수이고 환경 변수로는 줄일 수만 있다): 세션 기본 **2시간**·최대 **12시간**, 유휴 **30분**(마지막 명령이 끝난 뒤 새 명령이 없는 시간)이면 세션 종료(박스는 유지), 연장은 새 세션, **무인 요청의 승인 대기 10분** 뒤 만료(행동별 TTL — 레지스트리의 새 속성), 박스 poll 간격 ≤5초(dead-man 90초의 분해능), **박스당 동시 세션 1**, 워크스페이스당 박스 1, **에이전트당** 대기 3, 세션당 명령 1,000건, 명령당 제한 시간 기본 120초·최대 900초. 동시 세션을 1로 시작하는 이유: 박스는 **한 신뢰 영역**이다(셸 uid·홈·`/tmp`를 세션이 나눠 쓰므로 방이 다른 세션의 파일이 서로 보이고, 세션별 킬도 uid 하나 기준이다). 늘리려면 세션별 uid·홈 분리가 먼저고 그것은 이 ADR의 증보다. 방이 바뀌는 세션 사이에는 Reset을 권한다(카드 안내).
6. **앱에서 열어 결정한다.** `host.*` 승인은 항상 `opens_in_app`(잠금 화면 결정 불가, `momo.approval.open`)다. `opens_in_app`에 **행동 id 갈래**(`host.session.open`·`host.install`)와 **툴 이름 갈래**(`host.exec`·`host.read`·`host.write`를 `OPEN_IN_APP_TOOL_NAMES`에, 방어 심층)를 한 곳에서 더하고 푸시 어휘는 늘리지 않는다(ADR-0204 D6·D7). 승인 카드는 범위·남은 시간·이그레스 모드·「시크릿 없음」·uid 분리·hardening 상태를 보이되 **박스가 스스로 보고한 값은 「선언값」으로 표기**해 서버가 아는 값(드라이버 종류·확인 시각)과 구분한다. 카드는 「**누가 시킬 수 있나요**」(driver)를 고르게 하고 「에이전트는 대화에서 본 내용을 박스에서 쓸 수 있어요」를 보인다. `room`을 고르면 「이 방의 모든 멤버(N명)가 이 에이전트에게 박스 명령을 시킬 수 있어요」를 크게 보인다.
7. **두 번째 승인(자격)은 이 ADR이 열지 않는다**(I6). 자격이 필요한 행동(git push, 외부 API, 결제)은 부여 ADR이 착륙하기 전에는 박스에서 할 수 없다. 자격이 필요 없는 외부 행동(임의 HTTP, SMTP)은 막지 못하고 「주입된 것은 유출될 수 있다」(ADR-0157 D3)와 「박스에 인프라 비밀이 없다」로 받는다.
8. **위험 명령 하이라이트**(재귀 삭제·`mkfs`·`dd of=`·`DROP TABLE`·`curl | sh`·네트워크 스캔·SMTP·채굴·외부 `ssh`·docker 소켓 접근 시도)는 **표시일 뿐 경계가 아니다**(필터는 신뢰할 수 없다 [웹, r4 §2.6]).
9. **등록 확인.** 페어링 코드는 ADR-0192 D2 초안을 workspace 범위로 채택한다(0192 D2가 말한 「M4 착수 때 증보로 확정」은 먼저 착륙하는 슬라이스가 구현하고 다른 쪽이 재사용한다): 짧은 수명(10분 이하)·1회용·해시 저장·80비트 이상·레이트리밋과 실패 누적 시 폐기·확인 전 호스트는 컨트롤을 받지 않는다. 발급은 owner·admin(서명 불필요: 코드만으로는 아무것도 열리지 않는다), 확인은 `ops_box` 서명이다.
   - **claim은 `{ws}`로 테넌트를 정한다.** 박스에는 bearer·서명 키·워크스페이스 문맥이 없으므로 claim 경로는 `/v1/workspaces/{ws}/host-ops/…`의 `{ws}`로 tenant tx를 열고 **그 안에서만** 코드 해시를 조회한다(전 테넌트 조회·BYPASSRLS 없음). 모르는 ws·틀린 코드·만료·사용됨·다른 워크스페이스의 코드는 **같은 응답**이고, 레이트리밋 키는 (IP, ws)와 코드 해시 앞부분이다.
   - 확인 화면은 박스가 **자기 로그·콘솔에 낸 키 지문**과의 대조를 요구한다(서버 밖 값 대조. 서버가 준 지문을 서버 화면에서 보는 것은 독립 검증이 아니다 — ADR-0197 D5). 확인 서명은 박스가 보고한 능력 값 전체를 묶는다. 박스가 다른 능력 값을 보고하면 열린 세션을 닫고 재확인 전에는 새 세션을 열 수 없다.
10. **서버 검증과 박스 검증.** Phase 1의 서명 검증은 **서버**가 한다(편의와 감사). ADR-0146 D-10(보안 경계는 호스트)과 ADR-0197 D5(박스 데몬이 소유자 기기 서명을 직접 검증)와 달리 박스 데몬은 관리자 기기 키 목록을 갖지 않는다. 이유: 박스에 인프라 비밀이 없고 컨트롤 플레인에 닿지 않아(I1·I2) 서버가 침해돼도 박스가 잃는 것은 박스 안 내용과 egress 평판에 한정되며, 서버가 침해되면 공격자는 이미 마스터 키를 가진다. **남는 위험(RISK-1):** 침해된 서버가 사람 승인 없이 세션을 열고 박스를 쓸 수 있다. 데몬이 서명 목록을 직접 검증하는 것은 HO-27이다(관리자 키 목록의 고정·단조 버전·서명 갱신은 ADR 증보가 먼저).
11. **경합(원자성).** 열기·소비·revoke는 모두 **박스 행을 `FOR UPDATE`로 잡고** 한다(`approvals.rs:738`의 `lock_approval_in_tx`와 같은 방식). 열린 세션 수는 `state='open' AND expires_at > clock_timestamp()`로 세므로 접근이 없어 `open`으로 남은 만료 세션이 상한을 점유하지 않는다. 승인 소비는 `pending → approved` 조건부 UPDATE(CAS)이고 명령 번호는 세션 행에서 할당한다.
12. **승인 뒤 run은 이어지지 않는다.** `workspace_action`은 승인되면 run을 끝내고 resume job을 만들지 않는다(ADR-0186 D2). 에이전트는 **다음 run**에서 열린 세션을 쓴다 — 사람이 같은 방에서 한 줄로 이어 부른다(driver 규칙이 그 사람을 본다). 승인 직후 자동 재개는 별도 증보(HO-15 검토)다.

### D6. 박스 통신·감사·데이터 흐름 [권장]
1. **채널과 핀.** 박스 데몬은 서명 요청 v2로 outbound만 한다. 서명 호스트 경로를 **정확히 둘** 더한다(heartbeat는 기존 것을 쓴다): 명령·열림/닫힘 통지를 받는 poll(`GET …/host-ops/boxes/{host}/pending`)과 이벤트·결과를 올리는 보고(`POST …/host-ops/boxes/{host}/events`). 열기·확인·결정·설정 라우트는 allow-list에 넣지 않는다(`work_host_auth.rs:41-45`). 두 경로는 **인증기가 핀을 걸지 않는 형태**(`work_host_auth.rs:60-87`, `:297-303`)이므로 다음을 서버가 강제한다.
   - 서명한 host id가 경로의 `{host}`와 같다(`scoped_host_id_from_path`를 `host-ops/boxes/{host}`까지 넓히고, 핸들러도 한 번 더 단정한다).
   - 그 호스트가 `type='ops'`이고 `host_ops_box`와 짝이며 확인됐고 revoke되지 않았고 박스의 워크스페이스가 같다.
   - 보고하는 세션·명령 id가 **그 박스의 것**이다(다른 박스·다른 워크스페이스의 id는 거절).
   - 반대로 **Ops 호스트의 키는 heartbeat와 이 두 경로 외의 기존 서명 경로에서 거절된다**(terminal-attach·pending-controls·ack·display·work-sessions·work-tool-profiles 등, `:189-287`), 다른 서명 호스트(`workd`·member `cloud`)는 이 두 경로에서 거절된다.
2. **명령 어휘(닫힌 스키마).** `exec`(셸 줄·cwd·제한 시간), `read`(경로·최대 바이트), `write`(경로·내용 ≤ 1 MiB). `read`·`write`는 박스 홈 안으로 한정하고 자격 경로는 거절한다(`fsgate` 방식, `momo-box-agent/src/lib.rs:7-12`). `exec`는 **PTY가 아니다**(비대화형, stdin 닫힘, TUI 없음). 셸 uid로 도는 프로세스는 헬퍼가 세션 단위 프로세스 그룹·SID로 묶는다. 세션 하나만 끝낼 때는 그 그룹을, 박스 전역 사건에서는 셸 uid의 **모든 프로세스**를 정리한다(D7, D12).
3. **전달은 최대 한 번.** 부작용이 있는 명령이라 서버는 재배달하지 않는다. 박스는 `command_id`로 중복을 거절하고, 받지 못한 명령은 `lost`로 닫는다. 재시도는 에이전트가 판단한다.
4. **데이터는 세 층이다 — 「서버 DB의 현재 행에 남기지 않는다」가 정확한 약속이다**(삭제된 행은 WAL·PITR 백업에 남을 수 있다).
   - **박스에만:** 전사 원문(stdout·stderr 전체). 박스 데몬이 쓰는 감사 디렉터리에 두고 셸 uid는 못 읽는다.
   - **두뇌에게 일시적으로:** 에이전트가 일하려면 결과가 필요하다. 결과(종료 코드·머리와 꼬리 합쳐 **≤ 32 KiB**, 보이지 않는 문자·방향 제어 문자 정화)는 `host_ops_command`의 일시 열에 쓰이고 **같은 run을 재개하는 worker가 읽자마자 지운다**(소비 안 된 행도 5분 뒤 정리 스위프가 지운다, D9의 마감 처리). 이 결과는 **모델 공급자에게 간다**(에이전트가 일하려면 필요하다). **채널 `tool_result`·`tool_call` 메시지, 승인 `payload`, job payload, `audit_log`, outbox, 로그·메트릭에는 쓰지 않는다**(D9의 별도 경로).
   - **서버가 영속하는 것(감사):** 명령 줄(자격 패턴은 가린다)·cwd·종료 코드·시간·stdout/stderr 바이트 수·**머리·꼬리 발췌 각 ≤ 512 B(정화본)**·전사 sha256. 이것이 「채널에 남는 실행 기록」이다.
   - 에이전트가 **자기 답에 옮겨 쓴** 출력은 에이전트의 말이라 일반 메시지로 남는다(어떤 도구도 막지 못하는 부분이고 RISK-3에 적는다).
5. **감사 체인.** 박스 데몬이 이벤트마다 `seq`·`prev_hash`·`event_hash`를 이어 서명 요청으로 올린다. 서버는 연속성을 확인하고 끊김은 `chain_gap` 이벤트와 「감사 끊김」 표시로 남긴다. 이벤트는 `run_id`·`trigger_message_id`·`driver`(요청한 사람)·`approver`(승인한 사람)·`box_id`·`session_id`·`command_id`를 함께 싣는다. 저장은 추가 전용 표(UPDATE·DELETE를 거부하는 트리거, 선례 `070_hosted_agent_inbox.sql:100`: 직접 DELETE만 거부하고 연쇄 삭제는 `pg_trigger_depth()`로 허용한다. `128_agent_run_event.sql:358-369`는 UPDATE만 막는다)와 `audit_log` 행과 세션 방의 스레드 카드다. 보존·삭제 연쇄는 HO-12가 `cloud_box`의 tombstone 방식(ON DELETE RESTRICT)과 `audit_log`의 기존 규칙에 맞춰 정한다. 카드는 `send_message_in_tx`(channel_seq 증가·message·outbox 한 tx)로만 쓰고 시스템 작성자 줄 규칙은 ADR-0200 증보 3의 서버 본문 줄과 같다. 박스는 Centrifugo에 직접 publish하지 않는다.
6. **0125 D10 대조.** ADR-0125 D10은 raw PTY 바이트를 서버가 싣지 않는다는 결정이다. Ops 박스는 PTY가 없고 서버를 지나는 것은 구조화된 도구 결과(위 두 번째 층)이며 현재 행에 남는 것은 발췌뿐이다. 그래서 0125 D10 본문은 바뀌지 않는다. 오너의 실시간 보기는 눈먼 PTY(HO-25, ADR-0197 D5 재사용)로 따로 풀고 이 ADR이 열지 않는다. **전사 전체를 서버에 두는 대안은 기각**(0125 D10 증보와 별도 보안 검수가 필요하다).

### D7. 끄기 — 킬 사다리 · TTL · dead-man [권장]
- **네 단계(서명 불필요).** ① **세션 끊기**: owner·admin 누구나, 그 세션의 에이전트는 자기 세션만. 즉시 control 소비 중단 + 세션의 프로세스 그룹 종료 + 대기 명령 `lost`. ② **박스 revoke**: `work_host.revoked_at` → 서명 요청 401 → 박스 데몬 self-stop(ADR-0188 D7과 같은 방식). 같은 tx에서 열린 세션을 `killed`로 닫는다. ③ **워크스페이스 「호스트 작업」 끄기**와 **모두 끊기**. ④ 플랫폼 정지·삭제(오너 도구). 인스턴스 문(D2)이 닫히면 이 라우트들도 404이고, 그것이 전면 스위치의 뜻이다(열린 세션은 dead-man이 닫는다).
- **박스 전역 사건**(revoke·dead-man·모두 끊기·스위치 off·인스턴스 문 닫힘 감지·TTL 만료)에서는 헬퍼가 **셸 uid의 모든 프로세스를 SIGKILL**한다(`setsid`·이중 fork로 프로세스 그룹을 벗어난 것 포함). 세션 하나만 끝나는 경우만 그 세션의 프로세스 그룹을 종료한다. 이 정리가 「oort가 죽으면 박스 셸도 멈춘다」의 뜻이다: 새 명령을 더 받지 않고 셸 uid의 프로세스를 전부 지운다. 헬퍼 동사는 D12.
- **TTL은 박스가 로컬 단조 시계로 집행**하고 서버는 DB 시계로 소비를 거절한다. 둘 중 빠른 쪽이 이긴다. TTL 타이머를 지우면 박스 시험이 실패한다.
- **dead-man:** 서명 poll이 **연속 90초**(ADR-0125 D11의 오프라인 유예) 성공하지 못하면 박스 데몬이 열린 세션을 전부 닫고 위의 전역 정리를 한다. 문이 닫혀 404가 오는 것도 실패로 센다.
- 남용: 박스당 지속 고CPU(**10분 평균 ≥ 0.9 vCPU 또는 1시간 평균 ≥ 0.7 vCPU**, 절대 단위 — Railway 박스에는 vCPU 상한이 없어 비율로 쓸 분모가 없다, ADR-0197 D9의 90%·70%를 1 vCPU 기준으로 옮긴 값이다)면 데몬이 세션 프로세스를 죽이고 알린다. 박스 서비스 자체를 멈추는 것은 오너 도구다(oort는 Railway 토큰이 없다).

### D8. 배치와 드라이버 — 한 틀, 실측이 먼저 [owner 「둘 다 한 틀로」·10-22 정정, 세부는 권장]
**한 인터페이스.** 두 드라이버는 같은 동사 셋을 가진다: 관찰(`status`·`versions`)·박스 수명(`status`·`restart`·`reset`·`destroy` — 실행은 오너 도구) · 설치(`plan`·`apply`·`undo`, Phase 1은 레시피). 셸 세션은 드라이버가 아니라 박스 데몬이 한다. 드라이버는 **능력을 선언**하고 UI가 그대로 보인다(박스의 자기 보고이고 확인 서명이 묶는다, D5-9):

| 능력 | 값 | 뜻 |
|---|---|---|
| `egress` | `enforced` 또는 `advisory` | 선언 규칙으로 막는지 / 수단이 없는지 |
| `isolation` | `environment`·`project`·`rootless-userns`·`vm` | 컨트롤 플레인과의 분리 단위 |
| `uid_split` | `verified` 또는 `unverified` | preflight 결과. `unverified`면 exec 채널이 열리지 않는다 |
| `hardening` | `full` 또는 `partial` | 아래 하드닝 목록 중 적용된 것(VM 고정 템플릿은 `full`, Railway는 `partial`) |
| `snapshot` | `yes` 또는 `no` | 볼륨 스냅샷 가능 여부 |
| `root` | `none` 또는 `userns` | 셸의 root 여부 |

**Railway.**
- **R-a (우선): oort-team 프로젝트 안 빈 임시 환경(`ops`).** production 환경을 **포크하지 않는다**: 포크가 서비스와 변수(api의 변수 41개와 그 값 포함)를 복제하는지 [미확인]이고 복제하면 박스에 비밀이 생긴다. 서비스는 박스 하나와 볼륨 하나뿐이고 **환경 하나에 박스 하나**다(D1-4). 프로젝트 토큰은 그 환경 범위지만 스코프를 못 좁힌다 [V, S1] — oort는 그 토큰을 만들지도 쥐지도 않는다(D10). oort와 관련해 박스가 받는 변수는 `OORT_SERVER_URL`(공개 URL)과 1회용 `OORT_BOX_PAIR_CODE`뿐이다(키 보관 방식 (a)를 택하면 박스 자신의 봉인 키 하나가 더해진다, 아래 ⑤). 스파이크가 통과하면 같은 `ops` 환경이 팀 박스의 자리가 된다(빈 환경이라는 조건은 유지한다).
- **승격 조건(게이트, 전부 #4348의 실측)**: ① 박스에서 카탈로그 서비스 전부(postgres·centrifugo·api·relay·webhook-sender·agent-worker·hermes·notifier·push-relay·caddy)의 `.railway.internal` 이름이 NXDOMAIN이고, **같은 시점 production 환경의 대조 사이드카에서는 해석된다**(baseline 없는 음성은 증거가 아니다, S1 방식). IPv6 사설 주소 직접 접속도 막힌다. ①이 곧 **교차 *환경* 격리**의 실측이다(S1은 교차 *프로젝트*만 쟀다). 대조 사이드카는 production 환경에 서비스를 하나 더하는 일이므로 **owner 승인이 필요하고 시험 뒤 지운다**(#4348 수용 기준에 적는다). ② 박스 환경·파일시스템에 시크릿성 변수 이름이 0건이고(`*_KEY`·`*_SECRET`·`*_PASSWORD`·`DATABASE_URL`·`*_B64` 등) 프로젝트 공유 변수(`shared.*`)가 환경 경계를 넘어 보이는지 yes/no. ③ 시작 명령 root → uid 분리가 성립한다(`id` 출력 uid 둘, 셸 uid의 감사 디렉터리·host 키 접근 거부). api 시작 명령이 root에서 `setpriv`로 내려가는 선례(`railway.json:65`)는 [추정]의 근거일 뿐 두 uid의 장수 프로세스는 `runtime-unverified`다(`login_relay.py:1034`, README `:210-216`). ④ 환경을 지우면 서비스·볼륨·과금이 정리된다. ⑤ **박스 host 키 보관이 Railway에서 성립한다**(S4 게이트의 전제 — 러너가 주는 봉인 키·백업 없음 증명·`nosuid,nodev` 마운트 — 가 Railway에는 없다 [V, `S4-linux-box-host-key-custody-spike.md`, `box_store.rs`]). #4348이 둘 중 하나를 실측한다: (a) 볼륨 루트를 root 소유로 두고 `/data/oort`(uid A 0700)와 `/data/home`(셸 uid)을 나눠 상위 디렉터리 교체를 막고, 봉인 키는 오너가 관리하는 서비스 변수에서 기동 때 tmpfs로 옮긴다(박스 변수가 하나 늘고 oort 비밀이 아니라 박스 자신의 키다). (b) 키를 매 기동 tmpfs에서 새로 만들고 재배포마다 D5-9 재확인을 거친다(Reset 뒤 재확인 비용을 D11에 적는다). 둘 다 안 되면 Railway Ops는 닫힌다.
- **실패 때 갈 곳.** ①~③ 실패 → R-b를 owner에게 묻는다. ⑤ 실패 → Railway Ops를 열지 않는다(R-b도 같은 Railway 제약이라 대안이 아니다. VM 드라이버로 간다). ④ 실패 → 박스를 올리지 않고 owner에게 보고한다. **기록 항목**(승격과 무관): 토큰 행렬(account·workspace·project·OAuth viewer·member × 변수 값 읽기·`railway ssh`·`serviceCreate`). 컨테이너 안 `CAP_NET_ADMIN`으로 uid 기준 nft가 되는지 yes/no도 잰다 — 되면 Railway의 `egress`를 `enforced`로 올릴 수 있고 승격을 막는 조건은 아니다. 그 밖의 #4348 항목(등록·하트비트 지연, redeploy 뒤 파일시스템 리셋·볼륨 유지, 24시간 비용, `railway ssh` 감사 흔적, Sandboxes 재확인, 서비스 리소스 한도 설정 가능 여부)은 기록 항목이다. 결과는 이 ADR의 증보 1로 적는다(ADR-0197 증보 1과 같은 방식).
- **Railway 박스의 하드닝(`hardening=partial`).** 데몬이 **스스로 적용하는** 것: 셸 자식에 `PR_SET_NO_NEW_PRIVS`·모든 capability 제거·`RLIMIT_NPROC`·`RLIMIT_CORE=0`·`umask`, 이미지에 setuid·setgid 바이너리 없음(빌드 시험). **적용할 수 없는** 것: 읽기 전용 루트·seccomp 선택·userns·자원 상한(cgroup)·`hidepid`(Railway는 시작 명령·변수·볼륨만 제어한다 [V, S1:52]). 이 목록이 승인 카드에 「hardening: 부분」으로 보인다. ADR-0197 D1의 전체 하드닝은 VM 고정 템플릿(`template.rs`)만 `full`이다.
- **R-b (R-a가 ①~③에서 실패할 때만): 별도 Railway 프로젝트.** 프로젝트 생성·과금은 owner 승인이다(10-22 정정). 별도 프로젝트의 사설망 분리는 S1이 실측했다 [V].
- **R-c 같은 환경의 사이드카(Hermes 방식)는 기각**: 같은 환경의 서비스는 제한 없이 서로 닿는다 [V, S1].
- **R-d Railway Sandboxes**: 베타이고 egress 차단 수단이 없다고 Railway 직원이 답했다 [웹, r4 §2.2, 요약 경유]. 재평가는 HO-24.
- **egress는 `advisory`다**: 수단이 없고 SMTP 25/465/587이 열려 있다 [V, S1]. 남용 완화는 시크릿 0·D7의 고CPU 정지·운영자 책임 고지이고 승인 카드가 「박스 안 내용은 밖으로 나갈 수 있어요」를 보인다. **ADR-0125 D8의 마지막 항(agent 단계 기본 네트워크 제한)에서의 이탈**이다 — ADR-0157 D3가 인터넷 egress를 v0 허용으로 둔 것과 같은 이유이고, VM에서도 공용 인터넷은 열려 있다(사설 대역·메타데이터·SMTP만 차단). 결재 기록과 0125 역방향 줄에 적었다.
- **ADR-0197 증보 1(「B 닫힘」)과의 관계.** 그 증보는 **개인 박스**에서 Railway 어댑터를 닫았다(oort가 root급 토큰을 멤버 수만큼 쥐어야 하고, 볼륨 크기·egress를 못 정한다). 이 ADR은 그것을 다시 열지 않는다. 팀 박스는 다른 종류다: 워크스페이스당 하나, 박스 안에 oort 비밀·구독 자격이 없고, **oort가 Railway 토큰을 쥐지 않으며**(오너 세션이 만들고 지운다), 셸은 에이전트가 쓴다. 닫힌 이유 중 토큰 문제는 구조로 비켜 가고 egress·볼륨 크기는 그대로라 `advisory`와 모니터링으로 받는다(D7·D12).

**VM(Docker Compose·그록봇 VM).** 같은 인터페이스. 박스는 전용 OS 사용자(`oort-box`)의 **rootless 데몬 안 컨테이너**이고 oort 컴포즈 스택(root 데몬)과 데몬이 다르다. **어떤 컨테이너에도 `docker.sock`을 마운트하지 않는다**(docker 그룹은 사실상 root, ADR-0197 D2). egress는 `infra/personal-box/s1/runner-egress.nft`의 선언 규칙(사설 대역·CGNAT·메타데이터·IPv6·이웃 박스·호스트 자신·SMTP 차단)을 기준으로 하고 `enforced`다. **컨트롤 플레인과 다른 기계**가 기본이고(ADR-0197 D2: 「DB와 같은 기계에서 사용자 코드를 돌리지 않는다」), 같은 VM 공존은 `isolation` 능력을 낮게 표시하는 **약한 격리 프로파일**로 열되 승인 카드가 위험을 보인다(컨테이너는 경계가 아니다, ADR-0144 D1의 원칙). 컨트롤 플레인 변경용 `hostd`(닫힌 동사 `stack.status`·`profile.enable`·`stack.upgrade`, 전용 사용자, 서명 검증)는 P2이고 **동사 스키마·소켓·서명은 HO-20 착수 전에 이 ADR의 증보로 확정한다**(이 ADR은 「`exec` 동사 없음」과 「admin 서명 없는 실행 거부」만 정한다).

### D9. 두뇌와 손 — 두뇌는 서버, 손은 박스 [권장]
- **두뇌 = 서버**(agent-worker의 관리형 경로, 모델 키는 서버·Hermes가 쥔다), **손 = 박스의 exec 채널.** 박스에는 모델 키도 구독 로그인도 두지 않는다. 박스 안 구독 하네스(Claude·Codex)는 Phase 1 밖이다(ADR-0193 D18, ADR-0191 D2). API 키를 박스에 두려면 시크릿 브로커(HO-21)가 먼저다.
- **도구**: `host.exec`·`host.read`·`host.write`. 승인된 세션 안에서, 그 세션에 묶인 에이전트 멤버(`member.kind='agent'`, ADR-0101, 새 클래스 없음)가 D5-4의 조건을 만족하는 run으로만 부를 수 있다. 새 공개 REST가 아니다.
- **현행 도구 경로를 쓰지 않는다.** 현행 경로는 한 턴에 도구 한 번이고 결과·인자 전문을 채널 메시지로 영속하고 턴을 끝낸다(위 [V] 표). `host.*`는 `CATALOG`에 올리되 아래의 **별도 경로**를 쓴다. 이 경로는 반복 루프(모델 → 박스 명령 → 결과 → 모델 …)라서 **새 실행 구조**이고, 그 상세(job·재개·단계 상한)는 HO-18이 이 ADR의 증보로 먼저 쓴다(현행 G3 단계 상한 `consume_run_step_in_tx`가 재개마다 한 단계를 쓰는 구조를 재사용할 수 있는지도 그때 정한다, `momo-agent-worker/src/lib.rs:1294-1300`). 이 ADR이 못박는 것은 다음이다.
  1. **호출 카드.** `tool_call` 카드의 `arguments`는 도구별 투영이다: 명령 줄은 정화·절단(자격 패턴 가림), `host.write`는 경로·바이트 수만 싣고 내용은 싣지 않는다.
  2. **명령 기록.** worker는 `with_tenant_tx_prelude` 안에서 `SET LOCAL ROLE momo_hostops`를 걸고(`NOLOGIN NOBYPASSRLS`, `host_ops_*` 표에만 GRANT, `momo_worker`에 GRANT — ADR-0201 H4-2의 `momo_helper_read`와 같은 모양, `ws_isolation` 정책이 그대로 적용된다) `host_ops_command`에 명령을 넣는다. **worker의 BYPASSRLS 권한으로 host 표에 접근하지 않는다.**
  3. **대기.** 명령을 넣은 같은 tx에서 run의 전달 job을 settle(`awaiting host`)하고 run은 새 DB 상태 없이 **`running`으로 남긴다**(ADR-0200 D1: DB 열거형·`phase` 어휘 불변. 대기는 분 단위 — 명령 최대 900초 ≪ 고아 run 기준 2시간(`MOMO_RUN_LEASE_ABANDON_HOURS`) — 이므로 ADR-0200 D1-4의 고아 run 스위프가 건드리지 않는다는 가정을 HO-18이 시험으로 잠근다. 깨지면 ADR-0200 증보가 먼저다. `awaiting_approval`을 쓰지 않는다: 그 phase는 「작업 중이 아님」이다).
  4. **결과와 재개.** 박스의 `events` 보고(tenant tx, NOBYPASSRLS `momo_app`)가 결과를 `host_ops_command`에 쓰는 **같은 tx에서 resume job을 outbox로 enqueue**한다(`approvals.rs:1218-1250`의 `approve_run`이 승인 결정 tx에서 `OutboxKind::AgentJob`(`RESUME_APPROVAL_JOB_METHOD`) 행을 enqueue하는 방식). job payload에는 `command_id`만 싣는다. 재개된 worker는 `SET LOCAL ROLE momo_hostops`로 결과를 읽어 다음 모델 호출의 입력(`resumed_tool_note`, `momo-agent-worker/src/lib.rs:886-905`의 자리)으로만 쓰고 **읽은 같은 tx에서 지운다**(지운 뒤 worker가 죽으면 결과는 사라지고 그 명령은 `lost`로 보이며 에이전트가 재실행을 판단한다 — 재배달은 없다). 채널에 쓰는 `tool_result` 메시지는 ≤512 B 정화 발췌와 sha256뿐이다(`write_result` 불사용). 세션 종료·revoke·dead-man·스위치 off는 같은 tx에서 대기 명령을 `lost`로 닫고 resume job을 enqueue해 run이 영원히 대기하지 않게 한다.
  5. **마감.** 박스가 살아 있는데 보고가 없는 명령(제한 시간 + 60초 초과)과 5분 지난 미소비 결과 행은 **기존 notifier 정리 스위프에 행 종류 하나를 더해** 닫는다(BYPASSRLS 풀로 후보를 읽고 RLS 묶인 풀로 쓰는 기존 두 풀 모양, ADR-0208 맥락의 `momo-notifier` 정리 작업). 새 소비자·새 BYPASSRLS 역할은 만들지 않는다. worker는 host 표를 타이머로 폴링하지 않는다.
  6. **사전 조건 두 번 확인.** D5-4의 조건(루트 run·driver·방·세션·승인자·에이전트·능력 값)은 1단계(명령 기록 직전)와 4단계(재개 직후)에서 각각 본다.
- **세션이 덮지 않는 호출은 승인 카드 없이 거절한다.** 세션 없음·다른 방·다른 에이전트·driver 불일치·프로필 비활성의 `host.*` 호출은 `ToolDisposition::Refused`(`refused_spawn_target`과 같은 자리)로 답하고 승인 카드를 만들지 않는다. `approval_reason`은 DB를 보지 않는 함수라서 「세션이 덮음」 판정은 `record_tool_call` 안(DB를 보는 곳)에서 하고, `host.*`는 에이전트 프로필이 켠 경우에만 광고·실행한다(`exempt_tool_not_enabled` 패턴, `momo-agent/src/tools.rs:885-901`).
- **Phase 1에서 박스 도구가 없는 곳:** 팀 AI(제안만, ADR-0201 D2), 외부 Agent Port 에이전트(그록봇 등 다이얼인 에이전트의 박스 사용은 별도 증보). 에이전트가 제안한 `host.*`는 사람 승인 전에 아무것도 바꾸지 않는다.
- **Hermes 도구 잠금은 바뀌지 않는다**(ADR-0203 D6, 성재 「같은 프로젝트·도구 끔」). 박스는 Hermes와 별개의 컴퓨터이고 Hermes의 `terminal` 백엔드를 박스로 향하게 하지 않는다(그 경우 Hermes 쪽 위험 명령 검사가 꺼지고 oort가 도구 호출을 못 봐 감사가 빈다 [웹, r4 §6 D-8]). 이 결정은 r4가 「성재 한 줄 확인」을 권했으나 10-22 위임으로 갈음하며 PR 본문의 권장 표에 올린다.

### D10. 컨트롤 플레인 변경과 오너 직접 접근 [owner 「oort 본체는 타입 있는 동작만」, Railway 토큰 0은 권장]
- **oort는 Railway 토큰(account·workspace·project·OAuth)을 쥐지 않는다.** ADR-0203이 「Railway API로 서비스 목록을 읽어 자동 발견」을 같은 이유(토큰을 oort에 보관해야 한다)로 기각했고, S1이 토큰 하나로 root exec·변수 읽기·시작 명령 변경이 된다고 실측했다. 대가는 설치가 오너 손을 거친다는 점이고 ADR-0184 D2의 승인 지점 규율이 이미 이 모양이다.
- 컨트롤 플레인 변경은 타입 있는 동사이고 드라이버 어휘에 `exec`가 없다(I10). Phase 1은 오너 세션(CLI·MCP)이 실행하고 oort는 계획·승인 기록·검증을 맡는다. 오너 맥 `workd`의 닫힌 `railway`·`docker compose` 동사(HO-23)는 별도 ADR이다(오너 기기가 컨트롤 플레인 변경을 실행하는 새 경계).
- **오너의 직접 접근**(`railway ssh`, Tailscale SSH `check`+녹화)은 사람의 도구이지 에이전트 경로가 아니다. 제어 경로에 Tailscale을 두지 않는다(ADR-0188 D1·§5). 문서는 HO-26.

### D11. 실패·복구·스냅샷 [권장]
- **Reset** = 재배포(컨테이너 파일시스템 리셋, 볼륨 유지). **Hard reset** = 볼륨까지 삭제하고 재생성(데이터 손실 경고). 「내구」는 의도 표명이지 SLA가 아니라고 문서에 적는다(RULE-6). Railway의 키 보관 방식 (b)를 택하면 Reset마다 D5-9 재확인이 든다.
- **스냅샷은 허용한다.** 박스에는 인프라 비밀이 없으므로 개인 박스의 snapshot 금지(ADR-0197 D2·D7)와 **일부러 다르다.** 단 사용자가 박스에 넣은 데이터와 박스 host 키(S4의 봉인 파일)는 스냅샷에 들어가므로, 복원한 박스는 신원 확인(D5-9)을 다시 거친다.
- **설치 실패:** 매니페스트의 `undo`(만든 서비스·변수 역순 제거)와 설치 전 상태 기록(서비스·변수 **이름**·digest)이 되돌리기의 근거다. Railway는 변수 변경 이력이 없다 [추정].
- 컨트롤 플레인 업그레이드 실패는 기존 절차(`V0135` digest 롤백, `oort backup/restore`)를 동사로 감쌀 뿐 새로 만들지 않는다.

### D12. 박스 안 권한·자원·남용 [권장]
- 셸은 **non-root**이고 사용자 영역 설치(`mise`·`uv`·npm prefix)로 일한다. sudo는 Phase 1에 없다. ADR-0125 D8(비특권 유저·sudo 금지)이 이미 Accepted다. userns-root `sudo`는 VM의 rootless에서 Phase 2에 **별도 승인 종류**로만 연다(Railway 컨테이너의 userns-root 보증을 모른다).
- **uid는 셋이다.** 박스 데몬(A, 능력 없음, 감사·키·서명), 헬퍼(H, `CAP_SETUID`+`CAP_SETGID`만, 개인 박스의 `spawn_helper` 계보 — `momo-box-runner/src/template.rs:7-10`, `momo-box-agent/src/lib.rs:9`), 셸(U). 헬퍼의 **닫힌 동사**는 `exec`(셸 줄·cwd·환경 허용목록·한도를 받아 uid U로 실행)·`kill_session`(세션 프로세스 그룹)·`kill_all`(uid U의 모든 프로세스)뿐이고 파일 동사는 없다. 데몬은 root로 돌지 않고 셸 uid와 uid·gid가 다르다(`preflight.rs:26`의 `check_separation`을 재사용하고 세 uid가 서로 다름을 단정한다).
- **Ops 데몬은 별도 바이너리**(가칭 `momo-box-ops`)다. 개인 박스 데몬 크레이트에는 `pty`·`host`·`register` 모듈이 있으므로(`momo-box-agent/src/lib.rs:4-15`) 같은 크레이트를 쓰면 「PTY·ACP·구독 하네스 코드 없음」을 지킬 수 없다. `fsgate`·`preflight`·`env`와 헬퍼의 필요한 부분만 재사용하고(공용 크레이트로 빼거나 기능 플래그로 가른다 — HO-11이 정한다), Ops 바이너리에는 `pty`·`host`·`register`·ACP가 링크되지 않으며 인바운드 포트가 없다.
- **host 키 보관**은 개인 박스의 S4 모델을 재사용한다: 박스 안에서 생성하고 데몬 uid A 전용 봉인 파일에 두며 셸 uid는 읽지 못한다(`docs/research/S4-linux-box-host-key-custody-spike.md`, `momo-workd/src/keystore/box_store.rs`). Railway에서의 성립은 D8 ⑤이다. 키가 바뀌면 조용히 받아들이지 않고 재확인한다.
- Railway는 볼륨 크기를 정할 수 없다 [V, S1]. 비용은 사용량 과금이라 유휴 박스는 월 약 $0.05~0.15이다 [V, S1:③]. 상시 1 vCPU·2GB 가정의 월 약 $40은 [추정]이고(S1이 「실측 아님」으로 적은 값) **Railway 박스에는 자원 상한이 없어** 상한 수단이 없다. 그래서 doctor가 사용량을 보이고, 서비스 리소스 한도 설정 가능 여부를 #4348이 잰다.
- 박스 이미지는 oort 이미지와 같은 발행·digest 핀·출처 증명 절차를 따른다(HO-11·HO-14). 이미지에는 oort 자격이 없고 setuid·setgid 바이너리가 없다.
- 공개 문장 규율: 박스에 대한 보안 문장은 ADR-0214 D1에 따라 `claims.yaml`에 증명 시험이 붙기 전에는 쓰지 않는다(HO-17).

## 기각한 대안
| 대안 | 기각 이유 |
|---|---|
| (a) 컨트롤 플레인 컨테이너에 에이전트 `exec` | api·DB·푸시 키가 한 셸에 모인다(r4 §3.2). [A]·[B]·[C]가 다 생긴다 |
| (b) 같은 환경의 사이드카 셸 | 같은 환경은 서로 제한 없이 닿는다 [V]. Hermes는 도구가 잠겼기에 가능했던 선택이었다 |
| (c) oort api에 Railway 토큰 | 스코프를 못 좁히고 root exec이 된다 [V, S1]. ADR-0203이 같은 이유로 기각했다 |
| (d) Hermes `terminal` 켜기(`lockgate` 해제) | `/opt/data`의 구독 OAuth·대화 기록 옆에 셸이 앉는다. ADR-0203 D6 위반 |
| (e) 서버가 PTY 바이트를 중계 | 0125 D10 위반 |
| (f) 개인 박스(ADR-0197) 재사용 | 소유자 본인 셸 모델이라 결정자·감사·모델 경로가 다르다. 부품만 재사용한다 |
| (g) 팀 박스를 **일반 workspace 호스트**로 등록하고 `capabilities`에 `ops` 표시 | 호스트 자기 보고를 서버가 믿게 되고, R0 밖이라 채널 멤버 승인·`work_auto_approve`·후보 노출이 그대로다(D1) |
| (h) 처음부터 별도 Railway 프로젝트 | 성재 정정(10-22)으로 뒤로 미룬다. 환경 분리가 실측에서 실패할 때의 R-b다 |
| (i) 서버가 전사 전체를 저장 | 0125 D10 증보와 별도 보안 검수가 필요하다. 명령 단위 발췌로 충분하다 |
| (j) 승인을 일반 승인 결정 라우트에 서명 없이 맡김 | bearer 한 장으로 대화 밖 승인이 위조된다. R2가 꺼지면 문이 닫힌다(D2) |
| (k) 2인 승인 | 승인 피로가 크다(r4 §7). 서명·TTL·범위·driver로 받는다 |
| (l) Tailscale을 에이전트 제어 경로에 | 팀원 tailnet 가입이 필요하고 ADR-0188 §5가 이미 기각했다 |
| (m) 컨트롤 플레인이 루트 동등 SSH 키를 보관(Coolify 모델) | 템플릿 설치 모델은 채택하되 이 보관은 반면교사다 [웹, r4 §2.5] |
| (n) Railway Sandboxes를 지금 채택 | 베타, egress 수단 없음, 단가 5배 [웹, S1 남은 일]. HO-24에서 재평가 |
| (o) `host.*`를 현행 단일 단계 도구 경로(`write_result`·`finish_tool_turn`)에 그대로 얹기 | 명령·인자·출력 전문이 `message`·props에 영속·브로드캐스트되고 한 턴에 한 명령으로 끝난다(D9) |
| (p) `host.*` 실행기가 worker의 BYPASSRLS 권한으로 host 표에 접근 | 테넌트 격리가 쿼리마다의 `workspace_id` 조건 규율에만 달린다. 셸 표면에서 가장 위험한 버그 종류다(D9) |
| (q) 승인 대기 중 run을 `awaiting_approval`로 표시 | 그 phase는 「작업 중이 아님」이라 승인 카드가 없는 대기를 승인 대기로 보이게 한다(ADR-0200 D1) |

## 결과
- (+) 도우미 에이전트가 자기 컴퓨터를 갖는다. oort 비밀과 사설망에는 **필터가 아니라 부재·분리로** 닿지 않는다.
- (+) 기존 조각을 재사용한다: 박스 데몬의 uid 분리·preflight·`fsgate`·헬퍼, 서명 요청 v2, 승인 카드와 `opens_in_app`, 세션 스레드 카드, R2 서명 사슬, 도구 카탈로그, `momo_helper_read` 모양의 DB 역할.
- (+) 10-22 정정을 지킨다: 새 프로젝트 없이 실측이 먼저이고 실패할 때만 묻는다.
- (+) 새 레인이 ADR-0188 §3 불변식을 건드리지 않는다. 일반 spawn·승인 경로가 박스에 닿는 길은 DB 트리거가 막는다.
- (−) Railway는 egress를 강제할 수 없고(`advisory`) 환경 분리·uid 분리·키 보관은 실측 전이다. **Railway Ops는 #4348 통과 전에는 켜지 않는다.**
- (−) R2 서명 요구가 켜진 인스턴스에서만 열린다. 운영 값 확인(HO-28)이 선행하고, 웹 브라우저에서는 열 수 없다.
- (−) Phase 1의 서명 검증은 서버가 해서 서버 침해 시 박스가 쓰일 수 있다(RISK-1).
- (−) 박스는 한 신뢰 영역이고 동시 세션은 1이다. 에이전트의 반복 루프는 **새 실행 구조**라 HO-18이 증보를 먼저 쓴다.
- (−) 설치 평면은 Phase 1에서 oort가 실행하지 않는다(오너 손을 거친다). 자동 실행기는 별도 ADR이다.
- (−) 운영 부담: Railway 유휴 약 $0.1/월·상시 비용은 상한 없음 [V·추정, S1], 별도 환경 관리, 감사 신뢰를 위한 uid 분리 필수.

## 이 ADR이 열지 않는 것
자격 부여(I6, ADR-0211·0212·0205 증보 몫) · 박스 안 구독 하네스·모델 키 · 외부 Agent Port 에이전트와 팀 AI의 박스 도구(D9) · 오너 라이브 attach(PTY, HO-25) · 설치 실행기(HO-23, 별도 ADR) · 시크릿 브로커(HO-21, 별도 ADR) · VM `hostd`의 동사 스키마(HO-20 착수 전 증보) · 박스 데몬의 직접 서명 검증(HO-27) · 에이전트 반복 루프의 상세(HO-18의 증보) · 동시 세션 둘 이상과 세션별 uid·홈 분리 · Railway Sandboxes(HO-24) · 워크스페이스당 둘 이상의 박스.

## 불변식 대조 (AGENTS.md 「반드시 보존할 계약」)
- **REST send → channel_seq + message + outbox 단일 tx → relay → Centrifugo.** 채널 카드는 `send_message_in_tx`로만 쓴다. 박스는 직접 publish하지 않는다(D6-5).
- **에이전트는 1급 멤버.** 세션은 기존 `member.kind='agent'` 멤버에 묶이고 새 클래스를 만들지 않는다(D9).
- **`workspace_id` + RLS FORCE + tx마다 `SET LOCAL app.workspace_id`.** 새 표는 모두 테넌트 표이고 RLS FORCE·`ws_isolation` 정책 대상이다. `host.*` 실행기는 `SET LOCAL ROLE momo_hostops`(NOBYPASSRLS)로 우회 비트를 내린 뒤에만 host 표를 만지고(D9), 박스 서명 경로·페어링 claim은 NOBYPASSRLS `momo_app`의 tenant tx 안이다(D5-9). **새 BYPASSRLS 소비자·역할을 만들지 않는다.** 마감 처리는 기존 notifier 정리 스위프에 행 종류 하나를 더하는 것이고 BYPASSRLS 풀로는 후보만 읽는다(두 풀 모양). AGENTS.md가 적은 「기존 예외」는 relay·agent-worker이고 notifier도 같은 두 풀 모양의 기존 소비자다(ADR-0208 맥락).
- **`schema_v0.sql` 무접촉.** 확장은 `server/Migrations/` 새 migration이다(번호는 착수 때). Rust는 런타임 sqlx 쿼리다.
- **ADR-0004 자격 비유입.** 박스에는 구독·API 키가 없고 서버가 받는 것도 없다(I1·D9).
- **ADR-0188 §3 불변식**(결정자 = 소유자, 에이전트 컨트롤 `kill`만, 원격 `shell` 금지)은 `scope='member'`에 **그대로**다. Ops 레인은 그 밖에서 별도 `type`·어휘·결정자 규칙으로 선다(D1·D5).
- **0125 D8·D10**, **ADR-0203 D6**, **ADR-0157 D1~D3**: 0125 D8의 마지막 항(agent 단계 기본 네트워크 제한)만 **이탈**을 명시했고(D8) 나머지는 D6-6·D9·D12·I2·I3으로 그대로다.
- 시크릿·사용자 데이터·빌드 산출물 커밋 금지, 의존성은 permissive(새 의존은 NOTICE 반영). 이 ADR은 새 의존을 정하지 않는다.

## 새 공개 API·DB 선언 (ADR-0100)
이 ADR의 Accepted가 아래의 근거 선언이다. 경로 이름·본문 모양·OpenAPI는 각 구현 이슈가 확정한다(ADR-0146 선례).
| 표면 | 내용 | 인증·서명 | 슬라이스 |
|---|---|---|---|
| 설정 | `GET·PUT …/host-ops/settings`(스위치·동의 기록) | 사람 bearer owner·admin. 켜기는 R2 요구 인스턴스 | HO-10 |
| 페어링·박스 | 코드 발급, 박스 claim(`{ws}`로 tenant tx, 코드 한 번, 레이트리밋, 비공개 응답), 확인, 목록, revoke, 소유자 승계 | 발급·목록·revoke: owner·admin(서명 불필요). claim: 코드. **확인·승계: `ops_box` 서명** | HO-10 |
| 세션 | 열기, 목록, 끊기, 모두 끊기 | 열기: **`ops_session` 서명**. 끊기·모두 끊기: 서명 불필요. 에이전트 요청은 ADR-0186 행동 `host.session.open`: 결정 입력(`DecisionInput`)에 서명 필드를 더하고 행동별 승인 대기 TTL(10분)이라는 **레지스트리의 새 속성**을 갖는다(등록은 HO-15) | HO-10·HO-15 |
| 상태 | 읽기 전용 상태 보기(네트워크 호출 0) | owner·admin | HO-16 |
| 박스 서명 경로 둘 | `GET …/host-ops/boxes/{host}/pending`, `POST …/host-ops/boxes/{host}/events` | 서명 호스트 v2. `work_host_auth` allow-list에 정확히 둘 추가, 서명자·경로·type·박스 짝 핀을 서버가 강제 | HO-10·HO-11 |
| 서명 | 새 스키마 문자열(가칭 `momo.human.control.v5`)과 kind `ops_session`·`ops_box`, `human_control_nonce_kind_ck`(`095_human_control_nonce.sql:59-60`)에 두 kind 추가, `action_signature` 기록 | ADR-0146 사슬 | HO-10 |
| 환경 | `MOMO_HOST_OPS_ENABLED`(정확히 `true`만 연다, 열려 있는데 `MOMO_INSTANCE_ID`가 없으면 기동 오류) | 운영자 | HO-10 |
| 에이전트 도구 | `host.exec`·`host.read`·`host.write`(`CATALOG`), 새 resume job 종류(payload는 `command_id`만) | 서버 내부(공개 REST 아님) | HO-18 |
| DB 역할 | `momo_hostops`(NOLOGIN NOBYPASSRLS, `host_ops_*` 표에만 GRANT, `momo_worker`에 GRANT) | — | HO-10·HO-18 |
| DB(번호는 착수 때) | `host_ops_settings`(스위치·동의), `host_ops_pairing`(코드 해시·만료), `host_ops_box`(상태·보고 능력·확인 서명 요약), `host_ops_session`, `host_ops_command`(닫힌 컬럼, 일시 결과 열), `host_ops_event`(추가 전용·체인), `work_host_type_ck`에 `ops` 추가, `work_control` 대상 거부 트리거 | 전부 RLS FORCE, 비밀·전사 원문 컬럼 없음 | HO-10 |

## 증보 대상 (역방향 한 줄, 본문 결정은 바꾸지 않는다)
ADR-0188(`scope='member'` 불변식 불변, Ops는 별도 레인) · 0192 D7(A4 충족, D2 페어링 초안 채택) · 0125 D8·D10(비특권·sudo 금지와 D10은 그대로, D8 마지막 항은 이탈) · 0190 D1·D6(PTY 소유·raw 관전은 다른 레인) · 0191 D2(박스에 구독 로그인을 두지 않는 근거) · 0197(증보 1의 「B 닫힘」은 개인 박스 한정) · 0203 D6(Hermes 잠금 불변) · 0157 D1~D3(박스에도 적용) · 0146(서명 kind `ops_session`·`ops_box`, D-10 이탈은 Phase 1 한정) · 0186(`host.*` 행동 어휘의 방향과 `host.session.open`의 결정 방식 확장) · 0204(`host.*`는 항상 앱에서 연다). 0201(팀 AI 허용 목록)과 0186 레지스트리 등록은 HO-15가 증보로 쓴다. 각 문서에는 상태에 기대지 않는 문장으로 한 줄만 달았다(「0197(Proposed)」처럼 낡는 표기를 피한다).

## 수용 기준 (red proof) — 각 문장은 「해당 분기를 지우면 시험이 실패한다」
**HO-10 서버 Ops 호스트 레인**(격리 PG conformance, OpenAPI golden, migration 번호 CI)
- **RP-1** 인스턴스 문이 닫혀 있으면 host-ops의 **모든** 라우트(끄는 쪽·박스 서명 경로 포함)가 DB를 읽기 전에 404이고, 문이 다시 열리면 `open` 세션이 `expired`로 정리된다. 문 검사 분기나 재개방 정리를 지우면 이 시험이 실패한다.
- **RP-2** 워크스페이스 스위치가 꺼져 있으면 세션 열기·박스 확인·박스 poll이 거절되고 끄는 쪽 라우트는 동작한다. 스위치 분기를 지우면 실패한다.
- **RP-3** R2 서명 요구가 꺼진 인스턴스에서는 스위치 켜기·세션 열기·박스 확인·소유자 승계가 403 `device_signature_required`이고 켜져 있던 세션은 닫힌다(켠 **뒤에** R2가 내려가는 경우 포함). 서명 필드 없는 요청은 R2가 켜져 있어도 꺼져 있어도 403이다. 요청마다의 재확인 분기와 서명 필수 분기를 각각 지우면 실패한다.
- **RP-4** `ops_session` 서명문의 `host_id`·`agent_member_id`·`channel_id`·`ttl`·`driver`·egress 선언·uid 분리 선언·hardening 선언·`tools`·`approval_id` 중 **한 필드씩** 바꾸면 각각 거절되고 같은 nonce 재사용은 거절된다. 이 시험은 **직접 열기 라우트와 두 결정 라우트**에서 각각 돈다(같은 실행기를 지나는지 단정). 각 필드를 서명 본문에서 빼거나 한 입구의 검증을 지우면 해당 행이 실패한다.
- **RP-5** 일반 멤버·에이전트 bearer·웹훅·도어벨·서명 호스트의 열기·확인·승계 호출은 403(또는 401)이다. 역할 분기를 지우면 실패한다.
- **RP-6** `work_auto_approve`가 켜져 있어도 Ops 세션이 자동으로 열리지 않고, 승인 방의 일반 멤버(비 admin)의 결정은 403 `role_required`다. 자동 승인 분기를 열면 실패한다.
- **RP-7** 일반 `work.spawn` 승인으로 Ops 호스트를 대상으로 삼으면 거절되고, `work_control`에 Ops 호스트 대상 행을 **직접 INSERT·UPDATE**해도 DB 트리거가 거부한다. 트리거와 적격 검사를 각각 지우면 실패한다.
- **RP-8** `spawn_host_candidates_in_tx`는 Ops 호스트를 후보에 넣지 않는다. 필터를 지우면 실패한다.
- **RP-9** 일반 `POST …/work-hosts`는 `type='ops'`를 거절하고, `host_ops_box` 없는 `type='ops'` 행은 DB가 거절한다. 두 분기를 지우면 각각 실패한다.
- **RP-10** 동시 세션 2번째·에이전트당 대기 4번째·박스 두 번째 등록·세션당 명령 1,001번째는 각각 409(또는 거절)다. **병렬 N요청** 시험에서 동시에 연 두 세션 중 정확히 하나만 성공하고 같은 승인의 이중 소비는 하나만 통하며, 만료됐지만 `open`으로 남은 세션은 상한을 점유하지 않는다. 박스 행 잠금·CAS·만료 계산을 각각 지우면 실패한다.
- **RP-11** TTL이 지난 뒤 명령 소비는 DB 시계 기준으로 거절되고, 12시간을 넘는 TTL 요청과 유휴 30분(마지막 명령 종료 기준) 경과 세션은 닫힌다. TTL 검사를 지우면 실패한다.
- **RP-12** 승인자가 강등·비활성이 되거나 묶인 에이전트가 비활성이 되거나 박스가 확인 서명과 다른 능력 값을 보고하면 다음 소비에서 세션이 닫힌다. 승인자·에이전트·능력 값 재확인 분기를 지우면 실패한다.
- **RP-14** 박스 revoke 뒤 다음 서명 요청은 즉시 401이고 열린 세션은 같은 tx에서 `killed`다. revoke 연동을 지우면 실패한다.
- **RP-15** 서명 경로 핀과 allow-list: (a) 다른 서명 호스트(`workd`·member `cloud`)가 박스의 pending·events를 부르면 401 (b) Ops 호스트의 키로 heartbeat 외 기존 서명 경로(`work-sessions`·`work-tool-profiles`·`pending-controls` 등)를 부르면 거절 (c) 서명 호스트가 열기·확인·결정·설정 라우트를 부르면 allow-list 단계에서 401 (d) 박스가 다른 박스·다른 워크스페이스의 세션·명령 id로 보고하면 거절. 각 핀·검사 분기를 지우거나 allow-list에 그 경로를 더하면 실패한다.
- **RP-16** 등록한 admin이 비활성이 되면 박스 요청은 401이고, **강등**(활성 사람이지만 owner·admin 아님)되면 인증은 통과해도 박스 경로가 거절하며, 상태는 「소유자 필요」다. 다른 admin의 `ops_box` 서명 승계 뒤에만 복구된다. 코드 발급자와 확인자가 달라도 되지만 한쪽이 비 admin이면 거절된다. 역할 재확인·승계 분기를 지우면 실패한다.
- **RP-17** 페어링: 재사용·만료·다른 워크스페이스의 코드·비 admin이 발급한 코드·레이트리밋 초과·확인 전 컨트롤 수신이 각각 거절된다(ADR-0192 D2의 다섯에 workspace 범위의 둘을 더했다). 모르는 ws·틀린 코드·만료·사용됨의 응답은 같고, claim은 `{ws}`의 tenant tx 안에서만 코드를 조회한다(소스 시험: 전 테넌트 조회 없음). 각 분기를 지우면 실패한다.
- **RP-18** 교차 테넌트: 다른 워크스페이스의 box·session·command·event id로 모든 라우트가 404이고 새 표 전부가 RLS FORCE·`ws_isolation` 정책 대상이다. 정책을 지우면 실패한다. host-ops 모듈은 BYPASSRLS 풀을 쓰지 않는다(소스 시험).

**HO-11 박스 이미지·박스 데몬 Ops 모드**
- **RP-19** 셸 uid에서 감사 디렉터리·host 키의 읽기·쓰기·삭제·ptrace가 거부되고, preflight(세 uid 분리)가 실패하면 exec 채널이 열리지 않는다. 셸 자식의 `NoNewPrivs=1`·`CapEff=0`이고 이미지에 setuid·setgid 바이너리가 0개다(빌드 시험). 각 분기를 지우면 실패한다.
- **RP-20** 명령 120개 시험에서 감사 레코드 120건과 체인 검증이 통과하고, 중간 레코드를 지우는 사보타주에서는 서버가 `chain_gap`을 낸다. 체인 검증을 지우면 실패한다.
- **RP-21** TTL 타이머를 지우면 시험이 실패한다. 서명 poll이 연속 90초 실패하면(404 포함) 열린 세션이 닫히는 시험은 dead-man 분기를 지우면 실패한다.
- **RP-22** 박스 환경 변수 이름 집합이 허용목록(플랫폼이 주입하는 `RAILWAY_*`와 범용 이름 명시)과 정확히 같고 카탈로그 서비스별 변수 이름 중 시크릿성 이름(`*_KEY`·`*_SECRET`·`*_PASSWORD`·`DATABASE_URL`·`*_B64` 등)이 0건이다. **허용된 이름 아래에 시크릿 값을 심으면** 값 기반 `leakscan`이 잡고 exec 채널이 열리지 않는다. 이름 검사와 값 검사를 각각 지우면 실패한다.
- **RP-23** Ops 데몬 바이너리에 ACP·구독 하네스·PTY·`host`·`register`가 링크되지 않고(의존 그래프·심볼 시험) 인바운드 리스너가 0개다. 그런 코드나 리스너를 더하면 실패한다.
- **RP-24** 같은 `command_id`를 두 번 받아도 한 번만 실행하고, 서버는 재배달하지 않는다. 중복 거절 분기를 지우면 실패한다.
- **RP-41** dead-man·revoke·모두 끊기·스위치 off·TTL 만료 뒤 `setsid`·이중 fork로 프로세스 그룹을 벗어난 셸 uid 프로세스가 0개다. 세션 하나만 끝나면 그 세션의 그룹만 종료된다. 헬퍼의 `kill_all`·`kill_session`을 각각 지우면 실패한다.
- **RP-43** Railway 박스에서 host 키 보관이 S4 게이트를 통과하지 못하면 박스가 등록하지 않고 평문 키는 셸 uid가 쓸 수 있는 디렉터리 아래에 없다. 키가 바뀌면 재확인 전에 세션이 열리지 않는다. 게이트·디렉터리 분리·재확인 분기를 지우면 실패한다.

**HO-12 감사 이벤트와 채널 기록**
- **RP-25** 실제 worker 경로로 `host.exec`를 한 번 실행한 뒤 서버의 **모든** 테이블·outbox·job payload·`audit_log`·`message`(본문·props)·로그·메트릭에서 **발췌 창 밖에 심은 전사 표식 문자열**이 0건이다. 소비된 일시 결과의 출력 열은 비어 있고 5분 지난 행은 정리 스위프가 지운다. 발췌 상한·소비 시 삭제·스위프를 각각 지우면 실패한다.
- **RP-26** 보이지 않는 문자·방향 제어 문자·자격 패턴이 명령 줄·발췌에서 가려진다. 정화를 지우면 실패한다.
- **RP-27** 채널 이벤트 수가 명령 수와 같고 모두 `send_message_in_tx`로 쓰여 outbox 행이 1:1이다. 직접 publish 경로를 더하면 실패한다.
- **RP-28** `host_ops_event`는 UPDATE와 직접 DELETE가 거부되고 워크스페이스 삭제 연쇄는 HO-12가 정한 방식(tombstone·`pg_trigger_depth()`)으로만 통과한다. 트리거를 지우거나 연쇄 규칙을 바꾸면 실패한다.
- **RP-44** 감사 이벤트가 `run_id`·`trigger_message_id`·`driver`·`approver`·`box_id`·`session_id`·`command_id`를 모두 싣는다. 한 열이라도 빼면 시험이 실패한다.

**HO-13 UXUI·HO-14 레시피·HO-15 도우미 연결·HO-16 상태**
- **RP-29** 승인 카드 모델이 범위·남은 시간·이그레스 모드·「시크릿 없음」·uid 분리·hardening·driver 일곱 줄을 모두 그리고 박스 보고값에 「선언값」 표기를 단다. `room` 선택 때 「이 방의 모든 멤버(N명)」 문구가 크게 나온다. 한 줄이라도 지우면 카드 시험이 실패한다. 웹에서는 열기 버튼이 서명 불가 안내로 바뀌고 그 분기를 지우면 실패한다. 화면은 네 상태(로딩·빔·오류·권한 없음) 시험과 design-review Blocker 0·High 0, 폰·데스크탑·웹 캡처를 요구한다(미실행 캡처는 미검증으로 기록).
- **RP-30** `check_railway_catalog.py --prove-mutations`에 Ops 박스 규칙(공개 도메인 없음·oort 변수 0·digest 핀·시작 명령 정본·빈 환경·**환경당 서비스 1개**)이 있고 각 규칙을 깨는 사보타주가 전부 RED다.
- **RP-31** 에이전트의 `host.*` 제안은 사람 승인 전에 행 수를 바꾸지 않고, 비운영자는 403이며, 에이전트당 대기 3개 상한이 있고, 외부 Agent Port 에이전트의 제안은 거절된다. 각 분기를 지우면 실패한다.
- **RP-32** `opens_in_app`은 모든 `host.*` **행동 id**와 **툴 이름** 두 갈래에서 true이고 `push_action` 토큰으로 결정하면 403 `opens_in_app`이다. 두 arm을 각각 지우면 실패한다.
- **RP-33** 상태 라우트는 네트워크 호출이 0이고 owner·admin만 읽으며 값·비밀을 싣지 않는다. 호출을 더하면 실패한다.

**HO-17 보안 시험 스위트**
- **RP-34** 모든 격리 프로브(사설·CGNAT·메타데이터·IPv6·이웃·SMTP)는 규칙 적용 전 OPEN(baseline)이고 적용 후 BLOCKED이며 이름 있는 카운터가 오른다. 규칙 파일을 깨면 RED다(로컬에서만 실행).
- **RP-35** 적대적 지시 코퍼스가 내부망·oort API·시크릿에 닿지 못한다. 차단 규칙을 지우면 코퍼스 시험이 실패한다(방법·통계만 공개, 코퍼스는 비공개 — ADR-0214 D5).
- **RP-36** 박스에 대한 공개 보안 문장은 `claims.yaml`에 증명 시험이 붙은 것만이다. 증명 없는 문장을 더하면 ADR-0214 린트가 실패한다.

**HO-18 에이전트 도구 배선과 반복 루프**
- **RP-13** 묶인 에이전트가 **다른 방**에서 선 run으로 `host.exec`를 부르면 거절되고, 같은 방의 루트 run은 성공한다(대조군). 방 대조 분기를 지우면 실패한다.
- **RP-38** run 출처: A2A 자식 run(`parent_run_id` 있음)·에이전트·웹훅·도어벨·시스템이 쓴 트리거·Welcome 트리거·예약 전송이 만든 run의 `host.exec`는 거절되고, driver인 사람의 루트 run은 성공한다(대조군). driver가 한 사람일 때 방의 다른 멤버의 트리거는 거절되고 `room`이면 성공한다. 각 분기를 지우면 실패한다.
- **RP-39** 세션이 덮지 않는 `host.*` 호출(세션 없음·다른 방·다른 에이전트·driver 불일치·프로필 비활성)은 승인 카드 0건·거절 결과이고, 프로필이 켜지지 않은 에이전트에게는 도구가 광고되지 않는다. 분기를 지우면 실패한다.
- **RP-40** worker 경로에서 다른 테넌트의 session·box·command id를 넣으면 0행·거절이다(host 표 접근이 `SET LOCAL ROLE momo_hostops`를 거친다). worker의 host.* 경로가 BYPASSRLS 풀로 host 표를 만지면 소스 시험이 실패한다.
- **RP-42** 박스의 events 보고가 결과 기록과 같은 tx에서 resume job을 enqueue하고(job payload에는 `command_id`만), 재개된 worker가 읽은 결과를 같은 tx에서 지운다. 박스가 무응답이면 마감 처리가 명령을 `lost`로 닫고 run을 깨워 run이 영원히 대기하지 않으며, 대기 중 run은 고아 run 스위프에 종결되지 않는다. worker에 host 표를 타이머로 읽는 코드가 있으면 소스 시험이 실패한다.

**이 ADR의 문서 PR**
- **RP-37** 역방향 줄이 정확히 11개 문서에 있고 각 문서의 본문 결정 줄은 바뀌지 않았다(`git diff`가 머리 한 줄 추가뿐). 골격(맥락·결정·대안·결과·불변식·새 API·증보 대상·red proof)이 모두 이 문서에 있다.

## 구현 슬라이스
ADR Accepted 뒤 착수. 한 슬라이스 = 한 이슈 = 한 브랜치·PR, base `track/engine`. **번호는 이슈 발행 때 #4351 체크리스트에 단다**(#4351의 항목이 비어 있어 이 표가 그 목록의 초안이다). RP는 슬라이스 하나가 책임진다(RP-13은 HO-10 라우트의 방 대조를 시험하지만 `host.exec` 도구가 있어야 돌아서 HO-18 몫이다).
| ID | 제목 | 트랙·크기 | 의존 | 이슈 | red proof |
|---|---|---|---|---|---|
| HO-01 | 이 ADR | 엔진(문서)·M | — | **#4347** | RP-37 |
| HO-02 | Railway 박스 스파이크(oort-team 임시 환경) | 엔진·M | 병렬 | **#4348**(10-22 정정 반영. #2788은 같은 주제의 옛 이슈라 재범위화·종결은 planner) | D8 승격 조건 ①~⑤와 기록 항목 |
| HO-10 | 서버: Ops 호스트 레인(소유자 승계 포함) | 엔진·L | HO-01·02 | 신규 | RP-1~12·14~18 (RP-13은 HO-18) |
| HO-11 | 박스 이미지·Ops 데몬(별도 바이너리)·헬퍼 | 엔진·L | HO-02 | 신규 | RP-19~24·41·43 |
| HO-12 | 감사 이벤트·채널 기록 | 엔진+UXUI·M | HO-10·11 | 신규 | RP-25~28·44 |
| HO-13 | UXUI: 승인 카드·팀 박스 설정·세션 헤더·킬·위험 하이라이트 | UXUI·L | HO-10 | 신규 | RP-29 |
| HO-14 | Railway 박스 레시피와 doctor(`ops.registered`·`ops.online`) | 엔진·M | HO-02 | 신규 | RP-30 |
| HO-15 | 도우미 연결(0186 레지스트리·0201 허용 목록 증보, `opens_in_app`, 승인 뒤 재개 검토) | 엔진·M | HO-10 | 신규 | RP-31·32 |
| HO-16 | 상태 보기 카드 | 엔진+UXUI·S~M | — | 신규 | RP-33 |
| HO-17 | 보안 시험 스위트와 claims | 엔진·M | HO-11 | 신규 | RP-34~36 |
| HO-18 | 에이전트 도구 배선과 반복 루프(`host.exec/read/write`, 세션·방·driver 바인딩, `momo_hostops`) — r4에 없던 슬라이스. **착수 전 ADR 증보 필요**(루프·job·재개·단계 상한) | 엔진·M~L | HO-10·11 | 신규 | RP-13·38·39·40·42 |
| HO-27 | 박스 데몬의 서명 직접 검증(관리자 키 목록 고정) — P2, ADR 증보 먼저 | 엔진·L | HO-11 | 신규 | RISK-1을 닫는 시험 |
| HO-28 | 운영 값 확인과 켜기: oort-team의 `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`·`MOMO_INSTANCE_ID`. **선행: ADR-0146 D-11·ADR-0198 보안 검수와 owner 승인** | 운영·S | — | 신규 | Ops 켜기의 전제(D2) |
| HO-20 | VM 드라이버(rootless+nft, `install-box.sh --pair`, `hostd`는 증보 먼저) | 엔진·L | HO-11·17 | #2786(한 줄 설치·QR)·#3542(그록봇 VM 실측)가 입력 | 격리 프로브·`docker.sock` 미마운트 시험 |
| HO-21 | 시크릿 브로커·이그레스 치환 프록시 | 엔진·L | HO-20 | 신규, **ADR 필요**(I6) | |
| HO-22 | 스냅샷·되돌리기 | 엔진·M | HO-11 | 신규 | |
| HO-23 | 설치 실행기: 오너 맥 `workd` 닫힌 `railway`·`docker compose` 동사 | 엔진·L | HO-15 | 신규, **ADR 필요**(ADR-0184 D2 증보) | |
| HO-24 | Railway Sandboxes 재평가 | 엔진·M | — | 신규 | |
| HO-25 | 오너 라이브 attach(눈먼 PTY) | 엔진+UXUI·M | HO-11 | #3511(ADR-0197 M4)을 재사용 | |
| HO-26 | 오너 직접 접근 가이드 | 문서·S | — | 신규 | |

HO-19(소유자 승계)는 HO-10에 합쳤다(번호는 비워 둔다).

## 위험과 미확인
- **RISK-1 서버 침해 시 박스 사용.** Phase 1은 서버가 서명을 검증하므로 침해된 서버가 사람 승인 없이 세션을 열 수 있다. 피해는 박스 내용·egress 평판에 한정된다(D5-10). HO-27이 닫는다.
- **RISK-2 Railway egress 무통제.** SMTP가 열려 있고 수단이 없다 [V, S1]. 스팸·채굴·스캔·유출이 가능하다. 완화는 D7·D12와 운영자 고지이고 `advisory`를 승인 카드가 보인다. ADR-0125 D8 마지막 항에서의 이탈이다(D8).
- **RISK-3 프롬프트 주입과 한 신뢰 영역.** 박스 셸은 [A](채팅·웹·레포 내용이 주입될 수 있다)와 [C](인터넷·명령 실행)를 피할 수 없다. 인프라 비밀 [B]는 구조로 뺐지만 **에이전트가 컨텍스트에서 본 사용자 데이터를 박스로 옮겨 밖으로 보내는 길은 막지 못한다.** 박스 출력은 에이전트에게 신뢰할 수 없는 입력이다. 또 **박스는 한 신뢰 영역**이다: 같은 uid·홈·`/tmp`를 세션이 나눠 쓰고 디스크는 세션 사이에도 남으므로, 노출 상한은 「세션이 묶인 방」이 아니라 「그 박스에서 세션이 열렸던 모든 방」이다. 동시 세션을 1로 두고 방이 바뀔 때 Reset을 권하며, 승인 카드의 고지·driver·감사로 받는다.
- **RISK-4 승인 피로.** 세션 승인은 한 번이지만 잦으면 기계적으로 누르게 된다. 자격 부여가 열리면 범위·TTL로 좁힌다.
- **RISK-5 박스 탈출.** 컨테이너는 경계가 아니다(ADR-0144 D1의 원칙). Railway 플랫폼의 격리 기술은 [미확인]이고 VM은 rootless·userns·seccomp·no-new-privileges로 줄일 뿐이다. 같은 VM 공존은 위험이 커서 「약한 격리」로 표시한다.
- **RISK-6 교차 환경 격리·uid 분리·키 보관·공유 변수 가시성·`CAP_NET_ADMIN`**은 [미확인]이고 **#4348이 닫는다.** 닫히기 전에는 박스를 올리지 않는다(D8).
- **RISK-7 데몬화로 벗어난 프로세스.** 세션 하나만 끝날 때는 프로세스 그룹만 종료되므로 데몬화한 프로세스가 남을 수 있다. 박스 전역 사건은 `kill_all`로 지우고(D7), 세션 하나의 종료 뒤 잔존은 Reset으로 정리한다.
- **RISK-8 외부 수치의 신뢰.** 그록봇 sudo 기본값은 두 번의 요약 패스가 엇갈렸다 [웹, r4 §2.2]. 이 ADR의 결정은 그 값에 기대지 않는다.
- **RISK-9 개인 박스와의 혼동·구독 약관.** 별도 플래그·테이블·라우트로 분리했고(D1-6), 박스 안 구독 하네스는 Phase 1 밖이다(ADR-0193 D18).
- **RISK-10 반복 루프는 새 실행 구조다.** 현행 관리형 도구 경로가 한 턴 한 도구라 Ops의 반복 루프(D9)는 job·재개·단계 상한을 새로 정한다. 대기 중 `running` run이 고아 run 스위프에 안 잡힌다는 가정은 HO-18이 시험으로 잠그고, 깨지면 ADR-0200 증보가 먼저다.

## 결재 기록
**성재의 결정(원문)**
- 2026-10-21 요청: 위 「맥락」의 인용.
- 2026-10-21 결재: 셸 「박스 안만」(같은 날 미션 문서에는 「셸 전체」) · 대상 「둘 다 한 틀로」(Railway 먼저).
- 2026-10-22 정정: 새 프로젝트 없이 oort-team 안 임시 환경에서 망 격리부터 잰다. 안 되면 그때만 분리를 owner에게 묻는다.
- 2026-10-22 위임: 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」

**결정별 성격** (r4 §6 D-1~D-9와 이 ADR이 더한 것)
| 결정 | 이 ADR | 성격 |
|---|---|---|
| D-1 「셸 전체」의 경계 = 박스 안만 | D3·D4·D10 | **owner** |
| D-2 박스 배치 | D8 | **owner**(10-22 정정: 새 프로젝트 없이 임시 환경 먼저) + [권장] 세부(빈 환경·포크 금지·환경당 박스 하나·승격 조건·실패 때 갈 곳·VM 기본) |
| 대상 「둘 다 한 틀로」, Railway 먼저 | D8 | **owner** |
| D-3 Railway 자격 커스터디 = oort 토큰 0 | D10 | [권장] (ADR-0203 기각의 연장) |
| D-4 감사 단위 = 명령 단위 이벤트, 전사는 박스에 | D6 | [권장] |
| D-5 TTL·동시성 숫자 | D5 | [권장] (**동시 세션은 r4의 3이 아니라 1** — 박스는 한 신뢰 영역) |
| D-6 결정자 = 요청 방의 owner·admin, R2 서명 | D5 | [권장] (r4 (a) 「owner·admin 누구나」보다 좁힘) |
| D-7 root·sudo = non-root, sudo는 Phase 2 | D12 | [권장] |
| D-8 두뇌 = 서버, 손 = 박스 | D9 | [권장] |
| D-9 Hermes 잠금 유지 | D9 | [권장] (r4가 요청한 「한 줄 확인」을 위임으로 갈음) |
| 설치 평면은 Phase 1에 oort가 실행하지 않음(계획·승인 기록·오너 실행 레시피·검증). owner 요청의 「쉽게 설치」 중 **자동 실행이 뒤로 밀림** | D3·D10 | [권장] |
| 0125 D8 마지막 항(agent 단계 기본 네트워크 제한)에서의 **이탈**: Railway는 `advisory`, VM도 공용 인터넷은 열림 | D8, 0125 역방향 줄 | [권장] (ADR-0157 D3와 같은 이유) |
| R2가 꺼지면 Ops 자체가 닫힘(켜기 선행 조건은 ADR-0146 D-11·ADR-0198·owner 승인) | D2 | [권장] (r4는 「R2 켜진 인스턴스에서만 서명 필수」) |
| driver(누가 시킬 수 있나): 기본은 요청한 사람 또는 승인자 본인, `room`은 명시 선택 | D5 | [권장] |
| 이 ADR이 더한 구조: `type='ops'`·별도 어휘·DB 트리거·후보 제외·소유자 규칙·승계 | D1 | [권장] |
| 서명 kind·승인자 재확인·방·루트 run 바인딩·확인 지문 대조·서버 검증만 | D5 | [권장] |
| 데이터 세 층·최대 한 번·크기 값 | D6 | [권장] |
| 별도 도구 경로·`momo_hostops` 역할·run 대기 방식·notifier 마감 | D9 | [권장] |
| Railway 하드닝 목록·키 보관 게이트 ⑤·절대 단위 CPU 기준·Ops 데몬 별도 바이너리·세 uid | D7·D8·D12 | [권장] |

## 독립 설계 검토 기록
- **r1 (2026-10-25, fresh Sonnet 검토자 1명, 읽기 전용)**: **FAIL (Blocker 0, High 4)**. High — F-11 새 서명 호스트 경로의 서명자·경로·type 핀 부재, F-13 현행 도구 경로가 명령·출력 전문을 채널 메시지로 영속, F-14 `host.*` 실행기가 BYPASSRLS 워커에서 실행, F-15 A2A 자식 run이 사람 입력 없이 박스 명령을 생성. 이 개정이 반영한 곳: F-11 → D6-1·RP-15, F-13·F-14·F-15·F-22 → D9의 별도 경로·D5-4·RP-25·RP-38·RP-40·RP-42, 그리고 Medium·Low 전부(F-01 D8 게이트·실패 때 갈 곳, F-04 D12 별도 바이너리, F-05 비용·CPU 절대 단위, F-07 0125 D8 이탈, F-08 0146·HO-28 선행 조건, F-09 서명 검증 위치, F-10 소유자 규칙, F-12 R2 매 요청 재확인, F-16 헬퍼 `kill_all`·세 uid, F-17 세션 밖 호출 거절, F-18 동시 세션 1·driver, F-19 hardening·키 보관 게이트 ⑤, F-20 claim 테넌트, F-21 경합 규칙, F-24 접두 정리 등). 보고서는 PR 본문 요약에 있다.
- **r2**: (검토 뒤 채운다)
