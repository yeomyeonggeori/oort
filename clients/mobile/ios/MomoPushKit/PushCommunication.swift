// =============================================================================
// Communication notifications for the notification extension (#4316, ADR-0204 증보 5).
//
// A push carries ids and nothing else (ADR-0204), so everything a communication notification shows —
// the sender's round photo with the app icon small at its corner, the conversation's name, the preview
// — is built here, in the extension, from the REST read (`PushResolution`) and the App Group cache
// (`MomoPushPresentationStore.swift`). Three layers, from the one that decides to the one that does:
//
//   1. `PushPresentationPlanner` — a pure function: what the notification says and whether it is
//      dressed as a communication notification (`PushCommunicationDescriptor`). Everything the design
//      table (#4316 설계 1) and the two switches (설계 3) decide is decided here, and `sim-check` runs it.
//   2. `PushPresentationAssembler` — reads the roster/message, the channel name, the switches and finds the
//      sender's photo in the fixed order cache → one bounded REST read → a drawn initial.
//   3. `PushCommunicationPresenter` (iOS only, Intents) — donates the interaction and applies it to the
//      content. It re-asks the switch AFTER the donation: a person who turned 「보낸 사람 표시」 off while
//      the extension was working must not end up with a donated interaction and a named notification.
//
// Adapted from block/buzz `mobile/ios/BuzzPushKit/Sources/BuzzPushKit/BuzzCommunicationNotification.swift`
// @ af5bb0a (https://github.com/block/buzz, Apache-2.0, Copyright 2026 Block, Inc.), layer 3 and the shape of
// the intent. Changed by oort (Apache-2.0 §4(b)):
//   · kept: INPerson as the sender with the picture as `image`; for a conversation with a name, the name as
//     `speakableGroupName`, the picture ALSO set as that parameter's image (a communication notification
//     draws a group's picture from there, and a channel has none of its own, so the sender's photo stands
//     in), and a recipient count in the donation metadata; donate first, update the content second; the
//     privacy fence is asked again after the donation and a broken fence deletes what was donated.
//   · changed: the descriptor is built by oort's planner from the roster and a REST read, not from a signed
//     relay event; the conversation identifier is `workspace/channel`; the service name is oort; a failed
//     donation or a failed update delivers the ordinary content instead of dropping the notification.
//   · added: layers 1 and 2, the switches, the photo order, the sender-hiding look.
// =============================================================================
import Foundation

// MARK: - words

public enum PushPresentationCopy {
    /// 「메시지 미리보기」 off, and 「보낸 사람 표시」 off: the body says only that something came.
    public static let hiddenBody = "새 메시지"
    /// Put before the text of a reply that lives in a thread (설계 1: 「앞에 스레드 표시」).
    public static let threadLabel = "스레드"
    public static let threadSeparator = " · "
    /// A channel's name is shown as `#name`, the way the app writes it.
    public static let channelPrefix = "#"

    static func threaded(_ body: String) -> String {
        threadLabel + threadSeparator + body
    }
}

// MARK: - what the planner decides

/// Everything an `INSendMessageIntent` is made of, as plain values. The Intents adapter below maps
/// them one to one, so what is checked here is what the system is given.
public struct PushCommunicationDescriptor: Equatable, Sendable {
    public let senderName: String
    /// `workspace/member`. Stable for a person, different for the same person in another workspace.
    public let senderIdentifier: String
    public let senderAvatarPNG: Data?
    public let messageBody: String
    /// `workspace/channel`. The same string for every message of one conversation — a thread's replies
    /// included — and never shared between two conversations.
    public let conversationIdentifier: String
    /// `#name` for a named room, nil for a conversation with one person.
    public let groupName: String?
    /// People the message went to besides its sender. Only read when there is a group name.
    public let recipientCount: Int
    public let isThreadReply: Bool

    public init(
        senderName: String, senderIdentifier: String, senderAvatarPNG: Data?, messageBody: String,
        conversationIdentifier: String, groupName: String?, recipientCount: Int, isThreadReply: Bool
    ) {
        self.senderName = senderName
        self.senderIdentifier = senderIdentifier
        self.senderAvatarPNG = senderAvatarPNG
        self.messageBody = messageBody
        self.conversationIdentifier = conversationIdentifier
        self.groupName = groupName
        self.recipientCount = recipientCount
        self.isThreadReply = isThreadReply
    }
}

public struct PushPresentation: Equatable, Sendable {
    /// What the notification says when it is NOT drawn as a communication notification (and what the
    /// extension writes into the content before the system re-dresses it).
    public let display: PushDisplayContent
    /// nil: an ordinary notification.
    public let communication: PushCommunicationDescriptor?
    /// False when a switch replaced the text with 「새 메시지」. The extension hands the original category
    /// (the buttons) back to a notification that said what it is; this one does not, so it must not get
    /// 승인·거절 back even if the server paired an approval category with a message reason (ADR-0204 D7:
    /// nothing is approved from a lock screen that does not say what).
    public let showsResolvedText: Bool

    public init(display: PushDisplayContent, communication: PushCommunicationDescriptor?, showsResolvedText: Bool = true) {
        self.display = display
        self.communication = communication
        self.showsResolvedText = showsResolvedText
    }
}

public enum PushPresentationPlanner {
    /// The pushes whose text a person or an agent wrote, so that they have a sender to show. The two
    /// `work_*` pushes are the product's own sentences about a session (their cards are authored by the
    /// receiver, and iOS would replace their fixed title with a sender's name): they stay as they are.
    static func isAuthored(_ reason: String) -> Bool {
        ["dm", "mention", "approval_request", "resume_offer"].contains(reason)
    }

    /// The pushes the 「메시지 미리보기」 and 「보낸 사람 표시」 switches speak about: a message.
    /// An approval or a resume offer is a request for an action whose buttons are only safe while its
    /// text is readable (ADR-0204 D7: nothing is approved from a lock screen that does not say what),
    /// so the preview switch never hides it.
    static func isMessage(_ reason: String) -> Bool {
        reason == "dm" || reason == "mention"
    }

    public static func plan(
        envelope: MomoPushEnvelope,
        resolution: PushResolution,
        settings: MomoPushPresentationSettings,
        channel: MomoPushPresentationChannel?,
        avatarPNG: Data?
    ) -> PushPresentation {
        // Not authored, or the read failed: today's look, untouched.
        guard let author = resolution.author, isAuthored(envelope.reason) else {
            return PushPresentation(display: resolution.display, communication: nil)
        }
        var body = resolution.display.body
        var showsResolvedText = true
        if isMessage(envelope.reason) {
            // 「보낸 사람 표시」 off: no name, no picture, no preview, and nothing is donated.
            guard settings.showSender else {
                return PushPresentation(
                    display: PushDisplayContent(
                        title: MomoPushContract.placeholderTitle, body: PushPresentationCopy.hiddenBody),
                    communication: nil,
                    showsResolvedText: false)
            }
            if !settings.previewEnabled {
                body = PushPresentationCopy.hiddenBody
                showsResolvedText = false
            }
        } else if !settings.showSender {
            // An approval or a resume offer names its agent today and keeps doing so; the switch only
            // takes the communication dressing (the photo, the donation) away.
            return PushPresentation(display: resolution.display, communication: nil)
        }

        let isThreadReply = envelope.threadRootID != nil
        if isThreadReply { body = PushPresentationCopy.threaded(body) }

        let groupName = Self.groupName(reason: envelope.reason, channel: channel)
        let descriptor = PushCommunicationDescriptor(
            senderName: author.displayName,
            senderIdentifier: "\(envelope.workspaceID)/\(author.memberID)",
            senderAvatarPNG: avatarPNG,
            messageBody: body,
            conversationIdentifier: "\(envelope.workspaceID)/\(envelope.channelID)",
            groupName: groupName,
            recipientCount: channel?.memberCount.map { max($0 - 1, 1) } ?? 2,
            isThreadReply: isThreadReply)
        return PushPresentation(
            display: PushDisplayContent(title: author.displayName, body: body),
            communication: descriptor,
            showsResolvedText: showsResolvedText)
    }

    /// A named room, and only when the push is not a direct message: a `dm` push is a conversation with
    /// one person whatever an out-of-date cache says about the channel.
    static func groupName(reason: String, channel: MomoPushPresentationChannel?) -> String? {
        guard reason != "dm", let channel, channel.kind != .dm, let name = channel.name else { return nil }
        return PushPresentationCopy.channelPrefix + name
    }
}

// MARK: - the sender's photo

public enum PushAvatarSource: Equatable, Sendable {
    /// Found in the App Group cache under this exact media version.
    case cache
    /// Read from the server within the bound, and stored.
    case download
    /// The phone's own initial, drawn here.
    case generated
    /// Nothing at all: the system draws its own monogram.
    case none
}

public protocol PushAvatarDownloading: Sendable {
    func download(_ reference: PushAvatarReference, session: PushFetchSession) async -> Data?
}

/// The second photo source: ONE read, at most 256 KB, at most 3 seconds, no redirect. nil on anything
/// else — a refusal (the push-fetch credential may read two routes, ADR-0188 §8.7), a slow network,
/// an oversized body — and the caller draws an initial instead.
public struct PushAvatarURLSessionDownloader: PushAvatarDownloading {
    private let makeConfiguration: @Sendable () -> URLSessionConfiguration
    private let timeout: TimeInterval
    private let maxBytes: Int

    public init(
        timeout: TimeInterval = MomoPushPresentationContract.remoteAvatarTimeout,
        maxBytes: Int = MomoPushPresentationContract.remoteAvatarMaxBytes,
        makeConfiguration: @escaping @Sendable () -> URLSessionConfiguration = { URLSessionConfiguration.ephemeral }
    ) {
        self.timeout = timeout
        self.maxBytes = maxBytes
        self.makeConfiguration = makeConfiguration
    }

    public func download(_ reference: PushAvatarReference, session fetchSession: PushFetchSession) async -> Data? {
        // The request is built here from the session's own base URL and the one shape `parse` accepted:
        // the bearer cannot be sent anywhere else.
        guard let url = URL(string: reference.path, relativeTo: fetchSession.baseURL)?.absoluteURL,
              url.host == fetchSession.baseURL.host, url.scheme == fetchSession.baseURL.scheme
        else { return nil }
        let configuration = makeConfiguration()
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let urlSession = URLSession(configuration: configuration)
        defer { urlSession.invalidateAndCancel() }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.setValue("Bearer \(fetchSession.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await urlSession.bytes(for: request, delegate: NoRedirect())
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.expectedContentLength <= Int64(maxBytes)
            else { return nil }
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxBytes { return nil }
            }
            return data
        } catch {
            return nil
        }
    }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}

public struct PushAvatarSourcing: Sendable {
    private let cache: MomoPushPresentationCache?
    private let downloader: (any PushAvatarDownloading)?

    public init(cache: MomoPushPresentationCache?, downloader: (any PushAvatarDownloading)?) {
        self.cache = cache
        self.downloader = downloader
    }

    /// The order is the design's (#4316 설계 2): the App Group cache, then one bounded read, then a drawn
    /// initial. A photo is only worth its time while the extension has time: with less than
    /// `downloadBudget` seconds left the read is skipped, and the notification goes out with an initial
    /// rather than late.
    public func png(
        for author: PushResolvedAuthor, session: PushFetchSession, remaining: TimeInterval, now: Date = Date()
    ) async -> (data: Data?, source: PushAvatarSource) {
        let server = session.baseURL.absoluteString
        if let reference = author.avatar {
            if let cached = cache?.avatarPNG(
                server: server, workspace: session.workspaceID, member: author.memberID, version: reference.version,
                now: now)
            {
                return (cached, .cache)
            }
            if remaining >= Self.downloadBudget, let downloader,
               let bytes = await downloader.download(reference, session: session),
               let png = MomoPushPresentationImage.avatarPNG(
                   from: bytes,
                   maxSourceBytes: MomoPushPresentationContract.remoteAvatarMaxBytes,
                   maxSourceEdge: MomoPushPresentationContract.extensionSourceMaxEdge)
            {
                cache?.storeAvatarPNG(
                    png, server: server, workspace: session.workspaceID, member: author.memberID,
                    version: reference.version, now: now)
                return (png, .download)
            }
        }
        let initial = MomoPushPresentationAvatar.initial(of: author.displayName)
        if let drawn = MomoPushPresentationAvatar.png(initial: initial, kind: author.isAgent ? .agent : .human) {
            return (drawn, .generated)
        }
        return (nil, .none)
    }

    /// 3 s for the read plus time to decode, cut and write what came back.
    static let downloadBudget: TimeInterval = 8
}

// MARK: - putting it together

public struct PushPresentationResult: Equatable, Sendable {
    public let presentation: PushPresentation
    public let avatarSource: PushAvatarSource
}

public struct PushPresentationAssembler: Sendable {
    private let resolver: PushNotificationResolver
    private let container: MomoPushPresentationContainer?
    private let downloader: (any PushAvatarDownloading)?
    private let clock: @Sendable () -> Date

    public init(
        resolver: PushNotificationResolver,
        container: MomoPushPresentationContainer?,
        downloader: (any PushAvatarDownloading)?,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.resolver = resolver
        self.container = container
        self.downloader = downloader
        self.clock = clock
    }

    /// - Parameter remaining: seconds the extension still has (the system gives about 30).
    public func assemble(
        envelope: MomoPushEnvelope, session: PushFetchSession, fallback: PushDisplayContent, remaining: TimeInterval
    ) async -> PushPresentationResult {
        let now = clock()
        // The switches are read first, before the network: they are the person's answer to this very push.
        let settings = MomoPushPresentationSettings.load(from: container)
        let resolution = await resolver.resolveDetailed(envelope: envelope, session: session, fallback: fallback)
        let channel = container?.cache.channel(
            server: session.baseURL.absoluteString, workspace: session.workspaceID, channelID: envelope.channelID,
            now: now)
        // Plan without a photo first: when nothing will be dressed, no photo is worth a read.
        let plain = PushPresentationPlanner.plan(
            envelope: envelope, resolution: resolution, settings: settings, channel: channel, avatarPNG: nil)
        guard plain.communication != nil, let author = resolution.author else {
            return PushPresentationResult(presentation: plain, avatarSource: .none)
        }
        let sourcing = PushAvatarSourcing(cache: container?.cache, downloader: downloader)
        let photo = await sourcing.png(for: author, session: session, remaining: remaining, now: clock())
        let dressed = PushPresentationPlanner.plan(
            envelope: envelope, resolution: resolution, settings: settings, channel: channel, avatarPNG: photo.data)
        return PushPresentationResult(presentation: dressed, avatarSource: photo.source)
    }
}

// MARK: - the system's half (iOS)

#if os(iOS)
import Intents
import UserNotifications

public enum PushCommunicationIntent {
    public static func make(_ descriptor: PushCommunicationDescriptor) -> INSendMessageIntent {
        let senderImage = descriptor.senderAvatarPNG.map { INImage(imageData: $0) }
        let sender = INPerson(
            personHandle: INPersonHandle(value: descriptor.senderIdentifier, type: .unknown),
            nameComponents: nil,
            displayName: descriptor.senderName,
            image: senderImage,
            contactIdentifier: nil,
            customIdentifier: descriptor.senderIdentifier,
            isMe: false,
            suggestionType: .none)
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: descriptor.messageBody,
            speakableGroupName: descriptor.groupName.map { INSpeakableString(spokenPhrase: $0) },
            conversationIdentifier: descriptor.conversationIdentifier,
            serviceName: "oort",
            sender: sender,
            attachments: nil)
        if descriptor.groupName != nil {
            let metadata = INSendMessageIntentDonationMetadata()
            metadata.recipientCount = descriptor.recipientCount
            intent.donationMetadata = metadata
            if let senderImage {
                // A communication notification draws a named conversation's picture from the group-name
                // parameter, not from the sender. A channel has no picture of its own: the sender's photo
                // is the round picture people see.
                intent.setImage(senderImage, forParameterNamed: \.speakableGroupName)
            }
        }
        return intent
    }
}

/// Donates the interaction and applies it to the notification content. Every failure ends in the ordinary
/// content, never in a dropped notification.
public final class PushCommunicationPresenter: @unchecked Sendable {
    public typealias Donation = (INInteraction, @escaping (Error?) -> Void) -> Void
    public typealias InteractionDeletion = (@escaping (Error?) -> Void) -> Void
    public typealias ContentUpdate = (UNMutableNotificationContent, INSendMessageIntent) throws -> UNNotificationContent

    private let donate: Donation
    private let deleteAllInteractions: InteractionDeletion
    private let updateContent: ContentUpdate

    public init(
        donate: @escaping Donation = { interaction, completion in interaction.donate(completion: completion) },
        deleteAllInteractions: @escaping InteractionDeletion = { completion in
            INInteraction.deleteAll(completion: completion)
        },
        updateContent: @escaping ContentUpdate = { content, intent in try content.updating(from: intent) }
    ) {
        self.donate = donate
        self.deleteAllInteractions = deleteAllInteractions
        self.updateContent = updateContent
    }

    /// `isStillAllowed` is asked before the donation and again after it: the donation is asynchronous, and
    /// a person who turned the sender display off in between has withdrawn it.
    public func present(
        ordinaryContent: UNMutableNotificationContent,
        descriptor: PushCommunicationDescriptor,
        isStillAllowed: @escaping () -> Bool,
        completion: @escaping (UNNotificationContent) -> Void
    ) {
        guard isStillAllowed() else {
            completion(ordinaryContent)
            return
        }
        let intent = PushCommunicationIntent.make(descriptor)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        donate(interaction) { [deleteAllInteractions, updateContent] error in
            guard error == nil else {
                completion(ordinaryContent)
                return
            }
            guard isStillAllowed() else {
                deleteAllInteractions { _ in completion(ordinaryContent) }
                return
            }
            completion((try? updateContent(ordinaryContent, intent)) ?? ordinaryContent)
        }
    }
}
#endif
