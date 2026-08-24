# 셀프호스트 pg_dump 백업·복원

> 대상: 그록봇 VM·개인 VPS·로컬에 올린 oort에서 **내 데이터를 파일로 가져가는** 경로.
> 프로덕션 WAL/PITR(운영자)는 [`pgbackrest-pitr.md`](pgbackrest-pitr.md). 이 문서는 그 대체재가 아니다.
> named volume 복사나 `pg_dump` 성공을 production backup 증거로 보지 않는 계약은 PITR 런북이 유지한다.

이 문서는 법률 자문이 아니다. 덤프 파일·로그·이슈·PR에 비밀번호·토큰·DATABASE_URL을 붙이지 않는다 (ADR-0004).

## T-2 결속

에이전트 플레이북 [`SELF_HOST_AGENT.md`](../SELF_HOST_AGENT.md) §3.2(첫날 백업)·§4(데이터 가져가기)가 이 런북을 가리킨다. **복원 정본은 여기**다.

앱 UI export 버튼은 후속 티켓(본 파도 미발급).

## 이 경로가 필요한 때

| 시나리오 | 무엇이 사라지나 | 덤프가 하는 일 |
|---|---|---|
| 그록봇 **Update / Reset** | VM 설치물·Docker 볼륨이 증발하거나 과거 스냅샷으로 롤백될 수 있다 | `/workspace`에 둔 덤프를 사용자 기기로 내려받으면 산다 |
| **그록 구독 해지·이탈** | VM 자체에 더 이상 못 들어간다 | 해지 전에 덤프를 내려받는다 |
| **B7 트라이얼 잠김** | 크레딧이 마르면 워크스페이스 접근이 막힌다. 스펜드 캡이 없다 | 첫날 덤프가 잠김 이후의 복원 입력이다 |
| **다른 VPS / 로컬로 이사** | 원래 호스트를 버린다 | 아래 복원 절차로 새 oort 스택에 넣는다 |

체험은 **본인 그록봇 계정/VM**에서만 돌린다. 우리 팀 계정을 남에게 여는 절차가 아니다.

## 백업 (스택이 떠 있는 호스트에서)

레포 루트:

```sh
scripts/self_host_pg_dump.sh
```

그록봇 VM이면 기본 저장 위치는 `/workspace/oort-backups/` 다. 그 디렉터리가 없으면 위치를 지정한다:

```sh
scripts/self_host_pg_dump.sh --output-dir /workspace/oort-backups
```

로컬 머신이나 자기 VPS:

```sh
scripts/self_host_pg_dump.sh --output-dir /var/tmp/oort-backups
```

스크립트는 실행 중인 compose `postgres` 서비스에 `pg_dump -Fc` 를 보내고, 경로·바이트·sha256·다운로드 안내만 출력한다. 비밀번호는 stdout에 없다.

첨부 바이트는 Postgres 밖에 있다. 같은 백업 세트에 보관소 디렉터리(compose 볼륨 `DRIVE_VOLUME_NAME`, 기본 `oort-drive` → 컨테이너 `MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive`)를 동반 복사한다. 덤프만 복원하면 메시지 행은 남고 파일은 없다.

덤프 구현은 `scripts/lib/pg_dump_custom.sh` 하나다. 리허설 게이트 `scripts/verify_backup_restore_rehearsal.sh` 도 같은 함수를 쓴다.

## 복원 (새 oort 스택)

새 머신에서 env를 만들고 postgres만 먼저 올린 뒤 덤프를 넣는다. migrate가 빈 DB에 스키마를 깔기 **전에** 복원하는 경로다.

```sh
scripts/self_host_env.sh --local-build
scripts/self_host_env.sh --compose up -d --wait postgres
scripts/self_host_pg_restore.sh --dump /workspace/oort-backups/oort-pg.dump
scripts/self_host_env.sh --compose up -d --wait
```

이미 한 번 `up` 해서 스키마가 있는 dest면, 쓰기 프로세스를 멈추고 `--clean` 으로 교체한다.

```sh
scripts/self_host_env.sh --compose stop api relay agent-worker webhook-sender
scripts/self_host_pg_restore.sh --dump /workspace/oort-backups/oort-pg.dump --clean
scripts/self_host_env.sh --compose up -d --wait
```

공개 digest 모드면 `--local-build` 대신 `scripts/self_host_env.sh --published-image` 경로를 쓴다. 절차는 [`SELF_HOST.md`](../SELF_HOST.md) §2.

복원 뒤 브라우저에서 로그인하고 채널의 메시지·멤버가 보이는지 확인한다. dest의 `infra/rust/local.secrets.env` 는 **새 호스트의 시크릿**이다. 덤프가 가져오는 것은 Postgres 안의 멤버·메시지이지, 옛 env 파일이 아니다. 옛 비밀번호 해시가 덤프에 있으면 그 계정으로 로그인하고, dest env의 `MOMO_INITIAL_OWNER_*` 는 이미 있는 오너를 덮어쓰지 않는다.

## 검증 (개발/게이트)

```sh
scripts/verify_self_host_pg_dump_restore.sh
scripts/verify_backup_restore_rehearsal.sh
```

전자는 고유 compose 프로젝트 두 개에 member/message 시드를 넣고 dump→restore 잔존을 단정한다. 후자는 임시 PG18 마커 리허설이다. 둘 다 같은 `pg_dump -Fc` 구현을 쓴다.

## 함정

- `scripts/self_host_env.sh --compose down` 이 워크트리 스택을 「다른 체크아웃」으로 오인하고 거절할 수 있다(#1650: compose `working_dir` 라벨이 `infra/rust` 인데 가드는 워크트리 루트를 본다). 회수는 canonical compose 파일을 프로젝트 이름으로 직접 호출한다:

```sh
docker compose --project-name momo_example -f infra/rust/docker-compose.rust.yml down -v
```

- 시크릿이 든 `*.secrets.env` 와 덤프 파일을 커밋하지 않는다.
- 이 경로는 셀프호스터 이사·그록 이탈용이다. 공개 운영의 PITR 폐곡선·서명된 migrate evidence가 아니다.
