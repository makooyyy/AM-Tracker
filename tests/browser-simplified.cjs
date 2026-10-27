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

    assert.equal(await page.locator('[data-quick-title],#title-quick-dialog,.mt-menu-reading').count(),0);
    const cover=page.locator('.mt-cover[data-open-id="v0"]');
    await cover.dispatchEvent('pointerdown',{button:0,clientX:10,clientY:10});
    await page.waitForTimeout(650);await cover.dispatchEvent('pointerup');
    assert.equal(await page.locator('#title-quick-dialog').count(),0);
    await cover.click();
    assert.equal(await page.locator('[data-detail-section]').count(),2);
    assert.equal(await page.locator('[data-detail-section="rating"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-detail-section="info"],#reading-form,#reading-url,[data-reading-next]').count(),0);
    assert.equal(await page.locator('.mt-title-tools').isVisible(),true);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'detail width '+width);
      const radar=await page.locator('.mt-radar-panel').boundingBox();
      const bars=await page.locator('.mt-criteria-panel').boundingBox();
      assert.ok(bars.y-radar.y-radar.height>=16,'rating panels need spacing');
      assert.ok(Math.abs(bars.width-radar.width)<1,'matching panel widths');
      assert.ok(await page.locator('.mt-criteria-panel .mt-bar-row').evaluateAll(rows=>rows.every(row=>{
        const name=row.querySelector('.mt-bar-name').getBoundingClientRect(),track=row.querySelector('.mt-bar-track').getBoundingClientRect();
        return name.bottom<=track.top;
      })),'labels do not overlap bars');
      const copy=await page.locator('#copy-scores-btn').boundingBox(),share=await page.locator('#share-rating-card').boundingBox();
      assert.ok(Math.abs(copy.width-share.width)<1,'matching button widths');
      assert.ok(share.y-copy.y-copy.height>=16,'button spacing');
      await page.locator('.mt-criteria-panel').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(root,'test-results','simplified-rating-'+width+'.png'),animations:'disabled'});
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-detail-section="journal"]').click();
    await page.locator('#journal-quick').click();
    await page.locator('#chapter-number').fill('7');await page.locator('#chapter-rating').press('End');
    await page.locator('#chapter-form button[type=submit]').click();
    assert.ok(await page.evaluate(()=>e2e.state.manhwas[0].journal.some(e=>e.chapter===7&&e.rating===10)));
    await page.locator('#back-btn').click();await page.locator('.mt-cover[data-open-id="v0"]').click();
    assert.equal(await page.locator('[data-detail-section="rating"]').getAttribute('aria-pressed'),'true');
    await page.locator('#back-btn').click();
    await expand('.mt-library-menu');await page.locator('#compare-open').click();
    await page.locator('[data-compare-pick="0"]').selectOption('v0');await page.locator('[data-compare-pick="1"]').selectOption('v1');
    assert.equal(await page.locator('.mt-compare-higher').count(),5);
    assert.equal(await page.locator('[data-duel-winner]').count(),0);
    await page.locator('#compare-close').click();
    await page.evaluate(()=>localStorage.setItem('mt-usability-v1',JSON.stringify({journey:'discover'})));
    await page.reload();await page.waitForSelector('[data-tab="journey"]');
    await page.locator('[data-tab="journey"]').click();
    assert.deepEqual(await page.locator('[data-journey-section]').evaluateAll(els=>els.map(e=>e.dataset.journeySection)),['achievements','goals','halloween']);
    assert.equal(await page.locator('[data-journey-section="achievements"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-journey-section="goals"]').click();assert.ok(await page.locator('[data-goal-add]').count()>0);
    await page.locator('[data-journey-section="halloween"]').click();assert.equal(await page.locator('.mt-halloween').count(),1);
    await page.locator('[data-tab="profile"]').click();assert.equal(await page.locator('.mt-showcase,#showcase-edit').count(),0);
    await page.locator('#prof-edit').click();assert.equal(await page.locator('.mt-showcase-editor,#showcase-save').count(),0);
    await page.locator('#prof-nick').fill('Мой профиль');await page.locator('#prof-save').click();await page.waitForSelector('#prof-edit');
    await page.reload();await page.waitForSelector('[data-tab="profile"]');await page.locator('[data-tab="profile"]').click();
    assert.equal(await page.evaluate(()=>e2e.state.profile.n),'Мой профиль');
    assert.deepEqual(errors,[]);
    console.log('PASS: removed surfaces, rating default, two panels, aligned rating layout, diary save, comparison, journey migration, profile save');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
