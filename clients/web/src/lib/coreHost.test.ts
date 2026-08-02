import { afterEach, describe, expect, it } from "vitest";
import { apiBase as coreApiBase, coreHostInstalled } from "@momo/core/runtime/host";
import { setServerBase } from "./serverBase";
import "./coreHost";

// =============================================================================
// The wiring, asserted (goal RN-C1).
//
// `@momo/core` answers "" for the API base until a host installs itself. That
// default is correct for a decoder unit test and WRONG for a running app: a
// desktop shell that reached it would send every request to `tauri://localhost`
// and get the app bundle back instead of the API. The failure is silent — no
// exception, just a client talking to nobody — so it gets a test rather than a
// comment.
//
// Importing `./coreHost` for its side effect is the whole point: this asserts
// that the side effect exists and that it is pointed at the real modules, not
// that the port's types line up (the compiler already did that).
// =============================================================================

afterEach(() => {
  setServerBase(null);
});

describe("core host installation", () => {
  it("is installed by importing the module", () => {
    expect(coreHostInstalled()).toBe(true);
  });

  it("routes the core's apiBase() to this device's stored server choice", () => {
    expect(coreApiBase()).toBe("");
    setServerBase("https://oort.example.com");
    expect(coreApiBase()).toBe("https://oort.example.com");
    setServerBase(null);
    expect(coreApiBase()).toBe("");
  });
});
