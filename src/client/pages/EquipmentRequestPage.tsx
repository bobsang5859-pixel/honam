import React, { useEffect, useState, useCallback } from 'react';
import { Monitor } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui';
import type { WardRequest, Item } from '@shared/types';
import { EQUIPMENT_CATEGORIES } from '@shared/types';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '임시저장', SUBMITTED: '제출됨', APPROVED: '승인됨',
  PARTIAL_APPROVED: '일부승인', REJECTED: '반려됨', CANCELLED: '취소됨',
};
const STATUS_CLS: Record<string, string> = {
  DRAFT: 'badge-gray', SUBMITTED: 'badge-blue', APPROVED: 'badge-green',
  PARTIAL_APPROVED: 'badge-yellow', REJECTED: 'badge-red', CANCELLED: 'badge-gray',
};

// 비품 카테고리 계층 (대분류 → 중분류)
const EQUIPMENT_HIERARCHY = [
  { label: '의료장비', subs: [
    { label: '의료기기',     value: 'EQUIP_MEDICAL' },
    { label: '의료보조장비', value: 'EQUIP_AID' },
  ]},
  { label: '일반비품', subs: [
    { label: '사무용가구', value: 'EQUIP_FURNITURE' },
    { label: '가전제품',   value: 'EQUIP_APPLIANCE' },
  ]},
  { label: 'IT·안전', subs: [
    { label: '전산·IT장비',   value: 'EQUIP_IT' },
    { label: '안전·위생장비', value: 'EQUIP_SAFETY' },
  ]},
];

const today = () => new Date().toISOString().slice(0, 10);

const EQ_TYPES = [
  { value: 'DISPOSAL', label: '폐기', activeBg: 'bg-red-500',    inactiveBg: 'bg-red-50',    activeTxt: 'text-white', inactiveTxt: 'text-red-600',    border: 'border-red-300' },
  { value: 'ADDITION', label: '추가', activeBg: 'bg-blue-500',   inactiveBg: 'bg-blue-50',   activeTxt: 'text-white', inactiveTxt: 'text-blue-600',   border: 'border-blue-300' },
] as const;

const REASON_PRESETS: Record<string, string[]> = {
  DISPOSAL: ['노후 (사용연한 경과)', '파손', '고장수리불가', '분실', '오염/위생문제', '규격·모델 변경', '과다보유 정리'],
  ADDITION: ['신규 필요', '인원 증가', '병상 증가', '폐기 대체', '수량 부족', '시범 도입', '시설 확장'],
};

const EQ_TYPE_LABEL: Record<string, string> = { DISPOSAL: '폐기', ADDITION: '추가', REPAIR: '수리' };
const EQ_TYPE_BADGE: Record<string, string>  = { DISPOSAL: 'badge-red', ADDITION: 'badge-blue', REPAIR: 'badge-yellow' };

export default function EquipmentRequestPage() {
  const { user, hasPerm } = useAuth();
  const canCreate  = hasPerm('REQUEST_USE');
  const canViewAll = hasPerm('PURCHASE_MANAGE');

  // ── 페이지 탭 ─────────────────────────────────────────────
  const [pageTab, setPageTab] = useState<'create' | 'list'>(canCreate ? 'create' : 'list');

  // ── 신청현황 탭 state ─────────────────────────────────────
  const [requests, setRequests]         = useState<WardRequest[]>([]);
  const [loading, setLoading]           = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal]               = useState<'detail' | null>(null);
  const [detail, setDetail]             = useState<WardRequest | null>(null);

  // ── 비품 신청 탭 state ────────────────────────────────────
  const [items, setItems]       = useState<Item[]>([]);
  const [majorCat, setMajorCat] = useState<string | null>(null);
  const [subCat,   setSubCat]   = useState<string | null>(null);
  const [qtys, setQtys]         = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    is_emergency:   false,
    equipment_type: '' as string,
    reason:         '' as string,
  });

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const focusNextRowInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const td = e.currentTarget.closest('td');
    const tr = e.currentTarget.closest('tr');
    const table = e.currentTarget.closest('table');
    if (!td || !tr || !table) return;
    const col = (td as HTMLTableCellElement).cellIndex;
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const idx = rows.indexOf(tr as HTMLTableRowElement);
    for (let i = idx + 1; i < rows.length; i++) {
      const rowEl = rows[i] as HTMLTableRowElement;
      const next = rowEl.cells[col]?.querySelector('input[type="number"]') as HTMLInputElement | null;
      if (next && !next.disabled) {
        next.focus();
        next.select();
        break;
      }
    }
  };
  const showMsg = (type: 'ok' | 'err', text: string) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  // 사진 첨부
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await api('/ward-requests/upload-attachment', { method: 'POST', body: fd });
        setAttachments(prev => [...prev, res.url]);
      }
    } catch (err: any) { showMsg('err', err.message || '업로드 실패'); }
    finally { setUploading(false); e.target.value = ''; }
  };

  const removeAttachment = async (url: string) => {
    try {
      await api('/ward-requests/delete-attachment', { method: 'DELETE', body: JSON.stringify({ url }) });
    } catch { /* ignore */ }
    setAttachments(prev => prev.filter(u => u !== url));
  };

  // 이미지 hover 미리보기 / 확대
  const [hoverImg, setHoverImg]     = useState<{ url: string; x: number; y: number } | null>(null);
  const [enlargeImg, setEnlargeImg] = useState<string | null>(null);

  const equipCatValues = EQUIPMENT_CATEGORIES.map(c => c.value);

  // ── 데이터 로드 ───────────────────────────────────────────
  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    p.set('type', 'EQUIPMENT');
    if (filterStatus) p.set('status', filterStatus);
    api(`/ward-requests?${p}`).then(setRequests).catch(console.error).finally(() => setLoading(false));
  }, [filterStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canCreate) return; // 신청 권한 없으면 품목 로드하지 않음
    Promise.all([
      api('/items?is_active=true'),
      api('/dept-permissions/my-items').catch(() => ({ item_ids: null })),
    ]).then(([allItems, permData]) => {
      const item_ids: string[] | null = permData?.item_ids ?? null;
      const equipItems = allItems.filter((i: any) => equipCatValues.includes(i.category ?? ''));
      setItems(item_ids && item_ids.length > 0
        ? equipItems.filter((i: any) => item_ids.includes(i.id))
        : equipItems);
    }).catch(() => {});
  }, [canCreate]);

  // ── 카테고리 드릴다운 ─────────────────────────────────────
  const clickMajor = (label: string) => {
    setMajorCat(prev => prev === label ? null : label);
    setSubCat(null);
  };
  const clickSub = (value: string) => {
    setSubCat(prev => prev === value ? null : value);
  };

  const currentSubs  = EQUIPMENT_HIERARCHY.find(g => g.label === majorCat)?.subs ?? [];
  const visibleItems = subCat ? items.filter(i => (i as any).category === subCat) : [];

  const pendingCount = items.filter(i => (qtys[i.id] ?? 0) > 0).length;

  // ── 제출 ──────────────────────────────────────────────────
  const handleSubmit = async () => {
    const itemsToSubmit = items
      .filter(i => (qtys[i.id] ?? 0) > 0)
      .map(i => ({ item_id: i.id, requested_qty: qtys[i.id], note: '' }));

    if (itemsToSubmit.length === 0) {
      showMsg('err', '1개 이상 품목에 수량을 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await api('/ward-requests', {
        method: 'POST',
        body: JSON.stringify({
          period_type:            'MONTHLY',
          period_start:           today(),
          period_end:             today(),
          is_emergency:           form.is_emergency,
          request_type:           'EQUIPMENT',
          equipment_request_type: form.equipment_type || null,
          note:                   form.reason || null,
          attachment_urls:        attachments,
          items: itemsToSubmit,
        }),
      });
      await api(`/ward-requests/${created.id}/submit`, { method: 'POST' });
      showMsg('ok', '비품 신청이 제출되었습니다.');
      setQtys({});
      setMajorCat(null);
      setSubCat(null);
      setForm({ is_emergency: false, equipment_type: '', reason: '' });
      setAttachments([]);
      setPageTab('list');
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── 상세보기 / 취소 ───────────────────────────────────────
  const openDetail = async (id: string) => {
    try { setDetail(await api(`/ward-requests/${id}`)); setModal('detail'); }
    catch (e: any) { showMsg('err', e.message); }
  };
  const cancelRequest = async (id: string) => {
    if (!confirm('신청을 취소하시겠습니까?')) return;
    try {
      await api(`/ward-requests/${id}/cancel`, { method: 'POST' });
      showMsg('ok', '취소되었습니다.'); setModal(null); load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  return (
    <div>
      {/* ── 페이지 헤더 ── */}
      <PageHeader
        icon={Monitor}
        title="비품 신청"
        description={canViewAll ? '전체 비품 신청 현황' : `${user?.department_name} 비품 신청 관리`}
      />

      {/* ── 탭 바 ── */}
      <div className="flex border-b border-gray-200 mb-5">
        {canCreate && (
          <button
            onClick={() => setPageTab('create')}
            className={`px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${pageTab === 'create' ? 'border-purple-500 text-purple-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            비품 신청
          </button>
        )}
        <button
          onClick={() => setPageTab('list')}
          className={`px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${pageTab === 'list' ? 'border-purple-500 text-purple-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          신청현황
        </button>
      </div>

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {/* ══════════════════════════════════════════
          비품 신청 탭
      ══════════════════════════════════════════ */}
      {pageTab === 'create' && canCreate && (
        <div className="space-y-5">
          {/* 신청유형 + 사유 + 사진첨부 */}
          <div className="card p-5 space-y-5">
            {/* 신청유형 */}
            <div>
              <label className="label">신청 유형</label>
              <div className="flex gap-2">
                {EQ_TYPES.map(t => {
                  const isActive = form.equipment_type === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setForm(f => ({
                        ...f,
                        equipment_type: isActive ? '' : t.value,
                        reason: isActive ? '' : f.reason,
                      }))}
                      className={`px-5 py-2 rounded-lg text-sm font-semibold border transition-all ${
                        isActive
                          ? `${t.activeBg} ${t.activeTxt} border-transparent`
                          : `${t.inactiveBg} ${t.inactiveTxt} ${t.border}`
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 사유 (신청유형 선택 시) */}
            {form.equipment_type && (
              <div>
                <label className="label">사유</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {REASON_PRESETS[form.equipment_type]?.map(r => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, reason: f.reason === r ? '' : r }))}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                        form.reason === r
                          ? 'bg-gray-700 text-white border-gray-700'
                          : 'bg-white text-slate-600 border-gray-300 hover:border-gray-500'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <input
                  className="input"
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="직접 입력 가능"
                />
              </div>
            )}

            {/* 사진 첨부 */}
            <div>
              <label className="label">사진 첨부</label>
              <div className="flex flex-wrap gap-2 items-start">
                {attachments.map((url, idx) => (
                  <div key={idx} className="relative group w-20 h-20 rounded-lg overflow-hidden border border-gray-200">
                    <img
                      src={url}
                      alt=""
                      className="w-full h-full object-cover cursor-pointer"
                      onClick={() => setEnlargeImg(url)}
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(url)}
                      className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 text-white rounded-full text-xs leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      &times;
                    </button>
                  </div>
                ))}
                <label className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-300 flex flex-col items-center justify-center cursor-pointer hover:border-purple-400 hover:bg-purple-50 transition-colors">
                  <span className="text-xl text-slate-400">+</span>
                  <span className="text-[10px] text-slate-400">{uploading ? '업로드중' : '사진추가'}</span>
                  <input type="file" accept="image/*" multiple onChange={handleFileUpload} className="hidden" disabled={uploading} />
                </label>
              </div>
            </div>

          </div>

          {/* 카테고리 드릴다운 */}
          <div className="card p-5 space-y-3">
            {/* 대분류 */}
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">대분류</p>
              <div className="flex gap-2 flex-wrap">
                {EQUIPMENT_HIERARCHY.map(g => {
                  const totalCount = g.subs.reduce((acc, s) => acc + items.filter(i => (i as any).category === s.value).length, 0);
                  const isActive   = majorCat === g.label;
                  const isEmpty    = totalCount === 0;
                  return (
                    <button
                      key={g.label}
                      onClick={() => !isEmpty && clickMajor(g.label)}
                      disabled={isEmpty}
                      className="px-5 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{
                        background: isActive ? '#7c3aed' : '#f1f5f9',
                        color: isActive ? 'white' : isEmpty ? '#94a3b8' : '#475569',
                        opacity: isEmpty ? 0.4 : 1,
                        cursor: isEmpty ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {g.label}
                      <span className="ml-1.5 text-xs opacity-70">({totalCount})</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 중분류 (대분류 선택 시) */}
            {majorCat && currentSubs.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">중분류</p>
                <div className="flex gap-2 flex-wrap">
                  {currentSubs.map(s => {
                    const cnt      = items.filter(i => (i as any).category === s.value).length;
                    const isActive = subCat === s.value;
                    const isEmpty  = cnt === 0;
                    return (
                      <button
                        key={s.value}
                        onClick={() => !isEmpty && clickSub(s.value)}
                        disabled={isEmpty}
                        className="px-4 py-1.5 rounded-full text-sm font-medium border transition-all"
                        style={{
                          background:  isActive ? '#7c3aed' : 'white',
                          color:       isActive ? 'white' : isEmpty ? '#94a3b8' : '#7c3aed',
                          borderColor: isActive ? '#7c3aed' : isEmpty ? '#e2e8f0' : '#7c3aed',
                          opacity:     isEmpty ? 0.4 : 1,
                          cursor:      isEmpty ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {s.label}
                        <span className="ml-1.5 text-xs opacity-75">({cnt})</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 품목 테이블 */}
          <div className="card p-0 overflow-hidden">
            {!majorCat ? (
              <div className="text-center py-14 text-slate-400 text-sm">
                위에서 대분류를 선택하세요
              </div>
            ) : !subCat ? (
              <div className="text-center py-14 text-slate-400 text-sm">
                중분류를 선택하면 품목이 표시됩니다
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="text-center py-14 text-slate-400 text-sm">
                해당 분류의 품목이 없습니다
              </div>
            ) : (
              <div className="overflow-x-auto" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                <table className="tbl">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr>
                      <th>품목코드</th>
                      <th>품목명</th>
                      <th>단위</th>
                      <th className="text-right">현재재고</th>
                      <th className="text-right">신청수량</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map(item => {
                      const qty    = qtys[item.id] ?? 0;
                      const hasQty = qty > 0;
                      return (
                        <tr key={item.id} className={hasQty ? 'bg-purple-50/60' : ''}>
                          <td className="font-mono text-xs text-slate-400">{item.item_code}</td>
                          <td
                            className="font-medium text-sm"
                            style={item.image_url ? { cursor: 'pointer' } : {}}
                            onMouseEnter={item.image_url ? (e) => {
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setHoverImg({ url: item.image_url!, x: rect.right + 10, y: rect.top });
                            } : undefined}
                            onMouseLeave={() => setHoverImg(null)}
                            onClick={item.image_url ? () => { setHoverImg(null); setEnlargeImg(item.image_url!); } : undefined}
                          >
                            {item.image_url && <span className="inline-block w-1.5 h-1.5 bg-purple-400 rounded-full mr-1.5 align-middle" />}
                            {item.name}
                          </td>
                          <td className="text-xs text-slate-500">{item.uom}</td>
                          <td className="text-right text-sm">
                            <span className={(item.on_hand_qty ?? 0) === 0 ? 'text-red-400' : 'text-slate-600'}>
                              {item.on_hand_qty ?? 0}
                            </span>
                          </td>
                          <td className="text-right">
                            <input
                              type="number" min="0"
                              value={qty === 0 ? '' : qty}
                              placeholder="0"
                              onKeyDown={focusNextRowInput}
                              onChange={e => {
                                const v = Number(e.target.value);
                                setQtys(prev => ({ ...prev, [item.id]: v < 0 ? 0 : v }));
                              }}
                              className="input w-20 text-right"
                              style={hasQty ? { borderColor: '#7c3aed', background: '#faf5ff' } : {}}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 하단 요약 + 제출 */}
          <div className="flex items-center justify-between p-4 bg-white rounded-xl border border-gray-200">
            <span className="text-sm text-slate-500">
              신청 예정:&nbsp;
              <span className="font-semibold text-purple-600">{pendingCount}건</span>
              {pendingCount > 0 && (
                <button
                  onClick={() => setQtys({})}
                  className="ml-3 text-xs text-slate-400 hover:text-red-500 underline"
                >
                  전체 초기화
                </button>
              )}
            </span>
            <button
              onClick={handleSubmit}
              disabled={submitting || pendingCount === 0}
              className="btn-primary"
            >
              {submitting ? '처리 중...' : '신청 제출'}
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          신청현황 탭
      ══════════════════════════════════════════ */}
      {pageTab === 'list' && (
        <>
          <div className="flex justify-end mb-3">
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input w-36 text-sm">
              <option value="">전체 상태</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="card p-0 overflow-hidden overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-slate-400 text-sm">로딩 중...</div>
            ) : requests.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-slate-400 text-sm">비품 신청 내역이 없습니다.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>신청번호</th>
                    {canViewAll && <th>부서</th>}
                    <th>품목수</th>
                    <th>상태</th>
                    <th>제출일</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.id}>
                      <td className="font-medium text-accent-600">{r.request_no}</td>
                      {canViewAll && <td className="text-xs">{r.department_name}</td>}
                      <td>{r.items?.length ?? 0}건</td>
                      <td>
                        {(r as any).equipment_request_type && (
                          <span className={`${EQ_TYPE_BADGE[(r as any).equipment_request_type] ?? 'badge-gray'} mr-1`}>
                            {EQ_TYPE_LABEL[(r as any).equipment_request_type] ?? (r as any).equipment_request_type}
                          </span>
                        )}
                        {r.is_emergency && <span className="badge-red mr-1">긴급</span>}
                        <span className={STATUS_CLS[r.status] || 'badge-gray'}>{STATUS_LABEL[r.status] || r.status}</span>
                      </td>
                      <td className="text-xs text-slate-400">
                        {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('ko-KR') : '-'}
                      </td>
                      <td>
                        <button onClick={() => openDetail(r.id)} className="text-xs text-accent-600 hover:underline">상세보기</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* 상세보기 모달 */}
      {modal === 'detail' && detail && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal w-full max-w-3xl">
            <div className="modal-header">
              <div>
                <h2 className="modal-title">{detail.request_no}</h2>
                <div className="flex items-center gap-2 mt-1">
                  {(detail as any).equipment_request_type && (
                    <span className={EQ_TYPE_BADGE[(detail as any).equipment_request_type] ?? 'badge-gray'}>
                      {EQ_TYPE_LABEL[(detail as any).equipment_request_type] ?? (detail as any).equipment_request_type}
                    </span>
                  )}
                  {detail.is_emergency && <span className="badge-red">긴급</span>}
                  <span className={STATUS_CLS[detail.status] || 'badge-gray'}>{STATUS_LABEL[detail.status] || detail.status}</span>
                  <span className="text-xs text-slate-400">{detail.department_name}</span>
                </div>
              </div>
              <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
            </div>
            <div className="modal-body">
              {/* 신청유형 + 사유 */}
              {((detail as any).equipment_request_type || (detail as any).note) && (
                <div className="mb-4 p-3 bg-purple-50 rounded-lg text-sm border border-purple-100">
                  {(detail as any).equipment_request_type && (
                    <span className={`${EQ_TYPE_BADGE[(detail as any).equipment_request_type] ?? 'badge-gray'} mr-2`}>
                      {EQ_TYPE_LABEL[(detail as any).equipment_request_type] ?? (detail as any).equipment_request_type}
                    </span>
                  )}
                  {(detail as any).note && (
                    <span className="text-slate-700">
                      <span className="font-medium text-slate-800">사유: </span>{(detail as any).note}
                    </span>
                  )}
                </div>
              )}
              {detail.last_action && (
                <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm">
                  <span className="font-medium">{detail.last_action.approver_name}</span>
                  <span className="text-slate-500 mx-1">·</span>
                  <span className="text-slate-600">{detail.last_action.action}</span>
                  {detail.last_action.reason && <span className="text-slate-500 ml-2">— {detail.last_action.reason}</span>}
                </div>
              )}
              {/* 첨부사진 */}
              {(detail as any).attachment_urls?.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-slate-500 mb-2">첨부사진</p>
                  <div className="flex flex-wrap gap-2">
                    {(detail as any).attachment_urls.map((url: string, idx: number) => (
                      <img
                        key={idx}
                        src={url}
                        alt=""
                        className="w-20 h-20 object-cover rounded-lg border border-gray-200 cursor-pointer hover:opacity-80"
                        onClick={() => setEnlargeImg(url)}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>품목명</th>
                      <th className="text-right">신청수량</th>
                      <th className="text-right">승인수량</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items?.map(item => (
                      <tr key={item.id || item.item_id}>
                        <td>
                          <div className="font-medium text-sm">{item.item_name}</div>
                          <div className="text-xs text-slate-400">{item.item_code} · {item.uom}</div>
                        </td>
                        <td className="text-right font-medium">{item.requested_qty}</td>
                        <td className="text-right">
                          {item.approved_qty !== undefined && item.approved_qty !== null
                            ? <span className="font-medium text-green-600">{item.approved_qty}</span>
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modal-footer">
              {canCreate && detail.status === 'DRAFT' && (
                <button onClick={() => cancelRequest(detail.id)} className="btn-danger mr-auto">취소</button>
              )}
              <button onClick={() => setModal(null)} className="btn-secondary">닫기</button>
            </div>
          </div>
        </div>
      )}
      {/* 이미지 hover 미리보기 (fixed 오버레이) */}
      {hoverImg && (
        <div
          className="fixed z-50 pointer-events-none rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
          style={{ left: hoverImg.x, top: hoverImg.y, width: 160, height: 160 }}
        >
          <img src={hoverImg.url} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
      )}

      {/* 이미지 확대 모달 */}
      {enlargeImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setEnlargeImg(null)}
        >
          <img
            src={enlargeImg}
            alt=""
            loading="lazy"
            className="max-w-[80vw] max-h-[80vh] rounded-xl shadow-2xl object-contain"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
