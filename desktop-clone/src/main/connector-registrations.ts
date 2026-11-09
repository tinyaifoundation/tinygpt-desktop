import { z } from 'zod';
import registrations from './connector-registrations.json';
import type { ConnectorKind, PluginCredentials } from '../shared/plugins';

const registration = z.object({ clientId: z.string().max(500), releaseStatus: z.enum(['unconfigured', 'testing', 'review', 'production']) }).strict();
export const connectorRegistrationsSchema = z.object({ google: registration, github: registration, slack: registration }).strict();
// Public native-client identifiers only. Never bundle confidential web-client
// secrets, personal tokens, refresh tokens, or a developer's account grant.
export const connectorRegistrations = connectorRegistrationsSchema.parse(registrations);
export function connectorRegistration(kind: ConnectorKind): PluginCredentials['connectorAuth'] | undefined {
  const provider = kind === 'github' ? 'github' : kind === 'slack' ? 'slack' : 'google';
  const { clientId } = connectorRegistrations[provider];
  return clientId ? { provider, clientId } : undefined;
}
