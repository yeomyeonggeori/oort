import type { ScheduledPlace } from "@momo/core/features/scheduled/model";

/**
 * 「예약됨」 목록을 한 곳으로 거른 채 여는 주소. 입력창 배너의 「보기」가 연다: 채널이면 `?channel=<id>`, 스레드면
 * `&thread=<rootId>`가 더해진다. 목록 화면(`ScheduledRoute`)이 같은 두 키를 읽는다.
 */
export function scheduledListPath(place: ScheduledPlace): string {
  const params = new URLSearchParams({ channel: place.channelId });
  if (place.rootId !== undefined) params.set("thread", place.rootId);
  return `/scheduled?${params.toString()}`;
}
