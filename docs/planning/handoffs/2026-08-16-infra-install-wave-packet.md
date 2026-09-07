# 인프라 설치 파도 핸드오프 패킷 — momo-cube-host(CubeSandbox) · momo-turn(coturn), 병렬 2기

> 2026-08-16 Fable 발급, 성재 결재(발주·집행 위임 2026-08-16). 워커: 단발 무명 Opus 5 × 2(병렬 — 서로 다른 호스트·레포 접점은 런북/env 문서만·충돌 없음).
> 사양·근거 정본: `docs/planning/research/2026-08-16-turn-dedicated-host-procurement-package.md`(§1 사양·F1~F8 런북 의무) · `research/2026-08-15-reachability-spike-1411.md`(F1~F8 원문·형상 A/B/C 실측) · `research/2026-08-09-cubesandbox-d42-spike.md` §1(설치 45분 절차) · `infra/cubesandbox/display-template/`(producer 템플릿 계약 v2) · ADR-0165+증보 1 Accepted.
> 발주 실집행 결과(2026-08-16): **momo-cube-host** 101.79.18.230(사설 10.0.1.7·s8-g3 8vCPU/32GB·Rocky 9.8·단일 300GB XFS·nested virt 실증·ACG 22[운영자IP]+8443) · **momo-turn** 223.130.142.109(사설 10.0.1.8·s2-g3 2vCPU/8GB·ACG 22+3478tcp/udp+49152-65535udp). 자격: `~/.ncp/momo-oort-prod.pem`·`~/.ncp/.momo-cube-host-pw`·`~/.ncp/.momo-turn-pw`(전부 0600 — **값 stdout·문서 비유입, sshpass -f로만**).

## 공통 규율
- 첫 스텝: 비밀번호 SSH로 접속해 `momo-oort-prod.pem` 공개키를 `authorized_keys`에 심고 이후 키 인증 사용.
- **F1 이행 의무**: firewalld 활성(ACG 단일 실패점 제거 — ACG와 동일 규칙 중복 선언, 설치 부품 포트는 내부망/루프백 한정) + SELinux는 CubeSandbox/coturn 요구 실측 후 결정(Enforcing 시도→불가 실증 시 Permissive+근거 기록).
- 기존 서버(momo-t3-smoke=**프로덕션**·factsheet-*) 절대 비접촉. ACG 변경은 자기 호스트 전용 ACG만.
- 산출물: 레포에 설치 런북(`docs/runbooks/`)+서버 env 문서 갱신만 — 코드 변경 0. 시크릿 비유입. 실측 증거는 명령·출력 요약으로.
- 미결·불가 판정은 추측 금지 — 동결+보고.

## goal A — momo-cube-host: CubeSandbox 설치 + display 템플릿

1. d42 §1 절차로 CubeSandbox 표준 KVM 설치(`--node-ip=10.0.1.7`) — **F2**: preflight 9999/9998/9966 점유 확인·설치기 rc=0 불신, 유닛 상태(cubelet 등)로 판정. **F7** 전제는 이미 충족(단일 300GB XFS).
2. **F3**: 로컬/사설 레지스트리 구성(템플릿 빌더가 로컬 docker 이미지 못 읽는 실측 대응). **F5**: DOCKER-USER 예외. **F6**: 192.168.0.1:8443/:80 점유 회피 — 시그널링 프록시 포트는 호스트 8443.
3. 기본 microVM 왕복 실증(create→exec→kill — d42 폐곡선 축약판) + **F8**(검증이 refused/timeout 양태 모두 수용).
4. **display 템플릿 빌드**: `infra/cubesandbox/display-template/template.spec.json` v2 계약대로 webrtcbin producer+시그널링 탑재 템플릿을 실제 빌드·등록(레지스트리 경유). 빌드까지 성공하면 microVM 기동+시그널링 WS 로컬 왕복(호스트 내)까지. producer 실기동이 막히면 그 지점 동결+보고(다음 E2E goal의 입력).
5. **형상 A 결선**: 호스트에 시그널링 WS 리버스 프록시(8443, TLS는 self-signed 임시+실인증서는 후속 명시) — 외부(임의 IP)에서 8443 도달 실증.
6. 런북 `docs/runbooks/cubesandbox-host-install.md` 신설(F1~F8 이행 증거·재설치 절차·프록시 구성).

## goal B — momo-turn: coturn 설치

1. coturn 설치(dnf)·설정: listening 3478 tcp/udp·relay 레인지 49152-65535·**정적 임시 자격**(long-term credential 1쌍 — 시크릿은 서버 파일+`~/.ncp/.momo-turn-secret` 0600, 문서 비유입·단명 자격 체계는 LIVE-5에서 교체 명시)·public IP 223.130.142.109 광고(`external-ip`).
2. 외부 실증(이 맥에서): STUN binding 왕복 + **TURN allocation 성립**(권장 도구로 relay 후보 획득 실측 — 스파이크의 "relay가 유일 경로" 전제의 반대편 확인).
3. F1(firewalld)·fail2ban류는 선택(근거 기록). 런북 `docs/runbooks/turn-host-install.md` 신설.
4. (가능하면) momo-cube-host의 microVM에서 TURN allocation 아웃바운드 왕복 — 스파이크 §D3-2의 "TURN 클라이언트로는 무저촉" 실증. goal A 진행도와 독립적으로 시도, 안 되면 보고만.

## 리뷰 폐곡선
인프라 goal이라 design-review 불요. 완주 보고 → Fable 검수(런북·증거) → 런북 PR(main — docs 전용) → grok freeze는 런북 텍스트에 불요(코드 0), 단 잘못된 절차가 위험하므로 Fable이 증거 교차 확인. E2E goal(LIVE-5 전 실기동 검증)은 두 goal 완료 후 편성.

---

## goal C (증보 2026-08-16) — cubesandbox 어댑터 envVars 주입 경로 재설계 (#1437)

- **발단**: goal A 실측 [Blocker] — `create_body`가 `envVars`를 실으면 envd 미탑재(create-from-image) 템플릿에서 create 전체 500(`130497`). 현 어댑터로 우리 템플릿 프로비저닝 불가 — #1438 실기동 E2E의 선행 차단.
- base = 발사 시점 track/engine HEAD. 코드 좌표: `server-rust/crates/momo-t3/src/provider/cubesandbox.rs:356-380 create_body`·`:329 momo_metadata`·`provision.rs:92 BootstrapDerivationSecret`(env 주입의 현 소비자 추적 필수 — 무엇이 envVars에 실리는지 전수 파악부터).
- **경로 후보**(워커가 실측·판정, ADR 정합 1절 의무): ①기존 metadata 채널 이관+workd가 부팅 시 읽기(어댑터에 이미 momo_metadata 존재 — 최소 변경 후보) ②템플릿에 envd 탑재(호스트 실측 필요 — INFRA-A 런북의 템플릿 빌드 절차로 momo-cube-host에서 검증 가능, SSH 자격 `~/.ncp/` — 값 비유입) ③기타. 보안 경계 검토: 주입 값에 bootstrap 자격이 포함되므로 metadata의 가시 범위(다른 샌드박스/게스트에서 읽히는가)를 실측 — ADR-0157 D1/D2 정합.
- 수용기준: 우리 템플릿에서 create 201+bootstrap 자격 workd 실도달(momo-cube-host 실측)+conformance 갱신+mock provider 정직성 유지+선택 경로 ADR 정합 1절(경계 변경이면 증보 초안 동봉). 실호스트 접촉 규율은 goal A와 동일(기존 서버 비접촉·시크릿 비유입).
