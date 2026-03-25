import fs from 'fs';
import ExcelJS from 'exceljs';
import { prisma } from '../index';
import { importPatientsFromBuffer, ImportResult } from './patient-import';

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── 루프 방지 락 (excel-sync.ts가 쓸 때 watcher가 import 건너뜀) ──────────
let excelSyncLock = false;
export function setExcelSyncLock(value: boolean) {
  excelSyncLock = value;
}

// AppSetting 키
const KEY_PATH    = 'patient_watch_file_path';
const KEY_DEPT    = 'patient_watch_dept_id';
const KEY_ENABLED = 'patient_watch_enabled';
const KEY_STATUS  = 'patient_watch_last_status';

async function getSetting(key: string): Promise<string | null> {
  try {
    const row = await (prisma as any).appSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  } catch { return null; }
}

async function setSetting(key: string, value: string) {
  await (prisma as any).appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

async function runImport(filePath: string, deptId: string, actorUserId: string) {
  // 루프 방지: 프로그램이 Excel을 쓰는 중이면 스킵
  if (excelSyncLock) {
    console.log('[FileWatcher] Excel sync lock 활성화 — import 건너뜀');
    return;
  }

  try {
    if (!fs.existsSync(filePath)) {
      await setSetting(KEY_STATUS, JSON.stringify({ error: '파일을 찾을 수 없습니다.', synced_at: new Date().toISOString() }));
      return;
    }
    const buffer = fs.readFileSync(filePath);
    const result: ImportResult = await importPatientsFromBuffer(buffer, deptId, actorUserId, filePath);
    await setSetting(KEY_STATUS, JSON.stringify(result));
    console.log(
      `[FileWatcher] 동기화 완료: 등록 ${result.created}건, 업데이트 ${result.updated}건, ` +
      `퇴원 ${result.discharged}건, 사망 ${result.deceased}건, 중복 ${result.skipped}건, 오류 ${result.errors.length}건`
    );
    if (result.errors.length > 0) {
      const preview = result.errors.slice(0, 10);
      for (const err of preview) {
        console.warn(`[FileWatcher]   Row ${err.row}: ${err.message.split('\n')[0]}`);
      }
      if (result.errors.length > 10) {
        console.warn(`[FileWatcher]   ... 외 ${result.errors.length - 10}건`);
      }
    }
  } catch (e: any) {
    const status = { error: e.message || '알 수 없는 오류', synced_at: new Date().toISOString() };
    await setSetting(KEY_STATUS, JSON.stringify(status));
    console.error('[FileWatcher] 동기화 오류:', e.message);
  }
}

export async function startFileWatcher() {
  stopFileWatcher();

  const enabled = await getSetting(KEY_ENABLED);
  if (enabled !== 'true') return;

  const filePath = await getSetting(KEY_PATH);
  const deptId   = await getSetting(KEY_DEPT) ?? '';
  if (!filePath) return; // deptId는 없어도 됨 (병실번호로 자동 결정)

  // 기존 엑셀 헤더에 새 컬럼이 없으면 자동 추가
  await ensureExcelHeaders(filePath);

  // 감시 대상 파일의 상위 디렉토리를 watch (파일 자체는 저장 시 교체되어 watch가 끊길 수 있음)
  const dir = require('path').dirname(filePath);
  const fileName = require('path').basename(filePath);

  // 관리자 역할 유저를 감사 로그 주체로 사용 (역할명: 'ADMIN' 또는 '관리자')
  const adminUser = await (prisma as any).user.findFirst({
    where: { is_active: true, deleted_at: null, user_roles: { some: { role: { name: { in: ['ADMIN', '관리자'] } } } } },
  });
  // fallback: 아무 활성 유저라도 사용 (FK 위반 방지)
  const fallbackUser = adminUser ? null : await (prisma as any).user.findFirst({
    where: { is_active: true, deleted_at: null },
  });
  const actorUserId = adminUser?.id ?? fallbackUser?.id ?? 'system';

  try {
    watcher = fs.watch(dir, (eventType, changedFile) => {
      if (changedFile !== fileName) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runImport(filePath, deptId, actorUserId);
      }, 2000); // 2초 디바운스 (Excel 저장 시 이중 이벤트 방지)
    });

    watcher.on('error', (err) => {
      console.error('[FileWatcher] 오류:', err.message);
      stopFileWatcher();
    });

    console.log(`[FileWatcher] 감지 시작: ${filePath}`);
  } catch (e: any) {
    console.error('[FileWatcher] 시작 실패:', e.message);
  }
}

export function stopFileWatcher() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) { watcher.close(); watcher = null; console.log('[FileWatcher] 감지 중지'); }
}

export async function getFileWatcherStatus() {
  const filePath = await getSetting(KEY_PATH);
  const deptId   = await getSetting(KEY_DEPT);
  const enabled  = await getSetting(KEY_ENABLED);
  const lastStatus = await getSetting(KEY_STATUS);
  return {
    file_path: filePath ?? '',
    dept_id: deptId ?? '',
    enabled: enabled === 'true',
    is_running: watcher !== null,
    last_status: lastStatus ? JSON.parse(lastStatus) : null,
  };
}

export async function updateFileWatcherConfig(filePath: string, deptId: string, enabled: boolean) {
  await setSetting(KEY_PATH, filePath);
  await setSetting(KEY_DEPT, deptId);
  await setSetting(KEY_ENABLED, enabled ? 'true' : 'false');
  await startFileWatcher();
}

// ── 엑셀 헤더 자동 보정 (누락된 컬럼 추가) ─────────────────────────────────
// 상태 컬럼(마지막) 앞에 누락된 컬럼을 삽입
const REQUIRED_HEADERS: { header: string; field: string }[] = [
  { header: '특정기간단계', field: 'period_phase' },
  { header: '주상병코드', field: 'main_disease_code' },
  { header: '주상병명', field: 'main_disease_name' },
  { header: '산정특례코드', field: 'disease_code' },
  { header: '산정특례명', field: 'disease_name' },
  { header: '산정특례시작일', field: 'disease_code_registered_at' },
  { header: '산정특례종료일', field: 'disease_code_expires_at' },
  { header: '지인', field: 'acquaintance' },
  { header: '지인색상', field: 'acquaintance_color' },
  { header: '사업명', field: 'project_name' },
  { header: '사업지역', field: 'project_region' },
  { header: '시군구관할관청', field: 'project_sigungu_office' },
  { header: '비고', field: 'note' },
  { header: '상태', field: 'status_action' },
];

async function ensureExcelHeaders(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.getWorksheet('환자목록') ?? wb.worksheets[0];
    if (!ws || ws.rowCount < 1) return;

    // 헤더 행 읽기
    const headerRow = ws.getRow(1);
    const existingHeaders = new Set<string>();
    headerRow.eachCell((cell) => {
      existingHeaders.add(String(cell.value ?? '').trim());
    });

    // 누락된 헤더 확인
    const missing = REQUIRED_HEADERS.filter(h => !existingHeaders.has(h.header));
    if (missing.length === 0) return;

    // 상태 컬럼 위치 찾기 (마지막 헤더 셀 다음에 추가)
    let lastCol = 0;
    headerRow.eachCell((_, colNum) => { if (colNum > lastCol) lastCol = colNum; });

    // 누락된 헤더를 마지막 뒤에 추가
    for (const { header } of missing) {
      lastCol++;
      headerRow.getCell(lastCol).value = header;
      headerRow.getCell(lastCol).font = { bold: true };
    }
    headerRow.commit();

    await wb.xlsx.writeFile(filePath);
    console.log(`[FileWatcher] 엑셀 헤더 보정 완료: ${missing.map(m => m.header).join(', ')} 추가`);
  } catch (e: any) {
    // 파일이 열려있거나 권한 오류 시 조용히 스킵
    console.warn('[FileWatcher] 엑셀 헤더 보정 실패:', e.message);
  }
}
