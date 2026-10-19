'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const manifest = require('./package.json');
const source = fs.readFileSync(path.join(__dirname, manifest.main), 'utf8');

function context(frame) {
	const logs = [];
	const window = {};
	window.top = frame ? {} : window;
	return {
		logs,
		sandbox: {
			window,
			location: { href: 'https://www.google.com/' },
			console: {
				log: text => logs.push({ level: 'log', text }),
				info: text => logs.push({ level: 'info', text }),
			},
		},
	};
}

test('module opens Google and logs the exact injection marker', () => {
	assert.equal(manifest.websiteURL, 'https://www.google.com/');
	assert.equal(manifest.packageType, 'mods');
	const { sandbox, logs } = context(false);
	vm.runInNewContext(source, sandbox);
	assert.deepEqual(logs, [
		{ level: 'log', text: 'i am injected' },
		{ level: 'info', text: '[GoogleInjectionTest] https://www.google.com/' },
	]);
	vm.runInNewContext(source, sandbox);
	assert.equal(logs.length, 2);
});

test('does not report injection in a child frame', () => {
	const { sandbox, logs } = context(true);
	vm.runInNewContext(source, sandbox);
	assert.equal(logs.length, 0);
});
