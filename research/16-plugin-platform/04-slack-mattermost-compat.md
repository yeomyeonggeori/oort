# 16-04 · Slack/Mattermost 생태계 호환 표면 (성재 발제 2026-07-16)

> Planning ID: `PLN-20260716-01` · 검증: 2026-07-16 공식 1차 소스 · 발제: "Slack이나 Mattermost에서 사용하던 플러그인/연동을 oort에서 계속 쓸 수 있게"
> 요약 판정: **호환 가능한 것은 와이어 포맷(webhook/slash의 HTTP 페이로드)뿐** — Slack 인프라 결합분(OAuth/Marketplace/Events API/interactivity)과 Mattermost 플러그인 바이너리는 불가. 이는 Mattermost 자신이 12년째 유지하는 전략과 일치. **"incoming webhook 호환 = 가성비 1위" 가설 검증됨.**

## 1. Slack "앱"의 결합도 분해

| 구성요소 | 와이어 포맷 | Slack 인프라 결합 | oort 수용 |
|---|---|---|---|
| incoming webhook | JSON POST(`text`/`blocks`/`attachments`) | URL 발급만 | **가능** — URL을 oort가 발급하면 페이로드 그대로 |
| attachments(legacy) | 공개 스펙(fallback/color/fields…) — CI 도구 대다수가 여전히 사용, 문서 동결 관리 | 없음 | **가능**(Mattermost 선례) |
| slash command | form-encoded POST → JSON 응답 | Request URL·signing secret | **포맷은 가능**, `trigger_id`(modal) 불가 |
| Events API | JSON push | OAuth 스코프·워크스페이스 설치·앱 설정에 완전 결합 | 불가(oort 자체 outbound webhook으로 유사 표면만) |
| Block Kit 표시 | 공개 스펙 | 없음 | **부분집합 가능** |
| Block Kit 인터랙션 | interaction payload | interactivity URL + trigger_id + Web API(views.open) | 사실상 불가 |
| OAuth 설치·Marketplace | — | Slack 호스팅·심사 | 불가(복제 대상 아님) |

핵심: "Slack 앱"의 몸통은 `api.slack.com` Web API 클라이언트 코드 — 바이너리 재사용은 Web API 전체 에뮬레이션이 필요하고 Mattermost조차 가지 않은 길. 벤치마크 상한선 = **서드파티가 "Slack에 쏘는" 쪽 와이어 포맷**.

## 2. Mattermost 선례 (벤치마크 확정)

- **incoming**: 공식 "Slack compatibility" 문서 — `<url|text>`/멘션/`<!channel>` 자동 번역. 명시적 미지원: `<#CHANNEL_ID>`, mrkdwn/parse/link_names, `*bold*`, `<!everyone>`. **Block Kit `blocks` 미지원**(issue #14973 closed as not planned — 커뮤니티가 변환 프록시를 만들 정도의 수요 존재).
- **attachments**: "for compatibility with Slack non-markdown integrations" 공식 렌더(Slack 동일 계열 필드, `ts`만 미지원).
- **outgoing/slash**: 공식 문서 원문 "**copy-and-paste code used for a Slack outgoing webhook**... Mattermost automatically translates Slack's proprietary JSON payload format."
- 실동작: GitHub/Jenkins류 "Slack webhook URL 한 칸" 도구는 URL 교체만으로 동작. 인터랙티브 버튼은 MM 고유 스키마(호환 아님). 데이터 이식은 별도 축(mmetl/mmctl).
- Rocket.Chat: 스크립트 변환 레이어(`process_incoming_request`)로 임의 포맷 수용 — oort에는 서명·감사 가능한 **고정 변환기**가 불변식에 더 정합.

## 3. Mattermost 플러그인 바이너리 — 호환 기각 확정 (16-00 [미확인] 해소)

1. 번들 = plugin.json + **플랫폼별 컴파일 Go 실행 파일** + React webapp 번들 + settings_schema.
2. 실행 = MM 서버가 서브프로세스로 spawn + **RPC(hooks/API 수백 개)** — 컴파일 타임 결합. oort(Swift)에서 실행하려면 사실상 MM 재구현.
3. 설치 = 시스템 관리자 단위 marketplace. 공식 플러그인 라이선스 = **Apache-2.0**(GitHub API 확인) → 바이너리는 못 돌려도 **동작 사양의 oort MCP 플러그인 이식은 자유**.
4. **Apps Framework(HTTP 크로스플랫폼 앱) 사망 확정**: v10.0.0(2024-08) 서버 지원 종료, 공식 deprecated — "webhooks, slash commands, OAuth2 apps, and plugins로 확장하라". **MM 자신도 플러그인의 플랫폼 결합을 풀려다 실패·철회** — oort가 포맷 차용 대신 webhook 와이어 호환+자체 MCP 모델을 취할 공식 근거.

## 4. oort 채택 권고 (ADR-0113 §Slack-compat / ADR-0115 연계)

1. **① Slack-compatible incoming webhook — 채택, 우선순위 1**: ADR-0115 signed webhook ingress 위의 변환 레이어. `POST /hooks/{token}`(Slack 동형 URL-시크릿 모델) → text+attachments+`<>`번역 → 단일 쓰기경로. v1 화이트리스트는 **Mattermost 지원 필드 목록을 그대로 차용**(12년 검증된 부분집합), 미지원 목록도 동일하게 문서화. 효과: GitHub/Jenkins/Grafana/Alertmanager가 URL 교체만으로 oort에 알림.
2. ② outgoing/slash 호환 — 2순위·조건부: Slack 자신이 legacy 강등. oort에선 MCP 툴 앞 어댑터로만, v0 제외.
3. ③ Block Kit **표시 전용 부분집합**(section/header/context/divider/image/fields → 타임라인 카드) — 후속 분리. **MM이 거부한 지점이라 구현 시 "MM보다 나은 Slack 호환"이라는 구체적 우위.** 인터랙션은 제외(앱 호스팅 모델 복제가 됨).
4. ④ MM 플러그인 바이너리 — **기각**(§3). 인기 플러그인의 사양 이식은 Apache-2.0으로 자유.

## Open questions

Slack Web API 부분집합(`chat.postMessage`) 에뮬레이션 여부(기본값 아니오 — 별도 발제 가치만) · mrkdwn 번역 규칙표 · Slack-호환 URL 시크릿과 ADR-0115 서명 모델의 문서 통합 여부 · blocks 부분집합의 카드 매핑(UX 바이블 검토 — 별도 기획 티켓).

## 소스 (요지)

docs.slack.dev(sending-messages-using-incoming-webhooks·legacy-secondary-message-attachments·apis/events-api·implementing-slash-commands·block-kit·distribution·legacy outgoing) · developers.mattermost.com(integrate/webhooks/incoming·outgoing·slash-commands/slack·reference/message-attachments·plugins·plugins/manifest-reference) · docs.mattermost.com deprecated-features · mattermost/mattermost#14973 · mattermost-plugin-github LICENSE(Apache-2.0, API 확인) · docs.rocket.chat/docs/integrations
