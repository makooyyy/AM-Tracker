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
  if(name==='app.js')b=b.toString().replace('/* ---------- boot ---------- */','window.e2e = {state, render, newManhwa, openTitle}; /* ---------- boot ---------- */');
  res.end(b);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
const errs=[];
for(const [label,date] of [['classic','2026-11-07T12:00:00'],['halloween','2026-10-25T12:00:00']]){
 for(const w of [320,390,1280]){
  const ctx=await browser.newContext({viewport:{width:w,height:w===1280?900:844},serviceWorkers:'block'});
  const page=await ctx.newPage();page.on('pageerror',e=>errs.push(label+w+' '+e.message));
  await page.clock.setFixedTime(new Date(date));
  await page.route('https://**/*',r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForSelector('[data-tab="library"]');
  // --- empty library
  assert.equal(await page.locator('.mt-notify-dot').count(),1,'bell shows a dot for unseen notification and update log');
  await page.click('#open-changelog');
  await page.waitForSelector('.mt-notif-tabs');
  const tabs=await page.$$eval('.mt-notif-tabs button',b=>b.map(x=>x.textContent.trim()));
  assert.deepEqual(tabs.map(t=>t.replace('новое','')),['Уведомления','Журнал обновлений']);
  assert.match(await page.textContent('.mt-notif-card'),/Добро пожаловать/);
    // changelog tab
  await page.click('[data-notif-tab="changelog"]');await page.waitForSelector('.mt-changelog-entry');
  assert.ok(await page.locator('.mt-changelog-entry').count()>=2);
  assert.match(await page.textContent('.mt-changelog-entry'),/v\d+/);
  await page.click('#changelog-back-btn');
  assert.equal(await page.locator('.mt-notify-dot').count(),0,'dot gone once both tabs were seen');
  // --- rich data
  await page.evaluate(()=>{
    const DAY=86400000,now=Date.now();
    const mk=(t,o)=>Object.assign(e2e.newManhwa(t),o);
    const rated=(t,o)=>{const m=mk(t,Object.assign({rated:true,status:'done',lastRatedAt:now-35*DAY,createdAt:now-90*DAY,completedAt:now-35*DAY},o));m.criteria.forEach(c=>c.score=8);return m;};
    e2e.state.manhwas=[
      rated('Solo Leveling'),
      mk('Забытая история',{status:'reading',createdAt:now-60*DAY}),
      mk('Дочитал без оценки',{status:'done',completedAt:now-2*DAY,createdAt:now-30*DAY}),
      mk('Свежая',{status:'reading',createdAt:now-1*DAY}),
    ];
    e2e.render();
  });
  await page.click('#open-changelog');await page.waitForSelector('.mt-notif-card');
  const ids=await page.$$eval('.mt-notif-card',c=>c.map(x=>x.dataset.notifId.split(':')[0]));
  for(const need of ['unrated','stalled','backup'])assert.ok(ids.includes(need),'need '+need);
  assert.ok(await page.locator('.mt-notif-card.is-new').count()===ids.length,'all new on first open');
  const geo=await page.evaluate(()=>[...document.querySelectorAll('.mt-notif-actions')].map(a=>{const [x,y]=[...a.children].map(b=>b.getBoundingClientRect());return [Math.round(x.height),Math.round(y.height),Math.round(x.width),Math.round(y.width)]}));
  geo.forEach(g=>{assert.equal(g[0],g[1],'equal button heights');assert.ok(Math.abs(g[2]-g[3])<1,'equal widths')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no hscroll');
  
  // dismiss
  await page.click('[data-notif-dismiss^="backup"]');
  assert.equal(await page.locator('[data-notif-id^="backup"]').count(),0);
  // go to unrated title
  await page.click('[data-notif-id^="unrated"] [data-notif-go]');
  await page.waitForSelector('.mt-radar-panel, .mt-detail-nav');
  assert.equal(await page.evaluate(()=>e2e.state.selectedId&&e2e.state.manhwas.find(m=>m.id===e2e.state.selectedId).title),'Дочитал без оценки');
  await page.locator('button:has-text("←")').first().click();
  // badge cleared after viewing (changelog is seen only via its tab)
  await page.click('#open-changelog');
  assert.equal(await page.locator('.mt-notif-card.is-new').count(),0,'nothing new on second open');
  assert.equal(await page.locator('[data-notif-id^="backup"]').count(),0,'dismissed stays hidden');
  await page.click('#changelog-back-btn');
  assert.equal(await page.locator('.mt-notify-dot').count(),0,'no dot after everything was seen');
  // persistence across reload
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('mt-notifications-v1')));
  assert.ok(Object.keys(stored.dismissed).some(k=>k.startsWith('backup')));
  await ctx.close();
 }
}
assert.equal(errs.length,0,errs.join('; '));
console.log('PASS: bell opens notifications + update log tabs, cards from library data, dismiss and open work, new badge clears');
await browser.close();server.close();
})().catch(e=>{console.error(e);process.exit(1)});
