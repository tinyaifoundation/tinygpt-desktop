globalThis.fetch = async () => { throw new Error('Network is blocked by the offline verification fixture.'); };
require('../out/main/embedding-worker.js');
