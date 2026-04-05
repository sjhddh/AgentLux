const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const agentlux = require('../index.js');

const SAVED_KEY = process.env.OPENAI_API_KEY;
const SAVED_FETCH = global.fetch;

const DEFAULT_CURATOR = {
    master: 'bresson',
    color_profile: 'm10',
    lens: 'summilux_35',
    master_rationale: 'Geometric tension',
    color_rationale: 'Natural tones',
    lens_rationale: 'Classic street lens'
};

function setup() {
    process.env.OPENAI_API_KEY = 'test-key';
}

function teardown() {
    global.fetch = SAVED_FETCH;
    if (SAVED_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = SAVED_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.AGENTLUX_CUSTOM_BASE_URL;
    delete process.env.AGENTLUX_CUSTOM_API_KEY;
    delete process.env.AGENTLUX_CURATOR_MODEL;
    delete process.env.AGENTLUX_MASTER_MODEL;
    delete process.env.AGENTLUX_SELECTOR_MODEL;
}

function mockOpenAIResponse(payload) {
    const body = {
        choices: [{ message: { content: JSON.stringify(payload) } }]
    };
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(body)
    };
}

function mockTwoPass(curatorResp, masterResp) {
    let callIdx = 0;
    return async () => {
        callIdx++;
        return mockOpenAIResponse(callIdx === 1 ? curatorResp : masterResp);
    };
}

async function createFixtureImage(filePath, width = 120, height = 80) {
    await sharp({
        create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } }
    }).jpeg().toFile(filePath);
}

// --- Happy path ---

test('default delete_after=true deletes source file on success', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        DEFAULT_CURATOR,
        { x: 10, y: 10, width: 60, height: 40, rule: 'Golden Spiral' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath });
        assert.equal(result.status, 'success');
        assert.equal(result.source_file_deletion, 'deleted');
        assert.match(result.image_data_uri, /^data:image\/jpeg;base64,/);
        assert.equal(result.master_photographer, 'Henri Cartier-Bresson');
        assert.equal(result.color_profile, 'Leica M10 Digital');
        await assert.rejects(fs.access(imagePath));
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('delete_after=false keeps source file', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        DEFAULT_CURATOR,
        { x: 0, y: 0, width: 30, height: 30, rule: 'rule' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.source_file_deletion, 'disabled');
        await fs.access(imagePath);
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- VLM error paths ---

test('invalid VLM JSON schema returns VLM_SCHEMA_ERROR without retry', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) return mockOpenAIResponse(DEFAULT_CURATOR);
        return mockOpenAIResponse({ x: 1, y: 1, height: 20, rule: 'missing width' });
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'VLM_SCHEMA_ERROR');
        assert.equal(fetchCalls, 2, 'schema errors on master call must not trigger retries');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('transient network error retries and succeeds', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary network failure');
        if (calls === 2) return mockOpenAIResponse(DEFAULT_CURATOR);
        return mockOpenAIResponse({ x: 2, y: 2, width: 20, height: 20, rule: 'retry rule' });
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(calls, 3);
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('HTTP 4xx is not retried', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' };
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'VLM_HTTP_ERROR');
        assert.equal(fetchCalls, 1, 'client errors must not trigger retries');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Crop bounds ---

test('crop sanitization clamps to image bounds and enforces min size', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        DEFAULT_CURATOR,
        { x: -100, y: 1000, width: -5, height: 9999, rule: 'extreme values' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.coordinates.x, 0);
        assert.equal(result.coordinates.y, 79);
        assert.equal(result.coordinates.width, 1);
        assert.equal(result.coordinates.height, 1);
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Input validation ---

test('rejects empty image_path', async () => {
    setup();
    try {
        const result = await agentlux.execute({ image_path: '' });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'INPUT_ERROR');
    } finally {
        teardown();
    }
});

test('rejects relative image_path', async () => {
    setup();
    try {
        const result = await agentlux.execute({ image_path: 'relative/path.jpg' });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'INPUT_ERROR');
    } finally {
        teardown();
    }
});

test('rejects non-existent file', async () => {
    setup();
    try {
        const result = await agentlux.execute({ image_path: '/tmp/agentlux_nonexistent_' + Date.now() + '.jpg' });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'INPUT_ERROR');
    } finally {
        teardown();
    }
});

test('rejects missing API keys', async () => {
    delete process.env.OPENAI_API_KEY;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = async () => mockOpenAIResponse({ x: 0, y: 0, width: 30, height: 30, rule: 'r' });

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'CONFIG_ERROR');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('rejects string delete_after to prevent truthy misuse', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: 'false' });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'INPUT_ERROR');
        await fs.access(imagePath);
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Deletion failure ---

test('delete_failed branch surfaces status and message', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        DEFAULT_CURATOR,
        { x: 0, y: 0, width: 30, height: 30, rule: 'r' }
    );

    await fs.unlink(imagePath);
    await createFixtureImage(imagePath);
    await fs.chmod(tmpDir, 0o555);

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: true });
        assert.equal(result.status, 'success');
        assert.equal(result.source_file_deletion, 'delete_failed');
        assert.equal(typeof result.source_file_deletion_message, 'string');
        assert.ok(result.source_file_deletion_message.length > 0);
    } finally {
        await fs.chmod(tmpDir, 0o755);
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- VLM null/array defense ---

test('VLM returning null is VLM_SCHEMA_ERROR without retry', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    let fetchCalls = 0;
    global.fetch = async () => { fetchCalls += 1; return mockOpenAIResponse(null); };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'VLM_SCHEMA_ERROR');
        assert.equal(fetchCalls, 1, 'null crop must not trigger retries');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Timeout and 5xx retry ---

test('VLM_TIMEOUT on hung fetch', async () => {
    setup();
    process.env.AGENTLUX_VLM_TIMEOUT_MS = '100';
    process.env.AGENTLUX_VLM_MAX_RETRIES = '0';

    let mod;
    try {
        delete require.cache[require.resolve('../index.js')];
        mod = require('../index.js');
    } finally {
        delete process.env.AGENTLUX_VLM_TIMEOUT_MS;
        delete process.env.AGENTLUX_VLM_MAX_RETRIES;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    global.fetch = async (_url, opts) => {
        await new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        });
    };

    try {
        const result = await mod.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'VLM_TIMEOUT');
    } finally {
        delete require.cache[require.resolve('../index.js')];
        require('../index.js');
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('HTTP 503 retries then succeeds', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
            return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'overloaded' };
        }
        if (fetchCalls === 2) return mockOpenAIResponse(DEFAULT_CURATOR);
        return mockOpenAIResponse({ x: 5, y: 5, width: 40, height: 30, rule: '503 retry' });
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(fetchCalls, 3, '503 should be retried once then curator + master succeed');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Burst mode ---

test('burst mode selects decisive moment from multiple images', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const paths = [];
    for (let i = 0; i < 3; i++) {
        const p = path.join(tmpDir, `burst_${i}.jpg`);
        await createFixtureImage(p);
        paths.push(p);
    }

    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) return mockOpenAIResponse({ selected_index: 1, rationale: 'Peak gesture' });
        if (fetchCalls === 2) return mockOpenAIResponse(DEFAULT_CURATOR);
        return mockOpenAIResponse({ x: 5, y: 5, width: 40, height: 30, rule: 'Burst composition' });
    };

    try {
        const result = await agentlux.execute({ image_paths: paths, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.burst_selection.selected_index, 1);
        assert.equal(result.burst_selection.total_images, 3);
        assert.equal(typeof result.burst_selection.rationale, 'string');
        assert.equal(fetchCalls, 3);
        for (const p of paths) await fs.access(p);
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('burst mode rejects exceeding max burst size', async () => {
    setup();
    const paths = Array.from({ length: 25 }, (_, i) => `/tmp/burst_${i}.jpg`);
    try {
        const result = await agentlux.execute({ image_paths: paths, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'INPUT_ERROR');
        assert.ok(result.message.includes('burst size'));
    } finally {
        teardown();
    }
});

test('burst mode rejects providing both image_path and image_paths', async () => {
    setup();
    try {
        const result = await agentlux.execute({ image_path: '/tmp/a.jpg', image_paths: ['/tmp/b.jpg'] });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'INPUT_ERROR');
    } finally {
        teardown();
    }
});

// --- Multi-master curator defaults gracefully ---

test('curator defaults to bresson/m10/summilux when VLM returns unexpected keys', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    global.fetch = mockTwoPass(
        { unknown_field: true },
        { x: 10, y: 10, width: 50, height: 30, rule: 'Default master' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.master_photographer, 'Henri Cartier-Bresson');
        assert.equal(result.color_profile, 'Leica M10 Digital');
        assert.equal(result.lens_profile, 'Summilux-M 35mm f/1.4 ASPH');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Agent-native features ---

test('output_path writes JPEG to disk instead of returning data URI', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    const outPath = path.join(tmpDir, 'out.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        DEFAULT_CURATOR,
        { x: 5, y: 5, width: 50, height: 30, rule: 'Output path test' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, output_path: outPath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.output_path, outPath);
        assert.equal(result.image_data_uri, undefined, 'data URI should be omitted when output_path is set');
        const stat = await fs.stat(outPath);
        assert.ok(stat.size > 0, 'output file should have content');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('success response includes presentation narrative', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { master: 'fan_ho', color_profile: 'm_monochrom', lens: 'noctilux_50', master_rationale: 'Strong shadows', color_rationale: 'Dramatic B&W', lens_rationale: 'Dreamy rendering' },
        { x: 10, y: 10, width: 60, height: 40, rule: 'Diagonal light shaft' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(typeof result.presentation, 'string');
        assert.ok(result.presentation.includes('Fan Ho'), 'presentation should mention the master');
        assert.ok(result.presentation.includes('Leica M Monochrom'), 'presentation should mention color profile');
        assert.ok(result.presentation.includes('Noctilux'), 'presentation should mention lens');
        assert.equal(result.master_photographer, 'Fan Ho');
        assert.equal(result.color_profile, 'Leica M Monochrom');
        assert.equal(result.lens_profile, 'Noctilux-M 50mm f/0.95 ASPH');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('language parameter produces localized presentation', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { master: 'fan_ho', color_profile: 'm_monochrom', lens: 'noctilux_50',
          master_rationale: '光影对比强烈', color_rationale: '极致黑白', lens_rationale: '梦幻虚化' },
        { x: 10, y: 10, width: 60, height: 40, rule: '对角线光束构成强烈的引导线' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, language: 'zh', delete_after: false });
        assert.equal(result.status, 'success');
        assert.ok(result.presentation.includes('Fan Ho'), 'presentation should include master name');
        assert.ok(result.presentation.includes('对角线光束'), 'presentation should include localized rule');
        assert.ok(!result.presentation.includes('Recomposed through'), 'non-en presentation should not use English template');
        assert.equal(result.master_rationale, '光影对比强烈');
        assert.equal(result.composition_rule, '对角线光束构成强烈的引导线');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('output_path with nonexistent parent directory returns INPUT_ERROR', async () => {
    setup();
    try {
        const result = await agentlux.execute({
            image_path: '/tmp/agentlux_test_dummy.jpg',
            output_path: '/nonexistent_dir_xyz_' + Date.now() + '/out.jpg',
            delete_after: false
        });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'INPUT_ERROR');
        assert.ok(result.message.includes('parent directory'));
    } finally {
        teardown();
    }
});

test('burst mode partial deletion tracked correctly', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const lockedDir = path.join(tmpDir, 'locked');
    await fs.mkdir(lockedDir);

    const normalPath = path.join(tmpDir, 'normal.jpg');
    const lockedPath = path.join(lockedDir, 'locked.jpg');
    await createFixtureImage(normalPath);
    await createFixtureImage(lockedPath);

    await fs.chmod(lockedDir, 0o555);

    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) return mockOpenAIResponse({ selected_index: 0, rationale: 'Pick first' });
        if (fetchCalls === 2) return mockOpenAIResponse(DEFAULT_CURATOR);
        return mockOpenAIResponse({ x: 5, y: 5, width: 40, height: 30, rule: 'Partial test' });
    };

    try {
        const result = await agentlux.execute({ image_paths: [normalPath, lockedPath], delete_after: true });
        assert.equal(result.status, 'success');
        assert.equal(result.source_file_deletion, 'partial');
        assert.equal(typeof result.source_file_deletion_message, 'string');
        assert.ok(result.source_file_deletion_message.includes('deleted'));
        assert.ok(result.source_file_deletion_message.includes('failed'));
    } finally {
        await fs.chmod(lockedDir, 0o755);
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Aesthetic Intelligence: Composition Gate ---

test('excellent composition + crop_recommended=false → identity crop and no "Recomposed" narrative', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath, 120, 80);

    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        return mockOpenAIResponse({
            master: 'bresson', color_profile: 'm10', lens: 'summilux_35',
            master_rationale: 'Geometry', color_rationale: 'Natural', lens_rationale: 'Classic',
            composition_quality: 'excellent', crop_recommended: false,
            crop_rationale: 'Strong leading lines and balanced framing',
            processing_intensity: 'moderate', grain_appropriate: false, vignette_intensity: 'subtle'
        });
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(fetchCalls, 1, 'identity crop path should skip master VLM call');
        assert.equal(result.coordinates.x, 0);
        assert.equal(result.coordinates.y, 0);
        assert.equal(result.coordinates.width, 120);
        assert.equal(result.coordinates.height, 80);
        assert.equal(result.composition_assessment.quality, 'excellent');
        assert.equal(result.composition_assessment.crop_applied, false);
        assert.ok(!result.presentation.includes('Recomposed'), 'preserved composition should not say Recomposed');
        assert.ok(result.presentation.includes('Your composition captures'), 'should acknowledge original composition');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('fair composition + crop_recommended=true → normal master crop', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { ...DEFAULT_CURATOR, composition_quality: 'fair', crop_recommended: true, processing_intensity: 'full', grain_appropriate: true, vignette_intensity: 'standard' },
        { x: 10, y: 10, width: 60, height: 40, rule: 'Diagonal tension' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.composition_assessment.quality, 'fair');
        assert.equal(result.composition_assessment.crop_applied, true);
        assert.ok(result.presentation.includes('Recomposed'), 'cropped image should say Recomposed');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Aesthetic Intelligence: Effects Override ---

test('grain_appropriate=false skips grain even when profile has grain config', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { master: 'bresson', color_profile: 'm_monochrom', lens: 'summilux_35',
          master_rationale: 'R', color_rationale: 'R', lens_rationale: 'R',
          composition_quality: 'good', crop_recommended: true,
          processing_intensity: 'moderate', grain_appropriate: false, vignette_intensity: 'standard' },
        { x: 5, y: 5, width: 50, height: 30, rule: 'Chiaroscuro' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.processing_applied.grain_applied, false, 'grain should be skipped when grain_appropriate=false');
        assert.equal(result.processing_applied.color_graded, true);
        assert.equal(result.color_profile, 'Leica M Monochrom');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('vignette_intensity="none" produces no vignette', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { ...DEFAULT_CURATOR, composition_quality: 'good', crop_recommended: true,
          processing_intensity: 'moderate', grain_appropriate: false, vignette_intensity: 'none' },
        { x: 5, y: 5, width: 50, height: 30, rule: 'Test' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.processing_applied.vignette_level, 'none');
        assert.ok(!result.presentation.includes('Lens character'), 'no vignette → no lens character in narrative');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('vignette_intensity="dramatic" scales vignette strength up', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { ...DEFAULT_CURATOR, composition_quality: 'fair', crop_recommended: true,
          processing_intensity: 'full', grain_appropriate: true, vignette_intensity: 'dramatic' },
        { x: 5, y: 5, width: 50, height: 30, rule: 'Drama' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.processing_applied.vignette_level, 'dramatic');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Aesthetic Intelligence: Minimal Processing ---

test('processing_intensity="minimal" applies only color grading', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { ...DEFAULT_CURATOR, composition_quality: 'good', crop_recommended: true,
          processing_intensity: 'minimal', grain_appropriate: true, vignette_intensity: 'standard' },
        { x: 5, y: 5, width: 50, height: 30, rule: 'Minimal test' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.processing_applied.grain_applied, false, 'minimal processing skips grain');
        assert.equal(result.processing_applied.vignette_level, 'none', 'minimal processing forces vignette to none');
        assert.equal(result.processing_applied.color_graded, true);
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Aesthetic Intelligence: Restraint Narrative ---

test('restraint narrative in non-English for preserved composition', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath, 120, 80);

    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls += 1;
        return mockOpenAIResponse({
            master: 'fan_ho', color_profile: 'm_monochrom', lens: 'noctilux_50',
            master_rationale: '光影几何', color_rationale: '极致黑白', lens_rationale: '梦幻散景',
            composition_quality: 'excellent', crop_recommended: false,
            crop_rationale: '构图已经很完美',
            processing_intensity: 'moderate', grain_appropriate: false, vignette_intensity: 'subtle'
        });
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, language: 'zh', delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(fetchCalls, 1);
        assert.ok(!result.presentation.includes('Recomposed'), 'non-en preserved should not say Recomposed');
        assert.ok(result.presentation.includes('构图已经很完美'), 'should include crop rationale in presentation');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test('processing_applied summary is correct for full processing path', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { master: 'moriyama', color_profile: 'm6_trix400', lens: 'elmarit_28',
          master_rationale: 'Raw', color_rationale: 'Gritty', lens_rationale: 'Wide',
          composition_quality: 'poor', crop_recommended: true,
          processing_intensity: 'full', grain_appropriate: true, vignette_intensity: 'dramatic' },
        { x: 10, y: 10, width: 50, height: 30, rule: 'Visceral crop' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.processing_applied.cropped, true);
        assert.equal(result.processing_applied.grain_applied, true, 'full processing + grain profile should apply grain');
        assert.equal(result.processing_applied.vignette_level, 'dramatic');
        assert.equal(result.processing_applied.color_graded, true);
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Backward Compatibility with Aesthetic Intelligence ---

test('legacy curator response (no new fields) produces full processing with defaults', async () => {
    setup();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);
    global.fetch = mockTwoPass(
        { master: 'bresson', color_profile: 'm_monochrom', lens: 'summilux_35',
          master_rationale: 'Geometry', color_rationale: 'Classic B&W', lens_rationale: 'Sharp' },
        { x: 10, y: 10, width: 60, height: 40, rule: 'Golden ratio' }
    );

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(result.composition_assessment.quality, 'fair', 'legacy default should be fair');
        assert.equal(result.composition_assessment.crop_applied, true, 'legacy default should crop');
        assert.equal(result.processing_applied.grain_applied, true, 'legacy default should apply grain from M Monochrom');
        assert.equal(result.processing_applied.vignette_level, 'standard', 'legacy default vignette should be standard');
        assert.equal(result.processing_applied.color_graded, true);
        assert.ok(result.presentation.includes('Recomposed'), 'legacy path should behave as before');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

// --- Original tests continue ---

test('error responses include recovery_hint for agent self-healing', async () => {
    setup();
    process.env.AGENTLUX_VLM_MAX_RETRIES = '0';

    let mod;
    try {
        delete require.cache[require.resolve('../index.js')];
        mod = require('../index.js');
    } finally {
        delete process.env.AGENTLUX_VLM_MAX_RETRIES;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlux-'));
    const imagePath = path.join(tmpDir, 'in.jpg');
    await createFixtureImage(imagePath);

    global.fetch = async () => { throw new Error('connection refused'); };

    try {
        const result = await mod.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(typeof result.recovery_hint, 'string');
        assert.ok(result.recovery_hint.length > 0, 'recovery_hint should not be empty');
    } finally {
        delete require.cache[require.resolve('../index.js')];
        require('../index.js');
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});
