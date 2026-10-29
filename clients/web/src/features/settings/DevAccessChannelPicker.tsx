import { useMemo } from "react";
import { DEV_CHANNEL_MAX } from "@momo/core/features/auth/devAccessModel";
import { ChoiceList, type ChoiceListItem } from "@/features/hostedAgents/ChoiceList";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  channelLabel,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";

// Reading this as: settings for internal team users on web+Tauri,
// density 6/10, motion 2/10.

// =============================================================================
// 「고른 채널만 쓰기」의 채널 고르기 (#4663). 내가 들어가 있는 채널(서버가 `GET …/channels`로
// 주는 목록 그대로: 서버도 만들 때 같은 목록과 맞춰 본다)을 체크 목록으로 보인다. 하나는 고르고
// 하나는 안 고른 채 두면 그 도구는 고른 채널만 본다. 1개에서 50개까지는 코어
// (`validateChannelSelection`)가 판정하고, 이 목록은 고르는 일만 한다.
// =============================================================================

const GROUP_NAME = "dev-access-channels";

const KIND_DETAIL = {
  public: "공개 채널",
  private: "비공개 채널",
  dm: "1:1 대화",
} as const;

export function DevAccessChannelPicker({
  workspaceId,
  memberId,
  selected,
  onChange,
  disabled = false,
  describedBy,
}: {
  workspaceId: string;
  memberId: string;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** 검증 오류 문장의 id. 목록이 자기 오류를 든다. */
  describedBy?: string;
}) {
  const channels = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);

  const items = useMemo<ChoiceListItem[]>(
    () => [
      ...channels.groups.channels.map((channel) => ({
        id: channel.id,
        label: `#${channelLabel(channel, directory, memberId)}`,
        detail: KIND_DETAIL[channel.kind === "private" ? "private" : "public"],
      })),
      ...channels.groups.dms.map((channel) => ({
        id: channel.id,
        label: channelLabel(channel, directory, memberId),
        detail: KIND_DETAIL.dm,
      })),
    ],
    [channels.groups, directory, memberId]
  );

  if (channels.isPending) {
    return (
      <div role="status" data-testid="dev-access-channels-loading">
        <span className="sr-only">채널 목록을 불러오고 있어요.</span>
        <Skeleton ready={false} rows={3} className="p-0" />
      </div>
    );
  }

  if (channels.isError) {
    return (
      <InlineBanner
        message="채널 목록을 불러오지 못했어요. 다시 시도해 주세요."
        actionLabel="다시 시도"
        onAction={() => void channels.refetch()}
        className="px-0"
        separator={false}
        testId="dev-access-channels-error"
      />
    );
  }

  if (items.length === 0) {
    return (
      <p
        className="break-keep text-body text-ink-muted"
        data-testid="dev-access-channels-empty"
      >
        들어가 있는 채널이 없어요. 채널에 들어간 뒤에 고를 수 있어요.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* 긴 목록이 폼을 밀지 않게 이름 있는 높이(`max-h-pane`)에서 안으로 스크롤한다. */}
      <div className="max-h-pane overflow-y-auto" data-testid="dev-access-channels-scroll">
        <ChoiceList
          name={GROUP_NAME}
          legend="연결이 닿을 채널"
          multiple
          items={items}
          selected={selected}
          onChange={onChange}
          disabled={disabled}
          describedBy={describedBy}
          testId="dev-access-channels"
        />
      </div>
      <p
        className="break-keep text-meta text-ink-muted"
        role="status"
        data-numeric
        data-testid="dev-access-channels-count"
      >
        {selected.length}개 골랐어요. 최대 {DEV_CHANNEL_MAX}개까지 고를 수 있어요.
      </p>
    </div>
  );
}
