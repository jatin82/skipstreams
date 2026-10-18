(function () {
	'use strict';

	var SITE_URL = document.documentElement.getAttribute('data-url') || 'https://www.primevideo.com/';
	// The Tizen default UA can make Prime serve an "unsupported browser"/app-store page.
	// Set to '' to keep the TV's own user agent.
	var USER_AGENT =
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
	var KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
		'MediaFastForward', 'MediaRewind', 'ColorF0Red', 'ColorF1Green'];
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

	function navigate(url, withAdSkip) {
		statusEl.textContent = withAdSkip ? 'Opening…' : 'Opening (without the PC companion)…';
		hintEl.textContent = '';
		try {
			if (USER_AGENT && tizen.websetting) tizen.websetting.setUserAgentString(USER_AGENT);
		} catch (e) { /* websetting unavailable */ }
		sessionStorage.setItem(LAUNCHED_FLAG, '1');
		location.href = url || SITE_URL;
	}

	function openPrime(withAdSkip, url) {
		if (started) return;
		started = true;
		// No movie given: ask here, then open the movie page directly (the site's home page never loads).
		if (withAdSkip && !url && document.getElementById('movie')) return MovieForm.open();
		navigate(url, withAdSkip);
	}

	var MovieForm = (function () {
		var LAST_KEY = 'ptHotstarLastMovie';
		var KEY_UP = 38, KEY_DOWN = 40, KEY_LEFT = 37, KEY_RIGHT = 39;
		var KEY_DONE = 65376, KEY_CANCEL = 65385;
		var root, nameInput, numberInput, urlEl, errorEl, items, sel = 0;

		function slug(s) {
			return String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
		}

		function updateUrl() {
			var raw = nameInput.value.trim();
			urlEl.textContent = /^https?:\/\//i.test(raw) ? raw : 'hotstar.com/in/movies/' +
				(slug(raw) || '<movie_name>') + '/' + (numberInput.value.trim() || '<movie_number>') + '/watch';
		}

		function select(i) {
			sel = Math.max(0, Math.min(items.length - 1, i));
			items.forEach(function (item, k) { item.className = k === sel ? 'sel' : ''; });
		}

		// OK on a field opens the TV keyboard; OK on a button presses it.
		function activate() {
			var item = items[sel];
			if (item.tagName !== 'INPUT') return item.click();
			item.blur();
			item.focus();
			var n = item.value.length;
			try { item.setSelectionRange(n, n); } catch (e) { /* tel inputs may not support it */ }
		}

		// Keyboard "Done": go on to the next field, then to Play.
		function done() {
			if (sel === 0) {
				select(1);
				activate();
			} else {
				if (document.activeElement) document.activeElement.blur();
				select(2);
			}
		}

		function buildUrl() {
			var raw = nameInput.value.trim();
			if (/^https?:\/\//i.test(raw)) return raw;
			var name = slug(raw);
			var number = numberInput.value.replace(/\s+/g, '');
			if (!name || !/^[a-z0-9-]+$/.test(name)) {
				errorEl.textContent = 'Enter the movie name (letters, digits and dashes).';
				select(0);
				return null;
			}
			if (!/^\d+$/.test(number)) {
				errorEl.textContent = 'Enter the movie number (digits only).';
				select(1);
				return null;
			}
			try { localStorage.setItem(LAST_KEY, JSON.stringify({ name: name, number: number })); } catch (e) { /* ignore */ }
			return 'https://www.hotstar.com/in/movies/' + name + '/' + number + '/watch';
		}

		function leave(url) {
			if (document.activeElement) document.activeElement.blur();
			root.className = 'movie hidden';
			window.removeEventListener('keydown', onKey, true);
			navigate(url, true);
		}

		function onKey(e) {
			var code = e.keyCode;
			var active = document.activeElement;
			var typing = !!active && active.tagName === 'INPUT';
			var handled = true;
			switch (code) {
				case KEY_UP:
					if (typing) active.blur();
					select(sel >= 2 ? 1 : sel - 1);
					break;
				case KEY_DOWN:
					if (typing) active.blur();
					select(sel >= 2 ? sel : sel + 1);
					break;
				case KEY_LEFT:
				case KEY_RIGHT:
					if (typing) handled = false; // move the text cursor
					else if (sel >= 2) select(code === KEY_LEFT ? 2 : 3);
					break;
				case KEY_ENTER:
					if (typing) done();
					else if (!e.repeat) activate();
					break;
				case KEY_DONE:
					done();
					break;
				case KEY_CANCEL:
					if (typing) active.blur();
					break;
				case KEY_BACK:
					if (typing) active.blur();
					else exitApp();
					break;
				default:
					handled = false;
			}
			if (handled) {
				e.preventDefault();
				e.stopPropagation();
			}
		}

		return {
			open: function () {
				root = document.getElementById('movie');
				nameInput = document.getElementById('movie-name');
				numberInput = document.getElementById('movie-number');
				urlEl = document.getElementById('movie-url');
				errorEl = document.getElementById('movie-error');
				var playBtn = document.getElementById('movie-play');
				var homeBtn = document.getElementById('movie-home');
				items = [nameInput, numberInput, playBtn, homeBtn];
				items.forEach(function (item, i) {
					item.addEventListener('focus', function () { select(i); });
				});
				playBtn.addEventListener('click', function () {
					var url = buildUrl();
					if (url) leave(url);
				});
				homeBtn.addEventListener('click', function () { leave(SITE_URL); });
				nameInput.addEventListener('input', updateUrl);
				numberInput.addEventListener('input', updateUrl);
				try {
					var last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
					if (last) {
						nameInput.value = last.name || '';
						numberInput.value = last.number || '';
					}
				} catch (e) { /* ignore */ }
				updateUrl();
				spinnerEl.className = 'spinner hidden';
				statusEl.textContent = '';
				hintEl.textContent = '';
				root.className = 'movie';
				select(nameInput.value ? 2 : 0);
				window.addEventListener('keydown', onKey, true);
			},
		};
	})();

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
