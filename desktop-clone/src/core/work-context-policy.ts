/** Static model/context sizing; Pi retains ownership of triggering and recovery. */
export function workContextPolicy(window: number, output: number, inputBudget = window - output) {
  const usable = Math.max(512, window - output);
  return {
    cleanupTriggerTokens: Math.floor(inputBudget * .85),
    cleanupTargetTokens: Math.floor(inputBudget * .60),
    compactionReserveTokens: window - Math.floor(inputBudget * .85),
    keepRecentTokens: Math.max(256, Math.min(10000, Math.floor(usable * .2))),
    summaryOutputTokens: Math.max(256, Math.min(4096, output, Math.floor(window * .125))),
    summaryInstructions: 'Keep the checkpoint concise, aiming for 1,000–2,000 visible tokens or less. Preserve unresolved work, exact references and outcomes. Use saved observation references instead of copying source bodies or file contents.',
  };
}
