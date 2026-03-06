// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HyberTextBrowser",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "HyberTextBrowser",
            path: "Sources/HyberTextBrowser"
        )
    ]
)
