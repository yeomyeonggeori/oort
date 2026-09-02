import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  advertiseReadState,
  channelReadAdvertisementReason,
  readIntentWire,
} from "./advertiseReadState";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..");

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).map((path) => ({
  path: relative(SRC, path),
  code: codeOnly(readFileSync(path, "utf8")),
}));

function callers(fn: string): string[] {
  const call = new RegExp(`(?<![\\w.])${fn}\\s*\\(`);
  return FILES.filter((file) => call.test(file.code)).map((file) => file.path);
}

describe("readIntentWire", () => {
  it("채널 명시 열람과 「읽음 처리」만 explicit_open 이다", () => {
    expect(readIntentWire("channel_open")).toBe("explicit_open");
    expect(readIntentWire("mark_read_menu")).toBe("explicit_open");
    expect(readIntentWire("arrival_flush")).toBeUndefined();
    expect(readIntentWire("inbox_mention")).toBeUndefined();
    expect(readIntentWire("mark_unread")).toBeUndefined();
  });
});

describe("channelReadAdvertisementReason", () => {
  it("채널 id 가 바뀌면 명시 열람, 같은 채널의 다음 플러시는 도착이다", () => {
    expect(channelReadAdvertisementReason(null, "ch-a")).toBe("channel_open");
    expect(channelReadAdvertisementReason("ch-a", "ch-a")).toBe("arrival_flush");
    expect(channelReadAdvertisementReason("ch-a", "ch-b")).toBe("channel_open");
    expect(channelReadAdvertisementReason("CH-A", "ch-a")).toBe("arrival_flush");
  });
});

describe("광고 호출 자리는 헬퍼 한 곳이다", () => {
  it("updateReadState 를 직접 부르는 제품 코드는 헬퍼뿐이다", () => {
    expect(callers("updateReadState").sort()).toEqual(
      ["features/chat/advertiseReadState.ts"].sort()
    );
  });

  it("명시 열람과 도착 플러시와 읽음 처리와 마크가 헬퍼를 탄다", () => {
    expect(callers("advertiseReadState").sort()).toEqual(
      [
        "features/chat/ChatShell.tsx",
        "features/chat/advertiseReadState.ts",
        "features/chat/channelActions.tsx",
        "features/inbox/useInbox.ts",
        "features/timeline/useMarkUnread.ts",
      ].sort()
    );
  });
});

describe("advertiseReadState 는 reason 을 옵션으로 옮긴다", () => {
  it("함수가 존재한다 (시그니처 고정)", () => {
    expect(typeof advertiseReadState).toBe("function");
  });
});
