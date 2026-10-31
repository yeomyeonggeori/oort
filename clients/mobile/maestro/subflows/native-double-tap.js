// Host-native input, via the opt-in loopback photo fixture (no app/test-mode gesture bypass).
// Foreground the dedicated Simulator and set PHOTO_NATIVE_TAP_X/Y when starting photo-stub.mjs.
// Maestro supplies PHOTO_STUB_PORT; no separate XCTest request is made between taps.
var response = http.post('http://127.0.0.1:' + PHOTO_STUB_PORT + '/test/native-double-tap');
if (response.status !== 200) {
  throw new Error('Native double tap unavailable: check photo-stub, PHOTO_NATIVE_TAP_X/Y and cliclick');
}
