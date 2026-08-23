import {File, UploadType} from 'expo-file-system';

const PROGRESS_CEILING = 0.99;

export type UploadFailure = 'aborted' | 'status' | 'network';

export interface UploadResult {
  ok: boolean;
  failure?: UploadFailure;
  status?: number;
}

export interface UploadHandle {
  done: Promise<UploadResult>;
  abort: () => void;
}

/**
 * capability URL로 바이트를 올리는 유일한 폰 경로.
 *
 * momo bearer는 절대 싣지 않는다. 파일 바이트는 네이티브 URLSession이 URI에서 바로
 * 읽으므로 100MB 상한을 JS heap에 한 벌 더 만들지 않고, 완료 확인 전 진행률은
 * 99%에서 멈춘다(코어의 `verifying` 칸이 나머지를 진다).
 */
export function putAttachmentBytes(
  url: string,
  uri: string,
  mime: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const file = new File(uri);
  const task = file.createUploadTask(url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    mimeType: mime,
    headers: {'Content-Type': mime},
    sessionType: 'foreground',
    onProgress: ({bytesSent, totalBytes}) => {
      if (totalBytes <= 0) return;
      onProgress(
        Math.min(PROGRESS_CEILING, Math.max(0, bytesSent / totalBytes)),
      );
    },
  });
  let aborted = false;
  const done = task
    .uploadAsync()
    .then(result =>
      result.status === 200 || result.status === 201
        ? {ok: true}
        : {ok: false, failure: 'status' as const, status: result.status},
    )
    .catch(() => ({
      ok: false,
      failure: aborted ? ('aborted' as const) : ('network' as const),
    }))
    .finally(() => task.release());

  return {
    done,
    abort: () => {
      aborted = true;
      task.cancel();
    },
  };
}
