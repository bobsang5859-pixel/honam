import { describe, expect, it, vi } from 'vitest';

// prisma 의존을 피하기 위해 $transaction 을 in-memory 카운터로 모킹
const counters = new Map<string, number>();
vi.mock('../../index', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        docSequenceCounter: {
          findUnique: async ({ where }: { where: { scope_key: string } }) => {
            const v = counters.get(where.scope_key);
            return v === undefined ? null : { scope_key: where.scope_key, next_value: v };
          },
          create: async ({ data }: { data: { scope_key: string; next_value: number } }) => {
            counters.set(data.scope_key, data.next_value);
          },
          update: async ({ where, data }: { where: { scope_key: string }; data: { next_value: { increment: number } } }) => {
            counters.set(where.scope_key, (counters.get(where.scope_key) ?? 0) + data.next_value.increment);
          },
        },
      };
      return fn(tx);
    },
  },
}));

const { generateAutoSeqValue } = await import('./doc-sequence');

describe('generateAutoSeqValue — 기안서 문서번호 자동 채번', () => {
  it('같은 scope 안에서 순차 증가한다', async () => {
    const config = { scope_key_template: 'GIAN-TEST-{yyyy}', number_template: '호남-{yy}-{seq}', pad: 3 };
    const now = new Date('2026-01-06');
    const v1 = await generateAutoSeqValue(config, now);
    const v2 = await generateAutoSeqValue(config, now);
    const v3 = await generateAutoSeqValue(config, now);
    expect(v1).toBe('호남-26-001');
    expect(v2).toBe('호남-26-002');
    expect(v3).toBe('호남-26-003');
  });

  it('scope 가 다르면(연도 등) 별도로 채번된다', async () => {
    const config = { scope_key_template: 'GIAN-TEST2-{yyyy}', number_template: '호남-{yy}-{seq}', pad: 3 };
    const v2026 = await generateAutoSeqValue(config, new Date('2026-01-06'));
    const v2027 = await generateAutoSeqValue(config, new Date('2027-01-06'));
    expect(v2026).toBe('호남-26-001');
    expect(v2027).toBe('호남-27-001');
  });
});
