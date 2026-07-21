# 권한·워크스페이스 설계 진단 (2026-07-21, Fable — 성재 발제)

> 발단: 성재 — "채널 owner/admin이 초대·권한 부여·회수·내보내기까지 되는지 확인. 메신저 설계 핵심은 권한과 워크스페이스(Slack 유저 평균 ~3 워크스페이스, 파일 접근이 채널 접근에서 파생). Slack rearchitecture 발표(InfoQ)·Discord 등 업계 핸들링 조사 포함."
> 리서치: research/18-permissions-workspaces/00-industry-permission-models.md (Slack/Discord/Mattermost/Matrix — 별도 산출)
> 결론: **초대는 강함, 수명주기 관리(역할 변경·정지·추방·차단)는 ENUM만 있고 API가 없다. 멀티 워크스페이스는 데이터 모델만 준비(ADR-0117 미기안). → ADR-0128 기안.**

## 1. momo 현재 상태 (2026-07-21 main 8f9408f 대조)

### 있는 것 ✅
| 영역 | 현황 |
|---|---|
| 역할 체계 | `membership_role` ENUM: owner/admin/member/guest — 채널 membership 단위 |
| 워크스페이스 admin 판정 | 채널 membership의 owner/admin 보유 여부로 유도(`requireWorkspaceAdmin` — AgentRoutes 등에서 사용) |
| 초대 | `POST/GET .../invites` + redeem/revoke/regenerate, **초대 시 role 지정 가능**(admin/member/guest), 단축 링크(LinkShort) |
| 채널 멤버 추가/제거 | `POST/DELETE .../channels/:ch/members` — 워크스페이스 admin 권한 검사 있음 |
| 상태 모델 | `member_status` ENUM: active/invited/**suspended/deleted** — 스키마 준비됨 |
| 격리 | RLS FORCE(워크스페이스 경계 DB 강제), 파일 접근=채널 멤버십 파생(첨부 content proxy가 membership 검사 — Slack과 동일 원칙) |
| 에이전트 | 에이전트=member(1급) — 같은 역할 체계에 편입, agent 생성=owner/admin 전용 |

### 없는 것 ❌ (성재 질문에 대한 직답)
| # | 공백 | 영향 |
|---|---|---|
| P1 | **역할 변경 REST 없음** — 승격/강등(member→admin, admin→member) API 부재 | owner가 admin을 임명·해임 불가. 초대 시 role 지정이 유일한 경로 |
| P2 | **워크스페이스 정지/추방/차단 API 없음** — suspended/deleted ENUM만 존재, 상태를 바꾸는 REST 없음. 채널 remove만 가능 | "서버에서 내보내기" 불가. 나간 사람이 초대 링크로 재합류하는 것도 못 막음(**ban 부재**) |
| P3 | **워크스페이스 역할과 채널 역할 미분리** — 워크스페이스 admin이 채널 membership에서 유도됨 | 채널 admin(그 채널만 관리)과 워크스페이스 admin(전체 관리)을 구분 못함. Slack/Discord/Mattermost 전부 분리함 |
| P4 | **self-service 부재** — 채널 나가기(leave)·워크스페이스 탈퇴 REST 없음 | 사용자가 스스로 나갈 수 없음 |
| P5 | **멀티 워크스페이스 미기안** — 스키마는 전 테이블 workspace_id로 준비 완료, 로그인도 workspace 파라미터 수신. ADR-0117은 0119에서 참조만 되고 실제 미기안, 클라 UX는 단일 워크스페이스 | Slack "유저당 ~3 워크스페이스" 사용 문법 미지원. 한 사람이 두 워크스페이스에 가입하려면 계정도 별도(human이 workspace 스코프) |
| P6 | **audit 표면 부족** — agent.created 등 일부만. 권한 변경·추방·초대 소진의 관리자 감사 로그 일관성 없음 | 셀프호스트 관리자 신뢰 요구사항 |
| P7 | org(Enterprise Grid급 상위 계층) 없음 | v1 범위 밖 — 리서치 결론에 따라 "여러 워크스페이스 = 유저 단위 연결"로 충분(Grid는 대기업 문법) |

### 구조 평가
- **P1·P2·P4는 순수 API 공백** — 스키마(ENUM·membership)가 이미 받치고 있어 마이그레이션 없이 REST+검증+audit만으로 해소 가능. 오픈소스 공개 전 필수(관리 기능 없는 메신저는 운영 불가).
- **P3는 작은 마이그레이션**(workspace_membership 또는 member.workspace_role 컬럼) — Slack 문법(워크스페이스 역할 ⊥ 채널 역할) 정렬.
- **P5는 인증 경계 재설계**(human이 workspace 스코프 → 계정(email) 전역 + workspace 연결) — 가장 큰 조각, ADR-0117로 별도 기안(웹/모바일 멀티 워크스페이스 rail과 함께). Slack이 workspace 샤딩을 버린 교훈(리서치 §5)이 여기 직결: momo는 단일 PG+RLS라 **채널/유저 단위 재샤딩 부담이 없고**, 계정-워크스페이스 분리만 하면 된다.

## 2. 설계 추가 — ADR-0128 (멤버십·권한 수명주기 v1)

정본: `docs/adr/0128-membership-permission-lifecycle.md` (Proposed). 요지:
- **D1 워크스페이스 역할 분리**: `workspace_membership(workspace_id, member_id, role: owner|admin|member|guest)` 신설(기존 채널 유도 로직은 이관·폐기). owner ≥1 불변식(마지막 owner 강등 금지).
- **D2 역할 변경 REST**: 워크스페이스 역할(owner만 owner 임명, admin 이하 관리) + 채널 역할(워크스페이스 admin 또는 채널 owner/admin). **자기보다 높은 역할 조작 불가**(Discord 계층 규칙).
- **D3 수명주기 REST**: suspend(로그인·토큰 차단, 데이터 보존)·reinstate·**remove(워크스페이스 추방)**·**ban(재합류 차단 — 초대 redeem 시 banned 검사)**. deleted는 GDPR성 소거 절차로 분리(v1.5).
- **D4 self-service**: 채널 leave·워크스페이스 leave(마지막 owner는 이양 후에만).
- **D5 audit**: 위 전부 관리자 audit 원장 이벤트(who/what/target/when) — 기존 audit 문법 재사용.
- **D6 에이전트 대칭**: suspend/remove가 agent member에도 동일 적용(credential 즉시 revoke 연동).

## 3. ADR-0117 (멀티 워크스페이스 — 별도 기안 예약)
- 계정(email 전역) ↔ workspace 연결 테이블, 로그인 후 워크스페이스 선택/전환 rail(웹·iOS·macOS), 토큰의 workspace 스코프 유지(현행) + 계정 수준 refresh. Slack Connect류 채널 공유는 범위 밖(v2+).
- 선행: P1~P4(0128)가 먼저 — 수명주기 없는 멀티 워크스페이스는 관리 불능을 복제만 함.

## 4. 실행 제안
| 순서 | 작업 | 크기 |
|---|---|---|
| 1 | ADR-0128 성재 승인 → MOMO-523(엔진: D1~D3, migration 026)·MOMO-524(엔진: D4~D6)·MOMO-525(UXUI: 멤버 관리 설정 표면 — 역할 드롭다운·추방/차단·audit 뷰) | 중형×3 |
| 2 | ADR-0117 기안(리서치 §5 반영) — 웹 W-4+ 랜딩 후 착수 권고 | 대형 |
