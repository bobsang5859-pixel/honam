// 문서자동화 엔진 공통 타입 — 규칙엔진과 포맷 어댑터(엑셀/HWPX)가 공유.

export type FieldSource = 'DB_BOUND' | 'MANUAL' | 'AUTO_SEQ';

export interface FieldDef {
  key: string;               // 필드 고유 키 (예: "vendor_name")
  label: string;              // 화면 표시 라벨 (예: "거래처")
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea';
  source: FieldSource;        // DB_BOUND = bind_path 로 소스 데이터에서 자동 추출, MANUAL = 사용자 직접 입력
  bind_path?: string;         // source=DB_BOUND 일 때 소스 객체에서 값을 꺼낼 dot-path (예: "vendor.name")
  required?: boolean;
  options?: string[];         // type='select' 용 선택지
  default_value?: string;
  group?: string;             // 화면에서 묶어서 보여줄 그룹명
  excel_cell?: { sheet_index: number; cell: string }; // format=EXCEL 일 때 이 필드가 들어갈 셀
  auto_seq?: AutoSeqConfig;   // source=AUTO_SEQ 일 때 채번 규칙
}

// 자동 채번 — 예: 기안서 문서번호 "호남-26-004". scope_key_template 으로 연도별 등
// 채번 범위를 나누고, number_template 의 {seq} 자리에 그 범위의 다음 번호를 넣는다.
// 둘 다 {yy}(2자리 연도)/{yyyy}(4자리 연도) 토큰을 치환할 수 있다.
export interface AutoSeqConfig {
  scope_key_template: string;   // 예: "GIAN-{yyyy}"
  number_template: string;      // 예: "호남-{yy}-{seq}"
  pad: number;                  // {seq} 자릿수 (예: 3 -> "004")
}

export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'isTrue' | 'isFalse';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; op: ConditionOp; value?: unknown };

export type ActionType =
  | 'SHOW_FIELD'
  | 'HIDE_FIELD'
  | 'SHOW_SECTION'
  | 'HIDE_SECTION'
  | 'ADD_TABLE_ROWS';

export interface RuleDef {
  id: string;
  priority: number;           // 낮은 값 먼저 평가 (뒤 규칙이 앞 규칙 결과를 덮어쓸 수 있음)
  condition: Condition;
  action_type: ActionType;
  action_payload: {
    field_key?: string;       // SHOW_FIELD | HIDE_FIELD
    section_key?: string;     // SHOW_SECTION | HIDE_SECTION
    table_key?: string;       // ADD_TABLE_ROWS
    rows?: Record<string, string>[]; // ADD_TABLE_ROWS — 고정 행 추가용(품목 표 자체는 별도 반복 바인딩으로 처리)
  };
}

export interface TableRowsSpec {
  table_key: string;
  rows: Record<string, string>[];
}

export interface RenderPlan {
  visible_fields: string[];
  hidden_fields: string[];
  visible_sections: string[];
  hidden_sections: string[];
  extra_table_rows: TableRowsSpec[];
  warnings: string[];
}
