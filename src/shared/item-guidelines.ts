// 의료소모품 사용 가이드라인 — 서버·클라이언트 공유.
//
// 카테고리·이름 패턴으로 자동 매칭. usage-kind.ts 와 동일 구조 (정적 상수).
//
// 핵심 용도:
//   1. 권장 신청량 자동 계산 (재고 추론 엔진의 입력값)
//   2. 총무부 분석 화면 — 부서별 실제 vs 권장 비교
//   3. 사유 자동 추론 (BLOCKAGE / INFECTION_OUTBREAK 등)
//
// 화면 노출 정책 (병동 zero-burden):
//   - 병동 화면: 권장량 자동 prefill 만. 비용·경고·사유 입력 X.
//   - 총무부 화면: 모든 분석 정보 표시.
//
// 데이터 출처: CDC, 심평원 고시 제2025-75호, 의료기관평가인증원 4주기,
//              제조사 권장, 한국 임상 표준.

export type UsageTrigger =
  | 'INJECTION'      // 주사 시점 (알콜스왑·주사기 등)
  | 'DRESSING'       // 드레싱 시점 (거즈·테이프 등)
  | 'CONTINUOUS'     // 환자별 상시 사용 (Foley·IV 등)
  | 'EVENT'          // 시술·이벤트 시점 (Nelaton·시술 도구)
  | 'STERILIZATION'; // 멸균 시점 (Indicator 등)

export type GuidelineSource =
  | 'CDC'             // 미국 질병통제예방센터
  | 'HIRA'            // 한국 심평원 인정 기준
  | 'KOREAN_CLINICAL' // 한국 임상 표준
  | 'MANUFACTURER'    // 제조사 권장
  | 'ESTIMATE';       // 추정값

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type ItemGuideline = {
  purpose: string;                     // 용도
  replacement: {
    hours?: number;                     // 시간 단위 교체
    days?: number;                      // 일 단위 교체
    per_event?: boolean;                // 시술/이벤트마다 1회
    single_use?: boolean;               // 1회용 (사용 후 폐기)
    per_patient?: boolean;              // 환자별 전용 (다회 사용)
    on_demand?: boolean;                // routine 교체 X (감염·기능부전 시만)
  };
  caution: string;                      // 주의사항 (총무부 화면 전용)
  usage_per_patient_per_day?: number;   // 1환자·1일 사용 빈도 (추론용)
  usage_trigger?: UsageTrigger;
  variance_tolerance: number;           // 허용 편차 (0.2 = ±20%)
  unit_cost?: number;                   // 단가 (DB Item.unit_cost 우선, 없을 때 fallback)
  request_period_days?: number;         // 신청 주기 (일). 기본 30일 (월 1회). 기저귀는 7 (주 1회)
  source: GuidelineSource;
  confidence: Confidence;
};

type GuidelineMatcher = {
  match: (item: { name?: string | null; category?: string | null; sub_category?: string | null }) => boolean;
  guide: ItemGuideline;
};

// 매처 — 더 구체적인 패턴이 먼저 와야 함 (first match wins).
const MATCHERS: GuidelineMatcher[] = [
  // ============ MED_AIRWAY (호흡·삽관) ============

  // ENDO TUBE — 1회용, 발관 시 폐기
  {
    match: (i) => i.category === 'MED_AIRWAY' && /endo\s*tube|기관삽관/i.test(i.name ?? ''),
    guide: {
      purpose: '기관내 삽관용 튜브',
      replacement: { single_use: true, per_patient: true },
      caution: '1회용. 발관 시 폐기. 무균 삽입.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // TRACOE (기관절개관) — 실리콘 1회용 1개월
  {
    match: (i) => /tracoe|tracheostomy|기관절개/i.test(i.name ?? ''),
    guide: {
      purpose: '기관절개관 (실리콘)',
      replacement: { days: 30, per_patient: true },
      caution: '1개월 1회 교체. 막힘·기능부전 시 즉시.',
      usage_per_patient_per_day: 1 / 30,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'MANUFACTURER',
      confidence: 'MEDIUM',
    },
  },

  // T-piece (기관절개관 산소공급) — T-Tube 보다 먼저
  {
    match: (i) => /t-piece|t\s*piece|tpiece/i.test(i.name ?? ''),
    guide: {
      purpose: '기관절개관 산소공급용 T자관',
      replacement: { hours: 48, per_patient: true },
      caution: '24~72시간 교체 (CDC 인공호흡기 회로 기준). 가시적 오염 시 즉시.',
      usage_per_patient_per_day: 0.5,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // T-Tube (기관 T자관) — 1~3개월
  {
    match: (i) => /t-tube|t\s*tube|ttube|t_tube/i.test(i.name ?? ''),
    guide: {
      purpose: '기관절개공 유지용 T자관',
      replacement: { days: 60, per_patient: true },
      caution: '1~3개월 교체. 막힘·기능부전 시 즉시.',
      usage_per_patient_per_day: 1 / 60,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Speech Cannula (발성캐뉼라)
  {
    match: (i) => /speech\s*cannul|speechcannu|발성캐뉼/i.test(i.name ?? ''),
    guide: {
      purpose: '발성용 기관 캐뉼라 (실리콘)',
      replacement: { days: 60, per_patient: true },
      caution: '1~3개월 교체. 손상·막힘 시 즉시.',
      usage_per_patient_per_day: 1 / 60,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.4,
      source: 'MANUFACTURER',
      confidence: 'MEDIUM',
    },
  },

  // Nasal Cannula
  {
    match: (i) => /nasal\s*cann?ul|비강캐뉼/i.test(i.name ?? ''),
    guide: {
      purpose: '저유량 산소공급용 비강 캐뉼라',
      replacement: { days: 7, per_patient: true },
      caution: '환자별 1주 1회 교체. 가시적 오염 시 즉시.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // O2 Mask
  {
    match: (i) => i.category === 'MED_AIRWAY' && /o2\s*mask|산소\s*마스크/i.test(i.name ?? ''),
    guide: {
      purpose: '산소 마스크',
      replacement: { days: 7, per_patient: true },
      caution: '환자별 1주 1회 교체.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // O2 Line
  {
    match: (i) => /o2\s*line|산소\s*라인/i.test(i.name ?? ''),
    guide: {
      purpose: '산소 공급 라인',
      replacement: { days: 10, per_patient: true },
      caution: '환자별 1~2주 교체.',
      usage_per_patient_per_day: 1 / 10,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Air Way (구강 기도유지기)
  {
    match: (i) => /air\s*way|에어웨이/i.test(i.name ?? ''),
    guide: {
      purpose: '구강 기도유지기 (의식저하 환자용)',
      replacement: { single_use: true, per_patient: true },
      caution: '1회용. 의식 회복 시 제거.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Nebulizer Mask (먼저)
  {
    match: (i) => /nebu.+mask|네뷸.+마스크/i.test(i.name ?? ''),
    guide: {
      purpose: '네뷸라이저용 마스크',
      replacement: { days: 7, per_patient: true },
      caution: '환자별 1주 교체. 사용 후 청소·건조.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Nebulizer Kit
  {
    match: (i) => /nebu/i.test(i.name ?? ''),
    guide: {
      purpose: '네뷸라이저 키트 (약물통+호스+마스크)',
      replacement: { days: 7, per_patient: true },
      caution: '환자별 1주 교체. 사용 후 세척·완전 건조.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'MANUFACTURER',
      confidence: 'MEDIUM',
    },
  },

  // Breathing Set (인공호흡기 회로)
  {
    match: (i) => /breathing\s*set|breath\s*set|브레딩\s*세트/i.test(i.name ?? ''),
    guide: {
      purpose: '인공호흡기 회로',
      replacement: { days: 7, per_patient: true },
      caution: 'CDC 권고 routine 교체 불필요. 한국 임상 1주 또는 가시적 오염·기능부전 시 즉시.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // Suction Tip — 시술마다 (Suction line 보다 먼저)
  {
    match: (i) => /suction\s*tip/i.test(i.name ?? ''),
    guide: {
      purpose: '흡인용 팁 (1회용)',
      replacement: { per_event: true, single_use: true },
      caution: '시술마다 1회용. 환자간 교차 사용 금지.',
      usage_per_patient_per_day: 4,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // Suction Line
  {
    match: (i) => /suction\s*line|석션\s*라인/i.test(i.name ?? ''),
    guide: {
      purpose: '흡인기 연결 라인',
      replacement: { hours: 24, per_patient: true },
      caution: '폐쇄형 24시간 교체. 개방형은 1회용. 환자별 분리.',
      usage_per_patient_per_day: 1,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'MEDIUM',
    },
  },

  // M-VAC (다회용 흡인기)
  {
    match: (i) => /m-vac|mvac/i.test(i.name ?? ''),
    guide: {
      purpose: '다회용 흡인기 (장비 부속)',
      replacement: { per_patient: true },
      caution: '재사용 가능. 사용 후 소독.',
      variance_tolerance: 0.5,
      source: 'MANUFACTURER',
      confidence: 'LOW',
    },
  },

  // Stylet / Laryngo Scope (다회용)
  {
    match: (i) => /stylet|laryngo/i.test(i.name ?? ''),
    guide: {
      purpose: '삽관 보조기구 (다회용)',
      replacement: { per_patient: true },
      caution: '재사용 가능. 사용 후 멸균·소독.',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'LOW',
    },
  },

  // 산소메타 (장비)
  {
    match: (i) => /산소\s*메타/i.test(i.name ?? ''),
    guide: {
      purpose: '산소 압력계 (장비)',
      replacement: { per_patient: true },
      caution: '장비 — 정기 점검.',
      variance_tolerance: 0.5,
      source: 'ESTIMATE',
      confidence: 'LOW',
    },
  },

  // 덴탈/위생 마스크
  {
    match: (i) => /덴탈\s*마스크|위생\s*마스크/i.test(i.name ?? ''),
    guide: {
      purpose: '시술용 마스크 (1회용)',
      replacement: { per_event: true, single_use: true },
      caution: '시술마다 1회용.',
      usage_per_patient_per_day: 1,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // ============ MED_CATHETER (도뇨·튜브) ============

  // S/Foley Cath (실리콘 폴리 카테터)
  {
    match: (i) => /foley|폴리/i.test(i.name ?? ''),
    guide: {
      purpose: '유치 도뇨용 실리콘 카테터',
      replacement: { days: 14, per_patient: true },
      caution: '한국 심평원 인정 기준 2주 1회. 막힘·감염 의심 시 즉시. CAUTI 예방 무균 관리.',
      usage_per_patient_per_day: 1 / 14,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.2,
      source: 'HIRA',
      confidence: 'HIGH',
    },
  },

  // Urine Bag (유린백)
  {
    match: (i) => /urine\s*bag|유린|소변백/i.test(i.name ?? ''),
    guide: {
      purpose: '폐쇄식 소변백',
      replacement: { days: 7, per_patient: true },
      caution: 'Foley 교체 시 동시 교체 권장. 1주 1회 또는 손상·역류 시 즉시.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // Connector (도뇨 연결구)
  {
    match: (i) => i.category === 'MED_CATHETER' && /connector|커넥터/i.test(i.name ?? ''),
    guide: {
      purpose: '도뇨 카테터 연결구',
      replacement: { days: 14, per_patient: true },
      caution: 'Foley 교체 시 동시 교체.',
      usage_per_patient_per_day: 1 / 14,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // I.V CATH (정맥유치카테터) — MED_CATHETER 측
  {
    match: (i) => i.category === 'MED_CATHETER' && /i\.?v\s*cath|medicut/i.test(i.name ?? ''),
    guide: {
      purpose: '정맥유치 카테터',
      replacement: { hours: 96, per_patient: true },
      caution: 'CDC 96시간 또는 routine 교체 X (성인). 발적·통증 시 즉시. 무균 삽입.',
      usage_per_patient_per_day: 1 / 4,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // Levin Tube (비위관) — PVC 가정
  {
    match: (i) => /levin|레빈/i.test(i.name ?? ''),
    guide: {
      purpose: '비위관 (PVC)',
      replacement: { days: 7, per_patient: true },
      caution: 'PVC 1주 1회 (단기용). 실리콘은 4~6주. 제거 시 폐기.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'MANUFACTURER',
      confidence: 'MEDIUM',
    },
  },

  // Nelaton Cath (단순 도뇨)
  {
    match: (i) => /nelaton|넬라톤/i.test(i.name ?? ''),
    guide: {
      purpose: '간헐적 도뇨용 카테터',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 도뇨마다 1개.',
      usage_per_patient_per_day: 4,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // Rectal Tube (직장튜브)
  {
    match: (i) => /rectal\s*tube|렉털|직장/i.test(i.name ?? ''),
    guide: {
      purpose: '직장 튜브',
      replacement: { per_event: true, single_use: true },
      caution: '시행마다 1회용.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Surgical Jelly (윤활제)
  {
    match: (i) => /surgical\s*jelly|윤활/i.test(i.name ?? ''),
    guide: {
      purpose: '카테터 삽입용 윤활제',
      replacement: { days: 30 },
      caution: '개봉 후 30일 이내 사용. 단가 사용 시 환자간 교차 X.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'MANUFACTURER',
      confidence: 'MEDIUM',
    },
  },

  // TWO-lumen CVC (중심정맥카테터)
  {
    match: (i) => /cvc|two-lumen|중심정맥/i.test(i.name ?? ''),
    guide: {
      purpose: '중심정맥 카테터 (이중)',
      replacement: { on_demand: true, per_patient: true },
      caution: 'routine 교체 X. 감염·기능부전 의심 시 즉시 교체. CLABSI 예방 부위 점검.',
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.5,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // SURECAN Safety
  {
    match: (i) => /surecan/i.test(i.name ?? ''),
    guide: {
      purpose: '안전 정맥/포트 천자침',
      replacement: { per_event: true, single_use: true },
      caution: '천자마다 1개. 사용 후 자동 차폐 확인.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'MANUFACTURER',
      confidence: 'HIGH',
    },
  },

  // 바일백 (담즙 배액백)
  {
    match: (i) => /바일백|bile\s*bag/i.test(i.name ?? ''),
    guide: {
      purpose: '담즙 배액백',
      replacement: { days: 7, per_patient: true },
      caution: '1주 1회 교체. 가득 차면 즉시 교체.',
      usage_per_patient_per_day: 1 / 7,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // ============ MED_HANBANG (한방재료) ============

  // 동방침
  {
    match: (i) => /동방침|침$|침\s/i.test(i.name ?? '') && i.category === 'MED_HANBANG',
    guide: {
      purpose: '침구 시술용 1회용 침',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 손상성 의료폐기물 (노란통).',
      usage_per_patient_per_day: 10,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // 동서미니뜸 / 쑥봉지
  {
    match: (i) => /뜸|moxa|쑥봉지/i.test(i.name ?? ''),
    guide: {
      purpose: '뜸 시술 재료',
      replacement: { per_event: true, single_use: true },
      caution: '시술마다 1회용. 화상 주의.',
      usage_per_patient_per_day: 5,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 부항
  {
    match: (i) => /부항/i.test(i.name ?? ''),
    guide: {
      purpose: '부항 시술 기구 (다회용)',
      replacement: { per_patient: true },
      caution: '소독 후 재사용. 환자별 분리.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'LOW',
    },
  },

  // 목초액 / 절사
  {
    match: (i) => /목초액|절사/i.test(i.name ?? ''),
    guide: {
      purpose: '한방 외용 재료',
      replacement: { days: 30 },
      caution: '개봉 후 1개월 권장.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'ESTIMATE',
      confidence: 'LOW',
    },
  },

  // ============ MED_INJECTION (주사·수액) ============

  // I.V Set (수액세트)
  {
    match: (i) => /i\.?v\s*set|수액\s*세트/i.test(i.name ?? ''),
    guide: {
      purpose: '수액 세트',
      replacement: { hours: 96, per_patient: true },
      caution: 'CDC 96시간. 지질·혈액제제 24시간. 폐쇄 체계 유지.',
      usage_per_patient_per_day: 1 / 4,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // I.V Catheter (Medicut) — MED_INJECTION 측
  {
    match: (i) => i.category === 'MED_INJECTION' && /catheter|medicut/i.test(i.name ?? ''),
    guide: {
      purpose: '정맥유치 카테터',
      replacement: { hours: 96, per_patient: true },
      caution: 'CDC 96시간. 발적·통증 시 즉시. 무균 삽입.',
      usage_per_patient_per_day: 1 / 4,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // Heparine Cap
  {
    match: (i) => /heparine?\s*cap|헤파린/i.test(i.name ?? ''),
    guide: {
      purpose: '헤파린 락 (정맥카테터 마개)',
      replacement: { hours: 96, per_patient: true },
      caution: 'IV catheter 와 함께 교체. 12시간마다 헤파린 플러시.',
      usage_per_patient_per_day: 1 / 4,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'MEDIUM',
    },
  },

  // 3-Way
  {
    match: (i) => /3-?way|3\s*way|3방/i.test(i.name ?? ''),
    guide: {
      purpose: '3방 활전 (수액 분지구)',
      replacement: { hours: 96, per_patient: true },
      caution: 'IV Set 와 함께 교체. 무균.',
      usage_per_patient_per_day: 1 / 4,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'MEDIUM',
    },
  },

  // novo fine (인슐린펜 바늘)
  {
    match: (i) => /novo\s*fine|novofine|인슐린/i.test(i.name ?? ''),
    guide: {
      purpose: '인슐린 펜 바늘',
      replacement: { per_event: true, single_use: true },
      caution: '매 주사마다 1개. 절대 재사용 X (피부 손상·감염).',
      usage_per_patient_per_day: 4,
      usage_trigger: 'INJECTION',
      variance_tolerance: 0.3,
      source: 'MANUFACTURER',
      confidence: 'HIGH',
    },
  },

  // D/Syringe (1회용 주사기)
  {
    match: (i) => /d\/syringe|일회용\s*주사기|채혈주사기/i.test(i.name ?? ''),
    guide: {
      purpose: '1회용 주사기',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 절대 재사용 X.',
      usage_per_patient_per_day: 3,
      usage_trigger: 'INJECTION',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // D/Needle (1회용 주사바늘)
  {
    match: (i) => /d\/needle|주사바늘|needle/i.test(i.name ?? ''),
    guide: {
      purpose: '1회용 주사바늘',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 손상성 의료폐기물 (노란통).',
      usage_per_patient_per_day: 3,
      usage_trigger: 'INJECTION',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // Dosi Flow
  {
    match: (i) => /dosi\s*flow|dosiflow|점적\s*조절/i.test(i.name ?? ''),
    guide: {
      purpose: '수액 점적 조절기',
      replacement: { per_patient: true },
      caution: '환자별 1개. IV Set 와 함께.',
      usage_per_patient_per_day: 1 / 4,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Enema Syringe (관장용 시린지)
  {
    match: (i) => /enema/i.test(i.name ?? ''),
    guide: {
      purpose: '관장용 시린지',
      replacement: { per_patient: true },
      caution: '환자별 전용 (세척 재사용 또는 1회용).',
      usage_per_patient_per_day: 0.1,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'LOW',
    },
  },

  // 토니켓
  {
    match: (i) => /토니켓|tourniquet/i.test(i.name ?? ''),
    guide: {
      purpose: '정맥 채혈용 압박대',
      replacement: { per_patient: true },
      caution: '환자별 전용 또는 매번 알코올 소독. 다환자 사용 시 감염 위험.',
      usage_trigger: 'INJECTION',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 투약병
  {
    match: (i) => /투약병/i.test(i.name ?? ''),
    guide: {
      purpose: '약물 보관·투약 병',
      replacement: { per_patient: true },
      caution: '환자별 1회. 라벨링 필수 (약명·용량·환자명).',
      usage_per_patient_per_day: 0.5,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // ============ MED_DRESSING (드레싱·고정) ============

  // 3M 테가덤 (CHG 포함)
  {
    match: (i) => /테가덤|tegaderm/i.test(i.name ?? ''),
    guide: {
      purpose: '투명 필름 드레싱 (IV·수술 부위)',
      replacement: { days: 7 },
      caution: '최대 7일 (CHG 형 동일). 들뜸·오염 시 즉시 교체.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.3,
      source: 'MANUFACTURER',
      confidence: 'HIGH',
    },
  },

  // 장루파우치
  {
    match: (i) => /장루.*파우치|ostomy.*pouch|파우치.*장루/i.test(i.name ?? ''),
    guide: {
      purpose: '장루용 파우치',
      replacement: { days: 1, per_patient: true },
      caution: '1일 1회 교체 (심평원 주 7회 인정).',
      usage_per_patient_per_day: 1,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'HIRA',
      confidence: 'HIGH',
    },
  },

  // 장루판
  {
    match: (i) => /장루.*판|ostomy.*plate|판.*장루/i.test(i.name ?? ''),
    guide: {
      purpose: '장루판 (피부 보호판)',
      replacement: { days: 4, per_patient: true },
      caution: '주 2회 교체 (심평원 인정).',
      usage_per_patient_per_day: 1 / 4,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.3,
      source: 'HIRA',
      confidence: 'HIGH',
    },
  },

  // 탄력붕대
  {
    match: (i) => /탄력붕대|elastic\s*band/i.test(i.name ?? ''),
    guide: {
      purpose: '탄력붕대 (압박·고정)',
      replacement: { per_patient: true },
      caution: '환자별 전용. 오염·신축성 저하 시 교체.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 솜붕대
  {
    match: (i) => /솜붕대/i.test(i.name ?? ''),
    guide: {
      purpose: '솜붕대 (충전·고정)',
      replacement: { per_event: true, single_use: true },
      caution: '드레싱 시 교체. 삼출물 묻으면 조직물류 의료폐기물.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 스프린트
  {
    match: (i) => /스프린트|splint/i.test(i.name ?? ''),
    guide: {
      purpose: '스프린트 (고정·부목)',
      replacement: { per_patient: true },
      caution: '환자별 전용. 손상 시 교체.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'LOW',
    },
  },

  // EKG Electrode
  {
    match: (i) => /ekg\s*electrode|skintact|심전도\s*전극/i.test(i.name ?? ''),
    guide: {
      purpose: '심전도 전극 (1회용)',
      replacement: { hours: 24, single_use: true },
      caution: '24시간 내 교체. 24시간 초과 시 피부 자극.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'MANUFACTURER',
      confidence: 'HIGH',
    },
  },

  // Surgical Pad
  {
    match: (i) => /surgical\s*pad|수술.*패드/i.test(i.name ?? ''),
    guide: {
      purpose: '수술 후 두꺼운 흡수 패드',
      replacement: { days: 1 },
      caution: '삼출물 양에 따라 1~2일 교체.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Gauze (멸균 거즈)
  {
    match: (i) => /gauze|거즈/i.test(i.name ?? ''),
    guide: {
      purpose: '멸균 거즈 (드레싱·소독)',
      replacement: { per_event: true, single_use: true },
      caution: '드레싱마다 폐기. 삼출물·감염 시 즉시 교체.',
      usage_per_patient_per_day: 2,
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // Cotton Ball
  {
    match: (i) => /cotton\s*ball|솜뭉치/i.test(i.name ?? ''),
    guide: {
      purpose: '소독·세척용 솜',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 알코올·포비돈 적셔 사용.',
      usage_per_patient_per_day: 3,
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // micropore / Biopore
  {
    match: (i) => /micropore|biopore|마이크로포어/i.test(i.name ?? ''),
    guide: {
      purpose: '부직포 테이프 (저자극)',
      replacement: { days: 5 },
      caution: '드레싱과 함께 3~7일 교체. 민감 피부에 적합.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // Fix Roll Tape
  {
    match: (i) => /fix\s*roll|반창고|일반\s*테이프/i.test(i.name ?? ''),
    guide: {
      purpose: '일반 고정 테이프',
      replacement: { days: 2 },
      caution: '드레싱과 함께 교체. 피부 자극 강해 장기 X.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 밴드에스 (반창고)
  {
    match: (i) => /밴드에스|밴드\s*aid/i.test(i.name ?? ''),
    guide: {
      purpose: '일회용 반창고',
      replacement: { days: 1 },
      caution: '1~2일 교체.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 솜면봉 / 탈지면
  {
    match: (i) => /솜면봉|탈지면/i.test(i.name ?? ''),
    guide: {
      purpose: '소독·구강케어용 솜',
      replacement: { per_event: true, single_use: true },
      caution: '1회용.',
      usage_per_patient_per_day: 4,
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // ============ MED_SURGICAL (수술·시술) ============

  // Surgical Blade
  {
    match: (i) => /surgical\s*blade|수술.*칼날|메스/i.test(i.name ?? ''),
    guide: {
      purpose: '수술 메스 칼날',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 손상성 의료폐기물 (노란통).',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // 봉합사 NYLON
  {
    match: (i) => /nylon|봉합사|봉합실/i.test(i.name ?? ''),
    guide: {
      purpose: '비흡수성 봉합사',
      replacement: { per_event: true, single_use: true },
      caution: '1회 사용. 5~14일 후 발사 (부위별 차이).',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // ============ MED_DISINFECT (소독·멸균) ============

  // 알콜스왑
  {
    match: (i) => /알콜\s*스왑|알코올\s*스왑|alcohol\s*swab/i.test(i.name ?? ''),
    guide: {
      purpose: '주사 부위 소독용 알코올 솜',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 개봉 후 건조 빠름.',
      usage_per_patient_per_day: 3,
      usage_trigger: 'INJECTION',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // 스킨코튼플러스
  {
    match: (i) => /스킨\s*코튼|skincotton/i.test(i.name ?? ''),
    guide: {
      purpose: '알코올 솜 (대용량)',
      replacement: { per_event: true, single_use: true },
      caution: '1회용.',
      usage_per_patient_per_day: 3,
      usage_trigger: 'INJECTION',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // 손소독제
  {
    match: (i) => /손\s*소독/i.test(i.name ?? ''),
    guide: {
      purpose: '손 위생용 소독제',
      replacement: { per_patient: true },
      caution: '부서별 1통. 진료/처치 전후 사용. 인증평가 필수 항목.',
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // 멸균 Indicator (3M 1322 등)
  {
    match: (i) => /indicator|3m\s*1322|steam\s*chemical|sep\s*steam/i.test(i.name ?? ''),
    guide: {
      purpose: '멸균 화학적 지시제',
      replacement: { per_event: true, single_use: true },
      caution: '멸균마다 1개. 색 변경 안 됐으면 멸균 실패 — 재멸균.',
      usage_trigger: 'STERILIZATION',
      variance_tolerance: 0.3,
      source: 'MANUFACTURER',
      confidence: 'HIGH',
    },
  },

  // Biological Indicator
  {
    match: (i) => /biological\s*indicator|1262/i.test(i.name ?? ''),
    guide: {
      purpose: '멸균 생물학적 지시제',
      replacement: { days: 7 },
      caution: '주 1회 멸균기 효율 검사. 결과 음성이어야 멸균 유효.',
      usage_trigger: 'STERILIZATION',
      variance_tolerance: 0.2,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // 롤 크라프트지
  {
    match: (i) => /크라프트|롤\s*패키지/i.test(i.name ?? ''),
    guide: {
      purpose: '멸균 포장지',
      replacement: { per_event: true, single_use: true },
      caution: '멸균 후 30일 이내 사용 권장.',
      usage_trigger: 'STERILIZATION',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 과산화수소
  {
    match: (i) => /과산화수소|peroxide/i.test(i.name ?? ''),
    guide: {
      purpose: '상처·기관절개관 내관 소독',
      replacement: { days: 60 },
      caution: '개봉 후 1~3개월 내 사용. 갈색병 보관 (광분해).',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 알코올 / 에탄올 (1L/18L)
  {
    match: (i) => /알코올\s*\d|에탄올|alcohol\s*\d/i.test(i.name ?? ''),
    guide: {
      purpose: '일반 소독용 알코올',
      replacement: { days: 180 },
      caution: '개봉 후 6개월. 화기 주의.',
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 포비돈 / 염화벤잘코늄
  {
    match: (i) => /포비돈|povidone|염화벤잘코늄|벤잘코늄/i.test(i.name ?? ''),
    guide: {
      purpose: '피부·점막 소독제',
      replacement: { days: 180 },
      caution: '개봉 후 6개월~1년. 갈색병 보관.',
      usage_trigger: 'DRESSING',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 뉴젠 (혈액 응고 방지제)
  {
    match: (i) => /뉴젠|nugen/i.test(i.name ?? ''),
    guide: {
      purpose: '혈액 검체 응고 방지제',
      replacement: { per_event: true, single_use: true },
      caution: '검체 시점에 사용.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'MANUFACTURER',
      confidence: 'MEDIUM',
    },
  },

  // 목설압자
  {
    match: (i) => /목설압자|tongue\s*depressor/i.test(i.name ?? ''),
    guide: {
      purpose: '구강 진찰용 압자',
      replacement: { per_event: true, single_use: true },
      caution: '1회용. 환자별 폐기.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // 아세톤
  {
    match: (i) => /아세톤|acetone/i.test(i.name ?? ''),
    guide: {
      purpose: '매니큐어 제거 (산소포화도 측정 전)',
      replacement: { days: 365 },
      caution: '소량 사용. 화기 주의.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.5,
      source: 'ESTIMATE',
      confidence: 'LOW',
    },
  },

  // EKG Paper
  {
    match: (i) => /ekg\s*paper|심전도.*용지/i.test(i.name ?? ''),
    guide: {
      purpose: '심전도 인쇄용지',
      replacement: { per_event: true },
      caution: '측정 시 사용.',
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // ============ INFECT_* (감염관리) ============

  // 글러브 (멸균/일반)
  {
    match: (i) => i.category === 'INFECT_GLOVE' || /글러브|glove|장갑/i.test(i.name ?? ''),
    guide: {
      purpose: '의료용 장갑',
      replacement: { per_event: true, single_use: true },
      caution: '시술마다 1회용. 환자간 교차 사용 금지.',
      usage_per_patient_per_day: 6,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // 가운
  {
    match: (i) => i.category === 'INFECT_GOWN' || /가운|gown/i.test(i.name ?? ''),
    guide: {
      purpose: '격리·시술용 가운',
      replacement: { per_event: true, single_use: true },
      caution: '시술마다 1회용. 격리환자 1일 다회.',
      usage_per_patient_per_day: 1,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.4,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // N95 마스크
  {
    match: (i) => /n95/i.test(i.name ?? ''),
    guide: {
      purpose: 'N95 호흡기 보호 마스크',
      replacement: { hours: 8, single_use: true },
      caution: '1회용 또는 8시간 이내. 결핵·격리 환자 접촉 시 필수.',
      usage_per_patient_per_day: 1,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.3,
      source: 'CDC',
      confidence: 'HIGH',
    },
  },

  // INFECT_MASK (덴탈 등)
  {
    match: (i) => i.category === 'INFECT_MASK',
    guide: {
      purpose: '비말 차단 마스크',
      replacement: { per_event: true, single_use: true },
      caution: '시술마다 1회용.',
      usage_per_patient_per_day: 2,
      usage_trigger: 'EVENT',
      variance_tolerance: 0.3,
      source: 'KOREAN_CLINICAL',
      confidence: 'HIGH',
    },
  },

  // ============ DIAPER (기저귀) ============

  // 겉기저귀 — 외피·고정용 (덜 자주 교체).
  // 1일 1.5매 사용 / 1팩=10매 → 0.15 팩/일.
  // 신청 주기 7일 (기저귀는 주 1회 신청).
  // 환자 10명·7일 = ≈ 11 팩.
  {
    match: (i) => /겉기저귀/i.test(i.name ?? ''),
    guide: {
      purpose: '겉기저귀 (외피·고정용)',
      replacement: { per_patient: true },
      caution: '요양병원 평균 1일 1~2매 교체 (외피이므로 속기저귀보다 덜 자주). 1팩=10매 가정.',
      usage_per_patient_per_day: 0.15,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.4,
      request_period_days: 7,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 속기저귀 — 흡수 패드 (자주 교체).
  // 1일 5매 사용 / 1팩=10매 → 0.5 팩/일.
  // 환자 10명·7일 = ≈ 35 팩.
  {
    match: (i) => /속기저귀/i.test(i.name ?? ''),
    guide: {
      purpose: '속기저귀 (흡수 패드)',
      replacement: { per_patient: true },
      caution: '요양병원 평균 1일 4~6매 교체 (속패드 — 젖을 때마다). 1팩=10매 가정.',
      usage_per_patient_per_day: 0.5,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.4,
      request_period_days: 7,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // 이지메트 — 침대 밑 보호 매트.
  // 1일 1매 사용 / 1팩=20매 → 0.05 팩/일.
  // 환자 10명·7일 = ≈ 4 팩.
  {
    match: (i) => /이지메트|침대\s*보호/i.test(i.name ?? ''),
    guide: {
      purpose: '침대 보호 매트',
      replacement: { per_patient: true },
      caution: '오염 시 교체. 1팩=20매 가정.',
      usage_per_patient_per_day: 0.05,
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.4,
      request_period_days: 7,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },

  // PAT_DIAPER (보조 기저귀 용품)
  {
    match: (i) => i.category === 'PAT_DIAPER',
    guide: {
      purpose: '환자용 기저귀 보조 용품',
      replacement: { per_patient: true },
      caution: '환자별 사용.',
      usage_trigger: 'CONTINUOUS',
      variance_tolerance: 0.4,
      source: 'KOREAN_CLINICAL',
      confidence: 'MEDIUM',
    },
  },
];

// 카테고리·이름 패턴으로 가이드라인 결정.
// 매칭 안 되는 품목 (MED_OTHER, OFF_*, FAC_* 등)은 null 반환 — 신청 화면에서 권장량 prefill X.
export function getItemGuideline(item: { name?: string | null; category?: string | null; sub_category?: string | null }): ItemGuideline | null {
  for (const m of MATCHERS) {
    if (m.match(item)) return m.guide;
  }
  return null;
}

// 이 카테고리는 추론 대상인지 (병동 화면 자동 prefill 적용 여부)
export function isGuidedCategory(category?: string | null): boolean {
  if (!category) return false;
  return (
    category.startsWith('MED_') ||
    category.startsWith('INFECT_') ||
    category.startsWith('DIAPER_') ||
    category === 'PAT_DIAPER'
  );
}

// B2 — 사이즈별 동일 가이드라인 적용 검증.
// 한 품목군(같은 이름·카테고리, 다른 sub_category)이 같은 가이드라인을 받는지 확인.
// 매처가 sub_category 를 보지 않는 경우(현재 거의 모든 매처)는 자동 동일.
// sub_category 패턴 차이로 매처가 갈리는 경우만 null 외 결과 반환.
export function getGuidelinesForSizes(
  items: ReadonlyArray<{ name?: string | null; category?: string | null; sub_category?: string | null }>,
): {
  uniform: boolean;
  variants: Array<{ size: string; guideline: ItemGuideline | null }>;
} {
  const variants = items.map((it) => ({
    size: String(it.sub_category ?? '').trim(),
    guideline: getItemGuideline(it),
  }));
  if (variants.length === 0) return { uniform: true, variants: [] };
  const first = variants[0].guideline;
  const uniform = variants.every((v) => v.guideline === first);
  return { uniform, variants };
}

// B4 — 병원·부서별 가이드라인 override.
// 정적 상수가 모든 병원의 관행을 반영할 수 없으므로, 운영 중 일부 값을 덮어쓸 수 있게 한다.
// 데이터 소스: AppSetting('guideline_overrides') JSON. 운영 시 나중에 endpoint 추가.
//
// 형식:
//   { [item_id]: Partial<ItemGuideline> }
//
// 적용 시점: inferDemand 호출 시 1회 로드 → 가이드라인과 병합.
// 캐싱은 호출자 책임 (현재는 매 호출마다 재계산).

export type GuidelineOverrideMap = Record<string, Partial<ItemGuideline>>;

export function applyOverride(
  base: ItemGuideline,
  override?: Partial<ItemGuideline>,
): ItemGuideline {
  if (!override) return base;
  return {
    ...base,
    ...override,
    replacement: override.replacement
      ? { ...base.replacement, ...override.replacement }
      : base.replacement,
  };
}
