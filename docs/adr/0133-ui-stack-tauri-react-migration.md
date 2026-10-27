# ADR-0133: 클라이언트 UI 스택 전환 — SwiftUI → TS/React + Tauri (+Rust 코어)

- Status: **Accepted** (2026-07-25, 성재 — "ADR 승인할게. 스파이크랑 리서치 바로 진행해줘." 파생 P0 스파이크·R-1·R-2 즉시 착수. 2026-07-24 기안, Fable — 성재 발제)
- **전환 실행: 2026-07-25** — parity 게이트 실측(차단 0·성능 3종 통과, `docs/planning/2026-07-25-parity-gate-report.md`) 후 성재 승인으로 기본 다운로드를 momo-next 0.1.0-next.7(Tauri)로 교체(`scripts/switch_default_download.sh`). SwiftUI 0.0.6 = legacy 최종 빌드(신규 발행 중단, 은퇴).
- 증보: 2026-10-27 데스크탑 다운로드 폴더(#4587) — 앱 명령 다섯과 그 울타리(§2 Rust 활용 경계 — 네이티브 통합은 셸이 한다 — 의 한 갈래). 파일 끝 「증보 2026-10-27 — 다운로드 폴더」 절
- 발단(성재): ①Swift 백그라운드 부재로 SwiftUI의 장점을 오너가 살리지 못함(UI를 오너가 직접 다듬을 수 없음) ②Windows 지원 필요 ③buzz(Tauri)를 레퍼런스로 직접 활용 가능 ④최종 타깃 = **Windows·macOS·iOS·Android·Web**, 최소 릴리스 = **iOS·macOS·Web**.

## Context (실측)

- 현행 UI 자산: macOS SwiftUI 112파일(+테스트·스냅샷 인프라·momo-design-taste 체계), iOS 킷 35파일(부분). 웹 클라이언트는 ADR-0119 v0(`clients/web`, 레포 브라우저·알파 서빙용 경량 Vite 앱)가 존재하나 메신저 UI는 아니다(정정 2026-07-25 — 기안 시 '0'으로 오기). v0의 seq/reconcile·approval 모델 어휘는 momo-web의 씨앗으로 재사용한다.
- 서버 계약은 UI 무관: REST + Centrifugo(WS) + momo:// 딥링크 + mDNS. **엔진(서버/relay/worker/momo-workd/ACP)은 이 결정의 영향권 밖.**
- Tauri 2: 2024-10 stable, 현행 2.9.x. 데스크톱(mac WKWebView·win WebView2) 성숙, **모바일(iOS/Android)은 1급 타깃이나 상대적으로 신생**(iOS=Swift 셸+WKWebView+Rust FFI). 내장 updater·deep-link 플러그인·서명/공증 번들러 보유.
- buzz 실측: 데스크톱=Tauri, **모바일=Flutter(부분)** — buzz도 모바일엔 Tauri를 쓰지 않았다. Tauri의 Linux(WebKitGTK) day-1 크래시 전과는 우리 초기 타깃(mac/win)엔 비해당.

## Options

- **A. 전면 전환(빅뱅)**: SwiftUI 폐기, Tauri+React로 재작성 후 교체. — 내부 알파 공백 발생, 리스크 최대.
- **B. 웹-우선 스트랭글러(권고)**: React 웹 클라(momo-web)를 정본 UI로 신설 → Tauri가 데스크톱(mac→win) 래핑 → parity 게이트 통과 시 기본 배포 전환. SwiftUI mac은 그때까지 데일리 드라이버 유지(신규 표면 동결). iOS는 스파이크로 Tauri-mobile vs 대안 판정.
- **C. 현상 유지 + 웹만 신설**: SwiftUI mac 계속 + React 웹 별도. — 두 UI 스택 영구 이중 유지보수, Windows 불가. 오너 참여 문제 미해결.

## Decision (Proposed): **B**

1. **정본 UI = `clients/web`(TS + React + Vite)**. 데스크톱은 Tauri 2가 동일 코드를 래핑(mac→win). Next.js는 배제(SSR 불필요, Tauri 정합은 SPA/Vite가 표준).
2. **Rust 활용 경계**: Tauri 셸의 네이티브 통합(딥링크·mDNS 발견·keychain·알림·updater)은 Rust 플러그인. 성능 임계(타임라인 캐시·seq resume·WS 재연결)는 v1엔 TS로 시작, 병목 실측 시 `momo-core-rs`로 강등(웹은 브라우저 WS 유지). 조기 Rust 골드플레이팅 금지.
3. **UI 킷**: Tailwind + shadcn/ui(Radix) + react-virtuoso(타임라인 가상화) + cmdk(Cmd+K). buzz·codex·t3code 패턴 소화는 전용 UX 스펙으로(파생 R-1).
4. **iOS 결정은 스파이크 게이트**: Tauri-mobile 스파이크(P4a)로 판정 — 합격 시 동일 코드베이스, 불합격 시 대안(현행 SwiftUI iOS 킷 확장 등)을 별도 ADR 증보로. buzz의 Flutter 선택이 경고 신호임을 명시.
5. **전환 규율**: ADR Accepted 시점부터 macOS SwiftUI는 **버그픽스 전용 동결**(신규 UXUI 표면은 web에만). parity 게이트(부록 체크리스트) 통과 전까지 기본 다운로드는 SwiftUI 빌드 유지, Tauri 빌드는 `momo-next` 병행 채널로 배포.
6. 하드 불변식(PG=SoT·seq·단일 쓰기경로·RLS·ADR-0004)과 서버 계약 무변경. momo-design-taste는 웹판 스킬로 이식(파생 R-2).

## Consequences

- (+) 1 코드베이스로 web/mac/win(+모바일 후보) — 최소 릴리스의 Web을 만들면서 데스크톱을 공짜에 가깝게 확보. 오너가 UI를 직접 다듬을 수 있는 스택. buzz를 화면 단위로 직접 참조 가능. Tauri updater로 Sparkle(#736) 불필요.
- (−) SwiftUI 자산(112파일·테스트·스냅샷 체계) 상당분 대체 — 단 도메인 로직/계약/검증기는 잔존 가치. 이중 스택 기간의 드리프트 리스크(동결 규율로 상쇄). Tauri iOS 신생 리스크(스파이크 게이트로 상쇄).
- 예약: Android(P5), Linux 데스크톱(WebKitGTK 리스크로 후순위), momo-core-rs 공유 범위.

## 부록 — 데스크톱 parity 게이트 (기본 배포 전환 조건)

로그인/초대 딥링크/서버 발견 · 채널/DM 타임라인(seq 순서·재연결 resume) · 컴포저+@멘션 · 에이전트 카드(승인/비용/상태) · 멤버 디렉터리 · 설정(AI 연결·코드 실행 호스트·워크스페이스 생성·초대 메일) · 업데이트 알림 · 알림(mac) · 성능(1k 메시지 60fps 스크롤·콜드 스타트<2s·유휴 메모리<400MB) · design-review Blocker0·High0.

## 증보 2026-10-27 — 다운로드 폴더: 쓰기 · Finder 보기 · 열기 (#4587)

- Status: **Accepted** (2026-10-27 owner 승인. 원문 「다운로드 패널쪽 adr도 승인」, planner 전달. 기안: #4587 2단계, Sonnet 5.5 워커)
- 근거: 이슈 #4587(상위 #4584 파일 v2 F2). owner 2026-10-26 원문: 「다운로드 관련한 버튼을 제일 상단 우측에 두면 뭔가 일반적인 좋은 메신저 앱에서의 UX가 완성될 거 같은 느낌이야.」 그 자리의 버튼과 패널이 보여 주려면 데스크탑 셸이 받은 파일의 이름·위치·있음 여부를 알고 Finder에서 보여 주고 열 수 있어야 한다.
- 결재 기록: **owner 승인 2026-10-27(데스크탑 다운로드 폴더 쓰기·Finder 보기·열기 범위 — 다운로드 폴더 한정·덮어쓰기 금지·실행 파일 열기 거절·격리 표시).** 이 증보는 AGENTS.md 「공개 API·보안 경계·DB 계약·제품 방향·스택 변경은 Accepted ADR 참조가 머지 조건」(ADR-0100)에 따라 #4587 PR이 인용한다.

### 왜 필요한가

- 웹 번들의 예전 내려받기는 Blob + `<a download>`였다. **이 셸에서도 그 길은 파일을 쓴다**: wry 0.55.1의 `WebViewAttributes` 기본값이 모든 다운로드를 받아들이는 `download_started_handler`라서(`lib.rs`), 이 앱이 핸들러를 따로 달지 않아도 WKWebView가 제안 이름으로 OS 다운로드 폴더에 저장한다(실기: 같은 이름이면 ` (1)`, 저장본에 WebKit 격리 `0083`). 이 PR의 첫 커밋 주석은 wry 소스를 읽고 「취소된다」고 적었으나 실기가 틀렸음을 보였고(WebKit 로그 `policyAction=Download`) 같은 PR에서 고쳤다.
- 그 길의 한계는 **쓰기가 아니라 대답**이다. 앱은 그 다운로드의 진행도, 끝난 파일의 이름도, 어디에 놓였는지도, 아직 있는지도 알 길이 없다. 「Finder에서 보기」「열기」「다시 받기」「지워진 파일 표시」를 하려면 앱이 이름을 알고 그 이름의 파일을 만질 수 있어야 한다.
- 그래서 셸이 웹 번들이 이미 인가 프록시(ADR-0151 D2)로 받은 바이트를 **다운로드 폴더에만** 쓰고, 그 이름으로 보기·열기·있음 확인을 한다. 이 길은 §2(Rust 활용 경계: 네이티브 통합은 셸)의 연장이고, `opener.rs`·`pdf_viewer.rs`가 선 것과 같은 모양(좁은 앱 명령)이다.

### 결정

**D1. 앱 명령 다섯, 이름만 받는다.** `tauri-plugin-fs`·`tauri-plugin-opener`의 「아무 경로, 아무 핸들러」 표면은 쓰지 않는다.

| 명령 | 받는 것 | 하는 일 |
|---|---|---|
| `download_save` | 바이트(raw 본문) + 이름 헤더 | 다운로드 폴더에 새 파일로 쓰고 **셸이 정한 이름**을 돌려준다 |
| `download_probe` | 이름 목록(200개 이하) | 그 이름의 일반 파일이 폴더에 아직 있는지 같은 순서의 `bool` |
| `download_reveal` | 이름 하나 | Finder에서 그 파일을 선택해 보여 준다(macOS `open -R`; Windows·Linux는 폴더를 연다) |
| `download_open` | 이름 하나 | 기본 앱으로 연다(D4가 거절하는 종류는 제외) |
| `download_folder_open` | 없음 | 다운로드 폴더 자체를 연다 |

요청 구조체는 `deny_unknown_fields`라서 `path` 같은 필드를 붙여도 거절된다.

**D2. 폴더 울타리.** 웹뷰는 경로를 한 번도 말하지 않는다. 구분자·`..`·NUL·제어 문자·방향 문자·예약 문자(`: * ? " < > |`)·앞의 점·끝의 점/공백이 든 이름은 디스크에 닿기 전에 거절한다(`is_plain_name`). 통과한 이름은 폴더와 파일을 `canonicalize`한 뒤 **폴더의 직계 자식**이어야 하고(`lexical starts_with`는 `pdf_viewer.rs` 검수가 약하다고 잡은 검사라 쓰지 않는다), 파일은 `symlink_metadata`로 **일반 파일**이어야 한다. 폴더 안의 심볼릭 링크는 가리키는 곳과 상관없이 거절한다. 디렉터리도 거절한다.

**D3. 덮어쓰지 않는다. 이름은 셸이 정한다.** 쓰기는 `create_new`(O_CREAT|O_EXCL)라서 있는 파일과 그 이름에 놓인 심볼릭 링크를 통해 쓰지 않는다. 겹치면 ` (1)`, ` (2)`…(1000까지). 보낸 사람이 정한 이름은 적대 입력이라 셸이 다시 만든다: 확장자는 지키고, 구분자·제어·방향 문자는 버리거나 `-`로 바꾸고, 앞의 점을 걷고, Windows 장치 이름은 `_`를 붙이고, 200바이트로 줄인다(줄임은 이름 줄기에서, 확장자는 남긴다). 쓰다 실패하면 반쯤 쓴 파일을 지운다. 크기 상한은 100 MiB(첨부 계약 `MAX_ATTACHMENT_BYTES`)이고 본문을 복사하기 전에 거절한다.

**D4. 열기는 실행이 아니다.** 채팅 첨부의 보낸 사람은 믿을 수 있는 사람이 아닐 수 있다. 기본 핸들러가 받은 것을 실행하거나 설치하거나 해석하는 확장자는 `download_open`이 거절한다(`NOT_OPENED_EXTENSIONS`, 닫힌 목록, 마지막 확장자로 대소문자 무시, `a.pdf.command`는 `command`): macOS 번들·설치·프로필·핸들러(`app` `command` `tool` `terminal` `workflow` `scpt` `pkg` `dmg` `mobileconfig` `webloc` `url` `ipa` …), 셸·인터프리터(`sh` `bash` `zsh` `py` `rb` `js` `jar` …), Windows 실행·스크립트(`exe` `msi` `bat` `cmd` `ps1` `reg` `lnk` …), Linux(`desktop` `appimage` `run` `deb` `rpm`), 자기 스크립트를 `file:` 출처로 돌리는 페이지(`html` `htm` `svg` `webarchive` …). 거절된 종류도 **Finder에서 보기는 된다**: 사람이 거기서 판단한다. 모르는 확장자는 연다(목록은 닫힌 것이라 모르는 것까지 막으면 열 수 있는 파일이 없다).

**D5. 격리 표시.** macOS는 저장한 파일에 `com.apple.quarantine`을 브라우저와 같은 모양으로 붙인다(`0081;<초(16진)>;oort;`, 실패해도 저장은 유지하는 최선 시도). 그래서 사람이 Finder에서 더블클릭한 실행 파일은 Gatekeeper가 계속 판정한다. Windows(Zone.Identifier)와 Linux는 이 증보가 다루지 않는다(`quarantine`이 거짓을 돌려준다).

**D6. 권한(capabilities).** `capabilities/downloads.json`이 다섯 명령을 `main` 웹뷰의 로컬(번들) 출처에만 준다. `remote`가 없고 `fs:*`·`opener:*` 권한이 없다. 자식 웹뷰는 상속하지 않는다(`pty.json`과 같은 웹뷰 한정). `build.rs`의 `APP_COMMANDS`와 `lib.rs` 핸들러 표에 다섯이 정확히 있다.

**D7. 한 번에 한 덩어리 전송.** 100 MiB까지의 본문을 IPC 메시지 하나로 보낸다(웹뷰 Blob → 셸). #4585가 첨부 상한을 올리면 청크 전송으로 바꾸고 이 절의 상한을 올린다(후속). 상한이 어긋나면 웹의 `downloadsContract.test.ts`가 붉어진다.

### 무엇을 열지 않나

- 다운로드 폴더 밖의 어떤 경로도: 읽기·쓰기·보기·열기 모두. 폴더 자체를 여는 명령은 인자가 없다.
- 심볼릭 링크, 디렉터리, 숨김 파일, 구조가 있는 이름, 이미 있는 파일의 덮어쓰기.
- 실행·설치·해석하는 종류의 **열기**(D4). 그 종류의 저장과 Finder 보기는 막지 않는다.
- URL, 토큰, Drive 주소를 셸에 주는 길: 바이트는 웹뷰가 인가 프록시에서 받아 넘기고 자격은 웹뷰를 떠나지 않는다.
- 사용자 지정 저장 위치(폴더 선택은 `dialog` 권한과 허용 범위를 넓힌다): 이번에는 OS 다운로드 폴더 고정이고 바꾸기는 후속이다.
- 다운로드 진행 중 취소, 목록 개별 삭제, Windows 격리(MOTW), Linux 실기.

### 지금과 달라지는 것 · 달라지지 않는 것

- 달라지지 않는 것: 파일이 놓이는 곳(OS 다운로드 폴더), 격리 표시가 붙는다는 것, 페이지가 이름을 정해 파일을 만들 수 있다는 것(예전 `<a download>`도 같았고 WebKit이 `../../x`를 `_.._x`로 접는다). 앱이 다운로드 폴더를 쓴다는 사실 자체는 예전에도 같았다.
- 달라지는 것: ① 페이지의 호출로 셸이 쓴다(이름은 셸이 다시 만들고 덮어쓰지 않으며 확장자 제한 없이 저장하되 열기는 거절한다) ② 보기·열기·있음 확인·폴더 열기가 새로 생겼다(전부 D2 울타리 안) ③ 저장 이름을 셸이 돌려줘 패널이 그 이름으로 다시 부른다.

### 시험으로 잠근다

- 셸(`clients/desktop/src-tauri/src/downloads.rs`): `the_plain_name_gate_refuses_structure` · `only_a_direct_child_of_the_folder_counts` · `a_symlink_inside_the_folder_is_refused_wherever_it_points` · `a_symlink_at_the_target_name_is_not_written_through` · `a_second_save_never_overwrites_the_first` · `hostile_names_land_inside_the_folder` · `every_name_it_saves_passes_the_gate_the_other_commands_demand` · `what_runs_or_installs_is_never_opened_from_here` · `nothing_is_launched_for_a_refused_name` · `the_launchers_end_options_before_the_path` · `a_saved_file_carries_the_quarantine_attribute` · `the_ceiling_is_exactly_one_hundred_mib` · `a_failed_write_leaves_no_partial_file` · `requests_refuse_a_field_they_do_not_know`.
- 권한(`shell_contract.rs`): `tauri_grants_the_download_commands_to_the_local_main_webview_only` · `a_capability_that_grants_the_file_or_opener_plugin_is_noticed` · `every_registered_command_is_declared_and_granted` · `only_the_local_terminal_capability_grants_pty_and_none_is_remote`.
- 웹(`clients/web/src/features/downloads/downloadsContract.test.ts`): 열기 거절 확장자는 모델과 셸이 같은 집합이다 · 셸의 크기 상한은 첨부 계약과 같다 · 다리가 부르는 명령은 셸의 명령 표에 있다 · 셸의 명령은 파일을 이름으로만 받는다.
- 각 단정은 일부러 깨 보아 붉어지는지 확인했다(사보타주 표: #4587 PR 본문).

### 실기 확인 (2026-10-27, macOS 27.0, 서명 없는 debug 빌드, 샌드박스 HOME)

- 음성 프로브 16건(거절 14 · 없는 파일 `missing` 1 · probe가 폴더 밖 이름을 전부 `false`로 읽음 1)은 `../.zshrc` · `/etc/hosts` · `.command`/`.terminal`/`.pkg`/`.HTML`/`a.pdf.command`/`evil.app.` 열기 · 알 수 없는 필드 `path` · 빈 이름 · NUL · 숨김 파일 · 201개 probe를 포함하고, 거절은 모두 코드 문자열로 돌아왔으며 아무 앱도 뜨지 않았다(Terminal 미실행·새 파일 없음 확인). 적대적 이름 저장 10건(`../../evil.txt` → `-..-evil.txt`, `CON.txt` → `_CON.txt`, `.bashrc` → `bashrc`, 방향 문자 제거, 214바이트 한글 → 199바이트, 같은 이름 → ` (1)`)은 전부 폴더 안에 떨어졌다.
- 저장본: `com.apple.quarantine`은 `0081;…;oort;`, 실행 비트 없음, `.command`에 `spctl --assess --type open` = rejected. 서버 바이트와 sha256 일치(594 B · 24 MiB · 64 MiB). Finder 보기는 Finder 새 창이 폴더를 가리키고 그 파일이 선택됐다. 열기는 TextEdit·Preview에서 열렸고 `.command`는 행에 열기가 없다.
- 쓰기 권한이 없는 폴더(`chmod 555`)는 `denied`로 접혀 「다운로드 폴더에 저장할 권한이 없어요…」가 선다.

### 미검증 · 남는 위험

- **TCC 「다운로드 폴더」 첫 프롬프트는 관찰하지 못했다**(`runtime-unverified`). 서명 없는 `.app` 번들을 LaunchServices로 띄워 진짜 `~/Downloads`에 썼는데 프롬프트 없이 성공했고 `tccutil reset` 뒤에도 같았다. 책임 프로세스 귀속(이 맥은 개발 호스트라 이미 허용이 있을 수 있다)을 가르지 못했다. `Info.plist`의 `NSDownloadsFolderUsageDescription` 문구가 실제로 보이는지, 「허용 안 함」 뒤 `denied` 경로가 실제 TCC 거부에서 서는지(샌드박스 `chmod`로 같은 `PermissionDenied`만 확인)는 서명된 빌드로 새 맥에서 확인한다.
- Finder 더블클릭이 띄우는 Gatekeeper 대화상자 자체는 실행해 보지 않았다(`spctl` 평가와 속성까지만).
- Windows·Linux: 코드 경로는 있으나(`rundll32 url.dll,FileProtocolHandler`, `xdg-open`, `cfg`로 갈린다) 이 맥에서는 컴파일도 실행도 하지 않았고 격리가 없다.
- **일시적 메모리**: 64 MiB 한 건에 4개 프로세스 합계가 약 +569 MiB(파일의 약 9배; 셸 +256 · WebContent +200 · Networking +112)이고 끝난 뒤에도 곧바로 내려오지 않았다. 예전 `<a download>` 길은 같은 조건에서 +242 MiB(약 3.8배)다. 100 MiB 상한이면 약 +0.9 GiB가 한 번에 선다. D7의 청크 전송 후속이 이 비용을 줄인다.
- 보낸 사람이 정한 이름은 셸이 다시 만들지만, 사람이 Finder에서 직접 여는 파일은 이 증보의 밖이다(격리 표시가 그 몫이다).
