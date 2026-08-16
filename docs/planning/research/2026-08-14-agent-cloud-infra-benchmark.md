# 에이전트 클라우드 인프라 벤치마크 — Cursor·xAI·인접 지형 vs ADR-0156 (2026-08-14)

> 발제: 성재/오케스트레이터 — "Cursor·Grok/xAI(및 인접 에이전트 클라우드 제품)가 클라우드 에이전트·샌드박스에 어떤 인프라 기술을 쓰는지 실측하고, 우리 현행 설계(ADR-0156 CubeSandbox T3 기질) 대비 채택/회피 대상을 도출."
> 수행: deep-research 에이전트 단독 · 공개 소스만(벤더 블로그/문서·엔지니어링 인터뷰·채용 공고·보안 리서치·신뢰 보도 — 로그인/스크레이핑 없음). 전 출처 조회일 **2026-08-14**(별도 표기 없으면).
> 판정 요약: **업계는 KVM microVM(Firecracker/Kata/CLH) + 스냅샷/재개 + 프록시형 egress allowlist로 수렴 — ADR-0156의 격리 선택은 검증됨.** Cursor는 EC2+Firecracker 자체 오케스트레이터(Anyrun)로 "메시지 사이 hibernate·체크포인트/포크"를 제품 핵으로 삼았고, 이것이 우리 최대 갭(템플릿 스냅샷·warm pool·턴간 pause 정책)이다. xAI Grok Bot은 유일하게 "계정당 1 VM 공유" 이단 — 따라갈 대상이 아니다.

표기 규약: **[확실]** = 1차 출처(벤더 문서/블로그/공고) 또는 독립 실측 보고 원문. **[추정]** = 2차 보도·정황 종합·유료 원문의 재인용.

---

## 1. Cursor — Cloud Agents (구 Background Agents)

### 실행 기질
- **[확실]** 코드는 AWS 인프라의 격리 VM에서 실행: "Your code runs inside our AWS infrastructure in isolated VMs and is stored on VM disks while the agent is accessible." — cursor.com/docs/cloud-agent/security-network
- **[확실]** 에이전트당 전용 VM(공유 없음): "Cloud agents now run on their own dedicated virtual machines, with their own environments, dependencies, and network access." — cursor.com/blog/cloud-agent-lessons (2026-06-02). self-hosted 문서도 "each agent gets its own dedicated machine with no sharing" — cursor.com/blog/self-hosted-cloud-agents (2026-03-25)
- **[확실]** 오케스트레이터 = **Anyrun**(전량 Rust): "Anyrun is the name of Cursor's orchestrator component, and is written fully in Rust." — Pragmatic Engineer "Real-world engineering challenges: building Cursor" (2025-06-10, 무료 구간)
- **[추정→준확실]** Anyrun이 **Amazon EC2 + AWS Firecracker**로 에이전트를 발사: 같은 기사 유료 본문의 서술로, 다수 2차 소스가 동일 문구로 재인용("a Rust service that takes care of launching agents in the cloud using Amazon EC2 and AWS Firecracker"). 1차 원문 직접 열람은 페이월로 불가 — [추정] 등급이나 재인용 일치도가 높다.
- **[확실/실증]** 보안 리서처(Reco)가 Background Agent 터미널로 진입해 확인한 실물: 원격 머신은 AWS EC2, IAM/VPC는 강하게 제한, **"unable to ... see other Docker instances"** — VM 위에 Docker 컨테이너 계층이 있음을 시사. Cursor 보안팀은 by-design으로 확인. — reco.ai/blog/hijacking-cursors-agent-how-we-took-over-an-ec2-instance
- 종합 구조 [추정]: EC2 노드 풀(k8s pod 언급 있음) 위에 Firecracker microVM/에이전트 전용 VM + 내부 Docker 컨테이너. 블로그 원문: "running in a VM creates exposure to disruptions like inference provider outages, pods needing to be replaced, and EC2 nodes going down." — cloud-agent-lessons

### 리포 반입·스냅샷·재개
- **[확실]** 리포는 GitHub/GitLab/Azure DevOps/Bitbucket에서 clone, 별도 브랜치에서 작업 후 push. 환경은 **Dockerfile로 선언**, 원격 머신 직접 접근은 불가. — cursor.com/docs/cloud-agent, /docs/cloud-agent/setup
- **[확실]** 기본 방식 = **설치 후 파일시스템 스냅샷을 템플릿화**: "You run a bunch of install commands and then you snapshot more or less the file system." (Jonas, Cursor 공동창업자) — latent.space/p/cursor-third-era (2026-03-06)
- **[확실]** 그 위에 **hibernate/rehydrate = 전체 메모리 스냅샷**: "that is a full memory snapshot as well" — 같은 인터뷰. 브라우저가 열려 있던 페이지까지 복원되는 수준.
- **[확실]** 운영 요건으로 명문화: "Methods to efficiently hibernate and resume agent VMs **between messages**" + "Pipelines to quickly and durably **checkpoint, restore, and fork** VM images" + "optimizations like **readonly VMs or prewarmed VMs**" — cloud-agent-lessons
- **[확실]** 환경 스냅샷 보존 = 무활동 90일 상한. — security-network 문서

### 네트워크·시크릿
- **[확실]** egress 3모드(전체 허용 / 기본+allowlist / allowlist-only), 사용자·환경·팀 3계층 정책 + 조직 잠금, egress IP 공개(`cursor.com/docs/ips.json`). — security-network
- **[확실]** 시크릿 3종(env vars / runtime secrets=툴콜·트랜스크립트·커밋에서 마스킹 / build secrets=Docker build 시점만), 커밋은 HSM 백업 Ed25519 서명, OIDC 단기 토큰, 사설망은 Tailscale/Cloudflare Tunnel. — security-network

### Self-hosted 변형 (2026-03-25 출시)
- **[확실]** 워커 = **outbound HTTPS 단방향 프로세스**("no inbound ports, firewall changes, or VPN tunnels required"), 대규모는 Helm 차트+k8s operator(`WorkerDeployment` 리소스), 비-k8s는 fleet 관리 API. 코드·툴 실행·아티팩트가 고객망을 떠나지 않음. — cursor.com/blog/self-hosted-cloud-agents

---

## 2. xAI / Grok Bot·Grok 샌드박스

### Grok Bot 실행 기질 (제품 문서 기준)
- **[확실]** **계정당 1대의 퍼시스턴트 클라우드 컴퓨터를 모든 봇이 공유**: "Every Bot on your account uses the same computer." 봇별 "screen"은 **보안 경계가 아님**: "The screens are separate work surfaces, **not separate security boundaries**." — docs.x.ai/grok-bot/computer-and-apps
- **[확실]** 내구 상태 = `/workspace` 파일 + 브라우저 상태·로그인("designed to survive normal computer updates and recovery"); 임시 디렉터리·수동 설치 패키지는 소멸 가능 취급. 복구 3종: Update(내구 상태 보존) / Recover(무응답 교체) / **Reset(최근 스냅샷으로 복귀)** — 내부적으로 스냅샷 개념 존재. — 같은 문서
- **[확실]** 봇 1개당 컴퓨터-유즈 태스크 1개(스크린당), 봇 여러 개는 병렬 가능. 루틴/웨이크업 스케줄링의 **인프라 구현은 미공개**(문서는 한도만 — 봇당 루틴 50개, 2026-08-12 선행 리서치).
- **[추정]** 이 VM들이 xAI 자체 클러스터에서 구동된다는 직접 진술은 없음. 다만 아래 채용 공고가 "training과 product를 모두 받치는" 자체 샌드박스 서비스를 명시.

### xAI Sandbox Service (채용 공고 = 최상급 1차 소스)
- **[확실]** "builds and maintains a secure, scalable system that gives our models safe, controlled access to computational environments" · "**provisions containers and virtual machines on large-scale clusters**, granting models interactive control over these remote environments" · 명시 기술: "**cgroups, KVM, gVisor, QEMU**" · 언어: "Expert knowledge of **Rust, C++ or Go**" · 용도: "enables Grok to safely run and test code in real-time for user queries, and supports reinforcement learning in training". — job-boards.greenhouse.io/xai/jobs/5007872007 (Sandbox Service). 인접 공고: 4865885007(Coding Agents, Infrastructure — Data, Sandbox)
- 해석 [추정]: xAI는 컨테이너와 VM(KVM/QEMU, gVisor)을 혼용하는 자체 샌드박스 계층을 훈련·제품 겸용으로 운영. Grok Bot의 "계정당 1 VM"은 격리 등급의 한계가 아니라 **원가·UX 선택**(모든 봇이 같은 로그인·파일을 공유하는 제품 컨셉)으로 읽힌다. Bot 간 무경계는 보도에서도 보안 우려로 지적됨(TechTimes 2026-08-12).

---

## 3. 인접 지형 캘리브레이션 (항목당 요점만)

### OpenAI Codex cloud
- **[확실]** OpenAI 관리 **격리 컨테이너**(microVM 공개 언급 없음). 기본 이미지 `universal`(openai/codex-universal 공개). **2상 네트워크**: "Setup scripts run with internet access" → "during the agent phase, internet access is off by default", 전 트래픽 HTTP(S) 프록시 경유. 시크릿은 setup 단계만 존재, agent 단계 전 제거. **컨테이너 상태 캐시 12시간**("Codex caches container state for up to 12 hours") + 재개 시 브랜치 checkout + maintenance script, 설정 변경 시 캐시 무효화. — developers.openai.com/codex/cloud·/codex/environments/cloud-environment(→learn.chatgpt.com 리다이렉트)·/codex/agent-approvals-security
- 로컬 CLI는 별개(Landlock/seccomp·macOS Seatbelt) — 클라우드와 혼동 금지.

### Anthropic Claude (claude.ai 코드 실행 · Claude Code on the web · Cowork)
- **[확실]** claude.ai 서버측 실행 = "**gVisor container** on isolated infrastructure", 세션별 휘발 파일시스템. Claude Code 로컬 = bubblewrap(Linux)/Seatbelt(macOS). Cowork = 플랫폼 하이퍼바이저 전체 VM(Apple Virtualization framework/HCS), 자격증명은 호스트 키체인에만. — anthropic.com/engineering/how-we-contain-claude (2026-05-25)
- **[확실/교훈]** "The hypervisor, seccomp, and gVisor across our products **have been dependable**. Our **custom allowlist proxy was the piece that failed**." 승인 도메인 경유 유출(공격자 API 키로 api.anthropic.com Files API 업로드) 실증 → "allowlist를 **capability grant**로 취급하라". 프롬프트 인젝션 유출 25회 중 24회 성공 사례 → 모델 방어가 아니라 **환경 통제(egress 차단·파일시스템 경계)**가 방어선.

### 샌드박스 벤더 (격리 프리미티브 × 스냅샷)
| 벤더 | 격리 | 스냅샷/재개 | 출처(조회 2026-08-14) |
|---|---|---|---|
| **E2B** [확실] | Firecracker microVM | 템플릿=Dockerfile→microVM 스냅샷 · persistence(beta) pause/resume — **pause ≈4초/GiB·resume ≈1초**, 메모리 포함 복원 | e2b.dev/docs/sandbox/persistence · infra OSS(e2b-dev/infra, Terraform+Nomad+Consul, **GCP 정식/AWS beta**) |
| **Modal** [확실] | gVisor | Filesystem/Directory/**Memory snapshot 3종** — memory 복원은 "All running processes will still be running"(실험 API), FS 스냅샷은 베이스 이미지 대비 diff 저장 | modal.com/docs/guide/sandbox-snapshots |
| **Fly Machines** [확실] | Firecracker | suspend=Firecracker 스냅샷(레지스터+메모리+파일핸들), resume 수백 ms. **호스트 이전/용량 압박 시 스냅샷 무효→콜드 부팅 폴백** | fly.io/docs/reference/suspend-resume |
| **Daytona** [확실] | 기본 OCI/Docker 컨테이너 + 선택 Kata | 스냅샷 기반 **warm pool**(사전 생성 풀에서 claim) — 27~90ms 콜드스타트 주장 · 고객 컴퓨트(BYOC) 지원 | daytona.io/docs/en/snapshots · northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes |
| **Morph Cloud** [확실·벤더 주장] | microVM(전체 VM 티어) | **Infinibranch**: 실행 중 환경 snapshot→branch→restore **<250ms**, 러닝 상태 포크(tree-of-thought/병렬 평가), branch-level security | morph.so/blog/infinibranch · cloud.morph.so/docs |
| **Northflank** [확실] | **Kata Containers**(+워크로드별 Firecracker/CLH/gVisor 선택) | 2021년부터 **월 수백만 microVM** 운영: "in almost all cases **Kata was the right choice**, provided you leverage the best suited VMM" | katacontainers.io/blog/kata-containers-northflank-case-study · northflank.com/blog/secure-runtime-for-codegen-tools-microvms-sandboxing-and-execution-at-scale |
| **Vercel Sandbox** [확실] | Firecracker microVM(전용 커널) | ms급 시작, 기본 5분~최대 24h(Pro/Ent), Amazon Linux 2023 | vercel.com/docs/sandbox · github.com/vercel/sandbox |

---

## 4. 수렴 분석 vs ADR-0156 (우리 현행)

### 수렴이 검증해주는 것
1. **격리 = KVM microVM 또는 gVisor가 업계 정답.** Cursor(Firecracker)·E2B(Firecracker)·Fly(Firecracker)·Vercel(Firecracker)·Morph(microVM)·Northflank(Kata+CLH)·xAI(KVM/QEMU/gVisor 혼용)·Anthropic(gVisor/하이퍼바이저). 순수 컨테이너는 Codex cloud(관리형+프록시 전제)·Daytona 기본 티어 정도. **CubeSandbox(cloud-hypervisor+kata 계열)는 Northflank의 실전 결론("Kata + 적합 VMM")과 정확히 같은 좌표 — ADR-0156 D1 검증.** Anthropic 실증("battle-tested hypervisors... have survived more adversarial attention than anything you'll build")도 "직접 조립 대신 검증된 스택 소비" 방향을 지지.
2. **에이전트당 전용 샌드박스(공유 없음)가 표준.** Cursor·Codex·Claude·전 벤더 공통. 유일한 이단 = Grok Bot의 "계정당 1 VM, 스크린은 보안 경계 아님" — 보안 우려로 이미 지적받는 모델이며, 우리의 세션당 샌드박스 설계가 정합.
3. **Self-host/BYOC 패턴 동형.** Cursor self-hosted worker(outbound HTTPS 단방향, k8s operator)는 ADR-0142 BYOC 어댑터 방향과 같은 얼개 — 우리 경로 이질성 없음.
4. **pause/resume 성능은 우리가 이미 경쟁권.** E2B pause ≈4초/GiB 공표 vs CubeSandbox 실측 0.67~0.87초/GiB(ADR-0156 증보 3 H2). 다만 Fly의 교훈(스냅샷 무효→콜드 부팅 **폴백 경로 필수**)은 우리 probe lossy 대응(B2 능동 destroy)과 같은 계열의 방어로 이미 반영돼 있다.

### 우리 갭 (업계는 있는데 우리는 없는 것)
- **G1 — 설치-후 스냅샷 템플릿**: Cursor의 기본기("install 후 FS 스냅샷=템플릿") = E2B 템플릿 = Daytona 스냅샷. 우리는 매 세션 콜드 셋업(신규 호스트→첫 샌드박스 ≈10분 실측은 호스트 준비 포함이지만, 세션 셋업 반복 비용 자체가 미설계).
- **G2 — 턴 사이 hibernate 정책**: Cursor는 "hibernate and resume agent VMs **between messages**"를 명시 요건으로 운영. 우리 pause/resume은 어댑터 표면만 있고 **정책(언제 pause할지)**이 없다. 32GB=동시 ~14개 상한(증보 3)은 running 기준 — 턴 대기 세션을 pause하면 실효 동시성이 몇 배로 늘어난다.
- **G3 — warm pool**: Daytona(27~90ms)·Cursor(prewarmed VMs) 공통 패턴. 우리 프로비저너에 사전 생성 풀 개념 부재.
- **G4 — egress allowlist의 실패 모드 반영**: 전 벤더가 프록시+allowlist로 수렴했지만, Anthropic이 **그 프록시가 유일하게 실패한 부품**임을 실증(승인 도메인 경유 유출·capability-grant 재프레임). ADR-0150 계열 설계에 반영 안 되면 같은 구멍을 만든다.
- (비갭) VM fork/branch(Morph Infinibranch·Cursor checkpoint/fork)는 병렬 탐색용 — v0 요구 없음, 관찰만.

### AWS 특이사항 (NCP 전이성)
- **Firecracker/Kata/CLH 자체는 KVM만 요구** — NCP 표준 VM nested KVM 실증 완료(ADR-0156 증보 2)라 격리 계층은 전이 문제 없음.
- 비전이: Cursor Anyrun의 EC2 인스턴스 오케스트레이션·ips.json형 egress IP 운영 규모, E2B OSS 인프라의 **GCP Terraform 전제**(AWS beta·NCP 미지원 — E2B 셀프호스트 재검토 불요 근거 추가), Fly의 자체 하드웨어 fleet. 우리는 CubeSandbox 데몬+전용 호스트 1대 스케일이므로 해당 계층 자체가 없다(스케일아웃 시 베어메탈 — 증보 1).

---

## §결론 — 기술 요소 비교표

| 기술 요소 | Cursor | xAI(Grok Bot) | OpenAI Codex cloud | E2B | **우리 현행(ADR-0156)** |
|---|---|---|---|---|---|
| 격리 프리미티브 | EC2+Firecracker microVM[준확실]+내부 Docker[실증] | 컨테이너+VM 혼용(KVM/QEMU/gVisor)[공고 확실], Bot 간 경계 없음[확실] | 관리형 격리 컨테이너(+프록시)[확실] | Firecracker microVM[확실] | cloud-hypervisor+kata KVM microVM[실기동] |
| 단위 | 에이전트당 전용 VM | **계정당 1 VM 공유** | 태스크당 컨테이너 | 샌드박스당 microVM | 세션당 샌드박스 |
| 템플릿/이미지 | Dockerfile→설치 후 FS 스냅샷 | 미공개(Reset=스냅샷 복귀만 노출) | universal 이미지+setup script | Dockerfile→microVM 스냅샷 | **없음(갭 G1)** |
| 유휴 재개 | 메시지 사이 hibernate=메모리 스냅샷 | 퍼시스턴트 VM(끄지 않음) | 컨테이너 캐시 12h+maintenance | pause 4s/GiB·resume 1s | pause/resume 표면만(0.67~0.87s/GiB) — **정책 없음(갭 G2)** |
| warm pool | prewarmed/readonly VMs | 해당 없음 | 캐시로 갈음 | 템플릿 즉시 기동 | **없음(갭 G3)** |
| egress | 3모드 allowlist·3계층 정책·IP 공개 | 미공개(approvals 문서 수준) | agent 단계 기본 차단+프록시 | 설정 가능 | ADR-0150 계열 미결(갭 G4) |
| 시크릿 | 3종 분리+HSM 서명+OIDC | 로그인 자체가 VM에 상주(공유) | setup 단계만 존재 | env 주입 | provider 자격증명 비유입(ADR-0004)+금고(ADR-0147) |
| self-host | worker outbound-only+k8s operator | 없음 | 없음 | OSS infra(GCP 전제) | BYOC 어댑터 공존(ADR-0142) |

## §채택 후보 (노력 추정: S=수일 · M=1~2주 · L=티켓 체인)

| # | 후보 | 근거(수렴) | 내용 | 노력 |
|---|---|---|---|---|
| A1 | **턴-간 pause 정책** (갭 G2) | Cursor "hibernate between messages" · E2B persistence | 에이전트 턴 종료→idle 판정 시 pause, 다음 메시지에 resume. 실효 동시성을 running 상한(~14)에서 분리. H1 절대 TTL/`refreshes` keepalive·sweep 상호작용 설계 포함 | **S~M** (어댑터 위 정책 계층 — 원장/sweep 규칙 수정) |
| A2 | **설치-후 스냅샷 템플릿** (갭 G1) | Cursor 기본기·E2B 템플릿·Daytona 스냅샷 | 리포/에이전트 프로필별 "셋업 완료 시점 스냅샷"을 재기동 시드로. **CubeSandbox의 템플릿/이미지 표면 실측 선행**(스파이크에서 미확인 영역) | **M** (실측 스파이크 S + 어댑터 확장) |
| A3 | **warm pool** (갭 G3) | Daytona 27~90ms·Cursor prewarmed | 프로비저너에 사전 생성 N개 풀 + claim. A2 템플릿 위에서 효과 극대화 — A2 뒤 순서 | **S~M** (프로비저너 로직) |
| A4 | **egress allowlist=capability-grant 설계 주입** (갭 G4) | Anthropic 실패 실증 3건 | ADR-0150 계열 결정에 반영: 승인 도메인 경유 유출 모델링(자사 API 포함), 프록시는 "커스텀 최소화·검증된 부품 위주", allowlist 항목별 도달 가능 기능 심사 | **M** (설계/ADR 입력 — 코드 이전 단계) |
| 관찰 | VM fork/branch(Morph형)·Codex형 12h 캐시 TTL 수치·Grok Bot 인프라 공개 여부 | — | 분기 재실측 항목으로만 | — |

권고 순서: **A4(ADR-0150 진행 전 즉시) → A1 → A2 → A3**. A1~A3은 전부 ADR-0156 어댑터 계약 위의 증분이라 경계 변경이 아니다(단 A2의 스냅샷 표면이 신규 API 소비를 추가하면 어댑터 계약 증보 필요).

---

## 출처 테이블 (전 항목 조회일 2026-08-14)

| URL | 제목 | 신뢰도 | 노트 |
|---|---|---|---|
| cursor.com/docs/cloud-agent/security-network | Secrets & Network (Cursor Docs) | 상(1차) | AWS·격리 VM·egress 3모드·시크릿 3종·90일 스냅샷 보존 |
| cursor.com/blog/cloud-agent-lessons | What we've learned building cloud agents | 상(1차, 2026-06-02) | 전용 VM·hibernate/checkpoint/fork·prewarmed/readonly VM·EC2/pod 언급 |
| cursor.com/blog/self-hosted-cloud-agents | Run cloud agents in your own infrastructure | 상(1차, 2026-03-25) | outbound-only worker·Helm/k8s operator·fleet API |
| latent.space/p/cursor-third-era | Cursor's Third Era (인터뷰, 2026-03-06) | 상(당사자 발언) | FS 스냅샷=템플릿·hibernate=메모리 스냅샷 (Jonas/Samantha) |
| newsletter.pragmaticengineer.com/p/cursor | Real-world engineering challenges: building Cursor (2025-06-10) | 상(취재)·일부 페이월 | Anyrun=Rust 오케스트레이터[무료 구간]·EC2+Firecracker[유료 구간 재인용 — 준확실] |
| reco.ai/blog/hijacking-cursors-agent-how-we-took-over-an-ec2-instance | Hijacking Cursor's Agent | 상(독립 실측) | EC2 실물·IAM/VPC 제한·타 Docker 불가시 |
| docs.x.ai/grok-bot/computer-and-apps | Grok Bot: Computer and apps | 상(1차) | 계정당 1 VM·스크린≠보안경계·/workspace·Reset=스냅샷 |
| job-boards.greenhouse.io/xai/jobs/5007872007 | xAI MTS — Sandbox Service | 상(1차 공고) | 컨테이너+VM 대규모 클러스터·cgroups/KVM/gVisor/QEMU·훈련+제품 겸용 |
| developers.openai.com/codex/cloud (+/environments/cloud-environment, /agent-approvals-security) | Codex cloud 문서 | 상(1차) | 격리 컨테이너·2상 네트워크·12h 컨테이너 캐시·setup-only 시크릿 |
| anthropic.com/engineering/how-we-contain-claude | How we contain Claude (2026-05-25) | 상(1차) | gVisor/bubblewrap/하이퍼바이저 배치·allowlist 프록시 실패 실증·capability-grant |
| e2b.dev/docs/sandbox/persistence | E2B Sandbox persistence | 상(1차) | pause 4s/GiB·resume 1s·메모리 포함 복원 |
| modal.com/docs/guide/sandbox-snapshots | Modal Sandbox snapshots | 상(1차) | FS/Directory/Memory 3종·러닝 프로세스 복원(실험) |
| fly.io/docs/reference/suspend-resume | Fly Machine Suspend and Resume | 상(1차) | Firecracker 스냅샷 suspend·수백 ms resume·무효화→콜드 폴백 |
| daytona.io/docs/en/snapshots | Daytona Snapshots | 상(1차) | 스냅샷·warm pool claim 방식 |
| northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes 외 amux.io/guides/ai-agent-sandboxing | 벤더 비교글 다수 | 중(경쟁사/서드파티) | Daytona 27~90ms·컨테이너 기본+Kata 옵션 등 수치는 벤더 주장 |
| katacontainers.io/blog/kata-containers-northflank-case-study | Kata Containers — Northflank Case Study | 상(1차) | "almost all cases Kata was the right choice"·월 수백만 microVM |
| morph.so/blog/infinibranch · cloud.morph.so/docs | Infinibranch | 중상(벤더 주장) | <250ms snapshot/branch/restore·러닝 포크 |
| vercel.com/docs/sandbox · github.com/vercel/sandbox | Vercel Sandbox | 상(1차) | Firecracker·전용 커널·24h 상한 |
| techtimes.com/articles/324176/... | Grok Bot Launches: ... All Bots Share One Cloud Computer | 중(보도) | 공유 VM 보안 우려 지적 |

관련 정본: ADR-0156(+증보 1~3) · ADR-0142 · ADR-0140 · ADR-0150 계열(미결) · research/2026-08-12-grok-bot-integration-feasibility.md
