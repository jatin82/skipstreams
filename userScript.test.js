'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scripts = ['userScript.js', path.join('hotstar', 'userScript.js')];

class Element {
	constructor(tag) {
		this.tagName = tag;
		this.children = [];
		this.style = {};
		this.textContent = '';
	}
	get firstChild() { return this.children[0] || null; }
	appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
	removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
	remove() { this.parentNode.removeChild(this); }
	scrollIntoView() {}
}

function fixture(filename, options = {}) {
	const script = fs.readFileSync(path.join(__dirname, filename), 'utf8');
	const start = script.indexOf('\tvar PagePicker = (function () {');
	const end = script.indexOf('\n\t})();', start) + '\n\t})();'.length;
	assert.ok(start >= 0 && end > start, 'Movie picker source must be present');
	const backStart = script.indexOf('\tfunction showMovieList() {');
	const backEnd = script.indexOf('\n\tfunction handleMediaKey', backStart);
	const root = new Element('html');
	const timers = new Map();
	const messages = [];
	const requests = [];
	const calls = { exit: 0, close: 0, pause: 0, blur: 0 };
	const location = {
		hostname: filename === 'userScript.js' ? 'www.primevideo.com' : 'www.hotstar.com',
		pathname: '/watch/movie', href: 'https://example.com/watch/movie',
	};
	const context = {
		IS_PRIME: filename === 'userScript.js', WITH_COMPANION: !!options.companion,
		KEY: { BACK: 10009, UP: 38, DOWN: 40, ENTER: 13 },
		document: { documentElement: root, createElement: tag => new Element(tag),
			activeElement: { blur() { calls.blur++; } } },
		whenRoot: fn => fn(), getMainVideo: () => ({ pause() { calls.pause++; } }),
		isTextInput: () => !!options.textInput, location, history: { length: 1 },
		sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		log: (...args) => messages.push(args.join(' ')),
		trace: (...args) => messages.push(args.join(' ')),
		pagePath: url => new URL(url).origin + new URL(url).pathname,
		setTimeout(fn, ms) { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; },
		clearTimeout(id) { timers.delete(id); },
		tizen: options.missingTizen ? undefined : { application: {
			getCurrentApplication: () => ({ exit() {
				if (options.exitFailure) throw new Error('Exit failed');
				calls.exit++;
			} }),
		} },
		XMLHttpRequest: class {
			open() {}
			send() {
				this.responseText = JSON.stringify({
					amazonPrime: ['https://www.primevideo.com/detail/test/id'],
					jioHotstar: ['https://www.hotstar.com/in/movies/test/123'],
				});
				this.onload();
			}
		},
	};
	context.window = { close() { calls.close++; }, stop() {} };
	if (!options.missingBridge) {
		context.window.__tizenBrewReturnToHome = payload => {
			requests.push(payload);
			if (options.bridgeFailure) throw new Error('disconnected');
		};
	}
	vm.createContext(context);
	vm.runInContext(script.slice(start, end) + '\n' + script.slice(backStart, backEnd), context);
	function text(node = root) {
		return node.textContent + ' ' + node.children.map(child => text(child)).join(' ');
	}
	return { context, root, timers, messages, requests, calls, text };
}

test('Prime and Hotstar retain the same shared userscript implementation', () => {
	assert.equal(fs.readFileSync(path.join(__dirname, scripts[0]), 'utf8'),
		fs.readFileSync(path.join(__dirname, scripts[1]), 'utf8'));
});

for (const filename of scripts) {
	test(filename + ': first Back shows the movie list; second Back exits the app', () => {
		const f = fixture(filename);
		f.context.handleBack();
		assert.equal(f.calls.pause, 1);
		assert.equal(f.context.PagePicker.isOpen(), true);
		assert.deepEqual(f.requests, []);
		f.context.PagePicker.key(10009, false);
		assert.deepEqual(f.requests, []);
		assert.equal(f.calls.exit, 1);
		assert.equal(f.calls.close, 0);
	});

	test(filename + ': Exit app uses the native Tizen application exit', () => {
		const f = fixture(filename);
		f.context.PagePicker.open();
		f.context.PagePicker.key(40, false);
		f.context.PagePicker.key(13, false);
		assert.deepEqual(f.requests, []);
		assert.equal(f.calls.exit, 1);
		assert.equal(f.calls.close, 0);
	});

	test(filename + ': Back exits without the custom return bridge', () => {
		const f = fixture(filename, { missingBridge: true });
		f.context.PagePicker.open();
		f.context.PagePicker.key(10009, false);
		assert.equal(f.calls.exit, 1);
		assert.equal(f.calls.close, 0);
		assert.deepEqual(f.requests, []);
	});

	test(filename + ': unavailable or failing native exit falls back to closing the window', () => {
		for (const options of [{ missingTizen: true }, { exitFailure: true }]) {
			const f = fixture(filename, options);
			f.context.PagePicker.open();
			f.context.PagePicker.key(10009, false);
			assert.equal(f.calls.exit, 0);
			assert.equal(f.calls.close, 1);
			assert.deepEqual(f.requests, []);
			assert.equal(f.timers.size, 0);
		}
	});

	test(filename + ': companion movie-list navigation and input dismissal remain unchanged', () => {
		const companion = fixture(filename, { companion: true });
		companion.context.handleBack();
		assert.equal(companion.context.PagePicker.isOpen(), false);
		assert.ok(companion.messages.includes('Show movie list'));
		assert.deepEqual(companion.requests, []);
		const input = fixture(filename, { textInput: true });
		input.context.handleBack();
		assert.equal(input.calls.blur, 1);
		assert.equal(input.context.PagePicker.isOpen(), false);
	});
}
