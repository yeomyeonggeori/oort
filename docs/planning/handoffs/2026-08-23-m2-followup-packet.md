# #1703 M-2 후속 폴리시 패킷 (스코프 한정판)

> Status: `ready` · Planner: Fable · Integrator: momo-main · 트랙=uxui(base=track/uxui 5679f6c8) · 워커=sol · 검수=Fable+design-review

## 이번 스코프 (이슈 #1703 중 워커가 지금 닫을 것만)
1. **트레이 행 높이 자리 예약**: progressTrack 자리를 전 상태 예약(웹 쌍둥이·M-1 AttachmentList 규율) + 첫 진행 측정 전 indeterminate 표현(0% 오독 제거 — 웹 B-3 대응물).
2. **draftStore 세션 수명주기 리셋**: 로그아웃/계정 전환 시 drafts/inflight 비우기(구 bearer 업로드 세션 id 누출 차단). 세션 경계 훅은 기존 auth 스토어 관례를 따라 배선.
3. **TOUCH_TARGET 축 차용 제거**: grabber 폭·트레이 maxHeight를 명명 측정으로(`tokens.ts`에 tray 계열 이름 신설 — 웹 --spacing-tray-max 선례, 근거 주석).
4. **Nit 3건**: 발치 경고색 조건을 웹과 정렬(sendBlockReason 기준) · 크기 미독 파일 「0 B」→크기 줄 생략 · addPickedFiles rejected 무음 폐기에 방어 주석+단정.

## 명시 비스코프 (이 PR에서 하지 말 것)
- 시트 radius/grabber 문법 통일(#1703 Medium-3 후반 — 별도 결정), 컨트롤 윤곽 토큰(#1210 동반), 실기/시뮬레이터 검증(별도 세션).

## AC
- 각 항목 단정 테스트(특히 세션 리셋: 로그아웃 후 드래프트 0 단정 + 업로드 중 취소 경로) · 전체 모바일 스위트·tsc 그린 · worker는 PR(base=track/uxui) 후 정지.
