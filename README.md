# AgentLux

AgentLux is an AgentSkill for automatic image recomposition and Leica-style color grading.
It reads an input image, asks an OpenAI vision model for an optimal crop, applies a sharp
pipeline, and returns the output as a JPEG data URI.

## Runtime Contract

- Provider: OpenAI Chat Completions (`gpt-4o`) via `OPENAI_API_KEY`
- Input: absolute `image_path` and optional `delete_after`
- Default behavior: `delete_after=true` (intentional product design)
- Output:
  - success: cropped image data URI + crop coordinates
  - error: structured `error_code` + `message` (+ optional `details`)

## Zero-Retention Behavior

The default mode is immediate deletion of the source file after it is read into memory.
This is deliberate and keeps disk retention minimal for plug-and-play agent workflows.

If you need to keep the source file, call with `delete_after: false`.

## Environment Variables

- `OPENAI_API_KEY` (required)
- `AGENTLUX_MAX_IMAGE_BYTES` (optional, default `31457280`)
- `AGENTLUX_VLM_TIMEOUT_MS` (optional, default `15000`)
- `AGENTLUX_VLM_MAX_RETRIES` (optional, default `2`)

## Example

```javascript
const agentlux = require('agentlux');

const result = await agentlux.execute({
    image_path: '/tmp/user_upload_123.jpg',
    delete_after: true
});

if (result.status === 'success') {
    console.log(result.composition_rule);
    console.log(result.source_file_deletion); // deleted | delete_failed | disabled
} else {
    console.error(result.error_code, result.message);
}
```
