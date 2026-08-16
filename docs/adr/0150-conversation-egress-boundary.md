# ADR-0150: 대화 유출 경계 — 에이전트 도구가 대화 내용을 momo 밖으로 내보낼 때

- Status: **Accepted** (2026-08-05 기안 Fable · 성재 승인 2026-08-09 — 원안 D1~D4)
- 관련: ADR-0004(provider 자격증명 **유입** 금지 — 본 ADR은 그 **역방향**), SRV-B3b 조사(`docs/planning/2026-08-04-SRV-B3b-websearch-research.md`), agent_profile.enabled_tools(#1018 소비자)
- 발단: 성재 — *"웹검색은 안 되는 거 같아. 툴이 필요하면 쥐어줘."*

## 문제

웹검색 툴(provider 내장 `web_search`)을 켜는 순간, **사용자 메시지에서 뽑힌 검색어가 외부 검색엔진으로 나간다.** ADR-0004는 자격증명이 momo로 들어오는 방향만 다루고, 대화 내용이 momo 밖으로 나가는 방향의 경계는 어떤 정본도 정하지 않았다. 조사 확정 사실: provider는 받는다(8/8 모델 `supports_search_tool`), momo 어댑터도 통과시킨다 — 막는 건 정책 부재뿐.

## 결정 (제안)

**D1. 기본 off.** 워크스페이스·에이전트 어느 층에서도 명시적으로 켜기 전에는 검색이 나가지 않는다(현행 enabled_tools fail-closed와 동형).
**D2. 승인 대상 아님.** 검색은 읽기 전용·비가역성 없음·턴 내 완결 — tool_call 승인을 물리면 답 하나에 승인 N번(조사 권고 수용). 대신:
**D3. 검색 감사.** 검색 발생 사실(시각·에이전트·검색어)을 audit_log에 남긴다 — "켜면 언제 썼는지 아무도 모른다"가 기본값이 되지 않게. 검색어는 대화 인용이므로 감사 행의 열람 권한은 채널 멤버 준위.
**D4. 도메인 필터(후속).** v1에서 allow/deny 도메인 목록 — v0 범위 밖, 자리만 확보.

## 선행

`agent.tool_schema` 쓰기 표면 또는 tool 카탈로그 확장 경로(T-a) + 조사 문서 §7의 5분 실험(신원 게이팅 여부 — MAESTRO 로컬 스택 활용).

## Slack 비교

Slack 앱의 외부 호출은 앱 설치 시 스코프 동의로 일괄 위임되고 호출 단위 가시성이 없다. momo는 툴 단위 스위치(D1)+발생 감사(D3)로 "무엇이 나갔는가"를 채널 사실로 남긴다 — 에이전트가 1급 멤버라는 주장과 정합.

---

## 증보 1 — T3 egress capability 경계 (2026-08-14, 기안 Fable 위임 스파이크)

- Status: **Accepted** (성재 승인 2026-08-14 — 일괄 결재. §6 미결 4건은 P1~P7 티켓 분해 시 확정)
- 발단: 벤치마크(`research/2026-08-14-agent-cloud-infra-benchmark.md` §A4·갭 G4) — Anthropic 실증에서 hypervisor/seccomp/gVisor는 버텼고 **자체 egress 허용목록 프록시가 유일하게 실패한 부품**이었다(승인 도메인 경유 유출 — 자사 api.anthropic.com Files API가 채널). 본문 D4가 예약한 "도메인 필터" 슬롯을 그대로 채우면 같은 부품을 재건하게 된다.
- 근거 정본: **`research/2026-08-14-t3-egress-capability-design.md`** (위협 모델·설계 전개·대조표·출처 전부 — 본 증보는 결정만 적는다) · 실측 `research/2026-08-09-cubesandbox-d42-spike.md` · ADR-0157(+증보 1) · ADR-0004 증보 2 · ADR-0164

### D1. 허용목록 항목 = capability grant (본문 D4 대체)
- 본문 D4(도메인 allow/deny 목록)를 폐기하고 대체한다. T3 샌드박스의 egress 허가 단위는 도메인이 아니라 **grant** = (목적 × 대상 × 메서드/경로 클래스 × 자격 주입 방식 × 수명)이다. **승인 도메인은 중립 파이프가 아니라 부여된 유출 채널로 간주**하고, grant 발급 시 항목별 도달 가능 기능을 심사한다. work phase 기본값은 **default-deny** — grant에 없는 목적지는 L3/4에서 닿지 않는다(ADR-0157 D3의 "v0 인터넷 허용"은 work phase에 한해 이 규칙으로 대체, setup phase는 유지).

### D2. grant/use 원장
- grant는 PG 원장(`egress_grant` — RLS, 워크스페이스 준위), 사용은 audit 스트림(`egress_use` — 목적지·바이트·verdict). **거부(deny)도 행이다** — 기본 거부 체제에서 deny 행이 침해 시도 신호다. 열람 준위는 본문 D3 동형(채널 사실).

### D3. 자격 주입은 프록시에서 — 샌드박스는 provider 키를 보유하지 않는다
- bundled provider 키(ADR-0004 증보 2)는 샌드박스에 유입되지 않는다. 에이전트 런타임은 **oort 소유 주입 게이트웨이**(provider-형상 base URL)를 향하고, 게이트웨이가 요청마다 키를 주입한다. **샌드박스發 요청에 자격증명이 이미 실려 있으면 거부**(Anthropic 수리 동형 — 공격자 내장 키가 provider에 도달할 경로 소거). 주입 지점 = 계량 지점(ADR-0004 증보 2 D2·ADR-0164) — 과금 결선과 유출 방어가 한 부품이다. 게이트웨이 불달은 fail-closed.
- Drive(`*.googleapis.com`)는 v0에서 grant를 발급하지 않는다 — 첨부는 ADR-0151의 oort 인가 프록시 단일 경로(= oort 콜백 grant의 부분집합). 향후 에이전트 업로드는 도메인이 아니라 oort가 개설한 **single_use 업로드 세션 URL**을 grant한다.
- oort API 콜백은 자격 결속 대상: 해당 샌드박스의 tap에서 나가는 oort 요청은 **그 세션의 workd 신원만** 동반할 수 있다 — 유출 도달 범위가 자기 세션 표면(채널 멤버 가시)으로 고정된다.

### D4. 2상 네트워크 — 컨텍스트 주입은 넓은 네트워크가 닫힌 뒤에
- 세션은 **setup phase**(레지스트리·git read_only grant, 컨텍스트 0·bundled 자격 0)와 **work phase**(주입 게이트웨이+oort 콜백, 그 외 기본 거부)로 나뉜다(Codex cloud 2상 패턴의 우리 번역). 순서 불변식: **넓은 문이 열린 시간과 유출할 것이 있는 시간은 겹치지 않는다.** 스냅샷 템플릿(벤치마크 A2)과 합류 시 setup phase 없는 세션이 표준이 된다.

### D5. 임의 도메인 투명 MITM 금지
- 템플릿에 CubeEgress 루트 CA를 굽지 않는다(**`--with-cube-ca=false` 정본화** + CA 부재를 템플릿 검증 게이트로 — D4-② 실측 발견의 정식 처분). 자격 주입은 가로채기가 아니라 명시적 base URL로 하므로 MITM이 필요 없다. 제3자 도메인 L7 통제가 필요해지는 미래에는 범용 CA가 아니라 세션 스코프 단명 CA를 별건 결정으로.

### D6. 정직 조항 — bounds, not blocks
- ADR-0157 D3의 명제("샌드박스에 주입된 컨텍스트는 유출 가능하다고 간주한다")는 **철회되지 않는다.** 남는 채널(도메인 직접 grant의 CONNECT 불투시·쿼리스트링/DNS 저대역 인코딩·자기 세션 표면)은 차단이 아니라 **관측(use 원장 이상치)과 주입 최소화**로 좁힌다. 시행 분담: L3/4=기질 내장 eBPF(`cubevsmapdump` 기대값 게이트 확장 — ADR-0157 증보 1 연장), L7=주입 게이트웨이(정책 골격은 검증된 패턴 차용, 커스텀 표면 최소화).

### Consequences
- (+) Anthropic이 실증한 실패 계열(승인 도메인 경유·자격 반출·자사 API 채널화)이 설계 좌표에서 소거되거나 관측 가능해진다. 과금 계량(ADR-0164)과 방어가 한 부품으로 겸용.
- (−) 신규 부품 2개(grant 원장·주입 게이트웨이)와 선행 실측 3건(create `network` 스펙·cube-egress 비-MITM 모드·CoreDNS 응답 축소) — 조각별 노력·랜딩 순서는 설계 문서 §5.
- (−) BYOC에는 비적용(호스트 egress는 소유자 것) — 신뢰 경계 차이 문서화만.
- 성재 결정 큐: work phase 레지스트리 기본값 · `custom` grant 개방 시점/승인 UX · 레지스트리 미러 v0 여부 · 게이트웨이 배치(설계 문서 §6).
