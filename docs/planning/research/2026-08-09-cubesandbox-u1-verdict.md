# U1 판정 — NCP 일반 VM에서 PVM 호스트 커널이 부팅되는가

- **실측일**: 2026-08-09 00:37 ~ 01:00 KST (소요 약 23분, 그중 커널 설치 3분 + 재부팅 2회 각 20초 이내)
- **대상**: `cube-u1-test` / 10.0.1.7 / Rocky Linux 9.8 (Blue Onyx) / 2 vCPU · 7.86 GB RAM · 10 GB vda
- **하드웨어**: Intel Xeon Gold 5220 (Cascade Lake) · BIOS vendor `NAVERCloud` / model `GEN3` · **레거시 BIOS 부팅**(UEFI 아님, Secure Boot 없음)
- **대상 자산**: CubeSandbox v0.6.0 `kernel-6.6.69_opencloudos9.cubesandbox.pvm.host_g0de43d6b3bcd-1.x86_64.rpm` (603,127,085 B, sha256 `95e1c097d229b4268fd96a67a9f4ef05c6c97db91af42f6a8ff20054cc3a40fb`)

---

## 판정: **PASS — NCP 표준 VM에서 PVM 호스트 커널은 부팅된다**

`uname -r` = `6.6.69-opencloudos9.cubesandbox.pvm.host-g0de43d6b3bcd`

2단계로 나눠 실측했고 **둘 다 통과**했다.

| 단계 | 조건 | 결과 |
|---|---|---|
| **Stage 1** | PVM 커널 + Rocky 기본 cmdline (PVM 부트 파라미터 없음) | **부팅 성공** — 20초 내 SSH 복귀 |
| **Stage 2** | PVM 커널 + `host_grub_config.sh` 전체 파라미터(`pti=off`·`clearcpuid=60여개`·`module.sig_enforce=1` 등) | **부팅 성공** — 20초 내 SSH 복귀, `systemd-analyze` = 8.842s, failed unit 0개 |

단계를 쪼갠 이유: 실패했을 때 "커널이 안 뜬 것"과 "부트 파라미터가 깬 것"을 구분하기 위함. 결과적으로 둘 다 무사해서 분리 자체는 판정을 바꾸지 않았지만, D4-② 본판에서 다른 CPU 모델을 만나면 같은 순서로 나눠야 한다.

### PVM 모듈 실동작 (lsmod를 넘어선 신호)

```
kvm_pvm                49152  0
kvm                  1179648  1 kvm_pvm
```

모듈이 뜬 것만으로 만족하지 않고 KVM ioctl 경로를 직접 때렸다 — **`KVM_GET_API_VERSION`=12, `KVM_CREATE_VM` OK, `KVM_CREATE_VCPU` OK.** 즉 `/dev/kvm`이 kvm_pvm 백엔드로 실제 VM·vCPU를 만든다. 재부팅 후 자동 로드도 확인(아래 B-2 조치 포함).

---

## ★ 판정보다 큰 발견: **NCP 표준 VM은 이미 `/dev/kvm`을 준다 (중첩 가상화 활성)**

U1의 전제("NCP 일반 VM에는 `/dev/kvm`이 없으니 PVM이 필요하다")가 **사실과 다르다.** 커널을 건드리기 전, 순정 Rocky 상태에서 이미:

- `/dev/kvm` 존재 (`crw-rw-rw- root kvm 10, 232`), `kvm_intel` 로드됨
- `lscpu`: Virtualization=**VT-x**, Hypervisor vendor=KVM
- `/sys/module/kvm_intel/parameters/nested` = **Y**

그리고 말로 끝내지 않고 **L2 게스트를 실제로 띄웠다**:

```
/usr/libexec/qemu-kvm -accel kvm -m 512 -smp 1 -nographic \
  -kernel /boot/vmlinuz-5.14.0-687.15.1.el9_8.x86_64 -append "console=ttyS0 panic=1"
→ SeaBIOS → Linux 5.14 부팅 → "Hypervisor detected: KVM" 까지 정상 진행
```

`-accel kvm`은 KVM 초기화 실패 시 TCG로 조용히 넘어가지 않고 즉시 죽는다. 완주했다는 것은 **중첩 KVM 가속이 실제로 동작**한다는 뜻이다.

**함의 — ADR-0156 D-1(구성 A vs B)의 근거가 바뀐다.** 리서치는 "조달 가능성" 때문에 A(PVM 커널 교체)를 골랐는데, NCP 표준 VM이 네이티브 `/dev/kvm`을 주므로 **구성 B(커널 교체 없음)가 NCP 일반 VM에서 그대로 성립**한다. B를 쓰면:

- out-of-tree 3rd-party 커널(OpenCloudOS 6.6.69) 상시 종속 **제거** → 커널 보안 패치 추적 부담 0
- `pti=off`·`retbleed=off` 등 투기실행 완화 약화 **회피** (리서치 §1.4가 지적한 바로 그 리스크)
- 설치가 `curl … | bash` 한 줄로 축소 (`CUBE_PVM_ENABLE=1` 불필요)

다만 이 실측이 **증명하지 않은 것**을 분명히 해둔다: 중첩 KVM 위에서 cubelet 마이크로VM의 **성능**이 어떤지는 재보지 않았다. 중첩 가상화는 통상 상당한 페널티가 있고, 리서치의 PVM 벤치(create 66.7 ms)는 **비중첩** 표준 CVM 수치다. **D4-②에서 A/B를 같은 워크로드로 나란히 재는 것을 권고**한다 — 지금은 "B가 가능하다"까지만 확정됐지 "B가 더 빠르다"는 미확정이다.

---

## ★ 상류(upstream) 결함 3건 — D4-② 런북에 반드시 반영

### B-1. `host_grub_config.sh`는 RHEL9 계열에서 **조용히 아무것도 안 한다** (치명)

Rocky 9는 `GRUB_ENABLE_BLSCFG=true`라서 커널 인자가 `/boot/loader/entries/*.conf`의 `options` 줄에서 온다. `/etc/default/grub`의 `GRUB_CMDLINE_LINUX`는 **신규 BLS 엔트리 생성 시에만** 참조된다. 그런데 스크립트는 `/etc/default/grub`만 고치고 `grub2-mkconfig`를 돌린다.

실측 — 스크립트 실행 전후 BLS `options` 줄이 **바이트 단위로 동일**:

```
[전] options root=UUID=… ro crashkernel=1G-2G:192M,… net.ifnames=0 console=ttyS0,115200n8 console=tty0
[실행] "Generating grub configuration file ... done"   ← exit 0, 성공 메시지
[후] options root=UUID=… ro crashkernel=1G-2G:192M,… net.ifnames=0 console=ttyS0,115200n8 console=tty0
```

**즉 운영자는 "PVM 파라미터 적용 완료"라고 믿지만 실제 부팅 커맨드라인에는 하나도 안 들어간다.** exit 0 + 성공 로그라서 게이트로도 안 걸린다. 리서치 §1.8 런북의 `bash <(curl …host_grub_config.sh)` 한 줄을 그대로 쓰면 D4-②는 **파라미터 없이 PVM 커널만 뜬 상태**를 "구성 완료"로 오인한다.

**대체 절차(실측 검증됨)** — BLS 엔트리에 직접 주입:

```bash
K=/boot/vmlinuz-6.6.69-opencloudos9.cubesandbox.pvm.host-g0de43d6b3bcd
NEWARGS=$(grep '^GRUB_CMDLINE_LINUX=' /etc/default/grub | sed -E 's/^GRUB_CMDLINE_LINUX="//; s/"$//')
grubby --update-kernel=$K --args="$NEWARGS console=ttyS0,115200n8 panic=30"
grubby --info=$K | grep args        # 반드시 눈으로 확인
# 재부팅 후 /proc/cmdline 로 재확인 — 이 2중 확인을 게이트로 박을 것
```

### B-2. NCP에서는 `kvm_intel`이 벤더 슬롯을 선점해 **`kvm_pvm`이 조용히 안 뜬다**

`modprobe kvm_pvm`이 **exit 0을 반환하는데 `lsmod`에 안 나타난다.** dmesg에만 이유가 있다:

```
[   30.128873] kvm: already loaded vendor module 'kvm_intel'
```

NCP는 VT-x를 노출하므로 `kvm_intel`이 먼저 자동 로드돼 KVM 벤더 훅을 쥔다. 이건 Tencent CVM(중첩 미노출)에서는 안 생기는, **NCP 고유 단계**다. 문서·런북 어디에도 없다. `modprobe`가 0을 주므로 스크립트 검증도 통과해버린다.

**조치(실측 검증됨)**:

```bash
printf 'blacklist kvm_intel\ninstall kvm_intel /bin/false\n' > /etc/modprobe.d/cube-pvm.conf
printf 'kvm_pvm\n' > /etc/modules-load.d/kvm-pvm.conf
# 현재 세션 즉시 전환이 필요하면: rmmod kvm_intel && rmmod kvm && modprobe kvm_pvm
```

적용 후 재부팅에서 `kvm_pvm` 자동 로드 확인함. **검증은 `modprobe` 종료코드가 아니라 `lsmod | grep -qE '^kvm_pvm '`로 해야 한다.**

### B-3. 같은 스크립트의 `console=` de-dup 버그 + 무효 파라미터

스크립트의 키 기준 중복 제거 루프가 `console=ttyS0,115200`을 넣은 직후 `console=tty0`을 처리하면서 **앞서 넣은 시리얼 콘솔을 지운다**(둘 다 키가 `console`). 실측 결과 병합된 줄에 `console=`은 **1개(`console=tty0`)뿐**이었다. 커널 교체 실패 시 유일한 구조 수단인 시리얼 콘솔이 사라진다 — 위험 방향이 정확히 반대다. (본 실측에서는 수동으로 `console=ttyS0,115200n8`을 재주입했다.)

부팅 로그가 잡아낸 무효 파라미터도 있다:

```
Unsupported mitigations=on, system may still be vulnerable        ← mitigations=는 off|auto|auto,nosmt만 유효. "on"은 무효
Unknown kernel command line parameters "no5lvl … biosdevname=0 spec_store_bypass_disable=prctl"
```

`spec_store_bypass_disable=prctl`이 이 커널 빌드에서 **인식되지 않는다** — 즉 상류가 의도한 SSB 완화가 실제로는 안 걸린다. `mitigations=on`도 무효라 무시된다. **상류 파라미터 세트를 "검증된 것"으로 신뢰하면 안 된다**는 증거.

---

## 부수 실측치

| 항목 | 값 |
|---|---|
| RPM 서명 | **없음** (`Signature: (none)`) — GPG 미서명 자산. 무결성은 sha256 수동 대조에 의존 |
| RPM 의존성 | `/bin/sh` + rpmlib뿐 → **EL9에서 `--nodeps` 불필요**, `rpm -ivh` 그대로 통과 |
| 설치 점유 | **3.49 GB** (`Size: 3486879867`) — 다운로드 603 MB의 5.8배. 9 GB 디스크에서 여유 5.5 GB → 1.7 GB로 축소 |
| `/boot` 점유 | vmlinuz 20.0 MB + initramfs **77.0 MB** + System.map 4.5 MB (960 MB 파티션에 469 MB 잔여 — 여유 있음) |
| 모듈 서명 | "Build time autogenerated kernel key"로 서명됨 → `module.sig_enforce=1` **안전**(실측 확인) |
| `CONFIG_VIRTIO_BLK` | `=y` (내장) → 루트 디스크 드라이버가 initramfs에 의존하지 않음. 부팅 성공의 큰 요인 |
| BLS 엔트리 자동 생성 | **정상** — `/sbin/installkernel`(grubby 제공)이 BLS 엔트리 + dracut initramfs를 자동 생성. 수동 개입 불필요 |
| kvm_pvm 파라미터 | `direct_switch=Y`, `cpuid_intercept=N` |
| meltdown 상태 | `pti=off`에도 `Not affected` (Cascade Lake는 하드웨어 완화 보유) — 이 CPU에서는 `pti=off` 실질 위험이 리서치 §1.4 우려보다 작다 |
| crashkernel | 256 MB 실제 예약 확인 (`/sys/kernel/kexec_crash_size`=268435456) |
| 부팅 시간 | 커널 1.872s + initrd 1.905s + userspace 5.064s = **8.842s** |

### 설치기 게이트 현황 (install.sh 조건을 U1에 대조)

| 게이트 | 결과 |
|---|---|
| `/dev/kvm` 존재 | **PASS** |
| MemTotal ≥ 7,500,000 KB | **PASS** (7,870,052) |
| `/data/cubelet` 계열 fs = xfs | **PASS** (`/` = xfs, `ftype=1`) |
| cgroup v2 + `cpu` 컨트롤러 | **PASS** (`cpuset cpu io memory net_cls hugetlb pids rdma misc`) |
| bpffs 마운트 | **PASS** (`/sys/fs/bpf` type=bpf) |
| PVM 일관성(kvm_pvm 로드 시 `CUBE_PVM_ENABLE=1` 필수) | 해당 — 로드됨, 설치 시 반드시 `CUBE_PVM_ENABLE=1` |
| **아웃바운드 443** | **BLOCKED** ← cubelet 미기동 사유 |
| 디스크 여유 | 2.3 GB — 하드 게이트는 없으나(코드상 디스크 용량 게이트 부재) 실사용 부족 |

**cubelet 최소 기동은 시도하지 않았다.** U1은 사설 서브넷이고 egress가 막혀(`repo.ncloud.com`만 도달, GitHub 443 타임아웃) `online-install.sh`가 원천적으로 못 돈다. 번들을 밀어넣어도 남은 2.3 GB에서 설치기가 중간에 죽을 가능성이 높아, "egress 때문에 실패"라는 판정을 흐리는 결과만 남는다. 게이트 대조로 대체했다 — 위 표대로 **환경 게이트는 전부 PASS이고 막는 것은 egress와 디스크 두 개뿐**이다.

---

## D4-② 본판 절차 초안 (U1 실측 반영본)

리서치 §1.8 [3]~[4]를 아래로 **교체**할 것. 변경점은 B-1·B-2·B-3 대응이다.

```bash
### 0. 사전 판단 — 그 전에 A/B부터 다시 고른다
ls -l /dev/kvm && lscpu | grep -i virtualization
# NCP GEN3에서는 /dev/kvm이 이미 있다 → 구성 B(커널 교체 없음)가 성립.
# A(PVM)로 갈 이유가 성능 실측으로 뒷받침되지 않으면 B를 쓴다.

### 1. 자산 반입 (egress 없는 사설 서브넷 전제)
#   U1은 GitHub 443이 막혀 있다. 점프 호스트를 ProxyCommand로 삼아
#   로컬 → 대상으로 scp. (점프 디스크에 쓰지 않는다)
scp -O -o ProxyCommand="ssh -W %h:%p <jump>" kernel-*.pvm.host*.rpm root@<target>:/root/
sha256sum -c <<< "95e1c097…  /root/kernel-….rpm"   # RPM 무서명이므로 필수

### 2. 설치 — 의존성 없음, --nodeps 불필요
df -h / /boot            # 루트에 최소 4 GB, /boot에 150 MB 여유
rpm -ivh /root/kernel-*.pvm.host*.rpm       # 3.49 GB 점유, 약 3분
#   BLS 엔트리·initramfs는 grubby의 installkernel이 자동 생성한다(확인됨)
ls /boot/loader/entries/ | grep pvm         # 엔트리 생성 검증

### 3. 부트 파라미터 — ★ host_grub_config.sh 를 그대로 믿지 말 것 (B-1)
bash host_grub_config.sh                    # /etc/default/grub 갱신용으로만 사용
K=/boot/vmlinuz-6.6.69-opencloudos9.cubesandbox.pvm.host-g0de43d6b3bcd
NEWARGS=$(grep '^GRUB_CMDLINE_LINUX=' /etc/default/grub | sed -E 's/^GRUB_CMDLINE_LINUX="//; s/"$//')
grubby --update-kernel=$K --args="$NEWARGS console=ttyS0,115200n8 panic=30"   # 시리얼 복구 (B-3)
grubby --info=$K | grep args                # ★ 게이트: pti=off·clearcpuid 육안 확인

### 4. 모듈 — ★ NCP는 kvm_intel 선점 차단이 필수 (B-2)
printf 'blacklist kvm_intel\ninstall kvm_intel /bin/false\n' > /etc/modprobe.d/cube-pvm.conf
printf 'kvm_pvm\n' > /etc/modules-load.d/kvm-pvm.conf

### 5. 안전망 있는 재부팅 (콘솔 없이도 회수 가능)
grubby --set-default-index=<기존 배포판 커널>       # 영구 기본값 = 폴백
grub2-reboot "<PVM 엔트리 id>"                     # 1회성 부팅
#   panic=30 + saved_entry 폴백 → 패닉 시 자동으로 기존 커널로 복귀
systemctl reboot

### 6. 검증 — 종료코드가 아니라 상태로 판정
uname -r                                    # …pvm.host…
cat /proc/cmdline | tr ' ' '\n' | grep -E 'pti=off|clearcpuid'   # ★ B-1 재확인
lsmod | grep -qE '^kvm_pvm ' && echo PVM_OK  # ★ modprobe rc 말고 이걸로 (B-2)
python3 - <<'PY'                             # ioctl 실동작
import fcntl,os
fd=os.open('/dev/kvm',os.O_RDWR)
print('api',fcntl.ioctl(fd,0xAE00,0)); print('vm',fcntl.ioctl(fd,0xAE01,0))
PY
systemctl is-system-running; systemctl --failed
#   여기까지 통과하면 grubby --set-default-index=0 으로 영구 전환
```

**디스크**: 커널만 3.49 GB이므로 리서치가 적은 "50 GB 하한"은 커널·번들·게스트이미지·템플릿을 합치면 실사용선이 아니다. D4-② 본판 박스는 **200 GB 권장선**으로 조달할 것.

---

## 현재 U1 상태 (인계용)

- **PVM 커널이 영구 기본값**으로 설정됨(2회 연속 부팅 검증 후 전환). 재부팅해도 PVM 커널로 뜬다.
- `kvm_pvm` 자동 로드, `kvm_intel` 블랙리스트 적용, 영속 저널(`/var/log/journal`) 활성.
- 남은 파일: `/root/host_grub_config.sh`, `/root/kvmtest.py`, `/root/install.log`. RPM은 공간 회수 위해 삭제(로컬 `scratchpad/pvm-host-kernel.rpm`에 원본 보존).
- 디스크 2.3 GB 여유 — 이 박스로는 cubelet 전체 설치 불가. D4-② 본판은 별도 조달 필요.
- **롤백**: `grubby --set-default-index=1` (Rocky 5.14로 복귀). 폐기 예정이면 불필요.
- **terminate 하지 않았다** (오케스트레이터 몫).
- 점프 호스트(101.79.11.189)에는 **아무 변경도 하지 않았다** — SSH `-W` 통과만 사용(디스크 쓰기 0). 기설치 sshpass 외 설치·재시작 없음.

## 미해결 / 다음 질문

1. **A vs B 성능 비교** — 중첩 KVM(B) 위 cubelet create/pause/resume 지연이 PVM(A) 대비 어떤가. 이게 D-1 재결정의 유일한 남은 근거다.
2. **NCP 인스턴스 타입별 중첩 가상화 일관성** — GEN3/Xeon Gold 5220에서 확인했을 뿐, 다른 세대·타입도 `/dev/kvm`을 주는지는 미확인. B로 간다면 조달 스펙에 "중첩 가상화 노출" 조건을 명시해야 한다.
3. **`clearcpuid` 목록의 CPU 모델 의존성** — Cascade Lake에서 부팅은 됐으나, 그 목록이 AMD EPYC 9K65 기준으로 만들어진 것이라 Intel에서 마스킹 의미가 동일한지 미검증(부팅에는 지장 없음).
4. **cubelet 실기동·디스크 실점유(U3)** — egress 열린 200 GB 박스에서 재실행 필요.
