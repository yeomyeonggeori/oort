# buzz급 런칭 진단 — 종합 (2026-08-10)

- 발제: 성재 — "오픈소스화·프로덕션화·단일 이미지 셀프호스팅·실제 buzz급 작업이 가능한지, 기준을 buzz로 두고 진단"
- 기준: **block/buzz**(Apache-2.0·star 25,483·PR CI 실가동·릴리스 주 2회급). "buzz급"은 아키텍처 모방이 아니라 **오픈소스 프로젝트 성숙도·런칭 가능 상태** 벤치마크(인터뷰 확정, S-10).
- 방법: 우로보로스 인터뷰(`2026-08-10-ouroboros-buzz-diagnosis-interview.md`) → 5축 감사 전면 병렬(무명 Opus 5기, 축별 전문 `2026-08-10-buzz-audit-{A..E}.md` 총 1,616줄). 전 주장 실측 근거 딸림.

---

## 0. 결론 한 문단

**오늘 buzz급 런칭은 불가능하다. 그러나 격차의 성격이 좋다.** 제품 코어는 실측상 건강하고(C: 클론→메시지 왕복 성공·불변식 왕복 검증·서버 풀빌드 76초 error 0 / A: 전 히스토리 2,029커밋에 진짜 시크릿 0·의존 1,902개에 copyleft 0 — **히스토리 재작성도 키 로테이션도 불필요**), 법적 하자도 없다. 격차는 거의 전부 **포장과 운영층**에 있다: 은퇴 스택을 가르치는 진입 문서(README는 2026-08-10 수리 완료), 커버율 1.9%짜리 라이선스 게이트, 레포에 커밋된 적 없는 라이브 compose 3파일, 문서에 없는 최초 소유자 생성 경로, `/metrics` 없는 라이브 바이너리, 백업 없는 프로덕션 PG, Rust를 한 번도 컴파일한 적 없는 CI. **코드를 다시 쓰는 일이 아니라 이미 있는 것을 포장·배선하는 일이다.**

## 1. 1층 — go/no-go (세 관문)

### 관문 ① 오픈소스 공개 (source-available) — **가장 가깝다**

| 판정 | 근거 |
|---|---|
| ✅ 히스토리 클린 | gitleaks 60건 전수 트리아지 → 진짜 시크릿 0 (A) |
| ✅ 라이선스 청정 | cargo 644+npm 1,258에 GPL/AGPL 0·미상 0, LICENSE/NOTICE 실재 (A) |
| 🔧 공개 전 정리 6종(반나절) | SECURITY.md 구 org 링크(공개 즉시 404)·비DNS IP 1·개인 Gmail 4곳·debug.keystore·`.gitleaksignore` 고정·NOTICE `TODO` (A) |
| 🔧 게이트 이설 | CONTRIBUTING의 "fail-closed" 약속 vs 실제 커버 1.9%(SwiftPM 37만) — **정책 위반 MPL 30건 실재**. 최단: `deny.toml`+npm 체크 이설+CI 잡 (A) |
| ⛔ 성재 결정 | 공개 범위(planning 266+research 112=378파일·실명 260파일) · 레포/org명 확정 |

### 관문 ② 단일 이미지 셀프호스팅 — **실공수 축**

| 판정 | 근거 |
|---|---|
| ⛔ 라이브가 레포에서 재현 불가 | compose 5 중 3(t3·caddy·cent-origin override)이 **어느 ref에도 커밋된 적 없음** — Caddyfile(#1217 회수)을 마운트할 주인이 레포에 없다 (B) |
| ⛔ "단일 이미지"가 유령 | `ghcr.io/...` 이미지 **발행 0회**(워크플로 실행 0), README가 존재하지 않는 태그 pin 지시 → 2026-08-10 README에서 철회 완료 (B·E) |
| 🔧 웹 SPA가 이미지 밖 | buzz는 web/dist를 이미지에 굽는다. **oort의 Swift 경로도 그랬다**(web-init) — Rust 전환에서 잃은 것. 복원 선례 있음 (B) |
| ⛔ 최초 소유자 생성 경로 문서 0 | seed fail-closed는 옳으나 탈출구 미문서 — 실패 시 **DB 파기 강제**. time-to-hello 최대 지연 원인 (C) |
| 🔧 온보딩 함정 | `CENT_API_URL` 기본값이 호스트 실행과 충돌 — REST는 되고 실시간만 조용히 죽음 (C) · `infra/rust/README` 첫 명령 exit 1(`PROVIDER_LINK_MASTER_KEY` 템플릿 누락) (B) |
| 참고 | 실측 time-to-hello **13분 24초**(기계 2.5분+진단 11분·임기응변 6회). buzz는 "명령 5개, You're in." — 격차는 성숙도가 아니라 **약속과 실제의 간극** (C) |

### 관문 ③ 프로덕션 운영 신뢰 — **가장 멀다 (PASS 0/13)**

| 판정 | 근거 |
|---|---|
| ⛔ 관측 0 | 운영 자산 전량이 은퇴 Swift 스택 대상. **라이브 Rust 바이너리에 `/metrics` 자체가 없음** (D) |
| ⛔ 데이터 소실 되돌림 닫힌 고리 | 마이그레이션 63 forward-only → 유일 처방 PITR → 라이브 PG는 WAL·백업·크론 전무. **RPO = 없음** (D) |
| ⛔ CI가 Rust를 컴파일한 적 없음 | 워크플로 5 전부 수동·PR 트리거 0·릴리스 0·태그 0. 공개 전환 시 Actions 과금 자동 해소 가능 (D) |
| 🔧 성능 근거 | 실측 전부 클라 렌더링(1k p95 10.3ms 등 3건)·서버 부하 도구 0·soak 0. buzz는 재현 가능 벤치+CI 연결 (D) |
| 우위 2(무배선) | 백업 절차 문서 상세도·DB 실핑 `/healthz` — 라이브 미배선이라 실효 0 (D) |

## 2. 2층 — 격차 베이스라인 (buzz가 갖췄고 oort에 없는 것)

루트 문서 13종(CODE_OF_CONDUCT·GOVERNANCE·CHANGELOG·RELEASING·TESTING·ARCHITECTURE(루트)·VISION·`.env.example`·CODEOWNERS…) · PR CI 5레인/워크플로 17 · semver 릴리스(최근 30일 8회) · `deny.toml` 라이선스 CI 강제 · 재현 가능 성능 벤치 · Helm(servicemonitor 포함). 반대로 **oort 우위**: LICENSE 이미지 동봉 강제(`test -s`)·마이그레이션 실행 모델(one-shot·멱등·fail-closed 롤 — buzz 동급 이상)·NOTICE 존재 자체(buzz는 404)·시크릿 위생 게이트(`verify_staging_smoke.sh`).

부수 판정: ADR-0145의 "buzz는 패턴 인용만" 주장 — **반증 실패, 유지**(A). 단 D가 이첩한 `backup-hint` 명칭·의미 동일(buzz가 40일 선행) 1건은 A 보고서에 후속 검증 여지로 기록.

## 3. 얇은 DAG (기계적으로 참인 간선만)

```
성재: 레포/org명 확정 ──> SECURITY.md·GHCR 경로 수정 (A·B)
성재: 공개 전환 ──> Actions 과금 해소 ──> PR CI·라이선스 CI 가동 (D·A)
B: compose 3파일 레포화(대행 덤프 §7) ──> 단일 이미지 재정의(웹 SPA 굽기) ──> C: time-to-hello 재작성
C: 최초 소유자 경로 문서화 ──> time-to-hello 재작성
독립: 라이선스 게이트 이설(A) · /metrics 재이식(D) · 백업 배선(D) · #1222 웹훅 송신(진행 중)
```

## 4. 성재 결정 대기 (통합·중복 제거 10건)

1. **공개 시점·형태** — 공개가 Actions 과금 해소와 연동(D)
2. **공개 범위** — `docs/planning` 266+`research` 112=378파일, 실명 260파일, buzz 경쟁분석 3종
3. **레포·org명 확정** — momo/oort·Dawn-kim-official 잔재(선점 위험)
4. **라이선스 정책** — MPL 30건: CONTRIBUTING을 allow로 정정 vs 의존 교체. deny.toml 도입 여부
5. **셀프호스트 지원 선언 수준 + 단일 이미지 정의** — 웹 SPA를 이미지에 굽는 방향(선례 있음)
6. **RPO/RTO 약속 + 백업 스토리지 조달**
7. **버전 정책·릴리스 채널** — 태그 0 현실에서 시작점
8. **"런칭"의 정의** — 앱스토어 포함 시 privacy-policy 빈칸 9곳=1층 차단(변호사 검토 발주)
9. **staging 신설 여부**
10. **개인 Gmail 히스토리 방침** — 재작성 불가역이므로 방침만(공개 차단급 아님)

## 5. 권고 최단 경로 (결정 후 착수 순서 후보)

① 공개 전 정리 6종+게이트 이설(A — 반나절~1일) → ② compose 레포화+단일 이미지 재정의(B — 대행 덤프로 시작) → ③ 최초 소유자 경로+온보딩 함정 2(C) → ④ /metrics+백업 배선(D) → ⑤ CI 재가동(공개 전환과 연동) → ⑥ 루트 문서 세트(E). ①~③이 끝나면 "clone→You're in"이 성립하고, ④~⑥이 끝나면 buzz급 표면이 완성된다. **엔진은 이미 그 아래 있다.**
