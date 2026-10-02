/* Portfolio page: market + property-type filters and a sortable table view.
   Progressive enhancement: the controls ship `hidden` and are revealed here,
   so with no JS the page is just the full card grid. Cards carry data-market,
   data-type and data-name/-location/-sf/-type-label/-href; the table is built
   from those attributes. Market groups hide themselves when no card matches. */
(function () {
  'use strict';
  var grid = document.getElementById('portfolioGrid');
  if (!grid) return;

  var controls = document.querySelector('.pf-controls');
  var tableWrap = document.getElementById('portfolioTable');
  var empty = document.querySelector('.pf-empty');
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.pf-card'));
  var groups = Array.prototype.slice.call(grid.querySelectorAll('.pf-group'));
  var state = { market: 'all', type: 'all', view: 'cards' };
  var rows = [];
  var sort = { key: null, dir: 1 };
  var MARKET_LABEL = { Maryland: 'Maryland', Ohio: 'Columbus', Missouri: 'Kansas City' };

  function matches(el) {
    return (
      (state.market === 'all' || el.getAttribute('data-market') === state.market) &&
      (state.type === 'all' || el.getAttribute('data-type') === state.type)
    );
  }

  function apply() {
    var anyVisible = false;
    cards.forEach(function (card) {
      card.classList.toggle('is-hidden', !matches(card));
    });
    groups.forEach(function (group) {
      var visible = !!group.querySelector('.pf-card:not(.is-hidden)');
      group.classList.toggle('is-hidden', !visible);
      if (visible) anyVisible = true;
    });
    rows.forEach(function (row) {
      row.classList.toggle('is-hidden', !matches(row));
    });
    if (empty) empty.hidden = anyVisible;
  }

  function setView(view) {
    state.view = view;
    if (view === 'table' && !tableWrap.firstChild) buildTable();
    tableWrap.hidden = view !== 'table';
    grid.hidden = view === 'table';
  }

  function cell(tag, text, cls) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }

  function buildTable() {
    var table = document.createElement('table');
    table.className = 'pf-table';
    var caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent = 'Oxford Realty Advisors portfolio by property';
    table.appendChild(caption);

    var cols = [
      { key: 'name', label: 'Property' },
      { key: 'location', label: 'Location' },
      { key: 'market', label: 'Market' },
      { key: 'sf', label: 'Size (SF)', num: true },
      { key: 'type', label: 'Type' }
    ];
    var headRow = document.createElement('tr');
    cols.forEach(function (col) {
      var th = document.createElement('th');
      th.scope = 'col';
      if (col.num) th.className = 'pf-table__num';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pf-table__sort';
      btn.textContent = col.label;
      btn.addEventListener('click', function () {
        sort.dir = sort.key === col.key ? -sort.dir : 1;
        sort.key = col.key;
        sortRows(cols, headRow);
      });
      th.appendChild(btn);
      headRow.appendChild(th);
    });
    var thead = document.createElement('thead');
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    cards.forEach(function (card) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-market', card.getAttribute('data-market'));
      tr.setAttribute('data-type', card.getAttribute('data-type'));
      var data = {
        name: card.getAttribute('data-name'),
        location: card.getAttribute('data-location'),
        market: MARKET_LABEL[card.getAttribute('data-market')] || card.getAttribute('data-market'),
        sf: Number(card.getAttribute('data-sf')),
        type: card.getAttribute('data-type-label')
      };
      tr._data = data;
      var nameCell = document.createElement('th');
      nameCell.scope = 'row';
      var href = card.getAttribute('data-href');
      if (href) {
        var link = document.createElement('a');
        link.href = href;
        link.textContent = data.name;
        nameCell.appendChild(link);
      } else {
        nameCell.textContent = data.name;
      }
      tr.appendChild(nameCell);
      tr.appendChild(cell('td', data.location));
      tr.appendChild(cell('td', data.market));
      tr.appendChild(cell('td', data.sf.toLocaleString('en-US'), 'pf-table__num'));
      tr.appendChild(cell('td', data.type));
      tbody.appendChild(tr);
      rows.push(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    apply();
  }

  function sortRows(cols, headRow) {
    var tbody = tableWrap.querySelector('tbody');
    var sorted = rows.slice().sort(function (a, b) {
      var x = a._data[sort.key];
      var y = b._data[sort.key];
      var cmp = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
      return cmp * sort.dir;
    });
    sorted.forEach(function (row) { tbody.appendChild(row); });
    Array.prototype.forEach.call(headRow.children, function (th, i) {
      if (cols[i].key === sort.key) th.setAttribute('aria-sort', sort.dir === 1 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  function bind(attr, onChange) {
    var pills = Array.prototype.slice.call(document.querySelectorAll('[' + attr + ']'));
    pills.forEach(function (pill) {
      pill.addEventListener('click', function () {
        onChange(pill.getAttribute(attr) || 'all');
        pills.forEach(function (other) {
          var on = other === pill;
          other.classList.toggle('pf-pill--active', on);
          other.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        apply();
      });
    });
  }

  bind('data-pf-market', function (v) { state.market = v; });
  bind('data-pf-type', function (v) { state.type = v; });
  bind('data-pf-view', setView);
  if (controls) controls.hidden = false;
})();
