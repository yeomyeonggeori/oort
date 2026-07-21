# ADR-0125: Work Host Fabric — 세션이 앱 수명을 넘는다 (self-host workd + momo Cloud)

- Status: **Accepted** (2026-07-19, 성재 — D1~D8 권고안 전체 승인. 파생 487~490은 0114 v0 배치(483~486) 랜딩 후 순차 발급)
- 관련: ADR-0114(Accepted — D8 host_id 훅이 본 ADR의 접합점), ADR-0121(Accepted — D1-C momo Cloud 범위 제외분을 본 ADR이 인수, D5-A "운영을 판다" BM 승계), ADR-0004·MOMO-234(자격증명 비유입 — 전 계층 불변), ADR-0120(PushRelay — 호스트 등록·outbound 다이얼 패턴의 원형), research/17-work-host-fabric/00(레퍼런스 실사·비용 모델·성재 보정 2건)
- 발단: 성재 숙원 — "0114 v0 한계(세션=맥 앱 수명)를 뚫는다. 셀프호스팅 또는 유료 cloud, SSH 베이스, 로컬 있으면 물어보고 로컬."

## Context

1. **업계 수렴(17-00 실사)**: Cursor가 2026년 ①cloud VM ②내 머신 ③고객망 self-host 3계층으로 갔고, Codex Cloud가 관리형 샌드박스 계약(2-phase·시크릿 수명 분리·웜 캐시)을, Firecracker 생태계(E2B·Morph·Blaxel)가 "스냅샷+0컴퓨트 스탠바이+ms 재개" 경제를 정립했다. momo의 차별점은 이 3계층을 **채널 원장·승인·스레드 위에** 얹는다는 것뿐이며, 그거면 충분하다.
2. **0114이 이미 깔아둔 것**: 세션=스레드, control=원장 경유(work.spawn/input/read/kill), spawn=승인 대상, host_id 필수 필드. 본 ADR은 host_id가 가리키는 실체를 정의한다.
3. **경제 전제(17-00 §4)**: 총비용 지배항은 모델 구독(사용자 부담, BYOA)이고 인프라는 인당 $8~30/월. 자격증명만 사용자 전용이면 VM/스토리지는 워크스페이스 공유가 안전하다.

## Options

### D1. 호스트 레지스트리 — host_id의 실체
- **A (권고)** — `work_host`(id, workspace_id, **scope=member|workspace**, owner_member_id, type=**app|workd|cloud**, display_name, pubkey(Ed25519), capabilities jsonb, last_seen_at, revoked_at). 등록·서명은 PushRelay 디바이스 등록 패턴 재사용. 호스트는 **outbound-only로 다이얼**(workd/앱 → 서버; NAT·방화벽 무개방)하고 자기 앞 `work.control.*`만 구독. scope=workspace 호스트(팀 VPS·momo Cloud)는 멤버 누구의 세션이든 수용하되 L-cred(D4)는 세션 소유자 것만 마운트.

### D2. T2 — self-host workd
- **A (권고)** — 단일 바이너리 데몬(launchd/systemd). 설치 경로 둘: ①`momo host add ssh://user@vps` — 앱이 SSH로 부트스트랩(복사·서비스 등록·서버에 등록) ②ADR-0121 install.sh의 `--with-workd` 옵션. 도구 로그인은 1회, **momo 터미널 브리지로 원격 수행**(스레드 카드에 URL → 폰 인증 → 코드 회신; Codex의 localhost 리다이렉트는 workd가 로컬 포워딩 대행). 무료(0121 D5-A).
- B — SSH 실행기만(데몬 없이 앱이 매번 SSH): 세션이 다시 앱 수명에 묶임 — 숙원의 답이 아님. **기각.**

### D3. T3 기질 — momo Cloud를 무엇 위에 짓나
- **A (확정, v1) — E2B 샌드박스 재판매 위에서 시작** (2026-07-20 파일럿 완료로 기질=**E2B** 확정): 프로비저너·풀·과금을 먼저 검증. 원가가 자동으로 사용량 비례. **파일럿 근거(research/17-01)**: E1 지연(create p95 0.36s·재개 0.72s), E4 L-base 공유(분기 0.77s·빌드캐시 재사용 87%), E2-A 경제(6왕복 순활성 14초·2일 외삽 ~$1.8·스탠바이 0컴퓨트), E5 GitHub 사이클(clone→commit→push 실증), pty API(create/connect/send_stdin/resize — D10 원격 attach의 기반) 전부 E2B에서 실증. 유휴 스탠바이·pty attach·워크스페이스 공유가 우리 설계와 정합하는 유일 후보로 확인.
- B (v2 예약) — 자체 Firecracker 플릿: p95 동시성 bin-packing 마진(17-00 §4.1)이 커지는 규모에서 전환. A의 프로비저너 인터페이스를 기질-불가지로 설계해 전환 비용 최소화(D3-A 프로비저너를 provider-불가지 인터페이스로 짓는다).

### D4. 샌드박스 합성 (17-00 §4 성문화)
- **A (권고)** — 3계층: **L-base**(워크스페이스 공유 — 이미지+repo+의존성 웜 스냅샷, read-only CoW; setup 단계에만 네트워크·워크스페이스 시크릿, 잔류 금지) / **L-cred**(사용자 전용 자격증명 볼륨 — OAuth 풀링 금지 경계는 이 층 하나로 완결) / **L-session**(세션당 microVM 인스턴스 + CoW 오버레이 — 살아있는 VM의 동시 다중 사용자 공유 금지, 재사용은 스냅샷-신선 기동). 유휴 N분 → 스냅샷 → 0컴퓨트 스탠바이 → 스레드 입력 시 재개.

### D5. 세션 풀·쿼터 (17-00 §4.1 성문화)
- **A (권고)** — `work_pool`(workspace_id, max_active, included_active_hours, per_member_soft_limit) 서버 원장 + spawn=slot acquire / 종료·유휴스냅샷=release(감사 가능 이벤트). 소진 시 스레드 "대기 중" 카드 + 해제 시 자동 시작, cap 상향은 관리자·과금 이벤트. 선점은 유휴-스냅샷 LRU만.

### D6. 스폰 라우팅 — "로컬 있으면 물어보고 로컬"
- **A (권고)** — 승인 카드에 호스트 선택기(내 맥 온라인 / 팀 VPS / momo Cloud), 기본값=로컬 온라인 우선→마지막 사용. 프로파일별 기본 호스트 + auto-approve(0114 D5) 조합으로 무마찰 자동화. 전부 감사 원장.

### D7. 과금 경계
- **A (권고)** — **워크스페이스 단위**: 동시 슬롯 N + 월 활성시간 H 풀(+초과 종량). 모델 사용료는 전 계층에서 사용자 구독(BYOA — 샌드박스 안 디바이스 로그인, momo는 토큰 재판매·중개 없음). T1/T2 무료, T3만 유료 — 0121 "운영을 판다" 그대로.

### D8. 보안 기본값 (Cursor 사고 계열 반면교사)
- **A (권고)** — 샌드박스 비특권 유저(sudo 금지) · 시크릿은 setup 단계 한정 · 계정 풀링 금지(L-cred 구조로 강제) · spawn/개입 승인 원장(0114 D5 승계) · 호스트 등록 revoke 즉시 control 소비 차단 · agent 단계 기본 네트워크 제한(허용은 워크스페이스 설정·감사).

## Decision (Proposed 권고안)

D1-A(레지스트리·outbound-only) · D2-A(workd+SSH 부트스트랩+로그인 브리지) · D3-A(재판매 시작, 기질-불가지 프로비저너) · D4-A(3계층 합성) · D5-A(풀 원장) · D6-A(호스트 선택기·로컬 우선) · D7-A(워크스페이스 과금·BYOA) · D8-A(보안 기본값) — **2026-07-19 성재 승인, Accepted.**

## D10. 원격 인터랙티브 터미널 attach — T3 세션은 실제 TUI를 스트리밍한다 (2026-07-20 성재 지적 — T3 급소)

- **문제**: T1(로컬 맥)은 SwiftTerm이 로컬 PTY를 직접 spawn하지만, T3(클라우드 샌드박스)에서 claude/codex를 앱에서 보려면 헤드리스가 아니라 **실제 TUI(alternate screen·전체 인터랙션)를 하나의 터미널에서 양방향으로** 봐야 한다. E3에서 겪은 "TTY 스크랩 불가"가 정확히 이 문제. 헤드리스 명령 실행으로는 TUI 도구를 못 쓴다.
- **A (권고) — 원격 PTY attach(직결 스트림, 서버 raw 비경유)**: 
  1. 호스트(클라우드 샌드박스, workd/프로비저너)가 도구를 **원격 PTY**로 실행(E2B pty create — create/connect(pid)/send_stdin/resize/kill 검증됨 2026-07-20). 
  2. momo 서버는 **attach capability**(bearer·ephemeral, A-6 첨부 capability URL과 동일 패턴)만 발급하고, **클라이언트(SwiftTerm)가 샌드박스 PTY 스트림에 직접 연결**한다 — 원격 PTY 바이트는 momo 서버/relay를 경유하지 않는다(D3·ADR-0004 유지: 서버는 raw 무경유·전송전용). 
  3. SwiftTerm이 원격 PTY의 stdout을 렌더하고 키입력을 send_stdin으로 전달, resize 동기화. 로컬 T1과 동일한 뷰, 백엔드만 원격 attach.
  4. work_session 원장(483)은 그대로(수명주기·라벨만), 에이전트 조종(484 work.control)도 그대로 — attach는 "사람이 그 세션 터미널을 직접 본다"의 전송 계층 추가.
- **부수 효과 — E3 자동 해소**: 실제 인터랙티브 터미널이 붙으면 구독 로그인은 "터미널에 URL 뜨고 코드 붙여넣기"가 사용자 손에서 자연히 일어난다(D9의 스크랩 캡처 불필요 — 헤드리스일 때만 D9 카드가 대신). 즉 D10이 서면 D9는 "비-attach(모바일 관전 전용) 폴백"으로 축소된다.
- **경계·주의**: capability는 만료·세션 소유자 바인딩·revoke 즉시 무효(work_host revoke 연동). 클라이언트↔샌드박스 직결이 불가한 망(엄격 방화벽)에서는 서버 중계 폴백이 필요할 수 있으나 그 경우에도 **E2E 암호화로 서버가 평문 raw를 못 보게**(후속 결정). iOS는 v1에서 터미널 attach 대신 세션 스레드 관전(506)이 기본, 실 터미널 attach는 후속.
- B — 서버 중계 스트림(momo relay가 PTY 바이트 프록시): D3(전송전용·raw 비경유) 위반. **기각**(직결 불가 폴백에서만, 암호화 전제).

## D9. 구독 자격증명 연결 UX (2026-07-20 성재 지시 — E3 파일럿 실증 반영)

- **A (권고) — 세션 스레드 인라인 "연결 카드"**: T2/T3에서 사용자가 처음 claude/codex를 쓰려 하면 세션 카드 스레드(0114 D2)에 provider별 연결 카드가 인라인으로 뜬다. 흐름: ①"연결하기" → 호스트/샌드박스가 `setup-token`(또는 `login`)을 **momo 세션 매니저가 소유한 PTY**로 실행 ②매니저가 OAuth URL을 카드에 렌더(E3에서 script+FIFO로 검증한 그 URL) ③사용자가 URL 탭→폰에서 구독 인증→코드 복사 ④카드의 코드 입력 필드에 붙여넣기→매니저가 PTY stdin으로 주입→**토큰을 결정론적으로 캡처**해 호스트 로컬(T2)/샌드박스 볼륨(T3)에 영속 ⑤카드가 "connected · @user"로 전환.
- **경계**: 토큰·URL은 momo 서버/UI/로그/원장에 절대 미유입 — 사용자가 보는 것은 연결 상태(connected/expired/disconnected)뿐(ADR-0004 + 0114 D3). provider별 연결 상태는 프로필/설정에 배지로(Discord 연동 목록 문법), 만료 시 경고색·재연결 CTA.
- **E3 교훈**: TUI 스크랩(script+FIFO)은 라이브 인증엔 되나 토큰 영속이 불안정 — momo 세션 매니저가 PTY를 1급으로 소유해 토큰 캡처를 결정론화하는 것이 이 UX의 핵심 구현 요건. `setup-token`(헤드리스 CLAUDE_CODE_OAUTH_TOKEN) vs `login`(세션 크레덴셜) 선택은 구현 시 실측 확정.

## D11. 티어 폴백 정책 — 호스트 상실 시 전환 제안·재개 (2026-07-21 성재 발제, **Accepted** — "우선순위 작업 진행" 지시로 우선순위 4 실행 승인)

- **문제**: D6(호스트 선택기)는 spawn "시점"의 선택만 다룬다. 세션 도중 호스트가 사라지면(맥 닫힘 = work_host heartbeat 단절) 세션은 끊긴 채 방치 — "T1에서 작업하다 맥이 닫히면 T3로 전환해 재개할지 질문" 흐름이 없다.
- **A (권고) — 정책 설정 + 상실 감지 + 승인 카드 재개**:
  1. **티어 정책**(워크스페이스 기본 + 멤버 오버라이드): `t1-only`(전환 제안 안 함) / `ask`(기본 — 상실 시 전환 제안 노티) / `auto`(사전 승인된 대상 티어로 자동 재개, auto-approve 화이트리스트 문법 재사용).
  2. **상실 감지**: 기존 work_host heartbeat 원장 재사용 — offline 판정 유예(기본 90s, 절전/이동 오탐 방지) 후 running 세션을 `orphaned`로 전이(원장 이벤트).
  3. **전환 제안 = 승인 카드 재사용**: 세션 스레드에 "호스트 연결 끊김 — T3에서 재개할까요?" 카드(0114 D5 승인 문법·비용 표시 포함) + `momo.work` 푸시(503 랜딩분). 수락 시 재개, 무시 시 세션 ended(orphaned) 정리.
  4. **재개 의미론(v0) — git 계보 재개**: PTY/프로세스 상태 이전은 하지 않는다. 대상 호스트가 repo를 clone/fetch해 **마지막 push된 커밋에서 새 세션**을 열고, 에이전트 프롬프트에 이전 세션 스레드 요약을 주입한다(E5 파일럿의 clone→commit→push 사이클 재사용). 원장에 `resumed_from_session_id` 계보 — 스레드는 이어지고 실행만 새 것. **미커밋 작업 손실은 명시 고지**(worker 커밋 규율이 완화 장치). 라이브 상태 마이그레이션(스냅샷 이전)은 v1 검토(E2B pause/resume은 T3内 전환에만 유효).
- B — 상실 즉시 자동 T3 재개 기본: 비용 발생을 질문 없이 일으킴 — 과금 신뢰 위반. **기각(auto는 opt-in).**
- C — 세션 상태 완전 이전(프로세스 마이그레이션): 티어 간 기질이 달라(로컬 맥→microVM) 일반해가 없음. **기각(v0).**
- 파생(Accepted 시): **MOMO-519**(엔진 — 정책 원장+orphaned 전이+재개 카드 REST+계보) · **MOMO-520**(UXUI — 정책 설정 UI+재개 카드+계보 스레드 표시).

## 파생 (Accepted 후 발급 예약 — 0114 파생 483~486 랜딩 후 순차)

- **MOMO-487** (엔진): `work_host` 레지스트리 migration+REST 등록/revoke+Ed25519 검증+control 라우팅(host_id 필터) + verifier
- **MOMO-488** (엔진): momo-workd v0 — 단일 바이너리·outbound 다이얼·PTY 세션 매니저(앱 세션 매니저와 프로토콜 공유)·launchd/systemd 유닛 + `momo host add` SSH 부트스트랩
- **MOMO-489** (엔진): `work_pool` 원장 + slot acquire/release + 대기열 이벤트 + verifier
- **MOMO-490** (UXUI): 호스트 선택기(승인 카드)·호스트 관리 설정·대기열 카드·원격 로그인 브리지 UX
- **MOMO-511** (엔진+UXUI): 원격 인터랙티브 터미널 attach — 호스트 원격 PTY(E2B pty) + 서버 attach capability 발급 + SwiftTerm 원격 attach(stdout 렌더·키입력 send_stdin·resize) + revoke 연동. 서버 raw 비경유. macOS Work 서랍 먼저, iOS는 후속. E3/E4 파일럿이 기질 레퍼런스.
- **MOMO-510** (엔진+UXUI): 구독 연결 카드 — 세션 매니저 PTY OAuth 캡처(호스트/샌드박스) + provider 연결 상태 배지(프로필/설정) + 세션 스레드 인라인 연결 카드(iOS 506·macOS Work 서랍). E3 파일럿 스크립트가 메커니즘 레퍼런스.
- momo Cloud 프로비저너(기질 선정·과금 연동)는 위 4장 랜딩 후 별도 배치(S 배치 install.sh 자동화 승격과 합류)

## Consequences

- (+) 세션이 앱·기기 수명에서 해방 — 폰(iOS 스레드)에서 팀 VPS의 codex 세션을 관전·개입 가능. 숙원의 구조적 해소.
- (+) 전 계층에서 자격증명·raw 스트림 비유입 불변 — momo Cloud조차 "사용자에게 임대된 실행 호스트"로 취급.
- (+) BM이 명확: 무료(T1/T2)로 오픈소스 신뢰 확보, T3는 워크스페이스 과금으로 운영을 판다.
- (−) workd는 새 배포물(서명·업데이트 채널 필요 — 0121 install/upgrade 체계에 편승).
- (−) T3 재판매 시작은 마진이 얇다 — 규모에서 D3-B 전환 전제.
- (−) 풀 대기·스냅샷 재개 지연 등 새 UX 상태가 늘어난다(스레드 카드로 전부 가시화가 완충).
