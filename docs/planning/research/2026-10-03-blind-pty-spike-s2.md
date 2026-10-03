# S2 스파이크 — 눈먼 중계 PTY 프로토타입 (ADR-0197, #3409)

- 날짜: 2026-10-03 · 트랙: 엔진 · 기안: Sonnet 5.5 worker
- 계약: [ADR-0197](../../adr/0197-personal-cloud-workspace.md) D5 PTY 레인, 위협 T1·T7·T9·T11, 구현 계획 S2 ①~④
- 코드: `server-rust/crates/momo-blind-pty/` (시험 전용 라이브러리, 어떤 bin·라우트도 의존하지 않음)
- 표기: [V] 이 세션에서 실행해 확인 · **runtime-unverified** 실제 WebSocket·TLS·Railway·실기기 Secure Enclave는 실행하지 않음

## 한 줄 결론
**M4 GO (조건 6개).** 서버가 평문을 읽거나 PTY 입력을 주입할 수 있는 경로는 이 프로토콜에서 찾지 못했다([V] 시험 30개 + 사보타주). 단 아래 「M4 착수 조건」 6개를 M4 수용 기준에 넣어야 하고, 그중 ①(새 기기 등록의 신뢰 뿌리)과 ②(소유자 목록 감사)가 없으면 NO-GO다.

## 프로토콜 (암호군 1개, 협상 없음, 스키마 `momo.blind_pty.v1`)

### 신뢰 사슬 (서버 밖에서 확인)
1. 런너가 Ed25519 키를 만들고 **지문(SHA-256)은 런너 콘솔에만** 나온다. 운영자가 oort 밖 채널로 멤버에게 알리고, 멤버는 기기에 **직접 입력**한다(`set_runner_fingerprint`).
2. 박스 host 키(Ed25519)는 런너가 생성 때 `attest_host(box_id, host_pub)`로 **증명**한다.
3. 기기가 입력된 지문과 런너 공개키를 대조하고 증명을 검증한 뒤, 소유자 기기 키(P-256)로 `HostPin`(host 공개키 + 런너 지문 + 증명)에 **서명**한다(`pin_host`). 서버는 `HostPin`을 저장·전달할 수 있으나 만들 수 없다(`import_pin`이 두 증명을 다시 검증).
4. 지문 대조 전에는 `hello()`가 `HostNotPinned`로 거부한다 = 박스를 열지 않는다. 이미 고정된 박스의 host 키가 바뀌면 `HostKeyChanged`이고 자동 교체하지 않는다.
5. 소유자 기기 목록 `DeviceList{box_id, version, devices, signer, sig}`: 단조 증가 버전, 현재 목록의 기기가 서명해야만 갱신된다. 서버가 보낸 어떤 목록도 소유자 서명이 없으면 `DeviceListBadSigner`, 버전이 같거나 낮으면 `DeviceListRollback`.

### 붙기 핸드셰이크 (box-agent가 응답자)
```
Device                         Relay (oort server)                    Box-agent
  Hello{box_id, dev_pub, nonce_d, eph_d} ─────────► forward ─────────►  (목록에 없는 dev_pub이면 챌린지 없음)
                                                                         nonce_b, eph_b 생성, 만료 = now+60s(단조 시계)
  ◄──────── Challenge{host_pub, nonce_b, eph_b, expires, SigEd25519(T)} ◄┘
  host_pub == 고정된 키? SigEd25519 검증?
  Auth{nonce_b, SigP256(T)} ───────────────────────► forward ─────────►  챌린지 1회 소비, 만료·목록·SigP256 검증
  ◄──────── Ready (AES-GCM 첫 프레임) ◄──────────────────────────────────┘
  이후 Data/Resize/Close 프레임
T = SHA-256(스키마 ‖ box_id ‖ host_pub ‖ dev_pub ‖ nonce_d ‖ nonce_b ‖ eph_d ‖ eph_b ‖ expires)
서명 대상 = 스키마/역할 라벨 ‖ T  (역할 라벨 box_sig / attach_sig 로 서로의 서명을 바꿔 쓸 수 없다)
키 = HKDF-SHA256(salt=T, ikm=ECDH(eph_d, eph_b)) → d2b, b2d (info = 스키마/key/방향)
프레임 = counter(8, 평문) ‖ AES-256-GCM(kind ‖ payload), nonce = 0⁴ ‖ counter, AAD = T ‖ 방향 ‖ counter
수신자는 counter == 기대값만 받는다(건너뜀·중복·재정렬 거부). 오류 한 번이면 세션 폐기, 재연결 = 새 핸드셰이크.
```
서버는 위 어느 단계에서도 판단하지 않는다. 시험의 중계는 바이트를 받아 그대로 넘기거나(정직) 변조·삽입·재생한다(적대).

### ADR 본문과 다른 점 (증보 대상)
| ADR 문구 | 실제 | 이유 |
|---|---|---|
| 임시 X25519 | **임시 P-256 ECDH** | `x25519-dalek`이 잠금 파일에 없다. 소유자 기기 키(Secure Enclave)가 이미 P-256이고 `p256`이 이미 의존이다. 새 크레이트 없이 `ecdh` 기능만 켰다. 보안 수준 동급(128비트). |
| 정확한 프로토콜(예: Noise 변형) | 위의 서명된 transcript + HKDF + AEAD, **Noise 아님** | 상호 인증을 「양쪽 신원 서명 + 양쪽 임시키·nonce 결합」으로 직접 세웠다. 양쪽 장기 키가 서로 다른 곡선(P-256 / Ed25519)이고 Secure Enclave는 ECDH 장기 키 합의를 제공하지 않아 Noise XX/IK를 그대로 쓸 수 없다. |

## 의존과 라이선스 [V]
새 암호 구현 없음. 모두 기존 의존이다: `p256`(`ecdh` 기능 추가, ADR-0146 기기 서명과 같은 크레이트), `ed25519-dalek`, `sha2 0.10`, `aes-gcm 0.10`(momo-settings가 이미 사용), `hkdf 0.12`(sqlx 경유로 이미 잠금), `getrandom 0.2`(workd가 이미 사용).
`p256`의 `ecdh` 기능이 `hkdf 0.13.0` 패키지를 잠금 파일에 **하나 추가**한다(MIT OR Apache-2.0, RustCrypto). `legal/generated/GHCR_*`를 재생성했고 `scripts/check_ghcr_notice_bundle.sh` PASS. 새 크레이트 매니페스트는 `server-rust/Dockerfile` COPY에 추가했다.

## 시험과 사보타주 [V]
`cargo test -p momo-blind-pty`: 프로토콜 26 + 단위 2 + 서버 라우트 1 + loopback 1 = 30개, 전부 GREEN. 모든 단정은 거부 **이유**(`Error` 변종)를 구분해 확인한다.

### 수용 기준 ①: 각 거부를 RED로 잠금
| 시험 | 닫는 위협 |
|---|---|
| `box_never_opens_before_runner_fingerprint_comparison` | 지문 미입력·오입력 → 박스를 열지 않음 |
| `host_key_without_runner_attestation_is_refused` | 런너 증명 없는 키·다른 박스용 증명 거부 |
| `host_key_without_owner_endorsement_is_refused` | 서버 서명·가짜 서명자 `HostPin` 거부 |
| `changed_host_key_is_never_silently_accepted` | 박스 신원 교체 |
| `relay_substituting_its_own_host_key_or_signature_is_detected` | 서버가 자기 host 키·서명으로 바꿔치기 |
| `ephemeral_key_substitution_mitm_is_detected_by_transcript_signatures` | 임시키 치환 MITM(양방향) |
| `device_list_rollback_and_server_forged_lists_are_rejected` | 옛 목록 재전송, 서버가 만든 최고 버전 목록, 서명 뒤 본문 변조, 폐기 반영 |
| `unlisted_device_gets_no_challenge` / `server_posing_as_a_device_gets_no_session_and_no_pty_input` | 서버가 「기기」 행세 → box-agent가 입력을 버림(세션 자체가 생기지 않음) |
| `device_revoked_between_hello_and_auth_cannot_finish` | 챌린지 사이 폐기 |
| `attach_signature_replay_is_refused_including_after_agent_restart` | 붙기 서명 재사용(같은 agent, 재시작 후 저장소 복원, 저장소를 잃은 재시작) |
| `old_auth_replayed_against_a_fresh_challenge_fails` | 옛 Auth를 새 챌린지에 접합 |
| `expired_challenge_is_refused` | 만료(경계값 포함) |
| `reconnect_derives_fresh_keys_so_old_frames_and_counters_are_dead` | 재연결 시 카운터 0이 같아도 옛 프레임은 키 분리로 거부 |
| `relay_flipping_one_ciphertext_bit_is_detected`, `relay_cannot_edit_the_counter_or_reorder_drop_duplicate` | 변조·재정렬·누락·중복·카운터 고쳐쓰기 |
| `relay_injecting_frames_without_the_session_key_is_detected`, `reflecting_a_frame_back_at_its_sender_is_detected` | 삽입·반사 |
| `truncation_by_the_relay_is_visible_as_a_missing_close` | 꼬리 절단은 인증된 Close 부재로 보임 |
| `pending_challenges_are_capped_before_authentication`, `hello_for_another_box_is_refused` | 인증 전 상태 상한, 다른 박스 |
| `box_provisioned_with_a_server_chosen_device_is_caught_by_the_owner_audit`, `owner_audit_checks_signer_and_member_set_independently` | 서버가 박스 생성 때 기기를 끼워 넣음 |

### 수용 기준 ②: 서버 라우트는 암호문만
`tests/blind_relay.rs`. 중계를 **최악의 서버**로 만들었다: 모든 프레임을 기록하고 raw·hex로 전부 로그에 쓴다. PTY 평문에 표식 `OORT-S2-MARKER-…`를 40번 심고 실제 `tracing` 구독자로 로그를 캡처해 grep한다. 표식 수는 로그 0, hex 0, 기록된 프레임 0(양성 대조: 끝점은 표식 40개를 받았고, `relay dump` 로그 40줄 이상이 캡처됐다).
**사보타주:** `--features sabotage-null-cipher`(AEAD를 항등 함수로)에서 이 시험이 RED이고(`tests/blind_relay.rs:85`), 프레임 시험 6개도 RED다.
```
test relay_logs_metrics_and_recorded_bytes_contain_no_plaintext ... FAILED
test result: FAILED. 18 passed; 6 failed  (relay_flipping..., reflecting..., relay_injecting..., reconnect_derives..., spoofed_ready..., relay_cannot_edit...)
```
한계: 코어 덤프·APM·패닉 덤프는 실행하지 않았다(M4/H4의 라우트 시험).

### 변조 시험(가드를 하나씩 제거했을 때 RED가 되는가)
`~/.cache/momo-scratch/3409/mutate.py`로 소스의 가드 한 줄씩을 `if false`/삭제로 바꿔 전체 시험을 돌렸다. 아래 24개 변이가 모두 RED다.
기기 목록 확인(hello·auth 각각), 기기 서명 검증, 챌린지 1회 소비, 만료, 목록 버전·서명자, 기기의 host 키 고정·서명 검증, 지문 대조·지문 필수, 런너 증명, 소유자 보증(검증·서명자 목록), 카운터, 방향 키·방향 바이트 분리, transcript의 임시키 포함, 대기 챌린지 상한, 박스 id, Ready 선행, 핀 덮어쓰기, 소유자 감사(서명자·구성원 각각).
**RED가 아닌 하나:** AEAD AAD에서 transcript 제거. 키 도출이 이미 transcript를 salt로 쓰므로 AAD의 transcript는 **중복 방어층**이다(약화하지 않는다는 뜻이지 막힌 위협이 없다는 뜻은 아님). 정직하게 중복으로 표기한다.

### 수용 기준 ③: 지연·재연결 (loopback TCP, 순수 바이트 파이프 중계)
`tests/loopback.rs`. 개발 머신 한 대, **runtime-unverified**(WebSocket·TLS·인터넷 RTT 없음).
| | release | debug |
|---|---|---|
| 핸드셰이크(Hello→Ready) | 약 1.0 ms | 약 15 ms |
| 재연결 핸드셰이크 | 약 0.9 ms | 약 13 ms |
| 키 입력 왕복(기기→박스→기기) | 약 0.14 ms | 약 0.3~0.6 ms |
핸드셰이크 비용은 서명 2 + ECDH 2 + 검증 2로 고정이고 지연은 사실상 네트워크 RTT 3회(Hello, Challenge, Auth)가 지배한다. 인터넷 구간에서 첫 연결은 RTT×(TCP/TLS/WS 핸드셰이크 + 3) 정도로 [추정]. 재연결은 새 핸드셰이크이고 카운터 연속성은 없다.

## 위협 — 막음 / 못 막음
| 위협 (ADR-0197) | 이 프로토타입 | 비고 |
|---|---|---|
| T1 서버가 평문을 읽음 | 막음 [V] | 임시 ECDH, 서버는 임시 비밀키를 갖지 않음 |
| T1 서버가 입력 주입·변조·재생·재정렬 | 막음 [V] | AEAD + 방향 키 + 엄격 카운터 |
| T1 서버가 「기기」 행세 | 막음 [V] | box-agent가 소유자 기기 서명을 직접 검증, 목록은 소유자 서명으로만 변경 |
| T1 서버가 「박스」 행세(host 키 바꿔치기) | 막음 [V] | 런너 증명 + 소유자 보증 + 지문 대조 |
| 서버가 박스 생성 때 기기를 끼워 넣음 | **감사가 있으면 막음** [V] | 조건 ②. 감사를 인증 채널로 받아야 함 |
| T7 소유자 기기 탈취 | 못 막음 | 생체 ACL·폐기 목록에 의존(코드 밖) |
| T11 자원 고갈 | 일부 [V] | 인증 전 대기 챌린지 상한만. 프레임 속도·크기 상한(크기만 구현), 세션 길이, 동시 붙기는 M4 |
| 서버의 서비스 거부(연결 끊기, 8개 챌린지 점유, 꼬리 절단) | **못 막음** | 탐지만 한다(인증된 Close 부재, 카운터 틈). ADR이 이미 잔여로 적음 |
| 트래픽 분석(프레임 크기·시각으로 키 입력 추정) | **못 막음** | 패딩 없음. 서버는 키 입력 타이밍을 본다 |
| 런너 운영자·런너 root(T2) | 범위 밖 | 운영자는 신뢰 대상. 지문 대조 건너뛰기는 TOFU로 내려감 |
| 라이브 세션의 인가 철회 | **미구현** | 목록에서 빠진 기기의 이미 열린 세션을 box-agent가 끊어야 함(M4) |
| 시계 | 단조 시계 주입(`Clock`)만 시험 | 실제 박스의 단조 시계·재시작 시 의미는 M4 |
| 박스 안 PTY 자체 | 범위 밖 | 가짜 에코 대신 실제 PTY 프로세스는 M4 |

## M4 착수 조건 (GO의 전제)
1. **새 소유자 기기 등록의 신뢰 뿌리.** 새 기기가 처음 받는 `DeviceList`는 서버를 거치면 안 된다. 기존 기기가 QR/단문 코드로 직접 넘기는 대면 페어링이 필요하다. 이 프로토타입은 `DeviceListState::bootstrap`이 자기 서명 목록을 그냥 받는다(TOFU). **이게 가장 큰 열린 구멍이다.**
2. **소유자 감사.** 붙은 직후 box-agent가 자기 `DeviceList`를 **암호화 채널의 첫 컨트롤 프레임**으로 보내고, 기기가 `audit_box_list`로 「서명자와 모든 구성원이 내가 아는 기기」임을 확인한 뒤에야 입력을 보낸다. 서버가 중계한 사본으로 감사하면 무의미하다.
3. **박스 생성 컨트롤은 소유자 기기 서명**(R2)이고 런너가 지문으로 고정한 서명자만 받아 첫 목록을 만든다. 이 프로토타입은 첫 목록이 런너 로컬에서 온다고 가정한다.
4. **붙기 단위의 서버측 인가는 중복 방어층**으로 둔다(소유자·박스 켜짐·host 폐기). 서버 판단이 틀려도 box-agent가 막는다는 것이 이 설계의 핵심이므로 시험은 서버 검증을 끈 상태로 돌린다.
5. **라이브 세션 철회**(목록 갱신 시 열린 세션 중 빠진 기기 즉시 종료), 최대 세션 길이·유휴·프레임 속도 상한은 M4 시험으로 잠근다.
6. **서버 라우트 시험 확장.** 이 PR의 로그 grep은 `tracing` 로그와 기록 바이트만 본다. M4에서 코어 덤프 비활성·패닉 덤프·메트릭 라벨 시험을 같은 표식 방식으로 추가한다.

## 이탈과 한계 기록
- 이슈 #3409가 `status:ready`가 아니어서 `goal_claim.sh --force`로 시작했다(ADR PR #3406이 머지 대기 중이었다. 시작 시 ADR 파일을 PR 워크트리에서 읽었고 머지 후 rebase했다).
- 보안 검수 결과는 PR 본문에 있다.
