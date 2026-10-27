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


    async function expand(selector){const el=page.locator(selector);if(await el.getAttribute('open')===null)await el.locator(':scope > summary').click();}
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

    await page.evaluate(()=>{for(let i=3;i<30;i++){const m=e2e.newManhwa('История '+i);m.id='v'+i;m.rated=true;e2e.state.manhwas.push(m);}e2e.render();});
    const cover=page.locator('.mt-cover[data-open-id="v0"]');
    await cover.dispatchEvent('pointerdown',{button:0,clientX:10,clientY:10});
    await page.waitForTimeout(650);
    assert.equal(await page.locator('#title-quick-dialog').evaluate(el=>el.open),true);
    await cover.dispatchEvent('pointerup');await page.locator('#quick-close').click();
    await page.locator('#library-layout').click();
    assert.equal(await page.locator('.mt-library-list').count(),1);
    await page.locator('[data-quick-title="v0"]').click();
    await page.locator('#quick-next').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].reading.chapter),6);
    await page.locator('[data-quick-title="v0"]').click();await page.locator('#quick-rate').click();
    assert.equal(await page.locator('#chapter-quick-dialog').evaluate(el=>el.open),true);
    await page.locator('#chapter-sheet-close').click();
    await page.locator('[data-detail-section="info"]').click();
    assert.equal(await page.locator('[data-detail-panel="info"]').isVisible(),true);
    assert.equal(await page.locator('[data-detail-panel="journal"]').isVisible(),false);
    await page.locator('[data-detail-section="rating"]').click();
    assert.equal(await page.locator('.mt-radar-panel').isVisible(),true);
    await page.screenshot({path:path.join(root,'test-results','usability-detail.png'),animations:'disabled'});
    await page.locator('#back-btn').click();
    await page.locator('.mt-cover[data-open-id="v20"]').scrollIntoViewIfNeeded();
    const before=await page.evaluate(()=>scrollY);
    await page.locator('.mt-cover[data-open-id="v20"]').click();
    await page.locator('#back-btn').click();
    await page.waitForTimeout(200);
    assert.ok(Math.abs(await page.evaluate(()=>scrollY)-before)<10,'return to same scroll');
    await page.locator('[data-tab="journey"]').click();await page.locator('[data-journey-section="goals"]').click();
    await page.reload();await page.waitForSelector('[data-tab="journey"]');await page.locator('[data-tab="journey"]').click();
    assert.equal(await page.locator('[data-journey-section="goals"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-tab="profile"]').click();await page.locator('#prof-edit').click();
    await page.locator('#prof-nick').fill('Новый читатель');
    await page.locator('[data-tab="library"]').click();
    assert.equal(await page.locator('#profile-leave-dialog').evaluate(el=>el.open),true);
    await page.locator('#leave-stay').click();assert.equal(await page.locator('#prof-nick').inputValue(),'Новый читатель');
    await page.locator('[data-tab="library"]').click();await page.locator('#leave-save').click();
    await page.waitForSelector('#library-layout');assert.equal(await page.evaluate(()=>e2e.state.profile.n),'Новый читатель');
    await page.locator('[data-tab="profile"]').click();await page.locator('#prof-edit').click();
    await page.locator('#prof-nick').fill('Отменить');await page.locator('#prof-cancel').click();await page.locator('#leave-discard').click();
    assert.equal(await page.evaluate(()=>e2e.state.profile.n),'Новый читатель');
    await page.locator('#prof-edit').click();
    assert.equal(await page.locator('[data-style-value=""]').count(),3);
    const choice=page.locator('[data-style-value]:not([data-style-value=""])').first();
    const styleValue=await choice.getAttribute('data-style-value');
    await choice.click();assert.equal(await page.evaluate(()=>e2e.state.profileDraft.style.theme),styleValue);
    await page.locator('[data-style-kind="theme"][data-style-value=""]').click();
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'studio width '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(root,'test-results','usability-studio.png'),fullPage:true,animations:'disabled'});
    await page.locator('#prof-cancel').click();await page.locator('[data-tab="library"]').click();
    await page.screenshot({path:path.join(root,'test-results','usability-list.png'),fullPage:false});
    await page.locator('[data-tab="catalog"]').click();await page.waitForSelector('[data-catalog-detail="102"]');
    await page.locator('[data-catalog-detail="102"]').click();
    await page.locator('#catalog-add-collection').selectOption('c');
    await page.locator('#catalog-add').click();assert.ok(await page.evaluate(()=>e2e.state.manhwas.find(m=>m.anilistId===102).collectionIds.includes('c')));
    await page.locator('#catalog-back').click();await page.locator('#catalog-hide-owned').check();
    assert.equal(await page.locator('[data-catalog-detail="102"]').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: quick actions, list, detail panels, return scroll, journey memory, save/discard guard, visual styles, catalog collection and hide owned');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
