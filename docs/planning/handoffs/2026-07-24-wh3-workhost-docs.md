# 핸드오프 패킷 — WH-3 (#707): 배포판 문서 "코드 실행 호스트 5분 연결"

> ADR-0114 증보1 WH-3 (docs). base=**track/engine** · worktree=`../momo-worktrees/707-5-adr-0114-1-wh-3`.

## 목표
배포판 사용자(운영자)가 코드 실행 호스트를 붙이는 5분 가이드. opencode/goose는 배포판 동봉, Codex는 로컬 연결.

## 근거 (읽어라)
- `docs/adr/0114-interactive-work-console.md` 증보1(D1~D4, 파생 WH-*).
- `docs/planning/2026-07-24-wh0-workhost-engine-spike.md`(엔진 실측).
- `infra/prod/docker/workhost.Dockerfile` + compose `--profile workhost`(WH-1, main 랜딩) — 실제 기동 방식.
- 기존 배포/문서 톤: `README`, `infra/prod/install.sh`, 알파 배포(`scripts/publish_alpha_build.sh`).

## 수용기준
- [ ] "코드 실행 호스트 5분 연결" 문서(위치: `docs/` 또는 배포판 문서 관례에 맞게, README에서 링크). 한국어 우선(제품 톤 일치).
- [ ] 내용: (1) 사이드카 opt-in 기동(`--profile workhost`) (2) 앱 설정 "코드 실행 호스트"에서 엔진 선택(opencode 기본/goose 동봉/codex-local) (3) Codex 로컬 연결 방법(사용자 호스트의 `codex` 사용, 자격증명은 `~/.codex`/keychain — momo 비유입) (4) provider("AI 연결")와 work host의 관계 구분.
- [ ] 자격증명 경계(ADR-0004) 명시: 동봉 엔진/로컬 Codex가 쓰는 LLM 키는 사용자 소유, momo 서버/DB/원장 비유입.
- [ ] em-dash(—/–) 0, 과장어("원활한/손쉽게/seamless") 0. 동사-우선. 정확한 명령/경로만.

## 하드 룰
- PR base=track/engine(docs). PR 후 STOP. merge/close 금지. 코드/스키마 무변경(문서만). 시크릿 금지.
