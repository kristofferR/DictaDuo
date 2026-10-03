import Foundation

/// Bundle metadata is the single source of truth for app and storage identity.
public enum DictaDuoBuild: Equatable, Sendable {
    case release, development

    // Unbundled Swift runs stay isolated from the installed app's preferences.
    public static let current: Self = Bundle.main.object(forInfoDictionaryKey: "DictaDuoDevelopmentBuild") as? Bool == false
        ? .release : .development

    public var displayName: String { self == .development ? "DictaDuo Dev" : "DictaDuo" }
    public var isDevelopment: Bool { self == .development }
    public var bundleIdentifier: String {
        self == .development ? "com.kristofferr.dictaduo.dev" : "com.kristofferr.dictaduo"
    }
    public var credentialService: String { bundleIdentifier + ".server" }
    public var windowAutosaveName: String { self == .development ? "DictaDuoDevMainWindow" : "DictaDuoMainWindow" }
    public var dataDirectory: URL {
        dataDirectory(in: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
    }
    func dataDirectory(in support: URL) -> URL {
        support.appendingPathComponent(displayName, isDirectory: true)
    }
}
