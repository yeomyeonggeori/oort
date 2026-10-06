// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { ScopeChip } from "./ScopeChip";
import { SCOPE_LABELS, type SettingsScope } from "../settingsNav";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

describe("SettingsPageHeader", () => {
  it("보이는 h1 하나, 설명과 범위 칩은 선택이다", () => {
    const bare = mount(<SettingsPageHeader title="모양" />);
    expect(bare.querySelectorAll("h1")).toHaveLength(1);
    expect(bare.querySelector("p")).toBeNull();
    expect(bare.querySelector('[data-testid="settings-scope-chip"]')).toBeNull();
    const full = mount(
      <SettingsPageHeader title="모양" description="화면 색을 정해요." scope="device" />
    );
    expect(full.querySelector("h1")?.textContent).toBe("모양");
    expect(full.querySelector("p")?.textContent).toBe("화면 색을 정해요.");
    expect(full.querySelector('[data-testid="settings-scope-chip"]')?.textContent).toBe(
      SCOPE_LABELS.device
    );
  });

  it("h1은 포커스를 받을 수 있다(진입 포커스 폴백)", () => {
    const h = mount(<SettingsPageHeader title="프로필" />);
    expect(h.querySelector("h1")?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("ScopeChip", () => {
  it("범위마다 정해진 문장을 글자로 말하고 아이콘은 장식이다", () => {
    for (const scope of Object.keys(SCOPE_LABELS) as SettingsScope[]) {
      const h = mount(<ScopeChip scope={scope} />);
      expect(h.textContent).toBe(SCOPE_LABELS[scope]);
      expect(h.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("SettingsSection", () => {
  it("제목(h2)이 section의 이름이고 본문은 카드 안에 선다", () => {
    const h = mount(
      <SettingsSection title="색" description="설명" testId="sec">
        <div data-testid="child">행</div>
      </SettingsSection>
    );
    const section = h.querySelector("section")!;
    const heading = h.querySelector("h2")!;
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toBe("색");
    expect(h.querySelector(".settings-card [data-testid='child']")).not.toBeNull();
  });

  it("제목이 없으면 aria-labelledby를 달지 않는다", () => {
    const h = mount(
      <SettingsSection>
        <div>행</div>
      </SettingsSection>
    );
    expect(h.querySelector("section")?.hasAttribute("aria-labelledby")).toBe(false);
    expect(h.querySelector("h2")).toBeNull();
  });
});

describe("SettingsRow", () => {
  it("라벨·설명·컨트롤을 그리고 변형 속성을 단다", () => {
    const h = mount(
      <SettingsRow
        label="글자 크기"
        description="대화에 적용돼요."
        stack
        keep
        align="start"
        labelId="l"
        descriptionId="d"
      >
        <button type="button">컨트롤</button>
      </SettingsRow>
    );
    const row = h.querySelector(".settings-row")!;
    expect(row.hasAttribute("data-stack")).toBe(true);
    expect(row.hasAttribute("data-keep")).toBe(true);
    expect(row.getAttribute("data-align")).toBe("start");
    expect(h.querySelector("#l")?.textContent).toBe("글자 크기");
    expect(h.querySelector("#d")?.textContent).toBe("대화에 적용돼요.");
    expect(h.querySelector("button")?.textContent).toBe("컨트롤");
  });

  it("컨트롤이 없으면 컨트롤 칸을 그리지 않는다", () => {
    const h = mount(<SettingsRow label="정보" />);
    expect(h.querySelectorAll(".settings-row > div")).toHaveLength(1);
  });
});
