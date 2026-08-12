# ADR-0163: 관리형 에이전트 카탈로그 — 셀프호스트 동봉·버전 원장·개별 업데이트

- Status: **Proposed · deferred** (2026-08-12 #1343 검수 교정 — 현재 `Bring your hosted agent` 런칭 게이트에서 제외)
- Decision owner: 성재
- 관련: ADR-0100(결정 거버넌스), ADR-0102(worker=managed / gateway=BYOA), ADR-0121(셀프호스팅), ADR-0130(ACP·`work_tool_profile`), ADR-0135(provider chain), `docs/planning/2026-08-10-opensource-selfhost-plan.md`
- 구현 조건: 본 ADR의 별도 승인과 셀프호스트 기반선 재검증 전에는 카탈로그·동봉·업데이트 구현을 발급하지 않는다.

## 검수 결론

이 제안은 제품 가치가 있지만, 사용자가 이미 다른 서비스에서 호스팅하는 에이전트를 oort에 연결하는 `Bring your hosted agent`와는 수명주기·신뢰 경계·운영 주체가 다르다. 따라서 현재 런칭 축의 선행조건으로 묶지 않는다.

- **현재 런칭 축:** 외부 hosted agent가 oort에 일회성 페어링하고, 자기 런타임에서 oort inbox와 기존 agent gateway 계약을 소비한다. oort는 외부 런타임을 설치·업데이트하지 않는다.
- **본 ADR의 별도 축:** oort 셀프호스트 배포판이 큐레이션한 adapter/runtime를 운영자 호스트에 설치하고 버전 수명을 관리한다.
- **ACP 축:** 로컬/호스트 코딩 에이전트 세션 전송 규격이다. 카탈로그와 같은 테이블이나 같은 구현 티켓으로 합치지 않는다.

## Context — 2026-08-12 코드 대조로 교정된 사실

1. 셀프호스트 계획의 #1227~#1229 범위는 최초 소유자 부트스트랩·compose/단일 이미지·time-to-hello다. 관리형 에이전트 카탈로그와 개별 adapter 업데이트 수명주기는 그 계획에 명시돼 있지 않다.
2. `server/Migrations/029_work_tool_profile.sql`과 Rust `momo-t3`에는 **`work_tool_profile` 원장과 fail-closed 조회가 이미 존재한다.** “server-rust에 원장이 없다”는 종전 초안의 진술은 틀렸다.
3. `workers/WorkHostDaemon/Sources/MomoACPHost`에는 ACP client/adapter 구현과 테스트가 존재한다. 다만 이 코드는 은퇴 예정 Swift 트리이며, **현행 Rust-native work-host 구현이 완결됐다는 뜻은 아니다.** Rust 서버에는 work session/control과 서명된 ACP event ingestion 일부가 살아 있으므로, 실제 이식 잔여는 #1345에서 코드·런타임 기준으로 다시 잰다.
4. `work_tool_profile`은 “어떤 host-local 도구를 어떤 portable launch template로 실행할 수 있는가”를 정한다. 관리형 설치본의 이미지·catalog revision·업데이트 결과를 기록하는 원장이 아니므로 카탈로그와 의미가 다르다.
5. `adapters/`, provider chain, agent member/profile은 카탈로그의 재료지만, 설치·health·버전 비교·롤백 계약은 아직 별도 제품 경계다.

## 제안하는 결정 (아직 미승인)

### D1. 레포 동봉 카탈로그를 공급망 정본으로 둔다

권고안은 레포에 검토 가능한 manifest를 두고 릴리스에 함께 싣는 방식이다. 최소 항목은 다음과 같다.

- 안정된 `catalog_key`, 표시명과 설명
- digest로 고정한 adapter/runtime artifact와 permissive license 근거
- 지원하는 서버 버전 범위와 schema/config revision
- 필요한 provider 종류와 설정 키의 **이름만**; credential 값은 금지
- 기본 agent profile과 health probe 계약
- upgrade/rollback note 링크

서버가 임의 원격 카탈로그를 실행 중에 받아 실행하지 않는다. 원격 marketplace와 서드파티 자동 설치는 별도 보안 결정이다.

### D2. 초기 설정에서는 선택 설치를 제공하되, 에이전트 0개 시작을 1급 경로로 둔다

셀프호스트 운영자는 소유자 부트스트랩 뒤 카탈로그 항목을 고를 수 있다. 선택은 adapter 컨테이너/profile과 agent identity를 함께 준비하되 provider credential은 oort 서버에 넣지 않고 기존 provider-link 경계를 따른다. 설치하지 않고 메신저만 시작하는 경로도 동일하게 지원한다.

### D3. 설치본 원장은 `work_tool_profile`과 분리한다

설치본에는 최소 `catalog_key`, artifact digest, installed catalog revision, health 상태, 마지막 성공/실패 update, rollback target을 기록한다. `work_tool_profile`은 도구 실행 정책으로 유지하고, 한 관리형 에이전트가 host tool을 제공할 때만 stable key로 참조한다.

한 테이블로 합치면 “disabled tool”과 “중지된/낡은 adapter 설치본”이 같은 상태처럼 보이고 권한 경계가 흐려지므로 금지한다.

### D4. 업데이트 실행 주체는 `v0=안내`, `v1=최소권한 host helper`를 우선 검토한다

- **v0 권고:** 관리 화면은 현재/목표 digest, 검증된 명령, migration note, rollback 명령을 보여준다. 실행은 운영자가 호스트에서 한다. 실제 health/version 보고가 돌아오기 전에는 성공으로 표시하지 않는다.
- **v1 후보:** 별도 host helper가 서명된 update intent를 읽어 pull/restart/health/rollback을 수행하고 결과만 회신한다. helper의 명령 allowlist와 artifact digest 검증은 별도 ADR/위협모델 대상이다.
- **기각 권고:** 제품 서버에 Docker socket을 마운트해 임의 pull/restart 권한을 주는 방식. 서버 침해가 곧 호스트 장악이 된다.

### D5. 외부 hosted-agent 연결과 결합하지 않는다

Grok Bot 같은 외부 hosted agent는 oort가 artifact·버전·업데이트를 소유하지 않는다. 해당 연결은 ADR-0162의 pairing/credential/cleanup lifecycle만 따른다. 카탈로그에 Grok Bot 설치 항목을 만들지 않는다.

## 승인 전 열려 있는 질문

1. 셀프호스트 기반선(#1227~#1229)의 실제 랜딩 상태와 compose ownership을 어느 시점 기준으로 삼을지
2. artifact signing·SBOM·license attestation을 어느 릴리스 파이프라인이 발급할지
3. adapter가 보고하는 version/health를 어떤 서명 identity에 묶을지
4. v1 host helper의 명령 allowlist·권한·업데이트 실패 복구 계약
5. 카탈로그를 first-party 항목만 허용할지, 검토된 third-party 항목까지 열지

## Consequences

- (+) 셀프호스트 운영자가 “clone → 에이전트 선택 → 검증된 업데이트”를 한 제품 흐름으로 이해할 수 있다.
- (+) `work_tool_profile`, ACP, 외부 hosted-agent pairing의 서로 다른 경계를 보존한다.
- (+) v0에서 서버 Docker socket 없이도 버전 가시성과 안전한 수동 update loop를 먼저 검증할 수 있다.
- (−) 이미지 빌드·서명·호환성·롤백을 지속 관리해야 하는 공급망 운영 비용이 생긴다.
- (−) 실제 설치 자동화와 개별 업데이트 버튼은 셀프호스트 기반선과 host helper 결정 없이는 닫히지 않는다.

## 별도 축의 승인·검증 조건

본 ADR을 다시 편성할 때 다음 증거가 먼저 필요하다.

1. 현재 셀프호스트 배포판을 새 기계에서 문서대로 기동한 clean-room evidence
2. first-party adapter 한 종의 digest 고정 설치→health→수동 update→rollback 실증
3. server compromise가 host control로 번지지 않는 threat model
4. permissive license/SBOM/NOTICE gate
5. 실패나 version mismatch를 “최신”으로 위장하지 않는 red proof

이 조건은 현재 hosted-agent launch의 완료 조건이 아니며, #1343에서 구현 이슈를 발급하지 않는다.
