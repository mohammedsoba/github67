// Playwright config for the E2E smoke test. It boots a REAL uvicorn instance of the FastAPI app
// (which also serves index.html/js/css), so the browser talks to the genuine backend + ONNX models.
// Set E2E_BASE_URL to test an already-running server instead (no server is started then).
const { defineConfig, devices } = require('@playwright/test');

const PORT = process.env.E2E_PORT || '8765';
const externalBase = process.env.E2E_BASE_URL;
const python = process.env.E2E_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 170_000,                       // hard budget < 3 min for the whole smoke flow
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,                             // a flaky smoke test is a bug, not something to retry away
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBase || `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
  webServer: externalBase ? undefined : {
    command: `${python} -m uvicorn backend.app.main:app --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,                     // model loading happens in the FastAPI lifespan, before the port opens
    env: { LAMA_PROVIDER: 'cpu', PORTRAIT_PROVIDER: 'cpu', LAMA_WARMUP_PASSES: '0', PYTHONUNBUFFERED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
