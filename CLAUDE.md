# Claude Code 진입점

@AGENTS.md

위 공용 계약이 기획·검수·구현 모두에 적용된다. 모델과 역할은 [PIPELINE](docs/planning/PIPELINE.md)에서 확인한다.

SessionStart 훅이 `scripts/planning_context.sh`의 읽기 전용 복원 출력을 제공한다. 훅이 없는 환경에서는 기획 시작·인계 시 직접 실행한다. 이미 복원된 내용을 매 수정마다 다시 읽지 않는다. 개인 메모리·`claudedocs/`를 공용 현재 상태의 대체물로 사용하지 않는다.
