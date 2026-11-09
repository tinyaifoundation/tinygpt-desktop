export type ManagedLocalStatus = {
  phase: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'starting' | 'running' | 'stopping' | 'error';
  message: string;
  downloaded?: number;
  total?: number;
  backend?: 'CUDA' | 'Vulkan' | 'CPU' | 'Metal';
  endpoint?: string;
  speculative?: boolean;
  installed?: boolean;
  ready?: boolean;
  modelId?: BuiltInModelId;
};
export type BuiltInModelId = 'included' | 'pro';
export function builtInAvailability(status: ManagedLocalStatus | undefined, selected: boolean, compatible: boolean): 'Active' | 'Ready' | undefined {
  if (!compatible || !status || !['idle', 'running'].includes(status.phase)) return;
  if (status.phase === 'running' && selected) return 'Active';
  if (status.ready) return 'Ready';
}
export const proModelRevision = '94dd51cdbbec5309ed8b76a12f3268bc4fdceb93';
export const builtInModels = {
  included: { id: 'tinygpt-included', name: 'TinyGPT', context: 65536, output: 8192, bytes: 1561318368, downloadBytes: 1561318368 },
  pro: { id: 'tinygpt-pro', name: 'TinyGPT Pro', context: 65536, output: 16384, bytes: 7626008928, downloadBytes: 8926462755, predictionBytes: 1680271776 },
} as const;
// Accept the previous managed alias when migrating saved connections.
export function builtInModelId(model: string): BuiltInModelId | undefined {
  if (model === 'MiniCPM5-2B' || model === builtInModels.included.id) return 'included';
  if (model === builtInModels.pro.id) return 'pro';
}
export const miniCPM = builtInModels.included;
export function builtInModelInfo(id: BuiltInModelId) {
  const model = builtInModels[id];
  return { id: model.id, name: model.name, contextWindowTokens: model.context, maxOutputTokens: model.output, tools: true, images: false,
    reasoning: { kind: 'llamacpp' as const, efforts: id === 'pro' ? ['medium' as const, 'xhigh' as const] : [], canDisable: true } };
}
export type BuiltInHardware = {
  checkedAt: string;
  includedSupported: boolean;
  proCompatible: boolean;
  status: 'compatible' | 'incompatible' | 'unknown';
  message: string;
  device?: { name: string; uuid: string; index: number; totalBytes: number; freeBytes: number };
};
export type BuiltInModelState = { hardware: BuiltInHardware; models: Record<BuiltInModelId, ManagedLocalStatus> };
