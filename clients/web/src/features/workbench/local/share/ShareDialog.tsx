import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { ChoiceRadios, type RadioChoice } from "@/features/settings/SettingsFields";
import { SHARE_NAME_MAX, type HostReadiness, type PaneShare, type SharePrepared, type ShareRefusal } from "./paneShare";
import { refusalLine, SHARE_COPY } from "./shareCopy";

// Reading this as: 「채널에 공유」 창 for internal team users on Tauri desktop,
// density 6/10, motion 0/10.
//
// 한 창이 두 입구를 받는다(#2867, Q5): 「채널에 공유」는 곧장 채널을 고르고, 「링크 복사」는
// 공유가 꺼져 있으면 「이 세션을 공유할까요?」를 먼저 묻는다. 둘 다 같은 한 동작(공유 켜기 +
// 집 채널 + root 카드)으로 끝난다. 거절하면 아무것도 만들지 않는다.
// 이 맥이 작업 호스트로 등록되지 않았으면 채널 선택 대신 등록으로 가는 길을 보인다.

export interface ShareChannelOption {
  id: string;
  name: string;
  kind: "public" | "private";
}

export type ShareIntent = "share" | "copy";

/** 서버·셸이 호스트 문제라고 답한 거절은 창을 등록 안내로 바꾼다. */
const HOST_OF_REFUSAL: Partial<Record<ShareRefusal, HostReadiness>> = {
  host_not_registered: "not_registered",
  host_not_running: "not_running",
  host_elsewhere: "elsewhere",
  no_shell: "no_shell",
};

export function ShareDialog({
  share,
  paneId,
  intent,
  channels,
  onClose,
  onShared,
  onOpenHostSettings,
}: {
  share: PaneShare;
  paneId: string;
  intent: ShareIntent;
  channels: readonly ShareChannelOption[];
  onClose: () => void;
  /** 공유가 켜졌다. `intent`가 copy면 호스트가 링크를 복사한다. */
  onShared: (intent: ShareIntent, channelName: string | null) => void;
  onOpenHostSettings: () => void;
}) {
  const [prep, setPrep] = useState<SharePrepared | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ShareRefusal | null>(null);
  /** 칸을 확인하지 못했다(셸이 답하지 않음). 「다시 확인」으로 한 번 더 읽는다. */
  const [prepError, setPrepError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** 팀에 보일 세션 이름. 주인이 정한다(ADR-0190 D4-b): 이 칸의 기본 이름을 채워 두고 고칠 수 있다. */
  const [name, setName] = useState("");
  const nameId = useId();

  useEffect(() => {
    let alive = true;
    setPrep(null);
    setPrepError(false);
    void share.prepare(paneId).then(
      (next) => {
        if (!alive) return;
        setPrep(next);
        setName(next.name);
        setPick(next.lockedChannelId ?? next.defaultChannelId);
      },
      () => {
        if (alive) setPrepError(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [share, paneId, attempt]);

  const choices = useMemo<RadioChoice[]>(
    () =>
      channels.map((c) => ({
        id: c.id,
        label: `#${c.name}`,
        detail:
          prep?.defaultChannelId === c.id
            ? SHARE_COPY.pickerLast
            : c.kind === "private"
              ? SHARE_COPY.channelPrivate
              : SHARE_COPY.channelPublic,
      })),
    [channels, prep?.defaultChannelId]
  );
  const nameOf = (id: string | null) => channels.find((c) => c.id.toLowerCase() === id?.toLowerCase())?.name ?? null;

  const hostBlocked = prep !== null && prep.host !== "ready";
  const locked = prep?.lockedChannelId ?? null;
  const title = intent === "copy" ? SHARE_COPY.copyTitle : SHARE_COPY.shareTitle;
  const lead = intent === "copy" ? SHARE_COPY.copyLead : SHARE_COPY.shareLead;
  const hostLine =
    prep?.host === "not_running"
      ? SHARE_COPY.hostNotRunning
      : prep?.host === "elsewhere"
        ? SHARE_COPY.hostElsewhere
        : prep?.host === "no_shell"
          ? SHARE_COPY.hostNoShell
          : SHARE_COPY.hostNotRegistered;
  const canSubmit = prep !== null && !hostBlocked && (locked !== null || (pick !== null && name.trim() !== "")) && !busy;

  const submit = async () => {
    const channelId = locked ?? pick;
    if (!channelId) return;
    setBusy(true);
    setRefusal(null);
    const result = await share.share(paneId, channelId, locked === null ? name : undefined);
    setBusy(false);
    if (result.ok) {
      onShared(intent, nameOf(channelId));
      onClose();
    } else {
      setRefusal(result.reason);
      // 호스트가 막혔다고 서버가 말해 주면 다음 줄은 등록 안내로 바뀐다.
      const blocked = HOST_OF_REFUSAL[result.reason];
      if (blocked) setPrep((p) => (p ? { ...p, host: blocked } : p));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="gap-4 p-4" data-testid="share-dialog" data-intent={intent}>
        <div className="flex flex-col gap-1">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{lead}</DialogDescription>
        </div>
        {prepError ? (
          <p role="alert" className="text-body text-ink" data-testid="share-dialog-prepare-error">
            {SHARE_COPY.prepareFailed}
          </p>
        ) : prep === null ? (
          <p role="status" className="text-body text-ink-muted" data-testid="share-dialog-preparing">
            {SHARE_COPY.preparing}
          </p>
        ) : hostBlocked ? (
          <p role="status" className="text-body text-ink" data-testid="share-dialog-host">
            {hostLine}
          </p>
        ) : locked !== null ? (
          <p className="text-body text-ink" data-testid="share-dialog-locked">
            {SHARE_COPY.lockedHome(nameOf(locked) ?? "채널")}
          </p>
        ) : choices.length === 0 ? (
          <p role="status" className="text-body text-ink-muted" data-testid="share-dialog-no-channels">
            {SHARE_COPY.noChannels}
          </p>
        ) : (
          <div className="max-h-60 overflow-y-auto" data-testid="share-dialog-channels">
            <ChoiceRadios
              name="share-channel"
              legend={SHARE_COPY.pickerLegend}
              choices={choices}
              value={pick ?? ""}
              onChange={setPick}
              busy={busy}
              hint={pick === null ? SHARE_COPY.pickerFirst : undefined}
            />
          </div>
        )}
        {prep !== null && !hostBlocked && locked === null && !prepError ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-meta text-ink-muted">
              {SHARE_COPY.nameLabel}
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={SHARE_NAME_MAX}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              data-testid="share-dialog-name"
            />
            <p className="text-meta text-ink-muted">{SHARE_COPY.nameHint}</p>
          </div>
        ) : null}
        <p className="text-meta text-ink-muted">{SHARE_COPY.never}</p>
        {refusal && !hostBlocked ? (
          <p role="alert" className="text-body text-danger" data-testid="share-dialog-error">
            {refusalLine(refusal)}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {SHARE_COPY.cancel}
          </Button>
          {prepError ? (
            <Button type="button" size="sm" data-testid="share-dialog-retry" onClick={() => setAttempt((n) => n + 1)}>
              {SHARE_COPY.prepareRetry}
            </Button>
          ) : hostBlocked && prep?.host !== "no_shell" ? (
            <Button type="button" size="sm" data-testid="share-dialog-host-go" onClick={onOpenHostSettings}>
              {SHARE_COPY.hostGo}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!canSubmit}
              data-testid="share-dialog-submit"
              onClick={() => void submit()}
            >
              {busy ? SHARE_COPY.submitting : intent === "copy" ? SHARE_COPY.submitCopy : SHARE_COPY.submitShare}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
