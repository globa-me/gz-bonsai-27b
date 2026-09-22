# Product

<!-- impeccable:product-schema 1 -->

## Platform

macOS desktop

## Stack

Tauri 2 desktop shell with React and TypeScript; Rust owns system diagnostics, downloads, runtime lifecycle, and communication with `llama-server`. The first supported target is macOS on Apple Silicon.

## Users

The primary user wants to run a capable local model at home without Terminal, Python, Git, or knowledge of inference runtimes. They need the app to explain what fits their Mac, download it safely, and make stopping or removing it predictable.

## Product Purpose

GZ Bonsai 27B turns the official PrismML model family and compatible llama.cpp runtime into an ordinary desktop experience: inspect the Mac, recommend a model and context conservatively, install it, and open a private local chat.

Success means a newcomer can reach a streamed local response and understand where the model lives, what it uses, and how to remove it.

## Positioning

This is a focused, transparent home for the Bonsai model family rather than a general-purpose model marketplace. Compatibility between each model artifact and its required runtime is curated by the app instead of delegated to the user.

## Operating Context

- Installed as a signed and notarized macOS app.
- Model files live in Application Support and remain local.
- Inference binds to `127.0.0.1` by default.
- Russian is the default product language; English is available.
- The app must remain useful offline after installation.

## Capabilities and Constraints

- Required core: hardware and storage diagnostics, model catalog, evidence-based recommendation, resumable verified downloads, install/remove, runtime lifecycle, health checks, streaming chat, local history, image input where supported, local document RAG, reasoning/context controls, and a local OpenAI-compatible endpoint.
- Version 0.4.0 bundles a signed PrismML runtime and installs curated GGUF files from the in-app catalog; manual paths remain an advanced option.
- The catalog exposes the binary 1-bit Bonsai 27B separately from ternary Bonsai 2 27B in both PTQ1_0 and PQ2_0 packings, so packaging names are not presented as model families.
- Ternary Bonsai 2 requires the PrismML llama.cpp fork; stock llama.cpp is not assumed compatible.
- Memory thresholds are hypotheses until measured on real Macs. The interface must distinguish a recommendation from a verified compatibility result.
- Opt-in web search is implemented. MCP tools, OpenCode, and Tailscale remain planned integrations, not MVP blockers.
- The first local RAG implementation uses bounded BM25 retrieval and explicit document citations. Semantic embeddings require a separately verified multilingual embedding artifact and measured memory impact before becoming a release dependency.
- Model weights must never be committed to Git.
- User secrets must eventually be stored in Keychain and never copied into diagnostic reports.

## Brand Commitments

- Product name: **GZ Bonsai 27B**.
- Primary mark: a flat forest-green rounded square with a white three-leaf bonsai; G, Z, and B are integrated into the leaves. The source is `src/assets/app-icon.svg`, with generated platform assets under `src-tauri/icons/`.
- Credit: “Разработано Геннадием Захаровым” / “Developed by Gennadiy Zakharov”.
- Author link: <https://zakharov.asia/>.
- The interface should feel at home on macOS and be as direct as ChatGPT, without copying ChatGPT or Jan literally.
- A prominent diagnostics button must create a safe, copyable report for troubleshooting.

## Evidence on Hand

- Product research and primary-source links are recorded in `README.md`.
- Current PrismML model metadata and runtime release checks are recorded in `docs/verified-artifacts.md`.
- A full native E2E has been run for Bonsai 1.7B: download, SHA-256 verification, Metal load, health check, and streamed Russian response.
- A native E2E has verified exact token usage and llama.cpp timing metadata for streamed Bonsai 1.7B responses.
- No independent performance measurements or compatibility matrix exists yet; future work must not fabricate them.

## Product Principles

1. Local privacy is the default, not a setting users must discover.
2. Recommendations explain their evidence and uncertainty.
3. Downloads and deletion are resumable, verifiable, and transparent.
4. Advanced integrations never complicate the first successful chat.
5. Diagnostics help support without exposing prompts, secrets, or personal file paths unnecessarily.

## Accessibility & Inclusion

Keyboard operation, clear focus states, sufficient contrast, reduced-motion support, and complete RU/EN localization are release requirements.
