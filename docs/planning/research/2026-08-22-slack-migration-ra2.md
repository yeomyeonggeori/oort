> [Fable 검수 2026-08-22] RA-2 서브에이전트 산출을 검수 승격. 핵심 채택: v1=export zip 단일 경로(public 채널·스레드·리액션)+드라이런 리포트, 라이브 API는 BYO 내부앱 토큰으로 v2. 2026-03-03 유예 종료일은 [2차] 표기 — 티켓 발사 전 원문 재확인 의무. 모계획: 2026-08-22-aside-onboarding-three-axis-plan.md

# RA-2 리서치 노트 — Slack → oort 마이그레이션 기술 조사

- 작성: 2026-08-22 / 조사자: RA-2 (웹 리서치 팀메이트)
- 대상: oort(Postgres SoT, `member`/`channel`/`message.seq` 스키마)로 Slack 워크스페이스 히스토리를 옮기는 경로 설계
- 표기 규칙: **[확인]** = 1차 출처(Slack 공식/프로젝트 공식 문서)로 확인 · **[2차]** = 블로그·벤더 글 등 2차 출처만 · **[미확인]** = 출처를 찾지 못함, 실측/문의 필요

---

## 0. 세 줄 결론 (먼저 읽을 것)

1. **라이브 API 경로는 "누가 앱을 만드느냐"에 따라 살거나 죽는다.** 2026-03-03 유예 종료로, Marketplace 미승인 **배포형(commercially distributed)** 앱의 `conversations.history`/`conversations.replies`는 **1 req/min × 15건**으로 사실상 마비다. 반면 **고객이 자기 워크스페이스에 직접 만든 내부 앱(internal customer-built app)**은 **50+ req/min × limit 1000**을 유지한다. → oort가 "설치형 SaaS 앱"으로 가면 죽고, **"고객이 만든 토큰을 붙여넣는 BYO-token"** 으로 가면 산다. 이게 이번 조사의 최대 발견이다.
2. **Export zip은 정책 리스크가 0에 가깝지만 플랜 장벽이 있다.** Free/Pro는 **public 채널만**, private 채널·DM은 **Business+ 이상 + Slack 승인(compliance export)** 필요. 그리고 **zip에 파일 실물이 없다** — 링크만 들어있고 다운로드에 인증이 필요하다.
3. **v1 권고: export zip 단일 경로 + public 채널 + 스레드/리액션/멘션까지.** DM·private·파일 실물·앱/워크플로는 v1에서 명시적으로 포기하고, 라이브 API는 "BYO 내부앱 토큰" 옵션으로 v2에 둔다.

---

## 1. Slack 공식 워크스페이스 export

### 1.1 zip 구조 **[확인]**

출처: <https://slack.com/help/articles/220556107-How-to-read-Slack-data-exports>

최상위 메타 파일(export 종류에 따라 일부만 존재):

| 파일 | 내용 |
|---|---|
| `channels.json` | public 채널 메타(id, name, created, creator, members[], topic, purpose) |
| `groups.json` | private 채널 메타 (compliance export에서만) |
| `dms.json` | 1:1 DM 메타 (compliance export에서만) |
| `mpims.json` | 그룹 DM 메타 (compliance export에서만) |
| `users.json` (Enterprise Grid는 `org_users.json`) | 멤버 정보 |
| `integration_logs.json` | 앱·인테그레이션 활동 로그 |
| `canvases.json` | 캔버스 URL·메타 |
| `file_conversations.json` | 캔버스 코멘트 메타 |
| `content_flags.json` | 신고 메시지 (Enterprise 전용) |

대화별 디렉터리: `채널명/YYYY-MM-DD.json`. **활동이 없는 날짜의 파일은 아예 생성되지 않는다**(누락 ≠ 오류). 각 일자 파일은 메시지 객체의 **배열**.

### 1.2 메시지 JSON 스키마 **[확인]**

필수 필드: `type`, `user`, `text`, `ts`.

```json
{
  "type": "message",
  "user": "U2147483697",
  "text": "Hello world",
  "ts": "1355517523.000005"
}
```

- **`ts`** — `"<epoch초>.<6자리>"` 문자열. 채널 내 유니크 ID 겸 정렬 키. **문자열 비교가 아니라 (초, 마이크로초) 튜플로 파싱해 정렬해야 안전**(자릿수 고정이라 실무상 문자열 비교도 대개 맞지만, 파싱이 정석).
- **`thread_ts`** — 스레드 소속 표시. 부모 메시지는 `thread_ts == ts`이고 `reply_count`/`reply_users_count`를 가짐. 답글은 `thread_ts`가 부모의 `ts`이고 `parent_user_id`를 가짐. **[확인: thread_ts/reply_count는 help 문서, parent_user_id는 API 문서 기준]**
  - ⚠️ **함정**: Slack help 문서는 *"Your export file will not differentiate between messages in a thread and messages sent to a channel. All messages in a thread will appear in the flow of the conversation."* 라고 쓴다. 이건 **파일 배치**에 관한 말이다 — 답글이 별도 파일로 분리되지 않고 부모와 같은/다른 날짜 파일에 시간순으로 섞여 들어간다는 뜻이지, `thread_ts` 필드가 없다는 뜻이 아니다. **스레드 재구성은 `thread_ts`로 가능하다.** 단, 부모와 답글이 **날짜 파일을 가로질러** 흩어질 수 있으므로 채널 전체를 로드한 뒤 2-pass로 묶어야 한다.
  - `replies` 배열(부모에 답글 ts 목록)은 API에서 2019-10-18 deprecated. export에도 있을 수 있으나 **의존 금지**. **[2차]**
- **`reactions`** — `[{ "name": "astonished", "count": 3, "users": ["U1","U2","U3"] }]`. 커스텀 이모지는 이름만 있고 이미지가 zip에 없다(별도 수집 필요).
- **`files` / `attachments`** — 아래 1.4 참조.
- **`is_starred`**, **`pinned_to": ["C024BE7LT"]`** — 저장/고정.
- **`subtype`** — 20종 이상. import에서 중요한 것들:
  - `bot_message` (앱/봇 발화 — `bot_id`, `username`, `icons`)
  - `message_changed` (편집: `previous.text`, `original_ts`, `editor_id`)
  - `message_deleted` (삭제: `previous`, `editor_id`)
  - `channel_join` / `channel_leave` (**노이즈 — 대부분의 importer가 버린다**)
  - `file_share`, `pinned_item`, `unpinned_item`, `channel_topic`, `channel_purpose`, `me_message`, `thread_broadcast`

### 1.3 텍스트 내 마크업 포맷 (mrkdwn) **[확인/부분 2차]**

`text`는 평문이 아니라 Slack mrkdwn이며 엔티티가 **ID로 치환**되어 있다. help 문서: *"All usernames are replaced by user IDs... all channel names are replaced by channel IDs."*

| 원본 | export 표기 |
|---|---|
| 유저 멘션 | `<@U024BE7LH>` (표시명 포함형 `<@U024BE7LH|alice>`도 존재) |
| 채널 링크 | `<#C024BE7LT|general>` |
| 특수 멘션 | `<!here>`, `<!channel>`, `<!everyone>` |
| 유저그룹 | `<!subteam^SAZ94GDB8|@team>` |
| 링크 | `<https://ex.com|라벨>` |
| 이모지 | `:smile:` (숏코드 그대로) |
| 강조 | `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ```block``` ```` , `> quote` |
| 이스케이프 | `&amp;` `&lt;` `&gt;` (**언이스케이프 필수**) |

→ **oort는 자체 렌더 포맷이 있으므로 mrkdwn→oort 변환기가 import의 실질적 난이도 절반이다.** 신규 Slack 메시지는 `blocks`(Block Kit) 배열도 함께 갖는데, `text`는 폴백 텍스트다. **v1은 `text`만 쓰고 `blocks`는 원본 JSON을 `raw` 컬럼에 보존**하는 게 실용적.

### 1.4 파일 첨부 — 가장 큰 함정 **[확인]**

- **zip 안에 파일 실물이 없다.** help 문서: 익스포트 파일은 *"do not contain any files from the workspace. They include a series of file links... that direct back to the workspace's files."*
- 다운로드는 `url_private` / `url_private_download`를 **`Authorization: Bearer <token>` 헤더 + `files:read` 스코프**로 호출해야 한다. 브라우저 쿠키 세션으로도 가능. 출처: <https://docs.slack.dev/reference/objects/file-object/>
- 즉 **파일까지 옮기려면 export zip만으로는 불가능하고 반드시 토큰이 필요하다.** (Rocket.Chat이 "Download Pending Files"를 별도 단계로 둔 이유가 이것.)
- 원 워크스페이스를 해지/삭제하면 링크가 죽는다 → **파일 백필은 Slack 해지 전에 끝내야 한다**는 운영 제약. **[2차]**
- Free 플랜은 **파일 링크가 최근 90일치만** 포함된다. **[확인: Export your workspace data]**

### 1.5 플랜별 범위 **[확인]**

출처: <https://slack.com/help/articles/201658943-Export-your-workspace-data>

| 플랜 | public 채널 | private 채널 | DM/그룹DM | 비고 |
|---|---|---|---|---|
| **Free** | ✅ JSON | ❌ | ❌ | 파일 링크는 **최근 90일**만 |
| **Pro** | ✅ JSON | ❌ | ❌ | |
| **Business+** | ✅ | **승인 시 ✅** | **승인 시 ✅** | self-serve compliance export 신청 필요, 주간/월간 예약 export 가능 |
| **Enterprise Grid** | ✅ | ✅ | ✅ | 대화유형·멤버·워크스페이스별 커스텀 export, Discovery API 별도 |

- 실행 권한: Workspace Owner/Admin, **Export Admin** 시스템 역할 보유자, Enterprise Grid의 Org Owner.
- **승인 절차**: compliance export 신청은 *"approval from the Workspace Primary Owner, so our Support team will reach out via email before proceeding"* — **Slack 지원팀이 이메일로 접촉하는 수동 심사**다. 공식 문서에 소요 기간 명시 없음 **[미확인 — 실무상 수일~수주라는 2차 보고가 있으나 공식 수치 아님]**.
- 채널 감사 리포트(CSV)는 Business+ 이상.

### 1.6 export 소요/크기 **[2차]**

- 소규모: 수 분. 중간(1만~10만 메시지): 15~60분. 대규모(10만+): 수 시간. 수 GB zip.
- Slack **자체** import 도구 기준 2GB 초과 zip은 별도 호스팅 URL 필요.
- Mattermost 공식 문서 기준(변환 기준이라 참고치): *"files under ~25 GB often complete within a day, while exports over 100 GB can take several days."* **[확인 — Mattermost 문서]**
- → **oort importer는 스트리밍 파서 필수.** zip 전체를 메모리에 올리면 안 된다.

---

## 2. Slack API 라이브 가져오기 경로

### 2.1 2025~2026 rate limit 정책 — 현재 상태 (핵심)

출처(1차):
- <https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/>
- <https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/>
- <https://docs.slack.dev/apis/web-api/rate-limits/>

**대상 메서드: `conversations.history`, `conversations.replies` 단 둘.**

| 앱 분류 | `conversations.history/replies` 한도 | 상태 |
|---|---|---|
| **Marketplace 승인 앱** | 변경 없음 (기존 Tier 3급) | ✅ |
| **내부 고객제작 앱 (internal customer-built app)** | **50+ req/min, `limit` 최대·기본 1,000** | ✅ **영향 없음** |
| **Marketplace 미승인 배포형 앱** | **1 req/min, 요청당 최대 15건** | ❌ 사실상 사용 불가 |

**타임라인 [확인 + 2차 혼재]:**
- 2025-05-29: 신규 생성 앱 및 기존 앱의 **신규 설치**에 즉시 적용 **[확인]**
- 2025-06-30: 2025-05-29 이전 생성 앱에 대한 API ToS 준수 기한 **[확인]**
- **2026-03-03: 유예 종료 — Marketplace 외부 배포 앱의 *기존 설치분*까지 새 한도 적용** **[2차 — 복수의 2차 출처가 일치하나, docs.slack.dev 원 changelog 본문에서 이 날짜를 직접 확인하지 못함. 발사 전 재확인 권장]**
- 즉 **오늘(2026-08) 기준, 비-Marketplace 배포형 앱은 전부 1 req/min이다.**

**Slack의 명시적 이유**: 이 메서드들은 *"designed to facilitate an app reading a comment or a thread, but in the hands of unvetted applications have the potential to exfiltrate large amounts of sensitive conversational data."* → **"대량 히스토리 반출"이 바로 Slack이 막으려는 행위다.** oort의 마이그레이션은 정의상 그 행위이므로, 정책 리스크를 낮게 잡으면 안 된다.

**"internal customer-built app" 정의 [부분 미확인]**: 공식 changelog는 이 용어에 대한 **형식적 정의를 제공하지 않는다**. 문맥상 "그 조직이 자기 워크스페이스에서 쓰려고 직접 만들어 설치한 앱(배포하지 않는 앱)"을 뜻한다. → **oort 제품이 배포하는 앱은 여기 해당하지 않을 가능성이 높다.**

### 2.2 oort에 대한 함의 — 아키텍처 분기점

- **경로 A (oort가 Slack 앱을 배포하고 고객이 설치)** → "commercially distributed, non-Marketplace" → **1 req/min × 15건**. 10만 메시지 = 6,667분 ≈ **4.6일 연속 폴링**. 실질 불가.
  - 우회는 **Slack Marketplace 심사 통과**뿐. 심사 통과 시 정상 한도. 다만 "경쟁 메신저로의 마이그레이션 도구"가 Marketplace 심사를 통과할지는 **[미확인 — 선례 확인 못함, 높은 불확실성]**.
- **경로 B (고객이 자기 워크스페이스에 앱을 만들고 oort는 토큰만 받음, BYO-token)** → **internal customer-built app → 50+ req/min × limit 1000**. 10만 메시지 = 100 req = **2분**. 완전히 실용적.
  - 이게 Zulip이 택한 길이다(사용자가 `xoxb-` 토큰을 직접 만들어 넣음).
  - 리스크: (a) 온보딩 마찰(고객이 Slack 앱 manifest 만들고 스코프 붙이고 토큰 복사) — **manifest URL 원클릭으로 크게 완화 가능**, (b) Slack이 "실질적으로 제3자 서비스가 쓰는 토큰"을 내부앱으로 볼지에 대한 해석 리스크가 잔존 **[미확인]**.
- **권고: 경로 B를 기본값으로 설계하되, v1에서는 export zip을 1순위로 두고 API는 "파일 실물 백필 + 증분 동기화" 보조로만 쓴다.**

### 2.3 엔드포인트·스코프·페이지네이션 **[확인/부분 2차]**

| 목적 | 메서드 | 티어 | 스코프 |
|---|---|---|---|
| 채널 목록 | `conversations.list` | **Tier 2 (20+/min)** | `channels:read`, `groups:read`, `im:read`, `mpim:read` |
| 채널 히스토리 | `conversations.history` | **Special (위 표)** | `channels:history` 등 |
| 스레드 답글 | `conversations.replies` | **Special (위 표)** | 동일 |
| 채널 멤버 | `conversations.members` | Tier 4 | `channels:read` 등 |
| 유저 목록 | `users.list` | **Tier 3 (50+/min)** | `users:read`, `users:read.email` |
| 커스텀 이모지 | `emoji.list` | Tier 2 | `emoji:read` |
| 파일 | `files.list` / `url_private_download` | (files.list 티어 문서 미명시) | `files:read` |
| 워크스페이스 메타 | `team.info` | Tier 3 | `team:read` |

- 페이지네이션: 커서 방식(`cursor` / `response_metadata.next_cursor`). `limit` 최대 1000(내부앱), 제한 앱은 15.
- **429 처리**: `HTTP 429` + `Retry-After`(초) 헤더. **메서드×워크스페이스 단위**로 적용. 재시도는 반드시 `Retry-After`를 존중해야 한다. 지수 백오프만 쓰면 안 됨.
- 특수: 메시지 게시는 채널당 1 msg/sec (import 쪽엔 무관하지만 역방향 미러링 시 중요).
- ⚠️ **[2차]** 커뮤니티 보고: 제한 적용 후 `limit: 100`을 줘도 15건만 반환되는 사례. → limit 파라미터가 조용히 잘리므로 **반환 건수로 제한 여부를 감지**하는 방어 코드 권장.

### 2.4 Discovery API (Enterprise Grid) **[2차]**

- Enterprise Grid 전용 + **Slack 승인 파트너만** 사용 가능한 HTTP API.
- 단일 통합으로 Grid 내 **모든 워크스페이스의 모든 메시지·파일·채널·DM·그룹DM·Slack Connect**를 워크스페이스별 설치 없이 조회. **삭제된 메시지와 편집 이력까지** 포함.
- eDiscovery/DLP/컴플라이언스 아카이빙 목적으로 설계.
- **oort 판단: v1~v2 범위 밖.** 파트너 승인 장벽이 높고, 타깃 고객(그록봇 유저·소규모 팀)이 Enterprise Grid일 확률이 낮다. **다만 대형 고객 딜이 생기면 유일한 정공법이므로 존재만 기록.**

### 2.5 기존 도구: slackdump **[확인]**

<https://github.com/rusq/slackdump>

- 관리자 권한 없이 브라우저 세션 인증("EZ-Login 3000")으로 메시지·유저·채널·파일·이모지를 덤프. **Standard / Mattermost 형식의 Slack Export zip 생성 가능.** SQLite 아카이브, 변환, 뷰어, MCP 서버 모드까지 지원.
- README에 2025 rate limit 변경 언급 **없음** — 브라우저 세션(유저 토큰) 경로라 앱 분류 밖일 가능성이 있으나 **[미확인]**.
- ⚠️ **라이선스 AGPLv3.** oort의 "AGPL 백본 금지" 제약과 정면 충돌 → **코드 채택 불가. 포맷 참조·수동 운영 도구로만.**

---

## 3. 오픈소스 선례

### 3.1 비교표

| 항목 | **Mattermost** | **Rocket.Chat** | **Zulip** |
|---|---|---|---|
| 문서 | [migrate-from-slack](https://docs.mattermost.com/administration-guide/onboard/migrate-from-slack.html) | [import-from-slack](https://docs.rocket.chat/docs/import-from-slack) | [import-from-slack](https://zulip.com/help/import-from-slack) |
| 코드 | [mattermost/mmetl](https://github.com/mattermost/mmetl), [slack-advanced-exporter](https://github.com/mattermost/slack-advanced-exporter) | Rocket.Chat 본체 importer 모듈 | [zerver/data_import/slack.py](https://github.com/zulip/zulip/blob/main/zerver/data_import/slack.py) + `convert_slack_data` 관리 커맨드 |
| 입력 | export zip → `mmetl` 변환 → bulk import (UI import는 레거시) | export zip 업로드 | **export zip + (선택) `xoxb-` 토큰** |
| public 채널 | ✅ | ✅ | ✅ |
| private/DM | ✅ (compliance export가 있을 때만) | ❌ **public만** | ✅ (export에 있으면) |
| 스레드 | ✅ (네이티브 스레드) | 부분 | ✅ **→ Zulip "토픽"으로 변환**(토픽명 = 날짜 + 원문 스니펫, 예: `2023-05-30 Hi, can anyone reply if you're o…`) |
| 리액션 | ✅ | ✅ | ✅ |
| 파일 | ✅ (별도 exporter로 실물 수집 필요) | ⚠️ **URL 참조만 → "Download Pending Files" 별도 실행 전까지 방에 안 보임** | ✅ (첨부 포함) |
| 커스텀 이모지 | 부분 | 부분 | ✅ (`emoji:read` 필요) |
| 유저 매칭 | **이메일 기준**, 동일 이메일이면 기존 계정에 병합. 이메일 없으면 placeholder → 수동 교정 | Slack Workspace Admin → RC admin, 나머지 user | 이메일 기준, 불일치 시 **가입 시 드롭다운에서 자기 Slack 계정 선택** |
| 명시적 미지원 | 앱/봇/슬래시커맨드/웹훅/워크플로 빌더, 즐겨찾기(starred), 유저그룹, 캔버스, 프로필 사진·커스텀 필드·프레즌스, 삭제된 유저의 채널 멤버십 | private 채널, DM | **메시지 편집 이력**, `@user joined #channel` 메시지, 워크스페이스/유저 설정, 비밀번호 |
| 멱등성 | bulk import는 **멱등** / 레거시 Slack UI import는 **비멱등(중복 생성)** ⚠️ 문서 간 서술 불일치 있음 | 동명 채널 존재 시 **기존 채널에 병합** | (명시 없음) |
| 실무 팁 | 25GB 이하 ≈ 1일, 100GB 초과 ≈ 수일. Grid는 `teams.json` 매핑 선행 | **파일당 15MB 미만이 되도록 기간을 쪼개 export 권장** | 토큰은 `xoxb-`만, `xoxe-` 불가 |

### 3.2 세 프로젝트가 공통으로 **포기**한 것

1. **앱·봇·인테그레이션·워크플로** — 전부. (oort도 포기해야 한다. 단 oort는 "에이전트=member" 원칙이 있으므로 **`bot_message`를 어떤 member로 접지할지**는 별도 결정 필요.)
2. **편집/삭제 이력** — Zulip 명시 포기. Discovery API 없이는 애초에 완전 복원 불가.
3. **워크스페이스/유저 설정, 알림 설정, 프레즌스**.
4. **저장(starred)/즐겨찾기**, 유저그룹.
5. **캔버스·허들·리스트 등 신규 Slack 기능** — export에 메타만 있고 콘텐츠 이관은 사실상 없음.

### 3.3 매핑 난점 5가지 (oort가 반드시 결정해야 할 것)

**① 유저 매칭.** 업계 표준은 **이메일 기준 매칭**. 문제는 (a) Slack export의 `users.json`에 이메일이 없는 경우(게스트·SSO 설정에 따라), (b) 봇/앱 유저, (c) **삭제(deactivated)된 유저** — Mattermost는 이걸 명시적으로 미지원. → oort 권고: **`member`에 `external_ref = "slack:U024BE7LH"` 를 두고, 이메일 매칭은 그 위의 선택적 병합 단계로 분리.** 매칭 실패자는 **tombstone member(비활성, 표시명만 보존)**로 생성해 메시지 작성자 무결성을 지킨다. 이게 "이메일 없으면 placeholder" 보다 깔끔하다.

**② 스레드.** Slack은 채널 안의 평평한 시간축 + `thread_ts` 그룹핑. oort가 네이티브 스레드를 가지면 1:1 매핑, 없으면 Zulip처럼 토픽/서브채널로 승격해야 하고 그 순간 **채널 수가 폭증**한다. 추가 함정 3개:
- 부모와 답글이 **다른 날짜 파일**에 있음 → 채널 단위 2-pass 필수.
- `subtype: thread_broadcast`(스레드 답글을 채널에도 노출)는 **중복 삽입 위험** — 한 번만 넣어야 한다.
- 부모가 삭제되고 답글만 남은 **고아 스레드** 존재 가능 → 합성 부모(placeholder) 생성 규칙 필요.

**③ 타임스탬프 ↔ `message.seq`.** oort의 순서 정본은 `message.seq`(채널 내 단조증가)인데 Slack의 정본은 `ts`다. 두 축을 어떻게 접합할지가 **이번 마이그레이션의 최대 스키마 이슈**다. 권고:
- import는 **빈 채널에만** 허용하고, `ts` 오름차순으로 `seq = 1..N`을 부여. 라이브 메시지는 `N+1`부터.
- 기존 채널에 섞어 넣는 "인터리브 import"는 **v1에서 금지**. `seq` 재작성은 클라이언트 캐시·읽음위치·아이들empotency를 전부 깨뜨린다.
- `ts` 원본은 `message.origin_ts`(또는 `raw` JSONB) 에 **반드시 보존** — 재실행·감사·중복제거 키.
- 멱등 키: `(channel_id, "slack:" || original_ts)` 유니크 인덱스. Mattermost 레거시 import가 중복을 만든 실패를 그대로 답습하지 않으려면 이건 필수다.
- ⚠️ **아키텍처 불변식 충돌 주의**: oort 하드룰은 "단일 쓰기경로(REST→PG→outbox→relay)"다. 10만 건 import를 이 경로로 흘리면 **outbox/Centrifugo relay가 폭발**한다. → **백필 전용 경로**를 만들되, "PG가 SoT"는 유지하고 **outbox 이벤트는 개별 메시지가 아니라 '채널 X 백필 완료' 요약 1건**만 발행하는 설계를 권고. (이건 ADR감이다.)

**④ 리액션·이모지.** `reactions[].users`는 유저 ID 배열이라 ①의 매칭 결과에 의존. 매칭 실패 유저의 리액션을 버릴지 익명 카운트로 남길지 결정 필요. **커스텀 이모지 이미지는 export zip에 없다** → `emoji.list` API + 다운로드가 필요하고, 없으면 `:custom_name:` 이 깨진 텍스트로 남는다. v1은 **표준 유니코드 이모지만 매핑, 커스텀은 원문 숏코드 텍스트 유지**를 권고.

**⑤ 멘션·링크 언어 변환.** `<@U…>`, `<#C…|name>`, `<!here>`, `<https://…|label>`, `&amp;` 이스케이프. **유저/채널 ID를 oort ID로 치환하는 단계가 유저·채널 import 이후에 와야 하므로 3-pass 파이프라인**(users → channels → messages)이 강제된다. `<!here>`/`<!channel>`을 oort가 지원하지 않으면 평문으로 강등해야 하는데, **강등 시 원문 의도가 사라지는 것을 UX에서 어떻게 알릴지**가 남는다.

---

## 4. 권고 초안

### 4.1 export zip vs 라이브 API 비교표

| 축 | **Export zip** | **라이브 API (경로 B: 고객 내부앱 BYO-token)** | **라이브 API (경로 A: oort 배포 앱)** |
|---|---|---|---|
| 데이터 범위 | public 전부 / private·DM은 Business+ & 승인 | 토큰 스코프가 닿는 전부(유저토큰이면 private·DM 포함) | 동일하나 속도로 인해 실질 불가 |
| 파일 실물 | ❌ 링크만 (토큰 별도 필요) | ✅ `files:read`로 직접 수집 | ✅ (느림) |
| 편집/삭제 이력 | 부분 (`message_changed` 잔재) | ❌ (현재 상태만) | ❌ |
| 커스텀 이모지 | ❌ | ✅ `emoji.list` | ✅ |
| 증분 동기화 | ❌ (매번 전량 재신청) | ✅ (`oldest` 커서) | ❌ |
| 플랜 요구 | **private/DM은 Business+ 이상 + Slack 수동 승인** | 플랜 무관 (스코프 승인만) | 플랜 무관 |
| 속도 | export 생성 수 분~수 시간(1회) | **50+ req/min × 1000 → 10만 건 ≈ 2분** | **1 req/min × 15 → 10만 건 ≈ 4.6일** |
| 구현 난이도 | **낮음** (zip 스트리밍 파서 + 3-pass) | 중 (페이지네이션·429·`Retry-After`·스코프 온보딩) | 중 (+비현실적 러닝타임) |
| 온보딩 마찰 | 관리자가 zip 받아 업로드. **compliance 승인은 수일~수주 [미확인]** | 고객이 Slack 앱 생성 + 토큰 복사 (manifest 원클릭으로 완화) | OAuth 버튼 1회 (가장 매끄러움) |
| 정책 리스크 | **낮음** — 워크스페이스 소유자의 정당한 자기 데이터 반출 | **중** — "internal app" 해석 리스크 잔존 [미확인] | **높음** — Slack이 명시적으로 막는 행위 |
| 실패 모드 | 승인 거절 / 2GB+ 취급 / 파일 링크 만료 | 토큰 만료·스코프 부족·워크스페이스 정책 | 타임아웃, 사실상 완주 불가 |

### 4.2 v1 최소 import 범위 권고

**IN (v1):**
1. **입력: Slack 공식 export zip 단일 경로.** (관리자 업로드)
2. **채널: public 채널만.** `channels.json` → oort `channel`. 토픽/목적은 채널 설명으로.
3. **유저: `users.json` → `member`**, `external_ref="slack:U…"` 보존, 이메일 매칭은 선택적 병합 단계. 미매칭은 **tombstone member**.
4. **메시지: `type=message` 중 `subtype` 없음 + `file_share` + `me_message` + `thread_broadcast`(중복제거).** `ts` 오름차순 → `seq` 1..N. `origin_ts` 보존, `(channel, origin_ts)` 유니크.
5. **스레드: `thread_ts` 기반 부모-자식 복원.** 고아 답글은 합성 부모.
6. **리액션: 표준 이모지만.** 미매칭 유저는 카운트로 흡수.
7. **텍스트 변환: 멘션/채널링크/링크/이스케이프/기본 강조.** `blocks`는 `raw` JSONB 보존.
8. **드라이런 + 리포트**: import 전 "채널 N개, 메시지 M건, 매칭 실패 유저 K명, 버릴 항목 목록"을 먼저 보여준다. ← 세 선례 모두 이게 없어서 사용자가 사후에 놀란다. **oort의 차별점으로 삼을 만함.**

**OUT (v1에서 명시적으로 포기 — UI에 그대로 고지):**
- private 채널·DM·그룹 DM (플랜/승인 장벽)
- 파일 실물 (v1.5에서 BYO-token 백필로)
- 커스텀 이모지 이미지, 캔버스, 허들, 리스트
- 앱/봇/슬래시커맨드/웹훅/워크플로
- 편집·삭제 이력, 저장(starred)/핀, 유저그룹
- `channel_join`/`channel_leave` 등 시스템 노이즈 (**버린다**)

**v2 후보 (우선순위 순):**
1. **BYO 내부앱 토큰 → 파일 실물 백필 + 커스텀 이모지** (export zip의 최대 결함을 정확히 메움)
2. private 채널·DM (compliance export 또는 유저 토큰)
3. 증분/양방향 브리지 (Slack 병행 운영 기간용) — 단, 여기서 rate limit이 다시 문제됨
4. Discovery API (대형 Grid 고객 전용)

### 4.3 후속 확인 필요 (RA-2가 확정하지 못한 것)

1. **[미확인]** 2026-03-03 유예 종료 날짜를 docs.slack.dev 원문에서 직접 재확인. (2차 출처만 일치)
2. **[미확인]** "internal customer-built app"의 형식 정의 — 제3자 서비스에 토큰을 넘기는 구성이 여기 해당하는지. Slack Developer Support 문의가 정답.
3. **[미확인]** compliance export 승인 소요 기간 공식 수치.
4. **[미확인]** 마이그레이션 도구의 Slack Marketplace 심사 통과 선례.
5. **[미확인]** slackdump의 브라우저 세션 경로가 새 rate limit을 우회하는지 (그리고 그것이 ToS상 허용되는지).
6. **[미확인/실측 필요]** Slack Free 플랜의 90일 제한이 **메시지 본문**에도 적용되는지, **파일 링크**에만 적용되는지. help 문서는 파일 링크 기준으로 서술 — 실측 권장. (Free 워크스페이스는 90일 초과 메시지가 UI에서 안 보이지만 export 포함 여부는 별개 이슈)

### 4.4 oort 관련 ADR 후보

- **ADR-a: 백필 쓰기경로** — "단일 쓰기경로(REST→PG→outbox→relay)" 불변식에 대한 import 예외 정의. outbox 요약 이벤트 1건 원칙.
- **ADR-b: `message.seq` 할당 정책** — 빈 채널 전용 import, `origin_ts` 보존, `(channel, origin_ts)` 멱등 키.
- **ADR-c: 외래 identity 매핑** — `member.external_ref` + tombstone member 규약 (Slack 외 소스에도 재사용 가능한 일반형으로).
- **ADR-d: Slack 연동 자격증명 모델** — ADR-0004(provider 자격증명 비유입)와의 관계. BYO 토큰을 받는다면 그 토큰은 어디에 살고 언제 파기되는가. **이건 v2 전에 반드시 결정.**

---

## 출처

**Slack 공식**
- [How to read Slack data exports](https://slack.com/help/articles/220556107-How-to-read-Slack-data-exports)
- [Export your workspace data](https://slack.com/help/articles/201658943-Export-your-workspace-data)
- [Rate limit changes for non-Marketplace apps (2025-05-29)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- [Clarifying rate limit changes for non-Marketplace apps (2025-06-03)](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)
- [Rate limits (Web API)](https://docs.slack.dev/apis/web-api/rate-limits/)
- [File object reference](https://docs.slack.dev/reference/objects/file-object/)
- [conversations.replies method](https://api.slack.com/methods/conversations.replies)
- [Retrieving messages](https://api.slack.com/messaging/retrieving)
- [FAQ: Import data from one Slack workspace to another](https://slack.com/help/articles/360049597673-FAQ--Import-data-from-one-Slack-workspace-to-another)

**오픈소스 선례**
- [Mattermost — Migrate from Slack](https://docs.mattermost.com/administration-guide/onboard/migrate-from-slack.html) · [mmetl](https://github.com/mattermost/mmetl) · [slack-advanced-exporter](https://github.com/mattermost/slack-advanced-exporter)
- [Rocket.Chat — Import from Slack](https://docs.rocket.chat/docs/import-from-slack)
- [Zulip — Import from Slack](https://zulip.com/help/import-from-slack) · [zerver/data_import/slack.py](https://github.com/zulip/zulip/blob/main/zerver/data_import/slack.py) · [스레드 import 개선 이슈 #9006](https://github.com/zulip/zulip/issues/9006)
- [rusq/slackdump](https://github.com/rusq/slackdump) (AGPLv3 — 채택 불가)

**2차 출처 (교차검증용)**
- [About Slack's new rate limits — APIs You Won't Hate](https://apisyouwonthate.com/newsletter/about-slacks-new-rate-limits/)
- [Slack Discovery API 2026 guide — Strac](https://www.strac.io/blog/slack-discovery-api)
- [Slack Export Guide 2026 — ViewExport](https://viewexport.com/post/export-slack-conversations)
- [Selectively Migrating Slack History Across Workspaces — alexejk.io](https://alexejk.io/article/slack-history-migration/)
- [Personal Slack Data Export — Watsonbox](https://watsonbox.github.io/posts/2025/02/09/personal-slack-data-export.html)
- [conversations.history 15-message 보고 — GitHub community #162325](https://github.com/orgs/community/discussions/162325)
