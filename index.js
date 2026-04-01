const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

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
const MAX_BURST_SIZE = envInt('AGENTLUX_MAX_BURST_SIZE', 20);

const RECOVERY_HINTS = {
    CONFIG_ERROR: 'Set at least one VLM API key: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY. Or configure AGENTLUX_CUSTOM_BASE_URL + AGENTLUX_CUSTOM_API_KEY.',
    INPUT_ERROR: 'Check input parameters. image_path must be an absolute path to an existing file. image_paths must be an array of absolute paths. Provide one or the other, not both.',
    INPUT_TOO_LARGE: `Resize or compress the image to under ${MAX_IMAGE_BYTES} bytes before retrying.`,
    IMAGE_METADATA_ERROR: 'The file may be corrupted or not a valid image. Try a different file.',
    VLM_TIMEOUT: 'The VLM request timed out. Retry the same request — transient timeouts are normal.',
    VLM_NETWORK_ERROR: 'Network error reaching VLM provider. Check connectivity and retry.',
    VLM_HTTP_ERROR: 'The VLM API returned a client error (e.g. invalid key). Verify the API key and model name.',
    VLM_HTTP_TRANSIENT: 'The VLM API is temporarily overloaded. Wait a few seconds and retry.',
    VLM_PARSE_ERROR: 'The VLM returned malformed output. Retry the same request.',
    VLM_SCHEMA_ERROR: 'The VLM returned unexpected output. Retry the same request.',
    UNEXPECTED_ERROR: 'An unexpected internal error occurred. Retry once; if it persists, report the error message.'
};

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

// ============================================================
// Master Photographer Registry
// ============================================================

const MASTER_REGISTRY = {
    bresson: {
        name: 'Henri Cartier-Bresson',
        style: 'The Decisive Moment',
        prompt: (w, h) => `You ARE Henri Cartier-Bresson, shooting with your Leica M3 and 50mm Summicron. You live for The Decisive Moment — that fraction of a second when geometry, emotion, and narrative converge into perfection. You compose through dynamic symmetry, the golden rectangle, and diagonal tensions. Every frame must feel inevitable.

Analyze this image (${w}x${h} pixels). Find the decisive geometry within it. Calculate the mathematically perfect crop that creates maximum tension between form and content.

Return ONLY a JSON object:
{"x": int, "y": int, "width": int, "height": int, "rule": "Your compositional explanation — speak as Bresson would, referencing the specific geometric relationships you've found"}
Constraints: x >= 0, y >= 0, x+width <= ${w}, y+height <= ${h}, width >= 1, height >= 1.`
    },

    webb: {
        name: 'Alex Webb',
        style: 'Complex Color Layering',
        prompt: (w, h) => `You ARE Alex Webb, Magnum photographer renowned for complex multi-layered color compositions. You see the world as overlapping planes of saturated color and shadow. Your frames are impossibly dense — foreground, midground, background all active, all essential. You find order in visual chaos through color relationships and geometric interlocking.

Analyze this image (${w}x${h} pixels). Find the crop that creates maximum visual density — layer upon layer of information, each plane adding meaning. Color tension between warm and cool zones is your signature.

Return ONLY a JSON object:
{"x": int, "y": int, "width": int, "height": int, "rule": "Your compositional explanation — speak as Webb would, describing the layers and color relationships"}
Constraints: x >= 0, y >= 0, x+width <= ${w}, y+height <= ${h}, width >= 1, height >= 1.`
    },

    fan_ho: {
        name: 'Fan Ho',
        style: 'Light & Shadow Geometry',
        prompt: (w, h) => `You ARE Fan Ho, the master of Hong Kong light and shadow. Your photographs are paintings in chiaroscuro — shafts of light cutting through darkness, lone figures as punctuation marks in vast geometric compositions. You compose in triangles and diagonals of light, finding the poetry where architecture meets humanity.

Analyze this image (${w}x${h} pixels). Find the crop that maximizes the dramatic interplay of light and shadow. Isolate the most powerful light geometry — let darkness frame the luminous moment.

Return ONLY a JSON object:
{"x": int, "y": int, "width": int, "height": int, "rule": "Your compositional explanation — speak as Fan Ho would, describing the light geometry and emotional resonance"}
Constraints: x >= 0, y >= 0, x+width <= ${w}, y+height <= ${h}, width >= 1, height >= 1.`
    },

    koudelka: {
        name: 'Josef Koudelka',
        style: 'Panoramic High-Contrast Geometry',
        prompt: (w, h) => `You ARE Josef Koudelka, the exiled Czech photographer of sweeping landscapes and fierce human drama. Your vision is panoramic and stark — walls, horizons, human figures as sculptural elements against vast spaces. You embrace extreme contrast and wide aspect ratios. Your compositions have the weight of mythology.

Analyze this image (${w}x${h} pixels). Find the crop that creates maximum spatial drama and geometric austerity. Favor wider aspect ratios if they serve the epic scale. Let the composition breathe with tension.

Return ONLY a JSON object:
{"x": int, "y": int, "width": int, "height": int, "rule": "Your compositional explanation — speak as Koudelka would, describing the spatial drama and geometric forces"}
Constraints: x >= 0, y >= 0, x+width <= ${w}, y+height <= ${h}, width >= 1, height >= 1.`
    },

    salgado: {
        name: 'Sebastiao Salgado',
        style: 'Epic Human Documentary',
        prompt: (w, h) => `You ARE Sebastiao Salgado, the Brazilian documentarian who elevates humanity to mythic status through a Leica. Your compositions are monumental — human figures gain dignity through dramatic light, low angles, and environmental context. You find the universal in the specific, the epic in the everyday.

Analyze this image (${w}x${h} pixels). Find the crop that elevates the human narrative to its most dignified and monumental form. Let the subject command the frame with the gravity they deserve.

Return ONLY a JSON object:
{"x": int, "y": int, "width": int, "height": int, "rule": "Your compositional explanation — speak as Salgado would, describing the human dignity and monumental quality"}
Constraints: x >= 0, y >= 0, x+width <= ${w}, y+height <= ${h}, width >= 1, height >= 1.`
    },

    moriyama: {
        name: 'Daido Moriyama',
        style: 'Provoke-Era Raw Street',
        prompt: (w, h) => `You ARE Daido Moriyama, the provocateur of Japanese street photography. You shoot raw — blur, grain, tilt, and high contrast are your vocabulary. Your compositions deliberately reject classical beauty: you fragment, you isolate, you find the visceral in the chaotic. The street does not pose for you, and you do not ask it to.

Analyze this image (${w}x${h} pixels). Find the most raw, visceral crop. Embrace imperfection — tilt, fragment, push into the subject. Classical composition rules are meaningless here; only emotional intensity matters.

Return ONLY a JSON object:
{"x": int, "y": int, "width": int, "height": int, "rule": "Your compositional explanation — speak as Moriyama would, raw and direct, about the visceral energy captured"}
Constraints: x >= 0, y >= 0, x+width <= ${w}, y+height <= ${h}, width >= 1, height >= 1.`
    }
};

// ============================================================
// Leica Color Profiles
// ============================================================

const LEICA_PROFILES = {
    m10: {
        name: 'Leica M10 Digital',
        recomb: [[1.1, -0.05, -0.05], [0.0, 0.9, 0.1], [0.0, 0.0, 1.05]],
        saturation: 0.9,
        brightness: 1.02,
        contrastSlope: 1.15,
        contrastOffset: -(0.05 * 255),
        grayscale: false,
        grain: null
    },
    m9_ccd: {
        name: 'Leica M9 CCD',
        recomb: [[1.18, -0.10, -0.03], [0.03, 0.82, 0.15], [-0.03, 0.06, 1.15]],
        saturation: 1.08,
        brightness: 1.0,
        contrastSlope: 1.22,
        contrastOffset: -(0.08 * 255),
        grayscale: false,
        grain: null
    },
    m_monochrom: {
        name: 'Leica M Monochrom',
        recomb: [[0.33, 0.50, 0.17], [0.33, 0.50, 0.17], [0.33, 0.50, 0.17]],
        brightness: 1.0,
        contrastSlope: 1.35,
        contrastOffset: -(0.1 * 255),
        grayscale: true,
        grain: { intensity: 12, size: 1 }
    },
    m6_trix400: {
        name: 'Leica M6 + Kodak Tri-X 400',
        recomb: [[0.30, 0.59, 0.11], [0.30, 0.59, 0.11], [0.30, 0.59, 0.11]],
        brightness: 1.05,
        contrastSlope: 1.45,
        contrastOffset: -(0.15 * 255),
        grayscale: true,
        grain: { intensity: 32, size: 2 }
    },
    m6_portra400: {
        name: 'Leica M6 + Kodak Portra 400',
        recomb: [[1.05, 0.03, -0.02], [0.0, 1.0, 0.05], [-0.02, -0.02, 1.08]],
        saturation: 0.92,
        brightness: 1.05,
        contrastSlope: 1.08,
        contrastOffset: 0.02 * 255,
        grayscale: false,
        grain: { intensity: 14, size: 1 }
    }
};

// ============================================================
// Leica Lens Profiles
// ============================================================

const LENS_PROFILES = {
    summilux_35: {
        name: 'Summilux-M 35mm f/1.4 ASPH',
        vignetteRadius: 75,
        vignetteStrength: 0.4,
        vignetteFeather: 50,
        sharpenSigma: 1.0,
        sharpenFlat: 1.0,
        sharpenJagged: 0.6
    },
    noctilux_50: {
        name: 'Noctilux-M 50mm f/0.95 ASPH',
        vignetteRadius: 60,
        vignetteStrength: 0.55,
        vignetteFeather: 35,
        sharpenSigma: 0.7,
        sharpenFlat: 0.5,
        sharpenJagged: 0.3
    },
    summicron_35: {
        name: 'Summicron-M 35mm f/2 ASPH',
        vignetteRadius: 82,
        vignetteStrength: 0.22,
        vignetteFeather: 58,
        sharpenSigma: 1.2,
        sharpenFlat: 1.5,
        sharpenJagged: 0.8
    },
    elmarit_28: {
        name: 'Elmarit-M 28mm f/2.8 ASPH',
        vignetteRadius: 68,
        vignetteStrength: 0.35,
        vignetteFeather: 42,
        sharpenSigma: 0.9,
        sharpenFlat: 1.2,
        sharpenJagged: 0.5
    }
};

// ============================================================
// VLM Provider Abstraction
// ============================================================

function resolveProvider(modelOverride) {
    if (modelOverride) {
        if (modelOverride.startsWith('claude-')) {
            const key = process.env.ANTHROPIC_API_KEY;
            if (!key) throw new AgentLuxError('CONFIG_ERROR', 'ANTHROPIC_API_KEY required for Claude models.');
            return { type: 'anthropic', model: modelOverride, apiKey: key };
        }
        if (/^(gpt-|o[134]-|chatgpt-)/.test(modelOverride)) {
            const key = process.env.OPENAI_API_KEY;
            if (!key) throw new AgentLuxError('CONFIG_ERROR', 'OPENAI_API_KEY required for OpenAI models.');
            return { type: 'openai', model: modelOverride, apiKey: key };
        }
        if (modelOverride.startsWith('gemini-')) {
            const key = process.env.GOOGLE_API_KEY;
            if (!key) throw new AgentLuxError('CONFIG_ERROR', 'GOOGLE_API_KEY required for Gemini models.');
            return { type: 'gemini', model: modelOverride, apiKey: key };
        }
        const baseUrl = process.env.AGENTLUX_CUSTOM_BASE_URL;
        const key = process.env.AGENTLUX_CUSTOM_API_KEY;
        if (baseUrl && key) return { type: 'custom', model: modelOverride, apiKey: key, baseUrl };
        throw new AgentLuxError('CONFIG_ERROR', `Unknown model "${modelOverride}". Set AGENTLUX_CUSTOM_BASE_URL + AGENTLUX_CUSTOM_API_KEY for custom models.`);
    }

    if (process.env.AGENTLUX_CUSTOM_BASE_URL && process.env.AGENTLUX_CUSTOM_API_KEY) {
        return { type: 'custom', model: 'default', apiKey: process.env.AGENTLUX_CUSTOM_API_KEY, baseUrl: process.env.AGENTLUX_CUSTOM_BASE_URL };
    }
    if (process.env.ANTHROPIC_API_KEY) return { type: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: process.env.ANTHROPIC_API_KEY };
    if (process.env.OPENAI_API_KEY) return { type: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY };
    if (process.env.GOOGLE_API_KEY) return { type: 'gemini', model: 'gemini-1.5-pro', apiKey: process.env.GOOGLE_API_KEY };
    throw new AgentLuxError('CONFIG_ERROR', 'No VLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, or AGENTLUX_CUSTOM_BASE_URL + AGENTLUX_CUSTOM_API_KEY.');
}

function buildOpenAIBody(model, prompt, imageBase64) {
    return {
        model,
        messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ] }],
        response_format: { type: 'json_object' }
    };
}

function buildVLMRequest(provider, prompt, imageBase64) {
    if (provider.type === 'anthropic') {
        return {
            url: 'https://api.anthropic.com/v1/messages',
            headers: { 'Content-Type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
            body: { model: provider.model, max_tokens: 1024, messages: [{ role: 'user', content: [
                { type: 'text', text: prompt },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } }
            ] }] },
            extractContent: (data) => data?.content?.find(b => b.type === 'text')?.text
        };
    }
    if (provider.type === 'gemini') {
        return {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`,
            headers: { 'Content-Type': 'application/json' },
            body: { contents: [{ parts: [
                { text: prompt },
                { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }
            ] }], generationConfig: { responseMimeType: 'application/json' } },
            extractContent: (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text
        };
    }
    const url = provider.type === 'custom'
        ? `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
        : 'https://api.openai.com/v1/chat/completions';
    return {
        url,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
        body: buildOpenAIBody(provider.model, prompt, imageBase64),
        extractContent: (data) => data?.choices?.[0]?.message?.content
    };
}

function buildMultiImageVLMRequest(provider, prompt, imagesBase64) {
    if (provider.type === 'anthropic') {
        const content = [{ type: 'text', text: prompt }];
        imagesBase64.forEach((img, i) => {
            content.push({ type: 'text', text: `[Image ${i}]:` });
            content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
        });
        return {
            url: 'https://api.anthropic.com/v1/messages',
            headers: { 'Content-Type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
            body: { model: provider.model, max_tokens: 1024, messages: [{ role: 'user', content }] },
            extractContent: (data) => data?.content?.find(b => b.type === 'text')?.text
        };
    }
    if (provider.type === 'gemini') {
        const parts = [{ text: prompt }];
        imagesBase64.forEach((img, i) => {
            parts.push({ text: `[Image ${i}]:` });
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
        });
        return {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`,
            headers: { 'Content-Type': 'application/json' },
            body: { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } },
            extractContent: (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text
        };
    }
    const url = provider.type === 'custom'
        ? `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
        : 'https://api.openai.com/v1/chat/completions';
    const content = [{ type: 'text', text: prompt }];
    imagesBase64.forEach((img, i) => {
        content.push({ type: 'text', text: `[Image ${i}]:` });
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } });
    });
    return {
        url,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
        body: { model: provider.model, messages: [{ role: 'user', content }], response_format: { type: 'json_object' } },
        extractContent: (data) => data?.choices?.[0]?.message?.content
    };
}

async function callVLM(request) {
    const RETRYABLE_CODES = new Set(['VLM_TIMEOUT', 'VLM_NETWORK_ERROR']);
    let lastError;
    for (let attempt = 0; attempt <= VLM_MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), VLM_TIMEOUT_MS);
        try {
            const response = await fetch(request.url, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify(request.body),
                signal: controller.signal
            });
            const responseText = await response.text();
            if (!response.ok) {
                const code = response.status >= 500 || response.status === 429 ? 'VLM_HTTP_TRANSIENT' : 'VLM_HTTP_ERROR';
                if (code === 'VLM_HTTP_TRANSIENT') RETRYABLE_CODES.add(code);
                throw new AgentLuxError(code, `VLM request failed with status ${response.status}.`, {
                    status: response.status, statusText: response.statusText, body: responseText.slice(0, 512)
                });
            }
            let data;
            try { data = JSON.parse(responseText); }
            catch { throw new AgentLuxError('VLM_PARSE_ERROR', 'Unable to parse VLM HTTP response as JSON.'); }
            const content = request.extractContent(data);
            if (typeof content !== 'string') {
                throw new AgentLuxError('VLM_SCHEMA_ERROR', 'VLM response missing expected content string.');
            }
            let parsed;
            try { parsed = JSON.parse(content); }
            catch { throw new AgentLuxError('VLM_PARSE_ERROR', 'Unable to parse VLM JSON payload.'); }
            return parsed;
        } catch (err) {
            if (err.name === 'AbortError') {
                lastError = new AgentLuxError('VLM_TIMEOUT', `VLM request timed out after ${VLM_TIMEOUT_MS}ms.`);
            } else if (err instanceof AgentLuxError) {
                lastError = err;
            } else {
                lastError = new AgentLuxError('VLM_NETWORK_ERROR', err.message);
            }
            if (!RETRYABLE_CODES.has(lastError.code) || attempt === VLM_MAX_RETRIES) break;
            await sleep(200 * Math.pow(2, attempt));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw lastError;
}

// ============================================================
// Parsing & Validation
// ============================================================

function parseCropBox(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AgentLuxError('VLM_SCHEMA_ERROR', 'VLM response is not a valid JSON object.');
    }
    for (const key of ['x', 'y', 'width', 'height']) {
        if (!(key in raw)) throw new AgentLuxError('VLM_SCHEMA_ERROR', `VLM response missing "${key}" field.`);
        if (!Number.isFinite(raw[key])) throw new AgentLuxError('VLM_SCHEMA_ERROR', `VLM "${key}" must be a finite number.`);
    }
    return {
        x: Math.floor(raw.x), y: Math.floor(raw.y),
        width: Math.floor(raw.width), height: Math.floor(raw.height),
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

function parseCuratorResponse(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AgentLuxError('VLM_SCHEMA_ERROR', 'Curator response is not a valid JSON object.');
    }
    return {
        master: typeof raw.master === 'string' && raw.master in MASTER_REGISTRY ? raw.master : 'bresson',
        colorProfile: typeof raw.color_profile === 'string' && raw.color_profile in LEICA_PROFILES ? raw.color_profile : 'm10',
        lens: typeof raw.lens === 'string' && raw.lens in LENS_PROFILES ? raw.lens : 'summilux_35',
        masterRationale: typeof raw.master_rationale === 'string' ? raw.master_rationale : '',
        colorRationale: typeof raw.color_rationale === 'string' ? raw.color_rationale : '',
        lensRationale: typeof raw.lens_rationale === 'string' ? raw.lens_rationale : ''
    };
}

// ============================================================
// Agent Pipelines
// ============================================================

async function curateImage(imageBase64, width, height, lang) {
    const provider = resolveProvider(process.env.AGENTLUX_CURATOR_MODEL);
    const masterList = Object.entries(MASTER_REGISTRY).map(([k, m]) => `  - "${k}": ${m.name} (${m.style})`).join('\n');
    const profileList = Object.entries(LEICA_PROFILES).map(([k, p]) => `  - "${k}": ${p.name}`).join('\n');
    const lensList = Object.entries(LENS_PROFILES).map(([k, l]) => `  - "${k}": ${l.name}`).join('\n');
    const langInstruction = lang !== 'en' ? `\n\nIMPORTANT: Write ALL text values (master_rationale, color_rationale, lens_rationale) in ${lang}. Keep JSON keys and selection keys in English.` : '';

    const prompt = `You are the Chief Curator of a world-class Leica photography exhibition. You have spent decades studying the masters who defined 35mm street and documentary photography.

Analyze this photograph (${width}x${height} pixels). Consider:
1. The dominant light/shadow structure and tonal range
2. Geometric patterns, leading lines, and spatial tensions
3. The emotional weight, narrative content, and subject matter
4. Color palette, contrast characteristics, and mood

Select the ONE master photographer whose compositional philosophy best matches this image:
${masterList}

Select the optimal Leica color grade:
${profileList}

Select the lens character:
${lensList}

Return ONLY a JSON object:
{"master": "key", "master_rationale": "brief why", "color_profile": "key", "color_rationale": "brief why", "lens": "key", "lens_rationale": "brief why"}${langInstruction}`;

    const request = buildVLMRequest(provider, prompt, imageBase64);
    return parseCuratorResponse(await callVLM(request));
}

async function masterCompose(imageBase64, width, height, masterKey, lang) {
    const provider = resolveProvider(process.env.AGENTLUX_MASTER_MODEL);
    const master = MASTER_REGISTRY[masterKey] || MASTER_REGISTRY.bresson;
    const langInstruction = lang !== 'en' ? `\n\nIMPORTANT: Write the "rule" value in ${lang}. Keep JSON keys, x, y, width, height as numbers.` : '';
    const request = buildVLMRequest(provider, master.prompt(width, height) + langInstruction, imageBase64);
    return parseCropBox(await callVLM(request));
}

async function selectDecisiveMoment(thumbnailsBase64, lang) {
    const provider = resolveProvider(process.env.AGENTLUX_SELECTOR_MODEL || process.env.AGENTLUX_CURATOR_MODEL);
    const count = thumbnailsBase64.length;
    const langInstruction = lang && lang !== 'en' ? `\n\nIMPORTANT: Write the "rationale" value in ${lang}.` : '';
    const prompt = `You are selecting The Decisive Moment from a burst of ${count} consecutive frames (indexed 0 to ${count - 1}).

Evaluate each frame for:
1. Peak action — the apex of gesture, expression, or movement
2. Geometric perfection — the strongest compositional potential
3. Light quality — the most dramatic or revealing illumination
4. Emotional resonance — the frame that tells the most powerful story

There is only ONE decisive moment. Find it.

Return ONLY a JSON object:
{"selected_index": int, "rationale": "Why THIS frame captures the unrepeatable instant"}${langInstruction}`;

    const request = buildMultiImageVLMRequest(provider, prompt, thumbnailsBase64);
    const raw = await callVLM(request);
    if (!raw || typeof raw.selected_index !== 'number') {
        throw new AgentLuxError('VLM_SCHEMA_ERROR', 'Burst selector response missing selected_index.');
    }
    const idx = Math.floor(raw.selected_index);
    if (idx < 0 || idx >= count) {
        throw new AgentLuxError('VLM_SCHEMA_ERROR', `Burst selector index ${idx} out of range [0, ${count - 1}].`);
    }
    return { selectedIndex: idx, rationale: typeof raw.rationale === 'string' ? raw.rationale : '' };
}

// ============================================================
// Image Processing Pipeline
// ============================================================

function applyLeicaColor(sharpInstance, profile) {
    let s = sharpInstance.recomb(profile.recomb);
    if (profile.grayscale) {
        s = s.modulate({ brightness: profile.brightness });
    } else {
        s = s.modulate({ saturation: profile.saturation ?? 1.0, brightness: profile.brightness });
    }
    return s.linear(profile.contrastSlope, profile.contrastOffset);
}

function buildVignetteSvg(width, height, lens) {
    return `<svg width="${width}" height="${height}">
    <defs><radialGradient id="v" cx="50%" cy="50%" r="${lens.vignetteRadius}%">
        <stop offset="${lens.vignetteFeather}%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="${lens.vignetteStrength}"/>
    </radialGradient></defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="url(#v)"/>
</svg>`;
}

async function generateFilmGrain(width, height, grainConfig) {
    if (!grainConfig) return null;
    const { intensity, size } = grainConfig;
    const gw = Math.max(1, Math.ceil(width / size));
    const gh = Math.max(1, Math.ceil(height / size));
    const total = gw * gh;
    const buf = Buffer.alloc(total * 3);
    const rnd = crypto.randomBytes(total * 2);
    for (let i = 0; i < total; i++) {
        const u1 = (rnd[i * 2] + 1) / 257;
        const u2 = (rnd[i * 2 + 1] + 1) / 257;
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const v = Math.max(0, Math.min(255, 128 + Math.round(z * intensity)));
        buf[i * 3] = v;
        buf[i * 3 + 1] = v;
        buf[i * 3 + 2] = v;
    }
    return sharp(buf, { raw: { width: gw, height: gh, channels: 3 } })
        .resize(width, height, { kernel: size > 1 ? 'nearest' : 'lanczos3' })
        .png()
        .toBuffer();
}

// ============================================================
// Core Processing
// ============================================================

async function processImage(buffer, metadata, context) {
    const { width, height } = metadata;
    const lang = context.lang || 'en';
    const vlmJpeg = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    const base64 = vlmJpeg.toString('base64');

    const curation = await curateImage(base64, width, height, lang);
    const cropBox = await masterCompose(base64, width, height, curation.master, lang);
    const safeCrop = sanitizeCropBox(cropBox, width, height);

    const profile = LEICA_PROFILES[curation.colorProfile] || LEICA_PROFILES.m10;
    const lens = LENS_PROFILES[curation.lens] || LENS_PROFILES.summilux_35;
    const cw = safeCrop.width;
    const ch = safeCrop.height;

    const overlays = [];
    overlays.push({ input: Buffer.from(buildVignetteSvg(cw, ch, lens)), blend: 'multiply' });
    if (profile.grain) {
        const grainBuf = await generateFilmGrain(cw, ch, profile.grain);
        if (grainBuf) overlays.push({ input: grainBuf, blend: 'soft-light' });
    }

    let processed = sharp(buffer)
        .extract({ left: safeCrop.x, top: safeCrop.y, width: cw, height: ch });
    processed = applyLeicaColor(processed, profile);
    const outputBuffer = await processed
        .sharpen({ sigma: lens.sharpenSigma, flat: lens.sharpenFlat, jagged: lens.sharpenJagged })
        .composite(overlays)
        .withMetadata()
        .jpeg({ quality: 92 })
        .toBuffer();

    const masterName = MASTER_REGISTRY[curation.master]?.name || curation.master;
    const masterStyle = MASTER_REGISTRY[curation.master]?.style || '';
    const lensName = LENS_PROFILES[curation.lens]?.name || curation.lens;

    const result = {
        status: 'success',
        master_photographer: masterName,
        master_style: masterStyle,
        master_rationale: curation.masterRationale,
        composition_rule: safeCrop.rule,
        coordinates: safeCrop,
        color_profile: profile.name,
        color_rationale: curation.colorRationale,
        lens_profile: lensName,
        lens_rationale: curation.lensRationale,
        source_file_deletion: context.delete_after ? context.deletionStatus : 'disabled',
        source_file_deletion_message: context.deletionMessage
    };

    if (context.outputPath) {
        await fs.writeFile(context.outputPath, outputBuffer);
        result.output_path = context.outputPath;
    } else {
        result.image_data_uri = `data:image/jpeg;base64,${outputBuffer.toString('base64')}`;
    }

    if (context.burstResult) result.burst_selection = context.burstResult;

    const narrativeParts = [];
    if (context.burstResult) {
        narrativeParts.push(context.burstResult.rationale);
    }
    if (lang === 'en') {
        narrativeParts.push(`Recomposed through the eye of ${masterName} (${masterStyle}).`);
        if (safeCrop.rule) narrativeParts.push(safeCrop.rule);
        narrativeParts.push(`Color grade: ${profile.name}.`);
        narrativeParts.push(`Lens character: ${lensName}.`);
    } else {
        narrativeParts.push(`${masterName} · ${masterStyle}`);
        if (safeCrop.rule) narrativeParts.push(safeCrop.rule);
        narrativeParts.push(profile.name);
        narrativeParts.push(lensName);
    }
    result.presentation = narrativeParts.join('\n');

    return result;
}

// ============================================================
// Main Execute
// ============================================================

async function execute({ image_path, image_paths, output_path, language, delete_after = true }) {
    try {
        if (typeof delete_after !== 'boolean') {
            throw new AgentLuxError('INPUT_ERROR', 'delete_after must be a boolean.');
        }
        const lang = (typeof language === 'string' && language.trim()) || process.env.AGENTLUX_LANGUAGE || 'en';
        if (output_path !== undefined) {
            if (typeof output_path !== 'string' || output_path.trim().length === 0) {
                throw new AgentLuxError('INPUT_ERROR', 'output_path must be a non-empty string.');
            }
            if (!path.isAbsolute(output_path)) {
                throw new AgentLuxError('INPUT_ERROR', 'output_path must be an absolute path.');
            }
            const parentDir = path.dirname(output_path);
            const parentStat = await fs.stat(parentDir).catch(() => null);
            if (!parentStat || !parentStat.isDirectory()) {
                throw new AgentLuxError('INPUT_ERROR', `output_path parent directory does not exist: ${parentDir}`);
            }
        }

        if (image_paths !== undefined) {
            if (image_path !== undefined) throw new AgentLuxError('INPUT_ERROR', 'Provide either image_path or image_paths, not both.');
            if (!Array.isArray(image_paths) || image_paths.length === 0) throw new AgentLuxError('INPUT_ERROR', 'image_paths must be a non-empty array.');
            if (image_paths.length > MAX_BURST_SIZE) throw new AgentLuxError('INPUT_ERROR', `image_paths exceeds maximum burst size of ${MAX_BURST_SIZE}. Set AGENTLUX_MAX_BURST_SIZE to increase.`);
            for (const p of image_paths) {
                if (typeof p !== 'string' || !path.isAbsolute(p)) throw new AgentLuxError('INPUT_ERROR', `Each path must be absolute. Got: "${p}"`);
            }

            const loaded = [];
            for (const p of image_paths) {
                const stat = await fs.stat(p).catch(() => null);
                if (!stat || !stat.isFile()) throw new AgentLuxError('INPUT_ERROR', `File not found: ${p}`);
                if (stat.size > MAX_IMAGE_BYTES) throw new AgentLuxError('INPUT_TOO_LARGE', `Image exceeds max size: ${p}`);
                loaded.push({ path: p, buffer: await fs.readFile(p) });
            }

            let deletionStatus = 'disabled';
            let deletionMessage = null;
            if (delete_after) {
                let delOk = 0;
                let delFail = 0;
                const delErrors = [];
                for (const { path: fp } of loaded) {
                    try { await fs.unlink(fp); delOk++; }
                    catch (e) { delFail++; delErrors.push(e.message); }
                }
                if (delFail === 0) {
                    deletionStatus = 'deleted';
                } else if (delOk === 0) {
                    deletionStatus = 'delete_failed';
                    deletionMessage = delErrors[0];
                } else {
                    deletionStatus = 'partial';
                    deletionMessage = `${delOk} deleted, ${delFail} failed: ${delErrors[0]}`;
                }
            }

            const thumbnails = await Promise.all(loaded.map(({ buffer }) =>
                sharp(buffer).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer().then(b => b.toString('base64'))
            ));
            const { selectedIndex, rationale } = await selectDecisiveMoment(thumbnails, lang);

            const selected = loaded[selectedIndex];
            const meta = await sharp(selected.buffer).metadata();
            if (!isFinitePositiveInt(meta.width) || !isFinitePositiveInt(meta.height)) {
                throw new AgentLuxError('IMAGE_METADATA_ERROR', 'Invalid image dimensions.');
            }

            return await processImage(selected.buffer, meta, {
                lang, delete_after, deletionStatus, deletionMessage, outputPath: output_path,
                burstResult: { selected_index: selectedIndex, total_images: image_paths.length, rationale }
            });
        }

        if (typeof image_path !== 'string' || image_path.trim().length === 0) throw new AgentLuxError('INPUT_ERROR', 'image_path must be a non-empty string.');
        if (!path.isAbsolute(image_path)) throw new AgentLuxError('INPUT_ERROR', 'image_path must be an absolute path.');
        const fileStat = await fs.stat(image_path).catch(() => null);
        if (!fileStat || !fileStat.isFile()) throw new AgentLuxError('INPUT_ERROR', 'image_path must point to an existing file.');
        if (!Number.isFinite(fileStat.size) || fileStat.size <= 0) throw new AgentLuxError('INPUT_ERROR', 'Input image file is empty or invalid.');
        if (fileStat.size > MAX_IMAGE_BYTES) throw new AgentLuxError('INPUT_TOO_LARGE', `Input image exceeds max size ${MAX_IMAGE_BYTES} bytes.`, { maxBytes: MAX_IMAGE_BYTES, actualBytes: fileStat.size });

        const buffer = await fs.readFile(image_path);
        const metadata = await sharp(buffer).metadata();
        if (!isFinitePositiveInt(metadata.width) || !isFinitePositiveInt(metadata.height)) {
            throw new AgentLuxError('IMAGE_METADATA_ERROR', 'Image metadata does not include valid width/height.');
        }

        let deletionStatus = 'disabled';
        let deletionMessage = null;
        if (delete_after) {
            try { await fs.unlink(image_path); deletionStatus = 'deleted'; }
            catch (e) { deletionStatus = 'delete_failed'; deletionMessage = e.message; }
        }

        return await processImage(buffer, metadata, {
            lang, delete_after, deletionStatus, deletionMessage, outputPath: output_path, burstResult: null
        });
    } catch (err) {
        if (err instanceof AgentLuxError) {
            return {
                status: 'error', error_code: err.code, message: err.message,
                details: err.details || null,
                recovery_hint: RECOVERY_HINTS[err.code] || RECOVERY_HINTS.UNEXPECTED_ERROR
            };
        }
        return {
            status: 'error', error_code: 'UNEXPECTED_ERROR',
            message: err.message || 'Unknown error.',
            recovery_hint: RECOVERY_HINTS.UNEXPECTED_ERROR
        };
    }
}

module.exports = {
    name: 'agentlux_compose',
    description: 'Recompose and color-grade a photograph with Leica master-photographer aesthetics. Automatically selects the best master, color science, and lens. Returns the processed image and a presentation narrative. Use when a user uploads a photo and wants it improved.',
    parameters: {
        type: 'object',
        oneOf: [
            { required: ['image_path'] },
            { required: ['image_paths'] }
        ],
        properties: {
            image_path: { type: 'string', description: 'Absolute path to a single input image.' },
            image_paths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute paths for burst mode. Mutually exclusive with image_path.' },
            output_path: { type: 'string', description: 'Absolute path to write the output JPEG. If omitted, output is returned as image_data_uri (base64). Recommended for agent workflows.' },
            language: { type: 'string', description: 'Language for user-facing text (e.g. "zh", "ja", "fr", "de"). Defaults to "en". Pass the language the agent is conversing in.' },
            delete_after: { type: 'boolean', description: 'Delete original image(s) from disk after loading. Defaults to true (zero-retention).', default: true }
        },
        additionalProperties: false
    },
    execute
};
