# Wave C1·C2 머지 전 리뷰 보고서 (ADR-0134·0135 양층)

- 일시: 2026-07-26, 요청: 성재("머지하기 전에 한번 더 리뷰만 해줘"). 오케스트레이터: Fable.
- 대상: `origin/main...origin/track/uxui`(55파일 +10,042) + `origin/main...origin/track/engine`(43파일 +9,902). 티켓 MOMO-621~628.
- 방법: 시험 머지 워크트리(`trial-merge`) 생성 후 ①오케스트레이터 전체 게이트 ②4개 관점 병렬 리뷰(계약 드리프트·엔진 불변식/보안·머지 후 실동·유출 잔재) ③핵심 주장은 오케스트레이터가 개별 재현.
- **판정: 현 상태 머지 반대.** 아래 3건 선수정 + 1건 티켓 후 머지.

## 0. 기계 검증 (오케스트레이터 실측, 시험 머지 트리)

파일 충돌 0 · 마이그레이션 43개 유니크 · swift build 0 · server 324 tests · worker 86 tests · 웹 typecheck 0 · 웹 827 tests · gate:shell PASS · design preflight 10/10 · adapter python OK.
→ **빌드·테스트만으로는 아무 문제가 안 보인다.** 아래 결함들은 전부 게이트를 통과한 채 존재한다.

## 1. 머지 전 선수정 (3건)

### B-1 (Blocker, 보안) — 어댑터 로그 마스킹이 bearer 첫 글자만 지운다
`adapters/hermes/provider_chain.py:99` — `re.compile(r"(?i)\bbearer\s+\S")`. `\S`가 **한 글자**.
오케스트레이터 실행 결과: `Bearer sk-proj-AbCdEf…` → `[redacted]k-proj-AbCdEf…`. 게다가 소비된 그 글자(`s`) 때문에 후속 `\bsk-` 패턴이 매칭을 놓쳐 **1차 패턴이 2차 방어를 파괴**한다.
테스트가 이를 인증한다: `assertNotIn(PRIMARY_BEARER, ...)`는 원문 전체가 없어 통과 — `[1:]`은 그대로 남는다.
도달성: `QuotaProbeScheduler` 기본 활성이나 체인 생산자가 아직 없어 **격발 직전**. ADR-0135 D3 배선 시 코드 변경 없이 유출 시작.
**수정**: `\S` → `\S+`, 접두사 패턴 우선 적용, 테스트에 `PRIMARY_BEARER[1:]`·접두사 없는 토큰 케이스 추가.

### D1/F3 (Blocker, 기능 무효) — 캐스캐이드 안내가 구조적으로 렌더 불가
두 리뷰어가 독립적으로 같은 결론.
- 웹 `cascadeModel.ts:146`: `props.schema === "momo.agent_gateway.timeline.v0"`일 때만 앵커.
- 워커 `WorkerService.swift:2319 finalMessageProps`: `{run_id, source:"agent_worker.final_text.v0", …}` — **`schema` 키 없음**.
- 그 리터럴의 유일한 writer는 `AgentGatewayRoutes.swift:1521`(게이트웨이 콜백), `provider.cascade.fallback`의 유일한 emitter는 워커, 그리고 워커 클레임은 `AND method <> 'gateway'`로 게이트웨이 잡을 배제.
→ **캐스캐이드가 일어나는 턴은 정의상 웹이 요구하는 스키마를 가질 수 없다.** ADR-0135 D1이 금지한 "조용한 전환"이 뒷문으로 성립.
엔진층은 건전함이 실측으로 확인됨(실제 폴오버 재현: 워커 로그·audit_log 행·outbox 브로드캐스트 페이로드가 웹 기대와 완전 일치).
왜 게이트가 못 잡았나: 유닛테스트·스크린샷 캡처가 **둘 다 게이트웨이 스키마 턴을 손으로 만들어** 넣는다.
**수정**: `turnRecordRunId`가 `props.source === "agent_worker.final_text.v0"`도 수용(중복 제거 근거 보존) + **발신 코드에서 유도한 픽스처**로 테스트.

### F1 (High, 이번 머지가 새로 도달 가능하게 만듦) — 상속 줄이 서버가 버리는 모델을 "적용 중"이라 말한다
실측: 프로필 `modelPref=hermes-fast` 저장 → PUT **200** → 멘션 run 감사행 `resolved_model=hermes-agent`, `ignored_model_pref=hermes-fast`. 웹은 `hermes-fast (source=profile)`로 표시.
- 쓰기 시점 `AgentProfileValidation.validate`(`AgentProfileRoutes.swift:364`)는 **길이만** 검사(허용목록 미검사) → 200.
- 실행 시점 `MessageRoutes.resolveProfileModel:1718`이 허용목록 밖이면 **조용히 baseModel로 대체**.
- 웹 `routingModel.ts:241`에 `ignoredEffortPref`는 있으나 **`ignoredModelPref`가 없다**(DTO도 미제공).
**신규 도달경로인 이유**: `modelOptions`가 피커 목록을 effort 표에서 뽑는다. 머지 전엔 표가 404라 `agent.model` 하나만 떴다. 이제 4종이 뜨는데 워크스페이스 허용목록은 1종.
**수정(택1)**: ①프로필 PUT이 허용목록을 검사해 400(컴포저와 대칭) ②`modelOptions`를 허용목록 교집합으로 제한 ③DTO에 `ignoredModelPref` 추가 후 웹이 무음 폐기를 표기. **①+②를 권고**(F2도 함께 해소).

## 2. 머지와 함께 티켓 (1건)

### B-3 (Blocker급 위험, 기존 계층 상호작용) — propagate/content_already_emitted가 재큐잉에 뭉개짐
`WorkerService.swift:552-557`이 모든 실패를 문자열 `sawError`로만 받아 구분 없이 `requeueJob`(최대 8회). 4xx 즉시 전파가 8회 재시도 후 ~4분 지연이 되고, 캐스캐이드가 올바르게 거부한 `content_already_emitted`가 재실행으로 부활한다.
증폭: 9 hop × 2(B-2 논스트림 재시도) × 8(재큐잉) = **최대 144 업스트림 요청·36분 점유**. 실패 턴은 `usage == nil` → 토큰 0 → **G5 예산 차단기가 트립하지 않는다**. 체인은 instance-global이라 아무 멤버나 멘션으로 운영자 자격증명을 소진시킬 수 있다.
관련 B-2(`HermesTransport.swift:70-89`, 이번 diff 밖 기존 코드): 모든 스트림 실패에 같은 hop으로 논스트림 재요청 → 이미 흘린 조각 + 전체 답변이 합쳐져 **최종 커밋 본문 오염**.
**최소 포함 권고**: `propagate`·`content_already_emitted`를 `markJobFailed`로 분기, 캐스캐이드 총 예산 도입. 논스트림 재시도 조건화는 별도.

## 3. 후속 티켓

| 항목 | 요지 |
|---|---|
| H-1 (High) | 워크스페이스 admin이 `provider:quota:write`를 자가 발급 → **인스턴스 전역** quota_snapshot 오염(전 워크스페이스 게이지). 스코프 부여를 운영자 경계로 승격 또는 출처 감사 컬럼 |
| F2 (Med) | 컴포저도 같은 목록에서 확정 400 나는 모델 제안 + 서버 영문 원문 노출 |
| F5 (Med) | "리셋 지남"만 브라우저 시계 기준 → 나이 줄과 자기모순. 서버 `observedAt`를 파싱만 하고 안 읽음 |
| M-1 (Med) | 041 CHECK가 `NOT VALID` 없이 붙어 배포 중 `usage_ledger` 쓰기 전면 정지 위험 |
| M-2 (Med) | 자격증명 형상 하한이 주석 24 vs 코드 32 불일치 → 31자 이하 시크릿이 `provider_ref`로 저장·전 멤버 조회 |
| M-6/M-8 (Med) | Python만 408·425 폴백(ADR 위반) / HTTP 200+에러봉투가 조용한 무응답 턴 |
| F4 (Med) | 복호화 실패 홉을 `compactMap`으로 버리는데 신호 없음 → 다음 PUT이 그 행·암호문 영구 파괴(키 로테이션 시) |
| D2/M-9 (Med) | `openapi.yaml`이 ADR-0134/0135 미반영(`routing`·신설 6경로·`AgentProfile.effortPref`), shape 게이트 사각지대 |
| D3 (Med) | 어댑터가 `resets_at` 없는 스냅샷을 통째로 폐기 — 서버·스키마·웹은 셋 다 null 지원 |
| F6 (Low) | `ageSeconds` 결측 시 0("방금 전")으로 낙관적 기본값, schema 버전 트립와이어 없음 |

## 4. 별건 발견 — iOS 메시지 전송이 main에서 이미 깨져 있다

`clients/iOS/MomoiOSKit/.../MomoServerConversationClient.swift:776`이 `client_msg_id`(snake) 전송, 서버는 `clientMsgId`(camel, non-optional) 요구 → **main에서도 400**. PR #478/#479 이래 존재. iOS에 라이브 와이어 게이트가 없어(빌드+유닛만) 미검출.
이번 closed-world 전환은 상태코드 동일·문구만 변경(신규 장애 아님).
부수: `DTOs.swift:117-120` 주석이 "iOS도 이 키들만 보낸다"고 단언 — **사실과 다름**, 수정 필요.
→ **티켓 2장**: iOS 전송 키 수정 / iOS 라이브 와이어 게이트 신설.

## 5. 웹 백스크린 6건 (전부 main 기존, 이번 회귀 아님)

`lib/http.ts:83`의 검증 없는 캐스트가 뿌리. react-query가 `undefined`는 막지만 **`null`은 통과** — Vapor Optional·PG JSON이 정확히 보내는 값이다.
`AiLinkSection.tsx:229`(diagnostics) · `WorkHostSection.tsx:398,737` · `settings/model.ts:175,455` · `InviteSection.tsx:157` — 각각 `null`/정크 응답에 설정 화면 전체 백스크린(rootChildren=0) 재현됨.
특기: `AiLinkSection`은 818이 만진 파일이고 같은 컴포넌트 179행은 `parseProbeEntries`로 방어돼 있다 — **교훈이 파일 하나 안에서 절반만 적용**됐다.
→ **티켓 1장**: `lib/wire.ts` 공용 검증 헬퍼 + 언랩 지점 일괄 통과(`workHosts`·`invites`·`workTierPolicy`·`read_states`·`approvals`·roster 행).

## 6. 확인된 안전 항목 (근거 있음)

- **필드 계약 3쌍 완전 일치** — 웹이 ADR만 보고 쓴 픽스처가 엔진 실구현과 키·타입·케이싱·널러빌리티 모두 맞음. 위험했던 자리들(REST=camel/이벤트=snake 이중 규약, `disposition`의 `fall_over` 밑줄, `window` 와이어 키 vs `quota_window` 컬럼, ms/초·ratio/percent)까지 전부 일치.
- **엔진 표면이 실제로 켜짐** — 시험 스택(소스 컴파일, api+relay+worker 기동) 후 세 라우트 401(기존 momowebqa는 404). 626 프로필 저장 왕복·627 체인 CRUD·실제 폴오버 재현·628 ingest→게이지 값 대조 전부 PASS.
  - **검증 한계(명시)**: 브라우저 자동화 불가(Chrome 확장 미연결, 헤드리스 툴 호스트 해석 실패)로 **렌더된 DOM은 미검증**. 대체로 라이브 서버 응답을 실제 웹 모델 함수(`parseEffortTable`·`chainModel`·`quotaModel`·`resolveInheritance`)에 통과시켜 "화면이 말하게 될 문자열"을 대조했다 — 계약 검증으로는 스크린샷보다 강하나 컴포넌트 조립·포커스·키보드는 확인되지 않았다.
  - 그 외 미검증: F4(키 로테이션 미수행), F3의 "카드가 안 뜬다"의 렌더 확인(목 hermes가 워커 resume 불가 툴을 요구해 워커 턴이 최종 메시지로 정착하지 않음 — 다만 관측된 모든 워커 메시지에 `schema` 부재, 코드 경로 일의적).
- **ENGINE_HANDOFF 재확인 3종 충족** — 400이 트랜잭션 이전·문구가 `routing`을 호명·rootId 조회보다 앞.
- **SendMessageRequest closed-world 신규 장애 없음** — 1st-party 발신자 전수 대조(iOS만 기존 결함).
- **마이그레이션 041/042/043 안전** — 전부 additive, NOT NULL 없음, RLS FORCE 적용, 롤백 불가 변경 없음, 싱글톤↔체인 이중저장 구조적 불가(`CHECK position >= 1` + PUT 0 거부).
- **quota ingest 스크리닝 견고** — 중첩 객체·배열·따옴표 숫자·NaN·별칭 중복·재생 전부 차단(우회 경로 미발견).
- **단일 쓰기경로 유지** — 캐스캐이드 감사행이 audit_log+outbox 한 트랜잭션, 신규 Centrifugo 직접 publish 0건.
- **818 랜딩본 온전** — 유출 사고 후 14파일 바이트 대조 + 적대적 응답 33종 주입, 새 파서 전부 방어.
- **웹 품질** — `any`/`@ts-ignore` 0건, 임시파일 0건, 동어반복 테스트 없음.

## 7. 파이프라인 교훈 (다음 배치에 반영)

1. **픽스처는 ADR이 아니라 발신 코드에서 유도한다.** D1/F3가 정확히 이 실패다 — 필드는 다 맞았는데 "어느 행에 붙는가"가 어긋났고, 테스트·스크린샷이 둘 다 손으로 만든 턴을 썼기에 초록불이었다.
2. **웹/엔진 병렬 구현 시 계약 대조를 별도 관문으로 둔다.** 이번엔 리뷰에서 잡았지만 티켓 수용기준에 없었다.
3. **"기존 코드라 무관"을 그대로 넘기지 않는다.** B-2·B-3의 하부는 기존이지만 증폭 9배는 이번 변경 몫이다.
4. 워커 cwd 오염(818→819) 재발 방지: spawn 프롬프트에 `git status` clean 선검사.
5. 서브에이전트 프롬프트에 **자격증명 탐색 금지**를 명시(이번 배치에서 QA 계정 대상 추측 시도 1건 발생, 우리 자산이라 피해 없음).
