# 핸드오프 패킷 — CubeSandbox provider 어댑터 (ADR-0156 D4-③, 1워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신 · 워커=단발 Opus 무명 · 발주 전 랜딩분 대조 완료(cubesandbox 어댑터 코드 0 — registry에 byoc·mock 2종뿐) · 중간 보고 없음
- 정본: **ADR-0156**(D2 합류·D6 계약 결정 2건) · ADR-0142 D2(어댑터 계약=ADR-0140 D4 표면) · ADR-0140(D2 advisory 락·D4 provider_missing) · **매핑표 `research/2026-08-08-cubesandbox-requirements-adapter-mapping.md`**(필드 수준 대조·blocker 2·capability 초안 — 이 문서가 구현 명세다)
- 전제: **실 CubeSandbox 호스트 불요** — fake 상류(문서화된 동작을 복제한 in-process HTTP 더블)로 검증. 실기동 대조는 D4-②(전용 호스트 후 별도).

## 과업
1. **`cubesandbox` provider 어댑터** (`momo-t3/src/provider/cubesandbox.rs`): 매핑표의 경로/상태코드/헤더(`X-API-Key`) 그대로 — 폐기된 `E2BProvisioner.swift`(git `716ea9e3^`)가 경로 4/4 일치 참조물(Swift→Rust, 재활용은 참조 수준). 신규 4가지: probe·멱등 재구성·lifecycle 정책·409/503 처리.
2. **Blocker 해소 2** (매핑표 §해법 그대로):
   - 멱등: 공개 API에 idempotency 부재 → 생성 시 `metadata`에 우리 provision UUID 각인 + `GET /sandboxes?metadata=` 재구성, 잔여 경합은 ADR-0140 D2 advisory 락. red proof: 재구성 제거 시 이중 생성 재현.
   - probe lossy: 비Paused→`running` 접힘 → **`running`을 liveness 증거로 쓰지 않는다**(주석+단정으로 계약화 — workd 하트비트 정본, ADR-0156 D6②).
3. **capability 선언** (초안 그대로): `supportsPause: true` · resume=`.memory` · `continuousRuntimeLimitSeconds: None`(24h 천장 없음) · `pauseSecondsPerGiB: 0.2`(실측 370.8ms/2GiB) · **`maxConcurrentInstances`=설정 주입**(env `MOMO_T3_CUBE_MAX_INSTANCES` 류, 기본값 보수적 — ADR-0156 D6①, ADR-0142 D2 증보 한 줄도 이 PR에서).
4. **lifecycle 정책**: 생성 시 `timeout`=sweep 주기×4·`onTimeout: kill`(D6② — 미지정 기본 kill이 원장 몰래 죽이는 것 방지). `secure` no-op·`imageRef`=템플릿 ID 의미 차이는 주석으로 계약화.
5. **registry 등재**: `cubesandbox` id 추가(retired `e2b` 단정 불변). 설정에 API 엔드포인트·API 키(운영자 시크릿 — ADR-0004 동형: 워크스페이스 비노출) 주입.
6. **fake 상류**: 문서화된 동작 복제(서버 생성 `request_id`·metadata 조회·lossy probe·pause/resume·kill·idle timeout) — mock-a/b와 별개(그들은 E2B 유래 수치). conformance는 mock 스위트 동형 + cubesandbox 고유(멱등 재구성·lossy probe·timeout 정책).

## 함정
- 정책 코드가 CubeSandbox 상수를 알면 안 된다(ADR-0142 — 전부 capability/설정 뒤로). E2B 유래 mock 수치(`pauseSecondsPerGiB: 4`) 복붙 금지.
- ADR-0140 D4 표면 밖 연산(CubeSandbox가 추가로 주는 것) 소비 금지 — 표면 확장은 별건 ADR.
- 동결층 불변·시크릿 커밋 금지.

## 검증
cargo workspace+clippy(-D warnings)+실DB 인접 무회귀(t3 lifecycle·work_control_spawn) · 신규 conformance(fake 상류) · red proof ≥3(멱등 재구성 제거→이중 생성 · lossy probe를 liveness로 오용하는 코드 주입→단정 빨강 · timeout 미지정→기본 kill 함정 재현) · 병합 트리(7레인). PR "Closes #1177 어댑터 축"(이슈는 D4-② 실기동까지 열어둠 — 본문 명시)·`## 계획 이탈` 절·STOP(머지 금지).
