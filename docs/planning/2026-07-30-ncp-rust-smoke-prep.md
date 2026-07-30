# NCP T3 smoke — Rust 기반 준비 런북 (Swift smoke는 보류)

> 성재 결정(2026-07-30): **현재 Swift 이미지로는 smoke 안 함.** Rust 서버가 자리잡으면 이 런북대로 진행. 그때까지 이 문서가 준비 정본.

## 0. 왜 지금 미루나
- ADR-0145로 서버가 Rust/Axum으로 재작성 중. Swift 이미지로 smoke를 돌려도 곧 폐기될 스택 검증이라 가치가 낮다.
- T3 smoke가 진짜로 검증할 것(BYOC 등록→세션→과금→종료)은 **T3 런타임(B2)·workd(B5)가 Rust로 서고 나야** 의미가 있다.

## 1. Smoke 착수 트리거 (이게 되면 진행)
다음이 모두 서면 Rust smoke 개시:
1. **부팅 가능한 `momo-server` Rust 바이너리** — 최소 auth + 메신저 코어(B1) + T3 세션 수명주기(B2, provider 어댑터/BYOC 포함).
2. **workd**(B5) 또는 workd 계약을 만족하는 실행 호스트 — BYOC 등록·세션 실행에 필요.
3. **Rust 서버 이미지 빌드·퍼블리시** — 레지스트리에 `momo-rust` 이미지(현 prod의 `MOMO_API_IMAGE` Swift 이미지 대체). prod compose를 Rust 이미지로 스왑.
- 최소선: B2까지(세션·과금·종료). 완전선: B5까지(실 workd 왕복). **B2 완료 시 재평가**해서 부분 smoke 가능한지 판단.

## 2. NCP 서버 자산 (재사용 — 재생성 불요)
- 인스턴스 `momo-t3-smoke`(id **143929369**), 공인 IP **101.79.11.189**, Ubuntu 22.04.3 · 2 vCPU · RAM 7GB · **디스크 4.4GB** · docker 미설치.
- SSH: pem 직접 로그인 불가 → `getRootPassword`로 root 비번 복호화 후 `sshpass`(비번 `scratchpad/.ncp-root-pw` 0600).
- 생성 도구: `scratchpad/ncp-create-kvm.py`(serverImageNo+serverSpecCode+networkInterfaceList), IP 할당 `ncp-assign-ip.py`. 자격 `~/.ncp/credentials.env`. **자원 생성/시작/정지는 성재 트리거**(승인 분류기).

## 3. Smoke 실행 절차 (트리거 충족 후)
1. (선행) `momo-rust` 이미지가 레지스트리에 퍼블리시됐는지 확인(안 됐으면 빌드·푸시 먼저).
2. NCP 서버 시작(정지돼 있으면) → SSH.
3. Docker 설치(4.4GB로 이미지 pull 충분 — prod는 소스빌드 아니라 이미지 pull; §prod compose 전 서비스 `image:`).
4. prod compose(Rust 이미지 스왑판)로 스택 기동 — PG18·Centrifugo·momo-server(rust)·relay·workd.
5. 마이그레이션: **psql 러너**로 001~059 적용(B0 교훈 — `sqlx::raw_sql` 아님). seed 모드 판단(none/e2e).
6. **BYOC smoke**: 워크스페이스 운영자 토큰 발급 → workd 등록(BYOC) → T3 세션 생성 → 과금 계상 → 종료(`t3_terminate` 단일 문). 각 단계 DB 상태·과금 원장 확인.
7. 판정 → `MOMO_T3_ENABLED` 결정.

## 4. 지금 할 준비작업 (Rust 서고 나면 바로 되게)
- [x] 이 런북(트리거·자산·절차 고정).
- [ ] **성재 몫(비용·보안)**: 서버가 놀면서 시간당 100원대 과금 중 + **API 키 명령줄 노출**. Rust가 자리잡기까지 수 주라면 **서버 정지 권고**(자산·IP는 보존, 재시작만). **API 키 재발급 권고**(노출건). 정지/재발급은 성재 트리거.
- [ ] (B2 완료 시) prod compose의 Rust 이미지 스왑판 `infra/prod/docker-compose.rust.yml` 작성 — 지금은 Rust 이미지가 없어 미착수, B2 후.
- [ ] (B-assembly 시) `momo-rust` 이미지 빌드·퍼블리시 CI 경로.

## 5. 병행성
- 이 준비는 서버 재작성(B1~B5)과 독립 문서. 재작성 배치가 트리거(§1)를 채우면 이 런북으로 실행.
