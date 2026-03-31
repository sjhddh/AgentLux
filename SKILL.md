# AgentLux

A zero-retention, VLM-powered master composition skill for OpenClaw Agents. Inspired by the Leica 35mm aesthetic and Henri Cartier-Bresson's geometry.

## Features
- **Bresson-Level VLM Framing**: Leverages `gpt-4o` Vision capabilities instructed specifically in classical photojournalism geometry (Dynamic Symmetry, Golden Ratio, Leading Lines, The Decisive Moment).
- **High-Performance Crop**: Uses `sharp` to apply sub-millisecond, lossless physical crops based on the VLM's mathematical coordinates.
- **Zero-Retention Memory Management**: Files are read into memory buffers and immediately purged from the disk. The final image is returned purely as a Base64 Data URI payload, ensuring no permanent file footprint is left on the system.

## Agent Usage Instructions
1. Receive an image file path from the user.
2. Call the `agentlux_compose` tool with the file path (ensure `delete_after` is true).
3. The tool will parse the image, delete the original file, and return the optimal bounding box, the compositional rule applied (e.g., "Golden Spiral"), and the `image_data_uri`.
4. Forward the Data URI directly back to the user or save it strictly where requested.
