"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    selectBackupDir: () => electron_1.ipcRenderer.invoke('select-backup-dir'),
    selectBackupFile: () => electron_1.ipcRenderer.invoke('select-backup-file'),
    getDbPath: () => electron_1.ipcRenderer.invoke('get-db-path'),
    selectExcelFile: () => electron_1.ipcRenderer.invoke('select-excel-file'),
});
//# sourceMappingURL=preload.js.map