const ENABLE_TEST_CONSOLE_LOGS = false;

if (!ENABLE_TEST_CONSOLE_LOGS) {
	console.log = () => {};
	console.info = () => {};
	console.warn = () => {};
	console.error = () => {};
	console.debug = () => {};
}
