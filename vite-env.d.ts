/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    selectBackupDir: () => Promise<string | null>;
    selectBackupFile: () => Promise<string | null>;
    getDbPath: () => Promise<string>;
  };
}
