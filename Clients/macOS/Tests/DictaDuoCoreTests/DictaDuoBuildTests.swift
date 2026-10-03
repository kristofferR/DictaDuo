import Foundation
import XCTest
@testable import DictaDuoCore

final class DictaDuoBuildTests: XCTestCase {
    func testReleaseUsesDictaDuoIdentityAndSeparatesDevelopmentState() {
        let release = DictaDuoBuild.release
        let development = DictaDuoBuild.development
        XCTAssertEqual(release.bundleIdentifier, "com.kristofferr.dictaduo")
        XCTAssertEqual(release.displayName, "DictaDuo")
        XCTAssertEqual(development.displayName, "DictaDuo Dev")
        XCTAssertNotEqual(release.bundleIdentifier, development.bundleIdentifier)
        XCTAssertNotEqual(release.dataDirectory, development.dataDirectory)
        XCTAssertNotEqual(release.credentialService, development.credentialService)
        XCTAssertNotEqual(release.windowAutosaveName, development.windowAutosaveName)
        XCTAssertEqual(release.credentialService, "com.kristofferr.dictaduo.server")
        XCTAssertEqual(development.credentialService, "com.kristofferr.dictaduo.dev.server")
        XCTAssertFalse(release.isDevelopment)
        XCTAssertTrue(development.isDevelopment)
    }

    func testDataDirectoryUsesCurrentAppName() {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertEqual(DictaDuoBuild.release.dataDirectory(in: support), support.appendingPathComponent("DictaDuo", isDirectory: true))
        XCTAssertEqual(DictaDuoBuild.development.dataDirectory(in: support), support.appendingPathComponent("DictaDuo Dev", isDirectory: true))
    }
}
