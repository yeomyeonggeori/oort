const SERVER_URL_KEY = "momo.web.server-url.v1";

function defaultServerUrl(): string {
  return window.location.origin;
}

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("서버 주소를 https://부터 입력해 주세요.");
  }
  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
    throw new Error("HTTPS 서버 주소가 필요합니다. localhost만 HTTP를 허용합니다.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("경로와 계정 정보 없이 서버 주소만 입력해 주세요.");
  }
  return url.origin;
}

export function getServerUrl(): string {
  try {
    const stored = localStorage.getItem(SERVER_URL_KEY);
    return stored === null ? defaultServerUrl() : normalizeServerUrl(stored);
  } catch {
    return defaultServerUrl();
  }
}

export function saveServerUrl(value: string): string {
  const normalized = normalizeServerUrl(value);
  localStorage.setItem(SERVER_URL_KEY, normalized);
  return normalized;
}

export function apiUrl(path: string): string {
  return new URL(path, `${getServerUrl()}/`).toString();
}

export async function verifyServer(value: string): Promise<string> {
  const normalized = normalizeServerUrl(value);
  const response = await fetch(new URL("/health", `${normalized}/`), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`서버 상태 확인이 실패했습니다 (HTTP ${response.status}).`);
  }
  return saveServerUrl(normalized);
}
