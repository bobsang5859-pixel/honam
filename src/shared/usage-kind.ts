// 환자×품목 매핑(usage_kind) 자동 분류 — 서버·클라이언트 공유.
//
// 호흡·삽관(MED_AIRWAY) 과 카테터·튜브(MED_CATHETER) 카테고리의 품목을 이름 패턴으로 분류.
// Item.sub_category 가 사이즈/규격(예: '14Fr', 'Y-Type') 으로 사용되므로 그대로 size 로 활용.
//
// 그룹(group_key): 같은 환자 매핑을 자동 공유하는 묶음.
//   - FOLEY_GROUP   = 폴리 + 유린백 (도뇨 세트)
//   - SUCTION_GROUP = 석션 + 커넥터 (흡인 세트)
//   - 그 외는 usage_kind 자체를 group_key 로 사용

export type UsageKind =
  // 호흡·삽관 (MED_AIRWAY)
  | 'AIRWAY_INTUBATION'      // ENDO TUBE
  | 'AIRWAY_CANNULA'         // Nasal Cannular
  | 'AIRWAY_AIRWAY'          // Air Way (구강 기도유지기)
  | 'AIRWAY_BREATHING_SET'   // BReaTHING SET
  | 'AIRWAY_NEBULIZER_KIT'   // Nebulizer Kit
  | 'AIRWAY_NEBULIZER_MASK'  // Nebulizer Mask
  | 'AIRWAY_O2_MASK'         // O2 Mask
  | 'AIRWAY_O2_LINE'         // O2 LINE (산소 라인)
  | 'AIRWAY_TTUBE'           // T-Tube
  | 'CATH_TPIECE'            // T-piece (T-Tube 와 같은 그룹)
  | 'AIRWAY_SPEECH_CANNULA'  // Speechcannuia (발성캐뉼라)
  | 'AIRWAY_TRACHEOSTOMY'    // TRACOE (기관절개관)
  // 카테터·튜브 (MED_CATHETER)
  | 'CATH_FOLEY'
  | 'CATH_URINBAG'
  | 'CATH_SUCTION'
  | 'CATH_SUCTION_LINE'       // 석션라인 (석션팁과 다른 사이즈지만 같은 환자 매핑)
  | 'CATH_CONNECTOR'
  | 'CATH_LEVIN'
  // 드레싱·고정 (MED_DRESSING)
  | 'OSTOMY_PLATE'           // 장루판
  | 'OSTOMY_POUCH'           // 장루파우치
  | 'DRESSING_ELASTIC'       // 탄력붕대
  | 'DRESSING_COTTON'        // 솜붕대
  | 'DRESSING_SPLINT'        // 스프린트
  // 한방재료 (MED_HANBANG)
  | 'HANBANG_MOXA'           // 뜸
  | 'HANBANG_NEEDLE';        // 침

export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
  AIRWAY_INTUBATION: '기관삽관',
  AIRWAY_CANNULA: '비강캐뉼라',
  AIRWAY_AIRWAY: '에어웨이',
  AIRWAY_BREATHING_SET: '브레딩세트',
  AIRWAY_NEBULIZER_KIT: '네뷸라이저키트',
  AIRWAY_NEBULIZER_MASK: '네뷸라이저마스크',
  AIRWAY_O2_MASK: 'O2 마스크',
  AIRWAY_O2_LINE: 'O2 라인',
  AIRWAY_TTUBE: 'T-Tube',
  CATH_TPIECE: 'T-piece',
  AIRWAY_SPEECH_CANNULA: '발성캐뉼라',
  AIRWAY_TRACHEOSTOMY: '기관절개관(TRACOE)',
  CATH_FOLEY: '폴리',
  CATH_URINBAG: '유린백',
  CATH_SUCTION: '석션',
  CATH_SUCTION_LINE: '석션라인',
  CATH_CONNECTOR: '커넥터',
  CATH_LEVIN: '레빈튜브',
  OSTOMY_PLATE: '장루판',
  OSTOMY_POUCH: '장루파우치',
  DRESSING_ELASTIC: '탄력붕대',
  DRESSING_COTTON: '솜붕대',
  DRESSING_SPLINT: '스프린트',
  HANBANG_MOXA: '뜸',
  HANBANG_NEEDLE: '침',
};

export const USAGE_KIND_GROUP: Record<UsageKind, string> = {
  // 호흡·삽관 — 모두 단독 (각자 독립). 단 T-Tube + T-piece 는 한 그룹.
  AIRWAY_INTUBATION: 'AIRWAY_INTUBATION',
  AIRWAY_AIRWAY: 'AIRWAY_AIRWAY',
  AIRWAY_SPEECH_CANNULA: 'AIRWAY_SPEECH_CANNULA',
  AIRWAY_TRACHEOSTOMY: 'AIRWAY_TRACHEOSTOMY',
  AIRWAY_CANNULA: 'AIRWAY_CANNULA',
  AIRWAY_BREATHING_SET: 'AIRWAY_BREATHING_SET',
  AIRWAY_NEBULIZER_KIT: 'AIRWAY_NEBULIZER_KIT',
  AIRWAY_NEBULIZER_MASK: 'AIRWAY_NEBULIZER_MASK',
  AIRWAY_O2_MASK: 'AIRWAY_O2_MASK',
  AIRWAY_O2_LINE: 'AIRWAY_O2_LINE',
  // T-Tube · T-piece 그룹
  AIRWAY_TTUBE: 'TTUBE_GROUP',
  CATH_TPIECE: 'TTUBE_GROUP',
  CATH_FOLEY: 'FOLEY_GROUP',
  CATH_URINBAG: 'FOLEY_GROUP',
  CATH_SUCTION: 'SUCTION_GROUP',
  CATH_SUCTION_LINE: 'SUCTION_GROUP',
  CATH_CONNECTOR: 'SUCTION_GROUP',
  CATH_LEVIN: 'CATH_LEVIN',
  OSTOMY_PLATE: 'OSTOMY_GROUP',
  OSTOMY_POUCH: 'OSTOMY_GROUP',
  DRESSING_ELASTIC: 'DRESSING_ELASTIC',
  DRESSING_COTTON: 'DRESSING_COTTON',
  DRESSING_SPLINT: 'DRESSING_SPLINT',
  HANBANG_MOXA: 'HANBANG_GROUP',
  HANBANG_NEEDLE: 'HANBANG_GROUP',
};

// 같은 사용자가 클릭한 품목으로부터 usage_kind 를 추정.
// 매핑 대상 아닌 품목(넬라톤·렉털·드레싱 일반 등)은 null.
//
// 대상 카테고리: MED_AIRWAY / MED_CATHETER / MED_DRESSING(장루만) / MED_HANBANG.
// 시스템 분류상 일부 품목(예: 석션)이 MED_AIRWAY 에 들어있을 수 있어 카테고리·이름 패턴 종합 판단.
export function inferUsageKind(item: { name?: string | null; category?: string | null }): UsageKind | null {
  const cat = String(item.category ?? '');
  if (cat !== 'MED_AIRWAY' && cat !== 'MED_CATHETER' && cat !== 'MED_DRESSING' && cat !== 'MED_HANBANG') return null;

  const name = String(item.name ?? '').toLowerCase();

  // 호흡·삽관 + 카테터·튜브 (이름 패턴 매칭 — 두 카테고리 모두 적용)
  if (cat === 'MED_AIRWAY' || cat === 'MED_CATHETER') {
    if (name.includes('endo') || name.includes('기관삽관')) return 'AIRWAY_INTUBATION';
    if (name.includes('tracoe') || name.includes('tracheostomy') || name.includes('기관절개')) return 'AIRWAY_TRACHEOSTOMY';
    if (name.includes('speechcannuia') || name.includes('speech cannula') || name.includes('speechcannula') || name.includes('발성캐뉼라')) return 'AIRWAY_SPEECH_CANNULA';
    if ((name.includes('nasal') && (name.includes('cannular') || name.includes('cannula') || name.includes('canul')))
        || name.includes('비강캐뉼라') || name.includes('비강 캐뉼라')) return 'AIRWAY_CANNULA';
    if (name.includes('breathing') || name.includes('breath set')) return 'AIRWAY_BREATHING_SET';
    if (name.includes('nebu') && name.includes('mask')) return 'AIRWAY_NEBULIZER_MASK';
    if (name.includes('nebu')) return 'AIRWAY_NEBULIZER_KIT';
    if (name.includes('o2 mask') || name.includes('o2mask') || (name.includes('o2') && name.includes('mask'))) return 'AIRWAY_O2_MASK';
    if (name.includes('o2 line') || name.includes('o2line') || name.includes('o2-line') || (name.includes('o2') && name.includes('line'))) return 'AIRWAY_O2_LINE';
    // T-piece 가 T-Tube 보다 더 구체적이라 먼저 매칭
    if (name.includes('t-piece') || name.includes('t piece') || name.includes('tpiece')) return 'CATH_TPIECE';
    if (name.includes('t-tube') || name.includes('t tube') || name.includes('ttube') || name.includes('t_tube')) return 'AIRWAY_TTUBE';
    if (name.startsWith('air way') || name.includes('airway') || name === '에어웨이' || name.includes('에어웨이')) return 'AIRWAY_AIRWAY';

    if (name.includes('foley') || name.includes('폴리')) return 'CATH_FOLEY';
    if (name.includes('urine') || name.includes('유린') || name.includes('소변')) return 'CATH_URINBAG';
    // 석션라인이 더 구체적이라 먼저 매칭 (suction + line)
    if (name.includes('suction') && (name.includes('line') || name.includes('라인'))) return 'CATH_SUCTION_LINE';
    if (name.includes('suction')) return 'CATH_SUCTION';
    if (name.includes('connector') || name.includes('커넥터')) return 'CATH_CONNECTOR';
    if (name.includes('levin') || name.includes('레빈')) return 'CATH_LEVIN';

    return null; // 마스크·넬라톤·렉털·기타 부속은 매핑 X
  }

  // 드레싱 카테고리 — 장루판/장루파우치 + 탄력붕대 + 솜붕대 + 스프린트
  if (cat === 'MED_DRESSING') {
    if (name.includes('장루파우치') || (name.includes('장루') && (name.includes('pouch') || name.includes('파우치'))) || (name.includes('ostomy') && name.includes('pouch'))) {
      return 'OSTOMY_POUCH';
    }
    if (name.includes('장루판') || (name.includes('장루') && (name.includes('plate') || name.includes('판'))) || (name.includes('ostomy') && name.includes('plate'))) {
      return 'OSTOMY_PLATE';
    }
    if (name.includes('탄력붕대') || name.includes('elastic')) return 'DRESSING_ELASTIC';
    if (name.includes('솜붕대')) return 'DRESSING_COTTON';
    if (name.includes('스프린트') || name.includes('splint')) return 'DRESSING_SPLINT';
    return null; // 그 외 드레싱(거즈/면봉/테가덤 등)은 매핑 X
  }

  // 한방재료 — 뜸/침
  if (cat === 'MED_HANBANG') {
    if (name.includes('moxa') || name.includes('moxibustion') || name.includes('뜸')) return 'HANBANG_MOXA';
    if (name.includes('needle') || name.includes('침') || name.includes('acupunct')) return 'HANBANG_NEEDLE';
    return null;
  }

  return null;
}

export function getGroupKey(kind: UsageKind): string {
  return USAGE_KIND_GROUP[kind];
}

export function isInUsageKindCategory(category?: string | null): boolean {
  return category === 'MED_AIRWAY' || category === 'MED_CATHETER';
}
