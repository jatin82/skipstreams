'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

async function readDiagnostics(port, token) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local forwarding port');
	if (typeof token !== 'string' || token.length < 32) throw new Error('Invalid diagnostic token');
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);
	try {
		const response = await fetch('http://127.0.0.1:' + port + '/__tv_debug/logs', {
			headers: { Authorization: 'Bearer ' + token }, signal: controller.signal, redirect: 'error',
		});
		if (response.status !== 200) throw new Error('TV diagnostic retrieval failed: HTTP ' + response.status);
		if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
			throw new Error('TV did not return diagnostic records; verify that the newest build is installed');
		}
		const chunks = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > 524288) throw new Error('TV diagnostic response exceeds 512 KiB');
			chunks.push(chunk);
		}
		if (!size) throw new Error('TV returned an empty diagnostic log');
		return Buffer.concat(chunks);
	} finally {
		clearTimeout(timeout);
		controller.abort();
	}
}

async function main() {
	const { values } = parseArgs({ options: {
		port: { type: 'string', default: '18081' },
		config: { type: 'string', default: path.join(__dirname, 'dist', 'tizenbrew', 'debug-logs', 'receiver.json') },
		output: { type: 'string', default: path.join(__dirname, 'dist', 'tizenbrew', 'debug-logs',
			'tv-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl') },
	} });
	const config = JSON.parse(fs.readFileSync(values.config, 'utf8'));
	const contents = await readDiagnostics(Number(values.port), config.token);
	fs.writeFileSync(values.output, contents, { flag: 'wx', mode: 0o600 });
	console.log('Saved ' + contents.length + ' bytes to ' + path.resolve(values.output));
}

if (require.main === module) {
	main().catch(error => {
		console.error('[TV diagnostics] ' + error.message);
		process.exitCode = 1;
	});
}

module.exports = { readDiagnostics };
