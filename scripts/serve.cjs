// Local preview only. No build step or dependencies.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),port=Number(process.env.PORT||8001);
const files=new Set(['index.html','app.js','features.js','sync.js','firebase-config.js','styles.css','design.css','halloween.css','changelog.js','manifest.json','service-worker.js']);
http.createServer((req,res)=>{
  let name;try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'index.html';}catch{res.writeHead(400).end();return;}
  if(!files.has(name)&&!/^((assets|icons)\/[a-zA-Z0-9_/-]+\.(svg|png|webp))$/.test(name)){res.writeHead(404).end();return;}
  fs.readFile(path.join(root,name),(err,body)=>{if(err){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(name)]||'application/octet-stream');
    res.setHeader('Cache-Control','no-cache');res.end(body);
  });
}).listen(port,'127.0.0.1',()=>console.log('AM Tracker: http://127.0.0.1:'+port));
