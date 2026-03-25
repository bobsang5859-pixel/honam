import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { prisma } from '../index';

let cronJob: cron.ScheduledTask | null = null;

export function getDbFilePath(): string {
  const dbUrl = process.env.DATABASE_URL || '';
  return dbUrl.replace('file:', '');
}

export async function performBackup(note: string = '수동 백업'): Promise<string> {
  const dbPath = getDbFilePath();
  const userDataPath = process.env.USER_DATA_PATH || '.';
  
  // Get custom backup dir
  let backupDir: string;
  try {
    const setting = await prisma.appSetting.findUnique({ where: { key: 'backup_dir' } });
    backupDir = setting?.value && setting.value.length > 0 ? setting.value : path.join(userDataPath, 'backups');
  } catch {
    backupDir = path.join(userDataPath, 'backups');
  }

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFileName = `hospital-backup-${timestamp}.db`;
  const backupPath = path.join(backupDir, backupFileName);

  // Copy DB file
  fs.copyFileSync(dbPath, backupPath);

  // Record backup
  await prisma.backup.create({
    data: { file_path: backupPath, note },
  });

  return backupPath;
}

export async function restoreBackup(backupFilePath: string): Promise<void> {
  const dbPath = getDbFilePath();
  
  if (!fs.existsSync(backupFilePath)) {
    throw new Error('백업 파일을 찾을 수 없습니다.');
  }

  // Close Prisma connection
  await prisma.$disconnect();

  // Copy backup over current DB
  fs.copyFileSync(backupFilePath, dbPath);
}

export async function setupAutoBackup() {
  try {
    const enabled = await prisma.appSetting.findUnique({ where: { key: 'auto_backup_enabled' } });
    const timeSetting = await prisma.appSetting.findUnique({ where: { key: 'auto_backup_time' } });

    if (enabled?.value !== 'true') return;

    const time = timeSetting?.value || '02:00';
    const [hour, minute] = time.split(':').map(Number);

    if (cronJob) cronJob.stop();

    cronJob = cron.schedule(`${minute} ${hour} * * *`, async () => {
      try {
        await performBackup('자동 백업');
        console.log('Auto backup completed');
      } catch (err) {
        console.error('Auto backup failed:', err);
      }
    });

    console.log(`Auto backup scheduled at ${time}`);
  } catch (err) {
    console.error('Failed to setup auto backup:', err);
  }
}
