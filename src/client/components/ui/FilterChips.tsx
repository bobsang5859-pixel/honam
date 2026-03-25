import { X } from 'lucide-react';

export interface FilterChip {
  key: string;
  label: string;
  value: string;
  onRemove: () => void;
}

interface FilterChipsProps {
  chips: FilterChip[];
  totalCount?: number;
  onResetAll?: () => void;
}

export default function FilterChips({ chips, totalCount, onResetAll }: FilterChipsProps) {
  if (chips.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap mt-2.5 pt-2.5 border-t border-slate-100">
      {chips.map(chip => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 bg-slate-100 text-sm rounded-full pl-3 pr-1.5 py-1"
        >
          <span className="text-slate-500">{chip.label}:</span>
          <span className="text-slate-800 font-medium">{chip.value}</span>
          <button
            onClick={chip.onRemove}
            className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      {onResetAll && chips.length > 1 && (
        <button
          onClick={onResetAll}
          className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
        >
          전체 초기화
        </button>
      )}
      {totalCount !== undefined && (
        <span className="ml-auto text-sm text-slate-500 flex-shrink-0">
          {totalCount.toLocaleString()}건 표시됨
        </span>
      )}
    </div>
  );
}
