import AppKit
import XCTest
@testable import DictaDuo

final class InsertionAccessibilityWarmupTests: XCTestCase {
    @MainActor
    func testRepeatedAppActivationDoesNotRestartElectronDebounce() async throws {
        let application = try XCTUnwrap(NSWorkspace.shared.frontmostApplication)
        let requested = expectation(description: "Accessibility requested once")
        requested.assertForOverFulfill = true
        let warmup = InsertionAccessibilityWarmup(isTrusted: { true }, request: { _ in requested.fulfill() })
        defer { warmup.stop() }

        let first = try XCTUnwrap(warmup.prepare(application))
        let repeated = try XCTUnwrap(warmup.prepare(application))
        await first.value
        await repeated.value
        await fulfillment(of: [requested], timeout: 2)
        let later = try XCTUnwrap(warmup.prepare(application))
        await later.value
    }

    @MainActor
    func testWarmupCanRetryAfterTheReadinessWindow() async throws {
        let application = try XCTUnwrap(NSWorkspace.shared.frontmostApplication)
        var time: TimeInterval = 0
        let requested = expectation(description: "Accessibility requested again after expiry")
        requested.expectedFulfillmentCount = 2
        requested.assertForOverFulfill = true
        let warmup = InsertionAccessibilityWarmup(isTrusted: { true }, request: { _ in requested.fulfill() }, now: { time })
        defer { warmup.stop() }

        let first = try XCTUnwrap(warmup.prepare(application))
        await first.value
        time = InsertionPreparation.readinessSeconds
        let retried = try XCTUnwrap(warmup.prepare(application))
        await retried.value

        await fulfillment(of: [requested], timeout: 2)
    }

    @MainActor
    func testPermissionGrantCanPrepareTheAlreadyFocusedApp() async throws {
        let application = try XCTUnwrap(NSWorkspace.shared.frontmostApplication)
        var trusted = false
        let requested = expectation(description: "Accessibility requested after permission grant")
        requested.assertForOverFulfill = true
        let warmup = InsertionAccessibilityWarmup(isTrusted: { trusted }, request: { _ in requested.fulfill() })
        defer { warmup.stop() }

        XCTAssertNil(warmup.prepare(application))
        trusted = true
        let task = try XCTUnwrap(warmup.prepare(application))
        await task.value

        await fulfillment(of: [requested], timeout: 2)
    }
}
