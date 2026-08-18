# DeepSeek Harness(dsh) 벤치마크 — oort 갭 맵과 차용 편성안

> 2026-08-18 Fable (PLN-20260815-01) · 성재 발제("철학·플러그인 중심 구조·화면/UX·온보딩·최적화·커뮤니티 종합 분석 후 포함 계획").
> 사실 수집=딥리서치 워커(2026-08-18 실측·전 항목 1차 출처) · 분석·편성=momo-main.
> 지위: 리서치 정본. 차용 실행은 §5 편성안의 티켓 발급으로.

## §0. 정체 (사실 — 전부 출처 확인)

- **DeepSeek Harness(dsh)** — [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), DeepSeek **공식**(HN에서 소속 개발자 답변 확인), **MIT**. 2026-08-13 공개(V4-Pro-0813 동시), v0.1.0-rc.5 developer preview(호환성 파괴 예고 중). **5일 만에 153.2k★/15.8k fork** — GitHub 최고속 채택 곡선급.
- TypeScript 모노레포(57패키지 ~50만 라인)+Linux 샌드박스 C11 ~300라인. 기본 형태=**로컬 Web UI**(`npx @deepseek-ai/dsh web`)+headless 러너. 플러그인 커널=**Cordis**.
- 슬로건: **"Everything is a plugin. Every run is traceable."** · 프레이밍: "Agent = Model + Harness".
- 주요 출처: [공식 docs](https://deepseek.com/harness/en/) · [architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) · [HN 스레드(737점)](https://news.ycombinator.com/item?id=49285244) · [Justin3go 심층 리뷰](https://justin3go.com/en/posts/2026/08/15-deepseek-harness-review) · [dsh-plugin 토픽(6,946 레포)](https://github.com/topics/dsh-plugin) · [MarkTechPost](https://www.marktechpost.com/2026/08/17/deepseek-ai-releases-deepseek-harness-in-developer-preview/).

## §1. 해부 — "좋다"는 평가의 실체

1. **추적성이 문서 약속이 아니라 아키텍처 보장** [실측]: 불변식 **"Model-visible means logged"** — 모델이 보는 전부(시스템 프롬프트·추론·툴 호출/결과·서브에이전트 스케줄링·컨텍스트 주입)가 append-only 세션 로그에 남고 `deriveMessages()`로 재구성 가능. HN 호평 1순위는 그 위의 **Trajectory view — resume/fork/search/replay**.
2. **루프까지 플러그인** [실측]: "There is no privileged core to patch" — 모델 어댑터·툴 레지스트리·컨텍스트 컴팩션·**에이전트 루프 자체**가 교체 가능. 최소 계약 2줄(`name`+`apply(ctx)`), 이벤트 파이프라인 13단(`turn/start→…→turn/end`), reversible Effects(언로드 자동 되감기). 리뷰 인용: "not marketing rhetoric but structural reality".
3. **개방성**: MIT·모델 락인 없음(40+ 프로바이더)·MCP 호환·경쟁 하네스(claude-code/codex)를 **서브에이전트로 위임** — 전례 없는 harness-agnostic.
4. **온보딩**: Node만 있으면 한 줄→Web UI→키 입력→workspace 선택→첫 태스크 5~10분. 재시작 없는 키 반영.
5. **엔지니어링 투명성**: 의사결정 기록 1,386건 공개 · **docs(17만 라인)-코드 드리프트를 CI가 검사**.
6. **커뮤니티 부트스트랩**: 공식 마켓 없이 4층 — GitHub 토픽(`dsh-plugin` 6,946) → CI 생성 `catalog.json` 허브 → 커뮤니티 레지스트리 → awesome 큐레이션. 생태 자생 도구: plugin-doctor(검증)·poison-guard(공급망 스캔).

## §2. oort 대비 갭 맵

| 축 | dsh | oort 현재 | 갭 판정 |
|---|---|---|---|
| 추적성 계약 | model-visible=logged 불변식+재구성 함수 | run 원장·usage·audit·ACP 스레드·완료 리포트 — **강하지만 계약으로 성문화 안 됨**(컨텍스트 조립 전문이 로그에 남는다는 불변식 부재) | **성문화 갭** — 우리 정직 규율(ADR-0132)의 자연 연장 |
| 세션 재생/분기 | Trajectory view resume/fork/replay | 세션 상세=이벤트 타임라인+관전 라이브 화면(우리만 있음). replay/fork 없음 | **표면 갭** — LIVE 축과 상보(그들=기록 재생, 우리=실화면 관전) |
| 플러그인 구조 | in-process 플러그인, 루프까지 교체 | 플러그인 레지스트리·MCP(E7 OAuth)·webhook — **경계 밖 확장**(단일 쓰기경로·RLS 불침) | **철학 차이가 우위**: dsh 자신의 "trust gap"(플러그인 인프로세스 실행) 비판이 우리 fail-closed 경계의 정당성 근거 |
| 훅 택소노미 | 13단 이벤트 파이프라인 공개 명명 | 워커 내부 단계는 있으나 **이름 붙은 공개 계약 아님** | **어휘 갭** — 명명·로그 계약화만으로 확장·감사가 쉬워짐 |
| 온보딩 | 한 줄→5~10분 | 페어링 위저드(UX1)·BYOA — **첫 성공까지 시간 미실측** | **측정 갭** |
| docs 드리프트 | CI diff | policy-integrity·계약 테스트는 있으나 **런북 명령 실검증 없음** — #1472에서 RUN.md의 깨진 fmt 명령이 실제로 워커들을 오도 | **실증된 갭** |
| 커뮤니티 구조 | 토픽+catalog CI+doctor+poison-guard | 미개장(플랫폼 확장 overlay ADR-0119~0121 예약) | 시기 문제 — 개장 시 청사진으로 차용 |
| 토큰 규율 | 시스템 프롬프트 ~47.6K(경쟁 대비 3~10배) — **약점** | REPORT_PROTOCOL_BLOCK ~6줄+opt-out 플래그 | **우리가 우위** — 반면교사로 성문화 |

## §3. 차용 후보 (S/M/L · ADR · 표면)

| # | 후보 | 규모 | ADR | 근거·표면 |
|---|---|---|---|---|
| **A** | **docs-코드 드리프트 게이트** — RUN.md·runbook의 실행 명령을 CI/게이트가 실검증(#1472의 `--all` 부재 사고의 일반화) | **S** | 불요 | scripts/ 게이트. dsh §1-5 동형, 우리는 이미 사고 실증 보유 |
| **B** | **온보딩 벤치마크 감사** — "설치→첫 성공 N분" 실측 하네스+기본값 감사(위저드·workspace 선택·키 반영 무재시작) | **S** | 불요 | 데스크탑 검수 인테이크와 합류. dsh 5~10분이 기준선 |
| **C** | **추적성 계약 성문화** — "모델이 본 것=로그에 있다" 불변식을 워커 계약으로: 컨텍스트 조립 전문(트림 포함) 해시/전문 로그+`deriveMessages` 동형 재구성 conformance | **M** | **증보**(0132 정직 계열 또는 신규 — 로그 보존·redaction 경계) | server-rust 워커. #1454 프로토콜·redact 계약 위에 가산 |
| **D** | **훅 택소노미 공개 명명** — 워커 턴 파이프라인 13단 동형의 이름·로그 계약(문서+durable 이벤트). in-process 플러그인은 **비채택**, 확장은 기존 webhook/MCP 경계로 | S~M | 명명=불요 / 외부 노출=ADR | server-rust+docs. C의 어휘 기반 |
| **E** | **Trajectory 표면** — 세션 상세에 턴·툴 타임라인 search/replay(1단계), resume/fork(2단계 — 의미론 결정 필요) | **L** | **필요**(fork 의미론·원장 관계) | 웹 세션 상세. 전제=C. LIVE-5 뒤 세션 표면 심화와 자연 접속 — 관전(실화면)+재생(기록)이 한 화면 |
| **F** | **Code Mode 동형** — 워커가 TS 코드 블록으로 툴 호출 배칭, 실행=**T3 CubeSandbox 재사용**(우리는 샌드박스 인프라 기보유 — dsh 대비 구조 우위) | **L** | **필요**(실행 경계·과금) | 환경 폐곡선(커서 후보 B)과 같은 파도에서 검토 |
| **G** | **플러그인 생태 청사진** — 개장 시: `oort-plugin` 토픽+CI catalog+doctor/poison-guard 동형+**권한 매니페스트**(dsh trust gap의 fail-closed 교정판) | M~L | **필요**(ADR-0119~0121 증보) | 플랫폼 확장 overlay 시점에. 지금은 청사진 문서만 |
| **H** | **반면교사 성문화** — 토큰 오버헤드(47.6K)·CLAUDE.md/AGENTS.md 이중 주입 버그·플러그인 피로·벤치마크 불투명(벤더 80.6% vs 서드파티 96.4%)을 우리 컨텍스트 규율 문서에 렛슨으로 | **S** | 불요 | docs. 우리 ~6줄+플래그 규율의 근거 강화 |

**MIT 직접 차용 실사**: 서버가 Rust+고정 불변식이라 **런타임 통짜 이식은 부적합·불필요**. 실익 있는 직접 차용은 ①Trajectory view UI 패턴/컴포넌트(TS — 우리 웹과 동언어, E에서) ②catalog.json 생성 CI·doctor/poison-guard 스크립트(G에서) ③이벤트 파이프라인 명명 어휘(D — 코드 아닌 계약). Cordis 커널 자체 이식은 비채택(우리 확장 경계는 프로세스 밖).

## §4. 반면교사 (따라하면 안 되는 것)

1. **in-process 플러그인 신뢰 공백** — 임의 플러그인이 하네스 권한으로 셸/FS 접근. 우리 경계(웹훅·MCP·RLS 밖 확장)가 옳다는 외부 실증. G의 권한 매니페스트는 이 교훈의 교정판으로 설계.
2. **컨텍스트 비대** — 47.6K 시스템 프롬프트. 우리 규율(짧은 블록+opt-out+바이트 동일 테스트) 유지가 경쟁력.
3. **플러그인 피로** — 5일 7천 레포의 뒷면은 "6개월 뒤 폐기 플러그인 악몽"(HN). 개장 시 계약 안정성 약속을 먼저.
4. **벤치마크 불투명** — 발표 수치 상충·재현 부재. 우리 "정직 라벨·실측 게이트" 문화 유지.

## §5. 편성안 (momo-main 권장 — 전권 위임 하 확정, 성재 veto 가능)

- **즉시(다음 위생 파도 편입)**: **A**(docs 드리프트 게이트)+**B**(온보딩 실측)+**H**(반면교사 문서) — 전부 S급·ADR 불요.
- **LIVE-5 완주 후 1파도**: **C**(추적성 계약 — ADR 증보 기안 동반)+**D**(훅 택소노미 명명).
- **환경 폐곡선(커서 B) 검토 시 합석**: **F**(Code Mode×T3 — 같은 샌드박스 실행 결정을 두 번 하지 않게).
- **세션 표면 심화 파도**: **E**(Trajectory — LIVE-5b의 세션 표면 작업과 연접, fork 의미론 ADR 선행).
- **플랫폼 확장 overlay 개장 시**: **G**(생태 청사진 — 지금은 본 문서가 청사진).
- **기존 로드맵과의 우선순위**: LIVE-5(기결정)>A/B/H(위생급 병렬 가능)>C/D>E/F/G. **dsh 차용이 LIVE-5·환경 폐곡선을 밀어내지 않는다** — 상보 편입.

### 결정 큐 (성재)
1. §5 순서 승인/조정 (기본=위 권장으로 진행).
2. E(Trajectory fork/resume)의 야심 수준 — 1단계(read-only replay)만 먼저 vs 2단계(fork=새 run 파생)까지 한 축으로.
3. G 개장 시점은 기존 플랫폼 확장 overlay 결정에 종속(신규 결정 아님 — 확인만).

## §6. 미확인 항목 (추측 금지 유지)

플러그인 단위 권한 매니페스트 존재 여부·공식 거버넌스 체계·V4-Pro 가격 세부·정확한 첫 태그 시각. E/G 착수 전 재확인 대상.
