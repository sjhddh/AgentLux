# AgentLux QA Review Report

## Scope
- Repository: AgentLux
- Review mode: full-repo QA audit (correctness, reliability, security, regression safety)
- Product decision locked: `delete_after=true` default is intentional and preserved

## Design-Confirmed Items (Not Defects)
- Default source file deletion (`delete_after=true`) remains the expected plug-and-play behavior.
- Review treats this as policy, and evaluates only controllability/visibility around it.

## Findings by Severity

### Critical
1. No automated regression gates
   - Evidence: `package.json` test script was placeholder, no CI workflow.
   - Impact: high risk of shipping breakages undetected.
   - Resolution: added `node --test` suite and GitHub Actions CI matrix.
   - Status: fixed.

### High
1. Unvalidated VLM payload used directly in crop math
   - Evidence: direct JSON parse and field trust in runtime path.
   - Impact: malformed model output could crash or create invalid crop.
   - Resolution: added schema validation + typed parsing + defensive sanitization.
   - Status: fixed.

2. No timeout/retry for external vision call
   - Evidence: raw `fetch` call without timeout/backoff.
   - Impact: hanging requests and fragile transient failure behavior.
   - Resolution: added timeout (`AbortController`), bounded retries, exponential backoff.
   - Status: fixed.

3. Weak error classification
   - Evidence: generic `{ status: "error", message }` only.
   - Impact: poor operability and ambiguous caller behavior.
   - Resolution: introduced structured `error_code` and optional `details`.
   - Status: fixed.

### Medium
1. Input/path boundary assumptions
   - Evidence: no absolute-path check, no pre-stat validation, no size limits.
   - Impact: reliability issues and potential misuse of arbitrary paths.
   - Resolution: added absolute path check, file existence/type checks, max size guard.
   - Status: fixed.

2. Metadata assumptions on width/height
   - Evidence: pipeline relied on width/height presence without validation.
   - Impact: runtime failures on malformed images.
   - Resolution: metadata positive-integer validation added.
   - Status: fixed.

3. Source deletion observability gap
   - Evidence: unlink failure only logged to console, not surfaced in API result.
   - Impact: callers cannot reliably reason about retention outcome.
   - Resolution: result now exposes `source_file_deletion` and message on failure.
   - Status: fixed.

### Low
1. Docs/implementation mismatch on provider support
   - Evidence: docs implied multi-provider support while runtime is OpenAI-only.
   - Impact: operator confusion and onboarding errors.
   - Resolution: aligned docs to OpenAI-only runtime contract and env vars.
   - Status: fixed.

## Implemented Changes
- Runtime hardening in `index.js`
  - `AgentLuxError` with stable error codes
  - input/file/size/metadata validation
  - VLM timeout/retry/backoff and structured HTTP parse
  - crop schema parse + bound sanitization with min dimensions
  - explicit source deletion status in success payload
- Regression gates
  - `test/index.test.js` with 5 deterministic tests:
    - default deletion behavior
    - `delete_after=false` retention
    - VLM schema failure path
    - transient network retry success
    - crop bounds clamping and min-size enforcement
  - `package.json` test script to `node --test`
  - `.github/workflows/ci.yml` for Node 20/22
- Contract alignment
  - README and SKILL updated to match real runtime behavior and env contract.

## Second-Pass Review Findings (post-fix audit)

### High
1. Non-retryable errors were retried
   - Evidence: `VLM_SCHEMA_ERROR`, `VLM_PARSE_ERROR`, and HTTP 4xx all entered the retry loop with backoff, wasting time and API calls.
   - Impact: schema error test took 605ms instead of ~12ms; deterministic failures burned retry budget.
   - Resolution: classified error codes into retryable (`VLM_TIMEOUT`, `VLM_NETWORK_ERROR`, `VLM_HTTP_TRANSIENT` for 5xx/429) vs non-retryable; break immediately on non-retryable.
   - Status: fixed.

### Medium
1. Dead code in `applyLeicaM10Color`
   - Evidence: `cx`, `cy`, `r` variables computed but never used (SVG uses percentage-based gradient).
   - Resolution: removed the three unused variables.
   - Status: fixed.

2. Fragile environment variable parsing
   - Evidence: `Number("abc")` returns `NaN`, causing silent config corruption at module load.
   - Resolution: added `envInt()` helper with validation and fail-fast on invalid values.
   - Status: fixed.

3. No input validation test coverage
   - Evidence: report claimed input validation was fixed, but zero tests exercised those paths.
   - Resolution: added 4 tests: empty path, relative path, non-existent file, missing API key.
   - Status: fixed.

### Low
1. Test environment leakage
   - Evidence: `process.env.OPENAI_API_KEY` was set in each test but never restored.
   - Resolution: added `setup()`/`teardown()` helpers that save and restore env + `global.fetch`.
   - Status: fixed.

## Test Evidence
- Command: `npm test`
- Result: 10 passed, 0 failed (5 original + 5 new)

## Priority Roadmap
- P0 (done): runtime guardrails + error taxonomy + core tests
- P1 (done): docs/contract alignment + CI test gate
- P1.5 (done): retry correctness + env validation + input validation tests + test isolation
- P2 (recommended next):
  - add lightweight lint/check gate
  - add optional structured logs with request correlation
  - add load tests for large-image throughput profile

## Release Blockers
- None remaining for the scoped plan.
- Recommended pre-release checks:
  - verify `OPENAI_API_KEY` present in deployment env
  - verify `AGENTLUX_MAX_IMAGE_BYTES` policy matches production limits

