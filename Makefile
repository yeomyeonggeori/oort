# oort(momo) — Makefile
# Targets: build / test / migrate / up / down  (+ 은퇴 중: swift-build / swift-test)
#
# 현행 스택 (ADR-0145 서버 재작성 · ADR-0119/0133 웹·데스크톱 · ADR-0137 공유 코어):
#   서버        Rust/Axum 워크스페이스 `server-rust/` — cargo (bins: momo-server,
#               momo-relay, momo-agent-worker, momo-notifier, momo-migrate)
#   웹/데스크톱  `clients/web`(React/Vite) — `clients/desktop`(Tauri 2)이 같은 번들을 감싼다
#   모바일       `clients/mobile`(React Native)
#   공유 코어    `packages/momo-core`(레포 루트 npm 워크스페이스)
#
# **Swift 트리는 은퇴 중이다.** `clients/macOS`·`clients/iOS`·`clients/Core`,
# `server/Sources`(Hummingbird 2), `relay/OutboxRelay`, `workers/*`, `services/*`는
# 아직 레포에 있지만 삭제 대기이며 새 작업의 기준이 아니다. 그 빌드는 이 파일에서
# `build`/`test`가 아니라 **`swift-build`/`swift-test`**로 이름이 바뀌었다
# (`scripts/local_gate.sh`의 Swift 단계가 그 이름을 부른다).
# 예외 — 은퇴 아님: `server/Migrations/*.sql`은 Rust 이미지가 그대로 싣는 정본 DDL이고,
# `relay/PushRelay`는 라이브 푸시 경로가 여전히 빌드하는 Swift 컴포넌트다
# (`infra/rust/docker-compose.push.build.yml`).
#
# up/down/migrate는 dev용 `infra/docker-compose.yml`(PG18 + Centrifugo v6)을 다룬다.
# docker/psql이 없으면 runtime-unverified (no docker/psql).

# --- 현행 스택 -----------------------------------------------------------------
CARGO_MANIFEST := server-rust/Cargo.toml
NPM_TREES      := . clients/web clients/mobile

# --- 은퇴 중(Swift) ------------------------------------------------------------
# 의존 순서: Core → server/relay/worker/notifier/service → macOS
SWIFT_PKGS := clients/Core services/OutboundHTTPPolicy services/MomoMetrics services/CloudProviderKit server relay/OutboxRelay relay/PushRelay workers/AgentWorker workers/WorkHostDaemon workers/NotifierWorker services/LinkShort clients/macOS

COMPOSE        := docker compose
COMPOSE_FILE   := infra/docker-compose.yml
MIGRATE_SCRIPT := scripts/migrate.sh
ENV_FILE       ?= $(firstword $(wildcard .env.worktree .env infra/.env.example))
COMPOSE_ENV    := $(if $(ENV_FILE),--env-file $(ENV_FILE),)

.DEFAULT_GOAL := help
.PHONY: help build test rust-build rust-test ts-check ts-test migrate up down \
        swift-build swift-test local-alpha-plan local-alpha

help: ## 사용 가능한 타깃 출력
	@echo "oort — make targets:"
	@echo "  make build       현행 스택 빌드 (server-rust cargo build + TS 타입체크)"
	@echo "  make test        현행 스택 테스트 (cargo test + npm test)"
	@echo "  make rust-build  server-rust 워크스페이스만 cargo build"
	@echo "  make rust-test   server-rust 워크스페이스만 cargo test"
	@echo "  make ts-check    momo-core + web + mobile 타입체크"
	@echo "  make ts-test     momo-core + web + mobile 테스트"
	@echo "  make migrate     server/Migrations/*.sql 번호순 적용 (psql 필요)"
	@echo "  make up          infra/docker-compose.yml 기동 (PG18 + Centrifugo v6)"
	@echo "  make down        인프라 중지"
	@echo "  make swift-build [은퇴 중] Swift 패키지 빌드 — 삭제 대기 트리"
	@echo "  make swift-test  [은퇴 중] Swift 패키지 테스트 — 삭제 대기 트리"
	@echo "  make local-alpha-plan  MOMO-240 로컬 알파 runner dry-run"
	@echo "  make local-alpha       MOMO-240 로컬 알파 runner execute(mock Hermes)"

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
# 인프라 (dev compose)
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

up: ## 인프라 기동 (PostgreSQL 18 + Centrifugo v6)
	@# --wait: postgres/centrifugo 모두 compose healthcheck가 정의되어 있어
	@# healthy(=연결 수락 가능)까지 대기한다(MOMO-316). 폴링 루프 불필요.
	@if [ -f "$(COMPOSE_FILE)" ]; then \
		if command -v shasum >/dev/null 2>&1; then \
			config_sha="$$(shasum -a 256 infra/centrifugo.json | awk '{ print $$1 }')"; \
		else \
			config_sha="$$(sha256sum infra/centrifugo.json | awk '{ print $$1 }')"; \
		fi; \
		test -n "$$config_sha" || { echo "failed to fingerprint infra/centrifugo.json" >&2; exit 1; }; \
		MOMO_CENTRIFUGO_CONFIG_SHA256="$$config_sha" $(COMPOSE) $(COMPOSE_ENV) -f "$(COMPOSE_FILE)" up -d --wait; \
	else \
		echo "up: $(COMPOSE_FILE) 없음. runtime-unverified (no docker/psql)."; \
	fi

down: ## 인프라 중지
	@if [ -f "$(COMPOSE_FILE)" ]; then \
		$(COMPOSE) $(COMPOSE_ENV) -f "$(COMPOSE_FILE)" down; \
	else \
		echo "down: $(COMPOSE_FILE) 없음. runtime-unverified (no docker/psql)."; \
	fi

# =============================================================================
# 은퇴 중 — Swift 트리 (삭제 대기). 새 기능을 여기 얹지 마라.
# =============================================================================

swift-build: ## [은퇴 중] Swift 패키지 빌드 (Package.swift 존재하는 것만)
	@echo "[은퇴 중] Swift 트리는 삭제 대기다. 현행 스택 빌드는 'make build'."
	@found=0; \
	for pkg in $(SWIFT_PKGS); do \
		if [ -f "$$pkg/Package.swift" ]; then \
			found=1; \
			echo "==> swift build ($$pkg)"; \
			( cd "$$pkg" && swift build ) || exit 1; \
		fi; \
	done; \
	if [ "$$found" = "0" ]; then \
		echo "swift-build: Package.swift가 하나도 없습니다 (Swift 트리 삭제 완료로 보입니다)."; \
	fi

swift-test: ## [은퇴 중] Swift 패키지 테스트 (Package.swift 존재하는 것만)
	@echo "[은퇴 중] Swift 트리는 삭제 대기다. 현행 스택 테스트는 'make test'."
	@found=0; \
	for pkg in $(SWIFT_PKGS); do \
		if [ -f "$$pkg/Package.swift" ]; then \
			found=1; \
			echo "==> swift test ($$pkg)"; \
			( cd "$$pkg" && swift test ) || exit 1; \
		fi; \
	done; \
	if [ "$$found" = "0" ]; then \
		echo "swift-test: Package.swift가 하나도 없습니다 (Swift 트리 삭제 완료로 보입니다)."; \
	fi

local-alpha-plan: ## MOMO-240 local alpha runner dry-run
	@sh scripts/local_alpha_runner.sh plan

local-alpha: ## MOMO-240 local alpha runner execute (mock Hermes by default)
	@sh scripts/local_alpha_runner.sh execute --hermes mock
