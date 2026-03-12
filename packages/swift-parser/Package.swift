// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "swift-parser",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-syntax.git", exact: "600.0.1"),
    ],
    targets: [
        .executableTarget(
            name: "swift-parser",
            dependencies: [
                .product(name: "SwiftSyntax", package: "swift-syntax"),
                .product(name: "SwiftParser", package: "swift-syntax"),
            ],
            path: "Sources/SwiftParser"
        ),
    ]
)
