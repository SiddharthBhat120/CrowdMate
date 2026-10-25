import { useEffect, useState } from 'react';

interface QRCodeProps {
  value: string;
  /** Describes where the code leads, for screen readers. */
  label: string;
  size?: number;
}

/**
 * Renders a QR code as an <img>. The qrcode library is loaded on demand, so
 * visitors scanning a code never download the code that draws one.
 */
export function QRCode({ value, label, size = 200 }: QRCodeProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    import('qrcode')
      .then((lib) => lib.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } }))
      .then((svg) => {
        if (!cancelled) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) return <p className="qr-fallback">Could not draw the QR code. Share this link instead: {value}</p>;
  if (!src) return <div className="qr-placeholder" style={{ width: size, height: size }} aria-hidden="true" />;
  return <img className="qr" src={src} width={size} height={size} alt={label} />;
}
