# Third-party notices

## Chrome DevTools MCP

Chrome DevTools MCP 1.12.0 is distributed under Apache-2.0. Its original license
and bundled third-party notices remain in `node_modules/chrome-devtools-mcp`.
Source: https://github.com/ChromeDevTools/chrome-devtools-mcp .
The integration uses an installed Chrome/Chromium browser with a dedicated profile;
it does not connect to TinyGPT's privileged renderer or the user's browser profile.

## Optional built-in Pro model

TinyGPT Pro downloads Ternary Bonsai 2 27B Q2_0 and its Q8_0 vision projector from Prism ML's immutable
revision `94dd51cdbbec5309ed8b76a12f3268bc4fdceb93`, under Apache-2.0.
Source: https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf .
The original license and notice, including the Qwen3.8-27B attribution, are
retained in `licenses/bonsai-2/LICENSE` and `licenses/bonsai-2/NOTICE.txt`.
Downloaded official llama.cpp runtime archives retain their original notices.
Optional response acceleration downloads the separate Qwen3.8-27B Q4_0 MTP head
from ggml-org/Qwen3.8-27B-GGUF revision `a316ea527fde32c12487be7574e2db5ac2ad2a7e`,
under Apache-2.0. Source and checksum are retained in `licenses/bonsai-2/MTP-NOTICE.txt`.

TinyGPT uses open-source dependencies. Their license files remain with the packaged dependencies. A complete distribution license inventory is a release gate.

## Remote chat QR codes

Remote pairing uses `qrcode` 1.5.4 (MIT). Its original license is retained in the
packaged dependency at `node_modules/qrcode/license`.

## Solar Icons

Interface icons use [Solar Icons](https://solar-icons.dev/) by
[480 Design](https://www.figma.com/community/file/1166831539721848736), under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The React package
is by Saoudi Hakim under MIT. License texts are bundled in `licenses/solar-icons`.
The icons are mapped to application controls, resized, recolored and, where
needed, rotated or mirrored.

## Pi Work runtime

Work uses `@earendil-works/pi-coding-agent` 1.5.0 and its runtime dependencies. Pi is MIT licensed, copyright (c) 2025 Mario Zechner. Source: https://github.com/earendil-works/pi . The original MIT text is retained in `licenses/pi-MIT.txt`. Pi's native tools and execution loop are used with TinyGPT provider, permission, session and UI adapters. OpenCode supplies the delegated coding runtime, covered below. Chat retains its LibreChat agent engine.

Native Work search uses official ripgrep 15.2.0 (MIT/Unlicense) and fd 10.5.0 (MIT/Apache-2.0) release binaries. Versions and archive checksums are pinned in `scripts/work-tools.json`. Their original license texts are included beside the binaries under the `work-tools/licenses` application resource. Sources: https://github.com/BurntSushi/ripgrep and https://github.com/sharkdp/fd .

## On-device dictation

The Composer Voice interface is adapted from assistant-ui Elements (MIT),
copyright 2026 AgentbaseAI Inc. Source:
https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/react/assistant-ui/elements/composer.tsx .
Its MIT license is included at `out/renderer/licenses/assistant-ui-LICENSE.txt`.

NVIDIA NeMo-Speech.cpp `0.2.0` (Apache-2.0) is bundled as a native runtime.
Official release: https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.2.0 .
Platform archive checksums are pinned in `scripts/dictation-runtime.json`.
Original runtime and dependency licenses are retained under
`dictation/nemo-speech-*/share/licenses/nemo-speech/` in application resources.

Nemotron 3.5 ASR Streaming 0.6B, Q8_0, is downloaded and verified during build
preparation, then included in application resources. Its immutable revision,
size, and SHA-256 are pinned in `src/shared/dictation-model.json`. Model and license:
https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b .
The weights are governed by OpenMDW-1.1: https://openmdw.ai/license/1-1/ .
The pinned model card and license are bundled alongside the weights.

## Historical OpenClaw development proof

The development checkout may retain the pinned OpenClaw 2026.9.9 runtime and
its bundled Node 24.19.0 for historical proof scripts. Bot now uses the Pi SDK
already shipped for Work. OpenClaw, its private Node, and its runtime dependency
tree are excluded from the current desktop build and installer resources.
Original notices remain alongside any retained development copies.

## Interface color picker

The custom interface color picker uses `react-colorful` 5.6.1 (MIT), by
Vladislav Ogurtsov, inside TinyGPT's ShadCN/Radix popover and input components.
Source: https://github.com/omgovich/react-colorful . Its original MIT license is
bundled at `renderer/licenses/react-colorful-LICENSE.txt`.

## Interface fonts

Inter (`@fontsource/inter` 5.3.0), Geist, Figtree, Public Sans, Manrope, Roboto,
DM Sans, and Plus Jakarta Sans (their respective `@fontsource-variable` 5.3.0
packages) are bundled as local interface fonts. Each package's original license
is also copied to `out/renderer/licenses/fonts` in the built app. Sources and
family metadata: https://fontsource.org/fonts .

The optional Satoshi font is excluded from the open-source source distribution and new builds because its redistribution terms differ from the open font licenses above. Stored Satoshi preferences migrate to Figtree.

## Local memory and embeddings

`@huggingface/transformers` 4.3.1 (Apache-2.0), including its pinned ONNX Runtime and tokenizer dependencies, performs local CPU feature extraction in a supervised process. Its license remains in the packaged dependency. Source: https://github.com/huggingface/transformers.js

TinyGPT bundles the quantized `Xenova/bge-small-en-v1.5` ONNX conversion of BAAI's `bge-small-en-v1.5` (MIT). Original model: https://huggingface.co/BAAI/bge-small-en-v1.5 . Conversion: https://huggingface.co/Xenova/bge-small-en-v1.5 . The upstream MIT license is included in `licenses/BGE-MIT.txt`.

TinyGPT bundles `cross-encoder/ettin-reranker-17m-v1` (Apache-2.0), by Tom Aarsen and the Sentence Transformers contributors, with the Ettin ModernBERT backbone from Johns Hopkins University. The published ONNX encoder and all three classification-head weight files are used without modification. Model: https://huggingface.co/cross-encoder/ettin-reranker-17m-v1 . License: `licenses/Ettin-Apache-2.0.txt`. TinyGPT's inference adapter applies the published CLS, Dense/GELU, LayerNorm and Dense scoring modules. Immutable revisions, file sizes and SHA-256 checksums for both models are recorded in `src/shared/rag-models.json`. Runtime inference never downloads weights.

`sqlite-vec` 0.1.9, copyright (c) 2024 Alex Garcia, supplies native vector indexing in the retrieval utility process. Distributed under its MIT license option, included in `licenses/sqlite-vec-MIT.txt`. Source: https://github.com/asg017/sqlite-vec . Native binaries retain the upstream package version and license metadata.

`ignore` 7.0.5 (MIT), by kael, applies Project-folder ignore rules. Its license remains in the packaged dependency. Source: https://github.com/kaelzhang/node-ignore

## PDF.js

Package: `pdfjs-dist` 6.4.299, Mozilla PDF.js. Source: https://github.com/mozilla/pdf.js

Licensed under Apache License 2.0. The package's `LICENSE` remains in its distribution. See https://www.apache.org/licenses/LICENSE-2.0 for terms. PDF.js is used for local extraction of existing PDF text. Optional canvas/native dependencies retain their own notices and require a platform-specific distribution check.

## LibreChat agents

Package: `@librechat/agents` 4.0.4
Source: https://github.com/LibreChat-AI/agents

MIT License

Copyright (c) 2024 LibreChat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## MCP and plugin parsing

TinyGPT uses `@modelcontextprotocol/sdk` 1.32.1 (MIT), `ajv` 8.20.0 (MIT), and `yaml` 2.9.1 (ISC). Original license texts follow and remain in the distributed packages.

### @modelcontextprotocol/sdk

MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


### ajv

The MIT License (MIT)

Copyright (c) 2015-2021 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.



### yaml

Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.



## OpenCode and saved diffs

`opencode-ai` and `@opencode-ai/sdk` 1.18.35 (MIT), Copyright (c) 2025 opencode. The platform binary packages retain their included dependencies and upstream notices. Source: https://github.com/anomalyco/opencode . Their MIT permission and warranty terms are the same as the MIT text reproduced above, with this copyright holder.

`diff` 9.0.0 (BSD-3-Clause), Copyright (c) 2009–2015 Kevin Decker, renders saved before/after changes. Source: https://github.com/kpdecker/jsdiff . Its full LICENSE remains in the packaged dependency.

BSD 3-Clause License

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


## Workspace terminal

`@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0 and `@xterm/addon-search` 0.16.0 provide terminal rendering, sizing and search. Source: https://github.com/xtermjs/xterm.js . Their MIT licenses remain with the packaged dependencies.

Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


`ws` 8.22.0 supplies the main-process authenticated local terminal transport. Source: https://github.com/websockets/ws . Its MIT license remains with the packaged dependency.

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


## Voice clone model changes

Computer-use components: Cua Driver/SDK 0.38.0 (MIT), with the UniFFI JavaScript/N-API binding runtime 0.31.0-3 (MPL-2.0). Full license texts, source locations and the Electron compatibility-runtime notice are under licenses/computer and beside the bundled native module. The optional perception extension is not included.

This clone bundles official OpenBMB MiniCPM5 2B Q4_K_M (Apache 2.0), Moonshine Medium Streaming English via Moonshine Voice 0.1.5 (MIT and third-party notices), and Kyutai Pocket TTS v4.0.1 standalone runtime (MIT), English October 2026 model and voice embeddings (CC BY 4.0). Pocket TTS replaces Kokoro in the active bundle. Pocket source: https://github.com/kyutai-labs/pocket-tts/tree/v4.0.1; bundled model/voices: https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/tree/a7056f505a4a8ca72d8b5fb1440071d6f1a35739. Model configuration paths are adapted to local bundled files. Voice/model licenses, model card and source links are under licenses/voice. MiniCPM and Moonshine assets are pinned in scripts/voice-assets.lock.json; Pocket assets are pinned in scripts/pocket-assets.lock.json. The original Nemotron dictation runtime/model is replaced in this clone and is not bundled. The original desktop’s other dependencies and features remain present.


## Bundled local image understanding

SmolVLM-256M-Instruct (Hugging Face) is bundled as the ggml-org Q8_0 language and vision-projector GGUFs under Apache 2.0. Source: https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct. GGUF revision and SHA-256 pins: src/shared/vision-model.json. License: licenses/SmolVLM-Apache-2.0.txt. Inference reuses the existing bundled llama.cpp runtime.

## Calculator and visual chat outputs

The built-in calculator uses mathjs 15.2.0 (Apache-2.0). Visual chat outputs
use @json-render/core and @json-render/react 0.21.4 by Vercel (Apache-2.0).
Original license files remain in the packaged dependencies. The semantic chat
components are implemented by TinyGPT; Assistant UI is retained for conversation
rendering and read compatibility with previously saved presentation trees.

- @block65/webcrypto-web-push 2.0.0 (MIT) supplies RFC 8291 encryption and VAPID signing in the remote relay. License: licenses/webcrypto-web-push-MIT.txt.
- uint8array-extras (MIT), used by the Web Push relay. License: licenses/uint8array-extras-MIT.txt.

## Remote Control end-to-end encryption

noise-handshake 4.2.0 (Apache-2.0, Holepunch) implements the Noise handshake. Sodium native supplies desktop cryptographic operations; sodium-javascript 0.8.0 (MIT) supplies browser operations. b4a and sodium-universal provide cross-platform byte handling and dispatch. Original license files remain in the installed dependencies; copied Noise and sodium-javascript licenses are under licenses/. No upstream implementation has been modified.

## Remote Control QR scanning

zxing-wasm 3.1.6 (MIT) supplies the WebAssembly wrapper for ZXing-C++ (Apache-2.0). The reader is served from TinyGPT's own origin and decodes camera frames and selected photos locally. Sources: https://github.com/Sec-ant/zxing-wasm and https://github.com/zxing-cpp/zxing-cpp. License texts: licenses/zxing-wasm-MIT.txt and licenses/zxing-cpp-Apache-2.0.txt. No upstream implementation has been modified.

## Local document ingestion

Scanned PDF/image extraction uses tesseract.js 6.0.1 and tesseract.js-core (Apache-2.0), the locally bundled @tesseract.js-data/eng 1.0.0 package (MIT), and @napi-rs/canvas 1.0.10 (MIT). Office archive extraction uses JSZip 3.10.2 under its MIT option; spreadsheet extraction uses the existing ExcelJS dependency (MIT). Original package licenses and third-party notices remain with the bundled dependencies. OCR language data is packaged for offline use. No gated voice-cloning model or exporter setup is provided.


## Bot avatar

The desktop bot avatar uses blob-avatar 2.2.0 by Michel Coleoni, Coleoni Soluções Digitais, under the MIT License. Source: https://github.com/c0le0ni/blob-avatar. License: licenses/blob-avatar-MIT.txt. The React renderer is bundled locally and works without fetching a hosted avatar script. No upstream source has been modified.

## Bundled Work command runtimes

Node.js 24.22.2 (MIT and included third-party notices) and npm/npx 11.19.1 are redistributed from the official Node.js distributions at https://nodejs.org/dist/v24.22.2/. The Node distribution's LICENSE and npm's LICENSE and dependency notices remain under Resources/work-runtimes/node in the packaged app. On Windows, the optional npm.ps1/npx.ps1 launchers are omitted in favor of the original .cmd launchers to support the default PowerShell policy.

CPython 3.13.18 is redistributed using Astral python-build-standalone release 20261026: https://github.com/astral-sh/python-build-standalone/releases/tag/20261026. Python's PSF license and bundled pip/dependency license files remain under Resources/work-runtimes/python. Windows additionally provides python3.exe as a copy of the Python executable. Build downloads for both supported platforms are pinned by SHA-256 in src/shared/work-runtimes.json. No Python, Node or npm source code is modified.
