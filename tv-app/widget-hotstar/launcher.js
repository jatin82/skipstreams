(function () {
	'use strict';

	var SITE_URL = document.documentElement.getAttribute('data-url') || 'https://www.primevideo.com/';
	// The Tizen default UA can make Prime serve an "unsupported browser"/app-store page.
	// Set to '' to keep the TV's own user agent.
	var USER_AGENT =
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
	var KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
		'MediaFastForward', 'MediaRewind', 'ColorF0Red'];
	var LAUNCHED_FLAG = 'primeTizenNavigated';
	var KEY_ENTER = 13;
	var KEY_BACK = 10009;

	var statusEl = document.getElementById('status');
	var hintEl = document.getElementById('hint');
	var spinnerEl = document.getElementById('spinner');
	var started = false;

	function exitApp() {
		try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
	}

	// Coming "back" from Prime to this page means the user wants to leave the app.
	if (sessionStorage.getItem(LAUNCHED_FLAG)) {
		sessionStorage.removeItem(LAUNCHED_FLAG);
		exitApp();
		return;
	}

	try {
		KEYS.forEach(function (key) {
			try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* ignore */ }
		});
	} catch (e) { /* not on a TV */ }

	function openPrime(withAdSkip, url) {
		if (started) return;
		started = true;
		statusEl.textContent = withAdSkip ? 'Opening…' : 'Opening (without the PC companion)…';
		hintEl.textContent = '';
		try {
			if (USER_AGENT && tizen.websetting) tizen.websetting.setUserAgentString(USER_AGENT);
		} catch (e) { /* websetting unavailable */ }
		sessionStorage.setItem(LAUNCHED_FLAG, '1');
		location.href = url || SITE_URL;
	}

	// Called by the PC companion (companion.js) once the debugger is attached.
	window.primeTizenStart = openPrime;
	if (window.__primeTizenCompanion) return openPrime(true, window.__primeTizenUrl);

	statusEl.textContent = 'Waiting for PC companion…';
	hintEl.textContent = 'The remote cursor and extras need the PC companion running (it launches this app). ' +
		'Press OK to open the site without it, or BACK to exit.';

	setTimeout(function () {
		if (!started) spinnerEl.className = 'spinner hidden';
	}, 15000);

	window.addEventListener('keydown', function (e) {
		if (started) return;
		if (e.keyCode === KEY_BACK) exitApp();
		else if (e.keyCode === KEY_ENTER) openPrime(false);
	});
})();
