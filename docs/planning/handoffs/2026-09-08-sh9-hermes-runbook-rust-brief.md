# SH-9 핸드오프 브리프 — hermes 합류 런북 Rust 현행화 + SELF_HOST §5 로컬 provider 절 (#2231, 2026-09-08 go, SH-6a-e 뒤 발사)

> 트랙: engine/docs · 크기 M · 케이스 B(독립 셀프호스팅 + 본인 hermes) · 파도 G1'-3 · **SH-6a-e(#2215, PR #2225) 랜딩 뒤** 발사. 사실 출처: 2026-09-08 읽기 전용 탐색.

## 0. 실측 요약
- `docs/external-agent-provider/*` 스테일은 **국소적**: Swift 런타임 이름 3종(MomoServer·AgentWorker·OutboxRelay) 11곳 + 고정 포트 `28180/28100`(`hermes-gateway-native-platform.md:74-75`) + **삭제된** `scripts/verify_external_agent_provider.sh`(2026-09-07 `4dc75f2e`) 참조 5곳(README `:105,:141` · codex-oauth `:157` · gpt `:62,:126`) + 「Command Center」(은퇴 macOS 표면, codex-oauth `:147`). `PushRelay`·`ncp` 0건.
- 살아 있는 것(삭제 금지·승계): `adapters/hermes/`(Python 플러그인, `plugin.yaml`) · `scripts/momo` hermes 서브커맨드 8종(`:30-39`, `hermes-gateway-install-plugin` `:37-38`, 플러그인 경로 `:619-624`) · `scripts/verify_hermes_gateway_adapter.sh` · `scripts/verify_local_hermes_credentialed_smoke.sh` · `scripts/local_gate.sh --profile external-agent-provider`(`:828-834,:990-994`) · `local-hermes-provider.env.example`.
- **진짜 공백**: `docs/SELF_HOST.md`/`.ko.md`에 hermes·로컬 provider 0건(원격 OpenAI 호환 + 키만 상정). SH-6a-e가 「Local provider (same machine)」 절(`--allow-local-provider`, `host.docker.internal:<port>/v1`)을 §5에 추가하므로 SH-9는 그 절을 **hermes 실측 절차로 확장**한다.

## 1. 산출물
- **D1 `external-agent-provider/*` 재작성(삭제 아님)**: Swift 런타임 서술 → Rust 스택(api·agent-worker·outbox relay 컨테이너 이름은 `infra/rust/docker-compose.rust.yml` 실명), 포트는 `MOMO_WEB_PORT` 파생, 죽은 검증기 5곳 → `scripts/local_gate.sh --profile external-agent-provider` + `verify_local_hermes_credentialed_smoke.sh`로 교체, Command Center → 설정 › AI 연결. mermaid participant 이름 갱신.
- **D2 `SELF_HOST.md`(+ko) §5 「Local provider」 확장**: 본인 hermes(OpenAI 호환 SSE) 기동 → `--allow-local-provider`로 env 생성 → 설정 › AI 연결에 `http://host.docker.internal:<port>/v1` → 웰컴 킥오프 답장까지 **1회 실측 로그**(SH-6a-e E2E와 같은 경로를 문서 순서대로 재현). 플러그인 경로: `scripts/momo hermes-gateway-install-plugin` + `verify_hermes_gateway_adapter.sh` 1회 실측(copy 모드·대문자 `PLUGIN.yaml` 주의 유지).
- **D3 게이트**: 문서가 인용하는 스크립트 경로 전수가 실존하는지 검사하는 시험 1개(`scripts/tests/test_external_agent_provider_docs.sh`, 삭제된 경로 인용 0) — 사보타주: 죽은 경로 한 줄 되살리기 → RED.

## 2. 경계·허용 목록
보호 경로: `scripts/tests/test_external_agent_provider_docs.sh`(신규)만. `scripts/momo`·`adapters/hermes`·`server-rust/**`·`.github/**` 무접촉. `docs/adr/**` 무접촉(경계 변경 없음 — ADR-0004 증보는 SH-6a-e가 지님).

## 3. 수용 기준(숫자)
Swift 런타임 이름 잔존 0(grep) · 죽은 스크립트 인용 0 · 고정 포트 28180/28100 잔존 0 · hermes 킥오프 답장 실측 1회(seq 기록) · 플러그인 설치+검증 PASS 1회 · docs 프로파일 PASS · 새 시험 사보타주 RED.
