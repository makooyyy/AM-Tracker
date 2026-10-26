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


    page.on('dialog',d=>d.accept());
    await page.evaluate(()=>{
      e2e.state.manhwas=['Первый','Второй','Третий'].map((title,i)=>{
        const m=e2e.newManhwa(title);m.id='v'+i;m.rated=true;m.genres=['Фэнтези'];m.criteria.forEach(c=>c.score=9-i);return m;
      });
      const m=e2e.state.manhwas[0];m.readingRun=2;m.readingRuns=[{run:1,chapter:20,ended:100,score:70}];
      m.reading={chapter:5,url:'',updatedAt:200};m.journal=[{id:'before',chapter:5,ts:100,rating:7,text:'old',spoiler:true},{id:'now',run:2,chapter:5,ts:200,rating:9,text:'new',spoiler:true}];
      e2e.state.profile.library={collections:[{id:'c',name:'Любимое'}],showcase:{titles:[]},trash:[]};e2e.render();
      window.AMApp.commit({titles:{put:e2e.state.manhwas,del:[]},profile:e2e.state.profile,logAdd:[]});
    });
    assert.equal(await page.locator('.mt-library-menu').getAttribute('open'),null);
    assert.equal(await page.locator('.mt-trash').isVisible(),false);
    await page.locator('#bulk-toggle').click();
    await page.locator('.mt-cover[data-open-id="v0"]').click();await page.locator('.mt-cover[data-open-id="v1"]').click();
    assert.equal(await page.evaluate(()=>e2e.state.selectedId),null);
    assert.match(await page.locator('.mt-bulk-dock summary').innerText(),/Выбрано: 2/);
    assert.equal(await page.locator('.mt-grid-card[data-bulk-selected=true]').count(),2);
    assert.equal(await page.locator('.mt-bulk-dock').evaluate(el=>getComputedStyle(el).position),'fixed');
    await page.locator('#compare-open').click();
    assert.equal(await page.locator('.mt-compare-higher').count(),5);
    assert.match(await page.locator('.mt-compare-insight').innerText(),/Фэнтези/);
    assert.equal(await page.locator('.mt-compare-sticky').evaluate(el=>getComputedStyle(el).position),'sticky');
    await page.locator('#compare-close').click();await page.locator('#bulk-done').click();
    await page.locator('.mt-cover[data-open-id="v0"]').click();
    assert.match(await page.locator('.mt-score-change').innerText(),/7 → 9/);
    await page.locator('#journal-run').selectOption('1');
    assert.match(await page.locator('.mt-run-selector p').innerText(),/20/);
    assert.equal(await page.locator('.mt-chapter-chart svg a').count(),1);
    assert.equal(await page.locator('#chapter-form').isVisible(),false);
    await page.locator('#journal-quick').click();
    assert.equal(await page.locator('#chapter-quick-dialog').evaluate(el=>el.open),true);
    assert.equal(await page.locator('#journal-run').inputValue(),'2');
    await page.locator('#chapter-number').fill('6');await page.locator('#chapter-text').fill('Черновик после закрытия');
    await page.locator('#chapter-rating').press('End');await page.locator('#chapter-spoiler').check();
    await page.locator('#chapter-sheet-close').click();
    await page.reload();await page.waitForSelector('[data-tab="library"]');await page.evaluate(()=>e2e.openTitle('v0'));
    assert.equal(await page.locator('#chapter-text').inputValue(),'Черновик после закрытия');
    assert.equal(await page.locator('#chapter-rating').inputValue(),'10');
    assert.equal(await page.locator('#chapter-spoiler').isChecked(),true);
    await page.locator('#chapter-draft-continue').click();
    await page.screenshot({path:path.join(root,'test-results','polish-chapter-sheet.png'),animations:'disabled'});
    await page.locator('#chapter-form button[type=submit]').click();
    assert.equal(await page.locator('#chapter-quick-dialog').evaluate(el=>el.open),false);
    assert.equal(await page.locator('#chapter-text').inputValue(),'');
    await page.locator('#chapter-text').fill('Удалить этот черновик');await page.locator('#chapter-draft-discard').click();
    assert.equal(await page.locator('#chapter-text').inputValue(),'');
    await page.locator('#back-btn').click();await page.locator('[data-tab="profile"]').click();await page.locator('#showcase-edit').click();
    await page.locator('.mt-showcase-editor>summary').click();
    for(let i=0;i<3;i++)await page.locator('[data-showcase-title="'+i+'"]').selectOption('v'+i);
    assert.equal(await page.locator('#showcase-preview .mt-showcase-books button').count(),3);
    await page.locator('[data-showcase-move="0"][data-direction="1"]').click();
    assert.equal(await page.locator('[data-showcase-title="0"]').inputValue(),'v1');
    assert.equal(await page.locator('#showcase-preview .mt-showcase-books strong').first().innerText(),'Второй');
    assert.equal(await page.evaluate(()=>e2e.state.profile.library.showcase.titles.length),0,'preview does not save');
    await page.locator('#prof-save').click();
    assert.equal(await page.locator('.mt-showcase-books strong').first().innerText(),'Второй');
    await page.evaluate(()=>{e2e.state.totalXp=1000;e2e.render();});await page.locator('#shop-open').click();
    const item=await page.locator('[data-shop-purchase]:not([disabled])').first().getAttribute('data-shop-purchase');
    await page.locator('[data-shop-preview="'+item+'"]').click();
    assert.equal(await page.evaluate(id=>!!e2e.state.shop[id],item),false);
    await page.locator('[data-shop-purchase="'+item+'"]').click();
    assert.equal(await page.evaluate(id=>!!e2e.state.shop[id],item),true);
    assert.equal(await page.locator('[data-shop-purchase="'+item+'"]').count(),0);
    assert.equal(await page.locator('.mt-shop-owned').count(),1);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'shop width '+width);
      await page.locator('#shop-back').click();await page.locator('[data-tab="library"]').click();await page.locator('#bulk-toggle').click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'library width '+width);
      await page.locator('#bulk-done').click();await page.locator('[data-tab="profile"]').click();await page.locator('#shop-open').click();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: compact shelves, cover selection, fixed actions, reading passes, persistent drafts, sheet, comparison and live showcase');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});

