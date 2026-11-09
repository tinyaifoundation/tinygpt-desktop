import { describe, expect, it } from 'vitest';
import { botDesignSchema } from '../src/renderer/lib/bot';
import { botAvatarPresentation } from '../src/renderer/lib/bot-avatar';

describe('saved avatar migration', () => {
  it.each([['square','squircle'],['teardrop','droplet'],['circle','circle'],['triangle','triangle']])('preserves the name and color when migrating %s to %s', (shape,expected) => {
    expect(botDesignSchema.parse({name:'Blobby',color:'#3b93f0',shape,roundness:72,antenna:'ring'})).toEqual({name:'Blobby',color:'#3b93f0',shape:expected,expression:'neutral'});
  });
  it('keeps new-library customization on reload', () => {
    const saved = {name:'Blobby',color:'#42977c',shape:'ghost',expression:'curious'};
    expect(botDesignSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it('rejects unrecognized shapes and unsafe colors instead of passing them to the renderer', () => {
    expect(botDesignSchema.safeParse({name:'Bot',color:'url(example)',shape:'circle'}).success).toBe(false);
    expect(botDesignSchema.safeParse({name:'Bot',color:'#ffffff',shape:'not-a-shape'}).success).toBe(false);
  });
});

it('restores the chosen resting face after a meaningful assistant state', () => {
  expect(botAvatarPresentation('blocked','happy')).toMatchObject({expression:'worried',animation:'question.2'});
  expect(botAvatarPresentation('waiting','happy')).toMatchObject({expression:'focused'});
  expect(botAvatarPresentation('idle','happy')).toMatchObject({expression:'happy'});
});
