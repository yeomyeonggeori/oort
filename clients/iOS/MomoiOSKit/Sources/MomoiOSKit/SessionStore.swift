import Foundation
import MomoiOSPushKit

public final class SessionStore: @unchecked Sendable {
    public static let shared = SessionStore()

    private let defaults: UserDefaults
    private let legacyDefaults: UserDefaults?
    private let prefix: String
    private let secureStore: any MomoSecureValueStoring
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let lock = NSLock()

    public static let appGroupIdentifier = MomoPushContract.appGroupIdentifier

    public init(
        defaults: UserDefaults = UserDefaults(suiteName: SessionStore.appGroupIdentifier)!,
        prefix: String = "momo.ios.dev.session.",
        legacyDefaults: UserDefaults? = .standard,
        secureStore: any MomoSecureValueStoring = MomoKeychainValueStore()
    ) {
        self.defaults = defaults
        self.legacyDefaults = legacyDefaults
        self.prefix = prefix
        self.secureStore = secureStore
        migrateLegacyValuesOnce()
    }

    public func loadForm() -> SessionForm {
        lock.withLock {
            guard let data = defaults.data(forKey: key("form")),
                  let form = try? decoder.decode(SessionForm.self, from: data)
            else {
                return SessionForm()
            }
            return form
        }
    }

    public func save(form: SessionForm) {
        lock.withLock {
            // MOMO-452 keeps the internal-alpha login form in App Group defaults.
            // Session access/refresh tokens are deliberately excluded from this value.
            defaults.set(try? encoder.encode(form), forKey: key("form"))
        }
    }

    public func loadSession() -> IOSSession? {
        lock.withLock {
            guard let data = secureStore.data(for: MomoPushContract.authenticatedSessionAccount) else {
                return nil
            }
            return try? decoder.decode(IOSSession.self, from: data)
        }
    }

    /// Persists the rotated pair before it is exposed to request callers.
    /// A partial Keychain write fails closed and removes both records.
    @discardableResult
    public func save(session: IOSSession) -> Bool {
        lock.withLock {
            guard let sessionData = try? encoder.encode(session),
                  let pushData = try? encoder.encode(PushFetchSession(
                    baseURL: session.baseURL,
                    workspaceID: session.workspaceID.description,
                    accessToken: session.accessToken
                  )),
                  secureStore.set(sessionData, for: MomoPushContract.authenticatedSessionAccount),
                  secureStore.set(pushData, for: MomoPushContract.pushFetchSessionAccount)
            else {
                secureStore.removeValue(for: MomoPushContract.authenticatedSessionAccount)
                secureStore.removeValue(for: MomoPushContract.pushFetchSessionAccount)
                return false
            }
            removeLegacyTokenValues()
            return true
        }
    }

    public func clearSession() {
        lock.withLock {
            secureStore.removeValue(for: MomoPushContract.authenticatedSessionAccount)
            secureStore.removeValue(for: MomoPushContract.pushFetchSessionAccount)
            removeLegacyTokenValues()
        }
    }

    public func loadOrCreateDeviceID() -> UUID {
        lock.withLock {
            if let raw = defaults.string(forKey: key("device-id")), let id = UUID(uuidString: raw) {
                return id
            }
            let id = UUID()
            defaults.set(id.uuidString, forKey: key("device-id"))
            return id
        }
    }

    private func migrateLegacyValuesOnce() {
        lock.withLock {
            let marker = key("keychain-migration-v2")
            guard !defaults.bool(forKey: marker) else {
                removeLegacyTokenValues()
                return
            }

            if defaults.object(forKey: key("form")) == nil,
               let value = legacyDefaults?.object(forKey: key("form")) {
                defaults.set(value, forKey: key("form"))
            }

            if secureStore.data(for: MomoPushContract.authenticatedSessionAccount) == nil {
                let legacyData = defaults.data(forKey: key("authenticated"))
                    ?? legacyDefaults?.data(forKey: key("authenticated"))
                if let legacyData,
                   let session = try? decoder.decode(IOSSession.self, from: legacyData),
                   let pushData = try? encoder.encode(PushFetchSession(
                    baseURL: session.baseURL,
                    workspaceID: session.workspaceID.description,
                    accessToken: session.accessToken
                   )),
                   secureStore.set(legacyData, for: MomoPushContract.authenticatedSessionAccount) {
                    if !secureStore.set(pushData, for: MomoPushContract.pushFetchSessionAccount) {
                        secureStore.removeValue(for: MomoPushContract.authenticatedSessionAccount)
                    }
                }
            }

            // Delete plaintext credentials even if Keychain is unavailable: fail closed.
            removeLegacyTokenValues()
            defaults.set(true, forKey: marker)
        }
    }

    private func removeLegacyTokenValues() {
        defaults.removeObject(forKey: key("authenticated"))
        defaults.removeObject(forKey: MomoPushContract.sessionKey)
        legacyDefaults?.removeObject(forKey: key("authenticated"))
        legacyDefaults?.removeObject(forKey: MomoPushContract.sessionKey)
    }

    private func key(_ name: String) -> String { prefix + name }
}
