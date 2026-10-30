# ADR-0217: 사람 DM에 전원 동의로 에이전트 들이기

- Status: **Accepted**
- Date: 2026-10-30
- Issue: [#4792](https://github.com/yeomyeonggeori/oort/issues/4792)
- Owner decision: 10-30 02시 질문 창 및 이슈 코멘트 — **「상대 동의로 DM에 들이기」**, 「상대가 동의하면 에이전트가 들어와 그룹 DM이 되고 이후 대화를 계속 봐요.」
- Supersedes: ADR-0162 증보 2 B1의 그룹 DM 일괄 제외. 기존 사람↔에이전트 1:1 규칙은 유지한다.
- 번호 확인: 착수 시 로컬 `docs/adr`, `origin/track/engine`, `origin/track/uxui`의 마지막 번호 0216, 열린 PR #4796에 0217 없음. 0213은 다국어 예약이다.

## 결정

1. 활성 사람 DM 참여자가 `@에이전트`를 보내면, 호출 권한을 먼저 확인한다. 개인 에이전트 호출은 기존 경로다. 멈춤·은퇴·비소유자의 owner-only·커넥터 소유권·구독/hosted 끄개·끊긴 연결은 기존 호출 제한을 따른다. 초대는 에이전트의 권한을 넓히는 model 도구가 아니다.
2. **초대한 사람을 제외한 활성 사람 모두**에게 각각 15분짜리 기존 `workspace_action` 승인 카드를 만든다. 행동은 `dm.agent.admit`, 서버 전용 제안이며 `dm_participant` 권한은 그 카드에 고정된 사람 본인이다. 관리자·에이전트 소유자·초대한 사람이 대신 승인할 수 없다. 카드에는 에이전트 이름과 handle, 읽기 범위, 누구나 내보낼 수 있다는 사실을 표시한다.
3. 모든 카드의 허락이 유효한 동안 마지막 허락 트랜잭션에서 참여자 집합·초대한 사람의 호출 권한·에이전트/연결의 생존을 다시 증명한다. 사람이 추가되거나 나가면 기존 동의를 재사용하지 않는다. 한 명의 거절·만료·취소면 착석 0, 작업 전달 0이다. 중복 멘션은 같은 대기 요청을 사용한다.
4. 같은 `channel.id`, `kind=dm`에 에이전트 membership을 넣어 3명 이상 대화로 바꾼다. 별도 채널로 옮기지 않는다. 합류한 대화의 `dm_key`는 고유한 `admitted:<channel.id>`로 바꾸며 되돌리지 않는다. 원래 두 사람의 새 1:1 열기가 그룹 대화를 몰래 재사용하지 않게 한다.
5. 읽기는 **현재 착석 이후에 생성된 글**만이다. 서버 `clock_timestamp()`와 직렬화된 `channel_seq` 절단점을 모두 만족해야 한다. 예외는 그 착석을 요청한 메시지 **하나**다. 그 메시지가 인용한 글·스레드 뿌리·이전 첨부·이전 착석의 기록까지 예외가 확대되지 않는다. 다시 들이면 새 절단점을 쓴다.
6. 사람 누구나 그 대화에서 에이전트를 내보낼 수 있다. 비참여 관리자와 에이전트는 내보내기 권한이 없다. 같은 트랜잭션에서 admission 폐기·membership 종료·살아 있는 run 취소를 한다. 이 순간 이후 읽기·쓰기는 거절한다. 이미 외부 런타임에 전달한 글을 회수했다고 주장하지 않는다.
7. 이후 대화는 그 멤버의 읽기 범위에 포함된다. hosted inbox는 동의받은 **동일 연결**에만 새 메시지를 전달한다. 모델 답장 시작은 그룹 대화와 같이 명시적 멘션·기존 스레드 깨움 규칙을 따른다. 매 글 자동 답장을 켜지 않는다. 기존 A2A 깊이·예산·사람 저자 검증을 보존한다.

## 두 명 가정 전수와 변경 계약

| 표면 / 정본 | 기존 가정과 이 결정 |
|---|---|
| `momo-agent/src/dm.rs::resolve_dm_addressing` | 사람↔에이전트 정확히 둘만 무멘션 자동 답장. 셋 이상은 멘션·기존 스레드 깨움만; 사람끼리 한 말에 답 폭주하지 않는다. |
| ADR-0162 증보 2 B1·`091_hosted_dm_approval.sql` | 소유자가 연 기존 1:1 전달은 그대로. 새 migration의 함수가 현재 착석 + 동의 당시 connection을 합집합으로 더한다. 그룹 DM을 관리자 confirm 목록에 넣는 우회는 열지 않는다. |
| `momo-agent/src/hosted_dm.rs`, `routes/hosted_dm_approvals.rs` | 소유자가 타인과의 **1:1**을 여는 설정은 그대로 1:1 전용이다. 그룹 합류 동의는 DM 카드에서만 받는다. |
| `routes/agent_mentions.rs` | 미착석 멘션은 허락 카드를 만들 뿐 run job을 내보내지 않는다. 착석 뒤는 기존 멘션 gate·직렬화·멱등성으로 전달한다. `admitted:` DM의 미착석 개인 별칭은 안내 글을 생략하고 호출 건너뜀만 감사한다. 개인 세션 시작은 `409 dm_agent_consent_required`로 거절한다. 개인 에이전트는 동의 좌석 대상이 아니므로 기존 소유자 호출 규칙으로 그룹 DM의 동의를 대신하지 않는다. |
| `momo-messaging/src/message.rs`의 최근 대화, worker A2A | 에이전트마다 다른 착석 하한이므로 최근 대화 캐시를 에이전트 사이에 공유하지 않는다. BYPASSRLS worker도 명시적 가시성 함수를 통과한다. |
| Agent Port `oort_conversation_read`, jobs claim/start, REST history·thread·search | 인증된 에이전트의 request-local 읽기 주체를 tx GUC에 묶고 message의 restrictive SELECT RLS로 과거 글을 거른다. 인용·스레드·검색의 하위 조회도 같은 경계다. 사람이 읽는 이력은 그대로다. |
| 팀 AI 읽기 도구 `team_ai_read` | 요청자 권한·답장 청중과 함께 팀 AI 자신의 request-local 에이전트 주체를 읽기 tx에 묶는다. `momo_helper_read`는 NOBYPASSRLS·SELECT 전용이며 admission 조회만 더한다. 채널 지정/워크스페이스 검색·대화·스레드 모두 현재 착석 하한을 따르고, 착석하지 않은 요청자의 다른 DM도 읽지 않는다. |
| 공통 `guard_dm_agent_write`·착석/내보내기 | 해당 `(workspace, channel, agent)` admission 행이 있거나 `admitted:` DM에서 **에이전트 새 메시지 INSERT만** 현재 좌석 조건으로 막는다. 기존 메시지의 props/본문 UPDATE는 서버 카드 정리로 통과한다. 결정·만료·정체 장부와 카드·감사는 좌석 생존과 무관하게 종결하고, 좌석이 끝난 에이전트 이름의 새 안내 줄은 생략한다. 허용 판정은 공통 `dm_agent_can_speak`를 쓰고, channel_seq 다음에 같은 workspace·channel·agent 키의 공유 transaction advisory 잠금, 착석/내보내기는 배타 잠금을 잡으며 membership UPDATE 권한을 추가하지 않는다. |
| 표준 run 취소·정지·은퇴·승인 sweep | 내보내기·멤버 정지/제거·개인 에이전트 끄기는 같은 run 취소 함수를 재사용해 pending 승인·카드·job·hosted run 참조를 함께 정리한다. 이미 취소된 카드의 사람 결정은 새 실행 없이 종결 영수증을 200으로 돌려준다. sweep은 승인별 SAVEPOINT에서 실패만 되돌리고 식별자 로그 뒤 다음 회차에 재시도한다. 동의 카드 출처 `dm_agent_admission`은 `server_in_place`와 같이 에이전트 보류 행동 한도에서 제외한다. |
| `momo-messaging/src/dm.rs` open/list·`channel.dm_key` | 열기는 기존 정확히 둘 API. 합류한 대화는 id를 보존하고 pair key를 은퇴시킨다. 목록의 `memberIds`는 활성 전체다. |
| 코어 `workspace/directory.ts`의 `dmPeer`·`channelLabelParts`·`dmAutoReplyAgent` | 상대 한 명을 임의 선택하지 않는다. 그룹은 멤버 이름과 인원, 개인 상태 점·개인 프로필 열기는 실제 1:1만. 자동 답장 안내도 실제 1:1만. |
| 폰 `ConversationHeader`·`ConversationInfoPage`, 웹 채널 머리·사이드바 | 그룹 멤버 이름·인원 및 에이전트 표시. 멤버 메뉴에서 현재 에이전트 내보내기. 합류/내보내기 시스템 줄은 서버가 쓴 사실이다. |
| 폰·웹 멘션 목록·컴포저 | 호출 가능한 에이전트 후보, 보내기 전 ‘다른 사람이 모두 허락하면 … 이 대화에 들어와요’. 이미 있는 에이전트에는 합류 안내를 반복하지 않는다. 기존 1:1 에이전트 DM 안내는 유지한다. |
| `momo-push/src/judgment.rs`·폰 `push/presentation.ts`·푸시 제목 | DM 대상은 원래부터 다른 활성 사람 **전체**다. 임의의 한 상대가 아니라 발신자와 그룹 대화 이름을 표시한다. 승인 푸시는 기존 pinned target 판정으로 카드의 해당 사람만 깨운다. DM 합류 승인은 앱에서 내용을 보고 결정한다. |
| `momo-messaging/src/read_state.rs`·폰/웹 읽음 | 원장은 멤버별 seq이며 현행 화면은 자신의 안 읽음 경계/읽음 커서를 표시한다. 상대별 읽음 영수증은 현재 제공하지 않는다. 그룹도 자신의 커서를 유지하고 에이전트의 읽기를 다른 사람의 읽음으로 간주하지 않는다. 향후 상대별 읽음은 사람별로 설계하고 한 명의 ‘상대’로 합치지 않는다. |
| `dm_closure.rs`·사이드바 숨김 | 닫기는 멤버별 로컬/서버 표시 선택이며 내보내기가 아니다. 그룹은 상대 한 명 나감으로 대화 전체를 ‘나간 멤버’로 숨기지 않는다. |
| `momo-agent/src/memory.rs` | 기존 DM 기억은 가장 늦게 들어온 현 멤버 이후 증거만 쓴다. admission은 이를 과거로 넓히지 않는다. |
| `actions.rs` pin 카드의 ‘1:1 대화’ 문구 | DM 전체를 지칭하는 자리는 ‘이 대화’로 바꾼다. |

## 위협과 방어

- **지난 대화 유출**: 시각+seq 하한, 예외 id 하나, 에이전트별 컨텍스트, 중첩 조회 RLS. 인용 원문이나 오래된 뿌리는 따로 동의받지 않으면 숨긴다.
- **동의 없는 착석/사칭**: 서버 전용 action, 사람 principal + 활성 DM membership + pinned target. 전원 승인·만료·청중 고정을 DB에서 재증명한다. 클라이언트 props가 권한이 되지 않는다.
- **런타임 바꿔치기**: 동의한 hosted connection id를 고정한다. 연결 재등록·권한/주체 변화는 재동의 경로를 요구한다.
- **답 폭주**: 1:1 자동 답장 규칙 불변, 그룹 명시 호출, 중복 대기 카드 병합, job 멱등키, 기존 A2A 예산/깊이.
- **내보낸 뒤 쓰기**: 표준 진행 run 취소 + 동의 좌석/대화의 공통 message INSERT 트리거와 현재 membership 검사. 서버의 기존 카드 UPDATE는 허용하고 권한을 잃은 에이전트의 요청 편집은 기존 요청 경계에서 거절한다. BYPASSRLS worker에도 적용한다. 공유/배타 transaction advisory 잠금으로 이미 시작한 쓰기와 내보내기를 직렬화해 제거 commit 뒤 새 에이전트 발언을 허용하지 않는다.

## 검증과 전달

실 PG에서 허락 전 0·거절/만료 0·전원 동의·본인 외 결정 거절·가입 전 이력 0·부른 메시지 예외·시간/seq 독립 경계·제거 후 읽기/쓰기·재합류 경계·그룹 멘션·기존 1:1·hosted 전달을 확인한다. 각 보안 gate를 제거한 사보타주는 해당 행동 시험이 실패해야 한다.

폰·웹의 실제 화면, 밝음/어두움·큰 글자·동작 줄이기, Maestro·Playwright, 독립 design-review와 전체 시험은 S1 스택 검증에서 한다. 구현 진척·실행 명령·사보타주 원문은 워커 증거/PR 본문이 정본이며 이 ADR의 Accepted가 구현 또는 검증 완료를 뜻하지 않는다.
