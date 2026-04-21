import React, { useEffect, useState } from 'react';
import { CreditCard, X, Trash2, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui';
import { BigKpi } from '../components/stats';

const INSURANCE_LABEL: Record<string, string> = {
  HEALTH: '건강보험',
  MEDICAL_1: '의료급여1종', MEDICAL_2: '의료급여2종', WORKERS_COMP: '산재', AUTO_INS: '자동차',
};
const METHOD_LABEL: Record<string, string> = { CASH: '현금', CARD: '카드', TRANSFER: '계좌이체', OTHER: '기타' };
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  PAID: { label: '완납', cls: 'bg-emerald-100 text-emerald-700' },
  PARTIAL: { label: '부분납', cls: 'bg-amber-100 text-amber-700' },
  UNPAID: { label: '미납', cls: 'bg-red-100 text-red-700' },
  NONE: { label: '-', cls: 'bg-gray-100 text-gray-400' },
};

interface SummaryRow {
  patient_id: string; patient_no: string; name: string; department_name: string;
  insurance_type: string; total_charge: number; total_payment: number; unpaid: number; status: string;
}

export default function PatientChargesPage() {
  const { user, hasPerm } = useAuth();
  const isAdmin = hasPerm('SYSTEM_ADMIN') || hasPerm('BASIC_MANAGE');

  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [deptId, setDeptId] = useState('');
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [tab, setTab] = useState<'all' | 'unpaid'>('all');
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<any>(null);
  const [rows, setRows] = useState<SummaryRow[]>([]);

  // 모달
  const [modalOpen, setModalOpen] = useState(false);
  const [modalPatientId, setModalPatientId] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [payForm, setPayForm] = useState({ amount: '', payment_date: new Date().toISOString().slice(0, 10), payment_method: 'CASH', note: '' });
  const [saving, setSaving] = useState(false);

  // 부서 목록 로드
  useEffect(() => {
    if (isAdmin) {
      api('/departments').then((d: any[]) => setDepartments(d.filter((x: any) => x.is_active && !x.deleted_at))).catch(() => {});
    }
  }, [isAdmin]);

  // 요약 데이터 로드
  const loadSummary = async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ month });
      if (deptId) q.set('department_id', deptId);
      const data = await api(`/patient-charges/summary?${q}`);
      setSummary(data.summary);
      setRows(data.patients || []);
    } catch { }
    finally { setLoading(false); }
  };

  useEffect(() => { loadSummary(); }, [month, deptId]);

  const filteredRows = tab === 'unpaid' ? rows.filter(r => r.unpaid > 0) : rows;

  // 모달 열기
  const openDetail = async (patientId: string) => {
    setModalPatientId(patientId);
    setModalOpen(true);
    setDetailLoading(true);
    setPayForm({ amount: '', payment_date: new Date().toISOString().slice(0, 10), payment_method: 'CASH', note: '' });
    try {
      const data = await api(`/patient-charges/${patientId}/detail?month=${month}`);
      setDetail(data);
    } catch { }
    finally { setDetailLoading(false); }
  };

  // 수납 저장
  const savePayment = async () => {
    if (!payForm.amount || Number(payForm.amount) <= 0) return;
    setSaving(true);
    try {
      await api(`/patient-charges/${modalPatientId}/payments`, {
        method: 'POST',
        body: JSON.stringify({ ...payForm, amount: Number(payForm.amount), charge_month: month }),
      });
      const data = await api(`/patient-charges/${modalPatientId}/detail?month=${month}`);
      setDetail(data);
      setPayForm({ amount: '', payment_date: new Date().toISOString().slice(0, 10), payment_method: 'CASH', note: '' });
      loadSummary();
    } catch { }
    finally { setSaving(false); }
  };

  // 수납 삭제
  const deletePayment = async (paymentId: string) => {
    if (!confirm('이 수납 기록을 취소하시겠습니까?')) return;
    try {
      await api(`/patient-charges/payments/${paymentId}`, { method: 'DELETE' });
      const data = await api(`/patient-charges/${modalPatientId}/detail?month=${month}`);
      setDetail(data);
      loadSummary();
    } catch { }
  };

  const coveredCharges = (detail?.charges || []).filter((c: any) => c.category === 'COVERED');
  const ncCharges = (detail?.charges || []).filter((c: any) => c.category === 'NON_COVERED');

  return (
    <div>
      <PageHeader icon={CreditCard} title="수납관리" description="환자별 진료비 수납 및 미수금 관리" />

      {/* 필터 */}
      <div className="flex flex-wrap items-end gap-3 mb-5 no-print">
        <div>
          <label className="text-[11px] font-medium text-slate-500 block mb-1">청구월</label>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        {isAdmin && departments.length > 0 && (
          <div>
            <label className="text-[11px] font-medium text-slate-500 block mb-1">부서</label>
            <select value={deptId} onChange={e => setDeptId(e.target.value)}
              className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">전체</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {(['all', 'unpaid'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all
                ${tab === t ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
              {t === 'all' ? '전체' : '미수금만'}
            </button>
          ))}
        </div>
      </div>

      {/* 요약 카드 */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <BigKpi label="총 진료비" value={`₩${(summary.total_charge || 0).toLocaleString()}`} color="blue" />
          <BigKpi label="총 수납액" value={`₩${(summary.total_payment || 0).toLocaleString()}`} color="green" />
          <BigKpi label="총 미수금" value={`₩${(summary.total_unpaid || 0).toLocaleString()}`} color="red" />
          <BigKpi label="수납률" value={`${summary.payment_rate || 0}%`} color="teal" />
        </div>
      )}

      {/* 환자 목록 테이블 */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-4 py-2.5 text-left font-semibold text-slate-500">환자명</th>
                <th className="px-4 py-2.5 text-left font-semibold text-slate-500">병동</th>
                <th className="px-4 py-2.5 text-left font-semibold text-slate-500">보험유형</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-500">진료비</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-500">수납액</th>
                <th className="px-4 py-2.5 text-right font-semibold text-slate-500">미수금</th>
                <th className="px-4 py-2.5 text-center font-semibold text-slate-500">상태</th>
                <th className="px-4 py-2.5 text-center font-semibold text-slate-500 no-print">액션</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="text-center py-12 text-slate-400">로딩 중...</td></tr>
              ) : filteredRows.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-slate-400">데이터 없음</td></tr>
              ) : filteredRows.map(r => {
                const badge = STATUS_BADGE[r.status] || STATUS_BADGE.NONE;
                return (
                  <tr key={r.patient_id} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer" onClick={() => openDetail(r.patient_id)}>
                    <td className="px-4 py-2.5 font-medium text-slate-700">{r.name}</td>
                    <td className="px-4 py-2.5 text-slate-500">{r.department_name}</td>
                    <td className="px-4 py-2.5 text-slate-500">{INSURANCE_LABEL[r.insurance_type] || r.insurance_type}</td>
                    <td className="px-4 py-2.5 text-right font-medium">₩{r.total_charge.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-emerald-600">₩{r.total_payment.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-red-600">{r.unpaid > 0 ? `₩${r.unpaid.toLocaleString()}` : '-'}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                    </td>
                    <td className="px-4 py-2.5 text-center no-print">
                      <button onClick={e => { e.stopPropagation(); openDetail(r.patient_id); }}
                        className="px-2.5 py-1 bg-blue-600 text-white rounded-lg text-[10px] font-semibold hover:bg-blue-700 transition-colors">
                        수납처리
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 수납 처리 모달 ── */}
      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal max-w-2xl" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">수납 처리</h3>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="modal-body space-y-5">
              {detailLoading ? (
                <div className="text-center py-8 text-slate-400">로딩 중...</div>
              ) : detail ? (
                <>
                  {/* 환자 정보 */}
                  <div className="flex items-center gap-4 bg-gray-50 rounded-xl p-3">
                    <div>
                      <p className="text-sm font-bold text-slate-700">{detail.patient.name}</p>
                      <p className="text-xs text-slate-400">{detail.patient.patient_no} | {detail.patient.department?.name} | {INSURANCE_LABEL[detail.patient.insurance_type] || detail.patient.insurance_type}</p>
                    </div>
                    <div className="ml-auto text-right">
                      <p className="text-[10px] text-slate-400">청구월</p>
                      <p className="text-sm font-bold text-slate-700">{month}</p>
                    </div>
                  </div>

                  {/* 진료비 내역 */}
                  <div>
                    <p className="text-xs font-bold text-slate-600 mb-2">진료비 내역</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="border rounded-xl p-3">
                        <p className="text-[10px] font-semibold text-teal-600 mb-1.5">급여</p>
                        {coveredCharges.length === 0 ? <p className="text-xs text-slate-300">없음</p> :
                          coveredCharges.map((c: any) => (
                            <div key={c.id} className="flex justify-between py-1 text-xs border-b border-gray-50 last:border-0">
                              <span className="text-slate-600">{c.item_name}</span>
                              <span className="font-medium">₩{Number(c.amount).toLocaleString()}</span>
                            </div>
                          ))}
                      </div>
                      <div className="border rounded-xl p-3">
                        <p className="text-[10px] font-semibold text-amber-600 mb-1.5">비급여</p>
                        {ncCharges.length === 0 ? <p className="text-xs text-slate-300">없음</p> :
                          ncCharges.map((c: any) => (
                            <div key={c.id} className="flex justify-between py-1 text-xs border-b border-gray-50 last:border-0">
                              <span className="text-slate-600">{c.item_name}</span>
                              <span className="font-medium">₩{Number(c.amount).toLocaleString()}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>

                  {/* 수납 이력 */}
                  <div>
                    <p className="text-xs font-bold text-slate-600 mb-2">수납 이력</p>
                    {(detail.payments || []).length === 0 ? (
                      <p className="text-xs text-slate-300 text-center py-3">수납 기록 없음</p>
                    ) : (
                      <div className="border rounded-xl overflow-hidden">
                        <table className="w-full text-xs">
                          <thead><tr className="bg-gray-50 border-b">
                            <th className="px-3 py-2 text-left text-slate-500">수납일</th>
                            <th className="px-3 py-2 text-right text-slate-500">금액</th>
                            <th className="px-3 py-2 text-left text-slate-500">방법</th>
                            <th className="px-3 py-2 text-left text-slate-500">메모</th>
                            <th className="px-3 py-2 w-8"></th>
                          </tr></thead>
                          <tbody>
                            {(detail.payments || []).map((p: any) => (
                              <tr key={p.id} className="border-b border-gray-50">
                                <td className="px-3 py-2">{new Date(p.payment_date).toLocaleDateString('ko-KR')}</td>
                                <td className="px-3 py-2 text-right font-medium text-emerald-600">₩{Number(p.amount).toLocaleString()}</td>
                                <td className="px-3 py-2">{METHOD_LABEL[p.payment_method] || p.payment_method}</td>
                                <td className="px-3 py-2 text-slate-400">{p.note || '-'}</td>
                                <td className="px-3 py-2">
                                  <button onClick={() => deletePayment(p.id)} className="text-red-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* 신규 수납 입력 */}
                  <div className="bg-blue-50 rounded-xl p-4">
                    <p className="text-xs font-bold text-blue-700 mb-3 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> 신규 수납 입력</p>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">금액</label>
                        <input type="number" placeholder="0" value={payForm.amount}
                          onChange={e => setPayForm({ ...payForm, amount: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">수납일</label>
                        <input type="date" value={payForm.payment_date}
                          onChange={e => setPayForm({ ...payForm, payment_date: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">수납방법</label>
                        <select value={payForm.payment_method}
                          onChange={e => setPayForm({ ...payForm, payment_method: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                          <option value="CASH">현금</option>
                          <option value="CARD">카드</option>
                          <option value="TRANSFER">계좌이체</option>
                          <option value="OTHER">기타</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">메모</label>
                        <input type="text" placeholder="선택" value={payForm.note}
                          onChange={e => setPayForm({ ...payForm, note: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                    </div>
                    <button onClick={savePayment} disabled={saving || !payForm.amount}
                      className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50">
                      {saving ? '저장 중...' : '수납 등록'}
                    </button>
                  </div>

                  {/* 합계 */}
                  <div className="bg-slate-800 rounded-xl p-4 flex items-center justify-between text-white">
                    <div className="grid grid-cols-3 gap-6 flex-1">
                      <div>
                        <p className="text-[10px] text-slate-400">진료비 합계</p>
                        <p className="text-lg font-extrabold">₩{(detail.charge_total || 0).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">수납 합계</p>
                        <p className="text-lg font-extrabold text-emerald-400">₩{(detail.payment_total || 0).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">잔여 미수금</p>
                        <p className={`text-lg font-extrabold ${(detail.unpaid || 0) > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                          ₩{(detail.unpaid || 0).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-8 text-red-500">데이터를 불러올 수 없습니다.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
