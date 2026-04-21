import React, { useEffect, useState, useRef } from 'react';
import { FileInput, Upload, X, Check, XCircle, Eye, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui';

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  UPLOADED: { label: '업로드 완료', cls: 'bg-gray-100 text-gray-600' },
  ANALYZING: { label: 'AI 분석중', cls: 'bg-blue-100 text-blue-700 animate-pulse' },
  REVIEW: { label: '검토 대기', cls: 'bg-amber-100 text-amber-700' },
  APPROVED: { label: '승인 완료', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { label: '반려', cls: 'bg-red-100 text-red-700' },
};

const INS_OPTIONS = [
  { v: 'HEALTH', l: '건강보험' },
  { v: 'MEDICAL_1', l: '의료급여 1종' },
  { v: 'MEDICAL_2', l: '의료급여 2종' },
  { v: 'WORKERS_COMP', l: '산재보험' },
  { v: 'AUTO_INS', l: '자동차보험' },
];

export default function ReferralIntakePage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMemo, setUploadMemo] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 모달
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [approveForm, setApproveForm] = useState({
    patientName: '', chartNo: '', gender: 'UNKNOWN', insuranceType: 'HEALTH',
    copayReduction: 'NONE', patientGroup: 'UNRATED', mobilityType: 'BEDRIDDEN',
    departmentId: '', finalRoom: '', finalBed: '', prevHospital: '',
  });
  const [departments, setDepartments] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectMode, setRejectMode] = useState(false);

  const load = () => {
    setLoading(true);
    const q = filter ? `?status=${filter}` : '';
    api(`/referral${q}`).then(setRows).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filter]);
  useEffect(() => {
    api('/departments').then((d: any[]) => setDepartments(d.filter((x: any) => x.is_active && !x.deleted_at))).catch(() => {});
  }, []);

  // 파일 선택
  const handleFile = (file: File | null) => {
    if (!file) return;
    setSelectedFile(file);
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  // 업로드
  const doUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('memo', uploadMemo);
      const res = await fetch('/api/referral/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        setSelectedFile(null);
        setPreview(null);
        setUploadMemo('');
        load();
        if (data.referral?.status === 'REVIEW') {
          openDetail(data.referral.id);
        }
      }
    } catch { }
    finally { setUploading(false); }
  };

  // 상세 열기
  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setRejectMode(false);
    setRejectReason('');
    try {
      const d = await api(`/referral/${id}`);
      setDetail(d);
      setApproveForm({
        patientName: d.patient_name || '',
        chartNo: '',
        gender: 'UNKNOWN',
        insuranceType: 'HEALTH',
        copayReduction: 'NONE',
        patientGroup: 'UNRATED',
        mobilityType: 'BEDRIDDEN',
        departmentId: '',
        finalRoom: d.suggested_room || '',
        finalBed: '',
        prevHospital: d.suggested_ward || '',
      });
      // 부서 선택 시 병실 로드
      if (d.suggested_ward) {
        const dept = departments.find((dd: any) => dd.name === d.suggested_ward);
        if (dept) {
          setApproveForm(f => ({ ...f, departmentId: dept.id }));
          loadRooms(dept.id);
        }
      }
    } catch { }
    finally { setDetailLoading(false); }
  };

  const loadRooms = async (deptId: string) => {
    try {
      const data = await api(`/patients/room-config?department_id=${deptId}`);
      setRooms(Array.isArray(data) ? data : []);
    } catch { setRooms([]); }
  };

  // 승인
  const doApprove = async () => {
    if (!detail || !approveForm.patientName || !approveForm.departmentId) return;
    setSaving(true);
    try {
      await api(`/referral/${detail.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          ...approveForm,
          finalWard: departments.find(d => d.id === approveForm.departmentId)?.name || '',
        }),
      });
      setDetail(null);
      load();
    } catch { }
    finally { setSaving(false); }
  };

  // 반려
  const doReject = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      await api(`/referral/${detail.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: rejectReason }) });
      setDetail(null);
      load();
    } catch { }
    finally { setSaving(false); }
  };

  const counts = {
    all: rows.length,
    UPLOADED: rows.filter(r => r.status === 'UPLOADED').length,
    REVIEW: rows.filter(r => r.status === 'REVIEW').length,
    APPROVED: rows.filter(r => r.status === 'APPROVED').length,
    REJECTED: rows.filter(r => r.status === 'REJECTED').length,
  };

  return (
    <div>
      <PageHeader icon={FileInput} title="의뢰서 접수" description="의뢰서 업로드 → AI 분석 → 환자 등록" />

      {/* 상태 필터 탭 */}
      <div className="flex gap-1.5 mb-5 overflow-x-auto no-print">
        {[
          { key: '', label: '전체', count: counts.all },
          { key: 'REVIEW', label: '검토 대기', count: counts.REVIEW },
          { key: 'UPLOADED', label: '업로드', count: counts.UPLOADED },
          { key: 'APPROVED', label: '승인', count: counts.APPROVED },
          { key: 'REJECTED', label: '반려', count: counts.REJECTED },
        ].map(t => (
          <button key={t.key} onClick={() => setFilter(t.key)}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-full whitespace-nowrap transition-all
              ${filter === t.key ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-500 hover:bg-gray-200'}`}>
            {t.label} {t.count > 0 && <span className="ml-1 opacity-70">{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        {/* 업로드 영역 */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
              <Upload className="w-4 h-4" /> 의뢰서 업로드
            </h3>

            {/* 드래그 & 드롭 영역 */}
            <div
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-blue-400', 'bg-blue-50'); }}
              onDragLeave={e => { e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50'); }}
              onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50'); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center cursor-pointer hover:border-blue-300 hover:bg-blue-50/50 transition-all"
            >
              {preview ? (
                <div className="relative">
                  <img src={preview} alt="미리보기" className="max-h-48 mx-auto rounded-lg" />
                  <button onClick={e => { e.stopPropagation(); setPreview(null); setSelectedFile(null); }}
                    className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1"><X className="w-3 h-3" /></button>
                  <p className="text-xs text-slate-500 mt-2">{selectedFile?.name}</p>
                </div>
              ) : (
                <>
                  <FileInput className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-500">클릭하거나 파일을 드래그하세요</p>
                  <p className="text-xs text-slate-400 mt-1">JPG, PNG, PDF / 10MB 이하</p>
                </>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*,.pdf" className="hidden"
              onChange={e => handleFile(e.target.files?.[0] || null)} />

            <textarea value={uploadMemo} onChange={e => setUploadMemo(e.target.value)}
              placeholder="메모 (선택)"
              className="w-full mt-3 border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-2 focus:ring-blue-500" />

            <button onClick={doUpload} disabled={!selectedFile || uploading}
              className="w-full mt-3 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {uploading ? <><Loader2 className="w-4 h-4 animate-spin" /> AI 분석 중...</> : <><Upload className="w-4 h-4" /> 업로드 및 분석</>}
            </button>
          </div>
        </div>

        {/* 접수 목록 */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-bold text-slate-700">접수 목록</h3>
            </div>
            {loading ? (
              <div className="text-center py-12 text-slate-400 text-sm">로딩 중...</div>
            ) : rows.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-sm">접수 건이 없습니다</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {rows.map(r => {
                  const st = STATUS_MAP[r.status] || STATUS_MAP.UPLOADED;
                  return (
                    <div key={r.id} onClick={() => openDetail(r.id)}
                      className="px-5 py-3 flex items-center gap-4 hover:bg-gray-50 cursor-pointer transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-700">{r.patient_name || r.file_name}</span>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {r.diagnosis && `${r.diagnosis} · `}
                          {r.uploader?.display_name} · {new Date(r.created_at).toLocaleString('ko-KR')}
                        </p>
                      </div>
                      {r.status === 'REVIEW' && (
                        <span className="text-xs text-amber-600 font-semibold flex-shrink-0">검토 필요</span>
                      )}
                      <Eye className="w-4 h-4 text-slate-300 flex-shrink-0" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 상세/승인 모달 ── */}
      {(detail || detailLoading) && (
        <div className="modal-backdrop" onClick={() => !detailLoading && setDetail(null)}>
          <div className="modal max-w-4xl" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">의뢰서 상세</h3>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="modal-body">
              {detailLoading ? (
                <div className="text-center py-12 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
              ) : detail ? (
                <div className="grid md:grid-cols-2 gap-5">
                  {/* 좌측: 의뢰서 이미지 */}
                  <div>
                    <p className="text-xs font-bold text-slate-500 mb-2">의뢰서 원본</p>
                    {detail.mime_type?.startsWith('image/') ? (
                      <img src={detail.file_path} alt="의뢰서" className="w-full rounded-xl border" />
                    ) : (
                      <div className="bg-gray-100 rounded-xl p-8 text-center text-slate-400 text-sm">
                        PDF 파일 — <a href={detail.file_path} target="_blank" className="text-blue-600 underline">다운로드</a>
                      </div>
                    )}
                    {detail.memo && (
                      <p className="text-xs text-slate-400 mt-2">메모: {detail.memo}</p>
                    )}
                    {detail.ai_summary && (
                      <div className="mt-3 p-3 bg-blue-50 rounded-xl">
                        <p className="text-[10px] font-semibold text-blue-600 mb-1">AI 분석 요약</p>
                        <p className="text-xs text-slate-600">{detail.ai_summary}</p>
                      </div>
                    )}
                  </div>

                  {/* 우측: 추출 결과 / 승인 폼 */}
                  <div className="space-y-4">
                    {detail.status === 'APPROVED' || detail.status === 'REJECTED' ? (
                      /* 이미 처리된 건 */
                      <div>
                        <div className={`p-4 rounded-xl ${detail.status === 'APPROVED' ? 'bg-emerald-50' : 'bg-red-50'}`}>
                          <p className={`text-sm font-bold ${detail.status === 'APPROVED' ? 'text-emerald-700' : 'text-red-700'}`}>
                            {detail.status === 'APPROVED' ? '승인 완료' : '반려'}
                          </p>
                          {detail.approver && <p className="text-xs text-slate-500 mt-1">처리자: {detail.approver.display_name}</p>}
                          {detail.approved_at && <p className="text-xs text-slate-500">처리일: {new Date(detail.approved_at).toLocaleString('ko-KR')}</p>}
                          {detail.reject_reason && <p className="text-xs text-red-600 mt-1">사유: {detail.reject_reason}</p>}
                          {detail.patient && <p className="text-xs text-emerald-600 mt-1">등록 환자: {detail.patient.name} ({detail.patient.department?.name})</p>}
                        </div>
                      </div>
                    ) : (
                      /* 검토/승인 폼 */
                      <>
                        <p className="text-xs font-bold text-slate-500">환자 정보 (수정 가능)</p>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">환자명</label>
                            <input className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                              value={approveForm.patientName} onChange={e => setApproveForm(f => ({ ...f, patientName: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">차트번호</label>
                            <input className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                              value={approveForm.chartNo} onChange={e => setApproveForm(f => ({ ...f, chartNo: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">성별</label>
                            <select className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                              value={approveForm.gender} onChange={e => setApproveForm(f => ({ ...f, gender: e.target.value }))}>
                              <option value="UNKNOWN">미지정</option><option value="F">여</option><option value="M">남</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">보험유형</label>
                            <select className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                              value={approveForm.insuranceType} onChange={e => setApproveForm(f => ({ ...f, insuranceType: e.target.value }))}>
                              {INS_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                            </select>
                          </div>
                        </div>

                        <p className="text-xs font-bold text-slate-500 mt-2">병실 배정</p>
                        {detail.room_reason && (
                          <p className="text-xs text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg">{detail.room_reason}</p>
                        )}
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">병동</label>
                            <select className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                              value={approveForm.departmentId}
                              onChange={e => { setApproveForm(f => ({ ...f, departmentId: e.target.value })); loadRooms(e.target.value); }}>
                              <option value="">선택</option>
                              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">병실</label>
                            <select className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                              value={approveForm.finalRoom}
                              onChange={e => setApproveForm(f => ({ ...f, finalRoom: e.target.value }))}>
                              <option value="">선택</option>
                              {rooms.map((r: any) => <option key={r.id} value={r.room_no}>{r.room_no}호 ({r.capacity}인실)</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">병상번호</label>
                            <input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                              value={approveForm.finalBed} onChange={e => setApproveForm(f => ({ ...f, finalBed: e.target.value }))} />
                          </div>
                        </div>

                        {/* 반려 모드 */}
                        {rejectMode && (
                          <div className="mt-3">
                            <label className="text-[10px] text-slate-500 font-medium block mb-1">반려 사유</label>
                            <textarea className="w-full border border-red-200 rounded-lg px-3 py-2 text-sm resize-none h-20"
                              value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="반려 사유를 입력하세요" />
                          </div>
                        )}

                        {/* 버튼 */}
                        <div className="flex gap-2 mt-4">
                          {rejectMode ? (
                            <>
                              <button onClick={() => setRejectMode(false)} className="flex-1 py-2.5 bg-gray-100 text-slate-600 rounded-xl text-sm font-semibold">취소</button>
                              <button onClick={doReject} disabled={saving}
                                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-1">
                                <XCircle className="w-4 h-4" /> 반려 확정
                              </button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => setRejectMode(true)}
                                className="px-4 py-2.5 bg-red-50 text-red-600 rounded-xl text-sm font-semibold hover:bg-red-100 flex items-center gap-1">
                                <XCircle className="w-4 h-4" /> 반려
                              </button>
                              <button onClick={doApprove} disabled={saving || !approveForm.patientName || !approveForm.departmentId}
                                className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-1">
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                승인 → 환자 등록
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
