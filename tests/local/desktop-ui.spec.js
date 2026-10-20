const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startLivePreview } = require('../../local-tizenbrew');

const ui = path.join(__dirname, '..', '..', 'tv-app', 'dist', 'tizenbrew', 'debug-logs', 'ui', 'dist', 'index.html');

test('desktop navigation and service controls fit large and small browser windows', async () => {
	test.skip(!fs.existsSync(ui), 'Build the local TizenBrew UI to run its desktop layout check');
	const preview = await startLivePreview({ headless: true });
	try {
		for (const size of [{ width: 1800, height: 1000 }, { width: 800, height: 600 }, { width: 500, height: 700 }]) {
			await preview.page.setViewportSize(size);
			const controls = preview.page.locator('header button, .tv-service-panel button');
			await expect(controls).toHaveCount(6);
			for (const control of await controls.all()) {
				await expect(control).toBeVisible();
				const box = await control.boundingBox();
				expect(box.x).toBeGreaterThanOrEqual(0);
				expect(box.y).toBeGreaterThanOrEqual(0);
				expect(box.x + box.width).toBeLessThanOrEqual(size.width);
				expect(box.y + box.height).toBeLessThanOrEqual(size.height);
			}
		}
		expect(preview.service.handle({ operation: 'health' }).networkError).toBe(true);
	} finally {
		await preview.close();
	}
});
