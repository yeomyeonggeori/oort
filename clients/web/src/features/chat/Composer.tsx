import { useState, type FormEvent } from "react";
import { sendMessage } from "@/lib/api";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { SendHorizontal } from "lucide-react";

export function Composer({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setText("");
    try {
      // clientMsgId is the idempotency key (L4 §3.1). The message will arrive
      // back over the realtime rail and merge by seq — no optimistic insert
      // needed to prove the round-trip.
      await sendMessage(workspaceId, channelId, crypto.randomUUID(), body);
    } catch {
      setText(body); // restore on failure
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-center gap-2 border-t border-line p-3"
    >
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="메시지 입력…"
        data-testid="composer-input"
      />
      <Button type="submit" size="icon" disabled={busy} data-testid="composer-send">
        <SendHorizontal />
      </Button>
    </form>
  );
}
