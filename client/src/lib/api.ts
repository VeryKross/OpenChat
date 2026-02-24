/**
 * Provides a runtime-aware API fetch layer used by the client in both browser and desktop-hosted modes.
 * Depends on the desktop preload bridge (`window.openchatDesktop`) when available, with fetch fallback otherwise.
 */
function isDesktopLikeRuntime() {
  return window.location.protocol === "file:" || Boolean(window.openchatDesktop?.isDesktop);
}

function toDesktopInit(init?: RequestInit): OpenChatDesktopRequestInit | undefined {
  if (!init) return undefined;
  const headers = init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined;
  return {
    method: init.method,
    headers,
    body: typeof init.body === "string" ? init.body : undefined,
  };
}

function fromDesktopResponse(response: OpenChatDesktopResponse) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function getApiBaseUrl() {
  const desktopApiBase = window.openchatDesktop?.apiBase?.trim();
  if (desktopApiBase) return desktopApiBase.replace(/\/$/, "");
  if (isDesktopLikeRuntime()) return "http://127.0.0.1:4173";
  return "";
}

/**
 * Executes API requests using desktop IPC when present, otherwise falls back to direct HTTP with localhost retries.
 */
export async function apiFetch(path: string, init?: RequestInit) {
  if (isDesktopLikeRuntime() && window.openchatDesktop?.apiRequest) {
    const response = await window.openchatDesktop.apiRequest(path, toDesktopInit(init));
    return fromDesktopResponse(response);
  }

  const primaryBase = getApiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const candidates = [primaryBase];
  if (isDesktopLikeRuntime()) {
    candidates.push("http://127.0.0.1:4173", "http://localhost:4173");
  }

  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
  if (uniqueCandidates.length === 0) {
    return fetch(normalizedPath, init);
  }

  let lastError: unknown;
  for (const base of uniqueCandidates) {
    try {
      return await fetch(`${base}${normalizedPath}`, init);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenChat API request failed.");
}
