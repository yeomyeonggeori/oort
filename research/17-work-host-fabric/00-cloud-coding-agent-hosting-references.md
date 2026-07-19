# Work Host Fabric 리서치 — Claude Code/Codex를 클라우드로 다루는 업계 패턴 (2026-07-19, Fable)

> 성재 발제: ADR-0114 v0 한계(세션=맥 앱 수명)를 뚫는 것이 숙원 — 셀프호스팅 또는 유료 cloud로 상시 세션. SSH 베이스, 로컬 있으면 사용자에게 물어보고 로컬 베이스.
> 목적: 업계 레퍼런스 → momo Host Fabric 결정 구조 도출. 웹 실사 2026-07-19.

## 1. 레퍼런스 지형 (실사)

### 1급 제품 — 코딩 에이전트를 클라우드에서 돌리는 방식
| 제품 | 실행 기질 | 핵심 계약 | momo가 배울 것 |
|---|---|---|---|
| **OpenAI Codex Cloud** | 태스크당 격리 컨테이너(OpenAI 인프라) | GitHub 체크아웃 → **2-phase**(setup=네트워크 허용·의존성 설치 → agent=기본 오프라인) · secrets는 setup 단계에만 존재하고 agent 시작 전 제거 · **웜 컨테이너 캐시 12h**(두 번째 태스크 setup 비용 0) | 2-phase 보안 모델, 시크릿 수명 분리, 웜 캐시 경제성 |
| **Claude Code web** | 세션당 microVM(Anthropic 관리), 로컬은 Seatbelt/bubblewrap 샌드박스 | 세션 단위(태스크 단위 아님) 클라우드 실행, 로컬↔웹 세션 개념 공존 | "세션"을 1급으로 유지한 채 기질만 바꾸는 모델 — momo와 동형 |
| **Cursor** (2026 진화가 가장 시사적) | **3계층으로 수렴**: ①cloud agents(에이전트당 격리 VM, 2026-02) ②remote agents(**내 머신에서** 실행) ③**self-hosted cloud agents**(2026-03, 고객망 내부에 전부 유지) | 사용자·기업이 기질을 고른다 — 우리가 설계하려는 것과 정확히 동일한 3계층 | 계층 선택권 자체가 제품. 단, 보안사고 다수(EC2 탈취: VM 내 sudo 특권 유저·MCP 설정 오염·프롬프트 인젝션 RCE) — **반면교사** |
| **Terragon** | 클라우드 샌드박스에서 Claude Code 병렬 오케스트레이션 | 웹 대시보드·CLI(terry)·GitHub 코멘트·**모바일**에서 태스크 관리 | 채팅/모바일에서 세션을 다루는 UX — momo는 채널 스레드가 이 역할(0114 D2) |
| **Conductor (Melty)** | 로컬 맥, git worktree 격리 병렬 | 로컬-우선, 오프라인 가능 | momo T1(로컬)의 UX 기준점 |
| **Devin / Jules / Copilot agent** | 관리형 VM / VM per task / Actions 러너 | PR-중심 비동기 납품 | 결과물=PR 관례(momo는 결과물=스레드+PR 링크) |

### 인프라 계층 — 샌드박스 실행 기질 시장
- **Firecracker snapshot/restore**: 메모리+FS 상태 통째 저장 → **5~30ms 재개**. 유휴 세션을 "0 컴퓨트 스탠바이"로 내렸다가 입력 오면 즉시 복원하는 것이 비용 구조의 핵심.
- **E2B**(Firecracker, Pro $150/mo·세션 24h) · **Daytona**(90ms 콜드스타트) · **Morph**(스냅샷 분기 — 세션 브랜칭) · **Blaxel**(무제한 0-컴퓨트 스탠바이·25ms 재개). 업계 기본 유휴 타임아웃 ~15분.
- 시사점: **상시 VM을 파는 게 아니라 "스냅샷+재개"를 파는 시장** — momo Cloud의 원가 모델은 여기에 얹으면 된다(자체 Firecracker 운영 vs 이들 위 재판매는 후속 결정).

### 보안 교훈 (Cursor 사고 계열)
1. 샌드박스 기본 유저에 sudo 특권 금지(EC2 탈취 사고의 직접 원인).
2. 백그라운드 에이전트는 공격면이 크다 — **스폰·개입을 승인 원장에 거는 momo 0114 D5가 정답 방향**임을 역으로 입증.
3. MCP/프로파일 설정 오염(team-wide) — 프로파일은 사용자 소유·변경 감사(0114 D5의 화이트리스트 감사와 동일 계열).
4. 시크릿은 setup 단계에만(Codex 패턴) — agent 단계에서 env로 노출 금지.

## 2. momo Host Fabric 제안 — 3계층 + 라우팅

**핵심 재해석: "호스트"를 1급 객체로.** 0114의 세션 매니저를 호스트 유형과 무관한 계약(work.control 소비자)으로 두면, 계층은 등록된 호스트의 종류일 뿐이다.

| 계층 | 무엇 | 연결 | 자격증명 | 대상 |
|---|---|---|---|---|
| **T1 로컬** (0114 v0) | 맥 앱 내장 세션 매니저 | 앱 세션 그대로 | 로컬 keychain/~/.codex | 무료 |
| **T2 self-host workd** | 사용자 VPS/상시 맥의 데몬. **설치 = `momo host add` 원커맨드(SSH 부트스트랩) 또는 install.sh 옵션** | **outbound-only**(workd가 서버로 다이얼 — PushRelay/relay와 동일 패턴, NAT/방화벽 무개방) | 그 호스트에서 사용자가 1회 `claude login`/`codex login` — **momo 터미널 브리지로 원격 수행 가능**(스레드에서 디바이스 코드 안내) | 무료 (ADR-0121 D5-A: 셀프호스트 전기능 무료) |
| **T3 momo Cloud** | Dawn이 프로비저닝하는 세션 샌드박스(microVM/컨테이너) | Dawn 인프라 내부 | **샌드박스 안에서** 첫 세션 때 디바이스 플로우 로그인 → 샌드박스 볼륨에 영속. momo 서버 DB에는 절대 비저장 — **샌드박스=사용자에게 임대된 실행 호스트**로 취급해 ADR-0004 경계 유지 | **유료** — "운영을 판다"(0121 D5-A)의 1호 상품 |

**설계 계약(공통):**
1. **호스트 레지스트리**: `work_host`(id, workspace, owner_member, type=app|workd|cloud, pubkey, last_seen, capabilities) — PushRelay 등록 패턴 재사용(Ed25519). 호스트는 자기 앞으로 온 `work.control.*`만 구독.
2. **스폰 라우팅 = 사용자 선택(성재 요구 그대로)**: 에이전트가 work.spawn하면 승인 카드에 **호스트 선택기**가 뜬다 — "내 맥(온라인) / seongjae-vps / momo Cloud". 기본값=마지막 사용·로컬 온라인 우선. 프로파일별 기본 호스트 고정 + auto-approve와 결합하면 무마찰 자동화도 가능(전부 감사 원장).
3. **T3 경제성**: 세션 유휴 N분 → 스냅샷 → 0-컴퓨트 스탠바이 → 스레드에 입력 오면 재개(수십 ms~수 초). 과금은 "활성 컴퓨트 시간+스토리지"로 — 상시 VM 대비 한 자릿수 원가.
4. **T3 repo 물화**: Codex Cloud 패턴 — GitHub App(워크스페이스 단위 설치)·세션당 worktree·setup 스크립트(네트워크 허용) → agent 단계 기본 오프라인·웜 캐시(12h급).
5. **보안 기본값**: 샌드박스 비특권 유저·시크릿은 setup 단계 한정·스폰/개입은 승인 원장(0114 D5)·프로파일 변경 감사.

## 3. 구독 OAuth의 원격 로그인 메커니즘 (2026-07-19 성재 질의 반영)

- **Claude Code**: 헤드리스 URL+코드 플로우 — 샌드박스 터미널의 URL을 아무 브라우저에서 열어 claude.ai(Max) 인증 후 코드 붙여넣기. Anthropic 자신의 Claude Code web이 자사 VM에서 구독으로 도는 구조라 공인된 사용 형태.
- **Codex CLI**: localhost:1455 리다이렉트라 원격은 ①SSH 포트포워딩 1회 ②로그인된 머신의 `~/.codex/auth.json` 1회 복사 — momo 온보딩 위저드로 포장.
- **momo UX**: 로그인 플로우가 세션 스레드를 탄다 — 첫 spawn 시 "로그인 필요" 카드+URL → 폰 인증 → 코드를 스레드 답글(work.input)로.
- 경계: 한 구독을 다중 사용자에 풀링 금지(ToS+하드 룰) · rate limit은 계정 단위(터미널 3개가 한도 공유) · 정책 드리프트 감시(재판매 단속 — 개인 멀티머신은 무관).

## 4. 샌드박스 3계층 합성 — 자격증명만 사용자 전용, VM/스토리지는 워크스페이스 공유 (2026-07-19 성재 보정)

> 초안의 "사용자당 샌드박스+볼륨"은 과잉 격리였다. 격리 단위를 분리한다: **자격증명=사용자, 컴퓨트/스토리지=워크스페이스, 실행 인스턴스=세션.**

| 계층 | 스코프 | 내용 | 근거 |
|---|---|---|---|
| **L-base** (공유) | 워크스페이스 | 베이스 이미지+repo 체크아웃+의존성 캐시+빌드 산출물의 **웜 스냅샷(read-only, CoW 분기)** | Codex Cloud의 웜 캐시도 환경(=repo 설정) 단위지 사용자 단위가 아님. 멤버 B의 첫 spawn이 멤버 A가 데운 베이스에서 CoW로 시작 — setup 중복 비용 0 |
| **L-cred** (전용) | 사용자 | ~/.claude·~/.codex 자격증명 볼륨 — spawn 시 해당 사용자 것만 마운트 | OAuth 풀링 금지 경계는 이 계층 하나로 지켜진다 |
| **L-session** (인스턴스) | 세션 | CoW 오버레이 + microVM 1개. **동시 다중 사용자 1-VM 공유는 금지**(프로세스 env/메모리 노출 — Cursor 사고 계열) — 인스턴스는 세션 단위, 재사용은 스냅샷-신선 기동으로(스크러빙보다 안전·CoW라 저렴) | 스냅샷/재개(0-컴퓨트 스탠바이)의 단위 |

- 워크스페이스 시크릿(빌드용 env 등)은 Codex 패턴대로 **setup 단계에만** 주입, L-base에 잔류 금지.
- git 쓰기 신원: GitHub App은 워크스페이스 설치(기존안), 커밋 귀속은 momo 원장(세션 카드)이 담당 — 사용자별 토큰 강제는 후속 선택지.
- **T2에도 동일 적용**: 팀 VPS 1대에 workd 1개를 워크스페이스가 공유 — `work_host.scope = member | workspace` 필드로 소유 모델 표현(0125 반영 사항).

### 4.1 동적 풀 할당 — "인당 N개"가 아니라 워크스페이스 세션 풀 (2026-07-19 성재 보정 2)

> 사용 분포는 균질하지 않다(0개 / 평소1·가끔3 / 상시3). 정적 인당 예약 대신 **커넥션 풀 의미론**으로 할당한다.

**풀의 실체 두 가지 (혼동 금지):**
1. **과금·쿼터 풀(서버 원장)**: 워크스페이스가 "동시 활성 세션 슬롯 N + 월 활성시간 H"를 공유. spawn = slot acquire(원장 이벤트), 종료/유휴 스냅샷 = release. 페어니스는 인당 soft limit(기본 예: 5), 비용 통제는 워크스페이스 hard cap — 슬롯 소진 시 세션 스레드에 "대기 중" 카드 + 슬롯 해제 시 자동 시작, 관리자는 cap 상향(과금 이벤트·감사 기록). **선점은 유휴-스냅샷 LRU만** — 사용자가 붙어 있는 활성 PTY는 절대 선점하지 않는다.
2. **웜 인스턴스 풀(인프라)**: spawn 지연을 숨기기 위한 부팅 대기 microVM. 크기는 **spawn 빈도의 함수지 인원수의 함수가 아니며**, L-base 스냅샷 CoW 기동이 초 단위면 풀 크기 0~2로도 충분하다.

**경제 효과의 본질**: 유휴=0컴퓨트 구조에서 "인당 3개 예약"은 애초에 존재하지 않는 비용이고, 동적 풀의 진짜 마진 레버는 **자체 호스트 플릿 운영 시나리오**에서 나온다 — 여러 워크스페이스의 활성 세션을 공유 플릿에 bin-packing하면 플릿 크기가 전체 p95 동시성으로 결정된다(인원×3 아님). 5인 팀 예: 정적 15슬롯 vs 실측 동시 피크 4~6 → 예약 용량 ~2.5배 절감. 재판매(e2b류 초단위 과금) 경로에서는 이 절감이 자동으로 원가에 반영되므로, 동적 풀은 **요금제 설계(슬롯+시간 풀) 층에서 항상 유효**하고, 인프라 층에서는 자체 운영 전환 시 추가 마진이 된다.

**0125 반영 사항**: `work_pool`(workspace, max_active, included_hours, per_member_soft_limit) 서버 원장 + slot acquire/release 이벤트(감사 가능 — 원장 철학 정합) + 대기열 UX(스레드 카드).

**비용 임팩트 (5인 워크스페이스, 정적 인당 3개 가정 시)**
- 스토리지: 사용자별 완전 볼륨(15세션×15GB=225GB, ~$27/mo) → 공유 베이스 20GB+세션 CoW 델타 15×2GB=50GB(**~$6/mo**) — 4~5배 절감.
- 컴퓨트: 활성 작업 시간은 동일하나 웜 풀 공유로 spawn 대기·중복 setup 소거, 팀 단위 이용률 평탄화로 예약 용량 절감. §"비용 추정"의 인당 $12~45는 팀 공유 시 **인당 $8~30**대로 하향.
- 요금제 시사: T3는 **워크스페이스 단위 과금**(포함 활성시간 풀 공유 + 멤버 수 계단)이 원가 구조와 정합 — 인당 과금보다 팀 협업 제품 성격에도 맞다.

## 5. 결정 구조 제안

- **ADR-0114에 D8 1개만 가산**: "세션·control은 host_id를 가진다(호스트-불가지)" — v0 구현이 T2/T3를 막지 않게 하는 최소 훅. v0 파생(483~486)은 그대로.
- **ADR-0125 신설(Work Host Fabric)**: T2 workd(outbound-only·SSH 부트스트랩·원격 로그인 브리지) + T3 momo Cloud(샌드박스 수명주기·스냅샷 경제·repo 물화·과금 경계) + 라우팅/호스트 선택 UX. ADR-0121의 momo Cloud(D1-C 범위 제외분)를 이 ADR이 인수.
- 순서 권고: 0114 v0(483~486) → 0125 기안·승인 → T2 workd(자가 검증 가능·무료층) → T3(과금·프로비저너 — S 배치의 install.sh 자동화를 프로비저너로 승격).

## 출처
- Codex Cloud/샌드박스: developers.openai.com/codex/cloud, /codex/concepts/sandboxing, /codex/agent-approvals-security
- Claude Code 샌드박스/웹: code.claude.com/docs/en/changelog, agent37.com/blog/claude-code-background-agent
- Cursor 3계층·사고: buildfastwithai.com(cloud agents 2026-02·self-hosted 2026-03), reco.ai/blog/hijacking-cursors-agent, howtoharden.com/guides/cursor
- Terragon/Conductor 비교: thetoolnerd.com/p/era-of-virtual-employees-running
- 샌드박스 인프라: dev.to(Firecracker 28ms), betterstack.com/community/comparisons/best-sandbox-runners, blaxel.ai/blog/e2b-alternatives, morphllm.com/comparisons/daytona-alternative, modal.com/resources/best-sandbox-claude-agent-sdk
