# 로컬 자원 회수 파이프라인 (게이트·검수 런 수명주기)

> 2026-08-14 신설. 로컬 게이트/소크/검수 런이 만드는 Docker 자원·워크트리·고아 프로세스를
> **만든 쪽이 회수를 증명**하는 층(1)과, 새는 것을 기계적으로 쓸어담는 층(2·3)으로 나눈다.
> 전례: Docker VM CPU 146~214% 발열(2026-07), Docker Desktop 데몬 붕괴→재설치(2026-08-13~14, #1364/#1365 런타임 차단).

## 층 1 — 런 단위: verifier 소유권 계약 (신규 verifier의 표준)

`scripts/verify_hosted_agent_inbox.sh`(#1365)·`scripts/verify_agent_port.sh`(#1363)가 정본 패턴이다.
새 runtime verifier는 다음을 전부 갖춰야 한다:

1. **호출 단위 소유권 라벨** — `--label com.momo.<name>.invocation=<랜덤 hex>` + `com.momo.janitor.managed=true`.
2. **외부 DATABASE_URL 거부** — 격리 Docker 강제(개발 DB 오염·오판 차단).
3. **trap 기반 cleanup** — EXIT/INT/TERM에서 소유 컨테이너만(`인스펙트 ID+이름+라벨 3중 결속` 확인 후) `rm -f -v`.
4. **부재 증명 후에만 PASS** — 제거 뒤 재조회로 tri-state(존재/부재 증명/데몬 모호) 판별. 데몬 모호는 실패로 처리.
5. **cleanup 계약 자체 테스트** — `--verify-cleanup-contract` 모드를 static gate에 배선.

## 층 2 — 레포 janitor (랜딩 직후 + 주간)

머지/랜딩 사이클을 닫을 때마다:

```sh
scripts/compose_janitor.sh --cleanup        # momo_*/momo240_* compose 스택 (활성 워크트리 보호)
scripts/worktree_janitor.sh                 # dry-run 보고 → 판단 후
scripts/worktree_janitor.sh --cleanup       # RECLAIM(랜딩+clean)만 제거. JUNK는 --include-junk-dirty
```

`worktree_janitor.sh` 분류:
- **KEEP** — 주 워크트리·track/*·`deploy*`(env `WORKTREE_JANITOR_KEEP`로 확장).
- **RECLAIM** — main/track/engine ancestor이거나 head 브랜치의 PR이 머지됨(squash 대응) + tree clean. 자동 제거 대상.
- **JUNK** — 랜딩됨 + dirty가 junk(node_modules/.DS_Store/target/dist/*.log)뿐.
- **HOLD** — goal 이슈 OPEN, 실 미커밋 작업 보유, 판정 불가. **절대 자동 제거 안 함** — 사람이 삼거리 판정.

제거는 항상 `git worktree remove`(브랜치 ref 보존) — raw `rm -rf` 금지.
워크트리 디스크의 주범은 cargo `target/`(worktree당 6~20GB)이므로, **goal 랜딩 = 워크트리 회수**를 머지 루틴의 마지막 스텝으로 삼는다.

## 층 3 — 머신 안전망

```sh
~/.local/bin/momo-docker-reclaim.sh --dry-run    # 정지 momo 스택·게이트 이미지·dangling momo 볼륨·빌드캐시
~/.local/bin/momo-docker-reclaim.sh              # 실행 (RUNNING 컨테이너·타 프로젝트 불가침)
~/.local/bin/momo-docker-reclaim.sh --aggressive # 워크트리 소멸+유휴 커넥션 0인 크래시 잔존 스택까지
```

### Docker Desktop 데몬 붕괴 플레이북 (2026-08-13~14 실사례)

증상: `docker info` 무응답/타임아웃, 컨테이너 create가 부팅 전 실패, 내부 metadata/network DB I/O 오류.
자원 잔존과 무관하게 데몬 자체가 죽는 모드가 실재한다(#1364 runtime-unverified·#1365 지연의 원인).

1. Docker Desktop 재시작(메뉴 Restart) → `docker info` 30초 내 응답 확인.
2. 실패 시 디스크 확인(`docker system df` 불가면 호스트 여유 디스크) → 층 3 reclaim 후 재시도.
3. 그래도 실패면 Troubleshoot → Clean/Purge data(로컬 이미지 전멸 — verifier 이미지는 pinned digest라 재pull로 복원).
4. 최후: 재설치. **재설치 후 pinned 이미지 재pull은 verifier 첫 런에서 자동**.

## 알려진 함정: actionlint 1.7.12 무한 스핀 (2026-08-14 진단)

- Homebrew actionlint 1.7.12(go1.26.3, darwin/arm64)가 **shellcheck 연동 계층에서 CPU 800%로 무한 스핀**한다
  (25 CPU-분 실측). shellcheck 자체는 동일 스크립트를 0.04초에 처리, `-shellcheck=`로 연동을 끄면 즉시 통과.
  다변수 `run:` 블록 조합에서 발화하며 단일 라인 재현은 안 됨 — 통합 파이프 처리 결함으로 판정.
- **현행 완화: `brew unlink actionlint`** (2026-08-14 적용). local_gate는 actionlint 부재 시
  "워크플로 변경 없으면 skip / 변경 있으면 명시 실패" 폴백이 설계돼 있어 안전하다.
- 워크플로 파일을 실제 변경하는 PR은: 새 버전 확인(`brew upgrade actionlint` 후 재현 테스트) 또는
  일회성 `/opt/homebrew/Cellar/actionlint/1.7.12/bin/actionlint -shellcheck= <files>`.
- 항구 수리(티켓): local_gate의 actionlint 스텝에 하드 타임아웃 + 타임아웃 시 `-shellcheck=` 재시도.

## 고아 프로세스

게이트 킬/중단 후 `ps aux | grep -E 'cargo|actionlint|postgres|node'`로 잔존 확인.
런어웨이 CPU(위 actionlint 사례처럼 수백%)는 즉시 kill — Docker VM 발열의 상당분이 이 클래스였다.
