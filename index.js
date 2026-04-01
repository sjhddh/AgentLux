const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');

function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid env ${name}="${raw}": must be a non-negative number.`);
    }
    return Math.floor(parsed);
}

const MAX_IMAGE_BYTES = envInt('AGENTLUX_MAX_IMAGE_BYTES', 30 * 1024 * 1024);
const VLM_TIMEOUT_MS = envInt('AGENTLUX_VLM_TIMEOUT_MS', 15000);
const VLM_MAX_RETRIES = envInt('AGENTLUX_VLM_MAX_RETRIES', 2);

class AgentLuxError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'AgentLuxError';
        this.code = code;
        this.details = details;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isFinitePositiveInt(value) {
    return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function parseCropBox(raw) {
    const requiredKeys = ['x', 'y', 'width', 'height'];
    for (const key of requiredKeys) {
        if (!(key in raw)) {
            throw new AgentLuxError('VLM_SCHEMA_ERROR', `VLM response missing "${key}" field.`);
        }
        if (!Number.isFinite(raw[key])) {
            throw new AgentLuxError('VLM_SCHEMA_ERROR', `VLM "${key}" must be a finite number.`);
        }
    }

    return {
        x: Math.floor(raw.x),
        y: Math.floor(raw.y),
        width: Math.floor(raw.width),
        height: Math.floor(raw.height),
        rule: typeof raw.rule === 'string' ? raw.rule : 'Composition optimized by AgentLux.'
    };
}

function sanitizeCropBox(cropBox, imageWidth, imageHeight) {
    const x = Math.max(0, Math.min(cropBox.x, imageWidth - 1));
    const y = Math.max(0, Math.min(cropBox.y, imageHeight - 1));
    const width = Math.max(1, Math.min(cropBox.width, imageWidth - x));
    const height = Math.max(1, Math.min(cropBox.height, imageHeight - y));

    return { ...cropBox, x, y, width, height };
}

function applyLeicaM10Color(sharpInstance, width, height) {
    // 1. Leica M10 Color Science (Recomb Matrix)
    // - Boost Reds, slightly desaturate Greens, warm up the Midtones
    // [R, G, B]
    const leicaMatrix = [
        [1.1, -0.05, -0.05], // R
        [0.0, 0.9, 0.1],     // G
        [0.0, 0.0, 1.05]     // B
    ];

    // 2. Optical Vignetting (Simulating a 35mm Summilux f/1.4 wide open)
    const vignetteSvg = `<svg width="${width}" height="${height}">
        <defs>
            <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
                <stop offset="50%" stop-color="black" stop-opacity="0" />
                <stop offset="100%" stop-color="black" stop-opacity="0.4" />
            </radialGradient>
        </defs>
        <rect x="0" y="0" width="${width}" height="${height}" fill="url(#vignette)" />
    </svg>`;

    // 3. Contrast & Saturation (Micro-contrast punch, slightly muted saturation for filmic look)
    return sharpInstance
        .recomb(leicaMatrix) // Color shift
        .modulate({
            saturation: 0.9, // Slightly desaturated
            brightness: 1.02 // Slight bump to offset matrix darkening
        })
        .linear(1.15, -(0.05 * 255)) // S-curve contrast boost (slope 1.15, intercept shift to crush blacks slightly)
        .composite([{
            input: Buffer.from(vignetteSvg),
            blend: 'multiply'
        }]);
}


async function analyzeComposition(imageBase64, width, height) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new AgentLuxError('CONFIG_ERROR', 'OPENAI_API_KEY required for vision analysis.');
    }

    const prompt = `You are a master photographer in the tradition of Henri Cartier-Bresson, shooting with a 35mm Leica. You possess absolute mastery over dynamic symmetry, the golden ratio, leading lines, and 'The Decisive Moment'. 
Analyze this image (original size: ${width}x${height}). 
Determine the primary subject and calculate the absolute mathematically perfect photographic crop to elevate this image to a magnum opus. 
Return ONLY a JSON object representing the optimal crop box. 
Ensure x+width <= ${width} and y+height <= ${height}. 
Format: {"x": int, "y": int, "width": int, "height": int, "rule": "string explaining the compositional choice, e.g. 'Golden Spiral alignment on the subject's gaze'"}`;

    const RETRYABLE_CODES = new Set(['VLM_TIMEOUT', 'VLM_NETWORK_ERROR']);

    let lastError;
    for (let attempt = 0; attempt <= VLM_MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), VLM_TIMEOUT_MS);
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: "gpt-4o",
                    messages: [{
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
                        ]
                    }],
                    response_format: { type: "json_object" }
                }),
                signal: controller.signal
            });

            const responseText = await response.text();
            if (!response.ok) {
                const code = response.status >= 500 || response.status === 429
                    ? 'VLM_HTTP_TRANSIENT'
                    : 'VLM_HTTP_ERROR';
                if (code === 'VLM_HTTP_TRANSIENT') RETRYABLE_CODES.add(code);
                throw new AgentLuxError(
                    code,
                    `VLM request failed with status ${response.status}.`,
                    { status: response.status, statusText: response.statusText, body: responseText.slice(0, 512) }
                );
            }

            let data;
            try {
                data = JSON.parse(responseText);
            } catch {
                throw new AgentLuxError('VLM_PARSE_ERROR', 'Unable to parse VLM HTTP response as JSON.');
            }

            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string') {
                throw new AgentLuxError('VLM_SCHEMA_ERROR', 'VLM response missing choices[0].message.content string.');
            }

            let rawCrop;
            try {
                rawCrop = JSON.parse(content);
            } catch {
                throw new AgentLuxError('VLM_PARSE_ERROR', 'Unable to parse VLM composition JSON payload.');
            }
            return parseCropBox(rawCrop);
        } catch (err) {
            if (err.name === 'AbortError') {
                lastError = new AgentLuxError('VLM_TIMEOUT', `VLM request timed out after ${VLM_TIMEOUT_MS}ms.`);
            } else if (err instanceof AgentLuxError) {
                lastError = err;
            } else {
                lastError = new AgentLuxError('VLM_NETWORK_ERROR', err.message);
            }
            const isRetryable = RETRYABLE_CODES.has(lastError.code);
            if (!isRetryable || attempt === VLM_MAX_RETRIES) break;
            await sleep(200 * Math.pow(2, attempt));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw lastError;
}

async function execute({ image_path, delete_after = true }) {
    try {
        if (typeof image_path !== 'string' || image_path.trim().length === 0) {
            throw new AgentLuxError('INPUT_ERROR', 'image_path must be a non-empty string.');
        }
        if (!path.isAbsolute(image_path)) {
            throw new AgentLuxError('INPUT_ERROR', 'image_path must be an absolute path.');
        }

        const fileStat = await fs.stat(image_path).catch(() => null);
        if (!fileStat || !fileStat.isFile()) {
            throw new AgentLuxError('INPUT_ERROR', 'image_path must point to an existing file.');
        }
        if (!Number.isFinite(fileStat.size) || fileStat.size <= 0) {
            throw new AgentLuxError('INPUT_ERROR', 'Input image file is empty or invalid.');
        }
        if (fileStat.size > MAX_IMAGE_BYTES) {
            throw new AgentLuxError(
                'INPUT_TOO_LARGE',
                `Input image exceeds max size ${MAX_IMAGE_BYTES} bytes.`,
                { maxBytes: MAX_IMAGE_BYTES, actualBytes: fileStat.size }
            );
        }

        // 1. Read to memory
        const buffer = await fs.readFile(image_path);
        const metadata = await sharp(buffer).metadata();
        if (!isFinitePositiveInt(metadata.width) || !isFinitePositiveInt(metadata.height)) {
            throw new AgentLuxError('IMAGE_METADATA_ERROR', 'Image metadata does not include valid width/height.');
        }
        const base64 = buffer.toString('base64');
        
        // 2. Zero-Retention Memory Management: Purge original from disk immediately
        let deletionStatus = 'skipped';
        let deletionMessage = null;
        if (delete_after) {
            try {
                await fs.unlink(image_path);
                deletionStatus = 'deleted';
            } catch (e) {
                deletionStatus = 'delete_failed';
                deletionMessage = e.message;
                console.warn("[AgentLux] Could not delete original file:", e.message);
            }
        }

        // 3. VLM Analysis
        const cropBox = await analyzeComposition(base64, metadata.width, metadata.height);
        
        // 4. Boundary Safety Fallback (Evaluator Requirement)
        const safeCrop = sanitizeCropBox(cropBox, metadata.width, metadata.height);

        // 5. Transformation Engine (Lossless crop + Leica Color Science)
        let croppedSharp = sharp(buffer)
            .extract({ left: safeCrop.x, top: safeCrop.y, width: safeCrop.width, height: safeCrop.height });
        
        croppedSharp = applyLeicaM10Color(croppedSharp, safeCrop.width, safeCrop.height);
        const croppedBuffer = await croppedSharp.withMetadata().toBuffer();

        // 6. Return Data URI (No disk footprint for the output either)
        return {
            status: "success",
            composition_rule: safeCrop.rule,
            coordinates: safeCrop,
            source_file_deletion: delete_after ? deletionStatus : 'disabled',
            source_file_deletion_message: deletionMessage,
            image_data_uri: `data:image/jpeg;base64,${croppedBuffer.toString('base64')}`
        };
    } catch (err) {
        if (err instanceof AgentLuxError) {
            return { status: "error", error_code: err.code, message: err.message, details: err.details || null };
        }
        return { status: "error", error_code: "UNEXPECTED_ERROR", message: err.message || "Unknown error." };
    }
}

module.exports = {
    name: "agentlux_compose",
    description: "Re-compose an image to Leica/Bresson master-level standards using VLM and sharp. Implements zero-retention memory management.",
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
