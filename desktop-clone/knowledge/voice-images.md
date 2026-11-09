# Voice, images and media

Settings → Voice configures dictation and read aloud. These are separate from a model's ability to understand images or generate new images. A feature's presence in the interface does not establish that its runtime or provider is ready.

## Dictate a message

Choose the microphone, allow operating-system microphone access if requested, and use the composer microphone control. Bundled transcription turns speech into a draft on this computer; review the draft before sending. Microphone audio for bundled transcription stays local. Once sent, the resulting text goes to the selected inference connection. Transcription language is English in this interface. The speech model supplies punctuation/capitalization and manages phrase boundaries; noise reduction and echo reduction are configurable.

## Read an answer aloud

Enable Read aloud, choose Speech model and Voice, adjust Playback speed and use Try this voice. Completed answers expose read-aloud playback when enabled. Bundled speech and a connected speech provider have different data flows. A connected provider can receive the text to speak. Voice customization, where offered by the selected model, follows that setup flow; inspect its status rather than assuming all providers support the same voices.

## Understand or create an image

Attach an image and ask a focused question. Depending on the connection, image tools may use the selected vision model or a local helper. Extracted text and visual interpretation are different evidence; small labels, charts and measurements may need a focused crop or closer inspection. The assistant must acknowledge unreadable or omitted details.

Image generation requires an available configured image-generation connection/model and any applicable approval. Provider charges and network access can apply. Generated images are outputs, not proof of real-world facts. Do not assume that image support implies video generation or that every image format/export is available.
