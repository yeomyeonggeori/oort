// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WorkHostDaemon",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MomoACPHost", targets: ["MomoACPHost"]),
        .executable(name: "momo-workd", targets: ["WorkHostDaemon"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "WorkHostDaemon",
            dependencies: [
                "MomoACPHost",
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "Logging", package: "swift-log"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "MomoACPHost",
            dependencies: ["CMomoPTY"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // C shim exposing POSIX PTY calls the Swift Glibc overlay omits (Linux
        // container portability for ACP terminal/* — MOMO-579 / WH-1).
        .target(name: "CMomoPTY"),
        .testTarget(
            name: "WorkHostDaemonTests",
            dependencies: [
                "WorkHostDaemon",
                "MomoACPHost",
                .product(name: "Crypto", package: "swift-crypto"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
