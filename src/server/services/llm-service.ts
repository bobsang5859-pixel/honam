/**
 * 로컬 LLM 서비스 (Ollama 기반)
 * 사용자 발화에서 의도(intent)와 파라미터를 추출
 */
import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

const MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';

// 시스템 프롬프트: intent + params 추출용
const SYSTEM_PROMPT = `당신은 병원 물품관리 시스템의 AI 어시스턴트입니다.
사용자의 한국어 명령을 분석하여 JSON 형태로 의도(intent)와 파라미터(params)를 추출합니다.

가능한 intent 목록과 매핑되는 한국어 표현들:

[조회 — confirmation_required: false]
- inventory_query: 재고 조회. params: { search?, department? }
  예: "거즈 재고", "2병동 재고 확인", "물품 현황", "재고 얼마나 있어"
- inventory_low_stock: 부족/안전재고 이하 품목 조회. params: {}
  예: "부족한 품목", "모자란 거 뭐야", "재고 부족", "안전재고 이하"
- stock_out_list: 불출 내역 조회. params: { department?, date? }
  예: "불출 내역", "출고 이력", "뭐 나갔어", "불출 현황"
- ward_request_list: 신청 목록 조회. params: { status?, department? }
  예: "신청 목록", "신청 현황", "요청 내역"
- ward_request_pending: 승인 대기 신청 조회. params: {}
  예: "대기 중인 신청", "승인 대기", "미승인 건", "결재 대기"
- po_list: 발주 목록 조회. params: { status? }
  예: "발주 목록", "발주 현황", "주문 내역"
- cost_summary: 물품비/원가 요약. params: { year?, month?, department? }
  예: "물품비", "이번달 비용", "원가 요약", "물품 비용", "물품비랑", "비용 얼마", "금액 알려줘"
- patient_count: 환자 수/가동율/병상 조회. params: { department? }
  예: "환자 수", "환자 가동", "가동율", "병상 가동", "입원 환자", "환자 몇명", "병상 현황"
- item_search: 품목 검색. params: { search }
  예: "거즈 찾아줘", "품목 검색", "뭐가 있어"
- demand_forecast: 수요 예측/재고 소진 예상 조회. params: { department?, item? }
  예: "수요 예측", "재고 소진 예상", "발주 필요한 품목", "언제 떨어져", "소진 예상", "재고 며칠", "자동 발주"

[실행 — confirmation_required: true]
- stock_out_create: 불출 생성. params: { department, items: [{name, quantity}] }
  예: "2병동 거즈 200장 불출해줘", "불출 처리해줘"
- approval_approve: 신청 승인. params: { request_no?, department? }
  예: "신청 승인해줘", "승인 처리", "결재 해줘"
- approval_reject: 신청 반려. params: { request_no?, department?, reason? }
  예: "신청 반려", "거절해줘"
- usage_register: 사용 등록. params: { department?, items: [{name, quantity}], patient_name? }
  예: "거즈 10장 사용등록", "사용 처리"
- usage_remaining: 잔량 보고 (재고 업데이트). params: { department?, items: [{name, quantity}] }
  예: "잔량 보고", "남은 수량 업데이트"
- po_create: 발주 생성. params: { vendor?, items: [{name, quantity}] }
  예: "발주 넣어줘", "주문해줘"
- receipt_create: 입고 처리. params: { vendor?, items: [{name, quantity, unit_price?}] }
  예: "입고 처리", "물건 들어왔어"

[일반]
- greeting: 인사. params: {}
- help: 도움말. params: {}
- unknown: 이해 불가. params: {}

중요 규칙:
1. 반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.
2. /no_think 태그를 사용하세요.
3. 병동 이름에서 숫자가 있으면 "N병동" 형태로 정규화하세요.
4. 수량의 한국어 표현을 숫자로 변환하세요 (서른→30, 백→100 등).
5. 복합 질문(여러 요청)이 들어오면 첫 번째(가장 주요한) 의도만 추출하세요.
   예: "물품비랑 환자 가동 알려줘" → cost_summary (첫 번째 요청 우선)
6. 정확한 intent가 없더라도 가장 유사한 intent로 매핑하세요. unknown은 정말 관련 없는 경우만 사용하세요.

응답 형식:
{"intent":"intent_name","params":{...},"confirmation_required":true/false,"summary":"사용자에게 보여줄 요약 메시지"}`;

export interface AiIntent {
  intent: string;
  params: Record<string, any>;
  confirmation_required: boolean;
  summary: string;
}

let _modelReady = false;

export async function checkModelReady(): Promise<boolean> {
  try {
    const res = await ollama.list();
    _modelReady = res.models.some(m => m.name.startsWith(MODEL.split(':')[0]));
    return _modelReady;
  } catch {
    return false;
  }
}

export async function parseCommand(userMessage: string): Promise<AiIntent> {
  try {
    const response = await ollama.chat({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `/no_think\n${userMessage}` },
      ],
      format: 'json',
      keep_alive: '30m',
      options: {
        temperature: 0.1,
        num_predict: 512,
      },
    });

    const text = response.message.content.trim();
    const parsed = JSON.parse(text);

    return {
      intent: parsed.intent || 'unknown',
      params: parsed.params || {},
      confirmation_required: parsed.confirmation_required ?? false,
      summary: parsed.summary || userMessage,
    };
  } catch (err) {
    console.error('LLM parseCommand error:', err);
    return {
      intent: 'unknown',
      params: {},
      confirmation_required: false,
      summary: '명령을 이해하지 못했습니다. 다시 말씀해 주세요.',
    };
  }
}

