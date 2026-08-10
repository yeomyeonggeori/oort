# 공개 집행 지시서 (2026-08-10 · 우로보로스 인터뷰 `interview_20260810_054100` 수렴)

> 성재 결정 5건 — 인터뷰 4라운드(응답자=성재 본인)로 확정. ambiguity 0.11 수렴.

## 결정

| # | 항목 | 결정 |
|---|---|---|
| ① | 공개 범위 | **전부 그대로** — docs/planning 378파일·실명 260파일(내부인뿐 — 제3자 리스크 없음 확인)·buzz 경쟁분석 3종 포함. 필터링·히스토리 재작성 없음. 기획·감사 기록 = 공개 자산 |
| ② | 시점·형태 | **준비 되는 대로 조용히 public**(soft launch·별도 홍보 없음) |
| ③ | 런칭 정의 | **외부 셀프호스터 3명 이상 + 에이전트 멘션·런 실사용**. 레포 공개는 시작이지 런칭이 아님. 앱스토어 제출은 별도 트랙(privacy-policy는 그때 — 현재 비차단) |
| ④ | 공개 직후 자동 해제 | Actions 무료화 → CI 풀 스위트 확장 가능 · GHCR `ghcr.io/yeomyeonggeori/oort` 첫 발행 가능 — 자연 활성 |
| ⑤ | 커뮤니티 | **이슈·PR 둘 다 수용**. PR CI 기계 검사 + 성재·Fable 리뷰. dogfooding 고지는 README 정직성 표로 충분 — 별도 "기여 미수용" 고지 없음 |

## 집행 순서 (성재 "전환" 신호 후)

1. `gh repo edit yeomyeonggeori/oort --visibility public` — 전환.
2. 직후 검증: 비로그인 접근·클론 200 · Actions 과금 상태 전환 확인 · dependabot PR 13건 공개 노출 인지.
3. 공개 직후 권장(별도 티켓): main 브랜치 보호 규칙(공개 레포 위생) · CI 풀 스위트 확장(#1243 적립 5) · GHCR 첫 발행(재조준된 publish-images dispatch — 새 경로 생성) · momo-alpha Pages와의 관계 정리.
4. 런칭 트래킹: SELF_HOST 경로로 선 외부 셀프호스터 수·에이전트 실사용 — 이슈/디스커션 자기보고 기반 집계(3명+ 도달 시 런칭 선언).

## 근거 체인

공개 준비 완결 상태의 근거: `research/2026-08-10-buzz-launch-diagnosis.md`(관문①) + 이후 집행(W-O1~O6·개명·2차 파도·W-S1). 히스토리 시크릿 0(gitleaks 전 히스토리·전 프로파일 게이트) · copyleft 0 · LICENSE/NOTICE · 셀프호스트 63초 · PR CI 가동.
