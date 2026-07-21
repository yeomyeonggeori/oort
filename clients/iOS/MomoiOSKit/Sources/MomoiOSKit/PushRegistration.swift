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

public enum APNSRegistrationEnvironment: String, Sendable {
    case sandbox
    case production

    public static func from(apsEnvironment: String?) -> Self? {
        switch apsEnvironment?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "development": .sandbox
        case "production": .production
        default: nil
        }
    }
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
    private let store: SessionStore

    public init(
        urlSession: URLSession = .shared,
        store: SessionStore = .shared
    ) {
        self.urlSession = urlSession
        self.store = store
    }

    public func register(
        session: IOSSession,
        deviceID: UUID,
        apnsToken: Data,
        appBuild: String?,
        environment: APNSRegistrationEnvironment
    ) async throws {
        let request = try Self.registrationRequest(
            session: session,
            deviceID: deviceID,
            apnsToken: apnsToken,
            appBuild: appBuild,
            environment: environment
        )
        try await execute(request, authenticated: session)
    }

    public func revoke(session: IOSSession, deviceID: UUID) async throws {
        try await execute(
            Self.revocationRequest(session: session, deviceID: deviceID),
            authenticated: session
        )
    }

    static func registrationRequest(
        session: IOSSession,
        deviceID: UUID,
        apnsToken: Data,
        appBuild: String?,
        environment: APNSRegistrationEnvironment
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
            env: environment.rawValue,
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

    private func execute(_ request: URLRequest, authenticated: IOSSession) async throws {
        do {
            _ = try await IOSAuthenticatedRequestExecutor(
                authenticated: authenticated,
                store: store,
                urlSession: urlSession
            ).data(for: request)
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
    public let threadRootID: MessageID?
    public let category: MomoPushCategory

    public var opensWorkSession: Bool { category == .work }

    public init?(envelope: MomoPushEnvelope) {
        guard let workspaceID = WorkspaceID(uuidString: envelope.workspaceID.lowercased()),
              let channelID = ChannelID(uuidString: envelope.channelID.lowercased()),
              let messageID = MessageID(uuidString: envelope.messageID.lowercased())
        else { return nil }
        self.workspaceID = workspaceID
        self.channelID = channelID
        self.messageID = messageID
        self.threadRootID = envelope.threadRootID.flatMap {
            MessageID(uuidString: $0.lowercased())
        }
        self.category = envelope.category
    }

    public init?(url: URL) {
        guard url.scheme == "momo", url.host == "push" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 6,
              parts[0] == "workspaces", parts[2] == "channels", parts[4] == "messages",
              let workspaceID = WorkspaceID(uuidString: parts[1].lowercased()),
              let channelID = ChannelID(uuidString: parts[3].lowercased()),
              let messageID = MessageID(uuidString: parts[5].lowercased())
        else { return nil }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = components?.queryItems ?? []
        guard Set(queryItems.map(\.name)).count == queryItems.count else { return nil }
        let allowedQueryNames: Set<String> = ["category", "thread"]
        guard Set(queryItems.map(\.name)).isSubset(of: allowedQueryNames) else { return nil }
        let values = queryItems.reduce(into: [String: String]()) { values, item in
            if let value = item.value { values[item.name] = value }
        }
        let rawCategory = values["category"]
        let parsedCategory = rawCategory.flatMap(MomoPushCategory.init(rawValue:))
        if rawCategory != nil, parsedCategory == nil { return nil }
        let category = parsedCategory ?? .message
        let threadRootID = values["thread"].flatMap {
            MessageID(uuidString: $0.lowercased())
        }
        if values["thread"] != nil, threadRootID == nil { return nil }
        self.workspaceID = workspaceID
        self.channelID = channelID
        self.messageID = messageID
        self.threadRootID = threadRootID
        self.category = category
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

    public func route(link: IOSPushDeepLink) {
        pending = link
    }

    public func route(url: URL) {
        pending = IOSPushDeepLink(url: url)
    }

    /// Returns and clears a pending link only when its workspace is signed in.
    /// Passing `nil` deliberately keeps the link for post-login routing.
    public func consumePending(for signedInWorkspaceID: WorkspaceID?) -> IOSPushDeepLink? {
        guard let pending, pending.workspaceID == signedInWorkspaceID else { return nil }
        self.pending = nil
        return pending
    }
}
