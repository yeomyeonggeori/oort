import type { ReactNode, Ref } from "react";
import { directionParticle } from "@momo/core/lib/koreanParticle";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { S1_KEEP_MINE, S1_KEEP_THEIRS } from "./s1Copy";

// Reading this as: onboarding / settings stale-409 workspace name for internal
// team users on web+Tauri, density 6/10, motion 2/10.
//
// S1 and 설정 › 워크스페이스 share this treatment: draft stays, both names
// are on screen, one filled primary, the sentence is bound via aria-describedby.
// The NAME wraps; only 」+particle stay glued to the last character (U+2060).

export const WORD_JOINER = "\u2060";

export function StaleWorkspaceNamePhrase({
  otherName,
}: {
  otherName: string;
}): ReactNode {
  const particle = directionParticle(otherName);
  return (
    <>
      워크스페이스 이름이 「{otherName}
      {WORD_JOINER}
      <span className="whitespace-nowrap" data-testid="stale-name-particle">
        」{particle}
      </span>{" "}
      바뀌었습니다.
    </>
  );
}

export function StaleWorkspaceNameConflict({
  otherName,
  onKeepTheirs,
  onKeepMine,
  messageId,
  testIdPrefix,
  bannerRef,
}: {
  otherName: string;
  onKeepTheirs: () => void;
  onKeepMine: () => void;
  messageId: string;
  testIdPrefix: string;
  bannerRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={bannerRef}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 focus-visible:focus-ring"
    >
      <InlineBanner
        tone="error"
        message={<StaleWorkspaceNamePhrase otherName={otherName} />}
        messageId={messageId}
        testId={`${testIdPrefix}-stale`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={onKeepTheirs}
          data-testid={`${testIdPrefix}-keep-theirs`}
        >
          {S1_KEEP_THEIRS}
        </Button>
        <Button
          type="button"
          onClick={onKeepMine}
          data-testid={`${testIdPrefix}-keep-mine`}
        >
          {S1_KEEP_MINE}
        </Button>
      </div>
    </div>
  );
}
