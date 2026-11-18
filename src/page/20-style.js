// Generic upsell selectors are guarded so a match can never hide the player, a form, a dialog or consent.
const protectedSelector = 'audio,video,input,form,[role="dialog"],.playControls,.waveform,.playbackTimeline,button[aria-label*="Play"],button[aria-label*="Pause"]';
const guarded = `:not(html,body,#root,#app,#main,#__next):not(:is(${protectedSelector})):not(:has(${protectedSelector}))` +
  ':not(:is(.playControls *,.waveform *,.playbackTimeline *))';
const promos = ['.upsellBanner', '.premiumUpsell', '.mobileAppsButtons', '.appBanner', '[data-testid="promoted-track"]',
  '[data-testid="upsell-banner"]', '[data-testid="artist-pro-banner"]', '.artistProBanner', '.artistUpsell', '.homeCreditTracker',
  'a[href="/go"]', 'a[href="/pro"]', 'a[href^="/go?"]', 'a[href^="/pro?"]', 'a[href^="https://artists.soundcloud.com"]',
  'a[href^="https://checkout.soundcloud.com"]'].map(s => s + guarded);
// Exact SoundCloud modules a listener never needs: creator tools, follow suggestions,
// app-store badges, footer links and banners that sell a plan.
const clutter = ['.header__upsellWrapper', '.header__forArtistsButton', '.header__soundInput', '.header__upload', '.whoToFollowModule',
  '.mobileApps', '.l-footer', '.l-product-banners .banner:has(a[href^="https://checkout.soundcloud.com"])'];
// SoundCloud's layouts are fixed 960px columns. Below that, drop the sidebar, stack the
// search filters above the results and keep the header on one row.
const narrow = [':is(.l-container,.l-fluid-fixed,.l-main,.l-fixed-top,.l-fixed-left,.searchTitle,.searchOptions,.searchOptions *){width:auto!important}',
  ':is(.l-fixed-top,.l-fixed-left,.searchOptions,.searchOptions *){position:static!important;height:auto!important}',
  '.l-main{margin:0!important;padding-right:0!important;border-right:0!important}', '.l-fixed-fluid .l-main{padding-top:0!important}',
  '.searchOptions__navigation{display:flex;flex-wrap:wrap;gap:4px 16px}', '.searchOptions__navigationItem{padding:0!important}',
  '.l-sidebar-right{display:none!important}', '.header__left{display:flex;flex:none}', '.header__logo{width:44px!important;overflow:hidden}',
  ':is(.header__right,.header__loginMenu,.header__navWrapper){white-space:nowrap}', 'body{overflow-x:hidden}', '.playControls__control{flex-shrink:0}'];
// Readability fixes for the redesign: a visible liked state and full-contrast waveforms
// on new track pages, plus room for content on wide monitors.
const polish = ['button[aria-label="Unlike"]{color:#f50!important}', '[role="slider"][aria-label="Waveform"] svg>g{opacity:1!important}'];
const wide = ['.l-container{width:min(1840px,calc(100vw - 64px))!important}', '.l-main{width:auto!important}'];
const waveformComments = ['.waveform :is(.commentPlaceholder,.commentPopover,canvas.waveformCommentsNode)', 'div:has(>[role="slider"][aria-label="Waveform"]) ol'];
// Mini player: only the control bar, filling the window, with the timeline given room.
const mini = ['body{overflow:hidden!important}', ':is(body>:not(#app),#app>:not(.playControls)){display:none!important}',
  '.playControls{top:0!important;height:auto!important;display:flex!important;align-items:center;visibility:visible!important}',
  '.playControls__inner{flex:1;transform:none!important}', '.playControls__wrapper{width:auto!important}', '.playControls__control{flex-shrink:0}',
  '.playControls__soundBadge{flex:0 1 220px!important;width:auto!important;min-width:0}', '.playControls__timeline{flex:1 1 140px!important;min-width:140px}',
  ':is(.playControls__shuffle,.playControls__repeat,.playControls__volume,.playControls__queue,.playbackSoundBadge__actions){display:none!important}'];
// Playlist tiles keep a SMIL buffering spinner inside a play button that stays hidden
// until hover. Hidden SMIL still forces style and layout every frame, so stop rendering
// it exactly while SoundCloud's own rules keep the button hidden.
const idleSpinners = ['.playableTile[data-playbutton="never"] .playableTile__playButton',
  '.playableTile[data-playbutton="hover"]:not(.m-playing) .playableTile__artwork:not(:hover) .playableTile__playButton:not(.forceVisibility)'];

const rules = list => list.map(rule => 'html:root ' + rule).join('');
const hide = list => list.length ? list.map(selector => 'html:root ' + selector).join(',') + '{display:none!important}' : '';
// Features add CSS here: functions returning a string, for the page and for track-page frames.
const css = [], frameCss = [];
css.push(() => hide(['[data-golow-filtered]']) + (settings.compact ? rules(mini) : ''));

// Rules live in constructed stylesheets rebuilt from settings. SoundCloud's React pages
// re-render <head> and <html>, but cannot remove a sheet that is not in the DOM.
const sheet = new CSSStyleSheet(), frameSheets = new Map();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
const build = list => list.map(fn => { try { return fn(); } catch (error) { console.debug('[GoLow] css', error); return ''; } }).join('');
function restyle() {
  const clean = settings.cleanup && !recovery;
  const shared = (clean ? hide([...promos, ...clutter]) + rules(polish) + 'html:root:has(>body.theme-dark){color-scheme:dark}' +
    `@media (min-width:1600px){${rules(wide)}}@media (max-width:999px){${rules(narrow)}}` : '') +
    (settings.efficiency ? hide(idleSpinners.map(s => s + ' svg:has(animate,animateTransform)')) : '') +
    (settings.comments ? '' : hide(waveformComments));
  sheet.replaceSync(shared + build(css));
  const inFrames = shared + build(frameCss);
  for (const [frame, frameSheet] of frameSheets) {
    frameSheet.replaceSync(inFrames);
    if (frame.contentDocument) emit('frame', frame.contentDocument, frame);
  }
}
restyle();
// Redesigned track pages load in a same-origin /n/ iframe that WebView2 does not inject
// into, so style each one from here once it loads. Sheets must come from the frame's realm.
const frames = () => [...frameSheets.keys()].filter(frame => frame.isConnected && frame.contentDocument?.location.pathname.startsWith('/n/'));
document.addEventListener('load', event => {
  const frame = event.target, doc = frame.tagName === 'IFRAME' && frame.contentDocument;  // null when cross-origin
  if (!doc || !doc.location.pathname.startsWith('/n/')) return;
  for (const old of frameSheets.keys()) if (!old.isConnected) frameSheets.delete(old);
  const frameSheet = new frame.contentWindow.CSSStyleSheet();
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, frameSheet];
  frameSheets.set(frame, frameSheet);
  restyle();
  new MutationObserver(() => emit('frame', doc, frame)).observe(doc.documentElement, {childList: true, subtree: true});
}, true);

// Most-liked comments first. CSS order reorders the flex list without moving React's nodes.
const likesOf = item => {
  for (let node = item.querySelector('button[aria-label$="ike"]'); node && node !== item; node = node.parentElement) {
    if (/^\d+$/.test(node.textContent.trim())) return Number(node.textContent.trim());
  }
  return 0;
};
on('frame', doc => {
  for (const item of doc.querySelectorAll('ul[aria-label="Comments"] > li')) {
    const likes = settings.top_comments ? likesOf(item) : 0;
    const order = likes ? String(-likes) : '';
    if (item.style.order !== order) item.style.order = order;
  }
});
