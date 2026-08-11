import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database (production)...');

  // ──────────────────────────────────────────────
  //  1. 권한(Permission)
  // ──────────────────────────────────────────────
  const permDefs = [
    { key: 'BASIC_MANAGE',     description: '기초등록 (품목·업체·분류·기준량·사용자·감사로그)' },
    { key: 'REQUEST_USE',      description: '신청·사용 (소모품/비품 신청·사용등록·대여·수리·검수)' },
    { key: 'PURCHASE_MANAGE',  description: '구매·입출고 (승인·발주·입출고·재고)' },
    { key: 'STATS_VIEW',       description: '통계 (비용통계·물품분석·수요예측)' },
    { key: 'PATIENT_MANAGE',   description: '환자관리 (환자관리·환자통계)' },
    { key: 'SYSTEM_ADMIN',     description: '시스템 설정/백업' },
  ];

  const permIds: Record<string, string> = {};
  for (const p of permDefs) {
    const perm = await prisma.permission.upsert({
      where: { key: p.key },
      update: { description: p.description },
      create: { id: uuidv4(), key: p.key, description: p.description },
    });
    permIds[p.key] = perm.id;
  }

  // ──────────────────────────────────────────────
  //  2. 역할(Role) + 역할-권한 매핑
  // ──────────────────────────────────────────────
  const allPerms = permDefs.map(p => p.key);
  const roleDefs = [
    { name: '관리자', desc: '관리자 (전체 권한)',           perms: allPerms },
    { name: '사용자', desc: '일반 사용자 (부서 신청)',       perms: ['REQUEST_USE'] },
    { name: '조회자', desc: '조회 전용 (편집 불가)',         perms: ['PURCHASE_MANAGE', 'STATS_VIEW'] },
  ];

  const roleIds: Record<string, string> = {};
  for (const r of roleDefs) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.desc },
      create: { id: uuidv4(), name: r.name, description: r.desc },
    });
    roleIds[r.name] = role.id;

    for (const pk of r.perms) {
      if (!permIds[pk]) continue;
      try {
        await prisma.rolePermission.upsert({
          where: { role_id_permission_id: { role_id: role.id, permission_id: permIds[pk] } },
          update: {},
          create: { role_id: role.id, permission_id: permIds[pk] },
        });
      } catch {}
    }
  }

  // ──────────────────────────────────────────────
  //  3. 부서(Department)
  // ──────────────────────────────────────────────
  const parentDeptDefs = [
    { code: 'NURSING',  name: '간호부',       module_id: 'nursing' },
    { code: 'MEDICAL',  name: '진료부',       module_id: 'medical-dept' },
    { code: 'REHAB',    name: '재활센터',     module_id: 'rehab' },
    { code: 'OPD',      name: '외래',         module_id: null },
    { code: 'ADMIN',    name: '행정',         module_id: null },
    { code: 'CENTRAL',  name: '총무구매 창고', module_id: 'chongmu-module' },
  ];

  const deptIds: Record<string, string> = {};
  for (const d of parentDeptDefs) {
    const dept = await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name, module_id: d.module_id },
      create: { id: uuidv4(), code: d.code, name: d.name, module_id: d.module_id },
    });
    deptIds[d.code] = dept.id;
  }

  const childDeptDefs = [
    { code: 'WARD2',            name: '2병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'WARD3',            name: '3병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'WARD4',            name: '4병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'WARD5',            name: '5병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'WARD6',            name: '6병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'WARD7',            name: '7병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'WARD8',            name: '8병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'WARD9',            name: '9병동',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'DISINFECT',        name: '소독실',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'RENAL',            name: '신장실',               parent: 'NURSING',       module_id: 'nursing' },
    { code: 'PT',               name: '물리치료실',           parent: 'REHAB',         module_id: 'rehab' },
    { code: 'OT',               name: '재활치료실',           parent: 'REHAB',         module_id: 'rehab' },
    { code: 'PHARMACY',         name: '조제실',               parent: 'OPD',           module_id: 'pharmacy' },
    { code: 'LAB',              name: '진단검사의학실',       parent: 'OPD',           module_id: 'lab-medicine' },
    { code: 'RADIOLOGY',        name: '영상검사의학실',       parent: 'OPD',           module_id: 'radiology' },
    { code: 'NURSING_ADMIN',    name: '간호행정',             parent: 'NURSING',       module_id: 'nursing-admin' },
    { code: 'NURSING_DIRECTOR', name: '간호부장(보건관리자)', parent: 'NURSING_ADMIN', module_id: 'nursing-admin' },
    { code: 'QPS',              name: 'QPS',                  parent: 'NURSING_ADMIN', module_id: 'nursing-admin' },
    { code: 'INFECTION_CTRL',   name: '감염관리실',           parent: 'NURSING_ADMIN', module_id: 'nursing-admin' },
    { code: 'MEDICAL_AFFAIRS',    name: '원무부',     parent: 'ADMIN', module_id: 'medical-affairs' },
    { code: 'EXTERNAL_RELATIONS', name: '대외협력실', parent: 'ADMIN', module_id: 'external-relations' },
    { code: 'ACCOUNTING_DEPT',    name: '경리부',     parent: 'ADMIN', module_id: 'erp-accounting' },
    { code: 'REVIEW',             name: '심사부',     parent: 'ADMIN', module_id: 'insurance-review' },
    { code: 'GENERAL_AFFAIRS',    name: '총무부',     parent: 'ADMIN', module_id: null },
    { code: 'MANAGEMENT',         name: '관리과',     parent: 'ADMIN', module_id: 'management' },
    { code: 'SOCIAL_WELFARE',     name: '사회복지실', parent: 'ADMIN', module_id: 'social-welfare' },
    { code: 'NUTRITION',          name: '영양실',     parent: 'ADMIN', module_id: 'nutrition' },
  ];

  for (const d of childDeptDefs) {
    const dept = await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name, parent_id: deptIds[d.parent], module_id: d.module_id },
      create: { id: uuidv4(), code: d.code, name: d.name, parent_id: deptIds[d.parent], module_id: d.module_id },
    });
    deptIds[d.code] = dept.id;
  }

  // ──────────────────────────────────────────────
  //  4. 재고 위치(InventoryLocation)
  // ──────────────────────────────────────────────
  // 창고(총무구매)만 기본 생성 — 부서 보관함은 사용자 등록 시 자동 생성
  await prisma.inventoryLocation.upsert({
    where: { code: 'CENTRAL' },
    update: {},
    create: { id: uuidv4(), code: 'CENTRAL', name: '총무구매 창고', department_id: deptIds['CENTRAL'] },
  });

  // ──────────────────────────────────────────────
  //  5. 관리자 계정
  // ──────────────────────────────────────────────
  const adminHash = await bcrypt.hash('honam@8275', 10);
  const adminUser = await prisma.user.upsert({
    where: { username: 'honam206' },
    update: { display_name: '시스템관리자', password_hash: adminHash },
    create: {
      id: uuidv4(),
      username: 'honam206',
      password_hash: adminHash,
      display_name: '시스템관리자',
      department_id: deptIds['ADMIN'],
    },
  });

  try {
    await prisma.userRole.upsert({
      where: { user_id_role_id: { user_id: adminUser.id, role_id: roleIds['관리자'] } },
      update: {},
      create: { user_id: adminUser.id, role_id: roleIds['관리자'] },
    });
  } catch {}

  // ──────────────────────────────────────────────
  //  6. 앱 설정
  // ──────────────────────────────────────────────
  const appSettings = [
    { key: 'HOSPITAL_NAME',           value: '호남THE선요양병원',  description: '병원 이름 (로그인 화면 및 각 페이지 표시)' },
    { key: 'APP_NAME',                value: '물품 관리 시스템',    description: '앱 이름 (로그인 화면 서브타이틀)' },
    { key: 'INCINERATION_UNIT_PRICE', value: '550',                description: '소각 단가 (원/kg)' },
    { key: 'DEFAULT_ROOM_CAPACITY',   value: '6',                  description: '병실 기본 정원 (병상 수)' },
    { key: 'OVER_PCT_THRESHOLD',      value: '15',                 description: '초과 발주 경고 기준 (%)' },
    { key: 'PRICE_UP_THRESHOLD',      value: '10',                 description: '단가 인상 경고 기준 (%)' },
    { key: 'REORDER_DAYS',            value: '7',                  description: '재주문 필요 기준 (일)' },
    { key: 'AUTO_BACKUP',             value: 'true',               description: '자동 백업 활성화 (true/false)' },
    { key: 'BACKUP_TIME',             value: '02:00',              description: '자동 백업 시간 (HH:MM)' },
    { key: 'FISCAL_YEAR_START',       value: '01',                 description: '회계연도 시작월 (01/04/07/10)' },
    { key: 'SESSION_TIMEOUT_MIN',     value: '30',                 description: '자동 로그아웃 시간 (분)' },
    { key: 'SESSION_WARN_BEFORE_MIN', value: '5',                  description: '세션 만료 경고 표시 (분, 만료 전)' },
    { key: 'PASSWORD_MIN_LENGTH',     value: '8',                  description: '비밀번호 최소 길이 (자)' },
    { key: 'MAX_LOGIN_ATTEMPTS',      value: '5',                  description: '최대 로그인 시도 횟수 (0=무제한)' },
    { key: 'module:chongmu-module',    value: 'true',  description: '총무 모듈 활성화 (물품관리·발주·재고·승인)' },
    { key: 'HIRA_API_KEY',              value: '404c9832071e01831b2523b19ce63cf7749932d54f0b3c45998a6331d4dc2dd0', description: '건강보험심사평가원 치료재료 급여·비급여 목록 API 서비스키' },
  ];

  for (const s of appSettings) {
    await prisma.appSetting.upsert({
      where: { key: s.key },
      update: { value: s.value, description: s.description ?? '' },
      create: { id: uuidv4(), key: s.key, value: s.value, description: s.description ?? '' },
    });
  }

  // (통계용 샘플 데이터 섹션 제거됨 — 실 운영 데이터만 사용)

  console.log('✅ Seed 완료!');
  console.log('─────────────────────────────────────────');
  console.log('관리자 계정: honam206 / honam@8275');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
