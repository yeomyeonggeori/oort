// swift-tools-version: 6.0
// OutboxRelay — durable SoT→Centrifugo relay (SwiftPM executable).
// L4 spec §1.1 / §8.1: claims pending `outbox` rows (kind='broadcast') with
// SELECT ... FOR UPDATE SKIP LOCKED, POSTs Centrifugo /api/publish
// (version=seq, idempotency_key), then marks status='done'. Connects as a
// BYPASSRLS role so it polls across all tenants (L4 §2.2 / §10.1).
//
// Stack (L4 §0.3, pinned to the same stable tags the server package uses):
//   - postgres-nio 1.33.0  (Apache-2.0)  — PostgresClient pool + LISTEN/NOTIFY
//   - async-http-client 1.34.0           — POST /api/publish (X-API-Key)
//   - swift-service-lifecycle 2.6.0      — supervised pool + graceful shutdown
//   - swift-log 1.x                      — structured logging (run/outbox ids)
//
// Runtime needs PostgreSQL 18 + Centrifugo v6 (NOT running in this build env) →
// see `runtime-unverified` notes in source. `swift build` is the gate here.
import PackageDescription

let package = Package(
    name: "OutboxRelay",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "OutboxRelay", targets: ["OutboxRelay"]),
    ],
    dependencies: [
        .package(url: "https://github.com/vapor/postgres-nio.git", from: "1.33.0"),
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.34.0"),
        .package(url: "https://github.com/swift-server/swift-service-lifecycle.git", from: "2.6.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "OutboxRelay",
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
            name: "OutboxRelayTests",
            dependencies: ["OutboxRelay"],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
