import React, { useState, useEffect, useCallback } from 'react';
import { HeartPulse, Pencil, ToggleLeft, ToggleRight, Plus, Trash2 } from 'lucide-react';
import { PageHeader, Modal, EmptyState, FormField } from '../components/ui';

interface SupplyMap {
  id: string;
  item_id: string;
  qty_per_day: number;
  qty_per_week: number;
  note: string;
  item: { id: string; name: string; uom: string };
}

interface TreatmentType {
  id: string;
  code: string;
  name: string;
  category: string;
  is_active: boolean;
  supply_maps: SupplyMap[];
  _count: { patient_treatments: number };
}

interface ItemOption {
  id: string;
  name: string;
  uom: string;
  item_code: string;
}

const API = '/api/treatment-types';
const CATEGORIES = ['영양', '욕창', '호흡', '배설', '피부', '투약', '검사', '기타'];

function getToken() {
  return localStorage.getItem('token') || '';
}

function authHeaders(json = false) {
  const h: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

export default function TreatmentTypesPage() {
  const [types, setTypes] = useState<TreatmentType[]>([]);
  const [items, setItems] = useState<ItemOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Form
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ code: '', name: '', category: '' });
  const [showForm, setShowForm] = useState(false);

  // Supply map
  const [selectedType, setSelectedType] = useState<TreatmentType | null>(null);
  const [mapForm, setMapForm] = useState({ item_id: '', qty_per_day: '1', qty_per_week: '0', note: '' });
  const [itemSearch, setItemSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(API, { headers: authHeaders() });
      const data = await res.json();
      setTypes(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Load items for mapping
    fetch('/api/items?active=true', { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setItems(Array.isArray(d) ? d : d.items || []))
      .catch(() => {});
  }, [load]);

  const handleSave = async () => {
    if (!form.code || !form.name) return alert('코드와 이름을 입력하세요.');
    const method = editId ? 'PUT' : 'POST';
    const url = editId ? `${API}/${editId}` : API;
    await fetch(url, {
      method,
      headers: authHeaders(true),
      body: JSON.stringify(form),
    });
    setShowForm(false);
    setEditId(null);
    setForm({ code: '', name: '', category: '' });
    load();
  };

  const handleEdit = (t: TreatmentType) => {
    setEditId(t.id);
    setForm({ code: t.code, name: t.name, category: t.category });
    setShowForm(true);
  };

  const handleToggleActive = async (t: TreatmentType) => {
    await fetch(`${API}/${t.id}`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify({ is_active: !t.is_active }),
    });
    load();
  };

  const handleAddMap = async () => {
    if (!selectedType || !mapForm.item_id) return;
    await fetch(`${API}/${selectedType.id}/supply-maps`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({
        item_id: mapForm.item_id,
        qty_per_day: Number(mapForm.qty_per_day) || 0,
        qty_per_week: Number(mapForm.qty_per_week) || 0,
        note: mapForm.note,
      }),
    });
    setMapForm({ item_id: '', qty_per_day: '1', qty_per_week: '0', note: '' });
    setItemSearch('');
    // Reload selected type
    const res = await fetch(`${API}/${selectedType.id}`, { headers: authHeaders() });
    const updated = await res.json();
    setSelectedType(updated);
    load();
  };

  const handleDeleteMap = async (mapId: string) => {
    if (!selectedType) return;
    await fetch(`${API}/${selectedType.id}/supply-maps/${mapId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const res = await fetch(`${API}/${selectedType.id}`, { headers: authHeaders() });
    const updated = await res.json();
    setSelectedType(updated);
    load();
  };

  const filteredItems = items.filter(
    i => !itemSearch || i.name.includes(itemSearch) || i.item_code.includes(itemSearch)
  );

  return (
    <div>
      <PageHeader
        icon={HeartPulse}
        title="처치유형 관리"
        description="처치유형별 소요 물품을 관리합니다."
        actions={
          <button
            onClick={() => { setShowForm(true); setEditId(null); setForm({ code: '', name: '', category: '' }); }}
            className="btn-primary"
          >
            + 신규 등록
          </button>
        }
      />

      {/* 등록/수정 모달 */}
      <Modal
        open={showForm}
        onClose={() => { setShowForm(false); setEditId(null); }}
        title={editId ? '처치유형 수정' : '처치유형 등록'}
        footer={
          <>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary">취소</button>
            <button onClick={handleSave} className="btn-primary">저장</button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="코드" required>
            <input
              value={form.code}
              onChange={e => setForm({ ...form, code: e.target.value })}
              className="input"
              placeholder="예: TUBE_FEED"
            />
          </FormField>
          <FormField label="이름" required>
            <input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="input"
              placeholder="예: 경관영양"
            />
          </FormField>
          <FormField label="카테고리">
            <select
              value={form.category}
              onChange={e => setForm({ ...form, category: e.target.value })}
              className="input"
            >
              <option value="">선택</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
        </div>
      </Modal>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 왼쪽: 처치유형 목록 */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
            <span className="text-sm font-semibold text-slate-700">처치 유형 목록</span>
          </div>
          {loading ? (
            <EmptyState message="로딩 중..." />
          ) : types.length === 0 ? (
            <EmptyState message="등록된 처치유형이 없습니다." />
          ) : (
            <div className="divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
              {types.map(t => (
                <div
                  key={t.id}
                  className={`px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-teal-50 transition ${
                    selectedType?.id === t.id ? 'bg-teal-50 border-l-4 border-teal-500' : ''
                  } ${!t.is_active ? 'opacity-50' : ''}`}
                  onClick={() => setSelectedType(t)}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{t.name}</span>
                      <span className="text-xs text-slate-400">{t.code}</span>
                      {t.category && (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px]">{t.category}</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      물품 {t.supply_maps.length}종 | 적용 환자 {t._count.patient_treatments}명
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={e => { e.stopPropagation(); handleEdit(t); }}
                      className="px-2 py-1 text-xs text-teal-600 hover:bg-teal-100 rounded inline-flex items-center gap-0.5"
                    >
                      <Pencil className="w-3 h-3" />수정
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleToggleActive(t); }}
                      className={`px-2 py-1 text-xs rounded inline-flex items-center gap-0.5 ${t.is_active ? 'text-red-500 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}
                    >
                      {t.is_active ? <><ToggleRight className="w-3 h-3" />비활성</> : <><ToggleLeft className="w-3 h-3" />활성</>}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 오른쪽: 물품 매핑 */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
            <span className="text-sm font-semibold text-slate-700">
              {selectedType ? `${selectedType.name} -- 소요 물품` : '처치유형을 선택하세요'}
            </span>
          </div>

          {selectedType ? (
            <div className="p-4">
              {/* 기존 매핑 목록 */}
              {selectedType.supply_maps.length > 0 && (
                <table className="w-full text-sm mb-4">
                  <thead>
                    <tr className="text-xs text-slate-500 border-b border-slate-200">
                      <th className="text-left py-1">품목</th>
                      <th className="text-right py-1">일/일</th>
                      <th className="text-right py-1">주/주</th>
                      <th className="text-left py-1 pl-2">비고</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedType.supply_maps.map(m => (
                      <tr key={m.id} className="hover:bg-slate-50">
                        <td className="py-1.5">
                          {m.item.name}
                          <span className="text-xs text-slate-400 ml-1">({m.item.uom})</span>
                        </td>
                        <td className="text-right py-1.5">{Number(m.qty_per_day)}</td>
                        <td className="text-right py-1.5">{Number(m.qty_per_week)}</td>
                        <td className="text-left py-1.5 pl-2 text-slate-400 text-xs">{m.note}</td>
                        <td className="py-1.5">
                          <button
                            onClick={() => handleDeleteMap(m.id)}
                            className="text-red-400 hover:text-red-600 text-xs inline-flex items-center gap-0.5"
                          >
                            <Trash2 className="w-3 h-3" />삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* 물품 추가 */}
              <div className="border-t border-slate-200 pt-3">
                <h3 className="text-xs font-semibold text-slate-600 mb-2 inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" />물품 추가</h3>
                <div className="space-y-2">
                  <div>
                    <input
                      value={itemSearch}
                      onChange={e => setItemSearch(e.target.value)}
                      placeholder="품목 검색..."
                      className="input"
                    />
                    {itemSearch && (
                      <div className="max-h-32 overflow-y-auto border border-slate-200 rounded mt-1 bg-white shadow-sm">
                        {filteredItems.slice(0, 10).map(i => (
                          <div
                            key={i.id}
                            className={`px-2 py-1 text-sm cursor-pointer hover:bg-teal-50 ${mapForm.item_id === i.id ? 'bg-teal-100' : ''}`}
                            onClick={() => { setMapForm({ ...mapForm, item_id: i.id }); setItemSearch(i.name); }}
                          >
                            {i.name} <span className="text-xs text-slate-400">({i.uom})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <FormField label="일/일" className="!mb-0">
                      <input
                        type="number"
                        value={mapForm.qty_per_day}
                        onChange={e => setMapForm({ ...mapForm, qty_per_day: e.target.value })}
                        className="input"
                        min="0"
                        step="0.1"
                      />
                    </FormField>
                    <FormField label="주/주" className="!mb-0">
                      <input
                        type="number"
                        value={mapForm.qty_per_week}
                        onChange={e => setMapForm({ ...mapForm, qty_per_week: e.target.value })}
                        className="input"
                        min="0"
                        step="0.1"
                      />
                    </FormField>
                    <FormField label="비고" className="!mb-0">
                      <input
                        value={mapForm.note}
                        onChange={e => setMapForm({ ...mapForm, note: e.target.value })}
                        className="input"
                      />
                    </FormField>
                  </div>
                  <button
                    onClick={handleAddMap}
                    disabled={!mapForm.item_id}
                    className="btn-primary inline-flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />추가
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState message="왼쪽에서 처치유형을 선택하면 소요 물품을 관리할 수 있습니다." />
          )}
        </div>
      </div>
    </div>
  );
}
