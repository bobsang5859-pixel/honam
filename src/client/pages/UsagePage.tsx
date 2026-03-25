import { useEffect, useMemo, useState } from 'react';
import { PenLine } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui';
import type { Item, UsageRecord, InventoryItem } from '@shared/types';

const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n || 0);
const toNumber = (v: string | number) => {
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const today = new Date().toISOString().slice(0, 10);

const REASON_PRESETS = ['처치', '교환', '폐기(유통기한)', '기타'];

type UsageRecordExt = UsageRecord & {
  patient_id?: string | null;
  patient_name?: string | null;
  patient_room_no?: string | null;
};

interface CartItem {
  item_id: string;
  item_name: string;
  item_code: string;
  used_qty: number;
  note: string;
  pack_size: number;
  stock: number;
}

export default function UsagePage() {
  const { user } = useAuth();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [rows, setRows] = useState<UsageRecordExt[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [search, setSearch] = useState('');

  // ── 단건 등록 모달 ─────────────────────────────────────────────────────────
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ item_id: '', used_qty: '1', used_at: today, note: '' });
  const [itemSearch, setItemSearch] = useState('');
  const [showDrop, setShowDrop] = useState(false);
  const [unitMode, setUnitMode] = useState<'EA' | 'BOX'>('EA');
  const [singlePatientId, setSinglePatientId] = useState('');
  const [singlePatientSearch, setSinglePatientSearch] = useState('');
  const [showSinglePatientDrop, setShowSinglePatientDrop] = useState(false);
  const [isPublicUse, setIsPublicUse] = useState(false);

  // ── 처치 등록 (배치) 모달 ──────────────────────────────────────────────────
  const [batchModal, setBatchModal] = useState(false);
  const [patients, setPatients] = useState<any[]>([]);
  const [batchPatientId, setBatchPatientId] = useState('');
  const [batchPatientSearch, setBatchPatientSearch] = useState('');
  const [showPatientDrop, setShowPatientDrop] = useState(false);
  const [batchDate, setBatchDate] = useState(today);
  const [batchCart, setBatchCart] = useState<CartItem[]>([]);
  const [batchItemSearch, setBatchItemSearch] = useState('');
  const [showBatchItemDrop, setShowBatchItemDrop] = useState(false);
  const [batchQty, setBatchQty] = useState('1');
  const [batchNote, setBatchNote] = useState('처치');
  const [batchSaving, setBatchSaving] = useState(false);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [invRows, itemRows, usageRows] = await Promise.all([
        api('/inventory'),
        api('/items?is_active=true'),
        api('/usage'),
      ]);
      setInventory(Array.isArray(invRows) ? invRows : []);
      setItems(Array.isArray(itemRows) ? itemRows : []);
      setRows(Array.isArray(usageRows) ? usageRows : []);
    } catch (e: any) {
      showMsg('err', e.message || '조회에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filteredInventory = useMemo(() =>
    inventory.filter(i => !search || i.item_name.includes(search) || i.item_code.includes(search)),
    [inventory, search]
  );

  const filteredDropItems = useMemo(() => {
    if (!itemSearch) return items.slice(0, 30);
    const q = itemSearch.toLowerCase();
    return items.filter(i => i.name.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q)).slice(0, 30);
  }, [items, itemSearch]);

  // 배치 모달 품목 검색
  const filteredBatchItems = useMemo(() => {
    if (!batchItemSearch) return items.slice(0, 30);
    const q = batchItemSearch.toLowerCase();
    return items.filter(i => i.name.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q)).slice(0, 30);
  }, [items, batchItemSearch]);

  // 환자 검색 필터 (배치 모달)
  const filteredPatients = useMemo(() => {
    if (!batchPatientSearch) return patients.slice(0, 30);
    const q = batchPatientSearch.toLowerCase();
    return patients.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.room_no?.toLowerCase().includes(q) ||
      p.chart_no?.toLowerCase().includes(q)
    ).slice(0, 30);
  }, [patients, batchPatientSearch]);

  // 환자 검색 필터 (단건 모달)
  const filteredSinglePatients = useMemo(() => {
    if (!singlePatientSearch) return patients.slice(0, 30);
    const q = singlePatientSearch.toLowerCase();
    return patients.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.room_no?.toLowerCase().includes(q) ||
      p.chart_no?.toLowerCase().includes(q)
    ).slice(0, 30);
  }, [patients, singlePatientSearch]);

  const selectedStock = useMemo(() => {
    if (!form.item_id) return null;
    return inventory.filter(i => i.item_id === form.item_id).reduce((s, r) => s + Number(r.on_hand_qty || 0), 0);
  }, [form.item_id, inventory]);

  const selectedPackSize = useMemo(() => {
    if (!form.item_id) return 1;
    const inv = inventory.find(i => i.item_id === form.item_id);
    if (inv?.pack_size && inv.pack_size > 1) return inv.pack_size;
    const item = items.find(i => i.id === form.item_id);
    return item?.pack_size ?? 1;
  }, [form.item_id, inventory, items]);

  // ── 단건 등록 ──────────────────────────────────────────────────────────────
  const openModal = async (inv?: InventoryItem) => {
    setForm({ item_id: inv?.item_id || '', used_qty: '1', used_at: today, note: '' });
    setItemSearch(inv ? `${inv.item_name} (${inv.item_code})` : '');
    setShowDrop(false);
    setUnitMode('EA');
    setSinglePatientId('');
    setSinglePatientSearch('');
    setIsPublicUse(false);
    setModal(true);
    if (patients.length === 0) {
      try {
        const data = await api('/patients?status=ADMITTED');
        setPatients(Array.isArray(data) ? data : []);
      } catch { setPatients([]); }
    }
  };

  const selectItem = (item: Item) => {
    setForm(f => ({ ...f, item_id: item.id }));
    setItemSearch(`${item.name} (${item.item_code})`);
    setShowDrop(false);
    setUnitMode('EA');
  };

  const save = async () => {
    if (!form.item_id) return showMsg('err', '품목을 선택하세요.');
    if (!singlePatientId && !isPublicUse) return showMsg('err', '환자를 선택하거나 "공용 사용"을 체크해주세요.');
    const rawQty = toNumber(form.used_qty);
    if (rawQty <= 0) return showMsg('err', '수량은 1 이상이어야 합니다.');
    const qty = unitMode === 'BOX' ? rawQty * selectedPackSize : rawQty;
    setSaving(true);
    try {
      await api('/usage', {
        method: 'POST',
        body: JSON.stringify({
          department_id: user?.department_id,
          item_id: form.item_id,
          used_qty: qty,
          used_at: form.used_at,
          note: form.note,
          patient_id: singlePatientId || undefined,
        }),
      });
      setModal(false);
      showMsg('ok', '사용등록이 저장되었습니다.');
      load();
    } catch (e: any) {
      showMsg('err', e.message || '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const reverseUsage = async (id: string) => {
    if (!confirm('이 사용등록을 역전하시겠습니까?')) return;
    try {
      await api(`/usage/${id}/reverse`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '역전 처리되었습니다.');
      load();
    } catch (e: any) {
      showMsg('err', e.message || '역전에 실패했습니다.');
    }
  };

  // ── 처치 등록 (배치) ────────────────────────────────────────────────────────
  const openBatchModal = async () => {
    setBatchPatientId('');
    setBatchPatientSearch('');
    setBatchDate(today);
    setBatchCart([]);
    setBatchItemSearch('');
    setBatchQty('1');
    setBatchNote('처치');
    setBatchModal(true);
    // 환자 목록 로드
    try {
      const data = await api('/patients?status=ADMITTED');
      setPatients(Array.isArray(data) ? data : []);
    } catch { setPatients([]); }
  };

  const selectBatchPatient = (p: any) => {
    setBatchPatientId(p.id);
    setBatchPatientSearch(`${p.name} (${p.room_no}호${p.bed_no ? ' ' + p.bed_no + '번' : ''})`);
    setShowPatientDrop(false);
  };

  const addToCart = (item: Item) => {
    const qty = toNumber(batchQty);
    if (qty <= 0) { showMsg('err', '수량을 입력하세요.'); return; }
    const stock = inventory.filter(i => i.item_id === item.id).reduce((s, r) => s + Number(r.on_hand_qty || 0), 0);
    const packSize = inventory.find(i => i.item_id === item.id)?.pack_size ?? item.pack_size ?? 1;
    setBatchCart(c => [...c, {
      item_id: item.id,
      item_name: item.name,
      item_code: item.item_code,
      used_qty: qty,
      note: batchNote,
      pack_size: packSize,
      stock,
    }]);
    setBatchItemSearch('');
    setBatchQty('1');
    setShowBatchItemDrop(false);
  };

  const removeFromCart = (idx: number) => {
    setBatchCart(c => c.filter((_, i) => i !== idx));
  };

  const saveBatch = async () => {
    if (batchCart.length === 0) return showMsg('err', '품목을 추가하세요.');
    setBatchSaving(true);
    try {
      const res = await api('/usage/batch', {
        method: 'POST',
        body: JSON.stringify({
          department_id: user?.department_id,
          patient_id: batchPatientId || undefined,
          used_at: batchDate,
          items: batchCart.map(c => ({ item_id: c.item_id, used_qty: c.used_qty, note: c.note })),
        }),
      });
      const created = res?.created ?? batchCart.length;
      const errCount = res?.errors?.length ?? 0;
      setBatchModal(false);
      if (errCount > 0) {
        showMsg('err', `${created}건 저장, ${errCount}건 실패 (재고 부족 등)`);
      } else {
        showMsg('ok', `처치 등록 완료 (${created}건)`);
      }
      load();
    } catch (e: any) {
      showMsg('err', e.message || '저장에 실패했습니다.');
    } finally {
      setBatchSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={PenLine}
        title="사용 등록"
        description="부서별 실제 사용 수량을 등록합니다."
        actions={
          <div className="flex gap-2 items-center">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} className="input w-48" placeholder="품목명/코드 검색" />
            <button onClick={openBatchModal} className="btn-secondary">처치 등록</button>
            <button onClick={() => openModal()} className="btn-primary">+ 사용등록</button>
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
                    {(inv.pack_size ?? 1) > 1 && (
                      <span className="text-xs text-slate-400 ml-1 font-normal">
                        ({Math.floor(Number(inv.on_hand_qty) / inv.pack_size!)} BOX)
                      </span>
                    )}
                  </td>
                  <td className="text-xs text-slate-500">{inv.uom}{(inv.pack_size ?? 1) > 1 && <span className="text-slate-400">/{inv.pack_size}개</span>}</td>
                  <td>
                    <button onClick={() => openModal(inv)} className="text-xs text-teal-600 hover:underline font-medium">
                      사용등록
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 사용등록 이력 */}
      <div className="card p-0 overflow-hidden overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100">
          <span className="font-medium text-sm">사용등록 이력</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-slate-400 text-sm">로딩 중...</div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-slate-400 text-sm">등록 내역이 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>사용일</th><th>환자</th><th>품목</th><th className="text-right">수량</th><th>사유</th><th>등록자</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="text-xs">{String(r.used_at).slice(0, 10)}</td>
                  <td className="text-xs text-slate-600">
                    {r.patient_name
                      ? <span>{r.patient_name} <span className="text-slate-400">({r.patient_room_no}호)</span></span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td>{r.item_name} <span className="text-xs text-slate-400">{r.item_code}</span></td>
                  <td className="text-right">{fmt(Number(r.used_qty || 0))}</td>
                  <td className="text-xs text-slate-600">{r.note || '-'}</td>
                  <td className="text-xs text-slate-500">{r.creator_name || '-'}</td>
                  <td>
                    <button className="text-xs text-red-500 hover:underline" onClick={() => reverseUsage(r.id)}>역전</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── 단건 사용등록 모달 ─────────────────────────────────────────────── */}
      {modal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
          <div className="modal w-full max-w-md">
            <div className="modal-header">
              <h2 className="modal-title">사용등록</h2>
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
                  <p className="text-xs mt-1 text-teal-600">
                    현재 재고: <strong>{fmt(selectedStock)}</strong>개
                    {selectedPackSize > 1 && ` (${Math.floor(selectedStock / selectedPackSize)} BOX)`}
                  </p>
                )}
              </div>
              {/* 환자 선택 */}
              <div>
                <label className="label">환자</label>
                {isPublicUse ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-500">공용 사용 (환자 미지정)</span>
                    <button
                      type="button"
                      onClick={() => setIsPublicUse(false)}
                      className="text-xs text-teal-600 hover:underline"
                    >
                      환자 선택으로 변경
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <input
                        type="text"
                        className="input"
                        placeholder="환자 이름 또는 병실 검색..."
                        value={singlePatientSearch}
                        onChange={e => { setSinglePatientSearch(e.target.value); setShowSinglePatientDrop(true); setSinglePatientId(''); }}
                        onFocus={() => setShowSinglePatientDrop(true)}
                        onBlur={() => setTimeout(() => setShowSinglePatientDrop(false), 150)}
                      />
                      {showSinglePatientDrop && (
                        <div className="absolute z-50 top-full left-0 right-0 bg-white border border-gray-200 rounded-b shadow-lg max-h-48 overflow-y-auto">
                          {filteredSinglePatients.length === 0
                            ? <div className="px-3 py-2 text-xs text-slate-400">입원 환자가 없습니다.</div>
                            : filteredSinglePatients.map(p => (
                              <div
                                key={p.id}
                                className="px-3 py-2 hover:bg-teal-50 cursor-pointer text-sm border-b border-gray-50"
                                onMouseDown={() => {
                                  setSinglePatientId(p.id);
                                  setSinglePatientSearch(`${p.name} (${p.room_no}호${p.bed_no ? ' ' + p.bed_no + '번' : ''})`);
                                  setShowSinglePatientDrop(false);
                                }}
                              >
                                <span className="font-medium">{p.name}</span>
                                <span className="text-xs text-slate-400 ml-1.5">{p.room_no}호{p.bed_no ? ` ${p.bed_no}번` : ''}</span>
                              </div>
                            ))
                          }
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      {singlePatientId && <span className="text-xs text-teal-600">환자 선택됨</span>}
                      {!singlePatientId && (
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isPublicUse}
                            onChange={e => setIsPublicUse(e.target.checked)}
                            className="rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                          />
                          <span className="text-xs text-slate-500">공용 사용 (환자 미지정)</span>
                        </label>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div>
                <label className="label">수량 *</label>
                {selectedPackSize > 1 && (
                  <div className="flex gap-1 mb-2">
                    <button
                      type="button"
                      onClick={() => setUnitMode('EA')}
                      className={`px-3 py-1 text-xs rounded border transition-colors ${unitMode === 'EA' ? 'bg-navy-700 text-white border-navy-700' : 'bg-white text-slate-600 border-gray-300 hover:border-gray-400'}`}
                    >
                      낱개
                    </button>
                    <button
                      type="button"
                      onClick={() => setUnitMode('BOX')}
                      className={`px-3 py-1 text-xs rounded border transition-colors ${unitMode === 'BOX' ? 'bg-navy-700 text-white border-navy-700' : 'bg-white text-slate-600 border-gray-300 hover:border-gray-400'}`}
                    >
                      BOX
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    className="input text-right flex-1"
                    value={form.used_qty}
                    onChange={e => setForm(f => ({ ...f, used_qty: e.target.value }))}
                    onBlur={e => setForm(f => ({ ...f, used_qty: fmt(toNumber(e.target.value)) }))}
                  />
                  <span className="text-sm text-slate-500 whitespace-nowrap">
                    {unitMode === 'BOX' ? `BOX` : '개'}
                  </span>
                </div>
                {unitMode === 'BOX' && selectedPackSize > 1 && toNumber(form.used_qty) > 0 && (
                  <p className="text-xs mt-1 text-slate-400">
                    = {fmt(toNumber(form.used_qty) * selectedPackSize)}개 (1 BOX = {selectedPackSize}개)
                  </p>
                )}
              </div>
              <div>
                <label className="label">사유</label>
                <div className="flex gap-1 flex-wrap mb-1.5">
                  {REASON_PRESETS.map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, note: p }))}
                      className={`text-xs px-2.5 py-1 rounded border ${form.note === p ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-slate-600 border-gray-300 hover:border-teal-400'}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <input className="input" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="직접 입력 가능" />
              </div>
              <div>
                <label className="label">사용일</label>
                <input className="input" type="date" value={form.used_at} onChange={e => setForm(f => ({ ...f, used_at: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setModal(false)} className="btn-secondary">취소</button>
              <button onClick={save} disabled={saving || !form.item_id} className="btn-primary">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 처치 등록 (배치) 모달 ──────────────────────────────────────────── */}
      {batchModal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setBatchModal(false); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">처치 등록</h2>
              <button onClick={() => setBatchModal(false)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              {/* 환자 + 날짜 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">환자</label>
                  <div className="relative">
                    <input
                      type="text"
                      className="input"
                      placeholder="이름 또는 병실 검색..."
                      value={batchPatientSearch}
                      onChange={e => { setBatchPatientSearch(e.target.value); setShowPatientDrop(true); setBatchPatientId(''); }}
                      onFocus={() => setShowPatientDrop(true)}
                      onBlur={() => setTimeout(() => setShowPatientDrop(false), 150)}
                    />
                    {showPatientDrop && (
                      <div className="absolute z-50 top-full left-0 right-0 bg-white border border-gray-200 rounded-b shadow-lg max-h-48 overflow-y-auto">
                        {filteredPatients.length === 0
                          ? <div className="px-3 py-2 text-xs text-slate-400">입원 환자가 없습니다.</div>
                          : filteredPatients.map(p => (
                            <div
                              key={p.id}
                              className="px-3 py-2 hover:bg-teal-50 cursor-pointer text-sm border-b border-gray-50"
                              onMouseDown={() => selectBatchPatient(p)}
                            >
                              <span className="font-medium">{p.name}</span>
                              <span className="text-xs text-slate-400 ml-1.5">{p.room_no}호{p.bed_no ? ` ${p.bed_no}번` : ''}</span>
                            </div>
                          ))
                        }
                      </div>
                    )}
                  </div>
                  {batchPatientId && <p className="text-xs mt-1 text-teal-600">환자 선택됨</p>}
                </div>
                <div>
                  <label className="label">사용일</label>
                  <input className="input" type="date" value={batchDate} onChange={e => setBatchDate(e.target.value)} />
                </div>
              </div>

              {/* 품목 추가 행 */}
              <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-slate-500">품목 추가</p>
                <div className="flex gap-2 items-start flex-wrap">
                  {/* 품목 검색 */}
                  <div className="relative flex-1 min-w-[160px]">
                    <input
                      type="text"
                      className="input text-sm"
                      placeholder="품목명 또는 코드..."
                      value={batchItemSearch}
                      onChange={e => { setBatchItemSearch(e.target.value); setShowBatchItemDrop(true); }}
                      onFocus={() => setShowBatchItemDrop(true)}
                      onBlur={() => setTimeout(() => setShowBatchItemDrop(false), 150)}
                    />
                    {showBatchItemDrop && filteredBatchItems.length > 0 && (
                      <div className="absolute z-50 top-full left-0 right-0 bg-white border border-gray-200 rounded-b shadow-lg max-h-44 overflow-y-auto">
                        {filteredBatchItems.map(i => (
                          <div
                            key={i.id}
                            className="px-3 py-2 hover:bg-teal-50 cursor-pointer text-sm border-b border-gray-50"
                            onMouseDown={() => addToCart(i)}
                          >
                            <span className="font-medium">{i.name}</span>
                            <span className="text-xs text-slate-400 ml-1.5">{i.item_code}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 수량 */}
                  <input
                    type="number"
                    min="1"
                    className="input text-sm w-20 text-right"
                    value={batchQty}
                    onChange={e => setBatchQty(e.target.value)}
                    placeholder="수량"
                  />
                  {/* 사유 */}
                  <select
                    className="input text-sm w-28"
                    value={batchNote}
                    onChange={e => setBatchNote(e.target.value)}
                  >
                    {REASON_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <p className="text-xs text-slate-400">품목을 검색하여 선택하면 자동으로 목록에 추가됩니다.</p>
              </div>

              {/* 장바구니 */}
              {batchCart.length > 0 ? (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">품목</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">수량</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">사유</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">재고</th>
                        <th className="px-2 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {batchCart.map((c, idx) => (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="px-3 py-2">
                            <span className="font-medium">{c.item_name}</span>
                            <span className="text-xs text-slate-400 ml-1">{c.item_code}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            {fmt(c.used_qty)}<span className="text-xs text-slate-400 ml-0.5">개</span>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">{c.note}</td>
                          <td className={`px-3 py-2 text-right text-xs ${c.stock < c.used_qty ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
                            {fmt(c.stock)}개
                            {c.stock < c.used_qty && <span className="block text-[10px]">재고 부족</span>}
                          </td>
                          <td className="px-2 py-2">
                            <button onClick={() => removeFromCart(idx)} className="text-slate-300 hover:text-red-400 text-lg leading-none">&times;</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="border border-dashed border-gray-200 rounded-lg py-8 text-center text-sm text-slate-400">
                  위에서 품목을 검색하여 추가하세요
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => setBatchModal(false)} className="btn-secondary">취소</button>
              <button
                onClick={saveBatch}
                disabled={batchSaving || batchCart.length === 0}
                className="btn-primary"
              >
                {batchSaving ? '저장 중...' : `저장 (${batchCart.length}건)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
