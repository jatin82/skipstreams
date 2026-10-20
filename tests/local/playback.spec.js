const { test, expect } = require('@playwright/test');
const { createFixture, BREW_HOME } = require('./fixtures');

test('Prime rejects app playback links and selects the web playback control', async ({ page }) => {
	const fixture = await createFixture(page, 'prime', { appDuplicate: true });
	await fixture.openMovie();
	await expect.poll(() => page.evaluate(() => window.__localTest.clicks.length)).toBe(1);
	expect(new URL(await page.evaluate(() => window.__localTest.clicks[0].href)).hostname).toBe('www.primevideo.com');
});

test('Prime never clicks an app-only playback control', async ({ page }) => {
	const fixture = await createFixture(page, 'prime', { appLink: true });
	await fixture.openMovie();
	await page.waitForTimeout(1200);
	expect(await page.evaluate(() => window.__localTest.clicks.length)).toBe(0);
});

test('Prime app splash shows an error instead of reopening the movie selector', async ({ page }) => {
	await createFixture(page, 'prime');
	await page.goto('https://www.primevideo.com/splash/t/getTheApp');
	await expect(page.locator('#prime-tizen-playback-error')).toContainText('instead of web playback');
	await expect(page.locator('#prime-tizen-movie-list')).toHaveCount(0);
});

test('Prime traces picker navigation and Back without logging query parameters', async ({ page }) => {
	const traces = [];
	page.on('console', message => {
		if (message.text().includes('[PrimeTizen] Trace')) traces.push(message.text());
	});
	const fixture = await createFixture(page, 'prime');
	await fixture.openPicker();
	await expect(page.locator('#prime-tizen-movie-list')).toContainText('Movie 1');
	await page.keyboard.press('Enter');
	await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
	await page.keyboard.press('Escape');
	await expect(page.locator('#prime-tizen-movie-list')).toBeVisible();
	for (const event of ['document-start', 'picker-start-decision', 'picker-choose', 'autoplay-click', 'back-key', 'show-movie-list']) {
		expect(traces.some(line => line.includes(event)), event).toBe(true);
	}
	expect(traces.join('\n')).not.toContain('ref_=');
	expect(traces.join('\n')).not.toContain('autoplay=1');
});

for (const mode of ['watch', 'resume']) {
	test('Prime selects a movie and clicks ' + mode + ' without changing its start time', async ({ page }) => {
		const fixture = await createFixture(page, 'prime', { mode });
		await fixture.openPicker();
		await expect(page.locator('#prime-tizen-movie-list')).toContainText('Movie 1');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(fixture.movieUrl);
		await expect.poll(() => page.evaluate(() => window.__localTest.clicks.length)).toBe(1);
		const click = await page.evaluate(() => window.__localTest.clicks[0]);
		expect(click.text).toBe(mode === 'resume' ? 'Resume Episode 1' : 'Watch now');
		expect(new URL(click.href).searchParams.get('t')).toBe(mode === 'resume' ? '125' : '0');
		expect(new URL(click.href).searchParams.get('autoplay')).toBe('1');
		expect(new URL(click.href).searchParams.get('ref_')).toBe('local-fixture');
		await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
		expect(fixture.state.errors).toEqual([]);
	});
}

test('Prime ignores hidden duplicates and waits for an enabled playback control', async ({ page }) => {
	const fixture = await createFixture(page, 'prime', { mode: 'resume', hiddenDuplicate: true, disabled: true });
	await fixture.openMovie();
	await expect.poll(() => page.evaluate(() => window.__localTest.clicks.length)).toBe(1);
	const click = await page.evaluate(() => window.__localTest.clicks[0]);
	expect(click.text).toBe('Resume Episode 1');
	expect(new URL(click.href).searchParams.get('t')).toBe('125');
	expect(fixture.state.errors).toEqual([]);
});

test('Prime supports the stable automation ID without relying on generated CSS classes', async ({ page }) => {
	const fixture = await createFixture(page, 'prime', { automationOnly: true });
	await fixture.openMovie();
	await expect.poll(() => page.evaluate(() => window.__localTest.clicks.length)).toBe(1);
	expect(fixture.state.errors).toEqual([]);
});

test('Prime retries an ignored click and sends the full press sequence', async ({ page }) => {
	const fixture = await createFixture(page, 'prime', { mode: 'resume', ignoreClicks: 1, requirePress: true });
	await fixture.openMovie();
	await expect.poll(() => page.evaluate(() => window.__localTest.clicks.length), { timeout: 10000 }).toBe(1);
	await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
	expect(await page.locator('video').evaluate(video => video.currentTime)).toBe(125);
	expect(fixture.state.errors).toEqual([]);
});

test('Prime leaves page animations and videos outside the player container unrestricted', async ({ page }) => {
	const fixture = await createFixture(page, 'prime', { alreadyPlaying: true });
	await fixture.openMovie();
	expect(await page.locator('#prime-tizen-no-anim').count()).toBe(0);
	const state = await page.evaluate(async () => {
		const video = document.createElement('video');
		document.body.appendChild(video);
		await video.play();
		const animation = video.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 });
		const result = { paused: video.paused, muted: video.muted, duration: animation.effect.getTiming().duration };
		animation.cancel();
		video.remove();
		return result;
	});
	expect(state).toEqual({ paused: false, muted: false, duration: 1000 });
	expect(fixture.state.errors).toEqual([]);
});

test('Prime does not click again or reset the position when playback is already active', async ({ page }) => {
	const fixture = await createFixture(page, 'prime', { mode: 'resume', alreadyPlaying: true });
	await fixture.openMovie();
	await page.waitForTimeout(1000);
	expect(await page.evaluate(() => window.__localTest.clicks)).toEqual([]);
	expect(await page.locator('video').evaluate(video => video.currentTime)).toBe(200);
	expect(fixture.state.errors).toEqual([]);
});

for (const site of ['prime', 'hotstar']) {
	test(site + ': Back pauses playback, opens the list, then returns to TizenBrew', async ({ page }) => {
		const fixture = await createFixture(page, site);
		await fixture.openMovie();
		await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
		await page.keyboard.press('Escape');
		await expect(page.locator('#prime-tizen-movie-list')).toBeVisible();
		await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(true);
		expect(fixture.state.returns).toEqual([]);
		const key = await page.evaluate(() => window.__localTest.keys.at(-1));
		expect(key).toEqual({ code: 10009, trusted: true });
		await page.keyboard.press('Escape');
		await expect(page).toHaveURL(BREW_HOME);
		await expect(page.getByRole('heading', { name: 'TizenBrew module screen' })).toBeVisible();
		expect(fixture.state.returns).toEqual(['home']);
		expect(fixture.state.activeModule).toBe(null);
		expect(fixture.state.errors).toEqual([]);
	});

	test(site + ': Exit app returns to TizenBrew, not the Samsung launcher', async ({ page }) => {
		const fixture = await createFixture(page, site);
		await fixture.openPicker();
		await expect(page.locator('#prime-tizen-movie-list')).toContainText('Exit app');
		await expect(page.locator('#prime-tizen-movie-list')).not.toContainText('Loading movie list');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(BREW_HOME);
		expect(fixture.state.returns).toEqual(['home']);
		expect(fixture.state.errors).toEqual([]);
	});

	test(site + ': missing service bridge stays on the list and shows an actionable error', async ({ page }) => {
		const fixture = await createFixture(page, site, { bridge: false });
		await fixture.openPicker();
		await expect(page.locator('#prime-tizen-movie-list')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('#prime-tizen-movie-list')).toContainText('Return to TizenBrew is unavailable');
		expect(await page.evaluate(() => ({ exits: window.__localTest.exits, closes: window.__localTest.closes })))
			.toEqual({ exits: 0, closes: 0 });
		expect(fixture.state.errors).toEqual([]);
	});

	test(site + ': artwork is stripped without removing the video source', async ({ page }) => {
		const fixture = await createFixture(page, site);
		await fixture.openMovie();
		await expect(page.getByTestId('artwork')).not.toHaveAttribute('src');
		await expect(page.getByTestId('artwork-source')).not.toHaveAttribute('srcset');
		await expect(page.getByTestId('media-source')).toHaveAttribute('src', 'https://media.test/movie.mp4');
		expect(fixture.state.errors).toEqual([]);
	});
}
