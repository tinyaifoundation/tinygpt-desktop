export function updateFeed(metadata, notes) {
  if (!/^\d+\.\d+\.\d+-prebeta\.\d+$/.test(metadata.version)) throw Error('Unexpected pre-beta version.');
  const root = `https://downloads.tinygpt.org/releases/${metadata.version}/`;
  const url = name => { if (!/^[\w.-]+$/.test(name) || name.includes('..')) throw Error('Invalid release filename.'); return root + name; };
  return { ...metadata, path: url(metadata.path), files: metadata.files.map(file => ({ ...file, url: url(file.url) })), packages: Object.fromEntries(Object.entries(metadata.packages).map(([arch, file]) => [arch, { ...file, path: url(file.path) }])), releaseNotes: notes.slice(0, 6000) };
}
