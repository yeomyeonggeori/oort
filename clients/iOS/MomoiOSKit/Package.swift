// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MomoiOSKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "MomoiOSKit", targets: ["MomoiOSKit"]),
    ],
    dependencies: [
        .package(path: "../../Core"),
        .package(url: "https://github.com/centrifugal/centrifuge-swift.git", exact: "0.9.0"),
    ],
    targets: [
        .target(
            name: "MomoiOSKit",
            dependencies: [
                .product(name: "MomoCore", package: "Core"),
                .product(name: "SwiftCentrifuge", package: "centrifuge-swift"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "MomoiOSKitTests",
            dependencies: ["MomoiOSKit", .product(name: "MomoCore", package: "Core")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
