# Computer-use runtime notices

TinyGPT Voice bundles Cua Driver 0.38.0 and its TypeScript SDK, from Cua release commit `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`, under the MIT license. See `Cua-MIT.txt` and <https://github.com/trycua/cua/tree/cua-driver-rs-v0.38.0/libs/cua-driver>.

The SDK depends on `@ubjs/core` and `@ubjs/node` 0.31.0-3, from James Hugman and contributors' UniFFI JavaScript bindings, under the Mozilla Public License 2.0. See `MPL-2.0.txt` and <https://github.com/jhugman/uniffi-bindgen-react-native>. The unmodified JavaScript package sources are included with the isolated SDK under `computer-runtime/sdk/node_modules/@ubjs`.

The platform package includes Cua's copy-mode `cua_driver_node_runtime.node`, derived from that MPL runtime for compatibility with Electron's memory cage. Its original `node-runtime-NOTICE.md` is included beside the binary. Corresponding source and deterministic modifications are available in the pinned Cua release, including <https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/scripts/build-node-runtime.mjs>. This component remains under MPL-2.0; it does not change the license of unrelated application files.

No optional perception extension, OmniParser detector, or additional computer-use model weights are bundled.
