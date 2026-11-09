export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60); const rest = rounded % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
