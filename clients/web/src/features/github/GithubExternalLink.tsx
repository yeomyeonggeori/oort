import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cn } from "@/design/lib/cn";
import { isDesktop, openExternalUrl } from "@/lib/tauri";

// =============================================================================
// 바깥(GitHub)으로 나가는 링크. 브라우저 탭에서는 평범한 앵커이고, 데스크탑 셸에서는
// `target="_blank"` 가 죽은 컨트롤이라 Rust 명령(opener)으로 넘긴다(본문 링크와 같은 넘김,
// MessageBody·ArtifactCard). 주소는 호출부가 `safeHttpsUrl` 로 거른 https 만 넘긴다.
// =============================================================================

export const GithubExternalLink = forwardRef<
  HTMLAnchorElement,
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel"> & { href: string }
>(({ href, onClick, className, ...props }, ref) => (
  <a
    {...props}
    className={cn("press", className)}
    ref={ref}
    href={href}
    target="_blank"
    rel="noreferrer noopener"
    onClick={(event) => {
      onClick?.(event);
      if (event.defaultPrevented || !isDesktop()) return;
      event.preventDefault();
      void openExternalUrl(href);
    }}
  />
));
GithubExternalLink.displayName = "GithubExternalLink";
