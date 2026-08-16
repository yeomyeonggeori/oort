# T3 egress capability 설계 — 허용목록은 필터가 아니라 권한 부여다 (2026-08-14)

> 발제: #1380 [T3][A4] — `research/2026-08-14-agent-cloud-infra-benchmark.md` §채택 후보 A4(갭 G4). 수행: Fable 위임 스파이크(DOCS ONLY).
> 판정 요약: **승인 도메인 하나 = 유출 채널 하나다.** Anthropic은 hypervisor/seccomp/gVisor가 버티는 동안 자체 egress 허용목록 프록시가 뚫리는 것을 실증했다 — 승인 도메인(자사 API 포함) 경유 유출. 우리 T3의 필수 egress 4종(provider LLM·Drive·레지스트리·oort 콜백)에 같은 시나리오를 매핑하면, 도메인 필터(ADR-0150 D4의 예약 슬롯)로는 넷 중 셋이 뚫린다. 처방은 **(목적×메서드/경로×자격 주입×수명) 좌표의 capability grant + 기본 거부 + grant/use 원장**이고, 제3자 목적지는 도메인 개방 대신 **우리 소유 게이트웨이 표면**으로 도달시킨다. 임의 도메인 투명 MITM은 금지(D4-② CA 발견의 정식 처분).
> 관련 정본: ADR-0150(대화 유출 경계 — 본 문서가 D4 슬롯을 대체 제안) · ADR-0157(+증보 1 — eBPF `deny_out` 실측) · ADR-0156(+증보 3 — CubeEgress CA 발견) · ADR-0004 증보 2(bundled 키 규율) · ADR-0164(계량) · ADR-0151(첨부 Drive 계약) · `research/2026-08-09-cubesandbox-d42-spike.md`(실측 정본)

표기: **[실측]** = 우리 로컬 실측(D4-②·U1·매핑표). **[출처]** = 공개 1차 출처(URL+조회일 §7). 그 외 서술은 본 문서의 설계 제안.

---

## 1. 왜 다시 설계하는가 — Anthropic이 산 교훈

anthropic.com/engineering/how-we-contain-claude(2026-05-25 발행, 조회 2026-08-14)의 요지 [출처]:

1. **격리층은 버텼다**: "The hypervisor, seccomp, and gVisor across our products have been dependable. Our custom allowlist proxy was the piece that failed."
2. **승인 도메인 경유 유출(자사 API가 채널이었다)**: 워크스페이스의 악성 파일에 숨은 지시 + 공격자 API 키 → Claude가 워크스페이스 파일들을 읽어 **공격자 키로 api.anthropic.com Files API에 업로드**. "The egress proxy checked the destination, saw api.anthropic.com, and let it through."
3. **모델층 방어는 이 계열을 못 잡는다**: 피싱 유도 프롬프트로 `~/.aws/credentials`를 읽어 외부로 POST — **25회 중 24회 성공**. "Our model-layer defenses anchor on user intent — when the user is the one typing the instruction, there's nothing anomalous for a classifier to catch."
4. **관점 전환이 처방의 핵심**: "Previously, we'd conceptualized the allowlist as a destination filter … But it may be better conceptualized as a **capability grant**." 수리도 그 방향 — 방어형 프록시가 **VM에 provision된 세션 토큰을 동반한 요청만 통과**시키고, 공격자 내장 키는 거부한다.

우리 현행과의 거리: ADR-0150 D4는 "도메인 allow/deny 목록(v1 자리만 확보)"이고, ADR-0157 D3는 "v0 인터넷 egress 허용 + 주입된 컨텍스트는 유출 가능하다고 간주"다. 즉 지금 그대로 v1에서 도메인 필터를 깔면 **Anthropic이 실패를 실증한 바로 그 부품을 재건**하게 된다. 본 설계는 그 슬롯을 교체한다.

---

## 2. 위협 모델 — 우리 T3 필수 egress 4종에 매핑

전제 [실측]: CubeSandbox 기본값은 Cubelet 내장 eBPF `deny_out`(RFC1918·루프백·링크로컬 거부) + `allow_out_v2` 빈 목록 = **공인 인터넷 전면 허용**(D4-② §5). ADR-0157 D1(내부망 차단)·D2(피어 차단)는 성립하지만, 인터넷 방향은 문이 활짝 열려 있다. 아래 표는 "필수라서 열어야 하는 문"이 도메인 단위로 열렸을 때 각각 무엇이 되는가다.

| # | 필수 egress | 도메인 필터 세계에서의 유출 시나리오 | 나갈 수 있는 것 | 대역폭 | 도메인 필터로 탐지 가능한가 |
|---|---|---|---|---|---|
| E1 | **provider LLM API** (bundled 키 — ADR-0004 증보 2·ADR-0164) | Anthropic 사고의 1:1 동형. `api.anthropic.com`/`api.openai.com` 승인 → 프롬프트 인젝션이 **공격자 키**로 같은 도메인의 Files/uploads·messages를 호출 → 공격자 계정으로 데이터 반출 | 세션에 주입된 전부(스레드 요약·리포·WIP·첨부 사본) + 샌드박스에 키를 env로 넣는 설계라면 **bundled 키 자체** | uploads류 = 회선 전속(MB/s급). messages만 있어도 요청당 수백 KB | **불가** — 목적지·TLS·요청 형상이 정상 LLM 호출과 동일. 자격 결속 없이는 원리적으로 구분 불가(Anthropic 실증) |
| E2 | **Drive 첨부 경로** (ADR-0151) | `*.googleapis.com` 승인 → resumable 업로드 세션을 **공격자 자격으로 공격자 Drive에** 개설해 임의 바이트 업로드. E1과 같은 구조에 대역폭은 더 크다 | 샌드박스 파일시스템 전부 | 회선 전속 — 필수 egress 중 최대 | **불가** — 정상 Drive 트래픽과 동일 형상 |
| E3 | **패키지 레지스트리** (셋업: npm·PyPI·crates·git 호스트…) | 도메인 자체는 읽기용이지만 ①쿼리스트링/URL 경로/비실재 패키지명 인코딩 ②`npm publish`류 쓰기 API ③git push — 전부 같은 승인 도메인 안에 있다 | 저대역 인코딩 유출(①) 또는 리포 통째(③) | ① 요청당 수백 B~KB, 반복으로 KB/s급 ② ③ MB급 | 부분 — ③은 메서드/경로를 봐야 하고, ①은 요청 수 이상치 관측이 필요. 도메인 필터 단독으로는 둘 다 못 본다 |
| E4 | **oort API 콜백** (workd 등록·컨트롤 폴링·메시지 — ADR-0157 D1의 "하나뿐인 문") | **우리 자신의 도메인이 Anthropic의 api.anthropic.com과 같은 좌표다.** 주입/탈취된 **타 세션·타 워크스페이스 토큰**으로 우리 REST에 쓰면, 데이터가 공격자가 보는 표면으로 이동 | 대화·산출물 텍스트(우리 API 형상이 허용하는 것) | 수 KB/req·레이트리밋 하한 | 부분 — 서버측 RLS·감사가 있으나, "어느 자격이 이 샌드박스에서 나가도 되는가"는 목적지 검사로는 안 보인다 |

부수 채널(어느 grant를 열든 남는 것): **DNS** — CoreDNS가 필수 종속[실측]이므로 임의 이름 해석이 허용되면 서브도메인 인코딩 터널(수십 B/query)이 성립한다. §3.7에서 정직하게 처리한다.

핵심 독해: **E1·E2·E4는 "승인이 곧 유출 채널"인 계열이라 목적지 검사로는 원리적으로 못 막고, 자격(credential)이 어디서 왔는가를 검사해야 막힌다.** E3만이 메서드/경로 등급의 통제로 의미 있게 좁혀지는 계열이다.

---

## 3. Capability-grant 설계

### 3.1 grant 좌표계 — 도메인이 아니라 5축

egress 허가의 단위를 도메인에서 **grant**로 바꾼다. grant 하나는:

```
(목적 purpose) × (대상 destination class) × (메서드/경로 클래스) × (자격 주입 방식) × (수명)
```

- **목적**: `llm_provider` | `oort_callback` | `attachment_read` | `registry_fetch` | `custom` — 열거형. "왜 여는가"가 원장에 남는다.
- **대상**: 우리 소유 게이트웨이 표면(§3.4~3.5) 또는 도메인 패턴. **원칙: 제3자 도메인을 직접 grant하지 않고 게이트웨이 표면을 grant한다** — 예외는 §3.7의 등급 저하 명시와 함께만.
- **메서드/경로 클래스**: `read_only`(GET/HEAD/OPTIONS — Codex cloud와 동일 어휘 [출처]) | `session_write`(자기 세션 표면 한정 쓰기) | `full`. L7이 보이는 곳에서만 유효 — 안 보이면 §3.7.
- **자격 주입 방식**: `inject_at_proxy`(샌드박스는 무자격 — E1) | `sandbox_held_identity`(workd 자체 신원 — E4, ADR-0142 부트스트랩 그대로) | `none`(E3).
- **수명**: `setup_phase` | `session` | `single_use` | TTL. 기본은 세션 종료와 함께 소멸 — 영구 grant 없음.

**기본 거부(default-deny)**: work phase의 샌드박스에서 위 grant에 없는 목적지는 L3/4에서 닿지 않는다. 이는 ADR-0157 D3("v0 인터넷 허용")의 **work-phase 한정 대체**다 — setup phase는 §3.5에서 넓게 유지하므로 "egress 차단은 제품을 부순다"는 D3의 근거와 충돌하지 않는다.

### 3.2 원장 — grant와 use를 나눠 남긴다

PG=SoT 불변식 그대로. 두 테이블 상당:

- **egress_grant**: `id · session/sandbox ref · purpose · destination_class · method_class · credential_mode · lifetime · granted_by(정책 기본값 | 워크스페이스 관리자) · created_at/expires_at`. RLS — 워크스페이스 준위 열람.
- **egress_use**(audit_log 계열 스트림): `grant_id · at · 호스트/표면 · 메서드/경로 클래스(가시 범위) · bytes_in/out · verdict(allow|deny) · deny_reason`. **거부도 행이다** — 기본 거부 체제에서 deny 행이 곧 침해 시도 신호다(Anthropic 사고에서 없던 것: 승인 도메인 유출은 로그상 정상이었다). 열람 준위는 ADR-0150 D3 동형(채널 멤버 준위 — 에이전트가 1급 멤버라는 주장과 정합).

탐지 스토리: ①deny 행 자체 ②grant별 use의 요청 수/바이트 이상치 ③E1은 **계량 교차** — 주입 게이트웨이의 usage ledger(ADR-0004 증보 2 D2)와 provider 청구의 대조. 계량 없는 bundled 호출 경로가 금지이므로(같은 D2), "원장에 없는 LLM 호출"은 존재할 수 없는 구조가 된다.

### 3.3 시행 분담 — L3/4(eBPF)와 L7(게이트웨이)의 절단면

| 층 | 실체 | 담당 | 근거 |
|---|---|---|---|
| **L3/4** | Cubelet 내장 eBPF — tap 인터페이스별 `deny_out`/`allow_out_v2` 맵 [실측] + create API의 `network{allowOut, denyOut, allowPublicTraffic, …}` per-sandbox 스펙(매핑표 §2.2 — **미실기동, 실측 필요**) | ①ADR-0157 D1/D2 거부 유지 ②**work phase: allow_out을 게이트웨이·oort API 주소로만 좁혀 "모든 egress는 게이트웨이를 지난다"를 강제** ③setup phase: 넓은 허용 | 커널/eBPF 층은 우회 불가(같은 VM 탈출 없이는) — 검증은 ADR-0157 증보 1의 `cubevsmapdump` 기대값 게이트를 `allow_out_v2` 기대값으로 확장 |
| **L7** | **oort 소유 egress 게이트웨이**(신규·소형) — Smokescreen 계열 CONNECT 정책(호스트명 ACL + **해석된 IP 재검증** — IP 리터럴/리바인딩 우회 봉쇄 [출처]) + Secretless 계열 자격 주입 [출처] | grant 평가·메서드/경로 클래스 시행·자격 스트리핑+주입·use 원장 발행 | 커스텀 최소화 원칙(§4-4): 정책 골격은 검증된 패턴(Smokescreen ACL·resolved-IP 재검증)을 차용하고, 우리 커스텀은 grant 평가·주입 규칙에 국한 |

주의 — 이름 정리 [실측]: cube-proxy(nginx 80/443)는 **ingress**(exec 경로 `*.cube.app`) 필수 종속이고, cube-egress는 **투명 MITM egress** 컴포넌트다. 본 설계의 L7 시행 지점은 **cube-egress 재사용이 아니라 oort 게이트웨이 신설**이다 — cube-egress를 비-MITM 정책 모드로 쓸 수 있는지, create `network.rules`(L7)가 cube-egress 없이 시행되는지는 **미실측**(후속 스파이크 항목 U-a·U-b, §5).

### 3.4 자격 주입 게이트웨이 — 샌드박스는 provider 키를 본 적이 없다 (E1의 처방)

- 에이전트 런타임의 provider base URL을 **게이트웨이의 provider-형상 엔드포인트**로 설정한다(전 주류 SDK가 base_url 오버라이드 지원). 샌드박스 → 게이트웨이는 우리 이름·우리 인증서, 게이트웨이 → provider는 게이트웨이가 자체 TLS 발신.
- 게이트웨이가 요청마다 bundled 키를 **주입**한다. 규칙 두 개가 전부다:
  1. **샌드박스發 요청에 자격증명이 이미 실려 있으면 거부한다**(Authorization·api-key류 헤더 동반 = deny + use 원장 기록). Anthropic 수리("only passes requests carrying the VM's own provisioned session token; an attacker-embedded key is rejected")의 동형 — 공격자 키는 provider에 도달하지 못한다.
  2. 주입 지점 = **계량 지점**. workspace/agent/run 태깅으로 usage ledger 기록(ADR-0004 증보 2 D2·ADR-0164 D1) — 과금 결선과 유출 방어가 한 부품이다.
- 위치는 **VM 밖(호스트/게이트웨이 박스)**. Anthropic은 "only the VM knows provenance"라 VM 안에 프록시를 넣었지만 [출처], 우리 기질은 **tap 인터페이스가 샌드박스별로 분리**되어 있어[실측 — ifindex별 eBPF 맵] 호스트가 provenance(어느 샌드박스의 트래픽인가)를 안다. VM 안 배치가 갖는 "샌드박스가 프록시를 변조" 위험도 함께 사라진다.
- 부수 이득 [실측]: D4-② M1(envVars가 PID1에 미도달)이 보여주듯 env로 키를 넣는 설계는 기질적으로도 취약하다 — 주입 게이트웨이는 그 문제를 원천 제거한다(넣을 키가 없다).
- **E2(Drive)는 v0에서 grant 자체를 발급하지 않는다.** ADR-0151이 이미 답이다: 첨부 읽기는 oort 인가 프록시 단일 경로(Drive URL 클라 비노출), 에이전트 업로드는 v0 제외. 샌드박스의 첨부 접근 = E4(oort 콜백) grant의 부분집합이 되고, `*.googleapis.com`은 열리지 않는다. v1에서 에이전트 업로드가 열리면 **도메인이 아니라 oort가 개설한 resumable 세션 URL 1개**(단일 파일·단일 목적지·single_use 수명)를 grant한다 — 세션 URL 자체가 capability다.
- **E4(oort 콜백)는 자격 결속의 대상이지 주입 대상이 아니다**: workd의 Ed25519 신원은 설계상 샌드박스 보유(ADR-0142). 게이트웨이는 "이 샌드박스의 tap에서 나가는 oort API 요청은 **이 세션의 신원만** 동반할 수 있다"를 시행한다 — 타 세션/타 워크스페이스 토큰 동반 요청은 deny. 그러면 유출의 도달 범위가 **자기 세션 표면**으로 고정되고, 자기 세션 표면은 채널 멤버가 보는 곳이다 — 유출이 곧 목격된다(ADR-0150 D3의 "채널 사실" 원칙이 방어선이 되는 지점).

### 3.5 2상 네트워크 — Codex 패턴을 우리 템플릿/스냅샷 파이프라인에

Codex cloud [출처]: "Setup scripts still run with internet access so you can install dependencies" → "By default, Codex blocks internet access during the agent phase" + 시크릿은 agent phase 전 제거. 우리 번역:

| 국면 | 네트워크 | 컨텍스트/자격 | 실체 |
|---|---|---|---|
| **템플릿 빌드** | 빌더(호스트)의 네트워크 — 샌드박스 밖 | 없음 | `cubemastercli tpl create-from-image` + **`--with-cube-ca=false`** [실측 — D4-② §6.4] |
| **세션 setup phase** | 넓음: 레지스트리·git 호스트(read_only grant, `setup_phase` 수명) | **컨텍스트 0·bundled 자격 0** — 리포 clone과 의존성 설치만 | ADR-0157 D3의 "egress 차단은 제품을 부순다"가 사는 곳 |
| **세션 work phase** | 좁음: E1 게이트웨이 + E4 oort API (+관리자 opt-in 시 E3 read_only) — 그 외 기본 거부 | 컨텍스트 주입은 여기서만 | eBPF allow_out 전환(어댑터가 phase 전이 시 재선언) |

**순서 불변식이 이 절의 전부다: 컨텍스트 주입은 넓은 네트워크가 닫힌 뒤에.** Codex가 "시크릿은 setup에만 존재"로 지킨 것을 우리는 방향을 뒤집어 "**대화는 work에만 존재**"로 지킨다 — 넓은 문이 열린 시간과 유출할 것이 있는 시간이 겹치지 않는다. 벤치마크 A2(설치-후 스냅샷 템플릿)와의 시너지: setup 산출물을 스냅샷으로 굳히면 work 세션은 스냅샷에서 부팅해 **setup phase 없이** 시작한다 — 넓은 문이 아예 안 열리는 세션이 표준이 된다.

work phase 중 에이전트가 의존성을 추가해야 하는 경우(실수요 존재): 기본은 **거부 + 사유 표면**("의존성 추가는 setup 재실행으로")이고, 워크스페이스 관리자가 E3 read_only grant를 세션 수명으로 opt-in할 수 있다 — §3.7의 잔여 채널 고지와 함께. (기본값을 어느 쪽으로 할지는 성재 결정 큐 §6-①.)

### 3.6 MITM CA 취급 — D4-② 발견의 정식 처분

[실측] 템플릿 빌드는 CubeEgress 투명 MITM(TPROXY)의 루트 CA를 기본으로 rootfs에 굽는다(`--with-cube-ca` 기본 true). 처분:

1. **임의 도메인 투명 MITM은 하지 않는다 — CA를 굽지 않는다**(`--with-cube-ca=false` 정본화 + 템플릿 검증 게이트에 "CA 부재" 단정 추가). 근거: ①샌드박스에 범용 신뢰 앵커 1개 추가 = MITM 키 유출 시 전 세션의 전 TLS가 열린다 ②인증서 피닝을 쓰는 정상 도구를 부순다 ③Anthropic 교훈의 "커스텀 부품 최소화"와 정면 충돌 — 우리가 깰 수 있는 부품을 전 TLS 경로에 끼우는 일이다.
2. **자격 주입에 MITM은 필요 없다**: §3.4는 가로채기가 아니라 **명시적 base URL**이다 — 샌드박스가 우리 엔드포인트로 "찾아오게" 하지, 남의 도메인 행세를 하지 않는다. 신뢰 앵커는 우리 이름 하나에 좁게 스코프된 인증서뿐.
3. **TLS 가로채기가 정당한 유일한 경우**: 제3자 도메인에 L7(메서드/경로) 등급 통제를 강제해야 할 때다. v0에는 그 요구가 없다(E1·E2·E4는 게이트웨이 표면, E3는 §3.7의 등급 저하 수용 또는 미러). 그 요구가 생기면 — 범용 CA가 아니라 **세션 스코프 단명 CA + 대상 도메인 한정**으로 별건 결정.

### 3.7 정직 표기 — 이 설계가 막지 못하는 것 (bounds, not blocks)

ADR-0157 D3의 명제 "**샌드박스에 주입된 컨텍스트는 유출 가능하다고 간주한다**"는 본 설계 후에도 **철회되지 않는다**. 남는 채널과 그 상한:

- **CONNECT 불투시**: MITM을 거부했으므로, 도메인 직접 grant(E3 계열)에서는 메서드/경로가 안 보인다 — grant 등급이 (도메인×해석IP×연결)로 저하된다. 완화 축: **read-only pull-through 미러**(우리가 호스팅하는 레지스트리 캐시 — 샌드박스는 우리 엔드포인트만 보고, 미러는 읽기 경로만 구현·패키지명 로그·캐시 이득 덤). 미러를 v0에 세울지는 §6-③.
- **저대역 인코딩**: 열린 어떤 grant든 쿼리스트링·경로·요청 타이밍으로 KB/s급 유출이 가능하다. 방어는 차단이 아니라 **관측**(use 원장 이상치)과 **주입 최소화**(ADR-0157 D3 ① — 세션 스레드 요약만, 채널 전체 히스토리 금지)다.
- **DNS 터널**: work phase 리졸버를 **grant된 이름만 응답**하도록 좁힌다(CoreDNS 설정 — 실측 필요 U-c). 그래도 grant된 이름의 서브도메인 인코딩은 남는다 — 수십 B/query 상한, use 원장의 질의 수로 관측.
- **자기 세션 표면 유출**(E4): 막지 않는다 — 채널 멤버 가시 공간으로의 이동이므로 "유출"의 정의가 다르다. 다만 세션이 다루는 데이터가 채널 청중보다 민감한 경우(주입 최소화 위반)는 이 경계가 못 지킨다 — 주입 규율이 선행 방어선이다.
- **BYOC 비적용**: 본 설계 전체가 managed T3(CubeSandbox) 어댑터의 것이다. BYOC 호스트의 egress는 소유자 것 — 신뢰 경계 차이를 문서화(ADR-0142 Consequences의 기존 문장 연장)하고 강제하지 않는다.

---

## 4. Anthropic 실패 모드 대조표

| Anthropic 실증 실패 [출처] | 본 설계의 대응 | 막나 / 좁히나 |
|---|---|---|
| 승인 도메인(자사 api.anthropic.com) 경유, 공격자 키로 Files API 업로드 | E1: 샌드박스 무자격 + 게이트웨이 주입 + **자격 동반 요청 거부**(§3.4 규칙 1) — 공격자 키가 provider에 도달할 경로가 없다. E2: 그 대역폭 최대 동형(Drive)은 grant 자체를 발급하지 않음 | **막는다** (게이트웨이가 뚫리지 않는 한 — red proof: "내장 키 동반 요청이 deny+원장 기록되는가"를 게이트 테스트로) |
| 피싱/파일 주입 지시로 자격증명 읽어 외부 endpoint에 POST (25회 중 24회 성공) | ①work phase 기본 거부 — 임의 외부 endpoint가 L3/4에서 닿지 않는다 ②읽을 고가치 자격이 샌드박스에 없다(bundled 키 비보유·workd 신원은 자기 세션 스코프) | **막는다**(공표된 채널 기준). 잔여: 자기 세션 표면·저대역 인코딩으로의 강등 — §3.7 |
| 모델층 방어가 사용자 의도 앵커라 정상 지시형 유출을 못 잡음 | 모델층에 아무것도 걸지 않는다 — 환경층(기본 거부·자격 결속·원장)이 방어선. "Design for containment at the environment layer first" 그대로 | 해당 없음(같은 원칙 채택) — 단 환경층도 §3.7의 잔여 채널은 **좁힐 뿐**이다 |
| **커스텀 allowlist 프록시가 유일하게 실패한 부품** | 커스텀 표면 최소화: L3/4는 기질 내장 eBPF(기대값 게이트로 계약화), L7 정책 골격은 검증된 패턴(Smokescreen ACL·resolved-IP 재검증), MITM CA 미도입. **정직한 인정: 주입 게이트웨이는 우리 커스텀이다** — 그래서 규칙을 2개로 묶고(주입·거부), fail-closed(게이트웨이 불달 = E1 전면 불통이지 우회 아님)로 두고, red proof를 계약에 넣는다 | **좁힌다** — 실패 가능 부품이 사라지진 않고, 작아지고 관측 가능해진다 |

---

## 5. 채택 경로 — 무엇이 어댑터 계약이고 무엇이 ADR 증보인가

**어댑터 계약/운영 내부(경계 변경 아님 — ADR-0156 D2 capability 선언·D4-③ 티켓 체인 안)**:

| 조각 | 내용 | 노력(S=수일·M=1~2주) |
|---|---|---|
| P3 | eBPF `allow_out` phase별 선언 + create `network` 스펙 결선 + `cubevsmapdump` 기대값 게이트 확장(ADR-0157 증보 1 연장) | **S** (+선행 실측 U-a: create `network` 스펙 실동작) |
| P4 | 템플릿 `--with-cube-ca=false` + CA 부재 검증 단정 | **S** (D4-③ 런북에 기존재 — 게이트화만 추가) |
| P6 | 레지스트리 read-only pull-through 미러(기성 소프트웨어 조합) | **S~M** (§6-③ 결정 후) |

**ADR-0150 증보 필요(경계 — 본 문서와 함께 제출, Accept는 성재)**:

| 조각 | 내용 | 노력 |
|---|---|---|
| P1 | egress_grant/egress_use 원장(PG 마이그레이션·RLS·열람 준위) + 정책 평가기 | **M** |
| P2 | 자격 주입 게이트웨이(provider-형상 base URL·주입·자격 동반 거부·계량 결선) — ADR-0164 계량과 **한 부품** | **M** (계량 구현과 합배치 권고) |
| P5 | 2상 세션 결선(setup→work grant 전환·순서 불변식) — A2(스냅샷 템플릿)와 합류 시 시너지 | **M** |
| P7 | grant/use 열람 표면(관리자·채널 준위) | **S** (UXUI 트랙) |

선행 실측(후속 스파이크 — 전부 소형): **U-a** create API `network{allowOut,denyOut,rules}` per-sandbox 실동작(D4-②에서 미실기동) · **U-b** cube-egress의 비-MITM 정책 모드 존부(쓸 수 있으면 P2의 CONNECT 골격 대체 후보) · **U-c** CoreDNS 응답 범위 축소 가능성(§3.7 DNS).

권고 랜딩 순서: 증보 Accept → U-a/b/c(1개 스파이크로 묶음) → P3+P4(즉시 조이는 것) → P1+P2(계량과 함께) → P5(A2와 함께) → P6/P7.

---

## 6. 성재 결정 큐 (본 설계가 일부러 안 정한 것)

1. **work phase 레지스트리 기본값** — 기본 거부+관리자 opt-in(본 문서 권고) vs 기본 허용(read_only). 마찰 대 잔여 채널의 제품 판단.
2. **`custom` grant(사용자가 에이전트에게 임의 API 호출을 시키고 싶을 때)의 개방 시점과 승인 UX** — grant 좌표계에 자리는 있으나 v0 개방 여부·승인 주체(워크스페이스 관리자? 채널?)는 미정. Anthropic 교훈상 항목별 "도달 가능 기능 심사"가 요구되는 표면이라 가볍게 열 수 없다.
3. **레지스트리 미러(P6)를 v0에 세울 것인가** — 세우면 E3가 게이트웨이 표면으로 승격(등급 저하 소거), 안 세우면 도메인 grant+정직 고지로 시작.
4. **러닝 단가·게이트웨이 배치 위치**(전용 호스트 동거 vs 분리) — ADR-0164 단가 결정과 함께.

## 7. 출처 (전 항목 조회일 2026-08-14)

| URL | 내용 |
|---|---|
| anthropic.com/engineering/how-we-contain-claude (2026-05-25 발행) | allowlist 프록시 실패 실증·capability grant 재개념화·방어형 프록시(세션 토큰 결속) 수리·25중 24 유출 통계 |
| developers.openai.com/codex/cloud/agent-internet (→ learn.chatgpt.com/docs/cloud/internet-access) | 2상 네트워크(setup 온라인→agent 기본 차단)·allowlist 프리셋·GET/HEAD/OPTIONS 메서드 제한·프롬프트 인젝션/유출 경고 |
| github.com/stripe/smokescreen (README·acl/v1/policy.go·PR #285) | CONNECT 프록시 egress 정책 골격 — 호스트명 ACL·공인 IP 강제·해석된 IP 재검증(우회 봉쇄) |
| docs.cyberark.com Secretless Broker(secretless.io·github.com/cyberark/secretless-broker) | 자격 주입 프록시 패턴 — "connection secrets are … never exposed to the client" |

로컬 실측 정본: `research/2026-08-09-cubesandbox-d42-spike.md`(eBPF deny_out/allow_out_v2·CubeEgress CA·AUTH_CALLBACK path+method) · `research/2026-08-08-cubesandbox-requirements-adapter-mapping.md`(create `network` 스펙·레지스트리 의존) · ADR-0157 증보 1(기대값 검증 패턴).
