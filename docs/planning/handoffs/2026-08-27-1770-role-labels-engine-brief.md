# #1770 ④-1 브리프 — role_labels 서버 수용 + 멤버 가독 프로젝션 (engine)

> AC-4(#1770) 재발주의 engine 절반. 선행 #1800(PR #1805, track/engine 809a2a47)이 남긴 예약을 채운다: "`role_labels` 의미론은 AC-4가 정한다". uxui 절반(설정 UI·클라 라벨 오버라이드)은 별도 브리프 — 이 티켓에서 만들지 마라.
> 새 브랜치 `feat/1770-role-labels-engine`, base=`origin/track/engine`(**809a2a47**). 워크트리 `~/projects/momo-tracks/momo-worktrees/w1770-role-labels`.

## 0. 전제 (실측 확정)

- #1800이 열어둔 표면: `GET|PATCH /v1/workspaces/{ws}/settings`(operator 전용), `momo-settings::workspace_settings`의 `ALLOWED_SETTINGS_KEYS`·`validate_settings_value`·top-level RFC 7396 병합·`FOR UPDATE` 직렬화. `role_labels`는 현재 UnknownKey 거부 + OpenAPI 예약 주석.
- wire role 값과 표시명은 분리돼 있다(#1770 본문 실측). 서버는 라벨 무지, 클라 상수 2곳(`ROLE_LABEL`/`INVITE_ROLES`)이 기본 라벨. **DB 스키마 무변경** — 값은 settings jsonb 안에만 산다.
- 멤버 가독 요구: 라벨은 로스터·초대 UI에서 **모든 멤버가 봐야** 한다. #1800 정본 규약 = bag 통노출 금지, 멤버 필요 키는 **키별 파생 프로젝션**(allowed_agent_models 선례).

## 1. 설계 계약

1. **키 수용**: `ALLOWED_SETTINGS_KEYS`에 `role_labels` 추가. 형태 검증:
   - JSON object, 키 ⊂ `{owner, admin, member, guest}` — 그 외 role 키 400(에이전트 라벨은 클라 null 규칙 소관, 서버 수용 금지).
   - 값 = 비어 있지 않은 문자열, **48바이트 상한**(UTF-8 — 한국어 라벨 충분). 공백만인 문자열 400.
   - 개별 라벨 제거 = 해당 role 키를 뺀 object로 교체(병합이 top-level이므로 object 통째 교체가 규약 — 문서·테스트에 명시). `role_labels: null` = 전체 삭제(기본 라벨 복원).
2. **멤버 가독 프로젝션**: `GET /v1/workspaces/{ws}` 응답(WorkspaceDto)에 `roleLabels` 필드 추가 — settings에서 파생한 **role_labels 키 하나만**, 없으면 빈 object. bag 통노출 금지 규약 유지(#1805의 identity 회귀 자는 "settings 키 미포함"을 재는 것 — roleLabels는 파생 필드라 위반 아님. 자가 문자열 충돌하면 단정 문구를 정밀화하되 취지 보존).
3. **불변**: 권한 의미론 비접촉 — 라벨은 표시 전용. `is_admin`/`can_*` 사다리·RLS·role wire 값 무변경. `schema_v0.sql` 비접촉.
4. OpenAPI 두 군데 갱신(settings PATCH의 role_labels 스키마 + WorkspaceDto.roleLabels) → `schema.d.ts` 재생성 → STATUS.md 항목.

## 2. red proof (PG 컨포먼스 — `workspace_settings_conformance_pg` 확장)

- 수리 전 RED: `role_labels` PATCH가 400(UnknownKey)임을 재는 기존 단정을 갱신하며 시작(예약→수용 전환의 명시적 커밋 서사).
- operator가 `role_labels` PATCH 200 → **member의 identity GET에 roleLabels 반영**(프로젝션 왕복).
- 형태 위반 400: 미지 role 키(`hermes` 등)·빈 문자열·공백만·49바이트+·비문자열 값·비객체.
- `role_labels: null` → 키 삭제, identity GET roleLabels `{}` 복원.
- 다른 키(allowed_agent_models) 공존 보존(top-level 병합 회귀).
- member/guest의 settings 표면 403 불변 · 교차 테넌트 거부 불변.

## 3. 게이트 (전부 자가 실행, 그린 로그를 PR 코멘트에 동반)

cargo fmt --check · clippy -D warnings · cargo test --workspace · `cargo test -p momo-server --test workspace_settings_conformance_pg`(PG 게이트) · `scripts/verify_openapi_contract_rust.sh` · `scripts/verify_web_generated_types.sh` · gitleaks 프리체크.

## 4. 정지 조건 (정지 시 push 없이 보고만)

- WorkspaceDto 확장이 기존 클라 계약을 깨는 실측이 나올 때(deny_unknown_fields 역방향 등).
- `schema_v0.sql` 접촉이 필요해 보일 때(무조건 정지).
- 게이트 RED 원인이 범위 밖일 때.

## 5. 금지·완료

- uxui 코드(clients/·packages/momo-core) 접촉 금지 — schema.d.ts 재생성 산출물만 예외.
- merge/close 금지 · force push 금지 · 시크릿 커밋 금지 · 커밋 한국어(무엇이 왜).
- 완료 = push + PR 생성(제목에 `#1770`, base=track/engine, 본문에 red proof·게이트 요약) 후 정지.
