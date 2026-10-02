import AVFoundation
import Foundation
import SottoDuoAPI
import XCTest
@testable import SottoDuo

final class ServerClientTests: XCTestCase {
    func testInterruptedEventsRecoverCompletedResultWithoutRepeatingDelivery() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let queued = GenerationRecord(requestID: UUID(), device: .init(id: "test", name: "Test Mac"),
                                      status: .queued, settings: .init())
        var completed = queued
        completed.status = .completed
        completed.finalText = "Recovered result"
        let completedRecord = completed
        fixture.respond = { request in
            if request.url!.path.hasSuffix("/events") {
                return (200, try SottoDuoAPI.encodeWire(queued) + Data([10]))
            }
            return (200, try SottoDuoAPI.encodeWire(completedRecord))
        }
        let updates = GenerationCollector()
        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session)
        let result = try await client.events(queued.id) { updates.append($0) }
        XCTAssertEqual(result.id, completedRecord.id)
        XCTAssertEqual(result.status, .completed)
        XCTAssertEqual(result.finalText, completedRecord.finalText)
        XCTAssertEqual(updates.values.map(\.status), [.queued, .completed])
        XCTAssertEqual(fixture.requests.count, 2)
    }

    func testDiscardRetriesTransientFailuresButNotRejections() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        fixture.respond = { [weak fixture] _ in
            (fixture?.requests.count ?? 0) < 3 ? (503, Data()) : (200, Data("{}".utf8))
        }
        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session)
        await client.discardRecordingRetrying(UUID(), delays: [.milliseconds(5), .milliseconds(5), .milliseconds(5)])
        XCTAssertEqual(fixture.requests.count, 3)

        let rejected = HTTPFixture()
        defer { rejected.session.invalidateAndCancel() }
        rejected.respond = { _ in (404, Data()) }
        let other = try ServerClient(endpoint: rejected.endpoint, token: "", session: rejected.session)
        await other.discardRecordingRetrying(UUID(), delays: [.milliseconds(5)])
        XCTAssertEqual(rejected.requests.count, 1)
    }

    func testQueuedEventsReconnectUntilTerminalResult() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let queued = GenerationRecord(requestID: UUID(), device: .init(id: "test", name: "Test Mac"),
                                      status: .queued, settings: .init())
        var completed = queued
        completed.status = .completed
        let completedRecord = completed
        fixture.respond = { [weak fixture] request in
            let reconnect = (fixture?.requests.count ?? 0) == 3
            let data = try SottoDuoAPI.encodeWire(reconnect ? completedRecord : queued)
            return (200, data + (request.url!.path.hasSuffix("/events") ? Data([10]) : Data()))
        }
        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session)
        let result = try await client.events(queued.id) { _ in }
        XCTAssertEqual(result.status, .completed)
        XCTAssertEqual(fixture.requests.map { $0.url!.lastPathComponent },
                       ["events", queued.id.uuidString, "events"])
    }

    func testInvalidEventIdentityDoesNotRetryOrDeliverAnotherRecording() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let wrongRecord = GenerationRecord(requestID: UUID(), device: .init(id: "test", name: "Test Mac"),
                                           status: .completed, settings: .init())
        fixture.respond = { _ in (200, try SottoDuoAPI.encodeWire(wrongRecord) + Data([10])) }
        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session)
        let updates = GenerationCollector()
        do {
            _ = try await client.events(UUID()) { updates.append($0) }
            XCTFail("An unrelated generation must not be delivered")
        } catch ServerClientError.invalidResponse {
        }
        XCTAssertTrue(updates.values.isEmpty)
        XCTAssertEqual(fixture.requests.count, 1)
    }

    func testCaptureOwnerIsUniquePerTakeAndNeverLeaksIntoURLsOrDiscovery() throws {
        let client = try ServerClient(endpoint: "https://example.com", token: "server-access")
        let first = try client.owningCapture()
        let second = try client.owningCapture()
        let request = try first.request(path: "v2/captures", method: "POST")
        let secret = try XCTUnwrap(request.value(forHTTPHeaderField: "X-SottoDuo-Capture-Owner"))
        XCTAssertEqual(secret.count, 64)
        XCTAssertTrue(secret.allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertNotEqual(secret, try second.request(path: "v2/captures").value(forHTTPHeaderField: "X-SottoDuo-Capture-Owner"))
        XCTAssertNil(try client.request(path: "v1/audio-sources").value(forHTTPHeaderField: "X-SottoDuo-Capture-Owner"))
        for path in ["capture/heartbeat", "capture/stop", "context", "discard", "delivery", "events"] {
            let control = try first.request(path: "v2/recordings/\(UUID())/\(path)")
            XCTAssertEqual(control.value(forHTTPHeaderField: "X-SottoDuo-Capture-Owner"), secret)
            XCTAssertFalse(control.url!.absoluteString.contains(secret))
        }
    }

    func testCaptureSourceErrorsAreDistinctFromServerFailureAndLegacyDiscoveryIsEmpty() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session).owningCapture()
        let input = StartCaptureRequest(requestID: UUID(), device: .init(id: "mac", name: "Mac"), mode: .test,
                                        source: .init(hostID: "desk", id: "dji"))
        for code in ["source_unavailable", "capture_failed", "capture_timeout", "server_stopping"] {
            fixture.respond = { _ in (503, try SottoDuoAPI.encoder().encode(APIErrorResponse(code: code, message: "Fixture"))) }
            do { _ = try await client.startCapture(input, timeout: 2); XCTFail("Expected rejection") }
            catch ServerClientError.captureUnavailable { XCTAssertNotEqual(code, "server_stopping") }
            catch ServerClientError.rejected(503, _) { XCTAssertEqual(code, "server_stopping") }
        }
        fixture.respond = { _ in (404, Data()) }
        let sources = try await client.audioSources()
        XCTAssertTrue(sources.sources.isEmpty)
        XCTAssertNil(sources.sharingHost)
        XCTAssertEqual(fixture.requests.last?.timeoutInterval, 1)
    }

    func testBusySharedMicIsDistinctFromOtherConflicts() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session).owningCapture()
        let input = StartCaptureRequest(requestID: UUID(), device: .init(id: "mac", name: "Mac"), mode: .test,
                                        source: .init(hostID: "desk", id: "dji"))
        for code in ["capture_busy", "conflicting_request"] {
            fixture.respond = { _ in (409, try SottoDuoAPI.encoder().encode(APIErrorResponse(code: code, message: "Fixture"))) }
            do { _ = try await client.startCapture(input, timeout: 2); XCTFail("Expected rejection") }
            catch ServerClientError.captureBusy { XCTAssertEqual(code, "capture_busy") }
            catch ServerClientError.rejected(409, _) { XCTAssertEqual(code, "conflicting_request") }
        }
    }

    func testSharingFieldsAreRequestedAndDecodedWithButtonTarget() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session)
        let holder = Data(#"{"id":"linux","name":"Linux desk"}"#.utf8)
        fixture.respond = { request in
            switch request.url!.path {
            case "/v1/audio-sources":
                return (200, Data("""
                    {"sources":[{"identity":{"hostID":"omarchy-desktop","id":"dji"},"name":"DJI Mic Mini","transport":"usb",
                    "present":true,"link":"connected","capture":"available","audioHealth":"healthy",
                    "observedAt":"2026-10-02T12:00:00Z","shared":true,"recordingFor":\(String(decoding: holder, as: UTF8.self))}],
                    "sharingHost":{"name":"omarchy","local":false}}
                    """.utf8))
            case "/v1/button-destinations/target":
                XCTAssertEqual(request.httpMethod, "PUT")
                let target = try SottoDuoAPI.decodeWire(ButtonTarget.self, from: requestBody(request))
                return (200, try ServerClient.encode(ButtonDestinationState(destinations: [], available: false, buttonTarget: target)))
            default: return (404, Data())
            }
        }
        let list = try await client.audioSources()
        XCTAssertEqual(list.sharingHost?.name, "omarchy")
        XCTAssertEqual(list.sources.first?.shared, true)
        XCTAssertEqual(list.sources.first?.recordingFor?.name, "Linux desk")
        let state = try await client.setButtonTarget(ButtonTarget(mode: .device, device: .init(id: "mac", name: "Mac")))
        XCTAssertEqual(state.buttonTarget?.mode, .device)
        XCTAssertEqual(state.buttonTarget?.device?.id, "mac")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.value(forHTTPHeaderField: "X-SottoDuo-Microphone-Sharing") == "sharing-v1" })
    }

    @MainActor
    func testRemoteSealCallbackRunsBeforeWaitingForTranscription() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let connection = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session).owningCapture()
        let source = AudioSourceIdentity(hostID: "desk", id: "dji")
        var snapshot = RecordingSnapshot(id: UUID(), requestID: UUID(), device: .init(id: "mac", name: "Mac"), settings: .init())
        snapshot.capture = .init(source: source, state: .recording)
        let capture = try RemoteCaptureSession(snapshot: snapshot, connection: connection)
        snapshot.capture?.state = .sealed
        snapshot.captureState = .stopped
        let sealed = try RecordingWire.encoder().encode(snapshot)
        fixture.respond = { request in
            guard request.url?.path.hasSuffix("/capture/stop") == true else { throw URLError(.badServerResponse) }
            return (200, sealed)
        }
        var notified = false
        do {
            _ = try await capture.stop(continuationID: nil) {
                XCTAssertTrue(capture.isSealed)
                notified = true
            }
            XCTFail("The processing stream failed, so no result can arrive")
        } catch is URLError {
            // Acknowledging the seal must not wait for processing to finish.
            XCTAssertTrue(notified)
        }
        capture.cancelMonitoring()
    }

    @MainActor
    func testInterruptedRemoteStopIsNotCancelledAsUnsealed() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let connection = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session).owningCapture()
        let source = AudioSourceIdentity(hostID: "desk", id: "dji")
        var snapshot = RecordingSnapshot(id: UUID(), requestID: UUID(), device: .init(id: "mac", name: "Mac"), settings: .init())
        snapshot.capture = .init(source: source, state: .recording)
        let capture = try RemoteCaptureSession(snapshot: snapshot, connection: connection)
        fixture.respond = { request in
            XCTAssertTrue(request.url?.path.hasSuffix("/capture/stop") == true)
            throw URLError(.networkConnectionLost)
        }
        var notified = false
        do {
            _ = try await capture.stop(continuationID: nil) { notified = true }
            XCTFail("Expected the interrupted stop response to fail")
        } catch is URLError {}
        XCTAssertFalse(capture.isSealed)
        XCTAssertFalse(notified, "An interrupted response does not confirm the microphone is sealed")
        XCTAssertFalse(capture.shouldCancelServer)
        capture.cancelMonitoring()
    }

    func testConnectionRejectsCredentialsInURLsAndKeepsBearerInHeader() throws {
        XCTAssertThrowsError(try ServerClient(endpoint: "https://person:secret@example.com", token: ""))
        XCTAssertThrowsError(try ServerClient(endpoint: "https://example.com?token=secret", token: ""))
        let client = try ServerClient(endpoint: "https://example.com/sottoduo", token: "private-token")
        let request = try client.request(path: "v1/health")
        XCTAssertEqual(request.url?.absoluteString, "https://example.com/sottoduo/v1/health")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer private-token")
        XCTAssertFalse(request.url?.absoluteString.contains("private-token") == true)
    }

    func testRecordingSocketPreservesTLSForMixedCaseSchemes() throws {
        for endpoint in ["https://example.com", "HTTPS://example.com", "hTtPs://example.com"] {
            let request = try ServerClient(endpoint: endpoint, token: "private-token").recordingWebSocketRequest(UUID())
            XCTAssertEqual(request.url?.scheme, "wss")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer private-token")
        }
        let local = try ServerClient(endpoint: "HTTP://127.0.0.1:8391", token: "").recordingWebSocketRequest(UUID())
        XCTAssertEqual(local.url?.scheme, "ws")
    }

    func testKnownWisprFlowIDsBatchesLargeHistoryWithinServerLimits() async throws {
        let fixture = HTTPFixture()
        defer { fixture.session.invalidateAndCancel() }
        let sourceIDs = (0..<10_501).map { _ in UUID() }
        let expected = Set([sourceIDs[0], sourceIDs[4_999], sourceIDs[5_000],
                            sourceIDs[9_999], sourceIDs[10_000], sourceIDs[10_500]])
        let capturedBodies = RequestBodyCollector()
        fixture.respond = { request in
            let body = try requestBody(request)
            capturedBodies.append(body)
            let input = try SottoDuoAPI.decoder().decode(WisprFlowKnownIDsRequest.self, from: body)
            guard input.sourceIDs.count <= 10_000, body.count <= 262_144 else {
                return (413, try SottoDuoAPI.encoder().encode(APIErrorResponse(
                    code: "source_id_limit", message: "Source ID lookup exceeds server limits")))
            }
            return (200, try SottoDuoAPI.encoder().encode(WisprFlowKnownIDsResponse(
                knownSourceIDs: input.sourceIDs.filter { expected.contains($0) })))
        }

        let client = try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session)
        let known = try await client.knownWisprFlowSourceIDs(sourceIDs)
        XCTAssertEqual(known, expected)
        let bodies = capturedBodies.values
        XCTAssertEqual(bodies.count, 3)
        let batches = try bodies.map {
            try SottoDuoAPI.decoder().decode(WisprFlowKnownIDsRequest.self, from: $0)
        }
        XCTAssertEqual(batches.map { $0.sourceIDs.count }, [5_000, 5_000, 501])
        XCTAssertEqual(batches.flatMap(\.sourceIDs), sourceIDs)
        XCTAssertTrue(bodies.allSatisfy { $0.count <= 262_144 })
    }

    func testRecorderStreamsOriginalChannelsAndEveryNormalizedFrameBeforeFinishing() async throws {
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000,
                                                channels: 2, interleaved: false))
        let input = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_800))
        input.frameLength = 4_800
        let samples = try XCTUnwrap(input.floatChannelData)
        for index in 0..<4_800 { samples[0][index] = 0.25; samples[1][index] = -0.5 }
        let chunks = ChunkCollector()
        let writer = try RecordingWriter(inputFormat: format, preserveOriginalAudio: true,
                                         onLevel: { _ in }, onError: { _ in }, onChunk: { chunks.append($0) })
        writer.append(input)
        let audio = try await writer.finish()
        defer { audio.cleanup() }
        let original = chunks.values.filter { if case .original = $0.kind { return true }; return false }
        let normalized = chunks.values.filter { if case .normalized = $0.kind { return true }; return false }
        XCTAssertEqual(original.reduce(0) { $0 + $1.data.count }, 4_800 * 2 * 4)
        XCTAssertEqual(normalized.reduce(0) { $0 + $1.data.count } / 4, Int((audio.duration * 16_000).rounded()))
        XCTAssertTrue(normalized.allSatisfy { $0.sampleRate == 16_000 && $0.channels == 1 })
        let first = try XCTUnwrap(original.first)
        let pair = first.data.withUnsafeBytes { bytes in
            (bytes.loadUnaligned(fromByteOffset: 0, as: Float.self), bytes.loadUnaligned(fromByteOffset: 4, as: Float.self))
        }
        XCTAssertEqual(pair.0, 0.25)
        XCTAssertEqual(pair.1, -0.5)
    }
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 8_192)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { throw stream.streamError ?? URLError(.cannotParseResponse) }
        if count == 0 { break }
        body.append(buffer, count: count)
    }
    return body
}

private final class RequestBodyCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [Data] = []
    var values: [Data] { lock.withLock { bodies } }
    func append(_ body: Data) { lock.withLock { bodies.append(body) } }
}

final class HTTPFixture: @unchecked Sendable {
    let id = UUID().uuidString.lowercased()
    let session: URLSession
    private let lock = NSLock()
    private var captured: [URLRequest] = []
    var respond: ((URLRequest) throws -> (Int, Data))?
    var respondAsync: ((URLRequest, @escaping (Result<(Int, Data), Error>) -> Void) -> Void)?
    var endpoint: String { "https://\(id).test" }
    var requests: [URLRequest] { lock.withLock { captured } }

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureURLProtocol.self]
        session = URLSession(configuration: configuration)
        FixtureURLProtocol.register(self)
    }
    deinit { FixtureURLProtocol.unregister(id) }
    func response(_ request: URLRequest, completion: @escaping (Result<(Int, Data), Error>) -> Void) {
        lock.withLock { captured.append(request) }
        if let respondAsync { respondAsync(request, completion) }
        else { completion(Result { try respond?(request) ?? (500, Data()) }) }
    }
}

private final class FixtureURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var fixtures: [String: WeakFixture] = [:]
    private struct WeakFixture { weak var value: HTTPFixture? }
    static func register(_ fixture: HTTPFixture) { lock.withLock { fixtures[fixture.id] = WeakFixture(value: fixture) } }
    static func unregister(_ id: String) { _ = lock.withLock { fixtures.removeValue(forKey: id) } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let id = String((request.url?.host ?? "").dropLast(5))
        guard let fixture = Self.lock.withLock({ Self.fixtures[id]?.value }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost)); return
        }
        fixture.response(request) { [self] result in
            switch result {
            case .success(let (status, data)):
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            case .failure(let error): client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }
    override func stopLoading() {}
}

private final class ChunkCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [CapturedAudioChunk] = []
    var values: [CapturedAudioChunk] { lock.withLock { chunks } }
    func append(_ chunk: CapturedAudioChunk) { lock.withLock { chunks.append(chunk) } }
}

private final class GenerationCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var records: [GenerationRecord] = []
    var values: [GenerationRecord] { lock.withLock { records } }
    func append(_ record: GenerationRecord) { lock.withLock { records.append(record) } }
}
