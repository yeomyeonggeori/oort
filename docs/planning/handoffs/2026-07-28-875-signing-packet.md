# goal #875 — MOMO-657 [보안]: WorkHost 서명에 body digest + 1회용 request ID

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(최신). 모델: gpt-5.6-sol medium.

## 0. 착수 전 필수
1. `git status` clean. 2. 자격증명·`.env` 금지. 3. **PR 후 STOP.** 4. docker는 오케스트레이터. 5. 심볼 grep 실재 확인.

## 1. 결함 (오케스트레이터가 코드로 실증)
`WorkHostAuthenticator.swift:95-105`의 서명 base는 **body가 없다**:
```
momo.work_host.request.v1\n{METHOD}\n{PATH}\n{workspace}\n{host}\n{sentAtMs}
```
그런데 **같은 PATCH 경로가 body로 idle·running·ended를 가른다**(#856). 따라서 5분 창(`heartbeatClockSkewMs`) 안에 캡처한 서명 하나를 **임의 body와 재제출**할 수 있다 — private key 없이 세션 종료·과금 경계 조작·이벤트 위조. nonce가 없어 **동일 서명 반복 제출도 막히지 않는다.**

## 2. 할 일
1. 서명 base에 **raw body의 SHA-256 digest**(hex 소문자)와 **고유 request ID**를 추가. 버전 문자열도 올려라(`...v2`) — 구/신을 서버가 구분할 수 있어야 한다.
2. 서버가 **request ID를 원자적으로 1회만 소비**(중복 거부). 저장 수명은 서명 허용 창(5분)보다 길게, 정리 경로 포함. RLS·인덱스는 기존 마이그레이션 선례를 따라라.
3. **양쪽을 동시에 갱신**: `workers/WorkHostDaemon`의 `WorkHostAPIClient`(요청 생성)와 서버 검증. 한쪽만 바뀌면 전 호스트가 401이 된다.
4. **마이그레이션 전략을 판단하고 PR에 적어라**: v1 병행 수용 기간을 둘지, 즉시 절단할지. self-host 운영자가 데몬을 먼저/나중에 올릴 수 있다는 현실을 반영해라(둘 다 근거 있으면 판단은 네 몫, 근거를 커밋에).
5. 검증기 서명 헬퍼도 함께 갱신: `verify_work_session_idle.sh:155-172`(`host_api`)와 같은 서명 구성이 있는 다른 스크립트를 **전수 grep**해서 빠짐없이.

## 3. 하지 말 것
- 새 인증 문법 발명 금지(Ed25519·헤더 이름 유지). 서버 라우트 의미 변경 금지. `schema_v0.sql` 수정 금지.
- #876~#879(정산·수명주기·정밀도)는 **다른 티켓** — 손대지 마라.

## 4. 검증
- `swift build` · 서버 테스트 무회귀(현재 342) · 데몬 테스트 무회귀(32).
- **격리 검증기 신규/확장**: ①유효 서명의 **body 교체 재제출이 거부**된다 ②**같은 request ID 재사용이 거부**된다 ③정상 경로 무회귀.
- **오케스트레이터가 돌릴 회귀 목록을 PR에 명시**: `verify_work_session_idle` · `verify_work_session` · `verify_terminal_attach` · `verify_observer_attach` · `verify_work_pool` · `verify_t3_provisioner` · `verify_agent_run_history`(전부 host 서명 경로를 지난다).
- **red proof**: body digest를 서명 base에서 빼면 ①이 통과해버리므로 단정이 **이름 있는 실패**로 빨개진다(행·타임아웃 금지 — 실측 교훈).
- UUID 텍스트 비교는 lower() 정규화(payload는 Swift 대문자).

## 5. PR
`feat/875-momo-657-signing` → `track/engine`. 본문: 서명 base v2 정의, request ID 소비·정리 설계, 마이그레이션 전략 판단, 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
