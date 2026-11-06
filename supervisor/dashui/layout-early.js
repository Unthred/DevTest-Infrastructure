// Runs right after <main>, before the page is first painted (issue #492): applies the saved card layout (order, widths, heights,
// collapsed cards) from this browser's storage so cards never move after the first draw, also on a normal page load. Same-origin,
// sends nothing. It mirrors applyLayout and sanitizeCollapsed in logic.mjs (a test runs both on the same input); app.js applies
// the same layout again once it loads, so a failure here only costs the early draw. A free layout (v: 2, a saved place and size per
// card, grid.mjs) is applied as the card's --cx/--cy/--cw/--ch with the .free class on the grid; an old order/span/h layout is applied as before.
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
