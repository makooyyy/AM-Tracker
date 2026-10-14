/* Pure helpers and the standalone PNG renderer used by AM Tracker. */
(function (root) {
  "use strict";
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
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
    return titles.filter(function (m) { return m.status === "reading" && opened[m.id] > 0; })
      .sort(function (a, b) { return opened[b.id] - opened[a.id]; }).slice(0, 8);
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
  var api = { annualAwards: annualAwards, ratings: ratings, ratingInMonth: ratingInMonth, comparison: comparison, continueReading: continueReading,
    awardSnapshot: awardSnapshot, createShareCard: createShareCard, textLines: textLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AMFeatures = api;
})(typeof window !== "undefined" ? window : globalThis);
