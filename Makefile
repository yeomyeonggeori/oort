# momo — Makefile
# Targets: build / migrate / up / down / test
#
# 툴체인 현실: Swift 패키지는 `swift build`로 컴파일 검증된다.
# docker/psql/hermes가 없으면 up/down/migrate는 runtime-unverified (no docker/psql).
#
# build/test는 아래 SWIFT_PKGS 중 "Package.swift가 실제로 존재하는" 패키지만
# 순회한다 → 후속 티켓이 패키지를 추가하기 전에도 이 Makefile은 안전하게 동작한다.

# Swift 패키지 루트 (의존 순서: Core → server/relay/worker → macOS)
SWIFT_PKGS := clients/Core server relay/OutboxRelay workers/AgentWorker clients/macOS

COMPOSE        := docker compose
COMPOSE_FILE   := infra/docker-compose.yml
MIGRATE_SCRIPT := scripts/migrate.sh

.DEFAULT_GOAL := help
.PHONY: help build migrate up down test

help: ## 사용 가능한 타깃 출력
	@echo "momo — make targets:"
	@echo "  make build    모든 Swift 패키지 빌드 (Core/server/relay/worker/macOS)"
	@echo "  make migrate  server/Migrations/*.sql 번호순 적용 (psql 필요)"
	@echo "  make up       infra/docker-compose.yml 기동 (PG18 + Centrifugo v6)"
	@echo "  make down     인프라 중지"
	@echo "  make test     모든 Swift 패키지 테스트"

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
		sh "$(MIGRATE_SCRIPT)"; \
	else \
		echo "migrate: $(MIGRATE_SCRIPT) 없음 (후속 티켓 T03에서 추가). runtime-unverified (no docker/psql)."; \
	fi

up: ## 인프라 기동 (PostgreSQL 18 + Centrifugo v6)
	@if [ -f "$(COMPOSE_FILE)" ]; then \
		$(COMPOSE) -f "$(COMPOSE_FILE)" up -d; \
	else \
		echo "up: $(COMPOSE_FILE) 없음 (후속 티켓 T02에서 추가). runtime-unverified (no docker/psql)."; \
	fi

down: ## 인프라 중지
	@if [ -f "$(COMPOSE_FILE)" ]; then \
		$(COMPOSE) -f "$(COMPOSE_FILE)" down; \
	else \
		echo "down: $(COMPOSE_FILE) 없음 (후속 티켓 T02에서 추가). runtime-unverified (no docker/psql)."; \
	fi
