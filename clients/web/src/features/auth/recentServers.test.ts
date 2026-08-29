// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearRecentServers,
  readRecentServers,
  rememberRecentServer,
} from "./recentServers";

afterEach(() => {
  clearRecentServers();
});

describe("recent server chips", () => {
  it("stores normalised bases, newest first, without duplicates", () => {
    rememberRecentServer("https://a.example.com/");
    rememberRecentServer("https://b.example.com");
    rememberRecentServer("https://a.example.com");
    expect(readRecentServers()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("drops a value that is not a server URL", () => {
    rememberRecentServer("not a url");
    rememberRecentServer("ws://momo.example.com");
    expect(readRecentServers()).toEqual([]);
  });

  it("caps the list at five", () => {
    for (let i = 0; i < 7; i += 1) {
      rememberRecentServer(`https://s${i}.example.com`);
    }
    expect(readRecentServers()).toHaveLength(5);
    expect(readRecentServers()[0]).toBe("https://s6.example.com");
  });
});
