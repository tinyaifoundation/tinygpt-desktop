# Models, connections and offline use

Open Settings → Configuration to choose and manage inference. Inference is the model that reads your request and produces a reply. TinyGPT includes local model setup and supports connected providers; available controls depend on the current build and device.

## Use built-in models

Find TinyGPT or TinyGPT Pro in Configuration and open its configuration panel. Use Check device and the displayed setup/status information before starting a model. Follow the panel's download or setup steps when needed. TinyGPT Pro is optional and requires a compatible device; it is not a guarantee that every computer can run it. Downloads and first-time preparation may need internet access.

The Configuration monitor shows graphics memory, system memory and supported GPU activity/temperature. Apple Silicon uses shared memory. Expand TinyGPT components to inspect allocations. High memory use can affect other applications. Keep local models loaded controls residency; Chat idle timeout controls when idle local chat and retrieval models release memory. A cold model may take longer to answer.

Graphics memory includes model weights, the context buffer and temporary working buffers; it is not the model's download size. The included model uses a 65,536-token context, so its running memory can be substantially larger than its approximately 1.56 GB model file. The monitor reports Windows process allocations; the device total also includes other apps and the system. A high number alone does not establish that two copies of a model are running.

On Windows, closing the last TinyGPT window stops TinyGPT's owned built-in model processes and waits for their exit before completing app shutdown. Model startup already in progress is canceled, queued starts are blocked during shutdown, and concurrent stop/restart requests wait for the previous process to exit. Reopening while TinyGPT is still closing does not start a second app instance. This cleanup targets only TinyGPT's own child processes, including their Windows subprocesses; it does not stop external Ollama, LM Studio or other local servers. Downloaded models and saved conversations are kept. Force-ending the app through the operating system is outside this graceful-shutdown path.

Pro's host prompt-snapshot budget adapts to available system RAM at startup. It can exceed 4 GiB to preserve a large Work prompt across image analysis, up to 16 GiB, while reserving 4 GiB plus half the remaining free RAM. This is a lazy host-memory limit, not a VRAM allocation. Low-memory machines may disable snapshots or still be unable to preserve a large state; numeric Diagnostics records show skipped snapshots when enabled. The model context window and configured output allowance are unchanged.

## Connect other models

Open Local models to discover models already served by Ollama, LM Studio or another compatible local server. That server must be running and configured appropriately. The current Configuration interface exposes built-in models, OpenRouter and Local models. Internal support for other provider protocols does not mean there is a visible sign-in/control for them in this interface. Choose a supported model and connection rather than assuming every model supports tools, images or reasoning. Effort controls affect reasoning only where the selected model supports it.

OpenRouter uses your connected account and credits. Model access selects free or broader model access. Cost tier affects Auto Router price ranges; higher tiers can cost more. Review the actual connection and model information before relying on cost assumptions. A consumer subscription to a different chat product does not itself establish API access in TinyGPT.

## Offline boundaries

Once required assets are installed, local inference, local handbook lookup and supported local transcription/retrieval can operate without a cloud inference account. Web research, remote connections, cloud models, connected accounts and downloads need their respective network services. A locally stored conversation can still send prompts and selected evidence to a cloud model when that connection is selected. Offline support does not mean every feature works without internet.
