// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LinkShort",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "LinkShort", targets: ["LinkShort"]),
    ],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.25.0"),
    ],
    targets: [
        .executableTarget(
            name: "LinkShort",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "LinkShortTests",
            dependencies: ["LinkShort"],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
