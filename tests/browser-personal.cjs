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
    async function expand(selector){const el=page.locator(selector);if(await el.getAttribute('open')===null)await el.locator(':scope > summary').click();}
    async function collections(){await expand('.mt-library-menu');await expand('.mt-collection-tools');}
    await page.evaluate(()=>{
      e2e.state.manhwas=['Первый тайтл','Вторая история'].map((name,i)=>{
        const m=e2e.newManhwa(name);m.id='p'+i;m.rated=true;m.genres=['Фэнтези'];m.lastRatedAt=Date.now();m.criteria.forEach(c=>c.score=8-i);
        m.journal=[{id:'old'+i,chapter:12,ts:Date.now(),rating:9,text:'Скрытый поворот',spoiler:true}];return m;
      });e2e.render();
    });
    await collections();
    await page.locator('#collection-name').fill('Любимое');
    await page.locator('#collection-create button').click();
    const collection=await page.locator('#collection-filter option').nth(1).getAttribute('value');
    await collections();
    await page.locator('[data-collection-name]').fill('Любимые истории');
    await page.locator('[data-collection-rename]').click();
    assert.equal(await page.locator('#collection-filter option').nth(1).innerText(),'Любимые истории');
    await page.locator('#bulk-toggle').click();
    await expand('.mt-bulk-dock>details');await page.locator('#bulk-all').click();
    await page.locator('#bulk-collection').selectOption(collection);
    await page.locator('#bulk-collection-add').click();
    await page.locator('#bulk-genre').fill('Приключения');
    await page.locator('#bulk-genre-apply').click();
    await page.locator('#bulk-status').selectOption('done');
    await page.locator('#bulk-status-apply').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.filter(m=>m.status==='done'&&m.genres.includes('Приключения')&&m.collectionIds.length===1).length),2);
    await page.locator('#compare-open').click();
    assert.equal(await page.locator('.mt-compare-covers article').count(),2);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'compare width '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(root,'test-results','personal-compare.png'),fullPage:true,animations:'disabled'});
    await page.locator('#compare-close').click();await page.locator('#bulk-toggle').click();
    await page.locator('[data-shelf="'+collection+'"]').click();
    assert.equal(await page.locator('.mt-grid-card').count(),2);
    await page.evaluate(()=>e2e.openTitle('p0'));
    await page.locator('.mt-title-tools>details>summary').click();
    await page.locator('[data-reread]').click();
    assert.equal(await page.locator('#reading-chapter').inputValue(),'0');
    assert.equal(await page.locator('#journal-list article').count(),0);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal[0].rating),9);
    await page.locator('.mt-title-tools>details>summary').click();
    await page.locator('.mt-reading-history>details>summary').click();
    assert.equal(await page.locator('.mt-reading-history article details[open]').count(),0);
    await page.locator('[data-old-entry]').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.length),0);
    await page.locator('#extras-undo').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.length),1);
    assert.equal(await page.locator('#journal-list article').count(),0);
    await page.locator('#chapter-number').fill('12');await page.locator('#chapter-rating').press('End');
    await page.locator('#chapter-form button').click();
    assert.equal(await page.locator('#journal-list article').count(),1);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.length),2);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal[1].run),2);
    await page.locator('[data-journal-delete]').click();
    await page.locator('#extras-undo').click();
    assert.equal(await page.locator('#journal-list article').count(),1);
    await page.reload();await page.waitForSelector('[data-tab="library"]');
    await page.evaluate(()=>e2e.openTitle('p0'));
    assert.equal(await page.locator('#journal-list article').count(),1);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].readingRun),2);
    await page.locator('[data-delete-id="p0"]').click();await page.locator('[data-delete-id="p0"]').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.length),1);
    await page.locator('#extras-undo').click();assert.equal(await page.evaluate(()=>e2e.state.manhwas.length),2);
    await page.locator('#bulk-toggle').click();await expand('.mt-bulk-dock>details');await page.locator('#bulk-all').click();await page.locator('#bulk-trash').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.length),0);
    await page.reload();await page.waitForSelector('[data-tab="library"]');
    await expand('.mt-library-menu');await expand('.mt-trash');
    assert.equal(await page.locator('[data-trash-restore]').count(),2);
    await page.locator('[data-trash-restore="p0"]').click();
    await expand('.mt-library-menu');await expand('.mt-trash');await page.locator('[data-trash-restore="p1"]').click();
    await page.locator('[data-tab="profile"]').click();await page.locator('#showcase-edit').click();
    await page.locator('.mt-showcase-editor>summary').click();
    await page.locator('[data-showcase-title="0"]').selectOption('p0');await page.locator('[data-showcase-title="1"]').selectOption('p1');
    await page.locator('#showcase-achievement').selectOption('first_add');await page.locator('#prof-save').click();
    assert.equal(await page.locator('.mt-showcase-books button').count(),2);
    assert.match(await page.locator('.mt-showcase-treasures').innerText(),/Первый шаг/);
    await page.reload();await page.waitForSelector('[data-tab="profile"]');await page.locator('[data-tab="profile"]').click();
    assert.equal(await page.locator('.mt-showcase-books button').count(),2);
    await page.locator('.mt-showcase').screenshot({path:path.join(root,'test-results','personal-showcase.png')});
    await page.locator('[data-tab="library"]').click();
    await collections();
    await page.locator('[data-collection-delete]').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.length),2);
    assert.ok(await page.evaluate(()=>e2e.state.manhwas.every(m=>!m.collectionIds.length)));
    await page.locator('[data-tab="profile"]').click();
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'showcase width '+width);
      await page.locator('[data-tab="library"]').click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'library width '+width);
      await page.locator('[data-tab="profile"]').click();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: collections, bulk editing, comparison, rereading, undo, persistent trash and showcase');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});

