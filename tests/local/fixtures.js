const fs = require('node:fs');
const path = require('node:path');

const PRIME_MOVIE = 'https://www.primevideo.com/detail/0OML6W0QFI45I4D5HK2UTCGGFQ';
const HOTSTAR_MOVIE = 'https://www.hotstar.com/in/movies/local-test/12345/watch';
const BREW_HOME = 'https://tizenbrew.test/home';

function installPlatformMock() {
	window.__localTest = { clicks: [], exits: 0, closes: 0, keys: [] };
	window.tizen = {
		tvinputdevice: { registerKey() {} },
		application: {
			getCurrentApplication: () => ({ exit() { window.__localTest.exits++; } }),
			launchAppControl() { throw new Error('Local tests must never start a TV service'); },
		},
	};
	window.close = () => { window.__localTest.closes++; };
	window.addEventListener('keydown', event => {
		// A real desktop Escape key stands in for the TV's trusted Return key.
		if (event.key === 'Escape') Object.defineProperty(event, 'keyCode', { value: 10009 });
		window.__localTest.keys.push({ code: event.keyCode, trusted: event.isTrusted });
	}, true);
	const media = new WeakMap();
	function state(video) {
		if (!media.has(video)) media.set(video, { paused: true, time: 0 });
		return media.get(video);
	}
	Object.defineProperties(HTMLMediaElement.prototype, {
		paused: { configurable: true, get() { return state(this).paused; } },
		currentTime: { configurable: true, get() { return state(this).time; }, set(value) { state(this).time = value; } },
		duration: { configurable: true, get() { return 3600; } },
		readyState: { configurable: true, get() { return 4; } },
	});
	HTMLMediaElement.prototype.play = function () {
		state(this).paused = false;
		this.dispatchEvent(new Event('play'));
		return Promise.resolve();
	};
	HTMLMediaElement.prototype.pause = function () {
		state(this).paused = true;
		this.dispatchEvent(new Event('pause'));
	};
	document.addEventListener('DOMContentLoaded', () => {
		const video = document.querySelector('video');
		const player = document.getElementById('dv-web-player');
		document.querySelectorAll('a[data-local-play]').forEach(button => {
			button.addEventListener('click', event => {
				event.preventDefault();
				window.__localTest.clicks.push({ text: button.textContent.trim(), href: button.href });
				video.currentTime = Number(new URL(button.href).searchParams.get('t'));
				document.getElementById('title-controls').hidden = true;
				player.hidden = false;
				video.play();
			});
			if (button.dataset.enableAfter) {
				setTimeout(() => button.setAttribute('aria-disabled', 'false'), Number(button.dataset.enableAfter));
			}
		});
		if (video && player && !player.hidden) {
			video.currentTime = Number(player.dataset.startTime || 0);
			video.play();
		}
	});
}

function playbackLink({ mode, automationOnly, disabled, hidden = false }) {
	const resume = mode === 'resume';
	const time = hidden ? 999 : resume ? 125 : 0;
	const label = hidden ? 'Hidden duplicate' : resume ? 'Resume Episode 1' : 'Watch now';
	return `<a data-local-play class="${automationOnly ? 'play-action' : '_1jWggM BLmu_g fbl-play-btn fbl-btn'}"
		${automationOnly ? '' : 'data-testid="dp-atf-play-button"'}
		data-automation-id="dp-atf-play-button" role="button" aria-disabled="${disabled ? 'true' : 'false'}"
		${disabled ? 'data-enable-after="600"' : ''} ${hidden ? 'style="visibility:hidden"' : ''}
		href="/detail/0OML6W0QFI45I4D5HK2UTCGGFQ?autoplay=1&amp;t=${time}&amp;ref_=local-fixture">
		<span><span>${label}</span></span></a>`;
}

function documentHtml(site, options, picker) {
	const prime = site === 'prime';
	const controls = prime && !picker ? (options.hiddenDuplicate ? playbackLink({ ...options, hidden: true }) : '') +
		`<div class="mVyVPA BLmu_g dv-dp-node-playback">${options.mode === 'resume' ? '<div class="_3AXaee">' : ''}
		${playbackLink(options)}${options.mode === 'resume' ?
			'<span class="fbl-progress-bar"><span aria-valuenow="4" style="width:4%"></span></span></div>' : ''}</div>` : '';
	return `<!doctype html><html><head><title>LOCAL ${site} fixture</title>
		<link rel="icon" href="data:,"><style>
		body{margin:0;padding:40px;background:#172033;color:white;font:24px sans-serif}
		[hidden]{display:none!important}a{display:inline-block;padding:20px;color:white;background:#17659a}
		#dv-web-player{width:960px;height:540px}video{width:100%;height:100%}
		#local-badge{position:fixed;right:10px;top:10px;z-index:2147483647;background:#000;padding:8px;font:14px sans-serif;pointer-events:none}
		</style></head><body><div id="local-badge">LOCAL MOCK | no real playback/account. Esc = TV Back</div>
		<h1>${site} local test</h1><div id="title-controls">${controls}</div>
		<div id="dv-web-player" data-testid="webPlayerUIContainer" data-start-time="${options.alreadyPlaying ? 200 : 0}"
			${prime && !options.alreadyPlaying || picker ? 'hidden' : ''}>
			<video preload="none"><source data-testid="media-source" src="https://media.test/movie.mp4"></video>
		</div>
		<picture><source data-testid="artwork-source" srcset="https://images.test/poster.webp">
			<img data-testid="artwork" src="https://images.test/poster.jpg"></picture>
		</body></html>`;
}

async function createFixture(page, site, options = {}) {
	options = { mode: 'watch', bridge: true, ...options };
	const origin = site === 'prime' ? 'https://www.primevideo.com' : 'https://www.hotstar.com';
	const movieUrl = site === 'prime' ? PRIME_MOVIE : HOTSTAR_MOVIE;
	const state = { activeModule: site, returns: [], blockedRequests: [], errors: [] };
	page.on('pageerror', error => state.errors.push(error.message));
	await page.route('**/*', async route => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.isNavigationRequest() && url.origin === new URL(BREW_HOME).origin) {
			await route.fulfill({ contentType: 'text/html',
				body: '<!doctype html><title>LOCAL TizenBrew</title><h1>TizenBrew module screen</h1><p>No active module</p>' });
		} else if (request.isNavigationRequest() && url.origin === origin) {
			await route.fulfill({ contentType: 'text/html', body: documentHtml(site, options, url.pathname === '/robots.txt') });
		} else if (url.hostname === 'edrive.blackmushroom-4418eafb.southindia.azurecontainerapps.io' &&
			url.pathname === '/public/download/tizenMoviesToPlay.json') {
			await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
				body: JSON.stringify({ amazonPrime: [PRIME_MOVIE], jioHotstar: [HOTSTAR_MOVIE] }) });
		} else {
			state.blockedRequests.push(request.url());
			await route.abort('blockedbyclient');
		}
	});
	if (options.bridge) {
		await page.exposeFunction('__tizenBrewReturnToHome', async payload => {
			state.returns.push(payload);
			state.activeModule = null;
			await page.goto(BREW_HOME);
		});
	}
	const filename = site === 'prime' ? path.join(__dirname, '..', '..', 'userScript.js') :
		path.join(__dirname, '..', '..', 'hotstar', 'userScript.js');
	const script = fs.readFileSync(filename, 'utf8');
	await page.addInitScript({
		content: '(' + installPlatformMock.toString() + ')();\n' +
			'if (location.hostname === ' + JSON.stringify(new URL(origin).hostname) + ') {\n' + script + '\n}',
	});
	return {
		state, movieUrl,
		openPicker: () => page.goto(origin + '/robots.txt', { waitUntil: 'commit' }),
		openMovie: () => page.goto(movieUrl),
	};
}

module.exports = { createFixture, BREW_HOME };
