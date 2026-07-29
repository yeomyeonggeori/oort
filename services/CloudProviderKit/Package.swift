// swift-tools-version: 6.0
// CloudProviderKit — ADR-0142 D2 T3 provider adapter contract.
//
// MomoServer (REST intents) and NotifierWorker (lifecycle reconciler) both call
// providers, and ADR-0142 forbids policy code from knowing a specific
// provider's constants. A single library target is the only place that can
// hold that boundary for both processes; duplicating the protocol per package
// (the T3LifecycleLock precedent) would let the two copies drift into two
// different contracts, which is exactly the failure this ADR removes.
//
// Depends on async-http-client only (same pinned tag as server/relay/workers).
import PackageDescription

let package = Package(
    name: "CloudProviderKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CloudProviderKit", targets: ["CloudProviderKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.34.0"),
    ],
    targets: [
        .target(
            name: "CloudProviderKit",
            dependencies: [
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "CloudProviderKitTests",
            dependencies: ["CloudProviderKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
