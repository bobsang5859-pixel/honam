import React from 'react';
import { ResponsiveContainer } from 'recharts';

/* ── KPI Card ─────────────────────────────────────────── */

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
      className={`rounded-xl border border-gray-100 shadow-card p-4 transition
        ${bgColor} ${onClick ? 'cursor-pointer hover:shadow-card-md' : ''}
        ${active ? `ring-2 ${activeRing}` : ''}`}
    >
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
      {trend && (
        <p className={`mt-1 ${trend.value >= 0 ? 'stat-trend-up' : 'stat-trend-down'}`}>
          <span className="mr-0.5">{trend.value >= 0 ? '▲' : '▼'}</span>
          {Math.abs(trend.value)}%
          {trend.label && <span className="text-gray-400 ml-1">{trend.label}</span>}
        </p>
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

export function StatsChartCard({ title, subtitle, children, height = 300, className = '' }: StatsChartCardProps) {
  return (
    <div className={`bg-white rounded-xl border border-gray-100 shadow-card p-5 ${className}`}>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

/* ── Table Card ───────────────────────────────────────── */

interface StatsTableCardProps {
  title?: string;
  children: React.ReactNode;
  isEmpty?: boolean;
  emptyMessage?: string;
  className?: string;
}

export function StatsTableCard({ title, children, isEmpty, emptyMessage = '데이터 없음', className = '' }: StatsTableCardProps) {
  return (
    <div className={`bg-white rounded-xl border border-gray-100 shadow-card overflow-hidden ${className}`}>
      {title && (
        <div className="px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        </div>
      )}
      {isEmpty ? (
        <div className="text-center py-12 text-gray-400 text-sm">{emptyMessage}</div>
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
    <div className={`bg-white rounded-xl border border-gray-100 shadow-card px-5 py-3 flex flex-wrap items-end gap-4 ${className}`}>
      {children}
    </div>
  );
}

/* ── Sub-Tabs ─────────────────────────────────────────── */

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
    <div className="border-b border-gray-200 flex overflow-x-auto mb-5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition
            ${active === t.key
              ? 'border-teal-600 text-teal-700'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
