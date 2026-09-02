// RED (#1934): optimistic mark + advertiseReadState wiring lands in GREEN.

export function useMarkUnread(_workspaceId: string): {
  run: (input: {
    channelId: string;
    lastReadSeq: number;
    seq: number;
  }) => Promise<void>;
} {
  return {
    async run() {
      throw new Error("not implemented");
    },
  };
}
