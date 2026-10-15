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
      querySelectorAll() { return []; }, querySelector() { return null; }, focus() {},
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
    console, setTimeout() {}, clearTimeout() {}, navigator: {},
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
    window.testApi = { state, newManhwa, beginRerating, editableManhwa, commitRerating,
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
  h.elements.get('finish-rating-btn').handlers.click();
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
  a.state.selectedId = m.id; a.render(); h.elements.get('finish-rating-btn').handlers.click();
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
  assert.equal(a.ACHIEVEMENTS.length,95);
  assert.equal(new Set(a.ACHIEVEMENTS.map(x=>x.id)).size,95);
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
