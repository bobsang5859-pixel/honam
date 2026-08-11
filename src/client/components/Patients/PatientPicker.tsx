import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { Modal } from '../ui';
import { Search, Users, AlertTriangle, X } from 'lucide-react';

export interface PickerPatient {
  id: string;
  name: string;
  room_no: string;
  bed_no: number | null;
  diaper_state: string;
  treatments: { treatment_type_id: string; name: string }[];
}

export interface PickerItem {
  id: string;
  name: string;
  category?: string;
  sub_category?: string | null;
  item_code?: string;
}

interface DuplicateConfirmInfo {
  patient: { id: string; name: string };
  existing: { usage_kind: string; label: string; size: string };
  requested: { usage_kind: string; label: string; size: string };
  message: string;
}

interface Props {
  item: PickerItem;
  allPatients: PickerPatient[];
  mappedPatientIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
  showMsg: (type: 'ok' | 'err', text: string) => void;
}

type FilterMode = 'unmapped' | 'mapped';

export default function PatientPicker({ item, allPatients, mappedPatientIds, onClose, onAdded, showMsg }: Props) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('mapped');
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  // 다중 선택용
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // 처치 종류 선택 dialog (구 candidates)
  const [candidatesFor, setCandidatesFor] = useState<{ patient_id: string; candidates: { treatment_type_id: string; name: string }[] } | null>(null);
  // 사이즈 중복 confirm dialog
  const [duplicateConfirm, setDuplicateConfirm] = useState<{ patient_id: string; info: DuplicateConfirmInfo } | null>(null);

  // 검색·필터 적용된 환자 목록 + 병실별 그룹화
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allPatients.filter(p => {
      if (filter === 'unmapped' && mappedPatientIds.has(p.id)) return false;
      if (filter === 'mapped' && !mappedPatientIds.has(p.id)) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.room_no.toLowerCase().includes(q);
    });
  }, [allPatients, mappedPatientIds, search, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, PickerPatient[]>();
    for (const p of visible) {
      const arr = map.get(p.room_no) ?? [];
      arr.push(p);
      map.set(p.room_no, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, 'ko'));
  }, [visible]);

  const totalMapped = useMemo(
    () => allPatients.filter(p => mappedPatientIds.has(p.id)).length,
    [allPatients, mappedPatientIds],
  );

  // 단일 환자 추가
  const addOne = async (patientId: string, opts?: { treatment_type_id?: string; force?: boolean }) => {
    setSubmittingId(patientId);
    try {
      const body: any = { patient_id: patientId, item_id: item.id };
      if (opts?.treatment_type_id) body.treatment_type_id = opts.treatment_type_id;
      if (opts?.force) body.force = true;
      const r: any = await api('/patient-item-mapping/auto', { method: 'POST', body: JSON.stringify(body) });

      if (r?.auto === false && r?.action === 'CONFIRM_DUPLICATE_SIZE') {
        setDuplicateConfirm({ patient_id: patientId, info: r as any });
        return false;
      }
      if (r?.auto === false && Array.isArray(r?.candidates)) {
        setCandidatesFor({ patient_id: patientId, candidates: r.candidates });
        return false;
      }

      const action = r?.action;
      if (action === 'DIAPER_ENABLED') showMsg('ok', '기저귀 사용 환자로 등록되었습니다.');
      else if (action === 'TREATMENT_ADDED') showMsg('ok', '환자 처치가 등록되었습니다.');
      else if (action === 'USAGE_REGISTERED') showMsg('ok', '환자가 등록되었습니다.');
      else if (action === 'NOOP') {/* 조용히 */ }
      onAdded();
      return true;
    } catch (e: any) {
      showMsg('err', e?.message ?? '환자 등록에 실패했습니다.');
      return false;
    } finally {
      setSubmittingId(null);
    }
  };

  // 단일 환자 빼기 (매핑 해제)
  const removeOne = async (patientId: string, patientName: string) => {
    if (!confirm(`${patientName} 환자를 "${item.name}" 사용 환자에서 빼시겠습니까?\n\n· 기저귀 품목: 환자의 기저귀 상태가 '미사용'으로 변경됩니다.\n· 처치/사용 매핑: 해당 처치/매핑이 '종료' 처리됩니다.`)) return;
    setRemovingId(patientId);
    try {
      const r: any = await api('/patient-item-mapping/remove', {
        method: 'POST',
        body: JSON.stringify({ patient_id: patientId, item_id: item.id }),
      });
      if (r?.removed) {
        const action = r.action;
        if (action === 'DIAPER_DISABLED') showMsg('ok', '기저귀 사용 환자에서 제외되었습니다.');
        else if (action === 'TREATMENT_ENDED') showMsg('ok', '처치가 종료 처리되었습니다.');
        else if (action === 'USAGE_ENDED') showMsg('ok', '사용 매핑이 종료되었습니다.');
        else showMsg('ok', '환자가 사용 환자에서 빠졌습니다.');
      } else {
        showMsg('ok', r?.message ?? '변경 사항 없음');
      }
      onAdded();
    } catch (e: any) {
      showMsg('err', e?.message ?? '환자 제외에 실패했습니다.');
    } finally {
      setRemovingId(null);
    }
  };

  // 다중 환자 한 번에 추가
  const addBulk = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkSubmitting(true);
    let okCount = 0;
    let confirmHits = 0;
    let failCount = 0;
    for (const id of ids) {
      try {
        const r: any = await api('/patient-item-mapping/auto', {
          method: 'POST',
          body: JSON.stringify({ patient_id: id, item_id: item.id }),
        });
        if (r?.auto === false) {
          confirmHits += 1;
          // 다중 추가에서는 confirm/candidates 가 필요한 환자를 건너뜀.
          // 마지막 confirm 만 다이얼로그로 띄움.
          if (r?.action === 'CONFIRM_DUPLICATE_SIZE') {
            setDuplicateConfirm({ patient_id: id, info: r as any });
          } else if (Array.isArray(r?.candidates)) {
            setCandidatesFor({ patient_id: id, candidates: r.candidates });
          }
          continue;
        }
        okCount += 1;
      } catch {
        failCount += 1;
      }
    }
    setBulkSubmitting(false);
    setSelectedIds(new Set());
    onAdded();
    let msg = `${okCount}명 등록`;
    if (confirmHits > 0) msg += ` · 확인 필요 ${confirmHits}명 (개별 처리)`;
    if (failCount > 0) msg += ` · 실패 ${failCount}명`;
    showMsg('ok', msg);
  };

  return (
    <Modal open={true} onClose={onClose} title={`환자 추가 — ${item.name}`} size="full">
      <div className="space-y-3">
        {/* 안내문 */}
        <p className="text-xs text-gray-500">
          이 품목을 사용하는 환자를 추가합니다. 카테고리에 따라 환자관리(기저귀) / 처치 등록 / 환자×품목 사용 매핑에 자동 저장됩니다.
        </p>

        {/* 검색 + 필터 칩 */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[14rem]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="환자명 또는 병실 검색..."
              className="input pl-9 w-full"
              autoFocus
            />
          </div>
          <div className="flex items-center gap-1 text-xs">
            {([
              { v: 'mapped', l: '등록됨' },
              { v: 'unmapped', l: '미등록' },
            ] as const).map(opt => (
              <button
                key={opt.v}
                onClick={() => setFilter(opt.v)}
                className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
                  filter === opt.v
                    ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-200'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {opt.l}
              </button>
            ))}
          </div>
          <span className="text-xs text-gray-500 ml-auto">
            <Users className="w-3.5 h-3.5 inline mr-0.5" />
            전체 {allPatients.length}명 · 등록 {totalMapped}명
          </span>
        </div>

        {/* 다중 선택 액션바 */}
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            <span className="text-sm text-blue-800">
              <b>{selectedIds.size}명</b> 선택됨
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs px-3 py-1.5 rounded-md text-blue-600 hover:bg-blue-100"
                disabled={bulkSubmitting}
              >
                선택 해제
              </button>
              <button
                onClick={addBulk}
                disabled={bulkSubmitting}
                className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {bulkSubmitting ? '등록 중…' : `선택한 ${selectedIds.size}명 추가`}
              </button>
            </div>
          </div>
        )}

        {/* 사이즈 중복 confirm */}
        {duplicateConfirm && (
          <div className="border-2 border-amber-300 bg-amber-50 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">
                <p className="font-semibold text-amber-900">사이즈 중복 확인</p>
                <p className="text-amber-800 mt-1">{duplicateConfirm.info.message}</p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={async () => {
                      const pid = duplicateConfirm.patient_id;
                      setDuplicateConfirm(null);
                      await addOne(pid, { force: true });
                    }}
                    className="text-xs px-3 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700"
                  >
                    예 (두 사이즈 모두 사용)
                  </button>
                  <button
                    onClick={() => setDuplicateConfirm(null)}
                    className="text-xs px-3 py-1.5 rounded-md text-amber-700 hover:bg-amber-100"
                  >
                    아니오
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 처치 후보 선택 (구 candidates) */}
        {candidatesFor && (
          <div className="border-2 border-amber-300 bg-amber-50 rounded-lg p-3">
            <p className="text-sm font-semibold text-amber-900 mb-2">이 품목과 매핑된 처치 종류를 선택해주세요:</p>
            <div className="flex flex-wrap gap-2">
              {candidatesFor.candidates.map(c => (
                <button
                  key={c.treatment_type_id}
                  onClick={() => addOne(candidatesFor.patient_id, { treatment_type_id: c.treatment_type_id }).then(() => setCandidatesFor(null))}
                  className="text-xs px-3 py-1.5 rounded-full border border-amber-300 bg-white hover:bg-amber-100"
                >
                  {c.name}
                </button>
              ))}
              <button
                onClick={() => setCandidatesFor(null)}
                className="text-xs px-3 py-1.5 rounded-full text-gray-500 hover:bg-gray-100"
              >취소</button>
            </div>
          </div>
        )}

        {/* 환자 목록 */}
        <div className="max-h-[60vh] overflow-y-auto border rounded-lg">
          {visible.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">
              {filter === 'mapped' ? '등록된 환자가 없습니다.' : search ? '조건에 맞는 환자가 없습니다.' : '추가 가능한 환자가 없습니다.'}
            </p>
          ) : (
            grouped.map(([roomNo, list]) => (
              <div key={roomNo}>
                <div className="sticky top-0 z-10 bg-slate-100 px-4 py-1.5 text-xs font-semibold text-slate-600 border-b border-slate-200">
                  ◆ {roomNo}호 ({list.length}명)
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {list.map(p => {
                      const isMapped = mappedPatientIds.has(p.id);
                      const isSelected = selectedIds.has(p.id);
                      const isSubmitting = submittingId === p.id;
                      return (
                        <tr key={p.id} className={`border-b border-slate-100 ${isMapped ? 'bg-green-50/40' : ''} ${isSelected ? 'bg-blue-50' : ''}`}>
                          <td className="px-3 py-2 w-8 text-center">
                            {!isMapped && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelect(p.id)}
                                disabled={bulkSubmitting}
                              />
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <div className="text-sm font-medium">{p.name}</div>
                            <div className="text-xs text-gray-400 font-mono">
                              {p.room_no}{p.bed_no != null ? `-${p.bed_no}` : ''}
                            </div>
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-500">
                            {p.diaper_state === 'IN_HOUSE' && (
                              <span className="inline-block mr-1 px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px]">원내기저귀</span>
                            )}
                            {p.treatments.length > 0
                              ? p.treatments.map(t => t.name).join(', ')
                              : (p.diaper_state !== 'IN_HOUSE' && <span className="text-gray-300">-</span>)}
                          </td>
                          <td className="px-3 py-2 text-right w-40">
                            {isMapped ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="text-xs text-green-600">✓ 사용 중</span>
                                <button
                                  onClick={() => removeOne(p.id, p.name)}
                                  disabled={removingId === p.id || bulkSubmitting}
                                  className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 inline-flex items-center gap-0.5"
                                  title="이 품목 사용 환자에서 빼기"
                                >
                                  <X className="w-3 h-3" />{removingId === p.id ? '빼는 중…' : '빼기'}
                                </button>
                              </span>
                            ) : (
                              <button
                                onClick={() => addOne(p.id)}
                                disabled={isSubmitting || bulkSubmitting}
                                className="text-xs px-3 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50 disabled:opacity-40"
                              >
                                {isSubmitting ? '등록 중…' : '+ 추가'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="btn-secondary">닫기</button>
        </div>
      </div>
    </Modal>
  );
}
