# 경량화 프로그램 — LS 시리즈 편성 + 1차 목표 초점 점검 + 출시 잔여 재편성 제안 (2026-09-07, Fable · momo-main)

> 정본 결정: **ADR-0183 Accepted(2026-09-07)** — 결정 포인트 5건 권고안 채택 + 초점 지시(「셀프호스팅 + 그록봇 연동 지원에 초점을 두는 작업인지 점검」). 실측: `research/2026-09-07-clean-slate-inventory.md` · 후보: `research/2026-09-07-clean-slate-candidates.md`. 편성 정본(출시): `2026-09-02-launch-program-plan.md` — §4의 재편성 제안이 성재 확인을 받으면 그 문서를 개정한다.

## 0. 1차 최종 목표 (초점의 기준)

| 목표 | 레포에서 그것을 이루는 자산 | LS 파도에서 **무접촉** |
|---|---|---|
| **셀프호스팅** — 프롬프트 하나로 설치·day-2 운영 | `infra/rust/**` · `scripts/oort`·`scripts/lib`·`scripts/self_host_*` · `server-rust` 이미지(`publish-images.yml`) · `docs/SELF_HOST*.md`(en+ko)·`SELF_HOST_FIRST_DAY`·`RELEASING`·`NEXT_CHANNEL` · `check_release_manifest`·`test_publish_images_contract`·`test_self_host_env_modes`·SH 시험 3본 | 전부 |
| **그록봇 연동** — 외부 하네스(Claude Code/Codex/Grok Bot)를 Agent Port로 멤버化 | Rust Agent Port/MCP(ADR-0162)·hosted agent doorbell(ADR-0171)·`momo-mcp`·`momo-agent` · `scripts/verify_agent_port*.sh`·`verify_hosted_*`·`verify_agent_credentials_rust` · `docs/SELF_HOST_AGENT.md`(+ko) · 웹 `hostedAgents`·`agentHub`·`welcome` · UX-R2c 퍼널 · SH-6a 자격 GUI · #1361 HAP-GROK-E2E | 전부 |

## 1. 초점 점검표 — LS 티켓별 기여

| 티켓 | 1차 목표 기여 | 판정 |
|---|---|---|
| **LS-0 게이트 재배선** | 셀프호스터·기여자가 `local_gate`를 켰을 때 Swift 툴체인·Swift e2e 컴포즈·web-legacy npm ci를 요구하지 않게 된다(현재 `web` 프로파일은 서빙되지도 않는 클라를 빌드). CI 레인 5→4. Rust 이미지의 부트스트랩 SQL이 `infra/rust/sql/`로 와서 **셀프호스트 스택이 자기 디렉터리 안에서 닫힌다**. Agent Port 검증기 무접촉 | 직접 기여 |
| **LS-1 Swift 은퇴** | `docs/TRACKS.md`·`INDEX`·이미지 빌드 문맥에서 「은퇴 중」 설명이 사라져 셀프호스터가 읽을 스택이 하나가 된다. Swift e2e 컴포즈 삭제 = Rust e2e 오버레이 1본(#1022 재정의)이 셀프호스트 컴포즈와 같은 파일에서 파생. PushRelay 삭제는 폰 푸시(G3)만 미룬다 | 직접 기여 |
| **LS-2 클라 이중 정본** | web-legacy 삭제 = `clients/web`가 유일한 웹 정본(그록봇 온보딩 퍼널 UX-R2c가 놓일 자리) | 간접(정본 단일화) |
| **LS-3 은퇴 문서** | `README`·`INDEX`가 SELF_HOST·SELF_HOST_AGENT 두 정본으로 곧장 이어진다(현재 INDEX는 RUN/DEPLOY/BACKLOG를 정본으로 안내). `AGENTS.md` Codex 문면 일반화 = 그록봇 포함 하네스 불가지론 | 직접 기여(진입 경로) |
| **LS-4 로테이션** | 셀프호스터에게 직접 기여 없음 — planner·워커 컨텍스트 비용(문서 링크 그래프 1/3 단절) 제거. 크기 M, 워커 1기 1회 | 간접(운영 비용) — 병렬 2의 두 번째 자리로만 |
| LS-5 이슈 위생 | `area:ios/macos` 29건 정리 → 열린 이슈 215 중 1차 목표와 무관한 것을 걷어내 우선순위 판독 가능 | 간접 |
| LS-6 비대 파일 티켓 | 발행만. 착수는 1차 목표 파도 뒤 | 보류 |

**결론**: LS-0·1·3이 초점에 직접 닿고, LS-2·4·5는 그 뒤를 정리한다. LS 파도는 **2파도(LS-0∥LS-4 → LS-1∥LS-2 → LS-3)** 로 닫고 곧바로 §4의 1차 목표 파도로 넘어간다.

## 2. LS 티켓 (발급 상태)

| 티켓 | Issue | 패킷 | 트랙 | 크기 | 상태 |
|---|---|---|---|---|---|
| LS-0 게이트 재배선(정책 감사 1회) | **#2142** | `handoffs/2026-09-07-ls0-gate-rewire-brief.md` | engine | L | ready(go 대기) |
| LS-4 문서 로테이션 | **#2143** | `handoffs/2026-09-07-ls4-docs-rotation-brief.md` | engine(docs) | M | ready(go 대기) |
| LS-1 Swift 은퇴(+PushRelay·workd·LinkShort·infra/prod·Swift e2e) | LS-0 랜딩 뒤 발급 | — | engine | L | 대기 |
| LS-2 web-legacy·mobile-spike | LS-0 랜딩 뒤 발급 | — | uxui | M | 대기 |
| LS-3 은퇴 문서·INDEX·Codex 잔재 | LS-1 랜딩 뒤 발급 | — | engine(docs) | M | 대기 |
| LS-5 이슈 위생 | planner | — | — | S | LS-1 뒤 |
| LS-6 비대 파일 티켓 발행 | planner | — | — | S | 파도 뒤 |

각 PR 공통 수용: 삭제 + 실행 배선 참조 grep 0 + 게이트 초록 + **계수 표(전/후)**. 워커 상습 6축(PIPELINE §3) 상설. 완료 조건: `git grep -lE 'server/Sources|workers/|relay/|services/|web-legacy|mobile-spike|infra/prod|\.swift'`가 ADR·JOURNAL·archive 밖에서 0.

## 3. 순서·병렬

```
파도 LS-α  [engine] LS-0 #2142 (정책 감사)   ∥  [engine/docs] LS-4 #2143
파도 LS-β  [engine] LS-1 Swift 은퇴          ∥  [uxui] LS-2 클라 이중 정본
파도 LS-γ  [engine/docs] LS-3 은퇴 문서·INDEX  (+ planner: LS-5·LS-6)
────── 스냅샷 92 · 출시 계획 개정 ──────
파도 G1'   §4 재편성(성재 확인 뒤)
```

## 4. 출시 잔여 재편성 제안 — 1차 목표 기준 (성재 확인 필요)

편성 정본(2026-09-02) G1 잔여: UX-R2c · UX-R2d · UX-R3a~c · DS-1(·3·4) · SH-5a · SH-6a · (P2 완료) · SH-7 blocker(#1265 웹훅 인바운드 → #1925 허들 3키 → #1792 TURN → #1927 work host).

| 항목 | 1차 목표 관계 | 제안 |
|---|---|---|
| **SH-5a** Railway 템플릿 1회 E2E(마지막 칸 = 폰 QR) | 셀프호스팅 직접 | **G1' 1순위**(엔진) |
| **SH-6a** 외부 도구 자격 발급 GUI + 로컬 OpenAI 호환 opt-in | 그록봇 연동 직접(자격 발급이 연결의 첫 단계) | **G1' 1순위**(엔진→웹) |
| **UX-R2c** 온보딩 S5 「첫 에이전트 연결」 퍼널(하네스 카드: Claude Code/Codex/**Grok Bot**/OpenAI 호환) | 그록봇 연동 직접 | **G1' 1순위**(UXUI, SH-6a 소비) |
| **#1361** HAP-GROK-E2E(pair→reply→disconnect 잔여 0 증명) | 그록봇 연동 직접 | G1' 2순위 — SH-6a·R2c 뒤 실측 |
| SH-7 #1265 웹훅 인바운드 · #1925 허들 3키+프로파일 | 셀프호스트 완결 blocker(감사 순서) | G1' 2순위 |
| SH-7 #1792 TURN | 허들(음성) — 1차 목표와 간접 | G1' 3순위 |
| SH-7 #1927 work host 패키징 | ADR-0183 D4-②로 **출시 후 Rust 사이드카**로 이동 | G1'에서 제외 |
| UX-R2d 온보딩 재진입 커맨드 | 온보딩 완성도 | G1' 3순위(S) |
| **UX-R3a~c** ⌘K 팔레트 골격·검색·중첩 | Raycast 감각(기둥 ①)이나 1차 목표(셀프호스팅·그록봇)와 무관 | **ITO 뒤로 연기** 제안 |
| **DS-1(·3·4)** 프리미티브 12종 | UXUI 구조 부채 대응 | R2c에 필요한 프리미티브(Card·Field·Banner)만 R2c 안에서, 나머지 **연기** 제안 |
| M1 폰 패리티 · PushRelay Rust 이식(#1255) | G3 | 불변(출시 뒤) |

**G1' 제안 순서**: 파도 1 = SH-5a(엔진) ∥ UX-R2c(UXUI, 카드·감지·건너뛰기 — 자격은 SH-6a 전까지 수동 발급 경로) → 파도 2 = SH-6a(엔진+웹) ∥ #1265 → 파도 3 = #1361 E2E ∥ #1925 → ITO(G1). 팔레트·DS 잔여는 ITO 피드백 뒤.

## 5. 성재에게 묻는 것 (애매한 지점)

1. **§4 재편성**: UX-R3a~c(팔레트)·DS-1 잔여를 ITO 뒤로 미루고 SH-5a·SH-6a·UX-R2c·#1361을 앞세우는 순서로 편성 정본을 개정해도 되는가.
2. **work 표면 노출**: D4-②로 Swift workd가 사라지면 웹의 `work`·`workConsole`·`workstreams`·`ade` 라우트(41파일)는 「호스트 미연결」 상태로 남는다. G1 ITO에서 셀프호스터에게 이 표면을 **숨길지(플래그)** 그대로 둘지. 권고: 사이드바에서 숨기고 라우트는 유지(LS-2 안에서 1행 플래그).
3. **G3 문서**(`QA_GATE.md`·`IOS_TESTFLIGHT_RUNBOOK.md` — 스토어 제출 런북): LS-3에서 삭제하고 G3 진입 때 RN 기준으로 새로 쓴다는 판정으로 진행해도 되는가.

## 6. 완료·후속

LS-γ 랜딩 → 스냅샷 92 → `2026-09-02-launch-program-plan.md` 개정(§4 확정판) → G1' 파도 1 발사(go).
