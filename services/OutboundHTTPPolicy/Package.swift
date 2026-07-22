// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OutboundHTTPPolicy",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "OutboundHTTPPolicy", targets: ["OutboundHTTPPolicy"]),
    ],
    targets: [
        .target(
            name: "OutboundHTTPPolicy",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "OutboundHTTPPolicyTests",
            dependencies: ["OutboundHTTPPolicy"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
