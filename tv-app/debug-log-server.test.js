'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createLogServer, attachDebugger, argumentText, parseOptions } = require('./debug-log-server');
const rawLogForwarder = require('./tizenbrew-log-forwarder');
const rawServiceDiagnostics = require('./tizenbrew-service-diagnostics');
const attachLogForwarder = (client, moduleInfo, config, record) =>
	rawLogForwarder(client, moduleInfo, { loggingEnabled: true, ...config }, record);
const startServiceDiagnostics = (config, forwarder, runtime) =>
	rawServiceDiagnostics({ loggingEnabled: true, ...config }, forwarder, runtime);

test('logging defaults off without uploads while recovery and Google Back remain functional', async t => {
	const output = createLogServer({ token: 'disabled-test' });
	let uploads = 0;
	output.server.on('request', request => { if (request.method === 'POST') uploads++; });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const client = new EventEmitter();
	const evaluations = [];
	const evaluate = async params => { evaluations.push(params.expression); return {}; };
	let home;
	client.Runtime = { evaluate };
	client.Page = {
		enable: async () => assert.fail('Diagnostic Page events must not be enabled by default'),
		navigate: async params => { home = params.url; return {}; },
	};
	client.send = async () => {};
	client.__tvDebugPort = 12345;
	const records = [];
	const moduleInfo = { name: 'google-test', fullName: 'gh/jatin82/skipstreams@v1.4.1/google-test' };
	const forwarder = rawLogForwarder(client, moduleInfo,
		{ host: '127.0.0.1', port: output.server.address().port, token: 'disabled-test' },
		entry => records.push(entry));
	t.after(() => forwarder.stop());
	client.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'not uploaded' }] });
	client.emit('Runtime.executionContextCreated', { context: { id: 1, origin: 'file://' } });
	await new Promise(resolve => setImmediate(resolve));
	assert.ok(evaluations.some(expression => expression.includes('__tizenBrewDebugPort = 12345')));
	assert.equal(client.Runtime.evaluate, evaluate);
	const download = Promise.resolve('script');
	assert.equal(client.__tvDebugFetch(() => download, 'test'), download);
	const cache = new Map();
	assert.equal(client.__tvDebugCacheSet(cache, 'test', 'script'), cache);
	assert.equal(client.__tvDebugCacheGet(cache, 'test'), 'script');
	client.emit('Runtime.bindingCalled', { name: '__tizenBrewGoogleBack', payload: 'home' });
	forwarder.flush();
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.equal(home, 'file:///tizenbrew-ui/dist/index.html');
	assert.equal(uploads, 0);
	assert.equal(records.length, 0);
	assert.equal(forwarder.getStatus().loggingEnabled, false);
	assert.equal(forwarder.getStatus().queued, 0);
});

test('Google remote Back returns to local Home and clears only the active module', async t => {
	const client = new EventEmitter();
	const moduleInfo = { name: 'google-test', fullName: 'gh/jatin82/skipstreams@v1.4.1/google-test',
		appPath: 'https://www.google.com/', mainFile: 'userScript.js' };
	let keyHandler;
	let navigated;
	let prevented = false;
	const page = {
		addEventListener(type, handler) { if (type === 'keydown') keyHandler = handler; },
		__tizenBrewGoogleBack(payload) { client.emit('Runtime.bindingCalled', { name: '__tizenBrewGoogleBack', payload }); },
	};
	page.top = page;
	client.send = async (method, params) => {
		assert.equal(method, 'Runtime.addBinding');
		assert.ok(['__tizenBrewReturnToHome', '__tizenBrewGoogleBack'].includes(params.name));
	};
	client.Runtime = { evaluate: async params => { vm.runInNewContext(params.expression, { window: page }); return {}; } };
	client.Page = { enable: async () => {}, navigate: async params => {
		assert.equal(moduleInfo.name, '');
		navigated = params.url;
		return {};
	} };
	const records = [];
	const forwarder = attachLogForwarder(client, moduleInfo, { host: '127.0.0.1', port: 1, token: 'test' },
		entry => records.push(entry));
	t.after(() => forwarder.stop());
	client.emit('Runtime.executionContextCreated', { context: { id: 5, origin: 'https://www.google.com' } });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(typeof keyHandler, 'function');
	keyHandler({ keyCode: 10009, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(prevented, true);
	assert.equal(navigated, 'file:///tizenbrew-ui/dist/index.html');
	assert.equal(moduleInfo.fullName, '');
	assert.equal(moduleInfo.mainFile, '');
	assert.ok(records.some(entry => entry.text.includes('Module closed')));
});

test('a failed Google Home navigation restores module selection and reports the failure', async t => {
	const client = new EventEmitter();
	const moduleInfo = { name: 'google-test', fullName: 'gh/jatin82/skipstreams@v1.4.1/google-test',
		appPath: 'https://www.google.com/' };
	client.send = async () => {};
	client.Runtime = {};
	client.Page = { navigate: async () => ({ errorText: 'navigation denied' }) };
	const records = [];
	const forwarder = attachLogForwarder(client, moduleInfo, { host: '127.0.0.1', port: 1, token: 'test' },
		entry => records.push(entry));
	t.after(() => forwarder.stop());
	client.emit('Runtime.bindingCalled', { name: '__tizenBrewGoogleBack', payload: 'home' });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(moduleInfo.name, 'google-test');
	assert.ok(records.some(entry => entry.level === 'error' && entry.text.includes('navigation denied')));
});

test('Prime and Hotstar return to TizenBrew with logging off, without affecting unrelated modules', async t => {
	for (const fullName of [
		'gh/jatin82/skipstreams@v1.4.0',
		'gh/jatin82/skipstreams@v1.4.0/hotstar',
		'gh/other/repository@main',
	]) {
		const client = new EventEmitter();
		const moduleInfo = { name: 'selected', fullName, mainFile: 'userScript.js' };
		const bindings = [];
		let navigated;
		client.send = async (method, params) => bindings.push(params.name);
		client.Runtime = {};
		client.Page = { navigate: async params => {
			assert.equal(moduleInfo.name, '');
			navigated = params.url;
			return {};
		} };
		const forwarder = rawLogForwarder(client, moduleInfo, { host: '127.0.0.1', port: 1, token: 'test' });
		t.after(() => forwarder.stop());
		await new Promise(resolve => setImmediate(resolve));
		assert.ok(bindings.includes('__tizenBrewReturnToHome'));
		assert.ok(bindings.includes('__tizenBrewGoogleBack'));
		client.emit('Runtime.bindingCalled', { name: '__tizenBrewReturnToHome', payload: 'home' });
		await new Promise(resolve => setImmediate(resolve));
		if (fullName.startsWith('gh/jatin82/skipstreams')) {
			assert.equal(navigated, 'file:///tizenbrew-ui/dist/index.html');
			assert.equal(moduleInfo.fullName, '');
			assert.equal(moduleInfo.mainFile, '');
		} else {
			assert.equal(navigated, undefined);
			assert.equal(moduleInfo.fullName, fullName);
		}
		assert.equal(forwarder.getStatus().queued, 0);
	}
});

test('formats console values without executing page code', () => {
	assert.equal(argumentText({ value: 'hello' }), 'hello');
	assert.equal(argumentText({ value: null }), 'null');
	assert.equal(argumentText({ value: { x: 2 } }), '{"x":2}');
	assert.equal(argumentText({ unserializableValue: 'NaN' }), 'NaN');
	assert.equal(argumentText({ description: 'Error: fail' }), 'Error: fail');
	assert.equal(argumentText({ value: undefined }), 'undefined');
	assert.equal(argumentText({ description: 'Object', preview: {
		properties: [{ name: 'playing', value: 'true' }], overflow: false,
	} }), 'Object {playing: true}');
});

test('validates options and port ranges', () => {
	assert.equal(parseOptions([]).port, 8087);
	assert.equal(parseOptions(['--port', '8088']).port, 8088);
	assert.throws(() => parseOptions(['--debug-port', '38603']));
	assert.throws(() => parseOptions(['--port', '0']));
	assert.throws(() => parseOptions(['--port', '8087.5']));
	assert.throws(() => parseOptions(['--port']));
	assert.throws(() => parseOptions(['--unknown', 'x']));
});

test('captures page console levels, object descriptions, errors and navigations', async () => {
	const client = new EventEmitter();
	const entries = [];
	const enabled = [];
	client.Runtime = { enable: async () => enabled.push('Runtime') };
	client.Page = {
		enable: async () => enabled.push('Page'),
		getFrameTree: async () => ({ frameTree: { frame: { url: 'https://primevideo.com/' } } }),
	};
	await attachDebugger(client, { add: entry => entries.push(entry) });
	assert.deepEqual(enabled, ['Runtime', 'Page']);
	for (const type of ['log', 'debug', 'info', 'warning', 'error', 'assert', 'trace', 'table']) {
		client.emit('Runtime.consoleAPICalled', {
			type, args: [{ value: '[PrimeTizen]' }, { description: 'Object' }],
		});
	}
	assert.equal(entries.length, 8);
	assert.equal(entries[0].text, '[PrimeTizen] Object');
	assert.equal(entries[0].url, 'https://primevideo.com/');
	client.emit('Page.frameNavigated', { frame: { url: 'https://hotstar.com/' } });
	client.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'Error: test' } } });
	assert.equal(entries[8].text, 'Uncaught: Error: test');
	assert.equal(entries[8].url, 'https://hotstar.com/');
});

test('serves dashboard, bounded history, live SSE and downloadable JSON', async t => {
	const output = createLogServer();
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const base = 'http://127.0.0.1:' + output.server.address().port;
	for (let i = 0; i < 1005; i++) output.add({ level: 'log', text: String(i) });
	const last = output.add({ text: 'x'.repeat(9000), url: 'https://primevideo.com/' });
	assert.equal(last.text.length, 8000);
	const response = await fetch(base + '/logs.json');
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.logs.length, 1000);
	assert.equal(data.logs[0].text, '6');
	assert.equal(data.logs.at(-1).text.length, 8000);
	const html = await (await fetch(base)).text();
	assert.match(html, /Tizen live debug logs/);
	assert.match(html, /textContent/);
	assert.equal((await fetch(base + '/missing')).status, 404);
	assert.equal((await fetch(base, { method: 'POST' })).status, 405);
	const controller = new AbortController();
	const events = await fetch(base + '/events', { signal: controller.signal });
	assert.match(events.headers.get('content-type'), /text\/event-stream/);
	const reader = events.body.getReader();
	const decoder = new TextDecoder();
	let chunk = decoder.decode((await reader.read()).value);
	assert.match(chunk, /event: snapshot/);
	output.add({ level: 'error', text: 'live message' });
	let live = '';
	while (!live.includes('live message')) live += decoder.decode((await reader.read()).value);
	assert.match(live, /event: log/);
	controller.abort();
});

test('receiver rejects unauthorized, invalid and oversized uploads', async t => {
	const output = createLogServer({ token: 'test-token' });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const url = 'http://127.0.0.1:' + output.server.address().port + '/ingest';
	async function post(body, token = 'test-token') {
		return fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body });
	}
	assert.equal((await post('[]', 'wrong')).status, 401);
	assert.equal((await post('not JSON')).status, 400);
	assert.equal((await post('[null]')).status, 400);
	assert.equal((await post(JSON.stringify([{ text: 'missing fields' }]))).status, 400);
	assert.equal((await post(JSON.stringify(Array(21).fill({ text: '', level: 'log', url: '' })))).status, 400);
	assert.equal((await post('x'.repeat(262145))).status, 413);
	assert.equal((await post(JSON.stringify([{ text: 'valid', level: 'log', url: '' }]))).status, 204);
});

test('on-TV forwarder uploads console events and errors without SDB or page network requests', async t => {
	const output = createLogServer({ token: 'integration-token' });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const client = new EventEmitter();
	t.after(() => client.emit('disconnect'));
	const forwarder = attachLogForwarder(client,
		{ fullName: 'gh/jatin82/skipstreams@v1.4.0', appPath: 'https://primevideo.com/' },
		{ host: '127.0.0.1', port: output.server.address().port, token: 'integration-token' });
	for (const type of ['log', 'debug', 'info', 'warning', 'error', 'assert', 'trace', 'table']) {
		client.emit('Runtime.consoleAPICalled', {
			type, args: [{ value: '[PrimeTizen] ' + type }, { description: 'Object' }],
			stackTrace: { callFrames: [{ url: 'https://hotstar.com/test' }] },
		});
	}
	client.emit('Runtime.exceptionThrown', {
		exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: test exception' } },
	});
	forwarder.flush();
	let data;
	const base = 'http://127.0.0.1:' + output.server.address().port;
	for (let attempt = 0; attempt < 50; attempt++) {
		data = await (await fetch(base + '/logs.json')).json();
		if (data.logs.length === 10) break;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.equal(data.logs.length, 10);
	assert.match(data.logs[0].text, /Forwarding started/);
	assert.equal(data.logs[1].text, '[PrimeTizen] log Object');
	assert.equal(data.logs[1].url, 'https://hotstar.com/test');
	assert.equal(data.logs[9].text, 'Uncaught: Error: test exception');
	assert.match(data.status, /Receiving TV service logs/);
});

test('on-TV forwarder bounds its queue and transmits worst-case Unicode batches within receiver limits', async t => {
	const output = createLogServer({ token: 'limit-test' });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const client = new EventEmitter();
	t.after(() => client.emit('disconnect'));
	const forwarder = attachLogForwarder(client, { appPath: 'https://primevideo.com/' },
		{ host: '127.0.0.1', port: output.server.address().port, token: 'limit-test' });
	for (let i = 0; i < 250; i++) {
		client.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: String(i) + '\u0000'.repeat(8000) }] });
	}
	forwarder.flush();
	const base = 'http://127.0.0.1:' + output.server.address().port;
	let data;
	for (let attempt = 0; attempt < 50; attempt++) {
		data = await (await fetch(base + '/logs.json')).json();
		if (data.logs.length) break;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.ok(data.logs.length > 0);
	assert.ok(data.logs.length < 20);
	assert.ok(data.logs[0].text.startsWith('50'));
	assert.equal(data.logs[0].text.length, 8000);
});

test('TV diagnostics report failed evaluation and deliver debugger disconnect before shutting down', async t => {
	const output = createLogServer({ token: 'diagnostics-test' });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const client = new EventEmitter();
	client.Runtime = { evaluate: async () => ({ exceptionDetails: { text: 'SyntaxError' } }) };
	client.Page = { enable: async () => {} };
	attachLogForwarder(client, { fullName: 'google-test', appPath: 'https://www.google.com/' },
		{ host: '127.0.0.1', port: output.server.address().port, token: 'diagnostics-test' });
	client.emit('Runtime.executionContextCreated', { context: { id: 7, origin: 'https://www.google.com' } });
	client.emit('Page.frameNavigated', { frame: { url: 'https://www.google.com/' } });
	const result = await client.Runtime.evaluate({ expression: 'bad script', contextId: 7 });
	assert.equal(result.exceptionDetails.text, 'SyntaxError');
	await new Promise(resolve => setImmediate(resolve));
	client.emit('disconnect');
	let data;
	for (let attempt = 0; attempt < 100; attempt++) {
		data = await (await fetch('http://127.0.0.1:' + output.server.address().port + '/logs.json')).json();
		if (data.logs.some(entry => entry.text.includes('Page debugger disconnected'))) break;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.ok(data.logs.some(entry => entry.text.includes('Execution context 7; module=google-test')));
	assert.ok(data.logs.some(entry => entry.text.includes('Navigated to https://www.google.com/')));
	assert.ok(data.logs.some(entry => entry.text.includes('evaluate exception:') && entry.level === 'error'));
	assert.ok(data.logs.some(entry => entry.text.includes('Page debugger disconnected')));
});

test('injection diagnostics preserve and report synchronous throws and arbitrary promise rejections', async t => {
	const output = createLogServer({ token: 'exception-test' });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const client = new EventEmitter();
	let failure;
	let reject = false;
	client.Runtime = { evaluate: function () {
		if (reject) return Promise.reject(failure);
		throw failure;
	} };
	const forwarder = attachLogForwarder(client, { fullName: 'google-test' },
		{ host: '127.0.0.1', port: output.server.address().port, token: 'exception-test' });
	const cyclic = {};
	cyclic.self = cyclic;
	for (const value of [new SyntaxError('invalid script'), 'string failure', null, undefined, cyclic]) {
		failure = value;
		try {
			client.Runtime.evaluate({ expression: 'test' });
			assert.fail('Expected original thrown value');
		} catch (error) {
			assert.equal(error, value);
		}
	}
	reject = true;
	for (const value of [new Error('debugger disconnected'), 'rejected string', null]) {
		failure = value;
		await client.Runtime.evaluate({ expression: 'test' }).then(
			() => assert.fail('Expected original rejection'),
			error => assert.equal(error, value)
		);
	}
	forwarder.flush();
	let data;
	for (let attempt = 0; attempt < 100; attempt++) {
		data = await (await fetch('http://127.0.0.1:' + output.server.address().port + '/logs.json')).json();
		if (data.logs.length >= 17) break;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.equal(data.logs.filter(entry => entry.text.includes('evaluate threw:')).length, 5);
	assert.equal(data.logs.filter(entry => entry.text.includes('evaluate failed:')).length, 3);
	assert.ok(data.logs.some(entry => entry.text.includes('SyntaxError: invalid script')));
	assert.ok(data.logs.some(entry => entry.text.includes('Unserializable thrown value')));
	client.emit('disconnect');
});

test('logs cache, download and body-read steps without changing values or failures', async t => {
	const output = createLogServer({ token: 'step-test' });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const client = new EventEmitter();
	attachLogForwarder(client, { name: 'google-test', fullName: 'gh/google-test' },
		{ host: '127.0.0.1', port: output.server.address().port, token: 'step-test' });
	const cache = new Map();
	assert.equal(client.__tvDebugCacheGet(cache, 'test'), undefined);
	assert.equal(client.__tvDebugCacheSet(cache, 'test', 'script'), cache);
	assert.equal(client.__tvDebugCacheGet(cache, 'test'), 'script');
	const response = { status: 200, ok: true, text: async () => 'script' };
	assert.equal(await client.__tvDebugFetch(async () => response, 'https://cdn.example/script.js'), response);
	assert.equal(await response.text(), 'script');
	const missing = { status: 404, ok: false, text: async () => 'not found' };
	assert.equal(await client.__tvDebugFetch(async () => missing, 'https://cdn.example/missing'), missing);
	const syncFailure = new Error('sync fetch failure');
	assert.throws(() => client.__tvDebugFetch(() => { throw syncFailure; }, 'test'), error => error === syncFailure);
	await assert.rejects(client.__tvDebugFetch(() => Promise.reject(new Error('network failure')), 'test'), /network failure/);
	const unreadable = { status: 200, text: () => Promise.reject(new Error('body failure')) };
	await client.__tvDebugFetch(async () => unreadable, 'test');
	await assert.rejects(unreadable.text(), /body failure/);
	const syncBody = { status: 200, text: () => { throw new Error('sync body failure'); } };
	await client.__tvDebugFetch(async () => syncBody, 'test');
	assert.throws(() => syncBody.text(), /sync body failure/);
	// Disconnect drains batches, including diagnostics beyond the first 20 entries.
	client.emit('disconnect');
	let data;
	for (let attempt = 0; attempt < 150; attempt++) {
		data = await (await fetch('http://127.0.0.1:' + output.server.address().port + '/logs.json')).json();
		if (data.logs.some(entry => entry.text.includes('Page debugger disconnected'))) break;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	for (const marker of ['cache miss', 'cache hit', 'Script cached', 'download requested',
		'HTTP 200', 'HTTP 404', 'Reading script response body', 'body read; characters=6',
		'download threw:', 'download failed:', 'body read failed:', 'body read threw:']) {
		assert.ok(data.logs.some(entry => entry.text.includes(marker)), 'Missing diagnostic: ' + marker);
	}
});

test('service uploader and heartbeat work without a page debugger and preserve console behavior', async t => {
	const output = createLogServer({ token: 'service-test' });
	await new Promise(resolve => output.server.listen(0, '127.0.0.1', resolve));
	t.after(() => output.close());
	const localProcess = new EventEmitter();
	localProcess.pid = 123;
	localProcess.version = 'v4.4.3';
	localProcess.uptime = () => 42;
	const calls = [];
	const localConsole = {};
	for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
		localConsole[level] = (...args) => calls.push({ level, args });
	}
	const originalLog = localConsole.log;
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-service-test-'));
	const service = startServiceDiagnostics(
		{ host: '127.0.0.1', port: output.server.address().port, token: 'service-test' },
		attachLogForwarder, { console: localConsole, process: localProcess, heartbeatMs: 20,
			logPath: path.join(directory, 'diagnostics.jsonl') });
	t.after(() => {
		service.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	service.bindState(() => ({ module: 'google-test', debug: { tizenDebug: false } }));
	localConsole.log('Service started');
	localConsole.error(new Error('ADB connection failure'));
	localConsole.error('[TV debug logs] Upload failed; retrying: offline');
	service.report('info', 'Module launch received; module=google-test');
	localProcess.emit('uncaughtExceptionMonitor', new Error('fatal test'), 'uncaughtException');
	let data;
	for (let attempt = 0; attempt < 100; attempt++) {
		data = await (await fetch('http://127.0.0.1:' + output.server.address().port + '/logs.json')).json();
		if (data.logs.some(entry => entry.text.includes('Heartbeat;') && entry.text.includes('google-test')) &&
			data.logs.some(entry => entry.text.includes('fatal test'))) break;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	for (const text of ['Service diagnostics started', 'Service started', 'ADB connection failure',
		'Module launch received', 'fatal test', 'Heartbeat;']) {
		assert.ok(data.logs.some(entry => entry.text.includes(text)), 'Missing service log: ' + text);
	}
	assert.ok(!data.logs.some(entry => entry.text.includes('Upload failed; retrying: offline')));
	assert.equal(calls.length, 3);
	assert.equal(localProcess.listenerCount('uncaughtException'), 0);
	assert.equal(localProcess.listenerCount('unhandledRejection'), 0);
	assert.ok(data.logs.every(entry => entry.url === 'service://TizenBrew'));
	service.stop();
	assert.equal(localConsole.log, originalLog);
	assert.equal(localProcess.listenerCount('uncaughtExceptionMonitor'), 0);
});
