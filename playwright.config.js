const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const { browserChannel } = require('./local-tizenbrew');

module.exports = defineConfig({
	testDir: path.join(__dirname, 'tests', 'local'),
	outputDir: path.join(__dirname, 'test-results', 'local'),
	timeout: 20000,
	workers: 1,
	reporter: [['list'], ['html', { open: 'never' }]],
	use: {
		browserName: 'chromium',
		channel: browserChannel(),
		viewport: { width: 1920, height: 1080 },
		serviceWorkers: 'block',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
});
