import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

interface ToastApi {
  show: (message: string, options?: { tone?: Toast['tone']; action?: Toast['action']; durationMs?: number }) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export const useToast = () => useContext(ToastContext);

/**
 * Short messages at the bottom of the screen. The container is a polite
 * live region, so screen readers announce each toast without interrupting.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback<ToastApi['show']>(
    (message, options = {}) => {
      const id = nextId.current++;
      const toast: Toast = { id, message, tone: options.tone ?? 'info' };
      if (options.action) toast.action = options.action;
      setToasts((list) => [...list.slice(-2), toast]);
      const duration = options.durationMs ?? (options.action ? 12_000 : 5_000);
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="btn btn-small btn-inverse"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button type="button" className="toast-close" aria-label="Dismiss message" onClick={() => dismiss(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
