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
    await page.locator('[data-tab="journey"]').click();await page.locator('[data-journey-section="halloween"]').click();
    assert.equal(await page.locator('.mt-halloween-quest').count(),7);
    assert.equal(await page.locator('.mt-halloween-quest.earned').count(),0);
    for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'event '+width);}
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-halloween-preview="manor"]').click();
    assert.equal(await page.locator('.mt-shop-preview.mt-theme-h26-manor').count(),1);
    await page.locator('[data-halloween-preview="harvest"]').click();
    await page.evaluate(()=>scrollTo(0,320));await page.screenshot({path:path.join(root,'test-results','halloween.png'),animations:'disabled'});
    await page.evaluate(()=>{
      const a=e2e.newManhwa('Тени старой библиотеки'),b=e2e.newManhwa('История у костра');
      a.rated=b.rated=true;a.lastRatedAt=b.lastRatedAt=new Date(2026,9,20,12).getTime();a.genres=['Ужасы'];
      a.status='done';a.completedAt=a.lastRatedAt;
      a.journal=Array.from({length:5},(_,i)=>({id:'entry'+i,chapter:i+1,text:'Впечатление',rating:9,ts:new Date(2026,9,18+i%3,12).getTime()}));
      e2e.state.manhwas=[a,b];e2e.render();
    });
    assert.equal(await page.locator('.mt-halloween-quest.earned').count(),7);
    const xp=await page.evaluate(()=>e2e.state.totalXp);await page.evaluate(()=>e2e.render());assert.equal(await page.evaluate(()=>e2e.state.totalXp),xp);
    await page.locator('#halloween-wardrobe').click();
    await page.locator('[data-profile-style="theme"]').selectOption('theme-h26-manor');
    await page.locator('[data-profile-style="frame"]').selectOption('frame-h26-spectral');
    await page.locator('[data-profile-style="badge"]').selectOption('badge-h26-keeper');
    await page.locator('#prof-save').click();
    await page.waitForSelector('#prof-edit');
    assert.equal(await page.locator('.mt-hero.mt-theme-h26-manor.mt-frame-h26-spectral').count(),1);
    await page.screenshot({path:path.join(root,'test-results','halloween-profile.png'),animations:'disabled'});
    await page.reload();await page.locator('[data-tab="profile"]').click();
    assert.equal(await page.locator('.mt-hero.mt-theme-h26-manor').count(),1);
    await page.clock.setFixedTime(new Date(2026,10,4,12));
    await page.locator('[data-tab="journey"]').click();await page.locator('[data-journey-section="halloween"]').click();
    assert.equal(await page.locator('.mt-halloween-quest.earned').count(),7);
    assert.match(await page.locator('.mt-halloween-date').innerText(),/завершено/);
    await page.evaluate(()=>{e2e.state.unlockedAchievements={};e2e.render();});
    assert.equal(await page.locator('.mt-halloween-quest.earned').count(),0);
    assert.equal(await page.locator('[data-halloween-go]').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS Halloween: mobile layout, preview, seven rewards, idempotency, profile equip/reload, expired event');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});

