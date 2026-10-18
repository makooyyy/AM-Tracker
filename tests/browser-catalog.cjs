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
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://**/*',r=>r.abort());
    const calls=[];let failure=false;
    function media(id,name){return {id,title:{english:name||'Story '+id,native:'原作'},synonyms:[],countryOfOrigin:'KR',genres:['Fantasy'],averageScore:85,chapters:120,volumes:null,status:'FINISHED',description:'<b>A story</b><br>Second line<script>window.injected=true</script>',coverImage:{large:'/icons/icon-192.png'}};}
    await page.route('https://graphql.anilist.co',async route=>{
      const data=route.request().postDataJSON();calls.push(data.variables);
      if(failure)return route.fulfill({status:429,headers:{'Retry-After':'60'},body:'{}'});
      const v=data.variables;
      if(v.search==='slow')await new Promise(r=>setTimeout(r,500));
      const items=v.search==='empty'?[]:v.search?[media(v.search==='slow'?999:800,v.search)]:v.page===1?Array.from({length:24},(_,i)=>media(i+1)):[media(24),media(25)];
      await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{Page:{pageInfo:{hasNextPage:!v.search&&v.page===1},media:items}}})});
    });
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.locator('[data-tab="catalog"]').click();
    await page.waitForSelector('[data-catalog-detail="1"]');
    assert.equal(await page.locator('#catalog-filter-panel').isVisible(),false);
    assert.match(await page.locator('[data-catalog-detail="1"] .mt-catalog-score').innerText(),/8\.5/);
    assert.equal(await page.locator('[data-tab]').count(),5);
    for(const width of [320,390,768,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'catalog width '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(root,'test-results','catalog.png'),animations:'disabled'});
    await page.locator('[data-catalog-detail="1"]').click();
    assert.match(await page.locator('.mt-catalog-description').innerText(),/A story/);
    assert.equal(await page.evaluate(()=>!!window.injected),false);
    await page.locator('#catalog-add-status').selectOption('done');
    await page.locator('#catalog-add').click();
    assert.equal(await page.locator('#catalog-add').count(),0);
    const saved=await page.evaluate(()=>e2e.state.manhwas.find(m=>m.anilistId===1));
    assert.equal(saved.status,'done');assert.ok(saved.completedAt);assert.equal(saved.rated,false);
    assert.deepEqual(saved.genres,['Фэнтези']);assert.equal(saved.catalogInfo.chapters,120);
    await page.screenshot({path:path.join(root,'test-results','catalog-detail.png'),animations:'disabled'});
    await page.locator('#catalog-back').click();
    assert.match(await page.locator('[data-catalog-detail="1"]').innerText(),/В библиотеке/);
    await page.locator('#catalog-more').scrollIntoViewIfNeeded();
    await page.waitForSelector('[data-catalog-detail="25"]');
    assert.equal(await page.locator('[data-catalog-detail="24"]').count(),1);
    assert.ok(calls.some(v=>v.page===2));
    await page.locator('#catalog-filter-toggle').click();
    await page.locator('#catalog-country').selectOption('CN');
    await page.waitForSelector('[data-catalog-detail="1"]');
    assert.equal(calls.at(-1).country,'CN');assert.equal(calls.at(-1).page,1);
    await page.locator('#catalog-genre').selectOption('Fantasy');
    await page.waitForSelector('[data-catalog-detail="1"]');
    await page.locator('#catalog-status').selectOption('FINISHED');
    await page.waitForSelector('[data-catalog-detail="1"]');
    assert.equal(calls.at(-1).genre,'Fantasy');assert.equal(calls.at(-1).status,'FINISHED');
    assert.equal(await page.locator('[data-catalog-clear]').count(),3);
    await page.locator('#catalog-filters-done').click();
    assert.equal(await page.locator('#catalog-filter-panel').isVisible(),false);
    await page.locator('[data-catalog-clear="country"]').click();
    await page.waitForSelector('[data-catalog-detail="1"]');
    assert.equal(calls.at(-1).country,null);
    await page.locator('#catalog-filter-toggle').click();
    await page.locator('#catalog-reset').click();
    await page.waitForSelector('[data-catalog-detail="1"]');
    assert.equal(await page.locator('[data-catalog-clear]').count(),0);
    await page.locator('#catalog-search').fill('slow');await page.locator('#catalog-search-form').evaluate(f=>f.requestSubmit());
    await page.locator('#catalog-search').fill('fast');await page.locator('#catalog-search-form').evaluate(f=>f.requestSubmit());
    await page.waitForSelector('[data-catalog-detail="800"]');
    await page.waitForTimeout(600);assert.equal(await page.locator('[data-catalog-detail="999"]').count(),0);
    await page.locator('#catalog-search').fill('empty');await page.locator('#catalog-search-form').evaluate(f=>f.requestSubmit());
    await page.waitForFunction(()=>document.querySelector('.mt-catalog-message')?.textContent.includes('пока не нашлась'));
    failure=true;await page.locator('#catalog-search').fill('error');await page.locator('#catalog-search-form').evaluate(f=>f.requestSubmit());
    await page.waitForSelector('#catalog-retry');
    const count=calls.length;await page.locator('#catalog-retry').click();assert.equal(calls.length,count);
    await page.reload();await page.locator('[data-tab="library"]').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.filter(m=>m.anilistId===1).length),1);
    assert.deepEqual(errors,[]);
    console.log('PASS catalog: pagination, filters, add/reload, duplicate protection, stale requests, safe description, rate limit, responsive layout');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});

