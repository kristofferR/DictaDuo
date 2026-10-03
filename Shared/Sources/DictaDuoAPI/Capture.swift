import Foundation
import DictaDuoAPIWire

public typealias AudioSourceIdentity = Components.Schemas.AudioSourceIdentity
public typealias AudioSource = Components.Schemas.AudioSource
public typealias AudioSourceList = Components.Schemas.AudioSourceList
public typealias RemoteCapture = Components.Schemas.RemoteCapture
public typealias SharingHost = Components.Schemas.SharingHost

extension AudioSourceList: APIWireModel { public typealias Wire = Self }

extension AudioSource {
    /// USB presence and transmitter link alone do not prove healthy audio.
    public func isEligible(at now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(observedAt)
        return age >= 0 && age <= 3.5 && present && capture == .available
            && (link == .connected || link == .notApplicable) && audioHealth != .degraded
    }
}

public enum CaptureMode: String, Codable, Sendable { case dictation, test }

public struct StartCaptureRequest: Codable, Sendable, APIWireModel {
    public typealias Wire = Components.Schemas.StartCaptureRequest
    public var requestID: UUID
    public var device: DeviceIdentity
    public var mode: CaptureMode
    public var source: AudioSourceIdentity
    public var buttonTicket: UUID?

    public init(requestID: UUID, device: DeviceIdentity, mode: CaptureMode, source: AudioSourceIdentity, buttonTicket: UUID? = nil) {
        self.requestID = requestID; self.device = device; self.mode = mode; self.source = source; self.buttonTicket = buttonTicket
    }
}

public struct StopCaptureRequest: Codable, Sendable, APIWireModel {
    public typealias Wire = Components.Schemas.StopCaptureRequest
    public var continuationID: UUID?
    public init(continuationID: UUID? = nil) { self.continuationID = continuationID }
}

public typealias ButtonDestinationState = Components.Schemas.ButtonDestinationState
public typealias ButtonCommand = Components.Schemas.ButtonCommand
public typealias RegisterButtonDestination = Components.Schemas.RegisterButtonDestination
public typealias HeartbeatButtonDestination = Components.Schemas.HeartbeatButtonDestination
public typealias SelectButtonDestination = Components.Schemas.SelectButtonDestination
public typealias CompleteButtonTake = Components.Schemas.CompleteButtonTake
public typealias ButtonTarget = Components.Schemas.ButtonTarget
extension ButtonDestinationState: APIWireModel { public typealias Wire = Self }
extension RegisterButtonDestination: APIWireModel { public typealias Wire = Self }
extension HeartbeatButtonDestination: APIWireModel { public typealias Wire = Self }
extension SelectButtonDestination: APIWireModel { public typealias Wire = Self }
extension CompleteButtonTake: APIWireModel { public typealias Wire = Self }
extension ButtonTarget: APIWireModel { public typealias Wire = Self }
