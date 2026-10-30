/*
 * AM Tracker — the whole app in one file (no build step). Sections, in order:
 *   constants          storage keys, ranks, achievements, tag lists
 *   helpers            scoring formula, awards logic, title CRUD, AniList search
 *   backup import      validation of imported / cloud-synced data
 *   persistence        load/save (IndexedDB, localStorage fallback), activity log
 *   svg pieces         radar chart and small icons
 *   view: library      title list, search, filters, awards tab
 *   view: detail       a single title: rating, tags, notes, rating switcher
 *   view: profile      rank, achievements, activity, settings
 *   profile & account  nickname/avatar editor, sign-in and sync status
 *   render + handlers  render() redraws #app; attachHandlers() wires the buttons
 *   bridge for sync.js window.AMApp — the interface sync.js uses to read/write data
 *   boot               load data, start sync, register the service worker
 */
(function () {
  "use strict";

  var STORAGE_KEY = "manhwa-tracker:data:v1";
  var AWARDS_STORAGE_KEY = "manhwa-tracker:awards:v1";
  var AWARD_CANDIDATES_STORAGE_KEY = "manhwa-tracker:award-candidates:v1";
  var AWARD_EDIT_USED_STORAGE_KEY = "manhwa-tracker:award-edit-used:v1";
  var ACTIVITY_LOG_STORAGE_KEY = "manhwa-tracker:activity-log:v1";
  var ACTIVITY_LOG_MAX = 3000;
  var applyingRemote = false; // true while cloud changes are being written into state (must not trigger a sync)
  var SYNC_META_KEY = "manhwa-tracker:sync:v1";
  var SHOP_STORAGE_KEY = "manhwa-tracker:shop:v1";
  var XP_STORAGE_KEY = "manhwa-tracker:xp:v1";
  var ACHIEVEMENTS_STORAGE_KEY = "manhwa-tracker:achievements:v1";
  var RATING_DRAFTS_KEY = "manhwa-tracker:rating-drafts:v1";
  var RECENT_OPENED_KEY = "manhwa-tracker:recent-opened:v1";
  var Features = window.AMFeatures;
  var CHANGELOG_SEEN_KEY = "manhwa-tracker:changelog-seen:v1";

  // Storage backend: IndexedDB (no practical size cap, unlike localStorage's
  // ~5-10MB ceiling) with a one-time migration from the old localStorage data,
  // and a full fallback to localStorage if IndexedDB isn't available at all.
  var IDB_NAME = "manhwa-tracker-db";
  var IDB_STORE = "kv";
  var IDB_MIGRATED_KEY = "manhwa-tracker:idb-migrated:v1";
  var idbAvailable = true;
  var idbConnPromise = null;

  function openIdb() {
    if (idbConnPromise) return idbConnPromise;
    idbConnPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("indexeddb unsupported")); return; }
      var req;
      try {
        req = window.indexedDB.open(IDB_NAME, 1);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("indexeddb open failed")); };
      req.onblocked = function () { reject(new Error("indexeddb blocked")); };
    });
    return idbConnPromise;
  }

  function idbGet(key) {
    return openIdb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try { tx = db.transaction(IDB_STORE, "readonly"); } catch (e) { reject(e); return; }
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSet(key, value) {
    return openIdb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try { tx = db.transaction(IDB_STORE, "readwrite"); } catch (e) { reject(e); return; }
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("indexeddb write aborted")); };
      });
    });
  }

  function localSetPromise(key, value) {
    return new Promise(function (resolve, reject) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  // Picks the active backend (IndexedDB, or localStorage if IDB isn't usable
  // in this browser) — every save*() function below goes through this.
  var storageWrites = {};
  var pendingStorageWrites = 0;
  var storageVersions = {};
  var failedWrites = {};
  var retryingStorage = false;

  // Snapshot and serialize writes per key. A slow older write must never
  // overwrite a newer value, including after a failed write is retried.
  function persistKey(key, value) {
    var snapshot = JSON.parse(JSON.stringify(value));
    pendingStorageWrites++;
    patchDataStatus();
    var version = (storageVersions[key] || 0) + 1;
    storageVersions[key] = version;
    var write = (storageWrites[key] || Promise.resolve()).catch(function () {}).then(function () {
      return idbAvailable ? idbSet(key, snapshot) : localSetPromise(key, snapshot);
    }).then(function () {
      if (storageVersions[key] === version) delete failedWrites[key];
      patchStorageNotice();
    }, function (err) {
      if (storageVersions[key] === version) failedWrites[key] = snapshot;
      patchStorageNotice();
      throw err;
    });
    write = write.finally(function () { pendingStorageWrites--; patchDataStatus(); });
    storageWrites[key] = write;
    return write;
  }

  function storageNoticeHtml() {
    if (!Object.keys(failedWrites).length) return "";
    return '<div class="mt-error" role="alert">Не удалось сохранить часть данных на устройстве. ' +
      'Не закрывай приложение до успешной повторной попытки.' +
      '<button class="mt-ghost-btn" id="retry-storage-btn"' + (retryingStorage ? ' disabled' : '') + '>' +
      (retryingStorage ? 'Сохраняю…' : 'Повторить сохранение') + '</button></div>';
  }

  function patchStorageNotice() {
    patchDataStatus();
    var el = document.getElementById("storage-notice");
    if (!el) return;
    el.innerHTML = storageNoticeHtml();
    var btn = document.getElementById("retry-storage-btn");
    if (btn) btn.onclick = retryFailedWrites;
  }

  function retryFailedWrites() {
    if (retryingStorage) return Promise.resolve();
    retryingStorage = true;
    var keys = Object.keys(failedWrites);
    patchStorageNotice();
    return Promise.all(keys.map(function (key) {
      // Wait for a newer in-flight write before choosing what to retry.
      return (storageWrites[key] || Promise.resolve()).catch(function () {}).then(function () {
        if (Object.prototype.hasOwnProperty.call(failedWrites, key)) {
          return persistKey(key, failedWrites[key]).catch(function () {});
        }
      });
    })).then(function () { retryingStorage = false; patchStorageNotice(); });
  }

  function persistChangelogSeen(version) {
    persistKey(CHANGELOG_SEEN_KEY, version).catch(function () {});
  }

  var DEFAULT_CRITERIA = ["Рисовка", "Сюжет", "Персонажи", "Темп/Ритм", "Атмосфера"];

  // XP awarded per meaningful action — mirrors the activity-log event types.
  // "add"/"rated"/"award" are also used to seed a one-time XP baseline from
  // the library's existing history (see seedXpFromCurrentState), so a
  // long-time user doesn't start at rank zero after this update.
  var XP_VALUES = { add: 5, rated: 25, rated_review: 45, status: 3, award: 15, delete: 0 };

  // Rank tiers, lowest first. Each needs a strictly higher minXp than the last.
  var RANKS = [
    { name: "Новичок", minXp: 0, gradient: ["#6E6C6E", "#A8A6A8"], icon: "🌱" },
    { name: "Любитель", minXp: 200, gradient: ["#7A9B8A", "#9FBFAE"], icon: "📖" },
    { name: "Читатель", minXp: 500, gradient: ["#5C8AA0", "#7FB4CC"], icon: "📚" },
    { name: "Знаток", minXp: 1000, gradient: ["#6478A8", "#8CA0D0"], icon: "🔎" },
    { name: "Ценитель", minXp: 2000, gradient: ["#8C7FA0", "#B0A0C4"], icon: "🎭" },
    { name: "Эксперт", minXp: 3500, gradient: ["#A87C8C", "#D9838F"], icon: "⭐" },
    { name: "Мастер", minXp: 5500, gradient: ["#C9BFA8", "#D9C9A0"], icon: "🎖️" },
    { name: "Виртуоз", minXp: 8500, gradient: ["#E7E3DC", "#C9BFA8"], icon: "💎" },
    { name: "Легенда", minXp: 13000, gradient: ["#E7E3DC", "#C9BFA8", "#8CA0D0"], icon: "👑" }
  ];

  function rankIndexForXp(xp) {
    var idx = 0;
    for (var i = 0; i < RANKS.length; i++) {
      if (xp >= RANKS[i].minXp) idx = i; else break;
    }
    return idx;
  }

  // One-time baseline so existing history counts toward XP immediately,
  // instead of everyone starting at 0 the moment this feature ships.
  function seedXpFromCurrentState() {
    var ratedCount = 0;
    state.manhwas.forEach(function (m) { if (m.rated) ratedCount++; });
    var awardCount = 0;
    Object.keys(state.awardWinners).forEach(function (monthKey) {
      awardCount += Object.keys(state.awardWinners[monthKey]).length;
    });
    return state.manhwas.length * XP_VALUES.add + ratedCount * XP_VALUES.rated + awardCount * XP_VALUES.award;
  }

  /* ---------- constants: ranks, achievements, tables, changelog ---------- */
  function ratedTitlesCount() {
    var n = 0;
    state.manhwas.forEach(function (m) { if (m.rated) n++; });
    return n;
  }
  function droppedTitlesCount() {
    var n = 0;
    state.manhwas.forEach(function (m) { if (m.status === "dropped") n++; });
    return n;
  }
  function reviewCount() {
    return state.activityLog.filter(function (e) { return e.type === "rated_review" || e.type === "rerated_review"; }).length;
  }
  function totalAwardWinsCount() {
    var n = 0;
    Object.keys(state.awardWinners).forEach(function (mk) { n += Object.keys(state.awardWinners[mk]).length; });
    return n;
  }
  function categoryEverWon(categoryKey) {
    return Object.keys(state.awardWinners).some(function (mk) { return !!state.awardWinners[mk][categoryKey]; });
  }
  function anyMonthFullyDecided() {
    return Object.keys(state.awardWinners).some(function (mk) {
      var avail = availableCategoriesForMonth(mk);
      if (!avail.length) return false;
      return avail.every(function (ck) { return !!state.awardWinners[mk][ck]; });
    });
  }
  function rockBottomEver() {
    return state.activityLog.some(function (e) {
      return (e.type === "rated" || e.type === "rated_review" || e.type === "rerated" || e.type === "rerated_review") &&
        e.extra && e.extra.score === 1;
    });
  }
  // Longest-ever run of consecutive calendar days with at least one logged
  // action — checked against the full log, so an achievement stays earned
  // even if the streak later breaks.
  function longestStreakDays() {
    var days = {};
    state.activityLog.forEach(function (e) {
      var d = new Date(e.ts);
      days[d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())] = true;
    });
    var keys = Object.keys(days).sort();
    var longest = 0, current = 0, prevTime = null;
    keys.forEach(function (k) {
      var t = new Date(k + "T00:00:00").getTime();
      current = (prevTime !== null && t - prevTime === 86400000) ? current + 1 : 1;
      if (current > longest) longest = current;
      prevTime = t;
    });
    return longest;
  }
  function countByStatus(statusId) {
    var n = 0;
    state.manhwas.forEach(function (m) { if (m.status === statusId) n++; });
    return n;
  }
  function distinctGenresCount() {
    var set = {};
    state.manhwas.forEach(function (m) { (m.genres || []).forEach(function (g) { set[g] = true; }); });
    return Object.keys(set).length;
  }
  function hasCustomCriterion() {
    return state.manhwas.some(function (m) {
      return m.criteria.some(function (c) { return DEFAULT_CRITERIA.indexOf(c.name) === -1; });
    });
  }
  function hasAllThreeTypes() {
    var set = {};
    state.manhwas.forEach(function (m) { set[m.type || "manhwa"] = true; });
    return TYPES.every(function (t) { return set[t.id]; });
  }
  function perfectScoreEver() {
    return state.manhwas.some(function (m) { return ratedScore(m) === 100; });
  }
  function allAwardCategoriesEverWon() {
    return AWARD_CATEGORY_KEYS.every(function (ck) { return categoryEverWon(ck); });
  }
  function monthsFullyDecidedCount() {
    var n = 0;
    Object.keys(state.awardWinners).forEach(function (mk) {
      var avail = availableCategoriesForMonth(mk);
      if (avail.length && avail.every(function (ck) { return !!state.awardWinners[mk][ck]; })) n++;
    });
    return n;
  }
  function anyYearHasChampion() {
    var years = {};
    Object.keys(state.awardWinners).forEach(function (mk) { years[mk.split("-")[0]] = true; });
    return Object.keys(years).some(function (y) { return championsForYear(parseInt(y, 10)).length > 0; });
  }
  function activityInHourRange(startHour, endHour) {
    return state.activityLog.some(function (e) {
      var h = new Date(e.ts).getHours();
      return h >= startHour && h < endHour;
    });
  }
  function maxActionsInOneDay() {
    var days = {};
    state.activityLog.forEach(function (e) {
      var d = new Date(e.ts);
      var key = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      days[key] = (days[key] || 0) + 1;
    });
    var max = 0;
    Object.keys(days).forEach(function (k) { if (days[k] > max) max = days[k]; });
    return max;
  }

  var ACHIEVEMENT_CATEGORIES = [
    "Библиотека", "Жанры и типы", "Оценки", "Рецензии", "Премии", "Статусы", "Активность", "Ранг"
  ];

  var ACHIEVEMENTS = [
    // Библиотека
    { id: "first_add", category: "Библиотека", name: "Первый шаг", desc: "Добавь свой первый тайтл", icon: "🎬", xp: 10,
      check: function () { return state.manhwas.length >= 1; } },
    { id: "collect_10", category: "Библиотека", name: "Начало пути", desc: "10 тайтлов в библиотеке", icon: "🌱", xp: 15,
      check: function () { return state.manhwas.length >= 10; } },
    { id: "collect_50", category: "Библиотека", name: "Коллекционер", desc: "50 тайтлов в библиотеке", icon: "📚", xp: 30,
      check: function () { return state.manhwas.length >= 50; } },
    { id: "collect_100", category: "Библиотека", name: "Библиофил", desc: "100 тайтлов в библиотеке", icon: "🏛️", xp: 60,
      check: function () { return state.manhwas.length >= 100; } },
    { id: "collect_150", category: "Библиотека", name: "Книжный червь", desc: "150 тайтлов в библиотеке", icon: "🐛", xp: 90,
      check: function () { return state.manhwas.length >= 150; } },
    { id: "collect_250", category: "Библиотека", name: "Легендарная полка", desc: "250 тайтлов в библиотеке", icon: "🗿", xp: 120,
      check: function () { return state.manhwas.length >= 250; } },
    { id: "collect_400", category: "Библиотека", name: "Архивариус", desc: "400 тайтлов в библиотеке", icon: "🗄️", xp: 160,
      check: function () { return state.manhwas.length >= 400; } },
    { id: "collect_600", category: "Библиотека", name: "Хранитель библиотеки", desc: "600 тайтлов в библиотеке", icon: "🏰", xp: 220,
      check: function () { return state.manhwas.length >= 600; } },
    { id: "collect_1000", category: "Библиотека", name: "Бесконечная полка", desc: "1000 тайтлов в библиотеке", icon: "♾️", xp: 300,
      check: function () { return state.manhwas.length >= 1000; } },

    // Жанры и типы
    { id: "genres_5", category: "Жанры и типы", name: "Разносторонний вкус", desc: "5 разных жанров в библиотеке", icon: "🎭", xp: 20,
      check: function () { return distinctGenresCount() >= 5; } },
    { id: "genres_10", category: "Жанры и типы", name: "Знаток жанров", desc: "10 разных жанров в библиотеке", icon: "🌈", xp: 40,
      check: function () { return distinctGenresCount() >= 10; } },
    { id: "genres_20", category: "Жанры и типы", name: "Энциклопедист", desc: "20 разных жанров в библиотеке", icon: "📖", xp: 90,
      check: function () { return distinctGenresCount() >= 20; } },
    { id: "all_types", category: "Жанры и типы", name: "Три стихии", desc: "В библиотеке есть манхва, манга и маньхуа", icon: "⚡", xp: 30,
      check: function () { return hasAllThreeTypes(); } },
    { id: "custom_criterion", category: "Жанры и типы", name: "Свой стиль", desc: "Добавь свой критерий оценки на любом тайтле", icon: "🎨", xp: 20,
      check: function () { return hasCustomCriterion(); } },

    // Оценки
    { id: "first_rated", category: "Оценки", name: "Первая оценка", desc: "Оцени свой первый тайтл", icon: "⭐", xp: 10,
      check: function () { return ratedTitlesCount() >= 1; } },
    { id: "rated_10", category: "Оценки", name: "Втянулся", desc: "Оцени 10 тайтлов", icon: "✨", xp: 15,
      check: function () { return ratedTitlesCount() >= 10; } },
    { id: "rated_50", category: "Оценки", name: "Критик", desc: "Оцени 50 тайтлов", icon: "🧐", xp: 40,
      check: function () { return ratedTitlesCount() >= 50; } },
    { id: "rated_100", category: "Оценки", name: "Мастер оценок", desc: "Оцени 100 тайтлов", icon: "🎓", xp: 80,
      check: function () { return ratedTitlesCount() >= 100; } },
    { id: "rated_150", category: "Оценки", name: "Гуру оценок", desc: "Оцени 150 тайтлов", icon: "🧠", xp: 120,
      check: function () { return ratedTitlesCount() >= 150; } },
    { id: "rated_250", category: "Оценки", name: "Ходячая энциклопедия", desc: "Оцени 250 тайтлов", icon: "📊", xp: 200,
      check: function () { return ratedTitlesCount() >= 250; } },
    { id: "perfect_score", category: "Оценки", name: "Идеал", desc: "Поставь тайтлу 100/100 по всем критериям", icon: "💯", xp: 35,
      check: function () { return perfectScoreEver(); } },
    { id: "rock_bottom", category: "Оценки", name: "Дно", desc: "Поставь тайтлу оценку 1 по всем критериям", icon: "🤮", xp: 25,
      check: function () { return rockBottomEver(); } },

    // Рецензии
    { id: "first_review", category: "Рецензии", name: "Рецензент", desc: "Напиши первую рецензию при оценке", icon: "📝", xp: 20,
      check: function () { return reviewCount() >= 1; } },
    { id: "review_10", category: "Рецензии", name: "Плодовитый автор", desc: "Напиши 10 рецензий", icon: "🖋️", xp: 70,
      check: function () { return reviewCount() >= 10; } },
    { id: "review_25", category: "Рецензии", name: "Литературный критик", desc: "Напиши 25 рецензий", icon: "📰", xp: 130,
      check: function () { return reviewCount() >= 25; } },

    // Премии
    { id: "first_award", category: "Премии", name: "Первая победа", desc: "Выиграй первую номинацию в премии", icon: "🏆", xp: 20,
      check: function () { return totalAwardWinsCount() >= 1; } },
    { id: "award_10", category: "Премии", name: "Хозяин наград", desc: "Выиграй 10 номинаций суммарно", icon: "🏅", xp: 70,
      check: function () { return totalAwardWinsCount() >= 10; } },
    { id: "award_25", category: "Премии", name: "Коллекция кубков", desc: "Выиграй 25 номинаций суммарно", icon: "🥇", xp: 140,
      check: function () { return totalAwardWinsCount() >= 25; } },
    { id: "ceremony_full", category: "Премии", name: "Церемония закрыта", desc: "Реши все номинации хотя бы за один месяц", icon: "🎊", xp: 40,
      check: function () { return anyMonthFullyDecided(); } },
    { id: "ceremony_full_3", category: "Премии", name: "Постоянный организатор", desc: "Полностью реши номинации за 3 разных месяца", icon: "📅", xp: 90,
      check: function () { return monthsFullyDecidedCount() >= 3; } },
    { id: "year_champion", category: "Премии", name: "Тайтл года", desc: "Стань свидетелем «Тайтла года» хотя бы раз", icon: "👑", xp: 60,
      check: function () { return anyYearHasChampion(); } },
    { id: "won_art", category: "Премии", name: "Признанный художник", desc: "Выиграй номинацию «Лучшая рисовка»", icon: "🖌️", xp: 25,
      check: function () { return categoryEverWon("Рисовка"); } },
    { id: "won_plot", category: "Премии", name: "Мастер сюжета", desc: "Выиграй номинацию «Лучший сюжет»", icon: "📖", xp: 25,
      check: function () { return categoryEverWon("Сюжет"); } },
    { id: "won_chars", category: "Премии", name: "Кастинг-директор", desc: "Выиграй номинацию «Лучшие персонажи»", icon: "🎭", xp: 25,
      check: function () { return categoryEverWon("Персонажи"); } },
    { id: "won_pace", category: "Премии", name: "Чувство ритма", desc: "Выиграй номинацию «Лучший темп»", icon: "⏱️", xp: 25,
      check: function () { return categoryEverWon("Темп/Ритм"); } },
    { id: "won_mood", category: "Премии", name: "Атмосферный критик", desc: "Выиграй номинацию «Лучшая атмосфера»", icon: "🌫️", xp: 25,
      check: function () { return categoryEverWon("Атмосфера"); } },
    { id: "cover_given", category: "Премии", name: "Модный критик", desc: "Присуди «Обложка месяца»", icon: "💅", xp: 25,
      check: function () { return categoryEverWon("cover"); } },
    { id: "worst_given", category: "Премии", name: "Антигерой", desc: "Присуди «Худший тайтл месяца»", icon: "🤢", xp: 25,
      check: function () { return categoryEverWon("worst"); } },
    { id: "all_categories", category: "Премии", name: "Полный комплект", desc: "Выиграй все номинации хотя бы по разу", icon: "🌟", xp: 200,
      check: function () { return allAwardCategoriesEverWon(); } },

    // Статусы
    { id: "dropper_10", category: "Статусы", name: "Серийный дроппер", desc: "Дропни 10 тайтлов", icon: "📉", xp: 40,
      check: function () { return droppedTitlesCount() >= 10; } },
    { id: "dropper_25", category: "Статусы", name: "Безжалостный", desc: "Дропни 25 тайтлов", icon: "⚔️", xp: 90,
      check: function () { return droppedTitlesCount() >= 25; } },
    { id: "completed_50", category: "Статусы", name: "Финишер", desc: "Заверши 50 тайтлов", icon: "🏁", xp: 60,
      check: function () { return countByStatus("done") >= 50; } },
    { id: "completed_150", category: "Статусы", name: "Марафонец чтения", desc: "Заверши 150 тайтлов", icon: "🎽", xp: 150,
      check: function () { return countByStatus("done") >= 150; } },
    { id: "planned_20", category: "Статусы", name: "Список мечты", desc: "20 тайтлов в статусе «В планах»", icon: "📋", xp: 20,
      check: function () { return countByStatus("plan") >= 20; } },
    { id: "reading_5", category: "Статусы", name: "Многозадачность", desc: "5 тайтлов одновременно в статусе «Читаю»", icon: "🤹", xp: 20,
      check: function () { return countByStatus("reading") >= 5; } },

    // Активность
    { id: "streak_3", category: "Активность", name: "Серия из 3", desc: "3 дня активности подряд", icon: "🔥", xp: 15,
      check: function () { return longestStreakDays() >= 3; } },
    { id: "streak_7", category: "Активность", name: "Серия из 7", desc: "7 дней активности подряд", icon: "🔥", xp: 40,
      check: function () { return longestStreakDays() >= 7; } },
    { id: "streak_14", category: "Активность", name: "Серия из 14", desc: "14 дней активности подряд", icon: "🔥", xp: 70,
      check: function () { return longestStreakDays() >= 14; } },
    { id: "streak_30", category: "Активность", name: "Железная воля", desc: "30 дней активности подряд", icon: "🔥", xp: 100,
      check: function () { return longestStreakDays() >= 30; } },
    { id: "streak_60", category: "Активность", name: "Одержимость", desc: "60 дней активности подряд", icon: "💫", xp: 180,
      check: function () { return longestStreakDays() >= 60; } },
    { id: "streak_100", category: "Активность", name: "Легенда постоянства", desc: "100 дней активности подряд", icon: "🌠", xp: 300,
      check: function () { return longestStreakDays() >= 100; } },
    { id: "night_owl", category: "Активность", name: "Ночная сова", desc: "Сделай что-нибудь между полуночью и 4 утра", icon: "🦉", xp: 15,
      check: function () { return activityInHourRange(0, 4); } },
    { id: "early_bird", category: "Активность", name: "Ранняя пташка", desc: "Сделай что-нибудь между 4 и 7 утра", icon: "🐦", xp: 15,
      check: function () { return activityInHourRange(4, 7); } },
    { id: "busy_day", category: "Активность", name: "День марафона", desc: "10+ действий за один день", icon: "⚡", xp: 30,
      check: function () { return maxActionsInOneDay() >= 10; } },

    // Ранг
    { id: "rank_legend", category: "Ранг", name: "Легенда", desc: "Достигни ранга «Легенда»", icon: "👑", xp: 0,
      check: function () { return state.totalXp >= 13000; } }
  ];

  // Declarative goals share the same metric for unlocking and visible progress.
  [
    ['collect',25,'Библиотека','Своя полка','Собери 25 тайтлов в библиотеке','📚',20],
    ['collect',200,'Библиотека','Дом историй','Собери 200 тайтлов в библиотеке','🏠',100],
    ['rated',5,'Оценки','В поисках вкуса','Оцени 5 разных тайтлов','🔍',15],
    ['rated',25,'Оценки','Уверенный голос','Оцени 25 разных тайтлов','🎙️',30],
    ['review',3,'Рецензии','Есть что сказать','Запиши 3 оценки с рецензией','💬',15],
    ['review',5,'Рецензии','Автор колонки','Запиши 5 оценок с рецензией','✍️',25],
    ['review',50,'Рецензии','Литературный обозреватель','Запиши 50 оценок с рецензией','📰',180],
    ['completed',1,'Статусы','До последней страницы','Заверши первый тайтл','📕',10],
    ['completed',5,'Статусы','Пять финалов','5 завершённых тайтлов в библиотеке','🏁',15],
    ['completed',10,'Статусы','Закрытая глава','10 завершённых тайтлов в библиотеке','✅',25],
    ['completed',25,'Статусы','Знаток финалов','25 завершённых тайтлов в библиотеке','🎬',40],
    ['completed',100,'Статусы','Сто историй позади','100 завершённых тайтлов в библиотеке','💯',110],
    ['rerated',1,'Оценки','Второй взгляд','Переоцени тайтл, сохранив прошлую оценку','🔄',15],
    ['rerated',5,'Оценки','Мнение меняется','Сохрани 5 переоценок в истории тайтлов','🔁',30],
    ['rerated',15,'Оценки','Диалог с историей','Сохрани 15 переоценок в истории тайтлов','🪞',65],
    ['rerated',30,'Оценки','Взгляд сквозь время','Сохрани 30 переоценок в истории тайтлов','⏳',120],
    ['manhwa',10,'Жанры и типы','Мир манхвы','Собери 10 манхв','🇰🇷',20],
    ['manhwa',50,'Жанры и типы','По следам вебтунов','Собери 50 манхв','🌆',55],
    ['manga',5,'Жанры и типы','Чёрным по белому','Собери 5 манг','🖋️',20],
    ['manga',20,'Жанры и типы','Мастер панелей','Собери 20 манг','🇯🇵',45],
    ['manhua',5,'Жанры и типы','Новый горизонт','Собери 5 маньхуа','🏮',20],
    ['manhua',20,'Жанры и типы','Путь дракона','Собери 20 маньхуа','🐉',45],
    ['covered',10,'Библиотека','Галерея обложек','Добавь обложки к 10 тайтлам','🖼️',20],
    ['covered',50,'Библиотека','Куратор коллекции','Добавь обложки к 50 тайтлам','🎨',60],
    ['annotated',5,'Рецензии','На полях','Оставь непустые заметки у 5 разных тайтлов','🗒️',20],
    ['annotated',20,'Рецензии','Личный дневник','Оставь непустые заметки у 20 разных тайтлов','📓',60],
    ['award',50,'Премии','Золотой фонд','Вручи 50 месячных наград суммарно','🏆',180],
    ['award',100,'Премии','Академия историй','Вручи 100 месячных наград суммарно','🏛️',250],
    ['ceremonies',6,'Премии','Шесть церемоний','Полностью реши номинации за 6 разных месяцев','🎟️',130],
    ['ceremonies',12,'Премии','Двенадцать церемоний','Полностью реши номинации за 12 разных месяцев','🎊',220],
    ['activeDays',10,'Активность','Приятная привычка','10 разных дней с действиями в сохранённой истории','📅',20],
    ['activeDays',30,'Активность','Всегда возвращаюсь','30 разных дней с действиями в сохранённой истории','🧭',65],
    ['activeDays',100,'Активность','Сто дней историй','100 разных дней с действиями в сохранённой истории','🌅',180],
    ['xp',200,'Ранг','Уже любитель','Достигни ранга «Любитель»','📖',0],
    ['xp',500,'Ранг','Настоящий читатель','Достигни ранга «Читатель»','📚',0],
    ['xp',1000,'Ранг','Знание — сила','Достигни ранга «Знаток»','🔎',0],
    ['xp',2000,'Ранг','Тонкий вкус','Достигни ранга «Ценитель»','🎭',0],
    ['xp',3500,'Ранг','Экспертное мнение','Достигни ранга «Эксперт»','⭐',0],
    ['xp',5500,'Ранг','Мастер своего дела','Достигни ранга «Мастер»','🎖️',0],
    ['xp',8500,'Ранг','Искусство читать','Достигни ранга «Виртуоз»','💎',0]
  ].forEach(function (goal) {
    ACHIEVEMENTS.push({ id:'journey_' + goal[0] + '_' + goal[1], metric:goal[0], target:goal[1], category:goal[2],
      name:goal[3], desc:goal[4], icon:goal[5], xp:goal[6], check:function () { return achievementMetrics()[goal[0]] >= goal[1]; } });
  });

  Features.goalOptions.forEach(function(o){
    ACHIEVEMENTS.push({id:'goal_reward_'+o.id,name:o.name,desc:'Выполни выбранную цель: '+o.text,category:'Цели',icon:'🎯',xp:o.reward,check:function(){
      return journeyData().goals.some(function(g){return g.id===o.id&&new Set(g.earned).size>=o.target;});
    }});
  });

  Features.halloweenQuests.forEach(function(q){
    ACHIEVEMENTS.push({id:q.id,name:q.name,desc:q.text,category:'Хэллоуин 2026',icon:q.icon,xp:q.xp,check:function(){return Features.halloweenWindow(Date.now()).active&&Features.halloweenProgress(state.manhwas,state.activityLog,state.unlockedAchievements,Date.now())[q.metric]>=q.target;}});
  });

  // Persists newly-met achievements permanently — once unlocked, never
  // re-checked or revoked even if the underlying stat later drops (e.g. a
  // title gets deleted). Called after every logged action.
  function checkAchievements() {
    var unlocked = [];
    var metrics = achievementMetrics();
    ACHIEVEMENTS.forEach(function (a) {
      if (state.unlockedAchievements[a.id]) return;
      if (a.metric ? metrics[a.metric] >= a.target : a.check()) {
        state.unlockedAchievements[a.id] = Date.now();
        unlocked.push(a);
      }
    });
    if (unlocked.length) {
      var xpGain = 0;
      unlocked.forEach(function (a) { xpGain += a.xp || 0; });
      saveAchievements();
      if (xpGain) {
        state.totalXp += xpGain;
        saveXp();
      }
    }
    return unlocked;
  }

  var STATUSES = [
    { id: "reading", label: "Читаю", color: "#7FB4CC" },
    { id: "done", label: "Завершено", color: "#7FBF9B" },
    { id: "dropped", label: "Дропнул", color: "#D9838F" },
    { id: "plan", label: "В планах", color: "#C9BFA8" }
  ];

  var TYPES = [
    { id: "manhwa", label: "Манхва", color: "#D9838F" },
    { id: "manga", label: "Манга", color: "#8CA0D0" },
    { id: "manhua", label: "Маньхуа", color: "#C9A055" }
  ];

  var GENRE_SUGGESTIONS = [
    "Экшн", "Романтика", "Фэнтези", "Драма", "Комедия", "Ужасы",
    "Триллер", "Приключения", "Повседневность", "Школа", "Сверхъестественное",
    "Психология", "Спорт", "Меха", "Гарем", "Трагедия"
  ];

  // AniList's genre list comes back in English — translate the common ones so
  // they read consistently next to the app's Russian genre tags. Anything not
  // in this dict is used as-is rather than dropped.
  var ANILIST_GENRE_RU = {
    "Action": "Экшн",
    "Adventure": "Приключения",
    "Comedy": "Комедия",
    "Drama": "Драма",
    "Ecchi": "Этти",
    "Fantasy": "Фэнтези",
    "Hentai": "Хентай",
    "Horror": "Ужасы",
    "Mahou Shoujo": "Махо-сёдзё",
    "Mecha": "Меха",
    "Music": "Музыка",
    "Mystery": "Мистика",
    "Psychological": "Психология",
    "Romance": "Романтика",
    "Sci-Fi": "Фантастика",
    "Slice of Life": "Повседневность",
    "Sports": "Спорт",
    "Supernatural": "Сверхъестественное",
    "Thriller": "Триллер"
  };
  function translateAniListGenre(g) {
    return ANILIST_GENRE_RU[g] || g;
  }

  // AniList's countryOfOrigin maps neatly onto the app's manhwa/manga/manhua
  // type split. Anything else (rare) is left for the user to pick manually.
  function typeFromCountryOfOrigin(country) {
    if (country === "KR") return "manhwa";
    if (country === "JP") return "manga";
    if (country === "CN" || country === "TW" || country === "HK") return "manhua";
    return null;
  }


  var EMOTION_LABELS = [
    "Пожалел о каждой потраченной минуте",
    "Плохо, раздражало",
    "Средне, не жалею, но и не запомнил",
    "Хорошо, получил удовольствие",
    "Шедевр, буду перечитывать / помню спустя годы"
  ];

  var POSITIVE_TAGS = [
    "Сильный мейн-герой", "Неожиданные повороты", "Прекрасная химия между героями",
    "Уникальный сеттинг", "Отличная комедия", "Красивые боевые сцены",
    "Глубокий лор", "Короткие, но ёмкие главы"
  ];

  var NEGATIVE_TAGS = [
    "Затянуто", "Падение качества арта", "Нелогичные поступки героев",
    "Переизбыток клише", "Слабый финал", "Проблемы с переводом", "Слишком много филлера"
  ];

  var AWARD_LABELS = {
    overall: "Тайтл месяца",
    worst: "Худший тайтл месяца",
    cover: "Обложка месяца",
    "Рисовка": "Лучшая рисовка",
    "Сюжет": "Лучший сюжет",
    "Персонажи": "Лучшие персонажи",
    "Темп/Ритм": "Лучший темп",
    "Атмосфера": "Лучшая атмосфера"
  };

  var MONTH_NAMES_GENITIVE = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
  ];

  // The list of releases lives in changelog.js (newest first).
  var CHANGELOG = window.AM_CHANGELOG || [];

  var ICON_BELL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
    '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  var ICON_SEARCH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/>' +
    '<line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

  var ICON_BOOK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>' +
    '<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';

  var ICON_USER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/></svg>';

  var lastViewKey = null;
  var tabScrollPositions={};

  var state = {
    manhwas: [],
    tab: "library",
    selectedId: null,
    sortMode: "recent",
    filterStatus: "all",
    filterGenre: "all",
    showGenreFilter: false,
    showChangelog: false,
    showSearch: false,
    changelogSeenVersion: null,
    awardWinners: {},
    awardCandidates: {},
    awardEditUsed: {},
    activityLog: [],
    shop: {}, shopOpen: false, shopCategory: "all", shopRarity: "all", accountSettings: false, shopPreview: null, shopSet: null, shopNotice: "",
    totalXp: 0,
    unlockedAchievements: {},
    achievementFilter: 'all',
    achievementCategory: 'Все категории',
    confirmEditWinnersMonth: null,
    awardsView: "month",
    awardsCategory: null,
    revealManhwaId: null,
    awardsYear: null,
    searchQuery: "",
    addingManhwa: false,
    pendingType: "manhwa",
    pendingTitleDraft: "",
    pendingCoverDraft: "",
    pendingGenreDraft: "",
    pendingGenresDraft: [],
    pendingAltTitlesDraft: null,
    aniListSearching: false,
    aniListError: null,
    aniListResults: null,
    aniListPickedIndex: null,
    addingCriterion: false,
    acct: { mode: "signin", email: "", error: "", info: "", confirmDelete: false, open: false },
    profile: { n: "", b: "", a: null },
    profileEdit: false,
    profileDraft: null,
    confirmDeleteId: null,
    confirmWinnerPick: null,
    awardsCandidatesConfirmed: false,
    candidatePanelOpen: false,
    statusPickerOpen: false,
    showAllRanks: false,
    unlockedIds: {},
    // Local-only drafts keep the published rating intact until explicitly saved.
    ratingDrafts: {},
    recentOpened: {},
    awardsMonth: null,
    awardPreview: null,
    compareFrom: {},
    journeyUI: {mood:"",genre:"",type:"",duelGenre:"",pick:0,section:"achievements",results:[],previousPair:[]},
    shareCard: null,
    // Which past rating is shown on a title's page (index into m.ratingHistory).
    // No entry = the current rating. Pure UI state, never saved or synced.
    ratingView: {},
    error: null
  };

  /* ---------- helpers: scoring, awards, titles, AniList ---------- */
  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Scoring formula: plain average of the 5 default criteria (equal weight,
  // Атмосфера included like any other — no more multiplier), scaled ×10 onto
  // a 1–100 scale. With all 5 present, moving one criterion by 1 point moves
  // the final score by exactly 2 (1/5 of the average × 10).
  // Custom (non-default) criteria still don't factor into this — informational only.

  function buildScoreText(m, snap) {
    var criteria = snap ? snap.criteria : m.criteria;
    var avg = snap ? snap.avg : average(m.criteria);
    var lines = [];
    var snapLabel = snap ? ratingChipLabel(snap.ts, false) : null;
    lines.push(displayTitle(m) + (snapLabel ? " (" + snapLabel + ")" : ""));
    lines.push("Итоговая оценка: " + (avg === null || avg === undefined ? "—" : Math.round(avg)) + "/100");
    lines.push("");
    criteria.forEach(function (c) {
      lines.push(c.name + ": " + c.score.toFixed(1));
    });
    if (m.tags && m.tags.length) {
      lines.push("");
      lines.push("Теги: " + m.tags.join(", "));
    }
    return lines.join("\n");
  }

  function average(criteria) {
    if (!criteria.length) return null;

    // Special case: if literally every criterion is at rock bottom (1), the
    // final score is 1 — not the 10 the usual ×10 scale would give. A title
    // this bad shouldn't get rounded up just because of the scale factor.
    if (criteria.every(function (c) { return c.score === 1; })) return 1;

    var find = function (name) {
      var c = criteria.find(function (cc) { return cc.name === name; });
      return c ? c.score : null;
    };
    var defaults = [find("Рисовка"), find("Сюжет"), find("Персонажи"), find("Темп/Ритм"), find("Атмосфера")]
      .filter(function (v) { return v !== null; });

    if (defaults.length) {
      var sum = 0;
      for (var i = 0; i < defaults.length; i++) sum += defaults[i];
      return (sum / defaults.length) * 10;
    }

    // No default criteria at all (every one of the 5 was removed, only custom
    // ones left) — plain average of whatever's there, same 1–100 scale.
    var total = 0;
    for (var j = 0; j < criteria.length; j++) total += criteria[j].score;
    return (total / criteria.length) * 10;
  }

  function scoreColor(v) {
    if (v === null || v === undefined) return "#7C7A7C";
    if (v < 50) return "#D9838F";
    if (v < 75) return "#C9A055";
    return "#7FBF9B";
  }

  // Same idea as scoreColor but for a single criterion's raw 1–10 value
  // (used for sliders/bars and criterion-specific award nominees).
  function criterionColor(v) {
    if (v === null || v === undefined) return "#7C7A7C";
    if (v < 5) return "#D9838F";
    if (v < 7.5) return "#C9A055";
    return "#7FBF9B";
  }

  // "legacy" — manhwa added before the emotion-pick system existed, skip straight to normal rating
  // "phase1" — needs the quick emotional pick first
  // "phase2" — emotion picked (or legacy), full criteria available
  function ratingPhase(m) {
    if (m.emotionRating === undefined) return "legacy";
    if (m.emotionRating === null) return "phase1";
    return "phase2";
  }

  // Legacy manhwa (added before createdAt existed) get their date backfilled from
  // the timestamp encoded in the tail of uid(): random36(8 chars) + Date.now().toString(36)
  function getCreatedAt(m) {
    if (typeof m.createdAt === "number") return m.createdAt;
    if (m.id && m.id.length > 8) {
      var ts = parseInt(m.id.slice(8), 36);
      if (!isNaN(ts) && ts > 1577836800000 && ts < Date.now() + 86400000) return ts;
    }
    return null;
  }

  function monthKeyOf(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + (d.getMonth() + 1 < 10 ? "0" : "") + (d.getMonth() + 1);
  }

  function monthLabel(monthKey) {
    var parts = monthKey.split("-");
    var idx = parseInt(parts[1], 10) - 1;
    return MONTH_NAMES_GENITIVE[idx] + " " + parts[0];
  }

  var MONTH_NAMES_NOMINATIVE = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
  ];

  // Label for a rating-switcher button: "Июль 2026". When two ratings of the
  // same title fall in the same month, the day is added so they stay distinguishable.
  function ratingChipLabel(ts, withDay) {
    if (typeof ts !== "number") return null;
    var d = new Date(ts);
    if (withDay) return d.getDate() + " " + MONTH_NAMES_GENITIVE[d.getMonth()] + " " + d.getFullYear();
    return MONTH_NAMES_NOMINATIVE[d.getMonth()] + " " + d.getFullYear();
  }

  // Index into m.ratingHistory of the past rating currently shown, or null for
  // the current one. Always null while the rating is being edited.
  function viewedHistoryIndex(m) {
    if (m.rated === false || state.unlockedIds[m.id] || state.ratingDrafts[m.id]) return null;
    var hist = m.ratingHistory || [];
    var v = state.ratingView[m.id];
    return (typeof v === "number" && v >= 0 && v < hist.length) ? v : null;
  }

  var AWARD_CATEGORY_KEYS = ["overall", "worst"].concat(DEFAULT_CRITERIA).concat(["cover"]);

  // "overall" and "worst" are both scored on the 0-100 average scale;
  // per-criterion categories use the raw 1-10 criterion score.
  function isOverallScaleCategory(ck) {
    return ck === "overall" || ck === "worst";
  }

  // A title is eligible for the award of the month its CURRENT score was
  // given in — normally when it was first rated, but a re-rate moves it to
  // the new month. Falls back to the add-date for legacy data that predates
  // this timestamp.
  function ratingTs(m) {
    return (typeof m.lastRatedAt === "number") ? m.lastRatedAt : getCreatedAt(m);
  }

  function eligibleForMonth(monthKey) {
    return state.manhwas.map(function (m) {
      return Features.ratingInMonth(m, monthKey, average);
    }).filter(Boolean);
  }

  // Full eligible pool for one category, sorted best-first (used both as the
  // pick-list for choosing candidates and to display their scores).
  function eligiblePoolForCategory(monthKey, categoryKey) {
    var eligible = eligibleForMonth(monthKey);
    var scored = [];
    eligible.forEach(function (m) {
      if (categoryKey === "cover") {
        if (!m.coverUrl) return;
        var artCriterion = m.criteria.find(function (cc) { return cc.name === "Рисовка"; });
        scored.push({ manhwa: m, score: artCriterion ? artCriterion.score : 0 });
        return;
      }
      if (categoryKey === "overall" || categoryKey === "worst") {
        var avg = average(m.criteria);
        if (avg !== null) scored.push({ manhwa: m, score: avg });
      } else {
        var c = m.criteria.find(function (cc) { return cc.name === categoryKey; });
        if (c) scored.push({ manhwa: m, score: c.score });
      }
    });
    // "Худший тайтл месяца" ranks lowest score first — everything else best-first.
    scored.sort(function (a, b) { return categoryKey === "worst" ? a.score - b.score : b.score - a.score; });
    return scored;
  }

  function getCandidateIds(monthKey, categoryKey) {
    var byMonth = state.awardCandidates[monthKey];
    return (byMonth && byMonth[categoryKey]) || [];
  }

  function toggleCandidate(monthKey, categoryKey, manhwaId) {
    if (!state.awardCandidates[monthKey]) state.awardCandidates[monthKey] = {};
    if (!state.awardCandidates[monthKey][categoryKey]) state.awardCandidates[monthKey][categoryKey] = [];
    var list = state.awardCandidates[monthKey][categoryKey];
    var idx = list.indexOf(manhwaId);
    if (idx === -1) list.push(manhwaId); else list.splice(idx, 1);
    saveAwards();
  }

  // Chosen candidates for a category, resolved to manhwa+score, best-first.
  function candidateEntries(monthKey, categoryKey) {
    var ids = getCandidateIds(monthKey, categoryKey);
    return eligiblePoolForCategory(monthKey, categoryKey).filter(function (e) {
      return ids.indexOf(e.manhwa.id) !== -1;
    });
  }

  // Categories worth showing for a month — at least one eligible title exists for them.
  function availableCategoriesForMonth(monthKey) {
    return AWARD_CATEGORY_KEYS.filter(function (ck) {
      return !!getWinner(monthKey, ck) || eligiblePoolForCategory(monthKey, ck).length > 0;
    });
  }

  function lastCompletedMonthKey() {
    var now = new Date();
    var d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return monthKeyOf(d.getTime());
  }

  function getWinner(monthKey, categoryKey) {
    var picks = state.awardWinners[monthKey];
    if (!picks || !picks[categoryKey]) return null;
    var value = picks[categoryKey];
    return isPlainObject(value) ? value : findManhwa(String(value));
  }

  // Preserve the winning rating even if its library entry changes or is deleted.
  function setWinner(monthKey, categoryKey, manhwaId) {
    if (monthKey !== lastCompletedMonthKey() || AWARD_CATEGORY_KEYS.indexOf(categoryKey) < 0) return false;
    var candidate = candidateEntries(monthKey, categoryKey).find(function (c) { return c.manhwa.id === manhwaId; });
    if (!candidate || getWinner(monthKey, categoryKey)) return false;
    if (!state.awardWinners[monthKey]) state.awardWinners[monthKey] = {};
    state.awardWinners[monthKey][categoryKey] = Features.awardSnapshot(candidate.manhwa, monthKey, categoryKey, average, false);
    saveAwards();
    return true;
  }

  function canEditWinners(monthKey) {
    return monthKey === lastCompletedMonthKey() && !state.awardEditUsed[monthKey];
  }

  // One-time-per-month "undo": clears the picked winners (keeps the candidate
  // shortlists intact) and burns the month's single edit token.
  function editWinners(monthKey) {
    if (!canEditWinners(monthKey)) return;
    state.awardEditUsed[monthKey] = true;
    state.awardWinners[monthKey] = {};
    saveAwards();
  }

  function awardsForManhwa(m) {
    var result = [];
    Object.keys(state.awardWinners).forEach(function (monthKey) {
      var picks = state.awardWinners[monthKey];
      Object.keys(picks).forEach(function (categoryKey) {
        if (winnerId(picks[categoryKey]) === m.id) result.push({ monthKey: monthKey, categoryKey: categoryKey });
      });
    });
    return result;
  }

  // "Худший тайтл месяца" is an anti-award — it shouldn't count as a real win
  // for the golden-cover treatment, the year-champion tally, or the trophy icon.
  function positiveAwardsForManhwa(m) {
    return awardsForManhwa(m).filter(function (a) { return a.categoryKey !== "worst"; });
  }

  function awardIcon(categoryKey) {
    return categoryKey === "worst" ? "🗑️" : "🏆";
  }

  function yearsWithData() {
    var years = {};
    Object.keys(state.awardWinners).forEach(function (key) { years[key.slice(0, 4)] = true; });
    state.manhwas.forEach(function (m) {
      var ts = getCreatedAt(m);
      if (ts !== null) years[new Date(ts).getFullYear()] = true;
      if (m.rated) Features.ratings(m, average).forEach(function (r) { if (Number.isFinite(r.ts)) years[new Date(r.ts).getFullYear()] = true; });
    });
    var list = Object.keys(years).map(Number);
    list.sort(function (a, b) { return b - a; });
    return list;
  }

  function titlesForYear(year) {
    return state.manhwas.filter(function (m) {
      var ts = getCreatedAt(m);
      return ts !== null && new Date(ts).getFullYear() === year;
    });
  }

  function championsForYear(year) {
    var counts = {}, snapshots = {};
    Object.keys(state.awardWinners).sort().forEach(function (monthKey) {
      if (parseInt(monthKey.split("-")[0], 10) !== year) return;
      var picks = state.awardWinners[monthKey];
      Object.keys(picks).forEach(function (ck) {
        if (ck === "worst") return; // anti-award doesn't count toward "title of the year"
        var mid = winnerId(picks[ck]);
        snapshots[mid] = getWinner(monthKey, ck);
        counts[mid] = (counts[mid] || 0) + 1;
      });
    });
    var list = Object.keys(counts).map(function (mid) {
      return { manhwa: snapshots[mid] || findManhwa(mid), count: counts[mid] };
    }).filter(function (x) { return x.manhwa; });
    list.sort(function (a, b) { return b.count - a.count; });
    return list;
  }

  function statusById(id) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === id) return STATUSES[i];
    return STATUSES[0];
  }

  function typeById(id) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i];
    return TYPES[0];
  }

  var ANILIST_QUERY =
    "query ($search: String) { Page(page: 1, perPage: 8) { pageInfo { total } media(search: $search, type: MANGA, sort: SEARCH_MATCH) { " +
    "id title { romaji english native } coverImage { large } genres countryOfOrigin format status } } }";

  // Public AniList GraphQL endpoint — no API key needed, CORS-enabled for
  // browser use. Fetches a shortlist of matches so the user picks the right
  // one instead of the app guessing from a single top result.
  // "type: MANGA" already covers manhwa/manhua too — AniList only splits
  // ANIME vs MANGA; manhwa/manhua are told apart by countryOfOrigin, not type.
  var aniListRequestId = 0;
  function searchAniList(query) {
    var requestId = ++aniListRequestId;
    state.aniListSearching = true;
    state.aniListError = null;
    state.aniListResults = null;
    state.aniListPickedIndex = null;
    render();

    fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: query } })
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return null; })
          .then(function (data) {
            if (!res.ok) {
              var apiMsg = data && data.errors && data.errors[0] && data.errors[0].message;
              throw new Error(apiMsg || ("AniList вернул ошибку " + res.status));
            }
            return data;
          });
      })
      .then(function (data) {
        if(requestId !== aniListRequestId || !state.addingManhwa)return;
        if (!data) throw new Error("AniList прислал пустой/некорректный ответ");
        if (data.errors && data.errors.length) throw new Error(data.errors[0].message || "ошибка AniList");
        var page = data.data && data.data.Page;
        state.aniListResults = (page && page.media) || [];
        state.aniListSearching = false;
        render();
      })
      .catch(function (err) {
        if(requestId !== aniListRequestId || !state.addingManhwa)return;
        console.error("AniList search failed:", err);
        state.aniListSearching = false;
        state.aniListError = (err && err.message) ? err.message : "Не удалось найти на AniList — проверь соединение с интернетом.";
        render();
      });
  }

  function newManhwa(title, type, coverUrl) {
    return {
      id: uid(),
      title: title,
      status: "reading",
      type: type || "manhwa",
      rated: false,
      createdAt: Date.now(),
      completedAt: null,
      notes: "",
      emotionRating: null,
      emotionRatedAt: null,
      tags: [],
      coverUrl: coverUrl || "",
      genres: [],
      altTitles: { en: "", ja: "", ko: "", ru: "" },
      criteria: DEFAULT_CRITERIA.map(function (name) {
        return { id: uid(), name: name, score: 5 };
      }),
      lastRatedAt: null,
      ratingHistory: []
    };
  }

  function findManhwa(id) {
    for (var i = 0; i < state.manhwas.length; i++) if (state.manhwas[i].id === id) return state.manhwas[i];
    return null;
  }

  var RATING_FIELDS = ["criteria", "notes", "tags", "genres", "altTitles", "coverUrl", "emotionRating", "emotionRatedAt", "ratingReason"];

  function ratingFingerprint(m) {
    return JSON.stringify(RATING_FIELDS.filter(function (key) { return key !== "ratingReason"; }).map(function (key) { return m[key]; }).concat([m.lastRatedAt, m.ratingHistory || []]));
  }

  function editableManhwa(id) {
    var m = findManhwa(id), draft = state.ratingDrafts[id];
    if (!m || !draft) return m;
    Object.keys(m).forEach(function (key) {
      if (RATING_FIELDS.indexOf(key) === -1) draft.value[key] = m[key];
    });
    return draft.value;
  }

  function beginRerating(id) {
    var m = findManhwa(id);
    if (!m || !m.rated) return;
    state.ratingDrafts[id] = {
      base: ratingFingerprint(m),
      value: JSON.parse(JSON.stringify(m)),
      snapshot: { ts: ratingTs(m), avg: average(m.criteria), criteria: JSON.parse(JSON.stringify(m.criteria)), notes: m.notes || "", reason: m.ratingReason || "" }
    };
    state.ratingDrafts[id].value.ratingReason = "";
    saveRatingDrafts();
  }

  function saveRatingDrafts() {
    return persistKey(RATING_DRAFTS_KEY, state.ratingDrafts).catch(function () {});
  }

  function loadRatingDrafts() {
    return readKey(RATING_DRAFTS_KEY).then(function (drafts) {
      if (!isPlainObject(drafts)) return;
      Object.keys(drafts).forEach(function (id) {
        var d = drafts[id], m = findManhwa(id);
        if (!m || !isPlainObject(d) || d.base !== ratingFingerprint(m) || !isPlainObject(d.snapshot)) return;
        var value = sanitizeImportedManhwa(d.value, {});
        if (value) state.ratingDrafts[id] = { base: d.base, value: value, snapshot: d.snapshot };
      });
    });
  }

  function cancelRerating(id) {
    delete state.ratingDrafts[id];
    delete state.unlockedIds[id];
    saveRatingDrafts();
  }

  function commitRerating(id) {
    var m = findManhwa(id), d = state.ratingDrafts[id];
    if (!m || !d) return null;
    if (d.base !== ratingFingerprint(m)) {
      state.error = "Данные тайтла изменились на другом устройстве. Отмени черновик и начни переоценку заново.";
      return false;
    }
    RATING_FIELDS.forEach(function (key) { m[key] = JSON.parse(JSON.stringify(d.value[key] === undefined ? null : d.value[key])); });
    if (!Array.isArray(m.ratingHistory)) m.ratingHistory = [];
    m.ratingHistory.push(d.snapshot);
    m.lastRatedAt = Date.now();
    delete state.ratingDrafts[id];
    return d.snapshot;
  }

  function ratedScore(m) {
    return m.rated === true ? average(m.criteria) : null;
  }

  function winnerId(value) { return String(isPlainObject(value) ? value.id : value); }

  function normalizeWinners(raw) {
    var out = {};
    if (!isPlainObject(raw)) return out;
    Object.keys(raw).filter(function (key) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(key); }).forEach(function (key) {
      if (!isPlainObject(raw[key])) return;
      out[key] = {};
      AWARD_CATEGORY_KEYS.forEach(function (cat) {
        var v = raw[key][cat];
        if (v === undefined || v === null) return;
        if (isPlainObject(v)) {
          var m = sanitizeImportedManhwa(v, {});
          if (!m) return;
          var snap = Features.awardSnapshot(m, key, cat, average, v.legacy);
          snap.avg = v.avg === null ? null : Math.max(1, Math.min(100, finiteOr(v.avg, average(m.criteria))));
          snap.awardedAt = finiteOr(v.awardedAt, null);
          out[key][cat] = snap;
        } else if (typeof v === "string" || typeof v === "number") {
          var live = findManhwa(String(v));
          var historical = live && Features.ratingInMonth(live, key, average);
          out[key][cat] = Features.awardSnapshot(historical || live || {
            id: String(v), title: "Удалённый тайтл", criteria: []
          }, key, cat, average, true);
        }
      });
    });
    return out;
  }

  function saveRecentOpened() { return persistKey(RECENT_OPENED_KEY, state.recentOpened).catch(function () {}); }
  function loadRecentOpened() {
    return readKey(RECENT_OPENED_KEY).then(function (raw) {
      if (!isPlainObject(raw)) return;
      state.manhwas.forEach(function (m) {
        if (typeof raw[m.id] === "number" && isFinite(raw[m.id]) && raw[m.id] > 0) state.recentOpened[m.id] = raw[m.id];
      });
    });
  }
  function openTitle(id) {
    chapterSaveNotice='';
    var m = findManhwa(id);
    if (!m) return;
    if(!state.selectedId) usability.returnScroll=window.scrollY||0;
    usability.detailSection='rating';
    libraryUI.menuOpen=false;
    state.recentOpened[id] = Date.now();
    saveRecentOpened();
    state.selectedId = id;
    state.candidatePanelOpen = false;
    state.statusPickerOpen = false;
    render();
  }

  function deltaText(value) { return value > 0 ? "+" + value : String(value); }
  function deltaClass(value) { return value > 0 ? "up" : value < 0 ? "down" : "same"; }
  function renderComparison(m) {
    var all = Features.ratings(m, average), to = viewedHistoryIndex(m);
    if (to === null) to = all.length - 1;
    if (to < 1) return "";
    var from = state.compareFrom[m.id];
    if (!(from >= 0 && from < to)) from = to - 1;
    var diff = Features.comparison(all[from], all[to]);
    return '<section class="mt-paper mt-comparison"><div class="mt-section-eyebrow">КАК ИЗМЕНИЛОСЬ МНЕНИЕ</div>' +
      '<div class="mt-comparison-score"><span>' + Math.round(all[from].avg) + '</span><span class="mt-comparison-arrow">→</span><strong>' +
      Math.round(all[to].avg) + '</strong><span class="mt-delta ' + deltaClass(diff.delta) + '">' + deltaText(diff.delta) + '</span></div>' +
      '<label class="mt-field-label" for="compare-from">Сравнить выбранную оценку с</label><select class="mt-input" id="compare-from">' +
      all.slice(0, to).map(function (r, i) { return '<option value="' + i + '"' + (i === from ? ' selected' : '') + '>' +
        escapeHtml(ratingChipLabel(r.ts, true) || "Ранее") + ' · ' + Math.round(r.avg) + '/100</option>'; }).join("") + '</select>' +
      '<div class="mt-comparison-rows">' + diff.rows.map(function (r) {
        return '<div class="mt-comparison-row"><span>' + escapeHtml(r.name) + '</span><span>' +
          (r.before === null ? '—' : r.before) + ' → ' + (r.after === null ? '—' : r.after) + '</span><b class="mt-delta ' + deltaClass(r.delta || 0) + '">' +
          (r.delta === null ? (r.before === null ? 'Новый' : 'Убран') : deltaText(r.delta)) + '</b></div>';
      }).join("") + '</div>' + (all[to].reason ? '<p class="mt-comparison-reason">' + escapeHtml(all[to].reason) + '</p>' : '') + '</section>';
  }

  function awardMonths() {
    var last = lastCompletedMonthKey(), keys = {};
    keys[last] = true;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(state.awardsMonth || '') && state.awardsMonth <= last) keys[state.awardsMonth] = true;
    Object.keys(state.awardWinners).concat(Object.keys(state.awardCandidates)).forEach(function (k) { if (k <= last) keys[k] = true; });
    state.manhwas.forEach(function (m) {
      if (!m.rated) return;
      Features.ratings(m, average).forEach(function (r) { if (typeof r.ts === "number") { var k = monthKeyOf(r.ts); if (k <= last) keys[k] = true; } });
    });
    return Object.keys(keys).sort().reverse();
  }
  function awardPreviewAttrs(w) {
    return 'data-preview-month="' + escapeHtml(w.month || state.awardsMonth || lastCompletedMonthKey()) + '" data-preview-category="' + escapeHtml(w.category || "overall") + '"';
  }
  function renderAwardPreview() {
    var w = state.awardPreview;
    if (!w) return "";
    return '<div class="mt-feature-backdrop"><section class="mt-feature-dialog" role="dialog" aria-modal="true" aria-label="Победитель премии">' +
      '<button class="mt-ghost-btn mt-dialog-close" id="close-award-preview">Закрыть ✕</button>' +
      '<div class="mt-section-eyebrow">' + escapeHtml(monthLabel(w.month)) + ' · ' + escapeHtml(AWARD_LABELS[w.category] || w.category) + '</div>' +
      '<h2>' + escapeHtml(displayTitle(w)) + '</h2>' +
      (w.coverUrl ? '<img class="mt-archive-cover" src="' + escapeHtml(w.coverUrl) + '" alt="Обложка победителя" />' : '') +
      '<div class="mt-archive-score">' + (w.avg === null ? '—' : Math.round(w.avg) + '/100') + '</div>' +
      radarSvg(w.criteria, {}) + '<p class="mt-feature-hint">' + (w.legacy ?
        'Старая награда: снимок восстановлен из доступных данных. Оригинальное оформление могло отличаться.' :
        'Сохранено при вручении награды. Последующие изменения тайтла не меняют этот снимок.') + '</p>' +
      (findManhwa(w.id) ? '<button class="mt-primary-btn" id="open-archive-title">Открыть тайтл в библиотеке</button>' : '') + '</section></div>';
  }

  var shareSequence = 0;
  function closeShareCard() {
    shareSequence++;
    if (state.shareCard && state.shareCard.url) URL.revokeObjectURL(state.shareCard.url);
    state.shareCard = null;
  }
  function openShareCard(m) {
    closeShareCard();
    var token = shareSequence;
    var index = viewedHistoryIndex(m), all = Features.ratings(m, average), r = all[index === null ? all.length - 1 : index];
    state.shareCard = { loading: true };
    render();
    return Features.createShareCard({ title: displayTitle(m), coverUrl: m.coverUrl, criteria: r.criteria,
      avg: r.avg, ts: r.ts, notes: r.notes || "", nick: displayNick() }).then(function (result) {
      if (token !== shareSequence) return;
      state.shareCard = { blob: result.blob, url: URL.createObjectURL(result.blob), missingCover: result.missingCover };
      render();
    }).catch(function () {
      if (token !== shareSequence) return;
      state.shareCard = { error: "Не удалось создать карточку. Попробуй ещё раз." };
      render();
    });
  }
  function renderShareCard() {
    var s = state.shareCard;
    if (!s) return "";
    return '<div class="mt-feature-backdrop"><section class="mt-feature-dialog" role="dialog" aria-modal="true" aria-label="Карточка для публикации">' +
      '<button class="mt-ghost-btn mt-dialog-close" id="close-share-card">Закрыть ✕</button><h2>Поделиться впечатлением</h2>' +
      (s.loading ? '<p role="status">Готовлю карточку…</p>' : s.error ? '<p role="alert">' + escapeHtml(s.error) + '</p>' :
        '<img class="mt-share-preview" src="' + s.url + '" alt="Карточка с оценкой и рецензией" />' +
        (s.missingCover ? '<p class="mt-feature-hint">Обложка недоступна для экспорта. Вместо неё — фирменная заставка AM.</p>' : '') +
        '<a class="mt-primary-btn mt-download-card" download="AM-Tracker-rating.png" href="' + s.url + '">Скачать PNG</a>' +
        (navigator.share && navigator.canShare && typeof File !== 'undefined' && navigator.canShare({ files: [new File([s.blob], 'AM-Tracker-rating.png', { type: 'image/png' })] }) ?
          '<button class="mt-ghost-btn" id="native-share-card">Поделиться…</button>' : '')) + '</section></div>';
  }

  // Preserve awarded snapshots and remove the deleted title from candidate lists.
  function purgeAwardReferences(id) {
    var changed = false;
    // Freeze legacy winners before deleting a title; the archive survives deletion.
    state.awardWinners = normalizeWinners(state.awardWinners);
    changed = true;
    delete state.recentOpened[id];
    saveRecentOpened();
    Object.keys(state.awardCandidates).forEach(function (monthKey) {
      var byCategory = state.awardCandidates[monthKey];
      Object.keys(byCategory).forEach(function (ck) {
        var idx = byCategory[ck].indexOf(id);
        if (idx !== -1) { byCategory[ck].splice(idx, 1); changed = true; }
      });
    });
    if (changed) saveAwards();
  }

  function findManhwaByTitle(title) {
    var norm = title.trim().toLowerCase();
    for (var i = 0; i < state.manhwas.length; i++) {
      if (state.manhwas[i].title.trim().toLowerCase() === norm) return state.manhwas[i];
    }
    return null;
  }

  /* ---------- backup import validation ---------- */

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function cleanStringList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(function (x) { return typeof x === "string" && x.trim() !== ""; });
  }

  function finiteOr(v, fallback) {
    var n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && isFinite(n) ? n : fallback;
  }

  // Returns a repaired copy of one imported title, or null when it is not
  // usable at all (not an object / no title). Unknown fields are kept as-is;
  // only the fields the UI relies on are forced into a safe shape, so a
  // hand-edited or damaged backup can't crash render().
  function sanitizeImportedManhwa(raw, usedIds) {
    if (!isPlainObject(raw)) return null;
    if (typeof raw.title !== "string" || raw.title.trim() === "") return null;

    var m = {};
    Object.keys(raw).forEach(function (k) { m[k] = raw[k]; });

    var id = (typeof raw.id === "string" || typeof raw.id === "number") ? String(raw.id) : "";
    if (!id || usedIds[id]) id = uid();
    usedIds[id] = true;
    m.id = id;

    if (!STATUSES.some(function (x) { return x.id === m.status; })) m.status = "reading";
    if (!TYPES.some(function (x) { return x.id === m.type; })) m.type = "manhwa";
    // Legacy backups predate the rated flag; match the startup migration.
    m.rated = typeof m.rated === "boolean" ? m.rated : true;

    m.completedAt = finiteOr(m.completedAt, null);
    m.journal = Features.journal(m.journal);
    m.collectionIds=cleanStringList(m.collectionIds).slice(0,40);
    m.readingRun=Number.isInteger(m.readingRun)&&m.readingRun>0&&m.readingRun<=10000?m.readingRun:1;
    m.readingRuns=(Array.isArray(m.readingRuns)?m.readingRuns:[]).filter(function(r){return r&&Number.isInteger(r.run)&&r.run>0&&r.run<m.readingRun&&Number.isFinite(r.ended);}).slice(-100).map(function(r){return {run:r.run,ended:r.ended,chapter:Number.isFinite(r.chapter)?r.chapter:0,score:Number.isFinite(r.score)?r.score:null};});
    m.reading = Features.readingProgress(m);
    m.notes = typeof m.notes === "string" ? m.notes : "";
    m.ratingReason = typeof m.ratingReason === "string" ? m.ratingReason.slice(0, 500) : "";
    var emo = finiteOr(m.emotionRating, null);
    m.emotionRating = emo === null ? null : Math.min(5, Math.max(1, emo));
    m.emotionRatedAt = finiteOr(m.emotionRatedAt, null);
    m.tags = cleanStringList(m.tags);
    m.genres = cleanStringList(m.genres);
    m.coverUrl = typeof m.coverUrl === "string" ? m.coverUrl : "";

    var alt = isPlainObject(m.altTitles) ? m.altTitles : {};
    m.altTitles = {};
    ["en", "ja", "ko", "ru"].forEach(function (k) {
      m.altTitles[k] = typeof alt[k] === "string" ? alt[k] : "";
    });

    if (Array.isArray(m.criteria)) {
      var seen = {};
      m.criteria = m.criteria.filter(function (c) {
        return isPlainObject(c) && typeof c.name === "string" && c.name.trim() !== "";
      }).map(function (c) {
        var cid = (typeof c.id === "string" || typeof c.id === "number") ? String(c.id) : "";
        if (!cid || seen[cid]) cid = uid();
        seen[cid] = true;
        return { id: cid, name: c.name, score: Math.min(10, Math.max(1, finiteOr(c.score, 5))) };
      });
    } else {
      m.criteria = DEFAULT_CRITERIA.map(function (name) {
        return { id: uid(), name: name, score: 5 };
      });
    }

    m.lastRatedAt = finiteOr(m.lastRatedAt, null);
    if (Array.isArray(m.ratingHistory)) {
      m.ratingHistory = m.ratingHistory.filter(function (h) {
        return isPlainObject(h) && typeof h.ts === "number" && isFinite(h.ts);
      }).map(function (h) {
        var crit = Array.isArray(h.criteria) ? h.criteria.filter(function (c) {
          return isPlainObject(c) && typeof c.name === "string" && c.name.trim() !== "";
        }).map(function (c) {
          return { id: String(c.id || uid()), name: c.name, score: Math.min(10, Math.max(1, finiteOr(c.score, 5))) };
        }) : [];
        return { ts: h.ts, avg: finiteOr(h.avg, average(crit) || 0), criteria: crit,
          notes: typeof h.notes === "string" ? h.notes : "", reason: typeof h.reason === "string" ? h.reason.slice(0, 500) : "" };
      });
    } else {
      m.ratingHistory = [];
    }
    return m;
  }

  // Sanitises the whole list; `skipped` counts entries that had to be dropped.
  function sanitizeImportedManhwas(list) {
    var usedIds = {};
    var out = [];
    var skipped = 0;
    list.forEach(function (raw) {
      var m = sanitizeImportedManhwa(raw, usedIds);
      if (m) out.push(m); else skipped++;
    });
    return { list: out, skipped: skipped };
  }

  // { "2026-09": { category: value } } — keeps only well-formed months/categories.
  function sanitizeMonthMap(obj, valueOk) {
    var out = {};
    if (!isPlainObject(obj)) return out;
    Object.keys(obj).forEach(function (month) {
      var inner = obj[month];
      if (!isPlainObject(inner)) return;
      out[month] = {};
      Object.keys(inner).forEach(function (cat) {
        if (valueOk(inner[cat])) out[month][cat] = inner[cat];
      });
    });
    return out;
  }

  function sanitizeImportedActivityLog(list) {
    var out = list.filter(function (e) {
      return isPlainObject(e) && typeof e.ts === "number" && isFinite(new Date(e.ts).getTime()) && typeof e.type === "string";
    });
    if (out.length > ACTIVITY_LOG_MAX) out = out.slice(out.length - ACTIVITY_LOG_MAX);
    return out;
  }

  function sanitizeImportedAchievements(obj) {
    var out = {};
    if (!isPlainObject(obj)) return out;
    ACHIEVEMENTS.forEach(function (a) {
      if (obj[a.id]) out[a.id] = finiteOr(obj[a.id], Date.now());
    });
    return out;
  }

  /* ---------- persistence ---------- */
  // Reads the pre-IndexedDB localStorage format — used both as the one-time
  // migration source and as the permanent fallback if IndexedDB never works.
  function loadFromLocalStorageInto(target) {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      target.manhwas = raw ? JSON.parse(raw) : [];
    } catch (e) {
      target.manhwas = [];
    }
    try {
      target.changelogSeenVersion = window.localStorage.getItem(CHANGELOG_SEEN_KEY);
      // Old releases stored this one key as plain text; new writes use JSON.
      if (target.changelogSeenVersion && target.changelogSeenVersion[0] === '"') {
        target.changelogSeenVersion = JSON.parse(target.changelogSeenVersion);
      }
    } catch (e) {
      target.changelogSeenVersion = null;
    }
    try {
      var rawAwards = window.localStorage.getItem(AWARDS_STORAGE_KEY);
      target.awardWinners = rawAwards ? JSON.parse(rawAwards) : {};
    } catch (e) {
      target.awardWinners = {};
    }
    try {
      var rawCandidates = window.localStorage.getItem(AWARD_CANDIDATES_STORAGE_KEY);
      target.awardCandidates = rawCandidates ? JSON.parse(rawCandidates) : {};
    } catch (e) {
      target.awardCandidates = {};
    }
    try {
      var rawEditUsed = window.localStorage.getItem(AWARD_EDIT_USED_STORAGE_KEY);
      target.awardEditUsed = rawEditUsed ? JSON.parse(rawEditUsed) : {};
    } catch (e) {
      target.awardEditUsed = {};
    }
    try {
      var rawLog = window.localStorage.getItem(ACTIVITY_LOG_STORAGE_KEY);
      target.activityLog = rawLog ? JSON.parse(rawLog) : [];
    } catch (e) {
      target.activityLog = [];
    }
    try {
      var rawXp = window.localStorage.getItem(XP_STORAGE_KEY);
      target.totalXp = rawXp ? JSON.parse(rawXp) : 0;
    } catch (e) {
      target.totalXp = 0;
    }
    try {
      var rawAchv = window.localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
      target.unlockedAchievements = rawAchv ? JSON.parse(rawAchv) : {};
    } catch (e) {
      target.unlockedAchievements = {};
    }
  }

  function applyPostLoadMigrations() {
    // Carry the "Динамика" → "Темп/Ритм" rename over into already-saved award
    // picks so old choices for that category keep working under the new key.
    var awardsMigrated = false;
    [state.awardWinners, state.awardCandidates].forEach(function (byMonth) {
      Object.keys(byMonth).forEach(function (monthKey) {
        var byCategory = byMonth[monthKey];
        if (byCategory && byCategory["Динамика"] !== undefined && byCategory["Темп/Ритм"] === undefined) {
          byCategory["Темп/Ритм"] = byCategory["Динамика"];
          delete byCategory["Динамика"];
          awardsMigrated = true;
        }
      });
    });
    var normalizedWinners = normalizeWinners(state.awardWinners);
    if (JSON.stringify(normalizedWinners) !== JSON.stringify(state.awardWinners)) awardsMigrated = true;
    state.awardWinners = normalizedWinners;
    if (awardsMigrated) saveAwards();

    // One-time migration: titles imported with non-standard ids (e.g. bulk backups
    // like "m1", "m2"...) can't have their add-date recovered from the id tail,
    // which silently excluded them from awards forever. Back-date them to the
    // middle of last month so they show up in the awards right away instead of
    // waiting a full month for a "real" date to accumulate.
    var migrated = false;
    var fallbackDate = new Date();
    fallbackDate.setMonth(fallbackDate.getMonth() - 1);
    fallbackDate.setDate(15);
    var fallbackCreatedAt = fallbackDate.getTime();
    state.manhwas.forEach(function (m) {
      if (typeof m.createdAt !== "number" && getCreatedAt(m) === null) {
        m.createdAt = fallbackCreatedAt;
        migrated = true;
      }
      // Same bulk imports never had a "rated" field at all (not even false),
      // which made eligibleForMonth() silently skip them — they display as
      // normal finished titles everywhere else, so treat them as rated here too.
      if (typeof m.rated !== "boolean") {
        m.rated = true;
        migrated = true;
      }
      // Re-rating didn't exist before this feature shipped — back-fill the
      // "when was the current score given" timestamp from the add-date, so
      // award eligibility for already-rated titles doesn't silently shift.
      if (typeof m.lastRatedAt !== "number") {
        m.lastRatedAt = m.rated ? getCreatedAt(m) : null;
        migrated = true;
      }
      if (!Array.isArray(m.ratingHistory)) {
        m.ratingHistory = [];
        migrated = true;
      }
      // "Динамика" was renamed to "Темп/Ритм" — carry the rename over to
      // criteria already saved under the old name so the formula/labels stay in sync.
      (m.criteria || []).forEach(function (c) {
        if (c.name === "Динамика") {
          c.name = "Темп/Ритм";
          migrated = true;
        }
      });
    });
    if (migrated) save();

    // One-time baseline: XP is monotonic and never existed before this
    // feature shipped, so a long-time user would otherwise start at 0
    // despite having a full library already. Runs harmlessly every load
    // until totalXp becomes non-zero (a fresh install seeds to 0 anyway).
    if (!state.totalXp) {
      state.totalXp = seedXpFromCurrentState();
      if (state.totalXp) saveXp();
    }

    // Retroactively unlock anything already true from existing history —
    // same reasoning as the XP seed above. No XP double-dip here: XP for
    // achievements met at seed time is already folded into seedXpFromCurrentState's
    // inputs (rated/add/award counts), so this only awards XP for achievements
    // that AREN'T also double-counted — streaks, reviews, worst/cover awards,
    // drops, rank — which is why rank_legend has 0 xp and the rest are additive extras.
    checkAchievements();
  }

  // Loads app state. Prefers IndexedDB (no practical size cap); the very
  // first time this runs on a device it migrates whatever's in localStorage
  // (or starts empty, on a fresh install) into IndexedDB and marks that done
  // so it only ever happens once. If IndexedDB isn't usable at all in this
  // browser, falls back fully to localStorage — same as before IDB support.
  function load() {
    return openIdb()
      .then(function () {
        return idbGet(IDB_MIGRATED_KEY);
      })
      .then(function (migrated) {
        if (migrated) {
          // Guard each read individually: one key failing to read shouldn't
          // discard the whole IndexedDB dataset and roll back to whatever
          // stale snapshot localStorage had at migration time.
          var safe = function (p) { return p.catch(function () { return undefined; }); };
          return Promise.all([
            safe(idbGet(STORAGE_KEY)), safe(idbGet(CHANGELOG_SEEN_KEY)), safe(idbGet(AWARDS_STORAGE_KEY)),
            safe(idbGet(AWARD_CANDIDATES_STORAGE_KEY)), safe(idbGet(AWARD_EDIT_USED_STORAGE_KEY)), safe(idbGet(ACTIVITY_LOG_STORAGE_KEY)),
            safe(idbGet(XP_STORAGE_KEY)), safe(idbGet(ACHIEVEMENTS_STORAGE_KEY))
          ]).then(function (r) {
            state.manhwas = r[0] || [];
            state.changelogSeenVersion = r[1] || null;
            state.awardWinners = r[2] || {};
            state.awardCandidates = r[3] || {};
            state.awardEditUsed = r[4] || {};
            state.activityLog = r[5] || [];
            state.totalXp = r[6] || 0;
            state.unlockedAchievements = r[7] || {};
          });
        }
        loadFromLocalStorageInto(state);
        return Promise.all([
          idbSet(STORAGE_KEY, state.manhwas),
          idbSet(CHANGELOG_SEEN_KEY, state.changelogSeenVersion),
          idbSet(AWARDS_STORAGE_KEY, state.awardWinners),
          idbSet(AWARD_CANDIDATES_STORAGE_KEY, state.awardCandidates),
          idbSet(AWARD_EDIT_USED_STORAGE_KEY, state.awardEditUsed),
          idbSet(ACTIVITY_LOG_STORAGE_KEY, state.activityLog),
          idbSet(XP_STORAGE_KEY, state.totalXp),
          idbSet(ACHIEVEMENTS_STORAGE_KEY, state.unlockedAchievements),
          idbSet(IDB_MIGRATED_KEY, true)
        ]);
      })
      .catch(function () {
        // IndexedDB unavailable/broken in this browser — fall back fully to
        // localStorage, exactly like the app worked before IndexedDB support.
        idbAvailable = false;
        loadFromLocalStorageInto(state);
      })
      .then(function () {
        applyPostLoadMigrations();
      });
  }

  function save() {
    state.error = null;
    persistKey(STORAGE_KEY, state.manhwas).catch(function () {});
    saveRatingDrafts();
    checkAchievements();

    updateGoals();
    syncPing();
  }

  function syncPing() {
    if (!applyingRemote && window.AMSync) window.AMSync.notifyLocalChange();
  }

  function saveAwards() {
    persistKey(AWARDS_STORAGE_KEY, state.awardWinners).catch(function () {});
    persistKey(AWARD_CANDIDATES_STORAGE_KEY, state.awardCandidates).catch(function () {});
    persistKey(AWARD_EDIT_USED_STORAGE_KEY, state.awardEditUsed).catch(function () {});
    syncPing();
  }

  function saveActivityLog() {
    persistKey(ACTIVITY_LOG_STORAGE_KEY, state.activityLog).catch(function () {});
    syncPing();
  }

  function saveXp() {
    persistKey(XP_STORAGE_KEY, state.totalXp).catch(function () {});
    syncPing();
  }

  function saveAchievements() {
    persistKey(ACHIEVEMENTS_STORAGE_KEY, state.unlockedAchievements).catch(function () {});
    syncPing();
  }

  // Records one diary entry. Only called for meaningful, user-initiated
  // moments (not every slider tick) — see the call sites. Caps the log so a
  // years-old install doesn't grow localStorage without bound.
  function logActivity(type, manhwaId, title, extra) {
    state.activityLog.push({ xp: XP_VALUES[type] || 0, ts: Date.now(), type: type, manhwaId: manhwaId, title: title, extra: extra || null });
    if (state.activityLog.length > ACTIVITY_LOG_MAX) {
      state.activityLog.splice(0, state.activityLog.length - ACTIVITY_LOG_MAX);
    }
    saveActivityLog();
    var xpGain = XP_VALUES[type] || 0;
    if (xpGain) {
      state.totalXp += xpGain;
      saveXp();
    }
    checkAchievements();
  }

  /* ---------- svg pieces ---------- */
  function stampHtml(value, size) {
    size = size || 58;
    var color = scoreColor(value);
    var display = value === null || value === undefined ? "—" : String(Math.round(value));
    return (
      '<div class="mt-stamp" style="width:' + size + "px;height:" + size + "px;" +
      "border:3px solid " + color + ";box-shadow:0 0 0 2.5px " + color + "33;" +
      "background:" + color + '12;">' +
      '<span style="font-size:' + (size * 0.3) + "px;color:" + color + ';">' + display + "</span>" +
      "</div>"
    );
  }

  function radarSvg(criteria, opts) {
    opts = opts || {};
    var size = opts.size || 220;
    var fill = opts.fillColor || "#C9BFA8";
    var dot = opts.dotColor || "#C9BFA8";
    var n = criteria.length;

    if (n < 3) {
      return (
        '<div style="height:' + size * 0.6 + "px;display:flex;align-items:center;justify-content:center;" +
        'color:#9B999B;font-size:13px;text-align:center;padding:0 20px;">' +
        "Нужно хотя бы 3 критерия для диаграммы</div>"
      );
    }

    var center = size / 2;
    var maxR = size / 2 - 26;

    function ringPts(scale) {
      var pts = [];
      for (var i = 0; i < n; i++) {
        var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        var r = maxR * scale;
        pts.push([center + r * Math.cos(angle), center + r * Math.sin(angle)]);
      }
      return pts;
    }

    function toPolygon(pts) {
      return pts.map(function (p) { return p[0] + "," + p[1]; }).join(" ");
    }

    var valuePoints = criteria.map(function (c, i) {
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var r = maxR * (c.score / 10);
      return [center + r * Math.cos(angle), center + r * Math.sin(angle)];
    });

    var svg = '<svg width="' + size + '" height="' + size + '" style="overflow:visible">';

    [0.25, 0.5, 0.75, 1].forEach(function (s) {
      svg +=
        '<polygon points="' + toPolygon(ringPts(s)) + '" fill="none" stroke="#FFFFFF" ' +
        'stroke-opacity="0.10" stroke-dasharray="3,3" />';
    });

    criteria.forEach(function (c, i) {
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var x = center + maxR * Math.cos(angle);
      var y = center + maxR * Math.sin(angle);
      svg += '<line x1="' + center + '" y1="' + center + '" x2="' + x + '" y2="' + y +
        '" stroke="#FFFFFF" stroke-opacity="0.10" />';
    });

    svg += '<polygon points="' + toPolygon(valuePoints) + '" fill="' + fill +
      '" fill-opacity="0.30" stroke="' + fill + '" stroke-width="2" />';

    valuePoints.forEach(function (p) {
      svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="' + dot +
        '" stroke="#17171A" stroke-width="1.2" />';
    });

    criteria.forEach(function (c, i) {
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var lx = center + (maxR + 20) * Math.cos(angle);
      var ly = center + (maxR + 20) * Math.sin(angle);
      var label = c.name.length > 10 ? c.name.slice(0, 9) + "…" : c.name;
      svg += '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" dominant-baseline="middle" ' +
        'font-family="Manrope, sans-serif" font-weight="700" font-size="11" fill="#B8B6B8">' +
        escapeHtml(label) + "</text>";
    });

    svg += "</svg>";
    return svg;
  }

  // Expands under the status badge on the detail page — pick any status
  // directly instead of cycling through them one tap at a time.
  function renderStatusPicker(m) {
    var rows = STATUSES.map(function (s) {
      var active = s.id === m.status;
      return (
        '<div class="mt-status-option' + (active ? " active" : "") + '" data-set-status="' + s.id +
        '" data-manhwa-id="' + m.id + '">' +
        '<span class="mt-status-option-dot" style="background:' + s.color + '"></span>' +
        '<span class="mt-status-option-label">' + escapeHtml(s.label) + "</span>" +
        (active ? '<span class="mt-status-option-check">✓</span>' : "") +
        "</div>"
      );
    }).join("");
    return '<div class="mt-paper mt-status-picker">' + rows + "</div>";
  }

  function typeBadgeHtml(typeId, extraAttrs) {
    var t = typeById(typeId);
    return (
      '<button class="mt-status-badge" style="border-color:' + t.color + ";color:" + t.color +
      ";background:" + t.color + '18;" ' + (extraAttrs || "") + ">" + t.label + "</button>"
    );
  }

  function renderAniListResults() {
    if (!state.aniListResults.length) {
      return '<div class="mt-anilist-empty">Ничего не нашлось. AniList индексирует в основном английские/ромадзи названия — попробуй оригинальное название вместо русского перевода, либо впиши данные вручную</div>';
    }
    var typeLabels = { manhwa: "Манхва", manga: "Манга", manhua: "Маньхуа" };
    return (
      '<div class="mt-anilist-results">' +
      state.aniListResults.map(function (media, i) {
        var t = (media.title && (media.title.english || media.title.romaji || media.title.native)) || "?";
        var country = typeFromCountryOfOrigin(media.countryOfOrigin);
        var meta = typeLabels[country] || media.countryOfOrigin || "";
        if (media.genres && media.genres.length) {
          meta += (meta ? " · " : "") + media.genres.slice(0, 3).map(translateAniListGenre).join(", ");
        }
        var picked = state.aniListPickedIndex === i;
        var cover = media.coverImage && media.coverImage.large;
        var coverStyle = cover ? "background-image:url('" + escapeHtml(cover).replace(/'/g, "%27") + "')" : "";
        return (
          '<div class="mt-anilist-row' + (picked ? " picked" : "") + '" data-anilist-pick="' + i + '">' +
          '<div class="mt-anilist-cover' + (cover ? "" : " mt-anilist-cover-empty") + '" style="' + coverStyle + '"></div>' +
          '<div class="mt-anilist-info">' +
          '<div class="mt-anilist-title">' + escapeHtml(t) + "</div>" +
          '<div class="mt-anilist-meta">' + escapeHtml(meta) + "</div>" +
          "</div>" +
          (picked ? '<span class="mt-anilist-picked-check">✓</span>' : "") +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  /* ---------- view: library ---------- */
  function matchesQuery(m, q) {
    if (m.title.toLowerCase().indexOf(q) !== -1) return true;
    if (m.genres && m.genres.some(function (g) { return g.toLowerCase().indexOf(q) !== -1; })) return true;
    var alt = m.altTitles;
    if (!alt) return false;
    return Object.keys(alt).some(function (k) {
      return (alt[k] || "").toLowerCase().indexOf(q) !== -1;
    });
  }

  function allGenresSorted() {
    var counts = {};
    state.manhwas.forEach(function (m) {
      (m.genres || []).forEach(function (g) {
        counts[g] = (counts[g] || 0) + 1;
      });
    });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  }

  // The library grid shows a title's Russian alt name when set, falling back
  // to its primary title — used anywhere the "main list" needs a display name.
  function displayTitle(m) {
    var ru = m.altTitles && m.altTitles.ru;
    return (ru && ru.trim()) ? ru : m.title;
  }

  // Position in the "новые" sort: when the title was added, or — once it has
  // been re-rated with «Оценить заново» — when that re-rate happened.
  function recencyTs(m) {
    var wasRerated = (m.ratingHistory || []).length > 0 && typeof m.lastRatedAt === "number";
    return (wasRerated ? m.lastRatedAt : getCreatedAt(m)) || 0;
  }

  function sortedManhwas() {
    var arr = state.manhwas.slice();
    if (state.filterStatus !== "all") {
      arr = arr.filter(function (m) { return m.status === state.filterStatus; });
    }
    if (state.filterGenre !== "all") {
      arr = arr.filter(function (m) { return (m.genres || []).indexOf(state.filterGenre) !== -1; });
    }
    if (state.searchQuery.trim()) {
      var q = state.searchQuery.trim().toLowerCase();
      arr = arr.filter(function (m) { return matchesQuery(m, q); });
    }
    if (state.sortMode === "rating") {
      arr.sort(function (a, b) {
        var av = ratedScore(a), bv = ratedScore(b);
        return (bv === null ? -1 : bv) - (av === null ? -1 : av);
      });
    } else if (state.sortMode === "title") {
      arr.sort(function (a, b) { return displayTitle(a).localeCompare(displayTitle(b), "ru"); });
    } else if (state.sortMode === "completed") {
      arr.sort(function (a, b) {
        var ac = a.completedAt || 0, bc = b.completedAt || 0;
        return bc - ac;
      });
    } else {
      arr.sort(function (a, b) {
        return recencyTs(b) - recencyTs(a);
      });
    }
    return arr;
  }

  function changelogTypeMeta(type) {
    if (type === "major") return { label: "MAJOR · БОЛЬШОЕ ОБНОВЛЕНИЕ", color: "#E4AD71" };
    if (type === "feature") return { label: "НОВОЕ", color: "#7FBF9B" };
    if (type === "fix") return { label: "ИСПРАВЛЕНИЕ", color: "#D9838F" };
    return { label: "ОБНОВЛЕНИЕ", color: "#8CA0D0" };
  }

  function annualCover(w, className) {
    return w.coverUrl ? '<img class="' + className + '" src="' + escapeHtml(w.coverUrl) + '" alt="" loading="lazy" />' :
      '<span class="' + className + ' mt-annual-cover-empty" aria-hidden="true">' + escapeHtml((displayTitle(w)[0] || '?').toUpperCase()) + '</span>';
  }

  function renderYearSummary() {
    var years = yearsWithData();
    if (!years.length) return '<div class="mt-paper mt-empty"><div class="mt-empty-title">Твой зал славы впереди</div><p class="mt-feature-hint">Добавляй тайтлы и вручай премии месяца. Здесь соберутся главные истории твоего года.</p></div>';
    if (years.indexOf(state.awardsYear) < 0) state.awardsYear = years[0];
    var year = state.awardsYear, now = new Date(), ongoing = year >= now.getFullYear();
    var data = Features.annualAwards(normalizeWinners(state.awardWinners), year);
    var annualRatings = [];
    state.manhwas.forEach(function (m) {
      if (!m.rated) return;
      var saved = Features.ratings(m, average).filter(function (r) { return Number.isFinite(r.ts) && new Date(r.ts).getFullYear() === year && r.ts <= Date.now(); }).sort(function (a,b) { return b.ts-a.ts; });
      if (saved.length) annualRatings.push(saved[0]);
    });
    var avg = annualRatings.length ? Math.round(annualRatings.reduce(function (sum,r) { return sum+r.avg; },0)/annualRatings.length) : null;
    var html = '<section class="mt-annual"><div class="mt-annual-years" role="group" aria-label="Год премии">' + years.map(function (y) {
      return '<button data-awards-year="' + y + '" class="mt-annual-year' + (y === year ? ' active' : '') + '" aria-pressed="' + (y === year) + '">' + y + '</button>';
    }).join('') + '</div><header class="mt-annual-intro"><span class="mt-section-eyebrow">AM AWARDS · ' + year + '</span><h2>Год, достойный<br><em>своей истории.</em></h2><span class="mt-annual-season">' + (ongoing ? 'Сезон продолжается · промежуточные итоги' : 'Итоги сезона · ' + year) + '</span></header>';

    if (data.leaders.length) {
      html += '<div class="mt-annual-crown" aria-hidden="true">✦</div><div class="mt-annual-heading"><h3>' + (ongoing ? (data.leaders.length > 1 ? 'Лидеры сезона' : 'Лидер сезона') : (data.leaders.length > 1 ? 'Тайтлы года' : 'Тайтл года')) + '</h3><p>' + (data.leaders.length > 1 ? 'Одинаковое число наград — разделённое первое место' : 'Больше всего побед в премиях месяца') + '</p></div>';
      html += '<div class="mt-annual-winners">' + data.leaders.map(function (r) {
        return '<button class="mt-annual-winner" ' + awardPreviewAttrs(r.winner) + '><span class="mt-annual-winner-year" aria-hidden="true">' + year + '</span>' + annualCover(r.winner,'mt-annual-main-cover') +
          '<span class="mt-annual-winner-copy"><span class="mt-section-eyebrow">ПЕРВОЕ МЕСТО</span><strong>' + escapeHtml(displayTitle(r.winner)) + '</strong><span class="mt-annual-wins">' + r.count + ' ' + winWord(r.count) + '</span><small>Месяцев с наградами: ' + r.months.length + ' · Номинаций: ' + r.categories.length + '</small><span class="mt-annual-open">Карточка победителя ↗</span></span></button>';
      }).join('') + '</div>';
    } else {
      html += '<div class="mt-annual-await"><span aria-hidden="true">✦</span><h3>Место для твоего фаворита</h3><p>Выбери победителей премии месяца — и здесь начнётся гонка за тайтл года.</p><button class="mt-primary-btn" data-awards-view="month">К премии месяца</button></div>';
    }

    html += '<div class="mt-annual-numbers"><div><strong>' + data.awardCount + '</strong><span>наград вручено</span></div><div><strong>' + Object.keys(data.months).length + '<small> / 12</small></strong><span>месяцев с наградами</span></div><div><strong>' + (avg === null ? '—' : avg) + '</strong><span>средняя оценка года</span></div></div>';
    html += '<p class="mt-annual-footnote">Средняя — по последней сохранённой оценке каждого тайтла за ' + year + ' год. Оценено тайтлов: ' + annualRatings.length + '.</p>';
    var discoveries = titlesForYear(year), genres = {};
    discoveries.forEach(function (m) { (m.genres || []).forEach(function (g) { genres[g] = (genres[g] || 0) + 1; }); });
    var genreOrder = Object.keys(genres).sort(function (a,b) { return genres[b]-genres[a] || a.localeCompare(b,'ru'); });
    if (genreOrder.length) {
      var favoriteGenres = genreOrder.filter(function (g) { return genres[g] === genres[genreOrder[0]]; });
      html += '<div class="mt-annual-discovery"><span class="mt-section-eyebrow">ЖАНРЫ ТВОИХ ОТКРЫТИЙ</span><strong>' + favoriteGenres.map(escapeHtml).join(' · ') + '</strong><p>Самые частые жанры среди тайтлов, добавленных в ' + year + ' году. Пополнений коллекции: ' + discoveries.length + '.</p></div>';
    }

    if (data.ranking.length > 1) {
      html += '<div class="mt-annual-heading"><span class="mt-section-eyebrow">ГОНКА ЗА ПРИЗНАНИЕМ</span><h3>Пьедестал года</h3></div><div class="mt-annual-podium">' + data.ranking.filter(function (r) { return r.place <= 3; }).map(function (r) {
        return '<button class="mt-annual-runner" ' + awardPreviewAttrs(r.winner) + '><span class="mt-annual-place">' + String(r.place).padStart(2,'0') + '</span>' + annualCover(r.winner,'mt-annual-small-cover') + '<span class="mt-annual-runner-title">' + escapeHtml(displayTitle(r.winner)) + '<small>' + r.count + ' ' + winWord(r.count) + '</small></span></button>';
      }).join('') + '</div>';
      var rest = data.ranking.filter(function (r) { return r.place > 3; });
      if (rest.length) html += '<details class="mt-annual-rest"><summary>Все участники · ' + data.ranking.length + '</summary>' + rest.map(function (r) { return '<button class="mt-annual-runner" ' + awardPreviewAttrs(r.winner) + '><span class="mt-annual-place">' + r.place + '</span><span class="mt-annual-runner-title">' + escapeHtml(displayTitle(r.winner)) + '<small>' + r.count + ' ' + winWord(r.count) + '</small></span></button>'; }).join('') + '</details>';
    }

    var categories = AWARD_CATEGORY_KEYS.filter(function (c) { return c !== 'worst' && c !== 'overall' && data.categories[c]; });
    if (categories.length) {
      html += '<div class="mt-annual-heading"><span class="mt-section-eyebrow">У КАЖДОЙ ИСТОРИИ СВОЯ СИЛА</span><h3>Зал номинаций</h3><p>Больше всего месячных побед в каждой категории</p></div><div class="mt-annual-categories">' + categories.map(function (c) {
        return '<section class="mt-annual-category"><h4>' + escapeHtml(c === 'cover' ? 'Обложка года' : AWARD_LABELS[c]) + '</h4>' + data.categories[c].map(function (r) { return '<button ' + awardPreviewAttrs(r.winner) + '>' + annualCover(r.winner,'mt-annual-small-cover') + '<span>' + escapeHtml(displayTitle(r.winner)) + '<small>' + r.count + ' ' + winWord(r.count) + (data.categories[c].length > 1 ? ' · разделённая победа' : '') + '</small></span></button>'; }).join('') + '</section>';
      }).join('') + '</div>';
    }

    html += '<div class="mt-annual-heading"><span class="mt-section-eyebrow">ДВЕНАДЦАТЬ ГЛАВ ТВОЕГО ГОДА</span><h3>Сезон по месяцам</h3><p>Нажми на завершённый месяц, чтобы открыть его премию</p></div><div class="mt-annual-calendar">';
    var monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    for (var i=0;i<12;i++) {
      var key = year + '-' + pad2(i+1), record = data.months[key], open = key < monthKeyOf(Date.now());
      html += '<button class="mt-annual-month' + (record ? ' awarded' : '') + '" data-year-month="' + key + '"' + (open ? '' : ' disabled') + '><span>' + monthNames[i] + '</span><strong>' + (record ? record.count + ' ' + winWord(record.count) : (open ? 'Без наград' : 'Впереди')) + '</strong>' + (record && record.overall ? '<small>' + escapeHtml(displayTitle(record.overall)) + '</small>' : '') + '</button>';
    }
    return html + '</div>' + (!ongoing?renderAnnualRecap(year):'') + '<details class="mt-annual-rules"><summary>Как определяется победитель</summary><p>Каждая победа в номинации месяца даёт один балл. Антипремия не учитывается. При равенстве баллов тайтлы разделяют место. Учитываются только завершённые месяцы выбранного года.</p><p>Результаты строятся по сохранённым премиям: переоценка или удаление тайтла не меняет его прошлые награды. Годовые итоги пересчитываются при изменении архива. Для старых премий используются восстановленные данные.</p></details></section>';
  }
  function winWord(n) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "победа";
    if ([2, 3, 4].indexOf(mod10) !== -1 && [12, 13, 14].indexOf(mod100) === -1) return "победы";
    return "побед";
  }

  function championCardHtml(m, subtitle) {
    var coverStyle = m.coverUrl
      ? "background-image:url('" + escapeHtml(m.coverUrl).replace(/'/g, "%27") + "')"
      : "";
    return (
      '<button class="mt-winner-card" ' + (m.awardSnapshot ? awardPreviewAttrs(m) : 'data-open-id="' + escapeHtml(m.id) + '"') + '>' +
      '<div class="mt-winner-cover' + (m.coverUrl ? "" : " mt-winner-cover-empty") + '" style="' + coverStyle + '">' +
      (m.coverUrl ? "" : '<span class="mt-winner-cover-fallback">' + escapeHtml((displayTitle(m)[0] || "?").toUpperCase()) + "</span>") +
      '<span class="mt-winner-trophy-badge">🏆</span>' +
      "</div>" +
      '<div class="mt-winner-category">' + escapeHtml(subtitle) + "</div>" +
      '<div class="mt-winner-title">' + escapeHtml(displayTitle(m)) + "</div>" +
      "</button>"
    );
  }

  function winnerCardHtml(ck, w) {
    var coverStyle = w.coverUrl
      ? "background-image:url('" + escapeHtml(w.coverUrl).replace(/'/g, "%27") + "')"
      : "";
    return (
      '<button class="mt-winner-card" ' + awardPreviewAttrs(w) + '>' +
      '<div class="mt-winner-cover' + (w.coverUrl ? "" : " mt-winner-cover-empty") + '" style="' + coverStyle + '">' +
      (w.coverUrl ? "" : '<span class="mt-winner-cover-fallback">' + escapeHtml((displayTitle(w)[0] || "?").toUpperCase()) + "</span>") +
      '<span class="mt-winner-trophy-badge">' + awardIcon(ck) + "</span>" +
      "</div>" +
      '<div class="mt-winner-category">' + escapeHtml(AWARD_LABELS[ck] || ck) + "</div>" +
      '<div class="mt-winner-title">' + escapeHtml(displayTitle(w)) + "</div>" +
      '<div class="mt-winner-category">' + (w.avg === null ? '—' : Math.round(w.avg) + '/100') + '</div></button>'
    );
  }

  // Read-only peek at candidates already picked (from title pages or the Awards
  // tab of a still-open month) for the month currently in progress — shown once
  // the previous month's winners are all decided, so there's always something
  // to look forward to.
  function renderNextMonthCandidatesPreview() {
    var nextMonthKey = monthKeyOf(Date.now());
    var groups = AWARD_CATEGORY_KEYS.map(function (ck) {
      return { ck: ck, entries: candidateEntries(nextMonthKey, ck) };
    }).filter(function (g) { return g.entries.length > 0; });

    if (!groups.length) return "";

    return (
      '<div class="mt-winner-section-title" style="margin-top:18px">🔮 КАНДИДАТЫ — ' +
      escapeHtml(monthLabel(nextMonthKey)).toUpperCase() + "</div>" +
      groups.map(function (g) {
        return (
          '<div class="mt-paper mt-award-panel">' +
          '<div class="mt-panel-title">' + escapeHtml(AWARD_LABELS[g.ck] || g.ck) + "</div>" +
          g.entries.map(function (e) {
            return (
              '<div class="mt-nominee-row" data-open-id="' + e.manhwa.id + '">' +
              '<div class="mt-nominee-info"><div class="mt-nominee-title">' + escapeHtml(displayTitle(e.manhwa)) + "</div></div>" +
              '<span class="mt-nominee-score" style="color:' + (isOverallScaleCategory(g.ck) ? scoreColor(e.score) : criterionColor(e.score)) + '">' +
              (isOverallScaleCategory(g.ck) ? Math.round(e.score) : e.score.toFixed(1)) + "</span>" +
              "</div>"
            );
          }).join("") +
          "</div>"
        );
      }).join("")
    );
  }

  function renderAwardsTab() {
    var months = awardMonths();
    if (months.indexOf(state.awardsMonth) < 0) state.awardsMonth = lastCompletedMonthKey();
    var monthKey = state.awardsMonth;
    var toggle =
      '<div class="mt-filter-row">' +
      '<button class="mt-filter-chip' + (state.awardsView === "month" ? " active" : "") +
      '" data-awards-view="month" style="' + (state.awardsView === "month" ?
        "background:var(--amber);color:#0E0E10;border-color:var(--amber)" : "border-color:rgba(201,191,168,0.4);color:var(--amber)") +
      '">Месяц</button>' +
      '<button class="mt-filter-chip' + (state.awardsView === "year" ? " active" : "") +
      '" data-awards-view="year" style="' + (state.awardsView === "year" ?
        "background:var(--amber);color:#0E0E10;border-color:var(--amber)" : "border-color:rgba(201,191,168,0.4);color:var(--amber)") +
      '">Год</button>' +
      "</div>";

    var html =
      '<div class="mt-header">' +
      '<div class="mt-title-row">' +
      '<div><div class="mt-section-eyebrow">ЛУЧШЕЕ ИЗ ПРОЧИТАННОГО</div><h1 class="mt-page-title">Твоя премия</h1></div>' +
      "</div>" +
      '<div class="mt-subrow"><div class="mt-subtitle">' +
      (state.awardsView === "year" ? "Итоги года" : "Итоги месяца — " + escapeHtml(monthLabel(monthKey))) +
      "</div></div>" +
      toggle +
      "</div>" +
      '<div class="mt-list' + (state.awardsView === 'month' ? ' mt-month-awards' : '') + '">';

    if (state.awardsView === "year") {
      html += renderYearSummary();
      html += "</div>";
      return html;
    }

    html += '<div class="mt-award-months" role="group" aria-label="Месяц премии">' +
      months.map(function (key) { return '<button class="mt-award-month' + (key === monthKey ? ' active' : '') +
        '" data-awards-month="' + key + '" aria-pressed="' + (key === monthKey ? 'true' : 'false') + '"><strong>' +
        escapeHtml(monthLabel(key)) + '</strong><span>' + (key === lastCompletedMonthKey() ? 'Подводим итоги' : 'Архив') + '</span></button>'; }).join('') + '</div>';
    html += '<details class="mt-award-help"><summary>'+ (monthKey===lastCompletedMonthKey()?(state.awardEditUsed[monthKey]?'Правка победителей уже использована':'Доступна одна правка победителей'):'Архив · только просмотр')+'</summary><p>Выбор победителей доступен за последний завершённый месяц: '+escapeHtml(monthLabel(lastCompletedMonthKey()))+'. После выбора всех победителей их можно сбросить и выбрать заново один раз.</p><p>Участвуют тайтлы с сохранённой оценкой или переоценкой за выбранный месяц. В номинации критерия нужен соответствующий критерий; для обложки — изображение. Сначала отметь кандидатов, затем выбери победителя.</p></details>';
    if (monthKey < lastCompletedMonthKey()) {
      var archived = AWARD_CATEGORY_KEYS.filter(function (ck) { return !!getWinner(monthKey, ck); });
      html += '<div class="mt-section-eyebrow">АРХИВ ПРЕМИИ</div>' +
        (archived.length ? '<div class="mt-winner-carousel">' + archived.map(function (ck) { return winnerCardHtml(ck, getWinner(monthKey, ck)); }).join('') + '</div>' :
          '<div class="mt-paper mt-empty"><div class="mt-empty-title">Победители не выбраны</div><p class="mt-feature-hint">За этот месяц нет сохранённых победителей.</p></div>');
      return html + '</div>';
    }

    var availableCategories = availableCategoriesForMonth(monthKey);

    if (!availableCategories.length) {
      html +=
        '<div class="mt-paper mt-empty"><div class="mt-empty-title">Пока нечего вручать</div>' +
        '<div class="mt-empty-text">Награды появятся, когда закончится месяц с хотя бы одним оценённым тайтлом.</div></div>' +
        "</div>";
      return html;
    }

    var decidedCategories = availableCategories.filter(function (ck) { return !!getWinner(monthKey, ck); });
    var allDecided = decidedCategories.length === availableCategories.length;

    if (allDecided) {
      var editConfirming = state.confirmEditWinnersMonth === monthKey;
      html +=
        '<div class="mt-winner-section-title">🏆 ПОБЕДИТЕЛИ МЕСЯЦА</div>' +
        '<div class="mt-winner-carousel">' +
        availableCategories.map(function (ck) {
          return winnerCardHtml(ck, getWinner(monthKey, ck));
        }).join("") +
        "</div>";

      html += renderNextMonthCandidatesPreview();

      if (canEditWinners(monthKey)) {
        html +=
          '<button class="mt-ghost-btn' + (editConfirming ? " mt-edit-winners-confirming" : "") +
          '" id="edit-winners-btn" data-month="' + monthKey + '" style="width:100%;margin-top:12px">' +
          (editConfirming
            ? "Точно? Это единственная правка в этом месяце — нажми ещё раз"
            : "✎ Изменить кандидатов и победителей (доступно 1 раз в месяц)") +
          "</button>";
      } else {
        html +=
          '<div class="mt-ceremony-hint" style="text-align:center;margin-top:12px">' +
          "Правка победителей в этом месяце уже использована</div>";
      }

      html += "</div>";
      return html;
    }

    if (!state.awardsCategory || availableCategories.indexOf(state.awardsCategory) === -1) {
      state.awardsCategory = availableCategories.filter(function (ck) { return !getWinner(monthKey, ck); })[0] || availableCategories[0];
    }

    var categoryChips = availableCategories.map(function (ck) {
      var active = ck === state.awardsCategory;
      var decided = !!getWinner(monthKey, ck);
      return (
        '<button class="mt-category-chip' + (active ? " active" : "") + '" data-award-category="' + escapeHtml(ck) + '">' +
        (decided ? awardIcon(ck) + " " : "") + escapeHtml(AWARD_LABELS[ck] || ck) +
        "</button>"
      );
    }).join("");

    html += '<div class="mt-category-chip-row">' + categoryChips + "</div>";

    var ck = state.awardsCategory;
    var winner = getWinner(monthKey, ck);
    var pool = eligiblePoolForCategory(monthKey, ck);
    var candidates = candidateEntries(monthKey, ck);

    if (winner) {
      // Locked — winner already chosen, nothing left to do here.
      html +=
        '<div class="mt-paper mt-award-panel">' +
        '<div class="mt-panel-title">' + escapeHtml(AWARD_LABELS[ck] || ck) + "</div>" +
        '<div class="mt-award-row" ' + awardPreviewAttrs(winner) + '>' +
        '<span class="mt-award-trophy">' + awardIcon(ck) + "</span>" +
        '<div class="mt-award-info"><div class="mt-award-title">' + escapeHtml(displayTitle(winner)) + "</div>" +
        '<div class="mt-award-sub">Победитель выбран — изменить нельзя</div></div>' +
        "</div></div>";
    } else if (!state.awardsCandidatesConfirmed) {
      // Step 1: pick who's even in the running (multi-select, stays until confirmed).
      var candidateIds = getCandidateIds(monthKey, ck);
      var pickRows = pool.map(function (p) {
        var checked = candidateIds.indexOf(p.manhwa.id) !== -1;
        return (
          '<div class="mt-nominee-row' + (checked ? " picked" : "") + '" data-toggle-candidate="' + p.manhwa.id +
          '" data-month="' + monthKey + '" data-category="' + escapeHtml(ck) + '">' +
          '<span class="mt-nominee-checkbox">' + (checked ? "☑" : "☐") + "</span>" +
          '<div class="mt-nominee-info"><div class="mt-nominee-title">' + escapeHtml(displayTitle(p.manhwa)) + "</div></div>" +
          '<span class="mt-nominee-score" style="color:' + (isOverallScaleCategory(ck) ? scoreColor(p.score) : criterionColor(p.score)) + '">' +
          (isOverallScaleCategory(ck) ? Math.round(p.score) : p.score.toFixed(1)) + "</span>" +
          "</div>"
        );
      }).join("");

      html +=
        '<div class="mt-paper">' +
        '<div class="mt-panel-title">' + escapeHtml(AWARD_LABELS[ck] || ck) + "</div>" +
        '<div class="mt-ceremony-hint">Отметь тайтлы, которые претендуют на эту награду</div>' +
        pickRows +
        '<button class="mt-primary-btn" id="confirm-candidates-btn"' +
        (candidateIds.length === 0 ? " disabled" : "") +
        ' style="width:100%;margin-top:12px">Готово — выбрать победителя (' + candidateIds.length + ')</button>' +
        "</div>";
    } else {
      // Step 2: crown one of the chosen candidates.
      var rows = candidates.map(function (c) {
        var pickKey = monthKey + "|" + ck + "|" + c.manhwa.id;
        var confirming = state.confirmWinnerPick === pickKey;
        return (
          '<div class="mt-nominee-row' + (confirming ? " confirming" : "") + '" data-pick-winner="' + c.manhwa.id +
          '" data-month="' + monthKey + '" data-category="' + escapeHtml(ck) + '">' +
          '<span class="mt-nominee-trophy">' + (confirming ? awardIcon(ck) : "") + "</span>" +
          '<div class="mt-nominee-info"><div class="mt-nominee-title">' + escapeHtml(displayTitle(c.manhwa)) + "</div>" +
          (confirming ? '<div class="mt-nominee-confirm">Точно этот? Нажми ещё раз</div>' : "") + "</div>" +
          '<span class="mt-nominee-score" style="color:' + (isOverallScaleCategory(ck) ? scoreColor(c.score) : criterionColor(c.score)) + '">' +
          (isOverallScaleCategory(ck) ? Math.round(c.score) : c.score.toFixed(1)) + "</span>" +
          "</div>"
        );
      }).join("");

      html +=
        '<div class="mt-paper">' +
        '<div class="mt-panel-title">' + escapeHtml(AWARD_LABELS[ck] || ck) + "</div>" +
        '<div class="mt-ceremony-hint">Выбери победителя среди кандидатов — выбор нельзя будет изменить</div>' +
        rows +
        '<button class="mt-ghost-btn" id="edit-candidates-btn"' +
        ' style="width:100%;margin-top:12px">✎ Изменить список кандидатов</button>' +
        "</div>";
    }

    html += "</div>";
    return html;
  }

  function renderChangelog() {
    var entries = CHANGELOG.map(function (entry) {
      var meta = changelogTypeMeta(entry.type);
      var items = entry.items.map(function (it) {
        return '<li>' + escapeHtml(it) + "</li>";
      }).join("");
      return (
        '<div class="mt-paper mt-changelog-entry">' +
        '<div class="mt-changelog-entry-head">' +
        '<span class="mt-changelog-badge" style="background:' + meta.color + '18;color:' + meta.color +
        ";border-color:" + meta.color + '">' + meta.label + "</span>" +
        '<span class="mt-changelog-version">v' + escapeHtml(entry.version) + "</span>" +
        "</div>" +
        '<div class="mt-changelog-title">' + escapeHtml(entry.title) + "</div>" +
        '<ul class="mt-changelog-list">' + items + "</ul>" +
        "</div>"
      );
    }).join("");

    return (
      '<div class="mt-detail-head">' +
      '<button class="mt-icon-btn on-dark" id="changelog-back-btn" aria-label="Назад">←</button>' +
      '<div class="mt-detail-title">ЖУРНАЛ ОБНОВЛЕНИЙ</div>' +
      "</div>" +
      '<div class="mt-list">' + entries + "</div>"
    );
  }

  function renderHeader() {
    var sorts = [["recent", "новые"], ["completed", "завершено"], ["rating", "оценка"], ["title", "А-Я"]];
    var btns = sorts.map(function (s) {
      var active = state.sortMode === s[0];
      return (
        '<button class="mt-sort-btn' + (active ? " active" : "") + '" data-sort="' + s[0] + '">' +
        s[1] + "</button>"
      );
    }).join("");

    var filterBtns = STATUSES.map(function (f) {
      var active = state.filterStatus === f.id;
      return (
        '<button class="mt-filter-chip' + (active ? " active" : "") + '" data-filter="' + f.id +
        '" style="' + (active ?
          "background:" + f.color + ";color:#0E0E10;border-color:" + f.color :
          "border-color:" + f.color + "45;color:" + f.color) + '">' + f.label + "</button>"
      );
    }).join("");

    var query = state.searchQuery || "";
    var clearBtn = query
      ? '<button class="mt-search-clear" id="search-clear-btn" aria-label="Очистить поиск">✕</button>'
      : "";

    var genreList = allGenresSorted();
    var genreToggleLabel = "Жанры" + (state.filterGenre !== "all" ? ": " + state.filterGenre : "");
    var genrePanel = "";
    if (genreList.length > 0 && state.showGenreFilter && state.showSearch) {
      var genreChips = [{ id: "all", label: "Все жанры" }]
        .concat(genreList.map(function (g) { return { id: g, label: g }; }))
        .map(function (g) {
          var active = state.filterGenre === g.id;
          return (
            '<button class="mt-genre-filter-chip' + (active ? " active" : "") + '" data-genre-filter="' +
            escapeHtml(g.id) + '">' + escapeHtml(g.label) + "</button>"
          );
        }).join("");
      genrePanel = '<div class="mt-genre-filter-row">' + genreChips + "</div>";
    }

    var hasUnseen = CHANGELOG.length > 0 && CHANGELOG[0].version !== state.changelogSeenVersion;
    var searchPanel = state.showSearch
      ? '<div class="mt-search-wrap">' +
        '<input class="mt-input mt-search-input" id="search-input" placeholder="Поиск по названию или жанру…" value="' +
        escapeHtml(query) + '" />' + clearBtn +
        "</div>"
      : "";

    return (
      '<div class="mt-header">' +
      (halloweenAppearance() ? '' : '<div class="mt-title-row">' +
      '<div class="mt-brand"><img class="mt-brand-mark" src="icons/mark.svg" alt="" /><div><div class="mt-title">AM TRACKER</div><div class="mt-brand-caption">Твой дневник историй</div></div></div>' +
      '<button class="mt-icon-round" id="open-changelog" aria-label="Журнал обновлений">' + ICON_BELL +
      (hasUnseen ? '<span class="mt-notify-dot"></span>' : "") + "</button>" +
      "</div>") +
      '<div class="mt-library-intro mt-library-intro-compact">' +
      '<div class="mt-library-stats"><span><strong>' + state.manhwas.length + '</strong> в коллекции</span><span><strong>' +
      state.manhwas.filter(function (m) { return m.status === "reading"; }).length + '</strong> читаю</span><span><strong>' +
      state.manhwas.filter(function (m) { return ratedScore(m) !== null; }).length + '</strong> оценено</span></div></div></div>' +

      '<div class="mt-library-controls">' +
      '<div class="mt-subrow">' +
      '<div class="mt-subrow-actions">' +
      '<div class="mt-sort-group">' + btns + "</div>" +
      '<div class="mt-library-utility">' +
      '<button class="mt-icon-round mt-icon-round-sm' + (state.showSearch ? " active" : "") +
      '" id="toggle-search" aria-label="Поиск">' + ICON_SEARCH + "</button>" + renderLibraryTools(sortedManhwas(),true) + '</div>' +
      "</div></div>" +
      searchPanel +
      '<div class="mt-filter-row">' + filterBtns +
      (genreList.length > 0 && state.showSearch
        ? '<button class="mt-genre-toggle-chip' + (state.showGenreFilter ? " active" : "") +
          '" id="genre-filter-toggle">' + genreToggleLabel + "</button>"
        : "") +
      "</div>" +
      genrePanel +
      "</div>"
    );
  }

  function renderErrorBanner() {
    if (!state.error) return "";
    return '<div class="mt-error">' + escapeHtml(state.error) + "</div>";
  }

  function libraryFiltersHtml() {
    var filters=[];
    if(state.searchQuery.trim())filters.push(['search','Поиск: '+state.searchQuery.trim()]);
    if(state.filterStatus!=='all')filters.push(['status',statusById(state.filterStatus).label]);
    if(state.filterGenre!=='all')filters.push(['genre',state.filterGenre]);
    var collection=libraryData().collections.find(function(c){return c.id===libraryUI.collection;});
    if(collection)filters.push(['collection',collection.name]);
    return filters.length?'<div class="mt-active-filters" aria-label="Активные фильтры">'+filters.map(function(f){return '<button class="mt-ghost-btn" data-library-clear="'+f[0]+'" aria-label="Убрать фильтр: '+escapeHtml(f[1])+'">'+escapeHtml(f[1])+' ×</button>';}).join('')+'<button class="mt-ghost-btn" data-library-clear="all">Сбросить всё</button></div>':'';
  }
  function renderLibrary() {
    if(libraryUI.compare)return renderTitleComparison();
    var html = renderHeader() + renderErrorBanner();
    var list = sortedManhwas();
    if(libraryUI.collection)list=list.filter(function(m){return (m.collectionIds||[]).includes(libraryUI.collection);});

    html += '<div class="mt-list">'+renderLibraryTools(list)+libraryFiltersHtml();

    if (state.addingManhwa) {
      var typeBtns = TYPES.map(function (t) {
        var active = state.pendingType === t.id;
        return (
          '<button class="mt-type-choice' + (active ? " active" : "") + '" data-pick-type="' + t.id +
          '" style="' + (active ? "background:" + t.color + ";color:#17171A;border-color:" + t.color :
            "border-color:" + t.color + "55;color:" + t.color) + '">' + t.label + "</button>"
        );
      }).join("");
      var appliedBits = [];
      if (state.pendingCoverDraft) appliedBits.push("обложка");
      if (state.pendingGenresDraft.length) appliedBits.push(state.pendingGenresDraft.length + " жанр(а/ов)");
      if (state.pendingAltTitlesDraft && state.pendingAltTitlesDraft.en) appliedBits.push("англ. название");
      if (state.pendingAltTitlesDraft && state.pendingAltTitlesDraft.ko) appliedBits.push("кор. название");
      if (state.pendingAltTitlesDraft && state.pendingAltTitlesDraft.ja) appliedBits.push("яп. название");
      html +=
        '<div class="mt-paper">' +
        '<input class="mt-input" id="new-title-input" placeholder="Название манхвы" value="' +
        escapeHtml(state.pendingTitleDraft) + '" />' +
        '<button class="mt-ghost-btn" id="anilist-search-btn" style="width:100%;margin-top:8px"' +
        (state.aniListSearching ? " disabled" : "") + ">" +
        (state.aniListSearching ? "Ищу на AniList…" : "🔎 Найти на AniList") +
        "</button>" +
        (state.aniListError ? '<div class="mt-anilist-error">' + escapeHtml(state.aniListError) + "</div>" : "") +
        (state.aniListResults ? renderAniListResults() : "") +
        (appliedBits.length ? '<div class="mt-anilist-applied">✓ Подтянуто с AniList: ' + escapeHtml(appliedBits.join(", ")) + "</div>" : "") +
        '<input class="mt-input" id="new-cover-input" placeholder="Ссылка на обложку (необязательно)" ' +
        'style="margin-top:8px" value="' + escapeHtml(state.pendingCoverDraft) + '" />' +
        '<div class="mt-type-row">' + typeBtns + "</div>" +
        '<div class="mt-form-row">' +
        '<button class="mt-primary-btn" id="confirm-add-manhwa">Добавить</button>' +
        '<button class="mt-ghost-btn" id="cancel-add-manhwa">Отмена</button>' +
        "</div></div>";
    } else {
      html += '<div class="mt-collection-heading"><div><h2>Библиотека <span>' + list.length + '</span></h2><p>' +
        (state.searchQuery.trim() || state.filterStatus !== "all" || state.filterGenre !== "all" ? 'По выбранным фильтрам' : 'Каждая история — часть тебя') +
        '</p></div><button class="mt-icon-btn mt-layout-toggle" id="library-layout" aria-label="'+(usability.list?'Показать обложки':'Показать списком')+'" title="'+(usability.list?'Обложки':'Список')+'">'+(usability.list?'▦':'☷')+'</button><button class="mt-add-btn" id="start-add-manhwa"><span aria-hidden="true">+</span> Добавить</button></div>';
    }

    if (list.length === 0 && !state.addingManhwa) {
      var noneAtAll = state.manhwas.length === 0;
      html += noneAtAll
        ? '<div class="mt-paper mt-empty"><div class="mt-empty-art" aria-hidden="true">' + ICON_BOOK + '</div><div class="mt-empty-title">Хорошая история начинается здесь</div>' +
          '<div class="mt-empty-text">Добавь первый тайтл. Сохраняй впечатления, оценивай любимые истории и собирай свою коллекцию.</div></div>'
        : '<div class="mt-paper mt-empty"><div class="mt-empty-title">Ничего не найдено</div>' +
          '<div class="mt-empty-text">Попробуй изменить поиск или фильтр.</div></div>';
    }

    if (list.length > 0) {
      html += '<div class="mt-grid'+(usability.list?' mt-library-list':'')+'">';
      list.forEach(function (m, gridIdx) {
        var avg = ratedScore(m);
        var st = statusById(m.status);
        var ty = typeById(m.type || "manhwa");
        var isWinnerTitle = positiveAwardsForManhwa(m).length > 0;
        var isRockBottom = m.rated === true && m.criteria.length > 0 && m.criteria.every(function (c) { return c.score === 1; });
        var coverStyle = m.coverUrl
          ? "background-image:url('" + escapeHtml(m.coverUrl).replace(/'/g, "%27") + "')"
          : "";

        var title = displayTitle(m);
        html +=
          '<div class="mt-grid-card" style="animation-delay:' + Math.min(gridIdx * 30, 240) + 'ms"'+(libraryUI.bulk?' data-bulk-selected="'+libraryUI.selected.includes(m.id)+'"':'')+'>' +
          (libraryUI.bulk?'<button class="mt-select-title" data-select-title="'+escapeHtml(m.id)+'" aria-pressed="'+libraryUI.selected.includes(m.id)+'">'+(libraryUI.selected.includes(m.id)?'✓ Выбрано':'Выбрать')+'</button>':'')+
          '<button class="mt-cover' + (m.coverUrl ? "" : " mt-cover-empty") + (isWinnerTitle ? " mt-cover-winner" : "") +
          '" style="' + coverStyle + '" data-open-id="' + m.id + '" aria-label="Открыть: ' + escapeHtml(title) + '">' +
          (m.coverUrl ? "" : '<span class="mt-cover-fallback">' + escapeHtml((title[0] || "?").toUpperCase()) + "</span>") +
          '<div class="mt-cover-top-row">' +
          '<span class="mt-cover-status" style="background:' + st.color + '">' + st.label + "</span>" +
          (isRockBottom ? '<span class="mt-cover-worst" title="Оценено на дно по всем критериям">🤮</span>' : "") +
          "</div>" +
          (isWinnerTitle ? '<span class="mt-cover-trophy">🏆</span>' : "") +
          '<span class="mt-cover-score' + (avg === null ? ' mt-cover-unrated' : '') + '" style="border-color:' + scoreColor(avg) + ";color:" + scoreColor(avg) +
          '">' + (avg === null ? "Не оценено" : Math.round(avg)) + "</span>" +
          "</button>" +
          '<div class="mt-cover-title" data-open-id="' + m.id + '">' + escapeHtml(title) + "</div>" +
          '<div class="mt-cover-type-line">' + ty.label + '</div>' +
          "</div>";
      });
      html += "</div>";
    }

    html += "</div>";
    return html;
  }

  /* ---------- view: detail ---------- */
  function renderAltTitlesPanel(m) {
    var alt = m.altTitles || { en: "", ja: "", ko: "", ru: "" };
    var fields = [
      ["en", "EN", "Английское название"],
      ["ja", "JP", "Японское название"],
      ["ko", "KR", "Корейское название"],
      ["ru", "RU", "Русское название"]
    ];
    var rows = fields.map(function (f) {
      return (
        '<div class="mt-alt-row"><span class="mt-alt-label">' + f[1] + "</span>" +
        '<input class="mt-input" data-alt-lang="' + f[0] + '" placeholder="' + f[2] + '" value="' +
        escapeHtml(alt[f[0]] || "") + '" /></div>'
      );
    }).join("");
    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">АЛЬТЕРНАТИВНЫЕ НАЗВАНИЯ</div>' +
      rows +
      "</div>"
    );
  }

  function renderNotesPanel(m) {
    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">ЗАМЕТКИ / РЕЦЕНЗИЯ</div>' +
      '<textarea class="mt-input mt-notes-textarea" id="notes-textarea" placeholder="Что зацепило, что запомнилось, свои мысли…">' +
      escapeHtml(m.notes || "") + "</textarea>" +
      "</div>"
    );
  }

  function renderNotesReadOnly(m) {
    if (!m.notes || !m.notes.trim()) return "";
    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">ЗАМЕТКИ / РЕЦЕНЗИЯ</div>' +
      '<div class="mt-notes-text">' + escapeHtml(m.notes).replace(/\n/g, "<br>") + "</div>" +
      "</div>"
    );
  }

  function renderCoverPanel(m) {
    var url = m.coverUrl || "";
    var preview = url
      ? '<div class="mt-cover-preview" style="background-image:url(\'' + escapeHtml(url).replace(/'/g, "%27") + "')\"></div>"
      : '<div class="mt-cover-preview mt-cover-preview-empty">нет обложки</div>';
    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">ОБЛОЖКА</div>' +
      '<div class="mt-cover-panel-row">' +
      preview +
      '<input class="mt-input" id="cover-url-input" placeholder="Ссылка на изображение (URL)" value="' +
      escapeHtml(url) + '" />' +
      "</div></div>"
    );
  }

  function renderGenresPanel(m) {
    var genres = m.genres || [];
    var chips = genres.length
      ? genres.map(function (g) {
          return (
            '<span class="mt-genre-chip">' + escapeHtml(g) +
            ' <button class="mt-genre-remove" data-remove-genre="' + escapeHtml(g) +
            '" data-manhwa-id="' + m.id + '" aria-label="Убрать жанр">✕</button></span>'
          );
        }).join("")
      : '<span class="mt-empty-text" style="font-size:12px">Пока нет жанров</span>';

    var suggestions = GENRE_SUGGESTIONS.filter(function (g) { return genres.indexOf(g) === -1; });
    var suggBtns = suggestions.map(function (g) {
      return (
        '<button class="mt-genre-suggest" data-add-genre="' + escapeHtml(g) +
        '" data-manhwa-id="' + m.id + '">+ ' + escapeHtml(g) + "</button>"
      );
    }).join("");

    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">ЖАНРЫ</div>' +
      '<div class="mt-genre-list">' + chips + "</div>" +
      (suggBtns ? '<div class="mt-genre-suggest-row">' + suggBtns + "</div>" : "") +
      '<div class="mt-form-row">' +
      '<input class="mt-input" id="new-genre-input" placeholder="Свой жанр" value="' +
      escapeHtml(state.pendingGenreDraft) + '" />' +
      '<button class="mt-primary-btn" id="add-genre-btn" data-manhwa-id="' + m.id +
      '" style="flex:0 0 auto;padding:12px 16px">+</button>' +
      "</div></div>"
    );
  }

  function renderRatingSection(m, avg, editable, rerateSnap) {
    var phase = ratingPhase(m);

    var emotionPicker = "";
    if (phase === "phase1") {
      var stars = "";
      for (var i = 1; i <= 5; i++) {
        stars += '<button class="mt-emotion-star" data-emotion-pick="' + i +
          '" data-manhwa-id="' + m.id + '" aria-label="' + i + ' звёзд">★</button>';
      }
      emotionPicker = (
        '<div class="mt-paper mt-emotion-panel">' +
        '<div class="mt-panel-title">ПЕРВОЕ ВПЕЧАТЛЕНИЕ</div>' +
        '<div class="mt-emotion-hint">Необязательно: выбери эмоцию. Итоговая оценка ниже считается отдельно по критериям.</div>' +
        '<div class="mt-emotion-stars">' + stars + "</div>" +
        "</div>"
      );
    }

    // phase === "legacy" or "phase2" — full criteria available
    var hist = m.ratingHistory || [];
    var viewIdx = viewedHistoryIndex(m);
    var snapView = viewIdx === null ? null : hist[viewIdx];
    var shownCriteria = snapView ? snapView.criteria : m.criteria;
    var shownAvg = snapView ? snapView.avg : avg;

    // Buttons above the rating: one per past rating plus the current one.
    var ratingTabs = "";
    if (!editable && hist.length) {
      var stamps = hist.map(function (h) { return h.ts; }).concat([ratingTs(m)]);
      var baseLabels = stamps.map(function (ts) { return ratingChipLabel(ts, false); });
      var chips = stamps.map(function (ts, i) {
        var label = baseLabels[i];
        var dup = label !== null && baseLabels.filter(function (l) { return l === label; }).length > 1;
        if (dup) label = ratingChipLabel(ts, true);
        if (label === null) label = i === stamps.length - 1 ? "Сейчас" : "Ранее";
        var isCurrent = i === stamps.length - 1;
        var active = isCurrent ? viewIdx === null : viewIdx === i;
        return '<button class="mt-rating-chip' + (active ? " active" : "") + '" data-manhwa-id="' + m.id +
          '" data-rating-view="' + (isCurrent ? "current" : i) + '">' + escapeHtml(label) + "</button>";
      }).join("");
      ratingTabs = '<div class="mt-rating-tabs">' + chips + "</div>";
    }

    var emotionRecap = "";
    if (!snapView && typeof m.emotionRating === "number") {
      var recapStars = "";
      for (var j = 1; j <= 5; j++) {
        recapStars += '<span class="mt-emotion-star-static mini' + (j <= m.emotionRating ? " filled" : "") + '">★</span>';
      }
      emotionRecap =
        '<div class="mt-emotion-recap">' + recapStars +
        '<span class="mt-emotion-recap-label">' + escapeHtml(EMOTION_LABELS[m.emotionRating - 1]) + "</span></div>";
    }

    var html = emotionPicker + ratingTabs + '<div class="mt-paper mt-radar-panel"><div class="mt-rating-summary"><span class="mt-section-eyebrow">ТВОЯ ОЦЕНКА</span><div class="mt-editorial-score" style="--score-color:' + scoreColor(shownAvg) + '">' +
      (shownAvg === null ? '—' : Math.round(shownAvg)) + '<small>/ 100</small></div><span class="mt-rating-summary-caption">' + (snapView ? 'Из истории впечатлений' : 'Твой взгляд на эту историю') + '</span></div>' +
      (shownCriteria.length ? radarSvg(shownCriteria, {}) : "") +
      emotionRecap + "</div>" +
      '<div class="mt-paper mt-criteria-panel">';

    if (editable) {
      html += rerateSnap
        ? '<div class="mt-lock-hint">Прошлая оценка — ' + Math.round(rerateSnap.avg) +
          ' — сохранится в истории после нажатия «Сохранить переоценку». Черновик сохраняется на этом устройстве.</div>'
        : '<div class="mt-lock-hint">Можно менять — не забудь нажать «Готово» внизу</div>';
      m.criteria.forEach(function (c) {
        var color = criterionColor(c.score);
        var removable = m.criteria.length > 1;
        html +=
          '<div class="mt-crit-row" data-crit-id="' + c.id + '">' +
          '<div class="mt-crit-top">' +
          '<span class="mt-crit-name">' + escapeHtml(c.name) + "</span>" +
          '<div class="mt-crit-right">' +
          '<span class="mt-crit-score" data-score-label="' + c.id + '" style="color:' + color + '">' +
          c.score.toFixed(1) + "</span>" +
          (removable ? '<button class="mt-icon-btn" data-delete-crit="' + c.id + '" aria-label="Удалить критерий">✕</button>' : "") +
          "</div></div>" +
          '<input type="range" aria-label="' + escapeHtml(c.name) + '" class="mt-slider" min="1" max="10" step="0.5" value="' + c.score +
          '" data-slider-crit="' + c.id + '" />' +
          "</div>";
      });
    } else {
      shownCriteria.forEach(function (c) {
        var color = criterionColor(c.score);
        html +=
          '<div class="mt-bar-row"><span class="mt-bar-name">' + escapeHtml(c.name) + "</span>" +
          '<div class="mt-bar-track"><div class="mt-bar-fill" style="width:' + (c.score / 10) * 100 +
          "%;background:" + color + ';"></div></div>' +
          '<span class="mt-bar-value" style="color:' + color + '">' + c.score.toFixed(1) + "</span></div>";
      });
    }

    html += "</div>";

    html += '<button class="mt-ghost-btn" id="copy-scores-btn" data-manhwa-id="' + m.id +
      '" style="width:100%">📋 Копировать оценки</button>';
    if (!editable && m.rated) {
      html += renderComparison(m) + '<button class="mt-primary-btn" id="share-rating-card" data-manhwa-id="' + escapeHtml(m.id) + '">Создать карточку для публикации</button>';
    }
    if (rerateSnap) {
      html += '<div class="mt-paper"><label class="mt-field-label" for="rating-reason">Почему изменилось мнение?</label>' +
        '<textarea class="mt-input" id="rating-reason" maxlength="500" placeholder="Новые главы, развитие персонажей, другое впечатление…">' +
        escapeHtml(m.ratingReason || '') + '</textarea><p class="mt-feature-hint">Необязательно. Заметка останется рядом со сравнением оценок.</p></div>';
    }

    if (editable) {
      if (state.addingCriterion) {
        html +=
          '<div class="mt-paper">' +
          '<input class="mt-input" id="new-crit-input" placeholder="Свой критерий (напр. Саундтрек, Перевод)" />' +
          '<div class="mt-form-row">' +
          '<button class="mt-primary-btn" id="confirm-add-crit">Добавить</button>' +
          '<button class="mt-ghost-btn" id="cancel-add-crit">Отмена</button>' +
          "</div></div>";
      } else {
        html += '<button class="mt-add-btn" id="start-add-crit">+ Свой критерий</button>';
      }
    }

    return html;
  }

  function renderTagsPanel(m) {
    var tags = m.tags || [];
    var atLimit = tags.length >= 3;

    function chip(label, positive) {
      var selected = tags.indexOf(label) !== -1;
      var disabled = !selected && atLimit;
      var color = positive ? "#7FBF9B" : "#D9838F";
      var style = selected
        ? "background:" + color + ";color:#17171A;border-color:" + color
        : disabled
        ? "border-color:rgba(255,255,255,0.08);color:var(--text-faint);opacity:0.5"
        : "border-color:" + color + "55;color:" + color;
      return (
        '<button class="mt-tag-chip"' + (disabled ? " disabled" : "") + ' data-toggle-tag="' +
        escapeHtml(label) + '" data-manhwa-id="' + m.id + '" style="' + style + '">' +
        (selected ? "✓ " : "") + escapeHtml(label) + "</button>"
      );
    }

    var posChips = POSITIVE_TAGS.map(function (t) { return chip(t, true); }).join("");
    var negChips = NEGATIVE_TAGS.map(function (t) { return chip(t, false); }).join("");

    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">СИЛЬНЫЕ / СЛАБЫЕ СТОРОНЫ</div>' +
      '<div class="mt-tag-hint">До 3 тегов, которые лучше всего описывают тайтл' +
      (atLimit ? " — лимит достигнут, сними один, чтобы выбрать другой" : "") + "</div>" +
      '<div class="mt-tag-group-label mt-tag-group-pos">Сильные стороны</div>' +
      '<div class="mt-tag-row">' + posChips + "</div>" +
      '<div class="mt-tag-group-label mt-tag-group-neg">Слабые стороны</div>' +
      '<div class="mt-tag-row">' + negChips + "</div>" +
      "</div>"
    );
  }

  function renderTagsReadOnly(m) {
    var tags = m.tags || [];
    if (!tags.length) return "";
    var chips = tags.map(function (t) {
      var positive = POSITIVE_TAGS.indexOf(t) !== -1;
      var color = positive ? "#7FBF9B" : "#D9838F";
      return '<span class="mt-tag-chip" style="border-color:' + color + ";color:" + color +
        ";background:" + color + '18;">' + escapeHtml(t) + "</span>";
    }).join("");
    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">СИЛЬНЫЕ / СЛАБЫЕ СТОРОНЫ</div>' +
      '<div class="mt-tag-row">' + chips + "</div>" +
      "</div>"
    );
  }

  function renderGenresReadOnly(m) {
    var genres = m.genres || [];
    if (!genres.length) return "";
    var chips = genres.map(function (g) {
      return '<span class="mt-genre-chip mt-genre-chip-static">' + escapeHtml(g) + "</span>";
    }).join("");
    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">ЖАНРЫ</div>' +
      '<div class="mt-genre-list">' + chips + "</div>" +
      "</div>"
    );
  }

  function renderAltTitlesReadOnly(m) {
    var alt = m.altTitles || {};
    var fields = [
      ["en", "EN"], ["ja", "JP"], ["ko", "KR"], ["ru", "RU"]
    ];
    var rows = fields
      .filter(function (f) { return alt[f[0]] && alt[f[0]].trim(); })
      .map(function (f) {
        return (
          '<div class="mt-alt-row-static"><span class="mt-alt-label">' + f[1] + "</span>" +
          '<span class="mt-alt-value">' + escapeHtml(alt[f[0]]) + "</span></div>"
        );
      }).join("");
    if (!rows) return "";
    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">АЛЬТЕРНАТИВНЫЕ НАЗВАНИЯ</div>' +
      rows +
      "</div>"
    );
  }

  function renderRevealOverlay(m) {
    var avg = average(m.criteria);
    var verdict = avg === null ? 'Впечатление сохранено' : avg >= 90 ? 'В самое сердце' : avg >= 75 ? 'История, которую стоит помнить' : avg >= 50 ? 'Есть за что зацепиться' : 'Не твоя история';
    var cover = m.coverUrl ? '<img class="mt-reveal-cover-img" src="' + escapeHtml(m.coverUrl) + '" alt="" />' : '<div class="mt-reveal-cover-fallback"><img src="icons/mark.svg" alt="" /><span>ТВОЯ<br>ИСТОРИЯ</span></div>';
    return '<div class="mt-reveal-backdrop" id="reveal-backdrop"><section class="mt-reveal-card" role="dialog" aria-modal="true" aria-labelledby="reveal-title">' +
      '<div class="mt-reveal-content"><div class="mt-reveal-edition"><span class="mt-reveal-saved">✓ Оценка сохранена</span><span>AM TRACKER</span></div>' +
      '<div class="mt-reveal-hero"><div class="mt-reveal-cover">' + cover + '</div><div class="mt-reveal-result"><span class="mt-reveal-kicker">ПЕРВОЕ ВПЕЧАТЛЕНИЕ</span><div class="mt-reveal-stamp">' + (avg === null ? '—' : Math.round(avg)) + '<span>/ 100</span></div><p class="mt-reveal-verdict">' + verdict + '</p></div></div>' +
      '<h2 class="mt-reveal-title" id="reveal-title">' + escapeHtml(displayTitle(m)) + '</h2>' +
      '<div class="mt-reveal-criteria">' + m.criteria.map(function(c){return '<div><span>' + escapeHtml(c.name) + '</span><b>' + c.score.toFixed(1) + '</b><i aria-hidden="true"><em style="width:' + Math.max(0,Math.min(100,c.score*10)) + '%"></em></i></div>';}).join('') + '</div>' +
      (m.notes && m.notes.trim() ? '<details class="mt-reveal-notes"><summary>Твоё послевкусие <span>Читать заметку ↗</span></summary><p>' + escapeHtml(m.notes) + '</p></details>' : '') +
      '</div><footer class="mt-reveal-footer"><button class="mt-primary-btn" id="reveal-close-btn">Вернуться к тайтлу <span aria-hidden="true">↗</span></button><small>Оценка уже в твоей библиотеке</small></footer></section></div>';
  }

  // Categories still open for nomination for the month this title belongs to
  // (winner not yet decided). Returns null if there's nothing to nominate.
  function openAwardCategoriesFor(m) {
    if (!m.rated) return null;
    var ts = ratingTs(m);
    if (ts === null) return null;
    var monthKey = monthKeyOf(ts);
    var categories = AWARD_CATEGORY_KEYS.filter(function (ck) {
      if (getWinner(monthKey, ck)) return false;
      if (ck === "cover") return !!m.coverUrl;
      if (isOverallScaleCategory(ck)) return average(m.criteria) !== null;
      return m.criteria.some(function (c) { return c.name === ck; });
    });
    if (!categories.length) return null;
    return { monthKey: monthKey, categories: categories };
  }

  // Compact single button under the cover — expands into the nomination
  // checklist below only when tapped, instead of always taking up space.
  function renderCandidateToggle(m, info) {
    var pickedCount = info.categories.filter(function (ck) {
      return getCandidateIds(info.monthKey, ck).indexOf(m.id) !== -1;
    }).length;
    var open = state.candidatePanelOpen;
    var label = "🏆 Кандидат в премию" + (pickedCount > 0 ? " (" + pickedCount + "/" + info.categories.length + ")" : "");
    return (
      '<button class="mt-ghost-btn' + (pickedCount > 0 ? " mt-candidate-toggle-active" : "") +
      '" id="candidate-panel-toggle" data-manhwa-id="' + m.id + '" style="width:100%;margin-bottom:12px">' +
      label + " " + (open ? "▾" : "▸") +
      "</button>"
    );
  }

  // Lets a title be nominated straight from its own page: toggles it in/out of
  // the candidate shortlist for whichever category, for the month it belongs to.
  function renderCandidatePanel(m, info) {
    var rows = info.categories.map(function (ck) {
      var checked = getCandidateIds(info.monthKey, ck).indexOf(m.id) !== -1;
      return (
        '<div class="mt-nominee-row' + (checked ? " picked" : "") + '" data-toggle-candidate="' + m.id +
        '" data-month="' + info.monthKey + '" data-category="' + escapeHtml(ck) + '">' +
        '<span class="mt-nominee-checkbox">' + (checked ? "☑" : "☐") + "</span>" +
        '<div class="mt-nominee-info"><div class="mt-nominee-title">' + escapeHtml(AWARD_LABELS[ck] || ck) + "</div></div>" +
        "</div>"
      );
    }).join("");

    return (
      '<div class="mt-paper mt-award-panel">' +
      '<div class="mt-panel-title">🏆 Кандидат в премию — ' + escapeHtml(monthLabel(info.monthKey)) + "</div>" +
      '<div class="mt-ceremony-hint">Отметь номинации месяца, в которых участвует этот тайтл</div>' +
      rows +
      "</div>"
    );
  }

  function renderDetail(m) {
    var avg = average(m.criteria);
    var isNew = m.rated === false;
    var unlocked = !!state.unlockedIds[m.id] || !!state.ratingDrafts[m.id];
    var editable = isNew || unlocked;

    var rerateSnap = state.ratingDrafts[m.id] ? state.ratingDrafts[m.id].snapshot : null;
    var currentStatus = statusById(m.status);
    var html =
      '<div class="mt-detail-head">' +
      '<button class="mt-icon-btn on-dark" id="back-btn" aria-label="Назад">←</button>' +
      '<div class="mt-detail-title">' + escapeHtml(displayTitle(m)) + "</div>" +
      "</div>" +
      '<div class="mt-detail-status">' +
      '<button class="mt-status-badge" id="status-picker-toggle" style="border-color:' + currentStatus.color +
      ";color:" + currentStatus.color + ";background:" + currentStatus.color + '18;">' +
      escapeHtml(currentStatus.label) + " " + (state.statusPickerOpen ? "▴" : "▾") +
      "</button> " +
      typeBadgeHtml(m.type || "manhwa", 'data-cycle-type-id="' + m.id + '"') +
      "</div>" +
      (state.statusPickerOpen ? renderStatusPicker(m) : "") +
      renderErrorBanner() +
      '<div class="mt-detail-body">' +
      '<div class="mt-detail-overview">'+journeyCover(m)+'<div><span class="mt-section-eyebrow">ТВОЯ ИСТОРИЯ</span><strong>'+ (ratedScore(m)===null?'Без оценки':Math.round(ratedScore(m))+' / 100')+'</strong><small>'+escapeHtml(currentStatus.label)+'</small></div></div>'+
      '<nav class="mt-detail-nav" aria-label="Разделы тайтла">'+[['rating','Оценка'],['journal','Дневник']].map(function(x){return '<button data-detail-section="'+x[0]+'" aria-pressed="'+(usability.detailSection===x[0])+'">'+x[1]+'</button>';}).join('')+'</nav><section data-detail-panel="rating">';

    var wins = awardsForManhwa(m);
    var hasGoldWin = positiveAwardsForManhwa(m).length > 0;

    var candidateInfo = openAwardCategoriesFor(findManhwa(m.id));
    if (candidateInfo) {
      html += renderCandidateToggle(m, candidateInfo);
      if (state.candidatePanelOpen) html += renderCandidatePanel(m, candidateInfo);
    }

    if (wins.length > 0) {
      html +=
        '<div class="mt-paper mt-award-panel">' +
        wins.map(function (a) {
          return (
            '<div class="mt-award-row">' +
            '<span class="mt-award-trophy">' + awardIcon(a.categoryKey) + "</span>" +
            '<div><div class="mt-award-title">' + escapeHtml(AWARD_LABELS[a.categoryKey] || a.categoryKey) + "</div>" +
            '<div class="mt-award-sub">' + escapeHtml(monthLabel(a.monthKey)) + "</div></div>" +
            "</div>"
          );
        }).join("") +
        "</div>";
    }

    html += renderRatingSection(m, avg, editable, rerateSnap);
    html += renderTitleTools(m);
    if(!editable)html+=renderTagsReadOnly(m)+renderGenresReadOnly(m)+renderAltTitlesReadOnly(m)+renderNotesReadOnly(m);

    if (editable) {
      html += renderTagsPanel(m) + renderGenresPanel(m) + renderAltTitlesPanel(m) + renderNotesPanel(m) + renderCoverPanel(m);
    }

    if (editable) {
      if (isNew) {
        html +=
          '<label class="mt-rating-confirm"><input id="rating-confirm" type="checkbox" /> Подтверждаю итоговую оценку по выбранным критериям</label><p id="rating-confirm-error" role="alert"></p>' +
          '<div class="mt-form-row">' +
          '<button class="mt-ghost-btn" id="finish-rating-btn" data-manhwa-id="' + m.id +
          '" style="flex:1">✓ Без рецензии</button>' +
          '<button class="mt-primary-btn" id="finish-rating-review-btn" data-manhwa-id="' + m.id +
          '" style="flex:1">📝 С рецензией</button>' +
          "</div>" +
          '<div class="mt-ceremony-hint" style="text-align:center;margin-top:8px">' +
          "За рецензию (пара слов в заметках выше) — больше опыта</div>";
      } else {
        if(rerateSnap)html+='<label class="mt-rating-confirm"><input id="rating-confirm" type="checkbox" /> Подтверждаю новую оценку по выбранным критериям</label><p id="rating-confirm-error" role="alert"></p>';
        html += '<button class="mt-primary-btn" id="finish-rating-btn" data-manhwa-id="' + m.id +
          '" style="width:100%">' + (rerateSnap ? 'Сохранить переоценку' : 'Готово') + '</button>';
        if (rerateSnap) html += '<button class="mt-ghost-btn" id="cancel-rerate-btn" data-manhwa-id="' + m.id + '">Отменить переоценку</button>';
      }
    } else {
      html += '<div class="mt-form-row">' +
        '<button class="mt-ghost-btn" id="unlock-rating-btn" data-manhwa-id="' + m.id +
        '" style="flex:1">✎ Изменить</button>' +
        '<button class="mt-primary-btn" id="rerate-btn" data-manhwa-id="' + m.id +
        '" style="flex:1">🔄 Оценить заново</button>' +
        "</div>" +
        '<div class="mt-ceremony-hint" style="text-align:center;margin-top:8px">' +
        "Прочитал новые главы? «Оценить заново» сохранит старую оценку в историю и добавит новую в премию этого месяца</div>";
    }

    html += '</section><section data-detail-panel="journal"><button class="mt-primary-btn mt-journal-add" id="journal-quick">'+(chapterDrafts[m.id]?'Продолжить черновик':'Оценить главу')+'</button>'+renderChapterJournal(m);
    html += renderActivityFeedForManhwa(m)+'</section>';

    var confirmingDelete = state.confirmDeleteId === m.id;
    html += '<button class="mt-clear-btn' + (confirmingDelete ? " confirm" : "") +
      '" data-delete-id="' + m.id + '" style="width:100%">' +
      (confirmingDelete ? "Точно удалить? Нажми ещё раз" : "Удалить манхву") + "</button>";

    html += "</div>";
    return html;
  }

  /* ---------- view: profile ---------- */
  function aggregateCriteria() {
    var map = {};
    state.manhwas.forEach(function (m) {
      if (ratedScore(m) === null) return;
      m.criteria.forEach(function (c) {
        if (!map[c.name]) map[c.name] = { sum: 0, count: 0 };
        map[c.name].sum += c.score;
        map[c.name].count += 1;
      });
    });
    var extraNames = Object.keys(map).filter(function (k) { return DEFAULT_CRITERIA.indexOf(k) === -1; });
    var order = DEFAULT_CRITERIA.concat(extraNames);
    return order
      .filter(function (name) { return map[name]; })
      .map(function (name) {
        return { id: name, name: name, score: map[name].sum / map[name].count, count: map[name].count };
      })
      .slice(0, 8);
  }

  function miniRowHtml(m) {
    var avg = average(m.criteria);
    return (
      '<button class="mt-mini-row" data-open-id="' + m.id + '">' +
      (m.coverUrl ? '<img class="mt-profile-book" src="' + escapeHtml(m.coverUrl) + '" alt="" loading="lazy" />' : '<span class="mt-profile-book mt-profile-book-empty" aria-hidden="true">' + escapeHtml((displayTitle(m)[0] || '?').toUpperCase()) + '</span>') +
      '<div class="mt-mini-title">' + escapeHtml(displayTitle(m)) + "</div>" +
      '<span class="mt-mini-score" style="color:#C9BFA8">' +
      (avg === null ? "—" : Math.round(avg)) + "</span></button>"
    );
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function formatActivityDate(ts) {
    var d = new Date(ts);
    var now = new Date();
    var time = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return "Сегодня, " + time;
    var yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return "Вчера, " + time;
    var label = d.getDate() + " " + MONTH_NAMES_GENITIVE[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) label += " " + d.getFullYear();
    return label + ", " + time;
  }

  function activityIcon(e) {
    if (e.type === "add") return "➕";
    if (e.type === "rated") return "⭐";
    if (e.type === "rated_review") return "📝";
    if (e.type === "rerated") return "🔄";
    if (e.type === "rerated_review") return "📝";
    if (e.type === "status") {
      var st = e.extra && statusById(e.extra.status);
      return st ? '<span class="mt-activity-dot" style="background:' + st.color + '"></span>' : "•";
    }
    if (e.type === "award") return awardIcon(e.extra ? e.extra.categoryKey : "");
    if (e.type === "delete") return "✕";
    return "•";
  }

  function activityLineText(e) {
    // Prefer the title's current display name (picks up a Russian name added
    // later) and only fall back to the frozen snapshot for deleted titles.
    var live = e.manhwaId && findManhwa(e.manhwaId);
    var t = escapeHtml(live ? displayTitle(live) : (e.title || ""));
    if (e.type === "add") return "Добавлен тайтл «" + t + "»";
    if (e.type === "rated" || e.type === "rated_review") {
      var score = e.extra && e.extra.score !== null && e.extra.score !== undefined ? Math.round(e.extra.score) : null;
      var withReview = e.type === "rated_review";
      return "Оценён «" + t + "»" + (withReview ? " с рецензией" : "") + (score !== null ? " — " + score + "/100" : "");
    }
    if (e.type === "rerated" || e.type === "rerated_review") {
      var newScore = e.extra && e.extra.score !== null && e.extra.score !== undefined ? Math.round(e.extra.score) : null;
      var prevScore = e.extra && e.extra.prevScore !== null && e.extra.prevScore !== undefined ? Math.round(e.extra.prevScore) : null;
      var withReview2 = e.type === "rerated_review";
      return "Переоценён «" + t + "»" + (withReview2 ? " с рецензией" : "") +
        (prevScore !== null && newScore !== null ? " — " + prevScore + " → " + newScore : (newScore !== null ? " — " + newScore + "/100" : ""));
    }
    if (e.type === "status") {
      var st = e.extra && statusById(e.extra.status);
      return "«" + t + "»: статус «" + escapeHtml(st ? st.label : "?") + "»";
    }
    if (e.type === "award") {
      var catLabel = e.extra ? (AWARD_LABELS[e.extra.categoryKey] || e.extra.categoryKey) : "";
      var mLabel = e.extra ? monthLabel(e.extra.monthKey) : "";
      return "«" + t + "» — " + escapeHtml(catLabel) + " (" + escapeHtml(mLabel) + ")";
    }
    if (e.type === "delete") return "Удалён тайтл «" + t + "»";
    return t;
  }

  function renderActivityRows(events) {
    return events.map(function (e) {
      return (
        '<div class="mt-activity-row">' +
        '<span class="mt-activity-icon">' + activityIcon(e) + "</span>" +
        '<div class="mt-activity-body">' +
        '<div class="mt-activity-text">' + activityLineText(e) + "</div>" +
        '<div class="mt-activity-date">' + formatActivityDate(e.ts) + "</div>" +
        "</div></div>"
      );
    }).join("");
  }

  // Per-title diary, shown on that title's own detail page — not a global feed.
  function renderActivityFeedForManhwa(m) {
    var events = state.activityLog.filter(function (e) { return e.manhwaId === m.id; });
    if (!events.length) return "";
    var rows = renderActivityRows(events.slice().reverse());
    return '<div class="mt-paper"><div class="mt-panel-title">ДНЕВНИК ТАЙТЛА</div><div class="mt-activity-list">' + rows + "</div></div>";
  }

  function renderRankBadge() {
    var idx = rankIndexForXp(state.totalXp);
    var rank = RANKS[idx];
    return (
      '<div class="mt-rank-badge" style="background:linear-gradient(135deg,' + rank.gradient.join(",") + ')">' +
      '<span class="mt-rank-badge-icon">' + rank.icon + "</span>" +
      '<span class="mt-rank-badge-name">' + escapeHtml(rank.name) + "</span>" +
      "</div>"
    );
  }

  function renderRankPanel() {
    var idx = rankIndexForXp(state.totalXp);
    var rank = RANKS[idx];
    var next = RANKS[idx + 1];
    var grad = rank.gradient.join(",");
    var isMax = !next;
    var progressPct, progressLabel;
    if (isMax) {
      progressPct = 100;
      progressLabel = "Максимальный ранг достигнут";
    } else {
      var span = next.minXp - rank.minXp;
      var into = state.totalXp - rank.minXp;
      progressPct = Math.max(3, Math.min(100, Math.round((into / span) * 100)));
      progressLabel = (next.minXp - state.totalXp) + " XP до ранга «" + escapeHtml(next.name) + "»";
    }
    return (
      '<div class="mt-paper mt-rank-panel' + (isMax ? " mt-rank-panel-legendary" : "") + '">' +
      '<div class="mt-rank-panel-top">' +
      '<span class="mt-rank-panel-icon" style="background:linear-gradient(135deg,' + grad + ')">' + rank.icon + "</span>" +
      '<div><div class="mt-rank-panel-name">' + escapeHtml(rank.name) + "</div>" +
      '<div class="mt-rank-panel-xp">' + state.totalXp + " XP</div></div>" +
      "</div>" +
      '<div class="mt-rank-progress-track"><div class="mt-rank-progress-fill" style="width:' + progressPct +
      "%;background:linear-gradient(90deg," + grad + ')"></div></div>' +
      '<div class="mt-rank-progress-label">' + escapeHtml(progressLabel) + "</div>" +
      '<button class="mt-rank-ladder-toggle" id="rank-ladder-toggle">Все ранги ' + (state.showAllRanks ? "▴" : "▾") + "</button>" +
      "</div>" +
      (state.showAllRanks ? renderRankLadder(idx) : "")
    );
  }

  // Full ladder of every rank tier — reached ones lit up and checked off,
  // the current one glowing and labelled, everything above still dim.
  function renderRankLadder(currentIdx) {
    var rows = RANKS.map(function (r, i) {
      var grad = r.gradient.join(",");
      var reached = i <= currentIdx;
      var isCurrent = i === currentIdx;
      var rangeLabel = RANKS[i + 1] ? (r.minXp + "–" + (RANKS[i + 1].minXp - 1) + " XP") : (r.minXp + "+ XP");
      return (
        '<div class="mt-rank-ladder-row' + (reached ? " reached" : "") + (isCurrent ? " current" : "") + '">' +
        '<span class="mt-rank-ladder-icon" style="background:linear-gradient(135deg,' + grad + ')">' + r.icon + "</span>" +
        '<div class="mt-rank-ladder-body">' +
        '<div class="mt-rank-ladder-name">' + escapeHtml(r.name) + (isCurrent ? ' <span class="mt-rank-ladder-here">— ВЫ ЗДЕСЬ</span>' : "") + "</div>" +
        '<div class="mt-rank-ladder-range">' + rangeLabel + "</div>" +
        "</div>" +
        (reached ? '<span class="mt-rank-ladder-check">✓</span>' : "") +
        "</div>"
      );
    }).join("");
    return '<div class="mt-paper mt-rank-ladder">' + rows + "</div>";
  }

  function achievementMetrics() {
    var days = {};
    state.activityLog.forEach(function (e) { if (Number.isFinite(e.ts)) days[new Date(e.ts).toDateString()] = true; });
    return { collect: state.manhwas.length, genres: distinctGenresCount(), rated: ratedTitlesCount(),
      rerated:state.manhwas.reduce(function (sum,m) { return sum + (m.ratingHistory || []).length; },0),
      manhwa:state.manhwas.filter(function (m) { return (m.type || 'manhwa') === 'manhwa'; }).length,
      manga:state.manhwas.filter(function (m) { return m.type === 'manga'; }).length,
      manhua:state.manhwas.filter(function (m) { return m.type === 'manhua'; }).length,
      covered:state.manhwas.filter(function (m) { return !!String(m.coverUrl || '').trim(); }).length,
      annotated:state.manhwas.filter(function (m) { return !!String(m.notes || '').trim(); }).length,
      activeDays:Object.keys(days).length,
      review: reviewCount(), award: totalAwardWinsCount(), dropper: droppedTitlesCount(), completed: countByStatus('done'),
      planned: countByStatus('plan'), reading: countByStatus('reading'), streak: longestStreakDays(),
      types: TYPES.filter(function (t) { return state.manhwas.some(function (m) { return (m.type || 'manhwa') === t.id; }); }).length,
      categories: AWARD_CATEGORY_KEYS.filter(categoryEverWon).length, ceremonies: monthsFullyDecidedCount(),
      actions: maxActionsInOneDay(), xp: state.totalXp };
  }

  function achievementProgress(a, metrics) {
    var current = 0, target = 1, measured = false, match = a.id.match(/^(collect|genres|rated|review|award|dropper|completed|planned|reading|streak)_(\d+)$/);
    if (match) { current = metrics[match[1]]; target = Number(match[2]); measured = true; }
    if (a.metric) { current = metrics[a.metric]; target = a.target; measured = true; }
    var first = {first_add:'collect',first_rated:'rated',first_review:'review',first_award:'award'};
    if (first[a.id]) { current = metrics[first[a.id]]; measured = true; }
    var special = { all_types:[metrics.types,3], all_categories:[metrics.categories,AWARD_CATEGORY_KEYS.length],
      ceremony_full:[metrics.ceremonies,1], ceremony_full_3:[metrics.ceremonies,3], busy_day:[metrics.actions,10], rank_legend:[metrics.xp,13000] };
    if (special[a.id]) { current = special[a.id][0]; target = special[a.id][1]; measured = true; }
    if (!measured) current = a.check() ? 1 : 0;
    var unlocked = !!state.unlockedAchievements[a.id];
    return {current:unlocked ? target : Math.min(target,Math.max(0,current)), target:target, measured:measured,
      fraction:unlocked ? 1 : Math.min(1,Math.max(0,current / target)), unlocked:unlocked};
  }

  function achievementCard(a, p, compact) {
    var stamp = state.unlockedAchievements[a.id];
    var date = typeof stamp === 'number' && stamp > 1 ? new Date(stamp).toLocaleDateString('ru-RU') : '';
    var status = p.unlocked ? 'Получено' + (date ? ' · ' + date : '') : (p.fraction === 1 ? 'Условие выполнено' : (p.measured ? p.current + ' / ' + p.target : 'Ещё впереди'));
    return '<article class="mt-achievement-card' + (p.unlocked ? ' earned' : '') + (compact ? ' compact' : '') + '" data-achievement-id="' + a.id + '">' +
      '<div class="mt-achievement-top"><span class="mt-achievement-medal" aria-hidden="true">' + a.icon + '</span><span class="mt-achievement-xp">' + (a.xp ? '+' + a.xp + ' XP' : 'Знак ранга') + '</span></div>' +
      '<span class="mt-achievement-category">' + escapeHtml(a.category) + '</span><h3>' + escapeHtml(a.name) + '</h3><p>' + escapeHtml(a.desc) + '</p>' +
      '<div class="mt-achievement-bottom"><div class="mt-achievement-state"><span>' + (p.unlocked ? '✓ ' : '') + status + '</span>' + (!p.unlocked && p.measured ? '<strong>' + Math.round(p.fraction*100) + '%</strong>' : '') + '</div>' +
      (p.measured || p.unlocked ? '<div class="mt-achievement-track" role="progressbar" aria-label="' + escapeHtml(a.name) + '" aria-valuemin="0" aria-valuemax="' + p.target + '" aria-valuenow="' + p.current + '"><span style="width:' + p.fraction*100 + '%"></span></div>' : '') + '</div></article>';
  }

  function renderAchievementsTab() {
    var metrics = achievementMetrics(), rows = ACHIEVEMENTS.map(function (a) { return {a:a,p:achievementProgress(a,metrics)}; });
    var unlocked = rows.filter(function (r) { return r.p.unlocked; }), percent = Math.round(unlocked.length / rows.length * 100);
    var next = rows.filter(function (r) { return !r.p.unlocked && r.p.measured && r.p.fraction > 0 && r.p.fraction < 1; }).sort(function (a,b) { return b.p.fraction-a.p.fraction || a.p.target-b.p.target; }).slice(0,3);
    if (!next.length) next = rows.filter(function (r) { return !r.p.unlocked; }).slice(0,3);
    var earnedXp = unlocked.reduce(function (sum,r) { return sum+r.a.xp; },0);
    var html = '<section class="mt-achievement-page"><header class="mt-header"><div class="mt-section-eyebrow">ТВОЙ ПУТЬ В ИСТОРИЯХ</div><h1 class="mt-page-title">Коллекция достижений</h1></header><div class="mt-list">' +
      '<section class="mt-achievement-passport"><div><span class="mt-section-eyebrow">ПАСПОРТ ЧИТАТЕЛЯ</span><h2>Каждая история<br><em>делает тебя сильнее.</em></h2><p>' + unlocked.length + ' из ' + rows.length + ' наград · ' + earnedXp + ' XP за достижения</p></div><div class="mt-achievement-ring" style="--progress:' + percent + '%"><strong>' + percent + '<small>%</small></strong><span>коллекции</span></div></section>' + renderRankPanel();
    if (unlocked.length) {
      html += '<div class="mt-achievement-heading"><h2>Последние награды</h2><span>Твоя витрина</span></div><div class="mt-achievement-showcase">' + unlocked.slice().sort(function (a,b) { return Number(state.unlockedAchievements[b.a.id])-Number(state.unlockedAchievements[a.a.id]); }).slice(0,3).map(function (r) {
        return '<div><span class="mt-achievement-medal" aria-hidden="true">' + r.a.icon + '</span><strong>' + escapeHtml(r.a.name) + '</strong><small>✓ Получено</small></div>';
      }).join('') + '</div>';
    }
    if (next.length) html += '<div class="mt-achievement-heading"><h2>Следующие цели</h2><span>Ближе, чем кажется</span></div><div class="mt-achievement-next">' + next.map(function (r) { return achievementCard(r.a,r.p,true); }).join('') + '</div>';
    html += '<div class="mt-achievement-heading"><h2>Все достижения</h2><span>Всего: ' + rows.length + '</span></div>' +
      '<div class="mt-achievement-filters" role="group" aria-label="Статус достижения">' + [['all','Все'],['locked','Впереди'],['earned','Получены']].map(function (f) {
        return '<button data-achievement-filter="' + f[0] + '" aria-pressed="' + (state.achievementFilter === f[0]) + '">' + f[1] + '</button>';
      }).join('') + '</div><div class="mt-achievement-categories" role="group" aria-label="Категория достижения">' + ['Все категории'].concat(ACHIEVEMENT_CATEGORIES).map(function (c) {
        return '<button data-achievement-category="' + escapeHtml(c) + '" aria-pressed="' + (state.achievementCategory === c) + '">' + escapeHtml(c) + '</button>';
      }).join('') + '</div>';
    var visible = rows.filter(function (r) { return (state.achievementCategory === 'Все категории' || r.a.category === state.achievementCategory) && (state.achievementFilter === 'all' || (state.achievementFilter === 'earned' ? r.p.unlocked : !r.p.unlocked)); });
    html += '<div class="mt-achievement-result-count" role="status">Показано: ' + visible.length + '</div><div class="mt-achievement-grid">' + visible.map(function (r) { return achievementCard(r.a,r.p,false); }).join('') + '</div>';
    if (!visible.length) html += '<div class="mt-paper mt-empty"><div class="mt-empty-title">Здесь пока тихо</div><p class="mt-feature-hint">В этой категории пока нет наград с выбранным статусом. Попробуй другой фильтр.</p></div>';
    return html + '<p class="mt-achievement-note">Полученные награды остаются с тобой навсегда. Прогресс незавершённых целей считается по текущей библиотеке и сохранённой истории активности. XP начисляется автоматически при действиях в приложении.</p></div></section>';
  }
  function saveShop(){persistKey(SHOP_STORAGE_KEY,state.shop).catch(function(){});syncPing();}
  function loadShop(){return readKey(SHOP_STORAGE_KEY).then(function(raw){state.shop=Features.cleanShop(raw,state.totalXp);});}
  function ownsStyle(id){var item=Features.shopItem(id);return !!item&&(item.eventOnly?!!state.unlockedAchievements[item.eventOnly]:item.exclusive?!!(window.AMSync&&window.AMSync.isOwner&&window.AMSync.isOwner()):!!state.shop[id]);}
  function activeStyle(preview){
    var style=Features.cleanStyle(state.profile.style);
    Object.keys(style).forEach(function(k){if(!ownsStyle(style[k]))style[k]='';});
    var item=Features.shopItem(preview);if(item&&(!item.exclusive||ownsStyle(item.id)))style[item.kind]=item.id;
    return style;
  }
  function styleClasses(style){return Object.keys(style).map(function(k){return style[k]?' mt-'+style[k]:'';}).join('');}
  function styleBadge(style){var item=Features.shopItem(style.badge);return item?'<span class="mt-shop-badge">'+(item.image?'<img src="'+escapeHtml(item.image)+'" alt="" width="30" height="30" />':item.icon)+' <span>'+escapeHtml(item.name)+'</span></span>':'';}
  function buyShopItem(id){
    var item=Features.shopItem(id);if(!item||item.exclusive||item.eventOnly||state.shop[id])return false;
    if(Features.coinBalance(state.totalXp,state.shop)<item.price){state.shopNotice='Не хватает монет. Они начисляются вместе с опытом.';return false;}
    state.shop[id]=Date.now();saveShop();state.shopNotice='Куплено: '+item.name+'. Оформление доступно в редакторе профиля.';return true;
  }
  function equipShopItem(id){var item=Features.shopItem(id);if(!item||!ownsStyle(id))return;var style=Features.cleanStyle(state.profile.style);style[item.kind]=id;state.profile.style=style;saveProfile();state.shopNotice='Оформление применено.';}
  function renderShopEntry(){return '<button class="mt-shop-entry" id="shop-open"><span><small>МАГАЗИН ПРОФИЛЯ</small><strong>Сделай его своим <span aria-hidden="true">↗</span></strong></span><b>◈ '+Features.coinBalance(state.totalXp,state.shop)+'</b></button>'+(state.shopNotice?'<p class="mt-feature-hint" role="status">'+escapeHtml(state.shopNotice)+'</p>':'');}

  function renderCollections(){
    return '<details class="mt-shop-collections"><summary>Коллекции оформления <span>5 наборов</span></summary><div class="mt-collection-grid">'+Features.shopCollections.map(function(c){
      var count=c.items.filter(ownsStyle).length,missing=c.items.filter(function(id){return !ownsStyle(id);}).reduce(function(n,id){return n+Features.shopItem(id).price;},0);
      return '<article class="mt-collection-card"><div class="mt-collection-art mt-'+c.items[0]+'"></div><div><h3>'+escapeHtml(c.name)+'</h3><p>'+escapeHtml(c.text)+'</p><small>Собрано '+count+' / '+c.items.length+(missing?' · Осталось на '+missing+' ◈':' · Полный комплект ✓')+'</small><p>'+c.items.map(function(id){return escapeHtml(Features.shopItem(id).name)+(ownsStyle(id)?' ✓':'');}).join(' · ')+'</p><button class="mt-ghost-btn" data-set-preview="'+c.id+'">Примерить набор</button></div></article>';
    }).join('')+'</div></details>';
  }
  function renderShop(){
    var style=activeStyle(state.shopPreview),balance=Features.coinBalance(state.totalXp,state.shop),preview=Features.shopItem(state.shopPreview);
    var items=Features.shopItems.filter(function(i){return ((state.shopAvailability==='owned')?ownsStyle(i.id):!i.exclusive&&!i.eventOnly)&&((state.shopAvailability==='affordable')?!ownsStyle(i.id)&&i.price<=balance:(state.shopAvailability==='unowned')?!ownsStyle(i.id):true)&&(state.shopCategory==='all'||i.kind===state.shopCategory)&&(state.shopRarity==='all'||i.rarity===state.shopRarity);});
    var collection=Features.shopCollections.find(function(c){return c.id===state.shopSet;});
    if(collection)collection.items.forEach(function(id){var item=Features.shopItem(id);style[item.kind]=id;});
    var rarityOrder={common:0,rare:1,epic:2,legendary:3,exclusive:4};
    if(state.shopSort)items.sort(function(a,b){if(state.shopSort==='price-asc')return a.price-b.price;if(state.shopSort==='price-desc')return b.price-a.price;var delta=rarityOrder[a.rarity]-rarityOrder[b.rarity];return (state.shopSort==='rare-first'?-delta:delta)||a.price-b.price;});
    return '<section class="mt-shop-page"><button id="shop-back" class="mt-ghost-btn">← Профиль</button><header class="mt-shop-heading"><div><span class="mt-section-eyebrow">КОЛЛЕКЦИЯ ТВОЕГО СТИЛЯ</span><h1>Истории меняют нас.<br><em>Выбери свой образ.</em></h1></div><div class="mt-shop-wallet"><small>ТВОИ МОНЕТЫ</small><b>◈ '+balance+'</b></div></header><p class="mt-shop-explain">За каждый полученный XP — 1 монета. Прошлый опыт уже учтён. Покупки не снижают опыт и ранг.</p>'+
      '<div class="mt-shop-preview'+styleClasses(style)+'"><span class="mt-section-eyebrow">'+(collection?'НАБОР · '+escapeHtml(collection.name):preview?'ПРИМЕРКА · '+escapeHtml(preview.name):'ТВОЁ ОФОРМЛЕНИЕ')+'</span><div class="mt-shop-preview-person"><div class="mt-shop-avatar">'+avatarHtml(state.profile)+'</div><div><strong>'+escapeHtml(displayNick())+'</strong>'+styleBadge(style)+'<p>Твоя следующая история уже рядом.</p></div></div></div>'+
      '<p class="mt-preview-composition">'+[['theme','Тема'],['frame','Рамка'],['badge','Значок']].map(function(pair){var item=Features.shopItem(style[pair[0]]);return pair[1]+': '+escapeHtml(item?item.name:'базовое оформление');}).join(' · ')+'</p><p class="mt-feature-hint">Примерка бесплатна. Покупка добавляет вещь в коллекцию; применение — после сохранения профиля.</p><div class="mt-shop-preview-actions">'+(collection?'<button class="mt-ghost-btn" id="shop-set-clear">Закончить примерку набора</button><span class="mt-feature-hint">Предметы покупаются отдельно. Выбор оформления — в редакторе профиля.</span>':'')+(preview?(ownsStyle(preview.id)?'<button class="mt-primary-btn" id="shop-edit-profile">Оформить профиль →</button>':'<button class="mt-primary-btn" data-shop-buy="'+preview.id+'"'+(balance<preview.price?' disabled':'')+'>'+(balance<preview.price?'Не хватает '+(preview.price-balance)+' ◈':'Купить за '+preview.price+' ◈')+'</button>')+'<button class="mt-ghost-btn" id="shop-preview-clear">Закончить примерку</button>':'')+'</div>'+
      renderCollections()+'<p class="mt-shop-notice" role="status">'+escapeHtml(state.shopNotice||'Примеряй бесплатно. Купленные вещи остаются в коллекции.')+'</p><nav class="mt-shop-filters" aria-label="Категории магазина">'+[['all','Всё'],['theme','Темы'],['frame','Рамки'],['badge','Значки']].map(function(c){return '<button data-shop-category="'+c[0]+'" aria-pressed="'+(state.shopCategory===c[0])+'">'+c[1]+'</button>';}).join('')+'</nav><label class="mt-shop-rarity-filter">Показать<select id="shop-availability" class="mt-input">'+[['all','Все вещи'],['affordable','Хватает монет'],['unowned','Не куплено'],['owned','Моя коллекция']].map(function(o){return '<option value="'+o[0]+'"'+((state.shopAvailability||'all')===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+'</select></label><label class="mt-shop-rarity-filter">Редкость<select id="shop-rarity" class="mt-input"><option value="all">Все редкости</option>'+Object.keys(Features.shopRarities).map(function(r){return '<option value="'+r+'"'+(state.shopRarity===r?' selected':'')+'>'+Features.shopRarities[r]+'</option>';}).join('')+'</select></label><label class="mt-shop-rarity-filter">Порядок<select id="shop-sort" class="mt-input">'+[['','По умолчанию'],['rare-first','Сначала редкие'],['common-first','Сначала обычные'],['price-asc','Сначала дешевле'],['price-desc','Сначала дороже']].map(function(o){return '<option value="'+o[0]+'"'+((state.shopSort||'')===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+'</select></label><div class="mt-shop-grid">'+(!items.length?'<p class="mt-feature-hint">По этим фильтрам предметов нет. Попробуй другой выбор.</p>':'')+items.map(function(item){var owned=ownsStyle(item.id),equipped=activeStyle()[item.kind]===item.id;return '<article class="mt-shop-item'+(state.shopPreview===item.id?' previewing':'')+'" data-rarity="'+item.rarity+'"><div class="mt-shop-swatch mt-'+item.id+'">'+(item.image?'<img class="mt-shop-art" src="'+item.image+'" alt="" loading="lazy" />':'<span>'+item.icon+'</span>')+'<span class="mt-rarity-tag">'+Features.shopRarities[item.rarity]+'</span></div><div class="mt-shop-item-body"><small>'+({theme:'ТЕМА ПРОФИЛЯ',frame:'РАМКА АВАТАРА',badge:'ЗНАЧОК'})[item.kind]+'</small><h2>'+item.name+'</h2><p>'+item.desc+'</p><b>'+(equipped?'Применено ✓':owned?'В коллекции':item.price+' ◈')+'</b><div class="mt-shop-card-actions"><button class="mt-ghost-btn" data-shop-preview="'+item.id+'">Примерить</button>'+(owned?'<span class="mt-shop-owned">✓ Уже в коллекции</span>':'<button class="mt-primary-btn" data-shop-purchase="'+item.id+'"'+(balance<item.price?' disabled':'')+'>Купить · '+item.price+' ◈</button>')+'</div></div></article>';}).join('')+'</div></section>';
  }
  function attachShopHandlers(){
    var app=document.getElementById('app');
    function bind(id,fn){var el=document.getElementById(id);if(el)el.addEventListener('click',fn);}
    bind('account-settings-open',openAccountSettings);
    bind('account-settings-back',closeAccountSettings);
    app.querySelectorAll('[data-ui-setting]').forEach(function(el){el.addEventListener('change',function(){uiSettings[el.getAttribute('data-ui-setting')]=el.checked;applyUiSettings();persistKey(UI_SETTINGS_KEY,uiSettings).catch(function(){});});});
    app.querySelectorAll('[data-appearance]').forEach(function(el){el.addEventListener('click',function(){uiSettings.appearance=el.getAttribute('data-appearance');applyUiSettings();persistKey(UI_SETTINGS_KEY,uiSettings).catch(function(){});render();});});
    bind('season-event-open',function(){state.tab='journey';state.journeyUI.section='halloween';render();window.scrollTo(0,0);});
    bind('season-settings-open',openAccountSettings);
    bind('shop-open',function(){state.shopOpen=true;state.shopNotice='';render();window.scrollTo(0,0);});
    bind('shop-back',function(){state.shopOpen=false;state.shopPreview=null;state.shopSet=null;render();window.scrollTo(0,0);});
    bind('shop-set-clear',function(){state.shopSet=null;render();});
    app.querySelectorAll('[data-set-preview]').forEach(function(el){el.addEventListener('click',function(){state.shopSet=el.getAttribute('data-set-preview');state.shopPreview=null;render();document.querySelector('.mt-shop-preview').scrollIntoView({block:'start'});});});
    bind('recap-download',function(){
      var btn=document.getElementById('recap-download'),key=String(state.awardsYear);if(!/^\d{4}$/.test(key)||Number(key)>=new Date().getFullYear())return;btn.disabled=true;btn.textContent='Готовим карточку…';
      Features.createMonthlyCard(recapData(key),displayNick(),key+' · Итоги года').then(function(blob){var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='AM-Tracker-'+key+'.png';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);btn.textContent='Сохранить итог в PNG';}).catch(function(){btn.textContent='Не удалось создать PNG — повторить';}).finally(function(){btn.disabled=false;});
    });
    bind('shop-preview-clear',function(){state.shopPreview=null;render();});
    bind('shop-edit-profile',function(){var item=Features.shopItem(state.shopPreview);state.shopOpen=false;state.shopPreview=null;state.profileEdit=true;state.profileDraft=sanitizeProfile(state.profile);if(item&&ownsStyle(item.id)){state.profileDraft.style=Features.cleanStyle(state.profileDraft.style);state.profileDraft.style[item.kind]=item.id;}render();window.scrollTo(0,0);});
    var availability=document.getElementById('shop-availability');if(availability)availability.addEventListener('change',function(){state.shopAvailability=availability.value;render();});
    var sort=document.getElementById('shop-sort');if(sort)sort.addEventListener('change',function(){state.shopSort=sort.value;render();});
    var rarity=document.getElementById('shop-rarity');if(rarity)rarity.addEventListener('change',function(){state.shopRarity=rarity.value;render();});
    app.querySelectorAll('[data-shop-category]').forEach(function(el){el.addEventListener('click',function(){state.shopCategory=el.getAttribute('data-shop-category');render();});});
    app.querySelectorAll('[data-shop-preview]').forEach(function(el){el.addEventListener('click',function(){state.shopSet=null;state.shopPreview=el.getAttribute('data-shop-preview');state.shopNotice='';render();document.querySelector('.mt-shop-preview').scrollIntoView({block:'start'});});});
    app.querySelectorAll('[data-shop-buy]').forEach(function(el){el.addEventListener('click',function(){buyShopItem(el.getAttribute('data-shop-buy'));render();});});
  }


  var UI_SETTINGS_KEY='manhwa-tracker:ui-settings:v1';
  function openAccountSettings(){
    if(state.accountSettings)return;
    state.settingsReturn={tab:state.tab,scroll:window.scrollY||0};
    state.tab='profile';state.accountSettings=true;state.profileEdit=false;state.profileDraft=null;state.shopOpen=false;render();window.scrollTo(0,0);
  }
  function closeAccountSettings(){
    var previous=state.settingsReturn||{tab:'profile',scroll:0};
    state.accountSettings=false;state.settingsReturn=null;state.acct.confirmDelete=false;state.profileEdit=false;state.profileDraft=null;
    state.tab=previous.tab;render();window.scrollTo(0,previous.scroll);
  }
  var uiSettings={reduceMotion:false,largeText:false,appearance:'auto'};
  function halloweenAppearance(){return uiSettings.appearance==='halloween'||(uiSettings.appearance==='auto'&&Features.halloweenWindow(Date.now()).active);}
  function applyUiSettings(){
    if(document.documentElement){
      document.documentElement.classList.toggle('mt-reduce-motion',uiSettings.reduceMotion);
      document.documentElement.classList.toggle('mt-large-text',uiSettings.largeText);
      document.documentElement.classList.toggle('mt-halloween-site',halloweenAppearance());
    }
  }
  function loadUiSettings(){return readKey(UI_SETTINGS_KEY).then(function(raw){uiSettings={reduceMotion:!!(raw&&raw.reduceMotion),largeText:!!(raw&&raw.largeText),appearance:raw&&['auto','classic','halloween'].includes(raw.appearance)?raw.appearance:'auto'};applyUiSettings();});}
  function renderAppearanceSettings(){return '<section class="mt-settings-card"><h2>Облик приложения</h2><p>Выбери атмосферу для всех разделов. Хэллоуинское оформление доступно и после события. Выбор сохраняется на этом устройстве.</p><div class="mt-appearance-options">'+[['auto','◐','По сезону','Хэллоуин во время ивента, обычный вид после.'],['classic','✦','Классический','Привычная лавандовая палитра и спокойные панели.'],['halloween','☾','Ночь историй','Лунный особняк, медные акценты и свет фонарей.']].map(function(x){return '<button type="button" data-appearance="'+x[0]+'" aria-pressed="'+(uiSettings.appearance===x[0])+'"><span class="mt-appearance-art '+x[0]+'" aria-hidden="true">'+x[1]+'</span><span><strong>'+x[2]+'</strong><small>'+x[3]+'</small></span><b aria-hidden="true">'+(uiSettings.appearance===x[0]?'✓':'')+'</b></button>';}).join('')+'</div></section>';}
  function patchDataHealth(st){
    var el=document.getElementById('data-health');if(!el)return;
    var local=Object.keys(failedWrites).length?'Есть ошибки сохранения':pendingStorageWrites?'Сохранение…':'Все изменения сохранены';
    el.innerHTML='<dl class="mt-data-health"><div><dt>На этом устройстве</dt><dd>'+local+'</dd></div><div><dt>Облако</dt><dd>'+escapeHtml(st.signedIn?acctStatusShort(st):'Не подключено — данные только на этом устройстве')+'</dd></div><div><dt>Ждут отправки</dt><dd>'+(st.signedIn?Number(st.pending)||0:'—')+'</dd></div><div><dt>Последняя синхронизация</dt><dd>'+escapeHtml(st.lastSync?new Date(st.lastSync).toLocaleString('ru-RU'):'Ещё не было')+'</dd></div></dl><p class="mt-feature-hint">Резервная копия — отдельный файл. Облако синхронизирует изменения, в том числе удаления.</p>';
  }
  function previewBackup(filename,parsed,list,skipped,message){
    return new Promise(function(resolve){
      var dialog=document.createElement('dialog');dialog.className='mt-backup-preview';dialog.setAttribute('aria-labelledby','backup-preview-title');
      var entries=list.reduce(function(n,m){return n+Features.journal(m.journal).length;},0);
      var date=parsed.exportedAt&&Number.isFinite(Date.parse(parsed.exportedAt))?new Date(parsed.exportedAt).toLocaleString('ru-RU'):'Дата неизвестна · старый формат';
      dialog.innerHTML='<form method="dialog"><header><span class="mt-section-eyebrow">ПРОВЕРЬ ПЕРЕД ВОССТАНОВЛЕНИЕМ</span><h2 id="backup-preview-title">Содержимое копии</h2><p>'+escapeHtml(filename)+'</p><small>'+escapeHtml(date)+'</small></header><div class="mt-map-summary"><div><strong>'+list.length+'</strong><span>тайтлов</span></div><div><strong>'+entries+'</strong><span>записей глав</span></div><div><strong>'+skipped+'</strong><span>пропущено</span></div></div><p>'+escapeHtml(message)+'</p><details><summary>Тайтлы в файле</summary><ul>'+list.slice(0,100).map(function(m){return '<li>'+escapeHtml(displayTitle(m))+'</li>';}).join('')+'</ul>'+(list.length>100?'<p>И ещё '+(list.length-100)+' тайтлов</p>':'')+'</details><button type="button" id="backup-before-restore" class="mt-ghost-btn">Скачать текущую копию</button><label class="mt-restore-check"><input type="checkbox" id="backup-ack"> Я понимаю, что текущая библиотека будет заменена</label><footer><button class="mt-ghost-btn" value="cancel">Отмена</button><button class="mt-primary-btn" id="backup-accept" value="restore" disabled>Восстановить</button></footer></form>';
      document.body.appendChild(dialog);
      dialog.querySelector('#backup-ack').onchange=function(e){dialog.querySelector('#backup-accept').disabled=!e.target.checked;};
      dialog.querySelector('#backup-before-restore').onclick=function(){var btn=document.getElementById('export-btn');if(btn)btn.click();};
      dialog.addEventListener('close',function(){var accepted=dialog.returnValue==='restore'&&dialog.querySelector('#backup-ack').checked;dialog.remove();resolve(accepted);});
      dialog.showModal();
    });
  }
  function renderBackupSettings(){
    return '<section class="mt-settings-card"><h2>Сохранение и синхронизация</h2><div id="data-health"></div></section><div class="mt-paper mt-profile-backup"><div class="mt-panel-title">Резервная копия</div>' +
      '<div class="mt-backup-text">Сохрани файл с оценками себе на телефон — так данные ' +
      'не потеряются при очистке браузера, и их можно перенести на другое устройство.</div>' +
      '<div class="mt-form-row">' +
      '<button class="mt-ghost-btn" id="export-btn" style="flex:1">⭳ Сохранить в файл</button>' +
      '<button class="mt-ghost-btn" id="import-btn" style="flex:1">⭱ Загрузить из файла</button>' +
      "</div>" +
      '<input type="file" id="import-file-input" accept="application/json" style="display:none" />' +
      "</div>";
  }
  function renderSettings(){
    return '<section class="mt-account-settings mt-settings-page"><button class="mt-ghost-btn" id="account-settings-back">← Назад</button><header><span class="mt-section-eyebrow">ПОД ТЕБЯ</span><h1>Настройки</h1><p>Твой профиль, удобный интерфейс и сохранность коллекции.</p></header>'+
      (state.profileEdit?renderProfileEditor():'<section class="mt-settings-card"><h2>Профиль и оформление</h2><p>Ник, фото, описание и купленные темы, рамки и значки.</p><button class="mt-primary-btn" id="prof-edit">Редактировать профиль</button></section>')+
      renderAppearanceSettings()+'<section class="mt-settings-card"><h2>Интерфейс</h2><p>Эти настройки сохраняются на этом устройстве.</p>'+
      [['reduceMotion','Меньше анимаций','Спокойные переходы без движения.'],['largeText','Крупнее текст','Увеличенные подписи, описания и поля ввода.']].map(function(o){return '<label class="mt-setting-toggle"><span><strong>'+o[1]+'</strong><small>'+o[2]+'</small></span><input type="checkbox" data-ui-setting="'+o[0]+'"'+(uiSettings[o[0]]?' checked':'')+' /></label>';}).join('')+'</section>'+
      '<section class="mt-settings-card mt-settings-account"><h2>Аккаунт</h2>'+(renderAccountStrip()||'<p>Подключение аккаунта сейчас недоступно. Локальные данные остаются на устройстве.</p>')+'</section>'+
      renderErrorBanner()+renderBackupSettings()+'</section>';
  }


  function recapData(key){return Features.monthlyRecap(key,state.manhwas,state.activityLog,state.unlockedAchievements,ACHIEVEMENTS,XP_VALUES,average);}
  function renderAnnualRecap(year){
    if(year>=new Date().getFullYear())return '';var key=String(year),d=recapData(key);
    return '<section class="mt-paper mt-month-recap"><span class="mt-section-eyebrow">ТВОЯ ИСТОРИЯ / ИТОГИ ГОДА</span><h2>Твой '+year+' год в историях</h2><div class="mt-recap-stats">'+[[d.chapters,'глав в дневнике'],[d.finished,'завершено тайтлов'],[d.goals,'выполнено целей'],[d.xp,'XP и монет заработано']].map(function(x){return '<div><strong>'+x[0]+'</strong><span>'+x[1]+'</span></div>';}).join('')+'</div><div class="mt-recap-highlight"><small>ВЫСШАЯ ОЦЕНКА ГОДА</small><strong>'+escapeHtml(d.best?d.best.title:'Пока нет оценённых тайтлов')+'</strong>'+(d.best?'<span>'+Math.round(d.best.score)+' / 100</span>':'')+'</div><div class="mt-recap-highlight"><small>ЛЮБИМАЯ ГЛАВА</small><strong>'+escapeHtml(d.chapterBest?d.chapterBest.title:'Пока нет оценок глав')+'</strong>'+(d.chapterBest?'<span>Глава '+d.chapterBest.chapter+' · '+d.chapterBest.rating+' / 10</span>':'')+'</div><p class="mt-feature-hint">По сохранённой истории: главы учитываются по записям дневника. Старые удалённые записи могут не попасть в итог. При равных оценках показан один из лидеров.</p><button class="mt-primary-btn" id="recap-download">Сохранить итог в PNG</button></section>';
  }
  function renderProfile() {
    if(state.accountSettings)return renderSettings();
    if(state.shopOpen) return renderShop();
    if(state.profileEdit)return '<section class="mt-profile-page mt-profile-studio"><div class="mt-header"><div class="mt-section-eyebrow">ТВОЁ ПРОСТРАНСТВО</div><h1 class="mt-page-title">Студия профиля</h1></div>'+renderProfileEditor()+'</section>';
    var rated = state.manhwas.filter(function (m) { return ratedScore(m) !== null; });
    var overallAvg = rated.length
      ? rated.reduce(function (a, m) { return a + average(m.criteria); }, 0) / rated.length
      : null;

    var html =
      '<section class="mt-profile-page"><div class="mt-header"><div class="mt-section-eyebrow">ИСТОРИЯ ТВОИХ ВПЕЧАТЛЕНИЙ</div><h1 class="mt-page-title">Профиль читателя</h1></div>' + renderProfileHero() + renderErrorBanner() +
      '<div class="mt-list" style="padding-top:16px">' +
      renderShopEntry() +
      renderRankPanel() +
      '<div class="mt-chip-row">' +
      '<div class="mt-chip"><div class="mt-chip-value">' + state.manhwas.length + '</div><div class="mt-chip-label">манхв в списке</div></div>' +
      '<div class="mt-chip"><div class="mt-chip-value" style="color:#C9BFA8">' +
      (overallAvg === null ? "—" : Math.round(overallAvg)) + '</div><div class="mt-chip-label">средняя оценка</div></div>' +
      "</div>";

    // status bar
    var total = state.manhwas.length || 1;
    var track = "";
    var legend = "";
    STATUSES.forEach(function (s) {
      var count = state.manhwas.filter(function (m) { return m.status === s.id; }).length;
      var pct = (count / total) * 100;
      if (pct > 0) track += '<div style="width:' + pct + "%;background:" + s.color + ';" title="' + s.label + '"></div>';
      legend +=
        '<div class="mt-legend-item"><span class="mt-legend-dot" style="background:' + s.color + '"></span>' +
        '<span class="mt-legend-label">' + s.label + '</span><strong>' + count + '</strong></div>';
    });
    html +=
      '<div class="mt-paper"><div class="mt-panel-title">Твоя коллекция</div><p class="mt-profile-caption">Как продвигается чтение</p>' +
      '<div class="mt-status-track">' + track + "</div>" +
      '<div class="mt-status-legend">' + legend + "</div></div>";

    var agg = aggregateCriteria();
    if (agg.length >= 3) {
      html +=
        '<div class="mt-paper mt-radar-panel" style="align-items:flex-start">' +
        '<div class="mt-panel-title">Портрет твоих оценок</div>' +
        '<div style="width:100%;display:flex;justify-content:center">' +
        radarSvg(agg, { fillColor: "#C9BFA8", dotColor: "#C9BFA8" }) + "</div></div>";
    }

    if (agg.length > 0) {
      var bars = agg.slice().sort(function (a, b) { return b.score - a.score; }).map(function (c) {
        return (
          '<div class="mt-bar-row"><span class="mt-bar-name">' + escapeHtml(c.name) + "</span>" +
          '<div class="mt-bar-track"><div class="mt-bar-fill" style="width:' + (c.score / 10) * 100 +
          '%;background:#C9BFA8;"></div></div>' +
          '<span class="mt-bar-value" style="color:#C9BFA8">' + c.score.toFixed(1) + '<small> / 10</small></span></div>'
        );
      }).join("");
      html += '<div class="mt-paper mt-profile-criteria"><div class="mt-panel-title">Что ты ценишь выше всего</div><p class="mt-profile-caption">Средние баллы по оценённым тайтлам</p>' + bars + "</div>";
    }

    var genreStats = {};
    state.manhwas.forEach(function (m) {
      (m.genres || []).forEach(function (g) {
        if (!genreStats[g]) genreStats[g] = { count: 0, sum: 0, rated: 0 };
        genreStats[g].count += 1;
        var av = ratedScore(m);
        if (av !== null) { genreStats[g].sum += av; genreStats[g].rated += 1; }
      });
    });
    var genreNames = Object.keys(genreStats).sort(function (a, b) { return genreStats[b].count - genreStats[a].count; }).slice(0, 8);
    if (genreNames.length > 0) {
      var maxCount = Math.max.apply(null, genreNames.map(function (g) { return genreStats[g].count; }));
      var genreBars = genreNames.map(function (g) {
        var s = genreStats[g];
        var avgScore = s.rated ? s.sum / s.rated : null;
        var color = scoreColor(avgScore);
        return (
          '<div class="mt-bar-row"><span class="mt-bar-name">' + escapeHtml(g) + "</span>" +
          '<div class="mt-bar-track"><div class="mt-bar-fill" style="width:' + (s.count / maxCount) * 100 +
          "%;background:" + color + ';"></div></div>' +
          '<span class="mt-bar-value" style="color:' + color + '">' + s.count + '<small> шт.</small></span></div>'
        );
      }).join("");
      html += '<div class="mt-paper mt-profile-genres"><div class="mt-panel-title">Любимые жанры</div><p class="mt-profile-caption">По количеству тайтлов в коллекции</p>' + genreBars + "</div>";
    }

    var sortedByScore = rated.slice().sort(function (a, b) { return average(b.criteria) - average(a.criteria); });
    var top = sortedByScore.slice(0, 3);
    var bottom = sortedByScore.slice(-3).reverse().filter(function (m) { return top.indexOf(m) === -1; });

    if (top.length > 0) {
      html +=
        '<div class="mt-paper"><div class="mt-panel-title">Твои фавориты</div><p class="mt-profile-caption">Истории с самыми высокими оценками</p>' +
        top.map(miniRowHtml).join("") + "</div>";
    }
    if (bottom.length > 0) {
      html +=
        '<div class="mt-paper"><div class="mt-panel-title">Впечатлили меньше</div><p class="mt-profile-caption">Самые низкие оценки вне топа</p>' +
        bottom.map(miniRowHtml).join("") + "</div>";
    }

    if (state.manhwas.length === 0) {
      html +=
        '<div class="mt-paper mt-empty"><div class="mt-empty-text">Статистика появится, как только добавишь и оценишь первую манхву.</div></div>';
    }

    html += '<button class="mt-paper mt-settings-entry" id="account-settings-open"><span>⚙</span><span><strong>Настройки</strong><small>Профиль, интерфейс, аккаунт и резервная копия</small></span><span aria-hidden="true">→</span></button>';

    html += "</div></section>";
    return html;
  }

  /* ---------- profile (nickname, bio, avatar) & account UI ---------- */

  var PROFILE_STORAGE_KEY = "manhwa-tracker:profile:v1";
  var NICK_MAX = 24;
  var BIO_MAX = 80;
  var AVATAR_PX = 256;
  var AVATAR_MAX_CHARS = 200000;

  var AVATAR_COLORS = [
    ["#5C8AA0", "#7FB4CC"], ["#7A9B8A", "#9FBFAE"], ["#A87C8C", "#D9838F"], ["#8C7FA0", "#B0A0C4"],
    ["#B59B6E", "#E7E3DC"], ["#6478A8", "#8CA0D0"], ["#B0876B", "#D9A98A"], ["#4A4A50", "#8A8A92"]
  ];
  var AVATAR_EMOJIS = ["🦊", "🐱", "🐼", "🐺", "🦉", "🐉", "🌙", "⭐", "🔥", "🌸", "📚", "🎭", "⚔️", "👑", "🍜", "🎧"];

  function emptyProfile() { return { n: "", b: "", a: null }; }

  function avatarColorIndex(c) {
    var n = Math.floor(Number(c));
    return n >= 0 && n < AVATAR_COLORS.length ? n : 0;
  }

  function seedColor(str) {
    str = String(str || "");
    if (!str) return AVATAR_COLORS.length - 1;
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % AVATAR_COLORS.length;
  }

  // Repairs anything that comes from storage, a backup file or the cloud, so a
  // damaged profile can never break the page.
  function sanitizeProfile(p) {
    var out = emptyProfile();
    if (!isPlainObject(p)) return out;
    if (typeof p.n === "string") out.n = p.n.replace(/\s+/g, " ").trim().slice(0, NICK_MAX);
    if (typeof p.b === "string") out.b = p.b.replace(/\s+/g, " ").trim().slice(0, BIO_MAX);
    if (p.style) out.style = Features.cleanStyle(p.style);
    if (p.journey) out.journey = Features.cleanJourney(p.journey);
    if (p.library) out.library=cleanLibraryData(p.library);
    if(Array.isArray(p.outfits)){
      var bytes=0,ids=new Set();out.outfits=[];
      p.outfits.slice(0,6).forEach(function(o){
        if(!isPlainObject(o)||typeof o.id!=='string'||!o.id.trim()||ids.has(o.id.slice(0,80))||typeof o.name!=='string'||!o.name.trim())return;
        var clean={id:o.id.slice(0,80),name:o.name.trim().slice(0,30),style:Features.cleanStyle(o.style),a:sanitizeProfile({a:o.a}).a};
        var size=JSON.stringify(clean).length;if(bytes+size>200000)return;bytes+=size;ids.add(clean.id);out.outfits.push(clean);
      });
    }
    var a = p.a;
    if (isPlainObject(a)) {
      if (a.t === "img" && typeof a.v === "string" && a.v.length <= AVATAR_MAX_CHARS &&
          /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(a.v)) {
        out.a = { t: "img", v: a.v };
      } else if (a.t === "emoji" && AVATAR_EMOJIS.indexOf(a.v) !== -1) {
        out.a = { t: "emoji", v: a.v, c: avatarColorIndex(a.c) };
      } else if (a.t === "letter") {
        out.a = { t: "letter", c: avatarColorIndex(a.c) };
      }
    }
    return out;
  }

  function saveProfile() {
    var pending=persistKey(PROFILE_STORAGE_KEY, state.profile);
    pending.catch(function () {});
    syncPing();
    return pending;
  }

  function loadProfile() {
    return readKey(PROFILE_STORAGE_KEY).then(function (p) {
      if (p) state.profile = sanitizeProfile(p);
    }).catch(function () {});
  }

  // Any element size works: the avatar scales with the font-size of its container.
  function avatarHtml(p, extraClass) {
    var a = p.a;
    var cls = "mt-avatar" + (extraClass ? " " + extraClass : "");
    if (a && a.t === "img") {
      return '<div class="' + cls + '"><img src="' + attrEsc(a.v) + '" alt="" /></div>';
    }
    var nick = p.n || "";
    var ci = a && (a.t === "emoji" || a.t === "letter") ? a.c : seedColor(nick);
    var bg = "background:linear-gradient(135deg," + AVATAR_COLORS[ci].join(",") + ")";
    if (a && a.t === "emoji") {
      return '<div class="' + cls + '" style="' + bg + '"><span class="mt-avatar-emoji">' + escapeHtml(a.v) + "</span></div>";
    }
    var initial = Array.from(nick.trim())[0];
    return '<div class="' + cls + '" style="' + bg + '">' +
      (initial ? '<span class="mt-avatar-letter">' + escapeHtml(initial.toUpperCase()) + "</span>" : ICON_USER) + "</div>";
  }

  // Resizes/crops a chosen photo to a small square JPEG so it stays light enough
  // to live in storage and to sync.
  function processAvatarFile(file, done) {
    if (!file || (file.type && file.type.indexOf("image/") !== 0)) { done(new Error("Выбери файл с изображением.")); return; }
    var url;
    try { url = URL.createObjectURL(file); } catch (e) { done(new Error("Не удалось открыть файл.")); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) throw new Error("empty");
        var side = Math.min(w, h);
        var canvas = document.createElement("canvas");
        canvas.width = AVATAR_PX;
        canvas.height = AVATAR_PX;
        var g = canvas.getContext("2d");
        g.fillStyle = "#1A1A1C"; // transparent PNGs get a dark background instead of black
        g.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
        g.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
        var q = 0.85;
        var out = canvas.toDataURL("image/jpeg", q);
        while (out.length > 90000 && q > 0.45) { q -= 0.1; out = canvas.toDataURL("image/jpeg", q); }
        URL.revokeObjectURL(url);
        done(null, out);
      } catch (e) {
        URL.revokeObjectURL(url);
        done(new Error("Не удалось обработать фото."));
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      done(new Error("Не удалось открыть изображение. Попробуй JPEG или PNG."));
    };
    img.src = url;
  }

  // Google's own "G" mark (multi-colour, as their branding rules require).
  var ICON_GOOGLE =
    '<svg class="mt-google-logo" viewBox="0 0 48 48" aria-hidden="true">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
    "</svg>";

  // Google refuses to show its sign-in page inside an embedded WebView
  // ("disallowed_useragent"), so the button is only offered in a real browser.
  function isEmbeddedWebView() {
    return !!window.AndroidBridge || /; wv\)/.test(navigator.userAgent || "");
  }

  function accountSignedIn() {
    return !!(window.AMSync && window.AMSync.isConfigured() && window.AMSync.isSignedIn());
  }

  // Unlike escapeHtml this also escapes quotes, so it is safe inside value="...".
  function attrEsc(str) {
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function emailPrefix() {
    var st = window.AMSync && window.AMSync.isConfigured() ? window.AMSync.getStatus() : null;
    return st && st.email ? st.email.split("@")[0].slice(0, NICK_MAX) : "";
  }

  function displayNick() {
    return state.profile.n || emailPrefix() || "Гость";
  }

  function formatSyncTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
      ? "сегодня в " + time
      : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + " в " + time;
  }

  function acctStatusShort(st) {
    if (st.phase === "syncing") return "Синхронизация…";
    if (st.pending > 0 && st.phase !== "error" && st.phase !== "offline") return "Есть изменения для отправки";
    if (st.phase === "offline") return "Нет сети";
    if (st.phase === "error") return "Ошибка синхронизации";
    return st.lastSync ? "Синхронизировано " + formatSyncTime(st.lastSync) : "Ещё не синхронизировано";
  }

  function acctStatusDetail(st) {
    var parts = [];
    if (st.phase === "offline") parts.push("Нет соединения с облаком. Отправка продолжится после восстановления сети; состояние локального сохранения показано внизу экрана.");
    if (st.phase === "error" && st.error) parts.push(escapeHtml(st.error));
    if (st.pending > 0 && st.phase !== "syncing") parts.push("Ждут отправки: " + st.pending + ".");
    return parts.join(" ");
  }

  function acctPillClass(st) {
    return "mt-sync-pill " + (st.phase === "syncing" ? "busy" : st.phase === "offline" ? "off" : st.phase === "error" ? "err" : "ok");
  }

  // Repaints only the status widgets, so a form the user is typing into is never re-rendered.
  function patchAcctStatus(st) {
    patchDataStatus();
    var pill = document.getElementById("acct-pill");
    if (pill) pill.className = acctPillClass(st);
    var el = document.getElementById("acct-status");
    if (el) el.textContent = acctStatusShort(st);
    var det = document.getElementById("acct-detail");
    if (det) {
      var t = acctStatusDetail(st);
      det.innerHTML = t;
      det.style.display = t ? "" : "none";
    }
  }

  function joinedLabel() {
    var first = null;
    state.manhwas.forEach(function (m) {
      var t = typeof m.createdAt === "number" ? m.createdAt : getCreatedAt(m);
      if (typeof t === "number" && t > 0 && (first === null || t < first)) first = t;
    });
    if (first === null) return "";
    // Formatting with a day gives the month in the genitive ("с сентября 2025"), then the day is cut off.
    return "Читает с " + new Date(first).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
      .replace(/^\d+\s+/, "").replace(/\s*г\.$/, "");
  }

  function renderProfileHero() {
    if (state.profileEdit) return renderProfileEditor();
    var p = state.profile;
    var style = activeStyle();
    var rank = RANKS[rankIndexForXp(state.totalXp)];
    var shown = { n: p.n || (accountSignedIn() ? emailPrefix() : ""), a: p.a };
    var glow = p.a && p.a.t === "img" ? rank.gradient : AVATAR_COLORS[p.a && p.a.t !== "img" ? p.a.c : seedColor(shown.n)];
    var bio = p.b
      ? '<div class="mt-hero-bio">' + escapeHtml(p.b) + "</div>"
      : '';
    var since = joinedLabel();
    return (
      '<div class="mt-hero'+styleClasses(style)+'">' +
      '<div class="mt-hero-glow" style="background:radial-gradient(120% 90% at 0% 0%,' + glow[0] + "59,transparent 60%)," +
      "radial-gradient(90% 80% at 100% 100%," + glow[glow.length - 1] + '33,transparent 60%)"></div>' +
      '<button class="mt-hero-edit" id="prof-edit" aria-label="Редактировать профиль">✎</button>' +
      '<div class="mt-hero-main">' +
      '<button class="mt-hero-avatar-ring" id="prof-avatar-open" aria-label="Сменить аватар" style="background:linear-gradient(135deg,' +
      rank.gradient.join(",") + ')">' + avatarHtml(shown) + "</button>" +
      '<div class="mt-hero-id">' +
      '<div class="mt-hero-nick">' + escapeHtml(displayNick()) + "</div>" + styleBadge(style) + bio + renderRankBadge() +
      (since ? '<div class="mt-hero-since">' + escapeHtml(since) + "</div>" : "") +
      "</div></div>" +
      "</div>"
    );
  }


  function renderOutfits(d){
    return '<details class="mt-outfits mt-editor-fold" data-editor-section="outfits"><summary>Сохранённые образы <small>'+((d.outfits||[]).length)+' / 6</small></summary><div class="mt-editor-label">СОХРАНЁННЫЕ ОБРАЗЫ</div><p class="mt-feature-hint">Аватар, тема, рамка и значок одним нажатием. До 6 образов. Изменения сохраняются кнопкой «Сохранить» внизу.</p><div class="mt-outfit-save"><input class="mt-input" id="outfit-name" maxlength="30" placeholder="Например, Ночной читатель" aria-label="Название образа" /><button type="button" class="mt-ghost-btn" id="outfit-save">Запомнить образ</button></div><div class="mt-outfit-list">'+(d.outfits||[]).map(function(o){return '<div><button type="button" class="mt-ghost-btn" data-outfit-use="'+escapeHtml(o.id)+'">'+escapeHtml(o.name)+'</button><button type="button" class="mt-icon-btn" data-outfit-delete="'+escapeHtml(o.id)+'" aria-label="Удалить образ '+escapeHtml(o.name)+'">×</button></div>';}).join('')+'</div></details>';
  }
  function renderOwnedStyles(d) {
    var style=Features.cleanStyle(d.style);Object.keys(style).forEach(function(k){if(!ownsStyle(style[k]))style[k]='';});
    return '<section class="mt-owned-styles"><div class="mt-editor-label">МОЯ КОЛЛЕКЦИЯ</div><p class="mt-feature-hint">Выбери купленное оформление. Оно применится после сохранения профиля.</p>'+
      '<div class="mt-shop-preview'+styleClasses(style)+'"><div class="mt-shop-preview-person"><div class="mt-shop-avatar">'+avatarHtml(d)+'</div><div><strong>'+escapeHtml(d.n||displayNick())+'</strong>'+styleBadge(style)+'</div></div></div>'+
      [['theme','Тема'],['frame','Рамка'],['badge','Значок']].map(function(pair){
        var owned=Features.shopItems.filter(function(i){return i.kind===pair[0]&&ownsStyle(i.id);});
        return '<div class="mt-style-category"><h3>'+pair[1]+' <small>'+owned.length+' в коллекции</small></h3><div class="mt-style-choices">'+[{id:'',name:'Базовое',kind:pair[0],icon:'○'}].concat(owned).map(function(item){return '<button type="button" class="mt-style-choice" data-style-kind="'+pair[0]+'" data-style-value="'+item.id+'" aria-pressed="'+(style[pair[0]]===item.id)+'"><span class="mt-style-thumb mt-shop-swatch '+(item.id?'mt-'+pair[0]+'-'+item.id.replace(pair[0]+'-',''):'')+'">'+(item.image?'<img src="'+item.image+'" alt="" loading="lazy"/>':'<span>'+ (item.icon||'✦')+'</span>')+'</span><strong>'+escapeHtml(item.name)+'</strong>'+(item.rarity?'<small>'+Features.shopRarities[item.rarity]+'</small>':'')+'</button>';}).join('')+'</div><label class="mt-sr-only">'+pair[1]+'<select class="mt-input" data-profile-style="'+pair[0]+'"><option value="">Базовое оформление</option>'+owned.map(function(i){return '<option value="'+i.id+'"'+(style[pair[0]]===i.id?' selected':'')+'>'+escapeHtml(i.name)+' · '+Features.shopRarities[i.rarity]+'</option>';}).join('')+'</select></label></div>';
      }).join('')+'</section>';
  }

  function renderProfileEditor() {
    var d = state.profileDraft;
    var emojiSel = d.a && d.a.t === "emoji" ? d.a.v : null;
    var colorSel = d.a && (d.a.t === "emoji" || d.a.t === "letter") ? d.a.c : (d.a && d.a.t === "img" ? -1 : seedColor(d.n));
    var emojis =
      '<button class="mt-emoji-btn' + (d.a && d.a.t === "letter" ? " sel" : "") + '" data-letter="1" aria-label="Буква">Aa</button>' +
      AVATAR_EMOJIS.map(function (e) {
        return '<button class="mt-emoji-btn' + (e === emojiSel ? " sel" : "") + '" data-emoji="' + attrEsc(e) + '">' + e + "</button>";
      }).join("");
    var swatches = AVATAR_COLORS.map(function (c, i) {
      return '<button class="mt-swatch' + (i === colorSel ? " sel" : "") + '" data-color="' + i +
        '" aria-label="Цвет ' + (i + 1) + '" style="background:linear-gradient(135deg,' + c.join(",") + ')"></button>';
    }).join("");
    return (
      '<div class="mt-hero mt-editor">' +
      '<div class="mt-editor-title">РЕДАКТИРОВАНИЕ ПРОФИЛЯ</div>' +
      '<div class="mt-editor-avatar">' +
      '<div class="mt-editor-preview" id="prof-preview">' + avatarHtml(d) + "</div>" +
      '<div class="mt-editor-photo">' +
      '<button class="mt-ghost-btn" id="prof-photo-btn">📷 Загрузить фото</button>' +
      (d.a && d.a.t === "img" ? '<button class="mt-ghost-btn" id="prof-photo-clear">Убрать фото</button>' : "") +
      "</div></div>" +
      '<input type="file" id="prof-photo-input" accept="image/*" style="display:none" />' +
      '<details class="mt-editor-fold" data-editor-section="avatar"><summary>Эмодзи и цвет аватара</summary><div class="mt-editor-label">Выбери эмодзи</div><div class="mt-emoji-grid">' + emojis + "</div>" +
      '<div class="mt-editor-label">Цвет</div><div class="mt-swatch-row">' + swatches + "</div></details>" +
      '<div class="mt-editor-label">Ник</div>' +
      '<input class="mt-input" id="prof-nick" maxlength="' + NICK_MAX + '" placeholder="Как тебя называть?" value="' + attrEsc(d.n) + '" autocomplete="nickname" />' +
      '<div class="mt-editor-label">О себе</div>' +
      '<input class="mt-input" id="prof-bio" maxlength="' + BIO_MAX + '" placeholder="Например: читаю всё, что с драконами" value="' + attrEsc(d.b) + '" />' +
      renderOwnedStyles(d) + renderOutfits(d) +
      '<div class="mt-acct-msg err" id="prof-msg"></div>' +
      '<div class="mt-form-row">' +
      '<button class="mt-ghost-btn" id="prof-cancel" style="flex:1">Отмена</button>' +
      '<button class="mt-primary-btn" id="prof-save">Сохранить</button>' +
      "</div></div>"
    );
  }

  function renderAccountStrip() {
    var S = window.AMSync;
    if (!S || !S.isConfigured()) return "";
    var st = S.getStatus();
    var a = state.acct;
    var html = '<div class="mt-hero-acct">';

    if (st.signedIn) {
      html +=
        '<div class="mt-acct-top"><span class="' + acctPillClass(st) + '" id="acct-pill"><i class="mt-sync-dot"></i>' +
        '<span id="acct-status">' + escapeHtml(acctStatusShort(st)) + "</span></span></div>" +
        '<div class="mt-acct-email">' + escapeHtml(st.email) + "</div>";
      var det = acctStatusDetail(st);
      html += '<div class="mt-acct-detail" id="acct-detail"' + (det ? "" : ' style="display:none"') + ">" + det + "</div>";
      if (!st.verified) {
        html += '<div class="mt-acct-detail">Почта не подтверждена — открой письмо от Firebase и перейди по ссылке. ' +
          "Иначе не получится восстановить пароль, если в адресе опечатка.</div>";
      }
      html +=
        '<div class="mt-form-row">' +
        '<button class="mt-ghost-btn" id="acct-sync" style="flex:1">Синхронизировать</button>' +
        '<button class="mt-ghost-btn" id="acct-signout" style="flex:1">Выйти</button>' +
        "</div>";
      if (a.confirmDelete) {
        var needPass = st.hasPassword !== false;
        html +=
          '<div class="mt-acct-detail" style="margin-top:14px">Аккаунт и все данные в облаке будут удалены навсегда. ' +
          "Данные на этом устройстве останутся. " +
          (needPass ? "Для подтверждения введи пароль." : "Для подтверждения нужно ещё раз войти через Google.") + "</div>" +
          (needPass ? '<input class="mt-input" type="password" id="acct-delete-pass" placeholder="Пароль" autocomplete="current-password" />' : "") +
          '<div class="mt-form-row">' +
          '<button class="mt-ghost-btn" id="acct-delete-cancel" style="flex:1">Отмена</button>' +
          '<button class="mt-ghost-btn" id="acct-delete-confirm" style="flex:1;color:#D9838F">Удалить навсегда</button>' +
          "</div>";
      } else {
        html += '<button class="mt-acct-link" id="acct-delete">Удалить аккаунт</button>';
      }
    } else if (!a.open) {
      html +=
        '<div class="mt-cta">' +
        '<div class="mt-cta-text"><div class="mt-cta-title">Войди в аккаунт</div>' +
        '<div class="mt-cta-sub">Оценки и прогресс будут на всех твоих устройствах</div></div>' +
        '<button class="mt-primary-btn mt-cta-btn" id="acct-open">Войти</button>' +
        "</div>";
    } else {
      var signup = a.mode === "signup";
      if (!isEmbeddedWebView()) {
        html +=
          '<button class="mt-google-btn" id="acct-google">' + ICON_GOOGLE + "<span>Продолжить с Google</span></button>" +
          '<div class="mt-or"><span>или по почте</span></div>';
      }
      html +=
        '<div class="mt-acct-tabs">' +
        '<button class="mt-ghost-btn mt-acct-tab' + (signup ? "" : " active") + '" id="acct-mode-signin">Вход</button>' +
        '<button class="mt-ghost-btn mt-acct-tab' + (signup ? " active" : "") + '" id="acct-mode-signup">Регистрация</button>' +
        "</div>" +
        '<input class="mt-input" type="email" id="acct-email" placeholder="Почта" value="' + attrEsc(a.email) +
        '" autocomplete="email" autocapitalize="none" spellcheck="false" />' +
        '<input class="mt-input" type="password" id="acct-pass" style="margin-top:8px" placeholder="' +
        (signup ? "Пароль (минимум 8 символов)" : "Пароль") + '" autocomplete="' + (signup ? "new-password" : "current-password") + '" />' +
        '<div class="mt-form-row"><button class="mt-primary-btn" id="acct-submit">' + (signup ? "Создать аккаунт" : "Войти") + "</button></div>" +
        '<div class="mt-acct-links">' +
        (signup ? "" : '<button class="mt-acct-link" id="acct-forgot">Забыл пароль</button>') +
        '<button class="mt-acct-link" id="acct-close">Свернуть</button></div>';
    }

    var msg = a.error || a.info;
    html += '<div class="mt-acct-msg ' + (a.error ? "err" : "ok") + '" id="acct-msg">' + (msg ? escapeHtml(msg) : "") + "</div>";
    return html + "</div>";
  }

  function setAcctMsg(text, isError) {
    state.acct.error = isError ? text : "";
    state.acct.info = isError ? "" : text;
    var el = document.getElementById("acct-msg");
    if (el) {
      el.textContent = text || "";
      el.className = "mt-acct-msg " + (isError ? "err" : "ok");
    }
  }

  function attachAcctHandlers() {
    var S = window.AMSync;
    if (!S || !S.isConfigured()) return;
    var a = state.acct;
    var $ = function (id) { return document.getElementById(id); };
    var readEmail = function () { var e = $("acct-email"); if (e) a.email = e.value.trim(); return a.email; };

    // Runs an auth action while keeping the typed values on screen: only the
    // button and the message line are touched, the form is not re-rendered.
    function run(btn, busyText, task, onOk) {
      var label = btn.innerHTML; // innerHTML, so buttons with an icon get it back
      btn.disabled = true;
      btn.textContent = busyText;
      setAcctMsg("", false);
      task().then(function (result) {
        btn.disabled = false;
        btn.innerHTML = label;
        onOk(result);
      }, function (e) {
        btn.disabled = false;
        btn.innerHTML = label;
        setAcctMsg(e && e.message ? e.message : "Что-то пошло не так.", true);
      });
    }

    var open = $("acct-open");
    if (open) open.addEventListener("click", function () {
      a.open = true;
      setAcctMsg("", false);
      if (S.preload) S.preload(); // load the sign-in code now, so the Google window can open instantly on the next tap
      render();
    });
    var close = $("acct-close");
    if (close) close.addEventListener("click", function () { readEmail(); a.open = false; setAcctMsg("", false); render(); });

    var signinTab = $("acct-mode-signin"), signupTab = $("acct-mode-signup");
    if (signinTab) signinTab.addEventListener("click", function () { readEmail(); a.mode = "signin"; setAcctMsg("", false); render(); });
    if (signupTab) signupTab.addEventListener("click", function () { readEmail(); a.mode = "signup"; setAcctMsg("", false); render(); });

    var googleBtn = $("acct-google");
    if (googleBtn) googleBtn.addEventListener("click", function () {
      run(googleBtn, "Открываю Google…", function () { return S.signInWithGoogle(); }, function (res) {
        // No nickname yet? Take the name from the Google account.
        if (!state.profile.n && res && res.displayName) {
          var nick = sanitizeProfile({ n: res.displayName }).n;
          if (nick) { state.profile.n = nick; saveProfile(); }
        }
        a.email = ""; a.info = ""; a.error = ""; a.open = false; render();
      });
    });

    var submit = $("acct-submit");
    function doSubmit() {
      var email = readEmail();
      var pass = $("acct-pass") ? $("acct-pass").value : "";
      if (!email) { setAcctMsg("Введи почту.", true); return; }
      if (!pass) { setAcctMsg("Введи пароль.", true); return; }
      if (a.mode === "signup" && pass.length < 8) { setAcctMsg("Пароль — минимум 8 символов.", true); return; }
      var signup = a.mode === "signup";
      run(submit, signup ? "Создаю…" : "Вхожу…",
        function () { return signup ? S.signUp(email, pass) : S.signIn(email, pass); },
        function () {
          // No nickname yet? Start from the part of the address before the "@".
          // (If the account already has a profile, the first sync replaces this.)
          if (!state.profile.n) {
            state.profile.n = email.split("@")[0].slice(0, NICK_MAX);
            saveProfile();
          }
          a.email = ""; a.info = ""; a.error = ""; a.open = false; render();
        });
    }
    if (submit) submit.addEventListener("click", doSubmit);
    var passInput = $("acct-pass");
    if (passInput) passInput.addEventListener("keydown", function (e) { if (e.key === "Enter") doSubmit(); });

    var forgot = $("acct-forgot");
    if (forgot) forgot.addEventListener("click", function () {
      var email = readEmail();
      if (!email) { setAcctMsg("Введи почту, на которую придёт письмо для сброса пароля.", true); return; }
      run(forgot, "Отправляю…", function () { return S.resetPassword(email); },
        function () { setAcctMsg("Письмо для сброса пароля отправлено на " + email + ".", false); });
    });

    var syncBtn = $("acct-sync");
    if (syncBtn) syncBtn.addEventListener("click", function () {
      run(syncBtn, "Синхронизирую…", function () { return S.syncNow(); }, function () {});
    });

    var signout = $("acct-signout");
    if (signout) signout.addEventListener("click", function () {
      run(signout, "Выхожу…", function () { return S.signOut(); },
        function () { a.info = "Ты вышел. Данные остались на этом устройстве."; a.error = ""; render(); });
    });

    var del = $("acct-delete");
    if (del) del.addEventListener("click", function () { a.confirmDelete = true; setAcctMsg("", false); render(); });
    var delCancel = $("acct-delete-cancel");
    if (delCancel) delCancel.addEventListener("click", function () { a.confirmDelete = false; setAcctMsg("", false); render(); });
    var delConfirm = $("acct-delete-confirm");
    if (delConfirm) delConfirm.addEventListener("click", function () {
      var passEl = $("acct-delete-pass"); // absent for Google-only accounts
      var pass = passEl ? passEl.value : "";
      if (passEl && !pass) { setAcctMsg("Введи пароль для подтверждения.", true); return; }
      run(delConfirm, "Удаляю…", function () { return S.deleteAccount(pass); },
        function () { a.confirmDelete = false; a.info = "Аккаунт удалён. Данные остались на этом устройстве."; a.error = ""; render(); });
    });
  }

  function attachProfileHandlers() {
    var $ = function (id) { return document.getElementById(id); };
    var appEl = $("app");

    var openEditor = function () {
      state.profileEdit = true;
      state.profileDraft = sanitizeProfile(state.profile);
      render();
      window.scrollTo(0, 0);
    };
    var editBtn = $("prof-edit"), avatarBtn = $("prof-avatar-open");
    if (editBtn) editBtn.addEventListener("click", openEditor);
    if (avatarBtn) avatarBtn.addEventListener("click", openEditor);
    if (!state.profileEdit || !state.profileDraft) return;

    var d = state.profileDraft;
    var readText = function () {
      var n = $("prof-nick"), b = $("prof-bio");
      if (n) d.n = n.value;
      if (b) d.b = b.value;
    };
    appEl.querySelectorAll('[data-profile-style]').forEach(function(el){el.addEventListener('change',function(){
      readText();var kind=el.getAttribute('data-profile-style'),item=Features.shopItem(el.value);
      if(el.value&&(!item||item.kind!==kind||!ownsStyle(item.id)))return;
      d.style=Features.cleanStyle(d.style);d.style[kind]=el.value;render();
    });});
    var refreshPreview = function () {
      var el = $("prof-preview");
      if (el) el.innerHTML = avatarHtml(d);
    };
    var setMsg = function (t) { var m = $("prof-msg"); if (m) m.textContent = t || ""; };
    var outfitSave=$('outfit-save');if(outfitSave)outfitSave.addEventListener('click',function(){
      readText();var name=$('outfit-name').value.trim();if(!name){setMsg('Дай образу название.');return;}
      var list=(d.outfits||[]).slice();if(list.length>=6){setMsg('Сохранено 6 образов. Удали один, чтобы добавить новый.');return;}
      var style=Features.cleanStyle(d.style);Object.keys(style).forEach(function(k){if(!ownsStyle(style[k]))style[k]='';});
      list.push({id:uid(),name:name.slice(0,30),style:style,a:d.a?JSON.parse(JSON.stringify(d.a)):null});
      if(JSON.stringify(list).length>200000){setMsg('В образах слишком много фотографий. Удали один из старых образов или выбери эмодзи.');return;}
      d.outfits=list;render();
    });
    appEl.querySelectorAll('[data-outfit-use]').forEach(function(el){el.addEventListener('click',function(){
      readText();var o=(d.outfits||[]).find(function(o){return o.id===el.getAttribute('data-outfit-use');});if(!o)return;
      var style=Features.cleanStyle(o.style);Object.keys(style).forEach(function(k){if(!ownsStyle(style[k]))style[k]='';});
      d.style=style;d.a=o.a?JSON.parse(JSON.stringify(o.a)):null;render();
    });});
    appEl.querySelectorAll('[data-outfit-delete]').forEach(function(el){el.addEventListener('click',function(){readText();d.outfits=(d.outfits||[]).filter(function(o){return o.id!==el.getAttribute('data-outfit-delete');});render();});});
    var seedFor = function () { return d.a && (d.a.t === "emoji" || d.a.t === "letter") ? d.a.c : seedColor(d.n); };

    var nick = $("prof-nick"), bio = $("prof-bio");
    if (nick) nick.addEventListener("input", function () {
      readText();
      if (!d.a || d.a.t === "letter") refreshPreview(); // the letter avatar follows the nickname
    });
    if (bio) bio.addEventListener("input", readText);

    appEl.querySelectorAll("[data-emoji]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        readText();
        d.a = { t: "emoji", v: btn.getAttribute("data-emoji"), c: seedFor() };
        render();
      });
    });
    appEl.querySelectorAll("[data-letter]").forEach(function (btn) {
      btn.addEventListener("click", function () { readText(); d.a = { t: "letter", c: seedFor() }; render(); });
    });
    appEl.querySelectorAll("[data-color]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        readText();
        var c = Number(btn.getAttribute("data-color"));
        d.a = d.a && d.a.t === "emoji" ? { t: "emoji", v: d.a.v, c: c } : { t: "letter", c: c };
        render();
      });
    });

    var photoBtn = $("prof-photo-btn"), photoInput = $("prof-photo-input");
    if (photoBtn && photoInput) photoBtn.addEventListener("click", function () { photoInput.click(); });
    if (photoInput) photoInput.addEventListener("change", function () {
      var file = photoInput.files && photoInput.files[0];
      if (!file) return;
      readText();
      setMsg("");
      processAvatarFile(file, function (err, dataUrl) {
        if (err) { setMsg(err.message); return; }
        d.a = { t: "img", v: dataUrl };
        render();
      });
    });
    var photoClear = $("prof-photo-clear");
    if (photoClear) photoClear.addEventListener("click", function () { readText(); d.a = null; render(); });

    var cancel = $("prof-cancel");
    if (cancel) cancel.addEventListener("click", function () {
      state.profileEdit = false;
      state.profileDraft = null;
      render();
      window.scrollTo(0, 0); // the editor is taller than the card: bring the result back into view
    });
    var save = $("prof-save");
    var saveEditor = async function () {
      if (save.disabled) return;
      readText();
      save.disabled = true; save.textContent = 'Сохраняю…';
      state.profile = sanitizeProfile(d);
      try {
        await saveProfile();
        state.profileEdit = false; state.profileDraft = null;
        render(); window.scrollTo(0, 0);showToast('Профиль сохранён');
        return true;
      } catch (err) {
        save.disabled = false; save.textContent = 'Сохранить';
        setMsg('Не удалось сохранить профиль. Проверь свободное место и повтори сохранение.');return false;
      }
    };
    usability.saveEditor=saveEditor;
    if (save) save.addEventListener("click", saveEditor);

  }

  /* Library organisation, reading passes and personal showcase. */
  var libraryUI={collection:'',bulk:false,selected:[],compare:false,compareIds:[]};
  var lastUndo=null;
  function cleanLibraryData(raw){
    raw=isPlainObject(raw)?raw:{};
    var ids=new Set(),collections=(Array.isArray(raw.collections)?raw.collections:[]).filter(function(c){if(!c||typeof c.id!=='string'||!c.id||c.id.length>80||ids.has(c.id)||typeof c.name!=='string'||!c.name.trim())return false;ids.add(c.id);return true;}).slice(0,40).map(function(c){return {id:c.id,name:c.name.trim().slice(0,40)};});
    var used={},trash=(Array.isArray(raw.trash)?raw.trash:[]).slice(0,20).map(function(t){if(!t||!Number.isFinite(t.ts))return null;var m=sanitizeImportedManhwa(t.title,used);return m?{ts:t.ts,title:m}:null;}).filter(Boolean);
    var show=isPlainObject(raw.showcase)?raw.showcase:{};
    return {collections:collections,trash:trash,showcase:{titles:(Array.isArray(show.titles)?show.titles:[]).slice(0,3).map(function(id){return typeof id==='string'?id:'';}),achievement:typeof show.achievement==='string'?show.achievement:'',item:typeof show.item==='string'?show.item:''}};
  }
  function libraryData(){return cleanLibraryData(state.profile.library);}
  function currentRun(m){return Number.isInteger(m.readingRun)&&m.readingRun>0?m.readingRun:1;}
  function runJournal(m,run){return Features.journal(m.journal).filter(function(e){return (e.run||1)===(run||currentRun(m));});}
  function saveLibraryData(d){state.profile.library=d;saveProfile();}
  function moveToTrash(ids){
    var d=libraryData(),titles=state.manhwas.filter(function(m){return ids.includes(m.id);});
    if(!titles.length)return false;
    var next=d.trash.filter(function(t){return !ids.includes(t.title.id);}).concat(titles.map(function(m){return {ts:Date.now(),title:JSON.parse(JSON.stringify(m))};}));
    var profile=Object.assign({},state.profile,{library:Object.assign({},d,{trash:next})});
    if(next.length>20||JSON.stringify(profile).length>440000){state.error='Корзина заполнена. Восстанови или удали из неё старые тайтлы, затем повтори.';return false;}
    d.trash=next;saveLibraryData(d);lastUndo={kind:'titles',ids:titles.map(function(m){return m.id;})};
    return true;
  }
  function restoreTitles(ids){
    var d=libraryData(),restored=[];
    d.trash=d.trash.filter(function(t){
      if(!ids.includes(t.title.id))return true;
      if(findManhwa(t.title.id))return true;
      var m=sanitizeImportedManhwa(t.title,{});if(!m)return true;
      m.updatedAt=Date.now();state.manhwas.push(m);restored.push(m.id);return false;
    });
    saveLibraryData(d);save();if(restored.length)lastUndo=null;render();
  }
  function extrasUndoHtml(){
    if(!lastUndo)return '';
    return '<div class="mt-extras-undo" role="status"><span>'+(lastUndo.kind==='titles'?'Тайтл перемещён в корзину':'Запись главы '+lastUndo.entry.chapter+' удалена · отмена доступна до перезагрузки')+'</span><button class="mt-ghost-btn" id="extras-undo">Отменить</button><button class="mt-ghost-btn" id="extras-dismiss" aria-label="Скрыть уведомление">×</button></div>';
  }
  function renderLibraryTools(list,menuOnly){
    var d=libraryData();
    libraryUI.selected=libraryUI.selected.filter(function(id){return !!findManhwa(id);});
    var options=d.collections.map(function(c){return '<option value="'+escapeHtml(c.id)+'"'+(libraryUI.collection===c.id?' selected':'')+'>'+escapeHtml(c.name)+'</option>';}).join('');
    var shelf='<nav class="mt-shelf-strip" aria-label="Коллекции">'+d.collections.map(function(c){return '<button class="mt-ghost-btn" data-shelf="'+escapeHtml(c.id)+'" aria-pressed="'+(libraryUI.collection===c.id)+'">'+escapeHtml(c.name)+'</button>';}).join('')+'</nav>';
    var html='<details class="mt-library-menu"'+(libraryUI.menuOpen?' open':'')+'><summary aria-label="Ещё: действия библиотеки"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg><span>Ещё</span></summary><div class="mt-library-menu-content"><span class="mt-section-eyebrow">МОЯ БИБЛИОТЕКА</span><div class="mt-menu-actions"><button class="mt-ghost-btn" id="bulk-toggle">'+(libraryUI.bulk?'Завершить выбор':'Выбрать несколько')+'</button><button class="mt-ghost-btn" id="compare-open">Сравнить тайтлы</button></div><details class="mt-collection-tools"'+(libraryUI.collectionsOpen?' open':'')+'><summary>Управление коллекциями · '+d.collections.length+'</summary><form id="collection-create" class="mt-tools-row"><input class="mt-input" id="collection-name" maxlength="40" required placeholder="Например, Перечитать" aria-label="Название коллекции"/><button class="mt-ghost-btn">Создать</button></form>'+d.collections.map(function(c){return '<div class="mt-collection-manage"><input class="mt-input" data-collection-name="'+escapeHtml(c.id)+'" value="'+escapeHtml(c.name)+'" maxlength="40" aria-label="Название коллекции"/><button class="mt-ghost-btn" data-collection-rename="'+escapeHtml(c.id)+'">Сохранить</button><button class="mt-ghost-btn" data-collection-delete="'+escapeHtml(c.id)+'" aria-label="Удалить коллекцию '+escapeHtml(c.name)+'">×</button></div>';}).join('')+'</details>';
    var bulk='';if(libraryUI.bulk)bulk+='<aside class="mt-bulk-dock"><details'+(libraryUI.bulkOpen?' open':'')+'><summary>Выбрано: '+libraryUI.selected.length+' · Действия ▴</summary><div class="mt-bulk-panel"><div class="mt-tools-row"><button class="mt-ghost-btn" id="bulk-all">Выбрать видимые ('+list.length+')</button><button class="mt-ghost-btn" id="bulk-none">Снять выбор</button></div><label>Статус<select id="bulk-status" class="mt-input">'+STATUSES.map(function(s){return '<option value="'+s.id+'">'+s.label+'</option>';}).join('')+'</select></label><button class="mt-ghost-btn" id="bulk-status-apply">Применить статус</button><label>Жанр<input id="bulk-genre" class="mt-input" maxlength="50" placeholder="Например, Фэнтези"/></label><button id="bulk-genre-apply" class="mt-ghost-btn">Добавить жанр</button><label>Коллекция<select class="mt-input" id="bulk-collection"><option value="">Выбери коллекцию</option>'+options+'</select></label><div class="mt-tools-row"><button class="mt-ghost-btn" id="bulk-collection-add">Добавить</button><button class="mt-ghost-btn" id="bulk-collection-remove">Убрать</button></div><button class="mt-ghost-btn" id="bulk-trash">В корзину</button></div></details><button class="mt-ghost-btn" id="bulk-done">Готово</button></aside>';
    html+='<details class="mt-trash"'+(libraryUI.trashOpen?' open':'')+'><summary>Корзина · '+d.trash.length+' / 20</summary><p class="mt-feature-hint">Тайтлы хранятся до восстановления или удаления вручную. Они не участвуют в статистике библиотеки.</p>'+d.trash.slice().reverse().map(function(t){var conflict=!!findManhwa(t.title.id);return '<article><strong>'+escapeHtml(displayTitle(t.title))+'</strong><small>'+new Date(t.ts).toLocaleDateString('ru-RU')+'</small><div class="mt-tools-row"><button class="mt-ghost-btn" data-trash-restore="'+escapeHtml(t.title.id)+'"'+(conflict?' disabled':'')+'>'+(conflict?'Уже в библиотеке':'Восстановить')+'</button><button class="mt-ghost-btn" data-trash-delete="'+escapeHtml(t.title.id)+'">Удалить навсегда</button></div></article>';}).join('')+'</details></div></details>';
    if(menuOnly)return html;
    return (d.collections.length?'<section class="mt-library-tools">'+shelf+(libraryUI.collection?'<p class="mt-collection-filter-hint">Нажми на выбранную коллекцию ещё раз, чтобы снять фильтр.</p>':'')+'</section>':'')+bulk;
  }
  function renderTitleTools(m){m=findManhwa(m.id)||m;
    var d=libraryData(),run=currentRun(m);
    return '<section class="mt-title-tools mt-paper"><details><summary>Коллекции и перечитывание</summary><div class="mt-title-collections">'+(d.collections.length?d.collections.map(function(c){return '<label><input type="checkbox" data-title-collection="'+escapeHtml(c.id)+'" data-title-id="'+escapeHtml(m.id)+'"'+((m.collectionIds||[]).includes(c.id)?' checked':'')+'/> '+escapeHtml(c.name)+'</label>';}).join(''):'<p class="mt-feature-hint">Создай коллекцию в библиотеке, затем добавь сюда тайтл.</p>')+'</div><p>Чтение №'+run+'. Новый проход начнётся с главы 0. Предыдущие записи и оценки останутся в истории.</p><button class="mt-ghost-btn" data-reread="'+escapeHtml(m.id)+'"'+(run>=10000?' disabled':'')+'>Начать перечитывание</button>'+renderReadingHistory(m)+'</details></section>';
  }
  function renderReadingHistory(m){
    var run=currentRun(m);if(run===1)return '';
    var passes=Array.from(new Set(Features.journal(m.journal).map(function(e){return e.run||1;}).concat((m.readingRuns||[]).map(function(r){return r.run;})))).filter(function(n){return n<run;}).sort(function(a,b){return b-a;});
    return '<div class="mt-reading-history"><h3>Предыдущие прочтения</h3>'+passes.map(function(n){
      var snapshot=(m.readingRuns||[]).find(function(r){return r.run===n;}),entries=runJournal(m,n),scores=entries.filter(function(e){return e.rating;}),avg=scores.length?scores.reduce(function(s,e){return s+e.rating;},0)/scores.length:null,current=runJournal(m).filter(function(e){return e.rating;}),now=current.length?current.reduce(function(s,e){return s+e.rating;},0)/current.length:null;
      return '<details><summary>Чтение №'+n+' · '+entries.length+' записей</summary>'+(snapshot?'<p>Прочитано до главы '+snapshot.chapter+' · Оценка тайтла на тот момент: '+(snapshot.score===null?'—':Math.round(snapshot.score)+'/100')+'</p>':'')+'<p>Средняя оценка глав: '+(avg===null?'—':avg.toFixed(1)+'/10')+' · Сейчас: '+(now===null?'—':now.toFixed(1)+'/10')+'</p>'+entries.slice().sort(function(a,b){return a.chapter-b.chapter;}).map(function(e){return '<article><b>Глава '+e.chapter+(e.rating?' · '+e.rating+'/10':'')+'</b>'+(e.text?(e.spoiler?'<details><summary>Показать спойлер</summary><p>'+escapeHtml(e.text)+'</p></details>':'<p>'+escapeHtml(e.text)+'</p>'):'')+'<button class="mt-ghost-btn" data-old-entry="'+escapeHtml(e.id)+'" data-old-title="'+escapeHtml(m.id)+'">Удалить запись</button></article>';}).join('')+'</details>';
    }).join('')+'</div>';
  }
  function renderTitleComparison(){
    var ids=libraryUI.compareIds,items=ids.map(findManhwa),valid=items.length===2&&items[0]&&items[1]&&ids[0]!==ids[1];
    var html='<section class="mt-compare-page"><button class="mt-ghost-btn" id="compare-close">← Библиотека</button><h1>Сравнение тайтлов</h1><p class="mt-feature-hint">Личные оценки и впечатления. Сравнение ничего не меняет в библиотеке.</p><div class="mt-compare-pickers">'+[0,1].map(function(i){return '<label>Тайтл '+(i+1)+'<select class="mt-input" data-compare-pick="'+i+'"><option value="">Выбрать</option>'+state.manhwas.map(function(m){return '<option value="'+escapeHtml(m.id)+'"'+(ids[i]===m.id?' selected':'')+'>'+escapeHtml(displayTitle(m))+'</option>';}).join('')+'</select></label>';}).join('')+'</div>';
    if(!valid)return html+'<p>Выбери два разных тайтла.</p></section>';
    html+='<div class="mt-compare-covers">'+items.map(function(m){return '<article>'+journeyCover(m)+'<h2>'+escapeHtml(displayTitle(m))+'</h2><strong>'+(ratedScore(m)===null?'Не оценено':Math.round(ratedScore(m))+' / 100')+'</strong><p>'+escapeHtml((m.genres||[]).join(' · ')||'Без жанров')+'</p></article>';}).join('')+'</div>';
    var names=Array.from(new Set(items.flatMap(function(m){return (m.criteria||[]).map(function(c){return c.name;});})));
    var shared=(items[0].genres||[]).filter(function(g){return (items[1].genres||[]).includes(g);}),scores=items.map(ratedScore);
    html+='<div class="mt-compare-insight"><p><b>Общие жанры:</b> '+escapeHtml(shared.join(' · ')||'Нет общих жанров')+'</p>'+(scores.every(function(n){return n!==null;})?'<p>'+ (scores[0]===scores[1]?'Общие оценки равны.':escapeHtml(displayTitle(items[scores[0]>scores[1]?0:1]))+' выше на <b>'+Math.abs(Math.round(scores[0]-scores[1]))+' балл(а)</b>.')+'</p>':'')+'</div>';
    html+='<div class="mt-compare-table"><div class="mt-compare-row mt-compare-sticky"><b>Критерий</b>'+items.map(function(m){return '<b>'+escapeHtml(displayTitle(m))+'</b>';}).join('')+'</div>'+names.map(function(name){
      var values=items.map(function(m){var c=m.criteria.find(function(c){return c.name===name;});return !m.rated||!c?null:c.score;});
      var both=values.every(function(n){return n!==null;}),delta=both?Math.round(Math.abs(values[0]-values[1])*10)/10:0;
      return '<div class="mt-compare-row"><span>'+escapeHtml(name)+(both?'<small>'+(delta?'Разница '+delta:'Равны')+'</small>':'')+'</span>'+values.map(function(value,i){return '<strong class="'+(both&&value>values[1-i]?'mt-compare-higher':both&&value<values[1-i]?'mt-compare-lower':'')+'">'+(value===null?'—':value+'/10')+(both&&value>values[1-i]?'<small>↑ Выше</small>':'')+'</strong>';}).join('')+'</div>';
    }).join('')+'<div class="mt-compare-row"><span>Главы · средняя</span>'+items.map(function(m){var entries=runJournal(m).filter(function(e){return e.rating;});return '<strong>'+(entries.length?(entries.reduce(function(s,e){return s+e.rating;},0)/entries.length).toFixed(1)+'/10':'—')+'</strong>';}).join('')+'</div></div></section>';
    return html;
  }
  function attachLibraryExtras(){
    var app=document.getElementById('app');
    function bind(id,event,fn){var el=document.getElementById(id);if(el)el.addEventListener(event,fn);}
    function each(selector,event,fn){app.querySelectorAll(selector).forEach(function(el){el.addEventListener(event,function(e){fn(el,e);});});}
    each('[data-library-clear]','click',function(el){var key=el.dataset.libraryClear;if(key==='all'||key==='search')state.searchQuery='';if(key==='all'||key==='status')state.filterStatus='all';if(key==='all'||key==='genre')state.filterGenre='all';if(key==='all'||key==='collection')libraryUI.collection='';render();});
    function selected(){return state.manhwas.filter(function(m){return libraryUI.selected.includes(m.id);});}
    bind('collection-filter','change',function(e){libraryUI.collection=e.target.value;render();});
    bind('collection-create','submit',function(e){e.preventDefault();var input=document.getElementById('collection-name'),name=input.value.trim(),d=libraryData();if(!name)return;if(d.collections.length>=40||d.collections.some(function(c){return c.name.toLowerCase()===name.toLowerCase();})){input.setCustomValidity('Такое имя уже есть или достигнут лимит 40 коллекций.');input.reportValidity();return;}d.collections.push({id:uid(),name:name});saveLibraryData(d);render();});
    bind('collection-name','input',function(e){e.target.setCustomValidity('');});
    each('[data-collection-rename]','click',function(el){var id=el.dataset.collectionRename,d=libraryData(),input=Array.from(app.querySelectorAll('[data-collection-name]')).find(function(x){return x.dataset.collectionName===id;}),name=input.value.trim();if(!name||d.collections.some(function(c){return c.id!==id&&c.name.toLowerCase()===name.toLowerCase();})){input.setCustomValidity('Укажи непустое уникальное имя.');input.reportValidity();return;}d.collections.find(function(c){return c.id===id;}).name=name;saveLibraryData(d);render();});
    each('[data-collection-name]','input',function(el){el.setCustomValidity('');});
    each('[data-collection-delete]','click',function(el){if(!window.confirm('Удалить коллекцию? Сами тайтлы останутся в библиотеке.'))return;var id=el.dataset.collectionDelete,d=libraryData();d.collections=d.collections.filter(function(c){return c.id!==id;});state.manhwas.forEach(function(m){m.collectionIds=(m.collectionIds||[]).filter(function(c){return c!==id;});});if(libraryUI.collection===id)libraryUI.collection='';saveLibraryData(d);save();render();});
    each('[data-title-collection]','change',function(el){var m=findManhwa(el.dataset.titleId);if(!m)return;var ids=new Set(m.collectionIds||[]);if(el.checked)ids.add(el.dataset.titleCollection);else ids.delete(el.dataset.titleCollection);m.collectionIds=Array.from(ids);save();});
    bind('bulk-toggle','click',function(){libraryUI.bulk=!libraryUI.bulk;libraryUI.menuOpen=false;if(!libraryUI.bulk)libraryUI.selected=[];render();});
    each('[data-select-title]','click',function(el){var id=el.dataset.selectTitle;libraryUI.selected=libraryUI.selected.includes(id)?libraryUI.selected.filter(function(x){return x!==id;}):libraryUI.selected.concat(id);render();});
    bind('bulk-all','click',function(){libraryUI.selected=sortedManhwas().filter(function(m){return !libraryUI.collection||(m.collectionIds||[]).includes(libraryUI.collection);}).map(function(m){return m.id;});render();});
    bind('bulk-none','click',function(){libraryUI.selected=[];render();});
    bind('bulk-status-apply','click',function(){var value=document.getElementById('bulk-status').value,items=selected();if(!items.length)return;if(!window.confirm('Изменить статус у '+items.length+' тайтлов?'))return;items.forEach(function(m){if(m.status===value)return;m.status=value;if(value==='done'){m.completedAt=Date.now();}m.updatedAt=Date.now();logActivity('status',m.id,displayTitle(m),{status:value});});save();render();});
    bind('bulk-genre-apply','click',function(){var g=document.getElementById('bulk-genre').value.trim();if(!g||!selected().length)return;selected().forEach(function(m){m.genres=Array.from(new Set((m.genres||[]).concat(g)));});save();render();});
    ['add','remove'].forEach(function(action){bind('bulk-collection-'+action,'click',function(){var id=document.getElementById('bulk-collection').value;if(!id||!selected().length)return;selected().forEach(function(m){m.collectionIds=action==='add'?Array.from(new Set((m.collectionIds||[]).concat(id))):(m.collectionIds||[]).filter(function(x){return x!==id;});});save();render();});});
    bind('bulk-trash','click',function(){var ids=selected().map(function(m){return m.id;});if(!ids.length||!window.confirm('Переместить '+ids.length+' тайтлов в корзину?'))return;if(moveToTrash(ids)){ids.forEach(function(id){cancelRerating(id);purgeAwardReferences(id);});state.manhwas=state.manhwas.filter(function(m){return !ids.includes(m.id);});libraryUI.selected=[];save();}render();});
    each('[data-trash-restore]','click',function(el){restoreTitles([el.dataset.trashRestore]);});
    each('[data-trash-delete]','click',function(el){if(!window.confirm('Удалить этот тайтл из корзины навсегда? Восстановление будет невозможно.'))return;var d=libraryData();d.trash=d.trash.filter(function(t){return t.title.id!==el.dataset.trashDelete;});saveLibraryData(d);if(lastUndo&&lastUndo.kind==='titles')lastUndo=null;render();});
    bind('extras-dismiss','click',function(){lastUndo=null;render();});
    each('[data-old-entry]','click',function(el){var m=findManhwa(el.dataset.oldTitle),entry=m&&Features.journal(m.journal).find(function(e){return e.id===el.dataset.oldEntry;});if(!entry||!window.confirm('Удалить запись из предыдущего прочтения?'))return;lastUndo={kind:'journal',id:m.id,entry:entry};m.journal=Features.journal(m.journal).filter(function(e){return e.id!==entry.id;});save();render();});
    bind('extras-undo','click',function(){if(!lastUndo)return;if(lastUndo.kind==='titles'){restoreTitles(lastUndo.ids);return;}var m=findManhwa(lastUndo.id),entry=lastUndo.entry;if(!m){lastUndo=null;render();return;}if(entry.rating&&runJournal(m,entry.run||1).some(function(e){return e.chapter===entry.chapter&&e.rating;})){state.error='У этой главы уже есть новая оценка. Удали её перед восстановлением прежней.';render();return;}if(!Features.journal(m.journal).some(function(e){return e.id===entry.id;}))m.journal=Features.journal(m.journal).concat(entry);lastUndo=null;save();render();});
    bind('compare-open','click',function(){libraryUI.compare=true;libraryUI.menuOpen=false;libraryUI.compareIds=libraryUI.selected.slice(0,2);render();window.scrollTo(0,0);});
    bind('compare-close','click',function(){libraryUI.compare=false;render();});
    each('[data-compare-pick]','change',function(el){libraryUI.compareIds[Number(el.dataset.comparePick)]=el.value;render();});
    each('[data-reread]','click',function(el){var m=findManhwa(el.dataset.reread);if(!m||currentRun(m)>=10000)return;if(!window.confirm('Начать новое прочтение? Прогресс начнётся с 0, прежние записи и оценки останутся в истории.'))return;var run=currentRun(m),p=Features.readingProgress(m);m.readingRuns=(m.readingRuns||[]).concat({run:run,ended:Date.now(),chapter:p.chapter,score:ratedScore(m)}).slice(-100);m.readingRun=run+1;m.reading={chapter:0,url:p.url,updatedAt:Date.now()};m.status='reading';delete chapterDrafts[m.id];persistChapterDrafts();journalView[m.id]={query:'',sort:'recent'};save();render();});
  }
  function journeyData() { return Features.cleanJourney(state.profile.journey); }
  function updateGoals() {
    var data=journeyData(), changed=false;
    data.goals.forEach(function(g){var o=Features.goalOptions.find(function(o){return o.id===g.id;}); var keys=Features.goalKeys(state.manhwas,o.metric).filter(function(k){return !g.baseline.includes(k);});
      keys.forEach(function(k){if(!g.earned.includes(k)){g.earned.push(k);changed=true;}});
    });
    if(changed){state.profile.journey=data;saveProfile();}
    if(data.goals.some(function(g){var o=Features.goalOptions.find(function(o){return o.id===g.id;});return new Set(g.earned).size>=o.target&&!state.unlockedAchievements['goal_reward_'+g.id];}))checkAchievements();
  }
  function journeyCover(m) {return m.coverUrl ? '<img loading="lazy" src="'+escapeHtml(m.coverUrl)+'" alt="" />' : '<span class="mt-journey-placeholder">AM</span>';}
  var halloweenPreview='harvest';
  function renderHalloween(){
    var w=Features.halloweenWindow(Date.now()),p=Features.halloweenProgress(state.manhwas,state.activityLog,state.unlockedAchievements,Date.now()),quests=Features.halloweenQuests;
    var claimed=quests.filter(function(q){return state.unlockedAchievements[q.id];}).length;
    var style=halloweenPreview==='harvest'?{theme:'theme-h26-harvest',frame:'frame-h26-thorns',badge:'badge-h26-pumpkin'}:{theme:'theme-h26-manor',frame:'frame-h26-spectral',badge:'badge-h26-keeper'};
    return '<section class="mt-halloween"><header class="mt-halloween-hero"><span class="mt-section-eyebrow">СЕЗОННОЕ СОБЫТИЕ · 2026</span><span class="mt-halloween-moon" aria-hidden="true">✦</span><h2>Ночь<br><em>историй.</em></h2><p>Зажги фонари своей библиотеки.<br>У каждой истории есть светлая сторона.</p><span class="mt-halloween-date">18 октября — 2 ноября · '+(w.active?'Событие идёт':w.upcoming?'Скоро открытие':'Событие завершено')+'</span></header><div class="mt-halloween-progress"><div><strong>'+claimed+' / 7</strong><span>наград в твоей коллекции</span></div><progress max="7" value="'+claimed+'" aria-label="Полученные награды события"></progress><p>До 800 XP и 800 монет · 7 эксклюзивных украшений</p></div><div class="mt-halloween-intro"><h3>Собери свою ночь</h3><p>Задания выполняются автоматически по действиям с 18 октября. Награды выдаются один раз и остаются навсегда. Применить их можно в редакторе профиля.</p></div><div class="mt-halloween-preview-tabs"><button class="mt-ghost-btn" data-halloween-preview="harvest" aria-pressed="'+(halloweenPreview==='harvest')+'">Тыквенная долина</button><button class="mt-ghost-btn" data-halloween-preview="manor" aria-pressed="'+(halloweenPreview==='manor')+'">Лунный особняк</button></div><div class="mt-shop-preview'+styleClasses(style)+'"><span class="mt-section-eyebrow">ПРИМЕРКА НАГРАД СОБЫТИЯ</span><div class="mt-shop-preview-person"><div class="mt-shop-avatar">'+avatarHtml(state.profile)+'</div><div><strong>'+escapeHtml(displayNick())+'</strong>'+styleBadge(style)+'<p>Твоя история продолжается после полуночи.</p></div></div></div><button class="mt-ghost-btn" id="halloween-wardrobe">Мои украшения →</button><div class="mt-halloween-quests">'+quests.map(function(q,i){var earned=!!state.unlockedAchievements[q.id],n=earned?q.target:Math.min(p[q.metric],q.target),item=Features.shopItem(q.reward);return '<article class="mt-halloween-quest'+(earned?' earned':'')+(i===6?' finale':'')+'"><div class="mt-halloween-quest-top"><span aria-hidden="true">'+q.icon+'</span><small>'+(i===6?'ФИНАЛЬНАЯ НАГРАДА':'ЗАДАНИЕ 0'+(i+1))+'</small><b>'+(earned?'✓ Получено':!w.active?'Закрыто':n+' / '+q.target)+'</b></div><h3>'+q.name+'</h3><p>'+q.text+'</p><progress max="'+q.target+'" value="'+n+'" aria-label="'+q.name+'"></progress><div class="mt-halloween-reward"><span>'+({theme:'Тема',frame:'Рамка',badge:'Значок'})[item.kind]+' · '+item.name+'</span><strong>+'+q.xp+' XP · '+q.xp+' ◈</strong></div>'+(!earned&&w.active&&i<6?'<button class="mt-ghost-btn" data-halloween-go="'+(q.metric==='dark'?'catalog':'library')+'">'+(q.metric==='dark'?'Найти мрачную историю ↗':'К моей библиотеке →')+'</button>':'')+'</article>';}).join('')+'</div><details class="mt-halloween-rules"><summary>Как считается прогресс</summary><p>Событие идёт до конца 2 ноября 2026 года по времени устройства. Для заданий по главам учитываются разные главы; повторная запись той же главы не увеличивает счётчик. Дни считаются по записям дневника, оценкам тайтлов и завершениям — просто открывать приложение недостаточно.</p><p>До получения награды прогресс зависит от сохранённых записей. Удалённые данные могут уменьшить его. Полученные награды сохраняются при синхронизации и в резервной копии, даже после завершения события. Новые награды после закрытия события не выдаются.</p></details></section>';
  }
  function renderJourney() {
    var data=journeyData(),ui=state.journeyUI;
    if(!['achievements','goals','halloween'].includes(ui.section))ui.section='achievements';
    var genres=Array.from(new Set(state.manhwas.filter(function(m){return m.rated;}).flatMap(function(m){return m.genres||[];}))).sort();
    var html='<div class="mt-journey-page"><header class="mt-journey-heading"><div class="mt-journey-orbit" aria-hidden="true">✦</div><span class="mt-section-eyebrow">ТВОЁ ПРОСТРАНСТВО ЧТЕНИЯ</span><h1>Для тебя<span aria-hidden="true"> ✦</span></h1><p>Твои достижения, цели и события.</p></header><nav class="mt-journey-nav" aria-label="Разделы для тебя">'+[['achievements','01','Достижения'],['goals','02','Цели'],['halloween','☾','Ивент']].map(function(x){return '<button data-journey-section="'+x[0]+'" aria-pressed="'+(ui.section===x[0])+'"><small>'+x[1]+'</small>'+x[2]+'</button>';}).join('')+'</nav><div class="mt-journey-stage">';
    if(ui.section==='achievements')html+=renderAchievementsTab();
    if(ui.section==='halloween')html+=renderHalloween();
    if(ui.section==='goals')html+=
      '<section class="mt-journey-panel"><div class="mt-section-eyebrow">ТВОЙ ТЕМП</div><h2>Маленькие шаги, большие истории</h2><p>Выбери одну или несколько целей. Учитываются новые результаты после выбора, без дедлайнов. Награда за каждый вид цели выдаётся один раз.</p><div class="mt-goal-grid">'+Features.goalOptions.map(function(o){var g=data.goals.find(function(g){return g.id===o.id;}),n=g?Math.min(o.target,g.earned.length):0;return '<article class="mt-goal-card'+(g?' selected':'')+'"><span class="mt-section-eyebrow">'+(g?(n===o.target?'ЦЕЛЬ ДОСТИГНУТА ✓':'В ПУТИ'):'НОВЫЙ МАРШРУТ')+'</span><h3>'+o.name+'</h3><p>'+o.text+'</p><div class="mt-goal-reward">'+(state.unlockedAchievements['goal_reward_'+o.id]?'Награда получена ✓':'Награда: +'+o.reward+' XP · +'+o.reward+' монет')+'</div>'+(g?'<div class="mt-goal-count">'+n+' <span>/ '+o.target+'</span></div><progress value="'+n+'" max="'+o.target+'" aria-label="'+o.text+'"></progress><button class="mt-ghost-btn" data-goal-remove="'+o.id+'">Убрать цель</button>':'<button class="mt-primary-btn" data-goal-add="'+o.id+'">Выбрать цель</button>')+'</article>';}).join('')+'</div></section>'; 
    return html+'</div></div>';
  }
  var CHAPTER_QUICK_NOTES=['Раскрытие прошлого ГГ','Ничего не произошло','Неожиданный поворот','Развитие отношений','Сильная сцена боя','Новый персонаж','Важная подсказка','Красивые кадры','Смешной момент','Трогательная сцена','Много объяснений','Интригующий финал'];
  function chapterRatingSlider(value){
    var n=value||0;
    return '<fieldset class="mt-score-picker mt-chapter-slider"><legend>Как тебе глава?</legend><div class="mt-score-picker-heading"><output>'+(n?n+' / 10':'Без оценки')+'</output><p class="mt-chapter-mood">'+chapterRatingMood(n)+'</p></div><input type="range" id="chapter-rating" min="0" max="10" step="1" value="'+n+'" aria-label="Оценка главы" aria-valuetext="'+(n?n+' из 10. '+chapterRatingMood(n):'Без оценки')+'" /><div class="mt-score-ruler" aria-hidden="true"><span>0</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span></div><button type="button" class="mt-note-only" data-chapter-score="0" aria-pressed="'+(!n)+'">Без оценки · только заметка</button><p id="chapter-existing" role="status"></p></fieldset>';
  }
  function chapterRatingMood(value){
    return ['Как тебе эта глава?','Совсем не понравилась','Слабая глава','Не зацепила','Ниже ожиданий','Смешанные чувства','Неплохая глава','Хорошая глава','Очень понравилась','Потрясающая глава','Незабываемая глава'][Number(value)||0]||'Как тебе эта глава?';
  }
  function savedChapterRating(value){
    var n=value||0;
    return '<div class="mt-entry-score"><strong>'+(n?n+'<small> / 10</small>':'Заметка')+'</strong><span>'+(n?chapterRatingMood(n):'Без оценки')+'</span></div>';
  }
  var journalView={};
  var chapterSaveNotice='';
  var chapterSubmitting=false;
  var chapterDrafts=Object.create(null);
  var chapterDraftSaveFailed=false;
  var CHAPTER_DRAFTS_KEY='mt-chapter-drafts-v1';
  function persistChapterDrafts(){
    try{window.localStorage.setItem(CHAPTER_DRAFTS_KEY,JSON.stringify(chapterDrafts));chapterDraftSaveFailed=false;var el=document.getElementById('chapter-draft-status');if(el)el.textContent='Черновик сохранён на этом устройстве';return true;}
    catch(e){chapterDraftSaveFailed=true;var el=document.getElementById('chapter-draft-status');if(el)el.textContent='Не удалось сохранить черновик. Не закрывай страницу до сохранения записи.';return false;}
  }
  function loadChapterDrafts(){
    chapterDrafts=Object.create(null);
    try{var data=JSON.parse(window.localStorage.getItem(CHAPTER_DRAFTS_KEY)||'{}');if(!data||typeof data!=='object')return;
      Object.keys(data).slice(0,500).forEach(function(id){var m=findManhwa(id),d=data[id];if(!m||!d||typeof d!=='object'||(d.run||1)!==currentRun(m))return;
        chapterDrafts[id]={run:currentRun(m),'chapter-number':typeof d['chapter-number']==='string'?d['chapter-number'].slice(0,12):'','chapter-text':typeof d['chapter-text']==='string'?d['chapter-text'].slice(0,2000):'','chapter-rating':String(Math.max(0,Math.min(10,Math.round(Number(d['chapter-rating'])||0)))),'chapter-spoiler':!!d['chapter-spoiler']};
      });
    }catch(e){}
  }

  function renderChapterDraftNotice(m){
    var draft=chapterDrafts[m.id];
    return '<div class="mt-draft-notice"'+(!draft&&!chapterDraftSaveFailed?' hidden':'')+'><div><strong>Незаконченная запись</strong><p id="chapter-draft-status" role="status">'+(chapterDraftSaveFailed?'Не удалось сохранить черновик':draft?'Глава '+escapeHtml(draft['chapter-number']||'без номера')+' · прочтение №'+currentRun(m):'Черновик на этом устройстве')+'</p></div><div class="mt-tools-row"><button type="button" class="mt-ghost-btn" id="chapter-draft-continue">Продолжить</button><button type="button" class="mt-ghost-btn" id="chapter-draft-discard">Удалить</button></div></div>';
  }
  function renderRunSelector(m){
    var current=currentRun(m),view=viewedRun(m),passes=Array.from(new Set([current].concat((m.readingRuns||[]).map(function(r){return r.run;}),Features.journal(m.journal).map(function(e){return e.run||1;})))).sort(function(a,b){return a-b;});
    var snapshot=(m.readingRuns||[]).find(function(r){return r.run===view;}),chapter=view===current?Features.readingProgress(m).chapter:snapshot?snapshot.chapter:Math.max(0,...runJournal(m,view).map(function(e){return e.chapter;}));
    return '<div class="mt-run-selector"><label>Прочтение<select id="journal-run" class="mt-input">'+passes.map(function(n){return '<option value="'+n+'"'+(n===view?' selected':'')+'>'+(n===1?'Первое прочтение':n===2?'Второе прочтение':'Прочтение №'+n)+(n===current?' · текущее':'')+'</option>';}).join('')+'</select></label><p>Прочитано до главы <b>'+chapter+'</b>'+(view!==current?' · Архив: новые записи добавляются в текущее прочтение.':'')+'</p></div>';
  }
  function openChapterSheet(id){
    var m=findManhwa(id);if(!m)return;
    if(viewedRun(m)!==currentRun(m)){journalSettings(m).run=currentRun(m);render();}
    var dialog=document.getElementById('chapter-quick-dialog'),form=document.getElementById('chapter-form'),input=document.getElementById('chapter-number');if(!dialog||!form)return;
    if(!input.value){input.value=String(Math.max(0,...runJournal(m).map(function(e){return e.chapter;}))+1);var d=chapterDrafts[id]||(chapterDrafts[id]={run:currentRun(m)});d['chapter-number']=input.value;persistChapterDrafts();}
    var home=document.getElementById('chapter-form-home');document.getElementById('chapter-sheet-body').appendChild(form);
    refreshChapterComposer(m);
    if(!dialog.open)dialog.showModal();
    document.getElementById('chapter-rating').focus({preventScroll:true});
    dialog.onclose=function(){if(home&&form.isConnected)home.appendChild(form);var trigger=document.getElementById('journal-quick');if(trigger)trigger.focus({preventScroll:true});};
  }
  function attachPolishHandlers(selected){
    var app=document.getElementById('app');
    function bind(id,event,fn){var el=document.getElementById(id);if(el)el.addEventListener(event,fn);}
    [['.mt-library-menu','menuOpen'],['.mt-collection-tools','collectionsOpen'],['.mt-trash','trashOpen'],['.mt-bulk-dock>details','bulkOpen']].forEach(function(pair){var el=app.querySelector(pair[0]);if(el)el.addEventListener('toggle',function(){if(el.isConnected)libraryUI[pair[1]]=el.open;});});
    app.querySelectorAll('[data-shop-purchase]').forEach(function(el){el.addEventListener('click',function(){state.shopPreview=el.dataset.shopPurchase;buyShopItem(el.dataset.shopPurchase);render();});});
    app.querySelectorAll('[data-shelf]').forEach(function(el){el.addEventListener('click',function(){libraryUI.collection=libraryUI.collection===el.dataset.shelf?'':el.dataset.shelf;render();});});
    bind('bulk-done','click',function(){libraryUI.bulk=false;libraryUI.selected=[];render();});
    bind('chapter-sheet-close','click',function(){document.getElementById('chapter-quick-dialog').close();});
    bind('chapter-draft-continue','click',function(){if(selected)openChapterSheet(selected.id);});
    bind('chapter-draft-discard','click',function(){if(!selected||!window.confirm('Удалить несохранённый черновик этой главы?'))return;delete chapterDrafts[selected.id];persistChapterDrafts();render();});
    bind('journal-run','change',function(e){if(!selected)return;journalSettings(selected).run=Number(e.target.value);journalSettings(selected).query='';render();document.getElementById('chapter-journal').scrollIntoView({block:'start'});});
  }
  function journalSettings(m){return journalView[m.id]||(journalView[m.id]={query:'',sort:'recent'});}
  function viewedRun(m){return journalSettings(m).run||currentRun(m);}
  function journalEntriesHtml(m){
    var v=journalSettings(m),all=runJournal(m,viewedRun(m)),list=all.filter(function(e){return v.query===''||e.chapter===Number(v.query);});
    list.sort(function(a,b){return v.sort==='chapter'?a.chapter-b.chapter||b.ts-a.ts:v.sort==='rating'?(b.rating||0)-(a.rating||0)||b.ts-a.ts:b.ts-a.ts;});
    return list.length?list.map(function(e){var duplicates=e.rating&&all.filter(function(x){return x.chapter===e.chapter&&x.rating;}).length>1;
      var previous=Features.chapterScores(runJournal(m,Math.max(1,viewedRun(m)-1))).find(function(p){return p.chapter===e.chapter;});
      return '<article id="journal-entry-'+escapeHtml(e.id)+'" tabindex="-1"><header><b>Глава '+e.chapter+'</b><time>'+escapeHtml(new Date(e.ts).toLocaleDateString('ru-RU'))+'</time></header>'+(e.rating&&previous&&viewedRun(m)>1?'<p class="mt-score-change">Прошлое прочтение → это: <b>'+previous.rating+' → '+e.rating+'</b> / 10</p>':'')+savedChapterRating(e.rating)+(duplicates?'<p class="mt-feature-hint">В старых записях есть несколько оценок этой главы. На графике показана самая ранняя; лишние записи можно удалить.</p>':'')+(e.text?(e.spoiler?'<details><summary>Показать спойлер</summary><p>'+escapeHtml(e.text)+'</p></details>':'<p>'+escapeHtml(e.text)+'</p>'):'')+'<button class="mt-ghost-btn" data-journal-delete="'+escapeHtml(e.id)+'">Удалить запись</button></article>';
    }).join(''):'<p class="mt-journal-empty">Пока нет записей'+(v.query!==''?' для этой главы':'')+'.</p>';
  }
  function chapterChart(m){
    var entries=Features.chapterScores(runJournal(m,viewedRun(m)));if(!entries.length)return '<section class="mt-chapter-chart"><h3>Динамика оценок</h3><p>Поставь первую оценку — здесь появится график впечатлений по главам.</p></section>';
    var min=entries[0].chapter,max=entries[entries.length-1].chapter;
    function x(e){return entries.length===1?170:30+(e.chapter-min)/(max-min)*280;}
    function y(e){return 120-(e.rating-1)*10;}
    return '<section class="mt-chapter-chart"><h3>Динамика оценок</h3><p>Оценки по номеру главы · нажми на точку, чтобы открыть запись.</p><div class="mt-chart-scroll"><svg viewBox="0 0 340 154" role="group" aria-label="График оценок глав">'+[1,5,10].map(function(n){var yy=120-(n-1)*10;return '<line x1="30" x2="310" y1="'+yy+'" y2="'+yy+'" class="mt-chart-grid"/><text x="7" y="'+(yy+4)+'">'+n+'</text>';}).join('')+'<polygon points="'+x(entries[0])+',130 '+entries.map(function(e){return x(e)+','+y(e);}).join(' ')+' '+x(entries[entries.length-1])+',130" class="mt-chart-area"/><polyline points="'+entries.map(function(e){return x(e)+','+y(e);}).join(' ')+'" class="mt-chart-line"/>'+entries.map(function(e){return '<a href="#journal-entry-'+escapeHtml(e.id)+'" data-journal-jump="'+escapeHtml(e.id)+'" aria-label="Глава '+e.chapter+': '+e.rating+' из 10"><circle cx="'+x(e)+'" cy="'+y(e)+'" r="10" fill="transparent"/><circle class="mt-chart-dot" cx="'+x(e)+'" cy="'+y(e)+'" r="4"/><title>Глава '+e.chapter+' · '+e.rating+' / 10</title></a>';}).join('')+'<text x="30" y="148">Гл. '+min+'</text>'+(entries.length>1?'<text x="310" y="148" text-anchor="end">Гл. '+max+'</text>':'')+'</svg></div><details><summary>Все точки графика · '+entries.length+'</summary><div class="mt-chart-points">'+entries.map(function(e){return '<button class="mt-ghost-btn" data-journal-jump="'+escapeHtml(e.id)+'">Глава '+e.chapter+' · '+e.rating+'/10</button>';}).join('')+'</div></details></section>';
  }
  function ratingMapSummary(scores){
    var best=scores.reduce(function(a,e){return !a||e.rating>a.rating?e:a;},null);
    return '<div class="mt-map-summary"><div><strong>'+(scores.length?(scores.reduce(function(n,e){return n+e.rating;},0)/scores.length).toFixed(1):'—')+'</strong><span>средняя оценка</span></div><div><strong>'+(best?'Гл. '+best.chapter:'—')+'</strong><span>'+(best?'лучшая · '+best.rating+'/10':'лучшая глава')+'</span></div><div><strong>'+scores.length+'</strong><span>оценено глав</span></div></div>';
  }
  async function downloadRatingMap(m,button){
    var range=document.getElementById('map-range').value;
    var scores=Features.chapterScores(runJournal(m,viewedRun(m))).filter(function(e){return range==='all'||String(Math.floor(Math.max(0,e.chapter-1)/50))===range;});
    if(!scores.length)return;
    if(scores.length>1000){showToast('Для большой истории выбери диапазон глав перед сохранением.');return;}
    button.disabled=true;button.textContent='Готовим картинку…';
    try{
      var canvas=document.createElement('canvas');canvas.width=1000;canvas.height=340+Math.ceil(scores.length/10)*82;
      var ctx=canvas.getContext('2d');ctx.fillStyle='#15151e';ctx.fillRect(0,0,canvas.width,canvas.height);
      var cover=null;
      if(m.coverUrl)cover=await new Promise(function(resolve){var img=new Image(),done=false;function finish(v){if(!done){done=true;resolve(v);}}img.crossOrigin='anonymous';img.onload=function(){finish(img);};img.onerror=function(){finish(null);};img.src=m.coverUrl;setTimeout(function(){finish(null);},2500);});
      ctx.fillStyle='#302b40';ctx.fillRect(32,32,112,158);
      if(cover)ctx.drawImage(cover,32,32,112,158);
      else{ctx.fillStyle='#c4b2ed';ctx.font='bold 30px sans-serif';ctx.fillText('AM',62,120);}
      ctx.fillStyle='#c4b2ed';ctx.font='bold 14px sans-serif';ctx.fillText('AM TRACKER · МОИ ОЦЕНКИ ГЛАВ',170,53);
      ctx.fillStyle='#f4f0fa';ctx.font='bold 28px sans-serif';
      var words=displayTitle(m).split(/\s+/),line='',y=92;
      words.forEach(function(word){if(ctx.measureText(line+word).width>780&&line){if(y<=130)ctx.fillText(line,170,y);y+=34;line='';}line+=word+' ';});
      if(y<=160)ctx.fillText(line,170,y);
      ctx.fillStyle='#c2bacd';ctx.font='17px sans-serif';ctx.fillText('Прочтение №'+viewedRun(m)+' · '+scores.length+' глав · средняя '+(scores.reduce(function(n,e){return n+e.rating;},0)/scores.length).toFixed(1),170,195);
      var colors=['#bc9add','#eb8585','#f0ac64','#f0d46d','#8bd071','#36ba91'];
      ['1–2','3–4','5–6','7','8','9–10'].forEach(function(t,i){ctx.fillStyle=colors[i];ctx.fillRect(32+i*150,228,12,12);ctx.fillStyle='#c2bacd';ctx.fillText(t,52+i*150,241);});
      scores.forEach(function(e,i){var x=32+i%10*94,y=270+Math.floor(i/10)*82;ctx.fillStyle=colors[e.rating>=9?5:e.rating>=8?4:e.rating>=7?3:e.rating>=5?2:e.rating>=3?1:0];ctx.fillRect(x,y,86,70);ctx.fillStyle='#18231e';ctx.textAlign='center';ctx.font='14px sans-serif';ctx.fillText('Гл. '+e.chapter,x+43,y+22);ctx.font='bold 26px sans-serif';ctx.fillText(e.rating.toFixed(1),x+43,y+53);});
      ctx.textAlign='left';ctx.fillStyle='#c2bacd';ctx.font='14px sans-serif';ctx.fillText('Личные оценки · '+new Date().toLocaleDateString('ru-RU'),32,canvas.height-22);
      var blob=await new Promise(function(resolve){canvas.toBlob(resolve,'image/png');});if(!blob)throw new Error('PNG');
      var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='am-chapter-ratings-'+viewedRun(m)+'-'+range+'.png';a.click();setTimeout(function(){URL.revokeObjectURL(url);},10000);
    }catch(e){showToast('Не удалось сохранить картинку. Попробуй ещё раз.');}
    finally{button.disabled=false;button.textContent='Сохранить в PNG';}
  }
  function chapterRatingMap(m){
    var scores=Features.chapterScores(runJournal(m,viewedRun(m))),groups={};
    var bands=[['masterpiece','9–10','Великолепно'],['great','8','Отлично'],['good','7','Хорошо'],['mixed','5–6','Неплохо'],['weak','3–4','Слабо'],['poor','1–2','Не понравилось']];
    function band(n){return n>=9?'masterpiece':n>=8?'great':n>=7?'good':n>=5?'mixed':n>=3?'weak':'poor';}
    scores.forEach(function(e){var block=Math.floor(Math.max(0,e.chapter-1)/50);(groups[block]||(groups[block]=[])).push(e);});
    return '<section id="journal-rating-map" class="mt-rating-map"'+(journalSettings(m).mapOpen?'':' hidden')+' aria-label="Карта оценок глав"><header><span class="mt-section-eyebrow">ИСТОРИЯ В ЦВЕТЕ</span><h3>Карта оценок</h3><p>Твои оценки · прочтение №'+viewedRun(m)+'. Нажми на главу, чтобы открыть запись.</p></header>'+ratingMapSummary(scores)+(scores.length?'<div class="mt-map-tools"><label>Диапазон глав<select id="map-range" class="mt-input"><option value="all">Все главы</option>'+Object.keys(groups).map(function(k){var n=Number(k)*50+1;return '<option value="'+k+'">'+n+'–'+(n+49)+'</option>';}).join('')+'</select></label><button type="button" id="map-download" class="mt-ghost-btn">Сохранить в PNG</button></div>':'')+'<ul class="mt-rating-legend">'+bands.map(function(b){return '<li><i class="mt-rating-'+b[0]+'" aria-hidden="true"></i><span><b>'+b[1]+'</b> '+b[2]+'</span></li>';}).join('')+'</ul>'+(scores.length?Object.keys(groups).map(function(key){var start=Number(key)*50+1;return '<section class="mt-rating-block" data-map-block="'+key+'"><h4>Главы '+start+'–'+(start+49)+'</h4><div class="mt-rating-grid">'+groups[key].map(function(e){return '<button type="button" class="mt-rating-tile mt-rating-'+band(e.rating)+'" data-journal-jump="'+escapeHtml(e.id)+'" aria-label="Глава '+e.chapter+': '+e.rating+' из 10. Открыть запись"><span>Гл. '+e.chapter+'</span><strong>'+Number(e.rating).toFixed(1)+'</strong></button>';}).join('')+'</div></section>';}).join(''):'<p class="mt-journal-empty">Пока нет оценённых глав. Поставь первую оценку — она появится здесь.</p>')+'<p class="mt-rating-map-footnote">Только оценённые главы, по порядку. Цвет обозначает оценку, а не рейтинг других читателей.</p></section>';
  }
  function chapterComposerHtml(){
    return '<form id="chapter-form"><div class="mt-composer-fields"><div class="mt-chapter-number-row"><label for="chapter-number">Глава</label><div class="mt-chapter-stepper"><button type="button" data-chapter-step="-1" aria-label="Предыдущая глава">−</button><input id="chapter-number" class="mt-input" type="number" inputmode="decimal" min="0" step="0.1" max="1000000" required placeholder="Номер" /><button type="button" data-chapter-step="1" aria-label="Следующая глава">+</button></div><span id="chapter-run-label"></span></div>'+chapterRatingSlider(null)+'<label class="mt-chapter-note-label">Заметка <span>необязательно</span><textarea id="chapter-text" class="mt-input" maxlength="2000" rows="3" placeholder="Что хочется запомнить?"></textarea></label><details class="mt-quick-notes"><summary>Быстрые заметки</summary><p>Несколько слов, чтобы запомнить главное.</p><div>'+CHAPTER_QUICK_NOTES.map(function(note,i){return '<button type="button" data-quick-note="'+i+'">'+note+'</button>';}).join('')+'</div></details><label class="mt-spoiler-check"><input id="chapter-spoiler" type="checkbox" /> Спрятать текст под спойлер</label><p class="mt-composer-hint">Черновик сохраняется на устройстве. Сохранённую оценку можно только удалить вместе с записью.</p><p id="chapter-error" role="alert"></p></div><footer class="mt-chapter-submit"><button class="mt-primary-btn" type="submit">Сохранить</button><button class="mt-ghost-btn" type="submit" name="next" value="1">Сохранить и следующая →</button></footer></form>';
  }
  function renderChapterJournal(m) {
    m=findManhwa(m.id)||m;var v=journalSettings(m),entries=runJournal(m,viewedRun(m)),scores=Features.chapterScores(entries),avg=scores.length?(scores.reduce(function(n,e){return n+e.rating;},0)/scores.length).toFixed(1):'—';
    return '<section class="mt-journey-panel mt-chapter-journal" id="chapter-journal"><header class="mt-journal-heading"><div><span class="mt-section-eyebrow">ТВОИ ВПЕЧАТЛЕНИЯ</span><h2>Дневник глав</h2></div></header>'+renderRunSelector(m)+'<div class="mt-journal-stats"><div><strong>'+scores.length+'</strong><span>глав с оценкой</span></div><div><strong>'+avg+'</strong><span>средний балл</span></div><div><strong>'+entries.length+'</strong><span>записей</span></div></div>'+(chapterSaveNotice?'<p class="mt-journal-saved" role="status">'+escapeHtml(chapterSaveNotice)+'</p>':'')+renderChapterDraftNotice(m)+'<div id="chapter-form-home" hidden>'+chapterComposerHtml()+'</div>'+chapterChart(m)+'<button type="button" id="journal-records-toggle" class="mt-ghost-btn mt-records-toggle" aria-expanded="'+!!v.entriesOpen+'" aria-controls="journal-records">'+(v.entriesOpen?'Скрыть записи':'Все оценки и заметки')+' · '+entries.length+'</button><button type="button" id="journal-map-toggle" class="mt-ghost-btn mt-records-toggle mt-map-toggle" aria-expanded="'+!!v.mapOpen+'" aria-controls="journal-rating-map">'+(v.mapOpen?'Скрыть карту оценок':'Карта оценок глав')+' · '+scores.length+'</button>'+chapterRatingMap(m)+'<div id="journal-records"'+(v.entriesOpen?'':' hidden')+'><div class="mt-journal-toolbar"><label>Найти главу<input id="journal-search" class="mt-input" type="number" min="0" max="1000000" step="0.1" placeholder="Все главы" value="'+escapeHtml(v.query)+'" /></label><label>Порядок<select id="journal-sort" class="mt-input">'+[['recent','Сначала новые'],['chapter','По номеру главы'],['rating','По оценке']].map(function(o){return '<option value="'+o[0]+'"'+(v.sort===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+'</select></label></div><div class="mt-journal-list" id="journal-list">'+journalEntriesHtml(m)+'</div></div></section>';
  }
  function refreshChapterComposer(m){
    var rating=document.getElementById('chapter-rating'),input=document.getElementById('chapter-number');if(!rating||!input)return;
    var picker=rating.closest('.mt-score-picker');if(!picker)return;
    var n=Number(rating.value),existing=runJournal(m).find(function(e){return input.value!==''&&e.chapter===Number(input.value)&&e.rating;});
    picker.querySelectorAll('[data-chapter-score]').forEach(function(btn){btn.setAttribute('aria-pressed',String(Number(btn.dataset.chapterScore)===n));});
    var output=rating.closest('.mt-score-picker').querySelector('output');output.textContent=n?n+' / 10':'Выбери оценку';
    rating.closest('.mt-score-picker').querySelector('.mt-chapter-mood').textContent=chapterRatingMood(n);
    document.getElementById('chapter-existing').textContent=existing?'У этой главы уже есть оценка '+existing.rating+' / 10. Выбери «Без оценки», чтобы добавить заметку.':'';
    document.getElementById('chapter-run-label').textContent='Прочтение №'+currentRun(m);
  }
  function attachJourneyHandlers(selected) {
    function bind(id,event,fn){var el=document.getElementById(id);if(el)el.addEventListener(event,fn);}
    var chapterForm=document.getElementById('chapter-form');
    if(chapterForm&&selected){
      var draft=chapterDrafts[selected.id];
      ['chapter-number','chapter-text','chapter-rating','chapter-spoiler'].forEach(function(id){
        var el=document.getElementById(id);if(!el)return;
        if(draft&&Object.prototype.hasOwnProperty.call(draft,id)){if(el.type==='checkbox')el.checked=draft[id];else el.value=draft[id];}
        function remember(){var d=chapterDrafts[selected.id]||(chapterDrafts[selected.id]={});d[id]=el.type==='checkbox'?el.checked:el.value;d.run=currentRun(findManhwa(selected.id)||selected);persistChapterDrafts();}
        el.addEventListener('input',remember);el.addEventListener('change',remember);
      });
      var rating=document.getElementById('chapter-rating'),slider=rating&&rating.closest('.mt-chapter-slider');
      if(slider){var caption=Number(rating.value)?rating.value+' / 10':'Без оценки';slider.querySelector('output').textContent=caption;rating.setAttribute('aria-valuetext',caption);slider.style.setProperty('--chapter-fill',(Number(rating.value)*10)+'%');slider.querySelector('.mt-chapter-mood').textContent=chapterRatingMood(Number(rating.value));}
    }
    if(chapterForm&&selected){
      var liveTitle=findManhwa(selected.id)||selected;
      chapterForm.querySelectorAll('[data-chapter-score]').forEach(function(btn){btn.addEventListener('click',function(){var input=document.getElementById('chapter-rating');input.value=btn.dataset.chapterScore;input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chapter-error').textContent='';refreshChapterComposer(liveTitle);});});
      chapterForm.querySelectorAll('[data-chapter-step]').forEach(function(btn){btn.addEventListener('click',function(){var input=document.getElementById('chapter-number');input.value=String(Math.max(0,Math.min(1000000,Math.round(((Number(input.value)||0)+Number(btn.dataset.chapterStep))*10)/10)));input.dispatchEvent(new Event('input',{bubbles:true}));});});
      document.getElementById('chapter-number').addEventListener('input',function(){document.getElementById('chapter-error').textContent='';refreshChapterComposer(liveTitle);});
      chapterForm.querySelectorAll('[data-quick-note]').forEach(function(btn){btn.addEventListener('click',function(){var area=document.getElementById('chapter-text'),note=CHAPTER_QUICK_NOTES[Number(btn.dataset.quickNote)];if(!note)return;var lines=area.value.split('\n');if(lines.some(function(line){return line.trim()===note;}))return;var text=area.value+(area.value&&!area.value.endsWith('\n')?'\n':'')+note;if(text.length>2000){document.getElementById('chapter-error').textContent='В заметке не осталось места для этой фразы.';return;}area.value=text;area.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chapter-error').textContent='';});});
      refreshChapterComposer(liveTitle);
    }
    var journeyNav=document.getElementById('app').querySelector('.mt-journey-nav'),activeJourney=journeyNav&&journeyNav.querySelector('[aria-pressed="true"]');
    if(activeJourney)journeyNav.scrollLeft=Math.max(0,activeJourney.offsetLeft-journeyNav.offsetLeft-12);
    function jumpJournal(id){
      var m=selected&&findManhwa(selected.id);if(!m)return;
      var target=Features.journal(m.journal).find(function(e){return e.id===id;});
      if(target&&(target.run||1)!==viewedRun(m)){journalSettings(m).run=target.run||1;render();}
      var list=document.getElementById('journal-list');journalSettings(m).query='';journalSettings(m).entriesOpen=true;var records=document.getElementById('journal-records');if(records)records.hidden=false;var toggle=document.getElementById('journal-records-toggle');if(toggle){toggle.setAttribute('aria-expanded','true');toggle.textContent='Скрыть записи · '+runJournal(m,viewedRun(m)).length;}
      var search=document.getElementById('journal-search');if(search)search.value='';
      if(list)list.innerHTML=journalEntriesHtml(m);
      var entry=document.getElementById('journal-entry-'+id);if(entry){entry.scrollIntoView({block:'center'});entry.focus({preventScroll:true});}
    }
    document.getElementById('app').querySelectorAll('[data-journal-jump]').forEach(function(el){el.addEventListener('click',function(e){e.preventDefault();jumpJournal(el.getAttribute('data-journal-jump'));});});
    bind('journal-quick','click',function(){if(selected)openChapterSheet(selected.id);});
    bind('map-range','change',function(e){document.querySelectorAll('[data-map-block]').forEach(function(el){el.hidden=e.target.value!=='all'&&el.dataset.mapBlock!==e.target.value;});});
    bind('map-download','click',function(e){if(selected)downloadRatingMap(findManhwa(selected.id),e.currentTarget);});
    bind('journal-map-toggle','click',function(){if(!selected)return;var m=findManhwa(selected.id),v=journalSettings(m);v.mapOpen=!v.mapOpen;document.getElementById('journal-rating-map').hidden=!v.mapOpen;var btn=document.getElementById('journal-map-toggle');btn.setAttribute('aria-expanded',String(v.mapOpen));btn.textContent=(v.mapOpen?'Скрыть карту оценок':'Карта оценок глав')+' · '+Features.chapterScores(runJournal(m,viewedRun(m))).length;});
    bind('journal-records-toggle','click',function(){if(!selected)return;var m=findManhwa(selected.id),v=journalSettings(m);v.entriesOpen=!v.entriesOpen;document.getElementById('journal-records').hidden=!v.entriesOpen;var btn=document.getElementById('journal-records-toggle');btn.setAttribute('aria-expanded',String(v.entriesOpen));btn.textContent=(v.entriesOpen?'Скрыть записи':'Все оценки и заметки')+' · '+runJournal(m,viewedRun(m)).length;});
    ['journal-search','journal-sort'].forEach(function(id){bind(id,id==='journal-search'?'input':'change',function(e){var m=selected&&findManhwa(selected.id);if(!m)return;journalSettings(m)[id==='journal-search'?'query':'sort']=e.target.value;document.getElementById('journal-list').innerHTML=journalEntriesHtml(m);});});
    var journalList=document.getElementById('journal-list');
    if(journalList)journalList.onclick=function(e){var el=e.target.closest('[data-journal-delete]');if(!el)return;var m=selected&&findManhwa(selected.id);if(!m)return;var removed=Features.journal(m.journal).find(function(x){return x.id===el.getAttribute('data-journal-delete');});if(!removed||!window.confirm('Удалить запись главы '+removed.chapter+(removed.rating?' вместе с оценкой '+removed.rating+' / 10':'')+'? Отменить удаление можно до перезагрузки страницы.'))return;if(removed)lastUndo={kind:'journal',id:m.id,entry:removed};m.journal=Features.journal(m.journal).filter(function(x){return x.id!==el.getAttribute('data-journal-delete');});m.updatedAt=Date.now();save();render();};
    document.getElementById('app').querySelectorAll('[data-halloween-preview]').forEach(function(el){el.addEventListener('click',function(){halloweenPreview=el.getAttribute('data-halloween-preview');render();});});
    document.getElementById('app').querySelectorAll('[data-halloween-go]').forEach(function(el){el.addEventListener('click',function(){state.tab=el.getAttribute('data-halloween-go');if(state.tab==='catalog'){catalog.genre='Horror';catalog.search='';catalog.status='';catalog.country='';loadCatalog(true);}render();window.scrollTo(0,0);});});
    bind('halloween-wardrobe','click',function(){state.tab='profile';state.shopOpen=false;state.accountSettings=false;state.profileEdit=true;state.profileDraft=sanitizeProfile(state.profile);render();window.scrollTo(0,0);});
    document.getElementById('app').querySelectorAll('[data-journey-section]').forEach(function(el){el.addEventListener('click',function(){state.journeyUI.section=el.getAttribute('data-journey-section');usability.journey=state.journeyUI.section;saveUsability();render();});});
    document.getElementById('app').querySelectorAll('[data-goal-add]').forEach(function(el){el.addEventListener('click',function(){var d=journeyData(),o=Features.goalOptions.find(function(o){return o.id===el.getAttribute('data-goal-add');});if(d.goals.some(function(g){return g.id===o.id;}))return;d.goals.push({id:o.id,started:Date.now(),baseline:Features.goalKeys(state.manhwas,o.metric),earned:[]});state.profile.journey=d;saveProfile();render();});});
    document.getElementById('app').querySelectorAll('[data-goal-remove]').forEach(function(el){el.addEventListener('click',function(){if(!window.confirm('Убрать цель? При повторном выборе прогресс начнётся заново.'))return;var d=journeyData();d.goals=d.goals.filter(function(g){return g.id!==el.getAttribute('data-goal-remove');});state.profile.journey=d;saveProfile();render();});});
    document.getElementById('app').querySelectorAll('.mt-chapter-slider input').forEach(function(el){el.addEventListener('input',function(){
      var caption=Number(el.value)?el.value+' / 10':'Без оценки';
      el.closest('.mt-chapter-slider').querySelector('output').textContent=caption;el.setAttribute('aria-valuetext',caption);
      el.closest('.mt-chapter-slider').style.setProperty('--chapter-fill',(Number(el.value)*10)+'%');el.closest('.mt-chapter-slider').querySelector('.mt-chapter-mood').textContent=chapterRatingMood(Number(el.value));el.setAttribute('aria-valuetext',caption+'. '+chapterRatingMood(Number(el.value)));if(selected)refreshChapterComposer(findManhwa(selected.id)||selected);
    });});
    bind('chapter-form','submit',async function(e){
      e.preventDefault();if(chapterSubmitting)return;var next=e.submitter&&e.submitter.name==='next';var m=selected&&findManhwa(selected.id),text=document.getElementById('chapter-text').value.trim(),rawChapter=document.getElementById('chapter-number').value,chapter=Number(rawChapter),rating=Number(document.getElementById('chapter-rating').value)||null;
      if(!m||!rawChapter||!Number.isFinite(chapter)||chapter<0||chapter>1000000)return;
      if(!text&&!rating){document.getElementById('chapter-error').textContent='Поставь оценку или напиши заметку.';return;}
      if(rating!==null&&(!Number.isInteger(rating)||rating<1||rating>10))return;
      if(rating!==null&&Features.hasChapterRating(runJournal(m),chapter)){document.getElementById('chapter-error').textContent='У главы '+chapter+' уже есть оценка. Можно добавить заметку без оценки или удалить прежнюю запись.';journalSettings(m).query=String(chapter);document.getElementById('journal-search').value=String(chapter);document.getElementById('journal-list').innerHTML=journalEntriesHtml(m);return;}
      m.journal=Features.journal(m.journal);var entry={id:uid(),ts:Date.now(),chapter:chapter,text:text.slice(0,2000),spoiler:document.getElementById('chapter-spoiler').checked};if(rating!==null)entry.rating=rating;if(currentRun(m)>1)entry.run=currentRun(m);
      var progress=Features.readingProgress(m);progress.chapter=Math.max(progress.chapter,chapter);progress.updatedAt=Date.now();m.reading=progress;
      journalSettings(m).query='';
      delete chapterDrafts[m.id];persistChapterDrafts();
      m.journal.push(entry);m.journal=Features.journal(m.journal);m.updatedAt=Date.now();chapterSubmitting=true;
      chapterForm.querySelectorAll('button[type="submit"]').forEach(function(btn){btn.disabled=true;});
      try{save();await Promise.all(Object.keys(storageWrites).map(function(k){return storageWrites[k].catch(function(){});}));
        chapterSaveNotice=Object.keys(failedWrites).length?'Запись добавлена, но сохранение на устройстве требует повторной попытки.':'Глава '+chapter+' сохранена'+(rating?' · '+rating+' / 10':'');
        if(next&&!Object.keys(failedWrites).length&&chapter<1000000){chapterDrafts[m.id]={run:currentRun(m),'chapter-number':String(Math.round((chapter+1)*10)/10),'chapter-rating':'0','chapter-text':'','chapter-spoiler':false};persistChapterDrafts();}
        render();if(next&&!Object.keys(failedWrites).length&&chapter<1000000)openChapterSheet(m.id);
      }finally{chapterSubmitting=false;}
    });

  }

  /* ---------- AniList catalog ---------- */
  var catalog = {search:'',country:'',genre:'',status:'',sort:'POPULARITY_DESC',items:[],page:0,more:false,started:false,loading:false,error:'',detail:null,addStatus:'plan',scroll:0,controller:null,observer:null,cooldown:0};
  var CATALOG_STATUSES=[['','Любой статус'],['RELEASING','Выходит'],['FINISHED','Завершён'],['NOT_YET_RELEASED','Анонсирован'],['HIATUS','На паузе'],['CANCELLED','Отменён']];
  var CATALOG_QUERY='query Catalog($page:Int,$search:String,$country:CountryCode,$genre:String,$status:MediaStatus,$sort:[MediaSort]){Page(page:$page,perPage:24){pageInfo{hasNextPage} media(type:MANGA,format_in:[MANGA,ONE_SHOT],search:$search,countryOfOrigin:$country,genre:$genre,status:$status,sort:$sort){id title{english romaji native} synonyms coverImage{large} genres countryOfOrigin status averageScore chapters volumes description(asHtml:false) startDate{year}}}}';
  function catalogTitle(m){return m.title.english||m.title.romaji||m.title.native||'Без названия';}
  function catalogMatch(media){return state.manhwas.find(function(m){return !Features.unseenMedia([media],[m]).length;});}
  function catalogDescription(media){
    // Render API text as text, never as executable HTML.
    var doc=new DOMParser().parseFromString(String(media.description||'').replace(/<br\s*\/?\s*>/gi,'\n'),'text/html');
    doc.querySelectorAll('script,style,iframe').forEach(function(el){el.remove();});
    return (doc.body.textContent||'').trim().slice(0,12000);
  }
  function saveCatalogFilters(){try{window.sessionStorage.setItem('mt-catalog-filters',JSON.stringify({search:catalog.search,country:catalog.country,genre:catalog.genre,status:catalog.status,sort:catalog.sort}));}catch(e){}}
  function loadCatalogFilters(){try{var saved=JSON.parse(window.sessionStorage.getItem('mt-catalog-filters')||'{}');['search','country','genre','status','sort'].forEach(function(key){if(typeof saved[key]==='string'&&saved[key].length<=200)catalog[key]=saved[key];});}catch(e){}}
  function loadCatalog(reset){
    if(reset)saveCatalogFilters();
    if(catalog.loading&&!reset)return;
    if(catalog.controller)catalog.controller.abort();
    var controller=new AbortController();catalog.controller=controller;
    if(reset){catalog.items=[];catalog.page=0;catalog.more=false;catalog.detail=null;catalog.query={search:catalog.search.trim()||null,country:catalog.country||null,genre:catalog.genre||null,status:catalog.status||null,sort:catalog.search.trim()?['SEARCH_MATCH','ID']:[catalog.sort,'ID']};}
    catalog.started=true;catalog.error='';
    if(Date.now()<catalog.cooldown){catalog.loading=false;catalog.error='AniList просит подождать. Повтори поиск примерно через минуту.';return;}
    if(navigator.onLine===false){catalog.loading=false;catalog.error='Нет интернета. Запрос и фильтры сохранены — подключись к сети и нажми «Повторить».';return;}
    catalog.loading=true;var page=catalog.page+1;
    var timer=setTimeout(function(){controller.abort();},18000);
    fetch('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},signal:controller.signal,body:JSON.stringify({query:CATALOG_QUERY,variables:Features.aniListVariables(Object.assign({page:page},catalog.query))})})
      .then(function(r){if(catalog.controller!==controller)throw new Error('Устаревший запрос');if(r.status===429){catalog.cooldown=Date.now()+Math.max(60,Number(r.headers.get('Retry-After'))||60)*1000;throw new Error('Слишком много запросов к AniList. Подожди минуту и повтори.');}if(catalog.controller!==controller)throw new Error('Устаревший запрос');if(!r.ok)throw new Error('AniList временно недоступен. Попробуй ещё раз.');return r.json();})
      .then(function(r){if(catalog.controller!==controller)return;if(r.errors||!r.data||!r.data.Page||!Array.isArray(r.data.Page.media))throw new Error('Не удалось получить каталог. Попробуй ещё раз.');
        var seen=new Set(catalog.items.map(function(m){return m.id;}));
        r.data.Page.media.forEach(function(m){if(m&&Number.isInteger(m.id)&&m.title&&!seen.has(m.id)){seen.add(m.id);catalog.items.push(m);}});
        catalog.page=page;catalog.more=!!(r.data.Page.pageInfo&&r.data.Page.pageInfo.hasNextPage)&&page<208;
      }).catch(function(e){if(catalog.controller===controller)catalog.error=e.name==='AbortError'?'Каталог не ответил вовремя. Проверь интернет и повтори.':e.message;})
      .finally(function(){clearTimeout(timer);if(catalog.controller!==controller)return;catalog.loading=false;if(state.tab==='catalog'&&!state.selectedId)render();});
  }
  function catalogOptions(items,value){return items.map(function(x){return '<option value="'+escapeHtml(x[0])+'"'+(x[0]===value?' selected':'')+'>'+escapeHtml(x[1])+'</option>';}).join('');}
  function renderCatalog(){
    if(!catalog.started)loadCatalog(true);
    var m=catalog.detail;
    if(m){var owned=catalogMatch(m),release=CATALOG_STATUSES.find(function(x){return x[0]===m.status;});
      return '<section class="mt-catalog-page"><button class="mt-ghost-btn" id="catalog-back">← Каталог</button><article class="mt-catalog-detail"><div class="mt-catalog-detail-top">'+journeyCover({coverUrl:m.coverImage&&m.coverImage.large})+'<div><span class="mt-section-eyebrow">'+escapeHtml(typeById(typeFromCountryOfOrigin(m.countryOfOrigin)).label)+'</span><h1>'+escapeHtml(catalogTitle(m))+'</h1><p>'+escapeHtml(m.title.native||m.title.romaji||'')+'</p><strong>★ '+(m.averageScore==null?'Нет оценки':(m.averageScore/10).toFixed(1)+' / 10')+' · AniList</strong></div></div><div class="mt-catalog-facts"><span>'+escapeHtml(release?release[1]:'Статус неизвестен')+'</span><span>Глав: '+(m.chapters==null?'неизвестно':Number(m.chapters))+'</span><span>Томов: '+(m.volumes==null?'неизвестно':Number(m.volumes))+'</span></div><div class="mt-catalog-genres">'+(m.genres||[]).map(function(g){return '<span>'+escapeHtml(translateAniListGenre(g))+'</span>';}).join('')+'</div><div class="mt-catalog-add">'+(owned?'<p role="status">✓ В библиотеке · '+escapeHtml(statusById(owned.status).label)+'</p><button class="mt-primary-btn" id="catalog-open-library">Открыть в библиотеке</button>':'<label>Добавить со статусом<select id="catalog-add-status" class="mt-input">'+catalogOptions(STATUSES.map(function(s){return [s.id,s.label];}),catalog.addStatus)+'</select></label><label>Коллекция<select id="catalog-add-collection" class="mt-input"><option value="">Без коллекции</option>'+libraryData().collections.map(function(c){return '<option value="'+escapeHtml(c.id)+'"'+(catalog.addCollection===c.id?' selected':'')+'>'+escapeHtml(c.name)+'</option>';}).join('')+'</select></label><button class="mt-primary-btn" id="catalog-add">+ Добавить в библиотеку</button>')+'</div><h2>Об истории</h2><p class="mt-catalog-description">'+escapeHtml(catalogDescription(m)||'Описание пока отсутствует.')+'</p><a class="mt-ghost-btn" href="https://anilist.co/manga/'+m.id+'" target="_blank" rel="noopener noreferrer">Открыть на AniList ↗</a></article></section>';
    }
    var filters=[['country',catalog.country,({'JP':'Манга','KR':'Манхва','CN':'Маньхуа'})[catalog.country]],['genre',catalog.genre,translateAniListGenre(catalog.genre)],['status',catalog.status,(CATALOG_STATUSES.find(function(x){return x[0]===catalog.status;})||[])[1]]].filter(function(x){return x[1];});
    var chips=filters.map(function(x){return '<button type="button" data-catalog-clear="'+x[0]+'">'+escapeHtml(x[2])+' <span aria-hidden="true">×</span><span class="mt-sr-only">Убрать фильтр</span></button>';}).join('');
    return '<section class="mt-catalog-page"><header class="mt-catalog-heading"><div><span class="mt-section-eyebrow">ТВОЯ СЛЕДУЮЩАЯ ИСТОРИЯ</span><h1>Каталог</h1></div><a class="mt-catalog-source" href="https://anilist.co" target="_blank" rel="noopener noreferrer">AniList <span>↗</span></a></header>'+
      '<form id="catalog-search-form" class="mt-catalog-controls"><div class="mt-catalog-search"><input id="catalog-search" class="mt-input" type="search" maxlength="200" aria-label="Название тайтла" placeholder="Найти историю…" value="'+escapeHtml(catalog.search)+'" /><button class="mt-primary-btn" type="submit" aria-label="Найти тайтл"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button></div>'+
      '<div class="mt-catalog-toolbar"><label class="mt-catalog-sort-label"><span aria-hidden="true">↕</span><select class="mt-input" id="catalog-sort" aria-label="Сортировка"'+(catalog.search.trim()?' disabled':'')+'>'+ (catalog.search.trim()?'<option>По совпадению</option>':catalogOptions([['POPULARITY_DESC','Популярные'],['SCORE_DESC','По рейтингу'],['TRENDING_DESC','В тренде'],['START_DATE_DESC','Сначала новые']],catalog.sort))+'</select></label><button type="button" class="mt-catalog-filter-toggle" id="catalog-filter-toggle" aria-controls="catalog-filter-panel" aria-expanded="'+!!catalog.filtersOpen+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/></svg>Фильтры'+(filters.length?'<b>'+filters.length+'</b>':'')+'</button></div>'+
      '<div id="catalog-filter-panel"'+(catalog.filtersOpen?'':' hidden')+'><div class="mt-catalog-filter-heading"><strong>Подбери под настроение</strong><button type="button" id="catalog-reset">Сбросить</button></div><div class="mt-catalog-filters"><label>Тип<select class="mt-input" id="catalog-country">'+catalogOptions([['','Все типы'],['JP','Манга'],['KR','Манхва'],['CN','Маньхуа']],catalog.country)+'</select></label><label>Жанр<select class="mt-input" id="catalog-genre">'+catalogOptions([['','Все жанры']].concat(Object.keys(ANILIST_GENRE_RU).map(function(g){return [g,ANILIST_GENRE_RU[g]];})),catalog.genre)+'</select></label><label>Статус выхода<select class="mt-input" id="catalog-status">'+catalogOptions(CATALOG_STATUSES,catalog.status)+'</select></label></div><p>Фильтры применяются сразу. Для поиска попробуй английское или оригинальное название.</p><button type="button" id="catalog-filters-done" class="mt-ghost-btn">Показать тайтлы</button></div></form>'+
      (chips?'<div class="mt-catalog-chips" aria-label="Выбранные фильтры">'+chips+'</div>':'')+
      '<label class="mt-catalog-hide"><input id="catalog-hide-owned" type="checkbox"'+(usability.hideOwned?' checked':'')+' /> Скрыть добавленные в библиотеку</label>'+
      (usability.hideOwned&&catalog.items.length&&!catalog.items.some(function(m){return !catalogMatch(m);})?'<p class="mt-feature-hint">Все загруженные тайтлы уже в библиотеке. Загрузи ещё или отключи фильтр.</p>':'')+
      '<div class="mt-catalog-results-heading"><h2>'+(catalog.query&&catalog.query.search?'Результаты поиска':filters.length?'Твоя подборка':'Открой для себя')+'</h2><span>'+ (catalog.loading?'Загружаем…':catalog.items.length+' загружено')+'</span></div>'+
      '<div class="mt-catalog-grid" aria-busy="'+catalog.loading+'">'+catalog.items.filter(function(m){return !usability.hideOwned||!catalogMatch(m);}).map(function(m){var owned=catalogMatch(m),type=typeById(typeFromCountryOfOrigin(m.countryOfOrigin)).label;return '<button class="mt-catalog-card" data-catalog-detail="'+m.id+'" title="'+escapeHtml(catalogTitle(m))+'"><span class="mt-catalog-cover">'+journeyCover({coverUrl:m.coverImage&&m.coverImage.large})+'<span class="mt-catalog-cover-shade"></span><span class="mt-catalog-cover-meta"><span>'+escapeHtml(type)+'</span><span class="mt-catalog-score" aria-label="Рейтинг AniList: '+(m.averageScore==null?'нет':m.averageScore/10+' из 10')+'">★ '+(m.averageScore==null?'—':(m.averageScore/10).toFixed(1))+'</span></span>'+(owned?'<span class="mt-catalog-owned" aria-label="В библиотеке" title="В библиотеке">✓</span>':'')+'</span><strong>'+escapeHtml(catalogTitle(m))+'</strong>'+(owned?'<small class="mt-catalog-saved-label">В библиотеке · '+escapeHtml(statusById(owned.status).label)+'</small>':'')+'</button>';}).join('')+
      (catalog.loading&&!catalog.items.length?Array.from({length:6},function(){return '<div class="mt-catalog-skeleton" aria-hidden="true"><span></span><i></i><i></i></div>';}).join(''):'')+'</div>'+
      (catalog.error?'<div class="mt-catalog-message" role="alert">'+escapeHtml(catalog.error)+'<button id="catalog-retry" class="mt-ghost-btn">Повторить</button></div>':catalog.loading?'<p class="mt-catalog-message" role="status">Загружаем истории…</p>':catalog.items.length&&usability.hideOwned&&catalog.items.every(function(m){return !!catalogMatch(m);})?'<div class="mt-catalog-message" role="status">Все загруженные тайтлы уже в библиотеке. Отключи «Скрыть добавленные»'+(catalog.more?' или загрузи следующую страницу.<button id="catalog-more" class="mt-ghost-btn">Ещё истории ↓</button>':'.')+'</div>':!catalog.items.length?'<div class="mt-catalog-message"  role="status"><strong>Эта история пока не нашлась</strong><p>Попробуй оригинальное название или убери часть фильтров.</p></div>':catalog.more?'<button class="mt-ghost-btn" id="catalog-more">Ещё истории ↓</button>':'<p class="mt-feature-hint">'+(catalog.page>=208?'Уточни поиск или фильтры, чтобы посмотреть другие тайтлы.':'Ты посмотрел все результаты этой подборки.')+'</p>')+'<p class="mt-catalog-credit">Обложки и данные · <a href="https://anilist.co" target="_blank" rel="noopener noreferrer">AniList ↗</a><br>Рейтинг на обложке — по шкале 10. Твои оценки хранятся отдельно.</p></section>';
  }
  function attachCatalogHandlers(){
    if(catalog.observer){catalog.observer.disconnect();catalog.observer=null;}
    if(state.tab!=='catalog'||state.selectedId)return;
    function bind(id,event,fn){var el=document.getElementById(id);if(el)el.addEventListener(event,fn);}
    bind('catalog-search','input',function(e){catalog.search=e.target.value;saveCatalogFilters();});
    function toggleFilters(open){catalog.filtersOpen=open;render();document.getElementById('catalog-filter-toggle').focus({preventScroll:true});}
    bind('catalog-filter-toggle','click',function(){toggleFilters(!catalog.filtersOpen);});
    bind('catalog-filters-done','click',function(){toggleFilters(false);});
    bind('catalog-reset','click',function(){catalog.country='';catalog.genre='';catalog.status='';loadCatalog(true);render();});
    document.querySelectorAll('[data-catalog-clear]').forEach(function(el){el.addEventListener('click',function(){catalog[el.getAttribute('data-catalog-clear')]='';loadCatalog(true);render();});});
    bind('catalog-search-form','submit',function(e){e.preventDefault();loadCatalog(true);render();});
    ['country','genre','status','sort'].forEach(function(key){bind('catalog-'+key,'change',function(e){catalog[key]=e.target.value;loadCatalog(true);render();});});
    bind('catalog-retry','click',function(){loadCatalog(false);render();});
    bind('catalog-more','click',function(){loadCatalog(false);render();});
    document.querySelectorAll('[data-catalog-detail]').forEach(function(el){el.addEventListener('click',function(){catalog.detail=catalog.items.find(function(m){return String(m.id)===el.getAttribute('data-catalog-detail');});catalog.scroll=window.scrollY;catalog.addStatus='plan';catalog.addCollection='';render();window.scrollTo(0,0);});});
    bind('catalog-back','click',function(){catalog.detail=null;render();window.scrollTo(0,catalog.scroll);});
    bind('catalog-add-collection','change',function(e){catalog.addCollection=e.target.value;});
    bind('catalog-hide-owned','change',function(e){usability.hideOwned=e.target.checked;saveUsability();render();});
    bind('catalog-add-status','change',function(e){catalog.addStatus=e.target.value;});
    bind('catalog-open-library','click',function(){var found=catalogMatch(catalog.detail);if(found)openTitle(found.id);});
    bind('catalog-add','click',function(){var media=catalog.detail;if(!media||catalogMatch(media))return;
      var m=newManhwa(catalogTitle(media),typeFromCountryOfOrigin(media.countryOfOrigin),media.coverImage&&media.coverImage.large);
      m.status=STATUSES.some(function(s){return s.id===catalog.addStatus;})?catalog.addStatus:'plan';if(m.status==='done')m.completedAt=Date.now();
      m.anilistId=media.id;m.genres=(media.genres||[]).map(translateAniListGenre);m.altTitles={en:media.title.english||media.title.romaji||'',ja:media.countryOfOrigin==='JP'?media.title.native||'':'',ko:media.countryOfOrigin==='KR'?media.title.native||'':'',ru:''};
      m.collectionIds=catalog.addCollection?[catalog.addCollection]:[];
      m.catalogInfo={description:catalogDescription(media),chapters:media.chapters,volumes:media.volumes,status:media.status};
      state.manhwas.push(m);logActivity('add',m.id,displayTitle(m),{type:m.type});save();render();
    });
    var more=document.getElementById('catalog-more');
    if(more&&'IntersectionObserver' in window){catalog.observer=new IntersectionObserver(function(entries){if(entries.some(function(e){return e.isIntersecting;})&&!catalog.loading&&state.tab==='catalog'&&!catalog.detail){loadCatalog(false);render();}},{rootMargin:'150px'});catalog.observer.observe(more);}
  }

  /* ---------- tabbar ---------- */
  function renderTabbar() {
    var tabs = [
      ["library", "Библиотека", ICON_BOOK],
      ["catalog", "Каталог", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></svg>'],
      ["journey", "Для тебя", ICON_BOOK],
      ["awards", "Премия", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 13v5m-4 3h8m-6-3h4v3h-4z"/></svg>'],
      ["profile", "Профиль", ICON_USER]
    ];
    var inner = tabs.map(function (t) {
      var active = state.tab === t[0];
      return (
        '<button class="mt-tab-v2' + (active ? " active" : "") + '" data-tab="' + t[0] + '"' + (active ? ' aria-current="page"' : '') + '>' +
        '<span class="mt-tab-icon-wrap">' + t[2] + "</span>" +
        '<span class="mt-tab-label">' + t[1] + "</span>" +
        "</button>"
      );
    }).join("");
    return '<nav class="mt-tabbar" aria-label="Основная навигация"><div class="mt-nav-brand"><img src="icons/mark.svg" alt=""/><strong>AM TRACKER</strong><span>Личный дневник чтения</span></div><div class="mt-tabbar-inner">' + inner + '</div><div class="mt-nav-note">Хорошие истории<br>заслуживают места.</div></nav>';
  }

  /* Daily navigation and compact controls. */
  var usability={list:false,hideOwned:false,journey:'achievements',detailSection:'rating',returnScroll:0,quickId:null,suppressClick:false};
  var leaveAction=null,leavingProfile=false;
  function saveUsability(){
    try{window.localStorage.setItem('mt-usability-v1',JSON.stringify({list:usability.list,hideOwned:usability.hideOwned,journey:state.journeyUI.section}));}catch(e){}
  }
  function loadUsability(){
    try{var p=JSON.parse(window.localStorage.getItem('mt-usability-v1')||'{}');usability.list=!!p.list;usability.hideOwned=!!p.hideOwned;if(['goals','achievements','halloween'].includes(p.journey))state.journeyUI.section=p.journey;}catch(e){}
  }
  function profileIsDirty(){function normal(p){var v=sanitizeProfile(p);v.style=Features.cleanStyle(v.style);v.library=cleanLibraryData(v.library);v.outfits=v.outfits||[];return JSON.stringify([v.n,v.b,v.a,v.style,v.library,v.outfits,v.journey||null]);}return !!(state.profileEdit&&state.profileDraft&&normal(state.profileDraft)!==normal(state.profile));}
  function showToast(message){
    var el=document.getElementById('usability-toast');if(!el)return;el.textContent=message;el.hidden=false;
    setTimeout(function(){if(el.isConnected)el.hidden=true;},2600);
  }
  function renderUsabilityDialogs(){
    return '<div id="usability-toast" class="mt-toast" role="status" hidden></div><dialog id="profile-leave-dialog" class="mt-action-sheet" aria-labelledby="leave-heading"><span class="mt-section-eyebrow">ТВОИ ИЗМЕНЕНИЯ</span><h2 id="leave-heading">Сохранить перед выходом?</h2><p>Изменения профиля ещё не сохранены.</p><button id="leave-save" class="mt-primary-btn">Сохранить и выйти</button><button id="leave-stay" class="mt-ghost-btn">Продолжить редактирование</button><button id="leave-discard" class="mt-ghost-btn">Отменить изменения</button></dialog>';
  }
  function selectDetailSection(section){
    usability.detailSection=section;
    var app=document.getElementById('app');
    app.querySelectorAll('[data-detail-panel]').forEach(function(el){el.hidden=el.dataset.detailPanel!==section;});
    app.querySelectorAll('[data-detail-section]').forEach(function(el){el.setAttribute('aria-pressed',String(el.dataset.detailSection===section));});
  }
  function attachUsability(selected){
    var app=document.getElementById('app');
    if(selected)selectDetailSection(usability.detailSection);
    app.querySelectorAll('[data-detail-section]').forEach(function(el){el.onclick=function(){selectDetailSection(el.dataset.detailSection);};});
    app.querySelectorAll('[data-journal-jump]').forEach(function(el){el.addEventListener('click',function(){selectDetailSection('journal');},true);});
    var layout=document.getElementById('library-layout');if(layout)layout.onclick=function(){usability.list=!usability.list;saveUsability();render();};
    app.querySelectorAll('[data-style-value]').forEach(function(el){el.onclick=function(){var select=app.querySelector('[data-profile-style="'+el.dataset.styleKind+'"]');select.value=el.dataset.styleValue;select.dispatchEvent(new Event('change',{bubbles:true}));};});
    var leave=document.getElementById('profile-leave-dialog');
    if(leave){
      document.getElementById('leave-stay').onclick=function(){leaveAction=null;leave.close();};
      document.getElementById('leave-discard').onclick=function(){var action=leaveAction;leaveAction=null;leavingProfile=true;state.profileEdit=false;state.profileDraft=null;leave.close();if(action)action();else render();leavingProfile=false;};
      document.getElementById('leave-save').onclick=async function(){var action=leaveAction;leave.close();if(await usability.saveEditor()){leaveAction=null;leavingProfile=true;if(action)action();leavingProfile=false;}};
      leave.addEventListener('click',function(e){if(e.target===leave){leaveAction=null;leave.close();}});
    }
    // Install one delegated guard; its listener reads current state after each render.
    if(!app._profileGuard){
      app._profileGuard=true;
      app.addEventListener('click',function(e){
        var target=e.target.closest('[data-tab],#prof-cancel,#account-settings-back,#season-settings-open,#open-changelog');
        if(!target||leavingProfile||!profileIsDirty())return;
        e.preventDefault();e.stopImmediatePropagation();leaveAction=function(){target.click();};
        document.getElementById('profile-leave-dialog').showModal();
      },true);
    }
  }


  /* ---------- main render ---------- */
  function render() {
    applyUiSettings();
    if(state.tab === "achievements"){state.tab="journey";state.journeyUI.section="achievements";}
    updateGoals();
    if(state.tab==='journey'&&state.journeyUI.section==='halloween')checkAchievements();
    var app = document.getElementById("app");
    var selected = state.selectedId ? editableManhwa(state.selectedId) : null;
    if (state.selectedId && !selected) state.selectedId = null;

    var editorOpen = Array.from(app.querySelectorAll('[data-editor-section][open]')).map(function(el){return el.dataset.editorSection;});
    var activeEl = document.activeElement;
    var focusInfo = null;
    if (activeEl && activeEl.id === "search-input") {
      focusInfo = { start: activeEl.selectionStart, end: activeEl.selectionEnd };
    }

    var body;
    if (state.showChangelog) {
      body = renderChangelog();
    } else if (selected) {
      body = renderDetail(selected);
    } else if (state.tab === "library") {
      body = renderLibrary();
    } else if (state.tab === "journey") {
      body = renderJourney();
    } else if (state.tab === "catalog") {
      body = renderCatalog();
    } else if (state.tab === "awards") {
      body = renderAwardsTab();

    } else {
      body = renderProfile();
    }

    var showTabs = !selected && !state.showChangelog;
    var revealManhwa = state.revealManhwaId ? findManhwa(state.revealManhwaId) : null;
    var seasonHeader=showTabs&&halloweenAppearance()?'<aside class="mt-season-header"><button id="season-event-open"><span aria-hidden="true">☾</span><span><small>AM TRACKER · ОСОБЫЙ ОБЛИК</small><strong>Ночь историй</strong></span></button><div class="mt-season-actions"><button class="mt-icon-round" id="open-changelog" aria-label="Журнал обновлений">' + ICON_BELL + (CHANGELOG.length&&CHANGELOG[0].version!==state.changelogSeenVersion?'<span class="mt-notify-dot"></span>':'') + '</button><button id="season-settings-open" aria-label="Настройки оформления" title="Изменить оформление"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 3-.5 2-2 1.2-2-.6-2 3.4 1.5 1.4v3.2L2.5 15l2 3.4 2-.6 2 1.2.5 2h6l.5-2 2-1.2 2 .6 2-3.4-1.5-1.4v-3.2L21.5 9l-2-3.4-2 .6-2-1.2L15 3Z"/><circle cx="12" cy="12" r="3"/></svg></button></div></aside>':'';
    app.innerHTML = '<div class="mt-shell' + (showTabs ? ' mt-shell-tabs' : ' mt-shell-detail') + '"><div id="storage-notice"></div>' + seasonHeader + extrasUndoHtml() + body + '<div id="data-status" class="mt-data-status" role="status"></div><div id="update-notice"></div>' + "</div>" + (showTabs ? renderTabbar() : "") +
      (selected?'<dialog id="chapter-quick-dialog" class="mt-chapter-sheet" aria-labelledby="chapter-sheet-title"><header><div><span class="mt-composer-eyebrow">МАЛЕНЬКАЯ ИСТОРИЯ · ТВОЯ ОЦЕНКА</span><h2 id="chapter-sheet-title">Оценить главу</h2></div><button class="mt-ghost-btn" id="chapter-sheet-close" aria-label="Закрыть">×</button></header><div id="chapter-sheet-body"></div></dialog>':'')+
      (revealManhwa ? renderRevealOverlay(revealManhwa) : "") + renderAwardPreview() + renderShareCard() + renderUsabilityDialogs();
    patchStorageNotice();
    patchUpdateNotice();
    attachHandlers(selected);
    attachJourneyHandlers(selected);
    attachCatalogHandlers();
    attachShopHandlers();
    attachAcctHandlers();
    editorOpen.forEach(function(key){var section=app.querySelector('[data-editor-section="'+key+'"]');if(section)section.open=true;});
    attachProfileHandlers();
    attachLibraryExtras();
    attachPolishHandlers(selected);
    attachUsability(selected);

    var viewKey = state.showChangelog ? "changelog" :
      (selected ? "detail:" + selected.id : "tab:" + state.tab);
    var viewChanged = viewKey !== lastViewKey;
    lastViewKey = viewKey;

    if (focusInfo) {
      var el = document.getElementById("search-input");
      if (el) {
        el.focus();
        try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch (e) {}
      }
    } else if (viewChanged) {
      window.scrollTo(0, 0);
    }
  }

  /* ---------- event handlers ---------- */
  function attachHandlers(selected) {
    var app = document.getElementById("app");
    app.querySelectorAll('[data-achievement-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () { state.achievementFilter = btn.getAttribute('data-achievement-filter'); render(); });
    });
    app.querySelectorAll('[data-achievement-category]').forEach(function (btn) {
      btn.addEventListener('click', function () { state.achievementCategory = btn.getAttribute('data-achievement-category'); render(); });
    });
    var compare = document.getElementById("compare-from");
    if (compare && selected) compare.addEventListener("change", function () { state.compareFrom[selected.id] = Number(compare.value); render(); });
    var reason = document.getElementById("rating-reason");
    if (reason && selected) reason.addEventListener("input", function () { selected.ratingReason = reason.value.slice(0, 500); saveRatingDrafts(); });
    app.querySelectorAll('[data-year-month]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.awardsMonth = btn.getAttribute('data-year-month'); state.awardsView = 'month';
        state.awardsCategory = null; state.confirmWinnerPick = null; state.awardsCandidatesConfirmed = false;
        render(); window.scrollTo(0,0);
      });
    });
    app.querySelectorAll('[data-awards-month]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.awardsMonth = btn.getAttribute('data-awards-month'); state.awardsCategory = null; state.confirmWinnerPick = null; state.awardsCandidatesConfirmed = false; render();
      });
    });
    app.querySelectorAll('[data-preview-month]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.awardPreview = getWinner(el.getAttribute('data-preview-month'), el.getAttribute('data-preview-category')); render();
      });
    });
    var closeAward = document.getElementById('close-award-preview');
    if (closeAward) closeAward.addEventListener('click', function () { state.awardPreview = null; render(); });
    var openArchive = document.getElementById('open-archive-title');
    if (openArchive) openArchive.addEventListener('click', function () { var id = state.awardPreview.id; state.awardPreview = null; openTitle(id); });
    var shareBtn = document.getElementById('share-rating-card');
    if (shareBtn) shareBtn.addEventListener('click', function () { openShareCard(findManhwa(shareBtn.getAttribute('data-manhwa-id'))); });
    var closeShare = document.getElementById('close-share-card');
    if (closeShare) closeShare.addEventListener('click', function () { closeShareCard(); render(); });
    var nativeShare = document.getElementById('native-share-card');
    if (nativeShare) nativeShare.addEventListener('click', function () {
      navigator.share({ files: [new File([state.shareCard.blob], 'AM-Tracker-rating.png', { type: 'image/png' })] }).catch(function (err) {
        if (err.name !== 'AbortError') { nativeShare.textContent = 'Не удалось отправить — скачай PNG'; }
      });
    });

    // tabs
    app.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        tabScrollPositions[state.tab]=window.scrollY||0;
        state.tab = btn.getAttribute("data-tab");
        state.addingManhwa = false;
        render();
        window.scrollTo(0,tabScrollPositions[state.tab]||0);
      });
    });

    // sort
    app.querySelectorAll("[data-sort]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.sortMode = btn.getAttribute("data-sort");
        render();
      });
    });

    app.querySelectorAll("[data-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-filter");
        state.filterStatus = state.filterStatus === id ? "all" : id;
        render();
      });
    });

    var genreToggle = document.getElementById("genre-filter-toggle");
    if (genreToggle) genreToggle.addEventListener("click", function () {
      state.showGenreFilter = !state.showGenreFilter;
      render();
    });

    app.querySelectorAll("[data-genre-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filterGenre = btn.getAttribute("data-genre-filter");
        state.showGenreFilter = false;
        render();
      });
    });

    var searchInput = document.getElementById("search-input");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        state.searchQuery = searchInput.value;
        render();
      });
    }
    var searchClear = document.getElementById("search-clear-btn");
    if (searchClear) {
      searchClear.addEventListener("click", function () {
        state.searchQuery = "";
        render();
        var el = document.getElementById("search-input");
        if (el) el.focus();
      });
    }

    var toggleSearchBtn = document.getElementById("toggle-search");
    if (toggleSearchBtn) toggleSearchBtn.addEventListener("click", function () {
      state.showSearch = !state.showSearch;
      if (!state.showSearch) {
        state.searchQuery = "";
        state.showGenreFilter = false;
        state.filterGenre = "all";
      }
      render();
      if (state.showSearch) {
        var el = document.getElementById("search-input");
        if (el) el.focus();
      }
    });

    // open manhwa
    app.querySelectorAll("[data-open-id]").forEach(function (el) {
      el.addEventListener("click", function () {
        var id=el.getAttribute("data-open-id");
        if(libraryUI.bulk&&state.tab==='library'&&!state.selectedId&&el.closest('.mt-grid-card')){libraryUI.selected=libraryUI.selected.includes(id)?libraryUI.selected.filter(function(x){return x!==id;}):libraryUI.selected.concat(id);render();return;}
        openTitle(id);
      });
    });

    // status picker: tap the badge to open a panel of all statuses, tap one to pick it
    var statusPickerToggle = document.getElementById("status-picker-toggle");
    if (statusPickerToggle) statusPickerToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      state.statusPickerOpen = !state.statusPickerOpen;
      render();
    });

    app.querySelectorAll("[data-set-status]").forEach(function (row) {
      row.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = row.getAttribute("data-manhwa-id");
        var newStatus = row.getAttribute("data-set-status");
        var m = findManhwa(id);
        state.statusPickerOpen = false;
        if (!m || m.status === newStatus) { render(); return; }
        m.status = newStatus;
        if (m.status === "done") m.completedAt = Date.now();
        save();
        logActivity("status", m.id, displayTitle(m), { status: newStatus });
        render();
      });
    });

    app.querySelectorAll("[data-cycle-type-id]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-cycle-type-id");
        var m = findManhwa(id);
        if (!m) return;
        var idx = TYPES.findIndex(function (t) { return t.id === (m.type || "manhwa"); });
        m.type = TYPES[(idx + 1) % TYPES.length].id;
        save();
        render();
      });
    });

    // delete manhwa (requires confirm tap)
    app.querySelectorAll("[data-delete-id]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-delete-id");
        if (state.confirmDeleteId === id) {
          var deletedTitle = findManhwa(id);
          if(!moveToTrash([id])){render();return;}
          cancelRerating(id);
          purgeAwardReferences(id);
          state.manhwas = state.manhwas.filter(function (m) { return m.id !== id; });
          if (state.selectedId === id) state.selectedId = null;
          state.confirmDeleteId = null;
          save();
          if (deletedTitle) logActivity("delete", id, displayTitle(deletedTitle), null);
          render();
        } else {
          state.confirmDeleteId = id;
          render();
          setTimeout(function () {
            if (state.confirmDeleteId === id) {
              state.confirmDeleteId = null;
              render();
            }
          }, 3000);
        }
      });
    });

    // add manhwa flow
    var startAdd = document.getElementById("start-add-manhwa");
    if (startAdd) startAdd.addEventListener("click", function () {
      state.addingManhwa = true;
      state.pendingType = "manhwa";
      state.pendingTitleDraft = "";
      state.pendingCoverDraft = "";
      state.pendingGenresDraft = [];
      state.pendingAltTitlesDraft = null;
      state.aniListSearching = false;
      state.aniListError = null;
      state.aniListResults = null;
      state.aniListPickedIndex = null;
      render();
      var inp = document.getElementById("new-title-input");
      if (inp) inp.focus();
    });

    var cancelAdd = document.getElementById("cancel-add-manhwa");
    if (cancelAdd) cancelAdd.addEventListener("click", function () {
      aniListRequestId++;
      state.addingManhwa = false;
      state.pendingTitleDraft = "";
      state.pendingCoverDraft = "";
      state.pendingGenresDraft = [];
      state.pendingAltTitlesDraft = null;
      state.aniListSearching = false;
      state.aniListError = null;
      state.aniListResults = null;
      state.aniListPickedIndex = null;
      render();
    });

    var anilistSearchBtn = document.getElementById("anilist-search-btn");
    if (anilistSearchBtn) anilistSearchBtn.addEventListener("click", function () {
      var draftInput = document.getElementById("new-title-input");
      var q = draftInput ? draftInput.value.trim() : "";
      state.pendingTitleDraft = draftInput ? draftInput.value : "";
      if (!q) return;
      searchAniList(q);
    });

    app.querySelectorAll("[data-anilist-pick]").forEach(function (row) {
      row.addEventListener("click", function () {
        var i = parseInt(row.getAttribute("data-anilist-pick"), 10);
        var media = state.aniListResults && state.aniListResults[i];
        if (!media) return;
        state.aniListPickedIndex = i;
        state.pendingCoverDraft = (media.coverImage && media.coverImage.large) || "";
        var mappedType = typeFromCountryOfOrigin(media.countryOfOrigin);
        if (mappedType) state.pendingType = mappedType;
        state.pendingGenresDraft = (media.genres || []).map(translateAniListGenre);
        var altTitles = { en: "", ja: "", ko: "", ru: "" };
        if (media.title && media.title.english) altTitles.en = media.title.english;
        // Native title only means something in its own script — only fill "ja"
        // for manga (JP origin) and "ko" for manhwa (KR origin), never cross them.
        if (mappedType === "manga" && media.title && media.title.native) altTitles.ja = media.title.native;
        if (mappedType === "manhwa" && media.title && media.title.native) altTitles.ko = media.title.native;
        state.pendingAltTitlesDraft = altTitles;
        render();
        var inp = document.getElementById("new-title-input");
        if (inp) inp.focus();
      });
    });

    app.querySelectorAll("[data-pick-type]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var draftInput = document.getElementById("new-title-input");
        var coverInput = document.getElementById("new-cover-input");
        state.pendingTitleDraft = draftInput ? draftInput.value : "";
        state.pendingCoverDraft = coverInput ? coverInput.value : "";
        state.pendingType = btn.getAttribute("data-pick-type");
        render();
        var inp = document.getElementById("new-title-input");
        if (inp) inp.focus();
      });
    });

    var confirmAdd = document.getElementById("confirm-add-manhwa");
    var titleInput = document.getElementById("new-title-input");
    if(titleInput)titleInput.addEventListener("input",function(){state.pendingTitleDraft=titleInput.value;});
    var newCoverInput=document.getElementById("new-cover-input");
    if(newCoverInput)newCoverInput.addEventListener("input",function(){state.pendingCoverDraft=newCoverInput.value;});
    var coverInputEl = document.getElementById("new-cover-input");
    function submitNewManhwa() {
      var val = titleInput ? titleInput.value.trim() : "";
      if (!val) return;
      var dupe = findManhwaByTitle(val);
      if (dupe && !window.confirm("«" + displayTitle(dupe) + "» уже есть в списке. Всё равно добавить ещё раз?")) {
        return;
      }
      var coverVal = coverInputEl ? coverInputEl.value.trim() : "";
      var m = newManhwa(val, state.pendingType, coverVal);
      var pickedMedia = state.aniListResults && state.aniListResults[state.aniListPickedIndex];
      if (pickedMedia) m.anilistId = pickedMedia.id;
      if (state.pendingGenresDraft.length) m.genres = state.pendingGenresDraft.slice();
      if (state.pendingAltTitlesDraft) {
        m.altTitles.en = state.pendingAltTitlesDraft.en || "";
        m.altTitles.ja = state.pendingAltTitlesDraft.ja || "";
        m.altTitles.ko = state.pendingAltTitlesDraft.ko || "";
      }
      state.manhwas.push(m);
      logActivity("add", m.id, displayTitle(m), { type: m.type });
      state.addingManhwa = false;
      state.pendingTitleDraft = "";
      state.pendingCoverDraft = "";
      state.pendingType = "manhwa";
      state.pendingGenresDraft = [];
      state.pendingAltTitlesDraft = null;
      state.aniListSearching = false;
      state.aniListError = null;
      state.aniListResults = null;
      state.aniListPickedIndex = null;
      save();
      render();
    }
    if (confirmAdd) confirmAdd.addEventListener("click", submitNewManhwa);
    if (titleInput) titleInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submitNewManhwa();
    });

    // back button
    var backBtn = document.getElementById("back-btn");
    if (backBtn) backBtn.addEventListener("click", goBack);

    var openChangelogBtn = document.getElementById("open-changelog");
    if (openChangelogBtn) openChangelogBtn.addEventListener("click", function () {
      state.showChangelog = true;
      if (CHANGELOG.length > 0) {
        state.changelogSeenVersion = CHANGELOG[0].version;
        persistChangelogSeen(CHANGELOG[0].version);
      }
      render();
    });

    var changelogBackBtn = document.getElementById("changelog-back-btn");
    if (changelogBackBtn) changelogBackBtn.addEventListener("click", goBack);

    var revealCloseBtn = document.getElementById("reveal-close-btn");
    if (revealCloseBtn) revealCloseBtn.addEventListener("click", goBack);

    var revealBackdrop = document.getElementById("reveal-backdrop");
    if (revealBackdrop) revealBackdrop.addEventListener("click", function (e) {
      if (e.target === revealBackdrop) goBack();
    });

    app.querySelectorAll("[data-pick-winner]").forEach(function (row) {
      row.addEventListener("click", function () {
        var manhwaId = row.getAttribute("data-pick-winner");
        var monthKey = row.getAttribute("data-month");
        var categoryKey = row.getAttribute("data-category");
        var pickKey = monthKey + "|" + categoryKey + "|" + manhwaId;
        if (state.confirmWinnerPick === pickKey) {
          if (setWinner(monthKey, categoryKey, manhwaId)) {
            var wm = findManhwa(manhwaId);
            logActivity("award", manhwaId, wm ? displayTitle(wm) : "", { monthKey: monthKey, categoryKey: categoryKey });
          }
          state.confirmWinnerPick = null;
          render();
        } else {
          state.confirmWinnerPick = pickKey;
          render();
        }
      });
    });

    app.querySelectorAll("[data-toggle-candidate]").forEach(function (row) {
      row.addEventListener("click", function () {
        var manhwaId = row.getAttribute("data-toggle-candidate");
        var monthKey = row.getAttribute("data-month");
        var categoryKey = row.getAttribute("data-category");
        toggleCandidate(monthKey, categoryKey, manhwaId);
        render();
      });
    });

    var candidatePanelToggle = document.getElementById("candidate-panel-toggle");
    if (candidatePanelToggle) candidatePanelToggle.addEventListener("click", function () {
      state.candidatePanelOpen = !state.candidatePanelOpen;
      render();
    });

    var rankLadderToggle = document.getElementById("rank-ladder-toggle");
    if (rankLadderToggle) rankLadderToggle.addEventListener("click", function () {
      state.showAllRanks = !state.showAllRanks;
      render();
    });

    var editCandidatesBtn = document.getElementById("edit-candidates-btn");
    if (editCandidatesBtn) editCandidatesBtn.addEventListener("click", function () {
      state.awardsCandidatesConfirmed = false;
      render();
    });

    var confirmCandidatesBtn = document.getElementById("confirm-candidates-btn");
    if (confirmCandidatesBtn && !confirmCandidatesBtn.hasAttribute("disabled")) {
      confirmCandidatesBtn.addEventListener("click", function () {
        state.awardsCandidatesConfirmed = true;
        render();
      });
    }

    var editWinnersBtn = document.getElementById("edit-winners-btn");
    if (editWinnersBtn) editWinnersBtn.addEventListener("click", function () {
      var monthKey = editWinnersBtn.getAttribute("data-month");
      if (state.confirmEditWinnersMonth === monthKey) {
        editWinners(monthKey);
        state.confirmEditWinnersMonth = null;
        state.awardsCandidatesConfirmed = false;
        render();
      } else {
        state.confirmEditWinnersMonth = monthKey;
        render();
      }
    });

    app.querySelectorAll("[data-awards-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.awardsView = btn.getAttribute("data-awards-view");
        render();
      });
    });

    app.querySelectorAll("[data-award-category]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.awardsCategory = btn.getAttribute("data-award-category");
        state.confirmWinnerPick = null;
        state.awardsCandidatesConfirmed = false;
        render();
      });
    });

    app.querySelectorAll("[data-awards-year]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.awardsYear = parseInt(btn.getAttribute("data-awards-year"), 10);
        render();
      });
    });

    // criterion sliders — live label update on input, full save+render on change
    app.querySelectorAll("[data-slider-crit]").forEach(function (slider) {
      var critId = slider.getAttribute("data-slider-crit");
      slider.addEventListener("input", function () {
        var val = parseFloat(slider.value);
        var label = app.querySelector('[data-score-label="' + critId + '"]');
        if (label) {
          label.textContent = val.toFixed(1);
          label.style.color = criterionColor(val);
        }
        if (selected) {
          var c = selected.criteria.find(function (cc) { return cc.id === critId; });
          if (c) c.score = val;
          if (state.ratingDrafts[selected.id]) saveRatingDrafts();
        }
      });
      slider.addEventListener("change", function () {
        save();
        render();
      });
    });

    // alternative titles
    var copyScoresBtn = document.getElementById("copy-scores-btn");
    if (copyScoresBtn) copyScoresBtn.addEventListener("click", function () {
      var id = copyScoresBtn.getAttribute("data-manhwa-id");
      var m = editableManhwa(id);
      if (!m) return;
      var vi = viewedHistoryIndex(m);
      var text = buildScoreText(m, vi === null ? null : (m.ratingHistory || [])[vi]);

      function showCopied() {
        var original = copyScoresBtn.textContent;
        copyScoresBtn.textContent = "✓ Скопировано";
        setTimeout(function () {
          copyScoresBtn.textContent = original;
        }, 1800);
      }

      function fallbackCopy() {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          var ok = document.execCommand("copy");
          document.body.removeChild(ta);
          if (ok) showCopied();
          else state.error = "Не удалось скопировать — выдели и скопируй текст вручную.";
        } catch (e) {
          state.error = "Не удалось скопировать — выдели и скопируй текст вручную.";
        }
        if (state.error) render();
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showCopied, fallbackCopy);
      } else {
        fallbackCopy();
      }
    });

    function finalizeRating(id, withReview) {
      var m = findManhwa(id);
      if (!m) { cancelRerating(id); render(); return; }
      var wasNew = m.rated === false;
      if(wasNew||state.ratingDrafts[id]){
        var confirmation=document.getElementById('rating-confirm');
        if(!confirmation||!confirmation.checked){var error=document.getElementById('rating-confirm-error');if(error){error.textContent='Проверь критерии и подтверди итоговую оценку перед сохранением.';error.scrollIntoView({block:'center'});}return;}
      }
      delete state.ratingView[id];
      var snap = commitRerating(id);
      if (snap === false) { render(); return; }
      m.rated = true;
      if (wasNew || snap) m.lastRatedAt = Date.now();
      delete state.unlockedIds[id];
      save();
      if (wasNew) {
        logActivity(withReview ? "rated_review" : "rated", m.id, displayTitle(m), { score: average(m.criteria) });
        state.revealManhwaId = id;
      } else if (snap) {
        logActivity(withReview ? "rerated_review" : "rerated", m.id, displayTitle(m),
          { score: average(m.criteria), prevScore: snap.avg });
        state.revealManhwaId = id;
      }
      render();
    }

    var finishBtn = document.getElementById("finish-rating-btn");
    if (finishBtn) finishBtn.addEventListener("click", function () {
      finalizeRating(finishBtn.getAttribute("data-manhwa-id"), false);
    });

    var finishReviewBtn = document.getElementById("finish-rating-review-btn");
    if (finishReviewBtn) finishReviewBtn.addEventListener("click", function () {
      var id = finishReviewBtn.getAttribute("data-manhwa-id");
      var m = findManhwa(id);
      if (m && (!m.notes || !m.notes.trim())) {
        state.error = "Сначала напиши пару слов в заметках выше — или выбери «Без рецензии».";
        render();
        var notesEl = document.getElementById("notes-textarea");
        if (notesEl) notesEl.focus();
        return;
      }
      finalizeRating(id, true);
    });

    var unlockBtn = document.getElementById("unlock-rating-btn");
    if (unlockBtn) unlockBtn.addEventListener("click", function () {
      var id = unlockBtn.getAttribute("data-manhwa-id");
      delete state.ratingView[id];
      state.unlockedIds[id] = true;
      render();
    });

    app.querySelectorAll("[data-rating-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-manhwa-id");
        var v = btn.getAttribute("data-rating-view");
        if (v === "current") delete state.ratingView[id];
        else state.ratingView[id] = parseInt(v, 10);
        render();
      });
    });

    // Keep the selected rating button in view when there are more of them than fit.
    var activeRatingChip = app.querySelector(".mt-rating-chip.active");
    if (activeRatingChip && activeRatingChip.parentNode) {
      var strip = activeRatingChip.parentNode;
      strip.scrollLeft = activeRatingChip.offsetLeft - (strip.clientWidth - activeRatingChip.offsetWidth) / 2;
    }

    var cancelRerate = document.getElementById("cancel-rerate-btn");
    if (cancelRerate) cancelRerate.addEventListener("click", function () {
      cancelRerating(cancelRerate.getAttribute("data-manhwa-id"));
      state.error = null;
      render();
    });

    var rerateBtn = document.getElementById("rerate-btn");
    if (rerateBtn) rerateBtn.addEventListener("click", function () {
      var id = rerateBtn.getAttribute("data-manhwa-id");
      var m = findManhwa(id);
      delete state.ratingView[id];
      if (m) {
        beginRerating(id);
        state.unlockedIds[id] = true;
      }
      render();
    });

    app.querySelectorAll("[data-emotion-pick]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-manhwa-id");
        var m = editableManhwa(id);
        if (!m) return;
        m.emotionRating = parseInt(btn.getAttribute("data-emotion-pick"), 10);
        m.emotionRatedAt = Date.now();
        save();
        render();
      });
    });

    app.querySelectorAll("[data-toggle-tag]").forEach(function (btn) {
      if (btn.hasAttribute("disabled")) return;
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-manhwa-id");
        var m = editableManhwa(id);
        if (!m) return;
        var tag = btn.getAttribute("data-toggle-tag");
        if (!m.tags) m.tags = [];
        var idx = m.tags.indexOf(tag);
        if (idx !== -1) {
          m.tags.splice(idx, 1);
        } else if (m.tags.length < 3) {
          m.tags.push(tag);
        }
        save();
        render();
      });
    });

    app.querySelectorAll("[data-alt-lang]").forEach(function (input) {
      var lang = input.getAttribute("data-alt-lang");
      input.addEventListener("input", function () {
        if (!selected) return;
        if (!selected.altTitles) selected.altTitles = { en: "", ja: "", ko: "", ru: "" };
        selected.altTitles[lang] = input.value;
        if (state.ratingDrafts[selected.id]) saveRatingDrafts();
      });
      input.addEventListener("blur", function () {
        save();
      });
    });

    var coverInput = document.getElementById("cover-url-input");
    if (coverInput) {
      coverInput.addEventListener("input", function () {
        if (!selected) return;
        selected.coverUrl = coverInput.value;
        if (state.ratingDrafts[selected.id]) saveRatingDrafts();
      });
      coverInput.addEventListener("blur", function () {
        save();
        render();
      });
    }

    var notesTextarea = document.getElementById("notes-textarea");
    if (notesTextarea) {
      notesTextarea.addEventListener("input", function () {
        if (!selected) return;
        selected.notes = notesTextarea.value;
        if (state.ratingDrafts[selected.id]) saveRatingDrafts();
      });
      notesTextarea.addEventListener("blur", function () {
        save();
      });
    }

    app.querySelectorAll("[data-add-genre]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-manhwa-id");
        var m = editableManhwa(id);
        if (!m) return;
        var genre = btn.getAttribute("data-add-genre");
        if (!m.genres) m.genres = [];
        if (m.genres.indexOf(genre) === -1) m.genres.push(genre);
        var draftEl = document.getElementById("new-genre-input");
        state.pendingGenreDraft = draftEl ? draftEl.value : "";
        save();
        render();
      });
    });

    app.querySelectorAll("[data-remove-genre]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-manhwa-id");
        var m = editableManhwa(id);
        if (!m) return;
        var genre = btn.getAttribute("data-remove-genre");
        m.genres = (m.genres || []).filter(function (g) { return g !== genre; });
        var draftEl = document.getElementById("new-genre-input");
        state.pendingGenreDraft = draftEl ? draftEl.value : "";
        save();
        render();
      });
    });

    var addGenreBtn = document.getElementById("add-genre-btn");
    var genreInput = document.getElementById("new-genre-input");
    if (addGenreBtn) addGenreBtn.addEventListener("click", function () {
      var id = addGenreBtn.getAttribute("data-manhwa-id");
      var m = editableManhwa(id);
      var val = genreInput ? genreInput.value.trim() : "";
      if (!m || !val) return;
      if (!m.genres) m.genres = [];
      if (m.genres.indexOf(val) === -1) m.genres.push(val);
      state.pendingGenreDraft = "";
      save();
      render();
    });
    if (genreInput) genreInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && addGenreBtn) addGenreBtn.click();
    });

    app.querySelectorAll("[data-delete-crit]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!selected) return;
        var critId = btn.getAttribute("data-delete-crit");
        selected.criteria = selected.criteria.filter(function (c) { return c.id !== critId; });
        save();
        render();
      });
    });

    // add criterion flow
    var startAddCrit = document.getElementById("start-add-crit");
    if (startAddCrit) startAddCrit.addEventListener("click", function () {
      state.addingCriterion = true;
      render();
      var inp = document.getElementById("new-crit-input");
      if (inp) inp.focus();
    });
    var cancelAddCrit = document.getElementById("cancel-add-crit");
    if (cancelAddCrit) cancelAddCrit.addEventListener("click", function () {
      state.addingCriterion = false;
      render();
    });
    var confirmAddCrit = document.getElementById("confirm-add-crit");
    var critInput = document.getElementById("new-crit-input");
    function submitNewCrit() {
      var val = critInput ? critInput.value.trim() : "";
      if (!val || !selected) return;
      selected.criteria.push({ id: uid(), name: val, score: 5 });
      state.addingCriterion = false;
      save();
      render();
    }
    if (confirmAddCrit) confirmAddCrit.addEventListener("click", submitNewCrit);
    if (critInput) critInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submitNewCrit();
    });

    // export to file
    var exportBtn = document.getElementById("export-btn");
    if (exportBtn) exportBtn.addEventListener("click", function () {
      // Wrapped format carries award history, the activity diary, XP and
      // achievements too — a plain array (old exports) still imports fine,
      // just without those.
      var backup = {
        format: "am-tracker-backup",
        version: 7,
        exportedAt: new Date().toISOString(),
        shop: state.shop,
        manhwas: state.manhwas,
        awardWinners: state.awardWinners,
        awardCandidates: state.awardCandidates,
        awardEditUsed: state.awardEditUsed,
        activityLog: state.activityLog,
        totalXp: state.totalXp,
        unlockedAchievements: state.unlockedAchievements,
        profile: state.profile
      };
      var json = JSON.stringify(backup, null, 2);
      var date = new Date().toISOString().slice(0, 10);
      var filename = "manhwa-tracker-backup-" + date + ".json";

      if (window.AndroidBridge && window.AndroidBridge.saveFile) {
        try {
          window.AndroidBridge.saveFile(filename, json);
        } catch (e) {
          state.error = "Ошибка нативного сохранения (AndroidBridge): " + e.message;
          render();
        }
        return;
      }

      // No native bridge (regular browser / installed PWA) — a normal file
      // download works fine here, so there is nothing to warn about.
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoking right away can cancel the download in some browsers.
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    // import from file
    var importBtn = document.getElementById("import-btn");
    var importInput = document.getElementById("import-file-input");
    if (importBtn && importInput) {
      importBtn.addEventListener("click", function () { importInput.click(); });
      importInput.addEventListener("change", function () {
        var file = importInput.files && importInput.files[0];
        if (!file) return;
        if(file.size>25*1024*1024){state.error='Файл слишком большой. Максимум — 25 МБ.';render();return;}
        var reader = new FileReader();
        reader.onload = async function () {
          try {
            var parsed = JSON.parse(reader.result);
            var manhwas, awardWinners, awardCandidates, awardEditUsed, hasAwards;
            var activityLog = null, hasLog = false;
            var totalXp = null, unlockedAchievements = null, hasProgress = false;
            var profile = null;
            var rawList;

            if (Array.isArray(parsed)) {
              // Legacy export (pre-v2) — titles only, no award history in the file.
              rawList = parsed;
              hasAwards = false;
            } else if (isPlainObject(parsed) && Array.isArray(parsed.manhwas)) {
              rawList = parsed.manhwas;
              awardWinners = parsed.awardWinners;
              awardCandidates = sanitizeMonthMap(parsed.awardCandidates, Array.isArray);
              awardEditUsed = isPlainObject(parsed.awardEditUsed) ? parsed.awardEditUsed : {};
              hasAwards = true;
              if (Array.isArray(parsed.activityLog)) {
                activityLog = sanitizeImportedActivityLog(parsed.activityLog);
                hasLog = true;
              }
              // v4+: XP and achievements travel with the backup.
              if (typeof parsed.totalXp === "number" && isFinite(parsed.totalXp) && parsed.totalXp >= 0) {
                totalXp = Math.floor(parsed.totalXp);
                unlockedAchievements = sanitizeImportedAchievements(parsed.unlockedAchievements);
                hasProgress = true;
              }
              // v5+: nickname, bio and avatar.
              if (isPlainObject(parsed.profile)) profile = sanitizeProfile(parsed.profile);
            } else {
              throw new Error("bad format");
            }

            var cleaned = sanitizeImportedManhwas(rawList);
            manhwas = cleaned.list;
            // The file had entries, but none of them were usable — that's a wrong
            // or badly damaged file, not an empty library.
            if (rawList.length > 0 && manhwas.length === 0) throw new Error("bad format");

            var confirmMsg = "Заменить текущий список (" + state.manhwas.length +
              ") данными из файла (" + manhwas.length + ")? Текущие оценки" +
              (hasAwards ? ", награды" : "") + (hasLog ? ", дневник активности" : "") +
              (hasProgress ? ", XP и достижения" : "") + " будут удалены.";
            if (cleaned.skipped > 0) {
              confirmMsg += " Повреждённых записей пропущено: " + cleaned.skipped + ".";
            }
            if (!hasAwards) {
              confirmMsg += " В этом файле нет данных о наградах (старый формат бэкапа) — награды останутся как есть.";
            } else if (!hasLog) {
              confirmMsg += " В этом файле нет дневника активности (более старый бэкап) — текущий дневник останется как есть.";
            }
            if (hasAwards && !hasProgress) {
              confirmMsg += " В этом файле нет XP и достижений (более старый бэкап) — они останутся как есть.";
            }

            var replace = await previewBackup(file.name,parsed,manhwas,cleaned.skipped,confirmMsg);
            if (!replace) return;
            if (replace) {
              state.ratingDrafts = {};
              saveRatingDrafts();
              chapterDrafts=Object.create(null);persistChapterDrafts();
              journalView={};
              state.manhwas = manhwas;
              if (hasAwards) {
                state.awardWinners = normalizeWinners(awardWinners);
                state.awardCandidates = awardCandidates;
                state.awardEditUsed = awardEditUsed;
              }
              if (hasLog) state.activityLog = activityLog;
              if (hasProgress) {
                state.totalXp = totalXp;
                state.shop=Features.cleanShop(parsed.shop === undefined ? state.shop : parsed.shop,totalXp);saveShop();
                state.unlockedAchievements = unlockedAchievements;
              }
              if (profile) {
                state.profile = profile;
                saveProfile();
              }
              state.selectedId = null;
              state.error = null;
              save();
              if (hasAwards) saveAwards();
              if (hasLog) saveActivityLog();
              if (hasProgress) {
                saveXp();
                saveAchievements();
              }
              await Promise.all(Object.keys(storageWrites).map(function(k){return storageWrites[k].catch(function(){});}));
              render();
              if(!Object.keys(failedWrites).length)showToast('Резервная копия восстановлена на устройстве');
            }
          } catch (e) {
            state.error = "Не удалось прочитать файл — проверь, что это резервная копия из этого приложения.";
            render();
          }
        };
        reader.onerror=function(){state.error='Не удалось прочитать файл. Попробуй выбрать его ещё раз.';render();};
        reader.readAsText(file);
        importInput.value = "";
      });
    }
  }

  // Single "go back" action for the in-app ← buttons — closes whichever
  // "sub-page" is currently open, innermost first.
  function goBack() {
    if(profileIsDirty()&&!leavingProfile){leaveAction=goBack;document.getElementById('profile-leave-dialog').showModal();return;}
    if(state.tab==='catalog'&&catalog.detail&&!state.selectedId){catalog.detail=null;render();window.scrollTo(0,catalog.scroll);return;}
    if(state.accountSettings && !state.selectedId && !state.showChangelog){closeAccountSettings();return;}
    if (state.shopOpen && !state.selectedId) { state.shopOpen=false; state.shopPreview=null; state.shopSet=null; render(); return; }
    if (state.shareCard) { closeShareCard(); render(); return; }
    if (state.awardPreview) { state.awardPreview = null; render(); return; }
    if (state.revealManhwaId) {
      state.revealManhwaId = null;
      render();
      return;
    }
    if (state.showChangelog) {
      state.showChangelog = false;
      render();
      return;
    }
    if (state.selectedId) {
      delete state.unlockedIds[state.selectedId];
      saveRatingDrafts();
      delete state.ratingView[state.selectedId];
      state.selectedId = null;
      state.addingCriterion = false;
      state.pendingGenreDraft = "";
      state.candidatePanelOpen = false;
      state.statusPickerOpen = false;
      render();
      window.scrollTo(0,usability.returnScroll||0);
    }
  }

  /* ---------- bridge for sync.js ---------- */

  function readKey(key) {
    if (idbAvailable) return idbGet(key).catch(function () { return undefined; });
    return new Promise(function (resolve) {
      try { var raw = window.localStorage.getItem(key); resolve(raw ? JSON.parse(raw) : undefined); }
      catch (e) { resolve(undefined); }
    });
  }

  function wipeLocalData() {
    libraryUI={collection:'',bulk:false,selected:[],compare:false,compareIds:[]};lastUndo=null;
    chapterDrafts=Object.create(null);persistChapterDrafts();journalView={};
    if(state.journeyUI.discoveryAbort)state.journeyUI.discoveryAbort.abort();
    state.journeyUI.discoveryAbort=null;
    state.journeyUI={mood:"",genre:"",type:"",duelGenre:"",pick:0,section:"achievements",results:[],previousPair:[]};
    state.manhwas = [];
    state.ratingDrafts = {};
    state.recentOpened = {};
    saveRecentOpened();
    state.awardPreview = null;
    closeShareCard();
    state.awardWinners = {};
    state.awardCandidates = {};
    state.awardEditUsed = {};
    state.activityLog = [];
    state.shop = {}; state.shopOpen=false; state.accountSettings=false; state.shopPreview=null; state.shopNotice="";
    state.totalXp = 0;
    state.unlockedAchievements = {};
    state.profile = emptyProfile(); // another person's nickname/avatar must not leak into a different account
    state.selectedId = null;
    applyingRemote = true;
    try {
      save();
      saveShop();
      saveProfile();
      saveAwards();
      saveActivityLog();
      saveXp();
      saveAchievements();
    } finally { applyingRemote = false; }
    render();
  }

  window.AMApp = {
    titles: function () { return state.manhwas; },
    awards: function () { return { w: state.awardWinners, c: state.awardCandidates, e: state.awardEditUsed }; },
    progress: function () { return { x: state.totalXp, a: state.unlockedAchievements, shop: state.shop }; },
    log: function () { return state.activityLog; },
    profile: function () { return state.profile; },
    sanitizeProfile: sanitizeProfile,
    goalRewardXp: Features.goalRewardXp, cleanShop: Features.cleanShop, mergeShop: Features.mergeShop,
    sanitizeTitle: function (obj) { return sanitizeImportedManhwa(obj, {}); },
    loadMeta: function () { return readKey(SYNC_META_KEY); },
    saveMeta: function (meta) { return persistKey(SYNC_META_KEY, meta); },
    wipeLocal: wipeLocalData,

    // Writes changes that arrived from the cloud into the app. Goes straight to
    // storage (not through save()) so it neither re-runs achievements nor
    // triggers another sync.
    commit: function (ch) {
      applyingRemote = true;
      try {
        var del = {}, put = {};
        ch.titles.del.forEach(function (id) { del[id] = true; });
        ch.titles.put.forEach(function (o) { put[String(o.id)] = o; });
        if (ch.titles.del.length || ch.titles.put.length) {
          var placed = {};
          var next = [];
          state.manhwas.forEach(function (m) {
            var id = String(m.id);
            if (del[id]) return;
            if (put[id]) { next.push(put[id]); placed[id] = true; } else next.push(m);
          });
          ch.titles.put.forEach(function (o) { if (!placed[String(o.id)]) next.push(o); });
          state.manhwas = next;
          persistKey(STORAGE_KEY, state.manhwas).catch(function () {});
        }
        if (ch.awards) {
          state.awardWinners = normalizeWinners(ch.awards.w || {});
          state.awardCandidates = ch.awards.c || {};
          state.awardEditUsed = ch.awards.e || {};
          saveAwards();
        }
        if (ch.progress) {
          var nextShop=Features.cleanShop(ch.progress.shop,ch.progress.x||0);
          if(Object.keys(state.shop).some(function(id){return !nextShop[id];}))state.shopNotice='Покупки сверены между устройствами. Оформление сверх доступного баланса не списано — его можно купить позже.';
          state.shop=nextShop;saveShop();
          state.totalXp = ch.progress.x || 0;
          state.unlockedAchievements = ch.progress.a || {};
          saveXp();
          saveAchievements();
        }
        if (ch.profile) {
          state.profile = sanitizeProfile(ch.profile);
          saveProfile();
        }
        if (ch.logReset || ch.logAdd.length) {
          var log = ch.logReset ? [] : state.activityLog.slice();
          log = log.concat(ch.logAdd).sort(function (x, y) { return x.ts - y.ts; });
          if (log.length > ACTIVITY_LOG_MAX) log = log.slice(log.length - ACTIVITY_LOG_MAX);
          state.activityLog = log;
          saveActivityLog();
        }
        render();
      } finally { applyingRemote = false; }
    }
  };

  var waitingWorker=null, updateMessage='', updateRequested=false;
  function patchDataStatus(){
    var el=document.getElementById('data-status');if(!el)return;
    var st=window.AMSync&&window.AMSync.getStatus?window.AMSync.getStatus():{};
    var text=Object.keys(failedWrites).length?'Не всё сохранено — повтори сохранение в уведомлении':pendingStorageWrites?'Сохраняем на устройстве…':'Сохранено на устройстве';
    if(st.signedIn)text+=' · '+acctStatusShort(st);
    el.textContent=text;
    patchDataHealth(st);
  }
  function patchUpdateNotice(){
    var el=document.getElementById('update-notice');if(!el)return;
    el.innerHTML=waitingWorker?'<aside class="mt-update-notice" role="status"><span>'+escapeHtml(updateMessage||'Готово обновление приложения. Установи, когда закончишь ввод.')+'</span><button class="mt-ghost-btn" id="apply-update">Обновить</button></aside>':'';
    var btn=document.getElementById('apply-update');if(btn)btn.onclick=applyAppUpdate;
  }
  async function applyAppUpdate(){
    if(!waitingWorker)return;
    if(profileIsDirty()||state.addingManhwa||state.acct.open||document.querySelector('#chapter-quick-dialog[open]')||state.selectedId){updateMessage='Сначала закончи ввод и вернись в библиотеку. Черновики останутся на устройстве.';patchUpdateNotice();return;}
    await Promise.all(Object.keys(storageWrites).map(function(k){return storageWrites[k].catch(function(){});}));
    if(Object.keys(failedWrites).length||chapterDraftSaveFailed||pendingStorageWrites){updateMessage='Сначала сохрани данные: есть незавершённое или неудачное сохранение.';patchUpdateNotice();return;}
    updateRequested=true;waitingWorker.postMessage({type:'SKIP_WAITING'});
  }
  /* ---------- boot ---------- */
  if(window.visualViewport){
    function updateVisibleViewport(){
      var viewport=window.visualViewport,root=document.documentElement;
      root.style.setProperty('--app-visible-height',viewport.height+'px');
      root.style.setProperty('--app-visible-top',viewport.offsetTop+'px');
      root.classList.toggle('mt-keyboard-open',window.innerHeight-viewport.height>140&&viewport.scale===1);
    }
    window.visualViewport.addEventListener('resize',updateVisibleViewport);
    window.visualViewport.addEventListener('scroll',updateVisibleViewport);
    updateVisibleViewport();
  }
  window.addEventListener('beforeunload',function(e){if(profileIsDirty()){e.preventDefault();e.returnValue='';}});
  loadUsability();
  loadCatalogFilters();
  load().then(loadUiSettings).then(loadProfile).then(loadShop).then(loadRatingDrafts).then(loadRecentOpened).then(loadChapterDrafts).then(render).catch(function () { render(); }).then(function () {
    if (!window.AMSync) return;
    // Repaint only the status line when the sync state changes (so a form the
    // user is typing into is never wiped); a full render when signing in/out.
    window.AMSync.onStatus(function (st, prev) {
      if (st.signedIn !== prev.signedIn || st.verified !== prev.verified || st.owner !== prev.owner) { render(); return; }
      patchAcctStatus(st);
    });
    window.AMSync.start(window.AMApp);
  });

  // IndexedDB is "best effort" by default: under storage pressure the browser
  // may evict it. Ask for persistent storage; silently ignored if unsupported.
  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
  } catch (e) {}

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange',function(){if(updateRequested)window.location.reload();});
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js").then(function(reg){
        function check(){if(reg.waiting&&navigator.serviceWorker.controller){waitingWorker=reg.waiting;patchUpdateNotice();}}
        check();reg.addEventListener('updatefound',function(){var worker=reg.installing;if(worker)worker.addEventListener('statechange',check);});
        document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')reg.update().catch(function(){});});
      }).catch(function () {});
    });
  }
})();



