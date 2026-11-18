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
function start() {
  place();
  emit('page');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
