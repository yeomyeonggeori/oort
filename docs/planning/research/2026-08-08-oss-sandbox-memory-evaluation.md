# 오픈소스 3종 비판 평가 — CubeSandbox · TencentDB-Agent-Memory · vibesdk

- 작성: 리서치 워커 (2026-08-08), momo(oort) 문맥
- 방법: GitHub API + 원본 파일 직접 판독(LICENSE 원문·openapi.yml·package.json·drizzle config·소스 코드·deploy 스크립트). 2차 출처 미사용. README 주장은 전부 파일로 교차검증.
- 레포 상태 스냅샷: 2026-08-08

---

## 0. 판정 요약

| 레포 | 라이선스(실측) | 유지보수 실태 | 불변식 충돌 | **판정** |
|---|---|---|---|---|
| **CubeSandbox** | Apache-2.0 (원문 확인, 부가 제약 **없음**) | 건강 — merged PR 651, 기여자 분산, v0.6.0(2026-07-24) | 없음 (자격증명·SoT 무관) | **의존성 도입 후보 — 조건부 보류**(게이트 3개) + 즉시 패턴 차용 |
| **TencentDB-Agent-Memory** | MIT (원문 확인, 부가 제약 없음) | **불량** — open PR 459 vs merged 47, 기본 브랜치가 feature 브랜치 | **ADR-0004 위반 · PG=SoT 위반 · RLS 위반 · 단일 쓰기경로 위반 (4중)** | **배제** + 좁은 패턴 차용(추출 프롬프트·랭킹) |
| **vibesdk** | MIT | 활발하나 **버스팩터 1**(806/938 = 86%) | self-host 불가(Cloudflare 전면 종속) | **배제** (최저 우선순위) |

**한 줄**: 샌드박스 빈자리는 CubeSandbox가 실제로 메울 수 있다(단 인프라 비용이 지금 감당범위 밖 — 게이트 걸고 대기). 메모리 층은 3종 중 어느 것도 쓸 수 없고, **ADR-0129의 기존 설계가 이미 정답**임이 이번 실측으로 오히려 독립 검증됐다.

---

## 1. CubeSandbox (TencentCloud/CubeSandbox)

### 1.1 실체 — 주장과 실측이 일치한다

README 주장("RustVMM + KVM 기반 하드웨어 격리 MicroVM")은 **코드 구조로 뒷받침된다**. 추측이 아니라 트리 실측:

- 전체 3,781 파일. 루트 컴포넌트: `CubeAPI` `CubeMaster` `Cubelet` `CubeShim` `CubeNet` `CubeProxy` `CubeEgress` `CubeDB` `CubeOps` `hypervisor` `guest-init` `cube-lifecycle-manager`.
- 격리 기술 = **KVM MicroVM**. 컨테이너·gVisor 아님. LICENSE 파일이 이를 교차 증명한다 — 번들 의존성으로 **kata-containers**(Apache-2.0, Tencent 수정)와 **cloud-hypervisor**(Apache-2.0, Tencent 수정)가 명시돼 있다. 즉 cloud-hypervisor(RustVMM 계열) 기반 microVM이 맞다.
- 구현 언어 = **Rust** 주력 (`containerd-shim-cube-rs`, `cube-runtime`). 우리 `server-rust` 스택과 정합.
- 게스트마다 전용 커널이 뜨는 진짜 VM 경계 → 신뢰 경계가 우리가 T3에 원하는 수준(사용자 코드 실행)에 부합.

### 1.2 라이선스 — **Apache-2.0, 깨끗함** (실측)

GitHub API가 `license.spdx_id: NOASSERTION`을 반환해서 최초에 "커스텀 제약 의심" 신호였으나, **LICENSE 원문 468줄을 직접 내려받아 확인한 결과 순수 Apache-2.0**이다. NOASSERTION의 원인은 제약 조항이 아니라 **제3자 고지가 덧붙어 파일이 길어져 GitHub licensee가 자동 매칭에 실패**한 것.

- 본문: Apache-2.0 전문 (Copyright 2026 Tencent)
- 부록: kata-containers(Apache-2.0), cloud-hypervisor(Apache-2.0), cilium/bpf(**BSD-2-Clause OR GPL-2.0 듀얼 → BSD-2-Clause 선택 명시**)
- `grep -i "additional term|commercial|restrict|territor"` → **자체 부가 제약 0건**. 매칭된 줄은 전부 Apache-2.0 표준 문구(§4 재배포, §6 상표, §8 책임제한).
- cilium/bpf가 GPL-2.0이 아니라 **BSD-2-Clause를 선택했다고 명시**한 점이 중요 — AGPL/GPL 백본 금지 원칙에 걸리지 않는다.

**→ permissive 통과. 라이선스는 이 레포의 탈락 사유가 아니다.**

(잔여 미확인: 게스트 커널 자체는 Linux = GPL-2.0이지만, 커널은 링크 대상이 아니라 실행 기질이므로 우리 배포물의 라이선스에 전이되지 않는다. 단 PVM 호스트 커널 재배포 시 GPL-2.0 고지 의무는 발생 — 아래 1.5 참조.)

### 1.3 활동성 — 3종 중 유일하게 건강

| 지표 | 값 |
|---|---|
| 생성 / 최종 push | 2026-04-10 / **2026-08-07** |
| Stars / Forks | 10,977 / 1,016 |
| **merged PR** | **651** (open 69) |
| Issue | closed 247 / open 60 |
| Release | v0.6.0 (2026-07-24), 그 전 rc1~rc3, v0.5.1(2026-07-11) — **수 주 간격 규칙적** |
| 기여자 상위 10 (커밋) | 226 / 56 / 45 / 39 / 28 / 23 / 19 / 16 / 16 / 15 |

**버스팩터 판정: 양호.** 최다 기여자가 상위10 합계의 47%로, 단독 의존이 아니다. 커뮤니티 PR이 실제로 **머지된다**(651건) — 이것이 아래 메모리 레포와 결정적으로 갈리는 지점이다. 대기업 OSS의 "시제품 방치" 함정에 해당하지 않는다.

단, **생성 4개월 · v0.6.0 = pre-1.0**. API 파괴적 변경 리스크는 실재한다.

### 1.4 API 계약 — **ADR-0142 D2 어댑터에 거의 1:1로 맞는다** (핵심 발견)

`openapi.yml`(2,215줄) 실측 엔드포인트:

```
POST   /sandboxes                        create_sandbox
GET    /sandboxes/{id}                   get_sandbox
DELETE /sandboxes/{id}                   kill_sandbox
POST   /sandboxes/{id}/pause             pause_sandbox
POST   /sandboxes/{id}/resume            resume_sandbox
POST   /sandboxes/{id}/timeout           set_sandbox_timeout
POST   /sandboxes/{id}/snapshots         create_snapshot
POST   /sandboxes/{id}/rollback          rollback_sandbox
       /templates, /volumes, /snapshots  (템플릿·볼륨·스냅샷 관리)
```

ADR-0142 D2 표와 대조:

| ADR-0142 D2 의무 | CubeSandbox 대응 | 판정 |
|---|---|---|
| `create(spec, idempotency_key)` | `POST /sandboxes` | ○ |
| `pause(ref)` / `resume(ref)` | `pause_sandbox` / `resume_sandbox` | **○ (흉내 아님 — 진짜 지원)** |
| `destroy(ref)` 멱등 | `kill_sandbox` (DELETE) | ○ |
| `probe(ref)` 사실 조회 | `get_sandbox` | ○ |
| capability 선언(`supports_pause` 등) | AutoPause/AutoResume 기능으로 실재 | ○ |

추가로 **E2B SDK 인터페이스 호환**을 명시적으로 표방한다("환경변수 하나만 바꾸면 E2B Cloud에서 전환"). 우리는 E2B를 **은퇴시키면서 그 클라이언트 코드를 이미 갖고 있었다**(ADR-0142 D4: `CloudLifecycleReconciler`의 E2B HTTP 호출부). 즉 **폐기 예정이던 코드가 그대로 어댑터 초안이 되는 희귀한 상황**이다. 이건 우연치고는 값이 크다.

Go SDK 존재(`sdk/go/` — sandbox.go, snapshot.go, pty.go, files.go, stream.go). Rust SDK는 미확인(트리에 `sdk/go`만 확인됨) — 우리는 어차피 REST를 직접 물 것이므로 영향 작음.

### 1.5 self-host 가능성 — **가능하지만 인프라 청구서가 크다** (탈락 요인은 여기)

README 269줄: *"Cube Sandbox requires an **x86_64 Linux** environment with **KVM** support."*

우리 프로덕션 = **NCP 단일 KVM VM, 디스크 9.8G**. 일반 클라우드 VM은 `/dev/kvm`을 노출하지 않는다(중첩 가상화 차단). 그래서 이 축의 사활은 **PVM 모드**에 달려 있는데 — 실제로 있다.

`docs/guide/pvm-deploy.md` 원문:
> *"**When to use this guide:** Your cloud server does not expose `/dev/kvm` (nested virtualization is blocked by the cloud provider)."*
> *"PVM (Pagetable-based Virtual Machine) is a page-table-based nested virtualization framework built on top of KVM. Unlike conventional nested virtualization, PVM does not require the host hypervisor to expose hardware virtualization extensions (Intel VT-x / AMD-V) to the guest."*

PVM은 ACM 논문(10.1145/3600006.3613158) 기반이고 Tencent Cloud 프로덕션 대규모 검증을 주장하며 OpenCloudOS 커널에 오픈소스화돼 있다. **즉 "일반 클라우드 VM에서 self-host 불가"라는 우리의 기본 가정은 틀렸다 — 경로가 있다.**

그런데 그 대가가 명시돼 있다:

- **호스트 커널 교체 + 재부팅**: `kernel-*opencloudos9.cubesandbox.pvm.host*.x86_64.rpm`을 설치하고 기본 부트 엔트리를 바꿔야 한다. Tencent가 유지하는 **out-of-tree 호스트 커널에 상시 종속**된다는 뜻 — 보안 패치 추적 책임이 우리에게 넘어온다.
- **하드웨어 최소치**: x86_64, **RAM ≥ 8GB, 시스템 디스크 ≥ 50GB**(`/data/cubelet` 전용 데이터 디스크 권장), root 권한, XFS 지원 스토리지.
- **부수 런타임**: one-click 설치본이 **MySQL + Redis**(compose 템플릿) + containerd + CoreDNS + nginx WebUI를 함께 세운다. 게스트 커널 `vmlinux` 아티팩트와 `cube-agent.ext4` 이미지 빌드도 필요.

**대조 — 우리 프로덕션 NCP 단일 KVM은 디스크 9.8G다.** 요구치 50G의 1/5. 게다가 **그 박스는 PG(=SoT)를 돌리는 박스**다. 거기서 호스트 커널을 Tencent OpenCloudOS PVM 커널로 갈아끼우는 것은 **SoT를 태우는 도박**이며, 어떤 편익으로도 정당화되지 않는다.

→ 결론: **현행 프로덕션 박스에는 절대 불가. 전용 호스트를 새로 사면 가능.**

### 1.6 Tencent 클라우드 종속 여부 — **종속 아님** (공정하게)

- `deploy/one-click/` = **단일 머신 오프라인 릴리스 패키지**. `install.sh` 한 번으로 all-in-one 설치. Tencent 계정 불필요.
- `deploy/kubernetes/chart/` = Helm 차트(범용 K8s).
- `deploy/one-click/terraform/tencentcloud/` = Tencent Cloud 전용 Terraform은 **선택지 중 하나일 뿐** 필수 경로가 아니다.
- 런타임이 Tencent API를 호출한다는 증거 없음.

**대기업 OSS의 "자사 클라우드 유도" 함정에 이 레포는 해당하지 않는다.** (아래 메모리 레포는 정반대다 — 이 대비가 중요하다.)

### 1.7 문서-실체 괴리 — 경미하나 실재

- 일반 클라우드 VM 배포 실전기 2건이 **모두 외부 커뮤니티 글(중국어, CSDN·InfoQ CN)** 이고 `type: external`로 블로그에 링크만 걸려 있다.
- 그중 AWS 중첩가상화 인스턴스(c8i.2xlarge) 배포기는 **Cubelet·CubeShim·게스트 이미지 3곳을 패치해야 했다**고 기술 — 즉 1st-party 지원 경로 밖에서는 매끄럽지 않다.
- 다만 이후 1st-party `docs/guide/pvm-deploy.md`가 정식 편입돼 있어 개선 추세는 확인된다.
- `README_zh.md` / `CONTRIBUTING_zh.md` 병존 — 중국어 1st 문화이나 영문 문서 품질은 실사용 가능 수준.

### 1.8 판정 — **의존성 도입 후보(조건부 보류) + 즉시 패턴 차용**

**이 레포는 ADR-0142가 비워둔 managed provider 자리의 현재 최유력 후보다.** 라이선스 통과, 활동성 건강, API가 우리 어댑터 계약과 1:1, 언어 정합(Rust), self-host 가능, pause/resume을 흉내가 아니라 진짜로 지원(ADR-0142 D2의 "흉내 금지" 조항을 만족).

**그럼에도 지금 도입하지 않는 이유(반증 우선):**
1. 전용 호스트(≥8GB RAM / ≥50GB 디스크) 신규 조달이 전제. 현 프로덕션 박스로는 불가.
2. 호스트 커널 교체 = 3rd-party out-of-tree 커널 상시 보안 추적 부담.
3. MySQL+Redis+containerd+CoreDNS 신규 운영 표면. `momo-docker-reclaim` 이슈로 이미 Docker 자원 누적 발열을 겪는 상황에서 가볍지 않다.
4. pre-1.0(v0.6.0, 생성 4개월) — 파괴적 변경 리스크.
5. **무엇보다 ADR-0142가 정한 현재 자세는 "BYOC가 기본형"**이고, managed provider는 "그 위의 자동화"다. 지금 관리형 provider가 없다는 것은 **결함이 아니라 설계된 상태**다. 긴급성이 없다.

**게이트(아래 3개가 동시에 참이 될 때 재평가):**
- (G1) momo Cloud 유료 T3를 실제로 팔기로 확정 → 관리형 provider 필요가 실수요로 전환
- (G2) 전용 호스트 예산 승인(≥8GB/≥50GB, 프로덕션 PG 박스와 **분리**)
- (G3) CubeSandbox v1.0 도달 또는 API 안정성 선언

**게이트와 무관하게 지금 당장 취할 것(무비용):**
- `openapi.yml`을 **어댑터 capability 어휘의 참조 규격으로 사용**. ADR-0142 D2의 `supports_pause` / `resume_semantics` / `continuous_runtime_limit` 선언을 설계할 때, 실물 provider 하나의 표면을 보고 맞추는 것과 상상으로 맞추는 것은 다르다. mock provider 2종의 계약을 이 실물에 맞춰두면 나중에 CubeSandbox 어댑터가 "끼워넣기"가 된다.
- `snapshot` / `rollback` / `set_timeout`은 우리 계약에 **없는** 연산이다. ADR-0142 D3(연속성 무상태 의무)와 충돌하지 않는지 미리 판단해둘 가치가 있다 — 우리 원칙은 "스냅샷은 최적화, 원본은 git+원장". 즉 채택하더라도 **snapshot을 연속성의 근거로 삼지 않는다**는 선을 어댑터가 지켜야 한다.

---

## 2. TencentDB-Agent-Memory (TencentCloud/TencentDB-Agent-Memory)

### 2.1 실체 — **이름이 거짓말을 한다**

이름은 "TencentDB"인데 **TencentDB를 쓰지 않는다.** 실측:

- `MemoryKnowledge/drizzle.config.ts` → `dialect: "sqlite"`, `url: process.env.KNOWLEDGE_DB_PATH || "./data/knowledge.db"`
- `MemoryProxy/src/db/schema.ts` → 주석 원문: *"SQLite schema for MemoryProxy local persistence."*
- 의존성 실측: `better-sqlite3 ^11.10.0`, `drizzle-orm ^0.44.0`, **`sqlite-vec 0.1.7-alpha.2`**(벡터), `ioredis`(프록시 캐시)
- **PostgreSQL 참조 0건** (트리 전체 grep)

구성(1,028 파일): `MemoryCore`(391) · `MemoryPanel`(264, 웹 UI) · `MemoryProxy`(179) · `MemoryKnowledge`(82) · `sdk`(47).

즉 **서비스 4종 묶음 + SQLite 임베디드 저장소**다. 라이브러리도 스키마도 아니고, 별도로 세우는 런타임 스택이다.

4종 메모리 자산: Chat Memory / Skill / LLM-Wiki / Code-Graph. 검색은 **BM25(sparse) + dense embedding + RRF rerank** 하이브리드.

### 2.2 라이선스 — MIT (실측, 깨끗함)

LICENSE 원문 26줄. Tencent 서문 3줄 + 표준 MIT 전문. `Copyright (C) 2026 Tencent`. **부가 조항·상업 제한 없음.** (GitHub NOASSERTION은 서문 때문에 자동매칭 실패한 것.)

**→ 라이선스는 탈락 사유가 아니다. 아래 4중 불변식 충돌이 탈락 사유다.**

### 2.3 우리 불변식과의 충돌 — **4건, 전부 치명적**

#### (C1) ADR-0004 위반 — provider 자격증명이 유입된다 ★가장 무거움

`deploy/global-images/.env.example` 원문:
```
PROXY_UPSTREAM_URL=REPLACE_ME          # 例：https://api.deepseek.com/v1
PROXY_UPSTREAM_API_KEY=REPLACE_ME      # 例：sk-xxxxxxxx（可与 memory 组不同）
MEMORY_LLM_API_KEY=REPLACE_ME          # 例：sk-xxxxxxxx
```

`MemoryProxy`는 **코딩 에이전트와 상류 LLM 사이에 끼어 앉아**(포트 8096) 트래픽을 가로채고 메모리를 주입하는 구조다. 동작하려면 **우리가 provider API 키 2벌을 이 서비스에 심어야 한다.**

이건 설정으로 우회 가능한 문제가 아니다 — **프록시가 곧 이 제품의 주입 메커니즘**이다(`core/hooks/auto-capture.ts`, `core/hooks/auto-recall.ts`). ADR-0004(provider 자격증명 워크스페이스 비유입)와 정면충돌하며, 프록시를 빼면 제품의 절반이 사라진다.

#### (C2) PG=SoT 위반 — SQLite 제2 SoT

저장 기질이 SQLite 파일이다. 도입하면 대화 원장(PG)과 메모리(SQLite)가 **서로 다른 DB에, 서로 다른 백업·복구·트랜잭션 경계로** 존재하게 된다. ADR-0129가 D1-B(사이드카)를 기각한 사유("제2의 SoT를 만들어 PG=단일 SoT 하드 룰과 충돌")에 정확히 해당한다. 게다가 벡터 확장이 **`sqlite-vec 0.1.7-alpha.2` — alpha 버전**이다.

#### (C3) RLS 위반 — 권한이 애플리케이션 계층에서 사후 필터링된다 ★설계적으로 가장 시사적

이 레포는 private / team / restricted(ACL) 3단 가시성을 표방한다. **어디서 집행되는가**가 우리 질문이었다. 실측 결과 — `MemoryCore/src/metadata/service/user-visibility.ts`:

```ts
export function canViewUser(user, ctx, options?): boolean {
  if (isSystemAdminUser(user)) return ctx.isAdmin || ctx.isSystemAdmin || ctx.userId === user.user_id;
  if (ctx.isSystemAdmin) return true;
  if (options?.allowTeamPeers) return true;
  if (ctx.isAdmin) return true;
  return ctx.userId === user.user_id;
}
export function filterVisibleUsers(users: UserEntity[], ctx, options?): UserPublic[]
```

**전량 조회 후 프로세스 내 TypeScript boolean으로 걸러낸다.** DB는 권한을 모른다. `filterVisibleUsers`라는 이름 자체가 "다 가져와서 배열을 필터링한다"는 뜻이다.

이것이 바로 **RLS FORCE가 존재하는 이유인 안티패턴**이다. 코드 한 줄 빠뜨리면 조용히 전량 유출된다. 우리 문맥으로 옮기면 — 에이전트 개인 기억과 채널 공유 지식의 경계가 애플리케이션 버그 하나에 달리게 된다. **채택 불가.**

#### (C4) 단일 쓰기경로 위반

메모리 쓰기가 **프록시 훅의 부수효과**로 일어난다(`auto-capture`). LLM 트래픽이 통과할 때 기록되는 구조다. 우리 단일 쓰기경로(REST→PG→outbox→relay) 위에 얹을 수 없고, **제2의 인입 경로**를 만든다. ADR-0129 D2-A가 이미 정한 "outbox 소비 비동기 워커"와 양립 불가.

### 2.4 자사 클라우드 유도 — **실측으로 확인됨** ★함정 적중

성재 지시("대기업 OSS의 흔한 함정을 실측으로 확인")에 대한 답: **이 레포는 해당한다.**

SQLite는 기본값일 뿐이고, **스케일업 경로가 Tencent Cloud VectorDB(TCVDB)로 직결**된다. 증거는 파일 경로 자체:

```
MemoryCore/bin/migrate-sqlite-to-tcvdb.mjs
MemoryCore/scripts/migrate-sqlite-to-tcvdb/sqlite-to-tcvdb.ts
MemoryCore/src/core/store/tcvdb-client.ts
MemoryCore/src/core/store/tcvdb.ts
MemoryCore/src/core/store/tcvdb-skill-store.ts
package.json → "@tencentdb-agent-memory/tcvdb-text": "^0.1.1"
```

`tcvdb.ts` 헤더 주석 원문: *"TcvdbMemoryStore: **Tencent Cloud VectorDB backend** implementing IMemoryStore. Features: Optional server-side dense embedding … Native hybridSearch (dense + sparse + RRFRerank) …"*

즉 **"무료로 SQLite로 시작 → 규모가 커지면 마이그레이션 스크립트로 Tencent 관리형 벡터DB로"**. 고급 기능(서버측 임베딩, 네이티브 hybridSearch)이 TCVDB 쪽에 있다. 전형적 퍼널이며, 우리 self-host 원칙과 방향이 반대다.

추가 신호: `deploy/global-images/.env.example`에 **Tencent 사내 미러(`mirrors.tencent.com/memory-team-control/...`) 대체 경로**가 주석으로 남아 있다("내부 동료용"). 사외 배포판이 사내 배포 스크립트의 파생물임을 드러낸다.

또한 self-host 경로가 **소스 빌드가 아니라 Docker Hub 사전빌드 이미지 pull**이다(`agentmemory/memory-core:latest` 등). 소스와 이미지의 대응을 검증할 방법이 제공되지 않는다(공급망 관점 미확인 리스크).

### 2.5 유지보수성 — **불량** (숫자가 명확하다)

| 지표 | 값 | 해석 |
|---|---|---|
| Stars | 17,506 (4개월) | 주목도는 최상위 |
| **open PR** | **459** | — |
| **merged PR** | **47** | **머지율 약 21%(47/(47+124+…)), 적체 459건** |
| closed-unmerged PR | 124 | 커뮤니티 기여가 버려진다 |
| open issue / closed issue | 90 / 120 | |
| **기본 브랜치** | **`feat/server_team`** | **feature 브랜치가 default** — 릴리스 위생 붕괴 |
| main 커밋 수 | 약 105 (4개월) | |
| 최근 main 커밋 성격 | `Update README_CN.md`(#804), `Update README_CN.md`(#616), `Update README.md`(#535) … | **README 편집이 최근 이력을 지배** |

**주목도 17.5k stars ↔ 머지된 커뮤니티 PR 47건**의 괴리가 이 프로젝트의 정체다. 개발은 사내에서 이뤄지고 GitHub은 쇼케이스로 쓰인다. 459건의 열린 PR은 기여자들이 고친 것을 아무도 받지 않고 있다는 뜻이다. 2026-05-14~05-18에 열린 이슈가 3개월 뒤인 지금도 열려 있다.

**공정을 위한 정정**: 최초 측정에서 "총 8커밋"으로 보였던 것은 기본 브랜치(`feat/server_team`)만의 수치였다. `main`에는 약 105커밋이 있다. 그러나 기본 브랜치를 feature 브랜치로 두고 있다는 사실 자체가 릴리스 관리 부실의 증거이며, 105커밋/4개월 역시 이 규모(1,028파일·4개 서비스)에 비해 빈약하다.

추가 코드 냄새 — `tcvdb.ts` 주석: *"All methods are **fault-tolerant: return empty/false on error, never throw**."* **메모리 시스템에서 오류를 삼키는 것은 조용한 데이터 손실**이다. 우리 감사가능성 요구(ADR-0129: 삭제 대신 `invalid_at` 무효화, 출처 역링크)와 철학이 반대다.

### 2.6 판정 — **배제** (의존성) / **좁은 패턴 차용** (읽을 가치는 있음)

**의존성 도입: 배제.** 사유는 라이선스가 아니라 아키텍처다 — ADR-0004·PG=SoT·RLS FORCE·단일 쓰기경로 **4개 하드 룰을 동시에 위반**하며, 그중 어느 것도 설정으로 우회되지 않는다. 여기에 자사 클라우드 퍼널과 PR 적체 459건이 겹친다. 부분 채택(예: MemoryCore만)도 SQLite 저장 기질과 앱계층 권한이 딸려오므로 성립하지 않는다.

**단, 읽을 가치가 있는 것 3가지 (MIT라 자유롭게 참조 가능):**

1. **L1 추출 프롬프트** — `MemoryCore/src/core/prompts/l1-extraction.ts`, `l1-dedup.ts`, `scene-extraction.ts`, `persona-generation.ts`. ADR-0129 D2-A의 mem0 2-phase(후보 추출→대조→ADD/UPDATE/무효화/NOOP)를 **실제로 구현한 프롬프트 원문**이다. 우리가 처음부터 쓰는 것보다 출발점이 낫다. **읽을 시점: MOMO-526(추출 워커 v0) 착수 직전.**
2. **하이브리드 검색 랭킹** — dense + sparse BM25 + RRF. **ADR-0129 D3-A(pgvector + tsvector FTS + RRF)와 독립적으로 동일 결론**. 우리 설계가 업계 수렴점 위에 있음을 재확인해준다. 파라미터·가중치 튜닝 시 대조군. **읽을 시점: MOMO-527(검색) 착수 시.**
3. **L0/L1 계층 분리** — `core/conversation/l0-recorder.ts`(원문 기록) vs `core/record/l1-*`(추출된 메모리). 우리 `memory_source_ref`(원문은 링크만) 설계와 같은 방향이며, 우리 쪽이 더 낫다(원문 중복 저장 금지).

**차용하지 말 것**: 프록시 훅 인입, SQLite 저장, 앱계층 권한 필터링, 오류 무시(never throw).

---

## 3. vibesdk (cloudflare/vibesdk)

### 3.1 실체 및 1급 질문(Cloudflare 종속) — **전면 종속, self-host 불가**

"오픈소스 full-stack AI 웹앱 생성기"(자연어→앱 생성, 샌드박스 미리보기, 원클릭 배포). 홈페이지 `build.cloudflare.dev`.

1급 질문에 대한 답을 `wrangler.jsonc` 실측으로 확정한다:

```
ai            → binding AI                    (Workers AI)
browser       → binding BROWSER               (Browser Rendering)
dispatch_namespaces → binding DISPATCHER      (Workers for Platforms)
containers    → class_name UserAppSandboxService
d1_databases  → binding DB
kv_namespaces → binding VibecoderStore
r2_buckets    → binding TEMPLATES_BUCKET
durable_objects → CodeGeneratorAgent, UserAppSandboxService,
                  DORateLimitStore, UserSecretsStore, ThinkAgent, SpaceDO
```

**Durable Object 클래스 6개**가 아키텍처의 중심이다. Durable Objects·Workers for Platforms·Containers는 Cloudflare 밖에 등가물이 없다. **self-host 불가가 확정.** → 과제 지시대로 **패턴 차용만 가능**.

### 3.2 라이선스·활동성

- **MIT** (GitHub 자동분류 MIT, 부가 제약 없음). permissive 통과.
- 생성 2025-08-25, 최종 push 2026-08-05. Stars 5,268.
- merged PR **286**, open PR 4 / open issue 13 — **이슈·PR 관리는 3종 중 가장 깔끔**.
- **버스팩터 1 — 심각**: 상위 기여자 `AshishKumar4` 806커밋 / 상위10 합계 938 = **86%**. 2위는 98커밋. 이 한 명이 빠지면 프로젝트가 멈춘다.
- 태그 릴리스는 **v1.5.0(2026-02-06)이 마지막 — 6개월 정체**(단 push는 계속됨). 릴리스 규율이 느슨해졌다.

### 3.3 우리에게 배울 층이 있는가 — **거의 없다** (교차 배정 결과)

세 층을 각각 실측 대조:

- **샌드박스 실행**: Cloudflare Containers 위임. 격리 기술을 직접 구현하지 않으므로 **배울 것이 없다**(CubeSandbox가 이 축에서 비교 불가하게 우월).
- **상태 관리**: Durable Objects = 세션당 단일스레드 액터 + 내장 스토리지. **우리 PG=SoT + outbox 모델의 정반대**다. DO는 상태를 액터 안에 두는데, 우리는 상태를 원장에 두고 액터를 무상태로 만든다(ADR-0143). 차용 대상이 아니라 **반례**로서만 의미가 있고, 그 비교는 ADR-0143에서 이미 다른 근거로 결론이 났다.
- **에이전트 오케스트레이션**: phase-wise 생성(planning→foundation→core→styling→integration→optimization) + WebSocket 실시간 진행 스트리밍. 이 중 **진행 스트리밍 UX**만 미약하게 참고 가능하나, 우리는 Centrifugo 전송전용 + `message.seq` 순서 규율이 이미 있고 ADR-0126(cowork observation surface)·ADR-0154(ADE control surface)가 같은 문제를 우리 문법으로 이미 다룬다.

게다가 **제품 목적이 다르다** — 코드 생성 플랫폼이지 에이전트 네이티브 메신저가 아니다. 그리고 이 레포의 존재 이유는 Cloudflare 플랫폼 판매다(자사 클라우드 유도 함정에 해당하나, 애초에 숨기지 않으므로 기만은 아님).

### 3.4 판정 — **배제**

self-host 불가(불변식 이전에 물리적으로 불가) + 배울 층 부재 + 버스팩터 1. 3종 중 우리 문맥 적합도가 가장 낮다. **읽을 시점: 없음.** 굳이 하나 꼽으면 codegen 진행 스트리밍 UX를 볼 때인데, 그마저 우선순위가 낮다.

---

## 4. 종합

### 4.1 핵심 설계 질문에 대한 답

> **"소유 주체가 다른 두 메모리(에이전트 개인 기억 vs 채널 공유 지식)가 한 저장·검색 기질을 공유할 수 있는가? 권한 경계가 스키마 수준에서 갈라지는가?"**

**답: 공유할 수 있다. 갈라져야 하는 것은 저장소가 아니라 술어(predicate)다.**

TencentDB-Agent-Memory가 이 질문의 자연 실험이다. 그들은 개인 Chat Memory와 공유 Wiki/Skill/CodeGraph를 **하나의 `IMemoryStore` 위에** 올렸고(단일 컬렉션 + `IsolationFilter` + private/team/restricted 가시성 열거), 검색도 한 경로(BM25+dense+RRF)로 처리한다. **"한 기질 공유"는 실증적으로 가능하다** — 기질은 소유 주체에 따라 갈라질 필요가 없다.

문제는 그들이 그 술어를 **애플리케이션 코드에 둔 것**이다(§2.3 C3). 그래서 얻을 교훈은 두 겹이다:

1. **긍정**: 단일 테이블·단일 검색 경로가 옳다. 개인 기억과 공유 지식을 별도 저장소로 쪼개면 하이브리드 검색을 두 번 돌리고 결과를 합쳐야 하며(RRF 랭킹이 깨진다), 감사·백업 경계가 이중화된다.
2. **부정**: 경계를 앱에 두면 안 된다. **RLS 술어로 내려야 한다.**

**momo의 정답 형태 — ADR-0129 D1-A가 이미 맞다.** 단일 `memory_item` + 스코프 4단(`workspace|member|agent|conversation`) + `workspace_id` RLS FORCE. 에이전트 개인 기억 = scope `agent` + 소유 member_id, 채널 공유 지식 = scope `conversation`/`workspace`. 같은 테이블·같은 RRF 질의·다른 RLS 술어. 그들의 3번째 티어(restricted/ACL)는 우리 `memory_visibility_grant` 테이블이 이미 대응한다.

**즉 이번 리서치는 ADR-0129를 바꾸지 않는다 — 독립 검증한다.** D3-A(pgvector+FTS+RRF)는 그들의 dense+BM25+RRF와 동일 결론이고, D1-B(사이드카) 기각은 이 레포를 실측하고 나니 더 강해졌다.

### 4.2 ADR-0129에 추가 제안할 것 2건 (실측 근거 있음)

**(A) `memory_item.kind` 컬럼 — 큐레이션 지식과 추출 사실의 수명주기 분리** ★권고
그들의 4자산 분류(Chat Memory / Skill / Wiki / CodeGraph)가 드러내는 진짜 요구: **성재가 확정한 관심 ①(에이전트 장기기억)과 ②(채널/워크스페이스 지식베이스)는 수명주기가 다르다.**
- ①은 대화에서 **자동 추출**되고 mem0 2-phase 무효화 대상이다.
- ②는 사람이 **큐레이션**한 것이고, 추출 워커가 자동 무효화하면 **안 된다**.
현 ADR-0129는 `memory_item` 단일 종(種)에 `source_kind='message'` 고정만 있다. `kind`(`extracted_fact` | `curated_knowledge` | …)를 v0 스키마에 넣고 **추출 워커의 UPDATE/무효화 대상을 `kind='extracted_fact'`로 한정**해야 ②가 ①의 파이프라인에 짓밟히지 않는다. 지금 컬럼 하나 넣는 비용 < 나중에 마이그레이션 비용.

**(B) "검색 결과의 앱계층 사후 필터링 금지" 명문화** ★권고
D1-A에 부정형 수용기준 한 줄 추가: *"메모리 검색은 RLS 술어로 걸러진 집합만 반환한다. 애플리케이션 코드가 전량 조회 후 필터링하는 경로를 두지 않는다(테스트: 권한 없는 주체의 질의가 DB 레벨에서 0행)."* 근거는 §2.3 C3의 실물 안티패턴. 부정형·testable이라 ADR-0142 D3와 같은 문법이다.

### 4.3 ADR 후보 스케치 — CubeSandbox 관련

**신규 ADR을 지금 기안할 필요는 없다.** ADR-0142 line 67이 이미 *"momo Cloud 실 provider 선정은 별건 ADR"*로 자리를 비워뒀고, ADR-0144(momo cloud substrate)가 그 자리다. 이번 리서치는 **그 별건 ADR의 옵션 A에 이름을 채워 넣는 입력**이다.

> **ADR-0144(또는 후속) 옵션 표에 추가할 항목**
> - **결정 지점**: momo Cloud의 T3 managed provider를 무엇으로 구현하는가.
> - **옵션 A — CubeSandbox 자체호스팅**: Apache-2.0, Rust, E2B 호환 REST(우리 폐기 예정 E2B 클라이언트가 어댑터 초안으로 재활용), pause/resume 실지원. 비용: 전용 호스트(≥8GB/≥50GB) + PVM 호스트 커널 교체 + MySQL/Redis/containerd 운영 표면.
> - **옵션 B — BYOC 유지, managed provider 무기한 연기**: 비용 0. ADR-0142의 현재 자세 그대로. **현행 권고.**
> - **옵션 C — 상용 관리형(E2B 재검토 등)**: 자격증명·비용 구조 재검토 필요.
> - **권고**: **B 유지**, A를 명명된 1순위 후보로 등재하고 게이트 G1~G3(§1.8) 충족 시 재평가.

### 4.4 티켓 후보

지금 발급할 만한 것은 **무비용 항목 2개뿐**이다. 나머지는 게이트 대기.

| 후보 | 트랙 | 내용 | 근거 |
|---|---|---|---|
| **T-a** | 엔진 | ADR-0129 스키마에 `memory_item.kind` 추가 + 추출 워커 대상 한정 | §4.2(A). MOMO-526에 **흡수 가능**(별도 티켓 불필요할 수 있음 — 오케스트레이터 판단) |
| **T-b** | 엔진 | ADR-0142 mock provider capability 선언을 CubeSandbox `openapi.yml` 실물 표면에 맞춰 정렬 | §1.8. 기존 어댑터 작업 범위 내 |
| (보류) | — | CubeSandbox 어댑터 구현 | G1~G3 대기 |

**주의**: T-a/T-b 모두 **기존 ADR 범위 안의 정제**이지 새 결정이 아니다. 새 티켓을 끊기보다 MOMO-526 / ADR-0142 이행 1번 항목의 수용기준에 문장으로 얹는 편이 낫다고 본다 — 최종 판단은 오케스트레이터/성재.

### 4.5 읽기 계획 (패턴 차용 판정의 착지)

| 무엇을 | 언제 | 왜 |
|---|---|---|
| `MemoryCore/src/core/prompts/l1-extraction.ts`, `l1-dedup.ts` | **MOMO-526 착수 직전** | 2-phase 추출 프롬프트 출발점(MIT) |
| `MemoryCore/src/core/store/tcvdb.ts`의 랭킹부 | **MOMO-527 착수 시** | dense+BM25+RRF 가중치 대조군 |
| CubeSandbox `openapi.yml` | **ADR-0142 이행 1(어댑터+mock) 착수 시** | capability 선언 어휘 정렬 |
| vibesdk | — | 없음 |

### 4.6 미확인으로 남긴 것 (정직 기록)

- CubeSandbox를 **실제로 설치·기동해보지 않았다.** 60ms 콜드스타트·5MB 오버헤드 성능 주장, PVM 모드의 실제 안정성, one-click 설치의 실제 디스크 점유량은 **문서 기반이며 미검증**. 게이트 통과 후 반드시 실측 필요.
- CubeSandbox Rust SDK 존재 여부 미확인(`sdk/go`만 확인). 실무 영향은 작음(REST 직접 호출 예정).
- CubeSandbox의 PVM 호스트 커널 RPM이 **NCP 환경에서 부팅되는지 미확인**. OpenCloudOS 9 권장이며 Ubuntu/Debian/CentOS "지원"이라 기술되나 NCP 이미지에서의 실증은 없음.
- TencentDB-Agent-Memory의 Docker Hub 사전빌드 이미지가 **공개 소스와 동일한지 미검증**(재현빌드 미제공).
- 세 레포 모두 **보안 감사·CVE 이력 미조회**.
- CubeSandbox의 게스트 커널 GPL-2.0 고지 의무 범위는 **재배포 시점에 법무 확인 필요**(우리가 셀프호스트 배포판 ADR-0121에 동봉할 경우).
