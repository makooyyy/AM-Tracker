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
    await page.clock.setFixedTime(new Date(2026,11,31,23,59));
    await page.route('https://**/*',r=>r.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForSelector('[data-tab="profile"]');
    await page.evaluate(()=>{const m=e2e.newManhwa('История года');m.createdAt=new Date(2026,0,1).getTime();e2e.state.manhwas=[m];e2e.state.tab='awards';e2e.state.awardsView='year';e2e.state.awardsYear=2026;e2e.render();});
    assert.equal(await page.locator('#recap-download').count(),0);
    await page.clock.setFixedTime(new Date(2027,0,1,0,1));await page.evaluate(()=>e2e.render());
    assert.equal(await page.locator('#recap-download').count(),1);
    for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    const download=page.waitForEvent('download');await page.locator('#recap-download').click();
    const file=await download;assert.equal(file.suggestedFilename(),'AM-Tracker-2026.png');
    await file.saveAs(path.join(root,'test-results','annual-personal-recap.png'));
    await page.locator('[data-tab="profile"]').click();assert.equal(await page.locator('#recap-download,#recap-month').count(),0);
    console.log('PASS yearly recap: hidden Dec 31, available Jan 1, responsive, PNG download, absent from profile');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});

