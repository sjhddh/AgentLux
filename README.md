# AgentLux 🔴📸

An open-source **AgentSkill** that imbues autonomous AI vision models with the soul of a Leica and the geometric discipline of Henri Cartier-Bresson.

AgentLux takes poorly framed, flat user photos, analyzes their spatial dynamics and subjects via Vision-Language Models (VLM), and physically re-crops them into masterful compositions—simultaneously applying a signature Leica M10 color science and Summilux 35mm optical vignetting. All of this happens autonomously, in memory, in less than a second.

### 🌟 Key Features
- **The Decisive Moment Framing**: Instructs VLM logic using classical photojournalism principles (Dynamic Symmetry, Golden Ratio, Leading Lines).
- **Leica M-Series Color Science**: Mathematical `recomb` matrices shift colors (rich reds, muted greens) while `linear` S-curves create an unmistakable filmic micro-contrast.
- **Summilux Lens Falloff**: A mathematically applied `multiply` optical vignette highlights the focal subject dynamically.

### 🔥 Zero-Retention Architecture
Privacy and storage efficiency are paramount. AgentLux implements a strict **Zero-Retention Memory System**:
1. The image is loaded into an ephemeral memory buffer.
2. The original file is *immediately unlinked/deleted* from the disk to preserve privacy.
3. The cropped, color-graded artifact is returned to the agent strictly as a Base64 Data URI.
4. **Result**: Zero disk footprint. A purely functional digital darkroom.

### 🛠️ Agent Implementation (Node.js / OpenClaw)
Once installed in your OpenClaw environment, your agent can call the skill natively:
```javascript
const result = await agentlux_compose({ 
    image_path: "/tmp/user_upload_123.jpg", 
    delete_after: true 
});

// The agent receives the Data URI and streams it directly back to the user.
console.log(result.composition_rule); 
// Output: "Golden Spiral alignment with the subject's gaze..."
```

### 📦 Installation
Available via [ClawHub](https://clawhub.com).
```bash
clawhub install agentlux
```
