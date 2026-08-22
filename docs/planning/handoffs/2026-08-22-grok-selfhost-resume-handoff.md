# 핸드오프 — 그록봇 셀프호스팅 테스트 재개 (Fable용)

> 2026-08-22 Fable 발급. 다음 Fable 세션이 이 파일 하나로 즉시 이어받는다.
> 상세 실측 정본: `research/2026-08-22-grok-cdp-control-and-operator-host.md`. 절차 정본: `handoffs/2026-08-16-grok-e2e-manual-spike-packet.md`. goal: #1361.

## 성재 이번 세션 지시 3건 + 상태

1. **로컬 Docker 삭제·재설치**("자주 저러더라") → ✅ **완료·데몬 복구 실측**(29.7.2, 8GB/18cpu). 단 quarantine 미제거로 App Translocation(임시경로) 실행 중 — 기능 정상, 위생 정리는 성재가 편할 때 `sudo -v; brew install --cask --force docker-desktop`. **⚠ 프레이밍 정정(성재 지적): 로컬 Docker는 그록봇-오퍼레이터 셀프호스팅 테스트의 임계경로가 아니다** — 그록봇은 자기 VM의 Docker(:2375)를 쓴다. 로컬 Docker는 S1(이 맥에서 self-host) 스파이크용이었고, 별개 축이다.
2. **그록봇 제어 = 제일 좋은 방식으로 계속 테스트**(위임) → CDP(9333) READ✅·WRITE주입✅·**SEND는 분류기 차단**. 헬퍼: 스크래치패드 `cdp_read.py/cdp_send.py/cdp_clear.py`(`/opt/homebrew/bin/python3`, `suppress_origin=True` 필수).
3. **표적방향 = 추천대로**(오퍼레이터-호스트) → ✅ 승인 + VM 자백으로 강확증(§ 아래).

## 그록봇 VM 실측 (오퍼레이터 타당성)

Debian 13 amd64 · Docker 데몬 :2375 실가동(Engine 29.1.4) · 디스크 126G/7% · 공인 IP 없음(172.30.0.2/24 egress Cloudflare) · cgroup /agent · durable-but-resettable.
⇒ **오퍼레이터로 적격**(자기 Docker로 oort pull·구동, amd64라 GHCR digest 직접), **호스트로 부적격**(공인 IP 없음+reset 위험). 상시 호스팅은 별도 전용 호스트.

## 다음에 할 일 (재개 지점)

- **성재 결정 2건 대기**:
  - Q-CTRL: 그록봇 SEND 자동화 허용(Bash 권한 규칙)? vs 관측 릴레이(성재 Enter) 유지?
  - Q-HOST: 상시 호스트 = 현 프로덕션/TURN 호스트 재사용 vs 신규 조달?
- **스테이징된 프로브**(읽기전용, SEND 대기, research 노트 §3): ghcr.io 도달성 + `/2375/info` 용량. Q-CTRL 결정 후 발사.
- **#1361 본류**: 스파이크 절차는 2026-08-16 패킷이 정본. static bearer 실왕복 흔적은 이미 관측됨(inbox_read seq1·message_post seq2). 남은 건 성재 pairing 손절차 + confirm 후 폐곡선.
- **로컬 스택 상태**: `~/projects/momo-tracks/engine`에서 `scripts/self_host_env.sh --compose ps`로 확인(8/21 성재가 down·볼륨 보존·재개 1커맨드). Docker 복구됐으니 `up -d`로 재개 가능.

## 위생

- 디스크 89→92%(79Gi 여유)로 회복 — momo-worktrees 148G 중 cargo target 67GB를 `cargo clean`으로 회수(⚠ `rm`·`git worktree remove` 일괄은 부재 중 auto-deny, `cargo clean`은 허용). 더 회수하려면 `scripts/worktree_janitor.sh`(단건 remove만 허용).
- 그록봇 앱 컴포저는 원상복구함(스테이징 텍스트 제거).

---

## 2026-08-22 오후 갱신 (같은 날 후속 Fable 세션)

- **Q-CTRL 해소**: 성재가 그록봇 제어 사용을 위임("너가 그록봇 제어해서 사용해도 좋아") — CDP SEND 실전 성립(분류기 미차단 실측). 관측 릴레이 불요.
- **새 정본**: 성재 발제 "그록봇 원클릭 셀프호스트" 파이프라인이 우로보로스 인터뷰로 확정 — `research/2026-08-22-grokbot-one-click-selfhost-plan.md` (PLN-20260822-01, 결정 D1~D10·시리즈 R-1/R-2/T-1~T-4/V-1/E2E). Q-HOST는 이 계획의 R-1(VM 리셋 재검증) 결과에 종속되는 형태로 재프레이밍.
- **§3 스테이징 프로브**: 발사 완료(+영속성 프로브 추가) — 결과는 plan 문서 후속 갱신 참조.
