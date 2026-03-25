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

  // ──────────────────────────────────────────────
  //  7. 통계용 샘플 데이터
  // ──────────────────────────────────────────────
  console.log('📊 통계 샘플 데이터 생성 중...');

  // 날짜 헬퍼
  const daysAgo = (d: number) => new Date(Date.now() - d * 86400000);
  const monthsAgo = (m: number) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d; };

  // 7A. 업체(Vendor) 3개
  const vendorDefs = [
    { code: 'V-MED', name: '(주)메디서플라이', lead_time_days: 3 },
    { code: 'V-DIA', name: '다이퍼코리아', lead_time_days: 5 },
    { code: 'V-SAN', name: '클린케어', lead_time_days: 2 },
  ];
  const vendorIds: Record<string, string> = {};
  for (const v of vendorDefs) {
    const vendor = await prisma.vendor.upsert({
      where: { code: v.code },
      update: {},
      create: { id: uuidv4(), code: v.code, name: v.name, lead_time_days: v.lead_time_days },
    });
    vendorIds[v.code] = vendor.id;
  }

  // 7B. 품목(Item) 6개
  const itemDefs = [
    { code: 'GAUZE-01',   name: '거즈 (10x10)', vendor: 'V-MED', category: 'MEDICAL_FIXED', uom: 'PK' },
    { code: 'BAND-01',    name: '반창고 대',      vendor: 'V-MED', category: 'MEDICAL_FIXED', uom: 'EA' },
    { code: 'SYRINGE-01', name: '주사기 5ml',     vendor: 'V-MED', category: 'MEDICAL_ACT',   uom: 'EA' },
    { code: 'DIAPER-01',  name: '성인용 기저귀 L', vendor: 'V-DIA', category: 'GENERAL_PATIENT', uom: 'PK', stats_bucket: 'DIAPER_CARE' },
    { code: 'ALCOHOL-01', name: '알콜솜',          vendor: 'V-SAN', category: 'MEDICAL_FIXED', uom: 'BOX' },
    { code: 'GLOVES-01',  name: '니트릴 장갑 M',   vendor: 'V-SAN', category: 'MEDICAL_ACT',   uom: 'BOX' },
  ];
  const itemIds: Record<string, string> = {};
  for (const it of itemDefs) {
    const item = await prisma.item.upsert({
      where: { item_code: it.code },
      update: {},
      create: {
        id: uuidv4(), item_code: it.code, name: it.name,
        category: it.category, uom: it.uom,
        stats_bucket: (it as any).stats_bucket || 'MEDICAL',
        default_vendor_id: vendorIds[it.vendor],
      },
    });
    itemIds[it.code] = item.id;
  }

  // 7C. 가격이력(PriceHistory) — 품목별 3건
  const priceData = [
    { item: 'GAUZE-01',   vendor: 'V-MED', prices: [{ m: 5, p: 2500 }, { m: 3, p: 2600 }, { m: 1, p: 2700 }] },
    { item: 'BAND-01',    vendor: 'V-MED', prices: [{ m: 5, p: 800  }, { m: 3, p: 850  }, { m: 1, p: 900  }] },
    { item: 'SYRINGE-01', vendor: 'V-MED', prices: [{ m: 5, p: 350  }, { m: 3, p: 360  }, { m: 1, p: 370  }] },
    { item: 'DIAPER-01',  vendor: 'V-DIA', prices: [{ m: 5, p: 15000}, { m: 3, p: 15500}, { m: 1, p: 16000}] },
    { item: 'ALCOHOL-01', vendor: 'V-SAN', prices: [{ m: 5, p: 4500 }, { m: 3, p: 4600 }, { m: 1, p: 4700 }] },
    { item: 'GLOVES-01',  vendor: 'V-SAN', prices: [{ m: 5, p: 12000}, { m: 3, p: 11500}, { m: 1, p: 11000}] },
  ];
  for (const pd of priceData) {
    for (const pp of pd.prices) {
      const effDate = monthsAgo(pp.m);
      try {
        await prisma.priceHistory.create({
          data: {
            id: uuidv4(), item_id: itemIds[pd.item], vendor_id: vendorIds[pd.vendor],
            price: pp.p, effective_from: effDate, source: 'SEED',
          },
        });
      } catch {} // ignore duplicate
    }
  }

  // 재고 위치 가져오기
  const centralLoc = await prisma.inventoryLocation.findFirst({ where: { code: 'CENTRAL' } });
  const locId = centralLoc!.id;

  // 7D. 발주(PurchaseOrder) 6건 + 발주품목
  const poDefs = [
    { no: 'PO-SEED-001', vendor: 'V-MED', status: 'CLOSED', orderedAgo: 90, expectedAgo: 85, items: [{ item: 'GAUZE-01', qty: 100, price: 2500 }, { item: 'BAND-01', qty: 200, price: 800 }] },
    { no: 'PO-SEED-002', vendor: 'V-MED', status: 'CLOSED', orderedAgo: 60, expectedAgo: 55, items: [{ item: 'SYRINGE-01', qty: 500, price: 360 }] },
    { no: 'PO-SEED-003', vendor: 'V-DIA', status: 'CLOSED', orderedAgo: 75, expectedAgo: 70, items: [{ item: 'DIAPER-01', qty: 50, price: 15500 }] },
    { no: 'PO-SEED-004', vendor: 'V-DIA', status: 'SENT',   orderedAgo: 30, expectedAgo: 25, items: [{ item: 'DIAPER-01', qty: 30, price: 16000 }] },
    { no: 'PO-SEED-005', vendor: 'V-SAN', status: 'CLOSED', orderedAgo: 45, expectedAgo: 42, items: [{ item: 'ALCOHOL-01', qty: 80, price: 4600 }, { item: 'GLOVES-01', qty: 40, price: 11500 }] },
    { no: 'PO-SEED-006', vendor: 'V-SAN', status: 'SENT',   orderedAgo: 15, expectedAgo: 12, items: [{ item: 'GLOVES-01', qty: 60, price: 11000 }] },
  ];
  const poIds: Record<string, string> = {};
  for (const po of poDefs) {
    const existing = await prisma.purchaseOrder.findUnique({ where: { po_no: po.no } });
    if (existing) { poIds[po.no] = existing.id; continue; }
    const poId = uuidv4();
    const totalAmt = po.items.reduce((s, i) => s + i.qty * i.price, 0);
    await prisma.purchaseOrder.create({
      data: {
        id: poId, po_no: po.no, vendor_id: vendorIds[po.vendor],
        created_by: adminUser.id, status: po.status,
        ordered_at: daysAgo(po.orderedAgo),
        expected_at: daysAgo(po.expectedAgo),
        total_amount: totalAmt,
      },
    });
    for (const it of po.items) {
      await prisma.purchaseOrderItem.create({
        data: {
          id: uuidv4(), purchase_order_id: poId,
          item_id: itemIds[it.item], ordered_qty: it.qty,
          unit_price: it.price, line_amount: it.qty * it.price,
        },
      });
    }
    poIds[po.no] = poId;
  }

  // 7E. 입고(GoodsReceipt) 5건 + 입고품목(StockInItem) + 7F. 재고로트(InventoryLot)
  const grDefs = [
    { no: 'GR-SEED-001', po: 'PO-SEED-001', receivedAgo: 87, diff: 0, items: [{ item: 'GAUZE-01', qty: 100, price: 2500 }, { item: 'BAND-01', qty: 200, price: 800 }] },
    { no: 'GR-SEED-002', po: 'PO-SEED-002', receivedAgo: 56, diff: 1, items: [{ item: 'SYRINGE-01', qty: 480, price: 360 }] },
    { no: 'GR-SEED-003', po: 'PO-SEED-003', receivedAgo: 68, diff: 0, items: [{ item: 'DIAPER-01', qty: 50, price: 15500 }] },
    { no: 'GR-SEED-004', po: 'PO-SEED-005', receivedAgo: 40, diff: 0, items: [{ item: 'ALCOHOL-01', qty: 80, price: 4600 }, { item: 'GLOVES-01', qty: 40, price: 11500 }] },
    { no: 'GR-SEED-005', po: 'PO-SEED-004', receivedAgo: 22, diff: 2, items: [{ item: 'DIAPER-01', qty: 28, price: 16000 }] },
  ];
  const siIds: Record<string, string> = {}; // stockInItem id by "grNo-itemCode"
  for (const gr of grDefs) {
    const existing = await prisma.goodsReceipt.findUnique({ where: { gr_no: gr.no } });
    if (existing) continue;
    const grId = uuidv4();
    await prisma.goodsReceipt.create({
      data: {
        id: grId, gr_no: gr.no,
        purchase_order_id: poIds[gr.po],
        received_by: adminUser.id,
        received_at: daysAgo(gr.receivedAgo),
        status: 'CONFIRMED', diff_count: gr.diff,
        confirmed_at: daysAgo(gr.receivedAgo),
        confirmed_by: adminUser.id,
      },
    });
    for (const it of gr.items) {
      const siId = uuidv4();
      await prisma.stockInItem.create({
        data: {
          id: siId, goods_receipt_id: grId,
          item_id: itemIds[it.item], unit_price: it.price,
          received_qty: it.qty, location_id: locId,
        },
      });
      siIds[`${gr.no}-${it.item}`] = siId;
      // InventoryLot
      await prisma.inventoryLot.create({
        data: {
          id: uuidv4(), stock_in_item_id: siId, goods_receipt_id: grId,
          item_id: itemIds[it.item], location_id: locId,
          vendor_id: vendorIds[grDefs === grDefs ? 'V-MED' : 'V-SAN'], // simplified
          received_at: daysAgo(gr.receivedAgo),
          unit_cost: it.price, received_qty: it.qty,
          remaining_qty: Math.max(0, it.qty - Math.floor(it.qty * 0.3)), // 70% 잔여
        },
      });
    }
  }

  // 7G. 출고(StockOut) + 출고품목(StockOutItem) + 7H. 출고로트배분(StockOutLotAllocation)
  const wards = ['WARD2', 'WARD3', 'WARD4', 'WARD5'];
  const soItemCodes = ['GAUZE-01', 'BAND-01', 'SYRINGE-01', 'DIAPER-01', 'ALCOHOL-01', 'GLOVES-01'];
  let soCounter = 1;
  for (const ward of wards) {
    for (let j = 0; j < 2; j++) {
      const soNo = `SO-SEED-${String(soCounter++).padStart(3, '0')}`;
      const existing = await prisma.stockOut.findUnique({ where: { so_no: soNo } });
      if (existing) continue;
      const soId = uuidv4();
      const issuedAgo = 10 + j * 40 + wards.indexOf(ward) * 5;
      await prisma.stockOut.create({
        data: {
          id: soId, so_no: soNo,
          department_id: deptIds[ward],
          issued_by: adminUser.id,
          issued_at: daysAgo(issuedAgo),
          status: 'RECEIPT_CONFIRMED',
        },
      });
      // 각 출고에 2개 품목
      const idx1 = (soCounter - 2) % soItemCodes.length;
      const idx2 = (soCounter - 1) % soItemCodes.length;
      for (const itemCode of [soItemCodes[idx1], soItemCodes[idx2]]) {
        const soItemId = uuidv4();
        const qty = 5 + Math.floor(Math.random() * 20);
        const price = itemCode.includes('DIAPER') ? 16000 : itemCode.includes('GLOVES') ? 11000 : 2500;
        await prisma.stockOutItem.create({
          data: {
            id: soItemId, stock_out_id: soId,
            item_id: itemIds[itemCode], issued_qty: qty, location_id: locId,
          },
        });
        await prisma.stockOutLotAllocation.create({
          data: {
            id: uuidv4(), stock_out_id: soId, stock_out_item_id: soItemId,
            issued_qty: qty, unit_cost: price, line_amount: qty * price,
          },
        });
      }
    }
  }

  // 7I. 출고후속조치(StockOutFollowUp) 3건
  const soList = await prisma.stockOut.findMany({ where: { so_no: { startsWith: 'SO-SEED' } }, take: 3 });
  const followUpDefs = [
    { action: 'ISSUE_ADD',    diffQty: 3,  status: 'RESOLVED', resolvedAgo: 5 },
    { action: 'COLLECT_BACK', diffQty: 2,  status: 'OPEN',     resolvedAgo: null },
    { action: 'ISSUE_ADD',    diffQty: 5,  status: 'RESOLVED', resolvedAgo: 2 },
  ];
  for (let i = 0; i < Math.min(soList.length, followUpDefs.length); i++) {
    const fu = followUpDefs[i];
    const so = soList[i];
    try {
      await prisma.stockOutFollowUp.create({
        data: {
          id: uuidv4(), stock_out_id: so.id,
          department_id: so.department_id,
          item_id: itemIds[soItemCodes[i]],
          action_type: fu.action, diff_qty: fu.diffQty,
          status: fu.status, created_by: adminUser.id,
          created_at: daysAgo(10),
          resolved_at: fu.resolvedAgo ? daysAgo(fu.resolvedAgo) : null,
          resolved_by: fu.resolvedAgo ? adminUser.id : null,
        },
      });
    } catch {} // ignore if exists
  }

  // 7J. 병동신청(WardRequest) 4건 + 신청품목(WardRequestItem)
  const wrDefs = [
    { no: 'WR-SEED-001', ward: 'WARD2', type: 'CONSUMABLE_REGULAR', status: 'APPROVED', submittedAgo: 50, items: [{ item: 'GAUZE-01', qty: 30 }, { item: 'BAND-01', qty: 50 }] },
    { no: 'WR-SEED-002', ward: 'WARD3', type: 'DIAPER',             status: 'APPROVED', submittedAgo: 40, items: [{ item: 'DIAPER-01', qty: 20 }] },
    { no: 'WR-SEED-003', ward: 'WARD4', type: 'ADHOC',              status: 'SUBMITTED', submittedAgo: 20, items: [{ item: 'ALCOHOL-01', qty: 10 }, { item: 'GLOVES-01', qty: 15 }] },
    { no: 'WR-SEED-004', ward: 'WARD5', type: 'CONSUMABLE_REGULAR', status: 'REJECTED', submittedAgo: 35, items: [{ item: 'SYRINGE-01', qty: 100 }] },
  ];
  const wrIds: Record<string, string> = {};
  for (const wr of wrDefs) {
    const existing = await prisma.wardRequest.findUnique({ where: { request_no: wr.no } });
    if (existing) { wrIds[wr.no] = existing.id; continue; }
    const wrId = uuidv4();
    const now = new Date();
    await prisma.wardRequest.create({
      data: {
        id: wrId, request_no: wr.no,
        department_id: deptIds[wr.ward],
        requester_id: adminUser.id,
        request_type: wr.type, status: wr.status,
        period_start: new Date(now.getFullYear(), now.getMonth(), 1),
        period_end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
        submitted_at: daysAgo(wr.submittedAgo),
      },
    });
    for (const it of wr.items) {
      await prisma.wardRequestItem.create({
        data: {
          id: uuidv4(), ward_request_id: wrId,
          item_id: itemIds[it.item], requested_qty: it.qty,
        },
      });
    }
    wrIds[wr.no] = wrId;
  }

  // 7K. 승인(ApprovalAction) 3건 + 승인품목(ApprovalActionItem)
  const approvalDefs = [
    { wr: 'WR-SEED-001', action: 'APPROVE', items: [{ item: 'GAUZE-01', reqQty: 30, appQty: 30 }, { item: 'BAND-01', reqQty: 50, appQty: 45 }] },
    { wr: 'WR-SEED-002', action: 'ADJUST',  items: [{ item: 'DIAPER-01', reqQty: 20, appQty: 15 }] },
    { wr: 'WR-SEED-004', action: 'REJECT',  items: [{ item: 'SYRINGE-01', reqQty: 100, appQty: 0 }] },
  ];
  for (const ap of approvalDefs) {
    if (!wrIds[ap.wr]) continue;
    const existingActions = await prisma.approvalAction.findMany({ where: { ward_request_id: wrIds[ap.wr] } });
    if (existingActions.length > 0) continue;
    const aaId = uuidv4();
    await prisma.approvalAction.create({
      data: {
        id: aaId, ward_request_id: wrIds[ap.wr],
        approver_id: adminUser.id, action: ap.action, reason: '시드 데이터',
      },
    });
    for (const it of ap.items) {
      const diffQty = it.appQty - it.reqQty;
      await prisma.approvalActionItem.create({
        data: {
          id: uuidv4(), approval_action_id: aaId,
          item_id: itemIds[it.item],
          requested_qty: it.reqQty, approved_qty: it.appQty,
          diff_qty: diffQty, diff_pct: it.reqQty > 0 ? Math.round(diffQty / it.reqQty * 100) : 0,
        },
      });
    }
  }

  console.log('📊 통계 샘플 데이터 생성 완료!');

  console.log('✅ Seed 완료!');
  console.log('─────────────────────────────────────────');
  console.log('관리자 계정: honam206 / honam@8275');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
