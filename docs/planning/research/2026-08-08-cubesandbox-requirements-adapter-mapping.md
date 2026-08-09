# CubeSandbox 요건 실측 + 어댑터 계약 매핑 — ADR-0156 D4-① (#1177)

- 작성: 리서치 워커 (2026-08-08), oort(momo) 문맥. **레포 미커밋** — 오케스트레이터 검수 후 이식.
- 정본 입력: `docs/adr/0156-cubesandbox-t3-substrate.md`(Accepted) · `docs/adr/0142-t3-provider-interface-byoc.md` D2 · `docs/adr/0140-t3-lifecycle-redesign.md` D4 · 선행 리서치 `docs/planning/research/2026-08-08-oss-sandbox-memory-evaluation.md` §1
- **방법**: CubeSandbox 레포를 clone(`git clone --depth 50 https://github.com/TencentCloud/CubeSandbox.git`)해 **파일 원문 직접 판독**. 스냅샷 커밋 = **`5cefcca27a7fbd38eb7921cd66b340320e559d0f`** (master, 2026-08-08 fetch). 릴리스 자산은 GitHub API(`gh api repos/TencentCloud/CubeSandbox/releases`) 직접 조회. **2차 출처 0건.**
  - 인용 표기 `CS:<경로>:<줄>` = 위 커밋의 CubeSandbox 파일. 퍼머링크 형태는 `https://github.com/TencentCloud/CubeSandbox/blob/5cefcca/<경로>`.
  - oort 레포 인용은 절대경로(`/Users/kwakseongjae/projects/momo/...`).
- **실기동 없음**(D4-② 범위). 이 문서의 모든 수치는 ①설치기 코드가 실제로 강제하는 값 ②1st-party 문서 ③1st-party 벤치마크 리포트 중 하나에서 나왔고, 각 행에 출처를 붙였다. 추정은 "추정"이라 적었다.

---

## 0. 한 줄 판정과 선행 리서치 정정

**되는 것은 확정, 사양은 리서치보다 크다.** PVM 모드로 `/dev/kvm` 없는 일반 클라우드 VM에서 도는 것은 1st-party 문서 + 1st-party 벤치마크(표준 CVM 실측)로 뒷받침된다. 다만 **8GB/50GB는 "설치기가 거부하지 않는 하한"이고 실사용선이 아니다** — 1st-party PVM 벤치 환경은 **16 vCPU / 32 GiB / 200 GiB**이고, 그 문서 자신이 "빈 머신 베이스라인 사용량 7,198 MB"를 적는다. 8GB 박스는 스택 자체가 다 먹는다.

선행 리서치(`research/2026-08-08-...` §1.5) 대비 **정정 3건**:

| 리서치 기술 | 실측 정정 | 근거 |
|---|---|---|
| "x86_64 전용" | **PVM 경로만 x86_64 전용.** aarch64는 네이티브 KVM 있는 물리 머신에서 bare-metal/self-build로 **지원**(v0.5.0에서 ARM 정식 지원, arm64 릴리스 자산 실재) | `CS:docs/guide/quickstart.md:23-27` · `CS:docs/guide/bare-metal-deploy.md:13,39-60` · 릴리스 v0.6.0 자산 `cube-sandbox-one-click-v0.6.0-arm64.tar.gz`·`vmlinux-arm64` |
| "RAM≥8GB·디스크≥50GB" (하한=권장으로 읽힘) | 하한은 **MemTotal ≥ 7,500,000 KB**(설치기 하드 게이트, 낮출 수 없음). **권장은 32C/64G/200GB**, 1st-party PVM 벤치 실환경은 16C/32G/200GB, K8s 문서의 compute 노드 권장은 **16C32G+** | `CS:deploy/one-click/install.sh:740-754` · `CS:docs/guide/quickstart.md:55-58` · `CS:docs/blog/posts/2026-06-03-cubesandbox-perf-benchmark-pvm.md` §2.1 · `CS:docs/guide/kubernetes/install.md:36-40` |
| "일반 클라우드 VM 배포 실전기가 전부 외부 커뮤니티 글" | 여전히 사실이나(2건 `type: external`), **1st-party 벤치마크 리포트가 표준 CVM(SA9.4XLARGE32) + PVM 커널에서 전 항목 실측치를 공개**한다 — 문서-실체 괴리는 그만큼 줄었다 | `CS:docs/blog/posts/2026-05-17-...md:6`(external) · `CS:docs/blog/posts/2026-06-03-cubesandbox-perf-benchmark-pvm.md`(1st-party, author=coolli) |

그리고 **어댑터 쪽 큰 발견 2개**(§2에서 전개):
1. **폐기된 `E2BProvisioner.swift`가 CubeSandbox에 near-drop-in이다.** 경로·바디 필드·상태코드가 `/sandboxes`, `{templateID,timeout,metadata,envVars}`, 201/204/200 그대로 일치하고 인증 헤더 `X-API-Key`까지 CubeSandbox가 1급으로 받는다.
2. **그런데 두 개가 조용히 깨진다** — ⓐ `Idempotency-Key`를 CubeSandbox는 **읽지 않는다**(공개 API에 멱등 키 없음) ⓑ `probe`의 상태가 **lossy**하다: CubeAPI가 Paused 아닌 모든 상태를 `running`으로 접는다(`unknown`이 `running`으로 보인다). ADR-0142 D3.1("죽음을 정직하게 보고")·ADR-0140 D4의 근거를 정면으로 건드리므로 어댑터가 이 둘을 **구조로** 메워야 한다.

---

# 1. 호스트 요건 확정 (성재 인프라 발주 재료)

## 1.1 배포 모드는 3종이고, 요건이 서로 다르다

| 모드 | 아키텍처 | `/dev/kvm` | 호스트 커널 | 1st-party 문서 |
|---|---|---|---|---|
| **A. PVM (일반 클라우드 VM)** | **x86_64 전용** | **불필요** — PVM이 만들어 준다 | **교체 필수** (아래 §1.3) | `CS:docs/guide/pvm-deploy.md` · `CS:docs/guide/quickstart.md` |
| **B. Bare-metal / 중첩가상화 켜진 VM** | x86_64 **또는 aarch64** | **필수**(`ls -la /dev/kvm`) | 배포판 기본 커널 그대로 | `CS:docs/guide/bare-metal-deploy.md:11-18` |
| **C. Kubernetes (Helm)** | 노드가 B 요건 충족 | 필수 | 배포판 기본 | `CS:docs/guide/kubernetes/install.md` |

- **A는 단일 노드까지만이다.** multi-node 확장의 compute 노드 요건은 *"Physical machine or bare-metal server (**nested virtualization is not supported**)"* — 즉 **스케일아웃하려면 베어메탈**이 필요하다(`CS:docs/guide/multi-node-deploy.md:41-45`). v0 단일 박스에는 영향 없지만, "나중에 노드 붙이면 되지"가 성립하지 않는다는 뜻이라 발주 시점에 알아야 한다.
- ARM: PVM 호스트 커널은 릴리스 자산이 `*.x86_64.rpm` / `*_amd64.deb`뿐이고 문서가 *"PVM does **not** support ARM64"*라고 명시(`CS:docs/guide/quickstart.md:23-27`). aarch64는 **네이티브 KVM 있는 물리 ARM 서버**에서만. 또한 ARM은 `online-install.sh` 자동경로가 아직 x86_64만 탐색해 **수동 tar 설치**(`CS:docs/guide/bare-metal-deploy.md:41-60`). 멀티아치 게스트 이미지는 현재 `sandbox-code:latest` **1개만** 공개(`CS:docs/guide/quickstart.md:213-215`).

## 1.2 PVM은 "모듈 로드"가 아니라 **호스트 커널 교체 + 재부팅**이다 (질문에 대한 직답)

절차가 문서에 그대로 있다(`CS:docs/guide/pvm-deploy.md:55-152`):

1. 릴리스에서 커널 패키지 내려받아 설치 — v0.6.0 실제 자산명:
   - RPM: `kernel-6.6.69_opencloudos9.cubesandbox.pvm.host_g0de43d6b3bcd-1.x86_64.rpm` (**603 MB**), `kernel-headers-...rpm`
   - DEB: `linux-image-6.6.69-opencloudos9.cubesandbox.pvm.host-g0de43d6b3bcd_..._amd64.deb` (59 MB), `linux-headers-...deb`, `linux-libc-dev_...deb`
   (출처: `gh api repos/TencentCloud/CubeSandbox/releases/tags/v0.6.0 -q '.assets[]'`)
2. **GRUB 기본 부트 엔트리 변경**(`grubby --set-default-index` 또는 `GRUB_DEFAULT` sed)
3. **부트 파라미터 주입** — `bash <(curl -fsSL .../deploy/pvm/grub/host_grub_config.sh)` (§1.4에서 내용 분석)
4. **reboot**
5. `modprobe kvm_pvm` → `echo 'kvm_pvm' > /etc/modules-load.d/kvm-pvm.conf` (부팅 시 자동 로드)
6. 설치기를 `CUBE_PVM_ENABLE=1`로 실행 → PVM용 게스트 커널(`vmlinux-pvm`)이 런타임 커널로 설치됨

즉 **out-of-tree 3rd-party 호스트 커널(OpenCloudOS 6.6.69 기반)에 상시 종속**된다. 커널 소스 기준: `OpenCloudOS-Kernel.git` 태그 `6.6.69-1.2.cubesandbox`, config는 virt-pvm 프로젝트 레퍼런스 파생(`CS:deploy/pvm/configs/README.md`). 커널 보안 패치 추적 책임이 우리에게 온다 — 이건 리서치의 지적 그대로 유효하다.

**⚠ 릴리스 커널 vs 자가빌드 커널의 지위가 다르다 (새 발견).** 설치기가 `/dev/kvm` 부재 시 안내하는 **자가빌드 경로**(`deploy/pvm/pvm_setup.sh`)에는 이런 경고가 코드에 박혀 있다:

> `"WARNING: the open-source kvm-pvm integration is intended for development, evaluation and self-built experiments only. It is NOT suitable for production workloads -- expect reduced performance, limited hardware coverage and no long-term support guarantees."` — `CS:deploy/one-click/install.sh:730-733`

반면 문서의 **릴리스 RPM/DEB 경로**에는 *"Tencent Cloud has deployed PVM instances at scale in production, with reliability validated in production"*라는 정반대 톤이 붙는다(`CS:docs/guide/pvm-deploy.md:16-18`). **두 문장은 서로 다른 산출물에 대한 것**이므로 모순은 아니지만, 결론은 하나다: **릴리스 자산 커널만 쓴다. `pvm_setup.sh` 자가빌드 경로는 우리 프로덕션에서 금지.**

## 1.3 설치기가 **실제로 강제**하는 하드 게이트 (문서가 아니라 코드)

`install.sh`가 순서대로 실행하는 preflight 전량(`CS:deploy/one-click/install.sh:1188-1194`):

| # | 게이트 | 강제되는 값 | 실패 시 | 코드 |
|---|---|---|---|---|
| 1 | `check_hardware_preflight` | **`/dev/kvm` 존재** | die | `install.sh:715-735` |
| 2 | 〃 | **MemTotal ≥ 7,500,000 KB** (≈7.15 GiB). `CUBE_MIN_MEMORY_KB`로 **올릴 수만** 있고 내릴 수 없다 | die | `install.sh:737-754` |
| 3 | `check_pvm_consistency_preflight` | `kvm_pvm` 로드됨인데 `CUBE_PVM_ENABLE≠1`이면 **비대화형에서 die** (템플릿 생성이 나중에 조용히 실패하는 것을 막음) | die/prompt | `install.sh:766-843` |
| 4 | `check_cubelet_fs_preflight` | **`/data/cubelet`이 XFS** (CoW reflink 스냅샷 전제). ext4면 die | die | `install.sh:845-881` |
| 5 | `check_cgroup_cpu_preflight` | cgroup v2에서 **`cpu` 컨트롤러 노출 + subtree_control에 `+cpu`**. Ubuntu/Debian은 `multipathd`가 이걸 막는 알려진 함정 | die(수리 명령 안내) | `install.sh:883-924` |
| 6 | `check_bpf_fs_preflight` | **`/sys/fs/bpf`가 bpf fs로 마운트** + 커널 `bpf` 파일시스템 지원 (Cubelet 내장 네트워크 런타임이 eBPF 사용) | die | `install.sh:926-950` |
| 7 | `check_glibc_preflight` | **glibc ≥ 2.31** (바이너리가 Ubuntu 20.04 기준 빌드) | exit 3 | `deploy/one-click/lib/common.sh:2017-2053` |
| 8 | `check_install_preflight` | `tar ss systemctl bash curl sed grep pgrep date` + **`docker`** + `python3` + `ip` | die | `install.sh:952-1010` |
| 9 | `check_cidr_preflight` | 샌드박스 네트워크 CIDR 형식 + **호스트 라우트 충돌 검사**. 기본값 **`192.168.0.0/18`** | die | `install.sh:1222-1231`, `lib/common.sh:1917-` |

**⚠ 발주에 직접 영향 가는 두 개:**
- **XFS**: Ubuntu/Debian/일반 클라우드 이미지는 **ext4가 기본**이다. `/data/cubelet`용 **별도 데이터 디스크를 XFS로 포맷해 마운트**해야 한다(문서도 전용 데이터 디스크를 권장: `CS:docs/guide/quickstart.md:41,44`, 이슈 #311 참조). → **발주 시 데이터 디스크를 따로 붙일 것.**
- **CIDR `192.168.0.0/18`**: NCP VPC/서브넷이 `192.168.x.x`를 쓰면 **설치가 충돌로 죽는다.** `CUBE_SANDBOX_NETWORK_CIDR`로 바꿀 수 있으나(마스크 16~24), **발주 단계에서 VPC 대역을 겹치지 않게 잡는 편이 싸다.**

## 1.4 GRUB 부트 파라미터가 호스트를 어떻게 바꾸는가 ★ (리서치에 없던 축)

`CS:deploy/pvm/grub/host_grub_config.sh`가 `GRUB_CMDLINE_LINUX`에 병합하는 값 전문(요약이 아니라 실제 목록):

```
quiet elevator=noop console=ttyS0,115200 console=tty0 vconsole.keymap=us
crashkernel=1800M-64G:256M,64G-128G:512M,128G-486G:768M,486G-972G:1024M,972G-:2048M
vconsole.font=latarcyrheb-sun16 net.ifnames=0 biosdevname=0
intel_idle.max_cstate=1 intel_pstate=disable cgroup.memory=nokmem transparent_hugepage=never
ipv6.disable=1 systemd.unified_cgroup_hierarchy=1 module.sig_enforce=1
clearcpuid=27,28,54,57,104,107,118,120,122,131,152,158,193,196,198,199,200,201,214,215,225,241,249,250,254,289,292,295,297,299,302,306,307,309,311,312,317,321,322,323,389,416,418,425,513,514,517,518,520,521,522,523,524,526,534,537,539,540,580
clocksource=tsc pti=off no5lvl mitigations=on spec_store_bypass_disable=prctl retbleed=off
kvm.nx_huge_pages=never tsc=reliable kmem_cache.max_num=16000
```

이 중 **성재가 알고 발주해야 하는 것**:

| 파라미터 | 무슨 뜻인가 | 우리 판단 |
|---|---|---|
| **`pti=off`** | Meltdown 완화(KPTI) **끔** | 호스트 커널 투기실행 완화가 일부 꺼진다. **전용 호스트라 PG=SoT와 물리 분리된 것이 전제 조건이 되는 이유가 하나 더 늘었다** — 이 박스는 "사용자 코드를 돌리는 박스"이고 호스트 측 사이드채널 완화가 표준보다 약하다 |
| **`retbleed=off`**, `spec_store_bypass_disable=prctl` | Retbleed 완화 끔 / SSB는 opt-in | 위와 같은 성격 |
| **`kvm.nx_huge_pages=never`** | iTLB multihit 완화 끔 | 위와 같은 성격 |
| `mitigations=on` | 나머지 완화는 유지 | 부분 상쇄 |
| `clearcpuid=…`(60여 개) | CPU 기능 다수 마스킹 | PVM 동작 전제. **CPU 모델 의존성이 생긴다** — 다른 CPU에서 동작 보장이 문서에 없다 |
| **`ipv6.disable=1`** | 호스트 IPv6 **전면 비활성** | NCP에서 IPv6 쓰는 구성이면 충돌. v0에는 무해할 것으로 보이나 발주 시 확인 |
| **`module.sig_enforce=1`** | 서명 안 된 커널 모듈 로드 거부 | 나중에 서드파티 드라이버(백업 에이전트 등) 못 올릴 수 있음 |
| `crashkernel=…:256M` | 크래시 커널용 메모리 **예약** | 8GB 박스에서 256MB가 더 빠진다 |
| `transparent_hugepage=never`, `intel_pstate=disable`, `elevator=noop` | 성능 튜닝 | 부수효과: 이 박스는 범용 서버로 겸용하기 나쁘다 |

**결론**: PVM 호스트는 "커널만 갈아끼운 일반 서버"가 아니라 **보안 완화·CPU 기능·네트워크 스택이 튜닝된 전용 어플라이언스**가 된다. ADR-0156 D3의 "PG=SoT 박스와 물리 분리"는 옳은 결정이었고, 여기서 근거가 하나 더 나왔다. **이 박스에 다른 서비스를 얹지 않는다**를 운영 규칙으로 못 박을 것.

## 1.5 사양 — 하한 / 1st-party 권장 / 실측 베이스라인

| 축 | 설치 통과 하한 (코드) | 1st-party "기능 체험" | 1st-party 권장 | 1st-party 벤치 실환경(PVM) | K8s compute 노드 권장 |
|---|---|---|---|---|---|
| CPU | 검사 없음 | ≥ 4 core | 32 core | 16 core (AMD EPYC 9K65) | 16C+ |
| RAM | **≥ 7,500,000 KB (≈7.15 GiB)** | ≥ 8 GB | 64 GB | **32 GiB** | 32G+ |
| 디스크 | 검사 없음(문서 요구) | 시스템 ≥ 50 GB, `/data/cubelet` ≥ 50 GB | ≥ 200 GB | 200 GiB **XFS** | StorageClass |
| 출처 | `install.sh:740` | `quickstart.md:57` | `quickstart.md:58` | `perf-benchmark-pvm.md` §2.1 | `kubernetes/install.md:36-40` |

**실측 베이스라인 (이 리포트의 가장 중요한 숫자):** 1st-party PVM 벤치가 32 GiB 박스에서 **빈 상태 available = 25,570 MB**를 기록하고, 자기 문서에서 그 차이를 *"System baseline usage (measured): 7198 MB"*로 계산한다(`CS:docs/blog/posts/2026-06-03-cubesandbox-perf-benchmark-pvm.md` §3.3).

> **즉 OS + CubeSandbox 스택 자체가 ~7 GB를 쓴다.** 설치기 하한 7.15 GiB는 "스택만 겨우 올라가고 샌드박스는 못 돌리는" 선이다. **8 GB 발주는 실질적으로 불가**로 읽어야 한다.

**밀도 실측 (같은 문서)**: 유휴 샌드박스 1개당 상각 오버헤드 **27–34 MB**(2 vCPU/2 GiB 스펙). 32 GiB 박스 기준 그들의 산식:
- 유휴/경부하: `22,294 MB ÷ 30 MB ≈ 743 개`
- 만재(각 샌드박스가 2 GiB 전부 씀): `22,294 ÷ (2048+30) ≈ **10 개**`

**우리 T3 워크로드는 "코딩 에이전트가 실제로 빌드를 돌리는" 쪽이라 만재에 가깝다.** 즉 **동시 T3 세션 수 ≈ (RAM_GB − 7 − 여유) ÷ 세션당 메모리**. 32 GiB면 2 GiB 세션 기준 동시 ~10개. 이게 발주 사양을 정하는 유일하게 정직한 계산이다.

## 1.6 성능 — PVM 페널티는 실측상 작다

| 연산 | 베어메탈(BMI5, 96코어/375GiB) | **PVM 표준 CVM(16코어/32GiB)** | 비고 |
|---|---|---|---|
| create (직렬) | 47.8 ms avg | **66.7 ms avg** (p95 78.2) | PVM 페널티 ≈ +40%, 절대값은 여전히 sub-100ms |
| create (동시 10) | 88.7 ms avg | 170.9 ms avg (상각 17.1 ms) | |
| create (동시 20) | 98.1 ms avg | 364.6 ms avg (상각 18.2 ms) | |
| snapshot (직렬) | 49.8 ms | 41.4 ms | |
| **pause (직렬, 2 GiB)** | — | **370.8 ms** | 현재 **full-memory-copy 모드**. soft-dirty 증분은 미래 릴리스 예정 |
| **resume (직렬)** | — | **18.9 ms** (동시10 상각 2.7 ms) | |
| 성공률 | 100% | 100% | |

출처: `CS:docs/blog/posts/2026-06-01-cubesandbox-perf-benchmark.md` §3.2, `CS:docs/blog/posts/2026-06-03-cubesandbox-perf-benchmark-pvm.md` §3.2·§4.6.

**과금 설계에 직결되는 수치**: pause 370.8 ms / 2 GiB ≈ **0.19 s/GiB**. 우리 mock-a가 E2B 유래로 들고 있는 `pauseSecondsPerGiB: 4`(`/Users/kwakseongjae/projects/momo/services/CloudProviderKit/Sources/CloudProviderKit/CloudProviderRegistry.swift:36`) 대비 **약 20배 빠르다**. capability 선언에 그대로 반영한다(§2.7).

## 1.7 표 — **NCP 표준 VM으로 되는 구성 vs 베어메탈 필요한 구성**

| 항목 | **구성 A: NCP 표준 VM + PVM** | **구성 B: 베어메탈/중첩가상화 VM** |
|---|---|---|
| `/dev/kvm` | 불필요 (PVM이 제공) | **필수** |
| 아키텍처 | **x86_64만** | x86_64 또는 aarch64 |
| 호스트 커널 | **Tencent OpenCloudOS 6.6.69 PVM 커널로 교체 + GRUB 파라미터 + 재부팅** | 배포판 기본 커널 유지 |
| 커널 보안 추적 | **우리 책임**(out-of-tree) | 배포판 벤더 |
| 투기실행 완화 | `pti=off`·`retbleed=off`·`nx_huge_pages=never` **강제** | 배포판 기본 유지 |
| 설치 명령 | `curl … online-install.sh \| CUBE_PVM_ENABLE=1 bash` | `curl … online-install.sh \| bash` (ARM은 수동 tar) |
| create 지연(직렬) | ~67 ms | ~48 ms |
| **멀티노드 확장** | **불가** — compute 노드는 중첩가상화 미지원 | 가능 (control↔compute, 8089/9999) |
| 운영 리스크 | 커널 교체 실패 시 **부팅 불가**(콘솔 접근 필수) · 이미지 재생성 시 매번 재적용 | 낮음 |
| 조달 난이도/비용 | **낮음** (NCP 표준 상품) | 높음 (베어메탈 상품 또는 중첩가상화 지원 인스턴스) |
| 1st-party 검증 수준 | 벤치 리포트 1건(Tencent CVM SA9.4XLARGE32) + "프로덕션 대규모 검증" 주장 | 벤치 리포트 1건(Tencent BMI5) |
| **v0 권고** | **채택** — 조달 가능성이 지배적. 단 RAM 32 GB급 | 나중에 밀도/노드 확장이 필요해지면 |

**단 A에는 NCP 특정 미확인이 남는다 — §1.9 참조.**

## 1.8 설치 절차 개요 (런북 초안 — D4-② 스파이크의 실행 대본)

> 전제: x86_64 VM, root, 인터넷(GitHub + `*.tencentcloudcr.com` 도달 가능), **`/data/cubelet`용 XFS 데이터 디스크 별도 부착**, VPC 대역이 `192.168.0.0/18`과 비충돌.

```
[0] 사전 확인
    uname -m                      # x86_64
    ldd --version                 # glibc >= 2.31
    free -g                       # >= 8 (실사용 권장 32)
    grep -w bpf /proc/filesystems # bpf 있어야 함
    lsblk                         # 데이터 디스크 확인

[1] /data/cubelet XFS 준비
    mkfs.xfs /dev/<data-disk>
    mkdir -p /data/cubelet && mount /dev/<data-disk> /data/cubelet
    # /etc/fstab 영속화
    df -T /data/cubelet           # Type=xfs 확인

[2] Docker 설치 + 기동 (배포판 표준)

[3] PVM 호스트 커널  (구성 A만)
    # https://github.com/TencentCloud/CubeSandbox/releases 에서
    #   kernel-*opencloudos9.cubesandbox.pvm.host*.x86_64.rpm   (RPM 계열)
    #   linux-image-*opencloudos9.cubesandbox.pvm.host*_amd64.deb (DEB 계열)
    wget "<asset URL>"
    rpm -ivh --oldpackage kernel-*.rpm        # 또는 dpkg -i linux-image-*.deb
    grubby --info=ALL | grep -E "^kernel|^index"
    grubby --set-default-index=<index>        # DEB는 GRUB_DEFAULT sed (문서 참조)
    bash <(curl -fsSL https://raw.githubusercontent.com/TencentCloud/CubeSandbox/master/deploy/pvm/grub/host_grub_config.sh)
    reboot

[4] 재부팅 후 검증
    uname -r                      # ...opencloudos9.cubesandbox.pvm.host
    modprobe kvm_pvm && lsmod | grep kvm_pvm
    ls -la /dev/kvm
    echo 'kvm_pvm' > /etc/modules-load.d/kvm-pvm.conf

[5] 설치
    curl -sL https://github.com/tencentcloud/CubeSandbox/raw/master/deploy/one-click/online-install.sh \
      | CUBE_PVM_ENABLE=1 bash -s -- --node-ip=<private-ip>
    grep CUBE_PVM_ENABLE /usr/local/services/cubetoolbox/.one-click.env   # =1

[6] 하드닝 (프로덕션 필수 — 기본은 무인증·0.0.0.0 바인드)
    .env: CUBEMASTER_HTTP_BIND=<private-ip>
          CUBE_API_BIND=<private-ip>:3000 / CUBE_API_HEALTH_ADDR 동일
          AUTH_CALLBACK_URL=https://<oort>/internal/t3/authz
          MYSQL/REDIS 기본 비밀번호 전량 교체
    Cubelet/config/config.toml: [http] address / [grpc] tcp_address → private IP
    방화벽: 3000/8089/9999/12088 → oort 서버 IP만 허용

[7] momo-workd 템플릿 생성  (D4-② 산출물)
    cubemastercli tpl create-from-image \
      --image <our-registry>/oort-workd:<tag> \
      --writable-layer-size <N>G --expose-port <p> --probe <p>
    cubemastercli tpl watch --job-id <job_id>   # READY 까지
    → 나온 template_id 가 어댑터 설정의 MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF 값

[8] 스모크
    curl -s http://<ip>:3000/health
    POST /sandboxes → GET /sandboxes/{id} → pause → resume → DELETE
```

절차 출처: `CS:docs/guide/pvm-deploy.md` 전문 · `CS:docs/guide/quickstart.md:170-229` · `CS:docs/guide/network-hardening.md` · `CS:deploy/one-click/install.sh`.

**설치가 세우는 것 전량**(`CS:docs/guide/service-management.md:63-73`) — 신규 운영 표면:

| 유닛 | 형태 | 포트 | 기본 바인드 |
|---|---|---|---|
| `cube-sandbox-mysql` | Docker | 3306 | 127.0.0.1 |
| `cube-sandbox-redis` | Docker | 6379 | 127.0.0.1 |
| `cube-sandbox-cubemaster` | 호스트 프로세스 | 8089 | **0.0.0.0, 무인증** |
| `cube-sandbox-cube-api` | 호스트 프로세스 | **3000 (E2B 호환 API)** | **0.0.0.0** |
| `cube-sandbox-cubelet` | 호스트 프로세스 | 9999 gRPC / 9998 HTTP | **0.0.0.0, 무TLS** |
| `cube-sandbox-coredns` | Docker | 53 | 127.0.0.54 |
| `cube-sandbox-cube-proxy` | Docker | 80 / 443 / 9090 | 0.0.0.0 (의도적 공개) |
| `cube-sandbox-webui` | Docker | 12088 | **0.0.0.0** |

**보안 기본값이 나쁘다 — 명시적으로 기록**:
- CubeAPI는 **기본이 무인증 전면 허용**: *"By default, Cube API Server allows all requests without any authentication"*(`CS:docs/guide/authentication.md:3`). `AUTH_CALLBACK_URL`을 세팅하면 요청마다 우리 콜백에 permit/deny를 물어본다(콜백 불달 시 **fail-closed**). → **oort가 그 콜백을 구현하면 우리 자격증명 체계 안으로 들어온다**(ADR-0004에 유리 — 외부 provider 키가 아예 없다).
- 문서 자신이 *"The one-click / self-build deployments are designed for development and evaluation"*라고 경고(`CS:docs/guide/network-hardening.md:10-14`).
- `env.example` 기본 비밀번호가 실제 약함: `CUBE_SANDBOX_REDIS_PASSWORD=ceuhvu123`, `MYSQL_ROOT_PASSWORD=cube_root`, `MYSQL_PASSWORD=cube_pass`(`CS:deploy/one-click/env.example:151-155`) — **전량 교체 필수**.

**레지스트리 의존 (발주 시 방화벽 정책 재료)**: 부수 컨테이너 이미지가 `cube-sandbox-image.tencentcloudcr.com`에서 온다(mysql:8.0, redis:7-alpine, coredns, openresty — `CS:deploy/one-click/env.example:116-119`), 샌드박스 베이스 이미지는 `cube-sandbox-int.tencentcloudcr.com`(`CS:docs/guide/quickstart.md:211`). **Tencent Cloud 계정은 불필요하지만 Tencent 컨테이너 레지스트리 도달성은 필요**하다. 우리 이미지를 쓰면 후자는 대체 가능, 전자는 설치 시점 의존.

## 1.9 미확인 + 확인 방법 (정직 기록)

| # | 미확인 | 왜 지금 못 정하나 | **확인 방법** |
|---|---|---|---|
| U1 | **NCP 표준 VM에서 PVM 호스트 커널이 부팅되는가** | NCP 이미지·부트로더·CPU 모델에 대한 1차 소스가 CubeSandbox 레포에 없다. 1st-party 검증은 Tencent CVM(AMD EPYC 9K65)에서만 | D4-② 스파이크: **폐기 가능한** NCP VM 1대에 §1.8 [3]~[4]만 수행하고 `uname -r`/`lsmod`/`ls /dev/kvm` 3개로 판정. **콘솔(VNC) 접근 확보가 선결** — 커널 교체 실패 시 SSH가 안 열린다 |
| U2 | `clearcpuid=` 마스킹 목록이 NCP CPU(Intel/AMD 세대 미상)에서 문제를 일으키는지 | 상동 | U1과 같은 런에서 부팅 로그 + `lscpu` 확인 |
| U3 | 실제 디스크 점유(설치 직후 / 템플릿 1개 빌드 후) | 실기동 안 함. 릴리스 번들 258 MB·PVM 커널 RPM 603 MB·게스트 이미지 64 MB는 **다운로드 크기**일 뿐 설치 후 점유가 아님 | D4-②: 설치 전후 `df -h /` 와 `du -sh /data/cubelet /usr/local/services/cubetoolbox` |
| U4 | pause/resume 실동작이 우리 워크로드(빌드 중 프로세스 트리)에서도 메모리 보존되는가 | 벤치는 idle 샌드박스 기준 | D4-②: `examples/code-sandbox-quickstart/auto-resume.py`를 우리 workd 템플릿으로 실행 |
| U5 | `default_timeout_insec` 미설정 시 "영원히 안 죽음"이 우리 정산과 안전한가 | 레포 기본값이 `-1`(idle TTL 없음)(`CS:docs/guide/lifecycle.md:213`) | 설정 결정: **우리는 항상 `timeout`을 명시**하므로 클러스터 기본값에 의존하지 않는다(§2.7) |
| U6 | v1.0 도달 시점 / API 안정성 선언 | 로드맵에 **버전 표기·일정 없음**. "E2B API Compatibility" 항목이 *"Close the remaining gaps"*로 **아직 진행 중**임을 자인(`CS:docs/guide/roadmap.md:15-17`) | 릴리스 케이던스 관찰(현재 v0.6.0, 2026-07-24). ADR-0156이 이미 이 리스크를 "이탈 비용=어댑터 1개"로 수용 |
| U7 | 보안 감사/CVE 이력 | 미조회(선행 리서치와 동일) | GitHub Security Advisories + OpenCloudOS 커널 CVE 추적 채널 등록 |
| U8 | `secure: true`가 CubeSandbox에서 무엇을 하는가 | **아무것도 안 한다** — 필드는 파싱되지만 `create_sandbox`가 읽지 않는다(§2.2 확인). 즉 미확인이 아니라 **확인된 no-op** | — |

---

# 2. 어댑터 계약 매핑 (ADR-0142 D2 / ADR-0140 D4 ↔ CubeSandbox openapi.yml)

## 2.0 우리 쪽 계약의 현재 실물

ADR-0142 D2는 이미 **코드로 존재**한다 — `/Users/kwakseongjae/projects/momo/services/CloudProviderKit/Sources/CloudProviderKit/`:

- `CloudProviderAdapter.swift` — 5연산 프로토콜 + `CloudProviderCapabilities`(7필드) + `CloudInstanceSpec` + `CloudInstanceRef` + `CloudProviderError`
- `CloudProviderRegistry.swift` — `byoc` / `mock-a` / `mock-b` 3개 descriptor. **여기에 `cubesandbox` 한 줄을 더하는 것이 D4-③의 절반**
- `HTTPCloudProviderAdapter.swift` — **momo가 정의한 REST 모양**(`/v1/instances`, `X-Momo-Provider-Key`, `Idempotency-Key`). mock 기질이 이걸 구현한다
- `CloudProviderSettings.swift` — `MOMO_T3_PROVIDER_<ID>_{API_BASE_URL,API_KEY,IMAGE_REF,INSTANCE_TIMEOUT_SECONDS}` 네임스페이스
- `CloudLifecycleConvergence.swift` — ADR-0140 D4 수렴표를 코드로

**핵심 판정: CubeSandbox는 `HTTPCloudProviderAdapter`의 설정 변형으로 못 붙인다.** 경로(`/sandboxes` vs `/v1/instances`)·인증 헤더·create 바디·probe 상태 어휘가 전부 다르다. **새 타입 `CubeSandboxProviderAdapter: CloudProviderAdapter`가 필요**하다.

## 2.1 연산 매핑 — 필드 수준

### `create(spec, idempotencyKey) -> CloudInstanceRef`

| 우리 쪽 | CubeSandbox | 판정 |
|---|---|---|
| `POST` (엔드포인트) | **`POST /sandboxes`** (`CS:openapi.yml:55-83`) | ○ |
| 요청 바디 | `NewSandbox` (`CS:openapi.yml:1478-1540`) | |
| `endpoint.imageRef` | **`templateID` (required)** — **의미가 다르다**: OCI 이미지 참조가 아니라 **미리 빌드된 템플릿 ID**. 템플릿은 `POST /templates` 또는 `cubemastercli tpl create-from-image`로 선행 생성 | **△ 의미 다름** |
| `endpoint.instanceTimeoutSeconds` | `timeout` (int32, **초**, optional). `-1`=NEVER_TIMEOUT, `0`=즉시, 생략=클러스터 기본 | ○ (E2B는 ms, Cube는 **초** — `CS:docs/guide/lifecycle.md:21`) |
| `metadata: {momo_provision_id, momo_workspace_id}` | **`metadata` (HashMap<String,String>)** → CubeMaster `labels`로 저장. `GET /sandboxes?metadata=k=v&k2=v2`로 **AND 필터 조회 가능**(`CS:CubeAPI/src/services/sandboxes.rs:883-903`) | ○ **+ 멱등성 대체 수단** |
| `env: {MOMO_WORKD_*}` | **`envVars`** (별칭 `envs`) → `create_time_env_vars` (`CS:CubeAPI/src/services/sandboxes.rs:267`) | ○ |
| (없음) | `allow_internet_access` / `network{allowOut,denyOut,rules,allowPublicTraffic,maskRequestHost}` | **+ 추가 제공** |
| (없음) | `lifecycle{onTimeout: kill\|pause, autoResume: bool}` | **+ 추가 제공** |
| (없음) | `volumeMounts`, `distributionScope`, `mcp`, `secure` | + (단 `secure`는 **no-op**, §2.2) |
| **`Idempotency-Key` 헤더** | **없음.** `NewSandbox`에 멱등 필드 없고, CubeAPI가 `request_id`를 **서버가 생성**한다(`CS:CubeAPI/src/services/sandboxes.rs:259 new_request_id()`). 레포 전체 grep상 공개 API에 idempotency 개념 부재 | **✗ 없음 — 최대 갭** |
| 응답 201 → `{instanceId}` | 201 → `Sandbox{sandboxID, templateID, clientID, envdVersion, domain?, envdAccessToken?, trafficAccessToken?}` (`CS:openapi.yml:1613-1647`) | ○ (`sandboxID` → `CloudInstanceRef.instanceID`) |

### `pause(ref, key)`

| 우리 쪽 | CubeSandbox | 판정 |
|---|---|---|
| `POST …/pause` → 204 | **`POST /sandboxes/{sandboxID}/pause` → 204** (`CS:openapi.yml:242-274`) | ○ 완전일치 |
| — | 404 / **409 "Sandbox cannot be paused"** / 500 | 409를 우리 `CloudProviderError.instancePaused`로 접으면 **틀린다**(§2.3) |
| 흉내 금지 | **진짜 지원** — 메모리 스냅샷을 디스크에 내리고 CPU/메모리 물리 회수(`CS:docs/guide/lifecycle.md:15,168`) | ○ |

### `resume(ref, key)`

| 우리 쪽 | CubeSandbox | 판정 |
|---|---|---|
| `POST …/resume` → 200/201 | **두 개가 있다**: ① `POST /sandboxes/{id}/resume` (body `ResumedSandbox{autoPause, timeout}`) → **201 `Sandbox`**, 409 "already running" — **openapi가 `(deprecated)`로 표기**(`CS:openapi.yml:314-356`, `1576-1587`) ② `POST /sandboxes/{id}/connect` (body `ConnectSandbox{timeout}`) → **200 `Sandbox`** — paused면 내부적으로 resume 후 반환(`CS:CubeAPI/src/services/sandboxes.rs:367-399`) | ○ **단 어느 쪽을 쓸지 결정 필요** |
| resumeSemantics | **`.memory`** — *"CPU registers, process memory, TCP state …, and filesystem mutations all survive the snapshot"* (`CS:docs/guide/lifecycle.md:217`). 단 **샌드박스가 연 아웃바운드 소켓은 pause 시 끊긴다** | ○ (+ 단서 1개) |

> **권고**: `connect`를 쓴다. ⓐ `resume`이 deprecated 표기 ⓑ `connect`는 이미 running이어도 409를 안 내고 200을 준다 → **멱등에 가깝다** ⓒ 폐기된 우리 `E2BProvisioner.resume()`이 이미 `/connect`를 쓰고 있었다(아래 §2.5).

### `destroy(ref, key)` — 멱등

| 우리 쪽 | CubeSandbox | 판정 |
|---|---|---|
| `DELETE …` → 204/200/404/410 전부 성공 | **`DELETE /sandboxes/{sandboxID}` → 204** (`CS:openapi.yml:115-161`) | ○ |
| 404 = 성공 | 404 반환(`CS:CubeAPI/src/services/sandboxes.rs:724-728`) → **우리가 성공으로 접으면 멱등 성립** | ○ (어댑터 규칙으로 명문화) |
| — | **408** 동기 삭제 타임아웃 · **409** paused 샌드박스 내부 resume 정원 부족 · **503 + `Retry-After: 2\|5`** pausing 중 / 시간 부족 (`CS:openapi.yml:135-161`, `CS:docs/guide/lifecycle.md:125-134`) | **△ 추가 상태 — 재시도 시맨틱을 우리가 정해야 함** |
| — | DELETE는 **동기**다: 204는 자원 정리 완료 후에만 온다. paused 샌드박스 삭제는 내부 복원(최대 5초) 후 파괴 → **느리다** | △ 타임아웃 여유 필요 |

### `probe(ref) -> present | absent | unknown`

| 우리 쪽 | CubeSandbox | 판정 |
|---|---|---|
| `GET …/{id}` 200/404 | **`GET /sandboxes/{sandboxID}` → 200 `SandboxDetail` / 404 / 500** (`CS:openapi.yml:84-114`) | ○ |
| `state` 어휘 `running/paused/starting` → present | **`SandboxState` enum = `running \| paused \| pausing` 셋뿐** (`CS:openapi.yml:1833-1839`) | △ |
| **`unknown`은 절대 `absent`로 읽지 않는다** | ✗ **역방향 사고가 있다** — §2.3 | **✗ 위험** |
| 부가 | `SandboxDetail`이 `startedAt`, `endAt`(다음 타임아웃 예정 시각, never-timeout이면 **생략**), `cpuCount`, `memoryMB`, `diskSizeMB`, `metadata`, `volumeMounts` 제공 | **+ 추가 제공** — `endAt`은 우리 idle 정책 관측에 유용 |

## 2.2 3분류 정리

### (a) **없는 것** — 우리 계약이 요구하는데 CubeSandbox가 안 주는 것

| 없는 것 | 무게 | 대체 설계 |
|---|---|---|
| **멱등 키(create)** | **Blocker** — ADR-0142 D2 첫 줄 의무("같은 key 재호출은 같은 인스턴스"). 없으면 create 응답 유실 시 **과금되는 고아 인스턴스**가 생긴다 | **metadata 기반 재구성**: create 전에 `GET /sandboxes?metadata=momo_provision_id=<key>`로 조회 → 있으면 그 `sandboxID` 반환, 없으면 create. create 응답 유실 시 다음 시도가 조회에서 잡는다. **경합 창은 남는다**(두 요청이 동시에 조회 miss) → ADR-0140 D2의 `pg_advisory_xact_lock('momo.t3', cloud_host_id)`가 이미 **호스트 단위 직렬화**를 보장하므로 우리 쪽에서 닫힌다. **이 결합을 어댑터 주석에 못 박을 것** |
| **멱등 키(pause/resume/destroy)** | 낮음 | 이 셋은 상태 수렴형이라 재호출이 자연 멱등. destroy는 404=성공 규칙으로 완결 |
| **`terminated` 상태** | 중 | `SandboxState`에 없다 — 죽은 샌드박스는 **404로만** 표현된다. `absent` 판정은 **HTTP 404 단독**에 의존 |
| **`resuming` 상태** | 중 | 관측 불가. resume 중 probe는 `running` 또는 `pausing`으로 보인다 → 우리 `resuming` deadline은 **우리 원장이 단독으로** 관리해야 한다(이미 ADR-0140 D4가 그렇게 설계됨 — 영향 없음) |
| **`starting`/`provisioning` 상태** | 낮음 | create가 동기적으로 201을 주고 그 시점에 running이므로 문제 없음(벤치 create 지연 67ms) |
| **인스턴스 수 상한 API** | 낮음 | `maxConcurrentInstances`는 provider가 선언하지 않는다 → 우리가 **호스트 RAM에서 계산해 설정값으로** 넣는다(§2.7) |

### (b) **의미가 다른 것** — 이름은 같은데 뜻이 다른 것 ★가장 위험

| 항목 | 우리 의미 | CubeSandbox 의미 | 처방 |
|---|---|---|---|
| **`state == "running"`** | 인스턴스가 실제로 살아 있음 | **"paused가 아닌 전부"**. `sandbox_state_from_status`가 `Paused→paused`, `Running→running`, **`_ => running`**으로 접는다(`CS:CubeAPI/src/services/sandboxes.rs:917-923`). 즉 **알 수 없음/비정상도 `running`으로 보고된다** | **`running`을 살아있음의 증거로 쓰지 않는다.** presence는 HTTP 상태(200=present / 404=absent / 그 외·전송실패=unknown)로만 판정하고, **살아있음(liveness)은 workd 하트비트**(ADR-0125 fabric)를 정본으로 삼는다. 어댑터 주석에 명시 |
| **`imageRef`** | OCI 이미지 참조 | **템플릿 ID**(선행 빌드 산출물) | `CloudProviderEndpoint.imageRef`를 그대로 재사용하되 **의미를 "templateID"로 문서화**. 템플릿 생성은 운영 절차(§1.8 [7]) |
| **`timeout`** | 인스턴스 수명 상한 | **idle 타임아웃**(활동이 있으면 리셋). 활동 = SDK 호출 + 샌드박스 내부 서비스로의 HTTP 트래픽(`CS:docs/guide/lifecycle.md:176-183`) | 우리 `continuousRuntimeLimitSeconds`와 **다른 개념**. §2.7에서 분리 |
| **pause 후 타임아웃 동작** | — | `lifecycle.onTimeout` 미지정이면 **기본 `kill`** — idle하면 **삭제된다** | 우리는 T3 세션을 idle로 죽이지 않고 **우리 sweep이 판단**한다(ADR-0139/0141). → create 시 **`lifecycle: {onTimeout: "pause", autoResume: false}`를 명시**하거나 `timeout: -1`(NEVER_TIMEOUT). **기본값에 맡기면 우리 원장 몰래 인스턴스가 사라진다** |
| **`autoResume`** | — | true면 CubeProxy가 요청 도착 시 **우리 모르게 resume** | **`false` 고정.** resume은 우리 durable intent를 지나야 한다(ADR-0140 D4). 자동 resume은 원장에 없는 상태 전이를 만든다 |
| **409 (pause)** | `instancePaused`(이미 paused) | "cannot be paused" — **이유가 합쳐져 있다** | 409를 `instancePaused`로 접지 말고 **재조회 후 판정**. `pausing` 중일 수도 있음 |
| **409 (DELETE)** | — | paused 샌드박스 내부 resume이 **노드 정원 부족**으로 거부 | `destroy` 실패로 취급하고 **재시도**(ADR-0140 D4 `destroy_pending` 무한 재시도에 그대로 부합) |
| **`secure`** | — | **파싱되지만 사용되지 않는다** — `create_sandbox`의 destructuring이 `secure`를 읽지 않는다(`CS:CubeAPI/src/services/sandboxes.rs:154-165`) | 보내지 않는다(no-op에 의미를 부여하면 안 됨) |
| **알 수 없는 요청 필드** | — | `NewSandbox`에 `deny_unknown_fields` 없음(`CS:CubeAPI/src/models/mod.rs:178-226`) → **오타 필드가 조용히 무시된다** | 어댑터 계약 테스트가 **응답으로** 효과를 확인해야 한다(요청이 200이라고 반영된 것 아님) |

### (c) **추가로 주는 것** — 우리 계약에 없지만 값이 있는 것

| 추가 | 우리에게 쓸모 | ADR 충돌 검토 |
|---|---|---|
| `POST /sandboxes/{id}/snapshots` + `POST /sandboxes/{id}/rollback` + `GET /snapshots` | 클론/롤백 | **쓰지 않는다.** ADR-0142 D3.2 — 연속성의 원본은 git+원장이고 스냅샷은 최적화. ADR-0156 D5도 부속 컴포넌트 배제. **어댑터 표면에 넣지 않는 것 자체가 결정** |
| `POST /sandboxes/{id}/timeout`, `/refreshes` | idle 시계 연장 | **선택적 사용 가능**. 다만 우리는 `timeout: -1`로 CubeSandbox의 idle 회수를 아예 끄는 쪽이 단순(§2.7) |
| `network{allowOut, denyOut, rules(L7), allowPublicTraffic, maskRequestHost}` + `allow_internet_access` | **egress 통제** | ADR-0150 계열 별건. **v0에서는 workd가 momo 서버로 나가야 하므로 인터넷 허용**. 단 정밀 통제 수단이 존재한다는 사실을 ADR-0150에 입력 |
| `volumes` / `volumeMounts` (`/volumes` CRUD) | 영속 스토리지 | v0 미사용 |
| `GET /sandboxes/{id}/logs`, `/v2/…/logs` (구조화 로그) | 진단 | **운영 진단에 유용.** 어댑터 표면 밖(운영 도구)에 둔다 |
| `SandboxDetail.endAt` / `cpuCount` / `memoryMB` / `diskSizeMB` | 관측·과금 교차검증 | probe 확장으로 **선택적** 노출 가치 있음. 단 `CloudInstancePresence`는 3값 유지 |
| `GET /health` (인증 면제) | 데몬 헬스 | 프로비저너 preflight에 사용 |
| **`AUTH_CALLBACK_URL` 위임 인증** | **우리가 인증 주체가 된다** | **ADR-0004에 유리** — 외부 provider 자격증명이 존재하지 않는다. `MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY`는 **우리가 발급해 우리 콜백이 검증하는 값**이 된다 |
| `/templates` 전체 CRUD + 빌드 잡/로그/상태 | 템플릿 자동화 | **v0 수동**(런북 [7]). 자동화는 후속 |

## 2.3 probe 상태 매핑 확정안 (Blocker 처방)

```
GET /sandboxes/{id}
 ├─ 전송 실패 / 타임아웃          → .unknown       (절대 absent 아님 — ADR-0142 D3.1)
 ├─ 404                          → .absent
 ├─ 5xx / 4xx(404 외)            → .unknown
 └─ 200
     ├─ state == "paused"        → .present  (+ paused 사실)
     ├─ state == "pausing"       → .present  (+ 전이 중)
     └─ state == "running"       → .present  (⚠ liveness 증거 아님)
```

그리고 **어댑터 주석에 박을 부정형 한 줄**:

> *"`state == "running"`은 CubeAPI가 paused 아닌 모든 내부 상태를 접어 만든 값이다(`CubeAPI/src/services/sandboxes.rs:917-923`). 이 값을 인스턴스가 정상 동작 중이라는 증거로 쓰지 않는다. 살아있음의 정본은 workd 하트비트다."*

수용기준(테스트 가능): **fake 상류가 200 + `{"state":"running"}`을 주는 동안 workd 하트비트가 끊긴 시나리오에서, 수렴이 `running` 유지가 아니라 ADR-0139/0141의 orphan 경로로 간다**는 것을 단정.

## 2.4 E2B SDK 호환의 실체 — "어느 SDK 표면과 호환인가"

**답: E2B의 *컨트롤 플레인 REST 표면*과 필드명까지 호환이고, 그 위에서 E2B **Python** SDK(`e2b`, `e2b-code-interpreter`)가 그대로 돈다. 완전 호환은 아니며 로드맵에 "남은 갭 닫기"가 열려 있다.**

근거(전부 1차):

1. **모델 주석이 직접 말한다**: *"Request body for POST /sandboxes — **Field names match exactly what the E2B SDK sends.** … `allow_internet_access` is a known SDK snake_case quirk … `envs` is accepted as a compatibility alias for E2B SDK callers"* (`CS:openapi.yml:1480-1487`, `CS:CubeAPI/src/models/mod.rs:171-177`)
2. **응답 모델도 E2B 스펙 기준**: *"All ID abbreviations uppercase per E2B OpenAPI spec"*, `SandboxLogs` = *"Legacy log response — matches E2B SandboxLogs schema"* (`CS:openapi.yml:1615-1617`, `1771`)
3. **lifecycle 객체가 E2B의 그것**: *"Mirrors the e2b SDK's `lifecycle` object — see https://e2b.dev/docs/sandbox/auto-resume"* (`CS:openapi.yml:1717-1725`)
4. **사용법이 문자 그대로 E2B SDK**: `pip install e2b-code-interpreter` + `E2B_API_URL`/`E2B_API_KEY`만 바꾸고 `from e2b_code_interpreter import Sandbox` (`CS:docs/guide/quickstart.md:231-274`)
5. **인증도 E2B SDK 관례 수용**: *"The E2B SDK passes the value of `E2B_API_KEY` as `Authorization: Bearer <key>`"*, `X-API-Key`도 동등 수용 (`CS:docs/guide/authentication.md:41-55`)
6. **양방향 회귀 스위트가 실재**: `tests/e2e/sdk_compat/`가 `SDK_E2E_BACKENDS=e2b,cubesandbox`로 **같은 테스트를 두 백엔드에 돌린다**. 어댑터 2종(`e2b_adapter.py`, `cubesandbox_adapter.py`) + lifecycle/commands/filesystem/run_code/network/concurrency/volume 케이스 (`CS:tests/e2e/sdk_compat/docs/test-coverage.md`)

**호환이 아닌 것(자인)**:
- 로드맵 *"E2B API Compatibility — Close the **remaining gaps** … The goal is full drop-in compatibility"* → **아직 아니다**(`CS:docs/guide/roadmap.md:15-17`)
- `platform_lifecycle` 케이스는 **E2B 백엔드가 아직 비활성** — *"its lifecycle create parameters must be aligned with the CubeAPI create fields"*(PR #988 추적) (`CS:tests/e2e/sdk_compat/docs/test-coverage.md` §2.1)
- 단위 차이: E2B `timeoutMs`(ms) vs Cube `timeout`(초) (`CS:docs/guide/lifecycle.md:21`)
- E2B의 하드 상한(Pro 24h / Base 1h)이 **Cube에는 없다** (`CS:docs/guide/lifecycle.md:77`)
- **자체 SDK도 있다**: `sdk/{go,node,python}` — `cubesandbox` 패키지. 우리는 REST 직접 호출 예정이라 무관

**우리에게 의미**: 우리가 만드는 것은 "E2B 어댑터"가 아니라 **"E2B REST 방언을 말하는 self-host 기질용 어댑터"**다. E2B 클라우드 재검토(ADR-0142 D4 옵션)로 돌아갈 때 **같은 어댑터가 base URL 교체만으로 상당 부분 재사용**된다 — 이건 계획에 없던 옵션 가치다.

## 2.5 폐기 예정 E2B 잔재의 재활용 범위 — **실측 결과: 거의 전부**

### 현재 잔재 인벤토리

| 위치 | 상태 | 재활용 |
|---|---|---|
| 라이브 코드의 `e2b` 문자열 | **3개 파일뿐** (`server/Migrations/045_…sql`, `049_…sql`, `054_t3_provider_registry.sql`) — 전부 **주석·과거 CHECK 제약 설명** | 없음(역사 기록) |
| `server/Sources/MomoServer/Cloud/E2BProvisioner.swift` | **삭제됨** (`716ea9e3`에서 제거, `e23688fd` "provider 어댑터 + E2B 제거 + BYOC 등록 공식화 (MOMO-670, #897)"로 완결) | **★핵심 — 아래** |
| `scripts/mock_e2b.py` | **삭제됨** (`e23688fd`) → `scripts/mock_provider.py`로 일반화 | mock 하니스는 이미 승계됨 |
| `CloudProviderKit` | 신규 — E2B 잔재 아님 | D4-③의 확장 지점 |

### `E2BProvisioner.swift`(삭제본, `git show 716ea9e3^:server/Sources/MomoServer/Cloud/E2BProvisioner.swift`) vs CubeSandbox

| 삭제된 코드가 보내던 것 | CubeSandbox가 받는 것 | 판정 |
|---|---|---|
| `POST /sandboxes` | `POST /sandboxes` | **일치** |
| body `{templateID, timeout, autoPause, secure, metadata, envVars}` | `NewSandbox{templateID, timeout, secure, metadata, envVars, …}` | **`autoPause` 1개만 불일치** (Cube는 `lifecycle{onTimeout,autoResume}` — 게다가 unknown field라 **조용히 무시**됨) |
| 201 → `{sandboxID}` | 201 → `Sandbox{sandboxID, …}` | **일치** |
| `POST /sandboxes/{id}/pause` → 204 | 동일 → 204 | **일치** |
| resume = `POST /sandboxes/{id}/connect` body `{timeout}` → 200/201 | `connect` body `ConnectSandbox{timeout}` → 200 | **일치** (게다가 Cube에서 `connect`가 권장 경로 — §2.1) |
| `DELETE /sandboxes/{id}` → 204 | 동일 → 204 | **일치** |
| header `X-API-Key` | **1급 수용**(Bearer와 동등) | **일치** |
| header `Idempotency-Key: <provisionID>` | **무시됨** | **✗ 유일한 구조적 결손** |
| `safeID()` 정규식 `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` | Cube sandboxID 예: `iiny0783cype8gmoawzmx-ce30bc46` | **통과** (`CS:docs/guide/lifecycle.md:86`) |
| envVars `MOMO_WORKD_*` | `FORBIDDEN_ENV_NAMES`(LD_PRELOAD/PATH/PYTHONPATH 등, `CS:CubeAPI/src/services/sandboxes.rs:40-53`)에 **미저촉** | 통과 |
| **`probe` 없음** | `GET /sandboxes/{id}` 있음 | ADR-0142 D2가 추가한 의무 — **신규 작성** |

> **재활용 판정: `E2BProvisioner`의 HTTP 골격(경로·바디·상태코드·헤더·collect/safeID 헬퍼)을 그대로 `CubeSandboxProviderAdapter`로 되살릴 수 있다.** 새로 써야 하는 것은 ① `probe` ② 멱등 재구성(metadata+list) ③ `lifecycle`/`timeout` 정책 ④ 409/503/408 처리 — 4가지뿐. 리서치가 "폐기 예정이던 코드가 어댑터 초안이 된다"고 쓴 것은 **실측으로 확인**되며, 예상보다 일치도가 높다(경로 4/4, 상태코드 4/4, 헤더 1/1).

## 2.6 ADR-0140 D4 수렴표 ↔ CubeSandbox 응답 대조

| ADR-0140 D4 국면 | CubeSandbox 신호 | 어댑터 매핑 |
|---|---|---|
| `pausing` 실패/타임아웃 → `running` 복귀 | pause 500 / 전송실패 | `revert` (probe로 재확인) |
| `pausing` + 인스턴스 **부재** → `t3_terminate('provider_missing')` | pause **404** | `terminate` |
| `pausing` + 409 | "cannot be paused" — 이유 미분화 | **재조회 후 판정**: 200/paused면 `confirm`, 200/running이면 `revert`, 404면 `terminate` |
| `resuming` 실패/타임아웃 → `paused` 복귀 | connect 500 / 전송실패 | `revert` |
| `resuming` + provider 404/410 → terminate | connect **404** | `terminate` |
| `resuming` + 409 "already running" | resume(deprecated) 경로에서만 발생. `connect`는 200 | `connect` 사용으로 소거 |
| `destroy_pending` 실패 → **무한 재시도** | DELETE 408 / 409 / **503 + `Retry-After`** / 500 | `retry`. **`Retry-After` 헤더를 백오프 힌트로 존중**(2초/5초) |
| destroy 성공 | 204 **또는 404** | `confirm` |
| intent deadline 초과 → provider 상태 조회 | `GET /sandboxes/{id}` | probe 3값 → §2.3 표 |
| `unknown`을 `absent`로 읽지 않음 | 전송실패·5xx | `.unknown` → 수렴 보류 |

**신규 요구 1건**: `Retry-After` 존중은 우리 어댑터 계약에 지금 없다. `CloudProviderError`에 `case retryAfter(Int)`를 더하거나, 재시도 백오프를 호출자가 계산하는 현행을 유지하되 **503을 `upstreamStatus(503)`로 흘려보내고 reconciler 백오프에 맡기는** 것도 성립. **후자 권고**(계약 표면을 늘리지 않음).

## 2.7 capability 선언 값 초안

`CloudProviderRegistry.descriptors`에 추가할 항목(`/Users/kwakseongjae/projects/momo/services/CloudProviderKit/Sources/CloudProviderKit/CloudProviderRegistry.swift:23-47` 형식):

```swift
public static let cubeSandboxProviderID = "cubesandbox"

cubeSandboxProviderID: CloudProviderCapabilities(
    providerID: cubeSandboxProviderID,
    managesInstanceLifetime: true,     // create/destroy 있음
    supportsPause: true,               // 흉내 아님 — 진짜 메모리 스냅샷
    resumeSemantics: .memory,          // CPU 레지스터·프로세스 메모리·TCP 상태·FS 보존
    continuousRuntimeLimitSeconds: nil,// 상한 없음(E2B의 24h/1h 같은 천장 부재)
    pauseSecondsPerGiB: 0.2,           // 실측 370.8ms/2GiB ≈ 0.19 → 0.2로 보수 반올림
    maxConcurrentInstances: nil        // provider가 선언 안 함 → 설정으로 주입(아래)
)
```

| 필드 | 값 | 근거 | 신뢰도 |
|---|---|---|---|
| `providerID` | `"cubesandbox"` | `054` CHECK `^[a-z0-9][a-z0-9-]{0,31}$` 통과 (`server/Migrations/054_t3_provider_registry.sql:26-27`) | 확정 |
| `managesInstanceLifetime` | `true` | `POST /sandboxes` + `DELETE /sandboxes/{id}` | 확정 |
| `supportsPause` | `true` | `POST …/pause` 204, `SandboxState.paused` | 확정 |
| `resumeSemantics` | `.memory` | *"CPU registers, process memory, TCP state (with no external peer), and filesystem mutations all survive"* (`CS:docs/guide/lifecycle.md:217`) | 문서 확정 / **D4-② 실측 필요**(U4) |
| `continuousRuntimeLimitSeconds` | **`nil`** | *"Cube doesn't impose hard wall-clock ceilings (24h Pro / 1h Base) the way hosted e2b does"* (`CS:docs/guide/lifecycle.md:77`). idle TTL은 **우리가 요청마다 지정**하므로 provider 상한이 아님 | 확정 |
| `pauseSecondsPerGiB` | **`0.2`** | 1st-party PVM 벤치 pause 직렬 370.8 ms @ 2 GiB (`perf-benchmark-pvm.md` §4.6). **현재는 full-memory-copy 모드**이고 soft-dirty 증분이 오면 **더 빨라진다**(80~90% 감소 예고) → 이 값은 **상한 성격** | 실측 기반 / 릴리스 따라 하향 가능 |
| `maxConcurrentInstances` | **`nil`(레지스트리) + 설정 주입** | provider API가 선언하지 않는다. 호스트 RAM에서 계산: `(RAM_GB − 7 − 여유) ÷ 세션당_GiB`. 32 GiB·2 GiB 세션이면 **~10** (`perf-benchmark-pvm.md` §3.3 산식) | **운영 파라미터** — 레지스트리 상수로 박으면 하드웨어를 바꿀 때 코드를 고쳐야 한다 |

> **`maxConcurrentInstances` 처리 권고 (설계 결정 필요)**: 현재 `CloudProviderCapabilities`는 **컴파일 타임 상수**다(`CloudProviderRegistry`). CubeSandbox는 그 값이 **호스트 사양에 따라 달라지는** 첫 provider다. 두 갈래:
> - **(가) 설정 주입** — `MOMO_T3_PROVIDER_CUBESANDBOX_MAX_CONCURRENT`를 `CloudProviderSettings`가 읽어 capabilities를 **런타임 합성**. `CloudProviderRegistry.capabilities(for:)`가 순수 상수라는 현행 성질이 깨진다.
> - **(나) 레지스트리에 보수적 상수** — 예: `10`. 하드웨어를 키워도 못 늘린다.
> **(가) 권고.** ADR-0142 D2의 취지("정책 코드가 provider 상수를 모른다")는 값의 출처가 설정이어도 지켜진다. **이건 ADR-0142 D2의 미세 확장이므로 D4-③ 티켓에서 성재 확인 필요.**

**어댑터 설정 네임스페이스**(`CloudProviderSettings.environmentNamespace` 규칙상 자동 도출):

| 환경변수 | 값 | 비고 |
|---|---|---|
| `MOMO_T3_PROVIDER` | `cubesandbox` | 신규 managed 호스트의 기본 어댑터 |
| `MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL` | `http://<전용호스트-사설IP>:3000` | **http 허용됨**(`CloudProviderSettings.swift:96-100`) — 사설망 전제. 공개망 노출 시 TLS 필수 |
| `MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY` | 우리가 발급한 값 | CubeAPI `AUTH_CALLBACK_URL`이 **우리 콜백**으로 검증 → **외부 provider 자격증명 없음(ADR-0004 무저촉)** |
| `MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF` | **템플릿 ID** (`tpl-…`) | 이름은 `IMAGE_REF`지만 의미는 templateID — 문서화 필요 |
| `MOMO_T3_PROVIDER_CUBESANDBOX_INSTANCE_TIMEOUT_SECONDS` | (미사용 권고) | 아래 |

**idle 타임아웃 정책 결정(권고)**: create 시 **`timeout: -1`(NEVER_TIMEOUT) + `lifecycle` 생략**. 이유 — CubeSandbox의 idle 회수는 우리 원장 밖에서 인스턴스를 죽이는 **제2의 수명주기 주체**가 된다. ADR-0140의 "단일 문"(t3_terminate) 원칙과 충돌한다. 회수는 우리 sweep(ADR-0139/0141)이 단독으로 한다. **단 방어선으로 클러스터 기본값이 `-1`인지 확인**(`CubeMaster/conf.yaml: default_timeout_insec`, 레포 기본 `-1` — `CS:docs/guide/lifecycle.md:206-213`). 이 결정은 **`INSTANCE_TIMEOUT_SECONDS` 설정을 사실상 사용하지 않게** 만든다 → 기존 `CloudProviderEndpoint` 필드는 남기되 이 어댑터는 무시.

**⚠ 반대 논거도 기록**: `timeout: -1`이면 momo 서버/워커가 통째로 죽었을 때 CubeSandbox 쪽에 **영원히 사는 좀비 인스턴스**가 남는다(우리 원장이 유일한 회수 주체이므로). 절충안 = `timeout`을 우리 orphan 판정 시간의 **수 배**로 크게 잡고 `lifecycle.onTimeout: "kill"`을 **최후 안전망**으로 두는 것. **이 트레이드오프는 D4-③에서 성재/오케스트레이터 결정 사항**으로 올린다.

---

# 3. 성재 발주 체크리스트

## 3.1 결정해야 하는 것 (선택지 제시)

| # | 결정 | 선택지 | **권고** |
|---|---|---|---|
| D-1 | **모드** | (A) 일반 클라우드 VM + PVM 커널 교체 / (B) 베어메탈·중첩가상화 VM(커널 교체 없음) | **A** — 조달 가능성. 단 B가 같은 값에 조달되면 B가 운영이 훨씬 싸다(커널 추적 부담 0, 멀티노드 확장 가능) |
| D-2 | **RAM** | 8 GB(설치 통과 하한) / **32 GB** / 64 GB | **32 GB.** 8 GB는 스택 베이스라인 ~7 GB로 실사용 불가. 32 GB = 2 GiB 세션 **동시 ~10개** |
| D-3 | **vCPU** | 4 / **8~16** | **8 이상** (1st-party 권장 16C, 벤치 환경 16C) |
| D-4 | **디스크** | 시스템 50 GB + **데이터 디스크 100~200 GB 별도** | **시스템 50 GB + 데이터 200 GB.** 데이터 디스크는 **XFS로 포맷해 `/data/cubelet`에 마운트**(필수 게이트). 템플릿을 여러 개 빌드하면 200 GB 권장 |
| D-5 | **OS** | OpenCloudOS 9 / TencentOS 4 / **Ubuntu 22.04 or 24.04** / RHEL·Rocky 9 | NCP 카탈로그에 OpenCloudOS가 없을 가능성이 높다 → **Ubuntu 22.04 LTS**(glibc 2.35, tested). 단 ⓐ XFS 수동 준비 ⓑ `multipathd`의 cgroup `+cpu` 차단 함정 ⓒ DEB 커널 패키지 경로 |
| D-6 | **아키텍처** | **x86_64 고정** | PVM이 ARM 미지원. ARM 인스턴스가 싸도 A 모드에서는 불가 |
| D-7 | **네트워크** | VPC 대역이 `192.168.0.0/18`과 **비충돌**하도록 | 충돌 시 설치 실패. `CUBE_SANDBOX_NETWORK_CIDR`로 회피 가능하나 사전 회피가 쌈 |
| D-8 | **콘솔 접근** | VNC/시리얼 콘솔 확보 여부 | **필수**. 커널 교체 후 부팅 실패 시 SSH가 안 열린다. NCP 콘솔 접근 가능 상품인지 발주 전 확인 |
| D-9 | **egress** | GitHub + `*.tencentcloudcr.com` 아웃바운드 허용 | 설치·이미지 pull에 필요 |
| D-10 | **격리** | PG=SoT 박스와 **물리 분리** (ADR-0156 D3) | 이미 결정됨. §1.4의 `pti=off` 등이 근거를 강화 |

## 3.2 발주 사양 한 줄 (권고안)

> **x86_64 / 8~16 vCPU / 32 GB RAM / 시스템 디스크 50 GB + 데이터 디스크 200 GB(별도) / Ubuntu 22.04 LTS / 사설 IP + 콘솔 접근 / VPC 대역 192.168.0.0/18 회피 / 인터넷 아웃바운드 허용 / oort PG 박스와 물리 분리**

## 3.3 발주 후 즉시 확인할 것 (D4-② 첫 30분)

1. `uname -m` = x86_64, `ldd --version` ≥ 2.31, `free -g` ≥ 32
2. `grep -w bpf /proc/filesystems` (eBPF 지원)
3. `stat -fc %T /sys/fs/cgroup` = `cgroup2fs` 이고 `cat /sys/fs/cgroup/cgroup.controllers`에 `cpu` 포함
4. 데이터 디스크 존재 → `mkfs.xfs` 가능
5. **콘솔 접근 실제로 열리는지 미리 시험** (커널 교체 전에)
6. `ip route` — `192.168.0.0/18` 충돌 여부

---

# 4. D4-③ 어댑터 티켓 초안

## 4.1 티켓 A — `cubesandbox` provider 어댑터 (엔진 트랙)

**제목**: T3 managed provider `cubesandbox` 어댑터 — ADR-0156 D2 구현체

**범위**: `services/CloudProviderKit/` 안에서 완결. reconciler·REST·sweep·마이그레이션 **무변경**(ADR-0140/0142가 이미 provider-일반형).

**산출물**
1. `CloudProviderRegistry`에 `cubesandbox` descriptor 추가 (§2.7 값)
2. `CubeSandboxProviderAdapter: CloudProviderAdapter` 신규 (`HTTPCloudProviderAdapter` **설정 변형으로는 불가** — 경로/헤더/바디/상태어휘 전부 다름)
3. `CloudProviderSettings`에 `maxConcurrentInstances` 런타임 주입 경로(§2.7 (가)안 — **성재 확인 후**)
4. mock 상류(fake CubeAPI)를 이용한 계약 테스트 — 실기동 불요
5. 운영 문서 1편: 설치 런북(§1.8) + 하드닝 + 템플릿 생성

**수용기준 (전부 부정형·testable로 쓸 것)**

| # | 수용기준 | 성격 |
|---|---|---|
| A1 | create가 `POST /sandboxes`에 `{templateID, timeout, metadata:{momo_provision_id, momo_workspace_id}, envVars:{MOMO_WORKD_*}}`를 보내고 201의 `sandboxID`를 `CloudInstanceRef.instanceID`로 반환한다. `secure`·`autoPause`는 **보내지 않는다** | 정형 |
| A2 | **같은 `idempotencyKey`로 create를 두 번 부르면 상류에 create 요청이 1번만 간다.** 2회차는 `GET /sandboxes?metadata=momo_provision_id=<key>`가 찾아낸 기존 인스턴스를 반환한다 | **red proof: 조회 단계를 제거하면 상류 create 호출이 2회로 늘어 실패** |
| A3 | create 응답이 유실된(상류가 201을 만들고 연결이 끊긴) 시나리오에서, 재시도가 **새 인스턴스를 만들지 않는다** | 시뮬레이션 가능(fake 상류가 201 후 응답 폐기) |
| A4 | probe가 §2.3 표 그대로 매핑한다. **전송 실패·5xx는 `.absent`가 아니라 `.unknown`** | red proof: `.unknown`→`.absent`로 바꾸면 실패 |
| A5 | **`state=="running"` 200 응답만으로는 어떤 정산·수렴도 트리거되지 않는다** — liveness 정본은 workd 하트비트 | 부정형 |
| A6 | destroy가 **204·200·404를 전부 성공**으로 접고, 408·409·503·5xx는 `retry`로 남긴다(포기 없음) | 정형 |
| A7 | destroy 503 응답의 `Retry-After` 값이 로그에 기록된다(백오프 힌트) | 관측 |
| A8 | resume은 **`/connect`**를 쓴다. `/resume`(deprecated)은 호출하지 않는다 | 정형 |
| A9 | pause 409 수신 시 **즉시 `instancePaused`로 접지 않고** probe로 재판정한다 | 부정형 |
| A10 | 어댑터가 **snapshot/rollback/clone/volume/template CRUD를 호출하지 않는다** (ADR-0142 D3.2 · ADR-0156 D5) | **grep 가능한 부정형**: 어댑터 소스에 `/snapshots`·`/rollback`·`/volumes`·`/templates` 문자열 0건 |
| A11 | provider API 키가 워크스페이스 행·응답·로그에 **등장하지 않는다**(ADR-0004) — 기존 계약 유지 | 기존 |
| A12 | capabilities가 §2.7 값과 일치하고, **정책 코드 어디에도 `"cubesandbox"` 리터럴이 없다**(레지스트리·설정 로딩 제외) | **grep 가능한 부정형** |
| A13 | 기존 `mock-a`/`mock-b` 계약 테스트와 **동형의** 스위트가 `cubesandbox` fake 상류에도 green (ADR-0142 D3 연속성 검증기 포함) | 동형성 |
| A14 | `MOMO_T3_ENABLED` 미설정 시 어댑터가 로드되지 않고 T3는 503 유지 (ADR-0140 이행 7) | 기존 |

**명시적 비범위**: 실기동·성능 검증(D4-②) · 프로비저너 연동(D4-④) · egress 정책(ADR-0150) · 템플릿 자동 빌드 · 멀티노드.

## 4.2 티켓 B — 전용 호스트 실기동 스파이크 (D4-②, 티켓 A와 병렬 가능한 부분 있음)

**전제**: 성재 호스트 확보 후. **A와 병렬 가능** — A는 fake 상류로 진행되므로 호스트를 기다리지 않는다.

**수용기준(스파이크라 산출물 기준)**
1. §1.8 런북을 실행해 **U1(NCP에서 PVM 커널 부팅)** 판정 — 성공/실패 어느 쪽이든 런북에 실측을 되먹인다
2. U3 디스크 실점유 측정 (설치 전/후, 템플릿 1개 빌드 후)
3. **oort-workd 템플릿을 실제로 빌드**하고 template_id 확보
4. U4: create→pause→resume 후 **프로세스 트리·파일 시스템 보존** 확인 (`examples/code-sandbox-quickstart/auto-resume.py` 응용)
5. pause 실측 시간으로 `pauseSecondsPerGiB` 검증/보정
6. 동시 인스턴스 상한 실측 → `maxConcurrentInstances` 설정값 확정
7. 하드닝 적용 후 **외부에서 3000/8089/9999/12088가 닫혀 있음**을 외부 호스트에서 확인

**실패 시 되돌아갈 곳**: U1 실패(PVM 커널이 NCP에서 안 뜸)면 → D-1을 B(베어메탈)로 재발주하거나 ADR-0156 D3을 개정. **이 분기를 티켓에 미리 적어 둘 것.**

## 4.3 순서와 병렬성

```
[티켓 A: 어댑터 + 계약테스트]  ──┐   (fake 상류 — 호스트 불요, 지금 착수 가능)
                                 ├─→ [D4-④ 프로비저너 연동] → ADR-0140 게이트(T-2~T-4 + 실 smoke) → T3 활성화
[성재 발주] → [티켓 B: 실기동] ──┘
```

---

## 부록 A — 이 문서가 뒤집은 선행 리서치 항목 정리 (검수용)

| 선행 리서치 | 이 문서 | 변경 성격 |
|---|---|---|
| §1.5 "x86_64 Linux + KVM" | PVM만 x86_64 전용, aarch64는 bare-metal 경로로 지원 | **정정** |
| §1.5 "RAM≥8GB·디스크≥50GB" | 설치 하한이며 실사용선 아님. 실측 베이스라인 ~7 GB → 32 GB 권고 | **강화** |
| §1.5 "MySQL+Redis+containerd+CoreDNS 신규 운영 표면" | 정확. 여기에 **무인증 기본값·약한 기본 비밀번호·0.0.0.0 바인드**를 추가 | **보강** |
| §1.4 "API가 D2 계약과 1:1" | 연산 5/5 대응은 맞으나 **멱등 키 부재**와 **probe 상태 lossy** 2개 결손 | **정정(중요)** |
| §1.4 "E2B SDK 호환 표방" | 실체 = E2B REST 표면 + Python SDK 호환, 양방향 회귀 스위트 실재. 단 **완전 호환 아님(로드맵 진행 중)** | **구체화** |
| §1.4 "폐기 예정 E2B 클라이언트가 어댑터 초안" | **실측 확인** — 경로 4/4·상태코드 4/4·헤더 1/1 일치. 신규 필요분은 4가지 | **확인** |
| §4.6 "PVM 부팅 미확인" | 여전히 미확인이나 **1st-party PVM 벤치(표준 CVM)**가 존재해 "된다"의 증거 등급이 올라감. NCP 특정은 U1로 남음 | **부분 해소** |
| §4.6 "성능 주장 미검증" | 1st-party 실측표 확보(create/pause/resume/snapshot/density, 베어메탈+PVM 2세트). **우리 환경 실측은 여전히 D4-②** | **부분 해소** |
| (신규) | GRUB 부트 파라미터가 `pti=off` 등 **투기실행 완화를 일부 끈다** | **신규 발견** |
| (신규) | 멀티노드 compute 노드는 **중첩가상화 미지원 = 베어메탈 필요** | **신규 발견** |
| (신규) | CubeAPI 기본 **무인증 전면 허용** + `AUTH_CALLBACK_URL`로 우리가 인증 주체가 됨(ADR-0004에 유리) | **신규 발견** |
| (신규) | `secure` 필드는 **파싱되고 무시된다**(no-op) | **신규 발견** |

## 부록 B — 재현 명령

```bash
git clone --depth 50 https://github.com/TencentCloud/CubeSandbox.git
cd CubeSandbox && git rev-parse HEAD    # 이 문서 기준: 5cefcca27a7fbd38eb7921cd66b340320e559d0f
gh api repos/TencentCloud/CubeSandbox/releases/tags/v0.6.0 -q '.assets[] | "\(.name)\t\(.size)"'

# oort 쪽
git -C /Users/kwakseongjae/projects/momo show 716ea9e3^:server/Sources/MomoServer/Cloud/E2BProvisioner.swift
```
