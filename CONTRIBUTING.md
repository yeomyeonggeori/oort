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

## 서드파티 고지

의존성 추가/변경 시 `scripts/check_spm_licenses.sh --write`로 `legal/THIRD_PARTY_NOTICES.md`를 재생성하고 변경을 같은 PR에 포함하세요. `--check`는 9개 SwiftPM 그래프의 checkout LICENSE 원문과 고지 드리프트를 검사하며, GPL/AGPL/LGPL/MPL/SSPL/BUSL 계열은 fail-closed로 거부합니다.
