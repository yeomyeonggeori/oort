// MomoMacSmoke — build-verification smoke executable (ticket T09).
//
// Proves the MomoMac library compiles + links against MomoCore by importing both,
// constructing real domain models, and printing them. Runtime here is trivial and
// does not require Postgres/Centrifugo/hermes (none available in this build env).
//
// NOTE: this links the MomoMac library (which is SwiftUI) but only exercises model
// types + the in-memory backend, so it runs headless under `swift run MomoMacSmoke`.

import Foundation
import MomoCore
import MomoMac

@main
struct MomoMacSmoke {
    static func main() async {
        print("== momo macOS smoke ==")

        // 1) MomoCore model round-trip.
        let ws = WorkspaceID()
        let agent = Member(
            id: MemberID(), workspaceId: ws, kind: .agent,
            displayName: "리서처", handle: "researcher", presence: .working)
        let channel = Channel(
            id: ChannelID(), workspaceId: ws, kind: .publicChannel,
            name: "general", topic: "demo")
        let toolCall = Message(
            id: MessageID(), channelId: channel.id, seq: 1,
            hlcTs: 1_700_000_000_000, hlcCount: 0,
            authorMemberId: agent.id, type: .toolCall, state: .sent,
            props: .object([
                "name": .string("search_repo"),
                "arguments": .object(["query": .string("migration")]),
            ]),
            runId: RunID())

        print("workspace:", ws.description)
        print("member:   ", agent.displayName, "(\(agent.kind.rawValue), presence=\(agent.presence.rawValue))")
        print("channel:  ", channel.name ?? "DM", "kind=\(channel.kind.rawValue)")
        print("message:  ", "type=\(toolCall.type.rawValue) seq=\(toolCall.seq.map(String.init) ?? "nil")")

        // 2) Codable round-trip through the canonical coders.
        if let data = try? JSONEncoder.momo.encode(toolCall),
           let decoded = try? JSONDecoder.momo.decode(Message.self, from: data) {
            print("codable:   round-trip OK (type=\(decoded.type.rawValue))")
        } else {
            print("codable:   round-trip FAILED")
        }

        // 3) MomoMac in-memory backend seed (proves the library links).
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let history = (try? await backend.history(channel: seed.channels[0].id, after: nil, limit: 50)) ?? []
        print("seed:      ws=\(seed.workspace.description) channels=\(seed.channels.count) agents=\(seed.agents.count)")
        print("history:   channel[0] has \(history.count) seeded message(s)")

        // 4) Cost formatting helper (experience B).
        print("cost:      \(CostFormat.usd(280_000)) reserved \(CostFormat.usd(400_000))")

        print("== smoke OK ==")
    }
}
