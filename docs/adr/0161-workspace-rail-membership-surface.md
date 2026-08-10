# ADR-0161 — 워크스페이스 레일: 멀티 워크스페이스 멤버십 표면·아바타 미디어·세션 전환

- Status: **Proposed** (기안 2026-08-10 Fable/W-QA5 — 검수 피드백 #4. **Accepted는 성재**)
- Date: 2026-08-10
- 관련: **ADR-0117**(멀티 워크스페이스 생성·멤버십·권한 — 본 ADR의 기반. D5-A/D1-A를 **재개봉하지 않는다**) · ADR-0128(멤버십·권한 수명주기 — self-leave 경계) · **ADR-0151**(첨부 v0 Drive 계약 — 아바타 미디어가 재사용하는 전송 프리미티브) · ADR-0121(셀프호스팅 온보딩 — 초대 관통) · 편성 `docs/planning/2026-08-10-desktop-qa-feedback-batch1.md`(웨이브 C #4) · 패킷 `docs/planning/handoffs/2026-08-10-qa-batch1-packet.md`(W-QA5) · 구현 계획 `docs/planning/handoffs/2026-08-10-workspace-rail-qa5-packet.md`
- 발단: 성재 데스크탑 검수(oort.app) #4 — 「워크스페이스 레일(디스코드형)」. 조사 판정: **멀티 워크스페이스가 세션·데이터·API 전부 미완**(ADR-0117 미실현). 레일이 현재 그리는 "데" 글자는 워크스페이스가 아니라 **로그인 사용자 이름 첫 글자**다(prop 오배선). 목록·나가기·이미지 업로드 API와 워크스페이스 아바타 필드가 전무하다.

## Context (실측)

레일은 UI 리팩터링이 아니라 **표면 세 개가 통째로 없는 상태**다. 근거를 층별로 고정한다.

1. **스키마 — 아바타 컬럼 0, 멤버십은 채널 스코프**.
   - `workspace(id, slug, name, settings jsonb, created_at, updated_at, deleted_at)` (`schema_v0.sql:28-37`) — **아바타/로고 컬럼 없음**. `settings jsonb`는 있으나 이미지 바이트를 담을 곳은 아니다.
   - `member.avatar_url text`는 있으나(`schema_v0.sql:52`) **바 컬럼일 뿐 업로드 경로가 0**이다(아래 2). 워크스페이스 아바타에 재사용할 것이 아니다.
   - `membership`은 **per-channel**이다(`channel_id NOT NULL`, `UNIQUE(channel_id, member_id)`, `schema_v0.sql:122-134`). "이 사람이 이 워크스페이스에 소속인가"는 별도 테이블이 아니라 **그 `workspace_id`의 `human`+`member` 행 존재**로 표현된다. `human`은 `UNIQUE(workspace_id, email)`(`schema_v0.sql:69`) — 같은 이메일이 워크스페이스마다 **별도 human 행**을 갖는다(= ADR-0117 D5-A).
2. **API — 읽기/생성만, 목록·나가기·미디어 전무**.
   - `GET /v1/workspaces/{ws}` **존재**(`routes::workspaces::get`) — `WorkspaceDto{ id, slug, name, updatedAtMs }` 반환. 설정 패널의 첫 읽기이며 클라 래퍼 `fetchWorkspace`(`packages/momo-core/src/features/settings/api.ts:446`)가 이미 쓴다.
   - `POST /v1/workspaces` **존재**(`routes::workspaces::create`) — **operator-gated**(`require_instance_operator`, MOMO-583/`PLATFORM_ADMIN_EMAILS`). 생성자=owner 시딩+`#general`. 클라 래퍼 `createWorkspace`(`api.ts:436`).
   - **`PATCH /v1/workspaces/{ws}`(rename) 없음**(라우트 주석이 "open"으로 명기). **워크스페이스 목록·나가기·이미지 업로드 라우트 전무.**
   - 첨부 3경로(ADR-0151: `attachments/uploads`·`/complete`·`/content`)가 **유일한 Drive 미디어 경로**이고, 그 계약은 채널·메시지 바인딩이며 에이전트·아바타 바인딩이 없다.
3. **클라 — 워크스페이스명 필드 자체가 세션에 없다**.
   - `LoginResponse`는 `{ accessToken, refreshToken, member, realtimeWebSocketUrl }`뿐(`packages/momo-core/src/lib/api.ts:48`) — **workspaceName 없음**.
   - `WorkspaceRail`은 `workspaceName` prop에 **`selfName`(사용자 표시명)** 을 받아 첫 글자를 그린다(`Sidebar.tsx:287`가 `workspaceName={selfName}`, `selfName`은 `:137`의 사용자 displayName). 이니셜이 사용자 이름인 근본 원인이 이 오배선이다.
   - `WorkspaceRail.tsx:8` 주석이 스스로 명시한다: 스위처 메뉴는 *"multi-workspace lands (ADR-0117)"* 때 온다. `[+]`는 `<Link to="/settings">`(`:52`) — 생성이 아니라 설정 페이지로 간다.
4. **세션 — 워크스페이스간 principal 링크가 없다(D5-A의 직접 귀결)**.
   - 로그인은 워크스페이스 바인딩(`{email, password, workspace}`), refresh 토큰 1개 회전(`clients/web/src/app/session.tsx`, 데스크탑은 키체인 `session.keychain.test.ts`).
   - D5-A라 **크로스-워크스페이스 principal이 없다** → "내 워크스페이스 목록"을 서버에서 키로 잡을 수단이 없다. 이메일 문자열로 테넌트를 가로질러 조인하면 (a) RLS 격리를 깨고 (b) 그것이 바로 ADR-0117이 **공개 단계로 예약한 D5-B(전역 identity)** 다.

즉 "N:M 멤버십"은 스키마상 **이미 성립**하지만(같은 이메일의 여러 테넌트 행), 그 N을 **하나의 화면으로 모으는 표면**과 **아바타 미디어 경로**가 통째로 비어 있다. 이 ADR은 그 빈 표면을 채우되, 0117이 고정한 계정 모델을 재설계하지 않는다.

## 결정 항목 (Proposed — 성재 결정 대기)

### D1. 증보 vs 신규 → **신규 ADR(본 문서)**
- ADR-0117은 **Accepted**이고 D5-A(테넌트별 독립 계정)·D1-A(운영자 생성)를 정본으로 고정했다. 본 ADR은 그 위에 **표면 세 개**(멤버십 조회/나가기·아바타 미디어·세션 전환)를 얹으며 0117의 결정을 **재개봉하지 않는다**.
- 신규로 가는 이유: ① 아바타는 **미디어/저장 경계**(ADR-0151 관할)라 0117의 "생성·멤버십·권한" 제목 밖이다. ② **Proposed 절을 Accepted 문서에 끼우면 문서 상태가 혼합**된다(거버넌스 냄새 — 0117의 증보 1·2는 이미 성재 Accepted 상태로 추가됐다). ③ 0117이 이미 파생 후보 **W-4(클라 다중 워크스페이스 전환 UX)** 를 예약했고, 본 ADR이 그것을 **실현**하면서 W-4가 함의했으나 0117이 명세하지 않은 서버 경계(self-leave·아바타)를 명문화한다.

### D2. 멤버십 N:M 모델 → **D5-A 유지, N:M은 "테넌트별 독립 계정"으로 이미 성립**
- 사용자↔워크스페이스 N:M은 스키마상 이미 가능하다(같은 이메일의 `human` 행이 워크스페이스마다, Context 1). **멤버십 스키마 재설계 없음.**
- 크로스-워크스페이스 링크(전역 principal)는 **D5-B로 여전히 예약**. 본 ADR은 그 위에 표면만 얹는다.
- 내부 테스트 지평에서 "한 사람의 N 워크스페이스"는 **서버 조인이 아니라 클라가 보유한 세션 집합**으로 표현된다(D3·D6). 이것이 0117 Consequences가 예고한 "전환 UX가 계정 추가에 가까움"의 구체 형태다.

### D3. 목록(list) → **두 지평: 내부=클라 세션 집합 / 공개=서버 API 예약**
- **내부(D5-A, 지금)**: `GET /v1/me/workspaces`는 **불가**(전역 principal 부재, Context 4). 목록 = **로컬 저장된 워크스페이스별 세션**(refresh 토큰 + 캐시된 `WorkspaceDto`) 열거. 레일은 이 로컬 집합을 렌더하고, 각 타일의 이름·아바타는 그 세션의 캐시된 `GET /v1/workspaces/{ws}` 응답으로 채운다. **서버 신규 라우트 0.**
- **공개(D5-B, 예약)**: 전역 identity가 서면 `GET /v1/me/workspaces`(principal의 membership 다건)가 서버 목록의 정본이 된다. **본 ADR은 이 라우트의 형상을 예약만 하고 발주하지 않는다** — D5-B 승격과 반드시 동반한다.
- **권고**: 내부=클라 세션 집합(서버 구현 0). 이것이 0117 W-4의 최소 실현이다.

### D4. 나가기(leave) → **self-leave 신규 API, owner 가드**
- 신규 **`DELETE /v1/workspaces/{ws}/members/me`**(자기 워크스페이스 멤버십 종료 — 그 워크스페이스의 모든 `membership.left_at` 세팅 + `member` 소프트 상태 전이). ADR-0128 수명주기 경계를 따른다.
- **owner 가드(0117 D3 매트릭스)**: 오너십 이전은 owner-only 명시 행위다. **마지막 owner는 나갈 수 없다**(이전 없이 워크스페이스를 고아로 만들지 않는다). owner가 나가려면 먼저 이전. 계약: 마지막 owner의 self-leave = **409**(전제 위반), 비멤버 = 403/404(0117 라우트의 403↔404 계약 준수).
- **D5-A 귀결**: 나가기 = 서버 멤버십 종료 **+ 로컬 세션 파기**(그 워크스페이스 세션이 레일에서 사라진다). 재진입은 재초대(자격이 테넌트별이므로).
- **혼동 금지**: 채널 나가기(`removeChannelMember`, W-QA3 #3)는 **채널 스코프**다 — 워크스페이스 나가기는 상위 개념. 두 메뉴가 같은 "나가기" 어휘를 쓰지 않게 카피를 구분한다(§UX bible P-copy).

### D5. 워크스페이스 아바타 → **신규 미디어 경로. ADR-0151 전송 프리미티브 재사용, 바인딩·읽기 범위는 별개**
- **저장**: 스키마에 워크스페이스 아바타 참조 신설(`workspace.avatar_media_id uuid` 또는 `settings.avatar` 확장 — 티켓에서 확정, 권고는 전용 컬럼). `member.avatar_url`(바 문자열)은 **재사용하지 않는다**.
- **업로드 = ADR-0151 비대칭 계약 재사용**: *"바이트는 Drive로 우회, 접근은 인가 프록시"*. workspace-scoped resumable 업로드(`POST /v1/workspaces/{ws}/avatar/uploads`) → `complete`(mime·크기 서버 검증, 0151 스펙 값 유지) → 워크스페이스 행에 바인딩. **두 번째 저장 백엔드를 만들지 않는다** — S3 호환(MinIO)은 ADR-0151이 v1로 유보했고 여기서 **재개봉하지 않는다**.
- **읽기 범위가 첨부와 다르다(핵심 차이)**: 첨부 `content`는 채널 멤버십 인가(0151 D3). 아바타는 **워크스페이스 멤버 누구나** 상시 렌더(레일) → 더 넓은 스코프. 그리고 첨부는 상시 프록시라 무겁지만, 아바타는 **immutable content-hash URL로 캐시 가능**(교체 시 hash가 바뀜). content 경로는 캐시 헤더를 실을 수 있게 설계한다.
- **가변/교체 시맨틱**: 첨부는 immutable(메시지 바인딩). 아바타는 **워크스페이스당 1개 가변**(교체 시 이전 미디어 회수 — Drive 정리 후속).
- **조인 프리뷰(결정 필요)**: 초대 수락 전(비멤버) 아바타·이름 노출 여부. 권고: **초대 링크 소지자에게 이름+아바타 프리뷰 허용**(디스코드 선례 — "이 서버에 참가하시겠습니까"에 아바타가 뜬다). 프리뷰 전용 얕은 읽기 경로를 D3의 조인 흐름과 함께 설계.
- **인가(누가 설정하나)**: 0117 D3 — 워크스페이스 설정 write는 owner(권고) 또는 owner/admin. 아바타 설정 = 설정 write. **에이전트 제외**(0151 v0 사람만 업로드와 일관).

### D6. 세션 전환(switch) → **D5-A 위 클라 세션 스왑, 공개=전역 토큰 예약**
- 각 워크스페이스 세션 = **워크스페이스 바인딩 토큰 쌍**(access memory-only + refresh). 전환 = 활성 세션 스왑 + realtime 핸들 재수립(셸이 세션당 rail 1개 소유, `session.tsx` 머리말) + API base 재스코프. **새 워크스페이스 진입 = 로그인/초대 관통**(자격이 테넌트별).
- **저장·프라이버시**: refresh 토큰 **다건**을 안전 저장(데스크탑 키체인 — `session.keychain` 선례). 로그아웃/기기 초기화는 **전 세션 일괄 파기**(현 `signOut`의 draft 일괄 삭제와 동형 규율).
- **공개(D5-B, 예약)**: 전역 토큰 1개로 **재로그인 없는 즉시 전환**. D5-B 승격과 동반.

## Slack·업계 비교

Slack의 워크스페이스 스위처도 초기엔 **계정별 독립 세션**(각 워크스페이스 재로그인)이었고, 하나의 이메일이 여러 워크스페이스를 갖는 전역 계정으로 수렴하면서 즉시 전환 레일이 됐다. 디스코드는 처음부터 전역 계정(길드 membership 다건)이라 레일이 즉시 전환이다. **우리의 D5-A는 Slack의 초기 지점과 정확히 같고, D5-B 승격이 디스코드/현대 Slack 지점이다** — 레일의 "디스코드형" 외형은 4a로 낼 수 있지만 "디스코드형 즉시 전환"은 D5-B가 필요하다는 것을 이 ADR이 정직하게 분리한다. 아바타는 양대 서비스 모두 "바이트 우회 + immutable content-hash 캐시"로 수렴했고, 우리도 0151의 비대칭을 아바타로 확장하되 **읽기 스코프만 넓힌다**(레일 상시 렌더라 채널 인가보다 넓음).

## Consequences

- (+) **4a(즉시 프론트)가 ADR 없이 가능**: 이름 표시는 기존 `fetchWorkspace` GET 재사용, `[+]`는 생성 진입점 정정, 현재/호버 구분은 순수 스타일. 스크린샷 개선 상당수가 Accepted를 기다리지 않고 해소된다(별도 구현 패킷).
- (+) 4b 서버 경계(self-leave·아바타)가 **명시 계약**으로 고정 — Accepted 후 엔진 워커 발주 가능.
- (−) **D5-A 유지 = 전환이 "재로그인/세션 추가"** 라 디스코드 즉시 전환 대비 투박하다. 진짜 즉시 전환은 D5-B(전역 identity) 승격이 필요 — 공개 단계 부담(0117 Consequences의 부담을 승계).
- (−) 아바타로 **Drive가 또 하나의 미디어 경로**가 되어 장애 도메인이 넓어진다(0151 Consequences 연장). content-hash 캐시로 읽기 부하는 완화.
- 예약(D5-B 동반): `GET /v1/me/workspaces` 서버 목록 · 전역 토큰 즉시 전환 · 조인 프리뷰 정책 확정.

## 파생 배치 후보 (Accepted 후)

| 후보 | 내용 | 트랙 | 의존 | ADR 필요 |
|---|---|---|:-:|:-:|
| **4a** | prop 정정(워크스페이스명 실제 표시, 기존 GET 재사용) + `[+]` 실제 생성/참여 진입 + 현재/호버 pill 구분 | UXUI | 없음 | **불요**(지금 발사 가능) |
| 4b-1 | `DELETE /v1/workspaces/{ws}/members/me`(self-leave, 마지막 owner 409 가드) | 엔진 | D4 | 본 ADR |
| 4b-2 | 워크스페이스 아바타: 스키마 컬럼 + resumable 업로드/complete + content(캐시) + owner/admin 인가 + 교체 회수 | 엔진 | D5 | 본 ADR |
| 4b-3 | 클라 세션 집합 저장(refresh 다건 키체인) + 레일 목록/전환 UX | UXUI | D6 | 본 ADR |
| 4b-4(예약) | `GET /v1/me/workspaces` 서버 목록 + 전역 토큰 즉시 전환 | — | D5-B(공개) | **별도 ADR**(D5-B 승격) |

> 번호 조율: 병렬 배치 W-QA4(사용자 presence)가 **ADR-0160**을 claim(예약), 본 워크스페이스 레일이 **0161**. 두 워커가 origin/track/engine에서 병렬 진행하므로 충돌 회피를 위해 미리 분리했다.
