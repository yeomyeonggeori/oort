# oort(momo) — Makefile
# Targets: build / test / migrate / up / down
#
# 현행 스택 (ADR-0145 서버 재작성 · ADR-0119/0133 웹·데스크톱 · ADR-0137 공유 코어):
#   서버        Rust/Axum 워크스페이스 `server-rust/` — cargo (bins: momo-server,
#               momo-relay, momo-agent-worker, momo-notifier, momo-migrate)
#   웹/데스크톱  `clients/web`(React/Vite) — `clients/desktop`(Tauri 2)이 같은 번들을 감싼다
#   모바일       `clients/mobile`(React Native)
#   공유 코어    `packages/momo-core`(레포 루트 npm 워크스페이스)
#
# up/down 은 `docs/SELF_HOST.md` 로컬 빌드 모드의 compose 명령을 그대로 감싼다
# (`scripts/self_host_env.sh --compose …`). 기동 절차 정본은 그 문서다.
# migrate 는 `server/Migrations/*.sql` 정본 DDL 을 적용한다.

# --- 현행 스택 -----------------------------------------------------------------
CARGO_MANIFEST := server-rust/Cargo.toml
NPM_TREES      := . clients/web clients/mobile

MIGRATE_SCRIPT := scripts/migrate.sh
ENV_FILE       ?= $(firstword $(wildcard .env.worktree .env infra/.env.example))

.DEFAULT_GOAL := help
.PHONY: help build test rust-build rust-test ts-check ts-test migrate up down \
        local-alpha-plan local-alpha

help: ## 사용 가능한 타깃 출력
	@echo "oort — make targets:"
	@echo "  make build       현행 스택 빌드 (server-rust cargo build + TS 타입체크)"
	@echo "  make test        현행 스택 테스트 (cargo test + npm test)"
	@echo "  make rust-build  server-rust 워크스페이스만 cargo build"
	@echo "  make rust-test   server-rust 워크스페이스만 cargo test"
	@echo "  make ts-check    momo-core + web + mobile 타입체크"
	@echo "  make ts-test     momo-core + web + mobile 테스트"
	@echo "  make migrate     server/Migrations/*.sql 번호순 적용 (psql 필요)"
	@echo "  make up          docs/SELF_HOST.md 로컬 빌드 compose 기동"
	@echo "  make down        docs/SELF_HOST.md compose 중지"
	@echo "  make local-alpha-plan  MOMO-240 로컬 알파 runner dry-run"
	@echo "  make local-alpha       MOMO-240 로컬 알파 runner execute(mock Hermes)"
	@echo ""
	@echo "셀프호스트 절차 정본: docs/SELF_HOST.md"

# =============================================================================
# 현행 스택
# =============================================================================

build: rust-build ts-check ## 현행 스택 빌드 (Rust 워크스페이스 + TS 타입체크)

test: rust-test ts-test ## 현행 스택 테스트 (cargo test + npm test)

rust-build: ## server-rust 워크스페이스 cargo build
	@command -v cargo >/dev/null 2>&1 || { \
		echo "rust-build: cargo 없음. 설치: https://rustup.rs (rust-version = $$(grep -m1 'rust-version' $(CARGO_MANIFEST) | cut -d'\"' -f2))"; \
		exit 1; \
	}
	cargo build --manifest-path $(CARGO_MANIFEST) --workspace

rust-test: ## server-rust 워크스페이스 cargo test
	@command -v cargo >/dev/null 2>&1 || { echo "rust-test: cargo 없음. 설치: https://rustup.rs"; exit 1; }
	cargo test --manifest-path $(CARGO_MANIFEST) --workspace

# npm 트리는 각자 lockfile을 가진다(루트=packages/*, clients/web, clients/mobile).
# 설치가 안 된 트리를 조용히 건너뛰면 "초록인데 아무것도 안 본" 판이 되므로 멈춘다.
ts-check: ## packages/momo-core + clients/web + clients/mobile 타입체크
	@$(MAKE) --no-print-directory _npm_guard
	npm run typecheck
	npm --prefix clients/mobile run typecheck

ts-test: ## packages/momo-core + clients/web + clients/mobile 테스트
	@$(MAKE) --no-print-directory _npm_guard
	npm test
	npm --prefix clients/mobile run test

.PHONY: _npm_guard
_npm_guard:
	@command -v npm >/dev/null 2>&1 || { echo "npm 없음 — Node 20+ 설치 후 다시."; exit 1; }
	@missing=""; \
	for d in $(NPM_TREES); do \
		[ -d "$$d/node_modules" ] || missing="$$missing $$d"; \
	done; \
	if [ -n "$$missing" ]; then \
		echo "npm 트리에 node_modules 없음:$$missing"; \
		echo "  설치: npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci"; \
		exit 1; \
	fi

# =============================================================================
# 인프라 (docs/SELF_HOST.md 로컬 빌드 compose)
# =============================================================================

migrate: ## server/Migrations/*.sql 번호순 적용 (psql 필요)
	@if [ -f "$(MIGRATE_SCRIPT)" ]; then \
		if [ -n "$(ENV_FILE)" ] && [ -f "$(ENV_FILE)" ]; then \
			set -a; . "$(ENV_FILE)"; set +a; \
		fi; \
		sh "$(MIGRATE_SCRIPT)"; \
	else \
		echo "migrate: $(MIGRATE_SCRIPT) 없음. runtime-unverified (no docker/psql)."; \
	fi

up: ## 셀프호스트 스택 기동 (docs/SELF_HOST.md 로컬 빌드 모드)
	scripts/self_host_env.sh --compose up -d --build --wait

down: ## 셀프호스트 스택 중지 (docs/SELF_HOST.md)
	scripts/self_host_env.sh --compose down

local-alpha-plan: ## MOMO-240 local alpha runner dry-run
	@sh scripts/local_alpha_runner.sh plan

local-alpha: ## MOMO-240 local alpha runner execute (mock Hermes by default)
	@sh scripts/local_alpha_runner.sh execute --hermes mock
