# ADR-0146: 행동 provenance 서명 (buzz에서 선택 차용)

- Status: **Accepted** (2026-07-31 성재 “권고대로 진행” — 범위=3표면 + 세부 3결정 확정. 기안 Fable)
- **확정된 세부 3결정(2026-07-31)**: ①서명 페이로드 = 정규화 content+author, 서버 부여 seq는 2단계(행위자가 content 서명 → 서버가 seq 부여 후 envelope) ②행위자 단계 = **에이전트·workd 먼저**(키 보유·즉시), 사람은 device 키 결속 후 fast-follow ③UX = **초기 감사 로그·API 전용**(UI 뱃지 없음 — 부분 서명기의 “무서명=미검증” 오독 방지), 사람 서명까지 차면 뱃지 도입.
- 관련: **ADR-0145**(Rust/Axum 재작성 — 이 서명은 그 위에 얹힌다), ADR-0004(자격증명 비유입), ADR-0101(에이전트 신원), ADR-0139/0140(workd — 이미 Ed25519 서명 보유), `docs/architecture/invariants-in-rust.md`(D2 — 이 서명이 불변식을 안 건드림을 교차검증)
- 발단: 서버 스택 재검토에서 "oort가 buzz에서 취할 만한 한 가지 = 에이전트 행동의 암호학적 provenance"로 식별 → 성재가 B안에 포함 지시 + **범위를 "상태 전이까지 넓게"로 결정**.

## 맥락

buzz(Nostr)의 최대 강점은 **모든 행동이 서명된 이벤트 = 위·변조 내성 감사추적**이다. "이 행위자가 정말 이걸 했나"가 서버 로그 신뢰가 아니라 **서명 검증** 문제가 된다. oort는 Nostr 모델 전체(클라-서명-publish·created_at·RLS 부재)를 못 받지만(ADR-0145 스파이크), **이점 조각만 additive하게** 취한다 — oort는 이미 workd가 Ed25519로 서명하므로 신규 암호 스택 불요.

## 결정 (범위 확정)

**서버-authored 단일 쓰기경로·RLS FORCE·gapless seq를 하나도 바꾸지 않고**, 행위자에게 귀속되는 행동에 Ed25519 서명을 **검증 가능한 provenance 메타데이터로 additive하게** 부착한다. 범위 = **세 표면 전부**(성재 결정):

1. **메시지** — 행위자가 보낸 `message` (`momo-messaging`).
2. **작업 이벤트** — workd 실행 결과·작업 이벤트 (`momo-t3`, workd 서명키 재사용).
3. **상태 전이** — 감사 민감 행동: 권한 부여, 리뷰/승인 결정, 위계 변경 등 (`momo-t3`·`momo-integrations`).

## 불변식과의 관계 (D2 교차검증 — 재작성이 못 깨는 것)

| D2 불변식 | 이 서명이 미치는 영향 |
|---|---|
| 단일 쓰기경로 | **불변.** 서명은 서버 우회 publish 권한을 주지 **않는다**(buzz와 정반대 지점). 흐름 = 행위자가 서명 assertion 제출 → 서버가 검증 → **서버가 여전히 유일 저자로 row write** → 서명은 사이드카에 저장 |
| gapless `message.seq` | **불변.** 서명은 authenticity만, 순서 무관. 서버-부여 seq/id는 서명 후 붙으므로 2단계(행위자가 content 서명 → 서버가 seq 부여) |
| RLS FORCE | **불변.** 서명 사이드카도 동일 테넌트 RLS 아래 |
| provider 비유입(ADR-0004) | **불변.** 서명키 = 행위자 신원키(agent/workd/device)이지 provider 자격증명 아님 |

## 설계 (범위 확정에 따른 5개 항목 해소)

1. **대상 범위** → 위 세 표면 전부(넓게).
2. **서명자 모델(행위자 유형별)**:
   - 에이전트 → 에이전트 신원키(member 결속, `AgentCredential`/`AgentCard` 경로 활용).
   - workd → 기존 workd Ed25519 키(`Signing.swift` 포맷 확장).
   - **사람 → device 키**(`DeviceRoutes` 존재) — **유일한 선행 의존**. 사람 행동 서명은 device-key 결속이 필요하므로, **에이전트·workd 행위자는 즉시 적용, 사람 행위자는 device 키 배선 후 fast-follow**(범위는 넓게 확정, 사람분만 단계적). 이 phasing이 "무서명 공존"을 만든다 → nullable.
3. **저장 → 사이드카 테이블 `action_signature`** (신규 마이그레이션 060+, append-only·기존 스키마 불변). 세 표면이 여러 테이블에 걸치므로 표별 nullable 컬럼보다 `(entity_type, entity_id, signer_member_id, signer_pubkey, signature, signed_payload_digest)` 사이드카가 넓은 범위에 확장성 우위. 테넌트 RLS FORCE.
4. **검증 경로 → 쓰기시 chokepoint 검증**. `momo-wire`가 표면별 정규 서명 페이로드 정의, 공유 헬퍼 `record_provenance(tx, entity_ref, signer, signature)`(= provenance판 `emit_outbox` chokepoint)가 서명 검증 후 사이드카 write. 검증 실패 = 거부. 사후 재검증 가능(감사).
5. **UX 표면** → 에이전트/서명된 행동에 "서명됨(검증됨)" 표식 + 감사 로그. **부분 서명 위험**: "서명됨 vs 무서명" 공존이 오히려 신뢰를 흐릴 수 있으므로, 표식 규약을 ux-bible과 조율(무서명이 "미검증"으로 오독되지 않게). D3 상세에서 확정.

## Consequences

- (+) 세 표면 전반의 암호학적 감사추적 — 자체호스팅 조직이 "누가/어느 에이전트가 뭘 했나"를 서버 신뢰 없이 검증.
- (+) Nostr 전체를 받지 않고 이점만 — 불변식 무손상(위 표).
- (+) 공유 chokepoint(`record_provenance`)로 교차 관심사를 구조화 — `emit_outbox`와 대칭.
- (−) **B1 범위 팽창**: provenance가 교차 관심사(messaging·t3·integrations 전부) → 공유 프리미티브는 B1, 각 도메인의 서명 emit은 해당 배치에 분산. 계획 반영 필요.
- (−) 서명/검증 오버헤드, 키 관리 표면(특히 사람 device 키) 추가.
- (−) 무서명 레코드 공존의 UX·신뢰 모델 명확화 부담.

## 미해결 (D3 상세 설계)
- 표면별 정규 서명 페이로드 바이트 정의(재생·위조 경계).
- device-key 결속(사람 행위자) 배선 시점(B1 내 vs fast-follow).
- "서명됨/무서명" UX 표식 규약(ux-bible).
- → 확정 후 성재 최종 Accept.
