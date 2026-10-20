const { test, expect } = require('@playwright/test');
const { createFixture, BREW_HOME } = require('./fixtures');

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
