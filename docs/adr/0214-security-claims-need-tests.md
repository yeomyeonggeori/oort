# ADR-0214: 보안 주장은 시험이 없으면 공개하지 않는다 (claims.yaml · CI 린트 · 「하지 않는 것」)

- Status: **Proposed** (2026-10-25). 독립 보안 검수 PASS(Blocker 0·High 0) 뒤 Accepted로 올린다. 근거 결정: 성재 2026-10-21 「보안 = 자체 테스트 + 공개 증거」, 위임 2026-10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 → 리서치 D6 「하지 않는 것」 절 공개.
- Date: 2026-10-25
- Deciders: 성재
- 기안: Sonnet 5.5 엔진 워커 (#4224, SEC-02). 리서치 r1 §5-A·§5-B.
- 관계: ADR-0100(거버넌스) · ADR-0153(CI 스택, 필수 컨텍스트) · ADR-0004(자격증명 경계) · #4241 SEC-03 Security pack · #4242 SEC-04 카탈로그 시험 · #4246 SEC-08
- 번호 확인 [V, 2026-10-25]: `origin/main`·`track/engine`·`track/uxui`와 모든 원격 브랜치의 `docs/adr/`는 0208이 마지막이다. 열린 이슈 본문은 0206·0207(#4213), 0209~0211(#4213), 0212·0213(#4240 등)을 예약했고 0214 이상은 어디에도 없다. 이 ADR은 **0214**만 쓴다.
- 표기: [V] 이 세션에서 직접 확인 · `runtime-unverified` 실행하지 않음. 이 ADR의 린트와 적색 시험은 로컬에서 실행했다. PR CI 편입은 아직 하지 않았다(결정 D6).

## 맥락

[V] 공개 보안 문장이 코드와 어긋난 사례가 있었다(r1 §3.5: 「provider 비밀이 DB에 들어가지 않는다」, 「API 기동 시 역할 가드」, 닫힌 신고 창구). 문장을 고치는 것으로는 다시 어긋난다. 어긋남을 **빨간 체크**로 만드는 장치가 없었다.

Slack의 신뢰는 다년 인증 이력이고 oort는 그것을 시간 없이 따라갈 수 없다. oort가 낼 수 있는 근거는 「주장마다 공개 CI 시험이 붙고, 깨지면 빨강」이다. 레포가 공개라 CI 런과 PR 본문이 그대로 증거가 된다.

## 결정

**D1. 공개 약속.** 보안 주장은 증명 시험이 있어야 공개한다. 시험이 없으면 문장을 쓰지 않거나 「하지 않는 것」으로 쓴다. 「미검증」인 채로 주장을 두지 않는다.

**D2. `docs/security/claims.yaml`이 정본이다.** 주장마다 ID·한 문장·범위(한계 포함)·`priority`·`runs`·`proofs`(시험 선택자)·P0의 `sabotage`를 둔다. 문장은 시험이 단정하는 것보다 넓게 쓰지 않는다(린트가 못 잡는 규칙이므로 검수가 본다). 초기 34개.

**D3. 린트 `scripts/check_security_claims.py`.** 파일만 읽는다(컴파일러·DB 불요). 다섯 가지를 exit 1로 막는다.

| 코드 | 빨강 조건 |
|---|---|
| E0 | 형식 문제: 중복 id·중복 yaml 키(PyYAML이 있어도 거부), 알 수 없는 최상위 키(오타로 절이 조용히 사라지는 것 방지), 알 수 없는 priority·runs |
| E1 | 증명 선택자가 하나도 없다 |
| E2 | 선택자가 가리키는 것이 없다. Rust는 `fn NAME(` 줄 위에 `#[test]`/`#[tokio::test]`/`#[sqlx::test]`가 있어야 한다(줄 주석·블록 주석·문자열·raw string 안의 이름, `#[cfg(any())]`·never-enabled feature로 컴파일에서 빠진 시험은 통과하지 못한다). TS는 `it`/`test`의 **정확한 제목**이고(주석·문자열 안은 제외) `skip`/`todo`·`describe.skip`·`xdescribe` 안이 아니어야 한다. 스크립트는 non-comment·non-echo 줄에서 경로 전체가 단어 경계로 pr-ci.yml이나 local_gate.sh에 나타나야 한다 |
| E3 | `runs:` 약속보다 약한 레인에서만 도는 증명이 있다(아래 레인 표) |
| E4 | P0 주장에 `sabotage.how`·`sabotage.evidence`가 없다. 증거는 음성 대조 이름(control/red/sabotage/negative)의 시험 선택자이거나 `scripts/tests/`의 회귀 스크립트여야 하고, 증거가 도는 레인이 주장의 `runs:`보다 약하면 안 된다(저장소의 아무 파일이나 적는 것을 막는다) |
| E5 | `limits:` 항목의 표식 `<!-- limit:ID -->`가 지정 문서에 없거나 코드 블록 안이거나 뒤에 문장이 없다. 필수 LIM-1~4가 파일에서 빠져도 빨강이다 |

레인(강→약): **pr-ci** = `server-rust/` 아래 `#[ignore]` 아닌 Rust 시험(`cargo test --workspace`), `#[ignore]`이면 `(패키지, tests/<타깃>)`이 `infra/security-pack/selection.txt`에 있는 것(Security pack 잡), core·web·mobile의 vitest/jest, pr-ci.yml이 부르는 스크립트. **nightly** = 그 밖의 `#[ignore]` Rust 시험(security-nightly.yml이 전부 돈다). **local** = local_gate만 부르는 스크립트, `server-rust/` 밖 Rust. 참고: pr-ci의 Rust·TS 레인은 변경 경로로 선택된다(`pr-ci`의 「변경 경로로 레인 선택」). 린트는 그 선택을 모사하지 않으므로 「PR이 그 경로를 안 건드리면 안 돈다」는 남는 한계다.

**D4. P0는 사보타주 증거가 필수다.** P0 = 경계 자체를 지키는 주장(테넌트 격리·의존성 게이트·unsafe 금지). 증거는 같은 검사에 깨진 입력을 먹여 빨강을 확인하는 **저장소 안의 음성 대조**(예: `tenant_catalog_pg.rs`의 `control_*_is_red`, `scripts/tests/test_advisory_gate.sh`)여야 한다. 음성 대조가 아직 없는 주장은 P1이며, P1→P0 승격은 대조를 넣는 이슈의 몫이다.

**D5. 「하지 않는 것」과 「공개하지 않는 것」.**
- 하지 않는 것(문서 `SECURITY.md`·`docs/security/README.ko.md`, 표식 LIM-1~4): E2EE가 아니다(서버는 내용을 읽는다) · 외부 감사·침투 시험 없음 · SOC 2 등 인증 없음 · 서버 운영자는 평문을 볼 수 있다. 비교 근거 [V 2026-10-25]: Slack 보안 페이지는 TLS 1.2+·저장 암호화를 설명하고 종단 간 주장이 없다(slack.com/resources/why-use-slack/security-at-slack). Zulip 보안 모델은 root 권한자가 「메시지를 읽고 기록을 고칠 수 있다」고 적는다(zulip.readthedocs.io/en/latest/production/security-model.html).
- 공개하지 않는 것: 수정 전 취약점 세부 · 운영 인스턴스 설정값·시크릿 · 공격 단계 수준의 위협 모델(요약만) · 프롬프트 인젝션 공격 코퍼스(방법·통계만) · 운영 환경 스캔 결과. 공개하는 것: 통제 목록, 시험 이름, CI 링크, 수정이 끝난 GHSA.

**D6. 정책 파일 취급.** `docs/security/claims.yaml`·`scripts/check_security_claims.py`·`scripts/tests/test_security_claims.sh`는 `verify_policy_integrity.sh`의 정책 경로다(지정 owner exact-head audit 규칙, GITHUB_OPS). 린트와 그 적색 시험은 `local_gate.sh` 정적 단계에 있다. **PR CI 잡 편입(`.github/`)은 이 PR이 하지 않는다**: `.github` 정책 PR 절차를 따르는 후속 이슈의 몫이며, 편입 전까지 이 장치는 local gate에서만 막는다. SECURITY.md가 이 사실을 그대로 적는다(공개 문서가 PR CI가 막는다고 읽히지 않게).

**D7. selection.txt 파생은 보류.** SEC-03(#4378)이 말한 「selection.txt를 claims.yaml에서 파생」은 지금 하지 않는다. 이유: ① 시험 선택자는 함수 단위이고 selection은 타깃 단위라 파생하면 claims 한 줄이 CI 범위를 바꾼다 ② selection에는 주장 없는 타깃 15개가 있다(린트가 note로 출력) ③ `momo-agent/approval_pg`처럼 낡아서 뺀 타깃을 주장이 가리킬 수 있어야 한다(AGT-1은 nightly로 둠). 대신 린트가 한 방향을 강제한다: `runs: pr-ci`인 `#[ignore]` 증명은 selection에 있어야 한다(E3). **결정(2026-10-25): 파생은 보류하고 한 방향 강제(E3)를 유지한다.** 완전한 파생 또는 동등성 검사는 selection 정리(`approval_pg` 복귀)가 끝난 뒤 다시 본다.

## 결과와 한계 [V = 로컬 실행]

- [V] 34개 주장이 모두 해석되고 `runs` 약속을 지킨다. 린트가 초안에서 실제로 하나를 잡았다: CRED-2의 증명 하나가 PR CI에서 돌지 않는 시험이라(E3) 단정을 단위 시험이 증명하는 범위로 좁혔다.
- 이 ADR이 만든 초기 목록은 r1 초안에서 **시험이 없는 문장을 뺐다**: 레이트 리밋(AUTH-3 초안, 코드에 `there_is_no_rate_limiter` 시험이 있음), API 기동 시 역할 가드(없음), 감사 로그 불변성, 릴리스 이미지 provenance(시험이 아니라 수동 `gh attestation verify`). 이 중 SECURITY.md가 이미 서술 중인 것은 주장이 아니라 설명이며, 주장 ID가 붙지 않은 서술을 린트가 찾지는 못한다(문서→주장 역방향 검사는 후속).
- 린트는 시험이 **있는지**와 **어느 레인에서 도는지**를 본다. 시험이 문장을 충분히 증명하는지는 보지 못한다(검수와 P0 사보타주 몫).

## 후속

1. PR CI 편입(`pr-ci.yml`의 lint 단계 또는 docs 레인) + `Policy integrity` 승인.
2. `approval_pg` 수리 뒤 selection 복귀(AGT-1을 pr-ci로)와 그때 D7 재검토.
3. 문서의 주장 문장마다 claim ID를 다는 역방향 검사.
4. P1→P0 승격 대조 추가(웹훅 위조·refresh 재사용 등).
5. 린트의 알려진 한계: 시험 본문이 비어 있어도(assert 삭제) 초록이다. P0는 저장소 안 음성 대조가 덮고, P1은 검수가 본다.
