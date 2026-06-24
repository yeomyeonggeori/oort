// swift-tools-version: 6.0
// MomoCore — shared Swift core for momo clients (macOS + iOS).
// Pure Foundation: Codable domain models + ChatBackend / AgentTransport contracts.
// Per L4 spec §0.1 (shared Swift core) and §5.3 / §6.1 (client contracts).
//
// This package intentionally has NO external dependencies. The realtime/transport
// implementations (SwiftCentrifuge, AsyncHTTPClient, etc.) live in the platform
// apps that depend on MomoCore; the core only defines the contracts + wire models
// so it compiles fast and stays portable across macOS/iOS.
import PackageDescription

let package = Package(
    name: "MomoCore",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "MomoCore", targets: ["MomoCore"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "MomoCore",
            dependencies: [],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "MomoCoreTests",
            dependencies: ["MomoCore"]
        ),
    ]
)
