// swift-tools-version: 6.0
// MomoServer — Hummingbird 2 API server (SwiftPM executable).
// L4 spec §1.1 / §5 / §9.3: stateless REST API + JWT issue + Centrifugo publish/subscribe-proxy.
//
// Stack (L4 §0.3, pinned to current stable tags):
//   - Hummingbird 2.25.0   (Apache-2.0)  — HTTP/router/async
//   - postgres-nio 1.33.0  (Apache-2.0)  — PostgresClient pool, SoT access
//   - jwt-kit 5.2.0 exact  (Apache-2.0)  — HS256 app JWT issue/verify; CI Swift 6.1 compatibility
//   - async-http-client 1.34.0           — CentrifugoClient (POST /api/publish)
//
// Runtime needs PostgreSQL 18 + Centrifugo v6 (NOT running in this build env) →
// see `runtime-unverified` notes in source. `swift build` must stay green.
import PackageDescription

let package = Package(
    name: "MomoServer",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "MomoServer", targets: ["MomoServer"]),
    ],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.25.0"),
        .package(url: "https://github.com/vapor/postgres-nio.git", from: "1.33.0"),
        .package(url: "https://github.com/vapor/jwt-kit.git", exact: "5.2.0"),
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.34.0"),
        .package(url: "https://github.com/swift-server/swift-service-lifecycle.git", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "MomoServer",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "PostgresNIO", package: "postgres-nio"),
                .product(name: "JWTKit", package: "jwt-kit"),
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
                .product(name: "ServiceLifecycle", package: "swift-service-lifecycle"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "MomoServerTests",
            dependencies: ["MomoServer"],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
