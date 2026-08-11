import { describe, expect, it } from 'vitest';
import { resolveRenderPlan } from './rule-engine';
import type { FieldDef, RuleDef } from './types';

const fields: FieldDef[] = [
  { key: '이름', label: '이름', type: 'text', source: 'MANUAL' },
  { key: '회사명', label: '회사명', type: 'text', source: 'MANUAL' },
  { key: '주민등록번호', label: '주민등록번호', type: 'text', source: 'MANUAL' },
  { key: '사업자등록번호', label: '사업자등록번호', type: 'text', source: 'MANUAL' },
];

const allSectionKeys = ['계약조항', '견적조항', '승인란', '특약사항'];

describe('resolveRenderPlan — 요구사항 문서 예시', () => {
  it('문서종류=계약서 → 계약조항 표시, 견적조항 숨김', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: '문서종류', op: 'eq', value: '계약서' }, action_type: 'SHOW_SECTION', action_payload: { section_key: '계약조항' } },
      { id: 'r2', priority: 0, condition: { field: '문서종류', op: 'eq', value: '견적서' }, action_type: 'SHOW_SECTION', action_payload: { section_key: '견적조항' } },
    ];
    const plan = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 문서종류: '계약서' } });
    expect(plan.visible_sections).toContain('계약조항');
    expect(plan.hidden_sections).toContain('견적조항');
  });

  it('문서종류=견적서 → 견적조항 표시, 계약조항 숨김', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: '문서종류', op: 'eq', value: '계약서' }, action_type: 'SHOW_SECTION', action_payload: { section_key: '계약조항' } },
      { id: 'r2', priority: 0, condition: { field: '문서종류', op: 'eq', value: '견적서' }, action_type: 'SHOW_SECTION', action_payload: { section_key: '견적조항' } },
    ];
    const plan = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 문서종류: '견적서' } });
    expect(plan.visible_sections).toContain('견적조항');
    expect(plan.hidden_sections).toContain('계약조항');
  });

  it('고객유형=개인 → 주민등록번호 표시, 사업자등록번호 숨김', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: '고객유형', op: 'eq', value: '개인' }, action_type: 'SHOW_FIELD', action_payload: { field_key: '주민등록번호' } },
      { id: 'r2', priority: 0, condition: { field: '고객유형', op: 'eq', value: '개인' }, action_type: 'HIDE_FIELD', action_payload: { field_key: '사업자등록번호' } },
      { id: 'r3', priority: 0, condition: { field: '고객유형', op: 'eq', value: '법인' }, action_type: 'SHOW_FIELD', action_payload: { field_key: '사업자등록번호' } },
      { id: 'r4', priority: 0, condition: { field: '고객유형', op: 'eq', value: '법인' }, action_type: 'HIDE_FIELD', action_payload: { field_key: '주민등록번호' } },
    ];
    const plan = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 고객유형: '개인' } });
    expect(plan.visible_fields).toContain('주민등록번호');
    expect(plan.hidden_fields).toContain('사업자등록번호');
  });

  it('고객유형=법인 → 사업자등록번호 표시, 주민등록번호 숨김', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: '고객유형', op: 'eq', value: '개인' }, action_type: 'SHOW_FIELD', action_payload: { field_key: '주민등록번호' } },
      { id: 'r2', priority: 0, condition: { field: '고객유형', op: 'eq', value: '개인' }, action_type: 'HIDE_FIELD', action_payload: { field_key: '사업자등록번호' } },
      { id: 'r3', priority: 0, condition: { field: '고객유형', op: 'eq', value: '법인' }, action_type: 'SHOW_FIELD', action_payload: { field_key: '사업자등록번호' } },
      { id: 'r4', priority: 0, condition: { field: '고객유형', op: 'eq', value: '법인' }, action_type: 'HIDE_FIELD', action_payload: { field_key: '주민등록번호' } },
    ];
    const plan = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 고객유형: '법인' } });
    expect(plan.visible_fields).toContain('사업자등록번호');
    expect(plan.hidden_fields).toContain('주민등록번호');
  });

  it('금액이 1,000만원 이상이면 승인란 추가(표시)', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: '금액', op: 'gte', value: 10000000 }, action_type: 'SHOW_SECTION', action_payload: { section_key: '승인란' } },
    ];
    const under = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 금액: 9999999 } });
    expect(under.hidden_sections).toContain('승인란');

    const over = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 금액: 10000000 } });
    expect(over.visible_sections).toContain('승인란');
  });

  it('체크박스 선택 여부에 따라 특정 문단을 추가/삭제', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: '특약동의', op: 'isTrue' }, action_type: 'SHOW_SECTION', action_payload: { section_key: '특약사항' } },
    ];
    const checked = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 특약동의: true } });
    expect(checked.visible_sections).toContain('특약사항');

    const unchecked = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { 특약동의: false } });
    expect(unchecked.hidden_sections).toContain('특약사항');
  });

  it('규칙이 없으면 필드는 기본 표시, 섹션은 default_visible_sections 에 없으면 기본 숨김', () => {
    const plan = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: ['계약조항'], rules: [], input: {} });
    expect(plan.visible_fields.sort()).toEqual(fields.map((f) => f.key).sort());
    expect(plan.visible_sections).toEqual(['계약조항']);
    expect(plan.hidden_sections.sort()).toEqual(['견적조항', '승인란', '특약사항'].sort());
  });

  it('우선순위가 높은(숫자가 큰) 규칙이 나중에 적용되어 앞 규칙을 덮어씀', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: 'x', op: 'eq', value: 1 }, action_type: 'SHOW_SECTION', action_payload: { section_key: '계약조항' } },
      { id: 'r2', priority: 1, condition: { field: 'x', op: 'eq', value: 1 }, action_type: 'HIDE_SECTION', action_payload: { section_key: '계약조항' } },
    ];
    const plan = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { x: 1 } });
    expect(plan.hidden_sections).toContain('계약조항');
  });

  it('알 수 없는 필드/섹션을 참조하는 규칙은 warnings 에 기록됨', () => {
    const rules: RuleDef[] = [
      { id: 'r1', priority: 0, condition: { field: 'x', op: 'eq', value: 1 }, action_type: 'SHOW_SECTION', action_payload: { section_key: '존재하지않는섹션' } },
    ];
    const plan = resolveRenderPlan({ fields, allSectionKeys, defaultVisibleSections: [], rules, input: { x: 1 } });
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});
