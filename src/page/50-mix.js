// Mix mode: tracklists for DJ mixes and podcasts, from the description or from comments, the
// track playing inside a mix, bookmarks, and clickable times on track pages.
menu.push({section: 'Mixes and podcasts', key: 'mix_chapters', label: 'Show the track playing inside a mix', def: true,
  hint: 'From the mix tracklist: in the title bar, Discord and Last.fm.'},
{section: 'Mixes and podcasts', key: 'timestamps', label: 'Clickable times on track pages', def: true});

// A time like 4:31, 04:31 or 1:02:03, standing alone in the line.
const STAMP = /(?:^|[\s[(|#])(\d{1,2}(?::[0-5]\d){1,2})(?=$|[\s\])|:.,\-–—])/;
const stripName = text => text.replace(/[[(]\s*[\])]/g, ' ').replace(/^\s*#?\d{1,3}[.)]\s*/, '').replace(/^[\s\-–—|:•·.]+|[\s\-–—|:•·]+$/g, '').replace(/\s{2,}/g, ' ').trim();
// "Artist - Title" lines with a time each. A tracklist has three or more, in time order.
function parseTracklist(text, total = 0) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(), match = line.length <= 240 && STAMP.exec(line);
    if (!match) continue;
    const t = toSeconds(match[1]), at = match.index + match[0].lastIndexOf(match[1]);
    const name = stripName(line.slice(0, at) + ' ' + line.slice(at + match[1].length));
    if (name && (!total || t < total) && (!entries.length || t > entries.at(-1).t)) entries.push({t, name, ...split(name)});
  }
  return entries.length >= 3 ? entries : [];
}
function split(name) {
  const [artist, ...rest] = name.split(/\s[-–—]\s/);
  const title = rest.join(' - ');
  // "ID - ID" and "Artist - ID" are unknown tracks: show them, never scrobble them.
  return title && !/^(id|unknown)$/i.test(title.trim()) && !/^id$/i.test(artist.trim()) ? {artist: artist.trim(), title: title.trim()} : {artist: '', title: ''};
}

// The mix currently loaded in the player.
let mix = {path: null, chapters: [], source: '', ids: [], loading: false};
async function loadMix(path) {
  if (mix.path === path) return;
  mix = {path, chapters: [], source: '', ids: [], loading: true};
  const track = player.total >= LONG ? await trackAt(path) : tracks.get(path);
  if (mix.path !== path) return;
  mix.chapters = parseTracklist(track?.description, player.total);
  mix.source = mix.chapters.length ? 'description' : '';
  mix.loading = false;
  marks();
  refreshPanel('now');
}
on('track', path => loadMix(path));

// Timed comments: whole tracklists people post, and answers to "ID?" at their time.
async function findIds() {
  const path = mix.path, track = tracks.get(path);
  if (!track?.id) return toast('GoLow could not find this track on SoundCloud.');
  mix.loading = true;
  refreshPanel('now');
  try {
    const comments = await collect(`tracks/${track.id}/comments`, {threaded: 0, limit: 200, offset: 0, linked_partitioning: 1}, 1000);
    if (mix.path !== path) return;
    let best = [];
    const ids = [];
    for (const comment of comments) {
      const body = String(comment.body || '').replace(/^(@\S+\s*)+/, '').trim();
      const list = parseTracklist(body, player.total);
      if (list.length > best.length) { best = list; best.by = comment.user?.username || ''; }
      const at = comment.timestamp == null ? null : Math.floor(comment.timestamp / 1000);
      if (at !== null && /\s[-–—]\s/.test(body) && !/\?\s*$/.test(body) && body.length <= 120 && !/^https?:/i.test(body) && split(body).title) {
        ids.push({t: at, name: body, by: comment.user?.username || ''});
      }
    }
    ids.sort((a, b) => a.t - b.t);
    mix.ids = ids.filter((id, i) => !ids.slice(0, i).some(other => other.name.toLowerCase() === id.name.toLowerCase() && id.t - other.t < 60));
    if (!mix.chapters.length && best.length >= 5) {
      mix.chapters = best.map(({t, name}) => ({t, name, ...split(name)}));
      mix.source = `a comment by ${best.by}`;
    }
    toast(mix.ids.length || mix.source ? `Found ${mix.ids.length} IDs in ${comments.length} comments` : `No IDs in ${comments.length} comments yet`);
  } catch (error) {
    toast('Could not load comments: ' + error.message);
  }
  mix.loading = false;
  marks();
  refreshPanel('now');
}

let shownChapter = null;
on('tick', () => {
  const list = pref('mix_chapters') && mix.path === player.path ? mix.chapters : [];
  const t = position();
  let index = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].t <= t) { index = i; break; }
  const chapter = list[index];
  player.chapter = chapter ? {...chapter, seconds: Math.max(30, Math.round((list[index + 1]?.t ?? player.total) - chapter.t))} : null;
  if (chapter !== shownChapter) { shownChapter = chapter; refreshPanel('now'); }
});

// --- Bookmarks, kept per track ---
const bookmarks = stored('bookmarks', {});
function saveBookmarks() {
  for (const [path, list] of Object.entries(bookmarks)) if (!list.length) delete bookmarks[path];
  const keys = Object.keys(bookmarks);
  for (const key of keys.slice(0, Math.max(0, keys.length - 300))) delete bookmarks[key];
  store('bookmarks', bookmarks);
  marks();
  refreshPanel('now');
}
function addBookmark() {
  if (!player.path) return;
  const t = Math.floor(position()), list = bookmarks[player.path] ||= [];
  list.push({t, note: ''});
  list.sort((a, b) => a.t - b.t);
  saveBookmarks();
  toast(`Bookmarked ${clock(t)}`, {label: 'Add a note', run: () => openPanel('now')});
}
commands.bookmark = addBookmark;
on('key', event => { if (event.key === 'B' && event.shiftKey) { event.preventDefault(); addBookmark(); } });

// Chapter ticks and bookmark dots on SoundCloud's timeline; clicks still reach the timeline.
const [markHost, markRoot] = shadowHost('golow-marks', `:host{position:absolute;inset:0;pointer-events:none;z-index:1}
  i{position:absolute;top:30%;bottom:30%;width:1px;background:#ffffff59}b{position:absolute;top:50%;width:7px;height:7px;margin:-3.5px;border-radius:50%;background:#5cf2a8}`);
css.push(() => '.playbackTimeline__progressWrapper{position:relative}');
function marks() {
  const timeline = document.querySelector('.playbackTimeline__progressWrapper');
  if (!timeline || !player.total) return markHost.remove();
  if (markHost.parentElement !== timeline) timeline.append(markHost);
  const at = t => `left:${(t / player.total * 100).toFixed(3)}%`;
  const chapters = mix.path === player.path ? mix.chapters : [];
  markRoot.replaceChildren(markRoot.firstChild, ...chapters.slice(1).map(c => h('i', {style: at(c.t), title: c.name})),
    ...(bookmarks[player.path] || []).map(b => h('b', {style: at(b.t), title: b.note || clock(b.t)})));
}
on('track', marks);
let marksTotal = 0;
on('tick', () => { if (player.total !== marksTotal) { marksTotal = player.total; marks(); } });

// --- The panel tab ---
function timeRow(t, name, extra = [], current = false) {
  return h('li', {cls: current ? 'current' : ''}, h('span', {cls: 'time', role: 'button', tabindex: '0', text: clock(t), title: 'Play from here',
    onclick: () => seekTo(t), onkeydown: event => event.key === 'Enter' && seekTo(t)}), h('span', {cls: 'grow clip', text: name, title: name}), extra);
}
tabs.push({id: 'now', label: 'Now', order: 1, render(body) {
  if (!player.path) return body.append(h('p', {text: 'Play a track, mix or podcast to see its tracklist, bookmarks and tools here.'}));
  const goTo = h('input', {type: 'text', placeholder: 'Go to 1:02:03', 'aria-label': 'Go to time', onkeydown: event => {
    if (event.key === 'Enter' && /^\d{1,2}(:\d{1,2}){0,2}$/.test(event.target.value.trim())) seekTo(toSeconds(event.target.value.trim()));
  }});
  body.append(h('div', {cls: 'title', text: player.title || 'Now playing'}), h('p', {text: player.artist}),
    h('div', {cls: 'row'}, goTo, h('button', {cls: 'btn', type: 'button', text: `Bookmark ${clock(position())}`, onclick: addBookmark})));
  const marked = bookmarks[player.path] || [];
  if (marked.length) {
    body.append(h('h3', {text: 'Bookmarks'}), h('ul', {cls: 'list'}, marked.map(mark => timeRow(mark.t, '', [
      h('input', {type: 'text', cls: 'grow', value: mark.note, placeholder: 'Note', 'aria-label': 'Bookmark note',
        onchange: event => { mark.note = event.target.value.slice(0, 200); saveBookmarks(); }}),
      iconButton('close', 'Delete bookmark', () => { marked.splice(marked.indexOf(mark), 1); saveBookmarks(); })]))));
  }
  const mine = mix.path === player.path;
  if (mine && mix.chapters.length) {
    const current = player.chapter?.t;
    body.append(h('h3', {text: `Tracklist · ${mix.chapters.length} tracks from ${mix.source}`}),
      h('ul', {cls: 'list'}, mix.chapters.map(c => timeRow(c.t, c.name, [], c.t === current))),
      h('div', {cls: 'row'}, h('button', {cls: 'btn', type: 'button', text: 'Copy tracklist', onclick: () =>
        navigator.clipboard?.writeText(mix.chapters.map(c => `${clock(c.t)} ${c.name}`).join('\n')).then(() => toast('Tracklist copied'))})));
  } else if (player.total >= LONG) {
    body.append(h('p', {text: mine && mix.loading ? 'Looking for a tracklist…' : 'No tracklist in the description.'}));
  }
  if (mine && player.total >= LONG) {
    body.append(h('div', {cls: 'row'},
      h('button', {cls: 'btn', type: 'button', text: mix.loading ? 'Reading comments…' : 'Find IDs in comments', disabled: mix.loading, onclick: findIds}),
      h('a', {href: 'https://www.google.com/search?q=' + encodeURIComponent(`${player.title} ${player.artist} tracklist`), target: '_blank', rel: 'noreferrer', text: 'Search the web'})));
  }
  if (mine && mix.ids.length) {
    body.append(h('h3', {text: `IDs from comments · ${mix.ids.length}`}),
      h('ul', {cls: 'list'}, mix.ids.map(id => timeRow(id.t, id.name, h('span', {cls: 'dim clip', text: id.by, style: 'max-width:90px'})))));
  }
}});

// --- Clickable times in descriptions and comments on track pages ---
// The CSS Highlight API marks the times without touching React's text nodes.
frameCss.push(() => pref('timestamps') ? '::highlight(golow-time){color:#f50;text-decoration:underline}' : '');
// "02:37: Artist - Title" is common: a colon may follow. Clock readings like 12:30:45.5 are not times in the track.
const TIMES = /(?<![\d:.])(\d{1,2}(?::[0-5]\d){1,2})(?!\d|[:.]\d)/g;
const clickable = new WeakSet();
const pagePath = doc => pathOf(doc.location.pathname.replace(/^\/n(?=\/)/, ''));
let pendingSeek = null;
// Description and comment text only: not links, buttons, SoundCloud's own time controls, or the
// header with the waveform and its clock.
const SKIP = 'button,a,time,svg,input,textarea,script,style,[role="button"],[role="slider"],[role="group"],section[aria-label="Track header"]';
function textNodes(root, out = []) {
  for (const node of root.childNodes) {
    if (node.nodeType === 3) { if (/\d:\d\d/.test(node.data)) out.push(node); }
    else if (node.nodeType === 1 && !node.matches(SKIP)) textNodes(node, out);
  }
  return out;
}
// One pass shortly after React settles, however many updates arrive.
const scheduled = new WeakSet();
on('frame', (doc, frame) => {
  if (scheduled.has(doc)) return;
  scheduled.add(doc);
  setTimeout(() => { scheduled.delete(doc); highlightTimes(doc, frame); }, 250);
});
function highlightTimes(doc, frame) {
  const win = frame.contentWindow;
  if (!win?.CSS?.highlights || !win.Highlight) return;
  if (!pref('timestamps')) return win.CSS.highlights.delete('golow-time');
  const ranges = [];
  for (const node of textNodes(doc.querySelector('main') || doc.body).slice(0, 2000)) {
    for (const match of node.data.matchAll(TIMES)) {
      const range = new win.Range();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[1].length);
      ranges.push(range);
    }
  }
  win.CSS.highlights.set('golow-time', new win.Highlight(...ranges));
  if (clickable.has(doc)) return;
  clickable.add(doc);
  doc.addEventListener('click', event => {
    const caret = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
    const hit = caret && [...(win.CSS.highlights.get('golow-time') || [])].find(range => range.startContainer === caret.startContainer &&
      range.startOffset <= caret.startOffset && caret.startOffset <= range.endOffset);
    if (!hit) return;
    event.preventDefault();
    const t = toSeconds(hit.toString()), path = pagePath(doc);
    if (player.path === path) {
      seekTo(t);
      if (!player.playing) commands.toggle();
    } else {
      pendingSeek = {path, t};
      pressPagePlay();
    }
  }, true);
}
on('track', path => {
  if (pendingSeek?.path === path) seekTo(pendingSeek.t);
  pendingSeek = null;
});
