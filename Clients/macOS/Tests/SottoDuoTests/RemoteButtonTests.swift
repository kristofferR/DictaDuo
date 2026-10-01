import Foundation
import SottoDuoAPI
import XCTest
@testable import SottoDuo

@MainActor
final class RemoteButtonTests: XCTestCase {
    func testRegistrationDoesNotSelectAndDuplicateCommandsAreAcknowledgedOnce() async throws {
        // Closing the client sends a detached lease DELETE that can outlive the test,
        // so the session stays valid instead of being invalidated on exit.
        let fixture = HTTPFixture()
        let ticket = UUID()
        let command = ButtonCommand(id: UUID(), takeID: ticket, action: .start,
            source: .init(hostID: "desktop", id: "dji"), expiresAt: Date().addingTimeInterval(5))
        fixture.respond = { request in
            let state = ButtonDestinationState(destinations: [], available: true,
                command: request.url!.path.hasSuffix("/heartbeat") ? command : nil)
            return (200, try ServerClient.encode(state))
        }
        var commands: [UUID] = []
        let client = RemoteButtonDestination(
            connection: try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session),
            device: .init(id: "mac", name: "Mac"), available: { true },
            receive: { commands.append($0.takeID); return true }, cancelled: {}, changed: { _ in })
        defer { client.close() }
        try await client.tick(); try await client.tick()
        XCTAssertEqual(commands, [ticket])
        XCTAssertFalse(fixture.requests.contains { $0.url!.path.hasSuffix("/select") })
        let secret = try XCTUnwrap(fixture.requests.first?.value(forHTTPHeaderField: "X-SottoDuo-Destination-Owner"))
        XCTAssertEqual(secret.count, 64)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.value(forHTTPHeaderField: "X-SottoDuo-Capture-Owner") == nil })
        XCTAssertTrue(fixture.requests.allSatisfy { !$0.url!.absoluteString.contains(secret) })
    }

    func testUnavailableClientDropsLeaseAndRejectsExpiredStart() async throws {
        let fixture = HTTPFixture()
        fixture.respond = { _ in
            (200, try ServerClient.encode(ButtonDestinationState(destinations: [], available: true,
                command: .init(id: UUID(), takeID: UUID(), action: .start,
                    source: .init(hostID: "desktop", id: "dji"), expiresAt: Date().addingTimeInterval(-1)))))
        }
        var available = true, received = 0, cancelled = 0
        let client = RemoteButtonDestination(
            connection: try ServerClient(endpoint: fixture.endpoint, token: "", session: fixture.session),
            device: .init(id: "mac", name: "Mac"), available: { available },
            receive: { _ in received += 1; return true }, cancelled: { cancelled += 1 }, changed: { _ in })
        defer { client.close() }
        try await client.tick()
        XCTAssertEqual(received, 0)
        XCTAssertEqual(cancelled, 1)
        available = false
        try await client.tick()
        XCTAssertEqual(received, 0)
        do { try await client.select(); XCTFail("Locked clients cannot select themselves") }
        catch ServerClientError.disconnected { }
    }
}
