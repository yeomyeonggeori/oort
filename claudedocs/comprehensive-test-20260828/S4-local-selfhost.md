# S4 외부 도구 이중 — 로컬 셀프호스트 실측 (2026-08-28 저녁)

> 경로 전환: 그록봇 오류로 VM 릴레이 경로 중단(성재 지시) → 로컬 셀프호스팅으로 종합테스트 계속.
> 스택: `oortv013` compose 프로젝트 — **발행 v0.1.3 digest pin**(`ghcr.io/yeomyeonggeori/oort@sha256:e0faed22…c48688`, self_host_env.sh published-digest 모드, 8소비처 pin), pgvector·centrifugo는 compose 자체 digest pin. 포트 8088(web)/8080(api)/8000(cent). 구 `oort` 스택(doorbell 워크트리 소산)은 비파괴 정지로 포트만 회수(볼륨 보존).

## 셋업 체인 (전부 REST, 직접 실행)
1. owner 로그인(`MOMO_INITIAL_OWNER_*`) → invite(role=member, maxUses=1) → **Comptest-fable join**(`01a047bb-f063-7909-b238-d96d62263325`).
2. **admin 승격**: `PATCH /members/{id}/role {"role":"admin"}` → `{"memberId":…,"scope":"workspace","role":"admin"}` — #1848 서버 경로 + #1855 클라 와이어 계약(camelCase 3필드) 실배포 이미지에서 실측 일치.
3. Comptest-fable(admin)로 **generic 에이전트 생성**(`comptest-generic`, `01a047bc-6b81-7759-9e16-843b7b3b8ec8`) → 자격 발급(scopes `messages:read`+`messages:write`) → general(-201) 채널 투입. hosted 차단(409) 경로는 로컬에 hosted 에이전트가 없어 비대상.

## 매트릭스 결과 (에이전트 Bearer)
| 호출 | 기대(런시트) | 실측 | 판정 |
|---|---|---|---|
| POST 채널 메시지 | 201 | **201** (seq=1, author=agent) | PASS |
| GET 채널 히스토리 | 200 (#1820) | **200** | PASS |
| GET 스레드 replies | 200 | **200** | PASS |
| GET 단일 메시지 | 403 | **404** | PASS — 편차 기록 ① |
| POST replies | 403 | **403** | PASS |

### 편차 ① — 단일 메시지 GET 404 (기대치 오기, 결함 아님)
라우터(lib.rs:522)의 `/messages/{id}`에는 patch(edit)·delete만 있고 **GET 핸들러가 없다**. owner(사람) 토큰으로도 동일 404 실측 — "단일 메시지 닫힘"(#1820 D1)이 스코프 403이 아니라 **표면 부재**로 구현된 것. 닫힘 계약은 충족, 런시트 기대 코드만 부정확했다.

### 시트 자가 결함 (기록)
- 초판 s4-run.sh의 메시지 바디 `{"text":…}` → 422. 정본 shape는 `{clientMsgId, type:"text", body}` (SendMessageRequest). 수정 후 전항 통과.

## 의의
- S4 전 항목이 성재 개입 0으로 완주 — VM에서 owner curl·릴레이 대기로 막혀 있던 축이 로컬 전환으로 해소.
- v0.1.3 발행 이미지의 외부 도구 이중(쓰기+읽기 개방 / 나머지 닫힘) 계약 실증.
- #1848/#1855 역할 변경의 서버·와이어 계약이 발행 이미지에서 그대로 성립함을 부수 실증.
