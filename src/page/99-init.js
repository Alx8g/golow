window.addEventListener('pageshow', place);
window.__scClient = Object.freeze({
  update(value) { Object.assign(settings, value); save(); apply(); },
  openSettings,
  // News from the app: hotkey status, an update, an install finishing.
  event(name, data) { emit('app', name, data); },
  // Hotkeys, the tray, taskbar buttons and the phone remote all arrive here.
  command(name, arg) { if (Object.hasOwn(commands, name)) return commands[name](arg); },
  reply(id, value, error) {
    const pending = calls.get(id);
    if (!pending) return;
    calls.delete(id);
    clearTimeout(pending.timer);
    error ? pending.reject(new Error(error)) : pending.resolve(value);
  },
  diagnostics: () => ({placed: !!host && placed(), settings_built: !!panel, shuffle: managed?.[pos] ?? null, slot: host?.parentElement?.className || null,
    settings: {...settings}, recovery, playing: {...player}, tracks: tracks.size, session: !!session.client}),
});
// Startup milestones for the app's startup.log, measured from process launch. Only the first
// document reports, so later navigations never blur the numbers.
const launched = window.__scApp?.started || 0;
const reached = new Set();
function milestone(name, at = performance.timeOrigin + performance.now()) {
  if (!launched || reached.has(name) || performance.timeOrigin - launched > 20000) return;
  reached.add(name);
  send({call: 'timing', id: 0, args: {name, at: Math.round(at)}});
}
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') milestone('fcp', performance.timeOrigin + entry.startTime);
  }).observe({type: 'paint', buffered: true});
  // The largest paint keeps changing while the page fills in; report where it settled.
  let largest = 0;
  new PerformanceObserver(list => { largest = list.getEntries().at(-1)?.startTime || largest; }).observe({type: 'largest-contentful-paint', buffered: true});
  addEventListener('load', () => setTimeout(() => largest && milestone('lcp', performance.timeOrigin + largest), 3000), {once: true});
} catch {}
on('page', () => {
  if (document.querySelector('.header__right')) milestone('header');
  if (document.querySelector('.playControls__elements')) milestone('player');
  if (document.querySelector('.playableTile, .soundList__item, .badgeList__item, .trackList__item')) milestone('content');
});

function start() {
  place();
  emit('page');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
