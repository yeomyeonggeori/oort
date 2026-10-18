// =============================================================================
// 앱 연결 상태 네 칸 (#3943 U-2, ADR-0113 증보 2 E1, plugins-v2 계획 2.5절).
//
// 한 앱이 한 사람 앞에서 서 있는 자리는 네 칸이다.
//   1. 미설치                       워크스페이스에 아직 설치되지 않았다.
//   2. 설치됨 · 내 허용 없음        설치돼 있지만 내가 허용한 도구가 없다.
//   3. 허용됨 · 실행 장소 꺼짐      내가 허용했는데 도구를 돌릴 실행 장소가 꺼져 있다.
//   4. 사용 중                      허용했고 실행 장소가 켜져 있다.
//
// **앱 목록, 채팅의 @ 메뉴·/ 메뉴, 결과 카드가 모두 이 함수 하나를 읽는다.** 화면마다 「설치됐나」,
// 「허용했나」를 따로 계산하면 한 앱이 목록에서는 허용됨이고 메뉴에서는 허용 없음인 날이 온다.
//
// 이 티켓(U-2)이 재는 것은 1·2칸이다. 3·4칸을 가르려면 실행 장소의 온라인 여부가 입력으로
// 필요하고, 그 입력은 아직 없다(#3949 U-S1·#3950 U-S2가 만든다). 그래서 지금은 「허용했다」를
// 세 번째 읽기(`allowed`)로 묶어 돌려주고, 두 티켓이 이 한 값을 3·4칸으로 쪼갠다. 없는 입력을
// 짐작해서 「사용 중」이라고 하지 않는다.
// =============================================================================

/** 이 읽기가 가를 수 있는 칸. `allowed`는 3·4칸이 아직 갈리지 않은 묶음이다. */
export type PluginConnectionState = "notInstalled" | "installedNotAllowed" | "allowed";

export interface PluginConnectionInput {
  /** 카탈로그의 `installed`. 워크스페이스의 사실이다. */
  installed: boolean;
  /** 카탈로그의 `enabled`. 꺼진 설치는 서버가 grant를 세지 않는다. */
  enabled: boolean;
  /**
   * 서버의 실효 정책(`toolPolicy`)이 이 앱에 대해 싣는, 호출한 사람이 쓸 수 있는 도구 수.
   * 설치가 꺼져 있으면 서버가 0을 준다.
   */
  allowedToolCount: number;
}

export function pluginConnectionState(input: PluginConnectionInput): PluginConnectionState {
  if (!input.installed) return "notInstalled";
  if (input.enabled && input.allowedToolCount > 0) return "allowed";
  return "installedNotAllowed";
}

/**
 * 칸의 이름. 꺼진 설치는 「내 허용 없음」이라고 말하면 허용한 적이 없다는 주장이 된다(서버는 꺼진
 * 설치의 grant를 세지 않을 뿐이다). 그래서 이름이 따로 선다.
 */
export function pluginConnectionLabel(input: PluginConnectionInput): string {
  const state = pluginConnectionState(input);
  if (state === "notInstalled") return "미설치";
  if (state === "allowed") return "설치됨 · 내가 허용함";
  return input.enabled ? "설치됨 · 내 허용 없음" : "설치했지만 비활성";
}
