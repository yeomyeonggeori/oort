<!--
momo PR 템플릿 — AGENTS.md §7 정본. 한 PR = 한 이슈 = 한 goal.
머지 전 `make build`(swift build) green 필수. main 직접 push 금지(브랜치 보호 가정).
검증 등급: [swift]=swift build green · [infra]/[sql]=파일 존재+정본 정합 · [python]=py_compile ·
[xcode]=xcodebuild 산출 · [ci]=워크플로우 syntax/lint · [runtime]=docker/psql 필요(미가용 시 runtime-unverified) · [manual]=사람 1회.
-->

Closes #<issue>

## 한 일
- <!-- 변경 요약 bullet. 무엇을 done 상태로 만들었나. -->

## Goal / Worktree
- Issue: #<issue>
- Branch: `<type>/<issue>-<slug>`
- Worktree: `<local path>`
- Worker lane: `<runtime/backend|macOS UX|docs/spec/protocol|infra/devtooling>`

## 검증 (등급: [swift]/[infra]/[sql]/[python]/[xcode]/[ci]/[runtime]/[manual])
- [ ] Local gate: `scripts/local_gate.sh --profile <docs|swift|runtime-db|runtime-agent|macos-ui>` PASS, or scope-specific manual runtime evidence attached
- [ ] [swift] `swift build` green: <패키지>
- [ ] 선행 패키지 빌드 안 깨짐 (`make build`)
- [ ] [sql] schema_v0.sql 정합 (정본 미수정 — 확장은 server/Migrations/NNN_*.sql 신규 + RLS DO-block ARRAY 등록)
- [ ] runtime 미검증 부분 정직 표기 (no docker/psql) — `runtime-unverified`

## Local Gate Evidence
<!-- `scripts/local_gate.sh`가 출력한 ## Local Gate 블록을 붙인다. GitHub Actions disabled/manual-only 기간에는 이 evidence가 primary merge gate다. -->

## STATUS 영향
- <!-- STATUS.md에 반영한 줄(무엇이 추가/변경, 무엇이 여전히 미검증). -->

## 🔒 게이트 / 배포 불변식 (해당 시)
- [ ] 이 PR은 `release-ios.yml`/`release-macos.yml`을 **트리거하지 않는다** (M7 게이트 PASS + docs/cicd/03 PASS 블록 기록 전까지 release 금지)
- [ ] (M4/M5 스토어 관련이면) 검수 게이트(M7) 선행 의존 표기

## 남은 것 / 후속 이슈 제안
- <!-- 스코프 밖이라 새 이슈로 뺀 것. -->

---
- [ ] 시크릿 미커밋(.env), `.build/`·`*.resolved`·`DerivedData/` 미포함, 무관한 리팩터 없음 (AGENTS.md §5)
- [ ] 법무/스토어 정책 관련 텍스트는 1차 출처 링크 + "(추정)" 표기 — **법률 자문 아님**
