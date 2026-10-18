const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '') || 'index.html';
    if (!/^[a-zA-Z0-9./_-]+$/.test(name) || name.includes('..')) { res.writeHead(400).end(); return; }
    let file = path.join(root, name);
    if (name.startsWith('icons/') && !fs.existsSync(file)) file = path.join(root, '.publish-am-tracker', name);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)] || 'application/octet-stream');
    let body = fs.readFileSync(file);
    if (name === 'sync.js') body = '';
    if (name === 'app.js') body = body.toString().replace('/* ---------- boot ---------- */', 'window.e2e = {state, render, newManhwa, average, openTitle, saveXp}; /* ---------- boot ---------- */');
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});

    const page=await browser.newPage({viewport:{width:390,height:844}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://**/*',r=>r.abort());
    page.on('dialog',d=>d.accept());
    const url='http://127.0.0.1:'+server.address().port;
    await page.goto(url);
    await page.waitForSelector('[data-tab="library"]');
    for(const width of [320,390,768,1280]){
      await page.setViewportSize({width,height:844});
      for(const tab of ['library','journey','awards','achievements','profile']){
        await page.locator('[data-tab="'+(tab==='achievements'?'journey':tab)+'"]').click();
        if(tab==='achievements') await page.locator('[data-journey-section="achievements"]').click();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'empty '+tab+' '+width+' '+JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>[e.className,e.getBoundingClientRect().width]).slice(0,12))));
      }
    }
    await page.locator('[data-tab="library"]').click();
    await page.locator('#start-add-manhwa').click();
    const title='История "кавычки" & <текст>';
    await page.locator('#new-title-input').fill(title);
    await page.evaluate(()=>e2e.render());
    assert.equal(await page.locator('#new-title-input').inputValue(),title);
    await page.locator('#confirm-add-manhwa').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].title),title);
    await page.reload();await page.waitForSelector('[data-tab="profile"]');
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].title),title);
    await page.locator('[data-tab="profile"]').click();
    assert.equal(await page.locator('#export-btn').count(),0);
    await page.locator('#account-settings-open').click();
    await page.locator('[data-ui-setting="reduceMotion"]').check();
    await page.locator('[data-ui-setting="largeText"]').check();
    await page.locator('#prof-edit').click();
    await page.locator('#prof-nick').fill('Настроенный профиль');
    await page.locator('#prof-save').click();
    assert.equal(await page.locator('.mt-settings-page').count(),1);
    for(const width of [320,390,768,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'settings overflow '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({animations:'disabled',fullPage:true,path:path.join(root,'test-results','settings-new.png')});
    const dl=page.waitForEvent('download');await page.locator('#export-btn').click();
    const download=await dl; const backup=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert.equal(backup.manhwas[0].title,title);
    backup.manhwas[0].title='Восстановленная история';
    await page.locator('#import-file-input').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
    await page.waitForFunction(()=>e2e.state.manhwas[0].title==='Восстановленная история');
    await page.reload();await page.waitForSelector('[data-tab="profile"]');
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].title),'Восстановленная история');
    await page.locator('[data-tab="profile"]').click();
    await page.locator('#account-settings-open').click();
    assert.equal(await page.locator('[data-ui-setting="reduceMotion"]').isChecked(),true);
    assert.equal(await page.locator('[data-ui-setting="largeText"]').isChecked(),true);
    assert.ok(await page.evaluate(()=>document.documentElement.classList.contains('mt-large-text')));
    await page.locator('[data-ui-setting="largeText"]').uncheck();
    await page.locator('[data-ui-setting="reduceMotion"]').uncheck();
    await page.locator('#import-file-input').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{bad json')});
    await page.waitForFunction(()=>!!e2e.state.error);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.length),1);
    // A response from an aborted request must not revive recommendations after all seeds disappear.
    let requested;const requestSeen=new Promise(r=>requested=r);
    let release;const held=new Promise(r=>release=r);
    await page.route('https://graphql.anilist.co',async route=>{requested();await held;await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{Page:{media:[]}}})}).catch(()=>{});});
    await page.evaluate(()=>{const m=e2e.state.manhwas[0];m.rated=true;m.genres=['Фэнтези'];m.lastRatedAt=Date.now();e2e.state.tab='journey';e2e.render();});
    await requestSeen;
    await page.evaluate(()=>{e2e.state.manhwas=[];e2e.render();});
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>e2e.state.journeyUI.discoveryError),'');
    assert.equal(await page.locator('#discovery-retry').count(),0);
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>{e2e.state.tab='library';e2e.render();});
    await page.locator('#start-add-manhwa').click();
    await page.locator('#new-title-input').fill('Old request');
    let searchSeen, searchRelease;
    const seen=new Promise(r=>searchSeen=r), heldSearch=new Promise(r=>searchRelease=r);
    await page.route('https://graphql.anilist.co',async route=>{searchSeen();await heldSearch;await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{Page:{media:[{id:7,title:{english:'Stale'}}]}}})}).catch(()=>{});});
    await page.locator('#anilist-search-btn').click();await seen;
    await page.locator('#cancel-add-manhwa').click();
    await page.locator('#start-add-manhwa').click();
    await page.locator('#new-title-input').fill('New draft');
    searchRelease();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#new-title-input').inputValue(),'New draft');
    assert.equal(await page.evaluate(()=>e2e.state.aniListResults),null);
    assert.deepEqual(errors,[]);
    // Separate context: real service worker and isolated local storage.
    const offline=await browser.newContext({viewport:{width:390,height:844}});
    const p=await offline.newPage();
    await p.goto(url);
    await p.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
    await offline.setOffline(true);
    await p.reload();
    await p.waitForSelector('[data-tab="library"]');
    for(const tab of ['journey','awards','profile'])await p.locator('[data-tab="'+tab+'"]').click();
    assert.ok(await p.locator('#shop-open').count());
    await offline.close();
    console.log('PASS audit: empty tabs at four widths, quoted titles, create/reload, backup roundtrip, malformed import, stale discovery, offline PWA');
  } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
