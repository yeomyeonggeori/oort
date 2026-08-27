# #1770 ④-2 브리프 — 역할 표시명 커스텀 UI + 클라 오버라이드 (uxui)

> AC-4(#1770)의 uxui 절반. engine 절반(#1810, `role_labels` 수용+`WorkspaceDto.roleLabels` 프로젝션)이 랜딩된 뒤 발사. ENGINE_HANDOFF A-37.
> 새 브랜치 `feat/1770-role-labels-uxui`, base=`origin/track/uxui`. 워크트리 `~/projects/momo-tracks/momo-worktrees/w1770-uxui`.

## 0. 서버 계약 (engine 랜딩 실측 — 코드가 track/uxui에 없어도 이 계약으로 작업)

- 읽기(전 멤버): `GET /v1/workspaces/{ws}` 응답에 `roleLabels` — object, 키 ⊂ `{owner,admin,member,guest}`, 없으면 `{}`. settings bag은 미포함.
- 쓰기(operator=owner/admin 전용): `PATCH /v1/workspaces/{ws}/settings` body `{"role_labels": {...}}` — **object 통째 교체**(생략한 role 키 = 그 오버라이드 제거), `{"role_labels": null}` = 전체 삭제(기본 복원). 서버 검증: 비어 있지 않은 문자열·48 UTF-8 바이트 상한·공백만 400·미지 role 키 400. member/guest는 403.
- 에이전트 라벨은 서버 비저장 — 클라 null 규칙(`roleLabel()` agent 행) 그대로.

## 1. 범위 (이슈 #1770 본문 승계)

1. **읽기 경로**: 워크스페이스 identity 응답의 `roleLabels`를 스토어에 실어 `roleLabel()`(`packages/momo-core/src/features/directory/model.ts`)과 `INVITE_ROLES`(`settings/model.ts`)가 **오버라이드 우선, 없으면 기존 한국어 기본 라벨**로 읽게 한다. 오버라이드 부재 워크스페이스 = 현행 동작과 픽셀 단위 동일(회귀 0).
2. **설정 UI**: 워크스페이스 설정 표면에 4역할 표시명 편집. 규칙:
   - 빈 값 저장 = 해당 role 키 생략 = 기본 복원(placeholder로 기본 라벨 노출).
   - 클라 선검증은 서버 계약 반영(48바이트·공백만 금지) — 서버 400 문구 의존 금지, 클라가 먼저 막고 서버는 최후 방어.
   - 저장은 object 통째 교체 계약대로 4키 전량 재구성해 보낸다(부분 전송이 다른 role 오버라이드를 지우는 함정 — 계약을 UI가 흡수).
   - non-operator에게는 편집 비활성(읽기 전용 표시). 403 의존 금지.
3. **semantics 불변 고지**: 이름만 바뀌고 권한은 그대로임을 설정 화면이 말한다(예: owner를 "마스터"로 불러도 권한 체계는 동일). 문구는 momo-design-taste-web 금칙 준수.
4. 로스터·초대·멤버 카드 등 `roleLabel()` 소비처 전부에 오버라이드가 일관 반영되는지 실측(소비처 목록을 grep으로 확정해 PR에 기재).

## 2. 필수 상태·게이트

- 디자인 정본: `momo-design-taste-web` 프리플라이트 + 4상태(기본/호버/포커스/비활성) + 키보드 접근.
- vitest: `roleLabel()` 오버라이드 우선순위·빈 값 복원·agent null 규칙 회귀 + 저장 payload 통째 교체 검증.
- capture 레인 갱신(설정 표면). 전 게이트 자가 실행, 그린 로그 커밋/PR 코멘트 동반.
- 독립 design-review는 오케스트레이터가 별도 컨텍스트로 돌린다(자가 design-review 금지).

## 3. 정지 조건 (정지 시 push 없이 보고만)

- identity 응답에 `roleLabels`가 실제로 없거나(스키마 불일치) 계약과 다를 때.
- 오버라이드 반영이 wire role 값 분기(권한 로직)에 닿을 때 — 표시 전용 원칙 위반이 구조적으로 불가피해 보이면 정지.

## 4. 금지·완료

- 서버 코드 접촉 금지 · 권한 의미론 접촉 금지 · merge/close 금지 · force push 금지 · 커밋 한국어.
- 완료 = push + PR 생성(base=track/uxui, 제목에 `#1770`) 후 정지. 독립 design-review·머지는 오케스트레이터 몫.
