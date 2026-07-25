import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "@/lib/api";
import {
  channelLabel,
  channelLabelParts,
  dmPeer,
  isAmbiguousName,
  makeDirectory,
  memberFor,
} from "./useWorkspace";

// =============================================================================
// Naming a destination (MOMO-611 R2 High). The demo workspace really holds two
// members displayed as 김인턴, a human (@intern-kim) and an agent (@kim-intern),
// so a DM row named by displayName alone names two different conversations.
// These are the live roster ids and handles, in the case the server sends them.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const DEMO = member({
  id: "00000000-0000-7000-8000-000000000101",
  displayName: "데모 사용자",
  handle: "demo",
});
const SEONGJAE = member({
  id: "00000000-0000-7000-8000-0000000005d1",
  displayName: "곽성재",
  handle: "seongjae",
});
const INTERN_HUMAN = member({
  id: "00000000-0000-7000-8000-0000000005d2",
  displayName: "김인턴",
  handle: "intern-kim",
});
const INTERN_AGENT = member({
  id: "00000000-0000-7000-8000-000000000102",
  displayName: "김인턴",
  handle: "kim-intern",
  kind: "agent",
  ownerHumanId: DEMO.id,
});

const DIRECTORY = makeDirectory([DEMO, SEONGJAE, INTERN_HUMAN, INTERN_AGENT]);

function dm(peerId: string, id = "019f98d1-9d84-7625-9034-17f83367ca8a"): Channel {
  return {
    id,
    workspaceId: WS,
    kind: "dm",
    memberIds: [DEMO.id, peerId],
    dmKey: "a854e7444da734035b4faa15085844c8",
    muted: false,
  };
}

describe("makeDirectory / isAmbiguousName", () => {
  it("marks a display name carried by more than one member", () => {
    expect(isAmbiguousName(DIRECTORY, INTERN_HUMAN)).toBe(true);
    expect(isAmbiguousName(DIRECTORY, INTERN_AGENT)).toBe(true);
    expect(isAmbiguousName(DIRECTORY, SEONGJAE)).toBe(false);
  });

  it("folds case and edge whitespace when comparing names", () => {
    const directory = makeDirectory([
      member({ id: "a", displayName: "Hermes", handle: "hermes" }),
      member({ id: "b", displayName: " hermes ", handle: "hermes-2" }),
    ]);
    expect(directory.ambiguousNames.has("hermes")).toBe(true);
  });

  it("keeps the id lookup case-insensitive", () => {
    expect(memberFor(DIRECTORY, INTERN_HUMAN.id.toUpperCase())?.handle).toBe(
      "intern-kim"
    );
  });
});

describe("dmPeer", () => {
  it("resolves the other participant whatever case the ids arrive in", () => {
    const channel = dm(SEONGJAE.id.toUpperCase());
    expect(dmPeer(channel, DIRECTORY, DEMO.id)?.handle).toBe("seongjae");
  });

  it("is null for a channel, which has no single other participant", () => {
    const channel: Channel = {
      id: "019f8000-0000-7000-8000-000000000001",
      workspaceId: WS,
      kind: "public",
      name: "general",
      muted: false,
    };
    expect(dmPeer(channel, DIRECTORY, DEMO.id)).toBeNull();
  });
});

describe("channelLabelParts", () => {
  it("carries the handle when the name alone names two members", () => {
    expect(channelLabelParts(dm(INTERN_HUMAN.id), DIRECTORY, DEMO.id)).toEqual({
      text: "김인턴",
      handle: "@intern-kim",
      isAgent: false,
    });
    expect(channelLabelParts(dm(INTERN_AGENT.id), DIRECTORY, DEMO.id)).toEqual({
      text: "김인턴",
      handle: "@kim-intern",
      isAgent: true,
    });
  });

  it("leaves the handle off when the name is already unique", () => {
    expect(channelLabelParts(dm(SEONGJAE.id), DIRECTORY, DEMO.id)).toEqual({
      text: "곽성재",
      handle: null,
      isAgent: false,
    });
  });

  it("falls back without inventing a name when the roster has not loaded", () => {
    const empty = makeDirectory([]);
    expect(channelLabelParts(dm(SEONGJAE.id), empty, DEMO.id)).toEqual({
      text: "다이렉트 메시지",
      handle: null,
      isAgent: false,
    });
  });

  it("names a channel by its name, never by a participant", () => {
    const channel: Channel = {
      id: "019f8000-0000-7000-8000-000000000001",
      workspaceId: WS,
      kind: "public",
      name: "general",
      muted: false,
    };
    expect(channelLabelParts(channel, DIRECTORY, DEMO.id)).toEqual({
      text: "general",
      handle: null,
      isAgent: false,
    });
  });
});

describe("channelLabel", () => {
  it("keeps the disambiguator in the one-string form", () => {
    expect(channelLabel(dm(INTERN_AGENT.id), DIRECTORY, DEMO.id)).toBe(
      "김인턴 @kim-intern"
    );
    expect(channelLabel(dm(SEONGJAE.id), DIRECTORY, DEMO.id)).toBe("곽성재");
  });
});
