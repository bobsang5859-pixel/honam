import React, { useState } from 'react';
import { Search, X, SlidersHorizontal } from 'lucide-react';

interface FilterOption {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}

interface FilterBarProps {
  search?: string;
  onSearch?: (v: string) => void;
  searchPlaceholder?: string;
  filters?: FilterOption[];
  onReset?: () => void;
  children?: React.ReactNode;
}

export default function FilterBar({ search, onSearch, searchPlaceholder = '검색...', filters = [], onReset, children }: FilterBarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeCount = filters.filter(f => f.value !== '').length;

  return (
    <div className="card mb-4 py-3 px-4">
      {/* PC */}
      <div className="hidden sm:flex items-center gap-3 flex-wrap">
        {onSearch !== undefined && (
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search ?? ''}
              onChange={e => onSearch?.(e.target.value)}
              placeholder={searchPlaceholder}
              className="input pl-9 py-1.5 text-sm"
            />
          </div>
        )}
        {filters.map(f => (
          <select
            key={f.key}
            value={f.value}
            onChange={e => f.onChange(e.target.value)}
            className="input w-auto min-w-[120px] py-1.5 text-sm"
          >
            <option value="">{f.label}</option>
            {f.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ))}
        {children}
        {onReset && activeCount > 0 && (
          <button onClick={onReset} className="btn-ghost text-xs py-1 px-2 text-slate-500">
            <X className="w-3.5 h-3.5" /> 초기화
          </button>
        )}
      </div>

      {/* 모바일 */}
      <div className="sm:hidden">
        <div className="flex items-center gap-2">
          {onSearch !== undefined && (
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={search ?? ''}
                onChange={e => onSearch?.(e.target.value)}
                placeholder={searchPlaceholder}
                className="input pl-9 py-1.5 text-sm"
              />
            </div>
          )}
          {filters.length > 0 && (
            <button onClick={() => setMobileOpen(!mobileOpen)} className="btn-secondary py-1.5 px-3 text-sm relative">
              <SlidersHorizontal className="w-4 h-4" />
              {activeCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-teal-500 text-white text-[10px] rounded-full flex items-center justify-center">
                  {activeCount}
                </span>
              )}
            </button>
          )}
        </div>
        {mobileOpen && (
          <div className="mt-3 flex flex-col gap-2">
            {filters.map(f => (
              <select
                key={f.key}
                value={f.value}
                onChange={e => f.onChange(e.target.value)}
                className="input py-1.5 text-sm"
              >
                <option value="">{f.label}</option>
                {f.options.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ))}
            {onReset && activeCount > 0 && (
              <button onClick={() => { onReset(); setMobileOpen(false); }} className="btn-ghost text-xs py-1 text-slate-500">
                <X className="w-3.5 h-3.5" /> 필터 초기화
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
