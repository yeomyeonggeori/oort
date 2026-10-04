# personal-box — S3 스파이크 (ADR-0197, #3410)

개인 클라우드 작업 공간 박스 이미지와 로컬 러너, 자격 비열람 검증이에요. **네트워킹·중계·서버 연동은 이 스파이크 범위 밖**이에요(S1·S2·S4가 다룸). 모든 리소스 이름은 `momo-s3-` 접두어를 써요.

| 파일 | 역할 |
|---|---|
| `Dockerfile` | `node:22-bookworm-slim` 다이제스트 고정, 비루트 uid 10001, setuid 제거, Codex 무수정 설치(락파일 무결성), 자격 없음 |
| `momo-box-entry` | `/cred/{claude,codex}`를 0700으로 만들고 명령을 exec |
| `momo-box-install-claude` | Claude Code를 락파일 고정 버전으로 **첫 시작에** `/opt/tools`(tmpfs)에 설치 |
| `momo-box-leakscan` | 박스 안에서 실행. `/cred`의 비밀 값과 로그인 URL·코드 모양이 stdin에 있는지만 판정(값은 박스를 나가지 않음) |
| `momo-s3-box.sh` | 러너: `build`, `up [--persist-login]`, `shell`, `audit`, `down [--purge]` |
| `verify-s3.sh` | 가짜 표식으로 하는 검증(실로그인 불필요). `--sabotage <mode>`와 `--self-test` 포함 |

## 설계 요점
- 컨테이너 플래그: `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user 10001:10001`, `--ulimit core=0`, pids/메모리/CPU 상한과 `--memory-swap`=메모리(tmpfs 자격이 swap으로 나가지 않게), 바인드 마운트·docker 소켓 없음, docker 로그 드라이버 `none`(TTY 로그인 화면이 docker 로그에 남지 않게. ADR-0197 D8).
- 자격 디렉터리: `CLAUDE_CONFIG_DIR=/cred/claude`, `CODEX_HOME=/cred/codex`. 기본은 **tmpfs**(정지하면 사라짐, 다시 로그인). `up --persist-login`은 이름 있는 볼륨 `momo-s3-cred`를 쓰는 **옵트인** 모드이고, ADR D8 게이트(런너에 백업·스냅샷이 없음)를 통과한 런너에서만 켜야 해요.
- HOME도 tmpfs라서 `~/.claude.json` 같은 홈 파일이 이미지나 쓰기 레이어에 남지 않아요. 읽기 전용 루트의 쓰기 가능 지점은 tmpfs(`/cred`, `/home/box`, `/tmp`, `/opt/tools`, `/work`)뿐이에요.
- 운영 런너(M2)는 `exec`/`cp`/`commit` 동사가 없어요. 이 스파이크 러너의 `shell`(docker exec)은 로컬 수동 왕복용이에요.

## 라이선스 (재배포 판단)
| CLI | 라이선스 | 이미지 처리 |
|---|---|---|
| `@openai/codex` 0.160.0 | Apache-2.0 | 이미지에 무수정 포함. LICENSE/NOTICE를 `/usr/share/licenses/momo-box/`에 복사. 이미지를 공개 게시할 때는 NOTICE 귀속을 같이 실어야 해요 |
| `@anthropic-ai/claude-code` 2.1.289 | 독점 (`© Anthropic PBC. All rights reserved`, Anthropic 법적 약관 적용) | **재배포하지 않아요.** 이미지에는 `package.json`+락파일 핀만 있고, 박스 첫 시작에 사용자 박스 안에서 npm으로 설치해요(`momo-box-install-claude`) |
| Node 22 / Debian bookworm | MIT / 패키지별 | 기본 이미지 상속. 공개 게시 시 Debian 저작권 파일 목록을 `NOTICE` 체계(GHCR 번들)처럼 점검해야 해요 |
이 이미지는 아직 어디에도 게시하지 않아요. 그래서 루트 `NOTICE`(GHCR 번들 해시로 고정돼 있어요)는 건드리지 않았고, 게시 전에 번들·NOTICE 갱신이 필요해요. 게시 전 법무 확인이 필요해요(이 문서는 법적 충분성을 선언하지 않아요).
Claude 설치는 네트워크(registry.npmjs.org)가 필요해요. 박스 egress 허용목록은 S1/H1이 정해요.

## 검증 (실로그인 없음)
```bash
infra/personal-box/verify-s3.sh                 # GREEN: 이미지 레이어·플래그·tmpfs/볼륨·로그/러너/VM 디스크 표식 검사
infra/personal-box/verify-s3.sh --self-test     # GREEN + 사보타주 5종(image|log|runner|writable-root|cap-add)이 모두 RED
infra/personal-box/verify-s3.sh --self-test --rm-image   # 끝나고 이미지까지 삭제
```
표식은 가짜 `{"accessToken":"MOMO-S3-MARKER-…"}` 자격 파일이에요. 표식이 없는 곳이어야 하는 곳(이미지 레이어·히스토리, docker 로그, 러너 로그/상태 폴더, Colima VM의 컨테이너 디렉터리·쓰기 레이어·`momo-s3-*` 볼륨)을 호스트 grep과 박스 안 leakscan으로 확인하고, 양성 대조(로그에 `box-ready`가 보이는지, 영속 모드 볼륨에는 표식이 있는지)로 검사기가 눈먼 게 아님을 보여요.

## 소유자 런북 (②, runtime-unverified — 소유자 손이 필요해요)
전제: Colima 실행 중. 이 폴더에서 실행해요.
```
! infra/personal-box/momo-s3-box.sh build
! infra/personal-box/momo-s3-box.sh up
! infra/personal-box/momo-s3-box.sh shell
```
박스 셸 안에서:
```
momo-box-install-claude          # Claude Code 설치 (첫 시작 1회)
claude                           # 로그인 화면에서 /login → URL을 호스트 브라우저에서 열고 코드를 붙여넣기
codex login --device-auth        # 출력된 URL·코드를 브라우저에서 입력
claude --version; codex login status
exit
```
로그인 뒤 호스트에서:
```
! infra/personal-box/momo-s3-box.sh audit
```
`audit`는 `/cred`의 비밀 값 전부와 로그인 URL·코드 모양이 docker 로그·러너 로그·Colima VM 컨테이너 디렉터리에 없는지 박스 안에서 판정하고(`leaked=0 login_shapes=0`이어야 하고, **`secret_values`가 0보다 커야 해요**. 0이면 비교할 비밀이 없다는 뜻이라 audit이 실패해요. 로그인 전 점검은 `audit --pre-login`), 자격 파일 이름·크기만 출력해요(내용은 출력하지 않아요).

캡처해서 PR/이슈에 남길 것(토큰·코드·URL 값은 가리거나 빼요): ① `audit` 출력 전체 ② 로그인 성공을 보여주는 `claude` 상태 화면과 `codex login status` ③ `docker inspect momo-s3-box --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.LogConfig.Type}}'`. 이어서 tmpfs 확인:
```
! infra/personal-box/momo-s3-box.sh down
! infra/personal-box/momo-s3-box.sh up
! docker exec momo-s3-box sh -c 'ls -A /cred/claude /cred/codex'    # 비어 있어야 해요 (다시 로그인 필요)
! infra/personal-box/momo-s3-box.sh down --purge
! docker rmi momo-s3-box:local
```

읽을 때 주의할 점 두 가지예요.
- 러너 기본 로그 드라이버가 `none`이라 `audit`의 `docker-logs` 줄은 `N/A`로 표시돼요(로그가 없다는 뜻이지 깨끗하다는 결과가 아니에요). 읽지 못한 대상은 `UNREAD`로 실패 처리돼요. 로그가 있을 때 잡아내는 증명은 `verify-s3.sh`의 json-file 양성 대조가 맡아요.
- leakscan은 `/cred` 안의 16자 이상 문자열을 전부 비밀로 봐요. 실제 로그인 뒤에는 시각·계정 UUID·경로 같은 비밀이 아닌 값도 들어 있어서 오탐이 날 수 있어요. `leaked>0`이 나오면 값은 적지 말고 줄의 라벨만 보고해 주세요. 오탐인지 분류하고 누출로 단정하지 않아요.

## 첫 시작 설치와 후속 항목
- Claude 패키지의 `postinstall`(`install.cjs`)은 플랫폼 네이티브 바이너리를 `bin/claude.exe` 자리표시자 위에 복사할 뿐 네트워크를 쓰지 않아요. `--ignore-scripts`로 막으면 `claude`가 스텁으로 남아서 스크립트를 켜 둬요. 락파일이 모든 타르볼 무결성을 강제하고, 설치 직후 패키지 integrity와 바이너리 sha256을 출력하고 `/opt/tools/install-record.txt`(tmpfs)에 남겨요.
- 로그인 셸은 `umask 077`이고 `/opt/tools/node_modules/.bin`은 PATH 맨 끝이에요. Debian의 `/etc/profile`이 로그인 셸의 PATH를 다시 쓰기 때문에, 이미지의 `ENV PATH`만으로는 `bash -lc 'command -v claude'`가 실패했어요(#3496). `/etc/profile.d/zz-momo-path.sh`가 배포판 스크립트 뒤에 그 경로를 **맨 끝에, 이미 있으면 건너뛰며** 붙여요. `verify-s3.sh` 2b가 설치 전 자리표시자 CLI와 실제 첫 시작 설치(레지스트리에 닿을 때) 양쪽에서 이를 확인하고, `--sabotage path`가 스니펫을 지우면 RED가 돼요.
- 러너 호스트 점검(`verify-s3.sh`가 Colima VM의 swap·core_pattern 상태를 출력)은 정보용이에요. 기계 검증 항목화는 ADR D8/H5가 맡아요.
- 후속(이 PR 범위 밖): 리뷰의 M7–M9, L3–L6, ADR H3/H5.

## M3 — `momo-box-agent`와 Linux 박스 프로필 (ADR-0197 M3, #3501)
박스 안의 호스트 신원이에요. 코드는 `server-rust/bins/momo-box-agent/`예요. 릴레이 라우트(M4)와 러너(M2)는 아직 없어서 `run`은 신원만 쥐고 `pending`으로 기다려요.

| 수용 기준 | 증거 |
|---|---|
| host 등록 `scope=member`, 소유자 확인 전 비활성 | `register.rs`(요청은 scope를 고정, 응답의 scope·type·키가 다르면 거부) + `host.rs`(`Phase::Pending`은 hello·기기 목록·PTY 모두 거부, 소유자 첫 목록은 런너 로컬 마운트로만) + `tests/host.rs` |
| PTY 열기, workd는 PTY 불가 유지 | `tests/host.rs`(blind-pty 핸드셰이크 → 첫 Resize가 PTY를 열고, 릴레이가 평문 표식을 못 봄) / `momo-workd/tests/no_pty.rs`(소스·매니페스트 검사) |
| Claude ACP 어댑터 없음 | `tests/no_acp.rs`(소스·매니페스트·허용된 `momo_workd::` 경로 검사) + `momo-workd`의 박스 프로필(`OORT_BOX`)이 claude 어댑터 설정을 거부 + `verify-s3.sh`/`verify-m3.sh`의 이미지·바이너리 검사 |
| 자격 경로 접근 거부 | `fsgate.rs`가 에이전트의 유일한 파일 문(`tests/fs_discipline.rs`가 소스로 잠금). `..`·심볼릭 링크·대소문자·열린 fd 경로까지 거부. 커널 쪽 벽은 `verify-m3.sh`("agent uid cannot open /cred/…") |
| 환경 허용목록 | `env.rs`(상속 없이 허용목록으로 구성, 금지 조각 목록과 교차 시험) + 컨테이너 안 실제 PTY 자식의 환경 검사 |
| 별도 uid, 사용자 uid에서 host 키 읽기·ptrace 거부 | `verify-m3.sh`: 에이전트 uid 10002(SETUID/SETGID만), 사람 uid 10001의 probe가 키 읽기·덮어쓰기·이름 바꾸기·삭제, `/proc/<pid>/{environ,mem,maps,fd}`, `PTRACE_ATTACH`를 모두 거부당함 |

### 컨테이너 프로필 (S3와 다른 두 가지)
컨테이너가 root로 시작하되 **`SETUID`·`SETGID`만** 가져요(`--cap-drop ALL --cap-add SETUID --cap-add SETGID`, `no-new-privileges`, 읽기 전용 루트는 그대로). `momo-m3-entry`(M2 러너가 할 일의 대역)가 `setpriv`로 에이전트를 uid 10002에서 그 두 capability를 ambient로 가진 채 띄워요. 에이전트는 사람의 PTY를 열 때 `setgroups([])` → `setresgid` → `setresuid(10001)` → ambient 비움 → `capset`으로 비움 → `no_new_privs` 순서로 떨어져요. 자식의 `CapInh/Prm/Eff/Amb`는 전부 0이에요. root는 에이전트도 사용자 코드도 돌리지 않아요. 에이전트는 평생 SETUID/SETGID를 쥐어요(에이전트가 뚫리면 이미 host 키가 뚫린 것이라 T5와 같은 선이에요).

에이전트 프로세스는 `PR_SET_DUMPABLE=0`, `RLIMIT_CORE=0`, `no_new_privs`예요. 그래서 `/proc/<pid>/*`가 root 소유가 되어 같은 uid여도 `environ`·`mem`을 못 읽고 ptrace도 못 붙어요. 사람 uid의 `PTRACE_ATTACH`는 uid가 달라 `EPERM`이고, 같은 probe가 **자기 자식은 ptrace할 수 있다**는 양성 대조를 같이 내요.

`verify-m3.sh`는 호스트에서 Rust를 `rust:1-bookworm` 컨테이너(glibc 2.36, 박스 이미지와 같음)에서 빌드해요. 빌드 결과(target·registry)는 tmpfs에만 두고 디스크 볼륨을 남기지 않아요. 키 디렉터리는 `nosuid,nodev` tmpfs, 봉인 키는 별도 tmpfs로 대역을 세워요(영속 게이트의 「다른 장치」). 실제 볼륨·런너 증명은 M2예요.
```
infra/personal-box/verify-m3.sh                      # GREEN
infra/personal-box/verify-m3.sh --sabotage same-uid  # 에이전트를 사람 uid로: RED여야 해요 (pty-as-agent, cred-readable도)
infra/personal-box/verify-m3.sh --self-test          # GREEN + 세 sabotage 모두 RED
```
**검증하지 않은 것(runtime-unverified):** `hidepid=2`(docker run으로 설정 불가, M2 러너 템플릿 항목), 실제 볼륨·LUKS·크립토 슈레드, 서버 쪽 등록·페어링 라우트(M1/M4)와 중계 WebSocket. PTY 자식의 bounding set은 `CAP_SETPCAP`이 없어 비우지 못하지만(`CapBnd=c0`), 다른 집합이 비어 있고 `no_new_privs`·setuid 바이너리 없음이라 얻을 길이 없어요. Colima VM의 `ptrace_scope`는 1이에요. 거부가 Yama에 기대지 않도록 같은 uid여도 dumpable=0이 `/proc`과 ptrace를 막아요.
