import { z } from 'zod';

const assetPath = z.string().regex(/^(?:voice-runtime|rag|vision)\/[A-Za-z0-9_.\/-]+\.(?:gguf|onnx|ort|safetensors|bin)$/i).refine(value => !value.split('/').some(part => !part || part === '.' || part === '..'));
export const modelAssetSchema = z.object({ path: assetPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(32 * 1024 ** 3) }).strict();
export const modelAssetsSchema = z.object({ version: z.literal(1), files: z.array(modelAssetSchema).min(1).max(500) }).strict().refine(value => new Set(value.files.map(file => file.path.toLowerCase())).size === value.files.length, 'Duplicate model asset path');
export type ModelAsset = z.infer<typeof modelAssetSchema>;
export type ModelAssets = z.infer<typeof modelAssetsSchema>;
