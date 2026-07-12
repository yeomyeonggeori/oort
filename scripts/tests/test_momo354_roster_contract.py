#!/usr/bin/env python3
"""Static MOMO-354 contract checks. Never opens a socket or database connection."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


backend = read("clients/macOS/Sources/MomoMac/MomoServerRESTChatBackend.swift")
view_model = read("clients/macOS/Sources/MomoMac/ChatViewModel.swift")
sidebar = read("clients/macOS/Sources/MomoMac/ChannelListView.swift")
session = read("clients/macOS/Sources/MomoMac/MomoServerSession.swift")
dtos = read("server/Sources/MomoServer/Routes/DTOs.swift")
verifier = read("scripts/verify_macos_real_backend_ui.sh")

assert '"/v1/workspaces/\\(workspace.description)/roster"' in backend
assert '"/v1/workspaces/\\(workspace.description)/members"' not in backend
assert "demoMembers" not in backend and "demoChannels" not in backend
assert "$0.kind == .agent && $0.status == .active && $0.channelIds.contains(channel)" in backend
assert "channelIds.isEmpty ||" not in backend

assert "public func activeMembers" in view_model
assert "return activeMembers()" in view_model
assert "viewModel.activeMembers()" in sidebar
assert "isHiddenDogfoodAgent" not in sidebar

assert dtos.count("let realtimeWebSocketUrl: String") >= 2
assert "serverValue: response.realtimeWebSocketUrl" in session
assert "return centrifugoWebSocketURL(from: environment)" in session

for required in (
    "VERIFIER_DB_MARKER",
    "VERIFIER_DB_CREATED_OID",
    "source_digest",
    "exit 96",
    "uuid.uuid5",
    "CENT_CHANNEL",
    "tr '[:lower:]' '[:upper:]'",
    "/roster",
    ".realtimeWebSocketUrl",
):
    assert required in verifier, required

print("MOMO-354 roster/realtime static contract: PASS (no network, no DB)")
