# 핸드오프 패킷 H-FIX1 — Podfile.lock hermes-engine 체크섬 결정성 수리

- status: **ready** · planning: 배치 1(독립 레인 — TestFlight 전제) · owner/integrator: Fable(momo-main)
- worker: Opus 5 · 기준 브랜치: **`track/engine`** · 작업 레포: `~/projects/momo-tracks/engine` 기준의 **새 워크트리**
- 근거: 2026-08-03 오케스트레이션 세션 보고(JOURNAL 밤 항목 신규 티켓 후보 ①) — **아직 재현되지 않은 보고다**
- supersedes: 없음

## 0. 왜 이 티켓인가

전 세션 보고: *"커밋된 `Podfile.lock`의 `hermes-engine` 체크섬이 이 머신 `pod install` 결과와 달라 **깨끗한 체크아웃에서 Release 빌드가 실패**한다 — TestFlight 레인에서 터질 것."* 사실이면 CI/TestFlight 레인 전체가 막힌다. **단, 이 보고는 검증 세션(2026-08-04)이 재현하지 못했다(재현 시도 안 함).** 그래서 이 티켓의 1단계는 수리가 아니라 **재현**이다.

## 1. Goal (순서 엄수)

1. **재현**: 깨끗한 상태(새 워크트리, Pods/ 없음, CocoaPods 캐시 영향 기록)에서 `pod install` → `git diff clients/mobile/ios/Podfile.lock`으로 hermes-engine 항목 변동 여부를 실측. 재현 조건(캐시 유무·`pod repo update` 여부·CocoaPods/Xcode 버전)을 표로 기록.
2. **재현되면**: 원인 확정(예: RN 버전의 hermes prebuilt tarball 재발행, CDN specs 드리프트, 로컬 캐시 오염) → **결정적 lock**으로 수리 → 게이트: 깨끗한 체크아웃에서 `pod install` 2회 연속 diff 0 + Release 빌드가 lock과 일치.
3. **재현 안 되면**: **"재현 불가"가 결론이다.** 추정 수리 금지(전 세션의 확정 교훈: 실패 원인을 추정으로 먼저 말하지 않는다). 재현 시도 조건 전부를 기록한 문서형 PR로 종료.

## 2. 파일 맵

| 무엇 | 위치 |
|---|---|
| 커밋된 lock의 hermes 항목 | `clients/mobile/ios/Podfile.lock:77-79` — `hermes-engine (250829098.0.16)` / `hermes-engine/Pre-built` |
| Podfile | `clients/mobile/ios/Podfile` |
| RN 버전 고정 | `clients/mobile/package.json` |
| Release 빌드 선례 | 2026-08-03 세션이 `app.momo.ios`(팀 YWQQFQM38J, NSE 포함) Release 빌드를 이 머신에서 구웠다 — 그 빌드가 어느 lock으로 구워졌는지가 단서 |

## 3. 지켜야 할 계약

- **수정 범위 = `clients/mobile/ios/**`(+필요시 `clients/mobile/package.json`·문서).** src 코드 수정 금지. 병렬 티켓 M-AP1이 `clients/mobile/src`를 만진다 — 겹치지 않는다.
- 네트워크 접근(CDN specs·tarball)은 재현에 필요한 만큼만, 실행한 명령을 전부 PR에 기록.
- Xcode 프로젝트 서명 설정 변경 금지.

## 4. 함정

- CocoaPods는 로컬 specs 캐시(`~/.cocoapods`)·`Pods/` 캐시에 따라 결과가 갈린다 — "깨끗함"의 정의를 명시하고 두 조건(캐시 유지/제거) 모두 실측하라.
- hermes-engine은 RN 릴리스가 prebuilt tarball을 재발행하면 같은 버전 문자열에 체크섬만 바뀌는 전례가 있는 계열이다 — 버전 문자열 동일성에 속지 마라.
- `pod install`이 lock을 조용히 다시 쓰는 경우, diff의 **어느 줄**이 바뀌었는지가 원인 분리의 단서다(hermes만인지, 전반인지).

## 5. 검증 (PASS 기준)

- 재현 여부와 무관하게: 재현 매트릭스(조건×결과) 표가 PR에 있다.
- 수리한 경우: 깨끗한 워크트리에서 `pod install` 2회 연속 `Podfile.lock` diff 0 · Release 빌드(시뮬레이터 대상이어도 됨) 성공.

## 6. 이탈 보고 의무

PR 본문 `## 계획 이탈` 절. 특히 "원인이 Podfile.lock이 아니라 다른 곳"으로 판명되면 수리 범위를 넓히지 말고 보고.

## 7. 착수

```bash
cd ~/projects/momo-tracks/engine && git fetch origin track/engine && \
git worktree add ~/projects/momo-tracks/momo-worktrees/H-FIX1-hermes -b feat/H-FIX1-hermes-lock origin/track/engine
```
작업 → 커밋 → push → `gh pr create --repo Dawn-kim-official/momo --base track/engine` → **STOP** (머지 금지).
