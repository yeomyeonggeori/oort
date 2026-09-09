# 남은 작업 지도 (2026-09-08, Fable · momo-main — 성재 지시 「남은 작업도 파악」)

> 기준: main `26d03867`(스냅샷 93) · 열린 이슈 201(6월 18 · 7월 33 · 8월 113 · 9월 37). 출시 정의는 `2026-09-02-launch-program-plan.md` 상단 개정 상자(2026-09-08). 1차 목표 두 케이스 `2026-09-07-first-goal-two-cases.md`. 이 문서는 **무엇이 남았는지의 단일 지도**이며 티켓·패킷의 정본은 아니다.

## 0. 끝난 것 (2026-09-07, 하루)
경량화 LS-0~6(ADR-0183) · SH-10 push relay Rust · 1차 목표 두 케이스 정의 · 결재 8건. 추적 파일 3,416→2,491.

## 1. 1차 목표(G1' 내부 테스트 진입)까지 — 파도 순서

| 파도 | 티켓 | 트랙 | 크기 | 상태 | 케이스 |
|---|---|---|---|---|---|
| **G1'-1** | **SH-6a-w #2204** 설정 › 에이전트 자격(목록·발급·재발급·해제) + AI 연결 로컬 provider 안내 | uxui | M | PR #2214 — design-review R1 FAIL(H4·M5·N5) → R2 수리 → R2 검수 중 | B |
| **G1'-1** | **SH-5a #2205** Railway 템플릿 + 1회 E2E | engine | M | **템플릿 main 정본화**(#2210·#2211) — 실배포 E2E는 Railway 로그인 대기 | B |
| G1'-2 | **UX-R2c #2216** 로그인 뒤 「첫 에이전트 연결」 퍼널(카드 4종) | uxui | L | **완료** main(#2254→#2255, design-review R7 PASS; 잔여 #2256→#2262→#2284, 09-09) | A·B |
| G1'-2 | **#1265** 웹훅 인바운드 2경로 Rust 이식(SH-7 첫 blocker) | engine | M | **완료** main(#2226→#2227, 09-08) | B(별도 에이전트) |
| G1'-2 | **SH-6a-e #2215** 로컬 provider opt-in — 생성기 플래그 → 컴포즈 전달 → `host.docker.internal` 허용 목록 → staging에서도 유효(ADR-0004 증보, 보안 결정) → doctor | engine | S~M | **완료** main(#2225→#2237, ADR-0004 증보 Accepted, 09-08) | B(hermes 로컬) |
| G1'-3 | SH-8 그록봇: 루틴 지시문 정본화 + `SELF_HOST_AGENT.md` §3.3 「설치 뒤 그록봇 자신의 합류(dial-in pairing)」 절 + CDP 하네스 복구(로컬 한정, 2026-09-07 결재) | engine/docs | M | **완료** main(#2230, PR #2236→#2240, 09-08) | A |
| G1'-3 | SH-9 hermes 합류 런북 현행화 — `docs/external-agent-provider/*` Swift 전제 → Rust 현행(AI 연결 provider link + 플러그인 경로 1회 실측) | engine/docs | M | **완료** main(#2231, PR #2243→#2244, 09-08) | B |
| G1'-4 | **E2E-A**: README 붙여넣기 → 그록봇 VM 설치(§3.3) → doctor PASS → 팀 로그인 → 그록봇 pair→멘션→답장(#1361, CDP) → VM Reset 복구 → 잔여 0 | planner+CDP | — | **착수**(09-09: 앱 CDP 재기동·지시문 스테이징; 전송 권한 대기 — Enter 1탭/osascript 규칙; #1361 ready) | A |
| G1'-4 | **E2E-B**: Claude Code 붙여넣기 → Railway 설치 → doctor PASS → 팀 로그인 2인 → hermes 등록·킥오프 답장 → Claude Code 합류·멘션·답장 → upgrade·백업 · 폰 QR(+푸시 stub) | planner+성재 | — | **로컬 경로 PASS**(09-09, 보고 research/2026-09-09-e2e-b-selfhost-run.md; 결함 D2 #2258·D10 #2260·D8/D11 #2264·문서 #2263 전량 정본화; Railway 경로는 최종 단계) | B |
| → ITO | 성재+1인 내부 테스트(웹+데스크톱+폰 QR), 인테이크 규칙 `docs/INDEX.md` §6 | — | — | E2E 2본 뒤 | |

## 2. G2(출시)까지 — G1' 뒤

| 축 | 항목 | 상태 |
|---|---|---|
| 외부 셀프호스터 3 | 하네스 복붙 1 · 그록봇 1 · Railway 1 — 각자 E2E-A/B를 외부인이 재현 + 인테이크 | 모집·운영(성재) |
| **iOS 앱스토어 v0** | RN 앱: #20 계정 삭제 흐름(5.1.1(v)) · #21 PrivacyInfo.xcprivacy+암호화 신고 · #22 UGC 모더레이션 4종+EULA · #30 스토어 메타/스크린샷 · #31 빌드 업로드→심사 · **RN TestFlight 런북 신설**(Swift 런북은 LS-3에서 삭제) · **Dawn relay live 기동 + 실기기 APNs 실수신**(2026-09-08 보류 2번, `checklist-apns-real-device.md`) · 폰 잔여 #2030·#2011·#1964·#1396·#2090 중 v0 필수분 | 미착수(G1' 뒤) |
| 셀프호스트 완결(SH-7) | #1265(G1'-2) · #2193 momo_notifier 롤 · #2066 OUTBOUND_WEBHOOK_MASTER_KEY 분리 · #2029 기기 목록/해제 · #2010 SAS 동봉 | 이슈 있음 |
| 에이전트 표면 | #2016 도구 카탈로그 GET · #1957 UX-R4a enabledTools(blocked) · #1405·#1400 hosted DTO/불변성 · #1345 ACP 감사(재랜딩 범위) | 이슈 있음 |
| LAUNCH_READY | 릴리스 매니페스트·이미지 서명·NEXT_CHANNEL·SECURITY 검토(ADR-0100 증거) | 편성 시 |

## 3. 선재·위생(파도 사이에 끼움)
#2157 pgbackrest 시험 · #2181 gate:csp-deploy 템플릿 · #2193 notifier 롤 · #2124 local_gate 허용목록(일부 LS-0에서 흡수 — 잔여 확인) · #1984 release manifest 시험 편입(LS-0에서 완료 → close 후보) · 게이트 후속 #2129·#2128·#2130·#2047·#2074 · 웹 잔여 #2095·#2091·#2080·#2076·#2075·#2057·#2049·#2048·#2046·#2044·#2032·#2031·#1967·#1966 · 폰 #2018.

## 4. 연기(ITO 뒤 / G3)
UX-R3a~c 팔레트 · DS-1(·3·4) 잔여 · UX-R2d · #1925 허들 자격 · #1792 TURN · #1856 허들 페어 · M1 폰 UI 패리티(8월 U4 계열 폰 티켓 다수) · #1927 work host(출시 후 Rust 사이드카 ADR) · ADE #1135·#1137 · T3 #1381 · LS-6 #2187 · 6~7월 M-시리즈 잔여(스토어·법무 — iOS v0에 필요한 것만 §2로 승격).

## 5. 이슈 위생 후속(planner)
- 열린 201건 중 6~7월 51건은 대부분 Swift·M0~M8 시대 — LS-5와 같은 기준(두 케이스 + iOS v0)으로 2차 판정 필요(예: #1108·#1101·#1099·#1089 등 게이트 선재, U4 폰 묶음은 M1로 라벨).
- `status:needs-review` 23건·`in-progress` 11건은 랜딩 여부 대조 후 close/relabel.

## 결재 2026-09-08 저녁 (성재)
- **ADR-0004 증보 Accept** — 로컬 provider opt-in 경계. SH-6a-e(#2215, PR #2225) 감사 랜딩 진행.
- **SH-8·SH-9 발급 go** — 브리프 `handoffs/2026-09-08-sh8-grokbot-join-cdp-harness-brief.md`(#2230) · `handoffs/2026-09-08-sh9-hermes-runbook-rust-brief.md`(#2231). 탐색 정정 반영: SH-8은 §3.3.16이 이미 있어 검수·보강, CDP 하네스는 레포에 없었으므로 신규 작성, #1361 Deps 전부 CLOSED; SH-9는 `external-agent-provider/*` 국소 스테일 + SELF_HOST §5 로컬 provider 절 신설(SH-6a-e 의존).
- **Railway 실배포 E2E** — 최종 단계(셀프호스팅 완료·검증 단계)에서 수행. G1'-4 E2E-B 시점.
- **실기기 APNs** — 데스크톱 셀프호스팅 완료 뒤 테스트 진행 계획으로 편성(G2 iOS v0 앞).
