import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { workRuntimePaths } from './work-runtimes';

export const DEVTOOLS_PREFIX = 'chrome_devtools_';
export const devtoolsReadTools = new Set(['list_pages', 'take_snapshot', 'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request']);
export function devtoolsPermissions(args: Record<string, unknown>): ('read' | 'browser' | 'interact' | 'write')[] {
  const input = args.input as Record<string, unknown> | undefined;
  return ['read', 'browser', ...(!devtoolsReadTools.has(String(args.tool)) ? ['interact' as const] : []), ...(args.tool !== 'upload_file' && ['filePath','requestFilePath','responseFilePath','traceFilePath'].some(key => typeof input?.[key] === 'string') ? ['write' as const] : [])];
}

/** The official MCP owns Chromium automation. Never attach to TinyGPT's debugger. */
export function devtoolsMcpConfig(root: string, workspace = root) {
  const browsers = process.platform === 'win32' ? [
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const executable = browsers.find(path => existsSync(path));
  if (!executable) return undefined;
  const require = createRequire(__filename);
  const entry = require.resolve('chrome-devtools-mcp').replace(/index\.js$/, 'bin/chrome-devtools-mcp.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const node = workRuntimePaths().node;
  if (!existsSync(node)) throw new Error('The bundled Node runtime required by Chrome DevTools MCP is unavailable.');
  return {
    type: 'local' as const,
    command: [node, entry, '--headless', '--executable-path', executable, '--user-data-dir', resolve(root, 'browser-profile'), '--workspace', resolve(workspace), '--log-file', resolve(root, 'devtools.log'), '--no-usage-statistics', '--no-performance-crux', '--no-category-performance', '--no-category-memory', '--no-category-emulation', '--no-file-navigations'],
    environment: Object.fromEntries(['USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','SystemRoot','WINDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])), enabled: true, timeout: 30000,
  };
}
