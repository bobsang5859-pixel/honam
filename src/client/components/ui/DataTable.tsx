import React, { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import EmptyState from './EmptyState';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  className?: string;
  /** 모바일 카드에서 표시할 위치 */
  cardPosition?: 'title' | 'subtitle' | 'badge' | 'body' | 'hidden';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyField: keyof T | ((row: T) => string);
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
}

export default function DataTable<T>({ columns, data, keyField, onRowClick, emptyMessage }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const getKey = (row: T) => {
    if (typeof keyField === 'function') return keyField(row);
    return String(row[keyField]);
  };

  const handleSort = (col: Column<T>) => {
    if (!col.sortable) return;
    if (sortKey === col.key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(col.key);
      setSortAsc(true);
    }
  };

  let sorted = [...data];
  if (sortKey) {
    const col = columns.find(c => c.key === sortKey);
    if (col?.sortValue) {
      sorted.sort((a, b) => {
        const va = col.sortValue!(a);
        const vb = col.sortValue!(b);
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ko');
        return sortAsc ? cmp : -cmp;
      });
    }
  }

  if (data.length === 0) {
    return <div className="card p-0"><EmptyState message={emptyMessage} /></div>;
  }

  const titleCol = columns.find(c => c.cardPosition === 'title');
  const subtitleCol = columns.find(c => c.cardPosition === 'subtitle');
  const badgeCol = columns.find(c => c.cardPosition === 'badge');
  const bodyCols = columns.filter(c => c.cardPosition === 'body');

  return (
    <>
      {/* PC 테이블 */}
      <div className="card p-0 overflow-hidden overflow-x-auto hidden sm:block">
        <table className="tbl">
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`${col.sortable ? 'cursor-pointer select-none hover:text-slate-700' : ''} ${col.className ?? ''}`}
                  onClick={() => handleSort(col)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable && sortKey === col.key && (
                      sortAsc ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <tr
                key={getKey(row)}
                className={onRowClick ? 'cursor-pointer' : ''}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map(col => (
                  <td key={col.key} className={col.className}>{col.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 모바일 카드 */}
      <div className="sm:hidden space-y-2">
        {sorted.map(row => (
          <div
            key={getKey(row)}
            className={`card py-3 px-4 ${onRowClick ? 'cursor-pointer active:bg-slate-50' : ''}`}
            onClick={() => onRowClick?.(row)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {titleCol && <p className="text-sm font-semibold text-slate-800 truncate">{titleCol.render(row)}</p>}
                {subtitleCol && <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitleCol.render(row)}</p>}
              </div>
              {badgeCol && <div className="flex-shrink-0">{badgeCol.render(row)}</div>}
            </div>
            {bodyCols.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {bodyCols.map(col => (
                  <span key={col.key} className="text-xs text-slate-600">{col.render(row)}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
