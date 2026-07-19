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
- **A (권고, v1) — 샌드박스 재판매 위에서 시작**(E2B/Daytona/Blaxel류 초단위 과금): 프로비저너·풀·과금을 먼저 검증. 원가가 자동으로 사용량 비례.
- B (v2 예약) — 자체 Firecracker 플릿: p95 동시성 bin-packing 마진(17-00 §4.1)이 커지는 규모에서 전환. A의 프로비저너 인터페이스를 기질-불가지로 설계해 전환 비용 최소화.

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

## 파생 (Accepted 후 발급 예약 — 0114 파생 483~486 랜딩 후 순차)

- **MOMO-487** (엔진): `work_host` 레지스트리 migration+REST 등록/revoke+Ed25519 검증+control 라우팅(host_id 필터) + verifier
- **MOMO-488** (엔진): momo-workd v0 — 단일 바이너리·outbound 다이얼·PTY 세션 매니저(앱 세션 매니저와 프로토콜 공유)·launchd/systemd 유닛 + `momo host add` SSH 부트스트랩
- **MOMO-489** (엔진): `work_pool` 원장 + slot acquire/release + 대기열 이벤트 + verifier
- **MOMO-490** (UXUI): 호스트 선택기(승인 카드)·호스트 관리 설정·대기열 카드·원격 로그인 브리지 UX
- momo Cloud 프로비저너(기질 선정·과금 연동)는 위 4장 랜딩 후 별도 배치(S 배치 install.sh 자동화 승격과 합류)

## Consequences

- (+) 세션이 앱·기기 수명에서 해방 — 폰(iOS 스레드)에서 팀 VPS의 codex 세션을 관전·개입 가능. 숙원의 구조적 해소.
- (+) 전 계층에서 자격증명·raw 스트림 비유입 불변 — momo Cloud조차 "사용자에게 임대된 실행 호스트"로 취급.
- (+) BM이 명확: 무료(T1/T2)로 오픈소스 신뢰 확보, T3는 워크스페이스 과금으로 운영을 판다.
- (−) workd는 새 배포물(서명·업데이트 채널 필요 — 0121 install/upgrade 체계에 편승).
- (−) T3 재판매 시작은 마진이 얇다 — 규모에서 D3-B 전환 전제.
- (−) 풀 대기·스냅샷 재개 지연 등 새 UX 상태가 늘어난다(스레드 카드로 전부 가시화가 완충).
