# ADR-0205: GitHub App 연동 — 인스턴스가 가진 통합 자격증명과 서명 수신으로 저장소 → 채널 알림

- Status: **Accepted** (2026-10-16. 결재 원문은 「owner 결정」에 인용. D6 권한 묶음은 같은 날 저녁 결재로 고정됐다)
- Date: 2026-10-16
- Deciders: 성재
- 기안: Opus 5.5 planner (플러그인 v2 조사 묶음)
- 반영: D-0 (#3935) — 초안 번호 0204를 0205로 올리고, D6 권한 묶음 결재(2026-10-16 저녁)를 반영했다. 코드·인프라 변경 없음.
- 번호 확인 [V, 2026-10-16]: 초안은 0204로 썼으나 0204는 폰 알림 v2([ADR-0204](0204-phone-notifications-v2.md), #3922·PR #3934, `origin/track/engine` `987630c6f`)가 먼저 가져갔다. 그래서 **0205로 올렸다**. `origin/main`·`origin/track/engine`·`origin/track/uxui`의 `docs/adr/`에 0205는 없고, 열린 PR 중 `docs/adr/0205`를 만드는 것도 없다(D-0 #3935 착수 때와 PR 올리기 직전에 확인). 같은 묶음의 다른 문서는 기존 ADR 증보(0113 증보 2·0188 §8.9·0203 증보)라 번호를 쓰지 않는다.
- 관계: ADR-0113(D1-B 기각 **불변**, 증보 2), ADR-0115(signed ingress — 수신 모드 이탈 기록), ADR-0004 증보 1·4(운영자 자격증명 암호화 보관·마스터키 규율), ADR-0147(api 봉인·worker 복호화 나눔), ADR-0171(봉인·write-only 모양), ADR-0192 D7 Q9(A5 — 역방향 줄), ADR-0203 D6-2(Hermes에 oort 비밀값 금지), ADR-0201(도우미 경계), ADR-0100
- 표기: [V] 직접 확인(저장소 코드·문서, 또는 2026-10-16 받은 docs.github.com 원문) · [추정] · [확인 필요](닫는 슬라이스를 함께 적는다) · `runtime-unverified`. 이 문서는 설계이고 코드·인프라를 바꾸지 않았다.

## 맥락

### 풀려는 문제
팀이 GitHub 저장소의 PR·이슈·체크 소식을 채널에서 받고 싶다. Slack의 「GitHub 앱」처럼 설치 한 번, 채널마다 구독 한 줄로. 지금 oort에는 이 길이 없다.

- ADR-0115 수신(`POST /v1/webhooks/{ws}/{installation}` native HMAC, `POST /hooks/{token}` Slack 호환)은 있지만, `X-Hub-Signature-256`을 처리하는 코드는 0이다 [V, `webhook_ingress.rs:1-24`]. GitHub 저장소 웹훅은 Slack 형식을 보내지 않으므로 #2783의 「URL 교체」 레시피로는 받을 수 없다 [추정 — 형식 차이는 GitHub 문서로 확인, 실제 시도는 안 함].
- ADR-0192 D7 Q9는 「oort 서버가 토큰을 쥐는 MCP 카탈로그는 A5(커넥터 커스터디 재정합) 뒤, A5는 목표 A 뒤」라고 적었고, #2869는 수용기준에 「서버가 GitHub 토큰을 쥐지 않음」을 적었다. 이번 결재는 그 순서를 **알림에 한해** 앞당긴다.

### GitHub 쪽 사실 [V, docs.github.com 2026-10-16]
- **매니페스트 흐름**(`/apps/sharing-github-apps/registering-a-github-app-from-a-manifest`): 매니페스트를 `https://github.com/settings/apps/new`(개인) 또는 `…/organizations/ORG/settings/apps/new`로 POST → `redirect_url`로 `code` → `POST /app-manifests/{code}/conversions`. 원문 「You must complete all three steps … within one hour」. 응답에 `id`·`slug`·`client_id`·`client_secret`·`webhook_secret`·`pem`.
- **개인키**(`/…/managing-private-keys-for-github-apps`): 원문 「GitHub only stores the public portion of the key」 — 변환 때 봉인하지 않으면 잃는다(새 키는 다시 만들 수 있다). 앱당 최대 25개, 「use multiple keys in order to rotate keys without downtime」. 환경 변수 보관을 권하지 않는다: 「If an attacker gains access to the environment, they can read the private key and gain persistent authentication」.
- **JWT**: RS256, `exp` 10분 이내, `iat` 60초 전, `iss`에 client ID 권장. **설치 토큰**: 1시간 만료, 저장소(최대 500)·권한을 좁혀 받을 수 있다.
- **웹훅 검증**: `X-Hub-Signature-256: sha256=<HMAC-SHA256 hex(secret, body)>`, 상수 시간 비교. 서명에 시각이 없다. 재전송은 같은 `X-GitHub-Delivery`(「If you request a redelivery, the X-GitHub-Delivery header will be the same」). 10초 안에 2xx. 원문 「GitHub does not automatically redeliver failed deliveries」. 페이로드 상한 25MB.
- **이벤트 권한**: issues·issue_comment → Issues read, pull_request·pull_request_review → Pull requests read, check_run·check_suite → Checks read, push·release → **Contents read**, workflow_run → Actions read. `installation`·`installation_repositories`는 모든 앱이 받는다(`created`·`deleted`·`suspend`·`unsuspend`·`new_permissions_accepted`).
- **권한 확대**: 원문 「the owner of each account where the app was installed will be prompted to approve the new permissions」.
- **setup URL 위조**(`/…/about-the-setup-url`): 원문 「Bad actors can hit this URL with a spoofed installation_id. Therefore, you should not rely on the validity of the installation_id parameter」. GitHub 권장 해법은 사용자 토큰으로 확인 — 이 ADR은 채택하지 않는다(D3).
- setup URL에 `state`가 되돌아오는지는 GitHub 원문에서 찾지 못했다(제3자 문서에만 있음) [확인 필요: E-GH2에서 실측. 안 오면 D3 대체 경로만 쓴다].
- 벤치마크 [V, github.com/integrations/slack]: 워크스페이스에 설치, 채널별 `/github subscribe owner/repo [feature]`. 기본 issues·pulls·commits·releases·deployments, 선택 workflows·reviews·comments·branches, 라벨·브랜치 필터.

### 레포에 이미 있는 것 [V, track/engine `cfe8ec888`]
- 봉인: `momo-settings/src/crypto.rs:1-80` — `version(0x01) || nonce(12) || ct || tag(16)`, 키 `SHA256("momo.provider_link.key.v1\n" || PROVIDER_LINK_MASTER_KEY)`. doorbell은 같은 틀에 도메인만 바꿔 `OUTBOUND_WEBHOOK_MASTER_KEY` 아래 봉인(`momo-webhook/src/crypto.rs:236-300`).
- 운영자 전용 전역 테이블: `039_provider_link.sql` — RLS FORCE, `provider_link_operator` 정책 `current_setting('app.provider_link_admin', true) = 'on'`(:63-67).
- 마스터키 재사용 거부: `config.rs:1751-1762` — `PROVIDER_LINK_MASTER_KEY`가 JWT·OUTBOUND·INGRESS 키와 같으면 기동 거부.
- 수신 순서: 「signature/token → body-size → rate limit → replay → parse」, 메시지는 `send_message_in_tx`로만, 본문 상한 262144바이트(`webhook_ingress.rs:56`), 설치 단위 rate 예산과 `webhook.rate_limited` 감사.
- egress 가드 `momo-egress`(사설 주소 거부·redirect 없음·프록시 무시).

## 결정

### D1. 자격증명의 급과 보관 — 인스턴스가 가진 통합 자격증명, DB에 봉인
- GitHub App 자격증명(개인키·webhook secret)은 **인스턴스 자신의 통합 자격증명**이다. 사람의 OAuth 토큰이 아니다. 그래서 ADR-0113 D1-B(사람 토큰 서버 보관)는 **다시 열리지 않는다**. 이것은 ADR-0004 증보 1(운영자 provider bearer를 암호화해 DB에 보관)과 같은 급의 확장이다.
- 보관: 싱글턴 테이블 `github_app`(신규 migration) — `app_id`, `slug`, `client_id`, 소유 계정(login·type), **봉인한 `pem`**, **봉인한 `webhook_secret`(현재 값 + 이전 값 + `previous_valid_until`)**, 만든 사람·시각. RLS ENABLE + FORCE, 정책은 `039` 모양으로 운영자 GUC `app.github_app_admin`과 수신 GUC(D5) 두 갈래.
- **`client_secret`은 저장하지 않는다.** 사람 토큰 흐름을 쓰지 않으니 필요가 없다(변환 응답에서 받는 즉시 버린다).
- 마스터키: **독립 키 `GITHUB_APP_MASTER_KEY`**, 봉인 도메인 `momo.github_app.key.v1\n`.
  - 없으면 GitHub 표면만 503이다(provider link와 같은 규칙). 나머지 서버는 뜬다.
  - `config.rs` 재사용 거부를 넓힌다: JWT·OUTBOUND·INGRESS·PROVIDER_LINK 키와 같으면 기동 거부.
  - `scripts/self_host_env.sh` 키 수 계약 +1, 같은 커밋에서 `test_self_host_env_modes.sh`·`test_railway_template.sh`·`test_self_host_build_sha.sh`를 갱신한다(ADR-0004 증보 4 D1 규율).
  - 독립 키를 고른 이유: INGRESS 키를 회전하면 이미 모든 native secret을 다시 발급해야 한다. 거기에 GitHub 재봉인까지 묶지 않는다. 2단계 worker는 이 키만 받으면 된다.
- **1단계는 PEM을 한 번도 열지 않는다.** api는 봉인만 하고, 복호화 함수의 호출 지점이 바이너리에 0이다(grep 가드, 수용 기준 7). 알림에 필요한 것은 webhook secret 검증뿐이다. D6이 코드 읽기(`contents: read`)까지 받기로 했으므로 이 키가 새면 피해 반경이 커진다 — 이 가드가 그 위험을 묶는다(귀결).
- Hermes 서비스 env에 `GITHUB_APP_MASTER_KEY`를 걸지 않는다(ADR-0203 D6-2). 도우미는 이 자격증명을 읽지도 쓰지도 않는다(ADR-0201 H9-I5).

### D2. 인스턴스마다 앱 하나, 매니페스트 흐름으로 등록
- 누가: 인스턴스 운영자(`PLATFORM_ADMIN_EMAILS`). 설정 › 연결에서 「GitHub 앱 만들기」(개인 계정 또는 조직 이름 입력)를 누르면 서버가 매니페스트를 만들어 GitHub로 보낸다.
  - `hook_attributes.url` = `https://<공개 주소>/v1/integrations/github/webhook`
  - `redirect_url` = `https://<공개 주소>/v1/integrations/github/app/callback`, `setup_url` = `…/github/setup`
  - `public: false`(그 계정에만 설치) [추정: 조직 안 여러 저장소 설치에는 충분 — E-GH1에서 확인], `request_oauth_on_install: false`
  - `default_permissions`·`default_events` = D6 묶음
- 콜백은 1시간 안에 code를 변환하고, 응답을 받은 그 함수 안에서 봉인해 저장한다. 평문 PEM은 그 함수 밖으로 나가지 않는다(로그·감사·응답 0). 운영자 콜백은 매니페스트 POST 때 만든 일회용 state를 확인한다(CSRF).
- 손으로 만든 앱을 위한 「앱 id + PEM + webhook secret 붙여 넣기」 운영자 폼(write-only, ADR-0171 모양)을 같은 봉인으로 둔다(선택).
- **셀프호스트는 인스턴스마다 자기 앱을 등록한다.** GitHub App은 웹훅 URL이 앱당 하나라 「oort 공식 앱 하나로 모든 인스턴스」는 중계가 필요하다 — oort Cloud 단계 범위 밖이다.
- **공개 HTTPS가 필요하다.** 로컬·NAT 셀프호스트는 알림을 받을 수 없다. `oort doctor`가 공개 주소와 `GITHUB_APP_MASTER_KEY` 유무를 알려 준다.
- 팀 Railway 인스턴스는 성재가 조직 `yeomyeonggeori` 아래에 한 번 등록한다(owner 손 작업 — 등록 화면 링크로 전달).

### D3. 설치를 워크스페이스에 연결 — 사용자 토큰 없이, 두 신호가 만나야 확정
1. 워크스페이스 owner/admin이 「GitHub 연결」을 누른다. 서버가 일회용 `state`를 만든다(`(workspace, member)`에 묶임, 10분 만료, 해시만 저장).
2. `https://github.com/apps/<slug>/installations/new?state=…`로 보낸다.
3. setup URL로 돌아오면 `installation_id`와 state를 **대기 claim으로만** 기록한다(이 시점의 `installation_id`는 위조될 수 있다).
4. **서명된 `installation.created`**(D4 검증 통과)가 같은 `installation_id`로 오면 그때 처음 연결을 확정한다. 순서는 어느 쪽이 먼저 와도 된다 — 서명 이벤트는 「연결 안 된 설치」로, setup 콜백은 「대기 claim」으로 남고, 둘이 만나는 순간 확정한다.
- state가 돌아오지 않거나(맥락 「GitHub 쪽 사실」의 [확인 필요]), 조직 소유자가 아닌 사람이 설치를 **요청**만 한 경우(`setup_action=request`): 「연결 안 된 설치」 목록(서명 이벤트로만 알게 된 계정 login·저장소 수)을 **인스턴스 운영자**가 보고 워크스페이스에 붙인다. 워크스페이스 관리자에게는 남의 설치 목록을 보이지 않는다(인스턴스 안 다른 워크스페이스의 GitHub 계정 이름이 새지 않게).
- 한 GitHub 계정에는 한 앱이 한 번만 설치된다. 그래서 **한 인스턴스에서 한 GitHub 계정은 한 워크스페이스에만** 연결된다(`installation_id` UNIQUE). 이미 다른 워크스페이스에 연결된 설치를 claim하면 409.
- 위조 방어: state 없음·남의 state → 연결 0. 서명 이벤트 없음 → claim 만료. 사용자 토큰은 받지도 쥐지도 않는다(`request_oauth_on_install: false`).

### D4. 수신 — 인스턴스 전역 경로 하나, ADR-0115와 다른 모드
- `POST /v1/integrations/github/webhook`. 순서는 ADR-0115와 같은 뼈대다:
  1. `X-Hub-Signature-256`을 현재 secret으로, 회전 겹침 창이면 이전 secret으로도 상수 시간 비교. 실패 → 401, 아무것도 쓰지 않는다. SHA1 `X-Hub-Signature`는 보지 않는다.
  2. 본문 크기: GitHub 모드 상한은 별도 값(초안 5 MiB) [추정 — 실제 이벤트 크기 분포는 E-GH2에서 기록]. 넘으면 413.
  3. 설치 단위 rate 예산(기존 리미터, `webhook.rate_limited` 감사 재사용).
  4. replay: `X-GitHub-Delivery` 멱등. 같은 GUID는 `duplicate: true`, 메시지 0.
  5. 파싱.
- **ADR-0115 D1과의 이탈**: 서명에 시각이 없어서 replay **시간 창**이 없고 delivery id 멱등만 있다. 재전송 요청도 같은 GUID라 중복으로 처리된다. ADR-0115에 관계 줄을 단다.
- 10초 안에 응답한다. 무거운 일이 없도록 수신 tx는 receipt·메시지 쓰기만 한다.
- `ping` → 200. 모르는 이벤트 → 200, 아무것도 하지 않음.
- `installation.deleted`·`suspend`, `installation_repositories.removed` → 구독 비활성. `unsuspend`·`added` → 다시 활성(구독 자체는 사람이 만든 것만).
- 쓰기: 설치 → 워크스페이스 조회(D5) 뒤 **한 tenant tx**에서 receipt + 그 이벤트를 받는 구독 채널마다 `send_message_in_tx`(결정적 `client_msg_id` = delivery + channel). REST send 단일 쓰기 경로·outbox 불변식은 그대로다.
- 작성자: 워크스페이스의 「GitHub」 전용 비로그인 author 멤버. 본문은 「@login이 PR을 열었어요」처럼 쓰되 사람인 척하지 않는다(ADR-0115 D3).

### D5. 테넌트 모델 — BYPASSRLS 없이 설치 → 워크스페이스
- `github_app`(D1, 인스턴스 싱글턴).
- `github_app_installation`(전역): `installation_id` PK, 계정 login·type, `repository_selection`, `workspace_id`(연결 전 NULL, UNIQUE 대상은 `installation_id`), `linked_at`·`suspended_at`·`removed_at`. 비밀 없음. RLS ENABLE + FORCE, 정책 세 갈래 — (a) 수신 GUC `app.github_ingress = 'on'`: SELECT·INSERT·UPDATE(서명 검증을 통과한 수신 함수 안에서만 켠다), (b) 운영자 GUC `app.github_app_admin = 'on'`: 연결 안 된 설치 목록·연결, (c) tenant: `workspace_id = current_setting('app.workspace_id')`인 행 SELECT. 정확한 정책 모양은 E-GH1에서 정하고 **독립 보안 검수**를 받는다 [확인 필요]. `039` provider_link GUC가 선례다.
- `github_link_claim`(tenant, `ws_isolation`): state 해시, member, `installation_id`(setup 콜백 값), 만료.
- `github_channel_subscription`(tenant, FORCE): channel, `installation_id`, `repo_id`·`full_name`, 기능 목록, 필터(라벨·브랜치는 v1 밖), 만든 사람, 감사 FK.
- `github_receipt`(tenant): `(workspace_id, delivery_id)` UNIQUE. 기존 `webhook_receipt` 재사용 여부는 E-GH2에서 정한다. `webhook_installation`의 mode CHECK는 넓히지 않는다(비밀 모델이 다르다: 설치마다 vs 앱마다).
- 저장소 목록: 설치 이벤트 페이로드의 `repositories`와 `installation_repositories` 이벤트로 유지한다(1단계는 API 호출 없음). 「모든 저장소」 설치에서 페이로드가 전체 목록을 주는지 [확인 필요: E-GH2]. 없으면 구독 화면은 `owner/repo` 입력을 받고 첫 이벤트에서 `repo_id`를 채운다.
- 구독 권한: v1은 owner/admin(ADR-0115 D4와 같다). **비공개 저장소를 공개 채널에 연결**하면 경고 문장을 보이고 한 번 더 확인받는다.

### D6. v1 권한·이벤트 묶음 — 결재로 고정
- **권한(읽기 다섯 줄, 성재 결재 2026-10-16 저녁)**: `metadata: read`(필수), `issues: read`, `pull_requests: read`, `checks: read`, `contents: read`. **쓰기 권한은 하나도 없다.** 매니페스트의 `default_permissions`는 이 다섯 줄이 전부다(수용 기준 12).
- 이벤트: `pull_request`, `pull_request_review`, `issues`, `issue_comment`, `check_suite`(completed), `push`, `release`. `installation`·`installation_repositories`는 모든 앱이 받는다. `push`·`release`는 Contents read가 있어야 받는 이벤트다(맥락).
- 기본으로 켜지는 알림(Slack 앱을 본뜬다): PR 열림·닫힘·병합·Ready for review, 이슈 열림·닫힘. 선택(기본 꺼짐): 리뷰, 댓글, 체크 실패, 커밋(기본 브랜치 push), 릴리스. 메시지는 채널 구독이 켜 둔 기능에만 간다(수용 기준 13). 결재 대상은 **권한 묶음**이고, 이벤트 목록과 「선택·기본 꺼짐」은 그 귀결로 정한 기본값이라 구독 화면(U-GH1)에서 바꾼다.
- 코드 읽기까지 받는 근거(결재 선택지의 사실): 나중에 권한을 넓히면 앱이 설치된 모든 계정의 소유자가 다시 승인해야 하고(맥락), 커밋·릴리스 알림도 `contents: read`가 있어야 받는다. 그래서 처음에 읽기 다섯 줄을 받아 둔다.
- **코드 읽기 권한이 따라온다는 점을 숨기지 않는다.** 설치 화면에서 계정 소유자에게 그대로 보인다. 1단계(알림)는 코드를 읽지 않는다 — PEM을 열지 않으니 설치 토큰을 만들 수 없고, 운영자가 시작하는 매니페스트 code 변환 한 번 외에 GitHub API 호출이 없다(D1·D8). 설치는 「선택한 저장소만」으로 하도록 권한다(운영 권고. doctor와 U-GH1 안내문에 쓴다). 코드를 읽는 기능(설치 토큰으로 파일·diff 읽기)은 이 결정에 들어 있지 않고, D8·D9의 별도 증보로 연다.
- **v1에서 못 하는 것**: 워크플로(Actions)·배포·status 알림 — 각각 다른 권한이 필요하고, 넓히면 설치한 모든 계정이 다시 승인해야 한다. 쓰기(이슈·PR·댓글 만들기)도 같다(D9).
- #2869의 PR 체크 카드는 이 `check_suite` 이벤트를 쓴다.

### D7. 회전
- **webhook secret**: oort가 새 secret을 만들어 운영자에게 한 번만 보여 준다(write-only 화면). 겹침 창(초안 24시간) 동안 이전·현재 둘 다 받는다. 운영자가 GitHub 앱 설정에 붙여 넣는다. 창이 끝나면 이전 값은 401. 2단계에서는 JWT로 `PATCH /app/hook/config`를 불러 자동화할 수 있다.
- **개인키**: GitHub에서 새 키를 만들어 붙여 넣고(봉인), 옛 키를 GitHub에서 지운다. 25개 한도라 중단이 없다. 1단계는 PEM을 쓰지 않으니 실제 의미는 2단계부터다.
- **마스터키 회전**: 일회성 재봉인 명령(옛 키로 열고 새 키로 봉인, 한 tx)과 `oort doctor` 확인을 둔다. provider_link 쪽에 같은 절차가 있는지 [확인 필요] — 없으면 이 ADR의 절차를 공용으로 쓰고 SELF_HOST 회전 절에 함께 적는다.
- 유출 대응: DB 덤프와 마스터키가 함께 새면 설치된 모든 저장소의 PR·이슈·체크와 **코드(contents)** 를 읽을 수 있다(D6의 결재 범위). 대응 순서(SELF_HOST에 적는다): GitHub에서 키 삭제·webhook secret 교체 → oort에서 재봉인 → 필요하면 앱 삭제·재등록. 설치를 「선택한 저장소만」으로 두면 피해 반경이 그 저장소들로 줄어든다.

### D8. 바깥 연결(egress)
- 1단계: 매니페스트 code 변환 한 번(`api.github.com`, 운영자가 시작) 외에 0이다. ADR-0113 D5 「oort 서버 자신의 egress는 현행 유지」를 사실상 그대로 지킨다.
- 2단계(증보로 연다): `api.github.com` 고정 호스트만, `momo-egress` 경유, worker에서만. 용도는 놓친 전달 재조회(`GET /app/hook/deliveries`, GitHub가 자동 재전송하지 않는다)와 webhook secret 자동 회전.
- GHES base URL은 범위 밖이다.

### D9. 범위 밖과 예약
- 사람 토큰: `request_oauth_on_install`, `GET /user/installations`, 앱을 GitHub MCP의 사용자 OAuth client로 쓰기 — 모두 D1-B 방향이라 계속 기각이다. 채팅에서 GitHub 도구를 쓰는 것은 ADR-0113 증보 2의 「각자 에이전트」 경로다.
- 설치 토큰으로 하는 「행동」(봇 명의 이슈·댓글): `oort[bot]` 명의라 누가 시켰는지가 흐려지고 「각자 에이전트」 결정과 겹친다. 예약만 하고, 명의 문제는 증보에서 정한다.
- oort Cloud 공용 앱, GHES, 라벨·브랜치 필터, 저장소 단위 웹훅(앱 없는 인스턴스용 — 후속 선택지).

### D10. 기존 조각과 맞추기 (같은 문서 PR)
- ADR-0192 D7 Q9에 역방향 줄(D-0 #3935에서 달았다): 「GitHub App 알림 자격증명은 ADR-0205가 A5 중 좁은 선행 예외로 정한다. 사람 토큰을 서버가 쥐는 MCP 카탈로그(A5 본체)는 그대로 목표 A 뒤다.」
- ADR-0115에 관계 줄(D-0 #3935에서 달았다): 「GitHub App 수신은 ADR-0205 D4의 별도 경로다. 시각 창 없는 delivery 멱등은 D1의 이탈로 거기 적었다.」
- #2869 수용기준 개정(D-0 #3935에서 고쳤다): 「서버가 **사람** GitHub 토큰을 쥐지 않음. App 자격증명은 ADR-0205 봉인 규율」, 의존을 E-GH2(#3954)로.
- 설계 계획의 E-6(저장소 웹훅 + Secret, ADR-0115 증보)은 이 경로로 흡수한다. U-5는 「채널 ⋮ › GitHub 알림」 구독 화면으로 다시 정의한다.
- 「앱」 화면의 GitHub 카드에 얼굴 둘: 「알림 · 팀 전체 · oort 서버가 받아요」와 「도구 · 각자 에이전트」(Drive 두 칩과 같은 문법). 레지스트리 매니페스트는 바꾸지 않는다.

## 기각한 대안
- **Railway env에 PEM 보관**: 원클릭 등록과 맞지 않고(변환 응답을 env로 옮길 길이 없다) GitHub가 권하지 않는다.
- **PEM을 받는 즉시 버림(1단계 키 0)**: 보관 위험은 가장 작지만, 2단계(놓친 전달 재조회)에 운영자가 키를 다시 만들어 붙여야 한다. 성재 결재가 「서버가 앱 자격증명을 가진다」를 전제로 했고, 1단계 복호 경로 0(grep 가드)으로 위험을 묶는 쪽을 택했다.
- **저장소마다 웹훅 + Secret(ADR-0115 증보)**: 저장소마다 손으로 설정한다. 앱 없는 인스턴스용 후속 선택지로 남긴다.
- **사람 토큰으로 설치 확인**(GitHub 권장): D1-B다.
- **공식 앱 하나로 모든 인스턴스**: 중계가 필요하다. Cloud 단계.
- **`contents: read` 없이 시작(권한 최소)**: 위험은 가장 작지만 커밋·릴리스 알림이 없고, 나중에 넓히면 설치한 모든 계정이 다시 승인해야 한다. 결재가 코드 읽기까지 받는 쪽을 골랐다(D6).
- **쓰기 권한 포함(이슈·PR·댓글 쓰기)**: 봇 명의 「행동」이라 누가 시켰는지가 흐려진다. D9가 예약만 한다.
- **전역 라우팅 표를 GUC 없이 모두에게 SELECT**: 인스턴스 안 다른 워크스페이스의 설치·계정 이름이 tenant 세션에 보인다.

## 귀결
- (+) 원클릭 등록, 사람 토큰 0, 1단계 바깥 연결 0, PEM 복호 0.
- (+) Slack GitHub 앱과 같은 「설치 한 번 + 채널 구독」 모양.
- (−) 서버에 고가치 키가 하나 늘어난다. D6에서 코드 읽기까지 받으므로 DB와 마스터키가 함께 새면 설치된 모든 저장소의 PR·이슈·체크와 코드를 읽을 수 있다 — 코드 읽기가 없던 초안보다 피해 반경이 크다. 1단계가 PEM을 한 번도 열지 않는 grep 가드(수용 기준 7)와 「선택한 저장소만」 설치 권고가 이 위험을 묶는다.
- (−) 공개 HTTPS가 필요하다. 「프롬프트 하나로 셀프호스팅」 기대와 어긋날 수 있어 doctor가 정직하게 말한다.
- (−) 한 GitHub 계정은 인스턴스당 한 워크스페이스에만.
- (−) 1단계에서는 서버가 내려간 동안의 이벤트를 잃는다(GitHub는 자동 재전송하지 않는다). 재조회는 2단계.
- (−) 읽기 다섯 줄은 처음에 받아 두지만, 쓰기나 Actions·Deployments 같은 다른 권한을 더할 때는 설치한 모든 계정이 다시 승인해야 한다.

## 불변식 대조
- REST send → outbox → relay 단일 쓰기 경로 — 유지(`send_message_in_tx`).
- 모든 테넌트 경로 RLS FORCE + `SET LOCAL app.workspace_id`, 쓰기 경로 BYPASSRLS 0 — 유지. 전역 두 테이블은 GUC 정책(039 선례).
- `schema_v0.sql` 수정 없음 — 신규 migration만.
- 사람 사칭 없음(ADR-0115 D3) — 유지.
- 평문 PEM·secret·`client_secret`이 로그·감사·응답·Context Packet·outbox에 0.
- ADR-0113 D1-B 기각 — 유지(사람 토큰 없음).

## 구현 슬라이스 (Accepted 후, 한 슬라이스 = 한 이슈·브랜치·PR)
- **E-GH1 (engine, #3947)**: migration(`github_app`·`github_app_installation`·`github_link_claim`·`github_channel_subscription`·`github_receipt`), `GITHUB_APP_MASTER_KEY`와 재사용 가드·키 수 계약, 봉인, 운영자 매니페스트 흐름·콜백, 붙여 넣기 폼. RLS 정책 독립 보안 검수. D6 권한 묶음 결재가 닫혔으므로 이 ADR이 머지되면 바로 시작한다.
- **E-GH2 (engine, #3954)**: 수신 경로(D4), 설치 연결(D3 두 신호), 구독 REST, receipt, 설치 상태 이벤트, `push`·`release` 선택 알림(D6). state 되돌아옴·저장소 목록 실측 기록.
- **U-GH1 (uxui, #3955)**: 운영자 등록 화면, 워크스페이스 「GitHub 연결」, 채널 ⋮ 「GitHub 알림」 구독(선택 알림 포함), 비공개 저장소 경고, 앱 카드 두 얼굴, 알림 메시지 렌더(웹·데스크탑·폰). 캡처(라이트·다크)·design-review Blocker 0·High 0.
- **E-GH3 (engine+web, #2869)**: PR 체크 카드.
- **docs**: SELF_HOST(공개 주소 요건·키 회전·유출 대응·「선택한 저장소만」 설치 권고), Railway 가이드, doctor.
- **2단계 증보**: JWT·egress·놓친 전달 재조회·secret 자동 회전. 행동은 별도.

## 수용 기준 (red proof — 해당 분기를 지우면 실패해야 한다)
1. 서명이 틀리거나 없으면 401, 메시지 0, receipt 0. 비교를 지우면 실패.
2. 같은 delivery를 다시 보내면 `duplicate: true`, 메시지는 1개.
3. state가 없거나 남의 것이면 연결 0. 서명된 `installation.created` 없이 setup URL만 오면 연결 0. 순서가 바뀌어도(이벤트 먼저) 두 신호가 만나면 정확히 1회 연결.
4. 이미 다른 워크스페이스에 연결된 설치를 claim하면 409. 다른 워크스페이스의 구독에 이벤트가 섞이지 않음(RLS, `momo_app` 역할로 직접 확인). tenant 세션은 연결 안 된 설치·남의 설치를 SELECT하지 못함.
5. `installation.deleted`·`suspend` 뒤 이벤트는 메시지 0. `unsuspend` 뒤 다시 1.
6. 어떤 응답·감사 행·로그에도 PEM·webhook secret·`client_secret` 바이트가 없다(마커 시험). `client_secret`은 테이블에도 없다.
7. 1단계 바이너리에 PEM 복호 함수 호출 지점이 0이다(grep 가드 — 호출을 하나 넣으면 실패).
8. `GITHUB_APP_MASTER_KEY`가 없으면 GitHub 표면 503(다른 라우트 정상), 다른 마스터키와 같으면 기동 거부.
9. 본문이 상한을 넘으면 413, `ping`은 200, 모르는 이벤트는 200·메시지 0.
10. secret 회전 겹침 창에서 이전·현재 둘 다 통과, 창이 끝나면 이전 값 401.
11. 비공개 저장소를 공개 채널에 구독할 때 확인 없이는 구독 행 0.
12. 매니페스트 생성 함수의 `default_permissions`가 정확히 `metadata`·`issues`·`pull_requests`·`checks`·`contents` 읽기 다섯 줄이다. 쓰기 권한을 하나 넣거나 `contents`를 빼면 시험이 실패한다.
13. 구독의 기능 목록에 커밋·릴리스를 켜지 않은 채널에는 `push`·`release` 이벤트가 메시지 0이고, 켠 채널에는 1이다(기능 목록 판정을 지우면 실패).

## owner 결정 (2026-10-16, 원문 인용)
- AskUserQuestion 결재(GitHub 저장소 → 채널 알림): 「GitHub App으로 자동」. 결재 맥락(planner 요약, 원문 아님): 저장소에 설치한 GitHub App이 이벤트를 채널로 보내고, oort 서버가 App 개인키를 보관한다 — ADR-0113 D1-B와 비슷한 보관 변경이라 새 ADR로 정한다.
- 같은 날 실행 장소 결재 「각자 + 1인 워크스페이스에서 Hermes 시험 (추천)」은 채팅의 GitHub **도구** 경로를 정한다(ADR-0113 증보 2). 이 ADR은 **알림**만 다룬다.
- AskUserQuestion 결재(2026-10-16 저녁, D6 권한 묶음): 질문 「GitHub App의 첫 권한을 어디까지 받을까요?」 → 답 「이슈·PR·체크+코드 읽기 (Recommended)」. 반영: D6을 metadata·issues·pull_requests·checks·contents **읽기**로 고정했다(수용 기준 12). 1단계가 PEM을 열지 않고 알림만 받는다는 D1의 문장은 그대로다.

### 남은 owner 확인
없음. D6 권한 묶음 확인은 위 결재로 닫혔고, E-GH1(#3947)은 이 ADR이 머지되면 바로 시작할 수 있다.
