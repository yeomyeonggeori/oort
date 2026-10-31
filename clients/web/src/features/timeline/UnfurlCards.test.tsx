import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
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

// A `border`, `border-t`, `border-line`... class anywhere in a class list, including the first.
const BORDER_CLASS = /class="(?:[^"]*\s)?border(?:-[a-z0-9]+)*[\s"]/;

let korean: AppLocale;
beforeAll(async () => {
  korean = await koreanLocaleForTest();
});

/** Every render goes through the real Korean dictionary, like the app on a Korean device. */
function render(tree: ReactElement): string {
  return renderToStaticMarkup(<LocaleProvider locale={korean}>{tree}</LocaleProvider>);
}

function html(
  unfurls: readonly MessageUnfurl[],
  options: {
    preference?: "rich" | "compact" | "off";
    canRemove?: boolean;
  } = {}
): string {
  return render(
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
  const ICON = "/v1/workspaces/ws/unfurls/u-1/icon";
  const view = (
    unfurl: MessageUnfurl,
    props: {
      image?: string | null;
      icon?: string | null;
      imageFailed?: boolean;
      preference?: "rich" | "compact";
    } = {}
  ): string =>
    render(
      <UnfurlCardView
        unfurl={unfurl}
        image={props.image ?? null}
        icon={props.icon ?? null}
        imageFailed={props.imageFailed ?? false}
        preference={props.preference ?? "compact"}
      />
    );

  it("paints text above a 1.91:1 picture when large and the image is ready", () => {
    const output = view(withImage, { image: PIXEL, preference: "rich" });
    expect(output).toContain('data-layout="rich"');
    expect(output).toContain(UNFURL_HERO_FRAME_CLASS);
    expect(output).toContain("aspect-og");
    expect(output).toContain("max-h-unfurl-hero");
    expect(output).toContain("object-cover");
    expect(output).not.toContain("h-preview-frame");
    expect(output).toContain('data-testid="unfurl-image"');
    expect(output).toContain('aria-hidden="true"');
    expect(output).toContain('alt=""');
    // Title and description run to two lines, and they sit above the picture.
    expect(output.match(/line-clamp-2/g)).toHaveLength(2);
    expect(output.indexOf('data-testid="unfurl-title"')).toBeLessThan(
      output.indexOf('data-testid="unfurl-hero"')
    );
  });

  it("draws the small card as a 104x64 picture beside address, one-line title and one-line description", () => {
    const output = view(withImage, { image: PIXEL });
    expect(output).toContain('data-layout="compact"');
    expect(output).toContain("h-unfurl-tile");
    expect(output).toContain("w-unfurl-thumb");
    expect(output).toContain("object-cover");
    expect(output).not.toContain("aspect-og");
    expect(output).not.toContain("h-preview-frame");
    // Picture first, then the text column; each text line is one line, never a two-line clamp.
    expect(output.indexOf('data-testid="unfurl-thumb"')).toBeLessThan(
      output.indexOf('data-testid="unfurl-address"')
    );
    expect(output).toMatch(/class="[^"]*\btruncate\b[^"]*" data-testid="unfurl-title"/);
    expect(output).toMatch(/class="[^"]*\btruncate\b[^"]*" data-testid="unfurl-description"/);
    expect(output).not.toContain("line-clamp-2");
  });

  it("has no border on the card itself", () => {
    for (const preference of ["compact", "rich"] as const) {
      const output = view(withImage, { image: PIXEL, preference });
      expect(output, preference).not.toMatch(BORDER_CLASS);
    }
    expect(html([withImage])).not.toMatch(BORDER_CLASS);
  });

  it("shows a small or square picture whole in the 64x64 slot, never cropped", () => {
    const square = { ...withImage, imageWidth: 600, imageHeight: 600 };
    const output = view(square, { image: PIXEL });
    expect(output).toContain('data-testid="unfurl-thumb"');
    expect(output).toContain("size-unfurl-tile");
    expect(output).not.toContain("w-unfurl-thumb");
    expect(output).toContain("object-contain");
    expect(output).not.toContain("object-cover");
    // A large card cannot fill its frame with a small picture, so it becomes the small row.
    const large = view(square, { image: PIXEL, preference: "rich" });
    expect(large).toContain('data-layout="compact"');
    expect(large).not.toContain('data-testid="unfurl-hero"');
  });

  it("uses the icon tile when there is no picture: the site icon, else the globe", () => {
    const noIcon = view(base);
    expect(noIcon).toContain('data-layout="compact"');
    expect(noIcon).toContain('data-testid="unfurl-tile"');
    expect(noIcon).toContain("size-unfurl-tile");
    expect(noIcon).not.toContain('data-testid="unfurl-image"');
    expect(noIcon).not.toContain('data-testid="unfurl-icon"');
    expect(noIcon).toContain('data-testid="unfurl-globe"');

    const withIcon = view({ ...base, iconUrl: ICON }, { icon: PIXEL });
    expect(withIcon).toContain('data-testid="unfurl-tile"');
    expect(withIcon).toContain('data-testid="unfurl-icon"');
    expect(withIcon).not.toContain('data-testid="unfurl-globe"');
    // The address line wears the same icon, so the two share one request.
    expect(withIcon.match(/data-testid="unfurl-icon"/g)).toHaveLength(2);
    expect(withIcon).toContain("object-contain");
  });

  it("turns a picture that failed to load into the same tile, not a broken image", () => {
    const output = view(withImage, { imageFailed: true, preference: "rich" });
    expect(output).toContain('data-layout="compact"');
    expect(output).toContain('data-testid="unfurl-tile"');
    expect(output).not.toContain('data-testid="unfurl-hero"');
    expect(output).not.toContain('data-testid="unfurl-image"');
    // Still loading is not failed: the picture slot is reserved on the first paint.
    const loading = view(withImage);
    expect(loading).toContain('data-testid="unfurl-thumb"');
    expect(loading).not.toContain('data-testid="unfurl-tile"');
  });

  it("keeps the address line on the real domain whatever the site calls itself", () => {
    const output = view({
      ...withImage,
      title: undefined,
      siteName: "apple.com",
      domain: "evil.example",
      url: "https://evil.example/login",
    });
    const address = output.match(/data-testid="unfurl-address"[^>]*>(.*?)<\/span><\/span>/)?.[1] ?? "";
    expect(address).toContain("evil.example");
    expect(address).not.toContain("apple.com");
    expect(output).toMatch(/data-testid="unfurl-title">apple\.com</);
  });

  it("leaves the description line out when it only repeats the title", () => {
    expect(view({ ...base, description: base.title })).not.toContain("unfurl-description");
    expect(view({ ...base, description: undefined })).not.toContain("unfurl-description");
    expect(view(base)).toContain("unfurl-description");
  });

  it("marks a video with a play mark that opens the original page", () => {
    const video: MessageUnfurl = { ...withImage, isVideo: true, url: "https://video.example/watch?v=1" };
    for (const preference of ["compact", "rich"] as const) {
      const output = view(video, { image: PIXEL, preference });
      expect(output, preference).toContain('data-testid="unfurl-play"');
      expect(output, preference).toContain('href="https://video.example/watch?v=1"');
      expect(output, preference).toContain('target="_blank"');
    }
    // The mark is only a picture, so the screen reader hears it as a description of the link.
    const output = view(video, { image: PIXEL });
    const describedBy = output.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeDefined();
    expect(output).toMatch(new RegExp(`id="${describedBy}"[^>]*>동영상<`));
    expect(view(withImage, { image: PIXEL })).not.toContain("unfurl-play");
    expect(view(withImage, { image: PIXEL })).not.toContain("aria-describedby");
  });

  it("names the link 「링크 미리보기: 제목, 도메인」 and keeps a visible focus ring", () => {
    const output = view(withImage, { image: PIXEL });
    expect(output).toContain('aria-label="링크 미리보기: 운영 가이드, example.com"');
    expect(output).toContain("focus-visible:focus-ring");
    // The label follows the language: no provider means the English dictionary.
    const english = renderToStaticMarkup(
      <UnfurlCardView unfurl={withImage} image={PIXEL} preference="compact" />
    );
    expect(english).toContain('aria-label="Link preview: 운영 가이드, example.com"');
  });

  it("draws page text as text: markup in a title is escaped and nothing sets inner HTML", () => {
    const output = view({
      ...base,
      title: '<img src=x onerror=alert(1)>',
      description: "<b>bold</b>",
    });
    expect(output).not.toContain("<img src=x");
    expect(output).not.toContain("<b>");
    expect(output).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(componentSource).not.toContain("dangerouslySetInnerHTML");
  });

  it("strips direction controls from page text before it is drawn", () => {
    const output = view({ ...base, title: "\u202Egnp.exe" });
    expect(output).toContain(">gnp.exe<");
    expect(output).not.toContain("\u202E");
  });

  it("keeps the text clear of the corner remove chip in both shapes", () => {
    const compact = view(withImage, { image: PIXEL });
    const rich = view(withImage, { image: PIXEL, preference: "rich" });
    expect(compact).toContain("pr-control-lg");
    expect(rich).toContain("pr-control-lg");
  });

  it("is a single link with no nested tab stops", () => {
    const output = view(withImage, { image: PIXEL, preference: "rich" });
    expect(output.match(/<a /g)).toHaveLength(1);
    expect(output).not.toContain("<button");
    expect(output).toContain("focus-visible:focus-ring");
  });
});

describe("UnfurlCards (many links)", () => {
  const link = (n: number, patch: Partial<MessageUnfurl> = {}): MessageUnfurl => ({
    ...base,
    id: `u-${n}`,
    url: `https://site${n}.example/page`,
    domain: `site${n}.example`,
    title: `제목 ${n}`,
    ...patch,
  });
  const cards = (output: string) => output.match(/data-testid="unfurl-card"/g)?.length ?? 0;

  it("draws cards for the first 3 distinct links and no fourth", () => {
    const output = html([link(1), link(2), link(3), link(4)]);
    expect(cards(output)).toBe(3);
    expect(output).toContain("제목 3");
    expect(output).not.toContain("제목 4");
  });

  it("lets a link that gave nothing leave only its text link, without an error line", () => {
    const output = html([link(1, { status: "failed" }), link(2), link(3, { status: "blocked" }), link(4)]);
    expect(cards(output)).toBe(1);
    expect(output).not.toContain("제목 1");
    expect(output).not.toContain("alert");
  });

  it("draws no card for a page with no title and no picture", () => {
    const bare = link(1, { title: undefined, imageUrl: undefined, description: "설명만 있어요" });
    expect(html([bare])).toBe("");
  });
});
