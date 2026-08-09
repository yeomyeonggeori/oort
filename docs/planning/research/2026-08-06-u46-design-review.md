# Design Review — U4-6 배치(#1107 웹+#1106 폰) @ 62e63404 — Verdict: FAIL(B1·H2·M2·N2)

## Blocker
- **B1 크로스-PR 코어 API 드리프트**: #1107이 approvalNote 입력을 decidable→settled/hasTarget/pendingHere로 재편, 폰(#1106)은 옛 API 소비(웹 브랜치 초기 코어 커밋 rebase — 이후 amend 미반영). 병합 트리: 폰 tsc TS2353·jest 8/31 실패. 런타임(Metro 타입 소거): settled=undefined→영수증 외 전 갈래 null→**오프라인 승인 버튼 재도입**(H-1/H-10이 걷어낸 상태). u46-approval-notes.png는 병합 전 사진이라 증거 아님. **U4-4 W-1과 같은 실패 양식 2번째 발생 — "머지 결과가 검증되지 않는다".**

## High
- H1 컴포저 오프라인 문장 두 클라 상이(각자 지음) — APPROVAL_OFFLINE_COPY 전례로 코어 승격 필요.
- H2 폰 초안 로그아웃 생존(웹은 clearAllDrafts+근거 "쓰다 만 글은 보낸 메시지보다 사적이다") — privacy 분기.

## Medium
- M1 PendingRow가 H-7 리듬 계약 밖(pt-3 pb-1/py-1 — 에코 서 있는 동안 8~10px·확정 순간 2px 튐). M2 폰 내부 「때의 문제」 두 문장 다른 옷(승인 blocked=text/400 vs 컴포저 오프라인=warn — 앰버 기각 논리 비일관).

## 판정 요지
중점 6항 중 5항 PASS(아바타 위계·오프라인 구조·초안 침묵·「여기까지 복구」·타깃 이중 기준=정합 판정). 폰 문장 격은 B1로 병합 트리에서 무효. 의도적 결정 6건 재지적 없음.
