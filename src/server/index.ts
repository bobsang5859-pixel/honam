import express from 'express';
import cors from 'cors';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import fs from 'fs';

const PORT = parseInt(process.env.PORT || '4900');
const DATABASE_URL = process.env.DATABASE_URL || 'file:./hospital-supply.db';
process.env.DATABASE_URL = DATABASE_URL;

// Run migrations on startup
const prismaDir = process.env.PRISMA_DIR || path.join(__dirname, '..', '..', 'prisma');
const prismaBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma');
try {
  console.log('Running database migrations...');
  execSync(
    `"${prismaBin}" migrate deploy --schema="${path.join(prismaDir, 'schema.prisma')}"`,
    { env: { ...process.env, DATABASE_URL }, stdio: 'inherit' }
  );
  console.log('Migrations complete.');
} catch (e) {
  console.log('Migration deploy failed, trying db push...');
  try {
    execSync(
      `"${prismaBin}" db push --accept-data-loss --schema="${path.join(prismaDir, 'schema.prisma')}"`,
      { env: { ...process.env, DATABASE_URL }, stdio: 'inherit' }
    );
    console.log('DB push complete.');
  } catch (e2) {
    console.error('DB push also failed:', (e2 as Error).message);
  }
}

export const prisma = new PrismaClient();

// Backward compatibility for legacy DBs that may miss this column.
prisma.$executeRawUnsafe('ALTER TABLE users ADD COLUMN menu_permissions TEXT').catch(() => {});
prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL;').catch(() => {});

// 중앙창고 → 총무구매 창고 이름 변경 (idempotent)
prisma.$executeRawUnsafe(`UPDATE departments SET name='총무구매 창고' WHERE code='CENTRAL' AND name='중앙창고'`).catch(() => {});
prisma.$executeRawUnsafe(`UPDATE inventory_locations SET name='총무구매 창고' WHERE code='CENTRAL' AND name='중앙창고'`).catch(() => {});

// DECEASED → DISCHARGED 마이그레이션 (사망 상태 제거, 퇴원+사유로 통합)
prisma.$executeRawUnsafe(`UPDATE patients SET status='DISCHARGED', note=COALESCE(note,'') || CASE WHEN note IS NOT NULL AND note!='' THEN char(10) ELSE '' END || '[퇴원사유] 사망' WHERE status='DECEASED'`).catch(() => {});
prisma.$executeRawUnsafe(`UPDATE ward_room_boards SET status='DISCHARGED' WHERE status='DECEASED'`).catch(() => {});

// ── 권한 마이그레이션: 기존 세분화 권한 → 탭 단위 5개 권한 (idempotent) ──
(async () => {
  try {
    const PERM_MAP: Record<string, string> = {
      MASTER_WRITE: 'BASIC_MANAGE',
      BASELINE_WRITE: 'BASIC_MANAGE',
      USER_MANAGE: 'BASIC_MANAGE',
      AUDIT_VIEW: 'BASIC_MANAGE',
      WARD_REQUEST_CREATE: 'REQUEST_USE',
      WARD_REQUEST_VIEW_ALL: 'PURCHASE_MANAGE',
      APPROVAL_DECIDE: 'PURCHASE_MANAGE',
      PO_CREATE: 'PURCHASE_MANAGE',
      PO_SEND: 'PURCHASE_MANAGE',
      STOCK_IN_EXECUTE: 'PURCHASE_MANAGE',
      STOCK_OUT_EXECUTE: 'PURCHASE_MANAGE',
      INVENTORY_VIEW: 'PURCHASE_MANAGE',
      INVENTORY_WRITE: 'PURCHASE_MANAGE',
      ACCOUNTING_VIEW: 'STATS_VIEW',
      ACCOUNTING_CLOSE: 'STATS_VIEW',
      STATS_WRITE: 'STATS_VIEW',
      MEDICAL_AFFAIRS_VIEW: 'PATIENT_MANAGE',
    };
    const users = await prisma.user.findMany({ select: { id: true, direct_permissions: true } });
    for (const u of users) {
      if (!u.direct_permissions) continue;
      let perms: string[];
      try { perms = JSON.parse(u.direct_permissions); } catch { continue; }
      const hasOld = perms.some(p => p in PERM_MAP);
      if (!hasOld) continue;
      const newPerms = [...new Set(perms.map(p => PERM_MAP[p] || p))];
      await prisma.user.update({ where: { id: u.id }, data: { direct_permissions: JSON.stringify(newPerms) } });
    }
    console.log('Permission migration complete.');
  } catch (e) {
    console.error('Permission migration error:', e);
  }
})();

const app = express();
// CORS: 사설 네트워크(LAN) 전체 허용
app.use(cors({
  origin: (origin, callback) => {
    // origin이 없는 경우 = Electron 앱 내부 또는 same-origin 요청 → 허용
    if (!origin) return callback(null, true);
    try {
      const url = new URL(origin);
      const host = url.hostname;
      // localhost, 사설 IP 대역(192.168.x.x, 10.x.x.x, 172.16~31.x.x), Electron 허용
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.startsWith('192.168.') ||
        host.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        origin === 'app://.'
      ) {
        return callback(null, true);
      }
    } catch {}
    return callback(new Error('CORS 정책에 의해 차단된 요청입니다.'));
  },
  credentials: false,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Routes ──────────────────────────────────────────
import authRoutes         from './routes/auth';
import departmentRoutes   from './routes/departments';
import userRoutes         from './routes/users';
import vendorRoutes       from './routes/vendors';
import itemRoutes         from './routes/items';
import baselineRoutes     from './routes/baselines';
import patientStatRoutes  from './routes/patient-stats';
import patientRoutes      from './routes/patients';
import wardRequestRoutes  from './routes/ward-requests';
import approvalRoutes     from './routes/approvals';
import purchaseOrderRoutes from './routes/purchase-orders';
import receiptRoutes      from './routes/receipts';
import stockOutRoutes     from './routes/stock-out';
import receiptCheckRoutes from './routes/receipt-check';
import inventoryRoutes    from './routes/inventory';
import dashboardRoutes    from './routes/dashboard';
import costRoutes         from './routes/cost';
import auditLogRoutes     from './routes/audit-logs';
import systemRoutes       from './routes/system';
import deptPermRoutes         from './routes/dept-permissions';
import requestScheduleRoutes  from './routes/request-schedules';
import deptCalendarRoutes     from './routes/dept-calendar';
import masterCodesRoutes      from './routes/master-codes';
import diseaseCodeRoutes      from './routes/disease-codes';
import menuScopeRoutes        from './routes/menu-scopes';
import usageRoutes            from './routes/usage';
import loanRoutes             from './routes/loans';
import menuPolicyRoutes       from './routes/menu-policies';
import equipmentUnitsRoutes     from './routes/equipment-units';
import aiRoutes                    from './routes/ai';
import treatmentTypeRoutes         from './routes/treatment-types';
import supplyAnalyticsRoutes       from './routes/supply-analytics';
import demandForecastRoutes        from './routes/demand-forecast';
import poStatsRoutes               from './routes/po-stats';
import requestStatsRoutes          from './routes/request-stats';
import inventoryStatsRoutes        from './routes/inventory-stats';
import stockoutStatsRoutes         from './routes/stockout-stats';
import hiraApiRoutes               from './routes/hira-api';
import hiraDiseaseStatsRoutes      from './routes/hira-disease-stats';

app.use('/api/auth',           authRoutes);
app.use('/api/departments',    departmentRoutes);
app.use('/api/users',          userRoutes);
app.use('/api/vendors',        vendorRoutes);
app.use('/api/items',          itemRoutes);
app.use('/api/baselines',      baselineRoutes);
app.use('/api/patient-stats',  patientStatRoutes);
app.use('/api/patients',       patientRoutes);
app.use('/api/ward-requests',  wardRequestRoutes);
app.use('/api/approvals',      approvalRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/receipts',       receiptRoutes);
app.use('/api/stock-out',      stockOutRoutes);
app.use('/api/receipt-check',  receiptCheckRoutes);
app.use('/api/inventory',      inventoryRoutes);
app.use('/api/dashboard',      dashboardRoutes);
app.use('/api/cost',           costRoutes);
app.use('/api/audit-logs',     auditLogRoutes);
app.use('/api/system',         systemRoutes);
app.use('/api/dept-permissions',   deptPermRoutes);
app.use('/api/request-schedules', requestScheduleRoutes);
app.use('/api/dept-calendar',    deptCalendarRoutes);
app.use('/api/item-categories',  masterCodesRoutes.itemCategories);
app.use('/api/stats-categories', masterCodesRoutes.statsCategories);
app.use('/api/expense-scopes',   masterCodesRoutes.expenseScopes);
app.use('/api/disease-codes',    diseaseCodeRoutes);
app.use('/api/menu-scopes',      menuScopeRoutes);
app.use('/api/menu-policies',    menuPolicyRoutes);
app.use('/api/usage',            usageRoutes);
app.use('/api/loans',            loanRoutes);
app.use('/api/equipment-units',  equipmentUnitsRoutes);
app.use('/api/ai',               aiRoutes);
app.use('/api/treatment-types', treatmentTypeRoutes);
app.use('/api/supply-analytics', supplyAnalyticsRoutes);
app.use('/api/demand-forecast',  demandForecastRoutes);
app.use('/api/po-stats',         poStatsRoutes);
app.use('/api/request-stats',    requestStatsRoutes);
app.use('/api/inventory-stats',  inventoryStatsRoutes);
app.use('/api/stockout-stats',   stockoutStatsRoutes);
app.use('/api/hira',             hiraApiRoutes);
app.use('/api/hira-disease-stats', hiraDiseaseStatsRoutes);

// Static uploads
const uploadsDir = path.join(process.env.USER_DATA_PATH || '.', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Serve built React client (enables LAN access from other PCs via browser)
const distPath = process.env.DIST_PATH || path.join(__dirname, '..', '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api|\/uploads).*$/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Auto backup (daily at 02:00)
import cron from 'node-cron';
cron.schedule('0 2 * * *', async () => {
  try {
    const dbPath = DATABASE_URL.replace('file:', '');
    const backupDir = path.join(process.env.USER_DATA_PATH || '.', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bp = path.join(backupDir, `auto-backup-${ts}.db`);
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, bp);
      const { v4: uuidv4 } = await import('uuid');
      await prisma.backupRecord.create({
        data: { id: uuidv4(), file_path: bp, note: '자동 백업' },
      });
      console.log(`[AutoBackup] ${bp}`);
    }
  } catch (e) { console.error('[AutoBackup] Failed:', e); }
});

const SERVER_HOST = process.env.SERVER_HOST || '127.0.0.1';
app.listen(PORT, SERVER_HOST, () => {
  console.log(`Server running on ${SERVER_HOST}:${PORT}`);
});

export default app;




