import type { LucideIcon } from 'lucide-react';

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  trend?: { value: number; label: string };
  color?: 'teal' | 'blue' | 'red' | 'amber' | 'green' | 'slate';
}

const COLOR_MAP = {
  teal:  { bg: 'bg-teal-50',  icon: 'text-teal-600' },
  blue:  { bg: 'bg-blue-50',  icon: 'text-blue-600' },
  red:   { bg: 'bg-red-50',   icon: 'text-red-600' },
  amber: { bg: 'bg-amber-50', icon: 'text-amber-600' },
  green: { bg: 'bg-green-50', icon: 'text-green-600' },
  slate: { bg: 'bg-slate-50', icon: 'text-slate-600' },
};

export default function StatCard({ icon: Icon, label, value, trend, color = 'teal' }: StatCardProps) {
  const c = COLOR_MAP[color];
  return (
    <div className="card flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl ${c.bg} flex items-center justify-center flex-shrink-0`}>
        <Icon className={`w-6 h-6 ${c.icon}`} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500 truncate">{label}</p>
        <p className="text-xl font-bold text-slate-800">{value}</p>
        {trend && (
          <p className={`text-xs font-medium ${trend.value > 0 ? 'text-green-600' : trend.value < 0 ? 'text-red-600' : 'text-slate-400'}`}>
            {trend.value > 0 ? '▲' : trend.value < 0 ? '▼' : '—'} {Math.abs(trend.value)} {trend.label}
          </p>
        )}
      </div>
    </div>
  );
}
