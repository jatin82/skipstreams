const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixtures');

for (const site of ['prime', 'hotstar']) {
	test(site + ': trusted Volume Up unmutes playback and still propagates normally', async ({ page }) => {
		const fixture = await createFixture(page, site, { alreadyPlaying: true });
		await fixture.openMovie();
		const video = page.locator('video');
		await expect(video).toHaveJSProperty('paused', false);
		await page.evaluate(() => {
			document.querySelector('video').muted = true;
			window.__volumeEvents = [];
			window.addEventListener('keydown', event => {
				if (event.key === 'AudioVolumeUp') window.__volumeEvents.push({
					trusted: event.isTrusted, prevented: event.defaultPrevented,
				});
			});
		});
		const session = await page.context().newCDPSession(page);
		await session.send('Input.dispatchKeyEvent', {
			type: 'keyDown', key: 'AudioVolumeUp', code: 'AudioVolumeUp',
			windowsVirtualKeyCode: 175, nativeVirtualKeyCode: 447,
		});
		await expect(video).toHaveJSProperty('muted', false);
		expect(await page.evaluate(() => window.__volumeEvents)).toEqual([{ trusted: true, prevented: false }]);
		expect(fixture.state.errors).toEqual([]);
	});
}
