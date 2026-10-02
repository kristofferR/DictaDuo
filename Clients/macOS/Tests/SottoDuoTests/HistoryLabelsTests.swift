import Foundation
import SottoDuoAPI
import XCTest
@testable import SottoDuo

final class HistoryLabelsTests: XCTestCase {
    private func record(_ status: GenerationStatus, mode: GenerationMode = .dictation, seconds: Int64 = 0) -> GenerationRecord {
        var record = GenerationRecord(requestID: UUID(), device: .init(id: "mac", name: "Mac"), mode: mode,
                                      status: status, settings: .init())
        if seconds > 0 {
            record.inferenceAudio = AudioArtifact(filename: "inference.wav", sampleRate: 16_000, channels: 1,
                                                  frameCount: seconds * 16_000, byteCount: seconds * 64_000)
        }
        return record
    }

    func testStatusPrefersProblemsThenDelivery() {
        var pasted = record(.completed)
        pasted.delivery = DeliveryReceipt(status: "listUpdated")
        XCTAssertEqual(HistoryLabels.status(pasted, interrupted: false),
                       HistoryStatus(label: "Pasted", tone: .ok, detail: "Pasted at your cursor."))
        XCTAssertEqual(HistoryLabels.status(record(.queued), interrupted: true)?.label, "Interrupted")
        XCTAssertEqual(HistoryLabels.status(record(.failed), interrupted: false)?.tone, .error)
        XCTAssertEqual(HistoryLabels.status(record(.cancelled), interrupted: false)?.label, "Not pasted")
        XCTAssertEqual(HistoryLabels.status(record(.completed, mode: .test), interrupted: false)?.label, "Test (no paste)")
        XCTAssertNil(HistoryLabels.status(record(.completed), interrupted: false))
        XCTAssertNil(HistoryLabels.delivery("not reported"))
        XCTAssertNil(HistoryLabels.cleanup(.disabled))
        XCTAssertEqual(HistoryLabels.cleanup(.rejected), "Cleanup not used (kept recognized text)")
    }

    func testRecognitionLineNamesHowLanguageAndLength() {
        var cloud = record(.completed, seconds: 12)
        cloud.recognition = RecognitionState(provider: .soniox)
        cloud.detectedLanguage = "no"
        XCTAssertEqual(HistoryLabels.recognition(cloud), "Recognized with cloud · Norwegian · 0:12")
        var fallback = record(.completed)
        fallback.recognition = RecognitionState(provider: .whisper, fallbackReason: "Cloud unavailable")
        XCTAssertEqual(HistoryLabels.recognition(fallback), "Recognized locally (cloud unavailable)")
    }

    func testFinishedTakesCanBeTranscribedAgainAfterConfirming() {
        let finished = record(.completed, seconds: 3)
        XCTAssertTrue(finished.canTranscribeAgain)
        XCTAssertTrue(finished.asksBeforeTranscribingAgain)
        XCTAssertTrue(record(.failed, seconds: 3).canTranscribeAgain)
        XCTAssertFalse(record(.failed, seconds: 3).asksBeforeTranscribingAgain)
        XCTAssertFalse(record(.completed).canTranscribeAgain)
        XCTAssertFalse(record(.queued, seconds: 3).canTranscribeAgain)

        var parakeet = finished
        parakeet.settings.preferences.recognitionEngine = .parakeet
        XCTAssertEqual(HistoryLabels.retryEngine(parakeet, installed: [.whisper, .parakeet]),
                       "Current engine: Parakeet, language Detect automatically.")
        XCTAssertEqual(HistoryLabels.retryEngine(parakeet, installed: nil), "Current engine: Whisper, language English.")
    }
}
