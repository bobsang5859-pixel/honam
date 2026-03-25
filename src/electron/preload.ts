import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  selectBackupDir: () => ipcRenderer.invoke('select-backup-dir'),
  selectBackupFile: () => ipcRenderer.invoke('select-backup-file'),
  getDbPath: () => ipcRenderer.invoke('get-db-path'),
  selectExcelFile: () => ipcRenderer.invoke('select-excel-file'),
});
