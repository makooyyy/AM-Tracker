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
    res.setHeader('Content-Type', ({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)] || 'application/octet-stream');
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
    assert.equal(await page.locator('.mt-brand-mark').evaluate(img => img.complete && img.naturalWidth > 0),true);
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','design-empty.png'),fullPage:true});
    await page.evaluate(() => {
      const {state, newManhwa, average, render} = e2e;
      const m = newManhwa('Поднятие уровня в одиночку');
      m.id = 'sample'; m.rated = true; m.emotionRating = 5;
      m.criteria.forEach(c => c.score = 9); m.lastRatedAt = Date.now();
      m.notes = 'Сильный сюжет и выразительная рисовка. После перечитывания особенно понравилось развитие персонажей.';
      m.ratingReason = 'После перечитывания оценил персонажей выше.';
      m.genres = ['Фэнтези','Повседневность','Сверхъестественное','ОченьДлинноеНазваниеЖанраБезПробеловДляПроверкиПереноса'];
      m.ratingHistory = [{ts:new Date(2026,7,10).getTime(),avg:70,criteria:m.criteria.map(c => ({...c,score:7})),notes:'Первое впечатление'}];
      state.manhwas = [m].concat(['Всеведущий читатель', 'Начало после конца', 'Башня Бога', 'Возвращение героя', 'Магия возвращённого'].map((title,i) => {
        const entry = newManhwa(title); entry.id = 'demo-' + i;
        entry.rated = i < 3; entry.lastRatedAt = Date.now();
        entry.criteria.forEach(c => c.score = 8 - i / 2);
        return entry;
      })); state.recentOpened = {sample:Date.now()}; state.tab = 'library';
      state.awardWinners = {'2026-08':{overall:AMFeatures.awardSnapshot(m,'2026-08','overall',average,false)}};
      render();
    });
    assert.equal(await page.locator('.mt-continue-card').count(),1);
    for (const width of [320,390,1280]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`library overflow at ${width}px`);
      assert.equal(await page.locator('.mt-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
      await page.screenshot({animations:'disabled',path:path.join(root,'test-results',`design-library-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('#toggle-search').click();
    await page.locator('#search-input').fill('Всеведущий');
    assert.equal(await page.locator('.mt-grid-card').count(),1);
    await page.locator('#search-clear-btn').click();
    await page.locator('#toggle-search').click();
    await page.locator('#start-add-manhwa').click();
    await page.locator('#new-title-input').fill('Проверка формы добавления');
    await page.locator('#cancel-add-manhwa').click();
    assert.equal(await page.locator('.mt-grid-card').count(),6);
    await page.locator('.mt-continue-card').click();
    await page.waitForSelector('#compare-from');
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','design-detail.png'),fullPage:true});
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
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','share-mobile.png')});
    await page.locator('#close-share-card').click();
    await page.evaluate(() => { e2e.state.selectedId = null; e2e.state.tab = 'awards'; e2e.render(); });
    await page.waitForSelector('[data-awards-month]');
    await page.locator('[data-awards-month="2026-08"]').click();
    assert.equal(await page.locator('[data-awards-month="2026-08"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-preview-month="2026-08"]').first().click();
    await page.waitForSelector('#close-award-preview');
    assert.match(await page.locator('.mt-feature-dialog').innerText(),/Поднятие уровня/);
    await page.locator('#close-award-preview').click();
    await page.evaluate(() => {
      const {state,average,render} = e2e, a = state.manhwas[0], b = state.manhwas[1];
      const snap = (m,key,category) => AMFeatures.awardSnapshot(m,key,category,average,false);
      state.awardWinners['2025-01'] = {overall:snap(a,'2025-01','overall'),'Рисовка':snap(a,'2025-01','Рисовка'),'Сюжет':snap(b,'2025-01','Сюжет'),worst:snap(b,'2025-01','worst')};
      state.awardWinners['2025-02'] = {overall:snap(b,'2025-02','overall'),'Рисовка':snap(b,'2025-02','Рисовка'),'Сюжет':snap(a,'2025-02','Сюжет')};
      state.awardWinners['2024-01'] = {};
      render();
    });
    await page.locator('[data-awards-view="year"]').click();
    await page.locator('[data-awards-year="2025"]').click();
    assert.equal(await page.locator('.mt-annual-winner').count(),2);
    assert.equal(await page.locator('.mt-annual-month').count(),12);
    for (const width of [320,390,1280]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`annual overflow at ${width}px`);
      await page.screenshot({animations:'disabled',path:path.join(root,'test-results',`annual-${width}.png`),fullPage:true});
    }
    await page.locator('.mt-annual-winner').first().click();
    await page.waitForSelector('#close-award-preview');
    await page.locator('#close-award-preview').click();
    await page.locator('[data-year-month="2025-03"]').click();
    assert.match(await page.locator('.mt-empty-title').innerText(),/Победители не выбраны/);
    await page.locator('[data-awards-view="year"]').click();
    await page.locator('[data-awards-year="2024"]').click();
    assert.equal(await page.locator('.mt-annual-await').count(),1);
    await page.locator('.mt-annual-await [data-awards-view="month"]').click();
    for (const tab of ['awards','achievements','profile']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      for (const width of [320,390,1280]) {
        await page.setViewportSize({width,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`${tab} overflow at ${width}px`);
        if (tab === 'profile') {
          assert.equal(await page.locator('.mt-profile-genres .mt-bar-row').count(),4);
          assert.equal(await page.locator('.mt-profile-page .mt-bar-row').evaluateAll(rows => rows.every(row => {
            const name = row.querySelector('.mt-bar-name').getBoundingClientRect();
            const track = row.querySelector('.mt-bar-track').getBoundingClientRect();
            const value = row.querySelector('.mt-bar-value').getBoundingClientRect();
            return name.bottom <= track.top && value.bottom <= track.top && name.right <= value.left;
          })),true,`profile label overlaps track or value at ${width}px`);
        }
      }
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({animations:'disabled',path:path.join(root,'test-results',`design-${tab}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: reading shelf, rating comparison, 320/390/1280px layout, PNG download, monthly award preview; no page errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
