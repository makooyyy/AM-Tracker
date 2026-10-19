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



    const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
    await page.clock.setFixedTime(new Date(2026,9,22,12));
    const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForSelector('html.mt-halloween-site');
    assert.equal(await page.locator('.mt-header .mt-brand').count(),0);
    assert.equal(await page.locator('#open-changelog').count(),1);
    assert.equal(await page.locator('.mt-season-actions #open-changelog').count(),1);
    for(const tab of ['library','catalog','journey','awards','profile']){
      await page.locator('[data-tab="'+tab+'"]').click();
      await page.locator('#season-settings-open').click();
      await page.locator('#season-settings-open').click();
      await page.locator('#account-settings-back').click();
      assert.equal(await page.evaluate(()=>e2e.state.tab),tab);
    }
    await page.locator('[data-tab="library"]').click();
    await page.locator('#season-settings-open').click();
    await page.locator('#open-changelog').click();
    await page.locator('#changelog-back-btn').click();
    assert.equal(await page.locator('#account-settings-back').count(),1);
    await page.locator('#account-settings-back').click();
    assert.equal(await page.evaluate(()=>e2e.state.tab),'library');
    for(const width of [320,390,768,1280]){
      await page.setViewportSize({width,height:844});
      for(const tab of ['library','catalog','journey','awards','profile']){
        await page.locator('[data-tab="'+tab+'"]').click();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'theme '+tab+' '+width);
      }
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-tab="library"]').click();
    await page.screenshot({path:path.join(root,'test-results','season-library.png'),animations:'disabled'});
    await page.locator('#season-settings-open').click();
    await page.locator('[data-appearance="classic"]').click();
    assert.equal(await page.locator('html.mt-halloween-site').count(),0);
    await page.reload();await page.locator('[data-tab="profile"]').click();
    assert.equal(await page.locator('html.mt-halloween-site').count(),0);
    await page.locator('#account-settings-open').click();
    await page.locator('[data-appearance="halloween"]').click();
    await page.clock.setFixedTime(new Date(2026,10,5,12));
    await page.reload();assert.equal(await page.locator('html.mt-halloween-site').count(),1);
    await page.locator('#season-settings-open').click();
    await page.locator('[data-appearance="halloween"]').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,'test-results','season-settings.png'),animations:'disabled'});
    await page.locator('[data-appearance="auto"]').click();assert.equal(await page.locator('html.mt-halloween-site').count(),0);
    await page.reload();assert.equal(await page.locator('html.mt-halloween-site').count(),0);
    assert.deepEqual(errors,[]);console.log('PASS seasonal skin: responsive tabs, default in event, classic override, permanent Halloween, automatic expiry');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});

