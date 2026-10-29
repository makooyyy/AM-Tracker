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
    if(name==='app.js')body=body.toString().replace('/* ---------- boot ---------- */',`window.e2e={state,render,newManhwa,save,saveXp,libraryUI,uiSettings,setAppearance:function(a){uiSettings.appearance=a;},openTitle,catalog,loadCatalog,buyShopItem,Features,applyAppUpdate,patchDataStatus}; /* ---------- boot ---------- */`);
    if(name==='service-worker.js')body=body.toString().replace(/manhwa-tracker-v\d+/,'test-everyday-'+revision);
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
      await page.setViewportSize({width,height:844});await page.evaluate(a=>{e2e.setAppearance(a);e2e.render();},appearance);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(root,'test-results',`everyday-filters-${appearance}-${width}.png`),animations:'disabled'});
    }
    await page.locator('[data-library-clear="all"]').click();assert.equal(await page.locator('[data-library-clear]').count(),0);await page.locator('[data-open-id="local"]').first().waitFor();
    await page.waitForFunction(()=>document.getElementById('data-status').textContent==='Сохранено на устройстве');
    await page.evaluate(()=>{window.AMSync={getStatus:()=>({signedIn:true,phase:'idle',pending:2,lastSync:Date.now()})};e2e.patchDataStatus();});
    assert.match(await page.locator('#data-status').innerText(),/Есть изменения для отправки/);await page.evaluate(()=>delete window.AMSync);
    await page.evaluate(()=>e2e.openTitle('local'));await page.locator('[data-detail-section="journal"]').click();await page.locator('#journal-quick').click();await page.locator('#chapter-number').fill('12');await page.locator('#chapter-text').fill('Сохранённый черновик');await page.locator('#chapter-sheet-close').click();await page.reload();await page.waitForSelector('#data-status');await page.evaluate(()=>e2e.openTitle('local'));await page.locator('[data-detail-section="journal"]').click();assert.equal(await page.locator('#journal-quick').innerText(),'Продолжить черновик');
    await page.locator('#journal-quick').click();assert.equal(await page.locator('#chapter-text').inputValue(),'Сохранённый черновик');await page.locator('#chapter-form button[type="submit"]:not([name])').click();await page.locator('#chapter-quick-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#journal-records').isVisible(),false);await page.locator('#journal-records-toggle').click();await page.locator('[data-journal-delete]').waitFor();
    let deletion='';page.once('dialog',async d=>{deletion=d.message();await d.accept();});await page.locator('[data-journal-delete]').click();assert.match(deletion,/главы 12/);await page.locator('#extras-undo').click();assert.equal(await page.locator('[data-journal-delete]').count(),1);
    async function setScore(n){await page.locator('#chapter-rating').press('Home');for(let i=0;i<n;i++)await page.locator('#chapter-rating').press('ArrowRight');}
    // Score with the slider, save a sequence, then reject a duplicate.
    await page.locator('#journal-quick').click();await page.locator('#chapter-number').fill('13');await setScore(8);
    assert.equal(await page.locator('#chapter-rating').inputValue(),'8');
    const moods=[];for(let n=1;n<=10;n++){await setScore(n);moods.push(await page.locator('.mt-chapter-mood').innerText());}assert.equal(new Set(moods).size,10);await setScore(8);
    await page.locator('.mt-quick-notes summary').click();await page.locator('[data-quick-note="0"]').click();await page.locator('[data-quick-note="1"]').click();await page.locator('[data-quick-note="0"]').click();assert.equal(await page.locator('#chapter-text').inputValue(),'Раскрытие прошлого ГГ\nНичего не произошло');
    await page.locator('#chapter-form button[name="next"]').click();
    await page.waitForFunction(()=>document.getElementById('chapter-number').value==='14');
    assert.equal(await page.locator('#chapter-rating').inputValue(),'0');assert.equal(await page.locator('#chapter-text').inputValue(),'');
    await page.locator('#chapter-number').fill('13');await setScore(10);
    assert.match(await page.locator('#chapter-existing').innerText(),/уже есть оценка 8/);
    await page.locator('#chapter-form button[type="submit"]:not([name])').click();assert.match(await page.locator('#chapter-error').innerText(),/уже есть оценка/);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.filter(e=>e.chapter===13).length),1);
    await page.locator('[data-chapter-score="0"]').click();await page.locator('#chapter-text').fill('Ещё одна заметка со спойлером');await page.locator('#chapter-spoiler').check();
    await page.locator('#chapter-form button[type="submit"]:not([name])').click();await page.locator('#chapter-quick-dialog').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.filter(e=>e.chapter===13).length),2);
    await page.reload();await page.waitForSelector('#data-status');await page.evaluate(()=>e2e.openTitle('local'));await page.locator('[data-detail-section="journal"]').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.find(e=>e.chapter===13&&e.rating).rating),8);
    assert.equal(await page.locator('#journal-list details[open]').count(),0);
    assert.equal(await page.locator('#journal-records').isVisible(),false);assert.equal(await page.locator('.mt-chapter-chart').isVisible(),true);
    assert.equal(await page.evaluate(()=>e2e.state.manhwas[0].journal.find(e=>e.chapter===13&&e.rating).text),'Раскрытие прошлого ГГ\nНичего не произошло');
    await page.locator('[data-journal-jump]').first().click();assert.equal(await page.locator('#journal-records').isVisible(),true);await page.locator('#journal-records-toggle').click();assert.equal(await page.locator('#journal-records').isVisible(),false);
    for(const appearance of ['classic','halloween'])for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:780});await page.evaluate(a=>{e2e.setAppearance(a);e2e.render();},appearance);
      await page.locator('[data-detail-section="journal"]').click();await page.locator('#chapter-journal').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(root,'test-results',`journal-history-${appearance}-${width}.png`),animations:'disabled'});
      await page.locator('#journal-quick').click();await setScore(9);
      const dialog=await page.locator('#chapter-quick-dialog').boundingBox();assert.ok(dialog.x>=0&&dialog.x+dialog.width<=width);
      assert.equal(await page.locator('#chapter-rating').getAttribute('type'),'range');
      await page.locator('.mt-quick-notes summary').click();
      const fields=await page.locator('.mt-composer-fields').boundingBox(),footer=await page.locator('.mt-chapter-submit').boundingBox();
      assert.ok(fields.y+fields.height<=footer.y+1,'save actions never cover the scrolling form');
      assert.ok(footer.y+footer.height<=780,'save actions remain inside the viewport');
      assert.ok(await page.locator('#chapter-quick-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
      await page.screenshot({path:path.join(root,'test-results',`journal-composer-${appearance}-${width}.png`),animations:'disabled'});
      await page.locator('#chapter-sheet-close').click();
    }
    const item=await page.evaluate(()=>{e2e.state.selectedId=null;e2e.state.tab='profile';e2e.state.shopOpen=true;e2e.state.totalXp=10000;e2e.saveXp();const item=e2e.Features.shopItems.find(i=>!i.exclusive&&!i.eventOnly&&i.kind==='theme');e2e.buyShopItem(item.id);e2e.state.shopPreview=item.id;e2e.render();return item;});
    assert.match(await page.locator('.mt-preview-composition').innerText(),new RegExp(item.name));await page.locator('#shop-edit-profile').click();assert.equal(await page.evaluate(()=>e2e.state.profileDraft.style.theme),item.id);await page.locator('#prof-save').click();await page.waitForSelector('#prof-edit');await page.reload();await page.waitForSelector('#data-status');assert.equal(await page.evaluate(()=>e2e.state.profile.style.theme),item.id);
    let fail=true,queries=[];await page.route('https://graphql.anilist.co',r=>{queries.push(r.request().postDataJSON().variables);return fail?r.fulfill({status:503,body:'{}'}):r.fulfill({contentType:'application/json',body:JSON.stringify({data:{Page:{pageInfo:{hasNextPage:false},media:[]}}})});});
    await page.locator('[data-tab="catalog"]').click();await page.locator('#catalog-search').fill('My story');await page.locator('#catalog-search-form').evaluate(el=>el.requestSubmit());await page.locator('#catalog-retry').waitFor();fail=false;await page.locator('#catalog-retry').click();await page.getByText('Эта история пока не нашлась',{exact:true}).waitFor();assert.equal(queries.at(-1).search,'My story');await page.reload();await page.waitForSelector('#data-status');await page.locator('[data-tab="catalog"]').click();assert.equal(await page.locator('#catalog-search').inputValue(),'My story');
    await page.locator('[data-tab="awards"]').click();assert.match(await page.locator('.mt-award-help').innerText(),/одна правка|правка.*использована/i);
    for(const appearance of ['classic','halloween'])for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});await page.evaluate(a=>{e2e.setAppearance(a);e2e.render();},appearance);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    assert.deepEqual(errors,[]);await context.close();
    // Real service worker update, isolated origin and data; no Firebase account.
    const pwa=await browser.newContext({serviceWorkers:'allow'}),p=await pwa.newPage();await p.goto(base);await p.waitForSelector('#data-status');await p.evaluate(()=>navigator.serviceWorker.ready);await p.reload();await p.waitForFunction(()=>navigator.serviceWorker.controller);
    await p.evaluate(()=>{e2e.state.manhwas=[e2e.newManhwa('Сохраняется при обновлении')];e2e.save();});await p.waitForFunction(()=>document.getElementById('data-status').textContent==='Сохранено на устройстве');
    revision='second';await p.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});await p.locator('#apply-update').waitFor({timeout:30000});
    await p.evaluate(()=>{e2e.state.addingManhwa=true;});await p.locator('#apply-update').click();assert.match(await p.locator('#update-notice').innerText(),/Сначала закончи ввод/);await p.evaluate(()=>{e2e.state.addingManhwa=false;});
    for(const appearance of ['classic','halloween'])for(const width of [320,390,1280]){
      await p.setViewportSize({width,height:720});
      await p.evaluate(a=>{e2e.setAppearance(a);e2e.render();window.scrollTo(0,document.documentElement.scrollHeight);},appearance);
      const notice=await p.locator('.mt-update-notice').boundingBox(),button=await p.locator('#apply-update').boundingBox(),nav=await p.locator('.mt-tabbar').boundingBox();
      assert.ok(button.y>=0&&button.y+button.height<=720,'update button is fully visible');
      if(width<850)assert.ok(notice.y+notice.height<=nav.y,'entire update notice clears bottom navigation');
      else assert.ok(notice.x>=nav.x+nav.width,'update notice clears desktop sidebar');
      await p.screenshot({path:path.join(root,'test-results',`update-notice-${appearance}-${width}.png`),animations:'disabled'});
    }
    await Promise.all([p.waitForEvent('load'),p.locator('#apply-update').click()]);await p.waitForSelector('#data-status');assert.equal(await p.evaluate(()=>e2e.state.manhwas[0].title),'Сохраняется при обновлении');assert.equal(await p.locator('#apply-update').count(),0);
    await pwa.close();console.log('PASS: filters, both appearances and widths, save status, diary reload/undo, shop persistence, catalog retry/reload, awards help, real PWA update');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
