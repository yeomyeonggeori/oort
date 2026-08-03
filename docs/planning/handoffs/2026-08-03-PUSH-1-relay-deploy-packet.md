# goal PUSH-1 — PushRelay 배포 경로 (푸시 종단을 여는 마지막 조각)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/PUSH-1-relay-deploy`(브랜치 `feat/PUSH-1-relay-deploy`, 생성됨).

발단: 푸시 종단 경로를 오케스트레이터가 실측했다.
- **서버(Rust) 쪽은 됐다** — devices REST · push_candidate drain · Ed25519 서명 relay 클라이언트(`server-rust/bins/momo-notifier/src/push_relay.rs`), id-only 페이로드는 red test 로 고정(PR #963).
- **클라(RN) 쪽도 됐다** — NSE 타깃·`expo-notifications`·keychain access group(PR #972).
- **막힌 곳은 가운데다**: `relay/PushRelay` 는 Swift 패키지인데 **Dockerfile 이 없어 배포할 수 없다.** ADR-0120 D1-A 상 **APNs `.p8` 은 이 relay 만 든다**(셀프호스팅 서버는 Apple 과 계약할 수 없다는 구조적 필연). 즉 이게 없으면 실 푸시가 한 발도 못 나간다.

## 0. 규율
`.env`·자격증명 금지(파일명 출력도) · **APNs 키를 만들거나 요구하지 마라**(성재 Apple 계정 몫) · **실제 APNs 발송 금지** · **docker 실행 금지**(배포·검증은 오케스트레이터) · **`clients/**` 전부 수정 금지**(다른 배치 소유) · `schema_v0.sql` 금지 · 커밋은 새 커밋만 · **PR 후 STOP**.
**`server-rust` 는 읽기 우선** — relay 계약을 맞추려 고쳐야 하면 최소로 + 사유.

## 1. 먼저 읽어라
- `relay/PushRelay/Sources/PushRelay/` 전부(`App.swift`·`Config.swift`·`APNSSender.swift`·`PushDispatch.swift`·`RateLimiter.swift`·`Main.swift`).
- `server-rust/bins/momo-notifier/src/{push_relay.rs,config.rs}` — **Rust 가 실제로 무엇을 보내는지**가 계약의 절반이다.
- `docs/adr/0120-*.md` D1-A(구조적 필연)·D2-A(id-only).
- `infra/rust/docker-compose.rust.yml` 와 `server-rust/Dockerfile` — 기존 관례(멀티스테이지·역할 분기·이미지 pull)를 따라라.
- 감사: `docs/planning/2026-08-02-rn-push-inheritance-audit.md`.

## 2. 할 일
1. **`relay/PushRelay` 를 컨테이너로 굽는 경로**를 만들어라(Dockerfile). 기존 Swift 이미지 관례가 레포에 있으면 그것을 따르고, 없으면 `server-rust/Dockerfile` 의 멀티스테이지 문법을 참고해라. 런타임 베이스에 무엇이 필요한지(Swift 런타임 등) 실측해서 적어라.
2. **compose 편입** — `infra/rust/` 에 relay 서비스를 추가하되 **기본 비활성**(프로파일 또는 명시 플래그). 지금 도는 도그푸딩 스택이 이 변경으로 흔들리면 안 된다.
3. **자격증명 계약을 문서화해라** — relay 가 부팅에 필요한 것(APNs `.p8` 경로·Key ID·Team ID·번들 ID·bind 주소 등)을 `Config.swift` 에서 **읽어서** 표로 정리. **키가 없으면 어떻게 되는지**(부팅 거부인지 조용한 무동작인지)를 확인하고, 조용한 무동작이면 **부팅 거부로 바꿔라** — 푸시는 fail-open 이 가장 탐지하기 어려운 실패다(감사가 같은 지적을 했다).
4. **서버 등록 절차** — Rust notifier 가 Ed25519 로 서명하고 relay 가 검증한다. **공개키를 relay 에 어떻게 등록하는지**를 코드에서 확인해 절차로 적어라. 없으면 "없다"고 적어라(그 자체가 결과다).
5. **오케스트레이터/성재가 그대로 따라 할 배포·검증 런북**을 `docs/cicd/` 에 남겨라: 무엇을 준비하고(키·env), 무엇을 띄우고, 무엇으로 성공을 확인하는지. `docs/cicd/11-ios-push-device-check.md` 와 이어지게.
6. **가능하면 발송 없이 검증되는 것을 게이트로** — 예: relay 가 서명 검증을 실제로 하는지, 미서명/위조 서명을 거절하는지. 실 APNs 없이 확인 가능한 성질만.

## 3. 판단해야 할 것
- **Swift 유지가 맞나?** ADR-0145 재작성 인벤토리에 PushRelay 는 없다(감사 확인). 그대로 Swift 로 굽는 것이 기본이고, 다르게 판단하면 근거를 대라 — **다시 짜자는 결론은 이 배치 범위가 아니다.**
- relay 를 **어디에 둘 것인가**(같은 NCP 인스턴스 vs 별도). 자원·격리·ADR-0120 의 "Dawn 운영" 전제를 고려해 **권고 1개**를 내라.

## 4. 검증
- 이미지 빌드 정의가 **문법적으로 옳고**(빌드는 오케스트레이터가 실행) compose 가 `config` 로 파싱된다.
- 기존 게이트 무회귀: `server-rust` 의 `cargo check/test/fmt/clippy`, `clients/web`·`packages/momo-core` 수치 불변(건드리지 않았으니 당연하지만 확인해라).
- 런북대로 하면 **키만 꽂으면 되는 상태**여야 한다.

## 5. PR
`feat/PUSH-1-relay-deploy` → `track/engine`. 본문에: relay 자격증명 표·키 부재 시 동작·공개키 등록 절차(또는 부재)·배치 위치 권고·오케스트레이터가 실행할 명령·이탈. **PR 후 STOP.**
