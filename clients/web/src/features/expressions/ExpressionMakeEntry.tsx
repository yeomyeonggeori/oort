import { useState } from "react";
import { ExpressionMakeForm } from "./ExpressionMakeForm";
import { ExpressionPhotoForm } from "./ExpressionPhotoForm";

/**
 * 「AI와 만들기」의 입구(ADR-0218 §8 H9, #4941). 기본은 팀에 연결된 이미지 모델로 사진을 바로 만드는
 * 양식이고, 에이전트에게 부탁하는 길(#4820 B, 대화로 요청을 보내고 승인 카드로 받는다)은 그 양식
 * 안의 단추 하나로 남는다.
 */
export function ExpressionMakeEntry({ onImport, onDone, onClose }: { onImport: () => void; onDone: () => void; onClose?: () => void }) {
  const [agent, setAgent] = useState(false);
  return agent
    ? <ExpressionMakeForm onImport={onImport} onClose={onClose} />
    : <ExpressionPhotoForm onImport={onImport} onAgent={() => setAgent(true)} onDone={onDone} onClose={onClose} />;
}
