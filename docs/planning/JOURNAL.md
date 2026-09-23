# 기획 세션 저널 (newest-first, 기존 항목 불변)

> 세션 종료 시 공용 계약에 따라 짧은 항목을 맨 위에 추가한다.
> **로테이션(2026-09-01 재편):** 이 파일은 최근 20항목만 담는다. 갱신할 때 초과분을 해당 월의 `docs/planning/archive/JOURNAL-YYYY-MM.md`로 원문 그대로 이동한다.

## 2026-09-24 · Opus 5.5(+워커·리뷰어 C·보안 검수·design-review) · 재개(macOS 27 재부팅) · ★Railway 팀 인스턴스 가동 · 폰 대화 1 랜딩 · 원격 R0.1~R1.1

- **재개:** 재부팅으로 `/private/tmp`가 초기화됐다. 지시문과 리뷰 전문을 `claudedocs/resume-2026-09-23/`로 옮겨 영속화했다.
- **랜딩(engine):**
  - #2580 Railway 템플릿(리뷰어 C R1·R2 FAIL → R3 PASS, Client-IP gate)
  - #2597 R0.1+(A′)(보안 PASS)
  - #2579 workd 뼈대(보안 PASS, 조건 M5)
  - #2605 R1.1 경화(재검수 PASS)
  - #2606 Railway 첨부 경로
- **랜딩(uxui):**
  - #2587 TestFlight 준비
  - #2585 승인 카드
  - #2593 안읽음(DR R1 FAIL → R2 PASS)
  - #2594 점프(DR R1·R2 FAIL → R3 PASS)
  - #2614 점프 후속
- **Railway `oort-team` 가동:**
  - Pro·싱가포르·v0.1.6·9서비스
  - v0.1.5→v0.1.6 업그레이드·되돌리기 리허설
  - 백업 격리 복원 97테이블 일치
  - IP gate PASS
- **owner claim:** 성재가 폰으로 완료했다.
- **성재 결정:**
  - Railway Pro·리전·owner 메일 (a)
  - Codex 원격 「샌드박스 자동 실행 수용」(조건부 #2607)
  - Claude auto 기기 「시작 직후 교정」
  - ASC 확인은 planner 실측으로 위임(#2568)
- **폰 브라우저 온보딩 피드백:** 입력 자동 확대·에이전트 단계 건너뛰기가 문제였다 → #2616.
- **교훈:**
  - 회수 스크립트가 커밋 없는 새 워크트리를 「랜딩 완료」로 오판했다. `pipefail`+`grep -q`로 가드가 무력화돼 있었다. 둘 다 수리했다.
  - 게이트 49·68은 재부팅 직후 DNS 간헐 지연 때문이었다(#2599).
- **다음:**
  - #2584 랜딩 → 묶음 승격 → iOS·데스크탑 증거 빌드
  - 24시간 자원 재측정·비용 보고

## 2026-09-23 · Opus 5.5(+서브에이전트 조사 4·리뷰어 C·보안 검수) · ★목표 A 확정 — ADR-0187(목표·배포 두 등급·절차) · ADR-0188 Proposed→Accepted(폰 원격 작업) · 목표 A 계획

- **모델 전환 리뷰(Fable 09-22 작업 인수):**
  - 목표 정의가 6번 바뀌었다.
  - 30일 main 커밋: 웹 492 · docs 396 · STATUS 366 · 서버 79 · iOS 28 · 데스크탑 1.
  - 09-22 작업 PR 12 대 승격·sync PR 33.
  - A/B를 제시했다.
- **성재 결정:**
  - 목표 A(팀이 데스크탑·iOS로 매일 쓰는 oort 먼저)
  - Railway 기본, Tailscale 보조
  - iOS = Buzz 모바일 + Codex/Claude식 원격 작업
  - 실기기 푸시 필수
  - TestFlight·App Store 둘 다 목표, M7 두 등급(순서는 기안자 도출)
  - Grok 은퇴 · Opus 5.5 서브에이전트 · 고정 병렬 상한 없음
  - 묶음 승격과 STATUS 폐지는 확인을 위임
- **성재 조치:** Railway 로그인.
- **산출:**
  - #2565(PR #2566): ADR-0187 · M7-I/M7-S · TRACKS 묶음 승격 · STATUS 동결 · PIPELINE
  - 계획 `2026-09-23-goal-a-plan.md` · ADR-0188(Proposed → 2차 결재로 Accepted) · ROADMAP §0–§2 · 배포 레인 감사(research)
- **조사 4:**
  - Buzz 모바일: 승인·작업 생성·공개 푸시 없음
  - Codex/Claude: host outbound → 벤더 relay, VPN 없음
  - oort 원격 자산: 서버 계약 거의 완비, host 프로그램 부재
  - 배포 레인: Railway 템플릿 결함 5+와 doctor 거짓 초록, 데스크탑 즉시 가능, iOS 권한 문구
- **검수:**
  - 리뷰어 C R1 FAIL → 수리.
    - Blocker: 계열 단위 승인이 무기한 승인이 된다.
    - High: 공개 next 채널, #31 교착, I-6이 실패할 수 없음, 원문과 도출 혼재, CURRENT_STATE.
  - ADR-0188 보안 R1 FAIL → R0 방어 선행으로 개정.
    - Blocker: 채널 멤버 누구나 승인.
    - High: bypass 설정 경로, Face ID는 클라이언트 게이트, 지시 판별 기준 없음.
- **교훈:**
  1. 버전 규칙이 계열을 만들지 않으면 계열 단위 승인은 무기한 승인이다.
  2. 로컬 배포 스크립트도 배포 경계다.
  3. 정책 PR과 상태 문서를 나누면 중간 상태가 SessionStart로 새어 나간다.
  4. 오늘 코드의 승인 결정자는 「채널 멤버」다. 원격 작업 전에 막는다.
- **2차 결재(질문 응답):**
  - iOS: 원격 작업 R1까지 팀 배포 전(M7 I-8)
  - ADR-0188 Accept
  - 데스크탑 next = 팀 채널
  - W1 전부 승인: 코드 레인, Railway 배포와 APNs sealed 변수, v0.1.6 발행, 첫 증거 빌드 2종
- **착수:** 워커 8기(Opus 5.5 서브에이전트)
  - #2205 Railway 설정
  - #2568 TestFlight 준비
  - #1084+#2513 승인 카드
  - #1964·#1892 안읽음·점프
  - #2569 푸시 탭
  - #2570 R0
  - #2571 workd(R0 랜딩 뒤 머지)
  - #2572 PG 이미지 libssh2 수리. v0.1.6 발행이 실패한 원인이다: 고정한 deb13u1 arm64 파일이 Debian pool에서 삭제되어 404를 받았다. deb13u2(CVE 6건)와 영구 URL로 고친다.
  - 이와 별도로 v0.1.6 publish-images를 dispatch했다(run 35810234902, 성재 release 승인). PG 이미지 단계에서 실패했고(#2572), 앱 이미지만 아키별로 푸시됐다. 목록·증명은 없으며 릴리스가 아니다.
  - CSP 프리퍼블리시 게이트는 scratch 경로에서 Colima 마운트 문제로 한 번 실패했고, 홈 경로로 옮겨 PASS했다.
- **보안 위생**(성재 「보안 위생 관련해서도 처리해줘」):
  - `.p8` → `~/.momo-secrets`(400, 폴더 700)
  - 업데이터 키에 암호를 걸었다(같은 키 쌍, 공개키 불변, 암호는 키체인 `momo-updater-key`)
- **랜딩:** #2566 → track/engine(a5c9b109). 리뷰어 C R1 FAIL → R2 FAIL → R3 PASS, 정책 감사와 exact-base verifier PASS.
- **다음:** #2567 랜딩 → #2572 랜딩 → 묶음 승격 → v0.1.6 재발행 → Railway 단계 2 → TestFlight·데스크탑 증거 빌드. 워커 PR 수거·독립 검수·랜딩.

## 2026-09-22 (저녁) · Fable(+Opus 5 워커·리뷰어 C·design-review) · ★AX 축 초대 1종 폐곡선 main 정본화 — AX-2·3a·3b·4 + #2066·#2498·#2476·#2044 8건 랜딩

- 성재 결재: ADR-0186 Accept · W-A go · 워커=Opus 5 서브에이전트. 하루 랜딩(track→main 승격+sync 각 1회): #2519(ADR Accept) · #2497(정책3, 감사) · #2490(#2476 설정›기기, design R2 PASS) · #2523(#2066 마스터키, 리뷰 C FAIL→R2, 감사) · #2524(AX-2 레지스트리, design R1 FAIL H1→R2 PASS) · #2537(#2498 직렬화, 리뷰 C FAIL→R3, H1→M 재판정 uuidv7) · #2538(AX-3a propose, 리뷰 C FAIL→R2, 087 CHECK 재작성·D7 정오표, 감사) · #2485(#2044 오버레이, design R1 FAIL B2→R2 PASS) · #2549(AX-3b 실행기·secretOnce, 리뷰 C PASS-WITH-NITS→R2) · #2540(AX-4 카드, design R1 FAIL B1→R2 FAIL H1→R3 PASS). main `07567a14`.
- 교훈: ①리뷰어 C·design-review가 회전마다 실결함을 잡았다(sender 폴백 잔존·T2 백필 부재·거부 차단·멱등키 충돌·UA 포커스 링·390 절단) — fresh context 검수 상설 ②리뷰어 전제도 재판정 대상(uuid 무작위 → uuidv7 반증) ③DDL 무접촉 단정은 CHECK 열거를 봐야 한다(087) ④ADR 부록 샘플의 낡은 값(section=invites)이 두 PR을 오갔다 — 부록은 실좌표 검증 후 확정 ⑤워커 3기+리뷰 병렬은 호스트 부하 20 근처 — 상한 2 규율 재확인.
- 다음: AX-6 #2512 E2E(초대 1종) → E2E-A 발행 이미지 → SH-11a → ITO. 후속 이슈 9건 적립.

## 2026-09-22 (오후) · Fable · ★AX-0 main 정본화 + ADR-0186 Accepted + W-A 발사(Opus 5 서브에이전트 2기)

- AX-0 #2506: PR #2515 → track/engine → 승격 #2516(main 95199a69) → sync #2517/#2518. docs 게이트·CI PASS, 보호 경로 0.
- 성재 결재: 「승인할게 진행해줘. 워커는 그냥 opus 5 서브에이전트로」 → ADR-0186 **Accepted**(§7 확정점 4 전부) · W-A go. 워커 레인 예외 기록(PIPELINE 기본 Grok 4.6 → 이 배치 Opus 5 서브에이전트).
- 발사: `goal_claim` #2066(engine)·#2507(uxui) → Agent(opus) 2기, 미션 `claudedocs/resume-2026-09-22/mission-*.md`.
- 다음: 워커 보고 → 독립 검수 → 랜딩(#2066은 정책 감사, AX-2는 design-review) → W-B. planner 병행 #2498·PR 3건.

## 2026-09-22 · Fable · ★진행 브리핑 + 시장 동향(Muse·ZCode·Slack Code·NanoClaw·OpenUI) + AX 에이전트 행동 축 편성 — ADR-0186 Proposed·ADR-0004 증보 4 Accept·이슈 9·브리프 5

- 복원: 09-12 #2501 정합 뒤 랜딩 0(main=engine=uxui 동일 트리). 미랜딩: #2498(로컬)·PR #2485/#2490/#2497·#2066(Proposed)·#2205.
- 성재 결재(4): AX 첫 실물=ITO 전 초대 1종 · 승인 정책=위험 등급별 · ADR-0004 증보 4 Accept D2(a) · UX-R3a 팔레트 축소 해제. 「나머지는 설계 구체화, 준비가 온전하면 착수」.
- 산출: `2026-09-22-plan-revision.md`(브리핑·동향·편성) · **ADR-0186**(propose/approve/execute, 선언형 카드, 1회 시크릿=결정 응답에만, DDL 무접촉, run park + `run_complete` 409, 부록 A~E 고정 계약) · 이슈 #2506~#2514 · 브리프 5본(#2066·AX-2·AX-3a·AX-3b·AX-4) · ROADMAP §1 AX 행.
- 코드 실사: Agent Port 도구 7종은 전부 읽기·발화·run 수명 · 승인 `run_id NOT NULL` → hosted 제안은 claim한 job의 run 안에서 · `run_complete`는 승인 대기 미검사(가드 신설) · invites 라우트 5종·webhooks create/rotate/revoke 존재 · 외양은 localStorage(테마는 클라 명령 카드).
- 다음: 문서 PR(track/engine) docs 게이트 → 랜딩·승격 → **성재: ADR-0186 Accept + W-A 발사 go(#2066 ∥ AX-2)** → planner #2498 인수·PR 3건 검수.

## 2026-09-12 · Astra + Grok 4.6 · 공용 파이프라인 경량화 (#2501)

- 한 일: AGENTS 공용 계약·CLAUDE import, 공용 planning skill, 단일 CURRENT_STATE와 필요할 때 읽는 문서 구조. 이전 Fable 스냅샷·저널 원문은 archive 보존.
- 실행: Grok 4.6이 같은 clone의 워크트리 간 owner·checkpoint 도구와 오프라인 복원을 구현. Astra가 기획·독립 검수·통합 담당.
- 검수: 문서 R2·스크립트 독립 검수. 제목만 복원·손상 기록 덮어쓰기·Git 환경변수 오결속·증거 HEAD 덮어쓰기 수정. 실제 훅/격리 소유권 집중 시험 통과; 최종 게이트·통합 증거는 PR과 공용 checkpoint.
- 선행 의존성: Railway pin 불일치 재현 → 기존 PR #2500 clean-head docs77·정책 검증 확인 → engine `0726c8e2`로 별도 통합. 배포는 수행하지 않음.
- 다음: #2501 최종 전달 상태는 공용 checkpoint에서 확인. 통합 후 두 하네스가 같은 계약으로 복원한다. #2498과 Fable PR은 베타 재개 지시까지 대기 유지.

## 2026-09-11 · Fable · ★v0.1.5 릴리스(803ae7d5) + 밤사이 셀프호스트 하드닝 7건 main — 스냅샷 98

- **v0.1.5**: 성재 dispatch(run 34566962884, main tip 803ae7d5 — 워크플로가 main만 허용해 스냅샷 97의 db5cb8e9가 아님) → 승인 3회 → 앱 `sha256:5481c14e…`·postgres `sha256:c6a5bb84…` list digest, attestation PASS ×2 → **발행 이미지로 제로베이스 E2E-B′(`--published-image`+`--claim`) 12/12 PASS**(이전 D1~D4 소멸, D5=doctor env.digest가 committed manifest v0.1.4와 불일치 → #2469로 해소) → 태그·Release·`releases/latest.json`·CHANGELOG `[0.1.5]`(PR #2469).
- **랜딩(main)**: #2433 momo_notifier 롤+최소 GRANT+기존 env 백필(#2193, 리뷰 R1→R2: sweep 테이블 GRANT 누락·업그레이드 파손·doctor DELETE) · #2461 GRANT 트림+호출 그래프/INVOKER 트리거 도출 29표+E2E T3 stale 시드(#2448, R2: work_cloud_host_transition) · #2452 생성기 `--claim` 1급(#2438) · #2436 E2E-B 문서 이탈 D1~D4(#2429) · #2443 PITR 계약 시험 Colima 픽스처(#2157) · #2444 게이트 정책 배치 1(#1984 #2124, R1 FAIL: `bash -n a b c d` 첫 파일만) · #2460 정책 배치 2(#2456) · #2428 S1 nits(#2418). #2181은 #2307로 기해소 → 닫음. #2205는 SH-11a 실배포 티켓으로 재범위.
- **레인**: grok 리뷰어 C 사보타주가 실구멍 4건을 잡음(sweep GRANT 누락·bash -n 파일 인자·잠금 문자열·트리거 읽기 테이블). 기계 수면(02:30~09:30)·네트워크 중단(10:00~14:30)으로 grok 세션 3회 정지 → `-c` 재개/재스폰. 성재 질의 「grok 네이티브 서브에이전트?」 → Claude 모델 한정으로 불가, 하이브리드 결정(메모리·PIPELINE 후속).
- **다음**: E2E-A 그록봇(발행 이미지) → SH-11a → v0.1.6 편성.
- **19:1x 보강**: 배치 ct(v0.1.5 매니페스트 #2469)·cu(스냅샷 98 #2470)·cv(ADR-0004 증보 4 Proposed #2473 — webhook 마스터키 분리·D2 택일 (a) 이행 복사 권고·rate 예산, **성재 결재 대기**)·cw(#2468 기기 목록·해제 라우트 → #2029 closed, uxui 후속 #2476) main. uxui 워커: PR #2485(오버레이 층 이름표) 완료·#2476 진행 중. Docker 스크래치 9.5GB 회수. 다음 세션 진입점: `claudedocs/resume-2026-09-07/RESUME.md` 맨 끝 「재개 체크리스트」.

## 2026-09-10 (낮) · Fable · ★ADR-0185 Accepted 집행 — SH-12 온보딩 5/6 main + SH-11 플랫폼 중립화(e·e-2·b·c·host-network) main + 워커 레인 Grok Build 복귀 — 스냅샷 97

- **성재 결재(09-10)**: ①「결정 없이 재개, 다음 순서 진행」 ②**ADR-0185 권고안 그대로 Accept**(D-A (3) 절충 · D-B (b) 시드 유지+온보딩 덮어쓰기(v0.1.5) · D-C (iii) 첫 에이전트 연결) → #2330 ③「다시 fable orchestrator 모드, **grok build grok 4.6 적극 활용**」 → PIPELINE §1/§3/§5 갱신 #2357(Grok Build CLI 워커·리뷰어 C, Cursor CLI 폴백).
- **SH-12 제로베이스 온보딩(ADR-0185)**: SH-12a #2301(claim 뒤 first-run 복원) · **SH-12b-e #2331**(E1 워크스페이스 rename PATCH·E2 오너 핸들, ban 검사·fan-out, R2) · **SH-12c #2333**(S2 팀원 초대·skip 탈출구, design-review R1 FAIL B1·H1→R2 PASS: claim→S2 세션 복원 hold 순서·마커 선기록) · **SH-12d-e #2334**(첫 에이전트 활성 킥오프, R2: hosted 오프너 게이트웨이 레일·advisory lock) · **SH-12d-w #2335**(no-active-agent hold 해제) — 전부 main. **SH-12b-w #2332(S1 내 워크스페이스·내 이름)**: design-review R1 FAIL(H3: 영문 오류 카피·세션 정체성 미갱신·실패 출구/설정 컨트롤 부재) → R2 FAIL(H2: S2 skip이 S1 pending 소거·설정 stale 409) → **R3 진행**. SH-12e #2336 = S1 뒤.
- **SH-11 플랫폼 중립화(ADR-0184)**: **SH-11e #2325**(day-2 v2 T2: oort_tier()·backup/restore over URL·doctor SQL-over-URL·/healthz schema; R2: T2 오리진 선택기 스킵리스트·스탬프 없으면 명시 --tier) · **SH-11e-2 #2346**(런타임 이미지 PGDG client 18 + python3, in-image T2 doctor/backup 실측 +12.4 MB) · **host-network 행 #2340**(127.0.0.1 파생 + network_mode: host 오버레이 — E2E-A A3/A4 재현성) · **SH-11c #2377**(AWS Lightsail/EC2 T1 terraform·cloud-init·IAM·비용 가드, R2: 클론 핀 fail-closed) · **SH-11b #2379**(Fly T1 fly.toml·entrypoint, R2: compose 세트에 web 서비스 = doctor 정합) — 전부 main(감사 랜딩). **SH-11d #2386**(Cloudflare T3 엣지, R2: 시험 가드 3 강화) main. 잔여 nits #2328(T2 스탬프 emit·키 42·앵커 grep 등 8항목)·#2347(origin 폴백·id 핀·pg_dump rc·python3 핀) main. SH-11a(Railway 실배포)는 최종 단계. E2E-A 문서 정정 #2326 main. 잔여 nits #2328·#2347(T2 스탬프 emit·앵커 grep·python3 핀 등).
- **A6 #2327**: momo-core `approvalConsequence` 빈 이름 조사 결함 재현·수리 — design-review R1 FAIL(H2: 사실 행 동어반복·재개 행 `??`) → R2 FAIL(H1: 재발급 런치 시드에 폴백 문구) → R3 PASS → main. SH-12c 잔여 #2356 main. hostedRoutineLabel 빈 핸들 식별자 #2395 main.
- **레인 실측**: Grok Build CLI 워커 8기·리뷰어 C 7기 — PR 전부 산출, 리뷰 판정은 사보타주·PG 실측·감사 문서까지 구체적(planner 재판정으로 수용). 연결 끊김 시 `-c` 재개 유효. 워크트리별 FETCH_HEAD 함정(리뷰어를 옛 헤드에서 시작 → 재발사). 병렬 랜딩은 STATUS.md·SH-11f 표·local_gate 케이스가 매번 충돌 → planner union 규칙(행 둘 다·notes 병합·README 링크 행) + 게이트 전수 재검.
- **교훈**: ①UI 스테이지는 실빌드 세션 복원과 함께 검증해야 한다(S2 hold 순서, S1 정체성/펜딩 분리 — RTL 단독은 못 본다) ②hosted 에이전트 경로는 outbox 행이 아니라 배달(run·inbox event)까지 단정해야 한다(#2355 R1) ③레시피는 doctor 정합(서비스 이름·compose 세트)까지 시험에 못박아야 한다 ④gitleaks는 sha256 상수도 잡는다 — 허용은 fingerprint 한 줄 + 사유.
- **운영 교훈(추가)**: 병렬 랜딩은 STATUS.md 충돌이 상수 → `fix-conflict.sh`(union) · 체인 merge 직전 「체크 미보고」 레이스 → promote-lib에 대기·재시도 추가 · 네트워크 단절·세션 한도(19:10~20:30) 중 체인/워커 정지 → 재개 시 라벨·감사 코멘트 상태부터 확인 · Fable 한도 시 design-review도 grok 리뷰어 C + 기존 캡처 하네스로 대체 가능(근거 구체성으로 재판정).
- **잔여 후보**: #2418(S1 nits) · v0.1.5 발행(노트 초안 `claudedocs/release-v0.1.5-notes-draft.md`; S1·S2 랜딩 뒤 성재 dispatch) · 제로베이스 온보딩 E2E 재실측(A·B) · SH-11a Railway 실배포(최종) · APNs(데스크톱 뒤) · #2262 M-1·M-2·N3 · 캡처 레인 게이트 · D4 · #2157·#2181·#2193.

## 2026-09-09 (오후·저녁) · Fable · ★E2E-A 그록봇 실측 완주(설치→합류→답장→disconnect PASS) + ADR-0184 Accepted + SH-11·SH-12 패킷화(Fable 워커·Workflow 병렬) — 스냅샷 96

- **성재 결재(09-09 오후)**: ①**ADR-0184 Accept**(플랫폼 중립·에이전트 주도 셀프호스팅 + D7 미지 플랫폼 특성 분류) ②데모 워크스페이스 경유는 제로베이스가 아님 → **SH-12 제로베이스 온보딩**(워크스페이스 생성·프로필·팀 규모·초대/skip) 계획, 적당한 타이밍에 실측 ③**v0.1.5는 실제 온보딩 구조로 작업 뒤 발행** ④19:00까지 워커=Fable·Workflow 허용(토큰으로 시간 단축, 병렬) ⑤`Bash(osascript:*)` 허용 규칙 추가(로컬 테스트 한정 그록봇 제어).
- **E2E-A(#1361, 그록봇 VM)**: README 붙여넣기 블록 1회 → 봇이 §0 계약대로 설치(vfs·host network 우회 A1/A3/A4) → doctor PASS → cloudflared 터널+claim URL 핸드오프 → planner가 사람 대행(Chrome 도구)으로 claim·로그인·Agent Port 합류 확인(pairing→detected→**active** 17:08) → `@grokbot` 멘션 → 봇이 `oort_inbox_read`/`oort_message_post`로 **답장 seq 2**(17:12) → **disconnect(HAP-E6)**: 매니페스트 10항목·봇 정리 매니페스트·acknowledge(evidence 필수)·complete → `disconnected`·회수 자격 401·잔여 파일 0 = **기준 1·2·4 충족, 3은 수동 왕복 + 스케줄 지연 발화(A8, 28분)**. 보고 `research/2026-09-09-e2e-a-grokbot-run.md`(#2302). 이탈: **A5 릴리스 지연**(그록봇 경로 = v0.1.4 → v0.1.5 필요) · A7 도어벨 URL/key는 사람 승인 지점 · A8 스케줄러 지연(카피 한정).
- **정본화**: ADR-0184 Proposed #2291/#2292 → **Accepted #2295**(승격 #2298·sync #2299/#2300) · E2E-A 보고 #2302(승격 #2303) · **ADR-0185 Proposed #2304**(승격 #2309) · (랜딩 중) SH-12a #2308(fresh 리뷰 PASS, 사보타주 6/6 RED) · (검토+감사 중) SH-11f #2307 · SH-11g #2310. Fable 워커 3기(격리 워크트리·PR-only)와 검토 에이전트 3기가 병렬로 돌았고 planner 검토 병목만 남았다.
- **패킷**: SH-11g(`--platform` 프로파일·§0 경계·§1 티어표) · SH-11f(gate:csp-deploy 렌더 기반·템플릿 시험·env 표) · SH-11a~e 브리프 초안 · **SH-12 브리프**(`brief-sh12.md`: 결재 **D-A 노선**[buzz 2스텝 캐논 vs 성재 5스텝 → 권고 절충(3): 필수 이름+프로필 1화면·선택 초대 skip 탈출구·팀 규모는 추론] · **D-B 제로베이스 정의**[권고 v0.1.5=(b) 시드 유지+온보딩 덮어쓰기, (a) 시드 제거는 후속 ADR] · D-C 셀프호스트 킥오프 no-op → 첫 에이전트 유도) → **ADR-0185 Proposed** 초안 · **SH-12a #2301**(claim 뒤 first-run 퍼널 전체 스킵 결함 — ClaimPage가 마커 1/4만 기록) 결재 불요 즉시 수리.
- **교훈**: ①봇에게 「지시 1회 → 매니페스트 1회」 형식을 주면 HAP-E6 정리가 한 번에 닫힌다 — acknowledge는 disposition+evidence가 짝(문서 §3.3.18 반영 확인) ②그록봇 스케줄 루틴은 동작하되 ≈2배 지연 — 카피는 「지연 가능」, 도어벨이 1차 ③Workflow/Fable 워커 병렬은 격리 워크트리 + PR-only 계약이면 planner 검토 병목만 남는다 ④E2E는 「누구로 착륙하는가」까지 봐야 제로베이스다(데모 시드 착륙 = 성재 지적).
- **잔여 후보**: SH-12b~e(ADR-0185 결재 뒤) · SH-11a~e 이슈화 · A1/A3/A4·A6·A7 문서 티켓 · VM Update/Reset 복구 실측 · #2262 M-1·M-2·N3 · 캡처 레인 게이트 · D4 플러그인 검증기 Rust화 · `arbitrary_tw` 사각 · 선재 #2157·#2181·#2193 · Railway E2E(최종) · APNs(데스크톱 뒤) · **v0.1.5 발행**(성재 dispatch, CHANGELOG·manifest).

## 2026-09-09 (낮) · Fable · ★E2E-B 실측 완주(케이스 B 폐곡선 PASS) + 실결함 2·판정 1·문서 묶음 수리 전량 main 정본화 + UX-R2c 잔여 폐곡선 — 스냅샷 95

- **성재 결재**: 「Fable 위주 속도·완성도, 19:00 초기화까지 타이트」 재개 go · D9(셀프호스트 생성 env `MOMO_HOSTED_DELIVERY_ENABLED=true` 기본) 승인 · #1361 라벨 blocked→ready 승인 · 그록봇 E2E-A를 planner가 CDP/컴퓨터 제어로 집행하라는 지시 · 「병렬 가능하면 병렬로」.
- **E2E-B(독립 셀프호스팅, 로컬 경로)**: 신규 클론에서 `SELF_HOST.md` 명령만으로 설치→로그인→본인 provider(mock hermes, `--allow-local-provider`)→첫 멘션 답장 seq 2→**Agent Port 합류**(pairing→detected→confirm→active)→멘션 → `oort_inbox_read`/`oort_conversation_read`/`oort_message_post` 답장 seq 4→2인 합류 시 웰컴 킥오프 seq 5. 보고 `docs/planning/research/2026-09-09-e2e-b-selfhost-run.md`(#2265). 이탈 11: **D2**(로컬 빌드 웹 스테이지 `MOMO_BUILD_SHA` 미전달 — #2258/PR #2261 수리) · **D10**(`oort upgrade --local-build`가 pull — #2260/PR #2269 수리) · **D8/D11**(doctor/status outbox 판정 — #2264/PR #2270 수리) · **D9**(hosted delivery 기본 off — 생성기 기본 `true`, #2263) · D1·D3·D5·D6·D7(문서·OpenAPI — #2263/PR #2277) · D4(플러그인 검증기 Swift 잔존, 후속). upgrade의 백업 단계 PASS(dump 627,874 B). 폰 QR/푸시는 결재대로 보류.
- **정본화(순서)**: UX-R2c #2216(design-review R7 PASS, 승격 #2255) · E2E-B 보고 #2265 · D2 #2261(승격 #2271) · D10 #2269(#2274) · doctor #2270(#2278) · docs+D9 #2277(#2281) · #2256 잔여 폐곡선 #2262(design-review R1 PASS B0·H0·M2·N3, CI flake ×2 → RTL waitFor 5s로 굳힘, GHCR 고지 번들 재생성; 승격 #2284). main `1184271f` · uxui `88ff8d0f` · engine `820382a7`.
- **E2E-A(그록봇)**: 앱을 `--remote-debugging-port=9333`으로 재기동(GrokBot/0.44.0), 하네스 READ/WRITE OK, 설치 지시문(README 붙여넣기 블록 + cloudflared 폴백·URL 2개 보고 노트) 컴포저에 스테이징. **전송(Enter)은 Claude Code 자동 모드 분류기가 OS 키스트로크·CDP 키 이벤트 둘 다 거부** → 성재에게 Enter 1탭 또는 `Bash(osascript:*)` 규칙 요청(대기).
- **교훈**: ①체인은 트랙 이동 레이스에 약하다 — BEHIND 재확인(20s)·CONFLICTING 조기 ABORT·검증기 4×30s 재시도를 템플릿에 넣었고, STATUS.md 충돌은 planner가 합집합으로 푼다(오늘 5회) ②워커의 「측정」 시험이 jsdom에 숫자를 심는 경향 → 렌더 DOM 구조 단정 + 브라우저 측정은 캡처 레인, 그런데 캡처 레인이 병합 게이트에 없다(후속) ③npm devDep 추가 = GHCR 고지 번들 재생성 ④브리프의 브랜치명은 `<type>/<issue>-<slug>` 규약으로.
- **잔여 후보**: #2262 M-1·M-2·N3(핸들 양성 경로 가드·캡처 레인 게이트) · D4 플러그인 검증기 Rust화 · `arbitrary_tw` 프리플라이트 사각 · 선재 #2157·#2181·#2193 · E2E-A 본 실행(전송 권한 뒤) · Railway E2E(최종 단계) · APNs(데스크톱 뒤).

## 2026-09-08 (저녁·밤) → 09-09 새벽 · Fable · ★결재 4건 집행 + G1'-2·G1'-3 전량 main 정본화(SH-6a-w R7 PASS·SH-6a-e·#1265·SH-8·SH-9) — 스냅샷 94

- **성재 결재(09-08 저녁)**: ①ADR-0004 증보 Accept(로컬 provider opt-in 경계 — planner가 워커의 「Accepted(성재 승인)」 표기를 Proposed로 정정해 결재를 받은 뒤 Accepted) ②SH-8·SH-9 발급 go ③Railway 실배포 E2E는 최종 셀프호스팅 검증 단계 ④실기기 APNs는 데스크톱 셀프호스팅 완료 뒤. 기록: `2026-09-08-remaining-work-map.md` 결재 절 · `first-goal-two-cases.md` §9.
- **정본화(순서대로)**: #1265 웹훅 인바운드(PR #2226, R2: 세 Caddyfile `/hooks/*` 프록시 + 「403 아님」만 보던 계약 시험을 블록 실재·업스트림·순서 단정으로 교체; 승격 #2227) · G1'-3 패킷 docs(#2232→#2233) · **SH-6a-e**(PR #2225, 승격 #2237, ADR-0004 증보 Accepted, mock hermes E2E) · **SH-8 #2230**(PR #2236: §3.3.16 라우트 대조표 5/5·pairing bearer `tools/call` 401 문서 정정·로컬 CDP 하네스 READ/WRITE·SEND=사람 Enter 1탭; 승격 #2240) · **SH-9 #2231**(PR #2243: 4문서 Rust 현행화·SELF_HOST §5 로컬 provider 실측 seq=3·문서 인용 게이트; 승격 #2244) · **SH-6a-w #2204**(PR #2214, design-review **R5 FAIL B2 → R6 FAIL B1 → R7 PASS B0·H0·M0·N4**, R8 주석 정정; 승격 #2247). main `9dd350e1` · uxui `857f3277` · engine `3d1923e2`. UX-R2c #2216 워커 발사(00:2x).
- **탐색 정정(SH-8/SH-9 브리프)**: §3.3.16 합류 절은 09-06에 이미 존재(검수·보강으로 축소) · CDP 하네스는 레포에 커밋된 적 없음(신규 작성, 사양 research/2026-08-22) · #1361 Deps 전부 CLOSED(blocked 라벨 낡음 — 재실측 코멘트 게시, 라벨 교체는 성재 승인 대기) · external-agent-provider 스테일은 국소적(Swift 이름 11·죽은 검증기 5·포트 2), 진짜 공백은 SELF_HOST §5.
- **교훈**: ①planner의 레이아웃 규칙도 부작용을 낳는다(R5 규칙 3 → 컨트롤이 `--accent-soft` 위, R5 `minmax` 바닥은 산술상 dead) — 규칙은 「측정 열」과 함께 적고 사보타주가 실제로 붉어지는지까지 리뷰어가 잰다 ②감사 랜딩 템플릿: CONFLICTING이면 감사 전에 ABORT, 검증기는 4×30s 재시도(라벨 재부착 뒤 평가기 provenance 지연), 병합은 planner가 STATUS 합집합으로 ③발사기 셸 함정: `pipefail`+`grep -q`(SIGPIPE), 워커 0일 때 `pgrep` exit 1 + `set -e` ④체인 템플릿의 낡은 echo(「#2142 closed」)는 오독을 부른다 — 자리표시자로.
- **잔여 후보(미발급)**: R7-N4 core `parseDisconnectStart` 상태 재기록 가드 · 프리플라이트 `arbitrary_tw` 사각(`[minmax`·다중행 `cn()`) · #1361 라벨 blocked→ready(승인 대기) · Railway E2E(최종 단계) · APNs 실기기(데스크톱 뒤).

## 2026-09-08 (오전·재개) · Fable · ★안전 중단 플러시 + 재개 — SH-6a-w R3 FAIL → R4 가동, Railway 실배포는 G1'-4 시점으로

- 09-08 새벽 진행분(중단 시 미플러시): **SH-5a 템플릿 main `03e90c4c`**(#2210·승격 #2211; 실배포 E2E 미실행 — `RAILWAY_TOKEN` 부재, #2205 open) · **G1'-2 패킷 main `bbb00168`**(#2217·승격 #2218: SH-6a-e #2215·UX-R2c #2216·#1265 브리프, 지도 갱신) · **SH-6a-w #2214**: design-review R1 FAIL(H4·M5·N5, 브리프 결함 H-3 포함) → R2 수리 → R2 FAIL(B1·H3·M3·N5, 수리 회귀: 해제 대상 불일치) → R3 수리 → **R3 FAIL(B1·H1·M2·N5)**: R2 12건 CLOSED, R1 H-4 재발(한 줄 레이아웃 flex — 390px 이름 폭 0~3px), 터미널 행 도어벨 착지 결함. 성재 지시로 안전 중단(PR·머지 없이).
- 재개: 정렬 초록 · **R4 워커 가동**(`--continue`, 390 flex 우선순위·터미널 행 도어벨·가드 범위·jsdom 단정) → R4 검수(회귀 우선) → 랜딩 → UX-R2c 발사. G1'-2 엔진 쌍(SH-6a-e ∥ #1265)은 go 대기.
- 성재 질문 「Railway 실배포는 왜 필요한가」 → 답: Dawn 운영 서버 아님, **케이스 B 클라우드 설치 경로의 1회 실증**(G2 「Railway 1」 전제). 필요 시점 = G1'-4(E2E-B). 그 전까지 VPS/로컬 경로로 대체 가능 → 다음 작업으로 미룸. 새벽 회수가 커밋 없는 워크트리 2개(`wsh6ae`·`w1265`) 삭제(손실 0) — 런처 자가 복구.
- 교훈: ①수리가 수리를 부르는 사슬 3회전 — R4 미션에 「1280/900 무변화·390은 min-w-0 + 축약」을 수치로 ②브리프의 좌표(플래그명·티켓 id)는 화면 글자가 아님 ③design-review의 「회귀 우선」이 B-1·H-4 재발을 잡았다 — 상설 유지.

## 2026-09-08 (새벽) · Fable · ★G1'-1 진행(SH-5a 템플릿 정본화 · SH-6a-w R2 검수 중) + G1'-2 패킷 3본

- go → G1'-1 발사. **SH-5a #2205**: 워커 완주(커밋 7: `infra/railway/`(서비스 6·Caddy 엣지·Centrifugo env·PG 플러그인), 생성기 `--railway`(키 41 정본 파생), `Caddyfile.railway`+공개 엣지 계약 픽스처 확장, §3.4 실절차, doctor Railway fail-closed) → planner 검토(gitleaks 지문 2 = 사설 URL 오탐 확인, 시험 7/7) → 감사 랜딩·승격 ao → main `03e90c4c`. 실배포 E2E는 `railway login` 대기(#2205 open). 체인 결함 1: BODY의 `'`(G1'-1) → 문법 오류 → 승격부터 재개(교훈: 체인 BODY에 아포스트로피 금지).
- **SH-6a-w #2204**: 워커 완주(PR #2214, 커밋 10) → planner 범위 수용 → design-review R1 **FAIL B0·H4·M5·N5**(선택 행=hover 토큰 · 오프라인 잠금 aria 미설명 · 안내 문장이 없는 스위치·티켓 id — **planner 브리프 결함** · 390 절단) → R2 수리(행 선택 `--accent-soft`·이름 붙은 액션·`dl` 사실·`lockReason` 패턴·제품 어휘 카피·서버 원문 보존·캡처 4장면·렌더 시험) → design-review R2 진행 중.
- G1'-2 패킷: **SH-6a-e #2215**(로컬 provider opt-in — 실측: `validated_base_url`이 staging에서 플래그 무효 → ADR-0004 증보 필수) · **UX-R2c #2216**(첫 에이전트 연결 퍼널) · **#1265**(웹훅 인바운드) 브리프. 교훈: 브리프의 좌표(플래그명·티켓 id)는 화면 글자가 아님을 명시. 발사는 SH-6a-w 랜딩 뒤 go.

## 2026-09-08 · Fable · ★결재: 실기기 APNs 보류(2) · 출시 정의 개정 확정(1) · G1'-1 브리프(3) + 남은 작업 지도

- 성재: 「2번은 다음 진행으로, 1번·3번 중심으로 진행. 남은 작업도 파악」 → `2026-09-02-launch-program-plan.md` 상단 **개정 상자**(G1' = 두 케이스 E2E, G2 += iOS 앱스토어 v0, 파도 확정, 연기 목록) · `first-goal-two-cases.md` §7 확인·§8 · **`2026-09-08-remaining-work-map.md`**(G1'까지 파도 표 · G2 축 · 선재/위생 · 연기 · 이슈 위생 후속).
- 발급: **SH-6a-w #2204**(uxui, 설정 › 연결 › 에이전트 자격 — 기존 hosted 연결 라우트·위저드 재사용, 새 API 없음) · **SH-5a #2205**(engine, Railway 템플릿 — 같은 이미지 서비스 4 + PG 플러그인 + Centrifugo env + Caddy 서비스, 생성기 `--railway`, 계정 의존). 패킷 2본. 워크트리 `wsh6a`(uxui)·`wsh5a`(engine). 발사는 go.
- 미발급(지도 §1): UX-R2c · #1265 · SH-6a-e · SH-8 · SH-9 · E2E-A/B · ITO. iOS v0는 G1' 뒤(§2).

## 2026-09-07 (밤·종결) · Fable · ★LS 시리즈 완결(LS-0~6) + SH-10 push relay Rust main 정본화 — 스냅샷 93

- **LS-γ 랜딩**: **SH-10 #1255**(PR #2192 커밋 6 + planner 위생 1: GHCR 고지 번들 재생성 — 새 crate 의존 fnv·h2) → 승격 al → main `5c670e98`. momo-push-relay Rust(같은 이미지 `push-relay`, 정적 레지스트리, raw-body Ed25519, id-only 봉투, live/stub, 401/400/429가 notifier 분류기와 정합, stub E2E `push_dispatch_log` 200, 런북 3 모드). **LS-3 #2182**(PR #2191 R1 10 + R2 링크 19 정정) → 승격 ak → main `47f4d6f0`: 은퇴 문서 24 삭제(RUN·DEPLOY·BACKLOG·…·G3 문서·Codex 잔재·ncp 런북), 회전 절 SELF_HOST 이식+계약 게이트 재지정, INDEX/README D1 재작성, 살아 있는 md 링크 0 깨짐.
- **경량화 최종**(main `47f4d6f0` vs 진단 시점 `f399e417`): 추적 파일 **3,416 → 2,491(−27%)** · 코드 LOC ≈768k → 624k(−19%) · md 107k → 67k(−38%) · `.swift` 224→7 · scripts 265→151 · docs 663→364(루트 34→18) · handoffs 302→80 · research 112→36 · CI 레인 5→4. LS-5 17 close · LS-6 원장 #2187.
- 선재 이슈: #2157(pgbackrest 시험) · #2181(gate:csp-deploy 템플릿) · #2193(momo_notifier 롤). 교훈: 정책 파일 변경은 track·승격·sync 셋 다 감사(자동화) · GHCR 매니페스트가 NOTICE 해시 고정 · Rust 의존 추가 시 고지 번들 재생성 · 체인 update-branch 뒤 로컬은 pull --no-rebase.
- 다음: §7(G2에 iOS 앱스토어 v0) 성재 확인 → 출시 계획 개정 → G1' 파도(SH-6a ∥ SH-5a 브리프) · 실기기 APNs 실수신(`checklist-apns-real-device.md`, 성재 iPhone).

## 2026-09-07 (재개·밤3) · Fable · ★LS-β 완결(LS-1·LS-2 main 정본화) + LS-5 이슈 위생 + LS-γ 패킷(LS-3 #2182 · SH-10 #1255) — 스냅샷 92

- **LS-1 랜딩**(PR #2177 R1 8 + R2 2; 정정 1회 PushRelay): Swift 4트리·infra/prod·Swift e2e·eve·workd·codex-workbench·examples 삭제(313), `.swift` 224→8(RN 셸), Swift e2e 전제 verifier 19 삭제·재조준, 부록 A 실측(Swift 169 vs Rust 183, Swift-only 패밀리 전부 폐기), LinkShort 대체 없이 삭제 → 감사 랜딩·승격 ai·sync 감사 → main. R2 발견 선재 **#2181**(gate:csp-deploy가 SH-2 템플릿에서 빨강).
- **LS-2 랜딩**(PR #2175): clients 1250→1136, work 표면 4 id 셀프호스트 기본 숨김(진입점 0/5), Case 6 라이선스 시험 정합, NOTICE 2본은 GHCR 매니페스트 해시 고정으로 base 유지 → 승격 ah → main. dependabot web-legacy 3건 close.
- **LS-5**: `area:ios`·`area:macos` 29건 판정 — Swift 시대 17건 close(superseded/은퇴), iOS 앱스토어 v0 요건·RN 패리티 10건 유지(#20·#21·#22·#30·#31 등).
- **경량화 누계**: 추적 파일 3,416 → **2,502**(−914, 27%) · scripts 265→149 · `.swift` 224→8 · handoffs 302→76 · research 112→36 · CI 레인 5→4. 남은 LS: **LS-3 #2182**(은퇴 문서·INDEX·Codex·G3·ncp 런북 회전 절 이식, 감사) — 패킷 발급. **SH-10 #1255**(momo-push-relay Rust, 셀프호스트 동봉 3 모드) 패킷 발급 → LS-γ = LS-3 ∥ SH-10(병렬 2), 발사는 go.
- 열린 결재(성재): G2에 iOS 앱스토어 v0 포함(§7). 교훈: ①정책 파일 변경은 track·승격·sync PR 셋 다 감사(자동화됨) ②GHCR 고지 매니페스트가 NOTICE 해시를 고정 — 문구 정리 금지 ③수동 게이트(gate:csp-deploy)는 배선이 없으면 드리프트가 안 보인다(#2181 배선 결정).

## 2026-09-07 (밤2) · Fable · ★안전 중단 — LS-2 main 정본화 · LS-1 PR #2177 R2 대기 · 재개 절차 고정

- **LS-2 랜딩**(PR #2175 R1 6 + R2 2 + planner 위생 1: NOTICE·THIRD_PARTY는 GHCR 고지 매니페스트 해시 고정이라 base 바이트 유지) → 감사(AGENTS 1행·test_license_gate Case 6) → track/uxui → #2166·dependabot #1355~1357 close → 승격 ah #2176 → main → sync engine #2178(자동 감사)·uxui #2179. 결과: clients 1250→1136, work 표면 4 id 셀프호스트 기본 숨김(진입점 0/5).
- **LS-1 R1 완주**(PR #2177, 커밋 8, 정정 1회: PushRelay 소스만 삭제·계약 보존): 삭제 313, `.swift` 224→8(RN 셸), 추적 2,929→2,616, 부록 A 실측(Swift 169 vs Rust 183, Swift-only 패밀리 전부 폐기), LinkShort 대체 없이 삭제. planner 검토 수용 + **R2 2건 대기**(engine 합류·AGENTS/INDEX 충돌 해소 / `gate-csp-deploy.mjs`의 삭제된 `infra/prod/Caddyfile` 대상 → `infra/rust/Caddyfile.local`). 랜딩은 감사 체인(`audit-ls1.md` 초안).
- 재개 절차: `claudedocs/resume-2026-09-07/RESUME.md` 「★ 재개 첫 행동」. 열린 결재: G2에 iOS 앱스토어 v0 포함(§7).

## 2026-09-07 (밤) · Fable · ★결재 3건 — 푸시 relay Rust 승격(SH-10) · CDP 로컬 허용 · iOS 앱스토어 의도 + LS-β 발사

- go → `launch-ls-beta.sh`: LS-1 #2165(`wls1`)·LS-2 #2166(`wls2`) 발사. LS-1은 PushRelay 결재 반영을 위해 1회 중단·정정 재개(`mission-ls1-b.md`: Swift relay 소스만 삭제, push 컴포즈·env·런북·검증기 보존).
- 성재: 「셀프호스팅 레벨에서 모바일 알림 포함, iOS만 앱스토어 출시, Rust 기반이면 좋다」 → ADR-0183 결재 기록 2(결정 ① 정정) · #1255 = SH-10 재정의 · `first-goal-two-cases.md` §4 G1'-2 승격 + §7. 「계정 살아 있음, 로컬 테스트는 CDP 정책 위반 아님」 → CDP 로컬 허용, E2E-A 자동화. 메모리 갱신.
- 열린 것(성재): G2에 iOS 앱스토어 v0 포함 개정(§7) 확인.

## 2026-09-07 (저녁) · Fable · ★LS-α 완결 — LS-4(#2143)·LS-0(#2142) main 정본화, LS-β(LS-1 #2165·LS-2 #2166) 패킷 발급

- **LS-4 랜딩**(PR #2152 R1 커밋 10 → planner 검토: 정본·코드 인용 16본 삭제 miss → R2 복원+규칙 확장(살아 있는 정본·코드 참조면 보존, 경로 인식) → miss 0) → 승격 ad #2153 → main `e1975ce9`. 결과: handoffs 302→76 · planning 루트 70→51 · planning/research 112→78 · `research/` 112→36 · claudedocs 39→0(+gitignore) · docs/archive 해체 · STATUS 2026-08 761줄 로테이션 · D6 규칙 README §2.
- **LS-0 랜딩**(PR #2154 R1 8 + R2 3: 정지 3건 판정 — 문서 명령 게이트=브리프 범위 결함(AGENTS 2행·aws 런북 삭제·worktree_janitor 복원·ncp 런북은 계약 게이트 의존으로 유지) · web 82 빨강=로그인 셸 PATH(node 26) → `run_cmd` 호출자 PATH 재적용 · pgbackrest 선재 #2157) → 정책 감사(track PR·승격 #2158·**sync #2159까지 셋 다** 필요 — 정책 파일 변경 시 sync도 감사, promote-lib 반영) → main `6ed61cfb`. 결과: scripts 265→168 · `add_swift_commands` 0 · CI 레인 5→4 · web 프로파일=clients/web(2807/2807) · SQL 4본 `infra/rust/sql/` · SH 시험 4본 docs 프로파일 편입.
- 발급: **LS-1 #2165**(`handoffs/2026-09-07-ls1-swift-retire-brief.md`, engine, 감사) · **LS-2 #2166**(`handoffs/2026-09-07-ls2-client-dual-canon-brief.md`, uxui, work 표면 숨김 포함). 워크트리 `wls1`·`wls2`. 발사는 go.
- 추적 파일 3,416 → 2,927(−489). 다음: go → LS-1 ∥ LS-2 → LS-3 → 스냅샷 92·출시 계획 개정 → G1'.

## 2026-09-07 (오후2) · Fable · ★go → LS-0·LS-4 발사(병렬 2) + 1차 목표 두 케이스 구체화·결정 3건

- go(성재) → `launch-ls.sh`: LS-0 #2142(`wls0`)·LS-4 #2143(`wls4`) grok 워커 2기 세션 분리 발사(프리플라이트: 패킷·ADR Accepted origin/main 확인).
- 성재 지시: 「케이스 두 개 — ①그록봇 VM 안 설치·그록봇 중심 연동 ②독립 셀프호스팅 + 본인 hermes·별도 에이전트 연동 — 둘 다 커버. 1차 목표 구체화, 애매한 점은 지금 결정」 → `docs/planning/2026-09-07-first-goal-two-cases.md`: 매트릭스(설치 주체·호스트·엣지·합류 경로·영속·약관) · E2E 2본 수용기준 · 갭 8(A-1 §3.3 dial-in 합류 절 부재 · A-2 #1361 · A-3 Reset 복구 실측 0 · B-1 Railway · B-2 SH-6a · B-3 R2c · B-4 hermes 플러그인 문서 Swift 전제 · B-5 외부 호스트 upgrade 0회) · **G1' 편성 확정**(SH-6a∥SH-5a → #1265∥UX-R2c → SH-8∥SH-9 → E2E-B∥E2E-A → ITO; 팔레트·DS-1·R2d·허들·TURN 연기) · 결정 3(재편성 확정 · work 표면 숨김=LS-2 · G3 문서 삭제=LS-3, external-agent-provider 삭제 금지).
- 다음: 워커 감시(rc 파일) → LS-0 planner 검토·정책 감사 승격 → LS-1·LS-2 패킷(§5 반영) 발급.
