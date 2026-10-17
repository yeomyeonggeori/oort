import Foundation

// Check of the lock-screen decision (#3931, ADR-0204 D6) with nothing but the
// UIKit-free half of the module: MomoPushActionCore.swift and
// MomoPushActionDecisionKey.swift. A spawned CLI has no UIApplication and no
// notification centre, so what is exercised here is everything that DECIDES —
// the idempotency key, the request, the answer's reading, the sentence — and
// not the part that merely does as told (MomoPushActionHandler.swift, the
// keychain). Run by ./run.sh.

var failures = 0
func check(_ ok: Bool, _ what: String) {
  print("\(ok ? "ok" : "FAIL"): \(what)")
  if !ok { failures += 1 }
}

let approvalID = "11111111-2222-4333-8444-555555555555"
let workspaceID = "22222222-2222-4222-8222-222222222222"
let channelID = "33333333-3333-4333-8333-333333333333"
let messageID = "44444444-4444-4444-8444-444444444444"
let secret = Data(Array(1...32))
let approve = MomoPushActionContract.approveAction
let reject = MomoPushActionContract.rejectAction

// ---- the idempotency key ------------------------------------------------------

do {
  // Known answers, computed independently (python3 hashlib) from the recipe in
  // MomoPushActionDecisionKey.swift: they pin the construction, not just that
  // some deterministic string comes out.
  check(
    MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-1", action: approve, approvalID: approvalID)
      == "17b6608d-d7c8-88f7-a289-87f4394b0117",
    "approve key matches the independently computed vector")
  check(
    MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-1", action: reject, approvalID: approvalID)
      == "7f7d8b6b-a4c3-8f24-86b0-16e1ff69ca8d",
    "reject key matches the independently computed vector")
  check(
    MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-1", action: approve, approvalID: approvalID.uppercased())
      == "17b6608d-d7c8-88f7-a289-87f4394b0117",
    "the approval id's case does not change the key")
  // The fixture id above has no hex LETTERS, so upper/lower are the same string and the line above
  // proves nothing about case. This one does: a letter-bearing id and its upper-case spelling.
  let lettered = "abcdefab-1234-4abc-8def-abcdefabcdef"
  check(lettered != lettered.uppercased(), "the case fixture really differs in case")
  check(
    MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-1", action: approve, approvalID: lettered)
      == MomoPushActionDecisionKey.derive(
        secret: secret, requestIdentifier: "req-1", action: approve, approvalID: lettered.uppercased()),
    "an approval id spelled in upper case derives the same key as in lower case")

  let base = MomoPushActionDecisionKey.derive(
    secret: secret, requestIdentifier: "req-1", action: approve, approvalID: approvalID)!
  check(
    base == MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-1", action: approve, approvalID: approvalID),
    "the same tap derives the same key (a second press is one decision)")
  check(
    base != MomoPushActionDecisionKey.derive(
      secret: Data(Array(2...33)), requestIdentifier: "req-1", action: approve, approvalID: approvalID),
    "another phone's secret gives another key (nobody can name this key from public ids)")
  check(
    base != MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-2", action: approve, approvalID: approvalID),
    "another notification gives another key")
  check(
    base != MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-1", action: reject, approvalID: approvalID),
    "the other button gives another key")
  check(
    base != MomoPushActionDecisionKey.derive(
      secret: secret, requestIdentifier: "req-1", action: approve,
      approvalID: "99999999-2222-4333-8444-555555555555"),
    "another approval gives another key")
  check(
    MomoPushActionDecisionKey.derive(secret: secret, requestIdentifier: "ab", action: "c", approvalID: "x")
      != MomoPushActionDecisionKey.derive(secret: secret, requestIdentifier: "a", action: "bc", approvalID: "x"),
    "moving a boundary between two fields changes the key (length-prefixed)")

  let shape = try! NSRegularExpression(
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  check(
    shape.firstMatch(in: base, range: NSRange(base.startIndex..., in: base)) != nil,
    "the key is a lowercase UUID with version 8 and the RFC variant bits")
  check(UUID(uuidString: base) != nil, "Foundation reads it as a UUID (the server types it as one)")
  check(
    MomoPushActionDecisionKey.derive(
      secret: Data(count: 15), requestIdentifier: "r", action: approve, approvalID: approvalID) == nil,
    "a secret shorter than 16 bytes is refused, not hashed")
  check(
    MomoPushActionDecisionKey.derive(
      secret: Data(), requestIdentifier: "r", action: approve, approvalID: approvalID) == nil,
    "an empty secret is refused")
}

// ---- the payload ----------------------------------------------------------------

func payload(
  schema: String? = "momo.push.notification.v2",
  workspace: String? = workspaceID,
  channel: String? = channelID,
  message: String? = messageID,
  thread: String? = channelID,
  serverID: String? = "srv",
  collapse: String? = "collapse-1",
  reason: String? = "approval_request",
  badge: Int? = 1,
  category: String? = "momo.approval",
  approval: String? = approvalID
) -> [AnyHashable: Any] {
  var aps: [String: Any] = [:]
  if let badge { aps["badge"] = badge }
  if let thread { aps["thread-id"] = thread }
  if let category { aps["category"] = category }
  var momo: [String: Any] = [:]
  if let schema { momo["schema"] = schema }
  if let serverID { momo["server_id"] = serverID }
  if let workspace { momo["workspace_id"] = workspace }
  if let channel { momo["channel_id"] = channel }
  if let message { momo["message_id"] = message }
  if let collapse { momo["collapse_id"] = collapse }
  if let reason { momo["reason"] = reason }
  if let approval { momo["approval_id"] = approval }
  return ["aps": aps, "momo": momo]
}

do {
  let envelope = MomoPushActionEnvelope.parse(userInfo: payload())
  check(
    envelope
      == MomoPushActionEnvelope(
        workspaceID: workspaceID, channelID: channelID, messageID: messageID,
        approvalID: approvalID, threadID: channelID),
    "a well-formed approval payload parses")
  check(
    MomoPushActionEnvelope.parse(userInfo: payload(workspace: workspaceID.uppercased()))?.workspaceID
      == workspaceID,
    "ids are lowercased")
  check(MomoPushActionEnvelope.parse(userInfo: [:]) == nil, "an empty payload is refused")
  check(MomoPushActionEnvelope.parse(userInfo: ["aps": [:]]) == nil, "no momo object is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(schema: "momo.push.notification.v1")) == nil,
    "another schema is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(schema: nil)) == nil, "no schema is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(workspace: "not-a-uuid")) == nil,
    "a workspace id that is not a UUID is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(channel: nil)) == nil, "no channel is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(message: "x")) == nil, "a bad message id is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(thread: nil)) == nil, "no thread id is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(serverID: "")) == nil, "an empty server id is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(collapse: nil)) == nil, "no collapse id is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(reason: "surprise")) == nil,
    "a reason outside the vocabulary is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(badge: -1)) == nil, "a negative badge is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(badge: nil)) == nil, "no badge is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(category: "momo.message")) == nil,
    "a payload whose category is not approval is never decided")
  check(MomoPushActionEnvelope.parse(userInfo: payload(approval: nil)) == nil,
    "an approval payload without an approval id is refused")
  check(MomoPushActionEnvelope.parse(userInfo: payload(approval: "nope")) == nil,
    "an approval id that is not a UUID is refused")
  check(
    MomoPushActionContract.reasons
      == ["dm", "mention", "approval_request", "resume_offer", "work_session_idle", "work_run_done"],
    "the reason vocabulary is exactly the relay's six (the JS contract test holds the same list)")
  for reason in MomoPushActionContract.reasons {
    check(MomoPushActionEnvelope.parse(userInfo: payload(reason: reason)) != nil, "reason \(reason) is accepted")
  }
}

// ---- the credential -------------------------------------------------------------

func sessionJSON(
  baseURL: String = "https://oort.example.com",
  workspace: String = workspaceID,
  token: String = "tok",
  expiresAtMs: String = "2000000000000",
  extra: String = ""
) -> Data {
  Data(
    """
    {"baseURL":"\(baseURL)","workspaceID":"\(workspace)","actionToken":"\(token)","expiresAtMs":\(expiresAtMs)\(extra)}
    """.utf8)
}

do {
  let session = MomoPushActionSession.decode(sessionJSON())
  check(
    session
      == MomoPushActionSession(
        baseURL: "https://oort.example.com", workspaceID: workspaceID, actionToken: "tok",
        expiresAtMs: 2_000_000_000_000),
    "a complete item decodes")
  check(
    MomoPushActionSession.decode(
      sessionJSON(extra: ",\"memberID\":\"m\",\"ttlSeconds\":21600")) == session,
    "the member id and ttl JS also writes are ignored")
  check(MomoPushActionSession.decode(sessionJSON(token: "")) == nil, "an empty token is no session")
  check(MomoPushActionSession.decode(sessionJSON(workspace: "x")) == nil, "a bad workspace id is no session")
  check(MomoPushActionSession.decode(sessionJSON(baseURL: "ftp://x.example.com")) == nil,
    "a non-http base is no session")
  check(MomoPushActionSession.decode(sessionJSON(baseURL: "not a url")) == nil, "an unparseable base is no session")
  check(MomoPushActionSession.decode(sessionJSON(baseURL: "https://")) == nil, "a base without a host is no session")
  check(MomoPushActionSession.decode(Data("{}".utf8)) == nil, "an empty object is no session")
  check(MomoPushActionSession.decode(Data("nope".utf8)) == nil, "garbage is no session")
  check(
    MomoPushActionSession.decode(
      Data("{\"baseURL\":\"https://a.example.com\",\"workspaceID\":\"\(workspaceID)\",\"expiresAtMs\":1}".utf8))
      == nil,
    "an item without a token key is no session")
  let live = session!
  check(live.isUsable(atMs: 1_999_999_994_999), "a token with more than the slack left is usable")
  check(!live.isUsable(atMs: 1_999_999_995_000), "a token inside the slack is not")
  check(!live.isUsable(atMs: 2_000_000_000_001), "an expired token is not")
}

// ---- the request ------------------------------------------------------------------

do {
  let session = MomoPushActionSession.decode(sessionJSON(baseURL: "https://oort.example.com/"))!
  let envelope = MomoPushActionEnvelope.parse(userInfo: payload())!
  let fixedDecisionID = "17b6608d-d7c8-88f7-a289-87f4394b0117"
  let request = MomoPushActionRequestBuilder.make(
    session: session, envelope: envelope, direction: .approve, decisionID: fixedDecisionID)!
  check(
    request.url?.absoluteString
      == "https://oort.example.com/v1/workspaces/\(workspaceID)/approvals/\(approvalID)/decision",
    "the one route push_action may call, on the token's own workspace (trailing slash trimmed)")
  check(request.httpMethod == "POST", "POST")
  check(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok", "the bearer is the push_action token")
  check(request.value(forHTTPHeaderField: "Content-Type") == "application/json", "JSON body")
  check(request.timeoutInterval == 15, "a 15 second deadline")
  let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
  check(Set(body.keys) == ["approval_id", "approve", "client_decision_id"],
    "the body is exactly approval_id, approve, client_decision_id")
  check(body["approval_id"] as? String == approvalID, "approval_id is the path's")
  check(body["approve"] as? Bool == true, "approve")
  check(body["client_decision_id"] as? String == fixedDecisionID, "the derived key")
  check(!String(decoding: request.httpBody!, as: UTF8.self).contains("tok"), "the token is not in the body")
  let rejected = MomoPushActionRequestBuilder.make(
    session: session, envelope: envelope, direction: .reject, decisionID: fixedDecisionID)!
  let rejectedBody = try! JSONSerialization.jsonObject(with: rejected.httpBody!) as! [String: Any]
  check(rejectedBody["approve"] as? Bool == false, "reject sends approve=false")
  check(rejectedBody["hostId"] == nil && rejectedBody["deliverSecretToAgent"] == nil,
    "no host choice and no secret hand-off on a lock-screen decision")
}

// ---- the answer ----------------------------------------------------------------------

func receipt(_ status: String?) -> Data {
  Data((status.map { "{\"status\":\"\($0)\",\"approvalId\":\"x\"}" } ?? "{}").utf8)
}

do {
  typealias C = MomoPushActionClassifier
  check(C.classify(httpStatus: 200, body: receipt("approved"), direction: .approve) == .decided(.approve),
    "200 approved after 승인 is decided")
  check(C.classify(httpStatus: 200, body: receipt("rejected"), direction: .reject) == .decided(.reject),
    "200 rejected after 거절 is decided")
  check(C.classify(httpStatus: 200, body: Data(), direction: .approve) == .decided(.approve),
    "a 200 without a readable receipt is still the server accepting it")
  check(C.classify(httpStatus: 200, body: Data("<html>".utf8), direction: .reject) == .decided(.reject),
    "a 200 that is not JSON is still decided")
  check(C.classify(httpStatus: 200, body: receipt("rejected"), direction: .approve) == .alreadySettled(.rejected),
    "a 200 whose ledger says the opposite reports the ledger")
  check(C.classify(httpStatus: 409, body: receipt("approved"), direction: .reject) == .alreadySettled(.approved),
    "409 approved after 거절 reports the ledger's 승인, not the button")
  check(C.classify(httpStatus: 409, body: receipt("rejected"), direction: .approve) == .alreadySettled(.rejected),
    "409 rejected after 승인 reports 거절")
  check(C.classify(httpStatus: 409, body: receipt("expired"), direction: .approve) == .alreadySettled(.expired),
    "409 expired")
  check(C.classify(httpStatus: 409, body: receipt("cancelled"), direction: .approve) == .alreadySettled(.cancelled),
    "409 cancelled")
  check(C.classify(httpStatus: 409, body: receipt("idempotency_conflict"), direction: .approve) == .failed(.conflict),
    "409 idempotency_conflict is a failure, not a settled approval")
  check(C.classify(httpStatus: 409, body: receipt("pending"), direction: .approve) == .failed(.conflict),
    "409 with a status that is not settled is a failure")
  check(C.classify(httpStatus: 409, body: Data(), direction: .approve) == .failed(.conflict),
    "409 without a receipt is a failure")
  check(C.classify(httpStatus: 401, body: Data(), direction: .approve) == .failed(.unauthorized), "401")
  check(C.classify(httpStatus: 403, body: receipt("opens_in_app"), direction: .approve) == .failed(.refused),
    "403 opens_in_app finishes in the app")
  check(C.classify(httpStatus: 403, body: receipt("role_required"), direction: .reject) == .failed(.refused),
    "403 role_required")
  check(C.classify(httpStatus: 403, body: receipt("approved"), direction: .approve) == .failed(.refused),
    "a 403 is a refusal whatever status it carries")
  check(C.classify(httpStatus: 404, body: Data(), direction: .approve) == .failed(.notFound), "404")
  check(C.classify(httpStatus: 429, body: Data(), direction: .approve) == .failed(.rateLimited), "429")
  check(C.classify(httpStatus: 500, body: Data(), direction: .approve) == .failed(.server), "500")
  check(C.classify(httpStatus: 503, body: Data(), direction: .approve) == .failed(.server), "503")
  check(C.classify(httpStatus: 302, body: Data(), direction: .approve) == .failed(.unexpected),
    "a redirect is not an answer")
  check(C.classify(httpStatus: 400, body: Data(), direction: .approve) == .failed(.unexpected), "400")
}

// ---- the sentences -----------------------------------------------------------------------

do {
  typealias Copy = MomoPushActionCopy
  check(Copy.decided(.approve, title: "그록봇") == "승인했어요 · 그록봇", "승인했어요 · {제목}")
  check(Copy.decided(.reject, title: "그록봇") == "거절했어요 · 그록봇", "거절했어요 · {제목}")
  check(Copy.decided(.approve, title: "  그록봇\n") == "승인했어요 · 그록봇", "the title is trimmed")
  check(Copy.decided(.approve, title: "") == "승인했어요", "an empty title is left off")
  check(Copy.decided(.reject, title: "oort") == "거절했어요", "the relay's placeholder title is left off")
  check(Copy.alreadySettled(.approved) == "이미 승인된 요청이에요", "이미 승인된 요청이에요")
  check(Copy.alreadySettled(.rejected) == "이미 거절된 요청이에요", "이미 거절된 요청이에요")
  check(Copy.alreadySettled(.expired) == "이미 만료된 요청이에요", "이미 만료된 요청이에요")
  check(Copy.alreadySettled(.cancelled) == "이미 취소된 요청이에요", "이미 취소된 요청이에요")
  check(Copy.failed(.approve) == "승인하지 못했어요", "승인하지 못했어요")
  check(Copy.failed(.reject) == "거절하지 못했어요", "a 거절 that failed does not say 승인")
  check(Copy.failedDetail == "눌러서 앱에서 마무리해 주세요", "the next step is one 해요체 sentence")

  // The design system bans the em dash outright (docs/design-system/README.md); nothing measures a Swift
  // string, so this sweep over EVERY sentence the module can put on a lock screen is the only thing that
  // would notice one.
  var everySentence: [String] = [
    Copy.failed(.approve), Copy.failed(.reject), Copy.failedDetail,
    Copy.decided(.approve, title: "그록봇"), Copy.decided(.reject, title: "그록봇"),
    Copy.decided(.approve, title: ""),
  ]
  for status in [MomoPushActionLedgerStatus.approved, .rejected, .expired, .cancelled] {
    everySentence.append(Copy.alreadySettled(status))
  }
  check(everySentence.count == 10, "the sweep covers every sentence")
  check(everySentence.allSatisfy { !$0.contains("\u{2014}") && !$0.contains("\u{2013}") },
    "no sentence the lock screen can show contains an em or en dash")
  check(everySentence.allSatisfy { !$0.contains("!") }, "and none shouts")
}

// ---- the plan ----------------------------------------------------------------------------

func intent(
  _ direction: MomoPushActionDirection = .approve,
  request: String = "req-1",
  title: String = "그록봇",
  body: String = "git push origin main 을 실행해도 될까요?",
  userInfo: [AnyHashable: Any]? = nil
) -> MomoPushActionIntent {
  let info = userInfo ?? payload()
  return MomoPushActionIntent(
    direction: direction, requestIdentifier: request, title: title, body: body, threadIdentifier: channelID,
    envelope: MomoPushActionEnvelope.parse(userInfo: info),
    origin: try? JSONSerialization.data(withJSONObject: info))
}

do {
  typealias P = MomoPushActionPlanner
  let decided = P.line(for: .decided(.approve), intent: intent())
  check(decided == MomoPushActionLine(text: "승인했어요 · 그록봇", detail: nil, alerts: false, removesSiblings: true),
    "a decision is a quiet line and clears the approval's other notifications")
  let settled = P.line(for: .alreadySettled(.approved), intent: intent(.reject))
  check(settled == MomoPushActionLine(text: "이미 승인된 요청이에요", detail: nil, alerts: false, removesSiblings: true),
    "an already-settled approval says the ledger's direction")
  let failed = P.line(for: .failed(.refused), intent: intent(.reject))
  check(
    failed
      == MomoPushActionLine(
        text: "거절하지 못했어요", detail: "눌러서 앱에서 마무리해 주세요", alerts: true, removesSiblings: false),
    "a failure alerts, says what to do in its body, and leaves the other notifications (the approval is still pending)")
  for reason in [MomoPushActionFailure.noToken, .tokenExpired, .otherWorkspace, .unauthorized, .network, .timeLimit,
    .unreadableNotification, .unresolvedNotification, .noDeviceSecret, .server, .conflict, .notFound,
    .rateLimited, .badRequest, .unexpected]
  {
    let line = P.line(for: .failed(reason), intent: intent())
    check(line.text == "승인하지 못했어요" && line.detail == "눌러서 앱에서 마무리해 주세요",
      "failure \(reason.rawValue) is the same title and the same next step")
  }

  let origin = P.userInfo(origin: intent().origin)
  let carried = origin[MomoPushActionContract.originKey] as? [String: Any]
  check(origin.count == 1 && carried != nil, "the line carries the original payload under one key")
  check(MomoPushActionEnvelope.parse(userInfo: carried ?? [:]) == MomoPushActionEnvelope.parse(userInfo: payload()),
    "the carried payload still parses to the same approval (the tap can land on the card)")
  check(P.userInfo(origin: nil).isEmpty, "no payload to carry is an empty userInfo")
  check(P.userInfo(origin: Data("[1,2]".utf8)).isEmpty, "a payload that is not an object is not carried")
}

do {
  let line = MomoPushActionPlanner.line(for: .decided(.approve), intent: intent(request: "apns-collapse-7"))
  let quiet = MomoPushActionPlanner.notice(for: line, intent: intent(request: "apns-collapse-7"))
  check(quiet.identifier == "apns-collapse-7",
    "the replacement has the SAME identifier as the notification it answers (iOS replaces the delivered one)")
  check(quiet.threadIdentifier == channelID, "the replacement stays in the original's thread")
  check(quiet.categoryIdentifier == "", "the replacement carries no category, so no buttons")
  check(quiet.title == "승인했어요 · 그록봇" && !quiet.alerts, "a confirmation is the list only")
  check(quiet.body == "", "and has no body")
  check((quiet.userInfo[MomoPushActionContract.originKey] as? [String: Any]) != nil,
    "and it carries the payload the tap needs to land on the card")
  let failedLine = MomoPushActionPlanner.line(for: .failed(.network), intent: intent(request: "apns-collapse-7"))
  let loud = MomoPushActionPlanner.notice(for: failedLine, intent: intent(request: "apns-collapse-7"))
  check(loud.alerts && loud.categoryIdentifier == "" && loud.identifier == "apns-collapse-7",
    "a failure alerts, still with no buttons, still in the same slot")
  check(loud.title == "승인하지 못했어요" && loud.body == "눌러서 앱에서 마무리해 주세요",
    "and carries its next step as the body, so a clipped title never hides it")
  let bare = MomoPushActionPlanner.notice(
    for: failedLine,
    intent: MomoPushActionIntent(
      direction: .approve, requestIdentifier: "x", title: "t", body: "b", threadIdentifier: "th", envelope: nil,
      origin: nil))
  check(bare.userInfo.isEmpty, "a notification whose payload could not be read carries nothing to land on")
}

do {
  let envelope = MomoPushActionEnvelope.parse(userInfo: payload())!
  let otherApproval = payload(approval: "99999999-2222-4333-8444-555555555555")
  let otherWorkspace = payload(workspace: "88888888-2222-4222-8222-222222222222")
  let carriedLine: [AnyHashable: Any] = ["origin": payload()]
  let delivered: [(identifier: String, userInfo: [AnyHashable: Any])] = [
    ("acted", payload()),
    ("sibling-1", payload()),
    ("sibling-2", payload(reason: "resume_offer")),
    ("other-approval", otherApproval),
    ("other-workspace", otherWorkspace),
    ("a-message", payload(category: "momo.message", approval: nil)),
    ("an-old-result-line", carriedLine),
    ("unreadable", ["aps": [:]]),
  ]
  check(
    MomoPushActionPlanner.siblings(delivered: delivered, of: envelope, excluding: "acted")
      == ["sibling-1", "sibling-2"],
    "only the same workspace's same approval, other than the replaced notification, is a sibling")
}

// ---- the whole decision, with the outside world faked ---------------------------------------

final class FakeCredentials: MomoPushActionCredentials, @unchecked Sendable {
  var session: MomoPushActionSession?
  var secret: Data?
  var reads = 0
  init(session: MomoPushActionSession?, secret: Data?) {
    self.session = session
    self.secret = secret
  }
  func readSession() -> MomoPushActionSession? { reads += 1; return session }
  func readDeviceSecret() -> Data? { secret }
}

final class FakeTransport: MomoPushActionTransport, @unchecked Sendable {
  var requests: [URLRequest] = []
  var answer: Result<(status: Int, body: Data), Error>
  init(_ answer: Result<(status: Int, body: Data), Error>) { self.answer = answer }
  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    requests.append(request)
    return try answer.get()
  }
}

func decide(
  _ intent: MomoPushActionIntent,
  session: MomoPushActionSession? = MomoPushActionSession.decode(sessionJSON()),
  secret: Data? = secret,
  answer: Result<(status: Int, body: Data), Error> = .success((200, receipt("approved"))),
  now: Int64 = 1_000_000_000_000
) async -> (MomoPushActionOutcome, FakeTransport) {
  let transport = FakeTransport(answer)
  let decider = MomoPushActionDecider(
    credentials: FakeCredentials(session: session, secret: secret), transport: transport, nowMs: { now })
  return (await decider.decide(intent), transport)
}

func keyOf(_ transport: FakeTransport) -> String? {
  guard let body = transport.requests.first?.httpBody,
    let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
  else { return nil }
  return object["client_decision_id"] as? String
}

do {
  let (outcome, transport) = await decide(intent())
  check(outcome == .decided(.approve), "the happy path decides")
  check(transport.requests.count == 1, "exactly one request")
  check(keyOf(transport) == "17b6608d-d7c8-88f7-a289-87f4394b0117",
    "the request carries the key derived from the phone's secret, the notification and the button")
}

do {
  let (a, ta) = await decide(intent(request: "req-9"))
  let (b, tb) = await decide(intent(request: "req-9"))
  check(a == b && keyOf(ta) == keyOf(tb) && keyOf(ta) != nil, "two taps of one notification send one key")
  let (_, tc) = await decide(intent(request: "req-10"))
  check(keyOf(ta) != keyOf(tc), "another notification sends another key")
  let (_, td) = await decide(intent(.reject, request: "req-9"))
  check(keyOf(ta) != keyOf(td), "the other button sends another key")
  let (_, te) = await decide(intent(request: "req-9"), secret: Data(Array(9...40)))
  check(keyOf(ta) != keyOf(te), "another secret sends another key")
}

do {
  let (reject409, t) = await decide(intent(.reject), answer: .success((409, receipt("approved"))))
  check(reject409 == .alreadySettled(.approved) && t.requests.count == 1,
    "a 거절 on an already-approved approval ends as 이미 승인된 요청")
  let (refused, _) = await decide(intent(), answer: .success((403, receipt("opens_in_app"))))
  check(refused == .failed(.refused), "opens_in_app is a failure line")
}

do {
  // A notification nobody resolved ("oort / 새 알림", the relay's placeholder) is never approved blind.
  let (blind, tb) = await decide(intent(title: "oort", body: "새 알림"))
  check(blind == .failed(.unresolvedNotification) && tb.requests.isEmpty,
    "a notification still reading 「oort / 새 알림」 is never approved from the lock screen")
  let (blindReject, tbr) = await decide(intent(.reject, title: " oort ", body: "새 알림\n"))
  check(blindReject == .failed(.unresolvedNotification) && tbr.requests.isEmpty,
    "and whitespace around the placeholder does not hide it (reject too)")
  let (senderOort, ts) = await decide(intent(title: "oort", body: "배포해도 될까요?"))
  check(senderOort == .decided(.approve) && ts.requests.count == 1,
    "a sender who happens to be called oort is not mistaken for the relay")
  let (bodyOnly, tbo) = await decide(intent(title: "그록봇", body: "새 알림"))
  check(bodyOnly == .decided(.approve) && tbo.requests.count == 1,
    "a message whose text is 「새 알림」 from a real sender is still decided")
  check(!intent(title: "oort", body: "새 알림").contentWasResolved && intent().contentWasResolved,
    "contentWasResolved is the two-part test")

  let (unreadable, t1) = await decide(intent(userInfo: ["aps": [:]]))
  check(unreadable == .failed(.unreadableNotification) && t1.requests.isEmpty, "no readable payload: nothing is sent")
  let (noToken, t2) = await decide(intent(), session: nil)
  check(noToken == .failed(.noToken) && t2.requests.isEmpty, "no token: nothing is sent")
  let (expired, t3) = await decide(intent(), now: 2_000_000_000_000)
  check(expired == .failed(.tokenExpired) && t3.requests.isEmpty, "an expired token is not sent")
  let other = MomoPushActionSession.decode(sessionJSON(workspace: "88888888-2222-4222-8222-222222222222"))
  let (mismatch, t4) = await decide(intent(), session: other)
  check(mismatch == .failed(.otherWorkspace) && t4.requests.isEmpty,
    "a token from another workspace is never sent for this notification")
  let (noSecret, t5) = await decide(intent(), secret: nil)
  check(noSecret == .failed(.noDeviceSecret) && t5.requests.isEmpty, "no device secret: nothing is sent")
  let (shortSecret, t6) = await decide(intent(), secret: Data(count: 4))
  check(shortSecret == .failed(.noDeviceSecret) && t6.requests.isEmpty, "a too-short secret is not used")
  let (offline, _) = await decide(intent(), answer: .failure(URLError(.notConnectedToInternet)))
  check(offline == .failed(.network), "offline is a failure")
  let (slow, _) = await decide(intent(), answer: .failure(URLError(.timedOut)))
  check(slow == .failed(.network), "a timeout is a failure")
  let (cancelled, _) = await decide(intent(), answer: .failure(CancellationError()))
  check(cancelled == .failed(.timeLimit), "a request cancelled by the background-time limit is timeLimit")
  let (urlCancelled, _) = await decide(intent(), answer: .failure(URLError(.cancelled)))
  check(urlCancelled == .failed(.timeLimit), "URLSession reports a cancelled task as URLError.cancelled: also timeLimit")
}

// ---- the keychain logic (the SecItem calls faked) --------------------------------------------

final class Counter: @unchecked Sendable { var value = 0 }

final class FakeKeychain: MomoPushActionKeychainClient, @unchecked Sendable {
  var items: [String: Data] = [:]
  var copyStatusOverride: OSStatus?
  var addStatusOverride: OSStatus?
  var queries: [[String: Any]] = []
  var adds: [[String: Any]] = []
  var deletes = 0
  /// Called between a read that found nothing and the add that follows it.
  var beforeAdd: (() -> Void)?

  private func key(_ attributes: [String: Any]) -> String {
    "\(attributes[kSecAttrService as String] as? String ?? "")|\(attributes[kSecAttrAccount as String] as? String ?? "")|\(attributes[kSecAttrAccessGroup as String] as? String ?? "")"
  }

  func copyData(_ query: [String: Any]) -> (status: OSStatus, data: Data?) {
    queries.append(query)
    if let status = copyStatusOverride { return (status, nil) }
    if let data = items[key(query)] { return (errSecSuccess, data) }
    return (errSecItemNotFound, nil)
  }

  func add(_ attributes: [String: Any]) -> OSStatus {
    beforeAdd?()
    adds.append(attributes)
    if let status = addStatusOverride { return status }
    if items[key(attributes)] != nil { return errSecDuplicateItem }
    items[key(attributes)] = attributes[kSecValueData as String] as? Data
    return errSecSuccess
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    deletes += 1
    items[key(query)] = nil
    return errSecSuccess
  }
}

do {
  let group = "YWQQFQM38J.app.momo.ios.devicekey"
  let ok = MomoPushActionKeychain.accessGroup
  check(ok("YWQQFQM38J.app.momo.ios.devicekey") == group, "the app-only group is read from the plist value")
  check(ok("  YWQQFQM38J.app.momo.ios.devicekey\n") == group, "the plist value is trimmed")
  check(ok("YWQQFQM38J.app.momo.ios.shared") == nil,
    "THE SHARED GROUP (the one the notification extension reads) is never accepted")
  check(ok("$(AppIdentifierPrefix)app.momo.ios.devicekey") == nil, "an unexpanded build setting is no group")
  check(ok("") == nil && ok(nil) == nil && ok(42) == nil, "empty, missing and non-string are no group")

  let fake = FakeKeychain()
  let counter = Counter()
  let keychain = MomoPushActionKeychain(
    accessGroup: group, client: fake,
    randomSecret: { counter.value += 1; return Data(repeating: UInt8(counter.value), count: 32) })

  let address = keychain.query(account: "acct")
  check(address[kSecClass as String] as? String == kSecClassGenericPassword as String, "a generic password")
  check(address[kSecAttrService as String] as? String == "app.momo.ios.pushaction", "the service JS writes under")
  check(address[kSecAttrAccount as String] as? String == "acct", "the given account")
  check(address[kSecAttrAccessGroup as String] as? String == group,
    "every query names the app-only group explicitly (an ungrouped one defaults to the shared group)")
  check(address[kSecAttrSynchronizable as String] as? Bool == false, "never synchronizable")

  check(keychain.readSession() == nil, "no item: no session")
  fake.items["app.momo.ios.pushaction|push-action-session|\(group)"] = sessionJSON()
  check(keychain.readSession()?.actionToken == "tok", "JS's item is read from the app-only group")
  fake.items["app.momo.ios.pushaction|push-action-session|\(group)"] = Data("garbage".utf8)
  check(keychain.readSession() == nil, "a malformed item is no session")
  fake.items["app.momo.ios.pushaction|push-action-session|YWQQFQM38J.app.momo.ios.shared"] = sessionJSON()
  fake.items["app.momo.ios.pushaction|push-action-session|\(group)"] = nil
  check(keychain.readSession() == nil, "an item in the SHARED group is invisible to this reader")
  fake.copyStatusOverride = errSecInteractionNotAllowed
  check(keychain.readSession() == nil, "a locked keychain is no session")
  fake.copyStatusOverride = nil

  fake.queries = []
  let first = keychain.readDeviceSecret()
  check(first == Data(repeating: 1, count: 32), "the first read creates a 32-byte secret")
  check(fake.adds.count == 1, "exactly one add")
  check(fake.adds[0][kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
    "the secret is AfterFirstUnlockThisDeviceOnly")
  check(fake.adds[0][kSecAttrAccessGroup as String] as? String == group, "and in the app-only group")
  check(fake.adds[0][kSecAttrSynchronizable as String] as? Bool == false, "and not synchronizable")
  check(keychain.readDeviceSecret() == first, "the second read returns the SAME secret (stable keys)")
  check(fake.adds.count == 1, "and does not add again")
  check(counter.value == 1, "and does not draw randomness again")

  // A corrupt value is replaced, not hashed.
  fake.items["app.momo.ios.pushaction|device-secret-v1|\(group)"] = Data(count: 7)
  let replaced = keychain.readDeviceSecret()
  check(replaced == Data(repeating: 2, count: 32) && fake.deletes == 1, "a secret of the wrong size is deleted and replaced")

  // A keychain that cannot answer must not be mistaken for an empty one.
  let locked = FakeKeychain()
  locked.copyStatusOverride = errSecInteractionNotAllowed
  let drawn = Counter()
  let lockedKeychain = MomoPushActionKeychain(
    accessGroup: group, client: locked, randomSecret: { drawn.value += 1; return Data(repeating: 9, count: 32) })
  check(lockedKeychain.readDeviceSecret() == nil && drawn.value == 0 && locked.adds.isEmpty,
    "a locked keychain yields no secret and invents none (that would change live keys)")

  // Two writers: the other one wins the race.
  let racing = FakeKeychain()
  racing.beforeAdd = {
    racing.items["app.momo.ios.pushaction|device-secret-v1|\(group)"] = Data(repeating: 0xAB, count: 32)
    racing.beforeAdd = nil
  }
  let racingKeychain = MomoPushActionKeychain(
    accessGroup: group, client: racing, randomSecret: { Data(repeating: 1, count: 32) })
  check(racingKeychain.readDeviceSecret() == Data(repeating: 0xAB, count: 32),
    "on errSecDuplicateItem the winner's secret is returned")

  let failing = FakeKeychain()
  failing.addStatusOverride = errSecMissingEntitlement
  let failingKeychain = MomoPushActionKeychain(
    accessGroup: group, client: failing, randomSecret: { Data(repeating: 1, count: 32) })
  check(failingKeychain.readDeviceSecret() == nil, "-34018 (the group is not entitled) yields no secret")
  let weak = MomoPushActionKeychain(accessGroup: group, client: FakeKeychain(), randomSecret: { Data(count: 5) })
  check(weak.readDeviceSecret() == nil, "a random source that returns too few bytes yields no secret")
  let broken = MomoPushActionKeychain(accessGroup: group, client: FakeKeychain(), randomSecret: { nil })
  check(broken.readDeviceSecret() == nil, "a random source that fails yields no secret")
  check(MomoPushActionNoCredentials().readSession() == nil && MomoPushActionNoCredentials().readDeviceSecret() == nil,
    "a build with no resolvable group has no credentials")
}

check(MomoPushActionKeychain.systemRandomSecret()?.count == 32, "the system random source gives 32 bytes")
check(MomoPushActionKeychain.systemRandomSecret() != MomoPushActionKeychain.systemRandomSecret(),
  "and not the same 32 bytes twice")

check(MomoPushActionOutcome.decided(.approve).logName == "decided(approve)", "log name: decided(approve)")
check(MomoPushActionOutcome.decided(.reject).logName == "decided(reject)", "log name: decided(reject)")
check(MomoPushActionOutcome.alreadySettled(.approved).logName == "alreadySettled(approved)", "log name: alreadySettled")
check(MomoPushActionOutcome.failed(.tokenExpired).logName == "failed(tokenExpired)", "log name: failed(reason)")

print(failures == 0 ? "PASS" : "FAILED (\(failures))")
exit(failures == 0 ? 0 : 1)
