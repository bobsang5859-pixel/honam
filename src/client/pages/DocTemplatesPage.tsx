import { useCallback, useEffect, useState } from 'react';
import { FileText, Plus, Trash2, Wand2 } from 'lucide-react';
import { api, downloadBlob, getToken } from '../utils/api';
import { PageHeader, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';

interface FieldDef {
  key: string;
  label: string;
  type: string;
  source: 'DB_BOUND' | 'MANUAL' | 'AUTO_SEQ';
  bind_path?: string;
  excel_cell?: { sheet_index: number; cell: string };
  auto_seq?: { scope_key_template: string; number_template: string; pad: number };
}

interface TableBinding {
  rows_reserved: number;
  columns: string[];
  sheet_index?: number;
  start_row?: number;
}

interface Rule {
  id: string;
  name: string;
  priority: number;
  condition_json: string;
  action_type: string;
  action_payload_json: string;
}

interface DocTemplate {
  id: string;
  name: string;
  doc_type: string;
  format: 'EXCEL' | 'HWPX';
  description: string;
  is_active: boolean;
  field_schema_json: string;
  section_keys_json: string;
  table_binding_json: string;
  default_visible_sections_json: string;
  rules?: Rule[];
}

function parseJson<T>(s: string | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'textarea'];
const ACTION_TYPES = ['SHOW_FIELD', 'HIDE_FIELD', 'SHOW_SECTION', 'HIDE_SECTION', 'ADD_TABLE_ROWS'];

export default function DocTemplatesPage() {
  const [templates, setTemplates] = useState<DocTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [createModal, setCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', doc_type: '', description: '' });
  const [createFile, setCreateFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [selected, setSelected] = useState<DocTemplate | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [sectionKeys, setSectionKeys] = useState('');
  const [defaultVisibleSections, setDefaultVisibleSections] = useState('');
  const [tableBindings, setTableBindings] = useState<Record<string, TableBinding>>({});

  const [detected, setDetected] = useState<{ placeholders: string[]; sections: string[] } | null>(null);
  const [grid, setGrid] = useState<any>(null);

  const [ruleForm, setRuleForm] = useState({ name: '', priority: 0, field: '', op: 'eq', value: '', action_type: 'SHOW_SECTION', target: '' });

  const [testInput, setTestInput] = useState<Record<string, string>>({});
  const [testSourceJson, setTestSourceJson] = useState('{}');
  const [previewResult, setPreviewResult] = useState<any>(null);

  const showMsg = (type: 'ok' | 'err', text: string) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    api('/doc-templates').then(setTemplates).catch((e) => showMsg('err', e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setCreateForm({ name: '', doc_type: '', description: '' });
    setCreateFile(null);
    setCreateModal(true);
  };

  const createTemplate = async () => {
    if (!createForm.name || !createForm.doc_type) { showMsg('err', '이름과 문서종류 키는 필수입니다.'); return; }
    if (!createFile) { showMsg('err', '양식 파일(.xlsx 또는 .hwpx)을 선택해주세요.'); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('name', createForm.name);
      fd.append('doc_type', createForm.doc_type);
      fd.append('description', createForm.description);
      fd.append('file', createFile);
      await api('/doc-templates', { method: 'POST', body: fd });
      showMsg('ok', '템플릿이 등록되었습니다.');
      setCreateModal(false);
      load();
    } catch (e: any) { showMsg('err', e.message); }
    finally { setSubmitting(false); }
  };

  const openDetail = async (tpl: DocTemplate) => {
    setSelected(tpl);
    setFields(parseJson<FieldDef[]>(tpl.field_schema_json, []));
    setSectionKeys(parseJson<string[]>(tpl.section_keys_json, []).join(', '));
    setDefaultVisibleSections(parseJson<string[]>(tpl.default_visible_sections_json, []).join(', '));
    setTableBindings(parseJson<Record<string, TableBinding>>(tpl.table_binding_json, {}));
    setDetected(null);
    setGrid(null);
    setPreviewResult(null);
    setTestInput({});
    setTestSourceJson('{}');
    if (tpl.format === 'EXCEL') {
      try { setGrid(await api(`/doc-templates/${tpl.id}/grid`)); } catch { /* ignore */ }
    }
  };

  const closeDetail = () => setSelected(null);

  const deleteTemplate = async (tpl: DocTemplate) => {
    if (!window.confirm(`"${tpl.name}" 양식을 삭제할까요?`)) return;
    try {
      await api(`/doc-templates/${tpl.id}`, { method: 'DELETE' });
      showMsg('ok', '삭제되었습니다.');
      if (selected?.id === tpl.id) closeDetail();
      load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  const saveFieldsAndSections = async () => {
    if (!selected) return;
    try {
      const body = {
        field_schema_json: fields,
        section_keys_json: sectionKeys.split(',').map((s) => s.trim()).filter(Boolean),
        default_visible_sections_json: defaultVisibleSections.split(',').map((s) => s.trim()).filter(Boolean),
        table_binding_json: tableBindings,
      };
      const updated = await api(`/doc-templates/${selected.id}`, { method: 'PUT', body: JSON.stringify(body) });
      showMsg('ok', '저장되었습니다.');
      setSelected(updated);
      load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  const addField = () => {
    setFields((prev) => [...prev, { key: '', label: '', type: 'text', source: 'MANUAL' }]);
  };
  const updateField = (idx: number, patch: Partial<FieldDef>) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };
  const removeField = (idx: number) => setFields((prev) => prev.filter((_, i) => i !== idx));

  // 엑셀 미리보기에서 셀을 클릭하면 바로 필드로 등록/해제 — 시트번호·셀주소를 직접 타이핑할 필요 없음
  const mapExcelCell = (sheetIndex: number, address: string, currentValue: string) => {
    const idx = fields.findIndex((f) => f.excel_cell?.sheet_index === sheetIndex && f.excel_cell?.cell === address);
    if (idx >= 0) {
      if (window.confirm(`"${fields[idx].label}" 필드 매핑을 해제할까요? (셀: ${address})`)) removeField(idx);
      return;
    }
    const label = window.prompt(`이 칸(${address})에는 어떤 값이 들어가나요?\n예: 거래처명, 작성일자, 금액`, currentValue || '');
    if (!label) return;
    const key = uniqueKey(label);
    setFields((prev) => [...prev, { key, label, type: 'text', source: 'MANUAL', excel_cell: { sheet_index: sheetIndex, cell: address } }]);
  };

  // HWPX 에서 감지된 {{자리표시자}} 를 클릭하면 바로 필드로 등록/해제
  const mapPlaceholder = (placeholder: string) => {
    const idx = fields.findIndex((f) => f.key === placeholder);
    if (idx >= 0) {
      if (window.confirm(`"${fields[idx].label}" 필드 매핑을 해제할까요? ({{${placeholder}}})`)) removeField(idx);
      return;
    }
    const label = window.prompt(`{{${placeholder}}} 자리에는 어떤 값이 들어가나요? (화면에 보일 이름)`, placeholder);
    if (!label) return;
    setFields((prev) => [...prev, { key: placeholder, label, type: 'text', source: 'MANUAL' }]);
  };

  const uniqueKey = (label: string): string => {
    let key = label.trim();
    let n = 2;
    while (fields.some((f) => f.key === key)) { key = `${label.trim()}_${n}`; n += 1; }
    return key;
  };

  const runDetect = async () => {
    if (!selected) return;
    try { setDetected(await api(`/doc-templates/${selected.id}/detect-placeholders`)); }
    catch (e: any) { showMsg('err', e.message); }
  };

  const addTableBinding = () => {
    const key = prompt('표 키(placeholder 접두어, 예: items)');
    if (!key) return;
    setTableBindings((prev) => ({ ...prev, [key]: { rows_reserved: 10, columns: [] } }));
  };
  const updateTableBinding = (key: string, patch: Partial<TableBinding>) => {
    setTableBindings((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };
  const removeTableBinding = (key: string) => {
    setTableBindings((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };

  const addRule = async () => {
    if (!selected) return;
    if (!ruleForm.field || !ruleForm.action_type) { showMsg('err', '조건 필드와 액션 종류를 입력해주세요.'); return; }
    const condition = { field: ruleForm.field, op: ruleForm.op, value: isNaN(Number(ruleForm.value)) ? ruleForm.value : Number(ruleForm.value) };
    const isFieldAction = ruleForm.action_type === 'SHOW_FIELD' || ruleForm.action_type === 'HIDE_FIELD';
    const action_payload = isFieldAction ? { field_key: ruleForm.target } : { section_key: ruleForm.target };
    try {
      await api(`/doc-templates/${selected.id}/rules`, {
        method: 'POST',
        body: JSON.stringify({ name: ruleForm.name, priority: ruleForm.priority, condition, action_type: ruleForm.action_type, action_payload }),
      });
      showMsg('ok', '규칙이 추가되었습니다.');
      setRuleForm({ name: '', priority: 0, field: '', op: 'eq', value: '', action_type: 'SHOW_SECTION', target: '' });
      const updated = await api(`/doc-templates/${selected.id}`);
      setSelected(updated);
      load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  const deleteRule = async (ruleId: string) => {
    if (!selected) return;
    try {
      await api(`/doc-templates/${selected.id}/rules/${ruleId}`, { method: 'DELETE' });
      const updated = await api(`/doc-templates/${selected.id}`);
      setSelected(updated);
      load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  const runPreview = async () => {
    if (!selected) return;
    try {
      let source: Record<string, unknown> = {};
      try { source = JSON.parse(testSourceJson || '{}'); } catch { /* ignore */ }
      const input: Record<string, unknown> = { ...testInput };
      for (const f of fields) {
        if (f.source === 'DB_BOUND' && f.bind_path) {
          input[f.key] = f.bind_path.split('.').reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), source);
        }
      }
      const res = await api(`/doc-templates/${selected.id}/preview`, { method: 'POST', body: JSON.stringify({ input }) });
      setPreviewResult(res.plan);
    } catch (e: any) { showMsg('err', e.message); }
  };

  const runGenerate = async () => {
    if (!selected) return;
    try {
      let source: Record<string, unknown> = {};
      try { source = JSON.parse(testSourceJson || '{}'); } catch { /* ignore */ }
      const res = await fetch(`/api/doc-templates/${selected.id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ input: testInput, source }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '문서 생성 중 오류가 발생했습니다.');
      }
      const blob = await res.blob();
      downloadBlob(blob, `${selected.name}.${selected.format === 'EXCEL' ? 'xlsx' : 'hwpx'}`);
      showMsg('ok', '문서가 생성되었습니다.');
    } catch (e: any) { showMsg('err', e.message); }
  };

  const columns: Column<DocTemplate>[] = [
    { key: 'name', header: '이름', cardPosition: 'title', render: (t) => <span className="font-medium">{t.name}</span> },
    { key: 'doc_type', header: '문서종류 키', cardPosition: 'subtitle', render: (t) => <span className="font-mono text-xs text-slate-500">{t.doc_type}</span> },
    { key: 'format', header: '형식', cardPosition: 'badge', render: (t) => <span className={t.format === 'EXCEL' ? 'badge-green' : 'badge-blue'}>{t.format}</span> },
    { key: 'status', header: '상태', cardPosition: 'badge', render: (t) => <span className={t.is_active ? 'badge-green' : 'badge-gray'}>{t.is_active ? '활성' : '비활성'}</span> },
    {
      key: 'actions', header: '', cardPosition: 'hidden', render: (t) => (
        <div className="flex gap-3">
          <button onClick={(e) => { e.stopPropagation(); openDetail(t); }} className="text-xs text-accent-600 hover:underline">필드/규칙 설정</button>
          <button onClick={(e) => { e.stopPropagation(); deleteTemplate(t); }} className="text-xs text-red-500 hover:underline inline-flex items-center gap-0.5"><Trash2 className="w-3 h-3" />삭제</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={FileText}
        title="문서양식(자동화)"
        description="회사양식(엑셀/HWPX)을 등록하고 필드·조건을 관리합니다. 새 양식은 코드 수정 없이 여기서 등록·수정합니다."
        actions={<button onClick={openCreate} className="btn-primary"><Plus className="w-4 h-4 inline mr-1" />양식 등록</button>}
      />

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {loading ? (
        <div className="card p-0"><EmptyState message="로딩 중..." /></div>
      ) : (
        <DataTable columns={columns} data={templates} keyField="id" emptyMessage="등록된 양식이 없습니다." onRowClick={openDetail} />
      )}

      {/* 양식 등록 */}
      <Modal
        open={createModal}
        onClose={() => setCreateModal(false)}
        title="양식 등록"
        footer={<>
          <button onClick={() => setCreateModal(false)} className="btn-secondary">취소</button>
          <button onClick={createTemplate} disabled={submitting} className="btn-primary">{submitting ? '등록 중...' : '등록'}</button>
        </>}
      >
        <div className="space-y-4">
          <FormField label="이름" required>
            <input className="input" value={createForm.name} onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))} placeholder="예: 기안서 기본양식" />
          </FormField>
          <FormField label="문서종류 키" required>
            <input className="input" value={createForm.doc_type} onChange={(e) => setCreateForm((f) => ({ ...f, doc_type: e.target.value }))} placeholder="예: GIAN, PURCHASE_DECISION, LEAVE_REQUEST" />
          </FormField>
          <FormField label="설명">
            <textarea className="input" value={createForm.description} onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))} />
          </FormField>
          <FormField label="양식 파일 (.xlsx 또는 .hwpx)" required>
            <input type="file" accept=".xlsx,.hwpx" onChange={(e) => setCreateFile(e.target.files?.[0] ?? null)} />
          </FormField>
        </div>
      </Modal>

      {/* 상세 설정 */}
      <Modal open={!!selected} onClose={closeDetail} title={selected ? `${selected.name} — 필드/규칙 설정` : ''} size="full">
        {selected && (
          <div className="space-y-6">
            {/* 엑셀 그리드 미리보기 — 칸을 클릭해서 필드로 등록/해제 */}
            {selected.format === 'EXCEL' && grid && (
              <div>
                <h3 className="font-semibold text-sm mb-1">시트 미리보기</h3>
                <p className="text-xs text-slate-500 mb-2">값이 들어갈 칸을 클릭하면 바로 필드로 등록됩니다. 초록색 칸은 이미 등록된 칸이에요 — 다시 클릭하면 해제됩니다.</p>
                {grid.sheets.map((sheet: any, sIdx: number) => (
                  <div key={sIdx} className="mb-3 overflow-auto border rounded max-h-64">
                    <div className="text-xs text-slate-500 px-2 py-1 bg-slate-50">시트 {sIdx}: {sheet.name}</div>
                    <table className="text-xs border-collapse">
                      <tbody>
                        {sheet.rows.map((row: any[], rIdx: number) => (
                          <tr key={rIdx}>
                            {row.map((cell: any, cIdx: number) => {
                              if (cell.isMergedAway) return null;
                              const mappedField = fields.find((f) => f.excel_cell?.sheet_index === sIdx && f.excel_cell?.cell === cell.address);
                              return (
                                <td
                                  key={cIdx}
                                  rowSpan={cell.rowSpan}
                                  colSpan={cell.colSpan}
                                  onClick={() => mapExcelCell(sIdx, cell.address, cell.value)}
                                  className={`border px-1 py-0.5 whitespace-nowrap cursor-pointer hover:bg-accent-50 ${mappedField ? 'bg-green-100' : ''}`}
                                  title={mappedField ? `등록됨: ${mappedField.label} (클릭해서 해제)` : `클릭해서 "${cell.address}" 칸을 필드로 등록`}
                                >
                                  {mappedField && <span className="text-[10px] text-green-700 font-semibold block">{mappedField.label}</span>}
                                  <span className="text-[10px] text-slate-400 mr-1">{cell.address}</span>{cell.value}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            {/* HWPX 자리표시자 탐지 — 클릭해서 필드로 등록/해제 */}
            {selected.format === 'HWPX' && (
              <div>
                <button onClick={runDetect} className="btn-secondary text-sm"><Wand2 className="w-4 h-4 inline mr-1" />자리표시자/섹션 자동 탐지</button>
                {detected && (
                  <div className="mt-3 text-sm space-y-2">
                    <p className="text-xs text-slate-500">양식 안에 심어둔 {'{{자리표시자}}'}를 찾았습니다. 클릭하면 필드로 등록됩니다.</p>
                    <div className="flex flex-wrap gap-1">
                      {detected.placeholders.length === 0 && <span className="text-xs text-slate-400">감지된 자리표시자가 없습니다.</span>}
                      {detected.placeholders.map((ph) => {
                        const mapped = fields.some((f) => f.key === ph);
                        return (
                          <button
                            key={ph}
                            onClick={() => mapPlaceholder(ph)}
                            className={`text-xs px-2 py-1 rounded-full border ${mapped ? 'bg-green-100 border-green-400 text-green-700' : 'border-dashed border-slate-300 text-slate-600 hover:bg-accent-50'}`}
                          >
                            {mapped ? `${fields.find((f) => f.key === ph)?.label} ✓` : `{{${ph}}}`}
                          </button>
                        );
                      })}
                    </div>
                    <div><span className="text-slate-500 text-xs">감지된 섹션:</span> {detected.sections.length ? detected.sections.join(', ') : '없음'}</div>
                  </div>
                )}
              </div>
            )}

            {/* 필드 스키마 — 위에서 클릭으로 등록한 필드 목록. 고급 설정(DB연동/자동채번)은 여기서 바꿀 수 있음 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">등록된 필드 목록</h3>
                <button onClick={addField} className="text-xs text-accent-600 hover:underline"><Plus className="w-3 h-3 inline" />칸과 상관없는 필드 직접 추가(고급)</button>
              </div>
              {fields.length === 0 && (
                <p className="text-xs text-slate-400">
                  {selected.format === 'EXCEL' ? '위 미리보기에서 칸을 클릭하면 여기에 나타납니다.' : '위에서 감지된 자리표시자를 클릭하면 여기에 나타납니다.'}
                </p>
              )}
              <div className="space-y-2">
                {fields.map((f, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2 p-2 border rounded text-sm">
                    <span className="font-medium w-28 truncate" title={f.label}>{f.label || '(이름없음)'}</span>
                    {selected.format === 'EXCEL' && f.excel_cell && (
                      <span className="text-xs text-slate-400 font-mono">시트{f.excel_cell.sheet_index} · {f.excel_cell.cell}</span>
                    )}
                    {selected.format === 'HWPX' && <span className="text-xs text-slate-400 font-mono">{'{{' + f.key + '}}'}</span>}
                    <select className="input w-24" value={f.type} onChange={(e) => updateField(idx, { type: e.target.value })}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select className="input w-28" value={f.source} onChange={(e) => updateField(idx, { source: e.target.value as FieldDef['source'] })}>
                      <option value="MANUAL">직접입력</option>
                      <option value="DB_BOUND">DB연동</option>
                      <option value="AUTO_SEQ">자동채번</option>
                    </select>
                    {f.source === 'DB_BOUND' && (
                      <input className="input w-32" placeholder="bind_path (예: vendor.name)" value={f.bind_path ?? ''} onChange={(e) => updateField(idx, { bind_path: e.target.value })} />
                    )}
                    {f.source === 'AUTO_SEQ' && (
                      <>
                        <input className="input w-32" placeholder="scope (예: GIAN-{yyyy})" value={f.auto_seq?.scope_key_template ?? ''} onChange={(e) => updateField(idx, { auto_seq: { scope_key_template: e.target.value, number_template: f.auto_seq?.number_template ?? '', pad: f.auto_seq?.pad ?? 3 } })} />
                        <input className="input w-32" placeholder="번호형식 (예: 호남-{yy}-{seq})" value={f.auto_seq?.number_template ?? ''} onChange={(e) => updateField(idx, { auto_seq: { scope_key_template: f.auto_seq?.scope_key_template ?? '', number_template: e.target.value, pad: f.auto_seq?.pad ?? 3 } })} />
                      </>
                    )}
                    {selected.format === 'EXCEL' && !f.excel_cell && (
                      <input
                        className="input w-32"
                        placeholder="시트#,셀주소 (예: 0,B5)"
                        onBlur={(e) => {
                          const [sheetStr, cell] = e.target.value.split(',').map((s) => s.trim());
                          if (cell) updateField(idx, { excel_cell: { sheet_index: Number(sheetStr) || 0, cell } });
                        }}
                      />
                    )}
                    {selected.format === 'HWPX' && (
                      <input className="input w-28" placeholder="키({{}}안의 이름)" value={f.key} onChange={(e) => updateField(idx, { key: e.target.value })} />
                    )}
                    <button onClick={() => removeField(idx)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            </div>

            {/* 섹션 */}
            <div className="grid grid-cols-2 gap-4">
              <FormField label="섹션 키 목록 (콤마 구분)">
                <input className="input" value={sectionKeys} onChange={(e) => setSectionKeys(e.target.value)} placeholder="계약조항, 견적조항, 승인란" />
              </FormField>
              <FormField label="기본 노출 섹션 (콤마 구분)">
                <input className="input" value={defaultVisibleSections} onChange={(e) => setDefaultVisibleSections(e.target.value)} placeholder="규칙이 없을 때 기본으로 보이는 섹션" />
              </FormField>
            </div>

            {/* 표 바인딩 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">반복 표(품목 등)</h3>
                <button onClick={addTableBinding} className="text-xs text-accent-600 hover:underline"><Plus className="w-3 h-3 inline" />표 추가</button>
              </div>
              {Object.entries(tableBindings).map(([key, b]) => (
                <div key={key} className="flex flex-wrap items-center gap-2 p-2 border rounded text-sm mb-2">
                  <span className="font-mono text-xs">{key}</span>
                  <input className="input w-20" type="number" placeholder="최대행수" value={b.rows_reserved} onChange={(e) => updateTableBinding(key, { rows_reserved: Number(e.target.value) })} />
                  <input className="input w-48" placeholder="컬럼키 콤마구분 (예: name,qty,unit_price)" value={b.columns.join(',')} onChange={(e) => updateTableBinding(key, { columns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                  {selected.format === 'EXCEL' && (
                    <>
                      <input className="input w-16" type="number" placeholder="시트#" value={b.sheet_index ?? ''} onChange={(e) => updateTableBinding(key, { sheet_index: Number(e.target.value) })} />
                      <input className="input w-20" type="number" placeholder="시작행" value={b.start_row ?? ''} onChange={(e) => updateTableBinding(key, { start_row: Number(e.target.value) })} />
                    </>
                  )}
                  <button onClick={() => removeTableBinding(key)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>

            <button onClick={saveFieldsAndSections} className="btn-primary">필드/섹션/표 설정 저장</button>

            {/* 규칙 */}
            <div>
              <h3 className="font-semibold text-sm mb-2">조건(규칙)</h3>
              <div className="space-y-1 mb-3">
                {(selected.rules ?? []).map((r) => (
                  <div key={r.id} className="flex items-center justify-between text-xs p-2 border rounded">
                    <span>{r.name || '(이름없음)'} — IF {r.condition_json} THEN {r.action_type} {r.action_payload_json}</span>
                    <button onClick={() => deleteRule(r.id)} className="text-red-500 hover:text-red-700"><Trash2 className="w-3 h-3" /></button>
                  </div>
                ))}
                {(selected.rules ?? []).length === 0 && <div className="text-xs text-slate-400">등록된 규칙이 없습니다.</div>}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <input className="input w-24" placeholder="규칙 이름" value={ruleForm.name} onChange={(e) => setRuleForm((f) => ({ ...f, name: e.target.value }))} />
                <span>IF</span>
                <input className="input w-24" placeholder="필드키" value={ruleForm.field} onChange={(e) => setRuleForm((f) => ({ ...f, field: e.target.value }))} />
                <select className="input w-20" value={ruleForm.op} onChange={(e) => setRuleForm((f) => ({ ...f, op: e.target.value }))}>
                  {['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'isTrue', 'isFalse'].map((op) => <option key={op} value={op}>{op}</option>)}
                </select>
                <input className="input w-24" placeholder="값" value={ruleForm.value} onChange={(e) => setRuleForm((f) => ({ ...f, value: e.target.value }))} />
                <span>THEN</span>
                <select className="input w-28" value={ruleForm.action_type} onChange={(e) => setRuleForm((f) => ({ ...f, action_type: e.target.value }))}>
                  {ACTION_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <input className="input w-24" placeholder="대상 키" value={ruleForm.target} onChange={(e) => setRuleForm((f) => ({ ...f, target: e.target.value }))} />
                <button onClick={addRule} className="btn-secondary text-xs">규칙 추가</button>
              </div>
            </div>

            {/* 생성 테스트 */}
            <div className="border-t pt-4">
              <h3 className="font-semibold text-sm mb-2">문서 생성 테스트</h3>
              <FormField label="source (JSON, DB연동 필드 테스트용)">
                <textarea className="input font-mono text-xs" rows={3} value={testSourceJson} onChange={(e) => setTestSourceJson(e.target.value)} />
              </FormField>
              <div className="grid grid-cols-2 gap-2 my-2">
                {fields.filter((f) => f.source === 'MANUAL').map((f) => (
                  <FormField key={f.key} label={f.label || f.key}>
                    <input className="input" value={testInput[f.key] ?? ''} onChange={(e) => setTestInput((v) => ({ ...v, [f.key]: e.target.value }))} />
                  </FormField>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={runPreview} className="btn-secondary text-sm">미리보기(규칙 계산)</button>
                <button onClick={runGenerate} className="btn-primary text-sm">문서 생성</button>
              </div>
              {previewResult && (
                <div className="mt-2 text-xs space-y-1 bg-slate-50 p-2 rounded">
                  <div>보이는 섹션: {previewResult.visible_sections.join(', ') || '없음'}</div>
                  <div>숨김 섹션: {previewResult.hidden_sections.join(', ') || '없음'}</div>
                  {previewResult.warnings.length > 0 && <div className="text-red-600">경고: {previewResult.warnings.join(' / ')}</div>}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
