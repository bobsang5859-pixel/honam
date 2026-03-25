import React, { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hospitalName, setHospitalName] = useState('병원');
  const [appName, setAppName] = useState('물품 관리 시스템');

  useEffect(() => {
    api('/system/public-info').then((info: any) => {
      if (info?.hospital_name) setHospitalName(info.hospital_name);
      if (info?.app_name) setAppName(info.app_name);
    }).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err.message || '로그인 실패');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'linear-gradient(135deg,#0f2744 0%,#163374 60%,#1e4690 100%)' }}
    >
      <div className="w-full max-w-sm px-4">
        {/* Header */}
        <div className="text-center mb-8">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4"
            style={{ background: '#14b8a6' }}
          >
            H
          </div>
          <h1 className="text-white text-xl font-bold leading-tight">
            {hospitalName}
          </h1>
          <p className="text-blue-200/70 text-sm mt-1">{appName}</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-navy-800 font-bold text-base mb-6 text-center">로그인</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-100 text-red-600 text-sm rounded-lg">
                {error}
              </div>
            )}

            <div>
              <label className="label">아이디</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="input"
                placeholder="아이디 입력"
                autoFocus
                required
              />
            </div>

            <div>
              <label className="label">비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="input"
                placeholder="비밀번호 입력"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg text-white font-semibold text-sm transition-all duration-150 mt-2 disabled:opacity-60"
              style={{ background: loading ? '#94a3b8' : '#14b8a6' }}
            >
              {loading ? '로그인 중...' : '로그인'}
            </button>
          </form>

        </div>

        <p className="text-center text-blue-200/40 text-xs mt-6">내부망 전용 · 무단 접근 금지</p>
      </div>
    </div>
  );
}
