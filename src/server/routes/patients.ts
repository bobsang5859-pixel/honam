import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { importPatientsFromBuffer } from '../services/patient-import';

const router = Router();
router.use(authMiddleware);
const ACTIVE_STOCK_OUT_STATUSES = ['POSTED', 'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_DIFF'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PATIENT_SCOPE_EXCLUDED_PREFIXES = [
  '/stats',
  '/analytics',
  '/incineration-entries',
  '/incineration-monthly',
];

const requirePatientManageMenu = requireMenuAccess('patient-manage', 'REQUEST_USE', 'PURCHASE_MANAGE');
const requirePatientStatsMenu = requireMenuAccess('patient-stats', 'PURCHASE_MANAGE', 'REQUEST_USE', 'STATS_VIEW');

router.use((req: AuthRequest, res, next) => {
  if (PATIENT_SCOPE_EXCLUDED_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return requirePatientStatsMenu(req, res, next);
  }
  return requirePatientManageMenu(req, res, next);
});

const WARD_CODES = ['2병동', '3병동', '4병동', '5병동', '6병동', '7병동', '8병동', '9병동'];
const isWardDepartment = (dept: { name?: string | null; code?: string | null }) => {
  const name = String(dept.name ?? '').trim();
  const code = String(dept.code ?? '').trim().toUpperCase();
  return WARD_CODES.includes(name) || name.includes('병동') || /^WARD\d+$/.test(code);
};
const DEFAULT_ROOM_COUNT = 20;
const DEFAULT_ROOM_CAPACITY = 6;
const HOSPITAL_FILE = path.join(process.env.USER_DATA_PATH || '.', 'hospitals.json');

async function getSetting(key: string, fallback: string): Promise<string> {
  try {
    const s = await prisma.appSetting.findUnique({ where: { key } });
    return s?.value ?? fallback;
  } catch {
    return fallback;
  }
}

const toDateOnly = (input?: string) => {
  if (!input) return new Date(new Date().toISOString().slice(0, 10));
  return new Date(`${input.slice(0, 10)}T00:00:00.000Z`);
};

const keyDate = (d: Date) => d.toISOString().slice(0, 10);
const INCINERATION_UNIT_PRICE = 550;
const DIAPER_STATES = {
  IN_HOUSE: 'IN_HOUSE',
  PERSONAL: 'PERSONAL',
  NONE: 'NONE',
} as const;
const CAREGIVER_TYPES = ['CLOSE', 'OUTSOURCED', 'IN_HOUSE'] as const;

const normalizeDepartmentId = (departmentId?: string | null) => String(departmentId ?? '').trim();
const toYearMonth = (input: Date | string) => {
  const d = typeof input === 'string' ? new Date(`${input}-01T00:00:00.000Z`) : input;
  return d.toISOString().slice(0, 7);
};
const isMonOrThu = (dateStr: string) => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 1: Mon, 4: Thu
  return dow === 1 || dow === 4;
};
const normalizeDiaperState = (value?: string) => {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'CIRCLE') return DIAPER_STATES.IN_HOUSE;
  if (raw === 'TRIANGLE') return DIAPER_STATES.PERSONAL;
  if (raw === DIAPER_STATES.IN_HOUSE || raw === DIAPER_STATES.PERSONAL || raw === DIAPER_STATES.NONE) return raw;
  return DIAPER_STATES.NONE;
};
const normalizeGender = (value?: string) => {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'MALE') return 'M';
  if (raw === 'FEMALE') return 'F';
  if (raw === 'M' || raw === 'F' || raw === 'UNKNOWN') return raw;
  return 'UNKNOWN';
};
const normalizeCaregiverType = (value?: string) => {
  const raw = String(value ?? '').trim().toUpperCase();
  if ((CAREGIVER_TYPES as readonly string[]).includes(raw)) return raw;
  return '';
};
const validateProjectScope = (projectName: string, projectRegion: string, projectSigunguOffice: string) => {
  if (projectName && (!projectRegion || !projectSigunguOffice)) {
    throw new Error('PROJECT_SCOPE_REQUIRED');
  }
};

function canViewAllPatients(req: AuthRequest): boolean {
  if (isCustomMenuUser(req.user)) {
    const menus = req.user?.menu_permissions ?? [];
    return menus.includes('patient-manage') || menus.includes('patient-stats');
  }
  const perms = req.user?.permissions ?? [];
  return perms.includes('SYSTEM_ADMIN') || perms.includes('PURCHASE_MANAGE') || perms.includes('STATS_VIEW');
}

async function ensureIncinerationTables(db: any) {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS incineration_entries (
      id TEXT PRIMARY KEY,
      entry_date TEXT NOT NULL,
      department_id TEXT NOT NULL DEFAULT '',
      weight_kg REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incineration_entries_unique
    ON incineration_entries(entry_date, department_id)
  `);
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_incineration_entries_date
    ON incineration_entries(entry_date)
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS incineration_monthly_overrides (
      id TEXT PRIMARY KEY,
      year_month TEXT NOT NULL,
      department_id TEXT NOT NULL DEFAULT '',
      final_amount_override REAL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incineration_monthly_overrides_unique
    ON incineration_monthly_overrides(year_month, department_id)
  `);
}

function listYearMonths(fromDate: Date, toDate: Date) {
  const out: string[] = [];
  let y = fromDate.getUTCFullYear();
  let m = fromDate.getUTCMonth() + 1;
  const endY = toDate.getUTCFullYear();
  const endM = toDate.getUTCMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

async function getIncinerationMonthlySummary(db: any, fromDate: Date, toDate: Date, departmentId?: string) {
  await ensureIncinerationTables(db);
  const dept = normalizeDepartmentId(departmentId);
  const months = listYearMonths(fromDate, toDate);
  if (months.length === 0) return [];
  const fromYm = months[0];
  const toYm = months[months.length - 1];
  const fromStart = `${fromYm}-01`;
  const toEnd = `${toYm}-31`;
  const rows = await db.$queryRaw`
    SELECT strftime('%Y-%m', entry_date) AS year_month, SUM(weight_kg) AS kg_sum
    FROM incineration_entries
    WHERE department_id=${dept}
      AND entry_date >= ${fromStart}
      AND entry_date <= ${toEnd}
    GROUP BY strftime('%Y-%m', entry_date)
  `;
  const overrides = await db.$queryRaw`
    SELECT year_month, final_amount_override, note
    FROM incineration_monthly_overrides
    WHERE department_id=${dept}
      AND year_month >= ${fromYm}
      AND year_month <= ${toYm}
  `;
  const unitPrice = Number(await getSetting('INCINERATION_UNIT_PRICE', String(INCINERATION_UNIT_PRICE)));
  const kgMap = new Map<string, number>();
  for (const r of rows) kgMap.set(String(r.year_month), Number(r.kg_sum ?? 0));
  const ovMap = new Map<string, any>();
  for (const r of overrides) ovMap.set(String(r.year_month), r);

  return months.map((ym) => {
    const kg = Number((kgMap.get(ym) ?? 0).toFixed(3));
    const auto = Number((kg * unitPrice).toFixed(0));
    const ov = ovMap.get(ym);
    const finalAmount = ov?.final_amount_override === null || ov?.final_amount_override === undefined
      ? auto
      : Number(ov.final_amount_override);
    return {
      year_month: ym,
      kg_month_sum: kg,
      unit_price: unitPrice,
      auto_amount: auto,
      final_amount: Number(finalAmount.toFixed(0)),
      variance: Number((finalAmount - auto).toFixed(0)),
      override_note: String(ov?.note ?? ''),
    };
  });
}

function readHospitals(): { id: string; name: string }[] {
  try {
    if (!fs.existsSync(HOSPITAL_FILE)) return [];
    const raw = fs.readFileSync(HOSPITAL_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x: any) => x?.id && x?.name).map((x: any) => ({ id: String(x.id), name: String(x.name) }));
  } catch {
    return [];
  }
}

function writeHospitals(rows: { id: string; name: string }[]) {
  fs.writeFileSync(HOSPITAL_FILE, JSON.stringify(rows, null, 2), 'utf-8');
}

async function ensureDefaultWardRooms() {
  const allDepts = await prisma.department.findMany({
    where: { deleted_at: null, is_active: true },
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  });
  const defaultCapacity = Number(await getSetting('DEFAULT_ROOM_CAPACITY', String(DEFAULT_ROOM_CAPACITY)));
  const depts = allDepts.filter(isWardDepartment);
  for (const [deptIdx, d] of depts.entries()) {
    const existing = await (prisma as any).wardRoom.count({
      where: { department_id: d.id, deleted_at: null },
    });
    if (existing > 0) continue;
    const rows = Array.from({ length: DEFAULT_ROOM_COUNT }, (_, i) => {
      const wardNo = Number(String(d.name).replace(/[^\d]/g, ''));
      const base = Number.isFinite(wardNo) && wardNo > 0 ? wardNo * 100 : (deptIdx + 1) * 100;
      const no = `${base + i + 1}`;
      return {
        id: uuidv4(),
        department_id: d.id,
        room_no: `${no}호`,
        capacity: defaultCapacity,
        sort_order: i + 1,
      };
    });
    await (prisma as any).wardRoom.createMany({ data: rows });
  }
}

async function ensureBoardForDate(departmentId: string, date: Date) {
  const rooms = await (prisma as any).wardRoom.findMany({
    where: { department_id: departmentId, is_active: true, deleted_at: null },
    orderBy: [{ sort_order: 'asc' }, { room_no: 'asc' }],
  });
  if (rooms.length === 0) return;

  const existing = await (prisma as any).wardRoomBoard.count({
    where: { department_id: departmentId, board_date: date, deleted_at: null },
  });

  if (existing === 0) {
    const prev = await (prisma as any).wardRoomBoard.findMany({
      where: {
        department_id: departmentId,
        board_date: { lt: date },
        deleted_at: null,
      },
      orderBy: [{ board_date: 'desc' }],
    });

    let createRows: any[] = [];
    if (prev.length > 0) {
      const latestDate = keyDate(new Date(prev[0].board_date));
      createRows = prev
        .filter((r: any) => keyDate(new Date(r.board_date)) === latestDate)
        .map((r: any) => ({
          ...r,
          id: uuidv4(),
          board_date: date,
          created_at: undefined,
          updated_at: undefined,
        }));
    } else {
      createRows = rooms.flatMap((room: any) =>
        Array.from({ length: Number(room.capacity) }, (_, i) => ({
          id: uuidv4(),
          board_date: date,
          department_id: departmentId,
          ward_room_id: room.id,
          room_no: room.room_no,
          bed_no: i + 1,
        }))
      );
    }

    if (createRows.length > 0) {
      try {
        await (prisma as any).wardRoomBoard.createMany({ data: createRows });
      } catch (e: any) {
        // 동시 생성 경합으로 인한 유니크 충돌은 무시하고 후속 보정에서 수렴시킨다.
        if (e?.code !== 'P2002') throw e;
      }
    }
  }

  const existingCells = await (prisma as any).wardRoomBoard.findMany({
    where: { department_id: departmentId, board_date: date, deleted_at: null },
    select: { ward_room_id: true, bed_no: true },
  });
  const existingKeys = new Set(existingCells.map((cell: any) => `${cell.ward_room_id}:${Number(cell.bed_no)}`));
  const missingTargets = rooms.flatMap((room: any) =>
    Array.from({ length: Number(room.capacity) }, (_, i) => ({
      ward_room_id: room.id,
      room_no: room.room_no,
      bed_no: i + 1,
    }))
  ).filter((target: any) => !existingKeys.has(`${target.ward_room_id}:${target.bed_no}`));

  for (const target of missingTargets) {
    await (prisma as any).wardRoomBoard.upsert({
      where: {
        board_date_department_id_ward_room_id_bed_no: {
          board_date: date,
          department_id: departmentId,
          ward_room_id: target.ward_room_id,
          bed_no: target.bed_no,
        },
      },
      create: {
        id: uuidv4(),
        board_date: date,
        department_id: departmentId,
        ward_room_id: target.ward_room_id,
        room_no: target.room_no,
        bed_no: target.bed_no,
      },
      update: {},
    });
  }
}

function normalizePatient(body: any) {
  const rawPeriodType = String(body.period_type ?? '').trim();
  const hasPeriod = rawPeriodType.length > 0;
  const periodStart = hasPeriod ? String(body.period_start_date ?? '').trim() : '';
  const periodEnd = hasPeriod ? String(body.period_end_date ?? '').trim() : '';
  const baseNote = String(body.note ?? '')
    .replace(/\[기간:[^\]]*\]/g, '')
    .trim();
  const periodNote = hasPeriod ? `[기간:${periodStart || '-'}~${periodEnd || '-'}]` : '';
  const diaperState = normalizeDiaperState(body.diaper_state);
  const gender = normalizeGender(body.gender);
  const diaperPriceRaw = body.diaper_price;
  const diaperPriceParsed = diaperPriceRaw === undefined || diaperPriceRaw === null || diaperPriceRaw === '' ? 0 : Number(diaperPriceRaw);
  const diaperPrice = diaperState === DIAPER_STATES.IN_HOUSE ? Math.max(0, diaperPriceParsed || 0) : 0;
  const caregiverType = normalizeCaregiverType(body.caregiver_type);
  const projectName = String(body.project_name ?? '').trim();
  const projectRegion = String(body.project_region ?? '').trim();
  const projectSigunguOffice = String(body.project_sigungu_office ?? '').trim();
  return {
    chart_no: String(body.chart_no ?? body.patient_no ?? '').trim(),
    patient_no: String(body.patient_no ?? '').trim(),
    name: String(body.name ?? '').trim(),
    gender,
    mobility_type: String(body.mobility_type ?? 'AMBULATORY'),
    insurance_type: String(body.insurance_type ?? 'HEALTH'),
    copay_reduction: String(body.copay_reduction ?? 'NONE'),
    patient_group: String(body.patient_group ?? 'UNRATED'),
    specializations: JSON.stringify(Array.isArray(body.specializations) ? body.specializations : []),
    infection_strain: String(body.infection_strain ?? ''),
    period_type: rawPeriodType,
    period_phase: String(body.period_phase ?? ''),
    diaper_state: diaperState,
    diaper_price: diaperPrice,
    prev_hospital: String(body.prev_hospital ?? ''),
    acquaintance: String(body.acquaintance ?? ''),
    acquaintance_color: String(body.acquaintance_color ?? ''),
    address: String(body.address ?? ''),
    referral_source: String(body.referral_source ?? ''),
    main_disease_code_id: body.main_disease_code_id ? String(body.main_disease_code_id).trim() : null,
    caregiver_type: caregiverType,
    guardian_name: String(body.guardian_name ?? '').trim(),
    billing_sms_phone: String(body.billing_sms_phone ?? '').replace(/\s+/g, ''),
    project_name: projectName,
    project_region: projectRegion,
    project_sigungu_office: projectSigunguOffice,
    period_start_date: periodStart,
    period_end_date: periodEnd,
    note: [baseNote, periodNote].filter(Boolean).join(' ').trim(),
    diaper_start_date: body.diaper_start_date ? new Date(body.diaper_start_date) : null,
    diaper_end_date: body.diaper_end_date ? new Date(body.diaper_end_date) : null,
  };
}

async function admitOne(payload: any, userId: string) {
  const { department_id, room_no, bed_no, admitted_at } = payload;
  const date = toDateOnly(admitted_at ?? new Date().toISOString());
  await ensureBoardForDate(String(department_id), date);
  const room = await (prisma as any).wardRoom.findFirst({
    where: { department_id: String(department_id), room_no: String(room_no), deleted_at: null },
  });
  if (!room) throw new Error('ROOM_NOT_FOUND');

  const occupied = await (prisma as any).wardRoomBoard.findFirst({
    where: {
      board_date: date,
      department_id: String(department_id),
      ward_room_id: room.id,
      bed_no: Number(bed_no),
      deleted_at: null,
      patient_name: { not: '' },
    },
  });
  if (occupied) throw new Error('BED_OCCUPIED');

  const data = normalizePatient(payload);
  validateProjectScope(data.project_name, data.project_region, data.project_sigungu_office);
  const patient = await (prisma as any).patient.create({
    data: {
      id: uuidv4(),
      patient_no: data.patient_no || data.chart_no,
      chart_no: data.chart_no || data.patient_no,
      name: data.name,
      department_id: String(department_id),
      room_no: String(room_no),
      bed_no: Number(bed_no),
      admitted_at: admitted_at ? new Date(admitted_at) : new Date(),
      status: 'ADMITTED',
      created_by: userId,
      gender: data.gender,
      mobility_type: data.mobility_type,
      insurance_type: data.insurance_type,
      copay_reduction: data.copay_reduction ?? 'NONE',
      patient_group: data.patient_group,
      specializations: data.specializations,
      infection_strain: data.infection_strain,
      period_type: data.period_type,
      period_phase: data.period_phase,
      diaper_state: data.diaper_state,
      diaper_price: data.diaper_price,
      diaper_start_date: data.diaper_start_date ?? undefined,
      diaper_end_date: data.diaper_end_date ?? undefined,
      prev_hospital: data.prev_hospital,
      acquaintance: data.acquaintance,
      acquaintance_color: data.acquaintance_color,
      main_disease_code_id: data.main_disease_code_id,
      caregiver_type: data.caregiver_type,
      guardian_name: data.guardian_name,
      billing_sms_phone: data.billing_sms_phone,
      project_name: data.project_name,
      project_region: data.project_region,
      project_sigungu_office: data.project_sigungu_office,
      note: data.note,
    } as any,
  });

  await (prisma as any).wardRoomBoard.upsert({
    where: {
      board_date_department_id_ward_room_id_bed_no: {
        board_date: date,
        department_id: String(department_id),
        ward_room_id: room.id,
        bed_no: Number(bed_no),
      },
    },
    create: {
      id: uuidv4(),
      board_date: date,
      department_id: String(department_id),
      ward_room_id: room.id,
      room_no: String(room_no),
      bed_no: Number(bed_no),
      patient_id: patient.id,
      patient_no: patient.patient_no,
      chart_no: patient.chart_no,
      patient_name: patient.name,
      gender: patient.gender,
      mobility_type: patient.mobility_type,
      insurance_type: patient.insurance_type,
      copay_reduction: patient.copay_reduction ?? 'NONE',
      patient_group: patient.patient_group,
      specializations: patient.specializations,
      infection_strain: patient.infection_strain,
      period_type: patient.period_type,
      period_phase: patient.period_phase,
      diaper_state: patient.diaper_state,
      diaper_price: patient.diaper_price,
      diaper_start_date: patient.diaper_start_date ?? undefined,
      diaper_end_date: patient.diaper_end_date ?? undefined,
      prev_hospital: patient.prev_hospital,
      acquaintance: patient.acquaintance,
      acquaintance_color: patient.acquaintance_color,
      main_disease_code_id: patient.main_disease_code_id,
      caregiver_type: patient.caregiver_type,
      guardian_name: patient.guardian_name,
      billing_sms_phone: patient.billing_sms_phone,
      project_name: patient.project_name,
      project_region: patient.project_region,
      project_sigungu_office: patient.project_sigungu_office,
      status: 'ADMITTED',
      note: patient.note,
    },
    update: {
      patient_id: patient.id,
      patient_no: patient.patient_no,
      chart_no: patient.chart_no,
      patient_name: patient.name,
      gender: patient.gender,
      mobility_type: patient.mobility_type,
      insurance_type: patient.insurance_type,
      copay_reduction: patient.copay_reduction ?? 'NONE',
      patient_group: patient.patient_group,
      specializations: patient.specializations,
      infection_strain: patient.infection_strain,
      period_type: patient.period_type,
      period_phase: patient.period_phase,
      diaper_state: patient.diaper_state,
      diaper_price: patient.diaper_price,
      diaper_start_date: patient.diaper_start_date ?? undefined,
      diaper_end_date: patient.diaper_end_date ?? undefined,
      prev_hospital: patient.prev_hospital,
      acquaintance: patient.acquaintance,
      acquaintance_color: patient.acquaintance_color,
      main_disease_code_id: patient.main_disease_code_id,
      caregiver_type: patient.caregiver_type,
      guardian_name: patient.guardian_name,
      billing_sms_phone: patient.billing_sms_phone,
      project_name: patient.project_name,
      project_region: patient.project_region,
      project_sigungu_office: patient.project_sigungu_office,
      status: 'ADMITTED',
      note: patient.note,
    },
  });

  await (prisma as any).patientEvent.create({
    data: {
      id: uuidv4(),
      patient_id: patient.id,
      department_id: String(department_id),
      event_type: 'ADMISSION',
      event_date: admitted_at ? new Date(admitted_at) : new Date(),
      room_no: String(room_no),
      bed_no: Number(bed_no),
      prev_hospital: data.prev_hospital,
      memo: data.note,
      created_by: userId,
    } as any,
  });
  return patient;
}

router.get('/', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { status, search, department_id } = req.query;
    const canViewAll = canViewAllPatients(req);
    const deptId = canViewAll ? (department_id ? String(department_id) : undefined) : req.user!.department_id ?? undefined;

    const where: any = { deleted_at: null };
    if (deptId) where.department_id = deptId;
    if (status) where.status = String(status);
    if (search) {
      where.OR = [
        { patient_no: { contains: String(search) } },
        { chart_no: { contains: String(search) } },
        { name: { contains: String(search) } },
        { room_no: { contains: String(search) } },
      ];
    }

    const patients = await (prisma as any).patient.findMany({
      where,
      include: {
        department: true,
      },
      orderBy: [{ department: { name: 'asc' } }, { room_no: 'asc' }, { bed_no: 'asc' }, { admitted_at: 'desc' }],
    });

    // Manual lookup for disease codes (no @relation on Patient model)
    const dcIds = [
      ...new Set(
        patients
          .flatMap((p: any) => [p.disease_code_id, p.main_disease_code_id])
          .filter(Boolean)
      ),
    ] as string[];
    const dcMap: Record<string, any> = {};
    if (dcIds.length > 0) {
      const dcs = await (prisma as any).diseaseCode.findMany({ where: { id: { in: dcIds } } });
      for (const dc of dcs) dcMap[dc.id] = dc;
    }

    res.json(patients.map((p: any) => ({
      ...p,
      department_name: p.department?.name ?? '',
      specializations: JSON.parse(p.specializations ?? '[]'),
      disease_code_str: dcMap[p.disease_code_id]?.code ?? '',
      disease_code_name: dcMap[p.disease_code_id]?.name ?? '',
      main_disease_code: dcMap[p.main_disease_code_id]?.code ?? '',
      main_disease_name: dcMap[p.main_disease_code_id]?.name ?? '',
      disease_code_registered_at: p.disease_code_registered_at ? p.disease_code_registered_at.toISOString().slice(0, 10) : null,
      disease_code_expires_at: p.disease_code_expires_at ? p.disease_code_expires_at.toISOString().slice(0, 10) : null,
      diaper_start_date: p.diaper_start_date ? p.diaper_start_date.toISOString().slice(0, 10) : null,
      diaper_end_date: p.diaper_end_date ? p.diaper_end_date.toISOString().slice(0, 10) : null,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/bulk', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  try {
    for (const row of rows) {
      if (!row?.id) continue;
      const patch = normalizePatient(row);
      await (prisma as any).patient.update({
        where: { id: row.id },
        data: {
          name: patch.name,
          gender: patch.gender,
          mobility_type: patch.mobility_type,
          insurance_type: patch.insurance_type,
          copay_reduction: patch.copay_reduction,
          patient_group: patch.patient_group,
          specializations: patch.specializations,
          infection_strain: patch.infection_strain,
          period_type: patch.period_type,
          period_phase: patch.period_phase,
          diaper_state: patch.diaper_state,
          diaper_price: patch.diaper_price,
          prev_hospital: patch.prev_hospital,
          acquaintance: patch.acquaintance,
          acquaintance_color: patch.acquaintance_color,
          note: patch.note,
          room_no: row.room_no ?? '',
          bed_no: row.bed_no ?? null,
        } as any,
      });
    }
    await audit({ actor_user_id: req.user!.id, action: 'BULK_UPDATE', entity_type: 'patients', entity_id: 'bulk' });
    res.json({ updated: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/room-config', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE'), async (_req, res) => {
  try {
    await ensureDefaultWardRooms();
    const allWards = await prisma.department.findMany({
      where: { deleted_at: null, is_active: true },
      orderBy: { name: 'asc' },
    });
    const wards = allWards.filter(isWardDepartment);
    const rooms = await (prisma as any).wardRoom.findMany({
      where: { deleted_at: null, department_id: { in: wards.map((w: any) => w.id) } },
      orderBy: [{ department_id: 'asc' }, { sort_order: 'asc' }, { room_no: 'asc' }],
    });
    res.json({
      wards: wards.map((w: any) => ({ id: w.id, name: w.name })),
      rooms,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 전체 병동의 임종실 목록 (빈 자리 포함)
router.get('/hospice-rooms', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const date = toDateOnly(String(req.query.date ?? new Date().toISOString()));
    const rooms = await (prisma as any).wardRoom.findMany({
      where: { is_hospice: true, is_active: true, deleted_at: null },
      include: { department: { select: { id: true, name: true } } },
      orderBy: [{ department: { name: 'asc' } }, { room_no: 'asc' }],
    });
    const result = [];
    for (const room of rooms) {
      await ensureBoardForDate(room.department_id, date);
      const cells = await (prisma as any).wardRoomBoard.findMany({
        where: { department_id: room.department_id, ward_room_id: room.id, board_date: date, deleted_at: null },
        orderBy: { bed_no: 'asc' },
      });
      const emptyBeds = cells.filter((c: any) => !c.patient_name).map((c: any) => c.bed_no);
      result.push({
        id: room.id,
        department_id: room.department_id,
        department_name: room.department?.name,
        room_no: room.room_no,
        capacity: room.capacity,
        empty_beds: emptyBeds,
        occupied: room.capacity - emptyBeds.length,
      });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/room-config/:departmentId', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const rows = Array.isArray(req.body?.rooms) ? req.body.rooms : [];
  try {
    const departmentId = String(req.params.departmentId);
    const defaultCapacity = Number(await getSetting('DEFAULT_ROOM_CAPACITY', String(DEFAULT_ROOM_CAPACITY)));
    const normalized = rows
      .map((r: any, idx: number) => ({
        id: r.id ? String(r.id) : '',
        room_no: String(r.room_no ?? '').trim(),
        capacity: Math.max(1, Number(r.capacity ?? defaultCapacity)),
        sort_order: Number(r.sort_order ?? idx + 1),
        is_active: r.is_active !== false,
        is_hospice: Boolean(r.is_hospice),
      }))
      .filter((r: any) => r.room_no.length > 0);

    const existing = await (prisma as any).wardRoom.findMany({
      where: { department_id: departmentId },
    });

    // 인실 축소 시 현재 입원 환자가 병상을 넘지 않도록 방어
    for (const row of normalized) {
      const overCapacity = await (prisma as any).patient.count({
        where: {
          department_id: departmentId,
          room_no: row.room_no,
          status: 'ADMITTED',
          deleted_at: null,
          bed_no: { gt: row.capacity },
        },
      });
      if (overCapacity > 0) {
        return res.status(400).json({
          error: `${row.room_no}은(는) ${row.capacity}인실 초과 환자가 있어 인실을 줄일 수 없습니다.`,
        });
      }
    }

    const keepIds = new Set<string>();
    for (const row of normalized) {
      const byId = row.id ? existing.find((e: any) => e.id === row.id) : null;
      const byRoomNo = existing.find((e: any) => e.room_no === row.room_no);
      const target = byId || byRoomNo;
      if (target) {
        keepIds.add(target.id);
        await (prisma as any).wardRoom.update({
          where: { id: target.id },
          data: {
            room_no: row.room_no,
            capacity: row.capacity,
            sort_order: row.sort_order,
            is_active: row.is_active,
            is_hospice: row.is_hospice,
            deleted_at: row.is_active ? null : new Date(),
          },
        });
      } else {
        const created = await (prisma as any).wardRoom.create({
          data: {
            id: uuidv4(),
            department_id: departmentId,
            room_no: row.room_no,
            capacity: row.capacity,
            sort_order: row.sort_order,
            is_active: row.is_active,
            is_hospice: row.is_hospice,
            deleted_at: row.is_active ? null : new Date(),
          },
        });
        keepIds.add(created.id);
      }
    }

    const toDeactivate = existing.filter((e: any) => !keepIds.has(e.id));
    for (const room of toDeactivate) {
      await (prisma as any).wardRoom.update({
        where: { id: room.id },
        data: { is_active: false, deleted_at: new Date() },
      });
    }

    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'ward_rooms', entity_id: req.params.departmentId });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/board', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const departmentId = String(req.query.department_id ?? '');
  const date = toDateOnly(String(req.query.date ?? ''));
  if (!departmentId) return res.status(400).json({ error: 'department_id는 필수입니다.' });
  try {
    await ensureDefaultWardRooms();
    await ensureBoardForDate(departmentId, date);
    const rooms = await (prisma as any).wardRoom.findMany({
      where: { department_id: departmentId, deleted_at: null, is_active: true },
      orderBy: [{ sort_order: 'asc' }, { room_no: 'asc' }],
    });
    const cells = await (prisma as any).wardRoomBoard.findMany({
      where: { department_id: departmentId, board_date: date, deleted_at: null },
      orderBy: [{ room_no: 'asc' }, { bed_no: 'asc' }],
    });
    const grouped = rooms.map((room: any) => ({
      ...room,
      // 인실 축소 즉시 반영: capacity 범위 이내의 병상만 표시
      cells: cells
        .filter((c: any) => c.ward_room_id === room.id && Number(c.bed_no) <= Number(room.capacity))
        .sort((a: any, b: any) => Number(a.bed_no) - Number(b.bed_no))
        .map((c: any) => ({
          ...c,
          specializations: JSON.parse(c.specializations ?? '[]'),
        })),
    }));
    res.json({ date: date.toISOString(), rooms: grouped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/board/cell/:id', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const before = await (prisma as any).wardRoomBoard.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    // status만 변경하는 경우 (외출/외박/복귀)
    const statusOnlyValues = ['OUTING', 'OVERNIGHT', 'ADMITTED'];
    if (req.body.status && statusOnlyValues.includes(req.body.status) && !req.body.name && !req.body.chart_no && !req.body.patient_no && !req.body.patient_name) {
      const updated = await (prisma as any).wardRoomBoard.update({
        where: { id: req.params.id },
        data: { status: String(req.body.status) },
      });
      await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'ward_room_boards', entity_id: updated.id, after: { status: updated.status } });
      return res.json(updated);
    }

    const patch = normalizePatient(req.body);
    validateProjectScope(patch.project_name, patch.project_region, patch.project_sigungu_office);
    const hasPatientPayload = Boolean(patch.name || patch.chart_no || patch.patient_no);
    let syncedPatientId: string | null = before.patient_id ?? null;

    if (hasPatientPayload) {
      const existingPatient = before.patient_id
        ? await (prisma as any).patient.findUnique({ where: { id: before.patient_id } })
        : await (prisma as any).patient.findFirst({
            where: {
              deleted_at: null,
              department_id: before.department_id,
              room_no: before.room_no,
              bed_no: before.bed_no,
              status: 'ADMITTED',
              OR: [
                ...(patch.chart_no ? [{ chart_no: patch.chart_no }] : []),
                ...(patch.patient_no ? [{ patient_no: patch.patient_no }] : []),
              ],
            },
            orderBy: { admitted_at: 'desc' },
          });

      if (existingPatient) {
        const synced = await (prisma as any).patient.update({
          where: { id: existingPatient.id },
          data: {
            patient_no: patch.patient_no || existingPatient.patient_no,
            chart_no: patch.chart_no || existingPatient.chart_no,
            name: patch.name || existingPatient.name,
            department_id: before.department_id,
            room_no: before.room_no,
            bed_no: before.bed_no,
            status: String(req.body.status ?? existingPatient.status ?? 'ADMITTED'),
            gender: patch.gender,
            mobility_type: patch.mobility_type,
            insurance_type: patch.insurance_type,
          copay_reduction: patch.copay_reduction,
            patient_group: patch.patient_group,
            specializations: patch.specializations,
            infection_strain: patch.infection_strain,
            period_type: patch.period_type,
            period_phase: patch.period_phase,
            diaper_state: patch.diaper_state,
            diaper_price: patch.diaper_price,
            diaper_start_date: patch.diaper_start_date ?? undefined,
            diaper_end_date: patch.diaper_end_date ?? undefined,
            prev_hospital: patch.prev_hospital,
            acquaintance: patch.acquaintance,
            acquaintance_color: patch.acquaintance_color,
            main_disease_code_id: patch.main_disease_code_id,
            caregiver_type: patch.caregiver_type,
            guardian_name: patch.guardian_name,
            billing_sms_phone: patch.billing_sms_phone,
            project_name: patch.project_name,
            project_region: patch.project_region,
            project_sigungu_office: patch.project_sigungu_office,
            note: patch.note,
            ...(req.body?.admitted_at && String(req.body.admitted_at).trim() ? { admitted_at: new Date(req.body.admitted_at) } : {}),
          } as any,
        });
        syncedPatientId = synced.id;
      } else {
        const created = await (prisma as any).patient.create({
          data: {
            id: uuidv4(),
            patient_no: patch.patient_no || patch.chart_no,
            chart_no: patch.chart_no || patch.patient_no,
            name: patch.name || '',
            department_id: before.department_id,
            room_no: before.room_no,
            bed_no: before.bed_no,
            admitted_at: new Date(before.board_date),
            status: String(req.body.status ?? 'ADMITTED'),
            created_by: req.user!.id,
            gender: patch.gender,
            mobility_type: patch.mobility_type,
            insurance_type: patch.insurance_type,
          copay_reduction: patch.copay_reduction,
            patient_group: patch.patient_group,
            specializations: patch.specializations,
            infection_strain: patch.infection_strain,
            period_type: patch.period_type,
            period_phase: patch.period_phase,
            diaper_state: patch.diaper_state,
            diaper_price: patch.diaper_price,
            diaper_start_date: patch.diaper_start_date ?? undefined,
            diaper_end_date: patch.diaper_end_date ?? undefined,
            prev_hospital: patch.prev_hospital,
            acquaintance: patch.acquaintance,
            acquaintance_color: patch.acquaintance_color,
            main_disease_code_id: patch.main_disease_code_id,
            caregiver_type: patch.caregiver_type,
            guardian_name: patch.guardian_name,
            billing_sms_phone: patch.billing_sms_phone,
            project_name: patch.project_name,
            project_region: patch.project_region,
            project_sigungu_office: patch.project_sigungu_office,
            note: patch.note,
          } as any,
        });
        await (prisma as any).patientEvent.create({
          data: {
            id: uuidv4(),
            patient_id: created.id,
            department_id: before.department_id,
            event_type: 'ADMISSION',
            event_date: new Date(before.board_date),
            room_no: before.room_no,
            bed_no: before.bed_no,
            prev_hospital: patch.prev_hospital,
            memo: patch.note,
            created_by: req.user!.id,
          } as any,
        });
        syncedPatientId = created.id;
      }
    }

    const updated = await (prisma as any).wardRoomBoard.update({
      where: { id: req.params.id },
      data: {
        patient_id: hasPatientPayload ? syncedPatientId : null,
        patient_no: patch.patient_no,
        chart_no: patch.chart_no,
        patient_name: patch.name,
        gender: patch.gender,
        mobility_type: patch.mobility_type,
        insurance_type: patch.insurance_type,
        copay_reduction: patch.copay_reduction,
        patient_group: patch.patient_group,
        specializations: patch.specializations,
        infection_strain: patch.infection_strain,
        period_type: patch.period_type,
        period_phase: patch.period_phase,
        diaper_state: patch.diaper_state,
        diaper_price: patch.diaper_price,
        diaper_start_date: patch.diaper_start_date ?? undefined,
        diaper_end_date: patch.diaper_end_date ?? undefined,
        prev_hospital: patch.prev_hospital,
        acquaintance: patch.acquaintance,
        acquaintance_color: patch.acquaintance_color,
        main_disease_code_id: patch.main_disease_code_id,
        caregiver_type: patch.caregiver_type,
        guardian_name: patch.guardian_name,
        billing_sms_phone: patch.billing_sms_phone,
        project_name: patch.project_name,
        project_region: patch.project_region,
        project_sigungu_office: patch.project_sigungu_office,
        address: patch.address ?? '',
        referral_source: patch.referral_source ?? '',
        discharge_type: patch.discharge_type ?? '',
        status: String(req.body.status ?? before.status ?? 'ADMITTED'),
        note: patch.note,
        is_manual: true,
      },
    });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'ward_room_boards', entity_id: updated.id });
    res.json(updated);
  } catch (e) {
    if ((e as any)?.message === 'PROJECT_SCOPE_REQUIRED') {
      return res.status(400).json({ error: '사업명칭 입력 시 지역과 시군구청은 필수입니다.' });
    }
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/admit', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const { department_id, room_no, bed_no, admitted_at } = req.body;
  if (!department_id || !room_no || !bed_no) return res.status(400).json({ error: '부서/병실/병상 정보는 필수입니다.' });
  try {
    const date = toDateOnly(admitted_at ?? new Date().toISOString());
    await ensureBoardForDate(String(department_id), date);
    const room = await (prisma as any).wardRoom.findFirst({
      where: { department_id: String(department_id), room_no: String(room_no), deleted_at: null },
    });
    if (!room) return res.status(404).json({ error: '병실 정보를 찾을 수 없습니다.' });

    const occupied = await (prisma as any).wardRoomBoard.findFirst({
      where: {
        board_date: date,
        department_id: String(department_id),
        ward_room_id: room.id,
        bed_no: Number(bed_no),
        deleted_at: null,
        patient_name: { not: '' },
      },
    });
    if (occupied) return res.status(400).json({ error: '해당 병상이 이미 사용 중입니다.' });

    const data = normalizePatient(req.body);
    validateProjectScope(data.project_name, data.project_region, data.project_sigungu_office);
    const dcId = req.body?.disease_code_id ? String(req.body.disease_code_id) : null;
    const dcRegisteredAt = req.body?.disease_code_registered_at ? new Date(req.body.disease_code_registered_at) : null;
    const dcExpiresAt = req.body?.disease_code_expires_at ? new Date(req.body.disease_code_expires_at) : null;
    const patient = await (prisma as any).patient.create({
      data: {
        id: uuidv4(),
        patient_no: data.patient_no || data.chart_no,
        chart_no: data.chart_no || data.patient_no,
        name: data.name,
        department_id: String(department_id),
        room_no: String(room_no),
        bed_no: Number(bed_no),
        admitted_at: admitted_at ? new Date(admitted_at) : new Date(),
        status: 'ADMITTED',
        created_by: req.user!.id,
        gender: data.gender,
        mobility_type: data.mobility_type,
        insurance_type: data.insurance_type,
      copay_reduction: data.copay_reduction ?? 'NONE',
        patient_group: data.patient_group,
        specializations: data.specializations,
        infection_strain: data.infection_strain,
        period_type: data.period_type,
        period_phase: data.period_phase,
        diaper_state: data.diaper_state,
        diaper_price: data.diaper_price,
        diaper_start_date: data.diaper_start_date ?? undefined,
        diaper_end_date: data.diaper_end_date ?? undefined,
        prev_hospital: data.prev_hospital,
        acquaintance: data.acquaintance,
        acquaintance_color: data.acquaintance_color,
        main_disease_code_id: data.main_disease_code_id,
        caregiver_type: data.caregiver_type,
        guardian_name: data.guardian_name,
        billing_sms_phone: data.billing_sms_phone,
        project_name: data.project_name,
        project_region: data.project_region,
        project_sigungu_office: data.project_sigungu_office,
        note: data.note,
        ...(dcId && { disease_code_id: dcId }),
        ...(dcRegisteredAt && { disease_code_registered_at: dcRegisteredAt }),
        ...(dcExpiresAt && { disease_code_expires_at: dcExpiresAt }),
      } as any,
    });

    // V코드 이력 등록
    if (dcId && dcRegisteredAt) {
      try {
        const { v4: uuid4 } = await import('uuid');
        await (prisma as any).patientDiseaseCode.create({
          data: {
            id: uuid4(),
            patient_id: patient.id,
            disease_code_id: dcId,
            registered_at: dcRegisteredAt,
            expires_at: dcExpiresAt,
            note: '',
            is_active: true,
          },
        });
      } catch { /* 이력 등록 실패는 무시 */ }
    }

    await (prisma as any).wardRoomBoard.upsert({
      where: {
        board_date_department_id_ward_room_id_bed_no: {
          board_date: date,
          department_id: String(department_id),
          ward_room_id: room.id,
          bed_no: Number(bed_no),
        },
      },
      create: {
        id: uuidv4(),
        board_date: date,
        department_id: String(department_id),
        ward_room_id: room.id,
        room_no: String(room_no),
        bed_no: Number(bed_no),
        patient_id: patient.id,
        patient_no: patient.patient_no,
        chart_no: patient.chart_no,
        patient_name: patient.name,
        gender: patient.gender,
        mobility_type: patient.mobility_type,
        insurance_type: patient.insurance_type,
      copay_reduction: patient.copay_reduction ?? 'NONE',
        patient_group: patient.patient_group,
        specializations: patient.specializations,
        infection_strain: patient.infection_strain,
        period_type: patient.period_type,
        period_phase: patient.period_phase,
        diaper_state: patient.diaper_state,
        diaper_price: patient.diaper_price,
        diaper_start_date: patient.diaper_start_date ?? undefined,
        diaper_end_date: patient.diaper_end_date ?? undefined,
        prev_hospital: patient.prev_hospital,
        acquaintance: patient.acquaintance,
        acquaintance_color: patient.acquaintance_color,
        main_disease_code_id: patient.main_disease_code_id,
        caregiver_type: patient.caregiver_type,
        guardian_name: patient.guardian_name,
        billing_sms_phone: patient.billing_sms_phone,
        project_name: patient.project_name,
        project_region: patient.project_region,
        project_sigungu_office: patient.project_sigungu_office,
        status: 'ADMITTED',
      },
      update: {
        patient_id: patient.id,
        patient_no: patient.patient_no,
        chart_no: patient.chart_no,
        patient_name: patient.name,
        gender: patient.gender,
        mobility_type: patient.mobility_type,
        insurance_type: patient.insurance_type,
      copay_reduction: patient.copay_reduction ?? 'NONE',
        patient_group: patient.patient_group,
        specializations: patient.specializations,
        infection_strain: patient.infection_strain,
        period_type: patient.period_type,
        period_phase: patient.period_phase,
        diaper_state: patient.diaper_state,
        diaper_price: patient.diaper_price,
        diaper_start_date: patient.diaper_start_date ?? undefined,
        diaper_end_date: patient.diaper_end_date ?? undefined,
        prev_hospital: patient.prev_hospital,
        acquaintance: patient.acquaintance,
        acquaintance_color: patient.acquaintance_color,
        main_disease_code_id: patient.main_disease_code_id,
        caregiver_type: patient.caregiver_type,
        guardian_name: patient.guardian_name,
        billing_sms_phone: patient.billing_sms_phone,
        project_name: patient.project_name,
        project_region: patient.project_region,
        project_sigungu_office: patient.project_sigungu_office,
        status: 'ADMITTED',
      },
    });

    await (prisma as any).patientEvent.create({
      data: {
        id: uuidv4(),
        patient_id: patient.id,
        department_id: String(department_id),
        event_type: 'ADMISSION',
        event_date: admitted_at ? new Date(admitted_at) : new Date(),
        room_no: String(room_no),
        bed_no: Number(bed_no),
        prev_hospital: data.prev_hospital,
        memo: data.note,
        created_by: req.user!.id,
      } as any,
    });
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'patients', entity_id: patient.id });
    res.status(201).json(patient);
  } catch (e: any) {
    if (e?.message === 'PROJECT_SCOPE_REQUIRED') return res.status(400).json({ error: '사업명칭 입력 시 지역과 시군구청은 필수입니다.' });
    console.error(e);
    if (e.code === 'P2002') return res.status(409).json({ error: '중복 차트번호/환자번호입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

async function closePatientState(patientId: string, eventType: 'DISCHARGE' | 'DEATH', req: AuthRequest, closedAt?: string, dischargeType?: string, dischargeReason?: string) {
  const patient = await (prisma as any).patient.findUnique({ where: { id: patientId } });
  if (!patient) throw new Error('NOT_FOUND');
  if (patient.status !== 'ADMITTED') throw new Error('INVALID_STATUS');
  const now = closedAt ? new Date(closedAt) : new Date();

  const updated = await (prisma as any).patient.update({
    where: { id: patientId },
    data: {
      status: 'DISCHARGED',
      discharged_at: now,
      ...(dischargeType ? { discharge_type: dischargeType } : {}),
      ...(dischargeReason ? { note: [patient.note, `[퇴원사유] ${dischargeReason}`].filter(Boolean).join('\n') } : {}),
    },
  });

  await (prisma as any).patientEvent.create({
    data: {
      id: uuidv4(),
      patient_id: patientId,
      department_id: patient.department_id,
      event_type: 'DISCHARGE',
      event_date: now,
      room_no: patient.room_no ?? '',
      bed_no: patient.bed_no ?? null,
      prev_hospital: patient.prev_hospital ?? '',
      memo: dischargeReason ?? '',
      created_by: req.user!.id,
    } as any,
  });

  const date = toDateOnly(now.toISOString());
  await ensureBoardForDate(patient.department_id, date);
  // 모든 날짜의 병실현황판에서 환자 제거
  await (prisma as any).wardRoomBoard.updateMany({
    where: {
      patient_id: patientId,
      deleted_at: null,
    },
    data: {
      status: 'DISCHARGED',
      patient_id: null,
      patient_no: '',
      chart_no: '',
      patient_name: '',
    },
  });
  return updated;
}

router.post('/:id/discharge', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const updated = await closePatientState(req.params.id, 'DISCHARGE', req, req.body?.discharged_at, req.body?.discharge_type, req.body?.discharge_reason);
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'patients', entity_id: updated.id, after: { status: 'DISCHARGED' } });
    res.json(updated);
  } catch (e: any) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });
    if (e.message === 'INVALID_STATUS') return res.status(400).json({ error: '현재 입원 상태가 아닙니다.' });
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 하위호환: /death → discharge로 처리 (사유 "사망")
router.post('/:id/death', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const updated = await closePatientState(req.params.id, 'DISCHARGE', req, req.body?.deceased_at, undefined, '사망');
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'patients', entity_id: updated.id, after: { status: 'DISCHARGED' } });
    res.json(updated);
  } catch (e: any) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });
    if (e.message === 'INVALID_STATUS') return res.status(400).json({ error: '현재 입원 상태가 아닙니다.' });
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/:id/transfer', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const patient = await (prisma as any).patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });
    if (patient.status !== 'ADMITTED') return res.status(400).json({ error: '현재 입원 상태가 아닙니다.' });

    const targetDeptId = String(req.body?.department_id ?? '').trim();
    if (!targetDeptId) return res.status(400).json({ error: '이동할 병동을 선택해 주세요.' });

    const targetDept = await prisma.department.findUnique({ where: { id: targetDeptId } });
    if (!targetDept) return res.status(404).json({ error: '대상 병동을 찾을 수 없습니다.' });

    const memo = String(req.body?.memo ?? '');
    const newRoomNo = String(req.body?.room_no ?? '').trim();
    const newBedNo = req.body?.bed_no != null && req.body.bed_no !== '' ? Number(req.body.bed_no) : null;
    const today = new Date();
    const date = toDateOnly(today.toISOString());

    // 대상 병동 보드 준비
    await ensureBoardForDate(targetDeptId, date);

    // 병실/자리 지정 시 유효성 검증 + 교환 대상 확인
    let swapPatient: any = null;
    if (newRoomNo && newBedNo != null) {
      const room = await (prisma as any).wardRoom.findFirst({
        where: { department_id: targetDeptId, room_no: newRoomNo, deleted_at: null },
      });
      if (!room) return res.status(400).json({ error: `병실 ${newRoomNo}을 찾을 수 없습니다.` });
      const occupiedBoard = await (prisma as any).wardRoomBoard.findFirst({
        where: { board_date: date, department_id: targetDeptId, ward_room_id: room.id, bed_no: newBedNo, deleted_at: null, patient_name: { not: '' }, patient_id: { not: patient.id } },
      });
      if (occupiedBoard?.patient_id) {
        swapPatient = await (prisma as any).patient.findUnique({ where: { id: occupiedBoard.patient_id } });
      }
    }

    const oldDeptId = patient.department_id;
    const oldRoomNo = patient.room_no ?? '';
    const oldBedNo = patient.bed_no;

    // PatientEvent: TRANSFER
    await (prisma as any).patientEvent.create({
      data: {
        id: uuidv4(),
        patient_id: patient.id,
        department_id: oldDeptId,
        event_type: 'TRANSFER',
        event_date: today,
        room_no: oldRoomNo,
        bed_no: oldBedNo ?? null,
        memo: swapPatient ? `${memo} [교환: ${swapPatient.name}]`.trim() : memo,
        created_by: req.user!.id,
      },
    });

    // Clear board record(s) for today
    const todayStr = today.toISOString().slice(0, 10);
    await (prisma as any).wardRoomBoard.updateMany({
      where: {
        patient_id: patient.id,
        board_date: { gte: new Date(`${todayStr}T00:00:00.000Z`), lte: new Date(`${todayStr}T23:59:59.999Z`) },
      },
      data: { patient_id: null, patient_name: '', patient_no: '', chart_no: '', status: 'DISCHARGED' },
    });

    // 교환 대상이 있으면: 상대방을 현재 환자의 원래 자리로 이동
    if (swapPatient && oldRoomNo && oldBedNo != null) {
      // 상대방 보드 클리어
      await (prisma as any).wardRoomBoard.updateMany({
        where: {
          patient_id: swapPatient.id,
          board_date: { gte: new Date(`${todayStr}T00:00:00.000Z`), lte: new Date(`${todayStr}T23:59:59.999Z`) },
        },
        data: { patient_id: null, patient_name: '', patient_no: '', chart_no: '', status: 'DISCHARGED' },
      });
      // 상대방 Patient 업데이트 (원래 환자 자리로)
      await (prisma as any).patient.update({
        where: { id: swapPatient.id },
        data: { department_id: oldDeptId, room_no: oldRoomNo, bed_no: oldBedNo },
      });
      // 상대방 보드 배치
      const oldRoom = await (prisma as any).wardRoom.findFirst({
        where: { department_id: oldDeptId, room_no: oldRoomNo, deleted_at: null },
      });
      if (oldRoom) {
        await (prisma as any).wardRoomBoard.upsert({
          where: { board_date_department_id_ward_room_id_bed_no: { board_date: date, department_id: oldDeptId, ward_room_id: oldRoom.id, bed_no: oldBedNo } },
          create: { id: uuidv4(), board_date: date, department_id: oldDeptId, ward_room_id: oldRoom.id, room_no: oldRoomNo, bed_no: oldBedNo, patient_id: swapPatient.id, patient_name: swapPatient.name, patient_no: swapPatient.patient_no ?? '', chart_no: swapPatient.chart_no ?? '', status: 'ADMITTED' },
          update: { patient_id: swapPatient.id, patient_name: swapPatient.name, patient_no: swapPatient.patient_no ?? '', chart_no: swapPatient.chart_no ?? '', status: 'ADMITTED' },
        });
      }
      // 교환 이벤트 기록
      await (prisma as any).patientEvent.create({
        data: { id: uuidv4(), patient_id: swapPatient.id, department_id: targetDeptId, event_type: 'TRANSFER', event_date: today, room_no: newRoomNo, bed_no: newBedNo, memo: `자리교환: ${patient.name}`, created_by: req.user!.id },
      });
    }

    // Move patient to target
    const updated = await (prisma as any).patient.update({
      where: { id: patient.id },
      data: { department_id: targetDeptId, room_no: newRoomNo || '', bed_no: newBedNo },
    });

    // 새 보드에 배치
    if (newRoomNo && newBedNo != null) {
      const room = await (prisma as any).wardRoom.findFirst({
        where: { department_id: targetDeptId, room_no: newRoomNo, deleted_at: null },
      });
      if (room) {
        await (prisma as any).wardRoomBoard.upsert({
          where: { board_date_department_id_ward_room_id_bed_no: { board_date: date, department_id: targetDeptId, ward_room_id: room.id, bed_no: newBedNo } },
          create: { id: uuidv4(), board_date: date, department_id: targetDeptId, ward_room_id: room.id, room_no: newRoomNo, bed_no: newBedNo, patient_id: updated.id, patient_name: updated.name, patient_no: updated.patient_no ?? '', chart_no: updated.chart_no ?? '', status: 'ADMITTED' },
          update: { patient_id: updated.id, patient_name: updated.name, patient_no: updated.patient_no ?? '', chart_no: updated.chart_no ?? '', status: 'ADMITTED' },
        });
      }
    }

    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'patients', entity_id: updated.id, after: { department_id: targetDeptId, event_type: 'TRANSFER' } });
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 환자별 이벤트 이력
router.get('/:id/events', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const events = await (prisma as any).patientEvent.findMany({
      where: { patient_id: req.params.id, deleted_at: null },
      orderBy: { event_date: 'desc' },
      take: 20,
      include: { department: { select: { name: true } } },
    });
    res.json(events);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 환자별 급여/비급여 조회
router.get('/:id/charges', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
    const charges = await (prisma as any).patientCharge.findMany({
      where: { patient_id: req.params.id, charge_month: month, deleted_at: null },
      orderBy: [{ category: 'asc' }, { item_name: 'asc' }],
    });
    res.json(charges);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 환자별 급여/비급여 일괄 저장
router.put('/:id/charges', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const { month, items } = req.body;
    if (!month || !Array.isArray(items)) return res.status(400).json({ error: 'month와 items 필수' });
    const patientId = req.params.id;
    for (const item of items) {
      const where = { patient_id: patientId, charge_month: month, category: item.category, item_name: item.item_name, deleted_at: null };
      const existing = await (prisma as any).patientCharge.findFirst({ where });
      if (existing) {
        await (prisma as any).patientCharge.update({ where: { id: existing.id }, data: { amount: Number(item.amount ?? 0), note: item.note ?? '' } });
      } else if (Number(item.amount ?? 0) > 0) {
        await (prisma as any).patientCharge.create({ data: { id: uuidv4(), patient_id: patientId, category: item.category, item_name: item.item_name, amount: Number(item.amount ?? 0), charge_month: month, note: item.note ?? '' } });
      }
    }
    const charges = await (prisma as any).patientCharge.findMany({ where: { patient_id: patientId, charge_month: month, deleted_at: null }, orderBy: [{ category: 'asc' }, { item_name: 'asc' }] });
    res.json(charges);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

router.post('/:id/readmit', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const patient = await (prisma as any).patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });
    const updated = await (prisma as any).patient.update({
      where: { id: req.params.id },
      data: { status: 'ADMITTED', discharged_at: null, deceased_at: null },
    });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'patients', entity_id: updated.id, after: { status: 'ADMITTED' } });
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const deptId = req.body?.department_id || req.user!.department_id;
  if (!deptId) return res.status(400).json({ error: '부서를 지정해 주세요.' });
  const data = normalizePatient(req.body);
  if (data.project_name && (!data.project_region || !data.project_sigungu_office)) {
    return res.status(400).json({ error: '사업명칭 입력 시 지역과 시군구청은 필수입니다.' });
  }
  if (!data.chart_no) return res.status(400).json({ error: '차트번호는 필수입니다.' });
  try {
    const created = await (prisma as any).patient.create({
      data: {
        id: uuidv4(),
        department_id: deptId,
        admitted_at: req.body?.admitted_at ? new Date(req.body.admitted_at) : new Date(),
        room_no: String(req.body?.room_no ?? ''),
        bed_no: req.body?.bed_no ? Number(req.body.bed_no) : null,
        status: 'ADMITTED',
        created_by: req.user!.id,
        ...data,
        patient_no: data.patient_no || data.chart_no,
      } as any,
    });
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'patients', entity_id: created.id, after: { patient_no: created.patient_no, status: 'ADMITTED' } });
    res.status(201).json(created);
  } catch (e: any) {
    if (e?.message === 'PROJECT_SCOPE_REQUIRED') return res.status(400).json({ error: '사업명칭 입력 시 지역과 시군구청은 필수입니다.' });
    console.error(e);
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 환자번호/차트번호입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/:id', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const before = await (prisma as any).patient.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });
    const patch = normalizePatient(req.body);
    const nextProjectName = req.body?.project_name !== undefined ? patch.project_name : String(before.project_name ?? '');
    const nextProjectRegion = req.body?.project_region !== undefined ? patch.project_region : String(before.project_region ?? '');
    const nextProjectSigunguOffice = req.body?.project_sigungu_office !== undefined ? patch.project_sigungu_office : String(before.project_sigungu_office ?? '');
    validateProjectScope(nextProjectName, nextProjectRegion, nextProjectSigunguOffice);
    const after = await (prisma as any).patient.update({
      where: { id: req.params.id },
      data: {
        ...(req.body?.patient_no !== undefined && { patient_no: patch.patient_no }),
        ...(req.body?.chart_no !== undefined && { chart_no: patch.chart_no }),
        ...(req.body?.name !== undefined && { name: patch.name }),
        ...(req.body?.department_id !== undefined && { department_id: String(req.body.department_id) }),
        ...(req.body?.admitted_at !== undefined && { admitted_at: new Date(req.body.admitted_at) }),
        ...(req.body?.room_no !== undefined && { room_no: String(req.body.room_no ?? '') }),
        ...(req.body?.bed_no !== undefined && { bed_no: req.body.bed_no ? Number(req.body.bed_no) : null }),
        ...(req.body?.note !== undefined && { note: patch.note }),
        ...(req.body?.gender !== undefined && { gender: patch.gender }),
        ...(req.body?.mobility_type !== undefined && { mobility_type: patch.mobility_type }),
        ...(req.body?.insurance_type !== undefined && { insurance_type: patch.insurance_type }),
        ...(req.body?.copay_reduction !== undefined && { copay_reduction: patch.copay_reduction }),
        ...(req.body?.patient_group !== undefined && { patient_group: patch.patient_group }),
        ...(req.body?.specializations !== undefined && { specializations: patch.specializations }),
        ...(req.body?.infection_strain !== undefined && { infection_strain: patch.infection_strain }),
        ...(req.body?.period_type !== undefined && { period_type: patch.period_type }),
        ...(req.body?.period_phase !== undefined && { period_phase: patch.period_phase }),
        ...(req.body?.diaper_state !== undefined && { diaper_state: patch.diaper_state }),
        ...(req.body?.diaper_price !== undefined && { diaper_price: patch.diaper_price }),
        ...(req.body?.diaper_start_date !== undefined && { diaper_start_date: patch.diaper_start_date }),
        ...(req.body?.diaper_end_date !== undefined && { diaper_end_date: patch.diaper_end_date }),
        ...(req.body?.prev_hospital !== undefined && { prev_hospital: patch.prev_hospital }),
        ...(req.body?.acquaintance !== undefined && { acquaintance: patch.acquaintance }),
        ...(req.body?.acquaintance_color !== undefined && { acquaintance_color: patch.acquaintance_color }),
        ...(req.body?.address !== undefined && { address: String(req.body.address ?? '') }),
        ...(req.body?.referral_source !== undefined && { referral_source: String(req.body.referral_source ?? '') }),
        ...(req.body?.discharge_type !== undefined && { discharge_type: String(req.body.discharge_type ?? '') }),
        ...(req.body?.main_disease_code_id !== undefined && { main_disease_code_id: patch.main_disease_code_id }),
        ...(req.body?.caregiver_type !== undefined && { caregiver_type: patch.caregiver_type }),
        ...(req.body?.guardian_name !== undefined && { guardian_name: patch.guardian_name }),
        ...(req.body?.billing_sms_phone !== undefined && { billing_sms_phone: patch.billing_sms_phone }),
        ...(req.body?.project_name !== undefined && { project_name: patch.project_name }),
        ...(req.body?.project_region !== undefined && { project_region: patch.project_region }),
        ...(req.body?.project_sigungu_office !== undefined && { project_sigungu_office: patch.project_sigungu_office }),
        ...(req.body?.disease_code_id !== undefined && { disease_code_id: req.body.disease_code_id ? String(req.body.disease_code_id) : null }),
        ...(req.body?.disease_code_registered_at !== undefined && { disease_code_registered_at: req.body.disease_code_registered_at ? new Date(req.body.disease_code_registered_at) : null }),
        ...(req.body?.disease_code_expires_at !== undefined && { disease_code_expires_at: req.body.disease_code_expires_at ? new Date(req.body.disease_code_expires_at) : null }),
      } as any,
    });

    // V코드가 새로 지정된 경우 이력 자동 생성
    if (req.body?.disease_code_id && req.body.disease_code_id !== before.disease_code_id && req.body?.disease_code_registered_at) {
      try {
        const { v4: uuid4 } = await import('uuid');
        await (prisma as any).patientDiseaseCode.create({
          data: {
            id: uuid4(),
            patient_id: req.params.id,
            disease_code_id: String(req.body.disease_code_id),
            registered_at: new Date(req.body.disease_code_registered_at),
            expires_at: req.body.disease_code_expires_at ? new Date(req.body.disease_code_expires_at) : null,
            note: '',
            is_active: true,
          },
        });
      } catch { /* 이력 등록 실패는 무시 */ }
    }

    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'patients', entity_id: after.id, before: { id: before.id }, after: { id: after.id } });
    res.json(after);
  } catch (e: any) {
    if (e?.message === 'PROJECT_SCOPE_REQUIRED') return res.status(400).json({ error: '사업명칭 입력 시 지역과 시군구청은 필수입니다.' });
    console.error(e);
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 환자번호/차트번호입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

router.delete('/:id', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const patient = await (prisma as any).patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });
    await (prisma as any).patient.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    await audit({ actor_user_id: req.user!.id, action: 'SOFT_DELETE', entity_type: 'patients', entity_id: req.params.id });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/hospitals', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE'), (_req, res) => {
  try {
    res.json(readHospitals());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/hospitals', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: '병원명을 입력해 주세요.' });
  try {
    const rows = readHospitals();
    const exists = rows.some(r => r.name.toLowerCase() === name.toLowerCase());
    if (exists) return res.status(409).json({ error: '이미 등록된 병원입니다.' });
    const created = { id: uuidv4(), name };
    rows.push(created);
    rows.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    writeHospitals(rows);
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'hospitals', entity_id: created.id, after: created });
    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/incineration-entries', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    await ensureIncinerationTables(prisma as any);
    const from = req.query.from ? String(req.query.from).slice(0, 10) : `${new Date().toISOString().slice(0, 7)}-01`;
    const to = req.query.to ? String(req.query.to).slice(0, 10) : keyDate(new Date());
    const canViewAll = canViewAllPatients(req);
    const reqDept = req.query.department_id ? String(req.query.department_id) : '';
    const dept = normalizeDepartmentId(canViewAll ? reqDept : (req.user?.department_id ?? ''));
    const rows = await (prisma as any).$queryRaw`
      SELECT id, entry_date, department_id, weight_kg, note, created_by, created_at, updated_at
      FROM incineration_entries
      WHERE department_id=${dept}
        AND entry_date >= ${from}
        AND entry_date <= ${to}
      ORDER BY entry_date ASC, created_at ASC
    `;
    res.json((rows || []).map((r: any) => ({
      id: r.id,
      entry_date: String(r.entry_date),
      department_id: String(r.department_id ?? ''),
      weight_kg: Number(r.weight_kg ?? 0),
      note: String(r.note ?? ''),
      created_by: r.created_by ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/incineration-entries', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    await ensureIncinerationTables(prisma as any);
    const entryDate = String(req.body?.entry_date ?? '').slice(0, 10);
    const weight = Number(req.body?.weight_kg ?? 0);
    const note = String(req.body?.note ?? '').trim();
    const reqDept = req.body?.department_id ? String(req.body.department_id) : '';
    const dept = normalizeDepartmentId(canViewAllPatients(req) ? reqDept : (req.user?.department_id ?? ''));
    if (!entryDate) return res.status(400).json({ error: 'entry_date는 필수입니다.' });
    if (!isMonOrThu(entryDate)) return res.status(400).json({ error: '월요일/목요일 날짜만 입력 가능합니다.' });
    if (Number.isNaN(weight) || weight < 0) return res.status(400).json({ error: 'weight_kg 값이 올바르지 않습니다.' });
    const id = uuidv4();
    const createdBy = req.user!.id;
    await (prisma as any).$executeRaw`
      INSERT INTO incineration_entries (id, entry_date, department_id, weight_kg, note, created_by, created_at, updated_at)
      VALUES (
        ${id},
        ${entryDate},
        ${dept},
        ${weight},
        ${note},
        ${createdBy},
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(entry_date, department_id) DO UPDATE SET
        weight_kg=excluded.weight_kg,
        note=excluded.note,
        created_by=excluded.created_by,
        updated_at=datetime('now')
    `;
    await audit({ actor_user_id: req.user!.id, action: 'UPSERT', entity_type: 'incineration_entries', entity_id: `${entryDate}:${dept}`, after: { entry_date: entryDate, department_id: dept, weight_kg: weight } });
    res.status(201).json({ ok: true, entry_date: entryDate, department_id: dept, weight_kg: weight });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/incineration-entries/:id', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    await ensureIncinerationTables(prisma as any);
    const id = String(req.params.id);
    const entryDate = String(req.body?.entry_date ?? '').slice(0, 10);
    const weight = Number(req.body?.weight_kg ?? 0);
    const note = String(req.body?.note ?? '').trim();
    if (!entryDate) return res.status(400).json({ error: 'entry_date는 필수입니다.' });
    if (!isMonOrThu(entryDate)) return res.status(400).json({ error: '월요일/목요일 날짜만 입력 가능합니다.' });
    if (Number.isNaN(weight) || weight < 0) return res.status(400).json({ error: 'weight_kg 값이 올바르지 않습니다.' });

    const existing = await (prisma as any).$queryRaw`
      SELECT id, department_id FROM incineration_entries WHERE id=${id} LIMIT 1
    `;
    if (!existing?.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const oldDept = normalizeDepartmentId(existing[0].department_id);
    const userDept = normalizeDepartmentId(req.user?.department_id ?? '');
    const canViewAll = canViewAllPatients(req);
    if (!canViewAll && oldDept !== userDept) return res.status(403).json({ error: '권한이 없습니다.' });

    await (prisma as any).$executeRaw`
      UPDATE incineration_entries
      SET entry_date=${entryDate},
          weight_kg=${weight},
          note=${note},
          updated_at=datetime('now')
      WHERE id=${id}
    `;
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'incineration_entries', entity_id: id, after: { entry_date: entryDate, weight_kg: weight } });
    res.json({ ok: true, id, entry_date: entryDate, weight_kg: weight });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/incineration-monthly', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    await ensureIncinerationTables(prisma as any);
    const fromYm = req.query.from ? String(req.query.from).slice(0, 7) : toYearMonth(new Date());
    const toYm = req.query.to ? String(req.query.to).slice(0, 7) : toYearMonth(new Date());
    const fromDate = new Date(`${fromYm}-01T00:00:00.000Z`);
    const toDate = new Date(`${toYm}-28T00:00:00.000Z`);
    const canViewAll = canViewAllPatients(req);
    const reqDept = req.query.department_id ? String(req.query.department_id) : '';
    const dept = normalizeDepartmentId(canViewAll ? reqDept : (req.user?.department_id ?? ''));
    const monthly = await getIncinerationMonthlySummary(prisma as any, fromDate, toDate, dept);
    const totals = monthly.reduce((acc: any, r: any) => {
      acc.kg_month_sum += Number(r.kg_month_sum ?? 0);
      acc.auto_amount += Number(r.auto_amount ?? 0);
      acc.final_amount += Number(r.final_amount ?? 0);
      acc.variance += Number(r.variance ?? 0);
      return acc;
    }, { kg_month_sum: 0, auto_amount: 0, final_amount: 0, variance: 0 });
    res.json({ from: fromYm, to: toYm, department_id: dept, unit_price: (monthly as any[])[0]?.unit_price ?? INCINERATION_UNIT_PRICE, monthly, totals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/incineration-monthly/:yearMonth', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    await ensureIncinerationTables(prisma as any);
    const yearMonth = String(req.params.yearMonth).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: 'yearMonth 형식은 YYYY-MM 입니다.' });
    const reqDept = req.body?.department_id ? String(req.body.department_id) : '';
    const dept = normalizeDepartmentId(canViewAllPatients(req) ? reqDept : (req.user?.department_id ?? ''));
    const note = String(req.body?.note ?? '').trim();
    const hasOverride = req.body?.final_amount_override !== undefined && req.body?.final_amount_override !== null && String(req.body?.final_amount_override) !== '';
    const override = hasOverride ? Number(req.body.final_amount_override) : null;
    if (override !== null && (Number.isNaN(override) || override < 0)) return res.status(400).json({ error: 'final_amount_override 값이 올바르지 않습니다.' });

    const overrideId = uuidv4();
    const createdByMonthly = req.user!.id;
    await (prisma as any).$executeRaw`
      INSERT INTO incineration_monthly_overrides (id, year_month, department_id, final_amount_override, note, created_by, created_at, updated_at)
      VALUES (
        ${overrideId},
        ${yearMonth},
        ${dept},
        ${override},
        ${note},
        ${createdByMonthly},
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(year_month, department_id) DO UPDATE SET
        final_amount_override=excluded.final_amount_override,
        note=excluded.note,
        created_by=excluded.created_by,
        updated_at=datetime('now')
    `;
    await audit({ actor_user_id: req.user!.id, action: 'UPSERT', entity_type: 'incineration_monthly_overrides', entity_id: `${yearMonth}:${dept}`, after: { year_month: yearMonth, department_id: dept, final_amount_override: override } });
    res.json({ ok: true, year_month: yearMonth, department_id: dept, final_amount_override: override });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/stats', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const dateFrom = toDateOnly(String(req.query.date_from ?? ''));
    const dateTo = toDateOnly(String(req.query.date_to ?? ''));
    const canViewAll = canViewAllPatients(req);
    const requestedDepartmentId = req.query.department_id ? String(req.query.department_id) : undefined;
    const departmentId = canViewAll ? requestedDepartmentId : (req.user?.department_id ?? undefined);
    if (dateFrom > dateTo) return res.status(400).json({ error: 'date_from/date_to 값이 올바르지 않습니다.' });

    const dayMs = 24 * 60 * 60 * 1000;
    const days = Math.floor((dateTo.getTime() - dateFrom.getTime()) / dayMs) + 1;
    const prevDateTo = new Date(dateFrom.getTime() - dayMs);
    const prevDateFrom = new Date(prevDateTo.getTime() - (days - 1) * dayMs);
    const endOf = (d: Date) => new Date(`${keyDate(d)}T23:59:59.999Z`);
    const pct = (curr: number, prev: number) => (prev === 0 ? (curr === 0 ? 0 : 100) : Number((((curr - prev) / prev) * 100).toFixed(1)));

    const patientWhereBase: any = { deleted_at: null, ...(departmentId ? { department_id: departmentId } : {}) };

    const [allRoomRows, activePatients, currentEvents, prevEvents, overlapCurrent, overlapPrev, stockOutCurrent, stockOutPrev] = await Promise.all([
      (prisma as any).wardRoom.findMany({
        where: { deleted_at: null, is_active: true, ...(departmentId ? { department_id: departmentId } : {}) },
        include: { department: true },
      }),
      (prisma as any).patient.findMany({
        where: { ...patientWhereBase, status: 'ADMITTED' },
        include: { department: true },
        orderBy: [{ department: { name: 'asc' } }, { room_no: 'asc' }, { bed_no: 'asc' }],
      }),
      (prisma as any).patientEvent.findMany({
        where: {
          deleted_at: null,
          ...(departmentId ? { department_id: departmentId } : {}),
          event_date: { gte: dateFrom, lte: endOf(dateTo) },
        },
        include: { patient: true, department: true },
      }),
      (prisma as any).patientEvent.findMany({
        where: {
          deleted_at: null,
          ...(departmentId ? { department_id: departmentId } : {}),
          event_date: { gte: prevDateFrom, lte: endOf(prevDateTo) },
        },
        include: { patient: true, department: true },
      }),
      (prisma as any).patient.findMany({
        where: {
          ...patientWhereBase,
          admitted_at: { lte: endOf(dateTo) },
          OR: [{ discharged_at: null }, { discharged_at: { gte: dateFrom } }, { deceased_at: { gte: dateFrom } }],
        },
      }),
      (prisma as any).patient.findMany({
        where: {
          ...patientWhereBase,
          admitted_at: { lte: endOf(prevDateTo) },
          OR: [{ discharged_at: null }, { discharged_at: { gte: prevDateFrom } }, { deceased_at: { gte: prevDateFrom } }],
        },
      }),
      (prisma as any).stockOut.findMany({
        where: { status: { in: ACTIVE_STOCK_OUT_STATUSES as any }, issued_at: { gte: dateFrom, lte: endOf(dateTo) }, ...(departmentId ? { department_id: departmentId } : {}) },
        include: { items: { include: { item: true } } },
      }),
      (prisma as any).stockOut.findMany({
        where: { status: { in: ACTIVE_STOCK_OUT_STATUSES as any }, issued_at: { gte: prevDateFrom, lte: endOf(prevDateTo) }, ...(departmentId ? { department_id: departmentId } : {}) },
        include: { items: { include: { item: true } } },
      }),
    ]);

    // 전체 조회 시 병동 부서만 집계 (비병동 부서의 ward_rooms 제외)
    const roomRows = departmentId
      ? allRoomRows
      : allRoomRows.filter((r: any) => isWardDepartment(r.department));

    const capacityTotal = roomRows.reduce((s: number, r: any) => s + Number(r.capacity), 0);
    const occupied = activePatients.length;
    const dailyOccupancy = Array.from({ length: days }, (_, idx) => {
      const d = new Date(dateFrom.getTime() + idx * dayMs);
      const dEnd = endOf(d);
      const dStart = new Date(`${keyDate(d)}T00:00:00.000Z`);
      const occ = overlapCurrent.filter((p: any) => {
        const admitted = new Date(p.admitted_at);
        const closed = p.discharged_at ? new Date(p.discharged_at) : (p.deceased_at ? new Date(p.deceased_at) : null);
        return admitted <= dEnd && (!closed || closed >= dStart);
      }).length;
      const rate = capacityTotal > 0 ? Number(((occ / capacityTotal) * 100).toFixed(1)) : 0;
      return { date: keyDate(d), occupied: occ, capacity: capacityTotal, occupancy_rate: rate };
    });
    const prevDailyOccupancy = Array.from({ length: days }, (_, idx) => {
      const d = new Date(prevDateFrom.getTime() + idx * dayMs);
      const dEnd = endOf(d);
      const dStart = new Date(`${keyDate(d)}T00:00:00.000Z`);
      const occ = overlapPrev.filter((p: any) => {
        const admitted = new Date(p.admitted_at);
        const closed = p.discharged_at ? new Date(p.discharged_at) : (p.deceased_at ? new Date(p.deceased_at) : null);
        return admitted <= dEnd && (!closed || closed >= dStart);
      }).length;
      const rate = capacityTotal > 0 ? Number(((occ / capacityTotal) * 100).toFixed(1)) : 0;
      return { date: keyDate(d), occupied: occ, capacity: capacityTotal, occupancy_rate: rate };
    });

    const avgOcc = dailyOccupancy.length > 0 ? dailyOccupancy.reduce((s, d) => s + d.occupied, 0) / dailyOccupancy.length : 0;
    const avgOccRate = capacityTotal > 0 ? Number(((avgOcc / capacityTotal) * 100).toFixed(1)) : 0;
    const prevAvgOcc = prevDailyOccupancy.length > 0 ? prevDailyOccupancy.reduce((s, d) => s + d.occupied, 0) / prevDailyOccupancy.length : 0;
    const prevAvgOccRate = capacityTotal > 0 ? Number(((prevAvgOcc / capacityTotal) * 100).toFixed(1)) : 0;

    const admissionEvents = currentEvents.filter((e: any) => e.event_type === 'ADMISSION');
    const dischargeEvents = currentEvents.filter((e: any) => e.event_type === 'DISCHARGE' || e.event_type === 'DEATH');
    const deathEvents: any[] = []; // 사망 통계 제거 — 퇴원+사유로 통합
    const prevAdmissionEvents = prevEvents.filter((e: any) => e.event_type === 'ADMISSION');
    const prevDischargeEvents = prevEvents.filter((e: any) => e.event_type === 'DISCHARGE' || e.event_type === 'DEATH');
    const prevDeathEvents: any[] = [];

    const calcAlos = (events: any[]) => {
      const rows = events.filter((e: any) => e.patient?.admitted_at);
      if (rows.length === 0) return 0;
      const total = rows.reduce((s: number, e: any) => {
        const admitted = new Date(e.patient.admitted_at);
        const closed = new Date(e.event_date);
        const los = Math.max(1, Math.floor((closed.getTime() - admitted.getTime()) / dayMs) + 1);
        return s + los;
      }, 0);
      return Number((total / rows.length).toFixed(1));
    };
    const alosCurrent = calcAlos([...dischargeEvents, ...deathEvents]);
    const alosPrev = calcAlos([...prevDischargeEvents, ...prevDeathEvents]);

    const byDept = new Map<string, any>();
    const ensure = (dId: string, dName: string) => {
      if (!byDept.has(dId)) {
        byDept.set(dId, {
          department_id: dId,
          department_name: dName,
          capacity: 0,
          occupied: 0,
          patients: [],
          groups: {},
          insurance: {},
          specializations: {},
          periodType: {},
          diaper: {},
          caregiverType: {},
        });
      }
      return byDept.get(dId);
    };

    for (const r of roomRows) {
      const row = ensure(r.department_id, r.department?.name ?? '');
      row.capacity += Number(r.capacity);
    }
    for (const p of activePatients) {
      const row = ensure(p.department_id, p.department?.name ?? '');
      row.occupied += 1;
      row.patients.push({
        id: p.id,
        name: p.name,
        room_no: p.room_no,
        bed_no: p.bed_no,
        prev_hospital: p.prev_hospital,
        patient_group: p.patient_group,
        insurance_type: p.insurance_type,
        caregiver_type: p.caregiver_type,
        specializations: JSON.parse(p.specializations ?? '[]'),
        period_type: p.period_type,
        diaper_state: p.diaper_state,
      });
      const caregiverTypeKey = normalizeCaregiverType(p.caregiver_type) || 'NONE';
      row.groups[p.patient_group || 'UNRATED'] = (row.groups[p.patient_group || 'UNRATED'] ?? 0) + 1;
      row.insurance[p.insurance_type || 'HEALTH'] = (row.insurance[p.insurance_type || 'HEALTH'] ?? 0) + 1;
      row.caregiverType[caregiverTypeKey] = (row.caregiverType[caregiverTypeKey] ?? 0) + 1;
      const specs = JSON.parse(p.specializations ?? '[]');
      if (Array.isArray(specs)) for (const s of specs) row.specializations[s] = (row.specializations[s] ?? 0) + 1;
      if (p.period_type) row.periodType[p.period_type] = (row.periodType[p.period_type] ?? 0) + 1;
      if (p.diaper_state) row.diaper[p.diaper_state] = (row.diaper[p.diaper_state] ?? 0) + 1;
    }

    const infectionBy = {
      CRE: activePatients.filter((p: any) => p.infection_strain === 'CRE').length,
      VRE: activePatients.filter((p: any) => p.infection_strain === 'VRE').length,
      MR: activePatients.filter((p: any) => p.infection_strain === 'MR').length,
    };

    const diaperSummary = activePatients.reduce((acc: any, p: any) => {
      const state = normalizeDiaperState(p.diaper_state);
      const amount = Number(p.diaper_price ?? 0);
      if (state === DIAPER_STATES.IN_HOUSE) {
        acc.in_house_count += 1;
        acc.in_house_amount_total += amount;
      } else if (state === DIAPER_STATES.PERSONAL) {
        acc.personal_count += 1;
      } else {
        acc.none_count += 1;
      }
      return acc;
    }, { in_house_count: 0, personal_count: 0, none_count: 0, in_house_amount_total: 0 });
    diaperSummary.total_users = diaperSummary.in_house_count + diaperSummary.personal_count;
    diaperSummary.in_house_amount_avg = diaperSummary.in_house_count > 0
      ? Number((diaperSummary.in_house_amount_total / diaperSummary.in_house_count).toFixed(0))
      : 0;

    const categoryName = (item: any) => {
      const b = String((item as any)?.stats_bucket ?? '').toUpperCase();
      if (b === 'MEDICAL') return '의료소모품';
      if (b === 'GENERAL') return '일반소모품';
      if (b === 'OFFICE') return '사무용품';
      if (b === 'DIAPER_CARE') return '기저귀케어';
      if (b === 'FOOD') return '식음료';
      return '기타';
    };
    const sumConsumable = (rows: any[]) => {
      const out: Record<string, number> = {
        '의료소모품': 0,
        '일반소모품': 0,
        '사무용품': 0,
        '기저귀케어': 0,
        '식음료': 0,
      };
      for (const so of rows) {
        for (const it of so.items ?? []) {
          const key = categoryName(it.item);
          const amount = Number(it.issued_qty) * Number((it as any).unit_price ?? it.item?.latest_price ?? 0);
          if (out[key] !== undefined) out[key] += amount;
        }
      }
      return out;
    };
    const consumableCurrent = sumConsumable(stockOutCurrent);
    const consumablePrev = sumConsumable(stockOutPrev);
    const patientDaysCurrent = dailyOccupancy.reduce((s, d) => s + d.occupied, 0);
    const patientDaysPrev = prevDailyOccupancy.reduce((s, d) => s + d.occupied, 0);

    const diaperInsuranceCross = activePatients.reduce((acc: any, p: any) => {
      const grp = normalizeDiaperState(p.diaper_state);
      const ins = p.insurance_type || 'HEALTH';
      if (!acc[grp]) acc[grp] = {};
      acc[grp][ins] = (acc[grp][ins] ?? 0) + 1;
      return acc;
    }, {} as any);

    const highDays = dailyOccupancy.filter(d => d.occupancy_rate >= 90).map(d => d.date);
    const lowDays = dailyOccupancy.filter(d => d.occupancy_rate <= 80).map(d => d.date);
    const maxDay = dailyOccupancy.reduce((m: any, d: any) => (!m || d.occupancy_rate > m.occupancy_rate ? d : m), null);
    const minDay = dailyOccupancy.reduce((m: any, d: any) => (!m || d.occupancy_rate < m.occupancy_rate ? d : m), null);
    const incinerationMonthly = await getIncinerationMonthlySummary(prisma as any, dateFrom, dateTo, departmentId);
    const incinerationTotals = incinerationMonthly.reduce((acc: any, r: any) => {
      acc.kg_month_sum += Number(r.kg_month_sum ?? 0);
      acc.auto_amount += Number(r.auto_amount ?? 0);
      acc.final_amount += Number(r.final_amount ?? 0);
      acc.variance += Number(r.variance ?? 0);
      return acc;
    }, { kg_month_sum: 0, auto_amount: 0, final_amount: 0, variance: 0 });

    res.json({
      date_from: keyDate(dateFrom),
      date_to: keyDate(dateTo),
      period: {
        current: { date_from: keyDate(dateFrom), date_to: keyDate(dateTo) },
        previous: { date_from: keyDate(prevDateFrom), date_to: keyDate(prevDateTo) },
      },
      overall: {
        total_capacity: capacityTotal,
        total_occupied: occupied,
        total_available: Math.max(0, capacityTotal - occupied),
        occupancy_rate: avgOccRate,
        admitted_count: admissionEvents.length,
        prev_hospital_admission_count: admissionEvents.length,
        discharged_count: dischargeEvents.length,
        deceased_count: deathEvents.length,
        net_change: admissionEvents.length - dischargeEvents.length - deathEvents.length,
        avg_los: alosCurrent,
        admitted_daily_avg: Number((admissionEvents.length / Math.max(1, days)).toFixed(2)),
        discharged_daily_avg: Number((dischargeEvents.length / Math.max(1, days)).toFixed(2)),
        admitted_details: admissionEvents.map((e: any) => ({
          name: e.patient?.name ?? '',
          room_no: e.room_no ?? e.patient?.room_no ?? '',
          prev_hospital: e.prev_hospital ?? e.patient?.prev_hospital ?? '',
          event_date: e.event_date,
        })),
        discharged_details: dischargeEvents.map((e: any) => ({
          name: e.patient?.name ?? '',
          room_no: e.room_no ?? e.patient?.room_no ?? '',
          prev_hospital: e.prev_hospital ?? e.patient?.prev_hospital ?? '',
          event_date: e.event_date,
        })),
        deceased_details: deathEvents.map((e: any) => ({
          name: e.patient?.name ?? '',
          room_no: e.room_no ?? e.patient?.room_no ?? '',
          prev_hospital: e.prev_hospital ?? e.patient?.prev_hospital ?? '',
          event_date: e.event_date,
        })),
      },
      comparison: {
        admitted_count: { current: admissionEvents.length, previous: prevAdmissionEvents.length, diff_pct: pct(admissionEvents.length, prevAdmissionEvents.length) },
        discharged_count: { current: dischargeEvents.length, previous: prevDischargeEvents.length, diff_pct: pct(dischargeEvents.length, prevDischargeEvents.length) },
        hospice_count: { current: currentEvents.filter((e: any) => e.event_type === 'TRANSFER' && (e.memo || '').includes('임종실')).length, previous: prevEvents.filter((e: any) => e.event_type === 'TRANSFER' && (e.memo || '').includes('임종실')).length, diff_pct: pct(currentEvents.filter((e: any) => e.event_type === 'TRANSFER' && (e.memo || '').includes('임종실')).length, prevEvents.filter((e: any) => e.event_type === 'TRANSFER' && (e.memo || '').includes('임종실')).length) },
        avg_los: { current: alosCurrent, previous: alosPrev, diff_pct: pct(alosCurrent, alosPrev) },
        occupancy_rate: { current: avgOccRate, previous: prevAvgOccRate, diff_pct: pct(avgOccRate, prevAvgOccRate) },
      },
      occupancy: {
        daily: dailyOccupancy,
        average_occupied: Number(avgOcc.toFixed(2)),
        average_rate: avgOccRate,
        kpi_days: {
          gte_90: highDays,
          lte_80: lowDays,
          max_day: maxDay,
          min_day: minDay,
        },
      },
      consumable: {
        by_category: {
          current: consumableCurrent,
          previous: consumablePrev,
          diff_pct: Object.fromEntries(Object.keys(consumableCurrent).map(k => [k, pct(consumableCurrent[k], consumablePrev[k] ?? 0)])),
        },
        ppd: {
          current: Object.fromEntries(Object.keys(consumableCurrent).map(k => [k, patientDaysCurrent > 0 ? Number((consumableCurrent[k] / patientDaysCurrent).toFixed(2)) : 0])),
          previous: Object.fromEntries(Object.keys(consumablePrev).map(k => [k, patientDaysPrev > 0 ? Number((consumablePrev[k] / patientDaysPrev).toFixed(2)) : 0])),
        },
        sensitivity_per_1pct: Object.fromEntries(Object.keys(consumableCurrent).map(k => {
          const denom = avgOccRate - prevAvgOccRate;
          const val = denom === 0 ? 0 : Number(((consumableCurrent[k] - (consumablePrev[k] ?? 0)) / denom).toFixed(2));
          return [k, val];
        })),
      },
      diaper_analysis: {
        usage_counts: {
          in_house: diaperSummary.in_house_count,
          personal: diaperSummary.personal_count,
          none: diaperSummary.none_count,
          total_users: diaperSummary.total_users,
        },
        billing: {
          in_house_total_amount: Number(diaperSummary.in_house_amount_total.toFixed(0)),
          in_house_avg_amount: diaperSummary.in_house_amount_avg,
        },
        insurance_cross: diaperInsuranceCross,
        incineration: {
          included_count: diaperSummary.in_house_count,
          excluded_count: diaperSummary.personal_count + diaperSummary.none_count,
        },
      },
      incineration: {
        unit_price: (incinerationMonthly as any[])[0]?.unit_price ?? INCINERATION_UNIT_PRICE,
        monthly: incinerationMonthly,
        totals: {
          kg_month_sum: Number(incinerationTotals.kg_month_sum.toFixed(3)),
          auto_amount: Number(incinerationTotals.auto_amount.toFixed(0)),
          final_amount: Number(incinerationTotals.final_amount.toFixed(0)),
          variance: Number(incinerationTotals.variance.toFixed(0)),
        },
      },
      breakdown: {
        insurance_type: activePatients.reduce((acc: any, p: any) => {
          acc[p.insurance_type || 'HEALTH'] = (acc[p.insurance_type || 'HEALTH'] ?? 0) + 1;
          return acc;
        }, {}),
        specialization: activePatients.reduce((acc: any, p: any) => {
          const specs = JSON.parse(p.specializations ?? '[]');
          if (Array.isArray(specs)) for (const s of specs) acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {}),
        period_type: activePatients.reduce((acc: any, p: any) => {
          if (p.period_type) acc[p.period_type] = (acc[p.period_type] ?? 0) + 1;
          return acc;
        }, {}),
        patient_group: activePatients.reduce((acc: any, p: any) => {
          acc[p.patient_group || 'UNRATED'] = (acc[p.patient_group || 'UNRATED'] ?? 0) + 1;
          return acc;
        }, {}),
        caregiver_type: activePatients.reduce((acc: any, p: any) => {
          const key = normalizeCaregiverType(p.caregiver_type) || 'NONE';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        diaper: activePatients.reduce((acc: any, p: any) => {
          const s = normalizeDiaperState(p.diaper_state);
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {}),
        prev_hospital: overlapCurrent.reduce((acc: any, p: any) => {
          const key = (p.prev_hospital ?? '').trim() || '미등록';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        infection_strain: infectionBy,
        period_cumulative: {
          PNEUMONIA: activePatients.filter((p: any) => p.period_type === 'PNEUMONIA').length,
          SEPSIS: activePatients.filter((p: any) => p.period_type === 'SEPSIS').length,
        },
        address: activePatients.reduce((acc: any, p: any) => {
          const key = (p.address ?? '').trim() || '미등록';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        referral_source: activePatients.reduce((acc: any, p: any) => {
          const key = (p.referral_source ?? '').trim() || '미등록';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        discharge_type: (() => {
          const discharged = currentEvents.filter((e: any) => e.event_type === 'DISCHARGE' || e.event_type === 'DEATH');
          return discharged.reduce((acc: any, e: any) => {
            const key = (e.patient?.discharge_type ?? '').trim() || '미등록';
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {});
        })(),
        discharge_reason: (() => {
          const discharged = currentEvents.filter((e: any) => e.event_type === 'DISCHARGE' || e.event_type === 'DEATH');
          return discharged.reduce((acc: any, e: any) => {
            const key = (e.memo ?? '').trim() || '미입력';
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {});
        })(),
      },
      // 급여/비급여 집계
      charges: await (async () => {
        try {
          const monthFrom = dateFrom.toISOString().slice(0, 7);
          const monthTo = dateTo.toISOString().slice(0, 7);
          const allCharges: any[] = await (prisma as any).patientCharge.findMany({
            where: { deleted_at: null, charge_month: { gte: monthFrom, lte: monthTo }, ...(departmentId ? { patient: { department_id: departmentId } } : {}) },
          });
          const covered: Record<string, { total: number; count: number }> = {};
          const nonCovered: Record<string, { total: number; count: number }> = {};
          for (const c of allCharges) {
            const bucket = c.category === 'COVERED' ? covered : nonCovered;
            if (!bucket[c.item_name]) bucket[c.item_name] = { total: 0, count: 0 };
            bucket[c.item_name].total += Number(c.amount);
            bucket[c.item_name].count += 1;
          }
          return { covered, non_covered: nonCovered };
        } catch { return { covered: {}, non_covered: {} }; }
      })(),
      departments: Array.from(byDept.values()),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/analytics/consumables', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE', 'STATS_VIEW'), async (req: AuthRequest, res) => {
  try {
    const dateFrom = toDateOnly(String(req.query.date_from ?? ''));
    const dateTo = toDateOnly(String(req.query.date_to ?? ''));
    if (dateFrom > dateTo) return res.status(400).json({ error: 'date_from/date_to 값이 올바르지 않습니다.' });

    const canViewAll = canViewAllPatients(req);
    const requestedDepartmentId = req.query.department_id ? String(req.query.department_id) : undefined;
    const departmentId = canViewAll ? requestedDepartmentId : (req.user?.department_id ?? undefined);

    const dayMs = 24 * 60 * 60 * 1000;
    const days = Math.floor((dateTo.getTime() - dateFrom.getTime()) / dayMs) + 1;
    const prevTo = new Date(dateFrom.getTime() - dayMs);
    const prevFrom = new Date(prevTo.getTime() - (days - 1) * dayMs);
    const endOf = (d: Date) => new Date(`${keyDate(d)}T23:59:59.999Z`);
    const pct = (curr: number, prev: number) => (prev === 0 ? (curr === 0 ? 0 : 100) : Number((((curr - prev) / prev) * 100).toFixed(1)));

    const basePatientWhere: any = { deleted_at: null, ...(departmentId ? { department_id: departmentId } : {}) };

    const [
      rooms,
      activePatients,
      currentEvents,
      prevEvents,
      periodPatients,
      prevPeriodPatients,
      currentStockOut,
      prevStockOut,
    ] = await Promise.all([
      (prisma as any).wardRoom.findMany({
        where: { deleted_at: null, is_active: true, ...(departmentId ? { department_id: departmentId } : {}) },
      }),
      (prisma as any).patient.findMany({
        where: { ...basePatientWhere, status: 'ADMITTED' },
      }),
      (prisma as any).patientEvent.findMany({
        where: {
          deleted_at: null,
          ...(departmentId ? { department_id: departmentId } : {}),
          event_date: { gte: dateFrom, lte: endOf(dateTo) },
        },
        include: { patient: true },
      }),
      (prisma as any).patientEvent.findMany({
        where: {
          deleted_at: null,
          ...(departmentId ? { department_id: departmentId } : {}),
          event_date: { gte: prevFrom, lte: endOf(prevTo) },
        },
        include: { patient: true },
      }),
      (prisma as any).patient.findMany({
        where: {
          ...basePatientWhere,
          admitted_at: { lte: endOf(dateTo) },
          OR: [{ discharged_at: null }, { discharged_at: { gte: dateFrom } }, { deceased_at: { gte: dateFrom } }],
        },
      }),
      (prisma as any).patient.findMany({
        where: {
          ...basePatientWhere,
          admitted_at: { lte: endOf(prevTo) },
          OR: [{ discharged_at: null }, { discharged_at: { gte: prevFrom } }, { deceased_at: { gte: prevFrom } }],
        },
      }),
      (prisma as any).stockOut.findMany({
        where: {
          status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
          issued_at: { gte: dateFrom, lte: endOf(dateTo) },
          ...(departmentId ? { department_id: departmentId } : {}),
        },
        include: {
          items: {
            include: {
              item: { include: { price_history: { orderBy: { effective_from: 'desc' }, take: 1 } } },
            },
          },
        },
      }),
      (prisma as any).stockOut.findMany({
        where: {
          status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
          issued_at: { gte: prevFrom, lte: endOf(prevTo) },
          ...(departmentId ? { department_id: departmentId } : {}),
        },
        include: {
          items: {
            include: {
              item: { include: { price_history: { orderBy: { effective_from: 'desc' }, take: 1 } } },
            },
          },
        },
      }),
    ]);

    const totalBeds = rooms.reduce((s: number, r: any) => s + Number(r.capacity), 0);
    const dailyCensus = Array.from({ length: days }, (_, idx) => {
      const d = new Date(dateFrom.getTime() + idx * dayMs);
      const dStart = new Date(`${keyDate(d)}T00:00:00.000Z`);
      const dEnd = endOf(d);
      const census = periodPatients.filter((p: any) => {
        const ad = new Date(p.admitted_at);
        const cl = p.discharged_at ? new Date(p.discharged_at) : (p.deceased_at ? new Date(p.deceased_at) : null);
        return ad <= dEnd && (!cl || cl >= dStart);
      }).length;
      const rate = totalBeds > 0 ? Number(((census / totalBeds) * 100).toFixed(1)) : 0;
      return { date: keyDate(d), census, beds: totalBeds, occupancy_rate: rate };
    });
    const avgCensus = dailyCensus.length ? (dailyCensus.reduce((s, d) => s + d.census, 0) / dailyCensus.length) : 0;
    const occRate = totalBeds > 0 ? Number(((avgCensus / totalBeds) * 100).toFixed(1)) : 0;

    const prevDailyCensus = Array.from({ length: days }, (_, idx) => {
      const d = new Date(prevFrom.getTime() + idx * dayMs);
      const dStart = new Date(`${keyDate(d)}T00:00:00.000Z`);
      const dEnd = endOf(d);
      const census = prevPeriodPatients.filter((p: any) => {
        const ad = new Date(p.admitted_at);
        const cl = p.discharged_at ? new Date(p.discharged_at) : (p.deceased_at ? new Date(p.deceased_at) : null);
        return ad <= dEnd && (!cl || cl >= dStart);
      }).length;
      const rate = totalBeds > 0 ? Number(((census / totalBeds) * 100).toFixed(1)) : 0;
      return { date: keyDate(d), census, beds: totalBeds, occupancy_rate: rate };
    });
    const prevAvgCensus = prevDailyCensus.length ? (prevDailyCensus.reduce((s, d) => s + d.census, 0) / prevDailyCensus.length) : 0;
    const prevOccRate = totalBeds > 0 ? Number(((prevAvgCensus / totalBeds) * 100).toFixed(1)) : 0;

    const admissions = currentEvents.filter((e: any) => e.event_type === 'ADMISSION');
    const discharges = currentEvents.filter((e: any) => e.event_type === 'DISCHARGE');
    const deaths = currentEvents.filter((e: any) => e.event_type === 'DEATH');
    const prevAdmissions = prevEvents.filter((e: any) => e.event_type === 'ADMISSION');
    const prevDischarges = prevEvents.filter((e: any) => e.event_type === 'DISCHARGE');
    const prevDeaths = prevEvents.filter((e: any) => e.event_type === 'DEATH');

    const calcAlos = (rows: any[]) => {
      const valid = rows.filter((e: any) => e.patient?.admitted_at);
      if (!valid.length) return 0;
      const total = valid.reduce((s: number, e: any) => {
        const ad = new Date(e.patient.admitted_at);
        const cd = new Date(e.event_date);
        return s + Math.max(1, Math.floor((cd.getTime() - ad.getTime()) / dayMs) + 1);
      }, 0);
      return Number((total / valid.length).toFixed(1));
    };
    const alos = calcAlos([...discharges, ...deaths]);
    const prevAlos = calcAlos([...prevDischarges, ...prevDeaths]);

    const diseaseRows = activePatients.reduce((acc: any, p: any) => {
      const periodType = String(p.period_type ?? '').toUpperCase();
      if (periodType === 'PNEUMONIA') acc.PNEUMONIA = (acc.PNEUMONIA ?? 0) + 1;
      else if (periodType === 'SEPSIS') acc.SEPSIS = (acc.SEPSIS ?? 0) + 1;
      const specs = JSON.parse(p.specializations ?? '[]');
      if ((Array.isArray(specs) && specs.includes('INFECT')) || p.infection_strain) {
        acc.INFECTION = (acc.INFECTION ?? 0) + 1;
      }
      return acc;
    }, {} as any);

    const mapCategory = (it: any) => {
      const b = String(it?.item?.stats_bucket ?? '').toUpperCase();
      if (b === 'MEDICAL') return '의료소모품';
      if (b === 'GENERAL') return '일반소모품';
      if (b === 'OFFICE') return '사무용품';
      if (b === 'DIAPER_CARE') return '기저귀케어';
      if (b === 'FOOD') return '식음료';
      return '기타';
    };
    const mapDetailCategory = (c: string) => {
      if (c === 'GENERAL_PATIENT') return '환자용품';
      if (c === 'GENERAL_MGMT') return '병원관리';
      if (c === 'GENERAL_STAFF') return '직원용품';
      if (c === 'OFFICE_SUPPLY') return '사무용품';
      if (c === 'OFFICE_SEMI') return '사무기기(반소모)';
      if (c === 'GENERAL_SERVICE') return '식음료';
      if (c.startsWith('MEDICAL_')) return '의료소모품';
      return '기타';
    };
    const mapExpenseGroup = (scope: string): 'PATIENT_DIRECT' | 'OPS_INDIRECT' => {
      return String(scope || '').toUpperCase() === 'OPS_INDIRECT' ? 'OPS_INDIRECT' : 'PATIENT_DIRECT';
    };
    const aggregateCost = (rows: any[]) => {
      const cat: Record<string, { qty: number; amount: number }> = {
        '의료소모품': { qty: 0, amount: 0 },
        '일반소모품': { qty: 0, amount: 0 },
        '사무용품': { qty: 0, amount: 0 },
        '기저귀케어': { qty: 0, amount: 0 },
        '식음료': { qty: 0, amount: 0 },
      };
      const group = {
        PATIENT_DIRECT: { qty: 0, amount: 0 },
        OPS_INDIRECT: { qty: 0, amount: 0 },
      };
      const detail: Record<string, number> = {};
      const daily = new Map<string, number>();
      for (const so of rows) {
        const keyDateOnly = keyDate(new Date(so.issued_at));
        for (const it of so.items ?? []) {
          const k = mapCategory(it);
          if (!cat[k]) continue;
          const rawCat = String(it?.item?.category ?? '');
          const g = mapExpenseGroup(String(it?.item?.expense_scope ?? 'PATIENT_DIRECT'));
          const d = mapDetailCategory(rawCat);
          const unit = Number((it as any).unit_price ?? it.item?.price_history?.[0]?.price ?? 0);
          const qty = Number(it.issued_qty);
          const amt = qty * unit;
          cat[k].qty += qty;
          cat[k].amount += amt;
          group[g].qty += qty;
          group[g].amount += amt;
          detail[d] = (detail[d] ?? 0) + amt;
          daily.set(keyDateOnly, (daily.get(keyDateOnly) ?? 0) + amt);
        }
      }
      return { cat, group, detail, daily };
    };
    const currentCost = aggregateCost(currentStockOut);
    const prevCost = aggregateCost(prevStockOut);

    const patientDays = dailyCensus.reduce((s, d) => s + d.census, 0);
    const prevPatientDays = prevDailyCensus.reduce((s, d) => s + d.census, 0);
    const byCategoryCurrent = Object.fromEntries(Object.entries(currentCost.cat).map(([k, v]) => [k, Number(v.amount.toFixed(2))]));
    const byCategoryPrev = Object.fromEntries(Object.entries(prevCost.cat).map(([k, v]) => [k, Number(v.amount.toFixed(2))]));
    const ppdCurrent = Object.fromEntries(Object.entries(currentCost.cat).map(([k, v]) => [k, patientDays > 0 ? Number((v.amount / patientDays).toFixed(2)) : 0]));
    const ppdPrev = Object.fromEntries(Object.entries(prevCost.cat).map(([k, v]) => [k, prevPatientDays > 0 ? Number((v.amount / prevPatientDays).toFixed(2)) : 0]));
    const patientDirectCurrent = Number(currentCost.group.PATIENT_DIRECT.amount.toFixed(2));
    const patientDirectPrev = Number(prevCost.group.PATIENT_DIRECT.amount.toFixed(2));
    const opsIndirectCurrent = Number(currentCost.group.OPS_INDIRECT.amount.toFixed(2));
    const opsIndirectPrev = Number(prevCost.group.OPS_INDIRECT.amount.toFixed(2));
    const totalCurrent = Number((patientDirectCurrent + opsIndirectCurrent).toFixed(2));
    const totalPrev = Number((patientDirectPrev + opsIndirectPrev).toFixed(2));

    const dailyPairs = dailyCensus.map(d => {
      const amt = currentCost.daily.get(d.date) ?? 0;
      return { x: d.occupancy_rate, y: amt };
    });
    const meanX = dailyPairs.length ? dailyPairs.reduce((s, r) => s + r.x, 0) / dailyPairs.length : 0;
    const meanY = dailyPairs.length ? dailyPairs.reduce((s, r) => s + r.y, 0) / dailyPairs.length : 0;
    const cov = dailyPairs.reduce((s, r) => s + (r.x - meanX) * (r.y - meanY), 0);
    const varX = dailyPairs.reduce((s, r) => s + (r.x - meanX) ** 2, 0);
    const varY = dailyPairs.reduce((s, r) => s + (r.y - meanY) ** 2, 0);
    const slope = varX > 0 ? Number((cov / varX).toFixed(2)) : 0;
    const corr = varX > 0 && varY > 0 ? Number((cov / Math.sqrt(varX * varY)).toFixed(3)) : 0;

    const patientMix = {
      severity: activePatients.reduce((acc: any, p: any) => {
        const k = p.patient_group || 'UNRATED';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      insurance: activePatients.reduce((acc: any, p: any) => {
        const k = p.insurance_type || 'HEALTH';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    };

    const diaper = activePatients.reduce((acc: any, p: any) => {
      const state = normalizeDiaperState(p.diaper_state);
      const group = state === DIAPER_STATES.IN_HOUSE ? 'A' : (state === DIAPER_STATES.PERSONAL ? 'B' : 'C');
      acc.group_abc[group] = (acc.group_abc[group] ?? 0) + 1;
      const ins = p.insurance_type || 'HEALTH';
      if (!acc.insurance_cross[group]) acc.insurance_cross[group] = {};
      acc.insurance_cross[group][ins] = (acc.insurance_cross[group][ins] ?? 0) + 1;
      return acc;
    }, { group_abc: { A: 0, B: 0, C: 0 }, insurance_cross: {} as any });

    const occupancyRates = dailyCensus.map(d => d.occupancy_rate);
    const over90 = dailyCensus.filter(d => d.occupancy_rate >= 90).map(d => d.date);
    const under80 = dailyCensus.filter(d => d.occupancy_rate <= 80).map(d => d.date);
    const maxDay = dailyCensus.reduce((m: any, d: any) => (!m || d.occupancy_rate > m.occupancy_rate ? d : m), null);
    const minDay = dailyCensus.reduce((m: any, d: any) => (!m || d.occupancy_rate < m.occupancy_rate ? d : m), null);

    res.json({
      period: {
        current: { date_from: keyDate(dateFrom), date_to: keyDate(dateTo) },
        previous: { date_from: keyDate(prevFrom), date_to: keyDate(prevTo) },
      },
      admission_discharge: {
        total_admit: admissions.length,
        total_discharge: discharges.length,
        total_death: deaths.length,
        daily_avg_admit: Number((admissions.length / Math.max(days, 1)).toFixed(2)),
        daily_avg_discharge: Number((discharges.length / Math.max(days, 1)).toFixed(2)),
        net_change: admissions.length - discharges.length - deaths.length,
        alos,
      },
      occupancy: {
        daily_census: dailyCensus,
        avg_census: Number(avgCensus.toFixed(2)),
        occupancy_rate: occRate,
        kpi: { over_90_days: over90, under_80_days: under80, max_day: maxDay, min_day: minDay },
      },
      consumable_costs: {
        by_category: {
          current: byCategoryCurrent,
          previous: byCategoryPrev,
          diff_pct: Object.fromEntries(Object.keys(byCategoryCurrent).map(k => [k, pct((byCategoryCurrent as any)[k] ?? 0, (byCategoryPrev as any)[k] ?? 0)])),
        },
        ppd: { current: ppdCurrent, previous: ppdPrev },
        cost_structure: {
          basis: {
            patient_direct: '품목 마스터 expense_scope=PATIENT_DIRECT',
            ops_indirect: '품목 마스터 expense_scope=OPS_INDIRECT',
          },
          current: {
            patient_direct: patientDirectCurrent,
            ops_indirect: opsIndirectCurrent,
            total: totalCurrent,
          },
          previous: {
            patient_direct: patientDirectPrev,
            ops_indirect: opsIndirectPrev,
            total: totalPrev,
          },
          diff_pct: {
            patient_direct: pct(patientDirectCurrent, patientDirectPrev),
            ops_indirect: pct(opsIndirectCurrent, opsIndirectPrev),
            total: pct(totalCurrent, totalPrev),
          },
          detail_current: Object.fromEntries(Object.entries(currentCost.detail).map(([k, v]) => [k, Number((v as number).toFixed(2))])),
          detail_previous: Object.fromEntries(Object.entries(prevCost.detail).map(([k, v]) => [k, Number((v as number).toFixed(2))])),
        },
        sensitivity: { slope_per_1pct: slope, correlation: corr, mean_occupancy_rate: Number((occupancyRates.reduce((s, n) => s + n, 0) / Math.max(occupancyRates.length, 1)).toFixed(2)) },
      },
      patient_mix: patientMix,
      disease_pattern: {
        diagnosis: diseaseRows,
        key_disease_share: {
          PNEUMONIA: Number((((diseaseRows.PNEUMONIA ?? 0) / Math.max(activePatients.length, 1)) * 100).toFixed(1)),
          SEPSIS: Number((((diseaseRows.SEPSIS ?? 0) / Math.max(activePatients.length, 1)) * 100).toFixed(1)),
          INFECTION: Number((((diseaseRows.INFECTION ?? 0) / Math.max(activePatients.length, 1)) * 100).toFixed(1)),
        },
      },
      diaper_analysis: {
        group_abc: diaper.group_abc,
        insurance_cross: diaper.insurance_cross,
        leakage_estimate: {
          estimated_waste_units: diaper.group_abc.B * days,
          estimated_revenue_leak: diaper.group_abc.B * days * 1000,
        },
      },
      comparison: {
        admit_diff_pct: pct(admissions.length, prevAdmissions.length),
        discharge_diff_pct: pct(discharges.length, prevDischarges.length),
        death_diff_pct: pct(deaths.length, prevDeaths.length),
        alos_diff_pct: pct(alos, calcAlos([...prevDischarges, ...prevDeaths])),
        occupancy_diff_pct: pct(occRate, prevOccRate),
      },
      executive_summary: {
        strengths: [
          occRate >= 85 ? `평균 가동률 ${occRate}%로 병상 활용도가 높습니다.` : `평균 가동률 ${occRate}%로 병상 여유가 있습니다.`,
          Object.values(byCategoryCurrent as any).reduce((s: number, n: any) => s + Number(n), 0) > 0 ? '소모품 비용 데이터가 불출 기준으로 집계되었습니다.' : '해당 기간 소모품 불출 데이터가 적습니다.',
        ],
        weaknesses: [
          over90.length > 0 ? `가동률 90% 이상 일자가 ${over90.length}일 존재합니다.` : '가동률 과밀 일자는 없습니다.',
          diaper.group_abc.B > 0 ? `기저귀 본인 지참 환자 ${diaper.group_abc.B}명이 있습니다.` : '기저귀 본인 지참 환자는 없습니다.',
        ],
        recommendations: [
          '가동률 90% 이상 일자 중심으로 병상/인력 계획을 보정하세요.',
          '기저귀 본인/원내 분류를 기준으로 소각료 포함 대상을 관리하세요.',
          '카테고리별 PPD 상위 항목의 단가/수량을 주간 모니터링 하세요.',
        ],
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});
// ── 대량등록 헤더 매핑 ─────────────────────────────────────────────────
const IMPORT_HEADER_MAP: Record<string, string> = {
  '환자번호': 'patient_no', 'patient_no': 'patient_no', '번호': 'patient_no',
  '차트번호': 'chart_no',   'chart_no': 'chart_no',     '차트': 'chart_no',
  '이름': 'name',           'name': 'name',             '환자명': 'name', '성명': 'name',
  '성별': 'gender',
  '거동상태': 'mobility_type', '거동유형': 'mobility_type', '거동': 'mobility_type',
  '보험종류': 'insurance_type', '보험유형': 'insurance_type', '보험': 'insurance_type',
  '환자군': 'patient_group', '환자등급': 'patient_group', '등급': 'patient_group',
  '주상병': 'main_disease_code', '주상병코드': 'main_disease_code',
  '산정특례': 'disease_code', '산정특례코드': 'disease_code', 'V코드': 'disease_code',
  '산정특례시작일': 'disease_code_registered_at', '산정특례시작': 'disease_code_registered_at',
  '산정특례종료일': 'disease_code_expires_at', '산정특례종료': 'disease_code_expires_at', '산정특례기간': 'disease_code_expires_at',
  '특성화': 'specializations',
  '감염균주': 'infection_strain', '균주': 'infection_strain',
  '특정기간': 'period_type', '특정기간질환': 'period_type',
  '기저귀': 'diaper_state', '기저귀상태': 'diaper_state',
  '기저귀수량': 'diaper_price', '기저귀금액': 'diaper_price',
  '입원전병원': 'prev_hospital', '이전병원': 'prev_hospital',
  '입원일': 'admitted_at',
  '병실': 'room_no',
  '병상': 'bed_no', '병상번호': 'bed_no', '자리번호': 'bed_no', '자리': 'bed_no',
  '병동': 'dept_name', '부서': 'dept_name',
  '간병유형': 'caregiver_type',
  '보호자': 'guardian_name',
  '연락처': 'billing_sms_phone', '문자수신번호': 'billing_sms_phone',
};
const cleanHdr = (cell: any) => String(cell ?? '').trim().replace(/[★*✓✗]/g, '').trim();
const isImportHeaderRow = (row: any[]) =>
  row.filter(cell => IMPORT_HEADER_MAP[cleanHdr(cell)]).length >= 2;

router.get('/import/template', requirePermission('REQUEST_USE'), (_req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = [[
    '차트번호', '이름', '성별', '거동상태',
    '보험유형', '환자군', '특성화', '감염균주', '특정기간', '특정기간단계',
    '특정기간시작일', '특정기간종료일',
    '기저귀', '기저귀금액', '기저귀시작일', '기저귀종료일',
    '입원전병원', '입원일', '병실', '병상',
    '주상병코드', '주상병명', '산정특례코드', '산정특례명', '산정특례시작일', '산정특례종료일',
    '간병유형', '보호자', '연락처',
    '지인', '지인색상', '사업명', '사업지역', '시군구관할관청', '비고', '상태',
  ]];
  const samples = [
    ['C2026001', '홍길동', '남', '와상', '건강보험', '중도', '재활', '', '', '', '', '', '원내', '30000', '', '', 'KS병원', '2026-02-01', '201호', '1', 'I10', '', '', '', '', '', '밀착간병', '홍부모', '010-1234-5678', '', '', '', '', '', '', ''],
    ['C2026002', '김영희', '여', '거동', '본인부담중증', '경도', '감염,투석', 'CRE', '폐렴', '시작', '2026-01-15', '', '본인', '', '', '', '광명병원', '2026-02-10', '202호', '2', 'J18', '', 'V193', '뇌졸중', '2026-01-01', '2027-01-01', '외주간병', '김보호', '010-9876-5432', '박지인', '파랑', '', '', '', '특이사항 없음', ''],
    ['C2026003', '이철수', '남', '와상', '산재', '고도', '', '', '', '', '', '', '없음', '', '', '', '', '2026-02-15', '203호', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet([...headers, ...samples]);
  ws['!cols'] = [12,10,8,10,16,10,16,12,10,12,16,16,10,12,14,14,16,12,10,8,12,16,12,16,16,16,12,12,14,12,10,16,12,16,20,10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, '환자등록양식');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="patient_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/import/preview', requirePermission('REQUEST_USE'), upload.single('file'), async (req: AuthRequest, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length === 0) return res.json({ headers: [], preview: [], total: 0, is_header_mode: false, recognized: [] });

    const firstRow = rows[0] as any[];
    const isHeaderMode = isImportHeaderRow(firstRow);

    let headers: string[];
    let dataRows: any[][];

    if (isHeaderMode) {
      headers = firstRow.map(c => String(c ?? '').trim());
      dataRows = rows.slice(1).filter(r => r.some((c: any) => c !== ''));
    } else {
      headers = ['차트번호', '이름', '성별', '거동상태', '보험유형', '환자군', '특성화', '감염균주', '특정기간', '특정기간단계', '특정기간시작일', '특정기간종료일', '기저귀', '기저귀금액', '기저귀시작일', '기저귀종료일', '입원전병원', '입원일', '병실', '병상', '주상병코드', '주상병명', '산정특례코드', '산정특례명', '산정특례시작일', '산정특례종료일', '간병유형', '보호자', '연락처', '지인', '지인색상', '사업명', '사업지역', '시군구관할관청', '비고'];
      dataRows = rows.slice(1).filter(r => r.some((c: any) => c !== ''));
    }

    const recognized = isHeaderMode
      ? headers.filter(h => IMPORT_HEADER_MAP[cleanHdr(h)])
      : headers;

    res.json({
      is_header_mode: isHeaderMode,
      headers,
      recognized,
      preview: dataRows.slice(0, 5).map(r => headers.map((_, i) => String(r[i] ?? ''))),
      total: dataRows.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: '파일 처리 오류' });
  }
});

router.post('/import', requirePermission('REQUEST_USE'), upload.single('file'), async (req: AuthRequest, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const deptId = req.user!.department_id;
  if (!deptId) return res.status(400).json({ error: '부서 정보가 없습니다.' });

  try {
    const result = await importPatientsFromBuffer(req.file.buffer, deptId, req.user!.id);
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: '파일 처리 오류' });
  }
});

export default router;




