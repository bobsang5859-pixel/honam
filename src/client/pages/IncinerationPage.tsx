import React, { useEffect, useState, useCallback } from 'react';
import { Flame, Search } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader, DataTable, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';

const toMonth = (d: Date) => d.toISOString().slice(0, 7);
const dayName = (dateStr: string) =>
  ['일', '월', '화', '수', '목', '금', '토'][new Date(`${dateStr}T00:00:00.000Z`).getUTCDay()];

export default function IncinerationPage() {
  const [entries, setEntries] = useState<any[]>([]);
  const [monthly, setMonthly] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 이력 조회 필터
  const [monthFrom, setMonthFrom] = useState(toMonth(new Date()));
  const [monthTo, setMonthTo] = useState(toMonth(new Date()));

  // kg 입력 폼
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [entryKg, setEntryKg] = useState('');
  const [entryNote, setEntryNote] = useState('');

  // 월 보정 폼
  const [overrideMonth, setOverrideMonth] = useState(toMonth(new Date()));
  const [overrideAmount, setOverrideAmount] = useState('');
  const [overrideNote, setOverrideNote] = useState('');

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const loadEntries = useCallback(async () => {
    const start = `${monthFrom}-01`;
    const end = `${monthTo}-31`;
    const rows = await api(`/patients/incineration-entries?from=${start}&to=${end}`);
    setEntries(Array.isArray(rows) ? rows : []);
  }, [monthFrom, monthTo]);

  const loadMonthly = useCallback(async () => {
    try {
      const p = new URLSearchParams({
        date_from: `${monthFrom}-01`,
        date_to: `${monthTo}-31`,
      });
      const data = await api(`/patients/stats?${p.toString()}`);
      setMonthly(data?.incineration?.monthly || []);
    } catch {
      setMonthly([]);
    }
  }, [monthFrom, monthTo]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadEntries(), loadMonthly()]);
    setLoading(false);
  }, [loadEntries, loadMonthly]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveEntry = async () => {
    if (!entryDate || entryKg === '') return;
    setSaving(true);
    try {
      await api('/patients/incineration-entries', {
        method: 'POST',
        body: JSON.stringify({ entry_date: entryDate, weight_kg: Number(entryKg), note: entryNote }),
      });
      setEntryKg('');
      setEntryNote('');
      showMsg('ok', '저장되었습니다.');
      await loadAll();
    } catch (e: any) {
      showMsg('err', e.message ?? '저장 실패');
    } finally {
      setSaving(false);
    }
  };

  const saveOverride = async () => {
    if (!overrideMonth) return;
    setSaving(true);
    try {
      await api(`/patients/incineration-monthly/${overrideMonth}`, {
        method: 'PUT',
        body: JSON.stringify({
          final_amount_override: overrideAmount === '' ? null : Number(overrideAmount),
          note: overrideNote,
        }),
      });
      setOverrideAmount('');
      setOverrideNote('');
      showMsg('ok', '보정 저장되었습니다.');
      await loadAll();
    } catch (e: any) {
      showMsg('err', e.message ?? '보정 저장 실패');
    } finally {
      setSaving(false);
    }
  };

  const monthlyColumns: Column<any>[] = [
    { key: 'month', header: '월', cardPosition: 'title', render: r => r.year_month },
    { key: 'kg', header: 'kg 합계', cardPosition: 'body', className: 'text-right', render: r => Number(r.kg_month_sum ?? 0).toLocaleString() },
    { key: 'auto', header: '자동금액', cardPosition: 'body', className: 'text-right', render: r => `${Number(r.auto_amount ?? 0).toLocaleString()}원` },
    { key: 'final', header: '최종금액', cardPosition: 'badge', className: 'text-right', render: r => `${Number(r.final_amount ?? 0).toLocaleString()}원` },
    { key: 'variance', header: '차이', cardPosition: 'hidden', className: 'text-right', render: r => `${Number(r.variance ?? 0).toLocaleString()}원` },
  ];

  const entryColumns: Column<any>[] = [
    { key: 'date', header: '일자', cardPosition: 'title', render: r => r.entry_date },
    { key: 'day', header: '요일', cardPosition: 'subtitle', className: 'text-center', render: r => dayName(r.entry_date) },
    { key: 'kg', header: 'kg', cardPosition: 'badge', className: 'text-right', render: r => Number(r.weight_kg ?? 0).toLocaleString() },
    { key: 'note', header: '비고', cardPosition: 'body', render: r => r.note || '-' },
  ];

  return (
    <div>
      <PageHeader
        icon={Flame}
        title="소각료 관리"
        description="의료폐기물 소각료 입력 및 월별 집계를 관리합니다."
      />

      {msg && (
        <div className={`mb-3 px-4 py-2.5 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}

      <div className="space-y-4">
        {/* 소각료 kg 입력 */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">소각료 kg 입력 (월/목)</h2>
          <div className="grid md:grid-cols-4 gap-2 items-end">
            <FormField label="일자">
              <input type="date" className="input" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            </FormField>
            <FormField label="kg">
              <input type="number" className="input" value={entryKg} onChange={(e) => setEntryKg(e.target.value)} />
            </FormField>
            <div className="md:col-span-2">
              <FormField label="비고">
                <input className="input" value={entryNote} onChange={(e) => setEntryNote(e.target.value)} />
              </FormField>
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <button disabled={saving} onClick={saveEntry} className="btn-primary">저장</button>
          </div>
        </div>

        {/* 월 최종금액 보정 */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">월 최종금액 보정</h2>
          <div className="grid md:grid-cols-3 gap-2 items-end">
            <FormField label="월">
              <input type="month" className="input" value={overrideMonth} onChange={(e) => setOverrideMonth(e.target.value)} />
            </FormField>
            <FormField label="최종금액(원)">
              <input type="number" className="input" value={overrideAmount} onChange={(e) => setOverrideAmount(e.target.value)} />
            </FormField>
            <FormField label="비고">
              <input className="input" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} />
            </FormField>
          </div>
          <div className="mt-2 flex justify-end">
            <button disabled={saving} onClick={saveOverride} className="btn-secondary">보정 저장</button>
          </div>
        </div>

        {/* 월 소각료 집계 */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">월 소각료 집계</h2>
          {loading ? (
            <EmptyState message="로딩 중..." />
          ) : (
            <DataTable
              columns={monthlyColumns}
              data={monthly}
              keyField={(r: any) => r.year_month}
              emptyMessage="데이터 없음"
            />
          )}
        </div>

        {/* 소각료 입력 이력 */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">소각료 입력 이력</h2>
          <div className="flex gap-2 mb-3">
            <input type="month" className="input w-40" value={monthFrom} onChange={(e) => setMonthFrom(e.target.value)} />
            <input type="month" className="input w-40" value={monthTo} onChange={(e) => setMonthTo(e.target.value)} />
            <button className="btn-secondary inline-flex items-center gap-1" onClick={loadAll}><Search className="w-3.5 h-3.5" />조회</button>
          </div>
          <DataTable
            columns={entryColumns}
            data={entries}
            keyField={(r: any) => r.id}
            emptyMessage="데이터 없음"
          />
        </div>
      </div>
    </div>
  );
}
