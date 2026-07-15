# 16-01 · momo 플러그인 플랫폼 제안 — 기존 엔진 큐 위의 제품화

> Planning ID: `PLN-20260716-01` (Fable) · 2026-07-16 · 상태: **proposal** (문서화만 — 구현 없음, 성재 지시)
> 발제(성재): "Codex 앱처럼 공식+커스텀 플러그인, 원클릭 설치, 서버 단위 관리, 온보딩 추천 설치. 1호는 Google Drive(승인한 사용자의 Drive를 에이전트가 작업·업로드·링크 제공). 에이전트에게 플러그인을 언급해 시키거나, 에이전트가 동적으로 사용 가능 목록 기반으로 작업." UI는 Codex(momo-main 트랙)가 작업 중 — **UI handoff 문서 도착 대기**.

## 0. 한 줄 결론

**이 발제는 새 판이 아니라 이미 예약된 엔진 큐(ADR-0113 → SE-04A plugin registry → SE-04B webhook)의 제품화다.** 리서치(16-00)가 확인해준 것: 업계 플러그인 표준은 3층(MCP + SKILL.md + plugin.json/marketplace.json)으로 수렴했고, Codex가 Claude 호환 변수까지 유지하므로 **momo가 이 3층을 채택하면 momo 플러그인이 BYOA 에이전트(Codex든 Claude든)에서 그대로 동작한다.** momo가 만들 것은 실행기가 아니라 **카탈로그·정책·감사 레이어**다.

## 1. 아키텍처 골격 (권고)

```
momo 서버 (카탈로그·정책·감사 — 코드 실행/토큰 보관 없음)
 ├─ plugin manifest registry (SE-04A: 검증·install/grant/revoke·Capability Cache·RLS/audit)
 ├─ 서버(워크스페이스) 정책: enable/disable · role 스코프 · 기본 비활성 옵션 · 추천 세트
 └─ 감사: install/grant/revoke/사용 이벤트가 기존 audit_log 원장에

BYOA 에이전트 호스트 (= MCP 클라이언트 — 토큰 보유 주체)
 ├─ momo가 승인·배포한 manifest를 호스트 config(mcp_servers)에 주입
 ├─ remote MCP: 401→PRM→(DCR)→PKCE OAuth — 사용자가 브라우저에서 벤더에 직접 동의
 └─ stdio MCP: 호스트 로컬 실행 + env 자격증명 (스펙 공인)
```

- **커스터디 결정(ADR-0113의 본체)**: 리서치 16-00 §2의 (B)+(C) 조합 — 에이전트 호스트=MCP 클라이언트, 벤더 호스티드 remote MCP 우선. momo 서버는 사용자 OAuth 토큰을 **보관하지 않는다**(ADR-0004의 자연 연장). ChatGPT식 플랫폼 보관(A)은 선례는 있으나 momo 경계 변경이라 비권고 — 채택하려면 ADR-0113에서 명시 결정.
- **momo의 차별화 지점**: ChatGPT/Claude와 달리 momo는 실행 원장이 있다 — 플러그인 도구 호출이 **기존 승인 티어(read_only/workspace_write/network_write)·비용·감사 원장**을 그대로 통과한다(SE-02C action envelope). "Slack엔 없는 것"이 여기서도 반복된다.

## 2. 플러그인 정의 (권고)

`momo 플러그인 = manifest(plugin.json 계열, SE-04A validator 통과) + MCP 서버 참조(원격 URL 우선 / stdio는 호스트 실행) + 선택 SKILL.md 묶음 + momo 확장 필드`

momo 확장 필드(안): `approvalTier` 기본 매핑(도구→승인 티어), `risk`, `recommendedFor`(온보딩 추천 태그), `serverPolicy`(기본 활성/비활성). 카탈로그의 MCP 서버 기술부는 공식 MCP Registry `server.json` 스키마 재사용 검토(16-00 §2).

## 3. 후보 플러그인 리스트 (성재 지정 5 + 확장)

| 우선순위 | 플러그인 | 형태(예상) | 상태 |
|---|---|---|---|
| 1 | **Google Drive** (1호 — 작업·업로드·링크 제공) | 공식 MCP 공백 가능성 → momo 제작 플러그인(커뮤니티 서버 포크 또는 자체, permissive) + **per-user OAuth `drive.file` 최소 스코프** | 스코프 전략·CASA 요건 **요검증**. 기존 GWS 동결 트랙과 관계는 §4 |
| 1 | GitHub | 공식 github-mcp-server + 호스티드 remote(예상) | 라이선스·엔드포인트 요검증 |
| 1 | Notion | 공식 notion-mcp-server + mcp.notion.com(예상) | 요검증 |
| 2 | Google Calendar / Gmail | Drive와 같은 계열(공식 공백 예상 — ChatGPT도 자체 제작으로 대응) | 요검증 |
| 2 | Linear | mcp.linear.app(예상) | 요검증 |
| 3 | Slack(가져오기)·Dropbox·웹 검색/브라우저 | 후순위 | 요검증 |
| — | **signed webhook** | SE-04B — momo 자체 제작 1호 reference plugin(기예약) | ADR-0115 |

## 4. Google Drive 1호 플러그인과 기존 동결 트랙의 관계 (중요)

- 기존 동결분(`research/13-redesign/03`)은 **workspace archive**(공유 드라이브+SA, 모드 B) — 서버측 보관 모델이라 ADR-0113/0116 게이트에 걸려 동결됐다.
- 성재의 1호 플러그인은 **"승인한 사용자의 Drive"** — 즉 **per-user OAuth(모드 A, drive.file)** 계열이고, 커스터디 (B)+(C)라면 토큰이 에이전트 호스트에 있어 momo 서버 경계를 건드리지 않는다. **동결 트랙과 충돌하지 않고, 오히려 동결 사유(서버측 토큰 보관)를 우회하는 첫 slice다.** 13-redesign도 "첫 권고 slice는 per-user selected-file read/citation"이라 명시 — 방향 일치.
- 단 에이전트 호스트가 사용자 토큰을 보유하는 것의 신뢰 경계(호스트=사용자 소유 머신이라는 전제, 다중 사용자 워크스페이스에서 누구의 토큰인가)는 ADR-0113에서 명시 결정 필요.

## 5. UX 계약 (Codex UI handoff와 접속할 지점)

| 성재 요구 | 메커니즘(권고) | 선례 |
|---|---|---|
| 원클릭 설치 | 카탈로그 → manifest 검증 → install record(RLS/audit) → 에이전트 호스트 config 주입 → OAuth는 `ON_INSTALL` 또는 첫 사용(정책 필드) | ChatGPT `policy.installation/authentication` |
| 서버 단위 관리 | 워크스페이스 설정: enable/disable·role 스코프·(Enterprise형) 기본 비활성 | ChatGPT Workspace settings > Plugins |
| 온보딩 추천 | 서버 개설/합류 온보딩에 추천 세트(예: Drive+GitHub+Notion) 제시 — ADR-0121 온보딩과 합류 | ChatGPT featured row, Claude 공식 마켓 |
| 에이전트에 언급해 시키기 | `@에이전트 + 플러그인 멘션` → Context Packet의 tool policy에 해당 플러그인 도구 우선 주입 | ChatGPT `@` 멘션 호출 |
| 동적 발견 | 에이전트가 사용 가능 플러그인 목록(Capability Cache projection)을 컨텍스트로 받고, 도구 폭발은 **지연 로드+도구 검색** 프리미티브로 관리 | Anthropic Tool Search(85% 절감), github dynamic toolsets |
| 공식/커스텀 구분 | 카탈로그 탭: momo 공식 / 워크스페이스 / 커뮤니티(후속) + capabilities 라벨(Read/Write/Interactive) | ChatGPT 디렉터리 탭 구조 |

## 6. 실행 경로 제안 (전부 기존 큐 위 — 새 ADR 번호 불요할 가능성 높음)

1. **ADR-0113 draft에 이 리서치를 입력으로 통합** — 커스터디 (B)+(C) 권고, per-user Drive 모드 A 우선, 에이전트 호스트 토큰 보유의 신뢰 경계. (draft owner는 engine planner — 이 문서가 그 재료)
2. **SE-04A 계약 확장 제안**: manifest에 3층 표준 채택(Codex/Claude 호환) + momo 확장 필드 + server.json 참조 + 서버 정책 필드(추천 세트 포함).
3. **후보 실검증 리서치**(16-00 오픈 퀘스천 — 02 핸드오프의 1순위 작업): 후보별 공식 서버 라이선스·remote 엔드포인트·OAuth, Google 스코프/CASA, Mattermost 마켓 현황.
4. **UI**: Codex(momo-main 트랙) handoff 문서 도착 후 UX 계약(§5)과 대조 — 카탈로그/설치/관리 화면은 UX 트랙, registry/정책/감사 API는 엔진 트랙으로 분담.
5. 구현 순서는 기존 큐 그대로: ADR-0113 Accepted → SE-04A(registry) → SE-04B(webhook reference) → 1호 Drive 플러그인(신규 SE ID) → 추천 온보딩(ADR-0121 S 배치 합류).

## 7. 경계 (하지 않는 것)

- momo 서버의 MCP 클라이언트화·사용자 OAuth 토큰 서버 보관(= (A) 모델) — ADR-0113 명시 결정 전 금지.
- momo 서버측 플러그인 코드 실행(WASM 러너 등) — SE-04A out-of-scope 유지.
- ADR-0113/0115 Accepted 전 구현 티켓화 금지(기존 게이트 그대로).
- GPL/AGPL 플러그인 백본 금지(카탈로그 라이선스 검증은 SE-04A validator 계약에 기존재).
