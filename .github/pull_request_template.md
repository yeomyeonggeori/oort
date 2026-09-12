<!-- 공용 계약: AGENTS.md. 필수 검증 등급/명령: docs/runbooks/development-validation.md.
한 이슈 = 한 PR. 해당하지 않는 항목은 N/A와 이유를 적고, 실행하지 않은 검증을 체크하지 않는다. -->

Closes #<issue>

## 한 일
<!-- 문제와 변경 후 동작. -->

## 작업 원본
- Branch / HEAD:
- Worktree:
- 담당 / 인계 대상:

## 검증
<!-- 변경에 해당하는 등급과 실제 명령·결과·환경. clean HEAD의 Local Gate 원문/로그를 링크한다.
Rust는 fmt --all / clippy -D warnings / workspace tests.
웹·폰·코어는 해당 트리와 병합 트리. UI는 독립 design-review B0/H0.
문서·운영 스크립트는 docs 게이트 및 관련 동작 시험. -->
- 검증 등급:
- 실행 결과 / 증거:
- runtime-unverified / 남은 검증:

## STATUS 영향
<!-- 검증된 변화 1–3줄 또는 STATUS 링크. -->

## 계획 이탈
<!-- 수용기준·ADR·패킷과 다른 점 및 영향. 없으면 없음. -->

## 남은 것 / 인계
- [ ] worker는 PR·검증을 인계하며 merge/close하지 않는다.
- 후속 작업:

<!-- 공개 API/보안/DB/방향/스택 변경 시 Accepted ADR 링크를 적는다.
통합자는 current PR CI·Policy integrity·exact-base verifier와 local evidence를 확인한다.
M7/owner 승인 없는 release·스토어·공증·external TestFlight는 진행하지 않는다. -->
