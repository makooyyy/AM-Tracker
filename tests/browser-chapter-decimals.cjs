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
for(const w of [320,390]){
  const ctx=await browser.newContext({viewport:{width:w,height:844},serviceWorkers:'block'});
  const page=await ctx.newPage();page.on('pageerror',e=>errs.push(w+' '+e.message));
  await page.route('https://**/*',r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForSelector('[data-tab="library"]');
  await page.evaluate(()=>{const m=e2e.newManhwa('Дробные оценки');m.id='a';e2e.state.manhwas=[m];e2e.render();e2e.openTitle('a');});
  await page.click('[data-detail-section="journal"]');await page.click('#journal-quick');
  await page.waitForSelector('#chapter-quick-dialog[open]');
  const slider=page.locator('#chapter-rating'),exact=page.locator('#chapter-rating-exact'),out=page.locator('.mt-chapter-slider output');
  assert.equal(await slider.getAttribute('step'),'0.1');
  // typing a decimal, with a comma as in Russian
  await exact.fill('8,7');
  assert.equal(await slider.inputValue(),'8.7');assert.equal(await out.innerText(),'8.7 / 10');
  assert.equal(await page.locator('.mt-chapter-mood').innerText(),'Потрясающая глава');
  // ±0.1 buttons
  await page.click('[data-chapter-fine="0.1"]');assert.equal(await slider.inputValue(),'8.8');
  await page.click('[data-chapter-fine="-0.1"]');await page.click('[data-chapter-fine="-0.1"]');
  assert.equal(await slider.inputValue(),'8.6');assert.equal(await exact.inputValue(),'8.6');
  // keyboard: arrows are whole points, Shift+arrow is a tenth (existing behaviour kept)
  await slider.focus();await slider.press('Home');assert.equal(await slider.inputValue(),'0');
  for(let i=0;i<8;i++)await slider.press('ArrowRight');
  assert.equal(await slider.inputValue(),'8');
  await slider.press('Shift+ArrowRight');assert.equal(await slider.inputValue(),'8.1');
  await slider.press('ArrowRight');assert.equal(await slider.inputValue(),'9');
  await slider.press('ArrowLeft');assert.equal(await slider.inputValue(),'8');
  await slider.press('End');await slider.press('ArrowLeft');assert.equal(await slider.inputValue(),'9');
  // values between 0 and 1 do not exist: from "no rating" the first step is 1
  await page.click('[data-chapter-score="0"]');assert.equal(await slider.inputValue(),'0');
  await page.click('[data-chapter-fine="0.1"]');assert.equal(await slider.inputValue(),'1');
  // invalid text is explained and does not change the rating
  await exact.fill('11');await exact.blur();
  assert.match(await page.locator('#chapter-error').innerText(),/от 1 до 10/);
  assert.equal(await exact.inputValue(),'1');
  await exact.fill('0,5');await exact.blur();assert.equal(await slider.inputValue(),'1');
  // save chapter 5 = 8.7 and chapter 6 = 9.9
  async function saveChapter(ch,val){
    await page.fill('#chapter-number',String(ch));await exact.fill(val);
    await page.locator('#chapter-form button[type="submit"]:not([name="next"])').first().click();
    await page.waitForFunction(()=>!document.querySelector('#chapter-quick-dialog[open]'));
  }
  await saveChapter(5,'8,7');
  await page.click('#journal-quick');await page.waitForSelector('#chapter-quick-dialog[open]');
  await saveChapter(6,'9,9');
  const saved=await page.evaluate(()=>e2e.state.manhwas[0].journal.map(e=>[e.chapter,e.rating]));
  assert.deepEqual(saved,[[5,8.7],[6,9.9]]);
  // shown in the records, the chart and the average
  const records=await page.$$eval('.mt-saved-chapter-rating strong,.mt-entry-score strong',els=>els.map(e=>e.innerText.replace(/\s+/g,' ').trim()));
  assert.ok(records.includes('9.9 / 10')&&records.includes('8.7 / 10'),'records: '+records.join('|'));
  assert.deepEqual(await page.$$eval('a[data-chart-caption]',a=>a.map(x=>x.dataset.chartCaption)),['Глава 5 · 8.7 / 10','Глава 6 · 9.9 / 10']);
  assert.ok((await page.locator('body').innerText()).includes('9.3'),'average of 8.7 and 9.9 is 9.3');
  // survives a reload
  await page.reload();await page.waitForSelector('[data-tab="library"]');
  const after=await page.evaluate(()=>e2e.state.manhwas[0].journal.map(e=>e.rating));
  assert.deepEqual(after,[8.7,9.9]);
  // an unsent decimal is kept in the draft
  await page.evaluate(()=>e2e.openTitle('a'));await page.click('[data-detail-section="journal"]');await page.click('#journal-quick');
  await page.waitForSelector('#chapter-quick-dialog[open]');
  await page.locator('#chapter-rating-exact').fill('7,4');await page.keyboard.press('Escape');
  await page.click('#journal-quick');await page.waitForSelector('#chapter-quick-dialog[open]');
  assert.equal(await page.locator('#chapter-rating').inputValue(),'7.4');
  assert.equal(await page.locator('#chapter-rating-exact').inputValue(),'7.4');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal scroll');
  const geo=await page.evaluate(()=>[...document.querySelectorAll('.mt-chapter-fine > *')].map(e=>Math.round(e.getBoundingClientRect().height)));
  assert.ok(geo.every(h=>h>=44),'controls are at least 44px tall: '+geo);
  await ctx.close();
}
assert.equal(errs.length,0,errs.join('; '));
console.log('PASS: chapter ratings accept tenths (typing, ±0.1, Shift+arrows), whole-point arrows kept, saved/shown/charted/averaged, survive reload and drafts');
await browser.close();server.close();
})().catch(e=>{console.error(e);process.exit(1)});
