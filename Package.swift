// swift-tools-version: 5.10
import PackageDescription

var products: [Product] = [
    .library(name: "DictaDuoAPI", targets: ["DictaDuoAPI"]),
    .executable(name: "dictaduo-server", targets: ["DictaDuoServer"]),
]
var targets: [Target] = [
    .target(name: "DictaDuoDomain", path: "Shared/Sources/DictaDuoDomain"),
    .target(name: "DictaDuoAPIWire", dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"), .product(name: "HTTPTypes", package: "swift-http-types")], path: "Shared/Sources/DictaDuoAPIWire"),
    .target(name: "DictaDuoAPI", dependencies: ["DictaDuoDomain", "DictaDuoAPIWire"], path: "Shared/Sources/DictaDuoAPI"),
    .target(name: "DictaDuoServerKit", dependencies: ["DictaDuoAPI", "DictaDuoDomain", .product(name: "Hummingbird", package: "hummingbird"), .product(name: "Crypto", package: "swift-crypto")], path: "Server/Swift/Sources/DictaDuoServerKit"),
    .executableTarget(name: "DictaDuoServer", dependencies: ["DictaDuoServerKit"], path: "Server/Swift/Sources/DictaDuoServer"),
    .testTarget(name: "DictaDuoDomainTests", dependencies: ["DictaDuoDomain"], path: "Shared/Tests/DictaDuoDomainTests"),
    .testTarget(name: "DictaDuoAPITests", dependencies: ["DictaDuoAPI", "DictaDuoAPIWire"], path: "Shared/Tests/DictaDuoAPITests"),
    .testTarget(name: "DictaDuoServerTests", dependencies: ["DictaDuoServerKit", .product(name: "HummingbirdTesting", package: "hummingbird"), .product(name: "Crypto", package: "swift-crypto")], path: "Server/Swift/Tests/DictaDuoServerTests"),
]

#if os(macOS)
products += [
    .executable(name: "DictaDuo", targets: ["DictaDuo"]),
    .library(name: "DictaDuoCore", targets: ["DictaDuoCore"]),
]
targets += [
    .target(name: "DictaDuoCore", dependencies: ["DictaDuoDomain"], path: "Clients/macOS/Sources/DictaDuoCore"),
    .executableTarget(name: "DictaDuo", dependencies: ["DictaDuoCore", "DictaDuoAPI"], path: "Clients/macOS/Sources/DictaDuo"),
    .testTarget(name: "DictaDuoCoreTests", dependencies: ["DictaDuoCore"], path: "Clients/macOS/Tests/DictaDuoCoreTests"),
    .testTarget(name: "DictaDuoTests", dependencies: ["DictaDuo"], path: "Clients/macOS/Tests/DictaDuoTests"),
]
#endif

let package = Package(
    name: "DictaDuo",
    platforms: [.macOS(.v14)],
    products: products,
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.0.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "4.0.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime.git", exact: "1.11.0"),
        .package(url: "https://github.com/apple/swift-http-types.git", from: "1.0.0"),
    ],
    targets: targets,
    swiftLanguageVersions: [.v5]
)
