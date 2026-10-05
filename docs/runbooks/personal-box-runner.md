# 개인 클라우드 박스 — 런너 설치 런북 (ADR-0197 M2, H5 항목의 체크리스트)

`momo-box-runner`는 **런너 호스트 한 대**에서 한 워크스페이스의 박스(멤버당 컨테이너 1 + 볼륨 1)를 만들고 지우는 데몬이다. 서버로 outbound HTTPS만 하고(포트를 열지 않는다) 허용 동사 다섯 개(`create|start|stop|delete|status`)만 실행한다. 이 문서는 호스트를 준비하는 사람(런너 운영자)을 위한 것이다.

- 설계: [ADR-0197](../adr/0197-personal-cloud-workspace.md) D1·D2·D8·D9·D10, 증보 1(배치 A = 런너 호스트).
- **런너 VM의 위치·제공사·비용은 정해지지 않았다**(성재 2026-10-05 「일단 코드만」). 아래는 어떤 Linux 호스트에서나 같은 체크리스트이고, 배포 전 별도 결재가 필요하다. 이 런북을 실행했다는 것이 배포 승인이 아니다([M7 게이트](../cicd/03-store-readiness-gate.md)).
- 이 런북의 항목 중 **기계 검증이 아직 코드로 없는 것**(H5의 「기계 검증 항목」 중 스냅샷 API 조회, CI egress 게이트 H1)은 사람이 아래 명령으로 확인하고 결과를 남긴다.

## 0. 역할과 권한

| 역할 | 하는 일 | 권한 |
|---|---|---|
| **런너 운영자** | VM과 `momo-box-runner`를 관리한다. 호스트 root에 가깝다(아래 1번 docker 그룹). | 호스트 접근 |
| **인스턴스 운영자** | 서버에 런너를 **등록·회전·폐기**한다(`PLATFORM_ADMIN_EMAILS`에 등재된 owner/admin, 또는 `platform:read`). | 서버 API |
| **워크스페이스 관리자** | 박스 목록·정지·삭제(자원 관리). **런너를 등록하지 못한다**(D2). 박스 안을 보지 못한다(D6). | 서버 API |

한 사람이 겸할 수는 있지만 설정·감사에서 구분된다(`cloud_box_runner.registered|rotated|revoked` 감사 행의 `actor_role = instance_operator`).

## 1. 호스트 준비 체크리스트 (H5)

모두 런너 호스트에서 확인한다. 하나라도 실패하면 박스를 만들지 않는다.

| # | 항목 | 이유 | 확인 명령 |
|---|---|---|---|
| 1 | **docker 그룹 = 사실상 root.** `momo-box-runner`를 돌리는 계정은 docker 소켓에 닿으므로 호스트 root와 같다. 그 계정에는 SSH 키·클라우드 자격·다른 서비스를 두지 않는다. 소켓은 런너 uid(와 root)만 접근한다. | D2 | `id momo-box-runner` 의 그룹, `stat -c '%U:%G %a' /var/run/docker.sock` |
| 2 | **swap 끔.** tmpfs에 놓인 로그인 자격이 swap으로 새지 않는다. | D8 | `swapon --show` 가 비어 있다 |
| 3 | **코어 덤프·kdump 끔.** | D8 | `sysctl kernel.core_pattern` 이 `\|/bin/false` 또는 `/dev/null`, `systemctl is-active kdump-tools` 가 inactive |
| 4 | **docker 로그 드라이버 `none`.** 런너가 만드는 박스는 `--log-driver none`이지만 데몬 기본값도 같게 둔다(TTY의 로그인 URL·코드가 로그로 남지 않게). | D8 | `docker info --format '{{.LoggingDriver}}'` 가 `none` |
| 5 | **VM·볼륨 스냅샷·백업이 없다.** 제공사 디스크 스냅샷 정책이 꺼져 있고 백업 작업이 없다. 가능하면 **제공사 API로 조회**하고 결과(명령·시각)를 기록한다. 이 확인 없이는 로그인 영속(D8)을 켜지 않는다. | D8·T14 | 제공사 콘솔/API(제공사 미정) + `crontab -l`, `ls /etc/cron.*` 에 백업 없음 |
| 6 | **디스크 한도.** 박스 디스크 10 GB는 Docker 볼륨 크기 옵션으로 적용한다 — 데이터 루트가 **xfs + project quota(pquota)** 여야 하고, 런너 설정 `diskQuota` 를 `local-driver-size` 로 둔다(이때 볼륨은 `--opt size=<N>g`로 만들어지고 Docker가 거부하면 박스 생성이 실패한다). pquota가 없는 호스트는 `unenforced-dev`(개발 전용, **한도 미적용**)만 가능하다. | D3 | `findmnt -no FSTYPE,OPTIONS $(docker info --format '{{.DockerRootDir}}')` 에 `xfs`, `prjquota` 또는 `pquota` |
| 7 | **디스크·볼륨 암호화.** 볼륨별 LUKS/fscrypt 키와 crypto-shred는 S4가 실현을 확인하기 전까지 **방어로 세지 않는다**(잔여 위험 T14). 적어도 호스트 디스크를 암호화한다. | D10 | `lsblk -f` |
| 8 | **`hidepid=2`.** `docker run`으로는 못 건다(`runtime-unverified`). 호스트 `/proc`이 아니라 컨테이너 안의 보호이므로 box-agent 쪽 시험(`infra/personal-box/verify-m3.sh`)이 uid 분리와 ptrace 거부를 잰다. 호스트에서는 런너 계정만 호스트 프로세스를 본다. | D1 | `mount \| grep ' /proc '` |
| 9 | **한 호스트 = 한 워크스페이스.** 런너는 시작할 때 `io.oort.workspace` 라벨이 다른 박스(컨테이너·볼륨)가 이 호스트에 있으면 시작을 거부한다. | D2 | `momo-box-runner run` 의 시작 로그 |
| 10 | **키(런너 인증) 회전 절차**를 정해 두고(분기마다 또는 침해 의심 때) 아래 4번으로 연습한다. | D8 | 4번 |
| 11 | **용량 계획.** 워크스페이스 동시 켜짐 5개 × (1 vCPU · 2 GB · 10 GB) + 여유를 호스트가 감당한다. 초과하면 서버가 만들기를 거절한다(「자리가 없어요」). | D3 | `nproc`, `free -g`, `df -h` |
| 12 | **장애 시 삭제 확인 절차.** 런너가 오프라인이면 삭제 컨트롤이 쌓이고 박스는 `deleting`에 머문다. 런너가 돌아오면 이어서 처리한다. 5회 시도 안에 끝나지 않은 삭제는 서버가 `delete_failed`로 돌리고 관리자가 재시도한다. 호스트에서 `docker ps -a --filter label=io.oort.box` 와 `docker volume ls --filter label=io.oort.box` 로 남은 것을 직접 본다. | D10 | 같은 명령 |

## 2. 네트워크 — S1 egress 규칙 (D9)

박스는 인바운드 포트가 없고, 호스트·사설 대역·CGNAT·메타데이터·IPv6·이웃 박스·SMTP로 나가지 못한다. 규칙은 레포의 선언 파일 [`infra/personal-box/s1/runner-egress.nft`](../../infra/personal-box/s1/runner-egress.nft) 하나가 정본이고 런타임 API로 심지 않는다.

1. 박스 전용 브리지 네트워크를 만든다. 브리지 이름은 규칙 파일의 `BOX_BR`(`momos1br`)와 같아야 하고, 박스끼리는 `icc=false`로 막는다.

   ```bash
   docker network create --driver bridge \
     -o com.docker.network.bridge.name=momos1br \
     -o com.docker.network.bridge.enable_icc=false \
     momo-box-net
   ```

2. 규칙을 **테이블 단위로** 적용한다(`nft flush ruleset`은 같은 호스트의 다른 Docker 규칙까지 지우므로 금지).

   ```bash
   sudo nft -f infra/personal-box/s1/runner-egress.nft
   sudo nft list table inet momo_s1
   sudo nft list table bridge momo_s1_l2
   ```

3. 재부팅 뒤에도 적용되도록 호스트의 nftables 서비스에 이 파일을 넣는다. 제거는 `sudo nft delete table inet momo_s1` 과 `sudo nft delete table bridge momo_s1_l2`.
4. **연결률·PPS·대역폭 상한과 br_netfilter 호스트는 배포 전에 다시 잰다**(S1 증보 1). **배포마다 박스 안에서 프로브하는 CI 게이트(H1)는 아직 없다.** 규칙을 적용한 뒤에는 박스 안에서 `infra/personal-box/s1/box-probe.sh` 로 사설 대역·CGNAT·메타데이터·IPv6·이웃 박스·SMTP가 막히는지 직접 확인하고 결과(명령·시각)를 기록한다. 그 기록 없이는 박스를 열지 않는다.

## 3. 박스 이미지

런너는 이미지를 **받지 않는다**(`--pull never`). 호스트에 미리 올려 두고, 런너 설정은 그 이미지를 **다이제스트로** 고정한다(태그 거부).

- 레포에서 만들기: `infra/personal-box/build-image.sh` 가 S3 이미지 위에 `momo-box-agent`(release)와 진입 스크립트·덮어쓰기 도우미만 얹고 이미지 ID를 출력한다. M3의 시험 도구 `momo-box-probe`는 이미지에 들어가지 않는다(`infra/personal-box/verify-m2.sh` 가 검사).
- 설정에 쓰는 값: `sha256:<64 hex>`(로컬 이미지 ID) 또는 `레지스트리/이름@sha256:<64 hex>`.
- 공식 CLI(Claude, Codex)는 게시된 그대로이고 이미지에 자격이 없다(D1·D4).

## 4. 런너 설치와 등록

1. 전용 계정으로 `momo-box-runner` 바이너리를 둔다(`cargo build --release -p momo-box-runner`, 워크스페이스는 `server-rust/`). 상태 디렉터리(격리 장부)는 그 계정만 읽는다(0700).
2. **서버에 런너를 등록한다**(인스턴스 운영자). 응답의 `credential`은 **이때 한 번만** 보인다. 서버는 SHA-256만 저장한다.

   ```bash
   curl -sS -X POST "$OORT/v1/workspaces/$WS/cloud-box-runners" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
     -d '{"name":"런너 이름"}'
   ```

   워크스페이스당 활성 런너는 하나다(409 `cloud_box_runner_exists`). 박스 만들기 동의 화면(M5/M7)이 이 이름과 지문(`credentialFingerprint`)을 보여 준다.
3. 자격을 **0600** 파일로 저장한다(소유자가 런너 계정, 그룹·타인 접근 없음 — 아니면 런너가 시작하지 않는다).
4. 설정 파일(JSON, 닫힌 모양: 알 수 없는 필드는 거부)을 만들고 `MOMO_BOX_RUNNER_CONFIG` 로 가리킨다. **박스가 무엇을 도는지(이미지·이름·네트워크·DNS·로컬 한도)는 여기에만 있고 서버 컨트롤로는 바꿀 수 없다.**

   ```json
   {
     "serverUrl": "https://oort.example.com",
     "workspaceId": "00000000-0000-7000-8000-000000000001",
     "credentialFile": "/etc/momo-box-runner/credential",
     "image": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
     "namePrefix": "momo-box-",
     "network": "momo-box-net",
     "dns": ["1.1.1.1", "9.9.9.9"],
     "caps": {"cpuMillis": 1000, "memoryMb": 2048, "diskGb": 10, "pids": 512},
     "diskQuota": "local-driver-size",
     "stateDir": "/var/lib/momo-box-runner"
   }
   ```

5. 설정을 검증하고 시작한다. 서비스로 돌릴 때는 `Restart=on-failure`, 런너 계정, 읽기 전용 설정을 쓴다.

   ```bash
   MOMO_BOX_RUNNER_CONFIG=/etc/momo-box-runner/runner.json momo-box-runner check-config
   MOMO_BOX_RUNNER_CONFIG=/etc/momo-box-runner/runner.json momo-box-runner run
   ```

6. **자격 회전**(분기마다·침해 의심 때): 인스턴스 운영자가 `POST …/cloud-box-runners/{runner}/rotate` 를 부르면 새 자격이 한 번 나오고 **옛 자격은 즉시 죽는다**(런너가 보유한 lease는 그대로). 새 자격으로 파일을 바꾸고 런너를 재시작한다. 폐기(`…/revoke`)는 되돌릴 수 없고, 런너가 쥔 컨트롤은 `pending`으로 돌아가며 새 런너가 등록되면 이어서 받는다. 런너가 401을 받으면 스스로 멈춘다.

## 5. 운영 중 보는 것

- **고아 볼륨.** 런너는 주기적으로 호스트의 박스 볼륨과 서버의 박스 목록을 대조한다. 서버가 모르는(또는 `deleted`인) 볼륨은 **격리**(컨테이너 정지, 볼륨 유지)만 하고 장부에 적는다. **서버의 말만으로는 어떤 볼륨도 파기하지 않는다.** 파기는 ① 14일이 지나고 ② 운영자가 이 호스트에서 확인하고 ③ 일일 상한(기본 2개) 안일 때만 한다.

  ```bash
  MOMO_BOX_RUNNER_CONFIG=/etc/momo-box-runner/runner.json momo-box-runner quarantine
  MOMO_BOX_RUNNER_CONFIG=/etc/momo-box-runner/runner.json momo-box-runner confirm-shred 00000000-0000-4000-8000-000000000000
  ```

  서버가 빈 목록을 주거나 호스트 볼륨의 절반 넘게 한꺼번에 고아라고 하면 런너는 그 목록을 믿지 않고 아무것도 하지 않는다(DB 복구·장애·침해된 서버가 모든 박스를 멈추거나 파기하지 못하게).
- **삭제 검증.** `delete` 컨트롤은 컨테이너 중지·제거 → 볼륨 덮어쓰기 → 볼륨 제거 → **둘 다 없음을 확인**해 보고한다. 서버는 두 확인이 모두 참일 때만 박스를 `deleted`로 닫고, 아니면 `delete_failed`로 남긴다(관리자가 재시도).
- **로그.** 런너 로그에는 컨트롤 id·동사·결과만 남고 docker 출력·자격은 남지 않는다. 박스의 docker 로그는 `none`이다.

## 6. 알려진 한계 (M4/H로 넘긴다 — 숨기지 않는다)

| 한계 | 사정 |
|---|---|
| **host 키와 seal 키가 시작마다 새로 만들어지고 정지하면 사라진다**(tmpfs). | host 키 저장소는 키 디렉터리가 `nosuid,nodev` 마운트이길 요구하는데 **Docker 볼륨은 그렇게 마운트할 수 없다**(실측: 로컬 드라이버의 `o=bind,nosuid,nodev` 옵션은 무시된다). 영속은 호스트가 미리 `nosuid,nodev`로 마운트해 둔 전용 파일시스템 위의 디렉터리를 바인드해야 하고, 그 마운트 준비와 seal 키 전달(D8)은 M4/H5의 몫이다. box-agent 등록·페어링이 M4에서 붙기 전이라 지금은 잃을 신원이 없다. |
| 서명된 tombstone으로 파기하는 길이 없다. | D10의 소유자·관리자 기기 서명 tombstone은 M4/M6의 기기 서명이 필요하다. 그때까지 서버 말만으로는 파기하지 않는다(5번). |
| 박스의 bounding set을 비우지 못한다(`CapBnd=c0`). | `CAP_SETPCAP`이 없다. 나머지 capability 집합은 비어 있고 `no_new_privs`·setuid 바이너리 없음이라 얻을 길이 없다(M3 L-D). |
| 디스크 한도가 호스트에 달려 있다. | 위 6번(pquota). 개발 호스트의 `unenforced-dev`는 한도를 적용하지 않는다. |
| 컨테이너 탈출은 커널 취약점이다(T3). | gVisor/microVM은 H3. |

## 7. 검증

```bash
infra/personal-box/verify-m2.sh --self-test
infra/personal-box/verify-m2.sh --sabotage probe
```

`verify-m2.sh` 는 이미지(추가된 파일이 에이전트와 스크립트 둘뿐인지, `momo-box-probe` 없음, setuid 없음)를 검사하고, 실제 Docker에서 서버 라우터 ↔ 진짜 런너 ↔ 박스의 만들기·시작·정지·재시작·삭제(검증 보고)와 고아 볼륨 격리·파기를 돌린다. 격리된 PostgreSQL 18(`DATABASE_URL`)이 필요하고 이 스크립트가 만드는 Docker 객체는 모두 `momo-m2-` 접두사이며 끝나면 지운다.
