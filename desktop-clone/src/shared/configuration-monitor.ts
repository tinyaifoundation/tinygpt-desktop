export type MonitorComponent = { id: string; name: string; pids: number[]; state: string; memoryBytes?: number };
export type ComponentMemory = { id: string; name: string; state: string; memoryBytes: number | null; graphicsBytes: number | null };
export type GraphicsReading = { id: string; name: string; totalBytes: number | null; usedBytes: number | null; activity: number | null; temperature: number | null };
export type ConfigurationMonitorSnapshot = {
  sampledAt: number;
  platform: string;
  unified: boolean;
  systemMemory: { totalBytes: number; usedBytes: number; pressure: 'normal' | 'elevated' | 'high' | null };
  graphics: GraphicsReading[];
  components: ComponentMemory[];
};
