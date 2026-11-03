import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  findReleaseNote,
  listReleaseNotes,
  noteForDesktopVersion,
  type ReleaseNote,
  type ReleaseNoteSurface,
} from "@momo/core/features/releaseNotes/model";
import { RELEASE_NOTES } from "@momo/core/features/releaseNotes/notes";
import { Button } from "@/design/ui/button";
import { StatusChip } from "@/features/settings/SettingsFields";
import { SettingsRow } from "@/features/settings/shell/SettingsRow";
import { SettingsSection } from "@/features/settings/shell/SettingsSection";
import { useAppVersion } from "@/features/updates/store";
import { useReleaseNotesMessages } from "./useReleaseNotesMessages";

// =============================================================================
// 설정 › 업데이트 소식 (#4937, owner 10-31): 버전 목록 → 버전별 내용.
//
// 목록은 새 소식이 맨 위이고, 이 앱에 붙는 소식(`noteForDesktopVersion`)에 「지금 쓰는 버전」 표지가 선다. 앱 버전이
// 없는 브라우저 탭은 표지 없이 목록만 보인다. 앱의 자기 버전 소식이 아직 없으면 표지는 그 앞의 가장 새 소식에 선다
// (그 소식이 이 앱에 적용되는 가장 새 것이다).
//
// 내용은 팀이 QA와 써 보기에 쓴다: 항목마다 「바뀐 점」과 「이렇게 써 보세요」, 보이는 화면(폰·데스크탑) 표지.
// 목록에서 내용으로 들어가면 포커스가 내용의 제목으로 가고(낭독이 새 제목을 읽는다), 돌아오면 눌렀던 줄의 단추로
// 돌아온다. 이 화면에는 자기 움직임이 없다.
// =============================================================================

const SURFACE_KEY = {
  phone: "releaseNotes.surface.phone",
  desktop: "releaseNotes.surface.desktop",
} as const satisfies Record<ReleaseNoteSurface, string>;

// testID는 템플릿 문자열로 짓지 않는다: 직접 문구 장부(`direct-copy.mjs`)가 JSX 안의 템플릿 조각을 문구로 센다.
const itemTestId = (id: string) => "release-notes-item-" + id;
const rowTestId = (version: string) => "release-notes-row-" + version;
const openTestId = (version: string) => "release-notes-open-" + version;

export function ReleaseNotesSection({ notes: given = RELEASE_NOTES }: { notes?: readonly ReleaseNote[] }) {
  const { messages, noteLocale } = useReleaseNotesMessages();
  // 넘겨받은 순서에 기대지 않는다: 새 소식이 맨 위가 되게 스스로 줄 세운다.
  const notes = useMemo(() => listReleaseNotes(given), [given]);
  const appVersion = useAppVersion();
  const current = noteForDesktopVersion(notes, appVersion);
  const [selected, setSelected] = useState<string | null>(null);
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const returnTo = useRef<string | null>(null);

  useEffect(() => {
    if (selected !== null) {
      detailHeading.current?.focus();
      return;
    }
    if (returnTo.current !== null) {
      openers.current.get(returnTo.current)?.focus();
      returnTo.current = null;
    }
  }, [selected]);

  const back = useCallback(() => {
    returnTo.current = selected;
    setSelected(null);
  }, [selected]);

  const note = selected === null ? null : findReleaseNote(notes, selected);

  if (note !== null) {
    const versionLabel = messages.formatMessage("releaseNotes.version.label", { version: note.version });
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="release-notes-detail">
        <div>
          <Button variant="ghost" size="sm" onClick={back} data-testid="release-notes-back">
            <ArrowLeft aria-hidden="true" />
            {messages.formatMessage("releaseNotes.detail.back")}
          </Button>
        </div>
        <div className="flex min-w-0 flex-col gap-px px-4">
          <h2
            ref={detailHeading}
            tabIndex={-1}
            className="break-keep text-title font-semibold text-ink focus-visible:focus-ring"
            data-testid="release-notes-detail-title"
          >
            {versionLabel}
          </h2>
          <p className="break-keep text-meta text-ink-muted">
            <span data-numeric>{messages.formatMessage("releaseNotes.version.releasedOn", { date: note.releasedOn })}</span>
          </p>
          <p className="break-keep text-body text-ink-muted">{note.summary[noteLocale]}</p>
        </div>
        <SettingsSection>
          {note.items.map((item) => (
            <SettingsRow
              key={item.id}
              stack
              testId={itemTestId(item.id)}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  <span>{item.copy[noteLocale].title}</span>
                  <span
                    role="group"
                    aria-label={messages.formatMessage("releaseNotes.surface.label")}
                    className="flex items-center gap-1"
                  >
                    {item.surfaces.map((surface) => (
                      <StatusChip key={surface} tone="muted">
                        {messages.formatMessage(SURFACE_KEY[surface])}
                      </StatusChip>
                    ))}
                  </span>
                </span>
              }
            >
              <dl className="flex w-full min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-col gap-px">
                  <dt className="text-meta font-semibold text-ink-muted">
                    {messages.formatMessage("releaseNotes.detail.changed")}
                  </dt>
                  <dd className="break-keep text-body text-ink">{item.copy[noteLocale].changed}</dd>
                </div>
                <div className="flex min-w-0 flex-col gap-px">
                  <dt className="text-meta font-semibold text-ink-muted">
                    {messages.formatMessage("releaseNotes.detail.tryIt")}
                  </dt>
                  <dd className="break-keep text-body text-ink">{item.copy[noteLocale].tryIt}</dd>
                </div>
              </dl>
            </SettingsRow>
          ))}
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="release-notes-page">
      <SettingsSection description={messages.formatMessage("releaseNotes.page.description")}>
        {notes.length === 0 ? (
          <SettingsRow plain label={messages.formatMessage("releaseNotes.page.empty")} testId="release-notes-empty" />
        ) : (
          notes.map((item) => {
            const versionLabel = messages.formatMessage("releaseNotes.version.label", { version: item.version });
            const isCurrent = current !== null && current.version === item.version;
            return (
              <SettingsRow
                key={item.version}
                testId={rowTestId(item.version)}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{versionLabel}</span>
                    {isCurrent ? (
                      <StatusChip tone="accent">{messages.formatMessage("releaseNotes.version.current")}</StatusChip>
                    ) : null}
                  </span>
                }
                description={
                  <>
                    <span className="block">{item.summary[noteLocale]}</span>
                    <span className="block" data-numeric>
                      {messages.formatMessage("releaseNotes.version.releasedOn", { date: item.releasedOn })}
                    </span>
                  </>
                }
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="tap-target"
                  aria-label={`${messages.formatMessage("releaseNotes.action.details")}, ${versionLabel}`}
                  ref={(element) => {
                    if (element) openers.current.set(item.version, element);
                    else openers.current.delete(item.version);
                  }}
                  onClick={() => setSelected(item.version)}
                  data-testid={openTestId(item.version)}
                >
                  {messages.formatMessage("releaseNotes.action.details")}
                </Button>
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>
    </div>
  );
}
