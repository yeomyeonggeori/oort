# Contributing to oort

> 영문 정본: [CONTRIBUTING.md](CONTRIBUTING.md). 이 파일은 한국어 원문입니다.

oort는 Apache-2.0으로 배포됩니다. 기여를 환영합니다.

행동 강령은 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant
v2.1)입니다. 보안 취약점은 공개 이슈가 아니라
[SECURITY.md](SECURITY.md)의 private advisory로 신고하세요. 변경 이력은
[CHANGELOG.md](CHANGELOG.md)입니다.

## DCO (Developer Certificate of Origin)

모든 커밋은 [DCO 1.1](https://developercertificate.org/)에 서명해야 합니다 — 커밋 메시지에 다음 서명을 포함하세요:

```
Signed-off-by: Your Name <your@email.com>
```

`git commit -s`로 자동 추가됩니다. DCO 서명은 "이 기여를 프로젝트 라이선스(Apache-2.0)로 제출할 권리가 나에게 있음"을 확인하는 것으로, 별도 CLA는 요구하지 않습니다.

## 기여 절차

1. 이슈로 논의를 먼저 여세요(설계 경계를 바꾸는 변경은 ADR 절차를 따릅니다 — `docs/adr/0100-*`).
2. PR은 작게, 테스트/검증 스크립트와 함께.
3. 하드 불변식(Postgres=SoT, 단일 쓰기경로, RLS FORCE, 자격증명 비유입 — `docs/architecture/overview.md`)을 위반하는 PR은 수용되지 않습니다.
4. UI 변경은 `.claude/skills/momo-design-taste` 규율의 검토를 거칩니다.

## PR 신뢰 게이트

canonical branch PR은 현재 head의 `PR CI gate`와 base-only
`Policy integrity gate`가 모두 필요합니다. 같은 GitHub Actions App/context만으로는
workflow provenance가 증명되지 않으므로 통합자는 후보 checkout의 스크립트를 실행하지
않습니다. ADR-0153 D5에 따라 현재 PR의 exact canonical base branch/HEAD에서 wrapper
bytes가 그 base와 일치하는 checkout으로 다음 exact-base wrapper를 머지 직전에 실행합니다.
wrapper는 base object의 verifier만 추출해 실행하며 worktree/candidate verifier bytes는 무시합니다.

```bash
scripts/verify_policy_integrity_from_base.sh \
  --repo yeomyeonggeori/oort --pr <PR-number>
```

보호 정책 파일 변경은 지정 policy owner `kwakseongjae`(GitHub user id
`87296259`)가 PR author여야 하며, 같은 지정 owner의 exact
`Policy-Integrity-Audit: <40sha>` comment 뒤 같은 owner가
`policy-change-approved` label을 적용해야 합니다. GitHub org에서는 해당 계정의
`author_association`이 `MEMBER`이므로 문자열 `OWNER`를 권한 증거로 사용하지 않습니다.
head/comment/label transition이 바뀌면 증거를 다시 만들어야 합니다. 세부 trust 및 bootstrap
절차는 `docs/GITHUB_OPS.md`와 `docs/LOCAL_PR_GATE.md`가 정본입니다.

## 시크릿

커밋에 자격증명이 들어갔는지는 게이트가 봅니다. 모든 프로파일이 이 검사를 포함하므로 따로 기억할 필요는 없고, 커밋 직후 단독으로 확인하고 싶으면 이쪽이 3초입니다.

```bash
scripts/local_gate.sh --profile secrets   # = 회귀 테스트 + scripts/check_secrets.sh
```

`gitleaks`가 필요하며(`brew install gitleaks`), 없으면 **건너뛰지 않고 실패합니다** — 스캐너 없이 얻은 초록은 깨끗한 히스토리와 검사되지 않은 히스토리를 구분하지 못합니다.

오탐이면 `.gitleaksignore`에 지문(`<commit>:<file>:<rule>:<line>`) 한 줄을 판정 근거와 함께 남기세요. **근거에 탐지된 값을 그대로 인용하지 마세요** — 인용문 자체가 새 탐지가 됩니다. 진짜 유출이면 지문을 추가하기 전에 먼저 키를 로테이션하세요. 자세한 규칙은 `docs/LOCAL_PR_GATE.md`의 "Secret scan gate (#1236)".

## 의존성 라이선스

oort는 permissive 스택입니다. 의존성을 추가·변경했다면 해당 게이트를 PR 전에 돌리고 결과를 붙이세요.

```bash
scripts/local_gate.sh --profile license   # cargo + npm 한 번에
```

정책 정본은 두 곳이며 **같은 정책을 두 번 적은 것**입니다 — 한쪽만 고치지 마세요.

| 대상 | 정책 | 게이트 |
|---|---|---|
| cargo (`server-rust`, `clients/desktop/src-tauri`) | 루트 `deny.toml` | `scripts/check_cargo_licenses.sh` (`cargo-deny` 필요) |
| npm (워크스페이스 루트 = `packages/momo-core`, `clients/web`, `clients/mobile`) | `scripts/check_npm_licenses.mjs`의 `ALLOWED` | 같은 스크립트 |
| GHCR 재배포 고지 (app + postgres 이미지) | 생성 산출물 `legal/generated/` (정책 아님) | `scripts/check_ghcr_notice_bundle.sh` + `scripts/tests/test_ghcr_notice_bundle.sh` |

- **허용**: MIT · Apache-2.0 · ISC · BSD 계열 · 0BSD · Zlib · Unicode-3.0 · Unlicense · CC0-1.0 · CDLA-Permissive-2.0 · BlueOak-1.0.0 · Python-2.0 · CC-BY-4.0(데이터) · **MPL-2.0**.
- **거부(fail-closed)**: GPL/AGPL/LGPL·SSPL·BUSL·EPL·CDDL·CC-BY-SA/NC 등 copyleft 및 상용 제한 계열, 그리고 **라이선스를 알 수 없는 것**.
- SPDX 표현식은 이름 매칭보다 **먼저** 평가합니다. `MIT OR Apache-2.0 OR LGPL-2.1-or-later`처럼 permissive 분기가 있는 OR는 통과하고, AND의 한쪽이 copyleft면 거부합니다.
- **MPL-2.0은 허용입니다**(2026-08-10 정정). MPL-2.0은 파일 단위 약한 카피레프트라 링크만 하는 저작물의 Apache-2.0 배포에 영향이 없고(MPL-2.0 §3.3), 현행 트리에 이미 30건이 있으며(cargo 5 = Servo CSS 스택 등 데스크톱 전용, npm 24 = lightningcss와 플랫폼 바이너리 — 서버 백본은 0건), 벤치마크 대상인 block/buzz도 자기 `deny.toml`에서 같은 결정을 했습니다. 이전 문구는 "MPL 계열 fail-closed 거부"였으나 게이트가 실제로 그것을 강제한 적이 없습니다.
- 목록에 없는 라이선스가 필요하면 **거부가 기본값입니다.** 두 정책 파일에 SPDX id를 추가하되 *어떤 패키지가, 왜 Apache-2.0 재배포와 양립하는지*를 주석으로 함께 남기세요. 조용한 확장은 리뷰에서 되돌립니다.

## 서드파티 고지

역할은 둘이고 한곳에만 적습니다.

- **정책(allow/deny)** — 위 표. `deny.toml` / `check_npm_licenses.mjs`를 이 섹션에서 넓히지 마세요.
- **고지(attribution)** — GHCR 두 이미지가 재배포하는 Cargo·`clients/web` npm 그래프. 정본은 `legal/generated/GHCR_THIRD_PARTY_NOTICES.txt`. 인덱스는 `legal/THIRD_PARTY_NOTICES.md`(현행 vs 역사). 이미지 동봉은 `LICENSE` · `NOTICE` · 인덱스 · 생성 bundle 네 파일.

`server-rust/Cargo.lock` 또는 `clients/web/package-lock.json`을 바꾸면 같은 PR에서 재생성하세요:

```bash
python3 scripts/generate_ghcr_notice_bundle.py generate
scripts/check_ghcr_notice_bundle.sh
```

`generate`는 `cargo metadata --offline`과 `npm ci --prefix clients/web`이 필요합니다. stale 게이트는 lockfile 해시만 보고 그 트리가 없어도 RED/GREEN을 가립니다. 누락 SPDX·LICENSE 파일은 fail-closed입니다. 자동화는 재현 가능한 인벤토리이지 법적 충분성 선언이 아닙니다.

**SwiftPM 라이선스 게이트(`scripts/check_spm_licenses.sh`)는 은퇴했습니다**(2026-08-10, #1201). `legal/THIRD_PARTY_NOTICES.md`의 SwiftPM 섹션은 그 시점의 **역사 스냅샷**입니다. 잔존 Swift 트리의 SwiftPM 의존을 바꾸는 경우 그 역사 섹션을 손으로 갱신하고 PR에서 근거를 밝히세요.

데스크톱 Tauri Cargo·모바일 npm·인앱 "Open Source Licenses" UI는 이 고지 bundle 밖입니다(#35).
