# herdr 소스 분석과 momo T3/workd 관계 판정

- 작성: 2026-08-02 (Fable)
- 대상: `herdrdev/herdr` `885c9a6b` (2026-08-01), 버전 0.7.5, Apache-2.0
- 방법: 얕은 클론 후 **정적 읽기만**. 빌드·실행·설치 없음. `install.sh`/`brew`/`cargo` 미실행.
- 대조 대상: `/Users/kwakseongjae/projects/momo-tracks/engine` (track/engine 워크트리) 읽기 전용
- 선행 문서: `docs/planning/research/2026-07-28-tauri-rn-agent-platform-gap-audit.md` §5.2 — herdr sidecar를 "조건부 spike 후보(Windows 경계)"로 유보한 판정. **이 문서는 그 유보를 소스 근거로 종결한다.**

---

## 1. 요지

herdr는 **1인 사용자의 로컬 터미널 멀티플렉서**다. 다중 사용자·다중 테넌트 서버 런타임이 아니며, 그렇게 되려는 코드도 아직 없다. 소켓 API 91개 메서드 전체에 **인증이 하나도 없고**(`Hello` 핸드셰이크에 자격증명 필드 자체가 없다), 접근 통제는 유닉스 소켓 파일 모드 `0600` 하나뿐이며 그 제한은 **Windows에서 명시적 no-op**이다. 사용자·테넌트·계정 개념이 코드에 존재하지 않고, DB가 없으며(sqlite/postgres 의존 0), 시간·자원 계량이 전혀 없다. 에이전트 상태(`working/blocked/done`)는 **터미널 화면 꼬리를 정규식으로 긁는 휴리스틱**이고 `done`은 "idle이며 UI가 아직 안 본 상태"라는 주의 환기 표식이지 완료 계약이 아니다. 반면 momo workd는 workspace 스코프 + 요청별 Ed25519 서명 + PG 원장 + `t3_terminate` 단일 정산문을 전제로 만들어졌다. **결론: herdr는 workd를 대체할 수 없고, 대체 시도는 T3 정산·RLS·서명 불변식을 전부 되돌리는 일이다.** 다만 코드 품질은 높고(테스트 함수 3,203개, TODO/FIXME 0), **설계 참조로 가져올 가치가 있는 조각이 3개** 있다.

---

## 2. herdr가 실제로 하는 일 (코드 근거)

### 2.1 규모와 성숙도

| 항목 | 값 | 근거 |
|---|---|---|
| 커밋 | 1,286 (2026-03-23 최초 ~ 2026-08-01 HEAD) | `git rev-list --count HEAD` |
| 저자 편중 | 1,040/1,286을 Ogulcan Celik 단독 | `git shortlog -sn` |
| 소스 | `src/` 231개 `.rs`, 205,216줄 | — |
| 테스트 함수 | 3,203 (`#[test]`/`#[tokio::test]`), 통합 테스트 12파일 | `tests/detach_reattach.rs`, `tests/live_handoff.rs`, `tests/multi_client.rs` 등 |
| `TODO`/`FIXME`/`todo!()`/`unimplemented!()` | **0** | `grep -rE` |
| CI | 9개 워크플로 (`ci.yml`, `pr-gate.yml`, `release.yml`, `nix.yml` …) | `.github/workflows/` |
| 릴리스 | v0.7.5까지 태그, 문서 버전 스냅샷 19개 보존 | `docs/versions/` |

데모웨어가 아니다. 실물이고 관리가 촘촘하다. 다만 **크레이트 경계가 없다**: `src/lib.rs`가 없고 `Cargo.toml`에 `[lib]`/`[[bin]]`/`[workspace]` 섹션이 없다. 모든 모듈이 `src/main.rs:57-103`의 사적 `mod` 선언이다. 즉 **의존성으로 끌어다 쓸 수 없다.** 빌드에는 Zig 툴체인이 필요하다(`build.rs:60-80`이 vendored `libghostty-vt`를 `zig build`로 컴파일).

메인테이너 본인이 현재 상태를 이렇게 적어 뒀다 (`AGENTS.md:40`):

> Herdr is migrating toward a server-owned runtime protocol with the TUI as one client. New work should not deepen the current server/TUI coupling.

즉 **런타임이 되려는 중이지 아직 런타임이 아니다**. README 스폰서 섹션의 "the path to a real agent runtime"도 같은 뜻이다.

### 2.2 정체 판정 — 로컬 단일 사용자 도구

세 가지가 동시에 참이라 다른 해석이 불가능하다.

**(a) 인증이 없다.** `src` 전체에서 `auth|bearer|credential|password|api_key` 계열 히트가 29건인데, 실제 내용은 전부 무관하다: `parse_api_key`(`src/app/api_helpers.rs:11`)는 **키보드 키 문자열 파서**고, `"reviewing auth"`는 테스트 픽스처 문자열이며, `geteuid`(`src/server/clipboard_image.rs:76`)는 임시 디렉터리 이름용이다. 클라이언트 핸드셰이크 `ClientMessage::Hello`(`src/protocol/wire.rs:342-361`)는 version/cols/rows/encoding/keybindings/launch_mode만 싣고 **자격증명 필드가 없다**. JSON API 커넥션도 첫 줄을 읽어 바로 디스패치한다(`src/api/server.rs:143-283`) — 핸드셰이크 자체가 없다.

**(b) 네트워크 노출을 전제하지 않는다.** `TcpListener`/`SocketAddr`/`axum`/`hyper`/websocket 서버가 코드에 없다. 전송은 `interprocess::local_socket` 하나뿐이다(`src/ipc.rs:28-73`) — 유닉스는 UDS, Windows는 namespaced named pipe. `--remote`는 서버를 여는 게 아니라 **로컬 herdr가 ssh stdio를 타고 원격 herdr에 붙는 씬 클라이언트**다(`src/remote/unix.rs:1` 문서 주석, `:491` `Command::new("ssh")`). 원격에 herdr 바이너리가 없으면 설치까지 한다(`src/remote/unix.rs:673-740`).

**(c) 사용자/테넌트 개념이 없다.** `tenant|user_id|account_id|organization|quota|billing` 검색 결과 유의미한 히트 0. 세션 격리는 **디렉터리 이름**이다: `config_dir()/sessions/<name>`(`src/session.rs:157-166`). 같은 UID 안의 이름표일 뿐 신뢰 경계가 아니다.

접근 통제의 전부는 소켓 파일 모드 `0600`이다(`src/api/server.rs:28,83`, `src/server/socket_paths.rs:13,74-76`). 그리고 **Windows에서 이 함수는 빈 `Ok(())`다**:

```rust
// src/ipc.rs:283-286
#[cfg(windows)]
pub(crate) fn restrict_socket_permissions(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}
```

리스너도 보안 서술자를 지정하지 않는다(`src/ipc.rs:60-72`). **2026-07-28 감사가 herdr 비교를 유보해 둔 지점이 정확히 "Windows work host 착수 직전"이었는데, herdr의 접근 통제가 무력해지는 플랫폼이 바로 Windows다.**

### 2.3 소켓 API — 실제 프로토콜

- **전송**: 유닉스 도메인 소켓(Windows는 named pipe), 커넥션당 스레드(`src/api/server.rs:86-115`).
- **포맷**: JSON 한 줄 요청 → JSON 한 줄 응답. **커넥션당 요청 1개.** `{"id": "...", "method": "pane.split", "params": {...}}` 형태의 태그드 유니온(`src/api/schema.rs:33-44`).
- **메서드**: 91개. workspace/tab/pane/layout/agent/worktree/plugin/integration/events 계열(`src/api/schema.rs:45-235`). 전체 JSON Schema를 바이너리에 동봉하고 `herdr api schema --json`으로 뽑을 수 있다(`docs/next/api/herdr-api.schema.json`, 251 KB).
- **스트리밍**: `events.subscribe`, `agent.wait`, `agent.prompt --wait`, `pane.wait_for_output`, `pane.graphics.stream`은 커넥션을 유지한다(`src/api/server.rs:180-256`).
- **한계값**: 초기 요청 1 MiB(`src/api/server.rs:33`), 앱 응답 타임아웃 5초(`:30`), 폴링 간격 100 ms(`:29`).
- **호출자 식별**: 없다. herdr가 팬에 주입하는 환경변수 `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`(`src/integration/mod.rs:14-16`)를 읽을 수 있으면 **91개 메서드 전부**를 호출할 수 있다. `server.stop`(서버와 모든 팬 프로세스 종료), `pane.close`, `pane.read`(다른 팬 출력 읽기) 포함. 팬 A의 에이전트가 팬 B의 화면을 읽는 것을 막는 코드가 없다. 유일한 통제는 산문 예절이다(`skills/herdr/SKILL.md:161-166`: "Do not close workspaces, tabs, panes, or sessions you did not create").

실제 훅이 소켓에 쓰는 방식(`src/integration/assets/claude/herdr-agent-state.sh:21-23, 88-96`) — 인증 없이 python3로 UDS에 JSON 한 줄:

```sh
[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
```

**이벤트 전달은 손실 설계다.** `EventHub`는 인메모리 `Vec`에 최대 512개를 담고 초과분을 조용히 버린다(`src/api/event_hub.rs:12,20-25`). 시퀀스 번호는 서버 내부에만 있고 **`EventEnvelope`에는 시퀀스 필드가 없다**(`src/api/schema/events.rs`) — 구독자는 유실을 탐지할 수단이 없다. 프로세스가 죽으면 전부 사라진다. 우리의 채널별 gapless `message.seq` 불변식을 이 위에 올릴 수 없다.

프로토콜 버전은 19이고(`src/protocol/wire.rs:16`) 클라이언트/서버 버전 강제 일치다(`src/cli.rs:759-768`). 0.x 단계이므로 외부 소비자를 위한 안정 계약이 아니다.

### 2.4 세션 지속과 detach/reattach

세 갈래이고, 공식 문서 표(`website/src/content/docs/session-state.mdx:10-16`)가 코드와 정확히 일치한다.

| 경우 | 프로세스 생존 | 실제 메커니즘 |
|---|---|---|
| detach → reattach | **예** | 서버가 `setsid`로 데몬화돼 PTY 마스터 fd를 계속 소유(`src/platform/mod.rs:68-80`, `src/server/autodetect.rs:202-218`) |
| 서버 재시작 | **아니오** | PTY 사망. `session.json` 복원으로 워크스페이스/탭/팬/cwd/레이아웃만 되살리고 **셸을 새로 spawn**(`src/persist/restore.rs:590-621`) |
| 업데이트 `--handoff` | 최선 노력 | `SCM_RIGHTS`로 PTY 마스터 fd를 새 바이너리에 넘김(`src/server/handoff.rs:395-440`) |

세션 상태 저장소는 **JSON 파일 2개**다: `session.json`, `session-history.json`(`src/persist/io.rs:11-17`). 원자적 쓰기는 tmp+rename(`:48-60`). DB는 없다(`sqlite|postgres|rusqlite|sled|redb` 검색 결과 0).

서버 재시작 후 대화 복구는 **에이전트 CLI 자체의 resume**에 위임한다(`src/agent_resume.rs:121-205`) — `claude --resume <id>`, `codex resume <id>`, `copilot --resume=<id>` 등 15종 이상의 argv 표. 기본 on(`src/config/model.rs:249-257`).

화면 이력 리플레이는 **기본 off**이고 그 이유를 문서가 명시한다: 팬 출력에 시크릿·토큰이 섞이기 때문(`website/src/content/docs/session-state.mdx:44-52`).

> **README와 코드의 차이.** README는 "sessions survive restarts"라고 한 줄로 쓴다. 코드와 공식 문서는 "서버 재시작 시 프로세스는 생존하지 않고, 레이아웃 복원 + 선택적 화면 리플레이 + 에이전트 native resume"이다. 거짓은 아니지만 README 쪽이 더 강하게 읽힌다.

### 2.5 에이전트 상태 — 계약이 아니라 휴리스틱

모듈 첫 줄이 스스로 말한다(`src/detect/mod.rs:1-4`):

> Agent state detection via terminal tail pattern matching. Each pane's live bottom-of-buffer text is read periodically and matched against known agent output patterns to determine state.

- 내부 상태는 `Idle | Working | Blocked | Unknown` 4종(`src/detect/mod.rs:11-20`).
- 판정은 에이전트별 TOML 매니페스트의 규칙 매칭이다. 19종 번들(`src/detect/manifests/*.toml`). 규칙은 `priority` + `region` + `contains`/`regex`/`line_regex`/`any`/`not`. 리전은 `whole_recent`, `prompt_box_body`, `after_last_horizontal_rule`, `bottom_non_empty_lines(N)`, `osc_title`, `osc_progress`(`src/detect/manifest.rs:1075-1086`).
- 실제 규칙 예시(`src/detect/manifests/claude.toml:37-48`) — "blocked"의 정의가 문자열 매칭이다:

```toml
[[rules]]
id = "live_blocked_form"
state = "blocked"
priority = 980
region = "after_last_horizontal_rule"
contains = ["enter to select", "esc to cancel"]
```

- **`done`은 완료 신호가 아니다.** `(AgentState::Idle, seen == false) => AgentStatus::Done`(`src/app/api_helpers.rs:104`, `src/app/agent_view.rs:393`). 즉 "idle인데 사용자가 그 탭을 아직 안 봤다"는 **주의 환기 배지**다. 탭을 포커스하면 `done`이 `idle`로 바뀐다. 스킬 문서도 그렇게 적는다(`skills/herdr/SKILL.md:88-90`).
- 매니페스트는 `https://herdr.dev/agent-detection/index.toml`에서 `curl` 서브프로세스로 자동 갱신되며(`src/detect/manifest_update.rs:16,473-514`) **서명·체크섬 검증이 없다**. 같은 레포가 바이너리 업데이트에는 sha256을 쓴다(`src/update.rs:587`, `src/remote/unix.rs:1474`)는 점에서 비대칭이다. 기본 on, `[update] manifest_check = false`로 끌 수 있다.
- 보조 경로로 벤더 CLI의 훅을 설치해 세션 ID/트랜스크립트 경로를 보고받는다(`pane.report_agent_session`). 하지만 이건 **resume용 식별자 전달일 뿐 수명주기 계약이 아니다** — 훅이 나르는 필드는 `agent_session_id`/`agent_session_path`/`session_start_source`가 전부다.

`agent.wait`/`agent.prompt --wait`는 이 화면 판정이 "정착(settled)"할 때까지 기다리고, 상태 변화가 5초 안에 관측되지 않으면 `agent_prompt_stalled` 에러를 낸다(`src/api/wait.rs:620-632`).

### 2.6 플러그인 — 경계가 없다

- 매니페스트가 `build` / `startup` / `actions` / `events` / `panes` / `link_handlers`를 선언하고, 각각은 그냥 argv다(`src/api/schema/plugins.rs:36-68`, `src/app/api/plugins/manifest.rs:264-455`).
- 실행은 평범한 자식 프로세스다. 샌드박스·권한 축소·allowlist가 없다(`src/plugin_command.rs:7-28`).
- 출처는 로컬 경로 또는 GitHub(`PluginSourceKind::Local | Github`, `src/api/schema/plugins.rs:105-112`). 마켓플레이스는 Cloudflare Worker다(`workers/plugin-marketplace/`).
- 즉 확장 경계 = **사용자가 `plugin link`를 눌렀는가**. 그 뒤로는 사용자 권한 전체.

### 2.7 격리·자격증명

격리는 없다. 팬끼리, 에이전트끼리, 플러그인끼리 전부 같은 UID·같은 권한이다. `pane.read`로 다른 팬의 출력을 읽는 것이 정식 API다.

자격증명은 herdr가 **직접 다루지 않는다** — 벤더 CLI를 띄우고 CLI가 자기 설정을 읽는다(`src/integration/env.rs:23`의 `$GROK_HOME/auth.json` 언급도 훅 설치 위치를 찾기 위한 것뿐이다). 따라서 ADR-0004(provider 자격증명 비유입)와 **직접 충돌하지는 않는다**. 다만 강제하지도 않는다: 한 팬의 에이전트가 다른 팬의 화면에서 토큰을 긁어 갈 수 있고, `session-history.json`은 그 화면을 디스크에 남긴다(그래서 기본 off다).

### 2.8 과금·계량

**없다.** 시간·CPU·메모리 계량 코드가 0이다. 가장 근접한 `pane.process_info`가 돌려주는 것은 pid/name/argv/cmdline/cwd/tty뿐이다(`src/api/schema/panes.rs:441-464`). 원장도, 지속 저장소도 없다.

### 2.9 라이선스·의존성

- Apache-2.0 **확인**. `LICENSE` 실제 Apache 2.0 전문, `Cargo.toml:7 license = "Apache-2.0"`.
- 직접 의존 20개(base64, bincode, bytes, clap, crossterm, ctrlc, interprocess, libc, portable-pty, png, ratatui, regex, serde, serde_json, sha2, tokio, toml, tracing, unicode-width, schemars) 전부 MIT/Apache-2.0 계열. `Cargo.lock` 265개 crate 이름 목록에도 copyleft 상용 crate가 보이지 않는다.
- Vendored 2개: `vendor/libghostty-vt` = **MIT**(`vendor/libghostty-vt/LICENSE:1-3`, Mitchell Hashimoto/Ghostty contributors), `vendor/portable-pty` = **MIT**(`vendor/portable-pty/Cargo.toml`).
- **AGPL/GPL 혼입 없음.** 우리 "AGPL 백본 금지"와 충돌하지 않는다.
- 단, 빌드 전제로 **Zig 툴체인**이 필요하다(`build.rs:60-80`). 우리 Rust 빌드 파이프라인에 새 언어 툴체인을 들이는 비용이다.

### 2.10 재사용 가능한 Rust 조각 — crate 경계 판정

**crate 단위 재사용은 불가능하다.** `src/lib.rs`가 없고 `[lib]` 타깃이 없다. 모든 모듈이 바이너리 내부 사적 모듈이다(`src/main.rs:57-103`). `herdr = "0.7"` 의존은 성립하지 않는다. 남는 선택지는 **소스 복사 + Apache-2.0 고지**뿐이고, 그 경우 205k줄 중 어디를 잘라도 `crate::config`, `crate::session`, `crate::events` 같은 전역 싱글턴에 얽혀 있다(예: `src/persist/io.rs:11`이 `crate::session::data_dir()`를 직접 부른다).

우리가 원할 법한 PTY 계층은 사실 `portable-pty`의 얇은 래퍼다(`src/pty/backend/unix.rs:12-42`, 30줄). **`portable-pty`를 우리가 직접 의존하는 편이 낫다** — MIT이고 herdr도 그걸 쓴다.

다만 herdr가 그 crate에 붙인 **Windows 패치는 값어치가 있다**(`vendor/portable-pty.patches.md`):

> `portable-pty` intentionally probes a bare `conpty.dll` through the DLL search path. Herdr must never load another application's DLL from `PATH`.

즉 `portable-pty` 0.9.0은 Windows에서 **PATH 상의 `conpty.dll`을 그대로 로드하는 DLL 하이재킹 경로**가 있고, herdr는 해시 검증 + 절대경로 로드 + 검색경로 제한으로 막았다. 우리가 Windows work host를 열 때 **같은 함정을 그대로 밟게 된다**. 이건 코드가 아니라 사전 지식으로서 가치가 크다.

---

## 3. momo T3/workd와의 겹침·차이

우리 쪽 사실 (track/engine 실측):

- workd 실체 = `workers/WorkHostDaemon`, Swift 6 / macOS 14+, 실행 파일 `momo-workd`. **소스 6,100줄 / 23파일** (`Package.swift:1-30`). 상위: `TerminalAttachServer.swift`(754), `Config.swift`(481), `CodexJSONRPCAdapter.swift`(442), `WorkDaemon.swift`(435), `OpenCodeHTTPAdapter.swift`(427), `WebSocketWire.swift`(420), `WorkHostAPIClient.swift`(415), `ACPClient.swift`(405), `ProcessManager.swift`(342), `PTYReplayBuffer.swift`(261), `LocalPTYTerminalManager.swift`(239), `ShellWrappedPTY.swift`(162), `Signing.swift`(141).
- 서명: Curve25519(Ed25519) 개인키 보유(`Signing.swift:10-24`). 하트비트는 `momo.work_host.heartbeat.v1`, 요청은 `momo.work_host.request.v2`로 **method + path + workspace_id + host_id + sent_at + body SHA-256 digest + 1회용 request id**를 묶어 서명(`Signing.swift:26-60`). 헤더 `X-Momo-Work-Host-Sent-At` / `-Signature` / `-Request-ID`(`WorkHostAPIClient.swift:351-353`).
- 제어면은 전부 workspace 스코프 REST이고 workd가 **폴링한다**(ADR-0125 D1 — 사용자 네트워크에 인바운드 포트를 열지 않는다): `register` / `heartbeat` / `pending-controls` / `live-sessions` / `reconcile` / `work-tool-profiles` / `work-sessions` 생성·종료·idle·running / `work-controls/{id}/ack` / `terminal-attach/validate`(`WorkHostAPIClient.swift:104-320`). 서버 측 검증은 `server-rust/bins/momo-server/src/work_host_auth.rs:155-247`(7단계) + 재사용 차단 테이블 `work_host_request`(`048_work_host_request_replay.sql:15-24`).
- **현재 Rust 서버는 이 8개 서명 라우트 중 `terminal-attach/validate` 하나만 이식했다**(`work_host_auth.rs:15-19`, `routes/work_hosts.rs:31-41` — 나머지는 이름을 적어 400으로 거절한다). 즉 B7.4는 데몬 이식만이 아니라 **서버 쪽 나머지 7개 라우트와 짝을 이뤄야 한다.**
- **서버는 PTY 바이트를 나르지 않는다**(ADR-0125 D10). `terminal_attach.rs:8-15` 모듈 주석: "momo mints a bearer and answers whether one is still good. It does not carry a byte: no stream, no websocket, no stdin, no resize, no relay." 서버는 capability 토큰을 발급(TTL 60초, `crates/momo-t3/src/terminal_attach.rs:48`)하고 데몬의 서명 요청에 유효성만 답한다. 토큰은 SHA-256 해시로만 저장된다(`server/Migrations/023_terminal_attach.sql:24-38`).
- **바이트 전송은 workd가 직접 연다.** `TerminalAttachServer.swift`가 기본 `127.0.0.1:28650`에 TCP 리스너를 띄우고 손으로 짠 RFC 6455 WebSocket으로 클라이언트를 직접 받는다(`WebSocketWire.swift:220-258`). 클라이언트→호스트는 JSON(`connect`/`send_stdin`/`resize`/`kill`), 호스트→클라이언트는 PTY 바이트 바이너리 프레임 + 텍스트 제어 프레임 `replay_end{byte_offset}` / `replay_overflow{byte_offset}`(`PTYReplayBuffer.swift:24-53`). 재접속 시 링버퍼 리플레이→`replay_end` 1회→라이브를 **같은 락 안에서** 이어 붙여 중복도 누락도 없게 한다(`:179-207`, 설계 주석 `:6-9`). 백프레셔 초과 시 바이트를 버리지 않고 **구독자를 끊는다**(`:97-110`). 스트림 수명은 토큰 TTL이 아니라 **30초 주기 재검증**이 잡는다(`TerminalAttachServer.swift:386-429`) — 취소되면 close 1008.
- 수명주기: `work_session.status ∈ running | idle | orphaned | ended`, `end_reason ∈ orphaned | resumed | idle_timeout`(`server/Migrations/047_work_session_idle.sql:18-24`). 에이전트 run은 별도로 `queued | running | awaiting_approval | paused | succeeded | failed | cancelled | timed_out`(`schema_v0.sql:19-21`, `server-rust/crates/momo-agent/src/run.rs:26-35`). `running↔idle` 전이는 workd가 OSC-777 마커로 감지해 서명 PATCH로 보고하고(`WorkDaemon.swift:359-389`), `orphaned`는 **workd가 절대 쓰지 않는다** — 서버 sweep의 몫이다(`056_work_session_host_reconciliation.sql:10-16`).
- reattach 판정 어휘는 `reattach | resume_lineage | replay_only` 3종이고 서버가 한 번의 왕복으로 돌려준다(`routes/reattach.rs:76-82`). 리플레이는 PTY 바이트가 아니라 **메시지 스레드**이며 커서는 `message.seq`다(`:196-202`).
- **정산 원장은 `usage_ledger`가 아니다.** `usage_ledger`(`001_init.sql:456-472`)는 **LLM 토큰** 원장이고, 마이그레이션 045 머리주석(`:4-9`)이 T3용으로 확장하지 않겠다고 명시한다. T3 원장은 `workspace_credit` + `credit_entry`(append-only, `045:144-146`) + `work_host_usage` + `work_host_usage_interval`이다. paused 구간은 `active_seconds`가 GENERATED 식에 `state='active'` 가드로 묶여 **구조적으로 0원**이다(`045:66-72`).
- 정산: `t3_terminate(workspace, session, reason)` 단일 관문. `reason ∈ ended | idle_timeout | orphaned | provider_missing | destroyed`, advisory lock → `workspace_credit FOR UPDATE` → 열린 구간 전부 마감 → `SUM(active_micros)` 후 **딱 한 번 floor**(`server/Migrations/058_t3_interval_micro_precision.sql:116-275`). 우회는 트리거가 즉시 실패시킨다(`053_t3_lifecycle_canonicalization.sql:72-88` — "t3 settlement must go through t3_terminate").

| 축 | herdr | momo T3/workd | 판정 |
|---|---|---|---|
| 배치 | 사용자 노트북의 로컬 데몬 | 서버(멀티테넌트) + 원격 실행 호스트 | **다른 층** |
| 인증 | 없음. 소켓 `0600`뿐, Windows는 no-op | 요청별 Ed25519 v2 서명(경로·바디 digest·1회용 ID 결속) + bearer 미들웨어 | **호환 불가** |
| 테넌시 | 코드에 개념 없음 | workspace 스코프 + RLS FORCE | **호환 불가** |
| 제어 방향 | 로컬 호출자 → 로컬 서버(하향) | workd → 서버 폴링, 서버가 control 발행(상향 보고) | **반대** |
| 상태 판정 | 화면 정규식 휴리스틱 4종 | PG 기록 계약. 세션 4종 + run 8종 | **다른 종류** |
| `done` 의미 | "idle이고 UI가 아직 안 봄" | 없음. 우리는 `succeeded/failed/...`가 원장 입력 | **차용 불가** |
| 이벤트 | 512칸 인메모리 링, 시퀀스 미노출, 유실 무탐지 | outbox → relay, 채널별 gapless `message.seq` | **호환 불가** |
| SoT | JSON 파일 2개 | Postgres | **호환 불가** |
| 계량·정산 | 없음 | `work_host_usage(_interval)` + `credit_entry` + `t3_terminate` 초 단위 | **herdr에 없음** |
| PTY 소유 | herdr 서버 | workd(`LocalPTYTerminalManager` + `PTYReplayBuffer` 256 KiB) | **겹침** |
| PTY 바이트 경로 | 로컬 UDS(같은 머신 안) | 클라이언트 → workd WebSocket 직결. **서버 경유 금지**(ADR-0125 D10) | **다른 위상** |
| 리플레이 이음매 | 화면 이력 JSON 재주입, 경계 계약 없음 | `replay_end{byte_offset}` 단일 스플라이스, 중복·누락 금지, 초과 시 구독자 절단 | **우리가 더 엄격** |
| detach/reattach | 데몬 생존 + 화면 리플레이(기본 off) | capability 토큰 발급/검증 + 30초 재검증 + 단일 왕복 reattach 판정 3종 | **겹치나 우리가 더 나아감** |
| 재시작 후 복구 | 툴별 `--resume` argv 표 15종+ | `work-tool-profiles` + lineage resume(ADR-0139 D3) | **겹침. herdr 표가 더 넓음** |
| 무중단 업그레이드 | `SCM_RIGHTS` fd 핸드오프 | **없음** | **herdr가 앞섬** |
| 격리 | 없음 | workspace + RLS + 승인 게이트 | **호환 불가** |
| 자격증명 | 벤더 CLI에 위임(직접 안 다룸) | ADR-0004 비유입 | **충돌 없음, 강제도 없음** |
| 라이선스 | Apache-2.0, 의존성 permissive | AGPL 백본 금지 | **적합** |
| 소비 형태 | lib 타깃 없음 → 의존 불가 | — | **조각 차용도 복사뿐** |

---

## 4. workd 대체 가능성 판정

### 4.1 대체 — **불가**

herdr를 workd 자리에 놓으면 다음이 전부 사라진다.

1. **서명된 제어면.** workd의 존재 이유 중 상당 부분이 `WorkHostAPIClient.swift:104-320`의 서명 클라이언트다. herdr의 소켓은 자격증명 필드가 없어서 그 계약을 표현할 수 없다. herdr 앞에 우리가 서명 프록시를 새로 쓰면 **그 프록시가 곧 workd다** — 절약이 아니다.
2. **정산.** `t3_terminate`가 유일한 정산문이고 트리거로 봉인돼 있으며 NCP 실서버에서 3초 × 25 µUSD로 실측됐다. herdr에는 시간 계량 자체가 없다.
3. **상태 계약.** 우리 `work_session`/`run_status`는 PG 제약으로 강제되고 승인 게이트(`awaiting_approval`)를 갖는다. herdr의 `blocked`는 "화면에 `enter to select`와 `esc to cancel`이 같이 보임"이다. 이걸 승인·과금의 입력으로 쓰는 건 불가능하다.
4. **순서 보장.** 512칸 링에서 조용히 유실되고 구독자가 알 수 없는 이벤트 스트림 위에 gapless `seq`를 세울 수 없다.
5. **바이트 경로의 위상이 다르다.** ADR-0125 D10은 PTY 바이트가 서버·릴레이를 통과하지 못하게 못박았고, 그래서 workd가 자기 WebSocket 리스너를 연다. herdr의 전송은 **같은 머신 안의 로컬 소켓**뿐이라 이 자리에 놓을 물건이 아니다. herdr에 원격 수신을 붙이려면 그 자체가 우리 `TerminalAttachServer`(754줄)를 다시 쓰는 일이다.
6. **소비 형태.** lib 타깃이 없어 crate로 못 쓴다. 포크해서 205k줄을 유지보수하는 선택지만 남는데, B7.4(workd Rust 이식)의 실제 규모는 **Swift 6,100줄**이다. 포크 유지 비용이 원 작업보다 크다.

작업량 추정: herdr 대체 = 소켓 계층에 인증·테넌시·원장 훅을 이식(상류에 병합될 리 없는 침습적 포크) + 우리 서명/폴링/reconcile/capability 검증/원격 attach를 그 위에 재작성. **B7.4 자체(6,100줄 이식)보다 크고, 되돌리기 어렵다**(포크 드리프트가 누적된다). 불변식 충돌: PG=SoT, 단일 쓰기경로, gapless seq, RLS FORCE, `t3_terminate` 단일 관문, ADR-0125 D10 바이트 비경유 — **여섯 개 전부**.

### 4.2 보완재 — **성립하지만 우리가 할 일이 없다**

가능한 모양은 하나뿐이다: 개발자가 자기 머신에서 herdr로 여러 에이전트를 굴리고, **그 머신을 BYOC work host로 등록한다**. 그런데 등록·서명·`terminal-attach/validate` 응답은 **여전히 momo workd가 해야 한다**(Ed25519 키를 쥔 쪽이 workd다). 따라서 herdr는 workd 아래가 아니라 **옆에** 놓인다. 사용자가 알아서 깔면 그만이고, 우리 쪽 통합 작업은 0이다. 얻는 것: 없음(우리 코드 기준). 잃는 것: 없음. 되돌림: 해당 없음.

굳이 문서화한다면 "BYOC 호스트에서 herdr를 함께 써도 무방하다" 한 줄이고, 그마저 지금은 이르다.

### 4.3 조각 차용 — **3개, 전부 설계 참조 수준**

| 조각 | 위치 | 우리 쓰임 | 작업량 |
|---|---|---|---|
| **A. `SCM_RIGHTS` 무중단 핸드오프** | `src/server/handoff.rs:395-440` (fd 전달), `:33-47` (매니페스트) | workd 업그레이드 시 실행 중 PTY 유지. **B7.4의 Swift→Rust 컷오버가 지금 설계로는 모든 세션을 죽인다.** ADR-0139 orphaned 경로로 흡수되긴 하나 사용자에겐 세션 소실이다 | 소. 자기완결적 |
| **B. 툴별 `--resume` argv 표** | `src/agent_resume.rs:121-205` | `work-tool-profiles` 확장 시 15종+ CLI의 resume 문법 실측 참조표 | 극소. 표만 읽으면 됨 |
| **C. Windows ConPTY DLL 하이재킹 방어** | `vendor/portable-pty.patches.md`, `vendor/patches/portable-pty/0001-control-conpty-loading.patch` | Rust workd가 Windows를 열 때 `portable-pty` 0.9.0이 PATH의 `conpty.dll`을 로드하는 문제. 해시 검증 + 절대경로 + 검색경로 제한 | 소. 단, Windows 착수 시점에 |

**차용하지 말 것**: 탐지 매니페스트를 우리 상태 판정에 도입하는 것. 우리는 claude/codex/opencode에 대해 이미 의미 채널을 갖고 있다(`CodexJSONRPCAdapter.swift`, `ACPClient.swift`, `OpenCodeHTTPAdapter.swift`). 계약을 휴리스틱으로 바꾸는 건 **후퇴**다. `tool='shell'` 세션에서 상태 추론이 필요해질 때만 규칙 **형식**(region + priority + not/any + explain 출력)을 참고할 가치가 있다.

**차용하지 말 것 2**: 91개 메서드 소켓 API 표면. pane/tab/layout 중심이라 **TUI의 API지 런타임의 API가 아니다.**

### 4.4 아무것도 안 함 — 상당 부분 이쪽이 맞다

detach/reattach, 세션 지속, 상태 가시화, worktree 계층은 겹치지만 **우리가 이미 더 나아갔다**. capability 토큰 발급/검증 분리, 서명된 호스트 인증, `reattach` 단일 왕복 판정, PG 기록 수명주기, 초 단위 정산 — herdr에는 어느 것도 없고 만들 계획도 코드에 없다.

---

## 5. 권고

**B7.4(workd Rust 이식)를 계획대로 진행한다. herdr 도입·사이드카·교체는 열지 않는다.** 현재 B7.4는 핸드오프 패킷이 없고 스코프 선언만 있다(`docs/planning/2026-07-30-rewrite-batch-breakdown.md:41-44` — "WorkHostDaemon(6.1k Swift) → Rust, `momo-wire` 서명 공유. ACP/Codex/OpenCode 어댑터·PTY attach"). 그 패킷을 쓸 때 두 가지를 반영한다.

1. PTY 계층은 herdr 소스를 복사하지 말고 **`portable-pty`(MIT)를 직접 의존한다.** herdr의 해당 계층은 그 crate의 30줄 래퍼다(`src/pty/backend/unix.rs:12-42`).
2. 조각 A(`SCM_RIGHTS` 무중단 핸드오프)를 **명시적 스코프 항목으로 추가한다** — Swift→Rust 컷오버에서 실행 중 세션을 죽이지 않는 유일한 방법이고, herdr가 이미 검증한 패턴이며, 우리에게 없는 것이다. 없으면 컷오버가 전 세션을 `orphaned`로 밀어넣고 그 경로는 `t3_terminate('orphaned')`로 **과금 정산까지 발생시킨다**(`crates/momo-t3/src/sweep.rs:10-12`).

부수 조치 2건:

1. **2026-07-28 감사가 남긴 "Windows work host 착수 직전 herdr 비교 spike"를 종결 처리한다.** 근거: (a) herdr의 유일한 접근 통제(`0600`)가 Windows에서 명시적 no-op이다(`src/ipc.rs:283-286`), (b) crate 소비가 불가능하다(lib 타깃 없음), (c) 우리 서명·정산 계약을 표현할 수 없다. 비교할 축이 남아 있지 않다. 대신 그 spike의 실질 산출물로 **조각 C(ConPTY DLL 로드 경로)** 를 Windows work host 티켓의 수용기준에 넣는다.
2. 조각 B(resume argv 표)는 `work-tool-profiles` 확장 티켓의 참고 자료로 링크만 남긴다. 코드 이식 아님.

이 권고는 되돌릴 수 있다. herdr가 `AGENTS.md:40`이 말한 "server-owned runtime protocol" 전환을 실제로 마치고 인증·테넌시를 붙이면 재평가 대상이 된다. 재평가 트리거는 **소켓 프로토콜에 자격증명 필드가 생기는 시점**이다(`src/protocol/wire.rs`의 `Hello`, `src/api/schema.rs`의 `Request`).

---

## 6. 위험·미확인

- **실행하지 않았다.** 모든 판정은 정적 읽기다. 렌더 성능, PTY 처리량, 실제 detach 안정성은 검증하지 않았다. 지시대로 `install.sh`·brew·cargo 전부 미실행.
- **Windows named pipe의 기본 DACL은 확인하지 못했다.** 확인한 사실은 "herdr가 보안 서술자를 지정하지 않으며 `restrict_socket_permissions`가 Windows에서 빈 `Ok(())`"까지다(`src/ipc.rs:60-72, 283-286`). `interprocess` crate 내부 기본값은 vendored 소스가 없어 못 봤다. 실제 노출 범위는 그 crate의 기본 SD에 달렸다.
- **`Cargo.lock` 265개 crate의 라이선스를 개별 확인하지 않았다.** 직접 의존 20개 + vendored 2개만 실제 확인했고 나머지는 crate 이름 기준 판단이다. `cargo deny`를 돌리지 않았다(실행 금지 지시).
- **탐지 매니페스트 원격 갱신의 실제 서버 응답을 보지 않았다.** 코드상 체크섬 검증 부재는 확인했으나(`src/detect/manifest_update.rs`에 `checksum::` 호출 없음), herdr.dev가 별도 서명을 싣는지는 알 수 없다.
- **GitHub Issue/PR 논의를 읽지 않았다.** 소스와 레포 내 문서만 봤다. 로드맵상 인증·멀티테넌시가 임박했을 가능성은 배제하지 못한다(단, `AGENTS.md`·README·docs 어디에도 그런 언급은 없다).
- **momo 쪽 대조는 track/engine 워크트리 기준이다.** `server-rust/`는 engine 워크트리에만 있고 main에는 없다. `workers/WorkHostDaemon`과 `server/Migrations`는 두 곳이 동일하다. `work_session` 상태 4종은 마이그레이션 047 기준이며 그 이후 변경이 있으면 갱신이 필요하다.
- **과제 지시문의 "usage_ledger"는 코드와 다르다.** `usage_ledger`는 LLM 토큰 원장이고, T3 초 단위 과금은 `work_host_usage(_interval)` + `credit_entry`가 담당한다(`045_t3_provisioner_credit_ledger.sql:4-9`가 분리 의도를 명시). 본 문서 §3은 코드 쪽을 따랐다.
- **B7.4는 아직 핸드오프 패킷이 없다.** 배치 이름과 스코프 한 줄(`2026-07-30-rewrite-batch-breakdown.md:41-44`, 구 "B5")만 있고 수용기준·티켓이 없다. 본 문서의 권고는 그 패킷 작성 시 반영 대상이지, 기존 티켓의 변경이 아니다.
- 조각 A(`SCM_RIGHTS` 핸드오프)의 **Swift→Rust 언어 경계 적용 가능성은 미검증**이다. fd 전달 자체는 언어 무관이지만, 우리 workd의 PTY 상태(링버퍼 오프셋, `replay_end` 스플라이스 위치)를 매니페스트로 직렬화해 넘기는 설계는 새로 해야 한다. B7.4 착수 전 별도 판단이 필요하다.
