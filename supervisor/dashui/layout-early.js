// Runs right after <main>, before the page is first painted (issue #492): applies the saved card layout (order, widths, heights,
// collapsed cards) from this browser's storage so cards never move after the first draw, also on a normal page load. Same-origin,
// sends nothing. It mirrors applyLayout and sanitizeCollapsed in logic.mjs (a test runs both on the same input); app.js applies
// the same layout again once it loads, so a failure here only costs the early draw. A free layout (v: 2, a saved place and size per
// card, grid.mjs) is applied as the card's --cx/--cy/--cw/--ch with the .free class on the grid; an old order/span/h layout is applied as before.
// Local time (issue #493): early.js (in <head>, blocking) marks <html> .tzp, which hides the page (CSS visibility, no layout shift) until
// this script has converted the times and removed it, so no time text can change while visible. If this script never runs, a CSS
// animation reveals the page after 10 s (long enough that a slow layout-early.js does not bring back a UTC-then-local flash, issue #839). Every <time data-local> and [data-lms] is put in this browser's zone here, before the first paint, so a time
// never changes text after the first draw. Mirrors formatLocal and timeOnly in logic.mjs (a test compares them); app.js skips .lz nodes.
(function () {
  try {
    var zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch (e) { zone = 'UTC'; }
    var fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
    var local = function (ms) {
      var p = {}; fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
      return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ' ' + p.timeZoneName;
    };
    var times = document.querySelectorAll('time[data-local]'), i;
    for (i = 0; i < times.length; i++) {
      var el = times[i], ms = Date.parse(el.getAttribute('datetime'));
      if (!isFinite(ms)) continue;
      el.setAttribute('title', el.textContent + ' (stored in UTC); shown in your time zone, ' + zone);
      el.textContent = local(ms);
      el.classList.add('lz');
    }
    var svg = document.querySelectorAll('[data-lms]');
    for (i = 0; i < svg.length; i++) {
      var e2 = svg[i], m2 = Number(e2.getAttribute('data-lms'));
      if (!isFinite(m2)) continue;
      var t = local(m2); if (e2.hasAttribute('data-tonly')) t = t.slice(11);
      e2.textContent = (e2.getAttribute('data-tpl') || '{t}').replace('{t}', function () { return t; });
      e2.classList.add('lz');
    }
    var note = document.getElementById && document.getElementById('tznote');
    if (note) note.textContent = 'Times are shown in your time zone (' + zone + '). Data is stored in UTC; hover a time to see it.';   // same text as app.js
  } catch (e) { /* app.js converts them later */ }
  try { document.documentElement.classList.remove('tzp'); } catch (e) { /* the CSS fallback reveals the page */ }
})();
(function () {
  try {
    var w = window.innerWidth, bp = w >= 1100 ? 'desktop' : w >= 640 ? 'tablet' : 'phone';
    var grid = document.querySelector('.cards[data-layout]');
    var page = grid ? grid.getAttribute('data-layout') : location.pathname;
    var saved = JSON.parse(localStorage.getItem('dash.layout.' + page + '.' + bp));
    if (!saved || typeof saved !== 'object') return;
    var all = document.querySelectorAll('.card[data-card]'), i;
    var cols = bp === 'desktop' ? 24 : 12, free = bp !== 'phone' && saved.v === 2 && saved.pos && typeof saved.pos === 'object' && !Array.isArray(saved.pos);
    var coll = Array.isArray(saved.collapsed) ? saved.collapsed : [];
    for (i = 0; i < all.length; i++) if (coll.indexOf(all[i].getAttribute('data-card')) >= 0) all[i].classList.add('collapsed');
    if (!grid) return;
    if (free) {
      var hid = Array.isArray(saved.hidden) ? saved.hidden : [];
      grid.classList.add('free'); grid.style.setProperty('--cols', cols);
      for (i = 0; i < all.length; i++) {
        var cid = all[i].getAttribute('data-card'), r = Object.prototype.hasOwnProperty.call(saved.pos, cid) ? saved.pos[cid] : null;
        if (hid.indexOf(cid) >= 0 && !all[i].hasAttribute('data-pin')) { all[i].classList.add('lay-hidden'); continue; }
        if (!r || typeof r !== 'object' || !Number.isInteger(r.x) || !Number.isInteger(r.y) || !Number.isInteger(r.w) || !Number.isInteger(r.h)) continue;
        var cw = Math.min(cols, Math.max(3, r.w)), ch = Math.min(400, Math.max(4, r.h));
        all[i].style.setProperty('--cx', Math.min(cols - cw, Math.max(0, r.x))); all[i].style.setProperty('--cy', Math.max(0, r.y));
        all[i].style.setProperty("--cw", cw); all[i].style.setProperty("--ch", ch);
      }
      return;
    }
    var cards = [], byId = {};
    for (i = 0; i < grid.children.length; i++) {
      var c = grid.children[i];
      if (c.classList.contains('card') && c.hasAttribute('data-card')) { cards.push(c); byId[c.getAttribute('data-card')] = c; }
    }
    var gids = cards.map(function (x) { return x.getAttribute('data-card'); });
    var order = (Array.isArray(saved.order) ? saved.order : []).filter(function (id) { return gids.indexOf(id) >= 0; });
    gids.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    order.forEach(function (id) { grid.appendChild(byId[id]); });
    var span = saved.span && typeof saved.span === 'object' ? saved.span : {}, hs = saved.h && typeof saved.h === 'object' ? saved.h : {};
    cards.forEach(function (x) {
      var id = x.getAttribute('data-card'), s = span[id], h = hs[id];
      var okS = bp !== 'phone' && Number.isInteger(s) && s >= 1 && s <= 12;
      var okH = bp !== 'phone' && Number.isInteger(h) && h >= 40 && h <= 4000;
      if (bp === 'desktop' && okS) x.style.setProperty('--span', s);
      if (bp === 'tablet' && okS) x.style.setProperty('--tspan', s);
      if (okH) { x.style.setProperty('--h', h + 'px'); x.style.alignSelf = 'start'; }
    });
  } catch (e) { /* no usable saved layout: the server order stands */ }
})();
(function () {
  // Issue #1453: the period each summary card shows, kept per card in its own key (dashui/headline-period.mjs) and applied before the first paint.
  try {
    var w = window.innerWidth, bp = w >= 1100 ? 'desktop' : w >= 640 ? 'tablet' : 'phone';
    var grid = document.querySelector('.cards[data-layout]');
    var saved = JSON.parse(localStorage.getItem('dash.period.' + (grid ? grid.getAttribute('data-layout') : location.pathname) + '.' + bp));
    if (!saved || typeof saved !== 'object') return;
    var cards = document.querySelectorAll('.card.headline[data-card]'), i, id;
    for (i = 0; i < cards.length; i++) {
      id = cards[i].getAttribute('data-card');
      if (Object.prototype.hasOwnProperty.call(saved, id) && (saved[id] === '24h' || saved[id] === '7d')) cards[i].setAttribute('data-period', saved[id]);
    }
  } catch (e) { /* the default period stands */ }
})();
