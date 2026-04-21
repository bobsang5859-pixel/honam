import React from 'react';
import { ResponsiveContainer } from 'recharts';
import { TrendingUp, TrendingDown, Minus, ChevronRight } from 'lucide-react';

/* ══════════════════════════════════════════════════════════
   Pinterest-style analytics + Sales Report hybrid components
   ══════════════════════════════════════════════════════════ */

/* ── Trend Badge (Pinterest 스타일 ▲▼ 뱃지) ──────────── */

function TrendBadge({ value, suffix = '%' }: { value: number | null | undefined; suffix?: string }) {
  if (value == null || isNaN(value)) return null;
  const isUp = value > 0;
  const isDown = value < 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold
      ${isUp ? 'text-emerald-600' : isDown ? 'text-red-500' : 'text-slate-400'}`}>
      {isUp ? <TrendingUp className="w-3 h-3" /> : isDown ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
      {isUp ? '+' : ''}{value}{suffix}
    </span>
  );
}

/* ── Metric Row (Pinterest 분석 개요 스타일) ──────────── */

interface MetricRowProps {
  label: string;
  value: string | number;
  trend?: number | null;
  trendSuffix?: string;
  onClick?: () => void;
}

export function MetricRow({ label, value, trend, trendSuffix = '%', onClick }: MetricRowProps) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center justify-between py-3 border-b border-gray-50 last:border-0
        ${onClick ? 'cursor-pointer hover:bg-gray-50 -mx-4 px-4 rounded-lg transition-colors' : ''}`}
    >
      <div className="flex items-center gap-3">
        {trend != null && <TrendBadge value={trend} suffix={trendSuffix} />}
        <span className="text-sm text-slate-600">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-slate-800">{typeof value === 'number' ? value.toLocaleString() : value}</span>
        {onClick && <ChevronRight className="w-4 h-4 text-slate-300" />}
      </div>
    </div>
  );
}

/* ── Overview Card (Pinterest 분석 개요 카드) ─────────── */

interface OverviewCardProps {
  title: string;
  period?: string;
  children: React.ReactNode;
  className?: string;
}

export function OverviewCard({ title, period, children, className = '' }: OverviewCardProps) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm p-5 ${className}`}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-bold text-slate-700">{title}</h3>
      </div>
      {period && <p className="text-[11px] text-slate-400 mb-3">{period}</p>}
      <div>{children}</div>
    </div>
  );
}

/* ── Big KPI (세일즈 리포트 상단 핵심 지표) ──────────── */

interface BigKpiProps {
  label: string;
  value: string | number;
  trend?: number | null;
  trendLabel?: string;
  color?: 'blue' | 'green' | 'teal' | 'amber' | 'red' | 'indigo' | 'rose' | 'slate';
}

const BIG_KPI_COLORS = {
  blue: 'from-blue-500 to-blue-600',
  green: 'from-emerald-500 to-emerald-600',
  teal: 'from-teal-500 to-teal-600',
  amber: 'from-amber-500 to-amber-600',
  red: 'from-red-500 to-red-600',
  indigo: 'from-indigo-500 to-indigo-600',
  rose: 'from-rose-500 to-rose-600',
  slate: 'from-slate-500 to-slate-600',
};

export function BigKpi({ label, value, trend, trendLabel, color = 'blue' }: BigKpiProps) {
  return (
    <div className={`bg-gradient-to-br ${BIG_KPI_COLORS[color]} rounded-2xl p-4 text-white`}>
      <p className="text-xs font-medium text-white/70">{label}</p>
      <p className="text-2xl font-extrabold mt-1">{value}</p>
      {trend != null && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded-full
            ${trend >= 0 ? 'bg-white/20 text-white' : 'bg-red-400/30 text-red-100'}`}>
            {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)}%
          </span>
          {trendLabel && <span className="text-[10px] text-white/60">{trendLabel}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Stats KPI Card (기존 호환 + 개선) ────────────────── */

interface StatsKpiCardProps {
  label: string;
  value: string | number;
  trend?: { value: number; label?: string };
  valueColor?: string;
  bgColor?: string;
  onClick?: () => void;
  active?: boolean;
  activeRing?: string;
}

export function StatsKpiCard({
  label, value, trend, valueColor = 'text-gray-800',
  bgColor = 'bg-white', onClick, active, activeRing = 'ring-teal-400',
}: StatsKpiCardProps) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl border border-gray-100 shadow-sm p-4 transition
        ${bgColor} ${onClick ? 'cursor-pointer hover:shadow-md' : ''}
        ${active ? `ring-2 ${activeRing}` : ''}`}
    >
      <p className="text-[11px] text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-extrabold ${valueColor}`}>{value}</p>
      {trend && (
        <div className="mt-1.5">
          <TrendBadge value={trend.value} />
          {trend.label && <span className="text-[10px] text-gray-400 ml-1.5">{trend.label}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Report Table (세일즈 리포트 테이블) ──────────────── */

interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  render?: (value: any, row: any) => React.ReactNode;
}

interface ReportTableProps {
  title?: string;
  columns: ReportColumn[];
  data: any[];
  footer?: any;
  emptyMessage?: string;
  className?: string;
}

export function ReportTable({ title, columns, data, footer, emptyMessage = '데이터 없음', className = '' }: ReportTableProps) {
  const alignClass = (a?: string) => a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';
  return (
    <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden ${className}`}>
      {title && (
        <div className="px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-slate-700">{title}</h3>
        </div>
      )}
      {data.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-sm">{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {columns.map(c => (
                  <th key={c.key} className={`px-4 py-2.5 font-semibold text-slate-500 ${alignClass(c.align)}`} style={c.width ? { width: c.width } : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  {columns.map(c => (
                    <td key={c.key} className={`px-4 py-2.5 ${alignClass(c.align)}`}>
                      {c.render ? c.render(row[c.key], row) : row[c.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer && (
              <tfoot>
                <tr className="bg-gray-50 font-bold border-t border-gray-200">
                  {columns.map(c => (
                    <td key={c.key} className={`px-4 py-2.5 ${alignClass(c.align)}`}>
                      {footer[c.key] ?? ''}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Chart Card ───────────────────────────────────────── */

interface StatsChartCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  height?: number;
  className?: string;
}

export function StatsChartCard({ title, subtitle, children, height = 280, className = '' }: StatsChartCardProps) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm p-5 ${className}`}>
      <div className="mb-3">
        <h3 className="text-sm font-bold text-slate-700">{title}</h3>
        {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

/* ── Donut Center Label (도넛 차트 중앙 텍스트) ───────── */

export function DonutCenter({ cx, cy, value, label }: { cx: number; cy: number; value: string | number; label: string }) {
  return (
    <g>
      <text x={cx} y={cy - 8} textAnchor="middle" className="fill-slate-800 text-xl font-extrabold" style={{ fontSize: 22, fontWeight: 800 }}>
        {value}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 11 }}>
        {label}
      </text>
    </g>
  );
}

/* ── Table Card (기존 호환) ───────────────────────────── */

interface StatsTableCardProps {
  title?: string;
  children: React.ReactNode;
  isEmpty?: boolean;
  emptyMessage?: string;
  className?: string;
}

export function StatsTableCard({ title, children, isEmpty, emptyMessage = '데이터 없음', className = '' }: StatsTableCardProps) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden ${className}`}>
      {title && (
        <div className="px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-slate-700">{title}</h3>
        </div>
      )}
      {isEmpty ? (
        <div className="text-center py-10 text-gray-400 text-sm">{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </div>
  );
}

/* ── Filter Bar ───────────────────────────────────────── */

interface StatsFilterBarProps {
  children: React.ReactNode;
  className?: string;
}

export function StatsFilterBar({ children, className = '' }: StatsFilterBarProps) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-3 flex flex-wrap items-end gap-4 no-print ${className}`}>
      {children}
    </div>
  );
}

/* ── Sub-Tabs (pill 스타일) ───────────────────────────── */

interface StatsTab {
  key: string;
  label: string;
}

interface StatsTabBarProps {
  tabs: StatsTab[];
  active: string;
  onChange: (key: string) => void;
}

export function StatsTabBar({ tabs, active, onChange }: StatsTabBarProps) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 no-print">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`px-3.5 py-1.5 text-xs font-semibold rounded-full whitespace-nowrap transition-all
            ${active === t.key
              ? 'bg-slate-800 text-white shadow-sm'
              : 'bg-gray-100 text-slate-500 hover:bg-gray-200'
            }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ── Section Header ───────────────────────────────────── */

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-bold text-slate-700 mb-3">{children}</h3>;
}

/* ── Comparison Row (현재 vs 직전 비교) ───────────────── */

interface ComparisonItem {
  label: string;
  current: number | string;
  previous: number | string;
  diff_pct: number;
  unit?: string;
}

export function ComparisonTable({ items, className = '' }: { items: ComparisonItem[]; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden ${className}`}>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            <th className="px-4 py-2.5 text-left font-semibold text-slate-500">지표</th>
            <th className="px-4 py-2.5 text-right font-semibold text-slate-500">현재</th>
            <th className="px-4 py-2.5 text-right font-semibold text-slate-500">직전</th>
            <th className="px-4 py-2.5 text-right font-semibold text-slate-500">증감</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.label} className="border-b border-gray-50">
              <td className="px-4 py-2.5 font-medium text-slate-600">{item.label}</td>
              <td className="px-4 py-2.5 text-right font-bold text-slate-800">{item.current}{item.unit || ''}</td>
              <td className="px-4 py-2.5 text-right text-slate-400">{item.previous}{item.unit || ''}</td>
              <td className="px-4 py-2.5 text-right"><TrendBadge value={item.diff_pct} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
