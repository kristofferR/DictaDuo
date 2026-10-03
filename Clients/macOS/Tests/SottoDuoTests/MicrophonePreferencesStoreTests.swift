import Combine
import Foundation
import SottoDuoCore
import SottoDuoAPI
import XCTest
@testable import SottoDuo

final class MicrophonePreferencesStoreTests: XCTestCase {
    private let builtIn = AudioInputDevice(uid: "builtin", name: "Mac microphone", transport: .builtIn)
    private let usb = AudioInputDevice(uid: "usb", name: "Desk microphone", transport: .usb)
    private let headset = AudioInputDevice(uid: "headset", name: "Headset", transport: .bluetooth)

    func testUnchangedDiscoveryDoesNotPublishButStatusChangesDo() async throws {
        try await withPreferences { store, _ in
            var source = AudioSource(identity: .init(hostID: "desk", id: "dji"), name: "DJI", transport: .usb,
                present: true, link: .connected, capture: .available, audioHealth: .unknown, observedAt: Date())
            store.updateRemote([source], server: "https://desktop:8391")
            var updates = 0
            let subscription = store.objectWillChange.sink { updates += 1 }
            defer { subscription.cancel() }
            source.observedAt = Date()
            store.updateRemote([source], server: "https://desktop:8391")
            XCTAssertEqual(updates, 0)
            source.link = .unknown
            source.observedAt = Date()
            store.updateRemote([source], server: "https://desktop:8391")
            XCTAssertEqual(updates, 1)
        }
    }

    func testRemoteStatusUsesLocalFallbackAndPersistsAcrossConfigurationReload() async throws {
        try await withPreferences { store, fixture in
            let host = "https://desktop:8391"
            var source = AudioSource(identity: .init(hostID: "desk", id: "usb"), name: "DJI", transport: .usb,
                present: true, link: .connected, capture: .available, audioHealth: .unknown, observedAt: Date())
            store.update(devices: [builtIn, usb], systemDefaultUID: builtIn.uid)
            store.updateRemote([source], server: host)
            let remote = try XCTUnwrap(store.availableDevices.first { $0.remote != nil })
            [remote, usb, builtIn].forEach(store.addToPriority)
            XCTAssertEqual(store.resolution.device, remote)
            source.link = .unknown
            source.observedAt = Date()
            store.updateRemote([source], server: host)
            XCTAssertEqual(store.resolution.device, usb, "A USB receiver with unknown TX status is not ready")
            XCTAssertTrue(store.availableDevices.contains(remote), "Unavailable sources remain configurable")
            source.link = .connected
            source.observedAt = Date()
            store.updateRemote([source], server: host)
            store.update(devices: [builtIn], systemDefaultUID: builtIn.uid)
            XCTAssertEqual(store.resolution.device, remote, "A local inventory refresh must not erase remote sources")
            source.observedAt = Date().addingTimeInterval(-4)
            store.updateRemote([source], server: host)
            XCTAssertEqual(store.resolution.device, builtIn)
            let restored = await fixture.restoredStore()
            XCTAssertEqual(restored.activeProfile.priority, [remote, usb, builtIn])
            source.observedAt = Date()
            restored.updateRemote([source], server: host)
            XCTAssertEqual(restored.resolution.device, remote, "Remote-only Macs need no local input")
            restored.updateRemote([source], server: "https://different-server:8391")
            XCTAssertNil(restored.resolution.device, "A new endpoint must not inherit the previous server's identity")
            restored.clearRemote()
            XCTAssertNil(restored.resolution.device)
        }
    }

    func testLocalFallbackSkipsOtherReadyRemoteInputs() async throws {
        try await withPreferences { store, _ in
            store.update(devices: [builtIn], systemDefaultUID: builtIn.uid)
            let sources = ["first", "second"].map { id in
                AudioSource(identity: .init(hostID: "desk", id: id), name: id, transport: .usb,
                    present: true, link: .connected, capture: .available, audioHealth: .unknown, observedAt: Date())
            }
            store.updateRemote(sources, server: "https://desktop:8391")
            let remote = store.availableDevices.filter { $0.remote != nil }
            remote.forEach(store.addToPriority)
            store.addToPriority(builtIn)
            XCTAssertEqual(store.resolution.device, remote.first)
            XCTAssertEqual(store.resolution(excluding: remote[0].id).device, remote[1])
            XCTAssertEqual(store.localFallback, builtIn)
            store.update(devices: [], systemDefaultUID: nil)
            XCTAssertNil(store.localFallback)
        }
    }

    func testSharedMicBusyWithAnotherComputerFallsThroughToNextInput() async throws {
        try await withPreferences { store, _ in
            let server = "https://desktop:8391"
            let sharing = SharingHost(name: "omarchy", local: false)
            var source = AudioSource(identity: .init(hostID: "omarchy-desktop", id: "dji"), name: "DJI Mic Mini", transport: .usb,
                present: true, link: .connected, capture: .available, audioHealth: .healthy, observedAt: Date(), shared: true)
            store.update(devices: [builtIn, usb], systemDefaultUID: builtIn.uid)
            store.updateRemote([source], server: server, host: sharing, deviceID: "this-mac")
            let remote = try XCTUnwrap(store.availableDevices.first { $0.remote != nil })
            [remote, usb].forEach(store.addToPriority)
            XCTAssertEqual(store.resolution.device, remote)

            source.recordingFor = .init(id: "this-mac", name: "Studio Mac")
            store.updateRemote([source], server: server, host: sharing, deviceID: "this-mac")
            XCTAssertEqual(store.resolution.device, remote, "This Mac's own finishing take does not make the mic busy")

            // The server records one take at a time, so every source reports the holder.
            source.recordingFor = .init(id: "linux", name: "Linux desk")
            var other = source
            other.identity.id = "headset"
            store.updateRemote([source, other], server: server, host: sharing, deviceID: "this-mac")
            let second = try XCTUnwrap(store.availableDevices.first { $0.uid == "headset" })
            store.addToPriority(second)
            store.movePriority(id: second.id, by: -1)
            XCTAssertEqual(store.resolution.device, usb)
            XCTAssertFalse(store.isEligible(second))
            XCTAssertEqual(store.availability(remote), "Busy · Linux desk is dictating")
            XCTAssertEqual(store.busyFor(remote)?.id, "linux")

            source.recordingFor = nil
            store.updateRemote([source], server: server, host: sharing, deviceID: "this-mac")
            XCTAssertEqual(store.resolution.device, remote)
        }
    }

    func testSharedMicNamesUseTheSharingComputerName() async throws {
        try await withPreferences { store, _ in
            let server = "https://desktop:8391"
            let source = AudioSource(identity: .init(hostID: "omarchy-desktop", id: "dji"), name: "DJI Mic Mini", transport: .usb,
                present: true, link: .connected, capture: .available, audioHealth: .healthy, observedAt: Date())
            store.updateRemote([source], server: server)
            let remote = try XCTUnwrap(store.availableDevices.first)
            XCTAssertEqual(store.qualifiedName(remote), "DJI Mic Mini on omarchy-desktop", "An older server names no host")
            store.updateRemote([source], server: server, host: .init(name: "omarchy", local: false))
            XCTAssertEqual(store.hostName(remote), "omarchy")
            XCTAssertEqual(store.qualifiedName(remote), "DJI Mic Mini on omarchy")
            store.clearRemote()
            XCTAssertEqual(store.qualifiedName(remote), "DJI Mic Mini on omarchy", "Offline favorites keep a readable name")
            XCTAssertNil(store.hostName(usb))
            XCTAssertEqual(store.qualifiedName(usb), "Desk microphone")
        }
    }

    func testPreferredDeviceReturnsWithoutLosingSavedOrder() async throws {
        try await withPreferences { store, fixture in
            store.update(devices: [builtIn, usb], systemDefaultUID: builtIn.uid)
            store.addToPriority(usb)
            store.addToPriority(builtIn)
            XCTAssertEqual(store.resolution.device, usb)
            store.update(devices: [builtIn], systemDefaultUID: builtIn.uid)
            XCTAssertEqual(store.resolution.device, builtIn)
            XCTAssertEqual(store.activeProfile.priority.map(\.uid), [usb.uid, builtIn.uid])

            let restored = await fixture.restoredStore()
            restored.update(devices: [builtIn, usb], systemDefaultUID: builtIn.uid)
            XCTAssertEqual(restored.resolution.device, usb)
            XCTAssertEqual(restored.activeProfile.priority, store.activeProfile.priority)
        }
    }

    func testDragMoveAndKeyboardMovePersistWithoutAffectingOtherProfiles() async throws {
        try await withPreferences { store, fixture in
            [builtIn, usb, headset].forEach(store.addToPriority)
            store.movePriority(fromOffsets: IndexSet(integer: 2), toOffset: 0)
            XCTAssertEqual(store.activeProfile.priority.map(\.uid), [headset.uid, builtIn.uid, usb.uid])
            store.movePriority(id: usb.id, by: -1)
            XCTAssertEqual(store.activeProfile.priority.map(\.uid), [headset.uid, usb.uid, builtIn.uid])
            let firstProfile = store.activeProfile

            try store.addProfile(named: "Travel").get()
            store.addToPriority(builtIn)
            store.addToPriority(headset)
            store.movePriority(fromOffsets: IndexSet(integer: 0), toOffset: 2)
            XCTAssertEqual(store.activeProfile.priority.map(\.uid), [headset.uid, builtIn.uid])

            let restored = await fixture.restoredStore()
            XCTAssertEqual(restored.activeProfile.name, "Travel")
            restored.selectProfile(firstProfile.id)
            XCTAssertEqual(restored.activeProfile, firstProfile)
        }
    }

    func testMultipleRowMovesUseListDestinationSemanticsAndIgnoreBadOffsets() async throws {
        try await withPreferences { store, _ in
            [builtIn, usb, headset].forEach(store.addToPriority)
            store.movePriority(fromOffsets: IndexSet([0, 2]), toOffset: 3)
            XCTAssertEqual(store.activeProfile.priority, [usb, builtIn, headset])
            let before = store.preferences
            store.movePriority(fromOffsets: IndexSet(integer: 20), toOffset: 0)
            store.movePriority(fromOffsets: IndexSet(integer: 0), toOffset: 20)
            store.movePriority(id: usb.id, by: -1)
            XCTAssertEqual(store.preferences, before)
        }
    }

    func testFixedSelectionStaysSelectedDuringFallbackAndDeviceRename() async throws {
        try await withPreferences { store, fixture in
            store.select(.fixed(usb))
            store.update(devices: [builtIn], systemDefaultUID: builtIn.uid)
            XCTAssertEqual(store.preferences.selection, .fixed(usb))
            XCTAssertEqual(store.resolution.device, builtIn)

            let renamed = AudioInputDevice(uid: usb.uid, name: "USB studio mic", transport: .usb)
            store.update(devices: [builtIn, renamed], systemDefaultUID: builtIn.uid)
            XCTAssertEqual(store.resolution.device, renamed)
            let restored = await fixture.restoredStore()
            XCTAssertEqual(restored.preferences.selection, .fixed(renamed))
            store.select(.systemDefault)
            XCTAssertEqual(store.resolution.device, builtIn)
        }
    }

    func testProfileEditsRejectAmbiguityAndPreserveAtLeastOneList() async throws {
        try await withPreferences { store, _ in
            let firstID = store.activeProfile.id
            XCTAssertThrowsError(try store.addProfile(named: " ").get())
            XCTAssertThrowsError(try store.addProfile(named: "default").get())
            XCTAssertThrowsError(try store.removeProfile(firstID).get())
            try store.addProfile(named: "Travel").get()
            let travelID = store.activeProfile.id
            try store.renameProfile(travelID, to: "  On the go  ").get()
            XCTAssertEqual(store.activeProfile.name, "On the go")
            XCTAssertThrowsError(try store.renameProfile(travelID, to: "Default").get())
            try store.removeProfile(travelID).get()
            XCTAssertEqual(store.activeProfile.id, firstID)
        }
    }

    func testExternalMicrophoneConfigurationUpdatesSelectionWithoutWritingBack() async throws {
        try await withPreferences { store, fixture in
            store.update(devices: [builtIn, usb], systemDefaultUID: builtIn.uid)
            var external = fixture.configuration.configuration
            external.microphones = MicrophonePreferences(
                profiles: [MicrophoneProfile(id: "desk", name: "Desk", priority: [usb, builtIn])],
                activeProfileID: "desk", selection: .fixed(usb)
            )
            external.holdKey = "fn"
            let bytes = try JSONEncoder().encode(external)
            try bytes.write(to: fixture.file.url, options: .atomic)
            await fixture.configuration.reload()

            XCTAssertEqual(store.preferences, external.microphones)
            XCTAssertEqual(store.resolution.device, usb)
            await fixture.configuration.flush()
            XCTAssertEqual(try Data(contentsOf: fixture.file.url), bytes, "Applying external values must not write them back")

            store.select(.automatic)
            await fixture.configuration.flush()
            let saved = try await fixture.file.read().get()
            XCTAssertEqual(saved.microphones.selection, .automatic)
            XCTAssertEqual(saved.microphones.activeProfile.priority, [usb, builtIn])
            XCTAssertEqual(saved.holdKey, "fn")
        }
    }

    func testInvalidExternalConfigurationKeepsLastSelectionAndShowsStorageErrorUntilRepair() async throws {
        try await withPreferences { store, fixture in
            store.select(.fixed(usb))
            await fixture.configuration.flush()
            let valid = fixture.configuration.configuration
            try Data("not JSON".utf8).write(to: fixture.file.url, options: .atomic)
            await fixture.configuration.reload()
            XCTAssertEqual(store.preferences.selection, .fixed(usb))
            XCTAssertNotNil(store.storageError)

            try JSONEncoder().encode(valid).write(to: fixture.file.url, options: .atomic)
            await fixture.configuration.reload()
            XCTAssertEqual(store.preferences.selection, .fixed(usb))
            XCTAssertNil(store.storageError)
        }
    }

    @MainActor
    private func withPreferences(_ operation: @MainActor (MicrophonePreferencesStore, MicrophoneConfigurationFixture) async throws -> Void) async throws {
        let suite = "SottoDuoMicrophoneTests.\(UUID().uuidString)"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer {
            try? FileManager.default.removeItem(at: root)
        }
        let file = ConfigurationFile(url: root.appendingPathComponent("config.json"))
        let configuration = ConfigurationStore(file: file)
        await configuration.start()
        configuration.stopWatching()
        let fixture = MicrophoneConfigurationFixture(configuration: configuration, file: file)
        do { try await operation(MicrophonePreferencesStore(configuration: configuration), fixture) }
        catch { await fixture.flush(); throw error }
        await fixture.flush()
    }
}

@MainActor
private final class MicrophoneConfigurationFixture {
    let configuration: ConfigurationStore
    let file: ConfigurationFile
    private var restoredConfigurations: [ConfigurationStore] = []

    init(configuration: ConfigurationStore, file: ConfigurationFile) {
        self.configuration = configuration
        self.file = file
    }

    func restoredStore() async -> MicrophonePreferencesStore {
        await flush()
        let restored = ConfigurationStore(file: file)
        await restored.start()
        restored.stopWatching()
        restoredConfigurations.append(restored)
        return MicrophonePreferencesStore(configuration: restored)
    }

    func flush() async {
        await configuration.flush()
        for restored in restoredConfigurations { await restored.flush() }
    }
}
