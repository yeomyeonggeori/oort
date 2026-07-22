# momo 오픈소스 공개 — 법무 검토 패키지 (2026-07-22, momo-main)

> 목적: 성재가 법무에 전달할 공개 전 검토 자료 일체. 기술 검증은 완료 상태이며, 법무 확정 필요 항목은 §5.

## §1. 라이선스 선택: Apache-2.0 (LICENSE 배치 완료)

- 선택 근거: ①특허 조항(§3 특허 라이선스 부여+보복 조항) — 에이전트/메신저 도메인의 방어 가치 ②기업 채택 마찰 최소(permissive) ③생태계 정합: 직접 의존 37종 중 29종이 Apache-2.0(Swift 서버 생태계 표준), eve·Mastra 등 비교 대상 프레임워크도 Apache-2.0 ④AGPL 백본 금지 원칙(프로젝트 초기 결정)과 일관.
- 대안 검토: MIT(특허 조항 부재로 기각), BUSL/Elastic(오픈소스 아님 — LangGraph 서버 런타임의 상용 락이 채택 마찰을 만드는 반례 확인, research/20-01 §1-A 참조).

## §2. 의존성 감사 (2026-07-22 실측 — legal/THIRD_PARTY_NOTICES.md 재생성 완료)

- Swift 직접 의존 37종 전수: **Apache-2.0 29 + MIT 8, GPL 계열 0, 미확인 0** (Package.resolved 5개 매니페스트 + .build/checkouts LICENSE 원문 판독).
- npm 웹 런타임 의존 3종(react, react-dom, centrifuge): 전부 MIT.
- 인프라 컨테이너(별도 배포물 아님 — compose 참조만): PostgreSQL(PostgreSQL License), Centrifugo(Apache-2.0 v5 계열 확인 필요 시 §5), Caddy(Apache-2.0), LiveKit(Apache-2.0).
- NOTICE 오기 1건 정정: postgres-nio는 Apache-2.0가 아니라 **MIT**(실측).

## §3. 시크릿/이력 스캔

- gitleaks 전체 이력 878커밋 스캔: 탐지 33건 **전수 수동 판정 — 실 유출 0건**(privateKey 변수 선언 8, 내부 subscribe-proxy URL 17, 게이트 fixture 8). **이력 재작성 불요.**
- 운영 시크릿은 env/키체인 주입 원칙(ADR-0004) — 코드/이력에 자격증명 없음.

## §4. 공개 범위·배포 채널

- 공개 대상: 모노레포 전체(서버·클라 3종·워커·어댑터·infra compose·docs). `schema_v0.sql` 포함(스키마는 마이그레이션 정본과 함께 공개).
- 컨테이너 배포: ghcr.io/dawn-kim-official (publish-images.yml 기성 — 수동 dispatch, 공개 시점에 태그 정책 결정).
- 공개 1급 데모 자산: examples/eve-momo-channel·cloudflare-agent-momo (MOMO-534 랜딩) — README 배치 권고.

## §5. 확정 사항 (성재 결정 2026-07-22 — 외부 법무 검토 없이 내부 확정)

1. **저작권자 표기 = "dawnkim" 유지** (성재 확정). 법인 전환 시 NOTICE 1줄 갱신으로 족함(과거 릴리스 소급 불요).
2. **DCO 채택** (성재 확정) — CONTRIBUTING.md에 DCO 1.1 서명 요구 명문화(구현 완료). CLA 없음.
3. **명칭 "momo" 유지** (성재 확정). 주의 고지: 상표 미등록 상태 — 제3자 동명 상표 리스크는 잔존하며, 제품 트랙션 발생 시 상표 출원을 재검토 항목으로 이월(공개 차단 사유 아님).
4. **Centrifugo: 사용 중인 v6 코어 = Apache-2.0 실측 확인**(2026-07-22, 저장소 LICENSE 원문). PRO 기능 미사용. 후속 권고: compose의 `centrifugo:v6` 플로팅 태그를 digest 핀으로(기존 postgres 핀 규율과 정합) — 릴리스 체크리스트 편입.
5. **NOTICE/THIRD_PARTY 유지 절차 확정**: ①의존성 변경 PR은 THIRD_PARTY 갱신 동반(CONTRIBUTING 명문화) ②릴리스 태그 전 §2의 재감사 절차(Package.resolved+checkouts LICENSE 판독) 1회 실행 ③GPL 계열 검출 시 fail-closed.

## §6. 잔여 기술 작업 (momo-main 큐)

- 공개용 README/SECURITY.md 초안 (별도 티켓 — CONTRIBUTING은 완료).
- **공개 릴리스 확정(성재 2026-07-22, buzz 계획 §2)**: 게이트=554 랜딩+리허설 Phase1 PASS. 레포(모노레포 전체)+이미지 동시 공개, README/SECURITY(MOMO-564) 전제. 체크리스트 4조건: (a) 이미지 내 LICENSE/NOTICE 동봉 (b) 공개 전 이미지 1회 시크릿·설정 스캔 (c) semver v0.x+latest=stable+digest 핀 (d) publish=workflow_dispatch 수동 유지. 법무 추가 검토는 공개 차단 사유 아님(§5 종결).
- 실배포 리허설 — **일정 확정(momo-main, 성재 위임 2026-07-22)**: 2단계.
  - **Phase 1 (로컬 실행분, ⑮ grant UI 랜딩+게이트 부채 배치 직후 착수)**: make_deploy_bundle→fresh VM급 환경에서 install.sh 경로·upgrade 경로·internal hosting smoke·backup/restore 리허설을 오케스트레이터가 일괄 실행(기존 verifier 체계 재사용, 신규 발견은 티켓화).
  - **Phase 2 (공개 호스트)**: 도메인+VPS 1대 필요 — Phase 1 완료 보고 시점에 성재에게 VPS/도메인 준비 요청(그때까지 성재 액션 불요). TLS(ACME)→web 서빙→초대 링크 실왕복→운영 런북 대조까지.
