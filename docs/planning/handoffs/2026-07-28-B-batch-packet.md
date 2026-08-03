# goal #887 + #884 — B안: T3 기본 비활성 격리 + privileged 스코프 갱신 차단

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(최신). 모델: gpt-5.6-sol medium.

**두 티켓을 한 배치로 묶는다.** 목적이 하나다 — **main에 내보낼 표면을 안전하게 만드는 것.** 다만 **서로 다른 영역이니 커밋을 분리하라.**

## 0. 착수 전 필수
1. `git status` clean. 2. **자격증명·`.env` 금지.** 3. **PR 후 STOP.** 4. docker는 오케스트레이터. 5. 심볼 grep 실재 확인. 6. UUID 비교 lower().

---

# A. [#884 · 최상] privileged 스코프가 30일 refresh로 무기한 갱신된다

## 결함 (오케스트레이터 코드 실증)
- `AuthRoutes.swift:92-100` — allowlist+secret 통과 시 스코프에 **`platform:read`**와 **`platform:credits:write`**가 붙고 **30일 refresh JWT에 실린다.**
- `AuthRoutes.swift:173-177` — refresh가 **`payload.scopes`를 그대로 복사**하고 allowlist·secret을 **재확인하지 않는다.**

→ 운영자를 allowlist에서 빼거나 secret을 회전해도 **refresh만 계속 돌리면 권한이 유지된다.**

**범위 주의 — T3보다 넓다**: `credits:write`는 #882가 도입했지만 **`platform:read`는 선존재이고 더 무겁다** — `/v1/platform/{workspaces,members,invites}` **cross-tenant 조회**와 provider-link/quota 운영자 경로를 연다. **T3를 꺼도 이 결함은 남는다.**

## 할 일
1. refresh 시 **현재 allowlist·운영자 자격을 재검증**하고, 자격이 사라졌으면 **그 스코프만 떨어뜨린 채** 재발급하라. **일반 사용은 계속돼야 하므로 로그인·refresh 자체를 막지 마라**(messages:* 는 유지).
2. allowlist/secret 변경 시 기존 privileged 세션 토큰을 **일괄 revoke**할 운영 경로. 기존 token store·revoke 선례를 재사용하고 새 문법을 발명하지 마라.
3. **더 나은 구조가 보이면 제안만 하고 이번엔 구현하지 마라**(예: privileged를 단명 별도 credential로 분리). 범위를 넓히지 않는다 — 판단과 근거는 PR에.

## 수용 기준(A)
- **행동 기반 회귀 테스트**: 로그인(운영자) → allowlist에서 제거 → **refresh** → 새 토큰에 `platform:read`·`platform:credits:write` **둘 다 부재** → `/v1/platform/workspaces` **403** + topup **403** + **messages 경로는 정상**.
- red proof: 재검증을 되돌리면 그 단정이 **이름 있는 실패**로 빨개진다(정적 grep 금지).

---

# B. [#887] T3를 기본 비활성으로 잠근다

## 왜
adversarial-review 3라운드에서 **수리가 매번 새 결함을 만들었다**(6→3→3). T3는 아직 실 E2B 왕복도 못 한 미출시 기능인데, 검증을 마친 것들(허들·에이전트 허브·내 세션·idle 재부착·서명 v2·전사)이 그것 때문에 main에 못 들어간다. **잠그고 재설계(ADR-0140, #888)로 넘긴다.**

## 할 일
1. **명시적 옵트인이 있을 때만 T3 활성.** 지금은 키가 있으면 활성이다. 비활성일 때:
   - cloud 프로비저닝·pause/resume·topup·reconciler가 **읽히는 503**으로 닫힌다. **기존 "허들 미구성" 503 선례의 문법을 따르라** — 고장이 아니라 미구성 상태로 말할 것.
   - **reconciler 루프가 아예 돌지 않는다**(빈 폴링도 금지).
   - **T1/T2는 1바이트도 영향받지 않는다.** ← 이 티켓의 핵심.
2. ADR-0136·0139 상단과 `docs/RUN.md` §8.1.2에 **"T3는 기본 비활성, 재설계 진행 중(#888)"** 명시.
3. 기존 T3 검증기는 **옵트인을 켠 상태로 계속 그린**이어야 한다 — 회귀 감시를 잃지 마라.
4. **마이그레이션 049의 fail-closed(#886)를 함께 판단하라.** 비활성이어도 마이그레이션은 돈다 — 중복 데이터가 있는 설치는 여전히 업그레이드가 막힌다. **이번에 완화가 필요한지 판단해 보고하고, 필요하면 최소 조치만** 하라(복구 도구 전체는 #886 몫).

## 수용 기준(B)
- **비활성 기본값에서**: cloud 엔드포인트 전부 503 · **T1/T2 세션 생성·idle 전이·재개가 정상** · reconciler 미기동 — 각각 단정.
- 옵트인을 켜면 **기존 T3 검증기 11관문 + red proof 4종이 그대로 성립**.
- red proof: 기본값을 활성으로 되돌리면 "비활성 503" 단정이 **이름 있는 실패**.

## 하지 말 것
- T3 코드 삭제·되돌리기 금지(**잠그는 것**이지 없애는 게 아니다). 재설계 선취 금지(ADR-0140 승인 전).
- `schema_v0.sql` 수정 금지.

---

## 공통 검증
- `swift build` · 서버 테스트 무회귀(현재 347) · NotifierWorker · WorkHostDaemon.
- **검증기 9종 전부 그린**: work_session_idle · work_session · terminal_attach · observer_attach · work_pool · agent_run_history · push_notifier · t3_provisioner(옵트인) · openapi 정합.
- red proof는 **행동 기반으로만**(이 배치에서 정적 마커 grep이 두 번 동작을 증명하지 못했다).

## PR
`feat/887-t3-default-off` → `track/engine`. 커밋 분리(A/B). 본문: 스코프 재검증 설계, 옵트인 설정 이름·기본값, 049 판단, 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
