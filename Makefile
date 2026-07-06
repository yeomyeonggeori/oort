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
ENV_FILE       ?= $(firstword $(wildcard .env.worktree .env infra/.env.example))
COMPOSE_ENV    := $(if $(ENV_FILE),--env-file $(ENV_FILE),)

# ---------------------------------------------------------------------------
# SWIFT_SCRATCH_ROOT (opt-in, MOMO-317) — worktree 간 공유 Swift 빌드 캐시.
#
# 환경변수 SWIFT_SCRATCH_ROOT가 설정돼 있으면 build/test가 패키지별
# `--scratch-path "$SWIFT_SCRATCH_ROOT/<pkg>"`로 .build를 공유한다(worktree들이
# 같은 캐시를 재사용 → N개 worktree 초기 빌드 비용 1/N). 미설정이면 패키지 로컬
# .build로 기존 동작 그대로 — 순수 opt-in(맨 `make build`는 회귀 없음).
# `.conductor/setup.sh`가 이 변수를 .env.worktree에 기록하므로, 공유 캐시를 켜려면
# `set -a; . .env.worktree; set +a; make build`처럼 env를 로드한 뒤 호출한다.
#
# 동시 빌드 오염 방지: macOS엔 flock이 없어 패키지별 mkdir 기반 lock 디렉터리를
# 쓴다. 잠겨 있으면 SWIFT_SCRATCH_LOCK_WAIT초(기본 300)까지 2초 간격으로 대기하고,
# 그래도 안 풀리면 패키지 로컬 .build로 폴백한다(교착 없이 항상 진행).
# trap으로 중단(EXIT/INT/TERM) 시 lock을 해제한다. macOS /bin/sh(bash 3.2 POSIX) 호환.
# 사용법: momo_swift <pkg> <build|test> [extra swift args...]
# ---------------------------------------------------------------------------
SWIFT_RUN_FUNC = momo_swift() { \
  _pkg="$$1"; _sub="$$2"; shift 2; \
  if [ -z "$${SWIFT_SCRATCH_ROOT:-}" ]; then \
    ( cd "$$_pkg" && swift "$$_sub" "$$@" ); return $$?; \
  fi; \
  _key=`printf '%s' "$$_pkg" | tr '/ ' '--'`; \
  _scratch="$$SWIFT_SCRATCH_ROOT/$$_key"; \
  _lock="$$SWIFT_SCRATCH_ROOT/$$_key.lock"; \
  mkdir -p "$$SWIFT_SCRATCH_ROOT"; \
  _held=0; _deadline=$$(( $$(date +%s) + $${SWIFT_SCRATCH_LOCK_WAIT:-300} )); \
  while : ; do \
    if mkdir "$$_lock" 2>/dev/null; then _held=1; break; fi; \
    if [ "$$(date +%s)" -ge "$$_deadline" ]; then break; fi; \
    echo "   ($$_pkg) shared build cache busy; waiting on $$_lock"; \
    sleep 2; \
  done; \
  if [ "$$_held" = 1 ]; then \
    trap 'rmdir "$$_lock" 2>/dev/null || true' EXIT INT TERM; \
    ( cd "$$_pkg" && swift "$$_sub" --scratch-path "$$_scratch" "$$@" ); _rc=$$?; \
    rmdir "$$_lock" 2>/dev/null || true; trap - EXIT INT TERM; \
    return $$_rc; \
  fi; \
  echo "   ($$_pkg) shared build cache lock busy > $${SWIFT_SCRATCH_LOCK_WAIT:-300}s; using package-local .build"; \
  ( cd "$$_pkg" && swift "$$_sub" "$$@" ); \
}

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
	@$(SWIFT_RUN_FUNC); \
	found=0; \
	for pkg in $(SWIFT_PKGS); do \
		if [ -f "$$pkg/Package.swift" ]; then \
			found=1; \
			echo "==> swift build ($$pkg)"; \
			momo_swift "$$pkg" build || exit 1; \
		fi; \
	done; \
	if [ "$$found" = "0" ]; then \
		echo "build: 아직 Package.swift가 없습니다 (후속 티켓 T04/T05/T06/T07/T09에서 추가)."; \
	fi

test: ## 모든 Swift 패키지 테스트 (Package.swift 존재하는 것만)
	@$(SWIFT_RUN_FUNC); \
	found=0; \
	for pkg in $(SWIFT_PKGS); do \
		if [ -f "$$pkg/Package.swift" ]; then \
			found=1; \
			echo "==> swift test ($$pkg)"; \
			momo_swift "$$pkg" test || exit 1; \
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
		$(COMPOSE) $(COMPOSE_ENV) -f "$(COMPOSE_FILE)" up -d --wait; \
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
