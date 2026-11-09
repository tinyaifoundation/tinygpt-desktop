import { expect, it } from 'vitest';
import { projectComputerRead } from '../src/main/computer-read';
import { computerArguments, type ComputerElement, type ComputerReadOptions } from '../src/shared/computer';
import { HistoryStore } from '../src/main/history';

const windowId = 'window-1-abcd';
const rows: ComputerElement[] = Array.from({ length: 380 }, (_, i) => ({ id: `s12345678:${i}`, role: 'Button', label: `Row ${i}` }));

it('pages all controls and long prose without holes, duplicates or invalid next-read arguments', () => {
  const outline = 'Accessible document text. '.repeat(600);
  const controls: string[] = []; let text = '', options: ComputerReadOptions = {};
  for (let attempt = 0; attempt < 20; attempt++) {
    const page = projectComputerRead(windowId, rows, outline, options, true, 5000);
    expect(JSON.stringify(page).length).toBeLessThan(24000);
    controls.push(...page.elements.map(element => element.id)); text += page.text;
    if (!page.nextRead) break;
    expect(computerArguments.computer_read_window.safeParse(page.nextRead).success).toBe(true);
    options = page.nextRead;
  }
  expect(controls).toEqual(rows.map(row => row.id)); expect(text).toBe(outline);
});

it('budgets serialized JSON, marks clipped fields, and still makes progress with escaped content', () => {
  const values = Array.from({ length: 8 }, (_, i) => ({ id: `s12345678:${i}`, role: 'Edit', label: 'Field', value: '\u0000'.repeat(2000) }));
  const page = projectComputerRead(windowId, values, '\u0000'.repeat(8000), {}, true, 5000);
  expect(JSON.stringify(page).length).toBeLessThan(24000);
  expect(page.elements.length).toBeGreaterThan(0); expect(page.elements[0].valueTruncated).toBe(true);
  expect(page.nextRead!.offset).toBeGreaterThan(0); expect(page.nextRead!.textOffset).toBeGreaterThan(0);
});

it('keeps exact computer failure JSON intact when a manual draft and snapshot exceed the old storage cap', () => {
  const history = new HistoryStore(':memory:');
  try {
    const chat = history.createConversation(null); const run = history.startTurn(chat.id, 'Test native output', 'local');
    history.addTool('failure', chat.id, run.runId, 'computer_type', 'Write text');
    const result = JSON.stringify({ error: 'Unconfirmed edit', manualDraft: '\u0000'.repeat(4000), snapshot: { text: 'Observed '.repeat(2500) } });
    expect(result.length).toBeGreaterThan(40000);
    history.finishTool('failure', 'error', result);
    expect(JSON.parse(history.conversation(chat.id).tools[0].result!)).toEqual(JSON.parse(result));
  } finally { history.close(); }
});
