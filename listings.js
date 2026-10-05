/* listings.js — Oxford Realty Advisors Available Space
 * Renders listing cards with LoopNet-style expandable units, Leaflet map,
 * filters, stats bar, and detail overlay.
 * v3 — 2026-04-06 — current availabilities only
 */
(function () {
  'use strict';

  // GENERATED: do not edit LISTINGS by hand. Edit data/listings.json and run
  // `npm run build:listings` — it rewrites this block plus the static fallback
  // cards and id="listing-schema" JSON-LD in available-space.html (the markup
  // AI/search crawlers see before this script runs). `npm run verify` fails on drift.

  // ── Property Data (current availabilities only) ──────────────────────────────
  var LISTINGS = [
    {
      "id": 2,
      "name": "384-398 Morrison Rd",
      "city": "Columbus",
      "state": "OH",
      "market": "Columbus",
      "category": "Flex",
      "lat": 39.98527,
      "lng": -82.85498,
      "img": "/images/17-warehouse-columbus-external.jpg",
      "imgW": 700,
      "slug": "384-398-morrison-rd",
      "desc": "Flex/warehouse complex on Morrison Rd, Columbus, OH.",
      "loopnetId": "41318384",
      "units": [
        {
          "suite": "386",
          "sf": 1800,
          "sfLabel": "1,800 SF",
          "rate": "$9.00",
          "rateType": "NNN",
          "use": "Industrial"
        }
      ]
    },
    {
      "id": 3,
      "name": "2000-2002 Zettler Rd",
      "city": "Columbus",
      "state": "OH",
      "market": "Columbus",
      "category": "Industrial",
      "lat": 39.93064,
      "lng": -82.91113,
      "img": "/images/07-2000_2002-front.jpg",
      "imgW": 700,
      "slug": "2000-2002-zettler-rd",
      "desc": "Small-bay industrial in Columbus near the I-70/I-270 interchange.",
      "pinned": true,
      "units": [
        {
          "suite": "2000",
          "sf": 4960,
          "sfLabel": "4,960 SF",
          "rate": "$8.00",
          "rateType": "NNN",
          "use": "Industrial"
        },
        {
          "suite": "2002",
          "sf": 6200,
          "sfLabel": "6,200 SF",
          "rate": "$8.00",
          "rateType": "NNN",
          "use": "Industrial"
        }
      ]
    },
    {
      "id": 4,
      "name": "Northwood Business Center",
      "subtitle": "2203 Northwood Dr",
      "city": "Salisbury",
      "state": "MD",
      "market": "Maryland",
      "category": "Flex",
      "lat": 38.39942,
      "lng": -75.5791,
      "img": "/images/06-exterior-beauty.jpg",
      "imgW": 700,
      "slug": "2203-northwood-dr",
      "desc": "Multi-tenant industrial flex park in Salisbury, MD.",
      "loopnetId": "33776831",
      "units": [
        {
          "suite": "C5-6",
          "sf": 1200,
          "sfMax": 2400,
          "sfLabel": "1,200\u20132,400 SF",
          "rate": "$10.99",
          "rateType": "+UTIL",
          "use": "Industrial"
        },
        {
          "suite": "B15",
          "sf": 1200,
          "sfLabel": "1,200 SF",
          "rate": "$10.99",
          "rateType": "+UTIL",
          "use": "Flex"
        }
      ]
    },
    {
      "id": 5,
      "name": "2800-2826 Banwick Rd",
      "city": "Columbus",
      "state": "OH",
      "market": "Columbus",
      "category": "Flex",
      "lat": 39.92593,
      "lng": -82.92199,
      "img": "/images/01-2800-2826-banwick-exterior.jpg",
      "imgW": 800,
      "slug": "2800-2826-banwick-rd",
      "desc": "Shallow-bay flex industrial in Columbus, OH near I-270.",
      "loopnetId": "39958427",
      "units": [
        {
          "suite": "2808",
          "sf": 1500,
          "sfLabel": "1,500 SF",
          "rate": "$13.20",
          "rateType": "MG",
          "use": "Flex"
        },
        {
          "suite": "2802",
          "sf": 1500,
          "sfLabel": "1,500 SF",
          "rate": "$13.20",
          "rateType": "MG",
          "use": "Flex"
        }
      ]
    },
    {
      "id": 6,
      "name": "9620 E State Route 350",
      "city": "Raytown",
      "state": "MO",
      "market": "Kansas City",
      "category": "Retail",
      "lat": 38.99217,
      "lng": -94.46813,
      "img": "/images/05-exterior-front.jpg",
      "imgW": 485,
      "slug": "9620-state-route-350",
      "desc": "Flex industrial in the Raytown submarket of Kansas City, MO.",
      "loopnetId": "33608684",
      "units": [
        {
          "suite": "107-108",
          "sf": 2872,
          "sfMax": 5745,
          "sfLabel": "2,872\u20135,745 SF",
          "rate": "$9.99",
          "rateType": "+UTIL",
          "use": "Retail"
        }
      ]
    },
    {
      "id": 7,
      "name": "1100 Rarig Ave",
      "city": "Columbus",
      "state": "OH",
      "market": "Columbus",
      "category": "Flex",
      "lat": 39.99401,
      "lng": -82.92233,
      "img": "/images/04-1100-rarig-exterior-2-drive-ins-dock.jpg",
      "imgW": 800,
      "slug": "1100-rarig-ave",
      "desc": "Multi-tenant industrial/flex building on Rarig Ave, Columbus, OH.",
      "loopnetId": "33272230",
      "units": [
        {
          "suite": "J",
          "sf": 1800,
          "sfLabel": "1,800 SF",
          "rate": "$13.00",
          "rateType": "MG",
          "use": "Industrial"
        },
        {
          "suite": "G-H",
          "sf": 3000,
          "sfLabel": "3,000 SF",
          "rate": "$13.00",
          "rateType": "MG",
          "use": "Flex"
        }
      ]
    },
    {
      "id": 8,
      "name": "9050 Red Branch Rd",
      "city": "Columbia",
      "state": "MD",
      "market": "Maryland",
      "category": "Flex",
      "lat": 39.22908,
      "lng": -76.81735,
      "img": "/images/20-9050-red-branch-exterior.jpg",
      "imgW": 800,
      "slug": "9050-red-branch-rd",
      "desc": "Multi-tenant flex/industrial buildings with dock and drive-in units in Columbia, MD.",
      "loopnetId": "30496667",
      "units": [
        {
          "suite": "H",
          "sf": 5000,
          "sfLabel": "5,000 SF",
          "rate": "$13.95",
          "rateType": "NNN",
          "use": "Flex"
        }
      ]
    },
    {
      "id": 9,
      "name": "Easton Technology Center",
      "subtitle": "29000 Information Ln",
      "city": "Easton",
      "state": "MD",
      "market": "Maryland",
      "category": "Flex",
      "lat": 38.81341,
      "lng": -76.06947,
      "img": "/images/08-20161026_120215.jpg",
      "imgW": 800,
      "slug": "29000-information-ln",
      "desc": "Warehouse, office and lab/R&D suites with at-grade drive-in doors near the airport in Easton, MD.",
      "loopnetId": "5166229",
      "units": [
        {
          "suite": "402",
          "sf": 1500,
          "sfMax": 3000,
          "sfLabel": "1,500\u20133,000 SF",
          "rate": "$15.20",
          "rateType": "MG",
          "use": "Industrial"
        },
        {
          "suite": "202",
          "sf": 1500,
          "sfMax": 3000,
          "sfLabel": "1,500\u20133,000 SF",
          "rate": "$15.20",
          "rateType": "MG",
          "use": "Flex"
        }
      ]
    }
  ];

  // ── State ────────────────────────────────────────────────────────────────────
  var filtered = LISTINGS.slice();
  var viewMode = 'cards';
  var expandedIds = {};
  var map, markers = [];
  var detailLastFocused = null;   // element focused before the detail overlay opened
  var detailKeydownTrap = null;   // Tab focus-trap handler while overlay is open

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  // ── Focusable-element collector (for modal focus trapping) ────────────────────
  function focusableWithin(container) {
    var nodes = container.querySelectorAll('a[href], button, textarea, input, select, [tabindex]');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.disabled) continue;
      if (n.getAttribute('tabindex') === '-1') continue;
      if (n.getAttribute('aria-hidden') === 'true') continue;
      if (n.offsetWidth === 0 && n.offsetHeight === 0 && n.getClientRects().length === 0) continue;
      out.push(n);
    }
    return out;
  }

  // ── Format helpers ───────────────────────────────────────────────────────────
  function fmtSF(n) {
    return n >= 1000 ? n.toLocaleString() + ' SF' : n + ' SF';
  }
  function totalSF(p) {
    return p.units.reduce(function (s, u) { return s + (u.sfMax || u.sf); }, 0);
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
        // A property matches when ANY single unit falls in the range. The old
        // check compared the SUM of all units to the minimum and only the first
        // unit to the maximum, so three 4,000 SF suites showed under "10,000+ SF".
        var inRange = p.units.some(function (u) {
          var lo = u.sf;
          var hi = u.sfMax || u.sf;
          return hi >= min && lo <= max;
        });
        if (!inRange) return false;
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

  // ── Card image HTML ──────────────────────────────────────────────────────────
  // Mirrors the <picture> markup of the static fallback cards in available-space.html
  // (AVIF -> WebP -> JPEG). Derived paths must stay in step with the on-disk variants:
  // <base>.avif/.webp at the listing's full width (imgW) and <base>-480w.avif/.webp.
  // `sizes` is the card grid's, NOT 100vw — a card is ~30vw at desktop, and claiming
  // 100vw would pull the full-width source on every viewport.
  var CARD_IMG_SIZES = '(max-width: 767px) 100vw, (max-width: 1023px) 32vw, 30vw';

  // Descriptive alt: "<name> — <SF> SF <category> available in <city>, <state>".
  // The SF is the listing's own AVAILABLE (vacant-suite) total, never a building-wide
  // figure. Falls back to the plain photo string if any component is missing rather
  // than inventing one.
  function cardImgAlt(p) {
    if (!p.category || !p.city || !p.state) return p.name + ' property photo';
    return p.name + ' — ' + fmtSF(totalSF(p)) + ' ' + p.category +
      ' available in ' + p.city + ', ' + p.state;
  }

  function cardImgHTML(p) {
    var alt = cardImgAlt(p);
    var base = p.img.replace(/\.jpe?g$/i, '');
    // No derivable variants (non-JPEG source) -> keep the plain <img>.
    if (base === p.img || !p.imgW) {
      return '<img src="' + p.img + '" alt="' + alt + '" width="400" height="250" loading="lazy" decoding="async">';
    }
    function srcset(ext) {
      return base + '-480w.' + ext + ' 480w, ' + base + '.' + ext + ' ' + p.imgW + 'w';
    }
    return '<picture>' +
      '<source type="image/avif" srcset="' + srcset('avif') + '" sizes="' + CARD_IMG_SIZES + '">' +
      '<source type="image/webp" srcset="' + srcset('webp') + '" sizes="' + CARD_IMG_SIZES + '">' +
      '<img src="' + p.img + '" alt="' + alt + '" width="400" height="250" loading="lazy" decoding="async">' +
      '</picture>';
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
      cardImgHTML(p) +
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
      panel.innerHTML = '<div class="as-no-results"><p>No listings match your filters. <button class="as-no-results__reset" style="background:none;border:none;color:var(--as-gold);cursor:pointer;font-size:inherit;font-family:inherit;text-decoration:underline">Clear all</button></p></div>';
      var resetBtn = panel.querySelector('.as-no-results__reset');
      if (resetBtn) resetBtn.addEventListener('click', resetFilters);
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
      map = L.map('map', { zoomControl: true, scrollWheelZoom: false, maxZoom: 19 });
      var tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
      }).addTo(map);
      // Wheel-zoom is armed by a click/focus on the map and released when the
      // pointer leaves, so scrolling the page past the map never gets captured.
      map.on('click focus', function () { map.scrollWheelZoom.enable(); });
      map.on('mouseout blur', function () { map.scrollWheelZoom.disable(); });
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
      function popupEntry(p) {
        var unitText = p.units.length === 1 ? '1 space' : p.units.length + ' spaces';
        return '<strong style="font-family:DM Sans,sans-serif;color:#1B2A4A">' + p.name + '</strong><br>' +
          '<span style="font-family:DM Sans,sans-serif;font-size:12px;color:#596B7D">' + p.city + ', ' + p.state + ' &bull; ' + unitText + '</span><br>' +
          '<button class="as-map-popup__details" data-id="' + p.id + '" style="margin-top:6px;font-family:DM Sans,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.1em;border:1px solid #1B2A4A;background:none;padding:4px 12px;cursor:pointer;color:#1B2A4A">Details</button>';
      }
      // Pins that overlap on screen at the current zoom share one popup, so a pin
      // hidden underneath another is still reachable without zooming in first.
      function popupFor(layer) {
        var here = map.latLngToLayerPoint(layer.getLatLng());
        var entries = [];
        markers.forEach(function (m) {
          if (m.marker !== layer && !map.hasLayer(m.marker)) return;
          if (m.marker === layer || map.latLngToLayerPoint(m.marker.getLatLng()).distanceTo(here) < 24) {
            entries.push(popupEntry(LISTINGS.find(function (x) { return x.id === m.id; })));
          }
        });
        return entries.join('<hr style="border:0;border-top:1px solid #E5E0D6;margin:10px 0">');
      }
      LISTINGS.forEach(function (p) {
        var m = L.marker([p.lat, p.lng], { icon: goldIcon, title: p.name, riseOnHover: true })
          .bindPopup(popupFor)
          .addTo(map);
        markers.push({ id: p.id, marker: m });
      });
      // If the public OSM tile server is down, say so instead of showing a blank
      // grey map; the pins and every listing card still work without tiles.
      var tileErrors = 0, tilesLoaded = 0;
      tileLayer.on('tileload', function () {
        tilesLoaded++;
        var note = el('mapTileNote'); if (note) note.hidden = true;
      });
      tileLayer.on('tileerror', function () {
        tileErrors++;
        var note = el('mapTileNote');
        if (note && tileErrors >= 4 && tilesLoaded === 0) note.hidden = false;
      });
      var bounds = L.latLngBounds(LISTINGS.map(function (p) { return [p.lat, p.lng]; }));
      map.fitBounds(bounds.pad(0.15));
      // Popup content is rendered by Leaflet on open, so bind via delegation
      // on the map container rather than per-popup inline handlers.
      el('map').addEventListener('click', function (e) {
        var btn = e.target.closest('.as-map-popup__details');
        if (btn) openDetail(parseInt(btn.dataset.id, 10));
      });
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
        map.fitBounds(bounds.pad(0.15), { animate: true, maxZoom: 16 });
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

    // Only capture the trigger element the first time the overlay opens
    // (guards against a re-entrant open, e.g. hashchange while already open).
    if (!overlay.classList.contains('open')) detailLastFocused = document.activeElement;
    overlay.style.display = '';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var closeBtn = el('detailClose');
    if (closeBtn) closeBtn.focus();

    // Trap Tab / Shift+Tab within the overlay while it is open.
    if (detailKeydownTrap) document.removeEventListener('keydown', detailKeydownTrap);
    detailKeydownTrap = function (e) {
      if (e.key !== 'Tab') return;
      var list = focusableWithin(overlay);
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !overlay.contains(document.activeElement)) {
          e.preventDefault(); last.focus();
        }
      } else {
        if (document.activeElement === last || !overlay.contains(document.activeElement)) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', detailKeydownTrap);
  }

  function closeDetail() {
    var overlay = el('detailOverlay');
    if (overlay) { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); overlay.style.display = 'none'; }
    document.body.style.overflow = '';
    if (detailKeydownTrap) { document.removeEventListener('keydown', detailKeydownTrap); detailKeydownTrap = null; }
    // Return focus to whatever triggered the overlay (card, table row, map pin).
    if (detailLastFocused && typeof detailLastFocused.focus === 'function') {
      try { detailLastFocused.focus(); } catch (e) {}
    }
    detailLastFocused = null;
  }

  // ── View toggle ───────────────────────────────────────────────────────────────
  function setView(mode) {
    viewMode = mode;
    el('viewCards').classList.toggle('as-view-btn--active', mode === 'cards');
    el('viewTable').classList.toggle('as-view-btn--active', mode === 'table');
    renderCards();
    // The map panel is hidden in table view below 1280px (see
    // available-space.css); Leaflet only measures its container on init and
    // on window resize, so re-measure once the panel is visible again.
    if (map) setTimeout(function () { map.invalidateSize(); }, 60);
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
