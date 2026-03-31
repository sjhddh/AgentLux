# Master-Crop (AgentSkill) 📸

An open-source OpenClaw AgentSkill that turns any AI agent into a master photographer. 

It takes poorly framed user photos, analyzes them via Vision-Language Models (VLM) for geometric composition (Rule of Thirds, Golden Ratio), and physically recrops them using `sharp`. 

### 🔥 Zero-Retention Architecture
Privacy and storage efficiency are paramount. Master-Crop implements a **Zero-Retention Memory System**:
1. The image is loaded into a memory buffer.
2. The original file is *immediately unlinked/deleted* from the disk.
3. The cropped artifact is returned to the agent strictly as a Base64 Data URI.
4. Result: Zero disk footprint.

### Usage in OpenClaw
```javascript
const result = await master_crop({ 
    image_path: "/tmp/user_upload_123.jpg", 
    delete_after: true 
});
// The agent receives the Data URI and streams it back to the user.
```
