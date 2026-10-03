/* Portfolio page: market + property-type filters, a sortable table view and a map view.
   Progressive enhancement: the controls ship `hidden` and are revealed here,
   so with no JS the page is just the full card grid. Cards carry data-market,
   data-type and data-name/-location/-lat/-lng/-sf/-type-label/-href/-avail; the
   table and the map are built from those attributes. Market groups hide
   themselves when no card matches. Leaflet is loaded only when the Map view is
   first opened, so the page itself never pays for it. */
(function () {
  'use strict';
  var grid = document.getElementById('portfolioGrid');
  if (!grid) return;

  var controls = document.querySelector('.pf-controls');
  var tableWrap = document.getElementById('portfolioTable');
  var mapWrap = document.getElementById('portfolioMapWrap');
  var mapEl = document.getElementById('portfolioMap');
  var mapNote = document.getElementById('portfolioMapNote');
  var empty = document.querySelector('.pf-empty');
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.pf-card'));
  var groups = Array.prototype.slice.call(grid.querySelectorAll('.pf-group'));
  var state = { market: 'all', type: 'all', view: 'cards' };
  var rows = [];
  var sort = { key: null, dir: 1 };
  var map = null;
  var pins = [];
  var MARKET_LABEL = { Maryland: 'Maryland', Ohio: 'Columbus', Missouri: 'Kansas City' };

  // Same pinned Leaflet build and integrity hashes as /available-space.
  var LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  var LEAFLET_JS_SRI = 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH';
  var LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  var LEAFLET_CSS_SRI = 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H';

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
    updatePins();
    if (empty) empty.hidden = anyVisible;
  }

  function setView(view) {
    state.view = view;
    if (view === 'table' && !tableWrap.firstChild) buildTable();
    tableWrap.hidden = view !== 'table';
    mapWrap.hidden = view !== 'map';
    grid.hidden = view !== 'cards';
    if (view === 'map') showMap();
  }

  function cell(tag, text, cls) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }

  // ── Table ────────────────────────────────────────────────────────────────────
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
      { key: 'type', label: 'Type' },
      { key: 'avail', label: 'Available', num: true }
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
        type: card.getAttribute('data-type-label'),
        avail: Number(card.getAttribute('data-avail')) || 0
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
      var availCell = cell('td', '', 'pf-table__num');
      var availHref = card.getAttribute('data-avail-href');
      if (data.avail && availHref) {
        var availLink = document.createElement('a');
        availLink.href = availHref;
        availLink.textContent = data.avail + (data.avail === 1 ? ' suite' : ' suites');
        availCell.appendChild(availLink);
      } else {
        availCell.textContent = '—';
      }
      tr.appendChild(availCell);
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

  // ── Map ──────────────────────────────────────────────────────────────────────
  function showNote(text) {
    if (!mapNote) return;
    mapNote.textContent = text;
    mapNote.hidden = false;
  }

  function loadLeaflet(done, fail) {
    if (window.L) { done(); return; }
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = LEAFLET_CSS;
    css.integrity = LEAFLET_CSS_SRI;
    css.crossOrigin = 'anonymous';
    document.head.appendChild(css);
    var js = document.createElement('script');
    js.src = LEAFLET_JS;
    js.integrity = LEAFLET_JS_SRI;
    js.crossOrigin = 'anonymous';
    js.onload = done;
    js.onerror = fail;
    document.head.appendChild(js);
  }

  function showMap() {
    if (map) { refreshMap(); return; }
    if (showMap.loading) return;
    showMap.loading = true;
    loadLeaflet(function () {
      showMap.loading = false;
      try { initMap(); refreshMap(); } catch (e) { showNote('The map could not load. Switch to Cards or Table to browse every property.'); }
    }, function () {
      showMap.loading = false;
      showNote('The map could not load. Switch to Cards or Table to browse every property.');
    });
  }

  function popupItem(card) {
    var item = document.createElement('div');
    item.className = 'pf-popup__item';
    var name = document.createElement('strong');
    name.textContent = card.getAttribute('data-name');
    item.appendChild(name);
    var meta = document.createElement('span');
    meta.className = 'pf-popup__meta';
    meta.textContent = card.getAttribute('data-location') + ' · ' +
      Number(card.getAttribute('data-sf')).toLocaleString('en-US') + ' SF · ' + card.getAttribute('data-type-label');
    item.appendChild(meta);
    var href = card.getAttribute('data-href');
    var availHref = card.getAttribute('data-avail-href');
    if (href || availHref) {
      var links = document.createElement('span');
      links.className = 'pf-popup__links';
      if (href) {
        var a = document.createElement('a');
        a.href = href;
        a.textContent = 'Property details';
        links.appendChild(a);
      }
      if (availHref) {
        var b = document.createElement('a');
        b.href = availHref;
        var n = Number(card.getAttribute('data-avail'));
        b.textContent = n + (n === 1 ? ' suite available' : ' suites available');
        links.appendChild(b);
      }
      item.appendChild(links);
    }
    return item;
  }

  function initMap() {
    map = L.map(mapEl, { zoomControl: true, scrollWheelZoom: false, maxZoom: 19 });
    var tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(map);
    // Wheel-zoom is armed by a click/focus on the map and released when the
    // pointer leaves, so scrolling the page past the map never gets captured.
    map.on('click focus', function () { map.scrollWheelZoom.enable(); });
    map.on('mouseout blur', function () { map.scrollWheelZoom.disable(); });

    // Pins that overlap on screen at the current zoom form a group. A small group
    // (e.g. two buildings on one parcel) shares one popup so a pin hidden underneath
    // another is still reachable. A dense group (every Columbus pin at the all-markets
    // zoom) zooms in on click instead, like marker clustering, so the popup never
    // becomes a wall of text.
    function groupFor(layer) {
      var here = map.latLngToLayerPoint(layer.getLatLng());
      return pins.filter(function (p) {
        if (p.marker !== layer && !map.hasLayer(p.marker)) return false;
        return p.marker === layer || map.latLngToLayerPoint(p.marker.getLatLng()).distanceTo(here) < 24;
      });
    }
    function contentFor(group) {
      var wrap = document.createElement('div');
      wrap.className = 'pf-popup';
      group.forEach(function (p, i) {
        if (i) wrap.appendChild(document.createElement('hr'));
        wrap.appendChild(popupItem(p.card));
      });
      return wrap;
    }
    function openGroup(marker) {
      var group = groupFor(marker);
      if (group.length > 3 && map.getZoom() < 14) {
        map.fitBounds(L.latLngBounds(group.map(function (p) { return p.marker.getLatLng(); })), { padding: [60, 60], maxZoom: 16 });
        return;
      }
      L.popup({ maxHeight: 280 }).setLatLng(marker.getLatLng()).setContent(contentFor(group)).openOn(map);
    }

    cards.forEach(function (card) {
      var lat = Number(card.getAttribute('data-lat'));
      var lng = Number(card.getAttribute('data-lng'));
      if (!isFinite(lat) || !isFinite(lng)) return;
      var icon = L.divIcon({
        html: '<span></span>',
        className: 'pf-pin pf-pin--' + card.getAttribute('data-type'),
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      var marker = L.marker([lat, lng], { icon: icon, title: card.getAttribute('data-name'), riseOnHover: true }).addTo(map);
      marker.on('click', function () { openGroup(marker); });
      pins.push({ card: card, marker: marker });
    });

    // If the public OSM tile server is down, say so instead of showing a blank grey
    // map; the pins and every property card still work without tiles.
    var tileErrors = 0;
    var tilesLoaded = 0;
    tiles.on('tileload', function () {
      tilesLoaded++;
      if (mapNote) mapNote.hidden = true;
    });
    tiles.on('tileerror', function () {
      tileErrors++;
      if (tileErrors >= 4 && tilesLoaded === 0) showNote('Map tiles are unavailable right now. The pins and every property card still work.');
    });

    // The first fit can run before the container has its real size (a deep link opens the
    // map while the page is still laying out; the in-app browser sizes its pane late). Leaflet
    // then frames the map for a zero-size box (world zoom) and nothing re-frames it. So
    // re-frame whenever the container is resized, until the visitor touches the map: after
    // that their own pan/zoom wins.
    var touched = false;
    ['pointerdown', 'wheel', 'keydown'].forEach(function (name) {
      mapEl.addEventListener(name, function () { touched = true; }, { passive: true });
    });
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!touched && mapEl.clientWidth > 0) refreshMap();
      }).observe(mapEl);
    }
  }

  function updatePins() {
    if (!map) return;
    var visible = [];
    pins.forEach(function (p) {
      if (matches(p.card)) {
        if (!map.hasLayer(p.marker)) p.marker.addTo(map);
        visible.push(p.marker.getLatLng());
      } else if (map.hasLayer(p.marker)) {
        map.removeLayer(p.marker);
      }
    });
    if (visible.length && state.view === 'map') {
      map.invalidateSize();
      map.fitBounds(L.latLngBounds(visible).pad(0.15), { animate: false, maxZoom: 15 });
    }
  }

  // The container is display:none until the Map view opens, so Leaflet must be told
  // its real size, then framed on whatever the current filters leave visible.
  function refreshMap() {
    map.invalidateSize();
    updatePins();
    var slug = (location.hash || '').replace('#', '');
    pins.forEach(function (p) {
      if (slug && p.card.id === slug) {
        // A deep link to one property zooms to it (again after a resize re-frames the map)
        // and opens its popup once.
        map.setView(p.marker.getLatLng(), 16, { animate: false });
        if (!refreshMap.opened) {
          refreshMap.opened = true;
          p.marker.fire('click');
        }
      }
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────
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

  // Deep link: /portfolio?view=map (or =table), used by the property pages.
  var wanted = /[?&]view=(map|table)\b/.exec(location.search);
  if (wanted) {
    var pill = document.querySelector('[data-pf-view="' + wanted[1] + '"]');
    if (pill) pill.click();
  }
})();
