/*
 * Prime Video for Samsung Tizen TVs (TizenBrew site-modification module).
 *
 * - Clicks "Skip ad" controls and fast-forwards (muted) unskippable ads.
 * - Remote-controlled virtual cursor: arrows move, OK clicks, edges scroll.
 * - Disables page animations and trailer autoplay to keep the TV responsive.
 * - Back key navigates back / closes player, media keys control playback.
 *
 * Ad logic ported from the "Prime Video Ads Auto-Skip" Tampermonkey script.
 */
(function () {
	'use strict';

	if (window.__primeTizenLoaded || window.top !== window) return;
	window.__primeTizenLoaded = true;

	function log() {
		var args = Array.prototype.slice.call(arguments);
		args.unshift('[PrimeTizen]');
		console.log.apply(console, args);
	}

	// The same script runs in the Prime Video and JioHotstar apps; Prime-only features are gated on this.
	var IS_PRIME = !/(^|\.)hotstar\.com$/i.test(location.hostname);

	function onReady(fn) {
		if (document.body) fn();
		else document.addEventListener('DOMContentLoaded', fn, { once: true });
	}

	function normalizeLabel(value) {
		return String(value || '').replace(/\s+/g, ' ').trim();
	}

	/* ------------------------------------------------------------------ */
	/* No animations (the TV GPU/CPU can't keep up with Prime's effects)  */
	/* ------------------------------------------------------------------ */

	function disableAnimations() {
		var style = document.createElement('style');
		style.id = 'prime-tizen-no-anim';
		style.textContent =
			'*,*::before,*::after{animation:none!important;transition:none!important;' +
			'scroll-behavior:auto!important;}';
		(document.head || document.documentElement).appendChild(style);

		// Web Animations API (element.animate) bypasses CSS; make those finish instantly.
		var nativeAnimate = Element.prototype.animate;
		if (nativeAnimate) {
			Element.prototype.animate = function (keyframes, options) {
				var opts = typeof options === 'object' && options ? Object.assign({}, options) : {};
				opts.duration = 0;
				opts.delay = 0;
				opts.endDelay = 0;
				return nativeAnimate.call(this, keyframes, opts);
			};
		}
	}

	/* ------------------------------------------------------------------ */
	/* Prime: the chosen title's detail page starts playback by itself     */
	/* ------------------------------------------------------------------ */

	var AutoPlay = (function () {
		// Prime ships different detail-page layouts per region/account; the main CTA is the first match.
		var PLAY_BUTTONS = [
			'[data-testid="dp-atf-play-button"]',
			'a.fbl-play-btn[href*="autoplay=1"]',
			'[data-testid="play"][href*="autoplay=1"]',
			'[data-automation-id="play"]',
		];
		var GIVE_UP_MS = 30000;

		function findPlayButton() {
			for (var i = 0; i < PLAY_BUTTONS.length; i++) {
				var matches = document.querySelectorAll(PLAY_BUTTONS[i]);
				for (var j = 0; j < matches.length; j++) {
					var el = matches[j];
					if (el.offsetWidth && el.getAttribute('aria-disabled') !== 'true') return el;
				}
			}
			return null;
		}

		return {
			// The launcher opens the picked title's detail page with a full page load: press its Play button.
			start: function () {
				if (!/\/detail\//.test(location.pathname)) return;
				var startedAt = Date.now();
				var poll = setInterval(function () {
					if (Date.now() - startedAt > GIVE_UP_MS) return clearInterval(poll);
					var button = findPlayButton();
					if (!button) return;
					clearInterval(poll);
					log('Playing', button.getAttribute('aria-label') || button.textContent.trim());
					button.click();
				}, 300);
			},
		};
	})();

	/* ------------------------------------------------------------------ */
	/* No trailer autoplay (hero banners, hover previews, detail pages)   */
	/* ------------------------------------------------------------------ */

	function isTrailer(video) {
		// The real movie/episode always plays inside the web player; detached videos are left alone.
		return video.isConnected && !video.closest('#dv-web-player');
	}

	function stopTrailer(video) {
		video.muted = true;
		video.autoplay = false;
		if (!video.paused) video.pause();
	}

	function blockTrailerAutoplay() {
		// Media events don't bubble, but they do pass through the capture phase.
		['play', 'playing'].forEach(function (type) {
			document.addEventListener(type, function (event) {
				var video = event.target;
				if (video && video.tagName === 'VIDEO' && isTrailer(video)) stopTrailer(video);
			}, true);
		});
		onReady(function () {
			Array.prototype.forEach.call(document.querySelectorAll('video'), function (video) {
				if (isTrailer(video)) stopTrailer(video);
			});
		});
	}

	function isVisible(element) {
		if (!(element instanceof HTMLElement) || element.hidden) return false;
		var style = getComputedStyle(element);
		var rect = element.getBoundingClientRect();
		return style.display !== 'none' &&
			style.visibility !== 'hidden' &&
			Number(style.opacity) !== 0 &&
			rect.width > 0 &&
			rect.height > 0;
	}

	function isTextInput(el) {
		if (!el || !(el instanceof HTMLElement)) return false;
		if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
		if (el.tagName !== 'INPUT') return false;
		return !/^(button|checkbox|radio|submit|reset|image|file|range|color|hidden)$/i.test(el.type || 'text');
	}

	/* ------------------------------------------------------------------ */
	/* Ad skipping                                                         */
	/* ------------------------------------------------------------------ */

	var AdSkipper = (function () {
		var PLAYER_SELECTOR =
			'[data-testid="webPlayerUIContainer"], .webPlayerUIContainer, [class*="atvwebplayersdk-player-container"]';
		var SKIP_CONTROL_SELECTOR = [
			'button',
			'[role="button"]',
			'[data-testid*="skip" i]',
			'[class*="skipelement" i]',
		].join(',');
		var AD_LABEL_SELECTOR = '#dv-web-player [aria-label^="Ad playing." i]';
		var AD_TIMER_SELECTOR = '.atvwebplayersdk-ad-timer-remaining-time';
		var SKIP_LABEL_PATTERN = /^skip\s+ads?\b/i;
		var CLICK_COOLDOWN_MS = 1500;
		// TV hardware decoders may reject high rates, so fall back progressively.
		var AD_PLAYBACK_RATES = [16, 8, 4, 2];

		var lastClickedAt = new WeakMap();
		var adWasActive = false;
		var adVideo = null;
		var adRate = null;
		var previousPlaybackRate = 1;
		var mutedByScript = false;
		var recoveryTimer = null;
		var syncQueued = false;
		var lastSyncAt = 0;
		var MIN_SYNC_INTERVAL_MS = 250;

		function getPlayerRoot() {
			var video = document.querySelector('video');
			if (!video) return null;
			return document.querySelector(PLAYER_SELECTOR) || video.parentElement;
		}

		function getControlLabel(element) {
			return normalizeLabel([
				element.getAttribute('aria-label'),
				element.getAttribute('title'),
				element.getAttribute('data-testid'),
				element.textContent,
			].filter(Boolean).join(' '));
		}

		function findSkipControls() {
			var root = getPlayerRoot();
			if (!root) return [];
			return Array.prototype.filter.call(root.querySelectorAll(SKIP_CONTROL_SELECTOR), function (element) {
				// Label test first: it's cheap, while isVisible forces style/layout work.
				if (!SKIP_LABEL_PATTERN.test(getControlLabel(element))) return false;
				return isVisible(element) && !element.matches(':disabled, [aria-disabled="true"]');
			});
		}

		function clickSkipControls() {
			var now = Date.now();
			var clicked = false;
			findSkipControls().forEach(function (element) {
				if (now - (lastClickedAt.get(element) || 0) < CLICK_COOLDOWN_MS) return;
				lastClickedAt.set(element, now);
				var label = getControlLabel(element);
				Pointer.fireClick(element);
				clicked = true;
				log('Clicked:', label);
			});
			return clicked;
		}

		function hasPaidAdSignal() {
			var indicators = document.querySelectorAll(AD_LABEL_SELECTOR);
			for (var i = 0; i < indicators.length; i++) {
				var timer = indicators[i].querySelector(AD_TIMER_SELECTOR);
				if (!timer) continue;
				if (/^(?:\d+:)?\d{1,2}:\d{2}$/.test(normalizeLabel(timer.textContent))) return true;
			}
			return false;
		}

		function getActiveVideo() {
			var videos = document.querySelectorAll('#dv-web-player video');
			for (var i = 0; i < videos.length; i++) {
				if (isVisible(videos[i]) && !videos[i].paused) return videos[i];
			}
			return null;
		}

		function applyAdRate(video) {
			for (var i = 0; i < AD_PLAYBACK_RATES.length; i++) {
				try {
					video.playbackRate = AD_PLAYBACK_RATES[i];
					if (video.playbackRate === AD_PLAYBACK_RATES[i]) return AD_PLAYBACK_RATES[i];
				} catch (e) { /* try a lower rate */ }
			}
			return null;
		}

		function speedUpAd() {
			var video = getActiveVideo();
			if (!video) return;

			if (video !== adVideo) {
				adVideo = video;
				previousPlaybackRate = video.playbackRate;
				mutedByScript = !video.muted;
				adRate = null;
			}

			if (adRate === null || video.playbackRate !== adRate) {
				adRate = applyAdRate(video);
				if (adRate) log('Ad playing; rate set to', adRate + 'x');
			}
			if (mutedByScript) video.muted = true;
		}

		function restorePlaybackSettings() {
			if (!adVideo) return;
			var videos = [adVideo].concat(Array.prototype.slice.call(document.querySelectorAll('video')));
			videos.forEach(function (video) {
				if (video === adVideo || (adRate && video.playbackRate === adRate)) {
					try { video.playbackRate = previousPlaybackRate; } catch (e) { /* ignore */ }
				}
			});
			if (mutedByScript) adVideo.muted = false;
			log('Ad ended; restored playback settings');
			adVideo = null;
			adRate = null;
			previousPlaybackRate = 1;
			mutedByScript = false;
		}

		function recoverPlayback() {
			var video = Array.prototype.find.call(document.querySelectorAll('video'), isVisible);
			if (!video || !video.paused || video.ended) return;
			var playPromise = video.play();
			if (playPromise && typeof playPromise.catch === 'function') {
				playPromise.catch(function (error) { log('Playback recovery was blocked:', error); });
			}
		}

		function sync() {
			syncQueued = false;
			lastSyncAt = Date.now();
			// No player on screen (browse pages): nothing to skip, keep the page fast.
			if (!adWasActive && !adVideo && !document.querySelector('#dv-web-player video')) return;

			var paidAdActive = hasPaidAdSignal();

			clickSkipControls();
			if (paidAdActive) speedUpAd();
			else restorePlaybackSettings();

			if (adWasActive && !paidAdActive) {
				clearTimeout(recoveryTimer);
				recoveryTimer = setTimeout(recoverPlayback, 500);
			}
			adWasActive = paidAdActive;
		}

		function queueSync() {
			if (syncQueued) return;
			syncQueued = true;
			setTimeout(sync, Math.max(0, MIN_SYNC_INTERVAL_MS - (Date.now() - lastSyncAt)));
		}

		function start() {
			new MutationObserver(queueSync).observe(document.documentElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['aria-label', 'aria-disabled', 'class', 'data-testid', 'style'],
			});
			setInterval(sync, 500);
			sync();
			log('Ad skipper running');
		}

		return {
			start: start,
			isAdActive: function () { return adWasActive; },
		};
	})();

	/* ------------------------------------------------------------------ */
	/* Remote-controlled cursor                                            */
	/* ------------------------------------------------------------------ */

	var Pointer = (function () {
		var TAP_STEP = 16;
		var MIN_SPEED = 450;
		var MAX_SPEED = 1600;
		var ACCEL_MS = 700;
		// Safety stop if a keyup is ever missed (TV key-repeat fires well within this).
		var KEY_STALE_MS = 900;
		var EDGE = 48;
		var SCROLL_STEP = 260;
		var SCROLL_INTERVAL_MS = 280;
		// Prime's hover handlers (card expand + preview) are expensive on the TV, so hover is
		// only dispatched once the cursor comes to rest, never while it is moving.
		var HOVER_REST_MS = 220;
		var HIDE_AFTER_MS = 4000;

		var el = null;
		var x = window.innerWidth / 2;
		var y = window.innerHeight / 2;
		var enabled = true;
		var visible = false;
		var hideTimer = null;
		var hoverTarget = null;
		var held = { left: false, right: false, up: false, down: false };
		var holdStartedAt = 0;
		var lastKeyAt = 0;
		var lastFrameAt = 0;
		var hoverTimer = null;
		var lastScrollAt = 0;
		var rafId = 0;

		function create() {
			var style = document.createElement('style');
			style.textContent =
				'#prime-tizen-cursor{position:fixed;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;' +
				'pointer-events:none;z-index:2147483647;will-change:transform;opacity:0;transition:opacity .25s;}' +
				'#prime-tizen-cursor.visible{opacity:1;}' +
				'#prime-tizen-cursor>div{width:100%;height:100%;box-sizing:border-box;border-radius:50%;' +
				'border:3px solid #fff;background:rgba(0,168,225,.55);' +
				'box-shadow:0 0 0 2px rgba(0,0,0,.6),0 0 12px rgba(0,168,225,.9);transition:transform .08s;}' +
				'#prime-tizen-cursor.pressed>div{transform:scale(.7);}';
			document.documentElement.appendChild(style);

			el = document.createElement('div');
			el.id = 'prime-tizen-cursor';
			el.appendChild(document.createElement('div'));
			document.documentElement.appendChild(el);
			render();
		}

		function render() {
			if (el) el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
		}

		function show() {
			if (!el) return;
			if (!visible) {
				visible = true;
				el.classList.add('visible');
			}
			clearTimeout(hideTimer);
			hideTimer = setTimeout(hide, HIDE_AFTER_MS);
		}

		function hide() {
			visible = false;
			if (el) el.classList.remove('visible');
		}

		function targetAt(px, py) {
			var t = document.elementFromPoint(px, py);
			// Descend into open shadow roots.
			while (t && t.shadowRoot) {
				var inner = t.shadowRoot.elementFromPoint(px, py);
				if (!inner || inner === t) break;
				t = inner;
			}
			return t;
		}

		function mouseInit(type, px, py) {
			return {
				bubbles: true,
				cancelable: true,
				composed: true,
				view: window,
				clientX: px,
				clientY: py,
				screenX: px,
				screenY: py,
				button: 0,
				buttons: /down$/.test(type) ? 1 : 0,
				pointerId: 1,
				pointerType: 'mouse',
				isPrimary: true,
			};
		}

		function dispatch(target, type, px, py) {
			var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
			target.dispatchEvent(new Ctor(type, mouseInit(type, px, py)));
		}

		function cancelHover() {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}

		function scheduleHover() {
			cancelHover();
			hoverTimer = setTimeout(function () {
				hoverTimer = null;
				hoverAt(x, y);
			}, HOVER_REST_MS);
		}

		// Prime expands carousel tiles and plays previews on hover; never hover them.
		var NO_HOVER = '[data-testid="navigation-carousel-wrapper"],[data-testid="top-hero"]';

		function hoverAt(px, py) {
			var t = targetAt(px, py);
			if (t && t.closest && t.closest(NO_HOVER)) t = null;
			if (!t) {
				if (hoverTarget && hoverTarget.isConnected) {
					dispatch(hoverTarget, 'pointerout', px, py);
					dispatch(hoverTarget, 'mouseout', px, py);
				}
				hoverTarget = null;
				return;
			}
			if (t !== hoverTarget) {
				if (hoverTarget && hoverTarget.isConnected) {
					dispatch(hoverTarget, 'pointerout', px, py);
					dispatch(hoverTarget, 'mouseout', px, py);
				}
				dispatch(t, 'pointerover', px, py);
				dispatch(t, 'mouseover', px, py);
				hoverTarget = t;
			}
			dispatch(t, 'pointermove', px, py);
			dispatch(t, 'mousemove', px, py);
		}

		function fireClick(target, px, py) {
			if (px === undefined) {
				var rect = target.getBoundingClientRect();
				px = rect.left + rect.width / 2;
				py = rect.top + rect.height / 2;
			}
			['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
				dispatch(target, type, px, py);
			});
		}

		function focusableAncestor(t) {
			while (t && t !== document.body) {
				if (isTextInput(t)) return t;
				if (t.tabIndex >= 0 || /^(A|BUTTON|SELECT|INPUT|TEXTAREA)$/.test(t.tagName)) return t;
				t = t.parentElement;
			}
			return null;
		}

		function clickAtCursor() {
			if (hoverTimer) {
				cancelHover();
				hoverAt(x, y);
			}
			var t = targetAt(x, y);
			if (!t) return;
			if (el) {
				el.classList.add('pressed');
				setTimeout(function () { el.classList.remove('pressed'); }, 120);
			}
			var focusTarget = focusableAncestor(t);
			if (focusTarget && typeof focusTarget.focus === 'function') {
				try { focusTarget.focus({ preventScroll: true }); } catch (e) { focusTarget.focus(); }
			}
			fireClick(t, x, y);
		}

		function isScrollable(node, axis) {
			var style = getComputedStyle(node);
			var overflow = axis === 'y' ? style.overflowY : style.overflowX;
			if (!/(auto|scroll|overlay)/.test(overflow)) return false;
			return axis === 'y'
				? node.scrollHeight > node.clientHeight + 1
				: node.scrollWidth > node.clientWidth + 1;
		}

		function scrollFrom(target, dx, dy) {
			var axis = dy !== 0 ? 'y' : 'x';
			var node = target;
			while (node && node !== document.body && node !== document.documentElement) {
				if (node instanceof HTMLElement && isScrollable(node, axis)) {
					var before = axis === 'y' ? node.scrollTop : node.scrollLeft;
					// Instant scroll: smooth scrolling on the TV doubles Prime's re-render cost.
					node.scrollBy(dx, dy);
					// If the scroll is already at its limit, let an ancestor scroll instead.
					var limit = axis === 'y'
						? (dy > 0 ? node.scrollHeight - node.clientHeight : 0)
						: (dx > 0 ? node.scrollWidth - node.clientWidth : 0);
					if (Math.abs(before - limit) > 1) return;
				}
				node = node.parentElement;
			}
			window.scrollBy(dx, dy);
		}

		function direction() {
			return {
				dx: (held.right ? 1 : 0) - (held.left ? 1 : 0),
				dy: (held.down ? 1 : 0) - (held.up ? 1 : 0),
			};
		}

		function anyHeld() {
			return held.left || held.right || held.up || held.down;
		}

		function moveBy(mx, my, dx, dy) {
			// clientWidth/Height exclude scrollbars, so the cursor never parks over one.
			var w = document.documentElement.clientWidth || window.innerWidth;
			var h = document.documentElement.clientHeight || window.innerHeight;
			var nx = x + mx;
			var ny = y + my;
			var now = Date.now();

			if (now - lastScrollAt > SCROLL_INTERVAL_MS) {
				var sx = (nx < EDGE && dx < 0) ? -SCROLL_STEP : (nx > w - EDGE && dx > 0) ? SCROLL_STEP : 0;
				var sy = (ny < EDGE && dy < 0) ? -SCROLL_STEP : (ny > h - EDGE && dy > 0) ? SCROLL_STEP : 0;
				if (sx || sy) {
					lastScrollAt = now;
					var t = targetAt(x, y);
					if (sy) scrollFrom(t, 0, sy);
					if (sx) scrollFrom(t, sx, 0);
				}
			}

			x = Math.max(4, Math.min(w - 4, nx));
			y = Math.max(4, Math.min(h - 4, ny));
			render();
		}

		function frame(ts) {
			rafId = 0;
			if (!anyHeld()) return;
			if (Date.now() - lastKeyAt > KEY_STALE_MS) {
				release();
				return;
			}
			var dt = Math.min(50, ts - (lastFrameAt || ts));
			lastFrameAt = ts;
			var d = direction();
			if (d.dx || d.dy) {
				var progress = Math.min(1, (Date.now() - holdStartedAt) / ACCEL_MS);
				var dist = (MIN_SPEED + (MAX_SPEED - MIN_SPEED) * progress * progress) * dt / 1000;
				var norm = d.dx && d.dy ? Math.SQRT1_2 : 1;
				moveBy(d.dx * dist * norm, d.dy * dist * norm, d.dx, d.dy);
				show();
			}
			rafId = requestAnimationFrame(frame);
		}

		function press(name, isRepeat) {
			lastKeyAt = Date.now();
			// First press after the cursor was hidden just reveals it.
			if (!visible && !anyHeld()) {
				show();
				scheduleHover();
				return;
			}
			show();
			cancelHover();
			if (held[name]) return;
			var wasHeld = anyHeld();
			held[name] = true;
			if (!wasHeld) holdStartedAt = Date.now();
			if (!isRepeat) {
				var d = direction();
				moveBy(d.dx * TAP_STEP, d.dy * TAP_STEP, d.dx, d.dy);
			}
			if (!rafId) {
				lastFrameAt = 0;
				rafId = requestAnimationFrame(frame);
			}
		}

		function release(name) {
			if (name) held[name] = false;
			else held.left = held.right = held.up = held.down = false;
			if (!anyHeld()) {
				if (rafId) cancelAnimationFrame(rafId);
				rafId = 0;
				scheduleHover();
			}
		}

		function setEnabled(value) {
			enabled = value;
			release();
			if (!enabled) {
				cancelHover();
				hide();
			} else show();
			log('Cursor', enabled ? 'enabled' : 'disabled');
		}

		return {
			create: create,
			press: press,
			release: release,
			click: clickAtCursor,
			fireClick: fireClick,
			show: show,
			isVisible: function () { return visible; },
			isEnabled: function () { return enabled; },
			toggle: function () { setEnabled(!enabled); },
		};
	})();

	/* ------------------------------------------------------------------ */
	/* Remote keys                                                         */
	/* ------------------------------------------------------------------ */

	var KEY = {
		LEFT: 37,
		UP: 38,
		RIGHT: 39,
		DOWN: 40,
		ENTER: 13,
		BACK: 10009,
		PLAY_PAUSE: 10252,
		PLAY: 415,
		PAUSE: 19,
		STOP: 413,
		FAST_FORWARD: 417,
		REWIND: 412,
		RED: 403,
		GREEN: 404,
	};
	var SEEK_SECONDS = 10;

	function getMainVideo() {
		var videos = document.querySelectorAll('#dv-web-player video, video');
		for (var i = 0; i < videos.length; i++) {
			if (isVisible(videos[i]) && videos[i].readyState > 0) return videos[i];
		}
		return null;
	}

	function playerIsOpen() {
		if (!IS_PRIME) return /\/watch\b/.test(location.pathname) && !!getMainVideo();
		var player = document.getElementById('dv-web-player');
		return !!(player && isVisible(player) && player.querySelector('video'));
	}

	function closePlayer() {
		var close = document.querySelector(
			'#dv-web-player [class*="closebutton" i], #dv-web-player button[aria-label*="close" i], ' +
			'#dv-web-player [aria-label*="back" i][role="button"], #dv-web-player button[aria-label*="back" i]'
		);
		if (close && isVisible(close)) {
			Pointer.fireClick(close);
			return true;
		}
		return false;
	}

	// Back while watching returns to the app's movie list. The PC companion navigates there when it sees
	// "Show movie list"; fallback: walk history back to the launcher page.
	function showMovieList() {
		var video = getMainVideo();
		if (video) video.pause();
		log('Show movie list');
		var from = location.href;
		setTimeout(function () {
			if (location.href !== from) return;
			if (history.length > 1) history.go(-(history.length - 1));
			else window.close();
		}, 2500);
	}

	function handleBack() {
		var active = document.activeElement;
		if (isTextInput(active)) {
			active.blur();
			return;
		}
		showMovieList();
	}

	function handleMediaKey(code) {
		var video = getMainVideo();
		if (!video) return false;
		switch (code) {
			case KEY.PLAY_PAUSE:
				if (video.paused) video.play();
				else video.pause();
				return true;
			case KEY.PLAY:
				video.play();
				return true;
			case KEY.PAUSE:
				video.pause();
				return true;
			case KEY.STOP:
				video.pause();
				closePlayer();
				return true;
			case KEY.FAST_FORWARD:
			case KEY.REWIND:
				Seeker.seekBy(video, code === KEY.FAST_FORWARD ? SEEK_SECONDS : -SEEK_SECONDS);
				return true;
		}
		return false;
	}

	/* Seeking: repeated presses accumulate and are applied in one jump (each MSE seek rebuffers). */
	var Seeker = (function () {
		var APPLY_DELAY_MS = 450;
		var OSD_MS = 1500;
		var osd = null;
		var pendingVideo = null;
		var pendingTarget = 0;
		var applyTimer = null;
		var hideTimer = null;

		function format(seconds) {
			seconds = Math.max(0, Math.floor(seconds));
			var h = Math.floor(seconds / 3600);
			var m = Math.floor(seconds / 60) % 60;
			var s = seconds % 60;
			return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
		}

		function show(text) {
			if (!osd) {
				osd = document.createElement('div');
				osd.id = 'prime-tizen-seek';
				osd.style.cssText = 'position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:2147483646;' +
					'padding:14px 28px;border-radius:10px;background:rgba(0,0,0,.75);color:#fff;' +
					'font:bold 30px/1.3 sans-serif;pointer-events:none;';
				document.documentElement.appendChild(osd);
			}
			osd.textContent = text;
			osd.style.display = 'block';
			clearTimeout(hideTimer);
			hideTimer = setTimeout(function () { osd.style.display = 'none'; }, OSD_MS);
		}

		function apply() {
			applyTimer = null;
			if (pendingVideo && pendingVideo.isConnected) pendingVideo.currentTime = pendingTarget;
			pendingVideo = null;
		}

		return {
			seekBy: function (video, delta) {
				// Never seek during ads; that would skip program content, not the ad.
				if (AdSkipper.isAdActive()) {
					show('Can\'t seek during an ad');
					return;
				}
				if (pendingVideo !== video) {
					pendingVideo = video;
					pendingTarget = video.currentTime;
				}
				pendingTarget = Math.max(0, pendingTarget + delta);
				if (isFinite(video.duration)) pendingTarget = Math.min(video.duration - 1, pendingTarget);
				var diff = Math.round(pendingTarget - video.currentTime);
				var mag = Math.abs(diff);
				show((diff >= 0 ? '+' : '\u2212') + (mag >= 60 ? format(mag) : mag + 's') + '  \u2192  ' + format(pendingTarget) +
					(isFinite(video.duration) ? ' / ' + format(video.duration) : ''));
				clearTimeout(applyTimer);
				applyTimer = setTimeout(apply, APPLY_DELAY_MS);
			},
		};
	})();

	/* Left/Right while watching: tap = ±10 s (on release), hold = ±5 min, repeating while held. */
	var HoldSeek = (function () {
		var LONG_PRESS_MS = 600;
		var LONG_REPEAT_MS = 700;
		var LONG_SEEK_SECONDS = 300;
		var held = null; // { code, video, timer, longs }

		function longStep() {
			if (!held) return;
			held.longs++;
			Seeker.seekBy(held.video, held.code === KEY.RIGHT ? LONG_SEEK_SECONDS : -LONG_SEEK_SECONDS);
			held.timer = setTimeout(longStep, LONG_REPEAT_MS);
		}

		return {
			down: function (code, video, isRepeat) {
				if (held && held.code === code) return; // auto-repeat while holding
				if (held) clearTimeout(held.timer);
				if (isRepeat) return;
				held = { code: code, video: video, longs: 0, timer: setTimeout(longStep, LONG_PRESS_MS) };
			},
			// Returns true if the key-up belonged to a playback seek.
			up: function (code) {
				if (!held || held.code !== code) return false;
				clearTimeout(held.timer);
				if (!held.longs) Seeker.seekBy(held.video, code === KEY.RIGHT ? SEEK_SECONDS : -SEEK_SECONDS);
				held = null;
				return true;
			},
		};
	})();

	// While watching with the cursor hidden, the remote acts like a normal TV player remote.
	function handlePlaybackKey(code, isRepeat) {
		if (Pointer.isVisible() || !playerIsOpen()) return false;
		var video = getMainVideo();
		if (!video || (IS_PRIME && !video.closest('#dv-web-player'))) return false;
		if (code === KEY.LEFT || code === KEY.RIGHT) {
			HoldSeek.down(code, video, isRepeat);
			return true;
		}
		if (isRepeat) return code === KEY.ENTER;
		if (code === KEY.ENTER) {
			if (video.paused) video.play();
			else video.pause();
			return true;
		}
		return false;
	}

	function onKeyDown(event) {
		if (!event.isTrusted) return;
		var code = event.keyCode;
		var handled = false;

		switch (code) {
			case KEY.RED:
				Pointer.toggle();
				handled = true;
				break;
			case KEY.BACK:
				handleBack();
				handled = true;
				break;
			case KEY.PLAY_PAUSE:
			case KEY.PLAY:
			case KEY.PAUSE:
			case KEY.STOP:
			case KEY.FAST_FORWARD:
			case KEY.REWIND:
				handled = handleMediaKey(code);
				break;
			case KEY.LEFT:
			case KEY.UP:
			case KEY.RIGHT:
			case KEY.DOWN:
			case KEY.ENTER:
				// Let the on-screen keyboard / text fields handle keys while typing.
				if (!Pointer.isEnabled() || isTextInput(document.activeElement)) break;
				if (handlePlaybackKey(code, event.repeat)) {
					handled = true;
					break;
				}
				if (code === KEY.ENTER) {
					if (!event.repeat) Pointer.click();
				} else {
					Pointer.press(ARROW_NAMES[code], event.repeat);
				}
				handled = true;
				break;
		}

		if (handled) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}

	var ARROW_NAMES = {};
	ARROW_NAMES[KEY.LEFT] = 'left';
	ARROW_NAMES[KEY.RIGHT] = 'right';
	ARROW_NAMES[KEY.UP] = 'up';
	ARROW_NAMES[KEY.DOWN] = 'down';

	function onKeyUp(event) {
		var name = ARROW_NAMES[event.keyCode];
		if (!name) return;
		if (HoldSeek.up(event.keyCode)) {
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}
		Pointer.release(name);
		if (Pointer.isEnabled() && !isTextInput(document.activeElement)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}

	function registerKeys() {
		try {
			if (window.tizen && tizen.tvinputdevice) {
				['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
					'MediaFastForward', 'MediaRewind', 'ColorF0Red', 'ColorF1Green'].forEach(function (name) {
					try { tizen.tvinputdevice.registerKey(name); } catch (e) { /* already registered */ }
				});
			}
		} catch (e) { /* not on a TV */ }
	}

	/* ------------------------------------------------------------------ */
	/* JioHotstar: log in if needed, then open the requested URL           */
	/* ------------------------------------------------------------------ */

	var Hotstar = (function () {
		var TARGET_KEY = 'ptHotstarTarget';
		var SEEN_KEY = 'ptHotstarTargetSeen';
		var LOGIN_URL = 'https://www.hotstar.com/in/mypage#mp-login';
		var LOGIN_FLOW_KEY = 'ptHotstarLoginFlow';
		var PROFILE_NAME = 'Jatin';
		var TARGET_TRIES_KEY = 'ptHotstarTargetTries';
		var targetOpenedAt = 0;
		var profileClickedAt = 0;
		var notice = null;
		var loginOpenedAt = 0;

		function loginState() {
			try {
				var v = JSON.parse(localStorage.getItem('loginState') || 'null');
				return v && v.value;
			} catch (e) { return null; }
		}

		function showNotice(text) {
			if (!document.body) return;
			if (!notice) {
				notice = document.createElement('div');
				notice.id = 'prime-tizen-login';
				notice.style.cssText = 'position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:2147483646;' +
					'padding:14px 28px;border-radius:10px;background:rgba(0,0,0,.8);color:#fff;' +
					'font:bold 26px/1.4 sans-serif;text-align:center;pointer-events:none;';
				document.body.appendChild(notice);
			}
			notice.textContent = text;
		}

		function hideNotice() {
			if (notice) notice.remove();
			notice = null;
		}

		function loginDialogOpen() {
			return !!document.querySelector('[role="dialog"] input, [role="dialog"] img');
		}

		function openLogin() {
			if (loginDialogOpen()) return;
			var now = Date.now();
			if (now - loginOpenedAt < 4000) return;
			loginOpenedAt = now;
			if (location.pathname.replace(/\/$/, '') !== '/in/mypage') {
				// Come back to the page the user was on once they're logged in.
				if (!sessionStorage.getItem(TARGET_KEY) && !/\/(paywall|mypage)/.test(location.pathname)) {
					sessionStorage.setItem(TARGET_KEY, location.href.split('#')[0]);
				}
				log('Not logged in, opening', LOGIN_URL);
				sessionStorage.setItem(LOGIN_FLOW_KEY, '1');
				location.href = LOGIN_URL;
				return;
			}
			if (!/mp-login/.test(location.hash)) {
				location.hash = 'mp-login';
				return;
			}
			// The hash didn't open the dialog on this page; press the site's Login button instead.
			var buttons = document.querySelectorAll('button, a, [role="button"]');
			for (var i = 0; i < buttons.length; i++) {
				if (/^\s*log\s*in\s*$/i.test(buttons[i].textContent) && isVisible(buttons[i])) {
					buttons[i].click();
					return;
				}
			}
		}

		function goToTarget() {
			var target = sessionStorage.getItem(TARGET_KEY);
			// After logging in on the login page, leave it even if there's no target URL.
			if (!target && sessionStorage.getItem(LOGIN_FLOW_KEY)) target = 'https://www.hotstar.com/in';
			sessionStorage.removeItem(LOGIN_FLOW_KEY);
			if (!target) return;
			var here = location.href.split('#')[0].replace(/\/$/, '');
			if (here === target.split('#')[0].replace(/\/$/, '')) {
				sessionStorage.removeItem(TARGET_KEY);
				sessionStorage.removeItem(TARGET_TRIES_KEY);
				return;
			}
			// Hotstar can redirect to /in/home or the profile picker first; keep the target until we land on it.
			var tries = +sessionStorage.getItem(TARGET_TRIES_KEY) || 0;
			if (tries >= 4) {
				sessionStorage.removeItem(TARGET_KEY);
				sessionStorage.removeItem(TARGET_TRIES_KEY);
				log('Gave up opening', target);
				return;
			}
			var now = Date.now();
			if (now - targetOpenedAt < 5000) return;
			targetOpenedAt = now;
			sessionStorage.setItem(TARGET_TRIES_KEY, String(tries + 1));
			log('Opening', target);
			location.href = target;
		}

		function onProfilePage() {
			return /\/onboarding\/profile/.test(location.pathname);
		}

		// No artwork anywhere except the login page (its QR code is an image).
		function keepImages() {
			return /\/mypage/.test(location.pathname);
		}

		function stripImages(root) {
			if (!root || root.nodeType !== 1 || keepImages()) return;
			var imgs = root.tagName === 'IMG' || root.tagName === 'SOURCE' ? [root] : root.querySelectorAll('img, source');
			for (var i = 0; i < imgs.length; i++) {
				var img = imgs[i];
				if (img.closest('[role="dialog"]')) continue;
				if (img.hasAttribute('srcset')) img.removeAttribute('srcset');
				if (img.hasAttribute('src') && !/^data:/.test(img.getAttribute('src'))) img.removeAttribute('src');
			}
		}

		function blockImages() {
			var style = document.createElement('style');
			style.id = 'prime-tizen-no-images';
			style.textContent =
				'html.pt-no-images img:not([role="dialog"] img),html.pt-no-images picture:not([role="dialog"] picture)' +
				'{visibility:hidden!important;}' +
				'html.pt-no-images body *:not([role="dialog"] *),html.pt-no-images body *::before,' +
				'html.pt-no-images body *::after{background-image:none!important;}';
			(document.head || document.documentElement).appendChild(style);
			var sync = function () {
				document.documentElement.classList.toggle('pt-no-images', !keepImages());
			};
			sync();
			new MutationObserver(function (records) {
				sync();
				for (var i = 0; i < records.length; i++) {
					var r = records[i];
					if (r.type === 'attributes') stripImages(r.target);
					else for (var j = 0; j < r.addedNodes.length; j++) stripImages(r.addedNodes[j]);
				}
			}).observe(document.documentElement, {
				childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'],
			});
			onReady(function () { stripImages(document.body); });
		}

		function selectProfile() {
			var now = Date.now();
			if (now - profileClickedAt < 3000) return;
			var names = document.querySelectorAll('[data-testid="profile-wrapper-id"] p');
			for (var i = 0; i < names.length; i++) {
				if (names[i].textContent.trim().toLowerCase() !== PROFILE_NAME.toLowerCase()) continue;
				var tile = names[i].closest('[role="button"]');
				if (!tile) continue;
				profileClickedAt = now;
				log('Selecting profile', PROFILE_NAME);
				tile.click();
				return;
			}
		}

		// Hotstar plays ads inside the movie's own <video>, so speed it up while the ad overlay is shown.
		var AD_RATE = 16;
		var MAX_AD_SECONDS = 180;
		var adSeekAt = 0;
		var adActive = false;
		var adLastSeen = 0;

		function adShowing() {
			if (!/\/watch\b/.test(location.pathname)) return false;
			var leaves = document.querySelectorAll('span, p, div');
			for (var i = 0; i < leaves.length; i++) {
				var el = leaves[i];
				if (el.children.length) continue;
				var t = el.textContent.trim();
				if ((t === 'Ad' || /^go ads free$/i.test(t)) && isVisible(el)) return true;
			}
			return false;
		}

		function setRate(video, rate) {
			// Some players reject very high rates; fall back to the fastest accepted one.
			var rates = rate > 1 ? [rate, 8, 4, 2] : [1];
			for (var i = 0; i < rates.length; i++) {
				try {
					video.playbackRate = rates[i];
					if (video.playbackRate === rates[i]) return rates[i];
				} catch (e) { /* try a lower rate */ }
			}
			return video.playbackRate;
		}

		function fastForwardAds() {
			var video = getMainVideo();
			if (!video) return;
			var now = Date.now();
			if (adShowing()) adLastSeen = now;
			// The overlay can flicker between ads; wait a moment before treating the break as over.
			var inAd = now - adLastSeen < 1200;
			if (inAd) {
				if (!adActive) {
					adActive = true;
					log('Ad detected (' + Math.round(video.currentTime) + '/' + Math.round(video.duration) + 's), skipping');
				}
				// Ads are short clips loaded into the same <video>; jump to the clip's end to finish it.
				var d = video.duration;
				if (isFinite(d) && d > 0 && d < MAX_AD_SECONDS && video.currentTime < d - 0.5 && now - adSeekAt > 800) {
					adSeekAt = now;
					try { video.currentTime = d - 0.1; } catch (e) { /* fall back to fast playback */ }
				}
				if (video.playbackRate !== AD_RATE) setRate(video, AD_RATE);
				if (video.paused) video.play().catch(function () {});
			} else if (adActive) {
				adActive = false;
				setRate(video, 1);
				log('Ad finished, back to 1x');
			}
		}

		// Pick the highest quality in the player's Quality menu (Hotstar remembers it per profile).
		var QUALITY_SKIP_RE = /^(auto|data saver)$/i;
		var qualityStep = 0;
		var qualityAt = 0;
		var qualityDoneFor = '';

		function qualityAction() {
			var labels = document.querySelectorAll('.player-menu-label p');
			for (var i = 0; i < labels.length; i++) {
				if (/^quality$/i.test(labels[i].textContent.trim())) return labels[i].closest('[data-testid="action"]');
			}
			return null;
		}

		function ensureBestQuality() {
			var video = getMainVideo();
			// Only for the movie itself, not ad clips.
			if (!video || adActive || !(video.duration > MAX_AD_SECONDS)) return;
			var page = location.pathname;
			if (qualityDoneFor === page) return;
			var now = Date.now();
			if (now - qualityAt < 700) return;
			qualityAt = now;
			var action = qualityAction();
			if (!action) return;
			if (qualityStep === 0) {
				action.click();
				qualityStep = 1;
				return;
			}
			qualityStep = 0;
			var options = document.querySelectorAll('[data-testid="player-menu"] button, button');
			var best = null;
			for (var i = 0; i < options.length; i++) {
				var b = options[i];
				if (b.getAttribute('data-testid') === 'player-menu') continue;
				var name = b.textContent.trim();
				if (!name || QUALITY_SKIP_RE.test(name) || name.length > 20) continue;
				var sub = b.parentElement && b.parentElement.textContent || '';
				// Options are listed best-first (Full HD "Up to 1080p", HD "Up to 720p", ...).
				if (/up to \d{3,4}p|4k|ultra|full hd|^hd$/i.test(name + ' ' + sub)) { best = b; break; }
			}
			qualityDoneFor = page;
			if (!best) return;
			var current = action.textContent.replace(/^\s*quality/i, '').trim();
			if (current === best.textContent.trim()) {
				action.click(); // close the menu again
				return;
			}
			log('Setting quality to', best.textContent.trim());
			best.click();
		}

		// Hotstar starts muted when it can't autoplay with sound (e.g. fresh install); unmute once per movie.
		var unmutedFor = '';

		function ensureSound() {
			var video = getMainVideo();
			if (!video || adActive || video.paused || !(video.duration > MAX_AD_SECONDS)) return;
			var page = location.pathname;
			if (unmutedFor === page) return;
			var btn = document.querySelector('button[data-testid="volume"]');
			if (!btn) return;
			unmutedFor = page;
			if (/^unmute$/i.test(btn.getAttribute('aria-label') || '')) {
				log('Unmuting');
				btn.click();
			}
		}

		function check() {
			var state = loginState();
			if (!state) return;
			if (state === 'GUEST') {
				openLogin();
				showNotice('Log in to JioHotstar: scan the QR code with your phone, or enter your mobile number');
				return;
			}
			hideNotice();
			if (onProfilePage()) {
				selectProfile();
				return;
			}
			goToTarget();
		}

		return {
			start: function () {
				// The companion passes the URL to open; remember it once per app launch.
				// With the companion, the launcher asks which movie and opens it directly; that first
				// page is the target to come back to after login/profile selection.
				if (window.__ptTargetUrl !== undefined && !sessionStorage.getItem(SEEN_KEY)) {
					sessionStorage.setItem(SEEN_KEY, '1');
					var first = window.__ptTargetUrl ||
						(/\/watch\b/.test(location.pathname) ? location.href.split('#')[0] : '');
					if (first) sessionStorage.setItem(TARGET_KEY, first);
				}
				blockImages();
				onReady(function () {
					check();
					setInterval(check, 1000);
					setInterval(fastForwardAds, 250);
					setInterval(ensureBestQuality, 1000);
					setInterval(ensureSound, 1000);
				});
			},
		};
	})();

	/* ------------------------------------------------------------------ */
	/* Boot                                                                */
	/* ------------------------------------------------------------------ */

	registerKeys();
	disableAnimations();
	if (IS_PRIME) {
		blockTrailerAutoplay();
		AutoPlay.start();
	} else {
		Hotstar.start();
	}
	window.addEventListener('keydown', onKeyDown, true);
	window.addEventListener('keyup', onKeyUp, true);
	window.addEventListener('blur', function () { Pointer.release(); });
	onReady(function () {
		Pointer.create();
		Pointer.show();
		if (IS_PRIME) AdSkipper.start();
		log('Loaded');
	});
})();
