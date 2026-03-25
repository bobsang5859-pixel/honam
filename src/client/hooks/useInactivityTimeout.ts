import { useEffect, useRef, useCallback } from 'react';

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'mousedown', 'touchstart'] as const;

/**
 * 비활동 자동 로그아웃 훅
 * @param onLogout 로그아웃 콜백 (useAuth().logout)
 * @param enabled 활성화 여부 (로그인된 경우에만 true)
 * @param options.timeoutMin 자동 로그아웃 분 (기본 30)
 * @param options.warnBeforeMin 만료 전 경고 표시 분 (기본 5)
 */
export function useInactivityTimeout(
  onLogout: () => void,
  enabled: boolean,
  options?: { timeoutMin?: number; warnBeforeMin?: number },
) {
  const timeoutMin = Math.max(options?.timeoutMin ?? 30, 1);
  const warnBeforeMin = Math.min(options?.warnBeforeMin ?? 5, timeoutMin - 1);
  const WARN_AFTER_MS   = (timeoutMin - warnBeforeMin) * 60 * 1000;
  const LOGOUT_AFTER_MS = timeoutMin * 60 * 1000;
  const warnTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnDialogRef  = useRef<boolean>(false);

  const clearTimers = useCallback(() => {
    if (warnTimerRef.current)   clearTimeout(warnTimerRef.current);
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
  }, []);

  const resetTimers = useCallback(() => {
    if (!enabled) return;
    clearTimers();

    // 경고 다이얼로그가 열려있으면 닫기
    if (warnDialogRef.current) {
      warnDialogRef.current = false;
    }

    warnTimerRef.current = setTimeout(() => {
      warnDialogRef.current = true;
      const stay = window.confirm(
        `세션이 곧 만료됩니다.\n${warnBeforeMin}분 후 자동으로 로그아웃됩니다.\n\n계속 사용하시려면 "확인"을 누르세요.`
      );
      warnDialogRef.current = false;
      if (stay) {
        // 확인 클릭 = 타이머 리셋
        resetTimers();
      }
    }, WARN_AFTER_MS);

    logoutTimerRef.current = setTimeout(() => {
      alert('비활동으로 인해 자동 로그아웃되었습니다.');
      onLogout();
    }, LOGOUT_AFTER_MS);
  }, [enabled, clearTimers, onLogout]);

  useEffect(() => {
    if (!enabled) {
      clearTimers();
      return;
    }

    resetTimers();

    const handleActivity = () => resetTimers();
    ACTIVITY_EVENTS.forEach((event) =>
      window.addEventListener(event, handleActivity, { passive: true })
    );

    return () => {
      clearTimers();
      ACTIVITY_EVENTS.forEach((event) =>
        window.removeEventListener(event, handleActivity)
      );
    };
  }, [enabled, resetTimers, clearTimers]);
}
