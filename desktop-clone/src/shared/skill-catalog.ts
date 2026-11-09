import catalog from './skill-catalog.json';
import { skillSourceSchema, type CatalogSkill } from './plugins';

// Metadata only. Instructions and resources come verbatim from pinned upstream
// commits on preview/install, never from authored starter templates.
export const skillCatalog: CatalogSkill[] = catalog.map(item => ({ ...item, modes: item.modes as CatalogSkill['modes'], invocation: item.invocation as CatalogSkill['invocation'], source: skillSourceSchema.parse(item.source) }));