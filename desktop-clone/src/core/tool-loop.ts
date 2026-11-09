// Detect unchanged failed actions, not productive task length. Successful reads
// (including repeated polling) and changed arguments remain unrestricted.
import { operationOutcome, operationSignature } from './operation-outcome';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export class ToolLoopGuard {
  private recent: { key: string; failed: boolean }[] = [];
  constructor(private work = false) {}
  private failure?: string;
  private repeats = 0;
  blocked(name: string, input: unknown): boolean {
    if (this.work) return this.recent.filter(item => item.failed && item.key === operationSignature(name, input)).length >= 3;
    return this.repeats >= 3 && this.failure === canonical([name, input]);
  }
  record(name: string, input: unknown, result: string): void {
    const failed = ['failed', 'cancelled'].includes(operationOutcome(result).status);
    if (this.work) { this.recent.push({ key: operationSignature(name, input), failed }); this.recent = this.recent.slice(-32); }
    if (!failed) { this.failure = undefined; this.repeats = 0; return; }
    const key = canonical([name, input]);
    this.repeats = key === this.failure ? this.repeats + 1 : 1;
    this.failure = key;
  }
}
