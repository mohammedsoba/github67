// smoke.spec.js - the one end-to-end path that must never break:
//   load page -> upload photo -> photo visible -> Eraser: paint + "Remove with AI" (real /api/erase, real LaMa)
//   -> loading overlay disappears -> Save -> export modal -> a .png/.jpg download starts.
// Any uncaught page error (window 'pageerror') anywhere in the flow fails the test.
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const PHOTO = path.join(__dirname, 'fixtures', 'photo.jpg');

test('smoke: upload -> erase -> export, with zero uncaught frontend errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));

  // 1. Load the page (served by the live uvicorn instance).
  await page.goto('/');
  await expect(page.locator('#fileInput')).toBeAttached();
  await expect(page.locator('#loadingOverlay.active')).toHaveCount(0);

  // 2. Upload the fixture photo -> main image visible and really decoded.
  await page.setInputFiles('#fileInput', PHOTO);
  const main = page.locator('#mainImg');
  await expect(main).toBeVisible();
  await expect.poll(() => main.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator('#loadingOverlay.active')).toBeHidden({ timeout: 30_000 });   // "Loading image..." is done
  await expect(page.locator('#exportBtn')).toBeVisible();

  // 3. Eraser: open the Tools tab (Eraser is its default panel) and paint a stroke over the photo.
  await page.locator('.nav-tab').nth(1).click();
  await expect(page.locator('#p-eraser')).toBeVisible();
  await expect(page.locator('#me-paint-layer.on')).toBeAttached();
  const box = await main.boundingBox();
  expect(box && box.width > 50 && box.height > 50).toBeTruthy();
  const cx = box.x + box.width * 0.78, cy = box.y + box.height * 0.30;      // over the red block in the fixture
  await page.mouse.move(cx - 25, cy - 20);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx - 25 + i * 7, cy - 20 + i * 5, { steps: 3 });
  await page.mouse.up();
  const apply = page.locator('#me-apply');
  await expect(apply).toBeEnabled();

  // 4. Apply: the real backend must answer 200, and the loading overlay must show and then hide (<= 60 s).
  const erased = page.waitForResponse((r) => r.url().includes('/api/erase') && r.request().method() === 'POST', { timeout: 60_000 });
  await apply.click();
  const response = await erased;
  expect(response.status(), `POST /api/erase -> ${response.status()}`).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
  await expect(page.locator('#loadingOverlay.active')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#toast.error')).toHaveCount(0);   // no error toast after the run

  // 5. Export: modal opens, saving triggers a download whose extension is .png or .jpg.
  await page.locator('#exportBtn').click();
  await expect(page.locator('#exportModal.active')).toBeVisible();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.locator('#exportModal .quality-btn').nth(1).click();           // "Normal Quality" => JPEG
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.(png|jpg)$/i);
  await expect(page.locator('#loadingOverlay.active')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#exportModal.active')).toHaveCount(0);

  // 6. Zero uncaught errors across the entire flow.
  expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
});
