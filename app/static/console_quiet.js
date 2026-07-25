/**
 * Console verbosity gate.
 *
 * The front end carries ~130 console.log calls from debugging the FireStick
 * sleep problem. On a kiosk that runs for weeks they are retained memory and
 * they bury the messages that matter. Informational levels are therefore muted
 * by default; warnings and errors always get through.
 *
 * Turn them back on from the device's console with:
 *     localStorage.debug = '1'; location.reload();
 */
(() => {
  let enabled = false;
  try {
    enabled = localStorage.getItem('debug') === '1';
  } catch (_) { /* private mode / storage disabled */ }

  if (enabled) return;

  const noop = () => {};
  console.log = noop;
  console.debug = noop;
  console.info = noop;
})();
