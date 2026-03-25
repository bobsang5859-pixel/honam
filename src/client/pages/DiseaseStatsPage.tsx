import React, { useState } from 'react';
import { api } from '../utils/api';
import { StatsChartCard } from '../components/stats';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell,
} from 'recharts';
import type {
  HiraDiseaseCodeResult, HiraInpatientStat, HiraGenderAgeStat, HiraInstitutionStat, HiraRegionStat,
} from '@shared/types';

type TabKey = 'inpatient' | 'genderAge' | 'institution' | 'region';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'inpatient', label: '입원·외래별' },
  { key: 'genderAge', label: '성별·연령별' },
  { key: 'institution', label: '의료기관종별' },
  { key: 'region', label: '지역별' },
];

const COLORS = ['#0d9488', '#f59e0b', '#6366f1', '#ef4444', '#3b82f6', '#84cc16', '#ec4899', '#8b5cf6'];
const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n);
const fmtAmt = (n: number) => n >= 100_000_000 ? `${(n / 100_000_000).toFixed(1)}억` : n >= 10_000 ? `${(n / 10_000).toFixed(0)}만` : fmt(n);

export default function DiseaseStatsPage() {
  const [tab, setTab] = useState<TabKey>('inpatient');

  // 질병코드 검색
  const [codeSearch, setCodeSearch] = useState('');
  const [codeResults, setCodeResults] = useState<HiraDiseaseCodeResult[]>([]);
  const [codeLoading, setCodeLoading] = useState(false);
  const [selectedCode, setSelectedCode] = useState<HiraDiseaseCodeResult | null>(null);
  const [showCodeDrop, setShowCodeDrop] = useState(false);

  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [loading, setLoading] = useState(false);

  // 통계 데이터
  const [inpatientData, setInpatientData] = useState<HiraInpatientStat[]>([]);
  const [genderAgeData, setGenderAgeData] = useState<HiraGenderAgeStat[]>([]);
  const [institutionData, setInstitutionData] = useState<HiraInstitutionStat[]>([]);
  const [regionData, setRegionData] = useState<HiraRegionStat[]>([]);

  const searchCode = async (q: string) => {
    setCodeSearch(q);
    if (q.trim().length < 2) { setCodeResults([]); setShowCodeDrop(false); return; }
    setCodeLoading(true);
    try {
      const isCode = /^[A-Z]\d/i.test(q.trim());
      const params = new URLSearchParams({ search: q.trim(), searchType: isCode ? 'SICK_CD' : 'SICK_NM', numOfRows: '10' });
      const data = await api(`/hira/disease-codes?${params}`);
      setCodeResults(data.items ?? []);
      setShowCodeDrop(true);
    } catch { /* ignore */ }
    finally { setCodeLoading(false); }
  };

  const pickCode = (c: HiraDiseaseCodeResult) => {
    setSelectedCode(c);
    setCodeSearch(`${c.sickCd} ${c.sickNm}`);
    setShowCodeDrop(false);
  };

  const loadStats = async () => {
    if (!selectedCode) return;
    setLoading(true);
    const sickCd = selectedCode.sickCd;
    const q = `sickCd=${sickCd}&year=${year}&numOfRows=100`;
    try {
      const [ip, ga, inst, reg] = await Promise.all([
        api(`/hira-disease-stats/inpatient-outpatient?${q}`),
        api(`/hira-disease-stats/gender-age?${q}`),
        api(`/hira-disease-stats/institution?${q}`),
        api(`/hira-disease-stats/region?${q}`),
      ]);
      setInpatientData(ip.items ?? []);
      setGenderAgeData(ga.items ?? []);
      setInstitutionData(inst.items ?? []);
      setRegionData(reg.items ?? []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  // ── 차트 데이터 가공 ──

  // 입원·외래별: 성별 × 입원/외래
  const inpatientChart = inpatientData.map(d => ({
    label: `${d.sex} / ${d.inpatOpat}`,
    환자수: d.ptntCnt,
    급여총액: d.rvdRpeTamtAmt,
  }));

  // 성별·연령별: 연령대별 남/여
  const ageGroups = [...new Set(genderAgeData.map(d => d.age))];
  const genderAgeChart = ageGroups.map(age => {
    const male = genderAgeData.find(d => d.age === age && d.sex === '남');
    const female = genderAgeData.find(d => d.age === age && d.sex === '여');
    return { 연령대: age.replace('_', '~'), 남: male?.ptntCnt || 0, 여: female?.ptntCnt || 0 };
  });

  // 의료기관종별: PieChart
  const institutionChart = institutionData.map(d => ({ name: d.grade, value: d.ptntCnt }));

  // 지역별: BarChart
  const regionChart = regionData.map(d => ({ 지역: d.lcName, 환자수: d.ptntCnt, 급여총액: d.rvdRpeTamtAmt }))
    .sort((a, b) => b.환자수 - a.환자수);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => String(currentYear - 1 - i));

  return (
    <div>
      {/* 검색 영역 */}
      <div className="card p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <label className="label">질병코드/명 검색</label>
            <input
              value={codeSearch}
              onChange={e => searchCode(e.target.value)}
              onFocus={() => codeResults.length > 0 && setShowCodeDrop(true)}
              className="input"
              placeholder="질병명 또는 코드 입력 (예: 당뇨, E11)"
            />
            {showCodeDrop && codeResults.length > 0 && (
              <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {codeResults.map((c, i) => (
                  <button key={i} onClick={() => pickCode(c)} className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm border-b border-gray-50">
                    <span className="font-mono font-medium text-teal-700 mr-2">{c.sickCd}</span>
                    {c.sickNm}
                    {c.sickEngNm && <span className="text-gray-400 text-xs ml-2">{c.sickEngNm}</span>}
                  </button>
                ))}
              </div>
            )}
            {codeLoading && <span className="absolute right-3 top-8 text-xs text-gray-400">검색 중...</span>}
          </div>
          <div>
            <label className="label">연도</label>
            <select value={year} onChange={e => setYear(e.target.value)} className="input w-28">
              {years.map(y => <option key={y} value={y}>{y}년</option>)}
            </select>
          </div>
          <button onClick={loadStats} disabled={!selectedCode || loading} className="btn-primary h-10 px-6">
            {loading ? '조회 중...' : '조회'}
          </button>
        </div>
        {selectedCode && (
          <p className="text-xs text-gray-500 mt-2">
            선택: <span className="font-medium text-teal-700">{selectedCode.sickCd}</span> {selectedCode.sickNm}
          </p>
        )}
      </div>

      {/* 탭 */}
      <div className="flex border-b border-gray-200 mb-4">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 ${tab === t.key ? 'border-navy-600 text-navy-700' : 'border-transparent text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <div className="py-16 text-center text-gray-400 text-sm">데이터 조회 중...</div>}

      {!loading && !selectedCode && (
        <div className="py-16 text-center text-gray-400 text-sm">질병코드를 검색·선택한 후 조회 버튼을 눌러주세요.</div>
      )}

      {/* 입원·외래별 */}
      {!loading && tab === 'inpatient' && inpatientData.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <StatsChartCard title="입원·외래별 환자수" subtitle={`${selectedCode?.sickNm} (${year}년)`} height={280}>
            <BarChart data={inpatientChart}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmt} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any) => fmt(Number(v))} />
              <Bar dataKey="환자수" fill="#0d9488" radius={[4, 4, 0, 0]} />
            </BarChart>
          </StatsChartCard>
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">상세 데이터</h3>
            <table className="tbl text-xs">
              <thead><tr><th>구분</th><th>성별</th><th className="text-right">환자수</th><th className="text-right">내원일수</th><th className="text-right">급여총액</th></tr></thead>
              <tbody>
                {inpatientData.map((d, i) => (
                  <tr key={i}><td>{d.inpatOpat}</td><td>{d.sex}</td><td className="text-right">{fmt(d.ptntCnt)}</td><td className="text-right">{fmt(d.vstDdcnt)}</td><td className="text-right">{fmtAmt(d.rvdRpeTamtAmt)}원</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 성별·연령별 */}
      {!loading && tab === 'genderAge' && genderAgeData.length > 0 && (
        <StatsChartCard title="성별·연령별 환자수" subtitle={`${selectedCode?.sickNm} (${year}년)`} height={350}>
          <BarChart data={genderAgeChart}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="연령대" tick={{ fontSize: 10 }} />
            <YAxis tickFormatter={fmt} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: any) => fmt(Number(v))} />
            <Legend />
            <Bar dataKey="남" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            <Bar dataKey="여" fill="#ec4899" radius={[4, 4, 0, 0]} />
          </BarChart>
        </StatsChartCard>
      )}

      {/* 의료기관종별 */}
      {!loading && tab === 'institution' && institutionData.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <StatsChartCard title="의료기관종별 환자분포" subtitle={`${selectedCode?.sickNm} (${year}년)`} height={300}>
            <PieChart>
              <Pie data={institutionChart} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>
                {institutionChart.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: any) => fmt(Number(v))} />
            </PieChart>
          </StatsChartCard>
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">상세 데이터</h3>
            <table className="tbl text-xs">
              <thead><tr><th>기관종별</th><th className="text-right">환자수</th><th className="text-right">내원일수</th><th className="text-right">급여총액</th></tr></thead>
              <tbody>
                {institutionData.map((d, i) => (
                  <tr key={i}><td>{d.grade}</td><td className="text-right">{fmt(d.ptntCnt)}</td><td className="text-right">{fmt(d.vstDdcnt)}</td><td className="text-right">{fmtAmt(d.rvdRpeTamtAmt)}원</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 지역별 */}
      {!loading && tab === 'region' && regionData.length > 0 && (
        <StatsChartCard title="지역별 환자수" subtitle={`${selectedCode?.sickNm} (${year}년)`} height={400}>
          <BarChart data={regionChart} layout="vertical" margin={{ left: 50 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" tickFormatter={fmt} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="지역" tick={{ fontSize: 11 }} width={50} />
            <Tooltip formatter={(v: any) => fmt(Number(v))} />
            <Bar dataKey="환자수" fill="#6366f1" radius={[0, 4, 4, 0]} />
          </BarChart>
        </StatsChartCard>
      )}
    </div>
  );
}
