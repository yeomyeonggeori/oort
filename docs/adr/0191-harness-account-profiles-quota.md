# ADR-0191: 하네스 계정 프로필과 쿼터 — 자기 계정 사이 전환, 새 칸으로 이어서, 서버엔 라벨과 숫자만

- Status: **Accepted** (2026-09-26 성재 결재. 근거는 아래 인용)
- Date: 2026-09-26
- Deciders: 성재
- 결재 인용: 작업 공간 2.0 제안서 §4 Q1~Q11에 성재가 「전부 권장대로 가자」고 답했다. 이 ADR은 Q5를 적는다.
- 기안: Opus 5.5 worker(#2754)
- 근거 자료: 제안서 `claudedocs/agent-workspace-2.0/brief.md` §2.3(계정 스왑 관행과 약관), §3.5(계정 스왑). gitignore 대상이라 로컬에만 있다.
- 증보: ADR-0188 §8.1(D1이 조건 1·8을 완화한다. 0188 §8.5에 역방향 줄), ADR-0135(같은 날 한 줄 증보). 0135의 개념(순서 있는 체인, 한도류만 넘김, 전환 기록, 숫자만 유입)은 같고, 저장 위치가 다르다.
- 관계: ADR-0004(provider 자격 비유입), ADR-0113 D1, ADR-0125 D4·D8·D11, ADR-0188 D6(workd env 허용목록, #2630), ADR-0190(로컬 레인)

## Context
- `momo-workd`는 호스트 사용자의 Claude 로그인과 Codex 로그인을 그대로 쓴다. 호스트당 계정이 하나로 고정돼 있고, 프로필 전환이나 한도 소진 시 전환이 없다.
- 업계 표준 기법은 **프로필마다 설정 폴더 하나**다. Claude는 `CLAUDE_CONFIG_DIR`, Codex는 `CODEX_HOME`. 여러 계정을 동시에 돌리는 유일한 방법이다. Orca가 이 모양으로 동작하며, 전환은 새 세션에만 적용하고 실행 중 프로세스는 계정을 유지한다.
- **약관 선.** Anthropic은 제3자가 claude.ai 자격이나 세션 토큰을 수집·저장·중개하는 것을 금지하고, 사용자가 수정하지 않은 공식 바이너리에 자기 구독으로 로그인하는 것은 허용한다. OpenAI는 계정 자격을 남과 공유하지 못하게 한다. 팀 구독을 풀링해 한도를 피하는 것은 약관 위험이 분명하다.
- ADR-0135는 채팅 에이전트(서버측 `provider_link`)용이다. 하네스 CLI 계정(호스트 로컬)에는 적용 경로가 없다.

## Options
| 선택지 | 판단 |
|---|---|
| **A. 호스트 로컬 프로필 폴더, 서버엔 라벨·숫자만** | **채택.** ADR-0004 비유입과 약관을 함께 지킨다 |
| B. 서버 금고에 하네스 토큰 보관(0147 확장) | 기각. Anthropic 약관의 「중개 금지」에 걸린다. 0147이 「내부 도그푸딩 한정」으로 선을 그은 이유와 같다 |
| C. 팀원 계정 풀링·자동 순환 | 기각. 구독 약관 위반(0125 D8) |
| D. 한도 도달 시 조용한 자동 전환 | 기각. 비용·거버넌스가 다른 경로로 흘렀음을 사용자가 모른다(0135 D1 「조용한 전환 금지」) |

## Decision

### D1. 계정 프로필 = 하네스별 설정 폴더 하나, 호스트 로컬
- 앱이 `~/Library/Application Support/oort/profiles/<harness>/<label>/`을 만든다. Claude는 `CLAUDE_CONFIG_DIR`, Codex는 `CODEX_HOME`으로 그 폴더를 가리켜 띄운다. Grok은 해당 CLI의 방식을 스파이크로 정한다.
- 첫 사용 때 그 칸 안에서 공식 CLI의 `login`을 실행한다. 로그인은 사용자 손에서 끝나는 PTY 흐름이다.
- **A 레인(workd) 프로필은 로컬 L 프로필과 다른 폴더다.** L 프로필 폴더에는 사용자 층 설정(hooks·`permissions.allow`·MCP)이 생기므로 A 레인에 넘기지 않는다. A 레인 프로필은 host state 폴더 아래(`<state>/profiles/<harness>/<label>/`, 0700)에 두고, 소유자가 그 폴더로 한 번 로그인한다. 폰·서버는 host가 발급한 불투명 프로필 id만 보낸다. 경로는 서버에 싣지 않는다.
- **ADR-0188 §8.1을 이렇게 완화한다(조항별, 나머지는 그대로):**
  - 조건 1(host 전용 `CODEX_HOME` 하나, 고정 경로): 「프로필마다 고정 경로 하나」로 넓힌다. 각 `CODEX_HOME`은 조건 1의 나머지(0700, `auth.json`과 host가 매번 다시 쓰는 `config.toml`만, `AGENTS.md`·`rules/`·`hooks.json`·`prompts/`가 있으면 거부, 허용 폴더 안이면 거부, 자격 복사 금지)를 **각각** 만족한다. Codex 프로세스 `HOME`(F5 빈 폴더)은 프로필과 무관하게 하나 그대로다.
  - 조건 8(env 허용목록): Claude에 `CLAUDE_CONFIG_DIR` 하나를 더한다. 값은 host env에서 상속하지 않고 **host가 고른 프로필 폴더 경로로만 설정**한다. 그 폴더는 자격(키체인 항목 또는 자격 파일)과 host가 spawn마다 다시 쓰는 `settings.json`(hooks 없음, `permissions.allow` 없음, MCP 없음, §8.3 sandbox 설정 포함)만 가진다. 그 밖의 파일·폴더(`settings.local.json`, `CLAUDE.md`, `agents/`, `commands/`, `skills/`, `plugins/`, `hooks/` 등)가 있으면 spawn을 거부한다.
    - **단, ADR-0192 D3의 서명된 묶음 항목은 이 폴더 내용 제한의 예외다.** host가 넣은 링크(skills·`CLAUDE.md`·플러그인)와 host가 `settings.json`에 쓴 묶음 MCP 항목은 허용하며, 그 절의 거부 규칙과 해시 검사를 따른다. host가 넣지 않은 것은 여전히 거부한다.
  - 조건 2·F5와 §8.2·§8.3은 바뀌지 않는다.
  - **red proof(#2781·#2777 계열 구현, 없으면 머지하지 않는다):** host env의 `CLAUDE_CONFIG_DIR`이 에이전트에 넘어가지 않음 / 프로필 폴더에 hooks가 든 `settings.json`이나 허용 밖 파일이 있으면 spawn 거부 / 프로필 `CODEX_HOME`에 `AGENTS.md`가 있으면 거부 / state 폴더 밖 또는 허용 폴더 안 프로필 경로 거부.
- 서버에는 프로필 **라벨**(예: 「개인(Max)」)과 쿼터 숫자만 간다.

### D2. 약관 선 — 공식 바이너리, 토큰을 읽지 않는다, 풀링하지 않는다
- oort는 공식 바이너리를 폴더 변수만 바꿔 띄운다. 자격 파일과 토큰을 읽거나 옮기지 않는다.
- 실행 환경에서 `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`·`CLAUDE_CODE_OAUTH_TOKEN`·`OPENAI_API_KEY` 같은 변수를 제거해 프로필이 섞이지 않게 한다(workd env 허용목록 #2630 F1과 같은 방어).
- **스왑은 한 사람의 자기 계정들 사이에서만 한다.** 팀원끼리 계정을 풀링하지 않는다.

### D3. 쿼터 게이지 — 자격 보유 측이 숫자만 보낸다
- 로컬 L 칸: Claude는 조용한 `statusLine` 스크립트가 `rate_limits`를 **앱 전용 Unix 소켓**으로 보낸다. 서버로 가지 않는다. Codex·Grok의 사용량 신호는 스파이크로 정한다.
- A 세션: workd가 `{profile_label, window(short|weekly), remaining_ratio, resets_at, probed_at}`만 v2 서명으로 보낸다(0135 D2 ingest 문법의 host 확장). 토큰·헤더 원문은 들어오지 않는다.
- 표시는 짧은 창과 주간 창 두 게이지에 절대 리셋 시각과 스냅샷 나이를 붙인다. 없으면 「마지막 확인값」.

### D4. 한도 도달 — 조용한 전환 금지, 기본은 묻기
- 칸에 「개인 계정 5시간 한도 도달 · 16:00 리셋 · [다른 프로필로 이어서] [기다리기]」 카드를 띄운다.
- 「이어서」는 같은 worktree에서 다른 프로필로 **새 칸(새 세션)**을 열고 직전 대화 요약을 첫 프롬프트에 붙인다(0125 D11 계보 재개). 하네스 세션 파일 이전은 스파이크 뒤에 정한다.
- 실행 중인 프로세스의 계정은 바꾸지 않는다.
- A 레인에서는 폰에서도 같은 카드를 누를 수 있다. 전환 사실은 스레드 시스템 라인과 원장에 남는다.
- 자동 전환(`auto`)은 사용자가 미리 고른 순서로만 하는 옵트인이다(0125 D11 `ask/auto` 문법).

## 업계 비교
- **Orca:** 계정마다 `CLAUDE_CONFIG_DIR`, 실행 때 API 키 환경 변수 제거, Codex는 격리 home과 「활성 자격 포인터」, 전환은 새 세션에만. 한도에 따른 자동 전환은 문서에 없다. oort는 같은 모양에 한도 카드와 폰 표시를 더한다.
- **claude-swap·codexctl:** 남은 쿼터가 많은 계정을 자동으로 고른다. 한 사람의 계정 사이라면 약관 안이지만, oort는 조용한 전환을 금지하고 옵트인 순서만 허용한다.
- **Claude Tag:** 채널마다 조직 공용 신원을 쓴다. 개인 계정과 공용 신원을 섞지 않는다는 교훈을 따른다. 팀 공용 에이전트는 이 ADR 범위가 아니다(ADR-0192 D7).

## Consequences
- (+) ADR-0004 비유입과 구독 약관을 함께 지키면서 한 사람이 여러 계정을 동시에 쓴다.
- (+) 한도 소진이 「나를 기다림」으로 보이고, 전환이 기록된다.
- (−) Codex·Grok 사용량 신호가 불확실하다. 스파이크 결과에 따라 게이지가 Claude만 먼저 설 수 있다.
- (−) 쿼터 스냅샷 host 서명 ingest가 서버 새 표면이다. 새 테이블이면 RLS 대상이다.
- 파생 이슈: #2777(프로필 폴더·로그인), #2781(쿼터 ingest·게이지), #2782(폰 한도 카드).

## 구현 계약: 원격 작업의 계정 (2026-09-29, #3033)

D1 「A 레인 프로필」과 조건 1·8의 workd 쪽 구현이다. D1 본문은 바꾸지 않고 「폰·서버는 host가 발급한 불투명 프로필 id만 보낸다」를 이렇게 좁힌다.

- **계정은 이 맥의 선택이지 요청의 값이 아니다.** 「원격 작업」 행(기기 저장)은 이 맥의 데스크탑이 코드서명 제어 소켓으로 workd에 넘긴다(`set_remote_profile`, 하네스별 라벨 하나 또는 `null`). workd는 host state 폴더의 `remote-profiles.json`(0600)에 저장하고 spawn마다 읽는다. spawn 본문·기기 서명·서버는 계정도 경로도 싣지 않는다. 그래서 서명 본문(v2·v3)은 바뀌지 않고, 릴레이가 계정을 바꿀 길이 없다. 폰이 spawn마다 계정을 고르는 것은 이 계약 밖이다(하려면 host가 발급한 id와 서명 본문 확장이 함께 필요하다 — 별도 결정).
- **A 레인 프로필 폴더 = `<state>/profiles/<harness>/<label>/`(0700).** `prepare_remote_profile`이 단계마다 0700으로 만들고(링크를 지나지 않는다) 소유자가 공식 CLI로 로그인할 정확한 경로 문자열을 돌려준다. Claude 키체인 항목이 그 문자열의 해시로 정해지므로 spawn이 세팅하는 `CLAUDE_CONFIG_DIR`은 같은 문자열이다(끝 슬래시 없음, 마지막 단계는 resolve하지 않음). 로컬 L 프로필 폴더는 쓰지 않는다.
- **spawn마다 검사:** 라벨 규칙(로컬과 같음), `profiles`부터 모든 단계가 진짜 디렉터리(링크 거부)·이 사용자 것·0700, 디스크의 이름이 라벨과 바이트 단위로 같음, 허용 폴더와 겹치지 않음. Claude는 조건 8의 설정 항목(`settings.local.json`, `CLAUDE.md`, `agents/`, `commands/`, `skills/`, `plugins/`, `hooks/` 등)과 hooks·MCP·`permissions.allow`·`env`·헬퍼 명령이 든 `settings.json`을 거부한다. **원문의 「host가 spawn마다 다시 쓰는 settings.json」은 다시 쓰지 않고 거부로 구현한다** — 원격 Claude는 설정 파일을 읽지 않으므로(`settingSources: []`, §8.3의 설정은 `session/new` `_meta`로 간다) 다시 쓸 이유가 없다. Codex는 프로필 폴더를 `CODEX_HOME`으로 삼아 `prepare_codex_home`(조건 1)을 그대로 통과해야 한다.
- **env:** `CLAUDE_CONFIG_DIR`은 `AGENT_ENV_ALLOWLIST`에 넣지 않는다(넣으면 host의 상속 값이 통과한다). host가 검사한 폴더로만, 허용목록 위에 덮어쓴다. `CLAUDE_SECURESTORAGE_CONFIG_DIR`·`ANTHROPIC_CONFIG_DIR`·`ANTHROPIC_PROFILE`은 허용목록 밖이라 계속 넘어가지 않는다(로컬 터미널의 `STRIPPED_ENV`가 빼는 같은 변수들이다).
- **읽기·쓰기 금지(Claude):** 모든 A 레인 프로필(`<state>/profiles`, 설정된 경로와 OS가 resolve한 경로 둘 다)은 Claude 세션의 `Read`·`Edit` 거부 규칙(`//절대경로/**`)과 sandbox 자격 거부 목록에 든다. 세션이 다른 계정의 자격을 읽지도, 자기 프로필에 설정을 심지도 못한다. **잔여 위험(수용):** Codex 세션은 이 거부를 걸지 못한다(읽기 전용 sandbox가 디스크 전체를 읽는다) — 원격 Codex가 다른 프로필의 `auth.json`을 읽을 수 있다. 조건 1의 「자격 복사 금지」와 §8.1의 sandbox 수용 범위 안이며, Codex 파일시스템 읽기 제한은 후속으로 다룬다. 같은 사용자의 다른 프로세스가 선택 파일을 지우거나 프로필을 만드는 것은 이 계약의 위협 모델 밖이다(0600은 다른 사용자만 막는다).
- **조용한 기본 계정 폴백 금지:** 라벨이 정해져 있으면 그 프로필로 뜨거나 거부한다. 거부 라벨은 `profile_not_found`(폴더 없음), `profile_refused`(위 검사 실패·선택 파일 읽기 실패), `profile_login_required`(Codex `auth.json` 없음, 또는 어댑터가 ACP `auth_required`(-32000)로 답함), Codex 폴더의 `AGENTS.md`·`rules/` 등은 `codex_home_refused`. 이 라벨은 방에 `work.control.acked`로 보이며(`set_remote_profile`은 선택 파일이 읽히지 않을 때의 해제가 모든 하네스를 「선택 없음」으로 되돌리면 `reset: true`로 알린다 — 조용하지 않다) 클라이언트가 「매번 묻기」로 돌아가는 근거다. 알려진 한계: 로그아웃된 Claude 프로필이 `auth_required` 대신 다른 방식으로 실패하면 `agent_start_failed`로 보인다(키체인을 읽지 않는다 — D2).

## 결재 기록
- **2026-09-26 성재:** 「전부 권장대로 가자」. Q5 권장안 「계정 스왑은 한 사람의 자기 계정들 사이, 새 칸으로 이어서, 전환은 기록. 한도 도달 시 기본은 묻기, 자동 전환은 옵트인」을 확정했다.
