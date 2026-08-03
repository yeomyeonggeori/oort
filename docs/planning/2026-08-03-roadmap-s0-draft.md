# ROADMAP.md §0 교체 초안 — ✅ **승인·반영 완료 (2026-08-03)**

> 성재: *"결정 필요한 3개 부분은 권장 사항으로 추천해주면 내가 받을게. swift 사실상 지금 아무도 안 써서, 안에 핵심을 다 가져왔으면 도달 시 일괄 삭제 가능해."*
> → **3건 모두 권고안(a)로 확정.** 반영 위치:
> - `ROADMAP.md` §0 교체 + §1~§7에 "축으로 대체됨" 표식 (①②③)
> - `docs/adr/0145-*.md` Consequences에 **사실 정정**("기능 정지는 일어나지 않았고 병행이 나았다") + 삭제 시점 (②③)
> - `server/README.md` **신설** — "이식 원본이다, 실행 대상이 아니다" (③)
> - `docs/architecture/overview.md` 상단에 스택 갱신 경고 (①②③)
>
> 아래는 승인 당시의 초안 원문이다.
>
> 발단: `docs/planning/2026-08-03-roadmap-diagnosis.md` E항 — *"§0이 한 세대 낡아 아무것도 안내할 수 없다."*

## 왜 갈아야 하나

현행 §0이 서술하는 세계는 이렇다.

- "Phase 0 = **5개 Swift 패키지** 컴파일 통과"
- "`clients/iOS` = **미존재**, M5에서 생성"
- "clients/macOS = SwiftPM dev app"
- 진행 항목이 전부 **MOMO-2xx**(AWS 내부 알파·72h soak·local dogfood)

그 사이 실제로 벌어진 일:

| 사건 | 근거 |
|---|---|
| 서버가 **Swift → Rust/Axum 재작성**으로 확정 | **ADR-0145 Accepted (2026-07-30, 성재 B안 승인)** |
| 클라이언트가 **Tauri + React**로 확정 | ADR-0133 |
| 모바일이 **bare RN + Expo modules**로 확정, iOS 전면 재작성 | ADR-0137 |
| 푸시가 **Dawn 운영 PushRelay 경유**로 확정 | ADR-0120 D1-A |

§0은 이 넷 중 **하나도** 반영하지 않는다. 지금 이 문서를 읽고 다음 행동을 정할 수 있는 사람은 없다.

---

## 교체안 (§0 전체를 아래로 대체)

### 0. 현재 위치 (2026-08-03)

**출시 전 · 사용자 0 · 내부 도그푸드 단계.** 서버는 재작성 중이고, 그 위에 얹을 클라이언트 셋이 동시에 서 있다.

#### 서버 — Rust/Axum 재작성 진행 중 (ADR-0145)

```
Swift 정본(server/)         52 route files · 156 라우트 · 42k LOC   ← 이식 원본, 폐기 예정
Rust 재작성(server-rust/)   58 라우트 · 58k LOC(테스트 22k 별도)    ← 배포되는 것
```

**선 것**: auth · 메시지(발신·이력·수정·삭제·답글) · 채널 · 반응 · read-state · DM · 검색 · roster · 초대 · realtime 토큰 · devices · provider link/chain · **에이전트**(생성·프로필·pause·allowed-models·게이트웨이 잡) · **agent-runs**(게이트웨이 events/complete·채널별) · **work-hosts**(등록·heartbeat·BYOC·cloud·terminal-attach) · **work-sessions**(목록·생성·조회·resume·reattach) · work-tier-policy · usage/credits.

**안 선 것(대표)**: **approvals 0라우트** · work-controls · work-auto-approvals · workstream · plugins · MCP · Drive · huddles.

> **승인 축**: Swift에는 있다(`ApprovalDecisionRoutes.swift` 1,277줄 + `WorkControlRoutes`/`AgentGatewayRoutes`의 `INSERT INTO approval` + MCP `momo.create_tool_call`). Rust에는 없다. **goal SRV-T1**이 그 이식 중.

**불변식은 재작성 대상이 아니다** — 59 마이그레이션의 44개가 트리거·제약·RLS로 DB에 박아뒀고, 마이그레이션은 언어 독립이라 그대로 재사용한다(ADR-0145). 재작성은 "앱 계층 번역"이다.

#### 클라이언트

| 대상 | 상태 | 정본 |
|---|---|---|
| **웹** | 서 있음 · **23 feature** · 배포됨 | React |
| **데스크톱** | Tauri 셸 + 같은 React 앱 · 패키징됨 | ADR-0133 |
| **모바일(iOS)** | 서 있음 · **5 feature** · 실기기 검수 중 · NSE 포함 · **EAS 미사용** | ADR-0137 |
| 모바일(Android) | 미착수(성재 판단으로 후순위 → 리소스 되면 재개) | ADR-0137 |
| `clients/macOS`·`clients/iOS`(Swift) | **레거시** — 유지보수 대상 아님 | — |

**모바일 5 vs 웹 23이 지금의 가장 큰 격차**다. 서버가 주는 에이전트 운영·작업 관전을 **폰이 하나도 표면화하지 않는다**(진단 문서 A·B안 = goal RN-A1 이후).

#### 푸시

APNs 자격증명이 **종단으로 증명됨**(Apple이 `apns_id`와 함께 `400 BadDeviceToken` 반환 = provider token 수용). PushRelay 배포됨. payload는 **id-only**(ADR-0120 D2-A), `.p8`는 App Store 배포자만 보유하고 자체호스팅 서버는 전부 Dawn 운영 PushRelay를 경유한다(D1-A).

#### 남은 축 (M-번호가 아니라 **축**으로 센다)

ADR-0137 D5가 v0을 **관전 · 승인 · 대화** 셋으로 잘랐다. 현재:

| 축 | 서버 | 웹 | 모바일 |
|---|---|---|---|
| **대화** | ✅ | ✅ | ✅ |
| **관전** | ✅ | ✅ | ❌ |
| **승인** | ❌ (이식 중) | 부분 | ❌ |

**"출시"는 이 표가 다 차는 것이 아니라, 세 축이 폰에서 한 번씩 도는 것**이다.

#### 이 로드맵에서 **떨어져 나간 것**

- MOMO-2xx AWS 내부 알파 레인 · 72h soak · local dogfood 체크리스트 — **Swift 서버 시절의 전제**다. 재작성 후 다시 세워야 하고, 그대로 되살리면 안 된다.
- M1~M8 번호 체계 — 서버 재작성이 M-경계를 가로지른다. **번호를 살릴지 축으로 갈지가 성재 결정 사항**(아래).

---

## 성재에게 묻는 것 (셋)

### ① M0~M8 번호를 살릴 것인가, 축으로 갈 것인가
현행 M-번호는 "Swift 5패키지 → macOS 공증 → iOS 스토어"를 전제로 짜였다. 재작성이 그 전제를 관통했다.
- **(a) 축으로 간다** — 관전·승인·대화 셋이 폰에서 도는 것을 v0로 두고, 스토어는 그 뒤. *권고안.* 지금 실제로 일하는 단위와 일치한다.
- (b) M-번호를 유지하고 내용만 갱신 — 기존 티켓·문서 참조가 안 깨진다. 대신 이름과 실체가 계속 어긋난다.

### ② 재작성 중 클라이언트 작업을 계속할 것인가
ADR-0145는 *"수 주 기능 정지(성재 수용)"*를 적었다. 그런데 실제로는 재작성과 RN 클라이언트를 **병행**해 왔다(그 편이 나았다 — 재작성이 이미 메신저 코어를 넘겨서 클라가 붙을 표면이 있었다).
- **(a) 병행 유지** — *권고안.* 단 **클라는 Rust가 이미 주는 라우트만** 쓴다(승인 축은 SRV-T1 뒤로).
- (b) 재작성 완주까지 클라 동결 — 폰 검수가 몇 주 멈춘다.

**ADR-0145 본문의 "기능 정지" 문장은 실제와 다르므로, (a)면 ADR에 정정 한 줄이 필요하다.**

### ③ Swift 서버를 언제 지울 것인가
지금은 **이식 원본**이라 살아 있어야 한다(SRV-T1이 `ApprovalDecisionRoutes.swift`를 계약 정본으로 읽었다). 다만 156 → 58 라우트가 남아 있는 동안 *"어느 쪽이 정본이냐"*가 계속 헷갈린다.
- **(a) 라우트 parity 도달 시 일괄 삭제** — *권고안.* 그때까지 `server/`에 "이식 원본, 실행 대상 아님" 표식.
- (b) 축별로 이식 끝나는 대로 부분 삭제 — 헷갈림이 빨리 줄지만 되돌아볼 원본이 사라진다.

---

## 승인되면 할 일
1. `ROADMAP.md` §0을 위 교체안으로 치환.
2. ①의 답에 따라 M-번호 처리.
3. ②가 (a)면 **ADR-0145에 "기능 정지 → 병행"으로 정정 한 줄** 추가(경계 변경이 아니라 사실 정정이므로 새 ADR은 불필요하다고 판단 — 이견 있으면 알려줘).
4. ③의 답을 `server/README` 또는 `docs/architecture/overview.md`에 표식으로 반영.
