const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalService, createUiServer } = require('./local-tizenbrew');

test('desktop adapter starts only on an explicit request and keeps TV operations local', () => {
	const service = createLocalService();
	assert.deepEqual(service.handle({ operation: 'health' }), { networkError: true });
	assert.throws(() => service.handle({ operation: 'message', message: { type: 4 } }), /stopped/);
	service.handle({ operation: 'start' });
	const health = service.handle({ operation: 'health' }).body;
	assert.equal(health.state.desktopAdapter, true);
	assert.equal(health.loggingEnabled, false);
	const modules = service.handle({ operation: 'message', message: { type: 4 } })[0].payload;
	assert.equal(modules.length, 3);
	assert.ok(modules.every(module => module.appName.includes('[local source]')));
	service.handle({ operation: 'message', message: { type: 5, payload: modules[0] } });
	assert.equal(service.handle({ operation: 'health' }).body.state.module, 'prime');
	service.handle({ operation: 'return', payload: 'home' });
	assert.equal(service.handle({ operation: 'health' }).body.state.module, '');
	const stopped = service.handle({ operation: 'restart' });
	assert.equal(stopped.status, 202);
	assert.deepEqual(service.handle({ operation: 'health' }), { networkError: true });
	service.handle({ operation: 'start' });
	assert.notEqual(service.handle({ operation: 'health' }).body.session, health.session);
});

test('desktop adapter never downloads or runs arbitrary module packages', () => {
	const service = createLocalService();
	service.handle({ operation: 'start' });
	assert.throws(() => service.handle({ operation: 'message',
		message: { type: 10, payload: { action: 'add', module: 'npm/arbitrary-package' } } }), /no remote package/);
	assert.throws(() => service.handle({ operation: 'message', message: { type: 6 } }), /not supported/);
	service.handle({ operation: 'message',
		message: { type: 10, payload: { action: 'add', module: 'gh/jatin82/skipstreams@v1.4.0/hotstar' } } });
	assert.ok(service.handle({ operation: 'message', message: { type: 4 } })[0].payload
		.some(module => module.fullName.endsWith('@v1.4.0/hotstar') && module.version.includes('working tree')));
});

test('local UI server exposes only its UI directory and does not accept service-control writes', async t => {
	const server = createUiServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
	const base = 'http://127.0.0.1:' + server.address().port;
	assert.equal((await fetch(base + '/receiver.json')).status, 404);
	assert.equal((await fetch(base + '/tizenbrew-ui/dist/..%5creceiver.json')).status, 403);
	assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test('the desktop UI response does not expose the widget diagnostic credential', async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-brew-ui-'));
	const token = 'private-test-"quoted"-credential';
	fs.writeFileSync(path.join(directory, 'asset.js'), 'const token = ' + JSON.stringify(token) + ';');
	const server = createUiServer(directory, token);
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		fs.rmSync(directory, { recursive: true, force: true });
	});
	const response = await fetch('http://127.0.0.1:' + server.address().port + '/tizenbrew-ui/dist/asset.js');
	const body = await response.text();
	assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
	assert.ok(!body.includes(token));
	assert.ok(body.includes('desktop-preview-token-not-valid-for-tv'));
});
