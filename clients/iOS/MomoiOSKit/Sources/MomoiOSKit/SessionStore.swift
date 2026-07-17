import Foundation

public final class SessionStore: @unchecked Sendable {
    public static let shared = SessionStore()

    private let defaults: UserDefaults
    private let prefix: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(defaults: UserDefaults = .standard, prefix: String = "momo.ios.dev.session.") {
        self.defaults = defaults
        self.prefix = prefix
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
    }

    public func clearSession() {
        defaults.removeObject(forKey: key("authenticated"))
    }

    private func key(_ name: String) -> String { prefix + name }
}
