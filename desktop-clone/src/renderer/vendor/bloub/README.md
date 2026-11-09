# Bloub animation engine

Vendored from https://github.com/jeremy-prt/bloub at commit
`b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`, under the MIT license in LICENSE.
The framework-independent source files are unmodified. TinyGPT's React host is
`../../components/BloubIcon.tsx`: blue `nuage` (cloud), idle gaze drift and blinking,
alternating the original neutral and attentive expressions every four seconds
with the engine's smooth transitions. The sidebar cloud is 20px. Playback runs at
30 fps, pauses while hidden, and uses a static neutral pose for reduced motion. No network,
Vue runtime, remote asset, or additional animation dependency is required.
