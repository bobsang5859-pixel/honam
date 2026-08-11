// 순수 규칙엔진 — 파일 I/O·COM·DB 접근 없음. 입력 데이터 + 규칙 목록만으로 RenderPlan을 계산한다.
// 기본값: 필드는 규칙으로 숨기지 않는 한 기본 노출, 섹션은 default_visible_sections 에 있거나
// 규칙으로 켜지 않는 한 기본 숨김 ("필요한 항목만 표시").

import type { Condition, ConditionOp, FieldDef, RenderPlan, RuleDef } from './types';

function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function compare(op: ConditionOp, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'isTrue':
      return Boolean(actual) === true;
    case 'isFalse':
      return Boolean(actual) === false;
    default:
      return false;
  }
}

export function evaluateCondition(condition: Condition, input: Record<string, unknown>): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, input));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, input));
  if ('not' in condition) return !evaluateCondition(condition.not, input);
  return compare(condition.op, getPath(input, condition.field), condition.value);
}

export interface ResolveRenderPlanParams {
  fields: FieldDef[];
  allSectionKeys: string[];
  defaultVisibleSections: string[];
  rules: RuleDef[];              // 호출측에서 is_active=true 인 규칙만 넘겨야 함
  input: Record<string, unknown>;
}

export function resolveRenderPlan(params: ResolveRenderPlanParams): RenderPlan {
  const { fields, allSectionKeys, defaultVisibleSections, rules, input } = params;
  const warnings: string[] = [];

  const fieldKeys = new Set(fields.map((f) => f.key));
  const fieldVisible = new Map<string, boolean>(fields.map((f) => [f.key, true]));

  const sectionKeys = new Set(allSectionKeys);
  const defaultVisibleSet = new Set(defaultVisibleSections);
  const sectionVisible = new Map<string, boolean>(
    allSectionKeys.map((key) => [key, defaultVisibleSet.has(key)]),
  );

  const tableRowsMap = new Map<string, Record<string, string>[]>();

  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    if (!evaluateCondition(rule.condition, input)) continue;
    const payload = rule.action_payload;

    switch (rule.action_type) {
      case 'SHOW_FIELD':
      case 'HIDE_FIELD': {
        const key = payload.field_key;
        if (!key) { warnings.push(`규칙 ${rule.id}: field_key 누락`); break; }
        if (!fieldKeys.has(key)) { warnings.push(`규칙 ${rule.id}: 알 수 없는 필드 "${key}"`); }
        fieldVisible.set(key, rule.action_type === 'SHOW_FIELD');
        break;
      }
      case 'SHOW_SECTION':
      case 'HIDE_SECTION': {
        const key = payload.section_key;
        if (!key) { warnings.push(`규칙 ${rule.id}: section_key 누락`); break; }
        if (!sectionKeys.has(key)) { warnings.push(`규칙 ${rule.id}: 알 수 없는 섹션 "${key}"`); }
        sectionVisible.set(key, rule.action_type === 'SHOW_SECTION');
        break;
      }
      case 'ADD_TABLE_ROWS': {
        const key = payload.table_key;
        if (!key || !payload.rows) { warnings.push(`규칙 ${rule.id}: table_key/rows 누락`); break; }
        const existing = tableRowsMap.get(key) ?? [];
        tableRowsMap.set(key, [...existing, ...payload.rows]);
        break;
      }
      default:
        warnings.push(`규칙 ${rule.id}: 알 수 없는 action_type`);
    }
  }

  const visible_fields: string[] = [];
  const hidden_fields: string[] = [];
  for (const [key, visible] of fieldVisible) (visible ? visible_fields : hidden_fields).push(key);

  const visible_sections: string[] = [];
  const hidden_sections: string[] = [];
  for (const [key, visible] of sectionVisible) (visible ? visible_sections : hidden_sections).push(key);

  return {
    visible_fields,
    hidden_fields,
    visible_sections,
    hidden_sections,
    extra_table_rows: [...tableRowsMap.entries()].map(([table_key, rows]) => ({ table_key, rows })),
    warnings,
  };
}
