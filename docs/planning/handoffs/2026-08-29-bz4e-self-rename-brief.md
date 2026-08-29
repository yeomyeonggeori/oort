# 워커 브리프 — BZ-4e(#1873) 자기 표시 이름 변경 REST (engine)

> 워커: grok build CLI grok-4.6 · base=origin/track/engine
> 정지 조건: 머지·이슈 close 금지. 라이브 스택 비접촉(테스트는 conformance 자체 DB). 스키마 파일 무접촉.

## 계약
1. `PATCH /v1/workspaces/{ws}/members/me` — body `{"displayName": string}` (camelCase, deny_unknown_fields). 본인(사람) 전용:
   - `require_human`(에이전트 자격 403 — 에이전트 표시 이름은 기존 에이전트 프로필 경로 소관).
   - 정규화·거부는 기존 `normalized_join_display_name` 재사용(같은 규칙 두 벌 금지) — 위반 400은 그 문장 그대로.
2. 쓰기: 단일 쓰기경로 — tenant tx에서 member.display_name UPDATE + 감사(AuditEntry, 예: "member.renamed") + outbox 이벤트(roster 갱신이 실시간 전파되는 기존 관례 — 기존 membership/roster 이벤트 스키마 조사 후 동형, 신설 최소화). updated_at 갱신.
3. 응답: 갱신된 멤버 요약(기존 roster/member DTO 관례 — camelCase). 핸들·역할·아바타 무접촉.
4. 라우터 등록 + openapi 정합(기존 스펙 관리 방식 준수 — openapi.yaml 관례 확인 후 갱신, 검증 게이트 있으면 그린).

## red proof (선행 커밋)
- 실 DB conformance(기존 `*_conformance_pg` 패턴): ①본인 PATCH 200 + DB 반영 + roster GET에 새 이름 ②정규화 위반 400(기존 문장) ③에이전트 자격 403 ④비멤버/타 워크스페이스 경계 ⑤감사 행 존재.
- 단위: DTO shape·정규화 재사용.

## 완료 절차
cargo test(해당 크레이트+conformance)·openapi 게이트 자가 실행 → 커밋(#1873 참조) → git push -u origin feat/1873-bz4e-self-rename → gh pr create --base track/engine (본문에 red proof) → 정지. 마지막 출력에 PR URL과 변경 요약.
