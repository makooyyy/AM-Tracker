const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'..');let revision='first';
  const server=http.createServer((req,res)=>{
    const name=req.url.split('?')[0].replace(/^\//,'')||'index.html';
    if(name.includes('..')){res.writeHead(400).end();return;}
    const file=path.join(root,name);if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    let body=fs.readFileSync(file);res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.json':'application/json'})[path.extname(file)]||'application/octet-stream');
    if(name==='sync.js')body='';
    if(name==='app.js')body=body.toString().replace('/* ---------- boot ---------- */',`window.e2e={state,render,newManhwa,save,saveXp,libraryUI,uiSettings,openTitle,catalog,loadCatalog,buyShopItem,Features,applyAppUpdate,patchDataStatus}; /* ---------- boot ---------- */`);
    if(name==='service-worker.js')body=body.toString().replace('manhwa-tracker-v127','test-everyday-'+revision);
    res.end(body);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.abort());
    const base=`http://127.0.0.1:${server.address().port}`;await page.goto(base);await page.waitForSelector('#data-status');
    await page.evaluate(()=>{const m=e2e.newManhwa('Очень длинное русское название истории о путешествиях между мирами');m.id='local';m.status='reading';m.genres=['Фэнтези'];m.collectionIds=['shelf'];e2e.state.manhwas=[m];e2e.state.profile.library={collections:[{id:'shelf',name:'Избранные истории'}],trash:[]};e2e.state.searchQuery='нет совпадений';e2e.state.filterStatus='reading';e2e.state.filterGenre='Фэнтези';e2e.libraryUI.collection='shelf';e2e.save();e2e.render();});
    await page.getByText('Ничего не найдено',{exact:true}).waitFor();assert.equal(await page.locator('[data-library-clear]').count(),5);
    for(const appearance of ['classic','halloween'])for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});await page.evaluate(a=>{e2e.uiSettings.appearance=a;e2e.render();},appearance);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(root,'test-results',`everyday-filters-${appearance}-${width}.png`),animations:'disabled'});
    }
    await page.locator('[data-library-clear="all"]').click();assert.equal(await page.locator('[data-library-clear]').count(),0);await page.locator('[data-open-id="local"]').first().waitFor();
    await page.waitForFunction(()=>document.getElementById('data-status').textContent==='Сохранено на устройстве');
    await page.evaluate(()=>{window.AMSync={getStatus:()=>({signedIn:true,phase:'idle',pending:2,lastSync:Date.now()})};e2e.patchDataStatus();});
    assert.match(await page.locator('#data-status').innerText(),/Есть изменения для отправки/);await page.evaluate(()=>delete window.AMSync);
    await page.evaluate(()=>e2e.openTitle('local'));await page.locator('[data-detail-section="journal"]').click();await page.locator('#journal-quick').click();await page.locator('#chapter-number').fill('12');await page.locator('#chapter-text').fill('Сохранённый черновик');await page.locator('#chapter-sheet-close').click();await page.reload();await page.waitForSelector('#data-status');await page.evaluate(()=>e2e.openTitle('local'));await page.locator('[data-detail-section="journal"]').click();assert.equal(await page.locator('#journal-quick').innerText(),'Продолжить черновик');
    await page.locator('#journal-quick').click();assert.equal(await page.locator('#chapter-text').inputValue(),'Сохранённый черновик');await page.locator('#chapter-form button[type="submit"]').click();await page.locator('[data-journal-delete]').waitFor();
    let deletion='';page.once('dialog',async d=>{deletion=d.message();await d.accept();});await page.locator('[data-journal-delete]').click();assert.match(deletion,/главы 12/);await page.locator('#extras-undo').click();assert.equal(await page.locator('[data-journal-delete]').count(),1);
    const item=await page.evaluate(()=>{e2e.state.selectedId=null;e2e.state.tab='profile';e2e.state.shopOpen=true;e2e.state.totalXp=10000;e2e.saveXp();const item=e2e.Features.shopItems.find(i=>!i.exclusive&&!i.eventOnly&&i.kind==='theme');e2e.buyShopItem(item.id);e2e.state.shopPreview=item.id;e2e.render();return item;});
    assert.match(await page.locator('.mt-preview-composition').innerText(),new RegExp(item.name));await page.locator('#shop-edit-profile').click();assert.equal(await page.evaluate(()=>e2e.state.profileDraft.style.theme),item.id);await page.locator('#prof-save').click();await page.waitForSelector('#prof-edit');await page.reload();await page.waitForSelector('#data-status');assert.equal(await page.evaluate(()=>e2e.state.profile.style.theme),item.id);
    let fail=true,queries=[];await page.route('https://graphql.anilist.co',r=>{queries.push(r.request().postDataJSON().variables);return fail?r.fulfill({status:503,body:'{}'}):r.fulfill({contentType:'application/json',body:JSON.stringify({data:{Page:{pageInfo:{hasNextPage:false},media:[]}}})});});
    await page.locator('[data-tab="catalog"]').click();await page.locator('#catalog-search').fill('My story');await page.locator('#catalog-search-form').evaluate(el=>el.requestSubmit());await page.locator('#catalog-retry').waitFor();fail=false;await page.locator('#catalog-retry').click();await page.getByText('Эта история пока не нашлась',{exact:true}).waitFor();assert.equal(queries.at(-1).search,'My story');await page.reload();await page.waitForSelector('#data-status');await page.locator('[data-tab="catalog"]').click();assert.equal(await page.locator('#catalog-search').inputValue(),'My story');
    await page.locator('[data-tab="awards"]').click();assert.match(await page.locator('.mt-award-help').innerText(),/одна правка|правка.*использована/i);
    for(const appearance of ['classic','halloween'])for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});await page.evaluate(a=>{e2e.uiSettings.appearance=a;e2e.render();},appearance);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    assert.deepEqual(errors,[]);await context.close();
    // Real service worker update, isolated origin and data; no Firebase account.
    const pwa=await browser.newContext({serviceWorkers:'allow'}),p=await pwa.newPage();await p.goto(base);await p.waitForSelector('#data-status');await p.evaluate(()=>navigator.serviceWorker.ready);await p.reload();await p.waitForFunction(()=>navigator.serviceWorker.controller);
    await p.evaluate(()=>{e2e.state.manhwas=[e2e.newManhwa('Сохраняется при обновлении')];e2e.save();});await p.waitForFunction(()=>document.getElementById('data-status').textContent==='Сохранено на устройстве');
    revision='second';await p.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});await p.locator('#apply-update').waitFor({timeout:30000});
    await p.evaluate(()=>{e2e.state.addingManhwa=true;});await p.locator('#apply-update').click();assert.match(await p.locator('#update-notice').innerText(),/Сначала закончи ввод/);await p.evaluate(()=>{e2e.state.addingManhwa=false;});
    await Promise.all([p.waitForEvent('load'),p.locator('#apply-update').click()]);await p.waitForSelector('#data-status');assert.equal(await p.evaluate(()=>e2e.state.manhwas[0].title),'Сохраняется при обновлении');assert.equal(await p.locator('#apply-update').count(),0);
    await pwa.close();console.log('PASS: filters, both appearances and widths, save status, diary reload/undo, shop persistence, catalog retry/reload, awards help, real PWA update');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
