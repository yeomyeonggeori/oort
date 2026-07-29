// swift-tools-version: 6.0
// NotifierWorker — push notification judgment + dispatch worker (MOMO-404,
// ADR-0120 P-2). Claims `outbox` rows with kind='push_candidate' (SELECT ...
// FOR UPDATE SKIP LOCKED, OutboxRelay pattern), decides WHO gets notified
// (v0: every DM message + server-recomputed mentions + approval requests —
// the ONLY place judgment lives, ux-bible P9), records idempotent dispatches
// in `push_dispatch_log`, and POSTs an id-only payload (ADR-0120 D2: no
// message body, no display names) to the push relay (mock in e2e; Dawn
// PushRelay in P-3).
//
// Stack pinned to the same stable tags relay/OutboxRelay uses:
//   - postgres-nio 1.33.0  (Apache-2.0)  — PostgresClient pool + LISTEN/NOTIFY
//   - async-http-client 1.34.0           — POST push relay dispatch
//   - swift-service-lifecycle 2.6.0      — supervised pool + graceful shutdown
//   - swift-log 1.x                      — structured logging
//
// Runtime gate: scripts/verify_push_notifier.sh (isolated e2e compose).
import PackageDescription

let package = Package(
    name: "NotifierWorker",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "NotifierWorker", targets: ["NotifierWorker"]),
    ],
    dependencies: [
        // ADR-0142 D2: same T3 provider adapter contract MomoServer compiles
        // against — the reconciler must not own a second copy of it.
        .package(path: "../../services/CloudProviderKit"),
        .package(url: "https://github.com/vapor/postgres-nio.git", from: "1.33.0"),
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.34.0"),
        .package(url: "https://github.com/swift-server/swift-service-lifecycle.git", from: "2.6.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "NotifierWorker",
            dependencies: [
                .product(name: "CloudProviderKit", package: "CloudProviderKit"),
                .product(name: "PostgresNIO", package: "postgres-nio"),
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
                .product(name: "ServiceLifecycle", package: "swift-service-lifecycle"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Crypto", package: "swift-crypto"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "NotifierWorkerTests",
            dependencies: ["NotifierWorker"],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
