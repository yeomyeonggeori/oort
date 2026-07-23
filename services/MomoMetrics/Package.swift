// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MomoMetrics",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MomoMetrics", targets: ["MomoMetrics"]),
    ],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.25.0"),
        .package(url: "https://github.com/apple/swift-http-types.git", from: "1.0.0"),
        .package(url: "https://github.com/swift-server/swift-service-lifecycle.git", from: "2.6.0"),
    ],
    targets: [
        .target(
            name: "MomoMetrics",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "ServiceLifecycle", package: "swift-service-lifecycle"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "MomoMetricsTests",
            dependencies: ["MomoMetrics"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
