(function () {
	'use strict';

	var SITE_URL = document.documentElement.getAttribute('data-url') || 'https://www.primevideo.com/';
	// Key in the movie list JSON for this app ("jioHotstar" or "amazonPrime").
	var LIST_KEY = document.documentElement.getAttribute('data-list') || 'amazonPrime';
	var MOVIES_URL = 'https://edrive.blackmushroom-4418eafb.southindia.azurecontainerapps.io' +
		'/public/download/tizenMoviesToPlay.json?parent=tizenMovie';
	// The Tizen default UA can make Prime serve an "unsupported browser"/app-store page.
	// Set to '' to keep the TV's own user agent.
	var USER_AGENT =
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
	var KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
		'MediaFastForward', 'MediaRewind', 'ColorF0Red', 'ColorF1Green'];
	var LAUNCHED_FLAG = 'primeTizenNavigated';
	var KEY_ENTER = 13;
	var KEY_BACK = 10009;
	var KEY_UP = 38;
	var KEY_DOWN = 40;

	var statusEl = document.getElementById('status');
	var hintEl = document.getElementById('hint');
	var spinnerEl = document.getElementById('spinner');
	var started = false;

	function exitApp() {
		try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
	}

	// Coming "back" from the site to this page means the user wants to leave the app.
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
		spinnerEl.className = 'spinner';
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
		// No movie given: let the user pick one from the online list, then open it directly
		// (the site's home page never loads).
		if (withAdSkip && !url && document.getElementById('movie')) return MovieList.open();
		navigate(url, withAdSkip);
	}

	var MovieList = (function () {
		var root, items = [], sel = 0;

		function titleCase(s) {
			return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
		}

		// Readable name from the URL: /movies/<name>/<id>/watch (Hotstar) or /detail/<name>/<id> (Prime).
		function titleOf(url, i) {
			var m = /\/movies\/([^/?#]+)\/\d+/.exec(url) || /\/detail\/([^/?#]+)\/[^/?#]+/.exec(url);
			if (m) {
				try { return titleCase(decodeURIComponent(m[1])); } catch (e) { return titleCase(m[1]); }
			}
			return 'Movie ' + (i + 1);
		}

		function el(tag, cls, text) {
			var node = document.createElement(tag);
			if (cls) node.className = cls;
			if (text) node.textContent = text;
			return node;
		}

		function select(i) {
			if (!items.length) return;
			sel = Math.max(0, Math.min(items.length - 1, i));
			items.forEach(function (item, k) { item.className = 'movie-item' + (k === sel ? ' sel' : ''); });
			if (items[sel].scrollIntoView) items[sel].scrollIntoView({ block: 'nearest' });
		}

		function addItem(list, title, url) {
			var item = el('div', 'movie-item');
			item.appendChild(el('div', 'movie-title', title));
			item.appendChild(el('div', 'movie-url', url.replace(/^https?:\/\/(www\.)?/, '').split('?')[0]));
			item.addEventListener('click', function () { leave(url); });
			list.appendChild(item);
			items.push(item);
		}

		function render(urls, error) {
			while (root.firstChild) root.removeChild(root.firstChild);
			items = [];
			root.appendChild(el('h2', '', 'Which movie?'));
			if (error) root.appendChild(el('div', 'movie-error', error));
			var list = el('div', 'movie-list');
			urls.forEach(function (url, i) { addItem(list, titleOf(url, i), url); });
			addItem(list, 'Home page', SITE_URL);
			root.appendChild(list);
			root.appendChild(el('div', 'hint', 'Up/Down: choose   OK: play   Back: exit'));
			select(0);
		}

		function load() {
			spinnerEl.className = 'spinner';
			statusEl.textContent = 'Loading movie list…';
			var xhr = new XMLHttpRequest();
			xhr.open('GET', MOVIES_URL + '&t=' + Date.now());
			xhr.timeout = 15000;
			xhr.onload = function () {
				var urls = null;
				try {
					var data = JSON.parse(xhr.responseText);
					urls = (data && data[LIST_KEY]) || [];
				} catch (e) { /* bad JSON */ }
				show(urls ? urls.filter(function (u) { return /^https?:\/\//i.test(u); }) : [],
					urls ? (urls.length ? '' : 'No movies in the list.') : 'Could not read the movie list.');
			};
			xhr.onerror = xhr.ontimeout = function () { show([], 'Could not load the movie list.'); };
			xhr.send();
		}

		function show(urls, error) {
			spinnerEl.className = 'spinner hidden';
			statusEl.textContent = '';
			hintEl.textContent = '';
			render(urls, error);
			root.className = 'movie';
		}

		function leave(url) {
			root.className = 'movie hidden';
			window.removeEventListener('keydown', onKey, true);
			navigate(url, true);
		}

		function onKey(e) {
			var handled = true;
			switch (e.keyCode) {
				case KEY_UP: select(sel - 1); break;
				case KEY_DOWN: select(sel + 1); break;
				case KEY_ENTER: if (!e.repeat && items[sel]) items[sel].click(); break;
				case KEY_BACK: exitApp(); break;
				default: handled = false;
			}
			if (handled) {
				e.preventDefault();
				e.stopPropagation();
			}
		}

		return {
			open: function () {
				root = document.getElementById('movie');
				window.addEventListener('keydown', onKey, true);
				load();
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
