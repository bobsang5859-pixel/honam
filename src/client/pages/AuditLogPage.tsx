import React, { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import type { AuditLog } from '@shared/types';

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<AuditLog | null>(null);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    if (actionFilter) params.set('action', actionFilter);
    if (entityFilter) params.set('entity_type', entityFilter);
    api(`/audit-logs?${params}`)
      .then((data: any) => {
        setLogs(Array.isArray(data) ? data : data.logs || []);
        setTotal(Array.isArray(data) ? data.length : data.total || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, search, actionFilter, entityFilter]);

  return (
    <div>
      <PageHeader
        icon={ScrollText}
        title="감사 로그"
        description="시스템 내 모든 변경 이력 조회"
      />

      {/* Filters */}
      <div className="card mb-4 py-3">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="input w-48"
            placeholder="사용자/대상 검색"
          />
          <input
            type="text"
            value={actionFilter}
            onChange={e => { setActionFilter(e.target.value); setPage(1); }}
            className="input w-36"
            placeholder="액션 (예: CREATE)"
          />
          <input
            type="text"
            value={entityFilter}
            onChange={e => { setEntityFilter(e.target.value); setPage(1); }}
            className="input w-36"
            placeholder="엔티티 타입"
          />
        </div>
      </div>

      <div className="card p-0 overflow-hidden overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400 text-sm">로딩 중...</div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-400 text-sm">로그가 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>발생일시</th>
                <th>사용자</th>
                <th>역할</th>
                <th>액션</th>
                <th>엔티티</th>
                <th>대상 ID</th>
                <th>사유</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td className="text-xs text-slate-500 whitespace-nowrap">
                    {new Date(log.occurred_at).toLocaleString('ko-KR')}
                  </td>
                  <td className="text-sm font-medium">{log.actor_name}</td>
                  <td className="text-xs text-slate-500">{log.actor_role}</td>
                  <td>
                    <span className={`badge ${
                      log.action.includes('CREATE') ? 'badge-green' :
                      log.action.includes('UPDATE') ? 'badge-blue' :
                      log.action.includes('DELETE') ? 'badge-red' : 'badge-gray'
                    }`}>
                      {log.action}
                    </span>
                  </td>
                  <td className="text-xs text-slate-600">{log.entity_type}</td>
                  <td className="text-xs font-mono text-slate-400 max-w-[80px] truncate">{log.entity_id.slice(0, 8)}…</td>
                  <td className="text-xs text-slate-500 max-w-[120px] truncate">{log.reason || '-'}</td>
                  <td>
                    {(log.before_json || log.after_json) && (
                      <button onClick={() => setDetail(log)} className="text-xs text-accent-600 hover:underline">상세</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-2 mt-4">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary text-xs">이전</button>
          <span className="text-sm text-slate-600 self-center">{page} / {Math.ceil(total / limit)}</span>
          <button onClick={() => setPage(p => p + 1)} disabled={page * limit >= total} className="btn-secondary text-xs">다음</button>
        </div>
      )}

      {/* Detail Modal */}
      {detail && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">{detail.action} — {detail.entity_type}</h2>
              <button onClick={() => setDetail(null)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              <div className="text-sm text-slate-600">
                <span className="font-medium">{detail.actor_name}</span> ({detail.actor_role}) ·{' '}
                {new Date(detail.occurred_at).toLocaleString('ko-KR')}
              </div>
              {detail.reason && <div className="p-3 bg-yellow-50 rounded-lg text-sm text-yellow-800">사유: {detail.reason}</div>}
              {detail.before_json && (
                <div>
                  <div className="label mb-1">변경 전</div>
                  <pre className="bg-gray-50 rounded-lg p-3 text-xs overflow-x-auto">
                    {JSON.stringify(JSON.parse(detail.before_json), null, 2)}
                  </pre>
                </div>
              )}
              {detail.after_json && (
                <div>
                  <div className="label mb-1">변경 후</div>
                  <pre className="bg-gray-50 rounded-lg p-3 text-xs overflow-x-auto">
                    {JSON.stringify(JSON.parse(detail.after_json), null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => setDetail(null)} className="btn-secondary">닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
