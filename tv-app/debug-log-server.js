'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 1000;
const MAX_TEXT = 8000;

function argumentText(arg) {
	if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
		return typeof arg.value === 'string' ? arg.value : String(JSON.stringify(arg.value));
	}
	if (arg.preview && arg.preview.properties) {
		const properties = arg.preview.properties.slice(0, 20).map(property =>
			property.name + ': ' + (property.value === undefined ? property.type : property.value));
		return (arg.description || arg.type) + ' {' + properties.join(', ') +
			(arg.preview.overflow ? ', ...' : '') + '}';
	}
	return arg.unserializableValue || arg.description || arg.type;
}

function createLogServer(options = {}) {
	const history = [];
	const viewers = new Set();
	let sequence = 0;
	let status = 'Waiting for logs uploaded by the TV service';
	const dashboard = fs.readFileSync(path.join(__dirname, 'debug-log-dashboard.html'));

	function broadcast(event, data) {
		const message = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
		for (const viewer of viewers) {
			if (!viewer.write(message)) {
				viewers.delete(viewer);
				viewer.destroy();
			}
		}
	}

	function add(entry) {
		const item = {
			id: ++sequence,
			time: new Date().toISOString(),
			level: String(entry.level || 'log').slice(0, 30),
			text: String(entry.text || '').slice(0, MAX_TEXT),
			url: String(entry.url || '').slice(0, 2000),
		};
		history.push(item);
		if (history.length > MAX_ENTRIES) history.shift();
		broadcast('log', item);
		return item;
	}

	function setStatus(message) {
		if (status === message) return;
		status = message;
		console.log('[Debug logs] ' + status);
		broadcast('status', status);
	}

	const server = http.createServer((req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Content-Security-Policy',
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
		if (req.method === 'POST' && req.url === '/ingest') {
			if (!options.token || req.headers.authorization !== 'Bearer ' + options.token) {
				res.writeHead(401);
				res.end('Invalid upload token');
				req.resume();
				return;
			}
			let size = 0;
			const chunks = [];
			req.on('data', chunk => {
				size += chunk.length;
				if (size <= 262144) chunks.push(chunk);
			});
			req.on('error', error => console.error('[Debug logs] Upload error:', error.message));
			req.on('end', () => {
				if (size > 262144) {
					res.writeHead(413);
					res.end('Upload exceeds 256 KiB');
					return;
				}
				let entries;
				try {
					entries = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				} catch (error) {
					res.writeHead(400);
					res.end('Expected a JSON log array');
					return;
				}
				if (!Array.isArray(entries) || entries.length < 1 || entries.length > 20 ||
					entries.some(entry => !entry || typeof entry.text !== 'string' ||
						typeof entry.level !== 'string' || typeof entry.url !== 'string')) {
					res.writeHead(400);
					res.end('Expected 1-20 entries with string text, level and url');
					return;
				}
				for (const entry of entries) add(entry);
				setStatus('Receiving TV service logs; last batch ' + new Date().toISOString());
				res.writeHead(204);
				res.end();
			});
			return;
		}
		if (req.method !== 'GET') {
			res.writeHead(405, { Allow: 'GET' });
			res.end('Method not allowed');
			return;
		}
		if (req.url === '/') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(dashboard);
		} else if (req.url === '/logs.json') {
			res.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Content-Disposition': 'attachment; filename="tizen-debug-logs.json"',
			});
			server.requestTimeout = 10000;
			res.end(JSON.stringify({ status, logs: history }, null, 2));
		} else if (req.url === '/events') {
			if (viewers.size >= 10) {
				res.writeHead(503);
				res.end('Too many live viewers');
				return;
			}
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
			});
			res.write('event: snapshot\ndata: ' + JSON.stringify({ status, logs: history }) + '\n\n');
			viewers.add(res);
			res.on('close', () => viewers.delete(res));
		} else {
			res.writeHead(404);
			res.end('Not found');
		}
	});
	const heartbeat = setInterval(() => {
		for (const viewer of viewers) {
			if (!viewer.write(': heartbeat\n\n')) {
				viewers.delete(viewer);
				viewer.destroy();
			}
		}
	}, 15000);
	heartbeat.unref();

	function close() {
		clearInterval(heartbeat);
		for (const viewer of viewers) viewer.destroy();
		return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}

	return { server, add, setStatus, close };
}

async function attachDebugger(client, output) {
	let url = '';
	client.on('Runtime.consoleAPICalled', event => {
		const frame = event.stackTrace && event.stackTrace.callFrames && event.stackTrace.callFrames[0];
		output.add({
			level: event.type,
			text: (event.args || []).slice(0, 50).map(argumentText).join(' '),
			url: frame && frame.url || url,
		});
	});
	client.on('Runtime.exceptionThrown', event => {
		const detail = event.exceptionDetails;
		output.add({
			level: 'error',
			text: 'Uncaught: ' + (detail.exception ? argumentText(detail.exception) : detail.text),
			url: detail.url || url,
		});
	});
	client.on('Page.frameNavigated', event => {
		if (!event.frame.parentId) url = event.frame.url;
	});
	await client.Runtime.enable();
	await client.Page.enable();
	const tree = await client.Page.getFrameTree();
	url = tree.frameTree.frame.url;
}

function parseOptions(args) {
	const options = { host: '0.0.0.0', port: 8087 };
	const flags = { '--host': 'host', '--port': 'port', '--config': 'config' };
	for (let i = 0; i < args.length; i += 2) {
		const key = flags[args[i]];
		if (!key || !args[i + 1] || args[i + 1].startsWith('--')) {
			throw new Error('Expected a supported option (--host, --port, --config) followed by a value');
		}
		options[key] = args[i + 1];
	}
	for (const key of ['port']) {
		if (options[key] === undefined) continue;
		options[key] = Number(options[key]);
		if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 65535) {
			throw new Error(key + ' must be an integer between 1 and 65535');
		}
	}
	return options;
}

if (require.main === module) {
	let options;
	try {
		options = parseOptions(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
	if (options) {
		let config;
		try {
			config = JSON.parse(fs.readFileSync(options.config ||
				path.join(__dirname, 'dist', 'tizenbrew', 'debug-logs', 'receiver.json'), 'utf8'));
			if (typeof config.token !== 'string' || config.token.length < 32) {
				throw new Error('Upload token must contain at least 32 characters');
			}
		} catch (error) {
			console.error('[Debug logs] Cannot load receiver config:', error.message,
				'\nRun: python tv-app\\build-debug-tizenbrew.py');
			process.exitCode = 1;
			return;
		}
		const output = createLogServer(config);
		output.server.on('error', error => {
			console.error('[Debug logs] Server error:', error.message);
			process.exitCode = 1;
		});
		output.server.listen(options.port, options.host, () => {
			console.log('Log dashboard: http://192.168.29.126:' + options.port);
			console.log('Listening on ' + options.host + ':' + options.port + '; trusted LAN only. Logs may contain sensitive site data.');
			let closing = false;
			async function shutdown() {
				if (closing) return;
				closing = true;
				try {
					await output.close();
				} catch (error) {
					console.error('[Debug logs] Shutdown error:', error.message);
					process.exitCode = 1;
				}
			}
			process.on('SIGINT', shutdown);
			process.on('SIGTERM', shutdown);
		});
	}
}

module.exports = { createLogServer, attachDebugger, argumentText, parseOptions };
