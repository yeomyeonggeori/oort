# 그록봇 유지 경로 재개통 — routine webhook 트리거 발견·Slack 트리거 판정·폴링 상한 (2026-08-24)

- 작성: Fable · 발제(성재): "그록봇 포기 못해. ①Slack에서 멘션으로 그록봇 가능? ②30초 폴링 쓸까? ③루틴 돌 때마다 메시지 로그 남아?"
- 선행: `2026-08-24-realtime-autonomous-mention-research.md`(xAI API 방향) · `2026-08-24-grokbot-push-vs-cdp.md` · `2026-08-16-grok-ecosystem-2026.md`(기준선)
- 방법: 웹 디깅 2기(Slack 트리거 실체 / 루틴 실행 메커니즘). docs.x.ai·cursor.com 공식 + Cursor 포럼 스태프 답변 + 영·일 실사용기 교차. [확실]/[확실-2차]/[추정] 표기.

## 0. ⚠️ 기준선 갱신 (2026-08-16 판정 폐기)

**"웹훅/외부 트리거 전무" 판정은 낡았다. 그록봇 루틴에 `{type: webhook}` 트리거가 존재한다** — 루틴 저장 시 **전용 HTTP endpoint URL + sender API key**가 발급되고, POST 한 방으로 run이 시작된다. info pane 크래시 버그가 08-20 스태프 확인 → **08-21 v0.24에서 수정**되어 실사용 가능 상태. 단 공식 docs 미기재(rollout 중 undocumented) — 회수·변경 가능성 있는 베타 표면. [확실 — forum.cursor.com t/168883, 스태프 Colin·Kevin Neilson]

이 발견으로 **"그록봇 페르소나를 유지한 채 oort가 직접 깨우는 push"가 성립한다** — Slack 경유도, CDP도, 폴링도 없이.

## 1. Q1 — Slack에서 멘션으로 그록봇 쓸 수 있나

**된다 — 단 두 표면을 구분해야 하고, 지금 경첩이 흔들리는 문이다.**

- 표면 구분: ① "Grok for Slack"(slack.hooks.x.ai — console.x.ai **API key**를 꽂는 일반 Slack 챗봇, 그록봇 아님) ② **그록봇 루틴의 Slack event 트리거**(Cursor 계정 integration 경유 — 그록봇이 Slack에 설치되는 게 아니라 Cursor Slack 앱이 이벤트를 배달). [확실]
- ②의 상호작용 모델: Slack 메시지/reaction/mention 이벤트(**public 채널 한정**, 대상 채널에 Cursor 앱 invite 필수, keyword/regex 필터) → 루틴 run → 봇이 VM에서 작업 → **Slack connector로 같은 채널에 회신 post**. 실증 리포트 존재(응답은 채널 직접 post, thread 아님). 즉 "Slack 네이티브 봇 멤버"가 아니라 "이벤트→루틴→connector 회신" 3단. [확실-2차]
- 지연: 이벤트→run 시작 초 단위, 의미 있는 회신까지 수십 초~수 분. 커뮤니티 운영 기준 60–90초. [확실-2차/추정]
- **치명 결함: bot-authored 메시지 트리거의 반복 회귀.** 2026-04 회귀(봇 발신 무시, 스태프 공식 확인) → 5월 수정 → 재발 → **8/5·8/21 재발 리포트**. 개인 플랜은 "생성자 본인 메시지만 발화" 버그 병존. 실패 모드는 지연이 아니라 **silent no-fire**. oort 서버가 쏘는 doorbell은 필연적으로 bot-authored라 정확히 깨진 클래스에 떨어진다. [확실 — forum t/159325·158972·168397]
- 판정: **사람이 Slack에서 멘션하는 용도는 성립**(불안정 감수), **oort→Slack→그록봇 배달부 구조는 비권장** — §3의 webhook이 모든 축에서 우월.

## 2. Q2 — 30초 폴링? / Q3 — 루틴마다 로그 남나?

- **30초 폴링은 불성립.** schedule 트리거는 cron 기반, 최소 단위 **1분**. 1분 cron은 webhook 버그 기간 사용자들이 workaround로 실운용해 검증된 빈도(현장 실증). [확실 — forum t/168883·168199]
- 단 1분 폴링의 실비용: **루틴 run마다 Grok Bot weekly usage allowance 연소**(공식 docs가 broad listener를 "consume usage"로 경고), 장기 방치 루틴은 **자동 pause 개입 대상**. 상시 분 단위 폴링은 경제·운영 양면에서 취약. usage pool 구분(스태프 확인): 봇 자체 작업(루틴 포함)=Grok Bot allowance, 봇이 spawn한 Cloud Agent=Cursor plan allowance. [확실]
- run 내부 루프(터미널 sleep 루프로 한 run 안에서 30초 체크): 금지 조항 없고 VM이 상시 가동(persistent VM)이라 기술적으로 가능하나 무보증·turn 점유·usage 연소. [추정]
- **Q3 답: run마다 채팅이 불어나지 않는다.** 봇당 대화는 **단 하나**("one continuous conversation per Bot" — 스태프 확인). run 기록은 별도 **Run history 패널(루틴당 최근 20건 rolling)**에만 남고, **채팅 메시지는 루틴 지시문이 "채팅으로 보고하라"고 시킨 경우에만** 추가된다. 알림도 run마다가 아니라 **result/question/approval** attention state에서만. "발견 시에만 보고, 아니면 침묵"으로 설계하면 채팅·알림 플러딩 없음. [확실 — forum t/168183 + docs]
- 참고: 컨슈머 Grok Automations는 정반대(run마다 대화 생성) — 혼동 금지.

## 3. 권장 아키텍처 — webhook doorbell (그록봇 페르소나 유지)

```
oort 멘션("@grokbot …")
  → 한 tx: message + agent_run + outbox            (기존 단일 쓰기경로 그대로)
  → momo-webhook-sender가 루틴 전용 webhook URL로 POST   (신호만, 내용 0)
  → 그록봇 루틴 run 시작 (초 단위)
  → 루틴 지시문: "oort Agent Port(MCP 커스텀 커넥터)에서 oort_inbox_read
     → 처리 → oort_message_post로 응답 → 없으면 침묵"
```

- **신뢰 모델이 기존 설계와 동형**: `agentwork:` publication이 "DB에 일감 있다는 wake-up일 뿐 신뢰 입력이 아니다"와 똑같이, webhook POST는 도어벨(내용 0)이고 내용은 인증된 Agent Port pull로만 흐른다. ADR-0162 증보 불필요 — 전달 트리거만 추가.
- **그록봇이 지키는 것**: 페르소나·전용 VM·단일 대화 기억·스킬/커넥터 — 성재가 포기 못 하는 전부.
- **지연 클래스**: run 시작 초 단위 + 응답까지 수십 초 = **준실시간(수십 초)**. Slack 멘션→그록봇 회신의 커뮤니티 체감(60–90초)과 동급이거나 우위.
- **fallback 병설(필수)**: silent no-fire가 이 인프라의 공통 실패 모드(Sentry 트리거 무발화 사례 — 수신 200인데 run 없음)이므로, ①oort 측 "초인종 눌렀는데 N분 내 claim 없음" 타임아웃 감지 ②저빈도 cron sweep 루틴(예: 15분)으로 놓친 멘션 회수. 12인 팀의 90초 fallback 병설 패턴이 참고 모델.
- **리스크**: (i) undocumented 베타 — 공식 문서화 전이라 예고 없이 변경 가능 (ii) 무인 oort_message_post에 그록봇 승인 흐름(Auto Review) 설정 필요 여부 실측 요망 (iii) 멘션 빈도만큼 weekly allowance 연소(폴링 대비 압도적 우위 — 이벤트 있을 때만).
- 비추천 각주: VM 내부 gateway(port 1340 `/api/sendPrompt`, token 파일)가 포럼에서 발견됐으나 **내부 undocumented API — CDP급 gray-zone 회귀라 사용 금지 권고**.

## 4. 다음 행동 (성재 결재 대기)

- **SPIKE-WD(권고 1티켓)**: webhook doorbell 실측 폐곡선 — ①그록봇에서 `{type: webhook}` 루틴 생성(v0.24+)·URL/key 수령 ②수동 curl POST→run 시작·지연 실측 ③루틴 지시문에 Agent Port inbox read→message post 폐곡선 ④무발화율·승인 흐름 관찰. 성공 시 momo-webhook-sender 구독 배선 티켓 후속.
- fallback 설계 티켓: 도어벨 타임아웃 감지 + 15분 sweep 루틴 표준 지시문.
- 기준선 문서 갱신: `2026-08-16-grok-ecosystem-2026.md`의 "웹훅 전무" 항목에 본 노트 참조 각주(momo-main 통합 시).
- Slack 트리거는 "사람 사용" 시나리오로만 보류 — oort 배달부로는 채택하지 않음.
