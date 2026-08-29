import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import {
  UNFURL_HERO_FRAME_CLASS,
  UnfurlCardView,
  UnfurlCards,
} from "./UnfurlCards";
import { resetUnfurlImagesForTest } from "./useUnfurlImage";

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

afterEach(() => resetUnfurlImagesForTest());

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
    expect(output).not.toContain("aspect-og");
    expect(output).not.toContain("h-preview-frame");
    expect(output).not.toContain('data-testid="unfurl-image"');
    expect(output).not.toContain('data-testid="unfurl-hero"');
  });

  it("reserves the rich hero frame before image bytes arrive", () => {
    const output = html(
      [{ ...base, imageUrl: "/v1/workspaces/ws/unfurls/u-1/image" }],
      { preference: "rich" }
    );
    expect(output).toContain('data-layout="rich"');
    expect(output).toContain("aspect-og");
    expect(output).toContain("max-h-unfurl-hero");
    expect(output).toContain(UNFURL_HERO_FRAME_CLASS);
    expect(output).toContain('data-testid="unfurl-hero"');
    expect(output).not.toContain('data-testid="unfurl-image"');
  });

  it("gives the remove control an opaque token chip", () => {
    const output = html([base], { canRemove: true });
    const remove = output.match(
      /<button(?=[^>]*data-testid="unfurl-remove")[^>]*>/
    )?.[0];
    expect(remove).toBeDefined();
    expect(remove).toContain("bg-surface-raised");
    expect(remove).toContain("border-line-strong");
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
  const withImage: MessageUnfurl = {
    ...base,
    imageUrl: "/v1/workspaces/ws/unfurls/u-1/image",
  };

  it("paints a hero image card when rich and the image is ready", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={PIXEL} preference="rich" />
    );
    expect(output).toContain('data-layout="rich"');
    expect(output).toContain(UNFURL_HERO_FRAME_CLASS);
    expect(output).toContain("aspect-og");
    expect(output).toContain("max-h-unfurl-hero");
    expect(output).toContain("object-cover");
    expect(output).not.toContain("h-preview-frame");
    expect(output).toContain('data-testid="unfurl-image"');
    expect(output).toContain('aria-hidden="true"');
    expect(output).toContain('alt=""');
    expect(output).toContain("line-clamp-2");
  });

  it("keeps the compact thumb when compact and the image is ready", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={PIXEL} preference="compact" />
    );
    expect(output).toContain('data-layout="compact"');
    expect(output).toContain("size-rail-tile");
    expect(output).toContain("items-stretch");
    expect(output).not.toContain("aspect-og");
    expect(output).not.toContain("h-preview-frame");
  });

  it("degrades rich to compact when the image is missing", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={base} image={null} preference="rich" />
    );
    expect(output).toContain('data-layout="compact"');
    expect(output).not.toContain('data-testid="unfurl-image"');
    expect(output).not.toContain('data-testid="unfurl-hero"');
  });

  it("uses the same hero frame class before and after bytes arrive", () => {
    const reserved = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={null} preference="rich" />
    );
    const ready = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={PIXEL} preference="rich" />
    );
    expect(reserved).toContain('data-layout="rich"');
    expect(ready).toContain('data-layout="rich"');
    expect(reserved).toContain(UNFURL_HERO_FRAME_CLASS);
    expect(ready).toContain(UNFURL_HERO_FRAME_CLASS);
    expect(reserved).not.toContain('data-testid="unfurl-image"');
    expect(ready).toContain('data-testid="unfurl-image"');
  });

  it("degrades rich to compact when fetch failed", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView
        unfurl={withImage}
        image={null}
        imageFailed
        preference="rich"
      />
    );
    expect(output).toContain('data-layout="compact"');
    expect(output).not.toContain('data-testid="unfurl-hero"');
  });

  it("pads the compact meta for the remove chip and not the rich meta", () => {
    const compact = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={PIXEL} preference="compact" />
    );
    const rich = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={PIXEL} preference="rich" />
    );
    expect(compact).toContain("pr-control-lg");
    expect(rich).not.toContain("pr-control-lg");
    expect(rich).toContain("p-3");
  });

  it("is a single link with no nested tab stops", () => {
    const output = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={PIXEL} preference="rich" />
    );
    expect(output.match(/<a /g)).toHaveLength(1);
    expect(output).not.toContain("<button");
    expect(output).toContain("focus-visible:focus-ring");
  });
});
