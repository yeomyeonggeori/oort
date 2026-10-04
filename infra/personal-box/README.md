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
- 컨테이너 플래그: `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user 10001:10001`, `--ulimit core=0`, pids/메모리/CPU 상한, 바인드 마운트·docker 소켓 없음, docker 로그 드라이버 `none`(TTY 로그인 화면이 docker 로그에 남지 않게. ADR-0197 D8).
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
`audit`는 `/cred`의 비밀 값 전부와 로그인 URL·코드 모양이 docker 로그·러너 로그·Colima VM 컨테이너 디렉터리에 없는지 박스 안에서 판정하고(`leaked=0 login_shapes=0`이어야 해요), 자격 파일 이름·크기만 출력해요(내용은 출력하지 않아요).

캡처해서 PR/이슈에 남길 것(토큰·코드·URL 값은 가리거나 빼요): ① `audit` 출력 전체 ② 로그인 성공을 보여주는 `claude` 상태 화면과 `codex login status` ③ `docker inspect momo-s3-box --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.LogConfig.Type}}'`. 이어서 tmpfs 확인:
```
! infra/personal-box/momo-s3-box.sh down
! infra/personal-box/momo-s3-box.sh up
! docker exec momo-s3-box sh -c 'ls -A /cred/claude /cred/codex'    # 비어 있어야 해요 (다시 로그인 필요)
! infra/personal-box/momo-s3-box.sh down --purge
! docker rmi momo-s3-box:local
```

읽을 때 주의할 점 두 가지예요.
- 러너 기본 로그 드라이버가 `none`이라 `audit`의 `docker-logs` 줄은 「로그가 없어서 0」이에요. 로그를 읽어 깨끗하다고 확인한 것이 아니에요. 로그가 있을 때 잡아내는 증명은 `verify-s3.sh`의 json-file 양성 대조가 맡아요.
- leakscan은 `/cred` 안의 16자 이상 문자열을 전부 비밀로 봐요. 실제 로그인 뒤에는 시각·계정 UUID·경로 같은 비밀이 아닌 값도 들어 있어서 오탐이 날 수 있어요. `leaked>0`이 나오면 값은 적지 말고 줄의 라벨만 보고해 주세요. 오탐인지 분류하고 누출로 단정하지 않아요.
