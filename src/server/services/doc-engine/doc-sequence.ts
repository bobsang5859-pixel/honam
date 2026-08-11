// 문서번호 자동 채번 — 기안서(연간 누적철)처럼 "직전 번호 다음 것"을 자동으로 붙여야 하는
// 양식용. 물리적으로 파일을 계속 이어붙이지 않고, DB 시퀀스 카운터 + 개별 생성으로 처리
// (매 생성이 독립 파일이라 실패해도 그 해 전체가 깨지지 않음).
import { prisma } from '../../index';
import type { AutoSeqConfig } from './types';

function applyDateTokens(template: string, now: Date): string {
  const yyyy = String(now.getFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return template.replace('{yyyy}', yyyy).replace('{yy}', yy).replace('{mm}', mm);
}

async function nextSeqValue(scopeKey: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const existing = await (tx as any).docSequenceCounter.findUnique({ where: { scope_key: scopeKey } });
    if (!existing) {
      await (tx as any).docSequenceCounter.create({ data: { scope_key: scopeKey, next_value: 2 } });
      return 1;
    }
    await (tx as any).docSequenceCounter.update({
      where: { scope_key: scopeKey },
      data: { next_value: { increment: 1 } },
    });
    return existing.next_value as number;
  });
}

export async function generateAutoSeqValue(config: AutoSeqConfig, now: Date = new Date()): Promise<string> {
  const scopeKey = applyDateTokens(config.scope_key_template, now);
  const seq = await nextSeqValue(scopeKey);
  const seqStr = String(seq).padStart(config.pad, '0');
  return applyDateTokens(config.number_template, now).replace('{seq}', seqStr);
}
