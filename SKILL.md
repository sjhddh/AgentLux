# AgentLux

**A zero-retention, VLM-powered master composition and Leica color-grading skill for OpenClaw Agents.**

## ⚠️ Mandatory Installation (NPM)
To ensure you are using the latest runtime and behavior contract, install AgentLux via NPM.

If the module is not present in your environment, install it first:
```bash
npm install agentlux
```
*(Or `npm install -g agentlux` for global access).*

## Purpose & Triggers
Use this skill whenever a user uploads a photograph and asks you to "make it look better," "fix the composition," "edit this," or "make it look professional." 
**DO NOT** ask the user for cropping coordinates or color filter preferences. The skill is entirely opinionated: it automatically applies Henri Cartier-Bresson geometry and a Leica M10 aesthetic.

## Features
1. **Bresson-Level VLM Framing**: Evaluates subjects and computes bounding boxes using Dynamic Symmetry, Golden Ratio, and Leading Lines.
2. **Leica Color Science**: High-performance `sharp` transformations apply micro-contrast, red-channel boosting, green desaturation, and Summilux f/1.4 optical vignetting.
3. **Zero-Retention Privacy**: Original image files are deleted from disk by default (`delete_after: true`). The final output is streamed via memory as a Base64 Data URI.

## Provider and Environment
- Current provider implementation: **OpenAI only**
- Required key: `OPENAI_API_KEY`
- Optional runtime controls:
  - `AGENTLUX_MAX_IMAGE_BYTES`
  - `AGENTLUX_VLM_TIMEOUT_MS`
  - `AGENTLUX_VLM_MAX_RETRIES`

## Tool Usage
Write and execute a temporary Node.js script using the official NPM package:

```javascript
const agentlux = require('agentlux');
const fs = require('fs');

async function run() {
    // 1. delete_after defaults to true (intentional zero-retention behavior)
    const result = await agentlux.execute({ 
        image_path: "/absolute/path/to/image.jpg", 
        delete_after: true 
    });
    
    if (result.status === 'success') {
        // 2. Convert Data URI back to a temporary file to send to the user
        const base64Data = result.image_data_uri.replace(/^data:image\/\w+;base64,/, "");
        const outPath = '/tmp/agentlux_output_' + Date.now() + '.jpg';
        fs.writeFileSync(outPath, base64Data, 'base64');
        
        console.log(JSON.stringify({ 
            status: "success", 
            rule: result.composition_rule, 
            file: outPath 
        }));
    } else {
        console.error(result.error_code, result.message);
    }
}
run();
```
*(Ensure `OPENAI_API_KEY` is exported in the environment).*

## Behavioral Instructions
- **Execute Silently**: Run the script immediately upon receiving an image manipulation request. 
- **Present the Output**: Send the resulting image back to the user and briefly explain the `composition_rule` returned by the tool (e.g., "I've reframed the shot using the Golden Spiral and applied a Leica M-Series color profile.").
