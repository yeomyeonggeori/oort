# 리그에서 실 work 세션 1커맨드 (#1777)

성재·오케스트레이터가 Rust 리그에서 **데몬이 만든 실 PTY 세션**을 한 번에
세우는 절차다. 웹 관전 도크(`ObserverTerminal`)는 이 세션의
`remoteAttachAvailable: true` 를 소비한다. 픽스처로 세션을 흉내 내지 않는다.

## 데몬은 맥 로컬 프로세스다

`momo-workd`는 `workers/WorkHostDaemon` 의 Swift 바이너리를 **호스트에서**
띄운다. 컨테이너로 넣지 않는 이유:

1. `infra/rust` compose 에 Swift 툴체인이 없다.
2. 기존 `scripts/verify_workd.sh` 도 같은 형태다 (차이는 API 가 Swift e2e
   가 아니라 Rust 라는 점).
3. 실 PTY 바이트는 네이티브 `/bin/sh` 가 찍는다.
4. 테스트 환경이 성재의 맥이다.

은퇴 트리에 새 기능을 얹는 것이 아니라, 유일한 PTY 생산자를 그대로 돌린다.

## 1커맨드

리그 API(`http://127.0.0.1:8080`, compose project `oort`)가 이 브랜치의
host-signed 팔을 서빙하면:

```sh
scripts/verify_workd_rust.sh
```

하는 일: owner/agent 시드 → 맥 로컬 workd 등록 → agent credential
(`work:control`) → `shell` auto-approve → spawn 201 dispatched → 데몬이
host-signed create + `bindRemotePTY` → `remoteAttachAvailable` false→true →
controller attach(replay + live stdin) + 도크와 같은 observer attach
WS(replay만. observer 에 stdin 을 넣으면 1008 `forbidden for observer`).
이어서 소유자 `PATCH {observation:owner_only}` → 팀원 observer attach 403 →
재개방 → attach 200 (#1778).

PG 는 호스트 포트가 없으므로 `docker exec oort-postgres-1 psql` 로만 읽는다.

## 수리 전 RED / 이 워크트리 GREEN

리그 컨테이너가 #1777 이전이면 같은 스크립트가 등록된 `workd.key` 로
서명 `POST …/work-sessions` 를 직접 보내 400/401/403 에서 멈춘다
(데몬은 그 전에 `GET …/work-tool-profiles` 에서 죽을 수 있으므로, 로그
대기만으로는 RED 가 성립하지 않는다). 그게 red proof (b) 의 RED 다:

```sh
WORKD_RUST_EXPECT_RED=1 scripts/verify_workd_rust.sh
```

리그 API 를 교체하지 않고 이 워크트리 서버로 GREEN 을 닫으려면:

```sh
WORKD_RUST_BOOT_LOCAL=1 scripts/verify_workd_rust.sh
```

throwaway `pgvector/pgvector:pg18` + `cargo run -p momo-server` (기본
`127.0.0.1:18770`). 리그 컨테이너는 건드리지 않는다.

## 통합 시험 (red proof a)

리그 PG 가 아니라 전용 pgvector 에 대고 돌린다. `run_migrations` 가 라이브
리그 스키마를 만지면 안 된다.

```sh
DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
  cargo test --manifest-path server-rust/Cargo.toml -p momo-server \
    --test host_signed_session_conformance_pg \
    -- --ignored --test-threads=1 --nocapture
```

무서명 400 · 타 호스트 403 · controlId 불일치 409 · 정상 서명 201/200 +
`remoteAttachAvailable` false→true · idle/running 을 고정한다.

관전 토글 (#1778) 은 같은 리그 PG 에 대고:

```sh
DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
  cargo test --manifest-path server-rust/Cargo.toml -p momo-server \
    --test observation_toggle_conformance_pg \
    -- --ignored --test-threads=1 --nocapture
```

소유자 200 · 비소유자 403 · `owner_only` 에서 teammate attach 403 · 재개방 후
attach 200 · 감사 행을 고정한다.
