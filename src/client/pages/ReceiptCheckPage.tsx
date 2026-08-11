import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import type {
  StockOutFollowUpLite,
  StockOutReceiptConfirmResponse,
  StockOutReceiptDetail,
  StockOutReceiptQueueResponse,
} from '@shared/types';

const STATUS_LABEL: Record<string, string> = {
  RECEIPT_PENDING: '수령검수 대기',
  RECEIPT_CONFIRMED: '수령확정',
  RECEIPT_DIFF: '차이확정',
  REVERSED: '역전',
  POSTED: '불출완료',
};

const STATUS_CLS: Record<string, string> = {
  RECEIPT_PENDING: 'badge-blue',
  RECEIPT_CONFIRMED: 'badge-green',
  RECEIPT_DIFF: 'badge-yellow',
  REVERSED: 'badge-red',
  POSTED: 'badge-gray',
};

const FOLLOW_UP_STATUS_CLS: Record<string, string> = {
  OPEN: 'badge-orange',
  RESOLVED: 'badge-green',
  CANCELLED: 'badge-gray',
};

const FOLLOW_UP_ACTION_LABEL: Record<string, string> = {
  ISSUE_ADD: '추가불출',
  COLLECT_BACK: '회수',
};

function fmt(value: number): string {
  return new Intl.NumberFormat('ko-KR').format(value);
}

function parseNumericInput(value: string): number {
  const onlyDigits = String(value ?? '').replace(/[^\d]/g, '');
  if (!onlyDigits) return 0;
  const n = Number(onlyDigits);
  return Number.isFinite(n) ? n : 0;
}

const EMPTY_QUEUE: StockOutReceiptQueueResponse = {
  meta: {
    pending_count: 0,
    overdue_count: 0,
    total_count: 0,
  },
  rows: [],
};

export default function ReceiptCheckPage() {
  const { hasPerm } = useAuth();
  const canFilterByDepartment = hasPerm('SYSTEM_ADMIN');

  const [queue, setQueue] = useState<StockOutReceiptQueueResponse>(EMPTY_QUEUE);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState<any[]>([]);

  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [receiptDetail, setReceiptDetail] = useState<StockOutReceiptDetail | null>(null);
  const [receiptQtyDrafts, setReceiptQtyDrafts] = useState<Record<string, string>>({});
  const [receiptNoteDrafts, setReceiptNoteDrafts] = useState<Record<string, string>>({});
  const [savingDraft, setSavingDraft] = useState(false);
  const [confirmingReceipt, setConfirmingReceipt] = useState(false);

  const [followUps, setFollowUps] = useState<StockOutFollowUpLite[]>([]);
  const [loadingFollowUps, setLoadingFollowUps] = useState(false);

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3500);
  };

  const loadQueue = useCallback(() => {
    setLoadingQueue(true);
    const params = new URLSearchParams();
    params.set('status', 'RECEIPT_PENDING,RECEIPT_DIFF');
    if (overdueOnly) params.set('overdue_only', 'true');
    if (canFilterByDepartment && departmentId) params.set('department_id', departmentId);
    const query = params.toString();
    api(`/receipt-check${query ? `?${query}` : ''}`)
      .then((data) => setQueue(data || EMPTY_QUEUE))
      .catch(() => setQueue(EMPTY_QUEUE))
      .finally(() => setLoadingQueue(false));
  }, [canFilterByDepartment, departmentId, overdueOnly]);

  const loadFollowUps = useCallback(async (stockOutId: string) => {
    setLoadingFollowUps(true);
    try {
      const rows: StockOutFollowUpLite[] = await api(`/receipt-check/${stockOutId}/follow-ups`);
      setFollowUps(rows || []);
    } catch {
      setFollowUps([]);
    } finally {
      setLoadingFollowUps(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!canFilterByDepartment) return;
    api('/departments').then((rows) => setDepartments(rows || [])).catch(() => setDepartments([]));
  }, [canFilterByDepartment]);

  const queueRows = useMemo(() => queue.rows ?? [], [queue.rows]);

  const openReceiptDetail = async (id: string) => {
    try {
      const data: StockOutReceiptDetail = await api(`/receipt-check/${id}`);
      const qty: Record<string, string> = {};
      const note: Record<string, string> = {};
      for (const line of data.items) {
        qty[line.item_id] = line.received_qty == null ? '' : fmt(Number(line.received_qty));
        note[line.item_id] = line.receipt_note ?? '';
      }
      setReceiptQtyDrafts(qty);
      setReceiptNoteDrafts(note);
      setReceiptDetail(data);
      setReceiptModalOpen(true);
      await loadFollowUps(data.id);
    } catch (e: any) {
      showMsg('err', e.message || '검수 상세 조회 실패');
    }
  };

  const fillReceiptQtyAsIssued = () => {
    if (!receiptDetail) return;
    const qty: Record<string, string> = {};
    for (const line of receiptDetail.items) qty[line.item_id] = fmt(Number(line.issued_qty || 0));
    setReceiptQtyDrafts(qty);
  };

  const saveReceiptDraft = async (rethrow = false, silent = false) => {
    if (!receiptDetail) return;
    setSavingDraft(true);
    try {
      for (const line of receiptDetail.items) {
        const raw = receiptQtyDrafts[line.item_id] ?? '';
        if (!raw.trim()) throw new Error(`실수령수량 입력 필요 (${line.item_name ?? line.item_id})`);
        await api(`/receipt-check/${receiptDetail.id}/lines/${line.item_id}`, {
          method: 'POST',
          body: JSON.stringify({
            received_qty: parseNumericInput(raw),
            receipt_note: String(receiptNoteDrafts[line.item_id] ?? '').trim(),
          }),
        });
      }
      const refreshed: StockOutReceiptDetail = await api(`/receipt-check/${receiptDetail.id}`);
      setReceiptDetail(refreshed);
      await loadFollowUps(refreshed.id);
      loadQueue();
      if (!silent) showMsg('ok', '검수 임시저장 완료');
    } catch (e: any) {
      const message = e.message || '검수 임시저장 실패';
      if (rethrow) throw new Error(message);
      showMsg('err', message);
    } finally {
      setSavingDraft(false);
    }
  };

  const confirmReceipt = async () => {
    if (!receiptDetail) return;
    setConfirmingReceipt(true);
    try {
      await saveReceiptDraft(true, true);
      const result: StockOutReceiptConfirmResponse = await api(`/receipt-check/${receiptDetail.id}/confirm`, { method: 'POST' });
      loadQueue();
      showMsg('ok', result.follow_up_count > 0 ? `검수확정 완료 (후속작업 ${fmt(result.follow_up_count)}건 생성)` : '검수확정 완료');
      // 확정 완료 후 모달 닫기 (목록으로 복귀)
      setReceiptModalOpen(false);
      setReceiptDetail(null);
    } catch (e: any) {
      showMsg('err', e?.message || '검수확정 실패');
    } finally {
      setConfirmingReceipt(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={ClipboardCheck}
        title="수령 검수"
        description="불출 후 부서 수령검수 전용 화면"
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">검수대기</p>
          <p className="text-xl font-bold text-navy-800">{fmt(Number(queue.meta?.pending_count ?? 0))}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">SLA 지연(24h)</p>
          <p className="text-xl font-bold text-red-600">{fmt(Number(queue.meta?.overdue_count ?? 0))}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">조회건수</p>
          <p className="text-xl font-bold text-navy-800">{fmt(Number(queueRows.length || 0))}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">전체대상</p>
          <p className="text-xl font-bold text-navy-800">{fmt(Number(queue.meta?.total_count ?? 0))}</p>
        </div>
      </div>

      <div className="card mb-4">
        <div className="flex flex-wrap items-end gap-3">
          {canFilterByDepartment && (
            <div>
              <label className="label">부서</label>
              <select className="input min-w-[180px]" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">전체 부서</option>
                {departments.map((dept: any) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
              </select>
            </div>
          )}
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
            지연만 보기
          </label>
          <button className="btn-secondary" onClick={loadQueue}>새로고침</button>
        </div>
      </div>

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      <div className="card p-0 overflow-hidden overflow-x-auto">
        {loadingQueue ? (
          <div className="py-16 text-center text-sm text-slate-400">로딩 중...</div>
        ) : queueRows.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">검수 대상이 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>불출번호</th>
                <th>부서</th>
                <th>불출일</th>
                <th>SLA 마감</th>
                <th>상태</th>
                <th className="text-right">차이건수</th>
                <th className="text-right">품목수</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queueRows.map((row) => (
                <tr key={row.id} className={row.is_overdue ? 'bg-red-50/60' : ''}>
                  <td className="font-medium text-accent-600">{row.so_no}</td>
                  <td>{row.department_name || '-'}</td>
                  <td className="text-xs text-slate-500">{new Date(row.issued_at).toLocaleString('ko-KR')}</td>
                  <td className={`text-xs ${row.is_overdue ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>
                    {new Date(row.sla_due_at).toLocaleString('ko-KR')}
                    {row.is_overdue && <span className="ml-2 badge-red">지연</span>}
                  </td>
                  <td><span className={STATUS_CLS[row.status] || 'badge-gray'}>{STATUS_LABEL[row.status] || row.status}</span></td>
                  <td className="text-right">{fmt(Number(row.receipt_diff_count || 0))}</td>
                  <td className="text-right">{fmt(Number(row.item_count || 0))}</td>
                  <td className="text-right">
                    <button className="text-xs text-accent-600 hover:underline" onClick={() => openReceiptDetail(row.id)}>
                      검수
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {receiptModalOpen && receiptDetail && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setReceiptModalOpen(false); }}>
          <div className="modal w-full max-w-6xl">
            <div className="modal-header">
              <h2 className="modal-title">수령검수 - {receiptDetail.so_no}</h2>
              <button onClick={() => setReceiptModalOpen(false)} className="text-gray-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div><span className="label">부서</span><p>{receiptDetail.department_name}</p></div>
                <div><span className="label">불출일</span><p>{new Date(receiptDetail.issued_at).toLocaleDateString('ko-KR')}</p></div>
                <div><span className="label">상태</span><span className={STATUS_CLS[receiptDetail.status] || 'badge-gray'}>{STATUS_LABEL[receiptDetail.status] || receiptDetail.status}</span></div>
                <div><span className="label">차이건수</span><p>{fmt(Number(receiptDetail.receipt_diff_count || 0))}</p></div>
              </div>

              <div className="flex justify-end">
                <button className="btn-secondary" onClick={fillReceiptQtyAsIssued}>불출수량 동일입력</button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="tbl">
                  <thead><tr><th>품목</th><th className="text-right">불출수량</th><th className="text-right">실수령수량</th><th className="text-right">차이</th><th>차이 사유</th></tr></thead>
                  <tbody>
                    {receiptDetail.items.map((line) => {
                      const raw = receiptQtyDrafts[line.item_id] ?? '';
                      const issuedQty = Number(line.issued_qty || 0);
                      const receivedQty = raw.trim() === '' ? Number(line.received_qty ?? 0) : parseNumericInput(raw);
                      const diff = receivedQty - issuedQty;
                      return (
                        <tr key={line.item_id} className={diff !== 0 ? 'bg-yellow-50/60' : ''}>
                          <td>
                            <div className="font-medium text-sm">{line.item_name}</div>
                            <div className="text-xs text-slate-400">{line.item_code} · {line.uom}</div>
                          </td>
                          <td className="text-right">{fmt(issuedQty)}</td>
                          <td className="text-right">
                            <input
                              type="text"
                              inputMode="numeric"
                              className="input w-28 text-right inline-block"
                              value={raw}
                              onFocus={() => setReceiptQtyDrafts((prev) => ({ ...prev, [line.item_id]: String(parseNumericInput(prev[line.item_id] ?? '')) }))}
                              onChange={(e) => setReceiptQtyDrafts((prev) => ({ ...prev, [line.item_id]: e.target.value.replace(/[^\d]/g, '') }))}
                              onBlur={() => setReceiptQtyDrafts((prev) => ({ ...prev, [line.item_id]: fmt(parseNumericInput(prev[line.item_id] ?? '')) }))}
                            />
                          </td>
                          <td className={`text-right font-semibold ${diff === 0 ? 'text-slate-700' : diff > 0 ? 'text-blue-700' : 'text-red-600'}`}>
                            {diff > 0 ? '+' : ''}{fmt(diff)}
                          </td>
                          <td>
                            <input
                              className="input"
                              placeholder="차이 발생 시 사유 입력"
                              value={receiptNoteDrafts[line.item_id] ?? ''}
                              onChange={(e) => setReceiptNoteDrafts((prev) => ({ ...prev, [line.item_id]: e.target.value }))}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-sm text-navy-800">차이 후속작업 상태 (읽기전용)</h3>
                  <button className="text-xs text-accent-600 hover:underline" onClick={() => loadFollowUps(receiptDetail.id)}>새로고침</button>
                </div>
                {loadingFollowUps ? (
                  <div className="py-8 text-center text-sm text-slate-400">로딩 중...</div>
                ) : followUps.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">후속작업이 없습니다.</div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="tbl">
                      <thead><tr><th>품목</th><th>유형</th><th className="text-right">차이수량</th><th>상태</th><th>메모</th><th>생성일</th></tr></thead>
                      <tbody>
                        {followUps.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <div className="font-medium text-sm">{row.item_name || row.item_id}</div>
                              <div className="text-xs text-slate-400">{row.item_code || ''}</div>
                            </td>
                            <td>{FOLLOW_UP_ACTION_LABEL[row.action_type] || row.action_type}</td>
                            <td className="text-right">{fmt(Number(row.diff_qty || 0))}</td>
                            <td><span className={FOLLOW_UP_STATUS_CLS[row.status] || 'badge-gray'}>{row.status}</span></td>
                            <td className="text-xs text-slate-500">{row.note || '-'}</td>
                            <td className="text-xs text-slate-500">{new Date(row.created_at).toLocaleDateString('ko-KR')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" disabled={savingDraft || confirmingReceipt} onClick={() => { void saveReceiptDraft(); }}>검수 임시저장</button>
              <button className="btn-primary" disabled={savingDraft || confirmingReceipt} onClick={confirmReceipt}>{confirmingReceipt ? '확정 중...' : '검수확정'}</button>
              <button className="btn-secondary" onClick={() => setReceiptModalOpen(false)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
