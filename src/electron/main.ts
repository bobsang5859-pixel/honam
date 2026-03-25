import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { randomBytes } from 'crypto';

/**
 * JWT 시크릿을 userData 디렉토리의 파일에서 읽거나, 없으면 생성한다.
 * 소스코드에 시크릿을 하드코딩하지 않기 위함.
 */
function loadOrCreateSecret(userDataPath: string): string {
  const secretFile = path.join(userDataPath, 'jwt-secret.key');
  if (fs.existsSync(secretFile)) {
    return fs.readFileSync(secretFile, 'utf-8').trim();
  }
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
const isDev = !app.isPackaged;

function getDbPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'hospital-supply.db');
}

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const dbPath = getDbPath();
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const jwtSecret = loadOrCreateSecret(app.getPath('userData'));

    const env = {
      ...process.env,
      DATABASE_URL: `file:${dbPath}`,
      PORT: '4900',
      JWT_SECRET: jwtSecret,
      NODE_ENV: isDev ? 'development' : 'production',
      FONTS_DIR: isDev ? path.join(__dirname, '..', 'fonts') : path.join(process.resourcesPath!, 'fonts'),
      PRISMA_DIR: isDev ? path.join(__dirname, '..', 'prisma') : path.join(process.resourcesPath!, 'prisma'),
      USER_DATA_PATH: app.getPath('userData'),
      DIST_PATH: isDev ? path.join(__dirname, '..', '..', 'dist') : path.join(process.resourcesPath!, 'app', 'dist'),
    };

    const serverPath = isDev
      ? path.join(__dirname, '..', 'src', 'server', 'index.ts')
      : path.join(__dirname, 'server', 'index.js');

    if (isDev) {
      const tsNode = require.resolve('ts-node/dist/bin.js');
      serverProcess = spawn(process.execPath, [tsNode, serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      serverProcess = spawn(process.execPath, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    }

    serverProcess.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString();
      console.log('[Server]', msg);
      if (msg.includes('Server running on port')) resolve();
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[Server Error]', data.toString());
    });

    serverProcess.on('error', reject);

    // Timeout resolve after 10 seconds anyway
    setTimeout(resolve, 10000);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: '병원물품관리 시스템',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('http://localhost:4900');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers for native dialogs
ipcMain.handle('select-backup-dir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '백업 저장 폴더 선택',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-backup-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: '복구할 백업 파일 선택',
    filters: [{ name: 'Database', extensions: ['db'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-db-path', () => getDbPath());

ipcMain.handle('select-excel-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: '엑셀 파일 선택',
    filters: [
      { name: 'Excel 파일', extensions: ['xlsx', 'xls', 'csv'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    await startServer();
    await createWindow();
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});
