const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gamebinder", {
  print: (expectedPages) => ipcRenderer.invoke("gamebinder:print", Number(expectedPages) || 0),
  onPrintProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("gamebinder:print-progress", listener);
    return () => ipcRenderer.removeListener("gamebinder:print-progress", listener);
  },
  connectSteam: (steamId) => ipcRenderer.invoke("gamebinder:steam-connect", steamId),
  onSteamProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("gamebinder:steam-progress", listener);
    return () => ipcRenderer.removeListener("gamebinder:steam-progress", listener);
  }
});
