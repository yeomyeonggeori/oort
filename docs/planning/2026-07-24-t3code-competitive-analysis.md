# pingdotgg/t3code 경쟁 분석 — "코드 에이전트 GUI" 레이어 정면 비교 (2026-07-24, Fable — 성재 발제)

> **2026-07-28 사실 갱신:** 이 문서는 WH-0 구현 전 경쟁 분석이었다. 이후 oort는 `CodexJSONRPCAdapter.swift`로 Codex app-server JSON-RPC를 채택했고, OpenCode HTTP·ACP adapter와 함께 semantic event 경로를 운용한다. 또한 ADR-0133에 따라 데스크톱 표면은 SwiftUI에서 React/Vite+Tauri로 전환됐다. 아래 비교에서 미래형으로 남아 있던 두 전제는 현행에 맞게 고쳤다.
> 발단: 성재 지시 — "opencode·goose·t3code를 함께 다뤄보라. 셋 다 좋아 보인다." goose/opencode는 **동봉 엔진 후보**로 ADR-0114 증보1에 반영(별도), t3code는 성격이 달라 별도 경쟁 분석으로 분리한다.
> 한 줄 결론: **t3code는 oort의 Interactive Work Console(ADR-0114)에서 메신저·"에이전트=멤버"·서버 SoT를 뺀, 1인 로컬 개발자용 슬라이스다.** 엔진이 아니라 GUI 껍데기이므로 동봉 대상이 아니고, oort work console의 직접 경쟁자이자 그 방향이 시장에서 검증됐다는 신호다. 가져올 것은 (1) 태스크=스레드 + reasoning/tool-call 가시화 GUI 패턴, (2) worktree 격리의 1급 UX화, (3) Full Access/Supervised 이중 런타임(=승인 경계 UX), (4) **Codex app-server JSON-RPC의 semantic event 운용 패턴** — 연결 경로 자체는 oort에도 이미 구현됐다.

---

## 1. t3code는 무엇인가

- **Theo(t3.gg / ping.gg)와 Julius가 만든 오픈소스(MIT)**, 저장소 `github.com/pingdotgg/t3code`. "코드 에이전트를 위한 미니멀 웹 GUI". 상태: **very early development(버그·breaking change 경고 명시)**.
- **정체 = 에이전트가 아니라 GUI 오케스트레이터.** 자체 실행 루프가 없다. 기존 코드 에이전트를 감싸 브라우저/데스크톱 GUI로 몰아준다.
- **스택**: React + Vite 프론트 / Node.js WebSocket 서버(실시간) / 백엔드는 **Codex app server(JSON-RPC over stdio)**. 웹 + Electron 데스크톱 둘 다. 저장소는 TS 96% + 소량 Swift(macOS 네이티브 셸/헬퍼로 추정).
- **연결 방식 = 로컬 설치 필수 BYOK**: "Codex CLI를 설치·인증해야 t3code가 동작한다." 마케팅은 Codex/Claude/Cursor/opencode 지원을 표방하나 현행 문서는 Codex 중심(`ProviderManager`로 다중 백엔드 확장 설계).
- **기능**: 프로젝트/스레드 영속 관리, 태스크별 스레드, **built-in checkpointing + worktree 지원**, 멀티레포·멀티에이전트 병렬(주장), **이중 런타임(Full Access / Supervised)**, WebSocket 실시간 세션.
- 명분: CLI/클라우드 웹에서만 일어나던 상호작용을 로컬 GUI로. BYOK라 구독료 없이 사용자 API 비용만.

## 2. oort와 겹치는 포지션 — work console 레이어 정면 충돌

t3code가 하는 일은 oort ADR-0114 work console의 부분집합이다:

| 축 | t3code | oort work console (ADR-0114) |
|---|---|---|
| 태스크=스레드 | 스레드 하나=discrete 태스크, reasoning·tool call 가시화 | 동형 — 채널 타임라인의 세션이 승인/비용/감사 원장 |
| worktree 격리 | GUI에서 태스크별 worktree 격리 | 오케스트레이션에서 이미 사용(goal worktree) — GUI 노출은 후속 |
| 승인 경계 | Full Access / Supervised 이중 런타임 | ADR-0114 D5 승인 경계 — "에이전트가 내 머신에 프로세스 생성" 게이트 |
| 에이전트 연결 | Codex app-server JSON-RPC(stdio) 로컬 | `CodexJSONRPCAdapter.swift`로 **채택 완료**. ACP·OpenCode adapter와 함께 semantic event를 원장에 투영 |
| provider 키 | BYOK, 로컬 소유 | ADR-0004 — 서버 비유입, 동일 신념 |

## 3. oort가 t3code보다 더 하는 것 (차별화 = 해자)

t3code는 **1인 개발자 로컬 도구**다. oort의 해자는 코드 GUI가 아니라 그 위/옆의 레이어다:

1. **팀 + 에이전트=1급 멤버.** t3code는 single-user 로컬(멀티유저/멀티플레이어 불명확, "real-time collaboration"은 세션 수준). oort는 워크스페이스·채널·DM·사람과 에이전트가 같은 멤버 그리드에 서는 메신저. → t3code는 "내 코딩 태스크 GUI", oort는 "팀이 에이전트와 함께 일하는 장소".
2. **서버 = SoT + 감사 원장.** t3code는 로컬 세션 영속뿐. oort는 PG=SoT·seq 순서·outbox 전달·RLS FORCE 멀티테넌시·비용/승인 원장. 팀 감사·재연결·리플레이가 결정론.
3. **React/Vite+Tauri 데스크톱과 bare RN 모바일** — 표면은 공유 기술에 수렴하되 keychain·mDNS·deep link·notification 같은 네이티브 경계는 Rust/플랫폼 코드에 남긴다(ADR-0133/0137).
4. **엔진 비종속.** t3code는 Codex 로컬 설치에 결박. oort는 "AI 연결"(provider GUI) + work host 페어링으로 **bundleable 엔진(goose/opencode) 동봉 + Codex 로컬 연결**을 동시 지원 — 받자마자 붙는 경험까지 겨냥(ADR-0114 증보1).
5. **거버넌스로 반쪽 기능 배포 방지** — Accepted ADR 없이 경계 머지 금지(buzz의 executor suspend 미영속 전례 회피와 동일 논거).

## 4. oort가 t3code에서 가져올 것 Top 4

1. **Codex app-server JSON-RPC(stdio) semantic 경로 유지·고도화.** 최초 분석 뒤 `CodexJSONRPCAdapter.swift`가 구현돼 연결 경로 자체는 채택 완료됐다. 후속 초점은 terminal scraping이 아니라 Thread/Turn/Item·approval·tool lifecycle을 기존 `agent_run`·감사 원장에 손실 없이 투영하고 adapter conformance를 유지하는 일이다.
2. **태스크=스레드 + reasoning/tool-call 가시화 GUI 패턴.** t3code의 태스크 지향 스레드(각 스레드가 full reasoning·tool call·checkpoint)를 oort work console 표면 레퍼런스로. oort는 여기에 "채널 멤버가 지켜보는 승인 원장"을 더한다.
3. **worktree 격리의 1급 UX화.** oort는 오케스트레이션에서만 worktree를 쓰는데, t3code처럼 사용자 화면에서 "태스크=격리 worktree"를 노출하면 병렬 작업 안전성이 눈에 보인다.
4. **Full Access / Supervised 이중 런타임 명명.** ADR-0114 D5 승인 경계를 사용자에게 이 두 모드로 제시하는 카피/토글 레퍼런스.

## 5. 커뮤니티/포지셔닝 신호

- Theo의 대형 오디언스(YouTube/X) → **"코드 에이전트 GUI" 공간이 빠르게 붐빈다**(t3code, Codex 웹, Claude Code, Cursor, opencode 데스크톱…). oort가 여기서 "또 하나의 코드 GUI"로 인식되면 진다.
- **oort의 방어 프레임**: oort는 코드 GUI가 아니라 **"에이전트가 1급 멤버인 팀 메신저"** 다. work console은 그 안의 한 표면일 뿐, 제품 정체가 아니다. t3code/opencode/goose는 그 표면에 **꽂아 쓰는 엔진/레퍼런스**이지 oort의 대체재가 아니다. 마케팅·데모에서 이 위계를 분명히 할 것.
- 역설적 검증: t3code가 존재하고 Theo가 만들 만큼 수요가 확인됐다는 것 = oort work console 방향이 옳다는 시장 신호.

## 6. 판정 요약

| 질문 | 답 |
|---|---|
| 동봉하나? | ❌ 엔진 아님(GUI 껍데기). goose/opencode가 동봉 후보. |
| 경쟁자인가? | ⚠️ work console 레이어에 한해 정면 경쟁. 메신저·팀·SoT 레이어에선 비경쟁. |
| 가져올 것? | ✅ Codex JSON-RPC 경로, 태스크-스레드 GUI, worktree 1급 UX, 이중 런타임 명명. |
| 위협 수준 | 중 — 단독으로 oort를 대체 못 하나, "코드 에이전트 GUI" 인식 경쟁을 가열. 포지셔닝으로 대응. |

## 7. 파생 액션 (성재 확인용)

- ~~ADR-0114 증보1 스파이크에 "Codex app-server JSON-RPC 연결 경로 조사" 추가~~ → **완료:** `CodexJSONRPCAdapter.swift` 채택. 후속은 adapter conformance·resume·approval lifecycle 회귀 게이트로 관리한다.
- work console 표면 UXUI 배치 시 t3code의 태스크-스레드/worktree/이중런타임을 레퍼런스로 인용(buzz 배치와 동급 취급).
- 포지셔닝 노트: "oort=에이전트 네이티브 메신저, work console은 표면" 위계를 랜딩/데모 카피 정본에 고정.
