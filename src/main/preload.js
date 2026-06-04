const { contextBridge, ipcRenderer } = require("electron");
const appConfig = require("../shared/appConfig");

function getSerializableAppConfig() {
  return {
    currentUser: appConfig.currentUser,
    presence: appConfig.presence,
    supabase: appConfig.supabase,
    userConfigs: appConfig.userConfigs
  };
}

contextBridge.exposeInMainWorld("goodPuppy", {
  getWindowPosition: () => ipcRenderer.invoke("pet-window:get-position"),
  getWindowLayout: () => ipcRenderer.invoke("pet-window:get-layout"),
  setWindowPosition: (position) => ipcRenderer.send("pet-window:set-position", position),
  setIgnoreMouseEvents: (shouldIgnore) =>
    ipcRenderer.send("pet-window:set-ignore-mouse-events", shouldIgnore),
  getAppConfig: () => getSerializableAppConfig(),
  onRemoteMessage: (callback) => {
    ipcRenderer.on("remote-message:insert", (_event, payload) => callback(payload));
  },
  onRemoteMessageStatus: (callback) => {
    ipcRenderer.on("remote-message:status", (_event, status) => callback(status));
  },
  onPresenceUpdate: (callback) => {
    ipcRenderer.on("presence:update", (_event, payload) => callback(payload));
  },
  onPresenceStatus: (callback) => {
    ipcRenderer.on("presence:status", (_event, status) => callback(status));
  }
});
