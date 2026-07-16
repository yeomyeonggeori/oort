# 16-03 · 후보 통합 MCP 서버 실검증 (ADR-0113 직전 확정)

> Planning ID: `PLN-20260716-01` · 검증: 2026-07-16 웹 1차 소스(공식 레포 API·문서·블로그) — 16-00의 [미확인] 전부 해소
> 핵심 갱신: **Google 공식 Workspace MCP가 존재한다**(2026-05-01 롤아웃, Developer Preview) — 16-00의 "공식 공백 가능성 높음" 추정을 뒤집음.

## 요약 표

| 통합 | 공식 서버 / 엔드포인트 | 라이선스 | 호스티드 | 인증 | momo 판정 |
|---|---|---|---|---|---|
| GitHub | github/github-mcp-server / `api.githubcopilot.com/mcp/` | **MIT**(API 확인, push 2026-07-15) | 예 | OAuth 또는 PAT, toolsets 20종 토글 | **remote 위임 가능** (PAT 경로로 자체 OAuth 앱 없이 최소 구현 가능) |
| Notion | makenotion/notion-mcp-server / `mcp.notion.com/mcp` | **MIT**(로컬 레포는 sunset 가능성 명시) | 예(remote 우선 정책) | OAuth 2.0+PKCE 필수, **DCR 지원**, access 1h/refresh 180d | **remote 위임 가능** (로컬 포장 비권장) |
| Linear | `mcp.linear.app/mcp` (소스 비공개) | 호스티드 전용 | 예 | **OAuth 2.1+DCR** 또는 Bearer 직접 | **remote 위임 가능** |
| **Google Workspace** | **공식 존재**: `drivemcp.googleapis.com/mcp/v1`, gmailmcp/calendarmcp/chatmcp/people | 구글 호스티드. 커뮤니티 대안 taylorwilsdon/google_workspace_mcp(MIT, ★2.8k, 활발) | 예, **Developer Preview** | OAuth 2.0 — **각 배포자가 자기 GCP 프로젝트+자체 OAuth 클라이언트 필수**(공용 앱 없음) | **조건부** — 아래 경로 절 |
| Slack | 공식 MCP(2026-02 GA) | 호스티드 | 예 | OAuth — **Marketplace 게시 또는 조직 internal 앱만**(unlisted 금지) | **보류** (셀프호스터별 internal 앱 경로만 현실적) |
| Dropbox | `mcp.dropbox.com/mcp` (베타) | 호스티드 | 예(베타) | OAuth, DCR은 신뢰 클라이언트 목록만 | **보류/조건부** |

## Google Drive 1호 플러그인 — 현실적 경로 3개

공식 사실: Drive MCP 도구 8종(copy/create/download/metadata/permissions/list_recent/read/search — 읽기 중심). 스코프: `drive.file`=비민감(권장), `drive`/`drive.readonly`=**restricted**(서드파티 전송 시 CASA 보안 평가+12개월 재검증). 검증 **면제** 5종 중 momo에 유효한 것: **동일 Workspace 조직 internal 앱**, **자기 데이터만 접근하는 서비스 계정**. Testing 모드는 100명 상한+동의/refresh 7일 만료라 프로덕션 부적합.

- **경로 A — 셀프호스터별 자체 GCP 프로젝트 + 구글 공식 Drive MCP**: momo는 MCP 클라이언트만. 셀프호스터 조직 **internal 앱**이면 restricted 스코프도 검증·CASA 전면 면제 — "회사 셀프호스티드 메신저"인 한 검증 부담 0. 리스크: Preview 약관/안정성, 도구 읽기 중심, 셀프호스터 GCP 콘솔 온보딩 비용.
- **경로 B — momo 자체 포장 + `drive.file` 한정**: 벤더 단일 OAuth 앱도 CASA 불요(비민감). 단 앱이 만들었거나 사용자가 열어준 파일만 — **Drive 전역 검색 불가**. 단독으로는 불충분.
- **경로 C — 서비스 계정 + 공유드라이브 멤버십**: 기존 momo 확정(파일저장=Drive 공유드라이브+SA)의 연장. SA는 검증 면제, 100명 상한 무관, 사용자 동의 화면 없음. 팀 공유드라이브 범위 한정이 특성이자 한계. 공식 Drive MCP의 SA 자격증명 수용은 **[미확인]** — 이 경로는 momo가 Drive REST를 자체 MCP 서버로 포장하는 형태가 확실.

**판정 제안: 경로 C로 출발(기존 결정 정합·검증 부담 0) + 경로 A를 "개인 Drive 접근" 확장으로 예약(Preview 졸업 시 재평가). B는 단독 불충분.**

## 남은 미확인 (ADR 각주행)

1. Drive MCP 도구별 스코프 매핑(`search_files`가 drive.file만으로 되는지) — Preview 실계정 테스트 필요.
2. 공식 Drive MCP의 SA 자격증명 수용 여부 — 경로 C↔A 통합 가능성 좌우.
3. CASA 비용(외부 평가기관 견적制 — 공식 가격표 없음), GitHub remote MCP의 Copilot 라이선스 요구 여부, Workspace MCP Preview 약관의 프로덕션 허용 범위.

## 소스 (전부 공식)

github.com/github/github-mcp-server(+API) · developers.notion.com/guides/mcp/build-mcp-client · linear.app/docs/mcp · workspaceupdates.googleblog.com 2026-05 · developers.google.com/workspace/guides/configure-mcp-servers · /workspace/drive/api/guides/configure-mcp-server · /reference/mcp · /guides/api-specific-auth · developers.google.com/identity/.../restricted-scope-verification · support.google.com/cloud/answer/13464321·13464323·15549945 · docs.slack.dev/ai/slack-mcp-server · help.dropbox.com/integrations/connect-dropbox-mcp-server
