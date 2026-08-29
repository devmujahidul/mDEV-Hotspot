import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { selectToasts, toastRemoved, Toast } from '@/features/ui/uiSlice';

function ToastItem({ t }: { t: Toast }) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!t.ttl) return;
    const id = window.setTimeout(() => dispatch(toastRemoved(t.id)), t.ttl);
    return () => window.clearTimeout(id);
  }, [dispatch, t.id, t.ttl]);

  return (
    <div className={`toast toast-${t.kind}`} role="status">
      <div className="grow">{t.message}</div>
      <button
        className="ghost"
        onClick={() => dispatch(toastRemoved(t.id))}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

export default function Toaster() {
  const toasts = useAppSelector(selectToasts);
  if (!toasts.length) return null;
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
