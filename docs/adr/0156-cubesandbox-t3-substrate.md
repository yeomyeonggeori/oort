# ADR-0156 — T3 관리형 샌드박스 기질 = CubeSandbox 채택

- Status: **Accepted** (기안 2026-08-08 Fable · 성재 승인 2026-08-08 — "cube sandbox 등 적극 활용으로 승격해줘. 인프라 부분은 수정하지 뭐")
- 관련: ADR-0142(D1 BYOC·D2 어댑터 계약 — **유지**, 이 ADR은 그 계약의 첫 managed 구현체 결정) · ADR-0144(momo Cloud 기질 — **D1 대체**: k8s+kata 직접 조립 → CubeSandbox 스택) · ADR-0140(수명주기 — 전부 유지) · ADR-0004 · 정본 리서치 `research/2026-08-08-oss-sandbox-memory-evaluation.md`

## Context

E2B 은퇴(ADR-0142) 후 T3 관리형 provider 자리가 비어 있었고, ADR-0144는 그 기질을 "k8s + kata RuntimeClass 직접 조립"으로 권고했었다. 2026-08-08 OSS 실사에서 **CubeSandbox**(TencentCloud, Apache-2.0 원문 확인·부가 제약 0)가 그 조립을 대신해주는 완결 스택임이 실측됐다:

- cloud-hypervisor(RustVMM)+kata 계열 **KVM microVM** — 0144가 원하던 격리 등급 그대로, 조립을 우리가 하지 않는다.
- **API가 ADR-0142 D2 어댑터 계약과 1:1**(create/pause/resume/kill/get) + E2B SDK 호환 표방 — 폐기 예정이던 E2B 클라이언트 잔재가 어댑터 초안이 된다.
- PVM 모드로 `/dev/kvm` 없는 일반 클라우드 VM에서도 1st-party 배포 지원.
- 레포 건강(merged PR 651·기여자 분산·v0.6.0), Rust 주력 — 우리 스택 정합.

리서치는 인프라 제약(RAM≥8GB·디스크≥50GB·호스트 커널 요건 vs 프로덕션 NCP 9.8G 단일 박스)으로 게이트 3개(유료 T3 확정·전용 호스트 예산·v1.0)를 걸고 보류를 권고했으나, **성재가 인프라 수정을 수용하며 적극 활용으로 승격**했다.

## Decision

1. **D1 — 기질**: T3 관리형 샌드박스 기질 = **CubeSandbox**. ADR-0144 D1의 "k8s+kata 직접 조립"을 대체한다(격리 계열은 동일 — 바뀌는 것은 조립 주체). BYOC는 degenerate 어댑터로 **공존 유지**(ADR-0142 불변).
2. **D2 — 합류 형태**: ADR-0142 D2 계약의 구현체 `cubesandbox` provider 어댑터. E2B 고유 수치가 그랬듯 pause/resume 의미론·연속 상한은 전부 **capability 선언**으로 — 정책 코드는 CubeSandbox 상수를 모른다. 의존 형태는 **API 소비**(HTTP — 코드 벤더링 없음), 설치물은 전용 호스트의 CubeSandbox 데몬.
3. **D3 — 인프라**: **전용 호스트 신설**(성재 확보) — PG=SoT 박스와 물리 분리. 1차 후보는 PVM 모드(일반 VM — 커널 교체 요건 실측 후 확정), KVM 가용 베어메탈이면 표준 모드. 사양 하한: RAM 8GB·디스크 50GB.
   - **증보 1 (2026-08-08, D4-① 실측 — `research/2026-08-08-cubesandbox-requirements-adapter-mapping.md`)**: 하한 8GB는 설치기 거부선일 뿐 — 1st-party 벤치가 시스템 기저 ~7GB를 실측. **발주 사양: x86_64 · 8~16 vCPU · RAM 32GB · 시스템 50GB + 데이터 디스크 200GB 별도(XFS — `/data/cubelet` 필수) · Ubuntu 22.04 · 콘솔(VNC) 접근 필수(커널 교체 실패 대비) · VPC 대역 192.168.0.0/18 회피**. PVM=커널 교체+GRUB 기본 변경+재부팅(x86_64 전용, 투기실행 완화 일부 강제 해제 — PG 물리분리 근거 강화). 스케일아웃은 베어메탈(중첩가상화 미지원). aarch64는 베어메탈 경로만.
4. **D4 — 단계**: ①**요건 실측+어댑터 매핑**(호스트 사양 확정 재료 — 인프라 발주 전) ②전용 호스트에서 **실기동 스파이크**(리서치 미확인 목록: 성능 주장·PVM 부팅·디스크 실점유) ③어댑터 구현(+mock conformance 동형) ④프로비저너 연동 — T3 활성화는 ADR-0140의 게이트(T-2~T-4+실 smoke) 그대로.
5. **D5 — 유보**: CubeSandbox 부속 컴포넌트(CubeProxy·CubeEgress·CubeDB 등)는 전부 쓰지 않는다 — 우리가 소비하는 표면은 수명주기 API뿐. egress 정책은 ADR-0150 계열에서 별도 결정.
6. **D6 — 어댑터 계약 결정 2건 (2026-08-08 성재 승인)**: ①사양 종속 capability(`maxConcurrentInstances`)는 **운영자 설정 주입 허용**(기본값 보수적 — ADR-0142 D2 증보: "호스트 사양 종속 capability는 설정 주입 허용") ②idle 회수는 **원장 sweep=1차(ADR-0141 그대로) + CubeSandbox `timeout`=sweep 주기×4·`onTimeout: kill` 최후 안전망** — 좀비 과금 상한 보장, 안전망 발화는 probe의 `provider_missing` 수렴(ADR-0140 D4)으로 이름 있는 상태가 된다. probe lossy(비Paused→running 접힘) 실측에 따라 **`running`은 liveness 증거로 쓰지 않는다 — workd 하트비트가 정본**.

## Slack·업계 비교

Cursor/Codex Cloud류는 관리형 샌드박스를 재판매(E2B·Modal)하거나 자체 조립한다. 우리는 재판매 원가·429 리스크(ADR-0136 실측) 대신 **self-host microVM**으로 간다 — 통제·원가는 얻고, 가용성 운영 부담은 우리 몫이 된다(전용 호스트 1대의 SPOF는 v0 수용 — BYOC 폴백이 완충).

## Consequences

- 성재 액션: 전용 호스트 확보(D4-① 산출이 사양 확정 재료).
- ADR-0144는 D1이 이 문서로 대체됨을 헤더에 표기(후속 커밋).
- 티켓 체인: D4-① 요건 실측(즉시) → ②스파이크(호스트 후) → ③어댑터 → ④프로비저너.
- 리스크 기록: Tencent 주도 프로젝트의 로드맵 종속(v1.0 미도래) — capability 선언 뒤에 있으므로 이탈 비용은 어댑터 1개.

## 증보 2 — U1 실측: 표준 KVM 모드가 1차, PVM은 폴백 (2026-08-09)

U1 판정(scratchpad `u1-verdict.md`·JOURNAL 2026-08-09): PVM 호스트 커널은 NCP 표준 VM에서 부팅된다(PASS — 3회 부팅·ioctl 실증). 그러나 더 큰 실측: **NCP 표준 VM은 이미 `/dev/kvm`(nested=Y)을 주고 L2 게스트 KVM 가속 부팅이 실동작**한다 — D3의 "1차 후보 PVM" 전제(일반 클라우드 VM=KVM 없음)가 NCP에는 해당하지 않는다. 따라서 **1차 시도=표준 KVM 모드(커널 교체 없음 — out-of-tree 종속·`pti=off` 완화 약화 회피)**, PVM=표준 모드 성능 미달 시 폴백. A/B 성능 비교는 D4-②. PVM 채택 시 상류 결함 3건 필수 우회(BLS 무효 `host_grub_config.sh`→`grubby`·`kvm_intel` 선점 블랙리스트·`console=` de-dup 버그 — 판정 보고서 절차 참조).

## 증보 3 — D4-② 실기동 실측 (2026-08-09, `research/2026-08-09-cubesandbox-d42-spike.md`)

**표준 KVM 모드로 전 과업 완주**(설치 91초·preflight 9/9·create→exec→pause→resume→kill 실왕복·신규 호스트→첫 샌드박스 ≈10분) — 증보 2의 "표준 1차" 판단이 실물로 확정됐고 커널 교체는 불요다. 그러나 **D5의 "부속 컴포넌트를 전부 쓰지 않는다"는 사실이 아니다**: CubeProxy·CoreDNS는 exec 경로의 **필수 종속**(죽이면 SDK 전면 마비 실증). D5는 "우리가 **직접 소비하는** 표면은 수명주기 API뿐이고, 스택 내부 종속은 설치물의 일부"로 정정한다.

**어댑터 계약 수정 5건**(#1197로 티켓화): B1 "이미 목표 상태"가 409가 아니라 **500**(code 130490) → ADR-0140 수렴표의 `500→revert`가 플랩을 만든다(4xx/5xx 전부 probe 재판정) · B2 **probe lossy가 예측보다 나쁘다** — VMM SIGKILL 후 5분간 `running` 200 응답, 자력 수렴 0 → `provider_missing`이 크래시에서 발화하지 않으므로 원장이 하트비트 근거로 **능동 destroy**를 발행해야 한다 · H1 `timeout`은 idle이 아니라 **생성 기준 절대 TTL** → `/refreshes` keepalive 의무 신설(ADR-0156 D6②의 "sweep×4·onTimeout kill"은 이 사실 위에서 재해석) · H2 `pauseSecondsPerGiB` 0.2 → 실측 0.67~0.87(**1.0 보수 선언**) · H3 `metadata` 응답에 내부 키 혼입(`cube.*`·`X-Caller`).

**#1179 이탈 1 해소**: idle 시계는 조회성 GET·목록·SDK exec·인-샌드박스 CPU·아웃바운드 다섯 자극 어느 것도 리셋하지 않는다(리컨실러 probe는 안전) — 리셋은 `/refreshes`·`/timeout`뿐.

**발주 사양은 유지, 근거 정정**: 기저 메모리는 3.1GB(1st-party 7.2GB 주장의 43% — "8GB 불가"는 과했다). 다만 세션당 실사용이 지배(워킹셋 800MB 시 834MB/개)해 32GB=동시 ~14개가 여전히 최소선. 시스템 50GB는 `/var/lib/containerd` 2.1GB로 실물 근거.
