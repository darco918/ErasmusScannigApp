// Applies the colour theme before the page is drawn (so it never flashes),
// and wires up every [data-theme-toggle] button. Dark unless the person
// switched to light on this device.
(function () {
  var KEY = 'theme';
  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].textContent = theme === 'dark' ? '☀' : '☾';
      buttons[i].title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      buttons[i].setAttribute('aria-label', buttons[i].title);
    }
  }
  apply(stored() === 'light' ? 'light' : 'dark');
  document.addEventListener('DOMContentLoaded', function () {
    apply(document.documentElement.dataset.theme);
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('[data-theme-toggle]')) return;
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch (err) {}
      apply(next);
    });
  });
})();
