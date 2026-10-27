import CoreGraphics
import Foundation
import ImageIO

// Check of the communication-notification presentation (#4316, ADR-0204 증보 5) with the code the
// notification extension and the app really run: MomoPushPresentationStore.swift (the App Group state),
// PushNotification.swift (the REST read, the envelope) and PushCommunication.swift (the plan, the photo
// order, the assembly). Every decision in them is run here against temporary directories and a stubbed
// URLSession; the system's half (Intents) is run only when this is spawned inside an iOS simulator
// (`#if os(iOS)` at the end). Run by ./run.sh. People are made up (달무리 스튜디오).

var failures = 0
func check(_ ok: Bool, _ what: String) {
  print("\(ok ? "ok" : "FAIL"): \(what)")
  if !ok { failures += 1 }
}

// ---- fixtures -----------------------------------------------------------------------------------------

let workspaceID = "22222222-2222-4222-8222-222222222222"
let otherWorkspaceID = "77777777-7777-4777-8777-777777777777"
let designChannel = "33333333-3333-4333-8333-333333333333"
let dmChannel = "55555555-5555-4555-8555-555555555555"
let otherChannel = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let messageID = "44444444-4444-4444-8444-444444444444"
let threadRoot = "66666666-6666-4666-8666-666666666666"
let approvalID = "11111111-2222-4333-8444-555555555555"
let dohyun = "99999999-9999-4999-8999-999999999999"  // 이도현, a person with a photo
let seoyeon = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"  // 박서연, a person without one
let helper = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"  // 달무리 도우미, an agent
let legacy = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"  // 최민수, an old member whose avatarUrl is another host
let strayPath = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"  // 정하윤, whose avatarUrl names someone else's picture
let baseURL = "https://oort.test"
let version = "aaaa1111-bbbb-4ccc-8ddd-eeee22223333"

func tempDirectory() -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("momo-push-presentation-\(UUID().uuidString)")
  try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

func envelope(
  _ reason: String, category: String = "momo.message", channel: String = designChannel, thread: String? = nil,
  approval: String? = nil, workspace: String = workspaceID
) -> MomoPushEnvelope {
  var aps: [String: Any] = ["badge": 1, "thread-id": thread ?? channel, "category": category]
  aps["alert"] = ["title": "oort", "body": "새 알림"]
  var momo: [String: Any] = [
    "schema": "momo.push.notification.v2", "server_id": "srv", "workspace_id": workspace, "channel_id": channel,
    "message_id": messageID, "collapse_id": "collapse-1", "reason": reason,
  ]
  if let approval { momo["approval_id"] = approval }
  return try! MomoPushParser.parse(userInfo: ["aps": aps, "momo": momo])
}

func person(_ id: String, _ name: String, agent: Bool = false, avatar: String? = nil) -> PushResolvedAuthor {
  PushResolvedAuthor(
    memberID: id, displayName: name, isAgent: agent,
    avatar: PushAvatarReference.parse(avatar, workspaceID: workspaceID, memberID: id))
}

func resolution(_ author: PushResolvedAuthor?, body: String = "시안 확인 부탁드려요") -> PushResolution {
  PushResolution(display: PushDisplayContent(title: author?.displayName ?? "oort", body: body), author: author)
}

func avatarPath(_ member: String, v: String = version, workspace: String = workspaceID) -> String {
  "/v1/workspaces/\(workspace)/members/\(member)/avatar/content?v=\(v)"
}

// ---- pictures made here -------------------------------------------------------------------------------

func imageBytes(width: Int, height: Int, type: String = "public.png", noise: Bool = false) -> Data {
  let space = CGColorSpaceCreateDeviceRGB()
  let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  if noise {
    let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
    var seed: UInt32 = 12345
    for offset in 0..<(context.bytesPerRow * height) {
      seed = seed &* 1_664_525 &+ 1_013_904_223
      pixels[offset] = (offset % 4 == 3) ? 255 : UInt8(truncatingIfNeeded: seed >> 16)
    }
  } else {
    let gradient = CGGradient(
      colorsSpace: space,
      colors: [CGColor(red: 0.9, green: 0.4, blue: 0.2, alpha: 1), CGColor(red: 0.1, green: 0.3, blue: 0.8, alpha: 1)] as CFArray,
      locations: [0, 1])!
    context.drawLinearGradient(
      gradient, start: .zero, end: CGPoint(x: width, y: height), options: [])
  }
  let output = NSMutableData()
  let destination = CGImageDestinationCreateWithData(output, type as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  CGImageDestinationFinalize(destination)
  return output as Data
}

func decoded(_ png: Data) -> (width: Int, height: Int, pixels: [UInt8])? {
  guard let source = CGImageSourceCreateWithData(png as CFData, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { return nil }
  let width = image.width
  let height = image.height
  let space = CGColorSpaceCreateDeviceRGB()
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
    guard let context = CGContext(
      data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  return drawn ? (width, height, pixels) : nil
}

func pixel(_ image: (width: Int, height: Int, pixels: [UInt8]), x: Int, y: Int) -> (UInt8, UInt8, UInt8) {
  let at = (y * image.width + x) * 4
  return (image.pixels[at], image.pixels[at + 1], image.pixels[at + 2])
}

func near(_ a: (UInt8, UInt8, UInt8), _ b: (UInt8, UInt8, UInt8), within: Int = 3) -> Bool {
  abs(Int(a.0) - Int(b.0)) <= within && abs(Int(a.1) - Int(b.1)) <= within && abs(Int(a.2) - Int(b.2)) <= within
}

/// A PNG that is valid enough for the cache (signature + padding to a size).
func fakePNG(size: Int) -> Data {
  var data = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  data.append(Data(repeating: 7, count: max(size - 8, 1)))
  return data
}

// ---- the contract is one string -------------------------------------------------------------------------

check(
  MomoPushPresentationContract.appGroupIdentifier == MomoPushContract.appGroupIdentifier,
  "the presentation state lives in the very App Group the extension's kit names")
check(
  MomoPushPresentationContract.avatarMaxBytes == 64 * 1024 && MomoPushPresentationContract.avatarMaxPixels == 288,
  "a face is at most 64 KB and 288 px (96 pt at 3x, the design's ceiling)")
check(
  MomoPushPresentationContract.remoteAvatarMaxBytes == 256 * 1024 && MomoPushPresentationContract.remoteAvatarTimeout == 3,
  "the second photo source is bounded by 256 KB and 3 seconds (the design's numbers)")
check(
  PushAvatarReference.isValidVersion("aaaa1111-bbbb_4ccc") == true
    && PushAvatarReference.isValidVersion("../etc") == false,
  "the extension and the store agree on what a version looks like (a sample each way)")
check(
  MomoPushPresentationKey.version("AAAA1111-bbbb_4ccc") == "aaaa1111-bbbb_4ccc"
    && MomoPushPresentationKey.version("../etc") == nil && MomoPushPresentationKey.version("a b") == nil
    && MomoPushPresentationKey.version("") == nil
    && MomoPushPresentationKey.version(String(repeating: "a", count: 65)) == nil,
  "a version that is not a media id's alphabet never becomes part of a file name")

// ---- the two switches -----------------------------------------------------------------------------------

do {
  let directory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let container = MomoPushPresentationContainer(url: directory)
  check(MomoPushPresentationSettings.load(from: container) == .standard, "no file: both switches are on")
  check(MomoPushPresentationSettings.load(from: nil) == .standard, "no container at all: both switches are on")
  check(
    MomoPushPresentationSettings.standard.previewEnabled && MomoPushPresentationSettings.standard.showSender,
    "the defaults are on, on")
  try! MomoPushPresentationSettings(previewEnabled: false, showSender: true).write(to: container)
  check(
    MomoPushPresentationSettings.load(from: container) == MomoPushPresentationSettings(previewEnabled: false, showSender: true),
    "preview off round-trips and leaves the sender switch alone")
  try! MomoPushPresentationSettings(previewEnabled: true, showSender: false).write(to: container)
  check(
    MomoPushPresentationSettings.load(from: container) == MomoPushPresentationSettings(previewEnabled: true, showSender: false),
    "sender off round-trips and leaves the preview switch alone")
  try! Data("{not json".utf8).write(to: container.settingsURL)
  check(MomoPushPresentationSettings.load(from: container) == .standard, "an unreadable file reads as the defaults")
  try! Data(repeating: 0x20, count: 5000).write(to: container.settingsURL)
  check(MomoPushPresentationSettings.load(from: container) == .standard, "an oversized file is not read at all")
  // The switches are a preference of THIS PHONE: signing out clears the cache, not the person's choice.
  try! MomoPushPresentationSettings(previewEnabled: false, showSender: false).write(to: container)
  _ = container.cache.storeAvatarPNG(fakePNG(size: 400), server: baseURL, workspace: workspaceID, member: dohyun, version: version)
  container.cache.clearAll()
  check(
    MomoPushPresentationSettings.load(from: container) == MomoPushPresentationSettings(previewEnabled: false, showSender: false),
    "clearing the cache keeps the two switches")
}

// ---- the face cache -------------------------------------------------------------------------------------

do {
  let directory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let cache = MomoPushPresentationContainer(url: directory).cache
  let start = Date(timeIntervalSince1970: 1_800_000_000)
  let face = fakePNG(size: 3000)

  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: version, now: start) == nil, "an empty cache has no face")
  check(cache.storeAvatarPNG(face, server: baseURL, workspace: workspaceID, member: dohyun, version: version, now: start), "a face is stored")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: version, now: start) == face, "and read back byte for byte")
  check(
    cache.avatarPNG(server: baseURL.uppercased() + "/", workspace: workspaceID.uppercased(), member: dohyun.uppercased(), version: version.uppercased(), now: start) == face,
    "the key does not care about case or a trailing slash")

  // The key holds the media version: the person changed their picture.
  let newer = "bbbb2222-cccc-4ddd-8eee-ffff33334444"
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: newer, now: start) == nil, "another version of the same member is a miss, never the old face")
  let newFace = fakePNG(size: 3100)
  check(cache.storeAvatarPNG(newFace, server: baseURL, workspace: workspaceID, member: dohyun, version: newer, now: start), "the new version is stored")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: version, now: start) == nil, "the old version is gone when the new one lands")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: newer, now: start) == newFace, "and the new one reads")

  // Other people, other workspaces and other servers never see this face.
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: seoyeon, version: newer, now: start) == nil, "another member does not get it")
  check(cache.avatarPNG(server: baseURL, workspace: otherWorkspaceID, member: dohyun, version: newer, now: start) == nil, "the same member id in another workspace does not get it")
  check(cache.avatarPNG(server: "https://other.test", workspace: workspaceID, member: dohyun, version: newer, now: start) == nil, "the same ids on another server do not get it")
  let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("push-presentation/avatars").path)) ?? []
  check(
    names.count == 1 && !names.contains(where: { $0.contains(dohyun) || $0.contains(workspaceID) || $0.contains("oort.test") }),
    "a file name holds a digest, never a member id, a workspace id or a host")

  // What is refused on the way in.
  check(!cache.storeAvatarPNG(fakePNG(size: 64 * 1024 + 1), server: baseURL, workspace: workspaceID, member: seoyeon, version: version, now: start), "a face over 64 KB is refused")
  check(cache.storeAvatarPNG(fakePNG(size: 64 * 1024), server: baseURL, workspace: workspaceID, member: seoyeon, version: version, now: start), "a face of exactly 64 KB is accepted (control for the line above)")
  check(!cache.storeAvatarPNG(Data(repeating: 1, count: 500), server: baseURL, workspace: workspaceID, member: legacy, version: version, now: start), "bytes that are not a PNG are refused")
  check(!cache.storeAvatarPNG(Data(), server: baseURL, workspace: workspaceID, member: legacy, version: version, now: start), "an empty face is refused")
  check(!cache.storeAvatarPNG(face, server: baseURL, workspace: workspaceID, member: legacy, version: "../../x", now: start), "a version that is a path is refused")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: legacy, version: "../../x", now: start) == nil, "and is not looked up either")

  // 30 days from the last time anybody used the face; use keeps it alive.
  let day: TimeInterval = 24 * 60 * 60
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: newer, now: start.addingTimeInterval(29 * day)) == newFace, "a face is still served on day 29")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: newer, now: start.addingTimeInterval(29 * day + 29 * day)) == newFace, "and day 58 counts from day 29: being used keeps it")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: newer, now: start.addingTimeInterval(29 * day + 29 * day + 31 * day)) == nil, "31 days unused: the face has expired")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: newer, now: start.addingTimeInterval(29 * day + 29 * day + 31 * day)) == nil, "and stays gone (the file was removed, not just skipped)")

  // The whole cache stays inside its caps, dropping the least recently used.
  let evictionDirectory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: evictionDirectory) }
  let small = MomoPushPresentationContainer(url: evictionDirectory).cache
  var members: [String] = []
  for index in 0..<260 {
    let member = String(format: "00000000-0000-4000-8000-%012d", index)
    members.append(member)
    _ = small.storeAvatarPNG(fakePNG(size: 300), server: baseURL, workspace: workspaceID, member: member, version: version, now: start.addingTimeInterval(TimeInterval(index)))
  }
  let kept = members.filter { small.avatarPNG(server: baseURL, workspace: workspaceID, member: $0, version: version, now: start.addingTimeInterval(300)) != nil }
  check(kept.count == MomoPushPresentationContract.avatarMaxEntries, "260 faces in: exactly the 256-entry cap remain (\(kept.count))")
  check(kept.contains(members[259]) && !kept.contains(members[0]), "the newest is kept and the oldest went")
  let heavyDirectory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: heavyDirectory) }
  let heavy = MomoPushPresentationContainer(url: heavyDirectory).cache
  for index in 0..<80 {
    let member = String(format: "00000000-0000-4000-8000-%012d", 1000 + index)
    _ = heavy.storeAvatarPNG(fakePNG(size: 60_000), server: baseURL, workspace: workspaceID, member: member, version: version, now: start.addingTimeInterval(TimeInterval(index)))
  }
  let heavyFiles = (try? FileManager.default.contentsOfDirectory(atPath: heavyDirectory.appendingPathComponent("push-presentation/avatars").path)) ?? []
  let heavyBytes = heavyFiles.reduce(0) {
    $0 + (((try? FileManager.default.attributesOfItem(atPath: heavyDirectory.appendingPathComponent("push-presentation/avatars/\($1)").path))?[.size] as? Int) ?? 0)
  }
  check(heavyBytes <= MomoPushPresentationContract.avatarMaxTotalBytes && heavyFiles.count > 40, "80 faces of 60 KB: the 4 MB cap holds (\(heavyBytes) bytes, \(heavyFiles.count) files) and is not emptied")

  // Signing out.
  small.clearAll()
  check(members.allSatisfy { small.avatarPNG(server: baseURL, workspace: workspaceID, member: $0, version: version, now: start) == nil }, "clearAll leaves no face")
  check(!FileManager.default.fileExists(atPath: evictionDirectory.appendingPathComponent("push-presentation").path), "and no directory")
}

// ---- the channel names ------------------------------------------------------------------------------------

do {
  let directory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let cache = MomoPushPresentationContainer(url: directory).cache
  let start = Date(timeIntervalSince1970: 1_800_000_000)
  let channels = [
    MomoPushPresentationChannel(id: designChannel.uppercased(), kind: .public, name: "  디자인\n\t", memberCount: 12),
    MomoPushPresentationChannel(id: dmChannel, kind: .dm, name: "남의 이름", memberCount: 2),
    MomoPushPresentationChannel(id: otherChannel, kind: .private, name: String(repeating: "가", count: 200), memberCount: 0),
  ]
  check(channels[0].name == "디자인" && channels[0].id == designChannel, "a name is trimmed of white space and control characters, an id is lower-cased")
  check(channels[2].name?.count == 80 && channels[2].memberCount == nil, "a name is cut at 80 characters and a member count of 0 is no count")
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: designChannel, now: start) == nil, "nothing is known before the app writes")
  check(cache.replaceChannels(server: baseURL, workspace: workspaceID, channels: channels, now: start), "the app's list is stored")
  let design = cache.channel(server: baseURL, workspace: workspaceID, channelID: designChannel.uppercased(), now: start)
  check(design?.kind == .public && design?.name == "디자인" && design?.memberCount == 12, "a channel is read by id, case aside")
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: dmChannel, now: start)?.kind == .dm, "a DM is known as a DM")
  check(cache.channel(server: baseURL, workspace: otherWorkspaceID, channelID: designChannel, now: start) == nil, "another workspace of the same server does not see it")
  check(cache.channel(server: "https://other.test", workspace: workspaceID, channelID: designChannel, now: start) == nil, "another server does not see it")
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: "99999999-0000-4000-8000-000000000000", now: start) == nil, "a channel the app never listed is unknown")
  let day: TimeInterval = 24 * 60 * 60
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: designChannel, now: start.addingTimeInterval(13 * day)) != nil, "day 13: still served")
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: designChannel, now: start.addingTimeInterval(15 * day)) == nil, "day 15: expired")
  _ = cache.replaceChannels(server: baseURL, workspace: workspaceID, channels: [MomoPushPresentationChannel(id: dmChannel, kind: .dm, name: nil, memberCount: nil)], now: start)
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: designChannel, now: start) == nil, "a new list replaces the old one whole (a deleted channel is not remembered)")
  let many = (0..<600).map { MomoPushPresentationChannel(id: String(format: "00000000-0000-4000-8000-%012d", $0), kind: .public, name: "방 \($0)", memberCount: 3) }
  _ = cache.replaceChannels(server: baseURL, workspace: workspaceID, channels: many, now: start)
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: many[511].id, now: start) != nil && cache.channel(server: baseURL, workspace: workspaceID, channelID: many[512].id, now: start) == nil, "at most 512 channels are kept")
  cache.clearAll()
  check(cache.channel(server: baseURL, workspace: workspaceID, channelID: many[0].id, now: start) == nil, "clearAll forgets the channels too")
}

// ---- cutting a picture down ---------------------------------------------------------------------------------

do {
  let big = imageBytes(width: 800, height: 600)
  let cut = MomoPushPresentationImage.avatarPNG(from: big, maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 4096)
  let picture = cut.flatMap(decoded)
  check(cut != nil && cut!.count <= MomoPushPresentationContract.avatarMaxBytes && MomoPushPresentationCache.isPNG(cut!), "an 800x600 picture becomes a PNG of at most 64 KB")
  check(picture != nil && picture!.width == picture!.height && picture!.width <= 288, "which is a square of at most 288 px (a centred cut)")
  let jpeg = imageBytes(width: 1000, height: 1000, type: "public.jpeg")
  check(MomoPushPresentationImage.avatarPNG(from: jpeg, maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 4096) != nil, "a JPEG source is accepted")
  check(MomoPushPresentationImage.avatarPNG(from: big, maxSourceBytes: big.count - 1, maxSourceEdge: 4096) == nil, "a source one byte over the byte limit is refused")
  check(MomoPushPresentationImage.avatarPNG(from: big, maxSourceBytes: big.count, maxSourceEdge: 4096) != nil, "and exactly at it is accepted (control)")
  let wide = imageBytes(width: 3000, height: 8)
  check(MomoPushPresentationImage.avatarPNG(from: wide, maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 2048) == nil, "a 3000 px edge is not opened by the extension's limit of 2048 (a small file can hold a huge picture)")
  check(MomoPushPresentationImage.avatarPNG(from: wide, maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 4096) != nil, "and is opened by the app's limit of 4096 (control)")
  check(MomoPushPresentationImage.avatarPNG(from: Data("not a picture".utf8), maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 4096) == nil, "bytes that are not a picture give nothing")
  check(MomoPushPresentationImage.avatarPNG(from: Data(), maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 4096) == nil, "no bytes give nothing")
  let noise = imageBytes(width: 512, height: 512, noise: true)
  let fitted = MomoPushPresentationImage.avatarPNG(from: noise, maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 4096)
  check(fitted != nil && fitted!.count <= MomoPushPresentationContract.avatarMaxBytes, "a picture that does not compress still fits: it steps down in size until it does (\(fitted?.count ?? 0) bytes)")
  check(MomoPushPresentationImage.avatarPNG(from: noise, maxSourceBytes: 6 * 1024 * 1024, maxSourceEdge: 4096, maxBytes: 4000) == nil, "and when even 96 px does not fit the ceiling there is no face (not a bigger file)")
}

// ---- the face drawn when there is no photo -------------------------------------------------------------------------

do {
  typealias A = MomoPushPresentationAvatar
  check(A.initial(of: "이도현") == "이", "a Korean name's initial is its first syllable")
  check(A.initial(of: "alice") == "A", "a Latin initial is upper-cased")
  check(A.initial(of: "  박서연 ") == "박", "padding is trimmed first")
  check(A.initial(of: "1abc") == nil && A.initial(of: "😀 smile") == nil && A.initial(of: "") == nil && A.initial(of: nil) == nil, "a name starting with a digit, a symbol or nothing has no initial: it is an id or nothing, not a name")
  check(A.initial(of: "달무리 도우미") == "달", "an agent's name works the same way")

  let human = A.png(initial: "이", kind: .human)
  let agent = A.png(initial: "달", kind: .agent)
  check(human != nil && agent != nil && human != agent, "a person and an agent are drawn differently")
  check(A.png(initial: nil, kind: .human) == nil && A.png(initial: "", kind: .agent) == nil, "no letter, no drawn face: the system draws its own monogram")
  let humanPicture = human.flatMap(decoded)
  let agentPicture = agent.flatMap(decoded)
  check(humanPicture?.width == 288 && humanPicture?.height == 288 && human!.count <= MomoPushPresentationContract.avatarMaxBytes && MomoPushPresentationCache.isPNG(human!), "a drawn face is a 288 px PNG within the 64 KB ceiling (\(human?.count ?? 0) bytes)")
  check(humanPicture != nil && near(pixel(humanPicture!, x: 6, y: 6), (0xF3, 0xF1, 0xEE)), "a person's tile is the default theme's surface-muted")
  check(agentPicture != nil && near(pixel(agentPicture!, x: 6, y: 6), (0xE3, 0xEC, 0xF6)), "an agent's tile is its agent-soft")
  func letterPixels(_ picture: (width: Int, height: Int, pixels: [UInt8]), _ colour: (UInt8, UInt8, UInt8)) -> Int {
    var count = 0
    for y in 60..<228 { for x in 60..<228 where near(pixel(picture, x: x, y: y), colour, within: 24) { count += 1 } }
    return count
  }
  check(humanPicture != nil && letterPixels(humanPicture!, (0x16, 0x17, 0x1B)) > 400, "the letter is really drawn, in ink, near the centre")
  check(agentPicture != nil && letterPixels(agentPicture!, (0x2F, 0x5B, 0x8A)) > 400, "an agent's letter is drawn in the agent colour")
  check(humanPicture != nil && letterPixels(humanPicture!, (0x2F, 0x5B, 0x8A)) < 40, "and a person's is not (control: the colours are not both everywhere)")
  check(A.png(initial: "이", kind: .human, pixels: 96).flatMap(decoded)?.width == 96, "another size can be asked for")
}

// ---- forgetting: the marker, the retry, the deadline --------------------------------------------------------------------------

do {
  let directory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let container = MomoPushPresentationContainer(url: directory)
  var calls = 0
  var pending: [(Error?) -> Void] = []
  let cleanup = MomoPushPresentationCleanup(
    container: container,
    deleteAllInteractions: { completion in
      calls += 1
      pending.append(completion)
    },
    timeout: 5,
    scheduleTimeout: { _, _ in })

  _ = container.cache.storeAvatarPNG(fakePNG(size: 500), server: baseURL, workspace: workspaceID, member: dohyun, version: version)
  _ = container.cache.replaceChannels(server: baseURL, workspace: workspaceID, channels: [MomoPushPresentationChannel(id: designChannel, kind: .public, name: "디자인", memberCount: 3)])
  var result: [Error?] = []
  cleanup.request { result.append($0) }
  check(calls == 1, "a sign-out asks the system to forget the donated interactions")
  check(container.cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: version) == nil && container.cache.channel(server: baseURL, workspace: workspaceID, channelID: designChannel) == nil, "and the cache is already empty before the system answers")
  check(cleanup.hasPendingCleanup() && result.isEmpty, "the marker is on disk while the system has not answered")
  pending.removeFirst()(nil)
  check(result.count == 1 && result[0] == nil && !cleanup.hasPendingCleanup(), "the system said yes: one completion, no error, the marker removed")

  // A deletion that failed is owed, and is retried at the next start.
  result = []
  cleanup.request { result.append($0) }
  pending.removeFirst()(NSError(domain: "x", code: 9))
  check(result.count == 1 && result[0] != nil && cleanup.hasPendingCleanup(), "the system failed: the error is reported and the marker stays")
  let before = calls
  var retried: [Error?] = []
  cleanup.retryPending { retried.append($0) }
  check(calls == before + 1, "the next start retries it")
  pending.removeFirst()(nil)
  check(retried.count == 1 && retried[0] == nil && !cleanup.hasPendingCleanup(), "and the marker goes once the retry succeeded")
  var idle: [Error?] = []
  let afterRetry = calls
  cleanup.retryPending { idle.append($0) }
  check(calls == afterRetry && idle.count == 1 && idle[0] == nil, "with nothing owed the system is not asked at all")

  // A newer request replaced the marker while an older one was in flight: the newer one is still owed.
  var older: [Error?] = []
  var newer: [Error?] = []
  cleanup.request { older.append($0) }
  cleanup.request { newer.append($0) }
  let first = pending.removeFirst()
  let second = pending.removeFirst()
  first(nil)
  check(cleanup.hasPendingCleanup(), "the older answer does not clear a newer request's marker")
  second(nil)
  check(!cleanup.hasPendingCleanup() && older.count == 1 && newer.count == 1, "the newer answer does, and each request got exactly one completion")

  // The deadline: the system never answers.
  var fire: (() -> Void)?
  var late: [(Error?) -> Void] = []
  let impatient = MomoPushPresentationCleanup(
    container: container, deleteAllInteractions: { late.append($0) }, timeout: 5, scheduleTimeout: { delay, action in
      if delay == 5 { fire = action }
    })
  var timed: [Error?] = []
  impatient.request { timed.append($0) }
  fire?()
  check(timed.count == 1 && timed[0] != nil && impatient.hasPendingCleanup(), "no answer in time: a timeout error, once, and the marker stays for the retry")
  late.removeFirst()(nil)
  check(timed.count == 1, "an answer that arrives after the deadline does not complete the request a second time")

  // No container (the entitlement is missing): the system is still asked, and nothing crashes.
  var asked = 0
  let homeless = MomoPushPresentationCleanup(container: nil, deleteAllInteractions: { asked += 1; $0(nil) }, timeout: 5, scheduleTimeout: { _, _ in })
  var homelessResult: [Error?] = []
  homeless.request { homelessResult.append($0) }
  check(asked == 1 && homelessResult.count == 1 && homelessResult[0] == nil && !homeless.hasPendingCleanup(), "without a container the donated interactions are still deleted")
}

// ---- which roster picture may the extension fetch ----------------------------------------------------------------------------

do {
  typealias R = PushAvatarReference
  let good = avatarPath(dohyun)
  check(R.parse(good, workspaceID: workspaceID, memberID: dohyun) == R(path: good, version: version), "the member's own content path with a version is a picture")
  check(R.parse(good.uppercased(), workspaceID: workspaceID.uppercased(), memberID: dohyun.uppercased())?.version == version, "case does not matter, and the path is normalised")
  check(R.parse("  \(good) \n", workspaceID: workspaceID, memberID: dohyun) != nil, "padding does not matter")
  check(R.parse(nil, workspaceID: workspaceID, memberID: dohyun) == nil && R.parse("", workspaceID: workspaceID, memberID: dohyun) == nil, "no value is no picture")
  check(R.parse("https://cdn.example.test/a.png", workspaceID: workspaceID, memberID: legacy) == nil, "an address on another host is never fetched (the extension carries a bearer)")
  check(R.parse("https://oort.test" + good, workspaceID: workspaceID, memberID: dohyun) == nil, "not even an absolute address on this host: only the path is accepted, the request is built by the extension")
  check(R.parse(avatarPath(seoyeon), workspaceID: workspaceID, memberID: dohyun) == nil, "another member's picture is not this member's")
  check(R.parse(avatarPath(dohyun, workspace: otherWorkspaceID), workspaceID: workspaceID, memberID: dohyun) == nil, "another workspace's picture is not this workspace's")
  check(R.parse("/v1/workspaces/\(workspaceID)/members/\(dohyun)/avatar/content", workspaceID: workspaceID, memberID: dohyun) == nil, "without ?v= it cannot be keyed by version, so it is not used")
  check(R.parse(good + "&x=1", workspaceID: workspaceID, memberID: dohyun) == nil, "an extra query parameter is not the shape")
  check(R.parse(avatarPath(dohyun, v: "../../secret"), workspaceID: workspaceID, memberID: dohyun) == nil, "a version that is a path is not a version")
  check(R.parse(avatarPath(dohyun, v: "a%2fb"), workspaceID: workspaceID, memberID: dohyun) == nil, "and neither is an escape")
  check(R.parse(good + "#frag", workspaceID: workspaceID, memberID: dohyun) == nil, "and neither is a fragment")
}

// ---- the REST read: who wrote it, which picture ---------------------------------------------------------------------------------

final class RESTStub: URLProtocol {
  nonisolated(unsafe) static var routes: [String: (status: Int, body: Data)] = [:]
  nonisolated(unsafe) static var requested: [(path: String, auth: String?, host: String?)] = []
  nonisolated(unsafe) static var redirectAvatarTo: String?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let url = request.url!
    let key = url.path + (url.query.map { "?" + $0 } ?? "")
    RESTStub.requested.append((key, request.value(forHTTPHeaderField: "Authorization"), url.host))
    let routeKey = RESTStub.routes.keys.first(where: { key.hasSuffix($0) })
    if url.path.hasSuffix("/avatar/content"), let target = RESTStub.redirectAvatarTo {
      let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": target])!
      client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: target)!), redirectResponse: response)
      return
    }
    let route = routeKey.flatMap { RESTStub.routes[$0] } ?? (404, Data())
    let response = HTTPURLResponse(
      url: url, statusCode: route.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json", "Content-Length": "\(route.1.count)"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: route.1)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

func stubSession() -> URLSession {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [RESTStub.self]
  return URLSession(configuration: configuration)
}

func stubFetchSession(workspace: String = workspaceID) -> PushFetchSession {
  PushFetchSession(baseURL: URL(string: baseURL)!, workspaceID: workspace, accessToken: "sim-check-token")
}

func rosterJSON() -> Data {
  let members: [String] = [
    #"{"id":"\#(dohyun)","displayName":"이도현","kind":"human","avatarUrl":"\#(avatarPath(dohyun))"}"#,
    #"{"id":"\#(seoyeon)","displayName":"박서연","kind":"human"}"#,
    #"{"id":"\#(helper)","displayName":"달무리 도우미","kind":"agent","avatarPreset":"tile-blue"}"#,
    #"{"id":"\#(legacy)","displayName":"최민수","kind":"human","avatarUrl":"https://cdn.example.test/legacy.png"}"#,
    #"{"id":"\#(strayPath)","displayName":"정하윤","kind":"human","avatarUrl":"\#(avatarPath(dohyun))"}"#,
  ]
  return Data(#"{"members":[\#(members.joined(separator: ","))]}"#.utf8)
}

func messagesJSON(author: String, fields: String = #","body":"시안 확인 부탁드려요""#) -> Data {
  Data(#"{"messages":[{"id":"\#(messageID)","authorMemberId":"\#(author)"\#(fields)}]}"#.utf8)
}

func resetStub(author: String = dohyun, fields: String = #","body":"시안 확인 부탁드려요""#) {
  RESTStub.requested = []
  RESTStub.redirectAvatarTo = nil
  RESTStub.routes = [
    "/messages?limit=200": (200, messagesJSON(author: author, fields: fields)),
    "/roster": (200, rosterJSON()),
  ]
}

do {
  let fetcher = MomoPushRESTFetcher(session: stubSession())
  resetStub()
  let resolved = try? await fetcher.resolve(envelope: envelope("dm"), session: stubFetchSession())
  check(resolved?.display == PushDisplayContent(title: "이도현", body: "시안 확인 부탁드려요"), "the display is what it always was: the author's name and the text")
  check(resolved?.author == PushResolvedAuthor(memberID: dohyun, displayName: "이도현", isAgent: false, avatar: PushAvatarReference(path: avatarPath(dohyun), version: version)), "and the author is named, a person, with this member's own picture")
  check(
    RESTStub.requested.contains(where: { $0.path.hasSuffix("/messages?limit=200") }) && RESTStub.requested.contains(where: { $0.path.hasSuffix("/roster") }) && RESTStub.requested.count == 2,
    "the message page and the roster were read, once each")
  check((try? await fetcher.fetch(envelope: envelope("dm"), session: stubFetchSession())) == resolved?.display, "fetch still answers with the display alone, identically")

  resetStub(author: helper)
  let agent = try? await fetcher.resolve(envelope: envelope("dm"), session: stubFetchSession())
  check(agent?.author?.isAgent == true && agent?.author?.avatar == nil && agent?.author?.displayName == "달무리 도우미", "an agent is an agent, and a preset (no uploaded picture) is no picture to fetch")
  resetStub(author: legacy)
  check((try? await fetcher.resolve(envelope: envelope("dm"), session: stubFetchSession()))?.author?.avatar == nil, "an old member's address on another host is dropped")
  resetStub(author: strayPath)
  let stray = try? await fetcher.resolve(envelope: envelope("dm"), session: stubFetchSession())
  check(stray?.author?.displayName == "정하윤" && stray?.author?.avatar == nil, "a picture path that names another member is dropped, the name stays")
  resetStub(author: seoyeon)
  check((try? await fetcher.resolve(envelope: envelope("dm"), session: stubFetchSession()))?.author?.avatar == nil, "a member with no picture has none")
  RESTStub.routes["/roster"] = (200, Data(#"{"members":[{"id":"\#(dohyun)","displayName":"이도현","kind":7,"avatarUrl":{"x":1}}]}"#.utf8))
  RESTStub.routes["/messages?limit=200"] = (200, messagesJSON(author: dohyun))
  let odd = try? await fetcher.resolve(envelope: envelope("dm"), session: stubFetchSession())
  check(odd?.display.title == "이도현" && odd?.author?.isAgent == false && odd?.author?.avatar == nil, "a kind or an avatarUrl of the wrong type costs the notification its picture, never its name")

  // The work pushes keep their fixed words and read nothing about a person.
  resetStub()
  RESTStub.routes["/messages?limit=200"] = (200, Data(#"{"messages":[{"id":"\#(messageID)","authorMemberId":"\#(dohyun)","body":"비밀 답변 전문"}]}"#.utf8))
  let done = try? await fetcher.resolve(envelope: envelope("work_run_done", category: "momo.work"), session: stubFetchSession())
  check(done?.display == PushWorkRunDoneCopy.display() && done?.author == nil, "work_run_done: the fixed words, no author")
  check(!RESTStub.requested.contains(where: { $0.path.hasSuffix("/roster") }), "and the roster was not even asked for (nothing is read about a person)")
  resetStub()
  RESTStub.routes["/messages?limit=200"] = (200, Data(#"{"messages":[{"id":"\#(messageID)","authorMemberId":"\#(dohyun)","body":"x","props":{"kind":"work_session_idle","ran_ms":125000}}]}"#.utf8))
  let idle = try? await fetcher.resolve(envelope: envelope("work_session_idle", category: "momo.work"), session: stubFetchSession())
  check(idle?.author == nil && idle?.display.body == "2분 만에 끝났어요", "work_session_idle: the session's words, no author")
  check(!RESTStub.requested.contains(where: { $0.path.hasSuffix("/roster") }), "and no roster either")
  // A work_session_idle push whose card is NOT an idle card is an ordinary message: the roster is read then.
  resetStub()
  let notIdle = try? await fetcher.resolve(envelope: envelope("work_session_idle", category: "momo.work"), session: stubFetchSession())
  check(notIdle?.author?.displayName == "이도현" && RESTStub.requested.contains(where: { $0.path.hasSuffix("/roster") }), "that path still reads the roster, late")
  resetStub()
  RESTStub.routes["/roster"] = (500, Data())
  check((try? await fetcher.resolve(envelope: envelope("dm"), session: stubFetchSession())) == nil, "a roster that fails fails the read (the caller falls back to the placeholder)")
}

// ---- what a notification says (the plan) ----------------------------------------------------------------------------------

do {
  typealias P = PushPresentationPlanner
  let on = MomoPushPresentationSettings.standard
  let previewOff = MomoPushPresentationSettings(previewEnabled: false, showSender: true)
  let senderOff = MomoPushPresentationSettings(previewEnabled: true, showSender: false)
  let bothOff = MomoPushPresentationSettings(previewEnabled: false, showSender: false)
  let face = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
  let doh = person(dohyun, "이도현", avatar: avatarPath(dohyun))
  let design = MomoPushPresentationChannel(id: designChannel, kind: .public, name: "디자인", memberCount: 12)
  let directChannel = MomoPushPresentationChannel(id: dmChannel, kind: .dm, name: nil, memberCount: 2)

  // a person, one to one
  let dm = P.plan(envelope: envelope("dm", channel: dmChannel), resolution: resolution(doh), settings: on, channel: directChannel, avatarPNG: face)
  check(dm.communication != nil, "a direct message is dressed as a communication notification")
  check(dm.communication?.senderName == "이도현" && dm.communication?.senderAvatarPNG == face, "with the sender's name and photo")
  check(dm.communication?.groupName == nil, "and no group name: it is one person")
  check(dm.communication?.messageBody == "시안 확인 부탁드려요" && dm.display == PushDisplayContent(title: "이도현", body: "시안 확인 부탁드려요"), "the preview is the text; the ordinary look is today's name and text")
  check(dm.communication?.conversationIdentifier == "\(workspaceID)/\(dmChannel)" && dm.communication?.senderIdentifier == "\(workspaceID)/\(dohyun)", "the conversation is workspace/channel and the sender workspace/member")
  check(dm.showsResolvedText, "a notification that says what it is keeps the buttons it had")

  // a named room
  let mention = P.plan(envelope: envelope("mention", category: "momo.mention"), resolution: resolution(doh), settings: on, channel: design, avatarPNG: face)
  check(mention.communication?.groupName == "#디자인", "a mention in a room carries the room's name as #name (the group name)")
  check(mention.communication?.senderName == "이도현" && mention.communication?.recipientCount == 11, "the sender stays the person, and the recipients are the others (12 members minus the sender)")
  check(mention.communication?.conversationIdentifier == "\(workspaceID)/\(designChannel)", "the room is the conversation")
  let unknownRoom = P.plan(envelope: envelope("mention", category: "momo.mention"), resolution: resolution(doh), settings: on, channel: nil, avatarPNG: face)
  check(unknownRoom.communication != nil && unknownRoom.communication?.groupName == nil && unknownRoom.communication?.recipientCount == 2, "a room the app never listed: still dressed, with the sender only, no invented name")
  let staleDirect = P.plan(envelope: envelope("dm", channel: designChannel), resolution: resolution(doh), settings: on, channel: design, avatarPNG: face)
  check(staleDirect.communication?.groupName == nil, "a dm push is one person whatever an old cache says about the channel")
  let namelessRoom = P.plan(envelope: envelope("mention", category: "momo.mention"), resolution: resolution(doh), settings: on, channel: MomoPushPresentationChannel(id: designChannel, kind: .public, name: nil, memberCount: 5), avatarPNG: face)
  check(namelessRoom.communication?.groupName == nil, "a public room with no name has no group name")

  // two rooms never share a conversation; a thread is part of its room
  let inDesign = P.plan(envelope: envelope("mention", category: "momo.mention", channel: designChannel), resolution: resolution(doh), settings: on, channel: design, avatarPNG: face)
  let inOther = P.plan(envelope: envelope("mention", category: "momo.mention", channel: otherChannel), resolution: resolution(doh), settings: on, channel: MomoPushPresentationChannel(id: otherChannel, kind: .private, name: "운영", memberCount: 4), avatarPNG: face)
  check(inDesign.communication?.conversationIdentifier != inOther.communication?.conversationIdentifier, "two channels are two conversations")
  check(inOther.communication?.groupName == "#운영", "and each keeps its own name")
  let inWorkspaceB = P.plan(envelope: envelope("mention", category: "momo.mention", channel: designChannel, workspace: otherWorkspaceID), resolution: resolution(doh), settings: on, channel: design, avatarPNG: face)
  check(inWorkspaceB.communication?.conversationIdentifier != inDesign.communication?.conversationIdentifier, "the same channel id in another workspace is another conversation")
  let reply = P.plan(envelope: envelope("mention", category: "momo.mention", channel: designChannel, thread: threadRoot), resolution: resolution(doh), settings: on, channel: design, avatarPNG: face)
  check(reply.communication?.conversationIdentifier == inDesign.communication?.conversationIdentifier, "a reply in a thread is the same conversation as its room")
  check(reply.communication?.isThreadReply == true && reply.communication?.messageBody == "스레드 · 시안 확인 부탁드려요", "and its preview starts with the thread mark")
  check(reply.communication?.groupName == "#디자인", "with the room's name")
  check(inDesign.communication?.isThreadReply == false && inDesign.communication?.messageBody == "시안 확인 부탁드려요", "a top-level message has no thread mark")

  // an agent
  let agent = person(helper, "달무리 도우미", agent: true)
  let agentDM = P.plan(envelope: envelope("dm", channel: dmChannel), resolution: resolution(agent, body: "배포 끝났어요"), settings: on, channel: directChannel, avatarPNG: face)
  check(agentDM.communication?.senderName == "달무리 도우미" && agentDM.communication?.senderIdentifier == "\(workspaceID)/\(helper)", "an agent is the sender of its own messages")

  // a photo
  let photo = P.plan(envelope: envelope("dm", channel: dmChannel), resolution: resolution(doh, body: "사진 1장"), settings: on, channel: directChannel, avatarPNG: face)
  check(photo.communication?.messageBody == "사진 1장" && photo.display.body == "사진 1장", "a photo-only message says what the REST read said (사진 1장)")

  // 「메시지 미리보기」 off
  let hidden = P.plan(envelope: envelope("dm", channel: dmChannel), resolution: resolution(doh), settings: previewOff, channel: directChannel, avatarPNG: face)
  check(hidden.communication?.messageBody == "새 메시지" && hidden.display.body == "새 메시지", "preview off: the body is 새 메시지 (both in the intent and in the ordinary look)")
  check(hidden.communication?.senderName == "이도현" && hidden.communication?.senderAvatarPNG == face && hidden.display.title == "이도현", "and the name and the photo stay")
  check(!hidden.showsResolvedText, "and the notification is marked as not saying what it is")
  check(hidden.communication?.messageBody.contains("시안") == false && hidden.display.body.contains("시안") == false, "none of the text is anywhere in it")
  let hiddenReply = P.plan(envelope: envelope("mention", category: "momo.mention", thread: threadRoot), resolution: resolution(doh), settings: previewOff, channel: design, avatarPNG: face)
  check(hiddenReply.communication?.messageBody == "스레드 · 새 메시지", "a thread reply with the preview off keeps only the thread mark")
  let hiddenPhoto = P.plan(envelope: envelope("dm", channel: dmChannel), resolution: resolution(doh, body: "사진 2장"), settings: previewOff, channel: directChannel, avatarPNG: face)
  check(hiddenPhoto.display.body == "새 메시지", "a photo count is a preview too")

  // 「보낸 사람 표시」 off
  let nameless = P.plan(envelope: envelope("dm", channel: dmChannel), resolution: resolution(doh), settings: senderOff, channel: directChannel, avatarPNG: face)
  check(nameless.communication == nil, "sender display off: nothing is dressed and nothing is donated")
  check(nameless.display == PushDisplayContent(title: "oort", body: "새 메시지"), "the notification is oort / 새 메시지")
  check(!nameless.showsResolvedText, "and says it hides")
  check(!"\(nameless)".contains("이도현") && !"\(nameless)".contains("시안"), "neither the name nor the text is anywhere in what was planned")
  let namelessBoth = P.plan(envelope: envelope("mention", category: "momo.mention"), resolution: resolution(doh), settings: bothOff, channel: design, avatarPNG: face)
  check(namelessBoth.communication == nil && namelessBoth.display.title == "oort" && namelessBoth.display.body == "새 메시지", "both off: the same")

  // an approval is a request for an action: the preview switch never hides what is being approved
  let approval = envelope("approval_request", category: "momo.approval", approval: approvalID)
  let approvalRes = resolution(agent, body: "배포 승인 요청")
  let approvalOn = P.plan(envelope: approval, resolution: approvalRes, settings: on, channel: design, avatarPNG: face)
  check(approvalOn.communication?.senderName == "달무리 도우미" && approvalOn.communication?.messageBody == "배포 승인 요청", "an approval is dressed with its agent and says what it is")
  let approvalPreviewOff = P.plan(envelope: approval, resolution: approvalRes, settings: previewOff, channel: design, avatarPNG: face)
  check(approvalPreviewOff.communication?.messageBody == "배포 승인 요청" && approvalPreviewOff.showsResolvedText, "preview off does not hide an approval's text (its buttons are only safe while it says what)")
  let approvalSenderOff = P.plan(envelope: approval, resolution: approvalRes, settings: senderOff, channel: design, avatarPNG: face)
  check(approvalSenderOff.communication == nil && approvalSenderOff.display == approvalRes.display && approvalSenderOff.showsResolvedText, "sender display off: an approval is just today's notification, not dressed")
  let resume = P.plan(envelope: envelope("resume_offer", category: "momo.work"), resolution: resolution(agent, body: "이어서 할까요?"), settings: on, channel: design, avatarPNG: face)
  check(resume.communication?.senderName == "달무리 도우미", "a resume offer is dressed with its agent")

  // the fixed-words pushes and failures
  let workDone = P.plan(envelope: envelope("work_run_done", category: "momo.work"), resolution: PushResolution(display: PushWorkRunDoneCopy.display(), author: nil), settings: on, channel: design, avatarPNG: face)
  check(workDone.communication == nil && workDone.display == PushWorkRunDoneCopy.display(), "work_run_done stays the product's own sentence, undressed")
  let workIdle = P.plan(envelope: envelope("work_session_idle", category: "momo.work"), resolution: PushResolution(display: PushWorkCompleteCopy.display(label: "시안", ranMs: 125000), author: nil), settings: senderOff, channel: design, avatarPNG: face)
  check(workIdle.communication == nil && workIdle.display.title == "작업이 끝났어요 · 시안", "work_session_idle stays too, whatever the switches say")
  let failed = P.plan(envelope: envelope("dm"), resolution: PushResolution(display: .placeholder, author: nil), settings: on, channel: nil, avatarPNG: nil)
  check(failed.communication == nil && failed.display == .placeholder, "a read that failed is the relay's placeholder, not dressed")
  let failedSenderOff = P.plan(envelope: envelope("dm"), resolution: PushResolution(display: .placeholder, author: nil), settings: senderOff, channel: nil, avatarPNG: nil)
  check(failedSenderOff.display == .placeholder, "and the sender switch does not turn a failure into 새 메시지 (it stays oort / 새 알림)")
  // an author-less authored push is not dressed even when the switches are on
  check(P.plan(envelope: envelope("mention", category: "momo.mention"), resolution: PushResolution(display: PushDisplayContent(title: "x", body: "y"), author: nil), settings: on, channel: design, avatarPNG: face).communication == nil, "no author, no communication notification")
  // the demotion rule's inputs
  check(MomoPushCategoryDemotion.categoryIdentifier(current: "momo.approval", resolved: false) == "momo.approval.open", "an approval category whose text was hidden is demoted to open-only (the rule the extension re-applies)")
}

// ---- the second photo source: one bounded read ------------------------------------------------------------------------------------

func stubDownloader(maxBytes: Int = MomoPushPresentationContract.remoteAvatarMaxBytes) -> PushAvatarURLSessionDownloader {
  PushAvatarURLSessionDownloader(timeout: 3, maxBytes: maxBytes, makeConfiguration: {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RESTStub.self]
    return configuration
  })
}

do {
  let reference = PushAvatarReference(path: avatarPath(dohyun), version: version)
  let photo = imageBytes(width: 400, height: 400)
  RESTStub.requested = []
  RESTStub.redirectAvatarTo = nil
  RESTStub.routes = ["/avatar/content?v=\(version)": (200, photo)]
  let got = await stubDownloader().download(reference, session: stubFetchSession())
  check(got == photo, "the picture is read with the push-fetch session")
  check(RESTStub.requested.count == 1 && RESTStub.requested[0].path == avatarPath(dohyun) && RESTStub.requested[0].auth == "Bearer sim-check-token" && RESTStub.requested[0].host == "oort.test", "exactly one request, to this member's path on the session's host, with the bearer")
  RESTStub.routes = ["/avatar/content?v=\(version)": (403, Data(#"{"error":"push-fetch token is not allowed for this route"}"#.utf8))]
  check(await stubDownloader().download(reference, session: stubFetchSession()) == nil, "the server's refusal (403: the push-fetch credential may read two routes) is no picture, not an error")
  RESTStub.routes = ["/avatar/content?v=\(version)": (404, Data())]
  check(await stubDownloader().download(reference, session: stubFetchSession()) == nil, "a 404 is no picture")
  RESTStub.routes = ["/avatar/content?v=\(version)": (200, Data(repeating: 1, count: 300_000))]
  check(await stubDownloader().download(reference, session: stubFetchSession()) == nil, "a body over 256 KB is refused")
  RESTStub.routes = ["/avatar/content?v=\(version)": (200, Data(repeating: 1, count: 256 * 1024))]
  check(await stubDownloader().download(reference, session: stubFetchSession()) != nil, "and exactly 256 KB is taken (control)")
  RESTStub.routes = ["/avatar/content?v=\(version)": (200, photo)]
  RESTStub.redirectAvatarTo = "https://evil.example.test/steal"
  RESTStub.requested = []
  check(await stubDownloader().download(reference, session: stubFetchSession()) == nil, "a redirect is not followed")
  check(!RESTStub.requested.contains(where: { $0.host == "evil.example.test" }), "so the bearer never reaches the other host")
  RESTStub.redirectAvatarTo = nil
  check(await stubDownloader().download(PushAvatarReference(path: "https://evil.example.test/x", version: version), session: stubFetchSession()) == nil || RESTStub.requested.allSatisfy({ $0.host == "oort.test" }), "a reference can only ever be requested on the session's own host")
}

// ---- the sender's photo, in the design's order --------------------------------------------------------------------------------------

final class CountingDownloader: PushAvatarDownloading, @unchecked Sendable {
  var calls = 0
  var answer: Data?
  init(_ answer: Data?) { self.answer = answer }
  func download(_ reference: PushAvatarReference, session: PushFetchSession) async -> Data? {
    calls += 1
    return answer
  }
}

do {
  let directory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let cache = MomoPushPresentationContainer(url: directory).cache
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let session = stubFetchSession()
  let doh = person(dohyun, "이도현", avatar: avatarPath(dohyun))
  let cachedFace = fakePNG(size: 2000)
  // What the server serves is a reduced JPEG (the app cuts the upload down before it goes up).
  let remote = imageBytes(width: 600, height: 600, type: "public.jpeg")

  // 1. the cache, with no network
  _ = cache.storeAvatarPNG(cachedFace, server: baseURL, workspace: workspaceID, member: dohyun, version: version, now: now)
  let downloader = CountingDownloader(remote)
  let sourcing = PushAvatarSourcing(cache: cache, downloader: downloader)
  var photo = await sourcing.png(for: doh, session: session, remaining: 25, now: now)
  check(photo.source == .cache && photo.data == cachedFace && downloader.calls == 0, "a cached face is used and the network is not asked")

  // 2. a different version in the cache is not the face: one read, then it is stored
  let changed = person(dohyun, "이도현", avatar: avatarPath(dohyun, v: "bbbb2222-cccc-4ddd-8eee-ffff33334444"))
  photo = await sourcing.png(for: changed, session: session, remaining: 25, now: now)
  check(photo.source == .download && downloader.calls == 1, "a new version is read once")
  check(photo.data != nil && MomoPushPresentationCache.isPNG(photo.data!) && photo.data!.count <= MomoPushPresentationContract.avatarMaxBytes && photo.data != remote, "and arrives cut down to a PNG within the ceiling, not as the 600 px original")
  photo = await sourcing.png(for: changed, session: session, remaining: 25, now: now)
  check(photo.source == .cache && downloader.calls == 1, "the next push of that person comes from the cache: still one read")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: dohyun, version: version, now: now) == nil, "and the old version was replaced")

  // 3. the read fails (today's server: 403): an initial, nothing stored
  let refused = CountingDownloader(nil)
  let seo = person(seoyeon, "박서연", avatar: avatarPath(seoyeon))
  photo = await PushAvatarSourcing(cache: cache, downloader: refused).png(for: seo, session: session, remaining: 25, now: now)
  check(photo.source == .generated && refused.calls == 1, "a read that failed ends in a drawn initial")
  check(photo.data.flatMap(decoded).map { near(pixel($0, x: 6, y: 6), (0xF3, 0xF1, 0xEE)) } == true, "which is the person's tile")
  check(cache.avatarPNG(server: baseURL, workspace: workspaceID, member: seoyeon, version: version, now: now) == nil, "and nothing was cached for it")

  // 4. a read that returns something that is not a picture, or too big a picture
  photo = await PushAvatarSourcing(cache: cache, downloader: CountingDownloader(Data("<html>".utf8))).png(for: seo, session: session, remaining: 25, now: now)
  check(photo.source == .generated, "bytes that are not a picture end in an initial")
  photo = await PushAvatarSourcing(cache: cache, downloader: CountingDownloader(imageBytes(width: 3000, height: 8))).png(for: seo, session: session, remaining: 25, now: now)
  check(photo.source == .generated, "a picture with an edge over 2048 px is not opened inside the extension")

  // 5. no time left: the read is skipped, the notification does not wait for a photo
  let idle = CountingDownloader(remote)
  photo = await PushAvatarSourcing(cache: cache, downloader: idle).png(for: seo, session: session, remaining: 5, now: now)
  check(photo.source == .generated && idle.calls == 0, "with 5 s left the photo is not read: an initial, on time")
  photo = await PushAvatarSourcing(cache: cache, downloader: idle).png(for: seo, session: session, remaining: 8, now: now)
  check(idle.calls == 1 && photo.source == .download, "with 8 s left it is (the boundary, as a control)")

  // 6. no picture at all
  let none = CountingDownloader(remote)
  let plain = person(seoyeon, "박서연")
  photo = await PushAvatarSourcing(cache: cache, downloader: none).png(for: plain, session: session, remaining: 25, now: now)
  check(photo.source == .generated && none.calls == 0, "a member who has no uploaded picture is drawn, and the network is not asked")
  let agent = person(helper, "달무리 도우미", agent: true)
  photo = await PushAvatarSourcing(cache: cache, downloader: none).png(for: agent, session: session, remaining: 25, now: now)
  check(photo.data.flatMap(decoded).map { near(pixel($0, x: 6, y: 6), (0xE3, 0xEC, 0xF6)) } == true, "an agent is drawn on the agent's tile")
  photo = await PushAvatarSourcing(cache: cache, downloader: none).png(for: person(legacy, "7민수"), session: session, remaining: 25, now: now)
  check(photo.source == .none && photo.data == nil, "a name with no initial gives no picture: the system draws its monogram")
  photo = await PushAvatarSourcing(cache: nil, downloader: nil).png(for: doh, session: session, remaining: 25, now: now)
  check(photo.source == .generated, "no cache and no downloader at all (a missing App Group): still an initial")
}

// ---- all of it, from a push ----------------------------------------------------------------------------------------------------------

do {
  let directory = tempDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let container = MomoPushPresentationContainer(url: directory)
  let session = stubFetchSession()
  let fetcher = MomoPushRESTFetcher(session: stubSession())
  let face = fakePNG(size: 1500)
  _ = container.cache.storeAvatarPNG(face, server: baseURL, workspace: workspaceID, member: dohyun, version: version)
  _ = container.cache.replaceChannels(server: baseURL, workspace: workspaceID, channels: [
    MomoPushPresentationChannel(id: designChannel, kind: .public, name: "디자인", memberCount: 6),
    MomoPushPresentationChannel(id: dmChannel, kind: .dm, name: nil, memberCount: 2),
  ])
  let downloader = CountingDownloader(imageBytes(width: 300, height: 300))
  func assembler(_ container: MomoPushPresentationContainer?) -> PushPresentationAssembler {
    PushPresentationAssembler(resolver: PushNotificationResolver(fetcher: fetcher), container: container, downloader: downloader)
  }

  resetStub()
  var result = await assembler(container).assemble(envelope: envelope("mention", category: "momo.mention"), session: session, fallback: .placeholder, remaining: 25)
  check(result.presentation.communication?.groupName == "#디자인" && result.presentation.communication?.senderName == "이도현", "a mention: the room's name from the app's cache and the sender from the REST read")
  check(result.presentation.communication?.senderAvatarPNG == face && result.avatarSource == .cache && downloader.calls == 0, "with the cached photo, and no photo read")
  check(result.presentation.communication?.recipientCount == 5, "and the recipients from the cached member count")
  check(RESTStub.requested.count == 2 && RESTStub.requested.allSatisfy { $0.auth == "Bearer sim-check-token" }, "two reads only (messages, roster)")

  resetStub()
  result = await assembler(container).assemble(envelope: envelope("dm", channel: dmChannel), session: session, fallback: .placeholder, remaining: 25)
  check(result.presentation.communication?.groupName == nil && result.presentation.communication?.conversationIdentifier == "\(workspaceID)/\(dmChannel)", "a direct message: one person, its own conversation")

  // the switches are read from the container, at the time of the push
  try! MomoPushPresentationSettings(previewEnabled: false, showSender: true).write(to: container)
  resetStub()
  result = await assembler(container).assemble(envelope: envelope("dm", channel: dmChannel), session: session, fallback: .placeholder, remaining: 25)
  check(result.presentation.display.body == "새 메시지" && result.presentation.communication?.senderName == "이도현", "preview off in the container: 새 메시지, with the name")
  try! MomoPushPresentationSettings(previewEnabled: true, showSender: false).write(to: container)
  downloader.calls = 0
  resetStub()
  result = await assembler(container).assemble(envelope: envelope("dm", channel: dmChannel), session: session, fallback: .placeholder, remaining: 25)
  check(result.presentation.communication == nil && result.presentation.display == PushDisplayContent(title: "oort", body: "새 메시지") && result.avatarSource == .none, "sender off in the container: oort / 새 메시지, nothing dressed, no photo looked up")

  // a push for another workspace than the session's, and the container being absent
  try! MomoPushPresentationSettings.standard.write(to: container)
  resetStub()
  result = await assembler(container).assemble(envelope: envelope("dm", channel: dmChannel, workspace: otherWorkspaceID), session: session, fallback: PushDisplayContent(title: "oort", body: "새 알림"), remaining: 25)
  check(result.presentation.communication == nil && result.presentation.display.body == "새 알림" && RESTStub.requested.isEmpty, "a push for another workspace is never read: the relay's words stay")
  resetStub()
  result = await assembler(nil).assemble(envelope: envelope("dm", channel: dmChannel), session: session, fallback: .placeholder, remaining: 25)
  check(result.presentation.communication?.senderName == "이도현" && result.presentation.communication?.senderAvatarPNG != nil && result.avatarSource != .cache, "no App Group: still dressed, from the defaults and a drawn or fetched picture")

  // a photo only message
  resetStub(fields: #","body":null,"attachments":[{"id":"a1","name":"급여명세서-비공개.png","mime":"image/png","sizeBytes":10}]"#)
  try! MomoPushPresentationSettings.standard.write(to: container)
  result = await assembler(container).assemble(envelope: envelope("dm", channel: dmChannel), session: session, fallback: .placeholder, remaining: 25)
  check(result.presentation.communication?.messageBody == "사진 1장" && !"\(result.presentation)".contains("급여명세서"), "a photo-only message says 사진 1장 and never its file name")
  // a read that fails
  resetStub()
  RESTStub.routes["/messages?limit=200"] = (500, Data())
  result = await assembler(container).assemble(envelope: envelope("dm", channel: dmChannel), session: session, fallback: PushDisplayContent(title: "oort", body: "새 알림"), remaining: 25)
  check(result.presentation.communication == nil && result.presentation.display == PushDisplayContent(title: "oort", body: "새 알림"), "a read that fails leaves the relay's placeholder, not dressed")
}

// ---- the system's half (only inside an iOS simulator) ------------------------------------------------------------------------------------
#if os(iOS)
  import Intents
  import UserNotifications

  do {
    let png = fakePNG(size: 200)
    let group = PushCommunicationDescriptor(
      senderName: "이도현", senderIdentifier: "\(workspaceID)/\(dohyun)", senderAvatarPNG: png, messageBody: "시안 확인 부탁드려요",
      conversationIdentifier: "\(workspaceID)/\(designChannel)", groupName: "#디자인", recipientCount: 5, isThreadReply: false)
    let intent = PushCommunicationIntent.make(group)
    check(intent.speakableGroupName?.spokenPhrase == "#디자인", "the intent carries the room's name")
    check(intent.conversationIdentifier == "\(workspaceID)/\(designChannel)", "and the conversation identifier")
    check(intent.sender?.displayName == "이도현" && intent.sender?.customIdentifier == "\(workspaceID)/\(dohyun)" && intent.sender?.personHandle?.value == "\(workspaceID)/\(dohyun)", "and the sender, by name and by a stable identifier")
    check(intent.sender?.image != nil, "with the photo")
    check(intent.content == "시안 확인 부탁드려요" && intent.serviceName == "oort", "the text and the service")
    check(intent.sender?.isMe == false, "and the sender is not the person who reads it")
    check((intent.donationMetadata as? INSendMessageIntentDonationMetadata)?.recipientCount == 5, "a room says how many people it went to")
    check(intent.image(forParameterNamed: \.speakableGroupName) != nil, "and a room's picture is the sender's photo (a channel has none of its own)")
    let direct = PushCommunicationIntent.make(
      PushCommunicationDescriptor(
        senderName: "이도현", senderIdentifier: "\(workspaceID)/\(dohyun)", senderAvatarPNG: nil, messageBody: "x",
        conversationIdentifier: "\(workspaceID)/\(dmChannel)", groupName: nil, recipientCount: 2, isThreadReply: false))
    check(direct.speakableGroupName == nil && direct.donationMetadata == nil && direct.sender?.image == nil, "a conversation with one person has no group name, no recipient count and, without a photo, no image")

    // the presenter: donate, ask again, apply
    let content = UNMutableNotificationContent()
    content.title = "이도현"
    content.body = "시안 확인 부탁드려요"
    var donated = 0
    var deleted = 0
    var updated = 0
    func presenter(donation: Error?, deletion: Error? = nil) -> PushCommunicationPresenter {
      PushCommunicationPresenter(
        donate: { _, completion in donated += 1; completion(donation) },
        deleteAllInteractions: { completion in deleted += 1; completion(deletion) },
        updateContent: { content, _ in updated += 1; let copy = (content.mutableCopy() as! UNMutableNotificationContent); copy.subtitle = "updated"; return copy })
    }
    var delivered: [UNNotificationContent] = []
    presenter(donation: nil).present(ordinaryContent: content, descriptor: group, isStillAllowed: { true }) { delivered.append($0) }
    check(donated == 1 && updated == 1 && deleted == 0 && delivered.count == 1 && delivered[0].subtitle == "updated", "donate, then apply: the system's updated content is what is delivered")
    donated = 0; updated = 0; delivered = []
    presenter(donation: nil).present(ordinaryContent: content, descriptor: group, isStillAllowed: { false }) { delivered.append($0) }
    check(donated == 0 && updated == 0 && delivered.count == 1 && delivered[0] === content, "the switch is off before anything: nothing is donated, the ordinary content goes")
    var asks = 0
    presenter(donation: nil).present(ordinaryContent: content, descriptor: group, isStillAllowed: { asks += 1; return asks < 2 }) { delivered.append($0) }
    check(donated == 1 && deleted == 1 && updated == 0 && delivered.last === content, "the switch went off DURING the donation: what was donated is deleted and the ordinary content goes (the fence is asked again)")
    donated = 0; deleted = 0; updated = 0
    presenter(donation: NSError(domain: "x", code: 1)).present(ordinaryContent: content, descriptor: group, isStillAllowed: { true }) { delivered.append($0) }
    check(donated == 1 && updated == 0 && delivered.last === content, "a donation that failed delivers the ordinary content, never nothing")
    let throwing = PushCommunicationPresenter(
      donate: { _, completion in completion(nil) }, deleteAllInteractions: { $0(nil) },
      updateContent: { _, _ in throw NSError(domain: "x", code: 2) })
    throwing.present(ordinaryContent: content, descriptor: group, isStillAllowed: { true }) { delivered.append($0) }
    check(delivered.last === content, "an update the system refused delivers the ordinary content too")
  }
#endif

print(failures == 0 ? "PASS" : "FAILED (\(failures))")
exit(failures == 0 ? 0 : 1)
