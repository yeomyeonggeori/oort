export {
  workExecutionLocation as workConsoleLocation,
  type WorkExecutionLocation as WorkConsoleLocation,
  type WorkExecutionLocationKey as WorkConsoleLocationKey,
} from "@momo/core/features/work/workLocation";

/** 한 작업 세션을 새로고침·붙여넣기에도 살아 있는 상세 주소로 만든다. */
export function workConsoleSessionPath(sessionId: string): string {
  return `/work?session=${encodeURIComponent(sessionId.toLowerCase())}`;
}
