// swift-tools-version: 6.0
import PackageDescription

// The generated client for the backend's `openapi.json`. The repo-root file is
// symlinked into the target and the generator plugin runs at build time, so
// nothing generated is ever checked in: change the API, regenerate
// `openapi.json`, rebuild.
let package = Package(
    name: "ChatAPI",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ChatAPI", targets: ["ChatAPI"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.6.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.1.0"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.3.0"),
    ],
    targets: [
        .target(
            name: "ChatAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            // The generator's output isn't ours to fix, so its (import-access)
            // warnings stay out of the build log.
            swiftSettings: [.unsafeFlags(["-suppress-warnings"])],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
    ]
)
