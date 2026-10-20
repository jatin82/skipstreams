'use strict';

module.exports = function startServiceDiagnostics(config, attachForwarder, runtime) {
	var loggingEnabled = config.loggingEnabled === true;
	var EventEmitter = require('events').EventEmitter;
	var fs = runtime && runtime.fs || require('fs');
	var logPath = runtime && runtime.logPath || '/home/owner/share/tizenbrew-diagnostics.jsonl';
	var maxFileBytes = 262144;
	var emitter = new EventEmitter();
	var localConsole = runtime ? runtime.console : console;
	var localProcess = runtime ? runtime.process : process;
	var originals = {};
	var stopped = false;
	var state = function () { return { phase: 'starting' }; };
	var session = String(localProcess.pid) + '-' + Date.now();
	var originalError = localConsole.error;
	var lastDiskError = null;
	var lastDiskErrorTime = 0;
	var lastHeartbeat = Date.now();
	var recent = [];
	var sequence = 0;
	var restartTimer;
	function redact(value, limit) {
		var result = String(value);
		if (config.token) result = result.split(config.token).join('[redacted]');
		return result.slice(0, limit);
	}
	function record(entry) {
		if (!loggingEnabled || stopped) return;
		var item = {
			id: ++sequence,
			time: new Date().toISOString(), session: session, uptimeMs: Math.floor(localProcess.uptime() * 1000),
			level: redact(entry.level, 30), text: redact(entry.text, 8000), url: redact(entry.url || '', 2000),
		};
		recent.push(item);
		if (recent.length > 200) recent.shift();
		var line = JSON.stringify(item) + '\n';
		try {
			var size = 0;
			try {
				size = fs.statSync(logPath).size;
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
			if (size + Buffer.byteLength(line) > maxFileBytes) {
				// POSIX rename atomically replaces the older generation on the TV.
				fs.renameSync(logPath, logPath + '.1');
			}
			fs.appendFileSync(logPath, line, { encoding: 'utf8', mode: 384 });
			if (lastDiskError) originalError.call(localConsole, '[TV debug logs] Local diagnostic writes recovered');
			lastDiskError = null;
		} catch (error) {
			lastDiskError = redact(text(error), 2000);
			if (!lastDiskErrorTime || Date.now() - lastDiskErrorTime >= 30000) {
				originalError.call(localConsole, '[TV debug logs] Local diagnostic write failed: ' + lastDiskError);
				lastDiskErrorTime = Date.now();
			}
		}
	}
	function readLog() {
		var contents = [logPath + '.1', logPath].map(function (filename) {
			try {
				if (fs.statSync(filename).size > maxFileBytes) throw new Error('Diagnostic file exceeds size limit');
				return fs.readFileSync(filename, 'utf8');
			} catch (error) {
				if (error.code === 'ENOENT') return '';
				throw error;
			}
		}).join('');
		if (!contents) throw new Error('No persistent diagnostic records are available');
		return contents;
	}
	function handleRequest(req, res) {
		var address = require('url').parse(req.url, true);
		if (['/__tv_debug/logs', '/__tv_debug/live', '/__tv_debug/restart'].indexOf(address.pathname) === -1) return false;
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		if (req.headers.origin) {
			if (req.headers.origin !== 'null') {
				res.writeHead(403);
				res.end('Diagnostic controls are restricted to the local TV application');
				return true;
			}
			res.setHeader('Access-Control-Allow-Origin', 'null');
			res.setHeader('Vary', 'Origin');
		}
		var method = address.pathname === '/__tv_debug/restart' ? 'POST' : 'GET';
		if (req.method === 'OPTIONS') {
			res.writeHead(204, { 'Access-Control-Allow-Methods': method,
				'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '60' });
			res.end();
			return true;
		}
		if (!config.token || req.headers.authorization !== 'Bearer ' + config.token) {
			res.writeHead(401);
			res.end('Invalid diagnostic token');
		} else if (req.method !== method) {
			res.writeHead(405, { Allow: method });
			res.end('Method not allowed');
		} else if (address.pathname === '/__tv_debug/restart') {
			if (restartTimer) {
				res.writeHead(409);
				res.end('A service restart is already pending');
				return true;
			}
			report('warning', 'Manual service restart requested from diagnostics UI');
			res.writeHead(202, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ session: session, restarting: true }));
			restartTimer = setTimeout(function () { localProcess.exit(0); }, 250);
		} else if (address.pathname === '/__tv_debug/live') {
			var after = address.query.after || '0';
			if (!/^\d{1,15}$/.test(after)) {
				res.writeHead(400);
				res.end('Invalid diagnostic cursor');
				return true;
			}
			after = Number(after);
			if (address.query.session !== session) after = Math.max(0, sequence - 40);
			var entries = recent.filter(function (entry) { return entry.id > after; }).slice(0, 40);
			while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) > 240000) entries.pop();
			var currentState;
			try {
				currentState = state();
			} catch (error) {
				report('error', 'Diagnostic state inspection failed: ' + text(error));
				res.writeHead(503);
				res.end('Service state inspection failed');
				return true;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ session: session, pid: localProcess.pid, loggingEnabled: loggingEnabled,
				uptime: Math.floor(localProcess.uptime()), time: new Date().toISOString(),
				state: currentState, localWriteError: lastDiskError,
				entries: entries, cursor: entries.length ? entries[entries.length - 1].id : after,
				dropped: entries.length ? Math.max(0, entries[0].id - after - 1) : 0 }));
		} else {
			var contents;
			try {
				contents = readLog();
			} catch (error) {
				report('error', 'Local diagnostic read failed: ' + text(error));
				res.writeHead(503);
				res.end('Local diagnostic read failed: ' + redact(text(error), 2000));
				return true;
			}
			res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
				'Content-Disposition': 'attachment; filename="tizenbrew-diagnostics.jsonl"' });
			res.end(contents);
		}
		return true;
	}
	var transport = loggingEnabled ? attachForwarder(emitter, {
		name: 'TizenBrewService', fullName: 'TizenBrewService', appPath: 'service://TizenBrew',
	}, config, record) : null;

	function text(value) {
		if (value === null || value === undefined) return String(value);
		if (typeof value !== 'object') return String(value);
		if (value.stack) return String(value.stack);
		try {
			return JSON.stringify(value);
		} catch (error) {
			return '[Unserializable service value: ' + String(error) + ']';
		}
	}
	function report(level, message) {
		if (!loggingEnabled || stopped) return;
		emitter.emit('Runtime.consoleAPICalled', {
			type: level, args: [{ value: '[TizenBrew service ' + session + '] ' + redact(message, 8000) }],
		});
	}
	['log', 'info', 'debug', 'warn', 'error'].forEach(function (level) {
		if (!loggingEnabled) return;
		var original = localConsole[level];
		if (typeof original !== 'function') return;
		var wrapped = function () {
			var args = Array.prototype.slice.call(arguments);
			// Transport failures must not feed back into their own upload queue.
			if (String(args[0]).indexOf('[TV debug logs]') !== 0) {
				report(level, args.map(text).join(' '));
			}
			return original.apply(localConsole, args);
		};
		originals[level] = { original: original, wrapped: wrapped };
		localConsole[level] = wrapped;
	});
	function heartbeat() {
		try {
			var elapsed = Date.now() - lastHeartbeat;
			lastHeartbeat = Date.now();
			report('info', 'Heartbeat; uptime=' + Math.floor(localProcess.uptime()) +
				's; elapsedMs=' + elapsed + '; state=' + text(state()) +
				'; upload=' + text(transport.getStatus()) + '; localWriteError=' + text(lastDiskError));
		} catch (error) {
			report('error', 'Heartbeat state inspection failed: ' + text(error));
		}
	}
	function uncaught(error, origin) {
		report('error', 'Uncaught exception observed (' + origin + '): ' + text(error));
		transport.flush();
	}
	function beforeExit(code) {
		record({ level: 'info', text: 'Process beforeExit; code=' + code, url: 'service://TizenBrew' });
	}
	function exit(code) {
		// Exit handlers cannot complete an asynchronous upload.
		record({ level: 'info', text: 'Process exit; code=' + code, url: 'service://TizenBrew' });
	}
	// Unlike uncaughtException, this event does not suppress Node's fatal-error handling.
	var interval;
	if (loggingEnabled) {
		localProcess.on('uncaughtExceptionMonitor', uncaught);
		localProcess.on('beforeExit', beforeExit);
		localProcess.on('exit', exit);
		interval = setInterval(heartbeat, runtime && runtime.heartbeatMs || 10000);
		if (interval.unref) interval.unref();
		report('info', 'Service diagnostics started; Node=' + localProcess.version + '; localLog=' + logPath +
			'; maxFileBytes=' + maxFileBytes + '; generations=2');
		heartbeat();
		transport.flush();
	}
	return {
		report: report,
		record: record,
		handleRequest: handleRequest,
		observeSocket: function (socket) {
			if (!loggingEnabled) return;
			report('info', 'UI socket opened');
			socket.on('close', function (code) { report('info', 'UI socket closed; code=' + code); });
			socket.on('error', function (error) {
				report('error', 'UI socket error: ' + text(error));
				// Observing an otherwise unhandled EventEmitter error must not swallow it.
				if (socket.listenerCount('error') === 1) throw error;
			});
		},
		bindState: function (getter) { state = getter; },
		stop: function () {
			if (stopped) return;
			report('info', 'Service diagnostics stopping');
			stopped = true;
			clearInterval(interval);
			clearTimeout(restartTimer);
			localProcess.removeListener('uncaughtExceptionMonitor', uncaught);
			localProcess.removeListener('beforeExit', beforeExit);
			localProcess.removeListener('exit', exit);
			Object.keys(originals).forEach(function (level) {
				if (localConsole[level] === originals[level].wrapped) localConsole[level] = originals[level].original;
			});
			if (transport) transport.stop();
		},
	};
};
