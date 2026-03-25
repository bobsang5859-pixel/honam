import { useState, useEffect, useRef } from 'react';
import { Wrench, Printer } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';
import { PageHeader, Modal } from '../components/ui';

interface EquipmentUnit {
  id: string;
  serial_no: string;
  item_name: string;
  item_code: string;
  department_name: string;
  location: string;
  is_primary: boolean;
  status: 'ACTIVE' | 'IN_REPAIR' | 'DISPOSED';
  notes: string;
  created_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '정상',
  IN_REPAIR: '수리중',
  DISPOSED: '폐기',
};
const STATUS_CLS: Record<string, string> = {
  ACTIVE: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800',
  IN_REPAIR: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800',
  DISPOSED: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-slate-500',
};

export default function MyEquipmentPage() {
  const { user } = useAuth();
  const [units, setUnits] = useState<EquipmentUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingLocation, setEditingLocation] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 폐기 모달
  const [disposeModal, setDisposeModal] = useState<{ unit: EquipmentUnit } | null>(null);
  const [disposeNote, setDisposeNote] = useState('');
  const [disposeLoading, setDisposeLoading] = useState(false);

  // 수리 모달
  const [repairModal, setRepairModal] = useState<{ unit: EquipmentUnit } | null>(null);
  const [repairDesc, setRepairDesc] = useState('');
  const [repairLoading, setRepairLoading] = useState(false);

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  function showMsg(type: 'ok' | 'err', text: string) {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  }

  async function load() {
    setLoading(true);
    try {
      const data = await api('/equipment-units/my-dept');
      setUnits(data);
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function saveLocation(unit: EquipmentUnit) {
    const loc = editingLocation[unit.id] ?? unit.location;
    try {
      await api(`/equipment-units/${unit.id}`, { method: 'PUT', body: JSON.stringify({ location: loc }) });
      showMsg('ok', '위치가 저장되었습니다.');
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    }
  }

  async function togglePrimary(unit: EquipmentUnit) {
    try {
      await api(`/equipment-units/${unit.id}`, { method: 'PUT', body: JSON.stringify({ is_primary: !unit.is_primary }) });
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    }
  }

  async function submitDispose() {
    if (!disposeModal) return;
    setDisposeLoading(true);
    try {
      await api(`/equipment-units/${disposeModal.unit.id}/dispose`, {
        method: 'POST',
        body: JSON.stringify({ note: disposeNote }),
      });
      showMsg('ok', '폐기신청이 접수되었습니다.');
      setDisposeModal(null);
      setDisposeNote('');
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setDisposeLoading(false);
    }
  }

  async function submitRepair() {
    if (!repairModal) return;
    setRepairLoading(true);
    try {
      await api(`/equipment-units/${repairModal.unit.id}/repair`, {
        method: 'POST',
        body: JSON.stringify({ description: repairDesc }),
      });
      showMsg('ok', '수리신청이 접수되었습니다.');
      setRepairModal(null);
      setRepairDesc('');
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setRepairLoading(false);
    }
  }

  function printLabels() {
    const toPrint = units.filter(u => selectedIds.has(u.id));
    if (toPrint.length === 0) {
      showMsg('err', '라벨을 출력할 비품을 선택해주세요.');
      return;
    }
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<html><head><title>비품 라벨</title>
      <style>
        body { font-family: sans-serif; margin:0; }
        .label { display:inline-block; border:1px solid #333; padding:8px 12px; margin:4px; width:160px; text-align:center; page-break-inside:avoid; }
        .serial { font-size:16px; font-weight:bold; letter-spacing:1px; }
        .name { font-size:11px; color:#555; margin-top:4px; }
        @media print { body { margin: 0; } }
      </style>
    </head><body>`);
    for (const u of toPrint) {
      w.document.write(`<div class="label"><div class="serial">${u.serial_no}</div><div class="name">${u.item_name}</div></div>`);
    }
    w.document.write('</body></html>');
    w.document.close();
    w.print();
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === units.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(units.map(u => u.id)));
  }

  return (
    <div>
      <PageHeader
        icon={Wrench}
        title="수리 신청"
        description="부서 비품 관리 및 수리/폐기 신청"
        actions={
          <button onClick={printLabels} className="btn btn-secondary text-sm flex items-center gap-1.5">
            <Printer className="w-3.5 h-3.5" /> 라벨 출력 ({selectedIds.size})
          </button>
        }
      />

      {msg && (
        <div className={`mb-3 px-4 py-2 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-500">불러오는 중...</div>
      ) : units.length === 0 ? (
        <div className="text-center py-12 text-slate-400">등록된 비품이 없습니다.</div>
      ) : (
        <div className="card p-0 overflow-hidden overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-8">
                  <input type="checkbox" checked={selectedIds.size === units.length && units.length > 0}
                    onChange={toggleAll} className="rounded" />
                </th>
                <th>일련번호</th>
                <th>품목명</th>
                <th>위치</th>
                <th className="text-center w-16">정/부</th>
                <th className="text-center w-24">상태</th>
                <th className="text-right">액션</th>
              </tr>
            </thead>
            <tbody>
              {units.map(unit => (
                <tr key={unit.id} className="hover:bg-slate-50">
                  <td className="">
                    <input type="checkbox" checked={selectedIds.has(unit.id)}
                      onChange={() => toggleSelect(unit.id)} className="rounded" />
                  </td>
                  <td className="font-mono text-xs text-blue-700 font-semibold">{unit.serial_no}</td>
                  <td className="">
                    <div className="font-medium text-slate-800">{unit.item_name}</div>
                    {unit.item_code && <div className="text-xs text-slate-400">{unit.item_code}</div>}
                  </td>
                  <td className="">
                    {unit.status === 'ACTIVE' ? (
                      <div className="flex items-center gap-1">
                        <input
                          className="input text-xs w-36"
                          value={editingLocation[unit.id] ?? unit.location}
                          onChange={e => setEditingLocation(prev => ({ ...prev, [unit.id]: e.target.value }))}
                          placeholder="위치 입력"
                        />
                        {(editingLocation[unit.id] !== undefined && editingLocation[unit.id] !== unit.location) && (
                          <button
                            onClick={() => saveLocation(unit)}
                            className="text-xs bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600"
                          >저장</button>
                        )}
                      </div>
                    ) : (
                      <span className="text-slate-500 text-xs">{unit.location || '—'}</span>
                    )}
                  </td>
                  <td className="text-center">
                    {unit.status === 'ACTIVE' ? (
                      <button
                        onClick={() => togglePrimary(unit)}
                        className={`text-xs px-2 py-1 rounded border font-medium transition-colors ${
                          unit.is_primary
                            ? 'bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200'
                            : 'bg-gray-100 text-slate-600 border-gray-300 hover:bg-gray-200'
                        }`}
                      >
                        {unit.is_primary ? '정' : '부'}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">{unit.is_primary ? '정' : '부'}</span>
                    )}
                  </td>
                  <td className="text-center">
                    <span className={STATUS_CLS[unit.status]}>
                      {unit.status === 'ACTIVE' && '●'}
                      {unit.status === 'IN_REPAIR' && '●'}
                      {unit.status === 'DISPOSED' && '×'}
                      {' '}{STATUS_LABEL[unit.status]}
                    </span>
                  </td>
                  <td className="text-right">
                    {unit.status === 'ACTIVE' && (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => { setDisposeModal({ unit }); setDisposeNote(''); }}
                          className="text-xs px-2.5 py-1.5 rounded border border-red-300 text-red-600 hover:bg-red-50"
                        >폐기신청</button>
                        <button
                          onClick={() => { setRepairModal({ unit }); setRepairDesc(''); }}
                          className="text-xs px-2.5 py-1.5 rounded border border-yellow-300 text-yellow-700 hover:bg-yellow-50"
                        >수리신청</button>
                      </div>
                    )}
                    {unit.status === 'IN_REPAIR' && (
                      <span className="text-xs text-slate-400">수리요청 접수됨</span>
                    )}
                    {unit.status === 'DISPOSED' && (
                      <span className="text-xs text-slate-400">폐기완료</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 폐기신청 모달 */}
      <Modal
        open={!!disposeModal}
        onClose={() => setDisposeModal(null)}
        title="폐기신청"
        footer={
          <>
            <button onClick={() => setDisposeModal(null)} className="btn-secondary">취소</button>
            <button onClick={submitDispose} disabled={disposeLoading} className="btn-danger disabled:opacity-50">
              {disposeLoading ? '처리중...' : '폐기신청'}
            </button>
          </>
        }
      >
        {disposeModal && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              <span className="font-mono text-blue-700">{disposeModal.unit.serial_no}</span>{' '}
              {disposeModal.unit.item_name}
            </p>
            <div>
              <label className="label">폐기 사유</label>
              <textarea
                className="input resize-none"
                rows={3}
                value={disposeNote}
                onChange={e => setDisposeNote(e.target.value)}
                placeholder="폐기 사유를 입력하세요"
              />
            </div>
          </div>
        )}
      </Modal>

      {/* 수리신청 모달 */}
      <Modal
        open={!!repairModal}
        onClose={() => setRepairModal(null)}
        title="수리신청"
        footer={
          <>
            <button onClick={() => setRepairModal(null)} className="btn-secondary">취소</button>
            <button onClick={submitRepair} disabled={repairLoading} className="btn-primary disabled:opacity-50">
              {repairLoading ? '처리중...' : '수리신청'}
            </button>
          </>
        }
      >
        {repairModal && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              <span className="font-mono text-blue-700">{repairModal.unit.serial_no}</span>{' '}
              {repairModal.unit.item_name}
            </p>
            <div>
              <label className="label">증상 / 수리내용</label>
              <textarea
                className="input resize-none"
                rows={3}
                value={repairDesc}
                onChange={e => setRepairDesc(e.target.value)}
                placeholder="증상이나 수리 내용을 입력하세요"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
