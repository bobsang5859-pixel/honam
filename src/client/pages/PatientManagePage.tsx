import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui';
import { StatsKpiCard } from '../components/stats';
import type { HiraDiseaseCodeResult } from '@shared/types';
import {
  REHAB_TYPES,
  getRehabBadgeClass,
  getRehabTypeLabel,
  getOnsetDays,
  getOnsetBucketKey,
  getOnsetBucketLabel,
  formatOnsetDuration,
  ONSET_BUCKETS,
} from '@shared/types';

type MajorTab = 'patients' | 'board' | 'disease';
type DiseaseSubTab = 'reregistration' | 'codes';

interface Ward {
  id: string;
  name: string;
}

interface RoomConfig {
  id: string;
  department_id: string;
  room_no: string;
  capacity: number;
  sort_order: number;
  is_active: boolean;
  is_hospice: boolean;
}

interface RoomDraftRow {
  id?: string;
  room_no: string;
  capacity: number;
  sort_order: number;
  is_active: boolean;
  is_hospice: boolean;
}

interface PatientRow {
  id: string;
  patient_no: string;
  chart_no: string;
  name: string;
  department_id: string;
  department_name: string;
  room_no: string;
  bed_no: number | null;
  gender: string;
  mobility_type: string;
  insurance_type: string;
  specializations: string[];
  infection_strain: string;
  period_type: string;
  period_phase: string;
  patient_group: string;
  rehab_type: string;
  onset_date: string | null;
  diaper_state: string;
  diaper_price: number | null;
  diaper_start_date: string | null;
  diaper_end_date: string | null;
  prev_hospital: string;
  acquaintance: string;
  acquaintance_color: string;
  admitted_at: string;
  discharged_at: string | null;
  status: 'ADMITTED' | 'DISCHARGED';
  note: string;
  disease_code_id: string | null;
  disease_code_str: string;
  disease_code_name: string;
  disease_code_registered_at: string | null;
  disease_code_expires_at: string | null;
  main_disease_code_id: string | null;
  main_disease_code: string;
  main_disease_name: string;
  caregiver_type: string;
  guardian_name: string;
  billing_sms_phone: string;
  project_name: string;
  project_region: string;
  project_sigungu_office: string;
  address: string;
  referral_source: string;
  discharge_type: string;
}

interface BoardCell {
  id: string;
  patient_id?: string | null;
  room_no: string;
  bed_no: number;
  patient_no: string;
  chart_no: string;
  patient_name: string;
  gender: string;
  mobility_type: string;
  insurance_type: string;
  copay_reduction: string;
  specializations: string[];
  infection_strain: string;
  period_type: string;
  period_phase: string;
  period_start_date?: string;
  period_end_date?: string;
  patient_group: string;
  rehab_type: string;
  onset_date: string | null;
  diaper_state: string;
  diaper_price: number | null;
  diaper_start_date?: string | null;
  diaper_end_date?: string | null;
  prev_hospital: string;
  acquaintance: string;
  acquaintance_color: string;
  status: string;
  note: string;
  disease_code_id: string | null;
  disease_code_registered_at: string | null;
  disease_code_expires_at: string | null;
  main_disease_code_id: string | null;
  caregiver_type: string;
  guardian_name: string;
  billing_sms_phone: string;
  project_name: string;
  project_region: string;
  project_sigungu_office: string;
  address: string;
  referral_source: string;
  discharge_type: string;
  admitted_at?: string;
  caregiver_price?: number;
}

interface BoardRoom {
  id: string;
  room_no: string;
  capacity: number;
  is_hospice?: boolean;
  cells: BoardCell[];
}

interface DiseaseCodeItem {
  id: string;
  code: string;
  name: string;
  code_type: 'MAIN' | 'SEVERE' | 'RARE';
  is_active: boolean;
}

interface PatientDiseaseCodeRow {
  id: string;
  patient_id: string;
  patient_name: string;
  chart_no: string;
  department_name: string;
  room_no: string;
  insurance_type: string;
  status: string;
  disease_code_id: string;
  code: string;
  name: string;
  code_type: string;
  registered_at: string;
  expires_at: string | null;
  is_active: boolean;
  note: string;
}

const MAJOR_TABS: { key: MajorTab; label: string }[] = [
  { key: 'board', label: '병실현황판' },
  { key: 'patients', label: '환자리스트' },
  { key: 'disease', label: '주상병 및 본인부담경감 관리' },
];

function SelectField({
  value, onChange, options, disabled,
}: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[]; disabled?: boolean }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled} className={`input h-10 text-sm leading-6 py-2${disabled ? ' opacity-50 cursor-not-allowed' : ''}`}>
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

function GroupedSelectField({
  value, onChange, groups, disabled,
}: { value: string; onChange: (v: string) => void; groups: { label?: string; options: { v: string; l: string }[] }[]; disabled?: boolean }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled} className={`input h-10 text-sm leading-6 py-2${disabled ? ' opacity-50 cursor-not-allowed' : ''}`}>
      {groups.map((g, i) =>
        g.label ? (
          <optgroup key={i} label={g.label}>
            {g.options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </optgroup>
        ) : (
          g.options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)
        )
      )}
    </select>
  );
}

function SearchableSelect({
  value, onChange, options, placeholder = '검색...',
}: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[]; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = React.useRef<HTMLDivElement>(null);

  const selectedLabel = options.find(o => o.v === value)?.l || '';
  const filtered = query
    ? options.filter(o => o.l.toLowerCase().includes(query.toLowerCase()) || o.v.toLowerCase().includes(query.toLowerCase()))
    : options;

  React.useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setOpen(!open); setQuery(''); }}
        className="input h-10 text-sm text-left truncate w-full flex items-center justify-between gap-1">
        <span className={value ? 'text-slate-700' : 'text-slate-400'}>{value ? selectedLabel : placeholder}</span>
        <span className="text-slate-400 text-xs">▼</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-64 overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <input type="text" autoFocus value={query} onChange={e => setQuery(e.target.value)}
              placeholder="코드 또는 질환명 검색..."
              className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="overflow-y-auto max-h-48">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 text-center">검색 결과 없음</div>
            ) : filtered.map(o => (
              <button key={o.v} type="button"
                onClick={() => { onChange(o.v); setOpen(false); setQuery(''); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors truncate
                  ${o.v === value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'}`}>
                {o.l}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const INSURANCE_GROUPS = [
  {
    label: '건강보험',
    options: [
      { v: 'HEALTH', l: '건강보험' },
    ],
  },
  {
    label: '의료급여',
    options: [
      { v: 'MEDICAL_1', l: '의료급여 1종' },
      { v: 'MEDICAL_2', l: '의료급여 2종' },
    ],
  },
  {
    options: [
      { v: 'WORKERS_COMP', l: '산재보험' },
      { v: 'AUTO_INS', l: '자동차보험' },
    ],
  },
];

const COPAY_REDUCTION_OPTIONS = [
  { v: 'NONE', l: '해당없음' },
  { v: 'SEVERE', l: '중증질환' },
  { v: 'RARE', l: '희귀난치성' },
];

const SPECIALIZATION_OPTIONS = [
  { value: 'INFECT', label: '감염' },
  { value: 'DIALYSIS', label: '투석' },
  { value: 'REHAB', label: '재활' },
] as const;
const CAREGIVER_OPTIONS = [
  { v: '', l: '간병유형 없음' },
  { v: 'CLOSE', l: '밀착간병' },
  { v: 'OUTSOURCED', l: '외주간병' },
  { v: 'IN_HOUSE', l: '본원간병' },
];
const CAREGIVER_LABEL: Record<string, string> = {
  CLOSE: '밀착간병',
  OUTSOURCED: '외주간병',
  IN_HOUSE: '본원간병',
};
const CODE_TYPE_LABEL: Record<string, string> = {
  MAIN: '주상병',
  SEVERE: '중증질환',
  RARE: '희귀난치성',
};

const valueLabel = {
  mobility_type: { BEDRIDDEN: '와상', AMBULATORY: '거동' } as Record<string, string>,
  insurance_type: {
    HEALTH: '건강보험',
    MEDICAL_1: '의료급여 1종',
    MEDICAL_2: '의료급여 2종',
    WORKERS_COMP: '산재보험',
    AUTO_INS: '자동차보험',
  } as Record<string, string>,
  copay_reduction: {
    NONE: '',
    SEVERE: '중증질환',
    RARE: '희귀난치성',
  } as Record<string, string>,
  patient_group: {
    HIGHEST: '최고도',
    HIGH: '고도',
    MEDIUM: '중도',
    LOW: '경도',
    SELECT: '선택',
    UNRATED: '미평가',
    PNEUMONIA: '폐렴',
    SEPSIS: '패혈증',
    INFECTION: '감염',
  } as Record<string, string>,
  period_type: { PNEUMONIA: '폐렴', SEPSIS: '패혈증' } as Record<string, string>,
  period_phase: { START: '시작', END: '종료' } as Record<string, string>,
  diaper_state: { IN_HOUSE: '원내', PERSONAL: '본인', NONE: '미사용', CIRCLE: '원내', TRIANGLE: '본인' } as Record<string, string>,
  infection_strain: { CRE: 'CRE', VRE: 'VRE', MR: 'MR' } as Record<string, string>,
  rehab_type: { CNS: 'CNS', OS: 'CNS 외', OUTPATIENT: '외래' } as Record<string, string>,
};

const toLabel = (kind: keyof typeof valueLabel, value?: string) => {
  if (!value) return '-';
  return valueLabel[kind][value] ?? value;
};
const toCaregiverLabel = (value?: string) => {
  if (!value) return '-';
  return CAREGIVER_LABEL[value] ?? value;
};
const normalizeGenderForColor = (value?: string) => {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'FEMALE') return 'F';
  if (raw === 'MALE') return 'M';
  return raw;
};
const isWardName = (name?: string) => String(name ?? '').includes('병동');

function DistCard({ title, data, labelMap }: { title: string; data: Record<string, number>; labelMap: Record<string, string> }) {
  const entries = Object.entries(data).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="border border-slate-100 rounded-lg p-2.5">
      <p className="text-[11px] font-semibold text-slate-500 mb-1.5">{title}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-slate-300">해당 없음</p>
      ) : (
        <div className="space-y-1">
          {entries.map(([key, val]) => (
            <div key={key} className="flex justify-between text-xs">
              <span className="text-slate-600">{labelMap[key] ?? key}</span>
              <span className="font-semibold text-slate-800">{val}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PatientManagePage() {
  const { user } = useAuth();
  const [majorTab, setMajorTab] = useState<MajorTab>('board');
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [wards, setWards] = useState<Ward[]>([]);
  const [roomConfigs, setRoomConfigs] = useState<RoomConfig[]>([]);
  const [roomEditMode, setRoomEditMode] = useState(false);
  const [roomSaving, setRoomSaving] = useState(false);
  const [roomDraftRows, setRoomDraftRows] = useState<RoomDraftRow[]>([]);
  const [wardId, setWardId] = useState('');
  const [boardDate, setBoardDate] = useState(new Date().toISOString().slice(0, 10));
  const [boardRooms, setBoardRooms] = useState<BoardRoom[]>([]);
  const [loadingBoard, setLoadingBoard] = useState(false);

  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ADMITTED' | 'DISCHARGED' | ''>('ADMITTED');
  const [wardFilter, setWardFilter] = useState<string>('');
  const [insuranceFilter, setInsuranceFilter] = useState<string>('');
  const [patientGroupFilter, setPatientGroupFilter] = useState<string>('');
  const [specializationFilter, setSpecializationFilter] = useState<string>('');
  const [diaperFilter, setDiaperFilter] = useState<'' | 'USE' | 'NONE'>('');
  const [rehabFilter, setRehabFilter] = useState<string>('');
  const [onsetFilter, setOnsetFilter] = useState<string>(''); // ONSET_BUCKET key | 'NONE'
  const [statsOpen, setStatsOpen] = useState(false);
  const [listAdmitOpen, setListAdmitOpen] = useState(false);
  const [admitLoading, setAdmitLoading] = useState(false);
  const admittingRef = useRef(false);
  const [listAdmitForm, setListAdmitForm] = useState({
    department_id: '',
    room_no: '',
    bed_no: '',
    chart_no: '',
    name: '',
    gender: 'F',
    mobility_type: 'BEDRIDDEN',
    insurance_type: 'HEALTH',
    copay_reduction: 'NONE',
    patient_group: 'UNRATED',
    specializations: [] as string[],
    infection_strain: '',
    period_type: '',
    period_phase: '',
    period_start_date: '',
    period_end_date: '',
    diaper_state: 'NONE',
    diaper_price: '',
    diaper_start_date: '',
    diaper_end_date: '',
    prev_hospital: '',
    acquaintance: '',
    acquaintance_color: '#0ea5e9',
    admitted_at: new Date().toISOString().slice(0, 10),
    note: '',
    disease_code_id: '',
    disease_code_registered_at: '',
    disease_code_expires_at: '',
    main_disease_code_id: '',
    caregiver_type: '',
    guardian_name: '',
    billing_sms_phone: '',
    project_name: '',
    project_region: '',
    project_sigungu_office: '',
    address: '',
    referral_source: '',
    discharge_type: '',
    rehab_type: '',
    onset_date: '',
  });

  const [selectedCell, setSelectedCell] = useState<BoardCell | null>(null);
  const [savingCell, setSavingCell] = useState(false);
  const [cellEditTab, setCellEditTab] = useState<0|1|2|3>(0);
  const [patientEvents, setPatientEvents] = useState<any[]>([]);
  const [dischargeModalOpen, setDischargeModalOpen] = useState(false);
  const [dischargeForm, setDischargeForm] = useState({ type: '', reason: '' });
  const [hospiceModalOpen, setHospiceModalOpen] = useState(false);
  const [hospiceRooms, setHospiceRooms] = useState<any[]>([]);
  const [chargeMonth, setChargeMonth] = useState(new Date().toISOString().slice(0, 7));
  const [chargeItems, setChargeItems] = useState<{ category: string; item_name: string; amount: number }[]>([]);
  const [chargeLoadedFor, setChargeLoadedFor] = useState(''); // 어떤 환자의 데이터가 로드됐는지 추적
  const COVERED_ITEMS = ['임종실', '고빈도흉벽', '산소', '가온가습고유량'];
  const NON_COVERED_ITEMS = ['기저귀', '간병', '영양제', '상급병실료', '엠블비', '도수', '기타/약품비'];
  const emptyChargeItems = () => [
    ...COVERED_ITEMS.map(n => ({ category: 'COVERED', item_name: n, amount: 0 })),
    ...NON_COVERED_ITEMS.map(n => ({ category: 'NON_COVERED', item_name: n, amount: 0 })),
  ];
  const loadCharges = async (patientId: string, month: string) => {
    try {
      const data = await api(`/patients/${patientId}/charges?month=${month}`);
      const items = [
        ...COVERED_ITEMS.map(name => ({ category: 'COVERED', item_name: name, amount: (data || []).find((c: any) => c.category === 'COVERED' && c.item_name === name)?.amount || 0 })),
        ...NON_COVERED_ITEMS.map(name => ({ category: 'NON_COVERED', item_name: name, amount: (data || []).find((c: any) => c.category === 'NON_COVERED' && c.item_name === name)?.amount || 0 })),
      ];
      setChargeItems(items);
      setChargeLoadedFor(patientId);
    } catch {
      setChargeItems(emptyChargeItems());
      setChargeLoadedFor(patientId);
    }
  };
  // 환자/월 변경 시 즉시 0원 구조체로 리셋(input은 그대로 보이되 잔상 차단) → 비동기 재로드.
  useEffect(() => {
    setChargeItems(emptyChargeItems());
    setChargeLoadedFor('');
    if (selectedCell?.patient_id) {
      loadCharges(selectedCell.patient_id, chargeMonth);
    }
  }, [selectedCell?.patient_id, chargeMonth]);

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferWardId, setTransferWardId] = useState('');
  const [transferRoomNo, setTransferRoomNo] = useState('');
  const [transferBedNo, setTransferBedNo] = useState<number | null>(null);
  const [transferRooms, setTransferRooms] = useState<{ id: string; room_no: string; capacity: number }[]>([]);
  const [transferBoard, setTransferBoard] = useState<any[]>([]);
  const [transferMemo, setTransferMemo] = useState('');
  const [transferring, setTransferring] = useState(false);

  const [hospitals, setHospitals] = useState<{ id: string; name: string }[]>([]);
  const [importingPatients, setImportingPatients] = useState(false);

  // 대량등록 모달 상태
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkStep, setBulkStep] = useState<1|2|3>(1);
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkPreview, setBulkPreview] = useState<{
    is_header_mode: boolean; headers: string[]; recognized: string[]; preview: string[][]; total: number;
  } | null>(null);
  const [bulkPreviewing, setBulkPreviewing] = useState(false);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number; errors: { row: number; message: string }[] } | null>(null);
  const [bulkDragOver, setBulkDragOver] = useState(false);

  // 엑셀 최신화 모달
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncFiles, setSyncFiles] = useState<File[]>([]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);

  // 주상병 관리 탭 상태
  const [diseaseSubTab, setDiseaseSubTab] = useState<DiseaseSubTab>('reregistration');
  const [diseaseCodes, setDiseaseCodes] = useState<DiseaseCodeItem[]>([]);
  const [patientDiseaseRows, setPatientDiseaseRows] = useState<PatientDiseaseCodeRow[]>([]);
  const [codeTypeFilter, setCodeTypeFilter] = useState<'MAIN' | 'SEVERE' | 'RARE' | ''>('');
  const [regTypeFilter, setRegTypeFilter] = useState<'SEVERE' | 'RARE' | ''>('');
  // V코드 마스터 편집 모달
  const [codeEditOpen, setCodeEditOpen] = useState(false);
  const [codeForm, setCodeForm] = useState<{ code: string; name: string; code_type: 'MAIN' | 'SEVERE' | 'RARE' }>({ code: '', name: '', code_type: 'MAIN' });
  const [editingCodeId, setEditingCodeId] = useState<string | null>(null);
  const [codeSaving, setCodeSaving] = useState(false);
  // HIRA 질병코드 동기화
  const [hiraSyncing, setHiraSyncing] = useState(false);

  // HIRA 질병코드 검색
  const [hiraCodeModal, setHiraCodeModal] = useState(false);
  const [hiraCodeSearch, setHiraCodeSearch] = useState('');
  const [hiraCodeResults, setHiraCodeResults] = useState<HiraDiseaseCodeResult[]>([]);
  const [hiraCodeLoading, setHiraCodeLoading] = useState(false);
  const [hiraCodePage, setHiraCodePage] = useState(1);
  const [hiraCodeTotal, setHiraCodeTotal] = useState(0);
  const [hiraSearchType, setHiraSearchType] = useState<'SICK_NM' | 'SICK_CD'>('SICK_NM');

  // 재등록 편집 모달
  const [regEditOpen, setRegEditOpen] = useState(false);
  const [regForm, setRegForm] = useState({ patient_id: '', disease_code_id: '', registered_at: '', expires_at: '', note: '' });
  const [editingRegId, setEditingRegId] = useState<string | null>(null);
  const [regSaving, setRegSaving] = useState(false);

  // ── 환자 처치 관련 상태 ──
  const [treatmentTypes, setTreatmentTypes] = useState<{ id: string; code: string; name: string; category: string }[]>([]);
  const [patientTreatments, setPatientTreatments] = useState<any[]>([]);
  const [treatmentOpen, setTreatmentOpen] = useState(false);
  const [addTreatmentId, setAddTreatmentId] = useState('');

  const loadTreatmentTypes = useCallback(async () => {
    try {
      const data = await api('/treatment-types');
      setTreatmentTypes(Array.isArray(data) ? data.filter((t: any) => t.is_active) : []);
    } catch { /* ignore */ }
  }, []);

  const loadPatientTreatments = useCallback(async (patientId: string) => {
    try {
      const data = await api(`/treatment-types/patient-treatments/${patientId}`);
      setPatientTreatments(Array.isArray(data) ? data : []);
    } catch { setPatientTreatments([]); }
  }, []);

  const addPatientTreatment = async (patientId: string) => {
    if (!addTreatmentId) return;
    try {
      await api('/treatment-types/patient-treatments', {
        method: 'POST',
        body: JSON.stringify({ patient_id: patientId, treatment_type_id: addTreatmentId }),
      });
      setAddTreatmentId('');
      loadPatientTreatments(patientId);
    } catch (e: any) {
      showMsg('err', e.message || '처치 등록 실패');
    }
  };

  const endPatientTreatment = async (ptId: string, patientId: string) => {
    try {
      await api(`/treatment-types/patient-treatments/${ptId}`, {
        method: 'PUT',
        body: JSON.stringify({ ended_at: new Date().toISOString() }),
      });
      loadPatientTreatments(patientId);
    } catch (e: any) {
      showMsg('err', e.message || '처치 종료 실패');
    }
  };

  const deletePatientTreatment = async (ptId: string, patientId: string) => {
    try {
      await api(`/treatment-types/patient-treatments/${ptId}`, { method: 'DELETE' });
      loadPatientTreatments(patientId);
    } catch (e: any) {
      showMsg('err', e.message || '처치 삭제 실패');
    }
  };

  // 처치유형 로드 (한번만)
  useEffect(() => { loadTreatmentTypes(); }, [loadTreatmentTypes]);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3500);
  };

  // 전실 대상 병동 선택 시 병실 목록 + 보드 로드
  const loadTransferRooms = async (deptId: string) => {
    if (!deptId) { setTransferRooms([]); setTransferBoard([]); return; }
    try {
      const r = await api(`/patients/board?department_id=${deptId}`);
      const grouped = r?.rooms ?? [];
      setTransferRooms(grouped.map((rm: any) => ({ id: rm.id, room_no: rm.room_no, capacity: rm.capacity })));
      // cells를 flat 배열로 변환
      const allCells = grouped.flatMap((rm: any) => (rm.cells ?? []).map((c: any) => ({ ...c, ward_room_id: rm.id })));
      setTransferBoard(allCells);
    } catch {
      setTransferRooms([]);
      setTransferBoard([]);
    }
  };

  const handleTransfer = async () => {
    if (!selectedCell?.patient_id || !transferWardId) return;
    // 교환 대상 확인
    if (transferRoomNo && transferBedNo != null) {
      const room = transferRooms.find(r => r.room_no === transferRoomNo);
      if (room) {
        const occupant = transferBoard.find((c: any) => c.ward_room_id === room.id && c.bed_no === transferBedNo && c.patient_name && c.patient_id !== selectedCell.patient_id);
        if (occupant) {
          if (!confirm(`${occupant.patient_name} 환자와 자리를 교환하시겠습니까?`)) return;
        }
      }
    }
    setTransferring(true);
    try {
      await api(`/patients/${selectedCell.patient_id}/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          department_id: transferWardId,
          room_no: transferRoomNo,
          bed_no: transferBedNo,
          memo: transferMemo,
        }),
      });
      showMsg('ok', '자리이동 처리되었습니다.');
      setTransferOpen(false);
      setTransferMemo('');
      setTransferRoomNo('');
      setTransferBedNo(null);
      setTransferRooms([]);
      setTransferBoard([]);
      setSelectedCell(null);
      loadBoard();
    } catch (e: any) {
      showMsg('err', e.message || '자리이동에 실패했습니다.');
    } finally {
      setTransferring(false);
    }
  };
  const validateProjectScopeInput = (projectName?: string, projectRegion?: string, projectSigunguOffice?: string) => {
    if (String(projectName ?? '').trim() && (!String(projectRegion ?? '').trim() || !String(projectSigunguOffice ?? '').trim())) {
      return '사업명칭 입력 시 지역과 시군구청을 함께 입력해 주세요.';
    }
    return null;
  };
  const bedCellToneClass = (cell: BoardCell) => {
    const occupied = Boolean(cell.patient_name?.trim());
    if (!occupied) return 'bg-white text-slate-800 border-gray-200 hover:bg-gray-50';
    const g = normalizeGenderForColor(cell.gender);
    if (g === 'F') return 'bg-pink-100 text-pink-900 border-pink-300 hover:bg-pink-200';
    if (g === 'M') return 'bg-blue-100 text-blue-900 border-blue-300 hover:bg-blue-200';
    return 'bg-slate-100 text-slate-800 border-slate-300 hover:bg-slate-200';
  };

  const loadConfig = useCallback(async () => {
    try {
      const r = await api('/patients/room-config');
      const wardOnly: Ward[] = Array.isArray(r.wards)
        ? (r.wards as Ward[]).filter((w) => isWardName(w.name))
        : [];
      setWards(wardOnly);
      setRoomConfigs(r.rooms || []);
      const firstWardId = wardOnly[0]?.id ?? '';
      setWardId(prev => (wardOnly.some((w) => w.id === prev) ? prev : firstWardId));
      if (wardOnly.length === 0) setRoomEditMode(false);
    } catch (e: any) {
      setWards([]);
      setRoomConfigs([]);
      setRoomEditMode(false);
      showMsg('err', e.message || '병실 설정을 불러오지 못했습니다.');
    }
  }, []);

  const loadHospitals = useCallback(async () => {
    try {
      const rows = await api('/patients/hospitals');
      setHospitals(Array.isArray(rows) ? rows : []);
    } catch {
      setHospitals([]);
    }
  }, []);

  const loadDiseaseCodes = useCallback(async () => {
    try {
      const rows = await api('/disease-codes?includeInactive=true');
      setDiseaseCodes(Array.isArray(rows) ? rows : []);
    } catch {
      setDiseaseCodes([]);
    }
  }, []);

  const loadPatientDiseaseRows = useCallback(async () => {
    try {
      const rows = await api('/disease-codes/patient-registrations');
      setPatientDiseaseRows(Array.isArray(rows) ? rows : []);
    } catch {
      setPatientDiseaseRows([]);
    }
  }, []);

  const loadPatients = useCallback(async () => {
    setLoadingPatients(true);
    try {
      const p = new URLSearchParams();
      if (statusFilter) p.set('status', statusFilter);
      if (search) p.set('search', search);
      const rows = await api(`/patients?${p.toString()}`);
      setPatients(rows);
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setLoadingPatients(false);
    }
  }, [statusFilter, search]);

  const loadBoard = useCallback(async () => {
    if (!wardId) return;
    setLoadingBoard(true);
    try {
      const r = await api(`/patients/board?department_id=${wardId}&date=${boardDate}`);
      setBoardRooms(r.rooms || []);
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setLoadingBoard(false);
    }
  }, [wardId, boardDate]);


  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadHospitals(); }, [loadHospitals]);
  useEffect(() => { loadPatients(); }, [loadPatients]);
  useEffect(() => { if (majorTab === 'board') loadBoard(); }, [majorTab, loadBoard]);
  useEffect(() => { loadDiseaseCodes(); }, [loadDiseaseCodes]);
  useEffect(() => {
    if (majorTab === 'disease') {
      loadDiseaseCodes();
      loadPatientDiseaseRows();
    }
  }, [majorTab, loadDiseaseCodes, loadPatientDiseaseRows]);

  const mergedPatients = useMemo(() => {
    return patients.filter(p => {
      if (wardFilter && p.department_id !== wardFilter) return false;
      if (insuranceFilter && p.insurance_type !== insuranceFilter) return false;
      if (patientGroupFilter && p.patient_group !== patientGroupFilter) return false;
      if (specializationFilter && !(p.specializations || []).includes(specializationFilter)) return false;
      if (diaperFilter === 'USE' && (!p.diaper_state || p.diaper_state === 'NONE')) return false;
      if (diaperFilter === 'NONE' && p.diaper_state && p.diaper_state !== 'NONE') return false;
      if (rehabFilter) {
        if (rehabFilter === 'NONE' && p.rehab_type) return false;
        if (rehabFilter !== 'NONE' && p.rehab_type !== rehabFilter) return false;
      }
      if (onsetFilter) {
        if (onsetFilter === 'NONE') {
          if (p.onset_date) return false;
        } else {
          const key = getOnsetBucketKey(p.onset_date);
          if (key !== onsetFilter) return false;
        }
      }
      return true;
    });
  }, [patients, wardFilter, insuranceFilter, patientGroupFilter, specializationFilter, diaperFilter, rehabFilter, onsetFilter]);

  const patientStats = useMemo(() => {
    const byGroup: Record<string, number> = {};
    const byInsurance: Record<string, number> = {};
    const bySpec: Record<string, number> = {};
    const byRehab: Record<string, number> = {};
    const byOnsetBucket: Record<string, number> = {};
    const byOnsetCNS: Record<string, number> = {};
    const byOnsetOS: Record<string, number> = {};
    let diaperUse = 0, diaperNone = 0;
    let admitted = 0, discharged = 0;
    for (const p of mergedPatients) {
      if (p.status === 'ADMITTED') admitted++;
      else if (p.status === 'DISCHARGED') discharged++;
      // 환자군 카운트: 폐렴/패혈증/다제내성균 → '감염' 으로 통합
      const isInfection =
        p.patient_group === 'PNEUMONIA' ||
        p.patient_group === 'SEPSIS' ||
        p.patient_group === 'INFECTION' ||
        (p.infection_strain && String(p.infection_strain).trim() !== '');
      const groupKey = isInfection ? 'INFECTION' : (p.patient_group || '');
      if (groupKey) byGroup[groupKey] = (byGroup[groupKey] || 0) + 1;
      if (p.insurance_type) byInsurance[p.insurance_type] = (byInsurance[p.insurance_type] || 0) + 1;
      (p.specializations || []).forEach(s => { bySpec[s] = (bySpec[s] || 0) + 1; });
      if (p.diaper_state && p.diaper_state !== 'NONE') diaperUse++;
      else diaperNone++;
      const rehabKey = p.rehab_type || 'NONE';
      byRehab[rehabKey] = (byRehab[rehabKey] || 0) + 1;
      if (p.rehab_type === 'CNS' || p.rehab_type === 'OS') {
        const bk = getOnsetBucketKey(p.onset_date) || 'none';
        byOnsetBucket[bk] = (byOnsetBucket[bk] || 0) + 1;
        const target = p.rehab_type === 'CNS' ? byOnsetCNS : byOnsetOS;
        target[bk] = (target[bk] || 0) + 1;
      }
    }
    return {
      total: mergedPatients.length,
      admitted, discharged,
      byGroup, byInsurance, bySpec,
      byRehab, byOnsetBucket, byOnsetCNS, byOnsetOS,
      diaperUse, diaperNone,
    };
  }, [mergedPatients]);
  const diseaseCodeLabelById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const code of diseaseCodes) {
      map[code.id] = `${code.code} ${code.name}`;
    }
    return map;
  }, [diseaseCodes]);

  const wardRoomRows = useMemo(
    () => roomConfigs
      .filter(r => r.department_id === wardId)
      .sort((a, b) => a.sort_order - b.sort_order),
    [roomConfigs, wardId]
  );

  const saveCell = async () => {
    if (!selectedCell) return;
    const projectError = validateProjectScopeInput(selectedCell.project_name, selectedCell.project_region, selectedCell.project_sigungu_office);
    if (projectError) return showMsg('err', projectError);
    // 빈 병상에 환자 정보를 입력한 경우, 저장 버튼도 입원 등록으로 처리
    if (!selectedCell.patient_id && (selectedCell.patient_name?.trim() || selectedCell.chart_no?.trim() || selectedCell.patient_no?.trim())) {
      await admitFromBoard();
      return;
    }
    setSavingCell(true);
    try {
      // 입원전병원 자동 등록
      if (selectedCell.prev_hospital?.trim() && !hospitals.some(h => h.name === selectedCell.prev_hospital.trim())) {
        try { await api('/patients/hospitals', { method: 'POST', body: JSON.stringify({ name: selectedCell.prev_hospital.trim() }) }); loadHospitals(); } catch { /* 중복 무시 */ }
      }
      await api(`/patients/board/cell/${selectedCell.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          patient_no: selectedCell.patient_no,
          chart_no: selectedCell.chart_no,
          name: selectedCell.patient_name,
          gender: selectedCell.gender,
          mobility_type: selectedCell.mobility_type,
          insurance_type: selectedCell.insurance_type,
          copay_reduction: selectedCell.copay_reduction || 'NONE',
          specializations: selectedCell.specializations,
          infection_strain: selectedCell.infection_strain,
          period_type: selectedCell.period_type,
          period_start_date: selectedCell.period_start_date || '',
          period_end_date: selectedCell.period_end_date || '',
          patient_group: selectedCell.patient_group,
          diaper_state: selectedCell.diaper_state,
          diaper_price: selectedCell.diaper_price,
          diaper_start_date: selectedCell.diaper_start_date || null,
          diaper_end_date: selectedCell.diaper_end_date || null,
          prev_hospital: selectedCell.prev_hospital,
          acquaintance: selectedCell.acquaintance,
          acquaintance_color: selectedCell.acquaintance_color,
          main_disease_code_id: selectedCell.main_disease_code_id || null,
          caregiver_type: selectedCell.caregiver_type,
          guardian_name: selectedCell.guardian_name,
          billing_sms_phone: selectedCell.billing_sms_phone,
          project_name: selectedCell.project_name,
          project_region: selectedCell.project_region,
          project_sigungu_office: selectedCell.project_sigungu_office,
          address: selectedCell.address || '',
          referral_source: selectedCell.referral_source || '',
          discharge_type: selectedCell.discharge_type || '',
          rehab_type: selectedCell.rehab_type || '',
          onset_date: selectedCell.onset_date || null,
          note: selectedCell.note,
          status: selectedCell.status,
          ...(selectedCell.admitted_at ? { admitted_at: selectedCell.admitted_at } : {}),
        }),
      });
      // V코드가 있고 실제 환자와 연결된 경우, 환자 레코드에도 V코드 정보 저장
      if (selectedCell.patient_id && (selectedCell.disease_code_id !== undefined)) {
        try {
          await api(`/patients/${selectedCell.patient_id}`, {
            method: 'PUT',
            body: JSON.stringify({
              disease_code_id: selectedCell.disease_code_id || null,
              disease_code_registered_at: selectedCell.disease_code_registered_at || null,
              disease_code_expires_at: selectedCell.disease_code_expires_at || null,
              main_disease_code_id: selectedCell.main_disease_code_id || null,
            }),
          });
        } catch { /* V코드 저장 실패는 무시 */ }
      }
      // 비급여/급여 월별 금액도 같이 저장 (현재 환자 데이터가 로드된 상태에서만)
      if (selectedCell.patient_id && chargeLoadedFor === selectedCell.patient_id && chargeItems.length > 0) {
        try {
          await api(`/patients/${selectedCell.patient_id}/charges`, {
            method: 'PUT',
            body: JSON.stringify({ month: chargeMonth, items: chargeItems }),
          });
        } catch { /* 금액 저장 실패해도 메인 저장은 성공으로 처리 */ }
      }
      setSelectedCell(null);
      showMsg('ok', '저장 완료');
      loadBoard();
      loadPatients();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSavingCell(false);
    }
  };

  const downloadPatientTemplate = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/patients/import/template', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error('템플릿 다운로드 실패');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'patient_import_template.xlsx';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e: any) {
      showMsg('err', e.message || '템플릿 다운로드 실패');
    }
  };

  const importPatients = async (file?: File | null) => {
    if (!file) return;
    setImportingPatients(true);
    try {
      const token = localStorage.getItem('token');
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/patients/import', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '대량등록 실패');
      showMsg('ok', `대량등록 완료: 등록 ${json.created ?? 0}건, 중복 ${json.skipped ?? 0}건`);
      loadPatients();
      loadBoard();
    } catch (e: any) {
      showMsg('err', e.message || '대량등록 실패');
    } finally {
      setImportingPatients(false);
    }
  };

  const openBulkModal = () => {
    setBulkModalOpen(true);
    setBulkStep(1);
    setBulkFile(null);
    setBulkPreview(null);
    setBulkResult(null);
    setBulkDragOver(false);
  };

  const closeBulkModal = () => {
    setBulkModalOpen(false);
  };

  const openSyncModal = () => {
    setSyncModalOpen(true);
    setSyncFiles([]);
    setSyncResult(null);
  };

  const runSyncExcel = async () => {
    if (syncFiles.length === 0) return;
    setSyncLoading(true);
    try {
      const token = localStorage.getItem('token');
      const fd = new FormData();
      syncFiles.forEach(f => fd.append('files', f));
      const res = await fetch('/api/patients/sync-excel', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '최신화 실패');
      setSyncResult(json);
      loadPatients();
      loadBoard();
    } catch (e: any) {
      showMsg('err', e.message || '최신화 실패');
    } finally {
      setSyncLoading(false);
    }
  };

  const handleBulkFileSelect = async (file: File) => {
    setBulkFile(file);
    setBulkPreviewing(true);
    try {
      const token = localStorage.getItem('token');
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/patients/import/preview', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '미리보기 실패');
      setBulkPreview(json);
      setBulkStep(2);
    } catch (e: any) {
      showMsg('err', e.message || '파일 처리 오류');
    } finally {
      setBulkPreviewing(false);
    }
  };

  const startBulkImport = async () => {
    if (!bulkFile) return;
    setBulkImporting(true);
    try {
      const token = localStorage.getItem('token');
      const fd = new FormData();
      fd.append('file', bulkFile);
      const res = await fetch('/api/patients/import', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '대량등록 실패');
      setBulkResult(json);
      setBulkStep(3);
      if (json.created > 0) {
        loadPatients();
        loadBoard();
      }
    } catch (e: any) {
      showMsg('err', e.message || '대량등록 실패');
    } finally {
      setBulkImporting(false);
    }
  };


  const openListAdmitModal = () => {
    const firstWard = wards[0]?.id ?? '';
    setListAdmitForm({
      department_id: wardId || firstWard,
      room_no: '',
      bed_no: '',
      chart_no: '',
      name: '',
      gender: 'F',
      mobility_type: 'BEDRIDDEN',
      insurance_type: 'HEALTH',
      copay_reduction: 'NONE',
      patient_group: 'UNRATED',
      specializations: [],
      infection_strain: '',
      period_type: '',
      period_phase: '',
      period_start_date: '',
      period_end_date: '',
      diaper_state: 'NONE',
      diaper_price: '',
      diaper_start_date: '',
      diaper_end_date: '',
      prev_hospital: '',
      acquaintance: '',
      acquaintance_color: '#0ea5e9',
      admitted_at: new Date().toISOString().slice(0, 10),
      note: '',
      disease_code_id: '',
      disease_code_registered_at: '',
      disease_code_expires_at: '',
      main_disease_code_id: '',
      caregiver_type: '',
      guardian_name: '',
      billing_sms_phone: '',
      project_name: '',
      project_region: '',
      project_sigungu_office: '',
      address: '',
      referral_source: '',
      discharge_type: '',
      rehab_type: '',
      onset_date: '',
    });
    setListAdmitOpen(true);
  };

  const admitFromList = async () => {
    if (admittingRef.current) return;
    if (!listAdmitForm.department_id || !listAdmitForm.room_no || !listAdmitForm.bed_no || !listAdmitForm.chart_no || !listAdmitForm.name) {
      showMsg('err', '병동/병실/자리/차트번호/이름을 입력해 주세요.');
      return;
    }
    const projectError = validateProjectScopeInput(listAdmitForm.project_name, listAdmitForm.project_region, listAdmitForm.project_sigungu_office);
    if (projectError) {
      showMsg('err', projectError);
      return;
    }
    admittingRef.current = true;
    setAdmitLoading(true);
    try {
      // 입원전병원 자동 등록
      if (listAdmitForm.prev_hospital?.trim() && !hospitals.some(h => h.name === listAdmitForm.prev_hospital.trim())) {
        try { await api('/patients/hospitals', { method: 'POST', body: JSON.stringify({ name: listAdmitForm.prev_hospital.trim() }) }); loadHospitals(); } catch { /* 중복 무시 */ }
      }
      await api('/patients/admit', {
        method: 'POST',
        body: JSON.stringify({
          department_id: listAdmitForm.department_id,
          room_no: listAdmitForm.room_no,
          bed_no: Number(listAdmitForm.bed_no),
          patient_no: listAdmitForm.chart_no,
          chart_no: listAdmitForm.chart_no,
          name: listAdmitForm.name,
          gender: listAdmitForm.gender,
          mobility_type: listAdmitForm.mobility_type,
          insurance_type: listAdmitForm.insurance_type,
          patient_group: listAdmitForm.patient_group,
          specializations: listAdmitForm.specializations,
          infection_strain: listAdmitForm.infection_strain,
          period_type: listAdmitForm.period_type,
          period_phase: listAdmitForm.period_phase || '',
          period_start_date: listAdmitForm.period_start_date || '',
          period_end_date: listAdmitForm.period_end_date || '',
          diaper_state: listAdmitForm.diaper_state,
          diaper_price: listAdmitForm.diaper_price ? Number(listAdmitForm.diaper_price) : null,
          diaper_start_date: listAdmitForm.diaper_start_date || null,
          diaper_end_date: listAdmitForm.diaper_end_date || null,
          prev_hospital: listAdmitForm.prev_hospital,
          acquaintance: listAdmitForm.acquaintance,
          acquaintance_color: listAdmitForm.acquaintance_color,
          main_disease_code_id: listAdmitForm.main_disease_code_id || null,
          caregiver_type: listAdmitForm.caregiver_type || '',
          guardian_name: listAdmitForm.guardian_name || '',
          billing_sms_phone: listAdmitForm.billing_sms_phone || '',
          project_name: listAdmitForm.project_name || '',
          project_region: listAdmitForm.project_region || '',
          project_sigungu_office: listAdmitForm.project_sigungu_office || '',
          address: listAdmitForm.address || '',
          referral_source: listAdmitForm.referral_source || '',
          rehab_type: listAdmitForm.rehab_type || '',
          onset_date: listAdmitForm.onset_date || null,
          admitted_at: listAdmitForm.admitted_at,
          note: listAdmitForm.note || '',
          disease_code_id: listAdmitForm.disease_code_id || null,
          disease_code_registered_at: listAdmitForm.disease_code_registered_at || null,
          disease_code_expires_at: listAdmitForm.disease_code_expires_at || null,
        }),
      });
      setListAdmitOpen(false);
      showMsg('ok', '입원 등록 완료');
      loadBoard();
      loadPatients();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setAdmitLoading(false);
      admittingRef.current = false;
    }
  };

  const discharge = async (id: string, dischargeType?: string, dischargeReason?: string) => {
    try {
      await api(`/patients/${id}/discharge`, { method: 'POST', body: JSON.stringify({ discharged_at: new Date().toISOString().slice(0, 10), discharge_type: dischargeType || '', discharge_reason: dischargeReason || '' }) });
      showMsg('ok', '퇴원 처리 완료');
      loadPatients();
      loadBoard();
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  // V코드 마스터 저장
  const saveCode = async () => {
    if (!codeForm.code || !codeForm.name) return showMsg('err', '코드번호와 질환명을 입력해 주세요.');
    setCodeSaving(true);
    try {
      if (editingCodeId) {
        await api(`/disease-codes/${editingCodeId}`, {
          method: 'PUT',
          body: JSON.stringify(codeForm),
        });
      } else {
        await api('/disease-codes', {
          method: 'POST',
          body: JSON.stringify(codeForm),
        });
      }
      setCodeEditOpen(false);
      setEditingCodeId(null);
      setCodeForm({ code: '', name: '', code_type: 'MAIN' });
      await loadDiseaseCodes();
      showMsg('ok', editingCodeId ? '코드 수정 완료' : '코드 등록 완료');
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setCodeSaving(false);
    }
  };

  const deleteCode = async (id: string) => {
    if (!window.confirm('이 코드를 삭제하시겠습니까?')) return;
    try {
      await api(`/disease-codes/${id}`, { method: 'DELETE' });
      await loadDiseaseCodes();
      showMsg('ok', '삭제 완료');
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const syncHiraDiseaseCodes = async () => {
    if (!window.confirm('HIRA API에서 전체 질병코드(약 2,000건)를 가져와 등록합니다. 진행하시겠습니까?')) return;
    setHiraSyncing(true);
    try {
      const result = await api('/hira/sync-disease-codes', { method: 'POST' });
      showMsg('ok', result.message || '동기화 완료');
      await loadDiseaseCodes();
    } catch (e: any) {
      showMsg('err', e.message || '동기화 실패');
    } finally {
      setHiraSyncing(false);
    }
  };

  const searchHiraCode = async (page = 1) => {
    if (!hiraCodeSearch.trim()) return;
    setHiraCodeLoading(true);
    try {
      const params = new URLSearchParams({ search: hiraCodeSearch.trim(), searchType: hiraSearchType, pageNo: String(page), numOfRows: '20' });
      const data = await api(`/hira/disease-codes?${params}`);
      setHiraCodeResults(data.items ?? []);
      setHiraCodeTotal(data.totalCount ?? 0);
      setHiraCodePage(page);
    } catch (e: any) {
      showMsg('err', e.message || 'HIRA 검색 실패');
    } finally {
      setHiraCodeLoading(false);
    }
  };

  const selectHiraCode = (item: HiraDiseaseCodeResult) => {
    setCodeForm(f => ({ ...f, code: item.sickCd, name: item.sickNm }));
    setHiraCodeModal(false);
    showMsg('ok', `"${item.sickCd} ${item.sickNm}" 선택됨`);
  };

  // 재등록 이력 저장
  const saveReg = async () => {
    if (!regForm.patient_id || !regForm.disease_code_id || !regForm.registered_at) {
      return showMsg('err', '환자, V코드, 등록일은 필수입니다.');
    }
    setRegSaving(true);
    try {
      if (editingRegId) {
        await api(`/disease-codes/patient-registrations/${editingRegId}`, {
          method: 'PUT',
          body: JSON.stringify(regForm),
        });
      } else {
        await api('/disease-codes/patient-registrations', {
          method: 'POST',
          body: JSON.stringify(regForm),
        });
      }
      setRegEditOpen(false);
      setEditingRegId(null);
      setRegForm({ patient_id: '', disease_code_id: '', registered_at: '', expires_at: '', note: '' });
      await loadPatientDiseaseRows();
      showMsg('ok', editingRegId ? '수정 완료' : '등록 완료');
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setRegSaving(false);
    }
  };

  const deleteReg = async (id: string) => {
    if (!window.confirm('이 이력을 삭제하시겠습니까?')) return;
    try {
      await api(`/disease-codes/patient-registrations/${id}`, { method: 'DELETE' });
      await loadPatientDiseaseRows();
      showMsg('ok', '삭제 완료');
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const wardButtons = wards.map(w => (
    <button
      key={w.id}
      onClick={() => {
        setWardId(w.id);
        setRoomEditMode(false);
      }}
      className={`px-3 py-1.5 rounded-lg border text-sm ${wardId === w.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-gray-200'}`}
    >
      {w.name}
    </button>
  ));

  const startRoomEdit = () => {
    if (!wardId) {
      showMsg('err', '병동을 먼저 선택해 주세요.');
      return;
    }
    setRoomDraftRows(
      wardRoomRows.map((r, idx) => ({
        id: r.id,
        room_no: r.room_no,
        capacity: r.capacity,
        sort_order: r.sort_order ?? idx + 1,
        is_active: r.is_active,
        is_hospice: (r as any).is_hospice || false,
      }))
    );
    setRoomEditMode(true);
  };

  const addRoomRow = () => {
    setRoomDraftRows(prev => ([
      ...prev,
      { room_no: '', capacity: 6, sort_order: prev.length + 1, is_active: true, is_hospice: false },
    ]));
  };

  const removeRoomRow = (idx: number) => {
    setRoomDraftRows(prev => prev.filter((_, i) => i !== idx).map((r, i) => ({ ...r, sort_order: i + 1 })));
  };

  const saveRoomConfig = async () => {
    if (!wardId) return;
    const cleaned = roomDraftRows
      .map((r, i) => ({ ...r, room_no: r.room_no.trim(), capacity: Math.max(1, Number(r.capacity || 1)), sort_order: i + 1 }))
      .filter(r => r.room_no.length > 0);
    if (cleaned.length === 0) {
      showMsg('err', '최소 1개 병실은 필요합니다.');
      return;
    }
    const hasDup = new Set(cleaned.map(r => r.room_no)).size !== cleaned.length;
    if (hasDup) {
      showMsg('err', '중복된 병실명이 있습니다.');
      return;
    }
    setRoomSaving(true);
    try {
      await api(`/patients/room-config/${wardId}`, {
        method: 'PUT',
        body: JSON.stringify({ rooms: cleaned }),
      });
      showMsg('ok', '병실 설정 저장 완료');
      setRoomEditMode(false);
      await loadConfig();
      await loadBoard();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setRoomSaving(false);
    }
  };

  const extractPeriodFromNote = (note?: string) => {
    const text = String(note || '');
    const m = text.match(/\[기간:([^\]~]+)~([^\]]+)\]/);
    if (!m) return { start: '', end: '' };
    const start = m[1] === '-' ? '' : m[1];
    const end = m[2] === '-' ? '' : m[2];
    return { start, end };
  };

  const admitFromBoard = async () => {
    if (admittingRef.current) return;
    if (!selectedCell) return;
    if (!selectedCell.patient_name?.trim()) return showMsg('err', '성명을 입력해 주세요.');
    if (!selectedCell.chart_no?.trim()) return showMsg('err', '차트번호를 입력해 주세요.');
    const projectError = validateProjectScopeInput(selectedCell.project_name, selectedCell.project_region, selectedCell.project_sigungu_office);
    if (projectError) return showMsg('err', projectError);
    admittingRef.current = true;
    setAdmitLoading(true);
    try {
      await api('/patients/admit', {
        method: 'POST',
        body: JSON.stringify({
          department_id: wardId,
          room_no: selectedCell.room_no,
          bed_no: selectedCell.bed_no,
          chart_no: selectedCell.chart_no,
          patient_no: selectedCell.chart_no,
          name: selectedCell.patient_name,
          gender: selectedCell.gender,
          mobility_type: selectedCell.mobility_type,
          insurance_type: selectedCell.insurance_type,
          patient_group: selectedCell.patient_group,
          specializations: selectedCell.specializations || [],
          infection_strain: selectedCell.infection_strain || '',
          period_type: selectedCell.period_type || '',
          period_phase: selectedCell.period_phase || '',
          period_start_date: selectedCell.period_start_date || '',
          period_end_date: selectedCell.period_end_date || '',
          diaper_state: selectedCell.diaper_state || '',
          diaper_price: selectedCell.diaper_price ?? null,
          diaper_start_date: selectedCell.diaper_start_date || null,
          diaper_end_date: selectedCell.diaper_end_date || null,
          prev_hospital: selectedCell.prev_hospital || '',
          acquaintance: selectedCell.acquaintance || '',
          acquaintance_color: selectedCell.acquaintance_color || '#0ea5e9',
          main_disease_code_id: selectedCell.main_disease_code_id || null,
          caregiver_type: selectedCell.caregiver_type || '',
          guardian_name: selectedCell.guardian_name || '',
          billing_sms_phone: selectedCell.billing_sms_phone || '',
          project_name: selectedCell.project_name || '',
          project_region: selectedCell.project_region || '',
          project_sigungu_office: selectedCell.project_sigungu_office || '',
          rehab_type: selectedCell.rehab_type || '',
          onset_date: selectedCell.onset_date || null,
          admitted_at: boardDate,
          note: selectedCell.note || '',
          disease_code_id: selectedCell.disease_code_id || null,
          disease_code_registered_at: selectedCell.disease_code_registered_at || null,
          disease_code_expires_at: selectedCell.disease_code_expires_at || null,
        }),
      });
      setSelectedCell(null);
      showMsg('ok', '입원 등록 완료');
      loadBoard();
      loadPatients();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setAdmitLoading(false);
      admittingRef.current = false;
    }
  };

  const dischargeFromBoard = async () => {
    if (!selectedCell) return;
    if (!confirm(`${selectedCell.patient_name} 환자를 퇴원 처리하시겠습니까?`)) return;
    try {
      let linkedId = selectedCell.patient_id
        || mergedPatients.find(p => p.status === 'ADMITTED' && p.room_no === selectedCell.room_no && Number(p.bed_no || 0) === Number(selectedCell.bed_no || 0))?.id;
      if (!linkedId) {
        const rows = await api('/patients?status=ADMITTED');
        linkedId = (rows || []).find((p: any) => p.room_no === selectedCell.room_no && Number(p.bed_no || 0) === Number(selectedCell.bed_no || 0))?.id;
      }
      if (!linkedId) return showMsg('err', '퇴원 처리할 환자 ID를 찾지 못했습니다.');
      await discharge(linkedId, selectedCell.discharge_type, (selectedCell as any).discharge_reason);
      setSelectedCell(null);
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };


  return (
    <div>
      <PageHeader
        icon={User}
        title="환자 관리"
        description={`${user?.department_name} · 환자/병실 통합 관리`}
      />

      <div className="flex border-b border-gray-200 mb-4">
        {MAJOR_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setMajorTab(t.key)}
            className={`px-5 py-2.5 text-sm border-b-2 ${majorTab === t.key ? 'border-blue-600 text-blue-700 font-semibold' : 'border-transparent text-slate-500'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className={`mb-4 p-3 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {majorTab === 'patients' && (
        <div className="space-y-3">
          <div className="card p-3 flex flex-wrap gap-2 items-center">
            <input className="input w-56 shrink-0" value={search} onChange={e => setSearch(e.target.value)} placeholder="이름/환자번호/병실 검색" />
            <SelectField value={statusFilter} onChange={v => setStatusFilter(v as any)} options={[
              { v: 'ADMITTED', l: '입원중' }, { v: 'DISCHARGED', l: '퇴원' }, { v: '', l: '전체' },
            ]} />
            <select className="input text-xs w-28 shrink-0" value={wardFilter} onChange={e => setWardFilter(e.target.value)}>
              <option value="">전체 병동</option>
              {wards.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select className="input text-xs w-28 shrink-0" value={insuranceFilter} onChange={e => setInsuranceFilter(e.target.value)}>
              <option value="">전체 보험</option>
              <option value="HEALTH">건강보험</option>
              <option value="MEDICAL_1">의료급여 1종</option>
              <option value="MEDICAL_2">의료급여 2종</option>
              <option value="WORKERS_COMP">산재보험</option>
              <option value="AUTO_INS">자동차보험</option>
            </select>
            <select className="input text-xs w-28 shrink-0" value={patientGroupFilter} onChange={e => setPatientGroupFilter(e.target.value)}>
              <option value="">전체 환자군</option>
              <option value="HIGHEST">최고도</option>
              <option value="HIGH">고도</option>
              <option value="MEDIUM">중도</option>
              <option value="LOW">경도</option>
              <option value="SELECT">선택</option>
              <option value="UNRATED">미평가</option>
              <option value="INFECTION">감염</option>
              <option value="PNEUMONIA">폐렴</option>
              <option value="SEPSIS">패혈증</option>
            </select>
            <select className="input text-xs w-28 shrink-0" value={specializationFilter} onChange={e => setSpecializationFilter(e.target.value)}>
              <option value="">전체 특성화</option>
              {SPECIALIZATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="input text-xs w-28 shrink-0" value={diaperFilter} onChange={e => setDiaperFilter(e.target.value as any)}>
              <option value="">기저귀 전체</option>
              <option value="USE">사용</option>
              <option value="NONE">미사용</option>
            </select>
            <select className="input text-xs w-28 shrink-0" value={rehabFilter} onChange={e => setRehabFilter(e.target.value)}>
              <option value="">재활구분 전체</option>
              {REHAB_TYPES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              <option value="NONE">해당없음</option>
            </select>
            <select className="input text-xs w-28 shrink-0" value={onsetFilter} onChange={e => setOnsetFilter(e.target.value)}>
              <option value="">Onset 전체</option>
              {ONSET_BUCKETS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
              <option value="NONE">미입력</option>
            </select>
            {(wardFilter || insuranceFilter || patientGroupFilter || specializationFilter || diaperFilter || rehabFilter || onsetFilter) && (
              <button className="btn-secondary text-xs shrink-0" onClick={() => { setWardFilter(''); setInsuranceFilter(''); setPatientGroupFilter(''); setSpecializationFilter(''); setDiaperFilter(''); setRehabFilter(''); setOnsetFilter(''); }}>초기화</button>
            )}
            <span className="text-xs text-slate-500 whitespace-nowrap shrink-0 ml-auto">총 {mergedPatients.length}명</span>
            <button onClick={loadPatients} className="btn-secondary shrink-0">조회</button>
            <button onClick={openListAdmitModal} className="btn-primary shrink-0">입원 등록</button>
            <button onClick={openBulkModal} className="btn-secondary shrink-0">엑셀/CSV</button>
            <button onClick={openSyncModal} className="btn-secondary shrink-0">엑셀로 최신화</button>
          </div>

          <div className="card">
            <button
              onClick={() => setStatsOpen(o => !o)}
              className="w-full flex items-center justify-between p-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <span>📊 통계 보기 ({patientStats.total}명 기준)</span>
              <span className="text-slate-400">{statsOpen ? '▲' : '▼'}</span>
            </button>
            {statsOpen && (
              <div className="border-t border-slate-100 p-3 space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <StatsKpiCard label="총 인원" value={patientStats.total} />
                  <StatsKpiCard label="입원중" value={patientStats.admitted} valueColor="text-green-600" />
                  <StatsKpiCard label="퇴원" value={patientStats.discharged} valueColor="text-slate-500" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <DistCard title="환자군" data={patientStats.byGroup} labelMap={valueLabel.patient_group} />
                  <DistCard title="보험" data={patientStats.byInsurance} labelMap={valueLabel.insurance_type} />
                  <DistCard title="특성화" data={patientStats.bySpec} labelMap={Object.fromEntries(SPECIALIZATION_OPTIONS.map(o => [o.value, o.label]))} />
                  <DistCard title="기저귀" data={{ USE: patientStats.diaperUse, NONE: patientStats.diaperNone }} labelMap={{ USE: '사용', NONE: '미사용' }} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <DistCard
                    title="재활구분"
                    data={patientStats.byRehab}
                    labelMap={{ CNS: 'CNS', OS: 'CNS 외', OUTPATIENT: '외래', NONE: '해당없음' }}
                  />
                  <DistCard
                    title="Onset (CNS)"
                    data={patientStats.byOnsetCNS}
                    labelMap={{
                      lt6m: '~6m', '6m_1y6m': '6m~1y6m', '1y6m_2y': '1y6m~2y',
                      '2y_5y': '2y~5y', '5y_7y': '5y~7y', gt7y: '7y+', none: '미입력',
                    }}
                  />
                  <DistCard
                    title="Onset (CNS 외)"
                    data={patientStats.byOnsetOS}
                    labelMap={{
                      lt6m: '~6m', '6m_1y6m': '6m~1y6m', '1y6m_2y': '1y6m~2y',
                      '2y_5y': '2y~5y', '5y_7y': '5y~7y', gt7y: '7y+', none: '미입력',
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="card p-0 overflow-auto">
            {loadingPatients ? <div className="py-16 text-center text-sm text-slate-400">로딩 중...</div> : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>차트번호</th><th>이름</th><th>병동</th><th>병실</th><th>자리</th><th>보험</th><th>환자군</th><th>재활</th><th>발병일</th><th>경과</th><th>특성화</th><th>기저귀</th><th>상태</th><th>처리</th>
                  </tr>
                </thead>
                <tbody>
                  {mergedPatients.map(r => {
                    const onsetDays = getOnsetDays(r.onset_date);
                    const onsetBucket = getOnsetBucketKey(r.onset_date);
                    return (
                    <tr key={r.id}>
                      <td className="text-xs font-mono">{r.chart_no}</td>
                      <td>{r.name}</td>
                      <td className="text-xs">{r.department_name}</td>
                      <td>{r.room_no}</td>
                      <td>{r.bed_no ?? '-'}</td>
                      <td className="text-xs">{toLabel('insurance_type', r.insurance_type)}</td>
                      <td className="text-xs">{toLabel('patient_group', r.patient_group)}</td>
                      <td className="text-xs">
                        {r.rehab_type ? (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${getRehabBadgeClass(r.rehab_type)}`}>{getRehabTypeLabel(r.rehab_type)}</span>
                        ) : <span className="text-slate-300">-</span>}
                      </td>
                      <td className="text-xs">{r.onset_date ? r.onset_date.slice(0, 10) : <span className="text-slate-300">-</span>}</td>
                      <td className="text-xs">
                        {onsetDays !== null ? (
                          <span className="whitespace-nowrap">
                            <span className="font-semibold">{formatOnsetDuration(onsetDays)}</span>
                            <span className="text-slate-400 ml-1">{getOnsetBucketLabel(onsetBucket)}</span>
                          </span>
                        ) : <span className="text-slate-300">-</span>}
                      </td>
                      <td className="text-xs">{(r.specializations || []).map(v => (SPECIALIZATION_OPTIONS.find(o => o.value === v)?.label ?? v)).join(', ') || '-'}</td>
                      <td className="text-xs">{r.diaper_state ? `${toLabel('diaper_state', r.diaper_state)}${r.diaper_price ? `(${r.diaper_price})` : ''}${r.diaper_start_date ? ` ${r.diaper_start_date.slice(0,10)}~${r.diaper_end_date ? r.diaper_end_date.slice(0,10) : ''}` : ''}` : '-'}</td>
                      <td><span className={r.status === 'ADMITTED' ? 'badge-green' : 'badge-gray'}>{r.status === 'ADMITTED' ? '입원중' : '퇴원'}</span></td>
                      <td>
                        {r.status === 'ADMITTED' ? (
                          <button className="btn-secondary text-xs" onClick={() => { if (confirm(`${r.name} 환자를 퇴원 처리하시겠습니까?`)) discharge(r.id); }}>퇴원</button>
                        ) : '-'}
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {majorTab === 'board' && (
        <div className="space-y-3">
          <div className="card p-3 flex flex-wrap gap-2 items-center">
            {wardButtons}
            {!roomEditMode ? (
              <button onClick={startRoomEdit} className="btn-secondary">병실 설정</button>
            ) : (
              <>
                <button onClick={() => setRoomEditMode(false)} className="btn-secondary">설정 취소</button>
                <button onClick={saveRoomConfig} disabled={roomSaving} className="btn-primary">
                  {roomSaving ? '저장 중...' : '병실 설정 저장'}
                </button>
              </>
            )}
            <input type="date" value={boardDate} onChange={e => setBoardDate(e.target.value)} className="input w-40 ml-auto" />
            <button onClick={loadBoard} className="btn-secondary">불러오기</button>
          </div>
          <div className="card p-3 flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="font-semibold text-slate-700">색상범례</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border border-pink-300 bg-pink-100" />여자</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border border-blue-300 bg-blue-100" />남자</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border border-gray-300 bg-white" />빈자리</span>
            <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border border-slate-300 bg-slate-100" />미지정</span>
          </div>
          {roomEditMode && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold">병실/인실 편집</div>
                <button onClick={addRoomRow} className="btn-secondary text-xs">+ 병실 추가</button>
              </div>
              <div className="overflow-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 80 }}>순서</th>
                      <th>병실</th>
                      <th style={{ width: 120 }}>인실</th>
                      <th style={{ width: 80 }}>임종실</th>
                      <th style={{ width: 100 }}>삭제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roomDraftRows.map((row, idx) => (
                      <tr key={`${row.id ?? 'new'}-${idx}`}>
                        <td>{idx + 1}</td>
                        <td>
                          <input
                            className="input h-9 text-sm"
                            placeholder="예: 201호"
                            value={row.room_no}
                            onChange={e => setRoomDraftRows(prev => prev.map((r, i) => i === idx ? { ...r, room_no: e.target.value } : r))}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            className="input h-9 text-sm"
                            value={row.capacity}
                            onChange={e => setRoomDraftRows(prev => prev.map((r, i) => i === idx ? { ...r, capacity: Math.max(1, Number(e.target.value || 1)) } : r))}
                          />
                        </td>
                        <td className="text-center">
                          <input type="checkbox" checked={row.is_hospice || false} onChange={e => setRoomDraftRows(prev => prev.map((r, i) => i === idx ? { ...r, is_hospice: e.target.checked } : r))} />
                        </td>
                        <td>
                           <button onClick={() => removeRoomRow(idx)} className="btn-danger text-xs">삭제</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-500 mt-2">예: 201호 6인실 → 3인실로 변경, 220호는 삭제 후 저장</p>
            </div>
          )}
          {loadingBoard ? <div className="py-16 text-center text-sm text-slate-400">로딩 중...</div> : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {boardRooms.map(room => (
                <div key={room.id} className="card p-3">
                  <div className="font-semibold text-sm mb-2">{room.room_no} · {room.capacity}인실{room.is_hospice && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-semibold">임종실</span>}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {room.cells.map(cell => {
                      const period = extractPeriodFromNote(cell.note);
                      return (
                        <button
                          key={cell.id}
                          onClick={() => {
                            const linked = cell.patient_id ? mergedPatients.find(p => p.id === cell.patient_id) : null;
                            // 환자 변경 시 비급여 입력칸을 0원 구조체로 즉시 리셋 — 직전 환자 금액 잔상 차단 (input은 그대로 보임)
                            setChargeLoadedFor('');
                            setChargeItems(emptyChargeItems());
                            setSelectedCell({
                              ...cell,
                              period_start_date: period.start,
                              period_end_date: period.end,
                              disease_code_id: linked?.disease_code_id ?? null,
                              disease_code_registered_at: linked?.disease_code_registered_at ?? null,
                              disease_code_expires_at: linked?.disease_code_expires_at ?? null,
                              main_disease_code_id: linked?.main_disease_code_id ?? cell.main_disease_code_id ?? null,
                              caregiver_type: cell.caregiver_type || '',
                              guardian_name: cell.guardian_name || linked?.guardian_name || '',
                              billing_sms_phone: cell.billing_sms_phone || linked?.billing_sms_phone || '',
                              project_name: cell.project_name || linked?.project_name || '',
                              project_region: cell.project_region || linked?.project_region || '',
                              project_sigungu_office: cell.project_sigungu_office || linked?.project_sigungu_office || '',
                            });
                          }}
                          className={`border rounded-lg p-2 text-left transition-colors ${bedCellToneClass(cell)}`}
                        >
                          <div className="text-[11px] text-slate-500">{cell.bed_no}번 자리</div>
                          <div className="text-sm font-bold truncate">{cell.patient_name || '빈자리'}</div>
                          <div className="text-[11px] text-slate-600 truncate">{cell.patient_name ? `${cell.gender === 'F' ? '여' : cell.gender === 'M' ? '남' : '-'} · ${toLabel('insurance_type', cell.insurance_type)}${cell.copay_reduction && cell.copay_reduction !== 'NONE' ? `(${toLabel('copay_reduction', cell.copay_reduction)})` : ''} · ${toLabel('patient_group', cell.patient_group)}` : '\u00A0'}</div>
                          {cell.infection_strain && <div className="text-[10px] text-red-600 font-semibold">{cell.infection_strain}</div>}
                          {cell.patient_name && cell.rehab_type ? (() => {
                            const days = getOnsetDays(cell.onset_date);
                            const bucketKey = getOnsetBucketKey(cell.onset_date);
                            return (
                              <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                                <span className={`text-[10px] px-1.5 rounded border font-semibold ${getRehabBadgeClass(cell.rehab_type)}`}>{getRehabTypeLabel(cell.rehab_type)}</span>
                                {days !== null ? (
                                  <>
                                    <span className="text-[10px] text-slate-700 font-semibold">D+{days}</span>
                                    <span className="text-[10px] text-slate-500">{getOnsetBucketLabel(bucketKey)}</span>
                                  </>
                                ) : null}
                              </div>
                            );
                          })() : null}
                          {(cell.status === 'OUTING' || cell.status === 'OVERNIGHT') && <div className="text-[10px] text-indigo-600 font-semibold">{cell.status === 'OUTING' ? '외출' : '외박'}</div>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {majorTab === 'disease' && (
        <div className="space-y-3">
          {/* 서브탭 */}
          <div className="flex border-b border-gray-200">
            {([{ key: 'reregistration', label: '재등록관리' }, { key: 'codes', label: '코드등록' }] as { key: DiseaseSubTab; label: string }[]).map(t => (
              <button
                key={t.key}
                onClick={() => setDiseaseSubTab(t.key)}
                className={`px-4 py-2 text-sm border-b-2 ${diseaseSubTab === t.key ? 'border-blue-600 text-blue-700 font-semibold' : 'border-transparent text-slate-500'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 코드등록 */}
          {diseaseSubTab === 'codes' && (
            <div className="space-y-3">
              <div className="card p-3 flex flex-wrap gap-2 items-center">
                <span className="text-sm font-medium text-slate-700">주상병코드 / V코드 마스터 관리</span>
                <SelectField value={codeTypeFilter} onChange={v => setCodeTypeFilter(v as any)} options={[{ v: '', l: '전체' }, { v: 'MAIN', l: '주상병' }, { v: 'SEVERE', l: '중증질환' }, { v: 'RARE', l: '희귀난치성' }]} />
                <button onClick={syncHiraDiseaseCodes} disabled={hiraSyncing} className="btn-secondary ml-auto text-xs">{hiraSyncing ? '동기화 중...' : 'HIRA 전체 동기화'}</button>
                <button onClick={() => { setEditingCodeId(null); setCodeForm({ code: '', name: '', code_type: 'MAIN' }); setCodeEditOpen(true); }} className="btn-primary">코드 추가</button>
              </div>
              <div className="card p-0 overflow-auto">
                <table className="tbl">
                  <thead>
                    <tr><th>코드번호</th><th>질환명</th><th>유형</th><th>상태</th><th>처리</th></tr>
                  </thead>
                  <tbody>
                    {diseaseCodes.filter(c => !codeTypeFilter || c.code_type === codeTypeFilter).map(c => (
                      <tr key={c.id}>
                        <td className="font-mono font-semibold">{c.code}</td>
                        <td>{c.name}</td>
                        <td>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${c.code_type === 'MAIN' ? 'bg-blue-100 text-blue-700' : c.code_type === 'SEVERE' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>
                            {CODE_TYPE_LABEL[c.code_type] ?? c.code_type}
                          </span>
                        </td>
                        <td><span className={c.is_active ? 'badge-green' : 'badge-gray'}>{c.is_active ? '활성' : '비활성'}</span></td>
                        <td>
                          <div className="flex gap-2">
                            <button className="btn-secondary text-xs" onClick={() => { setEditingCodeId(c.id); setCodeForm({ code: c.code, name: c.name, code_type: c.code_type }); setCodeEditOpen(true); }}>수정</button>
                            <button className="btn-danger text-xs" onClick={() => deleteCode(c.id)}>삭제</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {diseaseCodes.filter(c => !codeTypeFilter || c.code_type === codeTypeFilter).length === 0 && (
                      <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-400">등록된 코드가 없습니다.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 재등록관리 */}
          {diseaseSubTab === 'reregistration' && (() => {
            const today = new Date().toISOString().slice(0, 10);
            const filtered = patientDiseaseRows.filter(r => !regTypeFilter || r.code_type === regTypeFilter);
            return (
              <div className="space-y-3">
                <div className="card p-3 flex flex-wrap gap-2 items-center">
                  <span className="text-sm font-medium text-slate-700">환자별 V코드 이력</span>
                  <SelectField value={regTypeFilter} onChange={v => setRegTypeFilter(v as any)} options={[{ v: '', l: '전체' }, { v: 'SEVERE', l: '중증질환' }, { v: 'RARE', l: '희귀난치성' }]} />
                  <button onClick={loadPatientDiseaseRows} className="btn-secondary">새로고침</button>
                  <button onClick={() => { setEditingRegId(null); setRegForm({ patient_id: '', disease_code_id: '', registered_at: '', expires_at: '', note: '' }); setRegEditOpen(true); }} className="btn-primary ml-auto">이력 등록</button>
                </div>
                <div className="card p-0 overflow-auto">
                  <table className="tbl">
                    <thead>
                      <tr><th>환자번호</th><th>환자명</th><th>병동</th><th>병실</th><th>보험유형</th><th>V코드</th><th>질환명</th><th>유형</th><th>등록일</th><th>만료일</th><th>상태</th><th>처리</th></tr>
                    </thead>
                    <tbody>
                      {filtered.map(r => {
                        const isExpired = r.expires_at && r.expires_at < today;
                        const isNearExpiry = !isExpired && r.expires_at && r.expires_at <= new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
                        return (
                          <tr key={r.id} className={isExpired ? 'bg-red-50' : isNearExpiry ? 'bg-orange-50' : ''}>
                            <td className="text-xs font-mono">{r.chart_no}</td>
                            <td>{r.patient_name}</td>
                            <td className="text-xs">{r.department_name}</td>
                            <td className="text-xs">{r.room_no || '-'}</td>
                            <td className="text-xs">{r.insurance_type === 'HEALTH_REDUCED_SEVERE' ? '중증질환' : r.insurance_type === 'HEALTH_REDUCED_RARE' ? '희귀난치성' : r.insurance_type}</td>
                            <td className="font-mono font-semibold">{r.code}</td>
                            <td className="text-xs">{r.name}</td>
                            <td><span className={`text-xs px-1.5 py-0.5 rounded-full ${r.code_type === 'SEVERE' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>{r.code_type === 'SEVERE' ? '중증' : '희귀'}</span></td>
                            <td className="text-xs">{r.registered_at}</td>
                            <td className="text-xs">
                              <span className={isExpired ? 'text-red-600 font-semibold' : isNearExpiry ? 'text-orange-600 font-semibold' : ''}>{r.expires_at || '-'}</span>
                              {isExpired && <span className="ml-1 text-red-500 text-xs">[만료]</span>}
                              {isNearExpiry && <span className="ml-1 text-orange-500 text-xs">[임박]</span>}
                            </td>
                            <td><span className={r.is_active ? 'badge-green' : 'badge-gray'}>{r.is_active ? '유효' : '비활성'}</span></td>
                            <td>
                              <div className="flex gap-2">
                                <button className="btn-secondary text-xs" onClick={() => { setEditingRegId(r.id); setRegForm({ patient_id: r.patient_id, disease_code_id: r.disease_code_id, registered_at: r.registered_at, expires_at: r.expires_at ?? '', note: r.note }); setRegEditOpen(true); }}>수정</button>
                                <button className="btn-danger text-xs" onClick={() => deleteReg(r.id)}>삭제</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {filtered.length === 0 && (
                        <tr><td colSpan={12} className="py-8 text-center text-sm text-slate-400">등록된 이력이 없습니다.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {selectedCell && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setSelectedCell(null); }}>
          <div className="modal" style={{ width: 1200, maxWidth: '96vw', height: 720, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
            {/* 헤더: 환자 요약 */}
            <div className="modal-header" style={{ flexShrink: 0 }}>
              <div className="flex items-center gap-3">
                <h2 className="modal-title text-base font-bold">{selectedCell.patient_name || '빈자리'}</h2>
                <div className="flex gap-1">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">{selectedCell.room_no} {selectedCell.bed_no}번</span>
                  {selectedCell.chart_no && <span className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-slate-600">{selectedCell.chart_no}</span>}
                  {(selectedCell.gender === 'F' || selectedCell.gender === 'M') && <span className="text-[10px] px-2 py-0.5 rounded bg-green-100 text-green-700">{selectedCell.gender === 'F' ? '여' : '남'} · {toLabel('mobility_type', selectedCell.mobility_type)}</span>}
                  {selectedCell.gender && selectedCell.gender !== 'F' && selectedCell.gender !== 'M' && <span className="text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 font-semibold">⚠ 성별 미설정</span>}
                  {selectedCell.insurance_type && <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-700">{toLabel('insurance_type', selectedCell.insurance_type)}{selectedCell.copay_reduction && selectedCell.copay_reduction !== 'NONE' ? ` (${toLabel('copay_reduction', selectedCell.copay_reduction)})` : ''} · {toLabel('patient_group', selectedCell.patient_group)}</span>}
                  {selectedCell.period_type && <span className="text-[10px] px-2 py-0.5 rounded bg-orange-100 text-orange-700 font-semibold">{selectedCell.period_type === 'PNEUMONIA' ? '폐렴' : '패혈증'}{selectedCell.period_phase === 'START' ? ' (진행중)' : selectedCell.period_phase === 'END' ? ' (종료)' : ''}</span>}
                </div>
              </div>
              <button className="text-xl text-slate-400" onClick={() => setSelectedCell(null)}>&times;</button>
            </div>
            {/* 탭 바 */}
            <div className="flex border-b border-gray-200 px-5 bg-gray-50" style={{ flexShrink: 0 }}>
              {[
                { label: '기본정보', icon: '📋', active: 'border-blue-500 text-blue-600' },
                { label: '간호·비급여', icon: '🩺', active: 'border-teal-500 text-teal-600' },
                { label: '보호자', icon: '📞', active: 'border-purple-500 text-purple-600' },
                { label: '환자통계', icon: '📊', active: 'border-slate-500 text-slate-600' },
              ].map((tab, i) => (
                <button key={i} onClick={() => { setCellEditTab(i as any); if (i === 3 && selectedCell?.patient_id) api(`/patients/${selectedCell.patient_id}/events`).then(setPatientEvents).catch(() => {}); }} className={`px-4 py-2.5 text-[13px] font-semibold border-b-2 -mb-px flex items-center gap-1 ${cellEditTab === i ? tab.active : 'border-transparent text-slate-400 hover:text-slate-600'}`}><span className="text-sm">{tab.icon}</span>{tab.label}</button>
              ))}
            </div>
            {/* 탭 내용 */}
            <div className="flex-1 overflow-y-auto p-5">
              {/* ━━━ 탭0: 기본정보 ━━━ */}
              {cellEditTab === 0 && (
                <div className="space-y-4">
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />인적사항</p>
                    <div className="grid grid-cols-4 gap-3">
                      <div><label className="text-[10px] text-slate-500 font-semibold">성명</label><input className="input w-full" value={selectedCell.patient_name} onChange={e => setSelectedCell({ ...selectedCell, patient_name: e.target.value })} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">차트번호</label><input className="input w-full" value={selectedCell.chart_no} onChange={e => setSelectedCell({ ...selectedCell, chart_no: e.target.value, patient_no: e.target.value })} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">성별</label><SelectField value={selectedCell.gender === 'F' || selectedCell.gender === 'M' ? selectedCell.gender : ''} onChange={v => setSelectedCell({ ...selectedCell, gender: v })} options={[{ v: '', l: '미설정 (선택 필요)' }, { v: 'F', l: '여' }, { v: 'M', l: '남' }]} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">거동상태</label><SelectField value={selectedCell.mobility_type} onChange={v => setSelectedCell({ ...selectedCell, mobility_type: v })} options={[{ v: 'BEDRIDDEN', l: '와상' }, { v: 'AMBULATORY', l: '거동' }]} /></div>
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />보험 · 분류</p>
                    <div className="grid grid-cols-4 gap-3">
                      <div><label className="text-[10px] text-slate-500 font-semibold">보험유형</label><GroupedSelectField value={selectedCell.insurance_type} onChange={v => setSelectedCell({ ...selectedCell, insurance_type: v })} groups={INSURANCE_GROUPS} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">환자분류</label><SelectField value={selectedCell.patient_group} onChange={v => {
                        const today = new Date().toISOString().slice(0, 10);
                        if (v === 'PNEUMONIA' || v === 'SEPSIS') {
                          setSelectedCell({ ...selectedCell, patient_group: v, period_type: v, period_phase: 'START', period_start_date: today });
                          return;
                        }
                        const activePeriod = selectedCell.period_type && selectedCell.period_phase === 'START';
                        if (activePeriod) {
                          const periodLabel = selectedCell.period_type === 'PNEUMONIA' ? '폐렴' : '패혈증';
                          if (window.confirm(`현재 ${periodLabel} 진행 중입니다. 함께 종료할까요?\n\n확인: 특정기간을 오늘 날짜로 종료\n취소: 환자분류만 변경 (특정기간 유지)`)) {
                            setSelectedCell({ ...selectedCell, patient_group: v, period_phase: 'END', period_end_date: today });
                            return;
                          }
                        }
                        setSelectedCell({ ...selectedCell, patient_group: v });
                      }} options={[{ v: 'HIGHEST', l: '최고도' }, { v: 'HIGH', l: '고도' }, { v: 'MEDIUM', l: '중도' }, { v: 'LOW', l: '경도' }, { v: 'SELECT', l: '선택' }, { v: 'UNRATED', l: '미평가' }, { v: 'INFECTION', l: '감염' }, { v: 'PNEUMONIA', l: '폐렴' }, { v: 'SEPSIS', l: '패혈증' }]} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">주상병코드</label><SearchableSelect value={selectedCell.main_disease_code_id || ''} onChange={v => setSelectedCell({ ...selectedCell, main_disease_code_id: v || null })} placeholder="주상병코드 검색..." options={[{ v: '', l: '선택 안함' }, ...diseaseCodes.filter(c => c.is_active && c.code_type === 'MAIN').map(c => ({ v: c.id, l: `${c.code} ${c.name}` }))]} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">입원일</label><input type="date" className="input w-full" value={selectedCell.admitted_at || ''} onChange={e => setSelectedCell({ ...selectedCell, admitted_at: e.target.value })} /></div>
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-orange-500" />특정기간</p>
                    <div className="grid grid-cols-4 gap-3 items-end">
                      <div><label className="text-[10px] text-slate-500 font-semibold">질환</label><SelectField value={selectedCell.period_type} onChange={v => setSelectedCell({ ...selectedCell, period_type: v, ...(v ? {} : { period_start_date: '', period_end_date: '', period_phase: '' }) })} options={[{ v: '', l: '없음' }, { v: 'PNEUMONIA', l: '폐렴' }, { v: 'SEPSIS', l: '패혈증' }]} /></div>
                      <div>
                        <label className="text-[10px] text-slate-500 font-semibold">상태</label>
                        <div className="flex gap-1.5 mt-0.5">
                          <button type="button" disabled={!selectedCell.period_type} onClick={() => { const today = new Date().toISOString().slice(0, 10); setSelectedCell({ ...selectedCell, period_phase: 'START', period_start_date: today }); }} className={`px-3 py-1.5 text-xs rounded border font-semibold ${selectedCell.period_phase === 'START' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-gray-200'} disabled:opacity-40`}>시작</button>
                          <button type="button" disabled={!selectedCell.period_type} onClick={() => { const today = new Date().toISOString().slice(0, 10); setSelectedCell({ ...selectedCell, period_phase: 'END', period_end_date: today }); }} className={`px-3 py-1.5 text-xs rounded border font-semibold ${selectedCell.period_phase === 'END' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-slate-600 border-gray-200'} disabled:opacity-40`}>종료</button>
                        </div>
                      </div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">시작일</label><input type="date" className="input w-full" value={selectedCell.period_start_date || ''} onChange={e => setSelectedCell({ ...selectedCell, period_start_date: e.target.value, period_phase: e.target.value ? 'START' : selectedCell.period_phase })} disabled={!selectedCell.period_type} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">종료일</label><input type="date" className="input w-full" value={selectedCell.period_end_date || ''} onChange={e => setSelectedCell({ ...selectedCell, period_end_date: e.target.value, period_phase: e.target.value ? 'END' : selectedCell.period_phase })} disabled={!selectedCell.period_type} /></div>
                    </div>
                  </div>
                </div>
              )}
              {/* ━━━ 탭1: 간호·비급여 ━━━ */}
              {cellEditTab === 1 && (
                <div className="space-y-4">
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />기저귀 · 간병</p>
                    <div className="grid grid-cols-4 gap-3">
                      <div><label className="text-[10px] text-slate-500 font-semibold">기저귀</label><SelectField value={selectedCell.diaper_state || 'NONE'} onChange={v => setSelectedCell({ ...selectedCell, diaper_state: v, ...(v === 'IN_HOUSE' ? {} : { diaper_price: 0 }) })} options={[{ v: 'NONE', l: '미사용' }, { v: 'IN_HOUSE', l: '원내' }, { v: 'PERSONAL', l: '본인' }]} /></div>
                      {selectedCell.diaper_state === 'IN_HOUSE' && (
                        <>
                          <div><label className="text-[10px] text-slate-500 font-semibold">기저귀 금액</label><input type="number" className="input w-full" placeholder="기저귀 금액(원내만)" value={selectedCell.diaper_price ?? ''} onChange={e => setSelectedCell({ ...selectedCell, diaper_price: Number(e.target.value) || 0 })} /></div>
                          <div><label className="text-[10px] text-slate-500 font-semibold">시작일</label><input type="date" className="input w-full" value={selectedCell.diaper_start_date || ''} onChange={e => setSelectedCell({ ...selectedCell, diaper_start_date: e.target.value || null })} /></div>
                          <div><label className="text-[10px] text-slate-500 font-semibold">종료일</label><input type="date" className="input w-full" value={selectedCell.diaper_end_date || ''} onChange={e => setSelectedCell({ ...selectedCell, diaper_end_date: e.target.value || null })} /></div>
                        </>
                      )}
                      <div><label className="text-[10px] text-slate-500 font-semibold">간병유형</label><SelectField value={selectedCell.caregiver_type || ''} onChange={v => setSelectedCell({ ...selectedCell, caregiver_type: v })} options={CAREGIVER_OPTIONS} /></div>
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />특성화 · 감염</p>
                    <div className="grid grid-cols-4 gap-3">
                      <div><label className="text-[10px] text-slate-500 font-semibold">특성화</label><div className="flex gap-1 mt-1">{SPECIALIZATION_OPTIONS.map(opt => (<button key={opt.value} type="button" onClick={() => { const cur = new Set<string>(selectedCell.specializations || []); if (cur.has(opt.value)) cur.delete(opt.value); else cur.add(opt.value); setSelectedCell({ ...selectedCell, specializations: Array.from(cur), ...(opt.value === 'INFECT' && !cur.has('INFECT') ? { infection_strain: '' } : {}) }); }} className={`px-2 py-1 text-xs rounded border ${(selectedCell.specializations || []).includes(opt.value) ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-slate-600 border-gray-200'}`}>{opt.label}</button>))}</div></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">감염균주</label><SelectField value={selectedCell.infection_strain} onChange={v => setSelectedCell({ ...selectedCell, infection_strain: v })} options={[{ v: '', l: '없음' }, { v: 'CRE', l: 'CRE' }, { v: 'VRE', l: 'VRE' }, { v: 'MR', l: 'MR' }]} disabled={!(selectedCell.specializations || []).includes('INFECT')} /></div>
                    </div>
                  </div>
                  {/* 재활구분 / 발병일 (CNS·OS·외래) */}
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-500" />재활구분 / 발병일</p>
                    <div className="grid grid-cols-4 gap-3 items-end">
                      <div>
                        <label className="text-[10px] text-slate-500 font-semibold">재활구분</label>
                        <SelectField
                          value={selectedCell.rehab_type || ''}
                          onChange={v => setSelectedCell({ ...selectedCell, rehab_type: v, ...(v ? {} : { onset_date: null }) })}
                          options={[{ v: '', l: '해당없음' }, { v: 'CNS', l: 'CNS (뇌신경계)' }, { v: 'OS', l: 'CNS 외 (정형·기타)' }, { v: 'OUTPATIENT', l: '외래' }]}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 font-semibold">발병일</label>
                        <input
                          type="date"
                          className="input w-full"
                          value={selectedCell.onset_date || ''}
                          onChange={e => setSelectedCell({ ...selectedCell, onset_date: e.target.value || null })}
                          disabled={!selectedCell.rehab_type || selectedCell.rehab_type === 'OUTPATIENT'}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-slate-500 font-semibold">경과 / 분류</label>
                        {(() => {
                          const days = getOnsetDays(selectedCell.onset_date);
                          const bucketKey = getOnsetBucketKey(selectedCell.onset_date);
                          const badgeClass = getRehabBadgeClass(selectedCell.rehab_type);
                          return (
                            <div className="flex items-center gap-2 h-10">
                              {selectedCell.rehab_type ? (
                                <span className={`text-[11px] px-2 py-0.5 rounded border font-semibold ${badgeClass}`}>{getRehabTypeLabel(selectedCell.rehab_type)}</span>
                              ) : null}
                              {days !== null ? (
                                <>
                                  <span className="text-xs text-slate-700 font-semibold">D+{days}</span>
                                  <span className="text-[11px] text-slate-500">({formatOnsetDuration(days)})</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">{getOnsetBucketLabel(bucketKey)}</span>
                                </>
                              ) : (
                                <span className="text-xs text-slate-300">발병일 미입력</span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                  {/* 처치 항목 */}
                  {selectedCell.patient_id && (
                    <div>
                      <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-500" />처치 항목</p>
                      <div className="border rounded-lg p-2 bg-amber-50 border-amber-200">
                        <button type="button" className="w-full flex items-center justify-between text-xs font-semibold text-amber-700" onClick={() => { if (!treatmentOpen) loadPatientTreatments(selectedCell.patient_id!); setTreatmentOpen(!treatmentOpen); }}>
                          <span>처치 항목 관리</span><span className="text-lg leading-none">{treatmentOpen ? '−' : '+'}</span>
                        </button>
                        {treatmentOpen && (
                          <div className="mt-2 space-y-2">
                            {patientTreatments.length > 0 ? (
                              <div className="space-y-1">{patientTreatments.map((pt: any) => (
                                <div key={pt.id} className="flex items-center justify-between bg-white rounded px-2 py-1 text-xs">
                                  <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${pt.ended_at ? 'bg-gray-300' : 'bg-green-400'}`} />
                                    <span className={pt.ended_at ? 'text-slate-400 line-through' : 'font-medium'}>{pt.treatment_type?.name || '알 수 없음'}</span>
                                    {pt.treatment_type?.category && <span className="px-1 py-0.5 bg-blue-100 text-blue-600 rounded text-[9px]">{pt.treatment_type.category}</span>}
                                    <span className="text-slate-400">{new Date(pt.started_at).toLocaleDateString()} ~{pt.ended_at ? ` ${new Date(pt.ended_at).toLocaleDateString()}` : ''}</span>
                                  </div>
                                  <div className="flex gap-1">
                                    {!pt.ended_at && <button type="button" onClick={() => endPatientTreatment(pt.id, selectedCell.patient_id!)} className="px-1.5 py-0.5 text-orange-600 hover:bg-orange-100 rounded text-[10px]">종료</button>}
                                    <button type="button" onClick={() => deletePatientTreatment(pt.id, selectedCell.patient_id!)} className="px-1.5 py-0.5 text-red-500 hover:bg-red-100 rounded text-[10px]">삭제</button>
                                  </div>
                                </div>
                              ))}</div>
                            ) : <p className="text-xs text-slate-400">등록된 처치 항목이 없습니다.</p>}
                            <div className="flex gap-2 items-center pt-1 border-t border-amber-200">
                              <select value={addTreatmentId} onChange={e => setAddTreatmentId(e.target.value)} className="flex-1 border rounded px-2 py-1 text-xs"><option value="">처치 유형 선택</option>{treatmentTypes.map(tt => <option key={tt.id} value={tt.id}>{tt.name} {tt.category ? `(${tt.category})` : ''}</option>)}</select>
                              <button type="button" onClick={() => addPatientTreatment(selectedCell.patient_id!)} disabled={!addTreatmentId} className="px-2 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 disabled:opacity-50">추가</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {/* ━━━ 탭2: 보호자 ━━━ */}
              {cellEditTab === 2 && (
                <div className="space-y-4">
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-500" />보호자 · 연락처</p>
                    {(() => {
                      // guardian_name에 줄바꿈으로 여러 보호자 저장 (이름/연락처 쌍)
                      const raw = selectedCell.guardian_name || '';
                      const guardians = raw ? raw.split('\n').map(line => {
                        const [name = '', phone = ''] = line.split('|');
                        return { name: name.trim(), phone: phone.trim() };
                      }) : [{ name: '', phone: '' }];
                      const updateGuardians = (list: { name: string; phone: string }[]) => {
                        const val = list.map(g => g.phone ? `${g.name}|${g.phone}` : g.name).join('\n');
                        setSelectedCell({ ...selectedCell, guardian_name: val });
                      };
                      return (
                        <div className="space-y-2">
                          {guardians.map((g, idx) => (
                            <div key={idx} className="flex gap-2 items-center">
                              <div className="flex-1"><label className="text-[10px] text-slate-500 font-semibold">{idx === 0 ? '보호자' : `보호자 ${idx + 1}`}</label><input className="input w-full" value={g.name} onChange={e => { const next = [...guardians]; next[idx] = { ...next[idx], name: e.target.value }; updateGuardians(next); }} placeholder="이름" /></div>
                              <div className="flex-1"><label className="text-[10px] text-slate-500 font-semibold">연락처</label><input className="input w-full" value={g.phone} onChange={e => { const next = [...guardians]; next[idx] = { ...next[idx], phone: e.target.value }; updateGuardians(next); }} placeholder="010-0000-0000" /></div>
                              {guardians.length > 1 && (
                                <button type="button" onClick={() => { const next = guardians.filter((_, i) => i !== idx); updateGuardians(next); }} className="text-red-400 hover:text-red-600 text-lg mt-3">×</button>
                              )}
                            </div>
                          ))}
                          <button type="button" onClick={() => updateGuardians([...guardians, { name: '', phone: '' }])} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ 보호자 추가</button>
                        </div>
                      );
                    })()}
                    <div className="grid grid-cols-4 gap-3 mt-3">
                      <div><label className="text-[10px] text-slate-500 font-semibold">병원비 문자번호</label><input className="input w-full" value={selectedCell.billing_sms_phone || ''} onChange={e => setSelectedCell({ ...selectedCell, billing_sms_phone: e.target.value })} /></div>
                      <div><label className="text-[10px] text-slate-500 font-semibold">지인</label><div className="flex gap-1"><input className="input flex-1" value={selectedCell.acquaintance} onChange={e => setSelectedCell({ ...selectedCell, acquaintance: e.target.value })} /><input type="color" className="w-8 h-8 rounded cursor-pointer" value={selectedCell.acquaintance_color || '#0ea5e9'} onChange={e => setSelectedCell({ ...selectedCell, acquaintance_color: e.target.value })} /></div></div>
                      <div className="col-span-2"><label className="text-[10px] text-slate-500 font-semibold">비고</label><input className="input w-full" value={selectedCell.note || ''} onChange={e => setSelectedCell({ ...selectedCell, note: e.target.value })} placeholder="메모" /></div>
                    </div>
                  </div>
                </div>
              )}
              {/* ━━━ 탭3: 환자통계 ━━━ */}
              {cellEditTab === 3 && (
                <div className="space-y-5">
                  {/* 요약 카드 */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 text-center">
                      <div className="text-xl font-extrabold text-blue-700">{selectedCell.admitted_at ? Math.max(1, Math.ceil((Date.now() - new Date(selectedCell.admitted_at).getTime()) / 86400000)) : 0}일</div>
                      <div className="text-[10px] text-slate-500 mt-1">재원일수</div>
                    </div>
                    <div className="border border-orange-200 bg-orange-50 rounded-lg p-3 text-center">
                      <div className="text-xl font-extrabold text-orange-700">{patientEvents.filter(e => e.memo?.includes('특정기간') || (e.event_type === 'TRANSFER' && e.memo?.includes('폐렴')) || (e.event_type === 'TRANSFER' && e.memo?.includes('패혈증'))).length || (selectedCell.period_type ? 1 : 0)}건</div>
                      <div className="text-[10px] text-slate-500 mt-1">특정기간</div>
                    </div>
                    <div className="border border-rose-200 bg-rose-50 rounded-lg p-3 text-center">
                      <div className="text-xl font-extrabold text-rose-700">{patientEvents.filter(e => e.memo?.includes('임종실')).length}건</div>
                      <div className="text-[10px] text-slate-500 mt-1">임종실</div>
                    </div>
                  </div>
                  {/* 3열 레이아웃 */}
                  <div className="grid grid-cols-3 gap-5">
                    {/* 좌: 환자 정보 요약 */}
                    <div>
                      <p className="text-xs font-bold text-slate-500 mb-2">환자 정보 요약</p>
                      <table className="w-full text-xs">
                        <tbody>
                          {[
                            ['입원일', selectedCell.admitted_at ? selectedCell.admitted_at.slice(0, 10) : '-'],
                            ['보험유형', toLabel('insurance_type', selectedCell.insurance_type)],
                            ['환자분류', toLabel('patient_group', selectedCell.patient_group)],
                            ['특성화', (selectedCell.specializations || []).map(v => (SPECIALIZATION_OPTIONS.find(o => o.value === v)?.label ?? v)).join(', ') || '-'],
                            ['감염균주', selectedCell.infection_strain || '-'],
                          ].map(([k, v]) => (
                            <tr key={k} className="border-b border-gray-100">
                              <td className="py-1.5 text-slate-500 font-medium w-20">{k}</td>
                              <td className="py-1.5 text-slate-700">{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {/* 중: 비급여 금액 통계 */}
                    <div>
                      <p className="text-xs font-bold text-slate-500 mb-2">비급여 금액</p>
                      <table className="w-full text-xs">
                        <tbody>
                          {(() => {
                            // patient_charges 단일 진실 출처. 환자관리·수납관리에서 입력한 월별 비급여 직접 표시.
                            // 기존 cell.diaper_price/caregiver_price 컬럼은 미사용.
                            const cur = (selectedCell as any).current_charges;
                            const diaperPrice = Number(cur?.diaper ?? 0);
                            const caregiverPrice = Number(cur?.caregiver ?? 0);
                            const monthLabel = cur?.charge_month ?? '';
                            const stayDays = selectedCell.admitted_at ? Math.max(1, Math.ceil((Date.now() - new Date(selectedCell.admitted_at).getTime()) / 86400000)) : 0;
                            const stayMonths = Math.max(1, Math.ceil(stayDays / 30));
                            const diaperTotal = diaperPrice * stayMonths;
                            const caregiverTotal = caregiverPrice * stayMonths;
                            const monthSuffix = monthLabel ? ` ${monthLabel}` : '';
                            return [
                              [`기저귀 (월)${monthSuffix}`, diaperPrice ? `₩${diaperPrice.toLocaleString()}` : '-'],
                              [`간병 (월)${monthSuffix}`, caregiverPrice ? `₩${caregiverPrice.toLocaleString()}` : '-'],
                              ['기저귀 누적', diaperPrice ? `₩${diaperTotal.toLocaleString()} (${stayMonths}개월)` : '-'],
                              ['간병 누적', caregiverPrice ? `₩${caregiverTotal.toLocaleString()} (${stayMonths}개월)` : '-'],
                              ['비급여 합계', (diaperPrice || caregiverPrice) ? `₩${(diaperTotal + caregiverTotal).toLocaleString()}` : '-'],
                            ].map(([k, v]) => (
                              <tr key={k as string} className={`border-b border-gray-100 ${k === '비급여 합계' ? 'font-bold' : ''}`}>
                                <td className="py-1.5 text-slate-500 font-medium w-24">{k}</td>
                                <td className="py-1.5 text-slate-700">{v}</td>
                              </tr>
                            ));
                          })()}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-500 mb-2">최근 이벤트</p>
                      {patientEvents.length > 0 ? (
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="bg-gray-50">
                              <th className="text-left py-1.5 px-2 font-semibold text-slate-500 border-b border-gray-200">일시</th>
                              <th className="text-left py-1.5 px-2 font-semibold text-slate-500 border-b border-gray-200">유형</th>
                              <th className="text-left py-1.5 px-2 font-semibold text-slate-500 border-b border-gray-200">내용</th>
                            </tr>
                          </thead>
                          <tbody>
                            {patientEvents.map((ev: any) => {
                              const evDate = ev.event_date ? new Date(ev.event_date).toISOString().slice(5, 10) : '-';
                              const typeLabel: Record<string, string> = { ADMISSION: '입원', DISCHARGE: '퇴원', TRANSFER: '자리이동', DEATH: '퇴원' };
                              const detail = ev.event_type === 'ADMISSION'
                                ? `${ev.department?.name || ''} ${ev.room_no || ''} 입원`
                                : ev.event_type === 'TRANSFER'
                                ? `${ev.room_no || ''}${ev.bed_no ? ` ${ev.bed_no}번` : ''} ${ev.memo ? `(${ev.memo})` : ''}`
                                : ev.memo || ev.department?.name || '';
                              return (
                                <tr key={ev.id} className="border-b border-gray-100 hover:bg-gray-50">
                                  <td className="py-1.5 px-2 text-slate-600">{evDate}</td>
                                  <td className="py-1.5 px-2"><span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${ev.event_type === 'ADMISSION' ? 'bg-green-100 text-green-700' : ev.event_type === 'TRANSFER' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{typeLabel[ev.event_type] || ev.event_type}</span></td>
                                  <td className="py-1.5 px-2 text-slate-700 truncate max-w-[200px]">{detail}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <div className="text-xs text-slate-400 text-center py-8 border border-dashed border-gray-200 rounded-lg">
                          이벤트 이력이 없습니다.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* 푸터 */}
            <div className="modal-footer" style={{ flexShrink: 0, justifyContent: 'space-between' }}>
              <div className="flex gap-2">
                {selectedCell.patient_id && selectedCell.patient_name?.trim() && (<>
                  {selectedCell.status === 'OUTING' || selectedCell.status === 'OVERNIGHT' ? (
                    <button className="btn-secondary text-xs text-indigo-700 border-indigo-200 bg-indigo-50" onClick={async () => {
                      const label = selectedCell.status === 'OUTING' ? '외출' : '외박';
                      if (!confirm(`${selectedCell.patient_name} 환자를 ${label} 복귀 처리하시겠습니까?`)) return;
                      await api(`/patients/board/cell/${selectedCell.id}`, { method: 'PUT', body: JSON.stringify({ status: 'ADMITTED' }) });
                      showMsg('ok', `${label} 복귀 완료`); setSelectedCell(null); loadBoard();
                    }}>{selectedCell.status === 'OUTING' ? '외출복귀' : '외박복귀'}</button>
                  ) : (<>
                    <button className="btn-secondary text-xs text-indigo-700 border-indigo-200 bg-indigo-50" onClick={async () => {
                      if (!confirm(`${selectedCell.patient_name} 환자를 외출 처리하시겠습니까?`)) return;
                      await api(`/patients/board/cell/${selectedCell.id}`, { method: 'PUT', body: JSON.stringify({ status: 'OUTING' }) });
                      showMsg('ok', '외출 처리 완료'); setSelectedCell(null); loadBoard();
                    }}>외출</button>
                    <button className="btn-secondary text-xs text-violet-700 border-violet-200 bg-violet-50" onClick={async () => {
                      if (!confirm(`${selectedCell.patient_name} 환자를 외박 처리하시겠습니까?`)) return;
                      await api(`/patients/board/cell/${selectedCell.id}`, { method: 'PUT', body: JSON.stringify({ status: 'OVERNIGHT' }) });
                      showMsg('ok', '외박 처리 완료'); setSelectedCell(null); loadBoard();
                    }}>외박</button>
                  </>)}
                  <button className="btn-secondary text-teal-700 border-teal-200 bg-teal-50" onClick={() => { setTransferWardId(wardId); setTransferRoomNo(selectedCell.room_no || ''); setTransferBedNo(null); setTransferMemo(''); loadTransferRooms(wardId); setTransferOpen(true); }}>자리이동</button>
                  <button className="btn-secondary text-xs text-rose-700 border-rose-200 bg-rose-50" onClick={async () => {
                    try {
                      const rooms = await api('/patients/hospice-rooms');
                      const available = (rooms || []).filter((r: any) => !(r.department_id === wardId && r.room_no === selectedCell.room_no));
                      if (available.length === 0) { showMsg('err', '임종실이 설정되지 않았습니다. 병실 설정에서 임종실을 지정해주세요.'); return; }
                      setHospiceRooms(available);
                      setHospiceModalOpen(true);
                    } catch (e: any) { showMsg('err', e.message); }
                  }}>임종실</button>
                </>)}
                {selectedCell.patient_name?.trim() && (
                  <button className="btn-secondary text-red-600 border-red-200 bg-red-50 text-xs" onClick={() => { setDischargeForm({ type: '', reason: '' }); setDischargeModalOpen(true); }}>퇴원</button>
                )}
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => setSelectedCell(null)}>취소</button>
                {!selectedCell.patient_id && <button className="btn-primary" disabled={admitLoading} onClick={admitFromBoard}>{admitLoading ? '처리 중...' : '입원 등록'}</button>}
                <button className="btn-primary" disabled={savingCell || admitLoading} onClick={saveCell}>{(savingCell || admitLoading) ? '저장 중...' : '저장'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {transferOpen && selectedCell?.patient_id && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setTransferOpen(false); }}>
          <div className="modal w-full max-w-xl">
            <div className="modal-header">
              <h2 className="modal-title">자리이동 — {selectedCell.patient_name}</h2>
              <button className="text-xl text-slate-400" onClick={() => setTransferOpen(false)}>&times;</button>
            </div>
            <div className="modal-body space-y-3">
              <div>
                <label className="label">병동</label>
                <select
                  className="input"
                  value={transferWardId}
                  onChange={e => {
                    setTransferWardId(e.target.value);
                    setTransferRoomNo('');
                    setTransferBedNo(null);
                    loadTransferRooms(e.target.value);
                  }}
                >
                  <option value="">병동 선택</option>
                  {wards.map(w => (
                    <option key={w.id} value={w.id}>{w.name}{w.id === wardId ? ' (현재)' : ''}</option>
                  ))}
                </select>
              </div>
              {transferWardId && transferRooms.length > 0 && (
                <div>
                  <label className="label">병실</label>
                  <select
                    className="input"
                    value={transferRoomNo}
                    onChange={e => { setTransferRoomNo(e.target.value); setTransferBedNo(null); }}
                  >
                    <option value="">병실 선택 (선택)</option>
                    {transferRooms.map(r => (
                      <option key={r.id} value={r.room_no}>{r.room_no}</option>
                    ))}
                  </select>
                </div>
              )}
              {transferRoomNo && (() => {
                const room = transferRooms.find(r => r.room_no === transferRoomNo);
                if (!room) return null;
                const bedOccupants = new Map<number, string>();
                transferBoard
                  .filter((c: any) => c.ward_room_id === room.id && c.patient_name && c.patient_id !== selectedCell?.patient_id)
                  .forEach((c: any) => bedOccupants.set(c.bed_no, c.patient_name));
                const currentBed = (transferWardId === wardId && transferRoomNo === selectedCell?.room_no) ? Number(selectedCell?.bed_no || 0) : 0;
                return (
                  <div>
                    <label className="label">자리</label>
                    <select
                      className="input"
                      value={transferBedNo ?? ''}
                      onChange={e => setTransferBedNo(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">자리 선택</option>
                      {Array.from({ length: room.capacity }, (_, i) => i + 1).map(bed => {
                        const occupant = bedOccupants.get(bed);
                        const isCurrent = bed === currentBed;
                        return (
                          <option key={bed} value={bed} disabled={isCurrent}>
                            {bed}번{isCurrent ? ' (현재)' : occupant ? ` — ${occupant} (교환)` : ''}
                          </option>
                        );
                      })}
                    </select>
                    {transferBedNo != null && bedOccupants.has(transferBedNo) && (
                      <p className="text-xs text-amber-600 mt-1">
                        {bedOccupants.get(transferBedNo)} 환자와 자리를 교환합니다.
                      </p>
                    )}
                  </div>
                );
              })()}
              <div>
                <label className="label">메모 (선택)</label>
                <input
                  className="input"
                  value={transferMemo}
                  onChange={e => setTransferMemo(e.target.value)}
                  placeholder="이동 사유 등"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setTransferOpen(false)}>취소</button>
              <button
                className="btn-primary"
                disabled={!transferWardId || transferring}
                onClick={handleTransfer}
              >
                {transferring ? '처리 중...' : '이동 확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 임종실 선택 모달 */}
      {hospiceModalOpen && selectedCell && (
        <div className="modal-backdrop" style={{ zIndex: 60 }} onClick={e => { if (e.target === e.currentTarget) setHospiceModalOpen(false); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">임종실 이동 — {selectedCell.patient_name}</h2>
              <button className="text-xl text-slate-400" onClick={() => setHospiceModalOpen(false)}>&times;</button>
            </div>
            <div className="modal-body space-y-2">
              {hospiceRooms.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">이동 가능한 임종실이 없습니다.</p>
              ) : hospiceRooms.map((hr: any) => (
                <button
                  key={hr.id}
                  disabled={hr.empty_beds.length === 0}
                  className={`w-full text-left border rounded-lg p-3 flex items-center justify-between transition-colors ${hr.empty_beds.length > 0 ? 'hover:bg-rose-50 border-gray-200' : 'opacity-40 border-gray-100'}`}
                  onClick={async () => {
                    if (!confirm(`${selectedCell.patient_name} 환자를 ${hr.department_name} ${hr.room_no}(임종실)로 이동하시겠습니까?`)) return;
                    try {
                      await api(`/patients/${selectedCell.patient_id}/transfer`, { method: 'POST', body: JSON.stringify({ department_id: hr.department_id, room_no: hr.room_no, bed_no: hr.empty_beds[0], memo: '임종실 이동' }) });
                      showMsg('ok', `${hr.department_name} ${hr.room_no} 임종실 이동 완료`);
                      setHospiceModalOpen(false); setSelectedCell(null); loadBoard();
                    } catch (e: any) { showMsg('err', e.message); }
                  }}
                >
                  <div>
                    <div className="text-sm font-semibold text-slate-700">{hr.department_name} · {hr.room_no}</div>
                    <div className="text-xs text-slate-500">{hr.capacity}인실 · {hr.empty_beds.length > 0 ? `빈자리 ${hr.empty_beds.length}개` : '만실'}</div>
                  </div>
                  {hr.empty_beds.length > 0 && <span className="text-xs px-2 py-1 rounded bg-rose-100 text-rose-700 font-semibold">이동</span>}
                </button>
              ))}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setHospiceModalOpen(false)}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 퇴원 확인 모달 */}
      {dischargeModalOpen && selectedCell && (
        <div className="modal-backdrop" style={{ zIndex: 60 }} onClick={e => { if (e.target === e.currentTarget) setDischargeModalOpen(false); }}>
          <div className="modal w-full max-w-xl">
            <div className="modal-header">
              <h2 className="modal-title">퇴원 처리 — {selectedCell.patient_name}</h2>
              <button className="text-xl text-slate-400" onClick={() => setDischargeModalOpen(false)}>&times;</button>
            </div>
            <div className="modal-body space-y-3">
              <div>
                <label className="label">퇴원유형 <span className="text-red-500">*</span></label>
                <select className="input w-full" value={dischargeForm.type} onChange={e => setDischargeForm(f => ({ ...f, type: e.target.value }))}>
                  <option value="">선택하세요</option>
                  {['자택', '장기요양기관', '급성기병원', '타요양병원', '기타'].map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className="label">퇴원사유 <span className="text-red-500">*</span></label>
                <select className="input w-full" value={dischargeForm.reason} onChange={e => setDischargeForm(f => ({ ...f, reason: e.target.value }))}>
                  <option value="">선택하세요</option>
                  {['퇴원', '사망', '전원', '자의퇴원', '기타'].map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDischargeModalOpen(false)}>취소</button>
              <button
                className="btn-primary bg-red-600 hover:bg-red-700"
                disabled={!dischargeForm.type || !dischargeForm.reason}
                onClick={async () => {
                  if (!confirm(`${selectedCell.patient_name} 환자를 퇴원 처리하시겠습니까?`)) return;
                  setDischargeModalOpen(false);
                  // dischargeFromBoard 로직 인라인
                  try {
                    let linkedId = selectedCell.patient_id
                      || mergedPatients.find(p => p.status === 'ADMITTED' && p.room_no === selectedCell.room_no && Number(p.bed_no || 0) === Number(selectedCell.bed_no || 0))?.id;
                    if (!linkedId) {
                      const rows = await api('/patients?status=ADMITTED');
                      linkedId = (rows || []).find((p: any) => p.room_no === selectedCell.room_no && Number(p.bed_no || 0) === Number(selectedCell.bed_no || 0))?.id;
                    }
                    if (!linkedId) { showMsg('err', '퇴원 처리할 환자를 찾지 못했습니다.'); return; }
                    await discharge(linkedId, dischargeForm.type, dischargeForm.reason);
                    setSelectedCell(null);
                  } catch (e: any) {
                    showMsg('err', e.message);
                  }
                }}
              >
                퇴원 처리
              </button>
            </div>
          </div>
        </div>
      )}

      {listAdmitOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setListAdmitOpen(false); }}>
          <div className="modal w-full max-w-3xl">
            <div className="modal-header">
              <h2 className="modal-title">입원 등록</h2>
              <button className="text-xl text-slate-400" onClick={() => setListAdmitOpen(false)}>&times;</button>
            </div>
            <div className="modal-body grid md:grid-cols-3 gap-3">
              <SelectField value={listAdmitForm.department_id} onChange={v => setListAdmitForm(p => ({ ...p, department_id: v }))} options={[{ v: '', l: '병동 선택' }, ...wards.map(w => ({ v: w.id, l: w.name }))]} />
              <input className="input" placeholder="병실 (예: 201호)" value={listAdmitForm.room_no} onChange={e => setListAdmitForm(p => ({ ...p, room_no: e.target.value }))} />
              <input className="input" placeholder="자리 번호" value={listAdmitForm.bed_no} onChange={e => setListAdmitForm(p => ({ ...p, bed_no: e.target.value }))} />
              <input className="input" placeholder="차트번호" value={listAdmitForm.chart_no} onChange={e => setListAdmitForm(p => ({ ...p, chart_no: e.target.value }))} />
              <input className="input" placeholder="이름" value={listAdmitForm.name} onChange={e => setListAdmitForm(p => ({ ...p, name: e.target.value }))} />
              <SelectField value={listAdmitForm.mobility_type} onChange={v => setListAdmitForm(p => ({ ...p, mobility_type: v }))} options={[{ v: 'BEDRIDDEN', l: '와상' }, { v: 'AMBULATORY', l: '거동' }]} />
              <GroupedSelectField value={listAdmitForm.insurance_type} onChange={v => setListAdmitForm(p => ({ ...p, insurance_type: v }))} groups={INSURANCE_GROUPS} />
              <SelectField value={listAdmitForm.copay_reduction || 'NONE'} onChange={v => setListAdmitForm(p => ({ ...p, copay_reduction: v, ...(v === 'NONE' ? { disease_code_id: '', disease_code_registered_at: '', disease_code_expires_at: '' } : {}) }))} options={COPAY_REDUCTION_OPTIONS} />
              <SelectField value={listAdmitForm.patient_group} onChange={v => {
                const today = new Date().toISOString().slice(0, 10);
                if (v === 'PNEUMONIA' || v === 'SEPSIS') {
                  setListAdmitForm(p => ({ ...p, patient_group: v, period_type: v, period_phase: 'START', period_start_date: today }));
                  return;
                }
                const activePeriod = listAdmitForm.period_type && listAdmitForm.period_phase === 'START';
                if (activePeriod) {
                  const periodLabel = listAdmitForm.period_type === 'PNEUMONIA' ? '폐렴' : '패혈증';
                  if (window.confirm(`현재 ${periodLabel} 진행 중입니다. 함께 종료할까요?\n\n확인: 특정기간을 오늘 날짜로 종료\n취소: 환자분류만 변경 (특정기간 유지)`)) {
                    setListAdmitForm(p => ({ ...p, patient_group: v, period_phase: 'END', period_end_date: today }));
                    return;
                  }
                }
                setListAdmitForm(p => ({ ...p, patient_group: v }));
              }} options={[{ v: 'HIGHEST', l: '최고도' }, { v: 'HIGH', l: '고도' }, { v: 'MEDIUM', l: '중도' }, { v: 'LOW', l: '경도' }, { v: 'SELECT', l: '선택' }, { v: 'UNRATED', l: '미평가' }, { v: 'INFECTION', l: '감염' }, { v: 'PNEUMONIA', l: '폐렴' }, { v: 'SEPSIS', l: '패혈증' }]} />
              <SearchableSelect
                value={listAdmitForm.main_disease_code_id}
                onChange={v => setListAdmitForm(p => ({ ...p, main_disease_code_id: v }))}
                placeholder="주상병코드 검색..."
                options={[
                  { v: '', l: '선택 안함' },
                  ...diseaseCodes.filter(c => c.is_active && c.code_type === 'MAIN').map(c => ({ v: c.id, l: `${c.code} ${c.name}` })),
                ]}
              />
              <SelectField value={listAdmitForm.caregiver_type} onChange={v => setListAdmitForm(p => ({ ...p, caregiver_type: v }))} options={CAREGIVER_OPTIONS} />
              <input className="input" placeholder="보호자" value={listAdmitForm.guardian_name} onChange={e => setListAdmitForm(p => ({ ...p, guardian_name: e.target.value }))} />
              <input className="input" placeholder="병원비 문자 수신번호" value={listAdmitForm.billing_sms_phone} onChange={e => setListAdmitForm(p => ({ ...p, billing_sms_phone: e.target.value }))} />
              <input className="input md:col-span-3" placeholder="사업명칭" value={listAdmitForm.project_name} onChange={e => setListAdmitForm(p => ({ ...p, project_name: e.target.value }))} />
              <input className="input" placeholder="지역" value={listAdmitForm.project_region} onChange={e => setListAdmitForm(p => ({ ...p, project_region: e.target.value }))} />
              <input className="input" placeholder="시/군/구청" value={listAdmitForm.project_sigungu_office} onChange={e => setListAdmitForm(p => ({ ...p, project_sigungu_office: e.target.value }))} />
              {(listAdmitForm.copay_reduction === 'SEVERE' || listAdmitForm.copay_reduction === 'RARE') && (
                <div className="md:col-span-3 border border-blue-200 rounded-lg p-2 bg-blue-50 grid md:grid-cols-3 gap-2">
                  <div>
                    <p className="text-xs text-blue-600 mb-1 font-medium">V코드 (산정특례)</p>
                    <SelectField
                      value={listAdmitForm.disease_code_id}
                      onChange={v => setListAdmitForm(p => ({ ...p, disease_code_id: v }))}
                      options={[
                        { v: '', l: 'V코드 선택' },
                        ...diseaseCodes
                          .filter(c => c.is_active && c.code_type === (listAdmitForm.copay_reduction === 'SEVERE' ? 'SEVERE' : 'RARE'))
                          .map(c => ({ v: c.id, l: `${c.code} ${c.name}` })),
                      ]}
                    />
                  </div>
                  <div>
                    <p className="text-xs text-blue-600 mb-1 font-medium">등록일</p>
                    <input type="date" className="input" value={listAdmitForm.disease_code_registered_at} onChange={e => {
                      const val = e.target.value;
                      const update: any = { disease_code_registered_at: val };
                      if (val && !listAdmitForm.disease_code_expires_at) {
                        const d = new Date(val + 'T00:00:00'); d.setFullYear(d.getFullYear() + 5);
                        update.disease_code_expires_at = d.toISOString().slice(0, 10);
                      }
                      setListAdmitForm(p => ({ ...p, ...update }));
                    }} />
                  </div>
                  <div>
                    <p className="text-xs text-blue-600 mb-1 font-medium">만료일</p>
                    <input type="date" className="input" value={listAdmitForm.disease_code_expires_at} onChange={e => setListAdmitForm(p => ({ ...p, disease_code_expires_at: e.target.value }))} />
                  </div>
                </div>
              )}
              <div className="md:col-span-3 border rounded-lg p-2">
                <p className="text-xs text-slate-500 mb-2">특성화 (중복 선택)</p>
                <div className="flex gap-2 flex-wrap">
                  {SPECIALIZATION_OPTIONS.map(opt => (
                    <button key={opt.value} type="button" onClick={() => {
                      const cur = new Set<string>(listAdmitForm.specializations || []);
                      if (cur.has(opt.value)) cur.delete(opt.value); else cur.add(opt.value);
                      const newSpecs = Array.from(cur);
                      setListAdmitForm(p => ({
                        ...p,
                        specializations: newSpecs,
                        ...(opt.value === 'INFECT' && !cur.has('INFECT') ? { infection_strain: '' } : {}),
                      }));
                    }} className={`px-3 py-1 text-xs rounded-full border ${(listAdmitForm.specializations || []).includes(opt.value) ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-slate-600 border-gray-200'}`}>{opt.label}</button>
                  ))}
                </div>
              </div>
              <SelectField value={listAdmitForm.infection_strain} onChange={v => setListAdmitForm(p => ({ ...p, infection_strain: v }))} options={[{ v: '', l: '감염균주 없음' }, { v: 'CRE', l: 'CRE' }, { v: 'VRE', l: 'VRE' }, { v: 'MR', l: 'MR' }]} disabled={!(listAdmitForm.specializations || []).includes('INFECT')} />
              <SelectField value={listAdmitForm.period_type} onChange={v => setListAdmitForm(p => ({ ...p, period_type: v, ...(v ? {} : { period_start_date: '', period_end_date: '' }) }))} options={[{ v: '', l: '특정기간 없음' }, { v: 'PNEUMONIA', l: '폐렴' }, { v: 'SEPSIS', l: '패혈증' }]} />
              {listAdmitForm.period_type ? (
                <>
                  <input type="date" className="input" value={listAdmitForm.period_start_date} onChange={e => setListAdmitForm(p => ({ ...p, period_start_date: e.target.value }))} />
                  <input type="date" className="input" value={listAdmitForm.period_end_date} onChange={e => setListAdmitForm(p => ({ ...p, period_end_date: e.target.value }))} />
                </>
              ) : (<><div /><div /></>)}
              <SelectField
                value={listAdmitForm.diaper_state || 'NONE'}
                onChange={v => setListAdmitForm(p => ({ ...p, diaper_state: v, ...(v === 'IN_HOUSE' ? {} : { diaper_price: '0' }) }))}
                options={[{ v: 'NONE', l: '미사용' }, { v: 'IN_HOUSE', l: '원내' }, { v: 'PERSONAL', l: '본인' }]}
              />
              <input
                className="input"
                placeholder="기저귀 금액(원내만)"
                disabled={listAdmitForm.diaper_state !== 'IN_HOUSE'}
                value={listAdmitForm.diaper_state === 'IN_HOUSE' ? listAdmitForm.diaper_price : '0'}
                onChange={e => setListAdmitForm(p => ({ ...p, diaper_price: e.target.value }))}
              />
              <div className="flex gap-2 items-center md:col-span-2">
                <label className="text-xs text-slate-500 whitespace-nowrap">기저귀 사용기간</label>
                <input type="date" className="input flex-1" value={listAdmitForm.diaper_start_date || ''} onChange={e => setListAdmitForm(p => ({ ...p, diaper_start_date: e.target.value }))} />
                <span className="text-xs text-slate-400">~</span>
                <input type="date" className="input flex-1" value={listAdmitForm.diaper_end_date || ''} onChange={e => setListAdmitForm(p => ({ ...p, diaper_end_date: e.target.value }))} />
              </div>
              <input className="input" list="hospital-options" placeholder="입원전병원" value={listAdmitForm.prev_hospital} onChange={e => setListAdmitForm(p => ({ ...p, prev_hospital: e.target.value }))} />
              <input className="input" value={listAdmitForm.address || ''} onChange={e => setListAdmitForm(p => ({ ...p, address: e.target.value }))} placeholder="거주지" />
              <select className="input" value={listAdmitForm.referral_source || ''} onChange={e => setListAdmitForm(p => ({ ...p, referral_source: e.target.value }))}>
                <option value="">유입경로 선택</option>
                {['SNS', '인근거주', '장기요양기관', '소개', '진료협력센터', '급성기병원', '재입원', '기타'].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <SelectField
                value={listAdmitForm.rehab_type}
                onChange={v => setListAdmitForm(p => ({ ...p, rehab_type: v, ...(v ? {} : { onset_date: '' }) }))}
                options={[{ v: '', l: '재활구분 없음' }, { v: 'CNS', l: 'CNS (뇌신경계)' }, { v: 'OS', l: 'CNS 외 (정형·기타)' }, { v: 'OUTPATIENT', l: '외래' }]}
              />
              <input
                type="date"
                className="input"
                placeholder="발병일"
                value={listAdmitForm.onset_date || ''}
                onChange={e => setListAdmitForm(p => ({ ...p, onset_date: e.target.value }))}
                disabled={!listAdmitForm.rehab_type || listAdmitForm.rehab_type === 'OUTPATIENT'}
                title="발병일 (CNS/OS 환자)"
              />
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setListAdmitOpen(false)}>취소</button>
              <button className="btn-primary" disabled={admitLoading} onClick={admitFromList}>{admitLoading ? '처리 중...' : '입원 등록'}</button>
            </div>
          </div>
        </div>
      )}
      <datalist id="hospital-options">
        {hospitals.map(h => <option key={h.id} value={h.name} />)}
      </datalist>

      {/* 주상병/V코드 마스터 추가/편집 모달 */}
      {codeEditOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setCodeEditOpen(false); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">{editingCodeId ? '코드 수정' : '코드 추가'}</h2>
              <button className="text-xl text-slate-400" onClick={() => setCodeEditOpen(false)}>&times;</button>
            </div>
            <div className="modal-body grid gap-3">
              <div className="flex justify-end">
                <button type="button" onClick={() => { setHiraCodeSearch(codeForm.name || codeForm.code); setHiraCodeResults([]); setHiraCodeTotal(0); setHiraCodeModal(true); }} className="btn-secondary text-xs">
                  HIRA 질병코드 검색
                </button>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">코드번호 (예: M001, V001)</label>
                <input className="input" placeholder="M001 또는 V001" value={codeForm.code} onChange={e => setCodeForm(p => ({ ...p, code: e.target.value.toUpperCase() }))} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">질환명</label>
                <input className="input" placeholder="질환명 입력" value={codeForm.name} onChange={e => setCodeForm(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">유형</label>
                <SelectField value={codeForm.code_type} onChange={v => setCodeForm(p => ({ ...p, code_type: v as any }))} options={[{ v: 'MAIN', l: '주상병코드' }, { v: 'SEVERE', l: '중증질환 (본인부담경감)' }, { v: 'RARE', l: '희귀난치성 (본인부담경감)' }]} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setCodeEditOpen(false)}>취소</button>
              <button className="btn-primary" disabled={codeSaving} onClick={saveCode}>{codeSaving ? '저장 중...' : '저장'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 재등록 이력 추가/편집 모달 */}
      {regEditOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setRegEditOpen(false); }}>
          <div className="modal w-full max-w-lg">
            <div className="modal-header">
              <h2 className="modal-title">{editingRegId ? 'V코드 이력 수정' : 'V코드 이력 등록'}</h2>
              <button className="text-xl text-slate-400" onClick={() => setRegEditOpen(false)}>&times;</button>
            </div>
            <div className="modal-body grid gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">환자 선택</label>
                <select
                  className="input h-10 text-sm"
                  value={regForm.patient_id}
                  onChange={e => setRegForm(p => ({ ...p, patient_id: e.target.value }))}
                >
                  <option value="">환자 선택</option>
                  {mergedPatients.filter(p => p.status === 'ADMITTED').map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.chart_no}) - {p.department_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">V코드</label>
                <select
                  className="input h-10 text-sm"
                  value={regForm.disease_code_id}
                  onChange={e => setRegForm(p => ({ ...p, disease_code_id: e.target.value }))}
                >
                  <option value="">V코드 선택</option>
                  {diseaseCodes.filter(c => c.is_active && (c.code_type === 'SEVERE' || c.code_type === 'RARE')).map(c => (
                    <option key={c.id} value={c.id}>{c.code} {c.name} ({c.code_type === 'SEVERE' ? '중증' : '희귀'})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">등록일</label>
                  <input type="date" className="input" value={regForm.registered_at} onChange={e => {
                    const val = e.target.value;
                    const update: any = { registered_at: val };
                    if (val && !regForm.expires_at) {
                      const d = new Date(val + 'T00:00:00'); d.setFullYear(d.getFullYear() + 5);
                      update.expires_at = d.toISOString().slice(0, 10);
                    }
                    setRegForm(p => ({ ...p, ...update }));
                  }} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">만료일</label>
                  <input type="date" className="input" value={regForm.expires_at} onChange={e => setRegForm(p => ({ ...p, expires_at: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">메모</label>
                <input className="input" placeholder="메모 (선택)" value={regForm.note} onChange={e => setRegForm(p => ({ ...p, note: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setRegEditOpen(false)}>취소</button>
              <button className="btn-primary" disabled={regSaving} onClick={saveReg}>{regSaving ? '저장 중...' : '저장'}</button>
            </div>
          </div>
        </div>
      )}

      {/* HIRA 질병코드 검색 모달 */}
      {hiraCodeModal && (
        <div className="modal-backdrop" style={{ zIndex: 60 }} onClick={e => { if (e.target === e.currentTarget) setHiraCodeModal(false); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">HIRA 질병코드 검색</h2>
              <button onClick={() => setHiraCodeModal(false)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body">
              <div className="flex gap-2 mb-4">
                <select value={hiraSearchType} onChange={e => setHiraSearchType(e.target.value as any)} className="input w-28">
                  <option value="SICK_NM">질병명</option>
                  <option value="SICK_CD">코드</option>
                </select>
                <input
                  value={hiraCodeSearch}
                  onChange={e => setHiraCodeSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') searchHiraCode(1); }}
                  className="input flex-1"
                  placeholder={hiraSearchType === 'SICK_NM' ? '질병명 검색 (예: 당뇨, 폐렴)' : '질병코드 검색 (예: E11, J18)'}
                  autoFocus
                />
                <button onClick={() => searchHiraCode(1)} disabled={hiraCodeLoading || !hiraCodeSearch.trim()} className="btn-primary text-sm px-5">
                  {hiraCodeLoading ? '검색 중...' : '검색'}
                </button>
              </div>

              {hiraCodeResults.length > 0 && (
                <>
                  <p className="text-xs text-slate-500 mb-2">총 {hiraCodeTotal.toLocaleString()}건 (페이지 {hiraCodePage}/{Math.ceil(hiraCodeTotal / 20)})</p>
                  <div className="overflow-x-auto border rounded-lg" style={{ maxHeight: 360 }}>
                    <table className="tbl text-xs">
                      <thead><tr><th>코드</th><th>질병명</th><th>영문명</th><th></th></tr></thead>
                      <tbody>
                        {hiraCodeResults.map((it, i) => (
                          <tr key={i} className="hover:bg-blue-50 cursor-pointer" onClick={() => selectHiraCode(it)}>
                            <td className="font-mono font-medium">{it.sickCd}</td>
                            <td>{it.sickNm}</td>
                            <td className="text-slate-400 max-w-[200px] truncate" title={it.sickEngNm}>{it.sickEngNm || '-'}</td>
                            <td><button className="text-xs text-accent-600 hover:underline" onClick={e => { e.stopPropagation(); selectHiraCode(it); }}>선택</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {hiraCodeTotal > 20 && (
                    <div className="flex justify-center gap-3 mt-3">
                      <button onClick={() => searchHiraCode(hiraCodePage - 1)} disabled={hiraCodePage <= 1 || hiraCodeLoading} className="btn-secondary text-xs">이전</button>
                      <button onClick={() => searchHiraCode(hiraCodePage + 1)} disabled={hiraCodePage >= Math.ceil(hiraCodeTotal / 20) || hiraCodeLoading} className="btn-secondary text-xs">다음</button>
                    </div>
                  )}
                </>
              )}

              {!hiraCodeLoading && hiraCodeResults.length === 0 && hiraCodeTotal === 0 && hiraCodeSearch && (
                <p className="text-center text-slate-400 text-sm py-8">검색 결과가 없습니다.</p>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => setHiraCodeModal(false)} className="btn-secondary">닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* 대량등록 모달 */}
      {bulkModalOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) closeBulkModal(); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">엑셀/CSV 대량등록</h2>
              <button className="text-xl text-slate-400" onClick={closeBulkModal}>&times;</button>
            </div>

            {/* 단계 표시 */}
            <div className="flex gap-2 mb-4 text-xs px-4 pt-2">
              {(['파일 선택', '미리보기', '결과'] as const).map((label, idx) => (
                <span key={idx} className={`px-2.5 py-1 rounded-full font-medium ${bulkStep === idx + 1 ? 'bg-blue-600 text-white' : 'text-slate-400'}`}>
                  {idx + 1}. {label}
                </span>
              ))}
            </div>

            <div className="modal-body">
              {/* Step 1: 파일 선택 */}
              {bulkStep === 1 && (
                <div>
                  <div
                    className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${bulkDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400 bg-gray-50'}`}
                    onDragOver={e => { e.preventDefault(); setBulkDragOver(true); }}
                    onDragLeave={() => setBulkDragOver(false)}
                    onDrop={e => {
                      e.preventDefault();
                      setBulkDragOver(false);
                      const file = e.dataTransfer.files[0];
                      if (file) handleBulkFileSelect(file);
                    }}
                    onClick={() => document.getElementById('bulk-file-input')?.click()}
                  >
                    {bulkPreviewing ? (
                      <p className="text-sm text-slate-500">파일 분석 중...</p>
                    ) : (
                      <>
                        <p className="text-4xl mb-3">📂</p>
                        <p className="text-sm font-medium text-slate-700">파일을 여기에 끌어다 놓거나 클릭하여 선택하세요</p>
                        <p className="text-xs text-slate-400 mt-1">.xlsx, .xls, .csv 지원</p>
                      </>
                    )}
                  </div>
                  <input
                    id="bulk-file-input"
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) handleBulkFileSelect(file);
                      e.currentTarget.value = '';
                    }}
                  />
                  <div className="flex justify-between items-center mt-3">
                    <button onClick={downloadPatientTemplate} className="btn-secondary text-xs">양식 다운로드 (.xlsx)</button>
                    <button onClick={closeBulkModal} className="btn-secondary">취소</button>
                  </div>
                </div>
              )}

              {/* Step 2: 미리보기 */}
              {bulkStep === 2 && bulkPreview && (
                <div>
                  <div className="mb-3 p-2 bg-gray-50 rounded-lg">
                    <p className="text-xs text-slate-500 mb-1.5">
                      {bulkPreview.is_header_mode ? '✓ 헤더 기반 자동 매핑' : '기본 16컬럼 순서 형식'}
                      {' — '}
                      총 <strong>{bulkPreview.total}</strong>행 감지
                    </p>
                    {bulkPreview.is_header_mode && (
                      <div className="flex flex-wrap gap-1">
                        {bulkPreview.recognized.map(h => (
                          <span key={h} className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded">{h} ✓</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mb-1">미리보기 (최대 5행)</p>
                  <div className="overflow-auto max-h-48 border rounded">
                    <table className="tbl text-xs">
                      <thead>
                        <tr>{bulkPreview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {bulkPreview.preview.map((row, ri) => (
                          <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="modal-footer mt-4">
                    <button onClick={() => { setBulkStep(1); setBulkPreview(null); setBulkFile(null); }} className="btn-secondary">이전</button>
                    <button onClick={startBulkImport} disabled={bulkImporting} className="btn-primary">
                      {bulkImporting ? '등록 중...' : `등록 시작 (${bulkPreview.total}명)`}
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: 결과 */}
              {bulkStep === 3 && bulkResult && (
                <div>
                  <div className="flex gap-6 mb-4 justify-center">
                    <div className="text-center">
                      <p className="text-3xl font-bold text-green-600">{bulkResult.created}</p>
                      <p className="text-xs text-slate-500 mt-0.5">✅ 등록 완료</p>
                    </div>
                    <div className="text-center">
                      <p className="text-3xl font-bold text-yellow-500">{bulkResult.skipped}</p>
                      <p className="text-xs text-slate-500 mt-0.5">⚠ 중복 스킵</p>
                    </div>
                    <div className="text-center">
                      <p className="text-3xl font-bold text-red-500">{bulkResult.errors.length}</p>
                      <p className="text-xs text-slate-500 mt-0.5">❌ 오류</p>
                    </div>
                  </div>
                  {bulkResult.errors.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-slate-700 mb-2">오류 상세</p>
                      <div className="overflow-auto max-h-48 border rounded">
                        <table className="tbl text-xs">
                          <thead><tr><th className="w-16 text-center">행</th><th>오류 내용</th></tr></thead>
                          <tbody>
                            {bulkResult.errors.map((e, i) => (
                              <tr key={i}>
                                <td className="text-center font-mono">{e.row}</td>
                                <td className="text-red-600">{e.message}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  <div className="modal-footer mt-4">
                    <button onClick={closeBulkModal} className="btn-primary">닫기</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 엑셀 최신화 모달 */}
      {syncModalOpen && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setSyncModalOpen(false); } }}>
          <div className="modal w-full max-w-lg">
            <div className="modal-header">
              <h2 className="modal-title">엑셀로 최신화</h2>
              <button className="text-xl text-slate-400" onClick={() => setSyncModalOpen(false)}>&times;</button>
            </div>
            <div className="modal-body space-y-4">
              {!syncResult ? (
                <>
                  <p className="text-sm text-slate-600">아래 3종 파일 중 해당 파일을 동시에 선택하세요. 종류는 자동으로 인식합니다.</p>
                  <ul className="text-xs text-slate-500 list-disc list-inside space-y-0.5">
                    <li>원무과약정금.xlsx — 환자 기본정보·보험유형·기저귀</li>
                    <li>일일병실현황.xlsx — 병실배정 (해당 날짜 덮어씀)</li>
                    <li>환자현황.xlsx — 재활구분·발병일</li>
                  </ul>

                  <label className="flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-10 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                    <span className="text-3xl mb-2">📂</span>
                    <span className="text-sm font-medium text-slate-700">파일 선택 (최대 3개)</span>
                    <span className="text-xs text-slate-400 mt-1">.xlsx 파일만 지원</span>
                    <input
                      type="file"
                      accept=".xlsx"
                      multiple
                      className="hidden"
                      onChange={e => {
                        const list = Array.from(e.target.files ?? []).slice(0, 3);
                        setSyncFiles(list);
                        e.currentTarget.value = '';
                      }}
                    />
                  </label>

                  {syncFiles.length > 0 && (
                    <div className="space-y-1">
                      {syncFiles.map((f, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-slate-600">
                          <span className="text-green-600">✓</span>
                          <span className="truncate">{f.name}</span>
                          <span className="text-slate-400 ml-auto shrink-0">({(f.size / 1024).toFixed(0)} KB)</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="modal-footer">
                    <button onClick={() => setSyncModalOpen(false)} className="btn-secondary">취소</button>
                    <button onClick={runSyncExcel} disabled={syncLoading || syncFiles.length === 0} className="btn-primary">
                      {syncLoading ? '처리 중...' : `최신화 실행 (${syncFiles.length}개 파일)`}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-3">
                    {syncResult.wonmu && (
                      <div className="p-3 bg-green-50 rounded-lg">
                        <p className="text-sm font-semibold text-green-800 mb-1">원무과약정금 (환자정보)</p>
                        <div className="flex gap-4 text-xs text-green-700">
                          <span>신규 {syncResult.wonmu.added}명</span>
                          <span>업데이트 {syncResult.wonmu.updated}명</span>
                          <span>퇴원처리 {syncResult.wonmu.discharged}명</span>
                        </div>
                        {syncResult.wonmu.errors?.length > 0 && (
                          <div className="mt-1 text-xs text-red-600 space-y-0.5">
                            {syncResult.wonmu.errors.slice(0, 5).map((e: string, i: number) => <div key={i}>{e}</div>)}
                          </div>
                        )}
                      </div>
                    )}
                    {syncResult.board && (
                      <div className="p-3 bg-blue-50 rounded-lg">
                        <p className="text-sm font-semibold text-blue-800 mb-1">일일병실현황 ({syncResult.board.date})</p>
                        <p className="text-xs text-blue-700">병상 {syncResult.board.updated}건 업데이트</p>
                        {syncResult.board.errors?.length > 0 && (
                          <div className="mt-1 text-xs text-red-600 space-y-0.5">
                            {syncResult.board.errors.slice(0, 5).map((e: string, i: number) => <div key={i}>{e}</div>)}
                          </div>
                        )}
                      </div>
                    )}
                    {syncResult.rehab && (
                      <div className="p-3 bg-purple-50 rounded-lg">
                        <p className="text-sm font-semibold text-purple-800 mb-1">재활현황</p>
                        <p className="text-xs text-purple-700">재활정보 {syncResult.rehab.updated}건 업데이트</p>
                        {syncResult.rehab.errors?.length > 0 && (
                          <div className="mt-1 text-xs text-red-600 space-y-0.5">
                            {syncResult.rehab.errors.slice(0, 5).map((e: string, i: number) => <div key={i}>{e}</div>)}
                          </div>
                        )}
                      </div>
                    )}
                    {syncResult.errors?.length > 0 && (
                      <div className="p-3 bg-red-50 rounded-lg">
                        <p className="text-sm font-semibold text-red-700 mb-1">파일 처리 오류</p>
                        {syncResult.errors.map((e: string, i: number) => (
                          <p key={i} className="text-xs text-red-600">{e}</p>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="modal-footer">
                    <button onClick={() => { setSyncResult(null); setSyncFiles([]); }} className="btn-secondary">다시 실행</button>
                    <button onClick={() => setSyncModalOpen(false)} className="btn-primary">닫기</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
