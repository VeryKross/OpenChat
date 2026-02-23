export {};

declare global {
  interface OpenChatDesktopRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  interface OpenChatDesktopResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
    body: string;
  }

  interface Window {
    openchatDesktop?: {
      apiBase: string;
      isDesktop: boolean;
      apiRequest?: (path: string, init?: OpenChatDesktopRequestInit) => Promise<OpenChatDesktopResponse>;
      chooseOutputFolder?: (initialPath?: string) => Promise<string | null>;
    };
  }
}
