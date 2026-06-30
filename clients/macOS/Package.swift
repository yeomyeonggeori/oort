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
// The distributable .app bundle (Info.plist + Xcode project / AsyncHTTPClient
// transport implementation) is intentionally a FOLLOW-UP ticket
// (see STATUS notes in README of this dir / build ticket T09). Here the hard
// requirement is: the SwiftUI library and development app compile via `swift build`,
// with a LiveChatBackend stub wiring the MomoCore contracts so the views render
// against real model types.
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
            dependencies: ["MomoMac"]
        ),
    ]
)
