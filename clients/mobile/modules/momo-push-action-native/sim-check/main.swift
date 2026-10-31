import Foundation

// Check of the lock-screen decision (#3931, ADR-0204 D6) with nothing but the
// UIKit-free half of the module: MomoPushActionCore.swift,
// MomoPushActionDecisionKey.swift, MomoPushActionKeychain.swift (its SecItem calls
// faked) and MomoPushActionJob.swift (UIApplication and the notification centre
// recorded). A spawned CLI has no UIApplication and no notification centre, so
// what is exercised here is everything that DECIDES — the idempotency key, the
// request, the answer's reading, the sentence, the order in which background time
// is taken and given back — and not the part that merely does as told
// (MomoPushActionHandler.swift). Run by ./run.sh.

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
/// A UUID with hex LETTERS in it, spelled in capitals. The fixtures above have none, so
/// .uppercased()/.lowercased() of them is the same string and a case check on them proves nothing.
let shoutingID = "ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF"

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
  approval: String? = approvalID,
  alert: (title: String, body: String)? = nil
) -> [AnyHashable: Any] {
  var aps: [String: Any] = [:]
  if let alert { aps["alert"] = ["title": alert.title, "body": alert.body] }
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
  check(shoutingID != shoutingID.lowercased(), "the case fixture really differs in case")
  let lowered = MomoPushActionEnvelope.parse(
    userInfo: payload(
      workspace: shoutingID, channel: shoutingID, message: shoutingID, thread: shoutingID, approval: shoutingID))
  check(
    lowered
      == MomoPushActionEnvelope(
        workspaceID: shoutingID.lowercased(), channelID: shoutingID.lowercased(),
        messageID: shoutingID.lowercased(), approvalID: shoutingID.lowercased(),
        threadID: shoutingID.lowercased()),
    "every id is lowercased, whatever case the relay spelled it in")
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
  check(
    MomoPushActionSession.decode(sessionJSON(workspace: shoutingID))?.workspaceID == shoutingID.lowercased(),
    "the session's workspace id is lowercased too, so it compares equal to the payload's whatever the spelling")
  check(MomoPushActionSession.decode(sessionJSON(token: "")) == nil, "an empty token is no session")
  check(MomoPushActionSession.decode(sessionJSON(workspace: "x")) == nil, "a bad workspace id is no session")
  check(MomoPushActionSession.decode(sessionJSON(baseURL: "ftp://x.example.com")) == nil,
    "a non-http base is no session")
  check(MomoPushActionSession.decode(sessionJSON(baseURL: "not a url")) == nil, "an unparseable base is no session")
  check(MomoPushActionSession.decode(sessionJSON(baseURL: "https://")) == nil, "a base without a host is no session")
  check(MomoPushActionSession.decode(Data("{}".utf8)) == nil, "an empty object is no session")
  check(MomoPushActionSession.decode(Data("nope".utf8)) == nil, "garbage is no session")
  // Built as a dictionary, not typed as JSON text: a JSON-shaped string literal next to words like "token" is
  // what the repository's secret scanner mistakes for a credential.
  let withoutCredential = try! JSONSerialization.data(withJSONObject: [
    "baseURL": "https://a.example.com", "workspaceID": workspaceID, "expiresAtMs": 1,
  ])
  check(MomoPushActionSession.decode(withoutCredential) == nil, "an item without the credential field is no session")
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
  // An upper-case payload still addresses the lower-case route (the envelope lowercased its ids).
  let shoutedEnvelope = MomoPushActionEnvelope.parse(
    userInfo: payload(workspace: shoutingID, approval: shoutingID))!
  let shouted = MomoPushActionRequestBuilder.make(
    session: session, envelope: shoutedEnvelope, direction: .approve, decisionID: fixedDecisionID)!
  check(
    shouted.url?.absoluteString
      == "https://oort.example.com/v1/workspaces/\(shoutingID.lowercased())/approvals/\(shoutingID.lowercased())/decision",
    "the route is built from the lower-cased ids")
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
  // A 200 is a decision only because of the receipt it carries (`decision_receipt` always has a
  // `status`). One without a verdict (a proxy's page, a body that changed) may or may not have recorded
  // anything, and the lock screen must not claim either.
  check(C.classify(httpStatus: 200, body: Data(), direction: .approve) == .failed(.unclearAnswer),
    "a 200 with no body is not a receipt: the result is unclear")
  check(C.classify(httpStatus: 200, body: Data("<html>".utf8), direction: .reject) == .failed(.unclearAnswer),
    "a 200 that is not JSON is not a receipt either")
  check(C.classify(httpStatus: 200, body: receipt(nil), direction: .approve) == .failed(.unclearAnswer),
    "a 200 whose JSON has no status is unclear")
  check(C.classify(httpStatus: 200, body: receipt("pending"), direction: .approve) == .failed(.unclearAnswer),
    "a 200 whose status is not a verdict is unclear")
  // The first call of a key that finds the approval settled is a 409; a RETRY of that key is answered the
  // stored receipt with a 200 (the server checks idempotency first), so a 200 can say expired or cancelled.
  check(C.classify(httpStatus: 200, body: receipt("expired"), direction: .approve) == .alreadySettled(.expired),
    "a 200 replaying an expired receipt says the approval expired")
  check(C.classify(httpStatus: 200, body: receipt("cancelled"), direction: .reject) == .alreadySettled(.cancelled),
    "a 200 replaying a cancelled receipt says it was cancelled")
  for status in [201, 202, 204, 206, 299] {
    check(C.classify(httpStatus: status, body: receipt("approved"), direction: .approve) == .failed(.unclearAnswer),
      "a \(status) is not the route's answer: unclear, whatever it carries")
  }
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
    "a redirect is not an answer (and none is followed)")
  check(C.classify(httpStatus: 199, body: Data(), direction: .approve) == .failed(.unexpected), "a 1xx")
  check(C.classify(httpStatus: 300, body: Data(), direction: .approve) == .failed(.unexpected), "a 300")
  check(C.classify(httpStatus: 400, body: Data(), direction: .approve) == .failed(.unexpected), "400")
}

// ---- the sentences -----------------------------------------------------------------------

do {
  typealias Copy = MomoPushActionCopy
  check(Copy.decided(.approve, title: "그록봇") == "승인했어요 · 그록봇", "승인했어요 · {제목}")
  check(Copy.decided(.reject, title: "그록봇") == "거부했어요 · 그록봇", "거부했어요 · {제목}")
  check(Copy.decided(.approve, title: "  그록봇\n") == "승인했어요 · 그록봇", "the title is trimmed")
  check(Copy.decided(.approve, title: "") == "승인했어요", "an empty title is left off")
  check(Copy.decided(.reject, title: "oort") == "거부했어요", "the relay's placeholder title is left off")
  check(Copy.alreadySettled(.approved) == "이미 승인된 요청이에요", "이미 승인된 요청이에요")
  check(Copy.alreadySettled(.rejected) == "이미 거부된 요청이에요", "이미 거부된 요청이에요")
  check(Copy.alreadySettled(.expired) == "이미 만료된 요청이에요", "이미 만료된 요청이에요")
  check(Copy.alreadySettled(.cancelled) == "이미 취소된 요청이에요", "이미 취소된 요청이에요")
  check(Copy.failed(.approve) == "승인하지 못했어요", "승인하지 못했어요")
  check(Copy.failed(.reject) == "거부하지 못했어요", "a 거절 that failed does not say 승인")
  check(Copy.failedDetail == "눌러서 앱에서 마무리해 주세요", "the next step is one 해요체 sentence")
  check(Copy.unknownResult == "결과를 확인하지 못했어요", "when the answer never came: the result is unknown, not 「못했어요」")
  check(Copy.unknownResultDetail == "눌러서 앱에서 확인해 주세요", "and the card in the app is where it is known, one tap away like the other failure's next step")
  check(!Copy.unknownResult.contains("승인") && !Copy.unknownResult.contains("거절"),
    "the unknown-result line names neither verdict (it cannot know which, if any, was recorded)")

  // The design system bans the em dash outright (docs/design-system/README.md); nothing measures a Swift
  // string, so this sweep over EVERY sentence the module can put on a lock screen is the only thing that
  // would notice one.
  var everySentence: [String] = [
    Copy.failed(.approve), Copy.failed(.reject), Copy.failedDetail,
    Copy.unknownResult, Copy.unknownResultDetail,
    Copy.decided(.approve, title: "그록봇"), Copy.decided(.reject, title: "그록봇"),
    Copy.decided(.approve, title: ""),
  ]
  for status in [MomoPushActionLedgerStatus.approved, .rejected, .expired, .cancelled] {
    everySentence.append(Copy.alreadySettled(status))
  }
  check(everySentence.count == 12, "the sweep covers every sentence")
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
    origin: try? JSONSerialization.data(withJSONObject: info),
    relayAlert: MomoPushActionRelayAlert.read(userInfo: info))
}

do {
  typealias P = MomoPushActionPlanner
  // 요청 고리: 영수증의 공개 한 줄만 결과 알림으로 읽어요. 실패·알 수 없는 상태는
  // 서버가 line을 보내도 기존 실패 안내를 지켜요. 네이티브 실행은 스택 검증에서 해요.
  for (status, httpStatus, direction, text) in [
    ("approved", 200, MomoPushActionDirection.approve, "✓ 소개를 바꿨어요"),
    ("rejected", 200, MomoPushActionDirection.reject, "소개 바꾸기를 거부했어요"),
    ("approved", 409, MomoPushActionDirection.reject, "이미 승인된 요청이에요 · 소개 바꾸기"),
    ("expired", 200, MomoPushActionDirection.approve, "승인을 기다리다 만료됐어요"),
  ] {
    let body = try! JSONSerialization.data(withJSONObject: ["status": status, "line": text])
    let outcome = MomoPushActionClassifier.classify(httpStatus: httpStatus, body: body, direction: direction)
    let line = P.line(for: outcome, intent: intent(direction))
    check(line.text == text && !line.alerts && line.removesSiblings,
      "receipt.line replaces the same notification quietly, including a contradictory 409")
    check(!outcome.logName.contains(text), "the public line is never put in the native outcome log")
  }
  let invalidLines: [Any] = ["", "  \n", 42, NSNull()]
  for invalidLine in invalidLines {
    let body = try! JSONSerialization.data(withJSONObject: ["status": "approved", "line": invalidLine])
    let outcome = MomoPushActionClassifier.classify(httpStatus: 200, body: body, direction: .approve)
    check(P.line(for: outcome, intent: intent()).text == "승인했어요 · 그록봇",
      "missing, blank and unreadable receipt lines keep the old server wording")
  }
  let refusedBody = try! JSONSerialization.data(withJSONObject: ["status": "approved", "line": "✓ 소개를 바꿨어요"])
  let refusedOutcome = MomoPushActionClassifier.classify(httpStatus: 403, body: refusedBody, direction: .approve)
  check(P.line(for: refusedOutcome, intent: intent()).text == "승인하지 못했어요",
    "a receipt line never promotes an HTTP failure to a successful result")
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
        text: "거부하지 못했어요", detail: "눌러서 앱에서 마무리해 주세요", alerts: true, removesSiblings: false),
    "a failure alerts, says what to do in its body, and leaves the other notifications (the approval is still pending)")
  // Every failure there is, by CaseIterable, so a new one cannot slip in without choosing a sentence.
  let maybeRecorded: Set<MomoPushActionFailure> = [.network, .timeLimit, .server, .unclearAnswer]
  check(Set(MomoPushActionFailure.allCases.filter { $0.mayHaveBeenRecorded }) == maybeRecorded,
    "the failures after which the decision may be on the server are exactly: network, timeLimit, server, unclearAnswer")
  for reason in MomoPushActionFailure.allCases {
    for direction in [MomoPushActionDirection.approve, .reject] {
      let line = P.line(for: .failed(reason), intent: intent(direction))
      let verb = direction.approved ? "승인하지 못했어요" : "거부하지 못했어요"
      if maybeRecorded.contains(reason) {
        check(
          line == MomoPushActionLine(
            text: "결과를 확인하지 못했어요", detail: "눌러서 앱에서 확인해 주세요", alerts: true, removesSiblings: false),
          "failure \(reason.rawValue) (\(direction.approved ? "승인" : "거절")): the result is unknown, for either button")
      } else {
        check(
          line == MomoPushActionLine(
            text: verb, detail: "눌러서 앱에서 마무리해 주세요", alerts: true, removesSiblings: false),
          "failure \(reason.rawValue) (\(direction.approved ? "승인" : "거절")): nothing was recorded, the verb follows the button")
      }
    }
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
  let failedLine = MomoPushActionPlanner.line(for: .failed(.refused), intent: intent(request: "apns-collapse-7"))
  let loud = MomoPushActionPlanner.notice(for: failedLine, intent: intent(request: "apns-collapse-7"))
  check(loud.alerts && loud.categoryIdentifier == "" && loud.identifier == "apns-collapse-7",
    "a failure alerts, still with no buttons, still in the same slot")
  check(loud.title == "승인하지 못했어요" && loud.body == "눌러서 앱에서 마무리해 주세요",
    "and carries its next step as the body, so a clipped title never hides it")
  let unknownLine = MomoPushActionPlanner.line(for: .failed(.timeLimit), intent: intent(request: "apns-collapse-7"))
  let unknown = MomoPushActionPlanner.notice(for: unknownLine, intent: intent(request: "apns-collapse-7"))
  check(unknown.title == "결과를 확인하지 못했어요" && unknown.body == "눌러서 앱에서 확인해 주세요" && unknown.alerts
    && unknown.identifier == "apns-collapse-7" && unknown.categoryIdentifier == "",
    "an unknown result alerts, says where to look, and replaces the same slot without buttons")
  check((unknown.userInfo[MomoPushActionContract.originKey] as? [String: Any]) != nil,
    "and its tap lands on the approval's card too")
  let bare = MomoPushActionPlanner.notice(
    for: failedLine,
    intent: MomoPushActionIntent(
      direction: .approve, requestIdentifier: "x", title: "t", body: "b", threadIdentifier: "th", envelope: nil,
      origin: nil, relayAlert: nil))
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

  // The relay's alert is read from the PAYLOAD (aps.alert), so a change of the relay's copy cannot make an
  // unseen approval look resolved. The extension rewrites it; a notification still equal to it was never seen.
  let relayWords = (title: "새 승인 요청", body: "열어서 확인하세요")
  let relayInfo = payload(alert: relayWords)
  check(
    MomoPushActionRelayAlert.read(userInfo: relayInfo)
      == MomoPushActionRelayAlert(title: relayWords.title, body: relayWords.body),
    "aps.alert.title/body are read from the payload")
  check(MomoPushActionRelayAlert.read(userInfo: payload()) == nil, "a payload with no aps.alert has no relay alert")
  check(MomoPushActionRelayAlert.read(userInfo: ["aps": ["alert": "plain string"]]) == nil,
    "an alert that is a plain string is not read as one")
  check(MomoPushActionRelayAlert.read(userInfo: ["aps": ["alert": ["title": "t"]]]) == nil,
    "an alert with no body is not read as one")
  check(MomoPushActionRelayAlert.read(userInfo: ["aps": ["alert": ["title": 1, "body": 2]]]) == nil,
    "an alert whose parts are not strings is not read as one")

  let stillRelay = intent(title: relayWords.title, body: relayWords.body, userInfo: relayInfo)
  check(!stillRelay.contentWasResolved, "a notification still showing exactly what the relay sent is unresolved, in whatever words")
  let (blindByAlert, tba) = await decide(stillRelay)
  check(blindByAlert == .failed(.unresolvedNotification) && tba.requests.isEmpty,
    "and it is never approved from the lock screen")
  let (blindByAlertReject, tbar) = await decide(
    intent(.reject, title: " \(relayWords.title) ", body: "\(relayWords.body)\n", userInfo: relayInfo))
  check(blindByAlertReject == .failed(.unresolvedNotification) && tbar.requests.isEmpty,
    "whitespace around it does not hide it (reject too)")
  check(intent(title: "그록봇", body: "배포해도 될까요?", userInfo: relayInfo).contentWasResolved,
    "one the extension rewrote is resolved")
  check(intent(title: relayWords.title, body: "배포해도 될까요?", userInfo: relayInfo).contentWasResolved,
    "a sender named like the relay's title, with their own text, is resolved (both halves must match)")
  check(intent(title: "그록봇", body: relayWords.body, userInfo: relayInfo).contentWasResolved,
    "and so is one whose text happens to equal the relay's body")
  check(!intent(title: "oort", body: "새 알림", userInfo: relayInfo).contentWasResolved,
    "the known placeholder is still unresolved beside an alert in other words")

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
  let shoutingSession = MomoPushActionSession.decode(sessionJSON(workspace: workspaceID.uppercased()))
  let (sameWorkspaceShouted, tsw) = await decide(intent(), session: shoutingSession)
  check(sameWorkspaceShouted == .decided(.approve) && tsw.requests.count == 1,
    "the same workspace spelled in another case is the same workspace")
  let lettered = "ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF"
  let letteredSession = MomoPushActionSession.decode(sessionJSON(workspace: lettered))
  let (letteredMatch, tl) = await decide(intent(userInfo: payload(workspace: lettered.lowercased())), session: letteredSession)
  check(letteredMatch == .decided(.approve) && tl.requests.count == 1,
    "a token minted for an upper-case spelling of the notification's workspace is accepted (ids with hex letters)")
  let (letteredOther, tlo) = await decide(
    intent(userInfo: payload(workspace: "abcdefab-1234-4abc-8def-abcdefabcde0")), session: letteredSession)
  check(letteredOther == .failed(.otherWorkspace) && tlo.requests.isEmpty,
    "and one id apart is another workspace")
  let (replayedExpiry, _) = await decide(intent(), answer: .success((200, receipt("expired"))))
  check(replayedExpiry == .alreadySettled(.expired), "the whole decision reports a replayed expiry as already settled")
  let (noReceipt, _) = await decide(intent(), answer: .success((200, Data("<html>".utf8))))
  check(noReceipt == .failed(.unclearAnswer), "a 200 that is not a receipt is not reported as a decision")
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

  /// What react-native-keychain's `setGenericPassword` does BEFORE it writes (RNKeychainManager.m): delete
  /// every generic-password item of the service in the group, whatever its account.
  func deleteEverythingOf(service: String, group: String) {
    items = items.filter { !($0.key.hasPrefix("\(service)|") && $0.key.hasSuffix("|\(group)")) }
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

  let address = keychain.query(service: MomoPushActionContract.keychainService, account: "acct")
  check(address[kSecClass as String] as? String == kSecClassGenericPassword as String, "a generic password")
  check(address[kSecAttrService as String] as? String == "app.momo.ios.pushaction", "the service JS writes under")
  check(address[kSecAttrAccount as String] as? String == "acct", "the given account")
  check(address[kSecAttrAccessGroup as String] as? String == group,
    "every query names the app-only group explicitly (an ungrouped one defaults to the shared group)")
  check(address[kSecAttrSynchronizable as String] as? Bool == false, "never synchronizable")

  let secretAddress = keychain.query(
    service: MomoPushActionContract.deviceSecretService, account: MomoPushActionContract.deviceSecretAccount)
  check(secretAddress[kSecAttrService as String] as? String == "app.momo.ios.pushaction.secret",
    "the secret lives in a service of its own")
  check(
    MomoPushActionContract.deviceSecretService != MomoPushActionContract.keychainService,
    "and that service is not the one JS writes the token under (JS deletes every item of ITS service on each publish)")
  check(secretAddress[kSecAttrAccessGroup as String] as? String == group, "in the same app-only group")

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
  fake.items["app.momo.ios.pushaction.secret|device-secret-v1|\(group)"] = Data(count: 7)
  let replaced = keychain.readDeviceSecret()
  check(replaced == Data(repeating: 2, count: 32) && fake.deletes == 1, "a secret of the wrong size is deleted and replaced")

  // The finding that moved the secret out of the session's service: a token publish deletes EVERY item of
  // the session's service first. The control proves the fake does what the library does; the check proves
  // the secret is out of its reach.
  let sameService = FakeKeychain()
  sameService.items["app.momo.ios.pushaction|device-secret-v1|\(group)"] = Data(repeating: 5, count: 32)
  sameService.items["app.momo.ios.pushaction|push-action-session|\(group)"] = sessionJSON()
  sameService.deleteEverythingOf(service: "app.momo.ios.pushaction", group: group)
  check(sameService.items.isEmpty, "(control) a publish takes every item of the service with it, whatever its account")
  let keptSecret = keychain.readDeviceSecret()
  let drawsBefore = counter.value
  fake.items["app.momo.ios.pushaction|push-action-session|\(group)"] = sessionJSON()
  fake.deleteEverythingOf(service: MomoPushActionContract.keychainService, group: group)
  check(fake.items["app.momo.ios.pushaction|push-action-session|\(group)"] == nil, "(the publish took the token)")
  check(keychain.readDeviceSecret() == keptSecret && keptSecret != nil && counter.value == drawsBefore,
    "and left the secret, which is read back unchanged without drawing a new one (the keys on the lock screen keep their meaning)")

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
    racing.items["app.momo.ios.pushaction.secret|device-secret-v1|\(group)"] = Data(repeating: 0xAB, count: 32)
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
check(MomoPushActionOutcome.failed(.unclearAnswer).logName == "failed(unclearAnswer)", "log name: failed(unclearAnswer)")

// ---- the job: background time, one line, one end of the task ----------------------------------
//
// The independent security review of #3931 broke the first version of this five ways (the task taken from
// inside a `Task`, not ended on the happy path, not ended on expiry, a result written twice, ...), and each
// passed the text-matching tests that stood in for it. These run the real MomoPushActionJob against a recorded
// UIApplication and a recorded notification centre, and read the ORDER things happened in.

/// What the job did to the outside world, in the order it did it.
final class Events: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []
  func add(_ event: String) { lock.lock(); items.append(event); lock.unlock() }
  var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
  func count(_ event: String) -> Int { all.filter { $0 == event }.count }
}

final class RecordedTasks: MomoPushActionBackgroundTasks, @unchecked Sendable {
  let events: Events
  private let lock = NSLock()
  private var expiration: (@Sendable () -> Void)?
  private var names: [String] = []
  /// iOS refusing to give any time.
  var refuse = false
  /// iOS running the expiration handler before `begin` has returned.
  var expireInsideBegin = false
  init(_ events: Events) { self.events = events }

  func begin(name: String, expiration: @escaping @Sendable () -> Void) -> Int? {
    events.add("begin")
    lock.lock(); names.append(name); lock.unlock()
    if refuse { return nil }
    lock.lock(); self.expiration = expiration; lock.unlock()
    if expireInsideBegin { expiration() }
    return 41
  }
  func end(_ token: Int) { events.add("end:\(token)") }
  var beginNames: [String] { lock.lock(); defer { lock.unlock() }; return names }
  /// iOS running out of time.
  func expire() {
    lock.lock(); let handler = expiration; lock.unlock()
    handler?()
  }
}

/// Holds a caller until the test lets it go.
final class OpenGate: @unchecked Sendable {
  private let lock = NSLock()
  private var opened = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func wait() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      if opened { lock.unlock(); continuation.resume(); return }
      waiters.append(continuation)
      lock.unlock()
    }
  }
  func open() {
    lock.lock(); opened = true; let pending = waiters; waiters = []; lock.unlock()
    for waiter in pending { waiter.resume() }
  }
}

final class RecordedNotifier: MomoPushActionNotifying, @unchecked Sendable {
  let events: Events
  /// When set, `apply` does not return until it is opened.
  var hold: OpenGate?
  private let lock = NSLock()
  private var appliedLines: [MomoPushActionLine] = []
  private var postedLines: [MomoPushActionLine] = []
  init(_ events: Events) { self.events = events }

  func apply(_ line: MomoPushActionLine, intent: MomoPushActionIntent) async {
    lock.withLock { appliedLines.append(line) }
    events.add("apply:\(line.text)")
    if let hold { await hold.wait() }
    events.add("applied")
  }
  func postWithoutWaiting(_ line: MomoPushActionLine, intent: MomoPushActionIntent) {
    lock.lock(); postedLines.append(line); lock.unlock()
    events.add("post:\(line.text)")
  }
  var applied: [MomoPushActionLine] { lock.lock(); defer { lock.unlock() }; return appliedLines }
  var posted: [MomoPushActionLine] { lock.lock(); defer { lock.unlock() }; return postedLines }
}

/// A server that answers when the test says so, and that notices being cancelled.
final class HeldTransport: MomoPushActionTransport, @unchecked Sendable {
  typealias Answer = Result<(status: Int, body: Data), Error>
  let events: Events
  private let lock = NSLock()
  private var continuation: CheckedContinuation<(status: Int, body: Data), Error>?
  private var released: Answer?
  private var cancelled = false
  private var sendCount = 0
  init(_ events: Events) { self.events = events }

  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    events.add("send")
    lock.withLock { sendCount += 1 }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(status: Int, body: Data), Error>) in
        lock.lock()
        if let released { lock.unlock(); continuation.resume(with: released); return }
        if cancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        self.continuation = continuation
        lock.unlock()
      }
    } onCancel: {
      lock.lock(); cancelled = true; let pending = continuation; continuation = nil; lock.unlock()
      pending?.resume(throwing: CancellationError())
    }
  }

  /// The server answering (before or after the request is in flight).
  func answer(_ result: Answer) {
    lock.lock(); released = result; let pending = continuation; continuation = nil; lock.unlock()
    pending?.resume(with: result)
  }
  var isWaiting: Bool { lock.lock(); defer { lock.unlock() }; return continuation != nil }
  var sends: Int { lock.lock(); defer { lock.unlock() }; return sendCount }
}

/// `waitForCompletion` with a deadline: a job that never finishes FAILS a check instead of hanging the run.
func finished(_ job: MomoPushActionJob, within seconds: Double = 10) async -> Bool {
  let done = Counter()
  Task {
    await job.waitForCompletion()
    done.value = 1
  }
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline && done.value == 0 { try? await Task.sleep(nanoseconds: 2_000_000) }
  return done.value == 1
}

func eventually(timeout: TimeInterval = 5, _ condition: () -> Bool) async -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 2_000_000)
  }
  return condition()
}

struct JobRig {
  let events = Events()
  let tasks: RecordedTasks
  let notifier: RecordedNotifier
  let transport: HeldTransport
  let job: MomoPushActionJob

  init(
    _ intent: MomoPushActionIntent = intent(),
    session: MomoPushActionSession? = MomoPushActionSession.decode(sessionJSON())
  ) {
    tasks = RecordedTasks(events)
    notifier = RecordedNotifier(events)
    transport = HeldTransport(events)
    job = MomoPushActionJob(
      intent: intent,
      decider: MomoPushActionDecider(
        credentials: FakeCredentials(session: session, secret: secret), transport: transport,
        nowMs: { 1_000_000_000_000 }),
      notifier: notifier, tasks: tasks)
  }
}

do {
  // The clock already ran out: a decision begun on a cancelled task sends nothing.
  let gate = OpenGate()
  let transport = FakeTransport(.success((200, receipt("approved"))))
  let decider = MomoPushActionDecider(
    credentials: FakeCredentials(session: MomoPushActionSession.decode(sessionJSON()), secret: secret),
    transport: transport, nowMs: { 1_000_000_000_000 })
  let work = Task { () -> MomoPushActionOutcome in
    await gate.wait()
    return await decider.decide(intent())
  }
  work.cancel()
  gate.open()
  let outcome = await work.value
  check(outcome == .failed(.timeLimit) && transport.requests.isEmpty,
    "a decision begun on a cancelled task sends nothing and is reported as running out of time")
}

do {
  // the answer comes back first
  let rig = JobRig()
  rig.transport.answer(.success((200, receipt("approved"))))
  rig.job.start()
  check(rig.events.all.first == "begin", "the background task is taken inside start(), before anything is awaited")
  check(rig.tasks.beginNames == ["oort.push-action.decision"], "exactly one task, with its name")
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "send", "apply:승인했어요 · 그록봇", "applied", "end:41"],
    "begin, THEN the request, then the one line, and only after the line is placed the task is given back")
  check(rig.notifier.posted.isEmpty, "the expiration path wrote nothing")
}

do {
  // a failure ends the task too
  let rig = JobRig(intent(.reject))
  rig.transport.answer(.success((403, receipt("opens_in_app"))))
  rig.job.start()
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "send", "apply:거부하지 못했어요", "applied", "end:41"],
    "a refusal is a line and an end of the task, the same as a success")
}

do {
  // nothing to send: the task is still taken and still given back
  let rig = JobRig(intent(), session: nil)
  rig.job.start()
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "apply:승인하지 못했어요", "applied", "end:41"] && rig.transport.sends == 0,
    "no token: no request, one line, the task given back")
}

do {
  // an unreadable notification: the same
  let rig = JobRig(intent(userInfo: ["aps": [:]]))
  rig.job.start()
  check(await finished(rig.job), "the job finishes")
  check(rig.events.all == ["begin", "apply:승인하지 못했어요", "applied", "end:41"] && rig.transport.sends == 0,
    "an unreadable payload: no request, one line, the task given back")
}

do {
  // the clock wins
  let rig = JobRig()
  rig.job.start()
  check(await eventually { rig.transport.isWaiting }, "the request is in flight")
  rig.tasks.expire()
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "send", "post:결과를 확인하지 못했어요", "end:41"],
    "when time runs out the line is posted without waiting, then the task is given back, in that order")
  check(rig.notifier.applied.isEmpty, "and the request that was cancelled writes no second line")
  check(rig.notifier.posted.count == 1 && rig.events.count("end:41") == 1, "one line, one end")

  rig.tasks.expire()
  check(rig.events.all.count == 4, "a second expiration changes nothing")
}

do {
  // the answer arrives, then the clock runs out while the line is being placed
  let rig = JobRig()
  let gate = OpenGate()
  rig.notifier.hold = gate
  rig.transport.answer(.success((200, receipt("approved"))))
  rig.job.start()
  check(await eventually { rig.events.all.contains("apply:승인했어요 · 그록봇") }, "the line is being placed")
  rig.tasks.expire()
  check(rig.notifier.posted.isEmpty, "the expiry does not write a second line over the first")
  check(rig.events.count("end:41") == 1, "but it does give the task back before it returns")
  gate.open()
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "send", "apply:승인했어요 · 그록봇", "end:41", "applied"],
    "and when the line finishes the task is not ended again")
}

do {
  // the answer wins, then the clock fires anyway
  let rig = JobRig()
  rig.transport.answer(.success((200, receipt("approved"))))
  rig.job.start()
  check(await finished(rig.job), "the job finishes")
  let before = rig.events.all
  rig.tasks.expire()
  check(rig.events.all == before, "an expiration after the end changes nothing (no second line, no second end)")
}

do {
  // iOS gives no time at all
  let rig = JobRig()
  rig.tasks.refuse = true
  rig.transport.answer(.success((200, receipt("approved"))))
  rig.job.start()
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "send", "apply:승인했어요 · 그록봇", "applied"],
    "a refused task: the request still goes, the line is still placed, and nothing is ended that was never taken")
  rig.tasks.expire()
  check(rig.events.all.count == 4, "and there is no handler to fire")
}

do {
  // iOS runs the expiration handler before begin has returned
  let rig = JobRig()
  rig.tasks.expireInsideBegin = true
  rig.job.start()
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "post:결과를 확인하지 못했어요", "end:41"],
    "an expiry inside begin: one line, the task given back the moment there is one, and no request after the clock")
  check(rig.transport.sends == 0, "nothing was sent")
  check(rig.notifier.applied.isEmpty, "and nothing applied")
}

do {
  // the cancelled request is the same outcome the line is written for
  let rig = JobRig(intent(.reject))
  rig.job.start()
  check(await eventually { rig.transport.isWaiting }, "the 거절 is in flight")
  rig.tasks.expire()
  check(await finished(rig.job), "the job finishes")
  check(rig.notifier.posted.first?.text == "결과를 확인하지 못했어요",
    "an expired 거절 also says the result is unknown, not 「거부하지 못했어요」")
}

do {
  // a lost connection is the same unknown result, through the normal path
  let rig = JobRig()
  rig.transport.answer(.failure(URLError(.networkConnectionLost)))
  rig.job.start()
  check(await finished(rig.job), "the job finishes")
  check(
    rig.events.all == ["begin", "send", "apply:결과를 확인하지 못했어요", "applied", "end:41"],
    "a connection lost after the request left: the line says the result is unknown, and the task is given back")
}

// ---- NSE demotion (ADR-0204 D7): an unresolved approval loses 승인/거부 -------------------------

do {
  typealias D = MomoPushCategoryDemotion
  check(D.categoryIdentifier(current: "momo.approval", resolved: false) == "momo.approval.open",
    "an approval the extension could not fill in becomes the open-only category")
  check(D.categoryIdentifier(current: "momo.approval", resolved: true) == "momo.approval",
    "a resolved approval keeps its buttons")
  for other in ["momo.approval.open", "momo.message", "momo.mention", "momo.work", ""] {
    check(D.categoryIdentifier(current: other, resolved: false) == other, "\(other.isEmpty ? "(none)" : other) is never touched")
  }
  check(MomoPushCategory.approvalOpen.rawValue == "momo.approval.open", "the target category is the one JS registers")
  check(MomoPushActionContract.approvalCategory == MomoPushCategory.approval.rawValue,
    "the handler and the kit agree on the inline approval category")
  check(MomoPushActionContract.placeholderTitle == MomoPushContract.placeholderTitle
    && MomoPushActionContract.placeholderBody == MomoPushContract.placeholderBody,
    "the handler's placeholder is the kit's")
}

// ---- NSE body of a message sent with files and no text (#4294) -----------------------------------
//
// The extension rewrites the notification from what its REST read says (the push carries no content).
// A message with attachments and no text used to throw `messageUnavailable` (empty body) and stay on the
// relay's 「oort / 새 알림」 - with its buttons taken off. This runs the REAL `MomoPushRESTFetcher.fetch`
// against a stubbed URLSession, so what is proven is the decode and the choice, not a copy of them.

final class PushRESTStub: URLProtocol {
  nonisolated(unsafe) static var messagesJSON = Data()
  nonisolated(unsafe) static var rosterJSON = Data()
  nonisolated(unsafe) static var requested: [String] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let url = request.url!
    PushRESTStub.requested.append(url.path + (url.query.map { "?" + $0 } ?? ""))
    let data = url.path.hasSuffix("/roster") ? PushRESTStub.rosterJSON : PushRESTStub.messagesJSON
    let response = HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

do {
  let authorID = "99999999-9999-4999-8999-999999999999"
  let png = #"{"id":"a1","name":"급여명세서-비공개.png","mime":"image/png","sizeBytes":10}"#
  let pdf = #"{"id":"f1","name":"견적.pdf","mime":"application/pdf","sizeBytes":20}"#
  let svg = #"{"id":"s1","name":"도식.svg","mime":"image/svg+xml","sizeBytes":30}"#

  /// The display the extension would show for one message, or nil when it falls back to the placeholder.
  func restDisplay(
    _ fields: String, reason: String = "dm", category: String = "momo.message", approval: String? = nil
  ) async -> PushDisplayContent? {
    PushRESTStub.requested = []
    PushRESTStub.messagesJSON = Data(
      #"{"messages":[{"id":"\#(messageID)","authorMemberId":"\#(authorID)"\#(fields)}]}"#.utf8)
    PushRESTStub.rosterJSON = Data(#"{"members":[{"id":"\#(authorID)","displayName":"이도현"}]}"#.utf8)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PushRESTStub.self]
    let fetcher = MomoPushRESTFetcher(session: URLSession(configuration: configuration))
    guard let envelope = try? MomoPushParser.parse(
      userInfo: payload(reason: reason, category: category, approval: approval))
    else { return nil }
    let session = PushFetchSession(
      baseURL: URL(string: "https://oort.test")!, workspaceID: workspaceID, accessToken: "sim-check-token")
    return try? await fetcher.fetch(envelope: envelope, session: session)
  }

  typealias C = PushAttachmentCopy
  check(C.line(mimeTypes: []) == nil, "no attachment says nothing (nil, not an empty string)")
  check(C.line(mimeTypes: ["image/jpeg"]) == "사진 1장", "one photo")
  check(C.line(mimeTypes: ["image/jpeg", "image/heic", "image/png"]) == "사진 3장", "three photos")
  check(C.line(mimeTypes: ["application/pdf", "video/mp4"]) == "파일 2개", "other kinds are 파일")
  check(C.line(mimeTypes: ["application/pdf", "image/png", "image/png"]) == "사진 2장, 파일 1개",
    "photos first when mixed, whatever order they were attached in")
  check(C.line(mimeTypes: ["image/svg+xml"]) == "파일 1개", "an SVG is a file: the timeline stands it up as a card")
  check(C.line(mimeTypes: ["  IMAGE/PNG "]) == "사진 1장", "case and padding do not matter")
  check(C.line(mimeTypes: [""]) == "파일 1개", "a kind we could not read is one file")

  let onlyPhoto = await restDisplay(#","body":null,"attachments":[\#(png)]"#)
  check(onlyPhoto == PushDisplayContent(title: "이도현", body: "사진 1장"),
    "photo only: 「이도현 / 사진 1장」, not the relay's placeholder")
  check(PushRESTStub.requested.contains(where: { $0.hasSuffix("/messages?limit=200") })
    && PushRESTStub.requested.contains(where: { $0.hasSuffix("/roster") }),
    "the extension read the message page and the roster to build it")
  check(onlyPhoto?.body.contains("급여명세서") == false, "the file name never reaches the lock screen")
  check(await restDisplay(#","body":"","attachments":[\#(png),\#(png),\#(pdf)]"#)
    == PushDisplayContent(title: "이도현", body: "사진 2장, 파일 1개"), "an empty-string body is no text")
  check(await restDisplay(#","body":"   \n ","attachments":[\#(pdf),\#(pdf)]"#)
    == PushDisplayContent(title: "이도현", body: "파일 2개"), "a whitespace-only body is no text")
  check(await restDisplay(#","body":null,"attachments":[\#(svg)]"#)
    == PushDisplayContent(title: "이도현", body: "파일 1개"), "an SVG-only message says 파일")
  check(await restDisplay(#","body":"회의 자료예요","attachments":[\#(png)]"#)
    == PushDisplayContent(title: "이도현", body: "회의 자료예요"), "text wins over attachments")
  check(await restDisplay(#","body":null"#) == nil, "no text and no attachments stays on the placeholder")
  check(await restDisplay(#","body":"","attachments":[]"#) == nil, "an empty attachment list stays on the placeholder")
  check(await restDisplay(#","body":"안녕하세요","attachments":"oops""#)
    == PushDisplayContent(title: "이도현", body: "안녕하세요"),
    "a malformed attachments value does not cost the message its text")
  check(await restDisplay(#","body":null,"attachments":[{"mime":7},null,"x"]"#)
    == PushDisplayContent(title: "이도현", body: "파일 3개"),
    "broken entries are counted as files, never thrown on")

  // ---- ADR-0204 D7: the count line must not bring the approve/reject buttons back -----------------------
  //
  // `NotificationService` puts the original category (the buttons) back when the display differs from the
  // placeholder. A line that is not about the approval ("사진 1장") must therefore never be the display of an
  // approval push, or a lock screen could ask to approve something it never named.
  let photoOnly = #","body":null,"attachments":[\#(png)]"#
  check(await restDisplay(photoOnly, reason: "mention", category: "momo.mention")
    == PushDisplayContent(title: "이도현", body: "사진 1장"), "a mention with only a photo says 사진 1장 too")
  check(await restDisplay(photoOnly, reason: "approval_request", category: "momo.approval", approval: approvalID) == nil,
    "an approval push with no text stays on the placeholder (buttons are taken off), whatever is attached")
  check(await restDisplay(photoOnly, reason: "approval_request", category: "momo.approval.open", approval: approvalID) == nil,
    "so does the open-in-app approval category")
  check(await restDisplay(photoOnly, reason: "mention", category: "momo.approval", approval: approvalID) == nil,
    "the category decides, not only the reason: an approval category with a mention reason is still an approval")
  check(await restDisplay(photoOnly, reason: "resume_offer", category: "momo.work") == nil,
    "a resume offer is not announced by its attachments either")
  check(await restDisplay(photoOnly, reason: "work_session_idle", category: "momo.work") == nil,
    "nor is an idle-session card")
  check(await restDisplay(#","body":"배포 승인 요청","attachments":[\#(png)]"#,
      reason: "approval_request", category: "momo.approval", approval: approvalID)
    == PushDisplayContent(title: "이도현", body: "배포 승인 요청"),
    "an approval with text is shown as before: the text, not the attachments")
  func envelope(_ reason: String, _ category: String, _ approval: String?) -> MomoPushEnvelope? {
    try? MomoPushParser.parse(userInfo: payload(reason: reason, category: category, approval: approval))
  }
  check(envelope("dm", "momo.message", nil).map(PushAttachmentCopy.announces) == true, "dm announces")
  check(envelope("mention", "momo.mention", nil).map(PushAttachmentCopy.announces) == true, "mention announces")
  check(envelope("approval_request", "momo.approval", approvalID).map(PushAttachmentCopy.announces) == false,
    "approval_request does not announce")
  check(envelope("mention", "momo.approval.open", approvalID).map(PushAttachmentCopy.announces) == false,
    "an approval category does not announce, whatever the reason")

  // ---- a message its sender took back: the server empties the text but still sends the attachment list ----
  //
  // The count must not reach the lock screen for a message that no longer exists (the core's inbox and banner
  // look at deletion first; the extension read no `state` at all until #4294's review).
  check(await restDisplay(#","body":null,"state":"deleted","deletedAtMs":1,"attachments":[\#(png)]"#) == nil,
    "a deleted message with attachments stays on the placeholder: its count is not announced")
  check(await restDisplay(#","body":null,"state":"sent","attachments":[\#(png)]"#)
    == PushDisplayContent(title: "이도현", body: "사진 1장"),
    "a live message says its count (control for the deleted one)")
  check(await restDisplay(#","body":null,"state":7,"attachments":[\#(png)]"#)
    == PushDisplayContent(title: "이도현", body: "사진 1장"),
    "a state of the wrong type costs the message nothing: it is read as not deleted")
}

print(failures == 0 ? "PASS" : "FAILED (\(failures))")
exit(failures == 0 ? 0 : 1)
