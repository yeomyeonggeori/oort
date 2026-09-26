import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/design/ui/button";
import { KomettoMark } from "@/design/brand/KomettoMark";
import { cn } from "@/design/lib/cn";
import { DeviceLinkCard } from "@/features/settings/DeviceLinkCard";
import {
  collapsePhoneLinkCard,
  dismissPhoneLinkCard,
  readPhoneLinkCard,
  subscribePhoneLinkCard,
} from "./phoneLinkCardStore";
import { PHONE_LINK_CARD_COPY, PHONE_LINK_SETTINGS_HREF } from "./phoneLinkCard";

// Reading this as: first-conversation channel band for internal team users on
// web+Tauri, density 6/10, motion 1/10.

// =============================================================================
// 「폰에서도」 채널 카드 (#2818, ADR-0193 D7).
//
// 예전 전체 화면 단계(`PhoneLinkFirstRun`)를 첫 대화 채널의 컴포저 바로 위 띠로
// 내렸다. 자리는 타임라인 아래라 오프너를 가리지 않는다. 시안은 온보딩 2.0 D5
// `.kband`(코메토 52 · 띠 반경 14 · 안쪽 8/14/8/8 · 틈 12 · 버튼 34)다.
//
// 지속 카드(ADR-0182 ③): 사용자가 치울 때까지 남는다. 시간으로 사라지지 않는다.
// 도착은 문장 칸의 role="status"로 한 번 읽힌다.
// =============================================================================

type Face = "idle" | "sleepy" | "happy";

// -----------------------------------------------------------------------------
// 임시 코메토 (교체 지점). #2807(OB2-1)의 `KomettoFace`와 #2806(OB2-0)의 표정
// 자산이 머지되면 이 함수 대신 `<KomettoFace expression={face} />`를 쓴다.
// 그때까지는 여섯 표정 모두 K6 플랫 배지 한 장이다(#2807 임시본과 같은 규칙).
// 표정 id는 `data-expression`으로 남겨 시험과 캡처가 상태를 잰다. 그림은
// 장식이고 상태는 옆 문장이 말한다(ADR-0193 D11).
// -----------------------------------------------------------------------------
function BandKometto({ face, small = false }: { face: Face; small?: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0",
        small ? "size-8" : "size-kometto-band"
      )}
      data-testid="phone-link-card-kometto"
      data-expression={face}
      aria-hidden="true"
    >
      <KomettoMark className="size-full" />
    </span>
  );
}

const bandActionClass = "h-band-action rounded-md px-3 text-body font-semibold";

export function PhoneLinkChannelCard({
  workspaceId,
  onDismissed,
}: {
  workspaceId: string;
  /** 마지막 [닫기] 뒤 포커스를 돌려줄 자리(컴포저). */
  onDismissed?: () => void;
}) {
  const stored = useSyncExternalStore(
    subscribePhoneLinkCard,
    () => readPhoneLinkCard(workspaceId),
    () => readPhoneLinkCard(workspaceId)
  );
  const [open, setOpen] = useState(false);
  const [linked, setLinked] = useState(false);
  const settingsLinkRef = useRef<HTMLAnchorElement | null>(null);
  // [나중에]를 누른 버튼이 사라지므로, 포커스를 접힌 줄의 「설정 › 기기」로 옮긴다.
  const focusSettingsRef = useRef(false);
  useEffect(() => {
    if (!focusSettingsRef.current || !settingsLinkRef.current) return;
    focusSettingsRef.current = false;
    settingsLinkRef.current.focus();
  });

  // 연결 성공은 저장소에 곧바로 dismissed로 쓴다(다시 서지 않는다). 이번 화면
  // 에서는 기쁨 띠가 [닫기]를 누를 때까지 남는다(③ 무기한, 사용자 해제).
  if (!linked && stored !== "pending" && stored !== "collapsed") return null;

  const later = () => {
    setOpen(false);
    focusSettingsRef.current = true;
    collapsePhoneLinkCard(workspaceId);
  };

  const close = () => {
    setLinked(false);
    dismissPhoneLinkCard(workspaceId);
    onDismissed?.();
  };

  if (!linked && stored === "collapsed") {
    return (
      <div
        className="kometto-band flex items-center gap-3 rounded-lg py-1 pl-2 pr-1"
        data-testid="phone-link-card-collapsed"
      >
        <BandKometto face="sleepy" small />
        <p role="status" className="min-w-0 flex-1 break-keep text-body text-ink-muted">
          <Link
            ref={settingsLinkRef}
            to={PHONE_LINK_SETTINGS_HREF}
            className="touch-target press rounded-sm text-ink underline underline-offset-2 hover:text-ink-muted focus-visible:focus-ring"
            data-testid="phone-link-card-settings"
          >
            {PHONE_LINK_CARD_COPY.collapsedLink}
          </Link>
          {PHONE_LINK_CARD_COPY.collapsedAfter}
        </p>
        <Button
          type="button"
          variant="ghost"
          className={cn(bandActionClass, "text-ink-muted")}
          onClick={close}
          data-testid="phone-link-card-close"
        >
          {PHONE_LINK_CARD_COPY.close}
        </Button>
      </div>
    );
  }

  const face: Face = linked ? "happy" : "idle";
  const title = linked
    ? PHONE_LINK_CARD_COPY.linkedTitle
    : open
      ? PHONE_LINK_CARD_COPY.openTitle
      : PHONE_LINK_CARD_COPY.title;
  const detail = linked
    ? PHONE_LINK_CARD_COPY.linkedDetail
    : PHONE_LINK_CARD_COPY.detail;

  return (
    <section
      className="kometto-band flex flex-col gap-3 rounded-lg bg-signal-soft py-2 pl-2 pr-card"
      aria-label="폰 연결"
      data-testid="phone-link-card"
      data-state={linked ? "linked" : open ? "open" : "idle"}
    >
      <div className="flex flex-wrap items-center gap-3">
        <BandKometto face={face} />
        <div role="status" className="min-w-0 flex-1 break-keep">
          <p className="text-body font-semibold text-ink">{title}</p>
          <p className="text-meta text-ink-muted">{detail}</p>
        </div>
        <div className="kometto-band-actions flex shrink-0 items-center gap-2">
          {linked ? (
            <Button
              type="button"
              variant="ghost"
              className={cn(bandActionClass, "text-ink-muted")}
              onClick={close}
              data-testid="phone-link-card-close"
            >
              {PHONE_LINK_CARD_COPY.close}
            </Button>
          ) : (
            <>
              {!open && (
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(bandActionClass, "border border-line-strong text-ink")}
                  onClick={() => setOpen(true)}
                  data-testid="phone-link-card-create"
                >
                  {PHONE_LINK_CARD_COPY.create}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className={cn(bandActionClass, "text-ink-muted")}
                onClick={later}
                data-testid="phone-link-card-later"
              >
                {PHONE_LINK_CARD_COPY.later}
              </Button>
            </>
          )}
        </div>
      </div>
      {open && !linked && (
        <div className="kometto-band-body flex min-w-0 flex-col items-start">
          <DeviceLinkCard
            autoCreate
            embedded
            onLinked={() => {
              setLinked(true);
              setOpen(false);
              dismissPhoneLinkCard(workspaceId);
            }}
          />
        </div>
      )}
    </section>
  );
}
