# CubeSandbox D4-② 실기동 스파이크 — 실측 보고 (ADR-0156 마지막 조각)

- 실행: 2026-08-09, 실측 워커. VM `cube-d42` (`root@<redacted>`, Rocky 9.8, 8 vCPU / 31 GB / vda 10G + vdb 200G, nested KVM `/dev/kvm`).
- 대상 버전: **CubeSandbox v0.6.0** (`online-install.sh` → GitHub latest = v0.6.0, 2026-07-24). 레포 스냅샷 `5cefcca`.
- 모드: **표준 KVM 모드** (ADR-0156 증보 2). `CUBE_PVM_ENABLE=0`, 커널 교체 없음.
- 정본 대조: ADR-0156 · ADR-0157 · `research/2026-08-08-cubesandbox-requirements-adapter-mapping.md`(이하 **매핑표**).
- **레포 미커밋.** 시크릿 0 — 테스트 페이로드만 사용(`MOMO_WORKD_TOKEN=test-not-a-secret`).
- 총 소요 ≈ 45분(호스트 준비~전 측정 완주). VM은 스택 기동 상태로 그대로 둠(terminate 안 함).

---

## 0. 한 줄 판정

**표준 KVM 모드로 전 항목 통과. 어댑터 계약은 살아남지만 매핑표 4곳이 실측과 다르고, 그중 2건은 Blocker다.** 폐곡선(create→exec→pause→resume→kill)은 실왕복으로 완주했고, ADR-0157 D1·D2·D3는 **호스트 nftables 없이 CubeSandbox 기본값만으로 성립**한다(eBPF `deny_out`). 반면 ①`timeout`은 idle 타이머가 아니라 **생성 기준 절대 TTL**이고 ②`state`는 VM을 SIGKILL한 뒤 **5분간 계속 `running`을 보고**한다(자력 수렴 없음).

| 과업 | 결과 |
|---|---|
| 1. 설치(XFS·표준 KVM) | **PASS** — preflight 9/9 통과, 설치 91초, rc=0 |
| 2. 실 microVM 폐곡선 | **PASS** — create/exec/pause/resume/kill 전부 실왕복 |
| 3. 매핑표 실물 검증 | **PARTIAL** — 상태코드 4/4 중 2건 불일치, metadata 멱등경로 PASS, probe lossy 재현 |
| 4. idle 시계 실측 | **PASS(판정 뒤집힘)** — 조회성 GET은 리셋 안 함. 단 **어떤 것도** 리셋 안 함 |
| 5. 네트워크 경계 | **PASS** — D1/D2 기본 성립, D3 허용. 기제 = Cubelet eBPF |
| 6. 기저 메모리·디스크 | **PASS** — 기저 3.1 GB(1st-party 주장 7.2 GB의 43%) |

---

## 1. 설치 실측

### 1.1 호스트 준비 (발주 사양 재검증)

| 게이트(매핑표 §1.3) | 실측 | 조치 |
|---|---|---|
| 1 `/dev/kvm` 존재 | ○ (nested KVM, Intel Xeon Gold 5220 / VT-x) | — |
| 2 MemTotal ≥ 7,500,000 KB | ○ 31,835 MB | — |
| 3 PVM 일관성 | ○ (`kvm_pvm` 미로드 · `CUBE_PVM_ENABLE=0`) | — |
| 4 `/data/cubelet` XFS | ✗ 초기 없음 | `mkfs.xfs /dev/vdb` → `/data` 마운트(fstab). `ftype=1` 확인 |
| 5 cgroup v2 `+cpu` | ✗ subtree_control=`memory pids` | `echo +cpu > .../cgroup.subtree_control` (설치기도 자동 시도함) |
| 6 `/sys/fs/bpf` | ○ 기본 마운트됨 | — |
| 7 glibc ≥ 2.31 | ○ 2.34 | — |
| 8 docker 등 | ✗ docker 없음 | docker-ce 29.7.2 설치 |
| 9 CIDR 충돌 | ○ VPC=10.0.1.0/24, `192.168.0.0/18`과 비충돌 | — |

> **Rocky 9는 매핑표 D-5가 걱정한 Ubuntu 함정(`multipathd`가 `+cpu` 차단)이 없었다.** `+cpu`는 한 줄로 켜졌다. Rocky/RHEL 9는 XFS가 기본이라 시스템 디스크만 쓰면 게이트 4도 그냥 통과한다(이번엔 데이터 디스크를 별도로 잡았다).

### 1.2 설치 실행

```
curl -sL .../deploy/one-click/online-install.sh -o /root/online-install.sh
bash /root/online-install.sh --node-ip=10.0.1.8      # CUBE_PVM_ENABLE 미설정 = 표준 KVM
```

- **소요 91초**, `rc=0`. 실패 지점 **0건**. 내장 quickcheck 6/6 통과.
- 세운 유닛 15개 전부 active(`cube-sandbox-control.target`).
- 설치기가 게이트를 스스로 수리하는 구간이 있다(`+cpu` 자동 활성). 문서보다 관대하다.

### 1.3 디스크 실점유 (U3 해소)

| 위치 | 점유 | 비고 |
|---|---|---|
| `/usr/local/services/cubetoolbox` | **1.7 GB** | 릴리스 번들 전개물(다운로드 258 MB → 전개 1.7 GB) |
| `/var/lib/containerd` | **2.1 GB** | 부수 컨테이너 이미지(mysql/redis/coredns/openresty) |
| `/data/cubelet` | **312 MB** | 템플릿 1개 + 런타임 |
| **합계** | **≈ 4.1 GB** (설치+템플릿 1개) | 다운로드 크기와 다르다 |

> **발주 사양 정정 — 시스템 디스크 50 GB는 실물 근거가 있다.** 이 박스의 시스템 디스크는 10 GB뿐이라, 기본 경로대로 두면 `/`가 4.0 → 6.0 GB(잔여 3.0 GB)까지 차서 템플릿 빌드가 위험했다. `/usr/local/services`와 `/var/lib/containerd`를 데이터 디스크로 bind-mount해 회피했다. **매핑표 D-4(시스템 50 GB + 데이터 200 GB)는 유효하며, 특히 `/var/lib/containerd`가 시스템 디스크에 있다는 사실이 런북에 없다.**

> ⚠ **런북 필수 항목(이번에 사고로 배움)**: containerd 이미지 저장소를 옮길 때 **`rsync -aX`로 xattr을 보존해야 한다.** `rsync -a`로 옮겼더니 CoreDNS 바이너리의 `security.capability`(=`cap_net_bind_service`) xattr이 유실돼 `listen tcp 127.0.0.54:53: bind: permission denied`로 CoreDNS가 죽고, 의존 유닛 `cube-sandbox-dns`가 연쇄 실패해 `*.cube.app` 해석이 끊겼다(→ SDK 전 경로 마비). 이미지 재pull로 복구. **비root 컨테이너 + 파일 capability를 쓰는 스택이라 xattr 보존이 정합성 조건이다.**

### 1.4 기저 메모리 (발주 사양 재검증 — 매핑표 뒤집음)

| 축 | 매핑표 §1.5 (1st-party 인용) | **본 실측(Rocky 9 · 표준 KVM)** |
|---|---|---|
| 시스템 기저 | "measured 7,198 MB" | **3,072 MB** |
| 유휴 샌드박스 상각 | 27–34 MB | **20 MB** |
| 32 GB 박스 available | 25,570 MB | **28,763 MB** |

> **매핑표의 "8 GB 발주는 실질적으로 불가"는 과했다.** 표준 KVM 모드 기저는 **3.1 GB**로, 1st-party PVM 벤치의 7.2 GB보다 4 GB 적다. 차이의 유력한 원인은 **PVM 커널 + `crashkernel=…:256M` 예약 + PVM 런타임**이 우리 구성에 없다는 것. 다만 결론(32 GB 권고)은 **바뀌지 않는다** — 아래 밀도 실측 때문이다.

---

## 2. 실 microVM 폐곡선 — 지연 실측

`GET /health` → `{"status":"ok","sandboxes":N}`. 템플릿: `sandbox-code:latest` → `tpl-50622c58811449bbba60cc1e`(alias `oort-spike`), **빌드 41초**(PULLING→UNPACKING→CREATING_TEMPLATE→READY).

| 연산 | 본 실측 | 1st-party PVM 벤치 | 1st-party 베어메탈 | 배율 |
|---|---|---|---|---|
| create (직렬 1회) | **295 ms** | 66.7 ms | 47.8 ms | **4.4× 느림** |
| create (8연속 평균) | **561 ms** (min 245 / max 751) | — | — | |
| create (6연속, 부하 중) | 1,535 ms avg (max 4,469) | — | — | 경합 시 급락 |
| **pause (2000 MB)** | **1,312 – 1,693 ms** | **370.8 ms** | — | **≈4.2× 느림** |
| **resume(`/connect`)** | **63.7 – 248 ms** | 18.9 ms | — | 3.4× 느림 |
| destroy(DELETE) | **455 ms** | — | — | 동기 |
| `GET /sandboxes/{id}` | **2–6 ms** | — | — | |
| `GET /sandboxes?metadata=` | **2 ms** | — | — | |
| exec(SDK `commands.run`) | 160–224 ms | — | — | |
| `run_code` | 493 ms | — | — | |

**게스트 실체 확인**(진짜 microVM):
```
uname -r  = 6.6.1199-0009-03_2.0.1        (Cube 게스트 커널)
/proc/1/comm = python ,  /dev/vda 존재
cmdline: root=/dev/pmem0 rootflags=dax ... console=hvc0 mitigations=off
nproc = 2, memoryMB = 2000
```

> **capability `pauseSecondsPerGiB` 정정 필요(Blocker급 수치 오류).**
> 매핑표 §2.7은 1st-party 370.8 ms/2 GiB에서 **0.2 s/GiB**를 도출했다. 본 실측은 **1,312–1,693 ms / 1.95 GiB ≈ 0.67–0.87 s/GiB**로 **3.4~4.4배 크다.** pause는 현재 full-memory-copy 모드이고, 우리 호스트는 중첩가상화 위 Xeon Gold 5220(2019년 Cascade Lake)이라 1st-party의 EPYC 9K65 대비 느린 것이 자연스럽다.
> **권고: `pauseSecondsPerGiB: 1.0`(보수)으로 선언하고, 실호스트 확정 후 D4-④에서 재측정해 조정.** 0.2는 어떤 실호스트에서도 관측되지 않은 값이므로 쓰지 않는다.

---

## 3. 매핑표 실물 검증 — 정정 4건

### 3.1 상태코드 (✗ 2건 불일치 — 어댑터 계약 수정 필요)

| 케이스 | 매핑표 예측 | **실측** | 판정 |
|---|---|---|---|
| create 성공 | 201 + `sandboxID` | **201** ✓ | 일치 |
| pause 성공 | 204 | **204** ✓ | 일치 |
| `connect` 성공 | 200 | **200** ✓ | 일치 |
| DELETE 성공 | 204 | **204** ✓ | 일치 |
| DELETE 재호출 | 404 | **404** ✓ | 일치(멱등 성립) |
| GET 삭제 후 | 404 | **404** ✓ | 일치 |
| **이미 paused인데 pause** | **409** "cannot be paused" | **500** `{"code":500,"message":"CubeMaster returned error code 130490: sandbox is already paused"}` | **✗ 불일치** |
| **이미 running인데 `/resume`** | **409** "already running" | **500** `…130490: sandbox already running` | **✗ 불일치** |
| 이미 running인데 `/connect` | 200(멱등) | **200** ✓ | 일치 — **`/connect` 권고 재확인** |

> **Blocker-1 — 500을 재시도로 접으면 안 되는 경우가 있다.**
> ADR-0140 D4 수렴표(매핑표 §2.6)는 `pause 500 → revert(재확인)`, `connect 500 → revert`로 되어 있다. 그런데 실물에서 **"이미 목표 상태에 도달함"이 409가 아니라 500으로 온다.** 500을 일괄 revert/retry로 접으면 이미 paused인 인스턴스를 계속 되돌리려 시도하는 **플랩**이 생긴다.
> **처방(둘 중 하나, 후자 권고)**
> - (가) 응답 본문의 `CubeMaster returned error code 130490` 문자열을 파싱해 분기 → **문자열 의존이라 취약, 비권고**
> - **(나) 상태코드에 의미를 부여하지 않고 항상 `GET`으로 재판정한다.** 즉 `pause`/`connect`가 2xx가 아니면 **무조건 probe 1회**를 돌려 `paused`면 `confirm`, `running`이면 `revert`, 404면 `terminate`, 그 외/전송실패면 `unknown`으로 보류. 매핑표 §2.6이 이미 **409에 대해서만** 그렇게 쓰고 있는데, **그 규칙을 4xx/5xx 전체로 넓히면 된다.** 계약 표면이 늘지 않고 문자열 의존도 없다.
> - 수용기준 추가: **"pause가 500을 반환하고 후속 probe가 `paused`를 주는 시나리오에서 수렴이 `confirm`으로 가고 재시도 카운터가 증가하지 않는다"**(red proof: 500→retry로 바꾸면 실패).

### 3.2 `metadata` 각인 + 조회 = 멱등 재구성 경로 (PASS)

```
POST /sandboxes  metadata={momo_provision_id: prov-d42-…, momo_workspace_id: ws-d42}
GET  /sandboxes?metadata=momo_provision_id%3D<key>                 -> 200, 1건 매치 (2.3 ms)
GET  /sandboxes?metadata=<k1>%3D<v1>%26<k2>%3D<v2>                 -> 200, 1건 (AND 성립)
GET  /sandboxes?metadata=momo_provision_id%3Dnope                  -> 200, 0건
```
- **매핑표 §2.2(a)의 멱등 대체 설계는 실물에서 그대로 동작한다.** 조회 2 ms로 create 전 선조회 비용도 무시 가능.
- ⚠ **주의 1 — `metadata`는 우리 것만 들어있지 않다.** 응답의 `metadata`에 CubeSandbox 내부 키가 섞여 돌아온다:
  `cube.master.runtime.snapshot.id`, `cube.master.appsnapshot.template.id`, `cube.numa_node`, `cube.product`, `cube.master.components.envd.version`, … 그리고 정체불명의 **`X-Caller: X-Caller`**.
  → 어댑터는 **자기 키(`momo_*`)만 읽고, 전체 dict를 그대로 원장에 저장하지 않는다.** (수용기준 추가 권고)
- ⚠ **주의 2 — 필터는 서버측 AND이고 값 완전일치**다. 접두어/부분일치 없음.

### 3.3 probe lossy 실물 — **예측보다 나쁘다** (Blocker-2)

VMM(`containerd-shim-cube-rs`, 해당 sandboxID 네임스페이스)을 **SIGKILL**한 뒤 CubeAPI를 계속 조회:

```
healthy                       -> 200 state=running
kill -9 <shim pid>
t≈  10s -> 200 running        t≈ 110s -> 200 running
t≈  30s -> 200 running        t≈ 190s -> 200 running
t≈  50s -> 200 running        t≈ 250s -> 200 running
t≈  90s -> 200 running        t≈ 290s -> 200 running
>> 300초 동안 한 번도 수렴하지 않음
```

- 매핑표 §2.2(b)는 "`running`은 paused가 아닌 전부를 접은 값"이라고 **코드에서** 읽어냈다. 실물은 그보다 강하다: **죽은 VM이 5분간 `running`으로 보고되며, 자력으로 404가 되지 않는다.**
- **따라서 `absent` 판정은 HTTP 404 단독에 의존하는데, 그 404가 영영 안 올 수 있다.** ADR-0140 D4의 `provider_missing` 수렴은 크래시 케이스에서 **발화하지 않는다.**
- **처방**: ADR-0156 D6의 *"`running`은 liveness 증거로 쓰지 않는다 — workd 하트비트가 정본"*은 **필요조건이지 충분조건이 아니다.** 크래시된 인스턴스는 provider가 영원히 살아있다고 말하므로, **원장이 하트비트 소실을 근거로 `destroy`를 능동 발행**해야 자원이 회수된다(provider의 부재 신호를 기다리면 안 된다). ADR-0139/0141 sweep이 이미 그 모양이면 변경 없음 — **다만 "provider가 present라고 답해도 하트비트가 죽었으면 destroy한다"가 명시적 규칙이어야 한다.**
- 수용기준 A5 보강: **"probe가 200/`running`을 반환하는 동안 workd 하트비트가 만료되면, 수렴이 destroy를 발행한다"**(부정형: provider present를 이유로 destroy를 보류하지 않는다).

### 3.4 `timeout` / `onTimeout` (PASS — 단 의미가 다름, §4에서 전개)

| 설정 | 실측 |
|---|---|
| `timeout: 30, lifecycle.onTimeout: "kill"` | **≈40초에 404**(삭제). 발화 지연 ≈10초(감시 주기) |
| `timeout: 30, lifecycle.onTimeout: "pause"` | **≈40초에 `state=paused`**. 삭제되지 않음 |
| `lifecycle` 생략 | 기본 `kill` (문서·실측 일치) |
| `POST /timeout {timeout:600}` | 204, `endAt` 절대 재설정 |
| `POST /refreshes {duration:180}` | 204, `endAt` 연장 |

→ **매핑표 §2.2(b)의 "기본값에 맡기면 우리 원장 몰래 인스턴스가 사라진다"는 실측으로 확인.** `lifecycle` 명시는 필수.

### 3.5 그 외 실물 확인

| 항목 | 실측 |
|---|---|
| `envVars` 주입 | **동작함** — `MOMO_WORKD_URL` 등 2건이 게스트 셸 `env`에 보임. **단 `/proc/1/environ`에는 없다** → **PID1이 아니라 envd exec 세션에 주입된다.** workd를 템플릿 ENTRYPOINT로 띄우면 env를 못 볼 수 있음 → **어댑터/템플릿 설계 시 확인 필요 항목** |
| `envVars` pause/resume 생존 | ○ 유지됨 |
| create 응답 필드 | `{templateID, sandboxID, clientID, envdVersion, domain}` — **`envdAccessToken`·`trafficAccessToken`은 오지 않음**(매핑표 §2.1이 openapi 기준으로 적은 것과 차이) |
| `SandboxDetail` | `endAt`·`cpuCount(2)`·`memoryMB(2000)`·`metadata` 제공. **`diskSizeMB`는 0**(미보고) |
| `state` 어휘 | 실물에서 `running` / `paused`만 관측(`pausing`은 창이 짧아 미포착) |
| U4 pause/resume 보존 | **PASS(강한 증거)** — pause 전후 **PID 동일(58)**, 프로세스 계속 살아있음, `/tmp` 파일 보존, **카운터가 paused 구간만큼 정지**(5→10, 벽시계 14초 중 10초 정지). 메모리 스냅샷 복원 확정 |

---

## 4. idle 시계 실측 (#1179 이탈 1) — **판정이 뒤집혔다**

**질문**: CubeSandbox idle timeout은 어떤 inbound에 리셋되는가 — 특히 조회성 GET(reconciler probe 상당)이 리셋하는가?

**답: 아무것도 리셋하지 않는다. `timeout`은 idle 타이머가 아니라 생성 시점 기준 절대 TTL이다.**

`timeout: 180`으로 생성 후 `endAt`을 고정 관측하며 각 자극을 가함:

| 자극 | `endAt` 변화 | 판정 |
|---|---|---|
| `GET /sandboxes/{id}` ×3 (20초 간격) | **0.0s** | 리셋 안 함 |
| `GET /sandboxes` (목록·metadata 조회) | **0.0s** | 리셋 안 함 |
| **SDK exec**(envd 경유, cube-proxy 통과) ×3 | **0.0s** | 리셋 안 함 |
| 샌드박스 내부 CPU 점유(60초 busy loop) | **0.0s** | 리셋 안 함 |
| 샌드박스發 **아웃바운드** HTTPS(api.github.com) | **0.0s** | 리셋 안 함 |
| `POST /sandboxes/{id}/refreshes` | **+70s / +36s (연장)** | **리셋함** |
| `POST /sandboxes/{id}/timeout` | 절대 재설정 | 설정함 |

> **매핑표 §2.2(b) 정정**: *"`timeout` = idle 타임아웃(활동이 있으면 리셋). 활동 = SDK 호출 + 샌드박스 내부 서비스로의 HTTP 트래픽"* — **실측과 다르다.** 1st-party 문서(`lifecycle.md:176-183`)의 서술이 v0.6.0 실물과 어긋나거나, "활동"이 우리가 시험한 경로를 포함하지 않는다. 5가지 자극 전부 `endAt`을 1 ms도 움직이지 못했다.

### 4.1 이 답이 정하는 sweep 정책 값

**좋은 소식 — reconciler probe는 안전하다.**
조회성 GET이 시계를 리셋하지 않으므로, **우리 sweep이 아무리 자주 probe해도 좀비 인스턴스의 수명을 연장시키지 않는다.** ADR-0156 D6의 안전망(`timeout` = sweep 주기 × 4 + `onTimeout: kill`)은 **우리 자신의 관측 행위에 의해 무력화되지 않는다.** #1179 이탈 1의 우려는 **해소**.

**나쁜 소식 — 안전망이 정상 세션도 죽인다.**
`timeout`이 절대 TTL이므로, **장시간 빌드를 정상 수행 중인 세션도 그 벽시계 시점에 `onTimeout: kill`로 삭제된다.** 활동은 유예를 만들지 못한다.

**따라서 어댑터에 없던 의무가 하나 생긴다 — keepalive.** 세 갈래:

| 안 | 내용 | 좀비 상한 | 정상 세션 안전 | 판정 |
|---|---|---|---|---|
| (가) `timeout: -1` | CubeSandbox 회수 완전 비활성, 우리 sweep 단독 | **없음**(momo 전면 정지 시 영구 좀비) | ○ | 매핑표 원안. §3.3 실측 후 **위험 증가** |
| (나) `timeout: T` + `onTimeout: kill`, 갱신 안 함 | 안전망만 | T | **✗ 장기 세션 사망** | 불가 |
| **(다) `timeout: T` + `onTimeout: kill` + 하트비트 연동 `/refreshes`** | workd 하트비트를 관측하는 그 자리에서 `POST /refreshes` 발행 | **T** | ○ | **권고** |

> **(다) 권고 이유**: 갱신 주체가 **momo의 하트비트 관측 경로**이므로, momo가 죽으면 갱신이 멈추고 `T` 후 인스턴스가 자멸한다 — **좀비 과금 상한이 구조적으로 보장**된다. 동시에 살아있는 세션은 계속 연장되어 (나)의 문제가 없다. §3.3에서 본 "provider는 죽은 VM을 영원히 running이라 말한다" 문제의 **유일한 자동 회수 경로**이기도 하다(우리가 destroy를 못 보내는 상황 = momo가 죽은 상황 = 갱신도 멈춘 상황).
> **값 권고**: `T` = 하트비트 만료 판정 시간 × 4 이상, 그리고 `/refreshes` 주기 = `T`/3 이하. ADR-0156 D6의 "sweep 주기 × 4"는 **갱신 주기 기준**으로 다시 읽으면 그대로 유효.
> **비용**: `/refreshes`는 204에 수 ms. 세션당 분당 1회면 무시 가능.

---

## 5. 네트워크 경계 실측 (ADR-0157 D4 재료) — **기본값으로 성립**

### 5.1 실측 결과 (기본 CubeNet, 호스트 nftables 미적용)

샌드박스 안에서 파이썬 소켓으로 직접 연결 시도:

| 대상 | 결과 |
|---|---|
| 호스트 CubeAPI `10.0.1.8:3000` | **BLOCKED** |
| 호스트 CubeMaster `10.0.1.8:8089` | **BLOCKED** |
| 호스트 Cubelet gRPC `10.0.1.8:9999` | **BLOCKED** |
| 호스트 WebUI `10.0.1.8:12088` | **BLOCKED** |
| 호스트 SSH `10.0.1.8:22` | **BLOCKED** |
| CubeNet 게이트웨이 `192.168.0.1:8080` / `:8443` | **BLOCKED** |
| **클라우드 메타데이터 `169.254.169.254:80`** | **BLOCKED** |
| **다른 샌드박스** `192.168.1.13:9100` | **BLOCKED** |
| 인터넷 `140.82.121.6:443` | **REACHABLE** |
| DNS `github.com` 해석 | **성공** |
| `https://api.github.com/zen` | **HTTP 200** |

**D2 양성 대조(중요)**: 같은 순간 **호스트에서** `curl http://192.168.1.13:9100/` → **HTTP 200**. 즉 리스너는 살아있고 주소지정 가능한데 **오직 이웃 샌드박스만 닿지 못한다.** (초기 시도에서 게스트가 자기 주소를 `169.254.68.6`으로 보고해 A/B가 같은 IP로 보였는데, 이는 게스트가 링크로컬 transit 주소를 쓰기 때문이고, 실제 피어 주소는 호스트측 tap `z192.168.x.y`에서 얻어야 한다.)

### 5.2 기제 — **Cubelet 내장 eBPF (호스트 nftables 불요)**

`cubevsmapdump`로 각 샌드박스 tap 인터페이스의 eBPF 맵을 덤프:

```
== deny_out
   ifindex 336 -> ['10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16']
   ifindex 362 -> (동일)
   ifindex 467 -> (동일)
== allow_out_v2
   ifindex 336/362/467 -> []        # 허용목록 없음 = 차단목록 방식
```

- **샌드박스 인터페이스마다** RFC1918 전체 + 루프백 + 링크로컬이 **기본 거부**로 박혀 있다.
- `10.0.0.0/8` → momo 내부망·호스트 사설 IP 차단 = **D1 성립**
- `192.168.0.0/16` → 동일 CubeNet 대역의 이웃 샌드박스 차단 = **D2 성립**
- `169.254.0.0/16` → 클라우드 메타데이터 차단(보너스, D1 취지)
- `172.16.0.0/12` → docker 브리지 차단
- `allow_out_v2` 비어 있음 + 공인 IP는 거부목록 밖 → **인터넷 허용 = D3 성립**

### 5.3 ADR-0157 D4 판정·권고

> **D4 답: "CubeNet 설정으로 충분한가 / 호스트 nftables인가 / CubeEgress 해제인가" → 셋 다 아니고, Cubelet 내장 네트워크 런타임(eBPF)이 기본값으로 이미 D1·D2·D3를 만족한다. 추가 기제 없이 v0 성립.**

다만 **선언성 요구(D4 후단 "규칙은 호스트에 선언적 파일로")를 위해 3가지를 권고**한다:

1. **기본값을 신뢰하되 검증한다.** `deny_out` 세트는 CubeSandbox 상류가 바꿀 수 있는 값이다(v0.6.0에서 관측된 것). **`cubevsmapdump`로 5개 CIDR의 존재를 확인하는 검증 스크립트를 레포에 두고, 설치 런북과 (가능하면) 기동 게이트에 넣는다.** 이것이 "선언적 파일"의 현실적 형태다 — 규칙을 우리가 심는 게 아니라 **기대값을 우리가 선언하고 어긋나면 실패시킨다.**
2. **호스트 nftables는 방어 2층으로만.** 기본값이 이미 맞으므로 필수는 아니나, `deny_out`이 조용히 비는 회귀에 대비해 `10.0.0.0/8`·`169.254.169.254` 차단을 호스트에 한 번 더 선언하는 것은 값싸다. **런타임 API가 아닌 파일로**(D4 조항 준수).
3. **ADR-0156 D5(부속 컴포넌트 미사용)와 실물의 어긋남을 기록해야 한다.** 아래 §6.

---

## 6. ADR-0157 D5(비노출) 및 하드닝 실측

### 6.1 기본 바인드 실측 (나쁜 기본값 확인)

| 유닛 | 기본 바인드 | 인증 |
|---|---|---|
| `cube-api` | **0.0.0.0:3000** | **없음(전면 허용)** |
| `cubemaster` | `*:8089` | 없음 |
| `cubelet` | `*:9999` / `*:9998` / `*:9966` | 없음, TLS 없음 |
| `cubeops` | `*:3010` | — |
| webui | `0.0.0.0:12088` | — |
| cube-proxy | `0.0.0.0:80` / `:443` | 의도적 공개 |
| mysql / redis | `127.0.0.1:3306` / `:6379` | **기본 약패스워드 실재** — 라이브 `DATABASE_URL=mysql://cube:cube_pass@127.0.0.1:3306/cube_mvp` |

**클라우드 ACG가 유일한 방벽이었다(실측)**: 설치 전에 호스트에서 3000/12088/8089에 리스너를 띄우고 **외부(맥)에서 접속 시도 → 전부 타임아웃(필터됨), 22만 개방.** 즉 이 박스에서는 무인증 CubeAPI가 인터넷에 노출되지는 않았다. **그러나 이는 호스트 통제가 아니라 클라우드 보안그룹 1개에 의존한 상태**이므로 ADR-0157 D5의 "공인 IP 바인딩 금지" 요구는 그대로 유효하다.

### 6.2 하드닝 적용·검증 (런북 항목으로 확정)

`/usr/local/services/cubetoolbox/.one-click.env`에 한 줄 추가 후 `systemctl restart cube-sandbox-cube-api`:

```
CUBE_API_BIND=127.0.0.1:3000
```
| 검증 | 결과 |
|---|---|
| `ss -lntp` | `127.0.0.1:3000` (0.0.0.0 사라짐) ✓ |
| `curl 127.0.0.1:3000/health` | 200 ✓ |
| `curl 10.0.1.8:3000/health` | 연결 거부 ✓ |
| 스택 건강 / create 왕복 | 정상 ✓ |

> ⚠ **운영 주의**: 순수 루프백은 **momo 서버가 같은 박스에 있을 때만** 성립한다. 전용 호스트 분리 구성에서는 `CUBE_API_BIND=<사설IP>:3000` + 호스트 방화벽(oort 서버 IP만) + 아래 인증 콜백 조합이 맞다. **런북에 두 경우를 나눠 적을 것.**

### 6.3 `AUTH_CALLBACK_URL` = momo가 인증 주체 (ADR-0004 유리, 실증)

`AUTH_CALLBACK_URL`을 세팅하고 콜백 서버를 붙여 실측:

| 시나리오 | 결과 |
|---|---|
| 콜백 **도달 불가** + 키 있음 | **500** (요청 거부) → **fail-closed 확인** |
| 콜백 활성, 유효 키(`X-API-Key`) | **200** |
| 콜백 활성, 무효 키 | **401** |
| 콜백 활성, `Authorization: Bearer` | **200** (동등 수용) |
| 키 없음 | **401** |
| `GET /health` | **200** (인증 면제) |

콜백이 실제로 받은 것:
```
cred='oort-valid-123'         path='/sandboxes' method='GET' -> 200
cred='attacker'               path='/sandboxes' method='GET' -> 403
cred='Bearer oort-valid-xyz'  path='/sandboxes' method='GET' -> 200
```

> **path와 method가 함께 온다 → momo가 연산 단위 인가를 할 수 있다.** 문서 경고대로 **경로만 보고 허용하면 `/templates/{id}`에서 GET↔DELETE 권한 상승**이 생기므로, 콜백 구현은 **path+method 쌍**으로 화이트리스트해야 한다.
> **ADR-0004 판정: 무저촉이 실증됨.** 외부 provider 자격증명이 존재하지 않고, `MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY`는 **우리가 발급하고 우리 콜백이 검증하는 값**이 된다.

### 6.4 ADR-0156 D5(부속 컴포넌트 유보)와 실물의 어긋남 — **기록 필요**

ADR-0156 D5는 *"CubeProxy·CubeEgress·CubeDB 등은 전부 쓰지 않는다"*로 되어 있다. 그러나 **one-click 설치는 이들을 기본으로 세우고, 일부는 폐곡선의 전제**다:

| 컴포넌트 | 실물 상태 | 우리 의존 여부 |
|---|---|---|
| `cube-proxy` (nginx 80/443) | active | **exec 경로가 이걸 통과한다**(`https://<port>-<id>.cube.app`) — SDK/envd 접근에 필수 |
| `cube-sandbox-coredns` + `dnsmasq` | active | **`*.cube.app` 해석 = exec 전제.** 죽으면 SDK 전 경로 마비(§1.3 사고로 실증) |
| **`cube-egress` (투명 MITM 프록시)** | **active** + `cube-egress-net`(TPROXY + ip rule) | 기본 기동. 템플릿 빌드가 **CubeEgress 루트 CA를 rootfs에 굽는다**(`--with-cube-ca` 기본 true) |
| `cube-lifecycle-manager` | active | `onTimeout` 발화 주체로 추정 |
| mysql / redis | active | CubeMaster 상태 저장소 |

> **판정: D5는 "설치하지 않는다"가 아니라 "우리 어댑터 표면에 넣지 않는다"로 문언을 좁혀야 한다.** 실제로 안 쓸 수 있는 것은 **CubeDB·snapshot/rollback/volume API**이고, CubeProxy·CoreDNS는 **exec가 존재하는 한 필수 종속**이다.
> ⚠ 추가 발견: `--with-cube-ca` 기본값이 **true**라 템플릿에 **CubeEgress MITM 루트 CA가 구워진다.** 우리가 egress MITM을 쓰지 않기로 했다면 **`--with-cube-ca=false`로 템플릿을 빌드해야 한다** — 안 그러면 샌드박스가 신뢰하는 CA가 하나 늘어난 채로 뜬다. **ADR-0150(대화 유출 경계) 입력값이자 D4-③ 템플릿 절차 항목.**

---

## 7. 밀도·동시성 실측 (`maxConcurrentInstances` 재료)

8개 샌드박스(각 2 vCPU / 2000 MB 스펙)를 생성 후, 각자 **800 MB를 실제로 터치**시켜 측정:

| 국면 | used | available | 샌드박스당 |
|---|---|---|---|
| 기저(0개) | 3,104 MB | 28,731 MB | — |
| 8개 **유휴** | 3,268 MB | 28,567 MB | **20 MB** |
| 8개 **800 MB 실사용** | 9,937 MB | 21,898 MB | **834 MB** |
| 정리 후 | 3,122 MB | 28,713 MB | 회수 정상 |

- **메모리는 사전 예약이 아니라 실사용분만 과금된다**(스펙 2000 MB여도 유휴는 20 MB).
- 실측 기반 용량식: **동시 세션 ≈ (available − 여유) ÷ 세션 실사용 메모리**
  - 800 MB 워킹셋: **≈ 34개**
  - 2 GiB 풀 워킹셋: **≈ 14개** (매핑표 추정 ~10개보다 약간 큼 — 기저가 3.1 GB로 작아서)
- create 지연은 동시성에 민감: 직렬 295 ms → 8연속 561 ms avg → 부하 중 6연속 1,535 ms avg(max 4,469 ms).

> **`maxConcurrentInstances` 권고**: 매핑표 §2.7 (가)안(**설정 주입**) 유지가 옳다. 실측이 그 근거를 강화한다 — 값이 **호스트 RAM뿐 아니라 워크로드 워킹셋에 종속**이라 컴파일 타임 상수로 박을 수 없다.
> **32 GB 박스 초기값 권고: 10** (2 GiB 워킹셋 가정 14의 70% — create 지연 열화와 버스트 여유 확보).

---

## 8. D4-② 판정

### 8.1 어댑터 계약 수정 필요 여부 — **필요. Blocker 2 + High 3.**

| # | 등급 | 항목 | 처방 |
|---|---|---|---|
| B1 | **Blocker** | "이미 목표 상태" 응답이 **409가 아니라 500** | 4xx/5xx 전부 **probe 재판정**으로 수렴(§3.1 (나)안). 수용기준 신규 1건 |
| B2 | **Blocker** | probe lossy가 **자력 수렴하지 않음**(크래시 VM이 5분+ `running`) | 원장이 하트비트 근거로 **능동 destroy 발행**. "provider present여도 하트비트 만료면 destroy" 명문화. A5 보강 |
| H1 | High | `timeout`이 **idle이 아니라 절대 TTL** | 어댑터에 **`/refreshes` keepalive 경로 추가**(하트비트 연동, §4.1 (다)안) — 매핑표에 없던 신규 의무 |
| H2 | High | `pauseSecondsPerGiB: 0.2`가 **실측의 1/4** | **1.0**으로 보수 선언, D4-④에서 실호스트 재측정 |
| H3 | High | `metadata` 응답에 **CubeSandbox 내부 키 혼입** | `momo_*`만 읽고 전체 dict를 원장에 저장 금지. 수용기준 추가 |
| M1 | Med | `envVars`가 **PID1에 없음**(exec 세션에만) | workd 기동 방식 확인 — ENTRYPOINT 의존 시 대체 주입 경로 필요 |
| M2 | Med | create 응답에 `envdAccessToken` **없음** | 어댑터가 이 필드를 기대하지 않도록 |
| M3 | Med | `diskSizeMB: 0` | 과금 교차검증에 못 씀 |
| M4 | Med | 템플릿에 **CubeEgress CA 기본 주입** | `--with-cube-ca=false` |

**변하지 않은 것(계약이 살아남는 근거)**: 경로 5/5 일치, 성공 상태코드 4/4 일치, `X-API-Key` 수용, `/connect` 멱등(200), DELETE 404 멱등, `metadata` 조회 기반 멱등 재구성 동작, pause=진짜 메모리 스냅샷(PID 동일). **매핑표 §2.5의 "`E2BProvisioner` 골격 재활용" 판정은 유효하다.**

### 8.2 ADR-0157 기제 권고

- **D1·D2·D3는 CubeSandbox 기본값(Cubelet eBPF `deny_out`)으로 성립 — 추가 기제 불요.**
- **D4는 "기제 선택"이 아니라 "기대값 검증"으로 재작성 권고**: `cubevsmapdump`가 5개 CIDR을 보고하는지 확인하는 검증 스크립트를 레포에 두고 런북·게이트에 편입. (선언성 요구를 이 형태로 충족)
- **D5는 검증됨**(§6.2·6.3). 단 **"루프백" 대신 "루프백 또는 사설IP+방화벽+AUTH_CALLBACK_URL"** 로 문언 확장 필요.
- **ADR-0156 D5 문언 정정 필요**: CubeProxy·CoreDNS는 exec 경로의 필수 종속이라 "쓰지 않는다"가 사실이 아니다(§6.4).

### 8.3 운영 런북 초안 (실행 검증된 순서)

```
[0] 사전:  uname -m=x86_64 / ldd>=2.31 / grep -w bpf /proc/filesystems
          stat -fc %T /sys/fs/cgroup = cgroup2fs, cgroup.controllers 에 cpu
          ip route 로 192.168.0.0/18 비충돌 확인
          ls -la /dev/kvm            # 표준 KVM 모드면 필수

[1] 데이터 디스크:  mkfs.xfs /dev/vdX ; mount /data ; fstab(UUID)
    mkdir -p /data/cubelet ; xfs_info /data | grep ftype=1
    # 시스템 디스크가 50GB 미만이면 추가로:
    #   /usr/local/services -> /data/services  (bind)
    #   /var/lib/containerd -> /data/containerd (bind)   ★ rsync -aX (xattr 필수)

[2] cgroup:  echo +cpu > /sys/fs/cgroup/cgroup.subtree_control

[3] docker-ce 설치 + enable

[4] 설치(표준 KVM):
    curl -sL .../deploy/one-click/online-install.sh -o online-install.sh
    bash online-install.sh --node-ip=<사설IP>          # CUBE_PVM_ENABLE 미설정
    # 91초, quickcheck 6/6

[5] 하드닝  (.one-click.env)
    CUBE_API_BIND=127.0.0.1:3000        # 동일 호스트
    CUBE_API_BIND=<사설IP>:3000          # 분리 호스트 — + 방화벽 + 아래 콜백
    AUTH_CALLBACK_URL=https://<oort>/internal/t3/authz     # fail-closed 확인됨
    MYSQL/REDIS 기본 비밀번호 전량 교체  (cube_pass / cube_root / ceuhvu123)
    systemctl restart cube-sandbox-cube-api
    검증: ss -lntp | grep 3000  /  외부에서 3000·8089·9999·12088 차단 확인

[6] 네트워크 경계 검증  ★신규
    cubevsmapdump | 각 tap ifindex의 deny_out 이
      10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16
      5개를 전부 포함하는지 단정 (없으면 설치 실패로 취급)

[7] 템플릿:
    cubemastercli tpl create-from-image --image <oort-workd:tag> \
      --alias oort-workd --writable-layer-size <N>G --expose-port <p> --probe <p> \
      --with-cube-ca=false          # ★ CubeEgress MITM CA 주입 방지
    cubemastercli tpl watch --job-id <id>      # READY (참조 이미지 기준 41초)

[8] 스모크: POST /sandboxes -> GET -> pause -> connect -> DELETE -> GET(404)
```

### 8.4 소요·비용 추정

| 항목 | 실측/추정 |
|---|---|
| 호스트 준비(디스크·cgroup·docker) | **≈ 6분** |
| CubeSandbox 설치 | **91초** |
| 템플릿 1개 빌드(참조 이미지) | **41초** |
| 첫 폐곡선 스모크 | **< 1분** |
| **신규 호스트 → 첫 샌드박스까지** | **≈ 10분** (런북대로면) |
| 설치 디스크 점유 | **≈ 4.1 GB** (스택 3.8 + 템플릿 0.3) |
| 기저 메모리 | **3.1 GB** |
| 동시 세션(2 GiB 워킹셋, 32 GB 박스) | **≈ 14** (권고 상한 10) |
| 동시 세션(8 GB 박스) | **≈ 2** — 가능하지만 실용성 낮음 |
| 동시 세션(16 GB 박스) | **≈ 6** |

> **발주 사양 판정**: 매핑표 §3.2 권고(**x86_64 / 8~16 vCPU / 32 GB / 시스템 50 GB + 데이터 200 GB**)는 **유지**. 근거는 바뀌었다 — 기저 메모리는 예상보다 작지만(3.1 GB), **세션당 실사용이 지배적**이라 32 GB가 동시 10~14 세션의 최소선이다. 시스템 디스크 50 GB 요구는 `/var/lib/containerd`(2.1 GB) + 번들 전개(1.7 GB) 때문에 **실물 근거가 확인**됐다.
> **모드 판정**: **표준 KVM 모드로 충분하다.** nested KVM VM에서 커널 교체 없이 전 항목이 돌았고, PVM이 강제하는 `pti=off` 등 완화 해제를 피할 수 있다. **PVM 비교는 불요 — ADR-0156 증보 2의 "1차=표준 KVM"이 실측으로 확정.** (성능은 1st-party PVM 벤치보다 3~4배 느리지만, 그것은 PVM/표준 차이가 아니라 **CPU 세대 차이**(Xeon Gold 5220 vs EPYC 9K65)로 보인다.)

---

## 9. 미해소·후속

| # | 항목 | 상태 |
|---|---|---|
| U1 | PVM 커널 부팅 | **불요** — 표준 KVM 확정으로 경로 폐기 |
| U3 | 디스크 실점유 | **해소** — 4.1 GB(§1.3) |
| U4 | pause/resume 보존 | **해소** — PID 동일·FS 보존(§3.5) |
| U5 | `default_timeout_insec` 의존 | **해소** — 우리가 항상 `timeout` 명시 + `/refreshes` |
| U6 | v1.0 / API 안정성 | 미해소(상류 로드맵) |
| U7 | CVE 이력 | 미조회 |
| **N1** | `state=pausing` 실물 관측 | 창이 짧아 미포착 — 어댑터는 여전히 present로 접어야 함 |
| **N2** | `envVars`의 PID1 미도달이 workd 기동에 미치는 영향 | **D4-③에서 확인 필요**(M1) |
| **N3** | `deny_out` 기본값의 상류 변경 가능성 | 검증 스크립트로 방어(§5.3) |
| **N4** | 다중 노드/스케일아웃 | 미시험(중첩가상화 미지원 = 베어메탈 필요, 매핑표 §1.1 유효) |

---

## 부록 — 재현 자산 (전부 scratchpad, 레포 미커밋)

| 파일 | 용도 |
|---|---|
| `d42.sh` | SSH 헬퍼(키인증) |
| `d42_loop.py` | 폐곡선 + 상태코드 + metadata 멱등 경로 |
| `d42_idle.py` | idle 시계 / onTimeout kill·pause / probe lossy 1차 |
| `d42_net.py` | exec + 네트워크 경계 + 인-샌드박스 활동 + U4 |
| `d42_final.py` | envVars / D2 / 시계 확정 / U4(PID) / 밀도 |
| `d42_d2.py`, `d42_d2b.py` | D2 피어 격리(양성 대조) + lossy 수렴 5분 관측 |
| `d42_dens.py` | 실사용 메모리 밀도 |

VM 상태: 스택 **기동 중**, 샌드박스 0개, 템플릿 `tpl-50622c58811449bbba60cc1e`(alias `oort-spike`) READY, CubeAPI는 `127.0.0.1:3000` 바인드(하드닝 적용됨), `AUTH_CALLBACK_URL` 해제(테스트 산출물 제거). **terminate 안 함 — 정리는 오케스트레이터.**
