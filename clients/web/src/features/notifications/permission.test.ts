import { describe, expect, it } from "vitest";
import { desktopNotificationPermissionView } from "./permission";

describe("desktop notification permission view", () => {
  it("is unsupported outside the desktop shell", () => {
    expect(
      desktopNotificationPermissionView({ desktop: false, native: "granted" })
    ).toBe("unsupported");
  });

  it("surfaces the three native states inside the shell", () => {
    expect(
      desktopNotificationPermissionView({ desktop: true, native: "granted" })
    ).toBe("granted");
    expect(
      desktopNotificationPermissionView({ desktop: true, native: "default" })
    ).toBe("default");
    expect(
      desktopNotificationPermissionView({ desktop: true, native: "denied" })
    ).toBe("denied");
  });
});
