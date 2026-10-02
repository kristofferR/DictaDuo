import AppKit
import Foundation
import SottoDuoAPI
import SottoDuoCore
import XCTest
@testable import SottoDuo

@MainActor
final class RemoteCaptureTests: XCTestCase {
    func testRemoteTakeOutlastsTheFormerThreeMinuteLimit() async throws {
        guard ProcessInfo.processInfo.environment["SOTTODUO_CAPTURE_LONG_TEST"] == "1" else {
            throw XCTSkip("Set SOTTODUO_CAPTURE_LONG_TEST=1 to record past the former three-minute limit.")
        }
        try await withController(sources: ["ready"]) { controller, client in
            controller.toggleTestRecording()
            try await until { controller.isRecording }
            try await Task.sleep(for: .seconds(190))
            XCTAssertTrue(controller.isRecording, controller.errorMessage ?? "")
            controller.toggleTestRecording()
            try await until { controller.activity == .success || controller.activity == .failed }
            XCTAssertEqual(controller.activity, .success, controller.errorMessage ?? "")
            let takes = try await takes(client, controller)
            XCTAssertEqual(takes.first?.capture?.state, .sealed)
        }
    }

    func testRemoteOnlyMacNeedsNoMicrophonePermissionAndRenewsLeaseThroughDrain() async throws {
        try await withController(sources: ["ready"]) { controller, client in
            XCTAssertFalse(controller.permissions.microphone)
            XCTAssertTrue(controller.canTest)
            let clipboardCount = NSPasteboard.general.changeCount
            controller.toggleTestRecording()
            try await until { controller.isRecording }
            XCTAssertTrue(controller.recordingInputName?.contains("capture-fixture") == true)
            try await until { controller.liveTranscript == "Remote preview." }
            try await until { controller.recordingFeedback.levels.contains { $0 > 0 } }
            try await Task.sleep(for: .seconds(6.2))
            XCTAssertTrue(controller.isRecording, "The six-second lease must be renewed")
            controller.toggleTestRecording()
            try await until { controller.activity == .success }
            XCTAssertEqual(controller.lastDeliveryStatus, .tested)
            XCTAssertEqual(controller.lastTranscript, "Remote transcript.")
            XCTAssertEqual(NSPasteboard.general.changeCount, clipboardCount, "Mic tests must never paste or copy")
            let first = try await takes(client, controller).first
            let take = try XCTUnwrap(first)
            XCTAssertEqual(take.capture?.state, .sealed)
            XCTAssertEqual(take.mode, .test)
            let detail = try await client.recordingDetail(take.id)
            XCTAssertEqual(detail.result?.delivery?.status, "tested")
        }
    }

    func testPreReadyRejectionDiscardsItsAdmissionWithoutSwitchingRemotes() async throws {
        // Fallback after a pre-ready rejection is local only; there is no local input here.
        try await withController(sources: ["reject", "ready"]) { controller, client in
            let order = controller.microphones.preferences
            controller.toggleTestRecording()
            try await until { controller.activity == .failed }
            XCTAssertTrue(controller.errorMessage?.contains("could not start recording") == true, controller.errorMessage ?? "")
            XCTAssertEqual(controller.microphones.preferences, order)
            let takes = try await takes(client, controller)
            XCTAssertEqual(takes.map(\.capture?.source.id), ["reject"])
            XCTAssertEqual(takes.first?.captureState, .discarded)
        }
    }

    func testRemoteStartupAllowsServerReadinessBudget() async throws {
        try await withController(sources: ["slow"]) { controller, _ in
            controller.toggleTestRecording()
            try await until { controller.isRecording || controller.activity == .failed }
            XCTAssertTrue(controller.isRecording, controller.errorMessage ?? "Remote startup failed")
            controller.cancelDictation()
            XCTAssertEqual(controller.activity, .idle)
        }
    }

    func testUnavailableRemoteSelectsLocalFallbackAndExplainsMissingLocalPermission() async throws {
        try await withController(sources: ["unknown"]) { controller, _ in
            let local = AudioInputDevice(uid: "local-test-input", name: "Mac fallback", transport: .builtIn)
            controller.microphones.update(devices: [local], systemDefaultUID: local.uid)
            controller.toggleTestRecording()
            try await until { controller.activity == .failed }
            XCTAssertTrue(controller.errorMessage?.contains("Allow microphone access") == true)
            XCTAssertFalse(controller.isRecording)
        }
    }

    func testFailedDiscoveryStillAttemptsLocalFallback() async throws {
        try await withController(sources: ["ready"]) { controller, client in
            let local = AudioInputDevice(uid: "local-test-input", name: "Mac fallback", transport: .builtIn)
            controller.microphones.update(devices: [local], systemDefaultUID: local.uid)
            try await client.send(path: "fixture/discovery", method: "POST", body: Data(#"{"unavailable":true}"#.utf8))
            do {
                controller.toggleTestRecording()
                try await until { controller.activity == .failed }
                XCTAssertTrue(controller.errorMessage?.contains("Allow microphone access") == true)
                XCTAssertEqual(controller.microphones.resolution.device, local)
            } catch {
                try? await client.send(path: "fixture/discovery", method: "POST", body: Data(#"{"unavailable":false}"#.utf8))
                throw error
            }
            try await client.send(path: "fixture/discovery", method: "POST", body: Data(#"{"unavailable":false}"#.utf8))
        }
    }

    func testOneLostHeartbeatResponseDoesNotInterruptAnOwnedTake() async throws {
        try await withController(sources: ["heartbeat-once"]) { controller, _ in
            controller.toggleTestRecording()
            try await until { controller.isRecording }
            try await Task.sleep(for: .seconds(1.2))
            XCTAssertTrue(controller.isRecording)
            controller.toggleTestRecording()
            try await until { controller.activity == .success }
            XCTAssertEqual(controller.lastDeliveryStatus, .tested)
        }
    }

    func testSourceLossKeepsCapturedAudioInHistoryWithoutDeliveryOrAutomaticSwitch() async throws {
        try await withController(sources: ["lost", "ready"]) { controller, client in
            controller.toggleTestRecording()
            try await until { controller.activity == .failed }
            XCTAssertTrue(controller.errorMessage?.contains("saved in history") == true, controller.errorMessage ?? "")
            XCTAssertTrue(controller.lastTranscript.isEmpty)
            XCTAssertEqual(controller.lastDeliveryStatus, .none)
            try await until {
                let takes = try await takes(client, controller)
                return takes.count == 1 && takes[0].capture?.state == .stopped && takes[0].processingState == .completed
            }
        }
    }

    func testEventOrLeaseLossDiscardsWithoutResultOrAutomaticSwitch() async throws {
        for source in ["event-loss", "heartbeat-loss"] {
            try await withController(sources: [source, "ready"]) { controller, client in
                controller.toggleTestRecording()
                try await until { controller.activity == .failed }
                XCTAssertTrue(controller.lastTranscript.isEmpty)
                XCTAssertEqual(controller.lastDeliveryStatus, .none)
                try await until {
                    let takes = try await takes(client, controller)
                    return takes.count == 1 && takes[0].captureState == .discarded
                }
            }
        }
    }

    func testReleaseWhileStartingAndCancelWhileRecordingNeverDeliver() async throws {
        for source in ["slow", "ready"] {
            try await withController(sources: [source]) { controller, client in
                controller.toggleTestRecording()
                if source == "ready" { try await until { controller.isRecording } }
                else { try await Task.sleep(for: .milliseconds(300)) }
                if source == "slow" { controller.toggleTestRecording() }
                else { controller.cancelDictation() }
                XCTAssertEqual(controller.activity, .idle)
                // A release during startup still learns the admitted ID and discards it.
                try await until(timeout: 7) {
                    let takes = try await takes(client, controller)
                    return takes.count == 1 && takes[0].captureState == .discarded
                }
                XCTAssertTrue(controller.lastTranscript.isEmpty)
                XCTAssertEqual(controller.lastDeliveryStatus, .none)
            }
        }
    }

    private func withController(sources: [String], operation: (SottoDuoController, ServerClient) async throws -> Void) async throws {
        guard let endpoint = ProcessInfo.processInfo.environment["SOTTODUO_CAPTURE_TEST_URL"] else {
            throw XCTSkip("Run Server/tests/fixtures/capture-client-server.ts for the native capture contract test.")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("SottoDuoCaptureTests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = ConfigurationStore(file: ConfigurationFile(url: root.appendingPathComponent("config.json")))
        await configuration.start(); configuration.stopWatching()
        let token = "sottoduo-native-capture-test-token-2026"
        let preferences = ClientPreferencesStore(root: root, environment: ["SOTTODUO_SERVER_URL": endpoint], readCredential: { _ in token })
        let controller = SottoDuoController(configuration: configuration, startServices: false, clientPreferences: preferences)
        defer { controller.shutdown() }
        let client = try ServerClient(endpoint: endpoint, token: token)
        let inventory = try await client.audioSources()
        controller.microphones.updateRemote(inventory.sources, server: client.endpoint.absoluteString,
                                          host: inventory.sharingHost, deviceID: controller.preferences.deviceID)
        for source in sources {
            let device = try XCTUnwrap(controller.microphones.availableDevices.first { $0.uid == source })
            controller.microphones.addToPriority(device)
        }
        controller.refreshServer()
        try await until { controller.isServerReady }
        do { try await operation(controller, client) }
        catch { controller.cancelDictation(); await configuration.flush(); throw error }
        await configuration.flush()
    }

    /// This controller's admitted takes, including discarded ones that history omits.
    private func takes(_ client: ServerClient, _ controller: SottoDuoController) async throws -> [RecordingSnapshot] {
        let (data, _) = try await client.session.data(for: client.request(path: "fixture/captures"))
        var result: [RecordingSnapshot] = []
        for id in try JSONDecoder().decode([UUID].self, from: data) {
            let take = try await client.recording(id)
            if take.device.id == controller.preferences.deviceID { result.append(take) }
        }
        return result
    }

    private func until(timeout: TimeInterval = 8, _ condition: () async throws -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while try await !condition() {
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                XCTFail("Timed out waiting for capture state")
                throw URLError(.timedOut)
            }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
}
