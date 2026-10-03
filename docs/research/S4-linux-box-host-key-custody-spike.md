# S4 — Linux 박스 host 키 보관·영속 게이트·볼륨 키 파기 스파이크 (#3411)

- 근거: ADR-0197 D1(uid 분리)·D8(영속 게이트)·D10(crypto-shred)·구현 계획 S4, ADR-0188 D2(host 키)·D3(등록)
- 코드: `server-rust/bins/momo-workd/src/keystore/box_store.rs`(+ `tests.rs`), 배선 `keystore.rs`의 `KeyStore::Box`, `cli.rs`의 `key_store`
- 표기: [V] 이 스파이크에서 시험으로 확인 · [추정] 설계상 주장, 실행 안 함 · `runtime-unverified` 하드닝된 박스(비특권 uid·userns·읽기 전용 루트·실제 tmpfs/볼륨 분리)에서는 돌려 보지 않음. 시험은 macOS와 일반 `rust:latest` 컨테이너(root)에서 통과

## 한 줄 판정

**MVP M3: GO (조건부).** 박스 host 키는 「박스 안에서 생성 → 볼륨의 0600 봉인 파일」로 가고, 박스 삭제의 crypto-shred는 **봉인 키를 스냅샷 범위 밖(KMS 또는 런너의 봉인 저장소)에 둘 때만 방어로 센다.** 그 저장소가 없으면 crypto-shred는 ADR-0197 T14 그대로 「잔여 위험」으로 둔다(방어로 세지 않는다). M3 착수를 막는 블로커는 없다. 아래 「M3에 넘기는 일」이 남는다.

## 만든 것 (원형)

| 항목 | 내용 |
|---|---|
| 생성 | `HostKey::generate()`가 컨테이너 안에서 실행된다. 런너·서버·이미지는 시드를 보지 않는다. |
| 파일 | `<OORT_BOX_KEY_DIR>/host.key`. 일반 파일, 0600, 호출 uid 소유, 폴더 0700. `O_NOFOLLOW`, 검사는 열린 fd에서(dev 파일과 같은 `check_private_*`). 쓰기는 같은 폴더의 `O_EXCL` 0600 임시 파일 + rename + 폴더 fsync. |
| 봉인 | `OORT_BOX_SEAL_KEY_FILE`(런너가 tmpfs에 두는 박스별 32바이트 키)가 있으면 시드는 **AES-256-GCM 봉인본**(`oort-hostkey-sealed-v1`, 무작위 12바이트 nonce)만 디스크에 남는다. AAD에 박스 id가 묶여 다른 박스로 복사한 파일은 열리지 않는다. 봉인 키는 매 load/store마다 새로 읽는다(런너가 파기하면 즉시 반영). |
| crypto-shred | 런너가 삭제 때 하는 일은 `destroy_seal_key`(덮어쓰기 + unlink) **하나**다. `host.key`를 열지 않는다. 그 뒤 볼륨 사본(스냅샷·제공사 백업·남은 블록)은 키 없는 암호문이다. |
| 영속 게이트 | 런너가 root 소유·읽기 전용 파일에 `backups=none\|present`를 증명한다(`OORT_BOX_BACKUP_ATTESTATION`). 파일이 없거나, 박스 uid가 쓸 수 있거나, root 소유가 아니거나, 다른 문구면 `Unknown`이고 `Present`와 똑같이 취급한다(fail-closed). |
| 게이트 규칙 | (1) **평문 시드**는 백업이 `none`으로 증명될 때만 허용(쓰기·읽기 모두. 읽다가 증명이 사라지면 시작 거부). (2) **봉인 시드**는 백업이 있어도 허용하되 봉인 키가 **다른 장치**(tmpfs)에 있을 때만(스냅샷 하나에 두 반쪽이 함께 들어가지 않게). 둘 다 어기면 `Refused`이고 **한 바이트도 쓰지 않는다**. (3) 키 폴더의 마운트는 `nosuid,nodev`여야 한다(`/proc/self/mountinfo`, 못 찾으면 거부). |
| 자격 디렉터리 | `credential_placement(attestation)`: `none`이면 볼륨, 그 밖에는 tmpfs. `is_tmpfs`로 마운트 종류를 확인할 수 있다. host 키는 게이트와 무관하게 볼륨(D8 그대로). |
| 회전 | `rotate`: stage(`host.key.next`) → 새 공개키 등록(새 행) → 상태 파일 기록(`persist`) → 승격(rename) → 옛 행 revoke. 순서가 안전성이다(옛 행은 새 키가 현재가 된 뒤에만 죽는다). 어느 지점에서 죽어도 `recover(등록된 공개키)`가 서버·박스 일치로 되돌린다. |
| dev 플래그 | `OORT_BOX`가 설정된 박스에서는 `--dev-key-file`이 사용 오류다. macOS 키체인 경로는 바뀌지 않았다(Linux에서만 박스 저장소를 고른다). |

## 시험 [V] (모두 사보타주 RED→GREEN 확인)

`cargo test -p momo-workd --lib keystore` 33개(기존 dev 파일 5 + 박스 28). 리뷰 반영 뒤 최종 트리를 `rust:latest` 리눅스 컨테이너(root)에서도 돌렸다(결과는 PR 본문). 사보타주는 한 줄씩 깨뜨려 해당 가드 시험이 실제로 실패함을 확인한 뒤 복구했다.

| 사보타주 | 실패한 시험 |
|---|---|
| 읽기에서 모드 검사 제거 | `a_group_or_world_readable_key_file_is_refused` |
| AAD에서 박스 id 제거 | `a_sealed_file_does_not_open_in_another_box_or_after_tampering` |
| 평문 게이트 끔 | `a_plaintext_key_is_refused_unless_backups_are_proven_off_and_nothing_is_written`, `an_existing_plaintext_key_is_refused_once_the_volume_may_be_backed_up` |
| 복구가 승격 대신 폐기 | `recovery_resolves_every_crash_point_from_the_registered_public_key` |
| 봉인 키 파기가 파일을 남김 | `destroying_the_seal_key_makes_every_copy_of_the_volume_unrecoverable` |
| 증명 파일 소유자 검사 제거 | `the_attestation_only_counts_from_a_trusted_read_only_file` |
| 알 수 없는 증명을 `none`으로 취급 | 같은 시험 |
| 등록 후 상태 기록 실패 때 새 행을 안 거둠 | `a_failed_state_write_withdraws_the_new_row_and_keeps_the_old_key` |
| 봉인 무시하고 평문 기록 | 11개 |
| 마운트 검사에서 `nodev` 제외 | `the_key_mount_must_be_nosuid_nodev_and_a_login_tmpfs_must_be_tmpfs`(처음엔 통과해 버렸다. 픽스처에 `nosuid`만 있는 마운트가 없었기 때문이다. 추가 후 RED) |

crypto-shred 시험은 (a) 스냅샷 바이트를 떠 두고 (b) 봉인 키만 파기하고 (c) 같은 파일을 읽으면 `SealKeyGone`, (d) 새 봉인 키를 만들고 스냅샷을 복원해도 `Unseal`, (e) 원본 바이트 어디에도 시드·시드 base64가 없음을 확인한다.

## 보안 검수 반영 (fresh security-engineer, High 0)
검수에서 High 0, Medium 5·Low 7. 고친 것(각각 RED→GREEN 시험): M1 최초 기록의 경합 덮어쓰기(`replace=false`는 `link`로 EEXIST), M2 크래시로 남은 staged 키를 새 회전이 덮어쓰는 문제(`stage_next`가 거부 → `recover` 먼저), M4 `destroy_seal_key`의 심볼릭 링크 추종·쓰기 실패 시 unlink 생략(`O_NOFOLLOW`, unlink는 항상 실행), M5 경로의 `..`와 봉인 키 위치(`mountinfo`가 있으면 봉인 키 폴더가 **tmpfs**여야 「다른 장치」), L2 `OORT_BOX_KEY_DIR`만 있어도 dev 플래그 거부, L5 봉인 설정인데 평문 파일이면 다운그레이드로 거부, L6 8진수 이스케이프 엄격화.
남기고 M3로 넘기는 것: **M3-리뷰** promote와 revoke 사이 크래시 시 `RevokePending`이 메모리에만 있다 → `persist` 콜백이 `old_host_id`를 함께 남기고 시작 시 revoke를 재시도해야 한다. L1 증명을 시작 때 한 번만 읽는다(런타임에 `present`로 바뀌면 다음 쓰기에도 반영되지 않음. 증명 폴더 소유자·모드 검사 없음). L3 시드·봉인 키 사본이 메모리에서 지워지지 않는다(`Zeroizing` 후속, 같은 uid 메모리 읽기는 위협 모델 안). L4 AAD가 파일명·세대를 묶지 않는다. L7 `create_seal_key`가 소유 uid를 지정하지 않는다(런너 root가 만들면 박스에서 `SealKeyGone`으로 안전하게 실패). 환경 변수 가드는 실수 방지용이고 벽은 box-agent 별도 uid다.

## 위협 모델 개정 (ADR-0197 D8 「위협 모델 개정은 S4가 한다」)

| 위협 | 효과 | 남는 것 |
|---|---|---|
| 제공사 볼륨 스냅샷·백업, 삭제 후 남은 블록 | 봉인본만 있다. 봉인 키를 별도 범위에 두고 파기하면 **복구 불가** [V] | 봉인 키 저장소가 같은 스냅샷에 들면 무효(아래 K1) |
| 다른 박스·다른 uid가 파일을 읽음 | 0600/0700 + uid 검사 + 별도 마운트 `nosuid,nodev` [V]. 하네스 uid와의 분리는 M3 시험 | 같은 uid 안의 프롬프트 주입 하네스는 봉인 키(tmpfs)도 읽을 수 있다. 방어는 D1의 box-agent 별도 uid뿐 |
| 파일 교체·심볼릭 링크 | `O_NOFOLLOW`, 폴더 모드·소유자 검사 [V] | 사용자 uid가 쓸 수 있는 폴더면 거부 |
| 봉인본 변조·타 박스 이식 | GCM 인증 + 박스 id AAD [V] | |
| 증명 파일 위조 | 박스 uid가 쓸 수 있거나 root 소유가 아니면 `Unknown` [V] | 런너 root 침해(T2)는 막지 못한다. 공개된 잔여 위험 |
| 라이브 운영자 | 막지 못한다 | ADR-0197 T2 그대로(정책·감사) |
| 유출된 host 키 | 회전 + revoke로 신원 교체 [V]. 서버가 같은 키의 중복 접속을 거부하면(D1) 볼륨 복제본도 막힌다 | 서버 쪽 중복 접속 거부는 이 스파이크 범위 밖(M3) |

### K1 — 봉인 키는 어디에 두는가 (crypto-shred가 방어인지 가르는 질문)
- 런너 VM 디스크에 두면 VM 스냅샷에 볼륨과 키가 함께 들어가 shred가 성립하지 않는다(ADR D10이 이미 경고). 이 스파이크의 코드는 봉인 키를 「박스에 파일로 주입되는 것」으로만 가정하고 **주입 원천은 정하지 않는다.**
- 방어로 세는 조건: 봉인 키 원천이 (a) 외부 KMS/TPM 또는 (b) 스냅샷 대상이 아닌 런너의 별도 저장소이고, 박스 시작 때마다 런너가 `/run`(tmpfs)에 0600으로 내려 준다.
- (b)를 런너 메모리/tmpfs에만 두면 런너 재부팅이 모든 박스의 host 키를 영구히 잃게 만든다. 이때의 복구 경로가 **재등록**이다. 회전 경로(`rotate`는 옛 키가 없어도 새 키를 stage·등록할 수 있고 옛 행은 소유자가 revoke)로 감당 가능하지만 소유자 기기 재서명(R2)이 든다. MVP는 이 비용을 받아들일지 정해야 한다.
- Railway 어댑터(ADR 결재의 1순위 배치): 런너 VM이 없다. 봉인 키를 서비스 변수로 두고 엔트리포인트가 `/run`에 쓰면 볼륨 백업과 키가 다른 범위가 된다 [추정]. 변수는 provider 콘솔·프로젝트 토큰으로 읽힌다(S1의 토큰 범위 실측에 의존). 박스 삭제 때 변수 삭제 = shred. Railway 쪽 변수 삭제가 복구 불가인지는 S1/H5가 확인해야 한다(`runtime-unverified`).

### LUKS/fscrypt를 쓰지 않은 이유
- LUKS는 `dm-crypt`와 `CAP_SYS_ADMIN`(또는 호스트 쪽 설정)이 필요해 「모든 capability drop·비특권」 박스(D1)와 맞지 않는다. 런너가 볼륨 마운트 때 호스트에서 열 수는 있으나 그러면 런너 VM에 키가 상주한다(K1과 같은 문제).
- fscrypt는 커널·파일시스템 지원(ext4/f2fs)과 키링 ioctl이 필요하고 Railway 볼륨 파일시스템에서 쓸 수 있는지 불명이다 [?].
- 그래서 **응용 계층 봉인(AES-GCM)** 으로 host 키 한 파일만 보호했다. 하네스 자격 디렉터리는 봉인하지 않는다(게이트 불통과 시 tmpfs, 통과 시 평문 볼륨). 이 판단이 자격 파일에도 crypto-shred를 원하면 LUKS/fscrypt가 다시 열린다.

## 등록 일관성 (ADR-0188)
- 불변식: 박스의 현재 `host.key`의 공개키 = 서버에 등록된 공개키(상태 파일). `cli.rs`의 시작 검사(저장 키와 등록 공개키 불일치 시 거부)가 이미 이것을 강제한다.
- 크래시 지점별 [V]: 등록 전/중 실패 → 옛 키·옛 행 그대로. 상태 기록 실패 → 새 행 revoke, 옛 키 유지. 상태 기록 뒤·승격 전 크래시 → `recover`가 승격. 등록 응답 뒤·상태 기록 전 크래시 → `recover`가 폐기, **서버에 고아 행 하나**(소유자가 host 목록에서 revoke. 등록 응답과 로컬 기록 사이는 어떤 register-then-record 프로토콜도 피할 수 없다). 옛 행 revoke 실패 → `RevokePending`으로 보고. **살아 있는 위험이다**: 봉인 키는 박스 단위라 회전해도 그대로이므로, 회전 전 볼륨 스냅샷과 현재 봉인 키가 함께 있으면 옛 시드를 복구할 수 있다. revoke를 끝까지 재시도해야 하고, 봉인 키 자체의 회전(재봉인)은 후속 선택지다.
- **새 행 = 새 host id.** 소유자가 고정한 신뢰(`TrustIdentity.host_id`)와 R2 래치는 host id에 묶여 있고 `register`/`forget`이 `remove_trust_files`로 지운다. `rotate`의 `persist` 콜백이 `register`와 같이 상태 기록 + 신뢰 초기화를 해야 하고 소유자가 서명한 등록으로 다시 고정한다. 이 스파이크는 콜백 계약을 문서화했을 뿐 배선하지 않았다(M3 1번).
- 현재 `register --force`는 새 키를 **먼저 덮어쓴다**(옛 행이 고아가 되고, 등록 실패 시 키도 사라진다). 박스에는 `rotate`/`recover`를 쓴다. 맥 경로의 `--force`는 이 PR이 바꾸지 않았다.

## M3에 넘기는 일
1. **`momo-workd rotate`/시작 시 `recover` 배선.** 라이브러리는 `HostRegistry`(register/revoke) 트레이트만 있다. 어댑터는 `client::register_host`·`revoke_registered_host`와 R2 서명자를 감싸면 된다. 시작 경로에서 `load` 전에 `recover(state.public_key)`를 부른다.
2. **box-agent 별도 uid 시험**(사용자 uid의 host 키 읽기·교체·ptrace 거부, 이미지에 setuid 없음). 이 스파이크는 같은 uid의 모드·소유자 검사까지만 시험했다. 컨테이너 안 실측 `runtime-unverified`.
3. **봉인 키 원천 결정**(K1) — KMS/별도 저장소/Railway 변수 중 무엇인지, 런너 재부팅 때의 재등록 정책.
4. **서버의 같은 host 키 중복 접속 거부**(볼륨 복제본 방지)와 박스 삭제 시 host revoke 연쇄(D10).
5. **증명 파일의 신뢰 uid.** `BackupState::read(.., 0)`은 박스 안 root 소유를 요구한다. D1의 사용자 네임스페이스 재매핑 아래에서는 호스트 root가 쓴 파일이 박스 안에서 overflow uid로 보여 게이트가 영원히 `Unknown`(안전하지만 통과 불가)이 된다. 런너가 매핑된 root로 쓰거나 신뢰 uid를 설정 가능하게 해야 한다.
6. **증명 파일의 실제 생산자**: 런너 A는 설치 런북이 스냅샷 부재를 확인한 뒤 root가 쓴다. 런너 B(Railway)는 볼륨 백업을 끌 수 있음이 S1에서 증명되기 전에는 `present`로 둔다(자격은 tmpfs).
7. Linux 컨테이너에서 이 시험 묶음을 한 번 돌리는 CI/수동 확인(`/proc/self/mountinfo` 경로 포함).
