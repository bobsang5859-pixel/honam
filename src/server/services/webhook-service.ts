/**
 * Webhook 이벤트 발송 서비스 (n8n 연동 기반)
 * AppSetting 'N8N_WEBHOOK_URL'이 설정되어 있을 때만 동작.
 * 미설정 시 아무 동작 없이 skip (fire-and-forget).
 *
 * SSRF 방어: URL 검증으로 내부 네트워크 접근 차단.
 * 허용 예외: ALLOWED_WEBHOOK_HOSTS 환경변수에 등록된 호스트만 허용.
 */
import { prisma } from '../index';

export type WebhookEventType =
  | 'LOW_STOCK'
  | 'REQUEST_CREATED'
  | 'REQUEST_APPROVED'
  | 'PO_CREATED'
  | 'RECEIPT_COMPLETED'
  | 'FORECAST_ALERT';

let _cachedUrl: string | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 1분 캐시

// 허용된 webhook 호스트 목록 (환경변수에서 로드)
// 예: ALLOWED_WEBHOOK_HOSTS=192.168.1.50,n8n.hospital.local
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_WEBHOOK_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

/**
 * Webhook URL SSRF 검증
 * - http/https만 허용
 * - localhost, 127.x, 0.0.0.0, 사설 IP 차단
 * - ALLOWED_WEBHOOK_HOSTS에 등록된 호스트는 예외 허용
 */
function isAllowedWebhookUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  // http/https만 허용
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname.toLowerCase();

  // 허용 목록에 있으면 통과
  if (ALLOWED_HOSTS.has(hostname)) return true;

  // 차단 대상: localhost, loopback, 사설 IP
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return false;
  if (hostname === '[::1]' || hostname === '::1') return false;

  // 127.x.x.x
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  // 10.x.x.x
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  // 172.16-31.x.x
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return false;
  // 192.168.x.x
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return false;
  // 0.x.x.x
  if (/^0\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  // 169.254.x.x (link-local)
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) return false;

  return true;
}

async function getWebhookUrl(): Promise<string | null> {
  const now = Date.now();
  if (_cachedUrl !== null && now - _cacheTime < CACHE_TTL) return _cachedUrl || null;

  try {
    const setting = await prisma.appSetting.findUnique({
      where: { key: 'N8N_WEBHOOK_URL' },
    });
    _cachedUrl = setting?.value?.trim() || '';
    _cacheTime = now;
    return _cachedUrl || null;
  } catch {
    return null;
  }
}

/**
 * 외부 webhook으로 이벤트 발송 (fire-and-forget)
 * URL 미설정이거나 실패해도 앱 동작에 영향 없음
 */
export async function emitEvent(
  type: WebhookEventType,
  payload: Record<string, any>
): Promise<void> {
  const url = await getWebhookUrl();
  if (!url) return;

  if (!isAllowedWebhookUrl(url)) {
    console.warn(`[Webhook] Blocked SSRF attempt: ${url}`);
    return;
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: type,
        timestamp: new Date().toISOString(),
        data: payload,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // 실패해도 무시 — 앱 동작에 영향 없음
  }
}

/** URL 캐시 초기화 (설정 변경 시 호출) */
export function clearWebhookCache(): void {
  _cachedUrl = null;
  _cacheTime = 0;
}

/** URL 검증 결과 반환 (설정 페이지 테스트용) */
export function validateWebhookUrl(url: string): { valid: boolean; reason?: string } {
  if (!url) return { valid: false, reason: 'URL이 비어있습니다' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: 'http/https 프로토콜만 허용됩니다' };
    }
  } catch {
    return { valid: false, reason: '올바른 URL 형식이 아닙니다' };
  }
  if (!isAllowedWebhookUrl(url)) {
    return { valid: false, reason: '내부 네트워크 주소는 차단됩니다. ALLOWED_WEBHOOK_HOSTS 환경변수에 등록하세요.' };
  }
  return { valid: true };
}
