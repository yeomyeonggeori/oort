# momo — Makefile
# Targets: build / migrate / up / down / test
#
# 툴체인 현실: Swift 패키지는 `swift build`로 컴파일 검증된다.
# docker/psql/hermes가 없으면 up/down/migrate는 runtime-unverified (no docker/psql).
#
# build/test는 아래 SWIFT_PKGS 중 "Package.swift가 실제로 존재하는" 패키지만
# 순회한다 → 후속 티켓이 패키지를 추가하기 전에도 이 Makefile은 안전하게 동작한다.

# Swift 패키지 루트 (의존 순서: Core → server/relay/worker/notifier/service → macOS)
SWIFT_PKGS := clients/Core server relay/OutboxRelay relay/PushRelay workers/AgentWorker workers/WorkHostDaemon workers/NotifierWorker services/LinkShort clients/macOS

COMPOSE        := docker compose
COMPOSE_FILE   := infra/docker-compose.yml
MIGRATE_SCRIPT := scripts/migrate.sh
ENV_FILE       ?= $(firstword $(wildcard .env.worktree .env infra/.env.example))
COMPOSE_ENV    := $(if $(ENV_FILE),--env-file $(ENV_FILE),)

.DEFAULT_GOAL := help
.PHONY: help build migrate up down test local-alpha-plan local-alpha

help: ## 사용 가능한 타깃 출력
	@echo "momo — make targets:"
	@echo "  make build    모든 Swift 패키지 빌드 (Core/server/relay/worker/macOS)"
	@echo "  make migrate  server/Migrations/*.sql 번호순 적용 (psql 필요)"
	@echo "  make up       infra/docker-compose.yml 기동 (PG18 + Centrifugo v6)"
	@echo "  make down     인프라 중지"
	@echo "  make test     모든 Swift 패키지 테스트"
	@echo "  make local-alpha-plan  MOMO-240 로컬 알파 runner dry-run"
	@echo "  make local-alpha       MOMO-240 로컬 알파 runner execute(mock Hermes)"

build: ## 모든 Swift 패키지 빌드 (Package.swift 존재하는 것만)
	@found=0; \
	for pkg in $(SWIFT_PKGS); do \
		if [ -f "$$pkg/Package.swift" ]; then \
			found=1; \
			echo "==> swift build ($$pkg)"; \
			( cd "$$pkg" && swift build ) || exit 1; \
		fi; \
	done; \
	if [ "$$found" = "0" ]; then \
		echo "build: 아직 Package.swift가 없습니다 (후속 티켓 T04/T05/T06/T07/T09에서 추가)."; \
	fi

test: ## 모든 Swift 패키지 테스트 (Package.swift 존재하는 것만)
	@found=0; \
	for pkg in $(SWIFT_PKGS); do \
		if [ -f "$$pkg/Package.swift" ]; then \
			found=1; \
			echo "==> swift test ($$pkg)"; \
			( cd "$$pkg" && swift test ) || exit 1; \
		fi; \
	done; \
	if [ "$$found" = "0" ]; then \
		echo "test: 아직 Package.swift가 없습니다 (후속 티켓에서 추가)."; \
	fi

migrate: ## server/Migrations/*.sql 번호순 적용 (psql 필요)
	@if [ -f "$(MIGRATE_SCRIPT)" ]; then \
		if [ -n "$(ENV_FILE)" ] && [ -f "$(ENV_FILE)" ]; then \
			set -a; . "$(ENV_FILE)"; set +a; \
		fi; \
		sh "$(MIGRATE_SCRIPT)"; \
	else \
		echo "migrate: $(MIGRATE_SCRIPT) 없음 (후속 티켓 T03에서 추가). runtime-unverified (no docker/psql)."; \
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
		echo "up: $(COMPOSE_FILE) 없음 (후속 티켓 T02에서 추가). runtime-unverified (no docker/psql)."; \
	fi

down: ## 인프라 중지
	@if [ -f "$(COMPOSE_FILE)" ]; then \
		$(COMPOSE) $(COMPOSE_ENV) -f "$(COMPOSE_FILE)" down; \
	else \
		echo "down: $(COMPOSE_FILE) 없음 (후속 티켓 T02에서 추가). runtime-unverified (no docker/psql)."; \
	fi

local-alpha-plan: ## MOMO-240 local alpha runner dry-run
	@sh scripts/local_alpha_runner.sh plan

local-alpha: ## MOMO-240 local alpha runner execute (mock Hermes by default)
	@sh scripts/local_alpha_runner.sh execute --hermes mock
