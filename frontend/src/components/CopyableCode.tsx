import { useState } from 'react';
import { useToast } from '@/features/ui/useToast';

interface Props {
  value: string;
  label?: string;
  className?: string;
}

/** Inline <code> with a "Copy" button. */
export default function CopyableCode({ value, label = 'Copy', className }: Props) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const onCopy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(value);
      toast('success', 'Copied to clipboard', 2000);
    } catch {
      toast('error', 'Copy failed - select and copy manually', 3000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={`copyable ${className ?? ''}`}>
      <code>{value}</code>
      <button
        className="ghost"
        onClick={onCopy}
        disabled={busy}
        title="Copy to clipboard"
        aria-label="Copy to clipboard"
      >
        {busy ? '…' : label}
      </button>
    </span>
  );
}
