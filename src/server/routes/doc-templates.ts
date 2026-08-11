/**
 * 문서자동화 엔진 — 회사양식(엑셀/HWPX) 템플릿·규칙 관리 + 문서 생성.
 *
 * 관리자가 양식 파일을 업로드하고, 필드 매핑·조건 규칙을 화면에서 등록하면
 * (코드 수정 없이) 그 양식으로 문서를 생성할 수 있다.
 *
 * 권한: 템플릿/규칙 CRUD = SYSTEM_ADMIN. 문서 생성 = PURCHASE_MANAGE/SYSTEM_ADMIN.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { resolveRenderPlan } from '../services/doc-engine/rule-engine';
import type { FieldDef, RuleDef } from '../services/doc-engine/types';
import { readExcelGrid, fillExcelTemplate, ExcelFieldBinding, ExcelTableBinding } from '../services/doc-engine/excel-adapter';
import { fillHwpxTemplate, detectHwpxPlaceholders, HwpxTableBinding } from '../services/doc-engine/hwpx-adapter';
import { generateAutoSeqValue } from '../services/doc-engine/doc-sequence';

const router = Router();
router.use(authMiddleware);

const TEMPLATES_DIR = path.join(process.env.USER_DATA_PATH || '.', 'uploads', 'doc-templates');
const GENERATED_DIR = path.join(process.env.USER_DATA_PATH || '.', 'generated', 'doc-submissions');

const uploadTemplate = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
      cb(null, TEMPLATES_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.hwpx') cb(null, true);
    else cb(new Error('.xlsx 또는 .hwpx 파일만 업로드 가능합니다.'));
  },
});

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

// ── 템플릿 CRUD ────────────────────────────────────────────────
router.get('/', requirePermission('SYSTEM_ADMIN', 'PURCHASE_MANAGE'), async (_req: AuthRequest, res) => {
  const rows = await (prisma as any).docTemplate.findMany({
    where: { deleted_at: null },
    orderBy: { created_at: 'desc' },
  });
  res.json(rows);
});

router.get('/:id', requirePermission('SYSTEM_ADMIN', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const row = await (prisma as any).docTemplate.findUnique({
    where: { id: req.params.id },
    include: { rules: { where: { deleted_at: null }, orderBy: { priority: 'asc' } } },
  });
  if (!row || row.deleted_at) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
  res.json(row);
});

router.post('/', requirePermission('SYSTEM_ADMIN'), uploadTemplate.single('file'), async (req: AuthRequest, res) => {
  try {
    const { name, doc_type, description } = req.body;
    if (!name || !doc_type) return res.status(400).json({ error: 'name, doc_type 은 필수입니다.' });
    if (!req.file) return res.status(400).json({ error: '양식 파일을 업로드해주세요.' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const format = ext === '.xlsx' ? 'EXCEL' : 'HWPX';

    const row = await (prisma as any).docTemplate.create({
      data: {
        id: uuidv4(),
        name,
        doc_type,
        format,
        description: description ?? '',
        master_file_path: req.file.path,
        created_by: req.user!.id,
      },
    });
    res.json(row);
  } catch (e: any) {
    console.error('[POST /doc-templates] error:', e);
    res.status(500).json({ error: e.message ?? '템플릿 등록 중 오류가 발생했습니다.' });
  }
});

router.put('/:id', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { name, description, field_schema_json, section_keys_json, table_binding_json, default_visible_sections_json, is_active } = req.body;
    const row = await (prisma as any).docTemplate.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(field_schema_json !== undefined ? { field_schema_json: JSON.stringify(field_schema_json) } : {}),
        ...(section_keys_json !== undefined ? { section_keys_json: JSON.stringify(section_keys_json) } : {}),
        ...(table_binding_json !== undefined ? { table_binding_json: JSON.stringify(table_binding_json) } : {}),
        ...(default_visible_sections_json !== undefined ? { default_visible_sections_json: JSON.stringify(default_visible_sections_json) } : {}),
        ...(is_active !== undefined ? { is_active } : {}),
        version: { increment: 1 },
      },
    });
    res.json(row);
  } catch (e: any) {
    console.error('[PUT /doc-templates/:id] error:', e);
    res.status(500).json({ error: e.message ?? '템플릿 수정 중 오류가 발생했습니다.' });
  }
});

router.delete('/:id', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  await (prisma as any).docTemplate.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
  res.json({ ok: true });
});

// 엑셀 템플릿 미리보기 그리드 — 관리자 셀 클릭 매핑 화면용
router.get('/:id/grid', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const tpl = await (prisma as any).docTemplate.findUnique({ where: { id: req.params.id } });
    if (!tpl || tpl.deleted_at) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    if (tpl.format !== 'EXCEL') return res.status(400).json({ error: '그리드 미리보기는 엑셀 템플릿만 지원합니다.' });
    const grid = await readExcelGrid(tpl.master_file_path);
    res.json(grid);
  } catch (e: any) {
    console.error('[GET /doc-templates/:id/grid] error:', e);
    res.status(500).json({ error: e.message ?? '양식을 읽는 중 오류가 발생했습니다.' });
  }
});

// HWPX 템플릿의 {{자리표시자}}/[SECTION] 마커 자동 탐지 — 관리자 필드 매핑 화면용
router.get('/:id/detect-placeholders', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const tpl = await (prisma as any).docTemplate.findUnique({ where: { id: req.params.id } });
    if (!tpl || tpl.deleted_at) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    if (tpl.format !== 'HWPX') return res.status(400).json({ error: '자리표시자 탐지는 HWPX 템플릿만 지원합니다.' });
    const detected = await detectHwpxPlaceholders(tpl.master_file_path);
    res.json(detected);
  } catch (e: any) {
    console.error('[GET /doc-templates/:id/detect-placeholders] error:', e);
    res.status(500).json({ error: e.message ?? '자리표시자 탐지 중 오류가 발생했습니다.' });
  }
});

// ── 규칙 CRUD ──────────────────────────────────────────────────
router.post('/:id/rules', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  const { name, priority, condition, action_type, action_payload } = req.body;
  if (!action_type) return res.status(400).json({ error: 'action_type 은 필수입니다.' });
  const row = await (prisma as any).docTemplateRule.create({
    data: {
      id: uuidv4(),
      template_id: req.params.id,
      name: name ?? '',
      priority: priority ?? 0,
      condition_json: JSON.stringify(condition ?? {}),
      action_type,
      action_payload_json: JSON.stringify(action_payload ?? {}),
    },
  });
  res.json(row);
});

router.put('/:id/rules/:ruleId', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  const { name, priority, condition, action_type, action_payload, is_active } = req.body;
  const row = await (prisma as any).docTemplateRule.update({
    where: { id: req.params.ruleId },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(condition !== undefined ? { condition_json: JSON.stringify(condition) } : {}),
      ...(action_type !== undefined ? { action_type } : {}),
      ...(action_payload !== undefined ? { action_payload_json: JSON.stringify(action_payload) } : {}),
      ...(is_active !== undefined ? { is_active } : {}),
    },
  });
  res.json(row);
});

router.delete('/:id/rules/:ruleId', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  await (prisma as any).docTemplateRule.update({ where: { id: req.params.ruleId }, data: { deleted_at: new Date() } });
  res.json({ ok: true });
});

// ── 규칙엔진만 실행 (COM/파일 I/O 없음) — 관리자 규칙 빌더의 즉시 미리보기용 ──
router.post('/:id/preview', requirePermission('SYSTEM_ADMIN', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const tpl = await (prisma as any).docTemplate.findUnique({
      where: { id: req.params.id },
      include: { rules: { where: { deleted_at: null, is_active: true }, orderBy: { priority: 'asc' } } },
    });
    if (!tpl || tpl.deleted_at) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });

    const fields = parseJson<FieldDef[]>(tpl.field_schema_json, []);
    const sectionKeys = parseJson<string[]>(tpl.section_keys_json, []);
    const defaultVisibleSections = parseJson<string[]>(tpl.default_visible_sections_json, []);
    const rules: RuleDef[] = tpl.rules.map((r: any) => ({
      id: r.id,
      priority: r.priority,
      condition: parseJson(r.condition_json, {}),
      action_type: r.action_type,
      action_payload: parseJson(r.action_payload_json, {}),
    }));

    const input = req.body?.input ?? {};
    const plan = resolveRenderPlan({ fields, allSectionKeys: sectionKeys, defaultVisibleSections, rules, input });
    res.json({ plan, fields });
  } catch (e: any) {
    console.error('[POST /doc-templates/:id/preview] error:', e);
    res.status(500).json({ error: e.message ?? '미리보기 계산 중 오류가 발생했습니다.' });
  }
});

// ── 문서 생성 ──────────────────────────────────────────────────
// body: { input: 사용자 입력값(수동 필드), source: DB_BOUND 필드 조회용 원본 객체(선택),
//         field_bindings, table_bindings: 엑셀 셀 매핑(관리자가 등록한 값, field_schema_json 과 별도 저장해도 되지만
//         여기서는 table_binding_json 을 그대로 사용) }
router.post('/:id/generate', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const tpl = await (prisma as any).docTemplate.findUnique({
      where: { id: req.params.id },
      include: { rules: { where: { deleted_at: null, is_active: true }, orderBy: { priority: 'asc' } } },
    });
    if (!tpl || tpl.deleted_at) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    if (!tpl.is_active) return res.status(400).json({ error: '비활성화된 템플릿입니다.' });

    const fields = parseJson<FieldDef[]>(tpl.field_schema_json, []);
    const sectionKeys = parseJson<string[]>(tpl.section_keys_json, []);
    const defaultVisibleSections = parseJson<string[]>(tpl.default_visible_sections_json, []);
    const rules: RuleDef[] = tpl.rules.map((r: any) => ({
      id: r.id,
      priority: r.priority,
      condition: parseJson(r.condition_json, {}),
      action_type: r.action_type,
      action_payload: parseJson(r.action_payload_json, {}),
    }));

    const manualInput: Record<string, unknown> = req.body?.input ?? {};
    const source: Record<string, unknown> = req.body?.source ?? {};

    // DB_BOUND 필드는 source 에서 bind_path 로 추출, AUTO_SEQ 는 채번, MANUAL 은 사용자 입력값 사용
    const fieldValues: Record<string, string> = {};
    const evalInput: Record<string, unknown> = { ...manualInput };
    let seqNo = '';
    for (const f of fields) {
      if (f.source === 'DB_BOUND' && f.bind_path) {
        const value = f.bind_path.split('.').reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as any)[key]), source);
        fieldValues[f.key] = value === undefined || value === null ? '' : String(value);
        evalInput[f.key] = value;
      } else if (f.source === 'AUTO_SEQ' && f.auto_seq) {
        const value = await generateAutoSeqValue(f.auto_seq);
        fieldValues[f.key] = value;
        evalInput[f.key] = value;
        seqNo = value;
      } else {
        fieldValues[f.key] = manualInput[f.key] === undefined || manualInput[f.key] === null ? '' : String(manualInput[f.key]);
      }
    }

    const plan = resolveRenderPlan({ fields, allSectionKeys: sectionKeys, defaultVisibleSections, rules, input: evalInput });

    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const ext = tpl.format === 'EXCEL' ? 'xlsx' : 'hwpx';
    const outputFileName = `${uuidv4()}.${ext}`;
    const outputFilePath = path.join(GENERATED_DIR, outputFileName);

    if (tpl.format === 'EXCEL') {
      const tableBindings: Record<string, ExcelTableBinding> = parseJson(tpl.table_binding_json, {});
      const fieldBindings: Record<string, ExcelFieldBinding> = {};
      for (const f of fields) {
        if (f.excel_cell) fieldBindings[f.key] = f.excel_cell;
      }
      await fillExcelTemplate({
        masterFilePath: tpl.master_file_path,
        outputFilePath,
        fieldValues,
        fieldBindings,
        tableRows: plan.extra_table_rows,
        tableBindings,
      });
    } else {
      const tableBindings: Record<string, HwpxTableBinding> = parseJson(tpl.table_binding_json, {});
      await fillHwpxTemplate({
        masterFilePath: tpl.master_file_path,
        outputFilePath,
        fieldValues,
        tableRows: plan.extra_table_rows,
        tableBindings,
        visibleSections: plan.visible_sections,
        hiddenSections: plan.hidden_sections,
      });
    }

    const submission = await (prisma as any).docSubmission.create({
      data: {
        id: uuidv4(),
        template_id: tpl.id,
        source_type: req.body?.source_type ?? '',
        source_id: req.body?.source_id ?? '',
        seq_no: seqNo,
        input_json: JSON.stringify(manualInput),
        render_plan_json: JSON.stringify(plan),
        output_file_path: outputFilePath,
        status: 'SUCCESS',
        generated_by: req.user!.id,
      },
    });

    res.download(outputFilePath, `${tpl.name}.${ext}`);
    void submission;
  } catch (e: any) {
    console.error('[POST /doc-templates/:id/generate] error:', e);
    res.status(500).json({ error: e.message ?? '문서 생성 중 오류가 발생했습니다.' });
  }
});

export default router;
