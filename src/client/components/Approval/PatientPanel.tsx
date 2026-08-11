import React from 'react';
import { Users, X } from 'lucide-react';

export interface PatientItem {
  id: string;
  name: string;
  room_no: string;
  bed_no: number | null;
}

interface Props {
  itemName?: string;
  itemCode?: string;
  patients: PatientItem[];
  onClose?: () => void;
}

export default function PatientPanel({ itemName, itemCode, patients, onClose }: Props) {
  if (!itemName) {
    return (
      <div className="card p-4 text-center text-sm text-gray-400">
        <Users className="w-6 h-6 mx-auto mb-2 text-gray-300" />
        라인을 선택하면 사용 환자 명단이 여기 표시됩니다.
      </div>
    );
  }

  return (
    <div className="card p-0">
      <div className="px-4 py-3 border-b border-slate-100 flex items-start justify-between">
        <div>
          <div className="text-xs text-gray-500">선택된 품목</div>
          <div className="font-semibold text-navy-800">{itemName}</div>
          {itemCode && <div className="text-xs text-gray-400 mt-0.5">{itemCode}</div>}
        </div>
        {onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        <div className="text-xs text-gray-500 mb-2 inline-flex items-center gap-1">
          <Users className="w-3.5 h-3.5" />
          사용 환자 {patients.length}명
        </div>
        {patients.length === 0 ? (
          <div className="py-3 text-center text-xs text-gray-400">사용 중인 환자가 없습니다.</div>
        ) : (
          <ul className="space-y-1">
            {patients.map(p => (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <span className="text-xs text-gray-500 font-mono w-12 flex-shrink-0">
                  {p.room_no}{p.bed_no != null ? `-${p.bed_no}` : ''}
                </span>
                <span className="text-slate-700">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
