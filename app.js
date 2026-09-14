(function () {
  "use strict";

  var STORAGE_KEY = "manhwa-tracker:data:v1";
  var AWARDS_STORAGE_KEY = "manhwa-tracker:awards:v1";
  var AWARD_CANDIDATES_STORAGE_KEY = "manhwa-tracker:award-candidates:v1";
  var AWARD_EDIT_USED_STORAGE_KEY = "manhwa-tracker:award-edit-used:v1";
  var ACTIVITY_LOG_STORAGE_KEY = "manhwa-tracker:activity-log:v1";
  var ACTIVITY_LOG_MAX = 3000;
  var XP_STORAGE_KEY = "manhwa-tracker:xp:v1";
  var ACHIEVEMENTS_STORAGE_KEY = "manhwa-tracker:achievements:v1";
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
  function persistKey(key, value) {
    return idbAvailable ? idbSet(key, value) : localSetPromise(key, value);
  }

  function persistChangelogSeen(version) {
    if (idbAvailable) {
      idbSet(CHANGELOG_SEEN_KEY, version).catch(function () {});
    } else {
      try { window.localStorage.setItem(CHANGELOG_SEEN_KEY, version); } catch (e) {}
    }
  }

  var DEFAULT_CRITERIA = ["Рисовка", "Сюжет", "Персонажи", "Темп/Ритм", "Атмосфера"];

  // XP awarded per meaningful action — mirrors the activity-log event types.
  // "add"/"rated"/"award" are also used to seed a one-time XP baseline from
  // the library's existing history (see seedXpFromCurrentState), so a
  // long-time user doesn't start at rank zero after this update.
  var XP_VALUES = { add: 5, rated: 25, rated_review: 45, status: 3, award: 15, delete: 0 };

  // Rank tiers, lowest first. Each needs a strictly higher minXp than the last.
  var RANKS = [
    { name: "Новичок", minXp: 0, gradient: ["#6B7280", "#9CA3AF"], icon: "🌱" },
    { name: "Любитель", minXp: 200, gradient: ["#22C55E", "#4ADE80"], icon: "📖" },
    { name: "Читатель", minXp: 500, gradient: ["#06B6D4", "#22D3EE"], icon: "📚" },
    { name: "Знаток", minXp: 1000, gradient: ["#3B82F6", "#6C93FF"], icon: "🔎" },
    { name: "Ценитель", minXp: 2000, gradient: ["#8B5CF6", "#A78BFA"], icon: "🎭" },
    { name: "Эксперт", minXp: 3500, gradient: ["#EC4899", "#FF5C77"], icon: "⭐" },
    { name: "Мастер", minXp: 5500, gradient: ["#FFB238", "#FFD27A"], icon: "🎖️" },
    { name: "Виртуоз", minXp: 8500, gradient: ["#FF3D9A", "#FFB238"], icon: "💎" },
    { name: "Легенда", minXp: 13000, gradient: ["#FF3D9A", "#FFB238", "#6C93FF"], icon: "👑" }
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

  /* ---------- achievements ---------- */
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
    return state.activityLog.filter(function (e) { return e.type === "rated_review"; }).length;
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
      return (e.type === "rated" || e.type === "rated_review") && e.extra && e.extra.score === 1;
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
    return state.manhwas.some(function (m) { return average(m.criteria) === 100; });
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

  // Persists newly-met achievements permanently — once unlocked, never
  // re-checked or revoked even if the underlying stat later drops (e.g. a
  // title gets deleted). Called after every logged action.
  function checkAchievements() {
    var unlocked = [];
    ACHIEVEMENTS.forEach(function (a) {
      if (state.unlockedAchievements[a.id]) return;
      if (a.check()) {
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
    { id: "reading", label: "Читаю", color: "#22D3EE" },
    { id: "done", label: "Завершено", color: "#34D399" },
    { id: "dropped", label: "Дропнул", color: "#FF5C77" },
    { id: "plan", label: "В планах", color: "#FFB238" }
  ];

  var TYPES = [
    { id: "manhwa", label: "Манхва", color: "#FF5C77" },
    { id: "manga", label: "Манга", color: "#6C93FF" },
    { id: "manhua", label: "Маньхуа", color: "#F3A93C" }
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

  // type: "feature" (новое) | "update" (обновление) | "fix" (исправление)
  var CHANGELOG = [
    {
      version: "62",
      type: "feature",
      title: "Все ранги в одном месте",
      items: [
        "На вкладке «Профиль», под панелью ранга — кнопка «Все ранги», разворачивает полную лестницу всех 9 рангов",
        "Пройденные ранги подсвечены и с галочкой, текущий выделен отдельно («ВЫ ЗДЕСЬ»), будущие — приглушены, с диапазоном XP для каждого"
      ]
    },
    {
      version: "61",
      type: "feature",
      title: "Работает как Telegram Mini App",
      items: [
        "Приложение теперь можно открыть внутри Telegram по кнопке у бота — без переустановки и без сервера, тот же сайт",
        "Внутри Telegram шапка/фон подстраиваются под тёмную тему приложения, а системная кнопка «назад» Telegram сворачивает открытую карточку/чейнджлог так же, как кнопка ← в самом приложении",
        "Вне Telegram (обычный браузер, установленный PWA) — ничего не изменилось, всё работает как раньше"
      ]
    },
    {
      version: "60",
      type: "feature",
      title: "Достижения — отдельная вкладка, в разы больше ачивок",
      items: [
        "Новая вкладка «Ачивки» между «Премией» и «Профилем»",
        "Список вырос с 19 до 55 достижений — по категориям: Библиотека, Жанры и типы, Оценки, Рецензии, Премии, Статусы, Активность, Ранг",
        "Новое: отдельные ачивки за победу в каждой номинации премии, «Тайтл года», разнообразие жанров, все 3 типа сразу, идеальная оценка 100/100, дропы, серии активности до 100 дней подряд, «сова»/«жаворонок» и марафон из 10+ действий за день",
        "Проверка достижений теперь идёт при любом сохранении, а не только при оценке/статусе/наградах — жанры, теги и свои критерии тоже учитываются"
      ]
    },
    {
      version: "59",
      type: "update",
      title: "Чище шапка библиотеки",
      items: [
        "Убрали подзаголовок «Рисовка, сюжет, персонажи — раздельно»",
        "Кнопка «Жанры» теперь показывается только в режиме поиска, а не постоянно"
      ]
    },
    {
      version: "58",
      type: "feature",
      title: "Достижения",
      items: [
        "На вкладке «Профиль» — 19 достижений за разные действия: рост библиотеки, оценки, рецензии, победы в премиях (включая «Худший тайтл» и «Обложку месяца»), дропы, серии дней подряд, максимальный ранг и антирекорд «Дно»",
        "Каждое достижение даёт разовый бонус к опыту при разблокировке",
        "Достижение остаётся навсегда, даже если позже показатель, за который оно дано, снизится (например, удалили тайтл)",
        "При первом запуске после обновления уже накопленная история учитывается сразу — часть достижений может открыться в момент обновления"
      ]
    },
    {
      version: "57",
      type: "feature",
      title: "Рецензия при первой оценке — больше опыта",
      items: [
        "При первой оценке тайтла — выбор: «Без рецензии» (как раньше) или «С рецензией»",
        "«С рецензией» требует пару слов в заметках перед тем, как оценка засчитается, зато даёт заметно больше опыта (45 XP против 25)",
        "В дневнике тайтла такая оценка помечена отдельной иконкой 📝"
      ]
    },
    {
      version: "56",
      type: "update",
      title: "Смена статуса — через панель, а не по кругу",
      items: [
        "На странице тайтла тап по статусу чтения больше не переключает его по кругу — открывается панель со всеми статусами, выбираешь нужный сразу",
        "Текущий статус в панели помечен галочкой"
      ]
    },
    {
      version: "55",
      type: "feature",
      title: "Ранги и опыт",
      items: [
        "Новая система рангов на вкладке «Профиль»: за оценку тайтла, добавление, смену статуса и победу в премии начисляется опыт (XP) — по-разному за каждое действие",
        "9 рангов от «Новичка» до «Легенды», у каждого свой цвет, иконка и порог опыта",
        "Значок текущего ранга — в шапке профиля, подробная карточка с прогресс-баром до следующего ранга — под статистикой",
        "Опыт не начинается с нуля: при первом запуске после обновления он один раз пересчитывается на основе уже накопленной истории (оценённые тайтлы, добавленные тайтлы, выигранные премии)",
        "У «Легенды» (максимальный ранг) — особый переливающийся блик на карточке"
      ]
    },
    {
      version: "54",
      type: "fix",
      title: "IndexedDB: один сбой чтения больше не откатывает всё",
      items: [
        "Раньше сбой чтения даже одного из шести значений заставлял приложение навсегда откатиться на устаревший снимок в localStorage за всю сессию",
        "Теперь каждое значение читается независимо — единичный сбой просто получает пустое значение по умолчанию, а не рушит остальные пять"
      ]
    },
    {
      version: "53",
      type: "feature",
      title: "Обложка месяца + крупнее тепловая карта",
      items: [
        "Новая номинация «Обложка месяца» — участвуют тайтлы с загруженной обложкой, сортировка по критерию «Рисовка» (своей оценки для обложки отдельно нет)",
        "Клетки тепловой карты активности теперь растягиваются на всю ширину карточки, а не жмутся мелкими квадратиками в углу"
      ]
    },
    {
      version: "52",
      type: "update",
      title: "Дневник — теперь у каждого тайтла свой",
      items: [
        "Тепловая карта в «Профиле» теперь показывает активность за месяц, а не за год",
        "Общий дневник со вкладки «Профиль» убран",
        "Вместо него — свой дневник на странице каждого тайтла: что с ним происходило (добавление, оценка, смена статуса, победы в премиях)"
      ]
    },
    {
      version: "51",
      type: "update",
      title: "Хранилище данных — IndexedDB",
      items: [
        "Приложение теперь хранит все данные в IndexedDB вместо localStorage — снят практический потолок в ~5-10 МБ, актуально по мере роста библиотеки, обложек и дневника активности",
        "Перенос старых данных происходит автоматически и один раз, при первом запуске после обновления — ничего делать не нужно",
        "Если IndexedDB недоступен в браузере — приложение само переключится обратно на localStorage, как раньше"
      ]
    },
    {
      version: "50",
      type: "feature",
      title: "Дневник и тепловая карта активности",
      items: [
        "На вкладке «Профиль» — тепловая карта активности за год (как контрибуции на GitHub) и лента последних событий: что добавлено, что оценено (и с каким баллом), смены статуса, победы в премиях, удаления",
        "Работает только вперёд — прошлые действия до этого обновления в дневнике не появятся, он начинает считать с этого момента",
        "Дневник теперь тоже входит в резервную копию (экспорт/импорт файлом)"
      ]
    },
    {
      version: "49",
      type: "update",
      title: "Дно есть дно",
      items: [
        "Если все критерии оценены на 1 — итоговая оценка тоже 1, а не 10 (обычная формула ×10 в этом случае не применяется)",
        "На карточке такого тайтла рядом со статусом чтения появляется 🤮"
      ]
    },
    {
      version: "48",
      type: "update",
      title: "Новая формула: без весов и множителей",
      items: [
        "Итог теперь — простое среднее по всем 5 критериям (Рисовка, Сюжет, Персонажи, Темп/Ритм, Атмосфера), у всех равный вес",
        "Атмосфера больше не множитель — обычный критерий наравне с остальными",
        "1 балл в любом из пяти критериев = 2 балла в итоговой оценке (шкала 10–100)",
        "Проценты веса рядом с критериями убраны — они больше не нужны"
      ]
    },
    {
      version: "47",
      type: "update",
      title: "Кнопка добавления тайтла — новый вид",
      items: [
        "«Добавить манхву» теперь с градиентом розовый→янтарь, кружком-иконкой и лёгким бликом — вместо простой пунктирной рамки"
      ]
    },
    {
      version: "46",
      type: "update",
      title: "Русское название в списке, кнопка добавления — наверх",
      items: [
        "В главном списке тайтлы теперь подписаны русским альтернативным названием (если оно указано), а не оригинальным — сортировка по алфавиту тоже ориентируется на него",
        "Кнопка «+ Добавить манхву» переехала наверх списка, над всеми тайтлами"
      ]
    },
    {
      version: "45",
      type: "feature",
      title: "Корейское название манхвы",
      items: [
        "На карточке тайтла добавилось поле «Корейское название» — по аналогии с японским для манги",
        "При выборе манхвы через поиск на AniList корейское название (родная запись) подтягивается автоматически",
        "Поиск по библиотеке теперь учитывает и его тоже"
      ]
    },
    {
      version: "44",
      type: "fix",
      title: "AniList: видно настоящую причину ошибки",
      items: [
        "Если поиск на AniList не срабатывает (лимит запросов, сбой API, сеть), теперь показывается реальная причина вместо общего «ничего не нашлось»",
        "Подсказка при пустом результате: AniList распознаёт в основном английские/ромадзи названия, а не переводы фан-групп"
      ]
    },
    {
      version: "43",
      type: "feature",
      title: "Автозаполнение через AniList",
      items: [
        "При добавлении тайтла — кнопка «Найти на AniList»: ищет по введённому названию и показывает подходящие варианты с обложкой",
        "При выборе варианта автоматически подтягиваются обложка, жанры, английское название и тип (манхва/манга/маньхуа определяется по стране происхождения)",
        "Работает как подсказка — все поля перед добавлением можно поправить руками, а если ничего не найдётся, форма как обычно заполняется вручную"
      ]
    },
    {
      version: "42",
      type: "feature",
      title: "Превью кандидатов следующего месяца",
      items: [
        "Во вкладке «Премия», под победителями завершённого месяца, теперь показываются кандидаты, уже отмеченные для текущего (ещё не завершённого) месяца",
        "Список только для просмотра — тап по тайтлу открывает его карточку, отмечать кандидатов по-прежнему нужно со страницы тайтла или во вкладке «Премия» после завершения месяца"
      ]
    },
    {
      version: "41",
      type: "fix",
      title: "Победитель премии не сохранялся после удаления тайтла",
      items: [
        "Если удалить тайтл, который уже выиграл номинацию (например «Худший тайтл месяца»), приложение больше не считает эту номинацию занятой навсегда — теперь можно выбрать победителя заново",
        "При удалении тайтла его больше не остаётся «висящим» в списках кандидатов и победителей"
      ]
    },
    {
      version: "40",
      type: "update",
      title: "Кандидат в премию — компактнее",
      items: [
        "На странице тайтла список номинаций спрятан за одну кнопку под обложкой",
        "На кнопке сразу видно, сколько номинаций уже отмечено (например «2/3»), не открывая список"
      ]
    },
    {
      version: "39",
      type: "fix",
      title: "Бэкап, антипремия и повторы",
      items: [
        "Экспорт/импорт теперь сохраняет и восстанавливает награды (победителей, кандидатов, использованные правки), а не только список тайтлов — старые файлы бэкапа по-прежнему читаются, просто без наград",
        "«Худший тайтл месяца» больше не даёт золотую рамку обложке и не считается победой при подсчёте «Тайтла года» — у него своя иконка 🗑️ вместо кубка",
        "При добавлении тайтла с уже существующим названием — предупреждение с подтверждением, чтобы не задвоить случайно"
      ]
    },
    {
      version: "38",
      type: "feature",
      title: "Кандидат в премию — прямо со страницы тайтла",
      items: [
        "На странице манхвы появилась панель «Кандидат в премию» — можно сразу отметить нужные номинации, не заходя во вкладку «Премия»",
        "Показываются только ещё не решённые номинации того месяца, к которому относится тайтл",
        "Новая номинация «Худший тайтл месяца» — присуждается тайтлу с самой низкой итоговой оценкой"
      ]
    },
    {
      version: "37",
      type: "feature",
      title: "Копирование оценок текстом",
      items: [
        "На странице манхвы — кнопка «📋 Копировать оценки»",
        "В буфер обмена копируется название, итоговая оценка, разбивка по критериям и теги",
        "Работает и в вебе, и в Android-приложении (с запасным способом на случай, если основной недоступен)"
      ]
    },
    {
      version: "36",
      type: "update",
      title: "У каждого критерия свой вес",
      items: [
        "Формула теперь взвешенная: Сюжет 35% — Рисовка 28% — Темп/Ритм 22% — Персонажи 15%, всё умножается на Атмосферу",
        "Максимум по-прежнему ровно 100 — веса подобраны так, чтобы это не сломать",
        "Процент веса каждого критерия виден прямо рядом с названием на карточке манхвы"
      ]
    },
    {
      version: "35",
      type: "update",
      title: "«Динамика» переименована в «Темп/Ритм»",
      items: [
        "Более понятное название того же критерия — суть и формула не изменились",
        "У всех уже добавленных тайтлов название переименовалось автоматически, включая уже выбранные награды за эту номинацию"
      ]
    },
    {
      version: "34",
      type: "update",
      title: "Золотая рамка у победителей",
      items: [
        "У тайтлов, выигравших хоть одну награду, обложка теперь с тонкой золотой рамкой — в общей сетке и на странице тайтла",
        "Сделано ненавязчиво, чтобы не спорило с самим кубком-значком"
      ]
    },
    {
      version: "33",
      type: "update",
      title: "Шкала оценки до 100",
      items: [
        "Максимум итоговой оценки теперь ровно 100 (было 90)",
        "Формула та же по структуре: (Рисовка + Сюжет + Персонажи + Динамика) × 0.25 × Атмосфера",
        "Уже выставленные оценки автоматически пересчитаются по новой формуле — ничего вручную переставлять не нужно"
      ]
    },
    {
      version: "32",
      type: "update",
      title: "Победители — теперь с обложками",
      items: [
        "«Победители месяца», «Тайтл года» и «Все чемпионы года» показываются карточками с обложкой, а не просто текстом",
        "Карточки можно листать свайпом влево-вправо",
        "Тап по карточке открывает тайтл"
      ]
    },
    {
      version: "31",
      type: "fix",
      title: "Пропавшие кандидаты в наградах",
      items: [
        "У тайтлов из самого первого массового импорта не было поля «оценено» вообще — награды считали их неоценёнными и не допускали до номинаций",
        "Теперь при запуске они автоматически помечаются как оценённые наравне с остальными"
      ]
    },
    {
      version: "30",
      type: "feature",
      title: "Разовая правка победителей",
      items: [
        "После выбора всех победителей месяца доступна кнопка «Изменить кандидатов и победителей»",
        "Сработает только один раз за месяц — список кандидатов сохраняется, нужно заново выбрать только победителей",
        "После использования кнопка исчезает до начала следующего месяца"
      ]
    },
    {
      version: "29",
      type: "update",
      title: "Ручной выбор кандидатов на премию",
      items: [
        "Больше никакого авто-топ-5 — сам отмечаешь, кто вообще претендует на награду в каждой номинации",
        "Выбор победителя теперь с подтверждением и необратим — один раз выбрал, и всё",
        "Список кандидатов можно менять, пока победитель ещё не выбран (или один раз позже — через правку победителей)",
        "Когда решены все номинации месяца — вкладка показывает просто список победителей"
      ]
    },
    {
      version: "28",
      type: "fix",
      title: "Награды для импортированных тайтлов",
      items: [
        "Тайтлы с нестандартным ID (например, из массового импорта списком) не получали дату добавления и никогда не участвовали в наградах",
        "Теперь при запуске им автоматически проставляется дата — и они сразу попадают в текущие номинации"
      ]
    },
    {
      version: "27",
      type: "fix",
      title: "Округление итоговой оценки",
      items: [
        "Итоговая оценка (0–90) теперь всегда целое число — например 69 вместо 68.9",
        "Оценки отдельных критериев (Рисовка, Сюжет и т.д.) по-прежнему с шагом 0.5, как и раньше"
      ]
    },
    {
      version: "26",
      type: "update",
      title: "Новая формула итоговой оценки",
      items: [
        "Итог теперь считается так: (Рисовка + Сюжет + Персонажи + Динамика) × 0.225 × Атмосфера",
        "Атмосфера действует как множитель — сильно влияет на итог, а не просто ещё один критерий",
        "Шкала итоговой оценки — от 0 до 90 вместо прежних 1–10",
        "Свои дополнительные критерии в формулу не входят — они по-прежнему просто для себя"
      ]
    },
    {
      version: "25",
      type: "feature",
      title: "Окно первой оценки",
      items: [
        "При первом завершении оценки тайтла появляется красивое окно: обложка → штамп с оценкой (с лёгкой анимацией) → заметка, если она есть",
        "Показывается только один раз — при повторном изменении оценки уже не появляется"
      ]
    },
    {
      version: "24",
      type: "update",
      title: "Вкладка «Премия» — по одной номинации",
      items: [
        "В шапке — кнопки-переключатели всех номинаций месяца",
        "Кандидаты показываются сразу для выбранной номинации, без прокрутки всего списка",
        "Уже решённые номинации помечены значком 🏆 в самой кнопке"
      ]
    },
    {
      version: "23",
      type: "fix",
      title: "Обложка на карточке манхвы",
      items: [
        "Обложка теперь показывается целиком, в реальных пропорциях, без обрезки",
        "На заднем плане — размытая копия той же обложки"
      ]
    },
    {
      version: "22",
      type: "update",
      title: "Ребрендинг: AM - Tracker",
      items: [
        "Новое название приложения и новая иконка",
        "Фон и системные цвета подстроены под новый логотип"
      ]
    },
    {
      version: "21",
      type: "feature",
      title: "Заметки, сортировка по дате, итоги года",
      items: [
        "Личные заметки/рецензия на карточке манхвы — свободный текст",
        "Новая сортировка библиотеки «завершено» — по дате перехода в статус Завершено",
        "Во вкладке «Премия» — переключатель Месяц/Год: итоги года, жанр года, «Тайтл года» по числу месячных побед"
      ]
    },
    {
      version: "20",
      type: "update",
      title: "Отдельная вкладка «Премия»",
      items: [
        "Выбор победителей месяца вынесен из профиля в отдельную вкладку между Библиотекой и Профилем",
        "Открывается сразу — без лишнего перехода"
      ]
    },
    {
      version: "19",
      type: "update",
      title: "Ручной выбор победителей",
      items: [
        "Награды больше не присуждаются автоматически — теперь показывается топ-5 кандидатов по каждой номинации",
        "Победителя в каждой категории выбираешь сам на экране «Церемония» в профиле",
        "Выбор можно изменить в любой момент"
      ]
    },
    {
      version: "18",
      type: "feature",
      title: "Ежемесячные награды",
      items: [
        "1 числа подводятся итоги прошлого месяца: «Тайтл месяца» и лучшие по каждому критерию среди добавленных в этом месяце",
        "Награды победителей показываются прямо на карточке манхвы",
        "В профиле — сводка «Церемония» с итогами последнего завершённого месяца",
        "Дата добавления теперь сохраняется у каждого тайтла (у старых тайтлов восстановлена автоматически)"
      ]
    },
    {
      version: "17",
      type: "fix",
      title: "Карточки и упрощение оценки",
      items: [
        "Оценка на карточках снова цветная по значению (красный/жёлтый/зелёный), а не всегда жёлтая",
        "Убрано обрезание бейджа с оценкой на обложке",
        "Первое впечатление (звёзды) больше не блокирует оценку на 12 часов — сразу открывает полную шкалу критериев"
      ]
    },
    {
      version: "16",
      type: "update",
      title: "Редизайн интерфейса",
      items: [
        "Новая палитра: розовый акцент, янтарные оценки, голубой статус «Читаю»",
        "Карточки в сетке — название и тип под обложкой, компактный бейдж статуса",
        "Плавающая нижняя навигация с иконками",
        "Колокольчик с индикатором новых обновлений вместо часов, поиск теперь скрывается за иконкой",
        "Лёгкие анимации: появление карточек, пружинистые нажатия"
      ]
    },
    {
      version: "15",
      type: "feature",
      title: "Журнал обновлений",
      items: ["Кнопка со списком всех изменений приложения по версиям"]
    },
    {
      version: "14",
      type: "update",
      title: "Единая блокировка карточки",
      items: [
        "Теги, жанры, альт-названия и обложка теперь заполняются один раз и блокируются вместе с оценкой",
        "Кнопка «Изменить» перенесена в самый низ страницы манхвы",
        "Обложка теперь показывается баннером в самом верху карточки"
      ]
    },
    {
      version: "13",
      type: "feature",
      title: "Двухфазная оценка и теги",
      items: [
        "Быстрая эмоциональная оценка (1–5 звёзд) сразу после прочтения",
        "Полная шкала критериев открывается только через 12 часов — против импульсивных оценок",
        "Теги «Сильные / слабые стороны» — до 3 штук на тайтл",
        "В профиле — блок «Часто отмечаешь» по тегам"
      ]
    },
    {
      version: "12",
      type: "fix",
      title: "Прокрутка страницы",
      items: [
        "Страница больше не дёргается наверх при каждом действии — только при смене экрана"
      ]
    },
    {
      version: "11",
      type: "fix",
      title: "Равные карточки в сетке",
      items: [
        "Исправлена разная ширина/высота карточек из-за длинных слов в названиях"
      ]
    },
    {
      version: "10",
      type: "update",
      title: "Упрощение главного меню",
      items: [
        "Удаление манхвы теперь возможно только внутри её карточки",
        "Фильтр по жанрам спрятан за отдельной кнопкой",
        "Из фильтра статусов убрана лишняя кнопка «Все» — повторный тап по активному статусу сбрасывает фильтр"
      ]
    },
    {
      version: "9",
      type: "fix",
      title: "Плашка статуса",
      items: ["Статус-бейдж на обложке больше не наезжает на кнопку удаления"]
    },
    {
      version: "8",
      type: "fix",
      title: "Выравнивание карточек",
      items: ["Названия теперь всегда занимают место под 2 строки — карточки в ряду не съезжают"]
    },
    {
      version: "7",
      type: "update",
      title: "Порядок блоков карточки",
      items: ["Оценки теперь показываются сверху, жанры/названия/обложка — снизу"]
    },
    {
      version: "6",
      type: "feature",
      title: "Обложки и жанры",
      items: [
        "Обложка по ссылке (URL)",
        "Жанры с готовыми подсказками и своими вариантами",
        "Сетка карточек-постеров вместо списка",
        "Фильтр и поиск по жанрам"
      ]
    },
    {
      version: "5",
      type: "feature",
      title: "Защита данных и метаданные",
      items: [
        "Удаление манхвы теперь с подтверждением (два тапа)",
        "Альтернативные названия — английское / японское / русское",
        "Оценка ставится один раз, потом только просмотр, изменить — по кнопке"
      ]
    },
    {
      version: "4",
      type: "feature",
      title: "Типы и поиск",
      items: [
        "Тип тайтла: манхва / манга / маньхуа",
        "Поиск по названию",
        "Фильтр по статусу"
      ]
    },
    {
      version: "3",
      type: "feature",
      title: "Профиль",
      items: [
        "Вкладка «Профиль» со статистикой",
        "Разбивка по статусам, средняя оценка, топ и аутсайдеры",
        "Резервное копирование — сохранить/загрузить из файла"
      ]
    },
    {
      version: "2",
      type: "update",
      title: "Тёмная тема",
      items: ["Полный редизайн: тёмный фон, радар-диаграмма критериев вместо просто списка чисел"]
    },
    {
      version: "1",
      type: "feature",
      title: "Первая версия",
      items: ["Оценка манхвы по критериям: рисовка, сюжет, персонажи, динамика, атмосфера"]
    }
  ];

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
    totalXp: 0,
    unlockedAchievements: {},
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
    confirmClear: false,
    confirmDeleteId: null,
    confirmWinnerPick: null,
    awardsCandidatesConfirmed: false,
    candidatePanelOpen: false,
    statusPickerOpen: false,
    showAllRanks: false,
    unlockedIds: {},
    error: null
  };

  /* ---------- helpers ---------- */
  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  // Scoring formula: plain average of the 5 default criteria (equal weight,
  // Атмосфера included like any other — no more multiplier), scaled ×10 onto
  // a 1–100 scale. With all 5 present, moving one criterion by 1 point moves
  // the final score by exactly 2 (1/5 of the average × 10).
  // Custom (non-default) criteria still don't factor into this — informational only.

  function buildScoreText(m) {
    var avg = average(m.criteria);
    var lines = [];
    lines.push(m.title);
    lines.push("Итоговая оценка: " + (avg === null ? "—" : Math.round(avg)) + "/100");
    lines.push("");
    m.criteria.forEach(function (c) {
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
    if (v === null || v === undefined) return "#8880A0";
    if (v < 50) return "#FF5C77";
    if (v < 75) return "#F3A93C";
    return "#34D399";
  }

  // Same idea as scoreColor but for a single criterion's raw 1–10 value
  // (used for sliders/bars and criterion-specific award nominees).
  function criterionColor(v) {
    if (v === null || v === undefined) return "#8880A0";
    if (v < 5) return "#FF5C77";
    if (v < 7.5) return "#F3A93C";
    return "#34D399";
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

  var AWARD_CATEGORY_KEYS = ["overall", "worst"].concat(DEFAULT_CRITERIA).concat(["cover"]);

  // "overall" and "worst" are both scored on the 0-100 average scale;
  // per-criterion categories use the raw 1-10 criterion score.
  function isOverallScaleCategory(ck) {
    return ck === "overall" || ck === "worst";
  }

  function eligibleForMonth(monthKey) {
    return state.manhwas.filter(function (m) {
      if (!m.rated) return false;
      var ts = getCreatedAt(m);
      return ts !== null && monthKeyOf(ts) === monthKey;
    });
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
      return eligiblePoolForCategory(monthKey, ck).length > 0;
    });
  }

  function monthHasCandidates(monthKey) {
    return eligibleForMonth(monthKey).length > 0;
  }

  function lastCompletedMonthKey() {
    var now = new Date();
    var d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return monthKeyOf(d.getTime());
  }

  function getWinner(monthKey, categoryKey) {
    var picks = state.awardWinners[monthKey];
    if (!picks || !picks[categoryKey]) return null;
    return findManhwa(picks[categoryKey]);
  }

  // Winners are permanent once set — this refuses to overwrite an existing
  // pick, UNLESS that pick points at a manhwa that no longer exists (deleted
  // after winning) — an orphaned id doesn't count as "decided".
  function setWinner(monthKey, categoryKey, manhwaId) {
    if (!state.awardWinners[monthKey]) state.awardWinners[monthKey] = {};
    var existing = state.awardWinners[monthKey][categoryKey];
    if (existing && findManhwa(existing)) return false;
    state.awardWinners[monthKey][categoryKey] = manhwaId;
    saveAwards();
    return true;
  }

  function canEditWinners(monthKey) {
    return !state.awardEditUsed[monthKey];
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
        if (picks[categoryKey] === m.id) result.push({ monthKey: monthKey, categoryKey: categoryKey });
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
    state.manhwas.forEach(function (m) {
      var ts = getCreatedAt(m);
      if (ts !== null) years[new Date(ts).getFullYear()] = true;
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
    var counts = {};
    Object.keys(state.awardWinners).forEach(function (monthKey) {
      if (parseInt(monthKey.split("-")[0], 10) !== year) return;
      var picks = state.awardWinners[monthKey];
      Object.keys(picks).forEach(function (ck) {
        if (ck === "worst") return; // anti-award doesn't count toward "title of the year"
        var mid = picks[ck];
        counts[mid] = (counts[mid] || 0) + 1;
      });
    });
    var list = Object.keys(counts).map(function (mid) {
      return { manhwa: findManhwa(mid), count: counts[mid] };
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

  function criteriaWord(n) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "критерий";
    if ([2, 3, 4].indexOf(mod10) !== -1 && [12, 13, 14].indexOf(mod100) === -1) return "критерия";
    return "критериев";
  }

  var ANILIST_QUERY =
    "query ($search: String) { Page(page: 1, perPage: 8) { pageInfo { total } media(search: $search, type: MANGA, sort: SEARCH_MATCH) { " +
    "id title { romaji english native } coverImage { large } genres countryOfOrigin format status } } }";

  // Public AniList GraphQL endpoint — no API key needed, CORS-enabled for
  // browser use. Fetches a shortlist of matches so the user picks the right
  // one instead of the app guessing from a single top result.
  // "type: MANGA" already covers manhwa/manhua too — AniList only splits
  // ANIME vs MANGA; manhwa/manhua are told apart by countryOfOrigin, not type.
  function searchAniList(query) {
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
        if (!data) throw new Error("AniList прислал пустой/некорректный ответ");
        if (data.errors && data.errors.length) throw new Error(data.errors[0].message || "ошибка AniList");
        var page = data.data && data.data.Page;
        state.aniListResults = (page && page.media) || [];
        state.aniListSearching = false;
        render();
      })
      .catch(function (err) {
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
      })
    };
  }

  function findManhwa(id) {
    for (var i = 0; i < state.manhwas.length; i++) if (state.manhwas[i].id === id) return state.manhwas[i];
    return null;
  }

  // Called right before a manhwa is actually removed, so a deleted title
  // can't leave a "phantom" winner slot behind (see setWinner) and doesn't
  // linger forever in candidate shortlists.
  function purgeAwardReferences(id) {
    var changed = false;
    Object.keys(state.awardWinners).forEach(function (monthKey) {
      var picks = state.awardWinners[monthKey];
      Object.keys(picks).forEach(function (ck) {
        if (picks[ck] === id) { delete picks[ck]; changed = true; }
      });
    });
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
    persistKey(STORAGE_KEY, state.manhwas).catch(function () {
      state.error = "Не удалось сохранить данные на этом устройстве.";
      render();
    });
    checkAchievements();
  }

  function saveAwards() {
    persistKey(AWARDS_STORAGE_KEY, state.awardWinners).catch(function () {});
    persistKey(AWARD_CANDIDATES_STORAGE_KEY, state.awardCandidates).catch(function () {});
    persistKey(AWARD_EDIT_USED_STORAGE_KEY, state.awardEditUsed).catch(function () {});
  }

  function saveActivityLog() {
    persistKey(ACTIVITY_LOG_STORAGE_KEY, state.activityLog).catch(function () {});
  }

  function saveXp() {
    persistKey(XP_STORAGE_KEY, state.totalXp).catch(function () {});
  }

  function saveAchievements() {
    persistKey(ACHIEVEMENTS_STORAGE_KEY, state.unlockedAchievements).catch(function () {});
  }

  // Records one diary entry. Only called for meaningful, user-initiated
  // moments (not every slider tick) — see the call sites. Caps the log so a
  // years-old install doesn't grow localStorage without bound.
  function logActivity(type, manhwaId, title, extra) {
    state.activityLog.push({ ts: Date.now(), type: type, manhwaId: manhwaId, title: title, extra: extra || null });
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
    var fill = opts.fillColor || "#FFB238";
    var dot = opts.dotColor || "#FFB238";
    var n = criteria.length;

    if (n < 3) {
      return (
        '<div style="height:' + size * 0.6 + "px;display:flex;align-items:center;justify-content:center;" +
        'color:#9A93AE;font-size:13px;text-align:center;padding:0 20px;">' +
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
        '" stroke="#120F1A" stroke-width="1.2" />';
    });

    criteria.forEach(function (c, i) {
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var lx = center + (maxR + 20) * Math.cos(angle);
      var ly = center + (maxR + 20) * Math.sin(angle);
      var label = c.name.length > 10 ? c.name.slice(0, 9) + "…" : c.name;
      svg += '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" dominant-baseline="middle" ' +
        'font-family="Manrope, sans-serif" font-weight="700" font-size="11" fill="#C9C2DA">' +
        escapeHtml(label) + "</text>";
    });

    svg += "</svg>";
    return svg;
  }

  function statusTagHtml(statusId) {
    var s = statusById(statusId);
    return (
      '<span class="mt-status-badge mt-status-tag" style="border-color:' + s.color + ";color:" + s.color +
      ";background:" + s.color + '18;">' + s.label + "</span>"
    );
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

  function typeTagHtml(typeId) {
    var t = typeById(typeId);
    return (
      '<span class="mt-status-badge mt-status-tag" style="border-color:' + t.color + ";color:" + t.color +
      ";background:" + t.color + '18;">' + t.label + "</span>"
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
        var av = average(a.criteria), bv = average(b.criteria);
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
        var at = getCreatedAt(a) || 0, bt = getCreatedAt(b) || 0;
        return bt - at;
      });
    }
    return arr;
  }

  function changelogTypeMeta(type) {
    if (type === "feature") return { label: "НОВОЕ", color: "#34D399" };
    if (type === "fix") return { label: "ИСПРАВЛЕНИЕ", color: "#FF5C77" };
    return { label: "ОБНОВЛЕНИЕ", color: "#6C93FF" };
  }

  function renderYearSummary() {
    var years = yearsWithData();
    if (!years.length) {
      return '<div class="mt-paper mt-empty"><div class="mt-empty-title">Пока нет данных</div>' +
        '<div class="mt-empty-text">Итоги года появятся, когда в библиотеке будут тайтлы с датой добавления.</div></div>';
    }
    if (!state.awardsYear || years.indexOf(state.awardsYear) === -1) {
      state.awardsYear = years[0];
    }
    var year = state.awardsYear;

    var yearChips = years.map(function (y) {
      var active = y === year;
      return '<button class="mt-genre-filter-chip' + (active ? " active" : "") + '" data-awards-year="' + y + '">' + y + "</button>";
    }).join("");

    var titles = titlesForYear(year);
    var rated = titles.filter(function (m) { return m.rated; });
    var avg = rated.length ? rated.reduce(function (a, m) { return a + average(m.criteria); }, 0) / rated.length : null;

    var genreCounts = {};
    titles.forEach(function (m) {
      (m.genres || []).forEach(function (g) { genreCounts[g] = (genreCounts[g] || 0) + 1; });
    });
    var topGenre = Object.keys(genreCounts).sort(function (a, b) { return genreCounts[b] - genreCounts[a]; })[0];

    var champions = championsForYear(year);

    var html = '<div class="mt-genre-filter-row" style="margin-top:0">' + yearChips + "</div>";

    html +=
      '<div class="mt-chip-row" style="margin-top:14px">' +
      '<div class="mt-chip"><div class="mt-chip-value">' + titles.length + '</div><div class="mt-chip-label">тайтлов за год</div></div>' +
      '<div class="mt-chip"><div class="mt-chip-value" style="color:#FFB238">' +
      (avg === null ? "—" : Math.round(avg)) + '</div><div class="mt-chip-label">средняя оценка</div></div>' +
      "</div>";

    if (topGenre) {
      html +=
        '<div class="mt-paper"><div class="mt-panel-title">ЖАНР ГОДА</div>' +
        '<div class="mt-year-genre">' + escapeHtml(topGenre) + '<span class="mt-year-genre-count">×' + genreCounts[topGenre] + "</span></div>" +
        "</div>";
    }

    if (champions.length > 0) {
      var top = champions[0];
      html +=
        '<div class="mt-winner-section-title">🏆 ТАЙТЛ ГОДА</div>' +
        '<div class="mt-winner-carousel">' +
        championCardHtml(top.manhwa, top.count + " " + winWord(top.count) + " за год") +
        "</div>";

      if (champions.length > 1) {
        html +=
          '<div class="mt-winner-section-title" style="margin-top:8px">ВСЕ ЧЕМПИОНЫ ГОДА</div>' +
          '<div class="mt-winner-carousel">' +
          champions.map(function (c) {
            return championCardHtml(c.manhwa, "×" + c.count + " " + winWord(c.count));
          }).join("") +
          "</div>";
      }
    } else {
      html +=
        '<div class="mt-paper mt-empty"><div class="mt-empty-text">В этом году ещё нет победителей месячных номинаций — выбери их во вкладке «Месяц».</div></div>';
    }

    return html;
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
      '<div class="mt-winner-card" data-open-id="' + m.id + '">' +
      '<div class="mt-winner-cover' + (m.coverUrl ? "" : " mt-winner-cover-empty") + '" style="' + coverStyle + '">' +
      (m.coverUrl ? "" : '<span class="mt-winner-cover-fallback">' + escapeHtml((m.title[0] || "?").toUpperCase()) + "</span>") +
      '<span class="mt-winner-trophy-badge">🏆</span>' +
      "</div>" +
      '<div class="mt-winner-category">' + escapeHtml(subtitle) + "</div>" +
      '<div class="mt-winner-title">' + escapeHtml(m.title) + "</div>" +
      "</div>"
    );
  }

  function winnerCardHtml(ck, w) {
    var coverStyle = w.coverUrl
      ? "background-image:url('" + escapeHtml(w.coverUrl).replace(/'/g, "%27") + "')"
      : "";
    return (
      '<div class="mt-winner-card" data-open-id="' + w.id + '">' +
      '<div class="mt-winner-cover' + (w.coverUrl ? "" : " mt-winner-cover-empty") + '" style="' + coverStyle + '">' +
      (w.coverUrl ? "" : '<span class="mt-winner-cover-fallback">' + escapeHtml((w.title[0] || "?").toUpperCase()) + "</span>") +
      '<span class="mt-winner-trophy-badge">' + awardIcon(ck) + "</span>" +
      "</div>" +
      '<div class="mt-winner-category">' + escapeHtml(AWARD_LABELS[ck] || ck) + "</div>" +
      '<div class="mt-winner-title">' + escapeHtml(w.title) + "</div>" +
      "</div>"
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
              '<div class="mt-nominee-info"><div class="mt-nominee-title">' + escapeHtml(e.manhwa.title) + "</div></div>" +
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
    var monthKey = lastCompletedMonthKey();
    var toggle =
      '<div class="mt-filter-row">' +
      '<button class="mt-filter-chip' + (state.awardsView === "month" ? " active" : "") +
      '" data-awards-view="month" style="' + (state.awardsView === "month" ?
        "background:var(--amber);color:#0D0A14;border-color:var(--amber)" : "border-color:rgba(255,178,56,0.4);color:var(--amber)") +
      '">Месяц</button>' +
      '<button class="mt-filter-chip' + (state.awardsView === "year" ? " active" : "") +
      '" data-awards-view="year" style="' + (state.awardsView === "year" ?
        "background:var(--amber);color:#0D0A14;border-color:var(--amber)" : "border-color:rgba(255,178,56,0.4);color:var(--amber)") +
      '">Год</button>' +
      "</div>";

    var html =
      '<div class="mt-header">' +
      '<div class="mt-title-row">' +
      '<div class="mt-title">🏆 ПРЕМИЯ</div>' +
      "</div>" +
      '<div class="mt-subrow"><div class="mt-subtitle">' +
      (state.awardsView === "year" ? "Итоги года" : "Итоги месяца — " + escapeHtml(monthLabel(monthKey))) +
      "</div></div>" +
      toggle +
      "</div>" +
      '<div class="mt-list">';

    if (state.awardsView === "year") {
      html += renderYearSummary();
      html += "</div>";
      return html;
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
          '" id="edit-winners-btn" data-month="' + monthKey + '" style="width:100%;margin-top:10px">' +
          (editConfirming
            ? "Точно? Это единственная правка в этом месяце — нажми ещё раз"
            : "✎ Изменить кандидатов и победителей (доступно 1 раз в месяц)") +
          "</button>";
      } else {
        html +=
          '<div class="mt-ceremony-hint" style="text-align:center;margin-top:10px">' +
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
        '<div class="mt-award-row" data-open-id="' + winner.id + '">' +
        '<span class="mt-award-trophy">' + awardIcon(ck) + "</span>" +
        '<div class="mt-award-info"><div class="mt-award-title">' + escapeHtml(winner.title) + "</div>" +
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
          '<div class="mt-nominee-info"><div class="mt-nominee-title">' + escapeHtml(p.manhwa.title) + "</div></div>" +
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
        ' style="width:100%;margin-top:10px">Готово — выбрать победителя (' + candidateIds.length + ')</button>' +
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
          '<div class="mt-nominee-info"><div class="mt-nominee-title">' + escapeHtml(c.manhwa.title) + "</div>" +
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
        ' style="width:100%;margin-top:10px">✎ Изменить список кандидатов</button>' +
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
          "background:" + f.color + ";color:#0D0A14;border-color:" + f.color :
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
      '<div class="mt-title-row">' +
      '<div class="mt-title">AM<span class="accent">•</span>TRACKER</div>' +
      '<button class="mt-icon-round" id="open-changelog" aria-label="Журнал обновлений">' + ICON_BELL +
      (hasUnseen ? '<span class="mt-notify-dot"></span>' : "") + "</button>" +
      "</div>" +
      '<div class="mt-subrow">' +
      '<div class="mt-subrow-actions">' +
      '<div class="mt-sort-group">' + btns + "</div>" +
      '<button class="mt-icon-round mt-icon-round-sm' + (state.showSearch ? " active" : "") +
      '" id="toggle-search" aria-label="Поиск">' + ICON_SEARCH + "</button>" +
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

  function renderLibrary() {
    var html = renderHeader() + renderErrorBanner();
    var list = sortedManhwas();

    html += '<div class="mt-list">';

    if (state.addingManhwa) {
      var typeBtns = TYPES.map(function (t) {
        var active = state.pendingType === t.id;
        return (
          '<button class="mt-type-choice' + (active ? " active" : "") + '" data-pick-type="' + t.id +
          '" style="' + (active ? "background:" + t.color + ";color:#120F1A;border-color:" + t.color :
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
      html += '<button class="mt-add-btn" id="start-add-manhwa"><span class="mt-add-icon">+</span>Добавить манхву</button>';
    }

    if (list.length === 0 && !state.addingManhwa) {
      var noneAtAll = state.manhwas.length === 0;
      html += noneAtAll
        ? '<div class="mt-paper mt-empty"><div class="mt-empty-title">Пока пусто</div>' +
          '<div class="mt-empty-text">Добавь манхву — оценишь рисовку, сюжет, персонажей и всё остальное по отдельности.</div></div>'
        : '<div class="mt-paper mt-empty"><div class="mt-empty-title">Ничего не найдено</div>' +
          '<div class="mt-empty-text">Попробуй изменить поиск или фильтр.</div></div>';
    }

    if (list.length > 0) {
      html += '<div class="mt-grid">';
      list.forEach(function (m, gridIdx) {
        var avg = average(m.criteria);
        var st = statusById(m.status);
        var ty = typeById(m.type || "manhwa");
        var isWinnerTitle = positiveAwardsForManhwa(m).length > 0;
        var isRockBottom = m.criteria.length > 0 && m.criteria.every(function (c) { return c.score === 1; });
        var coverStyle = m.coverUrl
          ? "background-image:url('" + escapeHtml(m.coverUrl).replace(/'/g, "%27") + "')"
          : "";

        var title = displayTitle(m);
        html +=
          '<div class="mt-grid-card" style="animation-delay:' + Math.min(gridIdx * 30, 240) + 'ms">' +
          '<div class="mt-cover' + (m.coverUrl ? "" : " mt-cover-empty") + (isWinnerTitle ? " mt-cover-winner" : "") +
          '" style="' + coverStyle + '" data-open-id="' + m.id + '">' +
          (m.coverUrl ? "" : '<span class="mt-cover-fallback">' + escapeHtml((title[0] || "?").toUpperCase()) + "</span>") +
          '<div class="mt-cover-top-row">' +
          '<span class="mt-cover-status" style="background:' + st.color + '">' + st.label + "</span>" +
          (isRockBottom ? '<span class="mt-cover-worst" title="Оценено на дно по всем критериям">🤮</span>' : "") +
          "</div>" +
          (isWinnerTitle ? '<span class="mt-cover-trophy">🏆</span>' : "") +
          '<span class="mt-cover-score" style="border-color:' + scoreColor(avg) + ";color:" + scoreColor(avg) +
          '">' + (avg === null ? "–" : Math.round(avg)) + "</span>" +
          "</div>" +
          '<div class="mt-cover-title" data-open-id="' + m.id + '">' + escapeHtml(title) + "</div>" +
          '<div class="mt-cover-type-line">' + ty.label + "</div>" +
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
      '" style="flex:0 0 auto;padding:10px 16px">+</button>' +
      "</div></div>"
    );
  }

  function renderRatingSection(m, avg, editable) {
    var phase = ratingPhase(m);

    if (phase === "phase1") {
      var stars = "";
      for (var i = 1; i <= 5; i++) {
        stars += '<button class="mt-emotion-star" data-emotion-pick="' + i +
          '" data-manhwa-id="' + m.id + '" aria-label="' + i + ' звёзд">★</button>';
      }
      return (
        '<div class="mt-paper mt-emotion-panel">' +
        '<div class="mt-panel-title">ПЕРВОЕ ВПЕЧАТЛЕНИЕ</div>' +
        '<div class="mt-emotion-hint">Оцени по горячим следам, сразу после прочтения — это только эмоция и на числовой рейтинг не повлияет.</div>' +
        '<div class="mt-emotion-stars">' + stars + "</div>" +
        "</div>"
      );
    }

    // phase === "legacy" or "phase2" — full criteria available
    var emotionRecap = "";
    if (typeof m.emotionRating === "number") {
      var recapStars = "";
      for (var j = 1; j <= 5; j++) {
        recapStars += '<span class="mt-emotion-star-static mini' + (j <= m.emotionRating ? " filled" : "") + '">★</span>';
      }
      emotionRecap =
        '<div class="mt-emotion-recap">' + recapStars +
        '<span class="mt-emotion-recap-label">' + escapeHtml(EMOTION_LABELS[m.emotionRating - 1]) + "</span></div>";
    }

    var html = '<div class="mt-paper mt-radar-panel">' + radarSvg(m.criteria, {}) + stampHtml(avg, 50) +
      emotionRecap + "</div>" +
      '<div class="mt-paper mt-criteria-panel">';

    if (editable) {
      html += '<div class="mt-lock-hint">Можно менять — не забудь нажать «Готово» внизу</div>';
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
          '<input type="range" class="mt-slider" min="1" max="10" step="0.5" value="' + c.score +
          '" data-slider-crit="' + c.id + '" />' +
          "</div>";
      });
    } else {
      m.criteria.forEach(function (c) {
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
      var color = positive ? "#34D399" : "#FF5C77";
      var style = selected
        ? "background:" + color + ";color:#120F1A;border-color:" + color
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
      var color = positive ? "#34D399" : "#FF5C77";
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
    var color = scoreColor(avg);
    var coverInner = m.coverUrl
      ? '<img class="mt-reveal-cover-img" src="' + escapeHtml(m.coverUrl).replace(/'/g, "%27") + '" alt="" />'
      : '<div class="mt-reveal-cover-fallback">' + escapeHtml((m.title[0] || "?").toUpperCase()) + "</div>";

    var notesHtml = "";
    if (m.notes && m.notes.trim()) {
      notesHtml =
        '<div class="mt-reveal-notes">' +
        '<div class="mt-reveal-notes-label">Твоя заметка</div>' +
        '<div class="mt-reveal-notes-text">' + escapeHtml(m.notes).replace(/\n/g, "<br>") + "</div>" +
        "</div>";
    }

    return (
      '<div class="mt-reveal-backdrop" id="reveal-backdrop">' +
      '<div class="mt-reveal-card">' +
      '<div class="mt-reveal-cover">' + coverInner + "</div>" +
      '<div class="mt-reveal-title">' + escapeHtml(m.title) + "</div>" +
      '<div class="mt-reveal-stamp" style="border-color:' + color + ";color:" + color + '">' +
      (avg === null ? "–" : Math.round(avg)) + "</div>" +
      notesHtml +
      '<button class="mt-primary-btn" id="reveal-close-btn" style="width:100%;margin-top:16px">Продолжить</button>' +
      "</div></div>"
    );
  }

  // Categories still open for nomination for the month this title belongs to
  // (winner not yet decided). Returns null if there's nothing to nominate.
  function openAwardCategoriesFor(m) {
    if (!m.rated) return null;
    var ts = getCreatedAt(m);
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
      '" id="candidate-panel-toggle" data-manhwa-id="' + m.id + '" style="width:100%;margin-bottom:10px">' +
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
    var unlocked = !!state.unlockedIds[m.id];
    var editable = isNew || unlocked;

    var currentStatus = statusById(m.status);
    var html =
      '<div class="mt-detail-head">' +
      '<button class="mt-icon-btn on-dark" id="back-btn" aria-label="Назад">←</button>' +
      '<div class="mt-detail-title">' + escapeHtml(m.title) + "</div>" +
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
      '<div class="mt-detail-body">';

    var wins = awardsForManhwa(m);
    var hasGoldWin = positiveAwardsForManhwa(m).length > 0;

    if (m.coverUrl) {
      var coverUrlSafe = escapeHtml(m.coverUrl).replace(/'/g, "%27");
      html +=
        '<div class="mt-hero-wrap' + (hasGoldWin ? " mt-hero-winner" : "") + '">' +
        '<div class="mt-hero-bg" style="background-image:url(\'' + coverUrlSafe + "')\"></div>" +
        '<img class="mt-hero-fg" src="' + coverUrlSafe + '" alt="" />' +
        "</div>";
    }

    var candidateInfo = openAwardCategoriesFor(m);
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

    html += renderRatingSection(m, avg, editable);

    if (editable) {
      html += renderTagsPanel(m) + renderGenresPanel(m) + renderAltTitlesPanel(m) + renderNotesPanel(m) + renderCoverPanel(m);
    } else {
      html += renderTagsReadOnly(m) + renderGenresReadOnly(m) + renderAltTitlesReadOnly(m) + renderNotesReadOnly(m);
    }

    if (editable) {
      if (isNew) {
        html +=
          '<div class="mt-form-row">' +
          '<button class="mt-ghost-btn" id="finish-rating-btn" data-manhwa-id="' + m.id +
          '" style="flex:1">✓ Без рецензии</button>' +
          '<button class="mt-primary-btn" id="finish-rating-review-btn" data-manhwa-id="' + m.id +
          '" style="flex:1">📝 С рецензией</button>' +
          "</div>" +
          '<div class="mt-ceremony-hint" style="text-align:center;margin-top:8px">' +
          "За рецензию (пара слов в заметках выше) — больше опыта</div>";
      } else {
        html += '<button class="mt-primary-btn" id="finish-rating-btn" data-manhwa-id="' + m.id +
          '" style="width:100%">Готово</button>';
      }
    } else {
      html += '<button class="mt-ghost-btn" id="unlock-rating-btn" data-manhwa-id="' + m.id +
        '" style="width:100%">✎ Изменить</button>';
    }

    html += renderActivityFeedForManhwa(m);

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
      '<div class="mt-mini-row" data-open-id="' + m.id + '">' +
      '<div class="mt-mini-title">' + escapeHtml(m.title) + "</div>" +
      '<span class="mt-mini-score" style="color:#FFB238">' +
      (avg === null ? "—" : Math.round(avg)) + "</span></div>"
    );
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function pluralRu(n, forms) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
    return forms[2];
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
    if (e.type === "status") {
      var st = e.extra && statusById(e.extra.status);
      return st ? '<span class="mt-activity-dot" style="background:' + st.color + '"></span>' : "•";
    }
    if (e.type === "award") return awardIcon(e.extra ? e.extra.categoryKey : "");
    if (e.type === "delete") return "✕";
    return "•";
  }

  function activityLineText(e) {
    var t = escapeHtml(e.title || "");
    if (e.type === "add") return "Добавлен тайтл «" + t + "»";
    if (e.type === "rated" || e.type === "rated_review") {
      var score = e.extra && e.extra.score !== null && e.extra.score !== undefined ? Math.round(e.extra.score) : null;
      var withReview = e.type === "rated_review";
      return "Оценён «" + t + "»" + (withReview ? " с рецензией" : "") + (score !== null ? " — " + score + "/100" : "");
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

  // Mon–Sun weeks for the last ~53 weeks (GitHub-style year window), each day
  // holding its activity-log event count. Days after today are left as null
  // placeholders so the grid still lines up into full week columns.
  function buildActivityHeatmap() {
    var counts = {};
    state.activityLog.forEach(function (e) {
      var d = new Date(e.ts);
      var key = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      counts[key] = (counts[key] || 0) + 1;
    });

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var start = new Date(today);
    start.setDate(start.getDate() - 29); // rolling last 30 days
    var dow = (start.getDay() + 6) % 7; // 0 = Monday
    start.setDate(start.getDate() - dow);

    var weeks = [];
    var cursor = new Date(start);
    while (cursor <= today) {
      var week = [];
      for (var i = 0; i < 7; i++) {
        if (cursor > today) {
          week.push(null);
        } else {
          var key = cursor.getFullYear() + "-" + pad2(cursor.getMonth() + 1) + "-" + pad2(cursor.getDate());
          week.push({ date: new Date(cursor), count: counts[key] || 0 });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(week);
    }
    return weeks;
  }

  function renderActivityHeatmap() {
    var weeks = buildActivityHeatmap();
    var maxCount = 1;
    weeks.forEach(function (w) { w.forEach(function (d) { if (d && d.count > maxCount) maxCount = d.count; }); });

    function levelFor(count) {
      if (count === 0) return 0;
      var ratio = count / maxCount;
      if (ratio > 0.75) return 4;
      if (ratio > 0.5) return 3;
      if (ratio > 0.25) return 2;
      return 1;
    }

    var cols = weeks.map(function (week) {
      var cells = week.map(function (d) {
        if (!d) return '<span class="mt-heat-cell mt-heat-empty"></span>';
        var dateLabel = d.date.getDate() + " " + MONTH_NAMES_GENITIVE[d.date.getMonth()];
        var title = dateLabel + ": " + d.count + " " + pluralRu(d.count, ["событие", "события", "событий"]);
        return '<span class="mt-heat-cell" data-level="' + levelFor(d.count) + '" title="' + escapeHtml(title) + '"></span>';
      }).join("");
      return '<div class="mt-heat-col">' + cells + "</div>";
    }).join("");

    return (
      '<div class="mt-paper">' +
      '<div class="mt-panel-title">АКТИВНОСТЬ ЗА МЕСЯЦ</div>' +
      '<div class="mt-heatmap-scroll"><div class="mt-heatmap-grid">' + cols + "</div></div>" +
      '<div class="mt-heat-legend">Меньше' +
      '<span class="mt-heat-cell" data-level="0"></span><span class="mt-heat-cell" data-level="1"></span>' +
      '<span class="mt-heat-cell" data-level="2"></span><span class="mt-heat-cell" data-level="3"></span>' +
      '<span class="mt-heat-cell" data-level="4"></span>Больше</div>' +
      "</div>"
    );
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

  function renderAchievementsTab() {
    var unlockedCount = ACHIEVEMENTS.filter(function (a) { return !!state.unlockedAchievements[a.id]; }).length;

    var sections = ACHIEVEMENT_CATEGORIES.map(function (cat) {
      var items = ACHIEVEMENTS.filter(function (a) { return a.category === cat; });
      if (!items.length) return "";
      var catUnlocked = items.filter(function (a) { return !!state.unlockedAchievements[a.id]; }).length;
      var rows = items.map(function (a) {
        var unlocked = !!state.unlockedAchievements[a.id];
        return (
          '<div class="mt-achv-row' + (unlocked ? " unlocked" : "") + '">' +
          '<span class="mt-achv-icon">' + a.icon + "</span>" +
          '<div class="mt-achv-body">' +
          '<div class="mt-achv-name">' + escapeHtml(a.name) + "</div>" +
          '<div class="mt-achv-desc">' + escapeHtml(a.desc) + "</div>" +
          "</div>" +
          (unlocked ? '<span class="mt-achv-check">✓</span>' : "") +
          "</div>"
        );
      }).join("");
      return (
        '<div class="mt-paper">' +
        '<div class="mt-panel-title">' + escapeHtml(cat.toUpperCase()) + " · " + catUnlocked + "/" + items.length + "</div>" +
        '<div class="mt-achv-list">' + rows + "</div>" +
        "</div>"
      );
    }).join("");

    return (
      '<div class="mt-header">' +
      '<div class="mt-title-row"><div class="mt-title">🎖️ ДОСТИЖЕНИЯ</div></div>' +
      '<div class="mt-subrow"><div class="mt-subtitle">Получено ' + unlockedCount + " из " + ACHIEVEMENTS.length + "</div></div>" +
      "</div>" +
      '<div class="mt-list">' + sections + "</div>"
    );
  }

  function renderProfile() {
    var rated = state.manhwas.filter(function (m) { return m.criteria.length > 0; });
    var overallAvg = rated.length
      ? rated.reduce(function (a, m) { return a + average(m.criteria); }, 0) / rated.length
      : null;

    var html =
      '<div class="mt-profile-head">' +
      '<div class="mt-profile-avatar">' + ICON_USER + "</div>" +
      '<div><div class="mt-profile-title">ПРОФИЛЬ<span style="color:#FF3D9A">.</span></div>' +
      '<div class="mt-profile-sub">Статистика по всей библиотеке</div>' +
      renderRankBadge() +
      "</div>" +
      "</div>" + renderErrorBanner() +
      '<div class="mt-list">' +
      renderRankPanel() +
      '<div class="mt-chip-row">' +
      '<div class="mt-chip"><div class="mt-chip-value">' + state.manhwas.length + '</div><div class="mt-chip-label">манхв в списке</div></div>' +
      '<div class="mt-chip"><div class="mt-chip-value" style="color:#FFB238">' +
      (overallAvg === null ? "—" : Math.round(overallAvg)) + '</div><div class="mt-chip-label">средняя оценка</div></div>' +
      "</div>";

    if (state.activityLog.length) {
      html += renderActivityHeatmap();
    }

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
        '<span class="mt-legend-label">' + s.label + " · " + count + "</span></div>";
    });
    html +=
      '<div class="mt-paper"><div class="mt-panel-title">СТАТУСЫ</div>' +
      '<div class="mt-status-track">' + track + "</div>" +
      '<div class="mt-status-legend">' + legend + "</div></div>";

    var agg = aggregateCriteria();
    if (agg.length >= 3) {
      html +=
        '<div class="mt-paper mt-radar-panel" style="align-items:flex-start">' +
        '<div class="mt-panel-title">СРЕДНЕЕ ПО КРИТЕРИЯМ</div>' +
        '<div style="width:100%;display:flex;justify-content:center">' +
        radarSvg(agg, { fillColor: "#FFB238", dotColor: "#FFB238" }) + "</div></div>";
    }

    if (agg.length > 0) {
      var bars = agg.slice().sort(function (a, b) { return b.score - a.score; }).map(function (c) {
        return (
          '<div class="mt-bar-row"><span class="mt-bar-name">' + escapeHtml(c.name) + "</span>" +
          '<div class="mt-bar-track"><div class="mt-bar-fill" style="width:' + (c.score / 10) * 100 +
          '%;background:#FFB238;"></div></div>' +
          '<span class="mt-bar-value" style="color:#FFB238">' + c.score.toFixed(1) + "</span></div>"
        );
      }).join("");
      html += '<div class="mt-paper"><div class="mt-panel-title">ЧТО ТЫ ЦЕНИШЬ ВЫШЕ ВСЕГО</div>' + bars + "</div>";
    }

    var genreStats = {};
    state.manhwas.forEach(function (m) {
      (m.genres || []).forEach(function (g) {
        if (!genreStats[g]) genreStats[g] = { count: 0, sum: 0, rated: 0 };
        genreStats[g].count += 1;
        var av = average(m.criteria);
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
          '<span class="mt-bar-value" style="color:' + color + '">' + s.count + "</span></div>"
        );
      }).join("");
      html += '<div class="mt-paper"><div class="mt-panel-title">ЛЮБИМЫЕ ЖАНРЫ</div>' + genreBars + "</div>";
    }

    var tagCounts = {};
    state.manhwas.forEach(function (m) {
      (m.tags || []).forEach(function (t) { tagCounts[t] = (tagCounts[t] || 0) + 1; });
    });
    var topPos = POSITIVE_TAGS
      .filter(function (t) { return tagCounts[t]; })
      .sort(function (a, b) { return tagCounts[b] - tagCounts[a]; })
      .slice(0, 5);
    var topNeg = NEGATIVE_TAGS
      .filter(function (t) { return tagCounts[t]; })
      .sort(function (a, b) { return tagCounts[b] - tagCounts[a]; })
      .slice(0, 5);

    if (topPos.length > 0 || topNeg.length > 0) {
      var tagRow = function (t) {
        return '<span class="mt-tag-stat">' + escapeHtml(t) + ' <b>' + tagCounts[t] + "</b></span>";
      };
      html +=
        '<div class="mt-paper"><div class="mt-panel-title">ЧАСТО ОТМЕЧАЕШЬ</div>' +
        (topPos.length
          ? '<div class="mt-tag-group-label mt-tag-group-pos">Сильные стороны</div><div class="mt-tag-stat-row">' +
            topPos.map(tagRow).join("") + "</div>"
          : "") +
        (topNeg.length
          ? '<div class="mt-tag-group-label mt-tag-group-neg" style="margin-top:10px">Слабые стороны</div><div class="mt-tag-stat-row">' +
            topNeg.map(tagRow).join("") + "</div>"
          : "") +
        "</div>";
    }

    var sortedByScore = rated.slice().sort(function (a, b) { return average(b.criteria) - average(a.criteria); });
    var top = sortedByScore.slice(0, 3);
    var bottom = sortedByScore.slice(-3).reverse().filter(function (m) { return top.indexOf(m) === -1; });

    if (top.length > 0) {
      html +=
        '<div class="mt-paper"><div class="mt-panel-title" style="color:#34D399">ТОП ПО ОЦЕНКЕ</div>' +
        top.map(miniRowHtml).join("") + "</div>";
    }
    if (bottom.length > 0) {
      html +=
        '<div class="mt-paper"><div class="mt-panel-title" style="color:#FF5C77">АУТСАЙДЕРЫ</div>' +
        bottom.map(miniRowHtml).join("") + "</div>";
    }

    if (state.manhwas.length === 0) {
      html +=
        '<div class="mt-paper mt-empty"><div class="mt-empty-text">Статистика появится, как только добавишь и оценишь первую манхву.</div></div>';
    }

    html +=
      '<div class="mt-paper"><div class="mt-panel-title">РЕЗЕРВНАЯ КОПИЯ</div>' +
      '<div class="mt-backup-text">Сохрани файл с оценками себе на телефон — так данные ' +
      'не потеряются при очистке браузера, и их можно перенести на другое устройство.</div>' +
      '<div class="mt-form-row">' +
      '<button class="mt-ghost-btn" id="export-btn" style="flex:1">⭳ Сохранить в файл</button>' +
      '<button class="mt-ghost-btn" id="import-btn" style="flex:1">⭱ Загрузить из файла</button>' +
      "</div>" +
      '<input type="file" id="import-file-input" accept="application/json" style="display:none" />' +
      "</div>";

    html +=
      '<div class="mt-clear-wrap"><button class="mt-clear-btn' + (state.confirmClear ? " confirm" : "") +
      '" id="clear-all-btn">' +
      (state.confirmClear ? "Точно удалить всё? Нажми ещё раз" : "Очистить все данные") +
      "</button></div>";

    html += "</div>";
    return html;
  }

  /* ---------- tabbar ---------- */
  function renderTabbar() {
    var tabs = [
      ["library", "Библиотека", ICON_BOOK],
      ["awards", "Премия", '<span class="mt-tab-emoji">🏆</span>'],
      ["achievements", "Ачивки", '<span class="mt-tab-emoji">🎖️</span>'],
      ["profile", "Профиль", ICON_USER]
    ];
    var inner = tabs.map(function (t) {
      var active = state.tab === t[0];
      return (
        '<button class="mt-tab-v2' + (active ? " active" : "") + '" data-tab="' + t[0] + '">' +
        '<span class="mt-tab-icon-wrap">' + t[2] + "</span>" +
        '<span class="mt-tab-label">' + t[1] + "</span>" +
        "</button>"
      );
    }).join("");
    return '<div class="mt-tabbar"><div class="mt-tabbar-inner">' + inner + "</div></div>";
  }

  /* ---------- main render ---------- */
  function render() {
    var app = document.getElementById("app");
    var selected = state.selectedId ? findManhwa(state.selectedId) : null;
    if (state.selectedId && !selected) state.selectedId = null;

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
    } else if (state.tab === "awards") {
      body = renderAwardsTab();
    } else if (state.tab === "achievements") {
      body = renderAchievementsTab();
    } else {
      body = renderProfile();
    }

    var showTabs = !selected && !state.showChangelog;
    var revealManhwa = state.revealManhwaId ? findManhwa(state.revealManhwaId) : null;
    app.innerHTML = '<div class="mt-shell">' + body + "</div>" + (showTabs ? renderTabbar() : "") +
      (revealManhwa ? renderRevealOverlay(revealManhwa) : "");
    attachHandlers(selected);
    syncTelegramBackButton();

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

    // tabs
    app.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.tab = btn.getAttribute("data-tab");
        state.addingManhwa = false;
        render();
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
        state.selectedId = el.getAttribute("data-open-id");
        state.candidatePanelOpen = false;
        state.statusPickerOpen = false;
        render();
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
        logActivity("status", m.id, m.title, { status: newStatus });
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
          purgeAwardReferences(id);
          state.manhwas = state.manhwas.filter(function (m) { return m.id !== id; });
          if (state.selectedId === id) state.selectedId = null;
          state.confirmDeleteId = null;
          save();
          if (deletedTitle) logActivity("delete", id, deletedTitle.title, null);
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
    var coverInputEl = document.getElementById("new-cover-input");
    function submitNewManhwa() {
      var val = titleInput ? titleInput.value.trim() : "";
      if (!val) return;
      var dupe = findManhwaByTitle(val);
      if (dupe && !window.confirm("«" + dupe.title + "» уже есть в списке. Всё равно добавить ещё раз?")) {
        return;
      }
      var coverVal = coverInputEl ? coverInputEl.value.trim() : "";
      var m = newManhwa(val, state.pendingType, coverVal);
      if (state.pendingGenresDraft.length) m.genres = state.pendingGenresDraft.slice();
      if (state.pendingAltTitlesDraft) {
        m.altTitles.en = state.pendingAltTitlesDraft.en || "";
        m.altTitles.ja = state.pendingAltTitlesDraft.ja || "";
        m.altTitles.ko = state.pendingAltTitlesDraft.ko || "";
      }
      state.manhwas.push(m);
      logActivity("add", m.id, m.title, { type: m.type });
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
            logActivity("award", manhwaId, wm ? wm.title : "", { monthKey: monthKey, categoryKey: categoryKey });
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
      var m = findManhwa(id);
      if (!m) return;
      var text = buildScoreText(m);

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
      var wasNew = m && m.rated === false;
      if (m) m.rated = true;
      delete state.unlockedIds[id];
      save();
      if (wasNew && m) {
        logActivity(withReview ? "rated_review" : "rated", m.id, m.title, { score: average(m.criteria) });
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
      state.unlockedIds[id] = true;
      render();
    });

    app.querySelectorAll("[data-emotion-pick]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-manhwa-id");
        var m = findManhwa(id);
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
        var m = findManhwa(id);
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
      });
      notesTextarea.addEventListener("blur", function () {
        save();
      });
    }

    app.querySelectorAll("[data-add-genre]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-manhwa-id");
        var m = findManhwa(id);
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
        var m = findManhwa(id);
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
      var m = findManhwa(id);
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
      // Wrapped format carries award history and the activity diary too — a
      // plain array (old exports) still imports fine, just without those.
      var backup = {
        format: "am-tracker-backup",
        version: 3,
        manhwas: state.manhwas,
        awardWinners: state.awardWinners,
        awardCandidates: state.awardCandidates,
        awardEditUsed: state.awardEditUsed,
        activityLog: state.activityLog
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

      state.error = "AndroidBridge не найден — используется запасной способ через браузер, " +
        "в приложении он обычно сохраняет пустой файл.";
      render();

      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    // import from file
    var importBtn = document.getElementById("import-btn");
    var importInput = document.getElementById("import-file-input");
    if (importBtn && importInput) {
      importBtn.addEventListener("click", function () { importInput.click(); });
      importInput.addEventListener("change", function () {
        var file = importInput.files && importInput.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var parsed = JSON.parse(reader.result);
            var manhwas, awardWinners, awardCandidates, awardEditUsed, hasAwards;
            var activityLog = null, hasLog = false;

            if (Array.isArray(parsed)) {
              // Legacy export (pre-v2) — titles only, no award history in the file.
              manhwas = parsed;
              hasAwards = false;
            } else if (parsed && Array.isArray(parsed.manhwas)) {
              manhwas = parsed.manhwas;
              awardWinners = (parsed.awardWinners && typeof parsed.awardWinners === "object") ? parsed.awardWinners : {};
              awardCandidates = (parsed.awardCandidates && typeof parsed.awardCandidates === "object") ? parsed.awardCandidates : {};
              awardEditUsed = (parsed.awardEditUsed && typeof parsed.awardEditUsed === "object") ? parsed.awardEditUsed : {};
              hasAwards = true;
              if (Array.isArray(parsed.activityLog)) {
                activityLog = parsed.activityLog;
                hasLog = true;
              }
            } else {
              throw new Error("bad format");
            }

            var confirmMsg = "Заменить текущий список (" + state.manhwas.length +
              ") данными из файла (" + manhwas.length + ")? Текущие оценки" +
              (hasAwards ? ", награды" : "") + (hasLog ? " и дневник активности" : "") + " будут удалены.";
            if (!hasAwards) {
              confirmMsg += " В этом файле нет данных о наградах (старый формат бэкапа) — награды останутся как есть.";
            } else if (!hasLog) {
              confirmMsg += " В этом файле нет дневника активности (более старый бэкап) — текущий дневник останется как есть.";
            }

            var replace = state.manhwas.length === 0 || window.confirm(confirmMsg);
            if (replace) {
              state.manhwas = manhwas;
              if (hasAwards) {
                state.awardWinners = awardWinners;
                state.awardCandidates = awardCandidates;
                state.awardEditUsed = awardEditUsed;
              }
              if (hasLog) state.activityLog = activityLog;
              state.error = null;
              save();
              if (hasAwards) saveAwards();
              if (hasLog) saveActivityLog();
              render();
            }
          } catch (e) {
            state.error = "Не удалось прочитать файл — проверь, что это резервная копия из этого приложения.";
            render();
          }
        };
        reader.readAsText(file);
        importInput.value = "";
      });
    }

    // clear all
    var clearBtn = document.getElementById("clear-all-btn");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      if (state.confirmClear) {
        state.manhwas = [];
        state.selectedId = null;
        state.confirmClear = false;
        save();
        render();
      } else {
        state.confirmClear = true;
        render();
        setTimeout(function () {
          state.confirmClear = false;
        }, 4000);
      }
    });
  }

  // Single "go back" action shared by the in-app ← buttons and (when running
  // as a Telegram Mini App) the platform's own BackButton — closes whichever
  // "sub-page" is currently open, innermost first.
  function goBack() {
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
      state.selectedId = null;
      state.addingCriterion = false;
      state.pendingGenreDraft = "";
      state.candidatePanelOpen = false;
      state.statusPickerOpen = false;
      render();
    }
  }

  /* ---------- Telegram Mini App integration (optional) ---------- */
  // Entirely a no-op in a normal browser/installed-PWA session — everything
  // here is guarded behind `tg` existing, i.e. only runs inside Telegram.
  var tg = (window.Telegram && window.Telegram.WebApp) || null;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor("#0D0A14");
      tg.setBackgroundColor("#0D0A14");
      if (tg.BackButton) tg.BackButton.onClick(function () { goBack(); });
    } catch (e) {}
  }
  function syncTelegramBackButton() {
    if (!tg || !tg.BackButton) return;
    var hasBack = !!(state.selectedId || state.showChangelog || state.revealManhwaId);
    try { hasBack ? tg.BackButton.show() : tg.BackButton.hide(); } catch (e) {}
  }

  /* ---------- boot ---------- */
  load().then(render).catch(function () { render(); });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js").catch(function () {});
    });
  }
})();
