import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import type { Channel } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { channelNameIssue, normalizeChannelName } from "@momo/core/features/channels/model";
import type { ChannelRenameFailure } from "@momo/core/features/channels/rename";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { ChannelNameField, useChannelNameField } from "./ChannelNameField";
import { useRenameChannel } from "./useRenameChannel";

// =============================================================================
// 채널 이름 바꾸기 창 (ADR-0225 D10 · D13, #5835). 채널 머리 ⋮ 메뉴의 「이름 바꾸기」가 연다(소유자 · 관리자에게만, `general` 에는 서지
// 않는다 — 코어 `canRenameChannel`). 이름 칸은 채널 만들기 창과 **같은 칸**(`ChannelNameField`)이다: 안내 글 · 친 그대로 · 친 것과
// 저장될 이름이 다를 때만 아래에 「#… 이름으로 바뀌어요」 · 거절 문장 · 자리 예약 · 조합 중 얼리기.
//
// 거절은 모두 칸 아래 같은 자리에서 말한다(409 `general` 잠금 · 409 겹침 · 404 · 403 · 400 · 429 · 망). 성공하면 응답의 `channel` 로
// 캐시를 고쳐(`useRenameChannel`) 사이드바와 채널 머리에 바로 새 이름이 서고 창이 닫힌다.
// =============================================================================

const FORM_ID = "rename-channel-form";
const FIELD_ID = "rename-channel-name";

export function RenameChannelDialog({
  workspaceId,
  channel,
  open,
  onOpenChange,
  opener,
}: {
  workspaceId: string;
  channel: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener?: DialogFocusTarget | null;
}) {
  const rename = useRenameChannel(workspaceId);
  const { clearFailure } = rename;
  // 닫히면 앞 거절은 다음 열기까지 따라오지 않는다.
  useEffect(() => {
    if (!open) clearFailure();
  }, [open, clearFailure]);
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !rename.pending) && onOpenChange(next)}>
      <DialogContent
        opener={opener}
        data-testid="rename-channel-dialog"
        onEscapeKeyDown={(event) => {
          if (rename.pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (rename.pending) event.preventDefault();
        }}
      >
        <RenameForm channel={channel} rename={rename} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  channel,
  rename,
  onClose,
}: {
  channel: Channel;
  rename: ReturnType<typeof useRenameChannel>;
  onClose: () => void;
}) {
  const formatMessage = useFormatMessage();
  const { pending, failure, clearFailure } = rename;
  const current = channel.name ?? "";
  // 이 폼은 창이 열릴 때마다 새로 서므로 지금 이름이 채워진 채로 시작한다(앞 시도의 글이 따라오지 않는다).
  const [name, setName] = useState(current);
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // 열리면 칸에 초점, 지금 이름 전체 선택(바로 새 이름을 덮어쓸 수 있게).
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const failureText = (f: ChannelRenameFailure) => formatMessage(f.key, f.values as never);
  const serverError = failure ? failureText(failure) : null;
  const nameField = useChannelNameField({
    name,
    attempted: false,
    serverError,
    previewKey: "channels.rename.preview",
    // 이 자리에 설 수 있는 이 창만의 문장. 망 문장은 전송 계층의 실제 문장(가장 긴 시간 초과)으로 자리를 잡는다.
    reserveExtra: [
      formatMessage("channels.rename.generalLocked"),
      formatMessage("channels.rename.notFound"),
      formatMessage("channels.rename.forbidden"),
      formatMessage("channels.rename.generic"),
      formatMessage("channels.rename.network", { reason: new NetworkError("timeout", 15_000).message }),
      formatMessage("channels.createFailure.rateLimited"),
    ],
  });

  const issue = channelNameIssue(name);
  const saved = issue === null ? normalizeChannelName(name) : null;
  // 이름이 그대로거나 거절이면 보낼 것이 없다(칸이 이유를 말한다).
  const unchanged = saved === current;
  const blocked = issue !== null || unchanged;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    nameField.thaw();
    if (nameField.frozen || pending || blocked || saved === null) return;
    const done = await rename.rename(channel.id, saved);
    if (done) onClose();
  }

  const busyTitle = formatMessage("channels.rename.busy");
  return (
    <>
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>{formatMessage("channels.rename.title")}</DialogTitle>
        <DialogDescription>{formatMessage("channels.rename.description")}</DialogDescription>
      </div>
      <form
        id={FORM_ID}
        ref={formRef}
        onSubmit={submit}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        onKeyDown={(event) => {
          if (PRIMARY_ACTION_SHORTCUT.matches(event)) {
            event.preventDefault();
            formRef.current?.requestSubmit();
          }
        }}
      >
        <ChannelNameField
          id={FIELD_ID}
          label={formatMessage("channels.rename.fieldLabel")}
          placeholder={formatMessage("channels.nameRule.placeholder")}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            clearFailure();
          }}
          field={nameField}
          inputRef={nameRef}
          disabled={pending}
        />
      </form>
      <div className="flex items-center justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onClose}
          data-testid="rename-channel-cancel"
        >
          {formatMessage("channels.rename.cancel")}
        </Button>
        <Button
          type="submit"
          form={FORM_ID}
          size="sm"
          disabled={blocked || nameField.frozen}
          aria-busy={pending || undefined}
          data-testid="rename-channel-submit"
        >
          {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {pending ? busyTitle : formatMessage("channels.rename.submit")}
        </Button>
      </div>
    </>
  );
}
