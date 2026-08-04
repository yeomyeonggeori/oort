# 핸드오프 패킷 U4(1차) — 폰 Blocker 3건: 본문 렌더·복사 (B3M 체인 연장 M3/M4)

- status: **ready** · worker: **B3M 재사용**(모바일 전속 유지) · 기준: 자기 브랜치 연속 · goal별 브랜치·PR
- 근거 정본: `docs/planning/research/2026-08-05-chat-ui-audit.md` — **정독 필수**. 결함 37건 중 Blocker 3건 전부 폰(BL-1 마크다운 미렌더 · BL-2 복사 불가 · BL-3 링크 안 눌림). U4-a/U4-b 배치 정의(§4)가 이 패킷의 원문.
- 순서 유연성: **B3 M1(인용)이 core 대기로 막혀 있으면 M3를 먼저 당겨도 된다** — M3(본문 렌더)가 MessageRow 본문 경로를 재구성하므로 M1(인용 블록)보다 먼저 하는 편이 이중 작업을 줄인다. M4는 언제든 가능.

## Goal M3 (U4-a · #1048) — 폰 본문 렌더 동등화 (BL-1·BL-3·M-13 일부·L-6)

- 현재: `clients/mobile/src/features/conversation/MessageRow.tsx:846-862` 본문이 평문 `<Text>` — 마크다운 미해석·링크 비활성.
- 작업: 코어 파서 `packages/momo-core/src/features/timeline/markdown.ts` 위에 **RN 렌더러 한 겹** 신설(웹 `clients/web/src/features/timeline/MessageBody.tsx`의 RN 판). 링크는 `Linking.openURL`(http/https만 — 스킴 화이트리스트), 코드블록 분기+언어 라벨, 인라인 코드·볼드·리스트 웹 동등.
- 금지: 새 파서 작성·서드파티 마크다운 라이브러리 도입(파서는 core가 정본). core 수정 금지 — 부족하면 이탈 보고.

## Goal M4 (U4-b · #1049) — 메시지에서 텍스트를 꺼낼 수 있게 (BL-2·H-9 폰)

- 작업: 롱프레스 액션 시트에 「메시지 복사」 + 코드블록에 복사 액션. 클립보드는 **expo-clipboard**(bare RN에 Expo 모듈 낱개 채택은 기존 결정 계열) — 네이티브 모듈 추가라 **pod install 필요**: 워크트리 pod 부트스트랩 함정(#1035) 유의, 재현 절차를 PR에 남길 것.
- `selectable` 정책은 롱프레스와 공존하게 재설계(현행 충돌이 BL-2의 절반).

## 검증 (각 goal)

전체 스위트+typecheck + red proof ≥2(M3: 마크다운→구조 렌더 단정·비허용 스킴 링크 불활성 단정 / M4: 복사 페이로드 단정) · goal 완료 후 `lane:phone` 무회귀 1회(레인은 M3의 렌더 변경에 민감할 수 있다 — 텍스트 매칭 플로우 깨지면 플로우 측 수정도 네 몫, 단 그 사실을 이탈 절에 기록). PR "Closes #1048"/"Closes #1049" · `## 계획 이탈` 절 · STOP. 턴 규율 유지(≤20분·마일스톤 보고).
