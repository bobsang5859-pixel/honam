import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui';
import type { DepartmentLoan, Item, InventoryItem } from '@shared/types';

const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n || 0);
const toNumber = (v: string | number) => {
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export default function LoansPage() {
  const { user } = useAuth();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [rows, setRows] = useState<DepartmentLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Modal
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ item_id: '', to_department_id: '', qty: '1', loaned_at: new Date().toISOString().slice(0, 10), note: '' });
  const [itemSearch, setItemSearch] = useState('');
  const [showDrop, setShowDrop] = useState(false);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const [invRows, itemRows, deptRows, loanRows] = await Promise.all([
        api('/inventory'),
        api('/items?is_active=true'),
        api('/departments'),
        api(`/loans${params.toString() ? `?${params}` : ''}`),
      ]);
      setInventory(Array.isArray(invRows) ? invRows : []);
      setItems(Array.isArray(itemRows) ? itemRows : []);
      setDepts(Array.isArray(deptRows) ? deptRows : []);
      setRows(Array.isArray(loanRows) ? loanRows : []);
    } catch (e: any) {
      showMsg('err', e.message || '조회에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]); // eslint-disable-line

  const filteredInventory = useMemo(() =>
    inventory.filter(i => !search || i.item_name.includes(search) || i.item_code.includes(search)),
    [inventory, search]
  );

  const filteredDropItems = useMemo(() => {
    if (!itemSearch) return items.slice(0, 30);
    const q = itemSearch.toLowerCase();
    return items.filter(i => i.name.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q)).slice(0, 30);
  }, [items, itemSearch]);

  const selectedStock = useMemo(() => {
    if (!form.item_id) return null;
    return inventory.filter(i => i.item_id === form.item_id).reduce((s, r) => s + Number(r.on_hand_qty || 0), 0);
  }, [form.item_id, inventory]);

  const sameDept = !!form.to_department_id && form.to_department_id === user?.department_id;

  const openModal = (inv?: InventoryItem) => {
    setForm({ item_id: inv?.item_id || '', to_department_id: '', qty: '1', loaned_at: new Date().toISOString().slice(0, 10), note: '' });
    setItemSearch(inv ? `${inv.item_name} (${inv.item_code})` : '');
    setShowDrop(false);
    setModal(true);
  };

  const selectItem = (item: Item) => {
    setForm(f => ({ ...f, item_id: item.id }));
    setItemSearch(`${item.name} (${item.item_code})`);
    setShowDrop(false);
  };

  const save = async () => {
    if (!form.item_id || !form.to_department_id) return showMsg('err', '품목과 빌린 부서를 선택하세요.');
    const qty = toNumber(form.qty);
    if (qty <= 0) return showMsg('err', '수량은 1 이상이어야 합니다.');
    if (sameDept) return showMsg('err', '자기 부서에 대여할 수 없습니다.');
    setSaving(true);
    try {
      await api('/loans', {
        method: 'POST',
        body: JSON.stringify({
          from_department_id: user?.department_id,
          to_department_id: form.to_department_id,
          item_id: form.item_id,
          qty,
          loaned_at: form.loaned_at,
          note: form.note,
        }),
      });
      setModal(false);
      showMsg('ok', '대여 등록이 완료되었습니다.');
      load();
    } catch (e: any) {
      showMsg('err', e.message || '등록에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const reverseLoan = async (id: string) => {
    if (!confirm('이 대여를 역전하시겠습니까?')) return;
    try {
      await api(`/loans/${id}/reverse`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '역전 처리되었습니다.');
      load();
    } catch (e: any) {
      showMsg('err', e.message || '역전에 실패했습니다.');
    }
  };

  return (
    <div>
      <PageHeader
        icon={ArrowLeftRight}
        title="부서간 대여"
        description="물품 부족 시 부서 간 대여를 즉시 기록합니다."
        actions={
          <div className="flex gap-2 items-center">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} className="input w-48" placeholder="품목명/코드 검색" />
            <button onClick={() => openModal()} className="btn-primary">+ 대여등록</button>
          </div>
        }
      />

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {/* 내 부서 재고 현황 */}
      <div className="card p-0 overflow-hidden overflow-x-auto mb-4">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <span className="font-medium text-sm">내 부서 재고 현황</span>
          <span className="text-xs text-slate-400">{filteredInventory.length}종</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-slate-400 text-sm">로딩 중...</div>
        ) : filteredInventory.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-slate-400 text-sm">재고 내역이 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>품목명</th><th>코드</th><th>위치</th><th className="text-right">재고</th><th>단위</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredInventory.map(inv => (
                <tr key={inv.id}>
                  <td className="font-medium text-sm">{inv.item_name}</td>
                  <td className="font-mono text-xs text-slate-500">{inv.item_code}</td>
                  <td className="text-xs text-slate-500">{inv.location_name}</td>
                  <td className={`text-right font-semibold ${Number(inv.on_hand_qty) <= 0 ? 'text-red-500' : inv.is_low_stock ? 'text-yellow-600' : 'text-slate-800'}`}>
                    {fmt(Number(inv.on_hand_qty))}
                  </td>
                  <td className="text-xs text-slate-500">{inv.uom}</td>
                  <td>
                    <button onClick={() => openModal(inv)} className="text-xs text-teal-600 hover:underline font-medium">
                      대여
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 대여 이력 */}
      <div className="card p-0 overflow-hidden overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <span className="font-medium text-sm">대여 이력</span>
          <select className="input max-w-[160px] ml-auto" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">전체 상태</option>
            <option value="ACTIVE">진행</option>
            <option value="REVERSED">역전</option>
          </select>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-slate-400 text-sm">로딩 중...</div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-slate-400 text-sm">등록 내역이 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>대여일</th><th>빌려준 부서</th><th>빌린 부서</th><th>품목</th><th className="text-right">수량</th><th>상태</th><th>사유</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="text-xs">{String(r.loaned_at).slice(0, 10)}</td>
                  <td>{r.from_department_name || r.from_department_id}</td>
                  <td>{r.to_department_name || r.to_department_id}</td>
                  <td>{r.item_name} <span className="text-xs text-slate-400">{r.item_code}</span></td>
                  <td className="text-right">{fmt(Number(r.qty || 0))}</td>
                  <td>{r.status === 'ACTIVE' ? <span className="badge-green">진행</span> : <span className="badge-gray">역전</span>}</td>
                  <td className="text-xs text-slate-600">{r.note || '-'}</td>
                  <td>
                    {r.status === 'ACTIVE' && (
                      <button className="text-xs text-red-500 hover:underline" onClick={() => reverseLoan(r.id)}>역전</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 대여 모달 */}
      {modal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">대여등록</h2>
              <button onClick={() => setModal(false)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              <div>
                <label className="label">품목 *</label>
                <div className="relative">
                  <input
                    type="text"
                    className="input"
                    placeholder="품목명 또는 코드 검색..."
                    value={itemSearch}
                    onChange={e => { setItemSearch(e.target.value); setShowDrop(true); setForm(f => ({ ...f, item_id: '' })); }}
                    onFocus={() => setShowDrop(true)}
                    onBlur={() => setTimeout(() => setShowDrop(false), 150)}
                  />
                  {showDrop && filteredDropItems.length > 0 && (
                    <div className="absolute z-50 top-full left-0 right-0 bg-white border border-gray-200 rounded-b shadow-lg max-h-48 overflow-y-auto">
                      {filteredDropItems.map(i => (
                        <div key={i.id} className="px-3 py-2 hover:bg-teal-50 cursor-pointer text-sm border-b border-gray-50" onMouseDown={() => selectItem(i)}>
                          <span className="font-medium">{i.name}</span>
                          <span className="text-xs text-slate-400 ml-1.5">{i.item_code}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {form.item_id && selectedStock !== null && (
                  <p className="text-xs mt-1 text-teal-600">현재 재고: <strong>{fmt(selectedStock)}</strong>개</p>
                )}
              </div>
              <div>
                <label className="label">빌린 부서 *</label>
                <select
                  className={`input ${sameDept ? 'border-red-400' : ''}`}
                  value={form.to_department_id}
                  onChange={e => setForm(f => ({ ...f, to_department_id: e.target.value }))}
                >
                  <option value="">부서 선택</option>
                  {depts.filter(d => d.id !== user?.department_id).map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
                {sameDept && <p className="text-xs text-red-500 mt-0.5">자기 부서에는 대여할 수 없습니다.</p>}
              </div>
              <div>
                <label className="label">수량 *</label>
                <input
                  className="input text-right"
                  value={form.qty}
                  onChange={e => setForm(f => ({ ...f, qty: e.target.value }))}
                  onBlur={e => setForm(f => ({ ...f, qty: fmt(toNumber(e.target.value)) }))}
                />
              </div>
              <div>
                <label className="label">대여일</label>
                <input className="input" type="date" value={form.loaned_at} onChange={e => setForm(f => ({ ...f, loaned_at: e.target.value }))} />
              </div>
              <div>
                <label className="label">사유</label>
                <input className="input" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setModal(false)} className="btn-secondary">취소</button>
              <button onClick={save} disabled={saving || !form.item_id || !form.to_department_id || sameDept} className="btn-primary">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
