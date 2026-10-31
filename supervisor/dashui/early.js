// Runs before the page is painted (issue #58): puts the saved navigation dock and rail state on <html> so there is no jump.
// Same-origin, sends nothing. The breakpoint edges and dock names mirror logic.mjs (a test keeps them identical).
(function () {
  try {
    var w = window.innerWidth, bp = w >= 1100 ? 'desktop' : w >= 640 ? 'tablet' : 'phone';
    var d = JSON.parse(localStorage.getItem('dash.dock.' + bp));
    var docks = ['top', 'bottom', 'left', 'right'];
    document.documentElement.dataset.dock = bp === 'phone' ? 'bottom' : docks.indexOf(d) >= 0 ? d : 'top';
    if (JSON.parse(localStorage.getItem('dash.navrail')) === true) document.documentElement.dataset.rail = 'collapsed';
  } catch (e) { document.documentElement.dataset.dock = 'top'; }
})();
