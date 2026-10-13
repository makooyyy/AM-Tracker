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
    if (name.startsWith('icons/')) file = path.join(root, '.publish-am-tracker', name);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.json':'application/json'})[path.extname(file)] || 'application/octet-stream');
    let body = fs.readFileSync(file);
    if (name === 'sync.js') body = '';
    if (name === 'app.js') body = body.toString().replace('/* ---------- boot ---------- */', 'window.e2e = {state, render, newManhwa, average, openTitle}; /* ---------- boot ---------- */');
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
    const page = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('[data-tab="library"]');
    await page.evaluate(() => {
      const {state, newManhwa, average, render} = e2e;
      const m = newManhwa('Поднятие уровня в одиночку');
      m.id = 'sample'; m.rated = true; m.emotionRating = 5;
      m.criteria.forEach(c => c.score = 9); m.lastRatedAt = Date.now();
      m.notes = 'Сильный сюжет и выразительная рисовка. После перечитывания особенно понравилось развитие персонажей.';
      m.ratingReason = 'После перечитывания оценил персонажей выше.';
      m.ratingHistory = [{ts:new Date(2026,7,10).getTime(),avg:70,criteria:m.criteria.map(c => ({...c,score:7})),notes:'Первое впечатление'}];
      state.manhwas = [m]; state.recentOpened = {sample:Date.now()}; state.tab = 'library';
      state.awardWinners = {'2026-08':{overall:AMFeatures.awardSnapshot(m,'2026-08','overall',average,false)}};
      render();
    });
    assert.equal(await page.locator('.mt-continue-card').count(),1);
    await page.locator('.mt-continue-card').click();
    await page.waitForSelector('#compare-from');
    assert.match(await page.locator('.mt-comparison-score').innerText(),/\+20/);
    for (const width of [320,390,1280]) {
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`overflow at ${width}px`);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('#share-rating-card').click();
    await page.waitForSelector('.mt-download-card');
    assert.equal(await page.locator('.mt-share-preview').evaluate(img => img.naturalWidth),1080);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.mt-download-card').click();
    const download = await downloadPromise;
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await download.saveAs(path.join(root,'test-results','share-card.png'));
    await page.screenshot({path:path.join(root,'test-results','share-mobile.png')});
    await page.locator('#close-share-card').click();
    await page.evaluate(() => { e2e.state.selectedId = null; e2e.state.tab = 'awards'; e2e.render(); });
    await page.waitForSelector('#awards-month');
    await page.selectOption('#awards-month','2026-08');
    await page.locator('[data-preview-month="2026-08"]').first().click();
    await page.waitForSelector('#close-award-preview');
    assert.match(await page.locator('.mt-feature-dialog').innerText(),/Поднятие уровня/);
    assert.deepEqual(errors,[]);
    console.log('PASS: reading shelf, rating comparison, 320/390/1280px layout, PNG download, monthly award preview; no page errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
