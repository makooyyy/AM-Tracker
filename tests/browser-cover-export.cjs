const fs=require('fs'),path=require('path'),http=require('http'),zlib=require('zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
function png(w,h,rgb){const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}
 const crc=b=>{let x=0xffffffff;for(const v of b)x=t[(x^v)&255]^(x>>>8);return (x^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([len,td,c]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
 const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=y*(w*3+1)+1+x*3;raw[o]=rgb[0];raw[o+1]=rgb[1];raw[o+2]=rgb[2];}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const COVER=png(60,90,[230,40,40]);
(async()=>{
const root=path.resolve(__dirname,'..');
let mode='cors',delay=0;const hits=[];
// Image host: sends the CORS header only to requests that carry an Origin, like many CDNs.
const cdn=http.createServer((req,res)=>{
  const origin=req.headers.origin;hits.push(origin||null);
  const h={'Content-Type':'image/png','Cache-Control':'public, max-age=3600'};
  if(origin&&mode!=='nocors')h['Access-Control-Allow-Origin']='*';
  res.writeHead(200,h);setTimeout(()=>res.end(COVER),delay);
});
await new Promise(r=>cdn.listen(0,'127.0.0.1',r));
const app=http.createServer((req,res)=>{const name=req.url.split('?')[0].replace(/^\//,'')||'index.html';const f=path.join(root,name);if(!fs.existsSync(f)||name.includes('..')){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'})[path.extname(f)]||'application/octet-stream');
  let b=fs.readFileSync(f);if(name==='sync.js')b='';
  if(name==='app.js')b=b.toString().replace('/* ---------- boot ---------- */','window.e2e = {state, render, newManhwa, openTitle}; /* ---------- boot ---------- */');
  res.end(b);});
await new Promise(r=>app.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
async function exportMap(scenario,{offline=false}={}){
  mode=scenario.mode;delay=scenario.delay||0;hits.length=0;
  const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await ctx.newPage();const errs=[];page.on('pageerror',e=>errs.push(e.message));
  await page.route('https://**/*',r=>r.abort());
  await page.goto('http://127.0.0.1:'+app.address().port);await page.waitForSelector('[data-tab="library"]');
  // the library shows the cover through a normal <img> first, as for a real user
  await page.evaluate(cover=>{const now=Date.now();const m=e2e.newManhwa('С обложкой','manhwa',cover);m.id='a';m.journal=[1,2,3,4,5].map((c,k)=>({id:'j'+k,chapter:c,ts:now-(6-k)*86400000,rating:7+k*0.5,text:'',spoiler:false}));e2e.state.manhwas=[m];e2e.render();e2e.openTitle('a');},'http://127.0.0.1:'+cdn.address().port+'/cover.png');
  await page.waitForTimeout(500);
  await page.click('[data-detail-section="journal"]');await page.click('#journal-map-toggle');
  if(offline)await ctx.setOffline(true);
  await page.click('#map-download');
  await page.waitForSelector('dialog.mt-export-preview[open] img',{timeout:20000});await page.waitForTimeout(300);
  const px=await page.evaluate(async()=>{const src=document.querySelector('dialog.mt-export-preview img').src;const bmp=await createImageBitmap(await (await fetch(src)).blob());const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;const g=c.getContext('2d');g.drawImage(bmp,0,0);const d=g.getImageData(60,60,1,1).data;return [d[0],d[1],d[2]];});
  const status=await page.locator('#export-status').innerText();
  await ctx.close();assert.equal(errs.length,0,errs.join('; '));
  return {drawn:px[0]>180&&px[1]<90&&px[2]<90,status,origins:hits.slice()};
}
let r=await exportMap({mode:'cors'});
assert.ok(r.drawn,'cover is drawn when the host allows CORS');assert.equal(r.status,'');
assert.ok(r.origins.some(o=>o),'the export asked the host in CORS mode (with an Origin header)');
r=await exportMap({mode:'cors',delay:3500});
assert.ok(r.drawn,'a slow cover (3.5 s) still makes it into the picture');
r=await exportMap({mode:'nocors'});
assert.ok(!r.drawn);assert.match(r.status,/не разрешил/,'the user is told why the cover is missing');
r=await exportMap({mode:'cors'},{offline:true});
assert.ok(!r.drawn);assert.match(r.status,/Нет интернета/);
console.log('PASS: chapter map export draws covers (fast and slow hosts), and explains a missing cover (blocked or offline)');
await browser.close();cdn.close();app.close();
})().catch(e=>{console.error(e);process.exit(1)});
