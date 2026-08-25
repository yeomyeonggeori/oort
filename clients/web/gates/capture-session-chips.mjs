#!/usr/bin/env node
// TC-1 (#1758): 세션 칩 증거는 `scripts/capture-session-chips.mjs` 에 산다.
// 7종 루프가 `node gates/capture-session-chips.mjs` 로 돌리므로 여기서 위임한다.
import "../scripts/capture-session-chips.mjs";
