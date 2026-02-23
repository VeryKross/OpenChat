import { contextBridge, ipcRenderer } from "electron";

const apiBaseArgPrefix = "--openchat-api-base=";
const apiBaseArg = process.argv.find((arg) => arg.startsWith(apiBaseArgPrefix));
const apiBaseFromArgs = apiBaseArg ? apiBaseArg.slice(apiBaseArgPrefix.length) : "";
let apiBaseFromMain = "";
try {
  const value = ipcRenderer.sendSync("openchat:get-api-base");
  apiBaseFromMain = typeof value === "string" ? value : "";
} catch {
  apiBaseFromMain = "";
}
const apiBase = (apiBaseFromMain || apiBaseFromArgs).trim();
const OPEN_HELP_EVENT = "openchat:open-help";

ipcRenderer.on("openchat:open-help", (_event, payload) => {
  const topicId =
    payload && typeof payload === "object" && "topicId" in payload
      ? String(payload.topicId ?? "").trim()
      : "";
  window.dispatchEvent(
    new CustomEvent(OPEN_HELP_EVENT, {
      detail: { topicId: topicId || undefined },
    })
  );
});

contextBridge.exposeInMainWorld("openchatDesktop", {
  apiBase,
  isDesktop: true,
  apiRequest: (path, init) => ipcRenderer.invoke("openchat:api-fetch", { path, init }),
  chooseOutputFolder: (initialPath) =>
    ipcRenderer.invoke("openchat:choose-output-folder", { initialPath }),
});
