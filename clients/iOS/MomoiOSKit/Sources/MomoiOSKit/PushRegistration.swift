import Foundation
import MomoCore
import MomoiOSPushKit
import Observation

public protocol IOSPushLifecycle: AnyObject {
    @MainActor func activate(session: IOSSession) async
    @MainActor func revoke(session: IOSSession) async
}

@MainActor
public final class NoopIOSPushLifecycle: IOSPushLifecycle {
    public static let shared = NoopIOSPushLifecycle()

    private init() {}

    public func activate(session: IOSSession) async {}
    public func revoke(session: IOSSession) async {}
}

public actor MomoPushRegistrationClient {
    public static let topic = "app.momo.ios"

    private struct RegisterBody: Encodable {
        let deviceId: String
        let platform: String
        let appBuild: String?
        let apnsToken: String
        let env: String
        let topic: String
    }

    private let urlSession: URLSession

    public init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    public func register(
        session: IOSSession,
        deviceID: UUID,
        apnsToken: Data,
        appBuild: String?
    ) async throws {
        let request = try Self.registrationRequest(
            session: session,
            deviceID: deviceID,
            apnsToken: apnsToken,
            appBuild: appBuild
        )
        try await execute(request)
    }

    public func revoke(session: IOSSession, deviceID: UUID) async throws {
        try await execute(Self.revocationRequest(session: session, deviceID: deviceID))
    }

    static func registrationRequest(
        session: IOSSession,
        deviceID: UUID,
        apnsToken: Data,
        appBuild: String?
    ) throws -> URLRequest {
        let path = "/v1/workspaces/\(session.workspaceID.description)/devices"
        var request = URLRequest(url: session.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RegisterBody(
            deviceId: deviceID.uuidString,
            platform: "ios",
            appBuild: appBuild,
            apnsToken: apnsToken.map { String(format: "%02x", $0) }.joined(),
            env: "sandbox",
            topic: topic
        ))
        return request
    }

    static func revocationRequest(session: IOSSession, deviceID: UUID) -> URLRequest {
        let path = "/v1/workspaces/\(session.workspaceID.description)/devices/\(deviceID.uuidString)"
        var request = URLRequest(url: session.baseURL.appendingPathComponent(path))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func execute(_ request: URLRequest) async throws {
        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw SessionError.transport("The server did not return an HTTP response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let message = String(data: data, encoding: .utf8)
                    ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                throw SessionError.server(status: http.statusCode, message: message)
            }
        } catch let error as SessionError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SessionError.transport("Could not update this device's push registration.")
        }
    }
}

public struct IOSPushDeepLink: Hashable, Sendable {
    public let workspaceID: WorkspaceID
    public let channelID: ChannelID
    public let messageID: MessageID

    public init?(envelope: MomoPushEnvelope) {
        guard let workspaceID = WorkspaceID(uuidString: envelope.workspaceID),
              let channelID = ChannelID(uuidString: envelope.channelID),
              let messageID = MessageID(uuidString: envelope.messageID)
        else { return nil }
        self.workspaceID = workspaceID
        self.channelID = channelID
        self.messageID = messageID
    }

    public init?(url: URL) {
        guard url.scheme == "momo", url.host == "push" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 6,
              parts[0] == "workspaces", parts[2] == "channels", parts[4] == "messages",
              let workspaceID = WorkspaceID(uuidString: parts[1]),
              let channelID = ChannelID(uuidString: parts[3]),
              let messageID = MessageID(uuidString: parts[5])
        else { return nil }
        self.workspaceID = workspaceID
        self.channelID = channelID
        self.messageID = messageID
    }
}

@MainActor
@Observable
public final class IOSPushDeepLinkRouter {
    public static let shared = IOSPushDeepLinkRouter()

    public private(set) var pending: IOSPushDeepLink?

    public init() {}

    public func route(userInfo: [AnyHashable: Any]) {
        guard let envelope = try? MomoPushParser.parse(userInfo: userInfo),
              let link = IOSPushDeepLink(envelope: envelope) else { return }
        pending = link
    }

    public func route(url: URL) {
        pending = IOSPushDeepLink(url: url)
    }

    public func consume(_ link: IOSPushDeepLink) {
        if pending == link { pending = nil }
    }
}
