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
  if(name==='app.js')b=b.toString().replace('/* ---------- boot ---------- */','window.e2e = {state, render, newManhwa, save}; /* ---------- boot ---------- */');
  res.end(b);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
const errs=[];
for(const width of [320,390,1280]){
  const ctx=await browser.newContext({viewport:{width,height:width===1280?900:844},serviceWorkers:'block'});
  const page=await ctx.newPage();page.on('pageerror',e=>errs.push(width+' '+e.message));
  await page.clock.setFixedTime(new Date('2026-11-10T12:00:00'));
  await page.route('https://**/*',r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForSelector('[data-tab="journey"]');
  await page.evaluate(()=>{e2e.state.manhwas=['A','B','C'].map((t,i)=>{const m=e2e.newManhwa(t);m.id='t'+i;return m;});e2e.render();});
  await page.click('[data-tab="journey"]');await page.click('[data-journey-section="goals"]');
  await page.waitForSelector('.mt-goal-slots');
  assert.match(await page.textContent('.mt-goal-slots'),/Активных: 0 \/ 3/);
  assert.ok(await page.locator('[data-goal-add]').count()<=6,'picker starts compact');
  // take three goals, the fourth is blocked
  for(const id of ['finish1','rate3','add3']){await page.click(`[data-goal-add="${id}"]`);}
  assert.equal(await page.locator('.mt-goal-card.selected').count(),3);
  assert.match(await page.textContent('.mt-goal-slots'),/Активных: 3 \/ 3/);
  assert.equal(await page.locator('[data-goal-add]').count(),0,'no add buttons with all slots taken');
  assert.ok(await page.locator('.mt-goal-card.compact button[disabled]').count()>0);
  // finish a goal
  const xp0=await page.evaluate(()=>e2e.state.totalXp);
  await page.evaluate(()=>{e2e.state.manhwas[0].status='done';e2e.save();});
  await page.waitForTimeout(700);
  const r=await page.evaluate(()=>({xp:e2e.state.totalXp,got:!!e2e.state.unlockedAchievements.goal_reward_finish1}));
  assert.ok(r.got,'reward unlocked');assert.ok(r.xp-xp0>=60,'reward XP granted');
  await page.evaluate(()=>e2e.save());await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>e2e.state.totalXp),r.xp,'reward XP is granted only once');
  assert.match(await page.textContent('#usability-toast'),/Цель выполнена: Первый финал/);
  // slot is free again and the finished goal is not offered again
  await page.click('[data-tab="library"]');await page.click('[data-tab="journey"]');await page.click('[data-journey-section="goals"]');
  assert.equal(await page.locator('.mt-goal-card.selected').count(),2);
  assert.match(await page.textContent('.mt-goal-slots'),/Активных: 2 \/ 3/);
  assert.match(await page.textContent('.mt-goal-free'),/1 свободное место/);
  await page.click('[data-goal-all="1"]');
  assert.equal(await page.locator('[data-goal-add="finish1"]').count(),0,'finished goal is replaced, not offered again');
  assert.ok(await page.locator('[data-goal-add]').count()>=30,'all remaining goals are shown');
  assert.ok(await page.locator('.mt-goal-done').count()===1);
  await page.click('.mt-goal-done summary');
  assert.match(await page.textContent('.mt-goal-done'),/Первый финал/);
  // new goal fills the slot
  await page.click('[data-goal-add="finish3"]');
  assert.equal(await page.locator('.mt-goal-card.selected').count(),3);
  // bell: notification about the finished goal
  await page.click('[data-tab="library"]');
  assert.equal(await page.locator('.mt-notify-dot').count(),1,'bell shows a dot');
  await page.click('#open-changelog');await page.waitForSelector('.mt-notif-card');
  const card=await page.textContent('[data-notif-id="goaldone:finish1"]');
  assert.match(card,/Цель выполнена/);assert.match(card,/Первый финал/);assert.match(card,/\+60 XP/);
  await page.click('[data-notif-id="goaldone:finish1"] [data-notif-go]');
  await page.waitForSelector('.mt-goal-slots');
  assert.equal(await page.evaluate(()=>e2e.state.journeyUI.section),'goals','notification opens the goals screen');
  // progress survives a reload
  await page.reload();await page.waitForSelector('[data-tab="journey"]');await page.click('[data-tab="journey"]');await page.click('[data-journey-section="goals"]');
  assert.equal(await page.locator('.mt-goal-card.selected').count(),3);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no hscroll');
  await ctx.close();
}
assert.equal(errs.length,0,errs.join('; '));
console.log('PASS: three goals at a time, finished goals are replaced by new ones, completion toast and bell notification');
await browser.close();server.close();
})().catch(e=>{console.error(e);process.exit(1)});
