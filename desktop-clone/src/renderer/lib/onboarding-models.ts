import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import { builtInModelId } from '../../shared/managed-local';

/** Optional Pro setup must not leave the default local model stopped on failure. */
export async function startWelcomePro(bridge: Pick<DesktopBridge, 'startBuiltInModel' | 'snapshot'>, update: (snapshot: AppSnapshot) => void) {
  try {
    const result = await bridge.startBuiltInModel('pro');
    if (!result.ok) throw new Error(result.error);
    update(result.value);
  } catch (error) {
    try {
      const fresh = await bridge.snapshot();
      if (fresh.ok && fresh.value.settings.route === 'local' && builtInModelId(fresh.value.settings.local.model) === 'included') {
        const restored = await bridge.startBuiltInModel('included');
        if (restored.ok) update(restored.value);
      }
    } catch { /* Keep the original setup error; Configuration remains available. */ }
    throw error;
  }
}
