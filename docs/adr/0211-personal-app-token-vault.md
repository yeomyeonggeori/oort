# ADR-0211: 개인 앱 토큰 금고 — 사람별 OAuth 연결을 서버가 봉인 보관하고, 서버 실행기가 요청자의 연결로만 대신 실행한다

- Status: **Accepted** (owner 2026-11-05 「확정」 — 원문은 「owner 결정」). 보안 경계 변경이라 **독립 보안 검수 Blocker 0·High 0을 받은 뒤 planner가 이 문서와 「미결 질문」의 권장값을 확인한다.** 그 확인 전에는 구현 이슈를 시작하지 않는다(ADR-0100). 이 문서는 설계이고 코드·migration·운영 변수를 바꾸지 않았다.
- Date: 2026-11-05
- Deciders: owner
- 기안: Sonnet 5.5 문서 워커 ([#4238](https://github.com/yeomyeonggeori/oort/issues/4238), 리서치 r3 P1-7)
- 번호 확인 [V, 2026-11-05]: 0211은 #4213·#4238이 예약했다. `origin/main`·`origin/track/engine`·`origin/track/uxui`의 `docs/adr/`에 0211이 없고, 열린 PR 중 `docs/adr/0211`·`0212`를 만드는 것도 없다.
- 검수: 독립 보안 검수 1회차(판정 FAIL — High 3·Medium 10·Low 12, 구조 변경 없음)의 지적을 본문에 인라인으로 반영했다(복호 지점·열 권한 D2·D3·D4, 승인 카드 D7·D8, 수명주기 D9, 슬라이스·수용 기준·미결 질문). 2회차 차이 재검수(High 1, 저장된 엔드포인트의 쓰기 권한과 호출 직전 대조)도 D2·D4·T6·수용 기준 11에 반영했다. 수리 중 새로 단 [V]는 이 브랜치 `90fa6db3e` 기준 확인이고, 벤더 사실과 푸시·웹훅·검색 색인의 입력 범위는 여전히 읽지 못했다(`runtime-unverified`).
- 표기: [V] 이 세션에서 저장소 코드·문서로 직접 확인(track/engine `17bcee4ff`) · [추정] 해석 · [확인 필요: 슬라이스] 닫는 슬라이스를 적는다 · `runtime-unverified` 실행하지 않음. 표·열·환경변수·역할 이름은 **후보**이고 구현 슬라이스가 확정한다. 인용한 로컬 리서치 둘(`claudedocs/resume-2026-09-23/handoff-1021/research-1021/r3-plugins-org-report.md`, `claudedocs/research/2026-11-05-image-integration.md`)은 `claudedocs/`가 gitignore 대상이라 저장소에 없다(ADR-0192와 같은 사정). 벤더 사실은 그 문서가 읽은 날짜 그대로 옮긴 것이고 이 ADR이 다시 열람하지 않았다.

## 번복·증보 (머리)

| 대상 | 성격 | 이 ADR이 하는 일 |
|---|---|---|
| [ADR-0113](0113-connector-credential-plugin-boundary.md) D1 | **부분 번복** | D1-B(서버 보관, 「기각 권고(v1)」)를 **사람별 앱 연결에 한해** 채택한다. D1-A(내 맥 workd·1인 Hermes·벤더 호스팅 에이전트)는 **그대로 공존**한다. 대체가 아니라 증보 2 E1 실행 장소 표에 넷째 줄(「oort 서버 실행기」)이 느는 것이다 |
| ADR-0113 D2 | 증보 | grant 4-튜플은 「동의 기록」 그대로다. 토큰은 별도 표(이 문서 D2). 금고 앱에 한해 「토큰 없이 SoT」가 「허가의 SoT = grant, 자격 = 금고」로 바뀐다 |
| ADR-0113 D5 | **번복** | 「oort 서버 자신의 egress는 현행 유지」가 깨진다. 서버가 벤더 MCP·OAuth 호스트를 직접 부른다(D4·D6) |
| ADR-0113 증보 2 E6 | **번복** | 「서버가 클라이언트 값을 쥐지 않는다」가 깨진다. 서버가 OAuth 클라이언트가 되므로 `client_secret`을 **운영자 급 봉인값**으로 쥔다(D4). 매니페스트·응답에 값을 싣지 않고 값을 나눠 주는 API도 만들지 않는 규칙(`FORBIDDEN_KEY_FRAGMENTS`)은 그대로다 |
| [ADR-0004](0004-codex-oauth-hermes-provider-boundary.md) | 무변경 | 모델 인증 OAuth(Codex·Claude)와 provider 키는 oort가 소유하지 않는다(본문·증보 6·7 그대로). 이 ADR의 토큰은 **앱 토큰**이라는 다른 급이다. 증보 1·4의 봉인 틀(독립 마스터키·재사용 거부)만 빌린다 |
| [ADR-0147](0147-chat-agent-oauth-provider.md) 증보 2026-09-26·10-19, 결정 4 | 무변경·준수 | 금고에 구독 OAuth kind를 더하지 않는다. 이 금고는 provider·구독 kind를 받지 않는다(수용 기준 12). 결정 4(「OAuth 호출·갱신은 전부 agent-worker」)를 따른다: 벤더 discovery·등록·code 교환·갱신·회수는 전부 agent-worker가 하고, 이 기능으로 api에 바깥 HTTP를 **더하지 않는다**(D3·D4). 결정 4의 「momo-server HTTP 0」은 증보 2026-09-27(연결 확인, `momo-provider-probe`)이 이미 좁혔고 이 ADR은 그 범위를 넓히지 않는다 [V] |
| [ADR-0192](0192-remote-host-onboarding.md) D7 Q9 | **번복** | 「서버가 사람 토큰을 쥐는 MCP 카탈로그(A5)는 목표 A 뒤」를 owner 10-21 「개인 연결까지」가 앞당겼다. 행동 명령 #2785가 기다리던 A5의 전제가 이 문서로 채워진다 |
| [ADR-0203](0203-cohosted-agent-detection.md) K1·K2·K6 | 좁힘 | 1인 Hermes 연결 모드는 **owner 본인 시험 전용**으로 남는다(2026-11-05 증보 N1). 팀 경로는 이 ADR이다. 팀 Hermes는 기본 모드(메일·드라이브 연결 없음)를 유지한다 |
| [ADR-0186](0186-agent-workspace-actions.md) D2 · ADR-0113 E4 | 확장·구분 | 쓰기 승인은 `workspace_action` 폐곡선을 타되 **서버가 실행**한다(D8). 「실행 없음·결정 전달」인 `connector_tool`이 아니다. 결정자는 `required_role`이 아니라 **요청자 = 토큰 주인 본인**이다(E4 문장 그대로) |
| [ADR-0205](0205-github-app-integration.md) | 선례 | 봉인·독립 키·「복호 호출 지점 grep 가드」·독립 보안 검수 틀. GitHub App(인스턴스 통합 자격, 사람 토큰 아님)은 표·키가 따로이고 바뀌지 않는다 |
| [ADR-0201](0201-team-ai-fast-path-for-simple-workspace-requests.md) H4·H7·H9, [ADR-0113](0113-connector-credential-plugin-boundary.md) E7 | 무변경 | 도우미는 v1에 연결 도구를 부르지 않는다(미결 Q2). 「요청자」 판정 패턴(H4-2)과 데이터 울타리(H4-4)는 재사용한다 |
| [ADR-0210](0210-host-ops-team-box-shell-curated-install.md) I6 | 무변경 | 박스는 자격 없는 컴퓨터다. 이 금고는 박스에 자격을 부여하지 않는다 |
| ADR-0212 (#4239, 예약) | 소비자 | 외부 에이전트 위임 규칙은 거기서 정한다. 이 ADR은 실행기·요청자 한정만 정하고 「요청자 없는 실행은 못 쓴다」를 못 박는다 |
| [ADR-0214](0214-security-claims-need-tests.md) · [ADR-0219](0219-workspace-guests.md) GUEST-5 | 적용 | 보안 문장은 시험과 함께만 공개한다(수용 기준 16). 앱 연결은 게스트에게 이미 닫힌 장기 자격이다 |

## 맥락

- 지금 사람이 **자기 계정으로** 앱을 쓰는 길은 셋이다: 내 맥(workd), 1인 워크스페이스의 Hermes(K2: 활성 사람이 정확히 1명일 때만), 벤더 호스팅 에이전트(oort가 막지 못함). 웹·iOS만 쓰는 팀원은 쓸 수 없다 [V, `r3-plugins-org-report.md` §6-1].
- owner는 2026-10-21에 앱 토큰 모델을 「개인 연결까지」로 골랐고(이슈 #4238 본문), 2026-11-05에 아래 설계를 설명받고 「확정」했다. 같은 날 팀 공동 Hermes는 **팀 공용 기본 모드**로 정해졌다(#5317, ADR-0203 증보 N1): 도구는 `todo_list`·`web_search`·`image_generate`이고 메일·드라이브 연결은 없다. **개인 드라이브·메일은 이 ADR로 간다.**
- 팀 Hermes에 개인 열쇠를 두면 안 되는 이유는 이미 기록돼 있다: 토큰이 서버별·기계별이고 사람별이 아니며(ADR-0203 K 사실 2), 한 Hermes가 `state.db`·`memories/`를 모든 워크스페이스와 공유한다(#4898이 `session_search`·`memory`를 끈 이유).
- 이 금고는 가장 가치 있는 자격(멤버의 메일·드라이브·일정에 닿는 갱신 토큰)을 서버가 쥐는 일이다. 그래서 이 문서의 무게는 **누가 무엇을 볼 수 있나**(위협 모델)와 **구조로 막는 것과 지시에 기대는 것의 구분**에 있다.

## 비교 참조 (ADR-0100)

| 레퍼런스 | 확인한 사실 (읽은 날) | 이 ADR이 취하는 것 |
|---|---|---|
| Slack | Drive 앱은 설치(워크스페이스)와 연결(멤버)이 나뉘어 「each team member connects their own Google account」. 실시간 검색은 「performs the search on behalf of the authenticated user, ensuring that only content the user has access to is returned」. 봇 토큰 호출은 사람이 보낸 `message`·`app_mention` 이벤트와 함께 오는 `action_token`이 있어야 한다(2026-11-05, `image-integration.md` §6.2) | 요청자 한정 실행(D5): 사람이 보낸 요청 한 번에 묶인 실행만 한다 |
| Notion | 개인 AI는 「acts as you and respects your personal permissions」. 공유 Custom Agent는 「responds using the agent's own access, not the permissions of the person who triggered it」이고 「Agent users can retrieve information from resources they lack access to」라고 스스로 경고한다(2026-11-05) | 공유 에이전트에 한 사람의 열쇠를 두는 모양을 기각(기각 대안 2) |
| Claude · ChatGPT | 「Connect for your team / just for me」, 켜도 접근은 늘지 않고 멤버가 각자 인증한다. 「Even when you allow a write action in Claude, a person still needs the underlying permission in the source system」. ChatGPT는 설치·연결·권한 승인을 나누고 쓰기는 호출마다 확인한다(2026-10-21, **이번에 재확인 안 함**) | 설치 ≠ 연결 ≠ 동의 세 단계(D2·D9), 읽기 자동·쓰기 카드(D8) |

## 결정

### D1. 범위와 불변식

- **금고가 보관하는 것**: 공식 카탈로그 앱 가운데 매니페스트가 금고 연결을 선언한 것에 대한 **멤버 개인의 OAuth 토큰**(갱신·접근), 그리고 그 연결을 맺기 위한 **운영자 급 OAuth 클라이언트 값**(D4).
- **받지 않는 것**: 모델 provider 키·구독 OAuth(ADR-0004·0147), 인스턴스 통합 자격(ADR-0205), 사람용 oort 토큰(ADR-0216 — oort 자신의 자격이다), 팀 단위 연결(서비스 계정·관리자가 한 번 연결, r3 §6-1 (b) — 병행하는 별도 결정).
- **I1 기본 불변식 — 사람 토큰은 oort 밖으로 나가지 않는다.** 에이전트(Hermes·팀 AI·호스팅·외부)·박스·work host·클라이언트(웹·데스크탑·폰)·도우미·로그·응답·감사·메시지·Context Packet·outbox 어디에도 토큰 바이트가 가지 않는다. 에이전트는 「이 요청을 한 사람의 연결로 이 도구를 실행해 달라」고 **요청만** 하고 **결과만** 받는다. 외부 에이전트도 같다: 토큰을 받지 않고 oort에 실행을 요청한다(그 규칙은 ADR-0212가 소비한다).
- **I2** 토큰은 요청자 본인의 요청에서만, 본인의 연결로만 쓰인다(D5). **I3** 서버가 쥐는 동안 멤버 토큰 봉투를 **여는** 곳은 agent-worker 안의 실행기와 회수 worker, 두 모듈뿐이다. 벤더가 방금 준 토큰은 연결 흐름이 봉인하는 순간까지만 메모리에 있다. **api 바이너리는 봉인만 하고 어떤 봉투도 열지 못하며, 이 기능으로 벤더에 바깥 HTTP를 하지 않는다**(D3 복호 지점 표, D4). **I4** 사람은 언제든 끊고, 끊으면 서버는 즉시 쓰지 못한다(D9).
- 설치(관리자) · 연결(멤버 본인) · 동의(grant, 멤버 본인)는 별개 단계다. 설치만으로 접근이 늘지 않는다.

### D2. 데이터 — 표, RLS, 역할

| 표(후보) | 종류 | 내용 |
|---|---|---|
| `app_connection` | tenant, 메타 | workspace·member(사람, 게스트 아님)·plugin, 가린 벤더 계정 표시, 벤더 주체 HMAC 지문, **벤더가 실제로 준 scope**, `client_ref`, 상태(`pending`·`active`·`needs_reconnect`·`revoked`), 시각, 폐기 사유(닫힌 열거). `ws_isolation` RLS ENABLE + FORCE. 활성 연결은 (워크스페이스, 멤버, 앱)당 하나. 같은 벤더 주체를 한 워크스페이스의 두 멤버가 활성으로 쓰는 것은 거절(응답은 중립 문구, Q6). **목록·상태 API는 본인 행과 관리자용 메타(가린 계정 표시)만 돌려준다** — 이 표의 RLS는 워크스페이스뿐이라 같은 워크스페이스 멤버가 읽는 길을 막는 것은 라우트 필터이므로 시험으로 못 박는다(수용 기준 5) |
| `app_connection_secret` | tenant, **봉인** | 봉인된 갱신 토큰(`refresh`), 봉인된 접근 토큰(`access`)과 만료 시각, `key_id`, 봉인 버전, `revoke_deadline`(끊긴 뒤, 또는 계정 확인을 기다리는 동안(D4의 4) 이 행이 살 수 있는 마지막 시각, 평소 NULL). **멤버 토큰 암호문은 이 표에만 있다** — 목록·상태 API가 읽는 표에는 암호문 열이 없다 |
| `app_oauth_client` | 전역, 운영자 | 앱별 client_id, 봉인된 `client_secret`(기밀 클라이언트만 — Google. DCR로 등록한 공개 클라이언트는 비밀이 없고, 등록 응답에 비밀이 오면 같은 방식으로 봉인한다), discovery로 확인하고 호스트 고정을 통과한 엔드포인트 넷(authorization·token·registration·revocation)과 `redirect_uri`·확인 시각(비봉인 열). 운영자 GUC로만 열림(`039 provider_link` 선례) |
| `app_oauth_state` | tenant | 일회용 state 해시, 멤버, 앱, 봉인된 PKCE verifier, 단계(`started`·`code_received`·`exchanged`·`failed`), 완료 호출이 넘긴 code를 **봉인한 일회용 교환 작업**(`auth_code`, 만료 2분)과 리스, 만료(멤버당 시작 횟수 상한). 교환이 끝나거나 만료되면 봉인 열을 비우고 행을 지운다 |
| `app_execution` | tenant | `approval_id` UNIQUE, 연결, 상태(`executing`·`succeeded`·`failed`·`outcome_unknown`), `args_digest`, `execute_by`(집기 기한), `lease_token`·리스 만료, 결과 요약(본문 없음) |

- **RLS가 두 겹으로 묶는다.** 비밀 표의 정책은 `workspace_id = app.workspace_id`와 `member_id = app.vault_member_id`를 **둘 다** 요구한다. 두 GUC는 실행기·회수 worker·연결 흐름이 tx마다 `SET LOCAL`로 건다. `app.vault_member_id`는 서버가 정한 요청자(회수 worker는 연결 주인)이고 모델 인자가 아니다. 실행기 쿼리가 `WHERE member_id`를 빠뜨려도 그 tx에서는 다른 멤버의 행이 0행이다.
- **역할(ADR-0201 H4-2 `momo_helper_read` 선례).** `momo_worker`는 BYPASSRLS라 [V, `bootstrap_roles.sql` 머리 주석] RLS가 소용없고 **표 권한이 곧 경계**다. 그래서 다섯 표에서 `momo_worker`·`momo_relay`·`momo_notifier`·`momo_platform_admin`의 표 권한을 회수하고, 일감을 찾는 데 쓰는 비봉인 열의 SELECT만 `momo_worker`에 남긴다(`momo_notifier`의 `expression_draft` 열 단위 SELECT 선례 [V, `bootstrap_runtime_roles.sql`]). worker의 vault tx(연결 흐름·실행기·회수 worker·벤더 OAuth 모듈)는 `SET LOCAL ROLE momo_vault_exec`(후보: NOLOGIN·NOSUPERUSER·**NOBYPASSRLS**)로 열어 RLS가 두 GUC로 적용되게 한다. `momo_worker`는 이 역할을 `GRANT momo_vault_exec TO momo_worker WITH INHERIT FALSE, SET TRUE`로 **SET만** 할 수 있고 다른 런타임 역할은 멤버가 아니다(`helper-read` 블록과 같은 모양 [V]). 새 BYPASSRLS 역할은 만들지 않는다.

**열 단위 권한표(후보).** 봉인 열은 암호문 열이다: `app_connection_secret`의 갱신·접근 토큰, `app_oauth_client`의 client secret, `app_oauth_state`의 verifier·code. 나머지는 비봉인 열이다. 봉인 열은 어떤 `WHERE`·RLS 정책식·인덱스 식에도 쓰지 않는다. 일감 열은 `workspace_id`·상태/단계·`execute_by`·`revoke_deadline`·`code_expires_at` 같은 시각·상태 열이다(암호문·인자 없음).

| 표 | `momo_app` (api) | `momo_vault_exec` (worker의 vault tx) | `momo_worker` (SET 전) | relay · notifier · platform_admin |
|---|---|---|---|---|
| `app_connection` | SELECT·INSERT·UPDATE | SELECT·UPDATE | 일감 열 SELECT | 없음 |
| `app_connection_secret` | **비봉인 열 SELECT와 `revoke_deadline` UPDATE만.** 봉인 열 접근·INSERT·DELETE 없음 | 전체 SELECT·INSERT·UPDATE·DELETE | 일감 열 SELECT | 없음 |
| `app_oauth_client` | 비봉인 열 SELECT, 등록 요청 열 INSERT·UPDATE. **`client_id`·엔드포인트 넷·`redirect_uri`·확인 시각은 쓰기 권한 없음**. 봉인 열은 **INSERT·UPDATE만**(운영자 입력을 봉인해 쓰기, 읽기·`RETURNING` 없음) | 전체 SELECT·UPDATE. 위 열의 쓰기는 이 역할뿐이다 | 없음 | 없음 |
| `app_oauth_state` | 비봉인 열 SELECT·INSERT·UPDATE. 봉인 열은 **INSERT·UPDATE만**(verifier·code를 봉인해 쓰기) | 전체 SELECT·UPDATE·DELETE | 일감 열 SELECT | 없음 |
| `app_execution` | SELECT·INSERT(결정 tx) | SELECT·UPDATE | 일감 열 SELECT | 없음 |

비밀 행을 **지우는 일은 `momo_vault_exec`(회수 worker)뿐**이다. api가 비밀 행을 지우면 벤더 회수 없이 권한만 고아가 되므로(D9) api의 끊기 tx는 `revoke_deadline`만 표시한다. 열 단위 GRANT의 선례는 `145_scheduled_message.sql`의 `momo_sched_definer`와 `momo_helper_read`이고, `momo_guest_definer`는 ADR-0219가 설계한 같은 모양의 이름이다(migration에 아직 없다) [V]. `UPDATE`·`DELETE`의 `WHERE`와 RLS 정책식이 참조하는 열에 SELECT가 필요한지의 정확한 규칙은 실 PG로 재야 한다(`runtime-unverified`) — 위 표는 그 열이 모두 비봉인 열이라는 설계 제약으로 받는다. [확인 필요: V-1 — 정확한 GRANT 모양, 독립 검수]

**잠금 블록(표 권한이 곧 경계이므로).** 새 표는 기본 권한 때문에 만들어지는 순간 `momo_app`·`momo_relay`·`momo_worker`(compose용 `bootstrap_roles.sql`에서는 `momo_notifier`도)에 SELECT·INSERT·UPDATE·DELETE가 붙고 [V, `bootstrap_runtime_roles.sql` 52–59행·`bootstrap_roles.sql` 44–52행], 운영 부트스트랩은 매 설치·업그레이드 때 마이그레이션 전후 두 번 돌며 `GRANT … ON ALL TABLES`를 다시 한다 [V, 같은 파일 머리 주석]. 그래서 다섯 표 모두를 `self-media-token-lockdown`(ADR-0218 G4) 모양의 잠금 블록 `app-vault-lockdown`(후보) 대상으로 둔다. ① `REVOKE ALL … FROM PUBLIC`. ② 대상 역할마다 `REVOKE ALL` 뒤 위 표의 허용분만 `GRANT` — 봉인 열이 있는 표는 table 단위 SELECT를 **먼저 회수**한 뒤 비봉인 열에만 열 단위 SELECT를 준다(table 단위 SELECT가 남아 있으면 열 단위 권한은 아무것도 막지 못한다). ③ `has_table_privilege`·`has_column_privilege`로 결과가 적은 그대로인지 자기검사하고 어긋나면 예외. ④ 대상 역할은 `momo_app`·`momo_relay`·`momo_worker`·`momo_notifier`·`momo_platform_admin`·`momo_helper_read`·`momo_vault_exec`이고 허용분 밖은 0이다. ⑤ **같은 글자가 마이그레이션·`bootstrap_roles.sql`·`bootstrap_runtime_roles.sql` 세 곳에 있고 시험이 마커 사이 글자를 비교한다**(선례: `self_media_static_guards.rs`·`prod_role_conformance_pg.rs`). 운영은 `bootstrap_runtime_roles.sql`이고 `bootstrap_roles.sql`은 compose e2e용 결정적 SQL이다 [V, 두 파일의 머리 주석] — 시험은 운영과 같은 부트스트랩으로 만든 DB에서 돈다. 셋 중 하나에 블록이 없으면 시험이 실패한다.

- 모든 쓰기는 `with_tenant_tx` + `SET LOCAL app.workspace_id`다. 새 테이블은 RLS 정책 대상이고 `schema_v0.sql`은 건드리지 않는다. migration 번호는 구현 착수 때 planner가 받는다.

### D3. 봉인 · 키 · 회전

- **봉투 v2**: AES-256-GCM, 무작위 96비트 nonce, **AAD = (workspace, member, connection, plugin, `key_id`, 봉인 버전, 열 용도 라벨)**. 암호문을 다른 연결·멤버·워크스페이스의 행으로 옮기면 열리지 않고, 같은 행의 갱신 토큰과 접근 토큰 암호문을 서로 바꿔 끼워도 열리지 않는다(용도 라벨: `refresh`·`access`·`client_secret`·`pkce_verifier`·`auth_code`). 기존 `provider_link` 봉투는 AAD가 없다 [V, `momo-settings/src/crypto.rs`: `seal_bearer`가 AAD 없이 암호화한다] — 사람별 표에는 부족해서 새 봉투를 쓴다. 행별 부분 키는 HKDF-SHA256(마스터, 도메인 `momo.app_vault.v1`, connection id)로 만든다.
- **독립 마스터키**(후보 `APP_VAULT_MASTER_KEY`, ADR-0205 D1과 같은 규율): 없으면 **연결 표면만 503**이고 나머지 서버는 뜬다. **기동 때 품질을 검사한다**: 디코드한 길이가 32바이트 이상(hex 64자·base64 43자 이상)이어야 하고 `is_unsafe_secret`(자리표시·흔한 값)이면 거부한다. 지금 가드는 값이 같은지만 보고 길이·엔트로피는 보지 않으며 `is_unsafe_secret`은 이 키들에 쓰이지 않는다 [V, `config.rs`]. 자체 호스트 스크립트의 기존 생성기 `gen()`은 `openssl rand -hex 24`(24바이트)라서 [V, `scripts/self_host_env.sh`] 이 바닥을 채우지 못한다 — 새 키만 32바이트 생성기(`openssl rand -hex 32`)로 만들고 기존 키는 그대로 둔다(키 수 계약 +1과 관련 시험 갱신은 같은 커밋, ADR-0004 증보 4 D1). `…_PREVIOUS`에도 같은 검사를 하고 새 키와 같으면 거부한다. 재사용 가드는 JWT·OUTBOUND·INGRESS·PROVIDER_LINK·GITHUB_APP 키 중 하나와 같으면 **기동 거부**(`GithubAppSettings::boot_error` 모양 [V, `config.rs`])이고 기존 다섯 키의 가드도 새 키를 막도록 넓힌다(CFG-2 확장). 비교 대상을 기존 다섯 키에서 **프로세스가 쥔 루트 비밀 전부**(`CENT_TOKEN_HMAC`·`CENT_PROXY_SECRET`·`AGENT_GATEWAY_SECRET`·`MOMO_LIVEKIT_API_SECRET` 등 서명·인증 비밀 포함)로 넓히거나, 빼는 비밀은 이유를 표로 남긴다. `oort doctor`는 키 품질·재사용·`_PREVIOUS` 잔존을 항목으로 보여 준다. Hermes·도우미·박스·클라이언트 env에 걸지 않는다(ADR-0203 D6-2, ADR-0210 I6).

**복호 지점 표.** 봉투를 **여는** 함수의 호출 지점은 봉투 종류마다 정해져 있고(grep 가드, ADR-0205 수용 기준 7 모양) api 바이너리는 어느 것도 열지 못한다. api는 봉인해 쓰기만 한다.

| 봉투 (용도 라벨) | 표 | 여는 곳 | api |
|---|---|---|---|
| 멤버 갱신·접근 토큰 (`refresh`·`access`) | `app_connection_secret` | agent-worker의 **실행기**와 **회수 worker** (모듈 둘) | 열기 0 · 쓰기 0 (교환 결과는 worker가 봉인해 넣는다) |
| OAuth 클라이언트 secret (`client_secret`, 기밀 클라이언트만) | `app_oauth_client` | agent-worker의 **벤더 OAuth 모듈** 한 곳 — 교환·갱신·회수 호출을 할 때만 | 운영자 입력을 봉인해 쓰기만 |
| PKCE verifier · 교환 대기 code (`pkce_verifier`·`auth_code`) | `app_oauth_state` | 같은 **벤더 OAuth 모듈** | 봉인해 쓰기만 |

**벤더 OAuth 모듈**은 token 엔드포인트(교환·갱신·회수)와 discovery·DCR 호출을 하는 agent-worker 안의 한 모듈이다. 실행기·회수 worker·연결 흐름은 이 모듈을 불러 쓰고(갱신·회수는 호출자가 연 갱신 토큰을 넘긴다), 모듈이 돌려준 새 토큰은 호출자가 봉인해 커밋한다. 이렇게 모든 벤더 HTTP가 agent-worker에 있고(ADR-0147 결정 4) api에는 토큰 교환용 바깥 HTTP도 클라이언트 secret 복호도 생기지 않는다. 클라이언트 secret 복호 지점은 기밀 클라이언트(Google 등) 경로에만 있다: PKCE만 쓰는 공개 클라이언트(DCR 벤더)는 secret이 없다. 평문은 Debug·Display가 없는 가림 타입에 담고 쓴 뒤 지운다. 로그·trace·에러에 나가지 않는다.

- **회전**: 마스터키는 이전 키를 `…_PREVIOUS`로 두고 **재봉인 명령**(행마다 tx, 옛 키로 열고 새 `key_id`로 봉인)을 돌린 뒤 `oort doctor`가 옛 `key_id` 행 0을 확인하면 이전 키를 지운다. 벤더 주체 지문도 재봉인 때 다시 찍는다(ADR-0147 개인 키 D5와 같다). 벤더가 갱신 토큰을 돌리면 새 값을 **봉인해 커밋한 뒤에만** 접근 토큰을 쓴다. **갱신·교환 커밋·회수 worker의 읽기와 회수는 모두 같은 연결별 advisory lock 아래에서 한다** — 잠금 없이 회수하면 회전 직전의 옛 갱신 토큰으로 회수를 하고 이미 무효인 토큰이 성공 응답을 받아 행이 지워지는 길이 생긴다. 커밋이 실패하면 연결은 `needs_reconnect`다(조용한 실패 없음). **커밋 시점에 연결이 이미 `revoked`이면** 방금 받은 새 토큰은 어디에도 저장하지 않고 즉시 벤더에 회수를 시도(best-effort)한 뒤 폐기한다 — 회전된 옛 갱신 토큰은 이미 무효라서 이 단계가 없으면 새 토큰이 벤더에 아무도 모르게 살아남는다. 공개 클라이언트의 갱신 토큰 회전은 OAuth 2.1 초안이 요구하므로 DCR 벤더에서 흔하다고 본다 [추정, 이번 설계에서 벤더 문서를 열람하지 않았다 — V-2·V-7이 확인]. 키가 **유출**된 경우 재봉인은 의미가 없다 — D9의 전량 회수가 답이다.

### D4. 연결 흐름 (OAuth 클라이언트는 서버다)

1. **클라이언트 등록(운영자, 한 번)**: 운영자가 벤더별 OAuth 클라이언트를 쓰기 전용 화면(ADR-0171 모양)으로 등록하면 api는 입력을 검증해 `client_secret`을 **봉인해 쓰기만** 하고 등록 요청 열에 나머지 입력을 남긴다. `client_id`·엔드포인트·`redirect_uri`·확인 시각을 쓰는 역할은 `momo_vault_exec`뿐이고, worker가 확인한 뒤 정식 열로 옮긴다. **discovery(RFC 9728·8414)·DCR·호스트 고정 검사는 agent-worker의 벤더 OAuth 모듈이 하고**, 확인된 네 엔드포인트를 `app_oauth_client`의 비봉인 열에 저장한다(재발견도 worker의 일이고 실패하면 기존 값을 유지한다). DCR 벤더(Notion·Linear)는 worker가 한 번 등록하고 응답의 비밀을 같은 방식으로 봉인한다. Google은 팀 조직 프로젝트의 **Internal** 동의 화면이다(ADR-0113 증보 2 E2, owner 10-17 결재) — 연결할 수 있는 계정은 그 조직으로 한정된다. 클라이언트를 바꾸면 옛 토큰은 새 클라이언트에서 쓸 수 없으므로(E6 「교체」) 연결이 `client_ref`를 갖고 재연결을 안내한다.
2. **시작(api, 바깥 HTTP 없음)**: 멤버가 「앱」 화면에서 연결한다. api가 인가 요청을 **저장된 엔드포인트로** 만든다(만들기 직전에 5의 대조를 한다) — PKCE S256(verifier는 봉인해 쓰기만 하고 api가 다시 열지 않는다), 일회용 `state`(멤버·워크스페이스·앱에 묶임, 10분, 해시만 저장), 서버 설정에서 오는 고정 `redirect_uri`(요청 헤더로 만들지 않는다 — ADR-0205 D2와 같은 요건), 벤더가 지원하면 `iss` 확인.
3. **완료(접수와 교환을 가른다)**: 벤더가 돌려보내는 주소(`redirect_uri`)는 서버 API 라우트가 아니라 **oort 웹 화면**이다. 그 화면이 `code`·`state`를 **시작한 멤버의 인증된 완료 호출**로 넘긴다 — 호출자는 `state`에 묶인 멤버이고 일회용 `state`를 제시해야 한다(세션이 아니라 멤버: 폰·데스크탑 복귀 경로는 다른 세션일 수 있다). api는 한 tx에서 `state`·멤버·만료·단계(`started`)를 확인하고 단계를 `code_received`로 바꾸고(일회용) code를 **봉인해 교환 작업으로만** 적은 뒤 「교환 중」으로 답한다. 웹 화면의 복귀 자체는 아무것도 저장하지 않고, code의 평문은 어떤 표·로그·감사·응답에도 없다(ADR-0004 증보 7의 일회용 code와 같이 마스킹 타입으로만 다룬다). **교환은 worker**의 연결 흐름이 한다: 작업을 집어 vault tx에서 벤더 OAuth 모듈로 verifier·code(와 기밀 클라이언트면 client secret)를 열어 token 엔드포인트에 한 번 교환하고, 받은 토큰을 봉인해 `app_connection_secret`에 넣고 봉인 열을 비운다. 접수 단계에는 벤더 호출이 없고 화면은 연결 상태가 바뀌기를 기다린다. 주소의 query는 프록시·정적 서버 접근 로그에 남을 수 있으므로(일회용이고 verifier는 봉인돼 서버에만 있어 단독으로는 쓸 수 없다) 그 로그에서 query를 지우는 설정을 둔다 [확인 필요: V-2 — 폰·데스크탑 복귀 경로 포함].
4. **계정 확인**: 교환이 끝난 연결은 `pending`에 머물고, 화면이 **가린 벤더 계정 표시**로 「이 계정으로 연결할까요?」를 한 번 묻는다. 본인이 확인해야 `active`가 되고 그 전에 실행기는 이 연결을 쓰지 않는다. 확인하지 않고 두면 기한(`revoke_deadline`) 뒤 회수 worker가 벤더 회수와 폐기를 한다. 다른 사람의 벤더 계정이 내 oort에 붙는 계정 혼동을 줄인다.
5. **호스트 고정**: discovery 문서가 알려 준 authorization·token·registration·revocation 엔드포인트의 호스트가 매니페스트가 선언한 허용 호스트(`egressDomains`) 안이 아니면 연결을 거절한다 — 침해된 메타데이터가 code·verifier를 다른 곳으로 보내지 못한다. **저장값을 믿지 않는다**: 벤더 OAuth 모듈은 token·registration·revocation 호출 **직전마다** 저장된 주소가 `https`이고 호스트가 `egressDomains`의 정확한 호스트 목록에 있는지 다시 대조한다. 어긋나면 벤더 요청을 보내지 않고 연결을 `needs_reconnect`로 두고 감사에 남긴다. `momo-egress`는 사설 주소·redirect만 막고 호스트 허용목록은 보지 않으므로 이 대조가 유일한 문이다. 이 넷 밖의 discovery 항목(`jwks_uri`·`userinfo` 등)은 쓰지 않는다. 모든 벤더 호출은 `momo-egress` 경유(연결 시점 DNS 고정·redirect 거절·프록시 무시, 사설 주소 거절)다.
6. **scope**: 연결은 읽기 scope부터 요청하고 쓰기 scope는 별도 동의(벤더가 지원하면 증분 동의)다. 벤더가 실제로 준 scope가 요청보다 좁으면 연결은 **교집합만** 쓴다. 한 사람·한 앱당 계정은 하나다(Q6).

### D5. 요청자 한정 — 누구의 요청에 쓰이나

1. **요청자 = 트리거 메시지 작성자**이고 서버가 정한다. 활성 사람 멤버(게스트 아님)만이다(ADR-0201 H4-2 1번, `NoHumanRequester` 선례). 실행 요청 봉투에는 `pluginId`·`tool`·`args`뿐이고 연결을 고르는 필드가 없다(봉투의 모르는 필드는 400). 연결은 요청자에서만 정해진다.
2. **요청자 없는 실행은 연결을 쓰지 못한다**: A2A, 웹훅, 시스템, 예약 전송(Q4), 스레드 깨우기의 비소유자 답글, 에이전트가 먼저 연 일.
3. 다른 멤버가 같은 에이전트를 불러도(팀 에이전트가 열린 뒤의 규칙이다 — v1의 개인 키 에이전트는 소유자만 부른다) **그 멤버의** 연결만 쓴다. 연결이 없으면 에이전트는 닫힌 코드 「연결이 필요해요」로 답하고, 연결 안내는 그 멤버에게만 간다.
4. 에이전트가 다른 에이전트를 불러 생긴 run은 요청자가 아니다(연결 호출 0).
5. 도구를 받는 에이전트는 v1에서 **`owner_only` 개인 키 에이전트**뿐이다. 호출자 = 연결 주인 = 에이전트 소유자이고, 소유자가 아닌 사람은 호출 입구에서 거절된다 [V, ADR-0147 증보 2026-10-03(개인 API 키)의 `owner_only_gate`]. 다만 프로필 지침은 워크스페이스 관리자도 고칠 수 있다 [V, `require_profile_editor_in_tx`]. 그래서 연결 도구를 쓰는 개인 키 에이전트의 지침 변경은 감사하고 소유자에게 알린다. 팀 에이전트(관리자·편집자가 프롬프트·모델·공급자 주소를 정하는 에이전트)에는 열지 않는다. 호출만 하면 내 연결로 읽은 내용이 그 설정에 따라 흘러가기 때문이다 — 열려면 별도 증보와 에이전트별 첫 사용 확인(에이전트 이름·공급자 origin 표시), 공급자 origin·모델이 바뀔 때의 재확인(ADR-0147 `origin_changed_from` 감사 선례)이 필요하다(미결 Q10). 도우미(ADR-0201)는 v1 제외(Q2). 외부 Agent Port 에이전트는 ADR-0212, 박스는 ADR-0210 몫이다. Hermes는 Q1의 조건을 채운 뒤에만 연다.

### D6. 실행기

- 실행기는 agent-worker 안의 **한 모듈**이고 에이전트 런타임(Hermes 등)과 다른 프로세스다. 입력은 run(→ 워크스페이스·요청자·채널), `pluginId`, `tool`, `args`뿐이다. 벤더 회수와 기한 청소(D9)를 하는 회수 worker는 멤버 토큰 봉투를 여는 **별도 모듈**이다(D3 복호 지점 표의 둘). 두 모듈이 token 엔드포인트를 부르는 일(갱신·회수)은 **벤더 OAuth 모듈**을 거친다.
- **호출 직전 한 tx에서 전부 다시 확인한다**(닫는 쪽 실패, 사유마다 닫힌 거절 코드와 감사): 요청자가 활성 사람이고 게스트·정지가 아님 · **호출한 에이전트가 활성이고 그 채널의 멤버이며 허용된 종류(D5의 5)** · 워크스페이스가 활성(정지·삭제 중 아님)이고 설치가 활성 · 요청자의 grant가 그 도구의 scope에 활성 · 연결이 `active`이고 벤더 scope가 도구를 덮음 · 도구가 설치된 매니페스트에 있고 등급이 R·A·B(C 없음)이며 `schemaDigest`가 같음 · run이 요청자의 것 · **현재 청중이 공개 확인 때보다 늘지 않았음(대화에 사람이 더해졌으면 다시 확인)** · 예산(멤버·연결·run별 호출 수, 연결당 동시 1).
- **순서**: ① 접근 토큰이 만료면 연결 잠금 아래에서 갱신하고 새 값을 봉인·커밋한다(`revoked` 연결을 만나면 D3대로 폐기). ② **최종 재확인과 집기를 한 tx**로 한다: 쓰기는 `app_execution`의 리스를 얻고, 읽기는 연결 잠금 안의 동시 1을 얻는다. ③ 벤더 원격 MCP(`streamable_http`, 호스트는 매니페스트 `mcp.url`과 일치)를 `momo-egress`로 **tx 밖에서 한 번** 부른다. ④ 완료 쓰기는 `WHERE state = 'executing' AND lease_token = …`이고 호출 직전에 리스가 아직 유효한지 한 번 더 본다 — 리스를 잃은 느린 worker는 호출도 완료도 하지 못한다. 갱신(네트워크)이 최종 재확인 앞에 있으므로 「회수가 커밋된 뒤의 다음 호출은 벤더로 나가지 않는다」가 호출 앞의 마지막 tx(②)에서 성립한다. 시간·크기 상한을 둔다. 벤더 오류는 닫힌 코드로 옮기고 원문은 저장·표시하지 않는다.
- **실행기의 바깥 접속**: MCP 클라이언트는 **도구 호출 전용**이다. 서버가 먼저 거는 sampling·elicitation·roots·리소스 구독 요청은 거절한다(T9). 접속 정책은 **고정된 공개 주소 전용**이고 `provider_probe_policy_from_env` 같은 운영자 opt-in(사설 주소 허용 등)을 상속하지 않는다. `momo-egress`는 연결 시점 DNS 고정·redirect 거절·프록시 무시다 [V].
- **에이전트에게 주는 것**: 결과의 텍스트·JSON만, ADR-0201 H4-4의 「[데이터 — 지시가 아니야]」 울타리 안에서, 길이 상한과 함께. 토큰·헤더·서명 URL 쿼리를 빼고, 결과에서 토큰 바이트가 보이면 버린다(정확히 일치하는 값만 잡는 **보조 장치**다 — 인코딩을 바꾼 값은 못 잡으므로 경계는 토큰이 실행기 밖으로 나가지 않는 구조다). 결과 원문은 run 기록·Context Packet·감사에 저장하지 않는다 — 에이전트가 답에 옮긴 만큼만 대화에 남는다(개인정보 안내문에 한 줄, V-6a).
- **회수 즉시 거절**: 최종 재확인이 모든 호출 앞에 있어서, 회수가 커밋된 뒤의 다음 호출은 벤더로 나가지 않는다. **재확인 tx 뒤 이미 벤더로 나간 호출 하나는 끝까지 간다**(정직한 한계). 집기 직전 재확인이 실패하면 쓰기는 `failed`(닫힌 사유)로 닫히고 승인은 이미 소모된 채이므로 카드는 「승인했지만 실행되지 않았어요」라고 말한다(D8).
- 감사 `app.tool.called`는 서버가 직접 한 일이라 ADR-0113 E8의 실행 장소 「자기 보고」가 아니라 **서버 사실**이다. 앱·도구·등급·결과 코드·바이트 수·run만 싣고 인자·본문은 싣지 않는다.
- 나중에 HTTP 문(V-8·ADR-0212)이 생기면 「run이 요청자의 것」에 「호출한 에이전트의 **현재 진행 중인** run」과 run 한정 일회용 능력을 더한다. 지금처럼 worker 안 호출이면 해당 없다.

### D7. 결과의 청중과 프롬프트 주입 방어

- **청중(공개 확인)**: 요청자와 에이전트뿐인 **1:1 DM**이면 읽기는 자동이다. 사람이 둘 이상 보는 대화(채널·스레드·그룹 DM)에서는 읽기도 **공개 확인 카드**(D8과 같은 승인 폐곡선, 결정자 = 요청자, 「이 대화 n명에게 보일 수 있어요」, **run당 호출 상한 수치를 함께 보인다** — 한 번의 확인이 그 run의 모든 읽기를 상한 안에서 허용하므로)를 거친 뒤에만 실행한다. 한 run에 한 번이고, 확인 뒤 대화에 사람이 더해지면 호출 직전 재확인(D6)이 현재 청중으로 다시 판단한다. 확인 뒤 모델이 쓰는 말은 **지시에 의존한다**(ADR-0113 E10과 같은 한계, 카드에 그렇게 적는다): 서버는 모델의 답 문장을 강제하지 못한다. 「나만 보기」는 ADR-0186 D5 증보가 필요해 열지 않는다(E10이 보류한 그대로) — 열리면 이 확인은 사라진다.
- **서버가 강제하는 것**: ① 쓰기는 카드(D8) ② 연결 도구를 쓴 run의 답 메시지에는 서버가 표지를 달아 링크 미리보기(unfurl)를 하지 않는다 — 메신저 서버의 fetcher가 데이터 유출 경로가 되지 않게 한다. 원격 이미지 자동 불러오기 금지는 클라이언트 몫인데, 웹은 Caddy의 CSP `img-src 'self' data:`(`infra/railway/Caddyfile.railway`·`infra/rust/Caddyfile`)가, 데스크탑은 `tauri.conf.json`의 같은 CSP가 이미 막는다 [V]. 폰만 [확인 필요: V-3 — 폰 클라이언트의 원격 이미지 처리] ③ run당 연결 호출 상한 ④ **오염 규칙(서버 소유 표지)**: 연결 도구로 읽은 run에는 서버가 표지를 세우고(모델이 정하지 못한다), 표지가 선 run에서는 (a) 외부로 나가는 도구(웹 검색·URL 가져오기·이미지 생성 prompt)를 막고 (b) 민감한 `workspace_action` 제안을 거절하며(`is_sensitive_action` 재사용) (c) 그 뒤 쓰기 제안의 카드에 표지를 붙인다(D8 카드 규칙 5). 도우미 문에는 이미 같은 서버 규칙이 있다 [V, `momo-workspace-actions/src/team_ai.rs`의 `AfterRead`·`momo-agent/src/team_ai_roles.rs`의 `is_sensitive_action`·`agent-worker/src/team_ai/task.rs`] — 이를 실행기 도구를 받는 **모든 에이전트로 일반화**한다. 요청별로 끌 수 없는 도구가 있는 에이전트(기본 모드 Hermes)는 이 규칙을 채울 수 없으므로 Q1대로 닫아 둔다.
- **하류로 새지 않게 하는 표지(서버 소유)**: 연결 도구를 쓴 run의 답 메시지에 서버가 다는 표지는 unfurl 0뿐 아니라 ① 기억 추출·요약에서 제외(ADR-0196의 수집 정책 「연결 도구가 원본인 상태는 저장하지 않는다」와 맞춘다 — 요약 워커는 채널 내용을 먼저 전부 요약 제공자로 보내므로 [V, ADR-0196 D9] 표지가 없으면 읽은 내용이 두 번째 공급자로 간다) ② 푸시 본문 미리보기 가림 ③ 아웃바운드 웹훅·이벤트 구독 제외 ④ 검색 색인 제외 ⑤ 후속 run의 Context Packet 제외를 뜻한다. 사람↔에이전트 DM의 답도 같다(DM은 그 사람의 개인 공간으로만 저장된다는 ADR-0196 D9와 부딪히지 않게 표지를 존중한다). 푸시·웹훅·검색 색인의 입력 범위는 이번 설계 때 코드로 읽지 못했다(`runtime-unverified`). [확인 필요: V-3 — 소비처 목록을 코드로 확인하고 표지를 존중하는지 시험]
- **지시에 기대는 것(강제 아님)**: 모델이 읽은 내용을 채널에 옮기는지, 읽은 글 속 숨은 지시를 따르는지. 이는 위협 모델 T7에 남는 위험으로 적는다.
- **모델 공급자로 가는 내용**: 읽은 메일·문서 내용은 그 에이전트의 모델 공급자(팀 AI 키의 회사, Hermes의 Codex 등)로 간다. 이것은 기능이라 구조로 막지 않는다. 연결 동의 화면과 공개 확인 카드가 **어느 에이전트가 읽고 어느 공급자로 가는지**를 숨기지 않는다(ADR-0218 H9 동의 문장이 회사 이름을 넣는 방식). 표지가 막지 못한 하류가 있으면 그 하류가 보내는 두 번째 공급자(요약 제공자 등)도 같은 문장에서 말한다.

### D8. 쓰기 승인

- 등급은 ADR-0113 E4 그대로다: **R 자동, A·B는 호출마다 카드, C(삭제·공유·병합·푸시·Gmail 보내기)는 매니페스트에 없다.** 「항상 허용」은 v1에 없다.
- 새 행동(후보 `app.tool.call`)은 ADR-0186 D2의 `workspace_action` 폐곡선을 탄다. 다른 점 셋: ① 결정자는 **요청자 = 연결 주인 본인**뿐(관리자·채널 멤버·에이전트 불가 — `requesting_member` 결정자의 선례 [V, `routes/approvals.rs`]) ② 카드는 아래 **카드 규칙**대로 서버가 그린다(모델의 설명문이 아니다) ③ 승인은 아래 **digest 입력 집합**을 묶어 소비하고, 실행 때 하나라도 다르면 거절한다(승인 뒤 인자·연결 바꿔치기 방지).
- **카드 규칙 (카드가 보여 주는 것 = 승인이 소비하는 것 = 실행되는 것).**
  1. 쓰기 도구는 매니페스트에 인자 스키마를 **닫힌 형태**로 선언한다(추가 필드 금지 — 현재 검증기가 루트·중첩 객체 모두 `additionalProperties: false`를 이미 요구한다 [V, `plugin_manifest.rs`의 `validate_input_schema`]). 여기에 **필드마다 표시 규칙**을 더한다: `effect`(결과를 정하는 필드 — 받는 사람·참석자·공유 대상·알림 발송 여부·대상 폴더·첨부: 카드 본문에 항상 보인다), `text`(자유 텍스트 — 본문·설명·파일 내용: 전체를 펼쳐 볼 수 있고 `maxLength`가 필수다), `detail`(그 밖의 값: 접힌 줄에라도 보인다). **표시 규칙이 없는 필드가 하나라도 있는 쓰기 도구는 매니페스트 로드·설치를 거절한다.** 지금 검증기의 속성 키 허용목록에는 표시 규칙과 배열 상한(`maxItems`)이 없다 [V] — 검증기 확장이 V-4 몫이다.
  2. **카드가 담지 못하는 인자는 제안 단계에서 거절한다**: 필드별 상한(`maxLength`·`maxItems`)이나 카드 직렬화 전체 크기 상한을 넘으면 닫힌 코드로 제안이 거절되고 벤더 호출은 0이다. 잘라서 보여 주고 전체를 실행하는 길은 없다.
  3. **한 값**: 서버가 모델 인자를 스키마로 검증·정규화한 정규 값 하나를 만들고, 카드 직렬화 = `args_digest` 입력 = 벤더로 보내는 인자가 이 값이다. 실행기는 모델의 원래 인자가 아니라 저장된 정규 값을 보낸다.
  4. **digest 입력 집합**: (워크스페이스, `pluginId`, `tool`, `schemaDigest`, 정규 인자, `connection_id`, 요청자, run, 채널)과 도메인 태그. 다른 run·채널·연결·스키마로 옮겨 쓸 수 없다.
  5. 연결 도구로 읽은 run에서 나온 쓰기 제안의 카드에는 D7 ④의 서버 표지가 붙는다.
- **「서버 tx 안」의 뜻(이슈 수용기준의 정정)**: 벤더 HTTP를 DB tx 안에서 하면 행 잠금을 네트워크 시간만큼 쥔다(ADR-0205 D4가 수신 tx를 「쓰기만」으로 둔 이유). 그래서 이렇게 정한다. **결정 tx가 승인을 소비하고 `app_execution`을 `executing`으로 만든다 — 둘은 한 tx이고 갈라지지 않는다.** 벤더 호출은 그 뒤 tx 밖에서 **한 번**, 완료 tx가 결과 카드와 `succeeded|failed`를 쓴다. 호출은 `executing` 행을 리스로 집어 가는 worker가 한다 — 결정 HTTP 요청이 중간에 끊겨도 실행이 이어지고, 같은 행을 두 worker가 집지 못한다 [확인 필요: V-4 — 결정 요청 안에서 커밋 직후 부르는 방식과 비교]. 승인 TTL은 결정 시점까지만 한정하므로 승인 뒤 `execute_by`(후보: 10분) 안에 집지 못하면 `failed(expired)`로 닫는다. 집기 직전 재확인이 실패하면 `failed`(닫힌 사유)로 닫히고 승인은 소모된 채이므로 카드는 「승인했지만 실행되지 않았어요」라고 말한다. 완료 쓰기는 `lease_token`이 맞을 때만 되고(D6의 ④) 리스를 잃은 worker의 늦은 완료는 0행이다. 실행 주체는 항상 서버다(클라이언트·호스트가 아니다). 이중 실행은 `approval_id` UNIQUE로 막고, 벤더가 멱등 키를 받으면 approval id를 쓴다. 호출 뒤 완료 전에 프로세스가 죽으면 리스 만료 뒤 `outcome_unknown`으로 두고 **자동 재시도하지 않는다**(카드: 「결과를 확인하지 못했어요 — 직접 확인해 주세요」).
- 결과는 REST send 단일 쓰기 경로(`send_message_in_tx`)로 에이전트 명의 메시지와 `momo.action_result.v1`로 돌아온다. TTL 기본 15분(ADR-0217과 같은 짧은 창)은 기존 승인의 기본 1시간(`DEFAULT_TTL_SECONDS` = 3,600초 [V, `momo-agent/src/approval.rs`])과 다르므로 만들 때 `expires_at`을 명시한다 [확인 필요: V-4]. 거절·만료는 실행 0이다.
- 승인 뒤 run을 이어 갈지는 구현이 정한다 [확인 필요: V-4]. `workspace_action`은 결과 카드로 끝나고(resume job 없음) 기존 worker `tool_call` 승인은 resume 경로(`approval.rs`)로 이어 간다. 쓰기는 어느 쪽이든 되지만, **공개 확인(D7)은 승인 뒤 같은 run이 읽기 결과로 답해야 하므로 resume 쪽**이다.

### D9. 끊기와 수명주기

| 일 | 연결·토큰에 일어나는 일 |
|---|---|
| 멤버가 끊기 | **한 tx**: 연결 `revoked`, 그 앱의 내 grant 회수(동의는 새로 — ADR-0113 증보 2026-10-16(#3914) W3와 같다), 비밀 행에 `revoke_deadline`(짧게, 예 15분) 표식. 이 커밋 뒤 실행기는 이 연결을 쓰지 않는다(D6 재확인). **회수 worker가 같은 연결 잠금(D3) 아래에서** 갱신 토큰을 열어 벤더 회수 호출(RFC 7009 형태)을 하고, **성공하거나 기한이 지나면 행을 지운다**(비밀 행을 지우는 것은 회수 worker뿐이다 — api가 지우면 벤더 권한이 고아가 된다, D2). 실패하면 `revoke_deadline` 안에서 백오프로 다시 시도한다. 결과는 감사 `app.connection.revoked`의 닫힌 필드 `vendor_revoke`(`ok`·`failed`·`expired` 중 하나)로 남기고, 화면은 이를 읽어 「oort는 지웠어요 · 벤더 쪽 확인은 …」로 정직하게 말한다. 암호문이 서버에 남는 시간의 상한은 이 기한이고, 기한을 넘긴 행 수는 `oort doctor`가 센다. 벤더 회수가 실패해도 로컬은 이미 못 쓴다 |
| grant 일부 회수 | 그 scope의 도구만 막힌다. **마지막 grant가 회수되면 연결도 끊는다**(쓸 수 없는 자격을 쥐지 않는다) |
| 관리자 | 누가 어떤 앱을 연결했는지 **메타(가린 계정 표시)만** 본다. 토큰 열람·사용·대신 연결은 못 한다. **강제 해제**는 된다(감사) |
| 앱 설치 해제(관리자) | `uninstall`의 grant 일괄 UPDATE와 **같은 tx**에서 그 앱의 모든 활성 연결을 `revoked` + `revoke_deadline` 표식으로 닫고 회수 worker가 벤더 회수를 한다. 지금 `uninstall`은 grant만 일괄 회수하고 연결에 닿지 않는다 [V, `plugin_writes.rs`]. 재설치해도 되살아나지 않고 새 연결이 필요하다 |
| 카탈로그 철회(레지스트리가 앱을 철회) | 같은 경로. 철회된 앱도 해제할 수 있어야 하므로 `uninstall`은 레지스트리 행을 보지 않는다 [V]. 서버 코드에 레지스트리의 `revoked_at`을 쓰는 경로가 없어 [V: 검색 0건] 철회를 표시하는 쪽(마이그레이션·운영 갱신)이 같은 폐기 함수를 부르거나, 그 전까지 회수 worker의 주기 대조(철회·해제된 앱의 활성 연결을 찾아 폐기)가 닫는다 [확인 필요: V-2] |
| 워크스페이스 정지·삭제·보관 | 지금 Rust에는 이 경로가 없다 [V: 검색 0건]. ADR-0197은 워크스페이스 삭제를 soft + tombstone으로 설계한다. **tombstone·실제 삭제의 선행 조건**: 모든 연결이 `revoked`이고 벤더 회수가 끝났거나 기한이 지났다. 그리고 `app_connection_secret`의 부모 FK(워크스페이스·멤버·연결)는 모두 **`ON DELETE RESTRICT`**다 — 기존 표(`145`·`160`)의 `ON DELETE CASCADE`는 따르지 않는다: 연쇄 삭제는 표 소유자 권한으로 돌아 암호문만 지우고 벤더 쪽 권한을 고아로 만든다. 암호문 행이 남아 있는 동안은 어떤 부모도 삭제되지 않는다 |
| 멤버 탈퇴·제거·정지·만료·게스트로 바뀜 | 같은 tx에서 전부 `revoked`와 기한 표식, 그 멤버의 grant 회수(위 「끊기」와 같은 경로, ADR-0219 GUEST-5·GS-10 만료 tx와 같은 자리). 다시 들어와도 되살아나지 않는다. **연결 폐기 함수는 `revoke_member_tokens_in_tx`(`momo-settings/src/workspace.rs`) 옆에 두고 호출처가 같은 tx에서 부른다** [V, 현재 지점]: 정지 `set_member_status_in_tx`(`membership_lifecycle.rs`, 정지에서만 토큰을 폐기한다)·제거 `remove_workspace_member_in_tx`·자기 탈퇴(`routes/workspaces.rs`의 탈퇴 경로) — 제거와 탈퇴는 `terminate_workspace_membership_in_tx`를 지난다 — 게스트화 `change_workspace_role_in_tx`, 만료는 ADR-0219 GS-10 틱(아직 없다). 수용 기준 14의 시험은 호출처마다 둔다 |
| 세션 종료·로그아웃·비밀번호 | 로그아웃과 한 기기 연결 해제는 **연결과 무관**하다(장기 자격이고 실행은 요청마다 재확인을 거친다). 멤버의 모든 세션을 끝내는 중앙 함수 `end_member_sessions_in_tx`(`session_end.rs`)는 `RevocationCause`를 받고 원인마다 효과를 와일드카드 없는 `match`로 가른다 [V, `ends_pending_reset_links`] — 연결 폐기도 **같은 모양의 원인별 `match`**로 정한다(새 원인은 정할 때까지 컴파일이 멈춘다). 이 함수는 본인 비밀번호 변경에도 불리므로 연결 폐기를 무조건 붙이면 Q5와 모순이다. 정할 값: `Suspended`·`Removed`·`Left`는 폐기, `PasswordChanged`는 **유지**(Q5), `DeviceUnlinked`는 유지, `PasswordReset`(관리자가 발급한 재설정 링크의 사용, ADR-0215)은 폐기가 기본이다. 본인 기기가 서명한 재설정을 가를지와 `RefreshReuse`(세션 탈취 의심)가 연결도 폐기할지는 [확인 필요: V-2] |
| 벤더가 거부(`invalid_grant`·벤더에서 해제) | `needs_reconnect`: 읽기·쓰기 모두 즉시 거절, 본인에게만 「연결이 풀렸어요 · 다시 연결」(앱 화면·인박스), 자동 재시도 루프 없음 |
| OAuth 클라이언트 교체 | 옛 토큰은 새 클라이언트에서 못 쓴다 → 전원 재연결(ADR-0113 E6 「교체」) |
| 마스터키·DB 유출 | **전량 회수 런북**(V-6a): ① 옛 키로 열어 모든 연결의 **벤더 회수 호출을 먼저** ② OAuth 클라이언트 secret 교체 ③ 연결 전량 삭제 ④ 새 마스터키. 키가 새면 재봉인은 답이 아니다 |
| 운영자가 기능을 끔(스위치) | 후보 `APP_VAULT_ENABLED=false`(기본값은 구현이 정한다): 연결 시작·완료·실행은 닫힌 코드로 거절되고 **회수 worker는 계속 돈다**(벤더 회수·기한 청소). 마스터키를 지우면 연결 표면이 503이 되지만 회수도 못 하므로 끄기에는 스위치를 쓴다. 첫 실사용자 토큰이 저장되기 전(V-2 착륙 전)에 스위치와 런북이 있어야 한다(V-6a) |

### D10. 감사 · 로그

- 감사 행은 허용목록 키만 싣는다(토큰·인자·본문·계정 전체 주소 없음): `app.connection.{started,connected,failed,revoked,needs_reconnect,refresh_failed}` · `app.tool.{called,refused}`(닫힌 사유) · `app.write.{proposed,approved,rejected,executed,outcome_unknown}` · `app.vault.{key_rotated,client_registered}`.
- 실행기의 HTTP 클라이언트는 요청·응답 로깅을 끄고, 에러는 닫힌 코드로만 낸다. 새 표는 CRED-1류 평문 스캔(PG, 표식 값)의 대상 표 목록에 넣는다.

### D11. 범위와 순서

- **제품 v1 범위는 Google 셋**(내 드라이브·Gmail·Calendar — owner 「무조건」, ADR-0113 증보 2 결재 2)이다. 쓰기는 E4 등급 안(Gmail 초안·라벨, 내 일정, Drive 파일 만들기)이고 Gmail 보내기는 계속 없다. 그 밖의 앱(GitHub·Jira·Slack…)은 증보로 연다. GitHub은 Q7의 토큰 종류 제한(GitHub App의 user-to-server 토큰만)을 따른다.
- **순서**: 스파이크(DCR 벤더 하나 — Linear 또는 Notion, GCP 준비 없이 닫힌 고리를 증명) → 금고 기초 → 연결 → 실행기 → 승인 → Google. 스파이크는 이 문서의 구현 슬라이스 첫 줄(V-0)이다.
- **Google 형태**: dawn.kim Internal(owner 10-17 결재) — 그 조직 계정만 연결된다. External 전환은 별도 결재이고 그때 7일 만료·100명 상한·CASA가 돌아온다(ADR-0113 E2). Preview 약관 때문에 GA 전에는 배포자 도메인 사용자로 시작한다(E2 「미리보기」 규칙 그대로).
- **갱신 토큰 수명 측정 계획**(Internal이면 7일 조건 밖이라는 E2의 [확인 필요]를 닫는다): dawn.kim 시험 계정으로 연결한 뒤 갱신 성공·실패와 오류 코드를 0시간·접근 토큰 만료 직후·24시간·8일째·30일째에 기록하고, 비밀번호 변경·관리자의 앱 차단·장기 미사용 뒤의 동작을 따로 본다. 벤더 문서가 알려 주는 실패 원인(사용자 해제, 장기 미사용, Gmail scope 계정의 비밀번호 변경, 클라이언트·계정당 토큰 수 한도)은 **이 ADR 작성 때 다시 열람하지 않았다** — V-7이 원문을 확인한다. 결과가 7일이면 「7일마다 다시 연결」이 운영 체크리스트와 `needs_reconnect` 안내에 들어간다. `runtime-unverified`.

## 위협 모델 (누가 무엇을 볼 수 있나)

| 위협 | **구조로 막는 것(강제)** | 지시·운영에 기대는 것 · 남는 위험 |
|---|---|---|
| T1 같은 워크스페이스의 다른 멤버 | 요청자는 서버가 정함(D5), 비밀 표 RLS가 워크스페이스+요청자 둘 다 묶음, AAD(열 용도 라벨 포함), 한 연결 UNIQUE | **토큰·실행은 구조로 막힘.** 데이터 경로는 에이전트 신뢰에 의존한다: 내 요청으로 에이전트가 읽은 내용은 그 에이전트의 프롬프트·모델·공급자 주소를 정한 사람의 설정을 따른다. 그래서 v1은 호출자 = 연결 주인 = 에이전트 소유자인 `owner_only` 개인 키 에이전트로 한정한다(D5). 한 사람이 계정을 둘이 나눠 쓰는 것은 벤더 주체 지문으로 막되 완전하지 않음 |
| T2 워크스페이스 관리자 | 메타만 열람, 강제 해제, 대신 연결·실행·승인 불가 | 토큰·실행·승인은 구조로 막힘. 관리자가 팀 에이전트의 공급자 주소를 바꿔 그 에이전트를 부른 멤버의 데이터를 가져가는 길은 v1이 팀 에이전트에 연결 도구를 열지 않아 닫혀 있고(D5, Q10) 열 때는 에이전트별 첫 사용 확인·origin 변경 재확인을 건다. 관리자가 멤버로 로그인하는 일은 세션 보안(이 ADR 밖) |
| T3 인스턴스 운영자 | — | **막지 못한다.** 운영자는 DB와 마스터키를 함께 쥘 수 있다(LIM-4와 같은 종류). 구현이 별도 한계 문장을 공개 문서에 더한다(V-6b). 키와 DB를 다른 곳에 두기를 권고한다 |
| T4 DB 덤프·백업만 유출 | AES-256-GCM 암호문 + AAD, 마스터키는 DB·백업 밖, **기동 때 키 품질 검사**(32바이트 이상·자리표시 거부, D3) | 키 품질 검사를 통과한 키라는 전제 아래 없음. 키까지 함께 복원한 인스턴스는 T5와 같다 |
| T5 DB 덤프 + 마스터키 | 독립 키(다른 키의 유출로는 안 열림), 전량 회수 런북, 읽기 scope 최소·증분 동의로 반경 축소 | 연결한 모든 사람의 읽기 범위가 열린다(쓰기 scope가 있으면 초안·파일 생성까지) |
| T6 서버 프로세스 침해 | 멤버 토큰 복호 지점 둘(실행기·회수 worker)과 클라이언트 자격·verifier·code 복호 지점 하나(벤더 OAuth 모듈)뿐, 가림 타입·사용 뒤 지움, **api 역할은 어떤 봉인 열도 읽지 못함**(D2 열 단위 권한표), BYPASSRLS 역할은 비밀 표 권한 없음 | 열린 순간의 토큰과 메모리의 마스터키는 막지 못한다. 같은 worker 프로세스 안의 악의적 코드(`RESET ROLE`·GUC 직접 설정)는 역할 경계로 막지 못한다. api가 침해되면 토큰 평문은 얻지 못해도 승인·상태 행은 위조할 수 있다 |
| T7 에이전트 프롬프트 주입(메일·문서 속 지시) | 쓰기=카드(서버가 정규 인자로 그리고 같은 값의 digest로 소비 — 표시 규칙 없는 필드는 매니페스트 거절, 상한 초과는 제안 거절, D8), C 등급 없음, run당 호출 상한, 공개 확인, unfurl 0, **읽은 뒤 외부 도구 차단·민감 제안 거절(D7 ④)** | **읽기 연쇄와 모델이 쓰는 말은 지시 의존**(채널에 옮기기·요약). 기본 모드 Hermes는 `web_search`·`image_generate`가 같은 문맥에 있다(ADR-0203 I2의 「남는 위험은 그림 prompt」) — oort가 요청별로 끌 수 없으면 Q1 때문에 닫아 둔다 |
| T8 에이전트가 열쇠를 봄 | 평문이 실행기 밖으로 안 나감, 결과만 울타리 안으로, 결과 속 토큰 바이트 폐기 | 벤더 내용 속 비밀(메일 본문의 비밀번호 등)은 데이터이고 막지 못한다 |
| T9 악성·침해된 벤더 메타데이터·MCP 응답 | 호스트 고정(D4), `schemaDigest` 불일치 도구 거절, 결과는 데이터 울타리 | 벤더 자체의 침해는 막지 못한다 |
| T10 동의 피싱(남을 속여 내 oort 연결로 그 사람 계정을 승인시킴) | 완료는 **시작한 멤버만**(`state`에 묶인 멤버·일회용 값, 세션이 아니다, D4), 완료 직후 가린 계정 표시 확인(D4의 4), 같은 벤더 주체는 한 멤버만, Internal 앱은 조직 계정만 | **막지 못한다** — 관리자 목록의 가린 계정 표시로 탐지하고 강제 해제한다. 계정 확인 단계는 혼동을 줄일 뿐 속은 사람의 확인까지 막지는 못한다 |
| T11 계정 탈취·멤버 퇴장 | D9 표(같은 tx 폐기). 탈취 의심 이벤트(갱신 토큰 재사용 감지 등)가 연결도 폐기할지는 V-2가 정한다(D9) | 탈취된 계정이 로그인해 있는 동안은 그 멤버 권한으로 읽기가 된다. 쓰기 승인도 같은 사람이 할 수 있다 |
| T12 승인 뒤 바꿔치기 | `args_digest`·`connection_id` 묶음, 소비 1회 | 없음 |
| T13 벤더 호출 남용 | 멤버·연결·run 예산, 연결당 동시 1 | 자기 연결의 벤더 쿼터 소진은 가능 |
| T14 읽은 내용이 모델 공급자로 감 | — (그것이 기능이다) | **구조로 막지 못한다.** 동의 화면·카드가 어느 에이전트·어느 공급자인지 보이고(D7) — 표지가 막지 못한 하류가 있으면 그 하류가 보내는 두 번째 공급자(요약 제공자 등)도 같은 문장에서 말한다 — 공급자의 보관·학습 약관은 운영자 선택이다. 결과 원문은 oort의 run 기록·감사에 남기지 않는다. 단 **Hermes는 자기 볼륨의 대화 기록(`sessions/`, 모든 워크스페이스가 한 볼륨)에 읽은 내용을 남길 수 있다**(ADR-0203 K3) — oort의 RLS·백업·삭제 밖이라 Q1이 Hermes 경로를 닫아 둔다 |

## 기각한 대안

1. **소유자 전용 연결 Hermes를 팀으로 넓힘**(ADR-0203 K1~K3): 토큰이 Hermes 볼륨(oort DB·RLS·백업 밖)에 있어 회수·감사가 oort 밖이고, K2가 사람 1명 워크스페이스만 허용하며, 풀면 공유 채널에서 오너 메일함이 남의 요청에 쓰인다(Notion이 경고하는 바로 그 모양). 웹·iOS만 쓰는 팀원은 못 쓴다. → **owner 본인 시험으로만 둔다**(ADR-0203 그대로).
2. **팀 Hermes에 개인 열쇠**(사람별 `profile` 포함): 토큰이 서버별·기계별이고 `state.db`·`memories/`가 런 사이에 공유되며 토큰이 운영자 영역이라 I1을 깬다. 게이트도 `profiles/` 항목을 거절한다(ADR-0203). → 기각.
3. **요청자 토큰을 요청 한 번에만 에이전트에게 빌려 줌**: I1 위반. 이 ADR의 실행기가 그것의 안전한 형태다(토큰은 안 가고 결과만 간다).
4. **클라이언트(맥·폰)가 토큰을 보관하고 서버가 대신 요청**: 웹·iOS만 쓰는 사람이 목표라 맞지 않는다. D1-A 경로(내 맥)는 그대로 남는다.
5. **팀 단위 연결만**(r3 §6-1 (b)): 팀 자료에는 더 싸고 안전하지만 개인 Gmail·Calendar가 안 된다. **대체가 아니라 병행**이다(별도 결정).
6. **멤버별 패스프레이즈로 사용자 키 파생**: 요청마다 사람이 암호를 넣어야 해서 에이전트 UX가 성립하지 않는다. 대신 운영자 신뢰 한계를 정직하게 적는다(T3).
7. **클라우드 KMS 봉투 암호화**: 셀프호스트·Railway 이식성 때문에 v1은 앱 수준 독립 키다. 운영자가 고르는 후속 선택지로 남긴다(Q8).

## 귀결

- (+) 웹·iOS만 쓰는 팀원도 자기 드라이브·메일·일정을 에이전트에게 맡길 수 있다. 팀 Hermes는 기본 모드(개인 도구 없음)를 유지한다.
- (+) 토큰이 oort 한 곳에서 회수·감사된다. 사용 기록은 실행 장소의 자기 보고가 아니라 서버 사실이다.
- (−) **서버가 고가치 금고가 된다.** 마스터키와 DB가 함께 새면 연결한 모든 사람의 읽기 범위가 열린다(T5). 운영자는 열 수 있다(T3).
- (−) 서버 egress가 벤더 호스트로 넓어지고 연결에 공개 HTTPS가 필요하다.
- (−) 구현이 크고(L 여럿) 보안 검수 라운드가 길어질 수 있다(팀 기억 v2에서 약 15라운드, r3 §7).
- (−) Google은 Preview·Internal 한계 안이다(dawn.kim 조직 계정만).
- (−) 구현이 착륙하면 `docs/security/README.ko.md`의 공개 문장 **네 곳**이 거짓이 된다: Google 앱 단락의 「서버에는 이 앱들의 매니페스트·설치·grant 기록만 있고」와 「사용자 OAuth 토큰과 클라이언트 값은 도구를 실행하는 호스트(…)에만 둔다」, 한계 절의 「Drive 도구 호출(`tools/call`) 경로는 Rust 서버로 옮기지 않았다 … 서버가 Drive 도구를 대신 실행하지는 않는다」와 「oort 서버는 이를 대신 실행하거나 토큰을 보관하지 않는다」. **첫 토큰을 저장하는 슬라이스(V-2)가 착륙하기 전에, 늦어도 같은 PR에서 고친다**(수용 기준 16, V-6a). 같은 단락의 「플러그인 레지스트리는 …자격증명을 담지 않는다」는 표가 분리돼 계속 참이다. 이 ADR만 머지돼서는 네 문장이 아직 참이다.

## 불변식 대조

- REST send → channel_seq + message + outbox 단일 tx → relay → Centrifugo: 유지(결과·카드는 `send_message_in_tx`). 클라이언트 직접 publish 없음.
- 에이전트는 `member.kind='agent'`인 1급 멤버, 모든 테넌트 경로는 `workspace_id` + RLS FORCE + tx마다 `SET LOCAL app.workspace_id`: 유지. 쓰기 경로 BYPASSRLS 금지: 새 BYPASSRLS 역할 0, 다섯 표의 암호문 열과 쓰기 권한은 BYPASSRLS 역할에 주지 않는다(일감을 찾는 비봉인 열의 SELECT만 `momo_worker`에 남는다, D2).
- `schema_v0.sql` 무변경, 신규 migration으로만 확장, Rust는 런타임 sqlx 쿼리.
- 시크릿·사용자 데이터 커밋 금지: 이 문서의 값은 전부 자리표시이고 실제 값이 없다.
- 새 의존이 필요하면(키 지움 등) permissive 라이선스와 NOTICE 귀속을 같은 PR에 넣는다.
- ADR-0004 본문 불변식(모델 인증 토큰 비유입) 유지. ADR-0100: 보안 경계 변경이라 이 ADR이 구현 머지 조건이다.

## 구현 슬라이스 (한 슬라이스 = 한 이슈·브랜치·PR, base `track/engine`)

| ID | 트랙·크기 | 내용 | 선행 |
|---|---|---|---|
| **V-0 스파이크** | 엔진 L | DCR 벤더 하나(Linear 또는 Notion)로: 서버가 클라이언트 등록 → 연결 → 봉인 → 도구 1건 왕복(모의 벤더 + 실 벤더 1회, 합성 계정). 마커 시험, 회수 즉시 거절, 쓰기 1건의 소비·실행 분리 실측, Hermes 경유 왕복 가능성 실측(Q1). 이슈 #4238의 스파이크 수용기준이 여기로 온다. **머지하지 않는 폐기 브랜치다**: 합성 계정과 모의 벤더만 쓰고 기능 스위치는 기본 꺼짐이며, 표·역할·봉투의 임시 구현은 V-1이 검수 뒤 처음부터 다시 만든다(스파이크가 검수 없이 DB 계약이 되지 않게). 결과는 보고로만 남긴다 | 이 ADR 검수 |
| V-1 금고 기초 | 엔진 L | 다섯 표·RLS·열 단위 권한·**잠금 블록 세 곳(마이그레이션·`bootstrap_roles.sql`·`bootstrap_runtime_roles.sql`)과 글자 비교 시험**·`momo_vault_exec` 멤버십·자기검사(D2), 봉투 v2(열 용도 라벨), 독립 키·키 품질 검사·재사용 가드(루트 비밀 전부)·키 수 계약, 재봉인 명령, 평문 마커 시험, 테넌트 카탈로그 시험(주장 TEN-1~3)의 비테넌트 예외 목록에 `app_oauth_client` 추가. 독립 보안 검수 | V-0 |
| V-2 연결 | 엔진 L | 클라이언트 등록(운영자 화면 API는 봉인해 쓰기만), **벤더 OAuth 모듈**(discovery·DCR·호스트 고정·교환·갱신·회수), 시작(저장된 엔드포인트, 바깥 HTTP 0)·웹 화면 복귀·인증된 완료(봉인한 교환 작업)·worker 교환·계정 확인(D4), 상태기계, 끊기와 `revoke_deadline`, 멤버 이벤트·설치 해제 폐기(D9의 호출처마다, 원인별 `match`), 회수 worker(같은 연결 잠금)·기한 청소·주기 대조, 갱신·교환 커밋의 `revoked` 처리(D3) | V-1, V-6a |
| V-3 실행기 | 엔진 L | 실행기 모듈(재확인·갱신·egress·MCP 클라이언트(도구 호출 전용)·울타리·예산·감사), 요청자 유도, 도구 노출, 오염 규칙·하류 표지·unfurl 0 표지(D7). **개인 키 에이전트의 1:1 DM 읽기만 허용하고 그 밖의 청중은 서버가 거절한다**(공개 확인 카드는 V-4). **R 등급만 실행하고 A·B는 `approval_required`로 거절한다(쓰기 0)** | V-1·V-2 |
| V-4 승인 | 엔진 M | `app.tool.call`, **공개 확인 카드**, 소비·`executing` 한 tx, 완료 tx(리스 펜싱), `execute_by`, `outcome_unknown` 청소, 카드(표시 규칙·상한·정규 값)와 매니페스트 검증기 확장(D8) | V-3 |
| V-5 화면 | UXUI M | 앱 화면의 연결·끊기·다시 연결, 동의 문구(모델 공급자 전송·운영자 열람 한계·끊기를 숨기지 않음), 쓰기·공개 확인 카드, 연결 안내(웹·데스크탑·폰). 캡처·design-review Blocker 0·High 0 | V-2·V-4 |
| V-6a 선행 안전장치 (V-2 착륙 **전**, 첫 실사용자 토큰이 저장되기 전) | 엔진+docs S | `docs/security/README.ko.md`의 거짓이 될 네 문장 수정(`SECURITY.md`는 같은 뜻의 문장이 있는지 함께 확인), 개인정보 안내문 한 줄, 전량 회수 런북, 기능 끄기 스위치, `oort doctor` 항목 | V-1 |
| V-6b 주장·나머지 | 엔진+docs M | `claims.yaml` 주장(`VAULT-*`)과 운영자 열람 한계 문장, SELF_HOST 회전 런북, 이 PR이 달지 않은 역방향 줄(ADR-0203 K1·K2·K6 — 같은 날 #5336이 고친 파일이라 충돌을 피해 미룬다 —, ADR-0186·0201·0004, ADR-0147 결정 4, ADR-0194 D7과 ADR-0162의 「서버는 GitHub 토큰을 쥐지 않는다」, ADR-0220의 「oort 금고는 구독 토큰을 보관하지 않는다」 — 「금고」라는 말이 이 문서와 겹친다) | V-2 |
| V-7 Google | 엔진 M | Google 세 앱 매니페스트의 금고 선언, Internal 클라이언트 등록(G-S0 연계), scope 매핑 실측, 갱신 토큰 수명 측정 | V-3·V-4 |
| V-8 Hermes 경로 | 엔진 M | 요청별 외부 전송 도구 차단 가능 여부와 도구 왕복 방식 확정, 게이트(ADR-0203 증보) 변경 | V-3, Q1 |

각 슬라이스는 독립 보안 검수 Blocker 0·High 0을 받아야 머지한다.

## 수용 기준 (red proof — 해당 분기를 지우면 실패해야 한다)

1. **평문 0**: 표식 토큰으로 연결 → 실행 → 갱신 → 끊기를 돌리면 표식 바이트가 로그(TRACE)·모든 표의 평문 열·HTTP 응답·감사 행·메시지·outbox·Context Packet·에이전트 입력에 0이다. client secret·PKCE verifier·code에 심은 표식도 같다. 비밀 표에는 봉투만 있다. 봉인을 지우고 평문을 저장하면 실패한다.
2. **독립 키**: `APP_VAULT_MASTER_KEY`가 JWT·OUTBOUND·INGRESS·PROVIDER_LINK·GITHUB_APP 키 중 어느 것과 같아도 기동을 거부한다(각각). 없으면 연결 표면만 503이다. 기존 다섯 가드도 새 키를 막는다. **32바이트 미만이거나 자리표시 값이면 기동을 거부하고(`…_PREVIOUS`도 같다) 새 키와 같은 `…_PREVIOUS`도 거부한다. 재사용 가드의 비교 대상에 루트 비밀 전부가 들어 있다.** 가드 하나를 지우면 실패한다.
3. **AAD**: 한 연결의 암호문을 다른 연결·멤버·워크스페이스 행으로 옮기면 열리지 않고, 같은 행의 갱신 토큰과 접근 토큰 암호문을 서로 바꿔 끼워도 열리지 않는다(열 용도 라벨). AAD나 라벨을 빼면 실패한다.
4. **복호 지점**: 멤버 토큰 봉투의 복호 함수 호출 지점이 실행기·회수 worker 모듈 둘뿐이고, client secret·verifier·code 봉투의 복호 지점은 벤더 OAuth 모듈 하나이며, api 바이너리에는 셋 모두 0이다(grep 가드, 호출을 하나 더하면 실패). api 바이너리에는 이 기능의 벤더 바깥 HTTP도 0이다(링크 의존·호출 점검). **벤더 OAuth 모듈에서 클라이언트 자격 복호를 지우면 기밀 클라이언트의 교환·갱신·회수 시험이 실패한다.**
5. **RLS·역할**(비우회 역할·두 테넌트 실 PG, **운영과 같은 부트스트랩으로 만든 DB**): `momo_app`·`momo_worker`·`momo_relay`·`momo_notifier`·`momo_platform_admin`이 세 봉인 표의 봉인 열을 읽지 못한다(D2 권한표의 칸마다 `has_column_privilege`로 재고, 칸 하나를 바꾸면 실패한다). `SET LOCAL ROLE momo_vault_exec` 없는 `momo_worker` 접근 거절, 다른 워크스페이스·다른 멤버 id를 걸면 0행. 새 BYPASSRLS 역할이 없음을 자기검사가 잰다. 잠금 블록 세 곳의 글자 비교 시험이 있고, 부트스트랩을 두 번 돌린(업그레이드) 뒤에도 권한이 같다. `app_connection` 목록·상태 API는 본인 행과 관리자 메타(가린 계정 표시)만 돌려준다(다른 멤버의 요청에는 그 밖의 행이 0건).
6. **요청자**: 다른 멤버·관리자·A2A·웹훅·시스템·예약·에이전트가 연 일에서 연결 호출이 0이다(모의 벤더의 수신 요청 계수). 인자에 멤버 필드를 넣으면 400이다. **`owner_only` 개인 키 에이전트가 아닌 에이전트(팀 에이전트·다른 사람의 에이전트)가 부르면 연결 호출이 0이다.**
7. **재확인과 즉시 거절**: grant 회수·연결 끊기·멤버 정지·탈퇴·게스트화·설치 해제·**에이전트 정지·채널 이탈·워크스페이스 정지** 뒤 다음 호출은 벤더 요청 0과 닫힌 코드다(사례마다). 재확인 항목 하나를 지우면 그 사례가 실패한다.
8. **쓰기 승인**: 승인 전 벤더 호출 0, 결정자가 요청자가 아니면 403이고 소비 0, 승인 뒤 인자·연결·run·채널·스키마를 바꾸면 실행 0, 같은 승인 두 번에 벤더 호출 1(UNIQUE), 거절·만료는 0이다. **표시 규칙에서 필드 하나를 빼면 매니페스트 검증이 실패하고, 카드 상한을 넘는 인자는 제안이 거절되어 벤더 호출이 0이며, 카드가 그린 값의 필드 경로 집합이 벤더 모의 서버가 받은 인자의 필드 경로 집합과 같다(카드 직렬화 = digest 입력 = 실행 입력).**
9. **소비·기록의 원자성**: 결정 tx에서 승인 소비와 `executing` 행이 함께 커밋되거나 함께 롤백된다(중간 실패 주입). 호출 뒤 완료 전 프로세스 종료는 `outcome_unknown`이고 재시도 0이다. **승인 뒤 `execute_by`가 지나면 `failed(expired)`로 닫히고 벤더 호출이 0이다. 리스를 잃은 worker의 완료 쓰기는 0행이고, 집기 직전 재확인이 실패하면 쓰기는 `failed`(닫힌 사유)로 닫히며 벤더 호출이 0이다. 갱신이 재확인 앞에 있어 회수 뒤에는 호출이 나가지 않는다.**
10. **청중**: 1:1 DM이 아닌 대화에서 공개 확인 전 읽기 0, 확인 뒤 run당 읽기 허용(상한 수치가 카드에 있다). 연결 도구를 쓴 run의 답에 unfurl이 0이다. **DM 답에 심은 표식이 다른 멤버의 기억·검색·요약·푸시 본문·웹훅·후속 Context Packet 어디에도 0이다. 오염 표지가 선 run에서 웹 검색·이미지 생성·민감 `workspace_action` 제안은 거절된다.**
11. **호스트 고정**: discovery가 허용 밖 호스트를 가리키면 연결을 거절하고, 모든 벤더 호출이 `momo-egress`를 지난다(사설 주소·redirect 거절). 네 엔드포인트 밖의 discovery 항목(`jwks_uri`·`userinfo` 등)은 호출하지 않는다. 저장된 엔드포인트를 허용 밖 호스트로 바꾸면 벤더 요청은 0이고, 호출 직전 대조를 지우면 이 시험이 실패한다. `momo_app`은 엔드포인트 열·`client_id`를 쓰지 못한다(`has_column_privilege`).
12. **provider kind 불가**: 금고 연결을 선언하지 않은 매니페스트(provider·구독 OAuth 포함)로는 연결이 생기지 않는다(CHECK + 라우트).
13. **게스트·에이전트 멤버**: 게스트와 `kind='agent'`는 연결을 만들 수 없다(403, 트리거). ADR-0219 GUEST-5의 분류 행에 더한다.
14. **끊기와 수명주기**: 끊기 tx 안에서 연결 `revoked`, grant 회수, `revoke_deadline` 표식이 함께 일어나고 그 뒤 실행기 호출은 벤더 요청 0이다. 벤더 회수 호출이 실패해도 로컬은 거절하고, 기한이 지나면 비밀 행이 0이다(지우는 것은 회수 worker뿐이고 api 역할은 비밀 행을 지울 수 없다). **앱 설치 해제는 같은 tx에서 그 앱의 활성 연결을 `revoked`로 닫고, 비밀 행은 회수 성공 또는 기한 뒤 0이며 벤더 회수 호출이 1이다. 워크스페이스 삭제 시도는 비밀 행이 남아 있는 동안 FK로 거부된다(`ON DELETE RESTRICT`) — 시험 정리는 연결 행을 먼저 지운다.** 멤버 이벤트(탈퇴·정지·제거·게스트화·만료)는 **호출처마다** 같은 시험을 둔다(D9의 호출처 목록, 원인별 `match`는 새 원인이 늘면 컴파일이 멈춘다). **갱신 커밋이 `revoked` 연결을 만나면 새로 받은 토큰을 저장하지 않고 즉시 회수를 시도하며, 회수 worker는 같은 연결 잠금 아래에서 읽고 회수한다(경쟁 주입 시험). 감사 `app.connection.revoked`에 `vendor_revoke`가 닫힌 값으로 남는다.**
15. **회전**: 이전 키로 봉인한 행이 재봉인 뒤 새 키로 열리고, 이전 키를 지운 뒤 옛 `key_id` 행은 `needs_reconnect`로 닫힌다. `oort doctor`가 옛 행 수를 센다.
16. **ADR-0214**: 1·2·6·7·8을 `claims.yaml` 주장(`VAULT-*`)으로 시험과 함께 더하고, 경계 자체를 지키는 1·5·6은 P0로 저장소 안 사보타주 음성 대조를 둔다. 공개 문서의 위 **네 문장**(귀결 마지막 줄)을 V-2 착륙 전에(V-6a, 늦어도 같은 PR에서) 고친다. 지금은 주장 파일에 더하지 않는다(시험 없는 선택자는 린트 E2가 빨강으로 본다).

## owner 결정 (인용)

- **2026-10-21** (이슈 #4238 본문의 인용, AskUserQuestion): 앱 토큰 = **「개인 연결까지」** — r3 §6-1 (c) 「사람별 OAuth 토큰 금고 + 서버 실행기 + 승인 카드 서버 실행」. ADR-0113 D1-A·ADR-0192 D7 「A5는 목표 A 뒤」를 번복한다.
- **2026-11-05** (planner 전달): 설계 — 사람마다 자기 구글 계정을 한 번 연결 → 서버가 잠가 보관 → 그 사람의 요청에만 서버가 대신 실행, 에이전트는 열쇠를 보지 못함, 쓰기는 승인 카드, 언제든 끊기 — 를 설명받고 **「확정」**이라고 답했다. 설명 문장은 planner 요약이고 원문이 아니다.
- **같은 날**: 팀 공동 Hermes는 팀 공용 기본 모드이고(#5317), 개인 드라이브·메일은 이 ADR로 간다.
- 위임된 세부: 이 문서의 표 이름·열·역할·변수 이름·「미결 질문」의 권장값은 확정이 아니라 **planner가 보안 검수 뒤 확인하는 초안**이다.

## 미결 질문 (권장 표시 — planner가 검수 뒤 닫는다)

1. **Hermes 경로의 개방 조건.** 팀 Hermes는 기본 모드라 `web_search`·`image_generate`가 같은 문맥에 있고, 읽은 내용이 Hermes 볼륨의 대화 기록에 남을 수 있다(T14). oort가 요청별로 도구를 끄고 기록을 남기지 않게 할 수 있는지는 V-0·V-8이 잰다. **권장: 둘 다 증명되기 전까지 Hermes 경로는 닫는다**(연결 화면에 「이 에이전트는 아직 개인 연결을 쓸 수 없어요」). 도구를 worker가 실행하고 결과가 oort 밖 저장소에 남지 않는 **`owner_only` 개인 키 에이전트**가 먼저 연다(D5). 팀 에이전트는 Q10.
2. **도우미(팀 AI 빠른 길)에 연결 도구를 열까.** 반경이 커진다. **권장: v1 제외**(ADR-0201 H4·H9 그대로).
3. **공개 확인 카드 대신 「DM에서 물어봐 주세요」로 거절할까.** 거절이 더 단순하지만 일정 한 줄도 DM으로 보내야 한다. **권장: 카드(run당 한 번)**. 「나만 보기」가 생기면 카드를 없앤다.
4. **예약 전송 메시지가 연결을 써도 되나.** 사람이 그 순간 화면에 없다. **권장: 제외**, 풀려면 증보.
5. **본인 비밀번호 변경이 연결을 끊나.** **권장: 끊지 않는다.** 관리자 발급 재설정·강제 세션 종료만 끊는다(D9).
6. **사람·앱당 계정 수.** **권장: 하나**, 같은 벤더 주체를 두 멤버가 쓰는 것은 거절(D2). 거절 응답은 「이미 다른 멤버가 연결했다」는 정보를 드러내지 않는 일반 문구(「이 계정은 연결할 수 없어요」)다 — 다른 사람의 계정 사용 여부를 묻는 오라클이 되지 않게.
7. **스파이크 벤더를 정식 앱으로 올리는 순서**(Linear·Notion·GitHub·Jira·Slack). **권장: 스파이크 벤더 → GitHub**, Google이 먼저 필요하면 G-S0가 앞선다. **GitHub은 GitHub App의 user-to-server 토큰(세분화 권한·만료)으로만 연결하고, 고전 OAuth App의 `repo` scope는 금지한다** — 읽기 전용 변형이 없고 비공개 저장소 전체에 닿는다 [일반 지식, 벤더 문서 이번에 미열람 — 그 증보가 원문을 확인한다]. 설치 단위 GitHub App(ADR-0205)과 자격이 이중이 되지 않도록 두 토큰의 역할 분담은 그 증보가 정한다.
8. **KMS 봉투 암호화를 운영자 선택지로 둘까.** **권장: 후속 증보**(이식성).
9. **연결 모드 Hermes(owner 본인 시험)와 금고에 같은 앱을 이중 연결해도 되나.** 토큰이 서로 독립이다. **권장: 허용**, 같은 OAuth 클라이언트의 토큰 수 한도는 V-7이 확인한다.
10. **팀 에이전트에 연결 도구를 열 조건.** 관리자·편집자가 프롬프트·모델·공급자 주소를 정하는 에이전트는 연결 주인과 신뢰 주체가 다르다(T1·T2). **권장: v1 제외**, 열려면 별도 증보와 ① 에이전트별 첫 사용 확인(에이전트 이름·공급자 origin 표시) ② 공급자 origin·모델이 바뀔 때의 재확인(ADR-0147의 `origin_changed_from` 감사 선례) ③ D7의 오염 규칙과 하류 표지가 모든 하류에서 증명될 것이 필요하다.
