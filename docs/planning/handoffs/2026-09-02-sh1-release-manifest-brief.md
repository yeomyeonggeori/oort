# 워커 브리프 — SH-1 릴리스 매니페스트 `releases/latest.json` (engine · ADR 불요)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `.github/**` 무접촉(발행 워크플로는 이 티켓에서 바꾸지 않는다 — 매니페스트는 RELEASING 절차의 산출물). `scripts/**` 신규 파일 1개만 허용(정책 무결성 감사 대상 — 오케스트레이터가 감사).
> 근거: `docs/planning/2026-09-02-launch-program-plan.md` §5 SH-1 · 셀프호스팅 실사 갭 ②(digest 핀이 산문에 박혀 릴리스마다 낡음 — `docs/SELF_HOST.md` §2-B=v0.1.3, `docs/SELF_HOST_AGENT.md` §1.2=v0.1.1 **불일치 실물**).

## 구현 계약
1. **`releases/latest.json`**(레포 루트, 커밋 대상) — `{version, released_at, images:{app:{ref, digest_list, digests:{amd64,arm64}}, postgres:{…}}, attestation:{verify_cmd}, sources:{release_url}}`. 값은 현행 v0.1.3 Release·`docs/SELF_HOST.md` §2-B에서 옮긴다(추측 금지 — `gh release view v0.1.3`·`docker buildx imagetools inspect`로 실측한 digest만).
2. **`scripts/release_manifest.sh`** — 태그명을 받아 GHCR list/arch digest를 조회해 위 JSON을 생성·검증(정규식 `^sha256:[0-9a-f]{64}$`, list digest ≠ arch digest)한다. `docs/RELEASING.md` 절차에 "태그 → 매니페스트 생성 → 커밋" 1단계 추가.
3. **문서가 매니페스트를 가리킨다**: `docs/SELF_HOST.md` §2-B·`docs/SELF_HOST_AGENT.md` §1.2·`README.md` Self-host 절의 하드코딩 digest를 제거하고 `releases/latest.json`을 읽는 명령(`jq -r .images.app.digest_list releases/latest.json` 또는 raw URL curl)으로 교체. `self_host_env.sh --published-image`는 무변경(입력 형식 그대로).
4. **드리프트 게이트**: `scripts/check_release_manifest.sh` — ①매니페스트 JSON 스키마·정규식 ②`docs/SELF_HOST*.md`·`README.md`에 `@sha256:` 리터럴 0건(매니페스트 파일 제외) ③매니페스트 version이 `CHANGELOG.md` 최신 항목과 일치. `scripts/local_gate.sh` 편입은 **하지 않는다**(정책 파일) — 오케스트레이터가 별도 랜딩.

## red proof (선행 커밋)
- 매니페스트 digest를 한 글자 바꾸면 check 스크립트 붉음 · 문서에 `@sha256:` 한 줄 남기면 붉음 · version 불일치 붉음.
- `release_manifest.sh v0.1.3` 재실행이 커밋된 파일과 바이트 동일(멱등).

## 완료 절차
`bash -n` + shellcheck(있으면) + `scripts/check_release_manifest.sh` 그린 실측 → 커밋(이슈 번호 참조) → `git push -u origin feat/sh1-release-manifest` → `gh pr create --base track/engine` → 정지. PR 본문에 `## 계획 이탈`(없으면 "없음")과 게이트 결과.

## 규율
digest는 실측값만. 문서의 한국어 문면은 유지(영문화는 SH-4). 막히면 우회 말고 보고 후 정지.
