import {
  attachmentDisplayName,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import { useCallback, useState } from 'react';
import { presentShareSheet } from '../../lib/shareSheet';
import { downloadAttachmentFile } from './content';

export type DownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: number | null }
  | { status: 'failed' };

/**
 * 내려받아 iOS 공유시트에 넘긴다. 카드 탭과 전체 화면 보기의 「공유」가 같은 길이다.
 *
 * `AttachmentList.tsx` 에서 옮겨 왔다(#4293): 뷰어가 자기 파일(`AttachmentViewer.tsx`)을
 * 갖게 되면서 두 파일이 서로를 부르면 순환이 되기 때문이다. 본문은 그대로다.
 */
export function useShareAttachment(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
): [DownloadState, () => void] {
  const [download, setDownload] = useState<DownloadState>({ status: 'idle' });
  const start = useCallback(() => {
    if (download.status === 'downloading') return;
    setDownload({ status: 'downloading', progress: null });
    void downloadAttachmentFile(workspaceId, channelId, attachment, progress =>
      setDownload({ status: 'downloading', progress }),
    )
      .then(file =>
        // `Share.share` 를 곧바로 부르지 않는다: 이 시트는 뒤 화면을 막지 않아서 시트를 닫는 탭이 뒤의 줄·단추에 샌다(#5207, `shareSheet.ts` 머리말).
        presentShareSheet({
          title: attachmentDisplayName(attachment),
          url: file.uri,
        }),
      )
      .then(() => setDownload({ status: 'idle' }))
      .catch(() => setDownload({ status: 'failed' }));
  }, [attachment, channelId, download.status, workspaceId]);
  return [download, start];
}
