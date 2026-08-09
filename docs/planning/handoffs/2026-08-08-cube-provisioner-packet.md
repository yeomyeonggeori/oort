# 핸드오프 패킷 — CubeSandbox 프로비저너 연동 (ADR-0156 D4-④, 1워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신(#1179 머지 후) · 워커=단발 Opus 무명 · 발주 전 랜딩분 대조 완료(#1179가 어댑터·registry까지 — 프로비저너 경로·notifier resolver는 미배선) · 중간 보고 없음
- 정본: ADR-0156(D4-④) · ADR-0136(프로비저너·크레딧 — provider 축만 0142로 개정, **크레딧·슬롯·부트스트랩 토큰 결정은 유지**) · ADR-0140(수명주기 게이트 T-2~T-4) · ADR-0142 D2 · #1179 PR 본문(Unwired("cubesandbox") 경계·이탈 절)
- 전제: fake 상류로 검증(실기동=D4-② 별건). **T3 기본 off 불변** — 이 배치는 배선이지 활성화가 아니다(활성화는 ADR-0140 게이트+실 smoke 후 별건).

## 과업
1. **프로비저너 경로 배선**: auto_target=cloud 세션 요청 → 프로비저너가 `cubesandbox` 어댑터로 create → workd 부트스트랩(ADR-0136의 부트스트랩 토큰 계약 유지 — provision UUID 결정적 파생·15분 TTL 계열 기존 문법) → 자기등록(type=cloud, Ed25519 등록 계약 그대로) → 세션 라우팅은 기존 로직. imageRef=템플릿 ID는 설정 주입(`MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF` — #1179 기존재 확인).
2. **notifier resolver**: `Unwired("cubesandbox")` → 배선(#1179가 테스트로 경계를 이름 붙여둠 — 그 테스트를 뒤집는 것이 시작점).
3. **설정 표면**: default_provider_id에 `cubesandbox` 유효값 합류(shared.rs의 UnknownProvider 판정 경로 — retired e2b 단정 불변). 크레딧/슬롯 소비는 ADR-0136 기존 결정 그대로(신규 결정 금지).
4. **conformance**: fake 상류로 프로비저닝 폐곡선(요청→create→부트스트랩→등록→라우팅→세션 201) + 실패 반쪽(create 5xx→이름 있는 실패·부트스트랩 TTL 만료·등록 불발 시 원장 상태). red proof ≥2(①부트스트랩 토큰 결정성 제거→재시도 이중 등록 재현 ②미활성 T3에서 경로 도달 불가 유지 — 활성화 게이트 무결).

## 함정
- ADR-0004: CubeSandbox API 키는 운영자 시크릿 — 부트스트랩 산출물·워크스페이스로 비유입(#1179 계약 유지).
- 단일 쓰기경로·RLS·동결층 불변. T3 활성화 조건(`MOMO_T3_ENABLED` 계열) 기본값 변경 금지.
- ADR-0136의 기존 마이그레이션·테이블 재사용 — 스키마 신설 최소(필요 시 이탈 절에 근거).

## 검증
cargo workspace+clippy(-D warnings)+실DB(t3 lifecycle·work_control_spawn·신규 폐곡선) 무회귀·red proof 실행 증거·병합 트리 7레인·lint 총계. PR "ADR-0156 D4-④ — #1177은 D4-② 실기동까지 오픈"·`## 계획 이탈` 절·STOP(머지 금지).
