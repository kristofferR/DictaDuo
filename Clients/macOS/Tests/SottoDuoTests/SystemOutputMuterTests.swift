import CoreAudio
import XCTest
@testable import SottoDuo

@MainActor
final class SystemOutputMuterTests: XCTestCase {
    func testMutesSeparateSoundEffectsOutputAndRestoresOriginalDevices() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false],
                                          9: [1: true, 2: false]], defaultDevice: 7, systemDevice: 9)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: true])
        XCTAssertEqual(output.devices[9], [1: true, 2: true])

        output.defaultDevice = nil
        output.systemDevice = nil
        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
        XCTAssertEqual(output.devices[9], [1: true, 2: false])
    }

    func testSharedMediaAndSoundEffectsOutputIsChangedOnce() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7, systemDevice: 7)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        muter.restore()
        XCTAssertEqual(output.setCalls, 2)
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
    }

    func testMutesOutputWhileRecordingAndRestoresIt() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: true])

        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
    }

    func testOutputAlreadyMutedBeforeRecordingStaysMuted() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: true]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: true])
    }

    func testPerChannelMuteRestoresEachChannelToItsPreviousState() {
        let output = FakeOutput(devices: [7: [1: true, 2: false]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        XCTAssertEqual(output.devices[7], [1: true, 2: true])

        muter.restore()
        XCTAssertEqual(output.devices[7], [1: true, 2: false])
    }

    func testRepeatedMuteStillRestoresTheStateBeforeTheFirstMute() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        muter.mute()
        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
    }

    func testRestoresTheOriginalDeviceWhenTheDefaultOutputChangesMidRecording() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false],
                                          9: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        output.defaultDevice = 9
        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
        XCTAssertEqual(output.devices[9], [kAudioObjectPropertyElementMain: false])
    }

    func testNoDefaultOutputDeviceIsANoOp() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: nil)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
        XCTAssertEqual(output.setCalls, 0)
    }

    func testRejectedMuteIsNotUndoneOnRestore() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7)
        output.rejectsChanges = true
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        output.rejectsChanges = false
        muter.restore()
        XCTAssertEqual(output.setCalls, 1)
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
    }

    func testRejectedRestoreIsRetriedOnTheNextRestore() {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client)

        muter.mute()
        output.rejectsChanges = true
        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: true])

        output.rejectsChanges = false
        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
    }

    func testRejectedRestoreIsRetriedAfterCaptureEnds() async {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client, retryDelays: [.milliseconds(10)])

        muter.mute()
        output.rejectsChanges = true
        muter.restore()
        output.rejectsChanges = false
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
    }

    func testNewTakeSuspendsPendingRestoreRetries() async {
        let output = FakeOutput(devices: [7: [kAudioObjectPropertyElementMain: false]], defaultDevice: 7)
        let muter = SystemOutputMuter(client: output.client, retryDelays: [.milliseconds(10)])

        muter.mute()
        output.rejectsChanges = true
        muter.restore()
        output.rejectsChanges = false
        muter.mute()
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: true])

        muter.restore()
        XCTAssertEqual(output.devices[7], [kAudioObjectPropertyElementMain: false])
    }
}

/// In-memory HAL: each device maps its settable mute elements to their state.
@MainActor
private final class FakeOutput {
    var devices: [AudioDeviceID: [AudioObjectPropertyElement: Bool]]
    var defaultDevice: AudioDeviceID?
    var systemDevice: AudioDeviceID?
    var rejectsChanges = false
    private(set) var setCalls = 0

    init(devices: [AudioDeviceID: [AudioObjectPropertyElement: Bool]], defaultDevice: AudioDeviceID?, systemDevice: AudioDeviceID? = nil) {
        self.devices = devices
        self.defaultDevice = defaultDevice
        self.systemDevice = systemDevice
    }

    var client: SystemOutputClient {
        SystemOutputClient(
            defaultOutputDevices: { [unowned self] in [defaultDevice, systemDevice].compactMap { $0 } },
            muteElements: { [unowned self] device in devices[device].map { $0.keys.sorted() } ?? [] },
            isMuted: { [unowned self] device, element in devices[device]?[element] },
            setMuted: { [unowned self] device, element, muted in
                setCalls += 1
                guard !rejectsChanges, devices[device]?[element] != nil else { return false }
                devices[device]?[element] = muted
                return true
            }
        )
    }
}
