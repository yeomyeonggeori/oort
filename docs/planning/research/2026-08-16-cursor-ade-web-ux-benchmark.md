# 커서 웹 ADE UX 벤치마크 — oort 갭 맵과 차용 편성안

> 2026-08-16 Fable(fork) 리서치. 성재 발제: "커서의 UXUI가 최고 — 차용할 개선 포인트를 잡아라. 특히 클라우드 env 세팅이 10~20분 작업을 지루하지 않게 구성됐다 — 최대한 모방."
> 재료: ①성재 스크린샷 실측(커서 클라우드 에이전트가 `yeomyeonggeori/oort`를 **24m 28s**에 셋업 완주한 화면 — 계정 SuperGrok Heavy) ②공식 문서·웹(조회일 2026-08-16). [실측]=스크린샷, [문서]=cursor.com 문서, [2차]=써드파티.
> 출처: cursor.com/docs/cloud-agent·cloud-agent/setup · x.ai/news/introducing-grok-bot · buildfastwithai/learncursor/infisical 리뷰(2차).

## §0. 생태계 좌표 한 절 (깊은 리서치는 별건)

스크린샷의 웹 ADE는 커서 Cloud Agents 표면이고, 성재 계정은 **SuperGrok Heavy** — Grok Bot이 SuperGrok Heavy·Cursor Ultra($200/월)·Teams Premium에 번들되고 커서 인프라 위에서 돌아가는 xAI×Cursor 통합 구조다[2차·공식]. 즉 "그록 기반 생태계"의 실행 표면이 커서 웹 ADE다. 생태계 심층(봇 오케스트레이션·chief-of-staff 봇·우리 HAP 다이얼인과의 접점 갱신)은 본 문서 스코프 밖 — 별도 리서치로.

## §1. 커서 웹 ADE 해부 — "지루하지 않음"의 장치들

**표면 구조** [실측]: 3열 — 좌(세션 목록: 이름+변경 규모 `+44` 칩·필터·New Chat/Automations/Dashboard), 중(대화: 원 지시문이 맨 위에 고정 → 진행/완료 리포트 → follow-up 컴포저), 우(**실행 컨텍스트 탭**: Environment·Git·Desktop·Terminal·Files — 대화와 실행 상태가 한 화면).

**긴 작업의 지루함 관리 — 핵심 장치 6개**:
1. **작업이 스스로를 설명한다** [실측]: 완료 시 채팅 안에 구조화 리포트 — ①한 문단 요약(레포가 뭔지까지 자기 말로) ②"What I installed" 불릿(왜까지: "pinned 1.83 couldn't build it") ③**Surface × Lint/Test/Build/Run 표**(표면별 게이트 결과 — `896 passed`·`-D warnings clean`·compose healthy). 24분짜리 작업의 산출이 감사 가능한 문서가 된다.
2. **경과 시간의 정직 표기** [실측]: "Environment ready / **Worked for 24m 28s**" — 시간을 숨기지 않고 성과의 단위로 보여준다.
3. **셋업 중 실시간 공유 터미널** [문서]: agent-led setup 동안 shared terminal로 진행을 관전 — 우리 관전 축과 동형.
4. **셋업 결과가 재사용 자산이 된다** [실측+문서]: 완료 즉시 우측 Environment 탭에 **Install Script/Start Script로 정제**되어 편집 가능. "**Needs build**" 칩 + "These scripts have not been tested in an environment build" 경고 + **Test new build** 버튼 — 검증 상태를 칩으로 정직 표기(우리 정직 라벨 문화와 같은 계열). Save하면 환경이 1급 객체(스냅샷·버전 히스토리·**롤백**·환경 해석 위계 repo `.cursor/environment.json` > 개인 > 팀)[문서]. 실패 빌드는 활성 빌드를 대체하지 않는다(fail-safe)[문서].
5. **저장 인센티브** [실측]: "Save your setup and **earn $250 in Cloud Agent credits**" — 재사용 자산화 행위 자체에 크레딧.
6. **follow-up 인라인** [실측]: 완료 후에도 "Add follow up for setup agent" 컴포저가 그 자리에 — 세션이 대화로 계속된다. 팀 공유 URL·read-only 관전·team follow-ups[문서].

**경계 UX** [실측+문서]: Secrets(환경 변수로 주입·암호화 저장·**환경-스코프 시크릿**·TOTP까지)와 Network Access Settings(사용자 설정 상속·Tailscale/Cloudflare Tunnel)가 별도 관리자 화면이 아니라 **환경 편집 화면 안에** 있다.

## §2. oort 대비 갭 맵

| 축 | 커서 | oort 현재 | 판정 |
|---|---|---|---|
| 긴 작업 관전 | shared terminal[문서]+Desktop 탭 | PTY 관전+**라이브 화면(WebRTC — LIVE-1~4·실기동 E2E #1438 진행)** | **우리가 우위**(실화면+control까지) — 단 셋업 국면에 안 물려 있음 |
| 완료 리포트 | 채팅 내 구조화 리포트+게이트 표 [실측] | turn 종료 텍스트+세션 카드(생존성) — **구조화 리포트 없음** | **갭** — 차용 A |
| 경과 표기 | "Worked for 24m 28s" | 세션 카드 elapsed 있음, 완료 성과 단위 표기 없음 | 갭(소) — 차용 C |
| 환경=1급 객체 | 스크립트 편집·빌드 검증·저장·버전·롤백·위계 | 템플릿=운영자 env(`image_ref`)·사용자-대면 UX 없음. A2 스냅샷 템플릿은 예약 후보 | **최대 갭** — 차용 B |
| 셋업 폐곡선 | 에이전트가 셋업→검증→환경으로 저장 | 없음(셋업=운영자 수동·INFRA 런북) | **갭** — 차용 B의 본체 |
| 실행 컨텍스트 탭 | Environment/Git/Desktop/Terminal/Files | 세션 상세(터미널+화면)뿐 — Files/Git diff 없음 | 갭 — 차용 D(스코프 실측 필요) |
| Secrets UX | 환경-스코프·설정 안 통합 | ADR-0004 증보 1(instance-level provider GUI)·워크스페이스 스코프 없음 | 갭(경계 증보 필요) — 차용 E |
| Network 경계 | 상속 설정+터널 통합 | **ADR-0150 증보 1 grant 모델이 더 정밀**(목적×대상×수명) — 단 UX 미구현(P1~P7 미착수) | 모델 우위·UX 갭 |
| 실행 위치 선택 | 암묵(클라우드) | CRUN 티어 축(`tierAxis`·`workLocation`) 기구현 | 우리 우위 |
| 사람 개입 | approval·take control | 승인 카드+로그인 핸드오프 카드(LIVE-4)+control(LIVE-3) | 동등~우위(채팅 원장 영속은 우리만) |
| 팀 가시성 | 세션 URL 공유 | 채팅=SoT라 카드가 채널에 자동 영속 | **구조적 우위** — 리포트 카드만 넣으면 커서보다 강함 |

## §3. 차용 후보 (S/M/L · ADR · 표면)

| # | 후보 | 규모 | ADR | 표면·정합 |
|---|---|---|---|---|
| **A** | **작업 완료 리포트 카드** — 요약 prose+행위 불릿+Surface×게이트 표+경과 시간을 구조화 카드로. 에이전트 방출(LIVE-4 카드 기계 동형 — props 구조화·코어 계약·웹/폰 렌더) | **M** | 불요(카드 kind 추가) | 채팅+세션 상세. 승인 카드 가족 확장 — 채팅 원장 영속이라 커서 대비 팀 가시성 우위 |
| **B** | **환경 셋업 폐곡선(oort Env)** — ①"이 레포 환경 만들어줘" goal이 T3 세션에서 돌고 **관전 라이브 화면+A 리포트로 관전** ②완료 결과를 **환경 객체**(CubeSandbox 스냅샷 템플릿+install/start 스크립트·검증 상태 칩·버전·롤백)로 저장 ③다음 세션이 그 환경에서 수초 부팅. ADR-0150 **setup phase가 곧 install 단계**·A2 스냅샷 후보의 사용자-대면 완성형 | **L** | **필요**(환경 원장 신설·템플릿 빌드 권한 경계 — ADR-0156/0150/0164 정합) | 워크콘솔+세션 상세. 전제: #1437 어댑터·#1438 E2E |
| **C** | **경과·검증 상태 정직 표기** — 완료 카드에 "24m 28s 동안"·환경/스크립트에 "빌드에서 미검증" 칩 계열 | **S** | 불요 | A에 동봉 가능. 우리 정직 라벨 문화의 사용자-대면화 |
| **D** | **세션 실행 컨텍스트 탭**(Files 변경 diff·Git) | **M** | 가능성(세션 파일 읽기 경계 — workd 경유 실측 선행) | 세션 상세. 스파이크 선행 |
| **E** | **시크릿 스코프 세분화**(환경/워크스페이스 스코프) | **S~M** | 증보 필요(ADR-0004 계열 저장 경계) | 설정. B와 짝 |
| **F** | **환경 저장 크레딧 인센티브**($250 훅의 우리판) | **S** | 불요(ADR-0164 안에서) | 제품 결정 — B 랜딩 시 |

권장 순서: **A+C(지금 착수 가능— 카드 기계 기성품) → D 스파이크 → B(E2E·LIVE-5 뒤 — ADR 기안 선행) → E·F(B와 함께)**.

## §4. 성재 결정 큐 + 티켓 초안

1. **A+C 착수**(작업 리포트 카드 — ADR 불요·LIVE-4 카드 기계 재사용): 티켓 초안 "REPORT-1: 작업 완료 리포트 카드 — 코어 계약(요약/불릿/게이트 표/경과)+에이전트 방출+웹/폰 렌더+design-review".
2. **B ADR 기안 시점** — E2E(#1438) 후 vs 지금 기안만 선행. 티켓 초안 "ENV-ADR: oort 환경 객체·셋업 폐곡선 ADR(원장·템플릿 빌드 경계·버전/롤백·해석 위계)".
3. **D 스파이크** — "세션 워크스페이스 파일 읽기 경로 실측(workd·30분급)".
4. **F 인센티브** — B 랜딩 시 결정.

## §5. 부수 시사점 — 커서가 우리 레포에서 겪은 마찰 (toolchain)

커서 에이전트는 우리 레포를 빌드하려고 **Rust를 고정 1.83→stable 1.97.1로 범프**해야 했다("the workspace requires edition2024, so the pre-existing pinned 1.83 couldn't build it" [실측]). 외부 에이전트가 우리 레포에서 만나는 첫 마찰의 실증이다. 시사점 2개: ①`rust-toolchain` 고정과 edition 요구의 부정합 해소 티켓(고정을 edition2024 지원 버전으로 올리거나 문서화) ②AGENTS.md에 셋업 마찰·정본 게이트 요약이 이미 있는 덕에 커서가 24분에 전 게이트 그린(웹 896·clippy clean·compose e2e healthy [실측])을 재현 — **우리 게이트 재현성의 외부 실증**이자, 셋업 시간 24분이 B(스냅샷 환경)로 수초가 될 수 있다는 근거.
