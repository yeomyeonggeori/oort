# 런칭 위생 파도(L-파도) 통합 패킷 — 태그/릴리스·CI 시크릿·기여자 첫 빨강·커뮤니티 문서

- status: ready · planning: PLN-20260815-01 · owner: Fable(momo-main) · integrator: momo-main
- 기준 커밋: `origin/track/engine`(스냅샷 46 이후) · main=`45a154d2`(발행 이미지 빌드 커밋)
- 결재: 성재 2026-08-21 "너가 작업하고, 내가 실 테스트해야하는 부분 전까지 작업 ㄱㄱ" + interview_20260820_074206 Q5(CoC=Contributor Covenant)
- 거버넌스 전제(성재 확정 2026-08-21): **org Owner 승격 없음** — kwakseongjae=member 유지. org/패키지 관리 작업은 필요 시 owner(여명) 1회 요청(새 패키지 생성 시에만 발생).
- 워커: grok 4.6 **병렬 1 순차** · 검수: Fable · supersedes: 없음

## goal 체인·순서

| 순서 | goal | 이슈 | 파일군 |
|---|---|---|---|
| G1 | L3 릴리스 준비(문서·초안) | #1628 | docs/RELEASING.md(신설)·docs/SELF_HOST.md·CHANGELOG 초안 인계 |
| G2 | L4 CI gitleaks 레인 | #1629 | .github/workflows/pr-ci.yml·scripts/tests/test_pr_ci_guardrails.sh |
| G3 | L7 기여자 첫 빨강 2건 | #1267·#1268(기존) | clients/web 테스트(TZ)·clients/mobile 테스트(리눅스 waitFor) |
| G4 | L5+L6 커뮤니티 문서 | #1630 | CODE_OF_CONDUCT.md·CODEOWNERS·CHANGELOG.md·CONTRIBUTING.md |

태그 push·GitHub Release 생성은 **오케스트레이터 집행**(G1 랜딩 후 — 워커 push 금지 규율 유지).

## G1 — L3 릴리스 준비 (#1628)

**사실**: 발행 digest 2본(원장 #1332 코멘트 2026-08-21) — app `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb`·postgres `ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757`, 빌드 커밋 main=`45a154d2`, attestation 검증 PASS. Apple Silicon native pull 불가(amd64 단일 — 실측 2026-08-21).

**작업**:
1. `docs/RELEASING.md` 신설 — 서버/이미지 릴리스 절차: 승격→발행(dispatch·owner 승인)→digest 수거→태그(빌드 커밋에)→Release(digest 표 기재)→SELF_HOST 문면 갱신. 데스크탑 next 채널(NEXT_CHANNEL §8)과의 경계 1절.
2. `docs/SELF_HOST.md` §2-B — placeholder(`REPLACE_WITH_64_LOWERCASE_HEX`)를 실 digest 예시+«최신 digest는 GitHub Releases에서» 문면으로 현행화. `:88` 라벨(「첫 workflow dispatch와 GHCR 왕복 runtime-unverified」)을 실측 완료로 갱신(발행·익명 pull·attestation 실측 좌표 병기). **amd64 단일 경계 문면은 유지·강화**(Apple Silicon 실측 반영).
3. Release notes 초안(`v0.1.0`) — 톤: README 정직성 표와 동형(Works today/Being wired up), digest 표, 검증 커맨드(`gh attestation verify`), amd64 한정 고지. 버전 택일 `v0.1.0` 권장(데스크탑 0.1.0-next.N과 계열 정합) — 이견 있으면 택일 상신.
**AC**: RELEASING 단독 완주 가능 · SELF_HOST digest 경로가 실값 문면 · 라벨 갱신에 실측 좌표 · notes 초안이 발명 0(실측·원장 인용만).

## G2 — L4 CI gitleaks (#1629)

**사실**: `scripts/check_secrets.sh`=gitleaks `--log-opts --all`(로컬 전용). `.gitleaksignore` 133지문(공개 전 전수 트리아지 완료). CI에는 시크릿 레인 0.
**작업**: pr-ci.yml에 gitleaks 잡 추가 — PR diff 범위(전 히스토리 재스캔 아님·베이스라인 재사용)·gitleaks 버전 pin·fail-closed. `changes` 경로 필터와의 관계(시크릿은 전 경로 상시가 원칙 — 예외 없이 항상 실행 권장, 택일 상신 가능). `test_pr_ci_guardrails.sh` 단언 가산.
**함정**: pr-ci.yml=**보호 정책 파일** — 랜딩 시 오케스트레이터가 policy 마커 절차. fork PR에서 secrets 불요(gitleaks는 토큰 없이 동작)·`pull_request` 이벤트 유지(pull_request_target 금지).
**AC**: 합성 시크릿 픽스처로 RED 증명 1회·기존 트리 GREEN·가드레일 테스트 그린.

## G3 — L7 기여자 첫 빨강 (#1267·#1268 기존 이슈)

**사실**: #1267=web quotaModel 테스트 TZ 미고정(외부 기여자 첫 빨강 후보)·#1268=mobile inboxApproval 리눅스 waitFor 예산. 이슈 본문이 계약.
**작업**: 각 이슈 AC대로 결정적 수정(TZ 고정/주입·waitFor 예산 재조정). 두 건 파일군 분리 — 한 워커가 순차 처리, 커밋 분리.
**AC**: 해당 스위트 로컬 그린 + 결정성 근거(반복 실행) 표기.

## G4 — L5+L6 커뮤니티 문서 (#1630)

**작업**: ①`CODE_OF_CONDUCT.md`=Contributor Covenant v2.1 표준문(연락처=SECURITY.md의 신고 경로 재사용 — 새 이메일 발명 금지) ②`CODEOWNERS`=최소형(`* @kwakseongjae`) ③`CHANGELOG.md`=Keep a Changelog 형식 시드(v0.1.0 항목=G1 notes 요약) ④`CONTRIBUTING.md` 영문판 — 택일 상신: 별도 CONTRIBUTING.en.md vs 본문 이중언어(권장: 영문 본문+한국어 원문 링크 또는 역순 — 논거 포함).
**함정**: README/SECURITY와 문면 충돌 금지·거버넌스 문서는 만들지 않음(1인 프로젝트 단계).
**AC**: 4파일 존재·상호 링크 정합·check_docs_commands 그린.

## 공통 규율
push/PR/머지 금지(로컬 커밋만) · 시크릿 비유입 · 발명 금지(실측·원장 인용) · 이탈은 최종 보고 `## 계획 이탈` · 착수=`scripts/goal_claim.sh --base track/engine <이슈>`.

## 오케스트레이터 후속(G1 랜딩 후)
`git tag v0.1.0 45a154d2` + push · `gh release create v0.1.0`(notes=G1 초안·digest 표) · SECURITY.md 약속 성립 확인 · 릴리스는 main 기준(태그는 승격 커밋에 — track 랜딩과 무관).
