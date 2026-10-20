'use strict';

// This runs in TizenBrew's Node service, not in the streaming site's page.
module.exports = function attachLogForwarder(client, moduleInfo, config, record) {
	var http = require('http');
	var loggingEnabled = config.loggingEnabled === true;
	var queue = [];
	var pending = false;
	var closed = false;
	var dropped = 0;
	var lastFailure = 0;
	var activeRequest;
	var timer;
	var url = moduleInfo.appPath || '';
	var disconnected = false;
	var disconnectTimer;
	var attempt = 0;
	var lastAttempt = null;
	var lastSuccess = null;
	var lastError = null;
	var returningHome = false;
	var homeUrl = 'file:///tizenbrew-ui/dist/index.html';
	function isGoogleTest() {
		return /^gh\/jatin82\/skipstreams(?:@[^/]+)?\/google-test$/.test(moduleInfo.fullName || '');
	}
	function observe(level, text) {
		if (loggingEnabled && record) record({ level: level, text: text, url: 'transport://' + (moduleInfo.fullName || 'TizenBrew') });
	}
	function functionalError(message) {
		if (loggingEnabled) enqueue('error', message);
		else console.error('[TizenBrew] ' + message);
	}
	function failureText(error) {
		if (error === null || error === undefined) return String(error);
		if (typeof error === 'object') {
			if (error.stack) return String(error.stack);
			try {
				return JSON.stringify(error);
			} catch (serializationError) {
				return '[Unserializable thrown value: ' + String(serializationError) + ']';
			}
		}
		return String(error);
	}

	function format(arg) {
		if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
			return typeof arg.value === 'string' ? arg.value : String(JSON.stringify(arg.value));
		}
		if (arg.preview && arg.preview.properties) {
			return (arg.description || arg.type) + ' {' + arg.preview.properties.slice(0, 20).map(function (p) {
				return p.name + ': ' + (p.value === undefined ? p.type : p.value);
			}).join(', ') + (arg.preview.overflow ? ', ...' : '') + '}';
		}
		return arg.unserializableValue || arg.description || arg.type;
	}

	function enqueue(level, text, source) {
		if (!loggingEnabled || closed) return;
		if (queue.length >= 200) {
			queue.shift();
			dropped++;
		}
		var entry = { level: String(level).slice(0, 30), text: String(text).slice(0, 8000),
			url: String(source || moduleInfo.appPath || url).slice(0, 2000) };
		if (record) record(entry);
		queue.push(entry);
	}

	function flush() {
		if (!loggingEnabled || closed || pending || !queue.length) return;
		if (dropped) {
			observe('warning', 'Upload queue overflow; dropped=' + dropped);
			console.error('[TV debug logs] Dropped ' + dropped + ' events: upload queue full');
			dropped = 0;
		}
		var batch = queue.splice(0, 20);
		var data = JSON.stringify(batch);
		while (Buffer.byteLength(data) > 240000 && batch.length > 1) {
			queue.unshift(batch.pop());
			data = JSON.stringify(batch);
		}
		pending = true;
		attempt++;
		lastAttempt = Date.now();
		observe('debug', 'Upload started; attempt=' + attempt + '; events=' + batch.length +
			'; bytes=' + Buffer.byteLength(data) + '; queued=' + queue.length);
		var finished = false;
		function finish(error) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			pending = false;
			activeRequest = null;
			lastError = error ? failureText(error) : null;
			if (!error) lastSuccess = Date.now();
			observe(error ? 'error' : 'debug', 'Upload ' + (error ? 'failed: ' + lastError : 'completed; HTTP 204') +
				'; attempt=' + attempt + '; elapsedMs=' + (Date.now() - lastAttempt));
			if (disconnected && !queue.length && !error) stop();
			if (error && !closed) {
				queue = batch.concat(queue);
				if (queue.length > 200) {
					dropped += queue.length - 200;
					queue = queue.slice(-200);
				}
				if (Date.now() - lastFailure > 30000) {
					console.error('[TV debug logs] Upload failed; retrying: ' + error.message);
					lastFailure = Date.now();
				}
			}
		}
		var request;
		try {
			request = http.request({
				hostname: config.host, port: config.port, path: '/ingest', method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token,
					'Content-Length': Buffer.byteLength(data) },
			}, function (response) {
				observe('debug', 'Upload response headers; HTTP ' + response.statusCode);
				response.resume();
				response.on('error', finish);
				response.on('end', function () {
					finish(response.statusCode === 204 ? null : new Error('HTTP ' + response.statusCode));
				});
			});
		} catch (error) {
			finish(error);
			throw error;
		}
		activeRequest = request;
		request.on('socket', function (socket) {
			observe('debug', 'Upload socket assigned; connecting=' + socket.connecting);
			if (socket.connecting) socket.once('connect', function () {
				observe('debug', 'Upload TCP connected; attempt=' + attempt);
			});
		});
		timer = setTimeout(function () {
			finish(new Error('Upload timeout'));
			request.destroy();
		}, 5000);
		request.on('error', finish);
		try {
			request.end(data);
		} catch (error) {
			finish(error);
			request.destroy();
			throw error;
		}
	}

	var backBinding = null;
	if (typeof client.send === 'function' && client.Page && client.Runtime) {
		backBinding = Promise.resolve().then(function () {
			return client.send('Runtime.addBinding', { name: '__tizenBrewGoogleBack' });
		}).then(function () {
			return true;
		}, function (error) {
			functionalError('Google Back binding unavailable: ' + failureText(error));
			return false;
		});
		client.on('Runtime.bindingCalled', function (event) {
			if (closed || returningHome || event.name !== '__tizenBrewGoogleBack' || event.payload !== 'home' || !isGoogleTest()) return;
			returningHome = true;
			var previous = {};
			Object.keys(moduleInfo).forEach(function (key) { previous[key] = moduleInfo[key]; });
			enqueue('info', '[TV debug logs] Google Back requested; closing active module and returning to TizenBrew Home');
			['fullName', 'name', 'appPath', 'moduleType', 'packageType', 'serviceFile', 'mainFile', 'tizenAppId'].forEach(function (key) {
				moduleInfo[key] = '';
			});
			moduleInfo.evaluateScriptOnDocumentStart = false;
			Promise.resolve().then(function () {
				return client.Page.navigate({ url: homeUrl });
			}).then(function (response) {
				if (response && response.errorText) throw new Error(response.errorText);
				returningHome = false;
				enqueue('info', '[TV debug logs] Google module closed; TizenBrew Home navigation accepted', homeUrl);
			}).catch(function (error) {
				if (!moduleInfo.name) Object.keys(previous).forEach(function (key) { moduleInfo[key] = previous[key]; });
				returningHome = false;
				functionalError('Returning to TizenBrew Home failed: ' + failureText(error));
			});
		});
	}

	client.on('Runtime.consoleAPICalled', function (event) {
		if (!loggingEnabled) return;
		var frame = event.stackTrace && event.stackTrace.callFrames && event.stackTrace.callFrames[0];
		enqueue(event.type, (event.args || []).slice(0, 50).map(format).join(' '), frame && frame.url);
	});
	client.on('Runtime.exceptionThrown', function (event) {
		if (!loggingEnabled) return;
		var detail = event.exceptionDetails;
		enqueue('error', 'Uncaught: ' + (detail.exception ? format(detail.exception) : detail.text), detail.url);
	});
	client.on('Runtime.executionContextCreated', function (event) {
		enqueue('info', '[TV debug logs] Execution context ' + event.context.id +
			'; module=' + (moduleInfo.fullName || '(none)') +
			'; origin=' + (event.context.origin || '(unknown)'), event.context.origin);
		if (!moduleInfo.name) enqueue('info', '[TV debug logs] Injection skipped: no module selected');
		if (client.__tvDebugPort && event.context.origin === 'file://' && client.Runtime) {
			Promise.resolve().then(function () {
				return client.Runtime.evaluate({
					contextId: event.context.id,
					expression: 'if (window === window.top && location.pathname.indexOf("/tizenbrew-ui/dist/") === 0) ' +
						'window.__tizenBrewDebugPort = ' + Number(client.__tvDebugPort) + ';',
				});
			}).catch(function (error) {
				functionalError('Publishing UI recovery endpoint failed: ' + failureText(error));
			});
		}
		if (isGoogleTest() && backBinding && event.context.origin !== 'file://') {
			backBinding.then(function (ready) {
				if (!ready || closed) return;
				return client.Runtime.evaluate({
					contextId: event.context.id,
					expression: '(function(){if(window!==window.top||window.__googleTestBackInstalled)return;' +
						'window.__googleTestBackInstalled=true;window.addEventListener("keydown",function(event){' +
						'if(event.keyCode===10009||event.key==="BrowserBack"){event.preventDefault();' +
						'event.stopImmediatePropagation();window.__tizenBrewGoogleBack("home");}},true);})()',
				});
			}).catch(function (error) {
				functionalError('Installing Google Back handler failed: ' + failureText(error));
			});
		}
	});
	client.on('Runtime.executionContextDestroyed', function (event) {
		enqueue('info', '[TV debug logs] Execution context destroyed: ' + event.executionContextId);
	});
	client.on('Runtime.executionContextsCleared', function () {
		enqueue('info', '[TV debug logs] Execution contexts cleared');
	});
	client.on('Inspector.targetCrashed', function () {
		enqueue('error', '[TV debug logs] Page target crashed');
	});
	client.on('Page.frameNavigated', function (event) {
		if (event.frame.parentId) return;
		url = event.frame.url;
		enqueue('info', '[TV debug logs] Navigated to ' + url, url);
	});
	function monitorEvaluation(methods, name) {
		if (!loggingEnabled) return;
		if (!methods || typeof methods[name] !== 'function') return;
		var original = methods[name];
		methods[name] = function () {
			var params = arguments[0] || {};
			enqueue('info', '[TV debug logs] ' + name + ' requested; module=' +
				(moduleInfo.fullName || '(none)') + '; context=' + (params.contextId || 'default') +
				'; script characters=' + String(params.expression || params.source || '').length);
			var result;
			try {
				result = original.apply(this, arguments);
			} catch (error) {
				enqueue('error', '[TV debug logs] ' + name + ' threw: ' + failureText(error));
				throw error;
			}
			if (result && typeof result.then === 'function') {
				result.then(function (response) {
					enqueue(response && response.exceptionDetails ? 'error' : 'info',
						'[TV debug logs] ' + name + (response && response.exceptionDetails ?
							' exception: ' + JSON.stringify(response.exceptionDetails) : ' completed'));
				}, function (error) {
					enqueue('error', '[TV debug logs] ' + name + ' failed: ' + failureText(error));
				});
			}
			return result;
		};
	}
	monitorEvaluation(client.Runtime, 'evaluate');
	monitorEvaluation(client.Page, 'addScriptToEvaluateOnNewDocument');
	monitorEvaluation(client.Runtime, 'enable');
	monitorEvaluation(client.Debugger, 'enable');
	client.__tvDebugCacheGet = function (cache, key) {
		var value = cache.get(key);
		enqueue('info', '[TV debug logs] Script cache ' + (value ? 'hit' : 'miss') + '; module=' + key);
		return value;
	};
	client.__tvDebugCacheSet = function (cache, key, value) {
		enqueue('info', '[TV debug logs] Script cached; module=' + key + '; characters=' + String(value).length);
		return cache.set(key, value);
	};
	client.__tvDebugFetch = function (fetch, address) {
		if (!loggingEnabled) return fetch(address);
		enqueue('info', '[TV debug logs] Script download requested; module=' +
			(moduleInfo.fullName || '(none)') + '; URL=' + address);
		var request;
		try {
			request = fetch(address);
		} catch (error) {
			enqueue('error', '[TV debug logs] Script download threw: ' + failureText(error));
			throw error;
		}
		return request.then(function (response) {
			enqueue(response.ok === false ? 'error' : 'info',
				'[TV debug logs] Script download response; HTTP ' + response.status + '; URL=' + address);
			var originalText = response.text;
			response.text = function () {
				enqueue('info', '[TV debug logs] Reading script response body');
				var body;
				try {
					body = originalText.apply(this, arguments);
				} catch (error) {
					enqueue('error', '[TV debug logs] Script body read threw: ' + failureText(error));
					throw error;
				}
				return body.then(function (text) {
					enqueue('info', '[TV debug logs] Script body read; characters=' + text.length);
					return text;
				}, function (error) {
					enqueue('error', '[TV debug logs] Script body read failed: ' + failureText(error));
					throw error;
				});
			};
			return response;
		}, function (error) {
			enqueue('error', '[TV debug logs] Script download failed: ' + failureText(error));
			throw error;
		});
	};
	var interval = loggingEnabled ? setInterval(flush, 1000) : null;
	if (interval && interval.unref) interval.unref();
	function stop() {
		if (closed) return;
		observe('info', 'Forwarder stopping; queued=' + queue.length + '; pending=' + pending);
		closed = true;
		clearInterval(interval);
		clearTimeout(timer);
		clearTimeout(disconnectTimer);
		if (activeRequest) activeRequest.destroy();
		if (queue.length) console.error('[TV debug logs] Debugger closed; discarding ' + queue.length + ' queued events');
	}
	client.on('disconnect', function () {
		disconnected = true;
		if (!loggingEnabled) { stop(); return; }
		enqueue('warning', '[TV debug logs] Page debugger disconnected; module=' +
			(moduleInfo.fullName || '(none)'), url);
		flush();
		disconnectTimer = setTimeout(stop, 10000);
		if (disconnectTimer.unref) disconnectTimer.unref();
	});
	if (loggingEnabled && client.Page && typeof client.Page.enable === 'function') {
		client.Page.enable().then(function () {
			enqueue('info', '[TV debug logs] Page navigation diagnostics enabled');
		}, function (error) {
			enqueue('error', '[TV debug logs] Page diagnostics failed: ' + error.message);
		});
	}
	enqueue('info', '[TV debug logs] Forwarding started for ' + (moduleInfo.fullName || 'TizenBrew'), url);
	return { flush: flush, stop: stop, getStatus: function () {
		return { loggingEnabled: loggingEnabled, queued: queue.length, pending: pending, disconnected: disconnected,
			lastAttempt: lastAttempt, lastSuccess: lastSuccess, lastError: lastError };
	} };
};
