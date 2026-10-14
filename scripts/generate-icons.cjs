// Rasterize the editable vector mark into the installable PWA icon sizes.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root = path.resolve(__dirname,'..');
  const svg = fs.readFileSync(path.join(root,'icons/mark.svg'),'utf8');
  const browser = await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
  try {
    const page = await browser.newPage();
    for (const [name,size,mask] of [['icon-v81-192.png',192,false],['icon-v81-512.png',512,false],['maskable-v81-512.png',512,true],['apple-touch-v81.png',180,false]]) {
      const data = await page.evaluate(async ({svg,size,mask}) => {
        const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#17161e'; ctx.fillRect(0,0,size,size);
        const inset = mask ? size * .08 : 0; ctx.drawImage(img,inset,inset,size-inset*2,size-inset*2);
        return canvas.toDataURL('image/png').split(',')[1];
      },{svg,size,mask});
      fs.writeFileSync(path.join(root,'icons',name),Buffer.from(data,'base64'));
    }
    console.log('Generated four PWA icons from mark.svg');
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode=1; });
