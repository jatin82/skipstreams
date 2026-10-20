'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createDeviceInfoClient = require('./tizenbrew-device-info');

function response(ip = '127.0.0.1', mode = '1') {
	return { ok: true, status: 200, json: async () => ({ device: { developerIP: ip, developerMode: mode } }) };
}

function setup(fetch) {
	const logs = [];
	const client = createDeviceInfoClient(fetch, (level, text) => logs.push({ level, text }), { retryDelayMs: 1 });
	const sent = [];
	const connection = {
		connection: { readyState: 1 },
		Event: (type, payload) => ({ type, payload }),
		send: event => sent.push(event),
	};
	return { client, logs, sent, connection, events: { CanLaunchInDebug: 2, Error: 8 } };
}

test('device checks preserve loopback aliases and developer-mode gating', async () => {
	for (const [ip, mode, expected] of [
		['127.0.0.1', '1', true], ['1.0.0.127', '1', true],
		['192.168.29.126', '1', false], ['127.0.0.1', '0', false], ['', '0', false],
	]) {
		const f = setup(async (address, options) => {
			assert.equal(address, 'http://127.0.0.1:8001/api/v2/');
			assert.deepEqual(options, { timeout: 3000, size: 65536 });
			return response(ip, mode);
		});
		assert.equal(await f.client.read(), expected);
		assert.equal(f.client.getStatus().allowed, expected);
	}
});

test('concurrent startup and UI checks share a request and never reply with stale null', async () => {
	let calls = 0;
	let resolve;
	const f = setup(() => {
		calls++;
		return new Promise(done => { resolve = done; });
	});
	const initial = f.client.read();
	assert.equal(f.client.read(), initial);
	const reply = f.client.reply(f.connection, f.events);
	await new Promise(done => setImmediate(done));
	assert.equal(calls, 1);
	assert.deepEqual(f.sent, []);
	assert.equal(f.client.getStatus().pending, true);
	resolve(response());
	assert.equal(await initial, true);
	await reply;
	assert.deepEqual(f.sent, [{ type: 2, payload: true }]);
	assert.equal(f.client.getStatus().pending, false);
});

test('connection refusal retries a bounded number of times and can recover', async () => {
	let calls = 0;
	const f = setup(async () => {
		if (++calls < 3) throw new Error('connect ECONNREFUSED 127.0.0.1:8001');
		return response();
	});
	await f.client.reply(f.connection, f.events);
	assert.equal(calls, 3);
	assert.deepEqual(f.sent, [{ type: 2, payload: true }]);
	assert.equal(f.logs.filter(entry => entry.level === 'error').length, 2);
	assert.equal(f.client.getStatus().lastError, null);
});

test('HTTP, malformed JSON, schema, timeout and synchronous failures produce explicit UI errors', async () => {
	for (const fetch of [
		async () => ({ ok: false, status: 503 }),
		async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }),
		async () => ({ ok: true, json: async () => ({ device: {} }) }),
		async () => { throw new Error('network timeout'); },
		() => { throw 'synchronous request failure'; },
	]) {
		let calls = 0;
		const f = setup((...args) => { calls++; return fetch(...args); });
		await f.client.reply(f.connection, f.events);
		assert.equal(calls, 3);
		assert.equal(f.sent.length, 1);
		assert.equal(f.sent[0].type, 8);
		assert.match(f.sent[0].payload, /unavailable after 3 attempts/);
		assert.equal(f.client.getStatus().allowed, null);
		assert.equal(f.client.getStatus().pending, false);
		assert.equal(f.logs.filter(entry => entry.level === 'error').length, 3);
	}
});

test('a fresh check can recover after exhausted startup retries without stale eligibility', async () => {
	let fail = true;
	const f = setup(async () => {
		if (fail) throw new Error('not ready');
		return response('192.168.29.126');
	});
	await assert.rejects(f.client.read(), /unavailable after 3 attempts/);
	fail = false;
	await f.client.reply(f.connection, f.events);
	assert.deepEqual(f.sent, [{ type: 2, payload: false }]);
	assert.equal(f.client.getStatus().attempts, 1);
});

test('closed sockets and response exceptions are reported without unhandled rejections', async () => {
	const f = setup(async () => response());
	f.connection.connection.readyState = 3;
	await f.client.reply(f.connection, f.events);
	assert.deepEqual(f.sent, []);
	assert.ok(f.logs.some(entry => entry.level === 'warning' && entry.text.includes('no longer open')));
	f.connection.connection.readyState = 1;
	f.connection.send = () => { throw new Error('send failed'); };
	await f.client.reply(f.connection, f.events);
	assert.ok(f.logs.some(entry => entry.level === 'error' && entry.text.includes('reply failed: send failed')));
});
