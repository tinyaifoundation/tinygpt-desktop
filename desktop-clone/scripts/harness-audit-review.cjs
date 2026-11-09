// Node 24 can load this dependency-free TypeScript module using native type stripping.
const { auditCommandExit, auditSnapshotEvidence } = require('../src/core/harness-audit.ts');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, join, basename } = require('node:path');
const runPaths = process.argv.slice(2);
if (!runPaths.length) { console.error('Usage: node scripts/harness-audit-review.cjs <run-directory> [more run directories]'); process.exit(1); }
const reviewed = runPaths.map(path => {
  const root = resolve(path), summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const cases = summary.results.map(result => {
    const conversation = JSON.parse(readFileSync(join(root, `${result.repeat}-${result.id}`, 'conversation.json'), 'utf8'));
    let failures = [...result.failures]; const reviewNotes = [];
    if (result.id === 'chat-browser-interact' && conversation.tools.some(t => t.name === 'browser_click' && t.status === 'success' && auditSnapshotEvidence(t.result, 'APPLIED=MAPLE'))) {
      failures = failures.filter(f => f !== 'Missing expected tool outcome: browser_snapshot');
      if (failures.length !== result.failures.length) reviewNotes.push({ classification: 'oracle', detail: 'browser_click returned a fresh matched accessibility snapshot; a redundant standalone snapshot is unnecessary.' });
    }
    if (result.id === 'work-shell-error' && !conversation.tools.some(t => t.name === 'code_bash' && auditCommandExit(t.result, 7))) {
      const detail = 'Structured shell exit code differs from expected child exit code 7';
      if (!failures.includes(detail)) failures.push(detail);
      reviewNotes.push({ classification: 'diagnostic-semantics', detail: 'The PowerShell Node wrapper preserves child code 7 in exception prose but exposes shell exitCode 1. Failure is correctly signaled; the original code is not structured.' });
    }
    if (result.id === 'work-maintenance-review-long') {
      const succeeded = (name, text) => conversation.tools.some(t => t.name === name && t.status === 'success' && t.result?.includes(text));
      const oracle = JSON.parse(readFileSync(join(root, `${result.repeat}-${result.id}`, 'artifact-oracle.json'), 'utf8'));
      const intact = !conversation.tools.some(t => ['error', 'interrupted', 'denied', 'cancelled'].includes(t.status));
      const exactArtifact = oracle.actual.replaceAll('\r\n', '\n').trimEnd() === oracle.expected;
      if (intact && exactArtifact && succeeded('code_grep', '') && succeeded('code_read', 'add') && succeeded('code_bash', 'VERIFIED=42') && succeeded('work_history', 'VERIFIED=42') && succeeded('review_project_changes', 'src/add.mjs')) {
        const originalLength = failures.length;
        failures = failures.filter(f => f !== 'Missing expected tool outcome: code_glob');
        if (failures.length !== originalLength) reviewNotes.push({ classification: 'oracle', detail: 'Successful grep located the source file; a redundant standalone find is unnecessary. Exact artifact, unchanged test execution, saved native verification and change review all passed. This does not count as live find-tool coverage.' });
      }
    }
    return { ...result, originalPassed: result.passed, passed: !failures.length, failures, reviewNotes };
  });
  const review = { ...summary, reviewVersion: 1, reviewedAt: new Date().toISOString(), source: basename(root), originalPassed: summary.passed, passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed).length, results: cases };
  review.configuration = { contextTokens: manifest.bounds.contextTokens, outputTokens: manifest.bounds.outputTokens, effort: manifest.effort };
  const baseline = cases.find(c => c.id === 'chat-baseline');
  if (baseline) {
    const payload = JSON.parse(readFileSync(join(root, `${baseline.repeat}-${baseline.id}`, 'requests/1.json'), 'utf8'));
    const tools = structuredClone(payload.tools ?? []), bytes = value => Buffer.byteLength(JSON.stringify(value));
    const schemaBytes = bytes(tools);
    for (const tool of tools) { const properties = tool.function?.parameters?.properties; if (properties) { delete properties.status; delete properties.permission; } }
    const browserTools = payload.tools.filter(tool => tool.function?.name?.startsWith('browser_'));
    review.baselineSchemas = { toolCount: tools.length, schemaBytes, browserToolCount: browserTools.length, browserSchemaBytes: bytes(browserTools), hypotheticalUiMetadataRemovalBytes: schemaBytes - bytes(tools), note: 'Hypothetical byte reduction only; removing metadata changes model-generated activity/approval text and requires a UX decision.' };
  }
  writeFileSync(join(root, 'review.json'), JSON.stringify(review, null, 2));
  return review;
});
const output = resolve('artifacts/harness-audit'); mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'comparison.json'), JSON.stringify(reviewed, null, 2));
const markdown = ['# Reviewed harness comparison', '', 'Original run results remain unchanged. review.json applies evidence-based oracle corrections and the stricter structured-exit-code assertion.', '', '| Run | Model | Context/output | Cases | Reviewed pass | Requests | Reported USD |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |', ...reviewed.map(r => `| [${r.source}](${r.source}/REPORT.md) | ${r.model}${r.live ? '' : ' (fixture)'} | ${r.configuration.contextTokens}/${r.configuration.outputTokens} | ${r.executed}/${r.planned} | ${r.passed} | ${r.requests} | ${r.costReportingComplete ? r.reportedCostUsd.toFixed(8) : r.live ? 'incomplete' : '0 (fixture)'} |`), '', ...reviewed.flatMap(r => r.results.filter(c => c.failures.length || c.reviewNotes.length).map(c => `- **${r.source} / ${c.id} #${c.repeat}**: ${[...c.failures, ...c.reviewNotes.map(n => `${n.classification}: ${n.detail}`)].join(' ')}`))];
writeFileSync(join(output, 'COMPARISON.md'), markdown.join('\n'));
console.log(markdown.join('\n'));
