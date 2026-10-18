import { describe, expect, it } from "vitest";
import {
  pluginConnectionLabel,
  pluginConnectionState,
  type PluginConnectionInput,
} from "./connectionState";

const base: PluginConnectionInput = { installed: true, enabled: true, allowedToolCount: 0 };

describe("앱 연결 상태 네 칸 중 1·2칸", () => {
  it("설치되지 않았으면 허용 도구 수와 상관없이 1칸(미설치)이다", () => {
    expect(pluginConnectionState({ installed: false, enabled: false, allowedToolCount: 0 })).toBe("notInstalled");
    // 설치 행이 없는데 정책이 도구를 싣는 일은 없어야 하지만, 있어도 설치 없이 허용됨이라고 말하지 않는다.
    expect(pluginConnectionState({ installed: false, enabled: false, allowedToolCount: 3 })).toBe("notInstalled");
  });

  it("설치돼 있고 내가 허용한 도구가 없으면 2칸이다", () => {
    expect(pluginConnectionState(base)).toBe("installedNotAllowed");
    expect(pluginConnectionLabel(base)).toBe("설치됨 · 내 허용 없음");
  });

  it("허용한 도구가 있으면 허용 읽기다. 3·4칸은 실행 장소 입력이 생길 때까지 가르지 않는다", () => {
    const allowed = { ...base, allowedToolCount: 2 };
    expect(pluginConnectionState(allowed)).toBe("allowed");
    expect(pluginConnectionLabel(allowed)).toBe("설치됨 · 내가 허용함");
  });

  it("꺼진 설치는 허용한 적 없다고 말하지 않는다(서버는 꺼진 설치의 grant를 세지 않는다)", () => {
    const disabled = { installed: true, enabled: false, allowedToolCount: 0 };
    expect(pluginConnectionState(disabled)).toBe("installedNotAllowed");
    expect(pluginConnectionLabel(disabled)).toBe("설치했지만 비활성");
    // 꺼진 설치 위에 정책이 도구를 싣는 모순이 와도 허용됨으로 읽지 않는다.
    expect(pluginConnectionState({ ...disabled, allowedToolCount: 2 })).toBe("installedNotAllowed");
  });

  it("미설치 이름은 설치됨 이름과 다르다", () => {
    expect(pluginConnectionLabel({ installed: false, enabled: false, allowedToolCount: 0 })).toBe("미설치");
  });
});
