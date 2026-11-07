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
  if(name==='app.js')b=b.toString().replace('/* ---------- boot ---------- */','window.e2e = {state, render, newManhwa}; /* ---------- boot ---------- */');
  res.end(b);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
const errs=[];page.on('pageerror',e=>errs.push(e.message));
let mode='ok';
await page.route('https://graphql.anilist.co',route=>{
  if(mode==='private')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({errors:[{message:'Private User'}]})});
  if(mode==='nouser')return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({errors:[{message:'User not found'}]})});
  const e=(id,en,ro,st,pr,sc,c,g)=>({status:st,progress:pr,score:sc,media:{id,title:{english:en,romaji:ro,native:null},synonyms:[],coverImage:{large:'https://x/c'+id+'.jpg'},genres:g,countryOfOrigin:c}});
  route.fulfill({contentType:'application/json',body:JSON.stringify({data:{MediaListCollection:{lists:[
    {entries:[e(1,'Solo Leveling','Na Honjaman Level Up','CURRENT',110,9,'KR',['Action','Fantasy']),e(2,null,'Berserk','COMPLETED',364,10,'JP',['Fantasy']),e(3,'Tower of God','Kami no Tou','PLANNING',0,0,'KR',[])]},
    {entries:[e(1,'Solo Leveling','Na Honjaman Level Up','CURRENT',110,9,'KR',['Action']),e(4,'Cultivation','Xiuzhen','DROPPED',5,4,'CN',[])]}]}}})});
});
await page.route('https://**/*',r=>r.request().url().includes('anilist')?r.fallback():r.abort());
await page.goto('http://127.0.0.1:'+server.address().port);
await page.waitForSelector('[data-tab="profile"]');
await page.evaluate(()=>{const m=e2e.newManhwa('Tower of God');m.id='own1';e2e.state.manhwas=[m];e2e.render();});
await page.click('[data-tab="profile"]');await page.click('#account-settings-open');
await page.waitForSelector('#list-import-user');
// AniList errors
mode='private';await page.fill('#list-import-user','someone');await page.click('#list-import-fetch');
await page.waitForSelector('.mt-list-import-error');assert.match(await page.textContent('.mt-list-import-error'),/закрыт/);
mode='nouser';await page.fill('#list-import-user','ghost');await page.click('#list-import-fetch');
await page.waitForFunction(()=>/не найден/.test(document.querySelector('.mt-list-import-error')?.textContent||''));
// success
mode='ok';await page.fill('#list-import-user','@artem');await page.click('#list-import-fetch');
await page.waitForSelector('#list-import-confirm');
const sum=await page.textContent('.mt-list-import-summary');assert.match(sum,/найдено 4/);assert.match(sum,/Новых: 3 · уже в библиотеке: 1/);
await page.click('#list-import-confirm');
const res=await page.evaluate(()=>e2e.state.manhwas.map(m=>({t:m.title,s:m.status,ty:m.type,n:m.notes,a:m.anilistId,g:m.genres,done:!!m.completedAt,rated:m.rated})));
assert.equal(res.length,4);
assert.deepEqual(res.find(x=>x.a===1),{t:'Solo Leveling',s:'reading',ty:'manhwa',n:'Перенесено из AniList · прочитано глав: 110 · там оценка: 9/10',a:1,g:['Экшн','Фэнтези'],done:false,rated:false});
assert.equal(res.find(x=>x.a===2).s,'done');assert.equal(res.find(x=>x.a===4).ty,'manhua');
assert.equal(res.find(x=>x.a===4).s,'dropped');
// second import → everything known
await page.fill('#list-import-user','artem');await page.click('#list-import-fetch');
await page.waitForFunction(()=>/Новых: 0 · уже в библиотеке: 4/.test(document.querySelector('.mt-list-import-summary')?.textContent||''));
await page.click('#list-import-cancel');
// XML file
const xml='<?xml version="1.0"?><myanimelist><myinfo><user_export_type>2</user_export_type></myinfo><manga><manga_mangadb_id>2</manga_mangadb_id><manga_title><![CDATA[Berserk]]></manga_title><my_read_chapters>1</my_read_chapters><my_score>10</my_score><my_status>Completed</my_status></manga><manga><manga_mangadb_id>7</manga_mangadb_id><manga_title><![CDATA[Vagabond]]></manga_title><my_read_chapters>50</my_read_chapters><my_score>8</my_score><my_status>On-Hold</my_status></manga></myanimelist>';
const tmp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'am-import-'));const malFile=path.join(tmp,'mal.xml'),badFile=path.join(tmp,'bad.xml');fs.writeFileSync(malFile,xml);fs.writeFileSync(badFile,'<html>nope</html>');
await page.setInputFiles('#list-import-file',badFile);
await page.waitForFunction(()=>/не похоже/.test(document.querySelector('.mt-list-import-error')?.textContent||''));
await page.setInputFiles('#list-import-file',malFile);
await page.waitForFunction(()=>/Новых: 1 · уже в библиотеке: 1/.test(document.querySelector('.mt-list-import-summary')?.textContent||''));
await page.click('#list-import-confirm');
const v=await page.evaluate(()=>e2e.state.manhwas.find(m=>m.title==='Vagabond'));
assert.equal(v.status,'reading');assert.equal(v.type,'manga');assert.match(v.notes,/файла MAL\/AniList · прочитано глав: 50 · там оценка: 8\/10/);
// library shows them
await page.click('[data-tab="library"]');await page.waitForTimeout(400);
assert.equal(await page.locator('.mt-cover[data-open-id]').count(),5);
assert.equal(errs.length,0);
console.log('PASS: list import from AniList username and MAL xml, duplicates skipped, errors shown');
await browser.close();server.close();
})().catch(e=>{console.error(e);process.exit(1)});
