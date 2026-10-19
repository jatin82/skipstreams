(function () {
	'use strict';

	if (window.top !== window || window.__googleInjectionTestLoaded) return;
	window.__googleInjectionTestLoaded = true;

	console.log('i am injected');
	console.info('[GoogleInjectionTest] ' + location.href);
}());
