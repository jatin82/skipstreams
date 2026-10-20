'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const load = import('./tizenbrew-service-controls.mjs');

function snapshot(session = 'original') {
	return { session, pid: session === 'original' ? 10 : 11, uptime: 5, entries: [], cursor: 0 };
}

async function fixture(handler) {
	const { createServiceControls } = await load;
	const requests = [];
	let clock = 0;
	let launches = 0;
	const platform = {
		setTimeout, clearTimeout, now: () => clock,
		sleep: async ms => { clock += ms; },
		XMLHttpRequest: class {
			open(method, url) { this.method = method; this.url = url; }
			setRequestHeader(name, value) { this.header = { name, value }; }
			send() {
				assert.equal(this.timeout, 3000);
				assert.deepEqual(this.header, { name: 'Authorization', value: 'Bearer test-token' });
				requests.push({ method: this.method, url: this.url });
				queueMicrotask(() => {
					const response = handler(this.method, this.url);
					if (response.network) this.onerror();
					else if (response.timeout) this.ontimeout();
					else {
						this.status = response.status || 200;
						this.responseText = response.raw === undefined ? JSON.stringify(response.body) : response.raw;
						this.onload();
					}
				});
			}
		},
		tizen: {
			ApplicationControl: function (operation) { this.operation = operation; },
			application: {
				getCurrentApplication: () => ({ appInfo: { packageId: 'xvvl3S1bvH' } }),
				launchAppControl(control, id, success) {
					assert.equal(control.operation, 'http://tizen.org/appcontrol/operation/service');
					assert.equal(id, 'xvvl3S1bvH.StandaloneService');
					launches++;
					success();
				},
			},
		},
	};
	return { client: createServiceControls('test-token', platform), requests, platform,
		launches: () => launches, elapsed: () => clock };
}

test('service check requires a valid fresh health response and preserves the log cursor', async () => {
	const f = await fixture(() => ({ body: snapshot() }));
	assert.equal((await f.client.check({ session: 'original', after: 12 })).pid, 10);
	assert.match(f.requests[0].url, /live\?session=original&after=12$/);
	for (const response of [{ network: true }, { timeout: true }, { status: 401 },
		{ raw: 'invalid JSON' }, { body: { pid: 10 } }]) {
		const failing = await fixture(() => response);
		await assert.rejects(failing.client.check());
	}
});

test('manual restart stops the old service, launches it, and requires a new session', async () => {
	let stopped = false;
	const f = await fixture(method => {
		if (method === 'POST') {
			stopped = true;
			return { status: 202, body: { restarting: true, session: 'original' } };
		}
		return { body: { ...snapshot(stopped ? 'new' : 'original'), pid: 10 } };
	});
	const progress = [];
	const result = await f.client.restart(message => progress.push(message));
	assert.equal(result.restarted, true);
	assert.equal(result.snapshot.session, 'new');
	assert.equal(result.snapshot.pid, 10, 'The TV may reuse its OS PID for a new service runtime');
	assert.equal(f.launches(), 1);
	assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
	assert.ok(progress.some(message => message.includes('fresh response')));
});

test('an unavailable service is launched but is not falsely described as a confirmed restart', async () => {
	let checks = 0;
	const f = await fixture(() => ++checks <= 2 ? { network: true } : { body: snapshot('new') });
	const result = await f.client.restart(() => {});
	assert.equal(result.restarted, false);
	assert.equal(f.launches(), 1);
	assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('launch acceptance and an unchanged PID/session cannot report a successful restart', async () => {
	const f = await fixture(method => method === 'POST' ?
		{ status: 202, body: { restarting: true, session: 'original' } } : { body: snapshot() });
	await assert.rejects(f.client.restart(() => {}), /recovery was not confirmed/);
	assert.ok(f.elapsed() >= 30000);
});

test('authorization failures never trigger a launch and native launch failures remain explicit', async () => {
	const unauthorized = await fixture(() => ({ status: 401 }));
	await assert.rejects(unauthorized.client.restart(() => {}), /HTTP 401/);
	assert.equal(unauthorized.launches(), 0);
	const refused = await fixture(() => ({ network: true }));
	refused.platform.tizen.application.launchAppControl = (control, id, success, failure) => failure(new Error('denied'));
	await assert.rejects(refused.client.restart(() => {}), /launch failed: denied/);
});

test('translation instance is initialized before delayed TV locale discovery', () => {
	const calls = [];
	let localeCallback;
	const i18n = {
		use() { return this; },
		init(options) {
			calls.push('init');
			assert.equal(options.initImmediate, false);
			assert.equal(options.lng, 'en');
		},
		changeLanguage(language) { calls.push(language); return Promise.resolve(); },
		addResourceBundle(language, namespace, data) {
			assert.equal(language, 'en');
			assert.equal(data.diagnostics.title, 'Service diagnostics');
		},
	};
	const source = fs.readFileSync(path.join(__dirname, 'tizenbrew-ui-i18n.js'), 'utf8')
		.replace(/^import .*;\r?$/gm, '').replace('export default i18n;', '');
	vm.runInNewContext(source, {
		i18n, initReactI18next: {}, resources: {}, navigator: { language: 'en-US' }, console,
		tizen: { systeminfo: { getPropertyValue(name, success) { localeCallback = success; calls.push(name); } } },
	});
	assert.deepEqual(calls, ['init', 'LOCALE']);
	localeCallback({ language: 'fr_FR' });
	assert.deepEqual(calls, ['init', 'LOCALE', 'fr']);
});

test('saved history includes previous sessions and reports unreadable records without hiding valid ones', async () => {
	const { parseDiagnosticHistory } = await load;
	const record = { time: '2026-10-19T10:00:00Z', session: 'old', level: 'error',
		text: 'upload failed', url: 'transport://TizenBrewService' };
	const result = parseDiagnosticHistory(JSON.stringify(record) + '\npartial record\n' +
		JSON.stringify({ ...record, session: 'new' }) + '\n');
	assert.equal(result.entries.length, 2);
	assert.deepEqual(result.invalidLines, [2]);
	assert.throws(() => parseDiagnosticHistory(''), /empty/);
	assert.throws(() => parseDiagnosticHistory('x'.repeat(524289)), /512 KiB/);
	const f = await fixture(() => ({ raw: JSON.stringify(record) + '\n' }));
	assert.equal((await f.client.history()).entries[0].text, 'upload failed');
});

test('the viewer keeps more than 100 records, upgrades partial live messages, and bounds its byte budget', async () => {
	const { mergeDiagnosticEntries, diagnosticSource } = await load;
	const saved = Array.from({ length: 350 }, (_, id) => ({
		id, session: 'service-run', time: '2026-10-19T10:00:00Z', level: 'info',
		text: 'record ' + id, url: 'service://TizenBrew',
	}));
	let result = mergeDiagnosticEntries([], saved);
	assert.equal(result.length, 350);
	result = mergeDiagnosticEntries(result, [{ ...saved[0], text: 'x'.repeat(8000) }]);
	assert.equal(result.length, 350);
	assert.equal(result.find(entry => entry.id === 0).text.length, 8000);
	assert.equal(diagnosticSource(saved[0]), 'SERVICE');
	assert.equal(diagnosticSource({ url: 'transport://TizenBrew' }), 'TRANSPORT');
	assert.equal(diagnosticSource({ url: 'ui://TizenBrew' }), 'UI');
	assert.equal(diagnosticSource({ url: 'https://www.google.com/' }), 'PAGE');
	result = mergeDiagnosticEntries([], saved.map(entry => ({ ...entry, text: '\u0000'.repeat(8000) })));
	assert.ok(result.length < saved.length);
	assert.ok(result.reduce((sum, entry) => sum + new Blob([JSON.stringify(entry)]).size, 0) <= 2097152);
});

test('UI console and browser errors remain observable without a service or debugger', async t => {
	const { createUiDiagnostics } = await import('./tizenbrew-ui-diagnostics.mjs');
	const events = new Map();
	const originalCalls = [];
	const localConsole = {};
	for (const name of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'table', 'assert']) {
		localConsole[name] = (...args) => { originalCalls.push(args); return 'original result'; };
	}
	const originalLog = localConsole.log;
	const capture = createUiDiagnostics({
		console: localConsole, setTimeout, clearTimeout,
		addEventListener: (name, listener) => events.set(name, listener),
		removeEventListener: name => events.delete(name),
	}, 'private-ui-token', true);
	t.after(() => capture.stop());
	let entries;
	capture.subscribe(value => { entries = value; });
	assert.equal(localConsole.log('not on the PC', 'private-ui-token'), 'original result');
	localConsole.assert(true, 'do not record');
	localConsole.assert(false, 'assertion failed');
	const cyclic = {};
	cyclic.self = cyclic;
	localConsole.error(cyclic);
	events.get('error')({ error: new Error('UI failure'), filename: 'panel.js', lineno: 4 });
	events.get('unhandledrejection')({ reason: 'rejected without service' });
	await new Promise(resolve => setTimeout(resolve, 10));
	const text = entries.map(entry => entry.text).join('\n');
	assert.match(text, /not on the PC \[redacted\]/);
	assert.match(text, /UI failure/);
	assert.match(text, /rejected without service/);
	assert.match(text, /serialization failed/);
	assert.match(text, /assertion failed/);
	assert.ok(!text.includes('do not record'));
	assert.ok(!text.includes('private-ui-token'));
	assert.equal(originalCalls.length, 4);
	for (let i = 0; i < 300; i++) capture.record('debug', 'x'.repeat(8000));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(entries.reduce((sum, entry) => sum + new Blob([JSON.stringify(entry)]).size, 0) <= 131072);
	capture.stop();
	assert.equal(localConsole.log, originalLog);
	assert.equal(events.size, 0);
});

test('UI logging defaults off and read-only checks never launch a service', async () => {
	const { createUiDiagnostics } = await import('./tizenbrew-ui-diagnostics.mjs');
	const capture = createUiDiagnostics({});
	let entries;
	capture.record('error', 'disabled');
	const unsubscribe = capture.subscribe(value => { entries = value; });
	assert.deepEqual(entries, []);
	unsubscribe();
	capture.stop();
	const f = await fixture(() => ({ network: true }));
	await assert.rejects(f.client.check());
	await assert.rejects(f.client.check());
	assert.equal(f.launches(), 0);
});
