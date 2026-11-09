const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createStore(filename) {
  let queue = Promise.resolve();
  async function load() {
    try {
      const value = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.replacements)) throw new Error('The saved change file has an unsupported format.');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, source: 'desktop-clone', updatedAt: null, replacements: [] };
      throw error;
    }
  }
  function mutate(operation) {
    const next = queue.then(async () => {
      const state = await load();
      operation(state);
      state.updatedAt = new Date().toISOString();
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const temporary = filename + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
        await fs.rename(temporary, filename);
      } finally { await fs.rm(temporary, { force: true }); }
      return state;
    });
    queue = next.catch(() => {});
    return next;
  }
  return { load, record: item => mutate(state => { state.replacements = state.replacements.filter(r => r.tool !== item.tool); state.replacements.push(item); }), remove: tool => mutate(state => { state.replacements = state.replacements.filter(r => r.tool !== tool); }) };
}
module.exports = { createStore };
