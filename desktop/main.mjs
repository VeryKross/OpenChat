import { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let apiServer;
let apiBase = "http://127.0.0.1:4173";

function getActiveWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function emitOpenHelp(topicId) {
  const activeWindow = getActiveWindow();
  if (!activeWindow) return;
  const payload = {
    topicId: typeof topicId === "string" && topicId.trim().length > 0 ? topicId : undefined,
  };
  activeWindow.webContents.send("openchat:open-help", payload);
  const payloadJson = JSON.stringify(payload);
  void activeWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent("openchat:open-help",{detail:${payloadJson}}));`
  );
}

function setupApplicationMenu() {
  const template = [
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "Open Help Center",
          accelerator: "F1",
          click: () => emitOpenHelp(),
        },
        { type: "separator" },
        {
          label: "LLM Setup and Configuration",
          click: () => emitOpenHelp("llm-setup-configuration"),
        },
        {
          label: "MCP Discovery and Connection",
          click: () => emitOpenHelp("mcp-discovery-and-connection"),
        },
        {
          label: "Skills and Custom Skills",
          click: () => emitOpenHelp("skills-and-custom-skills"),
        },
        {
          label: "XRay Guide and Node Glossary",
          click: () => emitOpenHelp("xray-guide"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function pickOutputFolder(webContents, initialPathValue) {
  const initialPath = String(initialPathValue ?? "").trim();
  const fallbackPath = process.env.OPENCHAT_PROJECT_ROOT?.trim() || app.getPath("documents");
  const defaultPath = initialPath || fallbackPath;
  const ownerWindow =
    (webContents ? BrowserWindow.fromWebContents(webContents) : null) ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0] ??
    undefined;
  const filePaths = dialog.showOpenDialogSync(ownerWindow, {
    title: "Choose Artifact Output Folder",
    defaultPath,
    properties: ["openDirectory", "createDirectory"],
  });
  return Array.isArray(filePaths) && filePaths.length > 0 ? filePaths[0] : null;
}

ipcMain.on("openchat:get-api-base", (event) => {
  event.returnValue = apiBase;
});

ipcMain.handle("openchat:api-fetch", async (event, payload) => {
  const rawPath =
    payload && typeof payload === "object" && "path" in payload ? String(payload.path ?? "") : "";
  const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const initSource =
    payload && typeof payload === "object" && "init" in payload && payload.init && typeof payload.init === "object"
      ? payload.init
      : {};
  const init = {
    method: typeof initSource.method === "string" ? initSource.method : undefined,
    headers:
      initSource.headers && typeof initSource.headers === "object"
        ? Object.fromEntries(Object.entries(initSource.headers))
        : undefined,
    body: typeof initSource.body === "string" ? initSource.body : undefined,
  };
  if (normalizedPath === "/api/desktop/choose-output-folder") {
    let initialPath = "";
    if (init.body) {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed && typeof parsed === "object" && "initialPath" in parsed) {
          initialPath = String(parsed.initialPath ?? "").trim();
        }
      } catch {
        initialPath = "";
      }
    }
    const selectedPath = pickOutputFolder(event.sender, initialPath);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({
        path: selectedPath,
      }),
    };
  }
  const response = await fetch(`${apiBase}${normalizedPath}`, init);
  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body,
  };
});

ipcMain.handle("openchat:choose-output-folder", async (event, payload) => {
  const initialPath =
    payload && typeof payload === "object" && "initialPath" in payload
      ? String(payload.initialPath ?? "").trim()
      : "";
  return pickOutputFolder(event.sender, initialPath);
});

async function startApiServer() {
  if (!process.env.OPENCHAT_PROJECT_ROOT?.trim()) {
    process.env.OPENCHAT_PROJECT_ROOT = process.env.OPENCHAT_DEV_URL
      ? path.resolve(__dirname, "..")
      : path.join(app.getPath("documents"), "OpenChat");
  }
  const serverModulePath = path.join(__dirname, "..", "server", "dist", "index.js");
  const serverModuleUrl = pathToFileURL(serverModulePath).href;
  const serverModule = await import(serverModuleUrl);
  if (typeof serverModule.startOpenChatServer !== "function") {
    throw new Error("Unable to load startOpenChatServer from server build output.");
  }
  if (typeof serverModule.setDesktopFolderPicker === "function") {
    serverModule.setDesktopFolderPicker((initialPath) => pickOutputFolder(undefined, initialPath));
  }
  try {
    apiServer = await serverModule.startOpenChatServer(4173, "127.0.0.1");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EADDRINUSE") {
      throw error;
    }
    apiServer = await serverModule.startOpenChatServer(0, "127.0.0.1");
  }
  const address = apiServer.address();
  const port =
    typeof address === "object" && address && "port" in address ? Number(address.port) : 4173;
  apiBase = `http://127.0.0.1:${port}`;
}

async function createMainWindow() {
  const devUrl = process.env.OPENCHAT_DEV_URL?.trim();
  const clientIndexPath = path.join(__dirname, "..", "client", "dist", "index.html");
  const clientIndexUrl = pathToFileURL(clientIndexPath).href;
  const windowIconPath = path.join(__dirname, "assets", "icons", "openchat.png");
  const isAllowedNavigation = (url) => {
    if (devUrl) return url.startsWith(devUrl);
    return url.startsWith(clientIndexUrl);
  };

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: "OpenChat",
    icon: windowIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      additionalArguments: [`--openchat-api-base=${apiBase}`],
    },
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      (input.key === "F1" || input.code === "F1" || String(input.key).toLowerCase() === "f1")
    ) {
      event.preventDefault();
      emitOpenHelp();
    }
  });

  if (devUrl) {
    await window.loadURL(devUrl);
    return;
  }

  await window.loadFile(clientIndexPath);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (apiServer) {
    apiServer.close();
  }
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  setupApplicationMenu();
  await startApiServer();
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}).catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start OpenChat desktop runtime:", error);
  app.quit();
});
