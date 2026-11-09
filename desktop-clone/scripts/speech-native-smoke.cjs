// Real pinned Pocket TTS binary, model, streaming and cancellation; no speaker output.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..'), stage = path.join(root, '.test-profile/pocket-native'); fs.mkdirSync(stage, { recursive: true });
buildSync({ stdin: { contents: "export {PocketTTS} from './src/main/pocket-tts';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(stage, 'speech.cjs') });
const { PocketTTS } = require(path.join(stage, 'speech.cjs'));
const speech = new PocketTTS(path.join(root, 'runtimes/voice'), stage);
(async () => {
  try {
    let begin = performance.now(); await speech.warm(); const warmMs = Math.round(performance.now() - begin);
    const controller = new AbortController(), text = 'Read aloud should start speaking before the whole answer has finished generating. The next words arrive while you listen. '.repeat(8);
    begin = performance.now(); const stream = speech.stream(text, 'alba', controller.signal), first = await stream.next(), firstChunkMs = Math.round(performance.now() - begin);
    assert.equal(first.done, false); assert.equal(first.value.sampleRate, 24000); assert.ok(first.value.audio.length > 0); assert.equal(first.value.audio.length % 2, 0);
    controller.abort(); await assert.rejects(stream.next()); await stream.return();
    let chunks = 0, bytes = 0; begin = performance.now();
    for await (const chunk of speech.stream('Ready to speak again.', 'marius', AbortSignal.timeout(30000))) { chunks++; bytes += chunk.audio.length; }
    assert.ok(chunks > 1); assert.ok(bytes > 4800);
    console.log(JSON.stringify({ result: 'passed', warmMs, firstChunkMs, firstChunkSeconds: first.value.audio.length / 48000, streaming: true, cancelled: true, differentVoiceChunks: chunks, audioSeconds: bytes / 48000, nextVoiceMs: Math.round(performance.now() - begin) }));
  } finally { speech.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
