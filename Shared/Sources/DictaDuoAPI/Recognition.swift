import Foundation

public enum RecognitionMode: String, Codable, CaseIterable, Sendable {
    case automatic, cloud, local
}

/// The server's local speech model.
public enum RecognitionEngine: String, Codable, CaseIterable, Sendable {
    /// Whisper large-v3-turbo: Whisper's languages and recognition vocabulary hints.
    case whisper
    /// Parakeet TDT 0.6B v3: faster; detects 25 European languages itself; no vocabulary hints.
    case parakeet
}

public struct RecognitionState: Codable, Equatable, Sendable {
    public enum Provider: String, Codable, Sendable { case soniox, whisper }
    public var provider: Provider
    public var fallbackReason: String?
    public var partialText: String?
    public init(provider: Provider, fallbackReason: String? = nil, partialText: String? = nil) {
        self.provider = provider
        self.fallbackReason = fallbackReason
        self.partialText = partialText
    }
}
