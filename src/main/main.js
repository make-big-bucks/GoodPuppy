const { app, BrowserWindow, Menu, Tray, ipcMain, screen } = require("electron");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const {
  currentUser,
  presence: presenceConfig,
  supabase: supabaseConfig,
  userConfigs
} = require("../shared/appConfig");

const PET_WINDOW_WIDTH = 780;
const PET_WINDOW_HEIGHT = 340;

app.disableHardwareAcceleration();

let mainWindow;
let supabaseClient;
let remoteMessagesChannels = [];
let presenceChannel;
let presenceHeartbeatTimer;
let tray;

function getIconPath() {
  return path.join(__dirname, "../../img/dog.ico");
}

function setTrayMenu() {
  if (!tray) {
    return;
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "\u9000\u51fa",
        click: () => {
          app.quit();
        }
      }
    ])
  );
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    minWidth: PET_WINDOW_WIDTH,
    minHeight: PET_WINDOW_HEIGHT,
    maxWidth: PET_WINDOW_WIDTH,
    maxHeight: PET_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer:load-failed] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:gone] ${details.reason}`);
  });
  mainWindow.on("resize", () => {
    mainWindow.setSize(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT, false);
  });
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function createTray() {
  tray = new Tray(getIconPath());
  tray.setToolTip("GoodPuppy");
  setTrayMenu();
}

function getSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  supabaseClient = createClient(supabaseConfig.url, supabaseConfig.apiKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return supabaseClient;
}

function sendPresenceToRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("presence:update", payload);
  }
}

function getPresencePayload(row) {
  const presenceUserId = row?.[presenceConfig.userIdColumn];
  const userEntry = Object.entries(userConfigs).find(
    ([, userConfig]) => userConfig.presenceId === presenceUserId
  );
  const userId = userEntry?.[0];

  if (!userId || !userConfigs[userId]) {
    return null;
  }

  const updatedAt = row[presenceConfig.updatedAtColumn];
  const updatedTime = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  const isFresh = Number.isFinite(updatedTime)
    ? Date.now() - updatedTime <= presenceConfig.staleAfterMs
    : true;

  return {
    user: userId,
    isOnline: row[presenceConfig.onlineColumn] !== false && isFresh,
    updatedAt: updatedAt || null
  };
}

function createPresenceRow(isOnline) {
  return {
    [presenceConfig.userIdColumn]: userConfigs[currentUser].presenceId,
    [presenceConfig.onlineColumn]: isOnline,
    [presenceConfig.updatedAtColumn]: new Date().toISOString()
  };
}

async function setCurrentUserPresence(isOnline) {
  const supabase = getSupabaseClient();
  const row = createPresenceRow(isOnline);
  const presenceId = userConfigs[currentUser].presenceId;

  const updateResult = await supabase
    .from(presenceConfig.tableName)
    .update(row)
    .eq(presenceConfig.userIdColumn, presenceId)
    .select();

  if (updateResult.error) {
    throw updateResult.error;
  }

  if (updateResult.data?.length > 0) {
    return;
  }

  const insertResult = await supabase.from(presenceConfig.tableName).insert(row).select();

  if (insertResult.error && insertResult.error.code !== "23505") {
    throw insertResult.error;
  }
}

async function fetchPresenceSnapshot() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from(presenceConfig.tableName).select("*");

  if (error) {
    throw error;
  }

  data.forEach((row) => {
    const payload = getPresencePayload(row);

    if (payload) {
      sendPresenceToRenderer(payload);
    }
  });
}

async function startPresenceSync() {
  const supabase = getSupabaseClient();

  presenceChannel = supabase
    .channel(`good-puppy-${presenceConfig.tableName}-changes`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: presenceConfig.tableName
      },
      (payload) => {
        const row = payload.new || payload.old;
        const presencePayload = getPresencePayload(row);

        if (presencePayload) {
          sendPresenceToRenderer(presencePayload);
        }
      }
    )
    .subscribe((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("presence:status", {
          tableName: presenceConfig.tableName,
          status
        });
      }
    });

  await setCurrentUserPresence(true);
  await fetchPresenceSnapshot();

  presenceHeartbeatTimer = setInterval(() => {
    setCurrentUserPresence(true).catch((error) => console.error(error));
  }, presenceConfig.heartbeatMs);
}

async function stopPresenceSync() {
  const supabase = getSupabaseClient();

  if (presenceHeartbeatTimer) {
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
  }

  if (presenceChannel) {
    await supabase.removeChannel(presenceChannel);
    presenceChannel = null;
  }

  await setCurrentUserPresence(false);
}

async function startRemoteMessageSubscription() {
  const supabase = getSupabaseClient();

  if (remoteMessagesChannels.length > 0) {
    await Promise.all(remoteMessagesChannels.map((channel) => supabase.removeChannel(channel)));
    remoteMessagesChannels = [];
  }

  remoteMessagesChannels = Object.entries(userConfigs)
    .filter(([userId]) => userId !== currentUser)
    .map(([userId, userConfig]) =>
      supabase
        .channel(`good-puppy-${userConfig.tableName}-inserts`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: userConfig.tableName
          },
          (payload) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("remote-message:insert", {
                user: userId,
                side: userConfig.side,
                message: payload.new
              });
            }
          }
        )
        .subscribe((status) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("remote-message:status", {
              user: userId,
              tableName: userConfig.tableName,
              status
            });
          }
        })
  );
}

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  startRemoteMessageSubscription().catch((error) => {
    console.error(error);
  });
  startPresenceSync().catch((error) => {
    console.error(error);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  event.preventDefault();
  stopPresenceSync()
    .catch((error) => console.error(error))
    .finally(() => app.exit(0));
});

ipcMain.on("pet-window:set-position", (event, position) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window || typeof position?.x !== "number" || typeof position?.y !== "number") {
    return;
  }

  window.setBounds(
    {
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT
    },
    false
  );
});

ipcMain.handle("pet-window:get-position", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window) {
    return { x: 0, y: 0 };
  }

  const [x, y] = window.getPosition();
  return { x, y };
});

ipcMain.handle("pet-window:get-layout", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window) {
    return {
      windowBounds: { x: 0, y: 0, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      workArea: { x: 0, y: 0, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT }
    };
  }

  const windowBounds = window.getBounds();
  const display = screen.getDisplayMatching(windowBounds);

  return {
    windowBounds,
    workArea: display.workArea
  };
});

ipcMain.on("pet-window:set-ignore-mouse-events", (event, shouldIgnore) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window || typeof shouldIgnore !== "boolean") {
    return;
  }

  window.setIgnoreMouseEvents(shouldIgnore, { forward: true });
});
