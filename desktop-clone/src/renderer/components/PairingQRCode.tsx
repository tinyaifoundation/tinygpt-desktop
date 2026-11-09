import { useMemo } from 'react';
import QRCode from 'qrcode';

/** Keep the optical code conventional; branding belongs around its quiet zone. */
export function PairingQRCode({ value }: { value: string }) {
  const code = useMemo(() => QRCode.create(value, { errorCorrectionLevel: 'M' }), [value]);
  const size = code.modules.size, margin = 4, extent = size + margin * 2;
  const paths: string[] = [];
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    if (code.modules.get(row,column)) paths.push(`M${column+margin} ${row+margin}h1v1h-1z`);
  }
  return <div className="remote-qr"><svg viewBox={`0 0 ${extent} ${extent}`} shapeRendering="crispEdges" role="img" aria-label="Scan to pair TinyGPT" xmlns="http://www.w3.org/2000/svg"><rect width={extent} height={extent} fill="white" /><path d={paths.join('')} fill="black" /></svg></div>;
}
