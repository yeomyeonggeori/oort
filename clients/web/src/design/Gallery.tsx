import { forwardRef, useMemo, type ReactNode } from "react";
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
  DialogOverlay,
  DialogPortal,
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
  PopoverPortal,
  PopoverTrigger,
} from "@/design/ui/popover";
import { Select } from "@/design/ui/select";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { SidebarRow } from "@/features/sidebar/SidebarRow";
import { MessageRow } from "@/features/timeline/MessageRow";
import { ReactionChips } from "@/features/timeline/ReactionChips";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { Message, RosterMember } from "@momo/core/lib/api";
import type { ReactionChip } from "@momo/core/features/timeline/reactions";

// Reading this as: design gallery (diagnostic surface) for internal team users
// on web+Tauri, density 6/10, motion 2/10.

/** 한국어·영문·숫자·이모지 혼합, 80자 상한 경계. */
export const GALLERY_TEXT_FIXTURE =
  "릴리스 노트 v0.1.4: 배포 12회 중 3회가 롤백됐다. seq 4082 로그를 같이 보자 🔥 ship-notes ok 12 오늘 확정했다.";

const INTERACTION_STATES = [
  "rest",
  "hover",
  "active",
  "focus",
  "disabled",
  "busy",
] as const;
type InteractionState = (typeof INTERACTION_STATES)[number];

const MOTION_VOCABULARY = [
  "press",
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
    "data-preview": previewOf(state),
    disabled: state === "disabled" ? true : undefined,
    "aria-busy": state === "busy" ? true : undefined,
  };
}

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
  children,
}: {
  title: string;
  children: (state: InteractionState) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-6">
      <h2 className="text-title font-medium text-ink">{title}</h2>
      <div className="flex flex-wrap gap-4">
        {INTERACTION_STATES.map((state) => (
          <figure key={state} className="flex min-w-pane-sm flex-col gap-2">
            <figcaption className="text-meta text-ink-muted">{state}</figcaption>
            <div data-preview={previewOf(state)}>{children(state)}</div>
          </figure>
        ))}
      </div>
    </section>
  );
}

function FloatPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-pane-sm flex-col gap-2">
      <p className="text-meta text-ink-muted">{title}</p>
      <div className="rounded-lg border border-line bg-surface-raised p-3 text-ink shadow-lg">
        {children}
      </div>
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
        패널은 elevation-float (`shadow-lg`). 캡처가 실제 열림을 만들고, 여기서는
        트리거와 같은 클래스의 정적 판을 둔다.
      </p>
      <div className="flex flex-wrap gap-4">
        <FloatPanel title="Dialog">
          <Export name="Dialog">
            <Dialog>
              <Export name="DialogTrigger">
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    대화상자 열기
                  </Button>
                </DialogTrigger>
              </Export>
            </Dialog>
          </Export>
          <p className="text-title font-semibold text-ink">채널을 지울까요</p>
          <p className="text-body text-ink-muted">{GALLERY_TEXT_FIXTURE}</p>
        </FloatPanel>
        <FloatPanel title="DropdownMenu">
          <Export name="DropdownMenu">
            <DropdownMenu>
              <Export name="DropdownMenuTrigger">
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    메뉴 열기
                  </Button>
                </DropdownMenuTrigger>
              </Export>
            </DropdownMenu>
          </Export>
          <p className="text-meta font-medium text-ink-muted">채널 동작</p>
          <p className="text-body">이름 바꾸기</p>
        </FloatPanel>
        <FloatPanel title="Popover">
          <Export name="Popover">
            <Popover>
              <Export name="PopoverAnchor">
                <PopoverAnchor asChild>
                  <span>
                    <Export name="PopoverTrigger">
                      <PopoverTrigger asChild>
                        <Button type="button" variant="outline" size="sm">
                          패널 열기
                        </Button>
                      </PopoverTrigger>
                    </Export>
                  </span>
                </PopoverAnchor>
              </Export>
            </Popover>
          </Export>
        </FloatPanel>
        <FloatPanel title="ContextMenu">
          <Export name="ContextMenu">
            <ContextMenu>
              <Export name="ContextMenuTrigger">
                <ContextMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    우클릭 메뉴
                  </Button>
                </ContextMenuTrigger>
              </Export>
            </ContextMenu>
          </Export>
          <p className="text-meta font-medium text-ink-muted">메시지</p>
          <p className="text-body">답글</p>
        </FloatPanel>
      </div>
      <div className="sr-only">
        <Dialog>
          <Export name="DialogPortal">
            <DialogPortal />
          </Export>
          <Export name="DialogOverlay">
            <DialogOverlay />
          </Export>
        </Dialog>
        <Export name="DialogContent">
          <Dialog>
            <DialogContent>
              <DialogTitle>채널을 지울까요</DialogTitle>
              <DialogDescription>{GALLERY_TEXT_FIXTURE}</DialogDescription>
              <DialogClose asChild>
                <Button type="button">닫기</Button>
              </DialogClose>
            </DialogContent>
          </Dialog>
        </Export>
        <Export name="DialogTitle">
          <span>DialogTitle</span>
        </Export>
        <Export name="DialogDescription">
          <span>DialogDescription</span>
        </Export>
        <Export name="DialogClose">
          <span>DialogClose</span>
        </Export>
        <Export name="DropdownMenuContent">
          <DropdownMenu>
            <DropdownMenuContent>
              <DropdownMenuLabel>채널 동작</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem>이름 바꾸기</DropdownMenuItem>
                <DropdownMenuSeparator />
              </DropdownMenuGroup>
              <DropdownMenuRadioGroup value="unread">
                <DropdownMenuRadioItem value="unread">안 읽은 것만</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </Export>
        <Export name="DropdownMenuLabel">
          <span>DropdownMenuLabel</span>
        </Export>
        <Export name="DropdownMenuGroup">
          <span>DropdownMenuGroup</span>
        </Export>
        <Export name="DropdownMenuItem">
          <span>DropdownMenuItem</span>
        </Export>
        <Export name="DropdownMenuSeparator">
          <span>DropdownMenuSeparator</span>
        </Export>
        <Export name="DropdownMenuRadioGroup">
          <span>DropdownMenuRadioGroup</span>
        </Export>
        <Export name="DropdownMenuRadioItem">
          <span>DropdownMenuRadioItem</span>
        </Export>
        <Popover>
          <Export name="PopoverPortal">
            <PopoverPortal />
          </Export>
        </Popover>
        <Export name="PopoverContent">
          <Popover>
            <PopoverContent>
              <PopoverClose asChild>
                <Button type="button">닫기</Button>
              </PopoverClose>
            </PopoverContent>
          </Popover>
        </Export>
        <Export name="PopoverClose">
          <span>PopoverClose</span>
        </Export>
        <Export name="ContextMenuContent">
          <ContextMenu>
            <ContextMenuContent>
              <ContextMenuLabel>메시지</ContextMenuLabel>
              <ContextMenuItem>답글</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuRadioGroup value="keep">
                <ContextMenuRadioItem value="keep">유지</ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuContent>
          </ContextMenu>
        </Export>
        <Export name="ContextMenuLabel">
          <span>ContextMenuLabel</span>
        </Export>
        <Export name="ContextMenuItem">
          <span>ContextMenuItem</span>
        </Export>
        <Export name="ContextMenuSeparator">
          <span>ContextMenuSeparator</span>
        </Export>
        <Export name="ContextMenuRadioGroup">
          <span>ContextMenuRadioGroup</span>
        </Export>
        <Export name="ContextMenuRadioItem">
          <span>ContextMenuRadioItem</span>
        </Export>
      </div>
    </section>
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
      className="min-h-full bg-surface p-6 text-ink"
    >
      <header className="flex flex-col gap-4 border-b border-line pb-6">
        <h1 className="text-display font-medium">디자인 갤러리</h1>
        <p className="max-w-pane-lg text-body text-ink-muted">
          {GALLERY_TEXT_FIXTURE}
        </p>
        <SchemeToggle />
      </header>

      <StateRow title="Button">
        {(state) => (
          <Export name="Button">
            <Button type="button" variant="secondary" {...controlProps(state)}>
              변경 저장
            </Button>
          </Export>
        )}
      </StateRow>

      <StateRow title="Input">
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

      <StateRow title="Select">
        {(state) => (
          <Export name="Select">
            <Select aria-label="갤러리 선택" {...controlProps(state)} defaultValue="hermes">
              <option value="hermes">hermes-agent</option>
              <option value="mini">hermes-agent-mini</option>
            </Select>
          </Export>
        )}
      </StateRow>

      <StateRow title="Card">
        {(state) => (
          <Export name="Card">
            <Card data-preview={previewOf(state)}>
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
        )}
      </StateRow>

      <StateRow title="SidebarRow">
        {(state) => (
          <ul>
            <SidebarRow
              to="/c/gallery"
              icon={<Hash className="size-4" />}
              label="릴리스 노트"
              unreadCount={state === "busy" ? 12 : 0}
              dataAttrs={{
                ...(previewOf(state) ? { "data-preview": previewOf(state)! } : {}),
              }}
            />
          </ul>
        )}
      </StateRow>

      <section className="flex flex-col gap-3 border-b border-line py-6">
        <h2 className="text-title font-medium text-ink">MessageRow</h2>
        <div data-preview="hover">
          <MessageRow
            message={message}
            startsGroup
            directory={directory}
          />
        </div>
      </section>

      <StateRow title="ReactionChips">
        {(state) => (
          <ReactionChips
            chips={chips}
            directory={directory}
            myMemberId={MEMBER_ID}
            onToggle={() => undefined}
            onOpenPicker={() => undefined}
            disabled={state === "disabled"}
          />
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
        <SkeletonRows rows={3} />
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

      <section className="flex flex-col gap-3 py-6">
        <h2 className="text-title font-medium text-ink">press · motion · elevation</h2>
        <div className="flex flex-wrap gap-4">
          {MOTION_VOCABULARY.map((name) =>
            name === "press" ? (
              <figure key={name} className="flex min-w-action-sm flex-col gap-2">
                <figcaption className="text-meta text-ink-muted">{name}</figcaption>
                <Button type="button" variant="secondary" data-preview="active">
                  눌림
                </Button>
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
