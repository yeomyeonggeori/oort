// swift-tools-version: 6.0
// MomoMac — macOS client package for momo (L4 spec §0.1 "macOS 우선", §9.3).
//
// Three products:
//   - MomoMac (library)      : SwiftUI views + ViewModel built on MomoCore
//                              (ChatBackend / AgentTransport contracts, L4 §5.3 / §6.1).
//                              This is the demo surface for v0 targets D / B / C
//                              (Live Tool-Call, Cost Breathing, Approval Inbox).
//   - MomoMacSmoke (exe)     : a tiny smoke executable that imports MomoCore +
//                              MomoMac and prints model values, used to prove the
//                              library compiles & links under `swift build`.
//   - MomoMacDevApp (exe)    : a SwiftPM development app that opens a real SwiftUI
//                              macOS window hosting MomoMacRootView.
//
// The release-oriented thin host app lives beside this package at
// `MomoMac.xcodeproj`. It imports the local SwiftPM products `MomoMac` and
// `MomoCore`; this package remains the source of the shared SwiftUI surface and
// the SwiftPM-only development app.
//
// Stack reality: built/verified with local Swift 6.2.3 toolchain. SwiftCentrifuge
// is linked by the library target for live Centrifugo subscription in REST dev mode;
// the in-memory demo path remains runtime-independent.
import PackageDescription

let package = Package(
    name: "MomoMac",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "MomoMac", targets: ["MomoMac"]),
        .executable(name: "MomoMacSmoke", targets: ["MomoMacSmoke"]),
        .executable(name: "MomoMacDevApp", targets: ["MomoMacDevApp"]),
    ],
    dependencies: [
        // Local path dependency on the shared client core (sibling dir).
        .package(name: "MomoCore", path: "../Core"),
        .package(url: "https://github.com/centrifugal/centrifuge-swift.git", exact: "0.9.0"),
        // Test-only: deterministic light/dark image snapshots of the SwiftUI surface
        // (MOMO-318). MIT-licensed; only the `SnapshotTesting` product is imported,
        // whose target has no transitive build dependencies (swift-syntax is pulled by
        // the unused InlineSnapshotTesting target only, so `swift build` stays cheap).
        .package(url: "https://github.com/pointfreeco/swift-snapshot-testing.git", from: "1.19.2"),
    ],
    targets: [
        .target(
            name: "MomoMac",
            dependencies: [
                .product(name: "MomoCore", package: "MomoCore"),
                .product(name: "SwiftCentrifuge", package: "centrifuge-swift"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .executableTarget(
            name: "MomoMacSmoke",
            dependencies: [
                "MomoMac",
                .product(name: "MomoCore", package: "MomoCore"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .executableTarget(
            name: "MomoMacDevApp",
            dependencies: [
                "MomoMac",
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "MomoMacTests",
            dependencies: [
                "MomoMac",
                .product(name: "SnapshotTesting", package: "swift-snapshot-testing"),
            ],
            exclude: ["__Snapshots__"]
        ),
    ]
)
