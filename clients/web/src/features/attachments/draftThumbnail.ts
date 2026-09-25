import { useEffect, useState } from "react";
import {
  showsDraftThumbnail,
  type AttachmentDraft,
} from "@momo/core/features/attachments/model";
import { draftFile } from "./draftStore";

// =============================================================================
// 컴포저 트레이 썸네일 (#2701).
//
// 트레이가 이름과 크기만 말하면, 스크린샷 세 장을 붙인 사람은 어느 것이 어느
// 것인지 파일명으로 맞혀야 한다. 그래서 안전한 래스터 이미지는 작은 그림으로 선다.
//
// ## 왜 캔버스를 거쳐 `data:` 인가
//
// 타임라인 미리보기(content.ts)와 같은 제약이다: 배포 CSP 가 `img-src 'self'
// data:` 라서 `URL.createObjectURL(file)` 의 `blob:` 은 깨진 상자가 된다. 그렇다고
// 원본을 통째로 base64 로 만들면 20개 상한 × 8 MB × 1.33 이 문자열로 남는다.
// 그래서 `createImageBitmap(file)` 로 디코드하고(주소가 필요 없다 — CSP 밖이다),
// 표시 크기의 두 배 정사각형 캔버스에 가운데를 잘라 그린 뒤 그 작은 PNG 만
// `data:` 로 만든다. 한 장에 수십 KB 다.
//
// ## 캐시
//
// `File` 을 키로 한 WeakMap 이다. 초안을 지우면 draftStore 가 `File` 을 놓고,
// 그러면 썸네일도 같이 놓인다 — 지우는 길(제거·모두 지우기·전송)을 셋 다 따라가며
// 청소할 필요가 없다. 같은 파일을 다시 그려도 디코드는 한 번이다.
//
// ## 실패
//
// 디코드하지 못하는 이미지(예: Chrome 의 HEIC)는 아이콘으로 돌아간다. 첨부 자체는
// 멀쩡하고 올라가는 중이므로, 칩에 오류 문장을 얹지 않는다.
// =============================================================================

/** 트레이 칩의 썸네일 한 변(CSS px). tokens.css `--spacing-tray-thumb` 와 같은 값. */
const THUMB_EDGE_PX = 48;
/** 레티나에서 흐리지 않게 두 배로 그린다. */
const THUMB_RENDER_PX = THUMB_EDGE_PX * 2;

export type DraftThumbnailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; dataUrl: string }
  | { status: "failed" };

const thumbnails = new WeakMap<File, Promise<string>>();
const settled = new WeakMap<File, DraftThumbnailState>();

async function renderThumbnail(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_RENDER_PX;
    canvas.height = THUMB_RENDER_PX;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("thumbnail");
    // object-fit: cover. 짧은 변을 정사각형에 맞추고 가운데를 자른다.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    context.drawImage(
      bitmap,
      sx,
      sy,
      side,
      side,
      0,
      0,
      THUMB_RENDER_PX,
      THUMB_RENDER_PX
    );
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

function thumbnailFor(file: File): Promise<string> {
  let request = thumbnails.get(file);
  if (request === undefined) {
    request = renderThumbnail(file);
    request.then(
      (dataUrl) => settled.set(file, { status: "ready", dataUrl }),
      () => settled.set(file, { status: "failed" })
    );
    thumbnails.set(file, request);
  }
  return request;
}

function initialState(file: File | undefined, eligible: boolean): DraftThumbnailState {
  if (!eligible || file === undefined) return { status: "none" };
  return settled.get(file) ?? { status: "loading" };
}

/** 칩 하나의 썸네일. 안전한 래스터 이미지가 아니면 `none` 이고 아무것도 읽지 않는다. */
export function useDraftThumbnail(draft: AttachmentDraft): DraftThumbnailState {
  const eligible = showsDraftThumbnail(draft);
  const file = eligible ? draftFile(draft.localId) : undefined;
  const [state, setState] = useState<DraftThumbnailState>(() =>
    initialState(file, eligible)
  );

  useEffect(() => {
    if (!eligible || file === undefined) {
      setState({ status: "none" });
      return;
    }
    const known = settled.get(file);
    if (known !== undefined) {
      setState(known);
      return;
    }
    let live = true;
    setState({ status: "loading" });
    thumbnailFor(file).then(
      (dataUrl) => {
        if (live) setState({ status: "ready", dataUrl });
      },
      () => {
        if (live) setState({ status: "failed" });
      }
    );
    return () => {
      live = false;
    };
  }, [eligible, file]);

  return state;
}
