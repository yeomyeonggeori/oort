import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { removeMyAvatar, type RosterMember } from "@momo/core/lib/api";
import {
  AVATAR_EDITOR_COPY,
  AVATAR_PNG_FILE_NAME,
  AVATAR_PNG_MIME,
  AVATAR_PRESET_IDS,
  avatarComposeFailureMessage,
  composeAvatarPng,
  normalizeFreeColor,
  renderAvatarPng,
  type AvatarCanvasPorts,
  type AvatarComposeFailure,
  type AvatarDraft,
  type AvatarGlyph,
  type AvatarPresetId,
} from "@momo/core/features/workspace/avatarEditor";
import { firstVisibleBackground, judgeGlyphVisibility } from "@momo/core/features/workspace/avatarContrast";
import {
  AVATAR_BACKGROUNDS,
  DEFAULT_EMOJI_BACKGROUND,
  DEFAULT_PRESET_BACKGROUND,
  avatarBackgroundHex,
  type AvatarBackground,
  type AvatarBackgroundId,
} from "@momo/core/features/workspace/avatarPalette";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { SegmentedControl, type SegmentOption } from "@/design/ui/segmented-control";
import { InlineBanner } from "@/features/common/States";
import { primeMemberAvatar } from "@/features/sidebar/useMemberAvatar";
import { memberAvatarPickError, memberAvatarRemoveError, memberAvatarUploadError } from "../memberAvatarCopy";
import { ConfirmButton } from "../SettingsFields";
import { uploadMyAvatar } from "../uploadMyAvatar";
import { AvatarColorPicker } from "./AvatarColorPicker";
import { bytesToPngDataUrl, readFileAsDataUrl } from "./avatarDataUrl";
import { AvatarEditorPreview } from "./AvatarEditorPreview";
import { AvatarEmojiPicker } from "./AvatarEmojiPicker";
import { AvatarPresetPicker } from "./AvatarPresetPicker";
import { canvasAvatarPorts } from "./canvasPorts";
import { useGlyphSample, usePaletteVerdicts, usePreviewUrl } from "./useAvatarRender";

// Reading this as: settings dialog (profile hero) for internal team users on web+Tauri, density 7/10, motion 2/10.

// =============================================================================
// 아바타 편집기 (#4261): 사진 · 이모지 + 배경색 · 코메토. 설정 › 프로필의 히어로가 연다.
//
// **지연 청크다.** 설정 화면에서만 쓰이는 코드(캔버스 포트, 팔레트 칩, 코메토 타일, 이모지 패널 배선, 미리보기)가
// 메인에 실리지 않게 `ProfileAvatarField` 가 `import()` 로 부른다(빌드 전후 메인 청크 크기는 PR 본문). 그 필드는
// 이 디렉터리에서 **타입만** 가져온다(`profileAvatarEditorLazy.test.ts` 가 소스를 읽어 지킨다).
//
// ## 서버를 건드리지 않는다
//
// 이모지·코메토 아바타는 클라이언트가 그린 512px 정사각 PNG 한 장이고, 사진과 **같은 길**(`uploadMyAvatar`:
// 세션 열기 → Drive PUT → complete)로 올라간다. 서버 입장에서는 그냥 PNG 다. 그린 PNG 가 정본이라(이모지는 기기마다
// 다르게 그려진다) 올리는 바이트는 `composeAvatarPng` 가 낸 그대로이고, 시험이 바이트가 한 글자도 안 바뀌고 `uploadMyAvatar`
// 에 닿는지 못 박는다.
//
// ## 저장은 한 번이고 판정이 막는다
//
// 세 종류가 모두 **고르고 → 미리보기 → 저장**이다(사진도: 고른 사진이 사이드바 24·메시지 32·프로필 큰 원에서 어떻게
// 잘리는지 보고 올린다). 이모지·코메토는 그려진 글리프가 배경과 3:1을 넘는 면적이 절반 이상일 때만 저장된다
// (`avatarContrast.ts`). 막힌 색은 칩이 흐려지고, 직접 입력한 색이 묻히면 아래 한 줄이 말한다. 저장 단추는 화면의
// 상태와 무관하게 마지막에 `composeAvatarPng` 로 다시 판정한다.
//
// 「기본으로 되돌리기」는 `removeMyAvatar` 다: 이름의 첫 글자로 돌아간다. 첫 글자를 PNG 로 굽지 않는 이유는 이름을 바꾸면
// 굽은 글자가 낡기 때문이다(기본 이니셜은 늘 토큰으로 그려지고 그 대비는 `tokens.contrast.test.ts` 가 잰다).
//
// ## 네 상태
//
//   · 빈 것: 이모지를 안 골랐거나 사진을 안 골랐다 → 저장 단추는 잠기고 아래 한 줄이 다음 행동을 말한다.
//   · 불러오는 중: 이모지 카탈로그는 패널의 막대가 서고, 구운 그림이 바뀌는 동안은 앞의 미리보기가 그대로 선다.
//   · 오류: 판정(묻힘·그리기 실패)과 올리기 오류는 한 줄에 하나씩(오류 > 진행 > 막힌 이유).
//   · 오프라인: 위 배너가 말하고 저장·되돌리기가 잠긴다(고르는 일은 이 기기 안이라 열려 있다).
//
// 진행은 잠금이 아니다(#1486 문법): 저장 단추는 `aria-busy` 와 「올리는 중」으로 진행을 말하고 native `disabled` 로
// 초점을 떨구지 않는다. 올리는 동안은 닫히지 않는다.
// =============================================================================

type Mode = "photo" | "emoji" | "preset";

const MODE_OPTIONS: readonly SegmentOption<Mode>[] = (["photo", "emoji", "preset"] as const).map((value) => ({
  value,
  label: AVATAR_EDITOR_COPY.modes[value],
}));

interface ColorState {
  /** 지금 쓰는 배경. 늘 소문자 `#rrggbb` 다. */
  bg: string;
  /** 직접 입력 칸의 글자. 쓰는 중에는 `bg` 와 다를 수 있다. */
  text: string;
  /** 사용자가 직접 골랐는가. 아니면 글리프가 묻힐 때 편집기가 첫 통과 색으로 옮겨도 된다. */
  touched: boolean;
  /** 입력 칸을 한 번이라도 떠났는가(꼴 오류는 떠난 뒤에 말한다). */
  left: boolean;
}

function initialColor(id: AvatarBackgroundId): ColorState {
  const hex = avatarBackgroundHex(id);
  return { bg: hex, text: hex, touched: false, left: false };
}

class AvatarComposeError extends Error {
  constructor(
    readonly reason: AvatarComposeFailure,
    readonly kind: AvatarDraft["kind"]
  ) {
    super(`avatar compose failed: ${reason}`);
  }
}

export interface AvatarEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  me: RosterMember | null;
  offline: boolean;
  opener: DialogFocusTarget | null;
  /** 저장·되돌리기가 끝났다. 히어로의 상태 줄이 이 문장을 말한다. */
  onDone: (message: string) => void;
  /** 올리는 중·되돌리는 중을 히어로가 알아 카메라 손잡이를 같이 잠글 수 있게 한다. */
  onBusyChange?: (busy: boolean) => void;
  /** 시험이 가짜 포트를 꽂는 자리(jsdom 에는 캔버스가 없다). 앱은 캔버스 포트를 쓴다. */
  ports?: AvatarCanvasPorts<unknown>;
  nowMs?: number;
}

export function AvatarEditorDialog({
  open,
  onOpenChange,
  workspaceId,
  me,
  offline,
  opener,
  onDone,
  onBusyChange,
  ports = canvasAvatarPorts as AvatarCanvasPorts<unknown>,
  nowMs,
}: AvatarEditorDialogProps) {
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const pickToken = useRef(0);
  const reasonId = useId();
  const offlineId = useId();
  const resetSlotRef = useRef<HTMLDivElement>(null);
  const refocusReset = useRef(false);
  const [now] = useState(() => nowMs ?? Date.now());

  const [mode, setMode] = useState<Mode>("photo");
  const [photo, setPhoto] = useState<{ file: File; url: string | null } | null>(null);
  const [emoji, setEmoji] = useState<string | null>(null);
  const [preset, setPreset] = useState<AvatarPresetId>(AVATAR_PRESET_IDS[0]);
  const [emojiColor, setEmojiColor] = useState<ColorState>(() => initialColor(DEFAULT_EMOJI_BACKGROUND));
  const [presetColor, setPresetColor] = useState<ColorState>(() => initialColor(DEFAULT_PRESET_BACKGROUND));
  const [skinOpen, setSkinOpen] = useState(false);
  // 되돌리기의 제자리 확인 질문이 열려 있는가. 대화상자 안에서는 `ConfirmButton` 이 자기 Esc 층을 받지 못한다(Radix 가 Esc 의 임자다,
  // `escapeLayer.ts`). 그래서 첫 Esc 는 여기서 질문만 닫는다(`resetKey` 를 올려 새로 세운다): 피부색 목록과 같은 「가장 안쪽 먼저」다.
  const [resetAsking, setResetAsking] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Partial<Record<AvatarPresetId, string>>>({});

  const hasAvatar = Boolean(me?.avatarUrl);

  // ---- 지금 탭의 그림과 색 -------------------------------------------------------
  const color = mode === "preset" ? presetColor : emojiColor;
  const updateColor = useCallback(
    (change: (current: ColorState) => ColorState) => {
      (mode === "preset" ? setPresetColor : setEmojiColor)(change);
    },
    [mode]
  );
  const glyph = useMemo<AvatarGlyph | null>(() => {
    if (mode === "emoji") return emoji === null ? null : { kind: "emoji", emoji };
    if (mode === "preset") return { kind: "preset", preset };
    return null;
  }, [mode, emoji, preset]);
  const draft = useMemo<AvatarDraft | null>(() => (glyph === null ? null : { ...glyph, bg: color.bg }), [glyph, color.bg]);

  // ---- 판정: 표본(배경 없이 그린 글리프)을 열다섯 색에 대 본다 --------------------------
  const sample = useGlyphSample(ports, glyph);
  const verdicts = usePaletteVerdicts(sample);
  const verdict = sample.state === "ready" ? judgeGlyphVisibility(sample.pixels, color.bg) : null;
  const blocked = useMemo(() => {
    const out: Partial<Record<AvatarBackgroundId, boolean>> = {};
    if (verdicts !== null) for (const entry of AVATAR_BACKGROUNDS) out[entry.id] = !verdicts[entry.id].ok;
    return out;
  }, [verdicts]);

  // 사용자가 색을 건드리지 않았는데 고른 그림이 지금 바탕에 묻히면 첫 통과 색으로 옮긴다(이모지를 고르자마자 막히지 않게).
  useEffect(() => {
    if (sample.state !== "ready" || color.touched) return;
    if (judgeGlyphVisibility(sample.pixels, color.bg).ok) return;
    const next = firstVisibleBackground(sample.pixels);
    if (next !== null) updateColor((current) => ({ ...current, bg: next.hex, text: next.hex }));
  }, [sample, color.bg, color.touched, updateColor]);

  // ---- 미리보기: 올릴 PNG 와 같은 함수가 구운 그림 ---------------------------------------
  const draftUrl = usePreviewUrl(ports, draft);
  const previewSrc = mode === "photo" ? (photo?.url ?? null) : draftUrl;

  // 코메토 타일 여섯: 지금 고른 배경 위에서 구운 작은 그림. 탭이 열려 있는 동안만 굽는다.
  useEffect(() => {
    if (mode !== "preset") return;
    let live = true;
    void (async () => {
      const next: Partial<Record<AvatarPresetId, string>> = {};
      for (const id of AVATAR_PRESET_IDS) {
        const result = await renderAvatarPng(ports, { kind: "preset", preset: id, bg: presetColor.bg }, 112);
        if (!live) return;
        if (result.ok) next[id] = bytesToPngDataUrl(result.png);
      }
      if (live) setThumbs(next);
    })();
    return () => {
      live = false;
    };
  }, [mode, ports, presetColor.bg]);

  // ---- 쓰기 ------------------------------------------------------------------------
  const refreshRoster = () => client.invalidateQueries({ queryKey: ["roster", workspaceId] });

  const save = useMutation({
    mutationFn: async () => {
      setProgress(0);
      let file: File;
      if (mode === "photo") {
        if (photo === null) throw new Error("no photo chosen");
        file = photo.file;
      } else {
        if (draft === null) throw new Error("no avatar drafted");
        const composed = await composeAvatarPng(ports, draft);
        if (!composed.ok) throw new AvatarComposeError(composed.reason, draft.kind);
        // 바이트는 포트가 구운 그대로다(다시 쓰지 않는다): 그려 올린 PNG 가 정본이다.
        file = new File([composed.png as Uint8Array<ArrayBuffer>], AVATAR_PNG_FILE_NAME, { type: AVATAR_PNG_MIME });
      }
      const media = await uploadMyAvatar(workspaceId, file, setProgress);
      await primeMemberAvatar(media.avatarUrl, file).catch(() => undefined);
    },
    onSuccess: async () => {
      await refreshRoster();
      onDone(
        mode !== "photo"
          ? AVATAR_EDITOR_COPY.doneSaved
          : hasAvatar
            ? AVATAR_EDITOR_COPY.doneSavedPhoto
            : AVATAR_EDITOR_COPY.doneUploadedPhoto
      );
      onOpenChange(false);
    },
    onError: (failure) =>
      setError(
        failure instanceof AvatarComposeError
          ? avatarComposeFailureMessage(failure.reason, failure.kind)
          : memberAvatarUploadError(failure)
      ),
  });

  const reset = useMutation({
    mutationFn: () => removeMyAvatar(workspaceId),
    onSuccess: async () => {
      await refreshRoster();
      onDone(AVATAR_EDITOR_COPY.doneReset);
      onOpenChange(false);
    },
    onError: () => setError(memberAvatarRemoveError()),
  });

  const saving = save.isPending;
  const resetting = reset.isPending;
  const busy = saving || resetting;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  // Esc 로 질문을 닫으면 새로 선 「되돌리기」 단추가 초점을 이어받는다(안 그러면 초점이 대화상자 껍데기로 떨어진다).
  useEffect(() => {
    if (!refocusReset.current) return;
    refocusReset.current = false;
    resetSlotRef.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [resetKey]);

  // ---- 저장해도 되는가, 안 되면 왜 ---------------------------------------------------
  const colorSynced = normalizeFreeColor(color.text) === color.bg;
  const colorFormatProblem = !colorSynced && color.left ? AVATAR_EDITOR_COPY.invalidColor : null;

  let blockReason: string | null = null;
  let ready = false;
  if (mode === "photo") {
    if (photo === null) blockReason = AVATAR_EDITOR_COPY.photoEmpty;
    else ready = true;
  } else if (glyph === null) {
    blockReason = AVATAR_EDITOR_COPY.emojiEmpty;
  } else if (sample.state === "failed") {
    blockReason = avatarComposeFailureMessage(sample.reason === "no-canvas" ? "no-canvas" : "blank", glyph.kind);
  } else if (!colorSynced) {
    blockReason = AVATAR_EDITOR_COPY.invalidColor;
  } else if (verdict !== null && !verdict.ok) {
    blockReason = avatarComposeFailureMessage(verdict.reason, glyph.kind);
  } else if (verdict !== null) {
    ready = true;
  }
  const canSave = ready && !offline && !busy;
  // 잠긴 저장 단추가 이유를 가리키는 곳: 오프라인 배너와, 상태 줄(막힌 이유·오류)이 문장을 든 때의 그 줄. 빈 줄은 가리키지 않는다.
  const saveDescribedBy =
    !canSave && !saving
      ? [offline ? offlineId : null, blockReason !== null || error !== null ? reasonId : null].filter(Boolean).join(" ") || undefined
      : undefined;

  const status = saving
    ? `${AVATAR_EDITOR_COPY.saving} ${Math.round(progress * 100)}%.`
    : resetting
      ? `${AVATAR_EDITOR_COPY.resetBusy}…`
      : null;

  // ---- 입력 ------------------------------------------------------------------------
  const clearError = () => setError(null);

  function onMode(next: Mode) {
    setMode(next);
    setSkinOpen(false);
    clearError();
  }

  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // 같은 파일을 다시 골라도 change 가 다시 뜨게.
    clearError();
    if (!file || busy) return;
    const problem = memberAvatarPickError(file);
    if (problem) {
      setError(problem);
      return;
    }
    const token = (pickToken.current += 1);
    const url = await readFileAsDataUrl(file);
    if (token !== pickToken.current) return; // 그사이 다른 파일을 골랐다.
    if (url === null) {
      setError(AVATAR_EDITOR_COPY.photoReadFailed);
      return;
    }
    setPhoto({ file, url });
  }

  function pickPalette(entry: AvatarBackground) {
    clearError();
    updateColor((current) => ({ ...current, bg: entry.hex, text: entry.hex, touched: true }));
  }

  function typeColor(value: string) {
    clearError();
    const normalized = normalizeFreeColor(value);
    updateColor((current) => ({
      ...current,
      text: value,
      bg: normalized ?? current.bg,
      touched: true,
    }));
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && busy) return; // 올리는 동안은 닫히지 않는다.
    onOpenChange(next);
  };

  const colorPicker = (
    <AvatarColorPicker
      bg={color.bg}
      text={color.text}
      blocked={blocked}
      problem={colorFormatProblem}
      onPalette={pickPalette}
      onText={typeColor}
      onTextBlur={() => updateColor((current) => ({ ...current, left: true }))}
    />
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        opener={opener}
        data-testid="avatar-editor-dialog"
        className="gap-3 p-4"
        onEscapeKeyDown={(event) => {
          // 한 번의 Esc 는 가장 안쪽의 것만 닫는다: 열려 있는 피부색 목록, 그다음 되돌리기의 확인 질문, 마지막이 대화상자다.
          event.stopPropagation();
          if (skinOpen) {
            event.preventDefault();
            setSkinOpen(false);
            return;
          }
          if (resetAsking) {
            event.preventDefault();
            refocusReset.current = true;
            setResetAsking(false);
            setResetKey((n) => n + 1);
          }
        }}
      >
        <DialogTitle>{AVATAR_EDITOR_COPY.title}</DialogTitle>
        <DialogDescription>{AVATAR_EDITOR_COPY.description}</DialogDescription>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {offline ? (
            <InlineBanner tone="neutral" message={AVATAR_EDITOR_COPY.offline} messageId={offlineId} testId="avatar-editor-offline" />
          ) : null}

          {/* 미리보기는 스크롤 본문 안에서 위에 붙는다: 낮은 창에서 아래의 색 칩을 고르는 동안에도 결과가 보인다. */}
          <div className="sticky top-0 layer-content-float bg-surface-raised pb-1">
            <AvatarEditorPreview me={me} src={previewSrc} nowMs={now} />
          </div>

          <SegmentedControl
            legend={AVATAR_EDITOR_COPY.modeLegend}
            options={MODE_OPTIONS}
            value={mode}
            onValueChange={onMode}
            testId="avatar-editor-mode"
          />

          {mode === "photo" ? (
            <div className="flex flex-col gap-2" data-testid="avatar-editor-photo">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="tap-target"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) inputRef.current?.click();
                  }}
                  data-testid="avatar-photo-pick"
                >
                  {photo === null ? AVATAR_EDITOR_COPY.photoPick : AVATAR_EDITOR_COPY.photoChange}
                </Button>
              </div>
              <p className="text-meta text-ink-muted">{AVATAR_EDITOR_COPY.photoHint}</p>
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                onChange={(event) => void onPickFile(event)}
                data-testid="profile-avatar-input"
                tabIndex={-1}
                aria-hidden="true"
              />
            </div>
          ) : mode === "emoji" ? (
            <div className="flex flex-col gap-3" data-testid="avatar-editor-emoji">
              <AvatarEmojiPicker
                skinOpen={skinOpen}
                onSkinOpenChange={setSkinOpen}
                onPick={(picked) => {
                  clearError();
                  setEmoji(picked);
                }}
              />
              {colorPicker}
            </div>
          ) : (
            <div className="flex flex-col gap-3" data-testid="avatar-editor-preset">
              <p className="text-meta text-ink-muted">{AVATAR_EDITOR_COPY.presetHint}</p>
              <AvatarPresetPicker
                value={preset}
                thumbs={thumbs}
                onChange={(next) => {
                  clearError();
                  setPreset(next);
                }}
              />
              {colorPicker}
            </div>
          )}
        </div>

        {/* 한 칸에 하나만 선다: 오류 > 진행 > 막힌 이유. 칸의 높이는 늘 예약해 두므로(min-h-6) 문장이 나타나도 아래가 밀리지 않는다. */}
        <div className="min-h-6">
          {error ? (
            <p id={reasonId} className="text-meta text-danger" role="alert" data-testid="avatar-editor-error">
              {error}
            </p>
          ) : (
            <p
              id={reasonId}
              role="status"
              aria-live="polite"
              className="text-meta text-ink-muted"
              data-testid="avatar-editor-status"
            >
              {status ?? (canSave ? null : blockReason)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div ref={resetSlotRef} className="min-w-0">
            {hasAvatar ? (
              <ConfirmButton
                key={resetKey}
                label={AVATAR_EDITOR_COPY.reset}
                question={AVATAR_EDITOR_COPY.resetQuestion}
                confirmLabel={AVATAR_EDITOR_COPY.resetConfirm}
                busy={resetting}
                busyLabel={AVATAR_EDITOR_COPY.resetBusy}
                disabled={offline || saving}
                describedBy={offline ? offlineId : undefined}
                onAskingChange={setResetAsking}
                onConfirm={() => {
                  clearError();
                  reset.mutate();
                }}
                triggerClassName="tap-target"
                testId="avatar-editor-reset"
              />
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)} data-testid="avatar-editor-cancel">
              {AVATAR_EDITOR_COPY.cancel}
            </Button>
            <Button
              type="button"
              aria-disabled={!canSave || undefined}
              aria-busy={saving || undefined}
              aria-describedby={saveDescribedBy}
              className={cn(!canSave && !saving && "opacity-50")}
              onClick={() => {
                if (!canSave) return;
                clearError();
                save.mutate();
              }}
              data-testid="avatar-editor-save"
            >
              {saving ? <Loader2 aria-hidden="true" className="spinner-busy" /> : null}
              {saving ? AVATAR_EDITOR_COPY.saving : AVATAR_EDITOR_COPY.save}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
