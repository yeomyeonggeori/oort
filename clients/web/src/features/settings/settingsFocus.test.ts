// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  rememberSettingsOpener,
  restoreSettingsOpener,
} from "./settingsFocus";

describe("settingsFocus", () => {
  afterEach(() => {
    document.body.replaceChildren();
    restoreSettingsOpener();
  });

  it("같은 testid의 새 노드로 포커스를 되돌린다", () => {
    const first = document.createElement("button");
    first.setAttribute("data-testid", "composer-input");
    document.body.append(first);
    first.focus();
    rememberSettingsOpener();
    first.remove();

    const second = document.createElement("button");
    second.setAttribute("data-testid", "composer-input");
    document.body.append(second);
    expect(restoreSettingsOpener()).toBe(true);
    expect(document.activeElement).toBe(second);
  });

  it("기억한 컨트롤이 없으면 손을 떼고 현재 포커스를 건드리지 않는다", () => {
    const keep = document.createElement("button");
    keep.setAttribute("data-testid", "keep");
    document.body.append(keep);
    keep.focus();
    expect(restoreSettingsOpener()).toBe(false);
    expect(document.activeElement).toBe(keep);
  });
});
