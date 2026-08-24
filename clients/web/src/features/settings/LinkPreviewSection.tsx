import {
  setLinkPreviewsFolded,
  useLinkPreviewsFolded,
} from "@/features/timeline/linkPreviewPreference";
import { SectionShell } from "./SettingsFields";

export function LinkPreviewSection() {
  const folded = useLinkPreviewsFolded();
  const nameId = "link-preview-folded-name";
  const descId = "link-preview-folded-desc";
  return (
    <SectionShell
      title="링크 미리보기"
      lines={[
        "메시지 아래의 링크 제목, 설명, 도메인과 이미지를 내 화면에서 표시할지 고릅니다.",
        "이 선택은 서버의 링크 확인이나 다른 멤버의 화면에 영향을 주지 않습니다.",
      ]}
    >
      <div
        className="flex min-w-0 items-start gap-3 rounded-md border border-line bg-surface-raised p-3"
        data-state={folded ? "on" : "off"}
      >
        <input
          id="link-preview-folded"
          type="checkbox"
          checked={folded}
          aria-labelledby={nameId}
          aria-describedby={descId}
          onChange={(event) => setLinkPreviewsFolded(event.target.checked)}
          className="mt-1 accent-accent focus-visible:focus-ring"
          data-testid="link-preview-folded"
        />
        <label
          htmlFor="link-preview-folded"
          className="flex min-w-0 cursor-pointer flex-col gap-px"
        >
          <span id={nameId} className="text-body text-ink">
            링크 미리보기 접기
          </span>
          <span id={descId} className="break-keep text-meta text-ink-muted">
            켜면 이 기기의 타임라인에서 카드만 숨깁니다. 메시지 속 링크는 그대로
            보이고, 서버는 워크스페이스 설정에 따라 링크를 계속 확인할 수 있습니다.
          </span>
        </label>
      </div>
      <p className="text-meta text-ink-muted" data-testid="link-preview-persistence">
        이 기기에만 저장됩니다. 다른 기기에서는 각자 고릅니다.
      </p>
    </SectionShell>
  );
}
