// Runs right after <main>, before the page is first painted (issue #431): applies the saved card layout (order, widths, heights,
// collapsed cards) from this browser's storage so cards never move after the first draw. Same-origin, sends nothing. It mirrors
// applyLayout and sanitizeCollapsed in logic.mjs (a test runs both on the same input); app.js re-applies the same layout later.
// Local time (issue #431): every <time data-local> and [data-lms] is put in this browser's zone here, before the first paint, so the
// times are local on the first draw (mirrors formatLocal and timeOnly in logic.mjs; a test compares them). app.js skips .lz nodes.
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
      if (isFinite(ms)) { el.setAttribute('title', el.textContent + ' (stored in UTC); shown in your time zone, ' + zone); el.textContent = local(ms); }
      el.classList.add('lz');
    }
    var svg = document.querySelectorAll('[data-lms]');
    for (i = 0; i < svg.length; i++) {
      var e2 = svg[i], m2 = Number(e2.getAttribute('data-lms'));
      if (isFinite(m2)) {
        var t = local(m2); if (e2.hasAttribute('data-tonly')) t = t.slice(11);
        e2.textContent = (e2.getAttribute('data-tpl') || '{t}').replace('{t}', function () { return t; });
      }
      e2.classList.add('lz');
    }
  } catch (e) { /* app.js converts them later */ }
})();
(function () {
  try {
    var w = window.innerWidth, bp = w >= 1100 ? 'desktop' : w >= 640 ? 'tablet' : 'phone';
    var grid = document.querySelector('.cards[data-layout]');
    var page = grid ? grid.getAttribute('data-layout') : location.pathname;
    var saved = JSON.parse(localStorage.getItem('dash.layout.' + page + '.' + bp));
    if (!saved || typeof saved !== 'object') return;
    var all = document.querySelectorAll('.card[data-card]');
    var ids = [], i;
    for (i = 0; i < all.length; i++) ids.push(all[i].getAttribute('data-card'));
    var coll = Array.isArray(saved.collapsed) ? saved.collapsed : [];
    for (i = 0; i < all.length; i++) if (coll.indexOf(all[i].getAttribute('data-card')) >= 0) all[i].classList.add('collapsed');
    if (!grid) return;
    var cards = [], byId = {};
    for (i = 0; i < grid.children.length; i++) {
      var c = grid.children[i];
      if (c.classList.contains('card') && c.hasAttribute('data-card')) { cards.push(c); byId[c.getAttribute('data-card')] = c; }
    }
    var gids = cards.map(function (c) { return c.getAttribute('data-card'); });
    var order = (Array.isArray(saved.order) ? saved.order : []).filter(function (id) { return gids.indexOf(id) >= 0; });
    gids.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    order.forEach(function (id) { grid.appendChild(byId[id]); });
    cards.forEach(function (c) {
      var id = c.getAttribute('data-card'), s = saved.span && saved.span[id], h = saved.h && saved.h[id];
      var okS = bp !== 'phone' && Number.isInteger(s) && s >= 1 && s <= 12;
      var okH = bp !== 'phone' && Number.isInteger(h) && h >= 40 && h <= 4000;
      if (bp === 'desktop' && okS) c.style.setProperty('--span', s);
      if (bp === 'tablet' && okS) c.style.setProperty('--tspan', s);
      if (okH) { c.style.setProperty('--h', h + 'px'); c.style.alignSelf = 'start'; }
    });
  } catch (e) { /* no saved layout: the server order stands */ }
})();
