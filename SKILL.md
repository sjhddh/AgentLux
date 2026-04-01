# AgentLux

**Leica master-photographer composition and color-grading skill.**

## When To Activate

Trigger this skill when the user does ANY of the following:
- Uploads a photo and asks to make it look better, professional, cinematic, or artistic
- Says "fix the composition," "crop this better," "edit this photo," "reframe this"
- Asks for a "Leica look," "film look," "德味" (German rendering), or "大师构图" (master composition)
- Provides multiple photos and wants the best one selected and improved
- Uploads a photo with no specific editing instructions (default to this skill)

**DO NOT ask the user for any preferences.** This skill is fully autonomous and opinionated.

## Prerequisites Check

Before first use, verify the module is installed and an API key is available:

```javascript
// Step 0: One-time installation check
const agentlux = require('agentlux');  // If this fails: npm install agentlux
// At least one of these env vars must be set:
// ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY
```

## Agent Workflow: Single Image

### Step 1 — Save the user's image to disk
If the user uploaded an image that is in memory or a temp location, ensure it is written to an absolute path on disk. Note the path.

### Step 2 — Execute the skill
Write and run a Node.js script. Use `output_path` to write the result directly to a file (recommended):

```javascript
const agentlux = require('agentlux');

async function run() {
    const result = await agentlux.execute({
        image_path: "ABSOLUTE_PATH_TO_INPUT",
        output_path: "/tmp/agentlux_output_" + Date.now() + ".jpg",
        delete_after: true
    });
    console.log(JSON.stringify(result));
}
run();
```

### Step 3 — Parse the result from stdout
The output is a single JSON object. Check `result.status`:

**On `"success"`:**
- `result.output_path` — The absolute path to the processed JPEG. **Send this file to the user.**
- `result.presentation` — A ready-to-use narrative explaining the creative decisions. **Show this text to the user.**
- `result.master_photographer` — e.g. "Fan Ho"
- `result.master_style` — e.g. "Light & Shadow Geometry"
- `result.composition_rule` — e.g. "Diagonal shaft of light creates a natural leading line..."
- `result.color_profile` — e.g. "Leica M Monochrom"
- `result.lens_profile` — e.g. "Noctilux-M 50mm f/0.95 ASPH"
- `result.coordinates` — The crop box applied `{x, y, width, height}`

**On `"error"`:**
- `result.error_code` — Machine-readable error type
- `result.message` — Human-readable description
- `result.recovery_hint` — **What YOU (the agent) should do next.** Follow this hint.

### Step 4 — Present to the user
1. Send the output image file (`result.output_path`)
2. Display `result.presentation` as the explanation
3. Optionally add your own commentary about the artistic choices

## Agent Workflow: Burst Mode

When the user provides multiple sequential images (e.g. burst photos, bracketed exposures):

```javascript
const result = await agentlux.execute({
    image_paths: [
        "/absolute/path/to/frame_001.jpg",
        "/absolute/path/to/frame_002.jpg",
        "/absolute/path/to/frame_003.jpg"
    ],
    output_path: "/tmp/agentlux_burst_output_" + Date.now() + ".jpg",
    delete_after: true
});
```

The system will auto-select the strongest frame, then compose and color-grade it. `result.burst_selection` contains:
- `selected_index` — Which frame was chosen (0-based)
- `total_images` — How many frames were evaluated
- `rationale` — Why this frame was selected

## Error Recovery Guide

| error_code | What happened | Agent action |
|---|---|---|
| `CONFIG_ERROR` | No API key configured | Tell user to set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY |
| `INPUT_ERROR` | Bad parameters | Fix the input (check file path exists, is absolute, etc.) |
| `INPUT_TOO_LARGE` | Image > 30MB | Resize the image before retrying |
| `VLM_TIMEOUT` | API call timed out | **Retry the same request** |
| `VLM_NETWORK_ERROR` | Network failure | **Retry the same request** |
| `VLM_HTTP_TRANSIENT` | API overloaded (5xx/429) | **Wait 3 seconds, then retry** |
| `VLM_HTTP_ERROR` | API client error (4xx) | Check API key and model configuration |
| `VLM_PARSE_ERROR` | Malformed VLM output | **Retry the same request** |
| `VLM_SCHEMA_ERROR` | Unexpected VLM format | **Retry the same request** |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | One of these | Anthropic Claude API key |
| `OPENAI_API_KEY` | is required | OpenAI GPT API key |
| `GOOGLE_API_KEY` | | Google Gemini API key |
| `AGENTLUX_CUSTOM_BASE_URL` | Optional pair | Custom OpenAI-compatible base URL |
| `AGENTLUX_CUSTOM_API_KEY` | | Custom API key |
| `AGENTLUX_CURATOR_MODEL` | Optional | Override curator model (e.g. `claude-sonnet-4-20250514`) |
| `AGENTLUX_MASTER_MODEL` | Optional | Override master model (e.g. `gpt-4o`) |

## What This Skill Does (For Context)

1. **Curator Agent** analyzes the image and selects the best-fit master photographer (Bresson, Alex Webb, Fan Ho, Koudelka, Salgado, Moriyama), Leica color profile (M10, M9, Monochrom, Tri-X, Portra), and lens character (Summilux, Noctilux, Summicron, Elmarit).
2. **Master Agent** embodies the selected photographer and computes the optimal crop.
3. **Image Pipeline** applies Leica color science, lens vignette + micro-contrast, and film grain.
4. Result is returned with a `presentation` narrative ready to show the user.
