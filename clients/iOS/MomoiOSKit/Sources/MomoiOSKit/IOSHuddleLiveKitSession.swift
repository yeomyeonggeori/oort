import AVFAudio
import Foundation
import LiveKit

public struct IOSSystemMicrophonePermissionAuthorizer: IOSMicrophonePermissionAuthorizing {
    public init() {}

    public func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }
}

public final class IOSHuddleLiveKitSession: NSObject, IOSHuddleAudioSession, RoomDelegate, @unchecked Sendable {
    private let room: Room
    private let lock = NSLock()
    private var participantContinuations: [UUID: AsyncStream<[IOSHuddleAudioParticipant]>.Continuation] = [:]

    public override init() {
        room = Room()
        super.init()
        room.add(delegate: self)
    }

    deinit {
        room.remove(delegate: self)
        lock.withLock {
            participantContinuations.values.forEach { $0.finish() }
            participantContinuations.removeAll()
        }
    }

    public func connect(url: URL, token: String) async throws {
        if room.connectionState != .disconnected { await room.disconnect() }
        try await room.connect(url: url.absoluteString, token: token)
        try await room.localParticipant.setMicrophone(enabled: true)
        emitParticipants()
    }

    public func disconnect() async {
        if room.connectionState != .disconnected { await room.disconnect() }
        emitParticipants()
    }

    public func setMicrophoneMuted(_ muted: Bool) async throws {
        try await room.localParticipant.setMicrophone(enabled: !muted)
        emitParticipants()
    }

    public func participantUpdates() async -> AsyncStream<[IOSHuddleAudioParticipant]> {
        AsyncStream { continuation in
            let id = UUID()
            lock.withLock { participantContinuations[id] = continuation }
            continuation.yield(snapshot())
            continuation.onTermination = { [weak self] _ in
                self?.lock.withLock { self?.participantContinuations[id] = nil }
            }
        }
    }

    public func roomDidConnect(_ room: Room) { emitParticipants() }
    public func room(_ room: Room, participantDidConnect participant: RemoteParticipant) { emitParticipants() }
    public func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) { emitParticipants() }
    public func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) { emitParticipants() }

    private func emitParticipants() {
        let value = snapshot()
        let continuations = lock.withLock { Array(participantContinuations.values) }
        continuations.forEach { $0.yield(value) }
    }

    private func snapshot() -> [IOSHuddleAudioParticipant] {
        let localIdentity = room.localParticipant.identity
        return room.allParticipants.values.map { participant in
            let identity = participant.identity?.stringValue ?? participant.sid?.stringValue ?? "unknown"
            return IOSHuddleAudioParticipant(
                id: identity,
                displayName: participant.name ?? identity,
                isSpeaking: participant.isSpeaking,
                isLocal: participant.identity == localIdentity
            )
        }.sorted {
            if $0.isLocal != $1.isLocal { return $0.isLocal }
            return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }
}
