// Discovery: a release radar of what the artists you follow uploaded (not what they reposted),
// with optional Windows notifications, and lyrics for what is playing.
menu.push(
  {section: 'Lists and feed', key: 'notify', label: 'Notify me about new releases',
    hint: 'A Windows notification when artists you follow upload, while GoLow is open or in the tray.'},
);

// --- Release radar ---
let radar = null, radarBusy = false, radarWindow = 7;
// Uploads by the artists themselves: not reposts, and not your own posts.
const isOriginal = item => (item.type === 'track' || item.type === 'playlist') && (item.track || item.playlist) &&
  (item.track || item.playlist).user?.id !== session.me?.id;
async function loadRadar(pages = 4) {
  await me().catch(() => null);
  const items = [];
  for (let next = 'stream', i = 0; next && i < pages; i++) {
    const page = await api(next, i ? {} : {limit: 50, linked_partitioning: 1});
    items.push(...(page?.collection || []));
    next = page?.next_href || null;
  }
  return items.filter(isOriginal).map(item => {
    const sound = item.track || item.playlist;
    return {id: `${sound.kind}:${sound.id}`, title: sound.title, artist: sound.user?.username || item.user?.username || '', path: pathOf(sound.permalink_url),
      at: Date.parse(sound.display_date || sound.created_at || item.created_at), duration: sound.duration || 0, kind: sound.kind,
      count: sound.track_count};
  }).filter((item, i, all) => item.path && all.findIndex(other => other.id === item.id) === i).sort((a, b) => b.at - a.at);
}
async function refreshRadar() {
  radarBusy = true;
  refreshPanel('radar');
  try { radar = await loadRadar(); } catch (error) { toast('Could not load new releases: ' + error.message); }
  radarBusy = false;
  refreshPanel('radar');
}
tabs.push({id: 'radar', label: 'Radar', order: 6, render(body) {
  body.append(h('div', {cls: 'row'}, h('h2', {text: 'New from artists you follow'}),
    h('select', {'aria-label': 'Period', onchange: event => { radarWindow = Number(event.target.value); refreshPanel('radar'); }},
      [[7, 'Last 7 days'], [30, 'Last 30 days']].map(([value, text]) => h('option', {value, text, selected: value === radarWindow})))));
  if (!radar) {
    if (!radarBusy) refreshRadar();
    return body.append(h('p', {text: 'Reading your feed…'}));
  }
  const seen = local.radar_seen || 0, since = Date.now() - radarWindow * DAY;
  const shown = radar.filter(item => item.at >= since);
  if (!shown.length) body.append(h('p', {text: 'Nothing new in this period. Reposts are left out: only uploads by the artists themselves show here.'}));
  body.append(h('ul', {cls: 'list'}, shown.map(item => h('li', {cls: item.at > seen ? 'current' : ''},
    h('div', {cls: 'grow'}, h('a', {cls: 'clip', href: item.path, text: item.title, style: 'display:block'}),
      h('div', {cls: 'clip dim', text: [item.artist, item.kind === 'playlist' ? `${item.count || ''} tracks` : clock(item.duration / 1000), ago(item.at)].filter(Boolean).join(' · ')})),
    h('button', {cls: 'btn', type: 'button', text: 'Play', onclick: () => playPath(item.path)})))),
    h('button', {cls: 'btn', type: 'button', text: radarBusy ? 'Refreshing…' : 'Refresh', disabled: radarBusy, onclick: refreshRadar}));
  local.radar_seen = Math.max(seen, radar[0]?.at || 0);
  store('prefs', local);
}});
// Every half hour while GoLow runs, look for uploads newer than the last one seen.
async function watchReleases() {
  if (settings.notify && window.ipc) {
    try {
      const fresh = (await loadRadar(1)).filter(item => item.at > (local.radar_notified || Date.now() - DAY));
      if (fresh.length) {
        local.radar_notified = fresh[0].at;
        store('prefs', local);
        const [first] = fresh;
        await call('notify', {title: fresh.length === 1 ? `New from ${first.artist}` : `${fresh.length} new releases`,
          body: fresh.length === 1 ? first.title : fresh.slice(0, 3).map(item => `${item.artist}: ${item.title}`).join('\n'), tab: 'radar'});
        radar = null;
      }
    } catch {}
  }
  setTimeout(watchReleases, 30 * 60000);
}
setTimeout(watchReleases, 2 * 60000);

// --- Lyrics, synced to the music when LRCLIB has timed lines ---
let lyrics = {path: null, loading: false, lines: [], plain: '', found: null};
function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const [, minutes, secs] of stamps) lines.push({t: Number(minutes) * 60 + Number(secs), text: words});
  }
  return lines.sort((a, b) => a.t - b.t);
}
async function loadLyrics() {
  const path = player.path;
  if (!path || lyrics.path === path) return;
  lyrics = {path, loading: true, lines: [], plain: '', found: null};
  refreshPanel('lyrics');
  // SoundCloud uploads are often titled "Artist - Title".
  const parts = player.title.split(/\s[-–—]\s/);
  const [artist, title] = parts.length > 1 ? [parts[0], parts.slice(1).join(' - ')] : [player.artist, player.title];
  try {
    const found = await call('lyrics', {artist, title, seconds: Math.round(player.total)}, 30000);
    if (lyrics.path !== path) return;
    lyrics = {path, loading: false, found, lines: parseLrc(found?.synced), plain: found?.plain || ''};
  } catch {
    lyrics = {path, loading: false, lines: [], plain: '', found: null};
  }
  refreshPanel('lyrics');
}
let lyricLine = -1;
tabs.push({id: 'lyrics', label: 'Lyrics', order: 2, render(body) {
  if (!player.path) return body.append(h('p', {text: 'Play something to see its lyrics.'}));
  if (lyrics.path !== player.path) { loadLyrics(); return body.append(h('p', {text: 'Looking for lyrics…'})); }
  if (lyrics.loading) return body.append(h('p', {text: 'Looking for lyrics…'}));
  if (lyrics.found?.instrumental) return body.append(h('p', {text: 'This track is an instrumental.'}));
  if (!lyrics.lines.length && !lyrics.plain) {
    return body.append(h('p', {text: 'No lyrics found. LRCLIB covers released songs best; remixes, mixes and unreleased tracks are often missing.'}),
      h('a', {href: 'https://www.google.com/search?q=' + encodeURIComponent(`${player.title} ${player.artist} lyrics`), target: '_blank', rel: 'noreferrer', text: 'Search the web'}));
  }
  body.append(h('div', {cls: 'title', text: lyrics.found?.title || player.title}), h('p', {text: lyrics.found?.artist || player.artist}));
  if (lyrics.lines.length) {
    body.append(h('ol', {cls: 'list lyrics'}, lyrics.lines.map((line, index) => h('li', {'data-line': String(index), title: 'Play from here',
      onclick: () => seekTo(line.t)}, line.text || '♪'))));
  } else {
    body.append(h('p', {style: 'white-space:pre-wrap;color:#ddd;font-size:14px', text: lyrics.plain}));
  }
  body.append(h('p', {cls: 'dim', text: 'Lyrics from LRCLIB.'}));
  lyricLine = -1;
}});
on('track', () => { if (panelOpen('lyrics')) refreshPanel('lyrics'); });
on('tick', () => {
  if (!overlayRoot.querySelector('.lyrics') || lyrics.path !== player.path || !lyrics.lines.length) return;
  const t = position() + 0.3;
  let index = -1;
  for (let i = lyrics.lines.length - 1; i >= 0; i--) if (lyrics.lines[i].t <= t) { index = i; break; }
  if (index === lyricLine) return;
  lyricLine = index;
  // The panel and the full-window view can both show the lyrics.
  for (const list of overlayRoot.querySelectorAll('.lyrics')) {
    list.querySelector('li.current')?.classList.remove('current');
    const line = list.querySelector(`li[data-line="${index}"]`);
    line?.classList.add('current');
    line?.scrollIntoView({block: 'center', behavior: 'smooth'});
  }
});
