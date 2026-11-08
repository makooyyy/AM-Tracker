const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const name=req.url.split('?')[0].replace(/^\//,'')||'index.html';
  const f=path.join(root,name); if(!fs.existsSync(f)||name.includes('..')){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json'})[path.extname(f)]||'application/octet-stream');
  let b=fs.readFileSync(f); if(name==='sync.js')b='';
  if(name==='app.js')b=b.toString().replace('/* ---------- boot ---------- */','window.e2e = {state, render, newManhwa, ACHIEVEMENTS}; /* ---------- boot ---------- */');
  res.end(b);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
const errs=[];
for(const [phase,date] of [['ended','2026-11-08T12:00:00'],['live','2026-10-25T12:00:00']]){
 for(const w of [320,390,1280]){
  const ctx=await browser.newContext({viewport:{width:w,height:w===1280?900:844},deviceScaleFactor:1,serviceWorkers:'block'});
  const page=await ctx.newPage();page.on('pageerror',e=>errs.push(phase+w+' '+e.message));
  await page.clock.setFixedTime(new Date(date));
  await page.route('https://**/*',r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForSelector('[data-tab="journey"]');
  await page.evaluate(()=>{const q=e2e.ACHIEVEMENTS.filter(a=>a.category==='Хэллоуин 2026').slice(0,3);q.forEach(a=>e2e.state.unlockedAchievements[a.id]=Date.now());e2e.render();});
  await page.click('[data-tab="journey"]');await page.waitForTimeout(300);
  const secs=await page.$$eval('[data-journey-section]',els=>els.map(e=>e.dataset.journeySection+':'+e.textContent.trim().replace(/\s+/g,' ')));
  if(phase==='ended'){
    assert.deepEqual(secs.map(x=>x.split(':')[0]),['achievements','goals','archive']);
    await page.click('[data-journey-section="archive"]');await page.waitForSelector('.mt-event-card');
    const txt=await page.textContent('.mt-event-card');
    assert.match(txt,/Ночь историй/);assert.match(txt,/3 \/ 7/);
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no hscroll');
    await page.click('[data-archive-open="halloween"]');await page.waitForSelector('.mt-halloween');
    assert.match(await page.textContent('.mt-halloween-date'),/Событие завершено/);
    assert.equal(await page.locator('[data-halloween-go]').count(),0,'no action buttons after the event');
    assert.match(await page.textContent('.mt-halloween-intro'),/Событие закончилось/);
    assert.equal(await page.locator('.mt-archive-back').count(),1);
    await page.waitForTimeout(400);
    await page.click('.mt-archive-back');await page.waitForSelector('.mt-event-card');
    // saved old section 'halloween' must land in the archive
    await page.evaluate(()=>localStorage.setItem('mt-usability-v1',JSON.stringify({journey:'halloween'})));
    await page.reload();await page.waitForSelector('[data-tab="journey"]');await page.click('[data-tab="journey"]');
    await page.waitForSelector('.mt-event-card');
  } else {
    assert.deepEqual(secs.map(x=>x.split(':')[0]),['achievements','goals','halloween']);
    await page.click('[data-journey-section="halloween"]');await page.waitForSelector('.mt-halloween');
    assert.match(await page.textContent('.mt-halloween-date'),/Событие идёт/);
    assert.equal(await page.locator('.mt-event-card,.mt-archive-link').count(),0,'no archive while nothing ended');
  }
  await ctx.close();
 }
}
assert.equal(errs.length,0,errs.join('; '));console.log('PASS: finished event moves to the Archive tab, live event keeps its tab, archive lists results and opens read-only');
await browser.close();server.close();
})().catch(e=>{console.error(e);process.exit(1)});
