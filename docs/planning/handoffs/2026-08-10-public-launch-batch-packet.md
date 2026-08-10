# 핸드오프 패킷 — 공개+런칭 배치 (성재 ㄱㄱ 신호 대기)

> 준비: 2026-08-10 Fable. 성재 승인: 배치 구성 4종 전부 + Swift 잔존 이식 방침 + dependabot 방침(2026-08-10).
> 집행 순서: **⓪ 공개 전환(오케스트레이터 직영 — 워커 발사 전에. CI가 무료·무제한이 된 상태에서 워커 PR들이 돌게)** → 워커 4기 병렬.
> 공통 규율: wave1과 동일(워크트리 base=origin/track/engine·PR base=track/engine·STOP·이탈은 PR 본문).

## ⓪ 직영 — 공개 전환+직후 검증 (오케스트레이터)

1. `gh repo edit yeomyeonggeori/oort --visibility public --accept-visibility-change-consequences`
2. 검증: 비로그인 클론/페이지 200 · Actions 요금제 전환 확인 · About/README 렌더.
3. 브랜치 보호(main): PR 필수 아님(직영 push 유지 필요) — **force-push·삭제 금지만**(`gh api repos/.../branches/main/protection` allow_force_pushes=false). track/engine 동일.
4. 지시서(`2026-08-10-public-release-directive.md`) §집행 체크 갱신.

## W-P1 — 공개 직후 위생 · 브랜치 `chore/public-hygiene`

- **CI 풀 확장**(#1243 적립 집행): `pr-ci.yml`에 스위트 잡 추가 — core·web·mobile vitest + `cargo test --workspace`(public=무료이므로 분 상한 해제, 단 path filter·cancel-in-progress 유지). 기존 경량 잡과 중복 없게 재구성.
- **GHCR 첫 발행 준비**: `publish-images.yml`이 재조준된 경로(`ghcr.io/yeomyeonggeori/oort`)로 실행 가능한지 정합 검사(dispatch는 오케스트레이터가 별도 신호로 — 이 워커는 워크플로 수리까지만). 계약 테스트 green 유지.
- 이슈/PR 템플릿 공개 손님맞이 점검(한국어+영어 병기 여부는 현행 유지 — 재작성 금지, 깨진 링크만).

## W-1222 — 웹훅·이벤트구독 송신+관리 REST Rust 이식 (#1222 — 대형)

- 정본: 이슈 #1222 본문(실측 근거 전부) + `packages/momo-core/src/features/webhooks/api.ts`(4연산)·`features/settings/eventSubscriptions.ts`(4연산) = 클라가 이미 기다리는 계약.
- 참조 구현: `relay/OutboxRelay/Sources/OutboxRelay/WebhookDeliveryClient.swift`(서명·재시도 계약 — 이식 후에도 이 파일은 **삭제하지 말 것**, 5단계 몫).
- 범위: ①관리 REST 8연산(RLS·스코프 — 기존 라우트 관례 승계) ②outbox `webhook_delivery` 소비자(전용 송신 워커 바이너리 or relay 확장 — **relay는 broadcast-only 불변이 명시돼 있으니 별도 소비자 권장**, 근거와 함께 선택) ③063 전송 감사 기록 ④compose에 서비스 추가 시 base+오버레이 정합(#1228 구조 준수).
- 경계: #1204(본문 전송 금지 — 함수 시그니처 강제 승계)·#1208(비밀 회전 레인 — 범위 밖이면 적립).
- 검증: `cargo test --workspace`+신설 검증기(설치→전송→감사행→재시도→서명 검증 폐곡선, red proof 2+)+8레인+PG 정합.

## W-1223 — agentRunHistory 읽기 3경로 (#1223 — 소형)

- 정본: 이슈 #1223 본문. 3경로(GET channels/{ch}/agent-runs — 현 405·GET agents/{id}/runs·GET agent-runs/{id})+`serverSurfaces.ts` provided:false→true 뒤집기(웹·폰 표면 켜짐 확인 — 캡처 불요, 타입·테스트로).
- 검증: cargo+PG 정합+8레인+red proof(경로 하나 제거 시 클라 테스트 빨강).

## W-SM — 소형 3종 · 브랜치 `chore/small-3`

- **#1250**: prod/rust compose의 `:?` 키 전수가 모든 env 템플릿(.env.example·internal-smoke·rust-smoke·overlays)에 존재함을 단정하는 기계 가드(+internal-smoke 누락 3키 수리 — 4번째 red 종결). red proof 필수.
- **#1252**: invite_code_redemption.email 정규화 1줄 + human_email_uniq → lower(email) 함수 인덱스 마이그레이션 1건(065 — 064 관례 승계).
- **#1254**: `.claude/agents/design-review.md`+`momo-design-taste` 스킬을 웹/RN 표면으로 재조준(삭제된 macOS 참조 제거·momo-design-taste-web 위임 구조). CLAUDE.md의 해당 줄 정합.
- 검증: 각 항목 red proof+관련 게이트. 서버 접촉분은 8레인.

## W-DEP — dependabot 13건 일괄 정리 (#1257)

- patch/minor: 하나씩 rebase→PR CI 그린 확인→머지(이 워커는 **예외적으로 dependabot PR 머지 허용** — 자기 PR은 아님). lockfile 충돌 시 재생성.
- major(typescript 7·eslint 10·checkout v7 등): 머지 금지 — 각각 파급 조사 후 판정표(권고 포함)를 최종 보고에.
- 검증: 머지마다 typecheck 스모크(로컬) — 깨지면 되돌리고 해당 건 보고로 전환.

## 보고 (전 워커)
PR 번호(W-DEP은 처리 표)+검증+적립. 중간 보고 없음.
