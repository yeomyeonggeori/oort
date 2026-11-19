import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { CreateChannelDialog, type ChannelDraft } from "@/features/channels/CreateChannelDialog";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { createAppLocale } from "@/i18n/localeStore";
import "@/lib/coreHost";
import "@/design/tokens.css";

// 채널 만들기 창을 실제 엔진에서 재는 하네스 (#5833). 진짜 `CreateChannelDialog`(진짜 토큰·진짜 사전)를 열어 두고,
// 서버 응답은 시험이 경로 가로채기로 흉내 낸다(`**/v1/**`). `?lang=ko-KR|en-US`로 화면 언어를 고른다.
// 시험은 `CreateChannelDialog.nameRule.browser.test.ts`다.

const WS = "00000000-0000-7000-8000-000000000001";
const session = {
  session: {
    accessToken: "a",
    refreshToken: "r",
    member: { id: "00000000-0000-7000-8000-000000000101", workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyeon" },
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
} as unknown as SessionContextValue;

// eslint-disable-next-line react-refresh/only-export-components -- 독립 브라우저 시험의 마운트 함수와 같은 파일에서만 쓰는 화면이에요.
function Host() {
  const [draft, setDraft] = useState<ChannelDraft>({ kind: "public", name: "", topic: "" });
  return (
    <CreateChannelDialog open onOpenChange={() => undefined} onCreated={() => undefined} draft={draft} setDraft={setDraft} />
  );
}

export async function mountCreateChannelHarness() {
  const lang = new URLSearchParams(window.location.search).get("lang") === "en-US" ? "en-US" : "ko-KR";
  const locale = await createAppLocale(
    { readPreference: () => lang, writePreference: () => {}, readDevice: () => ({ languages: [lang], timeZone: "Asia/Seoul" }) },
    { applyLang: () => {} },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LocaleProvider locale={locale}>
          <SessionProvider value={session}>
            <Host />
          </SessionProvider>
        </LocaleProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
