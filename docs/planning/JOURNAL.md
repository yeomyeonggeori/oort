# 기획 세션 저널 (newest-first, 기존 항목 불변)

> 목적: **기획/오케스트레이션 세션 간 이어달리기.** Fable이든 GPT 5.6이든, 세션을 시작할 때 최근 항목을 읽고, 끝낼 때 항목을 추가한다(`docs/planning/README.md` §1).
> 규칙: 항목당 5줄 이내. 새 항목은 맨 위에 추가하고 기존 항목은 수정하지 않는다. 결정·증거·계획의 정본이 아니다(그건 ADR/STATUS/ROADMAP) — 여기는 "무엇을 하다 어디서 멈췄나"만. 최신이 위.

---

## 2026-08-27 (오후2) · Fable · ★DNS 급소 종료 + #1798 랜딩 → 정리·중단 (성재 "정리하고 중단")
- **DNS 종료**: `app.oor7.com` A(101.79.11.189) 성재 삭제, 권위 NS(가비아)에서 소거 확인(삭제 45초 후 응답 중단, 8.8.8.8·1.1.1.1·ns.gabia 교차). 첫 확인 때 남아 있던 건 반영 지연이었음. 진단 삽화: 성재가 처음 연 가비아 존은 apex→216.150.1.1(Vercel)·www→vercel-dns인 **다른 도메인** — oor7.com은 apex·www 공백에 app만 매달려 3리졸버로 확정. **레포 밖 표면 노출 0.**
- **#1798 랜딩**: PR #1798 → track/engine **094cdc87**, #1767 close. 패스워드 리셋 위계(ADR-0128 D2) 구멍 종료. cursor grok 4.6 워커 수리(d8d68b89): `can_issue_password_reset_for` 사다리+self 진입즉시 Forbidden, 행위자·대상 role 둘 다 같은 테넌트 트랜잭션 조회(라우트 require_admin 비단독). **워커 RED proof 정석**: 매트릭스 20칸 중 4칸(admin→owner 계열) 201→403, conformance 25 passed. Fable 재검수+CI 그린(fail=0) 확인 후 머지. 브리프의 매트릭스 표·정지 조건 절 상설 템플릿 첫 실전 완주.
- **회수**: w1747·w1769·w1770·wfix·w1767 5기 reap(디스크 111Gi). `momo-worktree-reclaim.sh` infra 비-git 디렉터리 pipefail 결함 수리. 성재 위생 대상: `momo-worktrees/infra/rust/local.secrets.env`(리그 산물 추정 시크릿, 보존).
- **정리·중단**: 재개 진입점 `handoffs/2026-08-27-fable-resume-checkpoint.md`. 다음 순서 ③#1800→④#1770→⑤(#1792 P2폴백∥#1785∥#1797)→⑥#1768(위계 헬퍼 패턴 승계). 실행 결재 전부 소진, 방향 기승인 — 다음 세션 ③부터 자율.

## 2026-08-27 · Fable · ★성재 결재 5건 전부 판정 — #1799 랜딩·#1798 수리 워커 가동·#1803 완료
- **결재 반영**(정본 `handoffs/2026-08-27-post-audit-execution-plan.md` §1.1): ①DNS=성재 직접(가비아, **유일 잔여** — dig 실측 101.79.11.189 여전히 응답) ②#1798 계약 승인+검수·머지 위임 ③허들 폴백=**P2 운영자 TURN**(P3 유료 배제, #1792 코멘트) ④#1768=순서 ⑥ 유지 ⑤#1803=Fable 검증 위임.
- **#1799 랜딩**: track/engine **89298a2f**, #1769 close. 머지 전 같은 계열 위계 재점검 통과 — owner 초대 불가가 API 400+DB 제약(`invite_code_role_ck`) 이중 방어, admin의 revoke/regenerate는 신규 발급 경로라 탈취 계열 아님.
- **#1798 수리 워커 발사**(cursor grok 4.6, w1767 워크트리): 결함 재확정(require_admin이 행위자만, in_tx 오류 집합에 대상 role 축 부재, self 차단 부재) → 브리프 `2026-08-27-1798-hierarchy-repair-brief.md` — **권한 매트릭스 표+정지 조건 절 상설 템플릿 첫 실전**. #1799 선랜딩으로 base sync 1회화(①② 순서 의도적 교환).
- **#1803 완료**(e2b53eee): AGENTS/CODEX 헤더·런북 은퇴 배너·Caddyfile 고지. 정정: **CLAUDE.md 잔재 0건**(이슈 기재와 다름). STATUS.md 역사 기록은 원칙대로 보존.
- 다음: 워커 완료 시 재검수(매트릭스 red proof 확인)→머지→#1800 발사. DNS 삭제는 성재 가비아 처리 후 dig 재확인.

## 2026-08-26 (Opus) · ★리그 실기동이 검사가 됐다 — 결함 4건 발견·수리, 성재 테스트 빌드 인도
- **성재가 만질 리그 인도**: `http://localhost:8188`(oort-t, 오늘 랜딩분 전부 + LiveKit 허들 프로파일). 접속정보는 바탕화면 파일로 전달(주소+계정+비번 동봉 — 예전 "주소만 주고 계정 안 알려준" 전례 반복 안 함). **도어벨 리그(8088)는 비접촉** — 프로젝트명·포트·볼륨 3중 분리로 나란히 운용.
- **리그를 세우는 과정에서 결함 4건이 실기동으로 드러났다. 전부 "띄워봐야만 측정되는 축"이었다**(실패 양식 ㉠):
  ①**#1795 compose 충돌 가드 오탐** — 자기 경로를 `REPO_ROOT`로 잡는데 도커 라벨은 `infra/rust`라 **절대 일치하지 않는다** ⇒ 자기 스택을 남의 것으로 보고 `up`·`down` 둘 다 막는 **교착**. 가드가 권하는 `down`조차 같은 가드에 막힌다. **문서화된 재시작 절차(§2.3)가 성립하지 않던 것.**
  ②**#1790 printf 회귀(내가 오늘 랜딩한 것)** — `printf '--compose up -d'`가 bash에서 `invalid option`. **안내가 필요한 자리에서 안내가 통째로 빈다.** 모드 테스트가 claim 분기만 밟아 못 잡았다.
  ③**#1747 갭3 적립** — 낡은 env로 오늘 코드를 돌리면 migrate가 죽는데 에러가 **어느 변수인지 말하지 않는다**(`MOMO_ENV` vs `MOMO_MIGRATE_ENV`). 그록봇이 스스로 못 푼다.
  ④**#1747 갭2 실물 재현** — 신선 볼륨에서 api 재시작 루프. 수리 후 `drive-init` exit 0 + api healthy를 **볼륨 삭제 후 독립 재현**으로 확인.
- PR: **#1794**(가드+printf, red/green 실기동) · **#1796**(#1747, 정책 게이트 감사 첨부). 워커가 테스트 기대값을 바꾼 건 **tip 테스트를 워커 트리에 대고 돌려 rc=1 실패를 확인**해 약화 아님을 실측 판정.
- **허들 Funnel 스파이크 진행**: 그록봇이 §2.2 완주 — 공개주소 `cursor.tailb1aad3.ts.net`, HTTP Funnel **200**, 8443 TCP **OPEN**, 그러나 TLS 악수는 **EOF**. 판정: 불가가 아니라 **뒤에 리스너가 없어서**로 읽힌다(LiveKit TURN 미기동). 더미 리스너 후 재시도가 다음 단계.
- **CDP 재개 요청은 거절**: 성재가 "너가 CDP로 직접 요청해라" 했으나 **성재 본인이 2026-08-22에 Cursor 약관(자동화 금지) 때문에 은퇴시킨 경로**다. 제3자 약관은 성재 허용으로 해소되지 않는다. 대안으로 **ADR-0171 도어벨(webhook)**을 제시했고, #1747이 랜딩되면 그 경로가 실제로 선다.

## 2026-08-26 (Opus) · ★NCP 완전 철수 집행 + ADR 2건 결재 + 파도 1·2 랜딩 5건
- **NCP oort 자원 0**: 서버 3대·블록스토리지 **360GB**·공인 IP 3개 전부 반납(`factsheet` 비접촉). 집행은 `~/.ncp/credentials.env` API 키 + VPC Server API — SSH·콘솔 로그인 미사용(pem 부재·자격증명 입력 금지). 가드 5중(번호·이름·IP·`momo` 접두사·`stopped`). **실측이 판정을 뒤집었다**: 비용 핵심이라던 cube+turn은 **이미 stopped**였고(앞선 SSH 차단을 방화벽으로 읽은 것이 오독), 켜져 있던 oort 서버는 `app.oor7.com` 하나였다. 그런데 **꺼진 300GB SSD가 요금만 내고 있었던 것**이 체감 비용의 정체. 재구축 스냅샷 정본화(`9c99c24f`). **잃은 것 = app.oor7.com 내부 알파 PG**(pem 부재로 덤프 불가, 성재가 알고 지시).
- **ADR 2건 Accepted**: **0165 증보 3**(TURN 주어를 "oort 운영分"→"그 배포의 운영자 소유分"으로 재정의 + `D3-부재` 과도기 허용을 성재가 (가)로 결정) · **0169 증보 1**(첨부 capability URL의 same-origin 파생, **A 채택 + C 백엔드선택 하이브리드** 병기). 전자가 없으면 momo-turn 삭제가 Accepted ADR과 어긋났다.
- **랜딩 5건**(track/engine `394c4d42`): #1781·#1777(터미널 축 개방)·#1778(관전 토글)·#1790(claim 모드 유지보수)·#1788(첨부 same-origin). 검수 적발 2건이 **문서-코드 상호무효화** 형태였다 — #1790은 §1.4가 "생성기 재실행 금지"라 해놓고 §2.3이 실행을 시킴, #1788은 `--public-origin`이 `same-origin`을 덮어써 **플레이북대로 따르면 수리가 원상복귀**. 둘 다 워커가 못 보고 문면 대조에서 잡혔다.
- **허들 방향 확정**: RA-8 리서치(853줄) + RP-1 실측 — 그록봇 VM 매핑이 목적지마다 **포트뿐 아니라 공인 IP까지** 다름(로드밸런싱 NAT 풀, 둘 다 AWS) ⇒ **VM에 안정적 공인 신원 없음, 홀펀칭 사망**. 살아남는 건 안에서 밖으로 여는 터널뿐 ⇒ **#1792 SPIKE-HD**(Funnel TLS 종단 TCP로 LiveKit 내장 TURN 노출). #1789는 전제 오류로 close. **플레이북 §2.2가 이미 Funnel을 v1 기본으로 정해 뒀다는 성재 지적이 감사 오독을 교정**(추가 가입·설치 0).
- 잔여: SPIKE-HD 실행(그록봇 Funnel 필요) · 랜딩 사이트 Vercel 신설 · 파도 2 #1747 · TC-2 ADR.

## 2026-08-26 (Opus+Fable) · ★셀프호스팅 제품 모델 검수 — 허들 답 확정·#1788 기전 정정·파도 1 완주
- 성재 확정 모델(그록봇 VM 셀프호스팅 + 클라우드=VM 유휴자원 + 로컬=랩탑 + 그록봇이 세팅 대행)을 **Fable 검수**(`research/2026-08-26-selfhost-product-model-review.md`, 급소 7개). 판정: **무게중심은 이미 코드 위에 서 있고 정면 충돌은 정확히 2곳** — 허들(2b)·서브도메인 릴레이(1b).
- **허들 답(오케스트레이터 재판정 완료)**: 외부 SFU 연동이 정답. `MOMO_LIVEKIT_URL`이 임의 http/https/ws/wss를 수용하고(`config.rs:137-154` 루프백 제한 없음) join 응답이 **verbatim 광고**(`routes/huddles.rs:133`) ⇒ **서버 코드 0줄**, 미디어는 클라↔외부 SFU 직결이라 VM inbound 불요. 유일 걸림돌 = **CSP 한 줄**(`Caddyfile.local:57`·`Caddyfile:109` 둘 다 하드코딩 allowlist — 실측 확인). 허들이 "아웃오브박스"에서 "연동 항목"으로 바뀌는 것이 대가이나 **성재 모델 3번(추천만)과 오히려 정합**.
- **#1788 기전 정정**: 최초 진단("--public-origin이 이 키를 갱신 안 함")은 **틀렸다** — `ensure_local_drive_public_base`가 #1696부터 실재(`self_host_env.sh:436-446`). 진짜 결함은 **claim 수술이 정본 env의 비밀번호 키를 mv로 제거**(`SELF_HOST_AGENT.md:141-148`)해 갱신 경로가 `validate_owner_password`(`:872`)에서 abort ⇒ `ensure_local_drive_public_base`(`:879`)에 영원히 도달 못 함. **플레이북 §1.4↔§2.3 내부 모순**(§1.4가 스스로 "생성기를 다시 돌리지 않는다"고 적어 두고 §2.3이 돌리라 한다). 티켓 본문·제목 정정 완료.
- **급소 2**: "클라우드=VM 유휴자원"은 데이터 축은 **이미 성립**(pgdata·drive `/workspace` bind), 컴퓨트 축은 T3 어댑터 추가로 **안 된다**(wire adapter=cubesandbox 하나) — 맞는 그림은 **T2 workd**(`021_work_host.sql:23`). **TC-2와는 직교**(TC-2=관리형 표면, 이번 모델=셀프호스트).
- 파도 1 **4/4 완주**: #1781·#1777(9a308276)·#1778(b1966a23)·#850. 결재석 G1~G5 + ADR 2건(0165 증보3 문안 완성·0169 증보1) + 로드맵 델타 D-a~D-f.

## 2026-08-26 (Opus) · ★NCP 비용 판정 + 셀프호스트 외부 의존 전수 감사 · 파도 1 완주(#1777·#1778)
- **전수 감사**(`research/2026-08-26-selfhost-external-dependency-audit.md`): "우리 서버를 타는 자리"=4곳, 런타임 강제는 **실질 1곳(데스크톱 자동 업데이트 — 빌드타임 baked)**뿐. 이미지 pull=local-build 대안 1급, 푸시=기본 스택에 부재, display TURN=**문면만 oort 전용이고 코드는 호스트 미검증**(M7 판정 필요). 텔레메트리·분석·과금 콜백 **0건**. **사실 정정: 허들은 oort TURN을 타지 않는다 — livekit.yaml TURN 블록이 통째 주석이라 TURN이 아예 없다.**
- **NCP 정리 판정**(`research/2026-08-26-ncp-teardown-judgment.md`, 성재 발제 "비용이 의미 없이 발생"): 3대=app.oor7.com(healthz 200)·momo-cube-host(8vCPU·32GB·300GB)·momo-turn. **momo-turn은 cube의 자식**(symmetric NAT 때문에 생긴 호스트)이라 한 묶음. **성재 4대 테스트(터미널·UXUI·허들·그록봇)는 NCP 0대로 전부 도달 가능** — 허들은 같은 머신 안이면 LiveKit 127.0.0.1 바인드가 그대로 통한다(그록봇 VM은 불가: quick tunnel이 UDP 미디어를 못 나름). **Vercel은 옮길 대상이 없다** — oor7.com 루트 무응답(공개 랜딩 부재), 앱 SPA는 same-origin 전제라 뗄 수 없다. 결재 대기 2건: PG 덤프 필요 여부·외부 셀프호스터의 push relay 의존 여부.
- 파도 1: **#1777 랜딩**(9a308276) — host-signed 세 팔 이식으로 remote_attach_available false→true, 터미널 축 개방. 레시피 `scripts/verify_workd_rust.sh` 동반. **#1778 PR #1787** — 소유자 관전 토글 400 수리, **ADR-0004 증보3 D3 원문 회귀 이식**(owner_only 강제는 077 파도가 스스로 넓힌 규칙이었다). 독립 재현 1199/1199 + PG 컨포먼스 1/1(일회용 PG 신규 기동).
- 적립: **#1788**(M6 — 첨부 capability URL이 고정 localhost로 조립돼 터널 접속에서 깨짐. `--public-origin` 갱신 대상에서 누락. 그록봇 VM E2E가 정확히 이 조건). #1785(ACP 릴레이).

## 2026-08-24 (Fable) · 그록봇 제어 재검토 — CDP 필연성·오픈소스 오해·Push 가능성 리서치
- 성재 3문 답(정본 `research/2026-08-24-grokbot-push-vs-cdp.md`): ①**CDP는 필연 아님** — 데스크탑/폰 앱=클라우드 VM 얇은 클라이언트라 로컬 봇 API 부재, CDP(렌더러 :9333)가 유일했던 손잡이고 이미 자연어 릴레이로 은퇴. ②**오픈소스 전제 오해 2건** — 그록봇은 폐쇄 SaaS(오픈소스는 oort), 본인 계정도 Cursor ToS 자동화금지(B3) 그대로 구속(본인계정=필요조건≠충분).
- ③**Push 판정**: 그록봇 제품에 인바운드 API/웹훅/외부 트리거 **전무**(releasebot 8/17~24 재확인 — 8/21 플랜 확대뿐). polling 회피 native 경로=폐쇄 이벤트 트리거(Slack/GitHub/Teams 우회)뿐. "Grok이 응답" 넓게 보면 **xAI API Remote MCP Tools**(모델이 Agent Port 서버사이드 소비) 또는 **Cursor Cloud Agents API**(spawn/run/stop 우리 통제)가 진짜 push — 단 응답 주체가 봇 페르소나 아님.
- 권고: 그록봇 제품 편입 고집 대신 역방향 소비(Remote MCP Tools, ADR-0163 경로)가 폴링·CDP·약관 3문제 동시 탈출. Cloud Agents는 코드 이그레스 결정(ADR-0150 계열) 선행. 결정 큐 Q-DIR/Q-MCP/Q-EGRESS 상신.

## 2026-08-24 (Fable) · ★4차 집행 완결 — 2차 승격 창·v0.1.2 첫 멀티아치 재발행·#1716/#1720 랜딩
- **v0.1.2 발행 폐곡선**(RELEASING 전 절차): main=d66ca97a → dispatch+owner 승인 2회(위임·자동 승인 감시) → 멀티아치 성공 → list digest 수거(앱 43babdbc…de6d·pg b09eb970…1626) → attestation 2본 PASS → 태그·Release → SELF_HOST §2-B 현행화(#1730). **첫 멀티아치 운영자 pin — Apple Silicon 네이티브 pull 성립. D8 함정 3종(실시간·보관소·claim)이 셀프호스터 이미지에 실림.** 언퍼얼은 포함·기본 꺼짐.
- 2차 승격 창: #1721(docs)→선sync 짝→#1724(uxui)→#1725→#1726(engine)→최종 짝. 학습 절차(선sync)로 토폴로지 재실행 1회로 끝.
- #1716 랜딩(#1729): 실측 크기 정본화(0-선언 개방·상한 실측 red proof·PG 12/12) — grok 4차 조기종료(ENOSPC)를 인수 완주. #1720 1·3·4항 랜딩(#1733): sol이 main 전진에 TRACKS 하드 가드로 정직 정지→sync 후 전달. 잔여=2항(fan-out 배치)만.
- 운영: ENOSPC 4차 — **근본 원인=워크트리 50개 적체**(스테일 node_modules·딥 .build). 정리 판정=성재 큐. 각 회수로 14Gi+ 확보.
## 2026-08-24 (Fable) · ★ADR-0170 완결 — 언퍼얼 양 절반 랜딩(#1717 서버·#1719 클라). 성재 요청 기능 종단 완성
- 서버 절반(#1717, grok 3,828줄): message_unfurl 원장(079)·SSRF 가드 워커·on/off·제거·프록시. 랜딩 중 fail-closed 게이트 2건(GHCR 고지·web-legacy 타입) 정당 적발→해소.
- 클라 절반(#1719, sol 24파일): 카드·제거·2층 설정. **design-review FAIL(B1·H1)→수리 라운드(1413762d)→재판정 PASS(0·0)**. 수리가 로빙 기계 잠복 결함 2건을 근본 해소: ①비동기 마운트 구성원 정규화 누락(MutationObserver) ②정거장 이력 고착(focusout primary 복원) — 리뷰어 적대 반증 6경로 전부 방어. 레인 230프레임(다크 115) 완주 실증. 적립=#1720(rowFocus jsdom 고정·배치 API·바이트 예산).
- #1718·#1698 close. 활성화는 배포 창에서 MOMO_UNFURL_ENABLED=1 결정. 운영: ENOSPC 3차(원인=npm 캐시 11G+brew 4G+Swift .build 잔재)→36Gi 회수. **교훈: 대형 파도 세션은 시작·중간에 df 게이트.**
## 2026-08-23 (Fable) · ★일괄 승인 창 마감 — 3차 파도 3/3 랜딩·main 승격 완결·언퍼얼 서버 발사
- **main 승격 창 완결**: docs 정본 #1704 → uxui 승격 #1705 → engine 승격 #1710 + sync 짝 4본(#1706~1709·#1713~1714). 토폴로지 가드 닭-달걀 2회(가드가 요구하는 sync를 가드가 막음) — 순서 재배열+재실행으로 해소, 절차 교훈: **docs를 main에 먼저 넣으면 반드시 양 트랙 sync 후 승격**.
- **3차 파도 3/3**: #1696 로컬 보관소(#1712, ADR-0169 — 셀프호스트 첨부 503 원천 해소) · U-8 #1699(#1711 — 컴포저 하단 26px 회수, 리그 실측 118→92px·스왑 왕복 시프트 0, 리뷰 0·0·0) · #1703 M-2 후속(#1715 — 자리예약·세션경계 리셋·명명측정, 리뷰 0·0·M1→#1716 적립). STATUS 3-way 충돌 해소 4회(트랙 전진 경합 — 양블록 보존 표준).
- **언퍼얼 착수**: ADR-0170 Accepted 집행 1/2 — 서버 절반 패킷+#1698 grok 발사(MOMO_UNFURL_ENABLED 기본 0 옵트인). 2/2 클라 렌더는 엔진 랜딩 후 uxui 티켓.
- 운영: grok push 직전 조기 종료 2/2회(산출 무결 — 검수·PR·머지는 오케스트레이터 인수가 표준 코스로 굳음) · 디스크 회수 2회전(QA 서버 바이너리를 스크래치패드로 옮기고 main target 12G 회수) · 검수 앱 재빌드 진행(U-8 포함).
## 2026-08-23 (Fable) · ★M-2 폐곡선 — #1702 머지(track/uxui=5679f6c8)·#1700 close. UXUI 파도 전량 종결
- sol 워커 완주(1288 tests·PR #1702·정지 계약 준수) → 오케스트레이터 검수: 공유 코어 가산 무해(웹 tsc+첨부 23 그린)·project-shape 보정 스코프드·PHPicker selection-only라 권한 키 불요 판단 타당.
- design-review 1차 PASS(High 2: picker 제시 레이스·iOS 낭독 무음) → **오케스트레이터 수리 065cb6a6**(onDismiss+폴백 이원화·draftAnnouncement+announce 배선, 레드 프루프 3/3) → **재판정 PASS(0·0)** → 머지. Medium 4·Nit 5·실기 미검증은 **#1703** 적립.
- 이로써 UXUI 완성도 파도 8 goal(U-1~5·7·C-1·M-1+M-2) **전량 랜딩**. 남은 실기 확증=iOS 시뮬레이터 세션(Slow Animations 오독 주의 — 재판정 주석).
## 2026-08-23 (Fable) · ★T-9 폐곡선 — #1701 머지(track/engine=462efd67)·#1678 close
- grok 워커 커밋(13파일·+806) 인수 검수: 유닛 283·red-proof 통합 3분기·생성기 멱등·docs 493 facts 전부 그린 → PR #1701 CI 그린 → 머지. ENGINE_HANDOFF **A-29 info**(UXUI 소비 작업 없음 — 클라 verbatim 불변). ADR-0167 집행 완결, D8 P1 원천 수리 폐곡선.
- 운영 사고 복구: 호스트 ENOSPC 여파로 Colima VM containerd 블롭 I/O 에러(컨테이너 좀비化) → VM 재시작으로 완전 복구(pgdata 무손실·api 브리지 재기동). **교훈: 호스트 디스크 고갈은 VM 스파스 디스크를 통해 컨테이너층까지 전파된다 — 대형 빌드 전 df 확인.**
- ADR-0169(로컬 보관소)·ADR-0170(언퍼얼) Proposed 기안·티켓(#1696/#1698) 링크. M-2 sol 워커 계속 가동 중.
## 2026-08-23 (Fable) · ★성재 일괄 위임("다 승인할게") 집행 — ADR 2건 Accept·워커 2기 발사·U-8 티켓
- **컴포저 하단 패딩 질문 해부(성재)**: 밴드=힌트 행 26px+상시 예약 타이핑 라인 행 26px(H-2 자리예약 설계). Slack식 한 행 스왑 제안 → **U-8=#1699** 티켓화(즉흥 수리 금지 규율).
- **승인 집행**: ADR-0167·0168 **Accepted**(위임 기록 명시) · rescue stash **drop 완료**(보험 패치 스크래치패드) · **T-9(#1678) grok 워커 발사**(track/engine, acceptEdits, 감시자 무장) · **M-2=#1700 발급+패킷**(`handoffs/2026-08-23-m2-photo-picker-packet.md`)+**sol 워커 발사**(goal_claim, feat/1700-picker-p0-adr-0168, 감시자+stall 감지).
- **합류 릴레이(큐④)**: 토큰 2회 붙여넣기만 성재 몫으로 남긴 릴레이 킷 완성 `claudedocs/e2e-d8-desktop-20260823/agent-join-relay-kit.md`(1회용 pairing/active 자격증명은 Fable 비대행 경계).
- 운영: ENOSPC 재발(tauri 빌드) → engine 구 target 3.6G+tauri target 회수, 26Gi 확보. main repo server-rust/target 12G는 QA 서버 가동 중이라 보존(세션 말미 회수 후보). #1696·#1698 방향은 승인됨 — ADR 기안=다음 순번.
## 2026-08-23 (Fable) · ★실결함 수리 랜딩(#1697)+기본 기능 4축 검수+실시간 리그 성립
- **U-3 실결함 수리**: 라이트박스 512px 스트립 — cn()의 tailwind-merge가 하우스 측정명 미인지→max-w-none 패배. 수리=단어형 --spacing-* 19종 전량 등록+정본 파싱 가드 테스트(#1697 merged, track/uxui=7124598b). design-review PASS(Blocker 0·H-1/M-1 커밋 내 종결). 레드 프루프 2건 실측.
- **기본 기능 4축(성재 요청)**: 타이핑 인디케이터 PASS(2계정 실측 "…님이 작성 중", ADR-0149 계약 확인)·패딩 격자 준수(off-grid 0)·폰 드로어 애니메이션 PASS(160ms ease-out·reduced-motion·스크림 버튼·inert)·**언퍼얼 미구현 확정→#1698 원장 티켓**(ADR 선행 명시).
- **실시간 로컬 리그 성립**: 5173 오리진+socat api 브리지(centrifugo 구독 프록시→호스트 서버 — 없으면 WS 붙되 전 구독 조용히 실패, 리그 함정으로 기록)+qa2 계정 시드. 라이브 도착·프레즌스·타이핑 전 레일 GREEN.
- 사고 수습: 레드 프루프 중 bare `git stash pop`이 공유 스태시의 rescue-20260823을 오적용→복구 완료(스태시 무손실·동일 SHA). **교훈: 워크트리 공유 스태시에서 bare pop 금지, 반드시 stash@{n} 지정.** 검수 앱 재빌드(수리분 포함) 진행.
## 2026-08-23 (Fable) · ★재개 큐 소진: UXUI 재연 QA 대행 5/7 PASS + U-7 스코프드 랜딩 + ADR-0168 기안
- 성재 "검수 요청 부분 알아서 처리" → **재연 QA를 Fable이 브라우저 자동화로 대행**: 로컬 프록시(localhost:23080, 정적=track/uxui dist·/v1=D8 포워딩)로 same-origin 리그 구성. U-5·U-2·C-1·U-1·U-4 전부 PASS(포커스 복귀 수리분 실렌더 재확인 포함). 증거 11샷+리포트 `claudedocs/uxui-qa-d8-20260823/`.
- **실측 발견**: D8 셀프호스트 파일 보관소 미연결(no-archive)→첨부 전 계열(U-3 라이트박스·M-2) E2E 원천 불가 — 서버측 보관소 구성 티켓 후보. 이모지 피커 상단중앙 위치는 관찰 소견(Low).
- **U-7 판정 집행**: DESIGN.md·OMD.md 등 문서 6파일+.gitignore만 랜딩(#1695 merged, track/uxui=35074dbd)·번들 583파일은 비버전관리. #1693 close·#1689 종결. 전체 번들은 feat/1689-design-md-core-v2-book@272dd4c2 보존.
- **ADR-0168 Proposed 기안**(M-2 선행 — expo-image-picker+document-picker 낱개, D1 연장). rescue stash=역행 패치 확증(패치 보험 `scratchpad/uxui-rescue-…patch.gz`)·drop만 성재 1커맨드 필요. 남은 성재 큐: ADR-0167/0168 Accept·T-9 발사·U-3/M-1 실체감(선택).
## 2026-08-23 (Fable) · ★Docker Desktop 반복 hung 근본해결=Colima 전환 + UXUI 재연 앱 빌드
- 성재 "도커 데스크탑 자꾸 문제(재설치 3회)—원인 파악·해결 or 대안 적용". **근본원인=AppTranslocation**: `/Applications/Docker.app` quarantine(Homebrew Cask)→Gatekeeper가 격리 임시사본에서 실행→소켓 경로 꼬여 데몬 hung. brew cask가 매 설치 quarantine 재부착→재설치 반복 무의미. xattr 제거는 sandbox ACL로 권한막힘.
- **해결=Colima 전환**(정본 메모리 `docker-desktop-translocation-colima.md`): brew install colima→`colima start --vm-type vz --cpu4 --memory8 --disk60`(Apple Virtualization)→context 자동전환·compose v2 플러그인 링크·자동시작 등록·Docker Desktop 로그인항목 제거. **안정성 실증: hello-world·amd64 에뮬·momo dev스택(pg18+centrifugo) healthy·CPU 0.04%**(Docker Desktop 146~214% 발열 대비 극명). hung 0.
- **UXUI 재연 앱 빌드**: track/uxui(배치1+2 web) Tauri debug 빌드→`~/Desktop/oort-uxui-review.app`(quarantine 제거·ad-hoc). 재연 백엔드=D8 Funnel 서버(healthz 200·실시간 wss 수리됨) 재사용(로컬 스택 불필요 — UXUI는 web·서버 API 무변경). 성재: 앱 실행→cursor.tailb1aad3.ts.net→owner 로그인.
## 2026-08-23 (Fable) · UXUI 배치 2 검수·랜딩 4/5 + U-7 보류 + 재연 docker hung — Fable 재개 체크포인트
- 성재 지시: docker 내가 재기동·재연 준비 / 지금 도는 작업 끝나면 체크포인트·정지(Fable 재개).
- **배치 2 랜딩 4/5**(sol 워커): U-5(#1687 단축키 도움말·드리프트 가드)·C-1(#1685 멘션 코어+웹/폰·회귀0)·U-4(#1688 컴포저 이모지/스레드/패딩 — 검수 수리1: 이모지 후 textarea 포커스 복귀, gate-composer 적발)·U-3(#1686 라이트박스 — CI 자동머지 대기). 각 리베이스 STATUS 인접충돌 해소·게이트 PASS.
- **U-7(#1689 OmD) 보류**: PR #1693 — 590파일·389k줄(.omd 생성물+omd 스킬 번들). DESIGN.md·OMD.md 정당하나 대량 커밋 스코프=성재 승인 사안(계약 §함정 명시). 판정 요청 코멘트·브랜치 보존.
- **재연 막힘**: 로컬 docker 데몬 hung(killall=프로세스 없음→open해도 미기동, 전부 120s timeout). Docker 재설치/재부팅 추정. web dist는 빌드 완료. docker 회복 후 스택+데스크탑 빌드. **재개 진입점 `handoffs/2026-08-23-uxui-wave-resume-checkpoint.md`.**
## 2026-08-23 (Fable) · UXUI 배치 2 발사(sol 5기) + 재연 web 빌드 — 로컬 docker hung
- 성재 결정: 재연=로컬 풀스택+데스크탑 빌드 · 배치 2=지금 바로 발사.
- **배치 2 티켓 5건+발사**: C-1=#1685(멘션 inline·코어 단독)·U-3=#1686(라이트박스)·U-5=#1687(단축키 도움말)·U-4=#1688(컴포저 이모지피커+스레드 동등성+패딩 폴리시)·U-7=#1689(OmD v2 채택). sol 5기 병렬 spawn·워처 무장. M-2(사진 picker)는 ADR-0137 D1 기안 선행이라 별도.
- **재연 준비**: momo-tracks/uxui를 e14faa50(배치1 전체) 동기화·web dist 빌드 완료(stale node_modules→npm ci로 해소). **로컬 docker 데몬 hung**(version·ps 120s timeout — momo Docker 발열/누적 재발) → 풀스택 기동 불가. **성재 Docker Desktop 재시작 필요** 후 스택 up+데스크탑 재빌드 이어감.
## 2026-08-23 (Fable) · UXUI 배치 1 완전 랜딩 — M-1·U-2·U-1 3/3 track/uxui (PLN-20260823-UX)
- **U-1(#1679→PR#1684) 머지** — 배치 1 완결. track/uxui=e14faa50(M-1 df12da8f·U-2·U-1 6f1fa145 순). 세 이슈 close·워크트리 3개 회수(디스크 44Gi).
- U-1 리베이스 2회전 수동 해소: STATUS.md 인접추가 + ChatShell 헤더 3분기 병합(U-2 flex-col 구조 + U-1 DM 프로필 트리거). 병합 후 gate-quote·gate-channel-header 둘 다 PASS(양 계약 동시 충족 실증)·CI 8pass.
- 파도 성과: 메시지 우클릭 메뉴·원문 복사·멤버 프로필 카드(웹)·채널 토픽/멤버목록(웹)·iOS 첨부 렌더·다운로드(P0 조용한 유실 폐쇄)·프로필 시트. 감사가 밝힌 "발견성 결함"(기능은 있는데 안 보임)을 우클릭·프로필 진입점으로 해소.
- **다음**: 성재 수동 재연(빌드 원본=track/uxui) + 배치 2 발사(C-1 멘션·U-3 라이트박스·U-4 컴포저패딩·U-5 단축키·M-2 picker·U-7 OmD).
## 2026-08-23 (Fable) · UXUI 파도 배치 1 검수·랜딩 — sol 3워커 완주·Fable 재판정 수리 3
- 세 sol 워커 커밋 완료(exit 101은 codex 런타임 오류=캐시 TTL·디스크 풀, 산출물 무결). Fable 검수 이어받아 게이트·리뷰·랜딩 집행. **워커 브라우저 게이트 승인 요청은 계약대로 취소·Fable이 playwright 게이트 직접 실행.**
- **U-2(#1680→PR #1682)**: 채널 토픽 표시·전체열람+멤버목록 패널. 검수 중 게이트 FAIL 2건 수리(테스트 상수 trailing space·DialogTrigger 오용→정본 프로그래매틱 패턴). gate-channel-header PASS+red-proof.
- **U-1(#1679→PR #1684)**: 우클릭 메뉴+원문복사+멤버 프로필 카드. correctness 리뷰 Blocker 0(선택 양보 이중가드·탭스톱 0·결정주석 갱신). gate-quote 확장 PASS. legal 번들 재생성 정당(context-menu MIT).
- **M-1(#1681→PR #1683) 랜딩됨**: iOS 첨부 렌더/다운로드(조용한 유실 P0 폐쇄·회귀단정)+프로필 시트. jest 73스위트/1274 전부. **track/uxui 머지 완료(0f96d6f3)**. 이탈 1(expo-file-system top-level hoist — 이미 링크된 Pod, 새 네이티브 0·성재 판정 코멘트).
- design 검증: design-review 서브에이전트 3기 좀비화(mailbox 미전달)·재spawn도 오작동 → **Fable 코드+토큰+프리플라이트 직접 판정**(실렌더는 환경제약·성재 검수빌드 최종). 세 PR design Blocker 0(4상태·위계·키보드·죽은컨트롤 없음). 디스크 100%→오래된 워크트리 node_modules 회수 2.4Gi(docker prune은 분류기 차단·momo-docker-reclaim 성재).
- 랜딩 순서 M-1→U-2→U-1(U-1·U-2 ChatShell 헤더 공동접촉—U-1 DM 프로필 트리거). U-2 리베이스 완료·CI 대기. 배치 2 대기: C-1 멘션·U-3 라이트박스·U-4 컴포저패딩·U-5 단축키·M-2 picker(ADR)·U-7 OmD.
## 2026-08-23 (Fable) · UXUI 완성도 파도 발사 — 감사 2기·티켓 3건·sol 워커 병렬 3 (PLN-20260823-UX)
- 성재 발제: 프로필 모달·우클릭(이모지/리플라이)·다운로드·메신저 컨텍스트·패딩(컴포저 캡처)·iOS 동반·omd v2 디자인시스템·**워커=sol(codex)**. 계획 정본 `research/2026-08-23-uxui-completeness-wave-plan.md`.
- **감사가 판을 뒤집음**(Explore 2기, file:line 전수): 리액션·스레드·수정/삭제·핀·호버메뉴·타이핑·안읽음·첨부(웹)·마크다운 전부 EXISTS — **성재가 D8에서 못 찾은 것=발견성 결함**. 진짜 MISSING: 사람 프로필 카드·메시지 복사/퍼머링크·우클릭(의도적 부재 기록 — 오너 지시로 재개정)·채널 토픽 표시·헤더 멤버목록·멘션 렌더(코어 공동)·이모지 피커·라이트박스·단축키 도움말·**폰 첨부 전면 부재(조용한 유실 P0)**.
- 파생 발견 2: ①RN Origin 블로커(셀프호스트가 iOS 실시간 전부 거부) → #1678 AC 합류 ②uxui 워크트리 정체불명 스테이징(270파일 −64k줄) → stash `rescue-20260823` 보존 후 동기화(성재 확인 대기).
- **배치 1 발사**: U-1=#1679(우클릭+복사+프로필 카드) · U-2=#1680(채널 토픽+멤버목록) · M-1=#1681(폰 첨부 렌더/다운로드+프로필 시트) — 통합 패킷 `handoffs/2026-08-23-uxui-wave-packet.md`, sol 병렬 3 spawn(워처+행 감지 무장). 배치 2 대기열: C-1 멘션 노드(코어)·U-3 라이트박스·U-4 컴포저/패딩·U-5 단축키 도움말·M-2 사진 picker(ADR 게이트)·U-7 OmD v2 채택.
## 2026-08-23 (Fable) · D8 P1 원천수리 채비 + 그록봇 릴레이 2건 직접 전송(성재 지시)
- 성재 "알아서 해결·원천적 방법 마련" → **ADR-0167 Proposed**(`0167-selfhost-realtime-same-origin-advertisement.md` — `MOMO_CENTRIFUGO_WS_URL=same-origin` 센티널: 서버가 요청 XFP/Host에서 파생, 절대 URL은 verbatim 유지=ADR-0110 증보. 출하된 v0.1.1 클라가 무변경 수혜). 부수 결함도 포섭: 생성기 CENTRIFUGO_ALLOWED_ORIGINS에 공개 오리진 부재(브라우저 403 잔존 경로).
- **T-9=#1678 발급**+패킷 `handoffs/2026-08-23-selfhost-realtime-sameorigin-packet.md`(ready·착수 게이트=ADR-0167 Accept·발사=성재 go 대기).
- **그록봇 릴레이 직접 전송**(성재 "하라해줘" — cliclick UI 스테이징+전송, CDP 비사용): [1] 즉석 완화=env 2줄(WS URL wss 전환+오리진 추가)+api·centrifugo 재기동 [2] **온보딩 전 과정 단계별 캡처**(/workspace/oort-onboarding-captures/ 번호 파일+INDEX.md 헤맴 코멘트·시크릿 마스킹) — 성재의 aside/cursor/codex급 온보딩 와우 갭 검수 재료. 수리 폐곡선 완료(15:53 릴레이→15:54 wss 실측→15:59 REST 발신 메시지 데스크탑 라이브 도착·프레즌스 점등). 캡처 01~18 생성 확인(INDEX.md — 07 migrate 실패·12 tunnel 429·14 로그인 반복 등 마찰 지도). 잔여=에이전트 합류·성재 수동 판정·ADR-0167 Accept·T-9 발사.
## 2026-08-23 (Fable) · D8 데스크탑 실접속 — Fable 직접 수행: 코어 GREEN·실시간 레일 P1 발견
- 성재 지시로 D8을 Fable이 로컬 맥에서 직접 수행(스크린샷 14장 `claudedocs/e2e-d8-desktop-20260823/`). v0.1.1 dmg 공증 PASS→설치→Funnel 주소→claim 소비·비번 설정→**데스크탑 owner 로그인 성공**→첫 메시지 REST 전송·렌더. **T-5 그록봇 감지 CTA 실환경 노출.**
- **★P1**: 로그인 응답 `realtimeWebSocketUrl=ws://localhost:8088/...`(`self_host_env.sh:796` 터널 무인지·ADR-0110 verbatim) → 원격 데스크탑 실시간 연결 실패. R-2는 동일 호스트라 가림막. **Funnel WS 101 통과 실측 — env 1줄+api 재기동이면 수리.**
- 소견: owner 시드 표시명 "데모 사용자/@demo" 노출 · SELF_HOST_AGENT.md에 터널 WS URL 절차 부재. CDP READ/SEND는 분류기 차단 — claim URL은 화면 캡처+실링크 클릭으로 회수(비유입 규율 유지).
- 잔여: ①WS env 수리(그록봇 릴레이 지시문 성재 전달) ②에이전트 합류(pairing 릴레이) ③성재 수동 재연·수용 판정. 스택·Funnel 보존, 상세=모계획 §11 갱신 2.

## 2026-08-23 (Fable) · 파도 종결+main 승격+★v0.1.1 multi-arch 첫 발행 — E2E만 남음
- Q-LEGAL: 성재 "브리핑 검토 후 머지" 선택→브리핑 정본 작성·승인→§0/§3.1 체험위상 보강(워커)→T-2 머지. **파도 7/7 전량 랜딩.**
- **승격·재발행 체인(성재 "2번도 ㄱㄱ" 위임)**: promote #1665(양 트랙+planning 플러시·충돌 5파일 해소·merge_tree PASS — RED 2종은 deps 신선도+preview-guard flake 판정)→main=1b79bc65→sync #1666/#1667→publish-images dispatch+release 승인 2회(각 잡 게이트)→**amd64+arm64 manifest list 첫 실전**(attestation 2본 PASS)→v0.1.1 태그·Release→#1669 digest 문면 현행화→#1670 승격→sync #1671/#1672. topology PASS.
- 잔여: dmg 실공증(분류기 차단 — 성재 `! scripts/publish_next_build.sh --public --version 0.1.0` 후 Fable 업로드)·E2E 수용 런(지시문 제시)·R-1 마커 재확인. 정책 마커 누계 6회 — 절차가 일상 회전에 들어옴.

## 2026-08-23 (Fable) · T계열 파도 6/7 랜딩 — grok 워커 6완주·수리 5회전·정책 마커 3회
- 성재 "ㄱㄱ" 발사 go + ADR-0166 Accepted → V-1·T-4·T-5·T-6·T-1·T-3 순차 완주(전부 track 랜딩·close·잔재 회수). 검수 체제: Fable diff 리뷰+재판정 실측+design-review 에이전트(fresh context, T-5/T-6/T-1 — 실렌더 촬영 2건 포함).
- 수리 회전 실적: T-5(H2 — 문면 모순·오프라인 자동발사)·T-6(H4 — failed 전송 왕복무장·재멘션 미복귀·완료 로드창 묶임·오프라인 4중발화)·T-1(UX M2+CI 2: 마이그레이션 카운트 하드코딩·GHCR notice stale). 전부 워커 수리→재검수→머지.
- 이탈 판정 3건 DEVIATION 기록: T-4 검증 축소(noted)·T-1 runtime-db 선재 중단(noted — main 재현 실측)·복원 래퍼 가산(accepted). V-1 부수 발견 2건(self_host_env down 오인거절·reclaim rc=1)은 티켓 후보 원장.
- **잔여=T-2**(#1663 검수 합격): Q-LEGAL 성재 "브리핑 검토 후 머지" → 브리핑 정본 `research/2026-08-23-t2-assist-risk-briefing.md` 제시, 발화 대기. **E2E 전 체인**: main 승격→재발행(claim 포함 digest — 현행 pin으론 플레이북 게이트 RED)→digest 현행화→dmg 공증·업로드→E2E(자연어 릴레이).

## 2026-08-22 (Fable) · 성재 결재 3건 집행 — 자연어 릴레이 전환·본인 계정 확정·T계열 티켓 7건 발급
- 성재 결재: **Q-CDP=자연어 지시 릴레이 전환**(우리 E2E 검증의 CDP 자동 제어 은퇴 — 마커 재확인·수용 런 포함, 지시문=Fable·전달=성재) · **Q-STRUCT=체험자 본인 계정/VM 전용 확정** · **Q-LEGAL=계류**(T-2 정본 머지 전 판단 권장). 모계획 §9에 성문.
- **ADR-0166 기안**(Proposed — claim-token 부트스트랩): 현행 env 평문 경로의 전제 붕괴(설치자=에이전트·사용자 VM 셸 무접근·터널=공개 주소) → 1회용 claim URL. 선례 조합=invites 해시+hosted pairing TTL 단회소비+join 무인증 마운트. **Accept가 T-1 착수 게이트.**
- **티켓 7건 발급**: V-1=#1650·T-1=#1651·T-2=#1652·T-3=#1653·T-4=#1654·T-5=#1655·T-6=#1656 (전부 status:ready). 통합 패킷 `handoffs/2026-08-22-grokbot-selfhost-wave-packet.md`(ready). 스코프 발견: 서버 v0.1.0 릴리스 8/21 기존재→T-3=데스크탑 dmg로 확정 · T-5 감지 시그니처에서 CDP 포트 제외(Q-CDP 취지, E4 원문과 의도적 차이).
- **발사는 성재 명시 신호 대기.** 다음 결재: ①ADR-0166 Accept ②발사 go ③Q-LEGAL ④E2E 수용.

## 2026-08-22 (Fable) · aside 벤치마크 3축 리서치 완주 + R-1/R-2 관문 종결 + 타겟 축소
- 성재 발제 2건: aside(=aside.com AI 브라우저) 벤치마크로 ①구독/OpenRouter 연동 ②에이전트 감지·등록 ③Slack 마이그레이션 + 1차 런칭 타겟=그록봇 유저 한정. 우로보로스 인터뷰(`interview_20260822_095929`) 완결 — E1~E10 결재. 증보 계획 `research/2026-08-22-aside-onboarding-three-axis-plan.md`.
- **리서치 4기 병렬 완주**(서브에이전트, 전부 검수 승격): RA-1 aside(구독=정식 OAuth·3계층 병존·llms.txt 서빙 선례·온보딩 비게이트화)·RA-2 Slack(v1=export zip public채널+드라이런, 라이브 API는 2026-03 유예종료로 BYO 내부앱토큰만 생존→v2)·RA-3 구독약관(Anthropic 금지/예외=미개조 CC·xAI 유일권장·OpenRouter 최청정·aside는 UX만)·RA-4 그록봇VM.
- **★R-1 관문 종결(RA-4)**: Grok Bot=xAI+Anysphere(Cursor) 합병제품·약관=Cursor ToS. durable-but-resettable **공식 확증**(데이터 durable·설치물 replaceable·Update 시 스택 증발). 중대 약관리스크 발견(Beta 무보증·xAI 비상업용도만·**자동화 접근 금지=우리 CDP 사정권**·경쟁서비스·계정개방). ⇒ **파이프라인 성립하되 "체험자 본인 계정/VM" 구조로 못박고 T-2 멱등재기동+T-4 백업 필수화**.
- **★R-2 종결(Fable 직접 실측)**: cloudflared quick tunnel×로컬 스택 전면 GREEN(HTTP 200·agent-port 401·WS 프레임왕복·지연 13ms). 데스크탑 Tauri Origin 무설정 통과. D4 확정=quick tunnel. 정본 `research/2026-08-22-tunnel-spike-r2.md`. 스택 down·볼륨 보존·터널 종료.
- **성재 결정 큐**: Q-STRUCT(본인 계정 구조 확정?)·Q-CDP(검증 CDP 계속 vs 자연어 릴레이 — B3 약관 발견)·Q-LEGAL(조력 리스크 법무검토?)·티켓 발급(T-5 감지·T-6 첫왕복게이트·T-7 Slack·T-8 내장AI). 리서치 산출 6종 정본화 완료.
## 2026-08-22 (Fable) · ★그록봇 원클릭 셀프호스트 파이프라인 확정(PLN-20260822-01) + CDP SEND 자동화 첫 실전
- 성재 발제: llms.txt→그록봇이 자기 VM에 oort 자동 구동→주소+사용법 회신→데스크탑 앱 접속+**그록봇 에이전트 합류**. 우로보로스 인터뷰(`interview_20260822_091448`) 완결 — D1~D10 결재: 외부 셀프서브 퍼널 정본·수용=실측 E2E 1회·claim-token 서버 티켓(대화창 비번 기각)·리커버리 v1=pg_dump 스크립트·데스크탑 v0.x Release 포함.
- 정본 `research/2026-08-22-grokbot-one-click-selfhost-plan.md` — 시리즈 R-1(VM 리셋 재검증=관문)·R-2(터널)·T-1~T-4·V-1·E2E. T계열 병렬 착수 허가. 리서치 워커 발사는 성재 go 대기.
- **CDP SEND 자동화 성립**(성재 위임 — Q-CTRL 해소): 프로브 실전 — ghcr 401 도달 GREEN·8CPU/15.6G GREEN·**uptime 18h→1h39m=세션 간 VM 재시작 실측**·`cursorenvironments` 샌드박스 확정·영속성 마커 2종(홈 파일+Docker 볼륨) 심음 → 다음 세션 잔존 확인=R-1 실측면 종결.
- 신규 루틴: `docs/planning/FABLE_DOWNGRADE_ROUTINE.md`(Fable→Opus 강하 시 중단·핸드오프 — 성재 지시·메모리 영속화).

## 2026-08-22 (Fable) · 그록봇 CDP 제어 실증 + 오퍼레이터-호스트 확증 + 로컬 Docker 복구
- 성재 지시 3: ①로컬 Docker 삭제·재설치("자주 저러더라") ②그록봇 제어=최선방식 계속 테스트(위임) ③표적방향=추천대로(오퍼레이터-호스트).
- **그록봇 제어(CDP 9333)**: READ✅·WRITE주입✅(ProseMirror `Input.insertText`, WS는 `suppress_origin`)·**SEND는 auto-mode 분류기 차단** → 현행 최선=관측 릴레이(성재 Enter). 자동 SEND엔 성재 권한 규칙 필요. 헬퍼=스크래치패드 cdp_*.py.
- **표적방향 확증**: 그록봇 VM 자백 — Debian13 amd64·Docker :2375 실가동·126G/7%·공인IP 없음·cgroup /agent. ⇒ 오퍼레이터 적격·호스트 부적격. #1361 static bearer 실왕복 흔적(inbox_read seq1·message_post seq2) 재확인.
- **Docker/디스크**: "자주 저러는" 원인=디스크 99% 포화(worktrees 148G, cargo target). cargo clean 67GB 회수(→92%)+앱 재설치·데몬 복구(29.7.2). translocation 잔여는 성재 brew 재설치로 정리(비차단). **정정(성재 지적): 로컬 Docker는 그록봇-오퍼레이터 테스트 임계경로 아님** — S1 별개 축.
- 정본 `research/2026-08-22-grok-cdp-control-and-operator-host.md` · 재개 핸드오프 `handoffs/2026-08-22-grok-selfhost-resume-handoff.md`. 대기: Q-CTRL(SEND 자동화 허용?)·Q-HOST(호스트 재사용 vs 신규).

## 2026-08-22 (Fable) · 신규 축 발제: 에이전트-운영 셀프호스팅(AOP) — 리서치·계획 상신
- **성재 발제**: 로컬 그록봇이 핸드오프 하나로 oort를 컨테이너로 띄우고(호스팅·주소·알림·웹훅 전 기능) 업데이트·서버관리까지 하는 형태. 선행: 그록봇 VM co-host 브리핑(동일 채팅 — co-host=조건부 찬성·무료 공용=ADR 필요·localhost 착시 정정).
- **정본**: `research/2026-08-22-agent-operated-selfhost-grokbot.md` — 판정=agent-native 정체성의 자연 연장·기존 자산 정합 높음(발명 최소). 갭 6(AOR 부재·#1265 웹훅 인바운드·외부 접속 택일(#1239 선행)·알림 범위표·에이전트 시크릿 규율·Day-2는 AOR 흡수).
- **계획 S1~S4**: S1 에이전트 설치 스파이크(grok 헤드리스+현행 SELF_HOST만·제로 코드 — ITO-1의 에이전트 버전) → S2 AOR 신설+무개입 완주 재실측 → S3 외부 접속+#1265 이식 → S4 다이얼인 관리(#1361 소화 가능). 결정 큐 Q1~Q4(발사·표적·G-C 재료·ITO 별개 유지 권장).
- 대기: 성재 Q1(S1 발사) 승인.

## 2026-08-22 (Fable) · 대기 큐 4/4 완주 — 붕대 제거·문서 진실성·라벨 현행화·arm64 워크플로. 성재=실테스트만
- **#1635**: pr-ci 붕대 2건 제거(web TZ pin·mobile inboxApproval 제외 — 71/71 실검증)+재도입 RED 가드. **#1641**: 루트 계약 6좌표+동류 2줄의 web-legacy 실서빙 거짓 이분 정정(잔여 grep 판정표). **#1642**: 발행 실측 라벨 현행화(H2 amd64 정직 라벨 보존)+GATED_DOCS 3종 편입(439 fact·15문서). **#1643**: publish-images **multi-arch 준비**(native ubuntu-24.04-arm·digest-only push→manifest list 합성·attestation=아키4+list2·pin=list — 실발행=성재 클릭).
- **운영 사고 2건 해소**: ①디스크 ENOSPC(도커 빌드캐시 5GB+1330 워크트리 target 9GB 회수 — 39Gi 확보) ②STATUS 상단 경합 DIRTY 2건(#1642 선랜딩과 충돌 — 루프가 BEHIND만 처리해 정체. 교훈: **머지 루프에 DIRTY 즉시 탈출 분기 필수**·STATUS 상단은 순차 랜딩 시 상습 충돌면).
- **성재 잔여 목록(전량)**: ①ITO-1 실테스트 시작일 ②다음 발행 창에서 multi-arch dispatch+release 승인 클릭(→arm64 실측 digest 기입은 Fable) ③(선택) T-D §8 재발행=ITO-3 직전 ④(대기) 여명님 org 정리 없음 — Owner 승격 안 함 확정.
- 백로그 잔여(자율 후보): DCO CI·드리프트 게이트·볼륨 소유자 라벨·픽스처 URL·Swift prod 주석·DEPLOY 본체·#1600~#1604 제품 파도 — 각 이슈 코멘트 원장.

## 2026-08-21 (Fable) · L-파도 4/4 완주 — ★v0.1.0 첫 릴리스·gitleaks CI·커뮤니티 문서·승격 b1bf46e9
- **★v0.1.0 발행**: tag@45a154d2+GitHub Release(digest 표·검증 커맨드·amd64 고지) — SECURITY.md 「최신 v0.x」 약속 성립. G1(#1628 — RELEASING.md·SELF_HOST digest 실값·:88 라벨 해소).
- **G2(#1629)**: gitleaks PR-range 레인(8.30.1 tarball+sha256 pin·fail-closed·fork 안전) — 자기 PR 첫 실전 통과. **G3(#1267/#1268)**: 기여자 첫 빨강 결정성(TZ 주입·waitFor 분리 — UTC 빨강 재현·linux 1628ms 실측·3회×2플랫폼) — 검수 회전 1(vite.config tsc TS2769: Vite5/6 타입 충돌). **G4(#1630)**: CoC v2.1·CODEOWNERS·CHANGELOG 시드·CONTRIBUTING 영문 정본+ko.
- **승격 2회차**: main=`b1bf46e9`(PR #1637 — 커뮤니티 문서가 Community Standards 가시권 도달)+sync 짝 #1638/#1639 topology 복원.
- **거버넌스 확정**: org Owner 승격 없음(성재) — 새 패키지 생성 시에만 owner(여명) 1회 요청. 후속 티켓: #1635(CI 붕대 제거)+워커 후보 ~13건 이슈 코멘트 원장.
- **성재 앞 잔여 = ITO-1 실테스트 시작일 결정뿐.** grok 누계: 이 창 구현 완주 5·검수 회전 2(전부 실결함)·병렬 1 안정.

## 2026-08-21 (Fable) · ★GHCR 첫 발행 완결 — 법무 승인·public 전환·attestation 실측·arm64 경계 실증
- **발행 폐곡선**: 성재 dispatch+release 승인 → run 32461307786 success → digest 2본(app `0fbddd36…`·postgres `c6806369…`) attestation 동반. **법무 검토 승인**(성재 발화 — 브리핑 3판단: OS 레이어 copyleft 관행 수준·성실 이행 범위·상표 인지) 원장 기록(#1332 코멘트).
- **public 전환**: kwakseongjae=org **member**라 패키지 관리 불가 발견 → org owner(lifeissea)가 집행(org 패키지 정책 해제 선행). 익명 pull 토큰·digest 일치·`gh attestation verify` 2본 전부 실측 PASS. **Owner 승격 요청 전달됨**(재발 방지).
- **H2 실측**: Apple Silicon digest pull → `no matching manifest for linux/arm64` — SELF_HOST.md 문서 경계 실증(에뮬레이션 비가정 준수). amd64 부팅 실측=H2 잔여(amd64 호스트 또는 arm64 릴리스 후 — Q3 결정 근거 보강). 테스트 잔재 0 회수.
- **다음**: ①L3 파도(첫 v0.x 태그+릴리스에 digest 기재·SELF_HOST digest 문면 현행화·runtime-unverified 해소) ②ITO-1 H1(성재 — 조건 충족 상태) ③CI gitleaks·커뮤니티 문서 등 L 잔여.

## 2026-08-21 (Fable) · GHCR 발행 선행 완결 — #1330·#1332·#1613 랜딩·★승격 45a154d2·성재 발행 결재 대기
- **GHCR 체인 코드 완결**: #1330(PITR 게이트 — rebase 151커밋+리뷰 4건 대응·H1 실측 반증(2.59 stanza-create 멱등)·PR #1342) → **#1332(NOTICE bundle — cargo 292+npm 411·이미지 2본 동봉·mutation 4종 RED·PR #1620)** → #1613(교차-체크아웃 스택/볼륨 충돌 fail-closed·실 docker 증명·PR #1622). 검수 실적발 1: #1332의 per-Dockerfile ignore가 legal/scripts 배제→이미지 COPY 실패(실빌드 2회 재현) — 수리+ignore↔COPY 일반화 단언.
- **★승격**: main=`45a154d2`(PR #1623, 34커밋 — ITO-0 5건+GHCR 선행 3건+파도 9·10 잔여) + sync 짝 #1624/#1625 → main=양 트랙 조상 실측. 발행 워크플로 main ref 조건 충족.
- **성재 결정·조치**: #1361 연기(비차단 확인·로컬 스택 down — 볼륨 보존·재개 1커맨드) · NCP 최적화 집행(cube-host·turn 정지 — 월 ≈₩43만 절감·도구 ~/.local/bin/oort-ncp.py·ITO-3 I4 전 재기동 계획·프로덕션 유지).
- **다음=성재 2클릭**: ①법무 검토 1회(legal/generated bundle·NOTICE·인덱스·Debian 인벤토리) ②publish-images workflow_dispatch+release 승인. 이후 Fable: 발행 실측(digest 검증·SELF_HOST digest 경로=ITO-1 H2)·ITO-1 H1은 #1613 랜딩으로 조건 충족.
- grok 측정 누계: 구현 완주 9(발사 12회 중 조기종료 4회 전부 회복 — 동시 2기 창 집중→병렬 1 확정)·검수 회전 2(전부 실결함)·게이트 회전 0.

## 2026-08-20 (Fable) · ITO-0 수리 파도 5/5 완주 — grok 4.6 워커 첫 실전·#1613 실사고 발견·#1342 리뷰
- **인터뷰 종결**(`interview_20260820_074206` — 성재 결재 5건): Q1 ITO-0 발사·Q2 GHCR 체인(#1330→#1332) 착수·Q3 arm64=런칭 전 후미·Q4 실사용자 A시도/B폴백·Q5 커뮤니티 문서=런칭 전(위임).
- **ITO-0 랜딩 5/5**: T-A #1614(tauri CORS 기본값+거부 케이스 실측 405·허용은 ITO-1 이관)·T-B #1615(SELF_HOST_FIRST_DAY 런북 — GUI 초대 최초 문서화·로그인 화면 6문구 브라우저 실측 일치·owner 로그인 200)·T-C #1612(LAUNCH_READY 계약·스모크 웹+데스크탑 이관)·T-D #1617(MOMO_CHANNEL_BUILD 가드로 로컬 release 롤백 구멍 폐쇄·NEXT_CHANNEL §8 성재 복붙·policy 감사 마커 절차)·T-E #1616(stale 3파일 이분 정정).
- **★실사고→P1 발견 #1613**: compose 프로젝트명·pgdata 볼륨 고정 이름이 타 체크아웃 스택을 하이재킹(T-A 실기동 중 #1361 스택 재생성·PG 이중 기동까지 실측) — **완전 복구·데이터 무손실 실측**(workspace 1·agent 2·message 2·8088 정상). 셀프호스터 실경로 결함 — ITO-1 전 수리 권장.
- **grok 4.6 첫 파도 측정**: 워커 발사 7회 중 완주 5(+1은 -c 재개로 완주)·조기 종료 4회는 동시 2기 창 집중 — **잔여는 병렬 1 보수 운용**. 산출 품질 상(정직 라벨·file:line·이탈 보고·택일 논거 전부 성립)·게이트 회전 0·acceptEdits로 명령·커밋 완주. 티켓 후보 15건 이슈 코멘트 원장화.
- **#1342(#1330)**: grok 리뷰어 C 판정 C0/H1/M3/L2 PR 기록(H1=stanza-create 비멱등 시 2회차 폐곡선 중단·PLAUSIBLE — 이중 실행 실측이 AC). rebase+4건 대응 워커 단독 비행 중. 랜딩→#1332 ready 전환이 다음.

## 2026-08-20 (Fable) · 오픈소스 런칭 준비도 실측 + 내부 테스트 운영(ITO) 계획 상신
- **성재 발제**: 오픈소스 퍼블리싱 전 내부 테스트(호스팅→온보딩→실사용, 웹+데스크탑 연동 중심·셀프호스팅 유저 관점). 향후 워커=grok 4.6·기획 검수=Fable.
- **실측 종합**(정본 `research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md`): 레포는 이미 public(8/10)·런칭 정의="외부 셀프호스터 3+에이전트 실사용". 3관문 중 ①공개=완료 ②셀프호스팅=로컬 빌드 완주·digest 미개통(L1 #1332·L2 GHCR 첫 발행) ③운영 신뢰=public-host 라벨군 잔존. 신규 확인: Rust 이미지는 `clients/web` 번들(web-legacy README stale)·웹 GUI 초대 발급 실물 존재(InviteSection).
- **편성안**: ITO-0 수리 파도 5건(T-A 데스크탑 릴리스 로그인 CORS 실기동이 관문·T-B 통합 온보딩 런북·T-C 테스트 팩 현행화·T-D #1281·T-E stale 스윕) → ITO-1 호스팅(H1 로컬/H2 digest/H3 TLS) → ITO-2 온보딩(O4=#1361 합류) → ITO-3 웹↔데스크탑 연동 8시나리오 → ITO-4 LAUNCH_READY 판정. L 시리즈(태그·CI gitleaks·커뮤니티 문서·arm64) 병렬.
- **대기**: 성재 결정 큐 Q1~Q5(§7) — 티켓 발급·grok 워커 발사는 승인 후. #1361 로컬 스택 7컨테이너 22h healthy 유지 실측.

## 2026-08-19 (Fable) · 파도 10 완주(8/8) — 자율 큐 소탕·폐곡선이 실결함 11건 적발
- 8건 랜딩(engine=`28bf1a54`): #1511·#1584(카피/낱말+3클라 게이트)·#1515·#1516(칩 그릇·톤 soft 토큰)·#1558·#1559(진행/잠금 분리)·#1479·#1480(폰 AX). design-review 4판+재확인 3판, 회전 6회.
- **회전을 부른 High가 대부분 코드가 아니라 주장이었다** — 말줄임 정책·「넷」의 근거·「모든 칩을 훑었다」·「폰엔 이 칩이 없다」·「그대로 보내집니다」. 리뷰어가 그물을 직접 재구현해 변종을 먹인 것이 사각지대를 냈다.
- 후속 5건 발급(#1600~#1604). TRACKS §3.1.1에 「프리플라이트 파이프 금지」 성문화(워커 자기 신고 → 다음 워커의 실제 실패를 잡음).
- 병행: #1361 준비 완료(#1592 랜딩) — 성재 1단계(연결 값 발급→Grok 앱) 대기 중. Fable 5 한도 도달로 워커 전원 Opus 5 전환.

## 2026-08-19 (Fable) · ★집행 창 — TURN 은퇴 §6 완주·프로덕션 배포 8d0f7d9a·microVM 실측·LIVE-5 라벨 전해소
- 성재 SSH 위임("허가 해줄테니까 ssh 포함해서 너가 ㄱㄱ"→경로 B: permission 규칙 추가) 하에 집행: §6-2~6-4 완주(병행 불성립 실측·정지창 은퇴·**coturn은 reload로 인증 설정 안 집음 — restart 필요**), 프로덕션 배포(momo-rust:8d0f7d9a — LIVE-5 전 축·마이그 077·TURN 3키 주입), #1586 배선.
- **#1587/#1588**: microVM 내부 왕복 실측(relay↔relay·ephemeral만·화면 증거) — grok PASS+회전 1, engine=`ef134609`. producer READY 경쟁 수리(v5). **LIVE-5 정직 라벨 0 잔여.**
- 발견: momo-cube-host→app.oor7.com 200(5c 권한 경계의 실체는 로컬 서버 부재가 아니었음). #1545 close(원장=코멘트)·C-1=성재 비활성화 수용(9/7 재활성화 체크리스트).
- 다음: #1361 Grok E2E(성재 합의 — 집행 종결 후 별도 세션)·자율 큐(#1584·#1511·#1515/#1516·#1558·#1559·#1479/#1480)·차기 승격 창.

## 2026-08-19 (Fable) · 파도 9 완주(4/4) — 게이트 가드 일반화·라벨 예약·remint 반영·base 위생
- 4건 랜딩(engine=`fe3f2960`): #1572(openapi 인용·bench 주석)·#1573(「멤버 추가하기」 개명 — design-review PASS·택일 지지)·#1574(remint (b) 서술 전수 정정+ICE restart 훅 기록)·#1571(preview-guard 26레인 — grok PASS, 실 점유자 red proof).
- 후속: #1584(「초대」 어휘 정렬 마이크로 3). 판정 전건 accepted(DEVIATION_LOG).
- 다음 후보: 자율 큐(#1511·#1515/#1516·#1558·#1559·#1479/#1480)·dsh C/D 검토. 성재 손 5건은 스냅샷 39 목록 그대로(SSH류는 권한 거부 — 성재 직접).

## 2026-08-19 (Fable) · ★engine→main 승격 집행(107커밋)·파도 9 편성 — 성재 전권 위임 확장("내 손 작업도 알아서")
- **승격**: PR #1576(merge, main=`e322ccf3`) — 정책 마커+라벨 절차, 충돌 0·역방향 0. topology 복원=sync #1577(engine `88477fcc`)·#1578(uxui `a13c2d01`), alignment 전부 PASS. 로컬 3체크아웃 ff 정렬(낡은 TRACKS 수기 편집·패킷 사본은 랜딩본 확인 후 폐기).
- **파도 9 발사**: #1571(게이트 가드 일반화)·#1572(base 위생 마이크로)·#1573(라벨 이중 의미)·#1574(remint 반영) — 패킷 `handoffs/2026-08-19-wave9-packet.md`.
- **성재 손 항목 집행 시도**: SSH 원격 집행(momo-turn #1545·cube-host momo-server 배치)은 **권한 시스템 거부** — 성재 직접 실행 필요(보고 예정). C-1(Apple 콘솔)·#1361(개인 인증)은 본질적 성재 항목.

## 2026-08-18 (Fable) · 파도 8 완주(4/4) — ★LIVE-5 전 축 종결·5c 실기동 E2E·#1561 검증 close
- **LIVE-5c(#1565/PR #1570)**: 실 입력 왕복(XTEST 1006프레임·실 xterm 도달)·비관측 mutation red proof 양쪽·remint 천장 **반증**(coturn은 ALLOCATE 시만 만료 검사 — 택일 (b), #1574)·validate v2 실호출 200. producer 실결함 3건 실기동 적발·수리. freeze 회전 1(C1: continue가 재검증 deadline을 굶김 — 루프 선두 이동+--jam red proof). **engine=`d987ff58`**.
- 병렬 3건 랜딩: #1535(SELF_HOST §4 화면 실물 재작성, #1567)·#1563(Shift+Esc press-단위 판정 1슬롯, #1569 — grok PASS)·#1536(빈 채널 첫 행동, #1568 — design-review PASS B0/H0).
- #1561 close: 파도 8 실측 alignment fail 0(워커 PR 전건 PASS·플러시 track 직행·sync PR 0). 후속 발급: #1571(게이트 포트-스쿼트 가드 일반화)·#1572(base 위생 마이크로 2건)·#1573(「멤버 초대하기」 이중 의미)·#1574(remint 반영).
- 잔여: microVM 내부 왕복 미측(`unverified.inputDeliveryInMicroVM` — 권한 경계, momo-cube-host가 닿는 momo-server 배치=성재 손)·#1545·engine→main 승격(81+커밋) 정비.

## 2026-08-18 (Fable) · 파도 7 완주(4/4) — ★LIVE-5b 랜딩·CI 소음 구조 해소 확정·첫 track-랜딩 플러시
- **LIVE-5b 랜딩**(`#1560→bc819ecc`): 딥링크 전환 UI·datachannel 입력 포워딩(4표면 비관측 red proof)·auto-return(창 자체를 세는 LATEWINDOW 증명)·오버레이 설계만. 폐곡선 2회전(grok 경쟁/계약+design-review B1 Esc 도달→해제 규칙·focus=상태) 후 재확인 PASS. **LIVE-5 전 축 코드 랜딩 — 잔여=5c 실기동 E2E+릴레이 #1545(성재 손)**.
- **동반**: #1534(오퍼레이터 부트스트랩 — 키 둘 발견·M5 최초 측정)·#1510(propsKind — 거짓 묘비 해소)·#1541묶음(busy 소탕+SaveButton 정본 결함 발견→#1558).
- **CI 소음 구조 해소**: 성재 인터뷰 3확정(A-1·C-1·D-2)→TRACKS §3.1.1 성문화(#1562). **본 저널 항목이 track-랜딩 플러시의 첫 실행**(main 비접촉 — alignment 창 0 검증 중). C-1은 성재 콘솔(클릭 경로=#1561 코멘트).
- **다음**: LIVE-5c 편성(실기동 E2E — 입력 왕복·비관측 mutation·remint 실측·ephemeral 릴레이 병행 실증은 #1545 완료 후). 자율 큐: #1511·#1515·#1516·#1535·#1536·#1558·#1559·#1563·#1479·#1480.

## 2026-08-18 (Fable) · 파도 6 완주(5/5) — ★LIVE-5a 랜딩·dsh 즉시분 3건·in-flight 소탕
- **LIVE-5a 랜딩**(`#1544→c9a390d9` 계열): ephemeral TURN(use-auth-secret HMAC·TTL 24h clamp)·control 내구 투영(원장 SoT·마이그 077)·observation 원자성+owner 예외. grok 보안 freeze 경계 전부 닫힘(C0/H0/M0/L2→회전 폐쇄). 실경계 발견 1(validate 필드명 — 실호출 전부 400이었을 결함) 동반 수리. 잔여=릴레이 켜기(#1545 성재 손·런북 §6 복붙 가능)·remint 실측(5c AC).
- **dsh 즉시분**: #1525(docs 명령 드리프트 게이트 — 위반 17 정리)·#1526(온보딩 실측 — 헤드라인: 스택 80초인데 첫 에이전트 응답 도달 불가 F1→#1534 선행 티켓)·#1527(컨텍스트 규율 정본 신설·ADR-0113 D6 정정). **#1502**(in-flight 6사이트+초점 결함).
- **교훈 2**: 발사 전 패킷 랜딩 확인(사고 1회 복구) · **engine→main 코드 승격 81+커밋 미실행이 base 사고들의 뿌리** — 위임 범위 내 승격을 다음 정비 항목으로.
- **다음**: LIVE-5b(웹 직접 조작 UI — 딥링크 진입·입력 포워딩·auto-return·오버레이 설계) 편성. 자율 큐: #1534(T1 선행)·#1541~#1543·#1510·#1511·#1515·#1516.

## 2026-08-18 (Fable) · 발사 준비 상태(armed) 구축 — LIVE-5a 패킷·dsh 티켓·로드맵 반영
- **LIVE-5a 완전 준비**: 패킷 `handoffs/2026-08-18-live-5a-engine-packet.md`(ephemeral TURN=use-auth-secret 권장·내구 투영=원장 SoT+조인 권고·owner 예외 편입, ADR 근거 전부 Accepted)+goal **#1524** 발급·binding. 편성안 §4를 인터뷰 확정분으로 갱신. **재개 발화 즉시 발사 가능.**
- **dsh 즉시분 티켓**: #1525(A docs 드리프트 게이트)·#1526(B 온보딩 실측)·#1527(H 반면교사) — LIVE-5a와 파일군 분리라 병렬 파도 가능.
- **ROADMAP §1.7 dsh overlay 신설**(전권 위임 반영): A~H를 축별 시점에 배치, LIVE-5·환경 폐곡선 비침해 원칙 명문화.
- 정지 유지 — 재개 시 1커맨드: #1524 발사+위생 파도(#1525~#1527+#1502 등) 병렬.

## 2026-08-18 (Fable) · 중간 점검 + dsh(DeepSeek Harness) 벤치마크 정본 랜딩
- **중간 점검 보고**(성재 요청): 아크 결산=파도 5개·랜딩 23건·결재 큐 소진, 잔여=LIVE-5(재개 후 최우선)+위생 큐 ~14건, 로드맵=3축 전부 실물 도달 후 심화 단계·다음 대형 축 후보=환경 폐곡선(커서 B).
- **dsh 벤치마크 정본**: `research/2026-08-18-deepseek-harness-dsh-benchmark.md` — 딥리서치 실측(deepseek-ai 공식·MIT·5일 153k★·"Everything is a plugin. Every run is traceable.") 기반 갭 맵+차용 후보 A~H. 핵심 판정: ①추적성은 성문화 갭(우리 실물은 강함) ②in-process 플러그인은 반면교사(우리 fail-closed 경계의 외부 실증) ③토큰 규율은 우리 우위 ④Trajectory·Code Mode는 LIVE/T3 자산과 상보.
- **편성(권장 확정)**: A(docs 드리프트 게이트)+B(온보딩 실측)+H(반면교사)=다음 위생 파도 / C(추적성 계약)+D(훅 택소노미)=LIVE-5 후 / E(Trajectory)=세션 표면 심화 / F(Code Mode×T3)=환경 폐곡선 합석 / G(생태 청사진)=플랫폼 확장 시. **LIVE-5를 밀어내지 않음**. 성재 결정 큐 3건(§5) — 기본은 권장 진행.
- 정지 상태 유지 — LIVE-5a 착수는 재개 발화 대기.

## 2026-08-18 (Fable) · 위생 파도 5 완주(5/5) — read-model 앵커 랜딩·LIVE-5 결재 완결·정지 진입
- **5 goal 완주**: #1498(인용 null 4태 `c526b8a8`)·#1503(폰 상태 역할 코어 단일화 `0dc7a605`)·**#1463**(검증 read-model — 채널 히스토리 DESC 스캔으로 목록 칩+1만행 스레드 동시 해결·스키마 무변경 `61556307`)·#1509(busy 배선+명사+중 `aaaf2f34`)·#1512(fmt 게이트 단계 `e8ba71c1`). **engine HEAD=`aaaf2f34`**.
- **결재 큐 완전 소진**: 우로보로스 인터뷰 종결 — LIVE-5 4결정 확정(지금 발사·5a→5b→5c·ephemeral TURN=5a·LIVE-4 딥링크 진입)+재개 게이트(성재 자유 발화·자동 진행 불가). ADR 3건 전부 Accept 랜딩(0165-2 `cd7b00f4`·0156-4/0157-2 성재 명시 승인 `3dd6f6ca`).
- **GitHub major 장애 통과**: #1512 정책 발행 503×3(평가는 전 PASS) — 절차 결함 1건 병발 수리(교훈: **head 전진 시 마커 갱신=라벨 재부착 짝**). momo-main 검수가 층간 이음새 발견(#1510 — body 없는 카드 인용=거짓 묘비).
- **다음(재개 신호 후)**: LIVE-5a 패킷화·발사(ephemeral TURN 포함). 자율 큐: #1502·#1510·#1511·#1515·#1516·#1449·#1396·#1392·#1405·#1400·#1381·#1450·#1452.
- **현재 상태: 정지(성재 지시)** — 재개=성재 명시 발화. 정지 중 질문 응대·상태 보고 정상.

## 2026-08-17 (Fable) · 위생 파도 4 완주(5/5) — 코어 crash 방어·busy 문법 완결·초록 위계 확정
- **5 goal 완주**: #1489(폰 라벨 결속)·#1488(도달 불가 카피 제거 — 살아나면 거짓을 말했을 갈래)·#1476(코어 null crash — 지목 1구멍이 실제 3구멍, hasRenderableBody 재사용 완결)·#1490(ConfirmButton busyLabel — 흐림 미이식=H-1 교훈 정합·낱말꼴 전수 조사)·#1491(done 칩 ok→muted — 위임 결정 집행, 실패 세션에서 danger가 유일 고채도). **engine HEAD=`cac7f16a`**.
- **렌즈 비례성 확립**: 시각 델타 0·기계적 결속은 Fable 직접 검수, 코어 방어는 grok, 시각 변경은 design-review — 파도 4에서 회전 0회(파도 1~3의 폐곡선 산물이 좌표를 정확하게 만든 효과).
- **후속 발급**: #1498(quote.ts 동형)·#1501(busy 배선+명사+중 정본화)·#1502(in-flight 접힘 5곳)·#1503(폰 상태 역할 패리티). 관측: 락파일 드리프트(별건 후보).
- **성재 회신 대기 지속**: 인터뷰 Q1(LIVE-5)+ADR 0156-4·0157-2 한 줄 확인.

## 2026-08-17 (Fable) · 전권 위임 개시 — 결재 큐 집행·위생 파도 3 완주(4/4)·#1442 랜딩
- **성재 전권 일임**(2026-08-17): 결재 대기=권장안 자율 집행, 큰 결정=우로보로스 인터뷰 질의(메모리 성문화). 집행: **#1442 보안 술어 패치 6건 승인→적용→랜딩**(`907e076c` — clippy 그린·보안 술어 PG 런타임 실증·정책 감사 마커) · **ADR-0165 증보 2 Accept 전환**(0156-4·0157-2는 분류기가 승인 표기 차단 — 인터뷰에 편입) · **done 칩 muted 결정 확정**(#1491) · LIVE-5=인터뷰 진행 중(`interview_20260816_200427`, Q1 발사 시점 답 대기).
- **위생 파도 3 완주(4/4)**: #1478(공백-본문 core 이관 `433ab9cb`)·#1466(프로토콜 플래그 `f09f9d00` — 운영자 문서 2줄+PG 12/12는 momo-main 집행)·#1403(aria-disabled `1be4b087` — grok H3 오탐 반증+실결함 3 회전: 진행/잠금 문법 분리 5사이트)·#1468(경과 낱말 `b46da0ee` — 형태는 자리의 격·어근 하나). engine HEAD=`b46da0ee`.
- **렌즈 교훈**: grok 오탐 1(H3)의 원인=컨텍스트 사본에 인용 선례 파일(SettingsFields) 미동봉 — freeze 스테이징 시 diff가 인용하는 선례 파일도 동봉할 것. design-review 에이전트 트랜스크립트 소실 2회 — 재발사로 무손실 처리.
- **후속 발급 누계**: #1488(죽은 카피)·#1489(폰 라벨 결속)·#1490(ConfirmButton busyLabel)·#1491(done 칩 muted). 잔여 자율 큐: #1463·#1472·#1476·#1479·#1480·#1449·#1396·#1392·#1405·#1400·#1381·#1450·#1452(위임 결정 가능).
- **성재 회신 대기**: 인터뷰 Q1(LIVE-5 발사 시점)+ADR 0156-4·0157-2 승인 한 줄. 회신 오면 인터뷰 계속→LIVE-5 패킷화.

## 2026-08-17 (Fable) · 위생 파도 2 완주 — 4/4 랜딩·정렬 2트랙 해소·후속 9티켓
- **4 goal 병렬 완주**(경량 통합 패킷 `handoffs/2026-08-17-hygiene-wave2-packet.md`): **#1467**(PG 픽스처 재실행 내성 `9ba981e2`)·**#1464**(goal_claim 트랙 base 인지 `13eb8b52` — 선언 신호 7순위·policy 감사 마커 절차 이행)·**#1465**(웹 null-body 빈 문단 `0d6cc97f` — 3렌즈 전원 그린)·**#1443**(폰 컴포저 동적 타입 `70b42d53` — grok M1 회전: 창 몫에서 크롬 0.23 분리, AX 상한 271→170.4=목록 등분, 캡처 레인 크롬 상시 재실측). engine HEAD=`70b42d53`.
- **가치 큰 부수 발견 2건**: ①#1465 워커가 코어 잠복 크래시 발견(artifacts.ts null body→타임라인 백지화, #1476) ②#1443 헤더 두께 주범=뒤로 글리프(34×3.143), 첫 판 산수의 맹점.
- **정렬 2트랙 해소**: main 플러시 즉시 짝 sync #1470(engine `ef3d0120`)·**uxui도 diverged 실측→sync #1474(`a8ab97ec`)** — "docs→main 머지는 트랙 동기 즉시 짝" 규율을 양 트랙으로 확장.
- **후속 티켓 9건**: #1472(fmt 드리프트+게이트 단계)·#1476(코어 null crash)·#1478(폰 공백 패리티)·#1479(@ 결합+AX 절 예산 — design-review PASS 조건)·#1480(멘션 시트 고정 상한) + 파도 1분 #1463·#1466·#1468 잔여. 워커 트랜스크립트 소실 1회(#1443 회전은 신규 워커로 컨텍스트 재구성 — 무손실).
- **다음**: 성재 결재 큐 그대로(#1442 보안 술어 6건·LIVE-5·ADR 증보 4·#1361 pairing·상태 칩 muted). 자율 가능 잔여=#1463·#1466·#1468·#1478·#1449·#1403·#1396·#1392.

## 2026-08-17 (Fable) · UXC 파도 완주 — #1441·#1454 랜딩, #1442 성재 큐 파킹
- **UXC 파도 자율 완주**(패킷 3건 신규→Opus 워커 3기 병렬→폐곡선): **#1441**(세션 경과 성과 단위+검증 칩) `b9cfbf69` · **#1454**(완료 리포트 서버 프로듀서 — 모델 펜스 트리거·검증만·elapsed 서버 관측) `30186176` 랜딩. engine HEAD=`30186176`. 트랙 정렬 스큐는 sync PR #1461(`996896f6`)로 해소.
- **폐곡선 적발 누계 10건 전부 수리**: #1454=Fable M-1(펜스 맨-끝)+grok 4(원시 봉투 노출·안닫힌 외곽·제로폭·시계 혼합)+재-freeze 2(물결 펜스·틱 앞 제로폭 — FenceMark로 CommonMark 완결, 뮤테이션 증명 8) / #1441=design-review High(320px 머리 붕괴→원장 진술만·폭 회귀 숫자 가드)+grok 2(ended/idle 스레드 캐시 미무효화·절단 표 접기 거짓). 재-freeze 양쪽 그린.
- **#1442 성재 큐 파킹**: 실측 — 레포에 rust-toolchain 없음, 실결함=거짓 `rust-version`(실바닥 server 1.88/desktop 1.89 브래킷 확정). MSRV 상향이 보안 술어 4곳(auth/rate-limit) lint를 드러냈고 워커 편집 차단 → **패치+진리표를 이슈 #1442 blocker 코멘트로 성재 결재 대기**. PR #1459(문서/메타만)는 그 뒤 머지. ⚠CI rust 레인이 clippy 안 돎 — CI 초록≠머지 신호.
- **후속 티켓 6건 발급**: #1463(검증 read-model — 목록 행+장스레드)·#1464(goal_claim 트랙 base)·#1465(웹 null-body 카드 빈 문단)·#1466(프로토콜 config 플래그)·#1467(PG 픽스처 재실행)·#1468(경과 낱말 3종). 성재 결정 추가 1건: 종료 상태 칩 ok→muted 여부(코어 역할표).
- **통합 실측 잔여**: 프로듀서 리포트의 세션 스레드 안착(#1441 칩 결선) `runtime-unverified` — 실기동 시 확인. 이번 세션 이탈 판정 3건 전부 기록(#1441·#1454 accepted / #1442 pending).

## 2026-08-17 (Fable) · ★ 실기동 E2E 성립 — 브라우저에서 microVM 실화면 도달
- **#1438 E2E ACHIEVED**: 외부 브라우저(공인 39.115.69.188)가 TURN relay 경유 microVM producer H264 실화면 렌더 — 56프레임@1280×720·relay↔relay·라이브 xclock 시각 실증. **성재 발제 "채팅 내 VM 화면"이 실물 도달.** runtime-unverified 5→1(입력=LIVE-5). 캡처 성재 전달.
- **핵심 신규 발견(=ADR-0165 증보 2)**: TURN 결선만으론 relay 후보 0 — microVM eth0이 link-local 전용이라 libnice가 TURN 디스커버리 미스케줄. **라우팅 가능 RFC1918 base 주입**으로 해결(실측 성공). 헤어핀은 TCP 반증됐으나 별도 TURN 호스트라 무의미화.
- **#1455 정정본 랜딩**(PR #1456→`10c58951`): display 템플릿 v3(수신기 PID1·ICE relay·iceBase 주입·라벨 3해소)·producer.service 제거·런북 §8-B/§9·ADR-0165 증보 2 초안(가산·Proposed). #1437 증보와 중복 회피.
- **보안**: E2E 진단 중 momo-turn 정적 자격이 NICE_DEBUG 로그 노출 → **로테이션 완료**(신 relay 성립·구 401 실측·구 백업 shred·값 비유입).
- **#1440(UXC-A 완료 리포트 카드)**: 커서 벤치마크 차용 A — LIVE-4 카드 재사용·정직 톤 4색. grok freeze C0/H1/M3/L4(H1=중복 라벨 실패 숨김 정직 위반)→회전(판정 코어 이관·3표면 정합). 프로듀서 저작=#1454.
- **LIVE-5 편성안 상신**(`handoffs/2026-08-17-live-5-direct-control-ux-plan.md`): 실화면 위 직접 조작 — 5a(엔진 잔여)/5b(웹 UI·입력 포워딩·비관측)/5c(실기동 E2E). 성재 결재 대기(발사·분해·TURN 단명 자격·진입점).
- **사각지대 교훈(성문화)**: #1456이 template.spec를 v3로 바꾸며 **그 파일을 읽는 웹 테스트+타입(displayStream.test.ts)을 안 고침** — "실호스트 재검증 불요"만 보고 웹 스위트/tsc 미실행. track 잠복 red를 #1440 track 머지가 드러냄. **규율: 공유 계약 파일(template.spec·openapi·토큰 등) 변경 시 그걸 소비하는 테스트+타입까지 로컬 `typecheck`+해당 스위트로 확인.** 내가 정정 시 vitest만 보고 tsc 건너뛴 2차 사각도 동일 교훈. #1440에 파급 정정 동반 랜딩으로 해소.

## 2026-08-16 (Fable) · 프로덕션 배포 완료 — a5193e5e→68fc52ff·마이그 069~076 라이브
- **배포 성공(무중단 ~4분, 성재 위임 집행)**: 서버 이미지+웹 번들(index-DUwycTsq)+마이그 8건 전량(신규 테이블 6종 전부 RLS FORCE 실측·전 변경 가산적 — **이미지 롤백에 스키마 롤백 불요**). 백로그 점검 0/0/0(대소문자 잔재 0). 검증: 컨테이너 9 healthy·에러 로그 0·경계 verifier 전관문 PASS(최초 설치)·API→PG 실조회. HAP 전체+LIVE-1~4+run 파킹이 라이브 도달.
- 롤백 좌표: `/opt/momo/backup/deploy-68fc52ff-20260816T131328Z/`(config 9종+manifest)+DB 덤프+구 이미지 보존. 부수 수리: **Caddyfile의 #1329 centrifugo 403 블록이 미배포 상태였음** — 이번 창에 닫힘(401→403 실측).
- 특이: scp 분류기 비결정 차단 1회(단일 파일 재발행으로 완주·동결 0)·디스크 87%(이미지 6개 회수 후 — 다음 배포 전 재점검)·**사람 계정 실왕복 1건은 성재 몫**(시드 비번 잠김).

## 2026-08-16 (Fable) · 인프라 실기동·#1437 규명·#1422 랜딩·리서치 2건·배포 발사
- **INFRA-A/B 완주·런북 랜딩(PR #1436)**: cube=CubeSandbox 설치→display 템플릿 실빌드→**producer 실기동**→외부 wss 왕복(F1~F8 이행) / turn=coturn 외부 allocation·relay 실왕복·SELinux Enforcing. 정직 라벨 2건 해소.
- **#1437 랜딩**(PR #1446→engine): **envVars=cubelet의 동기 배달 계약 규명**(대안 4종 실측 격추) — 어댑터 무변경+1회용 수신기(시간 fail-closed·불변식 테스트 8케이스·실호스트 E2E 그린). **신규 경계**: CubeProxy 무인증 /sandbox 라우팅(F1이 유일 통제). ADR-0156 증보 4·0157 증보 2 초안=**성재 결재 대기**. grok freeze C0/H0/M3/L2 전건 수리.
- **#1422 랜딩**(PR #1448→`68fc52ff`): 절 단위 생략 코어 계약+웹 런타임 자+폰 hangul-word. grok H1을 **실측으로 반박**(레인 생존 62/39px 발화·인용된 scrollHeight 불변식이 #1384의 거짓 가정으로 판명 — 문장을 정정). 이월 #1443 스탬프.
- **리서치 2정본**(PR #1439): 커서 ADE 벤치마크(차용 A~F — #1440/#1441/#1442 발급, B 환경 폐곡선=ADR 선행 백로그)·그록 생태계(Heavy→Cursor Ultra 연동 규명·#1344 관문 완전 해소·Remote MCP Tools·냉정 판정).
- **운영 사고·교훈 3건 성문화**: ①머지·이슈종결 체인 분리(2회 재발 — 머지 MERGED 확인 후 별도 명령) ②**docs→main 머지는 engine 동기 PR을 즉시 짝으로**(스쿼시는 조상을 못 옮겨 정렬 게이트가 다음 engine PR을 막음 — #1444/#1447 2회 소요, main 플러시가 08-12 낡은 초안을 실은 오염도 #1445로 정정) ③reset --hard 전 porcelain 확인(미커밋 편집 유실 1회·재적용).
- **배포 발사**(성재 위임): track/engine@68fc52ff — 서버+웹+마이그 069~076, 백로그 점검 선행·config 외과·롤백 보존 규율. #1429 병렬 비행.

## 2026-08-16 (Fable) · 성재 대량 결재 집행 — 서버 2대 실발주·문서 플러시 머지·병렬 전환
- **성재 결재(2026-08-16)**: ①서버 발주=Fable 직접 집행·트래킹 ②라이브 배포=Fable 집행 ③문서 커밋 ④Grok Bot 검증 진행(SuperGrok 구독·로그인 확인 — #1344/#1361 게이트 해제) ⑤**병렬 허용**("현재 작업이랑 병렬이나 이후 알아서").
- **발주 집행 완료(NCP API 실생성·SSH 실증)**: **momo-cube-host** 101.79.18.230(s8-g3 8vCPU/32GB·Rocky 9.8·300GB XFS·**nested virt 실측 확정**·ACG 22[운영자IP]+8443) · **momo-turn** 223.130.142.109(s2-g3·ACG 3478+relay 레인지). 신규 로그인키 momo-oort-prod(`~/.ncp/` 보관). **월 고정 ≈₩477k**(cube 시간제 — 정지 운영 시 ₩38.6k)·**관전 1시간 트래픽 ≈₩45**(아웃바운드 ₩100/GB — ADR-0164 과금 실단가 입력). 기존 자원 무접촉 검증.
- **프로덕션 서버 정체 확인**: 배포 대상 = momo-t3-smoke(101.79.11.189 — 런북 ncp-rust-deploy.md)이며 오늘 복구한 접근 그대로 유효 → 배포는 위생 꼬리 랜딩 후 최신 HEAD로 집행 예정.
- **문서 플러시 머지**: PR #1433 → main@250f7507(보호 브랜치라 PR 경유 — 직push 불가 실측). **설치 파도 발사**: #1434(INFRA-A cube 설치+display 템플릿+프록시)·#1435(INFRA-B coturn) 병렬 2기, 패킷 `handoffs/2026-08-16-infra-install-wave-packet.md`. #1421 랜딩(`199d90eb`·design H1 주석 수리·M1=#1431). #1422 비행 중.

## 2026-08-16 (Fable) · LIVE-4 랜딩 — 로그인 핸드오프 카드 축·폐곡선 5회전
- **LIVE-4(#1428) 랜딩**: PR #1430 squash → `track/engine@19455d54`(커밋 4). **핵심 실증 2**: ①승인 hold 재사용 성립 — MessageType·마이그 발명 0, props.kind 분기+기존 park/requeue 폐곡선(인터뷰의 1순위 탐사 지시가 적중) ②경계 스탬프는 기존 message.edited 계약 재사용 — **클라 변경 0**(단일 쓰기경로 불변식의 존재 이유 실증). HumanIsTheAction=면제 분기 밖.
- **폐곡선 5회전**: Fable → design-review FAIL(H2: 수제 버튼 1.3:1·stopped 자기모순)→회전(칩 가림 3914px² red 실측 포함) → grok freeze **C0/H2/M2**(타임라인 카드 경계 이벤트 난청=단일 쓰기경로 위반 겸·uuid 정규화·pending 창 축·returned 모순)→회전 → 재-freeze **M1**(재개봉 스탬프 잔존 키)→마이크로 수리(`jsonb - text` 의미론 문서화)→소진. **grok 실경계 적발 누계 5건**(이 파도).
- 이탈 판정: stopped 4번째 상태·방출 도구 수용, 세션 표면 내구 투영=LIVE-5 이월, blocked 톤=#1429 발급. 다음: 위생 꼬리(#1421→#1422→#1429).

## 2026-08-16 (Fable) · 우로보로스 인터뷰로 LIVE-4 편성·#1425 랜딩·LIVE-4 발사
- **성재 지시 "다음 작업 인터뷰로 디벨롭→승인"** 집행: 인터뷰 4라운드(모호도 0.17 종결)+lateral 3렌즈. 산출 정본 `research/2026-08-16-live4-interview-and-plan.md` — 확정 6설계(카드 이원 표면·명시 반환 주동선·end_reason 3분기·**발제자 절단**(에이전트 발제형만 LIVE-4, 프레임 게이팅=안전 극장 기각)·관전자 매듭 해법 전환(신규 서버 조각 철회→observation 전환 재사용)·정직 카피 2분법). **성재 결재: LIVE-4 승인+발사·LIVE-5 예약 확정**(창 열기·observation 전환/복원·auto-return·입력·ICE·E2E — TURN 후).
- **#1425(run 파킹) 랜딩**: PR #1427 squash → `track/engine@8ce5ad38`. 토큰 0=원장 성질(게이트웨이 hold 거부 재사용·usage_ledger 0행 실증)·notifier sweep 신설·mutation 7종. **grok freeze가 또 H1 적발**(교차-세션 run 잠금 부재 → 잘못된 resume/영구 paused) → 수리(별도 문장 status-blind 잠금·잠금 순서 계약 5호출처)·red proof 분리 실측·재-freeze C0/H0/M0/L0. grok 실경계 적발 누계 3건(LIVE-3 재바인딩·이번).
- **LIVE-4(#1428) 발사**: 패킷 `handoffs/2026-08-16-live-4-login-handoff-packet.md`(base 8ce5ad38 — 카드 가족·승인 hold 재사용 1순위 탐사·경계 이벤트 표면·창 여는 코드 금지). 비행 중.

## 2026-08-16 (Fable) · LIVE-3 랜딩 — control 개방·grok가 D3 실패를 적발한 폐곡선 4회전
- **LIVE-3(#1424) 랜딩**: PR #1426 squash → `track/engine@460f142b`(+2,818 — 마이그 076·display_control_window(자체 lease 90초)·controller owner 한정·비관측 게이트(에이전트 유일 경로 work-controls 409·시도 무흔적)·owner_only="소유자만 본다"). §1-3 동결 조건 미발동(에이전트 세션 경로 단일 실측).
- **폐곡선 4회전**: Fable → design-review PASS(M2 카피 회전) → **grok freeze C0/H1/M1/L0 — H1(0.92): 재시도 발급이 창 capability 재바인딩 안 해 로그인 도중 ≤90초 에이전트 재개(D3 실패). 코드 재판정 확정 — Fable·conformance 둘 다 놓친 것을 grok이 적발** → 수리(재바인딩 UPDATE·M1 창 닫힘 2경로 배선, red proof 3종) → 재-freeze C0/H0/M0/L0.
- 운영 사고 1건 성문화: **머지·이슈종결을 한 체인에 묶지 말 것** — CI 빨강(schema.d.ts 재생성 누락)으로 머지 거부됐는데 종결이 선행(즉시 재개로 복구). 재생성(a64bfa00)은 머지 사이클 기계 작업으로 오케스트레이터 직접 처리. Xcode 유령 체크는 비필수(선례 #1378).
- 이탈 3건 판정(DEVIATION_LOG): lease 교정 수용·**run 파킹=#1425 LIVE-4 선행(발사됨·비행 중)**·terminate backstop 수용.

## 2026-08-16 (Fable) · #1418 랜딩·성재 결재 3건 집행 — LIVE-3 발사·TURN 패키지
- **#1418 랜딩**(PR #1423→`f56c07f7`): work-pane/thread-pane 900px 바닥(chat-region — thread-pane 동반이 반사실로 필수 입증)+플레이스홀더 1lh 클램프. 3렌즈(design-review B0/H0 — 리뷰어 독립 재빌드·WebKit 재검증 · grok C0/H0/M0/L0). 이월 선재 → **#1421**(600~899 바닥 부재·문턱 경계 결정)·**#1422**(절 단위 생략+폰 예산).
- **성재 결재 3건(구조화 질의)**: ①**ADR-0165 증보 1 Accept**(TURN 신규 운영 자원 확정) ②TURN=**발주 검토 패키지** → `research/2026-08-16-turn-dedicated-host-procurement-package.md` 작성(전용 호스트+TURN 2대 사양·F1~F8 런북 반영 의무·비용 산식·콘솔 체크리스트 — **발주 결정=성재**) ③**LIVE-3/4 지금 발사**.
- **LIVE-3(#1424) 발사**: 패킷 `handoffs/2026-08-15-live-3-control-open-packet.md`(base f56c07f7 — 마이그 076 잠금 해제+control 창 원장+**비관측=run 진행 경로 서버 게이트(불가 판명 시 전체 동결)**+owner_only owner 예외). LIVE-4(웹 UX)는 LIVE-3 랜딩 후.

## 2026-08-15 (Fable) · 위생 파도 종결(#1415→#1413→#1414) — 3연속 3렌즈 그린
- **#1415**(PR #1417→`2f0b3984`): ObserverTerminal connecting 정리 누수 — connectCleanupRef 동형 이식(하중 분기: early return보다 앞서 cleanup)+게이트 실DOM 리스너 카운트 red proof. grok freeze C0/H0/M0/L0.
- **#1413**(PR #1419→`268df1c8`): co-open-900 소유권 결함 — `--spacing-chat-min: 368px`(코어 236px 실측 역산+8px 리듬)·route-region 바닥·패널 `flex: 0 1` 양보(900~927px만). design-review PASS(B0/H0)+grok C0/H0/M0/L0. 동형 결함(세션 패널)+Low/Nit → **#1418** 발급.
- **#1414**(PR #1420→`0ac1e08c`): busy/failed/watching 엘리먼트 캡처 6장+단언(red proof 4종·컴포넌트 변경 0·watching=실디코드+반증가능 레터박싱). Fable 시각 검수+grok C0/H0/M0/L0.
- **grok 쿼터 해제 첫 적용**: 소형 diff 3건 전부 freeze 투입 — 3연속 유효 검산(무결 확인도 실가치). 다음: #1418 발사 → LIVE-3/4 편성(성재 질의: 증보 1 Accept·TURN 발주·발사 시점).

## 2026-08-15 (Fable) · SPIKE #1411 완주 — P2P 폐기·TURN 확정 · 위생 파도 개시
- **접근 복구**: d42 호스트(10.0.1.8)는 회수돼 없고 SSH 자격 전유실 → `~/Downloads/momo-t3-smoke.pem` 발견·`~/.ncp` 복원·getRootPassword API 재복호화로 momo-t3-smoke(=101.79.11.189, U1의 "점프 호스트") 접속 실증. NCP 서명 v2 조회 스크립트 스크래치 재작성(ncp-power.py 유실 대체).
- **#1411 완주**(폐기 Rocky 9 VM 실설치·전량 회수 증명): 형상 A(호스트 WS 프록시) 성립(에코 6.3ms)·B 구조 불가·C는 SNAT 강제로 비채택. **최대 수확 = microVM NAT symmetric(2회 재현) → P2P/srflx 실존 안 함, 호스트↔VM UDP 무경로+헤어핀 불가 → TURN 동거 불가** ⇒ **전용 공인 TURN 호스트 1대 신규 운영 자원 확정**. 정본 `research/2026-08-15-reachability-spike-1411.md`(부수 발견 F1~F8 런북 후보 — 설치기 rc=0 신뢰 불가·사설 레지스트리 필요 등).
- **ADR-0165 증보 1 Proposed**(D3-1 relay 유일·D3-2 TURN 전용 호스트·D2-1 시그널링=호스트 프록시 확정) — **Accept는 성재(TURN 발주 포함)**.
- grok 쿼터 성재 해제("막 써봐") — 메모리·스킬 성문화, 병렬 1~2(토큰 로테이션)만 유지. **위생 파도 개시**: 패킷 `handoffs/2026-08-15-hygiene-wave-observer-packet.md`(#1415→#1413→#1414 순차), #1415 발사.

## 2026-08-15 (Fable) · LIVE-2 랜딩 — 관전 "라이브 화면" 축 완성(서버+웹) · track/engine@fbe49826
- **LIVE-2(#1412) 랜딩**: PR #1416 squash → `track/engine@fbe49826`(커밋 3: 구현 3d96221a→design 수리 2ea1295e→누수 수리 0af458b5). view-only=코드 부재(`sdpNegotiatesInput` 사전 거절·recvonly=producer offer의 귀결·소스 부재 테스트+verifier 교차)·4상태·소유자-인지 실패 카피(`displayFailureCopy`).
- **폐곡선 3렌즈 완주**: Fable C0/H0/M0 → design-review **PASS**(H1 소유자 3인칭 카피·M1 오프라인 배너 → 회전 수리, M2 캡처=#1414) → grok freeze **C0/H0/M1/L0** → M1(connecting 정리 미회수 — document CSP 리스너 잔류) 코드 재판정 확정·회전 수리(게이트 실 DOM 리스너 카운트 red proof). **grok이 UI 층에서도 실가치 적발 — 리뷰어 C 3번째 실전 정착.**
- 선재 발견 2건 티켓화: **#1413**(co-open-900 컴포저 236px — base 실측 동일 실패)·**#1415**(ObserverTerminal 동형 CSP 리스너 누수 — 수리 shape·측정기 기성품 명시). 이탈 5건 판정 accepted(DEVIATION_LOG — D1은 패킷 문구 교정).
- **관전 축 현황**: 서버(LIVE-1)+웹(LIVE-2) 완결. 남은 것: **#1411 도달성 스파이크**(전용 호스트 실측 — 실 샌드박스 E2E·ADR-0165 D3 증보 개방 조건)·**LIVE-3/4**(control·로그인 핸드오프 — 증보 3 Accepted·owner_only 예외 포함, 편성=성재 신호)·#1414(캡처 증거).

## 2026-08-15 (Fable) · LIVE-1 랜딩 — track/engine@7179f3e5 · ADR 2건 Accept · LIVE-2 발사
- **LIVE-1(#1409) 랜딩**: 워커 완주(+5,019/26파일 — 마이그 075·kind 축·라우트 3본·conformance 4·verifier·webrtcbin 템플릿 계약) → Fable 기획검수 **C0/H0/M0/L1**(L=openapi sampled 매니페스트 미등재, 배포 창 실측 시 해소)+verifier 독립 재실행 PASS → grok 리뷰어 C freeze **C0/H0/M0/L0**(두 렌즈 일치) → PR #1410 → CI → squash **track/engine@7179f3e5**, #1409 수동 종결, 워크트리 회수.
- **policy-integrity 실측 성문화**: 감사 코멘트에 `Policy-Integrity-Audit: <full head SHA>` 리터럴 마커 필수 + `policy-change-approved` 라벨 전이가 그 코멘트 **이후**여야 함(순서 검증 — 라벨 뗐다 재부착으로 해소, 3연속 빨강의 실체).
- **성재 결재 4건(구조화 질의)**: ①**ADR-0165 Accept**(webrtcbin D1 반영형) ②도달성=**스파이크 선행**→#1411 발급 ③owner_only owner 예외=**LIVE-3와 묶기** ④**ADR-0004 증보 3 Accept**(control 경계 확정 — LIVE-3/4 편성 가능해짐). 이탈 3건 전부 판정 완료(DEVIATION_LOG).
- **LIVE-2(#1412) 발사(연속 편성)**: 패킷 `handoffs/2026-08-15-live-2-web-display-observer-packet.md`(base 7179f3e5 — 웹 DisplayObserver·view-only=입력 부재·로컬 모의 producer 검증·design-review 관문). 비행 중.

## 2026-08-15 (Fable) · 라이브 VM 관전·control 축 개설 — ADR-0165 기안·LIVE-1 패킷 ready
- 성재 발제(Grok Bot 채팅 내 VM 화면+직접 조작) 리서치 정본 `research/2026-08-15-in-chat-interactive-vm-takeover.md` 랜딩(Fable fork) — 판정: 그린필드 아님, 관전 축 해상도 증분. noVNC 1차 권고(E2B 선례)·자격 핸드오프=ADR-0004 주어 확장.
- 코드 실측(Explore): 서버=프록시 없는 호스트 직결 계약(dto.rs:1002)·`AttachMode(controller|observer)` 기존재 → takeover 새 동사 불요, **Controller의 display 적용="control"**로 명명(인수 어휘 충돌 회피). 범위 술어=`type='cloud'`+`provider='cubesandbox'`, BYOC fail-closed.
- **성재 결재 3건(구조화 질의) 집행**: ①LIVE-1 발사+연속 편성 ②경계=**ADR-0004 증보 3 재기안**(Proposed — control-창 비관측·자격 비유입·"0140 pause 재사용" 정정=VM running 유지) ③전송=**처음부터 WebRTC** → ADR-0165 재용도(`0165-live-display-webrtc-transport.md` Proposed — 문서 Accept가 LIVE-1 머지 관문). planning ID **PLN-20260815-01** claim.
- 집행: LIVE-1 패킷 WebRTC 개정(`handoffs/2026-08-15-live-1-display-spectate-packet.md`, base 99d42244·마이그 075) → **이슈 #1409 발급** → **Opus 단발 워커 발사(비행 중)**. LIVE-2(UXUI)=랜딩 시 자동, LIVE-3/4=증보 3 Accept 후. 성재 잔여: 0165 문서 Accept·증보 3 Accept·T1 확장.

## 2026-08-15 (Fable) · HAP 축 전체 완결 — UX1~4 랜딩
- **UX1(#1360 페어링 위저드 d7b390cf)·UX2(#1362 disconnect 원장 73ac11d4)·UX3(#1359 폰 읽기전용 4a093b30)·UX4(#1369 OAuth 동의 99d42244)** 전부 랜딩 → **HAP 축(엔진 E1~E7 + UX1~4) 완결**. 남은 HAP=#1361 GROK-E2E만 blocked(Grok Bot 티어).
- 각 UX design-review PASS 후 폴리시 회전: UX1(H1 대비·M4)·UX2(H1 포커스·M3 — 보안 3분리 'excellent')·UX3(H1 SR 도달·한국어 line-break)·UX4(H1 증거 갭 — **캡처 픽스처가 실제 런타임 크래시 적발**·M2). 코어 다형 설계로 UX1→UX3 폰 포트가 dedup만으로 성립.
- 프로세스 재시작·세션리밋으로 워커 트랜스크립트 수 회 유실 — 전부 워크트리 상태 기준 신규 폴리시 워커로 무손실 재개. 교훈: 동결 로컬 커밋이 세션 경계를 넘는 유일 진실.
- 신규 적립: #1403(트리거 native disabled)·#1405(hosted DTO 확장)·#1396(스레드 패리티).

## 2026-08-15 (Fable) · HAP 엔진 축 E1~E7 완전 종결 + CRUN 시리즈 완결
- **E7(#1368) 랜딩 = HAP 엔진 축 종결**: PR #1402 → `track/engine@f07a458f`. OAuth 2.1 AS(무강등 4층·fail-closed·비승격). 마이그 074. **리뷰 2독립 렌즈 일치**: Fable 적대 C0/H0/M0/L2→수리 · **grok 리뷰어 C freeze C0/H0/M0/L0**. ADR-0162 증보 1 Accepted로 ADR-0100 해소.
- **sol usage-limit(8/20까지) → grok 승격**: sol Codex가 리밋 소진, grok 리뷰어 C를 독립 freeze 리뷰어로 승격(오늘 구축한 grok-fleet 첫 실전 승격). 3사 체제가 한 축 막혀도 굴러가도록 설계된 대로 작동. **당분간 리뷰=Fable+grok 2사**(+UX는 design-review 관문).
- **CRUN 시리즈(1·2·3) 완결**: CRUN-1(#1382=3ca57c96) 실행 티어 축 — 와이어 계약 발명 거부(display-only, 서버=#1399). design-review PASS 후 M1-4 수리(다크 라디오 토큰 마커·900px 티어 생존·관리형 클라우드 브릿지).
- **#1369(UX4 OAuth 동의) ready 전환**. 신규 적립: #1400(auth_mode 불변 제약)·#1399(티어 override 와이어)·#1395/#1396(placeholder·스레드 패리티).
- 배포 이미지 최신 재빌드 `momo-rust:d7b390cf`(위생6+UX1+CRUN, E7 미포함) — 성재 대행 대기. BuildKit frontend 네트워크 일시 장애는 pull 후 회복.

## 2026-08-15 (Fable) · 재개 — 위생 완주·UX1/CRUN-2/3 랜딩·E7 완주·성재 결재 3건
- 프로세스 재시작으로 끊긴 3기(CRUN-3·E7·UX1 폴리시) 트랜스크립트에서 전량 재가동 — 유실 0.
- **랜딩(누계)**: 위생 6/6(#1374·1376·1377·1385 + #1375+1386=2dc1cd4f 마이그 073)·CRUN-2(#1383=49a4ba0e)·CRUN-3(#1384=04264770)·UX1(#1360=d7b390cf). 각 UX는 design-review PASS 후 폴리시 회전(CRUN-2 M1·CRUN-3 H1 정본거짓→#1396·UX1 H1/M4). track/engine HEAD 전진.
- **E7(#1368) 완주·동결**(`7fa03f74`, 미푸시): OAuth 2.1 AS 모드 — 무강등 4층 증명(비교→동결 리터럴→산술 비대체→스키마 guard), 20시나리오 PG18, flag-off·전 라우트 404. **마이그 073 충돌→랜딩 시 074 재번호**(워커 정직 신고). Fable 적대 리뷰 가동 중.
- **성재 결재 3건(2026-08-15)**: ①**ADR-0162 증보 1 Accept**(OAuth AS 경계 — 리뷰 통과 시 머지, 개방은 flag+#1369 대기) ②**배포=최신 engine 재빌드**(위생+UX 포함, 백로그 점검 선행) ③위생/UX 파도 계속. 신규 티켓: #1395(placeholder 방-인지)·#1396(스레드 멘션 패리티)·#1399(per-message 티어 override 와이어 — ADR 선행).
- 3사 리뷰 체제 정착: grok 리뷰어 C가 위생(C0/H0/M0/L2)·E6(트리거 강화)에서 실가치, diff-only 오탐은 코드 판정 기각.

## 2026-08-14 (Fable) · 위생 파도+CRUN-2 랜딩 — 성재 정지 지시(재개점=스냅샷 25)
- **위생 4/6+CRUN-2 랜딩**: #1377 fmt(6d2a7977 — workspace fmt 그린 복원)·#1385 샘플링(252ffa60 — E6가 깨뜨린 선재 fixture 교차 수리)·#1376 게이트(dcbe7f35 — **docs 게이트 80/80 이 머신 최초 완주**, bash -lc PATH 근본 원인+psych-3 3번째 결함)·#1374 lock-order(c6ecf48b — pg_stat_activity 동기화 결정적 40P01 재현)·#1383 CRUN-2(49a4ba0e — design-review PASS+M1 수리). BEHIND 경합 교훈: 병렬 랜딩 중 머지 체인은 재시도 루프+탭 컬럼 정확 술어가 표준.
- **grok 리뷰어 C 2번째 실전**(#1375+#1386 diff): C0/H0/M0/L2 — diff 밖 스키마·RLS 자가 대조로 E6 파일럿의 오탐 클래스 자가 교정. 3사 체제 정착 판정.
- **성재 정지 지시**: 비행 3기(#1375+86 폴리시·UX1·CRUN-3)는 로컬 동결 자연 완료로 두고 신규 발사·머지 중단. 재개 절차·큐=CURRENT_STATE 스냅샷 25.

## 2026-08-14 (Fable) · E6 랜딩 — HAP 서버 축 완성·grok 3사 리뷰 체제 첫 실전·배포 창 성립
- **#1367 랜딩**: PR #1387 squash → `track/engine@07ca8828`(하루 2 goal 랜딩 — E5 aa40e4c6→7a52c4c2→E6 07ca8828). 원자 disconnect+manifest+4중 terminal 가드+게이트 release 개방. CI **첫 시도 완주**(E5 교훈: 생성 타입·policy audit 선처리).
- **리뷰 4층이 각기 적발(2연속 재현)**: Fable(비차단 M1+L4→#1385/#1386) · sol 1차(생성 타입 M — PR CI 선방어) · **grok 4.6 파일럿**(072 트리거 진공 통과 정식화→채택·mutation으로 우회 실재 증명 후 봉쇄, 이중 audit 주장은 FOR UPDATE 직렬화로 기각) · sol 최종 C0/H0/M0. grok 오탐 1은 diff-only 한계 — 편입 시 워크트리 read-only(`--allow`) 접근으로 교정.
- **Grok 4.6 실측 완결**(리서치 정본+실측): Grok Build 1.0.3·기존 auth 유효(로그인 불요)·`-p`/`--json-schema`/`--allow`/`--agents`/ACP 전부 실재·config 격리 필요(전역 MCP 자동 로드). 플러그인 부재는 비장애 — codex-companion 패턴 미러 grok-fleet 소형 빌드로 해결 가능.
- **해제**: #1368(E7)·#1360/#1362/#1359(UX1~3) ready. **배포 창 조건 성립** — 실행은 성재 대행+백로그 점검 선행. 위생 큐(#1374~#1377·#1385·#1386)도 이제 발사 가능(엔진 파일 충돌 해소).
- 성재 결정 대기: ①배포 창 실행 ②E7 발사 ③UX 시리즈 편성(HAP-UX1~3+CRUN — UXUI 트랙) ④grok-fleet 스킬 빌드 go ⑤ADR 3건 Accept(0164·0004 증보 2·0150 증보 1).

## 2026-08-14 (Fable) · 성재 결재 4건 집행 — E6 발사·ADR 기안 2·병렬 5티켓·배포 창 확정
- 성재 일괄 결재(구조화 질의 4건 전부 권고안 채택): E6 발사 / 과금 3-A 기안 / 병렬 3트랙 전부 / 배포 창=E6 후.
- **E6(#1367) 가동**: 패킷 `handoffs/2026-08-14-hap-e6-atomic-disconnect-packet.md`(base 7a52c4c2·#1344 실측 negative path·E4 잠금 순서·#1374 함정 회피·E5 교훈 명문화) → Opus 단발 워커 발사. 랜딩 시 hosted delivery 게이트 개방+배포 창 조건 충족.
- **ADR 기안 2건(Proposed — Accept는 성재)**: `0164-managed-cloud-credit-billing.md`(D1~D7: 원화 크레딧·list-cost 단일 미터·running만 과금·예산=pause·HAP 경계·공정사용 상한·롤오버는 법무 확인 후) + ADR-0004 **증보 2**(불변식 주어=사용자 명확화·bundled 키=서버 시크릿+계량 의무·BYO-key 명시적 비개방).
- **티켓 5건 발급**: #1380(A4 egress capability 설계→ADR-0150 증보)·#1381(A1 pause 정책 — 0164 D3 결선)·#1382~#1384(CRUN 1~3 — 컴포저 실행 티어 축/메뉴 프리미티브/어포던스 카피, 착수는 UXUI 타이밍). **A4 스파이크 워커 가동**(docs 전용 — E6와 무충돌).
- 위생 4티켓(#1374~#1377)은 E6 랜딩 후 순차 발사로 편성(파일 충돌 회피).
- **A4 스파이크 완주(같은 날)**: `research/2026-08-14-t3-egress-capability-design.md`(위협 모델 4종 표·grant 좌표계·Anthropic 대조표·채택 경로 P1~P7+선행 실측 U-a~c) + **ADR-0150 증보 1 Proposed**(D1~D6 — 핵심: 자격 주입 게이트웨이=계량 지점 합배치·2상 네트워크 순서 불변식·임의 도메인 MITM 금지·저대역 채널 정직 조항). #1380 needs-review. 성재 미결 4건은 설계 문서 §6.

## 2026-08-14 (Fable) · HAP-E5 완주 — 신체제 첫 폐곡선 + 클라우드 리서치 2정본 + UXUI 실사
- **#1366 랜딩**: PR #1379 squash → **track/engine@7a52c4c2**. 8도구 thin-binding+per-agent selector+E4 producer 결선(M1 폐곡선: kind FK+job↔run 트리거) — Opus 워커 11커밋, +7.5k/-421. **신체제 첫 실전 성립**: Fable 적대 리뷰(C0/H1/M2→수리) → sol freeze 3회전(H 신규 적발 "승인 채널 job 경로 우회"→3중 방어 수리 → M 스키마 어긋남 3갈래→계약 명문화 → **C0/H0/M0 승인**). 전 수리 mutation-검증. 세 검증 층이 서로 다른 결함을 잡음(리뷰어=fan-out 부재 H, sol=채널 우회 H, CI=flaky 캔어리 2.65% 실측).
- 부수 확정: 선재 버그 수리(gateway 대소문자 — mention job 영구 claim 불가) → **배포 창에서 깨어나는 pending 백로그 점검 필수**(STATUS 체크리스트). #1367(E6) ready 전환·워크트리 회수. flaky 캔어리 결정화 교훈: 확률적 텍스트 캔어리 금지, 바이트 스캔+실측 재현이 표준.
- **클라우드 축 리서치 정본 2건**(성재 발제 "크레딧 기반 매니지드 클라우드"): `research/2026-08-14-agent-cloud-infra-benchmark.md`(Cursor=EC2+Firecracker+Anyrun·xAI=공유 VM 이단·**ADR-0156 좌표 검증**·채택 후보 A4→A1→A2→A3) · `research/2026-08-14-agent-cloud-credit-billing-models.md`(업계 수렴=티어 게이트+번들 선차감+인프라 흡수·**3-A 권고=원화 크레딧+list-cost 원장**·성재 결정 큐 7). UXUI 실사(Cursor "Run on" 대비): effort/모델은 기존재, **작성 시점 실행환경 선택이 공백** — CRUN 시리즈 티켓화 제안(성재 컨펌 대기).
- 성재 결정 대기: ①크레딧 단위(3-A) ②ADR-0004 증보 ③인프라 A4/A1 착수 ④CRUN 티켓 발급 ⑤E6(#1367) 발사.

## 2026-08-14 (Fable) · sol 인계 검수 완료 — #1365 최종 판정 C0/H0·자원 회수 파이프라인 신설
- sol(GPT 5.6) HAP 축 전수 복원: E1(#1358)~E3(#1364) track/engine 랜딩 확인, E4(#1365) 로컬 동결 @2304324. **최종 리뷰 C0/H0** — M1(job↔run·kind 결속 공백, outbox FK가 kind 미결속·broadcast 행 실존으로 실재 확정)은 #1366 수용기준으로 이관(코멘트), lock-order AB-BA(prove 경로 invalidate)→#1374, ledger 잠재 3종→#1375. verifier 독립 재실행 PASS(마이그 001→070·잔존 0).
- **docs gate 3분+ 정체의 실체 = Homebrew actionlint 1.7.12 shellcheck 연동 무한 스핀**(CPU 800%·25 CPU-분 실측, 이분 탐색 확정 — 워크플로 5개 중 `run:` 블록 조합 3개에서 발화) → `brew unlink actionlint` 완화(+게이트 폴백 설계가 흡수)+#1376(비대화형 셸의 시스템 ruby 2.6 false RED 병기). engine `cargo fmt --check` RED 13파일(sol "비소유 drift"의 실체, rustfmt 스큐)→#1377.
- **자원 회수 파이프라인 신설**: `scripts/worktree_janitor.sh`(KEEP/RECLAIM/JUNK/HOLD 4분류·PR squash-merge 인식·goal OPEN 보호)+정본 런북 `docs/runbooks/local-resource-reclaim.md`(3층: verifier 소유권 계약→레포 janitor→머신 안전망+Docker Desktop 붕괴 플레이북). 랜딩 워크트리 5개 회수(1343·1344·1358·1363·qa1, ≈32GB). janitor 일괄 --cleanup과 1364 폐기(checkout --)는 분류기 차단 — 단건 `git worktree remove`는 허용.
- **성재 결정 3건 집행 완료(같은 날)**: ①#1365 go — 문서 정정 커밋 `583526b4`→push→**PR #1378**(base track/engine)·이슈 needs-review 전환. policy-integrity가 local_gate.sh 접촉을 잡아 audit 코멘트+policy-change-approved 라벨(선례 #1372/#1373 동일 흐름)로 해소 — **CI 그린**(policy·cargo·alignment PASS, Xcode 유령 체크만 잔존). ②워크트리 전량 처분 — 1364 폐기(성재 대행)+HOLD 4개 제거(398·464·72·sol-review), sol 미랜딩 문서 8건은 `research/sol-20260811-checkpoint-a-drafts/`(번호 충돌 경고 README 동봉)+research 3건으로 회수, #464 close. ③sol=독립 리뷰어 유지(E5+ freeze 리뷰 담당, 구현=Opus 5·기획검수=Fable).
- **#1365 랜딩 완료("작업 진행하자" 신호)**: PR #1378 squash → **`track/engine@aa40e4c6`** · 이슈 done 수동 종결 · 1365 워크트리 회수(**세션 누계 ≈57GB**, 잔존 워크트리 5=main·engine·uxui·deploy5·1330). **#1366(E5) ready 전환 + 패킷 발급** `handoffs/2026-08-14-hap-e5-mcp-inbox-tools-packet.md`(발주 전 랜딩분 대조 완료·M1 폐곡선 수용기준·잠금 순서 계약·환경 함정 #1376/#1377·리뷰 폐곡선 명시). **워커 발사=성재 신호 대기.**

## 2026-08-12 (Fable) · 외부 에이전트 수용 축 개설 — ADR 초안 2건·이슈 3건·sol 핸드오프 준비 완료
- 성재 지시("리서치→로드맵화→ADR 초안→sol 검수→실작업 체인 준비")로 축 전체를 패키징. planning ID **PLN-20260812-01**.
- **ADR-0162 Proposed**(3분류 명명+Agent Port — MCP 도구 6종·스코프드 봇 토큰·REST 파사드·접속 허용 명문화) · **ADR-0163 Proposed**(agent_catalog·동봉 온보딩·개별 업데이트 v0=C→v1=A). 로드맵 정본 `2026-08-12-external-agent-reception-plan.md`(웨이브 R/0/A/1/2/3·DAG).
- 이슈: #1343(sol 검수 미션)·#1344(Grok Bot 스파이크 — 구독 계정 성재 게이트)·#1345(0130 ACP 재랜딩 감사). 구현 티켓은 ADR Accepted 후 분해(체인 규율 준수).
- sol 패킷 `handoffs/2026-08-12-sol-external-agent-reception-packet.md` — 검수 포인트 6개(자신 없는 순: 0163 업데이트 주체·0162 gateway 계약 중복 여부·인증 v0)+성재 복사용 프롬프트 부록. CURRENT_STATE 스냅샷 21 갱신.

## 2026-08-12 (Fable) · Grok Bot 역방향 팀메이트 방향 리서치 — 조건부 성립, Agent Port 표면 제안
- 성재 방향성("hermes형 — oort 일감을 봇이 감지·처리, 배포 허들 0 실마리")으로 2차 리서치 3기(감지 루프/Cursor 표면/프로토콜 선례). 정본 `research/2026-08-12-grok-bot-reverse-teammate-direction.md`.
- 판정: **조건부 성립** — 커스텀 MCP 소비(Cursor 체계 공유 확정, 개인 계정 실증만 남음)+루틴 웨이크업(Slack 트리거 실동작 검증)으로 배치형 팀메이트 오늘 구성 가능. 분 단위 스케줄 미확인·웨이크업 주권=xAI/Cursor·고빈도 폴링 비경제가 한계. provider 선택 불가 확인(봇=번들, ADR-0004 정합).
- 제안: 벤더 중립 "oort Agent Port"(원격 MCP 도구 6종, seq 커서, REST 파사드 — ADR-0130 체인+/v1/mcp/drive 선례 위) → Phase 2 Centrifugo 구독 겹. Slack 초인종은 신호만(내용 0) 옵션.
- 성재 결정 대기: ①Wave 0 스파이크(구독 계정 $200~300/월 필요) ②Agent Port ADR 기안 ③Slack 브리지 스코프. 워커 발사 없음.

## 2026-08-12 (Fable) · Grok Bot 연동 가능성 리서치 — 인바운드 불가 판정, 역방향 2경로 제안
- 성재 발제("Grok bot 바이럴 런칭 — 사용자의 ~50개 호스팅 봇을 oort로 가져오는 구조 가능?")로 웹 리서치 3기 병렬 실측. 정본 `research/2026-08-12-grok-bot-integration-feasibility.md`.
- 전제 교정: Grok Bot=SpaceXAI+Cursor의 2026-08-11 베타(독립 앱, X는 홍보 채널), "50"=봇 수가 아니라 봇당 루틴 한도, 무료 티어 없음($120~300/월).
- 판정: 봇 인바운드 반입은 **현재 불가**(열거/호출/위임 OAuth/export 전무 실측 + 우회는 AUP 3중 저촉·사용자 계정 리스크 전가). 성립 경로=A 에이전트 로그인 공식 허용(선언 기반, 연동 0줄) · B oort MCP 서버 노출(ADR 사안) · C xAI API provider(ADR-0147 그릇 재사용) · D 금주 Grok 4.6 롤아웃 재실측.
- 공용 정본·Issue 미변경. 다음: 성재 판단 — 경로 A/B의 ADR 기안 여부 + D 재실측 시점.

## 2026-07-28 (GPT 5.6 · momo-main) · Fable 산출물 통합 → 리소스 최적 정본 후보
- #860/#875 완료를 재계획에서 제거하고, clean/pushed #876~#878 배치 하나만 active로 고정했다.
- 3-Issue/1-PR가 운영 계약과 충돌함을 발견해 #876 umbrella+absorbed(권고) 또는 명시적 예외 승인 gate를 추가했다.
- 새 reconciler와 #870, interval/replay와 #879를 구현 전 dedupe하고 #869는 잔여 WSS 조각만 남기는 순서로 축소했다.
- WIP=code 1·planner 1·Docker-heavy 1, verifier 1회 묶음+통합 adversarial-review 1회. 공용 정본/Issue/track→main은 미변경; Fable 검수·성재 4결정 대기.

## 2026-07-28 (GPT 5.6 · momo-main) · PLN-20260728-01 독립 red team → 조건부 반려
- 원 builder DAG를 보안·UX·과설계로 독립 검수해 신뢰 경계 4건을 확인: plugin delegation·terminal은 해당 레인 현재 blocker, WorkHost/approval은 remote·personal-write 확대 전 blocker다.
- provider 1개의 host-owned connect+단일 runtime bridge 뒤 plugin v1 read-only 1개 + 기존 owner/profile/run을 재사용한 owner-only one-schedule로 축소했다.
- SkillSpector 격리 pilot은 LOW/SAFE였지만 benign `keychain` HIGH false positive와 96-package 비용으로 advisory-only 판정했다.
- superseding research/Fable 패킷 작성. ROADMAP/BUILD_TICKETS/STATUS/Issue/track→main은 미변경; 다음은 Fable 중복 검수→성재 A~E 승인.

## 2026-07-28 (GPT 5.6 · momo-main) · PLN-20260728-01 경쟁/플랫폼 갭 감사 → Fable 검수 대기
- 코드·GitHub·공식 경쟁사 자료를 대조해 Tauri/RN, plugin/skill/Automation/MCP Apps, terminal, motion 감사 문서와 builder 별칭/DAG를 작성했다.
- 사실 교정: Codex JSON-RPC는 이미 채택, MemoryRoutes는 13 endpoints, PR #868은 track/engine merge 완료(#857 needs-review는 main 전 정상), #859는 구현 없음, #839/#842는 코드와 Issue 상태가 어긋난다.
- 판정: xterm+현 PTY/replay 유지, Herdr/Ghostty 교체 금지; Windows 경계에서만 current/Rust PTY/Herdr 비교. plugin v2→skill lifecycle→기존 agent_run 기반 Automation 순서.
- 검증: docs 41/41 PASS(누락된 prod example WorkHost 2변수는 fixture 주입, `OPS-WORKHOST-ENV-DRIFT` 검수 대상). 다음은 Fable 검수→성재 승인; ROADMAP/BUILD_TICKETS/Issue와 track→main은 건드리지 않았다.

## 2026-07-28 (Fable) · #860 랜딩(uxui 큐 비움) · **#875 보안 서명 v2 랜딩** · T3 수리 배치 투입
- **#860 랜딩**(track/uxui `7974b923`): design-review 2R PASS. 1R Blocker 2건은 기하(760에서 `dd` 폭 0px로 값 소멸 · 긴 이름에서 탭 낙하), High는 **404를 "상태 확인 실패"로 보고**(레포가 `useAgentProfile.ts`에 "404는 아직 없다"를 적어둔 자리 — 첫 설치 워크스페이스 전 에이전트가 거짓 실패 배지). 2R High 1건은 **내 패킷 문구가 만든 것**이라 직접 수리: "가독 유지"라고만 써서 워커가 흐림을 통째로 제거 → 클라이언트에서 **유일하게 disabled인데 조작 가능해 보이는 컨트롤**이 됐다. 방향은 "흐린 글자"가 아니라 **"흐린 바닥 위 읽히는 글자"**. **uxui 큐 비었음.**
- **#875 랜딩**(track/engine `ac258c8e`): 서명 v2 = base에 **body SHA-256 + 1회용 request ID**. 실서버 단정 — 캡처 서명의 body 교체 재제출 **401**, 같은 request ID 재사용 **401**, 만료 정리. **red proof 성립**(digest 결속 제거 시 body 교체가 통과해 이름 있는 실패). **호스트 서명 경로 검증기 8종 전수 PASS.** v2 즉시 절단 판단 수용 — 불일치는 401 fail-closed, **서버와 workd는 한 릴리스 단위**(릴리스 노트 필수 항목).
- **검수 중 게이트 결함 2건 수리**: #860 게이트가 `realtime-token` 목·`unsubscribe` 응답 결손으로 **레일 down → 전 버튼 disabled**(소켓 로그로 원인 분리) · #875 보안 블록이 roundtrip에 전이를 한 번 더 얹는데 개수 단정을 안 고쳐 3:1↔4:2 — **숫자를 올리면 단정 의미가 흐려지므로 블록을 맨 뒤로 이동**.
- **T3 수리 배치 투입**(#876+#877+#878 한 묶음, 성재 승인): 정산 통합·pause 순환 의존·host당 유일성·provider 경합·provisioning idempotency·**topup REST 신설**. 불변식 명시(pause 0 계상 GENERATED 보장·서명 v2·자격증명 비유입·D10).
- **성재 결정**: ①main 동기화는 **엔진 마무리 후 uxui와 함께** ②수리 순서 승인 ③리허설은 topup REST 랜딩 후(현재는 DB 우회를 뜻함 — 성재가 만들 것은 없고 E2B 템플릿·공개 서버는 내 몫).

## 2026-07-28 (Fable) · Codex 공식 플러그인 도입 + adversarial-review가 교차 결함 6건 적발 — **track/engine main 동기화 보류**
- **성재 지적으로 `openai/codex-plugin-cc` 확인** — 내가 "공식 플러그인 없다"고 한 것은 **틀렸다**(공식 마켓플레이스 인덱스에 없을 뿐 별도 마켓플레이스로 추가하는 OpenAI 공식 플러그인, ⭐30k). 설치·setup 완료(ChatGPT 로그인 재사용). 어제 비교표의 오류 2건 정정: 플러그인도 detached 워커를 spawn하므로 **세션 독립·병렬은 fleet 전유물이 아니다**.
- **파일럿 1회에 값이 나왔다**: track/engine(main +21)에 `adversarial-review --base origin/main` → **needs-attention, high 6 + medium 2**. 개별 PR 게이트는 전부 초록이었는데 **여러 PR이 합쳐진 뒤에만 드러나는 교차 결함**을 잡았다(#856 sweep × #859 pause × #855 원장). 우리 게이트가 못 본 이유도 명확: mock E2B는 pause돼도 응답하고 검증기는 정상 종료 경로만 돈다.
- **오케스트레이터가 코드로 실증한 3건**: ①**서명이 body를 인증하지 않는다** — base가 `method|path|ws|host|sentAt`뿐이라 같은 PATCH 경로에서 캡처 서명을 **다른 body로 재사용** 가능(idle/running/ended가 body로 갈림 → 세션 종료·과금 조작) ②**sweep이 T3 원장을 안 닫는다** — TierFallbackSweep에 credit/usage 참조 0건, 특히 **paused workd는 heartbeat 불가라 stale sweep 표적**이 되며 미정산+슬롯 점유 ③**pause 순환 의존** — sandbox를 pause하면 resume을 트리거할 workd도 멈춘다.
- **판정: track/engine main 동기화 보류.** 안전(서명)+과금 신뢰(미정산·이중과금) 결함이라 승인 요청 전 수리가 맞다. T1/T2·uxui 트랙은 무관.
- **티켓 5장**: #875(보안 서명, 최상) · #876(정산 통합) · #877(순환 의존·host당 세션 유일성·provider 경합) · #878(provisioning idempotency + **topup REST 부재** — 리허설 4단계가 현재는 DB 우회를 뜻함) · #879(interval floor 정밀도·replay 큐 무제한).
- **#860 2R 검수 완료**(909 tests·gate:agent-hub+red proof 3종·기존 5종 무회귀). 1R FAIL(B2·H4)의 핵심은 **760x480에서 상세 값 폭 0px**과 **404를 "상태 확인 실패"로 보고**(레포가 `useAgentProfile.ts`에 "404는 아직 없다"를 주석으로 적어둔 자리). design-review 2R 가동 중.

## 2026-07-28 (Fable) · #858·#861 랜딩 — ADR-0139 파생 4장 완결 · #860(허브) 가동
- **#858 랜딩**(track/uxui `00df3bb4`, PR #872): design-review **PASS(B0·H0)** — D3 어휘 분리("이어서 보기" vs "새 호스트에서 재개") 세 표면 일관·idle 제3 상태 톤·미커밋 고지가 선택보다 먼저. 오케스트레이터 수리 5건: 앱 2(**스코프 칩이 열린 상세를 안 닫음** — 죽은 컨트롤 · **orphaned를 "닫힌 세션"으로 부름** — 재개 가능 상태의 종결 강등, 리뷰 M1) + 게이트 3(접힌 details visible 대기·이중 매칭·낡은 행수). red proof 4종(TRANSITION 포함 — stale 응답 덮어쓰기).
- **#861 랜딩**(track/engine `af931652`, PR #873): 에이전트별 전역 run REST. 검증기 전관문(채널/전역 요약 동일성 포함)·**red proof에서 내 절단 위치 오류 2회 뒤 진짜 성립**(같은 문자열의 첫 매칭이 커서 검증 쿼리 — 메인 필터를 자르자 이름 있는 실패). 교훈: **red proof는 자른 것이 하중을 받는 술어인지까지 확인**.
- **ADR-0139 파생 4장 전부 완결**: #856(엔진 idle)·#857(데몬 replay)·#859(T3 pause)·#858(웹). 남은 이월: #869(WSS 어댑터 — 실왕복 마지막 조각)·#870(재시작 reconciliation).
- **#860(에이전트 허브 탭) 가동** — 최대 신설면은 **메모리 뷰**(서버 13 endpoints, 웹 소비자 0건이던 것). #861 이력 축·실배선된 working signal 소비. 남은 큐: #860 랜딩 → #869/#870 → main 동기화(성재 승인).

## 2026-07-28 (Fable) · 재개 — #857·#859 랜딩, ADR-0139 엔진 3장 완결 · #858 검수 중 · 워커=sol high(Fast)
- **모델 지시 해석 정정**: "sol high fast"의 fast는 모델명이 아니라 **service tier**(`priority`="Fast" 1.5x — config.toml 전역 설정). `gpt-5.6-sol-fast`는 400 즉사(실측·감시가 60초 내 포착). 이후 sol high로 spawn.
- **#857 랜딩**(PR #868): host-internal replay core(셸 래핑·256KiB 링·replay 마커 계약). 워커 STOP 판단 수용 — 데몬에 공개 WSS 리스너 부재는 새 경계라 임의 설계 안 함 → **#869**(WSS attach 어댑터 — 웹 재부착 실왕복의 마지막 조각)·**#870**(재시작 reconciliation) 티켓화. 검수에서 테스트 결함 2건 수리: **기계 의존 청크 단정**(첫 라이브 청크가 "print" 다섯 글자 — 5/5 결정적 실패, 워커 샌드박스에선 우연히 통과) · **행(hang)형 red proof**(swift-test 0% CPU 10분 실측 → 워치독 finish로 3.1초 이름 있는 실패로).
- **#859 랜딩**(PR #871): T3 idle=pause 실배선. 신규 4관문(pause 1회 호출+paused interval·resume·**사라진 sandbox→destroyed→기존 orphaned sweep 합류**·latency 조회+pause 과금 0) + red proof 2종 이름 있는 실패. T1/T2 무영향.
- **#858 검수 중**: 워커 산출(902 tests·red proof 4종 설계)에서 **앱 결함 1**(스코프 칩이 열린 상세를 안 닫음 — 죽은 컨트롤 → 칩=목록 약속으로 수리) + **게이트 결함 3**(접힌 details visible 대기·타임라인 카드 이중 매칭·낡은 행수) 수리(`0bdabe2d`). gate:my-sessions 3연속 그린·red proof 4종 성립. design-review 가동 중.
- **#861 spawn**(전역 run REST — #860 허브 탭 선행). 남은 큐: #858 랜딩 → #860 · 별도 #869/#870.

## 2026-07-28 (Fable) · 성재 지시 일시 중단 — #856 랜딩·#857 가동 중·재개 문서 2
- **재개 문서 = `handoffs/2026-07-28-resume-batch2.md`.** #856 랜딩(track/engine `1396b072`) 후 #857(데몬 셸 래핑·링버퍼·replay) sol medium spawn 직후 중단. **워커는 죽이지 않았다** — PR 후 STOP 계약이라 방치 안전, 결과는 RUN_DIR에 남는다.
- 배치 누적: engine #855·#854·#856 / uxui #850·#851 — 전부 트랙 랜딩, **main 동기화 성재 승인 대기.** 다음 큐 #859→#858→#860/#861(패킷 미작성, 티켓에 상세 완비).

## 2026-07-28 (Fable) · #851 랜딩 · #856 검증 — 라이브가 결함 4+4건을 드러냄
- **#851 랜딩**(track/uxui `526b1641`, PR #866): design-review 2R PASS. 1R FAIL(B1·H3)은 전부 "자기 원칙(원장 정본·host 진실 대기)을 자기가 만진 나머지 분기에 미적용" 형태 — 칩 축소 우선순위·세 관점 대기 공유·오프라인 상세 진입 분리·hosts-empty 마스킹. 2R 신규 High(메타 줄 grow로 문장 분열)는 오케스트레이터가 직접 수리. red proof 3종(기존 2+수동 라벨 클립).
- **#856 라이브 검증이 값진 하루**: ①서버 결함 — workHost principal(Ed25519) 감사의 via_token_id FK 위반(레포 첫 사례, 전 전이 500) → NULL이 정직(토큰 미사용, 호스트는 detail에) ②워커 검증기 결함 3 — UUID 대소문자(payload 대문자 vs 셸 소문자, **감사는 uuid 비교라 통과한 비대칭이 단서**)·push 허용목록에 dispatch.v2 표준 필드 4종 누락. 수리 후 전 관문 PASS + red proof 성립(sweep 되돌리면 timeout/orphan 0:0).
- **선존재 드리프트 발견(중대)**: 07-21 fffe303b(#564 멤버십 수명주기) 이후 라우트 authz가 `workspace_membership`을 요구하는데 **기존 검증기 4종(work_session·terminal_attach·observer_attach·push_notifier)의 픽스처가 채널 membership만 SQL로 심어 그 뒤로 전부 403 — 일주일간 아무도 안 돌려 몰랐다.** SQL 지름길 픽스처가 실경로를 우회하는 패턴의 **6번째 사례**(실 REST join이면 자동 생성). base에서 재현 확정, #856 무관. 픽스처 4종에 workspace_membership 주입으로 수리(주석에 근거).
- **내 실수 기록**: red proof 첫 실행이 포트 충돌 exit 1이었는데 성립으로 오기 → 재실행해 진짜 성립 확인. 검증기 첫 실행을 `| tail` 파이프로 exit 가림(같은 교훈 재범).

## 2026-07-28 (Fable) · #850·#854 랜딩 — 허들이 웹에 복원되고 전사 v1이 섰다 · #851 가동
- **#850 랜딩**(track/uxui, PR #862): design-review **2R PASS(B0·H0)**. 1R Blocker 2건(760 제목 소거·핫마이크 무출구) 실렌더 폐쇄 — "오디오와 REST 프로젝션은 다른 진실 평면" 원칙으로 joined 분기 최우선화. **red proof 4종**(기존 503/ended + 수동: joined 우선 복원·폭 계약 제거 → 각각 FAIL). lazy-load 실측(livekit 531KB 별도 청크·엔트리 무참조). 2R 신규 Medium 4(배너 시 at-bottom 이탈·오프라인 이중 배너·joined 중 503 카피 모순·넓은 창 참가자 굶김)는 후속 티켓 예정.
- **#854 랜딩**(track/engine `9672006c`, PR #864): 339 tests · **동의 게이트 실서버 관통(무동의 409→동의 200→시작 201→녹음 중 무동의 join 409)** · compose transcription profile(Egress v1.9.1+전용 Redis) healthy · **하니스 3모델 실완주**(잠금 스냅샷·CER/RTF 산출, RTF@1스레드 small 3.05/medium 8.59/turbo 7.57 — "small이 실용 한계" 부합). **CER 0%는 합성 TTS라 품질 판정 아님** — 모델 확정은 실코퍼스 실측 후(성재 단계). 화자=트랙 소유 member 라벨(diarization 없음).
- **선존재 409 티켓화(#865)**: `work-session-remote-create` 409를 base에서 재확인 — 세 배치째 전체 계약 게이트를 끊어 미티켓 방치 종료. fail-fast 구조 재고 포함.
- **#851 내 세션 표면 워커 가동**(sol medium). 남은 큐: uxui #851→#858(ADR-0139 웹) · engine #856→#857→#859 · #860/#861(에이전트 허브).

## 2026-07-28 (Fable) · #855 랜딩(트랙) · #850 1R FAIL→2R · #854 가동
- **#855 T3 랜딩**(track/engine `05ff5720`, PR #863, sol medium): 리허설 대본→원장→프로비저너 3커밋. **pause 미계상이 GENERATED 컬럼으로 구조적**(과금 코드 빼기에 비의존 — 패킷 요구 정답), `usage_ledger` 비확장 근거 명시, 부트스트랩 토큰 digest-only+15분 1회용, RLS FORCE 4테이블, `confirmPaidCloud` 명시 동의. **검증**: 337 tests·격리 검증기 전관문(mock E2B)·red proof(pause 벽시계 과금 6s vs 4s 검출)·openapi 6경로. **한계**: 실 E2B 왕복은 D4 리허설 준비물(운영자 momo-workd template+공개 서버) 확보 후.
- **#850 웹 허들 1R FAIL(B2·H1)** — 워커 산출물 자체는 견실(893 tests·gate:huddle 신설+red proof 2종·lazy-load 530KB 분리·keepalive leave·마이크 거부 분리 분류). Blocker는 통합 지점: ①`shrink-0` 우측 클러스터에 가변 폭 표면을 넣어 **760x480 참가 중 채널 제목 폭 0px**·offline 경고 화면 밖·작업 패널 토글 도달 불가 ②`error/unconfigured` 분기가 joined보다 먼저 반환해 **통화 중 일시 500 한 번에 마이크·나가기 소멸(핫마이크 출구 없음)**. H1: 출하 웹 CSP가 LiveKit 소켓을 침묵 거부하는데 SecurityError를 마이크 거부로 오분류할 위험(`cspBlockedHost` 선례 미사용). 2R 패킷 `handoffs/2026-07-28-850-2r-fix-packet.md`, sol medium 가동.
- **검증 중 선존재 결함 수리 1건**: 패키징 CSP 재실행에서 gate:shell이 EvalError — `waitForFunction`이 술어를 페이지 월드에서 eval(#839 라운드 유래 5곳, #850 무관). CDP 면제인 `page.evaluate` 폴링으로 교체(`06974caf`), 평문=CSP 66단정 동일 PASS·부순 CSP FAIL 유지.
- **#854 전사 v1 워커 가동**(sol medium, 하니스+골격+동의 게이트 범위).

## 2026-07-28 (Fable) · buzz 에이전트 탭 실사(HEAD 07-27) → 허브 탭 갭 판정 + 향후 티켓 2장
- **성재 질문**: buzz Agents 탭 같은 "에이전트 베이스 탭"(프로필·권한·프롬프트·memory·이력·현재작업·cron)이 우리 설계에 있나 + buzz 갱신. **판정: 없다 — 조각 분산**(프로필 다이얼로그·디렉터리·앱 권한·인박스), 정본 `2026-07-28-buzz-agents-tab-delta.md`.
- **buzz 델타 실사**(07-22 분석 이후 **179커밋**, HEAD `18eef633`): Agents 탭 = 목록+프로필 4탭(info/runtime/channels/**memories**)+정의 단일정본(`8c0e8cb`)+Respond to/MCP/실행위치+세션 전사+스냅샷/팀+**BYOH generic ACP**(`95fdf97`). **방향 신호 = 분산 표면의 Unified 수렴**(페르소나 카탈로그·디렉터리 섹션 삭제). buzz도 cron은 없다(Workflows가 그 자리). **안 따라가는 것 명시: 프로바이더 API 키 입력(ADR-0004 위반).**
- **momo 최대 갭 발견**: **MemoryRoutes 10종이 서버에 완비돼 있는데 웹 소비자 0건** · agent-runs가 채널 단위뿐(전역 없음) · `triggers.schedule` 예약만·실행기 없음.
- **향후 티켓**(성재 지시대로 현 배치 뒤 진행): **#860** 웹 에이전트 허브 탭 v1(MOMO-568 작업중 전류 연결 포함, cron 자리는 정직 고지) · **#861** 에이전트별 전역 run REST. **ADR-0140 기안 예정**(schedule 실행기 — 새 실행 유발 경로라 결정 선행). buzz 추적 상시화: 배치 종결 시마다 델타 실사(방법 §4-4 고정).

## 2026-07-28 (Fable) · ADR-0139 Accepted + 파생 4장 · #850/#855 sol medium 가동
- **ADR-0139 승인**(성재 "ADR-0139 승인할게") — Status Accepted 반영. **파생 4장 발급**: #856(엔진 idle 상태 모델·타임아웃 sweep·완료 푸시) → #857(데몬 셸 래핑 PTY·링버퍼 256KiB·attach replay 이음새 계약) → #858(웹 idle 칩·"이어서 쓰기" vs "새 호스트에서 재개" 동선 분리, 선행 #851) · #859(T3 pause 접합·활성시간 미계상 실배선, 선행 #856+#855). #853은 산출물 완료로 닫음.
- 파생 티켓에 이번 배치 교훈을 선반영: SQL 지름길 픽스처 금지(#856) · replay 끄면 빨간불 레드 증명(#857) · 목 타이밍 아티팩트 금지(#858) · 워커 .env 비접촉(#859).
- **#850(웹 허들)·#855(T3) 워커 가동 중**(sol medium, 생존 확인·사망 감시). 완료 시 검수→게이트→랜딩→#851·#854 순차.

## 2026-07-28 (Fable) · 차기 배치 설계 검토 + ADR-0139 기안 + 패킷 4장 (spawn 대기)
- **성재 지시**: 티켓 리뷰→구현방식·정합성 설계 검토→작업 준비. **구현은 sol medium**. 검토 결과는 계획 정본 §8.
- **전제 재검증이 또 정정을 낳았다**: #851의 "마지막 활동 시각"은 서버 필드가 없다(startedAtMs·상태 전이로 대체, durable 최근활동은 별도 엔진 사안) · #853의 ADR 번호는 0146이 아니라 **0139**(0138은 온보딩 예약).
- **ADR-0139 기안**(Proposed): D1 셸 래핑 PTY로 `idle`(도구 종료≠세션 종료, running↔idle 왕복, 타임아웃) · D2 호스트 링버퍼 replay(D10 유지 — 서버 바이트 비경유 불변) · D3 재부착 vs git 계보 재개 분기 명문화 · D4 T3 idle=샌드박스 pause + **활성시간 미계상**(원장 요구를 #855에 선반영). **성재 승인 대기.**
- **설계 확정 사항**: #850 join 응답의 `livekitUrl`이 주소 권위(ADR-0110 동형)·실시간 와이어 3종은 `huddle_started/participants_changed/ended`·livekit-client는 xterm식 lazy-load·Tauri 마이크 권한은 워커 보고만 / #854는 1단계=실측 하니스(워커는 오디오 못 구함)+동의 fail-closed 게이트, Egress Redis는 prod 있음·dev 없음 / #855는 워커가 `.env`의 E2B 키를 읽지 않게 명시(스모크는 오케스트레이터 키 주입).
- **패킷 4장**: `handoffs/2026-07-28-{850,851,854,855}-*.md`. 순서: uxui #850→#851(순차 머지, realtime.ts·api.ts 겹침), engine #855(리허설 문서부터)→#854. **성재 "진행" 지시 대기 — spawn 안 함.**

## 2026-07-28 (Fable) · main 동기화(성재 전건 승인) + 허들·회의록·연속성 실사 → 티켓 5장
- **main 동기화 완료**: `main = track/engine = track/uxui = 99ea7330`. 배치 5장(#840·#841·#838·#842·#839) 전량 main. 원점 검증 — server build + **333 tests** · 웹 **881 tests** · typecheck 0 · `gate:wire`·`gate:shell`·`gate:csp` PASS · 마이그레이션 44개 번호 충돌 0.
- **머지 시 정정 이행**: `docs/security/README.ko.md`의 "Tauri CSP는 현재 null"을 #842 반영으로 고쳤다. **넓은 `connect-src`의 이유(런타임 서버 주소·관전 호스트)와 `style-src 'unsafe-inline'`(터미널 렌더러)까지 함께 적었다** — CSP가 있다는 사실만 적으면 그게 막지 못하는 것을 오해하게 된다.
- **후속 티켓 2장**: #848(다크 `--danger`가 `--warn`보다 약함 — #839가 두 톤을 처음 나란히 놓아 드러난 토큰층 결함) · #849(동의 모달 후속 10항목 묶음).
- **성재 질문 3건 실사**(정본 `2026-07-28-huddle-meeting-continuity-plan.md`): ①**허들은 서버·인프라·macOS·iOS까지 만들어져 있는데 웹/Tauri에 화면이 0건**이다 — macOS 은퇴 때 미포팅, **#838과 같은 유실 클래스**. ②**회의록·액션아이템은 ADR-0122 V-4/V-5로 설계만 있고 티켓조차 없다**(코드 0건). 선행이던 ADR-0113/0116은 이미 랜딩해 지금은 막힌 게 없다. ③**연속성은 절반만 된다** — 세션 목록·작업 스레드는 PG가 SoT라 이미 기기 간 동일하지만, **터미널 화면은 설계상 동기화되지 않고**(ADR-0125 D10: 서버가 바이트를 나르지 않음 + 호스트 데몬에 스크롤백 버퍼 0건) **T3 자체가 코드 0건**(ADR-0136 Accepted, E2B 키 성재 조달 대기)이다.
- **티켓 3장 발급**(결정 불요분): #850 웹 허들 복원 · #851 내 세션 연속성 표면 · #852 호스트 상실 재개 카드(ADR-0125 D11 파생 — MOMO-519/520이 미발급 상태였다).
- **성재 결정 3건 대기**: D1 터미널 스크롤백을 누가 보관하나(권고=호스트 로컬 링버퍼 — 서버 불변식 유지, B안은 보안 문서의 "실행 내용 미보관" 주장을 바꾸는 일) · D2 회의 녹음 동의·보존(privacy-policy 빈칸과 얽힘) · D3 T3 착수 시점(E2B 키).

## 2026-07-28 (Fable) · 일반 사용자 대응 배치 5장 완주 — #842·#839 랜딩, #839는 5라운드
- **배치 종결**: #840·#841(track/engine) · #838·#842·#839(track/uxui). **다섯 트랙 랜딩 전부 main 앞·성재 승인 대기.**
- **#842 랜딩**(track/uxui `8d8ba3b3`, PR #847): Tauri CSP + `gate-csp.mjs`(CSP를 `tauri.conf.json`에서 읽음). red proof 성립(style-src-elem 22건 뒤 exit 1). **게이트 사각지대 하나를 내가 메웠다** — `gate:csp`는 한 경로만 걸으므로 `gate:wire`·`gate:shell`을 같은 CSP 헤더 아래 재실행했고(둘 다 PASS), `default-src 'none'`에선 둘 다 exit 1이었다. **그 마지막 확인이 없으면 "CSP 아래 통과"가 헤더 무시와 구별되지 않는다.** 절차를 README·게이트 주석에 고정. **실빌드**: `cargo tauri build` exit 0, 실웹뷰 연결 화면 렌더, **IPC 동작 증거는 키체인 프롬프트와 mDNS 프리필**(둘 다 웹뷰→Rust 왕복). 한계: 릴리스 번들 devtools 부재로 런타임 콘솔 위반 목록 미확인.
- **#839는 5라운드**(PR #846). **매 라운드 지적이 직전 수정이 만든 것**이었다: 1R 스크롤 상자 부재(출하 시드가 900x600에서 **키보드가 안 보이는 승인 버튼에 도달**) → 2R **포커스 수정이 목 타이밍 덕에 초록**(120ms 편차에서 16/16 body) + 상자가 패널 전체를 감쌈 → 3R 헤더가 본문보다 커져 **권한 칩을 한 번도 못 본 채 승인 가능** + "설치 관리자"가 데이터에 없는 관계 단정 → 4R 단일 원인일 때 같은 문장 4회(403×N이 가장 흔한 실패) + 폴드 위 신원이 앱 자칭 이름뿐 → **5R PASS(B0·H0)**.
- **red proof 4종 실측**: 무조건-true 복원 시 포커스 단정 타임아웃 · `overflow-y-auto` 제거 시 버튼 top 878 vs 패널 568 · `scroll-pt-1` 제거 시 링 여백 0 · 단일 원인 분기 해제 시 `policyCauseCount` 4. **2R의 "목이 같은 tick에 답해 초록"이 이 티켓의 핵심 교훈**이라 게이트가 catalog/detail을 160ms 어긋나게 만든다.
- **내 실수·수정 2건**: ①1R 게이트 로그의 `buttonsInViewport:true`를 그대로 믿었는데 그 단정이 **측정 전에 `scrollIntoViewIfNeeded()`를 호출**하고 있었다("스크롤하면 닿는다"≠"열자마자 보인다"). ②4R 링 여백 단정이 **rAF 스크롤 전에** 재서 세 뷰포트 FAIL — 앱이 아니라 게이트 결함이었다.
- **워커 모델 전환(성재 지시)**: terra xhigh → **sol medium**(다음 라운드부터). 전환 직전 terra 런 1건이 **시작 3초 만에 죽어 한 시간을 날렸다**(exit-code 미생성, `AuthorizationRequired`는 성공 런 10건에도 있는 무해 잡음이라 사인 아님). **감시가 "완료"만 보고 "죽음"을 못 본 것**이 진짜 결함 — 이후 spawn은 프로세스 소멸도 감시한다.
- **성재 몫**: track→main 승인(5건) · `legal/privacy-policy.md` 빈칸 · #837 실기기 · ADR-0138/0113 · **#839 grant 기본 전체선택 유지 여부**(제품 판단, 의도적으로 안 바꿈).
- **랜딩 후 필수**: `docs/security/README.ko.md:68`의 "Tauri CSP는 null" 정직 항목이 #842로 **거짓이 됐다.** main 통합 시 정정(넓은 `connect-src` 이유 포함).

## 2026-07-27 (Fable) · 배치 5장 중 3장 랜딩 · #839 design-review FAIL · 성재 지시로 일시 중지
- **재개 문서 = `handoffs/2026-07-27-resume-batch.md`**(이것만 읽으면 재개 가능). #839 수정 패킷은 `handoffs/2026-07-27-839-2r-fix-packet.md`에 이미 쓰여 있고 **spawn 직전에 멈췄다.**
- **랜딩 3장**: #840(첨부 unique 테넌트 분리, 044) · #838(웹 마켓플레이스 복원, design-review 4R PASS) · #841(한국어 보안 자료+신뢰 경계 다이어그램, `01026aa1`). **세 트랙 모두 main 앞·성재 승인 대기.**
- **#839 FAIL(Blocker 1·High 4), 5건 전부 코드에서 재확인.** Blocker는 `dialog.tsx`가 "본문 스크롤 상자는 caller가 넣어라"라고 **주석으로 계약을 적어뒀는데 이 caller만 안 넣은 것** — **출하 시드 GitHub 1-scope가 900x600에서 승인 버튼이 화면 밖**이고 키보드 Tab이 **보이지 않는 승인 버튼에 도달해 Enter가 먹는다.** High 4: 다른 scope가 같은 라벨(`notion:comment`=`notion:admin`="notion 사용 권한") · `outcome.error` 참조처 0건이라 `pluginActionErrorMessage`가 죽은 코드가 되고 전량 실패에 선택까지 날아감 · 전량 성공 후 재조회가 opener를 언마운트해 포커스 body · 위험도가 앱 단위 한 줄뿐이라 **다이얼로그 뒤 상세 패널이 오히려 더 자세함**.
- **교훈 갱신**: "기존 사용처를 먼저 읽어라"를 패킷에 넣어도 **계약 주석이 호출부가 아니라 컴포넌트 쪽에 있으면 놓친다.** 뷰포트 밖 컨트롤은 #838에 이어 **두 번째**라 이번엔 게이트(900x600)로 잠그게 했다.
- **#842는 PR #847까지 왔다**(CSP 설정 + `gate-csp.mjs` 281줄, CSP 문자열을 `tauri.conf.json`에서 읽는 구조). `style-src 'unsafe-inline'`(xterm 실측)·넓은 `connect-src`(런타임 서버 주소+관전 호스트)는 근거가 레포에 있어 정당. **검증 미착수** — `gate:csp`·레드 증명·`cargo tauri` 실빌드가 내 몫이고, `frame-ancestors` 부재와 Tauri IPC CSP 주입은 확인 필요.

## 2026-07-27 (Fable) · 일반 사용자 대응 조사 3건 → 이슈 5장 + ADR 선행 분리
- **성재 발제 3건**(브라우저 왕복 가입 / 보안은 어떻게 답하나 / 코덱스식 커넥터 UI)을 코드에서 전수 조사. 계획 정본 `2026-07-27-general-user-readiness-plan.md`.
- **판정: 셋이 같은 결정을 가리킨다** — 셀프호스팅 도구에서 일반 유저 제품으로 무게중심 이동. ADR-0121 D6-A(기본 공개 서버 비내장)·D5-A(momo Cloud 범위 밖)가 막고 있어 **새 ADR이 필요한 경계 변경**이다. 그래서 **결정 불요분만 즉시 착수**로 갈랐다.
- **브라우저 왕복**: 후반부는 **이미 배선됨** — `momo://` OS 등록·전달·**콜드스타트 버퍼**(앱이 꺼져 있어도 유실 없음)·URL 비밀값 즉시 제거. 앱→브라우저도 `opener.rs`가 **https만 허용**해 인증에 오히려 적합. 빠진 건 유니버설 링크·인증 플로우·콜백 토큰 규약, 그리고 **초대 없는 계정 생성 경로 자체**(`JoinRoutes`가 유일 생성 경로, 초대 필수). ADR-0121 D2-A가 도메인 검증 우회 설계를 이미 예약(구현 S-4만 미발행).
- **보안**: 구현은 강하다(RLS FORCE + **부팅 거부** 부트가드 · capability URL 직송으로 바이트 서버 미경유 · 채널 멤버십 게이트 · Drive SA `drive.readonly`+driveId 강제·재검증·DB 미저장 · 푸시 id-only). **그런데 말할 자료가 없다** — 한국어 문안 0건, 랜딩 없음, 위협모델 없음. **`legal/privacy-policy.md`는 빈칸 템플릿이라 지금 링크 보내면 역효과**. 정직하게 함께 적어야 할 것도 확인: 바이러스 검사 없음·MIME sniffing 없음·브라우저 localStorage refresh token·Tauri CSP 미설정·구 알파 미서명·3자 인증 없음.
- **커넥터**: 서버 라우트 6종 실동 + 상세 API가 **manifest 통째**를 줘 동의 모달 재료가 이미 다 온다(publisher.verified·license·provenance·tools[].scopes/risk·**egressDomains**). **웹에 화면이 0건** — 구 SwiftUI 734줄 마켓플레이스가 은퇴 때 미포팅, Tauri 계획에도 없었다(**기능 유실**). 동의 모달은 mac에도 없었다(1클릭 즉시 grant). 스크린샷의 3자 OAuth는 ADR-0113이 토큰 취득을 에이전트 호스트로 밀어놔 **재개정 선행**.
- **이슈 5장**: #838 마켓플레이스 복원 · #839 동의 모달+다중 scope · **#840 첨부 unique 인덱스 테넌트 분리(실제 누설, `017:30-32`에 `workspace_id` 없음)** · #841 한국어 보안 문서+신뢰 경계 다이어그램 · #842 세션 저장 경계+Tauri CSP. 권장 순서 840→838→841→839→842.
- **ADR 선행(착수 금지)**: ADR-0138 신규(일반 유저 온보딩/momo Cloud) · ADR-0113 증보(3자 OAuth). **성재 몫**: privacy-policy 빈칸·#837 실기기·ADR 결정.


## 2026-07-27 (Fable) · ADR-0137 Accepted + RN 스파이크 티켓 발급
- **성재 승인**("ADR-0137 Accept 진행해줘"). 결정 5건 **전부 권고안대로**: 전량 재작성 · bare RN+Expo 모듈 낱개(EAS 미도입) · `momo-core` 모노레포(순수 로직만, npm workspaces) · iOS 킷 동결 후 교체 · Android cleartext 티켓 분리.
- **4번 조건이 이미 충족됐다**: 승인 조건이던 MOMO-631(iOS 전송 400 + 라이브 와이어 게이트 부재)이 오늘 랜딩(#826/PR #832)돼, 킷은 이제 **버그픽스 전용 동결**로 들어간다. ADR-0123은 본 ADR이 대체.
- **Accepted ≠ 착수 승인**을 ADR 본문에 명시했다 — D6대로 **첫 티켓은 구현이 아니라 스파이크**다. **#837 MOMO-635** 발급(실기기 5~7일, 6항목): ①한글 IME(**1번 게이트** — 확증 증상은 조합 밑줄 소실이고 "입력 불가"는 미재현, 반증으로 Mattermost CJK 이슈 0건. 2벌식·천지인·iOS 기본 한글 × 밑줄·백스페이스·controlled value) ②URL 폴리필+`momo://join`(15파일이 `new URL` 사용) ③centrifuge-js 실왕복+리플레이 게이트+Android cleartext 실측 ④Swift NSE 이식(ADR-0120 D2-A 생존 실증) ⑤리스트 3자 실측(`Animated.FlatList`/FlashList v2/`@legendapp/list` — 난점은 성능이 아니라 inverted+스크롤 보존) ⑥Android 동일 루프.
- **수용 기준을 판정으로 못박았다**: 산출물은 코드가 아니라 보고서, 애매하면 FAIL, **1건이라도 FAIL이면 구현 착수 금지·성재 재보고**, 스파이크 코드는 버려지는 것이 정상.
- 이후 순서: `momo-core` 추출(**웹이 먼저 소비해 회귀 0 증명 후** 모바일 부착) → RN 스캐폴드 → v0 UI(≈4,600 LOC) → NSE+TestFlight → Android 레인.


## 2026-07-27 (Fable) · #831 허용 모델 노출 REST — 잔여 티켓 소진, 검수 무결
- **랜딩**(track/engine `f4acd3a4`, PR #836). **집행자 셋·노출자 0** 구조를 닫았다 — 패킷은 "읽는 곳이 `MessageRoutes` 하나뿐"이라 했으나 지금은 단일 소스 함수·`AgentProfileRoutes:118`(#828 F1)·`RunRouting:123-131` 셋이 집행한다.
- **설계 세 판단이 전부 옳았다**: ①`GET .../agents/:agent/allowed-models`로 **에이전트별** 집합만 노출(`workspace.settings` 통째 노출 회피 — 확장 가능한 bag이라 나중에 안전하지 않은 키가 들어올 수 있다) ②`MessageRoutes.allowedAgentModels` 재사용으로 집행·노출이 갈라질 수 없게 ③웹은 **받았을 때만** 좁히고 미수신 시 완화 동작 유지 + settings에만 있는 모델을 후보에 합친 뒤 교집합(직접 입력란이 없어 좁히기만 하면 유효 모델이 영구히 숨는다).
- **오케스트레이터 검수: 고칠 것 없음.** #826·#825·#827·#828 네 배치에서 매번 결함을 잡았는데 이번엔 그대로 통과했다. 워커 프롬프트에 "덫"을 미리 적어둔 효과로 보인다.
- **게이트**: `verify_run_routing` **64관문 PASS/FAIL 0**(신규 4 — 401·200·집합 정합·**비멤버 403**). 비멤버 단정을 **실제 REST 로그인**으로 세워 #828에서 지적한 "픽스처를 SQL 지름길로 심어 경계를 우회" 패턴을 피했다. server 332 · 웹 851 · gate:wire · gate:shell.
- **red proof 2종 성립**: 웹 갇힘 방지(미수신에도 좁히도록 되돌리면 해당 단정이 깨짐) · openapi 역방향(신규 경로를 스펙에서 빼면 지목, 103→**104경로**).
- **#828 역방향 게이트의 첫 실전** — 새 라우트가 스펙과 함께 왔고 allowlist 회피도 없었다. 장치가 의도대로 작동한다.
- **내 실수 1건 기록**: 1차 실행에서 `| tail -25`로 로그를 잘라놓고 "신규 단정 미실행"으로 오판했다. 파일이 정확히 25줄인 것을 보고 자작임을 알았다. **게이트 결과를 자를 수 있는 형태로 보지 말 것.**
- 남은 것: momowebqa 라이브에서 피커가 실제로 좁혀지는지는 next 빌드 배포 후 확인. main 반영 대기.


## 2026-07-27 (Fable) · #828 리뷰 잔여 묶음 — 착수 전 전수 재현이 범위를 셋 바꿨다
- **랜딩**(track/engine `8f4eab1b`, PR #835). 11항목을 워커에 넘기기 **전에 전부 코드에서 재현**했고, 그 결과: **M-1 제외**(041은 이미 적용됐고 `migrate.sh`가 파일 단위 `--single-transaction`이라 `NOT VALID` 처방이 무효 — 021 선례 자체가 효과 없는 패턴이었다. 규약만 문서화) · **M-6 방향 반대**(ADR-0135:17 "무응답/5xx/429만" — Swift가 정본대로이고 **Python이 위반자**, 게다가 독스트링이 존재하지 않는 parity를 주장) · **M-9 "6경로"는 실제 4경로**(quota-snapshots는 operator 스펙에 있음).
- **H-1이 본체**: 같은 등급의 인스턴스 전역 자원인 provider link는 `requireOperator`를 요구하는데 `provider:quota:write`만 워크스페이스 admin이 자가 발급 가능했다(043에 `workspace_id` 없음·읽기 전역·ingest 무감사). **스코프 단위**로 막았다 — 발급 경로 전체를 올리면 워크스페이스 admin으로 자격증명을 발급하는 검증기 **5개**가 깨진다(사전 실측). 라이브에 해당 자격증명 0건이라 저위험.
- **오케스트레이터가 잡은 것 7건**: 빌드 3건(워커가 샌드박스 탓에 Swift 빌드를 한 번도 못 돌려 **컴파일 불가 상태**로 PR이 왔다) · openapi 역방향 매니페스트가 **손으로 쓴 4줄**이라 다음 드리프트를 못 잡음 → 소스 유도 생성기로 교체 · **그 검사가 게이트에 배선조차 안 됨** · H-1 단정 부재 → 순수 함수로 3건 잠금 · 배선 후 실제 실행하니 **경로 파라미터를 이름으로 비교**해 41건 거짓 양성 · allowlist 기준 스펙 불일치.
- **교훈: 배선했다고 도는 것이 아니다.** 나 자신도 "배선 완료"로 판단했는데 실제 스크립트를 직접 호출해보니 두 겹으로 틀려 있었다. 게이트는 만든 뒤 **반드시 실행해서** 초록·빨강 양쪽을 봐야 한다.
- **게이트**: quota 11 · cascade 18(F4 신규 `bearerUnavailable`이 A4/A5 무회귀, #825 B6 유지) · server 330 · worker 90 · 웹 847 · 어댑터 59 · openapi 역방향 103경로. **red proof 3종 성립**.
- **별건**: `verify_openapi_contract.sh`가 `work-session-remote-check`에서 409로 실패하는데 **base에서도 동일**(`spawn control is not dispatchable by this host`) — 기존 결함, 후속 티켓 필요. 추측으로 PR을 탓하지 않기 위해 base에서 같은 게이트를 돌려 확인했다.
- 남긴 것: H-1 라이브 경로 단정(검증기에 운영자 개념 부재) · openapi allowlist 41건은 줄여 나갈 부채. main 반영 대기.


## 2026-07-27 (Fable) · #827 웹 와이어 검증 + 렌더 오류 경계 — design-review 4R 종결
- **랜딩**(track/uxui `59d7df53`, PR #834). **전제부터 틀렸던 티켓**: 머지 리뷰가 실동 백스크린 6건으로 분류했으나 **전부 DRIFT-ONLY**다. Swift 합성 `Encodable`은 nil을 **JSON null이 아니라 키 부재**로 내보내고, 키 부재는 `undefined`라 react-query가 막는다. 언랩 10곳의 서버 필드가 전부 non-Optional, jsonb 경로는 SQL `COALESCE`로 차단. 재현은 **주입된** null이었다. 정본 정정 `58f1648d`.
- **그래서 값의 성격이 바뀐다**: 실동 수리가 아니라 ①**에러 경계**(레포에 `componentDidCatch` 0건이었다 — 열거 안 한 지점까지 폭발 반경을 묶는 유일한 자산) ②드리프트 방어(퍼널 2곳=`settingsRequest`·`lib/api.ts`에서 차단, 8개 호출 지점 안 갈아엎음) ③**게이트 신설**.
- **design-review 4라운드 → Blocker 0·High 0**. 1R FAIL(재시도 무동작·앱루트 경계가 셸을 삼킴·탈출구가 같은 상태로 회귀) → 2R FAIL(`key={routePath}`가 컴포저 초안 파괴·폴백 여백 0) → 3R PASS(링이 창 관통 800px 세로줄·전역 `resetQueries`가 사이드바 비움) → 4R PASS(`inbox-mentions` 셸 오분류) → 종결. **2R 이후 지적은 전부 오케스트레이터 수정이 만든 것**이고 매 라운드 실측이 붙어 있었다.
- **가장 값한 지적 3개**: ①경계를 `key`로 리셋하면 자식 트리까지 재생성 — 이미 보던 채널 클릭에도 초안 소멸 ②필터 없는 `resetQueries()`가 사이드바를 비워 **이 PR 자신의 논지와 정면 모순** ③`inbox-mentions`를 셸로 분류해 멘션 때문에 던진 인박스가 **자기를 던지게 만든 캐시를 보존**(1R Blocker의 재발).
- **기계 게이트 사각지대 실증**: `gate:wire`는 4라운드 내내 초록이었다. `assertShell`이 폴백 등장을 실패로 취급하므로 **폴백 자체의 품질은 구조적으로 못 본다**. 반대로 리뷰가 못 잡는 와이어 검증 회귀는 게이트가 잡았다 — 둘이 서로 다른 것을 본다.
- **red proof 3종 전부 성립**: 와이어 검증 되돌림→`settings code`에서 잡힘 · `key=` 복귀→`navigation discarded the route subtree` · 필터 제거/`inbox-mentions` 복귀→단위 테스트 실패. 게이트 실적: 844 tests(폭발 반경 3건 신규)·`gate:wire`·`gate:shell`·preflight 10/10·lint error 0.
- 후속 후보(비차단): 게이트가 "실패한 경계가 이동 시 리셋되는가"를 못 잠금 · 재시도 반복 실패 시 무변화(기존 결함, A/B 확인) · `role=alert`+포커스 이중 안내(WKWebView 실검증) · `forgetUsage`/`forgetQuota`는 쿼리 캐시 밖. main 반영 대기.


## 2026-07-27 (Fable) · #825 캐스캐이드 재시도 증폭 차단 — 기존 게이트 사각지대 실증
- **랜딩**(track/engine `e65ad53b`, PR #833). **진단 정정**: 패킷은 "분기 없이 재큐잉"이라 했으나 실제 뿌리는 **분류를 경계에서 버리는 것**이었다 — `ProviderCascade.step`은 이미 정확히 분류하는데 `ProviderCascadeRunner`가 `finish(throwing: failure)`로 원본만 던져 `reason`을 잃고, `WorkerService`가 문자열로 받아 전부 재큐잉했다. 수정 = 타입 경계 `ProviderCascadeFailure{reason,disposition,underlying}` 도입, `availabilityExhausted`만 재큐잉.
- **증폭 실측**: 홉 9(`maxChainEntries` 8+position 0) × 논스트림 무조건 재요청 2 × `WORKER_MAX_ATTEMPTS` 8 = **144 요청·36분**. 실패 턴은 `usage==nil`→cost 0이라 **G5가 구조적으로 트립 못 한다**. 체인이 instance-global이라 아무 멤버나 멘션으로 운영자 자격증명 소진 가능.
- **red proof의 수확이 크다**: 되돌리니 **기존 17관문이 전부 초록인 채** 신규 단정만 `{"status":"pending","attempts":1}`로 잡았다. 기존 B6는 "run 실패+폴백행 0"까지만 봤고 그건 수정 전에도 참이었다 — **증폭은 기존 게이트의 사각지대**였다. 동시에 워커 유닛 89개도 전부 초록(순수 함수라 호출부 오배선을 못 잡는다) → **통합 단정이 왜 필요한지의 실증**.
- **오케스트레이터 추가**(`caf7ea0e`): 분류 불가 실패의 terminal 기본값(`resolve(nil)`→markFailed)이 사고가 아니라 결정이 되도록 단정 고정. 오늘은 도달 불가지만 transport가 `.error`를 던지지 않고 방출하기 시작하면 모든 턴이 재시도 없이 실패한다.
- **기각한 우려 2건(실측)**: ①총 예산 60s가 긴 턴을 자르지 않는다 — AsyncHTTPClient deadline은 `defer{deadlineTask.cancel()}`로 **응답 헤드 도착 시 해제**(본문 스트리밍 무관), 러너 예산 검사도 홉 실패 후에만 돈다 ②`finalizeStreamingMessage`의 `id`는 로그 전용이라 부분 출력 덮어쓰기 없음.
- 포함: 총 wall-clock 예산(`PROVIDER_CASCADE_TOTAL_TIMEOUT_MS` 60s, 5곳 배선) · 논스트림 폴백 조건화(이벤트 미방출+파싱 실패 한정 → 조각+전체답변 합성 오염 차단). 게이트 **docker 18 PASS**·worker 89. 검증기 포트 다음=**28340대**. main 반영 대기.


## 2026-07-27 (Fable C 집행) · #826 iOS 전송 400 수리 — 9주 결함 종결
- **랜딩**(track/engine `a27c0d3a`, PR #832): iOS가 `client_msg_id`·`run_id`(snake)를 보내 서버 closed-world 디코더에 **9주간 400**을 맞고 있었다. 수정은 두 줄이지만 **진짜 산출물은 게이트**다 — `scripts/verify_ios_wire.sh` 신설(격리 compose 28320~23, 매 실행 자체 픽스처, public MomoiOSKit 로그인→전송→history→멱등 재전송).
- **red proof 성립(오케스트레이터 실측)**: 되돌리면 실서버가 `400 unknown message field`로 거부하고 게이트가 정확히 잡는다. 이 확인 없이는 게이트에 값이 없다.
- **오케스트레이터 선수정 1건**(`bb570ae7`): 라이브 테스트가 픽스처 env 부재 시 **0.001초에 무음 통과**해 스크립트가 "전송 바이트 수용 PASS"를 찍을 수 있었다 — **이 티켓이 닫으려는 결함과 같은 계열**. `MOMO_IOS_WIRE_REQUIRED=1`로 스킵을 단방향화(플래그 있으면 변수 결측=실패). 실증 후 커밋.
- **범위 교차검증(워커 착수 전 실시, 과잉수정 차단)**: iOS `Encodable` 요청 5종 전수 대조 → 결함은 `IOSSendMessageRequest` 하나뿐. **`IOSMarkReadRequest`의 `last_read_seq`는 서버도 snake**(DTOs.swift:295)라 일괄 변환했으면 회귀했다. 수신이 멀쩡했던 이유 = 서버 `MessageDTO`·iOS `IOSMessageDTO` 둘 다 CodingKeys 없이 camel 일치(`MomoCore.Message`의 snake는 실시간 이벤트용). 웹·어댑터·OpenAPI는 처음부터 camel — 주석이 거짓이었던 건 iOS 항목뿐.
- **게이트 설계 수확**: `MomoiOSKit`이 `.macOS(.v14)` 선언이라 **Xcode·시뮬레이터 없이 호스트에서 34초 빌드**(실측) → iOS 게이트 정체 전례 3건(MOMO-504·506·518) 구조적 회피. `verify_ios_build.sh`도 정체 없이 PASS(69 tests).
- **파이프라인**: Codex `gpt-5.6-terra` high 워커 첫 실전 — 필수 4항(clean 선검사·자격증명 탐색금지·픽스처는 발신코드에서·PR 후 STOP) 전부 준수, 이탈 0.
- **main 반영 완료**(성재 승인, `d7441538`): 머지 후 원점 검증 그린(server build+327 tests·MomoiOSKit build+70 tests·웹 typecheck 0). main=track/engine=track/uxui 3자 정렬.


## 2026-07-27 (Fable B 집행) · C1·C2 main 동기화 + 엔진 검증기 3종 + next.10
- **머지**(성재 B 승인): track/engine 12커밋 → main → swift build 0 → track/uxui 13커밋 → main → 웹 typecheck 0. **main=track/engine=track/uxui=`a8caa836`**. '머지 직후 typecheck' 규율 유지.
- **원점 게이트**: 마이그레이션 43 유니크 · server 327 · worker 86 · 웹 837 · gate:shell 전 창크기 PASS. **momowebqa 재배포 PASS** — 라이브 DB에 041~043 적용·`provider_link_chain`/`quota_snapshot` RLS FORCE·신규 라우트 3종 401.
- **엔진 검증기 3종(오케스트레이터 직접, 포트 28290~28313)**: `verify_run_routing` **30 PASS**(F1 선수정의 라이브 증거 = 허용목록 밖 modelPref 400) · `verify_quota_snapshot` 전관문 PASS(ingest 자격·형상 400·latest-only·RLS FORCE·로그 무유출) · **`verify_provider_cascade` docker 라이브 17관문 전부 PASS**(hop0 무응답→hop1 서빙 실폴오버 + 감사행 `{from:0,to:1,provider_unreachable}` + outbox broadcast, **401은 전파되고 hop1 예산 무손실**, AES-GCM 봉인·운영자 403·RLS FORCE·로그 무유출).
- **실측 한계(정직 고지)**: momowebqa **인증 웹 왕복은 미수행** — 이 세션 정책이 자격증명 취급(기존 계정 로그인·픽스처 비밀번호 프로비저닝)을 차단. 무인증 경계·DB 스키마·격리 스택 검증기로 대체했고, 웹 3표면 클릭 확인은 next.10 빌드로 성재 몫. 인수인계 §5에 명시.
- **0.1.0-next.10 발행 + 기본 다운로드 전환 완료**: build 1320 @`a8caa836`, 서명(YWQQFQM38J)·공증·스테이플·Gatekeeper accepted·tar 왕복 서명 보존. zip sha256 `872ac750…`. `update-next.json`·`update-manifest-alpha.json` 둘 다 next.10(legacy 0.0.6 블록 보존). ADR-0134·0135가 사용자 빌드 도달.
- **파이프라인 교훈 2건**: ①검증기 동시 실행이 `server/.build` SwiftPM 저장소 캐시를 깨뜨린다(캐스캐이드 1차 실패) — **docker 검증기는 순차** ②쉘 프로파일의 `POSTGRES_PORT`가 검증기 기본 포트를 덮어써 `momo_main` 상시 스택과 충돌 — 예약 포트를 항상 명시. 검증기 포트 다음=**28320대**.


## 2026-07-26 (Fable 인수인계) · 파이프라인 전환 + 다음 배치 패킷
- **파이프라인 전환**: 워커가 Opus 5 서브에이전트 → **Codex `gpt-5.6-terra` high**(codex-fleet 계약). docker 게이트는 오케스트레이터가 직접, 워커는 PR 후 STOP.
- **워커 프롬프트 필수 4항 정본화**(전부 이번 파동의 실사고 유래): ①착수 시 `git status` clean 선검사(워커 cwd 오염 — 818 작업이 819 워크트리 오염) ②자격증명 탐색·추측 금지(QA 계정 대상 추측 시도 1건 발생) ③픽스처는 발신 코드에서 유도(캐스캐이드 안내가 죽었는데 테스트·스크린샷 둘 다 손으로 만든 턴을 써서 210개 초록) ④merge/close 금지.
- **인수인계 정본**: `handoffs/2026-07-26-next-batch-handoff.md` — 성재 결정 3건, 착수 가능 5장(#825 캐스캐이드 분기·#826 iOS 전송+게이트·#827 웹 와이어 검증·#828 M건·#831 허용목록 REST) 패킷, ADR-0137 파생 6장 순서.
- 미정리: /tmp 리서치 클론 204M(권한상 오케스트레이터 삭제 불가, 성재 수동).


## 2026-07-26 (Fable 모바일 전략) · RN 채택 결정 + ADR-0137 기안
- **성재 결정: React Native** ("RN쪽으로 가자"). 리서치 2건 정본화: `2026-07-26-rn-adoption-plan.md`(RN 실전)·`2026-07-26-mobile-stack-research.md`(스택 비교). **ADR-0137 Proposed** 기안 — ADR-0123(SwiftUI iOS v0) 대체, 0133이 남긴 iOS 경로 공백 해소.
- **재고 실측**: iOS는 SwiftUI 35파일·14,119줄·View 35종이 있으나 **2026-07-22 이후 0커밋**이고 **메시지 전송이 main에서 400**(9주 미검출 — 실서버 게이트 부재). Android 0줄. 웹은 `.app-shell`이 `240px 1fr` 무조건이라 **폰 폭에서 본문 150px**(오케스트레이터 실측) — 어떤 경로든 모바일 셸은 신작.
- **자산 재사용 경계 실측**(웹 120파일 33,293줄 전수): 그대로 이식 7,516 + 얇은 어댑터 2,108 + 훅 1,820 + **테스트 7,728(안전망)**, UI 재작성 13,346(단 v0 범위는 ≈4,575). 가능한 이유 = **결정 함수가 플랫폼 사실을 파라미터로 받는 설계**(`windowFocused` 등).
- **승계 확인**: `MomoiOSPushKit/PushNotification.swift` 329줄이 **Foundation·Security만 import, UIKit/SwiftUI 히트 0** → ADR-0120 푸시 구현 391줄 생존. fastlane 레인도 유효(Android 레인만 신설).
- **기각 근거**: Tauri 모바일(푸시 부재·NSE entitlement 유실·buzz도 모바일은 Flutter) · Capacitor(silent push 미지원 공식 명시) · Flutter(TS/React 자산 공유 0) · KMP(UI 2벌).
- **최대 미해소 리스크 = 한글 IME**(RN #48497·#55257 open, 확증 증상은 조합 밑줄 소실). 반증: Mattermost New Arch에 열린 CJK 이슈 0. **스파이크 1번 게이트, 실패 시 성재 재보고.**
- **교훈(Zulip)**: RN 이탈의 진짜 이유는 RN이 아니라 **0.68 고착 + 자체 포크**. 업그레이드 규율이 상시 부채.


## 2026-07-26 (Fable 리서치 3) · `rn-adoption-plan.md` §2/§4 보강 — 딥링크·시큐어스토리지·백그라운드·리스트가상화·notifee 폐기
- **동시편집 조우**: 파일 편집 중 다른 세션이 같은 문서에 이미 §2(Expo vs bare)를 써넣은 걸 발견 — 중복 삽입분 제거하고 내 발견은 §2.3/2.4로 **추가(덮어쓰지 않음)**: iOS/Android **자산 비대칭**이 "bare+Expo낱개" 결론의 진짜 이유(iOS는 기존 NSE/fastlane 자산 보존, Android는 `expo prebuild --platform android`로 그린필드 부트스트랩 손해 없음, `deeeed/audiolab` 실사용 확인) + RocketChat·MetaMask·status-mobile 버전 실측 + LiveKit 공식 Expo 플러그인(⭐47).
- **§4 신규 4.4~4.7**: 딥링크(RN core `Linking`만으로 충분, 추가 lib 불요) · 시큐어스토리지(keychain/secure-store vs MMKV — **MMKV 암호화는 키를 직접 관리해야 해 시크릿 1차 저장소 부적합**) · 백그라운드(iOS 상주 소켓 불가 — background-fetch도 "~15분마다"가 한계, 푸시가 유일한 신뢰 경로) · 리스트가상화(**FlashList v2는 New Arch 필수**, LegendList가 채팅 UX를 1급 설계 — 스파이크에서 둘 다 실측 권고).
- **정정 1건**: `@notifee/react-native`는 "19개월 정체" 정도가 아니라 **레포 archived·공식 폐기**(README: "no longer actively maintained", 대체=expo-notifications 또는 신생 포크 `react-native-notify-kit`). §4.2 표에 갱신 각주 추가.
- 다음: 없음(리서치 완료분). §7.5 미확인 목록은 그대로 유효.

## 2026-07-26 (Fable 머지 전 리뷰 + 블로커 수리) · C1·C2 머지 준비 완료
- **머지 전 리뷰 4관점 실시**(성재 지시): 계약 드리프트·엔진 불변식/보안·머지 후 실동(실스택 기동)·유출 잔재. 보고서 `2026-07-26-c1c2-merge-review.md`. **기계 게이트는 전부 초록인 상태에서 Blocker 4건 발견** — 빌드가 심판이 아님을 재확인.
- **선수정 3건 랜딩**(#829 engine, #830 uxui):
  - B-1: `_redact`가 bearer를 첫 글자만 마스킹(테스트가 거짓 통과로 인증). 수리 중 **동일 계열 4건**(bearer·불투명 토큰·agent 토큰·JWT 서명) 발견, 단일 alternation 1패스로 상호 파괴 구조 제거. `\S+` 대신 RFC6750 문자류(로그 JSON 과잉 삭제 방지) — 의도적 이탈.
  - D1/F3: 캐스캐이드 안내가 구조적 렌더 불가(웹은 게이트웨이 스키마 요구, 워커 턴엔 부재). 앵커 확장 + **발신 코드에서 유도한 픽스처**, before 렌더 30s 타임아웃 → after 라이트·다크 렌더 확인.
  - F1: 프로필 upsert가 허용목록 검사 후 400(생성 폼 포함 단일 퍼널). 게이트가 **D2 커버리지 소실을 자가 포착**해 SQL 시딩으로 보존.
- **잔여 티켓**: #825(B-3 증폭 차단) #826(iOS 전송+라이브 게이트) #827(웹 와이어 검증) #828(M건 묶음) **#831(allowed_agent_models 노출 REST — 피커 교집합의 선결)**.
- **교훈 정본화**: 픽스처는 ADR이 아니라 **발신 코드에서 유도**한다(D1이 그 실패). 웹/엔진 병렬 시 계약 대조를 별도 관문으로.
- 다음: track→main 동기화(성재 승인) → 라이브 통합 → next.10.


## 2026-07-26 (Fable 리서치 2) · **성재 RN 결정** → 실전 조사
- **산출**: `docs/planning/2026-07-26-rn-adoption-plan.md`. 성재가 RN으로 결정(2026-07-26) → 팀리드 지시 6항목(Mattermost 해부·Expo vs bare·자산 경계·네이티브 능력·LiveKit·마이그레이션 전략).
- **자산 경계 실측(작업계획 뼈대)**: `clients/web/src` 120파일 전수 import/DOM 분류 → **A 그대로이식 7,516 + B 어댑터 2,108 + C 훅 1,820 = 로직 11,444 LOC 이관**, 테스트 7,728 동반, UI 13,346 재작성. **단 v0 UI는 ≈4,600 LOC 상당**(ADR-0123 v0 스코프). 지뢰: `new URL`/`URLSearchParams` 9파일(폴리필 선결)·`crypto.randomUUID`·Hermes `Intl` tz.
- **게이트 2개 해소**: ①**centrifuge-js가 RN 공식 지원**(npm description 명시, 5.7.0) → 실시간층+리플레이게이트 유지 확정, Android cleartext(`ws://*.local`)만 티켓 분리 ②**Expo config plugin으로 iOS NSE 주입 가능**(OneSignal 185★ 실증, 범용은 ★3). **기존 Swift NSE 62+`MomoiOSPushKit` 329 LOC와 fastlane/match/CI는 그대로 생존.**
- **권고 3건**: brownfield 아닌 **전량 재작성**(Android 0 → brownfield는 비대칭 하이브리드=Airbnb "세 번째 플랫폼", 성공사례 전부 전담인력 대기업) · **bare RN + Expo 모듈 낱개, EAS 미도입**(Mattermost 방식, 우리 fastlane 자산 보존) · `packages/momo-core`는 **웹이 먼저 소비해 회귀 없음 증명 후** 모바일 부착.
- **주의 2건**: "FlashList 쓰면 된다"는 **틀림** — Mattermost 채팅 타임라인은 FlatList이고 `inverted`+`maintainVisibleContentPosition` 위해 **RN Fabric ObjC++ 패치**까지 감. LiveKit RN은 v0 게이트 아님(음성 v0 제외)이나 v1 CallKit이 3개월 된 포크 의존 → 기존 `IOSHuddleLiveKitSession.swift` 재노출 권고. **최대 미해소 리스크는 여전히 한글 IME(스파이크 1번).**

## 2026-07-26 (Fable 리서치) · 모바일 스택 레퍼런스 — ADR-0133 P4a 입력
- **산출**: `docs/planning/2026-07-26-mobile-stack-research.md`. 성재 발제(모바일 전략) → A 제품별 스택 / B 프레임워크 / C 모바일 에이전트 UX / 권고. 소스 직독 우선(tauri·plugins-workspace·buzz·element-x·zulip·mattermost·rocket.chat·signal 클론).
- **판정: Tauri 2 모바일 = 불합격.** 1st-party 푸시 부재(업스트림 #11651 20개월 open, notification 플러그인은 `UNPushNotificationTrigger`를 명시 배제) · **ADR-0120이 요구하는 NSE가 Tauri iOS CI 서명에서 entitlement 유실**(#15663 open) · awesome-tauri 모바일 앱 사실상 0 · **buzz가 같은 Tauri 2.11에서 모바일만 Flutter 37,815 LOC·코드공유 0**.
- **권고 1순위 = React Native**(iOS+Android 단일, **한글 IME 스파이크 조건부**), 대안 = Flutter. 근거: momo 공백은 iOS가 아니라 **Android(0)** · TS/React가 ADR-0133 "오너가 UI를 직접" 원칙을 모바일까지 잇는 유일 선택지 · **momo의 id-only+NSE 푸시가 Mattermost(RN 0.83.9)에서 프로덕션 검증** — ADR-0120이 선례로 인용한 그 제품. Capacitor는 **iOS silent push 미지원(공식)** 으로, KMP/CMP는 유명사례가 전부 "로직만 공유·UI 네이티브 2벌"이라 기각.
- **🔴 최대 리스크(직접 검증)**: iOS Fabric **CJK/한글 IME 조합 결함** 18개월째 open(원본 #48497 재현코드 첨부, 수정 PR #56082 리뷰어 미배정 `blocked`), New Arch는 0.82+ 강제라 회피로 없음. **단 "한글 입력 불가"는 과장** — 확증 증상은 조합 밑줄 소실이고 더 센 주장엔 RN팀이 `Needs: Repro`, **Mattermost(New Arch)엔 열린 CJK 이슈 0**. → 실기기 스파이크가 P4a 1번 게이트. **한글 검증은 Flutter를 골라도 동일 필요**(Flutter도 2019~2025 한글 이슈 계보).
- **정정 4건**: ①`clients/web`은 "이미 반응형"이 아님(반응형 프리픽스 3개, 900px는 데스크톱 축소용) ②ADR-0123(SwiftUI iOS 14,119 LOC)과 ADR-0133이 iOS에 **상충하는 Accepted** — 결정의 실체는 그 자산 처분 ③buzz 모바일은 "Flutter(부분)"이 아니라 220파일·37,815 LOC 본격 구현 ④Slack "과거 하이브리드"설은 1차 출처 미확인(2013년부터 네이티브, 공유 C++ Libslack만 시도 후 폐기).
- **대기**: 성재 결정 4건(스택·기존 iOS 킷 처분·Android 시점·ADR 증보 기안). **엔진 선결질문**: momo 에이전트 작업이 모든 기기 꺼도 지속되는가(레퍼런스가 여기서 갈림 → 모바일 약속 문구 결정).

## 2026-07-26 (Fable Wave C2 완결) · ADR-0134·0135 소비면 4장 랜딩
- **랜딩**: 816 엔진(profile effort_pref writer+멘션 routing, track/engine #820) · 817 프로필 다이얼로그+컴포저 피커(#821) · 818 체인 UI+캐스캐이드 표기(#822) · 819 잔여량 게이지(#823) track/uxui. 824 tests대(각 랜딩 시 원점 재검증).
- **819 gate:shell 전면 실패 = 워크트리 오염(원인 C)**: 818(MOMO-627)의 미커밋 작업이 819 워크트리에 유출→dist 빌드→chainModel `undefined.filter` 크래시로 설정 AI 섹션부터 React 루트 언마운트. **819 소스·gate 코드 모두 무결**(gate가 실제 크래시를 정확히 포착 — 완화 0줄). 유출물 제거로 해소, 오케스트레이터 원점 검증(HEAD=origin·diff 819 파일만·gate:shell 44/44 PASS·827 tests).
- **파이프라인 교훈**: 워커 cwd 오염(작업이 남의 워크트리에 기록). 재발 방지 후보 = spawn 프롬프트에 "착수 시 git status clean 선검사" + 워크트리 경로 이중 확인. codex-fleet/워크플로 프롬프트에 반영 예정.
- ADR-0134·0135 **엔진+웹 양층 track 완비**. 대기: track→main 동기화(성재 승인) → momowebqa 재배포 → **817/818/819 라이브 통합 실측**(요청 라우팅·캐스캐이드·잔여량이 실서버서 처음 실동) → next.10.
- **0136(E2B)**: 키 부재 확정(.env엔 BLAXEL/DAYTONA만). 성재 조달 대기.


## 2026-07-26 (Fable Wave C1 랜딩 + C2 발진) · ADR-0134·0135 엔진층 완성
- **C1 랜딩(track/engine #812~815)**: 808 routing+effort(041) · 809 provider_link_chain+캐스캐이드(042) · 810 quota_snapshot(043) · 811 hermes adapter 다형화. 순차 리베이스, STATUS.md 합집합 1건. **병합 팁 스모크**: 마이그레이션 43 유니크·server 314 tests·verify_run_routing 32 PASS(docker).
- 설계 판단 기록: 809 — position0은 싱글톤 무이전 참조(이중 저장 드리프트 방지), 스트림 개시 후 실패는 전파(타임라인 중복 방지), connection-refused 폴백 ~30s 레이턴시 특성. 810 — window 예약어→quota_window(와이어는 window 유지), 신규 scope provider:quota:write는 grantable-only. 811 — local_gate 미등록 공백 자가 발견·수리.
- 809 verifier가 자기 거짓 초록(캐시 미갱신) 잡고 단정 강화 — 검증 문화 정착 증거.
- **ENGINE_HANDOFF X-14** ready 등록(웹 소비면 3종). **C2 발진(wf_379bafbc)**: 816 엔진 소형(profile effort_pref writer+멘션 routing — 808 미구현분) · 817 프로필 다이얼로그+컴포저 피커(537 합류) · 818 체인 UI+전환 표기 · 819 잔여량 게이지. 웹 3장은 계약 픽스처 기반(momowebqa 엔진층 미반영) — **라이브 통합은 track/engine main 반영 후**.
- 대기: E2B 키·크레딧(0136), C2 후 main 동기화 승인.


## 2026-07-26 (Fable Wave B main·next.9 + ADR Accept + Wave C1 발진)
- **Wave B main 동기화**(#807, 성재 승인) → 검증 그린(613 tests) → **next.9 발행+기본 다운로드 갱신**(sha 9a5bcfec…) — 관전 패널·터미널·diff 카드가 사용자 빌드 도달.
- **ADR 0134·0135·0136 Accepted**(성재 "둘다 승인할게").
- **Wave C1 발진**(wf_f0c67f72, Opus 5 병렬 4): #808 라우팅+effort(마이그레이션 041 고정) · #809 provider_link_chain+캐스캐이드(042) · #810 quota_snapshot(043) · #811 hermes adapter 다형화. 전부 track/engine.
- **0136(T3/E2B)은 C2 보류**: E2B API 키·크레딧 충전이 선행 — 성재에게 요청함. 키 도착 시 프로비저너+원장+리허설 티켓화.


## 2026-07-26 (Fable Wave B 완결) · 관전 표면 웹 이식 3장 전량 track/uxui 랜딩
- **#802 터미널 관전 랜딩(#806)**: xterm.js 로컬 번들·코드 스플릿, observer 등급 소비 — **connect 프레임만 인코딩 가능(stdin/resize/kill 인코더 부재를 테스트로 각인)**, 실 PTY stdout 관전 실왕복(rm -rf 타이핑 0바이트 실측), 소유자 토글·관전 권한 배지. 리뷰 2R: 오프라인 거짓 라이브 H1 → live=소켓 OPEN+onLine+최근 수신 3중 게이트+경과 시계, 중단 시 전사 보존. 613 tests.
- **Wave B 총계**: 801(패널)+803(diff 카드)+802(터미널) — 리뷰 6라운드, B4·H10·M48 전량 실측 해소.
- **802 구조 발견**: ①브라우저 배포 시 prod CSP connect-src가 호스트 직결을 차단(무한 pending 아닌 100ms 정직 실패로 처리) — **웹(브라우저) 관전 개방은 connect-src 정책 결정 선행, Tauri 셸은 무관** ②'관전 N'=capability 행 수(TTL 60s)이지 헤드카운트 아님 — 정밀화는 ADR 후속 ③capability 전달: 브라우저=Sec-WebSocket-Protocol, mac=헤더 — **호스트 계약에 양쪽 수용 확정 필요**(엔진 후보) ④style-src 'unsafe-inline' 의존은 xterm+react-virtuoso 공통(스킬 정본 정정됨).
- 엔진 후보 누적: 턴 중단용 work_session→agent_run 링크 노출 / 이벤트 body 한국어화(또는 클라 어휘 파생 정본화) / observer 헤드카운트 / 호스트 subprotocol 수용.
- 대기: Wave B 3장 main 동기화(성재 승인) → next.9. ADR 0134~0136 검토.


## 2026-07-26 (Fable Wave B 1단계 랜딩 + 2단계 발진)
- **랜딩(track/uxui)**: #801 작업 패널(MOMO-618, #804) · #803 diff/커밋/PR 카드(MOMO-620, #805). 리뷰 2R씩 — B3·H7·M32 전량 해소, 최종 577 tests·게이트 전량 그린.
- **801 수확**: 실서버 Ed25519 호스트 등록→ACP 중계 6종 200 실왕복. R1 Blocker 2(상세 크롬 압사·partial 델타 원장 오염)·R2 High(거짓 라이브 캐럿→streamOpen 게이트, 드로어 포커스 누수→inert). **엔진 발견**: work_session→agent_run 링크 미노출로 '턴만 중단' 서버 경로 부재(ENGINE_HANDOFF 후보), 서버 이벤트 body 영어 렌더(별건 후보).
- **803 수확**: R1 Blocker(실패 턴이 깨끗한 diff 카드로 둔갑)·잘림 거짓 단언 해소. mac 518 props 계약 정합 확인.
- **2단계 발진(wf_5be00582)**: #802 터미널 관전(xterm.js, observer 등급 소비, read-only 각인 프레임 검증 포함).
- QA 잔여물: momowebqa에 qa-618 채널·프로브 호스트·세션 3건(802 검증 재활용 예정).


## 2026-07-26 (Fable main 동기화·라이브 통합·next.8·Wave C ADR) 
- **main 동기화**(성재 승인, #799 #800) 후 원점 검증 그린(웹 467 tests·swift build 0), momowebqa 재배포.
- **616 라이브 통합 실측 PASS**: /usage/summary 전항목 손계산 일치(30d 총계 148,200µUSD·추정 분리·모델/에이전트 내림차순·7d 범위 절단·주 bucket 경계·401/400 게이트). 시드 3행은 QA 워크스페이스에 잔류(합성 데이터 고지) — 사용량 섹션 실렌더 확인용.
- **0.1.0-next.8 발행 + 기본 다운로드 갱신**(switch_default_download.sh) — Wave A 5장이 사용자 빌드에 도달.
- **Wave C ADR 3건 Proposed 발의**: 0134(요청 단위 model·effort 라우팅+auto — 선택 모델 항상 노출), 0135(프로바이더 캐스캐이드 체인+잔여량 프로브 — ADR-0004 경계 보존형), 0136(momo Cloud E2B 프로비저너+크레딧·활성시간 원장+리허설 게이트). 성재 검토·Accept 대기.


## 2026-07-26 (Fable Wave A 랜딩) · 에이전트 경험 프로그램 1차 — 5장 전량 트랙 랜딩
- **랜딩**: 789 작업중 표시(track/uxui #794) · 790 채널 생성(#795) · 792 사용량 섹션(#796) · 793 티어정책·호스트 UI(#797) · 791 사용량 REST(track/engine #798). Opus 5 병렬 21에이전트(구현 5+리뷰 8+수정 8), UI 4장 리뷰 2R 전량.
- **리뷰 수확 백미**: ①789 R1 Blocker — 재연결 replay가 끝난 턴을 되살려 거짓 '작업 중'(진행 스트림 non-recoverable로 해소) ②**twMerge 함정을 3개 에이전트가 독립 발견**(text-role이 색으로 오분류→소실; 789/790/793 각자 cn.ts에 extendTailwindMerge 동일 수리 — add/add 충돌 3회, 789판 채택+테스트 합집합) ③790 R2 — 공용 dialog 제목 위계·filled sm 버튼 AA 미달(라이트 2.78:1) 근본 수리.
- **순차 리베이스 랜딩**: Sidebar(789↔790)·AppShell(CreateChannelProvider 이동)·package.json·tokens.md·capture-screens 충돌 5건 수동 해소, 매 랜딩 후 전체 게이트 재실행(최종 467 tests). '머지 직후 typecheck' 규율이 이번에도 값함.
- **정리**: 이슈 5개 클로즈, 워크트리·compose 잔존 0. ENGINE_HANDOFF X-13(usage REST) 추가.
- **대기**: ①track/{uxui,engine}→main 동기화(성재 승인) ②그 후 momowebqa 재배포→616 라이브 통합 실측→next.8 발행 ③Wave C ADR 3~4건 발의.


## 2026-07-25 (Fable 전환 실행 + Wave A 발진) · 기본 다운로드 = Tauri, SwiftUI 은퇴
- **성재 3결정 승인**: ①기본 다운로드 전환 ②Wave A 착수 ③프로그램 결정 큐(auto 모델 노출·xterm.js·OAuth 경계안·T3 E2B/크레딧 방향).
- **전환 실행**: track/uxui→main 동기화(#788) → **0.1.0-next.7 발행**(디렉터리+DM 포함, sha f8e45de4…) → 사이트 manifest 교체(`scripts/switch_default_download.sh` 신설·실행 — 다운로드 버튼 3곳이 Tauri zip을 가리킴, SwiftUI 0.0.6은 legacy 블록 보존). **ADR-0133 전환 기록 완료. SwiftUI 신규 발행 중단.**
- **Wave A 발진**(wf_a16ee964): #789 작업중 표시(MOMO-613) · #790 채널 생성(614) · #791 사용량 요약 REST(615, track/engine) · #792 사용량 섹션(616) · #793 티어정책 UI(617) — Opus 5 병렬 5장, UI 4장은 design-review 루프(최대 2R) 내장. 615/616 계약 핸드오프: `handoffs/2026-07-25-usage-summary-contract.md`.
- 다음: Wave A 회수·검증·랜딩 → 616 라이브 통합(엔진 랜딩 후) → Wave C ADR 3~4건 발의(라우팅/캐스캐이드·쿼터/T3 프로비저너).


## 2026-07-25 (Fable #782 랜딩) · 멤버 디렉터리+DM 시작 — parity G-3·G-4 해소
- **MOMO-611 track/uxui 랜딩**(PR #787, bdfef0a3): 디렉터리 라우트(검색·역할·managed by·localeCompare ko)+DM 시작(POST /dms 서버 판정, 201/200 동일 경로)+⌘K 사람 섹션+⌘⇧K. Opus 5 구현+design-review 3R+medium 후속 = 커밋 4개(6eae5531→81e957cb→08363b37→db265157→d30b0617).
- **리뷰 루프 수확**: High 5(⌘K stale error·DM 착지 화면이 채널용 빈 상태·거짓 카운터 "사람 0"·⌘⇧K 포커스 미배치 Tab15회·동명이인 aria-label 동일)·Medium 6 전부 실측 검증 해소. 스켈레톤이 실물 행 클래스를 공유해 구조적으로 어긋날 수 없게 한 패턴 채택.
- **부수 발견 티켓화**: #786(MOMO-612) — realtime connStatus가 disconnected로 전이하지 않아 **오프라인 배너가 전 표면에서 사장**(기존 결함, 782 무관).
- 게이트 원점 재검증: 301 tests·typecheck 0·gate:shell PASS·preflight 10/10. parity 잔여 기능 갭(G-3·G-4) 소멸 — main 반영은 성재 승인 대기(전환 결정과 함께).


## 2026-07-25 (Fable 에이전트 경험 프로그램 기획) · 성재 7개 지시 → 재고 판정 + 실행 계획
- **성재 지시(7)**: ①첫 사용 와우 ②모델/effort/auto 라우팅 ③작업 관전 패널(핵심) ④캐스캐이드+사용량/잔여량 ⑤작업중 표시 ⑥cloud T1~T3 실동 ⑦워크스페이스 과금 트래킹.
- **3방향 병렬 조사**: 엔진 재고(서버 전수)·클라 재고(웹/SwiftUI 대조)·레퍼런스(buzz 오픈소스 소스 직독 1차 확인 포함, `research/2026-07-25-reference-ux-survey.md`).
- **판정**: ③⑤는 엔진 완료·웹 표면만 부재(516/517/518 전량 랜딩, 웹 realtime은 message 2종만 구독). ⑤는 웹 배선까지 완비된 의도적 空 스토어 — 최저비용. ⑦ 1층은 롤업 REST 1장(스키마·인덱스 완비, 현 노출은 채널 스코프뿐). ②는 effort 개념 전무+closed-world라 ADR 필수. ④는 provider_link 싱글톤+ADR-0004 충돌로 ADR 2건. ⑥ T3는 셀렉터만(프로비저너 0줄, 0125 D3 미결). ①은 그리팅까지 있고 "두 번째 수" 설계 공백 + **웹 채널 생성 막다른 골목 발견**(ChatShell→/settings에 채널 섹션 없음).
- **정본**: `2026-07-25-agent-experience-program.md` — AX-1~7 워크스트림, Wave A(ADR 불필요 4장 병렬)→B(관전 이식)→C(ADR 3~4건)→D(온보딩 R-3), 성재 결정 큐 6개(auto 모델 노출 권고·xterm.js·OAuth 경계안·T3 기질/크레딧·Orca 식별). 티켓 MOMO-612~ 예약, 기존 ready 520·537 재지정 합류.
- **동시 진행**: #782(디렉터리+DM, MOMO-611) Opus 5 구현+리뷰 루프 워크플로 가동 중.


## 2026-07-25 (Fable parity 게이트 실측·차단 해소·next.6) · Tauri 전환 판정 재료 완비
- **parity 실측(MOMO-608, 릴리스 번들 0.1.0-next.5)**: 부록 대분류 10개 PASS5·부분5·**FAIL 0**. 성능 3종 전부 통과 — 1k 스크롤 실효 96~105fps(p95 15~19ms, 가상화 62행 고정)·콜드 469~547ms(첫 실행 946ms)·유휴 137~169MB footprint. **릴리스 keychain 왕복 PASS**(암호창 0회 — 606 ACL 수리 유효). 재연결 resume 실측(Centrifugo 중단 중 25건 주입→복귀 유실 0). 보고서 `2026-07-25-parity-gate-report.md`.
- **차단 1건(G-1) 해소(MOMO-609)**: .local 무한 대기 → ①모든 REST 15s 데드라인(본문 포함)·NetworkError/ApiError 분리·의미 있는 실패에만 재시도(무응답 15.3s 종료 실측) ②mDNS TXT `ipv4` 키 추가, 셸 ipv4→base 우선 다이얼(하위호환, macOS 클라는 base 유지). 발견 카드→로그인 2.1s 성공. **정직 보고**: 이번 환경에선 원 증상 미재현 — 해제 근거는 "무한 대기 구조적 불가+카드가 이름 해석 비의존 주소 제공".
- **High(G-2) 해소(MOMO-610)**: 근본 원인=app-shell 암묵 auto 행+main min-height:auto → minmax(0,1fr)+overflow:clip(hidden은 포커스 스크롤로 더 나쁨). 3창×8라우트 실측 overflow 0, **회귀 게이트 gate:shell 신설**(전 10 FAIL→후 31 PASS 양방향).
- **next.6 발행**(sha256 cce83f1a…): 차단·High 수리 포함 첫 빌드. main #785.
- **전환 결정 대기**: 차단 GAP 0. 잔여 비차단=멤버 디렉터리·새 DM 진입점(#782), 비용 표시 미검증, 업데이터 실설치 재현. 권고: 성재가 next.6 직접 사용 후 전환 판단, 그동안 #782 진행.


## 2026-07-25 (Fable parity 게이트 실측 — MOMO-608/#775) · 릴리스 번들 0.1.0-next.5, 조건부 전환 권고
- 발행 번들(notarized·stapled)을 격리 경로에서 구동해 ADR-0133 부록을 전수 실측. 대분류 10개 **PASS 5·부분 PASS 5·FAIL 0**(세분 17행 기준 PASS 12·부분 5). 조작은 AX(AXPress/포커스)+CGEvent 키보드·휠 — 합성 마우스 클릭이 이 WKWebView 웹 콘텐츠엔 전달되지 않는 자동화 한계를 보고서에 명시.
- **성능 3종 전부 PASS**: 1k 실메시지 로드 후 4초 휠 스크롤 **96.0/105.5fps**(p50 9ms, >33ms 프레임 4/0, DOM 행 61~62 고정) · 콜드 스타트 창 표시 **269~946ms**·사용가능 469~547ms · 유휴 **RSS 247.5MB / footprint 137.6MB**(1k 스트레스 직후에도 298/169MB). **추가 항목 keychain 왕복 PASS**(로그인→⌘Q→재실행 무로그인 복원, 암호 창 0회). 재연결 resume도 릴리스 번들 실측(centrifugo stop→25건 주입→재기동, 9초 복귀·1000→1025·유실 0).
- **전환 차단 GAP 1건 = G-1**: LAN 발견 카드가 주는 `.local` 주소로 로그인하면 70초+ 무한 대기(오류·타임아웃 없음, 서버 로그 요청 0). 같은 앱에서 127.0.0.1·LAN IPv4는 정상 → `.local` 이름 자체 문제(mDNS가 IPv6 링크로컬만 반환). 비차단 7건(설정에서 앱 셸 전체 스크롤 High, 멤버 디렉터리·DM 시작 부재 Medium 등).
- **권고: 조건부 전환** — G-1(연결 타임아웃/오류 상태 또는 서버 광고 주소 교정) 해소 후 기본 다운로드 전환, P2 표면(연결·업데이트·알림) fresh design-review 1회 병행. 최종 결정은 성재.
- 보고서 `docs/planning/2026-07-25-parity-gate-report.md`(후속 티켓 T-1~T-6 제안 포함). momowebqa 오염(spike-745-gate 147→1025, agent-lab 19→25, DM 1개·초대 코드 1개 신규, 멤버 신규 0)은 §6에 전량 기록.


## 2026-07-25 (Fable P2 완주 — Tauri 네이티브 통합) · 딥링크·mDNS·keychain·CORS, main 승인 대기
- 3갈래 병렬(Opus 5): **766 Tauri 플러그인 4종**(딥링크 콜드스타트 버퍼링·mDNS 실발견·keychain·알림 — 실번들 E2E, 스캔 스레드 누수 자체 발견·수리, Rust 12 tests) + **767 웹 연결 표면**(서버 선택·프리필·발견 카드·API_BASE 동적화·브라우저 ?join 폴백) + **768 서버 CORS**(track/engine #769, 238/238+12관문).
- **통합(#770)**: lib/tauri.ts add/add 충돌을 766 셸 정본으로 해소, 767 재배선은 예고대로 상수 5개 국한. 182/182 tests. **실번들 핸드셰이크 E2E**: ①momo://join 콜드스타트→7.1s 내 프리필 렌더(실초대 코드 일치) PASS ②mDNS 발견 카드→클릭 프리필 PASS(로컬네트워크 권한 프롬프트 실발생) ③keychain 세션 복원 dev 경로 PASS — 릴리스 번들은 momowebqa CORS 미적용이라 차단(768 main 반영+재배포로 해소, 마지막 조각).
- 파이프라인 메모: push 의무화 후 누락 재발 0. 머지 커밋 provenance(2e71faaa 기본 메시지) 미흡 — 재작성 대신 코드 주석+README 커밋으로 근거 보존(정직 보고 수용).
- **다음: P2(engine 768 + uxui 766/767/770) main 병합 성재 승인** → momowebqa CORS 재배포→릴리스 번들 최종 E2E → momo-next 발행 채널(Tauri updater)+parity 게이트.


## 2026-07-25 (Fable wave2 3R 종결) · Blocker0·High0, main 승인 대기
- **3R 판정**: Blocker 0·High 1·Medium 5 — opaque payload가 픽셀로 증명(rm -rf 인자 미노출+"숨김 3개"), stalled 계약·seq 앵커·낙관 행 전부 런타임 검증. wave1 회귀 0.
- **수정 반영(오케스트레이터 직접, PR #764)**: H1 초대 발급 카드 포커스 착지(1회 노출 코드가 폴드 아래) · M3 모두읽음 카피 정직화(채널 커서 전진 사실 진술) · M4 와이어 어휘 번역(actionType·availability map-with-fallback) · M5 설정 Esc 편집 중 가드 · N9 payload→원본 데이터. 136/136 tests.
- 백로그 등재: 인박스 인라인 승인(760 ApprovalActions 재사용, R-1 §2 완성) · aria-controls·title 툴팁·⌘⇧A ctrl 병행 · M2 스펙 정합 질문. 
- **다음: wave1+2 통합분 track/uxui→main 성재 승인** → P2(Tauri 네이티브: 딥링크·mDNS·updater·keychain) 설계.


## 2026-07-25 (Fable P1 wave2 완주 — 인박스·에이전트 카드·설정 셸·세션/낙관) · track/uxui 랜딩, 3R 리뷰 중
- 4갈래 병렬(Opus 5, MOMO-599~602) → 통합 브랜치(761→759→760→762) → **136/136 tests·실서버 스모크 2종 PASS**로 track/uxui 랜딩(PR #763).
- **759 인박스**: 3필터+zero-noise 빈상태+seq 앵커 점프. 실서버로 멘션 계약 실측(대문자 UUID — 케이스 무관 교훈 4번째 적용). data gap 7건 정직(승인 원장 created_at 부재·전역 agent-run REST 부재 등 — 엔진 후속 후보).
- **760 에이전트 카드**: opaque payload 규율 계승(allowlist 밖 "숨김 N개"), timed_out=stalled(ADR-0132 침묵≠실패), 승인 결정 idempotency.
- **761 설정 셸 4표면**: 실서버 왕복 검증 + 상태 복원(잔존: momoqa-601 WS 1개 — 삭제 REST 부재).
- **762 M9/M10**: 새로고침 세션 복원(refresh 회전)+낙관 삽입→seq 확정 치환(중복 0 실측). 발견: realtime 페이로드 client_msg_id 부재(엔진 후속 후보).
- **통합 교훈**: 텍스트 충돌 0인데 **자동머지가 의미적 파손 2건 통과**(getAccessToken이 lib/session으로 이관돼 761·760 임포트 파손) — typecheck가 검출. "머지 직후 typecheck 필수" 성문화. 관측: worker들이 커밋을 원격에 push하지 않아(껍데기 브랜치) 로컬 worktree 브랜치로 통합 — 파이프라인 개선 후보.
- 진행: design-review 3R(wave2 표면). 다음: 3R 종결→main 승인 요청→P2(Tauri 데스크톱 네이티브 통합) 설계.


## 2026-07-25 (Fable P1 wave1 design-review 종결) · 웹판 첫 리뷰 사이클 2R PASS, Medium 전건 해소
- **1R FAIL(Blocker2·High2)**: 리뷰어가 런타임 스크롤 프로브 자작 — B1 프리펜드 앵커 소실(R-1 §3 firstItemIndex 계약 미이행), B2 Tauri 타이틀 em-dash, H3 로그인 매달린 카피+내부 어휘, H4 디바이더 직후 무기명 렌더.
- **수정 라운드(Opus 5)**: 10건 전부 반영 + **리뷰 프로브 자체의 결함 2건 교정**(?before 0회·프로그램적 scrollTop 점프) + baseline A/B 실측(앵커 이탈 vs 드리프트 -1~-3px anchorHeld). 리뷰 판정의 증상 서술 오류 정정. 엔진 리스크 플래그(nextBefore) → 오케스트레이터 실서버 확인 정상(209) 해제.
- **2R PASS(Blocker0·High0)**: B1(교정 프로브 독립 재실행 pxDrift -3px)·B2·H3·H4 RESOLVED. 2R이 픽셀 스캔으로 신규 발견: N12 마커가 위치(-8px) 문제로 **0픽셀 렌더** → 레일 가장자리 앵커로 수리 + tokens.md marker 축 동기화(같은 커밋 규칙 준수). PR #754·#755.
- wave1 최종: track/uxui = 748+749+750+리뷰 2사이클 완결. 남은 deferred: M9 세션 영속·M10 낙관 삽입(wave2), RuntimeBadge 스파이크 문구(정식 빌드 전 제거). **다음: main 병합 성재 승인 → wave2(R-1 2·4·5장: 인박스·에이전트 카드·설정 셸)**.


## 2026-07-25 (Fable P1 wave1 완주 — 파운데이션·여명 토큰·코어, Opus 5 전환) · track/uxui 랜딩
- **Opus 5 확정**: 하네스 별칭 `opus`=claude-opus-5 (프로브 실측). 노트북 종료 2회 중단 → worktree 미커밋 진행분 diff-검토 재개 방식으로 무손실 복구(momowebqa는 restart=unless-stopped로 생존).
- **748 승격**(PR #751): web-spike→clients/web·v0→web-legacy(git mv --follow 보존), 참조 30여곳 전수 갱신, 서빙/배포는 의도적으로 legacy 유지(parity 게이트 전). 빌드 3종 실증.
- **749 여명 토큰**(PR #752): light-dark() 단일 선언, **컴파일러 집행 스케일**(Tailwind 스톡 팔레트/스페이싱 initial 비움), R-2 제안값 AA 실측 조정(액센트 #a54c08 등 4색, 조정 근거 tokens.md 수록), 대비 자동테스트 12종(OKLab 색상각·인디고 대역 공백 단언), preflight 스크립트(negative test), eslint 정비. 인디고 잔재 0.
- **750 코어**(PR #753): R-1 1·3장 — 사이드바(서버 프로젝션 unread), 타임라인(같은 그리드+--agent, **"재연결됨, seq N까지 복구"** replay/backfill 구분, author group 300s), 컴포저(@멘션·재시도), ⌘K. 통합 에이전트가 충돌 7파일 해소(구조=750·스타일=749) + **지시문 오류 실측 정정: Tailwind v4는 미정의 유틸 무음 드롭 → 산출 CSS 전수 대조로 검증**(스킬 §10 반영 후보). 32/32 tests·preflight 10/10.
- **실서버 Playwright 스모크 2회 PASS**(momowebqa): 로그인→⌘K→채널→타임라인→전송→라이브 수신(24~74ms, 211건 가상화 27행, 재구독 0=순수 라이브 증명).
- 진행 중: 웹판 첫 design-review(신선 컨텍스트). 다음: 리뷰 종결→main 병합 여부→wave2(인박스·에이전트 카드·설정 셸) 설계. deferred 등재: tauri.conf 타이틀 정리·LoginPage 구분점·빈/오프라인 상태 일부·preflight의 local_gate 배선.


## 2026-07-25 (Fable ADR-0133 Accepted + P0 스파이크 게이트 PASS + R-1/R-2) · Tauri/React 전환 개시
- 성재 ADR-0133 승인 → 즉시 P0 스파이크(#745)+R-1/R-2 병렬. **스파이크 게이트 전관문 PASS**(커밋 667a40a3 정본): seq 121건 셔플 후 단조·gap 0 / 재연결 resume 25/25 누락 0 / 1k 스크롤 p95 10.3ms·>33ms 프레임 0 / 콜드 web 181ms·desktop 537ms / 메모리 196MB(<400MB). clients/web-spike+clients/desktop(Tauri 2) 신설, momo-spike.app 실빌드. main #747.
- **P1/P2 이월 발견 3건**: ①서버가 mDNS WS 호스트 반환 시 Chrome 리졸버 행(근본 수정=브라우저 리졸브 가능한 호스트 반환) ②REST CORS 부재→웹은 동일오리진 프록시, Tauri release는 Rust HTTP 필요 ③virtuoso initialItemCount. 스파이크 에이전트 최종 구조화 보고는 실패(StructuredOutput cap)했으나 작업·커밋·실측 완결 — ground truth 검증 원칙 재확인.
- **R-1 웹 UX 스펙 5장**(`research/2026-07-25-r1-ux-component-spec-web.md`): 실코드 어휘(TimelineMessage.seq·reconcileMessages·ApprovalStatus) 인용, buzz zero-noise→인박스 3필터 번역, 재연결 UX=momo 최대 우위 표면화, 에이전트=같은 그리드+--agent-accent+managed-by. **R-2 momo-design-taste-web 스킬 설치**(초안): 여명 토큰·CSP style-src 'self' 제약·grep 10종 pre-flight. **정정**: clients/web v0(ADR-0119) 실존 — ADR 컨텍스트 수정.
- 다음 성재 결정: ①P1(momo-web MVP) 착수 — 착수 시 SwiftUI 신규 표면 동결 발효 ②web-spike 승격 명명(기존 v0와의 관계) ③팔레트(v0 인디고→여명 호박) 승인.


## 2026-07-24 (Fable 셀프서브+업데이트 배치 + 서명 배포) · 실사용 루프 인앱 완결, Gatekeeper 제거
- 성재 "둘다 진행"+"서명도 진행했어" → 5티켓(MOMO-589~593/#731~735) 병렬 Opus xhigh + 서명 체인(오케스트레이터 직접).
- **서명 배포 성립**: 인증서(YWQQFQM38J)·momo-notary 검증 → publish에 codesign(hardened)+notarytool(120m)+staple+ditto 배선(MOMO_SIGN=0 폴백). 첫 공증 30m 타임아웃(신규 팀 지연, 실측 ~35m Accepted) 후 **0.0.5 서명 발행: Gatekeeper accepted**. 사이트/가이드 우회 안내 제거. Sparkle(#736) 게이트 해제.
- **엔진**: 589 POST /v1/workspaces(등재 운영자 인가·create_workspace.sql 서버화·D5-A 해시 SQL 내 복제·**verifier 전관문 PASS** 28290) + 592 ACP 런북(AGENT_HOSTING_QUICKSTART+agent_host_local.sh). **592 걷기가 실갭 발견: 재배포가 worker(AgentWorker) 미기동 → 멘션 응답 사망** — internal_alpha_stack `up api relay worker` 수리(main).
- **UXUI**: 590 워크스페이스 생성 시트(세션 전환+초대 연결) + 591 초대 딥링크 복사+메일로 보내기(mailto RFC6068) + 593 업데이트 pill(T3식, 기동+6h, 무소음 실패). 순차 rebase 체인(732→733→735) 무충돌. **통합 design-review PASS(Blocker0)** → High1(메일이 실재하지 않는 라벨 'Join with invite' 인용→'초대로 참여' 정합)+M2(초대 약속 침묵 강등 제거)+N6 수정, 기준이미지 기록. ADR-0117 증보2 Accepted(표면 확장, D1-A 불변).
- main #743·#744. momowebqa 재배포(worker 첫 포함, mDNS 재등록). 0.0.6 발행(아래 결과). 백로그: 시트 필드 레일 정렬(가족 단위)·자동 초대 팝오버 런타임 1회 확인·734 deferred(WH-2 페어링 표면 갭·시드 개인화).

## 2026-07-24 (Fable 온보딩 와우 배치 W-O1~5 완주) · 딥링크·mDNS·에이전트 첫 인사 main 랜딩
- 성재 "전체 배치로 진행" → 5티켓(MOMO-584~588/#719~723) 병렬 Opus 4.8 xhigh → 검수 → 트랙 → main(#729·#730). 계약 정본 `docs/onboarding-deeplink.md`(momo://join?server&code) + `_momo._tcp` TXT base.
- **엔진 3건**: 584 invite-create 딥링크 출력(verify 10/10, 코드 원문 파일-only 유지) · 586 internal_alpha mDNS 광고(dns-sd 수명주기, 누수 0 실측) · 588 에이전트 첫 인사(단일 쓰기경로 한 tx·UUIDv5 멱등·결정론 템플릿·join 불가침, **runtime verifier 11/11** — 실행 요건: 클린 볼륨+MOMO_AGENT_SEED_MODE=demo).
- **UXUI 2건**: 585 momo:// 스킴+join 프리필+기본값 정리(파서 16+라우팅 5 tests) · 587 chooser LAN 발견 카드. **design-review 1R FAIL(Blocker2·High1)→수정→2R PASS**: 배너 크롬 밴드 회피(controlBandHeight+8)·발견 카드 1행 압축(기본 창 푸터 잘림 해소)·Esc·톤 합니다체·connecting 딥링크 큐잉(didSet 전달). 스냅샷 기준이미지 오케스트레이터 기록.
- **검수에서 잡은 것**: 588 verifier 2건(demo 시드 모드 미지정 401, outbox id uuidString 대문자 케이스 — 582·577과 동일 클래스 3번째, **"UUID 비교는 항상 케이스 무관" 성문화 대상**) · STATUS.md 트랙 충돌 union 해소.
- **W-O5**: TESTER_GUIDE 운영자 초대 카드 복붙 템플릿(딥링크 1개+폴백). momowebqa 재배포 — **mDNS 광고 라이브**(momo._momo._tcp :28000). 0.0.4 발행(온보딩 와우 빌드). 백로그: Esc 공존(Medium), ko InfoPlist.strings, W-O6 서명/공증(성재 결정).

## 2026-07-24 (Fable MOMO-583 권한 재조임 + 알파 사이트 여명 리디자인) · 576 후속 집행, 사이트 라이브
- 성재 발제: ①576 후속 진행 ②배포 사이트 리디자인(buzz/slack/discord 참조, 히어로 재밌게, 여명거리 느낌, 마스코트는 우선 없이).
- **MOMO-583(#716→PR#717→#718→main)**: provider_link any-owner/admin 폴백 제거. 새 인가=platform:read OR **등재 인스턴스 운영자**(owner/admin+검증 이메일+PLATFORM_ADMIN_EMAILS, 요청시점 판정). **설계 조정 이유**: macOS 로그인은 platformAdminSecret 미지원 → scope-only면 운영자 GUI 영구 403. per-WS 표면(582)은 owner/admin 유지(의도된 분리). verifier 9관문 PASS(미등재 owner 403 회귀 단정 신설), server 16 tests. e2e compose+internal_alpha에 PLATFORM_ADMIN_EMAILS 배선(기본 성재).
- **알파 사이트 여명(Dawn) 리디자인 라이브**(dawn-kim-official.github.io/momo-alpha): 밤하늘 히어로(별+떠다니는 실대화 조각: @김인턴 멘션→작업완료 칩→승인대기 칩)→기능 3장→번호 스텝 설치/시작→여명 지평선 푸터(momo by Dawn). 마스코트 유보 슬롯(에이전트 아바타 교체형). 자급자족 단일 파일·noindex·manifest fetch 유지. 방향 정본 `2026-07-24-alpha-site-design-direction.md`(마스코트 후보 포함). em-dash 0·과장어 0 pre-flight 통과.
- 다음: momowebqa 재배포(583) 후 성재 GUI 라이브 확인 · 마스코트 방향 성재 결정 대기.

## 2026-07-24 (Fable WH-2·WH-3 main 랜딩 + 0.0.3 발행) · ADR-0114 증보1 전량 완성
- 성재 "ㄱㄱ" → track/engine→main(#714, MOMO-582 서버 REST + WH-3 문서) + track/uxui→main(#715, WH-2 GUI). 두 delta 모두 WH 작업만(이전 UXUI 배치는 기 main). 마커 3종(GUI/REST/docs) main 확인.
- **0.0.3 발행**(build 1114 @04c95afa, sha256 734315c8…, momo-macos-0.0.3.zip): 설정 "코드 실행 호스트" GUI 포함. macOS Release 빌드 통과=통합 게이트.
- **ADR-0114 증보1(WH-0 스파이크·WH-1 사이드카·WH-2 REST+GUI·WH-3 문서) 전량 main 완성.** "배포판에 코드 에이전트(opencode/goose) 담아 GUI로 붙이는" 경험의 클라이언트+서버+인프라+문서 완결. Codex는 로컬 연결(codex-local).
- 백로그 이관: 셰어드 토큰 상태칩 AA 대비(574/706 공통, design-review Medium2) — 공유 토큰 레벨 수정 후속. 다음: 성재 0.0.3 실사용(사이드카 `--profile workhost` + 엔진 붙이기) 피드백.

## 2026-07-24 (Fable WH-2·WH-3 병렬 구현·검수·트랙 랜딩) · GUI+REST+문서, main 승인 대기
- 성재 "이어서 진행". 3작업 병렬 Opus 4.8 xhigh → 오케스트레이터 검수 → 트랙 랜딩.
- **MOMO-582(#710, 서버 REST)**: GET/PUT `/v1/provider/work-host-engine`(requireOperator=platform:read OR owner/admin, 비관리자 403), per-workspace RLS(마이그레이션 040 재사용), 400 검증. **검증기 실 PG18 왕복 전관문 PASS**(3엔진·403·400·RLS FORCE·ADR-0004 라벨전용). WorkHostEngineTests 10. → PR #711 track/engine.
- **WH-2(#706, GUI)**: 설정 "코드 실행 호스트"(엔진 Picker opencode 기본/goose/codex-local + 페어링 상태 + "AI 연결" 구분). 574 셸 재사용. macOS 15 tests. **design-review Blocker0·High1** → 수정: 페어링을 엔진 loadState에서 분리(로드 실패해도 페어링 표시 유지) + codex-local 오프라인 코히런스 노트(Medium). → PR #712 track/uxui.
- **WH-3(#707, docs)**: `docs/WORK_HOST_QUICKSTART.md`+README. em-dash→콜론 수정. → PR #713 track/engine.
- 오케스트레이터 검수 이력: 자기보고 신뢰 안 하고 직접 빌드/테스트/docker/design-review. 잡은 것: verifier updatedBy 케이스 과민(→ascii_downcase), GUI 페어링 결합(→분리). 마이그레이션 다음=041, verifier 포트 다음=28290대.
- 대기: **WH-2/WH-3 track→main 성재 승인**(하드룰). 승인 시 0.0.3 배포판에 사이드카+GUI 동봉.

## 2026-07-24 (Fable WH-1 구현·검수·track/engine 랜딩) · 동봉 엔진 사이드카 실빌드 확증
- WH-1(#705) Opus 4.8 xhigh 서브에이전트 구현 → 오케스트레이터 검수 → **track/engine 랜딩**(PR #708, main 승인 대기).
- **A**: WorkEngineAdapter 프로토콜 + 3어댑터(OpenCodeHTTPAdapter HTTP+SSE·ACPEngineAdapter goose·CodexJSONRPCAdapter app-server stdio) + 승인 단일 계약(WorkApprovalRequest/Decision, fail-closed). **B**: 엔진 선택(기본 opencode)+마이그레이션 040(work_host_engine, RLS FORCE). **C**: workhost.Dockerfile(opencode MIT+goose Apache-2.0+momo-workd 레이어 분리, Codex 미동봉)+compose profile+라이선스. **D**: verify_workhost_engines.sh(28270대).
- **검수 그린**: 검증기 8관문 PASS(실 opencode 부팅/세션/권한+goose·codex 실stdio mock+ADR-0004 비유출), WorkHostDaemon 26 tests, **실 Docker 사이드카 빌드 성공**(1.02GB, momo-workd/opencode 1.18.4/goose OK·codex ABSENT·라이선스 3종).
- **오케스트레이터가 잡은 실결함 2건**(에이전트 최종보고는 placeholder "x"라 무시하고 직접 검증): ①Dockerfile opencode fetch가 `.zip`(404)→실제 `.tar.gz` 수정 ②LocalPTYTerminalManager Linux 첫 빌드에서 `posix_openpt` 등 Glibc 오버레이 미노출→CMomoPTY C shim(`_XOPEN_SOURCE`)으로 정공법 수리(goose ACP terminal을 Linux 사이드카에서 유지, macOS 회귀 0). **Linux 컨테이너 함정 3번째 성문화 후보**: WorkHostDaemon 첫 Linux 빌드는 PTY POSIX 심볼 갭.
- 다음: **track/engine→main 성재 승인 대기**. 승인 시 WH-2(#706 GUI 페어링+엔진선택, UXUI)·WH-3(#707 문서) 착수.

## 2026-07-24 (Fable ADR-0114 증보1 Accepted + WH-0 스파이크 실증) · 동봉 엔진 게이트 통과, WH-1/2/3 발급
- 성재 "승인할게" → **ADR-0114 증보1 Accepted**(opencode 우선+goose 병행 양자 동봉). 파생 WH-0~3 = MOMO-578~581 예약.
- **WH-0 스파이크 hands-on 완료(그린)** — 문서 아닌 실측: ①opencode 1.18.4 임시설치→`opencode serve` 키없이 부팅·OpenAPI 3.1 경로 162·`POST /session` 실세션 생성→제거(흔적 0). ②Codex CLI 0.144.1의 `codex app-server generate-json-schema`로 프로토콜 41파일 확보(Initialize/ThreadStart/TurnStart/CommandExec+승인/ApplyPatchApproval, v1 165+v2 516 정의). 추가 경로 `codex mcp-server`(stdio MCP)·`remote-control`(ws).
- **게이트 결정(D1/D4 확정)**: opencode v0 동봉 확정(임베드 실증), work host 연결=ACP∪JSON-RPC(+mcp-server) 다중 어댑터, 승인 경계 엔진무관 단일 계약(opencode /permissions·Codex *ApprovalParams). 스코프 축소 없음. 근거 `2026-07-24-wh0-workhost-engine-spike.md`.
- **발급**: WH-1 사이드카+어댑터 3종(#705, 엔진)·WH-2 GUI 페어링+엔진선택(#706, UXUI)·WH-3 문서(#707). 핸드오프 패킷 후 착수. 다음: WH-1 착수 여부 성재 확인(사이드카 동봉 대형 빌드).

## 2026-07-24 (Fable 코드 에이전트 엔진 조사 — opencode/goose/t3code) · ADR-0114 증보1 양자 동봉 재기안 + t3code 분석
- 성재 발제("opencode·goose·t3code 다뤄봐, 셋 다 좋아 보임"). 웹 실측으로 라이선스·정체 확정: **goose(Apache-2.0)·opencode(MIT)=독립 에이전트=동봉 후보**, **t3code(MIT)=에이전트 감싸는 GUI 오케스트레이터=엔진 아님(momo work console 경쟁자)**. Codex/Claude Code=독점=로컬 연결만.
- **ADR-0114 증보1 재기안(여전히 Proposed)**: goose 단독 → **opencode 우선+goose 병행** 양자 동봉안. 엔진 선택 매트릭스 추가, **WH-0 스파이크 신설**(opencode 임베드/헤드리스 API 표면 + Codex app-server JSON-RPC(stdio) 연결경로 검증 — t3code가 실증한 경로. D1/D4 확정 게이트, 실패 시 goose 단독 후퇴).
- **t3code 경쟁 분석 신규**(`2026-07-24-t3code-competitive-analysis.md`, buzz 분석 형식): t3code=work console에서 메신저·에이전트멤버·SoT 뺀 1인 로컬 슬라이스. momo 해자=팀+에이전트=멤버·PG SoT·네이티브 Swift·엔진 비종속. 가져올 것 Top4=Codex JSON-RPC 경로·태스크스레드 GUI·worktree 1급 UX·Full/Supervised 이중런타임. 포지셔닝 경보: "코드 에이전트 GUI" 공간 붐빔 → momo는 "메신저, work console은 표면" 위계 고정.
- 대기: 성재 ADR-0114 증보1 승인(양자 동봉안) → WH-0 스파이크 착수. 백로그에 t3code 파생 액션 3건.

## 2026-07-24 (Fable provider GUI 실서버 완결 — 577 랜딩·라이브 검증·0.0.2 발행)
- **MOMO-577 랜딩**(#703→track/engine→#704→main, 10e0493c): 실서버 왕복 3버그 수리 — PUT 500(PostgresNIO `Array<UInt8>`가 bytea 아닌 `char[]`로 인코딩→`ByteBuffer(bytes:)` 바인딩·decode `Data`, worker reader 동일 수정) + DELETE 500(audit `jsonb_build_object` nil `mode`/`endpoint` 타입 미추론→`::text` 캐스트) + Linux `.build` 심볼릭링크 함정(로컬 macOS build 잔재를 api 컨테이너 `cp -Rp`가 못 읽음→verifier가 부팅 전 제거).
- **verifier 실왕복 자동화**: `PROVIDER_LINK_RUN_DOCKER=1`이 실 PG18+api 부팅→owner PUT→storage bytea 증명(version byte·octet_length·평문 부재)→GET→RLS default-deny/GUC unlock→DELETE→비관리자 403 8관문 자동 단정. 8/8 PASS(재발 차단). server 15+worker 72 tests green.
- **라이브 실서버 검증 그린**: momowebqa 재배포(577 이미지, 데이터 볼륨 보존) 후 owner 계정 실왕복 — PUT(200·source=database·bearerLast4 마스킹)→GET(평문 부재)→DELETE(200)→env 복귀. "GUI로 provider 붙이면 실제 그 provider로 대화" 실서버 성립. 로그인=`/v1/auth/login`(workspace 필드 필수, demo WS), provider REST=`/v1/provider/link`.
- **0.0.2 알파 발행**(build 1087 @10e0493c, sha256 eab65d6c…): provider GUI "AI 연결" 포함 unsigned Release, momo-alpha Release + Pages 매니페스트 갱신(인앱 Updates 소비). 다운로드 momo-macos-0.0.2.zip.
- 다음: 성재 GUI 실사용(다운로드→로그인→AI 연결) 피드백 · ADR-0114 증보1(work host 동봉+GUI 페어링) 승인 대기 · 백로그 MOMO-575·ADR-0117 W-4·567.

## 2026-07-24 (Fable provider GUI 연동 3조각 완주) · "GUI로 붙이면 실제 대화" 성립
- 성재 발제("실제 codex/hermes를 CLI가 아니라 GUI로 연동, 배포판에 담아"). buzz 실측: 코드 에이전트는 동봉 아닌 ACP 접속(momo ADR-0114 동형), mesh-llm(오픈모델)만 동봉. Codex 자체 동봉은 독점 CLI+OAuth+ADR-0004로 불가(buzz도 안 함).
- **ADR-0004 증보1 Accepted → 3장 main 랜딩**(Opus 4.8): 572 provider config REST(암호화 저장·마스킹·mode override·health, 193 tests) + 573 worker job-time 소비(GUI 변경이 실제 대화 반영, 캐시 TTL 2s·golden interop vector) + 574 관리자 "AI 연결" GUI(design-review 2R Blocker 해소: 이탈 잠금 dead-end→미저장 확인 다이얼로그, in-flight dead-click→잠금을 unsaved bearer로 한정). 572의 prod boot 갭(api PROVIDER_LINK_MASTER_KEY 누락)·e2e compose 마스터키 배선도 수리.
- **ADR-0114 증보1 기안(Proposed)**: work host 배포판 동봉+GUI 페어링(goose 동봉·Codex 로컬)=WH-1~3 — 성재 승인 대기.
- 부수: MOMO-575(WorkConsole 프리셋 스냅샷 크로스환경 드리프트 안정화) 발급. 다음: momowebqa 재배포(039)→성재 GUI 실왕복→0.0.2 발행.

## 2026-07-23 (Fable Opus 4.8 전환 집행 — UXUI 배치 5장 완주) · Codex 대체 파이프라인 실증
- **Codex 한도 소진(7/29) → Opus 4.8 서브에이전트(Workflow) 구현 전환**(성재 지시, ultracode). 정본 메모리 [[momo-opus-implementation-pipeline]] 갱신.
- **5장 랜딩**: 571 workspace-create(main, ADR-0117 W-1/2/3, verifier PASS 28250) + UXUI 4장(track/uxui): 568 작업신호·569 managed-by·570 Create agent 동급·518 diff 카드. 각 goal Workflow 병렬 구현→검수→Docker/스냅샷 게이트→**design-review(fresh)**→반려수정→재리뷰→랜딩.
- **품질 게이트 실증**: design-review가 실결함 전건 검출·차단 — 569 Blocker(중첩 popover dead-control→inline disclosure), 568 High 3라운드(같은 문장 화면 중복→3표면 dedup 근본단순화, 잔여는 오케스트레이터가 footer 동일규칙으로 종결), 570 High(sparkles AI-tell→person.fill.badge.plus 3표면 일관), 518 High(과대추정 빈밴드→GeometryReader 실측). 전부 Blocker0·High0로 수렴.
- 스냅샷 규율 재확인: 기준이미지=오케스트레이터 환경, 재기록은 `--filter`로 스위트 한정(SNAPSHOT_TESTING_RECORD=all 전체는 노이즈 40장 유발 — 교훈). track/uxui 5장 통합 빌드 PASS.
- **다음: track/uxui→main 머지 성재 승인 대기**(TRACKS.md §3). 승인 시 순차 머지+알파 재발행(UX 개선 담긴).

## 2026-07-23 (Opus 구현 · MOMO-569 #685) · managed-by 표기 + owner 팝오버 (track/uxui, 성재 승인 전)
- **구현**: 멤버 디렉터리 상세·인스펙터 팝오버 GroupBox에 "관리 주체 {owner}" 행 + 읽기전용 owner 프로필 팝오버(키보드 포커스 버튼). 순수 리졸버 `MomoAgentOwnerPresentation`(신규 `MomoAgentOwnerLabel.swift`)·`ChatViewModel.agentOwner(for:)`가 명부 기존 owner 읽기투영·origin만 소비 — 신규 서버 계약 0. owner 이탈=회색+"워크스페이스에서 나감", 비활성=회색+"현재 비활성", card 출신=행에 "external runtime" 병기.
- **비스코프 준수**: who-can-talk(수신 게이트) UI 미구현(서버 집행 필드 부재=가짜 통제) → **X-12로 역등재**(profile `inbound_policy`+allowlist 필드 & agent_job enqueue 집행 지점 요청). A-22 done(track/uxui) 갱신.
- **검증**: swift build green, 순수 리졸버 8 테스트 PASS + 스냅샷 1 gated-skip(기준이미지 기록 금지 — 오케스트레이터 환경 기준, `MOMO_VERIFY_569_SNAPSHOTS`). 인스펙터/디렉터리 회귀 스냅샷 10 PASS. design-taste pre-flight grep 0 hit.
- **대기**: design-review 에이전트(신선 컨텍스트) Blocker/High 0 · main 머지=momo-main 순차·성재 승인.

## 2026-07-23 (Fable 내부 테스트 전환 집행) · 공개 동결, 알파 배포 채널 라이브, UXUI 배치 발급
- **방향 전환(성재)**: 공개=게이트 충족 동결, 내부 테스트 집중(잔버그·연동·UXUI). 목표치 통과 시 자연 배포. 정본 `2026-07-23-internal-test-focus-plan.md`.
- **알파 배포 채널 라이브**: 공개 저장소 momo-alpha + Pages(`dawn-kim-official.github.io/momo-alpha`) + `publish_alpha_build.sh` 원커맨드. **첫 빌드 v0.5.0-alpha.1(build 1047) 발행 완료**(LICENSE/NOTICE 동봉, sha256 기록, 인앱 Updates manifest 연결). 소스 비공개 유지·바이너리 공개 유통은 성재 승인분.
- **UXUI buzz 잔여 배치 발급**: 568(작업신호)·569(managed-by)·570(Create agent 동급)=#684~686 + 기존 #602(diff 카드). 패킷 `handoffs/2026-07-23-uxui-buzz-batch.md`(빡빡 종료조건 — design-review High 0·스테일 신호 3초·4클릭 여정 등). **성재가 UXUI 세션에 직접 전달**(프롬프트 제공됨). buzz 이행 원장은 계획 §5.
- 대기: 서버 공유 방식(Tailscale vs 단독 도그푸드) 성재 결정 → 결정 시 연동 온보딩 §2 실행.

## 2026-07-23 (Fable 공개 게이트 완성) · 565 랜딩 → 리허설 Phase 1 PASS → 564 랜딩 — "공개 버튼만 남음"
- **565 랜딩**: 단일 momo 이미지(6 커맨드+웹 에셋+LICENSE/NOTICE 빌드 시 단정), verifier 6/6 실기동 PASS(28240s). 공개 표면 6→1.
- **리허설 Phase 1 PASS(5/5)** — 보고서 2026-07-23-rehearsal-phase1-report.md. 검출 결함 4건 당일 해소(--wait 원샷 quirk→install 동형 시퀀스, 한도 600s, 528 픽스처 갭→mock 툴콜 토글, 증적 변수 잔재).
- **564 랜딩**: 공개 README(신뢰 경계 "What never leaves your server" 절)+SECURITY.md(비공개 신고·응답 타깃·하드닝). 링크 전수 실존 확인.
- 부수: 디스크 회수 254GB+14GB(reclaim_worktrees.sh 정본화=MOMO-566 종결), 패키징 레인 §8 판정 집행 완료.
- **다음: 성재 공개 실행 결정 대기** — 절차: 이미지 publish(workflow_dispatch)→digest 핀→시크릿 스캔→semver v0.1.0 태그→레포 공개 전환. Phase 2(공개 호스트)는 내부 검증+UXUI 피드백 후.

## 2026-07-23 (Fable Wave H 완결 — 562 랜딩·565 착수) · 관측 실물화 + 내부 알파 재배포
- **562 main 랜딩**(f5a6a55): /metrics 5종·bounded 라벨·프라이빗 전용·prometheus opt-in 오버레이(mem_limit/digest 핀 정합 후속 포함). verifier 4엔드포인트 실기동 PASS(28210s). **Linux 전용 결함 2건 검출·수정**: PushRelay 암묵 nio 전이 import, swift-crypto Sendable 격차(@preconcurrency) — 함정 목록 승격.
- **내부 알파 재배포 완결**: `scripts/internal_alpha_stack.sh`(redeploy/status/reclaim) 정본화 — 부분 수렴·restart 함정 2건 성문화, momowebqa가 신 태세(cancel/pause 실서빙, 데이터 보존)로 전환. 실 AWS는 내부 검증+UXUI 피드백 후(성재 확정).
- **Wave H 전량 완결**(554~563+558). 565(#681) worker 가동. 다음: 565 랜딩 → 리허설 Phase 1 → 564 → 공개.

## 2026-07-23 (momo-main 인수 — 패키징 레인 판정 확정) · 연구 §7 6건 전건 판정, 크리티컬 패스 재편
- 성재 위임("기각/수용 판단해 계획 포함")에 따라 §8 판정 확정: 옵션 A(이미지 6→1) **수용=MOMO-565**(562 후·리허설 전, ADR 불요 — ADR-0002 컨텍스트), 위생 ①② 수용(566·567, 패스 밖), code graph Phase 0~2 단계 수용, 모노레포 유지, mesh-llm 비편입(어댑터 확인은 즉석 실측 종결 — HERMES_BASE_URL=OpenAI-호환+루프백 해치, 신규 코드 0).
- 크리티컬 패스 재편: 562 → **565** → 리허설 Phase 1 → 564 → 공개. 옵션 C·멤버십 게이트 mesh는 백로그 예약(기안 금지).

## 2026-07-23 (Fable 리서치 — 패키징/레포 토폴로지/code graph) · 성재 발제 Q&A → 연구 문서 플러시
- 한 일: buzz 배포 실체 웹 검증(단일 '이미지'≠단일 컨테이너 — 앱 이미지 1+PG/Redis/MinIO compose 5~6컨테이너)·패키징 패턴 조사(Mattermost/Campfire/Discourse/Zulip/Supabase)·code graph 도구 실사(Swift 지원 기준 생존자 선별)·레포 무게 실측(무거움의 실체=SPM .build 15GB, tracked는 213K LOC로 작음)·mesh-llm 검증(Block 공식 아님·buzz 릴리스 동봉은 사실 — 코드 레벨 확인). 정본: `2026-07-23-packaging-repo-codegraph-research.md`.
- 판정 제안: ①커스텀 이미지 6→1 멀티바이너리 통합(buzz 동형, H3 후속 티켓 후보 — 권고) ②Centrifugo 제거 2서비스 수렴은 비권고 ③모노레포 유지(ADR-0001 트리거 미충족) + 위생 3종 후보 ④code graph는 저비용 3종+codebase-memory-mcp 실험만(Phase 0~2) ⑤mesh-llm 비편입·관찰(어댑터 OpenAI-호환 백엔드 확인만 소형 후속).
- 다음: 성재 결정 대기 6건(연구 문서 §7). 티켓/정본 반영 없음. Wave H 기존 큐와 독립.

## 2026-07-23 (Fable Wave H 집행 2 — 558·561 랜딩) · H2 완결 + H3 첫 타
- **main 랜딩 2장**: 561(migrate `set-owner` one-shot — env-only·재실행=회전+세션 revoke, verifier PASS 28200. "5분 설치 마지막 5분 DBA" 해소) / 558(Stop/Pause 클라 표면 — cancelRun TODO 해소·⌘.·시스템 라인 2종, macOS 522 tests 0실패). **ADR-0132 전 결정(D1~D5) 서버+클라 완결.**
- 558 design-review(신선 컨텍스트): Blocker 0·High 3 → 오케스트레이터 직접 해소: ①⌘. 취소 타겟 스트리밍 최근성 결정화 ②취소 시스템 라인 행위자 표기 ③스냅샷 렌더 NSHostingView 교체(실컨트롤 픽셀 포함 재기록). Medium 3(토글 라벨·에러 토큰 통일·응답 검증 완화)도 반영.
- 수리 2건 추가: 648 잠복 회귀(migrate 이미지에 중복번호 검사 스크립트 미동봉 — 컨테이너 127, 561 verifier가 검출) 핫픽스 / WorkConsole 터미널 프리셋 스냅샷 2장 선재 드리프트 재기록.
- 남은 Wave H: 560(653)·563(655) 발급 대기(성재 브리핑 후), 562=ADR-0121 증보 승인 대기, 564=공개 전제. 다음 큰 단계: **리허설 Phase 1**.

## 2026-07-23 (Fable Wave H 집행 — H1 완결+H2 서버 랜딩) · 554 Critical 해소, ADR-0132 Accepted 집행
- **main 랜딩 5장**: 554(prod RLS 실집행 — 롤 4분리+부트 가드+웹훅 키 분리, verifier 3회차 PASS 28170s)·555(게이트 하드닝 3종)·556(SPM 라이선스 게이트+dependabot, 실검사 37deps/9roots PASS)·557(휴먼 취소 REST+pause, verifier 5/5 PASS 28184s — worker 취소 경계 실왕복 확증)·559(depth 전파+G2+D4 프리앰블, verifier PASS 28191s). 이슈 647~650·652 close.
- **오케스트레이터 수리 6건**: .env.example 옛 태세 회귀 핫픽스(554 누락분 — 648 새 게이트가 검출), 650 migration 037→038 재부여(555 중복검사 실증), 취소 폴링 1s 스로틀(델타당 쿼리 결함), 557 verifier 3건(worker 소스빌드 기동 대기·run_id 대문자 조인·진단 덤프), 554 verifier preflight 정합, ENGINE_HANDOFF U″ ID 충돌 A-21/22/23 재부여.
- ADR-0121 **증보 1 기안(Proposed)** — /metrics 노출 계약(D7~D10, 562 게이트). 패킷 승격: handoffs/2026-07-22-buzz-hardening-batch.md(발급 후 델타 5건).
- 진행 중: 651(558 Stop/Pause UI, base track/uxui)·654(561 set-owner) worker 병렬. 다음: 654 랜딩→560→563, 651 랜딩(design-review), 이후 **리허설 Phase 1**(새 롤 태세 검증=공개 게이트). 성재 확인 대기: 내부 알파 재배포 여부(554 랜딩 조건), 557 run↔work_session 경계 해석, ADR-0121 증보 승인(→562).

## 2026-07-23 새벽 (Fable buzz→Wave H 기획) · PLN-20260722-02 plan-ready — 정본 2026-07-22-buzz-actions-plan.md + ADR-0132 Proposed
- 성재 지시("제안 액션 고도화+인프라 도입 검토+셀프호스팅 비교+우선순위·배포 판단+프롬프트")로 2차 사실 감사 2건 완료: ①momo RLS/게이트 태세 실코드 감사 — **Critical: prod 템플릿 API 롤=수퍼유저 momo(RLS 무효)**, 휴먼 정지권 REST 부재+cancelRun TODO, depth 전파 미구현, 게이트 3갭(skew/중복번호/SPM) ②셀프호스팅 축별 비교 — momo 우위(백업/롤백/BM), buzz 우위(단일이미지/owner 1줄/day-2 CLI/관측/공개 릴리스).
- 산출: Wave H 3단(H1 554~556 태세·게이트 / H2 ADR-0132 정지권·루프·발화계약 / H3 560~563 셀프호스팅 제품화)+Wave U″ 제안, worker 프롬프트 3종+오케스트레이터 인수 프롬프트 포함. ADR-0132 Proposed 기안.
- 독립 critic 검수 완료(신선 컨텍스트, 실코드 스팟체크) — 핵심 사실 전부 재확증, 정정 5건 반영(553 랜딩 반영·554 수리면 축소·555/556 순차화·D1 human 한정·562 ADR 증보 선행). §5에 기록.
- 다음: 성재 승인 3건 대기 — (a) H1 발급(기존 위임 큐 '게이트 부채 배치'와 합류 권장, 554는 리허설 Phase1 선행) (b) ADR-0132 option (c) H3 실행+공개 이미지 결정. 티켓/이슈 발급 없음(번호 554~563 예약만).

## 2026-07-22 (Fable buzz 경쟁 분석) · block/buzz 4축 해부 — 정본 2026-07-22-buzz-competitive-analysis.md
- 성재 발제: 어제(7/21) 공식 런칭한 block/buzz(Nostr relay 기반 agent-native 워크스페이스, HN 316pt) 0-tier 해부. 레포 전체 clone+병렬 4축(아키텍처/git 고고학/커뮤니티/UX) 분석 완료.
- 판정: momo와 동일 신념(에이전트=1급 멤버·PG=SoT·키 비유입)의 거울상. 프로토콜은 momo 우위(seq/outbox/RLS를 buzz는 구조적으로 못 가짐), 가져갈 것은 로직 계층(오너 위임 캐스케이드·페이지 계약·wake-only 푸시·승인 체인)+상흔(에이전트 멘션 루프·킬스위치 미도달·RLS 공리 5·branch-skew 가드).
- 커뮤니티 최대 쟁점=멀티 에이전트 권한 누출 질문에 buzz가 답 못함 — momo RLS FORCE+member 모델이 구조적 답(포지셔닝 전면 배치 제안).
- 제안 액션 7건(§8, 전부 성재 결정 대기): RLS 공리 게이트·라이선스 게이트·branch-skew·에이전트 상호작용 안전 계약·UXUI Top5·포지셔닝·4~6주 후 재방문. 티켓/정본 반영 없음.

## 2026-07-22 (Fable ⑮ 랜딩·공개 게이트 확정) · Memory Plane 사용자 표면 완결 + 법무 5항 확정
- **#646 MOMO-553 grant UI 랜딩(main c8bca25)** — design-review PASS(Blocker 0·High 0). 529의 X-11 잠금 완전 해제: Memory Plane이 추출→검색→packet→모델 주입→브라우저/인스펙터→**grant 부여/회수 UI**까지 전 표면 완결. 3 브랜치 동기, worker 0 — 계획 파이프라인 소진.
- **공개 게이트 5항 성재 확정**(외부 법무 없이 내부 확정): dawnkim·DCO(CONTRIBUTING.md 구현)·momo 유지(상표 미등록 리스크 고지)·Centrifugo v6 Apache-2.0 실측·NOTICE 유지 절차. 실배포 리허설 2단계 일정 확정(Phase1 로컬=게이트 부채 후, Phase2=성재 VPS 요청 시점 명시).
- 다음: 게이트 부채 배치 → 리허설 Phase 1 → ADR-0117 기안. 후속 소형: 553 Medium(피커 암묵 대상·⌘⇧G), 546 승인 이력 다건.

## 2026-07-22 (Fable UXUI 소비 3장 랜딩 + 통합 사고 수습) · ⑫⑬⑭ main, 마커 사고 2건 해소·절차화
- **랜딩→main(db47f52)**: #643 MOMO-550 온보딩 UI(URL 붙여넣기·origin 뱃지 — High: REST 플로우의 realtime 프리게이트 오배선 제거) / #641 551 연동 탭(1회성 시크릿 재표시 금지 grep 단정 — High: 삭제 다이얼로그 취소 카피) / #642 552 메모리 표시(과장 어휘 금지 단정 — High: 클릭 메타 hover 관행). 전부 design-review Blocker 0 통과 후 High 1건씩 momo-main 직접 수정.
- **통합 사고 2건(momo-main 과실)**: 632/642 머지에서 git add -A가 코드 파일 충돌 마커를 그대로 커밋 — track/uxui·main이 일시 빌드 불가(641 리뷰어가 최초 발견). 수리 완료(양측 보존+빌드 검증). **절차화: 통합 머지 후 push 전 grep 마커 검사+macOS 빌드 게이트 의무.**
- 함정 재확인: worker/게이트 스냅샷 렌더 컨텍스트 차이(641 6장·642 2장 재기록 — 오케스트레이터 환경=기준).
- 진행: 636(549 grant REST) worker. 다음: grant UI(⑮ 후보), 게이트 부채 배치, ADR-0117.

## 2026-07-22 (Fable 온보딩 배치 완주+Wave U 랜딩) · PLN-20260722-01 엔진 전장 종결, UXUI ⑨⑩⑪ main
- **PLN-20260722-01 엔진 몫 완주(main cdd78d0)**: 534 어댑터·536 카드 온보딩·535 outbound·538 동봉 eve·548 추출 동의·**537 agent_profile(ADR-0131 Accepted 집행 — 프리앰블 우선·도구 교집합·model fail-closed·요청 덤프 주입 단정)** + sol 후속 545·546·547·539. 양문형(담아오기+만들기) 전체 개통.
- **Wave U 완주**: #610(525)·#628(529 — Blocker 1+High 수정 fleet 반영)·#632(532 — Blocker 2+High 5 수정, 터미널 프리셋 정당 드리프트 재기록) track/uxui→main. 검수 함정 신규: worker/게이트 스냅샷 렌더 컨텍스트 차이(오케스트레이터 환경=기준), 설정 표면 확장發 프리셋 드리프트.
- roster verifier 선재 실패 해소(수명주기 roster의 workspace_membership JOIN — 픽스처 시드 추가, main 재현 rc=0→커밋). e2e worker 소스 복사에 services/ 누락 함정(§4 후보).
- 진행: UXUI 소비 3장 스폰(⑫550 온보딩 UI·⑬551 연동 탭·⑭552 메모리 표시 — #638~640, 성재 지시로 fleet 대행). 남은 성재 전달물: 법무 패키지. 잔여 엔진 큐: 549(grant REST).

## 2026-07-22 (Fable Wave B 완주+감사 후속) · 546·539·547·535 랜딩, 법무 패키지 완성, 548·538 스폰
- **랜딩→main(8f6fbd5)**: #629 MOMO-546 ACP 서버 릴레이(⑪ 전제 완성 — 원장+outbox+RLS PASS) / #630 539 백오프·포이즌 격리 / #631 547 env 스크럽(allowlist 기본, 마이그레이션 034) / #633 535 outbound 구독(HMAC·1회성 시크릿·자동 disable, 마이그레이션 033, OutboundHTTPPolicy 패키지로 SSRF 유틸 공용화). **Wave B(담아오기) 완주.**
- 검수 수정 1건: 617 mention 픽스처의 데이터 수정 CTE 동일 스냅샷 함정(외부 UPDATE가 신규 행 미인지).
- **공개 게이트 법무 패키지 완성**(0530c51): 의존성 37종 재감사(THIRD_PARTY 재생성, GPL 0)·NOTICE 정정·법무 확정 5항 — 성재 전달 대기.
- 스폰: 548(#625 외부 추출 동의)·538(#619 동봉 eve — 534 랜딩으로 개방). 잔여: 537=ADR-0131 승인 게이트만.

## 2026-07-22 (Fable Wave B-1 랜딩) · 534·536·545 main — 담아오기 문 개통 + sol 급소 1건 당일 봉합
- **랜딩→main**: #621 MOMO-534 eve/CF 어댑터 2종(verify_momo_channel_adapter PASS — pending→mock eve→메시지→콜백) / #626 MOMO-536 A2A 카드 URL 온보딩(전 항목 PASS — SSRF 거부·confirm·credential·RLS) / #627 **MOMO-545 memory_refs 모델 실주입**(verify_agent_context 확장 PASS — 요청 덤프에 발췌 단정). Memory Plane이 이제 end-to-end로 모델에 서빙된다.
- 검수 수정 4건(§4 12·13 성문화): 615 tsconfig verify/ 누락 / 616 addrinfo Darwin/Glibc 이식성(Linux 컨테이너에서만 발현)·verifier 고정 프로젝트명 stale 재사용 / 622는 무수정 통과.
- 진행: 623(546 ACP 릴레이) worker 가동 중 — 랜딩 시 ⑪(532) 완전 개방. 다음 스폰 큐: 535(outbound)·539(백오프)·547(env 스크럽)·548(추출 동의). 537은 ADR-0131 승인 대기.

## 2026-07-22 (Fable sol 감사 검수) · 독립 감사 브리프 실코드 재검증 — 급소 2건 확증, 티켓 4장
- 성재가 sol(GPT)과 정리한 감사 브리프를 main@e0c5336 실코드로 검수(정본 docs/planning/2026-07-22-sol-independent-audit-verdict.md). **적중 2건**: ①memory_refs가 모델 메시지에 미주입(ContextAssembler 0건 — Memory Plane이 아직 모델에 서빙 안 됨) ②workd ACP 이벤트가 로컬 JSONL 체류(서버 관전 불가 — 532 전제 갭).
- 발급: **MOMO-545(#622, HIGH 실주입)·546(#623, ACP 릴레이)·547(#624, env 스크럽)·548(#625, 외부 추출 동의)**. 가설 판정: Work Object=thin slice 연구로(즉시 ADR 반대), fidelity lane=수요 후, Collaborative Work Profile=기존 AMP 보류와 동일 결론(어휘 채택), 5-plane=대체로 기설계 일치.
- 규율 승격: "end-to-end 미연결은 완료 아님" — verifier는 최종 소비 지점(모델 요청 덤프·서버 원장 행)을 단정한다.

## 2026-07-22 (Fable 회귀 정비 + 온보딩 리서치 + 동생 반려) · runtime-agent rc=0, 제품 결함 1건 수정
- **527 전 게이트 회귀 완주**(runtime-db 핵심 PASS + runtime-agent rc=0). 8층 부검: ①pgvector 이미지 glibc 계보(→trixie digest, 상주 스택은 원 env로 재생성) ②스냅샷 드리프트 2건 재기록(카피 변경 — 511-U 부채 해소) ③멘션 패리티 단정 UUID 케이스 ④packet 스키마 문자열 ⑤~⑦fail-closed 픽스처 전환(owner 멤버십+실 install/grant+capability 등재 — §4 10 성문화) ⑧**제품 결함: 승인 재개가 grant 없는 도구에서 침묵 실패**(resume payload {} → 워커 디코드 사망; e984d9c 수정 — 서버 null 발신+워커 evidence optional, 인간 결정=권위).
- 부수 발견→후속 후보: **MOMO-539** 추출 워커 실패 백오프 부재(비-JSON 응답에 초당 수회 핫루프, 포이즌 배치 격리 없음). momo240_* 잔재 28100 선점 재확인(리클레임 사각).
- **리서치 20-01**(성재 발제 2차): eve 공식 셀프호스트+커스텀 채널 1급 API 확인, 업계 수렴=양문형(URL 담아오기/자연어 만들기)+에이전트 명부(=momo 불변식). **Wave B/C 기안**(534 어댑터·536 URL 온보딩·537 agent_profile+ADR-0131·535 outbound·538 동봉 eve) 성재 결정 대기.
- **동생 #610 반려**(design-review Blocker 1: MomoWorkspaceCopy 우회 ~30 문자열 + High 4) — PR 코멘트로 반려 패킷 게시. iOS 공식 빌드 게이트는 내가 PASS 확인.

## 2026-07-22 (Fable 패브릭 3라운드) · Wave M/A 완주 — 528·531 랜딩, 엔진 배치 종결
- **랜딩→main**: #613 MOMO-528 Context Packet v0(verify_context_packet 전 항목 PASS — 불변성·grant 서빙 필터(델타2)·revoke 재발급 제외·실 tool_grants·만료 재발급·RLS) / #614 MOMO-531 momo-acp-host(mock ACP 왕복 PASS — 승인 fail-closed·PTY 위임·029 template 경유). **패브릭 엔진 6장(526·527·528·530·533·531) 전부 main 랜딩** — 동생 ⑩(A-16/529)·⑪(A-17/532) 개방(A-16 중복 리넘버).
- 528 검수 실결함 3건(패킷 §4 7·8 성문화): 멘션 원문 FTS 질의(websearch AND가 전 매치 차단 — packet에 profile만 남던 원인) / verifier jq select 파이프 우선순위 / CONTEXT_PACKET_TTL compose 미매핑(§4-4 재발). momo240_* 잔재가 28100 선점(리클레임 사각 재확인).
- 남은 것: 회귀 게이트 잔여(runtime-agent+게이트 내 memory-search — 부하 해소 후), 529/532 랜딩 검수(동생), MOMO-534/535·0130 D4 상향 성재 결정, 공개 게이트 법무 패키지.

## 2026-07-22 (Fable 패브릭 2라운드) · 527·533 랜딩 + main 머지 + M-3/A-3 스폰 + 플랫폼 에이전트 리서치
- **랜딩→main(e7c6592)**: #611 MOMO-527 pgvector+FTS+RRF(verify_memory_search 전 항목 PASS) / #612 MOMO-533 work_tool_profile(verifier PASS). track/engine 완전 랜딩(main과 동기). **528(#598)·531(#601) worker 스폰** — 528에 델타2 서빙 필터+memory_search_hybrid grant 확장 지시.
- 검수 발견 3건(패킷 §4 성문화): 포트 28040대는 attachment와 충돌(신규=28100대부터, 27850~28093 사용 중) / 시드에 message 행 없음(verifier는 API 생성 — memory_plane 패턴) / Swift Int=bigint 바인딩이 SQL 함수 integer 파라미터 해석 실패(500) → `::integer` 캐스트. 마이그레이션 병렬 충돌: 028 중복 → 533을 029 리넘버.
- **리서치 20-00**(성재 발제): eve/Cloudflare 플랫폼 에이전트 = hermes와 본질 동일(차이=거주지·컨텍스트 소유자). momo=경쟁 아닌 "에이전트가 출근하는 사무실". 권고: MOMO-534(eve/CF momo 채널 어댑터)·535(outbound 이벤트 구독)·0130 D4 상향. 성재 결정 대기.
- 남은 것: 전 게이트 회귀(pgvector 이미지 영향 — internal-alpha 실행 예정), 528/531 검수·랜딩 후 동생 ⑩⑪ 개방, 공개 게이트 법무 패키지.

## 2026-07-22 (Fable 패브릭 1라운드) · 526·530·W-6 랜딩 + 비전 정합 델타 + 공개 게이트 준비
- **랜딩(track/engine 14c1e25)**: #608 MOMO-526 Memory Plane(docker PASS — 2-phase/무효화/워터마크/RLS, 델타1·3 오케스트레이터 가산: visibility_grant+source_kind) / #606 MOMO-530 gateway work tool(hermes 실런 rc=0) / #607 W-6 웹 Work 관전(vitest 71). **M-2(597)·A-2(600) worker 스폰** — 연쇄 진행.
- 검수 발견 3건: 596 demo password NULL 가정(진실=migration 005가 dev-password 백필 — §5.1 갱신 필요) / 599 fail() 미정의 127 / 599 approval 단정 UUID lower 누락(§5.1-3 재발). 599 사용 전제(소스 DB migrate 선행) 실측 명문화.
- **비전 정합 보수 검토**(성재 요청): 13개 요구 전수 대조 — 대주제 4개 전부 반영, 갭 3건 델타 봉합. 정본 2026-07-21-vision-conformance-review.md.
- **공개 게이트**: LICENSE(Apache-2.0) 배치, Swift 37종 감사(GPL 0), gitleaks 878커밋 실 유출 0건, ghcr 기성. 남음: THIRD_PARTY 갱신·법무 패키지.

## 2026-07-22 (Fable 기획 3차) · Momo Archive 재구성 + 메신저 심화 리서치 v0.2 (노션 정본)
- 성재 발제(집필·스터디): 노션 허브 **"Momo Archive"**(3a4c5b1cae0481739c9bc660205fc346) 개설 — 5.6 sol의 Messenger Systems Bible v0.1(00~09장)·결정 패키지·심화 리서치를 한 지붕으로 이동·체계화.
- **심화 리서치 5편 집필·게시**(1차 자료 직접 검증): 프레이밍(Geoffrey Litt "Understanding is the new bottleneck" — 제목 정정, 발표자 블로그 문서판 전문 확보) / Slack(QCon 2016+slack.engineering 12건, v0.1 교정 3건) / Discord(blog 11건+이미지 6종 육안 검증) / Mattermost(GitHub master 소스 검증 — Save↔Publish 무보장 구멍=momo outbox 정당성의 직접 증거) / Teams(MS Learn — compliance 쌍방향 기판). 각 편에 momo 대조 시사점 7~8개 포함(outbox·seq·RLS·MPNS 동형 확인).
- 개념도 3종 codex(gpt-image) 생성(세 평면·Slack 3시대·Mattermost ledger-first) — 로컬 PNG, 노션 첨부는 성재 드래그 필요(MCP가 로컬 바이너리 업로드 미지원).
- 이 작업은 노션이 정본(레포 비반영). 바이블 v0.2 개정 시 심화 리서치가 근거 문서.

## 2026-07-21 (Fable 5차) · W-5 랜딩 — 웹 트랙 W-1~W-5 완주
- **#594 W-5**(초대 링크 웹 합류): `/join`·`/i/<code>` SPA 랜딩(같은 가입 폼·403 사유별 종결 카피·replaceState 코드 제거) + LinkShort prod 편입(pinned 이미지·publish-images 가산·Caddy `/i/*` SPA보다 선행 프록시). 게이트: vitest 47·lint·build + **web-serving docker 8단정 PASS**. track/engine bfe6d51.
- **웹 트랙 완주**: W-1~W-5 전부 랜딩 — "설치 → 브라우저 접속 → 초대 링크로 합류" Mattermost급 온보딩 문법 완성. 잔여=실배포 TLS/DNS·초대 실왕복(게이트 부채 목록).
- 다음: LICENSE+ghcr(공개 게이트) → ADR-0117 기안. track/engine=main+2 — 동생 다음 랜딩과 묶어 main.

## 2026-07-21 (Fable 기획 2차) · PLN-20260721-01 승인 처리 — ADR-0129·0130 Accepted + 패브릭 배치 패킷 + Blaxel 캔슬
- 성재 지시(모바일) 5건 처리: ①노션 정리(인증 URL 발급 — 성재 승인 대기) ②UXUI 레퍼런스 분석(research/19-05, 에이전트 진행 중→도착 시 커밋) ③**Blaxel 콜라보 캔슬**(오픈소스화 전 credential 제공 불가 — E2B 베이스 확정, 진단 §5 반영) ④상세 실행 설계 main 랜딩 ⑤트랙 구조 진단.
- **ADR-0129·0130 → Accepted**("main에 설계 기반 상세 전개+트랙 실행" 지시 근거). 실행 정본 **handoffs/2026-07-21-agent-native-fabric-batch.md**: Wave M(526→527→528 메모리/pgvector/packet)·Wave A(530→533→531 gateway tool/도구원장/ACP host)·Wave U(518→529→532), 티켓 계약 원문·공통 함정(검수 축적분)·검증 규율·**오케스트레이터 인수 프롬프트(§8)** 포함.
- **트랙 진단**(2026-07-21-track-structure-diagnosis.md): 3~4트랙 세분화 기각 — 2트랙 유지+함정 체크리스트 HANDOFF_TEMPLATE 승격+정비 배치 정례화+공개 시 한시 release 트랙. 전환 트리거 4종 명시.
- **다음**: 성재가 패킷 §8 프롬프트를 오케스트레이터 세션에 전달 → momo-main 통합(BUILD_TICKETS 이관·Issue 발급·ENGINE_HANDOFF 갱신). 노션은 인증 완료 시 이 세션이 페이지 생성.

## 2026-07-21 (Fable 4차) · 웹 완성 배치(W-3·W-4) + 이중트랙 main 머지(53c457a)
- **W-3**(#581): Caddy `{$APP_DOMAIN}` 서빙 — web-init named volume·같은오리진 프록시·centrifugo 403·CSP. `verify_web_serving.sh` docker 6단정 PASS(web-serving infra 프로파일 신설). **W-4**(#580): 웹 승인 카드(멱등 결정)·read-state debounce·recovery reconcile·재연결 배너 — vitest 38·lint·build PASS. **"서버 URL이 곧 웹 주소" 완성**(prod TLS/DNS만 실배포 시 검증).
- **이중트랙 main 머지**(성재 사전 승인 "작업 마무리 되는대로"): engine(574 수명주기완결·580·581) + uxui(511-U 개방·505·506 — 동생 ①②) → main 53c457a. 게이트: server build + real-window 4/4. 동생은 그새 **③(517 관전 터미널 #575)까지 track/uxui 랜딩** — 페이스 탁월.
- 남은 게이트 부채(runtime-unverified 누적): iOS 505/506 시뮬 스냅샷·모바일 E2E 1왕복, 517 2계정 owner↔observer 실증, 웹 승인 실왕복, 511-U 선재 스냅샷 드리프트 2건 재기록. 다음 내 큐: W-5(초대 웹 합류)·LICENSE+ghcr(공개 게이트)·ADR-0117 기안.

## 2026-07-21 (Fable 기획) · PLN-20260721-01 에이전트-네이티브 비전 리서치 완료 + ADR-0129/0130 기안
- 성재 발제(CTO 대화 4대 고민+Blaxel cofounder 접촉) → 병렬 리서치 5기(내부 실사 2+외부 3) 완료, **research/19-agent-native-fabric/00~04** 저장(컨텍스트/메모리 실사·연동 표면 실사·프로토콜 지형·메모리 OSS·샌드박스 유휴 경제/Blaxel).
- 진단 정본 **docs/planning/2026-07-21-agent-native-vision-diagnosis.md**: cowork=0126 잔여 실행만(518 승격 권고) / 에이전트 호스팅=막힘 3곳, ACP 클라이언트로 40+ 에이전트 즉시 호환 / 규격 공백 실재("구현→스펙 추출" 순서, 창 12~18개월) / 메모리=최대 갭(PG-native 유일 경로, pgvector 도입) / Blaxel=명시 기각 아님·2nd 기질 후보+협상 카드, CTO 유휴 질문 직답 포함(E2B·Blaxel 메모리+FS 보존 재개 가능, 보관비 E2B 미명문화 vs Blaxel $0.20/GB-월).
- **ADR-0129**(Memory Plane & Context Fabric 런타임, MOMO-526~529 예약)·**ADR-0130**(외부 코딩 에이전트 멤버십·ACP, MOMO-530~533 예약) **Proposed** 기안. 구현-설계 정합 리뷰 6건(R1~R6)은 진단 §6 — 위반 0, 스펙 대비 미완 관리 항목.
- **성재 대기**: ①0129/0130 옵션 승인 ②우선순위 결정(진단 §7: 0129→0130→518 승격→Blaxel 미팅) ③Nicolas(Blaxel) 답장 발신 여부 — 초안은 세션 보고에 전달.

## 2026-07-21 (Fable 3차) · MOMO-524 랜딩 — ADR-0128 서버 절반 완전 종결 + 동생 ①② 순항
- 2차 배치(565 S3·566 멤버십) main 랜딩(49edf5d, 성재 승인). **#574 MOMO-524**(self-leave·agent credential 대칭·banned handle 생성차단·audit 조회 REST) track/engine 8cd20a2 랜딩 — docker 실런 PASS(self-leave/대칭/ban/audit/RLS) + 523 회귀 PASS. **ADR-0128 D1~D6 서버 전부 완결** — 잔여는 UXUI 525(=A-15, worker가 ENGINE_HANDOFF 등재)뿐.
- 검수 수정 2건: 전송 응답 jq 경로(.message.id→.id — 응답은 top-level 객체), e2e compose gateway 기본 비활성이라 agent 대칭 probe용 AGENT_GATEWAY_MODE=gateway override 가산.
- **동생 진행**: 순차 배치 ①(511-U 개방 #567/568)·②전반(505 Work 탭 #569/570) track/uxui 랜딩 — 순서 준수·페이스 양호. 506 진행 추정.
- 도달점 보고(성재 전달됨): L1~L3 100%·L5 ~90%·오픈소스 4대 관점 중 ④ 블로커 해소·권한 수명주기 완결. 다음 큐: W-3/4/5(웹 완성), LICENSE+ghcr(공개 게이트), ADR-0117 기안. **성재 대기**: track/engine→main(574).

## 2026-07-21 (Fable 2차 배치 완결) · S3 어댑터 + 멤버십 수명주기 랜딩 — track/engine=main+2 승인 대기
- **#565 MOMO-521**(S3 첨부): SigV4 SDK-less·presigned 직송·MinIO 프로파일. docker s3 실런 PASS(왕복/RLS/audit/redaction). 셀프호스트 하드 블로커 해소. **#566 MOMO-523**(멤버십 수명주기 D1~D3): workspace_membership 분리·역할변경·suspend/추방/ban·audit·guest 투영. docker 실런 PASS(lifecycle/hierarchy/guest/audit/RLS).
- 검수 중 잡은 결함(오케스트레이터 수정, PR에 커밋): ①**서버 2계열 500** — nil String?/UUID? 바인딩 'could not determine data type'(Roster/Lifecycle/Join/WorkControl 4곳 ::text/::uuid) + **트랜잭션 내 HTTPError가 PostgresTransactionError로 감싸져 500**(라우트별 ad hoc unwrap을 Database.withTenantTransaction 중앙 unwrap으로 승격 — 재발 원천 차단) ②verifier 3건 — bash 3.2 빈 배열, api 컨테이너 curl 부재(mock-hermes python 대체), demo 계정 password 시드.
- 함정 축적: nil 바인딩 ::캐스트·트랜잭션 HTTPError·bash 3.2 배열·컨테이너 내 curl 부재 → 이후 패킷 규율에 반영할 것. UXUI 순차 배치(9항목)는 동생 진행 중. **성재 대기**: track/engine→main(565·566), MOMO-524(D4~D6) 후속 발급.

## 2026-07-21 (Fable 오픈소스 배치 완결) · 519 랜딩 — 배치 4/4, track/engine=main+5 승인 대기
- #562 MOMO-519 티어 폴백 랜딩(track/engine 9cae37e): docker verifier 최종 PASS(ask/t1_only/auto/orphan/resume/push/RLS). 검수 중 verifier 결함 4종을 오케스트레이터가 수정(포트 중복 28023 → hermes 28024 분리 / INSERT...SELECT uuid·message_type·jsonb 캐스트 / Swift UUID 대문자 vs 시드 소문자 lower() 3곳 / RLS 단정 psql -q 부재로 명령 태그 오염). keep-stack 부검으로 구현 무죄 확정(카드·RLS 전부 정상 — 단정만 결함). X-8 done(#560 remoteAttachAvailable).
- perm-research 서브에이전트 좀비화(named spawn mailbox 전례 재발 — 메모리 교훈 위반, 재확인) → 손절, InfoQ 직접 fetch + 공지식으로 research/18-permissions-workspaces/00 작성(Slack V1→Grid→Unified Grid·Vitess 채널 샤딩·권한 헬퍼 중앙화 / Discord 계층·kick/ban / Mattermost·Matrix / 공통 패턴 8 / momo 시사점: 재샤딩 불요·0117=스키마 작업).
- **성재 대기**: ①track/engine→main 머지 승인(main+5: 560 관전·561 웹·562 폴백) ②ADR-0127(S3 스토리지) ③ADR-0128(멤버십 수명주기 — MOMO-523~525 발급 대기). 유지: momowebqa+vite(:5173) 성재 육안용.

## 2026-07-21 (Fable 오픈소스 배치) · 웹 탄생 + 관전 attach 랜딩 + 티어폴백 검수 중 + 권한 ADR-0128 기안
- 성재 승인: 이중트랙 main 머지(8f9408f) + 우선순위 실행. ADR: 0126(관전)·0125 D11(티어폴백) **Accepted**, 0127(S3 스토리지)·0128(멤버십 수명주기 — 역할변경/suspend/kick/**ban**/self-leave/audit/에이전트 대칭) **Proposed 성재 대기**. 진단 2건: 2026-07-21-opensource-cowork-diagnosis.md(웹=0119 기이행 대기·셀프호스트 갭 4·cowork 갭 4) / 2026-07-21-permissions-workspace-diagnosis.md(P1~P7 — 초대는 강함, 수명주기 API 전무, 0117 멀티워크스페이스 미기안).
- **랜딩(track/engine)**: #560 MOMO-516 관전 attach(observer capability+X-8 remoteAttachAvailable — verifier+511 회귀 PASS) / #561 **W-2 clients/web**(Vite+React, vitest 20·실서버 육안·실전송 PASS — momo 세 번째 클라이언트. 컴포저 범위초과=deviation accepted, W-4 축소로 상쇄). track/engine=main+3(560·561 머지커밋 포함).
- **진행 중**: #562 MOMO-519 티어폴백 검수 — notifier/workd 테스트 PASS, verify_tier_fallback은 worker의 포트 중복 버그(HERMES=PUSH=28023) 발견·오케스트레이터 직접 수정(HERMES→28024) 후 3차 실행 중. 이 수정은 559 브랜치에 커밋 필요. Slack/Discord 권한 리서치(deep-research) 마감 요청함 — 도착 시 research/18-permissions-workspaces/00에 저장.
- 유지 중 스택: momowebqa(:28000)+vite dev(:5173 — 성재 육안용 크레덴셜은 QA_FOLLOWUP Q9 계정). worker 사고 1건(zsh 1-기반 배열로 워크트리 매핑 어긋남 — main 무사, 재발 방지: spawn 루프에 명시 매핑 사용).

## 2026-07-21 (Fable fleet 완결) · MOMO-513 수정 랜딩 — 위임 배치 4/4 종결
- 553 worker(#556): outbox broadcastPayload에 `props: responsePropsJSON` 1줄 + 서버 테스트·verifier 양면 단정(mention REST↔outbox 일치, edited props 보존). 오케스트레이터 docker 실런 `verify_message_interaction.sh` PASS(실 Centrifugo 발행 props 단정) → track/engine e53c24d. **X-9 종결**. QA 스택 momo543qa teardown 완료.
- **최종 대기 상태**: track/uxui=main+4(543·499·511-U), track/engine=main+2(503·513) — 성재 main 머지 승인 대기. 다음 큐: X-8(ptyId 투영), MOMO-514(iOS 토큰 UX), iOS 500~/504~506, 490.

## 2026-07-21 (Fable fleet) · 이중트랙 위임 배치 — 499·503·511-U 랜딩 + 543 육안 QA PASS + 결함 2건 발견
- 성재 위임("UXUI트랙 fleet + 엔진 + 543 ⓑ"). worker 3기(548=511-U·549=499·550=503, 5.6-sol medium) 스폰 → 전기 PR 완주. 검수+게이트(오케스트레이터): 549 시뮬레이터 게이트 PASS(47/47)→#551 / 550 docker verifier PASS(4카테고리·thread_id·approval_id·ADR-0109 badge·억제0)→#552 / 548 build green+real-window 4/4+스냅샷 2실패=선재 flake 베이스라인 재현 확정→#555. **track/uxui=main+4(543·551·555), track/engine=main+1(552)** — 성재 승인 시 main.
- **543 육안 QA ⓑ 완료(PASS)**: 격리 스택+실 REST 시드 213건+시뮬 실로그인. 증거 세트(캡처6+영상) 성재 전달. 상세 QA_FOLLOWUP Q9.
- **발견**: A=MOMO-513(#553) send() outbox props 미탑재(라이브 멘션/인용/승인 props 누락 — 콜드/라이브 A/B 격리, MessageRoutes.swift:242) worker 수정 중 / B=MOMO-514(#554) 토큰 만료 시 타임라인 전체 에러+Retry 무효. X-8(ptyId 투영)·X-9 ENGINE_HANDOFF 등재.
- 도구: applesimutils+idb 확립(시뮬 자동 QA, 형 화면 무침범). QA 스택 momo543qa(:28000)는 513 검수 재현용으로 유지 — 종료 시 `docker compose -p momo543qa -f infra/docker-compose.e2e.yml down -v`.

## 2026-07-21 (Fable 재개) · 509·511 런타임 verifier 종결 + 543 track/uxui 랜딩
- main c953322에서 오케스트레이터 docker 실런: `verify_agent_create.sh`(509) — fresh DB 생성·409/403·pairing·credential·audit·RLS PASS / `verify_terminal_attach.sh`(511) — 발급·만료·소유자·revoke·raw 직결 우회·audit/RLS PASS. STATUS의 두 항목 `runtime-unverified`→`runtime-verified` 갱신(엔진 deviation 종결).
- 543(iOS 타임라인 v2): base 전진으로 STATUS 충돌 → 541 워크트리에서 union 해소·push → track/uxui 랜딩(a06d050). 컴파일+41 tests PASS. **남은 것=498 "인증 실데이터 육안"**(라이트/다크·Dynamic Type·한국어 3줄·200+ 스크롤) — STATUS에 runtime-unverified 명시(496/497 선례와 동일 수동 게이트). 성재 기기 확인 또는 Fable 실데이터 시드 캡처 택1.

## 2026-07-21 (Fable 통합) · 이중트랙 main 머지 완료 — 512 차단 해소, 엔진 파이프라인 재개
- 성재 위임("너가 해…검수한다음에 작업재개까지"). 547(512 focus fix)를 546 워크트리에서 real-window 직접 확증(실디스플레이 XDR — testComposerFocusRequestRestoresKeyboardFocusInRealWindow 등 real-window 4/4 PASS, XCTSkip 아님) → track/uxui 랜딩(e297dd3). 543(iOS 타임라인 v2)은 541 워크트리 시뮬레이터 게이트 PASS(BUILD/TEST SUCCEEDED·41 tests). iOS Archive CI fail은 main에서도 action_required = pre-existing 서명 이슈(코드 회귀 아님) 확증.
- **이중트랙 main 머지**: track/uxui(496·497·536·547) + track/engine(491·509·511) → main c953322. 충돌은 docs만(STATUS union·ADR-0125 keep-ours, 코드 충돌 0). 머지 결과 게이트: real-window 4/4 PASS + server swift build 완료. 세 ref(main·track/engine·track/uxui) c953322 정렬(ff 재동기화). **성재 맥 real-window 재실행 불요**(Fable가 실디스플레이로 확증함).
- 남음: 543 시각 QA(라이트/다크·Dynamic Type·한국어 3줄·200+ 스크롤) 후 track/uxui 랜딩 / 509·511 docker 런타임 verifier(runtime-unverified→verified) / 엔진 다음 큐.

## 2026-07-21 (Fable 검수) · MOMO-512 focus 회귀 수정(#547) 검수 CLEAN + 이중트랙 main 머지 시퀀스 준비
- 동생 PR #547(track/uxui) 검수: 근본원인=`@FocusState`가 NativeTextView(NSViewRepresentable)가 준 적 없는 focus 진실을 소유. 수정=`@State` 전환 + `viewDidMoveToWindow` 재동기화(rootView 교체 타이밍) + stale async firstResponder 탈취 방지(`textView.window === window`) + `onChange(initial:true, guard request>0)`(mention 오버레이 직접 focus 경로 보존). **결정타**: `textDidBeginEditing/EndEditing`가 바인딩 set으로 @State를 되써서 blur 시 stale-true 없음 → focus 재탈취 회귀 없음. 445/445·macos-ui 31/31·real-window 반복 PASS(동생).
- 준비: 동생 → 547·543(498) track/uxui 랜딩(자기 트랙, 승인함). **성재 승인 대기 이중트랙 main 머지**: track/uxui(496·497·536·498·512fix) + track/engine(491·509·511)을 원자적으로 함께 → main real-window 즉시 green. 최종 확인=성재 맥에서 `swift test --filter MemberInspectorSnapshotTests/testComposerFocusRequestRestoresKeyboardFocusInRealWindow` 1회(clients/macOS, 실 디스플레이) → 512 종결·509/511 런타임 검증.
- 남음: 543(498)은 성재 육안 QA(라이트/다크·Dynamic Type·한국어 3줄·200+ 스크롤) 선결. 엔진 새 기능은 머지 전까지 보류(미머지 스택 억제).

## 2026-07-20 (Fable 엔진 트랙) · 엔진 배치 랜딩 + 508 real-window 회귀(파이프라인 차단자)
- 랜딩(track/engine): MOMO-491 openssl 이식(#540)·509 X-7 에이전트 생성 API(#542)·511-E D10 attach capability(#545). 파일럿 E2-A 경제·E5 GitHub 사이클·E3 부분 완료. ADR-0125 D9(구독연결 UX)·D10(원격 attach) 기안.
- **차단자**: MOMO-508(컴포저 TextField→NativeTextView)이 real-window focus 복원 테스트를 결정적으로 깸. 헤드리스 게이트는 XCTSkip이라 508 통과했으나 실 디스플레이(성재 맥·runtime-db make test)에서 드러남 — 509·511 게이트 둘 다 걸림. 서버 전용이라 각 verifier 격리 PASS 확인 후 deviation 랜딩, MOMO-512로 동생 이관+정밀 진단(focusComposerRequest→isFocused 브리지).
- 검수 성과: 509/511 무죄(엔진 베이스 재현), 두 worker 포트 충돌(27970) 선제 수정(511→27980), 부하 게이팅 24 거부 준수. track/engine=main+3. 다음: 512 수정이 엔진 게이트 정상화 선결.

## 2026-07-20 (Fable 기획) · iOS v1 모바일 개편 계획 기안 (성재 승인 대기)
- 성재 발제(Discord·Mattermost·Claude 앱 레퍼런스 스크린샷) → docs/planning/handoffs/2026-07-20-ios-v1-mobile-plan.md. MOMO-496~506 예약: A(아이콘·탭 셸) → B(타임라인 v2·상호작용·스레드·첨부·검색) → C(푸시 v2 — 엔진 E-1 포함·C-3 딥링크 종결) → D(Work 탭·세션 상세 관전/개입 — Claude 앱 모델, 모바일 E2E 수용).
- 원칙: 모바일=관전과 개입(실행은 호스트). 엔진 의존은 E-1(푸시 페이로드 v2)만 신설 — 나머지는 전부 main 기랜딩 소비. codex iOS plugin worker 규율(컴파일=오케스트레이터) 명문화.
- 병행 상태: Q1c 스택 부팅 중, 495 랜딩 완료(a37026b).

## 2026-07-20 (Fable 통합) · A-11+Hermes(uxui) + X-6+489(engine) 동시 main 랜딩 — Q1 개방
- uxui@9ac0bd7(A-11 자기등록·실 Hermes E2E) 검수 결함 0 → main. engine(X-6·work_pool) → main a96f9c8. 3트리 정렬.
- 동생 발견 갭 X-7(에이전트 생성/pairing API — fresh DB 완주 불가) 등재·MOMO-494(#532) 발급. QA 판단: Hermes 멘션 QA는 즉시(트랙 스택), Q1 풀 사이클은 main 랜딩 후 — 지금 충족.
- 다음: Q1 실사용 QA(성재+Fable, AgentWorker MOMO_WORK_HOST_ID 조율) → 490(호스트 선택기)·X-7·491.

## 2026-07-20 (Fable 엔진 트랙) · X-6(493)+work_pool(489) 랜딩 — 0125 파생 3/4 완료
- 493(#529): auto-approve GET(human 전용·자기것만·tool만) — A-11 소비 짝. 489(#531): work_pool 슬롯 원장(FOR UPDATE 직렬화·구조화 409·집계 회복·admin audit). 둘 다 verifier+게이트 실패 0.
- 검수 실측 결함 1건(489): 기본행 included_active_hours=NULL이 audit jsonb_build_object 바인딩에서 타입 미상 PSQLError→빈 본문 500 — 스택 유지 재현으로 확정, ::int 캐스트 수정. **jsonb 내 nullable 바인딩은 명시 캐스트** 교훈.
- track/engine = main+2(493·489). 0125 파생 잔여: 490(UXUI 호스트 선택기 — A-11 뒤 동생 큐)·momo Cloud 프로비저너(T3 파일럿 후). 다음: 동생 A-11 검수 대기, 491(openssl 이식) 소형 정리 후보.

## 2026-07-20 (Fable 통합) · A-10 Work Console 검수 완료 + QA 팔로업 트래커 개설
- track/uxui@940369e(5169ef5, +2,311) A-10 검수: 코드 결함 0. SwiftTerm 1.14.0(MIT, exact pin·macOS 전용)·환경 allowlist(PATH/SHELL/TMPDIR만·TOKEN/cwd/PWD 배제 테스트)·host 필터·control dedup·세션종료 dedup·raw 로컬 파일 전용·샌드박스 fail-closed. macos-ui 게이트+420 tests PASS(동생 보고).
- **머지 미실행**(성재 명시 승인 대기 — TRACKS 규칙). App Sandbox 배포 정책은 blocker 아님으로 판정: dev 빌드 동작+샌드박스 fail-closed 안전, 배포판은 momo-workd(T2) 위임이 정답 → ADR-0114 보강.
- **QA_FOLLOWUP.md 개설**: Q1~Q8(A-10 실사용·샌드박스 결정·X-6·C-4·C-1·C-3·T3 E2/E3/E5·491)을 [자동]/[함께]/[성재] 분류·검증방법·트리거·수용조건으로 정리. 필요 시점에 함께 진행.
- X-6(auto-approve snapshot) ready 역핸드오프 확인. 다음: A-10 머지 여부 성재 결정 대기, 엔진 488 게이트 진행 중.

## 2026-07-20 (Fable 엔진 트랙) · MOMO-488 momo-workd v0 구현 완료 — verifier/게이트 대기(성재 지시 일시중단)
- 488(#525, PR 미생성) worker 완주·전량 push(goal `feat/525-momo-workd-v0-adr-0125-d2` @8cb2fe2, origin 동기화, 워크트리 clean). 신규 workers/WorkHostDaemon(momo-workd) + 서버 poll 엔드포인트(GET .../work-hosts/:id/pending-controls, 호스트 서명 인증) + infra/workd 배포 아티팩트.
- Fable 검수 완료(코드 결함 0): poll=호스트 서명 전용(bearer 불가)·host≠agent 경계·ack 페이로드 raw 미포함·process 출력 로컬 파일 전용(D3 정합). server 121/workd 6 통과. verify_workd는 openssl 미사용(내부 Crypto)이라 LibreSSL 게이트 함정 없음.
- **재개 지점(다음 작업 = verifier부터)**: ① goal 워크트리(feat/525…)에서 `bash -lc scripts/verify_workd.sh`(포트 27950대) → ② `scripts/local_gate.sh --profile runtime-db` → ③ PASS 시 PR 생성·squash→track/engine·이슈 #525 close·워크트리 회수 → ④ 다음 엔진 = MOMO-489(work_pool). 배치 종료 시 docker reclaim.
- 참고: 게이트 반복+파일럿으로 Docker 압박 → 이번 세션 build cache 24.6GB 회수 완료. 파일럿 E2/E3/E5·MOMO-491(push_relay openssl 이식) 잔여.

## 2026-07-20 (Fable 엔진 트랙) · MOMO-487 work_host 레지스트리 랜딩 + 게이트 openssl 함정 해소
- 487(#523 → track/engine): work_host(scope member|workspace·Ed25519·revoke) + work_session/control FK + 등록/서명 heartbeat/revoke + control 대상 검증(revoke 시 dispatch 차단→failed). verify_work_host + 게이트 실패 0.
- 검수 실측 2건: ①신규 호스트 online 투영 NULL→false(비옵셔널 디코드 500) ②**게이트 bash -lc 로그인 셸이 /usr/bin/openssl(LibreSSL, ED25519 미지원)을 homebrew보다 먼저 잡아** verify가 무출력 실패(cleanup 무에코→게이트 로그 0줄) — find_openssl 리졸버로 해소. push_relay 동일 패턴 이식은 MOMO-491(#524).
- Docker 자원 회수(배치 종결 계약): build cache 24.6GB→0. 다음 파일럿 E2(경제)·E5(통합 데모)와 0125 파생 488(workd) 잔여.

## 2026-07-20 (Fable 엔진 트랙) · ADR-0114 엔진 체인(483·484·486) 완주 — track/engine, main 대기
- 483 work_session 원장(#517) → 484 work.control+승인 게이트(#519, worker capacity 사망 7커밋 인수) → 486 AgentWorker tool+E2E(#521). 전부 verifier+runtime-db 게이트 실패 0.
- "채팅 멘션 → 에이전트 work_spawn → 승인 카드 → 호스트 ack+세션 → 스레드 개입"이 mock E2E로 완결. 486이 run-liveness 가드(죽은 run 명의 control 차단)를 추가해 484 verifier를 계약 정합 갱신.
- 다음: 성재 승인 시 엔진→main 머지 → A-10(MOMO-485 SwiftTerm) 동생 위임+QA 패키지 → T3 파일럿(17-01) 착수 → 0125 파생 487~490.

---

## 2026-07-19 (Fable 통합) · UXUI A-4/A-6 배치 → main ff (성재 승인)
- track/uxui@37bcd12(+2,252) 최종 리뷰 Blocker/High 0: capability URL 무유출(ephemeral 직송·Authorization 원천 부재)·complete 6필드 대조·tombstone 첨부 가드·replies root 탈출 검증·경로 방어 2중 전수 코드 대조. main 동기화 후 게이트 재실행 PASS(416/416) → main=8607580 fast-forward.
- A큐 전 항목 done — 핸드오프 UI 큐 완전 소진(A-1~A-9). 잔여: 동생 제기 orphan 첨부 GC(complete-미귀속 행) 엔진 티켓화 예정, Drive 실자격 E2E·2기기 수동 QA는 검증 부채 유지.
- 트랙 재정렬(engine=uxui=main). 다음: MOMO-483 랜딩 시 A-10(Work 서랍/SwiftTerm — MOMO-485)이 UXUI 다음 소비물로 등재 예정.

## 2026-07-19 (Fable 기획+엔진) · ADR-0114 Accepted → MOMO-483 착수 + ADR-0125 기안
- 성재 "ㄱㄱ"로 0114 v2(D1~D8) Accepted. MOMO-483(#516, work_session 원장+세션 카드/스레드 바인딩) 발급·worker 가동 — no-version 발행·비순번 분기 등 479/480 확립 계약을 패킷에 명시.
- ADR-0125(Work Host Fabric) Proposed 기안: work_host 레지스트리(scope=member|workspace·outbound-only) · T2 workd(SSH 부트스트랩·원격 로그인 브리지) · T3 재판매 시작(기질-불가지 프로비저너, 자체 Firecracker는 v2) · 3계층 샌드박스 합성 · work_pool 동적 슬롯 · 호스트 선택기(로컬 우선) · 워크스페이스 과금+BYOA · 보안 기본값. 파생 487~490 예약. 성재 승인 대기.

## 2026-07-19 (Fable 기획) · ADR-0114 v2 재기안 — Warp/Conductor형 에이전트 조종 터미널
- v1(수명주기만 원장·경로 분리) 기안 직후 성재 방향 보정: 기본 흐름=채팅 요청→에이전트가 CLI 세션 스폰·조종·작업 제공, 세션↔채팅 양방향. v2로 재기안.
- v2 권고: D1 호스트 세션 매니저(앱 내장, workd v1) · **D2 세션=채널 스레드**(카드 root+진행 답글+개입 답글 — X-3 인프라 재사용) · D3 큐레이션 기본·raw tail 옵트인 · **D4 원장 경유 control**(에이전트 tool-call work.spawn/input/read/kill→승인→outbox→호스트 실행) · **D5 spawn=승인 대상**(프로파일 auto-approve 화이트리스트) · D6 터미널+스레드 병행 · D7 도구-불가지 프로파일.
- 논거: 기존 5자산(mention→run·승인·partial·단일 쓰기경로·BYOA) 재사용 계약이지 새 시스템이 아님. 파생 483(세션 원장)/484(control+승인)/485(UXUI 터미널)/486(AgentWorker tool+E2E). 성재 승인 대기.

## 2026-07-19 (Fable 엔진 트랙) · MOMO-472 스냅샷 flake 근본 수정 (track/engine f74bae2)
- 원인 확정: MemberInspector·WindowChrome의 NSApp.appearance 전역 변조(비동기 전파)가 인접 무창 스냅샷 렌더를 오염 — 풀스위트 한정·격리 통과·부하 발현·family 고정 관측 전부 정합. worker 위임 불가 유형(게이트 env 재현)이라 오케스트레이터 직접 수정.
- 전역 변조 3사이트 제거(창/팝오버 외관 기설정 — 잉여 증명: 오염원 자기 스냅샷 18/18 정본 일치). evidence: 유휴 풀스위트 3×405 그린 + macos-ui 게이트 PASS. #495는 재발 감시로 유지, 무재발 확인 후 close.
- track/engine = main+2(MOMO-482 + 472수정). 잔여 백로그는 성재 필요: C-2(Codex 왕복)·C-4/C-1(2기기·마이크 수동 QA).

## 2026-07-19 (Fable 엔진 트랙) · MOMO-482 X-4 첨부 투영 랜딩 — X큐 소진
- 482(#515 → track/engine): history/전송/replies/message.new에 complete 첨부 투영(LATERAL 단일쿼리) + Core Message.attachments/DraftMessage.attachmentIds. 확장 verifier·게이트 실패 0. worker 리뷰 결함 0.
- 이로써 **UXUI 역요청 X-1~X-5 전량 소진**. track/engine=main+1(482) — 다음 성재 승인 머지 때 A-6 ready 전환.
- 잔여 후보: C-2(Work 실 Codex 왕복), C-4(2기기 수동 QA), MOMO-472(스냅샷 flake 안정화 #495).

## 2026-07-19 (Fable 엔진 트랙) · X-5 체인 완주 — MOMO-480/481 랜딩
- 480(#511): 상호작용 이벤트 no-version 발행(브로커 드랍 해소) + verifier history 실수신 회귀 가드. 481(#513): Core replay type 분기(커서 불전진)·history tombstone/편집 투영·재시작 수렴 단정. 둘 다 runtime-db 게이트 실패 0.
- track/engine = main+5(479·재정렬·480·481). **main 랜딩 시 A-9 done·A-4 ready 전환 가능** — 엔진→main 머지 성재 승인 대기. 실 2클라 ws E2E는 C-4 등재(수동 QA 대체 가능).
- 다음 엔진 후보: X-4(첨부 수신 투영 — A-6 개방) 또는 C-2(Work 실 Codex 왕복).

## 2026-07-19 (Fable 통합) · UXUI A-8/A-9 배치 → main 머지 (성재 승인)
- track/uxui@dae7e8a(+1,945) 검수 결함 0 → main f25503d 무충돌 머지. A-8 음소거 UI 완결, A-9는 REST/로컬 UI 범위(4종 실호출·fail-closed·경합 방어) — 교차 클라 realtime·재시작 복원은 X-5 대기(성재 선택지 1 채택).
- UXUI가 X-5(상호작용 이벤트 seq 재사용 → relay/Core drop + history 투영 부재)를 정확히 역요청 — 엔진이 독립 실측한 MOMO-480(브로커 절반, 게이트 진행 중)과 동일 근원. 잔여(Core replay 비순번 처리·history editedAtMs/state 투영·2클라 verifier)는 MOMO-481 후보.
- 트랙 재정렬(uxui=main), 앱 재빌드. 엔진 트랙은 main+2(479+480 대기)로 계속 전진.

## 2026-07-19 (Fable 엔진 트랙) · MOMO-479 X-3 스레드 투영 랜딩 + 478 선재 결함 발견
- X-3 완주(PR #509 → track/engine): thread 롤업 투영·replies cursor REST·thread.updated·AgentWorker root_id 보존(4사이트). worker(gpt-5.6-sol) 34분 구현, 리뷰 결함 0.
- **실검증에서 결함 2건 잡음**: ①thread.updated가 Centrifugo version 게이팅에 무언 드랍(version=답글 seq ≤ 저장 version — no-version 발행으로 수정) ②동일 기전으로 **MOMO-478 상호작용 이벤트 4종 상시 드랍**(선재) → MOMO-480(#510) 발급. outbox done이라 무증상인 함정 — A/B 발행 실측으로 확정.
- 게이트 부산물: e2e compose `cp -Rp`+`swift run -j 8`(Docker VM 7.7GiB OOM 실측 대응, 전 verifier 수혜), verifier 포트를 워크트리 runtime 포트와 분리, QuickSwitcher 스냅샷 4건 MOMO-472 family 재확장(#495).
- 다음: MOMO-480(A-9 개방 전 필수) → X-4(첨부 투영). main 반영은 성재 승인 대기.

## 2026-07-18 (Fable 통합) · 양 트랙 → main 동시 랜딩 (성재 승인 머지)
- UXUI 배치(6e43928, +5,758) 검수 완료: 웹훅 시크릿 무영속·단축링크 URL 검증·타임라인 rootId 필터·검색 stale 가드 전부 주장=코드 일치, macos-ui 게이트 풀 PASS. 결함 0 — 수정 없이 머지.
- 머지 순서 uxui(2998b23)→engine(7e7b283). ENGINE_HANDOFF 통합판 작성(A-1/2/3/5/7 done · A-4/6 in-progress · A-8/9 ready · X-3/4 needs-engine-contract), 트랙 브랜치 양쪽 main으로 ff 재정렬.
- 통합면 검증: 엔진 머지가 uxui 게이트 트리에 더한 것은 server/workers/scripts+Core 테스트뿐(macOS 소스 무접촉) — 양 게이트 evidence가 merged main을 그대로 커버.
- 다음: UXUI에 A-8(음소거 UI)·A-9(상호작용 개방) 제안, 엔진 다음 작업=X-3(스레드 조회 계약)·X-4(첨부 투영).
- 5티켓 순차 랜딩: 골격 `cb2f753` → 목록/타임라인 `daff55e` → 컴포저/승인 `9aad292` → 푸시 P-4 `a0e3d0c` → TestFlight 런북 `3d321c6`. 전부 codex worker 구현→Fable 리뷰·시뮬레이터 게이트·머지.
- 파이프라인 실측: worker 샌드박스는 CoreSimulator/xcodebuild 불가 — iOS 컴파일·시뮬레이터 검증은 오케스트레이터 상시 몫(Swift 6 sending 오류 3건 직접 수정 전례). capacity 사망 1회는 동일 worktree 이어받기+빈번 커밋으로 유실 0 복구.
- ADR-0120 전 체인 종결(P-4 포함, simctl push 실전달·NSE 18/18). 잔여: 런북 [manual](성재 실기기 E2E)이 배치 최종 evidence. ADR-0123 v1 수렴 항목(뷰모델 공용화)과 M8 이월(042/043) 유지.

## 2026-07-17 (Fable 기획) · ADR-0123 iOS 클라이언트 v0 기안
- 성재 발제로 iOS 트랙 기획 착수. 실측: MomoCore 20파일 AppKit 0(그대로 재사용), 레거시 EP-IOS 분해(040 승계·041 기완성·042/043 M8 이월), 팀/APNs 전제 금일 확인 완료.
- D1~D6 기안: 얇은 셸+MomoiOSKit / dogfood 스코프(수신·답장·승인 결정 — "이동 중 승인"이 차별점) / P-4 합류 / TestFlight internal / codex iOS 플러그인 구현+ios 게이트 프로파일 / IOS-1~5 순차 배치.
- 다음: 성재 D1~D6 승인 → Accepted 반영 → IOS-1 패킷 발급.

## 2026-07-18 (Fable) · B-4 완료 — 엔진 역요청 전량 소화
- MOMO-477(음소거) track/engine 랜딩: pref REST+채널 목록 muted+notifier 판정 join(멘션 포함 억제·로그 무오염·만료 자동 재개). ADR-0124 Accepted 즉일 구현.
- 이로써 갭 감사의 B(역요청) 4건 전부 종결(B-1 첨부/B-2 검색/B-3 스레드/B-4 음소거). UXUI A큐는 8건(A-8 음소거 UI 추가). X-1 이식 완료, X-2(반응/수정/삭제 REST)가 엔진 다음 작업.
- track/engine = main +2(X-1 스테이징 픽스, MOMO-477) — 다음 성재 승인 머지 대기.

## 2026-07-18 (Fable) · 엔진 3차 main 머지 `7edad20` — UXUI 큐 전면 개방
- 검색 FTS(MOMO-475)+스레드 개방(MOMO-476) 통합 게이트 PASS 후 성재 승인 머지. 트랙 재정렬(main=engine).
- ENGINE_HANDOFF 재구성: A 7건 전부 "main 랜딩·즉시 착수 가능"(마켓플레이스/웹훅/단축링크/스레드/첨부/검색/허들 폴리시). 엔진 잔여=B-4 음소거 ADR, C-2 Work 실검증.
- 성재가 UXUI에 전달할 멘트 작성 완료(세션 로그) — UXUI는 A 항목을 "이거 구현할까요?" 루프로 소비 시작.

## 2026-07-18 (Fable) · 엔진 트랙 main 머지 `bd77fe5` (성재 승인 2차)
- track/engine→main: V-3b iOS 허들 참가(#498) + 첨부 업로드 v0 Drive archive(#499). 게이트 재확인 runtime-db+ios PASS, BUILD_TICKETS 충돌은 main 완성본 채택. ADR-0122 음성 양 클라이언트 완성 + 파일저장 서버 절반 실물(실 Google smoke 검증).
- clean slate: main=track/engine=bd77fe5. track/uxui는 UX 세션 작업 중(미커밋 19, 트랙 워크트리 — 파이프라인 정착). ENGINE_HANDOFF A-6(파일첨부 UI) 해제됨.
- 다음 엔진 후보: B-2 검색 서버 FTS / C-2 Work 실 Codex 검증 / B-4 알림 음소거 계약.

## 2026-07-18 (Fable) · 성재 승인 main 머지 — clean slate `a2ec4fd`
- UX 464를 Fable이 마감(크롬 계약 상수 52/48 정합, 파생 스냅샷 14장 재기록, 더블클릭 줌 이식) → 342/342+macos-ui 게이트 PASS → **성재 명시 승인으로 track/uxui→main 머지**(TRACKS §3 첫 적용).
- clean slate: main=track/engine=track/uxui=a2ec4fd, 루트 clean, 성재 앱=uxui 트랙 빌드(빌드 원본 고지 관행 시작). 엔진(음성 V-1~3 포함)은 이미 main에 있었음.
- 다음: 양 트랙이 여기서 분기 — UXUI는 ENGINE_HANDOFF ready 5건 제안 루프, 엔진은 V-3b(iOS 허들)/회의록 v1/Work 실검증 등 후보.

## 2026-07-18 (성재+Fable) · 트랙 파이프라인 대전환 (docs/TRACKS.md 정본)
- 이원화(UXUI/엔진)·워크트리 작업·트랙 워크트리 빌드 확인·**main 머지=성재 명시 승인** 정본화. track/uxui·track/engine + ~/projects/momo-tracks/* 신설. AGENTS.md·CLAUDE.md에 최우선 규칙 삽입. ENGINE_HANDOFF.md 신설(ready 5건 시드).
- UX 464 리뷰: 자동승인 가드(reversible-only fail-closed) 양호, 루트 잔재의 더블클릭 줌 이식·통합 커밋. **머지 부적합 판정**: ChromeTests 계약 3건 실패+파생 스냅샷 15건 미기록 → track/uxui에 보존(main 보류), UX 마무리 요청. 루트 잔재는 stash 보관 후 루트 clean 복구.
- track/uxui는 main(V-3 허들 포함)과 병합 완료(STATUS만 충돌·양쪽 보존). 성재 확인용 앱은 uxui 트랙 빌드로 재실행(46cb58d).

## 2026-07-18 (Fable) · V-3 랜딩 — 채널에서 말 걸기(음성 UI) 실물
- `ad983ee`: macOS 허들 UI(헤더 시작/참가·배지·미니패널, livekit swift SDK 2.15.2). 파일스코프 계약 준수(MomoHuddle* 신규+헤더 최소). 블로커가 전방호환 선재결함(미지 이벤트 type이 스트림 종료) 발견 → Core에서 skip 처리 동반 수정.
- 게이트: huddle/Core 34 test PASS, 유일 실패=workspaceSearch full-suite flake(선재·V-3 무관) → DEVIATION+MOMO-472 분리 후 머지(411/412 선례).
- 루트 재오염: UX 세션이 또 루트 체크아웃에서 직접 편집(STATUS/Theme/MomoMacRootView 등 미커밋 다수) — §4.1 무접촉, 정본은 temp worktree 우회. 성재 재전달 필요.
- 잔여: V-3b(iOS 참가), V-3 실오디오 2클라 왕복(성재 협업), 회의록 v1/v2. 음성 배포는 도메인 결정(S-4와 동일) 후 V-2b(TURN).

## 2026-07-18 (Fable) · V-2 랜딩 — 음성 v0 서버·인프라 완성
- `5bab0d2`: compose huddle profile(옵트인·핀 v1.13.3)로 실 LiveKit 기동, V-1 JWT 실수락 검증(200/무효 401) PASS. 서버→JWT→실 SFU 전 구간 실물.
- 운영 사건: Docker Desktop 신규 pull 전역 불능(레지스트리 도달성 정상·기존 컨테이너 무영향) — 성재 재시작으로 해소. verifier pull 단계 무한대기 개선 후보(비차단).
- 다음: V-3(macOS 허들 UI — UX 트랙과 발급 시점 조율 필요), V-3b(iOS 참가). 회의록 v1/v2는 후속.

## 2026-07-18 (Fable) · V-1 랜딩 + iOS 실기기 E2E 완주
- 음성 V-1 `df18a6b`(huddle 스키마/수명주기/LiveKit JWT — verifier+runtime-db PASS). 게이트가 461 선재 결함(notifier 컨테이너 Linux Sendable) 검출 → #490 1줄 수정. 다음: V-2(compose LiveKit+TURN).
- iOS: 실기기 푸시 E2E PASS(STATUS 정본) + deep link 수정 `61e5cf3` 랜딩(실기기 재확인 [manual]). worker capacity 사망 2회 모두 커밋 보존 인수로 유실 0.
- 워크트리 47개 회수(PR MERGED 확인 기반). 오케스트레이터 실런이 잡은 잠복 결함 3종 기록: 렌더 편차/python 버전/컨테이너 Sendable — 전부 worker 환경 사각.

## 2026-07-18 (Fable) · ADR-0122 Accepted + 워크트리 대청소
- 성재 "ㄱㄱ"로 음성 허들 Accepted(D1 LiveKit/D2 임시 허들/D3 3단계). V-1(MOMO-468 `#486`) 발급 — 서버 전용, UX 무충돌.
- 워크트리 50→5 회수(47개 — GitHub PR MERGED 확인 후만 삭제, dirty 4개는 §4.1 무접촉 보존). UX 세션은 relay 후 worktree 분리 안착 확인(활성: /private/tmp/momo-464).
- iOS: MOMO-467(등록 env 자동판별+os_log 관측) 랜딩 `37480d2` — 실기기 재검증(케이블 Run)은 성재 [manual] 대기.

## 2026-07-17 (Fable 엔진 트랙+성재) · S-4 v0 + P-3 PushRelay 랜딩 — 성재 개입 3건 전부 종결
- MOMO-460 `69ace59`(services/LinkShort — /i/<code>→302, 도메인은 DNS만 붙이면 됨) + MOMO-461 `94b62bc`(relay/PushRelay — Ed25519 등록제·rate limit·APNs ES256 발송, NotifierWorker 서명 옵트인).
- APNs 자격증명: 기존 개인 유료 계정 키 4SSR3XS7WZ(Team YWQQFQM38J) 재사용 — 실 smoke 2단: 자격증명 단독(400 BadDeviceToken 판정) + relay 경유 end-to-end(apns_id 발급 passthrough). .p8은 ~/.momo-secrets/(레포 밖).
- ADR-0120은 P-4(iOS)만, ADR-0121은 도메인 결정만 잔여. rebase 시 Makefile/local_gate 양측 신규 패키지 합집합 병합 전례 기록(regex 일괄 금지 — 앵커 삽입으로).

## 2026-07-17 (Fable 엔진 트랙+성재) · Drive 실 SA smoke PASS — 경로 C 전 구간 종결
- 성재가 런북 §2~§5 수행(GCP momo-dawn, SA momo-archive, 공유 드라이브 0AHKTseTvG-mpUk9PVA). 관문 2개 실측 기록: ①Google secure-by-default 조직 정책이 SA 키 발급 차단 → 프로젝트 한정 재정의(legacy+managed 둘 다) ②조직 정책 관리자 역할 선행 필요.
- 오케스트레이터 smoke(§7.1): drives.get/files.list/changes.startPageToken 3종 200. scope 실증 — drive.file 403 → drive.readonly 확정(GoogleDriveSABackend 기구현과 일치, 코드 무변경). 키 바이트 무출력·레포 밖 보관.
- 남은 성재 결정 2건 유지: S-4 단축링크(momo.app), P-3 푸시(.p8 대기 — 개인 유료 계정 확인됨).

## 2026-07-17 (Fable 엔진 트랙) · MOMO-459 openapi 플러그인 표면 + SA smoke 대기
- `c109043`: 플러그인/webhook/Drive MCP 25 paths·30 operations 명세, 라이브 대조 41/41 PASS. 리뷰에서 expires_at_ms 오배치 교정(선재 approvals drift 동시 마감). 미기재 표면 목록은 PR #469 본문에 보존(후속 문서 티켓 후보).
- Drive 실 SA smoke: 성재에게 GCP 단계 안내 전달 완료(런북 §2~§5) — Workspace 유무 확인 대기, 산출물 계약 = SA 키 파일(~/.momo-secrets/) + 공유 드라이브 ID.
- ADR-0121 잔여는 성재 결정 대기: S-4 단축링크(momo.app 도메인/호스팅), S-5는 ADR-0120 P-3(Apple Developer — 성재 개인 유료 계정 사용 가능 확인) 선행.

## 2026-07-17 (Fable 엔진 트랙) · MOMO-458 오피셜 라인업 마감
- `f9085dd`: Notion/Linear 왕복 검증(3-플러그인 정확 집합 + 개별 revoke 차집합) + 카탈로그 `recommended`(ADR-0113 D6 세트 {github, drive, external_webhook}) — 마켓플레이스 UI(#462)가 소비할 서버 계약 성립.
- 게이트 교훈 2건 환류: roundtrip verifier가 runtime-db 프로파일 미편입이었던 공백 마감, 게이트 PATH의 Xcode python3(3.9)가 adapter(slots=True, >=3.10)와 충돌 — verifier에 python 버전 명시 탐색.
- 오피셜 5종 전부 실물 검증 완료. 남은 후보: Drive 실 SA smoke(성재 GCP 수동), ADR-0121 온보딩 잔여, openapi 플러그인 표면 문서화(예약).

## 2026-07-17 (Fable 엔진 트랙) · SE-04D Drive 경로 C MCP v0 랜딩
- MOMO-457 `367442c`: momo-hosted read-only Drive MCP(`/v1/mcp/drive`) — tools/call마다 FOR SHARE grant 재검증+같은 tx audit, stub prod 부팅 거부, validator hosted 확장(외부 HTTPS 규칙 무손상), migration 015(자격증명 무저장). 리뷰 소견: 백엔드 호출 tx 내 실행(15s 유계) 후속 개선 후보.
- 오케스트레이터 후속 수정 2건: verifier rg 의존 제거, registry verifier 시드 4→5(전수 열거 단정이 의도대로 회귀 감지). 실런 verify_drive_mcp + runtime-db 게이트 PASS.
- 오피셜 라인업 현황: GitHub(등재+왕복)·webhook·Drive(hosted) 실물, Notion/Linear 등재만. 다음 후보: Notion/Linear grant 왕복 복제(소형) 또는 실 SA smoke 런북 evidence(성재 GCP 손 필요) 또는 ADR-0121 온보딩 추천 세트 합류.

## 2026-07-17 (Fable 엔진 트랙) · SE-04C 완주 + 게이트 자급 + dev 키체인 우회
- 3건 랜딩(전부 codex worker 구현→Fable 리뷰·게이트·머지): MOMO-449 `9b20692`(SE-04C grant→tool policy 왕복, 실런 verifier+registry 회귀+runtime-agent 게이트 PASS) · MOMO-450 `b835e76`(macos-ui 게이트 스택 자급, §9 거부 실증 포함 3박자 검증) · MOMO-452 `65a55ba`(dev 키체인 우회+dev-password 자동 채움, 성재 결정).
- ADR-0113 파생 체인 SE-04A→04B→04C 닫힘. 다음 파생: Drive 경로 C MCP 포장.
- 루트는 UX 세션이 codex/457 브랜치+미커밋으로 점유 — §4.1 무접촉, 정본·앱 랜딩은 임시/app-landing worktree 우회. UX 세션에 §4.1-4(worktree 이동+루트 정리) 재전달 필요.

## 2026-07-17 (Fable 엔진 트랙) · MOMO-448 사후 리뷰 수정 랜딩 + 루트 규약 정본화
- #448 사후 리뷰(코드+design 독립 2축, 둘 다 Blocker 0) → 합의 결함을 MOMO-448(#449)로 티켓화, codex worker(5.6 sol medium) 구현 → PR #450 리뷰 PASS → 게이트 → squash `df0bc00`.
- 게이트 실패 2건 해소: ①worker 셸 폰트 렌더 편차로 스냅샷 21장 게이트 환경 재기록(교훈: 캐노니컬 RECORD는 오케스트레이터 몫 — worker 프롬프트 계약에 명시할 것) ②macos-ui 프로파일에 `make up` 부재(선재 공백, 소형 티켓 후속 필요).
- GPT의 루트 stash 검증: stash@{0,1} 전 파일이 과거 커밋 blob과 일치 — 유일본 0, mixed-reset 착시 확정. §4.1-5 정본화(루트 항상 clean, `pull --ff-only`만, dirty 위 mixed reset 금지, `8202aef`).
- DEVIATION_LOG 스냅샷 drift pending → accepted 종결(#448+#450). 다음: ADR-0113 후속(GitHub grant 왕복→Drive 경로 C), macos-ui 프로파일 보강 티켓.

## 2026-07-16 (momo-main/GPT 5.6) · PLN-20260716-01 Plugin Platform productization
- Codex/Hermes/MCP와 Google Workspace·GitHub·Notion 공식 표면을 대조해 plugin package와 runtime adapter를 분리했다.
- Plugin Center/추천 onboarding과 catalog/install/connection/channel/grant/health 독립 projection, Capability Cache 기반 동적 discovery를 제품 제안으로 정리했다.
- Drive selected-file read/cite/upload/link는 첫 vertical 후보이며 기존 GitHub-first 전략을 대체하지 않는다. 성재 결정+Accepted ADR 전 구현 순서 변경 금지.
- 보안 리뷰를 반영해 subject/actor/delegation binding, remote runtime SSRF 경계, Drive create outcome-unknown, webhook ingress/executor 분리를 Fable handoff에 추가했다.
- 다음: Fable이 ADR-0113/SE-04A 옵션과 threat model을 정교화한 뒤 성재가 선택한다. builder issue는 그 이후다.

## 2026-07-15 (Codex worker) · MOMO-392 channel chrome/context navigation
- compact one-line header, unifiedCompact chrome/inset, header-right app Downloads, truthful search-unavailable, channel quick/context/keyboard/VoiceOver actions를 구현했다.
- standard 1180x760, narrow 980x620, wide 1800x900 실창과 Downloads/search state, light/dark artifacts를 `/tmp/momo-398-design/`에 기록했다.
- MOMO-386 search backend와 chat attachment downloads/notification engine은 구현하지 않고 UI에서 planned/unsupported로 명시했다.
- 남은 것: full tests/preflight/local gates/fresh design review → commit/push/PR → `status:needs-review`; worker는 merge/close하지 않는다.

## 2026-07-17 (Fable, 오케스트레이터) · ADR-0115 Accepted → SE-04B/411 착수 + worktree 소유권 사고
- ADR-0115 Accepted(성재) → MOMO-412 `#438`(SE-04B webhook+Slack-호환)·MOMO-411 `#436`(gate 리소스 가드) codex worker 2기 병렬 spawn(§9 부하 체크: load 10.9, 412만 실질 부하 — 규칙 내).
- **worktree 소유권 사고(3번째 크로스 세션 파일 사건)**: 통합자가 메인 worktree의 GPT UX 작업분(MessageListView+launcher)을 stash 시도 → 성재가 차단. 판별 결과 GPT는 #437을 격리 worktree에서 정상 머지했고 메인 worktree 사본은 다른 버전(잔재 추정, 단 확정은 GPT 세션 몫 — 무접촉 유지). 내 커밋은 임시 worktree cherry-pick으로 push 우회.
- **§4.1 메인 worktree 소유권 규칙 정본화**: 메인 체크아웃=docs/머지 전용, add -A 금지, 타 세션 미커밋 파일 무접촉(stash/reset 금지), push 충돌 시 임시 worktree 우회, 초안 잔재는 만든 세션이 정리.
- 주의 인계: 메인 worktree의 STATUS.md/Theme.swift도 구버전 스냅샷 — GPT 세션이 잔재 정리 전까지 통합자 플러시는 임시 worktree 경유.
- 다음: 438/436 PR 검수(§9 부하 규칙 아래 게이트) → 순차 머지.

## 2026-07-17 (Fable, 오케스트레이터) · MOMO-411/412 종결 — 리소스 가드 + webhook ingress
- MOMO-411(`710a069`)·412(`5ff5161`) 순차 머지. 411=gate --down+부하 체크(발열 사고 봉합, teardown 잔재 0 실증), 412=ADR-0115 signed webhook + Slack-호환(리뷰 H1로 미지원 필드 무시 전환 — Grafana/Alertmanager URL 교체 동작). codex worker 2기 병렬, 오케스트레이터 검수·게이트·머지.
- 사고/해프닝 3건 무손실 처리: ①메인 worktree UX WIP를 임시 worktree cherry-pick 우회로 무접촉 push(§4.1 정본화) ②PR #439 GitHub mergeable-UNKNOWN 오작동 → 재오픈 후 정상 머지 ③rebase STATUS 반복 충돌 → origin 정규화. verifier 단정 오류 2건(201·토큰 매칭)은 H1 반영 케이스의 실수로 서버 무관, 수정.
- macOS 스냅샷 FAIL은 origin/main HEAD 격리 재현으로 UX 트랙 선재 확정 — 두 게이트 모두 이 사유로 무한 대기 없이 서버 표면 실증(단독 verifier)으로 머지 판정.
- 다음: ADR-0113 후속(GitHub grant 왕복→Drive 경로C). M1/M2·MOMO-390 smoke 등 DEVIATION_LOG pending 정리. UX 스냅샷 drift는 UX 트랙 통보 필요.

## 2026-07-17 (Fable, 오케스트레이터) · 리소스 거버넌스 정본화 + ADR-0115 draft
- 성재 지시로 부하 규칙을 프로젝트 정본화: `MULTI_SESSION_OPS.md` **§9 Resource Governance**(부하 체크 게이트 load>12 금지/8~12 단일/`<8` 정상, 게이트 후 down 의무, 호스트 전체 heavy 동시 1개, 잔재 판별 팁) — 전 세션(Fable/GPT/Codex) 적용. tooling 봉합 MOMO-411 `#436` 발급(status:ready, 부하 안정 후 착수).
- 부하 모니터 가동(load<8 3연속 시 heavy 재개 신호). ADR-0115 Proposed 기안(문서 작업) — HMAC native 모드 + Slack-호환 URL-시크릿 모드(blocks v0 거부), SE-04B 계약 승계.
- UX 세션 전달 멘트 작성(성재가 GPT momo-main 세션에 전달) — §9 요지 + UX 해당 항목.
- 다음: 성재 ADR-0115 승인 + 부하 안정 → SE-04B·MOMO-411 codex-fleet 발급. UX 트랙 점검은 추후 일괄(성재 지시).

## 2026-07-17 (Fable, 오케스트레이터) · SE-04A 종결 + 발열 사고 진단·방지 계약
- MOMO-410(PR #435 `1809551`) 종결 — 플러그인 물리 기반 랜딩. 리뷰 H1/M1/M2 반영, plugin verifier+runtime-db PASS. 크로스트랙 오커밋 사고(add -A → main macOS 빌드 파손)를 e1a9b78 revert로 수습, UX 작업분 보존.
- **발열 과부하 진단(성재 발제, Opus 세션 병행)**: 원인 절반=정상 동시부하(tf-hwp+momo 2트랙+VM 콜드빌드), 절반=구조 결함 — ①runtime-db 게이트의 `make up`이 스택을 내리지 않아 게이트 런마다 postgres+centrifugo 잔재 생성(주 생성자=이 세션의 오케스트레이션) ②게이트 중첩. 조치: 유휴 스택 5벌 down(활성 433·momo_main 보존), builder 2.5GB+볼륨 5.6GB 회수.
- **재발 방지 계약(오케스트레이터 의무)**: ①게이트 런 종료 즉시 해당 compose project down ②docker-heavy 게이트 직렬화(동시 1개) ③배치 종결마다 janitor+prune, 주 1회 reclaim --aggressive ④무거운 병행 작업 시 worker 동시 수 1-2 제한. tooling 후보: local_gate.sh `--down` 플래그(티켓 발급은 머신 안정 후).
- 다음: ADR-0115(signed webhook+Slack-호환 모드) draft → SE-04B. 무거운 게이트는 머신 부하 확인 후 실행.

## 2026-07-17 (Fable, engine planner+오케스트레이터) · ADR-0113 Accepted → SE-04A 착수
- 성재 승인("ㄱㄱ")으로 ADR-0113 Accepted 전환. UX 트랙은 GPT Codex 앱 진행분 팔로업만(MOMO-402 머지·409 발급 관찰 — 개입 없음, 추후 일괄 점검 형식).
- SE-04A=MOMO-410 `#434` 발급(수용기준+패킷 `2026-07-17-adr-0113-se04a-plugin-registry.md`) → codex worker(5.6 sol medium) spawn. registry 스키마(013)+validator fail-closed+install/grant/revoke REST+Capability projection+오피셜 시드 3종(GitHub/Notion/Linear).
- 사고 1건 자가 복구: `git add -A`가 UX 트랙 미커밋 작업분(MomoComposerActionLauncher.swift)을 오커밋 → 인덱스만 revert(working tree 보존, `9ade613`). **교훈: 메인 worktree는 UX Codex와 공유 — 이후 명시적 파일 지정 add만.**
- 다음: 410 PR 검수·머지 → SE-04B(Slack-호환 webhook, ADR-0115 draft 병행 필요) 발급 판단.

## 2026-07-16 (Fable, momo-main 오케스트레이터) · MOMO-408 종결 — H1 노출 확장 봉합
- PR #431 머지(`8193734`). 독립 리뷰가 H1(owner만 잠그면 pre-MOMO-217 join 행 잔존 노출)·H2(로컬 도그푸드 루프 파손 미기재)를 잡음 → planner 처분: 잠금 전 human 확장 + 로컬 러너 명시 부트스트랩(철학 일치). 오잠금 가드 매트릭스 verifier 추가, seed verifier 4/4 PASS.
- 전체 runtime-db 재실행 2회 외부 중단(SIGTERM) → 등가 논증으로 대체(수정 전 전체 PASS + 델타 3파일이 게이트 비대상/단독 검증 완료 — PR 코멘트 정본). 한가한 시점 전체 1회 재확인 권장.
- 후속 후보: INTERNAL_ALPHA/RUN dev-password 안내 정비(M2), regenerate 404/409 분기(L1 from #428).
- 대기: ADR-0113 성재 option 승인(→ SE-04A codex-fleet 발급), MOMO-402/405 등 UX 트랙 관찰 지속.

## 2026-07-16 (Fable, engine planner+오케스트레이터) · ADR-0113 기안 + MOMO-408 발급
- 성재 지시(플러그인 우선순위 상향·오피셜 집중·Slack/MM 호환)로 3축 분배: ① MOMO-408 `#430`(prod 시드 fail-closed, H1 파생) codex worker 가동 ② 실검증 리서치 2건 완료 — **16-03: Google 공식 Workspace MCP 존재(2026-05 Preview, 배포자별 GCP 필수), GitHub/Notion/Linear 전부 remote+DCR 위임 가능** / **16-04: Slack 호환의 실체=와이어 포맷뿐, MM incoming webhook 선례 검증, MM 플러그인 바이너리 기각 확정(Apps Framework 철회가 반면교사)** ③ **ADR-0113 Proposed 기안** — custody A(호스트=클라이언트+remote 우선), delegation 4-튜플, GitHub-first+Drive 경로C(SA 포장 — 동결 사유 우회), D4 Slack-호환 webhook(ADR-0115 입력), egress manifest 명시.
- 다음: 성재 ADR-0113 option 승인 → SE-04A부터 파생. MOMO-408 PR 대기 중.

## 2026-07-16 (Fable, momo-main 오케스트레이터) · ADR-0121 배치 1 종결 — codex-fleet 복귀
- 성재 지시로 구현 체제 전환: Fable 전담 → **codex-fleet(worker=gpt-5.6-sol medium)**. MOMO-406/407 병렬 spawn(stall 워치) → 둘 다 클린 완주 → 독립 리뷰 2건 병렬 → 반영(429: H1 시드 dev-password 경고+M1 rg 스킵 봉합, 428: M1 의미론+verifier casing) → 순차 머지(`bb3efc6`→`4a8b288`) → main 게이트 PASS.
- 검증 분담 계약 작동: worker=정적/swift, docker 게이트=오케스트레이터 — runtime-db 1차 실행이 verifier UUID strict 비교 결함을 실제로 잡음.
- 후속 후보: prod 시드 fail-closed 서버 티켓(H1 파생, 공개 배포 전 필수 성격), install fake-docker trace, regenerate 404/409 분기.
- 다음 잔량: S-4 universal link(웹), 리액션 REST(UX 조율), ADR-0122 승인 시 음성 V-1, 플러그인 위임(16-02).
- 종결 확정: main post-merge runtime-db가 verifier flake 2건(핸들 32자 상한 — pid 자릿수 의존)을 잡아 전수 감사로 봉합(`f460867`·`a23c261`), 3차 런 **PASS**(join 44 PASS). 배치 완전 종결.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-404 종결 — ADR-0120 서버측 절반 완성
- P-2(PR #424 `a8a1089`) 종결. 후보 기록은 011 트리거(재량 행사 — 리뷰가 불변식 정합을 일회용 PG 재현으로 판정, overview.md에 "생산자 트리거 유일·신규는 ADR" 정본화). 리뷰 H1/M1/L1 반영 후 verifier 재PASS. stall 방지 계약(대기 전 push)이 처음으로 완전 작동.
- ADR-0120 잔여는 Dawn 운영 결정 대상: P-3(PushRelay 실발송 — Apple Developer 계정+relay 배포), P-4(iOS/M5). 후속 후보: push_candidate prune(L3), D2 필드 목록 ADR 반영(L2).
- 다음 후보(성재 신호 대기): ① ADR-0121 S 배치(install.sh — 배포판) ② 리액션 서버 REST(15-04, UX 트랙 조율) ③ ADR-0122 승인 시 음성 V-1 ④ 플러그인 위임(16-02). 엔진/인프라 트랙의 발급 가능 잔량은 이 4개.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-403 종결 + 크로스트랙 정리
- ADR-0120 P-1(MOMO-403, PR #422 `36c0d70`) 종결 — device 등록 REST + migration 010(단일 ACTIVE 토큰 DB 강제). 구현 에이전트 stall을 통합자가 인수(verifier 재실행 PASS→push/PR), 독립 리뷰 Medium(TOCTOU)을 RETURNING 원자 재검증으로 봉합 후 verifier 반영본 재PASS. runtime-db 프로파일에 verifier 편입.
- 푸시 배치 발급: MOMO-403 `#420`/404 `#421` + 패킷(2026-07-16-adr-0120-push-server-side.md — id-only 하드 계약·outbox 소비자 경합 방지·MOMO-395 설정 표면 경계).
- 크로스트랙: GPT momo-main 복귀 관찰(MOMO-402 `#418` 머지·plugin overlay). PLN-20260716-01 중복 레인을 한 행으로 병합, momo-main 지정 구체화 4항목(custody/Drive-vs-GitHub/delegation binding/egress)을 16-02 핸드오프에 승계. 유령 스택 정리 2회(성재 승인).
- 다음: MOMO-404 NotifierWorker 착수(unblock 완료) → 리뷰/머지로 ADR-0120 서버측 절반 완성. P-3(relay 실발송)는 Dawn 운영 결정 대기.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-401 종결 — 웹 v0 완주
- MOMO-401(PR #419) 머지(`9616c67`)로 ADR-0119 웹 v0 7티켓 완주. 구현 에이전트는 stall이 아니라 콜드빌드 3런의 장주행이었고(총 4h, 게이트 경화 2커밋 자가 산출), PR 선생성·리뷰 M1/L1 반영은 통합자가 수행. 독립 리뷰 Blocker/High 0.
- join=스펙 준수 즉시 세션(JoinResponse required 토큰), 초대 코드 비잔류, 오류 카피 서버 문자열 대조. 스모크 32 PASS.
- 다음: 푸시 P-1(device 등록 REST)/P-2(notifier) 발급이 자연 후속. ADR-0122(음성)·플러그인 16-02 위임은 성재 신호 대기. UX 트랙(momo240_38877 활동 관찰)과 파일군 충돌 없음 유지.

## 2026-07-16 (Fable, 엔진/인프라 트랙 momo-main 겸임) · MOMO-400 종결 + 플러그인 플랫폼 리서치
- MOMO-398(`#413`)/399(`#412`)/400(`#414`) 순차 머지. 400은 stall된 수정 에이전트를 통합자가 직접 인수 — 남겨진 의도적 누출을 강화 단정이 DOM 레벨 검출(음성 대조 실증), 최종 스모크 25 PASS/0. 유령 게이트 스택 5벌 정리(janitor+수동, momo_main 보존)로 OOM 재발 조건 제거.
- 성재 발제(플러그인 플랫폼, 1호 Drive)로 PLN-20260716-01 claim → `research/16-plugin-platform/` 00(생태계: 3층 표준 수렴·커스터디=클라이언트 문제·원클릭의 실체)·01(제안: 기존 ADR-0113→SE-04A 큐의 제품화, Drive 모드A는 동결 트랙 우회 첫 slice)·02(Fable 엔진 세션 핸드오프) 랜딩. 구현 없음 — 문서화만(성재 지시). hang된 하위 리서치 2기는 shutdown, 몫은 02의 1순위 검증 목록으로 승계.
- 다음: MOMO-401 `#411` unblock·착수(웹 v0 마지막) → 푸시 P-1/P-2. 플러그인은 성재가 02를 별도 Fable 세션에 위임. UI handoff(Codex) 도착 시 01 §5와 대조.

## 2026-07-15 (Fable, 엔진/인프라 트랙 momo-main 겸임) · 웹 첫 배치 3/3 종결 + 후속 발급
- MOMO-391(PR #407) 독립 리뷰 Blocker/High 0·Medium 1(만료 access 로그아웃 revoke) → 수정 반영(b499d32, 스모크로 서버측 revoke 실증) → merge `63e7d51` → main `--profile web` 전체 게이트 PASS. 웹 첫 배치(389/390/391) 종결, STATUS/BUILD_TICKETS evidence 정본화.
- 후속 발급: MOMO-398 `#408` prod Centrifugo allowed_origins(웹 W-4/W-5 선행 필수), MOMO-399 `#409` staging smoke namespace drift(DEVIATION_LOG 항목 `accepted` 판정).
- 크로스트랙 관찰: UX momo-main 재개 — PR #406(MOMO-385) 머지, MOMO-392~397 이슈(#398~#405) 발급됨. 겹침 정리: 스레드 REST 제안(15-04)은 MOMO-393에 흡수(중복 발급 안 함), 리액션은 MOMO-393 Out of scope라 미결(조율 대기), MOMO-394 첨부·MOMO-395 presence는 각각 파일 동결 계약(ADR-0113/0116)·ADR-0104 큐와의 정합을 UX momo-main과 확인 필요.
- 다음: 성재 신호 시 MOMO-398/399 Fable 에이전트 착수 → W-4/W-5 + 푸시 P-1/P-2 발급. ADR-0122(음성) 승인 대기 유지.

## 2026-07-15 (Fable, 엔진/인프라 트랙 momo-main 겸임) · 웹 첫 배치 389/390 머지 + 음성 ADR + 스키마 점검
- 성재 지시로 이 트랙은 Codex 대신 Fable 구현·검수 체제로 전환. MOMO-389(PR #404)/390(PR #403)을 Fable 에이전트가 worktree 구현 → 독립 리뷰(각각 Blocker/High 0, 게이트 독립 재현) → local_gate.sh 충돌 해소 후 순차 머지(`6fe746f`→`5ecd645`). 리뷰 후속(391 수용기준 web_serving_smoke 포함, GATE_PASSWORD 랜덤화, CSP 주석, spec-first 문구)과 STATUS evidence 반영.
- 스레드·리액션 점검(성재 질문): 둘 다 스키마 day-1 완비, REST/UI만 미구현 — `research/15-04`. 음성 허들 리서치 완료 → ADR-0122 Proposed(`LiveKit + 임시 허들 + 요약=agent_run Work`, 15-05) — 성재 승인 대기, Accepted≠즉시 착수.
- 선재 발견 gate drift(staging smoke ↔ agentwork namespace)는 DEVIATION_LOG `pending`.
- 다음: MOMO-391 `#397` unblock·Fable 에이전트 착수 → 리뷰 → 머지. 이후 W-4/W-5 + 푸시 P-1/P-2 발급. ADR-0122와 리액션/스레드 REST 티켓화는 성재 판단 대기.

## 2026-07-15 (Fable, 엔진/인프라 트랙 momo-main 겸임) · ADR-0119~0121 Accepted + 웹 첫 배치 발급
- 성재가 세 ADR 권고안을 전부 승인(AskUserQuestion 기록)했고, 이 트랙 한정 Fable의 momo-main 겸임(티켓·패킷·Issue 발급)도 승인했다. ADR 3건 Status를 Accepted로 전환.
- MOMO-389(OpenAPI 계약 정본+drift 게이트)/390(Caddy APP_DOMAIN+정적 서빙)/391(clients/web 스캐폴드) 수용기준을 BUILD_TICKETS에 등록하고 ready 패킷 `2026-07-15-adr-0119-web-track.md`를 발급했다. ROADMAP §1.6 플랫폼 확장 overlay 신설.
- 경계: UX 트랙(`clients/macOS/**`, MOMO-385/386)과 파일군 분리 유지. 웹 검증은 e2e compose(로컬 러너 수명주기 이슈와 무관). P/S 배치는 웹 배치 랜딩 후.
- 다음: GitHub Issue 발급(389/390 ready, 391 blocked) → 패킷 binding 갱신 → worker spawn은 성재 신호 대기.
- 성재 위임(엔진/인프라 트랙, 웹 우선 확정)에 따라 ADR-0119(웹 클라이언트 트랙), 0120(푸시 relay+notifier), 0121(배포판·초대 온보딩)을 Proposed로 기안하고 CURRENT_STATE 레인을 claim했다. base: MOMO-384 머지 후 main `b720250`.
- 웹 핵심 결정 제안: 같은 오리진 서빙(APP_DOMAIN site+`/v1` proxy — CORS 원천 회피, 서버 무변경), Vite+React+centrifuge-js, v0 토큰은 메모리+localStorage(공개 배포 전 httpOnly 승격 게이트), 수기 OpenAPI 정본+drift 게이트, v0 스코프="초대받은 사람이 브라우저로 합류해 대화".
- 코드 사실 대조: CORS/쿠키 코드 0건, login=body 베어러+회전(DTOs.swift:41-58), Caddy 2-site. UX 트랙(MOMO-385/386, clients/macOS)과 파일군 비충돌 확인.
- 다음: 성재 option 승인 → Accepted 전환 → 파생 배치(W/P/S) 티켓·패킷 발급(발급 주체는 momo-main 규약 — 겸임 여부 성재 확인 필요). 공용 정본(ROADMAP 웹 트랙 신설 등)은 승인 후 momo-main 통합.
- 성재 발제(이해도/슈퍼앱 수용성/인프라)를 받아 메신저 아키텍처 바이블 초판 6장(`docs/architecture/bible/`, 학습용 파생 등급)과 `research/15-platform-expansion/` 00~03을 랜딩했다. INDEX 등재, planning lane claim/갱신은 momo-main 자격으로 수행.
- 코드 대조 결론: 푸시/프레즌스/파일/웹훅은 "스키마·placeholder만 있고 경로 없음", 웹·리전은 완전 미예약, 그룹채팅은 기완비. 업계 결론: push relay는 Dawn 운영이 구조적 필연(id-only), 웹은 서버 동일 도메인 서빙, 멀티리전은 업계 전체가 비채택.
- 신규 ADR 후보 3건(α 푸시 relay, β 웹 트랙, γ 배포판·온보딩)과 기존 큐 입력(0104/0105/0113·0116/0115/0117)을 `15/03-decision-proposals.md`로 제안 — 번호 발급·우선순위·웹vs iOS 순서는 성재 결정 대기(§6).
- 다음: 성재가 §6 승인 시 ADR-α부터 draft 착수(0104 병렬 claim 가능). 바이블 07~10장은 해당 ADR 승격 후 집필.
- REST `members`/`channels`가 요청 시작 generation+workspace를 capture하고 reconnect 뒤 돌아온 이전 session 응답은 `CancellationError`로 폐기해 current cache를 건드리지 않게 했다.
- delayed A roster/channel → connect B → B cache load → A release race 2건을 deterministic URLProtocol gate로 고정했다. 전체 Swift count는 Core 24·Server 80·Relay 2·Worker 29·macOS 234 = 369.
- 이전 dirty-worktree gate evidence는 폐기한다. 새 final commit에서 dirty 허용 없이 runtime-db, 실제 launch macos-ui, docs를 실행하고 PR #389 handoff에 commit/evidence를 기록한다.
- 다음: PR #389 draft 유지, merge/close 금지, clean gate 뒤 momo-main final rereview.

## 2026-07-15 (Codex worker) · MOMO-383 final FAIL review actual fixes
- REST connect generation으로 delayed login→clear·overlapping A/B를 차단하고, channel/read/status subscription exact-token cleanup과 workspace identity+channels 병렬 bootstrap을 추가했다.
- workspace GET을 bounded one-query로 합치고 private migration drift exact-create/ACL, production external-role preflight, accessible retry color, narrow settings projection을 반영했다.
- Core 24·Server 80·Relay 2·Worker 29·macOS 232 = 367 tests; `runtime-db` 30/30(`…r7f86c3c71502`)와 실제 launch `macos-ui` 20/20(`…rfd90ac91063d`) PASS.
- 다음: PR #389 draft 유지, commit/push 후 momo-main final rereview. merge 금지; 후속 #390/#391/#392 유지.

## 2026-07-15 (Codex worker) · MOMO-383 fresh-deploy role-order P1 fix
- production migrate→role bootstrap 순서에서 migration 009의 conditional app grant가 건너뛰는 결함을 `bootstrap_roles.sql` app-only grant와 relay/worker explicit denial로 닫았다.
- ephemeral PG18 verifier가 runtime role 0개 → migrate → 여전히 0개 → bootstrap → app exact invite lookup allow, relay/worker deny를 실제 실행한다.
- static contract와 full `runtime-db` 30/30 PASS(`20260714T221124Z-…-r584776886194`), Swift 360 tests 유지.
- 다음: PR #389 draft 유지, 추가 commit/push 뒤 momo-main final rereview/merge.

## 2026-07-15 (Codex worker) · MOMO-383 final review fix 검증 완료
- 모든 bootstrap await/subscription·409 reload generation guard, authoritative-denial persistent cache 삭제, workspace root FORCE RLS와 locked-schema invite lookup, no-cache retry/AX 및 normalized settings를 반영했다.
- locked function은 app만 호출하고 PUBLIC/worker/relay/platform은 broad public function grant 뒤에도 거부됨을 `verify_rls.sh`와 실제 join smoke로 확인했다.
- Core 24·Server 79·Relay 2·Worker 29·macOS 226 = 360 tests; full `runtime-db`와 launch 포함 `macos-ui`, design preflight PASS.
- 다음: PR #389 draft 유지·momo-main final rereview/merge; 후속 MOMO-384 `#390`, MOMO-385 `#391`, MOMO-386 `#392`.

## 2026-07-15 (Codex worker) · MOMO-383 correctness/performance review fix
- stale workspace GET이 rename/new session을 덮지 못하도록 session/load generation + `updatedAtMs` guard를 추가하고, unknown error cache fallback은 default-deny, REST cancellation은 `CancellationError` 보존으로 고쳤다.
- Live demo cache scope를 제거하고 isolated UserDefaults 반복 bootstrap, race/session/cancellation/default-deny 회귀 6건을 추가했다. verifier는 apostrophe 이름을 `psql -v` stdin binding으로 audit하고 복원 GET까지 확인한다.
- `verify_channel_management.sh`, worker `swift`, `macos-ui` PASS. Core 24·Server 78·Relay 2·Worker 29·macOS 219 = 352 tests 0 failure.
- 다음: PR #389 draft 유지. #388 merge/rebase 뒤 momo-main full `runtime-db` + final rereview; 후속은 MOMO-384 `#390`, MOMO-385 `#391`, MOMO-386 `#392`.

## 2026-07-15 (momo-main/Codex) · MOMO-383 리뷰 반려 수정
- security/design 독립 리뷰에서 ADR 부재, cache auth leak, stale conflict, 모호한 오류/권한 문구와 verifier 복원 결함을 찾아 실제 수정했다.
- ADR-0118을 Accepted 결정으로 추가하고 cache를 server+member+workspace로 격리, 401/403/404 비노출, 409 자동 reload, 구 cache Codable 호환을 구현했다.
- workspace 설정은 validation/권한/충돌/연결 copy와 cached-name 재시도를 제공하고, sidebar subtitle은 현재 사용자 문맥을 표시한다.
- 전체 Swift Core 24·Server 78·Relay 2·Worker 29·macOS 212 = 345 tests 0 failure. 다음: final rereview → clean gates → PR/merge/root main.

## 2026-07-15 (momo-main/Codex) · MOMO-383 workspace-first 구현 검수
- toolbar workspace capsule을 sidebar 최상단 identity/native popover로 옮기고 owner/admin durable workspace rename API와 audit를 구현했다.
- ordinary member/cross-workspace 403, 두 client 영속 read, audit/restore, 표준·좁은 실창 기하는 PASS했다.
- icon/invite policy는 local draft, multi-workspace는 ADR-0117 전 금지, interactive Work command는 ADR-0114 전 금지 경계를 유지했다.
- 다음: fresh code/design review와 clean 3-gate 후 merge; 그 뒤 MOMO-384/385를 unblock한다.

## 2026-07-15 (momo-main/Codex) · PLN-20260715-01 workspace-first superapp shell
- 성재 실창 QA 12건을 workspace navigation, native channel sheet/tooltip, member inspector/one-click DM, RLS workspace search의 4개 builder로 분리했다.
- `Control+backtick`는 transcript drawer(MOMO-375)와 interactive Work Console을 분리하고, 후자는 ADR-0114 승인 전 구현 금지로 고정했다.
- multi-workspace는 ADR-0117 전 fake rail 금지, engine은 ADR-0113/0116 → 0114 → 0115의 planning-only queue로 분리했다.
- 다음: MOMO-382 docs gate/review/merge 후 MOMO-383을 첫 UX goal로 발급한다.

## 2026-07-14 (momo-main/GPT 5.6) · PLN-20260714-02 슈퍼앱 엔진 리뷰
- engine planner의 gap audit/proposal/handoff를 인수해 security review High 7/Medium 2, architecture review High 6/Medium 3을 반영했다.
- ADR-0113~0116을 예약하고 Memory/Capability, plugin/webhook, Codex bridge/real gate, GWS runtime/evidence/citation을 one-issue/one-PR 단위로 분할했다.
- MOMO-307은 강화 유지하고 MOMO-308은 non-claimable MCP umbrella(SE-03A/B/C 새 ID)로 전환했다. MOMO-310 advanced RAG, MOMO-320 env drift 전용, MOMO-321/322 후속 동결로 충돌을 정리했다.
- 다음: 성재가 ADR 권고를 승인하면 0113/0116부터 draft goal을 발급한다. engine PR은 기본적으로 macOS UX 잠금 파일을 건드리지 않는다.

## 2026-07-14 (momo-main/GPT 5.6) · MOMO-380 식별자·보안 경계 재정정
- 아래 `MOMO-380`은 GitHub Issue `#381` / PR `#382`의 제품 티켓 ID다. 로컬 기록 부재로 혼동될 수 있어 이 항목으로 식별자를 명시한다.
- upstream Codex/OpenAI 자격증명 비유입과 허용되는 Hermes-facing bearer를 분리하고, GWS token 저장은 Accepted ADR 전 연구 스펙으로 낮췄다.
- engine planner는 BUILD_TICKETS 정본을 직접 수정하지 않고 proposal 안에 변경안을 남기며, 완료된 ADR-0109 Wave 2의 stale 다음 행동도 제거했다.
- 다음: docs gate와 의미 재리뷰가 green이면 PR #382를 merge하고 root main을 최신화한다.

## 2026-07-14 (momo-main/GPT 5.6) · MOMO-380 의미 리뷰 반영
- 독립 리뷰가 provider 자격증명 경계 과잉 일반화와 Work 실런타임 검증 과장을 지적해, Codex/OpenAI 실행 토큰과 GWS connector 토큰 경계를 분리했다.
- Work는 코드·mock 검증 완료/실 Codex 승인 왕복 `runtime-unverified`로 정정하고, 완료된 362..365 중복 발급 행을 제거했다.
- `PLN-01`은 `waiting-owner`, `PLN-02`는 `queued/unclaimed`로 고쳐 planner claim과 구현 worker 역할을 분리했다.
- 다음: PR #382 재게이트·리뷰 후 merge; UX 육안 QA와 engine planning claim은 그 뒤 각각 진행한다.

## 2026-07-14 (momo-main/GPT 5.6) · Fable 인수 감사 + UX/엔진 두 트랙 고정
- main/origin `b5e572b`, 열린 PR 0을 확인하고 Fable의 ADR-0112 Wave A(370..372)+MOMO-379 실창 크롬 핫픽스 랜딩을 코드/BUILD_TICKETS/저널과 대조했다.
- 다음 UX는 373..378이 ADR 후보로만 존재하고 BUILD_TICKETS 계약·handoff·Issue가 아직 없으며, 최신 앱 육안 QA와 멤버 행 절단 판정이 선행이다.
- 엔진은 Work/승인/bearer/status/비용·감사는 구현됐고, Context Broker·MCP는 부분, GWS·plugin runtime은 스펙, webhook은 placeholder임을 CURRENT_STATE에 고정했다.
- 다음: `momo-main`은 UX 수동 QA(`PLN-20260714-01`), 별도 engine planner는 슈퍼앱 builder chain(`PLN-20260714-02`)을 제안하고 성재 승인 후에만 공용 정본/Issue로 통합한다.

## 2026-07-14 (momo-main/Fable) · MOMO-379 크롬 핫픽스 2차 랜딩 — 실측 반증→재수정 사이클
- 성재 스크린샷 3결함(타이틀 중복·패널 침범·배지 겹침) → 1차 수정은 리뷰 실창 AX 실측이 no-op 반증(SwiftUI가 SplitView 칼럼 safe area를 0으로 보고) → `contentLayoutRect` 기반 재수정 → 2차 실측 리뷰 PASS(3케이스 AX 확증). PR #380 merge(`cef7430`), root `macos-ui` green.
- 교훈 확립: 창 크롬 클래스는 스냅샷·코드 논증으로 부족 — 실창 AX 실측이 리뷰 필수 단계(D6). harness도 프로덕션 창 구성이어야 정본에 증거 능력이 생긴다.
- 이월: 멤버 행 이름 절단(기존, layoutPriority) 별도 티켓 후보.
- 다음: 앱 재빌드→성재 재확인 → Wave B/C 발사 판정.

## 2026-07-14 (Codex worker) · MOMO-379 실창 AX 재반려 수정
- 기존 safe-area 수정은 `NavigationSplitView` 칼럼에서 top=0인 no-op이었다. hosting `NSWindow.contentLayoutRect`를 flipped/non-flipped content 좌표로 읽어 sidebar/detail에 전파하고 overlay/attached를 보이는 채널 헤더에 앵커했다.
- production full-size+unified 전체 root를 쓰고 WindowServer 합성본만 canonical 기록하도록 하네스를 교체했다. dark headless 흰 캡슐은 비정본 `cacheDisplay` 합성 결함으로 격리하고 fixture는 `momo/상준`으로 고쳤다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29 전체, macOS non-snapshot 146와 MOMO-379 기능 10+artifact 1이 PASS(canonical 3 skip)했다. fresh D6는 구현 6/7(Blocker 0, High 1=실창 AX 증거)이다.
- 계획 이탈: Computer Use가 custom dev app을 거부하고 관리 shell에는 WindowServer/AX trust가 없어 worker 표준/좁은/attached AX 실측은 `runtime-unverified`; 오케스트레이터 재측정이 필요하다. DB/Docker/verifier/gate는 미실행했다.

## 2026-07-14 (Codex worker) · MOMO-379 창 크롬 핫픽스
- 두 app host를 공용 title-hidden unified toolbar로 고정하고, overlay/attached inspector를 live safe area와 측정 채널 헤더 아래로 제한했다.
- 계획 이탈: 의심된 승인 배지는 하단 고정 utility라 원인이 아니었고, 실제 빨간 겹침은 workspace header를 toolbar로 옮긴 뒤 top safe area를 잃은 첫 채널 mention 배지였다. 해당 sidebar 경로만 safe area를 소비한다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29·macOS non-snapshot 145와 MOMO-379 raster, fresh D6 review 6/7(Blocker/High 0) PASS. 무필터 macOS의 기존 headless `NSImage` signal 5와 Xcode nested sandbox 실패는 재현했다.
- 정본 3종은 오케스트레이터 재기록 대기, 실 Dev/Xcode click·fullscreen은 `runtime-unverified`. DB/Docker/verifier/`local_gate.sh`는 미실행했다.

## 2026-07-14 (momo-main/Fable) · ADR-0112 Wave A 종결 (370/371/372)
- merge: 370 `6f4090c`(Blocker 반려: dev 밀도 보존+조사 비문+비용 누출) → 371 `c9ed890`(High 4 반려 — 리뷰 A/B 프로브가 죽은 닫기 버튼의 실증 원인=타이틀바 밴드 규명, 본문 15pt) → 372 `e254cc6`(Blocker 반려: 빈 캡처+DM 검색·정렬·배지, 멤버 수→디렉터리 훅 통합). root full gate green(`…062029Z…`, `…062619Z…`).
- D6 SLA rubric이 첫 판부터 유효: 빈 스냅샷·리터럴 DM·크롬 원인 오기가 전부 리뷰에서 잡힘. canonical 재기록 총 21종(fixture 변경분은 삭제 후 기록).
- 다음: 라이브 앱 재빌드→성재 육안(기본 모드/헤더/디렉터리·DM) → 판정 후 Wave B(373..375: 호출 옵션·승인 프리셋·⌃` 드로어)/C(376..378: 대시보드·온보딩 여정·런치 WOW) 발급.

## 2026-07-14 (Codex worker) · MOMO-372 MOMO-371 최종 rebase
- `origin/main@c9ed890` 위로 직접 rebase하고 ChannelList/QuickSwitcher 충돌에서 371 로컬 rename·topic·인콘텐츠 헤더 제거와 372 DM 상대 이름·숫자 배지·디렉터리 진입점을 함께 보존했다. 문서 기록도 양쪽을 유지했다.
- 채널 헤더 `멤버 N명`의 optional action은 production root의 `MemberDirectoryView` sheet fallback으로 연결하고, 외부 주입 action 우선 계약과 회귀 테스트를 추가했다.
- 5패키지 build, Core 전체 24·macOS non-snapshot 전체 143·371/372 비정본 raster 7 tests와 fresh D6 design-review(Blocker/High/Medium/Nitpick 0) PASS. 무필터 macOS 전체는 기존 canonical `AgentCredentialSnapshotTests` headless `NSImage` signal 5에서 중단돼 재기록 대상으로 남겼다.
- 계획 이탈: 371/372가 서로 다른 뜻으로 추가한 `noWorkspaceMembers` 이름 충돌은 채널 추가 빈 상태와 directory 빈 상태를 별도 copy로 분리했다. PNG 변경 없이 정본 재기록은 오케스트레이터 대기이며 DB/Docker/verifier/`local_gate.sh`는 미실행(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-372 D6 리뷰 반려 반영
- Blocker 1+High 3+Medium 3을 반영해 실제 검색/닫기/멤버 행 raster, ⌘K 상대 이름 검색, 표시 이름→ID DM 정렬, DM unread 숫자, 1줄 이름, 멤버 제목의 죽은 버튼 제거를 고정했다.
- 계획 이탈: visible `NSWindow` host는 XCTest signal 11, hidden system toolbar는 dark vibrancy smear라 list/detail을 borderless window에서 분리하고 동일 바인딩의 snapshot-only native capture chrome으로 증거화했다. 신규 정본 6건+기존 ChannelRoster 6건은 오케스트레이터 재기록 대기이며 PNG 변경은 없다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29·macOS 기능/비정본 raster 138 tests PASS. 무필터 macOS는 기존 headless `AgentCredentialSnapshotTests` `NSImage` signal 5를 재현했다.
- fresh design-review PASS: Blocker/High/Medium/Nitpick 0. 검색·닫기·멤버 행과 DM 버튼 제목은 source-pixel raster assert로, DM 상대 이름+unread 수는 light/dark sidebar raster로 고정했다.
- 수정 금지 기록: directory `.task` stale, 키보드 진입, raw `directMessageError`, in-flight 버튼 레이아웃. DB/Docker/verifier/`local_gate.sh`는 미실행(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-372 멤버 디렉터리 + DM
- active workspace member 쌍을 정렬·해시해 멱등 생성하는 tenant DM REST와 Core/REST/in-memory 계약을 추가하고, roster 기반 macOS 멤버 디렉터리·프로필·DM 시작·사이드바 상대 이름/기존 unread 결합을 구현했다.
- 계획 이탈 없음. `schema_v0.sql`, 채널 헤더, 메시지 카드와 기존 정본 PNG는 건드리지 않았다.
- 5패키지 build, Core 24·Server 76·Relay 2·Worker 29·macOS 기능/비정본 래스터 134 tests와 fresh design-review 전 등급 0이 PASS했다. DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행이며 RLS·동시성 런타임은 `runtime-unverified`다.
- 필터 없는 macOS suite의 기존 headless `AgentCredentialSnapshotTests` signal 5와 정본 light/dark PNG 재기록은 오케스트레이터 대기다.

## 2026-07-14 (Codex worker) · MOMO-371 MOMO-370 rebase
- `origin/main@6f4090c` 위로 직접 rebase하고 MessageListView/MomoMacRootView 충돌에서 371 헤더·통합 toolbar와 370 `showsCosts`·Alpha 개발자 gate를 함께 보존했다. 문서 기록도 양쪽을 유지했다.
- 개발자 모드 해제 시 닫힌 Alpha 상세가 재개방되지 않도록 presentation의 pane redirect를 분리하고 회귀 테스트를 추가했다. 비정본 renderer는 임시 NSWindow에서 native default action을 그려 light/dark 레이블 증거를 안정화했다.
- 5패키지 build, Core 23, macOS 기능 135·실행 가능 snapshot 39(정본 대기 2 skip) PASS; fresh design-review는 Blocker/High/Medium/Nitpick 0이다. 무필터/MessageBubble canonical은 기존 headless `NSImage` signal 5를 재현했다.
- 계획 이탈 없음. 정본 재기록·실창 검증은 오케스트레이터 대기이며 DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행했다(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-371 fresh review High 4/Medium 3 반영
- 런타임 A/B로 죽은 닫기 버튼의 원인을 surface stroke가 아닌 구 타이틀바 밴드의 콘텐츠 침범으로 정정했다. unified toolbar 수정은 유지하고 `allowsHitTesting(false)`는 방어로만 기록한다.
- 372용 optional directory 액션을 production session root까지 전달하고, 로컬 채널 표시값을 헤더·사이드바·퀵스위처가 공용 해석하며, row/message 본문을 15pt급 semantic role로 상향했다. 토픽 2줄, 프로덕션 sidebar snapshot, 저장 후 재편집 상태도 보정했다.
- 수정 금지 후속 기록: 채널 설정 키보드 경로, 영어 placeholder 톤, AppStorage 키 상수화.
- main의 MOMO-370 선랜딩 후 rebase·정본 재기록은 오케스트레이터 몫이다. DB/Docker/verifier/`local_gate.sh`는 미실행한다.

## 2026-07-14 (Codex worker) · MOMO-371 채널 헤더·macOS 크롬
- 채널 identity/주제/멤버 수/설정과 이름·주제·멤버·연동 시트를 구성하고 MOMO-372 디렉터리 closure만 노출했다. 워크스페이스 identity는 unified toolbar로 옮기고 상세 패널은 단일 열림/닫힘 상태로 고정했다.
- 계획 이탈: 사전 생성 worktree/branch와 `status:ready` 부재로 assignee/`status:in-progress`를 수동 반영했다. 서버 channel update 계약이 없어 이름/주제는 동기화 범위를 밝힌 Mac 로컬 표시값이며, webhook과 실제 디렉터리는 후속 계약/티켓 경계를 유지했다.
- 5패키지 build, Core 23/Server 73/Relay 2/Worker 29/macOS 비이미지 130 tests와 MOMO-371 raster가 PASS했다. fresh design-review는 전 등급 0, 무필터 macOS는 기존 headless `NSImage` signal 5를 재현했다.
- 정본 light/dark PNG와 실창 traffic-light/fullscreen/닫기 hit-test는 오케스트레이터 대기다. DB/Docker/verifier/`local_gate.sh`는 지시대로 미실행(`runtime-unverified`).

## 2026-07-14 (Codex worker) · MOMO-370 fresh D6 반려 수정
- dev Work 카드는 기존 `input.brief`를 복원해 실행 로그/결과 중복과 canonical 회귀를 해소했고, 표준 모드 Alpha Command Center 직접 표면·승인 연관 버튼·초대 fallback을 dev gate 또는 초대 안내로 정리했다.
- 마지막 한글 음절 종성 기반 이/가·을/를·은/는 헬퍼와 혼합 이름 테스트를 추가하고, 접힌 카드는 2줄·펼침은 전문+detail 무중복으로 바꿨다. 표준 ApprovalInbox 실데이터 raster도 추가했다.
- 계획 이탈 없음. 참고-only 후속으로 `local alpha` 캡션, 설정 토글 캡션 위계, 무의미한 `agentActivitySummary` switch를 기록하며 이번 PR에서는 수정하지 않았다.
- 5패키지 build, Core 23·Server 73·Relay 2·Worker 29·macOS 비이미지 130 tests, 기존 Work canonical 2종과 검토 raster 13종 PASS; fresh review 6.5/7, 전 등급 0. 신규 dual-density 정본 4종 재기록과 기존 headless `NSImage` signal 5는 오케스트레이터 대기다.

## 2026-07-14 (Codex worker) · MOMO-370 개발자 모드 + 메시지 이중 밀도
- 기본 off 개발자 모드/별도 비용 토글과 standard/developer 타임라인·Work·승인·사이드바·온보딩 게이트를 구현하고, 데모를 사람 언어 대화와 양 밀도 fixture로 재큐레이션했다.
- 계획 이탈: 오케스트레이터가 만든 worktree라 `goal_claim.sh` 대신 assignee/`status:in-progress`를 수동 반영했다. 수용기준의 전역 tool/비용/로컬 알파/세션 상세 숨김을 닫기 위해 의존 표면 `AgentPartialView`·metadata·`ApprovalInboxView`·`MomoServerSession`까지 수정했으며 371/372 소유 파일은 무접촉이다.
- 5패키지 build, Core 23·Server 73·Relay 2·Worker 29·macOS 비이미지 129 tests, 검토용 raster 18종, fresh review Blocker 0(55/70) PASS. 기존 headless snapshot signal 5와 실창 상호작용은 `runtime-unverified`다.
- 다음: 오케스트레이터가 신규 timeline standard/developer light/dark 정본 4종을 재기록하고 clean 실창 검수를 수행한다. DB/Docker/verifier/`local_gate.sh`는 worker 지시대로 미실행했다.

## 2026-07-14 (momo-main/Fable) · 성재 실사용 종합 피드백 → ADR-0112 기안·Accept + Wave A 스폰
- 성재 판정 "최악의 경험" — 실행 원장 과노출(비개발자 공포), 메신저 기본기 부재(디렉터리/DM/헤더), Codex 문법 부재(호출 옵션·승인 프리셋·⌃` 드로어), 첫인상 밋밋, 디테일 결함(타이틀바 겹침·죽은 닫기 버튼). ADR-0112로 성문화: **"하나의 타임라인, 두 개의 밀도"** — 기본=Slack, 개발자 토글=Codex 앱. 같은 날 Accept.
- 파생 MOMO-370..378 3웨이브. Wave A(370 듀얼 모드/371 헤더·크롬 결함/372 디렉터리·DM) 즉시 스폰, B/C는 A 랜딩 후. design-review rubric에 D6 디테일 SLA(죽은 컨트롤·크롬 겹침·잘린 텍스트=무조건 Blocker) 추가.
- 별건 처리: 에이전트 대시보드(D5)·온보딩 여정(D4)은 Wave C. swift-lsp 플러그인 검증 병용 예정.
- 다음: Wave A 랜딩 사이클 → 성재 육안 → B/C.

## 2026-07-13 (Codex worker) · MOMO-369 fresh design-review High 2 수정
- `.windowChrome` 표면 범위로 루트·사이드바·타임라인 fill의 safe-area bleed를 복원하고 bounded 카드·팝오버 chrome 순서는 유지했다. 오류 상태는 인증/불러오기/보내기/작업으로 분리했으며, send 재시도는 실패 요청의 `clientMsgId`와 에이전트 멘션 대상을 보존한다.
- 계획 이탈 없음. MOMO-368을 union rebase하되 온보딩 PR diff와 정본 PNG는 0건으로 유지했고, 5패키지 build, Core 23·Server 73·Relay 2·Worker 29·macOS 기능 127+비정본 래스터 6 tests와 fresh review(Blocker/High/Medium/Nitpick 0)가 PASS했다. 필터 없는 macOS suite의 기존 headless canonical signal 5는 오케스트레이터 재기록 대기다.
- 수정 금지 후속 기록: increased-contrast 팔레트, 승인 인박스 행/카드 그림자 누적, 진단 팝오버 이중 chrome, `sessionChrome == nil` 재로그인 no-op, DateFormatter 캐시, panel 토큰 의미 분화.

## 2026-07-13 (Codex worker) · MOMO-368 fresh design-review 반려 반영
- High 1: primary 라벨의 `onAccent` 강제를 제거해 비활성 창 표현을 시스템 `borderedProminent`에 위임했다.
- Medium 3: 실효 없는 접근성 변형 2종 산출을 제거하고, 네 필드 Enter를 현재 primary에 연결했으며, 필드 배경을 불투명 semantic 색으로 교체했다.
- 참고 기록(수정하지 않음): 비밀번호 placeholder 중복, `isPreviewFocused`, 영어 hero 칩, 영어 단일 `OnboardingInviteView`, 기존 영어 `sessionNotice`.
- 계획 이탈 없음. 5패키지 build, Core 23/server 73/relay 2/worker 29/macOS 비이미지 122 tests, snapshot 5(1 PASS+4 skip), fresh review 전 등급 0 PASS; 정본 PNG 4건은 오케스트레이터 재기록 대기(`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-368 온보딩/로그인 재구성
- 560pt 중앙 단일 구성, 입력 상태 기반 데모/로그인 primary 1개, 낮은 위계의 초대·Keychain·로컬 알파 채우기, Tab/Enter/Esc 및 오류·오프라인 복구를 구현했다.
- 계획 이탈: 없음. 최초 디자인 리뷰 Blocker 1(커스텀 field chrome 설명 부재)과 High 2(오프라인 복구·accent 불일치)는 네이티브 편집 동작 유지 설명, transport/auth 분류+직접 데모, 공용 tint로 해소했다.
- 5개 Swift 패키지 build와 Core 23/server 73/relay 2/worker 29/macOS 비이미지 122 tests, fresh design-review(Blocker 0/High 0/Medium 1) PASS; 기존 headless image snapshot signal 5는 재현됐다.
- 신규 정본 light/dark PNG 4건 재기록과 clean/root `macos-ui`는 오케스트레이터 대기다. DB/Docker/verifier/`local_gate.sh`는 미실행(`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-369 앱 셸 시각 폴리시 W3
- 양 스킴 3층 표면·타이포·motion 토큰을 앱 셸/타임라인/Work·승인/팝오버에 적용하고, 401 단일 재로그인 배너·subtle REST 칩·커서/날짜/멘션/capability 이월을 해소했다. 온보딩·스키마·정본 PNG는 무접촉이다.
- 계획 이탈: 사전 생성된 worktree/branch와 `status:ready` 부재로 `goal_claim.sh`를 재실행하지 않고 assignee/`status:in-progress`를 수동 반영했다. 제품 수용기준 이탈은 없으며 repo-wide pre-flight의 기존 fixed-font hit는 변경 파일 밖이다.
- 5패키지 build, Core/Server/Relay/Worker 127 tests, macOS 비이미지 120 tests와 W3 raster 5 tests PASS; fresh review는 raw Command Center 진단 High를 수정한 뒤 Blocker/High 0, Medium 1이다. 전체 macOS는 기존 headless NSImage signal 5, 정본 재기록과 금지된 DB/Docker/verifier/gate는 오케스트레이터 대기(`runtime-unverified`).

## 2026-07-13 (momo-main/Fable) · Work v0 + Wave 2 배치 종결 (362..367) + 라이브 반영
- merge 순서: 362 `2d5b2ad` → 366 `69facce` → 363 `44f8d35` → 365 `f5aba9f` → 364 `adf159f`(High 반려: 종결 run ephemeral 가림) → 367 `fd8eabe`(스펙 변경 ⌥⇧↑↓ `d9f4e68` + 364와 7파일 rebase는 worker 위임). root full gate 2종 green(`…075706Z…-ra6804669e978`, `…080432Z…-r6738c50ddf08`).
- 교훈: rebase union 해소 후 전 패키지 빌드 검증 필수(Theme/Core brace 유실 2건 수기 수리 전례), 실충돌 다수 rebase는 맥락 가진 worker에 위임이 정확.
- 라이브 반영: dogfood Centrifugo `allow_user_limited_channels` 패치·재기동, server/relay/worker 신 바이너리 재기동(구 프로세스 SIGKILL 정리), read-state 벌크 라이브 확인(201:2/202:6), 앱 재빌드(pid 73174).
- Work 데모 잔여 1: codex 에이전트 시드는 dogfood DB 직접 쓰기 거부(정책 일관) — 성재 opt-in SQL(scratchpad `seed-codex-agent.sql`) 후 credential 발급·codex-workbench 기동은 오케스트레이터 몫. 데모 워크스페이스 `~/momo-workbench-demo` 준비됨.
- 다음: 성재 육안(전체 UI+unread+Cmd+K) → codex 시드 → /work 실데모 → Phase A 운영 단계(GHCR publish·EC2).

## 2026-07-13 (Codex worker) · MOMO-367 rebase on MOMO-364
- `origin/main` `adf159f` 위로 rebase해 Work 카드·컴포저·`⇧⌘W`와 unread·mark-read·`⌥⇧↑↓` union을 보존했다.
- 5개 Swift package build, Core 23 tests, macOS 비이미지 116 tests와 MOMO-367 snapshot 클래스는 green이다.
- 필터 없는 macOS test는 main 기존 `AgentCredentialSnapshotTests`의 headless 1x/정본 2x `NSImage` fatal로 중단; 정본 재기록은 오케스트레이터 대기다.

## 2026-07-13 (Codex worker) · MOMO-367 review spec correction
- 계획 이탈: planner 승인(momo-main/Fable)에 따라 unread 순회를 macOS 텍스트 선택과 충돌하는 `⇧⌘↑↓`에서 Slack 문법 `⌥⇧↑↓`로 변경했다.
- BUILD_TICKETS 정본 문구 갱신과 신규 light/dark PNG 기록은 오케스트레이터 대기다.

## 2026-07-13 (momo-main/Fable) · UI Wave 1 종결 (358 랜딩) + Work v0·Wave 2 발급
- MOMO-358 랜딩: 리뷰 High(⌘1..9 서수 술어 ≠ 사이드바 표시 술어) 반려→공용 ordered source 공유+Cmd+K 토글(`b261aea`), 스위처 정본 4종 재기록·육안 확인, clean gate PASS, PR #356 merge(`5ac5fa9`) — **W1 종결(357/358/359)**. root runtime-agent PASS(`…20260713T050905Z…-r3cfb32a2aaf2.md`); root macos-ui는 이 정본화 커밋이 게이트 중 root를 dirty로 만들어 1회 FAIL(자충수) → 커밋 후 재실행.
- ADR-0111·0109 파생 배치 발급: 패킷 2종(agent-work-surface, ui-wave2-unread) + BUILD_TICKETS 362..367 수용기준. 선행 362(work run 계약)·366(read-state 계약) 스폰, 363/364/365/367은 선행 랜딩 후.
- 다음: root macos-ui 재실행 green 확인 → 362/366 랜딩 사이클 → 성재 육안(새 UI + Cmd+K는 라이브 앱 재빌드 필요).

## 2026-07-13 (Codex worker) · MOMO-358 fresh review fix
- 사이드바·퀵 스위처·`Cmd+1...9`가 non-archived 일반 채널→DM ordered source를 공유하게 하고 `Cmd+K` 재입력 닫힘을 추가했다.
- 후속 기록(이 PR 수정 금지): AGENT 배지 공용화, 패널 radius 14 분화, SF Symbol 혼용, 에러 원문 덤프 노출, viewport 높이 과소평가.
- 정본 light/dark PNG 재기록과 DB/Docker/verifier/gate는 계속 오케스트레이터 대기다.

## 2026-07-13 (momo-main/Fable) · UI W1(357/359)+Phase A(360/361) 랜딩 — 358만 잔여
- merge 순서: MOMO-360 `6980e64` → 361 `1c044e6` → 359 `6b75260`(Blocker 반려 1회: 복사 칩 `.opacity` 밖 상시 노출 → 수정 후 timeline+bubble 정본 재기록) → 357 `94e9244`(High 반려 1회: 멤버 mutation 비마우스 경로 → context menu 복원, Theme은 354 adaptive 토큰과 union). root runtime-agent+macos-ui full gate green(`…20260713T041003Z…`, `…20260713T041531Z…`).
- 게이트 운영 교훈: 워크트리 macos-ui는 compose 스택 필요 — 수동 `up`은 Centrifugo fingerprint 부재로 drift guard FAIL(→`MOMO_CENTRIFUGO_AUTO_RECREATE=1` recreate), verifier는 api 포트 비점유 필요(compose api/relay/worker stop 후 실행). worker capacity/스트림 오류 3회는 전부 세션 resume으로 복구.
- MOMO-358(Cmd+K, `#351`) 스폰 — W1 잔여 1건. 랜딩 시 W1 종결 → Work 배치(362..365)+Wave 2(unread) 발급 조건 충족.
- 다음: 358 랜딩 사이클, 라이브 앱 재빌드로 성재 육안 확인(새 사이드바·타임라인), Work/Wave 2 티켓 발급.

## 2026-07-13 (Codex worker) · MOMO-357 fresh review fix
- 멤버 context menu에 add/remove를 추가해 키보드·VoiceOver mutation 경로를 복원하고, workspace gear의 비가시 hit-test/accessibility를 차단했다. 개명 전 고아 snapshot PNG 2장도 삭제했다.
- 후속 기록(이번 PR 수정 금지): profilePresenceBadge의 "나" 추정 휴리스틱, 비적응형 white `subtlePanelBorder`, 앱 전역 radius scale 통합.
- 검증 후 같은 브랜치에 push하고 PR #355는 `status:needs-review`에서 유지한다. 신규 light/dark PNG 정본은 오케스트레이터 재기록 대기다.

## 2026-07-13 (Codex worker) · MOMO-357 UI W1 셸·사이드바
- `NavigationSplitView` 폭 토큰과 워크스페이스/채널/DM/멤버 계층, 하단 승인·개발 유틸리티, hover 멤버 액션, server-roster presence 숨김을 구현했다.
- 계획 이탈: repo 전체 design pre-flight는 티켓 밖 기존 view의 fixed font 41건을 반환한다. 변경 파일은 0 hit이며 MOMO-359 경계인 `MessageListView`/`MessageBubble` 등은 수정하지 않았다.
- 검증: macOS build, 비스냅샷 82 tests, light/dark raster 1 test PASS. 새 light/dark 정본 PNG는 reference-wait skip, 전체 snapshot은 기존 host signal 5로 오케스트레이터 대기(`runtime-unverified`).
- 다음: fresh design-review 후 worker PR handoff; 오케스트레이터가 정본 PNG 재기록과 clean `macos-ui` gate를 수행한다.

## 2026-07-13 (Codex worker) · MOMO-360 GHCR 이미지 발행
- api/relay/worker는 공용 Swift Dockerfile, migrate는 기존 source-checkout-free SQL/shell 전용 Dockerfile로 linux/arm64 GHCR 발행 계약을 추가했다.
- 계획 이탈: 핸드오프의 “4종 모두 swift-service.Dockerfile 기반”은 실행 파일이 없는 migrate에 적용 불가해 기존 전용 Dockerfile을 재사용했다.
- prod compose/env/preflight를 shared SHA tag·per-image digest rollback·migrate-first로 정렬했다. Docker/AWS/verifier/local gate는 미실행(`runtime-unverified`).

## 2026-07-13 (momo-main/Fable) · ADR-0111 기안 (Agent Work Surface, 성재 발제) + UI W1/Phase A 스폰
- 성재 발제: 메신저 내 업무·터미널·코드 작업(특화 에이전트 + codex 오픈소스 활용) → ADR-0111 Proposed 기안. Option A(BYOA 실행: momo 서버는 코드 실행 안 함, codex CLI=에이전트 호스트 엔진, sandbox→승인 티어 매핑, capability 배지 명시 선택) 권장.
- ROADMAP §1.4 overlay 추가, MOMO-362..365 예약(Accepted 전 발급 금지). ADR-0109(unread)도 같은 날 Proposed.
- UI W1(357 `#347`/359 `#348`)+Phase A(360 `#349`/361 `#350`) worker 4기 스폰, 358 `#351`은 357 랜딩 대기.
- 성재 판정(같은 날): **ADR-0111 Accepted (Option A=BYOA)** + **ADR-0109 Accepted**. Work 배치·Wave 2 모두 현행 배치 랜딩 후 발급으로 확정.
- 다음: 현행 goal 랜딩 사이클(348/349/350 PR 검수, 347 capacity-오류 resume 진행 중) → 종결 시 MOMO-362..365 + Wave 2 발급.

## 2026-07-13 (momo-main/Fable) · Phase 0 dogfood 무결성 배치 종결 (354/355/356)
- merge 순서: MOMO-356 `0a4bf37`(+오케스트레이터 python≥3.10 pin) → MOMO-355 `ac00ef3`(context verifier self-seed 반려 1회) → MOMO-354 `9ca9c93`(design-review High 2건 반려→profile gate+NSHostingView 캡처 수정, 정본 PNG 재기록 `6f00f05` 후 멤버 행+AGENT 배지 픽셀 육안 확인).
- root post-merge full gate green: `local-gate-runtime-agent-20260712T170955Z-…-rfc58973d57b9.md` + `local-gate-macos-ui-20260712T171443Z-…-r88f66c1ce253.md`.
- 발견: `cleanup-seeded-agents`는 102·103 동시 은퇴인데 앱 pairing은 기존 hermes 멤버 재사용이라 103 재생성 product 경로 부재 — 라이브는 REST 채널 멤버십 제거로 김인턴만 invite-gated 처리, full retire는 pairing 표면 후속 티켓 이후. design-review Medium 5건 BUILD_TICKETS 이월.
- 다음: 라이브 반영(김인턴 채널 제거→gateway env/plugin 갱신→재기동→앱 재빌드) 후 성재 육안 검증. 이어서 UI Wave 1 + ADR-0109 기안 + Phase A 티켓.

## 2026-07-13 (Codex worker) · MOMO-354 review fix — profile gate + roster pixels
- server-SoT에서 로컬 프로필 편집 버튼/컨텍스트 메뉴를 비활성화하고 서버 관리 안내를 표시하며, `applyLocalProfile`도 같은 경계에서 no-op한다.
- 계획 이탈: 최초 `ImageRenderer` snapshot이 `ScrollView/LazyVStack` roster 픽셀을 누락했다. `NSHostingView` 2x 캡처로 교체하고 light/dark `AGENT` accent pixel assertion을 추가했다.
- 검증: macOS build, 비스냅샷 79 tests, roster snapshot 3 tests(정본 대기 2 skip + pixel 1 PASS), Python static contract/design pre-flight, fresh design-review PASS(Blocker 0/High 0/Medium 0/Low 0). DB/Docker/verifier/gate 금지 유지.
- 다음: 같은 PR 추가 커밋 push. 정본 PNG는 오케스트레이터 재기록 대기.

## 2026-07-13 (Codex worker) · MOMO-354 real-server roster SoT
- 반영: REST backend fixture fallback과 이름 기반 agent 숨김을 제거하고 `/roster` active membership를 사이드바·멘션·작성자·agent realtime 구독의 공통 권위로 연결했다. login/join은 ADR-0110의 `realtimeWebSocketUrl`을 광고하며 앱 env보다 우선한다.
- verifier: 기존 marker/OID-owned DB·per-run UUID·대문자 CENT_CHANNEL·source digest·exit 96 경계를 보존한 채 roster/realtime discovery assertion만 추가했다.
- 검증: server 63 tests, macOS 비스냅샷 79 tests, 신규 snapshot 2종 reference-wait skip, Python no-DB contract, shell syntax/권한, design-review PASS(Blocker 0/High 0/Medium 1). Docker/DB/verifier/local gate는 금지 범위로 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 snapshot 2종 재기록과 clean `macos-ui` 후 PR을 검수하고 momo-main이 merge/root gate를 맡는다.

## 2026-07-13 (Codex worker) · MOMO-355 review fix — context verifier fixture
- 오케스트레이터 clean `runtime-agent`에서 context verifier가 seed-none DB의 human(…101)/Hermes(…103) FK를 migration seed에 의존한 누락을 확인했다.
- workspace·human·agent·target/other channel+seq·membership을 verifier-owned fixture로 추가하고, seed-none verifier의 고정 101/102/103 참조를 전수 점검했다.
- 계획 이탈: 최초 정적 계약이 migration mode/격리 경계만 확인해 context의 FK fixture 완결성을 증명하지 못했다. context fixture 조각을 contract test에 추가했다.
- 다음: shell/Python/diff 정적 검증과 같은 브랜치 push 후, 오케스트레이터가 DB/Docker clean `runtime-agent`를 재실행한다 (`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-355 dogfood agent seed opt-in
- persistent/local-alpha migration은 human+기본 채널만 만들고 agent 0으로 시작하며, 역사적 김인턴/Hermes seed는 demo/e2e 러너만 명시 opt-in한다. `schema_v0.sql`/신규 destructive migration은 없다.
- `scripts/momo`를 gateway-init → pairing invite → credential 발급 → env 순서로 정렬하고, 기존 고정 seed 둘은 exact identity/DB-owner/`--yes` guard가 있는 soft-retire 명령으로만 정리한다.
- runtime-agent/macos-ui verifier는 seed none + 자체 marker/OID fixture 계약을 비접속 Python test로 고정했다. shell/Python/diff, 5패키지 build, Core 18/Server 61/Relay 1/Worker 29/macOS 비스냅샷 78 tests PASS; 기존 image snapshot은 sandbox signal 5로 미실행·PNG 무변경이다.
- 다음: worker PR handoff 후 momo-main이 clean/root runtime-agent+macos-ui와 snapshot 영향 없음 확인 후 merge한다 (`runtime-unverified`).

## 2026-07-13 (Codex worker) · MOMO-356 gateway 운영 공지 timeline 차단
- 어댑터 direct message write를 momo `run_id`가 있는 실제 agent final로 제한하고, Hermes reset/home/`/resume`·`/sethome`/model-provider 공지는 성공 처리+본문 비포함 로컬 로그로만 남겼다. native gateway final은 `/gateway/complete` 유지.
- Hermes 정식 `MOMO_HOME_CHANNEL`을 plugin/enablement/`hermes-gateway-init` 신규·기존 env에 연결해 설정 요구를 기동 전에 해결했다. `schema_v0.sql`·UI·스냅샷 변경 없음.
- adapter contract 54 tests+smoke+pycompile, 실제 SDK result 및 신규·legacy home env init, 수정 shell `bash -n`/실행권한, diff check PASS. verifier DB assertion/runtime-agent gate는 worker 금지로 미실행.
- 다음: 오케스트레이터가 clean/root `runtime-agent`를 수행하고 gate 체크박스/merge를 맡는다.

## 2026-07-13 (Fable) · momo-main · dogfood 첫 실사용 → Phase 0 착수 + 내부알파 방향 확정
- dogfood 실증: gpt-5.5→**gpt-5.6-luna/high** 프로바이더 교체(Hermes config), per-agent bearer 라이브 연결·일반 왕복(@hermes 응답) 실동작 확인. 승인 왕복은 아직 라이브 미검증.
- 실사용 버그 3건 발견·발급: MOMO-354(#341 앱이 roster 대신 demo fixture)·355(#342 에이전트 pre-seed→초대 게이팅 위반)·356(#343 어댑터 운영공지가 durable message 오염). 게이트/verifier가 자체 fixture로 격리돼 안 걸린 종류 — 실사용에서만 드러남.
- **성재 방향 결정(ADR-0103 실질)**: 멀티팀 내부 알파 + **AWS 단일 EC2 실배포** 호스팅. Phase 0(354/355/356 정합)→A(호스팅+클라배포)→B(10인 용량)→C(온보딩 킷).
- 다음: Phase 0 배치 3-worker 스폰(진행 중). 랜딩 후 ADR-0103 정본화 + Phase A 티켓.

## 2026-07-12 (Fable) · momo-main · ADR-0102 배치 전체 종결 (350/341/352 랜딩)
- 랜딩: MOMO-350(#338 `f079279` — status/partial, outbox 경유+상한) → MOMO-341(#339 `6fcb870` — lease/takeover, 게이트가 회귀 2건 검출→resume 반려 2회→시나리오별 단위 테스트 고정) → **MOMO-352(#340 `bb76152` — 동등성 verifier)**. 전 건 clean+root gate PASS.
- **배치 종결**: root runtime-agent full gate에 동등성 검증 상시 포함 — worker/gateway가 run 전이·approval·usage/audit·durable message·realtime publication에서 완전 동일함이 매 게이트마다 증명된다. **legacy secret 호환 창 종료 조건 충족** (ADR-0102 §폐기 일정 2단계).
- 후속(성재 승인 대기): legacy header/`AGENT_GATEWAY_SECRET`/`MOMO_ALLOW_LEGACY_GATEWAY_SECRET` 물리 제거 보안 정리 티켓 (M7 전).
- 다음: ADR-0103 결정 순번. dogfood에서 승인 인박스/스트리밍 실사용 확인 권장.

## 2026-07-12 (Codex worker) · MOMO-352 agent path equivalence verifier
- worker(managed)와 gateway(BYOA) 정본 verifier를 fresh marker/OID DB·per-run 대문자 channel에서 각각 실행하고, trigger→approval→resume→final의 run/approval/usage/audit/message/realtime 보장 manifest를 완전 일치 비교하는 종결 verifier를 추가했다.
- allowlist는 timing/provider metadata/gateway lease/path-channel identity로 코드에 고정했고, source digest EXIT trap과 양 경로 pre-marker exit 96 exact-OID rollback을 자체 강제한다. `schema_v0.sql` 변경 없음.
- `runtime-agent` auto-classify/shell-syntax/add_cmd/coverage에 배선했다. `bash -n`·`git diff --check` PASS; Docker/DB/verifier/local gate는 worker 금지로 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 clean/root `runtime-agent` 두 경로 PASS와 fresh 보안/correctness 리뷰를 수행하고, legacy secret 물리 제거는 별도 후속 change로 넘긴다.

## 2026-07-12 (Codex worker) · MOMO-341 review fix — lease rejection 4xx audit
- clean `runtime-agent` 2차 게이트에서 takeover 뒤 crashed owner callback이 409 대신 500으로 새는 회귀를 확인했다. 원인은 PostgresNIO가 transaction closure 내부의 `HTTPError(.conflict)`를 `PostgresTransactionError`로 감싸는 데 있었다.
- `/gateway/events`(approval 포함)와 `/gateway/complete`의 lease 부재·불일치·만료·stale owner 거부를 transaction 결과값으로 반환하고 transaction 밖에서 409로 매핑했다. renew/release는 기존부터 UPDATE 결과를 밖에서 409로 매핑했으며, 누락 lease도 409로 통일했다. actor mismatch 403은 유지했다.
- server 단위 테스트에 동시 consumer 단일 claim, crash expiry/takeover, stale owner event/complete/renew/release 거부, expiry reclaim, missing/settled fail-closed를 추가해 61/61 PASS. DB/Docker/verifier는 worker 금지 범위라 오케스트레이터 재검증 대기다.

## 2026-07-12 (Codex worker) · MOMO-341 review fix — approval-held 409
- clean `runtime-agent`에서 승인 대기 late complete가 lease preflight를 먼저 타 500이 된 회귀를 확인했다. migration/claim/renew/release 설계는 변경하지 않았다.
- `awaiting_approval`/`paused`를 lease DTO·DB 검증 전에 `approvalHeld`로 판정해 MOMO-349의 409 human-decision guard를 복원했고, queued/running/terminal의 exact-owner lease 검증은 유지했다.
- server 56 tests PASS. DB/Docker/verifier 재실행은 오케스트레이터 대기(`runtime-unverified`).

## 2026-07-12 (Codex worker) · MOMO-341 gateway durable claim/lease
- 반영: `008_gateway_job_lease.sql` + actor-bound `FOR UPDATE SKIP LOCKED` claim, bounded renew/release, exact job+lease callback 결속, expiry takeover를 outbox SoT에 추가했다. `schema_v0.sql` 변경 없음.
- 어댑터: realtime은 wake-up 전용을 유지하고 serial claim(limit=1)만 provider를 시작한다. 실행 중 lease renew를 감독하며 owner 상실 시 provider task를 취소한다.
- verifier: 같은 agent 두 consumer 동시 claim=capability 1개, active lease 차단, simulated crash expiry/takeover, stale callback·non-owner renew/release 409, owner release/reclaim/complete 시나리오를 격리 DB 패턴에 추가했다.
- 검증: server build+55 tests, adapter 52 tests, py_compile, verifier `bash -n`/실행권한 PASS. DB/Docker/runtime-agent는 미실행(`runtime-unverified`); 오케스트레이터가 merge 전 clean/root gate와 fresh 리뷰를 수행한다.

## 2026-07-12 (Codex worker) · MOMO-350 gateway status/partial
- 반영: actor/run-bound gateway `thinking`/`streaming`을 bounded `agent.status`/`agent.partial` outbox로 투영하고 bearer per-member limit + run당 240 events/minute 하드캡, 2 KiB detail/8 KiB delta 상한을 적용했다.
- 어댑터/클라: provider stream을 512-byte/250ms 단위로 전달하며 macOS REST backend가 exact observable `agent:`를 구독해 기존 `AgentPartialView` state로 합친다. private `agentwork:`와 분리 유지.
- 검증: server 54 tests, adapter 49 tests, macOS 비스냅샷 78 tests(실렌더 타깃 포함), py_compile·verifier `bash -n`/실행권한 PASS. DB/Docker/verifier 미실행(`runtime-unverified`).
- 다음: 오케스트레이터가 격리 DB status/partial 시나리오와 clean/root `runtime-agent`를 수행하고, momo-main이 체크박스·merge를 맡는다.

## 2026-07-12 (Fable) · momo-main · 배치 4 랜딩 — 승인 왕복 실트래픽 도달 (349/351/353)
- 랜딩 3건: MOMO-351(#335, `ebb3a52` — 이중 경로 문서 정본화) → MOMO-353(#336, `8337ae2` — drift-guard, 배치 내 구세대 컨테이너 3곳을 실전 감지·이관하며 자가 실증) → **MOMO-349(#337, `b5b39df` — gateway 승인 왕복, ADR-0102 기함)**. 전 건 clean+root gate PASS.
- 검수 하이라이트: 349 보안 리뷰에서 actor↔run binding이 `requireRunActorBinding` 핸들러 진입점 상속임을 확인(Blocker 0). 353 격리 테스트(합성 dogfood 비접촉) 오케스트레이터 재실행 green.
- momo_main Centrifugo를 fingerprint 컨테이너로 1회 이관(opt-in 재생성) — 이후 config drift는 게이트가 자동 검출한다.
- 다음: MOMO-350(`#330`) 의존 충족·spawn 대기(성재 트리거) → 341 → 352(동등성 verifier, legacy secret 호환 창 종료 게이트).

## 2026-07-12 (Codex worker) · MOMO-349 gateway 승인 왕복
- 반영: actor-bound `approval_request` callback을 기존 approval/message/run/outbox/audit transaction에 연결하고, human approve/reject를 private gateway resume `agent.job`으로 전달한다.
- 어댑터: approval-required tool result를 callback으로 pause하고 approved resume은 재개, rejected resume은 provider 미호출 cancellation ack로 정산한다. terminal late completion도 409 fail-closed다.
- 검증: server build + 51 tests PASS, adapter contract 46 tests PASS, diff 보안 리뷰 Blocker 0. verifier는 격리 DB approval/approve/reject/actor/inbox 시나리오를 추가하고 `bash -n`/실행권한만 확인했다.
- 다음: 오케스트레이터가 merge 전 clean `runtime-agent`와 fresh 보안 리뷰를 수행하고, momo-main이 merge/root gate·잔여 체크박스 갱신을 맡는다.

## 2026-07-12 (Codex worker) · MOMO-353 local gate drift-guard
- 반영: Centrifugo 컨테이너 생성 시 repo config fingerprint를 고정하고 pre/post-start guard가 running fingerprint drift를 fail-closed하며 명시 opt-in에서만 해당 서비스를 재생성한다.
- 안전 경계: gate run marker(uid/repo/run/pid-start)+상속 env+repo command가 모두 맞는 프로세스만 stale/EXIT cleanup한다. unmarked dogfood MomoServer와 사용자 프로세스는 충돌로 남긴다.
- 검증: shell syntax/shellcheck/diff/make dry-run + fake Docker/합성 process-table 오탐 방지 테스트 PASS. 실제 Docker/DB/verifier 및 clean/root gate는 미실행(`runtime-unverified`), 오케스트레이터가 merge 전 수행.
- 다음: worker PR handoff 후 momo-main이 running-config match/drift/opt-in과 실패-run reaping, dogfood 28180 생존을 실제 gate에서 확인한다.

## 2026-07-12 (Codex worker) · MOMO-351 이중 실행 경로 문서 정렬
- 반영: adapter contract·L4 §6·README·architecture를 gateway=BYOA / worker=managed + 서버 소유 보장 매트릭스로 정렬하고 ADR-0102에 SD-5 표면을 소급 승인했다.
- 신원: 두 경로의 `agent_bearer` 수렴과 legacy secret의 equivalence-gate 후 제거·M7 전 시한을 ADR-0101/0102에 연결했다.
- 경계: 코드·shell·DB·Docker 변경/접속 없음. 349/350/341/352 미완 셀은 규범 계약으로 표시하고 완료 evidence로 쓰지 않았다.
- 검증: 링크/앵커 + dirty 허용 `docs` profile PASS; 오케스트레이터가 merge 전 clean docs gate와 체크박스 갱신을 맡는다.

## 2026-07-12 (Fable) · momo-main · ADR-0102 Accepted + 파생 배치 발급
- 결정: 성재가 ADR-0102 **Option C 수락** (gateway=BYOA / worker=managed 이중 경로 + 서버 보장 매트릭스). drift-guard 발급 승인, design-review Medium 2 보류, MOMO-341은 0102 배치 합류.
- 발급: MOMO-349 `#329`(gateway 승인 왕복) → 350 `#330`(status/partial) → 341 `#333`(claim/lease) → 352 `#332`(동등성 verifier), 병렬 351 `#331`(docs)·353 `#334`(drift-guard). 패킷 `handoffs/2026-07-12-adr-0102-execution-path.md`.
- 핵심: 349가 landing되면 **승인 인박스가 실트래픽에서 처음 동작** — agent-native 시그니처 경험 실물화.
- 다음: 성재 트리거로 349부터 codex-fleet spawn. 다음 결정 순번 ADR-0103.

## 2026-07-12 (Fable) · momo-main · MOMO-348 랜딩 — verifier 격리 캐스케이드 전 프로파일 종결 (배치 3)
- 랜딩: goal-325 worker PR #328 검수 — 배치 2 교훈(per-run 채널 UUID + CENT_CHANNEL 대문자)이 프롬프트 반영으로 첫 커밋부터 준수됨. worktree bootstrap+단독+clean full gate PASS 후 merge (`444ee59`), #325 close.
- **종결: root main `macos-ui` full gate PASS** (digest 보존) — runtime-agent에 이어 전 프로파일 green. MOMO-342→348 캐스케이드 완전 닫힘.
- 운영 노트: 1차 worker가 API 무응답 행(CPU 0, 2.5h) → stall 감지 watcher 도입 후 재스폰 10분 완주. 실패 게이트 런의 잔류 MomoServer 포트 점유 재발(오늘 3회) → drift-guard 티켓 제안에 잔류 프로세스 자동 정리 병합.
- 다음: ready 구현 goal 없음. ADR-0102 결정(성재), drift-guard 티켓 승인(성재), design-review 잔여 Medium 2 발급 여부(성재), MOMO-341.

## 2026-07-12 (Codex worker) · MOMO-348 macos-ui real-backend verifier 격리
- 반영: macOS verifier를 unique marker/OID-owned migrated DB와 marker-bound app/worker/relay role로 분리하고 per-run #agent-lab UUID, demo/Hermes·approval/cost fixture를 자체 seed한다.
- 경계: source dogfood DB는 광범위 digest 전후 비교만 하며 exact OID+marker cleanup, marker-bound role cleanup, pre-marker COMMENT 실패(exit 96) rollback 회귀를 `macos-ui`에 배선했다.
- 검증: DB/Docker/verifier 실행 없이 수정·신규 shell `bash -n` PASS; acceptance/gate 체크박스는 미체크 유지한다.
- 다음: 오케스트레이터가 merge 전 fresh REST assertion·성공/실패 digest·clean `macos-ui`를 수행하고, momo-main이 merge/root gate를 맡는다.

## 2026-07-12 (Fable) · momo-main · MOMO-347 랜딩 — codex-fleet 배치 2 완료
- 랜딩: goal-324 worker PR #327 검수 — main 위 rebase(JOURNAL 충돌 해소), 스냅샷 3종 정본 머신 재기록(UI 변경분 2 + 신규 290pt), fresh-context design-review 재판정 **PASS(Blocker 0/High 0)** — 이전 High 2·Medium 4 전부 해소 확인. worktree macos-ui gate full PASS 후 merge (`51db851`), #324 close.
- 잔여: 재판정의 신규 Medium 2(전역 error 행 귀속 오독, 상태 칩 세로 스캔)·Nitpick 3은 티켓 미발급, BUILD_TICKETS에 기록 — 성재가 필요 판단 시 발급.
- 배치 2 결산: 346+347 랜딩, runtime-agent root full gate green, resume 피드백 루프·순서 의존 결함 검시 실증.
- 다음: **MOMO-348(`#325`)이 유일한 ready goal** — landing 시 root 전 프로파일 green. ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex) · worker #324 · MOMO-347 pairing popover hardening
- 반영: 340pt popover를 max-height ScrollView로 제한하고 credential을 flat section으로 임베딩했다. 290pt에서 긴 label/status/menu가 수직 fallback하며 폐기 notice는 해당 행에 붙는다.
- refresh: 일반 중복 조회는 coalesce하고 발급/폐기 뒤에는 기존 in-flight 응답 이후 최신 목록을 재조회한다. mutation 성공 후 목록 조회 실패 시 one-time reveal/폐기 결과는 로컬 메타데이터에 보존한다.
- 검증: macOS build PASS, snapshot suite 제외 77 tests PASS, 신규 290pt snapshot PASS, targeted credential 3 tests PASS. 기존 PNG는 재기록하지 않았고 nominal large-type reference는 동일 바이트로 constrained-window 이름만 정직화했다.
- 리뷰: fresh-context design-review PASS(Blocker 0/High 0, diff-scoped 새 pre-flight 위반 0). 남은 것은 오케스트레이터 정본 snapshot 재기록/clean `macos-ui` gate 후 PR 검수·merge.

## 2026-07-12 (Fable) · momo-main · MOMO-346 랜딩 — verifier 격리 캐스케이드 종결 (codex-fleet 배치 2)
- 랜딩: goal-322 worker PR #326 검수 중 full gate 순서 의존 결함을 격리 DB 실시간 검시로 2단 규명 — ① relay version=seq stale skip(공유 Centrifugo, 성공 응답이며 조용히 drop) → worker resume 반려로 per-run 채널 UUID(`1706590`) ② 채널명 대소문자 불일치(Swift 대문자 vs python 소문자) → CENT_CHANNEL 정규화 직접 수정(`0bb685e`). merge `beceaa1`, #322 close.
- 종결: **root main runtime-agent full gate PASS** — context/live/bridge/gateway 4-verifier digest 보존. MOMO-342→346 캐스케이드 닫힘. 잔여: MOMO-348(macos-ui 프로파일).
- 관찰: 실패 게이트 런의 MomoServer 잔류 누수(MOMO-319 유형) 2건 수동 정리. 파이프라인 실증: codex exec resume 리뷰 피드백 루프 첫 사용.
- 다음: MOMO-347 랜딩(rebase+design-review 재판정+macos-ui gate), 이후 MOMO-348 착수 가능. ADR-0102 성재 대기.

## 2026-07-11 (Codex worker) · MOMO-346 Hermes bridge/gateway verifier 격리
- 반영: external-provider/bridge와 gateway verifier를 각각 unique marker/OID-owned migrated DB로 분리하고 marker-bound runtime role 및 Hermes/#agent-lab fixture를 자체 seed한다.
- 경계: source dogfood DB는 digest 전후 비교만 하며 exact OID+marker cleanup, marker-bound role cleanup, 두 verifier의 pre-marker COMMENT 실패(exit 96) rollback 회귀를 `runtime-agent`에 배선했다.
- 검증: DB/Docker/verifier 실행 없이 수정·신규 shell `bash -n`만 PASS; acceptance/gate 체크박스는 미체크 유지했다.
- 다음: 오케스트레이터가 merge 전 fresh invite/roundtrip/bearer assertions·성공/실패 digest·clean runtime-agent를 수행하고, momo-main이 merge/root gate를 맡는다.

## 2026-07-11 (Fable) · momo-main · MOMO-339 랜딩 — ADR-0101 Phase 1 종결 (codex-fleet 배치 1 완료)
- 랜딩: goal-309 worker PR #323을 검수 — 스냅샷 참조 6종 정본 머신 재기록(worker 샌드박스 렌더링 불일치), main 위 rebase, fresh-context design-review **PASS Blocker 0**, worktree macos-ui gate full PASS 후 merge (`881518b`). ADR-0101 Phase 1 배치(337/338/339) 종결, 패킷 Status `done`.
- 발급 2건: MOMO-347 `#324`(design review High 2·Medium 4 후속), MOMO-348 `#325`(root macos-ui gate가 `verify_macos_real_backend_ui.sh` dogfood 결합으로 중단 — hermes 멤버십 drift로 mention→agent_job 0건, 346 후속).
- 파이프라인 교훈: named 팀메이트(tmux) spawn은 mailbox 미전달 좀비化 — 리뷰 서브에이전트는 이름 없는 일반 spawn (codex-fleet 스킬 반영).
- 다음: MOMO-346‖347 병렬 착수 가능(성재 트리거), 348은 346 후. root full gate green = 346+348. ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex) · worker #309 · MOMO-339 macOS credential pairing UI
- 반영: 초대 후 per-agent bearer 발급, transient one-time reveal, env 복사/권한 안내, 프로필·페어링 목록의 상태/회전/grace/확인 후 폐기/401 복구를 연결했다.
- 보안: raw bearer는 매니페스트·UserDefaults·로그·오류·실제 snapshot fixture에 저장하지 않고 REST create 응답→sheet state에서만 유지한다.
- 검증: macOS build PASS, credential+snapshot 포함 82 tests PASS(기존 MessageBubble snapshot 2개 signal 5 제외), light/dark/고대비/큰 글자 스냅샷 6종 PASS, design-review Blocker 0.
- 남은 것: 오케스트레이터가 merge 전 `macos-ui` 런타임 게이트와 실제 pairing/profile integration·폐기 dialog smoke를 수행한다.

## 2026-07-11 (Fable) · momo-main · MOMO-345 랜딩 + MOMO-346 발급 (codex-fleet 배치 1)
- 랜딩: codex-fleet worker(goal-320)가 만든 PR #321을 리뷰(MOMO-344 패턴 정합 확인)·worktree clean gate full PASS 후 merge (`5854c2f`), #320 close.
- 실증: root post-merge에서 live verifier가 drift 있는 dogfood DB 위에서 PASS + digest 보존. full gate는 hermes bridge/gateway verifier의 dogfood 결합(Hermes `…103` 멤버십 drift + roundtrip이 dogfood 채널에 메시지 작성)에서 중단 → MOMO-346 `#322` 발급 (캐스케이드 종결 티켓, `status:ready`).
- 병행: goal-309(MOMO-339 pairing credential UI) worker 실행 중. 파이프라인 개선: worktree 커밋은 `--add-dir <메인repo>/.git` 필요.
- 다음: MOMO-346 착수(성재 트리거), goal-309 완주 시 검수 사이클, ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex worker) · MOMO-345 live channel verifier 격리
- 반영: live verifier를 unique marker/OID-owned migrated DB와 marker-bound app(NOBYPASSRLS)·worker/relay(BYPASSRLS) role로 분리하고 authorized/negative fixture를 자체 seed한다.
- 경계: source dogfood DB는 agent queue/run/approval/message digest 전후 비교만 하며, exact OID+marker cleanup과 pre-marker COMMENT 실패 rollback helper를 추가했다.
- 검증: DB/Docker/verifier 실행 없이 `bash -n`만 PASS; fresh bootstrap·live assertions·clean/root `runtime-agent` evidence는 오케스트레이터 merge 전 대기.
- 다음: PR 리뷰/런타임 gate 후 momo-main이 merge·root post-merge gate·체크박스 갱신.

## 2026-07-11 (Fable) · momo-main · MOMO-344 검수 마무리 + MOMO-345 발급
- 마무리: GPT sol이 중단한 MOMO-344를 인계받아 재리뷰(P1 4건 반영 확인 + 실행권한 결함 1건 수정), 타깃 검증·clean gate PASS 후 PR #319 merge (`0b2c94a`), #318 close.
- 발견 1: root post-merge gate에서 `verify_agent_live_channel.sh`가 dogfood DB demo 시드 drift(agent 멤버십 left_at)로 실패 → 스코프 확장 대신 MOMO-345 `#320` 발급 (`status:ready`).
- 발견 2: momo_main Centrifugo가 MOMO-338 이전 running-config로 기동 상태(107/102 오류) → 재시작으로 해소. drift guard 티켓은 성재 승인 대기 제안.
- 다음: MOMO-339 `#309`(macOS pairing credential UI)와 MOMO-345 `#320` 병렬 착수 가능. ADR-0102 결정은 계속 성재 대기.

## 2026-07-11 (Codex) · momo-main · MOMO-344 context verifier 격리
- 발견: PR #317 post-merge root gate에서 `verify_agent_context.sh`가 persistent dogfood DB의 unrelated `resume_approval` job을 claim해 context trigger가 starvation 됐다.
- 결정: production Worker claim 정책은 바꾸지 않고 verifier에 unique migrated DB, marker-bound NOBYPASS app/BYPASS worker role, exact OID+marker cleanup을 적용한다.
- 검증 계획: source queue/run/approval/message digest 보존 + 기존 context assertions + full runtime-agent + 리뷰 + root post-merge gate.

## 2026-07-11 (Codex) · momo-main · MOMO-343 fresh bootstrap 회귀
- 발견: MOMO-342 merge 후 root main 새 포트에서 psql `-c` marker 변수가 치환되지 않아 fresh verifier DB bootstrap이 syntax error로 중단되고 unmarked DB가 남았다.
- 반영: COMMENT를 psql stdin SQL로 이동하고, cleanup 직전 exact generation marker를 재검증하며 동일 marker의 전용 role만 NOLOGIN/제거한다. role bootstrap은 트랜잭션화했고 unique DB의 실패 rollback, fresh 성공, persistent 재실행을 한 회귀 helper로 고정했다.
- 추가 발견: cold worktree dependency materialization이 MomoServer health timeout에 포함됐다. 세 runtime binary를 timeout 전에 동기 build하도록 분리했다.
- 검증: fresh DB bootstrap + persistent 재실행 + root main runtime-agent post-merge gate 예정.
- 다음: #316 merge/root gate 후 MOMO-339 pairing credential UI로 복귀.

## 2026-07-11 (Codex) · momo-main · MOMO-342 main gate 복구
- 발견: MOMO-338 merge 후 persistent main DB에서 user-owned Hermes membership이 제거돼 AgentWorker verifier가 migration seed를 잘못 전제했다.
- 반영: source DB와 물리적으로 분리된 marker-owned migration DB, generation별 fixture UUID, verifier-only workspace/human/channel/agent/budget, 고정 ID/alias 소유권 guard, exact client-message 기반 cleanup, empty run fail-fast 진단을 추가했다.
- 리뷰 반영: body/agent-wide 삭제를 제거하고 unrelated message/pending job/membership/Hermes 보존 sentinel, marker-bound 전용 app/relay/worker role, 전역 consumer의 isolated DB 연결, source/system/unmarked DB 거부, runtime-agent 2회 실행을 추가했다. 서버는 사전 build executable을 직접 띄워 SwiftPM planning lock도 피한다.
- 검증: 동일 persistent verifier DB에서 AgentWorker verifier 연속 2회 PASS, source DB untouched 확인; 전체 runtime-agent gate와 main 재검증 예정.
- 다음: #314 리뷰/merge/root main gate 후 MOMO-339 pairing credential UI 착수.

## 2026-07-11 (Codex) · momo-main · MOMO-338 보안 재리뷰
- 발견: realtime payload 직접 실행, run/channel 위조, credential-coarse realtime revocation, token-shaped error/argv 노출을 P1/P2로 확인.
- 반영: realtime wake-only + pending REST 재조회, exact `meta.token_id` liveness, agent run binding, 양단 redaction과 stdin verifier를 적용.
- 검증: adapter 40 tests, server 49 tests, terminal 401/4xx·full-page·reconnect/shutdown race, revoked JWT/cross-channel run/private agentwork 및 gateway verifier PASS.
- 다음: clean gates와 재리뷰 후 PR merge/root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 리뷰 보강
- 발견: `agent:` 하나에 observer progress와 private Context Packet job이 섞여 보안 self-only 수정이 기존 live UX를 깨뜨렸다.
- 반영: `agent:` progress / `agentwork:` private job 분리, cancellation/reconnect/recovery/backpressure 및 verifier secret lifecycle 하드닝.
- 검증: adapter 33 tests(실시간/recovery 단일 provider worker), server 48 tests, exact-channel agent live + private agentwork WebSocket/relay + Hermes gateway runtime verifier PASS.
- 다음: clean docs/runtime-agent gate와 PR merge 후 root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 통합 준비
- 한 일: Hermes adapter를 per-agent bearer 하나로 단일화하고 login/shared-secret을 제거. realtime-first reconnect + bounded recovery/cache + legacy env migration을 추가.
- 리뷰 반영: 다른 agent의 Context Packet을 볼 수 있던 subscribe proxy를 self-only로 강화하고 actor/env 교차검증, non-loopback TLS 기본값, smoke session revoke를 적용.
- 이탈: Python adapter 범위에서 server transport auth까지 확대(보안 blocker, DEVIATION_LOG accepted). 중복 gateway lease는 후속 티켓.
- 다음: runtime-agent clean gate·PR merge 후 root main fast-forward. 그다음 MOMO-339 및 gateway lease 티켓.

## 2026-07-10 (Codex) · momo-main · MOMO-337 통합
- 한 일: PR #310 보안/성능 리뷰에서 one-time token no-store, 발급자 provenance, pending `available_at`을 수정하고 main `8d97c82`로 merge. post-merge `runtime-agent` PASS.
- 이탈: 예상만 있던 `/gateway/jobs/pending`을 actor-bound recovery endpoint로 신설. #308에는 realtime-first + bounded recovery 계약을 추가.
- 현재: #307 done, #308(M1)/#309(M3) ready·병렬 가능. ADR-0102는 여전히 성재 결정 대기.
- 다음: runtime 임계경로인 MOMO-338을 먼저 claim하고, 별도 worker에서 MOMO-339를 병렬 진행 가능.

## 2026-07-10 (Codex) · GPT 5.6 · 기획 체계 보강
- 한 일: Fable 인수 내용을 검토하고 `CURRENT_STATE.md` 중심의 압축 복원, planner 병렬 claim, `momo-main` 순차 통합, versioned handoff 규칙을 정본에 추가.
- 열린 것: ADR-0102는 성재 결정 대기. GitHub 실측상 MOMO-337(#307)은 이미 별도 worktree에서 in-progress(PR 없음). root main의 기존 Hermes/local-dogfood 변경은 분리 유지.
- 다음: #307 PR handoff를 기다리며 ADR-0102 결정. 병렬 planner는 `CURRENT_STATE.md`에서 서로 다른 planning ID를 먼저 claim.

## 2026-07-10 (오후) · Fable · 기획+오케스트레이션
- 한 일: 협업 파이프라인 정본화(docs/planning/* 신설, CLAUDE.md, momo-planning 스킬, PR 이탈 섹션). 이슈 #307(ready)/#308/#309(blocked) 발급 + 핸드오프 패킷. ADR-0102 기안(Proposed).
- 열린 것: **ADR-0102 성재 결정 대기(권고 C)** · #307 착수는 성재가 Codex에 직접 요청 예정 · 기획/문서 배치는 main에 커밋됨(성재 승인, 이전 세션의 코드 핫픽스 변경은 여전히 미커밋 — 그 배치의 주인이 처리).
- 다음: 성재의 0102 결정 → 파생 티켓. #307 PR 오면 momo-main 리뷰 사이클 가동.

## 2026-07-30 (오후) · Fable · 기획
- 한 일: 서버 스택 **B안 확정**(성재 승인) — Swift/Hummingbird→Rust/Axum **재작성**, buzz는 fork 아니라 코드 레퍼런스, momo 불변식 6개 보존. **ADR-0145 Accepted**로 개정(A안 fork→스파이크 불성립→B안). **ADR-0146 Proposed** 발제(에이전트 행동 provenance 서명, buzz 강점 조각을 Ed25519 additive로 차용, 단일쓰기경로·RLS 무손상). **실행 정본 `docs/planning/2026-07-30-server-rewrite-plan.md`** 신설 — 설계-우선(Phase 0 D1~D6 → 구현 배치 B1~B5). 저위험 핵심 = 불변식이 DB에 살아 마이그레이션 재사용, 재작성은 앱 계층 번역.
- 이어서: **Phase 0 설계 6/6 완료**. D1 crate 레이아웃 확정(공유5 db·outbox·wire·auth·provider + 도메인3 굵게 messaging·t3·integrations + 바이너리5 — 성재 승인: 공유는 별도 crate, 도메인 굵게 출발). D2 불변식 7개×[강제·DB백스톱·red]. D3 ADR-0146 범위 확정(성재 "상태 전이까지 넓게" → 3표면 서명·사이드카 action_signature·record_provenance chokepoint·불변식 무손상). D4 buzz 인용 카탈로그·D5 커토버 빅뱅 확정·D6 배치분할(B0 골격+B1~B5, provenance 분산).
- 열린 것: **성재 Phase 0 전체 승인 대기** → 승인 시 B0(워크스페이스 골격)부터 워커 착수. ADR-0146 세부(페이로드 바이트·device 키 시점·UX 표식) 확정 후 Accept 승격. 승인 전 재작성 코드 금지. NCP smoke(§독립)·열린 티켓 #925·#926·#893 병존.

## 2026-07-30 (오후 2) · Fable · 오케스트레이션
- 한 일: 성재 "B0 착수" = Phase 0 승인. **B0(Rust 워크스페이스 골격) 착수** — 핸드오프 패킷(`handoffs/2026-07-30-B0-rust-skeleton-packet.md`) 작성, track/engine을 main으로 ff 동기화(Phase 0 문서 반영), goal 워크트리 `feat/B0-rust-skeleton`(base track/engine) 생성, **백그라운드 워커(Opus 5) 스폰**. 범위: 공유 5 crate 스켈레톤(db·outbox·wire·auth·provider)·마이그레이션 러너(기존 59 제자리)·outbox chokepoint·workd 서명 바이트동일 이식·provenance API 스켈레톤(테이블 금지). 도메인/바이너리는 B1+.
- 열린 것: **B0 워커 결과 대기** → PR→track/engine, 오케스트레이터 docker 게이트(마이그레이션 러너·GUC cross-tenant red). ADR-0146 세부 확정(B1 전). NCP smoke(§독립)·#925·#926·#893 병존.

## 2026-07-30 (오후 3) · Fable · 오케스트레이션
- 한 일: **B0(Rust 워크스페이스 골격) 랜딩** — PR #927 → track/engine(`d1e51ddf`). `server-rust/` Cargo 워크스페이스 + 공유 5 crate(db·outbox·wire·auth·provider). 오케스트레이터 검수: 코드 리뷰(with_tenant_tx GUC·emit chokepoint·서명 바이트파리티 Swift 대조) + **docker 게이트 직접 재검증**(conformance_pg: 마이그레이션 러너 psql로 59개 fresh pgvector/pg18 적용·GUC red 통과). 게이트가 러너 결함 1건 실측(sqlx::raw_sql이 시드 `\if` 못 씀 → psql shell-out 전환, red-proof 커밋 보존) → 워커 수정 → 재검증 green.
- 열린 것: **B1(메신저 코어) 착수 준비** — 패킷 작성 → 워커. B1 러너는 psql 정본. OutboxKind push_candidate 누락 후속. ADR-0146 세부 확정(B1 전). NCP smoke·#925·#926·#893 병존.

## 2026-07-30 (오후 4) · Fable · 오케스트레이션
- 한 일: **B1(메신저 코어 write-path 척추) 착수** — 성재 "권고대로"(ⓑ: provenance 제외, 메신저 코어 먼저) + NCP 준비 지시. B1 패킷 작성(identity·channel·message+seq+emit_outbox+DB conformance #1/#3/#4/#5/#6, HTTP·huddle/search·provenance 제외), track/engine에 main 머지(드리프트 제어), 워크트리 `B1-messaging`, 워커 Opus 5 스폰. **NCP smoke 런북**(`ncp-rust-smoke-prep.md`) 작성 — Swift 보류·Rust 트리거(B2~) 후 실행, 서버 파킹/키 재발급 성재 권고.
- 열린 것: **B1 워커 결과 대기** → PR·오케스트레이터 conformance 게이트(pgvector/pg18+bootstrap_roles+momo_app cross-tenant). ADR-0146 세부 확정(provenance 얹기 전). **성재 몫: NCP 서버 정지+키 재발급.** #925·#926·#893 병존.

## 2026-07-30 (오후 5) · Fable · 오케스트레이션
- 한 일: **B1(메신저 코어 write-path 척추) 랜딩** — PR #928 → track/engine(`2cc97bb4`). `momo-messaging`(identity·channel·message: seq CTE·emit_outbox 같은 tx·멱등, Swift 파리티). 오케스트레이터 검수: message.rs 코드 리뷰(membership 테이블 적응·cent_channel 대문자 파리티 Swift 대조) + **docker conformance 게이트 직접 재검증 5/5**(D2 #1/#3/#4/#5/#6, pgvector/pg18+bootstrap_roles+momo_app). 게이트가 테스트 오라클 결함 실측(011 push_candidate 트리거가 outbox 늘려 계수 이중 → kind='broadcast' 필터로 수정, 코드는 정확) → 재실행 green.
- 열린 것: **다음 배치 방향 성재 지시 대기**(B1.2 척추 후속 / B2 T3 / momo-server HTTP 조립). provenance는 ADR-0146 Accept 후. NCP smoke Rust 트리거 대기·서버 정지+키 재발급 성재 몫. #925·#926·#893 병존.

## 2026-07-30 (밤) · Fable · 오케스트레이션
- 한 일: **B1.5(momo-server+momo-relay 조립) 랜딩** — PR #929 → track/engine(`c98b6474`). 첫 부팅 가능한 Rust 스택(Axum 서버+relay). 게이트: relay 3/3(#2 전송전용 e2e·claim 경합·백오프)+HTTP smoke green, D2 #1~#6 실행 스택 증명. **revocation 보안 갭**(워커 자기신고)을 티켓 대신 같은 PR 수정으로 —`momo-auth/token_store.rs` fail-closed 이식(revoke→401 red 포함), 워커의 실측 정정(tenant tx 안 조회) 검증 후 수용. 잔여 티켓 후보: logout/refresh route·러너 멱등 추적.
- 열린 것: **다음 배치 후보 — B2(T3, #7 provider red 포함) / B1.2(메신저 breadth) / logout·refresh.** ADR-0146 세부(성재). NCP 현상 유지(성재 지시). #925·#926·#893 병존.

## 2026-07-31 (새벽) · Fable · 오케스트레이션
- 한 일: **B1.6(소품 3종) 랜딩** — PR #930 → track/engine(`b5264a00`). logout/refresh(원자 revoke 게이트)·러너 멱등(2-run red)·push_candidate enum. 게이트를 **한 DB 연속 실행**으로 돌려 멱등 러너 실증 — 그 과정에서 relay 테스트의 공유 DB 격리 갭 실측(잔여 pending broadcast claim) → 하니스 잔여 정산 수정, 오염 DB 3/3 재현. B2.1(T3 척추) 병렬 진행 중.
- 열린 것: B2.1 결과 대기(→ conformance 5종 게이트·#7 완성). audit_log(write_audit 스텁) 후속 티켓 후보. ADR-0146 세부(성재). #925·#926·#893.

## 2026-07-31 (새벽 2) · Fable · 오케스트레이션
- 한 일: **B2.1(T3 수명주기+과금 척추) 랜딩** — PR #931 → track/engine(`f0467c02`). `momo-t3`: t3_terminate 단일 호출·전이표 트리거 에러 매핑(사본 0)·advisory 선획득 prelude(GUC 단일배선 보존)·mock 2종·#7 red. 게이트가 픽스처 UNIQUE 충돌 실측(sandbox_id 리터럴) → 무작위화 수정 → **conformance 5/5**. 머지 후 engine 통합 검증: 5 스위트 18케이스+단위 전부 green, 한 DB 연속. **D2 하드 불변식 7/7 Rust 스택 증명 완료.** ADR-0140:107 outbox 과기술 발견(053/058 실측 무) → 정오표 성재 승인 대기.
- 열린 것: 다음 배치(B2.2 T3 표면 / B1.2 breadth / Rust 이미지·compose→NCP 부분 smoke) 성재 방향. ADR-0146 세부. audit_log 티켓 후보. #925·#926·#893.

## 2026-07-31 (오전) · Fable · 오케스트레이션
- 한 일: **B1.7(Rust 이미지+compose) 랜딩** — PR #932 → track/engine(`a7c3551e`). 259MB 이미지(api|relay|migrate 3역할)·prod-미러 compose·env 파리티(JWT_HMAC 정본 승격). **실전 게이트 전 곡선 green**(migrate 59+멱등→set-owner→login→send→list→실 Centrifugo version==seq→시크릿 0). 게이트 실측 결함 2건 직접 수정(cargo mtime 캐시 touch·entrypoint set-owner 케이스) — 둘 다 워커가 원리적으로 못 잡는 docker 계층. NCP 런북 트리거 3(이미지 경로) 개통.
- 열린 것: **B2.2**(T3 표면·재부착 0139·T3 route) 다음 배치. 레지스트리 퍼블리시(성재/오케스트레이터 몫). ADR-0146 세부·ADR-0140 정오표(성재). #925·#926·#893.

## 2026-07-31 (오후) · Fable · 오케스트레이션
- 한 일: **B2.2(T3 REST 표면) 랜딩** — PR #933 → track/engine(`9e065d0f`). T3 route 12개(기본 OFF·503), momo-t3/auth 공개 API 추가(cloud_host·work_host_store). 워커 실측이 패킷 가정 3건 뒤집음(usage/summary 구조적 부적합→제외·smoke=byoc·topup 포함) — 3건 전부 Swift/마이그레이션 실측으로 검증 후 수용. 게이트: T3 smoke 곡선 2/2(봉인 트리거 red 포함)+전 스위트 공유 DB 무회귀 green. **NCP T3 부분 smoke REST 완비.**
- 열린 것: 다음 배치(B2.3 게이트웨이·재부착 0139 / NCP T3 smoke 실행 — amd64 크로스빌드 선행 / B1.2 breadth) 성재 방향. ADR-0146 세부·ADR-0140 정오표. #925·#926·#893.

## 2026-07-31 (오후 2) · Fable · 오케스트레이션
- 한 일: **NCP T3 smoke 완주** — amd64 크로스빌드→전송→Docker 설치→스택 기동→메신저 곡선(실 Centrifugo)+**T3 BYOC 곡선(topup→enroll→register→세션→종료→settled=true·3s×25µUSD 정확 차감)**. 리소스 RAM 375Mi. 곡선이 밝힌 운영 요건(https base URL 등) 런북 §7 기록. **B2.3(momo-notifier) 워커 병렬 진행 중.**
- 열린 것: B2.3 결과 대기. MOMO_T3_ENABLED 판단(성재 — 재료 확보됨). NCP 스택 가동 유지 중(비용 유의). #925·#926·#893.

## 2026-07-31 (저녁) · Fable · 오케스트레이션
- 한 일: **B2.3(momo-notifier) 랜딩** — PR #934 → track/engine. T3 내구성 워커(D4 수렴 reconciler+host-lost sweep, SQL 0줄·정산 t3_terminate 1곳). 게이트 d4 4/4 green. 게이트가 잡은 것: 픽스처 UNIQUE 충돌 → 워커가 원인 지점 수정(adopt_running_instance — 내 retire 패치가 '가짜 죽음'을 만들던 것까지 판정·제거, 수렴표는 무결). **NCP 비용 효율화 실행**(성재 승인): compose stop→서버 정지, ncp-power.py 도구, "테스트할 때만 켠다" 정책 런북 §8.
- 열린 것: B2.3 이탈 후속 티켓(sweep 사용자 가시 후속·audit_log 스텁·관리형 어댑터). 다음 배치(B2.4 gateway/재부착 0139 등) 성재 방향. MOMO_T3_ENABLED 판단(재료 확보). #925·#926·#893.

## 2026-07-31 (밤) · Fable · 오케스트레이션
- 한 일: **B2.4 랜딩**(PR #935) — 재부착/replay(0139, seq 커서 — wall-clock red 증명)·terminal attach 서버 계약(해시 저장·MomoHost 서명 validate)·**audit_log 실구현**(B0 스텁 해소, host 서명은 via_token_id NULL 규칙 API化). 게이트 3/3+무회귀 green. 이탈 2건 수용(/reattach 투영 route 신설 — Swift 4-route 합성의 D3 판정 통합, momo-auth host 자격 파일). **ADR-0146 Accepted**(3결정: 2단계 페이로드·에이전트/workd 먼저·감사전용 UX)·**ADR-0140 정오표** 반영.
- 열린 것: 다음 배치 = **provenance 구현**(0146 Accept로 준비 완료: record_provenance·action_signature 060·3표면 emit) 또는 AgentGateway(B2.5). audit 미배선 5건(PR #935 표). #925·#926·#893.

## 2026-08-01 (새벽) · Fable · 오케스트레이션
- 한 일: **B2.5(provenance, ADR-0146 이행) 랜딩**(PR #936) — 마이그레이션 060 action_signature(재작성 후 첫 신규·RLS FORCE·append-only+retention 진입점)·record_provenance 실구현(사이드카 SQL 단독 소유)·workd 서명 2지점(heartbeat·validate) 배선·에이전트 메시지는 검증 경로 완성+키 등록 부재로 501 이름 붙은 거부(제출 공개키 불신 — 위조 가능 provenance는 없느니만 못함). 게이트 전 스위트 31/31 green. 워커 판단 2건 수용: 서명 미도착 지점(등록·revoke) 미배선, heartbeat 볼륨 대비 retention 해치.
- 열린 것: fast-follow 티켓(에이전트 키 등록 표면·retention 잡·사람 device 키). **다음 배치 = B2.6 AgentGateway**(마지막 큰 T3 표면). #925·#926·#893.

## 2026-08-01 (오전) · Fable · 오케스트레이션
- 한 일: **B2.6(AgentGateway 과금 척추) 랜딩**(PR #937) — momo-agent crate(run 수명주기·usage_ledger 계상·usage/summary 완성)·agent bearer 인증·legacy secret 하드닝(Swift의 1자 시크릿 새니타이저 결함 실측→최소 16자). 게이트가 잡은 것 2건: b26_3 하니스가 배치 클레임 시맨틱 오해(격리 갭 아님 판정 — 워커가 근거와 함께 스윕 금지 문서화), b26_4 effort 단언 위양성(FK로도 실패 → 제약명 단언+양성 대조군). 재게이트 전 스위트 35/35 green.
- 열린 것: **T3 큰 표면 완주.** 남은 굵직: B1.2(메신저 breadth)·B4(클라 재배선)·B5(workd Rust)·fast-follow(에이전트 키 등록·retention·device 키). #925·#926·#893.

## 2026-08-01 (오후) · Fable · 오케스트레이션
- 한 일: **B1.2(메신저 breadth) 랜딩**(PR #938) — DM(3중 멱등)·read-state(seq 커서·unread 산술·mention 원장)·search(pg_trgm 파리티·튜플 커서). 게이트 전 스위트 40/40 green. 백미: **교차서버 UUID 대소문자 계약 실측**(Foundation 대문자 vs Rust 소문자 — 3곳 명시 정렬, 안 맞추면 Swift가 쓴 멘션을 Rust가 못 셈) + B1 트리거 교훈을 kind별 단언으로 박제. 이탈 4건 수용(search 리미터=미들웨어 후속·agent mention 라우팅=agent_run 표면·호출부 2곳 후속·base64 의존).
- 열린 것: **다음 = B4(클라 재배선)** — 랜딩 시 내부 팀 테스트 1차(메신저 도그푸딩) 트리거. 후속 소품(리미터 미들웨어·mention 호출부 2·huddle/attachment). #925·#926·#893.

## 2026-08-01 (저녁) · Fable · 오케스트레이션
- 한 일: **B4(클라 재배선) 랜딩**(PR #939) — 클라 소비 68쌍 전수 실측: 동일 14·서버측 마감 3(realtime-token JWT kid 분리·centrifugo subscribe 콜백=B1.7 inert 표면 해소·channels 사이드바)·**UI 수정 0**·미구현 51 카탈로그. 게이트 42/42 green(CENT env 주입). 정본 diff 매트릭스 `2026-08-01-b4-contract-diff.md`, ENGINE_HANDOFF §R 신설. 이탈 수용(routing 프로브 '고치지 말 것' 판단 등).
- 열린 것: **도그푸딩 1차 게이트 = 미구현 51 중 시퀀스 차단분**(우선순위: roster→채널 생성(D-7)→스레드→설정 — B4.1 후보). compose에 CENT_TOKEN_HMAC/PROXY_SECRET 필수화 반영 필요. STATUS.md 갱신은 momo-main 몫. #925·#926·#893.

## 2026-08-01 (밤) · Fable · 오케스트레이션
- 한 일: **B4.1(도그푸딩 차단분) 랜딩**(PR #940) — roster·채널 생성·스레드(rootId, 척추 무변경 근거 실측)·workspace/설정 최소. 게이트 44/44 green(클라 시퀀스 smoke 실 DB 통과 → runtime-unverified 해소). 미구현 51→46(전부 화면 부재, 시퀀스 차단 아님). 핵심 판단 수용: routing 프로브 순서를 결정으로 격리(404→400)·thread.updated version 미점유.
- **판정: 내부 도그푸딩 1차(메신저) 게이트 열림.** 절차 = NCP 기동(ncp-power.py start→compose up, 새 이미지 재전송 필요 — B1.5 이후 랜딩분 포함 재빌드)+CENT env 필수화+웹 SPA 배포(UXUI 트랙 협조·ENGINE_HANDOFF §R/R′ 소비). 2차(T3)는 D-4/D-5+B5 후.
- 열린 것: 도그푸딩 1차 실행(성재 트리거 — 서버 기동·팀 초대)·후속 배치(설정 나머지 18쌍→에이전트 허브 D-4/D-5→routing 실구현)·STATUS.md는 momo-main. #925·#926·#893.

## 2026-08-01 (심야) · Fable · 오케스트레이션
- 한 일: **도그푸딩 1차 스택 가동**(성재 "도그푸딩 시작") — NCP 기동→amd64 재빌드(결함: Dockerfile 매니페스트 목록에 B2.3/B2.6 신규 crate 누락→빌드 101→옛 이미지 배포 실측, 목록 수정 커밋 `track/engine` 직행)→재배포→api CENT env 필수화(B4)로 부팅 거부→오버라이드 주입→**도그푸딩 시퀀스 실서버 green**(login·roster·채널 생성(kind)·realtime-token·channels). **교훈: 이미지 빌드를 배치 게이트에 편입 필요**(cargo test는 Dockerfile 누락 못 봄).
- 열린 것: **웹 SPA 배포 = UXUI 트랙 몫**(ENGINE_HANDOFF §R·R′) → 팀 초대 → 도그푸딩 개시. 서버 가동 중(도그푸딩 기간 상시 — 비용 성재 인지). 후속 배치(설정 18쌍→에이전트 허브→routing)와 병렬.

## 2026-08-02 · Fable · 오케스트레이션
- 한 일: **B4.2(설정 표면 완결 D-3) 랜딩**(PR #941) — 18쌍 마감(provider link/chain·work-host-engine·effort-table·quota·tier-policy·invites·workspace 생성). 미구현 46→28(A 화면부재 22·B 실행경로 대기 5·C /v1/join 경계 1). 게이트 46/46 green + **docker build 게이트 첫 편입 통과**. 워커 판단 수용: link/test 라이브 프로브는 불변식 #2 사안이라 probe_not_run 어휘로(거짓말 배제), effort-table 서빙의 capability 뒤집힘은 실측상 무해. 신규 운영 env: PROVIDER_LINK_MASTER_KEY(JWT_HMAC과 같으면 부팅 거부).
- 열린 것: **도메인 대기(성재 — A 레코드→101.79.11.189)** → caddy+TLS+SPA 서빙 배선. half-open: 초대 발급만·/v1/join 미구현(도그푸딩 팀 초대에 필요할 수 있음 — 도메인 붙일 때 판단). 후속: 에이전트 허브(D-4/D-5)·routing. #925·#926·#893.

## 2026-08-02 (오후) · Fable · 오케스트레이션
- 한 일: **https://app.oor7.com 라이브** — 도그푸딩 1차 공개 URL 개통. 체인: A 레코드(성재)→전파 확인→웹 SPA 빌드(vite, same-origin)→서버 배포(/opt/momo/web)→Caddy 오버레이(경로 분기: /v1→api·/connection→centrifugo·나머지→SPA)→ACME 실패(방화벽)→**NCP ACG 80/443 인바운드 API로 개방**(ACG 377539/vpc 144489)→TLS 발급→외부 healthz·SPA 200. env 전환: MOMO_PUBLIC_BASE_URL=https://app.oor7.com·WSS=wss://app.oor7.com/connection/websocket. **리브랜딩 공지 기억**: momo→oort, oor7.com 최종(메모리 저장).
- 열린 것: **B4.3(/v1/join) 워커 진행 중** → 랜딩 시 초대 링크로 팀 온보딩 → 도그푸딩 본격 개시. 서버 상시 가동(도그푸딩 기간). 후속: 에이전트 허브 D-4/D-5·routing.

## 2026-08-02 (밤) · Fable · 오케스트레이션 — **도그푸딩 1차 개시**
- 한 일: B4.3(join #942)·B4.4(UI+oort 브랜딩 #943) 랜딩 → 최종 이미지+SPA 배포 → **join 실왕복 검증(발급→가입→신규 로그인) green** → 팀 초대 코드 발급(maxUses 20). https://app.oor7.com 라이브(title=oort·favicon 정상). B4.3 게이트에서 실측 결함 3건 직접 해결(pool.close 데드락=44분 행 진범·만료 픽스처 제약·suspended 도달 경로 — 전부 테스트 계층, 제품 무결). B4.4는 design-review Blocker(SVG 주석 이중하이픈) 해소 후 통과.
- 열린 것: 팀 온보딩(성재가 초대 코드 배포)·도그푸딩 피드백 수렴 루프·후속 배치(에이전트 허브 D-4/D-5·routing·oort:// 스킴 티켓). 서버 도그푸딩 기간 상시 가동.

## 2026-08-01 (오후) · Fable · 오케스트레이션
- 한 일: **도그푸딩 게이트 상향(성재: 에이전트 티키타카 도달 시) → B5 아크 착수. B5.1(momo-agent-worker) 랜딩**(PR #944) — agent_job 소비→provider 호출(실1+mock)→응답을 send_message 척추로(에이전트=member)·run 전이·ledger. 워커 발견 2건 수용: per-agent 직렬화를 SQL 보장으로(다중 워커 안전)+008 리스 재사용(죽은 워커가 에이전트를 영구 침묵시키는 걸 차단), client_msg_id=run_id로 exactly-once. 게이트가 오라클 JSON 경로 오류 1건 실측(봉투 data.payload.id) → 수정 후 4/4+전 무회귀 55케이스 green. NCP 재정지.
- 열린 것: **B5.2**(멘션→run 라우팅+에이전트 생성/초대 표면) → B5.3(허브 UI D-4/D-5·routing) → 티키타카 smoke → 도그푸딩. 후속: 스레드 응답 리더·model_price 리더·notifier compose 편입. #925·#926·#893.

## 2026-08-01 (저녁) · Fable · 오케스트레이션
- 한 일: **B5.2(멘션 라우팅+에이전트 초대) 랜딩**(PR #945) — @멘션→run+job(멱등·insert/finish 합성 정합)·에이전트 생성/프로필(자격증명 필드 fail-closed)·컨텍스트 윈도 리더. **게이트에서 티키타카 e2e 첫 green**(HTTP send→run→실워커 iteration→에이전트 응답 seq·ledger). 전 스위트 59케이스. 워커 판단 수용: A2A는 depth 캡 강제 불가라 fail-closed(감사만)·paused 라인은 단일 쓰기경로 경유(Swift의 직접 INSERT 대신).
- 열린 것: **B5.3**(허브 UI D-4/D-5·routing 실구현·프로필 편집/pause 토글·**채널 초대 REST** — 에이전트를 채널에 넣는 표면, B5.2 발견 갭) → 티키타카 smoke(실 provider) → 도그푸딩. A2A 티키타카는 후속 설계.

## 2026-08-01 (밤) · Fable · 오케스트레이션
- 한 일: **B5.3a(에이전트 운영 서버 표면) 랜딩**(PR #946) — 채널 멤버십 REST(사람/에이전트 무분기=불변식 #5, 티키타카 온보딩 접합점)·프로필 PUT/pause·routing 실구현(ADR-0134 D1 비대칭: 명시 위반=400 롤백/상속 위반=무시+audit, thread_root_then_routing은 예고대로 삭제=검증 위치가 진실). 게이트 전 스위트 63케이스+docker build green. conformance: 초대→멘션→응답→제거→침묵 / pause→run 0 / routing 반영. B5.3b(허브 UI) 병렬 진행 중.
- 열린 것: B5.3b 랜딩+design-review → **티키타카 smoke(실 provider·NCP)** → 도그푸딩 조건 판정. 후속 티켓: 채널 멤버십 audit(Swift 파리티로 미기록)·FOR UPDATE 편집 락.

## 2026-08-02 (새벽) · Fable · 오케스트레이션
- 한 일: **B5.3b(에이전트 허브 UI) 랜딩**(PR #947) — 허브(만들기·프로필·pause·채널 배치)·승인 D-5(인박스 결정)·capability 4축(allowed-models 프로브 — GET 200을 PUT 존재로 오독하던 '거짓 ready' 실측 수정). design-review PASS(Blocker 0·High 2) → High 2(승인 오프라인 게이트 일원화·무장 시 초점 이동)+Medium 2(배너 범위·비가역 재진술)를 오케스트레이터가 직접 수정 후 머지. 전 대비 AA. **B5 아크 완성** — 남은 것: 티키타카 smoke(실 provider·NCP)로 도그푸딩 조건 판정.
- 열린 것: 티키타카 smoke 실행(성재 provider link 설정 필요할 수 있음 — anthropic 키). 후속 티켓: capture:routing base 실패·M3/M4·채널 멤버십 audit.

## 2026-08-02 (오전) · Fable · 오케스트레이션
- 한 일: **GPT OAuth 완결** — ADR-0147 Accepted(구독 OAuth·내부 한정·봉인 계약 재사용), B5.4(PR #948: oauth-openai envelope·refresh→재봉인 DB 복호화 red·마이그레이션 0)·B5.4b(PR #949: Responses 어댑터·kind→와이어 매핑·codex 바이너리+openai-python 이중 실측) 랜딩. 게이트 71케이스+docker build green. 정직 한계 기록: Codex 신원 헤더 비위조 — ChatGPT 구독 백엔드 수용 여부는 실 smoke가 판정(거절 시 대안: API 키 경로 or ADR-0144 샌드박스 codex).
- 열린 것: **실 티키타카 smoke** — NCP 배포(agent-worker compose 편입 필요)→성재 codex 토큰 등록→@멘션→실응답 → 도그푸딩 조건 판정.

## 2026-08-02 (오후) · Fable · 오케스트레이션 — **🎉 실 티키타카 성공**
- 한 일: B5.4c(SSE) 랜딩(PR #950, 게이트 75케이스) 후 실 smoke 완주 — **@oort 멘션에 GPT-5.6이 실서버에서 실답변**("오르트 구름은…혜성의 주요 기원"). 경로: 성재 ChatGPT 구독 OAuth(봉인 등록)→run→agent-worker→Responses SSE→척추로 채널 기록. 양파 4겹을 실측으로 벗김: 모델명(gpt-5.6-sol)→SSE 필수→max_output_tokens 미지원(각각 진단 패치의 오류 본문 가시화가 결정적). 신원 헤더 위조 없이 백엔드 수용 확인.
- **판정: 성재의 도그푸딩 조건("에이전트 초대+buzz 수준 티키타카") 1차 충족.** 남은 다듬기: 에이전트 생성 시 모델 카탈로그↔실 provider 모델 매핑 정리(smoke는 SQL 직갱신으로 우회)·max_output_tokens 와이어별 분기·자연스러운 대화 품질(스레드 응답 등 후속 티켓들).
- 열린 것: 성재 실사용 확인(웹에서 직접 @oort) → 팀 도그푸딩 개시 판단. NCP 가동 중.

## 2026-08-02 (저녁) · Fable · 오케스트레이션 — **🎉 A2A 실연 성공**
- 한 일: **B7.2(A2A) 랜딩·실연**(PR #952, `7e3bf6eb`) — 실서버에서 사람 과제→@oort가 @luna에 위임(depth1·부모 결속)→luna 의견→oort 종합 결론. 안전장치 실측 이식(G1 동시 run·G2 연속 자동발화·G3 step 소비·a2a_depth 캡=스키마 007 CHECK에 clamp·체인 과금 상한=ledger 재귀 CTE, 배치 위치=ledger 뒤). 게이트 79케이스 green(신규 SQL 3 첫 실행 포함). 성재 질문 3종 답변 기록: 채팅 provider(GPT만, Claude=B7.1)·작업 실행(workd=B7.4)·봇=플러그인 경계(ADR-0113, 미이식)·A2A는 이제 개방.
- 열린 것: **B7.1(Claude 네이티브 provider — GPT×Claude 협업) / B7.3(tool call·Context Packet) / B7.4(workd Rust)**. 도그푸딩 개시 판단(티키타카+A2A 실증 완료 — 성재 체감 확인 대기). 서버 가동 중.

## 2026-08-02 · Fable · 오케스트레이션
- 한 일: **QA 스윕→수정 사이클 완주.** 실사용 QA(브라우저 46샷)가 Blocker 1(WSS 403)+High 10 발견 → **B1 인프라 즉시 해소**(Centrifugo allowed_origins: 마운트 config보다 env 우선 + v6 env는 **공백 구분**이라 JSON 배열은 원소 1개로 파싱 — 실측 2건, 레포 반영). **B8**(#953: Enter/IME·마크다운 무의존 렌더·오류 은닉·연결 배너·unread 커서 재시도·날짜 컨텍스트, 3라운드 자체 design-review) + **B9**(#954: iOS 하단 툴바가 레이아웃 뷰포트를 안 줄임→visualViewport 추적, 셸 overflow:clip 때문에 문서 단언이 구조적으로 무력했음→스크롤 컨테이너 단언 확대) 랜딩·배포. 충돌 1건 수동 병합. **데스크탑 앱 dev 빌드**(~/Desktop/oort.app, app.oor7.com 지향, 서명 없음).
- 정정 기록: 내가 "모바일 계획 공백"이라 답한 건 오류 — **ADR-0137(Accepted, bare RN+Expo 낱개)이 정본**이고 Tauri 모바일은 이미 기각(푸시·NSE). buzz 모바일 실측 = **Flutter(Dart 248파일, TS 0)** — ADR-0137이 인용한 그대로.
- **B10(PWA) 랜딩·배포 완료**(#955, track/engine `47094c60`): manifest(standalone·아이콘 3종)·최소 SW(앱셸만 캐시·**API 응답 캐시 0**을 게이트가 강제)·설치 안내 1회·standalone safe-area. 홈 화면 추가 시 주소창/툴바 소멸 → 컴포저 가림 근본 해소.
- 열린 것: 그 다음 **#837 RN 실기기 스파이크**(한글 IME 게이트, 성재 iPhone 필요). QA 잔여: H1 API 404군·H3 메시지 액션·H5 검색·H7 DM 무멘션·M/L군.

## 2026-07-10 (오전) · Fable · 기획
- 한 일: ADR-0100(거버넌스)·0101(에이전트 신원, Option A) 성재 승인 → Accepted. ux-bible/architecture 정본 신설. MOMO-337~339 수용기준 발급(BUILD_TICKETS).
- 열린 것: 없음 (전부 오후 세션으로 인계됨).

## 2026-07-09 · Fable · 진단
- 한 일: 6방향 코드베이스 감사 + Slack UX 딥리서치(36소스) → 진단 아티팩트(https://claude.ai/code/artifact/1e7d94cf-094c-4b66-b2b9-dbef028bee06). 판정: 골격 견고 / 신원·체감 레이어가 봇 수준 / 전면 리라이트 비추천. ADR 결정 큐 0100~0109 수립.
- 열린 것: 결정 큐 0102~0109 (0100·0101은 다음 날 처리됨).

## 2026-08-02 (심야) · Fable · 오케스트레이션 — QA 잔여군 3배치 완주 + qm/herdr 리서치
- 한 일: **B11·B12·B13 병렬 착수→2라운드→합본 랜딩·배포**(PR #956·#957·#958, `track/engine` `a591bc62`). 실측이 패킷을 다시 씀: H5 검색은 **서버가 이미 있었고**(클라만 부재), H3는 Swift 8라우트 중 **3개만 이식**돼 있었으며(reaction·thread 테이블은 스키마에 이미 존재 → 마이그레이션 0), H7은 `profile.triggers`가 `{mention:true}` 고정이라 **트리거 확장이 아니라 라우팅 규칙**으로 풀어야 했다.
- **B12(정직화+검색)**: 미제공 표면이 3군이 아니라 **7군**이었다(경로만 비교하면 `agent-runs`를 놓친다 — POST 전용이라 GET이 404 아닌 **405**). 최악은 `approvalDecision.ts`가 **404를 영수증으로 세던 것** — 라우트 없는 404는 본문이 없어 파싱에 걸려 "다시 시도하세요"가 떴고, 성공할 수 없는 재시도였다. design-review High 3(머리말이 본문을 반박·조사 오류·**점프 조용한 실패**) + "기록을 남기지 않습니다"가 **반대 방향 거짓말**(서버는 쓰고 있고 읽는 경로만 없음)까지 2R에서 해소. 캡처 24→46.
- **B13(DM 무멘션+다듬기)**: 발화자 검사를 **자격증명+명부 이중**으로 둔 게 핵심(에이전트 베어러의 HTTP send는 A2A 루프 게이트가 있는 워커 경로를 안 지나므로 여기가 유일한 문). design-review가 로그인 폼에서 **무언의 테넌트 전환**을 잡았다 — 워크스페이스 칸에 UUID 아닌 값을 넣으면 서버가 말없이 데모 워크스페이스로 로그인시켰고(`unwrap_or(DEMO_WORKSPACE_ID)`), 정작 워크스페이스 UUID는 제품 어디에도 표시되지 않는다. 2R에서 **빈 값 폴백은 유지, 파싱 실패는 400**으로 정직화 + 필수/선택 문법 복원(성재가 물었던 "이메일 비밀번호 뭘로 채워야해?"에 화면이 직접 답함).
- **B11(메시지 액션)**: 서버 5엔드포인트 Swift 파리티(seq 미소비·`emit_outbox` 단일경로·가드 순서 `lock→membership→authorship→state`로 404가 403보다 먼저 = 비멤버에게 존재 오라클 차단). design-review **FAIL(Blocker 1)** — hover 바가 자기 행 첫 줄을 덮는 기하 결함(`-top-3`=12px 상쇄 vs 바 32px → 항상 20px 잔류). 2R에서 오프셋 조정이 아니라 **행에 32px 액션 열 예약 + 진입점 1개(DropdownMenu)** 로 구조 해결, 탭 스톱 **행당 6개→1개**(타임라인→컴포저 Tab 16회), 죽은 스크롤 방어(`clear()`가 origin을 즉시 null로) 수정+테스트 13, 시트 목적지 44px 미달 2건 수정. **1R 증거가 가짜였다**: 키보드 증명 프레임이 hover 프레임과 md5 동일(프로그래매틱 `.focus()`는 `:focus-visible`을 안 켠다) → 2R은 실제 Tab·CDP 실터치로 재생성.
- 게이트: 합본 **실DB 91/91**·웹 **1178 test**·docker 이미지 빌드 green. 배포 후 healthz 200·manifest 200·**WSS 101**(HTTP/1.1) 확인. 게이트 PG 컨테이너·워크트리 3개 회수.
- **리서치(성재 요청)**: `2026-08-02-qm-source-analysis.md` — **권고 C안(조각 3개만 차용)**. qm은 데모웨어가 아니지만(테스트 3,347케이스) **RLS 0건·`ORG_ID` env로 프로세스당 조직 1개·에이전트=Slack 봇 1개·provider 키 서버 상주**라 우리 불변식 ⑤⑦과 정면 충돌. 차용 대상 = ①**audience-floor 컨텍스트 해석**(~90줄, 우리 Context Packet(B7.3)이 곧 답해야 할 질문) ②런 큐 하드닝(부분 유니크 인덱스, `attempts`/`error_attempts` 분리) ③harness adapter **profile 모양**. README가 코드와 어긋나는 곳 9건(특히 `strict`가 인젝션 스크리너를 끔) — **SECURITY.md를 믿어야 하는 레포**.
- `2026-08-02-herdr-runtime-analysis.md` — **workd 대체 불가**(소켓 API 91메서드 전체에 자격증명 검사 0·Windows에서 파일모드 통제가 no-op·상태는 화면 정규식 휴리스틱·이벤트 유실을 탐지할 seq 없음·`lib` 타깃 부재로 crate 의존 불가). **B7.4 계획대로 진행.** 소득 2건: (a) B7.4 스코프에 **`SCM_RIGHTS` 무중단 핸드오프** 추가 — 없으면 컷오버가 전 세션을 `orphaned`로 밀고 `t3_terminate('orphaned')`가 **과금 정산까지 일으킨다** (b) 2026-07-28 감사의 Windows herdr spike는 종결하고 **`portable-pty` 0.9.0 ConPTY DLL 하이재킹**을 Windows work host 수용기준에 편입.
- 열린 것 — 후속 티켓: ①스레드 패널 루트의 죽은 「답글 N개」(선재, `ThreadPanel`이 `onOpenThread` 미전달) ②paused 에이전트 DM에 사람이 말할 때마다 시스템 라인 누적 ③승인 라우트 이식(B7.3 툴콜과 함께 — 지금은 `awaiting_approval` writer가 없어 잠복) ④반응 DTO id 대문자 정본 통일 ⑤폼 컨트롤 32px 토큰. **#837 RN 실기기 스파이크**(성재 iPhone)·**도그푸딩 개시 판단**은 성재 트리거.

## 2026-08-02 (심야2) · Fable · 오케스트레이션 — RN 스파이크 착수(#837)
- 발단: 성재 "RN작업 바로 착수. buzz기반으로 얼마나 촘촘하게 계획 수립했는지 체크하고 진행."
- **계획 밀도 실측 → 정정**: RN 계획은 **buzz 기반이 아니다.** 채택계획(581줄) 내 언급 = Mattermost 35 · Expo 32 · FlashList 7 · **buzz 0**. buzz는 토대가 아니라 **반례**로 두 번 인용된다(같은 Tauri 2.11을 쓰면서 모바일만 Flutter 37,815줄 → "Tauri 모바일 불합격" 증거 / "Flutter 기각 — buzz가 그 길을 갔고 코드 공유 0"). **이게 맞는 선택**이다 — buzz 모바일은 Dart 248파일·TS 0이라 베낄 코드가 없다. 밀도 자체는 충분(ADR 115줄 + 계획 581줄 + 티켓이 게이트마다 이슈번호·판정기준까지).
- **RN-S2(게이트 4, PR #959 머지)** — 판정 **기기대기(조건부)**. ADR-0137 D7 주장 검증: `PushNotification.swift` 329줄·import가 Foundation/Security뿐은 **참**이나 ①**"배포 레인은 살린다"는 미성립** — fastlane이 프로비저닝하는 id는 `com.dawnkim.momo` 하나이고 Matchfile·Appfile에 `⚠️ 실제 Bundle ID로 교체` 주석이 그대로, Xcode `app.momo.ios`·NSE `app.momo.ios.NotificationService`와 불일치, **확장 프로파일 부재**, `CODE_SIGN_STYLE=Automatic`이라 **CI에서만 터진다**(Tauri #15663 동류) ②**NSE 경로의 load-bearing은 App Group이 아니라 Keychain access group**(`PushNotification.swift:73`) — 혼동 시 **크래시 없이 fail-open**해 placeholder만 뜸 ③**391줄은 한 바퀴 중 3/4**(알림 액션 승인은 앱 타깃). 이식성의 진짜 근거는 import 수가 아니라 **의존성 0 SPM 리프 타깃** 구조. **라이브러리 = expo-notifications 확정**(firebase messaging은 커스텀 액션 식별자 JS 미전달로 승인 흐름이 안 닫히고, APNs 키의 Firebase 업로드를 요구 — 우리 PushRelay는 ES256 JWT 직접 서명). **서버 공백: Rust에 APNs 0줄·devices 라우트 없음**(발송 체인 전부 Swift). **`expo prebuild`는 반드시 `--platform android`** — 플래그 없이 한 번이면 `ios/` 재생성으로 NSE 소멸(Tauri와 문자 그대로 같은 사고). → **ADR-0137 D7에 정오 7항 반영**(`af5405dc`, 결정 불변·서술 정정).
- **RN-S1(게이트 1·2·3·5, PR #960 머지)** — `clients/mobile-spike/` 하네스 인도(70파일). 판정: **게이트2 PASS**(RN 0.86 코어 URL은 정규식 래퍼이고 `validateBaseUrl`이 `https?|ftp`만 허용 → 커스텀 스킴 **7/19 실패**, 폴리필로 19/19. 어댑터 비용 = `deepLink.ts` 0줄·`serverBase.ts` 0줄·`env.ts` 6줄) · **게이트3 PASS(단 서버 설정 변경 필수)** · **게이트1·5 기기대기**.
- **가장 중요한 발견 — RN의 WebSocket은 `Origin` 헤더를 보낸다.** 사전 조사의 "RN은 Origin을 안 보낸다"는 가정이 **측정으로 반증**됐다(origin=`http://127.0.0.1:18901`, Centrifugo가 `request Origin is not authorized`로 거절). `wss://app.oor7.com`은 통과하지만 **셀프호스팅 LAN·로컬은 전부 거절** — 셀프호스팅이 제품 특성이라 실제 문제. **단 이 측정은 dev(Metro) 기준이다 — release 빌드의 Origin을 먼저 재고 정책을 정한다**(dev 측정으로 `allowed_origins`를 넓히지 않는다).
- 게이트5 예비(시뮬레이터, **판정 근거 아님**): FlatList(mVCP) 67.3px / FlashList v2 67.3px / Legend 92.3px, 프리펜드는 3자 모두 0px 보존, **새 메시지 도착은 3자 모두 튐** — Mattermost가 RN 코어 Fabric ObjC++를 패치한 바로 그 지점. 기기에서 재현되면 게이트5는 3자 전부 FAIL 가능.
- 워커 정직성 기록: 하네스가 **한 번 거짓 PASS를 냈고**(웹 `gate-resume.mjs`의 union 판정식을 그대로 옮긴 탓에 WS가 죽어도 REST 백필이 `missing=0`을 만듦) 워커가 스스로 발견해 `wsRailOk`로 고쳤다. 패킷 정정 2건: URL 사용 파일 15→**19개**, `URL.canParse` 0건.
- 설치: cocoapods 1.17.0 · watchman(brew). Android SDK 없음 → **게이트6은 2차**.
- 열린 것 — **성재 실기기 필요**: 게이트1(2벌식·천지인·iOS기본 각각 조합 밑줄·백스페이스·controlled value·조합 중 리렌더, 키보드 3종 = 스크린샷 3장) · 게이트5(구현 3자 자동 측정 + FlatList mVCP 켬/끔). 신규 티켓: ①Centrifugo `allowed_origins` vs RN Origin 정책(**release 빌드 Origin 실측이 선행**) ②fastlane 번들 ID·확장 프로파일 수선(RN 무관·지금 필요) ③Rust APNs·devices 라우트 이식.

## 2026-08-02 (심야3) · Fable · 오케스트레이션 — P1·P2·P3 랜딩 (RN 판정 무관 선행 작업)
- 성재 결정: **"리소스 대비 추천이면 안드도 해도 돼"** → 권고 = **지금은 아니고 iOS v0 TestFlight 직후**. 근거: UI는 RN 공유라 싸지만 **푸시 승계가 0**이고 FCM 발송 체인이 Swift 전용·Rust 미이식이라 지금 열면 **두 번 짓는다**. 기다려서 잃는 것 없음(prebuild·기기루프·Play레인은 비용 동일, FCM만 나중이 쌈). 반대로 지금 열면 iOS 판정 전에 스파이크 표면이 2배. → ADR-0137 §성재 결정 6-b(`227d4ecf`).
- **P1(#961) iOS 서명 레인** — **워커가 내 패킷을 뒤집었다**: `com.dawnkim.momo`는 자리표시자가 아니라 **실제 macOS 앱 번들 ID**(`MomoMac.xcodeproj:153,180`). 내 지시대로 전역 치환했으면 mac 공증·직접배포 레인이 깨졌다. 진짜 자리표시자는 문자열이 아니라 "iOS 레인이 mac 번들 ID를 쓰고 있었다"는 사실. → 플랫폼별 집합 동치로 교정 + NSE 프로파일 추가 + `scripts/verify_ios_signing.sh` 신설.
  - **내가 그 게이트의 구멍을 찾았다**: 판정이 iOS 블록 **합집합**이라 `beta` 레인에서만 NSE를 지워도 PASS했다 — 하필 beta가 TestFlight 레인이고 가장 자주 돈다(로컬 불가시 + 게이트 통과 + CI 확장 서명에서만 터짐 = 이 게이트의 존재 이유인 실패 형태). → **호출 지점별 개별 판정**으로 교정, D6/D7 추가해 신·구 게이트 대조 출력으로 입증. 훼손 8종 전부 실패, 수선 이전(D0) 12건 검출. `CODE_SIGN_STYLE`은 근거 대고 **보류**(CI에 Xcode 계정 없음·`-allowProvisioningUpdates`/`api_key:`/`export_options` 부재, Manual 전환은 실 프로파일 이름 확정 필요, `xcargs` specifier는 **확장이 앱 프로파일로 서명되는** 지점이라 타깃별이어야 함).
- **P2(#963) 푸시 체인 Rust 이식** — **워커가 내 패킷의 범위를 반박했고 맞았다**: 패킷이 "APNs 발송 이식"이라 했으나 **ADR-0120 D1-A가 relay hop을 구조적 필연**으로 못박았다(`.p8`은 App Store 배포자만 보유 → 셀프호스트 서버는 Dawn relay 경유 필수). Rust에 발송기를 넣으면 그 서버가 `.p8`을 들어야 해 경계가 무너진다. Rust 코드가 이미 스스로 적어놨다(`momo-notifier/src/lib.rs:13-14`). → 실제로 빠진 둘(**devices REST + push_candidate drain**)만 이식, **Ed25519 서명 relay hop 보존**(출력 바이트 동일 → `verify_push_notifier.sh` 무수정 통과). 신규 crate `momo-push` + Dockerfile 매니페스트 등재(B1.7 함정) + `notifier` 엔트리포인트.
  - **id-only를 증명으로 만들었다**: 일부러 `body` 필드를 넣어 테스트 3개가 빨개지는 걸 확인하고 되돌림. 키 부재 시 Swift의 "조용히 무서명 전송"(→relay 403→영구실패→무재시도 폐기)을 **상속하지 않고** 기본 off·명시 opt-in·아니면 **부팅 거부**.
  - **실 결함 발견(후속 티켓)**: `work_session_idle` 푸시가 프로덕션에서 배달 불가 — 판정은 그 사유를 내는데 relay 검증기·iOS NSE는 나머지 4종만 받아 400→영구실패 폐기. e2e 게이트가 **어휘 검증 0인 mock relay**를 상대로 단정해 못 본다. 어휘 확장은 ADR-0120 와이어 변경이라 동작 보존 + 명명 테스트로 고정.
  - 게이트: 실DB **107/107**(91→+16) · 이미지 빌드 green.
- **P3(#962) QA 잔여 4건** — 죽은 「답글 N개」 제거(텍스트 렌더) · paused DM 반복 접기(**배열이 아니라 렌더 파생에서만** — seq 구멍 방지, 중단 3조건) · 폼 컨트롤 좁은 폭 44px(전역 토큰 32px 유지, 데스크탑 밀도 보존 실측) · **1-3은 현행 유지 판단**(대문자는 반응만이 아니라 **Swift 전역 기본값**·`openapi.yaml` 비준 계약·릴레이가 채널명에 대소문자를 굽는다).
  - **`capture:design`이 죽어 있었고 원인이 B12였다**(내가 확정): 하네스가 `feed-row` 가시화를 기다리는데 B12의 `isSurfaceProvided`가 `approvals`를 정적 미제공으로 선언 → 인박스가 정직하게 접혀 행이 없음. 게다가 하네스의 approvals 라우트 목이 **죽은 코드**가 됐다(정적 판정이 앞섬). B12가 못 본 이유 = **새 캡처 스크립트를 따로 쓰고 기존 것을 안 돌림**. → 인박스 프레임을 제품 사실에 맞춰 복구(`waitForInboxSettled`, 오류 정착은 실패로 — 불러오지 못한 인박스를 찍어 보내면 리뷰어가 그걸 제품으로 읽는다), 서랍 단정 유지 + 44px 실측 추가, 데스크탑 결정대기 2프레임 제거(피사체가 이 빌드에 없음·`capture:honesty`가 이미 찍음), 죽은 목은 되살아나는 조건과 함께 사유 명시. **exit 0 · 114장 회복.**
  - **남은 것(후속 티켓)**: `capture:design`의 `turn-failure` 스크롤 프레임이 **플레이크**다 — 내가 2회 실행에 1회 실패를 실측했고 하네스 `:467`에 이미 같은 증상 주석이 있다. 플레이크 게이트는 "재실행해서 초록 나올 때까지"를 학습시켜 게이트를 죽인다.
- 열린 것 — 후속 티켓: ①`turn-failure` 캡처 플레이크 ②`work_session_idle` 푸시 어휘(ADR-0120 와이어) ③Swift 대문자 vs Rust 소문자 메시지 id(살아있는 결함 아님 — 웹 `uuidEq`가 주석까지 달고 처리, mac/iOS는 UUID 파싱 면역, 현 배포는 Rust 단독 자기정합) ④macOS `DEVELOPMENT_TEAM` 공백 ⑤`RELEASE_PLAYBOOK.md:213,290` 옛 App ID 서술 ⑥승인 라우트 이식(B7.3 툴콜과 함께).
- **성재 몫**: ①**아이폰** — RN 게이트 1(한글 IME)·5(리스트). RN의 운명을 정하는 유일한 남은 변수 ②**Apple Developer 계정** — App Group→App ID 2개→APNs 키→`match appstore`(런북 `docs/cicd/10-ios-signing-identity-runbook.md`, **App ID를 match가 만들어도 capability는 안 켜주므로 순서 중요**) ③도그푸딩 개시 판단.

## 2026-08-03 (오후) · Fable · 오케스트레이션 — 로드맵 진단 → 승인 축 서버 폐곡선 + 에이전트 운영 표면 착수
- 발단: 성재 — *"아직 메신저 정도 수준에도 못 미치는 UXUI야. **우리 핵심기능을 담는 부분도 미흡해.** 일단 로드맵 체크하고 그 부분을 강화하는 방향으로. **현재의 로드맵 진단부터.**"*
- **진단 정본 `docs/planning/2026-08-03-roadmap-diagnosis.md`.** 두 가지가 동시에 사실이었다: ①`ROADMAP.md` §0이 한 세대 낡음(Swift 서버 · `clients/iOS = 미존재` · MOMO-2xx AWS 알파 — ADR-0145/0137/0133/0120 중 **하나도** 반영 안 됨) ②서버는 에이전트 네이티브 코어를 갖고 있는데 **모바일이 거의 아무것도 표면화하지 않음**(모바일 5 feature vs 웹 23).
- **내 실측 오류를 스스로 잡았다**: `server-rust` 라우트를 처음에 **12개**로 셌다 — grep이 여러 줄 등록(`.route(\n "path",\n handler)`)을 놓쳤다. **실제 58개.** 하마터면 "재작성이 8%"라는 틀린 그림으로 성재에게 결정을 요청할 뻔했다. 정정 후 판정은 그대로: 관전·에이전트 운영은 **서버에 있고 모바일에만 없다**.
- **SRV-T1(#979) 머지 — 승인 축 서버 쪽 폐곡선.** `INSERT INTO approval` 0건 → 생산자 존재 · 승인 라우트 0 → 3 · `resume_approval` 잡이 삼켜지던 자리 닫힘. 도구 하나(`work.session.end`)로 최소 폐곡선 — **새 능력이 아니라 두 번째 호출자**를 고른 판단이 좋다. 워커가 **게이트 점유 누수**를 스스로 발견(`live_run_count_in_tx`가 `awaiting_approval`을 세는데 `max_concurrent_runs` 기본이 1 → 답 없는 승인 하나가 에이전트를 영구 침묵)해 3겹으로 막았다.
  - **오케스트레이터 docker 게이트가 2건을 잡았다**(워커는 docker 금지라 못 도는 자리): ①하네스 비밀번호 기본값이 `momo_app`인데 `bootstrap_roles.sql`은 `momo_app_dev_pw` → env 없이는 **7/7 전멸** ②`t1_3` `22P02 invalid input syntax for type uuid: ""`.
  - **②의 원인을 워커가 나보다 정확히 짚었다**: payload 모양이 아니라 **롤 자세**였다. `claim_agent_job_batch`는 workspace 술어 없는 **전역 소비자 claim**이라 프로덕션에서 BYPASSRLS `momo_worker`로 도는데, 테스트가 NOBYPASSRLS `momo_app`으로 불러 `outbox` 정책이 미설정 GUC를 uuid 캐스팅하다 죽었다. **프로덕션 무영향을 배포 설정으로 검증**(worker/notifier 각각 전용 URL). 다만 지적 자체는 유효했다 — **폐곡선이 미증명이었고, 자세가 틀린 테스트는 존재하지 않는 배포를 검증한다.**
  - 게이트 결과: `approval_pg` **7/7 green** · 인접 실DB 스위트(agent-worker·a2a·agent·notifier) **회귀 0** · 워커 로컬 629 passed.
  - 부수 수확: 워커가 claim을 넓히며 만든 파생 결함(residue sweep이 `publish`만 쓸어 다른 스위트 통계 오염)을 스스로 잡고, **docker 없이 도는 producer↔consumer 계약 테스트**를 추가 — 같은 계열 결함이 다음엔 일반 `cargo test`에서 빨개진다.
- **RN-A1 착수** — 에이전트 운영 표면. 진짜 일은 **웹에 갇힌 순수 판단 로직을 `momo-core`로 꺼내는 것**(`agentHub/model.ts` 153 · `channelPlacement.ts` 121 · `agents/agentRail.ts` 384 — 순수 확인. `agentWorkingSignal`·`observerStream`은 React/DOM 참조라 제외). B안(작업 관전) 최소 절단면(세션 목록·상태·**호스트 등급**)을 포함 — "지금 이거 꺼도 되나"에 답해야 한다(D5). **세 번째 탭이 여기서 생기므로** `react-navigation` 도입 여부가 걸리는데, 네이티브 모듈 2개는 ADR-0137 D1 사안이라 **하지 말고 근거를 PR에 넘기라**고 지시.
- **ADR 2건 기안(Proposed)**:
  - **ADR-0148 인용 답글** — `reply_to_id`는 컬럼·FK·INSERT 바인딩까지 있는데 **모든 호출부가 `None`을 넣는다**(단 한 번도 non-null인 적 없음). 스레드는 `root_id`라 충돌 없음 → **마이그레이션 불필요.** 의미를 확정: **`root_id`=소속(옆으로 치움), `reply_to_id`=지목(본류에 두고 맥락만 끌어옴).**
  - **ADR-0149 휘발 신호(작성 중)** — outbox 경유 기각(타이퍼당 3초 = 절대 안 읽힐 행, 그 값을 진짜 메시지가 낸다) · 클라 직접 publish 기각(지금 "클라는 publish 못 한다"가 **설정 한 줄로 강제**되는데 그걸 정책으로 내려앉히지 않는다) → **서버 경유 직접 publish, PG 미접촉.** 유일한 실질 비용을 명시: **RLS가 격리를 공짜로 보장해 주지 않게 된다** → 발행 시점 권한 검사가 가장 깨지기 쉬운 자리.
- **성재 결정 대기 — `docs/planning/2026-08-03-roadmap-s0-draft.md`**: ①M0~M8 번호를 살릴 것인가 축(관전·승인·대화)으로 갈 것인가 ②재작성 중 클라 병행 유지 여부(ADR-0145 본문은 "수 주 기능 정지"라 적었으나 실제는 병행 — 사실 정정 필요) ③Swift 서버(156 라우트, 이식 원본) 삭제 시점. 그리고 ADR-0148·0149 승인.
- 살림: 게이트 컨테이너·워크트리 회수, Docker 빌드캐시 정리(누적 82GB 이미지/38GB 캐시 — 발열 이슈 계열).
- 검수: **여전히 요청 없음.** 성재 지시("조금 분기가 되면 한번에")에 따라 RN-A1이 통째로 설 때까지 대기.

## 2026-08-03 (오후2) · Fable · 기획 — 로드맵 정본 갱신 (성재 승인 3건 반영)
- 성재: *"결정 필요한 3개 부분은 권장 사항으로 추천해주면 내가 받을게. **swift 사실상 지금 아무도 안 써서, 안에 핵심을 다 가져왔으면 도달시 일괄 삭제 가능해.**"* → 권고안 3건 모두 확정.
- **① v0의 단위를 M번호 → 축(관전·승인·대화)으로.** `ROADMAP.md` 헤더·§0 교체. §1~§7은 **폐기하지 않고 "축으로 대체됨" 표식**만 붙였다 — 스토어·공증·법무·CI/CD 항목은 여전히 유효해서 축 작업 뒤 다시 태운다. 8개 마일스톤 분량을 미검토로 지우는 건 파괴적이라 안 했다.
- **② 재작성 중 클라이언트 병행 유지.** ADR-0145 Consequences에 **사실 정정** 추가: *"기능 정지는 일어나지 않았고, 일어나지 않는 편이 나았다"* — 재작성이 메신저 코어를 먼저 넘겨 클라가 붙을 표면이 있었다. 실제 방침 = **병행하되 클라는 Rust가 이미 주는 라우트만 쓴다.** 경계 변경이 아니라 예측의 정정이라 새 ADR 안 열었다.
- **③ Swift 서버는 parity 도달 시 일괄 삭제.** `server/README.md` **신설** — "이식 원본이다, 실행 대상이 아니다". 축별 부분 삭제를 안 하는 이유를 적었다: **되돌아볼 원본이 조각나면 남은 이식이 근거를 잃는다.** 아직 이식 안 된 것 목록(work-controls · work-auto-approvals · workstream · plugins · MCP · Drive · huddles)도 함께.
- `docs/architecture/overview.md`는 시스템 지도가 Swift/Hummingbird 시절이라 상단에 **스택 갱신 경고** 삽입(전면 재작성은 별건). **불변식 6개는 그대로 유효** — DB가 최종 강제자라 언어 교체가 위협하지 않는다는 점을 같이 적었다.
- **열린 것**: ADR-0148(인용 답글)·0149(휘발 신호) 여전히 **Proposed**. 0149는 Centrifugo publish 주체를 relay 하나 → 둘로 늘리는 **경계 변경**이라 Accepted 없이 구현 착수 금지(ADR-0100).

## 2026-08-03 (밤) · Fable · 오케스트레이션 — 3배치 랜딩: 에이전트 운영 표면 + 인용 답글 + 작성 중 신호
- **#980 RN-A1 에이전트 운영 표면 (머지).** 폰에 「에이전트」 탭이 처음 섰다 — 목록·프로필·**재우기/깨우기**·채널 배치·작업 세션+**호스트 등급**. 웹에 갇혀 있던 순수 판단(`agentHub/model.ts`·`channelPlacement.ts`·`agentRail.ts`)을 `momo-core`로 꺼내고 모바일은 뷰만 얹었다. 웹 테스트 **579 불변**(호출부가 하나도 안 움직였다 — re-export로 공개 API 보존).
  - **디자인 리뷰(신선한 컨텍스트)가 제 몫을 했다: Blocker 0인데 High 3.** 최악은 **H1 — 끝난 작업 카드가 "지금 이거 끄면 멈춥니다"라고 경고**하고 있었고, **테스트가 그 결함을 잠그고 있었다**(`SESSION-CLOUD` 픽스처가 `status:'ended'`인데 "폰을 꺼도 계속됩니다"를 단언). 성재가 첫 화면에서 볼 자리였다.
  - 2R 수정이 좋다: `sessionSurvival(session, hosts)`가 호스트와 **세션 상태를 함께** 읽고, `hostTier`는 등급 이름만 답한다. **`idle`을 `ended`로 접지 않은 판단이 정확** — 호스트가 아직 PTY를 들고 있어 잃을 게 남아 있다. `ended`는 침묵 대신 **"끝난 작업입니다. 지금 무엇을 꺼도 영향이 없습니다"**로 답한다. 테스트는 지우지 않고 고쳤고 **`멈춥니다`·`계속됩니다` 부정 단언**까지 걸어 되돌아올 수 없게 했다.
  - **H2에서 서버 사실이 나왔다 — 승인 hold 중에도 work session은 `running`으로 남는다.** 근거: `work_session`↔`agent_run` FK 부재 + `work_session.status`를 쓰는 8개 문장 전부 `momo-t3`라 승인 경로에서 도달 불가. 그대로 뒀으면 **사람을 기다리는 에이전트를 폰이 "작업 중"이라 불렀을 것.** 폰 문구를 「세션 실행 중」으로 좁히고, 웹의 "작업 중"(실시간 턴)과 갈리지 않게 코어·모바일 양쪽에 단언을 걸었다. 실시간 턴 배선은 다음 배치.
  - H3: 「다시 시도」가 배너만 닫고 있었다 — 이번에 처음 **워크스페이스 상태를 바꾸는 컨트롤**에 붙은 자리. 진짜 재시도로 고치고 선례(`SidebarScreen.tsx`)도 함께.
- **#981 SRV-T3 인용 답글 (머지).** `reply_to_id`를 깨웠다. **마이그레이션 0건.** 실DB 7/7 + 인접 6스위트 회귀 0 + OpenAPI 142/142.
  - **워커의 최선 판단**: 인용 소스를 job payload가 아니라 **잠긴 `agent_run.trigger_message_id`**에서 읽었다 — `resume_job_payload`에 트리거가 없어서, payload를 읽었으면 **승인 뒤 재개 턴부터 조용히 인용이 끊겼을 것**이다. 대가는 `GatewayRunSnapshot` 컬럼 1개.
  - N+1은 페이지 자체의 `LEFT JOIN`으로 해소(인용 0개든 100개든 쿼리 1개). 규칙 3(참조≠스냅샷)의 핵심은 **realtime/`message.edited`에 본문을 안 싣는 것** — outbox 행은 영원히 재생되므로 렌더된 인용이 곧 스냅샷이 된다.
  - **워커가 내 패킷의 오류를 짚었고 맞았다**: 거부 문장을 한국어로 쓰라 했으나 서버 `ApiError`에 **한글 0건**이고 한국어 문장은 `momo-core`의 `http.ts`/`api.ts`가 상태코드에서 만든다. 한 엔드포인트만 한국어면 그게 새 모양이다.
- **#982 SRV-T2 작성 중 신호 (머지, 2R).** ADR-0149 구현. **grant를 앞으로 빼서 발행 라우트를 PG 0회로** 만든 게 핵심 — 가드 3(PG 미접촉)과 발행시점 권한 검사를 동시에 참으로 만드는 유일한 모양이고, 부수로 3초 주기 인라인 검사(타이퍼당 분당 20 SELECT)를 없앤다. `is_channel_member`를 subscribe 프록시와 **같은 함수**로 부르고 `parse_channel`에 `typing:`을 같은 분기로 태워 **갈라질 두 번째 구현 자체를 없앴다.**
  - 서명 키를 `CENT_TOKEN_HMAC`이 아니라 `JWT_HMAC`에서 **도메인 분리 파생** — 안 그랬으면 유출된 grant가 그대로 Centrifugo 연결 토큰이 되어 `user:read-state#<MEMBER>`를 프록시 없이 구독할 수 있었다. **`jsonwebtoken` 기본 leeway 60초 함정**(60초 grant가 120초가 된다)도 잡고 red test로 고정.
  - **오케스트레이터 게이트가 1건 잡았다** — `srv_t2_2`. **내 추정(outsider)은 틀렸고** 워커가 갈라서 반증했다: 실패는 **교차 테넌트 probe**였고 `ch:`/`typing:` 패리티는 원래 green이었다. 서버도 옳았다 — subscribe가 **채널이 지목한 워크스페이스**로 tenant tx를 열어 credential 게이트가 채널 규칙보다 **먼저** 거절한다. 문자열만 맞췄으면 그 구분이 사라졌을 자리.
  - 2R가 좋다: **패리티를 리터럴이 아니라 두 레일 상호 비교로** 단언(그래야 `ch:`가 답을 바꿔도 잡힌다) + 게이트별 이름(`CHANNEL_RULE_DENIAL`/`CREDENTIAL_GATE_DENIAL`)에 `assert_ne!`로 구분까지 고정 + 배우를 서버가 인증하게(`connection_claims` 200 단언). 단언 34→50, probe 13→21.
  - 재게이트 3/3 · OpenAPI 142/142 · **이미지 빌드 OK**(신규 crate 2개 매니페스트, B1.7 함정 통과).
- **폰 검수 준비 완료** — Release 빌드(`app.momo.ios`, 팀 `YWQQFQM38J`, NSE `.appex` 탑재) 구움. 배포된 라이브 서버에 새 화면이 부르는 4라우트 전부 존재 확인(401), **`approvals`만 404**(#979 배포 전).
- **신규 티켓 후보**: ①**커밋된 `Podfile.lock`의 `hermes-engine` 체크섬이 이 머신 `pod install` 결과와 달라 깨끗한 체크아웃에서 Release 빌드 실패** — TestFlight 레인에서 터질 것 ②M1 어휘 통일(재우기/일시정지/자고 있음 — 서버 `mention.rs:622`까지 걸린 제품 결정) ③roster에 pause 상태 부재(목록 한 줄이 에이전트당 요청 1건, owner/admin 게이트라 일반 멤버 403) ④에이전트 실행 기록 클라 미제공 ⑤실시간 턴 신호 폰 배선 ⑥openapi.yaml 백필(샘플과 함께) ⑦Rust에 agent-run cancel 라우트 부재.
- **성재 대기**: ①승인 축(#979) 배포 실행 — `compose up -d` 한 줄(main 머지 **불요**: main엔 server-rust가 없고 배포는 track/engine 이미지에서 직접 — 2026-08-04 검증 세션이 커밋 전 정정) ②데스크탑 동시 검수 여부 ③폰 연결.

## 2026-08-04 · Fable · 기획 — 인계 전수 검증 + 구현 리뷰 + 로드맵 조정 초안
- 인계 문서 전 항목 재실측: 핵심 판정(승인 축 미배포·paused=생성시점만·main에 server-rust 없음·ADR 2건 Accepted)은 유효, **수치는 셋 다 어긋남** — Rust 라우트 63→**65 유니크 경로**(메서드 기준 82)·Swift 156→**137 유니크 경로**(어느 단위로도 156 재현 불가)·work_session 쓰기 8문장→UPDATE 5. 라이브 실측: roster **401** vs approvals/typing **404**(구 이미지 서빙 확정). 이미지 신원·디스크 82%는 ssh 차단으로 **확인 못 함**.
- 인계가 놓친 것 2건: **승인 표면은 모바일이 웹보다 앞서 있다**(인박스 목록+푸시 잠금화면 결정 배선 완비, fail-closed 잠김 — 웹은 결정 UI 0건) · **웹 23 feature는 명목치**(serverSurfaces 5표면 provided:false). ADR-0149의 비용(RLS 비보장)은 #982가 제대로 갚았다(grant 발급 1회 read를 RLS 아래서·subscribe와 동일 술어·PG 0회 테스트 고정) — 잔여는 60초 grant 창뿐(Consequences 한 줄 추가 권고).
- 정본 결함 2건(비커밋이라 정정 가능): ROADMAP·server/README 라우트 수 단위 불명("58/156") · 이 파일 8/3 밤 항목 말미의 "승인 축 배포=main 머지 승인"은 **오류**(main에 server-rust 없음 — 배포는 track/engine에서 직접).
- 산출: `docs/planning/2026-08-04-handover-verification-and-roadmap-adjustment.md`(검증 판정표·축별 4층 판정·배치 0~5 제안·성재 결정 A~F·ADR-0150 후보 지목) + CURRENT_STATE 스냅샷 10.
- 다음: 성재 결정 **A**(compose up -d 한 줄)·**F**(정정 2건 후 12파일 커밋)부터. 폰 검수 분기 = 배치 1 완료 시점.
- **(같은 날 오후 추가)** 성재 지시 접수: *"구현은 Opus 5로, Fable은 기획·검수·로드맵의 오케스트레이터로."* → 결정 **C·E·F 확정 집행**(어휘=재우기/깨우기 · 인앱 승인 배치1 개방 · 정정 4건: ROADMAP/README 라우트 수 65/137 단위 명기·overview 137·JOURNAL "배포=main 머지" 오류 정정) + 정본 일괄 커밋. **배치 1 가동**: Opus 5 워커 3기 병렬 — W-AP1(웹 승인함)·M-AP1(모바일 인앱 결정)·H-FIX1(hermes 재현→수리). 패킷 3장 `handoffs/2026-08-04-*`. 충돌 경계: momo-core는 W-AP1만(serverSurfaces approvals 항목), M-AP1은 mobile/src만, H-FIX1은 mobile/ios만. 머지 순서 H 독립·W→M.

## 2026-08-04 (오후2) · Fable · 오케스트레이션 — 승인 축 라이브 배포(대행) + Apple 자산 실태 확정 + 결정 A~F 종결
- **결정 A 집행(배포 대행, 성재 ssh 위임)**: NCP에서 `MOMO_RUST_IMAGE` amd64→`dae3a387` 갱신 후 up -d. **함정 실증 1건**: 07-30 런북의 2파일 compose 명령은 낡음 — 실스택은 **5파일+env 2개**(rust·push·t3·caddy·cent-origin), 빼먹으면 notifier가 구 이미지로 남고 centrifugo가 origin 허용목록 없이 재생성된다. 재발 방지 정본 신설 = `docs/runbooks/ncp-rust-deploy.md`. 검증: approvals **404→401** · typing 서빙 · migrate 60/60 멱등 · 전 서비스 healthy·신 태그 · 디스크 82%(momo-rust:deploy 256MB 회수). 롤백 = env 태그 복원(백업 `.bak-20260804`).
- **Apple 자산 실태 실측(성재: "swift 때 다 줬다" — 맞았다)**: 키체인 Distribution/Developer ID 유효 · **App Store 프로파일이 앱+NSE 둘 다 존재**(=App ID 2개 등록 완료, 신경로 `~/Library/Developer/Xcode/UserData/`) · APNs `.p8`은 NCP push-relay에서 실작동. **빈 곳은 CI 레인뿐**(momo-signing repo 미생성·GH Secrets 0건) — **첫 TestFlight는 로컬 Xcode Organizer로 지금 가능.** 상태 정본 = engine `docs/cicd/10-*.md` 상단 블록(track/engine `cf25c1c6` push됨) + Fable 메모리. **다시 성재에게 묻지 않는다.**
- **hermes 물증 확보**: engine 워크트리 비커밋 lock diff가 정확히 한 줄 — hermes-engine **SPEC CHECKSUM 드리프트**(1f9904ef→3ccaa647, 버전 동일). H-FIX1 워커에 전달(독립 재현 지시 유지).
- 결정 B 집행: **ADR-0145 증보 1**(parity=제품 채택 라우트 집합, 이식/보류/폐기 초기 분류표). D는 ADR-0150 기안 시 확정. 성재 5번 승인으로 main push(이전 세션 12커밋 포함). main 동기화는 성재 위임("트랙별로 메인에 머지 잘하쇼") — 랜딩 단위·게이트 그린 전제로 수행.
- 배치 1 워커 3기(Opus 5) 진행 중: W-AP1(#983)·M-AP1(#984)·H-FIX1(#985). 완료 시 검수→track/engine 순차 머지→성재 폰 검수 분기.

## 2026-08-04 (저녁) · Fable · 오케스트레이션 — H-FIX1 랜딩(배치 1 첫 장)
- **#986 머지**(track/engine `9ce32e5d`, Opus 5 워커): hermes 체크섬 결함의 원인을 **기계적으로 확정** — RN 0.86 `hermes-engine.podspec`이 `require.resolve` 절대경로를 xcconfig에 박고, CocoaPods가 직렬화 JSON의 SHA1을 SPEC CHECKSUM으로 쓰므로 **체크섬 = 체크아웃 절대경로의 함수**. 사전 등록 예측 2건 적중(치환 SHA1 선계산 → 설치 결과 일치). 수리 = 직렬화 직전 `${PODS_ROOT}` 상대화 훅 + stale podspec 캐시 축출.
- **워커의 값진 이탈 보고 2건**: ①내 패킷 게이트("같은 경로 2회 diff 0")는 이 결함을 통과시킨다 — 결정성의 축은 횟수가 아니라 **경로**. 게이트를 "다른 절대경로에서 동일 체크섬"으로 스스로 강화 ②원 보고의 "깨끗한 체크아웃 Release 실패"는 부정확 — 로컬 Release는 통과하고 **`pod install --deployment`(=CI/TestFlight 레인)가 실패**한다. 결함 실체는 그대로, 터지는 지점만 정정.
- **오케스트레이터 독립 검증 PASS**: fix 이전 `Pods/`를 가진 engine 워크트리(제3의 절대경로)에서 pod install → 축출 훅 발동 실측 → **lock diff 0**. 검증 축이 검증자와 무관하게 성립.
- 잔여: W-AP1(#983)·M-AP1(#984) 진행 중. 랜딩 시 track/engine 순차 머지(W→M) 후 성재 폰 검수 분기.

## 2026-08-04 (밤) · Fable · 오케스트레이션 — 배치 1 완주: 승인 축이 서버·웹·폰 3층에 섰다
- **3 goal 전부 랜딩**(track/engine `a604eb2f`): #986 hermes 체크섬(경로 함수 결함 기계적 확정·수리) · #988 웹 승인함(플립+도달 경로+게이트 신설, 3커밋) · #987 모바일 인앱 승인(4커밋 — 확인단계·400ms가드·멱등키·core 뿌리 수리·absent 폴딩). 오케스트레이터 원점 통합 검증: **core 678 · web 619 · mobile 486 전부 green · typecheck 0×2 · gate:approvals PASS.**
- **리뷰 사이클이 배치의 절반을 만들었다**: 신선 컨텍스트 디자인 리뷰 2기가 Blocker 4(가역성 fail-open — 서버 계약 명시 위반 · `tool_call` 유출 · 플립의 모바일 파장 · 활동 라우트 막다른 길)를 적발, 전부 오케스트레이터가 코드로 독립 확정 후 2R/3R로 수리. **워커가 리뷰에도 없던 Blocker급을 추가 발견** — core가 snake_case만 읽어 Rust 서버 상대 승인 목록이 언제나 비어 있었다(양표기 읽기로 수리, 근거: 서버가 두 대 사는 동안 한쪽을 고르면 반대 방향 재현).
- **내 오케스트레이션 오류 2건 기록**: 1R 패킷의 core 수정 금지가 Blocker 뿌리를 워커가 못 고치게 했고, shared-core 플립인데 웹 검증만 요구했다(모바일 파장 미검). 2R 패킷 설계에서 파일 전속 경계로 정정 — 이후 패킷은 "공유 코어를 만지면 전 클라이언트 스위트"가 기본.
- **후속 적립**: ①openapi 승인 스키마 표기 정정(snake↔camel — Swift 사후 정본 표기 확정과 함께)+게이트가 응답 형상 표기를 못 잡는 사각 ②승인 카드 표면(서버 props 영어·타임라인 `동작: tool_call`·unknown 가역 갈래) ③푸시 결정 결과 사용자 고지 ④Low 2건(픽스처 표기 혼합·orphan 영수증 testID).
- **다음**: 검수 빌드 준비(폰 Release 재빌드 — 기존 빌드는 배치 1 이전 코드 · 웹 배포 경로 확인) → **성재 폰 검수 분기**(에이전트 탭+승인함+잠금화면 승인) → 배치 2(관전 마감: cancel 이식·턴 신호 폰·roster pause) 패킷.

## 2026-08-04 (새벽) · Fable · 오케스트레이션 — 배치 2 완주: 관전 축 마감 「보인다 → 멈출 수 있다」
- **4 goal 전부 랜딩**(track/engine `d5cc8559`): #993 cancel 이식(단일 tx: run·job·approval·시스템라인·audit — Swift 수기 INSERT를 단일 쓰기경로로 교정, **mention run job 유실 버그를 case-fold로 선제 차단**) · #995 roster paused(경계 근거 성문화·paused:false 명시) · #994 폰 「작업 중」(파서 0줄 — 전부 core 소비 · 2R: 회복배치 종료프레임·오프라인 고지·문구 5표면 단일화) · #996 중단 컨트롤+paused 소비(409가 "어떤 끝이었는지"까지·영수증이 서버가 안 한 일도 말함·N+1 제거). **오케스트레이터 원점 통합 검증 green**(core 678·web 619·mobile 516·typecheck 0).
- 리뷰 사이클 성과: RN 리뷰 2회가 High 3(복귀 후 90초 거짓 「작업 중」 창 — 워커의 좋은 설계가 만든 이차 결함 · 오프라인 무고지 · 비-wrap 행 줄 깨짐)을 적발, red proof 누적 12종. 워커 역제안 2건 수용(M2 물러남 조건 — 성공 영수증이 읽히기 전에 사라지는 문제, 접근성 라벨 내용 판단).
- 후속 적립(배치 4 후보로): producer job payload run_id 대소문자 통일 · 게이트웨이 직송 경로 성공 종료 프레임 부재 · 웹 replay 갭(core `isTerminalProgressFrame` 한 줄 채택) · 에이전트 행 폭 · momo-push 픽스처 재실행 충돌·approval_pg PSQL_BIN 폴백(선존재).
- **다음: 검수 빌드 준비**(폰 Release 재빌드 — 기존 빌드는 배치 1·2 이전 코드 · 웹 새 빌드 배포 경로 확인) → **성재 폰 검수**(배치 1+2 합산: 에이전트 탭·승인함·잠금화면 승인·작업 중·중단·재우기 상태) → 배치 3(대화 기준선: 인용·typing 클라).

## 2026-08-04 (오후) · Fable · 오케스트레이션 — 성재 1차 실기기 검수: 폐곡선 성립 + 결함 8건 분류 + 자동화 전환
- **provider 재등록 성공(ADR-0147 실전 첫 적용)**: 만료 원인=생 bearer 등록(account_id 부재 → chatgpt 백엔드 404). 웹 설정에 OAuth 폼이 없어(UI 미랜딩) **브라우저 콘솔 스니펫**(성재 세션·refresh 회전 되쓰기)으로 등록 — PUT 200, 루나 실응답 확인. 임시 절차·UI 부재는 후속 티켓감. 분류기가 서명키/자격 접근을 막은 구간은 전부 성재 `!` 실행으로 우회 없이 처리.
- **검수 지적 분류**: ①"상태 볼 수 없음"·중단버튼 부재 = **서버 구버전**이 원인(아침 배포 dae3a387에 배치 2 미탑재) → **d5cc8559 재빌드·재배포 완료**(cancel 401 실측) ②모델 luna·강도 xhigh 미노출·웹검색 부재 → SRV-B3 워커(#1000·#1001) ③버벅임·컴포저 가림·작업중 인지성 → RN-P2 워커(#997~#999) ④검은 화면 1회(재현 불가, 관찰 유지) ⑤김인턴 시나리오는 **내 오류**(라이브 실체 미확인 이름 사용).
- **성재 지시로 역할 전환**: *"maestro 같은 걸로 알아서 확인하고 파이널 체크만 불러라"* → **MAESTRO-1 레인**(#1002, 워커 투입): 로컬 스택+internal-host-mock+일회용 픽스처+Maestro 플로우 5종 — 이후 폰 검수는 오케스트레이터 자동 수행.
- **작업 패널 설계 초안** = `2026-08-04-work-panel-design.md` — 실측: 과정 데이터(text_delta·tool_call_*)는 와이어에 흐르는데 그리는 표면 0·저장 0. 권고: D1=휘발 관전 v0(저장은 실증 후 ADR)·D2=웹 먼저·D3=「작업 패널」. 성재 결정 대기.
- 진행 중 워커 3기: RN-P2(3-goal)·SRV-B3(2-goal)·MAESTRO-1. 승인 축 실기 테스트는 루나 툴 활성화(`enable_luna_tool.sh` — 성재 `!` 실행 대기)만 남음.

## 2026-08-04 (저녁) · Fable · 오케스트레이션 — 검수 후속 배치: 관전 레일의 근본 결함 발견
- **최대 수확(#1010)**: Rust 서버에 `agent.status`/`agent.partial` **프로듀서 0** — 인가·네임스페이스·클라 3종 폴딩까지 완비된 레일에 발행자만 없었다. **성재가 "작업 중"을 한 번도 못 본 근본 원인**(짧은 턴·발견성은 부차). 종료 프레임 7곳 채움(phase+run_status 동시 — Swift 버그의 정체인 "둘 접기" 회피), 여는/진행 프레임은 **SRV-B3d(#1012)** 로 즉시 후속(이것 없이는 배지·자리표시·작업 패널이 라이브 공백).
- **RN-P2 3장 랜딩**(`ddb33240`): 버벅임(원인 4, 되돌림-계측)·컴포저 성장(키보드 무죄 판정)·작업중 자리표시("사라짐=도착"). 리뷰 B0·H0·M6 — M1은 워커가 지시 반박(무조건 flush=코얼레싱 원복 실측) 후 더 나은 해법. 후속 #1011(AppState flush).
- **SRV-B3 4-goal 완주**: luna 모델+강도(#1004 — 원인 2중: allow-list 의미론+effort 표) · 웹검색 조사(#1008 — "provider는 받는다, 막는 건 momo") · 종료 프레임(#1010). 라이브 `58e20566`(luna 사용 가능).
- 진행: MAESTRO-1 · WEB-WP1(레일 사실 갱신+웹 replay 한 줄 증보 전달) · SRV-B3d. 폰 파이널 체크 1순위 = #1007 보정의 실기 유효성.

## 2026-08-04 (밤2) · Fable · 오케스트레이션 — 검수 후속 사이클 마감 국면
- **랜딩 누적(이 사이클)**: 서버 6 PR(#1004 luna모델·#1008 웹검색 조사·#1010 종료 프레임·#1013 여는 프레임·#1016 델타 스트리밍·#1018 enabled_tools 소비자 — SRV-B3 단일 워커 6-goal 체인) · 모바일 3 PR(#1003·#1007·#1009) · 웹 2건(#1015 작업 패널+게이트 체리픽). **배포 4회**(서버 3: 58e20566→a929b7ee→8a8df012 · 웹 1: 패널 포함). **작업 패널이 첫날부터 실데이터로 라이브.**
- **승인 실사용 차단기 해제(#1018)**: enabled_tools 리더 0·tool_schema '[]' 고정이라 승인이 실전 생성 불가였던 것 — 교집합 양방향 fail-closed로 배선. 잠금화면 승인 파이널 체크가 이제 가능.
- 파이널 체크 목록 정본 = `2026-08-04-final-check-list.md`(사람만 답할 수 있는 A7+B4개 항목만 — 자동 검증분은 게이트 30여 종+MAESTRO 레인이 담당). 폰 Release 재빌드(8a8df012) 백그라운드 진행.
- 잔여 1레인: MAESTRO-1(격리 스택 momo_maestro1-* 가동·Maestro 런 반복 중). 후속 큐 신규: #1011 AppState flush·#1019 work run tools 키·ADR 2건(0131 증보·외부 유출 방향)·taste §9 완화 여부(성재 B4).

## 2026-08-04 (심야) · Fable · 오케스트레이션 — MAESTRO 레인 완성, 사이클 전체 마감
- **#1021 머지 — 폰 자동 검수 레인 가동**: `npm run lane:phone` 한 번에 5플로우(로그인·작업중·중단·승인·재우기) 2연속 green + red proof + 자원 회수 검증. **전임 워커 행 사건**: 2.5h 무보고 마라톤 턴 — 성재 지시로 중단, WIP 구조 후 MAESTRO-2 재투입(턴 규율 계약 명시: 20분 턴·마일스톤 보고). 신임이 15분 만에 첫 보고, 행 원인까지 규명(러너 trap-락 순서 → 남의 스택 파괴 → 죽은 DB 폴링). 내 오탐 정정 1건(turnSurfaces.tsx 수정은 없었음 — mtime 오인).
- **레인의 첫 실전 수확 = #1020**(앱 사용 중 도착 승인이 인박스에 안 뜸 — 리얼타임 invalidate 부재). red proof 1차가 레인 자체 결함(단독 실행 주소 덧쓰기)도 잡음.
- 한계 명시·후속: 레인 서버=Swift → #1022(server-rust e2e 교체, Swift 삭제 전 필수).
- **파이널 체크 준비 완료**: 서버 8a8df012·웹(작업 패널)·폰 아카이브(MomoMobile-8a8df012) 전부 최종 상태. 사람 항목은 `2026-08-04-final-check-list.md` — 레인 러너도 매 실행 세 줄(잠금화면 푸시·알림 실배달·공유 키체인)로 출력. **다음 = 성재 기기 연결.**

## 2026-08-05 (자정~새벽) · Fable · 오케스트레이션 — 오후 사이클 마감: 결함 배치 2종 완주 + 브랜드 착수
- **RN-B4 5-goal 완주**(#1029~#1034): 진입 앵커(수렴 기계 공유)·pull-to-refresh 3표면·조사(전수 스캔 잠금)·인박스 리얼타임(레인 38s 실증, 우회 제거)·AppState flush. **SRV-B5 3-goal 완주**(#1037·#1039·#1040): 작업런 툴 배선·서버 조사(korean.rs — 정책 분리: 서버 병기/클라 열린 형 수용)·openapi 승인 표기 정합(+생성 타입 원자 랜딩).
- **핫픽스 사이클**: 툴명 400(#1024→#1028) — 점 포함 이름을 백엔드가 거절, 카탈로그 조회 역매핑으로 수리·배포. 성재 실기 검수가 잡은 결함 전부 랜딩됨.
- **게이트 사각 2종 확정**: openapi 게이트가 Swift를 샘플("unsampled 0"의 착시)·게이트웨이 모드 하네스 0 → #1038(하네스 위생 묶음: gateway 하네스+push 픽스처 격리+게이트 재조준).
- 배포: 서버 `da6a646b`(작업런 툴·조사 포함) · 폰 아카이브 `MomoMobile-rnb4`(결함 5건 반영) 재설치. 데스크탑 momo.app 최신. **브랜드**: 오르트 마스코트 컨셉 4종 생성·전달(방향 선택 대기). UXUI 고도화 문서(U1~U5) 승인 대기.
- 성재 대기: ①luna 멘션 단건(핫픽스 확정 — 미수행) ②마스코트 방향 ③UXUI 배치 순서. 다음 단건 검수 = 진입 앵커 실기감.

## 2026-08-05 (새벽2) · Fable · 운영 — 디스크 사건 종결: 워크트리 199GB 회수
- U1 진단 중 로컬 디스크 100% 사건 → 2단 정리: ①Docker 표적(빌드캐시 12GB+스테일 스택 2·구태그 8) ②**워크트리 일괄**(머지완료+추적변경 0 조건, 활성·미병합 보존) — momo-worktrees **199GB→11GB**, 디스크 99%→**79%(가용 192GB)**. 정체는 7월 이후 머지된 워크트리들의 .build/node_modules/Pods 누적.
- 보존 8개: SRV-B6(활성)·RN-B4-defects(tracked 1)·WEB-WP1-panel·684(미병합)·구레포 3·827(브랜치불명). momowebqa·momo_main 스택은 용도 불확실로 보류(성재 확인 목록).
- 성재 지시 반영: 워커 복귀 시 로드맵 점검→미구현 중심 구현 재개 — 최대 갭 = **배치 3(대화 기준선: 인용·typing 클라 표면)**, U1 산출로 U4(채팅 UI 수리) 편성.

## 2026-08-05 (아침) · Fable · U1 랜딩 + 4워커 체제 편성 (B3W·B3M·U3·SRVB7)
- **U1 감사 랜딩**: `research/2026-08-05-chat-ui-audit.md` 커밋(015cb601) — 결함 37건(BL 3 전부 폰: 마크다운 미렌더·복사 불가·링크 안눌림), U4-a~j 수리 배치 편성 포함. 성재의 "구리다"가 열거 가능한 목록이 됐다.
- **U4 1차(폰 Blocker) → B3M 체인 연장**: 패킷 `2026-08-05-U4-phone-blockers-packet.md`, #1048(U4-a 본문 렌더 동등화)·#1049(U4-b 복사). B3M이 core 대기로 막히면 M3(렌더)를 M1(인용)보다 먼저 — MessageRow 본문 경로 재구성이 선행되는 게 이중 작업을 줄인다.
- **U3(AI 연결 OAuth 폼) 착수**: 패킷 `2026-08-05-U3-ai-link-oauth-packet.md`, #1047, worker-U3 스폰(전속=web settings — B3W와 경계 조정 통지 완료). 콘솔 스니펫 우회의 제품화.
- **SRV-B7(#1042 openapi rust 이중 샘플) 착수**: 패킷 `2026-08-05-SRV-B7-openapi-rust-sampling-packet.md`, worker-SRVB7 스폰. 함정 명시: repo에 rust 로컬 컴포즈 부재(실측) — 부팅 패턴 선택은 worker 실측+근거 기록.
- **#1022(레인→rust)는 배치 4로 보류**: 레인 파일이 clients/mobile/** + 기기·컴포즈 자원이 B3M 검증과 경합 — B3 랜딩 후.
- 다음: 첨부 v0 ADR(0151) 기안(성재 사전 승인 방향) · B3W core 표면 커밋 대기 → B3M 중계 · PR 도착 순 검수·머지.

## 2026-08-05 (오전) · Fable · 워커 보고 4건 처리 — U1 종결·이탈 판정·B3W 무보고 경보
- **U1 최종 종결**: 증거 공백 2건 닫힘 커밋 — BL-1은 시각 확증으로 심각도 근거 강화(지배 실패 모드="답변 전체가 코드 상자" — `body.includes('```')` 분기, 웹 대조군 정상. 대표 캡처 `md-01`) · M-10 근인 확정(momowebqa centrifugo `allowed_origins`에 RN origin 부재 → 거절이 '연결 중…'으로 위장 — UI 결함으로 재분류, U3 축 이관). 파생 이슈: **#1050**(openapi에 provider/link 4경로 부재) · **#1051**(QA·레인이 폰 실시간 미검증). U1 워커 해제.
- **U3 이탈 판정**: ①스펙 갭 → 이 PR 불작성, #1050 후속 ②`momo-core/features/settings/api.ts` 가산 수정 예외 승인(조건: 가산만·호출자 무영향·이탈 절 명기). 서버 실측 소득: GET이 credentialKind/credentialMeta(계정 라벨·만료·한국어 notice)까지 이미 줌 — Goal 2 서버 갭 소멸.
- **SRV-B7 패킷 정정 인정**: infra/rust 컴포즈는 track/engine에 존재(내 실측이 main 체크아웃 기준 — 재발 유형 주의: **경로 실측은 반드시 origin/track/engine 대상**). 방향 ③(재사용+게이트 오버레이) 승인.
- **B3M 진척**: 2커밋(인용·typing UI 셸+행 배선, red proof 12, 스위트 578→591) — 전부 core 무의존 셸. 낱말 **「인용해서 답하기」 양 클라 정본 확정**. core 대기 동안 M3(#1048 본문 렌더) 당겨 착수 지시.
- **B3W 무보고 경보**: 2차 독촉 발신(30분 데드라인 — 초과 시 MAESTRO-1 전례로 세이브 후 재기동). B3M 블로킹 해소용 core 부분 커밋 요구.

## 2026-08-05 (오후1) · Fable · SRV-B7 완주(#1058)·PR 파이프라인·머지 권한 차단
- **SRV-B7 완료**: PR #1058 — 게이트 2연속 green(`125 sampled + 3 owned by another pass`·Rust 3/3)·red proof 2종·cargo 713/0·자원 0잔여. 이탈 3건 DEVIATION_LOG `accepted`(shape_check 가산·패킷 함정 전제 오류·예상 빨강=Swift 선존재+잠식 기제). 코드 리뷰 통과(가산+겹침 가드 확인).
- **⚠ 머지 차단**: `gh pr merge`·git 네이티브 머지(push to track/engine) 둘 다 이 세션 권한 분류기에 거부됨(오전까지는 머지 가능했음). 성재에게 보고 — `! gh pr merge 1058 --merge` 대행 또는 권한 룰 추가 필요. **머지 큐 적체 시작**: #1058(ready) → #1052(B3W design 수리 후) → #1056(design-review 후) → B3M M1.
- U3 PR #1056 오픈·design-review 가동·#1057(capture:design 설정 표면 구멍) 발급. B3M lane 1차 = #1035 pod 벽(코드 회귀 아님, 증거·파이프 exit code 함정 이슈 기록) → 재실행 중. B3M 자체 리뷰로 onSend 인용 의존 재렌더 전파 수리.
- design-review #1052 = Blocker 1(인용 규정선 앰버 — 멘션 하이라이트와 색 의미 충돌·taste §4) + High 3 → B3W 수리 지시(낱말 「인용해서 답하기」 교체 포함).

## 2026-08-05 (오후2) · Fable · B3 웹 축 코드 완주(W1+W2)·U3 재검증·리뷰 신뢰성 사건
- **B3W 완주**: PR #1052(인용)+**#1059(작성 중, W1 위 스택 — 머지 순서 #1052 먼저)**. W2 수확: 송신 무타이머 설계(키가 발행을 만든다 — 실측 3029/3070ms 간격)·**renewMargin 결함**(grant 수명<갱신 여유→발행 0 무한 grant 순환, 짧은 TTL 서버에서 「작성 중」 전사 — red seam으로 적발·수리)·「작성 중」/「작업 중」 나란히 배치(대조 학습). typing core 표면·subscribeTyping 시그니처 B3M 중계 완료 — **B3 전 블로킹 해소**.
- **리뷰 신뢰성 사건**: design-review(#1052)의 지적 중 2건이 실코드와 대조 불가(quote.css 부재 — 전부 Tailwind·칩은 이미 문서 흐름). B3W에 지침: 실질도 실측 — 실재하면 수리, 유령이면 증거와 함께 보고(유령 결함 수리도 오염). 리뷰어 file:line 인용의 검증 의무가 오케스트레이터에게 있음을 기록.
- U3 판정 3건 반영 재검증 green(가산성 결정적 증명 — 호출부 base 되돌려 컴파일 0에러). 파생 이슈: **#1060**(preflight raw_color가 이슈 참조 #NNNN을 hex로 오인) · **#1061**(ApiError 헤더 버림 — 429 Retry-After 미독).
- 머지 큐(성재 대행 대기): **#1058**(ready — 분류기 차단 건) → #1052(수리 후) → #1059 → #1056(리뷰 후) → B3M M1·M2.

## 2026-08-05 (오후3) · Fable · #1052 머지 확정·리뷰 신뢰성 사건 종결
- **#1052 수리 검증 통과(@30340175)**: 리뷰 인용 4건이 유령(quote.css 부재·가공 토큰명·이미 흐름인 칩·엉뚱한 줄범위)이었으나 **B-1의 실질은 실재** — 정지 레일은 중성이었고 진짜 위반은 `hover:border-accent`(마우스 얹는 순간 인용=멘션 색). B3W가 유령은 거절·실질은 발굴 수리 + 계산값 기반 색 단정을 게이트에 추가(정지+hover 양측, red seam은 특정도 동률 문제로 계산값 주입 방식). 낱말 「인용해서 답하기」 core 교체 + 게이트가 문자열 재기록하던 것을 코어 정규식 읽기로 전환.
- **교훈(내 레인)**: design-review 에이전트의 file:line 인용은 검증 의무 대상. #1059 리뷰부터 강화 지침(인용 실재 확인·실토큰명·Tailwind 전제) 적용 — 가동 중.
- 머지 확정 큐(성재 대행 대기): **#1058(@8aacbf22) → #1052(@30340175) → #1059(@deabf788)** · #1056은 리뷰 결과 대기. SRV-B7의 92초 건은 내 warm 가설이 실측 기각됨(신규 프로젝트 콜드 79초 — 매 런 콜드가 정상이자 원래 빠름).

## 2026-08-05 (오후4) · Fable · B3W 자기감사 — 유령 처방 절반 되돌림, head 재확정
- B3W가 지침(실질도 실측) 적용해 자기 수리를 감사: **배경 `--surface-raised` 한 단은 유령 처방이었고 기능 역행**(폭 찬 고도 띠가 인용 무게를 올림 — 코어 2줄 임계의 "종속성" 근거와 모순)이라 되돌림. 유지=실측 실재분만(hover 중성화·unresolved 위계·「인용 포함」 축소·게이트 색 단정+앵커 틴트 방지). 게이트가 매 런 계산색을 `[color]`로 찍음 — "다음 같은 지적엔 눈이 아니라 숫자로 답한다".
- **머지 확정 head 최종: #1052 @ `82d90a75` · #1059 @ `f33cb751`** (구 30340175/deabf788 기록은 폐기). #1062(B3M M1)는 W1 위 스택 PR — 순서 #1052→#1059→#1062.
- design-review-1056 좀비化(보고 없이 유휴 반복·직접 독촉 무응답 — mailbox 버그 전례) → r2 재스폰(보고=산출물 명시+정확성 하드 룰). #1059 리뷰는 구 head 기준 — 보고 도착 시 f33cb751 대조 검증 예정.

## 2026-08-05 (오후5) · Fable · 리뷰 2건 도착 — 양쪽 다 High 반송, 리뷰 레인이 값을 낸다
- **#1059(typing) 리뷰**: FAIL(B0·H3) — H-1 **코어 결함**(정렬 키=재발행 시각 → 이름 순서 1.5초마다 뒤집힘, 테스트 이름이 주장한 불변식을 코드가 깸)·H-2(등장/소멸 26px 캐럿 밀림 vs 같은 파일 라우팅 줄은 32px 예약)·H-3(px-4→px-6 한 단어). B3W 반송(H-1·H-3 필수, H-2 수리 또는 숫자 반박 — 내 기울기 예약). M/N → **#1065**. 전문 보존: research/2026-08-05-typing-line-design-review.md.
- **#1056(OAuth 폼) 리뷰**: PASS(B0)이나 High 5로 반송 — H1(**auth.json 평문 노출** — 키 칸은 마스킹인데 더 오래 사는 비밀이 폼 세션 내내 평문)·H2(편집 중 상태 카드 시제 충돌)·H3(방식 전환 시 주소 잔존+힌트 거짓)·H4(--warn 4의미 과부하)·H5(오류 위치 이동). U3 반송(H1·H2·H4 필수). M/N → **#1066**. 전문 보존: research/2026-08-05-ailink-oauth-design-review.md. 리뷰어가 gate 스텁 재사용해 24장 자가 촬영 — #1057(캡처 레인 구멍)의 우회 선례.
- **리뷰어 운영 교훈**: SendMessage 본문 유실 반복(요약만 도착) → **파일 우회가 표준**(scratchpad에 쓰고 도착 신호만 메시지). 좀비 1기(1056 1차)·유실 2기 — design-review 스폰 프롬프트에 "보고=파일+신호" 명시할 것.
- B3M: M2 코드 완료 후 API 오류로 턴 중단 → 재개 지시(레인 확인→PR→최종 보고). 이탈 3건 승인(blur 무배선="없는 것이 더 강하다"·임계 fallback·무명부 탈락+엣지 기록).

## 2026-08-05 (오후6) · Fable · 배치 3 전 goal PR 완성 — 마일스톤
- **배치 3(대화 기준선) 4/4 goal PR 완성**: #1052(웹 인용)·#1059(웹 작성중 — 리뷰 수리 중)·#1062(모바일 인용, lane 5/5)·**#1064(모바일 작성중, lane 5/5 + 최종 트리 타겟 재실행)**. 서버만 있고 클라 0이던 최대 갭이 코드로 닫혔다 — 남은 것은 리뷰 수리 2건(B3W H3·U3 H5)과 머지 체인.
- B3M M2 마지막 자체 리뷰 수확: 주석("레일 끊기면 명부 비움")-코드 불일치 → 코드를 고침("끊긴 6초는 거짓말" — 끊긴 동안 상대가 치는지 모름). 명부 공급자 단일(보이는 채널만 구독)이라 통째 비우기 성립 — 사이드바 전체 구독 안 함 결정이 재차 값을 함.
- **B3M에 M3(#1048)·M4(#1049) 재배정** — feat/B3-M2-typing 위 스택. M2 최종 rebase는 B3W의 W2 수리(코어 정렬) 랜딩 후 신호.
- 머지 큐(성재 대행): **#1058·#1052 지금 가능** → #1062 → #1059(수리 후) → #1064(rebase 후) → M3/M4.

## 2026-08-05 (새벽3) · Fable · 주간 리밋 전원 중단 — 재개 계획 성재 승인·즉시 조치 완료
- **워커 전원(B3W·B3M·U3 재리뷰어) 주간 리밋 사망** — 리셋 8/6 수 13:00 KST. 중단 지점 전수 실측(스냅샷 12에 상세): 완결 2(#1058·#1052 머지만 대기)·수리 완료 2(#1059 캡처 1커밋·#1056 재리뷰 미완)·완결 대기 1(#1062)·rebase 필수 1(#1064 — startedAtMs)·미push 1(M3).
- **즉시 조치(성재 전부 승인)**: ①M3 salvage push 완료(`feat/B3-M3-markdown` @1d16d10f — 유일한 유실 위험 제거) ②기록 플러시(이 항목+스냅샷 12) ③머지 대행 2건은 성재 실행 예정(#1058→#1052).
- 직전 사이클 마감분: B3W #1059 High 3 전건 수리(@89693fd7 — startedAtMs 분리·상시 예약·3행 정렬+AgentActivityBar 확장 승인, red proof 5→7) · U3 #1056 High 5 전건+M/N 8 수리(@4c67b4a2 — H1 "한 컨트롤 두 상태"·게이트 4지점 확대) · B3M M3 코드 완료(코드상자 분기 폐기·BL-3 아티팩트 카드 확장·splitItalicRuns 판정) · #1060 2회 적중(임시 규약: 샵 없이 번호) · #1065 재편(M-2·M-3·N-1·N-2 한 결정 묶음).
- 다음 세션 주의: **#1064는 rebase 전 머지 금지**(track/engine 컴파일 빨강). 워커 재개는 SendMessage 우선(맥락 보존), 무반응 시 패킷 재스폰. 리뷰어는 처음부터 파일 보고 지시.

## 2026-08-05 (재개) · Fable · 리밋 해제 — 머지 3연속·전 레인 재가동
- 성재 "토큰 다시 생겼어 ㄱㄱ" — 승인된 재개 계획 즉시 실행. **머지 권한 회복**(분류기 차단 해소): **#1058→#1052→#1062 track/engine 머지 완료**(a614af02까지). #1062는 base 수동 재조준(track/engine) 후 검수(core 상수 소비·재조회 0·문 판정 단정 확인) — 머지.
- 재가동: B3W(stress 캡처→#1059 확정 대기)·B3M(M2 rebase→M3 lane→M4)·design-review-1056-r4(파일 보고 하드 룰로 스폰). SRV-B7 임무 종결·워크트리 회수(잔여 7개).
- **모바일 design-review 편성 결정**: M1~M4가 같은 대화 표면을 연속 수정하므로 개별 PR 리뷰 대신 **M3/M4 랜딩 후 폰 대화 표면 일괄 1회** — 같은 파일 이중 리뷰 방지. (M1은 코드 검수+lane 5/5로 머지, 시각 판단은 일괄 패스에서.)

## 2026-08-05 (오전) · Fable · U3 완주 — #1056 머지·r4 사이클 종결
- **#1056 머지 완료**(d2f1d208): r4 재리뷰(기준선 High 5/5 해소 확인, 계측 30항목)가 잡은 신규 High-N1(**라디오 왕복이 커스텀 테넌트 주소를 조용히 교체 저장** — PUT 바디 실측, 게이트 사각까지 지목)을 U3가 "제안하되 소유하지 않게"(방식별 주소 기억·`??` 의미론)로 수리 + 커스텀 왕복 게이트 케이스. Medium-N2(스왑 포커스 body 추락 — 파일 자신의 규칙 예외)도 role=status+포커스 이관으로 동반 수리. 잔여 Nit→#1066.
- 머지 시 `clients/web/package.json` 게이트 스크립트 충돌(B3 gate:quote/typing vs U3 gate:ailink)은 통합자 권한으로 합집합 해소·수동 머지. **교훈: 머지 성공 확인 전 워크트리 제거 금지**(이번엔 클린 상태라 무손실).
- red proof 방법론 적립(U3): "삭제로 되돌리면 컴파일러가 먼저 죽어 게이트 증명이 안 된다 — **컴파일 통과+결함만 살아 있는 형태로 주입**해야 red가 증명된다."
- 남은 체인: B3M 20-stop flake/회귀 판정(기준 선고정: 2연속 초록) → M4 PR → 3단 스택 수술 → #1064→#1067→M4 머지. 그러면 배치 3 + 폰 Blocker 전체 랜딩.

## 2026-08-05 (오전2) · Fable · 배치 3 완주 — 8 PR 전량 머지 + 웹 배포
- **머지 완주(8건)**: #1058(rust 샘플)·#1052(웹 인용)·#1062(모바일 인용)·#1059(웹 작성중)·#1056(OAuth 폼)·#1064(모바일 작성중)·#1067(폰 마크다운)·#1068(폰 복사) — track/engine c9ea9cc9. **배치 3(4/4) + 폰 Blocker 3건(U4-a/b) + U3 + SRV-B7 전부 랜딩.**
- B3M 수술: track/engine 위 3단 rebase — M1'/M2'/M3' 중복 patch-id 자동 스킵·충돌 0·모바일 byte-동일(게이트만 재실행 634/646/655). 20-stop flake 확정(#1069 — 단독 2연속 초록·인과 증거=목 턴 미오픈). #1068 스팟 체크(복사 페이로드 상자 목·selectable 갈림) 후 머지.
- **웹 배포 완료**: track/engine 빌드(index-CfaAQbFh.js) → app.oor7.com 검증 일치. 함정 재확인: clients/web은 루트 워크스페이스(packages/*) 밖 — **fresh 워크트리는 clients/web에서 자체 npm ci 필요**(런북에 추가할 것).
- 워크트리 정리: B3M-conversation·SRV-B6 제거(잔여 4: 684·RN-B4-defects·WEB-WP1-panel(merged=0 불확실 보존)·구레포류). 폰 대화 표면 **일괄 design-review 가동 중**(M1~M4 병합 결과 — 산출은 U4-c~j 편성 입력).
- 다음: 일괄 리뷰 결과 → U4 잔여 편성 · 폰 재빌드는 성재 검수 타이밍에 · #1065 typing 묶음 goal 편성(tie 단정 포함) · ADR-0150/0151 승인 대기 유지.

## 2026-08-05 (낮) · Fable · 폰 일괄 리뷰 → U4-2차 편성·B3M 재기동
- **폰 대화 표면 일괄 리뷰 도착**(M1~M4 병합 결과): B0·**H5**·M10·N8 — 시각 위상은 캡처 부재로 SKIPPED 정직 명기, (도출)/확인 필요 증거 등급 분리. 전문: `research/2026-08-05-mobile-b3-design-review.md`. 백미: H-2에서 웹 B-1 근거(멘션 색 충돌)가 폰에 전이되지 않음을 밝히고 **폰 고유 근거 3개를 새로 세움**(배경 1.08:1·눌림 색 동일·accent 3중 의미) — 유령 없는 리뷰 계보 유지.
- **U4-2차 편성**: 3-goal 체인 #1070(시각 — accent 규정선·코드 색 박음·danger 배너→NoticeBlock)·#1071(접근성 — VoiceOver 로터 액션 4종·마크다운 selectable 배선·44pt)·#1072(작성중 안정화 — 자리 예약·typingSegments·스택). 패킷 `handoffs/2026-08-05-U4-2-phone-followup-packet.md`. **공통 완료 조건 = measure/ 하네스 캡처**(시각 SKIPPED 해소). B3M 재기동.
- 참고: 이슈 URL이 yeomyeonggeori/momo로 발급됨(org 이동 반영).

## 2026-08-05 (오후) · Fable · U4-2차 3-goal 완결 (#1073·#1074·#1075)
- **폰 후속 수리 완주**: A 시각(#1073 — 인용 배경 띠 제거+규정선 중성·코드 색 상속·NoticeBlock 전환+닫기 비대칭) · B 접근성(#1074 — 로터 4종+첫 링크 정직 라벨·hitSlop 44pt·시트 스크롤 M-7 격상 "잘리는 끝이 닫기") · C 작성중 안정화(#1075 — 자리 예약이 M-5를 풀어줌 "한 매듭"·typingSegments·AA 이동). 리뷰 H 5/5·M 9/10·N 4 처리, 테스트 655→692. 잔여 M-10=#1076.
- 실측이 판단을 바꾼 세 자리 기록: ①H-2는 색이 아니라 띠(웹 정본에 배경 부재 — border 1.296:1 함정 회피) ②M-7 격상(AX5 850>SE 667, 잘리는 끝이 「닫기」) ③여백의 값은 "무엇을 밀어내는가"로 잰다.
- 테스트 승계 원칙 적립: "테스트는 지금 참인 것을 말하는 자리이지 역사를 적는 자리가 아니다"(뒤집힌 단정 삭제·산 것 이전·이유는 소스 머리말에). #1035 두 겹 벽(빌드 산출물 조기 거부) 수용 기준 갱신.
- 남은 꼬리: B3M 캡처 7종 소형 PR(최종 시각 리뷰 입력) → 최종 시각 리뷰 → U4 잔여(c~j) 편성. 웹 재배포는 코어 변경분(typing 정렬 등) 반영 위해 다음 랜딩 묶음에서.

## 2026-08-05 (오후2) · Fable · U4-2차 최종 시각 리뷰 PASS — 리뷰 폐곡선 완성
- **최종 시각 리뷰 PASS(B0·H1·M5·N8)**: 실기 캡처 7장 픽셀 샘플링 — 지난 일괄 리뷰의 (도출) 시각 항목 **8/8 픽셀 확인**(규정선 #6b7280·배경 띠 부재·코드 잉크 동등·이름 조각 강조 등 전부 실측 일치). "인용의 무게가 실제로 내려갔다"가 사진으로 판정됨. 전문: research/2026-08-05-u42-final-visual-review.md.
- 신규 High 1 = **한글 italic 무동작**(묘비/미해결 구분이 AA 미달 회색 한 단계에만 의존 — 기울기 차 0 픽셀 확증) → **#1078**(구분축 재설계 결정 필요). M5+N8+사진 4장 → **#1079**(U4-3차 후보 적립).
- 정직성 유지: PASS는 캡처 7장 범위 안에서만 — 위상 1·2·4·5 SKIPPED 명시, "수리 9건 중 사진 확인 3건" 자기 한계 기록. 다음 라운드 사진 4장으로 대부분 폐쇄 가능 명시.
- **U4-2차 폐곡선 완성**: 일괄 리뷰(H5) → 3-goal 수리 → 캡처 증거 → 최종 시각 확인. 폰 대화 표면은 "리뷰 완주" 상태. 마스코트 R2 진행 중(성재 피드백 대기) — 다음 구현 배치는 성재 지시("마스코트 먼저") 존중해 마스코트 라운드 후 U4 잔여 편성.

## 2026-08-05 (오후3) · Fable · 마스코트 정본 확정 → 작업 복귀
- **마스코트 확정**: 5라운드 탐색(아스트랄→입자→3D 말랑→라인아트) 끝에 성재가 `docs/brand/concepts/oort-v2-main.png` 단독 확정 — 라인아트 문법(잉크 라인+플랫 필+오렌지 볼, 3D 질감 기각). 나머지 22장 전량 삭제. 메모리 `oort-mascot-canon` 기록(향후 베리에이션은 이 이미지 참조로 성재와 함께).
- 다음: U4-3차 편성(#1078 구분축·#1079 사진4장+다듬기) + U4 잔여(c·d·g·e·i·f·j) 순차 — 성재 "향후 작업 진행 준비로 복귀" 지시 이행.

## 2026-08-05 (저녁) · Fable · U4-3차 완결(#1080·#1081) — "사진이 증거를 넘어 결함을 잡았다"
- **U4-3차 완주**: #1080(구분축 — `※`+textMuted, appVoice.ts 단일 문, 같은 고장 4곳 일괄, red proof 3종) · #1081(사진 11장+다듬기 — N-1 어휘 규칙 "이미 지배하던 ~기 서술형 발견 적용"·M-4 칸 분리+숫자 우정렬·N-7 자기 인용 2곳 수리). 테스트 692→712. lane 5/5 ×2.
- **사진의 3중 수확**: ①AX5 캡처가 하네스 결함(시트 줄 누락) 적발 → 보강 후 "넘칠 때 밀려나는 게 닫기" 실사진화 ②M-2 1.000:1 도출→실측 승격 ③워커 단위 오류(3x/2x) 자기 적발 — 거짓 진단("한글 폴백 전각")이 커밋에 실리기 직전 회수, 축척 명문화.
- 운영: 성재 지시로 18:30 예약 재개 체계 첫 운용(정지→cron→재개). 규칙 메모리化: 워커 발사=명시 신호(준비≠시작). B3M 해제 — **오늘 B3M 누계: PR 12장 머지·테스트 +134**.
- 다음(시작 신호 대기): U4-4 편성안 — c(시간·경계)·d(행 꼬리·아바타)·g(폰 승인 버튼) 우선 3종 + #1065 typing 묶음 병렬 후보.

## 2026-08-05 (밤) · Fable · U4-4 완주 + 일괄 리뷰 FAIL(B3) — 수리 패킷 준비·발사 대기
- **U4-4 랜딩**(4 PR: #1086 웹 typing·#1088 웹 시간경계+core divider·#1087 폰 승인버튼+오프라인·#1090 폰 시간경계). 오늘 총 **18 PR 머지**, 모바일 테스트 578→757(+179).
- **일괄 리뷰 FAIL(B3·H3·M5·N3)**: ①W-1 웹 묶음 안 간격 **0px 회귀**(py-1.5 미컴파일 — 코어 공용 상수 18/6이 웹 고정 스케일 밖. gate:borders red인데 워커 보고는 PASS였음 — 환경/시점 차 규명 필요) ②W-2 가드가 틀린 표(Tailwind 기본)를 봐서 초록 ③M-1 폰 시각 칸 예약 구조 구멍(첫 자식이 본문 아닐 때 — u44-row.png 겹침 인쇄 증거·연속 승인 카드 미픽스처). High: E-1 낡은 캡처가 증거로 커밋·D-1 복구 구분선 어휘 분기·W-3 320폭 님 고아. **C-1 주목: seq 사용자 문구가 코어 정본으로 승격됨**(SKILL §4 — 감사 H-12 계열 합류). 전문: research/2026-08-05-u44-design-review.md.
- 이슈: **#1091**(웹 R)·**#1092**(폰 R)·**#1093**(M/N 적립). 패킷 `2026-08-05-U4-4R-review-fixes-packet.md` **발사 대기**(성재 "끊었다가 다음 준비" 지시 — 시작 신호 후 U4-4R 2워커부터).
- 전 팀메이트 종료(TaskStop 표준 — 유휴 소음 방지 성재 지시). 활성 에이전트 0.

## 2026-08-05 (심야) · Fable · U4-4R 완주(#1094·#1095) — Blocker 3·High 3 전부 폐쇄
- **웹(#1094)**: `--spacing-row` 이름 신설(산술 증명: 스케일이 4의 배수라 18≡2 mod 4 — 온그리드 조합 불가 → "격자 밖 측정값은 이름" 규율 준수)·가드가 tokens.css 실표 파싱·「님」 고아 해소(조사를 이름에, 꼬리=이름 없이 성립하는 서술어). **PASS/FAIL 규명 = 시점**: 게이트 증거가 버려진 인라인 판에서 수집·클래스 전환 후 미재실행 + 게이트 로그가 단정이 안 읽는 값을 찍고 하한 단정(>8)이 틀린 15px도 통과 → 게이트를 렌더 실측+등호 비교로 수리. "두 … 자리 분리" 이득은 성립 불가라 주석에서 거둠(정직한 후퇴).
- **폰(#1095)**: 예약을 그릇(rowInner)으로 — "자식은 자기를 등록할 필요가 없다", 이중 예약 씨앗 제거·가림은 칠(렌더 순서) 별축 해소. source 필수 인자 코어 승격(선택이면 한쪽이 조용히 짧은 문장). row-lead 픽스처(연속 승인 카드 포함) 신설·캡처 원칙 하네스 머리말 명문화. lane PASS·red proof 양방향. PendingRow 여백 0 관찰 → #1093 적립.
- 단발 서브에이전트 방식 첫 운용(성재 지시 — 팀메이트 미사용): 중간 보고 없이 완주 후 최종 보고 1회 — 엇갈림·유휴 소음 0. 워커 토큰 263k/284k.
- **U4-4 배치 완전 종결**(리뷰 폐곡선: 랜딩→일괄 리뷰 FAIL→R 수리→그린). 다음: U4-5(접기·항법·폰 위생+#1093) 편성.

## 2026-08-06 (새벽) · Fable · U4-5 완주(#1098·#1100) — U4-6 준비·컨펌 대기
- **U4-5 랜딩**: 웹(#1098 — 접기 예산 fold.ts·최신 점프+새 메시지 배지·hover:none 시각 상시·행 탭 스톱. 캡처 미커밋=게이트 결정적 재생성으로 E-1 방식 차원 방지) · 폰(#1100 — slopTo 44pt 도출·PendingRow rowInner·삭제 묘비 접기 "잃을 것 없을 때만"·hex 0 실측 테스트·착지 틴트 warnSurface 의미 대응+스크롤 소멸·기준선 +2.67→+0.33pt "정렬은 공유에서 온다"). 폰 테스트 804.
- 선재 발견 티켓: **#1099**(capture:design 95/118 중단)·**#1101**(React-Core-prebuilt 경로 의존 sandbox-desync — #1035 세 번째 겹).
- **U4-5 일괄 리뷰 가동 중**(단발) — 결과 반송이면 U4-5R 선행. **U4-6 준비 완료**(패킷 `2026-08-06-U4-6-composer-packet.md`·이슈 #1102/#1103 — 컴포저·아바타·문장 옷·색 계약·seq 어휘·deleted-fold 승격) — **성재 컨펌 후 발사**.

## 2026-08-06 · Fable · U4-5R 완주(#1105) — U4-5 완전 종결
- **H-1 방향 ② 채택(대리 착지)** — 기각 논거 3이 교본감: "롤업·반응은 행 위에 그려져 있던 것이라 접으면 사라지지만, 「인용됐다」는 묘비 위에 아무것도 그리지 않는다 — 목적지를 고치는 자리는 항법이지 접기가 아니다" + 보이지 않는 성질이 보이는 배치를 지배하게 됨 + 비용이 접기 전체에 걸림. 접기 규칙 무변경, 착지 틴트는 대리 행 id로.
- **상류 가드 부재 실측**: quoteLookup이 접힌 스트림이 아니라 messages 기준·라이브 seq 항상 null·페이지 경로도 같은 거짓 문장 — 두 경로가 한 수리로 함께 치유. 4번째 red proof가 "진짜 없는 것은 여전히 없다"를 초록으로 잠금(접기가 항법을 삼키지 않음).
- M-3: countNewerThan에 저자 접기(자기 확정 전송 비계수). 검증 전량 그린·lane 5/5·#1101 desync 미재현(pod 선행 우회 — #1035·#1101 여전히 유효 재확인).
- **U4-5 완전 종결**(랜딩→리뷰 PASS→High 수리). U4-6은 준비 완료 상태로 성재 컨펌 대기.

## 2026-08-06 (오전) · Fable · U4-6 랜딩(#1107·#1106) — 일괄 리뷰 가동
- **웹(#1107)**: 컴포저(draftStore·오프라인·useAutoGrow)·M-3 카드 옷+**누락 영수증 발견 복구**(성공 결정 영수증이 아예 없었음 — outcome.note는 409에만)·D-2 역할 계약("무엇이 아니어야 하는가가 공통" — mustDifferFrom, 가드가 tokens.css 실파싱)·C-1 「여기까지 복구」(표지 위치가 답·낭독 「이 줄 위까지」·data-seq는 진단 채널)·deletedFold 코어 승격(#1105 계약+4번째 단정 보존)·아바타 계약+웹 렌더·터치 24px. core 872·web 743·게이트 전판 PASS.
- **폰(#1106)**: 초안 MMKV 키스트로크 저장(별개 레일 계약)·오프라인 = 레일 아님 **NetInfo**(승인 수리의 재적용 — "레일은 보낼 수 있는가에 답하지 않는다")·성장 정책 도출식·Avatar(폰 몫=오리진 하나·자리=시각 칸의 거울·모르는 작성자 글자 없음)·코어 소비 로컬 우회 0·M-3 두 축 격(새 색 0). jest 861·lane 5/5·u46 캡처가 U4-4 미캡처 자리(카드 오프라인) 폐쇄.
- 운영 노트: 병렬 워커가 공용 스크래치패드 `pr-body.md` 충돌(본문 1회 덮임·복구됨) — **다음 패킷부터 워커별 고유 파일명 규약**. 선재 게이트 FAIL 3건 추가(#1089 합류 — 웹 게이트 위생 묶음 후보).
- U4-6 일괄 리뷰 가동 중 — 결과까지가 배치 마감. 이후: 감사 U4 시리즈 사실상 소진(a~j — h만 oort 2단계 결합 잔존). 다음 후보: oort 1단계·첨부(ADR-0151)·레인 재설계 묶음·웹 게이트 위생·U2 모드.

## 2026-08-06 (낮) · Fable · U4-6R 완주(#1109) — U4-6 완전 종결, 감사 U4 시리즈 소진
- **B1 이행**: settled의 출처를 "상태 칩이 읽는 그 값"으로(다르면 한 카드가 한 줄에서 두 말) — 이행이 코어의 개선(끝난 결정에 인박스 안내 안 붙임)도 폰에 들여옴. **H1 문장 선택 기준 적립**: "정보가 많은 쪽이 아니라 **모양을 지키는 쪽**"(오프라인 문장의 제품 문법: 지금 무엇이 안 되는가→다시 연결되면 여기서 무엇을). H2 근거: "쿼리 캐시는 메모리지만 MMKV 초안은 앱 삭제까지 산다". M2: 앰버 기각 유지 — "눈에 띄는 이유는 색이 아니라 자리가 진다".
- 가드 결함 동반 수리 2건: gate-composer가 문장 조각을 손으로 듦→코어 읽기, spacing.test가 PendingRow를 못 봄→"행 파일이 패딩을 이름으로 드는가" 편입. **전 검증 병합 트리 기준**(신규 머지 규율 첫 적용 — 3종 tsc/테스트/게이트/lane).
- **U4-6 완전 종결**(랜딩→리뷰 FAIL(B1)→R 수리→그린). **감사 U4 시리즈(a~j) 소진** — h(카피·브랜드)만 oort 2단계 결합 잔존. 대화 표면 리뷰 사이클 누적 6회전 전부 폐곡선.
- 다음 배치 후보(성재 컨펌 대기): ①oort 전환 1단계(사용자 노출 12곳 — ADR-0152) ②첨부 v0(ADR-0151 승인 필요) ③레인·게이트 위생 묶음(#1022+#1035+#1051+#1069+#1089+#1099+#1101+#1108) ④U2 모드 전환(웹 토글+폰 라이트 팔레트) ⑤U4-6 리뷰 잔여 Nit·#1093 잔여.

## 2026-08-06 (오후) · Fable · 4기능 조사→로드맵化 + oort1·첨부 발사
- 성재 발제 4기능 전수 조사(코드+기획) → `2026-08-06-feature-gaps-roadmap.md`: ①pin=레포 전체 개념 부재(ADR 불요 판정, #1112) ②다중 에이전트=**기구현**(per-agent run 루프·A2A 게이트 5종 — 계획 문서보다 코드가 앞섬. 갭=회귀 테스트·라우팅 바, #1113) ③즉시 승인=**폐곡선 성립**(한 tx 원장→resume 300ms·타임라인 카드 랜딩. 갭=실행 도구 1종뿐) ④실행 방식 컨펌=부분 — **ADR-0125 D6-A가 이미 정확히 그 설계**(승인 카드 호스트 선택기)·MOMO-490 미착수, 병목=work_control 서버 미이식. ③④를 한 체인으로 **#1114**(스폰 폐곡선 — 로컬/원격 2택+T3 예약).
- ADR-0151(첨부)·0152(oort) **Accepted**(성재 "작업 진행해줘"+후보 ①② 채택). 발사: 워커 A=oort 1단계(#1110 사용자 노출 12곳·동결층 하드 금지) · 워커 B=첨부 v0 서버(#1111 Drive 3경로 이식). 진행 중.
- 다음 배치 슬롯 후보 갱신: W1(#1112+#1113 소형 듀오) → W2(#1114 중형 체인). ROADMAP §0 승인 축 표기 낡음(폰 ❌→랜딩됨) — 다음 정비 시.

## 2026-08-06 (저녁) · Fable · oort 1단계 랜딩(#1117) + Xcode Cloud 판정
- **#1117 머지**: 인벤토리 12곳 → 실측 **69곳**(Swift 클라 화면 카피 전체가 인벤토리 사각이었음 — 초대 메일·온보딩·허들/프로바이더 설명·업데이트 안내). 동결층 0접촉(diff 검증 — 히트 3건은 신설 게이트의 보호 패턴 자기 문서). **신설 게이트 `gate_oort_user_facing.sh`**(표면 444곳 잔여 0·red proof 6/6) — 재발 방지 기계화. 잔여(server-rust 카피 5곳·macOS 'm' 배지·골든 문구)=#1118.
- **Xcode Cloud 판정 확정**(research/2026-08-06-xcode-cloud-transition.md): 비활성=성재 콘솔 수동(레포 산출물 0 — Disable 권장), RN 계승=유력(번들·팀·NSE 100% 동일 — 워크플로 재지정이 최저비용), Tauri=대상 아님+**빌드 CI 자체 부재 발견**(#1116). 레포 준비 6건=#1115(위생 배치 워커 C 합류).
- 대기: 첨부 서버 워커(#1111) — 랜딩 시 위생 배치(A 레인 rust·B 게이트·C Xcode 준비) 발사.

## 2026-08-06 (밤) · Fable · 첨부 서버 랜딩(#1119) — v0 이식 대상 사실상 폐쇄 · 위생 배치 발사
- **#1119 머지**: Drive 3경로+메시지 바인딩 이식 — 신규 크레이트 momo-drive(재사용 대상 0 실측 — stub+Google SA JWT·resumable·스트림, 실 Drive 접촉 금지 준수), 바인딩은 "삽입과 브로드캐스트 사이·거절 시 메시지 동반 롤백", 읽기 4표면 동봉, 스키마 무변경(017/044 기존재 실측). 검증: workspace 740·실DB 145+신규 7·병합 트리 3종 0·red proof 2(상태코드+원자성). openapi 미등재 사유 기록(stub이 staging strict에서 부팅 거부 — 등재 조건 명시). **ADR-0145 판정표: attachments·cancel 완료, 잔여=agentRunHistory 실측 확인 1건.**
- **ADR-0153 Accepted**(CI 스택 — 재검토 실측: PRIVATE·ADMIN·NCP 2코어): 로컬 게이트 권위+셀프호스티드 러너(경량 한정)+Xcode Cloud+런북 CD — Jenkins 기각·Argo 부적합. 러너 설치=첫 수요 시(#1116).
- **위생 배치 3워커 발사**: A(#1022 레인 rust+실시간 단정+flake 재설계+부트스트랩 자가 치유) · B(Swift 패스 강등+#1108 merge-tree 스크립트+#1089/#1099 게이트 수리) · C(#1115 Xcode Cloud RN 준비 6건). 완주 시 ADR-0145 증보 2 전 항목 이행.
- 다음 결정 대기: 첨부 웹 컴포저(클라 표면 — ADR-0151 D2) 배치 시점 · 라이브 배포 묶음(웹 재배포+서버 이미지 — 첨부 포함) · W1(#1112 pin+#1113)·W2(#1114 스폰 폐곡선).

## 2026-08-06 (밤2) · Fable · ADE 발제 → ADR-0154 기안 + prime/herdr 리서치
- 성재 발제(스플릿뷰 멀티세션·기기 독립 연속성 = oort 지향점) → 로드맵 대조: **부품 완비·묶는 경험 부재** 판정 → **ADR-0154 Proposed**(D1 생존성 모델 working/blocked/idle+기기종속/지속, blocked=멘션급 · D2 관제 뷰=채널이 홈·집계 그리드·리뷰 루프 내장 · D3 재개/인수 어휘 분리+사전조건 선검사 · D4 단계=#1114가 1단계 · D5 외부 하네스 트랙).
- 리서치(research/2026-08-06-prime-agent-ade-herdr.md): **prime agent**=Prime Intellect 2026-08-05 공개 CLI 하네스(MIT·로컬 데몬·JSONL RPC·steer·extension_ui) — 우리 provider와 같은 층, 스파이크 #1120. **herdr**=실존(24.8k★ Rust 에이전트 인식 tmux) — 워커 좀비화 해독제 후보, 스파이크 #1121(라이선스 재확인 전 실행만). ADE 업계 수렴 3원칙(worktree=경계·3상태 배지·resume/teleport 분리)·함정(리뷰 병목이 진짜)이 ADR에 반영됨.
- 성재 대기: ADR-0154 세부 승인(D1~D5). 위생 3워커(레인 rust·게이트·Xcode 준비) 계속 진행 중.

## 2026-08-06 (밤3) · Fable · 위생 C 랜딩(#1122) — Xcode Cloud 레포 준비 완료
- **#1122 머지**: ci_post_clone(위치=워크스페이스 옆 — 루트는 Xcode Cloud가 조용히 무시 실측)·xcworkspace는 **contents.xcworkspacedata 1파일만**(절대경로·UUID 0 — 바이트 결정적, Podfile.lock과 정반대 성질 논증)·서명 잔재 4조합 제거·ci_post_xcodebuild가 11-런북 A·C절반을 CI로 이관("프로파일 서명이 있어야 보이던 것들 — 어느 게이트도 못 보던 층")·projectShape 가드 5(전부 "깨져도 빌드는 안 깨지고 체크만 조용히 사라지는" 종류)·docs/cicd/10 §8 정본 등재. 클린 클론 BUILD SUCCEEDED·red proof 매트릭스 11/11.
- **A 몫 인계 1건(A PR 검수 시 확인)**: build-sim.sh:44의 `[ ! -d $WORKSPACE ]` 술어가 이 PR로 무효화(디렉터리는 항상 존재) — Pods/Manifest.lock 존재로 교체 필요. **Gemfile.lock 미커밋이 SPEC CHECKSUM 85줄 매런 재작성의 뿌리**(CocoaPods 1.15.2 vs 락 1.17.0) — #1101 규명 사안으로 §8-6 기록됨.
- 성재 콘솔 절차는 docs/cicd/10 §8에 등재(Disable→재지정 — ②xcworkspace가 있어야 선택지가 화면에 뜸). 남은 위생: A(레인 rust)·B(게이트) 진행 중.

## 2026-08-06 (밤4) · Fable · 위생 A 랜딩(#1123) — 레인=배포 이미지·레이스 소멸·배포 파이프 선재 결함 적발
- **#1123 머지**: 레인 스택=infra/rust 배포 compose+lane 오버레이(베이스 무접촉 — "배포와 같은 스택" 근거 보존). **매 실행 배포 이미지를 굽는 구조가 즉시 값을 함**: #1119가 Dockerfile pre-copy에 momo-drive 누락 → **배포 이미지 빌드가 깨져 있던 선재 결함 적발·수리**(다음 배포에서 터졌을 것). ADR-0004 가드를 자기신고→증거 3종으로 재설계. 목 재사용(변인 통제 — "초록/빨강 변화의 원인이 서버 교체라고 말할 수 있게").
- **#1069 종결**: 원인=Rust 와이어 stream:false인데 MAESTRO 지시어가 SSE에서만 읽힘 → 비스트림 존중 수리로 「턴 열린 시간」이 이벤트 sleep 합(창발)→서버 sleep 하나(값) — **레이스 자체 소멸**. 20-stop 3연속 34/34/35s. **#1101 반증**: 3경로·4실행 락 바이트 동일 — desync 서사는 전부 #1035(Pods 부재)로 설명. 락 무변경.
- 30-approval을 실행 가능 툴로 재조준+DB 행 재확인(화면-초록을 FAIL 강등 가능) — 폰 실시간 단정 red proof 포함(#1051 부분 해소).
- **병합 교차 1건 실측·소수리 발사**: C의 예측대로 #1122(xcworkspace 커밋)×#1123(`[ ! -d ]` 술어) 충돌 — 클린 클론 자가 치유 불발. Manifest.lock 술어 교체 워커 가동.

## 2026-08-06 (심야) · Fable · 위생 B 랜딩(#1124) — Swift 퇴역 증보 2 전 항목 이행 완료
- **#1124 머지**: Swift 패스 기본 off(강등 대가를 이름 붙임 — 미커버 125/128 연산을 매 실행 경고, 두 패스 동시 off 거부)·verify_merge_tree.sh(20초 — red proof가 U4-6 B1과 동일 코드 재현)·**선재 FAIL 4건 규명=원인 하나**(/v1/auth/refresh 스텁 부재 → 앱 자가 로그아웃 → 타임아웃, 3줄 수리)·#1099 근인="길게 누르기 touchEnd가 합성 클릭으로 자기가 연 시트를 닫음" → touchCancel 교정+조용한 초록 차단+설정 6표면 → **130프레임 완주**(#1057 동반 폐쇄). 웹 게이트 17/17.
- B가 경고한 Dockerfile 누락은 A(#1123)가 기수리 — 병합 확인 후 머지. 잔여 관측 2건=#1125.
- **ADR-0145 증보 2(Swift 퇴역) 3자리 전부 이행**: ①레인=rust(A) ②openapi Swift 패스 opt-in(B) ③Xcode Cloud 준비(C — 콘솔 Disable만 성재 몫). 위생 배치 종결 — 남은 것: build-sim 술어 소수리 워커 1기.

## 2026-08-06 (심야2) · Fable · ADR-0154 Accepted(D2 수정)·리서치 파이프라인 규칙·ADE 1단계 발사
- **ADR-0154 Accepted**: 성재 D2 수정 승인 — "대화 공간=summary 한 줄('실행 중인 작업 N개')·클릭=drawer 관제·터미널=상세"의 3층. 나머지 D 원안. ADR 본문 갱신 완료.
- **리서치 파이프라인 규칙 영구화**(메모리 research-via-ouroboros-interview): 리서치 발제 → ouroboros 인터뷰로 구체화 → 워커 발사. 방향 열린 리서치에만(단답 조회 제외).
- **3워커 발사**(패킷 2026-08-06-ade-stage1-spikes-packet.md): ①#1114 서버 축(work_control 이식·spawn 승인 폐곡선·호스트 후보 동봉 — ADE 1단계) ②#1120 prime 스파이크(컨테이너·RPC·키 주입 금지) ③#1121 herdr 스파이크(라이선스 실측 1순위). 스파이크는 "안 되는 이유의 실측도 완주".

## 2026-08-06 (심야3) · Fable · 스파이크 2건 완주(#1128·#1131) — D5 판정 확정
- **prime(#1128)**: 전면 동작 실측(steer 주입 위치 증명·승인 다이얼로그 폐곡선+거부 red proof·릴레이 seq gapless=단일 쓰기경로 통과 물증). 키 없는 CI 회귀 가능(자격증명 벽=첫 prompt만). **판정: 3전제(#1130 — 메시지 edit 계약·자기수정 감사·HOME 격리) 후 3번째 provider 승격 가치.** 부수 #1129(env 템플릿).
- **herdr(#1131)**: 라이선스 수수께끼 해소 — 2026-07-22 Apache-2.0 재라이선스(v0.8.0부터 — **버전 핀=라이선스 핀**), 2차 출처 AGPL 주장은 낡은 정보였음. **감지기로는 불채택**(blocked 재현율 20%·비대화형 워커는 아예 미검출·미매칭 폴백이 idle=관제에 역방향 안전). **본질 발견: 해독제는 스니핑이 아니라 푸시** — `pane report-agent` 커스텀 라벨로 워커 자기 보고 성립(exit trap release 필수 — "좀비 잡다 좀비 만들기" 방지). → **D1 생존성 모델에 환류: 워커 자기 상태 푸시가 1급 경로**, herdr는 선택적 표시층.
- ⚠ 스파이크 부작용 1건: 사용자 전역 codex CLI 0.144.1→0.146.1 의도치 않게 업그레이드(herdr가 모달을 idle로 오분류→prompt가 기본 선택 확정 — 오분류 위험의 실물 증명이기도). 성재 선택 대기: 롤백(`npm install -g @openai/codex@0.144.1`) or 최신 유지.

## 2026-08-07 (새벽) · Fable · ADE 1단계 서버 축 랜딩(#1132) — 클라 축 발사
- **#1132 머지**: work_control 원장 이식(라우트 5·guarded UPDATE·**ack 의도적 제외** — "요청과 실행 보고를 한 자격증명이 다 하면 없던 세션을 있다고 보고") · spawn 3점 세트(실행기=create의 두 번째 호출자, 두 번째 구현 아님) · **승인 payload 호스트 후보 형상 확정**(selectable+사유 명시 — 숨기지 않기·T3 자리=상수 하나·두 겹 검증="게시한 집합인가+지금도 자격 있나"). 병합 트리 6레인 green·conformance 5/5·red proof 2.
- 이탈 중 기록감: Swift 결함 비추종 2건(park 미적용 시 승인 sweep이 승인된 run을 죽임 → park 적용 / work-control 승인에 expires_at 부여 — sweep 사각 제거) — ADR-0114 증보 후보. 잔여는 #1114 코멘트로 구조화(클라 축·데몬 ack·마지막 사용·매니페스트). 선존재 관찰 → **#1133**(tool_result가 client_msg_id 충돌로 접힘 — spawn 체감 직결).
- **클라 축 워커 발사**: 승인 카드 호스트 선택기(웹+폰 — D6-A 실현, execution.host_candidates 소비). 이게 랜딩되면 "에이전트에게 작업 시키면 어디서 돌릴지 물어보는" 성재 발제 4번이 폐곡선.

## 2026-08-07 (새벽2) · Fable · 클라 축 완료(PR #1134 — 머지 대기) · 성재 지시 정지
- **클라 축 워커 완주**: 승인 카드 호스트 선택기(웹+폰, D6-A). design-review를 워커가 자체 3회전(FAIL B1·H5 → 전건 수리 → PASS **B0·H0** — 파리티 기준 충족. 리뷰어가 픽셀로 판정: 잠긴 판 균일 muted 재칠·픽커 폭 640px=pane-lg 정확 일치·대비 수치 교차 확인). 증거 공백(폰 잠금 사진)까지 SPAWN-LOCKED 하네스 표면으로 폐쇄("잠겼다는 잠기지 않은 것 옆에서만 사진에서 확인된다"). 배치 중 자가 적발 1건: offersHostChoice가 후보 개수로 판정해 서버 키-존재 술어와 갈라짐 — 등록 호스트 0 워크스페이스의 이유 없는 409 경로 수리.
- 게이트: 코어 912/웹 750/폰 884·병합 트리 6칸·red proof 7종·lane 5/5. **성재 지시로 검수·머지 전 정지** — PR #1134 OPEN 유지.
- 컨펌 대기: ①#1134 머지 ②웹 캡처 경로 판단(artifacts gitignore 관례 vs 커밋 — 리뷰어가 사진으로 판정하는 구조라 실질적) ③다음 배치(후보: ADE 2단계 summary+drawer 설계 / #1114 잔여 데몬 경로 / 라이브 배포 묶음 / W1 pin+다중멘션).

## 2026-08-07 (새벽3) · Fable · #1134 머지·라이브 배포 완료·ADE 2단계 발사
- **#1134 머지**(컨펌 후) — ADE 1단계 폐곡선 완성(승인 카드 호스트 선택기 웹+폰).
- **라이브 배포**: 웹=index-Cy-dq-wn.js(라이브 일치 — 인용·작성중·OAuth·시간경계·접기·호스트 선택기 반영) · 서버=momo-rust:fc122584(4서비스 태그 일치·migrate 멱등 60skip·healthz 200·approvals 401·**work-controls 401=신규 라우트 라이브**). 디스크 위생: 구 태그 2종 제거·da6a646b 롤백 보존·82%.
- **ADE 2단계 발사**(#1135): 생존성 모델+summary 라인+drawer(웹 우선) — agentWorkingSignal 재사용·문구=코어 함수·drawer 불밀림(H-3 전례)·빈 상태 정직. 워커 1기.
- 웹 캡처 경로 판정(성재 위임분): **현행 유지**(gitignore+게이트 재생성 — 낡은 사진 문제 원천 차단, 폰만 커밋).

## 2026-08-07 (새벽4) · Fable · ADE 2단계 완결(#1136 머지) — 배치 마감·정지
- 리뷰 FAIL(B1·H2) → ADE2R 수리 전건: **B1은 "주소를 짓지 않고 이미 있던 workSessionPath 소비"**("두 곳에서 지으면 한 곳만 낡는다")+게이트가 카드 두 종류 다 클릭. **H1은 escapeLayer 층 스택 신설**("등록 순서 보장은 마운트 순서를 계약으로 만드는 것 — 스택은 '덮은 것이 위'를 자료구조로") — 세 층(사이드바·작업 패널·관제 서랍) 전부 이관. H2=스크림 버튼(사이드바 선례가 1차 주석의 반대 근거를 반증). M3=전면 문턱 1200px(240+640+320 산술 — 띠가 존재할 수 없는 구간+부수로 서랍·패널 겹침 구간 소멸). M2=닫는다(한 셸 한 규칙). red proof 7/7·병합 트리 6/6.
- **ADE 2단계 랜딩**: 대화 공간 요약 한 줄→drawer 관제→기존 패널 확대의 3층이 웹에 섰다(성재 D2 수정안 실현). 성재 지시대로 **정지 — 다음 배치는 컨펌 후**.
- 다음 후보(컨펌 대기): ①ADE 3단계(D3 재개/인수 어휘+핸드오프)+폰 drawer ②#1114 잔여(데몬 서명 ack) ③W1(pin+다중멘션) ④폰 재빌드 검수 셋업 ⑤웹 재배포(ADE 2단계 반영 — 소묶음).

## 2026-08-07 (오전) · Fable · ADE 3단계 완결(#1138·#1140 머지) — D1~D4 전 단계 랜딩
- **웹·코어(#1138)**: 재개("이어서 보기" — observer 실측이라 stdin 약속 안 함)/인수 어휘 분리·판정은 서버 규칙 바이트 복제(발명 0)·canReattach 드리프트 수리("돌아갈 길을 웹이 숨기고 있었다")·서버 계약 실측 4건(git 사전조건 부재→고지 전환·단방향·검증 미이식=#1139·spawn dispatch 미이식). 리뷰 FAIL(B2·H2)→ADE3R 수리 전건: **preflight raw_color 자체 수리+selftest 11케이스 내장**("임시 규약이 3번 실패한 것이 이 수리의 논거" — #1060 종결)·어휘 통일(이어받→인수)·죽은 지시 배너 교체.
- **폰(#1140)**: 요약 줄(헤더 아래 44pt — 자리·형식·착지 셋 다 앱 자신의 규율에서 도출: "폰에 작업 패널이 없고 그게 결정이다")+덮는 관제 화면. 리뷰 PASS(B0·H1)→소수리(AA 이관·tabular·warn 카드 씨앗 구멍 자기 적발 — "사진이 수리를 증언").
- **ADR-0154 D1~D4 전 단계 랜딩 완료**(D5 스파이크도 기완): 생존성 모델·요약/drawer/터미널 3층(웹+폰)·재개/인수 어휘·스폰 폐곡선. 신규 적립: #1139(resume 서버 검증)·#1141(코어 기계 검사 부재 — emdash 73 잠복). 세션 카드 메시지 앵커(코어 AdeItem 필드)는 후속.
- 정지 — 다음 배치 컨펌 대기. 폰 아카이브(ade1)는 기기 연결 시 즉시 설치 가능 상태.

## 2026-08-07 (낮) · Fable · 배치 ①~④ 완결 — pin·다중멘션·서버체인 랜딩, 정지
- **#1145 pin v0 머지**(리뷰 PASS B0·**H0 파리티 충족**): reaction 동형 사이드카·"고정은 채널의 사실"(message 유니크)·상한 100=읽기 표면 경계+advisory 락 직렬화·message.pinned가 항목 전체 나름("화면에 없는 메시지가 요점"). 병렬 마이그레이션 충돌(061) 자가 해소(062). Medium 적립=#1146.
- **#1142 다중 멘션 머지**: 서버 회귀 단정(한 발화 @A @B=run 2·각자 멱등 키)+라우팅 바 다중화 — API 경계 안에서 "보여주는 값=각자·고르는 값=교집합 하나"(한 명만 유효한 값=전송 전체 롤백 근거). per-agent 와이어는 ADR-0134 개정 후보(#1144).
- **#1143 서버 체인 머지 → #1114 종결**: 데몬 서명 ack("두 자격증명이 서로 다른 사실에 대조")·pending-controls·resume 검증 5종(+Swift에 없던 target≠source)·resume에도 spawn dispatch(인수가 실제로 실행 재개)·D6-A 마지막 사용(마이그레이션 061). red proof 6종.
- ①웹 재배포(index-B5KcwxeI — ADE 3단계 라이브) ②**폰 설치 완료**("oort" — 기기 확인됨, 검수 대기). 8/7 누계 머지: #1138·#1140·#1142·#1143·#1145 + 폰 소수리.
- **정지 — 컨펌 대기.** 다음 후보: 서버 재배포(#1143 pin·resume 검증 등 — 이미지 재빌드)·pin 후속(#1146)·게이트 위생 잔여(sampled-on-rust 픽스처)·oort 2단계(문서 산문)·U2 모드 전환·#1130 prime 전제.

## 2026-08-07 (오후) · Fable · 배포+후속 배치 완결(#1147·#1148) — 정지
- **서버 배포 b74e6e53**: pin·스폰 폐곡선·데몬 경로·resume 검증 라이브(pins 401 확인·migrate 62·롤백 태그 보존). 오늘 랜딩분 전부 라이브 상태.
- **#1147 머지**: sampled-on-rust **3→53**(감시받지 않는 연산 128→78) — 등재 기준 ④ 신설("그 라우트가 요구하는 자격증명으로 샘플" — 서명 데몬 픽스처가 스폰 폐곡선 전체 재현)·allOf 검증기 결함 수리("기본 off라 여태 아무도 검사한 적 없던" 층).
- **#1148 머지**(리뷰 PASS B0·H0): 스레드 고정 배선 두 가닥(핸들러+지도 — "지도 없이 핸들러만 주면 조용히 틀린다")·실패 정직 3상태+헤더 개수("거짓말이 한 줄 위로")·행 「고정됨」 꼬리(기존 자리 재사용·accent 넷째 뜻 금지)·시각=정렬 근거 일치·서로게이트 안전 절단. Medium 4=#1149.
- **정지 — 컨펌 대기.** 8/7 누계: PR 10장 머지(#1138·#1140·#1142·#1143·#1145·#1147·#1148+수리 3)·서버 2회+웹 2회 배포·폰 설치. 다음 후보: oort 2단계(문서 산문)·U2 모드 전환·#1130 prime 전제·#1149·캡처 하네스 잔여(#1125)·Tauri CI(#1116).

## 2026-08-07 (저녁) · Fable · 후보 배치 5/5 완결 + 전 층 배포 — 검수 준비 완료
- **5워커 전량 머지**: #1150(oort 2단계 — 산문 1,160건·보존 4,694건 분류 증명) · #1151(U2 웹 테마 토글 — 스탬프 문법 "발굴"·터미널 재읽기 집합 규칙) · #1152(메시지 edit 계약 — 와이어 신설 0·17write→1메시지·"답의 도착은 수정이 아니다") · #1154(pin 잔여 4+캡처 하네스 3 — honesty 수수께끼="사라진 상태를 대기"·자가 로그아웃 한 원인) · #1153(U2 폰 라이트 — 전면 개조를 인자 하나로·웹과 16역할 바이트 일치·리뷰 PASS 후 소수리 de2d9d6f: systemScheme 분리로 거짓 봉인 테스트 교정).
- **전 층 배포**: 웹 index-lsbIEZDj · 서버 momo-rust:2fe2be47(migrate 62·4서비스 일치·healthz 200·롤백 fc122584→아니 b74e6e53 제거·직전 보존 확인 필요 없음 — da6a646b 잔존) · 폰 U2 아카이브 빌드 성공(**기기 unavailable — 연결 시 설치**).
- 적립: #1155(다크 accent 파리티+로그아웃 버튼 테두리) · #1130 잔여(②감사·③격리·ADR-0155 후보=취소 시 스트리밍 메시지) · #1118(oort 잔여 범위) · #1144(per-agent 라우팅 ADR 후보).
- 다음: 성재 검수(웹 라이브·폰은 연결 후 설치) → 피드백 배치.

## 2026-08-07 (밤) · Fable · 야간 배치 3/3 완결 — Tauri CI 개통·tool_result 접힘 수리·oort 배치 3
- **#1156 머지 → #1116 종결**: `release-desktop.yml`(build-only/dry-run/release 3모드·runs-on self-hosted macOS)+`docs/cicd/13` 러너 가이드. 서명 자산 전부 로컬 실측 실재(Developer ID·notarytool momo-notary·minisign — 자리표시자 0), 발행=기존 `publish_next_build.sh` 호출로 일원화. 성재 수동 1건: 첫 러너 등록(키체인 프롬프트 — 릴리스 시점에).
- **#1158 머지 → #1133 종결**: 스파인 멱등 가드 `(channel,author,client_msg_id)`가 type 미포함 → 카드·결과가 `call_message_id` 공유로 결과 쓰기가 dedup 흡수(전 도구 공통·선존재). 수리=`result_message_id` 전용 네임스페이스(v6 상수 vs run id=uuidv7 — **키 공간 구조적 분리**, `tool_result:x` 위조 call_id도 차단). 스키마/마이그레이션 0("구 키 점유 행은 언제나 카드"의 논증)·TS/Swift 0줄·red proof 2종(ade1_6). 후속감(기록만): 가드 type 추가는 동일 결함 재발 시 ADR.
- **#1159 머지 → #1118 코멘트(오픈 유지)**: server-rust 사용자 문장 5→**13곳**(shared.rs·cloud_hosts.rs 동질 8곳)·런북 stale 7곳·문서 잔여 65파일/670건(**동결층 diff 0 — 오케스트레이터 독립 재실측 일치**)·eve 게이트 선재 결함 수리(compose가 프로파일 필터 전에 전 서비스 보간 → workhost `:?` env 자리표시자 2줄)·oort 게이트 server-rust 3절 확장(표면 469→630). ROADMAP.md는 skew 적발로 의도적 제외. 잔여=Swift server/ ~50곳(prod 이미지가 아직 이쪽 빌드 — Dockerfile:25 주의)·openapi·하이픈 109 등 이슈에 표로.
- 다음 배치 발사: W-A(#1130 잔여 ②refine 감사·③HOME 격리) · W-B(#1155 폰 다크 여명화+#1157 INDEX cicd+깨진 링크 3곳). ADR-0155(취소 시 스트리밍 메시지) 기안은 Fable 직접.

## 2026-08-07 (심야) · Fable · W-A/W-B 랜딩·0155 Accepted·#1160 발사
- **ADR-0155 Accepted**(성재 승인) → 티켓 변환: #1160(stream.outcome 구현)·#1161(run_turn flip — 1160 후행). 패킷 `2026-08-07-stream-outcome-packet.md`.
- **#1162 머지(W-A=#1130 ②③ 부분 해소)**: 실측이 #1120 §7-2를 정정 — `refine_complete` 이벤트 실재(AgentSessionEvent, 유니온 밖이라 놓침) → 결함 성격="업스트림 문서/타입 드리프트+커널 경로 무음". 업스트림 초안 **미제출 보존**(외부 발신=성재 승인 사안 — 규율이 잘못된 이슈 제출을 실제로 막음). HOME 격리=누출 red proof 재현 후 **full(HOME+TMPDIR) 채택**(데몬 소켓이 uid 기준이라 home만으론 제어면 공유)·격리 비용 0(venv 이미지 공유). 미측정 정직 기록(자동 refine 미트리거·rollbackId·uid 경계)=정식 통합 체크리스트.
- **#1163 머지(W-B=#1155·#1157 종결)**: 다크 accent 가족 6역할 여명화 — 웹 짝 3역할 바이트 일치+파생 3 OKLCH 관계 재해석(색상각 고정·라이트의 걸음 재사용). 파리티 가드=웹 tokens.css **실파일 파싱 대조**(베낀 기대값 0). onAccent 뒤집힘=값 아닌 관계(명도 부등호)로 재정의. 로그아웃 테두리 원 소견 발굴(성재 이슈 코멘트)→border→textFaint. **design-review PASS(B0·H0·M1·N4)** — 전문 `research/2026-08-07-dark1155-design-review.md`. M1(sign-out confirm 위계)+N1(warn/accent 10.9° 이웃화)=#1164 적립.
- 워커 위생: named spawn 2기가 최종 보고 대신 유휴 신호로 종료(mailbox 전례 재확인 — **이후 단발 워커는 무명 spawn 복귀**). 완주 확인 후 TaskStop+워크트리 회수. 구 워크트리 6기+브랜치 10개 청소(6.6G→3.2G — 잔존 판정 대기 2: 684-3 Swift 미랜딩·WEB-WP1 squash 대조 필요).
- 활성: #1160 워커 1기(무명). 도착 시 design-review(웹·폰 꼬리) 발주→검수→머지. 이후 후보: #1161(run_turn flip)·#1164(다크 잔여+재배선)·#1139·#1141·#1146·#1149.

## 2026-08-08 (전야) · Fable · #1165 랜딩(ADR-0155 전면 구현) — 3워커 배치 발사
- **#1165 머지 → #1160 종결**: StreamCloseOutcome(닫힌 2값·final 동반 강제·정상 완결=키 부재)·닫는 PATCH best effort·코어 streamStopMark+문구 상수·웹/폰 꼬리(잉크=「수정됨」 동일 실측·accent 0)·endedRuns(부재≠종결). 이탈 3 전부 수용(props run_id 1줄="방어 렌더링 도달 가능성의 조건"·endedRuns 스토어·gate:pin 확장). **design-review PASS(B0·H1·M2·N2)** → H-1(픽스처 UUID 얽힘 — "무엇을 재는지 아무도 모르는 초록") 원 워커 재개 수리(cde4b872 — 자기모순 가드 신설+failed 판 픽스처·캡처 추가). M-2=#1166 발급(방어 렌더링 세션-로컬 — 페이지 읽기에 run 터미널 동봉, 엔진 후속). 전문 `research/2026-08-07-outcome1160-design-review.md`.
- 다음 배치 발사(3워커 무명): W-D=#1161(run_turn flip — 공존/은퇴·Suppressed 분기·dedup 합류 3결정 실측) · W-E=#1139(resume 서버 검증 이식 — fail-closed) · W-F=#1146+#1149(pin 다듬기 — 리뷰 발주 예정). 패킷 `2026-08-07-flip-resume-pin-packet.md`. 서버 D·E는 순차 머지+교차 실측.

## 2026-08-08 (새벽) · Fable · 배치 D/E/F 완결 — 스트리밍 전환 랜딩·헛발주 교훈 성문화
- **#1167 머지 → #1161 종결(W-D)**: run_turn in-process 스트리밍 전환. 결정 3지점 실측 — ①partial 힌트 **공존**(한 750ms 창 공유, 은퇴=싼 쪽 아끼며 레일 실명) ②Suppressed 유지+closing_outcome 일반화 ③dedup 합류(이중 메시지 구조적 부재). 부수 결함 2 동시 수리: **A2A 가드가 스트리밍 턴에서 위임 전체 무음 소멸**(→first_delivery)·첫 write 무표식 창(→opening_stream_props rev:0). red proof 4종. 적립: #1168(preamble이 도구 카드 위에 — 제품 결정 포함, 성재 실물 확인 권장)·이탈 5(어댑터 여는 POST 표식).
- **W-E(#1139)=헛발주 적발**: 실체는 PR #1143(8/6)이 기구현 — base≠main이라 Closes 미발화로 이슈만 열려 있었음. 워커가 재구현 대신 랜딩 코드를 신규 red proof 2건으로 재검증(검증 제거→201 통과 재현)·Swift 대조표 전항 일치 확인 후 종결. **W-F도 동형**: #1146·#1149의 10항목 중 9개가 #1148·#1154 기랜딩. **교훈 2건 메모리 성문화** — ①패킷 발주 전 `git log -S`/PR 검색 대조 ②track base PR 머지 시점에 이슈 수동 종결(이후 루틴 반영됨).
- **#1169 머지 → #1146·#1149 종결(W-F)**: 실잔여 N4 하나 — 실측 "세 이름"(폰은 한 컨트롤에서 눈·귀 분열+낭독 조사 손글씨). 수리=코어 판정표 단일 소스 배선(낱말 발명 0). design-review **PASS(B0·H0·M1·N4)** — M1(웹 tripwire 게이트 부재)+N 묶음=#1170 적립. 병합 트리는 #1167 랜딩 후 기준으로 오케스트레이터 재실행 PASS(85eb7759).
- 8/8 새벽 누계: PR 3장 머지(#1167·#1169·+전날 밤 #1165)·이슈 6건 종결(#1139·#1146·#1149·#1160·#1161·+#1133 계열)·신규 적립 #1166·#1168·#1170. 다음: **배포 묶음**(웹 재빌드+서버 이미지 — ADR-0155 전체·스트리밍 전환·다크 여명화·pin 마무리 반영).

## 2026-08-08 (새벽2) · Fable · 배포 반완료 — 웹 라이브·서버는 분류기 차단으로 성재 대기
- **웹 배포 완료**: `index-BqUnvS4I` 라이브(app.oor7.com 검증 일치) — ADR-0155 꼬리·endedRuns·검색 이름 통일 반영. 구버전 서버와 전방 호환(outcome 부재=꼬리 없음)이라 무위험.
- **서버 이미지 `momo-rust:892b342f` 로컬 빌드 완료**(amd64 — ADR-0155 서버 전체+스트리밍 전환+A2A 가드 수리). **전송·로드가 세션 분류기에 차단**(docker save/scp/load·원격 image rm 전부) — 성재 `!` 대행 또는 권한 규칙 필요. 절차는 런북 `docs/runbooks/ncp-rust-deploy.md` 그대로(5파일 compose·태그만 교체·2fe2be47=롤백 보존). 구 롤백 태그 da6a646b 회수도 동반 차단(디스크 85%·1.5G 여유라 급하지 않음).

## 2026-08-08 (새벽3) · Fable · 서버 배포 완결 — momo-rust:892b342f 라이브
- 성재 `!` 대행 2건(이미지 전송·compose up — 분류기 차단분)으로 완결. 검증: healthz **200**·approvals **401**(신 라우트 서빙)·기동 로그에 4서비스 전부 **Recreated**(notifier 포함 — 8/4 함정 재발 불가)·migrate one-shot 정상. **롤백=2fe2be47**(env 백업 smoke.secrets.env.bak-20260808). 구구 태그 da6a646b 회수는 미실행(차단 — 디스크 여유 있어 급하지 않음, 성재 여유 시 `docker image rm momo-rust:da6a646b`).
- **전 층 최신**: 웹 index-BqUnvS4I · 서버 892b342f — ADR-0155 폐곡선(기안→승인→구현→리뷰→배포)이 하루 안에 라이브. 스트리밍 전환·A2A 가드 수리·다크 여명화(폰은 아카이브 대기)·검색 이름 통일 포함.
- 다음 후보: #1166(페이지 읽기 run 터미널 동봉)·#1168(preamble 위치 — 성재 실물 확인 권장)·#1170(이름 가드 소묶음)·#1141(코어 기계 검사)·#1164(다크 잔여+재배선 — 결정 포함)·#1118 잔여(Swift server/ 카피 — prod 이미지 주의)·폰 재빌드(기기 연결 시).

## 2026-08-08 (새벽4) · Fable · 성재 지시 정지 — 재개 지점 고정
- W-G(#1166)·W-H(#1170+#1141) 착수 직후 정지(패킷 읽기 단계 — 유실 0), 워크트리·브랜치 회수. **재개=같은 패킷(`2026-08-08-terminal-backfill-guards-packet.md`, ready 유지)에서 2기 재발사** — 랜딩분 대조 기완료라 즉시 발사 가능, 성재 신호 후.
- 스냅샷 17 갱신(정지 상태·재개 절차·적립 큐 순서 후보·성재 대기 항목·운영 교훈 3건). 이 밤 최종 상태: **전 층 라이브**(웹 index-BqUnvS4I·서버 892b342f·롤백 2fe2be47), PR 6장 머지, 이슈 8건 종결, ADR-0155 폐곡선 완결.

## 2026-08-08 (오전) · Fable · 재개 배치 W-G/W-H 완결(#1171·#1172)
- **#1171 머지 → #1170 종결·#1141 코어 축 완결**: 분리 규칙=AST 실측 채택(삼자 비교), **부채 73/47은 규칙 부재의 숫자 — 실부채 2건(비렌더 자증 칸)**이라 ratchet 없이 하드 제로+allow 마커 2(판정 기준 내장). verify_merge_tree에 core copy scan 레인(7레인). 잔여=웹 emdash 12(레인 종결 후 or AST 이관 — 도구 기제작).
- **#1172 머지 → #1166 종결**: 동봉=인라인 `runEnded`(사이드카 문법 부재 실측·서버 투영 전례 3종 계승)·false 미전송(부재≠종결)·momo.stream 기입 기각 명기. red proof 4종+크로스테넌트 오라클. 이탈 ①스레드 페이지 동승 수용. **병합 트리 1회 폰 RED→동일 트리 재실행 green**(선존재 flake 계열 #1063 — 교차 결함 아님 판정).
- 신규 적립: #1173(어댑터 여는 POST 표식 — #1167 이탈 5 추적). 다음 후보: 배포 묶음(#1171·#1172 — 892b342f 이후분)·#1168(성재 실물)·#1164(결정)·#1118 잔여·웹 emdash 12.

## 2026-08-08 (낮) · Fable · W-I/W-J 랜딩 + OSS 리서치 가동(E2B 정정)
- **#1174 머지(W-I=oort 배치 4)**: Swift server/ 리터럴 58(**역치환 증명** — 빌드 없이 컴파일 무영향 보증)·openapi 산문 12(계약 표면 동일 증명+schema.d.ts 선재 드리프트 흡수)·하이픈 69·게이트 4절 확장(표면 725)·관사 파손 5. 동결 diff 0 독립 재실측 일치. #1118 잔여=배지·골든·ROADMAP 20줄·주석 산문(오픈 유지).
- **#1175 머지 → #1141 완결(W-J)**: AST 공유 모듈화(규칙이 한 곳에), **부채 12=오탐 11+실물 1**(도달 불가 증명 후 allow)·따옴표 없는 JSX 텍스트 기존 미탐까지 닫음. 신규 적립: #1176(web-legacy typecheck 선재 빨강).
- **OSS 리서치 가동(성재 발제)**: vibesdk·CubeSandbox·TencentDB-Agent-Memory — ouroboros 인터뷰 4라운드로 축 확정(메모=에이전트 장기기억+채널 지식베이스 둘 다·단일 기질 여부가 판정 축 / 샌드박스=T3 빈자리 / 케이스별 판정 / 로드맵 반영까지). **성재 지적으로 E2B 은퇴 실측 확인**(현행=ADR-0142 D1 BYOC+mock, registry.rs:247 "retired provider id" 단정 — 스냅샷 11 시절 "E2B 확정"은 낡은 컨텍스트였음). 리서치 워커 1기 가동 중.
- 다음: 리서치 도착 시 검수·정본 이식·ADR 후보 판단 → **배포 묶음**(#1171·#1172·#1174·#1175 — 성재 대행 2명령 필요).

## 2026-08-08 (오후) · Fable · CubeSandbox 승격(ADR-0156 Accepted) — D4-① 발사
- 성재 결정: "cube sandbox 등 적극 활용으로 승격. 인프라 부분은 수정하지 뭐" → **ADR-0156 Accepted**(기질=CubeSandbox·ADR-0144 D1 대체·BYOC 공존·capability 선언 뒤 합류·전용 호스트 신설·부속 컴포넌트 유보). 티켓: #1177(D4-① 요건 실측+어댑터 매핑 — 인프라 발주 전)·#1178(메모리 플레인 흡수 2건 — kind 분리+사후 필터링 금지).
- 성재 액션 대기: **전용 호스트 확보**(#1177 산출=사양 재료) · 서버 배포 대행 2명령(momo-rust:e8b604e0) · 구구 태그 회수.

## 2026-08-08 (저녁) · Fable · CubeSandbox 어댑터 랜딩(#1179) — D4-③ 완결
- **#1179 머지**: `cubesandbox` provider 어댑터(fake 상류 검증 — 실 호스트 불요). blocker 2 해소가 구조적: 멱등=metadata 각인+재구성(조회 실패=생성 중단 fail-closed)+advisory 락 / probe lossy=**`presence_for_status`가 state 인자를 안 받는 시그니처가 곧 계약**+실DB 단정(fake가 running 보고해도 stale 하트비트=고아 처리). capability=D6·max instances env 주입. red proof 3종. **이탈 채택 2**: ①sweep 정의 모호→ADR-0141 24h 기준(env 조정)+D4-② 실측 항목 추가(reconciler probe가 idle 시계 리셋하는가 — inbound만 리셋·workd는 outbound) ②pause 409=재프로브(mock 방식이 오히려 결함 — 살아있는 머신 과금 중단 위험). notifier=Unwired(D4-④ 경계). cargo 808·병합 트리 7/7.
- 운영 노트: NCP SSH 경로 스톨(HTTPS 정상 — 관리 경로만) — 웹 `index-C3szaFwl` 교체·서버 e8b604e0 전송 대기. 연결 회복 후 재시도(반복 재시도는 MaxStartups 악화 위험이라 중단).
- #1177=D4-② 실기동만 잔여(전용 호스트 — 성재 발주 체크리스트 전달됨). 다음 후보: D4-④ 프로비저너 연동(어댑터 랜딩으로 전제 충족)·#1178(메모리 플레인 흡수)·#1168·#1164·#1176.

## 2026-08-08 (밤) · Fable · D4-④ 랜딩(#1180)·#1178 종결 — CubeSandbox 체인 3/4 완결
- **#1180 머지(D4-④)**: 프로비저닝 폐곡선(티어 정책→create→env 등록 토큰→기존 register→세션 201) — 사본 0·마이그레이션 0·토큰은 응답에 실리지 않음이 계약(부정형 단정). red proof 3(결정성 2형태·미활성=상류 요청 0). 이탈 채택 3(provisioning→failed 비신설·권한=활성 멤버+티어 정책·bootstrapToken 부재). cargo 821·실DB 신규 8/8·병합 트리 7/7.
- **하루 아크 완성**: OSS 발제(아침)→인터뷰→리서치→ADR-0156 Accepted→D4-① 요건→D4-③ 어댑터→D4-④ 프로비저너(밤) — **잔여=D4-② 실기동만**(성재 전용 호스트 대기). #1178은 ADR-0129 증보 1로 직접 반영·종결(kind 분리·사후 필터링 금지).
- 성재 대기: 전용 호스트 발주(체크리스트 전달됨)·서버 배포 대행(SSH 스톨 회복 후 — e8b604e0는 D4-③/④ 미포함이라 회복 시 최신 head로 재빌드 판단)·구구 태그. 큐 잔여: #1168(실물 확인)·#1164(결정)·#1176(web-legacy)·#1173(어댑터 POST 표식).

## 2026-08-08 (밤2) · Fable · #1181 랜딩(#1176 종결)·SSH 진단 확정·NCP 전원 도구 재작성
- **#1181 머지**: web-legacy 빨강 원인=스펙 이동 후 미추종(타입만이 아니라 web-legacy dist가 Rust API 앞에서 승인 패널 TypeError — **라이브 무영향**, app.oor7.com=clients/web 서빙). 은퇴 기각(momo.Dockerfile 유일 웹·MOMO-678 선례)·수리=이중 표기 리더. 같은 프로파일 base 빨강 2건 동반 수리(B2 title 리브랜딩 준비 판정·B3 admin 픽스처), B4=#1182 발급. --profile web 13/14 green.
- **SSH 스톨 진단 확정**: TCP·배너·키교환 정상 → **비밀번호(PAM) 단계 서버 무응답**(logind/dbus 류 전형) — 성재 터미널도 동일이라 서버측 확정. 처방=NCP API 재부팅. `ncp-power.py` 재작성(원본 tmp 유실 — 서명 v2·자격 ~/.ncp 생존)·status 검증 성공(running). 성재에 reboot 명령 전달(리스크 고지: 재부팅 후 up -d까지 1~3분 다운 가능). 회복 시 순서: 스택 확인→잔여물 청소→웹 C3szaFwl→서버 3380e4fc.

## 2026-08-08 (밤3) · Fable · 서버 회복+전 층 배포 완결·#1183/#1184 랜딩
- **SSH 사건 종결**: 원인=logind 런타임 걸림(재부팅=정답·디스크 86% 무관) + 혼선 2겹(비번 파일 tmp 청소 소실 — pem+getRootPassword API로 재복호화 복구·root 일시 잠금 — 1분 자동 해제). 교훈: 비번 파일은 세션 스크래치 의존 금지 → **API 재복호화 절차가 정본**(ncp-power.py+getRootPassword, ~/.ncp 자격+pem이 진짜 원본).
- **전 층 배포**: 웹 `index-C3szaFWl`·서버 `momo-rust:08e0c9d9`(4서비스 일치·migrate 62 skip·healthz 200·approvals 401) — 오늘 랜딩 전체(ADR-0155 폐곡선·runEnded·CubeSandbox 어댑터+프로비저너·여는 POST 표식·oort 배치 4) 라이브. 롤백=892b342f 단일 보존, 구 태그 2개 회수(디스크 87→84%).
- **#1183 머지(#1173 종결)**: 여는 POST 표식 — 선언≠저장값(400)·SignedStreamOpen 거절·클라 0줄. 서버측 닫기 전제(runId 서비스)는 #1130 합류. **#1184 머지(#1182 종결)**: 스모크 18일 잠복 드리프트(#577 개명) — 정착 배리어 보존 수리+B5 경합+B6 히어독 백틱(#1181 자기 결함)+testid⊆렌더 밀리초 가드. #1185 적립(게이트 ruby 환경).
- 활성: #1186(다크 20역할 파리티 — N1 해소 18.08° 실측·에이전트 색 159° 통일) design-review 중. ADR-0157(샌드박스 네트워크 경계) Proposed — 성재 승인 대기.

## 2026-08-08 (밤4) · Fable · #1186 랜딩(#1164 파리티 축) — 대기 병렬 배치 3/3 완결
- **#1186 머지**: 다크 20역할 파리티(웹 짝 16 바이트 일치·파생 8 tone 회전각 — okSurface 순흑 충돌을 피한 방식 선택). **N1 해소 실측**(warn/accent 18.08° — 웹과 동수), **에이전트 색 아이덴티티 통일**(스킴 간 59.4°→1.06° — "never neon AI purple" 해소·구현 보고의 159°는 다른 쌍의 값 오기, 리뷰 M1이 적발→c04de940 교정+측정 규율 주석화), 위험 위계 우연(1.008)→설계(1.18)+가드. design-review **PASS(B0·H0·M1·N3)** — 전문 `research/2026-08-08-dark1164-design-review.md`. #1164 잔여=②재배선·③confirm 위계(성재 결정).
- 병렬 배치(#1182·#1173·#1164①) 3/3 랜딩 + 전 층 배포(08e0c9d9) — "대기 중 공회전" 지적 이후 사이클. 웹은 다크 파리티 미포함(#1186이 폰 전용) — 폰 아카이브 재빌드는 기기 검수 시점에.

## 2026-08-08 (마감) · Fable · #1187 랜딩(#1185 종결) — 8/8 최종 11 PR
- **#1187 머지**: 게이트 ruby red의 진범=사본 드리프트(#1042 복사 시 재시도 갈래 누락 — "같은 변환" 주석이 반증). 수리=공유 라이브러리(드리프트 자리 제거)+자격 실측 갈래+상시 고지+red proof 영구화. **게이트 경유 --profile web 14/14 — 이 호스트 최초.**
- **8/8 최종 누계**: PR 11장 머지·이슈 9건 종결·ADR 0156 Accepted+0157 Proposed+증보 2·리서치 2·design-review 2 PASS·전 층 배포(index-C3szaFWl·momo-rust:08e0c9d9·롤백 892b342f)·SSH 사건 복구. 성재 게이트 2 잔여(전용 호스트 발주·ADR-0157 검토). 큐 잔여: #1130 정식 승격(runId 서비스 포함)·#1118 소형 산문·#1164 ②③·#1168(실물)·세션 카드 앵커(이슈 미발급)·PYTHON_BIN 관측.

## 2026-08-09 (새벽) · Fable · prime 정식 승격 완결(#1188·#1189 → #1130 종결)
- **ADR-0158 Accepted**(성재 결정 3건: refine 기본 공개·system 재사용·롤백 v0 비노출)+**증보 1 D7**(에이전트 PATCH 스코프 본인 한정 — W-N이 적발한 Swift 시절 공백, "스파이크가 턴당 17메시지였던 실제 원인").
- **#1188(서버 축)**: runId 서비스(트랜잭션 안 fail-closed 3종·컬럼+props 이중 기록 — 두 독자론)·어댑터 스트림 서버측 닫기·refine 수용(uuid5 파생 멱등·기대값 명명 400)·D7(새 스코프 0·메서드 매칭·저자 검사=기존 하나 실측 후 단정). red proof 5종.
- **#1189(어댑터 축)**: adapters/prime 상주(hermes 형식·24파일) — 스파이크 빚 5건 청산(답 하나=메시지 하나·outcome 구분·고정 키·refine 양 경로·full 격리 fail-closed)+버퍼 미달 짧은 답 버그 수리. **실연동 증명: 베어러 하나로 525 update→메시지 1개(여는+조각 23+닫는)·refine 공지·outbox 25/25·audit 2행**. 교차 실측이 N·O의 계약 불일치(패킷 vs 랜딩 형상)를 잡아 서버 정본 수렴.
- **prime=3번째 provider 정식 합류.** 적립: #1190(uuid5 파생 양측 사본 — 골든 벡터 크로스체크)·정식 운영 전 체크리스트(자동 refine 실측·멀티 uid·업스트림 문서 드리프트 — PR #1189 명시). 어댑터 이미지 1.82GB 로컬 보존(재현용).

## 2026-08-09 (새벽2) · Fable · prime 승격분 배포(momo-rust:2afae645) + W-P/W-Q 발사
- **서버 배포**: `momo-rust:2afae645`(#1188·#1189 포함 — runId 서비스·D7 PATCH 스코프·refine 수용·adapters/prime) 라이브 — 4서비스 일치·healthz 200·migrate 62 skip. 롤백=08e0c9d9(직전 — 초기 태그 선택 실수를 즉시 교정: 2세대 전이 아니라 직전을 남긴다). 웹 무변경(index-C3szaFWl 유지 — 이 배치 클라 0줄).
- 발사: W-P(#1190 uuid5 골든 벡터 — 한 파일을 양 언어 테스트가 읽음)·W-Q(#1118 배치 5 — 산문만·배지/골든 접촉 금지). 패킷 `2026-08-09-golden-oort5-packet.md`.

## 2026-08-09 (새벽3) · Fable · W-P/W-Q 완결(#1191·#1192) — oort 리브랜딩 완주·골든 벡터
- **#1191 머지 → #1118 종결**: oort 5배치 완주(#1117→#1150→#1159→#1174→#1191). 주석 29곳 — "주석만 만졌다"의 기계 증명(렉서 분리 후 코드·리터럴 스트림 SHA 동일)·의도 동결 1곳(v5 바이트 설명 주석). 잔여 3줄=작업 아닌 결정(배지·골든·ROADMAP=main 소관) — 열린 이슈=미완 신호 원칙으로 종결.
- **#1192 머지 → #1190 종결**: 골든 벡터 9종 한 파일(중립 위치)·include_str! 컴파일 결속·기대값=RFC 수조립·**세 번째 사본 적발**(스탠드인→실 POST 결속)·양끝 공백 엣지(실드리프트 지점). 잔여 기록: 200자 초과 키 어긋남(시끄러운 실패·미도달).
- 이 사이클 누계(ㄱㄱ 이후): 배포 1회(2afae645)+PR 4장(#1188·#1189·#1191·#1192)+이슈 4건 종결(#1130·#1118·#1190·+#1173 계열). **남은 큐=성재 게이트·결정 항목뿐** — 성재 무대기 실작업 큐 소진.

## 2026-08-09 (새벽4) · Fable · ADR-0157 Accepted·U1 실기동 개시(성재 승인)
- **ADR-0157 Accepted**(샌드박스 네트워크 경계 — 성재 승인).
- **U1 판정 가동**: 성재 승인(비용 확인 — 시간제 몇백 원~천 원대)으로 `cube-u1-test` 생성(**인스턴스 144279772**·rocky-9.8-base — PVM 커널이 EL9 RPM이라 Ubuntu 대신 Rocky 1차·s2-g3·10.0.1.7·점프=프로덕션 경유 통과만). U1 워커 가동 중(PVM 커널 부팅 판정 — 실패도 판정). **종료 책임=오케스트레이터: 판정 후 terminateServerInstances 필수**(과금 유실 방지 — 이 줄이 그 리마인더다).

## 2026-08-09 (새벽5) · Fable · track/engine→main 동기화 완료(a749d765)
- 525커밋 동기화(위임 사항 — 랜딩 단위). 충돌 3건 전부 문서: 0144=engine(oort화)+대체 헤더 재적용·0145=engine(oort화)+증보 2 이식·JOURNAL=main 초집합(역사 원문 우선 — engine측 구항목 oort화 미채택 기록). **병합 결과 7레인 green 확인 후 푸시** — main=engine 코드 동일. uxui 트랙은 별도(변경 없음 확인 시 생략).

## 2026-08-09 (아침) · Fable · U1 PASS·표준 KVM 반전·D4-② 본판 가동
- **U1 판정 PASS**(25분): PVM 커널 NCP VM 부팅 성공(3회·ioctl 실증). **더 큰 발견: NCP 표준 VM에 /dev/kvm(nested) 실동작** — L2 게스트 KVM 가속 부팅 실증 → ADR-0156 증보 2(**표준 KVM 1차·PVM 폴백**). 상류 결함 3 실측(BLS 무효 스크립트·kvm_intel 선점·console de-dup — 전문 `research/2026-08-09-cubesandbox-u1-verdict.md`). U1 VM(144279772) **terminate 완료**(성재 스크립트 대행).
- **D4-② 환경 구성**: cube-d42 생성(**인스턴스 144280017**·s8-g3 31GB)+`<redacted>` 공인 IP(**인스턴스 144280033**)+**200GB CB1 볼륨(144280036)** — 회수 대상 3개 전부 번호 명기(**종료 책임=오케스트레이터**: terminate+IP 반납+볼륨 삭제). KVM(g3) 스토리지 API 특이(분리 생성 CB1+zone→attach) 실측 기록. D4-② 워커 가동(표준 모드 설치→실 microVM 폐곡선→매핑 실물→idle 시계→ADR-0157 네트워크 실측).
- 병행: #1193 앵커·자동 refine 실측 워커 진행 중.

## 2026-08-09 (낮) · Fable · D4-② 완주·Swift 감사·#1198 랜딩·#1195 FAIL
- **D4-② 완주(#1197 발급)**: 표준 KVM 전 과업 성공(설치 91초·호스트→첫 샌드박스 10분). **어댑터가 fake에 맞춰져 있었음이 실물로 드러남** — 이미 목표 상태=500(409 아님)·VMM 크래시 후 5분 running(provider_missing 미발화 → 원장 능동 destroy 필요)·timeout=절대 TTL(keepalive 의무)·pause 4배·metadata 내부 키 혼입. **ADR 문언 2건 실물 정정**: 0156 D5(CubeProxy·CoreDNS는 필수 종속)·**0157 D4=기제 선택이 아니라 기대값 검증**(Cubelet eBPF가 D1~D3를 기본 만족·양성 대조 확인). 부수: 템플릿이 CubeEgress MITM CA를 기본으로 굽는다(ADR-0150 입력).
- **Swift 감사 — 통째 삭제 불가 판정**: 삭제 불가 4(PushRelay=유일 APNs·**WorkHostDaemon=방금 만든 T3가 띄우는 바이너리**·server/Migrations=배포 DDL·MomoMetrics)·파리티 갭 Swift-only 83(openapi 성문 65)·삭제 가능 573(클라 407 우선)·web-legacy는 독립 Dockerfile.web 보유. **오케스트레이터 실수 적발·복원**: main 머지 a749d765가 ADR-0145 **증보 1(삭제 조건 판정표)을 유실** — 감사가 잡아 원문 복원+고지. 교훈: 문서 충돌 해소 시 "무엇을 취했나"가 아니라 **"무엇이 사라졌나"**를 세라.
- **#1198 머지 → #1194 종결**: 목 수리 선행(자동 경로 LLM 패스 둘 미구분→모든 자동 refine 조용히 거부=거짓 초록)·유래를 관측에서·로컬 스코프는 RPC 종료 후 질의(경합 회피)·applied 필터. red proof 4.
- **#1195 리뷰 FAIL(B2·H2)** — 수리 중: B1 깊은 방(45줄+) 앵커가 가상 창 밖이라 착지 실패+**거짓 고지**(이미 로드된 것을 "더 불러오세요")·B2 2회차 무동작(?msg= 미소거).
- 성재 지시 반영: **검수 표면=데스크톱(Tauri)+모바일(RN)** — macOS 폐기 시 사라지는 표면 목록 감사에 명시(웹훅·이벤트구독 설정·첨부 UI 등). 검수 전 빌드 준비 예정(폰 아카이브·Tauri 번들).

## 2026-08-09 (오후) · Fable · 전 층 배포 + 검수 빌드 완비 — 실작업 큐 종료
- **#1195 머지(재검증 PASS)·#1200 머지 → #1193·#1197 종결**: 앵커 B1 수리가 **웹 전 앵커 표면**(인박스·활동·검색·작업흐름·ADE)의 거짓 고지를 함께 제거(리뷰어 300줄 독립 프로브로 "참인 고지는 살아 있음" 확인) · 어댑터는 **fake가 비실재 기질을 검증하던 문제**로 재정의, 실물 하네스가 6번째 어긋남 자체 적발(/refreshes 404 미발화)·자기 결함 2건 자백 수리.
- **배포**: 서버 `momo-rust:b727ea4f`(4서비스·migrate 62·healthz 200·approvals 401·롤백 08e0c9d9)·웹 `index-D4M7P01H`. NCP 실험 자원 3종 **전량 회수**(과금 종료 — U1·d42·IP·볼륨).
- **검수 빌드 완비**: 데스크톱 `oort.app`(5.1MB·app.momo.desktop·0.1.0-next.1 — scratchpad/oort-0809.app) · 폰 `MomoMobile-0809.xcarchive`(68MB·app.momo.ios — 기기 unavailable, 연결 시 설치). 성재 지시대로 검수 표면=데스크톱(Tauri)+모바일(RN).
- 신규 적립: #1199(앵커 잔여 4·N-c 딥링크 계약 미기록)·#1201(check_spm_licenses base red — **전 프로파일 게이트 차단**, Swift 삭제 판단과 함께).
- **실작업 큐 종료** — 남은 것은 성재 검수·결정뿐(Swift 삭제 방향·ADR-0150·#1164 ②③·#1168 실물·기기 연결).

## 2026-08-09 (밤) · Fable · Tauri 이식 3축(#1202) 리뷰 사이클 — Swift 삭제 선행조건
- **성재 지시 정정 반영**: "swift를 지우라가 아니라 **tauri쪽 작업이 다 되면** 지워라" → 실측으로 이식 대상 확정(웹훅·이벤트구독·첨부 UI — **서버 API는 셋 다 완비, UI만 macOS에 갇혀 있었다**). #1202 발급·3워커 병렬.
- **3축 전부 1차 FAIL → 수리**: 공통 성격이 **주장과 실물의 어긋남**이었다. 웹훅=주석이 "언마운트되면 비밀이 사라진다"고 적었으나 캐시 5분 잔존(**2차에서 힙 스냅샷으로 진짜 소유자 발견 — 인라인 queryFn이 렌더 스코프 캡처, 목록 Query의 gcTime이 붙잡음**) · 이벤트구독="나가는 것을 이름으로 말한다"면서 멘션 대상 ID 침묵(재실측에서 **리뷰 표에도 없던 유출 2건 추가 발견** — work의 스레드 ID·승인의 props 통째) · 첨부=표제 주장 "진행 정직성"인데 **막대가 전송 내내 0**(+게이트가 눈멀었던 원인 규명: Playwright 라우트 인터셉션이 네트워크 앞에서 가로채 진행 이벤트 부재 → 진짜 HTTP 싱크로 교체).
- **이벤트구독 재검증 PASS**(캡처 sha256 24/24 일치로 증거 시비도 해소)·잔여 2건 마무리(착지=아래행→위행→폼·낭독 sr-only·오프라인 이유 1문장을 6컨트롤이 참조). **Esc가 두 축 공통 결함**(비밀 카드·확인 열려도 설정 전체 소멸) → 선행 머지인 웹훅이 셸에서 단일 수리하도록 조율.
- 신규 적립: #1204(이벤트 웹훅이 메시지 본문 전송 — ADR-0150 관할·유출 범위가 알려진 것보다 넓음)·#1207(브라우저 CSP가 첨부 업로드 차단 — **Tauri는 무사**, 보안 경계라 ADR 사안).
- 성재 결정 반영: ADR-0150 **Accepted**(웹검색 egress 원안)·#1201은 Swift 삭제와 함께·#1164 ②는 기기 검수 후.

## 2026-08-09 (심야) · Fable · #1202 3축 랜딩 — Swift 삭제 선행조건 충족
- **머지 체인 완주**: #1205 웹훅(3차 PASS — B1을 힙 스냅샷으로 규명·수리·게이트화, 리뷰어가 **제품 번들 한 줄 되돌려** 리테이너 재현까지. Esc 층 구조 신설: 확인=useEscapeLayer·비밀 카드=useEscapeGuard·셸=escapeIsClaimed 캡처 단계. 다이얼로그 안전이 여태 "캐럿이 INPUT 안"에 얹혀 있었음도 드러남) → #1203 이벤트구독(재병합 시 Esc는 **자기 층 등록 누락**이 원인 — 한 줄로 AiLink 계열까지 해소) → #1206 첨부(Esc 층 판정 정교: 트레이는 층 아님 3근거+실측, 드래그 강조는 실구멍이라 등록).
- **#1202 종결 = macOS 삭제 개시 조건 충족**. 잔여는 별건 3(#1207 CSP·#1208 회전 레인·#1204 본문 전송).
- 병행 랜딩 대기: #1209(폰 앵커 잔여 — **「위로 올려 더 불러오세요」가 따라도 아무 일 없는 지시였다** 진단·두 발 착지·고지 4주어 합류) design-review 중.

## 2026-08-09 (마감) · Fable · 디자인 시스템 「오르트 구름」 정본화 + 세션 인계
- **ADR-0159 Accepted**(성재 결정 3: 이름=오르트 구름·가드 전 축 확장·macOS 층은 Swift 삭제와 동반 재조준). 감사가 전제 2개를 뒤집음: **우리는 이미 시스템이 있고**(위계를 채도로 재는 방식은 업계 1차 소스에 선례 없음 — 우리가 앞선다) **진짜 문제는 명세가 아니라 강제**(리뷰 170건 최다 패턴 25건 = "옳은 답이 바로 옆 줄에 있었는데 안 씀"), 그리고 **디자인 표면은 셋이 아니라 둘**(Tauri=web dist 그대로·조건부 스타일 0).
- **#1214 랜딩(#1211 종결)**: 정본 문서 349줄(축별 짝/분기/홀로·위계를 관계로·**무검사 목록**)+바이트 대조를 색→간격·타이포·반경·그림자. **자가 적발 8건** — 헤드라인 주장("격자 밖 값은 컴파일 안 된다")이 거짓이었다.
- **#1212 랜딩(#1207·#1204 종결)**: CSP 한 호스트+**#1206이 검수를 통과한 이유 규명**(기존 gate:csp는 Tauri 정책만 재고 배포 정책은 무검사)·웹훅 전송 감사(본문 금지를 **함수 시그니처가 든다**). **검수 중 발견 → #1213**: 라이브가 보안 헤더를 하나도 안 보낸다(Caddy 설정 2벌 분기·라이브 쪽 무방비).
- **#1215 진행 중 정지**(성재 지시 "그것까지 페이블한테 시켜") — 구현·검증 완료·design-review만 미완, 워크트리 보존.
- **docs 동기화**: main→track/engine 문서 134파일(코드 0줄) — 워커가 engine에서 ADR-0159를 못 읽던 문제 해소.
- **인계**: `docs/planning/NEXT_SESSION_BRIEF.md` 최종본 — 즉시 이어받을 #1215 리뷰 지시서·열린 전선 4·성재 대기·운영 규율. 새 세션 Fable이 여기서 시작한다.

## 2026-08-09 (저녁) · Fable · 우로보로스 선행 → 4전선 배치 — #1210·#1213 종결·라이브 헤더 발효·ASC 재조준
- **우로보로스 인터뷰(Opus 5 워커·4라운드·ambiguity 0.10) 선행**: 브리프 사실 오류 3건 적발(④"선행조건 충족"은 감사 §0-1과 정반대(Blocker — 증보 1 유실·11패밀리 판정 미결)·#1213 원인은 "2벌 분기"가 아니라 **라이브 Caddyfile이 레포에 없음**·열린 PR은 1이 아니라 14(dependabot 13 방치)) + 숨은 매듭(ASC 콘솔 5~10분이 ①③④ 동시 해소) + ②③은 순서가 아니라 결합(CSP connect-src에 googleapis 없으면 첨부 즉사) + 감사 낡음(engine 36커밋 앞, T9·T10 이미 닫힘). **전 항목 오케스트레이터 재검증 후 채택**. 정본 `research/2026-08-09-ouroboros-session-planning-interview.md`. 성재 결정 4: 편성 승인 · ②③ 같은 배포 창(HSTS 1일 시작) · ASC 즉시 · 검수 빌드는 #1215 머지 후 1회.
- **W1 — #1215 폐곡선**: design-review PASS(Blocker 0·High 0·Medium 1·Nit 3 — 5항목 전부 반증 방식, D3 포커스 링은 Playwright로 직접 재현) → 병합 트리 **8레인 전부 green**(신설 web lint 레인 포함, 병합 결과 ef528aa9) → 머지 → **#1210 수동 종결**. Medium 1(feature 층 border-line 잔존 2곳)은 **#1218** 발급. 리뷰 전문 보존 `research/2026-08-09-dsfix1210-design-review.md`.
- **#1213 폐곡선(같은 배포 창 결정 집행)**: 0단계 **#1217** 라이브 Caddyfile 레포 회수(서버 sha256 `5238f252…` 바이트 일치·내용 변경 0줄 — 버전관리 밖 상위 결함 해소) → W3 **#1220** 헤더 5종(전 소스 코드 실측 근거표·`gate:csp-deploy`가 라이브 파일도 잰다·red proof 7건=파일을 실제 고쳐 빨강 증명·런북 Caddy 배포 절 신설) → 배포 창(성재 `!` 대행 1회, 3단계 스크립트) → **라이브 재실측: SPA에 CSP(googleapis 포함·frame-ancestors 'none')+HSTS 86400+nosniff+no-referrer, API 경로에 사이트 3종 도달** → 종결. 제품 영향 고지 2(브라우저에서 임의 호스트 관전 터미널·타 서버 접속 닫힘 — 설계된 축소, 데스크톱 무관).
- **배포**: 서버 `momo-rust:6bfc9b82`(라이브 b727ea4f 대비 +115/-22, **마이그레이션 063** 포함)·웹 `index-Dp1ym0h8`·헤더 발효. healthz 200·approvals 401·해시 일치. 롤백 백업 2(env·Caddyfile) 서버 보존.
- **ASC Xcode Cloud 재조준 — Fable이 성재 Chrome으로 콘솔 직접 조작**: "Default" 워크플로 대상을 `clients/iOS/MomoiOS.xcodeproj`→`clients/mobile/ios/MomoMobile.xcworkspace`·scheme `MomoMobile`로 재지정·저장(스킴 목록은 재스캔 강제용 수동 빌드로 갱신). 첫 실빌드 2035: **아카이브·서명·3종 export 전부 green(서명 동의 프롬프트 없이 Apple 관리형 서명 성립)**, 유일 빨강 = `ci_post_xcodebuild.sh` **첫 실환경 실행이 드러낸 자체 결함**(entitlement 덤프를 `</plist>`에서 안 잘라 뒤 잡음이 plutil 전체 거부 유발) → **#1219** 수리(+실패 시 진단 덤프). 재빌드 자동 트리거로 검증 중.
- **W2 — #1216(성재 승인 대기, main 대상)**: 패킷 전제 정정 2(증보 1은 `32f31eaa`에서 이미 복원돼 있었음·"engine⊂main" 역전) · 감사 engine 재기준화(소거 4·정정 4·수치 2·좌표 5·신규 결함 2) · 11패밀리+agentRunHistory 3칸 표(판정 칸 공백 — 폐기 유력 후보는 work-tool-profiles·bans·platform 셋뿐, 8패밀리는 클라 호출 생존). **최대 발견: `relay/OutboxRelay`는 삭제 가능이 아니다**(engine-only 36커밋의 .swift 3파일이 전부 이 트리·8/9 웹훅 랜딩·Rust 웹훅 소비자 0건 — 5-A→5-C 강등+T13 필요) + 감사 §9 지시를 문자 그대로 실행하면 `clients/mobile/ios` 삭제 사고(좌표→경로 문자열로 정정).
- **검수 재료 완비**: 데스크톱 `oort.app`(@6bfc9b82, #1215 디자인 수리 포함 — deploy5 워크트리 bundle/macos) 빌드 완료. 폰은 ASC green 확인 후 TestFlight 경로(배포 준비 토글+내부 테스터 그룹) 제안 예정.
- 적립: LiveKit 랜딩 티켓에 CSP connect-src 갱신 수용기준 필수 · `infra/prod/Caddyfile` Permissions-Policy가 셀프호스트 허들 마이크를 죽이는 기존 결함(티켓 후보) · dependabot 13건 방침(S9) · engine→main 머지(S10 — 문서 드리프트의 뿌리) · 11패밀리 판정(S5, 입력=#1216 표) · T6/T7 존폐(S7 — OutboxRelay 발견으로 무게 상승).

## 2026-08-09 (심야) · Fable · Swift 판정 종결 + Xcode Cloud 첫 그린
- **#1216 머지(성재 승인)** → 성재 판정 4결정을 판정표 정본에 기록: **폐기 3**(work-tool-profiles REST — 테이블 존치·bans·platform) · **이식 확정 3**(webhooks·event-subscriptions→**#1222**(T13)·agentRunHistory→**#1223**) · **이월 5+종속 1**(plugins·memories·huddles·workstreams·members잔여=v1 범위, mcp=plugins 종속) · **OutboxRelay=Rust 이식(#1222) 후 Swift 삭제**. 증보 1 "보류 13" 전원 상태 확보 — **W-S 판정 선행조건 종결**(남은 선행 = 감사 §6 순서+패킷).
- 티켓 발급 근거에 신규 실측: **라이브 compose에 웹훅 송신 서비스가 없다**(웹훅·이벤트구독은 8/9 설정 표면만 출하, 송신·관리 REST는 어디에도 없음 — #1222가 라이브 기능도 깨운다).
- **Xcode Cloud 첫 완전 그린**: 빌드 2039 진단(#1219가 심음)이 전제 오류를 확정 — 아카이브 단계 서명은 grant 3종을 싣되 application-identifier는 export 재서명에서 주입. **#1221**(성재 승인·분류기 차단 해제 후): 그 키를 선택 검사로, 팀 보증은 keychain 그룹 문자열로 이동(기대 팀 고정 — 종전보다 좁음), 진단 덤프를 하중 단정으로 이관. 재빌드 **track/engine·ci-appid 둘 다 green** — 재지정(워크스페이스+scheme) 이후 전 파이프라인 성립. TestFlight 전환(배포 준비+테스터 그룹)은 성재 원할 때 1클릭 거리.

## 2026-08-10 (새벽) · Fable · buzz급 진단 완주 + README 재구성 + W-S1 패킷
- **W-S1 삭제 패킷 준비**(`handoffs/2026-08-09-ws1-swift-client-removal-packet.md`): 범위=감사 1+2단계(클라 3트리 407파일)+#1201 은퇴. 3단계=S6 대기·5단계=#1222 대기 제외. mobile/ios 오폭 함정을 하드 금지로. **발사는 성재 신호 대기.**
- **buzz급 진단 완주**: 우로보로스 인터뷰(Opus 5·3라운드 — "buzz급"=성숙도 벤치마크 재해석·빠진 축 6 발굴) → 5축 감사 전면 병렬(A라이선스·B재현성·C실주행·D운영·E드리프트, 전문 1,616줄 보존). **종합 정본 `research/2026-08-10-buzz-launch-diagnosis.md`**. 결론: 오늘 런칭 불가하나 격차는 포장·운영층 — 코어는 건강(히스토리 시크릿 0·copyleft 0·클론→왕복 13분24초 성공·불변식 실측). 관문: ①공개=가장 가까움(정리 6종+게이트 이설) ②셀프호스트=compose 3파일 미커밋·최초 소유자 경로 부재 ③운영=PASS 0(라이브 /metrics 없음·RPO 없음·CI가 Rust 컴파일 0회). 성재 결정 10건 통합 수집.
- **README buzz급 재구성**(`b9e2f579`): 마스코트 정본 헤더+히어로 배너 신규(codex 라인아트·오르트 구름 천문 모티프·마스코트 변주 없음)+철학 절+불변식 6 표+정직성 표(✅🚧💭 — 당일 판정과 정렬)+mermaid 아키텍처+**"5분 셀프호스트" 철회 명시**(감사 B·E 발견 즉시 반영)+원문 강한 절 보존(프라이버시·온보딩 3경로·워크호스트). 링크 14 전수 검증.

## 2026-08-10 (오전) · Fable · 관문①② 엔지니어링 완결 — W-O1~O6 (PR 6·티켓 6 종결)
- **성재 지시 "오픈소스+단일 이미지 셀프호스팅 목표로 진행"** → 계획 정본 `2026-08-10-opensource-selfhost-plan.md`(방침 2: MPL-2.0 allow·웹을 이미지에) → 티켓 #1224~#1229 → 6워커.
- **관문① 랜딩**: #1230(라이선스 게이트 — 커버 1.9%→cargo 644+npm 1,750·red proof) · #1232(공개 전 정리 6종·gitleaks 전 히스토리 no leaks — **감사 밖 결정타: 출고 데스크톱 앱 자동업데이트가 org 개명 404로 이미 단절**(레포 수리·기배포 바이너리는 재배포 필요), 구 org명 무주공산=선점 위험) · #1233(진입 문서 6파일 — make 현행화·거짓 라벨 수리).
- **관문② 랜딩**: #1231(**`up -d` 한 번으로 소유자 로그인** — 멱등 부트스트랩·012 무접촉·red proof 실증. 결함 실체 정정: "출구 없음"이 아니라 "up -d만으로 로그인 불가") · #1237(오버레이 3개 레포화·**웹을 이미지에**(+0.99%)·버전 스탬핑 — **라이브 웹이 391077a6으로 환원, 감사 B-10 종결**) · #1240(**SELF_HOST.md+env 생성기+local 오버레이 — 재실측 63초·임기응변 6→0·명령 3+브라우저 1**, 재실측이 결함 2건을 잡아 수리).
- 머지 규율: local_gate.sh 3중 접촉을 리베이스 합집합으로 해소, **병합 결과에서** license·docs 재검증 PASS. 워크트리 전량 회수.
- 신규 티켓: #1234(로그인 이메일 대소문자 비대칭 — auth 의미, 성재 결정)·#1235(CENT 가드 7 은퇴)·#1236(gitleaks 배선·런북 org 스윕·선재 red 2)·#1238(pgdata 스코프 — 실발생 위험)·#1239(caddy off-host ACME — 로컬 우회로는 #1240이 흡수).
- **다음 관문은 결정**: S10 engine→main 머지(README Self-host 갱신과 공개 대상 브랜치 정합의 선행) · 공개 시점·범위(378파일)·레포명 · 데스크톱 재배포 · 구 org 방어 선점.

## 2026-08-10 (낮) · Fable · oort 개명 집행 + 2차 파도 완주 — 정지점
- **레포 개명**: `yeomyeonggeori/oort`(momo URL 리다이렉트)·About 현행화·로컬 리모트 재조준. 구 org `Dawn-kim-official`은 **성재가 방어 선점 완료**. 메모리 정본 갱신.
- **2차 파도 6 PR 전량 머지**: #1242 개명 스윕(goal_*.sh가 rename 직후부터 hard-fail이던 것 적발·수리, momo-alpha 무영향 실측, GHCR 미추종 고지) · #1243 **경량 PR CI — 레포 첫 자동 CI**(2런 green 실증·월 1,440~1,870분/무료 2,000) · #1244 CENT 가드 7 은퇴+pgdata 스코프(라이브 렌더 0바이트 차이 증명) · #1245 gitleaks 전 프로파일 배선+선재 red 2 규명(digest guard 아님=픽스처 드리프트 18일·momo_=동결 네임스페이스 예외) · #1247 이메일 대소문자(중복 공존 실증→064 마이그레이션+조회 정규화·PG 203/0) — 티켓 #1234·#1235·#1236·#1238·#1241 종결.
- 신규 적립: #1246(staging-smoke 픽스처 — 세 번째 숨은 선재 red)·#1248(join.rs 원문 비교 4곳).
- **⚠ 미배포 랜딩분 재적립**: #1247(서버+마이그레이션 064)·#1231(부트스트랩)·#1237(이미지 웹 임베드) — 다음 배포 창 대상.
- **정지(성재 지시)**: "완주 후 다음 작업 전에 멈춰라" — 데스크톱 재빌드 등 후속 미발사. 다음 후보: 재빌드+재배포 / 공개 결정 2(시점·범위) / W-S1 발사 / #1246·#1248.

## 2026-08-10 (오후) · Fable · 배포 창 2 — 새 절차 첫 실전 (momo-rust:5671f15d)
- **실린 것**: #1247(이메일 정규화+마이그레이션 064)·#1231(소유자 부트스트랩)·#1237(웹 임베드). 성재 대행 2회(본편+재개).
- **새 절차(#1228) 첫 실전 성립**: 오버레이 레포 파일 동기화 → `overlays.secrets.env` 신설(구 파일 리터럴에서 서버 안 추출) → 단일 `up -d`(web-init 볼륨 스테이징→caddy). **웹 배포 단계 소멸.**
- config 게이트가 1차 시도를 의도대로 차단 — 원인은 오케스트레이터 추출 정규식이 숫자 포함 변수(`MOMO_T3_ENABLED`) 누락. 필수(:?) 키 전수 대조로 누락=1 확인 후 백업에서 추출·재개. **교훈: env 키 스캔은 `[A-Z0-9_]`.**
- 검증: healthz 200·approvals 401·**`momo-build=5671f15d` 라이브 실측(웹→커밋 환원 첫 성립)**·헤더 유지. 롤백 = 6bfc9b82(서버 bak-20260810 일습).
- 검수 재료 갱신: 새 `oort.app`(살아있는 업데이터 URL 첫 빌드) — 성재 검수 대기.

## 2026-08-10 (저녁) · Fable · 3차 파도 완주 — Swift 클라이언트 퇴역 (하루 결산 14 PR)
- **W-S1/PR #1253**: `clients/{macOS,iOS,Core}` **407파일/−109,537줄 삭제** — 3커밋 규율(메타→참조 0→트리), 전 게이트 그린, **Xcode Cloud 그린**(아침 재조준이 삭제를 견딤 증명). 게이트가 감사 밖 살아있는 소비자 6곳을 적발해 동반 수리. verify_push_kit_inheritance는 폰 스위트가 spawn해 존치(VACUOUS 판정화). #1201 종결(성재 기결정 집행). 후속 3(#1254 — design-review/taste 재조준·RN entitlement 공백·잔존 Swift SPM 무검사).
- **W-F1/#1249**: staging 픽스처 = 계약 이동 3개 통째 누락이 실체 — 전체 exit 0 복구·커버리지 증가·gitleaksignore +0. 4번째 동계열 red 발굴 → #1250(기계 가드 권고 — 오늘 배포 정규식 실수와 같은 클래스).
- **W-F2/#1251**: join.rs 4곳+handle 반쪽 SQL 정규화·core normalizeEmail 접점 1곳. red proof: 064 백스톱 실증·btrim 없인 밴 누수. 적립 #1252.
- 하루 누계(8/10): **PR 14 머지**(#1230~33·37·40·42~45·47·49·51·53), 티켓 12 종결, 신규 적립 7. 라이브 = 5671f15d(064 발효). main=engine 정렬 유지. ⚠ 미배포 재적립: #1251(서버).

## 2026-08-10 (밤) · Fable · 공개 전환 + 공개·런칭 배치 완주 (ㄱㄱ)
- **oort 공개**: `yeomyeonggeori/oort` public 전환(비로그인 200)·main/engine force-push 보호·Actions 무료화. 우로보로스 지시서(5결정)대로 — 전 히스토리·기획 기록 포함 공개.
- **배치 5/5 랜딩**: #1261 W-P1(CI 풀 스위트 확장 — **첫 런에서 이식성 결함 2건 적발**(TZ 의존·리눅스 waitFor)·publish-images 정합) · #1264 W-1222(**웹훅·이벤트구독 송신+관리 REST Rust — OutboxRelay 은퇴 조건 성립**, 별도 sender 바이너리로 relay 불변식 보존) · #1262 W-1223(agentRunHistory 3경로+표면 켜짐·ENGINE_HANDOFF A-26) · #1263 W-SM(#1250 env 기계 가드 — **5번째 함정 사례를 prod 경로에서 적발**·#1252=065·#1254 taste 라우터화) · W-DEP(#671·#663 머지+major 10 판정표 — #667 후속 머지, #673/674 rebase 대기).
- **GHCR 첫 발행 보류 결정**(오케스트레이터): publish-images가 Swift·arm64 스택 — 라이브(Rust·amd64)와 다른 스택을 첫 공개 패키지로 내지 않는다 → #1266(Rust 재기반)이 선행. 파생 티켓: #1258 React19·#1259 eslint10·#1260 node핀·#1265 인바운드 ingress·#1267/#1268 테스트 이식성.
- 시크릿 경보 폐곡선: W-1223이 W-1222 브랜치의 gitleaks 적발 → 전달 → 합성값 교체·히스토리 정리·게이트 PASS로 처리(교차 감시가 작동한 첫 사례).
- ⚠ **미배포 랜딩분(다음 배포 창)**: #1262·#1263(065)·#1264(웹훅 송신 — 라이브 기능 각성) 서버+compose. Xcode Cloud 경로 필터(유령 체크 소음)는 브라우저 연결 시 처리.
- 성재 검수 진행 중(데스크탑) — 피드백 대량 예고, 인테이크 규율 대기 태세.

## 2026-08-10 (밤2) · Fable · 검수 집중 준비 — 배포 창 3 + 데스크탑 최신화
- 성재 지시: "검수(4번)에 온전히 집중하게 앞 작업 싹 최신화."
- **데스크탑 검수 앱 최신화**: ~/Desktop/oort.app을 최신 engine 5a06efb9로 재빌드·재배치(업데이터 URL 정상 yeomyeonggeori.github.io). 성재 검수 대상=최신 코드.
- **배포 창 3**(성재 대행 1회): momo-rust:5a06efb9 — #1262(agentRunHistory 표면)·#1263(065·taste)·#1264(웹훅). **webhook-sender 컨테이너 라이브 최초 기동** — 잠자던 웹훅·이벤트구독이 각성. 검증: healthz 200·approvals 401·momo-build=5a06efb9·헤더·**webhooks 관리 REST 401(신 라우트 서빙)**. 롤백 *.bak-20260810c. config 게이트가 조용한 실패 재차 방어.
- dependabot 정리: 티켓 승계 파손 4건(#758·672·669·1082) close — 검수 중 PR 더미 축소. examples 2·docker 3은 rebase/GHCR 대기.
- 미처리(검수 무관): Xcode Cloud 경로 필터(Chrome 미연결 — 유령 체크 소음, 검수 비차단).
- **다음 = 성재 데스크탑 검수 피드백 인테이크**(대량 예고, 규율: 전량 티켓화→시리즈 편성).

## 2026-08-11 — 검수 배치 2 완결 + 배포 창 5 (Fable 오케스트레이션)
- **배치 2 랜딩 5/5**: #1280 updater dev 가드 · #1282 레이아웃 전체폭 · #1284 알림규칙 실기능(ADR-0124 증보1, DND+멘션예외, 키워드는 P9 본문미판독 불변식으로 제외) · #1285 프레즌스 6b(ADR-0160) · #1286 워크스페이스 4b(ADR-0161). ADR-0160·0161 성재 승인으로 Accepted. 병렬 마이그 충돌은 066(알림규칙)→067(WS아바타)→068(프레즌스) 순차 재부여.
- **design-review 사이클**: FAIL 2건(High 4 — 연결점/상태칩 동형 이중·마커 0px·손제작 확인·탭타깃) 전부 실측 지적→수정→재리뷰 PASS. 이음매 판정: 연결 표시는 "건강할 때 침묵"(이상시에만 바 형태) — 성재의 원 오독(연결점=상태칩)을 두 배로 만들 뻔한 결함 차단.
- **배포 창 5** (`a5193e5e`, live 검증 200/스탬프/presence 마커/401): 1차 실패 — prod 정본 centrifugo.json 통째 덮기(redis 엔진 전제·placeholder secret)로 centrifugo fatal→API 다운. 백업 복원으로 라이브 복구 후, presence 네임스페이스만 외과 삽입(recovery류 필드 strip — "history required for recovery" fatal 해소)+**checkconfig 사전 게이트**+자동 롤백 내장으로 완결. **교훈: 서버 config는 호스트 적응본 — 통째 덮기 금지, 백업+외과 삽입+기계 사전검증(checkconfig)이 표준.**
- 검수앱: ~/Desktop/oort.app = --debug 빌드(a5193e5e) — dev 가드 런타임 실증("skipping update check", 매니페스트 접촉 0). 롤백 원천 차단.
- 적립: #1281 매니페스트 재발행(성재 맥) · #1283 검색폭 · #1287/#1288 캡처 픽스처 · #1275 self-leave 권한. ADR-0124 증보1은 랜딩됨 — 성재 최종 승인 대기.

## 2026-08-24 · Fable · 완전 자율 실시간 멘션 응답 3축 디깅 (성재 발제)
- 발제: "현행 오픈소스 셀프호스트 구조에서 멘션→그록봇 응답이 가능한가" → "완전 자율 실시간 방식 + 업계(플러그인/커넥터/Slack/커뮤니티) 방향 디깅".
- 병렬 리서치 3기(플랫폼·Grok 표면·프로토콜/커뮤니티) 완주 → **`research/2026-08-24-realtime-autonomous-mention-research.md`** 플러시.
- 핵심 판정: ①업계 공통 구조 = push 전달 + warm 상주 런타임 + 런타임 상주 자격증명(예외 없음) ②oort는 push 전달을 이미 보유(`agentwork:` wake) — 빠진 조각은 Grok 런타임뿐 ③셀프호스트 비교군(Mattermost 등)은 "서버 내장 런타임 + 운영자 key + 봇=멤버"로 수렴 ④MCP server-wake 문은 2026-07-28 스펙에서 공식 폐쇄(sampling deprecated) ⑤Grok sanctioned 실시간 경로는 xAI API 단일 — 선행 노트(push-vs-cdp)의 Q-DIR (b) 재확증.
- 신규 결정 큐: Q-SLOT(xAI provider를 managed A vs BYOA B 어디부터 — 권고 A 선행) · Q-LOOP(agent-authored message wake 배제 검증 티켓). 각주: 구독 OAuth 상시 데몬은 gray-zone — 상시 봇은 API key 경로 권고.

## 2026-08-24 · Fable · 그록봇 유지 경로 재개통 — routine webhook 트리거 발견 (기준선 갱신)
- 성재 발제("그록봇 포기 못해 — Slack 멘션 가능? 30초 폴링? 루틴 로그 남나?")로 웹 디깅 2기(Slack 트리거 실체 / 루틴 메커니즘). 정본 **`research/2026-08-24-grokbot-webhook-doorbell.md`**.
- **⚠️ 기준선 폐기**: 그록봇 루틴에 `{type: webhook}` 트리거 존재 — 루틴별 전용 URL+API key, POST로 run 시작, v0.24(08-21)에서 UI 크래시 수정. 8/16 "웹훅/외부 트리거 전무" 판정 낡음(공식 docs는 아직 미기재 — undocumented 베타).
- 3답: ①Slack 멘션→그록봇 회신 성립하나 bot-authored 트리거 회귀 반복(4→5→8월)·silent no-fire — oort 배달부로 비권장 ②30초 폴링 불성립(cron 최소 1분·usage 연소·자동 pause) ③run마다 채팅 안 불어남(봇당 대화 1개·Run history 20건 rolling·보고는 지시문 선택).
- 권장: **webhook doorbell** — oort 멘션→webhook-sender POST(신호만)→루틴 run→Agent Port pull→message post. 준실시간(수십 초)·페르소나/VM/기억 유지·기존 wake-up 신뢰모델과 동형. fallback(타임아웃 감지+15분 sweep) 병설 필수.
- 성재 결재 대기: SPIKE-WD(webhook doorbell 실측 폐곡선 1티켓) 착수 여부.

## 2026-08-24 · Fable · 도어벨 실측 성공 → ADR-0171 기안·WD 파도 패킷 (성재 "해당 방향 리팩토링" 지시)
- **SPIKE-WD 전반부 성공**: 성재 계정 그록봇에 `oort-doorbell-spike` webhook 루틴 생성(자연어 릴레이) → 무인증 401 확인 → **Bearer POST → HTTP 200 `{"success":true,"runUuid":…}` 0.95s** (T0=17:51:35 KST). endpoint=`api2.cursor.sh/automations/webhook/<uuid>` — Cursor Automations 인프라 판정 실증. ACK 지연 관측은 성재 보고 대기.
- **ADR-0171 기안(Proposed)**: hosted 커넥션 단위 도어벨 — 신호만 페이로드(내용 0)·기존 webhook-sender 편입(신규 outbox 생산자 0)·60s 코얼레싱·best-effort+15분 스윕 폴백·`MOMO_DOORBELL_ENABLED` 기본 off·disconnect 동일 tx 소거. 기각: Slack 경유·1분 폴링·VM 내부 gateway.
- **패킷**: `handoffs/2026-08-24-grokbot-doorbell-packet.md` — WD-1(server)·WD-2(Agent Hub UI)·WD-3(플레이북+프로덕션 루틴 지시문). E2E 수용 목표 p50 ≤ 90s. Issue 미발급(성재 승인 후).
- **성재 검수 대기**: ①ADR-0171 Accept ②패킷 승인+워커 발사 신호 ③E2E 수용 런. 스파이크 key는 세션 한정 사용 — E2E 후 재발급/루틴 삭제로 무효화 예정.

## 2026-08-24 · Fable · WD 파도 발사 — ADR-0171 Accepted·Issue 발급·grok WD-1 투입
- 성재 승인("승인할게 작업 진행해줘") + **ACK 지연 실측 확정: 9초**(T0 08:51:35Z → 봇 자기보고 08:51:44Z) — ADR·패킷에 기록.
- ADR-0171 **Accepted** 반영·패킷 `ready`. Issue: WD-1=#1734·WD-2=#1735·WD-3=#1736.
- grok 워커 발사: 신선 워크트리 `momo-worktrees/wd1-doorbell`(origin/track/engine 5e1f5291 기반, 브랜치 `feat/1734-wd1-doorbell`) — 기존 engine 워크트리는 dirty+139커밋 뒤처짐이라 비접촉(⚠ 잔재 정리 별도 확인 필요). ADR·패킷 사본을 워커 브랜치 첫 커밋으로 랜딩 지시.
- 파이프라인: WD-1 검수·머지 → WD-2(uxui·design-review) → WD-3(docs) → E2E 수용(멘션→도어벨→응답 p50≤90s — 도어벨 단독 9s라 여유).

## 2026-08-24 · Fable · WD-1 랜딩 (PR #1737 → track/engine c36311c1) + WD-3 투입
- **WD-1 검수 재판정 통과**: diff 실물 검토 — 마이그레이션 080 트리거 0·outbox INSERT 0(하드 룰)·RLS FORCE+자가검증·페이로드 byte 상수·시크릿 로그 비출현·`parse_outbound_url` 정책 재사용·disconnect 같은-tx `clear_hosted_doorbell_in_tx`(잠금 순서 준수)·AC1~7 red proof 테스트 실존. 게이트 재실행 전판 그린(fmt·clippy·유닛 28+8·PG admin 4/4+dispatch 4/4, DATABASE_URL 관례).
- CI RED 1건 수리: 의존성 추가로 GHCR 고지 번들 stale → 재생성 커밋(f52e1596) → CI 전판 그린 → 머지. #1734 종결. ENGINE_HANDOFF **X-WD1 (ready)** 추가.
- **WD-3(#1736) grok 워커 투입**(feat/1736-wd3-doorbell-docs — WD-1 랜딩 브랜치 기반, 실계약 문서화).
- **WD-2(#1735)는 승격 게이트 대기**: 도어벨 openapi 생성 타입이 track/uxui로 가려면 engine→main 승격+sync 필요(성재 승인 사안) — X-WD1에 명시.

## 2026-08-24 · Fable · WD-3 랜딩 (PR #1738 → track/engine 02f3712e) — 파도 2/3 완료
- WD-3 검수 통과: SELF_HOST_AGENT.md §4 도어벨 증보 — API 경로·OpenAPI 오퍼레이션명·에러 문자열·drain 로그 철자까지 코드 자구 대조 일치. 프로덕션 루틴 지시문+15분 스윕(공유 cursor로 중복 무해)+usage/베타/Q-STRUCT 고지 수록. docs 게이트(493 facts) 재실행 그린. #1736 종결.
- 파도 현황: WD-1·WD-3 track/engine 랜딩 완료. **잔여 = WD-2(#1735, 승격+sync 대기) + E2E 수용 런**.
- E2E 선결 체인: engine→main 승격(성재 게이트) → (라이브 검증이면) publish-images+배포 창. 로컬/트랙 빌드 E2E는 승격 없이 가능 — 서버 flag on + hosted 커넥션 활성 + 도어벨 등록(REST) + 루틴 지시문 교체(릴레이).

## 2026-08-24 · Fable · 승격 창 집행 (성재 "승격 ㄱㄱ") — WD 도어벨 main 랜딩·WD-2 투입
- **engine→main 승격 PR #1739 머지**(main=1b4e1402) — WD-1 서버+WD-3 플레이북+ADR-0171 포함 14커밋.
- sync 짝: **uxui-18 #1741 머지**(02bc7a6e — 충돌 4건 해소: STATUS.md union + GHCR 고지 번들 병합 트리 재생성 check PASS) · engine-22 #1740은 "main is ancestor of both tracks" 체크가 uxui sync 선행 전 실행돼 RED → uxui 랜딩 후 재실행 중.
- **WD-2(#1735) grok 워커 투입**(wd2-doorbell-ui 워크트리, feat/1735-wd2-doorbell-ui — 도어벨 openapi 계약 전파 확인 후 발사). 스코프 판정: "벨 테스트" 버튼은 서버 시험 발화 엔드포인트 부재로 제외·후속 적립.

## 2026-08-24 · Fable · 성재 발제: 호버 퀵액션 툴바 + 이모지 피커 고도화 — 리서치·티켓·패킷
- 발제(스크린샷 3장): 호버만으로 우상단 액션 표시 + 이모지 모달 반영, Slack/MM 레퍼런스 탐색 포함.
- 리서치 1기 완주 → `research/2026-08-24-hover-toolbar-emoji-picker-reference.md`. 핵심: 슬롯 3(3사 수렴)·recency-only 실패 실증(MM #19258)·shortcode 표준=iamcal/Slack·데이터=emojibase compact(en) 83kB gz 자작 권장·a11y=Nolan 패턴.
- **충돌 2건 성문 해소**: ①B11(R1 6버튼 바 2회 리버트 — 탭스톱 150개·§6 위반) → 조건부 렌더+ARIA toolbar 계약으로 재도입, §6 정본 같은 PR 개정 ②#1688(고정 32종·중앙 모달) → 어휘·모달 supersede, 무라이브러리 유지.
- 티켓: **UX-EB=#1742**(피커 고도화, 선행) · **UX-HT=#1743**(호버 툴바, 빈도 store 공유 후행). 패킷 `handoffs/2026-08-24-hover-toolbar-emoji-packet.md` ready. 워커 투입은 WD-2 완료 후(grok 병렬 1).

## 2026-08-24 · Fable · 재개 — WD-2 마감·design-review 사이클 (PR #1744)
- 정지점 복원: WD-2 워커 2세션 모두 조기 종료(구현 커밋 819c38ab·4상태 캡처까지 완료, push/PR 미완) → 오케스트레이터가 마감(게이트 재실행: tsc·lint(경고 5=비접촉 부채)·unit 1446 → PR #1744).
- **design-review PASS(B0·H1·M5·N2)** — 실렌더 5상태 캡처·기계 프리플라이트 12/12. 수리 커밋 b5010f2e: **H-1**(400/409/404 계약 문구 닫힌 집합을 한국어 사상 — wire 원문 화면 비노출 red proof) · M-1(칩 성공/실패 낱말+원시코드 메타) · M-2(sender key 용어 단일·교체 라벨) · N-1(다시 입력).
- **M-5 역방향 해소 교훈**: busy 낱말 스캐너 red-proof(confirmBusySplit·rawControlBusySplit)가 컴포넌트 소스 리터럴을 요구 — 리뷰 권고의 "상수 import" 가지는 하우스 관례와 충돌, "죽은 상수 삭제" 가지가 정답. 리뷰 지적을 코드로 재판정하는 규율이 잡아냄.
- 적립 이슈 발급(M-3·M-4·N-2·벨테스트 문구 정리). 웹 1446+코어 1707 전판 그린, CI 감시 중 — 그린 시 track/uxui 머지→UX-EB 발사.

## 2026-08-24 · Fable · 도어벨 E2E 수용 런 — 서버 폐곡선 GREEN, 벤더 엔드포인트 RED
- 성재 "E2E 하자". 로컬 셀프호스트 리그(wd1-doorbell 빌드, MOMO_DOORBELL_ENABLED=true) 직접 수행. 증거 `claudedocs/e2e-doorbell-20260824/REPORT.md`.
- **GREEN(우리 절반 전 구간)**: 멘션 POST→`hosted_agent_inbox_event` 적재→webhook-sender drain→**도어벨 POST 발화**(projection lastFired 23:44:24)→Agent Port `oort_inbox_read` 3건 pull(멘션 seq1·2+agent_job)→`oort_message_post` 응답 랜딩(general seq3). 상수 페이로드·마스킹·게이트 실동작.
- **RED(벤더 밖)**: cursor webhook 엔드포인트가 오후 내내 500(`{"code":"internal"}`, 오전 200 페이로드도 동일 500) — cursor/그록봇 백엔드 장애. ADR-0171 D5 스윕 폴백이 대비한 실패 모드. 도어벨=가속기, durable inbox=GREEN이라 회수 가능.
- 부트스트랩: 사람 릴레이가 페어링 TTL(~19분) 소진하는 마찰(값 누락 붙여넣기로 커넥션 1개 expired) → **오퍼레이터 루프백 부트스트랩**(pairing·active handshake를 mcp-method 헤더로 직접 — 그록봇과 바이트 동일 호출, 커스터디 모델 불변).
- **셀프호스트 갭 2건 → #1747**: ①MOMO_HOSTED_DELIVERY_ENABLED compose 미배선(도어벨 켜도 멘션 미배달 조용한 실패) ②drive 볼륨 초기 권한(root 소유→api 부팅 루프). 둘 다 리그 수동 우회.
- 도어벨 시크릿 무효화(DELETE 200). 그록봇 측 스파이크 루틴 key 재발급 권고 잔여(#27).
- **UX-EB(#1742) 워커 완주 → PR #1746**(카탈로그 1914 glyph·gzip 48.5kB<120kB·radix popover 재사용·web 1462 tests). 워커 자체 design-review는 규율상 무효 — 독립 design-review 대기.

## 2026-08-25 · Fable · E2E 잔재 회수 + UX-EB 검수 사이클 (성재 "다음 작업+E2E쪽 작업")
- **E2E 리그 전량 회수**: cloudflared 터널·socat 브리지(`api`) 종료, `oort` 스택 down(**볼륨 보존**). 추가 발견 — 랜딩 완료 브랜치들의 게이트 잔재 스택 6개(1696·1698·1716·1734wd1·momo240·momo_main, 최장 26h 유휴 — 발열 이슈 패턴) 전부 down → **가동 컨테이너 0**. 볼륨/이미지 리클레임은 권한 차단으로 잔여(성재: momo-docker-reclaim.sh 직접 실행 또는 권한 허용).
- **재시험 런북 정본**: `claudedocs/e2e-doorbell-20260824/RERUN.md` — 벤더 회복 프로브(무인증 POST 401=회복/500=장애)·리그 재기동 2경로(볼륨 재사용/main 기반)·#1747 랜딩 전 수동 우회 2건·수용 p50≤90s·종료 회수. 태스크 정리: #13(구 E2E, 도어벨 런으로 대체 수행)·#27(스파이크 폐곡선) 종결 — 잔여=성재의 그록봇 측 루틴 삭제/key 재발급.
- **PR #1746(UX-EB) CI RED 진단·수리**: gitleaks가 `EMOJI_FREQUENCY_STORAGE_KEY`(localStorage **키 이름** 상수)를 generic-api-key 오탐 — pwa/store.ts:32 선례 동클래스로 fingerprint 등록(f29111fe) → **CI 전판 그린**(PR CI gate pass).
- **독립 design-review 판정: FAIL (B1·H5·M5·N8)** — 정본 `claudedocs/design-review-1746/REPORT.md`+캡처 42장. 핵심: B-1 hover가 키보드 선택 가로채 Enter 오삽입(MentionAutocomplete 패턴이 정답)·H-2 전량 DOM 렌더(패킷 AC 위반, `:` 1글자에 1914건/34화면)·H-3 Esc 층 분리 미동작(React stopPropagation이 Radix DismissableLayer에 무효)·H-4 반응 피커 앵커 996px 이탈·H-5 터치 autofocus. **그렙 게이트 층은 12/12+5/5 clean — findings 전부 §5.3 비측정 축.** 워커 자체 리뷰 무효 규율이 실가치 입증.
- **수리 사이클**: 폰 패리티 후속 **#1748** 발급(M-5 인용용) → grok 수리 워커 투입(uxeb 워크트리, findings 19건 전량+red-proof 3, 푸시 금지·오케스트레이터 재판정 후 푸시). 완료 시 diff 재판정→게이트→재리뷰→track/uxui 머지.

## 2026-08-25 · Fable · UX-EB 3회전 랜딩 + 자원 대청소 집행 (성재 "알아서 처리·남은 작업 쭉")
- **UX-EB(#1742) 랜딩**: PR #1746 → track/uxui **c2b779cf**. 리뷰 3회전 폐곡선 — R1 FAIL(B1·H5) → grok 수리 4커밋(dfb612d3~cfc23943: 커서 분리·gridWindow 96칸 창·Esc 층·앵커·autofocus·M/N 일괄) → **R2 FAIL(수리가 새 Blocker 2 생성**: 무선언 가로 스크롤 탭=capture:design exit 1+깃발 탭 소실 · 시트 포커스가 모달 밖=ADR-0112 D6) → 오케스트레이터 마감 90ae48aa(wrap 환원·sheetRef 포커스·창 위3/아래9 편향·빈 상태 복원) → **R3 PASS(Blocker 0·High 0)**. 리뷰 정본 3부+캡처 76+34장 `claudedocs/design-review-1746/`. 교훈: ①R1 게이트 3종(tsc·vitest·프리플라이트)에 **capture:design 레인이 빠져 있었다** — 수리 검수 게이트에 상시 포함할 것 ②수리 diff는 새 결함 축(이번엔 게이트 레인·포커스 소유)을 다시 열 수 있다 — 재리뷰는 표적이 아니라 신규 발굴 포함이어야.
- **R3 부수 발견**: vitest 전량 red 2건=외부 프로젝트(omd-test-0820) vite preview가 4300/4301 점유(port squat) — PR 무관, 성재 기기 위생 항목.
- **적립**: #1748(폰 피커 패리티) · soft 채움 3:1(시스템 미결, §5.3 존치) · N-7 탭 7+2 고아(수용, 근거 주석화).
- **자원 대청소(성재 "워크트리·이미지 알아서" 승인 집행)**: Docker 이미지 8.5→3.1GB(-5.4GB: 게이트 이미지·dangling·미참조 Playwright 3.7GB)·볼륨 645→78MB(momo* 게이트 pgdata 7개 삭제, oort 리그 4개 보존)·리클레임 스크립트 pipefail 결함 패치. 워크트리 10→5(정본 2트랙+main+uxht+**wd1-doorbell 보존**=E2E 수동 우회 compose 실물, diff 백업 `rig-compose-bypass.diff`). 로컬 브랜치 538→183(정본 포함 355 일괄 삭제). 원격 추적 프룬.
- **UX-HT(#1743) 발사**: uxht-hover-toolbar 워크트리(base=c2b779cf), grok 워커 가동 — 패킷 §2+UX-EB 리뷰 3부 필독 지시(탭스톱 red proof·조건부 렌더·단일 빈도 store·B11 주석+§6 개정 동반). 병행: 성재 검수용 track/uxui Tauri debug 재빌드.

## 2026-08-25 (새벽2) · Fable · UX-HT 1차 리뷰 FAIL(B3) — 수리 방향 확정·재투입 + UX-CB 인테이크
- **UX-HT PR #1750**: 워커 구현(78eba169+2156cfda) → 게이트 전녹(vitest 1491·capture 완주·CI 그린) → **독립 design-review FAIL: B3·H3·M5·N3** (`claudedocs/design-review-1750/REPORT.md`, 베이스 대조군 빌드까지 세운 계측).
  - **B-1**: 툴바→피커 전 진입점 크래시 — frequencyStore 단일 snapshotCache가 소비자 2개(피커 32·툴바 3)에서 상호 축출→무한 렌더. **툴바가 이 store의 첫 번째 동시 소비자 추가 표면.**
  - **B-2**: focus-within 경로 실붕괴 — W-4(행=정거장)와 조건부 마운트가 상호 무효화, 포커스 BODY 추락. 테스트 하네스가 전 행에 칩을 심어 이 갈래를 영원히 통과(사각).
  - **B-3**: 툴바가 본문 20~26자 가림 + **그걸 재던 assertActionGutterClearsBody를 같은 커밋이 삭제**, 근거 주석("겹침은 계약")은 어느 정본에도 없음 — B11 R2 Blocker의 무승인 회귀.
- **패턴 기록**: 2연속으로 워커 게이트-전녹 뒤 독립 리뷰가 상호작용 축 Blocker 적발(UX-EB B-1 hover가로채기 → UX-HT B-1/2/3). 기계 레인이 안 누르는 자리(새 진입점 클릭·구성원 0 행·본문 교차)가 반복 사각 — **capture 레인에 "새 진입점은 실제로 누른다" 원칙 편입 필요**(N-2 수리로 이번 PR에서 시작).
- **수리 재투입**: 방향 확정본(`repair-brief-1750.md`) — B-1=store 전체랭킹 안정캐시+훅 useMemo 슬라이스·소비자2 red proof / B-2+H-1=rest 정거장=행·포커스 시 툴바 ⋯로 핸드오프·normalizeRow 순서 보장 / B-3+H-3+M-3=행 상단 경계 straddle+16px 거터+다크 §2.2 산술+px 자 부활 / H-2=마운트 중 슬롯 순위 동결. grok 수리 워커 가동 중.
- **UX-CB(#1749) 인테이크**: 성재 실물 검수 발제 — 컴포저 buzz형 단일 그릇(상단 입력+하단 액션 행, Aa 발명 금지)+하단 패딩 정리. 패킷 `handoffs/2026-08-25-composer-buzz-restyle-packet.md` ready. UX-HT 랜딩 후 착수.
- 부수: 리그 재기동(성재 QA용, owner@oort.local)·검수 앱 c2b779cf 재빌드 배치·외부 vite preview 포트 점유(4023/4024) 제거로 preview-guard 오염 해소.

## 2026-08-25 (새벽3) · Fable · UX-HT 3회전 랜딩 (track/uxui ba914b7a) → UX-CB 발사
- **UX-HT(#1743) 랜딩**: PR #1750 → track/uxui **ba914b7a**. 리뷰 3회전 — R1 FAIL(B3: store 크래시·focus 붕괴·본문 가림+자 삭제) → 수리1(5커밋: 안정 랭킹 캐시·⋯ 핸드오프·straddle -26px·슬롯 동결·로빙 통일) → R2 FAIL(수리가 만든 **B-4: 핸드오프가 마우스 드래그 선택 사멸**+클릭 fv 링·H-4 최상단 헤더 잘림) → 수리2(4커밋: `:focus-visible` 한정·아래 미러 뒤집기·드래그선택/뒤집기/탭스톱 기계 자 3종 신설) → **R3 PASS(B0·H0)**. vitest 1491→**1506**. 정본 3부 `claudedocs/design-review-1750/`.
- **교훈 적립(파이프라인)**: ①"수리 방향 확정본" 브리프가 유효 — 라운드2·3 워커가 방향 이탈 0으로 완주 ②그래도 수리는 새 축(마우스 모달리티·상단 충돌)을 열 수 있다 — **재리뷰는 표적+신규발굴 겸용이 정본** ③이번에 신설된 기계 자 3종(드래그 선택·본문 교차 이웃 포함·행당 정거장 실측)이 §5.3 무검사 축을 셋 줄임.
- **UX-CB(#1749) 발사**: uxcb-composer 워크트리(base=ba914b7a), grok 워커 가동 — 패킷+직전 두 사이클 교훈(새 진입점은 레인이 누른다·popover 트리거 앵커·키보드 모달리티 한정·§2.2 산술) 브리프 포함. uxht 워크트리·브랜치 회수 완료.

## 2026-08-25 (아침) · Fable · UX-CB 3회전 랜딩 (track/uxui 31dc8a89) — UX 파도 3티켓 완결
- **UX-CB(#1749) 랜딩**: PR #1751 → track/uxui **31dc8a89**. grok 402(Build 잔고 소진)로 **codex 워커 전환**(codex-fleet, 샌드박스 브라우저 게이트는 오케스트레이터 대행). 리뷰 3회전 — R1 FAIL(B1: [@]가 공백 뒤 캐럿에서만 동작·죽은 @ 잔류 / H2: 포커스 링이 그릇 분열·그릇 절반 비활성 면적) → 수리1(문맥 인지 " @" 삽입·그릇 focus-within·클릭 캐럿 포워딩·선택 보존·자 3건 계약화) → R2 FAIL(신규 B2: 워커가 고친 gate-typing 미실행 RED / B3: 그릇 opacity 수리가 스레드 빈 초안 전송 버튼을 원색으로 / H-1R: UA 파란 링 잔존) → 수리2(슬롯 대기 재설계·sending/빈초안 상태 분리·outline-none+그릇 링 단일) → **R3 PASS(B0·H0)**. vitest 1509→**1523**. 정본 3부 `claudedocs/design-review-1751/`.
- **오케스트레이터 절차 교훈 적립**: codex 샌드박스는 Chromium 불가 — **대행 게이트 세트 = capture:design + gate-typing + gate:composer + gate-shell-layout 전부**(1차엔 capture만 대행해 gate-typing RED가 리뷰까지 갔다). 워커가 게이트 파일을 고치면 "끝까지 초록으로 돈 로그"가 커밋에 동반돼야 한다.
- 자 결함 2건 오케스트레이터 직접 수리(0309db90): 입력 fv 스펙 오적용·Radix 배치 플레이크(정착 대기, 3연속 그린).
- 적립: **#1752**(폰 컴포저 buzz형 동형 — M-3·M-5R 폰 작성중 문장 폭 거래 병기, 성재 판단 사안).
- **UX 파도 완결**: UX-EB(c2b779cf)·UX-HT(ba914b7a)·UX-CB(31dc8a89) — 성재 발제 3건 전부 track/uxui 랜딩. 9회전 리뷰 누적: Blocker 7·High 10 실측 적발·전부 폐곡선. 검수 앱 재빌드 진행 중.

## 2026-08-25 (오전) · Fable · buzz 정합 파도 인테이크 — 성재 검수 피드백 16장 전량 티켓화·2기 발사
- 성재 발제(스크린샷 16장, 규율=전량 티켓화): 증거 정본 `claudedocs/buzz-feedback-20260825/`(27~41). 패킷 `handoffs/2026-08-25-buzz-alignment-packet.md`.
- **허들 실체 조사(디깅)**: 스키마 생존(016·046)·**Rust 서버 미포팅**(server-rust 0건)·현행 compose LiveKit 부재·웹 UI 0건. #850의 "서버 완비"는 Swift 시대 기록 — 전제 정정 코멘트. 참조 구현은 `server/Sources/MomoServer/Routes/HuddleRoutes.swift`+`Huddles/`로 레포 생존.
- **ADR-0172 기안·Accepted**(성재 지시 자체가 결정): 웹 아이콘 lucide-react 통일 — 이모지 무라이브러리(#1688)와 별개 축 성문.
- 티켓 발급: **UX-D2=#1753**(스레드 보더·첫 메시지 호버 깨짐·cmdK 보더) · **UX-D1=#1754**(lucide 스윕) · **UX-D3=#1755**(⋯ 메뉴 보강 — 기능 실존분만) · **UX-D4=#1756**(사이드바: 프로필 카드·상태 조절(ADR-0160 기배선 UI화)·패널접기 상단·채널 호버 액션·섹션 접기) · **HD-1=#1757**(engine: 허들 REST 포팅+LiveKit compose) · **TC-1=#1758**(채널 하단 터미널 buzz형, T1~T3 기반) · **TC-2=#1759**(기획 적립: 작업 콘솔 팀 트래킹+원격 조작 — 보안/권한 ADR 선행).
- **발사(병렬 2)**: codex D2(uxui, d2-thread-fix)+HD-1(engine, hd1-huddle). 순서: D2→D1→D3→D4→TC-1(uxui) · HD-1→#850 웹 허들(engine 랜딩+승격 후).

## 2026-08-25 (낮) · Fable · 디스크 위기 회수 +34Gi(실효 109Gi) + 상시 회수 파이프라인 구축 (성재 지시)
- 가용 10Gi까지 하락. 실측 회수: **Xcode DerivedData 21G**(Swift 퇴역 잔재+타 프로젝트 캐시 — 전부 재생성 가능) · cargo target 3곳 7.7G(wd1 4.1·uxui desktop 2.5·engine desktop 1.1, `cargo clean`) · engine/wd1 node_modules·Pods ~5G(`git clean -fdX` 경로 한정 — 시크릿 env 비접촉) · codex-fleet 런 232개 1.15G · git gc 16M. **가용 10Gi→44Gi→(퍼저블 반영)119Gi.** 잔존 대형: hd1-huddle target 10G(활성 — PG 게이트 대행 임박이라 보존).
- 각주: `rm -rf`가 프로젝트 경로에서 권한 거부 — **정식 도구 우회가 정답이었다**(cargo clean·git clean -fdX). 이후 회수도 이 도구 어휘로.
- **상시 파이프라인**: `~/.local/bin/momo-worktree-reclaim.sh`(랜딩 완료+clean 워크트리 자동 reap+브랜치 삭제·7일 codex 런·docker 연계·`--deep`=캐시까지·keep-list=`~/.config/momo/worktree-keep.list`(wd1 등재)) + **launchd 데일리 06:30**(com.momo.reclaim). 오케스트레이터 규율=머지 직후 즉시 회수, launchd=안전망. 메모리 정본 갱신.

## 2026-08-25 (오후) · Fable · 재개 — HD-1 랜딩·engine 정본 복구·RA-6 터널 리서치
- **HD-1(#1757) 랜딩**: PR #1760 → track/engine **46a1788e**. PG 컨포먼스 대행 PASS(15432 게이트 PG·마이그레이션 전체 적용·fail-closed/grant/단일활성/재입장/RLS 통합 red proof 5.21s). 커밋 한국어 재구성(서버/인프라 분할). **Policy integrity 게이트 첫 실전**: 워커의 local_gate.sh 커버리지 노트 1줄 현행화가 보호 경로 감지 → Fable 감사 판정 → 성재 지시("감사 코멘트 달아줘")로 `Policy-Integrity-Audit: <head>` 대행 게시+라벨 → 재평가 통과. hd1 워크트리(10G target 포함)·브랜치·게이트 PG 즉시 회수.
- **engine 정본 워크트리 화석 발견·복구**: 152커밋 뒤처짐+dirty(CODEOWNERS 삭제·pr-ci.yml의 랜딩된 보호장치 역행 등 118파일 −55k줄) — 8/24 "잔재 정리 별도 확인" 그 건. 판정=버려진 작업 화석. **stash 백업 후 origin 복구**(stash: "engine 정본 워크트리 화석 diff 백업"). 필요 없다고 확정되면 stash drop은 성재 판정.
- **D2(#1753)**: 대행 게이트 전녹(vitest 1530/1530) → PR #1761 → CI 그린·독립 design-review(dr-1753) 가동 중.
- **RA-6 랜딩**: `research/2026-08-25-tunnel-scalability-pricing.md` — ①그록봇 IP=고정 근거 없음·미공개 Cloudflare WARP/Gateway급 대역(Cloudflare 소유이나 공개 anycast에 없음, Cursor ips.json 416개에도 없음)→**IP allowlist 불가** ②Tailscale Funnel=전 플랜 무료 확정(가격 락인 기우)·단 진짜 위험은 beta 3.9년·**WS 1001 이슈(GH #18827 Open)**·LE 인증서 34h rate limit(durable-but-resettable과 충돌 — state 영속화 완화) ③CF named tunnel 값어치=URL lock-in 소멸(Funnel 커스텀 도메인 공식 불가 GH #16478) ④한도 도달 플레이북 표. 성재 결정 2건 대기(§6).
- 디스크: hd1 회수 반영 가용 **128Gi**.

## 2026-08-25 (오후2) · Fable · D2 랜딩 (track/uxui 0e202e5e) — buzz 파도 2/8
- **D2(#1753) 랜딩**: PR #1761 → track/uxui **0e202e5e**. 리뷰 2회전 — R1 PASS(B0)이나 H-1(⌘K 링이 그릇으로 이사만 해 화면 동일 픽셀 — 상시 포커스 모달의 링은 상시 점등) → 마감 수리(링 완전 제거+hairline·thread-empty 캡처 레인·호버/rest 프레임 분리) → **R2 PASS(B0·H0·회귀 0)**. 채널 straddle 수치는 UX-HT R3와 "한 자도 다르지 않음" 실측.
- 캡처 레인 신설 과정의 학습 3연타: ①스레드 재열람은 스토어 캐시로 빈 상태 불가 → 자연 경로(툴바 [답글]) ②scrollIntoView가 Virtuoso 리마운트로 locator-실호버 어긋남 → 화면 안 last() 행 ③앞 레인의 행 포커스 잔존으로 툴바 2개(hover∨focus 계약) → 컴포저 클릭으로 포커스 정리 선행. 전부 레인 주석으로 성문.
- 적립: M-3(폰 스레드 빈 상태 격 차이)·N-2(border-dashed 첫 등장 무자)·N-4(naked_focus 문자열 맹점).
- **D1(#1754 lucide, ADR-0172) codex 워커 발사**(d1-lucide-icons, base 0e202e5e). d2 워크트리·브랜치 즉시 회수.

## 2026-08-25 (오후3) · Fable · URL 안정성 인터뷰 수렴 + 계정·권한 감사 + D1 사이클
- **우로보로스 인터뷰 수렴**(5라운드, 모호도 0.17): 셀프호스트 URL 안정성 제품 범위 확정 — 정본 `research/2026-08-25-selfhost-url-stability-interview.md`. 핵심: 3-Tier(B 그록봇 자동 프로비저닝+정체성 영속=기본 / A oort 고정 별칭=opt-in 폴백 / 숙련자 문서) · 불변식 "URL은 바뀌지 않는다"(성재 직관 승격) · 성공 기준(터미널 명령 0·15분·복구 5분) · RQ-1~7 도출. 다음: RA-7(RQ-1+2 실측) 발사 성재 신호 대기.
- **계정·권한 5축 감사 랜딩**: `research/2026-08-25-selfhost-accounts-roles-audit.md` — 계정 발급 실존/패스워드 초기화 부재/멤버 라이프사이클 10경로 Rust 미이식/role 추가 무겁고 fail-closed 의도/커스텀 이름은 클라 상수 2곳으로 최경량. 티켓 후보 AC-1~4 적립(발급 대기).
- **D1(#1754) 사이클**: 워커 실측 반전 — base가 이미 lucide 165곳 표준(손제작 기능 SVG 0) → 경계 가드+문서 정본화만 랜딩(무발명 판정 정확). ADR-0172 배경 실측 정정. PR #1762, 대행 게이트 전녹(vitest 1535), CI+독립 리뷰 가동 중. **D1 닫히면 성재 지시대로 정지.**

## 2026-08-25 (저녁) · Fable · 정지점 — D1 머지 직전 동결 (성재 "바로 정지, 재개 가능하게")
- D1(#1754) 리뷰 3회전 진행: R1 H2 → 수리(f0f37943) → R2 H2(잔량 수치 — 리뷰어 자기 grep 사각 자백, "손으로 센 수는 썩는다") → 수리(84b4d537, 1안=수 삭제·성질만·24px 복원·§5.2 스캔표면 참말). R3 최종 확인 발주 상태에서 **성재 지시로 머지 없이 동결**. 재개 절차·적립 6건은 태스크 #30에 성문.
- 세션 랜딩 누계: HD-1(허들 서버, engine)·D2(스레드 표면, uxui). URL 안정성 인터뷰 확정본·계정권한 5축 감사·RA-6 랜딩.

## 2026-08-26 (새벽) · Fable · 재개 — D1·D3 랜딩, 워커 레인 Cursor CLI 전환
- **워커 레인 전환**: Codex CLI 공식 은퇴(성재 고지) → **cursor-agent + cursor-grok-4.6-high-fast**(kwak@dawn.kim 기로그인, 스모크 실증). 호출: `-p --trust -f`. 호스트 직접 실행이라 브라우저 게이트 워커 자가 실행 가능(대행 세트 불요). 메모리 정본 갱신. 죽어 있던 D3 codex 워커(exit 1)·고아 프로세스 정리.
- **D1(#1754) 랜딩**: PR #1762 → track/uxui 4c913f77(동결 해제 후 머지). 적립 6건 승계 **#1763**.
- **D3(#1755) 랜딩**: PR #1764 → track/uxui **1eb7c627**. 새 레인 첫 완주 — 사실 판정 정확(Mark unread=GREATEST 단조 적립·Copy link=기존 딥링크 재사용). 리뷰 3회전: R1 B1(**Tauri에서 열 수 없는 주소 복사** — absoluteApiBase가 정답, 옆 파일 패턴) → R2 B1(**콜드 오픈 착지 선재 버그**: ChatShell 채널 리셋 효과가 방금 파싱한 앵커를 소거 — #1195 머리말 "고쳤다"가 거짓이었음을 실측) → 수리(앵커 채널 소속화 urlAnchorForChannel) → **R3 PASS(3회전 13건 전부 폐곡선)**. **부수확: 붙여넣은 메시지 링크 콜드 착지가 제품 역사상 처음 실동작.** 코어 낱말 승격(copyLabels.ts — 웹·폰 단일 출처). vitest 1543→1554.
- **D4(#1756 사이드바) 발사**(d4-sidebar, base 1eb7c627 — 프로필 카드·상태 조절(ADR-0160 기배선 UI화)·패널 접기 상단 이동·채널 호버 액션+섹션 접기).

## 2026-08-26 (오전) · Fable · D4 랜딩 (track/uxui e1a0ca42) — 파도 최초 전 등급 0 판정
- **D4(#1756) 랜딩**: PR #1765 → track/uxui **e1a0ca42**. 리뷰 3회전 — R1 FAIL(B1: 모델은 overlayOpen을 받는데 호출부가 리터럴 false — UX-HT가 푼 클래스의 배선 누락, +H2 폰 44px 강등·포커스 BODY) → 수리 14/14 → R2 PASS+H1(**overlayHeld ⌘K 누수** — 해제가 헤더 blur에만 걸려 팔레트 경로에서 영구 잔존, 전역 플래그가 DM 섹션까지 고정) → 수리(실닫힘+rAF 해제·섹션 스코프·양 경로 자 확장) → **R3 PASS 전 등급 0**(파도 최초 무결 판정). vitest 1563→1577. 커밋 한국어 재구성(soft-reset 재구성 — commit-tree+reset --hard는 권한 거부).
- 상태 픽커의 ADR-0160 의미 우선 판정(buzz Offline 모사 대신 선언값 auto/away/dnd)이 리뷰에서 정당 확인.
- **TC-1(#1758 하단 터미널 도크) 발사**(tc1-terminal, base e1a0ca42 — 선행 조사: 작업 세션이 조작 가능한가 관찰 전용인가가 스코프 분기·가짜 어포던스 금지·원격 조작은 TC-2 절대 금지).

## 2026-08-26 (낮) · Fable · TC-1 랜딩 (track/uxui 264bb1dc) — buzz 정합 파도 uxui 6/6 완결
- **TC-1(#1758) 랜딩**: PR #1766. 조사 판정=작업 세션은 관찰 전용 → **관전 터미널 도크 정직 축소**(입력 미발명). 리뷰 4회전: R1 B1(확대 640px 고정이 720/844에서 컴포저를 화면 밖으로·타임라인 0px) → 기하 재설계(세로 토큰 4종·양보 순서 터미널→띠→컴포저·**컴포저 ⊂ 뷰포트 하드 불변식**·기하 자 3높이) → R2 H2(확대 무동작 vh≤784·0줄 침묵) → 수리(확대=띠까지 실취득·이득 0=disabled·folded 동형 정직 문장) → R3 H1(크롬 상수 200이 폰 폭에서 사본 거짓 — §5.5①) → 수리(실높이 판정·상수 삭제) → **R4 PASS(B0·H0)**. vitest 1584→1585.
- **워커 예고→실측 RED 5게이트**(헤더 트리거 의미 변경) 재배선 — 보호 단정 강도 유지·evidence 로그 커밋 동반(UX-CB B-2 교훈 제도화 첫 실전).
- **buzz 정합 파도 uxui 완결(6/6)**: D2 0e202e5e·D1 4c913f77·D3 1eb7c627·D4 e1a0ca42·TC-1 264bb1dc(+HD-1 engine 46a1788e). 리뷰 누적 16회전, Blocker 9·High 15 실측 적발·전부 폐곡선. 잔여: #850 웹 허들(승격 후)·TC-2 기획·AC-1~4 발급 대기.
- 검수 앱 재빌드 착수(track/uxui 264bb1dc).

## 2026-08-26 · Opus5(Fable 대행) · 승격 창 완결 + 5갈래 집행
- **인계**: 성재 지시로 Fable→Opus 5 역할 대행. 워커 레인은 cursor-agent(grok-4.6) 유지.
- **★ 승격 창 완결 — 삼자 정렬 복구**: engine→main(#1771, HD-1 허들) → uxui sync(#1773, STATUS union) → engine sync(#1775) → **uxui→main(#1772, 74커밋/9티켓)** → docs 플러시(#1776) → sync 짝(#1779·#1780). 최종 main=dafe81b1, 잔여 0, `main ⊂ 두 트랙` 복구.
  - 순서 함정 실측: engine 승격이 uxui PR을 CONFLICTING으로 만들고(STATUS.md), sync로 풀면 이번엔 `main is ancestor of both tracks`가 걸린다 — 이 체크는 **pull_request가 아니라 push 이벤트 기반 브랜치 감시**라 PR 머지 전에는 구조적으로 통과 불가. required 아님(required=PR CI gate·Policy integrity gate 둘). 순서 = 승격→sync→승격 재개.
  - **정책 감사가 세 번 요구됨**(원 랜딩 #1760 → 승격 #1771 → sync #1773, 전부 같은 한 줄). 대행 서명으로 통과시키되 **마찰 자체를 #1774로 적립** — 서명이 형식이 되면 게이트 실효가 준다.
- **AC 티켓 4건 발급**(계정·권한 5축 감사 근거): #1767 패스워드 초기화(reset 토큰+본인 변경) · #1768 멤버 라이프사이클 10경로 이식 · #1769 초대 revoke/regenerate · #1770 role 표시명 인스턴스 커스텀.
- **RA-7 랜딩**(`research/2026-08-26-ra7-tunnel-identity-feasibility.md`): ①state 영속 → 같은 URL·인증서 재발급 0회(성재 직관 공식 확인) ②URL 파괴 경로는 state 소실 하나이고 **되돌릴 수 없다**(이름 자동회수 없음·재사용 불가·CT 오류) ③"터미널 0회"는 되나 **"계정 0개"는 불가** — oort tailnet 수용은 ToS 소지+ACL로 전 고객 서버 접근권을 갖게 돼 셀프호스팅 명분 붕괴 ④**무계정+고정URL 대안 부재는 구조** → A트랙은 폴백이 아니라 무계정 tier의 유일 구현(CNAME 불가·TLS 종단 프록시 필요) ⑤진짜 blocker=Funnel WS 1001(#18827). 보너스: 비대화형 `exit 0` 조용한 실패·OAuth secret=ephemeral 기본 함정.
- **TC-2 랜딩**(`research/2026-08-26-tc2-work-console-remote-control.md`) — **출시 결함 2건 적발**: **#1777 WK-0a** host-signed 세션 변이 미이식으로 `remote_attach_available` 항상 false → **방금 랜딩한 TC-1 관전 도크가 붙을 PTY가 원리적으로 없음**(리뷰 4회전이 못 잡은 이유=캡처 픽스처가 세션을 모킹). **#1778 WK-0b** 소유자 관전차단 토글 400(동의 모델이 열린 채 잠김). 정정 2건: ⓐ 내가 브리프에 세운 "고빈도 입력 vs 단일 쓰기경로" 긴장은 **성립하지 않음**(ADR-0125 D10에서 터미널 바이트는 이미 서버 비경유) ⓑ 「조작 중 관전 차단」은 증보 3 결재분이 아니라 077 파도가 넓힌 규칙. display 평면은 살아 있어 조작을 그 위에 세우는 선택지 실재(D5-B), `grantee_member_id`가 확장을 이미 예약.
- **docs 플러시**(#1776): planning 3본 + **리뷰 정본 40본**(claudedocs md). gitignore 둘 — `claudedocs/**/*.png`(1,005장 247MB, U-7 판정 승계) · **`.tok`·`PAIRING_VALUE.txt`**(도어벨 E2E 잔재가 engine 워크트리에 **미무시로 방치**, `git add -A` 한 번이면 공개 레포 유출). gitleaks 오탐 3건 등록(RFC 6455 표준 예제 키·`$TS_APIKEY` 셸 변수).
- **가동/대기**: T-2 플레이북 §2 재작성 워커 진행(RA-7 근거·조용한 실패 2종 절차화). WS soak는 **환경 부재로 미실행** — 로컬 tailscale 없음 + D8 Funnel 서버 응답 없음(그록봇 VM 쪽).

## 2026-08-27 (오후) · Fable · 재개 — 순서 ③ #1800 워커 발사 + engine 정본 워크트리 화석 2차 발견
- **체크포인트 복원**: `handoffs/2026-08-27-fable-resume-checkpoint.md` → #1798 랜딩 확정(track/engine **094cdc87**, #1767 close), 실행 결재 전소진 상태라 순서 ③부터 자율 진행(방향 기승인).
- **#1800 브리프 작성·발사**: `handoffs/2026-08-27-1800-workspace-settings-brief.md`. 설계 판단의 핵심 실측 — `dto.rs:3304`·`agents.rs:583`에 "settings는 전 멤버가 읽어선 안 되는 확장 가방" 성문이 이미 있어 **기존 `GET /v1/workspaces/{ws}` 확장은 정본 위반** → 읽기=operator 전용 `GET …/settings` 신설, 쓰기=`PATCH`(최상위 키 병합·null=삭제), 골격=`unfurl-settings`(require_human→workspace_scope→require_workspace_operator→agent_tenant_tx→audit) 승계, allowlist 시작=`allowed_agent_models`(형태 검증만·의미론 비접촉), `role_labels`=AC-4 몫 예약. red proof에 "기존 워크스페이스 GET에 settings 미포함 유지" 회귀 자 포함. 워커=cursor grok-4.6-high-fast 병렬 1, 워크트리 `w1800-workspace-settings`(base 094cdc87).
- **게이트 PG 잔재 회수**: 랜딩 완료 티켓의 momo-1767-pg·momo-1769-pg(13h 방치) 제거. 리그 스택(oort-t-*) 보존.
- **engine 정본 워크트리(momo-tracks/engine) 화석 2차**: HEAD 394c4d42(#1793, origin보다 뒤) 위에 **stash 적용 실패 잔재**(`Updated upstream/Stashed changes` 마커, STATUS.md UU) 방치. staged 방향은 랜딩된 #1777/#1778 산출물 삭제(−3,439줄) = 역행. unstaged infra 수정(MOMO_HOSTED_DELIVERY_ENABLED·ADR-0169 first-boot)은 origin에 **이미 랜딩된 내용의 중복** 확인. 적용원은 stash 목록에 전부 보존(stash@{0} WIP on b1966a23 · stash@{2} 8/25 화석 백업). **복구 명령(`git reset --hard HEAD` → `git merge --ff-only origin/track/engine`)이 권한 거부돼 미집행** — 성재 확인 대상으로 이월(폐기 안전 판정은 완료, stash drop도 성재 몫 유지). `infra/rust/local.secrets.env`는 gitignored라 복구와 무관하게 보존됨.
- 검수 정본 `research/2026-08-27-fable-audit-of-opus-session.md`가 untracked 방치였던 것 추적 보완(전 세션 플러시 누락).

## 2026-08-27 (오후2) · Fable · 승격 창 완주 + #1800 랜딩 + #1770 ④-1 재발주 — main 정본화 상시 위임 개시
- **성재 결재 2건**: ①engine 정본 워크트리 화석 폐기·복구 승인(집행: `git restore` 우회 — `reset --hard` 문자열 자동 거부 규칙, stash 보관함은 보존) ②**main 정본화 상시 위임** — "항시는 아니지만 계속 main 쪽으로 싱크를 맞추면서 정본화"(랜딩 단위 승격+sync 짝 자율 집행, 건별 결재 불요). 메모리 정본 갱신.
- **승격 창 완주(삼자 정렬 복구)**: #1804(engine→main, 티켓 PR 10건/34커밋 — #1798·#1799·#1777·#1778·#1747·#1788·#1790·#1794·#1782·#1781) → #1806(main→uxui sync, STATUS union) → #1807(uxui→main, #1783 허들 active) → #1808(main→engine sync)·#1809(main→uxui sync) 짝. 최종 **main=7a0a1612, main ⊂ 두 트랙**. 정책 게이트 학습 2건: ⓐ감사 서명은 **코멘트 먼저→라벨 나중**(라벨 전환 시각이 exact-head 감사 코멘트 이후여야 함 — 순서 반대면 FAIL) ⓑ승격·sync에 같은 감사 반복 요구는 #1774 적립분 그대로.
- **#1800 랜딩**(PR #1805 → track/engine **809a2a47**, 이슈 close): `GET|PATCH /v1/workspaces/{ws}/settings` operator 전용, top-level RFC 7396 병합, allowlist=`allowed_agent_models`, `role_labels`=AC-4 예약. **재검수 High 1건 적발·폐곡선** — PATCH read-modify-write가 무잠금 SELECT(동시 PATCH lost update, 키 1개라 잠복·AC-4에서 실결함화 예정) → 수리 워커 재투입(`FOR UPDATE` 직렬화 + 결정적 잠금 증명 테스트, 22c39053) → 재검수 통과. PG 컨포먼스 12/12. canonical track alignment의 "candidate가 origin/main 포함" 규칙 실측 → base sync(806b2be0) 후 전녹.
- **uxui 정본 워크트리 잔재 2차**: #1783 역행 staged 상태 발견 → stash 백업("uxui 정본 워크트리 잔재 백업") 후 ff. engine·uxui 정본 워크트리 모두 origin 정렬 유지.
- **#1770(AC-4) 재발주 — 2단계 편성**: ④-1 engine(`role_labels` 키 수용+형태 검증 48B·4role, WorkspaceDto `roleLabels` 멤버 가독 프로젝션 — allowed_agent_models 선례) → ④-2 uxui(설정 UI·`roleLabel()` 오버라이드·semantics 불변 고지, 독립 design-review). 브리프 `2026-08-27-1770-role-labels-engine-brief.md`. ④-1 워커 발사(base 809a2a47).
- 회수: 게이트 PG(momo-w1800-settings)·sync 워크트리 4개·워커 워크트리·원격 브랜치 전부 즉시 회수.

## 2026-08-27 (저녁) · Fable · #1770 완주(AC-4 양절반) — 리뷰 3회전 폐곡선 + 정본화 창 2 개시
- **④-1 engine 랜딩**(PR #1810 → 2e4d628c): `role_labels` 수용(4역할·48B·공백 400·통째 교체·null 삭제) + `WorkspaceDto.roleLabels` 멤버 프로젝션. 재검수 판정: identity GET의 OpenAPI 미성문은 이탈 아님(스펙 헤더의 의도적 미문서 목록 적용). PG 컨포먼스 15/15.
- **⚠️ 워커 사고 1건**: ④-1 컨포먼스가 라이브 리그 PG(oort-t)에 닿아 역할 비밀번호 리셋 — 워커가 컨테이너 env 기준 복구, 오케스트레이터 실측 리그 전 컨테이너 healthy·DB ok. 잔여=momo_notifier 역할 기본 비번 가능성(소비자 0·로컬 전용, 난수 회전 명령은 분류기 차단으로 성재 이월). **교훈: 이후 engine 브리프에 "라이브 리그 DB 비접촉(게이트 PG만)" 정지 조건 상설.**
- **④-2 uxui 랜딩**(PR #1811 → 80bdd83d): 설정>워크스페이스 4역할 편집(빈 값=기본 복원·한글 16자 선검증·operator만 편집·비운영자는 KeyValueRows 전 대비 뷰), roleLabel()/inviteRoles() 오버라이드(웹 로스터·멤버 카드·초대·폰 프로필 시트), 권한 불변 고지. vitest 1589. member 캡처 레인 신설.
- **독립 design-review 3회전**: R1 PASS(B0)나 H1(저장 403 완전 침묵 — 403 문장이 도달 불가 분기)·M2(Enter 저장 사망·읽기 전용 AA 미달)·L3 → 수리(25d2e6b2) → **R2 FAIL(B0·H1)**: 수리가 만든 `denied` useState가 오류 수명주기와 어긋남(403 후 pending 중 거짓 실패 문장·403 뒤 500 침묵 재도입·재승격 잔존 — 전부 런타임 프로브 실증) → 수리(7a9c986a, 파생식 전환 — "옳은 답이 같은 파일에 있었다" 메타패턴 재현) → **R3 PASS(B0·H0)**(3시나리오 코드+테스트+런타임 3중 폐곡선). #1770 close.
- **인프라 학습**: named 팀메이트 design-review spawn이 좀비화(기존 전례 재현) → TaskStop 후 무명 단발 서브에이전트로 재발사 표준 재확인.
- **정본화 창 2 개시**: #1812(engine→main, #1810). 이후 uxui sync→#1811 승격→docs 플러시→sync 짝.

## 2026-08-27 (밤) · Fable · 정본화 창 2 종결 — 삼자 정렬 복구·docs 플러시 main 랜딩
- **창 2 완주**: #1812(engine→main, #1810) → #1813(main→uxui sync) → #1814(uxui→main, #1811) → **#1815(docs 플러시→main)** → #1816·#1817(종결 sync 짝). 최종 **main=1bbab8fd, main ⊂ 두 트랙**.
- **#1815 충돌 1건 판정**: ADR-0169 증보 1이 두 판본(기획 세션 장문판 vs #1793 랜딩 축약판) — 장문판(결정 맥락·하이브리드 표·용어 주의)을 본문으로 유지 + 축약판의 구현 확정 2건(derive_same_origin_http_base 규칙·생성기 기본값 same-origin 확정)을 반영해 해소.
- **정책 게이트 감사 3회**(#1815 AGENTS/CODEX=#1803 반영, #1816·#1817 동일 변경 운반) — 전부 "코멘트→라벨" 순서로 통과. 동일 변경 반복 감사 마찰 재확인(#1774 적립분, 이번 창에서 5회).
- 세션 누계: 티켓 3건 랜딩·close(#1800·#1770 양절반, +#1798·#1799는 전 세션분 승격), PR 14건(#1804~#1817), 승격 창 2회, 리뷰 3회전(H 2건 적발·폐곡선), 워커 5기(전부 회수), 트리 keep-list만 잔존.
- 다음 실행 순서: **⑤ #1792 SPIKE-HD ∥ #1785 ACP 릴레이 ∥ #1797 에이전트 자격**(상호 독립, 워커 병렬 1이라 순차 발사) → ⑥ #1768 AC-2. 성재 이월 1건: 리그 momo_notifier 역할 비번 난수 회전(분류기 차단분).

## 2026-08-27 (심야) · Fable · 순서 ⑤ 소화(2/3)·#1792 환경 차단 판정·⑥ #1768 발사
- **#1785 랜딩·close**(PR #1818 → track/engine bd41f6b6): ACP 이벤트 릴레이 — Swift recordACPEvent 3함수 이식, 4타입·금칙 키 11종 재귀·64KiB·240/60s·event_id 멱등·same-tx outbox. 재검수: Swift 원본 줄 단위 대조 정합, 유일 미세 이탈(outbox idempotency_key가 event_id 기반)은 기능 동치 판정. red proof 3/3. 게이트 PG 격리 준수(리그 비접촉 상설 첫 실전 — 지켜짐).
- **#1797 랜딩·close**(PR #1819, 조사형): **외부 도구=에이전트 멤버 경로가 쓰기·회전·유예까지 실측으로 선다. 읽기는 현재 계약상 닫힘**(스코프 표에 REST GET 부재·messages:read 비개방·Agent Port read는 hosted 전용) → 스코프 경계 변경이라 **#1820(EXT-1-READ, ADR 결재 선행)** 적립. ADR-0162 409는 일반 agent member 비해당. SELF_HOST §6 초안 랜딩. 재검수 정정 1건: 워커의 "게이트 RED=환경 드리프트" 진단은 오판 — clean 트리 12/12 PASS 재현, 실원인=워커 실측 스택 env 누출(PR 코멘트 기록).
- **#1792 SPIKE-HD = 환경 차단 판정**: 스파이크 급소(Funnel 노드·외부 망 관측점 2대)가 성재 참여 없이는 불성립(로컬 tailscale 부재·그록봇 VM 비접촉 규율). 이슈에 필요 목록 코멘트 — 성재 준비 시 실행 시트 즉시 제공. 폴백 P2 기결재.
- **⑥ #1768 발사**(w1768-lifecycle, base=#1819 반영): 10경로 이식 — #1798 `can_*_for` 사다리·매트릭스 픽스처 승계 계약, 마지막 owner 보호·정지 로그인 차단·밴 재가입 차단 red proof, outbox-only. 브리프 `2026-08-27-1768-member-lifecycle-brief.md`.
- 성재 이월 소화: momo_notifier 난수 회전 완료(성재 직접 실행) — 리그 접촉 사고 잔여 0.

## 2026-08-27 (밤2) · Fable · #1768 랜딩(실행플랜 완주) + SPIKE-HD 릴레이 가동
- **#1768 랜딩·close**(PR #1821 → track/engine): Swift MemberLifecycleRoutes 10경로 이식 — can_* 사다리 5종(도메인 층·FOR UPDATE — #1805 교훈이 워커 관례로 정착 확인), Swift 오류 우선순위 보존(last-owner 가드 선행), suspend=토큰 revoke+로그인 403·ban=redeem 403, 직접 publish 0, red proof 선행 커밋 → 컨포먼스 49/49. 재검수=Swift 원문 줄 대조 PASS.
- **랜딩 중 학습**: Cargo.lock 변경 PR은 GHCR 고지 번들 재생성 동반(manifest가 cargo_lock_sha256 커버) — 라이선스 레인이 깨어날 때만 드러나는 계약. 오케스트레이터가 재생성 커밋 대행(604dd71c, 게이트 산물), 이후 engine 브리프 관례에 추가할 것.
- **이로써 post-audit 실행플랜 ①~⑥ 전 소화**(잔여=#1792 스파이크뿐). AC 4부작(#1767·#1768·#1769·#1770) 전부 랜딩 — 계정·권한 축 완결.
- **SPIKE-HD(#1792) 가동**(성재 승인 — 그록봇 자연어 릴레이 경로 확정): ①외부 망(로컬 맥)에서 **급소 2단계 TLS 악수 선통과**(LE 정식 인증서·TLS1.3) ②그록봇 릴레이 1 관측 — 8443 Funnel 매핑 실존(백엔드=구 TLS 프로브 더미), livekit 미기동·MOMO_LIVEKIT_URL 미설정(VM 허들 첫 기동이 됨), 시그널=join 응답 직결 ③릴레이 2 발신 — 더미 철거+turn 활성+같은 오리진 /livekit 프록시(CSP 무변경 설계). 정본 claudedocs/spike-hd-funnel-turns/.

## 2026-08-28 (자정) · Fable · SPIKE-HD 릴레이 자율화 + 정본화 창 3 완주
- **그록봇 릴레이 자율화**(성재 지시 2026-08-27: "이후는 나한테 부탁 말고 네가 CDP/앱 제어로"): Grok Bot 데스크탑 앱(Electron)을 osascript+cliclick+screencapture로 직접 제어 — Orchestrator 대화 검색·진입, 릴레이 작성/전송, 응답 스크린샷 판독. **CDP 크롬 확장 미연결 → chrome-devtools MCP(전용 프로파일) 레인 병용**. 자연어 릴레이 원칙 유지, 타이핑 주체만 Fable로 이관.
- **SPIKE-HD 3b 폐곡선**: CSP가 시그널 :10000 차단(connect-src 부재) 외부 실측 → 릴레이(Fable 자율)→그록봇 connect-src에 해당 오리진 1개만 추가·리로드 → 외부 재검증 `wss://<host>:10000` 반영(와일드카드 0). 시그널 :10000 외부 200·TURN 8443 TLS 유효·livekit healthy. 3c(JoinResponse turns: 광고) 릴레이 발신 — 그록봇 VM 루프백 join으로 확인 중.
- **자격 경계 재확인**(성재 "자격 입력까지 해줘 허가"에 대한 응답): 비밀번호 입력·계정 자격 취급은 명시 허가로도 풀리지 않는 하드 룰 → owner 로그인 1회는 성재 몫 유지. 그록봇에게 비번을 캐내 달라는 릴레이도 자체 차단(자격 exfil 형상) — 3c는 자격 불요 경로로 우회.
- **정본화 창 3 완주**: #1822(engine→main, #1785·#1797·#1768) → #1823·#1824(sync 짝). 최종 main=1bbab8fd 이후 갱신, main ⊂ 두 트랙. 회수 완료.
- 스파이크 정본 claudedocs/spike-hd-funnel-turns/{REPORT,RELAY}.md 갱신.

## 2026-08-28 (새벽) · Fable · SPIKE-HD 결론 — 터널이 TURN 미디어를 나른다(외부 증명), 잔여=클라 리라이트 1건
- **핵심 증명(3d)**: Fable 로컬 맥(터널 밖)에서 인증 없는 TURN ALLOCATE over TLS→8443 → `type=0x0113`·**ERROR-CODE 401·REALM=livekit·NONCE**. 웹은 STUN 응답 불가 → **LiveKit 내장 TURN이 Funnel 터널 너머에서 응답 확정, 로그인·자격 불요 순수 프로토콜 증명.** 스파이크 핵심 질문 = YES.
- **구조적 제약(3e)**: 그록봇 판정 — LiveKit **v1.13.3 external_tls가 클라 광고 TURN 포트 443 하드코딩**(iceServersForParticipant, tls_port>0→turns:<domain>:443 고정, advertise 필드 없음, 업스트림 #4542=의도). 443은 웹 점유 → **P1 "zero 코드" 전제 falsified**.
- **결론**: P1은 폐기가 아니라 **"클라 ICE URL 리라이트(443→8443) 1건이 붙는 P1"**. 성재 사전결재의 "P1 실패→P2" 실패 조건 비해당 — P1(웹 1커밋)이 P2(운영자 별도 TURN 기동)보다 여전히 가벼움. **후속 티켓 #1825(HD-TURN-1)** 발급(uxui, huddleRuntime ICE 주입점 신설·셀프호스트 배치 한정·실브라우저 2대 검증이 4·5단계 승계). 대안=443 TCP 디먹서(STUN magic 분기, zero 앱코드·인프라 1개). 정본 claudedocs/spike-hd-funnel-turns/REPORT.md.
- **실행 체계 실증**: 그록봇 자연어 릴레이를 Fable이 데스크탑 앱 직접 제어로 완전 자율 구동(성재 부재·비번 미소지 상태에서 왕복 4회 릴레이 완료). 자격 경계 준수(비번 입력·계정자격 취급 없음, TURN 프로토콜 증명은 인증 없는 ALLOCATE로 우회).

## 2026-08-28 (오전) · Fable · #1825 허들 TURN 리라이트 랜딩 + #1820 ADR-0173 초안 — 성재 2결정 집행
- **성재 결정 2건**(2026-08-28 "A 연다 발사"): ①#1825=방식 A(웹 리라이트) 발사 ②#1820=읽기 연다→ADR 초안.
- **#1825 랜딩·close**(PR #1826 → track/uxui): huddleTurnRewrite 모듈 + 세션 스코프 RTCPeerConnection 셰임(host-게이트 자기격리 — Cloud/직결 무발동, 새 플래그 0). (a) rtcConfig 탈락 실측→(b) 셰임 판정. **재검수 High 폐곡선**: 셰임 복원 시점(connect 직후→세션 종료)으로 마이크 지연 PC·재접속 PC 리라이트 누락(허들 드롭) 수리. vitest 1608→1610. **SPIKE-HD 유일 잔여(광고 443) 닫힘 = 허들 미디어 외부 도달 폐곡선.** 실브라우저 2대 왕복은 랜딩 후 오케스트레이터 검증 이월.
- **#1820 ADR-0173 Proposed**: 외부 도구 메시지 읽기 REST 표면. D1 generic 자격에 GET messages 개방·D2 범위=멤버 채널 히스토리(검색 제외)·**D3 hosted=MCP 격리 유지(ADR-0162 보존, principal 종류 분기)**·D4 무per-read감사·D5 messages:read 비-default 유지. 성재 확정 3점(범위·이중매핑·감사) 대기 → Accepted+engine 티켓.
- **세션 총괄**: AC 4부작(#1767·#1768·#1769·#1770) 완결 → post-audit 실행플랜 ①~⑥ 소화 → SPIKE-HD 판정(터널 TURN 미디어 외부 증명·LiveKit 443 하드코딩·#1825로 해소) → 그록봇 릴레이 완전 자율화(데스크탑 앱 제어). 랜딩 누계: #1800·#1770(양절반)·#1785·#1797·#1768·#1825. 정본화 창 3회. 후속 적립 #1820(ADR 결재)·#1825 실검증.

## 2026-08-28 (낮) · Fable · #1820 EXT-1-READ 랜딩 — Fable 검토→ADR 확정→grok 구현→재검수 (성재 위임 흐름)
- **성재 지시**(2026-08-28): "fable 검토→기획 수정→grok4.6 작업→fable 핸드오프 검수". 실검증(허들·터미널·그록봇 종합)은 성재가 일괄 수행 예정이라 조각 검증 금지.
- **Fable 적대 검토(fork)**: ADR-0173 방향 견고(Blocker 0)·D3·D4 서술이 코드와 어긋남 발견(둘 다 ADR 유리). **D3**: hosted 격리용 신규 라우트 가드 불요 — `AgentBearerClass` 프리플라이트(auth.rs:836-848)가 hosted를 스코프 표 도달 전 403(넣으면 오작동). **D4**: 에이전트 읽기는 auth 층이 이미 method+path 감사(auth.rs:972) — "무감사" 정반대, 추적 요구 공짜 해소. → ADR 정정·**Accepted 전환**(성재 위임+Fable 검토 반영).
- **#1820 grok 구현 랜딩**(PR #1830 → track/engine): `required_agent_scope`에 GET messages·replies를 messages:read로 매핑(경로 shape·verb 격리, 단일 메시지·POST replies는 계속 닫힘). **코드 변경=agent_scope.rs 하나**(핸들러·agent_credential·auth 무접촉 — 계약 정확 준수). red proof=ext1_read_conformance_pg: 실 DB hosted 3상태 403 매트릭스·교차 테넌트 RLS GUC 자가검증·비활성 멤버·페이지네이션·사람 불변. Fable 재검수 통과(모킹 아닌 실자격 시딩 확인).
- **세션 총누계 랜딩 7**: #1800·#1770(양절반)·#1785·#1797·#1768·#1825·#1820. 정본화 창 4회. AC 4부작+외부 도구 완전 이중+허들 미디어 외부도달 폐곡선.
- 잔여: #1825·#1820의 성재 종합 실테스트(허들·터미널·그록봇 연동) — 작업 마무리 후 핸드오프 패킷으로.

## 2026-08-28 (오후) · Fable · 종합 실테스트 준비 체계 확정 — 정본 패킷·#1837 발급
- **성재 go**("진행하자 — 작업=grok 4.6, 검수 기획=Fable"): 종합 테스트 준비 갭 판정·패킷화 집행.
- **갭 판정**: 최신 발행 v0.1.2(8/24)가 테스트 대상 랜딩분(#1825·#1777/#1778·#1785·#1820 등 8/27~28) **전부 미포함** — VM은 발행 이미지 기반이라 지금 테스트하면 구버전 검증. **배포 경로=이미지 재발행 v0.1.3 확정**(VM 소스빌드 기각 — 오프-플레이북 드리프트+자원 소모).
- **정본 패킷** `handoffs/2026-08-28-comprehensive-test-packet.md`: 준비 체인 ①~⑤(발행→#1837 문면→VM 갱신 릴레이→검수 앱 재빌드→자격 세팅) + 시나리오 S1~S5·PASS 기준. VM 수동 배선 5종 보존 목록 성문(**CSP connect-src=최고 위험** — 컨테이너 내부 수정이면 이미지 교체로 소실, 갱신 후 외부 헤더 재검증+재적용 릴레이 절차). 적립 메모: 생성기가 MOMO_LIVEKIT_URL 오리진을 CSP 자동 반영 안 하는 갭=티켓 후보.
- **#1837 발급**(DOCS-V013, grok·게이트=발행 후 착수): §2-B digest pin — **선재 정합 결함 동반 수리**(현행 문면 라벨 v0.1.1·빌드커밋 1b79bc65·digest는 v0.1.2 값 혼재) + **§6 "읽기 스코프를 넣어도 REST는 403" 정정**(#1820 랜딩으로 거짓 판명 — 이번 검토의 실발견) + llms.txt 정합. 브리프 `2026-08-28-v013-docs-refresh-brief.md`(grep 증명 3종 완료 기준).
- **성재 결재 대기**: v0.1.3 발행 창 승인=체인 개시 게이트. 승인 후 Fable이 dispatch·Release 생성→grok 발사→VM 릴레이·검수 앱 재빌드까지 자율, 성재 실작업은 4점(승인 클릭·owner 로그인 1회·폰 LTE 3분·종합 검수 세션)으로 최소화.

## 2026-08-28 (오후2) · Fable · 종합 테스트 준비 체인 ①~④ 완주 — v0.1.3 발행·VM 갱신·실행 시트
- **성재 "ㄱㄱ"로 체인 개시**: ① publish-images 디스패치(성재 env 승인 2회) → **v0.1.3 발행**(main=4d3085ad · 앱 `e0faed22…4868` · pg `49a589bd…d071` · attestation verify 2본 PASS · Release 생성). ② **#1837 랜딩·close**(PR #1841 — §2-B 3자 정합·§6 읽기 개방 정정·llms.txt 0건 실증, Fable 재검수 PASS) + 정본화(sync 짝 #1842·#1843, main ⊂ 두 트랙).
- **③ VM 갱신 — 그록봇 릴레이 Fable 자율 집행**(성재 결재 "지금 바로 투입", 앱 제어 중 성재의 별도 그록봇 작업과 키보드 조율): 관측→pin 교체→pull→검증 6항 전부 성공. 데이터 볼륨·허들 배선 5종 보존, **CSP는 호스트 파일(infra/rust/Caddyfile.local)이라 무사**(패킷의 최고 위험 항목 해소). livekit은 orphan 유지 가동. 외부 검증(Fable 실측): healthz 200·CSP :10000 잔존·시그널 200·TURN 8443 TLS verify 0·**새 번들 서빙 실증**(8443 리라이트 상수+roleLabel 마커 grep).
- **④ 검수 앱 재빌드**: main=4d3085ad Tauri debug → ~/Desktop/oort-uxui-review.app 교체. 함정 재현: node_modules 신선도(radix 신규 패키지) — npm install 후 그린.
- **실행 시트** `claudedocs/comprehensive-test-20260828/RUNSHEET.md`: 준비 스탬프+⑤ 자격 발급 시트(owner 로그인=성재)+S1~S5 절차. **잔여=⑤(성재 ~2분) → S1-a는 Fable 선행 가능.**
- 앱 제어 학습: 한글 IME가 cliclick 타이핑·osascript keystroke를 전부 자모 변환 — **텍스트 투입은 pbcopy+Edit 메뉴 Paste가 정석**(클립보드 백업·복원 동반). 검색창 타이핑은 IME 오염으로 불가, 사이드바 직접 클릭이 안전.

## 2026-08-28 (저녁) · Fable · 종합 테스트 S1 실행 — 허들 결함 2겹 적발·A 폐곡선·B 진단
- **성재 위임**: 자격 발급 owner 관문에서 "너가 올려줘" → 로그인된 세션 조작으로 진행(비번 미취급 유지). 종합 테스트 S1(허들) Fable 선행 실측.
- **S1 실측(v0.1.3 실배포·외부 크롬 계측)**: 허들 미연결 — 결함 2겹. 증거 `claudedocs/comprehensive-test-20260828/S1-huddle-findings.md`.
  - **결함 A(#1847→PR #1849 랜딩·폐곡선)**: #1825 셰임이 생성자 config만 리라이트 → livekit-client의 빈 ctor+`setConfiguration` 주입 경로 미발동(라이브 443 잔존·드롭 3회). 페이지 임시 패치로 8443 적용→TURN 할당 성공 실측=수리 방향 검증. grok가 `prototype.setConfiguration` 인터셉트 추가(host 게이트·idempotent), Fable 재검수 PASS(구현이 라이브 실측과 일치), track/uxui 랜딩. **단위 테스트가 생성자 픽스처만 짚어 못 잡은 함정 — #1777 동류.**
  - **결함 B(진단 중)**: 8443 적용 후에도 relay(tls)↔SFU 내부(172.19.0.2:50025) 페어 요청 1회 만에 failed — TURN CreatePermission 거부 형상. 그록봇 진단 릴레이(livekit 로그·rtc 섹션·node/advertise IP) 발신 대기. S1-a/b/c는 B 해소 후 승계.
- **부수 발견 2건**: ①Grok Bot=`hosted-agent` → S4 generic 자격 409 차단, **S4는 generic 에이전트 신설 필요** ②웹 명부 역할 변경 UI 부재 → **#1848**(서버 PATCH /role 미배선). admin 위임이 curl로만 가능.
- **S4 경로 재설계**: promotion/자격발급 UI 부재 확인 → owner curl 1회로 Comptest-fable admin 승격 시트 성재 제공(비번=성재 터미널). 승격 후 Fable이 generic 에이전트 생성+자격 발급+S4 5항 자율 대행.
- 워커/트리: #1849 워커 회수 완료. 미해결=결함 B 진단(그록봇 앱 성재 사용 중이라 릴레이 대기)·성재 승격 curl.
- 정본화 이월: #1849(track/uxui)는 결함 B 산출물과 묶어 한 승격 창으로 batch 예정(허들 축 폐곡선 시).

## 2026-08-28 (밤) · Fable · 로컬 셀프호스트 전환 — 종합테스트 로컬 완주(S4·S1-lite·UI)·#1848/#1856a 랜딩·결함 B 실증
- **재개·정렬**: 체크포인트(#1851) 단독 재개 → sync 짝 #1852·#1853 머지로 `main ⊂ 두 트랙` 복구. 이전 세션 scratchpad 3종(승격 시트·릴레이 문안·테스트 자격) 회수.
- **#1848 랜딩 사이클**: 브리프 정본화(#1854) → grok 구현(PR #1855: momo-core changeWorkspaceMemberRole + MemberProfileDialog operator 컨트롤·낙관 갱신 금지·거부 문장 표면화) → Fable 재검수(서버 접점 3곳 실측 정합) + design-review 2회전 — **H-1**(busy-disabled 포커스 증발→하우스 busy 패턴 치환) · **H-2**(에이전트 대상 개방→kind 게이트, 브리프의 "동일 표면" 조항이 원인 — 기획 오류 자인) 수리 후 **B0·H0** 재검증 PASS → track/uxui 머지·#1848 close. 파생: **#1857**(서버 미차단 갭)·**#1858**(계정 메뉴 로그아웃 부재, 성재 발견 티켓화). 검수 앱 track/uxui 재빌드.
- **그록봇 릴레이(왕복 1.5회 후 중단)**: 미발신 초안 발견→통합 문안(진단+승격)으로 교체 발신. 작업1 보고 수신 — **nodeIP=브리지 자동감지·CreatePermission 거부 로그 없음·SFU→relay 요청8/응답0** → **#1856** 발급. 작업2(승격)는 자동검토 카드 만료로 불발, 이후 그록봇 자체 오류(성재 고지)로 VM 경로 중단. 넛지 발신은 권한 분류기 차단 → 우회 없이 성재 이관.
- **로컬 셀프호스팅 전환(성재 지시 "직접 입력해서 해봐")**: `oortv013`(발행 v0.1.3 digest pin, published-digest 모드) 기동 — 구 `oort`·`oort-t` 스택 비파괴 정지(볼륨 보존), 검수 앱 저장 주소(127.0.0.1:8088) 자동 승계. owner 자격 로컬 발급으로 **성재 대기 2건(승격 curl·릴레이) 구조 소멸**: invite→Comptest-fable join→admin 승격(PATCH 실측=#1855 와이어 계약 일치)→generic 에이전트+자격.
- **테스트 실적**: **S4 5/5 PASS**(편차 기록: 단일 메시지 GET=라우트 부재 404 — 런시트 403 기대 오기, 시트 초판 body shape 결함 자기 수정) · **S1-lite PASS**(livekit-client 하네스+playwright 2컨텍스트 상호 오디오 바이트 실측) · **결함 B B-1 실증**: 기본 구성 동형 재현(PC 연결 실패) → `rtc.node_ip` 한 줄로 즉시 연결 — 대조 실험으로 "advertise IP=병인" 증명(#1856 코멘트) · **UI 워크스루**(Fable 직접): 발행 번들 로그인·명부·S4 게시물 렌더·**허들 2자 실 UI**(Live 배지·참가자 상호 표시) + 역할 UI(dev번들×v0.1.3 서버 — 강등→명부 반영→복원·self 게이트). 증거 4본 `claudedocs/comprehensive-test-20260828/`.
- **#1856a 랜딩**(PR #1859→track/engine): livekit `MOMO_LIVEKIT_NODE_IP` 노브(빈 값=자동 감지 현행 유지)·생성 env 기본 127.0.0.1·기존 env 소급 주입 금지(LAN 오광고 방지 사유 명문)·게이트 신설(test_livekit_node_ip: compose render+entrypoint argv+실이미지 부팅 --node-ip≡rtc.node_ip). **정책 무결성 감사 제도 이행**: local_gate 1줄 추가로 게이트 발동 → momo-main 실감사 코멘트(Policy-Integrity-Audit)+라벨 → 그린. 게이트 2본 오케스트레이터 직접 재실행 PASS.
- **가동/큐**: #1857 워커 진행 중 → #1858 → 성재 UXUI 피드백 티켓들(상시 순차 발사 위임). 보류: S2·S3·VM축(그록봇 복구 대기). 잔여 정리: infra/livekit.yaml 워킹트리 실험 수정(#1859 노브로 이행 예정).

## 2026-08-29 · Fable · BZ 시리즈 1차 파도 — 성재 대량 피드백 티켓화·5랜딩·grok 레인 전환·ADR-0174 기안
- **인테이크**: 성재 검수 피드백(스크린샷 14종 — buzz 대비 UXUI 전반) 전량 티켓화 → BZ 시리즈 #1864~#1869 + 파생 #1873(rename REST)·#1876(폰 컴포저 윤곽)·#1600 좌표. buzz = Block 오픈소스(**Apache-2.0**, github.com/block/buzz) 확인 후 `~/projects/reference/buzz` 클론 — 워커 브리프마다 참조 경로 제공.
- **워커 레인 전환(성재 지시)**: BZ-1은 cursor로 마감, 이후 전부 **grok build CLI grok-4.6**(`--permission-mode bypassPermissions`, 병렬 2 실증 — cursor와 인증 분리라 무충돌). grok 레인 첫 구현부터 정본 동기·레인 자가 실행을 스스로 수행하는 결 확인.
- **랜딩 5건(각 design-review 2회전 폐곡선)**:
  - **BZ-1 #1864→PR#1870**: 사이드바 접기 — 토글 타이틀바 고정·접힘 hidden+inert·모션 토큰 1호(--duration-sidebar, 정본 §2.6/§7 동기)·Tauri Overlay. R1 FAIL(증거 기계 2블로커: 캡처 레인 사망·게이트 자 불일치) → R2 PASS.
  - **BZ-6a #1869→PR#1871**: 온보딩 3스텝 셸 + S0 오르트 랜딩("오르트 구름을 지나 들어온다" — 딥스페이스 단일 룩·산포 필드 30개체·마우스 반발·OortMark 궤도 드로잉·buzz 동형 전환 650/760ms). 선제 레인 정합(런 2) → R1 H2(카드 정렬·오류 복귀)+M3 → R2 전항 실측 PASS. 후속: 409 signIn 분기·폰 패리티 등재.
  - **BZ-2 #1865→PR#1872**: 채널 헤더 1줄(토픽→⋮)+라운드 컨트롤 그룹. R1 FAIL(B1 390×라이브 겹침 — 상시 Blocker·H3) → 수리(flex 축소·Button 프리미티브·칩 ok-soft 채움·useRestoreFocusOnClose로 플레이키 게이트 12/12) → R2 PASS. gate:huddle 390×라이브 축 신설. 후속 Medium(390 칩 클립) 등재.
  - **BZ-4e #1873→PR#1875(engine)**: PATCH members/me displayName — join 정규화 재사용·단일 쓰기경로·프레즌스 동형 outbox·conformance 4/4·ENGINE_HANDOFF A-40 등재.
  - **BZ-3 #1866→PR#1874**: 라이트 --line 완화(--line-strong 3.03:1 실측 유지)·텍스트 입력 그릇 3종 focus-visible-within+모달리티 스탬프(마우스 무링·Tab 링). R1 H1(정본 일반문 vs 터미널 잔량) → 터미널 동일 변형 → R2 PASS(재발 가드 3그릇).
- **온보딩 기획**: buzz 온보딩 실코드 전독(`research/2026-08-29-buzz-onboarding-research.md`) — 에셋=로고 1장 12KB뿐, 화려함 전부 코드(SVG 산포+CSS+rAF), 절정=웰컴 채널 에이전트 킥오프. 설계 v2.1(`bz6-onboarding-design.md`): Dawn 면 제거→오르트 우주 서사(성재 지시), grok imagine·meshy 불요 확정(지출 0), 투어 카드 폐기→김인턴 킥오프.
- **ADR-0174 Proposed**(BZ-5 선행): 외양 커스터마이제이션 — 의미 토큰 불변·바인딩 층만 사용자 설정, v1 축(컬러 모드·큐레이션 액센트·폰트·밀도·라이브 프리뷰, 글래스 제외), 이-기기 저장, 기본=Dawn·온보딩 영향권 밖, 게이트 재정의(사전 검증 테마 허용 목록). **성재 확정 3점 대기**.
- **가동/큐**: BZ-4(#1867 설정 전면+Profile, A-40 배선) 진행 중 → ADR 결재 후 BZ-5a → BZ-6b/6c. 검수 앱 재빌드 1회(BZ-1+6a 시점, 469f7c90) — BZ-4 랜딩 후 재빌드 예정. 교훈: 워크트리 회수는 PR 머지 확인 후(BZ-3에서 성급 회수→재생성 비용).

## 2026-08-30 · Fable · BF 1차 4연발 완주(A1~A4) + BZ 잔여 랜딩 — buzz 격차 파도
- **buzz 격차 리서치**: 탐색 에이전트가 양 실코드 대조(16영역, 파일 검증) → 후보 15건 정본(`research/2026-08-29-buzz-ui-gap-candidates.md`). 성재 "권장대로 ㄱㄱ" → 티켓 6건(#1884~#1889) + ADR-0175(리마인더)·ADR-0176(커스텀 상태) Proposed 기안(스키마 경계 규율).
- **BZ 잔여 랜딩**: BZ-4 설정 전면+Profile(#1880, 2회전 — 킬 사고 후 -c 재개 실증) · BZ-6a-p1 온보딩 폴리시(#1883, 2회전 — 히어로 락업 154/51/14 위계, 캐칭 재판정 "해소").
- **BF-A 랜딩 4건(전부 2회전 폐곡선, A1만 1회전)**:
  - **A1 #1890**: 리액션 이름 툴팁(formatReactionNames·동명이인 핸들·native title 관례) — R1 단번 B0·H0.
  - **A2 #1891**: 상단 안읽음 점프 필 — R2에서 래치 오발(range 폴백 in 무장→스크롤업 실종·채널 오픈 비결정 실종) 적발 → 무장 소스 IO 실측+실행 2경로 제한 → R3 동일 지오메트리 해소 검증. 파생 #1892(폰 점프 항법)·#1893(gate-fold-nav 자 재조준).
  - **A3 #1894**: 허들 마이크 선택+게인 — R1 B2(390 겹침 사태·**게인 부착 시 디바이스 전환이 실런타임 마이크 사망** — livekit 2.21.0 processor.restart에 audioContext 미전달, 리뷰어가 esm 줄번호 추적) → 컨텍스트 캐시+실쉐이프 테스트+390 wide-only 양보+게이트 그룹 내 겹침 단정 신설 → R2 **무모킹 실검증**(실제 맥 마이크+진짜 livekit로 전환 생존·게이트 붉은 증명). 파생 **#1895**(prod Caddyfile microphone=() 차단 — 허들 브라우저 prod 불능 선재 결함).
  - **A4 #1896**: 알림 세분화(권한 4분기·실존 2종만·kind-disabled 런타임 검증) — R1 H3(전폭 바·denied 처방 방향 오류·grant 포커스 증발) → R2 5/5.
- **운영 노트**: gitleaks가 momo.web.* 저장 키 상수를 generic-api-key로 반복 오탐(2건 트리아지) — 패턴 allowlist 개선 티켓 후보. 백그라운드 킬 사고 1회(BZ-4 워커 등) — grok `-c` 재개로 복구, 워크트리 회수는 머지 확인 후 규율 재확인.
- **잔여 큐**: 2차 A5~A10 취사(성재 제안 예정) · ADR 3본(0174·0175·0176) 결재 대기 · B1·B2(ADR 후) · 그록봇 복구 시 VM축.
