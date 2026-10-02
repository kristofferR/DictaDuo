import CryptoKit
import Foundation
import SottoDuoAPI

enum ServerClientError: LocalizedError {
    case invalidEndpoint
    case rejected(Int, String)
    case captureUnavailable(String)
    /// Another take holds the shared microphone; the next input may be used.
    case captureBusy(String)
    case invalidResponse
    case disconnected
    case importArtifactTooLarge(WisprFlowArtifactName, Int)
    case dictionaryArchiveTooLarge(Int)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint: "The server address is invalid."
        case .rejected(_, let message): message
        case .captureUnavailable(let message), .captureBusy(let message): message
        case .invalidResponse: "The server returned an invalid response."
        case .disconnected: "The server connection was interrupted. Any completed result is available in shared history."
        case .importArtifactTooLarge(let name, let bytes):
            "\(name.rawValue) is \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)), above the 8 MiB source-artifact limit."
        case .dictionaryArchiveTooLarge(let bytes):
            "Wispr Flow dictionary is \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)), above the 8 MiB archive limit. No dictionary entries were archived."
        }
    }
}

/// A connection is immutable for a take. Editing the configured endpoint cannot
/// redirect a running upload or accidentally send its credential to another host.
struct ServerClient: Sendable {
    let endpoint: URL
    private let token: String
    private let captureOwner: String?
    private let destinationOwner: String?
    let session: URLSession

    init(endpoint: String, token: String, session: URLSession? = nil, captureOwner: String? = nil, destinationOwner: String? = nil) throws {
        self.endpoint = try ServerEndpoint(endpoint).url
        self.token = token
        self.captureOwner = captureOwner
        self.destinationOwner = destinationOwner
        self.session = session ?? Self.defaultSession
    }

    private static func newOwnerSecret() -> String {
        SymmetricKey(size: .bits256).withUnsafeBytes { bytes in
            bytes.map { String(format: "%02x", $0) }.joined()
        }
    }

    func owningCapture() throws -> ServerClient {
        let secret = Self.newOwnerSecret()
        return try ServerClient(endpoint: endpoint.absoluteString, token: token, session: session, captureOwner: secret)
    }

    func owningDestination() throws -> ServerClient {
        let secret = Self.newOwnerSecret()
        return try ServerClient(endpoint: endpoint.absoluteString, token: token, session: session, destinationOwner: secret)
    }

    func buttonDestination(_ path: String = "", method: String = "POST", body: Data? = nil) async throws -> ButtonDestinationState {
        try await json(path: "/v1/button-destinations" + path, method: method, body: body, timeout: 1.5)
    }

    /// Where the DJI button types, stored on the server for every computer.
    func setButtonTarget(_ target: ButtonTarget) async throws -> ButtonDestinationState {
        try await buttonDestination("/target", method: "PUT", body: Self.encode(target))
    }

    private static let defaultSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 300
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    func request(path: String, method: String = "GET", body: Data? = nil,
                 contentType: String = "application/json", query: [URLQueryItem] = []) throws -> URLRequest {
        let url = endpoint.appendingPathComponent(path)
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ServerClientError.invalidEndpoint
        }
        if !query.isEmpty { components.queryItems = query }
        guard let target = components.url else { throw ServerClientError.invalidEndpoint }
        var request = URLRequest(url: target)
        request.httpMethod = method
        request.httpBody = body
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("streaming-v1", forHTTPHeaderField: "X-SottoDuo-Recognition")
        request.setValue("retry-v1", forHTTPHeaderField: "X-SottoDuo-Generation-Retry")
        request.setValue("engine-v1", forHTTPHeaderField: "X-SottoDuo-Recognition-Engine")
        request.setValue("capture-v1", forHTTPHeaderField: "X-SottoDuo-Capture")
        request.setValue("sharing-v1", forHTTPHeaderField: "X-SottoDuo-Microphone-Sharing")
        request.setValue("cloud-v1", forHTTPHeaderField: "X-SottoDuo-Cloud-Recognition")
        request.setValue("features-v1", forHTTPHeaderField: "X-SottoDuo-Features")
        request.setValue("language-v2", forHTTPHeaderField: "X-SottoDuo-Language")
        if let destinationOwner { request.setValue(destinationOwner, forHTTPHeaderField: "X-SottoDuo-Destination-Owner") }
        if let captureOwner { request.setValue(captureOwner, forHTTPHeaderField: "X-SottoDuo-Capture-Owner") }
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    func json<Response: APIWireModel>(path: String, method: String = "GET", body: Data? = nil,
                                     timeout: TimeInterval = 12) async throws -> Response {
        var request = try request(path: path, method: method, body: body)
        request.timeoutInterval = timeout
        let (data, response) = try await session.data(for: request)
        try Self.validate(response, data: data)
        guard data.count <= 16 * 1_024 * 1_024 else { throw ServerClientError.invalidResponse }
        do { return try SottoDuoAPI.decodeWire(Response.self, from: data) }
        catch { throw ServerClientError.invalidResponse }
    }

    func send(path: String, method: String, body: Data? = nil, timeout: TimeInterval = 12) async throws {
        var request = try request(path: path, method: method, body: body)
        request.timeoutInterval = timeout
        let (data, response) = try await session.data(for: request)
        try Self.validate(response, data: data)
    }

    static func encode<T: APIWireModel>(_ value: T) throws -> Data {
        try SottoDuoAPI.encodeWire(value)
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private static func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let response = response as? HTTPURLResponse else { throw ServerClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            if let error = try? SottoDuoAPI.decoder().decode(APIErrorResponse.self, from: data) {
                let message = String(error.message.prefix(1_000))
                if response.statusCode == 503, ["source_unavailable", "capture_failed", "capture_timeout"].contains(error.code) {
                    throw ServerClientError.captureUnavailable(message)
                }
                if response.statusCode == 409, error.code == "capture_busy" { throw ServerClientError.captureBusy(message) }
            }
            let message: String
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let detail = object["message"] as? String ?? object["error"] as? String {
                message = String(detail.prefix(1_000))
            } else {
                switch response.statusCode {
                case 401, 403: message = "The server credential was rejected. Update it in Preferences."
                case 409: message = "The recording changed before the request could finish."
                case 429: message = "The server has reached its capacity. Try again shortly."
                case 503: message = "The server is online but its models are not ready."
                default: message = "The server could not complete the request (HTTP \(response.statusCode))."
                }
            }
            throw ServerClientError.rejected(response.statusCode, message)
        }
    }
}

/// API redirects are configuration errors. Do not follow them with audio or a
/// credential, even if a reverse proxy accidentally emits one.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

extension ServerClient {
    func audioSources() async throws -> AudioSourceList {
        do {
            let result: AudioSourceList = try await json(path: "v1/audio-sources", timeout: 1)
            guard result.sources.count <= 32,
                  Set(result.sources.map(\.identity)).count == result.sources.count else {
                throw ServerClientError.invalidResponse
            }
            return result
        } catch ServerClientError.rejected(404, _) {
            return AudioSourceList(sources: []) // A server without capture support still accepts local uploads.
        }
    }
    /// Admits a recording session fed by a server-hosted microphone.
    func startCapture(_ value: StartCaptureRequest, timeout: TimeInterval) async throws -> RecordingSnapshot {
        // Like create: a release during startup must still learn the admitted ID
        // so it can discard the take instead of holding the microphone.
        try await Task {
            let snapshot: RecordingSnapshot = try await recordingJSON(
                path: "v2/captures", method: "POST", body: Self.encode(value), timeout: timeout)
            return snapshot
        }.value
    }
    func heartbeat(_ id: UUID) async throws {
        try await send(path: "v2/recordings/\(id)/capture/heartbeat", method: "POST", timeout: 1)
    }
    func stopCapture(_ id: UUID, continuationID: UUID?) async throws -> RecordingSnapshot {
        try await recordingJSON(path: "v2/recordings/\(id)/capture/stop", method: "POST",
                                body: Self.encode(StopCaptureRequest(continuationID: continuationID)), timeout: 6)
    }
    /// Fixes the take's continuation, or none, so processing need not wait for the server's hold.
    func setCaptureContext(_ id: UUID, continuationID: UUID?, timeout: TimeInterval = 12) async throws {
        try await send(path: "v2/recordings/\(id)/context", method: "POST",
                       body: Self.encode(StopCaptureRequest(continuationID: continuationID)), timeout: timeout)
    }
    func health() async throws -> ServerHealth { try await json(path: "v1/health") }
    func preferences() async throws -> PreferencesSnapshot { try await json(path: "v1/preferences") }
    func updatePreferences(_ value: PreferencesSnapshot) async throws -> PreferencesSnapshot {
        try await json(path: "v1/preferences", method: "PUT", body: Self.encode(value))
    }
    func history(before cursor: String? = nil, source: String? = nil) async throws -> GenerationPage {
        var query: [URLQueryItem] = []
        if let cursor { query.append(URLQueryItem(name: "before", value: cursor)) }
        if let source { query.append(URLQueryItem(name: "source", value: source)) }
        let (data, response) = try await session.data(for: request(path: "v1/generations", query: query))
        try Self.validate(response, data: data)
        guard data.count <= 16 * 1_024 * 1_024 else { throw ServerClientError.invalidResponse }
        return try SottoDuoAPI.decodeWire(GenerationPage.self, from: data)
    }

    func knownWisprFlowSourceIDs(_ sourceIDs: [UUID]) async throws -> Set<UUID> {
        var known = Set<UUID>()
        // The server's 256 KiB JSON body limit is tighter than its 10,000-ID limit.
        for start in stride(from: 0, to: sourceIDs.count, by: 5_000) {
            let batch = Array(sourceIDs[start..<min(start + 5_000, sourceIDs.count)])
            let input = WisprFlowKnownIDsRequest(sourceIDs: batch)
            let result: WisprFlowKnownIDsResponse = try await json(
                path: "v1/imports/wispr-flow/known", method: "POST", body: Self.encode(input))
            known.formUnion(result.knownSourceIDs)
        }
        return known
    }

    func beginWisprFlowImport(_ value: WisprFlowImportRequest) async throws -> WisprFlowImportSession {
        try await json(path: "v1/imports/wispr-flow", method: "POST", body: Self.encode(value))
    }

    func uploadWisprFlowArtifact(_ url: URL, filename: WisprFlowArtifactName,
                                 contentType: String, to importID: UUID) async throws -> WisprFlowArtifactReceipt {
        let upload = try request(path: "v1/imports/wispr-flow/\(importID)/artifacts/\(filename.rawValue)",
                                 method: "PUT", contentType: contentType)
        let (data, response) = try await session.upload(for: upload, fromFile: url)
        try Self.validate(response, data: data)
        return try SottoDuoAPI.decodeWire(WisprFlowArtifactReceipt.self, from: data)
    }

    func completeWisprFlowImport(_ importID: UUID) async throws -> WisprFlowImportResult {
        try await json(path: "v1/imports/wispr-flow/\(importID)/complete", method: "POST")
    }

    func cancelWisprFlowImport(_ importID: UUID) async throws {
        try await send(path: "v1/imports/wispr-flow/\(importID)", method: "DELETE")
    }

    func archiveWisprFlowDictionary(_ url: URL) async throws -> WisprFlowDictionaryArchiveReceipt {
        let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard (1...WisprFlowImportLimits.maximumDictionaryBytes).contains(bytes) else {
            throw ServerClientError.dictionaryArchiveTooLarge(bytes)
        }
        let upload = try request(path: "v1/imports/wispr-flow/dictionary", method: "PUT", contentType: "application/json")
        let (data, response) = try await session.upload(for: upload, fromFile: url)
        try Self.validate(response, data: data)
        return try SottoDuoAPI.decodeWire(WisprFlowDictionaryArchiveReceipt.self, from: data)
    }

    static func wisprFlowArtifactManifest(filename: WisprFlowArtifactName, url: URL) throws -> WisprFlowArtifactManifest {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard (1...WisprFlowImportLimits.maximumArtifactBytes).contains(size) else {
            throw ServerClientError.importArtifactTooLarge(filename, size)
        }
        let input = try FileHandle(forReadingFrom: url)
        defer { try? input.close() }
        var hash = SHA256()
        var byteCount = 0
        while let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty {
            hash.update(data: chunk)
            byteCount += chunk.count
        }
        let sha256 = hash.finalize().map { String(format: "%02x", $0) }.joined()
        return WisprFlowArtifactManifest(filename: filename, byteCount: byteCount, sha256: sha256)
    }
    func generation(_ id: UUID, timeout: TimeInterval = 12) async throws -> GenerationRecord {
        try await json(path: "v1/generations/\(id)", timeout: timeout)
    }
    func retry(_ id: UUID) async throws -> GenerationRecord {
        try await json(path: "v1/generations/\(id)/retry", method: "POST")
    }
    func delete(_ id: UUID) async throws {
        try await send(path: "v1/generations/\(id)", method: "DELETE")
    }
    func audio(_ id: UUID, kind: AudioKind) async throws -> URL {
        let filename = "\(kind.rawValue).wav"
        let (temporary, response) = try await session.download(for: request(path: "v1/generations/\(id)/artifacts/\(filename)"))
        try Self.validate(response)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SottoDuo-remote-preview", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let destination = directory.appendingPathComponent("\(id)-\(filename)")
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        return destination
    }

    func wisprFlowArtifact(_ id: UUID, filename: WisprFlowArtifactName) async throws -> URL {
        let (temporary, response) = try await session.download(for: request(path: "v1/generations/\(id)/artifacts/\(filename.rawValue)"))
        try Self.validate(response)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SottoDuo-remote-preview", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let destination = directory.appendingPathComponent("\(id)-\(filename.rawValue)")
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        return destination
    }

    /// `recover` reconnects after transient stream loss.
    func events(_ id: UUID, recover: Bool = true,
                onUpdate: @escaping @Sendable (GenerationRecord) async -> Void) async throws -> GenerationRecord {
        try await follow(path: "v1/generations/\(id)/events", recover: recover,
                         decode: { try? SottoDuoAPI.decodeWire(GenerationRecord.self, from: $0) },
                         matches: { $0.id == id }, isFinal: { $0.status.isTerminal },
                         fetch: { try await generation(id) }, onUpdate: onUpdate)
    }

    /// `recover` reconnects after transient stream loss. A recording remote
    /// capture opts out: its event loss fails the take rather than authorizing
    /// a delayed insertion.
    func recordingEvents(_ id: UUID, recover: Bool = true,
                         onUpdate: @escaping @Sendable (RecordingSnapshot) async -> Void) async throws -> RecordingSnapshot {
        try await follow(path: "v2/recordings/\(id)/events", recover: recover,
                         decode: { try? RecordingWire.decoder().decode(RecordingSnapshot.self, from: $0) },
                         matches: { $0.id == id }, isFinal: \.isSettled,
                         fetch: { try await recording(id) }, onUpdate: onUpdate)
    }

    private func follow<Value: Sendable>(path: String, recover: Bool, decode: @escaping @Sendable (Data) -> Value?,
                                         matches: @escaping @Sendable (Value) -> Bool,
                                         isFinal: @escaping @Sendable (Value) -> Bool,
                                         fetch: @escaping @Sendable () async throws -> Value,
                                         onUpdate: @escaping @Sendable (Value) async -> Void) async throws -> Value {
        var recoveryFailures = 0
        while true {
            try Task.checkCancellation()
            do { return try await readEvents(path: path, decode: decode, matches: matches, isFinal: isFinal, onUpdate: onUpdate) }
            catch {
                try Task.checkCancellation()
                guard recover, Self.isTransient(error) else { throw error }
            }
            // A queue can outlive URLSession's request/resource timeout. Read
            // the durable state before reconnecting; a completed result must
            // still be delivered even if its final stream frame was lost.
            do {
                let value = try await fetch()
                guard matches(value) else { throw ServerClientError.invalidResponse }
                try Task.checkCancellation()
                await onUpdate(value)
                if isFinal(value) { return value }
                recoveryFailures = 0
            } catch {
                try Task.checkCancellation()
                guard Self.isTransient(error) else { throw error }
                recoveryFailures += 1
                guard recoveryFailures < 5 else { throw error }
            }
            try await Task.sleep(for: .seconds(min(8, 1 << recoveryFailures)))
        }
    }

    private static func isTransient(_ error: Error) -> Bool {
        if let error = error as? URLError {
            return [.timedOut, .networkConnectionLost, .notConnectedToInternet,
                    .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(error.code)
        }
        if let error = error as? ServerClientError {
            switch error {
            case .disconnected: return true
            case .rejected(let status, _): return [408, 429, 502, 503, 504].contains(status)
            default: return false
            }
        }
        return false
    }

    private func readEvents<Value>(path: String, decode: (Data) -> Value?, matches: (Value) -> Bool,
                                   isFinal: (Value) -> Bool,
                                   onUpdate: @Sendable (Value) async -> Void) async throws -> Value {
        var request = try request(path: path)
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        try Self.validate(response)
        // Parse bounded bytes rather than .lines, whose buffer has no upper limit.
        var line = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            if byte == 10 {
                if !line.isEmpty {
                    guard let value = decode(line), matches(value) else { throw ServerClientError.invalidResponse }
                    await onUpdate(value)
                    if isFinal(value) { return value }
                    line.removeAll(keepingCapacity: true)
                }
            } else {
                guard line.count < 2 * 1_024 * 1_024 else { throw ServerClientError.invalidResponse }
                line.append(byte)
            }
        }
        throw ServerClientError.disconnected
    }
}

extension RecordingSnapshot {
    /// No further capture or processing changes will arrive.
    var isSettled: Bool { captureState == .discarded || processingState == .completed || processingState == .failed }
}

/// The long-recording contract is versioned independently of legacy generated
/// wire models. Requests still use this take's immutable endpoint/credential.
extension ServerClient {
    private func recordingJSON<Response: Decodable>(path: String, method: String = "GET", body: Data? = nil,
                                                    query: [URLQueryItem] = [], timeout: TimeInterval = 12,
                                                    maxBytes: Int = 16 * 1_024 * 1_024) async throws -> Response {
        var request = try request(path: path, method: method, body: body, query: query)
        request.timeoutInterval = timeout
        let (data, response) = try await session.data(for: request)
        try Self.validate(response, data: data)
        guard data.count <= maxBytes else { throw ServerClientError.invalidResponse }
        do { return try RecordingWire.decoder().decode(Response.self, from: data) }
        catch { throw ServerClientError.invalidResponse }
    }

    func recordingCapabilities() async throws -> RecordingCapabilities {
        try await recordingJSON(path: "v2/recordings/capabilities")
    }

    func createRecording(_ value: CreateGenerationRequest) async throws -> RecordingSnapshot {
        try await recordingJSON(path: "v2/recordings", method: "POST", body: RecordingWire.encoder().encode(value))
    }

    func recordingDetail(_ id: UUID) async throws -> RecordingDetail {
        // The server stores a completed result of up to 64 MiB beside the snapshot.
        try await recordingJSON(path: "v2/recordings/\(id)", maxBytes: 80 * 1_024 * 1_024)
    }

    func recording(_ id: UUID) async throws -> RecordingSnapshot { try await recordingDetail(id).snapshot }

    func recordingHistory(before cursor: String? = nil, source: String? = nil) async throws -> RecordingPage {
        let query = cursor.map { [URLQueryItem(name: "before", value: $0)] } ?? []
        return try await recordingJSON(path: "v2/recordings", query: query)
    }

    func discardRecording(_ id: UUID, timeout: TimeInterval = 12) async throws {
        try await send(path: "v2/recordings/\(id)/discard", method: "POST", timeout: timeout)
    }

    /// An explicit cancel must win over the server sealing an expired lease, so a
    /// discard that fails transiently keeps retrying through a brief outage.
    func discardRecordingRetrying(_ id: UUID,
                                  delays: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15)]) async {
        for delay in [Duration.zero] + delays {
            try? await Task.sleep(for: delay)
            do { try await discardRecording(id); return }
            catch { guard Self.isTransient(error) else { return } }
        }
    }

    func retryRecording(_ id: UUID) async throws -> RecordingSnapshot {
        try await recordingJSON(path: "v2/recordings/\(id)/retry", method: "POST")
    }

    func recordingDelivery(_ id: UUID, receipt: DeliveryReceipt) async throws {
        try await send(path: "v2/recordings/\(id)/delivery", method: "POST", body: RecordingWire.encoder().encode(receipt))
    }

    func materializedRecording(_ id: UUID) async throws -> GenerationRecord {
        let detail = try await recordingDetail(id)
        if let result = detail.result { return result }
        return Self.generationSummary(detail.snapshot)
    }

    static func generationSummary(_ snapshot: RecordingSnapshot) -> GenerationRecord {
        let status: GenerationStatus
        if snapshot.captureState == .discarded { status = .cancelled }
        else if snapshot.processingState == .completed { status = .completed }
        else if snapshot.processingState == .failed { status = .failed }
        else if snapshot.captureState == .recording { status = .receiving }
        else if snapshot.processingState == .processing { status = .transcribing }
        else { status = .queued }
        var result = GenerationRecord(id: snapshot.id, requestID: snapshot.requestID, device: snapshot.device,
                                      mode: snapshot.mode, status: status, createdAt: snapshot.createdAt,
                                      settings: snapshot.settings)
        result.previewText = snapshot.previewText
        if snapshot.uploadedFrames > 0, snapshot.uploadedFrames <= Int64.max / 4 {
            result.inferenceAudio = AudioArtifact(filename: "inference.wav", sampleRate: 16_000, channels: 1,
                                                 frameCount: snapshot.uploadedFrames, byteCount: snapshot.uploadedFrames * 4)
        }
        result.error = snapshot.error
        result.progress = snapshot.uploadedFrames > 0
            ? min(1, Double(snapshot.transcribedFrames) / Double(snapshot.uploadedFrames)) : nil
        return result
    }

    func recordingWebSocketRequest(_ id: UUID) throws -> URLRequest {
        var result = try request(path: "v2/recordings/\(id)/stream")
        guard let url = result.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme else { throw ServerClientError.invalidEndpoint }
        switch scheme.lowercased() {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: throw ServerClientError.invalidEndpoint
        }
        guard let target = components.url else { throw ServerClientError.invalidEndpoint }
        result.url = target
        result.timeoutInterval = 15
        result.setValue("sottoduo.recording.v1", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        return result
    }
}

extension ServerClient {
    func recordingAudio(_ id: UUID, kind: AudioKind, runID: UUID? = nil) async throws -> URL {
        let suffix = runID.map { "/\($0)" } ?? ""
        var request = try request(path: "v2/recordings/\(id)/audio/\(kind.rawValue)\(suffix)")
        // The server rebuilds the whole WAV before sending headers.
        request.timeoutInterval = 300
        let (temporary, response) = try await session.download(for: request)
        try Self.validate(response)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SottoDuo-remote-preview", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let runSuffix = runID.map { "-\($0)" } ?? ""
        let destination = directory.appendingPathComponent("\(id)-\(kind.rawValue)\(runSuffix).wav")
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        return destination
    }
}
