import Foundation
import SottoDuoCore
import XCTest

final class RemoteMicrophonePreferencesTests: XCTestCase {
    private let local = AudioInputDevice(uid: "receiver", name: "Mac", transport: .builtIn)
    private let remote = AudioInputDevice(uid: "receiver", name: "DJI", transport: .usb,
        remote: .init(server: "https://desktop:8391", hostID: "omarchy"))

    func testScopedIdentitiesPreserveLocalAndRemoteWithSameUIDAndName() throws {
        let secondHost = AudioInputDevice(uid: remote.uid, name: remote.name, transport: .usb,
            remote: .init(server: "https://desktop:8391", hostID: "other"))
        let secondServer = AudioInputDevice(uid: remote.uid, name: remote.name, transport: .usb,
            remote: .init(server: "https://other:8391", hostID: "omarchy"))
        let entries = [local, remote, secondHost, secondServer]
        let preferences = MicrophonePreferences(profiles: [.init(name: "Home", priority: entries)], selection: .fixed(remote))
        XCTAssertEqual(Set(entries.map(\.id)).count, 4)
        let configuration = SottoDuoConfiguration(microphones: preferences)
        let restored = try JSONDecoder().decode(SottoDuoConfiguration.self, from: JSONEncoder().encode(configuration))
        XCTAssertEqual(restored.microphones, preferences)
        XCTAssertEqual(restored.microphones.activeProfile.priority, entries)
    }

    func testNamesLeaveHostIDsOutOfDeviceNames() {
        XCTAssertEqual(remote.displayName, "DJI")
        XCTAssertEqual(remote.qualifiedName(host: "desk"), "DJI on desk")
        XCTAssertEqual(remote.qualifiedName(host: nil), "DJI on omarchy")
        let headset = AudioInputDevice(uid: "headset", name: "AirPods", transport: .bluetooth)
        XCTAssertEqual(headset.qualifiedName(host: "desk"), "AirPods · Bluetooth")
    }

    func testLegacyJSONRemainsLocalAndDoesNotChangeItsOrder() throws {
        let old = Data(#"{"microphones":{"profiles":[{"id":"home","name":"Home","priority":[{"uid":"usb","name":"Desk","transport":"usb"},{"uid":"builtin","name":"Mac","transport":"builtIn"}]}],"activeProfileID":"home","selection":{"mode":"systemDefault"}}}"#.utf8)
        let preferences = try JSONDecoder().decode(SottoDuoConfiguration.self, from: old).microphones
        XCTAssertEqual(preferences.activeProfile.priority.map(\.uid), ["usb", "builtin"])
        XCTAssertTrue(preferences.activeProfile.priority.allSatisfy { $0.remote == nil })
        XCTAssertEqual(preferences.selection, .systemDefault)
    }

    func testPriorityAndFixedRemoteWorkWithoutAnyLocalDeviceAndRecoverNextTake() {
        var preferences = MicrophonePreferences(profiles: [.init(name: "Home", priority: [remote, local])])
        func resolve(_ available: [AudioInputDevice]) -> AudioInputDevice? {
            MicrophoneSelectionPolicy.resolve(preferences: preferences, available: available, systemDefaultUID: local.uid).device
        }
        XCTAssertEqual(resolve([remote]), remote)
        XCTAssertEqual(resolve([local]), local)
        XCTAssertEqual(resolve([remote, local]), remote)
        preferences.selection = .fixed(remote)
        XCTAssertEqual(resolve([local]), local)
        XCTAssertEqual(resolve([remote]), remote)
        preferences.selection = .systemDefault
        XCTAssertNil(resolve([remote]), "Remote UID must never satisfy the Mac system-default UID")
        XCTAssertEqual(resolve([remote, local]), local)
        preferences = MicrophonePreferences()
        XCTAssertNil(resolve([remote]), "Discovery must not silently opt a user into a remote microphone")
    }
}
