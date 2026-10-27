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

    await page.locator('[data-tab="profile"]').click();
    await page.locator('#showcase-edit').click();
    await expand('.mt-showcase-editor');
    assert.equal(await page.locator('#showcase-preview #showcase-edit').count(),0);
    await page.locator('[data-showcase-title="2"]').selectOption('v2');
    await page.locator('[data-profile-style="theme"]').selectOption('');
    assert.equal(await page.locator('[data-showcase-title="2"]').inputValue(),'v2','empty slots survive rerender');
    await page.locator('[data-showcase-title="0"]').selectOption('v0');
    await page.locator('[data-showcase-title="1"]').selectOption('v1');
    await page.locator('#showcase-save').click();
    await page.waitForSelector('#prof-edit');
    await page.reload();await page.waitForSelector('[data-tab="profile"]');
    await page.locator('[data-tab="profile"]').click();
    assert.equal(await page.locator('.mt-showcase-books button').count(),3);
    assert.deepEqual(await page.evaluate(()=>e2e.state.profile.library.showcase.titles),['v0','v1','v2']);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'profile width '+width);
      await page.locator('.mt-showcase').screenshot({path:path.join(root,'test-results','showcase-new-'+width+'.png')});
    }
    await page.setViewportSize({width:390,height:844});await page.locator('#showcase-edit').click();
    await expand('.mt-showcase-editor');
    await page.locator('[data-showcase-title="0"]').selectOption('');
    await page.locator('#prof-cancel').click();
    assert.equal(await page.locator('.mt-showcase-books button').count(),3);
    await page.locator('#prof-edit').click();
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'editor width '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(root,'test-results','profile-studio.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: explicit showcase save, reload, cancel, empty slots, noninteractive preview, responsive profile studio');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
