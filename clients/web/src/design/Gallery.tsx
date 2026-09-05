import {
  cloneElement,
  forwardRef,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Hash } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cn } from "@/design/lib/cn";
import { setTheme, useSystemScheme, useThemeChoice } from "@/design/theme";
import { Button } from "@/design/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/design/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/design/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/design/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { Input } from "@/design/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/design/ui/popover";
import { Select } from "@/design/ui/select";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { SidebarRow } from "@/features/sidebar/SidebarRow";
import {
  SettingsToggleRow,
  SETTINGS_COLLAPSIBLE_CARD_CLASS,
  SETTINGS_COLLAPSIBLE_SUMMARY_CLASS,
} from "@/features/settings/SettingsFields";
import { DraftRow } from "@/features/drafts/DraftsRoute";
import type { DraftViewItem } from "@/features/drafts/model";
import { MessageRow } from "@/features/timeline/MessageRow";
import { PendingRow } from "@/features/timeline/PendingRow";
import { ReactionChips } from "@/features/timeline/ReactionChips";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { Message, RosterMember } from "@momo/core/lib/api";
import type { ReactionChip } from "@momo/core/features/timeline/reactions";
import "./gallery-preview.css";

// Reading this as: design gallery (diagnostic surface) for internal team users
// on web+Tauri, density 6/10, motion 2/10.

/** 한국어·영문·숫자·이모지 혼합. 80은 상한이지 목표가 아니다. */
export const GALLERY_TEXT_FIXTURE =
  "릴리스 노트 v0.1.4: 배포 12회 중 3회가 롤백됐다. seq 4082 로그를 같이 보고 오늘 안에 확정하자 🔥";

const INTERACTION_STATES = [
  "rest",
  "hover",
  "active",
  "focus",
  "disabled",
  "busy",
] as const;
type InteractionState = (typeof INTERACTION_STATES)[number];

const BUTTON_STATES = INTERACTION_STATES;
const FIELD_STATES = ["rest", "focus", "disabled"] as const;
const SIDEBAR_STATES = ["rest", "hover", "focus"] as const;
const CHIP_STATES = ["rest", "hover", "focus", "disabled"] as const;

const MOTION_VOCABULARY = [
  "press",
  "press-instant-fill",
  "scrim-press",
  "motion-instant",
  "motion-fast",
  "motion-standard",
  "motion-arrival",
  "motion-enter",
  "motion-exit",
  "motion-enter-zoom",
  "motion-exit-zoom",
  "motion-modal-enter",
  "motion-modal-exit",
  "motion-modal-enter-zoom",
  "motion-modal-exit-zoom",
  "shadow-sm",
  "shadow-lg",
] as const;

const MOTION_EXIT = new Set([
  "motion-exit",
  "motion-exit-zoom",
  "motion-modal-exit",
  "motion-modal-exit-zoom",
]);

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-0000000005d1";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";

const galleryQuery = new QueryClient({
  defaultOptions: {
    queries: { retry: false, enabled: false },
    mutations: { retry: false },
  },
});

function previewOf(
  state: InteractionState
): "hover" | "active" | "focus" | undefined {
  if (state === "hover" || state === "active" || state === "focus") return state;
  return undefined;
}

function controlProps(state: InteractionState) {
  return {
    "data-gallery-preview": previewOf(state),
    disabled: state === "disabled" ? true : undefined,
    "aria-busy": state === "busy" ? true : undefined,
  };
}

const preventAutoFocus = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

const Export = forwardRef<
  HTMLDivElement,
  { name: string; children: ReactNode }
>(function Export({ name, children }, ref) {
  return (
    <div ref={ref} data-gallery-export={name}>
      {children}
    </div>
  );
});

function StateRow({
  title,
  states,
  note,
  children,
}: {
  title: string;
  states: readonly InteractionState[];
  note?: string;
  children: (state: InteractionState) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-6">
      <h2 className="text-title font-medium text-ink">{title}</h2>
      {note ? <p className="text-meta text-ink-muted">{note}</p> : null}
      <div className="flex flex-wrap gap-4">
        {states.map((state) => (
          <figure key={state} className="flex min-w-pane-sm flex-col gap-2">
            <figcaption className="text-meta text-ink-muted">{state}</figcaption>
            {children(state)}
          </figure>
        ))}
      </div>
    </section>
  );
}

function StampPreview({
  preview,
  selector,
  children,
}: {
  preview?: "hover" | "active" | "focus";
  selector: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current?.querySelector(selector);
    if (preview && node instanceof HTMLElement) {
      node.setAttribute("data-gallery-preview", preview);
    }
  });
  return <div ref={ref}>{children}</div>;
}

function OverlayCell({
  portalExport,
  className,
  children,
}: {
  portalExport?: string;
  className?: string;
  children: (host: HTMLElement) => ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setHost}
      data-gallery-stage=""
      {...(portalExport ? { "data-gallery-export": portalExport } : {})}
      className={cn("relative border border-line bg-surface p-4", className)}
    >
      {host ? children(host) : null}
    </div>
  );
}

function galleryMember(): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [CHANNEL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function gallerySession(): SessionContextValue {
  const member = galleryMember();
  return {
    session: {
      accessToken: "gallery",
      refreshToken: "gallery",
      member: {
        id: member.id,
        workspaceId: member.workspaceId,
        kind: member.kind,
        displayName: member.displayName,
        handle: member.handle,
      },
      realtimeWebSocketUrl: "wss://gallery.invalid/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function galleryMessage(): Message {
  return {
    id: "00000000-0000-7000-8000-000000000401",
    channelId: CHANNEL_ID,
    seq: 4082,
    hlcTs: 1_800_000_000_000,
    hlcCount: 0,
    authorMemberId: MEMBER_ID,
    type: "text",
    body: GALLERY_TEXT_FIXTURE,
    state: "sent",
    createdAtMs: 1_800_000_000_000,
  };
}

function galleryPending() {
  return {
    clientMsgId: "gallery-pending-1",
    channelId: CHANNEL_ID,
    authorMemberId: MEMBER_ID,
    body: GALLERY_TEXT_FIXTURE,
    createdAtMs: 1_800_000_000_000,
    sinceSeq: 4081,
    status: "sending" as const,
  };
}

function galleryDraft(): DraftViewItem {
  return {
    workspaceId: WS,
    channelId: CHANNEL_ID,
    text: GALLERY_TEXT_FIXTURE,
    atMs: 1_800_000_000_000,
    preview: GALLERY_TEXT_FIXTURE,
    destination: {
      text: "릴리스 노트",
      handle: null,
      kind: "public",
      isAgent: false,
    },
  };
}

function SchemeToggle() {
  const choice = useThemeChoice();
  const system = useSystemScheme();
  const resolved = choice === "system" ? system : choice;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant={resolved === "light" ? "default" : "outline"}
        size="sm"
        aria-pressed={resolved === "light"}
        onClick={() => setTheme("light")}
      >
        라이트로 보기
      </Button>
      <Button
        type="button"
        variant={resolved === "dark" ? "default" : "outline"}
        size="sm"
        aria-pressed={resolved === "dark"}
        onClick={() => setTheme("dark")}
      >
        다크로 보기
      </Button>
    </div>
  );
}

function OverlayExamples() {
  return (
    <section className="flex flex-col gap-4 border-b border-line py-6">
      <h2 className="text-title font-medium text-ink">떠 있는 표면</h2>
      <p className="text-body text-ink-muted">
        패널은 elevation-float (shadow-lg). 아래 네 칸은 실제로 열린 Dialog,
        DropdownMenu, Popover, ContextMenu 다. 판은 칸 안에 붙는다.
      </p>
      <div className="flex flex-col gap-6">
        <div className="flex w-max max-w-full flex-col gap-2">
          <p className="text-meta text-ink-muted">Dialog</p>
          <p className="text-meta text-ink-muted">
            스크림은 갤러리 대역이다. 모달을 끄면 프리미티브는 스크림을 그리지
            않는다.
          </p>
          <Export name="Dialog">
            <Dialog open modal={false}>
              <DialogTrigger asChild>
                <Button
                  data-gallery-export="DialogTrigger"
                  type="button"
                  variant="outline"
                  size="sm"
                >
                  대화상자 열기
                </Button>
              </DialogTrigger>
              <OverlayCell
                portalExport="DialogPortal"
                className="mt-2 w-max max-w-full p-8"
              >
                {(host) => (
                  <>
                    <div
                      data-gallery-export="DialogOverlay"
                      data-gallery-replica="DialogOverlay"
                      className="absolute inset-0 bg-scrim"
                    />
                    <DialogContent
                      container={host}
                      className="relative left-auto top-auto w-pane-md translate-x-0 gap-4 p-4"
                      data-gallery-export="DialogContent"
                      onOpenAutoFocus={preventAutoFocus}
                    >
                    <DialogTitle data-gallery-export="DialogTitle">
                      채널을 지울까요
                    </DialogTitle>
                    <DialogDescription data-gallery-export="DialogDescription">
                      {GALLERY_TEXT_FIXTURE}
                    </DialogDescription>
                    <div className="flex justify-end">
                      <DialogClose asChild>
                        <Button
                          data-gallery-export="DialogClose"
                          type="button"
                          variant="outline"
                          size="sm"
                        >
                          닫기
                        </Button>
                      </DialogClose>
                    </div>
                    </DialogContent>
                  </>
                )}
              </OverlayCell>
            </Dialog>
          </Export>
        </div>

        <div className="flex w-max max-w-full flex-col gap-2">
          <p className="text-meta text-ink-muted">DropdownMenu</p>
          <Export name="DropdownMenu">
            <DropdownMenu open modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  data-gallery-export="DropdownMenuTrigger"
                  type="button"
                  variant="outline"
                  size="sm"
                >
                  메뉴 열기
                </Button>
              </DropdownMenuTrigger>
              <OverlayCell className="mt-2 w-max max-w-full">
                {(host) => (
                  <DropdownMenuContent
                    container={host}
                    align="start"
                    data-gallery-export="DropdownMenuContent"
                    onOpenAutoFocus={preventAutoFocus}
                  >
                    <DropdownMenuLabel data-gallery-export="DropdownMenuLabel">
                      채널 동작
                    </DropdownMenuLabel>
                    <DropdownMenuGroup data-gallery-export="DropdownMenuGroup">
                      <DropdownMenuItem data-gallery-export="DropdownMenuItem">
                        이름 바꾸기
                      </DropdownMenuItem>
                      <DropdownMenuSeparator data-gallery-export="DropdownMenuSeparator" />
                    </DropdownMenuGroup>
                    <DropdownMenuRadioGroup
                      data-gallery-export="DropdownMenuRadioGroup"
                      value="unread"
                    >
                      <DropdownMenuRadioItem
                        data-gallery-export="DropdownMenuRadioItem"
                        value="unread"
                      >
                        안 읽은 것만
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                )}
              </OverlayCell>
            </DropdownMenu>
          </Export>
        </div>

        <div className="flex w-max max-w-full flex-col gap-2">
          <p className="text-meta text-ink-muted">Popover</p>
          <Export name="Popover">
            <Popover open modal={false}>
              <PopoverAnchor asChild>
                <span data-gallery-export="PopoverAnchor">
                  <PopoverTrigger asChild>
                    <Button
                      data-gallery-export="PopoverTrigger"
                      type="button"
                      variant="outline"
                      size="sm"
                    >
                      패널 열기
                    </Button>
                  </PopoverTrigger>
                </span>
              </PopoverAnchor>
              <OverlayCell
                portalExport="PopoverPortal"
                className="mt-2 w-max max-w-full"
              >
                {(host) => (
                  <PopoverContent
                    container={host}
                    align="start"
                    data-gallery-export="PopoverContent"
                    onOpenAutoFocus={preventAutoFocus}
                  >
                    <p className="text-body">{GALLERY_TEXT_FIXTURE}</p>
                    <PopoverClose asChild>
                      <Button
                        data-gallery-export="PopoverClose"
                        type="button"
                        variant="outline"
                        size="sm"
                      >
                        닫기
                      </Button>
                    </PopoverClose>
                  </PopoverContent>
                )}
              </OverlayCell>
            </Popover>
          </Export>
        </div>

        <div className="flex w-max max-w-full flex-col gap-2">
          <p className="text-meta text-ink-muted">ContextMenu</p>
          <Export name="ContextMenu">
            <ContextMenuSpecimen />
          </Export>
        </div>
      </div>
    </section>
  );
}

function ContextMenuSpecimen() {
  return (
    <ContextMenu open modal={false}>
      <ContextMenuTrigger asChild>
        <Button
          data-gallery-export="ContextMenuTrigger"
          type="button"
          variant="outline"
          size="sm"
        >
          우클릭 메뉴
        </Button>
      </ContextMenuTrigger>
      <OverlayCell className="mt-2 w-max max-w-full">
        {(host) => (
          <ContextMenuContent
            container={host}
            data-gallery-export="ContextMenuContent"
            onOpenAutoFocus={preventAutoFocus}
          >
            <ContextMenuLabel data-gallery-export="ContextMenuLabel">
              메시지
            </ContextMenuLabel>
            <ContextMenuItem data-gallery-export="ContextMenuItem">
              답글
            </ContextMenuItem>
            <ContextMenuSeparator data-gallery-export="ContextMenuSeparator" />
            <ContextMenuRadioGroup
              data-gallery-export="ContextMenuRadioGroup"
              value="keep"
            >
              <ContextMenuRadioItem
                data-gallery-export="ContextMenuRadioItem"
                value="keep"
              >
                유지
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuContent>
        )}
      </OverlayCell>
    </ContextMenu>
  );
}

function GalleryBody() {
  const directory = useMemo(() => makeDirectory([galleryMember()]), []);
  const message = useMemo(() => galleryMessage(), []);
  const chips: ReactionChip[] = useMemo(
    () => [
      {
        emoji: "👍",
        count: 3,
        mine: true,
        memberIds: [MEMBER_ID],
      },
    ],
    []
  );

  return (
    <div
      data-testid="design-gallery"
      data-gallery-root=""
      className="h-full min-h-0 overflow-y-auto bg-surface p-6 text-ink"
    >
      <header className="flex flex-col gap-4 border-b border-line pb-6">
        <h1 className="text-display font-medium">디자인 갤러리</h1>
        <p className="max-w-pane-lg text-body text-ink-muted">
          {GALLERY_TEXT_FIXTURE}
        </p>
        <SchemeToggle />
      </header>

      <section
        data-testid="press-triplet-root"
        className="flex flex-col gap-4 border-b border-line py-6"
      >
        <h2 className="text-title font-medium text-ink">눌림 3짝</h2>
        <p className="text-meta text-ink-muted">
          캡처 레인이 갤러리 프리미티브와 제품 행의 정지, 가리킴, 눌림을 찍는다.
          미리보기 속성이 아니라 포인터 상태다.
        </p>
        <div className="flex flex-wrap items-start gap-4">
          <figure
            data-testid="press-triplet-button-default"
            className="inline-flex bg-surface p-6"
          >
            <Button type="button" variant="default">
              변경 저장
            </Button>
          </figure>
          <figure
            data-testid="press-triplet-button-secondary"
            className="inline-flex bg-surface p-6"
          >
            <Button type="button" variant="secondary">
              취소
            </Button>
          </figure>
          <figure
            data-testid="press-triplet-button-ghost"
            className="inline-flex bg-surface p-6"
          >
            <Button type="button" variant="ghost">
              닫기
            </Button>
          </figure>
          <figure
            data-testid="press-triplet-button-destructive"
            className="inline-flex bg-surface p-6"
          >
            <Button type="button" variant="destructive">
              지우기
            </Button>
          </figure>
          <figure
            data-testid="press-triplet-row"
            className="min-w-action bg-surface p-6"
          >
            <ul>
              <SidebarRow
                to="/c/gallery-press-triplet"
                icon={<Hash className="size-4" />}
                label="릴리스 노트"
                testId="press-triplet-row-link"
                wrapLink={(link) =>
                  cloneElement(link, {
                    onClick: (event: { preventDefault: () => void }) => {
                      event.preventDefault();
                    },
                  })
                }
              />
            </ul>
          </figure>
          <figure
            data-testid="press-triplet-chip"
            className="inline-flex bg-surface p-6"
          >
            <ReactionChips
              chips={[
                {
                  emoji: "👍",
                  count: 2,
                  mine: false,
                  memberIds: [MEMBER_ID],
                },
              ]}
              directory={directory}
              myMemberId={MEMBER_ID}
              onToggle={() => undefined}
            />
          </figure>
          <figure
            data-testid="press-triplet-message-row"
            className="w-full bg-surface"
          >
            <MessageRow
              message={message}
              startsGroup
              directory={directory}
            />
          </figure>
          <figure
            data-testid="press-triplet-pending-row"
            className="w-full bg-surface"
          >
            <PendingRow
              pending={galleryPending()}
              startsGroup
              directory={directory}
            />
          </figure>
          <figure
            data-testid="press-triplet-settings-row"
            className="w-full bg-surface"
          >
            <SettingsToggleRow
              testId="press-triplet-settings-toggle"
              name="알림"
              description="멘션이 오면 알려 준다."
              checked={false}
              onToggle={() => undefined}
            />
          </figure>
          <figure
            data-testid="press-triplet-settings-row-checked"
            className="w-full bg-surface"
          >
            <SettingsToggleRow
              testId="press-triplet-settings-toggle-checked"
              name="방해 금지"
              description="정해 둔 시간에는 알림을 끊는다."
              checked={true}
              onToggle={() => undefined}
            />
          </figure>
          <figure
            data-testid="press-triplet-drafts-li"
            className="w-full bg-surface"
          >
            <ul>
              <DraftRow
                item={galleryDraft()}
                nowMs={1_800_000_000_000}
                onDelete={() => undefined}
                onCloseAutoFocus={() => undefined}
                onClick={(event) => event.preventDefault()}
              />
            </ul>
          </figure>
          <figure
            data-testid="press-triplet-summary-card"
            className="w-full bg-surface p-6"
          >
            <details className={SETTINGS_COLLAPSIBLE_CARD_CLASS}>
              <summary className={SETTINGS_COLLAPSIBLE_SUMMARY_CLASS}>
                기간별로 자세히 보기
              </summary>
            </details>
          </figure>
        </div>
      </section>

      <StateRow
        title="Button"
        states={BUTTON_STATES}
        note="busy는 aria-busy만 있고 시각 유틸이 없다."
      >
        {(state) => (
          <Export name="Button">
            <Button type="button" variant="secondary" {...controlProps(state)}>
              변경 저장
            </Button>
          </Export>
        )}
      </StateRow>

      <StateRow
        title="Input"
        states={FIELD_STATES}
        note="hover·active·busy 시각 상태가 없다."
      >
        {(state) => (
          <Export name="Input">
            <Input
              defaultValue={GALLERY_TEXT_FIXTURE}
              aria-label="갤러리 입력"
              {...controlProps(state)}
            />
          </Export>
        )}
      </StateRow>

      <StateRow
        title="Select"
        states={FIELD_STATES}
        note="hover·active·busy 시각 상태가 없다."
      >
        {(state) => (
          <Export name="Select">
            <Select aria-label="갤러리 선택" {...controlProps(state)} defaultValue="hermes">
              <option value="hermes">hermes-agent</option>
              <option value="mini">hermes-agent-mini</option>
            </Select>
          </Export>
        )}
      </StateRow>

      <section className="flex flex-col gap-3 border-b border-line py-6">
        <h2 className="text-title font-medium text-ink">Card</h2>
        <p className="text-meta text-ink-muted">
          hover·active·focus·disabled·busy 시각 상태가 없다.
        </p>
        <Export name="Card">
          <Card>
            <Export name="CardHeader">
              <CardHeader>
                <Export name="CardTitle">
                  <CardTitle>작업 세션</CardTitle>
                </Export>
                <Export name="CardDescription">
                  <CardDescription>{GALLERY_TEXT_FIXTURE}</CardDescription>
                </Export>
              </CardHeader>
            </Export>
            <Export name="CardContent">
              <CardContent>
                <p className="text-body">seq 4082</p>
              </CardContent>
            </Export>
          </Card>
        </Export>
      </section>

      <StateRow
        title="SidebarRow"
        states={SIDEBAR_STATES}
        note="disabled·busy 없음. unread 배지는 busy가 아니다."
      >
        {(state) => (
          <ul>
            <SidebarRow
              to="/c/gallery"
              icon={<Hash className="size-4" />}
              label="릴리스 노트"
              dataAttrs={{
                ...(previewOf(state) ? { "data-gallery-preview": previewOf(state)! } : {}),
              }}
            />
          </ul>
        )}
      </StateRow>

      <section className="flex flex-col gap-3 border-b border-line py-6">
        <h2 className="text-title font-medium text-ink">MessageRow</h2>
        <StampPreview preview="hover" selector="[data-testid=timeline-message]">
          <MessageRow message={message} startsGroup directory={directory} />
        </StampPreview>
      </section>

      <StateRow title="ReactionChips" states={CHIP_STATES}>
        {(state) => (
          <StampPreview
            preview={previewOf(state)}
            selector='[data-testid="reaction-chip"]'
          >
            <ReactionChips
              chips={chips}
              directory={directory}
              myMemberId={MEMBER_ID}
              onToggle={() => undefined}
              onOpenPicker={state === "focus" ? undefined : () => undefined}
              disabled={state === "disabled"}
            />
          </StampPreview>
        )}
      </StateRow>

      <section className="flex flex-col gap-3 border-b border-line py-6">
        <h2 className="text-title font-medium text-ink">칩 그릇</h2>
        <div className="flex flex-wrap gap-2">
          <span className={cn(CHIP_CLASS, "bg-muted-soft text-ink-muted")}>원장</span>
          <span className={cn(CHIP_CLASS, "bg-ok-soft text-ok")}>통과</span>
          <span className={cn(CHIP_CLASS, "bg-warn-soft text-warn")}>주의</span>
          <span className={cn(CHIP_CLASS, "bg-danger-soft text-danger")}>실패</span>
        </div>
      </section>

      <section className="flex flex-col gap-3 border-b border-line py-6">
        <h2 className="text-title font-medium text-ink">States</h2>
        <InlineBanner
          tone="error"
          message="seq 4082 로그를 읽지 못했습니다. 다시 시도하세요."
          actionLabel="다시 시도"
          onAction={() => undefined}
        />
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 캐시된 내용은 그대로 둡니다."
        />
        <Skeleton ready={false} rows={3} />
        <EmptyInvite
          headline="아직 메시지가 없습니다"
          detail={GALLERY_TEXT_FIXTURE}
          actions={
            <Button type="button" variant="default">
              첫 메시지 쓰기
            </Button>
          }
        />
      </section>

      <OverlayExamples />

      <section className="flex flex-col gap-3 border-b border-line py-6">
        <h2 className="text-title font-medium text-ink">press · motion · elevation</h2>
        <p className="text-meta text-ink-muted">
          이 캡처는 prefers-reduced-motion: reduce다. ADR-0179 D9가 사다리 4단을
          끄므로 아래 칸은 정지 상태다.
        </p>
        <div className="flex flex-wrap gap-4">
          {MOTION_VOCABULARY.map((name) =>
            name === "press" ? (
              <figure key={name} className="flex min-w-action-sm flex-col gap-2">
                <figcaption className="text-meta text-ink-muted">{name}</figcaption>
                <Button type="button" variant="secondary" data-gallery-preview="active">
                  눌림
                </Button>
              </figure>
            ) : name === "press-instant-fill" ? (
              <figure key={name} className="flex min-w-action-sm flex-col gap-2">
                <figcaption className="text-meta text-ink-muted">{name}</figcaption>
                <button
                  type="button"
                  className="rounded-sm border border-line-strong px-3 py-2 text-meta text-ink press-instant-fill"
                >
                  {name}
                </button>
              </figure>
            ) : name === "scrim-press" ? (
              <figure key={name} className="flex min-w-action-sm flex-col gap-2">
                <figcaption className="text-meta text-ink-muted">{name}</figcaption>
                <button
                  type="button"
                  className="rounded-sm border border-line-strong px-3 py-2 text-meta text-ink scrim-press"
                >
                  {name}
                </button>
              </figure>
            ) : (
              <figure key={name} className="flex min-w-action-sm flex-col gap-2">
                <figcaption className="text-meta text-ink-muted">{name}</figcaption>
                <div
                  className={cn(
                    "rounded-md border border-line bg-surface-raised p-4 text-meta",
                    !MOTION_EXIT.has(name) && name
                  )}
                >
                  {name}
                </div>
              </figure>
            )
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3 py-6">
        <h2 className="text-title font-medium text-ink">NOTES</h2>
        <ul className="flex max-w-pane-lg list-disc flex-col gap-1 pl-6 text-body text-ink-muted">
          <li>Card, Input, Select는 hover·active·busy 시각 상태가 없다.</li>
          <li>SidebarRow는 disabled·busy가 없다. unread 배지는 busy가 아니다.</li>
          <li>Button busy는 aria-busy만 있고 시각 유틸이 없다.</li>
          <li>
            DialogPortal·PopoverPortal은 목적지 칸이다. 포털 자체는 상자가 없다.
          </li>
          <li>
            스크림은 갤러리 대역이다. 모달을 끄면 프리미티브는 스크림을 그리지
            않는다.
          </li>
        </ul>
      </section>
    </div>
  );
}

export function Gallery() {
  const session = useMemo(() => gallerySession(), []);
  return (
    <QueryClientProvider client={galleryQuery}>
      <SessionProvider value={session}>
        <OpenMemberProfileContext.Provider value={() => undefined}>
          <GalleryBody />
        </OpenMemberProfileContext.Provider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
