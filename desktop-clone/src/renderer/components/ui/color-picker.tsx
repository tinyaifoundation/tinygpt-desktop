import { useEffect, useId, useState, type ReactElement } from 'react';
import { HexColorPicker } from 'react-colorful';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { ControlTooltip } from './tooltip';

export function ColorPicker({ value, onValueChange, children, label = 'Custom color' }: {
  value: string; onValueChange: (color: string) => void; children: ReactElement; label?: string;
}) {
  const id = useId();
  const [hex, setHex] = useState(value.toUpperCase());
  useEffect(() => { setHex(value.toUpperCase()); }, [value]);
  function settleHex() {
    const digits = hex.trim().replace(/^#/, '');
    if (/^[\da-f]{3}$/i.test(digits)) onValueChange('#' + [...digits].map(char => char + char).join('').toLowerCase());
    else if (/^[\da-f]{6}$/i.test(digits)) onValueChange('#' + digits.toLowerCase());
    else setHex(value.toUpperCase());
  }
  return <Popover onOpenChange={() => setHex(value.toUpperCase())}>
    <ControlTooltip label={label}><PopoverTrigger asChild>{children}</PopoverTrigger></ControlTooltip>
    <PopoverContent className="color-picker-popover" align="end" aria-label={label}>
      <HexColorPicker color={value} onChange={onValueChange} aria-label="Color canvas" />
      <div className="color-picker-value"><span className="color-picker-sample" style={{ backgroundColor: value }} aria-hidden="true" /><label htmlFor={id} className="sr-only">Hex color</label><Input id={id} value={hex} maxLength={7} spellCheck={false} autoComplete="off" onChange={event => { const next = event.target.value; setHex(next); const digits = next.replace(/^#/, ''); if (/^[\da-f]{6}$/i.test(digits)) onValueChange('#' + digits.toLowerCase()); }} onBlur={settleHex} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); settleHex(); } }} /></div>
    </PopoverContent>
  </Popover>;
}
