/* listings.js — Oxford Realty Advisors Available Space
 * Renders listing cards with LoopNet-style expandable units, Leaflet map,
 * filters, stats bar, and detail overlay.
 * v3 — 2026-04-06 — current availabilities only
 */
(function () {
  'use strict';

  // ── Property Data (current availabilities only) ──────────────────────────────
  var LISTINGS = [
    {
      id: 1, name: '2012-2026 Zettler Rd', city: 'Columbus', state: 'OH', market: 'Columbus',
      category: 'Flex', lat: 39.957, lng: -82.960,
      img: '/images/10-zettler-2012-2026-exterior-.jpg', slug: '2012-2026-zettler-rd',
      desc: 'Adjacent small-bay flex industrial on Zettler Rd, Columbus.',
      units: [
        { suite: '2016', sf: 1800, sfLabel: '1,800 SF', rate: '$11.67', rateType: 'MG', use: 'Flex' }
      ]
    },
    {
      id: 2, name: '384-398 Morrison Rd', city: 'Columbus', state: 'OH', market: 'Columbus',
      category: 'Flex', lat: 39.938, lng: -82.974,
      img: '/images/17-warehouse-columbus-external.jpg', slug: '384-398-morrison-rd',
      desc: 'Flex/warehouse complex on Morrison Rd, Columbus, OH.',
      units: [
        { suite: '390', sf: 1800, sfLabel: '1,800 SF', rate: '$13.33', rateType: 'MG', use: 'Flex' }
      ]
    },
    {
      id: 3, name: '2000-2002 Zettler Rd', city: 'Columbus', state: 'OH', market: 'Columbus',
      category: 'Industrial', lat: 39.958, lng: -82.961,
      img: '/images/07-2000_2002-front.jpg', slug: '2000-2002-zettler-rd',
      desc: 'Small-bay industrial in Columbus near the I-70/I-270 interchange.',
      units: [
        { suite: '2000', sf: 4960, sfLabel: '4,960 SF', rate: '$8.00', rateType: 'NNN', use: 'Industrial' },
        { suite: '2002', sf: 6200, sfLabel: '6,200 SF', rate: '$8.00', rateType: 'NNN', use: 'Industrial' }
      ]
    },
    {
      id: 4, name: 'Northwood Business Center', subtitle: '2203 Northwood Dr',
      city: 'Easton', state: 'MD', market: 'Maryland',
      category: 'Flex', lat: 38.780, lng: -76.080,
      img: '/images/06-exterior-beauty.jpg', slug: '2203-northwood-dr',
      desc: 'Multi-tenant industrial flex park in Easton, MD.',
      units: [
        { suite: 'A1-2', sf: 1200, sfMax: 2400, sfLabel: '1,200\u20132,400 SF', rate: '$10.99', rateType: '+UTIL', use: 'Flex' }
      ]
    },
    {
      id: 5, name: '2800-2826 Banwick Rd', city: 'Columbus', state: 'OH', market: 'Columbus',
      category: 'Flex', lat: 39.939, lng: -82.953,
      img: '/images/01-2800-2826-banwick-exterior.jpg', slug: '2800-2826-banwick-rd',
      desc: 'Shallow-bay flex industrial in Columbus, OH near I-270.',
      units: [
        { suite: '2814', sf: 1500, sfLabel: '1,500 SF', rate: '$13.60', rateType: 'MG', use: 'Flex' }
      ]
    },
    {
      id: 6, name: '9620 E State Route 350', city: 'Raytown', state: 'MO', market: 'Kansas City',
      category: 'Retail', lat: 38.946, lng: -94.462,
      img: '/images/05-exterior-front.jpg', slug: '9620-state-route-350',
      desc: 'Flex industrial in the Raytown submarket of Kansas City, MO.',
      units: [
        { suite: '107-108', sf: 5745, sfLabel: '5,745 SF', rate: '$10.00', rateType: '+UTIL', use: 'Retail' },
        { suite: '110', sf: 2865, sfLabel: '2,865 SF', rate: '$10.00', rateType: '+UTIL', use: 'Retail' }
      ]
    }
  ];

  // ── State ────────────────────────────────────────────────────────────────────
  var filtered = LISTINGS.slice();
  var viewMode = 'cards';
  var expandedIds = {};
  var map, markers = [];

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  // ── Format helpers ───────────────────────────────────────────────────────────
  function fmtSF(n) {
    return n >= 1000 ? n.toLocaleString() + ' SF' : n + ' SF';
  }
  function totalSF(p) {
    return p.units.reduce(function (s, u) { return s + (u.sfMax || u.sf); }, 0);
  }
  function totalUnits() {
    return LISTINGS.reduce(function (s, p) { return s + p.units.length; }, 0);
  }
  function totalAvailSF() {
    return LISTINGS.reduce(function (s, p) {
      return s + p.units.reduce(function (us, u) { return us + (u.sfMax || u.sf); }, 0);
    }, 0);
  }

  // ── Populate filter dropdowns ─────────────────────────────────────────────────
  function populateFilters() {
    var markets = [];
    var types = [];
    LISTINGS.forEach(function (p) {
      if (markets.indexOf(p.market) === -1) markets.push(p.market);
      if (types.indexOf(p.category) === -1) types.push(p.category);
    });
    markets.sort();
    types.sort();
    var mSel = el('filterMarket');
    var tSel = el('filterType');
    markets.forEach(function (m) {
      var o = document.createElement('option'); o.value = m; o.textContent = m;
      mSel.appendChild(o);
    });
    types.forEach(function (t) {
      var o = document.createElement('option'); o.value = t; o.textContent = t;
      tSel.appendChild(o);
    });
  }

  // ── Apply filters ─────────────────────────────────────────────────────────────
  function applyFilters() {
    var q = (el('searchInput').value || '').toLowerCase().trim();
    var market = el('filterMarket').value;
    var type = el('filterType').value;
    var size = el('filterSize').value;
    var sort = el('sortBy').value;

    filtered = LISTINGS.filter(function (p) {
      if (q && !(p.name.toLowerCase().indexOf(q) !== -1 || p.city.toLowerCase().indexOf(q) !== -1 ||
        p.category.toLowerCase().indexOf(q) !== -1 || (p.subtitle && p.subtitle.toLowerCase().indexOf(q) !== -1))) return false;
      if (market && p.market !== market) return false;
      if (type && p.category !== type) return false;
      if (size) {
        var parts = size.split('-');
        var min = parseInt(parts[0], 10);
        var max = parts[1] ? parseInt(parts[1], 10) : Infinity;
        var pMax = totalSF(p);
        if (pMax < min || p.units[0].sf > max) return false;
      }
      return true;
    });

    if (sort === 'sf-desc') filtered.sort(function (a, b) { return totalSF(b) - totalSF(a); });
    else if (sort === 'sf-asc') filtered.sort(function (a, b) { return totalSF(a) - totalSF(b); });
    else if (sort === 'name') filtered.sort(function (a, b) { return a.name.localeCompare(b.name); });

    renderStats();
    renderCards();
    updateMapMarkers();
  }

  // ── Stats bar ─────────────────────────────────────────────────────────────────
  function renderStats() {
    var units = filtered.reduce(function (s, p) { return s + p.units.length; }, 0);
    el('statListings').textContent = units;
    var sf = filtered.reduce(function (s, p) {
      return s + p.units.reduce(function (us, u) { return us + (u.sfMax || u.sf); }, 0);
    }, 0);
    el('statSF').textContent = sf.toLocaleString() + ' SF';

    // Rate range
    var rates = [];
    filtered.forEach(function (p) {
      p.units.forEach(function (u) {
        var r = parseFloat(u.rate.replace('$', ''));
        if (!isNaN(r)) rates.push(r);
      });
    });
    if (rates.length) {
      var lo = Math.min.apply(null, rates);
      var hi = Math.max.apply(null, rates);
      el('statRange').textContent = lo === hi ? '$' + lo.toFixed(2) : '$' + lo.toFixed(2) + ' \u2013 $' + hi.toFixed(2);
    } else {
      el('statRange').textContent = '\u2014';
    }
    var rc = el('resultsCount');
    if (rc) rc.textContent = filtered.length + ' properties \u00B7 ' + units + ' spaces';
  }

  // ── Unit row HTML ────────────────────────────────────────────────────────────
  function unitRowHTML(u, pId, pName) {
    var subject = pName ? pName + ' Suite ' + u.suite : 'Suite ' + u.suite;
    var label = pName ? 'Inquire about Suite ' + u.suite + ' at ' + pName : 'Inquire about Suite ' + u.suite;
    return '<div class="as-unit" data-pid="' + pId + '" data-suite="' + u.suite + '">' +
      '<div class="as-unit__suite"><span class="as-unit__label">Suite</span>' + u.suite + '</div>' +
      '<div class="as-unit__sf"><span class="as-unit__label">Size</span>' + u.sfLabel + '</div>' +
      '<div class="as-unit__use"><span class="as-unit__label">Use</span>' + u.use + '</div>' +
      '<div class="as-unit__rate"><span class="as-unit__label">Asking</span>' + u.rate + ' <span class="as-unit__rate-type">' + u.rateType + '</span></div>' +
      '<a href="mailto:info@oxfordra.net?subject=Inquiry%20-%20' + encodeURIComponent(subject) + '" class="as-unit__inquire" aria-label="' + label + '">Inquire</a>' +
      '</div>';
  }

  // ── Card HTML ─────────────────────────────────────────────────────────────────
  function cardHTML(p) {
    var multiUnit = p.units.length > 1;
    var isExpanded = expandedIds[p.id];
    var totalPropSF = totalSF(p);
    var badgeText = multiUnit ? p.units.length + ' Spaces' : '1 Space';
    var subtitle = p.subtitle ? '<div class="as-card__subtitle">' + p.subtitle + '</div>' : '';

    var html = '<article class="as-card' + (isExpanded ? ' as-card--expanded' : '') + '" data-id="' + p.id + '">' +
      '<div class="as-card__img">' +
      '<img src="' + p.img + '" alt="' + p.name + ' property photo" loading="lazy" decoding="async">' +
      '<span class="as-card__badge as-card__badge--available">' + badgeText + '</span>' +
      '</div>' +
      '<div class="as-card__body">' +
      '<h2 class="as-card__title">' + p.name + '</h2>' +
      subtitle +
      '<div class="as-card__address">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' +
      p.city + ', ' + p.state +
      '</div>' +
      '<div class="as-card__stats">' +
      '<span class="as-card__stat">' + fmtSF(totalPropSF) + ' total</span>' +
      '<span class="as-card__stat">' + p.category + '</span>' +
      '<span class="as-card__stat">' + p.market + '</span>' +
      '</div>';

    if (multiUnit) {
      html += '<button class="as-card__expand" data-id="' + p.id + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '">' +
        '<span>' + (isExpanded ? 'Hide Spaces' : 'View ' + p.units.length + ' Available Spaces') + '</span>' +
        '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5"/></svg>' +
        '</button>';
      html += '<div class="as-card__units' + (isExpanded ? ' as-card__units--open' : '') + '">';
      p.units.forEach(function (u) { html += unitRowHTML(u, p.id, p.name); });
      html += '</div>';
    } else {
      // Single unit — show details inline
      var u = p.units[0];
      html += '<div class="as-card__single-unit">' +
        '<div class="as-unit-inline">' +
        '<div><span class="as-unit__label">Suite</span> ' + u.suite + '</div>' +
        '<div><span class="as-unit__label">Size</span> ' + u.sfLabel + '</div>' +
        '<div><span class="as-unit__label">Asking</span> ' + u.rate + ' <span class="as-unit__rate-type">' + u.rateType + '</span></div>' +
        '</div>' +
        '</div>';
    }

    html += '<div class="as-card__footer">' +
      '<a href="mailto:info@oxfordra.net?subject=Inquiry%20-%20' + encodeURIComponent(p.name) + '" class="as-card__cta" aria-label="Inquire about ' + p.name + '">Inquire</a>' +
      '<a href="tel:+13015126125" class="as-card__phone" title="Call 301.512.6125">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>' +
      '</a>' +
      '</div>';

    html += '</div></article>';
    return html;
  }

  // ── Table HTML ───────────────────────────────────────────────────────────────
  function tableHTML(list) {
    var rows = '';
    list.forEach(function (p) {
      p.units.forEach(function (u, idx) {
        var isFirst = idx === 0;
        var propName = isFirst ? p.name + (p.subtitle ? ' \u2014 ' + p.subtitle : '') : '';
        var propLoc = isFirst ? p.city + ', ' + p.state : '';
        rows += '<tr data-id="' + p.id + '"' + (!isFirst ? ' class="as-table__sub"' : '') + '>' +
          '<td class="as-table__name">' + propName + '</td>' +
          '<td>' + propLoc + '</td>' +
          '<td>Suite ' + u.suite + '</td>' +
          '<td class="as-table__sf">' + u.sfLabel + '</td>' +
          '<td>' + u.use + '</td>' +
          '<td class="as-table__rate">' + u.rate + ' ' + u.rateType + '</td>' +
          '<td><a href="mailto:info@oxfordra.net?subject=Inquiry%20-%20' + encodeURIComponent(p.name + ' Suite ' + u.suite) + '" class="as-table__action" aria-label="Inquire about ' + p.name + ' Suite ' + u.suite + '">Inquire</a></td>' +
          '</tr>';
      });
    });
    return '<div class="as-table-wrap"><table class="as-table" aria-label="Available listings">' +
      '<thead><tr>' +
      '<th>Property</th><th>Location</th><th>Unit/Suite</th><th>SF Available</th><th>Use</th><th>Asking Rent</th><th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function renderCards() {
    var panel = el('listingsPanel');
    if (!panel) return;
    if (filtered.length === 0) {
      panel.innerHTML = '<div class="as-no-results"><p>No listings match your filters. <button onclick="resetFilters()" style="background:none;border:none;color:var(--as-gold);cursor:pointer;font-size:inherit;font-family:inherit;text-decoration:underline">Clear all</button></p></div>';
      return;
    }
    if (viewMode === 'table') {
      panel.innerHTML = tableHTML(filtered);
    } else {
      panel.innerHTML = filtered.map(cardHTML).join('');
    }
    bindCardEvents(panel);
  }

  function bindCardEvents(panel) {
    // Expand/collapse multi-unit
    panel.querySelectorAll('.as-card__expand').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = parseInt(btn.dataset.id, 10);
        expandedIds[id] = !expandedIds[id];
        renderCards();
      });
    });
    // Card click opens detail
    panel.querySelectorAll('.as-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('.as-card__expand') || e.target.closest('.as-card__cta') ||
          e.target.closest('.as-card__phone') || e.target.closest('.as-unit__inquire') ||
          e.target.tagName === 'A') return;
        openDetail(parseInt(card.dataset.id, 10));
      });
    });
    // Table row click
    panel.querySelectorAll('.as-table tbody tr').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        openDetail(parseInt(row.dataset.id, 10));
      });
    });
  }

  // ── Map ───────────────────────────────────────────────────────────────────────
  function initMap() {
    if (!window.L || !el('map')) return;
    try {
      map = L.map('map', { zoomControl: true, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18
      }).addTo(map);
      // LoopNet-style diamond pin, gold for available listings
      function buildDiamondIcon(color) {
        return L.divIcon({
          html: '<div style="width:22px;height:22px;background:' + color +
                ';border:2px solid #1B2A4A;transform:rotate(45deg);box-shadow:0 2px 6px rgba(0,0,0,.4);' +
                'transition:transform .15s ease"></div>',
          className: 'ora-pin', iconSize: [22, 22], iconAnchor: [11, 11]
        });
      }
      var goldIcon = buildDiamondIcon('#C9A96E');
      LISTINGS.forEach(function (p) {
        var unitText = p.units.length === 1 ? '1 space' : p.units.length + ' spaces';
        var m = L.marker([p.lat, p.lng], { icon: goldIcon, title: p.name, riseOnHover: true })
          .bindPopup('<strong style="font-family:DM Sans,sans-serif;color:#1B2A4A">' + p.name + '</strong><br>' +
            '<span style="font-family:DM Sans,sans-serif;font-size:12px;color:#596B7D">' + p.city + ', ' + p.state + ' &bull; ' + unitText + '</span><br>' +
            '<button onclick="window._oraOpenDetail(' + p.id + ')" style="margin-top:6px;font-family:DM Sans,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.1em;border:1px solid #1B2A4A;background:none;padding:4px 12px;cursor:pointer;color:#1B2A4A">Details</button>')
          .addTo(map);
        markers.push({ id: p.id, marker: m });
      });
      var bounds = L.latLngBounds(LISTINGS.map(function (p) { return [p.lat, p.lng]; }));
      map.fitBounds(bounds.pad(0.15));
    } catch (e) { /* non-fatal */ }
  }

  function updateMapMarkers() {
    if (!map) return;
    var ids = {};
    filtered.forEach(function (p) { ids[p.id] = true; });
    markers.forEach(function (m) {
      if (ids[m.id]) { if (!map.hasLayer(m.marker)) m.marker.addTo(map); }
      else { map.removeLayer(m.marker); }
    });
    if (filtered.length > 0) {
      try {
        var bounds = L.latLngBounds(filtered.map(function (p) { return [p.lat, p.lng]; }));
        map.fitBounds(bounds.pad(0.15), { animate: true, maxZoom: 13 });
      } catch (e) { }
    }
  }

  // ── Detail overlay ────────────────────────────────────────────────────────────
  window._oraOpenDetail = function (id) { openDetail(id); };

  function openDetail(id) {
    var p = LISTINGS.find(function (x) { return x.id === id; });
    if (!p) return;
    var overlay = el('detailOverlay');
    var hero = el('detailHero');
    var body = el('detailBody');
    if (!overlay || !hero || !body) return;

    hero.style.backgroundImage = 'url(\'' + p.img + '\')';
    hero.style.backgroundSize = 'cover';
    hero.style.backgroundPosition = 'center';

    var unitsHTML = '<div class="detail-units">' +
      '<h3 style="font-family:var(--as-font-heading);font-size:20px;color:var(--as-navy);margin:0 0 12px">Available Spaces</h3>';
    p.units.forEach(function (u) {
      unitsHTML += '<div class="detail-unit-row">' +
        '<div class="detail-unit-row__main">' +
        '<span class="detail-unit-row__suite">Suite ' + u.suite + '</span>' +
        '<span class="detail-unit-row__sf">' + u.sfLabel + '</span>' +
        '<span class="detail-unit-row__use">' + u.use + '</span>' +
        '<span class="detail-unit-row__rate">' + u.rate + ' <small>' + u.rateType + '</small></span>' +
        '</div>' +
        '</div>';
    });
    unitsHTML += '</div>';

    body.innerHTML =
      '<h2 style="font-family:var(--as-font-heading);font-size:28px;color:var(--as-navy);margin:0 0 4px">' + p.name + '</h2>' +
      (p.subtitle ? '<p style="font-family:var(--as-font-body);font-size:14px;color:var(--as-slate);margin:0 0 4px">' + p.subtitle + '</p>' : '') +
      '<p style="font-family:var(--as-font-body);font-size:14px;color:var(--as-slate);margin:0 0 20px">' + p.city + ', ' + p.state + ' &bull; ' + p.market + ' Market</p>' +
      '<p style="font-family:var(--as-font-heading);font-size:18px;color:#333;line-height:1.6;margin-bottom:24px">' + p.desc + '</p>' +
      unitsHTML +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:24px">' +
      '<a href="mailto:info@oxfordra.net?subject=Inquiry%20-%20' + encodeURIComponent(p.name) + '" ' +
      'aria-label="Inquire about ' + p.name + '" ' +
      'style="display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:var(--as-navy);color:#fff;font-family:var(--as-font-body);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;text-decoration:none;border-radius:4px">Inquire About This Space</a>' +
      '<a href="tel:+13015126125" ' +
      'style="display:inline-flex;align-items:center;gap:8px;padding:14px 28px;border:1.5px solid var(--as-navy);color:var(--as-navy);font-family:var(--as-font-body);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;text-decoration:none;border-radius:4px">301.512.6125</a>' +
      '</div>';

    overlay.style.display = '';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var closeBtn = el('detailClose');
    if (closeBtn) closeBtn.focus();
  }

  function closeDetail() {
    var overlay = el('detailOverlay');
    if (overlay) { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); overlay.style.display = 'none'; }
    document.body.style.overflow = '';
  }

  // ── Share ─────────────────────────────────────────────────────────────────────
  function showToast() {
    var t = el('shareToast');
    if (!t) return;
    t.style.display = 'flex';
    setTimeout(function () { t.style.display = 'none'; }, 2400);
  }

  // ── View toggle ───────────────────────────────────────────────────────────────
  function setView(mode) {
    viewMode = mode;
    el('viewCards').classList.toggle('as-view-btn--active', mode === 'cards');
    el('viewTable').classList.toggle('as-view-btn--active', mode === 'table');
    renderCards();
  }

  // ── Reset filters ─────────────────────────────────────────────────────────────
  window.resetFilters = function () {
    el('searchInput').value = '';
    el('filterMarket').value = '';
    el('filterType').value = '';
    el('filterSize').value = '';
    el('sortBy').value = 'featured';
    applyFilters();
  };

  // ── Hash deep link ────────────────────────────────────────────────────────────
  function handleHash() {
    var hash = window.location.hash.replace('#', '');
    if (!hash) return;
    var p = LISTINGS.find(function (x) { return x.slug === hash; });
    if (p) openDetail(p.id);
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    populateFilters();
    applyFilters();

    if (window.L) initMap();
    else window.addEventListener('load', initMap);

    ['searchInput', 'filterMarket', 'filterType', 'filterSize', 'sortBy'].forEach(function (id) {
      var node = el(id);
      if (node) node.addEventListener(id === 'searchInput' ? 'input' : 'change', applyFilters);
    });

    var vCards = el('viewCards'); if (vCards) vCards.addEventListener('click', function () { setView('cards'); });
    var vTable = el('viewTable'); if (vTable) vTable.addEventListener('click', function () { setView('table'); });

    var closeBtn = el('detailClose');
    if (closeBtn) closeBtn.addEventListener('click', closeDetail);
    var overlay = el('detailOverlay');
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDetail(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

    handleHash();
    window.addEventListener('hashchange', handleHash);
  });

})();
