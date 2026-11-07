// Runs before the page is painted (issue #58): puts the saved navigation dock and rail state on <html> so there is no jump.
// Same-origin, sends nothing. The breakpoint edges and dock names mirror logic.mjs (a test keeps them identical).
(function () {
  var cl = document.documentElement.classList; if (cl) { cl.add('js'); cl.add('tzp'); }   // lets the stylesheet reserve the list controls' room before paint (no jump when the script starts)
  try {
    var w = window.innerWidth, bp = w >= 1100 ? 'desktop' : w >= 640 ? 'tablet' : 'phone';
    var d = JSON.parse(localStorage.getItem('dash.dock.' + bp));
    var docks = ['top', 'bottom', 'left', 'right'];
    document.documentElement.dataset.dock = bp === 'phone' ? 'bottom' : docks.indexOf(d) >= 0 ? d : 'top';
    var nw = JSON.parse(localStorage.getItem('dash.navw')); if (typeof nw === 'number' && nw >= 140 && nw <= 480) document.documentElement.style.setProperty('--nav-w', nw + 'px');
    if (JSON.parse(localStorage.getItem('dash.sticky')) === true) document.documentElement.dataset.sticky = 'on';
    if (JSON.parse(localStorage.getItem('dash.navrail')) === true) document.documentElement.dataset.rail = 'collapsed';
  } catch (e) { document.documentElement.dataset.dock = 'top'; }
})();
