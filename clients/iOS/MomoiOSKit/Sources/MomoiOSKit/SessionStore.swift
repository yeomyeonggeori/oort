import Foundation
import MomoiOSPushKit

public final class SessionStore: @unchecked Sendable {
    public static let shared = SessionStore()

    private let defaults: UserDefaults
    private let prefix: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public static let appGroupIdentifier = MomoPushContract.appGroupIdentifier

    public init(
        defaults: UserDefaults = UserDefaults(suiteName: SessionStore.appGroupIdentifier)!,
        prefix: String = "momo.ios.dev.session.",
        legacyDefaults: UserDefaults? = .standard
    ) {
        self.defaults = defaults
        self.prefix = prefix
        migrateLegacyValuesOnce(from: legacyDefaults)
    }

    public func loadForm() -> SessionForm {
        guard let data = defaults.data(forKey: key("form")),
              let form = try? decoder.decode(SessionForm.self, from: data)
        else {
            return SessionForm()
        }
        return form
    }

    public func save(form: SessionForm) {
        // MOMO-452 dev decision (성재, 2026-07-17): persist the development
        // credentials in UserDefaults. Do not introduce Keychain in IOS-1.
        defaults.set(try? encoder.encode(form), forKey: key("form"))
    }

    public func loadSession() -> IOSSession? {
        guard let data = defaults.data(forKey: key("authenticated")) else { return nil }
        return try? decoder.decode(IOSSession.self, from: data)
    }

    public func save(session: IOSSession) {
        defaults.set(try? encoder.encode(session), forKey: key("authenticated"))
        savePushFetchSession(for: session)
    }

    private func savePushFetchSession(for session: IOSSession) {
        let pushSession = PushFetchSession(
            baseURL: session.baseURL,
            workspaceID: session.workspaceID.description,
            accessToken: session.accessToken
        )
        defaults.set(try? encoder.encode(pushSession), forKey: MomoPushContract.sessionKey)
    }

    public func clearSession() {
        defaults.removeObject(forKey: key("authenticated"))
        defaults.removeObject(forKey: MomoPushContract.sessionKey)
    }

    public func loadOrCreateDeviceID() -> UUID {
        if let raw = defaults.string(forKey: key("device-id")), let id = UUID(uuidString: raw) {
            return id
        }
        let id = UUID()
        defaults.set(id.uuidString, forKey: key("device-id"))
        return id
    }

    private func migrateLegacyValuesOnce(from legacyDefaults: UserDefaults?) {
        let marker = key("app-group-migration-v1")
        guard !defaults.bool(forKey: marker) else { return }
        if let legacyDefaults {
            for name in ["form", "authenticated"] {
                let storageKey = key(name)
                if defaults.object(forKey: storageKey) == nil,
                   let value = legacyDefaults.object(forKey: storageKey) {
                    defaults.set(value, forKey: storageKey)
                }
            }
        }
        if defaults.object(forKey: MomoPushContract.sessionKey) == nil,
           let data = defaults.data(forKey: key("authenticated")),
           let session = try? decoder.decode(IOSSession.self, from: data) {
            savePushFetchSession(for: session)
        }
        defaults.set(true, forKey: marker)
    }

    private func key(_ name: String) -> String { prefix + name }
}
