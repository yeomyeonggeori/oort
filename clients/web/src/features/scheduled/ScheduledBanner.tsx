import { CircleAlert, Clock } from "lucide-react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { SCHEDULED_COPY, type PlaceWord } from "@momo/core/features/scheduled/copy";
import {
  bannerLine,
  scheduledBanner,
  type ScheduledPlace as ScheduledBannerPlace,
} from "@momo/core/features/scheduled/model";
import { InlineBanner } from "@/features/common/States";
import { scheduledListPath } from "./scheduledPaths";
import { useScheduled } from "./useScheduled";

// =============================================================================
// 입력창 위의 예약 배너 (UI 명세 1.6, ADR-0208 D8, #4215). 토스트가 금지된 자리에서 「다시 찾는 길」은 시간으로
// 사라지지 않는 지속 카드다(ADR-0182 ③).
//
//   (a) 대기   「이 채널에 예약된 메시지 2개」          neutral · `role="status"` · 시계 아이콘
//   (b) 스레드 「이 스레드에 예약된 메시지 1개」        스레드 패널은 그 스레드(`rootId`)의 것만 센다
//   (c) 실패   「예약한 메시지 1개를 보내지 못했어요」  위험 어조 · `role="alert"` · 느낌표 아이콘
//
// 실패가 하나라도 있으면 (c) 한 줄만 선다((a) 대신). 0개면 배너가 없다. (a)는 개수가 바뀔 때 한 번 읽히고 (c)는
// 생길 때 읽힌다. 「보기」는 목록을 그 채널(스레드면 그 스레드)로 거른 채 연다. 이벤트가 도착하면 즉시 바뀐다:
// `sessions_ended`로 멈춘 예약이 멈춘 즉시 실패 어조로 선다(owner 결정 6).
//
// 라우터가 없는 호스트(입력창을 라우터 밖에서 그리는 시험)에서는 「보기」 단추를 세우지 않는다: 갈 곳이 없다.
// =============================================================================

interface BannerProps {
  place: ScheduledBannerPlace;
  word: PlaceWord;
  testId: string;
  /** 호스트가 정하는 바깥 여백. 스레드 입력창은 배너가 입력 틀 바로 위에 닿아서 아래 여백을 준다. */
  className?: string;
}

function BannerBody({
  place,
  word,
  testId,
  className,
  onOpen,
}: BannerProps & { onOpen?: () => void }) {
  const { rows, surface } = useScheduled();
  if (surface === "absent") return null;
  const banner = scheduledBanner(rows, place);
  if (banner === null) return null;
  const failed = banner.tone === "failed";
  return (
    <InlineBanner
      tone={failed ? "error" : "neutral"}
      icon={
        failed ? (
          <CircleAlert className="size-4" />
        ) : (
          <Clock className="size-4 text-ink-muted" />
        )
      }
      // 좁은 칸(320px 스레드 패널)에서 한 줄이 넘으면 두 줄이 비슷한 길이로 접힌다(`text-balance`, `PauseBanner`와 같은
      // 처방): 안 그러면 「1개」나 「못했어요」가 홀로 다음 줄에 남는다(design-review #4215 M3).
      message={<span className="block text-balance">{bannerLine(banner, word)}</span>}
      {...(onOpen === undefined ? {} : { actionLabel: SCHEDULED_COPY.banner.action, onAction: onOpen })}
      separator={false}
      {...(className === undefined ? {} : { className })}
      testId={testId}
    />
  );
}

function RoutedBanner(props: BannerProps) {
  const navigate = useNavigate();
  return <BannerBody {...props} onOpen={() => navigate(scheduledListPath(props.place))} />;
}

/** 입력창 바로 위 배너. `place`는 채널 화면이면 `{channelId}`, 스레드 패널이면 `{channelId, rootId}`. */
export function ScheduledBanner(props: BannerProps) {
  const inRouter = useInRouterContext();
  return inRouter ? <RoutedBanner {...props} /> : <BannerBody {...props} />;
}
