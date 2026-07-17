// swift-tools-version: 6.0
// PushRelay — Dawn-operated, open-source APNs boundary (ADR-0120 P-3).
import PackageDescription

let package = Package(
    name: "PushRelay",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "PushRelay", targets: ["PushRelay"]),
    ],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.25.0"),
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.34.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
        .package(url: "https://github.com/apple/swift-http-types.git", from: "1.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "PushRelay",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "PushRelayTests",
            dependencies: ["PushRelay"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
