# WH-0 스파이크 — work host 동봉 엔진 임베드 가능성 + Codex 연결 경로 실증 (2026-07-24, Fable)

> 게이트: ADR-0114 증보1 D1/D4. "opencode를 oort가 프로그램으로 몰 수 있나(=동봉 정당한가)" + "Codex 로컬 연결을 ACP 외 JSON-RPC로 할 수 있나"를 **문서가 아니라 hands-on으로** 판정.
> **결론: 둘 다 CONFIRMED(그린). opencode v0 동봉 확정, work host 연결은 ACP∪JSON-RPC(+ Codex mcp-server)로 확장.** 스코프 축소 없음.

---

## 1. 판정 요약

| 질문 | 판정 | 증거 |
|---|---|---|
| opencode를 헤드리스로 프로그램 구동 가능? | ✅ CONFIRMED | `opencode serve` 키 없이 부팅, OpenAPI 3.1 (경로 162), `POST /session` 실제 세션 생성 |
| opencode 동봉 정당? | ✅ | MIT + 단일 바이너리 + 헤드리스 서버 = 사이드카 이미지 동봉·구동 가능 |
| Codex 로컬 연결을 JSON-RPC로? | ✅ CONFIRMED | `codex app-server` 서브커맨드 실재, 프로토콜 스키마 41파일(v1 165/v2 516 정의) 생성 |
| Codex 연결 대안 경로? | ✅ 다중 | `codex app-server`(JSON-RPC/stdio) + `codex mcp-server`(MCP/stdio) + `remote-control`(websocket) |

## 2. opencode — 헤드리스 임베드 실증

로컬 환경: opencode 1.18.4 임시 설치(npm `opencode-ai`) → 스모크 후 제거(흔적 없음).

- **부팅**: `opencode serve --port 4096 --hostname 127.0.0.1` — **API 키 없이 부팅**(키는 모델 실행 시에만 필요). 인증은 `OPENCODE_SERVER_PASSWORD`(HTTP basic, opt-in).
- **API 표면**(`GET /doc`, OpenAPI **3.1**, 경로 **162개**):
  - `POST /session`(생성) · `GET/POST /session/{id}` · `/session/{id}/children` · `/session/{id}/todo` · `/session/status`
  - `POST /session/{id}/message`(동기) · `POST /session/{id}/prompt_async`(비동기)
  - `GET /event`(SSE 스트림 — assistant/tool 이벤트)
  - `POST /session/{id}/permissions/{permissionID}`(승인 응답 — **work console 승인 경계와 직결**)
  - `GET /experimental/tool`(도구 목록) · `/experimental/control-plane/move-session`
  - 공식 JS/TS SDK `@opencode-ai/sdk`(OpenAPI 자동생성 타입)
- **실왕복 증거**: `POST /session {"title":"momo WH-0 스파이크 스모크"}` → `{"id":"ses_06f52ace…","title":"…"}` 200. 키 없이 세션 생성 성공.
- **oort 의미**: work host 사이드카가 `opencode serve`를 띄우고 oort 서버/워커가 HTTP+SSE로 세션 생성→프롬프트→이벤트 스트림→승인을 몬다. 승인 엔드포인트가 있어 ADR-0114 D5 승인 경계를 그대로 매핑 가능.

## 3. Codex — 로컬 연결 프로토콜 실증

로컬 환경: Codex CLI 0.144.1 기설치(`@openai/codex@0.144.1`). 모델 호출·OAuth 없이 프로토콜 표면만 확인.

- **`codex app-server`**(experimental): daemon/proxy/generate-ts/generate-json-schema 서브커맨드. 프로토콜은 **newline-delimited JSON-RPC 2.0 over stdio**(t3code가 이 경로로 Codex를 몲).
- **프로토콜 스키마**(`generate-json-schema --out`): 41개 파일 —
  - 핸드셰이크: `InitializeParams`/`InitializeCapabilities`
  - 대화: `ThreadStartParams`/`ThreadResume…`/`TurnStartParams`/`TurnSteerParams`
  - 실행+승인: `CommandExecParams`/`CommandExecutionRequestApprovalParams`/`ApplyPatchApprovalParams`/`PermissionsRequestApprovalParams`/`ExecCommandApprovalResponse`
  - 버전: v1(`ClientRequest` 165 정의) + **v2(516 정의)** 병존 — 안정적·버전관리되는 계약.
- **대안 경로**: `codex mcp-server`(Codex를 MCP 서버로, stdio) — oort가 이미 MCP를 쓰면 최소 어댑터로 연결 가능. `codex remote-control`(websocket).
- **자격증명 경계(ADR-0004 재확인)**: 스키마에 `ChatgptAuthTokensRefresh…`가 있으나 이는 **사용자 호스트의 Codex가 자기 `~/.codex`/keychain으로 처리**하는 것 — oort 서버/DB/원장 비유입 불변. 사이드카/로컬 Codex는 자격증명 소비자일 뿐.

## 4. 결정 (D1/D4 확정)

1. **opencode v0 동봉 유지**(게이트 통과). 사이드카가 `opencode serve` 헤드리스 구동, oort가 HTTP+SSE로 몲.
2. **goose 병행 동봉**(Apache-2.0, ACP) — 기존 근거 유지.
3. **work host 연결 프로토콜 = 다중 지원**: 사이드카 동봉 엔진(opencode HTTP / goose ACP) + **Codex 로컬 연결(app-server JSON-RPC/stdio 우선, mcp-server 대안)**. 단일 ACP 가정을 폐기하고 어댑터 레이어로 추상화.
4. **승인 경계 통일**: opencode `/permissions` · Codex `*ApprovalParams` 둘 다 승인 요청/응답 훅을 노출 → work console 승인 UI(D5)를 엔진 무관 단일 계약으로 매핑.

## 5. WH-1 착수 인풋 (실측 반영)

- 사이드카 이미지: base + **opencode 바이너리(단일)** + **goose 바이너리** 레이어 분리(opt-in `--profile workhost`). Codex는 미동봉(사용자 호스트 연결).
- 연결 어댑터 3종: `opencode-http`(session/message/event/permissions), `goose-acp`, `codex-jsonrpc`(initialize→thread/start→turn/start→stream, 승인 훅). mcp-server는 후속 옵션.
- 엔진 선택은 GUI(WH-2)→서버 설정→사이드카 구동 엔진으로 전파. 기본=opencode.
- 리스크 없음(게이트 그린). 잔여 미확인: opencode `/session/{id}/message`의 모델 실행 실왕복(키 필요)은 WH-1 통합 테스트에서 mock provider로 확인.
