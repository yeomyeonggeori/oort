// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WorkHostDaemon",
    platforms: [.macOS(.v14)],
    products: [
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
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "Logging", package: "swift-log"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "WorkHostDaemonTests",
            dependencies: ["WorkHostDaemon", .product(name: "Crypto", package: "swift-crypto")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
