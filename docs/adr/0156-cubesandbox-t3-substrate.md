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

## Slack·업계 비교

Cursor/Codex Cloud류는 관리형 샌드박스를 재판매(E2B·Modal)하거나 자체 조립한다. 우리는 재판매 원가·429 리스크(ADR-0136 실측) 대신 **self-host microVM**으로 간다 — 통제·원가는 얻고, 가용성 운영 부담은 우리 몫이 된다(전용 호스트 1대의 SPOF는 v0 수용 — BYOC 폴백이 완충).

## Consequences

- 성재 액션: 전용 호스트 확보(D4-① 산출이 사양 확정 재료).
- ADR-0144는 D1이 이 문서로 대체됨을 헤더에 표기(후속 커밋).
- 티켓 체인: D4-① 요건 실측(즉시) → ②스파이크(호스트 후) → ③어댑터 → ④프로비저너.
- 리스크 기록: Tencent 주도 프로젝트의 로드맵 종속(v1.0 미도래) — capability 선언 뒤에 있으므로 이탈 비용은 어댑터 1개.
