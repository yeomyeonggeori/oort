# 그록봇 원클릭 셀프호스트 파이프라인 — 구체화 계획 (PLN-20260822-01)

> 2026-08-22 Fable 기안. 성재 발제·우로보로스 인터뷰(`interview_20260822_091448`, ambiguity 0.16 READY)로 결재 완료된 결정 반영.
> 입력 정본: `handoffs/2026-08-22-grok-selfhost-resume-handoff.md` · `research/2026-08-22-grok-cdp-control-and-operator-host.md` · `handoffs/2026-08-16-grok-e2e-manual-spike-packet.md`(#1361) · `docs/SELF_HOST.md` · `docs/SELF_HOST_FIRST_DAY.md`.
> 경계: ADR-0100(경계 변경은 Accepted ADR 선행) · ADR-0004(자격 비유입) · ADR-0162. 실행 체제: 구현·리서치 실무=grok 4.6 워커(병렬 1), 검수·기획=Fable, 정본 승인=성재.

## 0. 북극성 UX (성재 발제 원문 요지)

사용자가 그록봇(Grok Bot 데스크탑 앱 — VM 조작 에이전트)에게 oort의 llms.txt/에이전트 프롬프트 URL을 붙여넣으면 → 그록봇이 **알아서 자기 VM 안에 oort 서버를 구동**하고 → **사용자에게 접속 주소·데스크탑 앱 다운로드 링크·사용법을 회신**하고 → 사용자는 데스크탑 앱으로 접속해 사용하며 → **설치한 그록봇 자신이 그 서버에 에이전트 멤버로 합류**해 있다("서버를 깔아준 에이전트가 첫 팀원이 된다" — agent-native 데모의 완성형).

## 1. 확정 결정 (인터뷰 결재 — 성재)

| # | 결정 | 내용 |
|---|---|---|
| D1 | 타겟 | **외부 셀프서브 온보딩 퍼널**이 정본. 내부 데모는 그 리허설 |
| D2 | 프롬프트 형태 | **(c) 이중 구조** — 루트 `llms.txt`=에이전트 진입 stub, `docs/SELF_HOST_AGENT.md`=3계층 플레이북 전문. URL은 GitHub raw |
| D3 | 프롬프트 범위 | **E2E 완결형·3계층** — ①코어 설치 계약(멱등·digest 고정·헬스체크) ②환경 분기 플레이북(공인 IP 판단→터널→외부 도달성 자가검증) ③사용자 핸드오프 계약(주소+앱 링크+첫날 사용법+영속성 고지). 각 단계에 검증 게이트 명시 |
| D4 | 터널 | **후보 리서치 선행 후 결정**(R-2). 유력 후보=cloudflared quick tunnel(계정 불요·TLS 자동·VM egress가 이미 CF 대역) |
| D5 | VM 리셋 | **"durable-but-resettable" 판정 재검증 리서치가 관문**(R-1) — 원출처가 레포에 없음(8/22 문서의 '기존 리서치' 인용 실물 부재), 성재 실사용 체감과 상충. 리셋 실재 시 그록봇 VM은 호스트에서 제외하고 **피벗**(프롬프트는 호스트 불가지론적 — 사용자 VPS 등에서 동일 계약) |
| D6 | 데스크탑 Release | **이 파이프라인에 포함** — 첫 v0.x 태그+GitHub Release(dmg)가 시리즈 산출물 |
| D7 | 수용 기준 | **실측 E2E 1회** — 프롬프트 URL 붙이기→사람 개입 없이 주소+앱 링크 회신→데스크탑 실접속·메시징 성공 = GREEN |
| D8 | 앱 최소 바 | 접속+로그인+메시징 + **그록봇 에이전트 합류까지**(#1361 결합) |
| D9 | 리커버리 | **둘 다, 순서 명시** — v1 오퍼레이터 pg_dump 스크립트+복원 문서(그록 이탈·구독 해지 유저의 마이그레이션 경로), 앱 UI export 버튼은 후속 티켓 예약 |
| D10 | 크레덴셜 | **1회용 셋업 링크(claim token)** — 부트스트랩이 1회용 claim URL 발급, 사용자가 첫 접속에서 스스로 비밀번호 설정. 대화창 비번 전달은 기각(xAI 로그 유입 방지). 서버 기능 티켓 1건 |

## 2. 산출물 시리즈 (티켓 초안 — 발급은 성재 승인 후)

| ID(가칭) | 산출물 | 성격 | 게이트 의존 |
|---|---|---|---|
| **R-1** | 그록봇 VM 리셋/영속성 재검증 | 리서치(관문). 방법 2면: ⓐ공식 문서·웹(xAI/Anysphere 계보 — 앱 번들 `com.anysphere.sand` 확인 포함, ToS의 상주 서버 허용 여부 포함) ⓑ로컬 그록봇 CDP 제어 실측(uptime 추적·과거 아티팩트 잔존·앱 UI Reset 어포던스) | 없음(최우선) |
| **R-2** | 터널 후보 리서치+로컬 실측 스파이크 | cloudflared quick tunnel/named/tailscale 등 비교 + **로컬 oort 스택에 터널 물려 실측**: Centrifugo WebSocket 통과·데스크탑 앱 임의 URL 접속·TLS·지연 | 없음(최우선 병렬) |
| **T-1** | claim-token 부트스트랩 서버 기능 | 서버. **Proposed ADR 선행**(인증/부트스트랩 경계 변경 — ADR-0100) | ADR 승인 |
| **T-2** | `llms.txt` + `docs/SELF_HOST_AGENT.md` 3계층 플레이북 | 문서(=제품). 에이전트 합류 지시(agent-port MCP 왕복을 VM 내부 curl로 직접 수행 — Grok 커넥터 static 헤더 미지수 우회) 포함. GHCR 고정 digest 사용: app `@sha256:0fbddd36…`, postgres `@sha256:c6806369…`(§`docs/SELF_HOST.md` 정본 참조) | ②환경분기 계층만 R-2 입력 대기 |
| **T-3** | 데스크탑 v0.x 태그+GitHub Release | 릴리스(현행 `0.1.0-next.1`). Apple 서명 자산 확보됨(메모리 정본), CI 레인 미구축 → 수동 서명 빌드 허용 | 없음 |
| **T-4** | pg_dump 리커버리 스크립트+복원 문서 | 스크립트+문서. llms.txt '데이터 가져가기' 섹션과 결속. 후속: 앱 UI export 티켓 예약(발급만) | 없음 |
| **V-1** | GHCR digest에 agent-port 포함 실측 | 검증 소품(고정 digest 컨테이너 부팅→`/v1/mcp/agent-port` 401 확인) | 없음 |
| **E2E** | 수용 런: 그록봇 실측 E2E 1회(D7·D8 전체) | 수용 테스트 | R-1·R-2 + T-1~T-4·V-1 |

**크리티컬 패스**: R-1·R-2(병렬 최우선) → [R-1 GREEN이면 그록봇 VM 호스트 유지 / RED면 E2E 호스트 피벗] → E2E. T-1~T-4는 호스트 판정 불가지론적이라 전부 병렬 착수 가능(성재 병렬 착수 허가 완료).

## 3. 리스크·경계

- **크레덴셜 유입**: pairing/claim 값·비밀번호는 대화로그·이슈·스크린샷 비유입(ADR-0004). claim URL 자체도 1회용·TTL로 노출 파급 최소화.
- **터널 URL 노출**: quick tunnel URL은 사실상 공개 주소 — 프롬프트에 "주소를 아는 사람은 로그인 화면까지 도달"임을 고지, 초기 비밀번호 없음(D10 claim 방식이 이 리스크도 완화).
- **VM 리셋 UX**: R-1 결과와 무관하게 핸드오프 계약에 영속성 고지+T-4 백업 안내 포함.
- **xAI/Anysphere 약관**: VM에 상주 서비스 구동+터널 노출이 약관상 허용인지 R-1에서 확인 — 위반이면 D1 퍼널 자체를 재설계(관문 사유 추가).
- **#1361과의 관계**: 본 파이프라인의 에이전트 합류는 VM 내부 curl 경로라 Grok 앱 커넥터 미지수와 독립. #1361(Grok 앱 커넥터 스파이크)은 별도 축으로 유지.

## 4. 실행 체제·검수

- 리서치·구현 실무 = **grok 4.6 워커(grok-fleet, 병렬 1)** + 그록봇 CDP 제어(성재 이번 세션 허용 — SEND 포함 사용 위임). grok 토큰 제약 없음(성재).
- 티켓은 핸드오프 패킷 없이 워커에 넘기지 않는다(하드 룰). T-1은 Proposed ADR 선행.
- 검수·재판정 = Fable. **Fable→Opus 다운그레이드 시 중단 루틴 적용**: `docs/planning/FABLE_DOWNGRADE_ROUTINE.md`.
- 성재 결재 포인트: ①티켓 발급·시리즈 발사 go ②T-1 ADR Accept ③R-1 결론에 따른 호스트 유지/피벗 ④E2E 수용 판정.

## 5. 이 세션에서 즉시 실행(성재 위임 범위 내)

1. 그록봇 CDP로 스테이징된 프로브 발사(ghcr 도달성+`/2375/info` 용량 — 8/22 핸드오프 스테이징분) + R-1 실측면 개시(영속성 자백 질의).
2. R-1·R-2 리서치 워커 편성은 성재 go 후 발사(워커 발사=명시 신호 룰).

## 6. 프로브 실측 결과 (2026-08-22 18:35 KST — CDP SEND 자동화 첫 실전)

> **SEND 자동화 성립**: 성재 제어 위임 후 `cdp_send.py --send` 실전 전송 성공(분류기 미차단). 관측 릴레이 체제 종료.

| 프로브 | 결과 | 판정 |
|---|---|---|
| ghcr.io/v2/ 도달성 | **401**(무인증 표준 응답) | **GREEN** — 레지스트리 도달·익명 pull 토큰 플로우 가능 |
| /2375/info 용량 | x86_64 · **NCPU 8 · Mem ~15.6G** · overlay2 · /var/lib/docker · Engine 29.1.4 | **GREEN** — oort 스택 구동 충분 |
| machine-id | `abdcf7f1…` 유지(전일과 동일) | 동일 계열 환경(이미지 소부 가능성 있음) |
| **uptime** | **18h26m(전일) → 1h39m** | **★세션 사이 VM 재시작 실측** — R-1 핵심 신호 |
| 홈 마커 | `~/.oort_probe`에 `2026-08-22T09:35:55Z` 신규 기록(이전 기록 무 — 첫 심기) | 종단 추적 armed — 다음 세션 재확인이 판정 |
| 가동 컨테이너 | `cursorenvironments/universal:sand-box-5b2eaab` 1개 | **Anysphere/Cursor 샌드박스 인프라 확정**(번들 id 계보 일치) |
| Docker 볼륨 마커 | `oort-persist-probe` 볼륨 생성 지시 발사(라벨 created=2026-08-22) | `/var/lib/docker` 층(=oort pgdata가 사는 층) 영속성 종단 추적 armed |

**R-1 중간 판정**: 환경은 세션 간 재시작된다(실측). 재시작을 넘어 홈·Docker 볼륨이 유지되는지가 관문의 남은 반쪽 — 마커 2종(홈 파일·Docker 볼륨)이 심어졌으므로 **다음 세션에서 잔존 확인 = R-1 실측면 종결**. 문서면(xAI/Anysphere 공식 문서·약관)은 R-1 워커 몫으로 남음.

### 6.1 추가 자백 (18:38 KST — 그록봇이 앱 문서 기준으로 정리한 영속성 의미론)

- **볼륨 마커 생성 완료**: `oort-persist-probe`(label created=2026-08-22, mount `/var/lib/docker/volumes/oort-persist-probe/_data`).
- **턴 사이(같은 인스턴스)**: 파일·설치 툴·브라우저 로그인·`/workspace` 유지. 에이전트들이 이 컴퓨터를 공유(화면만 에이전트별).
- **Settings→Updates→Update = 새 인스턴스 이동**: 파일·로그인 유지, **apt/npm/pip·CLI·Docker 이미지는 소실(재설치 필요)**. 볼륨 동반 소실 여부는 미상 — 이번 마커가 정확히 그 질문.
- **Reset = 마지막 스냅샷 롤백 어포던스 실존**(앱 UI) — 동기화 안 된 최근 작업 손실 가능. ⇒ **"durable-but-resettable" 판정은 본질적으로 확증됨**(단 Reset은 사용자 촉발; 자동 주기는 미상 — 오늘 18h→1h39m 재시작이 Update였는지 팟 재스케줄이었는지 불명).
- **구조 발견**: 셸에서 `/var/lib/docker` 비가시 — Docker 데몬(:2375)은 에이전트 셸과 **별개 파일시스템 층**. 홈 영속성과 볼륨 영속성은 독립 의미론일 수 있음(볼륨이 살아남을 가능성 여지).
- 봇의 "홈은 세션 넘어 안 남았다" 발언은 추론 오류 가능(마커는 오늘 처음 심음 — 이전 부재는 무증거). **종단 판정은 다음 세션 마커 2종 재확인.**

**설계 반영**: ①R-1 문서면 잔여 = 자동 재활용 주기·볼륨 층 소유권(어느 레이어의 데몬인가)·약관 ②T-2 플레이북에 "재기동 멱등 재개" 섹션 필수(이미지 re-pull+볼륨 재부착, 볼륨 소실 시 T-4 백업 복원 경로) ③T-4(백업/export)의 중심성 상승 — Update 시 이미지 소실이 앱 공식 문서 수준으로 확인됨.

## 7. R-2 종결 (2026-08-22 저녁 — D4 결정 완료)

로컬 스택+cloudflared quick tunnel 전면 실측 GREEN(정본 `research/2026-08-22-tunnel-spike-r2.md`): HTTP 200·agent-port 401 통과·WS 프레임 왕복 성립·지연 중앙값 13ms. **데스크탑(Tauri) Origin은 기본 허용목록에 이미 있어 무설정 통과** — 웹-경유-터널만 Origin 주입 필요(T-2 플레이북 반영 or v1 데스크탑 전용). **D4 확정: v1 터널 = cloudflared quick tunnel.** ~~(2026-08-22)~~ **→ D4 재개정(2026-08-23, 성재): **Tailscale Funnel 전면 전환**(기본 터널=Tailscale Funnel·고정 URL·rate limit 구조 소멸·에이전트 headless 설치). quick tunnel 후순위. 사유=그록봇 VM egress=CF 대역 공유로 1015 구조 노출(E2E §11 실측·RA-5).** URL 휘발성은 체험 위상 고지+T-4와 결합 수용. 아울러 1차 런칭 타겟 축소·온보딩 3축은 증보 계획 `research/2026-08-22-aside-onboarding-three-axis-plan.md`(E1~E10) 참조 — 게이트 = PLN E2E + 그록봇 감지·등록(T-5) + 첫 왕복 온보딩(T-6).

## 8. R-1 종합 판정 (2026-08-22 — 문서면 종결 · 관문 통과, 단 조건부)

정본: `research/2026-08-22-grokbot-vm-persistence-ra4.md`(RA-4). **관문 결론: 파이프라인은 성립하나, "체험자 본인 계정/VM" 구조로 못박아야 하고 약관 리스크를 설계에 흡수해야 한다.**

### 8.1 제품 정체 확정
Grok Bot = **xAI+Anysphere(Cursor) 합병 첫 공동 제품**(SpaceX의 Anysphere 인수 2026-08 클로징). 계약 주체=Anysphere, 적용 약관=**Cursor ToS**(App Store: Anysphere Inc.·privacy=cursor.com). 우리 실측 `com.anysphere.sand`·`cursorenvironments/*`와 정합.

### 8.2 "durable-but-resettable" = 공식 확증 (성재 의문 해소)
성재 체감("리셋 뉘앙스 없었다")은 **데이터 층에서는 맞다** — `/workspace` 파일·브라우저 로그인은 durable 설계, durable storage는 VM과 분리되어 Kill/재생성에도 재부착. 그러나 **실행 상태·수동 설치물(우리 Docker 스택)은 공식 "replaceable"**, `Update Agent Computer` 시 증발 가능(확장 프로그램 소실 실증). 우리 실측 uptime 18h→1h39m 재시작이 이것. ⇒ **데이터는 살릴 수 있으나 스택은 언제든 재설치 전제.**

### 8.3 설계 제약 확정 (리스크→대응, 기존 결정 갱신)
| 리스크 | 대응 (T-티켓 반영) |
|---|---|
| A1 Update 시 스택 증발·A3 Reset DB 시간여행 | **T-2 멱등 재기동 필수** + Postgres 데이터를 `/workspace`에 배치 + **T-4 외부 덤프가 핵심 안전장치**(선택 아닌 필수로 승격) |
| A2 VM 네트워크 주소 변경·A6 quick tunnel URL 변동 | 터널은 outbound+hostname 기반(R-2 GREEN). URL 휘발은 데스크탑 앱 "서버 주소 변경/재접속" UX로 흡수(T-5/T-6). **고정 링크 필요 시 named tunnel+도메인** |
| A6 SSE 미지원(quick tunnel) | oort WS(`/connection/websocket`)는 R-2에서 통과 실측 — SSE 트랜스포트 미사용 확인, 무영향 |
| **B5 계정 개방·B6 프로비저닝 악용** | **★구조 확정: 체험자 본인 그록봇 계정/VM에서 oort 구동**(성재 원래 발제와 일치). "성재/팀 계정 VM을 공용 데모 호스트로" 변형은 **금지** |
| B1/B2 베타 무보증·"개인 비상업 용도만" | 본인 계정+개인 체험 구조면 크게 완화. 단 **우리가 이를 권장·조력하는 입장**의 잔여 리스크(xAI AUP "encourage others to violate")는 성재 판단 필요 |
| **B3 자동화·비인간 접근 금지(우리 CDP 제어)** | 최종 사용자 경로는 **자연어 지시**(CDP 아님)라 제품은 무관. **우리 E2E 검증의 CDP 자동 제어만 사정권** → 검증도 자연어 지시 릴레이로 전환 권고(성재 결정) |
| B4 경쟁 서비스 개발 금지 | 홍보에서 "Grok Bot 위에서 동작" 전면화 회피 |
| **B7 트라이얼 소진 시 워크스페이스 잠김**(포럼 미해결) | 데이터 durable해도 **접근 통로가 크레딧에 묶임** → T-4 백업을 온보딩 초기에 안내(첫날 고지) |

### 8.4 관문 판정
- **통과**: 데이터 영속성 공식 확증 + 터널 GREEN(R-2) + 오퍼레이터 용량 GREEN ⇒ **그록봇 VM을 "체험자 본인의 임시 셀프호스트"로 쓰는 것은 성립**.
- **조건**: (1) 본인 계정/VM 구조 못박기 (2) T-2 멱등 재기동+T-4 외부 백업을 필수 안전장치로 (3) 우리 검증의 CDP 사용은 성재 재결정.
- **실측면 잔여**: 마커 2종(홈 파일·`oort-persist-probe` 볼륨) 다음 세션 잔존 확인 — Update가 Docker 볼륨을 보존하는지의 최종 실증(문서상 "manually installed=replaceable"이라 볼륨도 위험 쪽).

### 8.5 성재 신규 결정 큐 (R-1 발)
- **Q-STRUCT**: 파이프라인을 "체험자 본인 계정/VM 전용"으로 확정(추천)? — D1 셀프서브 퍼널과 정합.
- **Q-CDP**: 약관 B3 발견 후, 우리 E2E 검증의 그록봇 CDP 자동 제어를 계속할지 vs 자연어 지시 릴레이로 전환할지. (제품 최종 경로엔 무영향, 우리 테스트 방식만의 문제)
- **Q-LEGAL**: 본인 계정 구조라도 남는 "조력 리스크"(B1/B2/B4)를 감수하고 진행할지 — GHCR 발행 때처럼 법무 검토 1회 소재.

## 9. 성재 결재 (2026-08-22 밤 — R-1 발 결정 큐 종결·티켓 발급 go)

> 성재 원문 요지: "자연어 지시 릴레이로 전환하고, 본인 계정 구조로 확정해서 티켓 발급해줘."

| 큐 | 결정 | 효과 |
|---|---|---|
| **Q-CDP** | **자연어 지시 릴레이로 전환** — 우리 E2E 검증에서 그록봇 CDP 자동 제어(9333 READ/WRITE/SEND, 스크래치패드 `cdp_*.py` 헬퍼) **사용 은퇴** | Cursor ToS B3(자동화·비인간 접근 금지) 리스크 소거. 제품 최종 경로는 원래 자연어라 무영향. **R-1 실측면 잔여(마커 2종 재확인)와 E2E 수용 런(D7)도 자연어 지시 릴레이로 수행** — 지시문은 Fable이 작성, 그록봇 앱 전달은 사람(성재)이 수행 |
| **Q-STRUCT** | **"체험자 본인 그록봇 계정/VM 전용" 구조 확정** | D1 셀프서브 퍼널과 정합. 성재/팀 계정 VM을 공용 데모 호스트로 쓰는 변형 금지 성문화. B5(계정 개방)·B6(프로비저닝 악용) 리스크 소멸. T-2 플레이북·핸드오프 계약 문면에 "본인 계정/VM에서 구동" 명시 |
| **Q-LEGAL** | **미결(성재 판단 대기)** | 본인 계정 구조라도 남는 조력 리스크(B1 베타 무보증·B2 개인 비상업·B4 경쟁서비스)의 법무 검토 1회 여부. 티켓 착수 비차단 — 단 **T-2(공개 플레이북) 정본 머지 전 판단 권장**(공개 문서가 조력의 실물이므로) |
| **티켓 발급** | **go** — T-1~T-6·V-1 발급(이 세션 집행). **워커 발사는 별도 명시 신호 대기** | 패킷: `handoffs/2026-08-22-grokbot-selfhost-wave-packet.md`. T-1은 ADR(claim-token) Accept가 착수 게이트 |


## 10. Q-CDP 예외 1회 — E2E 수용 런 (2026-08-23 성재 지시)

성재가 E2E 수용 런 진행을 Fable에 위임하며 "너가 그록봇 제어해서 진행"을 지시. Q-CDP 결재(CDP 자동 제어 은퇴 — Cursor ToS B3)와 충돌하나, **이번 E2E 수용 런 1회에 한한 예외**로 처리(성재 선택 "이번 E2E 한정 예외"). 범위: 본인(성재) 계정 VM·수용 런 1회. 은퇴 결정 자체는 유지 — 이후 그록봇 검증/데모는 자연어 릴레이가 기본. 예외 사용 도구=스크래치패드 cdp_*.py(READ/WRITE/SEND), 크레덴셜·claim 원문은 산출물 비유입(ADR-0004).


## 11. E2E 수용 런 실측 (2026-08-23 — §1 코어 GREEN·P1 발견·§2 CF rate limit)

Q-CDP 예외 1회(§10)로 그록봇 실설치 수행. 두 바퀴:

**1차(v0.1.1 digest)**: §1.4 claim 부트스트랩에서 **실결함 발견** — `bootstrap_owner_claim_if_absent.sql` `column reference "ttl_seconds" is ambiguous`(PL/pgSQL 변수↔컬럼 동명), migrate 스키마 78/78 후 Exited 1. 봇이 §5 규율대로 비밀번호 우회 거부·정확한 게이트 보고. → P1 #1673 수리(SQL 별칭 한정+cargo 회귀 가드+verify migrate-time 단정 3중 방어)→승격→재발행.

**2차(재발행 digest app `6cd5320e…`)**: 스택 보존 상태에서 §1.2 digest만 교체·§1.4 재개.
- **§1.4 GREEN**: migrate **Exit 0**(claim 부트스트랩 통과) → api/relay/agent-worker/webhook-sender 전부 Up healthy. **P1 수리 실환경 검증 완료.**
- **§1.5 GREEN**: 로컬 `/healthz` 200 status=ok · **agent-port 401 + `Bearer scope="agent:port:connect"`**(V-1 #1650 검증 표면을 실 셀프호스트 스택에서 재확인).
- **§1.6 GREEN**: claim 경로를 `/workspace/oort-claim.env`에 1회 수거(원문 대화 비노출).
- **§2 멈춤(외부 요인)**: cloudflared quick tunnel `429 / error 1015`(Cloudflare rate limit) — R-2 스파이크 등 반복 개설 이력으로 IP 한도. 봇 올바른 백오프(재시도 중단). 우리 코드·파이프라인 무결.
- §3 핸드오프: §2 대기.

### 판정
- **코어 계층(§1 설치·헬스체크·agent-port·claim) 전량 GREEN 실증** — 파이프라인·claim-token·플레이북 fail-closed가 실환경에서 정확히 작동.
- §2/§3 잔여 = **Cloudflare quick tunnel rate limit(외부·일시)**. 한도 회복 후 §2부터 재개하면 폐곡선. 또는 named tunnel 전환(D4 변경 — 성재 결재 필요, RA-4 A6 고정링크 대응책과 동일).
- **플레이북 후속 후보**: §2에 "quick tunnel 429/1015 시 백오프·named tunnel 대안" 문면 추가(T-2 후속 소형 티켓).

### 성재 결정 큐 (E2E 발)
- **Q-TUNNEL**: §2/§3 재개를 ⓐquick tunnel 한도 회복 대기 후 재시도 ⓑnamed tunnel+도메인으로 전환(D4 변경) 중 무엇으로.


### §11 갱신 (2026-08-23 — Tailscale Funnel로 §2·§3 종결)
D4 재개정(Tailscale Funnel) 후 그록봇 실환경에서 §2 재개:
- Tailscale 설치(에이전트 1줄)·인증(성재 로그인 URL 클릭 — 첫 시도 VM 미반영, 재인증 1회로 성립)·Funnel 연결(에이전트 `tailscale serve --bg 8088`+`funnel 443 on`) 전부 성립.
- **§2 GREEN(고정 URL)**: `https://cursor.tailb1aad3.ts.net` — `/healthz` 200·agent-port 401+`Bearer scope="agent:port:connect"` 외부 도달성 실측.
- **§3 GREEN(핸드오프)**: 접속 주소(고정 URL)+데스크탑 앱(Releases latest)+셋업 링크(claim URL 1회·24h)+본인 계정 고지+덤프 백업 안내. 봇이 Q-STRUCT·ADR-0004·T-4 문면 자발 준수.
- **RA-5 Tailscale 전환 실환경 검증 완료** — quick tunnel 1015 구조 노출을 자체 릴레이 고정 URL로 해소.
- **claim 토큰 대화 노출 발견**: claim URL은 토큰 포함 구조라 링크 전달 시 대화(그록/xAI 로그)에 원문 노출 불가피. 1회·24h·소비 시 무효라 파급 제한적이나, **플레이북 재작성 시 "claim 링크는 즉시 소비 권장·미사용 시 재발급" 문면 명시** 필요(§5 "원문 반복 금지"와 claim URL의 관계 정교화).
- **잔여 = D8**(성재 데스크탑 실접속→claim 비번 설정→첫 메시지→그록봇 에이전트 합류). 스택·Funnel 보존. D8 GREEN 시 E2E 완전 종결.

### §11 갱신 2 (2026-08-23 — D8 Fable 대행 실측: 코어 GREEN·실시간 레일 P1)
성재 지시("너가 직접 데스크탑 제어해서 수행")로 Fable이 로컬 맥에서 D8 직접 수행. 증거 14샷 `claudedocs/e2e-d8-desktop-20260823/`.
- **D8 코어 GREEN**: v0.1.1 dmg(공증 stapler PASS) 설치→실행→Funnel 주소 입력→claim 소비·비번 설정(웹)→**데스크탑 owner 로그인 성공**→첫 메시지 REST 전송·렌더. **T-5 그록봇 감지 CTA가 실환경 데스크탑에서 노출**("그록봇을 팀에 초대할까요?").
- **★P1 발견 — 실시간 레일 RED**: 로그인 응답 `realtimeWebSocketUrl=ws://localhost:8088/connection/websocket`(curl 실측). 근원=`scripts/self_host_env.sh:796` 기본값이 터널 모드 무인지, 서버는 ADR-0110대로 verbatim 반환 → 원격 클라가 자기 localhost로 WS 시도·실패. **R-2가 이를 못 본 이유=스택이 검증 머신과 동일 호스트라 localhost가 우연히 옳았음**(가림막 실증 — 원격 D8만이 잡을 수 있던 결함).
- **수리 유효성 실측**: Funnel 경유 `/connection/websocket` WS 업그레이드 **101 통과**(curl) — VM env `MOMO_CENTRIFUGO_WS_URL=wss://cursor.tailb1aad3.ts.net/connection/websocket` + api 재기동이면 폐곡선. 수리는 그록봇 릴레이(성재 전달) 대상.
- 소견 2: ①owner 계정 표시명이 시드 "데모 사용자/@demo"로 노출(첫 소유자 이름 설정 단계 부재 — 폴리시 티켓감) ②플레이북(SELF_HOST_AGENT.md) websocket/realtime 문면 0건 — 터널 모드 WS URL 재설정 절차 부재(T-2 후속과 병합).
- **잔여**: ①WS env 수리(그록봇 릴레이) ②그록봇 에이전트 합류(T-5 위저드 pairing — 그록봇 릴레이) ③성재 수동 D8 재연·수용 판정. 스택·Funnel·claim 소비 상태 보존.

### §11 갱신 3 (2026-08-23 — P1 즉석 완화 폐곡선: 실시간 레일 GREEN 실측)
- 성재 "알아서 해결" 지시 → 원천수리 채비(**ADR-0167 Proposed**·**T-9=#1678**·패킷 ready — Accept·발사 go 대기)와 별도로, 즉석 완화를 그록봇 릴레이로 집행(전달도 Fable — 성재 "하라해줘", UI 스테이징 전송·CDP 비사용).
- 타임라인: 릴레이 15:53 → 그록봇 env 2줄(WS URL wss 전환+Origin 추가)+api·centrifugo 재생성 → 로그인 응답 `wss://cursor.tailb1aad3.ts.net/connection/websocket` 실측 15:54 → 데스크탑 재로그인(구 세션은 구 광고 URL 보유 — 재로그인 필요 실측) → **REST 201 발신 메시지가 열려있는 데스크탑 채널에 라이브 도착 15:59 + 프레즌스 점등**. 실시간 레일 GREEN.
- **온보딩 캡처 가동**(성재 발제 — 와우 갭 검수 재료): 그록봇이 `/workspace/oort-onboarding-captures/` 01~18 생성(INDEX.md 목차·헤맴 코멘트·시크릿 마스킹). 목록 자체가 마찰 지도다: 07 migrate ttl 실패·12 quick tunnel 429·14 로그인 반복·18 WS 공개 URL. 합류 단계는 19번부터 이어붙임 약속.
- **잔여 = 에이전트 합류**(T-5 위저드 pairing→그록봇) + **성재 수동 D8 재연=수용 판정** + ADR-0167 Accept·T-9 발사.
