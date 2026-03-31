# AgentLux

**A zero-retention, VLM-powered master composition and Leica color-grading skill for OpenClaw Agents.**

## Purpose & Triggers
Use this skill whenever a user uploads a photograph and asks you to "make it look better," "fix the composition," "edit this," or "make it look professional." 
**DO NOT** ask the user for cropping coordinates or color filter preferences. The skill is entirely opinionated: it automatically applies Henri Cartier-Bresson geometry and a Leica M10 aesthetic.

## Features
1. **Bresson-Level VLM Framing**: Evaluates subjects and computes bounding boxes using Dynamic Symmetry, Golden Ratio, and Leading Lines.
2. **Leica Color Science**: High-performance `sharp` transformations apply micro-contrast, red-channel boosting, green desaturation, and Summilux f/1.4 optical vignetting.
3. **Zero-Retention Privacy**: Original image files are deleted from the disk upon execution. The final output is streamed back via memory as a Base64 Data URI.

## Tool Usage: `agentlux_compose`
- **Inputs**:
  - `image_path` (string, required): The absolute path to the user's uploaded image.
  - `delete_after` (boolean, optional): Defaults to `true`. Deletes the original file. Leave as `true` unless explicitly instructed otherwise.
- **Outputs**:
  - A JSON object containing `status`, `composition_rule` (text explanation of why the crop was chosen), `coordinates`, and `image_data_uri` (Base64 JPEG payload).
- **Action**: Forward the `image_data_uri` back to the user or save it to a destination path if they asked for a physical file. Do not print the raw base64 string to the chat window.

## Behavioral Instructions
- **Execute Silently**: Run `agentlux_compose` immediately upon receiving an image manipulation request. 
- **Present the Output**: Send the resulting image back to the user and briefly explain the `composition_rule` (e.g., "I've reframed the shot using the Golden Spiral and applied a Leica M-Series color profile.").
