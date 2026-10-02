import Foundation
import SottoDuoAPI
import SottoDuoAPIWire
import XCTest

final class APIWireTests: XCTestCase {
    func testGenerationRetryRequiresAnExplicitServerCapability() throws {
        let json = Data("""
            {"apiVersion":3,"serverVersion":"0.1.0","isDev":true,"ready":true,
             "speech":{"modelID":"whisper","backend":"local","ready":true},
             "proofreading":{"modelID":"qwen","backend":"local","ready":false}}
            """.utf8)
        XCTAssertNil(try SottoDuoAPI.decodeWire(ServerHealth.self, from: json).generationRetry)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        for supported in [true, false] {
            object["generationRetry"] = supported
            let health = try SottoDuoAPI.decodeWire(ServerHealth.self,
                from: JSONSerialization.data(withJSONObject: object))
            XCTAssertEqual(health.generationRetry, supported)
            XCTAssertEqual(try SottoDuoAPI.decodeWire(ServerHealth.self,
                from: SottoDuoAPI.encodeWire(health)).generationRetry, supported)
        }
    }

    func testRemoteSourceStatusDecodesWithTheExistingDateStrategy() throws {
        let data = Data("""
            {"sources":[{"identity":{"hostID":"host-stable","id":"usb-dji"},"name":"DJI",\
            "transport":"usb","present":true,"link":"connected","capture":"available",\
            "audioHealth":"unknown","observedAt":"2026-09-20T20:00:00Z"}]}
            """.utf8)
        let decoded = try SottoDuoAPI.decoder().decode(Components.Schemas.AudioSourceList.self, from: data)
        XCTAssertEqual(decoded.sources.first?.identity.hostID, "host-stable")
        XCTAssertEqual(decoded.sources.first?.observedAt, Date(timeIntervalSince1970: 1_789_934_400))
        XCTAssertEqual(decoded.sources.first?.link.rawValue, "connected")
        XCTAssertEqual(decoded.sources.first?.audioHealth.rawValue, "unknown")
        let capture = try SottoDuoAPI.decoder().decode(Components.Schemas.RemoteCapture.self,
            from: Data("""
                {"source":{"hostID":"host-stable","id":"usb-dji"},"state":"recording","peak":0.25}
                """.utf8))
        XCTAssertEqual(capture.state.rawValue, "recording")
        XCTAssertEqual(capture.peak, 0.25)
    }
    func testGenerationTimestampsDecodeFractionalSeconds() throws {
        let record = GenerationRecord(requestID: UUID(), device: .init(id: "test", name: "Test Mac"), settings: .init())
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: SottoDuoAPI.encodeWire(record)) as? [String: Any])
        object["createdAt"] = "2026-01-01T00:00:00.678Z"
        object["updatedAt"] = "2026-01-01T00:00:00.678Z"

        let decoded = try SottoDuoAPI.decodeWire(GenerationRecord.self,
            from: JSONSerialization.data(withJSONObject: object))

        XCTAssertEqual(decoded.createdAt.timeIntervalSince1970, 1_767_225_600.678, accuracy: 0.001)
        XCTAssertEqual(decoded.updatedAt, decoded.createdAt)
    }
    func testHistoricalPreferencesDefaultsSurviveGeneratedTransport() throws {
        let json = Data("""
            {"revision":7,"preferences":{"language":"en","vocabulary":"",
             "dictionary":{"lists":[{"id":"personal","name":"Personal","entries":[{"id":"codex","term":"Codex"}]},
                                    {"id":"empty","name":"Empty"}]},
             "textCorrectionEnabled":true,"keepOriginalAudio":true}}
            """.utf8)
        let snapshot = try SottoDuoAPI.decodeWire(PreferencesSnapshot.self, from: json)
        XCTAssertEqual(snapshot.revision, 7)
        XCTAssertEqual(snapshot.preferences.recognitionMode, .automatic)
        XCTAssertEqual(snapshot.preferences.proofreadingPrompt, ServerPreferences.defaultProofreadingPrompt)
        XCTAssertEqual(snapshot.preferences.dictionary.lists[0].entries[0].aliases, [])
        XCTAssertFalse(snapshot.preferences.dictionary.lists[0].entries[0].isPriority)
        XCTAssertEqual(snapshot.preferences.dictionary.lists[1].entries, [])
        XCTAssertNil(snapshot.preferences.validationError)
        let encoded = try SottoDuoAPI.encodeWire(snapshot)
        XCTAssertEqual(try SottoDuoAPI.decodeWire(PreferencesSnapshot.self, from: encoded), snapshot)
    }

    func testRecognitionEngineIsOmittedUnlessTheServerReportsIt() throws {
        let json = Data("""
            {"revision":1,"preferences":{"language":"en","vocabulary":"","dictionary":{"lists":[]},
             "textCorrectionEnabled":true,"keepOriginalAudio":true}}
            """.utf8)
        var snapshot = try SottoDuoAPI.decodeWire(PreferencesSnapshot.self, from: json)
        XCTAssertNil(snapshot.preferences.recognitionEngine)
        // An older server rejects unknown fields, so an unknown selection is never sent.
        XCTAssertFalse(String(decoding: try SottoDuoAPI.encodeWire(snapshot), as: UTF8.self)
            .contains("recognitionEngine"))
        snapshot.preferences.recognitionEngine = .parakeet
        let encoded = try SottoDuoAPI.encodeWire(snapshot)
        XCTAssertEqual(try SottoDuoAPI.decodeWire(PreferencesSnapshot.self, from: encoded).preferences.recognitionEngine,
                       .parakeet)
        let health = ServerHealth(ready: true, speech: .init(modelID: "parakeet-tdt-0.6b-v3", backend: "local", ready: true),
                                  proofreading: .init(modelID: "qwen", backend: "local", ready: true),
                                  recognitionEngines: [.whisper, .parakeet])
        XCTAssertEqual(try SottoDuoAPI.decodeWire(ServerHealth.self, from: SottoDuoAPI.encodeWire(health)).recognitionEngines,
                       [.whisper, .parakeet])
    }

    func testCompleteGenerationRoundTripsThroughGeneratedTypes() throws {
        let timestamp = Date(timeIntervalSince1970: 1_700_000_000)
        var record = GenerationRecord(requestID: UUID(), device: .init(id: "test", name: "Test Mac"),
            status: .completed, createdAt: timestamp, settings: .init(revision: 3))
        record.settings.preferences.recognitionMode = .automatic
        record.recognition = .init(provider: .whisper, fallbackReason: "Cloud disconnected.")
        record.rawText = "codex, sorry, MiniMax"
        record.finalText = "MiniMax."
        record.insertionText = "MiniMax."
        record.previewText = "MiniMax."
        record.inferenceAudio = .init(filename: "inference.wav", sampleRate: 16_000, channels: 1,
            frameCount: 32_000, byteCount: 128_044)
        record.originalAudio = .init(filename: "original.wav", sampleRate: 48_000, channels: 2,
            frameCount: 96_000, byteCount: 768_044)
        record.detectedLanguage = "en"
        record.speech = .init(modelID: "whisper", modelSHA256: "abc", backend: "whisper.cpp",
            engineVersion: "test", processingSeconds: 0.25)
        record.proofreading = .init(modelID: "qwen", backend: "mlx", processingSeconds: 0.1)
        record.textProcessing = try SottoDuoAPI.decoder().decode(TextProcessingRecord.self, from: Data("""
            {"dictionaryTerms":["Codex","MiniMax"],"dictionaryChangedText":true,
             "inputText":"Codex, sorry, MiniMax","outputText":"MiniMax.","enabled":true,
             "status":"applied","reason":"verified","modelID":"qwen","modelSHA256":"abc",
             "engineVersion":"test","processingSeconds":0.1,"wallSeconds":0.2,"proposedText":"MiniMax.",
             "verifiedRepairs":[{"abandoned":{"locationUTF16":0,"lengthUTF16":5,"text":"Codex"},
                                 "cue":{"locationUTF16":7,"lengthUTF16":5,"text":"sorry"},
                                 "replacement":{"locationUTF16":14,"lengthUTF16":7,"text":"MiniMax"}}]}
            """.utf8))
        record.recognitionHints = .init(includedTerms: ["Codex"], omittedTerms: ["MiniMax"], tokenCount: 3, tokenBudget: 48)
        record.proofreadingHints = .init(includedTerms: ["MiniMax"], omittedTerms: [], tokenCount: 2, tokenBudget: 96)
        record.formattingRejectionReason = "retained source formatting"
        record.consumedListControls = [try SottoDuoAPI.decodeWire(ListControlSpan.self,
            from: Data("{\"location\":0,\"length\":4}".utf8))]
        record.continuation = .init(list: .init(style: .numbered, nextNumber: 3), preview: "1. MiniMax", boundary: .line)
        record.delivery = .init(status: "inserted", message: "ok", reportedAt: timestamp)
        record.progress = 1
        record.importedSource = .init(sourceID: UUID(), sourceStatus: "completed", importedAt: timestamp,
            variantNames: ["final"], artifactNames: [.sourceJSON, .sourceWAV], durationSeconds: 2,
            sourceSHA256: "abc", artifactSHA256: ["source.json": "abc"])

        let data = try SottoDuoAPI.encodeWire(record)
        let generated = try SottoDuoAPI.decoder().decode(Components.Schemas.GenerationRecord.self, from: data)
        XCTAssertEqual(generated.id, record.id)
        XCTAssertEqual(generated.createdAt, timestamp)
        XCTAssertEqual(generated.inferenceAudio?.frameCount, 32_000)
        XCTAssertEqual(try SottoDuoAPI.decodeWire(GenerationRecord.self, from: data), record)
        XCTAssertEqual(record.audioSeconds, 2)
        XCTAssertTrue(record.status.isTerminal)

        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["error"])
        XCTAssertFalse(object.values.contains { $0 is NSNull })
    }

    func testGeneratedTransportEnforcesRequiredFieldsAndKnownEnums() throws {
        XCTAssertThrowsError(try SottoDuoAPI.decodeWire(ServerHealth.self, from: Data("{}".utf8)))
        XCTAssertThrowsError(try SottoDuoAPI.decodeWire(GenerationStatus.self, from: Data("\"unknown\"".utf8)))
    }

    func testDomainDictionaryValidationRemainsActive() throws {
        let json = Data("""
            {"lists":[{"id":"personal","name":"Personal","entries":[
                {"id":"duplicate","term":"Codex"},{"id":"duplicate","term":"MiniMax"}]}]}
            """.utf8)
        XCTAssertThrowsError(try SottoDuoAPI.decodeWire(PersonalDictionary.self, from: json))
        let nullAliases = Data("{\"id\":\"codex\",\"term\":\"Codex\",\"aliases\":null}".utf8)
        XCTAssertThrowsError(try SottoDuoAPI.decodeWire(DictionaryEntry.self, from: nullAliases))
        let nullEntries = Data("{\"id\":\"personal\",\"name\":\"Personal\",\"entries\":null}".utf8)
        XCTAssertThrowsError(try SottoDuoAPI.decodeWire(DictionaryList.self, from: nullEntries))
    }

    func testFrameCountersAndImportsRetainTheirWireShapes() throws {
        let frames: Int64 = 4_294_967_296
        let receipt = AudioChunkReceipt(nextSequence: 3, frameCount: frames)
        let decoded = try SottoDuoAPI.decodeWire(AudioChunkReceipt.self, from: SottoDuoAPI.encodeWire(receipt))
        XCTAssertEqual(decoded.frameCount, frames)
        let request = FinishGenerationRequest(inferenceFrames: frames, originalFrames: frames, continuationID: UUID())
        let finish = try SottoDuoAPI.decodeWire(FinishGenerationRequest.self, from: SottoDuoAPI.encodeWire(request))
        XCTAssertEqual(finish.continuationID, request.continuationID)

        let sourceID = UUID()
        let manifest = WisprFlowArtifactManifest(filename: .sourceJSON, byteCount: 128,
            sha256: String(repeating: "a", count: 64))
        let imported = WisprFlowImportRequest(sourceID: sourceID, createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            finalText: "Hello.", rawText: "hello", artifacts: [manifest], unarchivedArtifacts: [])
        XCTAssertEqual(try SottoDuoAPI.decodeWire(WisprFlowImportRequest.self, from: SottoDuoAPI.encodeWire(imported)), imported)
        let known = WisprFlowKnownIDsRequest(sourceIDs: [sourceID])
        XCTAssertEqual(try SottoDuoAPI.decodeWire(WisprFlowKnownIDsRequest.self, from: SottoDuoAPI.encodeWire(known)).sourceIDs, [sourceID])
    }
}
