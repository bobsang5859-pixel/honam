import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Settings } from 'lucide-react';
import { api, downloadBlob } from '../utils/api';
import { PageHeader } from '../components/ui';
import type { Department } from '@shared/types';
import UsersPage from './UsersPage';

// ── 인터페이스 ──────────────────────────────────────────────────────────
interface AppSetting {
  key: string;
  value: string;
  description: string;
}

interface BackupRecord {
  id: string;
  file_path: string;
  note: string;
  created_at: string;
}


interface DeptRow {
  dept: Department;
  parentName: string;
  isChild: boolean;
}

interface SettingItem {
  key: string;
  label: string;
  type: 'text' | 'number' | 'toggle' | 'time' | 'select';
  unit?: string;
  options?: { value: string; label: string }[];
  description?: string;
}

interface SettingSection {
  title: string;
  description?: string;
  items: SettingItem[];
}

// ── 상수 ───────────────────────────────────────────────────────────────
const SCHEDULE_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품',
  CONSUMABLE_REGULAR: '일반소모품',
  CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간간식',
};
const SCHEDULE_TYPES = Object.keys(SCHEDULE_TYPE_LABEL);

// MODULE_META 제거됨 — 모듈관리 탭 삭제

const BASIC_SECTIONS: SettingSection[] = [
  {
    title: '병원/시스템 정보',
    items: [
      { key: 'HOSPITAL_NAME', label: '병원명', type: 'text', description: '로그인 화면 및 각 페이지에 표시됩니다.' },
      { key: 'APP_NAME', label: '시스템명', type: 'text', description: '로그인 화면 서브타이틀에 표시됩니다.' },
      {
        key: 'FISCAL_YEAR_START', label: '회계연도 시작월', type: 'select',
        description: '회계연도가 시작되는 월을 선택합니다.',
        options: [
          { value: '01', label: '1월 (1월~12월)' },
          { value: '04', label: '4월 (4월~3월)' },
          { value: '07', label: '7월 (7월~6월)' },
          { value: '10', label: '10월 (10월~9월)' },
        ],
      },
    ],
  },
  {
    title: '재고/구매 기준값',
    description: '구매 및 재고 관련 임계값을 설정합니다.',
    items: [
      { key: 'REORDER_DAYS', label: '재발주 기준 일수', type: 'number', unit: '일', description: '재고 소진까지 N일 이하이면 재발주 경고를 표시합니다.' },
      { key: 'INCINERATION_UNIT_PRICE', label: '소각 단가', type: 'number', unit: '원/kg', description: '폐기물 소각 비용 산출 기준입니다.' },
      { key: 'DEFAULT_ROOM_CAPACITY', label: '기본 병상 수', type: 'number', unit: '병상', description: '통계 계산에 사용되는 기본 병실 병상 수입니다.' },
      { key: 'OVER_PCT_THRESHOLD', label: '과잉발주 경고 기준', type: 'number', unit: '%', description: '기준 대비 N% 초과 발주 시 경고를 표시합니다.' },
      { key: 'PRICE_UP_THRESHOLD', label: '단가상승 경고 기준', type: 'number', unit: '%', description: '기준 단가 대비 N% 이상 상승 시 경고를 표시합니다.' },
    ],
  },
  {
    title: '자동백업',
    items: [
      { key: 'AUTO_BACKUP', label: '자동백업 사용', type: 'toggle', description: '매일 설정한 시간에 자동으로 DB를 백업합니다.' },
      { key: 'BACKUP_TIME', label: '자동백업 시간', type: 'time', description: '자동백업이 실행되는 시간입니다.' },
    ],
  },
];

const SECURITY_SECTIONS: SettingSection[] = [
  {
    title: '세션 보안',
    description: '변경 후 다음 로그인 세션부터 적용됩니다.',
    items: [
      { key: 'SESSION_TIMEOUT_MIN', label: '자동 로그아웃', type: 'number', unit: '분', description: '비활동 상태가 N분 지속되면 자동으로 로그아웃됩니다.' },
      { key: 'SESSION_WARN_BEFORE_MIN', label: '경고 표시 (만료 전)', type: 'number', unit: '분', description: '자동 로그아웃 N분 전에 경고 팝업을 표시합니다.' },
    ],
  },
  {
    title: '비밀번호 정책',
    description: '신규 비밀번호 설정 시부터 적용됩니다.',
    items: [
      { key: 'PASSWORD_MIN_LENGTH', label: '비밀번호 최소 길이', type: 'number', unit: '자', description: '사용자 비밀번호의 최소 문자 수입니다.' },
      { key: 'MAX_LOGIN_ATTEMPTS', label: '최대 로그인 시도', type: 'number', unit: '회', description: 'N회 연속 실패 시 계정이 잠깁니다. (0 = 제한 없음)' },
    ],
  },
];

type TabKey = 'basic' | 'organization' | 'users' | 'security' | 'backup' | 'integration' | 'test-data';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'basic',        label: '기본정보'  },
  { key: 'organization', label: '조직관리'  },
  { key: 'users',        label: '사용자관리' },
  { key: 'security',     label: '보안설정'  },
  { key: 'backup',       label: '백업/복구' },
  { key: 'integration', label: '외부연동' },
  { key: 'test-data',   label: '테스트 데이터' },
];

// ── 부서 헬퍼 ──────────────────────────────────────────────────────────
function sortByKoName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, 'ko');
}

function buildGroupedRows(departments: Department[]): DeptRow[] {
  const byId = new Map(departments.map((d) => [d.id, d]));
  const parents = departments.filter((d) => !d.parent_id).sort(sortByKoName);
  const children = departments.filter((d) => !!d.parent_id).sort(sortByKoName);
  const rows: DeptRow[] = [];
  const seen = new Set<string>();

  for (const parent of parents) {
    rows.push({ dept: parent, parentName: '-', isChild: false });
    seen.add(parent.id);
    for (const child of children) {
      if (child.parent_id !== parent.id) continue;
      rows.push({ dept: child, parentName: parent.name, isChild: true });
      seen.add(child.id);
    }
  }
  for (const child of children) {
    if (seen.has(child.id)) continue;
    rows.push({ dept: child, parentName: byId.get(child.parent_id || '')?.name || '(상위 부서 없음)', isChild: true });
  }
  return rows;
}

// ── 테스트 데이터 탭 컴포넌트 ─────────────────────────────────────────
// 5단계 워크플로우(신청→승인→발주→입고→불출) 체험용. is_test=true 데이터는
// 통계 합산에서 자동 제외되고, 삭제 시 inventory까지 원복됨.
function TestDataTab() {
  const [status, setStatus] = useState<{ ward_requests: number; purchase_orders: number; goods_receipts: number; stock_outs: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'seed' | 'delete' | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/test-data/status');
      setStatus(data as any);
    } catch (e: any) {
      showMsg('err', e.message || '현황 조회 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSeed = async () => {
    setBusy('seed');
    try {
      const r = await api('/test-data/seed', { method: 'POST' }) as any;
      showMsg('ok', r.message || '시드 완료');
      await loadStatus();
    } catch (e: any) {
      showMsg('err', e.message || '시드 실패');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!confirm('테스트 데이터 전체를 삭제합니다. (재고는 시작 전 상태로 원복됩니다) 계속할까요?')) return;
    setBusy('delete');
    try {
      const r = await api('/test-data', { method: 'DELETE' }) as any;
      showMsg('ok', r.message || '삭제 완료');
      await loadStatus();
    } catch (e: any) {
      showMsg('err', e.message || '삭제 실패');
    } finally {
      setBusy(null);
    }
  };

  const total = status ? (status.ward_requests + status.purchase_orders + status.goods_receipts + status.stock_outs) : 0;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="text-base font-bold text-slate-700 mb-2">테스트 데이터 시드</h3>
        <p className="text-sm text-slate-500 mb-4">
          5단계 워크플로우(신청 → 승인 → 발주 → 입고 → 불출)를 직접 클릭하며 체험할 수 있도록
          정기 소모품 신청 데이터를 미리 박아둡니다. 시드된 신청은 <strong className="text-amber-600">통계에서 자동 제외</strong>되고,
          아래 "전체 삭제" 버튼으로 한 번에 정리됩니다 (재고도 원복).
        </p>
        <div className="flex gap-2">
          <button onClick={handleSeed} disabled={busy !== null} className="btn-primary">
            {busy === 'seed' ? '시드 중...' : '+ 테스트 신청 시드'}
          </button>
          <button onClick={handleDelete} disabled={busy !== null || total === 0} className="px-4 py-2 rounded-lg text-sm font-medium bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-40">
            {busy === 'delete' ? '삭제 중...' : '× 전체 삭제'}
          </button>
          <button onClick={loadStatus} disabled={loading} className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-600 hover:bg-slate-200">
            새로고침
          </button>
        </div>
        {msg && (
          <div className={`mt-3 p-2 rounded text-xs ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {msg.text}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h3 className="text-base font-bold text-slate-700 mb-3">현재 테스트 데이터 현황</h3>
        {loading ? (
          <div className="text-sm text-slate-400 py-4">불러오는 중...</div>
        ) : status ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: '신청', value: status.ward_requests, key: 'wr' },
              { label: '발주', value: status.purchase_orders, key: 'po' },
              { label: '입고', value: status.goods_receipts, key: 'gr' },
              { label: '불출', value: status.stock_outs, key: 'so' },
            ].map(s => (
              <div key={s.key} className={`border rounded-lg p-3 ${s.value > 0 ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'}`}>
                <div className="text-xs text-slate-500">{s.label}</div>
                <div className={`text-2xl font-bold ${s.value > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{s.value}건</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="card p-5">
        <h3 className="text-base font-bold text-slate-700 mb-3">5단계 워크플로우 체험 가이드</h3>
        <ol className="space-y-2 text-sm text-slate-600 list-decimal list-inside">
          <li><strong>신청</strong>: 위에서 시드 버튼 → "물품관리 → 물품신청" 메뉴에서 TEST 배지 신청 확인</li>
          <li><strong>승인</strong>: "물품관리 → 신청승인" 메뉴 → TEST 신청 검토 후 승인 (수량 조정 가능)</li>
          <li><strong>발주</strong>: "물품관리 → 발주관리" 메뉴 → 거래처 선택, 품목·수량 확정 후 발주서 생성. 발주 시 'is_test: true' 자동 인식하려면 ApprovalPage에서 TEST 신청 기반으로 발주 생성하거나 발주 폼에서 is_test 체크</li>
          <li><strong>입고</strong>: "물품관리 → 입고관리" 메뉴 → 발주 선택, 도착 수량 입력 → 자동으로 재고(on_hand_qty) 증가. TEST 발주 → TEST 입고로 자동 전파</li>
          <li><strong>불출</strong>: "물품관리 → 불출관리" 메뉴 → 신청 부서로 출고. TEST 신청 기반이면 TEST 불출로 전파, 재고 차감</li>
          <li>모두 끝나면 위 "전체 삭제" 버튼으로 정리. 재고는 시드 시작 전 값으로 자동 원복.</li>
        </ol>
      </div>
    </div>
  );
}

// ── 외부연동 탭 컴포넌트 ──────────────────────────────────────────────
function IntegrationTab() {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [saved, setSaved] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    api('/system/settings').then((rows: any[]) => {
      const row = rows.find((r: any) => r.key === 'N8N_WEBHOOK_URL');
      if (row) { setWebhookUrl(row.value); setSaved(row.value); }
    }).catch(() => {});
  }, []);

  const saveUrl = async () => {
    try {
      await api('/system/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: 'N8N_WEBHOOK_URL', value: webhookUrl.trim() }),
      });
      setSaved(webhookUrl.trim());
      setTestResult({ ok: true, msg: '저장 완료' });
    } catch {
      setTestResult({ ok: false, msg: '저장 실패' });
    }
  };

  const testWebhook = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api('/system/webhook-test', { method: 'POST' });
      setTestResult({ ok: true, msg: (res as any).message || '테스트 전송 성공' });
    } catch {
      setTestResult({ ok: false, msg: '테스트 실패 — URL을 확인해주세요' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="section-title">n8n Webhook 연동</h3>
        <p className="text-xs text-slate-400 mb-4">
          n8n 자동화 서버의 Webhook URL을 설정하면 주요 이벤트(재고 부족, 신청 접수, 승인, 발주, 입고) 발생 시 자동 알림이 전송됩니다.
          <br />URL이 비어있으면 알림이 전송되지 않습니다.
        </p>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="label">Webhook URL</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="input"
              placeholder="https://n8n.example.com/webhook/..."
            />
          </div>
          <button
            onClick={saveUrl}
            disabled={webhookUrl.trim() === saved}
            className="btn-primary disabled:opacity-50"
          >
            저장
          </button>
          <button
            onClick={testWebhook}
            disabled={testing || !saved}
            className="btn-navy disabled:opacity-50"
          >
            {testing ? '전송 중...' : '테스트'}
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 p-2 rounded text-sm ${testResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {testResult.msg}
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="section-title">이벤트 목록</h3>
        <p className="text-xs text-slate-400 mb-3">Webhook URL 설정 시 다음 이벤트가 자동 전송됩니다.</p>
        <table className="tbl">
          <thead>
            <tr><th>이벤트</th><th>설명</th><th>발생 시점</th></tr>
          </thead>
          <tbody>
            <tr><td className="font-mono text-xs">FORECAST_ALERT</td><td>재고 소진 임박</td><td>수요예측에서 긴급 발주 필요 감지</td></tr>
            <tr><td className="font-mono text-xs">LOW_STOCK</td><td>안전재고 이하</td><td>재고가 안전재고 기준 이하</td></tr>
            <tr><td className="font-mono text-xs">REQUEST_CREATED</td><td>신청 접수</td><td>병동 물품 신청 제출</td></tr>
            <tr><td className="font-mono text-xs">REQUEST_APPROVED</td><td>승인 완료</td><td>신청 승인 처리</td></tr>
            <tr><td className="font-mono text-xs">PO_CREATED</td><td>발주 생성</td><td>구매 발주 생성</td></tr>
            <tr><td className="font-mono text-xs">RECEIPT_COMPLETED</td><td>입고 완료</td><td>입고 확정 처리</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────
export default function SystemPage() {
  const [tab, setTab] = useState<TabKey>('basic');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // 설정
  const [settings, setSettings] = useState<AppSetting[]>([]);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // 백업
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [backupNote, setBackupNote] = useState('');

  // 조직관리 (부서)
  const [departments, setDepartments] = useState<Department[]>([]);
  const [deptLoading, setDeptLoading] = useState(false);
  const [deptModal, setDeptModal] = useState<'create' | 'edit' | null>(null);
  const [editingDept, setEditingDept] = useState<Department | null>(null);
  const [deptForm, setDeptForm] = useState({ name: '', parent_id: '' });
  const [deptSubmitting, setDeptSubmitting] = useState(false);

  // ── 헬퍼 ────────────────────────────────────────────────────────────
  const sv = (key: string, fallback = '') => settings.find((s) => s.key === key)?.value ?? fallback;

  const showMessage = (type: 'ok' | 'err', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3500);
  };

  // ── 데이터 로딩 ──────────────────────────────────────────────────────
  const loadBase = async () => {
    setLoading(true);
    try {
      const [settingsRows, backupRows] = await Promise.all([
        api('/system/settings').catch(() => []),
        api('/system/backups').catch(() => []),
      ]);
      setSettings(Array.isArray(settingsRows) ? settingsRows : []);
      setBackups(Array.isArray(backupRows) ? backupRows : []);
    } finally {
      setLoading(false);
    }
  };

  const loadDepartments = useCallback(async () => {
    setDeptLoading(true);
    try {
      const rows = await api('/departments');
      setDepartments(Array.isArray(rows) ? rows : []);
    } catch {
      // ignore
    } finally {
      setDeptLoading(false);
    }
  }, []);

  useEffect(() => { loadBase(); }, []);

  useEffect(() => {
    if (tab === 'organization') loadDepartments();
  }, [tab]);

  // ── 설정 저장 ────────────────────────────────────────────────────────
  const saveSetting = async (key: string, value?: string) => {
    const val = value !== undefined ? value : editValue;
    setSubmitting(true);
    try {
      await api('/system/settings', { method: 'PUT', body: JSON.stringify({ key, value: val }) });
      setSettings((prev) => {
        const exists = prev.find((s) => s.key === key);
        if (exists) return prev.map((s) => (s.key === key ? { ...s, value: val } : s));
        return [...prev, { key, value: val, description: '' }];
      });
      setEditKey(null);
      showMessage('ok', '설정을 저장했습니다.');
    } catch (e: any) {
      showMessage('err', e.message || '설정 저장에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleSetting = async (key: string) => {
    const current = sv(key, 'true');
    await saveSetting(key, current === 'false' ? 'true' : 'false');
  };

  // ── 백업 ─────────────────────────────────────────────────────────────
  const createBackup = async () => {
    setSubmitting(true);
    try {
      const created = await api('/system/backup', {
        method: 'POST',
        body: JSON.stringify({ note: backupNote || '수동 백업' }),
      });
      setBackups((prev) => [created, ...prev]);
      setBackupNote('');
      showMessage('ok', '백업을 생성했습니다.');
    } catch (e: any) {
      showMessage('err', e.message || '백업 생성에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const downloadBackup = async (id: string, filename: string) => {
    try {
      const blob = await api(`/system/backups/${id}/download`);
      downloadBlob(blob, filename);
    } catch (e: any) {
      showMessage('err', e.message || '백업 다운로드에 실패했습니다.');
    }
  };

  // ── 부서 관리 ────────────────────────────────────────────────────────
  const deptRows = useMemo(() => buildGroupedRows(departments), [departments]);
  const deptParentOptions = useMemo(() => {
    const topLevels = departments.filter((d) => !d.parent_id).sort(sortByKoName);
    if (!editingDept) return topLevels;
    return topLevels.filter((d) => d.id !== editingDept.id);
  }, [departments, editingDept]);

  const openCreateDept = () => { setDeptForm({ name: '', parent_id: '' }); setEditingDept(null); setDeptModal('create'); };
  const openEditDept = (d: Department) => { setDeptForm({ name: d.name, parent_id: d.parent_id || '' }); setEditingDept(d); setDeptModal('edit'); };

  const saveDept = async () => {
    if (!deptForm.name.trim()) { showMessage('err', '부서명을 입력해주세요.'); return; }
    setDeptSubmitting(true);
    try {
      const payload = { name: deptForm.name.trim(), parent_id: deptForm.parent_id || null };
      if (editingDept) {
        await api(`/departments/${editingDept.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showMessage('ok', '수정되었습니다.');
      } else {
        await api('/departments', { method: 'POST', body: JSON.stringify(payload) });
        showMessage('ok', '등록되었습니다.');
      }
      setDeptModal(null);
      loadDepartments();
    } catch (e: any) {
      showMessage('err', e.message);
    } finally {
      setDeptSubmitting(false);
    }
  };

  const toggleDeptActive = async (id: string, current: boolean) => {
    try {
      await api(`/departments/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: !current }) });
      loadDepartments();
    } catch (e: any) {
      showMessage('err', e.message);
    }
  };

  const removeDept = async (d: Department) => {
    if (!confirm(`'${d.name}' 부서를 삭제할까요?`)) return;
    try {
      await api(`/departments/${d.id}`, { method: 'DELETE' });
      showMessage('ok', '삭제되었습니다.');
      loadDepartments();
    } catch (e: any) {
      showMessage('err', e.message);
    }
  };

  // ── 설정 항목 렌더러 ──────────────────────────────────────────────────
  const renderSettingRow = (item: SettingItem) => {
    const value = sv(item.key, item.type === 'toggle' ? 'true' : '');
    const isEditing = editKey === item.key;

    if (item.type === 'toggle') {
      const isOn = value !== 'false';
      return (
        <div key={item.key} className="flex items-center gap-4 py-3.5 border-b border-gray-100 last:border-0">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800">{item.label}</p>
            {item.description && <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>}
          </div>
          <button
            onClick={() => toggleSetting(item.key)}
            disabled={submitting}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isOn ? 'bg-accent-600' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <span className={`text-xs font-medium w-8 text-right ${isOn ? 'text-accent-600' : 'text-slate-400'}`}>{isOn ? 'ON' : 'OFF'}</span>
        </div>
      );
    }

    if (item.type === 'select') {
      if (isEditing) {
        return (
          <div key={item.key} className="flex items-center gap-4 py-3.5 border-b border-gray-100 last:border-0">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800">{item.label}</p>
              {item.description && <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>}
            </div>
            <div className="flex items-center gap-2">
              <select value={editValue} onChange={(e) => setEditValue(e.target.value)} className="input w-48">
                {item.options?.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
              <button onClick={() => saveSetting(item.key)} disabled={submitting} className="btn-primary text-xs" style={{ padding: '6px 12px' }}>저장</button>
              <button onClick={() => setEditKey(null)} className="btn-secondary text-xs" style={{ padding: '6px 12px' }}>취소</button>
            </div>
          </div>
        );
      }
      const displayLabel = item.options?.find((o) => o.value === value)?.label ?? value;
      return (
        <div key={item.key} className="flex items-center gap-4 py-3.5 border-b border-gray-100 last:border-0">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800">{item.label}</p>
            {item.description && <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-700 font-mono bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200">{displayLabel || '-'}</span>
            <button onClick={() => { setEditKey(item.key); setEditValue(value); }} className="text-xs text-accent-600 hover:underline">수정</button>
          </div>
        </div>
      );
    }

    // text, number, time
    if (isEditing) {
      return (
        <div key={item.key} className="flex items-center gap-4 py-3.5 border-b border-gray-100 last:border-0">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800">{item.label}</p>
            {item.description && <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>}
          </div>
          <div className="flex items-center gap-2">
            <input
              type={item.type === 'number' ? 'number' : item.type === 'time' ? 'time' : 'text'}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="input w-36"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveSetting(item.key);
                if (e.key === 'Escape') setEditKey(null);
              }}
            />
            {item.unit && <span className="text-xs text-slate-400">{item.unit}</span>}
            <button onClick={() => saveSetting(item.key)} disabled={submitting} className="btn-primary text-xs" style={{ padding: '6px 12px' }}>저장</button>
            <button onClick={() => setEditKey(null)} className="btn-secondary text-xs" style={{ padding: '6px 12px' }}>취소</button>
          </div>
        </div>
      );
    }

    return (
      <div key={item.key} className="flex items-center gap-4 py-3.5 border-b border-gray-100 last:border-0">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800">{item.label}</p>
          {item.description && <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-700 font-mono bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200">
            {value || '-'}{value && item.unit ? ` ${item.unit}` : ''}
          </span>
          <button onClick={() => { setEditKey(item.key); setEditValue(value); }} className="text-xs text-accent-600 hover:underline">수정</button>
        </div>
      </div>
    );
  };

  const renderSettingSections = (sections: SettingSection[]) => (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.title} className="card">
          <div className="mb-3">
            <h3 className="section-title mb-0">{section.title}</h3>
            {section.description && <p className="text-xs text-slate-400 mt-1">{section.description}</p>}
          </div>
          <div>{section.items.map((item) => renderSettingRow(item))}</div>
        </div>
      ))}
    </div>
  );

  // ── JSX ──────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        icon={Settings}
        title="시스템 설정"
        description="병원 기본정보 · 조직 · 모듈 · 권한 · 보안 · 백업을 통합 관리합니다."
      />

      {message && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${message.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {message.text}
        </div>
      )}

      {/* 탭 바 */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 flex-wrap">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === key ? 'bg-white shadow-sm text-navy-800' : 'text-slate-500 hover:text-slate-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── 기본정보 탭 ── */}
      {tab === 'basic' && (
        loading
          ? <div className="flex items-center justify-center py-16 text-slate-400 text-sm">불러오는 중...</div>
          : renderSettingSections(BASIC_SECTIONS)
      )}

      {/* ── 조직관리 탭 ── */}
      {tab === 'organization' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-slate-500">소속(그룹)과 소속별 부서를 함께 관리합니다.</p>
            <button onClick={openCreateDept} className="btn-primary">+ 부서 등록</button>
          </div>
          <div className="card p-0 overflow-hidden overflow-x-auto">
            {deptLoading ? (
              <div className="flex items-center justify-center py-16 text-slate-400 text-sm">로딩 중...</div>
            ) : deptRows.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-slate-400 text-sm">등록된 부서가 없습니다.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>부서명</th>
                    <th>소속(그룹)</th>
                    <th>상태</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {deptRows.map(({ dept, parentName, isChild }) => (
                    <tr key={dept.id} className={isChild ? '' : 'bg-slate-50/70'}>
                      <td className={`font-medium ${isChild ? 'pl-7' : ''}`}>
                        {isChild && <span className="text-slate-300 mr-2">└</span>}
                        {dept.name}
                      </td>
                      <td className="text-xs text-slate-500">{parentName}</td>
                      <td>
                        <span className={dept.is_active ? 'badge-green' : 'badge-gray'}>
                          {dept.is_active ? '활성' : '비활성'}
                        </span>
                      </td>
                      <td className="flex gap-2">
                        <button onClick={() => openEditDept(dept)} className="text-xs text-accent-600 hover:underline">수정</button>
                        <button onClick={() => toggleDeptActive(dept.id, dept.is_active)} className="text-xs text-slate-400 hover:text-slate-600">
                          {dept.is_active ? '비활성화' : '활성화'}
                        </button>
                        <button onClick={() => removeDept(dept)} className="text-xs text-red-500 hover:underline">삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── 사용자관리 탭 ── */}
      {tab === 'users' && <UsersPage embedded />}

      {/* ── 보안설정 탭 ── */}
      {tab === 'security' && (
        loading
          ? <div className="flex items-center justify-center py-16 text-slate-400 text-sm">불러오는 중...</div>
          : renderSettingSections(SECURITY_SECTIONS)
      )}

      {/* ── 백업/복구 탭 ── */}
      {tab === 'backup' && (
        <div className="space-y-4">
          <div className="card">
            <h3 className="section-title">수동 백업 생성</h3>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="label">백업 메모</label>
                <input type="text" value={backupNote} onChange={(e) => setBackupNote(e.target.value)} className="input" placeholder="예: 배포 전 백업" />
              </div>
              <button onClick={createBackup} disabled={submitting} className="btn-navy">
                {submitting ? '생성 중...' : '백업 생성'}
              </button>
            </div>
          </div>
          <div className="card p-0 overflow-hidden overflow-x-auto">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-navy-800">백업 목록</h3>
            </div>
            {backups.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">백업 파일이 없습니다.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr><th>생성일시</th><th>메모</th><th>파일명</th><th></th></tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.id}>
                      <td className="text-xs">{new Date(b.created_at).toLocaleString('ko-KR')}</td>
                      <td className="text-sm">{b.note}</td>
                      <td className="text-xs font-mono text-slate-400 truncate max-w-xs">{b.file_path.split(/[/\\]/).pop()}</td>
                      <td>
                        <button onClick={() => downloadBackup(b.id, b.file_path.split(/[/\\]/).pop() || 'backup.db')} className="text-xs text-accent-600 hover:underline">
                          다운로드
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── 외부연동 탭 ── */}
      {tab === 'integration' && <IntegrationTab />}

      {/* ── 테스트 데이터 탭 ── */}
      {tab === 'test-data' && <TestDataTab />}

      {/* ── 부서 모달 ── */}
      {deptModal && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setDeptModal(null); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">{deptModal === 'create' ? '부서 등록' : '부서 수정'}</h2>
              <button onClick={() => setDeptModal(null)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              <div>
                <label className="label">부서명 *</label>
                <input type="text" value={deptForm.name} onChange={(e) => setDeptForm((f) => ({ ...f, name: e.target.value }))} className="input" placeholder="예: 2병동" />
              </div>
              <div>
                <label className="label">상위 부서(소속)</label>
                <select value={deptForm.parent_id} onChange={(e) => setDeptForm((f) => ({ ...f, parent_id: e.target.value }))} className="input">
                  <option value="">최상위 부서</option>
                  {deptParentOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setDeptModal(null)} className="btn-secondary">취소</button>
              <button onClick={saveDept} disabled={deptSubmitting} className="btn-primary">{deptSubmitting ? '저장 중...' : '저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
