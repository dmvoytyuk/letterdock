// Theme toggle (and opens the Gmail steps). The page works without this file.
(function () {
  var d = document, r = d.documentElement, b = d.getElementById('theme'), K = 'letterdock-theme';
  function pics(t) {
    d.querySelectorAll('source[data-t]').forEach(function (s) {
      s.dataset.o = s.dataset.o || s.media;
      s.media = !t ? s.dataset.o : s.dataset.t === t ? s.dataset.m : 'not all';
    });
  }
  function apply(t) {
    r.dataset.theme = t;
    b.setAttribute('aria-pressed', t === 'dark');
    pics(t);
  }
  function isDark() {
    return r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  if (b) {
    try { var s = localStorage.getItem(K); if (s === 'dark' || s === 'light') apply(s); } catch { /* no storage */ }
    if (!r.dataset.theme) b.setAttribute('aria-pressed', isDark());
    b.hidden = false;
    b.addEventListener('click', function () {
      var t = isDark() ? 'light' : 'dark';
      apply(t);
      try { localStorage.setItem(K, t); } catch { /* no storage */ }
    });
  }
  var a = d.getElementById('apw-link');
  if (a) a.addEventListener('click', function () { d.getElementById('app-password').open = true; });
})();
