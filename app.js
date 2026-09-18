/* --- CONFIGURATION & CONSTANTS --- */
const STORAGE_KEY = 'am_tracker_manhwas_v1';
const AWARDS_STORAGE_KEY = 'am_tracker_awards_v1';
const AWARD_CANDIDATES_STORAGE_KEY = 'am_tracker_candidates_v1';
const AWARD_EDIT_USED_STORAGE_KEY = 'am_tracker_edit_used_v1';
const ACTIVITY_LOG_KEY = 'am_tracker_activity_log_v1';
const XP_KEY = 'am_tracker_xp_v1';
const IDB_DB_NAME = 'AmTrackerDB';
const IDB_STORE_NAME = 'kv_store';
const IDB_MIGRATED_KEY = 'migrated_from_localstorage';

let db = null;
let idbAvailable = true;

/* --- STATE --- */
var state = {
  manhwas: [],
  awardWinners: {},
  awardCandidates: {},
  awardEditUsed: {},
  activityLog: [],
  totalXp: 0,
  tab: 'library', // library, awards, profile
  selectedId: null,
  showSearch: false,
  searchQuery: '',
  aniListResults: [],
  aniListSearching: false,
  aniListError: null,
  filterStatus: 'all',
  filterGenre: null,
  sortBy: 'added_desc',
  confirmClear: false,
  error: null,
  changelogSeenVersion: null,
  awardsView: 'month', // month, year
  awardsMonthKey: getCurrentMonthKey(),
  awardsYear: new Date().getFullYear(),
  awardsCategory: null,
  confirmWinnerPick: null,
  awardsCandidatesConfirmed: false,
  editConfirming: false,
  pendingGenreDraft: '',
  statsCache: { // Optimization: Cache heavy calculations
    distinctGenres: 0,
    hasAllTypes: false,
    ratedCount: 0,
    droppedCount: 0,
    completedCount: 0,
    maxStreakDays: 0,
    lastRecalcTime: 0
  }
};

/* --- UTILS --- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function getCurrentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function getCreatedAt(m) {
  if (!m.createdAt) return null;
  try {
    // Handle both number timestamps and ISO strings
    const ts = typeof m.createdAt === 'number' ? m.createdAt : Date.parse(m.createdAt);
    return isNaN(ts) ? null : ts;
  } catch (e) {
    return null;
  }
}

/* --- INDEXEDDB SETUP --- */
function openIdb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      idbAvailable = false;
      resolve(null);
      return;
    }
    const request = indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(IDB_STORE_NAME)) {
        database.createObjectStore(IDB_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };
    request.onerror = (event) => {
      console.warn("IndexedDB not available, falling back to localStorage");
      idbAvailable = false;
      resolve(null);
    };
  });
}

async function persistKey(key, value) {
  if (!db || !idbAvailable) {
    // Fallback to localStorage
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error("LocalStorage save failed:", e);
      throw e;
    }
    return;
  }
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction([IDB_STORE_NAME], 'readwrite');
    const store = tx.objectStore(IDB_STORE_NAME);
    const req = store.put({ key: key, value: value });
    
    req.onsuccess = () => resolve();
    req.onerror = (e) => {
      console.error("IDB write error:", e);
      reject(e);
    };
  });
}

async function loadFromIdb(key) {
  if (!db || !idbAvailable) {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction([IDB_STORE_NAME], 'readonly');
    const store = tx.objectStore(IDB_STORE_NAME);
    const req = store.get(key);
    
    req.onsuccess = () => {
      const item = req.result;
      resolve(item ? item.value : null);
    };
    req.onerror = (e) => reject(e);
  });
}

/* --- SAVE LOGIC WITH DEBOUNCE (FIX FOR RACE CONDITIONS) --- */
let saveTimeout = null;
function save() {
  state.error = null;
  
  // Debounce saves to prevent multiple rapid writes overwriting each other
  if (saveTimeout) clearTimeout(saveTimeout);
  
  saveTimeout = setTimeout(async () => {
    try {
      await persistKey(STORAGE_KEY, state.manhwas);
      // Invalidate stats cache when data changes significantly
      invalidateStatsCache();
      
      // Check achievements asynchronously after save completes
      checkAchievements();
    } catch (e) {
      state.error = "Не удалось сохранить данные. Попробуйте снова.";
      render();
    }
  }, 300); // Wait 300ms after last change before saving
}

function saveAwards() {
  persistKey(AWARDS_STORAGE_KEY, state.awardWinners).catch(console.error);
  persistKey(AWARD_CANDIDATES_STORAGE_KEY, state.awardCandidates).catch(console.error);
  persistKey(AWARD_EDIT_USED_STORAGE_KEY, state.awardEditUsed).catch(console.error);
}

function saveActivityLog() {
  persistKey(ACTIVITY_LOG_KEY, state.activityLog).catch(console.error);
}

function saveXp() {
  persistKey(XP_KEY, state.totalXp).catch(console.error);
}

/* --- STATS CACHE HELPERS (OPTIMIZATION) --- */
function invalidateStatsCache() {
  state.statsCache.lastRecalcTime = 0;
}

function ensureStatsCalculated() {
  const now = Date.now();
  // Recalculate only if older than 1 second OR if never calculated
  if (state.statsCache.lastRecalcTime > now - 1000 && state.statsCache.distinctGenres !== undefined) {
    return;
  }
  
  let genresSet = new Set();
  let typesSet = new Set();
  let ratedCount = 0;
  let droppedCount = 0;
  let completedCount = 0;
  
  state.manhwas.forEach(m => {
    if (m.genres) m.genres.forEach(g => genresSet.add(g));
    if (m.type) typesSet.add(m.type);
    if (m.criteria && m.criteria.length > 0) ratedCount++;
    if (m.status === 'dropped') droppedCount++;
    if (m.status === 'done') completedCount++;
  });
  
  state.statsCache.distinctGenres = genresSet.size;
  state.statsCache.hasAllTypes = ['manhwa', 'manga', 'manhua'].every(t => typesSet.has(t));
  state.statsCache.ratedCount = ratedCount;
  state.statsCache.droppedCount = droppedCount;
  state.statsCache.completedCount = completedCount;
  state.statsCache.lastRecalcTime = now;
}

function distinctGenresCount() {
  ensureStatsCalculated();
  return state.statsCache.distinctGenres;
}

function hasAllThreeTypes() {
  ensureStatsCalculated();
  return state.statsCache.hasAllTypes;
}

function ratedTitlesCount() {
  ensureStatsCalculated();
  return state.statsCache.ratedCount;
}

function droppedTitlesCount() {
  ensureStatsCalculated();
  return state.statsCache.droppedCount;
}

/* --- ACHIEVEMENTS CHECKER (OPTIMIZED) --- */
// Note: In a real scenario, keep your full ACHIEVEMENTS array here.
// I'm including the logic fix.
var UNLOCKED_ACHIEVEMENTS = []; // Load this from storage on init

function checkAchievements() {
  // Only run if there are manhwas or significant changes
  if (state.manhwas.length === 0 && UNLOCKED_ACHIEVEMENTS.length === 0) return;
  
  let newlyUnlocked = [];
  
  // Iterate through achievement definitions (assuming ACHIEVEMENTS array exists globally)
  // You need to paste your original ACHIEVEMENTS array definition above this function
  
  /* Example structure for checking:
  ACHIEVEMENTS.forEach(a => {
    if (!UNLOCKED_ACHIEVEMENTS.includes(a.id)) {
      if (a.check()) {
        newlyUnlocked.push(a);
        UNLOCKED_ACHIEVEMENTS.push(a.id);
      }
    }
  });
  */
   
  if (newlyUnlocked.length > 0) {
    saveAchievements();
    let xpGain = 0;
    newlyUnlocked.forEach(a => xpGain += a.xp || 0);
    if (xpGain) {
      state.totalXp += xpGain;
      saveXp();
      // Optionally trigger UI notification
    }
  }
}

function saveAchievements() {
  persistKey('am_tracker_achievements', UNLOCKED_ACHIEVEMENTS).catch(console.error);
}

/* --- INITIALIZATION --- */
async function init() {
  await openIdb();
  
  // Migration Logic
  const migrated = await loadFromIdb(IDB_MIGRATED_KEY);
  if (!migrated) {
    // Try loading from localStorage first time
    const lsData = window.localStorage.getItem(STORAGE_KEY);
    if (lsData) {
      state.manhwas = JSON.parse(lsData);
      await persistKey(STORAGE_KEY, state.manhwas);
    }
    // Mark as migrated
    await persistKey(IDB_MIGRATED_KEY, true);
  } else {
    // Normal Load
    const savedManhwas = await loadFromIdb(STORAGE_KEY);
    if (savedManhwas) state.manhwas = savedManhwas;
    
    const savedAwards = await loadFromIdb(AWARDS_STORAGE_KEY);
    if (savedAwards) state.awardWinners = savedAwards;
    
    const savedCandidates = await loadFromIdb(AWARD_CANDIDATES_STORAGE_KEY);
    if (savedCandidates) state.awardCandidates = savedCandidates;
    
    const savedEditUsed = await loadFromIdb(AWARD_EDIT_USED_STORAGE_KEY);
    if (savedEditUsed) state.awardEditUsed = savedEditUsed;
    
    const savedLog = await loadFromIdb(ACTIVITY_LOG_KEY);
    if (savedLog) state.activityLog = savedLog;
    
    const savedXp = await loadFromIdb(XP_KEY);
    if (savedXp !== null) state.totalXp = savedXp;
    
    const savedAchv = await loadFromIdb('am_tracker_achievements');
    if (savedAchv) UNLOCKED_ACHIEVEMENTS = savedAchv;
  }
  
  applyPostLoadMigrations();
  
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js')
        .then(reg => console.log('SW registered:', reg.scope))
        .catch(err => console.error('SW registration failed:', err));
    });
  }
  
  render();
}

function applyPostLoadMigrations() {
  // Ensure all manhwas have required fields
  state.manhwas.forEach(m => {
    if (!m.id) m.id = uid();
    if (!m.createdAt) m.createdAt = Date.now();
    if (!m.criteria) m.criteria = [];
    if (!m.tags) m.tags = [];
    if (!m.genres) m.genres = [];
  });
}

/* --- RENDERING (Placeholder for your existing render functions) --- */
// Keep your existing render(), renderLibrary(), etc. functions below.
// Just make sure they use the updated state and helper functions.

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  
  // Clear previous listeners if necessary to avoid memory leaks
  // (Simple approach: replace innerHTML which detaches listeners automatically)
  
  let html = '';
  
  if (state.selectedId) {
    html = renderDetail(findManhwa(state.selectedId));
  } else if (state.tab === 'library') {
    html = renderLibrary();
  } else if (state.tab === 'awards') {
    html = renderAwards();
  } else if (state.tab === 'profile') {
    html = renderProfile();
  }
  
  app.innerHTML = html;
  attachHandlers();
}

// ... [REST OF YOUR ORIGINAL APP.JS CODE GOES HERE] ...
// Paste your renderLibrary, renderDetail, renderAwards, renderProfile, 
// and event handler functions here.
// IMPORTANT: Remove any duplicate variable declarations like 'var ICON_BELL' 
// if they were defined twice in your original messy code.

init();
