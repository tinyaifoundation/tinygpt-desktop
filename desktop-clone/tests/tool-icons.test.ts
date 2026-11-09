import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toolIcon } from '../src/renderer/tool-icons';
import { connectorToolIconKeys } from '../src/shared/connector-tool-icon-keys';
import overrides from '../src/shared/tool-icon-overrides.json';
import type { PluginSnapshot, PluginView } from '../src/shared/plugins';
import { Globe, CircleHelp } from '../src/renderer/icons';
import { toolNameSchema } from '../src/shared/tools';
import type { ToolName } from '../src/shared/tools';

function plugin(id: string, connector?: string) {
  return { id, manifest: { connector }, tools: [] } as unknown as PluginView;
}
function alias(id: string, name: string) {
  return `ext_${name}_${createHash('sha256').update(`${id}\0${name}`).digest('hex').slice(0, 24)}` as const;
}
function glyph(name: string, connectorKey?: string) {
  return renderToStaticMarkup(createElement(toolIcon(name as ToolName, connectorKey)));
}

describe('Approved Solar toolchain mappings', () => {
  it('renders every selected tool with the exact Solar Linear glyph', () => {
    for (const [key, slug] of Object.entries(overrides)) {
      const name = key.includes('/') ? alias('fixture-plugin', key.split('/')[1]) : key;
      expect(glyph(name, key.includes('/') ? key : undefined), key).toContain(`solar-${slug}-linear`);
    }
  });

  it('matches every connector by installed plugin identity, even without a connected catalog', async () => {
    const entries = ['gmail', 'gdrive', 'gcalendar', 'github', 'slack'].map(kind => plugin(`${kind}-instance`, kind));
    const keys = await connectorToolIconKeys({ entries } as PluginSnapshot);
    expect(Object.values(keys).sort()).toEqual(Object.keys(overrides).filter(key => key.includes('/') && !key.startsWith('plugin/')).sort());
    for (const [name, key] of Object.entries(keys)) expect(glyph(name, key)).toContain('solar-plug-circle-linear');
    expect(keys[alias('github-instance', 'read_file')]).toBe('github/read_file');
    expect(keys[alias('different-mcp-instance', 'read_file')]).toBeUndefined();
    expect(glyph(alias('different-mcp-instance', 'read_file'))).toContain('solar-plug-circle-linear');
  });

  it('supports the combined Google connector without applying choices to local plugins', async () => {
    const keys = await connectorToolIconKeys({ entries: [plugin('google-instance', 'google'), plugin('local-plugin')] } as PluginSnapshot);
    expect(keys[alias('google-instance', 'read_mail')]).toBe('gmail/read_mail');
    expect(keys[alias('google-instance', 'read_document')]).toBe('google-drive/read_document');
    expect(keys[alias('local-plugin', 'read_document')]).toBeUndefined();
  });

  it('honors individual browser choices before the default browser globe', () => {
    for (const name of ['code_devtools', ...toolNameSchema.options.filter(name => name.startsWith('browser_'))]) {
      const slug = overrides[name as keyof typeof overrides];
      if (slug) expect(glyph(name), name).toContain(`solar-${slug}-linear`);
      else expect(glyph(name), name).toBe(renderToStaticMarkup(createElement(Globe)));
    }
    expect(glyph('browser_future_action')).toBe(renderToStaticMarkup(createElement(Globe)));
  });

  it('uses the question circle for Work questions instead of the library fallback', () => {
    expect(glyph('work_ask_user')).toBe(renderToStaticMarkup(createElement(CircleHelp)));
  });

  it('preserves unchanged tools and the remaining computer defaults', () => {
    expect(glyph('search_web')).toContain('solar-magnifier-linear');
    expect(glyph('view_image')).toContain('solar-gallery-wide-linear');
    expect(glyph('code_edit')).toContain('solar-file-pen-linear');
    expect(glyph('computer_click')).toContain('solar-cursor-linear');
    expect(glyph('computer_read_window')).toContain('solar-cursor-linear');
    expect(glyph('model_load')).toContain('solar-refresh-square-linear');
    expect(glyph('ext_unchanged_000000000000000000000000')).toContain('solar-plug-circle-linear');
    expect(glyph('bot_historical_action')).toContain('solar-bot-linear');
  });

  it('keeps built-in skill icons distinct from UUID-scoped local plugin actions', async () => {
    const skillPlugin = { ...plugin('skill-instance'), manifest: { kind: 'skill', skills: [{ references: { guide: 'text' } }] } } as unknown as PluginView;
    const reports = { ...plugin('report-instance'), manifest: { kind:'builtin', id:'tinygpt-reports', skills:[] } } as unknown as PluginView;
    const mcp = { ...plugin('mcp-instance'), manifest: { kind:'mcp', skills:[], server:{transport:'http'} } } as unknown as PluginView;
    const other = { ...plugin('other-instance'), manifest: { kind:'builtin', id:'other', skills:[] } } as unknown as PluginView;
    const keys = await connectorToolIconKeys({ entries:[skillPlugin,reports,mcp,other] });
    const expected = [
      ['skill-instance','load_skill','download-square'], ['skill-instance','read_skill_reference','notebook-2'],
      ['report-instance','create_report','document-add'], ['mcp-instance','tinygpt_read_resource','notebook-2'], ['mcp-instance','tinygpt_get_prompt','notebook-2'],
    ];
    for (const [id,name,slug] of expected) expect(glyph(alias(id,name),keys[alias(id,name)])).toContain(`solar-${slug}-linear`);
    expect(glyph('load_skill')).toContain('solar-square-transfer-horizontal-linear');
    expect(keys[alias('other-instance','load_skill')]).toBeUndefined();
    expect(keys[alias('other-instance','create_report')]).toBeUndefined();
    expect(keys[alias('mcp-instance','load_skill')]).toBeUndefined();
    expect(glyph(alias('other-instance','load_skill'))).toContain('solar-plug-circle-linear');
  });
});
