import SottoDuoAPI
import XCTest
@testable import SottoDuo

final class ServerModelStatusTests: XCTestCase {
    func testStatusAndNameComeFromHealthRuntimes() {
        let whisper = ModelRuntimeInfo(modelID: "whisper-large-v3-turbo", backend: "whisper.cpp/Metal", ready: false)
        let qwen = ModelRuntimeInfo(modelID: "Qwen3-4B-Instruct-2507", backend: "MLX", ready: false, message: "Loading…")
        let health = ServerHealth(ready: true, speech: whisper, proofreading: qwen, message: "Server ready.")
        XCTAssertEqual(ServerModelStatus(qwen, health: health), .loading)
        XCTAssertEqual(ServerModelStatus(qwen, health: health, enabled: false), .off)
        XCTAssertEqual(ServerModelStatus(whisper, health: health), .unavailable)
        var warming = health
        warming.message = "Loading server models…"
        XCTAssertEqual(ServerModelStatus(whisper, health: warming), .loading)
        var ready = whisper
        ready.ready = true
        XCTAssertEqual(ServerModelStatus(ready, health: health), .ready)

        XCTAssertEqual(whisper.friendlyName, "Whisper large-v3-turbo")
        XCTAssertEqual(qwen.friendlyName, "Qwen3 4B")
        XCTAssertEqual(ModelRuntimeInfo(modelID: "parakeet-tdt-0.6b-v3", backend: "parakeet.cpp", ready: true).friendlyName,
                       "Parakeet v3")
        XCTAssertEqual(ModelRuntimeInfo(modelID: "stt-rt-v5", backend: "soniox/websocket", ready: true).friendlyName, "Soniox")
    }
}
