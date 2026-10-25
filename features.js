/* Pure helpers and the standalone PNG renderer used by AM Tracker. */
(function (root) {
  "use strict";
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  // AniList treats explicit null filters differently from omitted variables.
  function aniListVariables(raw){var out={};Object.keys(raw).forEach(function(k){if(raw[k]!==null&&raw[k]!==undefined&&raw[k]!=='')out[k]=raw[k];});return out;}
  function title(m) { return (m.altTitles && m.altTitles.ru && m.altTitles.ru.trim()) || m.title; }
  function month(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function ratings(m, score) {
    return (m.ratingHistory || []).map(function (h) { return copy(h); }).concat([{
      ts: m.lastRatedAt || m.createdAt, avg: score(m.criteria), criteria: copy(m.criteria),
      notes: m.notes || "", reason: m.ratingReason || ""
    }]);
  }
  function ratingInMonth(m, key, score) {
    if (!m.rated) return null;
    var found = ratings(m, score).filter(function (r) { return Number.isFinite(r.ts) && month(r.ts) === key; })
      .sort(function (a, b) { return b.ts - a.ts; })[0];
    return found ? Object.assign({}, m, { criteria: found.criteria, lastRatedAt: found.ts,
      notes: found.notes || "", ratingReason: found.reason || "" }) : null;
  }
  function comparison(before, after) {
    var names = [];
    before.criteria.concat(after.criteria).forEach(function (c) { if (names.indexOf(c.name) < 0) names.push(c.name); });
    return { delta: Math.round(after.avg) - Math.round(before.avg), rows: names.map(function (name) {
      var a = before.criteria.find(function (c) { return c.name === name; });
      var b = after.criteria.find(function (c) { return c.name === name; });
      return { name: name, before: a ? a.score : null, after: b ? b.score : null,
        delta: a && b ? Math.round((b.score - a.score) * 10) / 10 : null };
    }) };
  }
  function continueReading(titles, opened) {
    function time(m){return Math.max(opened[m.id]||0,readingProgress(m).updatedAt||0,m.createdAt||0);}
    return titles.filter(function (m) { return m.status === "reading"; })
      .sort(function (a, b) { return time(b)-time(a); }).slice(0, 8);
  }
  function readingProgress(m){
    var r=m&&m.reading||{},chapters=journal(m&&m.journal).map(function(e){return e.chapter;});
    return {chapter:Number.isFinite(r.chapter)&&r.chapter>=0&&r.chapter<=1000000?r.chapter:(chapters.length?Math.max.apply(null,chapters):0),url:readingUrl(r.url),updatedAt:Number.isFinite(r.updatedAt)?r.updatedAt:0};
  }
  function readingUrl(raw){
    if(typeof raw!=='string'||raw.length>2000)return '';
    try{var u=new URL(raw.trim());return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:'';}catch(e){return '';}
  }
  function chapterScores(raw){
    var seen=new Set();return journal(raw).filter(function(e){return e.rating;}).sort(function(a,b){return a.ts-b.ts||a.id.localeCompare(b.id);}).filter(function(e){if(seen.has(e.chapter))return false;seen.add(e.chapter);return true;}).sort(function(a,b){return a.chapter-b.chapter;});
  }
  function hasChapterRating(raw,chapter){return journal(raw).some(function(e){return e.chapter===chapter&&!!e.rating;});}
  function cleanFeedback(raw){
    var byId=new Map();(Array.isArray(raw)?raw:[]).forEach(function(f){if(!f||!Number.isInteger(f.id)||f.id<=0||!['hide','read','like'].includes(f.action)||!Number.isFinite(f.ts))return;var old=byId.get(f.id);if(!old||old.ts<=f.ts)byId.set(f.id,{id:f.id,action:f.action,ts:f.ts,genres:Array.isArray(f.genres)?f.genres.filter(function(g){return typeof g==='string'&&g.length<80;}).slice(0,20):[]});});return Array.from(byId.values()).sort(function(a,b){return a.ts-b.ts;}).slice(-500);
  }
  function awardSnapshot(m, key, category, score, legacy) {
    return { awardSnapshot: 1, id: String(m.id), title: title(m), altTitles: {}, type: m.type || "manhwa",
      coverUrl: m.coverUrl || "", criteria: copy(m.criteria || []), avg: score(m.criteria || []),
      notes: m.notes || "", lastRatedAt: m.lastRatedAt || m.createdAt || null,
      month: key, category: category, legacy: !!legacy, awardedAt: legacy ? null : Date.now() };
  }
  function coverImage(url) {
    if (!url || !/^(https?:|data:image\/(png|jpeg|webp);)/i.test(url)) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var img = new Image(), finished = false;
      var timer = setTimeout(function () { done(null); }, 6000);
      function done(result) { if (finished) return; finished = true; clearTimeout(timer); resolve(result); }
      img.crossOrigin = "anonymous";
      img.onload = function () { done(img); };
      img.onerror = function () { done(null); };
      img.src = url;
    });
  }
  // Wrap by characters too: long unbroken titles must not escape the card.
  function textLines(g, text, width, maxLines) {
    var lines = [], remaining = String(text || "").replace(/\s+/g, " ").trim();
    while (remaining && lines.length < maxLines) {
      var chars = Array.from(remaining), count = 0;
      while (count < chars.length && g.measureText(chars.slice(0, count + 1).join("")).width <= width) count++;
      if (count === chars.length) { lines.push(remaining); break; }
      count = Math.max(1, count);
      var line = chars.slice(0, count).join("");
      if (lines.length === maxLines - 1) {
        while (line && g.measureText(line + "…").width > width) line = Array.from(line).slice(0, -1).join("");
        lines.push(line.trimEnd() + "…"); break;
      }
      var space = line.lastIndexOf(" ");
      if (space > 0 && chars[count] !== " ") count = Array.from(line.slice(0, space)).length;
      lines.push(chars.slice(0, count).join("").trim());
      remaining = chars.slice(count).join("").trimStart();
    }
    return lines;
  }
  function drawText(g, text, x, y, width, lineHeight, maxLines) {
    textLines(g, text, width, maxLines).forEach(function (s, i) { g.fillText(s, x, y + i * lineHeight); });
  }
  function drawCard(data, cover) {
    var canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1350;
    var g = canvas.getContext("2d");
    if (!g) throw new Error("Не удалось создать изображение в этом браузере.");
    var bg = g.createLinearGradient(0, 0, 1080, 1350);
    bg.addColorStop(0, "#272730"); bg.addColorStop(1, "#0e0e10");
    g.fillStyle = bg; g.fillRect(0, 0, 1080, 1350);
    g.fillStyle = "#c9bfa8"; g.font = "700 27px sans-serif"; g.fillText("AM • TRACKER", 64, 76);
    g.fillStyle = "#f2f0ed"; g.font = "700 48px sans-serif";
    drawText(g, data.title, 64, 160, 952, 59, 2);
    g.fillStyle = "#acabb2"; g.font = "23px sans-serif";
    g.fillText(new Date(data.ts || Date.now()).toLocaleDateString("ru-RU"), 64, 265);
    g.fillStyle = "#34333b"; g.fillRect(64, 310, 334, 470);
    if (cover) {
      var ratio = Math.min(334 / cover.width, 470 / cover.height);
      var w = cover.width * ratio, h = cover.height * ratio;
      g.drawImage(cover, 64 + (334 - w) / 2, 310 + (470 - h) / 2, w, h);
    } else {
      g.fillStyle = "#c9bfa8"; g.font = "700 80px sans-serif";
      g.fillText("AM", 108, 550);
    }
    g.fillStyle = "#c9bfa8"; g.font = "700 110px sans-serif"; g.fillText(String(Math.round(data.avg)), 472, 415);
    g.fillStyle = "#acabb2"; g.font = "26px sans-serif"; g.fillText("/ 100", 665, 410);
    var criteria = data.criteria.slice(0, 8), n = criteria.length, cx = 738, cy = 636, radius = 125;
    if (n >= 3) {
      function polygon(scale, values) {
        g.beginPath();
        criteria.forEach(function (c, i) {
          var a = i * Math.PI * 2 / n - Math.PI / 2, r = radius * (values ? c.score / 10 : scale);
          var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }); g.closePath();
      }
      g.strokeStyle = "#55525d"; g.lineWidth = 1;
      [0.25, 0.5, 0.75, 1].forEach(function (s) { polygon(s); g.stroke(); });
      polygon(1, true); g.fillStyle = "rgba(201,191,168,0.25)"; g.fill(); g.strokeStyle = "#c9bfa8"; g.lineWidth = 3; g.stroke();
      g.fillStyle = "#e7e3dc"; g.font = "18px sans-serif"; g.textAlign = "center";
      criteria.forEach(function (c, i) {
        var a = i * Math.PI * 2 / n - Math.PI / 2;
        drawText(g, c.name + " " + c.score, cx + Math.cos(a) * 165, cy + Math.sin(a) * 165, 145, 22, 2);
      }); g.textAlign = "left";
    } else {
      g.fillStyle = "#e7e3dc"; g.font = "26px sans-serif";
      criteria.forEach(function (c, i) { drawText(g, c.name + " — " + c.score, 475, 565 + i * 70, 480, 30, 2); });
    }
    g.fillStyle = "#202025"; g.fillRect(64, 868, 952, 324);
    g.fillStyle = "#c9bfa8"; g.font = "700 21px sans-serif"; g.fillText(data.notes ? "МОЯ РЕЦЕНЗИЯ" : "МОЯ ОЦЕНКА", 94, 915);
    g.fillStyle = "#e7e3dc"; g.font = "27px sans-serif";
    drawText(g, data.notes || "Личные впечатления — в каждой оценке.", 94, 967, 886, 38, 5);
    g.fillStyle = "#acabb2"; g.font = "23px sans-serif";
    drawText(g, data.nick || "Моя библиотека", 64, 1260, 530, 28, 1);
    g.textAlign = "right"; g.font = "18px sans-serif"; g.fillText("AM TRACKER · ЛИЧНЫЕ ВПЕЧАТЛЕНИЯ", 1016, 1260);
    return canvas;
  }
  function createShareCard(data) {
    return coverImage(data.coverUrl).then(function (cover) {
      var canvas = drawCard(data, cover);
      return new Promise(function (resolve, reject) {
        try {
          canvas.toBlob(function (blob) {
            if (blob) resolve({ blob: blob, missingCover: !!data.coverUrl && !cover });
            else reject(new Error("Не удалось сохранить изображение."));
          }, "image/png");
        } catch (err) { reject(err); }
      });
    });
  }
  // Every positive monthly nomination is one vote. Equal totals share a place.
  function annualAwards(winners, year, now) {
    var current = month(now === undefined ? Date.now() : now), total = {}, categories = {}, months = {}, count = 0;
    function add(map, w, key, category) {
      var id = String(w.id);
      if (!map[id]) map[id] = { winner: copy(w), count: 0, months: [], categories: [] };
      var row = map[id]; row.winner = Object.assign(copy(w), {month:key, category:category}); row.count++;
      if (row.months.indexOf(key) < 0) row.months.push(key);
      if (row.categories.indexOf(category) < 0) row.categories.push(category);
    }
    Object.keys(winners).sort().forEach(function (key) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || Number(key.slice(0,4)) !== year || key >= current) return;
      Object.keys(winners[key]).forEach(function (category) {
        var w = winners[key][category];
        if (category === 'worst' || !w || typeof w !== 'object' || !w.id) return;
        add(total,w,key,category);
        if (!categories[category]) categories[category] = {};
        add(categories[category],w,key,category);
        if (!months[key]) months[key] = {count:0, overall:null};
        months[key].count++; count++;
        if (category === 'overall') months[key].overall = Object.assign(copy(w),{month:key,category:category});
      });
    });
    function rank(map) {
      var rows = Object.keys(map).map(function (id) { return map[id]; }).sort(function (a,b) {
        return b.count-a.count || title(a.winner).localeCompare(title(b.winner),'ru') || String(a.winner.id).localeCompare(String(b.winner.id));
      });
      rows.forEach(function (r,i) { r.place = i && rows[i-1].count === r.count ? rows[i-1].place : i+1; });
      return rows;
    }
    var leaders = rank(total), categoryLeaders = {};
    Object.keys(categories).forEach(function (c) { var rows = rank(categories[c]); categoryLeaders[c] = rows.filter(function (r) { return r.place === 1; }); });
    return {ranking:leaders, leaders:leaders.filter(function (r) { return r.place === 1; }), categories:categoryLeaders, months:months, awardCount:count};
  }
  var goalOptions = [
    {id:'finish3',reward:150,name:'Три истории до финала',text:'Заверши 3 тайтла',metric:'done',target:3},
    {id:'finish12',reward:600,name:'Большое путешествие',text:'Заверши 12 тайтлов',metric:'done',target:12},
    {id:'notes10',reward:200,name:'Летописец',text:'Сделай 10 записей по главам',metric:'journal',target:10},
    {id:'reviews5',reward:250,name:'Своё мнение',text:'Напиши рецензии к 5 тайтлам',metric:'reviews',target:5},
    {id:'genres3',reward:150,name:'За пределами привычного',text:'Оцени тайтлы 3 новых для тебя жанров',metric:'genres',target:3}
  ];
  function goalRewardXp(achievements){return goalOptions.reduce(function(sum,o){return sum+(achievements&&achievements['goal_reward_'+o.id]?o.reward:0);},0)+halloweenQuests.reduce(function(sum,q){return sum+(achievements&&achievements[q.id]?q.xp:0);},0);}
  var halloweenQuests=[
    {id:'h26_lantern',name:'Зажги первый фонарь',text:'Напиши текстовые заметки к 3 разным главам.',metric:'notes',target:3,xp:60,reward:'badge-h26-pumpkin',icon:'🎃'},
    {id:'h26_ink',name:'Чернила полуночи',text:'Оцени 5 разных глав.',metric:'ratings',target:5,xp:80,reward:'frame-h26-thorns',icon:'✒'},
    {id:'h26_stories',name:'Две истории у костра',text:'Поставь оценку 2 разным тайтлам.',metric:'titles',target:2,xp:100,reward:'theme-h26-harvest',icon:'📖'},
    {id:'h26_shadows',name:'Загляни в тени',text:'Оцени тайтл с жанром «Ужасы», «Мистика», «Триллер» или «Сверхъестественное».',metric:'dark',target:1,xp:100,reward:'badge-h26-bat',icon:'🦇'},
    {id:'h26_visits',name:'Огонёк не гаснет',text:'Читай и отмечай впечатления в 3 разных дня. Дни не обязательно подряд.',metric:'days',target:3,xp:120,reward:'theme-h26-manor',icon:'🕯'},
    {id:'h26_final',name:'Последняя страница',text:'Заверши один тайтл во время события.',metric:'finished',target:1,xp:140,reward:'frame-h26-spectral',icon:'👻'},
    {id:'h26_crown',name:'Хранитель Ночи историй',text:'Выполни все 6 заданий события.',metric:'complete',target:6,xp:200,reward:'badge-h26-keeper',icon:'♛'}
  ];
  function halloweenWindow(now){var start=new Date(2026,9,18).getTime(),end=new Date(2026,10,3).getTime();return {start:start,end:end,active:now>=start&&now<end,upcoming:now<start};}
  function halloweenProgress(list,log,earned,now){
    var w=halloweenWindow(now),notes=new Set(),ratingsSet=new Set(),titles=new Set(),dark=new Set(),days=new Set(),finished=new Set();
    function inside(ts){return Number.isFinite(ts)&&ts>=w.start&&ts<w.end&&ts<=now;}
    function day(ts){var d=new Date(ts);days.add(d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate());}
    list.forEach(function(m){
      journal(m.journal).forEach(function(e){if(!inside(e.ts))return;var key=JSON.stringify([m.id,e.chapter]);if(e.text.trim())notes.add(key);if(e.rating)ratingsSet.add(key);day(e.ts);});
      var dates=(m.ratingHistory||[]).map(function(r){return r.ts;}).concat(m.rated?[m.lastRatedAt]:[]).filter(inside);
      if(dates.length){titles.add(m.id);dates.forEach(day);if((m.genres||[]).some(function(g){return ['Ужасы','Мистика','Триллер','Сверхъестественное','Horror','Mystery','Thriller','Supernatural'].includes(g);}))dark.add(m.id);}
      if(inside(m.completedAt)){finished.add(m.id);day(m.completedAt);}
    });
    (log||[]).forEach(function(e){if(e.type==='status'&&e.extra&&e.extra.status==='done'&&e.manhwaId&&inside(e.ts)){finished.add(e.manhwaId);day(e.ts);}});
    return {notes:notes.size,ratings:ratingsSet.size,titles:titles.size,dark:dark.size,days:days.size,finished:finished.size,complete:halloweenQuests.slice(0,6).filter(function(q){return !!earned[q.id];}).length};
  }
  function journal(raw) {
    return (Array.isArray(raw) ? raw : []).filter(function(e) { return e && typeof e.id==='string' && Number.isFinite(e.ts) && Number.isFinite(e.chapter) && e.chapter>=0 && e.chapter<=1000000; }).map(function(e) {
      var rating=Number.isInteger(e.rating)&&e.rating>=1&&e.rating<=10?e.rating:null;
      var entry={id:e.id,text:typeof e.text==='string'?e.text.slice(0,2000):'',chapter:e.chapter,ts:e.ts,spoiler:!!e.spoiler};
      if(rating!==null)entry.rating=rating;
      if(Number.isInteger(e.run)&&e.run>1&&e.run<=10000)entry.run=e.run;
      return entry;
    }).filter(function(e){return e.text.trim()||e.rating;}).slice(-1000);
  }
  function goalKeys(list, metric) {
    if(metric==='journal') return list.flatMap(function(m){ return journal(m.journal).map(function(e){return m.id+':'+e.id;}); });
    if(metric==='genres') return Array.from(new Set(list.filter(function(m){return m.rated;}).flatMap(function(m){return m.genres||[];})));
    return list.filter(function(m){return metric==='done' ? m.status==='done' : m.rated && String(m.notes||'').trim();}).map(function(m){return m.id;});
  }
  function cleanJourney(raw) {
    raw = raw && typeof raw==='object' ? raw : {};
    return {feedback:cleanFeedback(raw.feedback),goals:(Array.isArray(raw.goals)?raw.goals:[]).filter(function(g){return g && goalOptions.some(function(o){return o.id===g.id;}) && Number.isFinite(g.started);}).slice(0,5).map(function(g){return {id:g.id,started:g.started,baseline:Array.isArray(g.baseline)?g.baseline.filter(function(s){return typeof s==='string';}):[],earned:Array.isArray(g.earned)?g.earned.filter(function(s){return typeof s==='string';}):[]};}),
      duels:(Array.isArray(raw.duels)?raw.duels:[]).filter(function(d){return d && typeof d.a==='string' && typeof d.b==='string' && d.a!==d.b && (d.winner===d.a||d.winner===d.b);}).slice(-2000).map(function(d){return {a:d.a,b:d.b,winner:d.winner};})};
  }
  function duelPair(list, history, genre, previous, random) {
    var pool=list.filter(function(m){return m.rated && (!genre||(m.genres||[]).includes(genre));}), pairs=[];
    var seen=new Set(history.map(function(d){return [d.a,d.b].sort().join('|');}));
    for(var i=0;i<pool.length;i++) for(var j=i+1;j<pool.length;j++) {
      var a=pool[i],b=pool[j];
      if((a.genres||[]).some(function(g){return (b.genres||[]).includes(g);}) && !seen.has([a.id,b.id].sort().join('|'))) pairs.push([a,b]);
    }
    if(!pairs.length)return null;
    previous=Array.isArray(previous)?previous:[];
    var fresh=pairs.filter(function(p){return !previous.includes(p[0].id)&&!previous.includes(p[1].id);});
    if(!fresh.length)fresh=pairs.filter(function(p){return !(previous.includes(p[0].id)&&previous.includes(p[1].id));});
    if(!fresh.length)fresh=pairs;
    var rng=random||Math.random, chosen=fresh[Math.min(fresh.length-1,Math.floor(rng()*fresh.length))];
    return rng()<.5?chosen:chosen.slice().reverse();
  }
  function recentReading(list) {
    function time(m){return Math.max(m.completedAt||0,m.lastRatedAt||0,readingProgress(m).updatedAt,...journal(m.journal).map(function(e){return e.ts;}));}
    return list.filter(function(m){return m.status!=='plan'&&m.status!=='dropped'&&(m.rated||m.status==='done'||readingProgress(m).updatedAt||journal(m.journal).length);}).slice().sort(function(a,b){return time(b)-time(a);}).slice(0,5);
  }
  function titleKey(s){return String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
  function unseenMedia(media,list){
    var ids=new Set(list.map(function(m){return String(m.anilistId||'');})),names=new Set();
    list.forEach(function(m){[m.title].concat(Object.values(m.altTitles||{})).forEach(function(s){if(titleKey(s))names.add(titleKey(s));});});
    return media.filter(function(m){return !ids.has(String(m.id)) && !Object.values(m.title||{}).concat(m.synonyms||[]).some(function(s){return names.has(titleKey(s));});});
  }

  var shopItems = [
    {id:'theme-dusk',kind:'theme',name:'Сумерки',price:150,icon:'☾',desc:'Лиловый закат и мягкое свечение'},
    {id:'theme-ocean',kind:'theme',name:'Глубина',price:250,icon:'≈',desc:'Холодные синие переливы'},
    {id:'theme-rose',kind:'theme',name:'Сакура',price:350,icon:'✿',desc:'Тёплый розовый свет'},
    {id:'theme-gold',kind:'theme',name:'Золотой час',price:600,icon:'☀',desc:'Янтарь и тёмное золото'},
    {id:'frame-orbit',kind:'frame',name:'Орбита',price:120,icon:'◎',desc:'Двойное кольцо вокруг аватара'},
    {id:'frame-frost',kind:'frame',name:'Иней',price:220,icon:'❄',desc:'Серебристая рамка с голубым светом'},
    {id:'frame-prism',kind:'frame',name:'Призма',price:400,icon:'◇',desc:'Переливы сиреневого и розового'},
    {id:'frame-crown',kind:'frame',name:'Корона',price:700,icon:'♛',desc:'Золотая рамка для любимого профиля'},
    {id:'badge-dreamer',kind:'badge',name:'Мечтатель',price:80,icon:'☁',desc:'Значок рядом с твоим именем'},
    {id:'badge-explorer',kind:'badge',name:'Искатель историй',price:180,icon:'✧',desc:'Для тех, кто всегда ищет новую историю'},
    {id:'badge-night',kind:'badge',name:'Ночной читатель',price:300,icon:'☾',desc:'Ещё одна глава перед сном'},
    {id:'badge-legend',kind:'badge',name:'Хранитель историй',price:500,icon:'✦',desc:'Твоя личная коллекция впечатлений'}
  ];
  shopItems.forEach(function(item){item.rarity=item.price>=500?'legendary':item.price>=300?'epic':item.price>=180?'rare':'common';});
  shopItems.push(
    {id:'theme-celestial',kind:'theme',name:'Небесная библиотека',price:1200,rarity:'legendary',icon:'✦',image:'assets/shop/celestial-library.webp',desc:'Библиотека среди звёзд и золотых созвездий'},
    {id:'theme-garden',kind:'theme',name:'Сад фонарей',price:900,rarity:'epic',icon:'✿',image:'assets/shop/lantern-garden.webp',desc:'Сакура, тихий пруд и вечерние огни'},
    {id:'theme-aurora',kind:'theme',name:'Полярное сияние',price:650,rarity:'epic',icon:'≈',desc:'Ленты бирюзы на ночном небе'},
    {id:'theme-ink',kind:'theme',name:'Чернильный шёлк',price:280,rarity:'rare',icon:'◈',desc:'Графитовая текстура и серебряные линии'},
    {id:'frame-celestial',kind:'frame',name:'Лунный артефакт',price:1100,rarity:'legendary',icon:'☾',image:'assets/shop/celestial-frame.webp',desc:'Золотая филигрань и лунный аметист'},
    {id:'frame-petals',kind:'frame',name:'Лепестки',price:450,rarity:'epic',icon:'✿',desc:'Розовое сияние и цветочный контур'},
    {id:'frame-eclipse',kind:'frame',name:'Затмение',price:750,rarity:'legendary',icon:'◐',desc:'Тёмный обод с огненным ореолом'},
    {id:'frame-silver',kind:'frame',name:'Серебряная нить',price:160,rarity:'common',icon:'◇',desc:'Тонкая геометрическая рамка'},
    {id:'badge-sakura',kind:'badge',name:'Ловец мгновений',price:200,rarity:'rare',icon:'✿',desc:'Красота истории в маленьких деталях'},
    {id:'badge-moon',kind:'badge',name:'Под луной',price:380,rarity:'epic',icon:'☽',desc:'Для тихих вечеров с любимым тайтлом'},
    {id:'badge-phoenix',kind:'badge',name:'Феникс',price:800,rarity:'legendary',icon:'♜',desc:'Каждая новая история — новое начало'},
    {id:'badge-quill',kind:'badge',name:'Перо критика',price:140,rarity:'common',icon:'✒',desc:'Для тех, кто бережёт свои впечатления'}
  );
  shopItems.push(
{"id":"theme-rain","kind":"theme","name":"Дождливый переулок","price":700,"rarity":"epic","icon":"☂","image":"assets/shop/theme-rain.webp","desc":"Книжный магазин, тёплые окна и ночной дождь"},
{"id":"theme-forest","kind":"theme","name":"Лесная читальня","price":950,"rarity":"epic","icon":"❦","image":"assets/shop/theme-forest.webp","desc":"Светлячки и книги под древними деревьями"},
{"id":"frame-tide","kind":"frame","name":"Серебряный прилив","price":650,"rarity":"epic","icon":"≈","image":"assets/shop/frame-tide.webp","desc":"Серебряные волны и бирюзовые жемчужины"},
{"id":"frame-vine","kind":"frame","name":"Изумрудный плющ","price":550,"rarity":"epic","icon":"❧","image":"assets/shop/frame-vine.webp","desc":"Бронзовые ветви, листья и янтарный кристалл"},
{"id":"badge-fox","kind":"badge","name":"Книжный лис","price":300,"rarity":"rare","icon":"✧","image":"assets/shop/badge-fox.webp","desc":"Маленький спутник уютных историй"},
{"id":"badge-dragon","kind":"badge","name":"Дракон библиотеки","price":500,"rarity":"epic","icon":"✦","image":"assets/shop/badge-dragon.webp","desc":"Хранитель книг и больших приключений"},
{"id":"theme-slate","kind":"theme","name":"Тихий графит","price":60,"rarity":"common","icon":"◈","desc":"Спокойные серые тона и тонкая фактура"},
{"id":"theme-coffee","kind":"theme","name":"Кофейная пауза","price":80,"rarity":"common","icon":"☕","desc":"Тёплые оттенки какао и сливок"},
{"id":"theme-lavender","kind":"theme","name":"Лавандовый вечер","price":100,"rarity":"common","icon":"❋","desc":"Мягкая дымка на фиолетовом фоне"},
{"id":"theme-seafoam","kind":"theme","name":"Морской туман","price":120,"rarity":"common","icon":"≋","desc":"Приглушённая бирюза и прохладный свет"},
{"id":"frame-chalk","kind":"frame","name":"Белый контур","price":40,"rarity":"common","icon":"○","desc":"Чистая светлая линия вокруг аватара"},
{"id":"frame-copper","kind":"frame","name":"Медный обод","price":60,"rarity":"common","icon":"◎","desc":"Тёплая медь без лишних деталей"},
{"id":"frame-denim","kind":"frame","name":"Синий штрих","price":80,"rarity":"common","icon":"◉","desc":"Глубокий синий с тонким светлым краем"},
{"id":"frame-lilac","kind":"frame","name":"Лиловая нить","price":100,"rarity":"common","icon":"◌","desc":"Нежная двойная линия"},
{"id":"badge-bookmark","kind":"badge","name":"Закладка","price":40,"rarity":"common","icon":"▱","desc":"Место для следующей главы"},
{"id":"badge-tea","kind":"badge","name":"Чай и главы","price":60,"rarity":"common","icon":"☕","desc":"Самый уютный читательский ритуал"},
{"id":"badge-spark","kind":"badge","name":"Искра интереса","price":80,"rarity":"common","icon":"✧","desc":"Каждая история начинается с любопытства"},
{"id":"badge-compass","kind":"badge","name":"Свой маршрут","price":100,"rarity":"common","icon":"⌖","desc":"Выбирай истории в своём темпе"}
  );
  shopItems.push(
    {id:'theme-freefall',kind:'theme',name:'Свободное падение',price:0,rarity:'exclusive',exclusive:true,icon:'☁',image:'assets/shop/theme-freefall.webp',desc:'Личное небо владельца: лазурь, облака и свобода'},
    {id:'frame-freefall',kind:'frame',name:'Облачный поток',price:0,rarity:'exclusive',exclusive:true,icon:'❧',image:'assets/shop/frame-freefall.webp',desc:'Серебряный ветер и крылья из облаков'},
    {id:'badge-owner',kind:'badge',name:'owner',price:0,rarity:'exclusive',exclusive:true,icon:'♛',desc:'Личный знак владельца AM Tracker'}
  );
  var shopRarities={common:'Обычная',rare:'Редкая',epic:'Эпическая',legendary:'Легендарная',exclusive:'Эксклюзивная'};
  halloweenQuests.forEach(function(q){var kind=q.reward.split('-')[0],names={'badge-h26-pumpkin':'Искра Хэллоуина','frame-h26-thorns':'Терновый фонарь','theme-h26-harvest':'Тыквенная долина','badge-h26-bat':'Друг теней','theme-h26-manor':'Особняк лунных историй','frame-h26-spectral':'Призрачный ореол','badge-h26-keeper':'Хранитель Ночи'};shopItems.push({id:q.reward,kind:kind,name:names[q.reward],price:0,rarity:'exclusive',eventOnly:q.id,icon:q.icon,image:kind==='badge'?'assets/shop/halloween-'+q.reward.split('-').pop()+'.svg':undefined,desc:'Награда события «Ночь историй · 2026». Остаётся навсегда.'});});
  function shopItem(id){return shopItems.find(function(i){return i.id===id;});}
  function cleanShop(raw,xp){
    raw=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
    var budget=Number.isFinite(xp)?Math.max(0,Math.floor(xp)):0,out={};
    Object.keys(raw).filter(function(id){return shopItem(id)&&!shopItem(id).exclusive&&!shopItem(id).eventOnly&&Number.isFinite(raw[id])&&raw[id]>0;}).sort(function(a,b){return raw[a]-raw[b]||a.localeCompare(b);}).forEach(function(id){var cost=shopItem(id).price;if(cost<=budget){out[id]=raw[id];budget-=cost;}});
    return out;
  }
  function mergeShop(a,b,xp){
    var union={};[a,b].forEach(function(raw){Object.keys(raw||{}).forEach(function(id){if(!shopItem(id)||shopItem(id).exclusive||shopItem(id).eventOnly||!Number.isFinite(raw[id])||raw[id]<=0)return;union[id]=union[id]?Math.min(union[id],raw[id]):raw[id];});});
    return cleanShop(union,xp);
  }
  function coinBalance(xp,owned){return Math.max(0,Math.floor(Number.isFinite(xp)?xp:0)-Object.keys(cleanShop(owned,xp)).reduce(function(n,id){return n+shopItem(id).price;},0));}
  function cleanStyle(raw){var out={};['theme','frame','badge'].forEach(function(k){var item=raw&&shopItem(raw[k]);out[k]=item&&item.kind===k?item.id:'';});return out;}


  var shopCollections=[
    {id:'celestial',name:'Лунная библиотека',text:'Золото созвездий и лунный свет',items:['theme-celestial','frame-celestial','badge-moon']},
    {id:'forest',name:'Хранители леса',text:'Изумрудные листья и маленький дракон',items:['theme-forest','frame-vine','badge-dragon']},
    {id:'tide',name:'Морская история',text:'Прохладная глубина и серебряные волны',items:['theme-ocean','frame-tide','badge-explorer']},
    {id:'sakura',name:'Весенние страницы',text:'Цветущая сакура и нежные лепестки',items:['theme-garden','frame-petals','badge-sakura']},
    {id:'cozy',name:'Тихий вечер',text:'Кофейные оттенки, медь и чай',items:['theme-coffee','frame-copper','badge-tea']}
  ];
  function monthlyRecap(key,list,log,achievements,definitions,xpValues,score){
    function inPeriod(ts){return Number.isFinite(ts)&&month(ts).slice(0,key.length)===key;}
    var entries=[],best=[];
    list.forEach(function(m){
      journal(m.journal).filter(function(e){return inPeriod(e.ts);}).forEach(function(e){entries.push({title:title(m),titleId:m.id,chapter:e.chapter,rating:e.rating,ts:e.ts});});
      var rating=key.length===4?(m.rated?ratings(m,score).filter(function(r){return inPeriod(r.ts);}).sort(function(a,b){return b.ts-a.ts;})[0]:null):ratingInMonth(m,key,score);if(rating)best.push({title:title(m),score:score(rating.criteria),id:m.id});
    });
    best.sort(function(a,b){return b.score-a.score||a.title.localeCompare(b.title);});
    var chapterBest=entries.filter(function(e){return e.rating;}).sort(function(a,b){return b.rating-a.rating||b.ts-a.ts;})[0]||null;
    var events=log.filter(function(e){return inPeriod(e.ts);});
    var unlocked=definitions.filter(function(a){return inPeriod(achievements[a.id]);});
    var xp=events.reduce(function(n,e){return n+(Number.isFinite(e.xp)?Math.max(0,e.xp):(xpValues[e.type]||0));},0)+unlocked.reduce(function(n,a){return n+(a.xp||0);},0);
    var done=new Set(list.filter(function(m){return inPeriod(m.completedAt);}).map(function(m){return m.id;}));
    events.filter(function(e){return e.type==='status'&&e.extra&&e.extra.status==='done';}).forEach(function(e){done.add(e.manhwaId);});
    return {key:key,chapters:new Set(entries.map(function(e){return JSON.stringify([e.titleId,e.chapter]);})).size,notes:entries.length,finished:done.size,goals:unlocked.filter(function(a){return a.id.indexOf('goal_reward_')===0;}).length,xp:xp,best:best[0]||null,chapterBest:chapterBest};
  }
  function createMonthlyCard(data,nick,label){
    var canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1350;var g=canvas.getContext('2d');
    if(!g)return Promise.reject(new Error('Canvas unavailable'));
    var bg=g.createLinearGradient(0,0,1080,1350);bg.addColorStop(0,'#30223f');bg.addColorStop(1,'#111824');g.fillStyle=bg;g.fillRect(0,0,1080,1350);
    g.fillStyle='#c4b2ed';g.font='700 25px sans-serif';g.fillText(data.key.length===4?'AM TRACKER / МОЙ ГОД':'AM TRACKER / МОЙ МЕСЯЦ',64,88);
    g.fillStyle='#f2ecdf';g.font='54px serif';drawText(g,label,64,180,952,64,2);
    g.fillStyle='#b9aec6';g.font='26px sans-serif';drawText(g,nick,64,280,952,34,1);
    [[data.chapters,'глав в дневнике'],[data.finished,'завершено тайтлов'],[data.goals,'целей выполнено'],[data.xp,'XP и столько же монет']].forEach(function(pair,i){
      var x=64+(i%2)*490,y=345+Math.floor(i/2)*200;g.fillStyle='#ffffff0c';g.fillRect(x,y,462,170);
      g.fillStyle='#ead09b';g.font='700 60px sans-serif';g.fillText(String(pair[0]),x+28,y+78);
      g.fillStyle='#d2c6de';g.font='23px sans-serif';drawText(g,pair[1],x+28,y+125,410,28,1);
    });
    g.fillStyle='#c4b2ed';g.font='700 23px sans-serif';g.fillText(data.key.length===4?'ВЫСШАЯ ОЦЕНКА ГОДА':'ТАЙТЛ МЕСЯЦА',64,810);
    g.fillStyle='#f2ecdf';g.font='38px serif';drawText(g,data.best?data.best.title+' · '+Math.round(data.best.score)+'/100':'Пока нет оценённых тайтлов',64,870,952,47,2);
    g.fillStyle='#c4b2ed';g.font='700 23px sans-serif';g.fillText('ЛЮБИМАЯ ГЛАВА',64,1030);
    g.fillStyle='#f2ecdf';g.font='32px serif';drawText(g,data.chapterBest?data.chapterBest.title+' · глава '+data.chapterBest.chapter+' · '+data.chapterBest.rating+'/10':'Пока нет оценок глав',64,1086,952,42,2);
    g.fillStyle='#a89cb7';g.font='21px sans-serif';drawText(g,'По сохранённой истории. Главы учитываются по записям дневника.',64,1260,952,28,2);
    return new Promise(function(resolve,reject){canvas.toBlob(function(blob){if(blob)resolve(blob);else reject(new Error('PNG unavailable'));},'image/png');});
  }

  var api = {readingProgress:readingProgress,readingUrl:readingUrl,chapterScores:chapterScores,hasChapterRating:hasChapterRating,cleanFeedback:cleanFeedback,aniListVariables:aniListVariables,halloweenQuests:halloweenQuests,halloweenWindow:halloweenWindow,halloweenProgress:halloweenProgress,shopCollections:shopCollections,monthlyRecap:monthlyRecap,createMonthlyCard:createMonthlyCard,goalRewardXp:goalRewardXp,shopRarities:shopRarities, shopItems:shopItems, shopItem:shopItem, cleanShop:cleanShop, mergeShop:mergeShop, coinBalance:coinBalance, cleanStyle:cleanStyle, recentReading:recentReading, unseenMedia:unseenMedia, goalOptions:goalOptions, journal:journal, goalKeys:goalKeys, cleanJourney:cleanJourney,  duelPair:duelPair,  annualAwards: annualAwards, ratings: ratings, ratingInMonth: ratingInMonth, comparison: comparison, continueReading: continueReading,
    awardSnapshot: awardSnapshot, createShareCard: createShareCard, textLines: textLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AMFeatures = api;
})(typeof window !== "undefined" ? window : globalThis);
