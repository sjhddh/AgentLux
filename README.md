# AgentLux 🔴📸

An open-source OpenClaw AgentSkill that imbues AI vision models with the soul of a Leica and the geometric discipline of Henri Cartier-Bresson.

AgentLux takes poorly framed user photos, analyzes their spatial dynamics via Vision-Language Models (VLM), and physically re-crops them into masterful compositions (Rule of Thirds, Golden Triangle, Dynamic Symmetry, "The Decisive Moment" framing) using `sharp`.

### 🔥 Zero-Retention Architecture
Privacy and storage efficiency are paramount. AgentLux implements a strict **Zero-Retention Memory System**:
1. The image is loaded into an ephemeral memory buffer.
2. The original file is *immediately unlinked/deleted* from the disk.
3. The cropped artifact is returned to the agent strictly as a Base64 Data URI.
4. Result: Zero disk footprint. A purely functional darkroom.

### Usage in OpenClaw
```javascript
const result = await agentlux_compose({ 
    image_path: "/tmp/user_upload_123.jpg", 
    delete_after: true 
});
// The agent receives the Data URI and streams it back to the user.
```
