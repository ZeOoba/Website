/* Portfolio page: market + property-type filters.
   Progressive enhancement: with no JS every property is visible and the
   filter controls simply do nothing. Cards carry data-market / data-type;
   market groups hide themselves when none of their cards match. */
(function () {
  'use strict';
  var grid = document.getElementById('portfolioGrid');
  if (!grid) return;

  var cards = Array.prototype.slice.call(grid.querySelectorAll('.pf-card'));
  var groups = Array.prototype.slice.call(grid.querySelectorAll('.pf-group'));
  var empty = document.querySelector('.pf-empty');
  var state = { market: 'all', type: 'all' };

  function apply() {
    cards.forEach(function (card) {
      var show =
        (state.market === 'all' || card.getAttribute('data-market') === state.market) &&
        (state.type === 'all' || card.getAttribute('data-type') === state.type);
      card.classList.toggle('is-hidden', !show);
    });
    var anyVisible = false;
    groups.forEach(function (group) {
      var visible = !!group.querySelector('.pf-card:not(.is-hidden)');
      group.classList.toggle('is-hidden', !visible);
      if (visible) anyVisible = true;
    });
    if (empty) empty.hidden = anyVisible;
  }

  function bind(attr, key) {
    var pills = Array.prototype.slice.call(document.querySelectorAll('[' + attr + ']'));
    pills.forEach(function (pill) {
      pill.addEventListener('click', function () {
        state[key] = pill.getAttribute(attr) || 'all';
        pills.forEach(function (other) {
          var on = other === pill;
          other.classList.toggle('pf-pill--active', on);
          other.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        apply();
      });
    });
  }

  bind('data-pf-market', 'market');
  bind('data-pf-type', 'type');
})();
