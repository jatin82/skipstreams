'use strict';

/*
 * Signs and packages a Tizen widget.
 *   node build.js                        -> dist/PrimeVideoAdSkip.wgt
 *   node build.js --app hotstar          -> dist/JioHotstarTV.wgt
 *   node build.js [--app hotstar] --install  -> also installs on the connected TV
 *
 * Env:
 *   TIZEN_CLI      path to tizen(.bat) (default: "tizen" on PATH)
 *   TIZEN_PROFILE  certificate profile name (default: the active profile)
 *   TV_IP          install target, e.g. 192.168.29.51 (default: the only connected device)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APPS = {
	prime: { widget: 'widget', wgt: 'PrimeVideoAdSkip.wgt' },
	hotstar: { widget: 'widget-hotstar', wgt: 'JioHotstarTV.wgt' },
};
const appArg = process.argv.indexOf('--app');
const APP_NAME = appArg !== -1 ? process.argv[appArg + 1] : 'prime';
if (!APPS[APP_NAME]) throw new Error('Unknown app "' + APP_NAME + '". Use: ' + Object.keys(APPS).join(', '));

const ROOT = __dirname;
const WIDGET = path.join(ROOT, APPS[APP_NAME].widget);
const DIST = path.join(ROOT, 'dist', APP_NAME);
const WGT_NAME = APPS[APP_NAME].wgt;

function tizenCli() {
	if (process.env.TIZEN_CLI) return process.env.TIZEN_CLI;
	return process.platform === 'win32' ? 'tizen.bat' : 'tizen';
}

function run(cmd, cmdArgs) {
	console.log('>', cmd, cmdArgs.join(' '));
	const isWinBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
	execFileSync(isWinBatch ? 'cmd.exe' : cmd, isWinBatch ? ['/c', cmd].concat(cmdArgs) : cmdArgs,
		{ stdio: 'inherit', cwd: ROOT });
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const pkgArgs = ['package', '-t', 'wgt', '-o', DIST];
if (process.env.TIZEN_PROFILE) pkgArgs.push('-s', process.env.TIZEN_PROFILE);
run(tizenCli(), pkgArgs.concat(['--', WIDGET]));

const built = fs.readdirSync(DIST).find((f) => f.endsWith('.wgt'));
if (!built) throw new Error('Packaging produced no .wgt');
if (built !== WGT_NAME) fs.renameSync(path.join(DIST, built), path.join(DIST, WGT_NAME));
console.log('Packaged:', path.join(DIST, WGT_NAME));

if (process.argv.includes('--install')) {
	const installArgs = ['install', '-n', WGT_NAME];
	if (process.env.TV_IP) {
		installArgs.push('-s', process.env.TV_IP.indexOf(':') === -1 ? process.env.TV_IP + ':26101' : process.env.TV_IP);
	}
	run(tizenCli(), installArgs.concat(['--', DIST]));
}
