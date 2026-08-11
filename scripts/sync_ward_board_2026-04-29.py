"""
patients 테이블의 patient_group / period_type / infection_strain 변경분을
2026-04-29 wardRoomBoard에 동기화.
"""
import sqlite3, sys, io
from datetime import datetime, timezone

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DB_PATH = r'd:/hospital-supply-app/prisma/hospital-supply.db'
BOARD_DATE_MS = 1777420800000  # 2026-04-29 00:00:00 UTC

def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 4/29 보드 중 patient_id가 있는 행 + 환자 정보 join
    cur.execute("""
        SELECT b.id AS board_id, b.patient_id,
               b.patient_name, b.room_no, b.bed_no,
               b.patient_group AS b_group, b.period_type AS b_period, b.infection_strain AS b_strain,
               p.patient_group AS p_group, p.period_type AS p_period, p.infection_strain AS p_strain
        FROM ward_room_boards b
        JOIN patients p ON b.patient_id = p.id
        WHERE b.board_date = ? AND b.deleted_at IS NULL
          AND p.status = 'ADMITTED' AND p.deleted_at IS NULL
    """, (BOARD_DATE_MS,))
    rows = cur.fetchall()
    print(f"4/29 보드 + 입원중 환자 매칭: {len(rows)}건")

    diffs = []
    for r in rows:
        if (r['b_group'] != r['p_group']
            or (r['b_period'] or '') != (r['p_period'] or '')
            or (r['b_strain'] or '') != (r['p_strain'] or '')):
            diffs.append(r)

    print(f"동기화 필요: {len(diffs)}건")
    if not diffs:
        print("이미 동기화 상태 — 변경 없음")
        return

    # 미리보기
    print("\n[변경 미리보기 - 처음 10건]")
    for d in diffs[:10]:
        parts = []
        if d['b_group'] != d['p_group']:
            parts.append(f"group:{d['b_group']}→{d['p_group']}")
        if (d['b_period'] or '') != (d['p_period'] or ''):
            parts.append(f"period:'{d['b_period'] or ''}'→'{d['p_period'] or ''}'")
        if (d['b_strain'] or '') != (d['p_strain'] or ''):
            parts.append(f"strain:'{d['b_strain'] or ''}'→'{d['p_strain'] or ''}'")
        print(f"  {d['room_no']} {d['patient_name']}: {', '.join(parts)}")

    # 적용
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    cur.execute("BEGIN")
    try:
        for d in diffs:
            cur.execute("""
                UPDATE ward_room_boards
                SET patient_group=?, period_type=?, infection_strain=?, updated_at=?
                WHERE id=?
            """, (d['p_group'], d['p_period'] or '', d['p_strain'] or '', now_ms, d['board_id']))
        conn.commit()
        print(f"\n✓ 보드 {len(diffs)}건 동기화 완료")
    except Exception as e:
        conn.rollback()
        print(f"✗ 롤백: {e}")
        raise

    # 검증
    cur.execute("""
        SELECT b.room_no, b.patient_name, b.patient_group, b.period_type, b.infection_strain
        FROM ward_room_boards b
        WHERE b.board_date = ? AND b.id IN ({})
    """.format(','.join('?' * min(5, len(diffs)))),
    (BOARD_DATE_MS, *(d['board_id'] for d in diffs[:5])))
    print("\n[검증 (보드)]")
    for r in cur.fetchall():
        print(f"  {r['room_no']} {r['patient_name']}: group={r['patient_group']} period={r['period_type']} strain={r['infection_strain']}")

    conn.close()

if __name__ == '__main__':
    main()
