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
    const page = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    let catalogueFails=false;
    await page.route('https://graphql.anilist.co',route=>catalogueFails?route.fulfill({status:429,body:'{}'}):route.fulfill({contentType:'application/json',body:JSON.stringify({data:{Page:{media:[
      {id:101,title:{english:'Already saved'},synonyms:['Поднятие уровня в одиночку'],genres:['Fantasy'],countryOfOrigin:'KR'},
      {id:102,title:{english:'A New Adventure'},synonyms:[],genres:['Fantasy','Adventure'],countryOfOrigin:'JP',averageScore:90},
      {id:103,title:{english:'Another Story'},synonyms:[],genres:['Fantasy'],countryOfOrigin:'KR',averageScore:80},
      {id:104,title:{english:'A Very Long Title: The Beginning of Another Extraordinary Adventure'},synonyms:[],genres:['Fantasy'],countryOfOrigin:'CN',averageScore:70}
    ]}}})}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('[data-tab="library"]');

    await page.evaluate(()=>{
      const m=e2e.newManhwa('Test Reading');m.id='ux';m.genres=['Фэнтези'];e2e.state.manhwas=[m];e2e.openTitle('ux');
    });
    assert.ok(await page.locator('input[type=range]').count()>1,'criteria visible without choosing emotion');
    await page.locator('#finish-rating-btn').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].rated),false);
    assert.ok((await page.locator('#rating-confirm-error').innerText()).length>0);
    await page.locator('#rating-confirm').check();
    await page.locator('#finish-rating-btn').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].rated),true);
    if(await page.locator('#reveal-close-btn').count())await page.locator('#reveal-close-btn').click();
    await page.evaluate(()=>e2e.openTitle('ux'));
    await page.locator('#chapter-number').fill('12');
    await page.locator('#chapter-rating').press('End');
    await page.locator('#chapter-text').fill('A hidden twist');
    await page.locator('#chapter-spoiler').check();
    await page.locator('#chapter-form button').click();
    await page.locator('#chapter-number').fill('12');
    await page.locator('#chapter-rating').press('End');
    await page.locator('#chapter-rating').press('ArrowLeft');
    await page.locator('#chapter-form button').click();
    assert.match(await page.locator('#chapter-error').innerText(),/уже есть оценка/);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.length),1);
    await page.locator('#chapter-rating').press('Home');
    await page.locator('#chapter-text').fill('Additional note');
    await page.locator('#chapter-form button').click();
    assert.equal(await page.locator('#journal-list article').count(),2);
    await page.locator('#chapter-number').fill('13');
    await page.locator('#chapter-rating').press('End');
    await page.locator('#chapter-form button').click();
    await page.locator('#journal-search').fill('13');
    assert.equal(await page.locator('#journal-list article').count(),1);
    await page.locator('.mt-chapter-chart svg a').first().click();
    assert.equal(await page.locator('#journal-search').inputValue(),'');
    assert.equal(await page.locator('#journal-list details[open]').count(),0,'graph never reveals spoilers');
    assert.ok(await page.evaluate(()=>document.activeElement.id.startsWith('journal-entry-')));
    await page.locator('#journal-sort').selectOption('chapter');
    assert.match(await page.locator('#journal-list article header b').first().innerText(),/12/);
    await page.locator('#reading-settings summary').click();
    await page.locator('#reading-url').fill('https://senkuro.com/manga/test');
    await page.locator('#reading-form button').click();
    await page.locator('[data-reading-next="ux"]').click();
    await page.reload();await page.waitForSelector('[data-tab="library"]');
    await page.evaluate(()=>e2e.openTitle('ux'));
    assert.equal(await page.locator('#reading-chapter').inputValue(),'14');
    assert.equal(await page.locator('#reading-url').inputValue(),'https://senkuro.com/manga/test');
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'diary width '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('.mt-reading-panel').screenshot({path:path.join(root,'test-results','ux-reading.png')});
    await page.locator('.mt-chapter-chart').screenshot({path:path.join(root,'test-results','ux-chart.png')});
    let confirmations=0;page.on('dialog',async dialog=>{confirmations++;await dialog.accept();});
    await page.locator('[data-journal-delete]').first().click();
    assert.equal(confirmations,1,'one delete confirmation after sorting');
    await page.evaluate(()=>{e2e.state.selectedId=null;e2e.state.tab='journey';e2e.state.journeyUI.section='discover';e2e.render();});
    await page.locator('#discovery-add').waitFor();
    const hidden=await page.locator('#discovery-add').getAttribute('data-media-id');
    await page.locator('[data-discovery-feedback="hide"]').click();
    assert.notEqual(await page.locator('#discovery-add').getAttribute('data-media-id'),hidden);
    await page.reload();await page.waitForSelector('[data-tab="journey"]');await page.locator('[data-tab="journey"]').click();
    await page.locator('#discovery-add').waitFor();
    assert.notEqual(await page.locator('#discovery-add').getAttribute('data-media-id'),hidden);
    await page.locator('#discovery-undo').click();
    assert.equal(await page.locator('#discovery-add').getAttribute('data-media-id'),hidden);
    await page.locator('[data-discovery-feedback="like"]').click();
    await page.locator('#discovery-add').waitFor();
    await page.locator('[data-discovery-feedback="read"]').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.length),1,'feedback does not change library');
    assert.equal(await page.evaluate(()=>e2e.state.profile.journey.feedback.length),2);
    await page.locator('#discovery-undo').click();
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'recommendations width '+width);
    }
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'test-results','ux-discovery.png'),fullPage:true});
    await page.evaluate(()=>{e2e.state.tab='profile';e2e.state.totalXp=100;e2e.render();});
    await page.locator('#shop-open').click();
    await page.locator('#shop-availability').selectOption('affordable');
    const ids=await page.locator('[data-shop-preview]').evaluateAll(els=>els.map(e=>e.dataset.shopPreview));
    assert.ok(ids.length>0);
    assert.ok(await page.evaluate(ids=>ids.every(id=>AMFeatures.shopItem(id).price<=100),ids));
    await page.locator('#shop-sort').selectOption('price-asc');
    const prices=await page.locator('[data-shop-preview]').evaluateAll(els=>els.map(e=>AMFeatures.shopItem(e.dataset.shopPreview).price));
    assert.deepEqual(prices,prices.slice().sort((a,b)=>a-b));
    const item=await page.locator('[data-shop-preview]').first().getAttribute('data-shop-preview');
    await page.locator('[data-shop-preview]').first().click();
    await page.locator('[data-shop-buy]').click();
    await page.locator('#shop-edit-profile').click();
    assert.equal(await page.locator('#prof-save').count(),1);
    assert.equal(await page.evaluate(()=>e2e.state.profile.style&&e2e.state.profile.style.frame||''),'','purchase does not equip');
    await page.locator('#prof-save').click();await page.locator('#shop-open').click();
    await page.locator('#shop-availability').selectOption('owned');
    assert.equal(await page.locator('[data-shop-preview="'+item+'"]').count(),1);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'shop width '+width);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: explicit rating, duplicate protection, diary navigation, progress persistence, feedback and shop filters');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

