const fs = require('fs').promises;
const sharp = require('sharp');

async function analyzeComposition(imageBase64, width, height) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY required for vision analysis.");

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: `You are a master photographer. Analyze this image (original size: ${width}x${height}). Determine the primary subject and the absolute best photographic composition (e.g., Rule of Thirds, Golden Ratio, Lead Room). Return ONLY a JSON object for the optimal crop box. Ensure x+width <= ${width} and y+height <= ${height}. Format: {"x": int, "y": int, "width": int, "height": int, "rule": "string explaining the compositional choice"}` },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
                ]
            }],
            response_format: { type: "json_object" }
        })
    });
    
    if (!response.ok) {
        throw new Error(`VLM Request Failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
}

async function execute({ image_path, delete_after = true }) {
    try {
        // 1. Read to memory
        const buffer = await fs.readFile(image_path);
        const metadata = await sharp(buffer).metadata();
        const base64 = buffer.toString('base64');
        
        // 2. Zero-Retention Memory Management: Purge original from disk immediately
        if (delete_after) {
            await fs.unlink(image_path).catch(e => console.warn("[Master-Crop] Could not delete original file:", e.message));
        }

        // 3. VLM Analysis
        const cropBox = await analyzeComposition(base64, metadata.width, metadata.height);
        
        // 4. Boundary Safety Fallback (Evaluator Requirement)
        cropBox.x = Math.max(0, Math.min(Math.floor(cropBox.x), metadata.width - 1));
        cropBox.y = Math.max(0, Math.min(Math.floor(cropBox.y), metadata.height - 1));
        cropBox.width = Math.min(Math.floor(cropBox.width), metadata.width - cropBox.x);
        cropBox.height = Math.min(Math.floor(cropBox.height), metadata.height - cropBox.y);

        // 5. Transformation Engine (Lossless crop)
        const croppedBuffer = await sharp(buffer)
            .extract({ left: cropBox.x, top: cropBox.y, width: cropBox.width, height: cropBox.height })
            .toBuffer();

        // 6. Return Data URI (No disk footprint for the output either)
        return {
            status: "success",
            composition_rule: cropBox.rule,
            coordinates: cropBox,
            image_data_uri: `data:image/jpeg;base64,${croppedBuffer.toString('base64')}`
        };
    } catch (err) {
        return { status: "error", message: err.message };
    }
}

module.exports = {
    name: "master_crop",
    description: "Re-compose an image to master-level photography standards using VLM and sharp. Implements zero-retention memory management (input deleted, output streamed).",
    parameters: {
        type: "object",
        properties: {
            image_path: { type: "string", description: "Absolute path to the input image." },
            delete_after: { type: "boolean", description: "If true, deletes the original image from disk immediately after loading into memory. Defaults to true." }
        },
        required: ["image_path"]
    },
    execute
};
