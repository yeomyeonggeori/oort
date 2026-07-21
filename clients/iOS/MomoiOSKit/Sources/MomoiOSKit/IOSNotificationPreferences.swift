import Foundation
import MomoiOSPushKit

public struct IOSNotificationActionPreferences: Codable, Equatable, Sendable {
    public var message = true
    public var mention = true
    public var approval = true
    public var work = true

    public init(message: Bool = true, mention: Bool = true, approval: Bool = true, work: Bool = true) {
        self.message = message
        self.mention = mention
        self.approval = approval
        self.work = work
    }

    public func isEnabled(_ category: MomoPushCategory) -> Bool {
        switch category {
        case .message: message
        case .mention: mention
        case .approval: approval
        case .work: work
        }
    }

    public mutating func set(_ category: MomoPushCategory, enabled: Bool) {
        switch category {
        case .message: message = enabled
        case .mention: mention = enabled
        case .approval: approval = enabled
        case .work: work = enabled
        }
    }
}

public final class IOSNotificationActionPreferenceStore: @unchecked Sendable {
    public static let shared = IOSNotificationActionPreferenceStore()

    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = UserDefaults(suiteName: MomoPushContract.appGroupIdentifier)!,
        key: String = "momo.ios.notification-action-preferences.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> IOSNotificationActionPreferences {
        guard let data = defaults.data(forKey: key),
              let value = try? JSONDecoder().decode(IOSNotificationActionPreferences.self, from: data)
        else { return IOSNotificationActionPreferences() }
        return value
    }

    public func save(_ value: IOSNotificationActionPreferences) {
        defaults.set(try? JSONEncoder().encode(value), forKey: key)
    }
}

#if os(iOS)
import UserNotifications

@MainActor
public enum IOSNotificationCategoryRegistry {
    public static func register(
        preferences: IOSNotificationActionPreferences = IOSNotificationActionPreferenceStore.shared.load(),
        center: UNUserNotificationCenter = .current()
    ) {
        let reply = UNTextInputNotificationAction(
            identifier: MomoPushActionIdentifier.quickReply,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Message"
        )
        let approve = UNNotificationAction(
            identifier: MomoPushActionIdentifier.approve,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let reject = UNNotificationAction(
            identifier: MomoPushActionIdentifier.reject,
            title: "Reject",
            options: [.authenticationRequired, .destructive]
        )

        var categories = Set<UNNotificationCategory>()
        if preferences.message {
            categories.insert(UNNotificationCategory(
                identifier: MomoPushCategory.message.rawValue,
                actions: [reply],
                intentIdentifiers: []
            ))
        }
        if preferences.mention {
            categories.insert(UNNotificationCategory(
                identifier: MomoPushCategory.mention.rawValue,
                actions: [reply],
                intentIdentifiers: []
            ))
        }
        if preferences.approval {
            categories.insert(UNNotificationCategory(
                identifier: MomoPushCategory.approval.rawValue,
                actions: [approve, reject],
                intentIdentifiers: []
            ))
        }
        if preferences.work {
            categories.insert(UNNotificationCategory(
                identifier: MomoPushCategory.work.rawValue,
                actions: [],
                intentIdentifiers: []
            ))
        }
        center.setNotificationCategories(categories)
    }
}
#endif
