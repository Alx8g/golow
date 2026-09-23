"""Run through cloak-browse run. Uses a synthetic document, not an account."""
from pathlib import Path
import json

root = Path.cwd()
script = (root / 'src' / 'client.js').read_text(encoding='utf-8')
# Only replace the origin guard in this local fixture. Production file is untouched.
fixture_script = script.replace("location.protocol !== 'https:' ||\n      !['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)", "false", 1)
assert fixture_script != script
html = '''<html><head><title>SoundCloud cleanup fixture</title></head><body>
<div id="app"><div class="upsellBanner" id="promo">Try Artist Pro</div>
<div class="announcementBanner" id="ordinary">Account notice <button>Close</button></div>
<div class="upsellBanner" id="protected"><button aria-label="Play track">Play</button></div>
<div class="cookieBanner" id="consent">Choose cookies <button>Accept</button></div>
<div class="playControls" id="player"><button aria-label="Pause">Pause</button></div>
<div class="track" id="track">A song about promotions <button>Like</button></div>
<a href="/go" id="upsell-link">Go+</a>
<aside class="streamSidebar"><div class="homeCreditTracker" id="artist-tools"><div class="sidebarModule"><iframe title="Artist Tools" srcdoc="Artist Tools Amplify Replace Distribute Master Unlock Artist tools from NZ$4.25/month"></iframe></div></div>
<article class="artistShortcutsModule" id="new-tracks"><h4>New tracks</h4><button aria-label="Play new track">Play</button></article></aside>
<div id="dynamic"></div></div>
</body></html>'''
result = cdp('Target.createTarget', url='about:blank')
target_id = result['targetId']
session_id = cdp('Target.attachToTarget', targetId=target_id, flatten=True)['sessionId']

def evaluate(expression, await_promise=False):
    response = cdp('Runtime.evaluate', session_id=session_id, expression=expression, returnByValue=True, awaitPromise=await_promise)
    if 'exceptionDetails' in response:
        raise RuntimeError(response['exceptionDetails'])
    return response.get('result', {}).get('value')

try:
    evaluate('document.open();document.write(' + json.dumps(html) + ');document.close();')
    evaluate('window.__scMessages=[];window.ipc={postMessage:s=>window.__scMessages.push(JSON.parse(s))};')
    evaluate(fixture_script)
    result = evaluate('''(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const assert=(value,msg)=>{if(!value)throw new Error(msg);};
      const hidden=id=>document.getElementById(id).hasAttribute('data-sc-client-hidden');
      await wait(200);
      assert(hidden('promo')&&hidden('upsell-link'),'Explicit promos hidden');
      for(const id of ['ordinary','protected','consent','player','track','new-tracks'])assert(!hidden(id),'Protected content: '+id);
      assert(hidden('artist-tools'),'Artist Tools iframe host hidden without touching New Tracks');
      const initial=window.__scClient.diagnostics();
      await wait(3200);
      assert(window.__scClient.diagnostics().scans===initial.scans,'No idle polling scans');
      document.getElementById('dynamic').innerHTML='<div class="upsellBanner" id="new-promo">New upsell</div>';
      await wait(250); assert(hidden('new-promo'),'New subtree cleaned');
      window.__scClient.update({cleanup:false});
      assert(!hidden('promo')&&!hidden('new-promo')&&!hidden('artist-tools'),'Toggle restores existing content');
      assert(!window.__scClient.diagnostics().observer_active,'Disabled cleanup disconnects observer');
      window.__scClient.update({cleanup:true});
      assert(hidden('promo')&&hidden('artist-tools')&&!hidden('new-tracks'),'Re-enable cleanup preserves New Tracks');
      window.__scClient.setNativeHidden(true);
      const background=window.__scClient.diagnostics();
      assert(!background.observer_active&&!background.timer_active,'Background has no timer or observer');
      document.getElementById('dynamic').innerHTML='<div class="upsellBanner" id="background-promo">Later promo</div>';
      await wait(250); assert(!hidden('background-promo'),'No background scan');
      window.__scClient.setNativeHidden(false);
      assert(hidden('background-promo'),'Resume catches changed content');
      window.__scClient.openSettings(true);
      const shadow=document.getElementById('sc-client-settings').shadowRoot;
      assert(!shadow.getElementById('panel').hidden,'Settings opens');
      shadow.getElementById('efficiency').click();
      assert(window.__scMessages.some(x=>x.type==='settings'&&!x.value.efficiency),'Settings uses bounded native message');
      window.__scClient.status({cache_mib:400,low_memory:false});
      assert(shadow.getElementById('status').textContent.includes('400.0'),'Status rendered as text');
      shadow.getElementById('close').click();assert(shadow.getElementById('panel').hidden,'Settings closes');
      const beforeIrrelevant=window.__scClient.diagnostics().scans;
      for(let i=0;i<100;i++)document.getElementById('dynamic').appendChild(document.createElement('span'));
      const fakePromo=document.createElement('span');fakePromo.className='upsellBanner';document.getElementById('player').appendChild(fakePromo);
      await wait(250);
      const final=window.__scClient.diagnostics();
      assert(!final.timer_active,'Mutation batch drains');
      assert(final.scans===beforeIrrelevant,'Irrelevant and player mutations do not schedule scans');
      assert(!fakePromo.hasAttribute('data-sc-client-hidden'),'Player subtree is never cleaned');
      return {passed:true,tests:17,initial,background,final};
    })()''', True)
    output = root / '.working' / 'verification' / 'cleanup-browser.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
finally:
    cdp('Target.closeTarget', targetId=target_id)
