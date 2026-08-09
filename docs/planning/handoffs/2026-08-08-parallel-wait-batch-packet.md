# 핸드오프 패킷 — 대기 병렬 배치: #1182·#1173·#1164 파리티 축 (3워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신(#1181 머지 후) · 워커=단발 Opus 무명 · 발주 전 랜딩분 대조 완료(셋 다 미착수 — #1181·#1167·#1163 후속) · 중간 보고 없음
- 경합 지도: W-K=web-legacy 스모크(clients/web-legacy·게이트 스크립트) / W-L=server-rust 어댑터 와이어(momo-messaging·openapi) / W-M=폰 다크 토큰·테스트 — **무교차**.

## 워커 K — #1182 web-legacy 스모크 B4 (소형)
- #1181 부수 발견: 스모크 11단계가 브라우저 단정 18연속 PASS 후 존재하지 않는 testid `approval-state` 대기 정지 — 실물은 `approval-status-chip`(ApprovalCard.tsx:98). 규명: 셀렉터가 낡은 것인가(그 testid가 존재했던 커밋 실측), 화면이 잘못 바뀐 것인가 — **낡은 쪽을 고친다**(단정 갱신 or 화면 복원, 실측이 정한다). 콜드 빌드 ~50분이 걸림 주의 — 캐시된 빌드 재사용 가능하면 활용, 최종 검증 1회는 필수.
- 검증: `--profile web` 11~13단계 실행표(B4 자리 green 전진)·red proof 1(수리 되돌리면 그 자리 재정지)·병합 트리 7레인. PR "Closes #1182"·이탈 절·STOP.

## 워커 L — #1173 어댑터 여는 POST 표식
- #1167 이탈 5: in-process 경로의 `opening_stream_props`(rev:0·streaming:true — 첫 write~둘째 write 사이 사망 시 무표식 반쪽 문장 방지)가 REST 어댑터 경로에 없다. POST /messages body에 `stream` 여는 블록 허용(선택 — 하위호환)·momo-messaging 수용·openapi 등재·rev 단조 규칙 불변(여는 표식=rev:0, 첫 조각=rev:1 — stream.rs와 동형). 소비 클라 0줄 예상(#1165 방어 렌더링이 이미 받는다 — 실측으로 확인).
- 검증: cargo+실DB(stream_edit·stream_message 무회귀+여는 POST 신규 단정)·red proof 2(①여는 표식 없이 죽은 턴=무표식 반쪽 재현(수리 전 상태) ②rev:0 아닌 여는 표식 거절)·병합 트리 7레인. PR "Closes #1173"·이탈 절·STOP.

## 워커 M — #1164 파리티 축만: 폰 다크 잔여 역할 웹 정렬 (재배선 결정은 범위 밖)
- #1163이 accent 가족만 정렬 — 나머지 다크 역할(표면·잉크·warn·danger 계열)을 **웹 tokens.css 다크 항에 값 단위 정렬**(#1153 라이트·#1163 accent와 같은 기승인 파리티 패턴 — 발명 0). 특히 `warn`: 정렬되면 리뷰 N1(#1164 ①)의 warn/accent 10.9° 이웃 문제가 웹과 같은 18.1°로 벌어지는지 실측해 기록.
- **범위 밖(이 이슈의 ②③)**: accent 의미 재배선(제품 결정 — 성재)·sign-out confirm 위계(M1 — 캡처 케이스 신설 포함, 별도). PR 본문에 남는 결정 2건 명시.
- 파리티 가드는 #1163 방식(웹 파일 파싱 대조) 확장 — 베낀 기대값 0. 기존 값 분리 가드(conversationHygiene)와의 충돌은 실측 후 참인 문장으로 재서술.
- 검증: 폰 jest 전판+tsc+lint 총계·다크/라이트 캡처(pt=px/3·경로 PR 명기)·red proof 1(정렬 단정이 구값 복귀 시 빨강)·병합 트리 7레인. **UI 변경 — design-review는 오케스트레이터 발주.** PR "#1164 부분 해소(파리티 축)" 명시(Closes 금지)·이탈 절·STOP.

## 공통
무명 단발 Opus·`origin/track/engine` 새 워크트리·동결층 불변·시크릿/프로덕션 금지·워크트리 보고 후 대기. 스크래치 접두 `smoke1182-*`/`open1173-*`/`dark1164-*`.
