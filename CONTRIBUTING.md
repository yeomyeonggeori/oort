# Contributing to oort

oort는 Apache-2.0으로 배포됩니다. 기여를 환영합니다.

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
| SwiftPM (은퇴 예정) | `scripts/check_spm_licenses.sh` | `--profile swift` |

- **허용**: MIT · Apache-2.0 · ISC · BSD 계열 · 0BSD · Zlib · Unicode-3.0 · Unlicense · CC0-1.0 · CDLA-Permissive-2.0 · BlueOak-1.0.0 · Python-2.0 · CC-BY-4.0(데이터) · **MPL-2.0**.
- **거부(fail-closed)**: GPL/AGPL/LGPL·SSPL·BUSL·EPL·CDDL·CC-BY-SA/NC 등 copyleft 및 상용 제한 계열, 그리고 **라이선스를 알 수 없는 것**.
- SPDX 표현식은 이름 매칭보다 **먼저** 평가합니다. `MIT OR Apache-2.0 OR LGPL-2.1-or-later`처럼 permissive 분기가 있는 OR는 통과하고, AND의 한쪽이 copyleft면 거부합니다.
- **MPL-2.0은 허용입니다**(2026-08-10 정정). MPL-2.0은 파일 단위 약한 카피레프트라 링크만 하는 저작물의 Apache-2.0 배포에 영향이 없고(MPL-2.0 §3.3), 현행 트리에 이미 30건이 있으며(cargo 5 = Servo CSS 스택 등 데스크톱 전용, npm 24 = lightningcss와 플랫폼 바이너리 — 서버 백본은 0건), 벤치마크 대상인 block/buzz도 자기 `deny.toml`에서 같은 결정을 했습니다. 이전 문구는 "MPL 계열 fail-closed 거부"였으나 게이트가 실제로 그것을 강제한 적이 없습니다.
- 목록에 없는 라이선스가 필요하면 **거부가 기본값입니다.** 두 정책 파일에 SPDX id를 추가하되 *어떤 패키지가, 왜 Apache-2.0 재배포와 양립하는지*를 주석으로 함께 남기세요. 조용한 확장은 리뷰에서 되돌립니다.

## 서드파티 고지

SwiftPM 의존성을 추가·변경했다면 `scripts/check_spm_licenses.sh --write`로 `legal/THIRD_PARTY_NOTICES.md`를 재생성하고 변경을 같은 PR에 포함하세요. `--check`는 각 SwiftPM 그래프의 checkout LICENSE 원문과 고지 드리프트를 검사합니다.

> 주의: 이 SwiftPM 게이트는 현재 실패 상태입니다 — 기대 루트 수(10)와 실제(11, `services/MomoMetrics` 등 추가분)가 어긋납니다. Swift 트리 은퇴 작업에서 함께 정리하며, 그때까지 `--profile swift`/`--profile all`은 이 단계에서 빨강입니다. 위 cargo·npm 게이트(`--profile license`)는 이와 독립이며 초록입니다.

cargo·npm 의존성의 **고지(NOTICE) 생성**은 아직 자동화되어 있지 않습니다 — 현재 `legal/THIRD_PARTY_NOTICES.md` 커버리지는 SwiftPM 그래프뿐입니다. 라이선스 *검사*는 위 표대로 전 스택을 덮습니다.
