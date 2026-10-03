// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "DictaDuoTextEngine",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "dictaduo-text-engine", targets: ["DictaDuoTextEngine"])],
    dependencies: [
        .package(name: "DictaDuo", path: ".."),
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.31.4"),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.31.4"),
        .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.3.0"),
    ],
    targets: [
        .executableTarget(
            name: "DictaDuoTextEngine",
            dependencies: [
                .product(name: "DictaDuoCore", package: "DictaDuo"),
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "Tokenizers", package: "swift-transformers"),
                .product(name: "Hub", package: "swift-transformers"),
            ]
        ),
    ]
)
