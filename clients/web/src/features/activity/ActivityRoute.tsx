import { RouteStub } from "@/features/common/RouteStub";

/** 활동 (R-1 §1 글로벌 표면 2/2): the agent activity feed, fed by observation events. */
export function ActivityRoute() {
  return (
    <RouteStub
      title="활동"
      headline="에이전트가 무엇을 했는지 한 줄로 읽는 자리입니다."
      points={[
        "각 항목은 '누가 무엇에 무엇을 해서 어떤 결과가 났는지' 한 문장으로 남습니다.",
        "진행 중인 턴은 관측 이벤트에서 나옵니다. 타이핑 표시를 흉내내지 않습니다.",
        "담당자가 함께 표시되어 책임 소재가 목록 단계에서 보입니다.",
      ]}
      testId="activity-route"
    />
  );
}
