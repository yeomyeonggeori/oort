# Grok Bot 역방향 팀메이트 연동 — 방향 리서치 (2026-08-12)

> 발제: 성재 — "사용자가 Grok Bot에서 만든 봇을 oort에서 ACP처럼 연동해 팀메이트로 사용. oort에서 요청하면 봇이 감지해 자기 방식으로 처리하는 hermes형 구조. 배포 허들 0의 호스팅 에이전트라 러프하더라도 실마리를 뚫으면 파급력이 크다. provider 선택은 불가할 것."
> 선행 정본: `2026-08-12-grok-bot-integration-feasibility.md`(제품 실체·인바운드 불가 판정). 본 문서는 그 §5 경로 A/B를 성재 방향성으로 구체화한 2차 리서치. 웹 리서치 3기(감지 루프 실측 / Cursor 표면 / 프로토콜 선례) + 레포 대조.
> **판정 요약: 조건부 성립 — 실마리는 뚫린다.** 봇의 커스텀 MCP 소비(확정에 근접)+루틴 웨이크업(실동작 검증)으로 "배치형 팀메이트"가 오늘 구성 가능. 단 실시간성은 Slack 초인종 브리지 없이는 일/시간 단위이고, 웨이크업 주권이 전적으로 xAI/Cursor에 있어 **의존이 아닌 수용 표면(벤더 중립 Agent Port)으로 설계해야 한다.** 최우선 관문 = 구독 계정 실증 스파이크(문서상 "추정" 2건의 실측).

## 0. 구조 스케치

```
[oort]                                   [xAI/Cursor 클라우드]
 Agent Port (원격 MCP 서버) ◄──── 도구 호출 ──── Grok Bot (사용자의 봇, VM+모델 번들)
  ├ inbox_poll(after_seq)                          ▲ 웨이크업(3종뿐):
  ├ thread_read / message_post(멱등키)              ① 스케줄 루틴 (일/요일 실증, 분단위 미확인)
  ├ task_claim(lease) / task_complete               ② Slack/GitHub 이벤트 루틴 (실동작 검증)
  └ REST 파사드 → PG → outbox → relay               ③ 사용자/타 봇 메시지
 (선택) Slack 초인종: oort → 전용 채널 "새 일감" 신호만 → ② 발화 → 내용은 MCP로 당겨감
```

- 봇 = provider+런타임 불투명 번들 → **provider 선택 불가 확인(성재 예상대로)**. oort는 봇을 provider_link/agent-worker 경로가 아니라 **"다이얼인하는 외부 호스팅 멤버"**로 수용 — ADR-0004 hermes 경계(자격증명·런타임=provider 소유, oort=멤버십·순서·승인·감사 소유)와 정합.
- 감지("oort에서 요청하면 그걸 감지")는 자동 푸시가 아니라 **봇의 pull**로 실현된다. oort는 절대 봇을 호출할 수 없다(인바운드 API 부재 — 선행 리서치 확정). 이 제약이 설계 전체를 지배한다.

## 1. Grok Bot 쪽 실측 (2026-08-12, 공식 문서 14페이지 전량 llms.txt 확보 + HN 234코멘트 + 핸즈온 보도)

### 성립 재료 (확정)
- **MCP 소비**: "connectors/MCP where available" + **Cursor MCP 체계 공유**("MCP authentication is shared across Cursor + Grok Bot", 별도 Grok Bot 플러그인 컨트롤 없음). 팀 설정에 "멤버가 자기 서버를 추가할 수 있는지" 토글 존재 → **커스텀 원격 MCP 서버 추가 경로 실재**(개인 계정 기본값은 실측 필요 — 추정). 원격 서버는 공인 URL 필수(사설 IP 거부).
- **루틴**: 봇당 50개, 자연어로 생성("The Bot creates the routine and shows its next run"), 노트북 닫혀도 실행. 트리거=시계+Cursor 계정 통합 이벤트. **실측된 트리거 후보**(출시 익일 핸즈온): Slack 새 메시지·리액션·멘션, 예약 시각, Git 이벤트, MS Teams 메시지. **"Slack 채널 새 메시지→봇 응답" 루틴이 제3자 실동작 재현됨**(note.com 핸즈온). GitHub push 트리거 실운용 사례도 확인(explainx.ai).
- 봇 간 그룹챗·도메인 분리 운용이 실사용에서 유효(HN 얼리액세스 1개월 유저: 원단 공급업체 40곳 접촉·협상·발주 사례).

### 제약 (확정)
- **웨이크업 주권이 xAI/Cursor에 있음**: MCP 서버발 이벤트로 봇을 깨울 수 없다(MCP는 도구 소비뿐). 외부 호출 API 없음. 트리거 카탈로그는 "where supported" 헤지로 유동적.
- **스케줄 granularity 미확인**: 문서 예시·실사용 보고 전부 일/요일 단위("Every weekday at 8:00 AM"). 분 단위 실증 0건. Cursor Automations(별개 제품, 클라우드 코딩 에이전트용)는 cron 지원 — 엔진 공유 여부 미확인.
- **경제성**: 주간 사용량 allowance + 초과 토큰 과금. 실사용 "3시간 실험에 주간 사용량 52% 소진", "상시 에이전트는 토큰을 엄청나게 쓴다"(HN). 문서가 broad listener("every new message")를 사용량 이유로 비권장. → **고빈도 폴링은 비경제적, "아침/저녁 인박스 비우기" 배치형이 현실 상한.**
- **방치 시 루틴 자동 일시정지**: "may ask whether to keep routines running after a long period away and pause them if there is no response" — 상시 운용의 구조적 제약.
- **MCP 호출이 Cursor 백엔드 프록시 경유**("Sign-in tokens for hosted MCP servers stay with Cursor's backend, which runs those tool calls on the computer's behalf") — oort가 볼 소스 IP/헤더 실측 필요. VM 자체는 정적 egress 대역.
- 전 과정 베타: Musk "Grok 4.6과 함께 기본 이슈 수리 후 베타 확대" — 수주 내 재조정 확실시.

### Cursor 우회 표면 (탈락 판정)
- Cloud Agents API(구 Background Agents): 사양 풍부(POST /v1/agents·SSE 스트림·웹훅 v0)하나 **Grok Bot 미노출**(레포 중심 코딩 에이전트 전용, 확인 범위: 공식 docs+HN+Cursor 포럼). 코딩 일감 한정으로는 Grok Bot 우회 없이 이쪽이 직통이라는 점만 병기.
- "Multi-Agent Beta API coming soon" 풍문은 **오독으로 판명**(원문은 모델 변형 로드맵 — Grok Bot 제어 API 예고 아님).

## 2. 정책 정합

이 방향은 **문서화된 기능만 사용**한다(커스텀 MCP 커넥터 추가 UI·루틴·통합 이벤트) — 선행 리서치에서 문제였던 AUP 저촉(자동화 접근·자격증명 공유) 없음. 자격증명 방향도 안전: 사용자가 oort의 스코프드 봇 토큰을 **자기 봇에게** 주는 것이지, xAI 자격증명이 oort로 들어오는 게 아니다(ADR-0004 비유입 유지). oort 쪽에서 할 일은 우리 약관에 에이전트 접속 허용을 명문화하는 것뿐.

## 3. oort 쪽 수용 표면 — 기존 자산 위에 선다

| 기존 자산 | 역할 |
|---|---|
| ADR-0130 (Accepted) | "임의 에이전트를 1급 멤버로"의 결정 그릇. gateway REST 계약(pending/events/complete/lease)이 이미 **pull 기반** — codex-workbench가 순수 계약 실증. D4(A2A Agent Card 셀프 온보딩) 2단계 예약 |
| `/v1/mcp/drive` (ADR-0113 D3/D5) | **서버 소유 MCP endpoint 선례**: agent bearer + 위임 사용자·채널 바인딩 + 매 호출 grant 재검증 |
| ADR-0101/0102 | 에이전트=member + bearer 신원 |
| 단일 쓰기경로 | Agent Port는 REST 파사드 — PG 직쓰기 없음, 순서=`message.seq` 유지 |

### 제안 표면: "oort Agent Port" (프로토콜 리서치 권고안)
- **Phase 1 — 순수 원격 MCP 서버**: 도구 6종 `inbox_poll(after_seq, wait_hint)` · `thread_read` · `message_post(…, idempotency_key)` · `task_claim(task_id, lease_sec)` · `task_complete` · `task_release`. 커서=`message.seq`(Telegram offset 사상 — at-least-once+멱등 소비가 공짜), 클레임=리스(다중 에이전트 경합). 인증: 초기 정적 스코프드 봇 토큰 → MCP 2026-07-28 사양(RFC 9728 PRM·RFC 8707 오디언스 바인딩·CIMD) 승격. MCP Tasks 확장(2026-07-28 공식 승격)이 "핸들 반환→재접속 폴링→결과 회수" 모델로 우리 일감 구조와 동형.
- **Phase 2 — 지속 연결 겹**: Centrifugo 스코프드 read-only JWT 구독 + REST 쓰기(Discord의 WS 읽기/REST 쓰기 분리와 동형, Centrifugo=전송전용 불변식 그대로). Grok Bot은 못 쓰지만 OpenClaw·자체 배포 하네스가 저지연으로 붙는 겹 — **Agent Port는 Grok Bot 전용이 아니라 벤더 중립이며, Grok Bot은 첫 번째 고객일 뿐**.
- **(선택) Slack 초인종 브리지**: 준실시간이 필요할 때만. oort가 전용 Slack 채널에 **"새 일감 있음" 신호만** 발행(내용 0 — 유출 경계 보존), 봇 루틴이 그걸로 깨어나 내용은 MCP로 당겨감. 실동작 검증된 유일한 이벤트 경로이나 외부 SaaS 의존이라 기본 경로가 아닌 옵션으로.
- ACP/A2A는 1차 표면 부적합 판정(ACP=원격 전송 미완+클라이언트가 에이전트로 접속하는 방향, A2A=호출자→피호출자 방향 — 둘 다 "에이전트가 다이얼인" 제약과 반대). A2A Agent Card 스키마만 ADR-0130 D4대로 프로필에 차용. ACP 원격 전송 RFC는 감시.

## 4. 파급력 평가 (성재 가설 검증)

- **가설 유효**: "에이전트는 원래 클라우드 배포+연동이 엄청 불편한데 Grok Bot이 허들을 없앤다" — 실측과 일치. 사용자 쪽 비용은 구독+커넥터 1회 등록+루틴 1개 생성뿐, 배포·키관리·서버 0. oort 쪽은 Agent Port 하나로 받는다.
- 단 파급의 성격은 재조준 필요: 베타 게이트($120~300/월)·배치형 지연·웨이크업 주권 탓에 당장은 "Grok Bot 사용자 대량 유입"이 아니라 **"oort는 호스팅 에이전트가 다이얼인해 일하는 첫 메신저"라는 표면 선점**이 실익. 같은 표면에 OpenClaw(이미 메신저 브리지 수요 흡수 중)·Claude 계열·자체 배포 에이전트가 즉시 붙는다. HN에서 "이걸 겨루는 오픈소스 대안 있나" 수요 확인됨.
- 시점 이점: Grok Bot 베타 확대(금주 예고)와 맞물려 "당신의 Grok Bot을 oort 팀메이트로" 데모는 바이럴 재료로 유효.

## 5. 리스크 대장

| 리스크 | 등급 | 완화 |
|---|---|---|
| 웨이크업 주권 부재(트리거 카탈로그 유동·루틴 자동 일시정지·베타 재조정 예고) | 높음 | Agent Port를 벤더 중립으로 — Grok Bot은 여러 클라이언트 중 하나. 의존 금지 |
| 분 단위 스케줄 미확인 → 배치형 한계 | 중 | 스파이크로 실측. 불가 시 Slack 초인종 또는 "배치 팀메이트"로 정직하게 포지셔닝 |
| 커스텀 MCP 커넥터의 개인 계정 허용 여부 미실증 | 중 | 스파이크 1순위 항목 |
| 고빈도 폴링 비경제(주간 사용량) | 중 | 기본 케이던스를 저빈도로 설계, 문서에 비용 고지 |
| Cursor 백엔드 프록시 경유 → 소스 식별·레이트리밋 설계 불확실 | 낮음 | 스파이크에서 헤더/IP 실측 |
| 셀프호스팅 oort의 공인 HTTPS 노출 필요(사설 IP 거부) | 낮음 | 기존 Caddy 경로 재사용, 터널 안내 문서화. 보안 경계 변경분은 ADR에 포함 |

## 6. 제안 실행 순서 (전부 성재 승인 대기 — 발사 없음)

1. **Wave 0 — 실증 스파이크 (선행 관문, 구독 계정 필요)**: SuperGrok Heavy 또는 Cursor Ultra 1계정으로 4항목 실측 — ①개인 계정에서 커스텀 MCP 서버(터널) 커넥터 추가 가능 여부 ②봇 세션·루틴에서 그 도구 호출 확인 ③루틴 최소 간격(분 단위 성립?) ④Slack 트리거→MCP 회신 폐곡선 + 소스 IP/헤더. **문서상 "추정"인 ①이 실측되면 방향 확정, 안 되면 Slack 초인종 단독 경로로 축소.**
2. **Wave 1 — ADR 기안**: "oort Agent Port"(원격 MCP 표면·스코프드 봇 토큰·에이전트 접속 허용 약관) — 경계 변경이므로 Accepted 없이 구현 금지(ADR-0100). ADR-0130 체인의 증보로 기안.
3. **Wave 2 — MVP**: Phase 1 도구 6종 + "Grok Bot을 oort 팀메이트로" 사용자 가이드(루틴 프롬프트 템플릿 = 우리가 배포하는 "oort 팀메이트 스킬" 텍스트).
4. **관찰 지속**: Grok 4.6 동반 베타 확대(금주)·트리거 카탈로그 변화·Cloud Agents API에 Grok Bot 노출 여부·ACP 원격 전송 RFC.

## 성재 결정 필요

- ① Wave 0 스파이크 착수 여부 — **구독 계정이 관문**($200~300/월 1개월. 어느 계정/결제로 할지).
- ② Agent Port ADR 기안 착수 여부(스파이크와 병행 가능 — 표면 설계는 Grok Bot 실측과 독립).
- ③ Slack 초인종 브리지를 스코프에 넣을지(외부 SaaS 의존 — 기본 경로 아님을 전제로).

## 8. 현행 설계 감사 — "주=외부 연동" 테제 대조 (2026-08-12 성재 질문 후속)

성재 질문: "oort 서버가 에이전트를 소유하는 구조인가? 주는 ACP형(외부 연동)이어야 하고, 셀프호스팅 동봉+개별 업데이트도 살리고 싶다."

- **설계 정본은 테제와 일치**: ADR-0102(Accepted)가 worker(managed)/gateway(BYOA) 이중 경로를 공식화 — 기각 사유에 "성재의 실운용=bring-your-own-agent가 agent-native 초대 경험의 핵심" 명시. 서버 소유는 신원·멤버십·순서·승인·비용·감사뿐(경로 무관 서버 기계장치로 통일). hermes는 역사적으로 사용자 소유 gateway 프로세스 — 종전 "hermes형=서버 상주" 명명은 부정확했다.
- **ACP 체인(ADR-0130)은 Swift 퇴역으로 부분 좌초**: MomoACPHost(Swift) 퇴역·work_tool_profile 원장 server-rust 부재(grep 0)·X-11(workd ACP 릴레이, MOMO-546) Swift 시대 in-progress에서 정지(`clients/web/src/features/work/WorkSessionDetail.tsx:84` 주석이 현행 자백)·D4 Agent Card 미착수. **"주=ACP형"의 선행 과제 = 0130 체인 현행 스택 재랜딩.** 현재 실제로 사는 외부 연동은 gateway 계약(codex-workbench·prime).
- **동봉+업데이트는 실재 갭**: 셀프호스팅 계획(#1227~#1229)에 에이전트 동봉 개념 0. `adapters/`(hermes·prime·codex-workbench)가 재료로 존재하나 버전 원장·업데이트 라이프사이클·개별 업데이트 버튼 전무(work_tool_profile에도 버전 개념 없음). → 제안: **에이전트 카탈로그 원장**(어댑터 이미지+기본 프로필+provider 요구, 온보딩 선택 설치=compose profile) + **버전·업데이트 표면**(태그 비교→pull&restart→마이그레이션 노트). 배포 계약+운영 표면 경계 변경 = ADR감.
- **네이밍 제안(성재 확정 대기)**: 관리형(managed — worker+provider 체인, 동봉·카탈로그가 얹히는 곳) / 연동형(BYOA — gateway+ACP 하네스, **주력**) / 다이얼인형(Agent Port — 부를 수 없는 호스팅 봇, 본 문서 §3).
- 다음 결정 지점: ①0130 재랜딩의 로드맵 편성 ②카탈로그+업데이트 ADR 기안 ③3분류 네이밍 확정.

## 출처 (전 항목 2026-08-12 확인)

docs.x.ai/grok-bot/* 14페이지(llms.txt 경유 원문 전량, last updated 08-11 — overview·get-started·skills-routines-and-automations·computer-and-apps·approvals-security-and-privacy·settings-and-notifications·teams-and-enterprises·faq 등) · docs.x.ai/grok/connectors(+custom-mcp-tunneling) · cursor.com/docs/cloud-agent/{api/endpoints,api/webhooks,automations} · cursor.com/docs/integrations/{slack,github} · cursor.com/docs/plugins · blog.modelcontextprotocol.io/posts/2026-07-28(MCP 사양) · agentclientprotocol.com · a2a-protocol.org · docs.slack.dev(Socket Mode) · core.telegram.org/bots/api · spec.matrix.org(AS API) · docs.discord.com(Gateway) · docs.openclaw.ai/{concepts/architecture,providers/xai} · github.com/dicklesworthstone/mcp_agent_mail(MCP 메일박스 선례) · news.ycombinator.com/item?id=49261514(234코멘트) · note.com/masa_wunder(Slack 트리거 실동작 핸즈온) · explainx.ai(베타 리포트) · usecarly.com · kingy.ai · 9to5mac.com · roo.beehiiv.com(Cursor 인프라 분석) · datastudios.org(풍문 원출처 — 오독 판정)
