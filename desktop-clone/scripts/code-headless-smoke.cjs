// Real native OpenCode commands, with no paid inference or user profile.
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { writeFile, unlink } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  assert.equal(process.platform, 'win32');
  const stop = resolve('artifacts/headless-monitor.stop');
  const script = resolve('artifacts/headless-monitor.ps1');
  await unlink(stop).catch(() => {});
  await writeFile(script, `
$taskNames = @('cmd','node','powershell','conhost','OpenConsole','WindowsTerminal')
$taskExisting = @(Get-Process -Name $taskNames -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$taskSeen = @{}
Write-Output READY
$taskUntil = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $taskUntil -and !(Test-Path -LiteralPath $args[0])) {
  foreach ($taskProcess in @(Get-Process -Name $taskNames -ErrorAction SilentlyContinue)) {
    if ($taskProcess.Id -ne $PID -and $taskProcess.Id -notin $taskExisting -and $taskProcess.MainWindowHandle -ne 0) {
      $taskSeen[[string]$taskProcess.Id] = $taskProcess.ProcessName
    }
  }
  Start-Sleep -Milliseconds 20
}
ConvertTo-Json -Compress -InputObject $taskSeen
`);
  const monitor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, stop], { windowsHide: true });
  let output = '';
  const completed = new Promise((done, reject) => { monitor.on('error', reject); monitor.on('close', code => code === 0 ? done() : reject(new Error('Window monitor failed'))); });
  await new Promise((done, reject) => { const timer=setTimeout(()=>reject(new Error('Window monitor did not start')),10000);monitor.stdout.on('data', chunk => { output+=chunk; if(output.includes('READY')) {clearTimeout(timer);done();} });monitor.once('error',reject); });
  try {
    await new Promise((done, reject) => {
      const fixture = spawn(process.execPath, [resolve('scripts/code-smoke.cjs'), '--headless'], { env: process.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
      fixture.once('error', reject); fixture.once('close', code => code === 0 ? done() : reject(new Error(`Native fixture exit ${code}`)));
    });
  } finally { await writeFile(stop, 'stop'); await completed; }
  const windows = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(windows, {}, 'Native commands must not create visible console windows');
  console.log('Headless native cmd.exe and Node commands passed; no visible console windows.');
}
main().catch(error => { console.error(error); process.exitCode=1; });
