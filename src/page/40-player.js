// What is playing, read from SoundCloud's control bar on every change it makes. No polling:
// while a track plays, the bar's clock changes once a second and that drives `tick`.
const player = {path: null, title: '', artist: '', artistPath: null, playing: false, passed: 0, total: 0, chapter: null};
let started = null, wheelBar = null, autoplayBusy = false;
// A trusted click on a play button: GoLow's shuffle and skips leave the user's own picks alone.
let picked = {at: 0, inList: false};

// SoundCloud's player keeps a pool of <audio> elements outside the page. Every play() passes
// through here, so GoLow knows which element is sounding.
const media = {el: null};
const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  adopt(this);
  return nativePlay.apply(this, arguments);
};
function adopt(el) {
  if (media.el === el) return;
  media.el = el;
  // SoundCloud resets the speed to 1 for every new track.
  for (const type of ['loadedmetadata', 'playing', 'ratechange']) el.addEventListener(type, () => applyRate(el));
}
// The element only counts when it holds the track the bar shows.
const live = () => {
  const el = media.el;
  return el && el.readyState > 0 && player.total && Math.abs(el.duration - player.total) < 3 ? el : null;
};
const position = () => live()?.currentTime ?? player.passed;
// SoundCloud's player treats a position change on its element as a seek request and performs it
// properly, to the millisecond. Without an element yet, click the timeline instead.
function seekTo(t) {
  t = Math.max(0, player.total ? Math.min(t, player.total - 1) : t);
  const el = live();
  if (el) el.currentTime = t;
  else seek(player.total ? t / player.total : 0);
}
function seek(fraction) {
  const timeline = document.querySelector('.playbackTimeline__progressWrapper'), box = timeline?.getBoundingClientRect();
  if (!box?.width) return;
  const point = {bubbles: true, clientX: box.left + box.width * fraction, clientY: box.top + box.height / 2};
  for (const type of ['mousedown', 'mouseup', 'click']) timeline.dispatchEvent(new MouseEvent(type, point));
}

function watchPlayer() {
  const link = document.querySelector('.playbackSoundBadge__titleLink'), by = document.querySelector('.playbackSoundBadge__lightLink');
  Object.assign(player, {path: pathOf(link?.getAttribute('href') || '') || null, title: link?.title || '', artist: by?.title || '',
    artistPath: pathOf(by?.getAttribute('href') || '') || null, playing: !!document.querySelector('.playControls__play.playing'),
    passed: seconds('.playbackTimeline__timePassed'), total: seconds('.playbackTimeline__duration')});
  if (player.path === '/') player.path = null;
  if (player.playing && player.path && player.path !== started) {
    started = player.path;
    emit('track', player.path);
  }
  emit('tick');
  report();
  if (!settings.autoplay) document.querySelector('.queueFallback__toggle .sc-toggle-on input')?.click();
}
// Tells the app what is playing: the window title, the tray, Discord and Last.fm. Inside a mix
// with a tracklist, that is the current track of the mix.
let reported;
function report() {
  const chapter = player.playing && player.title ? player.chapter : null;
  const message = !player.playing || !player.title ? {now: null}
    : chapter ? {now: `${chapter.name} · ${player.title}`, artist: chapter.artist, title: chapter.title, seconds: chapter.seconds, album: player.title}
    : {now: `${player.title} – ${player.artist}`, artist: player.artist, title: player.title,
      seconds: Math.round((tracks.get(player.path)?.duration || 0) / 1000) || player.total};
  if (message.now === reported) return;
  reported = message.now;
  send(message);
}
on('track', () => autoplayOff());

// SoundCloud only renders its autoplay switch inside the open queue panel, and turns it
// back on as tracks change. Open the panel invisibly, switch it off, close it again.
async function autoplayOff() {
  const button = document.querySelector('.playbackSoundBadge__showQueue'), queue = document.querySelector('.playControls__queue');
  if (settings.autoplay || autoplayBusy || !button || !queue || document.querySelector('.queueFallback__toggle')) return;
  autoplayBusy = true;
  queue.style.visibility = 'hidden';
  button.click();
  for (let i = 0; i < 30 && !document.querySelector('.queueFallback__toggle'); i++) await wait(50);
  document.querySelector('.queueFallback__toggle .sc-toggle-on input')?.click();
  button.click();
  queue.style.visibility = '';
  autoplayBusy = false;
}

on('page', () => {
  const controls = document.querySelector('.playControls');
  if (!controls || controls === wheelBar) return;
  wheelBar = controls;
  // The wheel over the speaker icon drives SoundCloud's own Shift+arrow volume shortcut.
  // Bound to the bar only, so page scrolling never waits on this listener.
  controls.addEventListener('wheel', event => {
    if (!event.target.closest('.playControls__volume')) return;
    event.preventDefault();
    volume(event.deltaY < 0);
  }, {passive: false});
  new MutationObserver(watchPlayer).observe(controls, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'title', 'href']});
  watchPlayer();
});
const volume = up => document.dispatchEvent(new KeyboardEvent('keydown', {key: up ? 'ArrowUp' : 'ArrowDown', keyCode: up ? 38 : 40, shiftKey: true, bubbles: true}));

// --- Playback speed, kept per track, with pitch preserved ---
const speeds = stored('speeds', {});
const rateFor = path => speeds[path] ?? pref('speed');
function applyRate(el = media.el) {
  if (!el) return;
  const want = player.path ? rateFor(player.path) : 1;
  if (el.playbackRate !== want) el.playbackRate = want;
  el.preservesPitch = true;
  const button = barButton('speed');
  if (button) button.textContent = want === 1 ? '1×' : `${want}×`;
}
function setSpeed(rate, everywhere = false) {
  if (everywhere) { local.speed = rate; store('prefs', local); }
  if (player.path) {
    if (rate === pref('speed')) delete speeds[player.path]; else speeds[player.path] = rate;
    const keys = Object.keys(speeds);
    for (const key of keys.slice(0, Math.max(0, keys.length - 300))) delete speeds[key];
    store('speeds', speeds);
  }
  applyRate();
}
menu.push({section: 'Playback', key: 'speed', label: 'Default speed', type: 'select', def: 1,
  options: [[0.75, '0.75×'], [1, '1×'], [1.1, '1.1×'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×']]});

// --- Skipping, by the amounts set in settings ---
menu.push({section: 'Playback', key: 'skip_back', label: 'Skip back', type: 'select', def: 10, options: [[5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s']]},
  {section: 'Playback', key: 'skip_forward', label: 'Skip forward', type: 'select', def: 30, options: [[10, '10 s'], [15, '15 s'], [30, '30 s'], [60, '60 s']]});
const skip = delta => seekTo(position() + delta);

// --- Resume: the last track after a restart, and every long track wherever you stopped ---
const LONG = 600;
const positions = stored('positions', {});
const lastResume = stored('resume', null);
let firstStart = true, savedAt = -1, positionsAt = 0;
menu.push({section: 'Mixes and podcasts', key: 'resume_all', label: 'Resume long tracks where you stopped', def: true,
  hint: 'Tracks of 10 minutes or more remember their position, each on its own.'});
on('track', path => {
  const saved = (pref('resume_all') && positions[path]) || (firstStart && lastResume?.at === path ? lastResume : null);
  firstStart = false;
  if (!saved || player.passed >= 5 || saved.t < 30 || (player.total && saved.t >= player.total - 30)) return;
  seekTo(saved.t);
  toast(`Resumed at ${clock(saved.t)}`, {label: 'Start over', run: () => seekTo(0)});
});
on('tick', () => {
  if (!player.path || !player.playing) return;
  const t = position();
  if (Math.floor(t / 5) !== savedAt) {
    savedAt = Math.floor(t / 5);
    store('resume', {at: player.path, t: Math.floor(t)});
  }
  if (player.total < LONG || (positions[player.path] && Date.now() - positionsAt < 15000)) return;
  positionsAt = Date.now();
  if (t > player.total - 60) delete positions[player.path];
  else positions[player.path] = {t: Math.floor(t), total: player.total, title: player.title, artist: player.artist, at: Date.now()};
  const keys = Object.keys(positions).sort((a, b) => positions[a].at - positions[b].at);
  for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete positions[key];
  store('positions', positions);
  refreshPanel('continue');
});

// Opens a page inside SoundCloud's app and lets it start, pressing play if it does not.
function navigate(path) {
  const link = h('a', {href: path, hidden: true});
  (document.querySelector('#app') || document.body).append(link);
  link.click();
  link.remove();
}
function pressPagePlay() {
  for (const frame of frames()) {
    const button = frame.contentDocument.querySelector('section[aria-label="Track header"] button[aria-label="Play"]');
    if (button) return button.click();
  }
  document.querySelector('.listenHero .sc-button-play, .fullHero .sc-button-play, .soundTitle .sc-button-play')?.click();
}
async function playPath(path) {
  if (player.path === path) { if (!player.playing) commands.toggle(); return; }
  navigate(path);
  for (let i = 0; i < 40 && !(player.path === path && player.playing); i++) {
    await wait(250);
    if (i === 12) pressPagePlay();
  }
}
tabs.push({id: 'continue', label: 'Continue', order: 3, render(body) {
  const list = Object.entries(positions).sort(([, a], [, b]) => b.at - a.at).slice(0, 40);
  body.append(h('h2', {text: 'Continue listening'}));
  if (!list.length) return body.append(h('p', {text: 'Mixes and podcasts you stop part way through show up here.'}));
  body.append(h('ul', {cls: 'list'}, list.map(([path, item]) => h('li', {},
    h('div', {cls: 'grow'},
      h('div', {cls: 'clip', text: item.title}), h('div', {cls: 'clip dim', text: `${item.artist} · ${clock(item.total - item.t)} left`}),
      h('div', {cls: 'bar'}, h('i', {style: `width:${Math.round(item.t / item.total * 100)}%`}))),
    h('button', {cls: 'btn', type: 'button', text: 'Resume', onclick: () => playPath(path)}),
    iconButton('close', 'Remove from the list', () => { delete positions[path]; store('positions', positions); refreshPanel('continue'); })))));
}});

// --- Sleep timer: fades out, pauses, and puts the volume back ---
const FADE = 20000;
let sleep = null;
function setSleep(minutes) {
  clearTimeout(sleep?.timer);
  const ms = minutes * 60000, fade = Math.min(FADE, ms);
  sleep = !minutes ? null : minutes < 0 ? {end: true, fade: FADE} : {at: Date.now() + ms, fade, timer: setTimeout(fadeOut, ms - fade)};
  sleepLabel();
  if (minutes) toast(minutes < 0 ? 'Stopping after this track' : `Stopping in ${minutes < 1 ? 'under a minute' : minutes + ' minutes'}`);
}
function sleepLabel() {
  const button = barButton('sleep');
  if (!button) return;
  button.classList.toggle('on', !!sleep);
  button.title = !sleep ? 'Sleep timer' : sleep.end ? 'Stops after this track' : `Stops in ${Math.max(1, Math.round((sleep.at - Date.now()) / 60000))} min`;
}
async function fadeOut() {
  if (!sleep || sleep.fading) return;
  sleep.fading = true;
  const el = media.el, base = el?.volume ?? 1, steps = 50, fade = sleep.fade;
  for (let i = 1; el && i <= steps && sleep?.fading; i++) {
    // The user moved the volume themselves: stop fading and leave it there.
    if (i > 1 && Math.abs(el.volume - base * (1 - (i - 1) / steps)) > 0.02) { sleep = null; return sleepLabel(); }
    el.volume = base * (1 - i / steps);
    await wait(fade / steps);
  }
  if (player.playing) commands.toggle();
  await wait(300);
  if (el) el.volume = base;
  sleep = null;
  sleepLabel();
}
on('tick', () => {
  if (sleep?.end && player.playing && player.total && player.total - player.passed <= FADE / 1000) fadeOut();
  sleepLabel();
});

const commands = {
  toggle: () => document.querySelector('.playControls__play')?.click(),
  next: () => document.querySelector('.skipControl__next')?.click(),
  previous: () => document.querySelector('.skipControl__previous')?.click(),
  back: () => skip(-pref('skip_back')),
  forward: () => skip(pref('skip_forward')),
  like: () => document.querySelector('.playbackSoundBadge__like, .playbackSoundBadge__actions .sc-button-like')?.click(),
  volume_up: () => volume(true),
  volume_down: () => volume(false),
  sleep: minutes => setSleep(Number(minutes) || 0),
  seek: t => seekTo(Number(t) || 0),
  speed: rate => setSpeed(Number(rate) || 1),
  panel: tab => openPanel(tab || undefined, true),
};

barButtons.push(
  {name: 'back', icon: 'back', label: 'Skip back', onclick: () => commands.back(), mini: true},
  {name: 'forward', icon: 'forward', label: 'Skip forward', onclick: () => commands.forward(), mini: true},
  {name: 'speed', text: '1×', label: 'Playback speed', narrow: true, onclick: event => {
    const now = player.path ? rateFor(player.path) : pref('speed');
    popup(event.currentTarget, [{heading: 'Speed for this track'}, ...[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map(rate =>
      ({label: `${rate}×`, checked: rate === now, action: () => setSpeed(rate)})),
      {label: `Use ${now}× for every track`, action: () => setSpeed(now, true)}]);
  }},
  {name: 'sleep', icon: 'moon', label: 'Sleep timer', narrow: true, onclick: event => popup(event.currentTarget, [{heading: 'Sleep timer'},
    ...[15, 30, 45, 60, 90].map(minutes => ({label: `${minutes} minutes`, checked: false, action: () => setSleep(minutes)})),
    {label: 'End of this track', checked: !!sleep?.end, action: () => setSleep(-1)}, {label: 'Off', checked: !sleep, action: () => setSleep(0)}])},
  {name: 'panel', icon: 'panel', label: 'GoLow panel (Ctrl+.)', onclick: () => openPanel(undefined, true)},
);
on('key', event => {
  if (event.key === '[') { event.preventDefault(); commands.back(); }
  if (event.key === ']') { event.preventDefault(); commands.forward(); }
});
document.addEventListener('click', event => {
  if (!event.isTrusted) return;
  const play = event.target.closest?.('.sc-button-play');
  if (play) picked = {at: Date.now(), inList: !!play.closest('.lazyLoadingList')};
  // SoundCloud's own autoplay switch sets the remembered choice too.
  if (event.target.closest?.('.queueFallback__toggle')) setTimeout(() => change('autoplay', !!document.querySelector('.queueFallback__toggle .sc-toggle-on')));
}, true);
