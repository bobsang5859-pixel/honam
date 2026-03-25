"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const crypto_1 = require("crypto");
/**
 * JWT 시크릿을 userData 디렉토리의 파일에서 읽거나, 없으면 생성한다.
 * 소스코드에 시크릿을 하드코딩하지 않기 위함.
 */
function loadOrCreateSecret(userDataPath) {
    const secretFile = path.join(userDataPath, 'jwt-secret.key');
    if (fs.existsSync(secretFile)) {
        return fs.readFileSync(secretFile, 'utf-8').trim();
    }
    const secret = (0, crypto_1.randomBytes)(32).toString('hex');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    return secret;
}
let mainWindow = null;
let serverProcess = null;
const isDev = !electron_1.app.isPackaged;
function getDbPath() {
    const userDataPath = electron_1.app.getPath('userData');
    return path.join(userDataPath, 'hospital-supply.db');
}
function startServer() {
    return new Promise((resolve, reject) => {
        const dbPath = getDbPath();
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir))
            fs.mkdirSync(dbDir, { recursive: true });
        const jwtSecret = loadOrCreateSecret(electron_1.app.getPath('userData'));
        const env = {
            ...process.env,
            DATABASE_URL: `file:${dbPath}`,
            PORT: '4900',
            JWT_SECRET: jwtSecret,
            NODE_ENV: isDev ? 'development' : 'production',
            FONTS_DIR: isDev ? path.join(__dirname, '..', 'fonts') : path.join(process.resourcesPath, 'fonts'),
            PRISMA_DIR: isDev ? path.join(__dirname, '..', 'prisma') : path.join(process.resourcesPath, 'prisma'),
            USER_DATA_PATH: electron_1.app.getPath('userData'),
            DIST_PATH: isDev ? path.join(__dirname, '..', '..', 'dist') : path.join(process.resourcesPath, 'app', 'dist'),
        };
        const serverPath = isDev
            ? path.join(__dirname, '..', 'src', 'server', 'index.ts')
            : path.join(__dirname, 'server', 'index.js');
        if (isDev) {
            const tsNode = require.resolve('ts-node/dist/bin.js');
            serverProcess = (0, child_process_1.spawn)(process.execPath, [tsNode, serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        }
        else {
            serverProcess = (0, child_process_1.spawn)(process.execPath, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        }
        serverProcess.stdout?.on('data', (data) => {
            const msg = data.toString();
            console.log('[Server]', msg);
            if (msg.includes('Server running on port'))
                resolve();
        });
        serverProcess.stderr?.on('data', (data) => {
            console.error('[Server Error]', data.toString());
        });
        serverProcess.on('error', reject);
        // Timeout resolve after 10 seconds anyway
        setTimeout(resolve, 10000);
    });
}
async function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
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
    }
    else {
        mainWindow.loadURL('http://localhost:4900');
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
// IPC handlers for native dialogs
electron_1.ipcMain.handle('select-backup-dir', async () => {
    const result = await electron_1.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '백업 저장 폴더 선택',
    });
    return result.canceled ? null : result.filePaths[0];
});
electron_1.ipcMain.handle('select-backup-file', async () => {
    const result = await electron_1.dialog.showOpenDialog({
        properties: ['openFile'],
        title: '복구할 백업 파일 선택',
        filters: [{ name: 'Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePaths[0];
});
electron_1.ipcMain.handle('get-db-path', () => getDbPath());
electron_1.ipcMain.handle('select-excel-file', async () => {
    const result = await electron_1.dialog.showOpenDialog({
        properties: ['openFile'],
        title: '엑셀 파일 선택',
        filters: [
            { name: 'Excel 파일', extensions: ['xlsx', 'xls', 'csv'] },
            { name: '모든 파일', extensions: ['*'] },
        ],
    });
    return result.canceled ? null : result.filePaths[0];
});
electron_1.app.whenReady().then(async () => {
    try {
        await startServer();
        await createWindow();
    }
    catch (err) {
        console.error('Failed to start:', err);
        electron_1.app.quit();
    }
});
electron_1.app.on('window-all-closed', () => {
    if (serverProcess)
        serverProcess.kill();
    electron_1.app.quit();
});
electron_1.app.on('before-quit', () => {
    if (serverProcess)
        serverProcess.kill();
});
//# sourceMappingURL=main.js.map