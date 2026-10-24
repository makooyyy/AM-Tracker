const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(saved = new Map()) {
  const elements = new Map();
  function element(attrs = {}) {
    return {
      attrs, style: {}, handlers: {}, value: '', textContent: '',
      addEventListener(name, fn) { this.handlers[name] = fn; },
      getAttribute(name) { return this.attrs[name]; },
      hasAttribute(name) { return name in this.attrs; },
      querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; }, focus() {}, scrollIntoView() {},
      set innerHTML(html) {
        this.html = html;
        if (this === app) elements.clear();
        for (const match of html.matchAll(/<[^>]*?\sid="([^"]+)"[^>]*>/g)) {
          const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(x => [x[1],x[2]]));
          elements.set(match[1], element(attrs));
        }
      },
      get innerHTML() { return this.html || ''; }
    };
  }
  const app = element();
  const fail = new Set();
  const context = vm.createContext({
    console, URL, setTimeout() {}, clearTimeout() {}, navigator: {},
    document: {
      getElementById(id) { return id === 'app' ? app : elements.get(id) || null; }, activeElement: null,
      createElement() { return { textContent: '', get innerHTML() {
        return String(this.textContent).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      } }; }
    },
    window: { AM_CHANGELOG: [], scrollTo() {}, localStorage: {
      setItem(k,v) { if (fail.has(k)) throw Error('quota'); saved.set(k,v); },
      getItem(k) { return saved.get(k) || null; }
    } }
  });
  vm.runInContext(fs.readFileSync('features.js','utf8'), context);
  let source = fs.readFileSync('app.js','utf8');
  source = source.slice(0, source.indexOf('  /* ---------- boot ---------- */')) + `
    idbAvailable = false;
    window.testApi = { escapeHtml, sanitizeImportedActivityLog, bridge: window.AMApp, saveProfile, loadProfile, buyShopItem, equipShopItem, activeStyle, loadShop, saveShop, logActivity, state, newManhwa, beginRerating, editableManhwa, commitRerating,
      cancelRerating, saveRatingDrafts, loadRatingDrafts, save, goBack, render,
      renderLibrary, renderProfile, aggregateCriteria, sortedManhwas, ratedScore,
      sanitizeImportedManhwa,
      setWinner, getWinner, normalizeWinners, purgeAwardReferences, championsForYear,
      eligibleForMonth, lastCompletedMonthKey, renderAwardsTab, renderComparison, renderYearSummary, yearsWithData,
      openTitle, loadRecentOpened, ACHIEVEMENTS, achievementMetrics, achievementProgress, renderAchievementsTab, checkAchievements,
      persistKey, retryFailedWrites, failedWrites, storageNoticeHtml,
      flush: async function () { await Promise.all(Object.values(storageWrites).map(p => p.catch(() => {}))); },
      setWriter: function (fn) { idbAvailable = true; idbSet = fn; },
      keys: { titles: STORAGE_KEY, drafts: RATING_DRAFTS_KEY, profile: PROFILE_STORAGE_KEY,
        awards: AWARDS_STORAGE_KEY, xp: XP_STORAGE_KEY, log: ACTIVITY_LOG_STORAGE_KEY, achievements: ACHIEVEMENTS_STORAGE_KEY }
    };
  })();`;
  vm.runInContext(source, context);
  return { api: context.window.testApi, saved, fail, app, elements };
}
function addRated(api, score = 8) {
  const m = api.newManhwa('Rated title');
  m.rated = true; m.emotionRating = 4; m.lastRatedAt = 1700000000000;
  m.criteria.forEach(c => c.score = score);
  api.state.manhwas.push(m);
  return m;
}

test('rerating stays local as a draft, survives back and reload, and cancels without changing the rating', async () => {
  const h = harness(), a = h.api, m = addRated(a);
  a.beginRerating(m.id);
  a.editableManhwa(m.id).criteria[0].score = 2;
  a.editableManhwa(m.id).notes = 'Draft review';
  a.state.selectedId = m.id;
  a.save(); a.goBack(); await a.flush();
  assert.equal(m.criteria[0].score, 8);
  assert.equal(m.notes, '');
  assert.equal(m.ratingHistory.length, 0);
  assert.equal(JSON.parse(h.saved.get(a.keys.titles))[0].criteria[0].score, 8);
  const reopened = harness(h.saved).api;
  reopened.state.manhwas = JSON.parse(h.saved.get(a.keys.titles));
  await reopened.loadRatingDrafts();
  assert.equal(reopened.editableManhwa(m.id).criteria[0].score, 2);
  assert.equal(reopened.editableManhwa(m.id).notes, 'Draft review');
  reopened.state.selectedId = m.id; reopened.render();
  reopened.cancelRerating(m.id); await reopened.flush();
  assert.equal(reopened.editableManhwa(m.id).criteria[0].score, 8);
  assert.equal(Object.keys(reopened.state.ratingDrafts).length, 0);
});

test('Save rerating button commits exactly one previous rating and clears draft', async () => {
  const h = harness(), a = h.api, m = addRated(a);
  a.state.selectedId = m.id; a.render();
  h.elements.get('rerate-btn').handlers.click();
  a.editableManhwa(m.id).criteria[0].score = 3;
  a.render();
  h.elements.get('rating-confirm').checked = true; h.elements.get('finish-rating-btn').handlers.click();
  await a.flush();
  assert.equal(m.criteria[0].score, 3);
  assert.equal(m.ratingHistory.length, 1);
  assert.equal(m.ratingHistory[0].criteria[0].score, 8);
  assert.equal(m.ratingHistory[0].ts, 1700000000000);
  assert.equal(Object.keys(a.state.ratingDrafts).length, 0);
  assert.equal(a.state.activityLog.filter(e => e.type === 'rerated').length, 1);
  assert.equal(a.commitRerating(m.id), null);
});

test('remote rating change is preserved when committing a stale draft', async () => {
  const {api:a} = harness(), m = addRated(a);
  a.beginRerating(m.id); a.editableManhwa(m.id).criteria[0].score = 2;
  m.criteria[0].score = 9;
  assert.equal(a.commitRerating(m.id), false);
  assert.equal(m.criteria[0].score, 9);
  assert.equal(m.ratingHistory.length, 0);
  await a.flush();
});

test('unrated titles are excluded from averages, radar and rankings and display an unrated badge', () => {
  const {api:a} = harness(), rated = addRated(a, 4);
  const fresh = a.newManhwa('Unrated title');
  a.state.manhwas.push(fresh);
  assert.equal(a.ratedScore(fresh), null);
  assert.ok(a.aggregateCriteria().every(c => c.score === 4 && c.count === 1));
  a.state.sortMode = 'rating';
  assert.equal(a.sortedManhwas()[0].id, rated.id);
  assert.match(a.renderLibrary(), /Не оценено/);
  const profile = a.renderProfile();
  assert.match(profile, />40<\/div><div class="mt-chip-label">средняя оценка/);
  assert.ok(!profile.includes('Unrated title'));
});

test('errors for every user dataset remain visible until successfully retried', async () => {
  const h = harness(), a = h.api;
  for (const key of Object.values(a.keys)) {
    h.fail.add(key);
    await assert.rejects(a.persistKey(key, { value: key }));
  }
  a.state.tab = 'achievements'; a.render();
  assert.match(h.elements.get('storage-notice').innerHTML, /Повторить сохранение/);
  await a.retryFailedWrites();
  assert.equal(Object.keys(a.failedWrites).length, Object.keys(a.keys).length);
  h.fail.clear();
  await a.retryFailedWrites();
  assert.equal(Object.keys(a.failedWrites).length, 0);
  for (const key of Object.values(a.keys)) assert.equal(JSON.parse(h.saved.get(key)).value, key);
});

test('legacy imported ratings still count; a completely unrated library has no rating average', () => {
  const {api:a} = harness();
  const legacy = a.newManhwa('Legacy'); delete legacy.rated;
  assert.equal(a.ratedScore(a.sanitizeImportedManhwa(legacy, {})), 50);
  a.state.manhwas.push(a.newManhwa('Not rated'));
  assert.equal(a.aggregateCriteria().length, 0);
  assert.match(a.renderProfile(), />—<\/div><div class="mt-chip-label">средняя оценка/);
  assert.ok(!a.renderProfile().includes('ТОП ПО ОЦЕНКЕ'));
});

test('writes snapshot values and serialize updates; retry never restores an older value', async () => {
  const h = harness(), a = h.api, key = a.keys.profile;
  h.fail.add(key); await assert.rejects(a.persistKey(key, {n:'old'}));
  let release;
  a.setWriter((k,v) => new Promise(resolve => { release = () => { h.saved.set(k,JSON.stringify(v)); resolve(); }; }));
  const value = {n:'new'};
  const writing = a.persistKey(key,value); value.n = 'mutated later';
  const retry = a.retryFailedWrites();
  await new Promise(resolve => setImmediate(resolve));
  release(); await writing; await retry;
  assert.equal(JSON.parse(h.saved.get(key)).n, 'new');
  assert.equal(Object.keys(a.failedWrites).length, 0);
});

test('reading shelf remembers opened titles across reload and excludes completed titles', async () => {
  const h = harness(), a = h.api, m = addRated(a);
  a.openTitle(m.id); await a.flush(); a.goBack();
  assert.match(a.renderLibrary(), /Продолжить читать/);
  const b = harness(h.saved).api; b.state.manhwas = [m]; await b.loadRecentOpened();
  assert.ok(b.state.recentOpened[m.id] > 0);
  m.status = 'done';
  assert.ok(!b.renderLibrary().includes('Продолжить читать'));
});

test('rerating captures review and reason, and compares added and removed criteria', async () => {
  const h = harness(), a = h.api, m = addRated(a);
  m.notes = 'Original review'; m.ratingReason = 'Original reason';
  a.beginRerating(m.id); const d = a.editableManhwa(m.id);
  d.notes = 'New review'; d.ratingReason = 'New chapters';
  d.criteria[0].score = 10; d.criteria.pop(); d.criteria.push({id:'extra',name:'Translation',score:9});
  a.state.selectedId = m.id; a.render(); h.elements.get('rating-confirm').checked = true; h.elements.get('finish-rating-btn').handlers.click();
  assert.equal(m.ratingHistory[0].notes, 'Original review');
  assert.equal(m.ratingHistory[0].reason, 'Original reason');
  assert.equal(m.ratingReason, 'New chapters');
  const html = a.renderComparison(m);
  assert.match(html, /New chapters/); assert.match(html, /Новый/); assert.match(html, /Убран/);
  await a.flush();
});

test('award snapshots survive rerating, renaming, deleting and backup normalization', async () => {
  const {api:a} = harness(), m = addRated(a), key = a.lastCompletedMonthKey();
  m.lastRatedAt = new Date(key+'-15T12:00:00').getTime(); m.coverUrl = 'https://example.com/old.png';
  a.state.awardCandidates[key] = {overall:[m.id]};
  assert.equal(a.setWinner(key,'overall',m.id), true);
  assert.equal(a.setWinner(key,'overall',m.id), false);
  m.title = 'Changed'; m.coverUrl = 'https://example.com/new.png'; m.criteria[0].score = 1;
  a.purgeAwardReferences(m.id); a.state.manhwas = [];
  a.state.awardWinners = a.normalizeWinners(JSON.parse(JSON.stringify(a.state.awardWinners)));
  const w = a.getWinner(key,'overall');
  assert.equal(w.title,'Rated title'); assert.equal(w.avg,80);
  assert.equal(w.coverUrl,'https://example.com/old.png'); assert.equal(w.criteria[0].score,8);
  assert.equal(a.championsForYear(Number(key.slice(0,4)))[0].manhwa.title,'Rated title');
  await a.flush();
});

test('historic rating remains eligible in its original month and archive is read-only', async () => {
  const {api:a} = harness(), m = addRated(a), key = a.lastCompletedMonthKey();
  const old = new Date(key+'-15T12:00:00').getTime();
  m.ratingHistory = [{ts:old,avg:60,criteria:m.criteria.map(c=>({...c,score:6}))}];
  m.lastRatedAt = Date.now();
  assert.equal(a.eligibleForMonth(key)[0].criteria[0].score,6);
  a.state.awardWinners['2020-01'] = {overall:m.id};
  a.state.awardWinners = a.normalizeWinners(a.state.awardWinners);
  a.state.awardsMonth = '2020-01';
  const html = a.renderAwardsTab();
  assert.match(html,/АРХИВ ПРЕМИИ/); assert.ok(!html.includes('data-pick-winner'));
  assert.equal(a.setWinner('2020-01','overall',m.id),false);
  assert.equal(a.getWinner('2020-01','overall').legacy,true);
  await a.flush();
});

test('comparison calculates signed deltas and handles zero change', () => {
  const f = require('../features.js');
  const d = f.comparison({avg:72,criteria:[{name:'Plot',score:7},{name:'Art',score:8}]},
    {avg:86,criteria:[{name:'Plot',score:9},{name:'Art',score:8}]});
  assert.equal(d.delta,14); assert.equal(d.rows[0].delta,2); assert.equal(d.rows[1].delta,0);
});

test('annual awards share tied places, exclude anti-awards and unfinished months, and preserve snapshots', () => {
  const f = require('../features.js');
  const a = {id:'a',title:'Alpha',avg:80,awardSnapshot:1}, b = {id:'b',title:'Beta',avg:90,awardSnapshot:1};
  const winners = {'2025-01':{overall:a,Art:a,Plot:b,worst:b},'2025-02':{overall:b,Art:b,Plot:a},'2026-01':{overall:a}};
  const data = f.annualAwards(winners,2025,new Date(2026,1,1).getTime());
  assert.equal(data.awardCount,6);
  assert.equal(data.leaders.length,2);
  assert.deepEqual(data.ranking.map(r=>r.place),[1,1]);
  assert.equal(data.categories.Art.length,2);
  assert.equal(data.months['2025-01'].count,3);
  assert.equal(data.leaders[0].winner.month,'2025-02');
  a.title = 'Renamed'; assert.equal(data.leaders[0].winner.title,'Alpha');
  const unfinished = f.annualAwards(winners,2025,new Date(2025,1,15).getTime());
  assert.equal(unfinished.awardCount,3);
  assert.equal(unfinished.leaders[0].winner.id,'a');
  assert.equal(f.annualAwards({},2025).ranking.length,0);
});

test('annual recap uses historical scores from the selected year, even for titles added earlier', () => {
  const {api:a} = harness(), m = addRated(a);
  m.createdAt = new Date(2020,1,1).getTime(); m.lastRatedAt = new Date(2026,1,1).getTime();
  m.ratingHistory = [{ts:new Date(2024,4,1).getTime(),avg:60,criteria:m.criteria.map(c=>({...c,score:6}))},
    {ts:new Date(2024,8,1).getTime(),avg:70,criteria:m.criteria.map(c=>({...c,score:7}))}];
  a.state.awardsYear = 2024;
  assert.ok(a.yearsWithData().includes(2024));
  assert.match(a.renderYearSummary(), /<strong>70<\/strong><span>средняя оценка года/);
  assert.match(a.renderYearSummary(), /Оценено тайтлов: 1/);
});

test('achievement progress measures targets, preserves earned medals and never grants XP on render', () => {
  const {api:a} = harness();
  for (let i=0;i<6;i++) addRated(a);
  const collection = a.ACHIEVEMENTS.find(x=>x.id==='collect_10');
  let progress = a.achievementProgress(collection,a.achievementMetrics());
  assert.equal(progress.current,6); assert.equal(progress.target,10); assert.equal(progress.fraction,.6);
  a.state.unlockedAchievements.collect_10 = 1700000000000;
  a.state.manhwas = [];
  progress = a.achievementProgress(collection,a.achievementMetrics());
  assert.equal(progress.current,10); assert.equal(progress.unlocked,true);
  const xp = a.state.totalXp, medals = JSON.stringify(a.state.unlockedAchievements);
  assert.match(a.renderAchievementsTab(), /ПАСПОРТ ЧИТАТЕЛЯ/);
  assert.equal(a.state.totalXp,xp); assert.equal(JSON.stringify(a.state.unlockedAchievements),medals);
  a.state.achievementFilter='earned'; a.state.achievementCategory='Библиотека';
  assert.match(a.renderAchievementsTab(), /Показано: 1/);
});

test('40 new achievements use consistent metrics and award XP only once', async () => {
  const {api:a} = harness();
  assert.equal(a.ACHIEVEMENTS.length,107);
  assert.equal(new Set(a.ACHIEVEMENTS.map(x=>x.id)).size,107);
  const m = addRated(a); m.notes = '   '; m.coverUrl = 'https://example.com/cover.png';
  m.ratingHistory = [{ts:1700000000000,avg:70,criteria:m.criteria}];
  a.state.activityLog = [{ts:1700000000000,type:'add'},{ts:1700000001000,type:'rated'}];
  let metrics = a.achievementMetrics();
  assert.equal(metrics.rerated,1); assert.equal(metrics.activeDays,1); assert.equal(metrics.covered,1); assert.equal(metrics.annotated,0);
  const newGoals = a.ACHIEVEMENTS.filter(x=>x.metric);
  assert.equal(newGoals.length,40);
  for (const goal of newGoals) {
    const p = a.achievementProgress(goal,metrics);
    assert.equal(goal.check(),metrics[goal.metric] >= goal.target);
    assert.equal(p.current,Math.min(metrics[goal.metric],goal.target));
  }
  a.checkAchievements(); const xp = a.state.totalXp;
  assert.ok(a.state.unlockedAchievements.journey_rerated_1);
  a.checkAchievements(); assert.equal(a.state.totalXp,xp);
  a.state.manhwas = []; a.checkAchievements();
  assert.ok(a.state.unlockedAchievements.journey_rerated_1);
  await a.flush();
});

const J = require('../features.js');
test('first rating requires confirmation and never grants XP on accidental save',async()=>{
 const h=harness(),a=h.api,m=a.newManhwa('Unrated');a.state.manhwas=[m];a.state.selectedId=m.id;a.render();
 const xp=a.state.totalXp;
 h.elements.get('finish-rating-btn').handlers.click();
 assert.equal(m.rated,false);assert.equal(a.state.totalXp,xp);
 assert.match(h.elements.get('rating-confirm-error').textContent,/подтверди/);
 h.elements.get('rating-confirm').checked=true;h.elements.get('finish-rating-btn').handlers.click();
 assert.equal(m.rated,true);await a.flush();
});
test('chapter draft survives render but is cleared with account data',async()=>{
 const h=harness(),a=h.api,m=addRated(a);a.state.selectedId=m.id;a.render();
 const input=h.elements.get('chapter-text');input.value='Private chapter draft';input.handlers.input();
 a.render();assert.equal(h.elements.get('chapter-text').value,'Private chapter draft');
 await a.bridge.wipeLocal();a.state.manhwas=[m];a.state.selectedId=m.id;a.render();
 assert.equal(h.elements.get('chapter-text').value,'');
});
test('reading links are safe and legacy chapter scores remain intact',()=>{
 assert.equal(J.readingUrl('javascript:alert(1)'),'');
 assert.equal(J.readingUrl('https://user:password@example.com'),'');
 assert.equal(J.readingUrl('https://senkuro.com/manga/test'),'https://senkuro.com/manga/test');
 const entries=[{id:'later',chapter:12,ts:200,rating:1},{id:'first',chapter:12,ts:100,rating:10},{id:'next',chapter:14,ts:300,text:'note'}];
 assert.equal(J.hasChapterRating(entries,12),true);assert.equal(J.hasChapterRating(entries,14),false);
 assert.deepEqual(J.chapterScores(entries).map(x=>x.id),['first']);assert.equal(entries.length,3);
 assert.equal(J.readingProgress({journal:entries}).chapter,14);
 assert.equal(J.readingProgress({journal:entries,reading:{chapter:5}}).chapter,5);
});
test('reading progress and recommendation feedback survive backup normalization and cloud roundtrip',async()=>{
 const a=harness().api,m=addRated(a);m.reading={chapter:42.5,url:'https://senkuro.com/manga/test',updatedAt:100};
 a.state.profile.journey={feedback:[{id:102,action:'like',ts:100,genres:['Фэнтези']}],goals:[],duels:[]};
 assert.deepEqual(JSON.parse(JSON.stringify(a.sanitizeImportedManhwa(m,{}).reading)),m.reading);
 const cloud=syncHarness();await cloud.engine(a).sync();const b=harness().api;await cloud.engine(b).sync();
 assert.deepEqual(JSON.parse(JSON.stringify(b.state.manhwas[0].reading)),m.reading);
 assert.equal(b.state.profile.journey.feedback[0].action,'like');
 assert.equal(J.cleanFeedback([{id:1,action:'hide',ts:1},{id:1,action:'read',ts:2},{id:2,action:'invalid',ts:3}]).length,1);
});
test('annual personal recap spans months and appears only for completed years, never in profile',()=>{
 const a=harness().api,y=new Date().getFullYear()-1,m=a.newManhwa('Year test');
 m.createdAt=new Date(y,0,1).getTime();m.journal=[{id:'a',chapter:1,text:'one',ts:new Date(y,0,5).getTime()},{id:'b',chapter:1,text:'again',ts:new Date(y,8,5).getTime()},{id:'c',chapter:2,rating:9,ts:new Date(y,11,31,23).getTime()},{id:'d',chapter:3,rating:10,ts:new Date(y+1,0,1).getTime()}];
 a.state.manhwas=[m];a.state.awardsYear=y;
 const d=J.monthlyRecap(String(y),[m],[],{},[],{},()=>0);assert.equal(d.chapters,2);assert.equal(d.chapterBest.rating,9);
 assert.match(a.renderYearSummary(),/recap-download/);assert.doesNotMatch(a.renderProfile(),/recap-download|recap-month/);
 m.createdAt=Date.now();a.state.awardsYear=y+1;assert.doesNotMatch(a.renderYearSummary(),/recap-download/);
});
test('AniList requests omit inactive filters rather than sending null',()=>{
 const raw={page:1,search:null,country:null,genre:'',status:undefined,sort:['POPULARITY_DESC','ID']};
 assert.deepEqual(J.aniListVariables(raw),{page:1,sort:['POPULARITY_DESC','ID']});
 assert.deepEqual(J.aniListVariables({...raw,search:'Solo Leveling',country:'KR'}),{page:1,search:'Solo Leveling',country:'KR',sort:['POPULARITY_DESC','ID']});
 assert.equal(raw.country,null);
});
test('Halloween uses event dates and unique chapters, excludes future and old activity',()=>{
 const now=new Date(2026,9,22,12).getTime(),ts=new Date(2026,9,20,12).getTime();
 const m={id:'a',rated:true,lastRatedAt:ts,genres:['Ужасы'],completedAt:ts,journal:[{id:'a',chapter:1,ts,text:'Note',rating:8},{id:'b',chapter:1,ts,text:'Again',rating:9},{id:'c',chapter:2,ts:new Date(2026,9,1).getTime(),text:'Old'},{id:'d',chapter:3,ts:now+1000,text:'Future'}]};
 const p=J.halloweenProgress([m],[],{},now);
 assert.equal(p.notes,1);assert.equal(p.ratings,1);assert.equal(p.dark,1);assert.equal(p.finished,1);assert.equal(p.days,1);
 assert.equal(J.halloweenWindow(new Date(2026,10,2,23,59).getTime()).active,true);
 assert.equal(J.halloweenWindow(new Date(2026,10,3).getTime()).active,false);
 assert.equal(J.halloweenWindow(new Date(2026,9,17).getTime()).upcoming,true);
});
test('Halloween cosmetics require earned quests and cannot be bought or imported as purchases',()=>{
 const a=harness().api,id='theme-h26-harvest';a.state.totalXp=10000;
 assert.equal(a.buyShopItem(id),false);assert.deepEqual(J.cleanShop({[id]:123},10000),{});
 a.state.profile.style={theme:id};assert.equal(a.activeStyle().theme,'');
 a.state.unlockedAchievements.h26_stories=123;assert.equal(a.activeStyle().theme,id);
});
test('different offline Halloween rewards merge once and preserve cosmetics',async()=>{
 const cloud=syncHarness(),a=harness().api,b=harness().api;
 a.state.totalXp=1060;a.state.unlockedAchievements={h26_lantern:12};
 b.state.totalXp=1100;b.state.unlockedAchievements={h26_stories:13};
 await cloud.engine(a).sync();await cloud.engine(b).sync();await cloud.engine(a).sync();
 assert.equal(a.state.totalXp,1160);assert.ok(a.state.unlockedAchievements.h26_stories);
 const c=harness().api;await cloud.engine(c).sync();assert.equal(c.state.totalXp,1160);
 assert.equal(J.goalRewardXp(Object.fromEntries(J.halloweenQuests.map(q=>[q.id,1]))),800);
});
test('monthly recap counts saved activity only within selected month',()=>{
 const ts=new Date(2026,8,15).getTime(),later=new Date(2026,9,1).getTime();
 const m={id:'a',title:'History',rated:true,criteria:[{score:40}],lastRatedAt:later,completedAt:ts,
 ratingHistory:[{ts,criteria:[{score:90}]}],journal:[{id:'1',chapter:1,ts,rating:8},{id:'2',chapter:1,ts:ts+1,text:'Note'},{id:'3',chapter:2,ts:later,rating:10}]};
 const data=J.monthlyRecap('2026-09',[m],[{ts,type:'rate',xp:20},{ts,type:'note'},{ts:later,type:'rate',xp:100},{ts,type:'status',manhwaId:'a',extra:{status:'done'}}],{goal_reward_test:ts,other:later},[{id:'goal_reward_test',xp:150},{id:'other',xp:500}],{note:5},c=>c[0].score);
 assert.equal(data.chapters,1);assert.equal(data.finished,1);assert.equal(data.goals,1);assert.equal(data.xp,175);
 assert.equal(data.best.score,90);assert.equal(data.chapterBest.rating,8);
 const empty=J.monthlyRecap('2025-01',[m],[],{},[],{},c=>c[0].score);
 assert.equal(empty.xp,0);assert.equal(empty.best,null);assert.equal(empty.chapterBest,null);
});
test('shop collections contain valid public theme frame and badge',()=>{
 for(const set of J.shopCollections){
  const items=set.items.map(J.shopItem);assert.ok(items.every(i=>i&&!i.exclusive));
  assert.deepEqual(items.map(i=>i.kind).sort(),['badge','frame','theme']);
 }
});
test('profile outfits sanitize duplicates and survive cloud roundtrip',async()=>{
 const a=harness().api,cloud=syncHarness();
 const outfit={id:'night',name:'Night',a:{t:'letter',c:1},style:{theme:'theme-forest'}};
 a.state.profile=a.bridge.sanitizeProfile({outfits:[outfit,outfit,{id:'',name:'Bad'}]});
 assert.equal(a.state.profile.outfits.length,1);
 await cloud.engine(a).sync();const b=harness().api;await cloud.engine(b).sync();
 assert.equal(b.state.profile.outfits[0].name,'Night');assert.equal(b.state.profile.outfits[0].style.theme,'theme-forest');
 assert.equal(b.state.profile.outfits[0].a.t,'letter');
});
test('duels avoid repeats in either direction, filter by genre and handle exhausted pools',()=>{
  const list=[{id:'a',rated:true,genres:['Драма']},{id:'b',rated:true,genres:['Драма']},{id:'c',rated:false}];
  assert.equal(J.duelPair(list,[],'Драма',0).length,2);
  assert.equal(J.duelPair(list,[{a:'b',b:'a',winner:'b'}],'',0),null);
  assert.equal(J.duelPair(list,[],'Комедия',0),null);
});
test('journal validation and goal snapshots exclude existing results and duplicate genres',()=>{
  assert.deepEqual(J.journal([null,{id:'x',text:'x',chapter:-1,ts:1}]),[]);
  const list=[{id:'a',status:'done',rated:true,genres:['Драма','Драма'],journal:[{id:'n',text:'note',chapter:1,ts:1}]}];
  assert.deepEqual(J.goalKeys(list,'done'),['a']);
  assert.deepEqual(J.goalKeys(list,'genres'),['Драма']);
  assert.deepEqual(J.goalKeys(list,'journal'),['a:n']);
  assert.deepEqual(J.cleanJourney({goals:[{id:'bad',started:1}],duels:[{a:'a',b:'a',winner:'a'}]}),{feedback:[],goals:[],duels:[]});
});

test('chosen goals count only new results, persist progress and survive backup sanitization', async()=>{
  const {api,saved}=harness();const m=addRated(api);m.status='reading';
  api.state.profile.journey={goals:[{id:'finish3',started:Date.now(),baseline:[],earned:[]}],duels:[{a:m.id,b:'other',winner:m.id}]};
  m.status='done';api.save();await api.flush();
  assert.equal(api.state.profile.journey.goals[0].earned.length,1);
  api.save();await api.flush();assert.equal(api.state.profile.journey.goals[0].earned.length,1);
  api.state.manhwas=[];api.save();await api.flush();assert.equal(api.state.profile.journey.goals[0].earned.length,1);
  const stored=JSON.parse(saved.get(api.keys.profile));assert.equal(stored.journey.goals[0].earned.length,1);
  const clean=api.sanitizeImportedManhwa({...m,journal:[{id:'note',ts:1,chapter:74,text:'Текст',spoiler:true}]},{});
  assert.equal(clean.journal[0].chapter,74);
});

test('random duels share a genre and replace both participants when possible',()=>{
  const list=['a','b','c','d'].map(id=>({id,rated:true,genres:['Фэнтези']}));
  list.push({id:'e',rated:true,genres:['Спорт']});
  const pair=J.duelPair(list,[],'',['a','b'],()=>0);
  assert.deepEqual(pair.map(m=>m.id),['c','d']);
  assert.equal(J.duelPair([{id:'a',rated:true,genres:['Фэнтези']},{id:'b',rated:true,genres:['Спорт']}],[],'',[],()=>0),null);
  assert.notDeepEqual(J.duelPair(list,[],'',[],()=>0).map(m=>m.id).sort(),J.duelPair(list,[],'',[],()=>.99).map(m=>m.id).sort());
});
test('discovery uses latest reading and excludes saved IDs, translations and aliases',()=>{
  const list=[{id:'a',title:'Поднятие уровня в одиночку',rated:true,status:'done',completedAt:20},{id:'b',title:'Other',status:'reading',journal:[{id:'n',text:'t',chapter:1,ts:30}]},{id:'c',title:'Plan',rated:true,status:'plan',lastRatedAt:100},{id:'d',title:'Stored',anilistId:12,status:'plan'}];
  assert.deepEqual(J.recentReading(list).map(m=>m.id),['b','a']);
  const media=[{id:10,title:{english:'Solo Leveling'},synonyms:['Поднятие уровня в одиночку']},{id:11,title:{english:'New title'}},{id:12,title:{english:'Unrelated spelling'}}];
  assert.deepEqual(J.unseenMedia(media,list).map(m=>m.id),[11]);
});

function syncHarness() {
  const ctx=vm.createContext({window:{},console});
  const source=fs.readFileSync('sync.js','utf8').replace('root.AMSync = setupBrowserApi();','root.syncTest = {createEngine, freshMeta};');
  vm.runInContext(source,ctx);
  const docs=new Map();let clock=100;
  const remote={pull:async()=>({docs:[...docs.values()],maxSrv:clock}),push:async(items,confirm)=>{items.forEach(d=>docs.set(d.key,JSON.parse(JSON.stringify(d))));confirm(items.map(d=>d.key));}};
  return {docs,engine(api,meta){return ctx.window.syncTest.createEngine({host:api.bridge,remote,meta:meta||ctx.window.syncTest.freshMeta('test',''),saveMeta:async()=>{},clock:()=>++clock});}};
}
test('selected goals and earned progress survive cloud sign-in, local reload and removal',async()=>{
  const cloud=syncHarness(),a=harness();
  a.api.state.profile.journey={goals:[{id:'finish3',started:10,baseline:['old'],earned:['new']}],duels:[{a:'one',b:'two',winner:'one'}]};
  a.api.saveProfile();await a.api.flush();
  const engine=cloud.engine(a.api);await engine.sync();
  assert.equal(JSON.parse(cloud.docs.get('profile').json).journey.goals[0].id,'finish3');
  const signedIn=harness();await cloud.engine(signedIn.api).sync();await signedIn.api.flush();
  assert.equal(signedIn.api.state.profile.journey.goals[0].id,'finish3');
  assert.deepEqual(Array.from(signedIn.api.state.profile.journey.goals[0].earned),['new']);
  assert.equal(signedIn.api.state.profile.journey.duels.length,1);
  const reloaded=harness(signedIn.saved);await reloaded.api.loadProfile();
  assert.equal(reloaded.api.state.profile.journey.goals[0].id,'finish3');
  a.api.state.profile.journey.goals=[];a.api.saveProfile();engine.noteChange();await engine.sync();
  const another=harness();await cloud.engine(another.api).sync();
  assert.equal(another.api.state.profile.journey.goals.length,0,'removed goals must not return');
});

test('upgrade restores goals omitted by old cloud parser without reviving removed goals',async()=>{
  const cloud=syncHarness(),device=harness();
  device.api.state.profile.n='Reader';
  const old=cloud.engine(device.api);await old.sync();
  const doc=cloud.docs.get('profile');
  const remoteProfile=JSON.parse(doc.json);
  remoteProfile.journey={goals:[{id:'notes10',started:10,baseline:[],earned:['a:n']}],duels:[]};
  doc.json=JSON.stringify(remoteProfile);
  delete old.meta.profileJourneyVersion;old.meta.watermark=999999;
  const repaired=cloud.engine(device.api,old.meta);
  assert.equal(repaired.meta.watermark,0);
  await repaired.sync();await device.api.flush();
  assert.equal(device.api.state.profile.journey.goals[0].id,'notes10');
  assert.equal(device.api.state.profile.journey.goals[0].earned.length,1);
  device.api.state.profile.journey.goals=[];
  repaired.noteChange();
  doc.updatedAt=repaired.meta.profile.u; // stale remote echo ties with pending edit
  await repaired.sync();
  assert.equal(device.api.state.profile.journey.goals.length,0);
  assert.equal(JSON.parse(cloud.docs.get('profile').json).journey.goals.length,0);
});

test('shop earns alongside XP, charges once, preserves rank XP and rejects unaffordable items',async()=>{
  const {api,saved}=harness();api.state.totalXp=200;
  assert.equal(J.coinBalance(api.state.totalXp,api.state.shop),200);
  assert.equal(api.buyShopItem('theme-dusk'),true);
  assert.equal(api.state.totalXp,200);
  assert.equal(J.coinBalance(200,api.state.shop),50);
  assert.equal(api.buyShopItem('theme-dusk'),false);
  assert.equal(api.buyShopItem('frame-crown'),false);
  api.equipShopItem('theme-dusk');assert.equal(api.activeStyle().theme,'theme-dusk');
  api.equipShopItem('frame-crown');assert.equal(api.activeStyle().frame,'');
  const before=api.state.totalXp;api.logActivity('add','new','New',{});
  assert.ok(api.state.totalXp>before);
  assert.equal(J.coinBalance(api.state.totalXp,api.state.shop),50+api.state.totalXp-before);
  await api.flush();const again=harness(saved);again.api.state.totalXp=api.state.totalXp;
  await again.api.loadShop();await again.api.loadProfile();
  assert.equal(again.api.activeStyle().theme,'theme-dusk');assert.equal(J.coinBalance(again.api.state.totalXp,again.api.state.shop),J.coinBalance(api.state.totalXp,api.state.shop));
});
test('shop merge deduplicates purchases and deterministically resolves simultaneous overspending',()=>{
  const a={'theme-dusk':10},b={'theme-ocean':11};
  assert.deepEqual(J.mergeShop(a,b,300),{'theme-dusk':10});
  assert.deepEqual(J.mergeShop(b,a,300),J.mergeShop(a,b,300));
  assert.deepEqual(J.mergeShop(a,{'theme-dusk':12},300),a);
  assert.equal(J.coinBalance(300,J.mergeShop(a,b,300)),150);
  assert.deepEqual(J.cleanShop({'unknown':1,'frame-orbit':-1,'theme-dusk':NaN},999),{});
});
test('cloud roundtrip preserves bought items, equipped style and spent balance',async()=>{
  const cloud=syncHarness(),a=harness();a.api.state.totalXp=1000;
  a.api.buyShopItem('theme-ocean');a.api.buyShopItem('frame-frost');a.api.equipShopItem('theme-ocean');a.api.equipShopItem('frame-frost');
  await cloud.engine(a.api).sync();
  const b=harness();await cloud.engine(b.api).sync();await b.api.flush();
  assert.equal(b.api.state.totalXp,1000);
  assert.equal(J.coinBalance(b.api.state.totalXp,b.api.state.shop),530);
  assert.equal(b.api.activeStyle().theme,'theme-ocean');assert.equal(b.api.activeStyle().frame,'frame-frost');
  assert.equal(Object.keys(b.api.state.shop).length,2);
});
test('user text is safe in quoted HTML attributes',()=>{
  const {api}=harness();
  assert.equal(api.escapeHtml('Title "quoted" & <tag>'), 'Title &quot;quoted&quot; &amp; &lt;tag&gt;');
});
test('invalid dates in imported activity do not reach cloud month grouping',async()=>{
  const {api}=harness();
  api.state.activityLog=api.sanitizeImportedActivityLog([{ts:1e100,type:'add'},{ts:100,type:'add'}]);
  assert.equal(api.state.activityLog.length,1);
  const cloud=syncHarness();await cloud.engine(api).sync();
  assert.ok(cloud.docs.has('log:1970-01'));
});
test('account wipe discards pending recommendations and previous reader context',()=>{
  const {api}=harness();let aborted=false;
  api.state.journeyUI.results=[{id:123}];
  api.state.journeyUI.discoveryAbort={abort(){aborted=true;}};
  api.state.journeyUI.discoveryKey='previous-user';
  api.bridge.wipeLocal();
  assert.equal(aborted,true);
  assert.equal(api.state.journeyUI.results.length,0);
  assert.equal(api.state.journeyUI.discoveryKey,undefined);
});
test('cloud rejects non-finite XP and invalid activity timestamps',async()=>{
 const cloud=syncHarness(),h=harness();
 cloud.docs.set('progress',{kind:'progress',id:'',json:'{"x":1e999,"a":{},"shop":{}}',epoch:0,updatedAt:10});
 cloud.docs.set('log:1970-01',{kind:'log',id:'1970-01',json:JSON.stringify([{ts:1e100,type:'add'},{ts:100,type:'add'}]),epoch:0,updatedAt:10});
 await cloud.engine(h.api).sync();
 assert.equal(h.api.state.totalXp,0);
 assert.equal(h.api.state.activityLog.length,1);
});
test('shop catalog references existing assets and unique valid items',()=>{
 assert.equal(new Set(J.shopItems.map(x=>x.id)).size,J.shopItems.length);
 for(const item of J.shopItems){assert.ok(((item.exclusive||item.eventOnly)?item.price===0:item.price>0)&&Number.isInteger(item.price));assert.ok(J.shopRarities[item.rarity]);if(item.image)assert.ok(fs.existsSync(item.image),item.image);}
});
test('exclusive cosmetics cannot be bought or granted by importing purchases',()=>{
 const {api}=harness();api.state.totalXp=100000;
 for(const id of ['theme-freefall','frame-freefall','badge-owner']){
   assert.equal(api.buyShopItem(id),false);
   api.state.shop[id]=1;api.equipShopItem(id);
 }
 assert.equal(api.activeStyle().theme,'');
 assert.deepEqual(J.cleanShop({'theme-freefall':1,'badge-owner':1},100000),{});
 assert.deepEqual(J.mergeShop({'frame-freefall':1},{},100000),{});
});
test('owner eligibility requires the verified account, not nickname or imported profile',async()=>{
 const ctx=vm.createContext({window:{},console,crypto:require('node:crypto').webcrypto,TextEncoder,Uint8Array});
 vm.runInContext(fs.readFileSync('sync.js','utf8').replace('root.AMSync = setupBrowserApi();','root.checkOwner = verifiedOwner;'),ctx);
 assert.equal(await ctx.window.checkOwner({email:'other@example.test',emailVerified:true}),false);
 assert.equal(await ctx.window.checkOwner(null),false);
 ctx.crypto={subtle:{digest:async()=>Uint8Array.from(Buffer.from('342f6208633b9708f2eec434d8f9c89eb36871c0c5f3f082bb6727754c73ca92','hex')).buffer}};
 assert.equal(await ctx.window.checkOwner({email:'owner@example.test',emailVerified:true}),true);
 assert.equal(await ctx.window.checkOwner({email:'owner@example.test',emailVerified:false}),false);
});
test('completed goals grant XP and coins once, including already completed goals',async()=>{
 const h=harness(),a=h.api;
 a.ACHIEVEMENTS.filter(x=>!x.id.startsWith('goal_reward_')).forEach(x=>a.state.unlockedAchievements[x.id]=1);
 a.state.totalXp=1000;
 a.state.profile.journey={goals:[{id:'finish3',started:10,baseline:[],earned:['one','two']}],duels:[]};
 a.render();assert.equal(a.state.totalXp,1000);
 const m=a.newManhwa('Third');m.id='three';m.status='done';a.state.manhwas=[m];a.save();
 assert.equal(a.state.totalXp,1150);assert.equal(J.coinBalance(a.state.totalXp,a.state.shop),1150);
 a.render();a.save();assert.equal(a.state.totalXp,1150);
 await a.flush();
 const b=harness(h.saved).api;b.state.totalXp=1150;
 b.state.unlockedAchievements=JSON.parse(h.saved.get(a.keys.achievements));
 await b.loadProfile();b.render();assert.equal(b.state.totalXp,1150);
 b.state.profile.journey.goals=[];b.save();
 b.state.profile.journey.goals=[{id:'finish3',started:20,baseline:[],earned:['x','y','z']}];b.render();
 assert.equal(b.state.totalXp,1150);
 const legacy=harness().api;
 legacy.ACHIEVEMENTS.filter(x=>!x.id.startsWith('goal_reward_')).forEach(x=>legacy.state.unlockedAchievements[x.id]=1);
 legacy.state.profile.journey={goals:[{id:'notes10',started:10,baseline:[],earned:Array.from({length:10},(_,i)=>'n'+i)}],duels:[]};
 legacy.render();assert.equal(legacy.state.totalXp,200);
 legacy.render();assert.equal(legacy.state.totalXp,200);
});
test('goal reward merge deduplicates same goals and preserves different offline rewards',async()=>{
 const cloud=syncHarness(),a=harness().api,b=harness().api;
 a.state.totalXp=1150;a.state.unlockedAchievements={goal_reward_finish3:10};
 b.state.totalXp=1200;b.state.unlockedAchievements={goal_reward_notes10:11};
 const ea=cloud.engine(a),eb=cloud.engine(b);
 await ea.sync();await eb.sync();await ea.sync();
 assert.equal(a.state.totalXp,1350);assert.equal(b.state.totalXp,1350);
 await eb.sync();await ea.sync();assert.equal(a.state.totalXp,1350);
 const same=harness().api;same.state.totalXp=1150;same.state.unlockedAchievements={goal_reward_finish3:12};
 await cloud.engine(same).sync();assert.equal(same.state.totalXp,1350);
});
test('chapter ratings accept rating-only records and preserve legacy notes',()=>{
 const old={id:'old',text:'Note',chapter:1,ts:100,spoiler:true};
 assert.deepEqual(J.journal([old]),[old]);
 const records=J.journal([{id:'score',chapter:2,ts:200,rating:9},{id:'bad',chapter:3,ts:300,rating:11},{id:'fraction',chapter:4,ts:400,rating:2.5}]);
 assert.equal(records.length,1);assert.equal(records[0].rating,9);assert.equal(records[0].text,'');
 const {api}=harness();const m=api.newManhwa('Chapter test');m.journal=records;
 assert.equal(api.sanitizeImportedManhwa(m,{}).journal[0].rating,9);
});
test('chapter ratings survive cloud roundtrip without changing title scores',async()=>{
 const cloud=syncHarness(),a=harness().api,m=addRated(a);
 const score=a.ratedScore(m);m.journal=[{id:'chapter',chapter:74.5,ts:100,text:'',rating:8,spoiler:false}];
 await cloud.engine(a).sync();const b=harness().api;await cloud.engine(b).sync();
 assert.equal(b.state.manhwas[0].journal[0].rating,8);
 assert.equal(b.ratedScore(b.state.manhwas[0]),score);
 b.state.manhwas[0].journal[0].rating=10;
 const eb=cloud.engine(b);await eb.sync();
 const c=harness().api;await cloud.engine(c).sync();assert.equal(c.state.manhwas[0].journal[0].rating,10);
});
