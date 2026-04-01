const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const agentlux = require('../index.js');

const SAVED_KEY = process.env.OPENAI_API_KEY;
const SAVED_FETCH = global.fetch;

function setup() {
    process.env.OPENAI_API_KEY = 'test-key';
}

function teardown() {
    global.fetch = SAVED_FETCH;
    if (SAVED_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = SAVED_KEY;
}

function mockOpenAIResponse(cropBox) {
    const payload = {
        choices: [{ message: { content: JSON.stringify(cropBox) } }]
    };
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(payload)
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
    global.fetch = async () => mockOpenAIResponse({ x: 10, y: 10, width: 60, height: 40, rule: 'rule' });

    try {
        const result = await agentlux.execute({ image_path: imagePath });
        assert.equal(result.status, 'success');
        assert.equal(result.source_file_deletion, 'deleted');
        assert.match(result.image_data_uri, /^data:image\/jpeg;base64,/);
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
    global.fetch = async () => mockOpenAIResponse({ x: 0, y: 0, width: 30, height: 30, rule: 'rule' });

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
    global.fetch = async () => { fetchCalls += 1; return mockOpenAIResponse({ x: 1, y: 1, height: 20, rule: 'missing width' }); };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'error');
        assert.equal(result.error_code, 'VLM_SCHEMA_ERROR');
        assert.equal(fetchCalls, 1, 'schema errors must not trigger retries');
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
        return mockOpenAIResponse({ x: 2, y: 2, width: 20, height: 20, rule: 'retry rule' });
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(calls, 2);
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
    global.fetch = async () => mockOpenAIResponse({ x: -100, y: 1000, width: -5, height: 9999, rule: 'extreme values' });

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

test('rejects missing OPENAI_API_KEY', async () => {
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
    global.fetch = async () => mockOpenAIResponse({ x: 0, y: 0, width: 30, height: 30, rule: 'r' });

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
        return mockOpenAIResponse({ x: 5, y: 5, width: 40, height: 30, rule: '503 retry' });
    };

    try {
        const result = await agentlux.execute({ image_path: imagePath, delete_after: false });
        assert.equal(result.status, 'success');
        assert.equal(fetchCalls, 2, '503 should be retried once then succeed');
    } finally {
        teardown();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});
