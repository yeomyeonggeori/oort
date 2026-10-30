import Foundation

// =============================================================================
// Everything about a lock-screen 승인/거절 that does not need UIKit (#3931,
// ADR-0204 D6), kept free of UIKit, UserNotifications and Expo so
// `sim-check/` can compile and run it as a plain command-line binary. The
// handler (MomoPushActionHandler.swift) is the only file that touches the
// system; it asks this file what to do and does it.
//
// The shape of one tap:
//
//   intent    which button, on which notification, for which approval
//   decider   token + secret from the keychain -> ONE request -> an outcome
//   planner   an outcome -> the one line that replaces the notification
//
// Nothing here logs a token, a response body or an identifier: the only things
// that leave this file are the outcome's NAME and the line's text.
// =============================================================================

// MARK: - contract with JS and with the other binaries

/// The strings both sides must agree on. `__tests__/pushContract.test.ts` parses
/// this file and compares them with `src/push/contract.ts`; they are written in
/// the `static let name = "value"` shape that test reads.
enum MomoPushActionContract {
  /// The keychain item JS writes (`src/push/pushActionSession.ts`) and this
  /// module reads. The service/account pair, the app-only access group below and
  /// `kSecAttrSynchronizable = false` are the whole address; a mismatch is not an
  /// error anywhere, the item is simply never found.
  static let keychainService = "app.momo.ios.pushaction"
  static let sessionAccount = "push-action-session"
  /// Written by THIS module, not by JS, in a SERVICE of its own: JS's
  /// `setGenericPassword` deletes every item of ITS service before it writes, so a
  /// secret sharing that service would be wiped by every token publish and the
  /// idempotency key of a notification still on the lock screen would change under
  /// it (finding 1 of the #3931 security review). It outlives token re-mints,
  /// sign-out and the push switch: a random value that names no one.
  static let deviceSecretService = "app.momo.ios.pushaction.secret"
  static let deviceSecretAccount = "device-secret-v1"

  /// The Info.plist key that names the APP-ONLY group (`MomoDeviceKeyStore` reads
  /// the same one). NOT `MomoKeychainAccessGroup`: that is the group the
  /// notification extension reads, and this credential must never be in it.
  static let accessGroupInfoKey = "MomoDeviceKeyAccessGroup"
  static let accessGroupSuffix = "app.momo.ios.devicekey"

  static let approveAction = "momo.action.approve"
  static let rejectAction = "momo.action.reject"
  static let approvalCategory = "momo.approval"
  static let envelopeSchema = "momo.push.notification.v2"

  /// `MomoPushParser` / `src/push/contract.ts` `PUSH_REASONS`. The envelope below
  /// is as strict as both of them, so a push either of them refuses is not
  /// decided from the lock screen.
  static let reasons: Set<String> = [
    "dm", "mention", "approval_request", "resume_offer", "work_session_idle", "work_run_done",
  ]

  /// The alert the relay ships (ADR-0120 D2-A: id-only, so the payload names no
  /// content) and the notification extension replaces with the sender and the
  /// message. A notification still wearing it is one nobody resolved: the
  /// extension could not fetch the body, was out of time, or never ran. Same
  /// strings as `MomoPushContract.placeholderTitle/Body`
  /// (`__tests__/pushActionContract.test.ts` holds them equal).
  static let placeholderTitle = "oort"
  static let placeholderBody = "새 알림"

  /// The result line carries the notification's original payload under this
  /// `userInfo` key, because a local notification has no push trigger for JS to
  /// read it from (`src/push/envelope.ts` `pushPayloadOf`).
  static let originKey = "origin"
}

// MARK: - the button

enum MomoPushActionDirection: Equatable, Sendable {
  case approve
  case reject

  init?(actionIdentifier: String) {
    switch actionIdentifier {
    case MomoPushActionContract.approveAction: self = .approve
    case MomoPushActionContract.rejectAction: self = .reject
    default: return nil
    }
  }

  var approved: Bool { self == .approve }
  var actionIdentifier: String {
    approved ? MomoPushActionContract.approveAction : MomoPushActionContract.rejectAction
  }
}

// MARK: - the notification's payload

/// The few ids a decision needs, from the id-only payload the relay sends. The
/// guards are the ones `MomoPushParser` (the extension) and `parsePushEnvelope`
/// (JS) apply — exact schema, canonical UUIDs, a known reason, and the
/// approval-id/category biconditional — because this is the third reader of the
/// same payload and the one that WRITES.
struct MomoPushActionEnvelope: Equatable, Sendable {
  let workspaceID: String
  let channelID: String
  let messageID: String
  let approvalID: String
  let threadID: String

  static func parse(userInfo: [AnyHashable: Any]) -> MomoPushActionEnvelope? {
    guard let aps = userInfo["aps"] as? [String: Any],
      let momo = userInfo["momo"] as? [String: Any]
    else { return nil }

    func text(_ source: [String: Any], _ key: String) -> String? {
      guard let value = source[key] as? String, !value.isEmpty else { return nil }
      return value
    }
    func uuid(_ value: String?) -> String? {
      guard let value, UUID(uuidString: value) != nil else { return nil }
      return value.lowercased()
    }

    guard text(momo, "schema") == MomoPushActionContract.envelopeSchema,
      let workspaceID = uuid(text(momo, "workspace_id")),
      let channelID = uuid(text(momo, "channel_id")),
      let messageID = uuid(text(momo, "message_id")),
      let threadID = uuid(text(aps, "thread-id")),
      text(momo, "server_id") != nil,
      text(momo, "collapse_id") != nil,
      let reason = text(momo, "reason"), MomoPushActionContract.reasons.contains(reason),
      let badge = (aps["badge"] as? NSNumber)?.intValue, badge >= 0,
      text(aps, "category") == MomoPushActionContract.approvalCategory,
      // The category says approval, so the approval id must be there and be real.
      let approvalID = uuid(text(momo, "approval_id"))
    else { return nil }

    return MomoPushActionEnvelope(
      workspaceID: workspaceID,
      channelID: channelID,
      messageID: messageID,
      approvalID: approvalID,
      threadID: threadID
    )
  }
}

// MARK: - the credential

/// What `src/push/pushActionSession.ts` writes. `memberID` and `ttlSeconds` are
/// JS's own bookkeeping (who the token was minted for, how long it lives); this
/// side ignores them.
struct MomoPushActionSession: Equatable, Sendable {
  let baseURL: String
  let workspaceID: String
  let actionToken: String
  let expiresAtMs: Int64

  private struct Wire: Decodable {
    let baseURL: String
    let workspaceID: String
    let actionToken: String
    let expiresAtMs: Int64
  }

  /// Nil for anything that is not a complete, well-formed session: refusing a
  /// half-written item is the same as having none, and the lock screen then says
  /// so instead of sending a request that cannot work.
  static func decode(_ data: Data) -> MomoPushActionSession? {
    guard let wire = try? JSONDecoder().decode(Wire.self, from: data),
      !wire.actionToken.isEmpty,
      UUID(uuidString: wire.workspaceID) != nil,
      let url = URL(string: wire.baseURL), let scheme = url.scheme?.lowercased(),
      scheme == "https" || scheme == "http", url.host != nil
    else { return nil }
    return MomoPushActionSession(
      baseURL: wire.baseURL,
      workspaceID: wire.workspaceID.lowercased(),
      actionToken: wire.actionToken,
      expiresAtMs: wire.expiresAtMs
    )
  }

  /// A token that is about to lapse is as good as lapsed: a request that dies on
  /// the server's clock costs a round trip and says the same thing.
  static let expirySlackMs: Int64 = 5_000

  func isUsable(atMs now: Int64) -> Bool {
    expiresAtMs > now + Self.expirySlackMs
  }
}

// MARK: - what one tap comes to

/// Why a decision did not happen. Only the NAME is ever logged.
enum MomoPushActionFailure: String, CaseIterable, Equatable, Sendable {
  /// The payload is not one this module reads, so there is nothing to decide.
  case unreadableNotification
  /// The notification is still the relay's placeholder, so the person never saw
  /// what they are being asked to approve. ADR-0204 D7: 「무엇인지 모르는 것을
  /// 잠금 화면에서 승인하게 두지 않는다」. The extension is meant to take the buttons
  /// off such a notification; this is the second line for when it did not run.
  case unresolvedNotification
  /// No push_action item: signed out, the server could not mint one (an older
  /// server, the per-session cap), or the keychain would not answer.
  case noToken
  case tokenExpired
  /// The notification is from a workspace this token was not minted for.
  case otherWorkspace
  case noDeviceSecret
  case badRequest
  case unauthorized
  /// 403 — including `opens_in_app`, a role the person does not hold, and a
  /// channel they have left. The lock screen cannot tell them apart and does not
  /// need to: all of them are finished in the app.
  case refused
  case notFound
  case rateLimited
  /// 409 with no settled status: the key is bound to the other verdict.
  case conflict
  case server
  /// An answer that says no and is not one of the above (400, a redirect this
  /// module refuses to follow, ...): the server refused it, nothing was written.
  case unexpected
  /// A 2xx that is not a receipt this module can read as 승인 or 거절. The server
  /// answered "ok" to something, so the decision may well be recorded; saying it
  /// was not would be a guess, and so would saying it was.
  case unclearAnswer
  case network
  /// iOS ran out of background time before the request answered.
  case timeLimit

  /// Whether the server may have recorded the decision even though this phone
  /// never saw a usable answer: the request left and the reply did not come back
  /// (a lost connection, a timeout, a cancelled wait), the server broke after
  /// taking it (5xx), or it said "ok" in a form nobody here can read. Everything
  /// else was refused, or never sent, before anything was written. The sentence
  /// differs: 「못했어요」 would be a false statement for these.
  var mayHaveBeenRecorded: Bool {
    switch self {
    case .network, .timeLimit, .server, .unclearAnswer: return true
    default: return false
    }
  }
}

/// What the server's ledger says about an approval that was already settled.
enum MomoPushActionLedgerStatus: String, Equatable, Sendable {
  case approved
  case rejected
  case expired
  case cancelled
}

enum MomoPushActionOutcome: Equatable, Sendable {
  /// This tap recorded the decision (200, which also covers a replayed tap).
  case decided(MomoPushActionDirection, line: String? = nil)
  /// The approval was already settled, in the direction the LEDGER holds — which
  /// may not be the one this button asked for.
  case alreadySettled(MomoPushActionLedgerStatus, line: String? = nil)
  case failed(MomoPushActionFailure)

  /// The one thing about an outcome that is written to the log: a name. No id, no
  /// token, no body.
  var logName: String {
    switch self {
    case .decided(let direction, _): return direction.approved ? "decided(approve)" : "decided(reject)"
    case .alreadySettled(let status, _): return "alreadySettled(\(status.rawValue))"
    case .failed(let reason): return "failed(\(reason.rawValue))"
    }
  }
}

// MARK: - the request

enum MomoPushActionRequestBuilder {
  /// Longer than the decision route ever needs and shorter than the time iOS
  /// gives a background task, so a slow server reads as a failure line instead
  /// of an expiry.
  static let timeoutSeconds: TimeInterval = 15

  /// `POST /v1/workspaces/{ws}/approvals/{approval}/decision`, the ONE route a
  /// push_action token may call. The body is exactly what an inline approval
  /// sends: no `hostId`, no `deliverSecretToAgent` — the server refuses those
  /// cards to this credential (`opens_in_app`), so a body that could ask for
  /// them would only invite a mistake.
  static func make(
    session: MomoPushActionSession,
    envelope: MomoPushActionEnvelope,
    direction: MomoPushActionDirection,
    decisionID: String
  ) -> URLRequest? {
    var base = session.baseURL
    while base.hasSuffix("/") { base.removeLast() }
    guard
      let url = URL(
        string:
          "\(base)/v1/workspaces/\(envelope.workspaceID)/approvals/\(envelope.approvalID)/decision"
      )
    else { return nil }

    var request = URLRequest(url: url, timeoutInterval: timeoutSeconds)
    request.httpMethod = "POST"
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(session.actionToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let body: [String: Any] = [
      "approval_id": envelope.approvalID,
      "approve": direction.approved,
      "client_decision_id": decisionID,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    else { return nil }
    request.httpBody = data
    return request
  }
}

// MARK: - the answer

enum MomoPushActionClassifier {
  /// The route answers the same receipt shape on 200, 403, 404 and 409; only
  /// Only status and the optional public receipt.line are read. Neither the
  /// receipt nor its line is logged; older servers keep the current wording.
  static func classify(
    httpStatus: Int,
    body: Data,
    direction: MomoPushActionDirection
  ) -> MomoPushActionOutcome {
    let ledger = ledgerStatus(in: body)
    let line = receiptLine(in: body)
    switch httpStatus {
    case 200:
      // The server's own receipt (`decision_receipt`, always with a `status`) is what
      // makes this an answer. A 200 with no readable status (a proxy's page, a changed
      // body) says nothing about the ledger, so it is not reported as one.
      guard let ledger else { return .failed(.unclearAnswer) }
      switch ledger {
      case .approved, .rejected:
        // The ledger can only contradict the button here if the server is wrong;
        // saying what it holds is still the one thing that cannot mislead.
        return ledger == direction.ledgerStatus ? .decided(direction, line: line) : .alreadySettled(ledger, line: line)
      case .expired, .cancelled:
        // A REPLAY of a key whose first call found the approval settled: the server
        // answers the stored receipt with a 200 (`decide_in_tx`, idempotency first), and
        // the stored receipt says what happened to the approval.
        return .alreadySettled(ledger, line: line)
      }
    case 201...299: return .failed(.unclearAnswer)
    case 409:
      if let ledger { return .alreadySettled(ledger, line: line) }
      return .failed(.conflict)
    case 401: return .failed(.unauthorized)
    case 403: return .failed(.refused)
    case 404: return .failed(.notFound)
    case 429: return .failed(.rateLimited)
    case 500...599: return .failed(.server)
    default: return .failed(.unexpected)
    }
  }

  private static func ledgerStatus(in body: Data) -> MomoPushActionLedgerStatus? {
    guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let status = object["status"] as? String
    else { return nil }
    return MomoPushActionLedgerStatus(rawValue: status)
  }

  private static func receiptLine(in body: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let line = object["line"] as? String,
      !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    return line
  }
}

extension MomoPushActionDirection {
  var ledgerStatus: MomoPushActionLedgerStatus { approved ? .approved : .rejected }
}

// MARK: - the whole decision, with the outside world injected

/// The two things a decision needs from the phone. The keychain-backed
/// implementation is MomoPushActionKeychain.swift; the simulator check uses a
/// dictionary.
protocol MomoPushActionCredentials: Sendable {
  func readSession() -> MomoPushActionSession?
  func readDeviceSecret() -> Data?
}

protocol MomoPushActionTransport: Sendable {
  /// The status code and body of ONE request. Throws when there is no answer
  /// (offline, timed out, cancelled) or the answer is not HTTP.
  func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

/// The alert the relay put in the payload (`aps.alert`) — the text the notification
/// carried BEFORE the extension rewrote it. A notification whose shown title and
/// body still equal it was never resolved.
struct MomoPushActionRelayAlert: Equatable, Sendable {
  let title: String
  let body: String

  static func read(userInfo: [AnyHashable: Any]) -> MomoPushActionRelayAlert? {
    guard let aps = userInfo["aps"] as? [String: Any],
      let alert = aps["alert"] as? [String: Any],
      let title = alert["title"] as? String, let body = alert["body"] as? String
    else { return nil }
    return MomoPushActionRelayAlert(title: title, body: body)
  }
}

struct MomoPushActionIntent: Sendable {
  let direction: MomoPushActionDirection
  /// The notification's request identifier — the APNs collapse id. The same on
  /// every tap of the same notification, which is what makes the key repeatable.
  let requestIdentifier: String
  /// The notification's title and body as the extension left them.
  let title: String
  let body: String
  let threadIdentifier: String
  /// Nil when the payload is not one this module reads.
  let envelope: MomoPushActionEnvelope?
  /// The notification's `userInfo`, as JSON, to carry onto the result line.
  let origin: Data?
  /// What the relay sent as the alert, when the payload still has it.
  let relayAlert: MomoPushActionRelayAlert?

  /// False while nobody rewrote the notification: its shown title and body are
  /// still what the relay sent (`aps.alert`, read from the payload itself, so a
  /// change to the relay's copy cannot make an unseen approval look resolved) or,
  /// when the payload has no alert to compare, the known placeholder 「oort / 새 알림」.
  /// Both halves must match, so a sender who happens to be called oort is not
  /// mistaken for the relay.
  var contentWasResolved: Bool {
    let shownTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let shownBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
    if let relayAlert,
      shownTitle == relayAlert.title.trimmingCharacters(in: .whitespacesAndNewlines),
      shownBody == relayAlert.body.trimmingCharacters(in: .whitespacesAndNewlines)
    {
      return false
    }
    return !(shownTitle == MomoPushActionContract.placeholderTitle
      && shownBody == MomoPushActionContract.placeholderBody)
  }
}

struct MomoPushActionDecider: Sendable {
  let credentials: MomoPushActionCredentials
  let transport: MomoPushActionTransport
  let nowMs: @Sendable () -> Int64

  /// ONE request at most, and none at all when it cannot succeed: no payload, no
  /// token, an expired token, another workspace's token. Each of those is a
  /// failure the person is told about, not a request that goes out to fail.
  func decide(_ intent: MomoPushActionIntent) async -> MomoPushActionOutcome {
    guard let envelope = intent.envelope else { return .failed(.unreadableNotification) }
    guard intent.contentWasResolved else { return .failed(.unresolvedNotification) }
    guard let session = credentials.readSession() else { return .failed(.noToken) }
    guard session.isUsable(atMs: nowMs()) else { return .failed(.tokenExpired) }
    // The same boundary `handlePushResponse` held in JS: a notification for a
    // workspace the person has since left must never drive a write into the one
    // they are in now. The server enforces it too (403) — this makes the
    // refusal local, so the token is not even sent.
    guard session.workspaceID == envelope.workspaceID else { return .failed(.otherWorkspace) }
    guard let secret = credentials.readDeviceSecret(),
      let decisionID = MomoPushActionDecisionKey.derive(
        secret: secret,
        requestIdentifier: intent.requestIdentifier,
        action: intent.direction.actionIdentifier,
        approvalID: envelope.approvalID
      )
    else { return .failed(.noDeviceSecret) }
    guard
      let request = MomoPushActionRequestBuilder.make(
        session: session,
        envelope: envelope,
        direction: intent.direction,
        decisionID: decisionID
      )
    else { return .failed(.badRequest) }

    // Never start a request on a job whose clock has already run out: the line for that
    // is written, the background task is given back, and a request begun now would be
    // sent after the process may be suspended. (The check and the send are not atomic,
    // and cancelling a URLSession call interrupts the WAIT, not a send already under way:
    // what slips between them is a request the line has already told the person about —
    // 「결과를 확인하지 못했어요」 does not claim that nothing happened.)
    if Task.isCancelled { return .failed(.timeLimit) }

    do {
      let answer = try await transport.send(request)
      return MomoPushActionClassifier.classify(
        httpStatus: answer.status,
        body: answer.body,
        direction: intent.direction
      )
    } catch is CancellationError {
      return .failed(.timeLimit)
    } catch let error as URLError where error.code == .cancelled {
      // URLSession reports a cancelled task as this, not as CancellationError.
      return .failed(.timeLimit)
    } catch {
      return .failed(.network)
    }
  }
}

// MARK: - the line that replaces the notification

enum MomoPushActionCopy {
  /// 「승인했어요 · {제목}」 / 「거부했어요 · {제목}」. A title that says nothing —
  /// empty, or the relay's placeholder because the extension could not fetch the
  /// body — is left off rather than printed.
  static func decided(_ direction: MomoPushActionDirection, title: String) -> String {
    let verb = direction.approved ? "승인했어요" : "거부했어요"
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed == MomoPushActionContract.placeholderTitle { return verb }
    return "\(verb) · \(trimmed)"
  }

  /// The direction is the LEDGER's, not the button's (ADR-0204 D6 「원장의 실제
  /// 방향」): a 거절 tapped on an approval someone else already approved must
  /// say 승인됐다. Expired and cancelled are not in the ADR; they are the same
  /// sentence with the state they are in.
  static func alreadySettled(_ status: MomoPushActionLedgerStatus) -> String {
    switch status {
    case .approved: return "이미 승인된 요청이에요"
    case .rejected: return "이미 거부된 요청이에요"
    case .expired: return "이미 만료된 요청이에요"
    case .cancelled: return "이미 취소된 요청이에요"
    }
  }

  /// The failure's TITLE. ADR-0204 D6 writes 「승인하지 못했어요 — 눌러서 앱에서
  /// 마무리」 as one line for every failure; this departs from it twice, both on the
  /// design review of #3931:
  ///
  ///  - The verb follows the button. A 거절 that did not go through must not say
  ///    승인 — it would read as "nothing was approved", a safe outcome, when in fact
  ///    neither decision was recorded and the approval is still waiting.
  ///  - No dash (the design system bans the em dash outright, and nothing measures a
  ///    Swift string, so only a person can notice), and the instruction is a 해요체
  ///    sentence in the BODY (`failedDetail`) instead of a noun-tail on a one-line
  ///    title that iOS would truncate at its end — the end being the instruction.
  static func failed(_ direction: MomoPushActionDirection) -> String {
    direction.approved ? "승인하지 못했어요" : "거부하지 못했어요"
  }

  /// When the request left and no answer came back (or the server broke after
  /// taking it) the decision MAY be on the ledger, so the line must not say it
  /// was not made: it says the result is unknown and sends the person to the card,
  /// which tells the truth. The idempotency key makes pressing again in the app safe.
  /// (Both the independent design review and the security review of #3931 raised it.)
  static let unknownResult = "결과를 확인하지 못했어요"
  static let unknownResultDetail = "눌러서 앱에서 확인해 주세요"

  /// What to do next, shown as the notification's body. The tap lands on the
  /// approval's card, which is where it is finished.
  static let failedDetail = "눌러서 앱에서 마무리해 주세요"
}

/// The one line, before it becomes a UNNotificationContent.
struct MomoPushActionLine: Equatable, Sendable {
  let text: String
  /// A second line under the title: what to do next. Only a failure has one — a
  /// result is one short line and nothing more.
  let detail: String?
  /// A failure alerts (banner and sound): the approval is still waiting and the
  /// person has to do something. A result is quiet — it confirms what they just
  /// did.
  let alerts: Bool
  /// The approval is settled, so the other notifications for it are dead
  /// buttons and are removed. After a failure they are left: the approval is
  /// still pending, and any of them still opens its card.
  let removesSiblings: Bool
}

/// What the notification centre is asked to show. Plain values only.
struct MomoPushActionNotice {
  let identifier: String
  let title: String
  /// Empty for a result; the next step for a failure.
  let body: String
  let threadIdentifier: String
  let categoryIdentifier: String
  /// Banner and sound (a failure) or the list only (a confirmation).
  let alerts: Bool
  let userInfo: [String: Any]
}

enum MomoPushActionPlanner {
  static func line(for outcome: MomoPushActionOutcome, intent: MomoPushActionIntent)
    -> MomoPushActionLine
  {
    switch outcome {
    case .decided(let direction, let line):
      return MomoPushActionLine(
        text: line ?? MomoPushActionCopy.decided(direction, title: intent.title),
        detail: nil,
        alerts: false,
        removesSiblings: true
      )
    case .alreadySettled(let status, let line):
      return MomoPushActionLine(
        text: line ?? MomoPushActionCopy.alreadySettled(status),
        detail: nil,
        alerts: false,
        removesSiblings: true
      )
    case .failed(let reason) where reason.mayHaveBeenRecorded:
      return MomoPushActionLine(
        text: MomoPushActionCopy.unknownResult,
        detail: MomoPushActionCopy.unknownResultDetail,
        alerts: true,
        removesSiblings: false
      )
    case .failed:
      return MomoPushActionLine(
        text: MomoPushActionCopy.failed(intent.direction),
        detail: MomoPushActionCopy.failedDetail,
        alerts: true,
        removesSiblings: false
      )
    }
  }

  /// The line as the notification centre is asked for it. Everything the person
  /// can notice about the replacement is decided here, where it can be checked;
  /// the handler only copies these fields onto a UNMutableNotificationContent.
  static func notice(for line: MomoPushActionLine, intent: MomoPushActionIntent)
    -> MomoPushActionNotice
  {
    MomoPushActionNotice(
      // The SAME identifier as the notification this answers: the header of
      // UNUserNotificationCenter.h says a request with the identifier of a delivered
      // notification "will alert for the new notification request and replace the
      // existing delivered notification". One slot, so nothing is left behind
      // between the old banner leaving and the new one arriving.
      identifier: intent.requestIdentifier,
      title: line.text,
      body: line.detail ?? "",
      // The same thread as the notification it replaces, so the two never sit in
      // different groups on the lock screen.
      threadIdentifier: intent.threadIdentifier,
      // No category: a result has no buttons, so it can never be pressed twice.
      categoryIdentifier: "",
      alerts: line.alerts,
      userInfo: userInfo(origin: intent.origin)
    )
  }

  /// The line's `userInfo`: the original payload under one key, or nothing when
  /// there is none to carry.
  static func userInfo(origin: Data?) -> [String: Any] {
    guard let origin,
      let object = try? JSONSerialization.jsonObject(with: origin) as? [String: Any]
    else { return [:] }
    return [MomoPushActionContract.originKey: object]
  }

  /// Which delivered notifications are the same approval's other copies: the
  /// ones whose payload names this workspace and this approval, other than the
  /// one the line replaces. A result line of an earlier decision carries its
  /// payload under `origin` and is not matched.
  static func siblings(
    delivered: [(identifier: String, userInfo: [AnyHashable: Any])],
    of envelope: MomoPushActionEnvelope,
    excluding identifier: String
  ) -> [String] {
    delivered.compactMap { entry in
      guard entry.identifier != identifier,
        let other = MomoPushActionEnvelope.parse(userInfo: entry.userInfo),
        other.workspaceID == envelope.workspaceID,
        other.approvalID == envelope.approvalID
      else { return nil }
      return entry.identifier
    }
  }
}
