/*
 * AM Tracker — accounts and cross-device sync (Firebase Auth + Firestore).
 *
 * Design: the app stays local-first. Everything keeps working offline and
 * without an account; signing in only adds a background sync on top.
 *
 *   - Each title is its own Firestore document, last-write-wins by `updatedAt`.
 *     Deletions travel as tombstones so they reach the other devices.
 *   - Awards: one document, last-write-wins (union-merged on a device's first sync).
 *   - Profile (nickname, bio, avatar): one document, last-write-wins; on a device's
 *     first sync the account's existing profile wins over a blank local one.
 *   - XP / achievements: merged (max XP, union of achievements).
 *   - Activity log: append-only, union-merged, stored in one document per month.
 *   - "Clear everything" bumps an `epoch` so other devices drop their old copy too.
 *
 * All docs live in ONE collection (users/{uid}/items) so a sync costs a single
 * query, and only documents changed since the last sync are read.
 *
 * The sync engine (createEngine) knows nothing about Firebase — it talks to a
 * small `remote` adapter — which keeps it testable without a network.
 */
(function (root) {
  "use strict";

  var FIREBASE_VERSION = "12.3.0"; // bump here to move to a newer Firebase JS SDK
  var CDN_BASE = "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";
  var META_VERSION = 1;
  var PULL_OVERLAP_MS = 5000; // re-read a little history so out-of-order server timestamps can't be missed
  var PUSH_BATCH = 400; // Firestore allows 500 writes per batch
  var AUTO_SYNC_MS = 120000;

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

  // cyrb53 — small, fast, well distributed; only used to detect "did this change".
  function hashStr(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // JSON with sorted keys, so two equal objects always produce the same string.
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (isObj(v)) {
      return "{" + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ":" + stable(v[k]);
      }).join(",") + "}";
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  function canonTitle(m) {
    var c = {};
    Object.keys(m).forEach(function (k) { if (k !== "updatedAt") c[k] = m[k]; });
    return JSON.stringify(c);
  }
  function canonAwards(a) { return stable({ w: (a && a.w) || {}, c: (a && a.c) || {}, e: (a && a.e) || {} }); }
  function canonProgress(p) { return stable({ x: (p && p.x) || 0, a: (p && p.a) || {} }); }

  function logKey(e) { return e.ts + "|" + e.type + "|" + (e.manhwaId == null ? "" : e.manhwaId); }
  function validLogEntry(e) { return isObj(e) && typeof e.ts === "number" && isFinite(e.ts) && typeof e.type === "string"; }
  function monthOf(ts) { return new Date(ts).toISOString().slice(0, 7); }

  function groupLog(list) {
    var out = {};
    (list || []).forEach(function (e) {
      if (!validLogEntry(e)) return;
      (out[monthOf(e.ts)] = out[monthOf(e.ts)] || []).push(e);
    });
    return out;
  }

  function canonLogMonth(entries) {
    return JSON.stringify(entries.slice().sort(function (a, b) {
      return a.ts - b.ts || (logKey(a) < logKey(b) ? -1 : logKey(a) > logKey(b) ? 1 : 0);
    }));
  }

  function canonProfile(p) { return stable({ n: (p && p.n) || "", b: (p && p.b) || "", a: (p && p.a) || null }); }
  function isEmptyProfile(p) { return !p || (!p.n && !p.b && !p.a); }

  function isEmptyAwards(a) {
    return !a || (!Object.keys(a.w || {}).length && !Object.keys(a.c || {}).length && !Object.keys(a.e || {}).length);
  }

  // Union of two { month: { category: value } } maps; `prefer` wins on conflicts.
  function unionNested(prefer, other, leafMerge) {
    var out = {};
    var months = {};
    Object.keys(other || {}).forEach(function (k) { months[k] = 1; });
    Object.keys(prefer || {}).forEach(function (k) { months[k] = 1; });
    Object.keys(months).forEach(function (m) {
      var a = (prefer && prefer[m]) || {}, b = (other && other[m]) || {};
      var cats = {};
      Object.keys(a).forEach(function (k) { cats[k] = 1; });
      Object.keys(b).forEach(function (k) { cats[k] = 1; });
      out[m] = {};
      Object.keys(cats).forEach(function (c) {
        out[m][c] = leafMerge(a[c], b[c]);
      });
    });
    return out;
  }

  function unionAwards(local, remote) {
    return {
      w: unionNested(local.w, remote.w, function (l, r) { return l !== undefined ? l : r; }),
      c: unionNested(local.c, remote.c, function (l, r) {
        var out = (Array.isArray(l) ? l : []).slice();
        (Array.isArray(r) ? r : []).forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
        return out;
      }),
      e: (function () {
        var out = {};
        Object.keys(remote.e || {}).forEach(function (k) { out[k] = remote.e[k]; });
        Object.keys(local.e || {}).forEach(function (k) { out[k] = out[k] || local.e[k]; });
        return out;
      })()
    };
  }

  function unionAch(a, b) {
    var out = {};
    [a, b].forEach(function (src) {
      Object.keys(src || {}).forEach(function (id) {
        var t = src[id];
        if (!t) return;
        out[id] = out[id] ? Math.min(out[id], t) : t;
      });
    });
    return out;
  }

  function isOfflineError(e) {
    var code = e && e.code ? String(e.code) : "";
    var msg = e && e.message ? String(e.message) : "";
    if (code === "unavailable" || code === "auth/network-request-failed") return true;
    if (/offline|network|failed to fetch|load failed/i.test(msg)) return true;
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  function friendlySyncError(e) {
    var code = e && e.code ? String(e.code) : "";
    if (code === "permission-denied") return "Нет доступа к облачным данным — проверь правила Firestore.";
    if (code === "unauthenticated" || code === "auth/user-token-expired") return "Нужно войти заново.";
    if (code === "resource-exhausted") return "Исчерпана дневная квота Firestore — синхронизация продолжится позже.";
    return (e && e.message) ? String(e.message) : "Не удалось синхронизировать.";
  }

  function freshMeta(uid, email) {
    return {
      v: META_VERSION, uid: uid, email: email || "", signedIn: true,
      watermark: 0,
      titles: {},      // id -> { h, u } or { d: 1, u } (tombstone)
      dirty: {},       // id -> 1 (needs pushing)
      awards: null,    // { h, u, dirty }
      progress: null,  // { h, dirty }
      profile: null,   // { h, u, dirty }
      epoch: null,     // "cleared everything" generation; null until first sync
      logs: {},        // "YYYY-MM" -> hash of last known content
      logDirty: {},
      lastSync: 0
    };
  }

  /* ------------------------------------------------------------------ */
  /* sync engine (no Firebase inside)                                    */
  /* ------------------------------------------------------------------ */

  /*
   * cfg.host    — the app: titles(), awards(), progress(), log(), profile(), commit(changes),
   *               optional sanitizeTitle(obj), sanitizeProfile(obj)
   * cfg.remote  — pull(sinceMs) -> { docs, maxSrv }, push(docs, onConfirmed)
   * cfg.meta    — persisted per-device sync bookkeeping (see freshMeta)
   * cfg.saveMeta(meta) -> Promise
   */
  function createEngine(cfg) {
    var host = cfg.host, remote = cfg.remote, meta = cfg.meta;
    var clock = cfg.clock || Date.now;
    var onState = cfg.onState || function () {};
    var running = null, again = false;
    var st = { phase: "idle", error: "", lastSync: meta.lastSync || 0 };

    function pendingCount() {
      var n = Object.keys(meta.dirty).length + Object.keys(meta.logDirty).length;
      if (meta.awards && meta.awards.dirty) n++;
      if (meta.progress && meta.progress.dirty) n++;
      if (meta.profile && meta.profile.dirty) n++;
      return n;
    }
    function setState(patch) {
      Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
      onState({ phase: st.phase, error: st.error, lastSync: st.lastSync, pending: pendingCount() });
    }
    function persist() { return Promise.resolve(cfg.saveMeta(meta)); }

    /* ---- 1. notice what changed locally since the last sync ---- */
    function detect() {
      var now = clock();
      var seen = {};
      host.titles().forEach(function (m) {
        if (!isObj(m) || m.id === undefined || m.id === null) return;
        var id = String(m.id);
        seen[id] = true;
        var h = hashStr(canonTitle(m));
        var k = meta.titles[id];
        if (!k || k.d || k.h !== h) {
          meta.titles[id] = { h: h, u: Math.max(now, k ? k.u + 1 : 0) };
          meta.dirty[id] = 1;
        }
      });
      Object.keys(meta.titles).forEach(function (id) {
        var k = meta.titles[id];
        if (!seen[id] && !k.d) {
          meta.titles[id] = { d: 1, u: Math.max(now, k.u + 1) };
          meta.dirty[id] = 1;
        }
      });

      if (meta.awards) {
        var ah = hashStr(canonAwards(host.awards()));
        if (ah !== meta.awards.h) meta.awards = { h: ah, u: now, dirty: true };
      }
      if (meta.progress) {
        var ph = hashStr(canonProgress(host.progress()));
        if (ph !== meta.progress.h) meta.progress = { h: ph, dirty: true };
      }
      if (meta.profile && host.profile) {
        var prh = hashStr(canonProfile(host.profile()));
        if (prh !== meta.profile.h) meta.profile = { h: prh, u: now, dirty: true };
      }

      var months = groupLog(host.log());
      Object.keys(months).forEach(function (mk) {
        var h = hashStr(canonLogMonth(months[mk]));
        if (meta.logs[mk] !== h) { meta.logs[mk] = h; meta.logDirty[mk] = 1; }
      });
    }

    /* ---- 2. apply what arrived from the cloud ---- */
    function handleTitle(d, ch) {
      var id = String(d.id);
      var k = meta.titles[id];
      var obj = null, rh = null;
      if (!d.deleted) {
        try { obj = JSON.parse(d.json); } catch (e) { return; }
        if (host.sanitizeTitle) obj = host.sanitizeTitle(obj, id);
        if (!isObj(obj)) return;
        rh = hashStr(canonTitle(obj));
      }
      if (k) {
        if (d.updatedAt < k.u) return; // ours is newer
        if (d.updatedAt === k.u) {
          if (d.deleted ? !!k.d : (!k.d && k.h === rh)) return; // identical (e.g. our own echo)
          // Exact tie with different content: every device must pick the same
          // winner — a deletion first, otherwise the larger content hash.
          var remoteWins = d.deleted || (!k.d && rh > k.h);
          if (!remoteWins) { meta.dirty[id] = 1; return; }
        }
      }
      if (d.deleted) {
        ch.titles.del.push(id);
        meta.titles[id] = { d: 1, u: d.updatedAt };
      } else {
        ch.titles.put.push(obj);
        meta.titles[id] = { h: rh, u: d.updatedAt };
      }
      delete meta.dirty[id];
    }

    function parseProgress(d) {
      if (!d) return null;
      try {
        var o = JSON.parse(d.json);
        return { x: Number(o.x) > 0 ? Number(o.x) : 0, a: isObj(o.a) ? o.a : {} };
      } catch (e) { return null; }
    }

    function mergeProgressInto(local, remoteP, ch) {
      var merged = { x: Math.max(local.x || 0, remoteP.x || 0), a: unionAch(local.a, remoteP.a) };
      var lh = hashStr(canonProgress(local));
      var mh = hashStr(canonProgress(merged));
      if (mh !== lh) ch.progress = merged;
      meta.progress = { h: mh, dirty: mh !== hashStr(canonProgress(remoteP)) };
    }

    function handleProgress(d, ch) {
      var local = host.progress();
      var remoteP = parseProgress(d);
      if (!remoteP) {
        if (meta.epoch === null) meta.epoch = 0;
        if (!meta.progress) meta.progress = { h: hashStr(canonProgress(local)), dirty: true };
        return;
      }
      var remoteEpoch = d.epoch || 0;
      if (meta.epoch === null) { // first time this device sees this account: merge, don't overwrite
        meta.epoch = remoteEpoch;
        mergeProgressInto(local, remoteP, ch);
      } else if (remoteEpoch > meta.epoch) { // everything was cleared on another device
        meta.epoch = remoteEpoch;
        ch.progress = remoteP;
        ch.logReset = true;
        meta.logs = {};
        meta.logDirty = {};
        meta.progress = { h: hashStr(canonProgress(remoteP)), dirty: false };
      } else if (remoteEpoch < meta.epoch) { // we cleared more recently — our state wins
        meta.progress = { h: hashStr(canonProgress(local)), dirty: true };
      } else {
        mergeProgressInto(local, remoteP, ch);
      }
    }

    function handleAwards(d, ch) {
      var local = host.awards();
      var remoteA = null;
      if (d) {
        try {
          var o = JSON.parse(d.json);
          remoteA = { w: isObj(o.w) ? o.w : {}, c: isObj(o.c) ? o.c : {}, e: isObj(o.e) ? o.e : {} };
        } catch (e) { remoteA = null; }
      }
      if (!meta.awards) { // first time this device syncs awards
        if (!remoteA) {
          meta.awards = { h: hashStr(canonAwards(local)), u: clock(), dirty: !isEmptyAwards(local) };
        } else if (isEmptyAwards(local)) {
          ch.awards = remoteA;
          meta.awards = { h: hashStr(canonAwards(remoteA)), u: d.updatedAt, dirty: false };
        } else {
          var merged = unionAwards(local, remoteA);
          ch.awards = merged;
          // strictly newer than the cloud copy, so every other device adopts the merge
          meta.awards = { h: hashStr(canonAwards(merged)), u: Math.max(clock(), d.updatedAt + 1), dirty: true };
        }
        return;
      }
      if (remoteA && d.updatedAt > meta.awards.u) {
        ch.awards = remoteA;
        meta.awards = { h: hashStr(canonAwards(remoteA)), u: d.updatedAt, dirty: false };
      }
    }

    function parseProfile(d) {
      if (!d) return null;
      try {
        var o = JSON.parse(d.json);
        if (!isObj(o)) return null;
        var p = { n: typeof o.n === "string" ? o.n : "", b: typeof o.b === "string" ? o.b : "", a: isObj(o.a) ? o.a : null };
        return host.sanitizeProfile ? host.sanitizeProfile(p) : p;
      } catch (e) { return null; }
    }

    function handleProfile(d, ch) {
      if (!host.profile) return;
      var local = host.profile();
      var remoteP = parseProfile(d);
      if (!meta.profile) { // first time this device syncs the profile
        if (remoteP) { // the account already has a profile — it wins over whatever is here
          ch.profile = remoteP;
          meta.profile = { h: hashStr(canonProfile(remoteP)), u: d.updatedAt, dirty: false };
        } else {
          meta.profile = { h: hashStr(canonProfile(local)), u: clock(), dirty: !isEmptyProfile(local) };
        }
        return;
      }
      if (remoteP && d.updatedAt > meta.profile.u) {
        ch.profile = remoteP;
        meta.profile = { h: hashStr(canonProfile(remoteP)), u: d.updatedAt, dirty: false };
      }
    }

    function handleLogChunk(d, ch) {
      if ((d.epoch || 0) < (meta.epoch || 0)) return; // written before the last "clear everything"
      var remoteEntries;
      try { remoteEntries = JSON.parse(d.json); } catch (e) { return; }
      if (!Array.isArray(remoteEntries)) return;
      remoteEntries = remoteEntries.filter(validLogEntry);
      var month = String(d.id);
      var localAll = ch.logReset ? [] : host.log();
      var localMonth = localAll.filter(function (e) { return validLogEntry(e) && monthOf(e.ts) === month; });
      var have = {};
      localMonth.forEach(function (e) { have[logKey(e)] = 1; });
      var add = remoteEntries.filter(function (e) { return !have[logKey(e)]; });
      add.forEach(function (e) { ch.logAdd.push(e); });
      var mergedMonth = localMonth.concat(add);
      var remoteKeys = {};
      remoteEntries.forEach(function (e) { remoteKeys[logKey(e)] = 1; });
      meta.logs[month] = hashStr(canonLogMonth(mergedMonth));
      if (mergedMonth.some(function (e) { return !remoteKeys[logKey(e)]; })) meta.logDirty[month] = 1;
      else delete meta.logDirty[month];
    }

    function applyDocs(docs) {
      var ch = { titles: { put: [], del: [] }, awards: null, progress: null, profile: null, logAdd: [], logReset: false };
      var prog = null, aw = null, prof = null, titles = [], logs = [];
      docs.forEach(function (d) {
        if (d.kind === "progress") prog = d;
        else if (d.kind === "awards") aw = d;
        else if (d.kind === "profile") prof = d;
        else if (d.kind === "t") titles.push(d);
        else if (d.kind === "log") logs.push(d);
      });
      handleProgress(prog, ch); // first: it may bump the epoch that the log chunks are checked against
      handleAwards(aw, ch);
      handleProfile(prof, ch);
      titles.forEach(function (d) { handleTitle(d, ch); });
      logs.forEach(function (d) { handleLogChunk(d, ch); });
      if (ch.titles.put.length || ch.titles.del.length || ch.awards || ch.progress || ch.profile || ch.logAdd.length || ch.logReset) {
        host.commit(ch);
      }
    }

    /* ---- 3. send local changes up ---- */
    function pushDirty() {
      var docs = [], done = {};
      var epoch = meta.epoch || 0;
      function add(doc, fn) { docs.push(doc); done[doc.key] = fn; }
      function mk(key, kind, id, json, deleted, updatedAt) {
        return { key: key, kind: kind, id: id, json: json, deleted: deleted, updatedAt: updatedAt, epoch: epoch };
      }

      var byId = {};
      host.titles().forEach(function (m) { if (isObj(m) && m.id != null) byId[String(m.id)] = m; });
      Object.keys(meta.dirty).forEach(function (id) {
        var k = meta.titles[id];
        if (!k) { delete meta.dirty[id]; return; }
        var key = "t:" + encodeURIComponent(id);
        var sentU = k.u;
        var clear = function () {
          if (meta.titles[id] && meta.titles[id].u === sentU) delete meta.dirty[id];
        };
        if (k.d) add(mk(key, "t", id, "", true, k.u), clear);
        else if (byId[id]) add(mk(key, "t", id, canonTitle(byId[id]), false, k.u), clear);
      });

      if (meta.awards && meta.awards.dirty) {
        var sentA = meta.awards.h;
        add(mk("awards", "awards", "", canonAwards(host.awards()), false, meta.awards.u), function () {
          if (meta.awards && meta.awards.h === sentA) meta.awards.dirty = false;
        });
      }
      if (meta.profile && meta.profile.dirty && host.profile) {
        var sentPr = meta.profile.h;
        add(mk("profile", "profile", "", canonProfile(host.profile()), false, meta.profile.u), function () {
          if (meta.profile && meta.profile.h === sentPr) meta.profile.dirty = false;
        });
      }
      if (meta.progress && meta.progress.dirty) {
        var sentP = meta.progress.h;
        add(mk("progress", "progress", "", canonProgress(host.progress()), false, clock()), function () {
          if (meta.progress && meta.progress.h === sentP) meta.progress.dirty = false;
        });
      }
      var months = groupLog(host.log());
      Object.keys(meta.logDirty).forEach(function (mkey) {
        if (!months[mkey]) { delete meta.logDirty[mkey]; return; }
        var sentL = meta.logs[mkey];
        add(mk("log:" + mkey, "log", mkey, canonLogMonth(months[mkey]), false, clock()), function () {
          if (meta.logs[mkey] === sentL) delete meta.logDirty[mkey];
        });
      });

      if (!docs.length) return Promise.resolve();
      return remote.push(docs, function (keys) {
        keys.forEach(function (key) { if (done[key]) done[key](); });
      });
    }

    function runOnce() {
      detect();
      return remote.pull(meta.watermark > 0 ? Math.max(0, meta.watermark - PULL_OVERLAP_MS) : 0)
        .then(function (res) {
          applyDocs(res.docs);
          if (res.maxSrv > meta.watermark) meta.watermark = res.maxSrv;
          return persist();
        })
        .then(pushDirty)
        .then(persist);
    }

    function sync() {
      if (running) { again = true; return running; }
      setState({ phase: "syncing", error: "" });
      var loop = function () {
        again = false;
        return runOnce().then(function () { if (again) return loop(); });
      };
      running = loop()
        .then(function () {
          meta.lastSync = clock();
          return persist().then(function () { setState({ phase: "idle", error: "", lastSync: meta.lastSync }); });
        })
        .catch(function (e) {
          var offline = isOfflineError(e);
          return persist().catch(function () {}).then(function () {
            setState(offline ? { phase: "offline", error: "" } : { phase: "error", error: friendlySyncError(e) });
          });
        })
        .then(function () { running = null; });
      return running;
    }

    // The user wiped all data while signed in: wipe it everywhere.
    function markCleared() {
      meta.epoch = (meta.epoch === null ? 0 : meta.epoch) + 1;
      meta.progress = { h: null, dirty: true };
      meta.logs = {};
      meta.logDirty = {};
      if (meta.awards) meta.awards = { h: null, u: clock(), dirty: true };
      return persist();
    }

    // Called right after every local save so that "updatedAt" is the moment of the
    // edit — an edit made offline days ago must not beat a newer edit from another
    // device just because this device happened to sync later.
    function noteChange() { detect(); }

    return { sync: sync, markCleared: markCleared, noteChange: noteChange, meta: meta, pendingCount: pendingCount };
  }

  /* ------------------------------------------------------------------ */
  /* Firestore adapter                                                   */
  /* ------------------------------------------------------------------ */

  function createFirebaseRemote(sdk, uid) {
    var fs = sdk.fsMod;
    var col = fs.collection(sdk.db, "users", uid, "items");

    return {
      pull: function (sinceMs) {
        var q = sinceMs > 0 ? fs.query(col, fs.where("srv", ">", fs.Timestamp.fromMillis(sinceMs))) : col;
        return fs.getDocs(q).then(function (snap) {
          var docs = [], maxSrv = 0;
          snap.forEach(function (d) {
            var x = d.data();
            var srv = x.srv && x.srv.toMillis ? x.srv.toMillis() : 0;
            if (srv > maxSrv) maxSrv = srv;
            docs.push({
              key: d.id, kind: x.kind, id: x.id, json: x.json || "", deleted: !!x.deleted,
              updatedAt: Number(x.updatedAt) || 0, epoch: Number(x.epoch) || 0, srv: srv
            });
          });
          return { docs: docs, maxSrv: maxSrv };
        });
      },

      push: function (docs, onConfirmed) {
        var i = 0;
        function next() {
          if (i >= docs.length) return Promise.resolve();
          var chunk = docs.slice(i, i + PUSH_BATCH);
          i += PUSH_BATCH;
          var batch = fs.writeBatch(sdk.db);
          chunk.forEach(function (d) {
            batch.set(fs.doc(col, d.key), {
              kind: d.kind, id: d.id, json: d.json, deleted: d.deleted,
              updatedAt: d.updatedAt, epoch: d.epoch, srv: fs.serverTimestamp()
            });
          });
          return batch.commit().then(function () {
            onConfirmed(chunk.map(function (d) { return d.key; }));
            return next();
          });
        }
        return next();
      },

      deleteAll: function () {
        return fs.getDocs(col).then(function (snap) {
          var refs = [];
          snap.forEach(function (d) { refs.push(d.ref); });
          var i = 0;
          function next() {
            if (i >= refs.length) return Promise.resolve();
            var batch = fs.writeBatch(sdk.db);
            refs.slice(i, i + PUSH_BATCH).forEach(function (r) { batch.delete(r); });
            i += PUSH_BATCH;
            return batch.commit().then(next);
          }
          return next();
        });
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* public API: sign-in + orchestration (browser only)                  */
  /* ------------------------------------------------------------------ */

  var AUTH_ERRORS = {
    "auth/invalid-email": "Неверный формат почты.",
    "auth/missing-email": "Введи почту.",
    "auth/missing-password": "Введи пароль.",
    "auth/user-not-found": "Аккаунт с такой почтой не найден.",
    "auth/wrong-password": "Неверный пароль.",
    "auth/invalid-credential": "Неверная почта или пароль.",
    "auth/email-already-in-use": "Эта почта уже зарегистрирована — попробуй войти.",
    "auth/weak-password": "Слишком простой пароль — нужно минимум 8 символов.",
    "auth/too-many-requests": "Слишком много попыток. Подожди немного и попробуй снова.",
    "auth/network-request-failed": "Нет связи с сервером. Проверь интернет.",
    "auth/user-disabled": "Этот аккаунт отключён.",
    "auth/requires-recent-login": "Нужно подтвердить пароль ещё раз.",
    "auth/operation-not-allowed": "Вход по почте не включён в настройках Firebase."
  };

  function friendlyAuthError(e) {
    var code = e && e.code ? String(e.code) : "";
    if (AUTH_ERRORS[code]) return new Error(AUTH_ERRORS[code]);
    if (isOfflineError(e)) return new Error(AUTH_ERRORS["auth/network-request-failed"]);
    return new Error((e && e.message) ? String(e.message) : "Что-то пошло не так.");
  }

  function setupBrowserApi() {
    var cfg = root.AM_FIREBASE_CONFIG || {};
    var host = null;
    var sdk = null, sdkPromise = null;
    var engine = null, remote = null, meta = null, attachedUid = null;
    var listeners = [];
    var timer = null;
    var started = false;

    var status = {
      configured: !!(cfg.apiKey && cfg.projectId),
      signedIn: false, email: "", verified: true,
      phase: "idle", error: "", lastSync: 0, pending: 0
    };

    function snapshot() { return JSON.parse(JSON.stringify(status)); }
    function emit(prev) {
      var now = snapshot();
      listeners.forEach(function (fn) { try { fn(now, prev); } catch (e) {} });
    }
    function update(patch) {
      var prev = snapshot();
      Object.keys(patch).forEach(function (k) { status[k] = patch[k]; });
      emit(prev);
    }

    function loadSdk() {
      if (sdk) return Promise.resolve(sdk);
      if (sdkPromise) return sdkPromise;
      sdkPromise = Promise.all([
        import(CDN_BASE + "firebase-app.js"),
        import(CDN_BASE + "firebase-auth.js"),
        import(CDN_BASE + "firebase-firestore.js")
      ]).then(function (mods) {
        var appMod = mods[0], authMod = mods[1], fsMod = mods[2];
        var app = appMod.initializeApp(cfg);
        // No popup/redirect resolver: email + password only, keeps the bundle small
        // and works inside WebViews too.
        var auth = authMod.initializeAuth(app, {
          persistence: [authMod.indexedDBLocalPersistence, authMod.browserLocalPersistence]
        });
        var db;
        try { db = fsMod.initializeFirestore(app, { experimentalAutoDetectLongPolling: true }); }
        catch (e) { db = fsMod.getFirestore(app); }
        sdk = { appMod: appMod, authMod: authMod, fsMod: fsMod, app: app, auth: auth, db: db };
        authMod.onAuthStateChanged(auth, function (user) {
          (user ? attach(user) : detach()).catch(function () {});
        });
        return sdk;
      }).catch(function (e) { sdkPromise = null; throw e; });
      return sdkPromise;
    }

    function attach(user) {
      if (attachedUid === user.uid && engine) {
        update({ email: user.email || "", verified: !!user.emailVerified });
        return Promise.resolve();
      }
      return Promise.resolve(host.loadMeta()).catch(function () { return null; }).then(function (stored) {
        var valid = stored && stored.v === META_VERSION && stored.uid;
        if (valid && stored.uid !== user.uid) {
          var wipe = false;
          try {
            wipe = root.confirm(
              "На этом устройстве остались данные другого аккаунта" + (stored.email ? " (" + stored.email + ")" : "") + ".\n\n" +
              "ОК — удалить их и загрузить данные аккаунта " + (user.email || "") + ".\n" +
              "Отмена — оставить их и добавить в этот аккаунт."
            );
          } catch (e) {}
          if (wipe) host.wipeLocal();
          valid = false;
        }
        meta = valid && stored.uid === user.uid ? stored : freshMeta(user.uid, user.email);
        meta.email = user.email || "";
        meta.signedIn = true;
        remote = createFirebaseRemote(sdk, user.uid);
        engine = createEngine({
          host: host, remote: remote, meta: meta,
          saveMeta: function (m) { return host.saveMeta(m); },
          onState: function (s) { update({ phase: s.phase, error: s.error, lastSync: s.lastSync, pending: s.pending }); }
        });
        attachedUid = user.uid;
        update({ signedIn: true, email: user.email || "", verified: !!user.emailVerified, phase: "idle", error: "" });
        return Promise.resolve(host.saveMeta(meta)).catch(function () {}).then(function () {
          engine.sync(); // background; progress and errors are reported through status
        });
      });
    }

    function detach() {
      clearTimeout(timer);
      engine = null; remote = null; attachedUid = null;
      var save = Promise.resolve();
      if (meta) {
        meta.signedIn = false;
        save = Promise.resolve(host.saveMeta(meta)).catch(function () {});
      }
      return save.then(function () {
        update({ signedIn: false, email: "", verified: true, phase: "idle", error: "", pending: 0 });
      });
    }

    function needSdk() { return loadSdk().catch(function (e) { throw friendlyAuthError(e); }); }

    function schedule(ms) {
      clearTimeout(timer);
      timer = setTimeout(function () { if (engine) engine.sync(); }, ms);
    }

    function wrapAuth(fn) {
      return needSdk().then(function (s) {
        return fn(s).catch(function (e) { throw friendlyAuthError(e); });
      });
    }

    var api = {
      isConfigured: function () { return status.configured; },
      isSignedIn: function () { return status.signedIn; },
      getStatus: snapshot,
      onStatus: function (fn) { listeners.push(fn); },

      start: function (h) {
        if (started || !status.configured) return Promise.resolve();
        started = true;
        host = h;
        root.addEventListener("online", function () {
          if (engine) engine.sync();
          else if (status.signedIn && !sdk) loadSdk().catch(function () {});
        });
        document.addEventListener("visibilitychange", function () {
          if (document.visibilityState === "visible" && engine) engine.sync();
        });
        setInterval(function () {
          if (engine && document.visibilityState === "visible") engine.sync();
        }, AUTO_SYNC_MS);

        return Promise.resolve(host.loadMeta()).catch(function () { return null; }).then(function (stored) {
          // Only a hint for the UI until Firebase confirms the session.
          if (stored && stored.v === META_VERSION && stored.signedIn) {
            meta = stored;
            update({ signedIn: true, email: stored.email || "", lastSync: stored.lastSync || 0 });
            return loadSdk().catch(function () { update({ phase: "offline" }); });
          }
        });
      },

      signIn: function (email, password) {
        return wrapAuth(function (s) {
          return s.authMod.signInWithEmailAndPassword(s.auth, email, password).then(function (cred) {
            return attach(cred.user);
          });
        });
      },

      signUp: function (email, password) {
        return wrapAuth(function (s) {
          return s.authMod.createUserWithEmailAndPassword(s.auth, email, password).then(function (cred) {
            // Best effort: lets the user recover the account if they mistyped the address.
            s.authMod.sendEmailVerification(cred.user).catch(function () {});
            return attach(cred.user);
          });
        });
      },

      resetPassword: function (email) {
        return wrapAuth(function (s) { return s.authMod.sendPasswordResetEmail(s.auth, email); });
      },

      signOut: function () {
        return wrapAuth(function (s) { return s.authMod.signOut(s.auth); });
      },

      // Removes the cloud copy and the account itself. Local data on this device stays.
      deleteAccount: function (password) {
        return wrapAuth(function (s) {
          var user = s.auth.currentUser;
          if (!user) return Promise.reject({ code: "auth/requires-recent-login" });
          var cred = s.authMod.EmailAuthProvider.credential(user.email, password);
          return s.authMod.reauthenticateWithCredential(user, cred)
            .then(function () { return remote ? remote.deleteAll() : createFirebaseRemote(s, user.uid).deleteAll(); })
            .then(function () { return s.authMod.deleteUser(user); })
            .then(function () {
              meta = null;
              return Promise.resolve(host.saveMeta(null)).catch(function () {});
            });
        });
      },

      syncNow: function () {
        if (!engine) return needSdk().then(function () {});
        return engine.sync();
      },

      notifyLocalChange: function () {
        if (!engine) return;
        try { engine.noteChange(); } catch (e) {}
        schedule(1500);
      },

      // "Clear all data" was pressed in the app.
      onLocalCleared: function () {
        if (engine) {
          return engine.markCleared().then(function () { return engine.sync(); });
        }
        // Signed out: only this device is wiped. Forget the sync state so that the
        // cloud copy comes back down the next time the user signs in.
        meta = null;
        if (host) return Promise.resolve(host.saveMeta(null)).catch(function () {});
        return Promise.resolve();
      }
    };
    return api;
  }

  /* ------------------------------------------------------------------ */

  if (typeof window !== "undefined" && root === window) {
    root.AMSync = setupBrowserApi();
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      createEngine: createEngine, freshMeta: freshMeta, hashStr: hashStr,
      canonTitle: canonTitle, friendlySyncError: friendlySyncError
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
