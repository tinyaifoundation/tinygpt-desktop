import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  lstat,
  rename,
  copyFile,
  readdir,
  cp,
  chmod,
  access,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { resolve, join, basename } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  lockPath = join(root, "scripts/voice-assets.lock.json"),
  lock = JSON.parse(await readFile(lockPath, "utf8"));
const target = `${process.platform}-${process.arch}`,
  pins = lock.targets[target];
if (!pins) throw Error("Build on Windows x64 or Apple Silicon macOS 15+.");
const legacyCache = join(root, "../voice-app/.cache/files");
const cache = (await stat(legacyCache).catch(()=>null)) ? legacyCache : join(root, "runtimes/.voice-cache/files"),
  runtime = join(root, "runtimes/voice");
await mkdir(cache, { recursive: true });
await mkdir(runtime, { recursive: true });
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0x82f63b78 : n >>> 1;
  return n >>> 0;
});
async function inspect(file, crc = false) {
  const h = createHash("sha256");
  let c = 0xffffffff;
  for await (const bytes of createReadStream(file)) {
    h.update(bytes);
    if (crc) for (const b of bytes) c = (c >>> 8) ^ table[(c ^ b) & 255];
  }
  const cb = Buffer.alloc(4);
  cb.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return { sha256: h.digest("hex"), crc32c: cb.toString("base64") };
}
async function asset(pin, name) {
  const file = join(cache, name);
  if ((await stat(file).catch(() => null))?.size === pin.size) {
    const digest = await inspect(file, !pin.sha256);
    if (
      pin.sha256 ? digest.sha256 === pin.sha256 : digest.crc32c === pin.crc32c
    ) {
      if (!pin.sha256 && process.argv.includes("--record-hashes"))
        pin.sha256 = digest.sha256;
      return file;
    }
  }
  const part = file + ".part";
  console.log("Downloading", name);
  const r = await fetch(pin.url, { signal: AbortSignal.timeout(600000) });
  if (!r.ok || !r.body) throw Error(`Download failed: ${name} (${r.status})`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(part));
  const digest = await inspect(part, !pin.sha256);
  if (
    (await stat(part)).size !== pin.size ||
    (pin.sha256 ? digest.sha256 !== pin.sha256 : digest.crc32c !== pin.crc32c)
  )
    throw Error(`Checksum mismatch: ${name}`);
  if (!pin.sha256) {
    if (!process.argv.includes("--record-hashes"))
      throw Error("Missing SHA-256 pin; resolve asset lock first.");
    pin.sha256 = digest.sha256;
  }
  await rename(part, file);
  return file;
}
async function find(dir, name) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const v = await find(p, name);
      if (v) return v;
    }
  }
}
async function extract(archive, folder, zip) {
  await mkdir(folder, { recursive: true });
  if (zip) {
    if (process.platform === "win32") {
      const q = (s) => `'${s.replaceAll("'", "''")}'`;
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(folder)} -Force`,
        ],
        { windowsHide: true },
      );
    } else execFileSync("unzip", ["-qo", archive, "-d", folder]);
  } else execFileSync("tar", ["-xzf", archive, "-C", folder]);
}
const modelName = "MiniCPM5-2B-Q4_K_M.gguf",
  modelCache = join(cache, modelName),
  shared = join(
    process.env.APPDATA ?? "",
    "tinygpt-desktop/local-models/minicpm5-2b",
    modelName,
  );
if (
  !(await stat(modelCache).catch(() => null)) &&
  process.platform === "win32" &&
  (await stat(shared).catch(() => null))?.size === lock.model.size
) {
  console.log("Reusing existing MiniCPM download");
  await copyFile(shared, modelCache);
}
const model = await asset(lock.model, modelName);
await mkdir(join(runtime, "models"), { recursive: true });
if (
  (await stat(join(runtime, "models", modelName)).catch(() => null))?.size !==
    lock.model.size ||
  (await inspect(join(runtime, "models", modelName))).sha256 !==
    lock.model.sha256
)
  await copyFile(model, join(runtime, "models", modelName));
await mkdir(join(runtime, "moonshine-model"), { recursive: true });
for (const pin of lock.speech) {
  if (basename(pin.name) !== pin.name) throw Error("Invalid model asset path");
  const file = await asset(pin, "speech-" + pin.name);
  if (
    (await stat(join(runtime, "moonshine-model", pin.name)).catch(() => null))
      ?.size !== pin.size ||
    (await inspect(join(runtime, "moonshine-model", pin.name))).sha256 !==
      pin.sha256
  )
    await copyFile(file, join(runtime, "moonshine-model", pin.name));
}
const llamaZip = target.startsWith("win32"),
  llamaArchive = await asset(
    pins.llama,
    `llama-${target}.${llamaZip ? "zip" : "tar.gz"}`,
  ),
  llamaFolder = join(cache, `llama-${target}`);
await extract(llamaArchive, llamaFolder, llamaZip);
const exe = await find(
  llamaFolder,
  llamaZip ? "llama-server.exe" : "llama-server",
);
if (!exe) throw Error("Missing llama server");
await cp(resolve(exe, ".."), join(runtime, "llama"), {
  recursive: true,
  // An unchanged DLL can be in use by the running local model. Node's cp
  // unlinks destinations even when bytes match; avoid touching verified files.
  filter: async (source, destination) => {
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile()) return true;
    const destinationInfo = await stat(destination).catch(() => null);
    return !destinationInfo?.isFile() || sourceInfo.size !== destinationInfo.size || (await inspect(source)).sha256 !== (await inspect(destination)).sha256;
  },
  // Mach-O library aliases must stay relative to the shipped runtime, not this build cache.
  verbatimSymlinks: true,
});
if (!llamaZip) await chmod(join(runtime, "llama", "llama-server"), 0o755);
const moonArchive = await asset(pins.moonshine, `moonshine-${target}.zip`),
  moonFolder = join(cache, `moonshine-${target}`);
await extract(moonArchive, moonFolder, true);
const lib = await find(
  moonFolder,
  llamaZip ? "moonshine.dll" : "libmoonshine.dylib",
);
if (!lib) throw Error("Missing Moonshine library");
await mkdir(join(runtime, "moonshine"), { recursive: true });
for (const e of await readdir(resolve(lib, ".."))) {
  if (/\.(dll|dylib)$/.test(e)) {
    const source = join(resolve(lib, ".."), e), destination = join(runtime, "moonshine", e);
    if ((await inspect(destination).catch(() => null))?.sha256 !== (await inspect(source)).sha256) await copyFile(source, destination);
  }
}
if (process.argv.includes("--record-hashes"))
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
const files = [];
async function inventory(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await inventory(p);
    else if (e.isFile() && e.name !== "prepared.json")
      files.push({
        path: p.slice(runtime.length + 1).replaceAll("\\", "/"),
        size: (await stat(p)).size,
        sha256: (await inspect(p)).sha256,
      });
  }
}
await inventory(runtime);
await writeFile(
  join(runtime, "prepared.json"),
  JSON.stringify(
    {
      target,
      lockHash: createHash("sha256")
        .update(await readFile(lockPath))
        .digest("hex"),
      files,
    },
    null,
    2,
  ),
);
console.log(
  "Bundled offline MiniCPM + Moonshine Medium ready:",
  target,
  files.reduce((n, f) => n + f.size, 0),
  "bytes",
);
