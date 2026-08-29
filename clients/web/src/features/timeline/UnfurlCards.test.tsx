import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import { UnfurlCardView, UnfurlCards } from "./UnfurlCards";

const componentSource = readFileSync(
  new URL("./UnfurlCards.tsx", import.meta.url),
  "utf8"
);

const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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
  options: {
    preference?: "rich" | "compact" | "off";
    canRemove?: boolean;
  } = {}
): string {
  return renderToStaticMarkup(
    <UnfurlCards
      unfurls={unfurls}
      preference={options.preference ?? "compact"}
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
    expect(output).toContain('data-layout="compact"');
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

  it("renders nothing when preference is off, including pending", () => {
    expect(html([base], { preference: "off" })).toBe("");
    expect(
      html([{ ...base, status: "pending" }], { preference: "off" })
    ).toBe("");
    expect(base.status).toBe("ok");
  });

  it("degrades rich without an image to the compact card", () => {
    const output = html([{ ...base, imageUrl: undefined }], {
      preference: "rich",
    });
    expect(output).toContain('data-layout="compact"');
    expect(output).not.toContain("h-preview-frame");
    expect(output).not.toContain('data-testid="unfurl-image"');
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

describe("UnfurlCardView", () => {
  it("paints a hero image card when rich and the image is ready", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={base} image={PIXEL} preference="rich" />
    );
    expect(output).toContain('data-layout="rich"');
    expect(output).toContain("h-preview-frame");
    expect(output).toContain("object-cover");
    expect(output).toContain('data-testid="unfurl-image"');
    expect(output).toContain('aria-hidden="true"');
    expect(output).toContain('alt=""');
    expect(output).toContain("line-clamp-2");
  });

  it("keeps the compact thumb when compact and the image is ready", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={base} image={PIXEL} preference="compact" />
    );
    expect(output).toContain('data-layout="compact"');
    expect(output).toContain("size-rail-tile");
    expect(output).not.toContain("h-preview-frame");
  });

  it("degrades rich to compact when the image is missing", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={base} image={null} preference="rich" />
    );
    expect(output).toContain('data-layout="compact"');
    expect(output).not.toContain('data-testid="unfurl-image"');
  });

  it("is a single link with no nested tab stops", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={base} image={PIXEL} preference="rich" />
    );
    expect(output.match(/<a /g)).toHaveLength(1);
    expect(output).not.toContain("<button");
    expect(output).toContain("focus-visible:focus-ring");
  });
});
