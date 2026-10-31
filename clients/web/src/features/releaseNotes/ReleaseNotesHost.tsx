import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  noteForDesktopVersion,
  shouldAnnounceNote,
  type ReleaseNote,
} from "@momo/core/features/releaseNotes/model";
import { RELEASE_NOTES } from "@momo/core/features/releaseNotes/notes";
import { useAppVersion } from "@/features/updates/store";
import { ReleaseNotesDialog } from "./ReleaseNotesDialog";
import { markReleaseNoteSeen, useLastSeenReleaseNote } from "./seenStore";

// =============================================================================
// 업데이트 뒤 처음 열 때 「업데이트 소식」을 한 번 자동으로 보인다 (#4937, owner 10-31).
//
// 언제 뜨는가: 이 앱의 버전에 붙는 소식(`noteForDesktopVersion`)이 있고, 이 기기가 그 소식을 아직 닫은 적이 없을 때.
// 데스크탑 셸만 앱 버전을 안다(`useAppVersion`은 브라우저 탭에서 늘 `null`): 브라우저 탭은 새로 고침이 곧 최신
// 번들이라 「업데이트 뒤 처음」이라는 순간이 없고, 소식은 설정에서 읽는다. 버전은 비동기로 오므로 `null`인 동안은
// 아무것도 하지 않는다.
//
// 닫으면(닫기·Esc·「자세히 보기」) 그 소식의 버전을 기기에 적고, 같은 소식은 다시 뜨지 않는다. 더 새 소식에서는
// 다시 뜬다. 한 번 뜬 뒤에는 이 마운트 안에서 다시 판정하지 않는다(닫는 순간 값이 바뀌어도 창이 깜박이지 않게).
// 로그인된 셸 안(`AppShell`)에만 서므로 첫 실행 흐름을 가리지 않는다.
// =============================================================================

export function ReleaseNotesHost({ notes = RELEASE_NOTES }: { notes?: readonly ReleaseNote[] }) {
  const appVersion = useAppVersion();
  const lastSeen = useLastSeenReleaseNote();
  const navigate = useNavigate();
  const note = useMemo(() => noteForDesktopVersion(notes, appVersion), [notes, appVersion]);
  const [shown, setShown] = useState<ReleaseNote | null>(null);
  const [open, setOpen] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || note === null || !shouldAnnounceNote(note, lastSeen)) return;
    decided.current = true;
    setShown(note);
    setOpen(true);
  }, [note, lastSeen]);

  const close = useCallback(() => {
    if (shown !== null) markReleaseNoteSeen(shown.version);
    setOpen(false);
  }, [shown]);

  const showDetails = useCallback(() => {
    if (shown !== null) markReleaseNoteSeen(shown.version);
    setOpen(false);
    // 경로는 객체로 건넨다: 한 줄 문자열 `/settings?section=…`은 직접 문구 장부가 문장으로 센다.
    navigate({ pathname: "/settings", search: "?section=releaseNotes" });
  }, [shown, navigate]);

  // 닫힌 뒤에도 마운트해 둔다: 퇴장 움직임이 끝나야 내용이 사라진다(`design/ui/dialog.tsx` 머리말).
  return shown === null ? null : (
    <ReleaseNotesDialog open={open} note={shown} onClose={close} onDetails={showDetails} />
  );
}
