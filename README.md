# AgentLux

**用 Agent 给你的照片注入徕卡德味。**

One skill. Only Leica. Six master photographers. Zero compromise.

---

> **Agents**: Your operational instructions are in **[SKILL.md](SKILL.md)**. Read that file for the complete step-by-step workflow, trigger conditions, error recovery guide, and code templates. This README is the reference manual.

---

## Philosophy

AgentLux does one thing and does it with absolute conviction: it transforms any photograph into a Leica-grade image through the eyes of the world's greatest 35mm photographers. It does not ask the user what they want. It *knows*.

- **Only Leica.** Every color matrix, every vignette curve, every grain particle is calibrated to real Leica hardware: M10, M9 CCD, M Monochrom, M6 bodies; Summilux, Noctilux, Summicron, Elmarit glass.
- **Only Masters.** Bresson's decisive geometry. Alex Webb's layered color. Fan Ho's chiaroscuro. Koudelka's panoramic austerity. Salgado's monumental humanity. Moriyama's raw provocation. The system picks the right eye for your image.
- **Only Opinionated.** No sliders. No presets menu. No "which filter do you want?" The Curator Agent analyzes your image and makes every creative decision autonomously.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Input Image │────▶│  Curator Agent   │────▶│  Master Agent    │
│  (or Burst)  │     │  (Pass 1: VLM)   │     │  (Pass 2: VLM)   │
└─────────────┘     │                  │     │                  │
                    │  Selects:        │     │  Computes:       │
                    │  · Master style  │     │  · Crop box      │
                    │  · Color profile │     │  · Composition   │
                    │  · Lens character│     │    rule narrative │
                    └──────────────────┘     └────────┬─────────┘
                                                      │
                                                      ▼
                                          ┌──────────────────────┐
                                          │  Image Pipeline      │
                                          │  (sharp, no AI)      │
                                          │                      │
                                          │  · Precision crop    │
                                          │  · Leica color       │
                                          │    science (recomb)  │
                                          │  · Lens vignette +   │
                                          │    micro-contrast    │
                                          │  · Silver halide     │
                                          │    film grain        │
                                          └──────────┬───────────┘
                                                     │
                                                     ▼
                                          ┌──────────────────────┐
                                          │  Output              │
                                          │  · JPEG file or URI  │
                                          │  · presentation text │
                                          │  · full metadata     │
                                          └──────────────────────┘
```

For burst input, a **Selector Agent** runs before Pass 1 to pick the single strongest frame.

## Install

```bash
npm install agentlux
```

Entry point: `require('agentlux')` → `agentlux.execute({ ... })`

Agent skill instructions: **[SKILL.md](SKILL.md)**

## Quick Start

```javascript
const agentlux = require('agentlux');

const result = await agentlux.execute({
    image_path: '/tmp/photo.jpg',           // absolute path to input
    output_path: '/tmp/agentlux_out.jpg',   // where to write the output JPEG
    delete_after: true                       // zero-retention: delete input after loading
});

if (result.status === 'success') {
    // result.output_path  → send this file to user
    // result.presentation → show this narrative to user
} else {
    // result.recovery_hint → follow this to fix the error
}
```

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `image_path` | `string` | — | Absolute path to a single input image. Required unless `image_paths` is used. |
| `image_paths` | `string[]` | — | Absolute paths for burst mode. Mutually exclusive with `image_path`. |
| `output_path` | `string` | — | Absolute path to write output JPEG. If omitted, output is returned as `image_data_uri` (base64). **Recommended for agent workflows.** |
| `delete_after` | `boolean` | `true` | Delete original file(s) after loading into memory. |

## Success Response

| Field | Type | Description |
|---|---|---|
| `status` | `"success"` | |
| `presentation` | `string` | **Ready-to-show narrative** of all creative decisions. Show this to the user. |
| `output_path` | `string` | Path to output JPEG (only if `output_path` was provided) |
| `image_data_uri` | `string` | Base64 JPEG data URI (only if `output_path` was NOT provided) |
| `master_photographer` | `string` | e.g. `"Fan Ho"` |
| `master_style` | `string` | e.g. `"Light & Shadow Geometry"` |
| `master_rationale` | `string` | Why this master was chosen |
| `composition_rule` | `string` | The master's compositional explanation |
| `coordinates` | `object` | `{x, y, width, height, rule}` — the crop applied |
| `color_profile` | `string` | e.g. `"Leica M Monochrom"` |
| `color_rationale` | `string` | Why this color grade |
| `lens_profile` | `string` | e.g. `"Noctilux-M 50mm f/0.95 ASPH"` |
| `lens_rationale` | `string` | Why this lens character |
| `burst_selection` | `object` | (Burst only) `{selected_index, total_images, rationale}` |
| `source_file_deletion` | `string` | `"deleted"` / `"delete_failed"` / `"disabled"` |

## Error Response

| Field | Type | Description |
|---|---|---|
| `status` | `"error"` | |
| `error_code` | `string` | Machine-readable error type |
| `message` | `string` | Human-readable description |
| `recovery_hint` | `string` | **What the agent should do next** to resolve the error |
| `details` | `object\|null` | Additional context (e.g. HTTP status) |

## VLM Provider Configuration

AgentLux auto-detects the VLM provider from available API keys. Set at least one:

| Priority | Provider | API Key | Default Model |
|---|---|---|---|
| 1 (highest) | Custom | `AGENTLUX_CUSTOM_BASE_URL` + `AGENTLUX_CUSTOM_API_KEY` | configurable |
| 2 | Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| 3 | OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| 4 | Google | `GOOGLE_API_KEY` | `gemini-1.5-pro` |

Override the model for any agent role:

| Variable | Controls | Example |
|---|---|---|
| `AGENTLUX_CURATOR_MODEL` | Curator Agent (image analysis + style selection) | `claude-sonnet-4-20250514` |
| `AGENTLUX_MASTER_MODEL` | Master Agent (crop computation) | `gpt-4o` |
| `AGENTLUX_SELECTOR_MODEL` | Burst Selector (decisive moment) | defaults to curator model |

**Model names determine provider routing.** `claude-*` → Anthropic, `gpt-*` / `o1-*` / `o3-*` → OpenAI, `gemini-*` → Google, anything else → Custom API.

## Other Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENTLUX_MAX_IMAGE_BYTES` | `31457280` (30MB) | Maximum input image size |
| `AGENTLUX_VLM_TIMEOUT_MS` | `15000` | VLM request timeout |
| `AGENTLUX_VLM_MAX_RETRIES` | `2` | VLM retry count for transient errors |

## The Six Masters

| Key | Photographer | Style | Best For |
|---|---|---|---|
| `bresson` | Henri Cartier-Bresson | The Decisive Moment | Geometric tension, street moments, golden ratio |
| `webb` | Alex Webb | Complex Color Layering | Dense multi-layer scenes, saturated color |
| `fan_ho` | Fan Ho | Light & Shadow Geometry | Dramatic chiaroscuro, lone figures, architecture |
| `koudelka` | Josef Koudelka | Panoramic High-Contrast | Sweeping landscapes, stark geometry, wide frames |
| `salgado` | Sebastiao Salgado | Epic Human Documentary | Human dignity, environmental portraits, monumental |
| `moriyama` | Daido Moriyama | Provoke-Era Raw Street | Raw energy, blur, fragments, anti-classical |

## The Five Color Profiles

| Key | Profile | Character |
|---|---|---|
| `m10` | Leica M10 Digital | Warm, micro-contrast punch, slightly desaturated. The modern Leica digital look. |
| `m9_ccd` | Leica M9 CCD | Rich reds, warm shadows, filmic saturation. The legendary CCD 德味. |
| `m_monochrom` | Leica M Monochrom | High-contrast B&W with extreme tonal range. Fine sensor grain. |
| `m6_trix400` | M6 + Kodak Tri-X 400 | Gritty high-contrast B&W. Heavy film grain. Classic photojournalism. |
| `m6_portra400` | M6 + Kodak Portra 400 | Warm pastels, lifted shadows, beautiful skin tones. Fine grain. |

## License

MIT
