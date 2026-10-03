import Foundation
import DictaDuoAPI
import XCTest

final class CaptureTests: XCTestCase {
    func testReadinessRequiresFreshCaptureAndTransmitterStatusButNotAnAudioLevel() {
        let now = Date(timeIntervalSince1970: 1_000)
        let ready = AudioSource(identity: .init(hostID: "desk", id: "receiver"), name: "DJI", transport: .usb,
            present: true, link: .connected, capture: .available, audioHealth: .unknown, observedAt: now)
        XCTAssertTrue(ready.isEligible(at: now))
        XCTAssertTrue(ready.isEligible(at: now.addingTimeInterval(3.5)))
        XCTAssertFalse(ready.isEligible(at: now.addingTimeInterval(3.501)))
        XCTAssertFalse(ready.isEligible(at: now.addingTimeInterval(-0.001)))
        var source = ready
        source.link = .unknown; XCTAssertFalse(source.isEligible(at: now))
        source = ready; source.link = .disconnected; XCTAssertFalse(source.isEligible(at: now))
        source = ready; source.present = false; XCTAssertFalse(source.isEligible(at: now))
        source = ready; source.capture = .unknown; XCTAssertFalse(source.isEligible(at: now))
        source = ready; source.audioHealth = .degraded; XCTAssertFalse(source.isEligible(at: now))
        source = ready; source.link = .notApplicable; XCTAssertTrue(source.isEligible(at: now))
    }

    func testCaptureModelsAndGenerationRoundTripThroughContract() throws {
        let source = AudioSourceIdentity(hostID: "desk", id: "receiver")
        let device = DeviceIdentity(id: UUID().uuidString, name: "Mac")
        let request = StartCaptureRequest(requestID: UUID(), device: device, mode: .test, source: source)
        let decoded = try DictaDuoAPI.decodeWire(StartCaptureRequest.self, from: DictaDuoAPI.encodeWire(request))
        XCTAssertEqual(decoded.source, source)
        XCTAssertEqual(decoded.requestID, request.requestID)
        XCTAssertEqual(decoded.mode, .test)
        let stop = StopCaptureRequest(continuationID: UUID())
        XCTAssertEqual(try DictaDuoAPI.decodeWire(StopCaptureRequest.self, from: DictaDuoAPI.encodeWire(stop)).continuationID, stop.continuationID)
        var record = GenerationRecord(requestID: UUID(), device: device, settings: .init())
        record.capture = .init(source: source, state: .recording, peak: 0.25)
        let roundTrip = try DictaDuoAPI.decodeWire(GenerationRecord.self, from: DictaDuoAPI.encodeWire(record))
        XCTAssertEqual(roundTrip.capture, record.capture)
    }
}
