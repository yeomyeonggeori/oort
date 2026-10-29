import Foundation
import Intents

// =============================================================================
// The app's half of the presentation state (#4316, ADR-0204 증보 5): JS decides, this writes.
//
// What the layout is, its limits and the cleanup rule live in `MomoPushPresentationStore.swift` — the
// ONE file the notification extension compiles too, so the writer and the reader cannot disagree. This
// file only adds what needs the app: opening a picture the app already downloaded, and asking the
// system (`INInteraction.deleteAll`) to forget the communication interactions the extension donated.
//
// Nothing here throws into JS. A write that did not happen answers `false`: the notification is then
// drawn from what the extension can find or draw itself, which is a worse notification and never a
// missing one.
// =============================================================================
enum MomoPushPresentationBridge {
    private static var container: MomoPushPresentationContainer? {
        MomoPushPresentationContainer.appGroup()
    }

    /// The two switches of 설정 › 알림 as this phone holds them.
    static func setSettings(previewEnabled: Bool, showSender: Bool) -> Bool {
        guard let container else { return false }
        do {
            try MomoPushPresentationSettings(previewEnabled: previewEnabled, showSender: showSender)
                .write(to: container)
            return true
        } catch {
            return false
        }
    }

    /// Hands the extension a face the app already has on disk (`file://` in the app's cache directory).
    /// Cut to a centred square of at most 288 px and 64 KB first. Already there for this media version:
    /// nothing is read or written again (the app shows the same avatar on every screen).
    static func exportAvatar(baseURL: String, workspaceID: String, memberID: String, version: String, fileURI: String)
        -> Bool
    {
        guard let container, let url = URL(string: fileURI), url.isFileURL else { return false }
        let cache = container.cache
        if cache.avatarPNG(server: baseURL, workspace: workspaceID, member: memberID, version: version) != nil {
            return true
        }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              let png = MomoPushPresentationImage.avatarPNG(
                  from: data,
                  maxSourceBytes: MomoPushPresentationContract.appSourceMaxBytes,
                  maxSourceEdge: MomoPushPresentationContract.appSourceMaxEdge)
        else { return false }
        return cache.storeAvatarPNG(
            png, server: baseURL, workspace: workspaceID, member: memberID, version: version)
    }

    /// The workspace's whole channel list: `{id, kind: "public" | "private" | "dm", name?, memberCount?}`.
    /// An entry that does not have that shape is skipped, not an error.
    static func exportChannels(baseURL: String, workspaceID: String, channels: [[String: Any]]) -> Bool {
        guard let container else { return false }
        let parsed: [MomoPushPresentationChannel] = channels.compactMap { entry in
            guard let id = entry["id"] as? String, UUID(uuidString: id) != nil,
                  let rawKind = entry["kind"] as? String,
                  let kind = MomoPushPresentationChannel.Kind(rawValue: rawKind)
            else { return nil }
            return MomoPushPresentationChannel(
                id: id, kind: kind, name: entry["name"] as? String, memberCount: entry["memberCount"] as? Int)
        }
        return container.cache.replaceChannels(server: baseURL, workspace: workspaceID, channels: parsed)
    }

    private static func makeCleanup() -> MomoPushPresentationCleanup {
        MomoPushPresentationCleanup(
            container: container,
            deleteAllInteractions: { completion in INInteraction.deleteAll(completion: completion) })
    }

    /// 로그아웃·계정 전환·「보낸 사람 표시」 끄기. `true` once the system confirmed that it forgot what the
    /// extension donated; the cache is gone either way, and a deletion that did not finish is retried at
    /// the next start (`retryPendingCleanup`).
    static func clear(completion: @escaping (Bool) -> Void) {
        makeCleanup().request { error in completion(error == nil) }
    }

    /// At app start: finish a deletion an earlier run began and could not finish.
    static func retryPendingCleanup() {
        makeCleanup().retryPending { _ in }
    }
}
