'use strict';

/*
 * PC companion: launches a TV app in debug mode over sdb and injects ../userScript.js
 * into the website through the Chrome DevTools Protocol. Keep it running while watching.
 *
 *   npm run watch                              Prime Video
 *   node companion.js hotstar [url]            JioHotstar, optionally opening a page (logs in first if needed)
 *                                              Without a url it asks for the movie name and number.
 *   TV_IP=192.168.29.51 npm run watch
 *
 * Env: TV_IP, SDB (path to sdb), APP_ID (overrides the app id)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const CDP = require('chrome-remote-interface');

const APPS = {
	prime: 'PrimeTzn01.PrimeTizen',
	hotstar: 'HotstarT01.JioHotstar',
};
const APP_NAME = process.argv[2] && APPS[process.argv[2]] ? process.argv[2] : 'prime';
let TARGET_URL = resolveTarget(process.argv.slice(2).filter((a) => !APPS[a])[0] || '');
const APP_ID = process.env.APP_ID || APPS[APP_NAME];
const SDB = process.env.SDB || 'sdb';
const USER_SCRIPT_PATH = path.join(__dirname, '..', 'userScript.js');
const SDB_PORT = 26101;

// Hotstar shorthand: "<moviename>/<number>" -> https://www.hotstar.com/in/movies/<moviename>/<number>/watch
function resolveTarget(arg) {
	if (!arg || /^https?:\/\//i.test(arg)) return arg;
	const m = APP_NAME === 'hotstar' && /^\/?([^/\s]+)\/(\d+)\/?$/.exec(arg);
	if (!m) {
		console.error('Unrecognised URL "' + arg + '". Use a full https:// URL' +
			(APP_NAME === 'hotstar' ? ' or <moviename>/<number>.' : '.'));
		process.exit(1);
	}
	return 'https://www.hotstar.com/in/movies/' + m[1] + '/' + m[2] + '/watch';
}

// Hotstar without a movie argument: ask for the movie name and number in the terminal.
async function askForMovie() {
	if (!process.stdin.isTTY) return '';
	const readline = require('readline');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
	try {
		console.log('Movie URL: https://www.hotstar.com/in/movies/<movie_name>/<movie_number>/watch');
		for (;;) {
			const name = (await ask('Movie name (e.g. superman, Enter for the home page): '))
				.toLowerCase().replace(/\s+/g, '-');
			if (!name) return '';
			if (/^https?:\/\//i.test(name)) return name;
			const number = await ask('Movie number (e.g. 1271509950): ');
			if (/^[a-z0-9-]+$/.test(name) && /^\d+$/.test(number)) {
				return 'https://www.hotstar.com/in/movies/' + name + '/' + number + '/watch';
			}
			console.log('The name may only contain letters, digits and dashes, and the number only digits. Try again.');
		}
	} finally {
		rl.close();
	}
}

function log() {
	const args = Array.prototype.slice.call(arguments);
	console.log.apply(console, ['[' + new Date().toLocaleTimeString() + ']'].concat(args));
}

function sdb(args, opts) {
	return execFileSync(SDB, args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opts));
}

function sdbOn(serial, args, opts) {
	return sdb(['-s', serial].concat(args), opts);
}

function resolveSerial() {
	if (process.env.TV_IP) {
		const serial = process.env.TV_IP.indexOf(':') === -1 ? process.env.TV_IP + ':' + SDB_PORT : process.env.TV_IP;
		log('Connecting to', serial);
		log(sdb(['connect', serial]).trim());
		return serial;
	}
	const line = sdb(['devices']).split(/\r?\n/).find((l) => /\tdevice\b|\s+device\s+/.test(l));
	if (!line) throw new Error('No TV connected. Run `sdb connect <TV-IP>` or set TV_IP.');
	return line.trim().split(/\s+/)[0];
}

function launchInDebug(serial) {
	try { sdbOn(serial, ['shell', '0', 'was_kill', APP_ID]); } catch (e) { /* not running */ }
	const out = sdbOn(serial, ['shell', '0', 'debug', APP_ID], { timeout: 60000 });
	const match = /port:\s*(\d+)/.exec(out);
	if (!match) throw new Error('Debug launch failed:\n' + out);
	return Number(match[1]);
}

function shouldInject(context) {
	const aux = context.auxData || {};
	if (aux.isDefault === false) return false;
	return /^https?:\/\//i.test(context.origin || '');
}

async function main() {
	if (APP_NAME === 'hotstar' && !TARGET_URL) TARGET_URL = await askForMovie();

	const serial = resolveSerial();
	log('TV:', serial);

	const port = launchInDebug(serial);
	log('App launched in debug mode, port', port);
	sdbOn(serial, ['forward', 'tcp:' + port, 'tcp:' + port]);

	const client = await CDP({ host: '127.0.0.1', port, local: true });
	log('Debugger attached');

	client.on('Runtime.executionContextCreated', ({ context }) => {
		if (!shouldInject(context)) return;
		// Re-read every time so script edits apply without reinstalling the app.
		const script = 'window.__ptTargetUrl = ' + JSON.stringify(TARGET_URL) + ';\n' +
			fs.readFileSync(USER_SCRIPT_PATH, 'utf8');
		client.Runtime.evaluate({ expression: script, contextId: context.id })
			.then(() => log('Injected script into', context.origin))
			.catch((e) => log('Inject failed:', e.message));
	});

	client.on('Runtime.consoleAPICalled', ({ args }) => {
		const text = args.map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
		if (text.indexOf('[PrimeTizen]') !== -1 || text.indexOf('[PrimeAdsSkip]') !== -1) log('TV:', text);
		if (text.indexOf('[PrimeTizen] Exit requested') !== -1 && !closed) {
			// Back on the remote: the page can't exit the app itself, so close it from here.
			log('Closing app on TV');
			try { sdbOn(serial, ['shell', '0', 'was_kill', APP_ID]); } catch (e) { /* already closed */ }
		}
	});

	let closed = false;
	const done = new Promise((resolve) => client.on('disconnect', () => { closed = true; resolve(); }));

	await client.Runtime.enable();
	if (client.Runtime.runIfWaitingForDebugger) await client.Runtime.runIfWaitingForDebugger().catch(() => {});

	// Tell the launcher page the companion is attached; it then opens TARGET_URL (or the site's home page).
	// If Hotstar isn't logged in, the script sends it to the login page and returns to TARGET_URL afterwards.
	const startArgs = 'true, ' + JSON.stringify(TARGET_URL || undefined);
	await client.Runtime.evaluate({
		expression: 'window.primeTizenStart ? (window.primeTizenStart(' + startArgs + '), "ok") : ' +
			'(window.__primeTizenCompanion = true, window.__primeTizenUrl = ' + JSON.stringify(TARGET_URL) + ', "flag")',
	});
	log('Opening', APP_NAME, TARGET_URL ? '-> ' + TARGET_URL : '', 'on TV. Keep this running while watching (Ctrl+C to stop).');

	process.on('SIGINT', () => { client.close().finally(() => process.exit(0)); });
	await done;
	log('App closed on TV.');
	try { sdbOn(serial, ['forward', '--remove', 'tcp:' + port]); } catch (e) { /* ignore */ }
}

main().catch((e) => {
	console.error('Error:', e.message);
	process.exit(1);
});
