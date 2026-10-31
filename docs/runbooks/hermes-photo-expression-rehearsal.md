# 사진 이모티콘 실제 Hermes 리허설

> 상태: 절차 초안(2026-10-31, #4931 S4). owner가 2026-10-31 21:06에 실제 Hermes 리허설 실행을 승인했다(코디네이터 전달). **실행은 planner가 이 맥에서 한다.** 이 문서를 쓴 워커는 로그인·자격 파일·docker·그림 생성을 쓰지 않았으므로 아래 명령은 모두 runtime-unverified다. 부록의 스크립트 다섯 개는 합성 입력으로 로컬에서만 시험했다(프록시 11케이스·사보타주 2건, 점검 스크립트 파싱, 합성 그림 세 장의 측정, Hermes 기록 읽기).
> 계약: [ADR-0218 §7 G3.7·G4](../adr/0218-workspace-expressions.md)가 호스팅 문과 전달 경로를, [§8](../adr/0218-workspace-expressions.md)(#4931, Proposed)이 배경 정리 방식과 팀 서버에서 문을 여는 순서를 정한다. 이 리허설은 G4의 「미검증」 목록을 실제 Hermes로 잰다.
> 이 문서의 명령은 `scripts/check_docs_commands.py`의 runbook 검사 대상이다. `<…>`는 자리 표시이고 값(키·비밀번호·토큰·주소)은 어디에도 쓰지 않는다.

## 0. 먼저 읽을 것

- **잰다**: ① 모델이 `MEDIA:`를 실제로 쓰는지 ② 5 MiB·시간 한도 안에서 그림이 들어오는지 ③ 구독 한도 오류의 모양 ④ 실제 Hermes가 자기 주소를 내려받는지(Hermes의 사설 주소 필터가 통과시키는지, 리디렉션 없이 받는지) ⑤ 모델이 주소를 `reference_image_urls`가 아니라 `image_url`에 넣는지 ⑥ Codex `images/edits`가 이 사진을 받아들이는지. 덧붙여 리허설 B가 ADR-0218 §8 H5 권장안(단색 배경 지우기)이 쓸 수 있는지를 미리 잰다.
- **쓰지 않는다**: `hermes-kwak`·`oort-team`·Railway·운영 env, 실제 사람 사진(합성 그림만), 다른 프로젝트의 컨테이너·볼륨, `pkill`·이름 패턴 kill·`rm -rf`. 자격 값·키·토큰·그림 주소는 출력하지도 기록하지도 않는다.
- **구독 사용량**: 그림은 최대 12장이다(계획 11장 이하: 1단계 2장·2단계 6장·대조 1장·다시 시도 여유). 한도 오류가 나면 거기서 멈추고 모양만 적는다. 일부러 한도를 소진하지 않고 재시도로 밀어붙이지 않는다.
- **막힘이 둘 있다.** (A) Hermes는 사설·루프백 주소를 받아 오지 않으므로 로컬 값으로는 사진 편집 길이 열리지 않는다 → §3의 임시 공개 주소. (B) Codex 로그인 파일을 복사해 쓰면 owner의 Codex 로그인을 풀 수 있다 → §5의 기기 코드 로그인.
- **이 리허설이 증명하는 구성**은 저장소 기본 설정의 Hermes + 호스팅 문이다. 팀 서버의 연결 모드 Hermes(`hermes-kwak`)는 그림 도구가 없어 이 리허설로 잴 수 없다(§11).

## 1. 이름·포트·격리

| 항목 | 값 | 비고 |
|---|---|---|
| compose 프로젝트 | `oort-rehearsal-4931` | 컨테이너 이름은 `oort-rehearsal-4931-<서비스>-1` |
| Hermes 컨테이너 | `oort-rehearsal-4931-hermes-1` | 이미지는 compose `hermes`·`infra/railway/railway.json`의 `hermes`와 같은 digest `nousresearch/hermes-agent@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919`(§2가 대조한다) |
| 볼륨 | `oort-rehearsal-4931-hermesdata`, `oort-rehearsal-4931-pgdata` | `down -v`로 함께 지워진다 |
| 이미지 태그 | `oort:rehearsal-4931` | `MOMO_RUST_IMAGE`로 지정하는 `--local-build` 전용 태그. 다른 스택의 `oort:local`을 덮어쓰지 않는다 |
| 호스트 포트 | 웹 18688, api 18680, Centrifugo 18600, 통과 프록시 18699 | 전부 `127.0.0.1`. 사용 중이면 §2에서 바꾼다. **Hermes는 호스트 포트를 열지 않는다**(공유 compose의 설계, 점검은 `docker exec`) |
| env 파일 | `<scratch>/rehearsal-4931.env` | `SELF_HOST_ENV_FILE`로 지정(저장소 밖). 소유자 비밀번호·API 키가 들어 있어 커밋하지 않는다 |
| `<scratch>` | 이번에 새로 만든 폴더(저장소 밖) | 부록 스크립트·합성 그림·PID 파일·로그 |

## 2. 시작 전 점검

```sh
colima status
for port in 18688 18680 18600 18699; do lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && echo "사용 중: $port"; done
docker ps -a --filter label=com.docker.compose.project=oort-rehearsal-4931 --format '{{.Names}}'
docker volume ls --format '{{.Name}}' | grep '^oort-rehearsal-4931-' || echo "남은 볼륨 없음"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -x 'oort:rehearsal-4931' || echo "전용 이미지 태그 없음"
grep -o 'nousresearch/hermes-agent@sha256:[0-9a-f]*' infra/rust/docker-compose.rust.yml infra/railway/railway.json
cloudflared --version
python3 -I -c 'import PIL; print(PIL.__version__)'
```

컨테이너·볼륨이 남아 있으면 멈추고 §10으로 먼저 정리한다. 두 파일의 digest가 다르면 멈추고 보고한다. 빌드하는 트리는 v0.1.41 후보(승격 대상 SHA)여야 하고 결과표에 커밋 SHA를 적는다. 스크립트는 부록 A~E의 코드 블록을 `<scratch>`에 저장해 쓴다.

## 3. 막힘 A — Hermes는 로컬 주소를 받아 오지 않는다

**고정 소스 근거** (Hermes 고정 commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`, 실행하지 않고 읽었다).

- 그림 도구가 원본 주소를 내려받기 전에 `is_safe_url`을 거친다(`plugins/image_gen/openai-codex/__init__.py:124-132`). 이 함수는 http(s)만 받고 이름을 풀어 나온 **모든** 주소를 검사해, 사설·루프백·링크로컬·예약·멀티캐스트·미지정 주소와 `100.64.0.0/10`을 막는다. 이름 풀이가 실패해도 막는다(`tools/url_safety.py:276-283,339-396`). 받는 연결도 연결 시점에 다시 검사한다(`create_ssrf_safe_client`).
- 이 필터를 끄는 스위치(`HERMES_ALLOW_PRIVATE_URLS`·`security.allow_private_urls`·`security.fake_ip_ranges`·`*_PROXY`)는 `infra/hermes/lockgate.py`가 기동 전에 거절한다(ADR-0203 I1-8·I1-9, I2). **쓰지 않는다.**
- 그림 가드 플러그인이 받는 출처 모양은 `https://<소문자 호스트 2라벨 이상>[:포트]`뿐이다(`:443`·IP·단일 라벨 거절, ADR-0203 I2). 그래서 `localhost`나 루프백 값은 모양부터 거절되고, 모양만 맞춘 로컬 값(예: `*.localhost`)은 이름이 풀리지 않거나 루프백으로 풀려 Hermes의 필터에 막힌다.

결론: `OORT_SELF_MEDIA_ORIGIN`은 **공개 주소로 풀리는 https 호스트**여야 한다. 이 맥에서는 임시 공개 주소를 만든다. 방법은 저장소가 개발·임시용으로 이미 적어 둔 cloudflared quick tunnel이다(`docs/SELF_HOST_AGENT.md` §3.3.11: 주소가 프로세스마다 바뀌고 1015 속도 제한이 있으며 운영용이 아니다). 보안 규칙 안에서 하는 방법은 아래와 같다.

- 터널이 바라보는 곳은 로컬 스택의 api 전체가 아니라 **통과 프록시**(부록 A)다. 프록시는 `GET /v1/self-media/<uuid>/<토큰 43자>` 한 모양만 로컬 엣지로 전달하고 나머지는 전부 404를 돌려주며, 리디렉션을 따라가지 않고 요청 경로(토큰)를 기록하지 않는다.
- 사진 주소 토큰은 5분·1회용이고 로컬 스택에는 합성 그림뿐이다. 터널은 이 리허설 동안만 켠다.
- 프록시와 터널은 호스트 프로세스라 **PID를 파일에 적어 두고 그 PID로만** 끝낸다.

```sh
python3 -I <scratch>/selfmedia_proxy.py http://127.0.0.1:18688 18699 & echo $! > <scratch>/proxy.pid
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:18699 > <scratch>/tunnel.log 2>&1 & echo $! > <scratch>/tunnel.pid
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' <scratch>/tunnel.log | head -1
```

출력된 주소를 셸 변수 `ORIGIN`에 둔다(소문자, 끝 슬래시 없음, 포트 없음. 이 형태가 가드와 워커의 형식 규칙을 모두 만족한다). 요청 경로를 찍는 디버그 로그 수준은 켜지 않는다.

- 터널 프로세스를 다시 띄우면 주소가 바뀐다. env 파일의 `OORT_SELF_MEDIA_ORIGIN` 줄을 새 값으로 고치고 `scripts/self_host_env.sh --compose up -d --wait`를 다시 부른다(env가 바뀐 agent-worker·hermes가 다시 만들어진다. Hermes 볼륨, 곧 로그인은 유지된다).
- 1015·429가 나오면 멈춘다. 재시도로 한도를 넓히지 않는다.
- 맥에서 가짜 IP DNS(터널형 VPN 등)가 켜져 있으면 공개 호스트가 `198.18.0.0/15`로 풀려 Hermes가 막을 수 있다. §4의 확인이 `False`이면 그것부터 끈다. 우회 스위치는 쓰지 않는다.

## 4. 스택 올리기

```sh
export COMPOSE_PROJECT_NAME=oort-rehearsal-4931 DB_VOLUME_NAME=oort-rehearsal-4931-pgdata
export MOMO_WEB_PORT=18688 MOMO_RUST_API_PORT=18680 CENT_HOST_PORT=18600 MOMO_RUST_IMAGE=oort:rehearsal-4931
export SELF_HOST_ENV_FILE=<scratch>/rehearsal-4931.env
scripts/self_host_env.sh --local-build --with-agents
printf '%s\n' "OORT_SELF_MEDIA_ORIGIN=$ORIGIN" >> "$SELF_HOST_ENV_FILE"
scripts/self_host_env.sh --compose up -d --wait
scripts/self_host_env.sh --compose ps
```

`--with-agents`가 같은 서버 Hermes에 필요한 값(`COMPOSE_PROFILES`·`HERMES_API_KEY`·`HERMES_BASE_URL`·`AGENT_PROVIDER_*`·`OORT_COHOSTED_AGENT_TOOLS_LOCKED`·로그인 중계 키)을 env 파일에 쓰고, compose가 고정 이미지 `hermes`를 공식 시작 명령(복사 → `lockgate.py gate` → `lockgate.py report` → 게이트웨이)으로 띄운다. `HERMES_MEDIA_DELIVERY_STRICT`는 compose가 리터럴 `1`로 넣으므로 따로 두지 않는다. **`OORT_SELF_MEDIA_ORIGIN`과 `HERMES_MEDIA_DELIVERY_STRICT`는 Hermes 볼륨의 `.env`에 절대 두지 않는다**(게이트와 `report`가 이름만으로 거절한다). `OORT_HOSTED_MEDIA_STRICT`는 아직 두지 않는다: 문은 닫힌 채 시작한다(§7.2에서 연다). `MOMO_RUST_IMAGE`는 이 리허설 전용 태그라 다른 스택이 쓰는 `oort:local`을 덮어쓰지 않는다(이미 같은 SHA로 만든 이미지가 있으면 그것을 이 태그로 `docker tag`해서 쓴다. 빌드가 길다). **이후 모든 `--compose` 호출(§6~§10)은 위 `export`가 살아 있는 같은 셸에서 부르고, 새 셸이면 `SELF_HOST_ENV_FILE`부터 다시 `export`한다.** 그렇지 않으면 스크립트가 기본 `infra/rust/local.secrets.env`로 돌아가 다른 스택을 만진다.

```sh
HC="$(docker ps --filter label=com.docker.compose.project=oort-rehearsal-4931 --filter label=com.docker.compose.service=hermes --format '{{.Names}}')"; echo "$HC"
docker logs "$HC" 2>&1 | grep -E '^LOCKGATE |^LOCKREPORT ' | cut -c1-400
scripts/self_host_env.sh --compose logs agent-worker | grep -c '호스팅 문 꺼짐'
docker exec -u hermes -e HERMES_HOME=/opt/data "$HC" /opt/hermes/.venv/bin/python -c 'import sys; sys.path.insert(0, "/opt/hermes"); from tools.url_safety import is_safe_url; print(is_safe_url(sys.argv[1]))' "$ORIGIN/v1/self-media/"
```

통과 신호: `LOCKGATE` 줄에 `"ok": true`와 `image_guard`의 `"media_strict": true`, `LOCKREPORT`가 깨끗함, 서비스가 healthy, 「호스팅 문 꺼짐」이 1줄(문이 닫힌 채 시작한 것이 정상), 마지막 줄이 `True`(Hermes가 쓰는 같은 함수가 이 공개 주소를 받아 온다고 본다). 마지막 줄이 `False`이면 §3의 마지막 항목을 보고 멈춘다.

## 5. 막힘 B — Codex 로그인은 복사하지 않고 기기 코드로 넣는다

**Hermes가 실제로 읽는 자격 위치**(고정 소스): `$HERMES_HOME/auth.json`(이 컨테이너에서는 `/opt/data/auth.json`)의 `providers.openai-codex.tokens`(`access_token`·`refresh_token`)이다(`hermes_cli/auth.py:490-494`, `hermes_cli/auth_codex.py:111-130`). 그림 도구는 자격 풀을 먼저 보고 없으면 이 파일의 접근 토큰을 읽으며 만료된 JWT는 건너뛴다(`agent/auxiliary_client.py:2109-2149`). 접근 토큰은 만료 120초 전부터 갱신한다(`hermes_cli/auth_constants.py:96`). Codex CLI의 파일(`$CODEX_HOME/auth.json`, 기본 `~/.codex/auth.json`)은 Hermes가 로그인 때 「가져올까요」라고 물을 때와 복구 때만 읽는다(`auth_codex.py:217-250,567-586`).

**복사하지 않는 이유**(고정 소스): Hermes 자신이 이렇게 적는다 — Codex·Claude의 OAuth 갱신 토큰은 한 번만 쓰이고 바뀌므로, Hermes가 CLI의 토큰 쌍을 빌리면 둘이 한 토큰 가족을 공유하고 **먼저 갱신하는 쪽이 다른 쪽을 로그아웃시킨다**(`agent/credential_sources.py:32-38`). 읽기 전용 마운트는 원본 파일을 지킬 뿐 토큰 가족을 지키지 못한다: Hermes는 가져온 토큰을 자기 볼륨에 저장하고 거기서 갱신한다. 그래서 Hermes도 가져오기보다 별도 로그인을 권한다(`auth_codex.py:963-967`).

**기본 방법(권장)**: 시험 컨테이너 안에서 기기 코드로 로그인한다. 저장소의 로그인 중계가 쓰는 고정 명령과 같다(`infra/hermes/login_relay.py:57,368`). 새 토큰 한 벌이 시험 볼륨 안에만 생기고 owner의 Codex CLI·데스크탑 로그인과 가족이 다르다. planner는 출력의 링크와 코드를 owner에게 그대로 건넨다(owner 손은 링크를 열어 코드를 입력하는 것뿐이다).

```sh
docker exec -i -u hermes -e HOME=/opt/data -e HERMES_HOME=/opt/data -e PYTHONUNBUFFERED=1 -e NO_COLOR=1 "$HC" /opt/hermes/.venv/bin/hermes auth add openai-codex --type oauth --no-browser
```

명령은 owner가 승인하면 끝난다(코드 수명은 짧다. 429가 나오면 Hermes가 기다리라고 알려 준다). 성공 확인은 §6의 첫 줄(`openai-codex logged in: True`)이다. oort의 인스턴스 운영자 라우트 `model-login`도 같은 명령을 돌린다(로그인 중계, ADR-0203 증보 2026-10-19). 어느 쪽이든 성공 확인은 이 문서의 §6이 한다.

**복사가 꼭 필요할 때만**(owner가 승인할 수 없는 때). ① 접근 토큰의 남은 수명이 30분 이상인지 **분 단위 숫자만** 출력해 본다(JWT `exp` 클레임, 토큰은 출력하지 않는다). ② 원본 `auth.json`은 읽기만 한다: 새 폴더에 `cp`로 사본 한 파일만 만들고(권한 600) 그 사본만 컨테이너의 `/tmp/codex-src/auth.json`으로 올린다(`docker cp`, root 소유로 올라가므로 `docker exec -u root`로 `chown hermes`한다). compose 컨테이너는 마운트를 나중에 더할 수 없어 읽기 전용 마운트 대신 이렇게 하고 끝나면 지운다. ③ 위 로그인 명령(`-i`가 있어야 질문에 답할 수 있다)에 `-e CODEX_HOME=/tmp/codex-src`를 더하고 가져오기 질문에 `y`를 입력한다. ④ owner에게 먼저 알린다: 이 경로는 owner의 Codex CLI·데스크탑 로그인이 풀릴 수 있어 다시 로그인해야 할 수 있다. ⑤ 끝나면 컨테이너의 사본과 호스트의 사본을 지우고 확인한다(§10).

## 6. 1단계 — Hermes 단독 (oort 없이)

원인을 가르려고 oort를 거치지 않고 Hermes에 한 번 묻는다(부록 B, 그림 한 장). 키는 컨테이너 환경에서 읽고 출력하지 않는다.

```sh
docker exec -i -u hermes "$HC" /opt/hermes/.venv/bin/python - < <scratch>/hermes_probe.py
```

| 줄 | 읽는 것 | PASS |
|---|---|---|
| `options status … logged in` | Codex 로그인과 모델 목록 | `True`, 모델 1개 이상 |
| `chat status … seconds` | HTTP와 걸린 시간 | 200, 100초 이하 |
| `inline pictures … MEDIA lines left` | 모델이 `MEDIA:`를 실제로 썼고 Hermes가 그림 주소로 바꿨는가 | 그림 1, 남은 `MEDIA:` 줄 0 |
| `picture png … bytes … base64 chars` | 그림 크기와 가로세로 | 5 MiB(5,242,880) 이하, base64 6,990,508자 이하, 응답 전체 12 MiB(12,582,912) 이하 |
| `usage` | 토큰 수(참고) | 기록만 한다 |

마감 근거: 워커의 공급자 호출 마감은 120초(`PROVIDER_REQUEST_TIMEOUT_MS` 기본 120,000 ms)이고, 시간 초과는 시도마다 새 그림을 만든 뒤 두 번째 시도에서 실패 카드로 끝난다. 그래서 100초를 넘으면 여유가 20초 아래다. 같은 질문을 한 번 더 해 분산을 본다(그림 최대 2장). 1단계가 PASS가 아니면 2단계로 가지 않는다.

## 7. 2단계 — 호스팅 문 전체

### 7.1 문이 닫힌 채 oort 쪽 준비 (그림을 쓰지 않는다)

1. 브라우저로 `http://127.0.0.1:18688`을 열고 owner로 로그인한다(이메일과 비밀번호는 env 파일의 `MOMO_INITIAL_OWNER_EMAIL`·`MOMO_INITIAL_OWNER_PASSWORD`에 있다. 화면에 찍지 않는다).
2. 인스턴스 운영자 화면에서 같은 서버 Hermes를 연결한다(ADR-0203 D3·D4, `docs/SELF_HOST_AGENT.md`의 co-hosted Hermes 절). 모델은 `openai-codex` 목록에서 고른다(ADR-0203 증보 2026-10-20 M2·M3). 핀 종류가 `operator_env`여야 하고 §8의 SQL (0)으로 확인한다.
3. 합성 그림을 만든다(부록 C): `python3 -I <scratch>/make_synthetic.py <scratch>/synthetic` (새 폴더가 없을 때만 만든다).
4. (선택, 그림 1장 소비) **대조 C1**: 문이 닫힌 지금 합성 그림 한 장으로 「AI와 만들기」를 한 번 보낸다. 카드 없이 평소 답이 와야 한다(문 닫힘 = 평소 턴). #4908 뒤로는 답에 그림 주소가 있었다면 그 자리에 안내 문장 한 줄이 서고 base64는 남지 않아야 한다.

### 7.2 문 열기

```sh
printf '%s\n' 'OORT_HOSTED_MEDIA_STRICT=1' >> "$SELF_HOST_ENV_FILE"
scripts/self_host_env.sh --compose up -d --wait
scripts/self_host_env.sh --compose logs agent-worker | grep -c '호스팅 문 꺼짐'
```

env가 바뀐 agent-worker만 다시 만들어지고 새 컨테이너의 로그만 남으므로 마지막 `grep -c`는 **0**이어야 한다(문이 열린 시작). 1이면 값이 정확히 `1`로 들어가지 않은 것이다. Hermes 쪽 STRICT(`media_strict: true`)는 §4에서 이미 확인했다. 순서(Hermes 먼저, 워커는 마지막)는 ADR-0218 G3.7 (b)와 `docs/SELF_HOST_AGENT.md`의 기존 프로젝트 갱신 순서를 따른다.

### 7.3 실행표 (한 번에 하나씩, 결과를 읽고 다음으로)

웹의 팀 이모지 패널 「＋」 → 「AI와 만들기」에서 그림·움직임·메모를 고르고 만든 Hermes 에이전트에게 보낸다(양식이 그 에이전트와의 DM을 대신 연다). 메모(B 줄)는 `배경은 피사체에 쓰이지 않은 한 가지 단색으로, 피사체는 가운데에 가장자리에서 떨어지게 그려 주세요.`로 고정한다(요청 메모 500자 안). 각 실행 뒤 카드를 **거절**해 대기 카드를 비운다(R2에서만 후보 하나를 승인해 등록까지 본다). 같은 사람의 대기 카드가 있으면 다음 요청이 「같은 사람에게 승인을 기다리는 카드가 있어요」로 막힌다.

| # | 그림 | 움직임 | 메모 | 보는 것 |
|---|---|---|---|---|
| R1 | `t1-flat.png` | 움직임 없이 | 없음 | 문 전체의 첫 통과: 그림 도착·카드·시간 |
| R2 | `t1-flat.png` | 통통 | 없음 | GIF 후보 1개(16프레임·40ms), 승인 1건으로 등록까지 |
| R3 | `t1-flat.png` | 두근두근 + 반짝 | 없음 | 한 장에서 후보 2개(12프레임·50ms, 20프레임·50ms) |
| R4 | `t1-flat.png` | 움직임 없이 | B | 리허설 B: 모델이 단색 배경으로 그리는가 |
| R5 | `t2-gradient.png` | 움직임 없이 | B | B: 입력 배경이 그라데이션이어도 |
| R6 | `t3-clutter.png` | 움직임 없이 | B | B: 어수선한 입력, 피사체가 가장자리에 닿은 입력 |

## 8. 잴 것과 PASS 기준

실행마다 아래를 읽는다. SQL은 psql 도우미 `Q`로 부른다(테스트 DB의 기본 역할은 RLS를 건너뛰므로 워크스페이스를 지정하지 않는다).

```sh
Q() { scripts/self_host_env.sh --compose exec -T postgres psql -U momo -d momo -At -c "$1"; }
scripts/self_host_env.sh --compose logs agent-worker | grep -E 'hosted expression|호스팅 문' | cut -c1-240
docker exec "$HC" ls -l /opt/data/cache/generated/images
docker exec -i -u hermes "$HC" /opt/hermes/.venv/bin/python - < <scratch>/hermes_evidence.py
```

```sql
-- (0) 연결 확인: 핀 종류가 operator_env이고 모델이 openai-codex 쪽인가
select kind, model_provider, model_id from agent_provider_pin;
-- (1) 걸린 시간: 사람이 보낸 요청에서 에이전트의 다음 메시지까지(type이 approval_request면 카드)
select h.seq, to_char(h.created_at, 'HH24:MI:SS') as sent, a.type, round(extract(epoch from (a.created_at - h.created_at))::numeric, 1) as seconds
from message h
join lateral (select type, created_at from message where channel_id = h.channel_id and seq > h.seq and author_member_id <> h.author_member_id order by seq limit 1) a on true
where h.type = 'text' and h.body like '이 사진으로%'
order by h.channel_id, h.seq;
-- (2) 에이전트 본문에 그림·MEDIA·요청 표기가 남았나(leaked는 0), 가장 긴 본문
select count(*) filter (where body like '%data:image/%' or body like '%MEDIA:%' or body like '%oort-expression%') as leaked, max(length(body)) as longest_body_chars
from message where author_member_id in (select id from member where kind = 'agent');
-- (3) outbox의 가장 큰 payload
select max(octet_length(payload::text)) as largest_outbox_payload_bytes from outbox;
-- (4) 사진 주소 토큰: 만든 수·쓴 수·안 쓰고 만료된 수
select count(*) as minted, count(used_at) as used, count(*) filter (where used_at is null and expires_at < now()) as expired_unused from self_media_token;
-- (5) 후보 그림(후보마다 small·large·thumb 3행)
select d.name, i.variant, i.mime, octet_length(i.bytes) as bytes, i.width, i.height, i.frame_count, i.duration_ms
from expression_draft d join expression_draft_image i on i.workspace_id = d.workspace_id and i.draft_id = d.id
order by d.id, i.variant;
-- (6) 등록된 표현 수(승인하기 전에는 0)
select count(*) as registered from expression;
```

**안전 기준** (하나라도 어긋나면 FAIL: 호스팅 문을 열지 않는다)

| # | 기준 | 읽는 곳 |
|---|---|---|
| S-1 | `LOCKGATE ok=true`와 `media_strict: true`, 열린 뒤 워커 시작 로그에 「호스팅 문 꺼짐」 없음 | §4 로그, §7.2 |
| S-2 | 모델의 최종 답에 쓴 `MEDIA:` 경로가 모두 Hermes 그림 폴더 안(`all under the generated-images dir: True`) | 부록 E |
| S-3 | `leaked`가 0, 가장 긴 에이전트 본문 20,000자 이하, outbox 가장 큰 payload 100,000바이트 이하(MiB 단위 base64가 메시지·outbox에 실리지 않는다) | SQL (2)(3) |
| S-4 | 토큰: `used`가 `minted` 이하이고 한 요청에 하나만 쓰였다. 같은 주소를 두 번 쓰는 길은 없다 | SQL (4) |
| S-5 | 사진이 있는 호출은 `image_url`만 주고 `reference_image_urls`는 주지 않았다. 도구 결과에 `[oort-image-guard]` 거절이 없다 | 부록 E |
| S-6 | 승인 전에는 등록이 없다(`registered`가 R2 승인 전까지 0) | SQL (6) |

**기능 기준**

| # | 기준 | 읽는 곳 |
|---|---|---|
| F-1 | R1~R6 중 5건 이상이 후보 카드로 끝난다(나머지는 닫힌 실패 카드나 평소 답이어도 사유를 적는다) | SQL (1), 로그 |
| F-2 | 성공한 건의 걸린 시간 중앙값 60초 이하, 최대 100초 이하 | SQL (1) |
| F-3 | 모델이 만든 PNG는 모두 5 MiB 이하, 후보 GIF는 large 1 MiB·small 256 KiB 이하이고 프레임·지연이 G3.3과 같다(통통 16×40ms, 두근 12×50ms, 반짝 20×50ms) | `ls -l`, SQL (5) |
| F-4 | 5건 이상이 `modality: image`와 `input_image_count: 1`(= 실제 Hermes가 자기 주소를 받아 갔고 Codex가 편집했다) | 부록 E |
| F-5 | 합성 그림은 `subjectMemberId:null`이고 카드에 「원본 사진」 줄이 보인다, 카드가 보이는 그림이 실제 후보다 | 화면 |

**판정**: PASS는 안전 S-1~S-6 전부와 기능 F-1~F-4 전부다. 안전이 전부 맞고 F-1만 모자라면(3~4건) 조건부: 지시문을 보강한 뒤 같은 표를 다시 잰다. F-2가 모자라면 그림 등급·`PROVIDER_REQUEST_TIMEOUT_MS` 조정이 필요한 owner 결정이며 이 리허설은 값을 바꾸지 않는다. 안전이 하나라도 어긋나면 FAIL이고 문은 열지 않는다. 한도 오류(구독)는 일부러 만들지 않고 자연히 나왔을 때만 부록 E가 읽는 `error_type`·`error` 줄로 모양을 적는다.

**리허설 B (권장안 사전 측정)**: R4~R6마다 후보의 large PNG를 꺼내 가장자리 단색도를 잰다.

```sh
Q "select id, name from expression_draft order by id"
Q "select encode(bytes, 'hex') from expression_draft_image where variant = 'large' and draft_id = '<draft id>'" | xxd -r -p > <scratch>/large-<run>.png
python3 -I <scratch>/measure_border.py <scratch>/large-<run>.png
```

PASS-B는 R4~R6 중 2건 이상이 `possible`(가장자리 균일 98% 이상, 이어진 배경 20~95%)이다. 1건 이하면 지시문만으로는 부족하다는 뜻이므로 ADR-0218 §8 H5를 owner에게 다시 올린다(리허설이 방향을 바꿀 수 있다). 수치(16·98%·20~95%)는 초안이고 S5가 확정한다.

결과는 이슈 #4931의 PR 본문에 표로 적는다(열: 실행·그림·움직임·결과·걸린 초·Hermes PNG 바이트·`modality`/`input_image_count`·후보 GIF 바이트·프레임·지연·비고, 맨 위에 커밋 SHA·Hermes digest). 그림·토큰·주소·키는 붙이지 않는다.

## 9. 실패 모양 읽는 법

| 보이는 것 | 뜻 | 확인 |
|---|---|---|
| 사진을 보냈는데 평소 답만 오고 모델이 `MEDIA:` 글자나 경로를 그대로 말한다 | 문이 닫혔다(`OORT_HOSTED_MEDIA_STRICT`가 정확히 `1`이 아님) | 워커 시작 로그의 「호스팅 문 꺼짐」 |
| 평소 답만 오고 카드가 없다 | 요청 표기가 거절됐다: 펜스 블록이 여럿(`Several`)·닫히지 않음(`Unterminated`)·한 줄이 아님(`NotOneLine`)·JSON 모양 오류(`Shape`)·값 오류(`Value`) | 로그 `hosted expression request block refused`의 `refused` |
| 「그림을 만들지 못했어요」(`generation_failed`) | 그림 없음, 구독 한도, 시도 2번 소진, 응답 12 MiB 초과, 그림이 5 MiB 초과라 Hermes가 `MEDIA:`를 주소로 바꾸지 않음 | 로그 `its attempts are spent`·`over the size limit`, 부록 E |
| 「이 그림에는 움직임을 입힐 수 없어요」(`assembly_source_invalid`) | 그림이 2장 이상이거나 형식·치수가 안 맞음 | 로그 `hosted expression failure card raised`의 `code` |
| 「그림이 너무 커서…」(`assembly_source_too_large`) | base64가 6,990,508자 초과 | 부록 E의 `pixel_size`·`ls -l` |
| 도구 결과에 `Image URL failed the SSRF safety check` | Hermes가 이 출처를 사설로 봤다: 공개 주소가 아니거나 가짜 IP DNS | §4의 `is_safe_url` 줄, 부록 E |
| 도구 결과에 `[oort-image-guard]` | 모델이 주소를 `reference_image_urls`나 다른 모양으로 넣었다 | 부록 E의 `reference_image_urls given` |
| 도구 결과에 `Codex images API returned HTTP <상태>` | 구독 한도나 백엔드 오류. 상태와 문구가 한도 오류의 모양이다 | 부록 E의 `error_type`·`error` |
| 도구 결과에 `No Codex/ChatGPT OAuth credentials available` | 로그인이 안 돼 있다(이 경우 그림 도구가 모델에게 안 보이는 것이 정상: 「이 에이전트는 그림을 만들 수 없어요」) | §6 첫 줄 |
| 카드 대신 「승인을 기다리는 카드가 이미 많아요」·「같은 사람에게 …」 | 대기 카드 상한 | 카드를 거절해 비운다 |

## 10. 끝낸 뒤 정리와 확인

```sh
kill "$(cat <scratch>/tunnel.pid)"; kill "$(cat <scratch>/proxy.pid)"
kill -0 "$(cat <scratch>/tunnel.pid)" 2>/dev/null && echo "터널이 남았다" || echo "터널 종료 확인"
kill -0 "$(cat <scratch>/proxy.pid)" 2>/dev/null && echo "프록시가 남았다" || echo "프록시 종료 확인"
scripts/self_host_env.sh --compose down -v
```

`down`이 워크트리 스택을 다른 체크아웃으로 오인하고 거절하면(#1650) 같은 프로젝트를 직접 지운다.

```sh
docker compose --project-name oort-rehearsal-4931 --env-file <scratch>/rehearsal-4931.env -f infra/rust/docker-compose.rust.yml -f infra/rust/docker-compose.rust.build.yml -f infra/rust/local.override.yml down -v --remove-orphans
```

(이 파일 셋은 `scripts/self_host_env.sh --compose`가 `--local-build` 스택에 쓰는 것과 같다. 에이전트 프로필은 env 파일의 `COMPOSE_PROFILES`를 따르므로, 아래 확인에서 `hermes`가 남아 있으면 같은 명령을 `--profile agents`를 더해 다시 부른다.) 지운 것을 확인한다(전부 비어야 한다).

```sh
docker ps -a --filter label=com.docker.compose.project=oort-rehearsal-4931 --format '{{.Names}}'
docker volume ls --format '{{.Name}}' | grep '^oort-rehearsal-4931-' || echo "볼륨 없음"
docker network ls --format '{{.Name}}' | grep '^oort-rehearsal-4931' || echo "네트워크 없음"
docker image rm oort:rehearsal-4931
```

남은 것이 있으면 이름을 정확히 지정해서만 지운다(`docker rm -f <컨테이너>`·`docker volume rm <볼륨>`·`docker network rm <네트워크>`). 이름 패턴으로 한꺼번에 지우지 않는다. 이미지 태그는 이 리허설이 만든 `oort:rehearsal-4931` 하나만 지운다.

- **자격**: 기본 방법(기기 코드)의 토큰은 Hermes 볼륨(`oort-rehearsal-4931-hermesdata`) 안에만 있어 위 `down -v`로 끝난다. 복사 방법을 썼다면 컨테이너 안의 `/tmp/codex-src`는 컨테이너와 함께 사라지고, 호스트에 만든 사본 파일은 경로를 정확히 지정해 `rm`으로 지운 뒤 `ls`로 없음을 확인한다. 저장소 밖 `<scratch>`에 토큰 문자열이 남지 않았는지는 `grep -rl`로 **파일 이름만** 본다(내용 출력 없음).
- `<scratch>`의 env 파일(비밀번호·API 키)·합성 그림·추출한 PNG·터널 로그·PID 파일을 지운다(파일 하나씩 정확한 경로로). 저장소에는 아무것도 남지 않아야 한다: `git status --short`가 비어 있다.
- 기기 코드 로그인 세션이 서버 쪽에서 폐기되는지는 **미확인**이다. owner가 원하면 계정의 보안 설정에서 로그인 기기를 정리한다(화면 위치는 미확인).
- 결과를 PR 본문에 적은 뒤 이슈 #4931에 링크한다.

## 11. 이 리허설 다음 — 팀 서버에서 문을 열기 전

ADR-0218 §8 H7이 정본이다. 요약은 이렇다.

1. 운영 점검(코디네이터 전달): 팀 서버의 공동 Hermes `hermes-kwak`은 모델 선택과 Gmail·캘린더·드라이브 읽기 연결을 더한 연결 모드이고, 새 판 시작 명령이 기본 설정 해시만 받아 v0.1.41에서 Hermes를 올리지 못했다. 고치는 일은 #4935다.
2. **연결 모드 Hermes에는 그림 도구가 없다**(`infra/hermes/lockgate.py:120,202-204,222-223`, ADR-0203 I3). #4935가 끝나도 연결 모드 Hermes로는 그림이 안 만들어지고, 문을 열면 사진이 붙은 모든 대화가 비스트리밍 문 턴이 된다. 그래서 이 리허설의 PASS(기본 설정)만으로 팀 서버의 문을 열지 않는다. 그림 도구를 어느 Hermes가 갖는지는 owner 결정이다(ADR-0218 §8 H7).
3. #4934(api 볼륨이 서비스 하나에만 붙어 agent-worker가 첨부 사진을 못 읽음)는 **사진 이모티콘의 원본 사진 주소와 상관없다.** 주소를 내주는 것은 api(`server-rust/bins/momo-server/src/routes/self_media.rs`)이고 워커는 토큰 행만 만든다. 워커의 첨부 읽기는 프로필 사진 제안 하나뿐이다.
4. 순서: #4935 착륙 → 그림 도구 구성 결정 → 새 판 Hermes 배포(`HERMES_MEDIA_DELIVERY_STRICT=1`, 로그의 `media_strict: true`) → 리허설 PASS(구성이 다르면 같은 표를 그 구성으로) → `OORT_SELF_MEDIA_ORIGIN`(agent-worker·hermes 같은 값) → 마지막에 `OORT_HOSTED_MEDIA_STRICT=1`. 되돌리기는 `OORT_HOSTED_MEDIA_STRICT`를 지워 문을 닫는 것이 첫째이고(평소 턴으로 돌아간다), 둘째로 두 서비스의 `OORT_SELF_MEDIA_ORIGIN`을 지우면 사진 주소가 만들어지지 않는다(이미 만든 토큰은 5분 안에 죽는다).

## 12. 이 리허설이 닫지 않는 것

- 연결 모드 Hermes(그림 도구 없음)와 팀 서버의 실제 구성, Railway의 실제 기동·시작 명령 체크섬 사슬.
- 구독 한도 오류의 모양(자연 발생 때만), 다중 프로필 턴의 `gateway.strict`와 형제 변수(`HERMES_MEDIA_ALLOW_DIRS`·`HERMES_MEDIA_TRUST_RECENT_*`, #4886).
- 실제 사람 사진과 얼굴 규칙(당사자 승인)의 사람 동작, 폰·데스크탑 화면, 오래 쓰는 터널의 안정성.
- Hermes `state.db`의 표·열 이름(부록 E)은 소스로 추정했을 뿐 실제 파일을 열어 보지 못했다. 스크립트가 실패하면 `.schema`를 보고 고친다.

## 부록 A. 통과 프록시

```python
#!/usr/bin/env python3
"""리허설용 통과 프록시: GET /v1/self-media/<uuid>/<토큰 43자> 하나만 로컬 엣지로 전달하고 나머지는 모두 404.
사용: python3 -I selfmedia_proxy.py <로컬 엣지 주소 http://127.0.0.1:포트> <이 프록시가 듣는 루프백 포트>"""
import http.server
import re
import socketserver
import sys
import urllib.error
import urllib.request

UPSTREAM = sys.argv[1].rstrip("/")
PORT = int(sys.argv[2])
ALLOWED = re.compile(r"/v1/self-media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{43}")
BODY_CAP = 6 * 1024 * 1024  # 사진은 5 MiB 이하여야 한다


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 요청 경로(토큰)를 기록하지 않는다
        pass

    def _reply(self, status, ctype=None, body=b""):
        self.send_response(status)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if ALLOWED.fullmatch(self.path) is None:
            return self._reply(404)
        try:
            with OPENER.open(UPSTREAM + self.path, timeout=20) as upstream:
                body = upstream.read(BODY_CAP + 1)
                if len(body) > BODY_CAP:
                    return self._reply(502)
                return self._reply(upstream.status, upstream.headers.get("Content-Type"), body)
        except urllib.error.HTTPError as error:
            return self._reply(error.code)
        except Exception:
            return self._reply(502)

    def _deny(self):
        self._reply(404)

    do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _deny


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


Server(("127.0.0.1", PORT), Handler).serve_forever()
```

## 부록 B. Hermes 단독 점검

```python
"""Hermes 컨테이너 안에서 oort 없이 한 번 묻는다(stdlib만). 키는 컨테이너 환경에서 읽고 출력하지 않는다.
  docker exec -i -u hermes <컨테이너> /opt/hermes/.venv/bin/python - < hermes_probe.py"""
import base64
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("HERMES_PROBE_BASE", "http://127.0.0.1:8642")
KEY = os.environ["API_SERVER_KEY"]
PROVIDER = "openai-codex"
SYSTEM = ("Draw ONE sticker-style picture of a simple geometric character on a plain single-colour background "
          "with the image tool, text prompt only (no image_url). Then answer with the MEDIA: line the tool "
          "result gave, alone on its own line, and nothing else.")


def call(method, path, body=None):
    request = urllib.request.Request(
        BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.status, response.read(), time.monotonic() - started
    except urllib.error.HTTPError as error:
        return error.code, error.read(), time.monotonic() - started


status, raw, _ = call("GET", "/api/model/options")
providers = json.loads(raw).get("providers", []) if status == 200 else []
logged_in = [p for p in providers if p.get("slug") == PROVIDER and p.get("authenticated") is True]
models = logged_in[0].get("models", []) if logged_in else []
print("options status", status, "| %s logged in: %s | models: %d" % (PROVIDER, bool(logged_in), len(models)))
if not models:
    sys.exit("stop: the Codex login is not in place")
first = models[0]
model = first if isinstance(first, str) else first.get("id")
body = {"provider": PROVIDER, "model": model, "stream": False, "messages": [
    {"role": "system", "content": SYSTEM}, {"role": "user", "content": "a blue round character, one picture"}]}
status, raw, seconds = call("POST", "/v1/chat/completions", body)
print("chat status", status, "| seconds %.1f" % seconds, "| response bytes", len(raw))
try:
    data = json.loads(raw)
except ValueError:
    sys.exit("stop: the answer is not JSON")
text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
print("usage", json.dumps(data.get("usage")))
pictures = re.findall(r"data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)", text)
print("inline pictures:", len(pictures), "| MEDIA lines left in the text:", len(re.findall(r"(?m)^\s*MEDIA:", text)))
for kind, b64 in pictures:
    picture = base64.b64decode(b64)
    dims = struct.unpack(">II", picture[16:24]) if picture[:8] == b"\x89PNG\r\n\x1a\n" else None
    print("picture", kind, "| bytes", len(picture), "| base64 chars", len(b64), "| width x height", dims)
rest = re.sub(r"!\[[^\]]*\]\(data:image/[^)]*\)", "[picture]", text)
print("text without the picture:", rest[:300].replace("\n", " | "))
```

## 부록 C. 합성 그림

```python
"""합성 그림 세 장(얼굴 없는 도형 캐릭터). 실제 사람 사진은 쓰지 않는다.
사용: python3 -I make_synthetic.py <새 출력 폴더(저장소 밖)>"""
import os
import random
import sys

from PIL import Image, ImageDraw

SIZE = 1024
BLUE, BELLY = (60, 120, 220), (250, 220, 90)


def character(draw, cx, cy, r):
    ear = lambda sx: [(cx + sx * r * 0.7, cy - r * 0.8), (cx + sx * r * 0.35, cy - r * 1.35), (cx + sx * r * 0.05, cy - r * 0.95)]
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BLUE)
    draw.polygon(ear(-1), fill=BLUE)
    draw.polygon(ear(1), fill=BLUE)
    draw.ellipse([cx - r * 0.5, cy - r * 0.1, cx + r * 0.5, cy + r * 0.75], fill=BELLY)


def flat():
    image = Image.new("RGB", (SIZE, SIZE), (235, 235, 235))
    character(ImageDraw.Draw(image), SIZE // 2, SIZE // 2 + 60, 260)
    return image


def gradient():
    image = Image.new("RGB", (SIZE, SIZE))
    draw = ImageDraw.Draw(image)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        draw.line([(0, y), (SIZE, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip((255, 220, 200), (120, 170, 230))))
    character(draw, SIZE // 2, SIZE // 2 + 60, 260)
    return image


def clutter():
    rng = random.Random(4931)
    image = Image.new("RGB", (SIZE, SIZE))
    draw = ImageDraw.Draw(image)
    for y in range(0, SIZE, 64):
        for x in range(0, SIZE, 64):
            shade = 200 if (x // 64 + y // 64) % 2 else 160
            draw.rectangle([x, y, x + 63, y + 63], fill=(shade, shade, shade))
    for _ in range(40):
        x, y, r = rng.randrange(SIZE), rng.randrange(SIZE), rng.randrange(15, 60)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=tuple(rng.randrange(256) for _ in range(3)))
    character(draw, SIZE - 230, SIZE // 2, 230)  # 피사체가 오른쪽 가장자리에 닿는다
    return image


out = sys.argv[1]
os.makedirs(out)  # 이미 있으면 실패한다: 남의 폴더를 덮어쓰지 않는다
for name, make in (("t1-flat", flat), ("t2-gradient", gradient), ("t3-clutter", clutter)):
    path = os.path.join(out, name + ".png")
    make().save(path, optimize=True)
    print(name, os.path.getsize(path), "bytes")
```

## 부록 D. 가장자리 단색도 측정

```python
"""받은 그림의 가장자리가 얼마나 한 가지 색인지 잰다(배경 지우기 가능성 사전 측정).
사용: python3 -I measure_border.py <PNG 경로>   — 값(색)만 출력한다."""
import sys
from collections import deque

from PIL import Image

RING, TOL = 3, 16  # 가장자리 폭(픽셀), 같은 색으로 보는 채널 차이
image = Image.open(sys.argv[1]).convert("RGBA")
w, h = image.size
px = image.load()
edge = [(x, y) for y in range(h) for x in range(w) if x < RING or y < RING or x >= w - RING or y >= h - RING]
median = tuple(sorted(px[p][i] for p in edge)[len(edge) // 2] for i in range(4))
if median[3] < 128:
    sys.exit("already transparent at the edge: median alpha %d" % median[3])
near = lambda c: all(abs(c[i] - median[i]) <= TOL for i in range(3))
uniform = sum(1 for p in edge if near(px[p])) / len(edge)
seen = bytearray(w * h)
queue = deque(p for p in edge if near(px[p]))
for x, y in queue:
    seen[y * w + x] = 1
while queue:
    x, y = queue.popleft()
    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
        if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and near(px[nx, ny]):
            seen[ny * w + nx] = 1
            queue.append((nx, ny))
keyed = sum(seen) / (w * h)
kept = [(i % w, i // w) for i in range(w * h) if not seen[i]]
bbox = (min(x for x, _ in kept), min(y for _, y in kept), max(x for x, _ in kept), max(y for _, y in kept)) if kept else None
box_area = ((bbox[2] - bbox[0] + 1) * (bbox[3] - bbox[1] + 1) / (w * h)) if bbox else 0.0
verdict = "possible" if uniform >= 0.98 and 0.20 <= keyed <= 0.95 else ("borderline" if uniform >= 0.90 else "not uniform")
print("size %dx%d | edge median rgb %s | edge uniform %.1f%% | connected background %.1f%% | subject box %.1f%% of area | %s"
      % (w, h, median[:3], uniform * 100, keyed * 100, box_area * 100, verdict))
```

## 부록 E. Hermes 기록 읽기

```python
"""Hermes 세션 기록(state.db)에서 그림 도구 호출의 증거를 읽는다(읽기 전용, stdlib만).
인자 값·그림 설명·주소는 출력하지 않는다(주소의 토큰은 가린다).
  docker exec -i -u hermes <컨테이너> /opt/hermes/.venv/bin/python - < hermes_evidence.py"""
import json
import os
import re
import sqlite3

DB = os.environ.get("HERMES_STATE_DB", "/opt/data/state.db")
IMAGES = "/opt/data/cache/generated/images/"
db = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
redact = lambda text: re.sub(r"(/v1/self-media/)[0-9a-f-]{36}/[A-Za-z0-9_-]{43}", r"\1<workspace>/<redacted>", text)
RESULT_KEYS = ("success", "error_type", "modality", "input_image_count", "pixel_size", "reported_size", "reported_quality")
for rowid, role, tool_name, tool_calls, content in db.execute(
        "select id, role, tool_name, tool_calls, content from messages order by id"):
    if role == "assistant" and tool_calls:
        for call in json.loads(tool_calls):
            function = call.get("function") or {}
            if function.get("name") != "image_generate":
                continue
            args = json.loads(function.get("arguments") or "{}")
            print(rowid, "image_generate call | argument names:", sorted(args),
                  "| image_url given:", bool(args.get("image_url")),
                  "| reference_image_urls given:", bool(args.get("reference_image_urls")))
    elif role == "tool" and tool_name == "image_generate":
        try:
            result = json.loads(content)
        except (TypeError, ValueError):
            result = {}
        print(rowid, "image_generate result:", {key: result.get(key) for key in RESULT_KEYS},
              "| error:", redact(str(result.get("error") or ""))[:240])
    elif role == "assistant" and content and "MEDIA:" in content:
        paths = re.findall(r"MEDIA:\s*(\S+)", content)
        print(rowid, "final answer MEDIA lines:", len(paths), "| all under the generated-images dir:",
              all(path.strip("`'\"").startswith(IMAGES) for path in paths))
```
