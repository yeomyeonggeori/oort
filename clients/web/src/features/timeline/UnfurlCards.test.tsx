import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import { UnfurlCards } from "./UnfurlCards";

const componentSource = readFileSync(
  new URL("./UnfurlCards.tsx", import.meta.url),
  "utf8"
);

const base: MessageUnfurl = {
  id: "u-1",
  messageId: "m-1",
  url: "https://example.com/guide",
  status: "ok",
  title: "운영 가이드",
  description: "문제가 생겼을 때 확인할 순서입니다.",
  domain: "example.com",
};

function html(
  unfurls: readonly MessageUnfurl[],
  options: { folded?: boolean; canRemove?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <UnfurlCards
      unfurls={unfurls}
      folded={options.folded ?? false}
      canRemove={options.canRemove ?? false}
      onRemove={async () => {}}
    />
  );
}

describe("UnfurlCards", () => {
  it("renders the pending reserved slot", () => {
    const output = html([{ ...base, status: "pending" }]);
    expect(output).toContain('data-testid="unfurl-pending"');
    expect(output).toContain("링크 미리보기를 불러오는 중");
  });

  it("renders title, description, domain and a safe external link for ok", () => {
    const output = html([base], { canRemove: true });
    expect(output).toContain('data-testid="unfurl-card"');
    expect(output).toContain("운영 가이드");
    expect(output).toContain("문제가 생겼을 때 확인할 순서입니다.");
    expect(output).toContain("example.com");
    expect(output).toContain('rel="noreferrer noopener"');
    expect(output).toContain('data-testid="unfurl-remove"');
    expect(output).toContain("tap-target");
  });

  it("renders failed, blocked and empty as quiet absence", () => {
    expect(html([{ ...base, status: "failed" }])).toBe("");
    expect(html([{ ...base, status: "blocked" }])).toBe("");
    expect(html([])).toBe("");
  });

  it("folds cards locally without changing the projection", () => {
    expect(html([base], { folded: true })).toBe("");
    expect(base.status).toBe("ok");
  });

  it("withholds removal from non-authors", () => {
    expect(html([base], { canRemove: false })).not.toContain("unfurl-remove");
  });

  it("keeps the desktop external-open handoff and inline refusal path", () => {
    expect(componentSource).toContain("if (!isDesktop()) return");
    expect(componentSource).toContain("openExternalUrl(unfurl.url)");
    expect(componentSource).toContain('data-testid="unfurl-open-error"');
  });
});
