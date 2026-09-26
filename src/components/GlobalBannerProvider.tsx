import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ToastTone } from "../lib/toast";

/** 顶部提示条：错误文案可能较长，给足阅读时间 */
const BANNER_AUTO_DISMISS_MS: Record<ToastTone, number> = {
  error: 12000,
  success: 5000,
  info: 7000,
};

export interface BannerNotice {
  tone: ToastTone;
  text: string;
}

interface GlobalBannerContextValue {
  notice: BannerNotice | null;
  /** @deprecated 兼容旧调用：等同于 showNotice("error", …) */
  error: string | null;
  showError: (message: string) => void;
  showNotice: (tone: ToastTone, message: string) => void;
  clearError: () => void;
}

const GlobalBannerContext = createContext<GlobalBannerContextValue | null>(null);

export function GlobalBannerProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<BannerNotice | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current != null) {
      clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = null;
  }, []);

  const clearError = useCallback(() => {
    clearDismissTimer();
    setNotice(null);
  }, [clearDismissTimer]);

  const showNotice = useCallback(
    (tone: ToastTone, message: string) => {
      const trimmed = message.trim();
      if (!trimmed) {
        clearError();
        return;
      }
      clearDismissTimer();
      setNotice({ tone, text: trimmed });
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        setNotice(null);
      }, BANNER_AUTO_DISMISS_MS[tone]);
    },
    [clearDismissTimer, clearError],
  );

  const showError = useCallback(
    (message: string) => {
      showNotice("error", message);
    },
    [showNotice],
  );

  useEffect(() => {
    return () => {
      clearDismissTimer();
    };
  }, [clearDismissTimer]);

  const value = useMemo(
    () => ({
      notice,
      error: notice?.tone === "error" ? notice.text : (notice?.text ?? null),
      showError,
      showNotice,
      clearError,
    }),
    [clearError, notice, showError, showNotice],
  );

  return <GlobalBannerContext.Provider value={value}>{children}</GlobalBannerContext.Provider>;
}

export function useGlobalBanner(): GlobalBannerContextValue {
  const ctx = useContext(GlobalBannerContext);
  if (!ctx) {
    throw new Error("useGlobalBanner must be used within GlobalBannerProvider");
  }
  return ctx;
}
