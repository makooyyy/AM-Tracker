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
    assert.equal(await page.locator('.mt-season-header,.mt-header .mt-brand').count(),1);
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
    assert.equal(await page.locator('.mt-continue-card').count(),6);
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
    await page.locator('.mt-library-menu > summary').click();
    await page.locator('.mt-menu-reading > summary').click();
    await page.locator('.mt-continue-card[data-open-id="sample"]').click();
    await page.locator('[data-detail-section="rating"]').click();await page.waitForSelector('#compare-from');
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
      await page.locator(`[data-tab="${tab === 'achievements' ? 'journey' : tab}"]`).click();
      if(tab === 'achievements') await page.locator('[data-journey-section="achievements"]').click();
      if (tab === 'achievements') {
        await page.evaluate(() => { e2e.state.unlockedAchievements = {first_add:Date.now(),first_rated:Date.now()-1000,genres_5:Date.now()-2000}; e2e.render(); });
        await page.locator('[data-achievement-filter="earned"]').click();
        assert.equal(await page.locator('.mt-achievement-grid .earned').count(),3);
        await page.locator('[data-achievement-category="Библиотека"]').click();
        assert.equal(await page.locator('.mt-achievement-grid .mt-achievement-card').count(),1);
        await page.locator('[data-achievement-filter="locked"]').click();
        assert.equal(await page.locator('.mt-achievement-grid .earned').count(),0);
        assert.match(await page.locator('.mt-achievement-grid [data-achievement-id="collect_10"]').innerText(),/6 \/ 10/);
        await page.locator('[data-achievement-category="Все категории"]').click();
        await page.locator('[data-achievement-filter="all"]').click();
      }
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
      if (tab === 'achievements') {
        await page.evaluate(() => window.scrollTo(0,0));
        await page.screenshot({animations:'disabled',path:path.join(root,'test-results','achievements-top.png')});
        await page.locator('.mt-achievement-filters').scrollIntoViewIfNeeded();
        await page.screenshot({animations:'disabled',path:path.join(root,'test-results','achievements-collection.png')});
      }
    }
    await page.evaluate(() => {e2e.state.selectedId=null;e2e.state.tab='journey';e2e.state.manhwas.forEach(m=>m.genres=['Фэнтези']);e2e.render();});
    await page.locator('[data-journey-section="discover"]').click();
    await page.locator('#discovery-add').waitFor();
    assert.equal(await page.locator('.mt-discovery-card h3').innerText(),'A New Adventure');
    assert.equal(await page.locator('.mt-discovery-card').innerText().then(t=>t.includes('Already saved')),false);
    for(const [type,country,title] of [['manhwa','KR','Another Story'],['manhua','CN','A Very Long Title: The Beginning of Another Extraordinary Adventure'],['manga','JP','A New Adventure']]) {
      const request=page.waitForRequest(r=>r.url().startsWith('https://graphql.anilist.co')&&r.method()==='POST'&&r.postDataJSON().variables.country===country);
      await page.locator('[data-discovery-type="'+type+'"]').click();
      await request;
      await page.locator('#discovery-add').waitFor();
      assert.equal(await page.locator('.mt-discovery-card h3').innerText(),title);
      assert.equal(await page.locator('[data-discovery-type="'+type+'"]').getAttribute('aria-pressed'),'true');
      for(const width of [320,390,1280]){
        await page.setViewportSize({width,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'discovery type overflow '+width);
        assert.equal(await page.locator('.mt-discovery-actions').evaluate(el=>el.getBoundingClientRect().top>=el.parentElement.querySelector('.mt-discovery-copy').getBoundingClientRect().bottom),true,'buttons below description');
      }
      await page.setViewportSize({width:390,height:844});
      if(type==='manhua')await page.screenshot({animations:'disabled',fullPage:true,path:path.join(root,'test-results','discovery-type-long-title.png')});
    }
    await page.locator('[data-discovery-type=""]').click();
    await page.locator('#discovery-add').waitFor();
    await page.locator('[data-journey-section="goals"]').click();
    await page.locator('[data-goal-add="notes10"]').click();
    assert.equal(await page.locator('.mt-goal-count').innerText(),'0 / 10');
    await page.locator('[data-journey-section="duels"]').click();
    const pairBefore=await page.locator('[data-duel-winner]').evaluateAll(els=>els.map(e=>e.dataset.duelWinner));
    await page.locator('[data-duel-winner]').first().click();
    const pairAfter=await page.locator('[data-duel-winner]').evaluateAll(els=>els.map(e=>e.dataset.duelWinner));
    assert.equal(pairAfter.some(id=>pairBefore.includes(id)),false,'both participants change');
    assert.equal(await page.locator('.mt-duel-history').getAttribute('open'),null);
    assert.equal(await page.locator('.mt-duel-ranking').count(),0);
    await page.locator('.mt-duel-history summary').click();
    assert.equal(await page.locator('.mt-duel-history li').count(),1);
    await page.locator('#duel-undo').click();
    assert.equal(await page.locator('.mt-duel-history').count(),0);
    await page.locator('[data-journey-section="discover"]').click();
    await page.locator('#journey-mood').selectOption('adventure');
    await page.locator('#discovery-add').waitFor();
    for(const section of ['discover','duels','goals']) {
      await page.locator('[data-journey-section="'+section+'"]').click();
      for(const width of [320,390,1280]) {
        await page.setViewportSize({width,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),true,section+' overflow '+width);
      }
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({animations:'disabled',path:path.join(root,'test-results','journey-'+section+'.png'),fullPage:true});
    }
    await page.locator('[data-journey-section="discover"]').click();
    await page.locator('#discovery-add').click();
    assert.equal(await page.evaluate(()=>e2e.state.manhwas.filter(m=>m.anilistId===102&&m.status==='plan').length),1);
    assert.equal(await page.locator('.mt-discovery-card h3').innerText(),'Another Story');
    catalogueFails=true;
    await page.locator('#journey-mood').selectOption('calm');
    await page.locator('#discovery-retry').waitFor();
    catalogueFails=false;
    await page.locator('#journey-mood').selectOption('adventure');
    await page.locator('#discovery-add').waitFor();
    await page.evaluate(()=>e2e.openTitle('sample'));
    await page.locator('#chapter-number').fill('74.5');
    await page.locator('#chapter-text').fill('Неожиданный поворот <script>');
    await page.locator('#chapter-rating').press('End');
    await page.locator('#chapter-rating').press('ArrowLeft');
    await page.locator('#chapter-rating').press('ArrowLeft');
    await page.locator('#chapter-spoiler').check();
    await page.locator('#chapter-form button').click();
    assert.equal(await page.locator('.mt-journal-list details').count(),1);
    assert.equal(await page.locator('.mt-journal-list details').getAttribute('open'),null);
    await page.locator('.mt-journal-list summary').click();
    assert.equal(await page.locator('.mt-journal-list p').innerText(),'Неожиданный поворот <script>');
    assert.equal(await page.locator('.mt-journal-list input').count(),0,'saved ratings are read-only');
    const titleScore=await page.evaluate(()=>e2e.average(e2e.state.manhwas.find(m=>m.id==='sample').criteria));
    await page.locator('#chapter-number').fill('75');
    await page.locator('#chapter-form button').click();
    assert.equal(await page.locator('#chapter-error').innerText(),'Поставь оценку или напиши заметку.');
    await page.locator('#chapter-rating').press('End');
    await page.locator('#chapter-rating').press('ArrowLeft');
    assert.equal(await page.locator('#chapter-form .mt-chapter-slider output').innerText(),'9 / 10');
    await page.locator('#chapter-form button').click();
    assert.equal(await page.locator('.mt-saved-chapter-rating strong').first().innerText(),'9 / 10');
    assert.equal(await page.locator('.mt-saved-chapter-rating strong').first().innerText(),'9 / 10');
    assert.equal(await page.evaluate(()=>e2e.average(e2e.state.manhwas.find(m=>m.id==='sample').criteria)),titleScore);
    await page.reload();
    await page.waitForSelector('[data-tab="library"]');
    await page.evaluate(()=>e2e.openTitle('sample'));
    assert.equal(await page.locator('.mt-saved-chapter-rating strong').first().innerText(),'9 / 10');
    assert.equal(await page.locator('.mt-saved-chapter-rating strong').nth(1).innerText(),'8 / 10');
    for(const width of [320,390]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'chapter ratings width '+width);}
    await page.locator('.mt-journal-list').screenshot({path:path.join(root,'test-results','chapter-ratings.png')});
    await page.locator('#chapter-form').screenshot({path:path.join(root,'test-results','chapter-rating-form.png')});
    await page.evaluate(() => {e2e.state.selectedId=null;e2e.state.tab='journey';e2e.state.journeyUI.section='goals';e2e.render();});
    assert.equal(await page.locator('.mt-goal-count').innerText(),'2 / 10');
    await page.reload();
    await page.waitForSelector('[data-tab="journey"]');
    await page.locator('[data-tab="journey"]').click();
    await page.locator('[data-journey-section="goals"]').click();
    assert.equal(await page.locator('.mt-goal-count').innerText(),'2 / 10','goal survives reload');
    assert.equal(await page.evaluate(() => e2e.state.manhwas.reduce((n,m)=>n+(m.journal||[]).length,0)),2,'journal survives reload');
    await page.evaluate(() => {e2e.state.revealManhwaId='sample';e2e.render();});
    await page.locator('.mt-reveal-card').waitFor({state:'visible'}); await page.screenshot({animations:'disabled',path:path.join(root,'test-results','reveal-new.png')});
    assert.equal(await page.locator('.mt-reveal-criteria>div').count(),5);
    await page.locator('#reveal-close-btn').click();
    await page.evaluate(()=>{e2e.state.selectedId=null;e2e.state.tab='profile';e2e.state.totalXp=1000;e2e.saveXp();e2e.render();});
    async function applyFromEditor(id) {
      assert.equal(await page.locator('[data-shop-equip],#shop-reset').count(),0);
      await page.locator('#shop-back').click();
      await page.locator('#prof-edit').click();
      await page.locator('[data-profile-style="'+id.split('-')[0]+'"]').selectOption(id);
      await page.locator('#prof-save').click();
      await page.locator('#shop-open').click();
    }
    await page.locator('#shop-open').click();
    for(const [order,first] of [['rare-first','legendary'],['common-first','common']]){
      await page.locator('#shop-sort').selectOption(order);
      assert.equal(await page.locator('.mt-shop-item').first().getAttribute('data-rarity'),first);
    }
    await page.locator('#shop-sort').selectOption('');
    assert.equal(await page.locator('.mt-shop-item').count(),42);
    await page.locator('[data-shop-preview="theme-ocean"]').click();
    assert.equal(await page.evaluate(()=>e2e.state.profile.style?.theme||''),'');
    await page.locator('[data-shop-buy="theme-ocean"]').click();
    assert.equal(await page.locator('.mt-shop-wallet b').innerText(),'◈ 750');
    await applyFromEditor('theme-ocean');
    await page.locator('[data-shop-category="frame"]').click();
    assert.equal(await page.locator('.mt-shop-item').count(),14);
    await page.locator('[data-shop-preview="frame-frost"]').click();
    await page.locator('[data-shop-buy="frame-frost"]').click();
    await applyFromEditor('frame-frost');
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'shop overflow '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({animations:'disabled',fullPage:true,path:path.join(root,'test-results','shop.png')});
    await page.locator('#shop-back').click();
    assert.equal(await page.locator('.mt-hero.mt-theme-ocean.mt-frame-frost').count(),1);
    await page.reload();await page.waitForSelector('[data-tab="profile"]');await page.locator('[data-tab="profile"]').click();
    assert.equal(await page.locator('.mt-hero.mt-theme-ocean.mt-frame-frost').count(),1);
    await page.locator('#shop-open').click();
    assert.equal(await page.locator('.mt-shop-wallet b').innerText(),'◈ 530');
    await page.locator('[data-shop-preview="frame-crown"]').click();
    assert.equal(await page.locator('[data-shop-buy="frame-crown"]').isDisabled(),true);
    await page.locator('#shop-back').click();
    await page.locator('#prof-edit').click();
    assert.equal(await page.locator('[data-profile-style="frame"] option[value="frame-crown"]').count(),0);
    await page.locator('[data-profile-style="theme"]').selectOption('');
    await page.locator('#prof-cancel').click();if(await page.locator('#profile-leave-dialog').evaluate(el=>el.open))await page.locator('#leave-discard').click();
    assert.equal(await page.locator('.mt-hero.mt-theme-ocean').count(),1);
    await page.locator('#prof-edit').click();
    for(const kind of ['theme','frame','badge'])await page.locator('[data-profile-style="'+kind+'"]').selectOption('');
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'editor overflow '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({animations:'disabled',fullPage:true,path:path.join(root,'test-results','profile-collection-editor.png')});
    await page.locator('#prof-save').click();
    await page.locator('#shop-open').click();
    assert.equal(await page.evaluate(()=>Object.keys(e2e.state.shop).length),2);
    await page.locator('#shop-rarity').selectOption('legendary');
    assert.equal(await page.locator('.mt-shop-item:not([data-rarity="legendary"])').count(),0);
    await page.locator('#shop-rarity').selectOption('all');
    await page.evaluate(()=>{e2e.state.totalXp=10000;e2e.saveXp();e2e.render();});
    await page.locator('[data-shop-preview="theme-celestial"]').click();
    await page.locator('[data-shop-buy="theme-celestial"]').click();
    await applyFromEditor('theme-celestial');
    await page.locator('[data-shop-preview="frame-celestial"]').click();
    await page.locator('[data-shop-buy="frame-celestial"]').click();
    await applyFromEditor('frame-celestial');
    await page.locator('[data-shop-category="theme"]').click();
    await page.locator('.mt-shop-art').first().scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.mt-shop-art').first().evaluate(img=>img.complete&&img.naturalWidth>0),true);
    await page.screenshot({animations:'disabled',fullPage:true,path:path.join(root,'test-results','shop-illustrated.png')});
    await page.locator('#shop-back').click();
    await page.evaluate(()=>{window.AMSync={isConfigured:()=>true,isSignedIn:()=>true,getStatus:()=>({signedIn:true,verified:true,email:'reader@example.test',phase:'idle',lastSync:Date.now(),hasPassword:true}),notifyLocalChange(){}};e2e.render();});
    assert.equal(await page.locator('#acct-sync,#acct-signout,#acct-delete').count(),0);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'illustrated profile overflow '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','profile-illustrated.png')});
    await page.locator('#account-settings-open').click();
    assert.equal(await page.locator('#acct-sync,#acct-signout,#acct-delete').count(),3);
    await page.locator('#acct-delete').click();
    assert.equal(await page.locator('#acct-delete-confirm').count(),1);
    await page.locator('#acct-delete-cancel').click();
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','account-settings.png')});
    await page.locator('#account-settings-back').click();
    assert.equal(await page.locator('#acct-sync,#acct-signout,#acct-delete').count(),0);
    await page.evaluate(()=>{window.AMSync=undefined;});
    await page.locator('#shop-open').click();
    await page.locator('#shop-rarity').selectOption('all');
    await page.locator('[data-shop-category="badge"]').click();
    for (const id of ['badge-fox','badge-dragon']) {
      await page.locator('[data-shop-preview="'+id+'"]').click();
      await page.locator('[data-shop-buy="'+id+'"]').click();
      await applyFromEditor(id);
      await page.waitForFunction(()=>{const img=document.querySelector('.mt-shop-preview .mt-shop-badge img');return img&&img.complete&&img.naturalWidth>0;});
    }
    await page.locator('[data-shop-category="theme"]').click();
    await page.locator('[data-shop-preview="theme-forest"]').click();
    await page.locator('[data-shop-buy="theme-forest"]').click();
    await applyFromEditor('theme-forest');
    await page.locator('[data-shop-category="frame"]').click();
    await page.locator('[data-shop-preview="frame-vine"]').click();
    await page.locator('[data-shop-buy="frame-vine"]').click();
    await applyFromEditor('frame-vine');
    await page.locator('#shop-back').click();
    await page.reload();
    await page.locator('[data-tab="profile"]').click();
    await page.waitForFunction(()=>{const img=document.querySelector('.mt-hero .mt-shop-badge img');return img&&img.complete&&img.naturalWidth>0;});
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'new collection overflow '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','profile-new-collection.png')});
    assert.deepEqual(errors,[]);
    await page.locator('#prof-edit').click();
    assert.equal(await page.locator('[data-profile-style] option[value="theme-freefall"]').count(),0);
    await page.locator('#prof-cancel').click();if(await page.locator('#profile-leave-dialog').evaluate(el=>el.open))await page.locator('#leave-discard').click();
    await page.evaluate(()=>{window.AMSync={isOwner:()=>true,isConfigured:()=>false,notifyLocalChange(){}};});
    await page.locator('#prof-edit').click();
    for(const [kind,id] of [['theme','theme-freefall'],['frame','frame-freefall'],['badge','badge-owner']]){
      await page.locator('[data-profile-style="'+kind+'"]').selectOption(id);
    }
    await page.locator('#prof-save').click();
    assert.equal((await page.locator('.mt-hero.mt-theme-freefall.mt-frame-freefall .mt-shop-badge').innerText()).replace(/\s+/g,' '),'♛ owner');
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','exclusive-owner.png')});
    await page.locator('#shop-open').click();
    assert.equal(await page.locator('.mt-shop-item[data-rarity="exclusive"]').count(),0);
    await page.locator('#shop-back').click();
    await page.evaluate(()=>{window.AMSync=undefined;e2e.render();});
    assert.equal(await page.locator('.mt-hero.mt-theme-freefall,.mt-hero .mt-shop-badge').count(),0);
    assert.deepEqual(errors,[]);
    assert.equal(await page.locator('#recap-download').count(),0);
    await page.evaluate(()=>{e2e.state.manhwas[0].createdAt=new Date(2020,0,1).getTime();e2e.state.tab='awards';e2e.state.awardsView='year';e2e.state.awardsYear=2020;e2e.render();});
    const recapDownload=page.waitForEvent('download');await page.locator('#recap-download').click();
    const recapFile=await recapDownload;assert.equal(recapFile.suggestedFilename(),'AM-Tracker-2020.png');
    await recapFile.saveAs(path.join(root,'test-results','monthly-recap.png'));
    const png=fs.readFileSync(path.join(root,'test-results','monthly-recap.png'));
    assert.equal(png.readUInt32BE(16),1080);assert.equal(png.readUInt32BE(20),1350);
    await page.locator('[data-tab="profile"]').click();
    await page.locator('#prof-edit').click();
    await page.locator('[data-profile-style="theme"]').selectOption('theme-forest');
    await page.locator('.mt-outfits>summary').click();await page.locator('#outfit-name').fill('Лесная история');await page.locator('#outfit-save').click();
    await page.locator('#prof-cancel').click();if(await page.locator('#profile-leave-dialog').evaluate(el=>el.open))await page.locator('#leave-discard').click();assert.equal(await page.evaluate(()=>(e2e.state.profile.outfits||[]).length),0);
    await page.locator('#prof-edit').click();
    await page.locator('[data-profile-style="theme"]').selectOption('theme-forest');
    await page.locator('.mt-outfits>summary').click();await page.locator('#outfit-name').fill('Лесная история');await page.locator('#outfit-save').click();
    await page.locator('#prof-save').click();await page.reload();await page.locator('[data-tab="profile"]').click();
    await page.locator('#prof-edit').click();assert.equal(await page.locator('[data-outfit-use]').count(),1);
    await page.locator('[data-profile-style="theme"]').selectOption('');await page.locator('.mt-outfits>summary').click();await page.locator('[data-outfit-use]').click();
    assert.equal(await page.locator('[data-profile-style="theme"]').inputValue(),'theme-forest');
    await page.screenshot({animations:'disabled',path:path.join(root,'test-results','saved-outfits.png')});
    await page.locator('#prof-save').click();
    const beforeSet=await page.evaluate(()=>JSON.stringify([e2e.state.profile.style,e2e.state.shop,e2e.state.totalXp]));
    await page.locator('#shop-open').click();await page.locator('.mt-shop-collections summary').click();
    await page.locator('[data-set-preview="celestial"]').click();
    assert.equal(await page.locator('.mt-shop-preview.mt-theme-celestial.mt-frame-celestial').count(),1);
    assert.equal(await page.evaluate(()=>JSON.stringify([e2e.state.profile.style,e2e.state.shop,e2e.state.totalXp])),beforeSet);
    await page.locator('.mt-shop-collections summary').click();
    for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'collections width '+width);}
    await page.setViewportSize({width:390,height:844});await page.screenshot({animations:'disabled',path:path.join(root,'test-results','shop-collections.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: reading, awards, shop, saved outfits, monthly PNG and responsive collections; no page errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

