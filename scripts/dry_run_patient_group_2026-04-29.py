"""
4.29 시트 환자군 dry-run
- 이름 + 병실 매칭으로 DB 입원중 환자 찾아 patient_group/period_type 변경 시뮬레이션
- DB 변경 없음. 리포트만 출력.
"""
import openpyxl
import sqlite3
import sys, io, re, json
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

EXCEL_PATH = r'C:/Users/총무구매/Desktop/2026년 호남더선요양병원 일일병실현황(자동 복구됨) (1).xlsx'
SHEET_NAME = '4.29'
DB_PATH = r'd:/hospital-supply-app/prisma/hospital-supply.db'

# 환자군 매핑 (오타 포함)
GROUP_MAP = {
    '최고도': 'HIGHEST',
    '고도': 'HIGH',
    '중도': 'MEDIUM',
    '증도': 'MEDIUM',  # 오타 케이스
    '경도': 'LOW',
    '선택': 'SELECT',
    '미평가': 'UNRATED',
    '폐렴': 'PNEUMONIA',
    '패혈증': 'SEPSIS',
}
PERIOD_GROUPS = {'PNEUMONIA', 'SEPSIS'}

# 7개 병동 블록 시작 컬럼 (0-indexed): A, G, M, S, Y, AE, AK
BLOCK_STARTS = [0, 6, 12, 18, 24, 30, 36]
# 각 블록 내 컬럼 오프셋: 병실=0, No=1, 성명=2, 비고=3, 환자군=5

def normalize_room(raw):
    """엑셀 '201\\nF', '301\\nF/와상', '311\\nM\\n밀착' → '201호'"""
    if raw is None:
        return ''
    s = str(raw).strip()
    m = re.search(r'\d+', s)
    if not m:
        return ''
    return f"{m.group()}호"

def main():
    # 1. Excel 읽기
    wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)
    ws = wb[SHEET_NAME]

    excel_rows = []  # (name, room_no, group_kor, group_enum, source_row, block_idx)
    current_room_per_block = [''] * 7

    for row_idx, row in enumerate(ws.iter_rows(min_row=4, values_only=True), start=4):
        for block_idx, start in enumerate(BLOCK_STARTS):
            room_cell = row[start]
            no_cell = row[start + 1]
            name_cell = row[start + 2]
            group_cell = row[start + 5] if (start + 5) < len(row) else None

            # 새 병실 시작이면 current_room 갱신
            if room_cell:
                normalized = normalize_room(room_cell)
                if normalized:
                    current_room_per_block[block_idx] = normalized

            # 이름이 있고 No가 숫자(실제 환자 행)일 때만 수집
            if not name_cell:
                continue
            if not isinstance(no_cell, (int, float)):
                continue

            name = str(name_cell).strip()
            if not name:
                continue

            room = current_room_per_block[block_idx]
            group_kor = str(group_cell).strip() if group_cell else ''
            group_enum = GROUP_MAP.get(group_kor, None) if group_kor else None

            excel_rows.append({
                'name': name,
                'room': room,
                'group_kor': group_kor,
                'group_enum': group_enum,
                'excel_row': row_idx,
                'block_idx': block_idx,
            })

    print(f"[엑셀] 추출된 환자 행: {len(excel_rows)}건")

    # 2. DB에서 입원중 환자 모두 로드
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""
        SELECT id, name, room_no, bed_no, patient_group, period_type, department_id
        FROM patients
        WHERE status = 'ADMITTED' AND deleted_at IS NULL
    """)
    db_patients = [dict(r) for r in cur.fetchall()]
    print(f"[DB] 입원중 환자: {len(db_patients)}명")

    # name+room_no → list of patients
    db_index = {}
    for p in db_patients:
        key = (p['name'], p['room_no'])
        db_index.setdefault(key, []).append(p)

    # 3. 각 엑셀 행 매칭
    matched_changes = []         # 업데이트 대상 (이름+병실 1:1)
    matched_no_change = []       # 매칭됐지만 환자군 동일
    not_found = []               # DB에 (이름,병실) 매칭 0건
    duplicates = []              # 1:N (동명이인)
    empty_group = []             # 엑셀 환자군 비어있음
    unknown_group = []           # 환자군 값이 매핑 안 됨
    empty_room = []              # 엑셀 병실 정보 누락

    for er in excel_rows:
        if not er['room']:
            empty_room.append(er)
            continue
        if not er['group_kor']:
            empty_group.append(er)
            continue
        if er['group_enum'] is None:
            unknown_group.append(er)
            continue

        candidates = db_index.get((er['name'], er['room']), [])
        if len(candidates) == 0:
            not_found.append(er)
        elif len(candidates) > 1:
            duplicates.append({**er, 'candidates': candidates})
        else:
            p = candidates[0]
            new_group = er['group_enum']
            new_period = ''
            if new_group in PERIOD_GROUPS:
                new_period = new_group  # PNEUMONIA or SEPSIS
            # 변경 여부
            if p['patient_group'] == new_group and (p['period_type'] or '') == new_period:
                matched_no_change.append({**er, 'patient': p})
            else:
                matched_changes.append({
                    **er,
                    'patient_id': p['id'],
                    'old_group': p['patient_group'],
                    'old_period': p['period_type'] or '',
                    'new_group': new_group,
                    'new_period': new_period,
                })

    # 4. 리포트 출력
    print("\n" + "=" * 70)
    print("DRY-RUN 결과 (DB 변경 없음)")
    print("=" * 70)
    print(f"  업데이트 대상: {len(matched_changes)}건")
    print(f"  매칭됐지만 변경 없음: {len(matched_no_change)}건")
    print(f"  DB에 매칭 안 됨: {len(not_found)}건")
    print(f"  동명이인 충돌(같은 이름+병실 2명 이상): {len(duplicates)}건")
    print(f"  엑셀 환자군 빈칸: {len(empty_group)}건")
    print(f"  환자군 값 인식 불가: {len(unknown_group)}건")
    print(f"  엑셀 병실 누락: {len(empty_room)}건")

    if duplicates:
        print("\n[동명이인 충돌] —————————————————————————————————")
        for d in duplicates:
            print(f"  엑셀행 {d['excel_row']}  {d['room']} {d['name']} ({d['group_kor']})")
            for c in d['candidates']:
                print(f"      → DB id={c['id'][:8]} bed={c['bed_no']} 현재={c['patient_group']}")

    if not_found:
        print(f"\n[DB 매칭 실패] ({len(not_found)}건) —————————————")
        # 엑셀 이름은 있지만 DB에 그 이름이 다른 병실에 있는 경우 힌트 제공
        db_by_name = {}
        for p in db_patients:
            db_by_name.setdefault(p['name'], []).append(p)
        for er in not_found:
            hint_list = db_by_name.get(er['name'], [])
            hint = ''
            if hint_list:
                hint = ' / DB동일이름: ' + ', '.join(f"{p['room_no']}" for p in hint_list)
            print(f"  엑셀 {er['room']} {er['name']} ({er['group_kor']}){hint}")

    if unknown_group:
        print(f"\n[환자군 값 인식 불가] ({len(unknown_group)}건) —")
        for er in unknown_group:
            print(f"  엑셀행 {er['excel_row']} {er['room']} {er['name']} → '{er['group_kor']}'")

    if empty_group:
        print(f"\n[환자군 빈칸 - 스킵] ({len(empty_group)}건)")

    if empty_room:
        print(f"\n[병실 정보 누락 - 스킵] ({len(empty_room)}건)")
        for er in empty_room[:20]:
            print(f"  블록{er['block_idx']} 엑셀행{er['excel_row']} {er['name']} ({er['group_kor']})")

    # 변경 미리보기 (요약)
    print(f"\n[업데이트 미리보기 - 처음 15건]")
    for ch in matched_changes[:15]:
        period_part = ''
        if ch['old_period'] != ch['new_period']:
            period_part = f", period: '{ch['old_period']}'→'{ch['new_period']}'"
        print(f"  {ch['room']} {ch['name']}: {ch['old_group']}→{ch['new_group']}{period_part}")

    # 변경 요약: 환자군 분포
    print(f"\n[변경 후 환자군 분포 (업데이트 대상만)]")
    dist = {}
    for ch in matched_changes:
        dist[ch['new_group']] = dist.get(ch['new_group'], 0) + 1
    for k in sorted(dist.keys()):
        print(f"  {k}: {dist[k]}")

    # 결과 저장
    out = {
        'summary': {
            'matched_changes': len(matched_changes),
            'matched_no_change': len(matched_no_change),
            'not_found': len(not_found),
            'duplicates': len(duplicates),
            'empty_group': len(empty_group),
            'unknown_group': len(unknown_group),
            'empty_room': len(empty_room),
        },
        'matched_changes': matched_changes,
        'duplicates': duplicates,
        'not_found': not_found,
        'unknown_group': unknown_group,
    }
    out_path = Path(r'd:/hospital-supply-app/scripts/dry_run_2026-04-29_result.json')
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
    print(f"\n결과 JSON: {out_path}")

if __name__ == '__main__':
    main()
