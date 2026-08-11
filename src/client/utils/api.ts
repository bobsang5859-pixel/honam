const API_BASE = '/api';

let authToken: string | null = localStorage.getItem('token');

export function setToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}

export function getToken() {
  return authToken;
}

export async function api(endpoint: string, options: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });

  if (res.status === 401) {
    setToken(null);
    window.location.href = '/login';
    throw new Error('인증이 만료되었습니다.');
  }

  if (
    res.headers.get('content-type')?.includes('application/pdf') ||
    res.headers.get('content-type')?.includes('application/octet-stream') ||
    res.headers.get('content-type')?.includes('spreadsheetml')
  ) {
    return res.blob();
  }

  // 응답 본문이 JSON 이 아닐 수 있음 (서버가 HTML 404 등 반환).
  // 파싱 실패 시 status code 와 url 을 담은 명확한 에러로 재포장.
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) {
      throw new Error(`서버 응답 오류 (${res.status}) — ${endpoint}. 서버 재시작이 필요할 수 있습니다.`);
    }
    return null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `요청 처리 중 오류가 발생했습니다. (${res.status})`);
  }
  return data;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
