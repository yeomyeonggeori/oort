// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Button, type ButtonProps } from "./ui/button";

// =============================================================================
// 웹 단추 규격 (DS-05, #6074)
//
// ① 부품 장부(components.md) 「단추」 절의 종류 · 크기 표와 button.tsx의 변형 표가 같은
//    이름을 든다. 한쪽에만 이름을 더하거나 빼면 빨개진다(문서가 코드보다 늦게 가는 것을 막는다).
// ② 「진행 중」(busy)은 누름을 전달하지 않는다: onClick · 폼 제출 · 바깥 click 0회,
//    aria-busy가 서고, disabled가 아니라 초점이 남는다. 같은 판에서 busy만 끈 단추는
//    셋 다 1회다(세는 장치가 실제로 센다는 대조군).
// 높이 변화 0 · 계산된 스타일 전후 차이 0은 브라우저로 잰다(PR 본문의 측정).
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const BUTTON_SRC = readFileSync(join(HERE, "ui", "button.tsx"), "utf8");
const LEDGER = readFileSync(
  join(HERE, "..", "..", "..", "..", "docs", "design-system", "components.md"),
  "utf8"
);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** cva 설정의 `<block>: { key: "...", ... }` 에서 키 이름만. */
function cvaKeys(block: "variant" | "size"): string[] {
  const code = stripComments(BUTTON_SRC);
  const match = new RegExp(`\\b${block}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`).exec(code);
  if (!match) return [];
  return [...match[1].matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1]);
}

/** 「## 단추」 절 안 `### <제목>` 표의 둘째 칸(코드 이름). */
function ledgerNames(heading: "종류" | "크기"): string[] {
  const section = /^## 단추[^\n]*\n([\s\S]*?)(?=^## )/m.exec(LEDGER)?.[1] ?? "";
  const table = new RegExp(`^### ${heading}\\n([\\s\\S]*?)(?=^### |$(?![\\s\\S]))`, "m").exec(section)?.[1] ?? "";
  return table
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[-| ]+\|$/.test(line))
    .slice(1)
    .map((line) => /^\|[^|]*\|\s*`([A-Za-z]+)`/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

describe("단추 규격 표 ↔ button.tsx 변형 표", () => {
  it.each([
    ["variant", "종류"],
    ["size", "크기"],
  ] as const)("%s 이름과 장부 「%s」 표의 코드 이름이 같다", (block, heading) => {
    const code = cvaKeys(block);
    const doc = ledgerNames(heading);
    expect(code.length, `button.tsx ${block} 블록을 읽지 못했다`).toBeGreaterThan(0);
    expect(doc.length, `components.md 「${heading}」 표를 읽지 못했다`).toBeGreaterThan(0);
    expect([...doc].sort()).toEqual([...code].sort());
  });
});

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

function mountInForm(props: Partial<ButtonProps>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onClick = vi.fn();
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  const onOuterClick = vi.fn();
  act(() =>
    root?.render(
      createElement(
        "form",
        { onSubmit, onClick: onOuterClick },
        createElement(Button, { type: "submit", onClick, ...props }, "저장")
      )
    )
  );
  const button = host.querySelector<HTMLButtonElement>("button")!;
  return { button, onClick, onSubmit, onOuterClick };
}

describe("진행 중(busy)", () => {
  it("누름 · 폼 제출 · 바깥 click이 0회이고, busy만 끈 대조군은 1회다", () => {
    const busy = mountInForm({ busy: true });
    act(() => busy.button.click());
    expect(busy.onClick).not.toHaveBeenCalled();
    expect(busy.onSubmit).not.toHaveBeenCalled();
    expect(busy.onOuterClick).not.toHaveBeenCalled();
    act(() => root?.unmount());
    host?.remove();
    root = null;

    const rest = mountInForm({});
    act(() => rest.button.click());
    expect(rest.onClick).toHaveBeenCalledTimes(1);
    expect(rest.onSubmit).toHaveBeenCalledTimes(1);
    expect(rest.onOuterClick).toHaveBeenCalledTimes(1);
  });

  it("aria-busy가 서고 잠기지 않아 초점이 남으며, 돌림 표시는 낭독되지 않는다", () => {
    const { button } = mountInForm({ busy: true });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    const spinner = button.querySelector("[data-button-busy-spinner]");
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toBe("저장");
  });
});
