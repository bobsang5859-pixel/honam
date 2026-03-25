import React, { useState, useRef, useEffect, useCallback } from 'react';

interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  timestamp: Date;
  confirmation_id?: string;
  confirmation_required?: boolean;
  confirmed?: boolean;
  intent?: string;
}

const API = '/api/ai';

export default function AiChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'ai',
      content: '안녕하세요! AI 어시스턴트입니다.\n재고 조회, 불출, 신청 승인 등 무엇이든 말씀해 주세요.\n\n"도움말"을 입력하면 사용 가능한 명령을 볼 수 있습니다.',
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // AI 상태 확인
  useEffect(() => {
    const token = localStorage.getItem('token');
    fetch(`${API}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => setAiReady(d.model_ready))
      .catch(() => setAiReady(false));
  }, []);

  // 스크롤 하단 유지
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 열릴 때 포커스
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    setMessages(prev => [
      ...prev,
      { ...msg, id: Math.random().toString(36).slice(2), timestamp: new Date() },
    ]);
  }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    addMessage({ role: 'user', content: text });
    setInput('');
    setLoading(true);

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (!res.ok) {
        addMessage({
          role: 'ai',
          content: data.error || `오류가 발생했습니다. (${res.status})`,
        });
        return;
      }

      addMessage({
        role: 'ai',
        content: data.message || '응답을 받지 못했습니다.',
        confirmation_id: data.pending_action?.id,
        confirmation_required: data.confirmation_required,
        intent: data.intent,
      });
    } catch (err) {
      addMessage({
        role: 'ai',
        content: 'AI 서버에 연결할 수 없습니다. Ollama가 실행 중인지 확인해주세요.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (confirmId: string) => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API}/confirm/${confirmId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      // 확인 상태 업데이트
      setMessages(prev =>
        prev.map(m =>
          m.confirmation_id === confirmId ? { ...m, confirmed: true } : m
        )
      );

      addMessage({
        role: 'ai',
        content: data.message || '처리 완료',
      });
    } catch {
      addMessage({ role: 'ai', content: '실행 중 오류가 발생했습니다.' });
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (confirmId: string) => {
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API}/confirm/${confirmId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      setMessages(prev =>
        prev.map(m =>
          m.confirmation_id === confirmId ? { ...m, confirmed: true } : m
        )
      );

      addMessage({ role: 'ai', content: '취소되었습니다.' });
    } catch {
      // ignore
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // 플로팅 버튼 + 패널
  return (
    <>
      {/* 플로팅 버튼 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-white text-2xl transition-all hover:scale-110"
        style={{
          background: isOpen ? '#64748b' : '#0d9488',
        }}
        title="AI 어시스턴트"
      >
        {isOpen ? '✕' : 'AI'}
      </button>

      {/* 채팅 패널 */}
      {isOpen && (
        <div
          className="fixed bottom-24 right-6 z-50 flex flex-col bg-white rounded-xl shadow-2xl border border-gray-200"
          style={{ width: 400, height: 520 }}
        >
          {/* 헤더 */}
          <div className="px-4 py-3 bg-teal-600 text-white rounded-t-xl flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold">AI 어시스턴트</span>
              {aiReady === true && (
                <span className="w-2 h-2 rounded-full bg-green-300" title="AI 준비됨" />
              )}
              {aiReady === false && (
                <span className="w-2 h-2 rounded-full bg-red-400" title="AI 연결 안됨" />
              )}
            </div>
            <span className="text-xs text-teal-200">Qwen3 로컬</span>
          </div>

          {/* 메시지 영역 */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-teal-500 text-white'
                      : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {msg.content}

                  {/* 확인/취소 버튼 */}
                  {msg.confirmation_required && msg.confirmation_id && !msg.confirmed && (
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => handleConfirm(msg.confirmation_id!)}
                        disabled={loading}
                        className="px-3 py-1 bg-teal-600 text-white rounded text-xs font-medium hover:bg-teal-700 disabled:opacity-50"
                      >
                        확인
                      </button>
                      <button
                        onClick={() => handleCancel(msg.confirmation_id!)}
                        disabled={loading}
                        className="px-3 py-1 bg-gray-400 text-white rounded text-xs font-medium hover:bg-gray-500 disabled:opacity-50"
                      >
                        취소
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 text-gray-500 px-3 py-2 rounded-lg text-sm">
                  생각 중...
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* 입력 영역 */}
          <div className="px-4 py-3 border-t border-gray-200">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="명령을 입력하세요..."
                disabled={loading}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:bg-gray-50"
              />
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                전송
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
