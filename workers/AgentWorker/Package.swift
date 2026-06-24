// swift-tools-version: 6.0
// AgentWorker — agent_job consumer + hermes (OpenAI-compatible) adapter (SwiftPM executable).
// L4 spec §3.5 / §6.1 / §6.2 / §8.5:
//   - claims pending `outbox` rows (kind='agent_job') with FOR UPDATE SKIP LOCKED,
//     partition_key = agent_member_id (per-agent serialization);
//   - opens the §3.3 loop-safety gates (per-agent semaphore / consecutive-auto /
//     step cap / hop depth) — stubbed with default-value constants;
//   - calls hermes POST /v1/chat/completions (stream=true) and parses the
//     `chat.completion.chunk` SSE stream (text deltas + tool_calls), with a
//     non-stream fallback (§6.3);
//   - publishes SSE deltas as `message` PATCH events (streaming mimic) +
//     `agent.status` (queued/thinking/streaming/done/error) to Centrifugo;
//   - records reserve/reconcile cost ledger stubs (§8.5).
// Connects as the BYPASSRLS `momo_relay` role so it polls across all tenants
// (L4 §2.2 / §10.1) — same role family the relay uses.
//
// Stack (L4 §0.3, pinned to the same stable tags the server/relay packages use):
//   - postgres-nio 1.33.0  (Apache-2.0)  — PostgresClient pool + SKIP LOCKED claim
//   - async-http-client 1.34.0           — hermes /v1/chat/completions (SSE) + Centrifugo /api/publish
//   - swift-service-lifecycle 2.6.0      — supervised pool + graceful shutdown
//   - swift-log 1.x                      — structured logging (run/job ids)
//
// Runtime needs PostgreSQL 18 + Centrifugo v6 + hermes gateway (NONE running in
// this build env) → see `runtime-unverified` notes in source. `swift build` is
// the verification gate for this package.
import PackageDescription

let package = Package(
    name: "AgentWorker",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "AgentWorker", targets: ["AgentWorker"]),
    ],
    dependencies: [
        .package(url: "https://github.com/vapor/postgres-nio.git", from: "1.33.0"),
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.34.0"),
        .package(url: "https://github.com/swift-server/swift-service-lifecycle.git", from: "2.6.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "AgentWorker",
            dependencies: [
                .product(name: "PostgresNIO", package: "postgres-nio"),
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
                .product(name: "ServiceLifecycle", package: "swift-service-lifecycle"),
                .product(name: "Logging", package: "swift-log"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "AgentWorkerTests",
            dependencies: ["AgentWorker"],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
