import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('patient-charges', 'PATIENT_MANAGE', 'BASIC_MANAGE'));

const PAYMENT_METHODS = ['CASH', 'CARD', 'TRANSFER', 'OTHER'];

// ── 월별 수납 현황 요약 ──
router.get('/summary', async (req: AuthRequest, res) => {
  try {
    const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
    const departmentId = req.query.department_id ? String(req.query.department_id) : '';

    const where: any = { status: 'ADMITTED', deleted_at: null };
    if (departmentId) where.department_id = departmentId;

    const patients = await prisma.patient.findMany({
      where,
      select: {
        id: true,
        name: true,
        patient_no: true,
        department_id: true,
        insurance_type: true,
        department: { select: { name: true } },
        charges: {
          where: { charge_month: month, deleted_at: null },
          select: { category: true, item_name: true, amount: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    // 수납 합계 (PatientPayment)
    const payments = await (prisma as any).patientPayment.findMany({
      where: { charge_month: month, deleted_at: null },
      select: { patient_id: true, amount: true },
    });
    const paymentByPatient: Record<string, number> = {};
    for (const p of payments) {
      paymentByPatient[p.patient_id] = (paymentByPatient[p.patient_id] || 0) + Number(p.amount);
    }

    let totalCharge = 0;
    let totalPayment = 0;

    const rows = patients.map(p => {
      const chargeSum = p.charges.reduce((s, c) => s + Number(c.amount), 0);
      const paymentSum = paymentByPatient[p.id] || 0;
      const unpaid = Math.max(0, chargeSum - paymentSum);
      const status = chargeSum === 0 ? 'NONE' : unpaid <= 0 ? 'PAID' : paymentSum > 0 ? 'PARTIAL' : 'UNPAID';

      totalCharge += chargeSum;
      totalPayment += paymentSum;

      return {
        patient_id: p.id,
        patient_no: p.patient_no,
        name: p.name,
        department_name: p.department?.name ?? '',
        insurance_type: p.insurance_type,
        total_charge: chargeSum,
        total_payment: paymentSum,
        unpaid,
        status,
      };
    });

    const totalUnpaid = Math.max(0, totalCharge - totalPayment);
    const paymentRate = totalCharge > 0 ? Number(((totalPayment / totalCharge) * 100).toFixed(1)) : 0;

    res.json({
      month,
      summary: { total_charge: totalCharge, total_payment: totalPayment, total_unpaid: totalUnpaid, payment_rate: paymentRate },
      patients: rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 환자 1명 상세 (진료비 + 수납 이력) ──
router.get('/:patientId/detail', async (req: AuthRequest, res) => {
  try {
    const { patientId } = req.params;
    const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));

    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: {
        id: true, name: true, patient_no: true, insurance_type: true,
        department: { select: { name: true } },
      },
    });
    if (!patient) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });

    const charges = await prisma.patientCharge.findMany({
      where: { patient_id: patientId, charge_month: month, deleted_at: null },
      orderBy: [{ category: 'asc' }, { item_name: 'asc' }],
    });

    const payments = await (prisma as any).patientPayment.findMany({
      where: { patient_id: patientId, charge_month: month, deleted_at: null },
      orderBy: { payment_date: 'desc' },
    });

    const chargeTotal = charges.reduce((s: number, c: any) => s + Number(c.amount), 0);
    const paymentTotal = payments.reduce((s: number, p: any) => s + Number(p.amount), 0);

    res.json({
      patient,
      charges,
      payments,
      charge_total: chargeTotal,
      payment_total: paymentTotal,
      unpaid: Math.max(0, chargeTotal - paymentTotal),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 수납 입금 처리 ──
router.post('/:patientId/payments', async (req: AuthRequest, res) => {
  try {
    const { patientId } = req.params;
    const { amount, payment_date, payment_method, charge_month, note } = req.body;

    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: '금액은 0보다 커야 합니다.' });
    if (!charge_month) return res.status(400).json({ error: '청구월은 필수입니다.' });
    if (!PAYMENT_METHODS.includes(payment_method)) return res.status(400).json({ error: '유효하지 않은 수납방법입니다.' });

    const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { name: true } });
    if (!patient) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });

    const payment = await (prisma as any).patientPayment.create({
      data: {
        id: uuidv4(),
        patient_id: patientId,
        amount: Number(amount),
        payment_date: new Date(payment_date || new Date()),
        payment_method,
        charge_month,
        note: note || '',
        created_by: req.user!.id,
      },
    });

    await audit(req, 'PATIENT_PAYMENT_CREATE', `환자 ${patient.name} 수납 ₩${Number(amount).toLocaleString()} (${charge_month})`, patientId);

    res.json(payment);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 수납 취소 (soft delete) ──
router.delete('/payments/:paymentId', async (req: AuthRequest, res) => {
  try {
    const { paymentId } = req.params;

    const existing = await (prisma as any).patientPayment.findUnique({ where: { id: paymentId } });
    if (!existing || existing.deleted_at) return res.status(404).json({ error: '수납 기록을 찾을 수 없습니다.' });

    await (prisma as any).patientPayment.update({
      where: { id: paymentId },
      data: { deleted_at: new Date() },
    });

    const patient = await prisma.patient.findUnique({ where: { id: existing.patient_id }, select: { name: true } });
    await audit(req, 'PATIENT_PAYMENT_DELETE', `환자 ${patient?.name ?? ''} 수납 취소 ₩${Number(existing.amount).toLocaleString()}`, existing.patient_id);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
