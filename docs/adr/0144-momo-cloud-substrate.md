# ADR-0144: momo Cloud substrate — k8s 위 microVM 격리·이미지/캐시·샌드박스 자격증명

- Status: **Proposed** (2026-07-29, 기안 Fable — 성재 지시 "0144도 기안 진행해줘")
- 관련: **ADR-0142(Accepted)의 "momo Cloud 실 provider 선정" 별건이 이 ADR이다.** ADR-0140(수명주기 — substrate 무관 유지), ADR-0127(첨부 S3 — SaaS 백엔드), ADR-0004(자격증명 비유입)
- 발단: 성재(2026-07-29) — "Slack처럼 momo 호스트로서 k8s를 하나 띄우고, 사람들이 편하게 워크스페이스·에이전트 연동·개발·컴퓨트 사용을 보조."
- 입력: `docs/planning/2026-07-29-gpt-work-runtime-review.md` §8(인프라 감사 — 빈 곳 ①②③) + 격리 기술 리서치(§리서치 근거)

## Context

- ADR-0142가 provider 어댑터 계약을 세웠고, momo Cloud는 그 계약의 **관리형 구현 하나**다. 이 ADR은 그 구현의 실체 — 무엇 위에서, 어떤 격리로, 어떤 이미지·스토리지·자격증명으로 도는지를 정한다.
- **E2B 폐기로 E2B가 공짜로 주던 microVM 격리가 우리 몫이 됐다.** momo Cloud 샌드박스는 임의 에이전트 코드(Claude Code가 실행하는 빌드·docker·브라우저)를 돌린다 — 컨테이너/네임스페이스는 이 코드의 보안 경계가 아니다. 업계는 지난 18개월간 "신뢰 불가 코드=microVM"으로 수렴했다(§리서치).
- 성재의 관리형 방향은 확정이고, 컨트롤 플레인(서버·PG·Centrifugo·워커)과 샌드박스 플릿을 같은 k8s에서 운영하는 것이 출발점이다.

## Decision

### D1. 격리 = **run당 microVM (Kata Containers RuntimeClass)** — 컨테이너는 경계가 아니다

- **A (권고)**: 샌드박스 pod는 `RuntimeClass: kata`로 실행한다 — pod당 하드웨어 가상화 microVM, k8s 표준 워크플로 유지. VMM 오버헤드는 150~300ms 수준으로 cold start 예산에 수용 가능.
  - **노드 요구가 곧 비용 구조다**: Kata는 VT-x/AMD-V 직접 접근이 필요해 **베어메탈 또는 nested virt 노드**가 필요하다. AWS .metal은 3~5배 비싸므로 **저가 베어메탈(Hetzner/OVH류) 또는 nested virt 지원 클라우드(GCP)**를 샌드박스 노드풀 후보로 한다 — **구체 사업자 선정은 운영 결정으로 위임**(이 ADR은 "microVM-급 경계 + RuntimeClass" 계약만 고정).
- B — Firecracker 직접 오케스트레이션(E2B 방식 자가 구축): 격리는 같으나 k8s 밖 커스텀 인프라를 처음부터 짓는 것. 팀 규모 대비 과대. **기각(규모가 요구하면 재론).**
- C — gVisor만: 일반 VM 노드에서 동작해 싸지만 커널 공격면이 남는다(유저스페이스 syscall 가로채기 — 하드웨어 경계 아님). **주 경계로는 기각**, 단 **자가 관리형 운영자를 위한 문서화된 대안 프로파일**로 허용(가상화 확장이 없는 환경에서 "약한 격리임을 알고" 선택) — capability 선언으로 구분한다.
- D — k8s 네임스페이스/컨테이너 격리: **기각.** 이 문장을 ADR에 남기는 것 자체가 목적이다 — 다음 사람이 "네임스페이스면 되지 않나"를 다시 묻지 않게.

### D2. 토폴로지 — 한 클러스터, 두 노드풀, 경계는 pod가 아니라 microVM

- 컨트롤 플레인(서버·PG·Centrifugo·NotifierWorker·LiveKit)은 일반 노드풀. 샌드박스는 **Kata 전용 노드풀**(autoscale). 처음엔 클러스터 1개·리전 1개 — 다중 리전·enterprise 풀은 GPT 문서 §단계7이며 여전히 ④(과도)다.
- 샌드박스 pod 안에는 **cloud workd + 도구**만 산다. momo 서버와의 관계는 BYOC와 동일(부트스트랩 토큰 등록·서명 REST·PTY 호스트 로컬) — **k8s adapter의 유일한 특권은 pod를 만들고 부수는 것**(ADR-0142 D1 그대로).
- k8s API·클라우드 메타데이터·타 pod 네트워크는 샌드박스에서 차단(NetworkPolicy + 메타데이터 차단). 샌드박스의 아웃바운드는 기본 허용(개발 작업 특성) + 워크스페이스 정책 후속.

### D3. 이미지·캐시·cold start — 체감 속도와 원가가 여기서 결정된다

- **base 이미지 1종**: Claude Code·codex·git·기본 툴체인 사전 설치. 노드 로컬 이미지 캐시로 pull 시간 제거(이미지 갱신은 노드풀 롤링).
- **읽기 전용 공유 캐시**: 패키지 캐시(content-addressed)를 노드 로컬 볼륨으로 read-only 마운트 — 워크스페이스 간 공유 가능한 것은 불변 콘텐츠뿐이라는 GPT §9.2 원칙 그대로.
- **warm pool은 나중**: cold start 예산 = Kata 오버헤드(~0.3s) + workd 부트스트랩 + git clone/WIP 복원. 먼저 실측하고, 목표(대화형 시작 수 초대)를 넘을 때만 SandboxWarmPool 패턴(선기동 pod claim)을 얹는다 — **유휴 자원이 "아무도 예산에 안 넣는 비용"이라는 리서치 결론을 기본값에 반영**(warm=0에서 시작).
- **스토리지는 전부 소모품**: 샌드박스 rootfs·workdir은 ephemeral(PV 없음). 원본은 git+원장(ADR-0142 D3). 첨부는 S3(ADR-0127). **k8s 쪽에 새 영속 스토리지 계층을 만들지 않는다.**

### D4. 샌드박스 안의 LLM 자격증명 — momo는 저장하지 않는다

- **A (권고)**: **첫 사용 시 샌드박스 안 대화형 로그인.** 사용자가 momo Cloud 세션 터미널에서 `claude login`/`codex login`을 직접 수행 — 자격증명은 **샌드박스 파일시스템에만** 살고, momo 서버·원장·relay는 만지지 않는다(ADR-0004 유지, PTY 바이트 비경유 D10이 이를 구조로 보장). 샌드박스 destroy와 함께 소멸 — D3의 "스토리지 소모품" 원칙과 정합.
  - 결과로 따라오는 트레이드오프를 정직하게 문서화한다: **재프로비저닝마다 재로그인.** pause/resume(같은 샌드박스)은 유지되고, hibernate/재생성은 재로그인이다.
- B — momo가 단기 자격증명 브로커(암호화 보관 후 주입): 재로그인 없는 UX. 그러나 momo가 사용자 LLM 자격증명의 보관자가 된다 — ADR-0004의 경계를 처음으로 넘는 결정이라 **보안 문서·위협 모델 개정 없이 불가. 후속 재론 가능으로 기각**(사용 데이터로 재로그인 마찰이 실제 문제로 확인되면).
- infra 자격증명(k8s API 토큰)은 어댑터 운영자 시크릿 — ADR-0136의 E2B 키와 동형, 워크스페이스 비노출.

### D5. 셀프호스트 대칭 — 관리형은 "같은 스택 + 어댑터 설정"이어야 한다

- momo Cloud가 쓰는 k8s adapter는 **셀프호스트 운영자도 같은 것을 쓸 수 있는 오픈 구현**이다(자기 k8s에 붙이면 자기 momo Cloud가 된다). Dawn 전용 코드 경로를 만들지 않는다 — ADR-0127의 `drive|s3` 선택과 같은 결. 컨트롤 플레인 k8s 매니페스트(helm)는 별도 운영 티켓(설계 결정 아님).

## Consequences

- (+) "관리형 momo"의 보안 주장이 업계 수렴선(microVM)과 일치 — E2B가 주던 격리 수준을 유지한 채 종속만 제거.
- (+) 샌드박스=BYOC와 같은 workd 문법이라 momo 서버 코드는 substrate를 모른다 — ADR-0142 인터페이스 무변경.
- (+) 영속 스토리지 무증설 — 운영 표면이 이미지·노드풀·S3로 한정.
- (−) 베어메탈/nested virt 노드풀은 일반 노드보다 비싸고 autoscale이 느리다 — warm pool 결정(D3)과 묶여 원가 실측이 필요.
- (−) 재프로비저닝 시 LLM 재로그인(D4 트레이드오프) — hibernate 빈도가 높으면 마찰. ADR-0141 재론(보류 중)과 상호작용.
- (−) Kata 운영 경험이 팀에 없다 — 첫 이행은 단일 노드 PoC로 위험을 앞당겨 태운다.

## 이행 (Accepted 시)

1. **PoC(운영 결정 선행)**: 베어메탈 1노드 + Kata RuntimeClass + base 이미지 → cold start·빌드·docker-in-sandbox 실측. 이 결과가 노드 사업자·warm pool 판단의 근거.
2. **k8s adapter 구현**(ADR-0142 D2 계약: create/destroy/probe, pause 미지원 capability 선언) — mock provider 검증기 통과가 수용 기준.
3. base 이미지 + 캐시 볼륨 + NetworkPolicy/메타데이터 차단.
4. D4 로그인 동선 문서화 + 세션 UI 고지("이 환경의 로그인은 샌드박스에만 저장됩니다").
5. helm/매니페스트는 운영 티켓으로 분리.

## 리서치 근거 (2026-07-29)

- 업계 수렴 "컨테이너는 샌드박스가 아니다 — 18개월간 주요 플랫폼이 microVM으로 수렴": https://emirb.github.io/blog/microvm-2026/
- Kata vs gVisor vs Firecracker 비교(격리 강도·k8s 통합·RuntimeClass): https://northflank.com/blog/kata-containers-vs-firecracker-vs-gvisor · https://northflank.com/blog/how-to-sandbox-ai-agents
- k8s 위 샌드박스 운영 패턴(RuntimeClass·SandboxWarmPool): https://northflank.com/blog/sandboxes-on-kubernetes
- Kata 노드 요구(VT-x/AMD-V — 베어메탈 또는 nested virt)·EKS 베어메탈 실습: https://ketharan.medium.com/how-to-set-up-an-eks-bare-metal-cluster-with-kata-containers-for-vm-isolated-workloads-19793e62274b
- AWS .metal 비용(3~5배)·Kata 기동 오버헤드 150~300ms: https://northflank.com/blog/what-are-kata-containers · https://northflank.com/blog/kata-containers-vs-docker
- GKE의 gVisor/Kata 격리 프로파일: https://medium.com/@berk.yavuzz/pod-isolation-on-gke-gvisor-and-kata-containers-20f783ec78c6
