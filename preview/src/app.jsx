// Oxford Realty Advisors — interactive preview
// Single-file React app focused on enhancements over the live site.

const { useState, useEffect, useRef, useCallback } = React;

// ===================== HOOKS =====================
function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { el.classList.add('in'); io.unobserve(el); } });
    }, { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

function CountUp({ end, suffix = '', duration = 1800, prefix = '' }) {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf, started = false;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !started) {
        started = true;
        const start = performance.now();
        const tick = (t) => {
          const p = Math.min(1, (t - start) / duration);
          const eased = 1 - Math.pow(1 - p, 3);
          setVal(Math.round(end * eased));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }
    }, { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [end, duration]);
  const formatted = val.toLocaleString();
  return <span ref={ref}>{prefix}{formatted}{suffix}</span>;
}

// ===================== ANNOTATION =====================
function Anno({ tag, title, children, body, popoverOffset = 0 }) {
  return (
    <div className="anno" style={{ position: 'relative' }}>
      <span className="anno-tag">{tag}</span>
      {children}
      <div className="anno-popover" style={{ left: popoverOffset }}>
        <b>{tag} · {title}</b>
        {body}
      </div>
    </div>
  );
}

function AnnoToggle({ on, setOn }) {
  return (
    <button className="anno-toggle" onClick={() => setOn(v => !v)}>
      <span className="pulse" />
      {on ? 'Hide what changed' : 'Show what changed'}
    </button>
  );
}

// ===================== NAV =====================
function Nav({ page, setPage }) {
  const links = [
    ['firm', 'The Firm'], ['portfolio', 'Portfolio'], ['track', 'Track Record'],
    ['brokers', 'For Brokers'], ['tenants', 'For Tenants'], ['contact', 'Contact'],
  ];
  return (
    <header className="nav">
      <a className="brand" onClick={() => setPage('home')}>
        <span className="mark">O</span>
        <span>Oxford Realty Advisors</span>
      </a>
      <nav>
        {links.map(([k, l]) => (
          <a key={k} className={page === k ? 'active' : ''} onClick={() => setPage(k)}>{l}</a>
        ))}
      </nav>
      <a className="cta" onClick={() => setPage('brokers')}>Submit a Deal</a>
    </header>
  );
}

// ===================== HERO =====================
function Hero({ setPage }) {
  return (
    <section className="hero">
      <div className="hero-bg" />
      <div className="hero-inner">
        <Anno tag="01" title="Cinematic hero" body={
          <>Your live hero is strong but static. Here we add a Ken Burns drift on the property image, a parallax overlay grid, and an animated &quot;Live · Q1 acquisition target&quot; status pill — signaling the firm is active <em>right now</em>.</>
        }>
          <div>
            <div className="status">
              <span className="live" />
              Live · Q1 2026 · Targeting $15M+ in acquisitions
            </div>
            <h1>
              Private capital for <em>industrial</em> real estate.
            </h1>
            <p className="lede">
              Oxford Realty Advisors deploys 100% family capital into value-add shallow-bay industrial
              and flex across the Mid-Atlantic and Midwest. All-cash. 30–45 day close. No committee.
            </p>
            <div className="actions">
              <button className="btn gold" onClick={() => setPage('brokers')}>Submit a Deal →</button>
              <button className="btn" onClick={() => setPage('track')}>View Track Record</button>
            </div>
          </div>
        </Anno>
        <Anno tag="02" title="Live status card" body={
          <>A real-time card showing what Oxford is buying right now, with a scanning gold sweep. Replaces the static hero photo space — gives brokers an immediate &quot;they&apos;re active, I should pitch them&quot; signal.</>
        }>
          <div className="hero-card">
            <div className="label">▸ Acquisition Pipeline · Live</div>
            <h3>What we're buying — Q1 2026</h3>
            <p>Shallow-bay industrial, $1M–$10M, 30–45 day cash close. Comfortable with vacancy, deferred maintenance, environmental complexity.</p>
            <div className="row"><span>Active markets</span><b>Columbus · KC · Indy · Mid-Atl</b></div>
            <div className="row"><span>Deal size</span><b>$1M – $10M</b></div>
            <div className="row"><span>Building size</span><b>{'< 50,000 SF'}</b></div>
            <div className="row"><span>Close timeline</span><b>30–45 days</b></div>
            <div className="row"><span>Financing contingency</span><b style={{ color: 'var(--gold)' }}>None</b></div>
          </div>
        </Anno>
      </div>
    </section>
  );
}

// ===================== METRICS COUNTER =====================
function MetricsBlock() {
  const ref = useReveal();
  return (
    <Anno tag="03" title="Animated counters" body={
      <>Your numbers (600K SF, 140 tenants, 27 properties, 4 markets, 21 years) <em>count up</em> when scrolled into view. A small touch that makes the page feel alive and emphasizes the scale.</>
    }>
      <div className="metrics reveal" ref={ref}>
        <div className="metric"><div className="v"><CountUp end={600000} />+</div><div className="l">Square Feet</div></div>
        <div className="metric"><div className="v"><CountUp end={140} />+</div><div className="l">Tenants</div></div>
        <div className="metric"><div className="v"><CountUp end={27} />+</div><div className="l">Properties</div></div>
        <div className="metric"><div className="v"><CountUp end={4} /></div><div className="l">Core Markets</div></div>
        <div className="metric"><div className="v"><CountUp end={21} />+</div><div className="l">Years Operating</div></div>
      </div>
    </Anno>
  );
}

// ===================== BASIS SLIDER =====================
function BasisSlider() {
  const [price, setPrice] = useState(72);
  const ref = useRef(null);
  const drag = useRef(false);
  const MIN = 0, MAX = 200, OXF_HI = 85, NEW_LO = 130, NEW_HI = 180;
  const margin = Math.max(0, Math.round(((NEW_LO - price) / NEW_LO) * 100));
  const pct = ((price - MIN) / (MAX - MIN)) * 100;

  const onMove = (e) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setPrice(Math.round(p * (MAX - MIN) + MIN));
  };
  return (
    <Anno tag="04" title="Basis vs. replacement-cost slider" body={
      <>Your &quot;buy below replacement&quot; thesis is currently a static line of copy. Here it&apos;s a draggable slider — brokers/tenants can position any deal and see the margin of safety light up. Makes the number visceral.</>
    }>
      <div className="basis">
        <div className="section-eyebrow" style={{ color: 'var(--ink-faint)' }}>The Edge</div>
        <h3>Drag the handle. <em style={{ fontStyle: 'italic', color: 'var(--gold)' }}>See the margin.</em></h3>
        <p className="cap">Oxford acquires at $42–$85/SF. New construction runs $130–$180/SF. Position any deal below to see the margin of safety.</p>
        <div className="basis-track" ref={ref}
          onPointerDown={(e) => { drag.current = true; e.target.setPointerCapture?.(e.pointerId); onMove(e); }}
          onPointerMove={(e) => { if (drag.current) onMove(e); }}
          onPointerUp={() => drag.current = false}
        >
          <div className="basis-zone-oxf" style={{ width: `${(OXF_HI / MAX) * 100}%` }} />
          <div className="basis-zone-new" style={{ left: `${(NEW_LO / MAX) * 100}%`, right: `${100 - (NEW_HI / MAX) * 100}%` }} />
          <div className="basis-handle" style={{ left: `${pct}%` }}>
            <div className="basis-readout">${price}/SF · {margin}% below replacement</div>
          </div>
        </div>
        <div className="basis-axis">
          <span>$0</span>
          <span style={{ color: 'var(--gold)' }}>OXFORD $42–$85</span>
          <span style={{ color: 'var(--ink)' }}>NEW BUILD $130–$180</span>
          <span>$200</span>
        </div>
        <div className="basis-grid">
          <div className="col oxf"><div className="v">$42–$85</div><div className="l">Oxford basis / SF</div></div>
          <div className="col"><div className="v">${price}</div><div className="l">Your deal / SF</div></div>
          <div className="col"><div className="v">$130–$180</div><div className="l">New construction / SF</div></div>
        </div>
      </div>
    </Anno>
  );
}

// ===================== BEFORE/AFTER =====================
function BeforeAfter() {
  const [pos, setPos] = useState(50);
  const ref = useRef(null);
  const drag = useRef(false);
  const onMove = (e) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };
  return (
    <Anno tag="05" title="Before / after comparator" body={
      <>You already have before/after photos for 3540 E. Fifth Avenue on the Track Record page. Here we make them <em>scrubbable</em> — drag the divider to see the transformation. Drop in real photos and this becomes the most-shared element on the site.</>
    }>
      <div className="ba" ref={ref}
        onPointerDown={(e) => { drag.current = true; e.target.setPointerCapture?.(e.pointerId); onMove(e); }}
        onPointerMove={(e) => { if (drag.current) onMove(e); }}
        onPointerUp={() => drag.current = false}
      >
        <div className="img after"><b>[ AFTER · 3540 E. FIFTH AVE — RENOVATED ]</b></div>
        <div className="clip" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <div className="img before"><b>[ BEFORE · ACQUIRED 2018 ]</b></div>
        </div>
        <div className="lab l">Before</div>
        <div className="lab r">After</div>
        <div className="divider" style={{ left: `${pos}%` }} />
      </div>
    </Anno>
  );
}

// ===================== SCORECARD =====================
function Scorecard() {
  const [params, setParams] = useState({ basis: 70, location: 75, condition: 60, tenancy: 65 });
  const score = Math.round((params.basis * 0.3 + params.location * 0.25 + params.condition * 0.2 + params.tenancy * 0.25));
  const grade = score >= 85 ? 'A · Pursue' : score >= 70 ? 'B · Likely LOI' : score >= 55 ? 'C · Conditional' : 'D · Pass';
  const gradeColor = score >= 70 ? 'var(--gold)' : score >= 55 ? '#d4b56a' : '#a28872';

  const circumference = 2 * Math.PI * 78;
  const offset = circumference - (score / 100) * circumference;

  return (
    <Anno tag="06" title="Live 100-parameter scorecard demo" body={
      <>Your live site mentions a &quot;100-parameter acquisition scorecard&quot; in copy — but it&apos;s invisible. Here&apos;s a tangible interactive demo: brokers slide four signals, see a live grade circle fill in. Demystifies your underwriting and signals technical sophistication.</>
    }>
      <div className="scorecard">
        <div>
          <div className="section-eyebrow">Acquisition Scorecard</div>
          <h3>Try our underwriting — live.</h3>
          <p className="cap">A simplified four-parameter version of the proprietary 100-parameter scorecard we run on every submission. Slide to see the grade move.</p>
          {[
            ['basis', 'Basis vs. replacement', '30%'],
            ['location', 'Market quality', '25%'],
            ['condition', 'Building condition', '20%'],
            ['tenancy', 'Tenancy / cash flow', '25%'],
          ].map(([k, l, w]) => (
            <div className="row" key={k}>
              <div className="top"><span>{l} · {w}</span><b>{params[k]}/100</b></div>
              <input type="range" min="0" max="100" value={params[k]} onChange={(e) => setParams({ ...params, [k]: +e.target.value })} />
            </div>
          ))}
        </div>
        <div className="gauge">
          <svg viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="78" fill="none" stroke="rgba(245,240,230,0.08)" strokeWidth="14" />
            <circle cx="100" cy="100" r="78" fill="none" stroke={gradeColor} strokeWidth="14"
              strokeDasharray={circumference} strokeDashoffset={offset}
              transform="rotate(-90 100 100)" style={{ transition: 'stroke-dashoffset 400ms var(--ease)' }} strokeLinecap="round" />
          </svg>
          <div className="num" style={{ color: gradeColor }}>{score}</div>
          <div className="grade">{grade}</div>
        </div>
      </div>
    </Anno>
  );
}

// ===================== MAP =====================
function MarketMap({ setPage }) {
  const pins = [
    { name: 'Maryland (HQ)', x: 78, y: 44, n: '12 properties · 220K SF' },
    { name: 'Columbus, OH', x: 67, y: 41, n: '14 properties · 285K SF' },
    { name: 'Kansas City', x: 51, y: 50, n: '1 property · 45K SF · Active' },
    { name: 'Indianapolis', x: 64, y: 44, n: 'Pipeline · evaluating', soon: true },
  ];
  const [active, setActive] = useState(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = c.getBoundingClientRect();
      c.width = r.width * dpr; c.height = r.height * dpr;
      ctx.scale(dpr, dpr);
    }
    resize();
    function draw() {
      const r = c.getBoundingClientRect();
      ctx.clearRect(0, 0, r.width, r.height);
      // Soft US ellipse glow
      const g = ctx.createRadialGradient(r.width * 0.55, r.height * 0.5, 30, r.width * 0.55, r.height * 0.5, r.width * 0.45);
      g.addColorStop(0, 'rgba(201,163,90,0.12)');
      g.addColorStop(1, 'rgba(201,163,90,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, r.width, r.height);
      // Dot grid
      ctx.fillStyle = 'rgba(201,163,90,0.18)';
      const sp = 22;
      for (let x = sp; x < r.width; x += sp) {
        for (let y = sp; y < r.height; y += sp) {
          const cx = r.width * 0.55, cy = r.height * 0.5;
          const d = Math.hypot((x - cx) / 1.2, (y - cy) / 1.6);
          if (d < r.width * 0.36) {
            ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }
    draw();
    window.addEventListener('resize', () => { resize(); draw(); });
  }, []);

  return (
    <Anno tag="07" title="Interactive market map" body={
      <>Replace your portfolio &quot;cards by market&quot; layout with a single canvas-based US map showing all four markets as pulsing pins. Hover/tap any pin for live property count and SF — single glance, full geography.</>
    }>
      <div className="map-wrap">
        <canvas ref={canvasRef} />
        {pins.map((p, i) => (
          <div key={i}
            className={`map-pin ${p.soon ? 'soon' : ''} ${active === i ? 'active' : ''}`}
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onClick={() => setPage('portfolio')}
          >
            <div className="tip"><b>{p.name}</b><br />{p.n}</div>
          </div>
        ))}
        <div className="map-legend">
          <span><span className="dot" />Active · 27 properties</span>
          <span><span className="dot soon" />Pipeline</span>
        </div>
      </div>
    </Anno>
  );
}

// ===================== CLOSE TIMELINE =====================
function CloseTimeline() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep(s => (s + 1) % 5), 2400);
    return () => clearInterval(id);
  }, []);
  const steps = [
    ['Day 1', '01', 'Submit', 'OM, rent roll, or one-pager. Same-day acknowledgement.'],
    ['Hour 48', '02', 'Score', 'Run through 100-parameter scorecard. Indication of interest.'],
    ['Hour 72', '03', 'LOI', 'Executable, at-market, no financing contingency.'],
    ['Day 30–45', '04', 'Close', 'All-cash. Commission paid at closing.'],
  ];
  return (
    <Anno tag="08" title="Animated close-timeline" body={
      <>Your &quot;how we close&quot; copy is a list. Here, an auto-cycling progress bar walks brokers through Submit → Score → LOI → Close, each stage glowing in turn. Reinforces speed visually.</>
    }>
      <div className="close-tl">
        {steps.map(([d, n, h, p], i) => (
          <div key={i} className={`step ${step >= i ? 'on' : ''}`}>
            <div className="day">{d}</div>
            <div className="num">{n}</div>
            <h4>{h}</h4>
            <p>{p}</p>
          </div>
        ))}
        <div className="close-tl-bar" style={{ width: `${((step + 1) / 4) * 100}%` }} />
      </div>
    </Anno>
  );
}

// ===================== CASE GRID =====================
function CaseGrid({ setPage }) {
  const ref = useReveal();
  const cases = [
    ['Featured', '3540 E. Fifth Avenue', 'Columbus, OH · 36,000 SF', [['~12%', 'Cap Rate'], ['~2×', 'Value Created'], ['$1.3M', 'Acquisition']]],
    ['Current', 'Sepich Portfolio', 'Columbus, OH · 110,000 SF · 8 Bldg', [['$42', 'Basis / SF'], ['2.0×', 'NOI Growth'], ['38d', 'LOI → Close']]],
    ['Current', '29000 Information Lane', 'Eastern Shore, MD · 48,000 SF', [['6.3×', 'NOI Growth'], ['33→100%', 'Occupancy'], ['~3.5×', 'Equity Mult.']]],
  ];
  return (
    <div ref={ref} className="cases-grid reveal-stagger">
      {cases.map(([badge, name, loc, stats], i) => (
        <div className="case-card" key={i} onClick={() => setPage('track')}>
          <div className="photo"><div className="badge">{badge}</div></div>
          <div className="body">
            <h4>{name}</h4>
            <div className="loc">{loc}</div>
            <div className="stats">
              {stats.map(([v, l], j) => <div key={j}><b>{v}</b><span>{l}</span></div>)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ===================== HOME =====================
function Home({ setPage }) {
  return (
    <>
      <Hero setPage={setPage} />

      <section className="light">
        <div className="container">
          <div className="section-eyebrow">Scale</div>
          <h2 className="section-h2">A private investment firm, built for <em>generations.</em></h2>
          <MetricsBlock />
        </div>
      </section>

      <div className="marquee">
        <div className="track">
          {[1, 2].map(rep => (
            <React.Fragment key={rep}>
              <span>$1M–$10M</span><span className="sep">/</span>
              <em>Cash close</em><span className="sep">/</span>
              <span>30–45 days</span><span className="sep">/</span>
              <em>15% LTV</em><span className="sep">/</span>
              <span>100% family capital</span><span className="sep">/</span>
              <em>Zero failed closings</em><span className="sep">/</span>
            </React.Fragment>
          ))}
        </div>
      </div>

      <section className="light">
        <div className="container">
          <div className="section-eyebrow">The Edge</div>
          <h2 className="section-h2">Acquisition basis <em>40–65%</em> below replacement cost.</h2>
          <BasisSlider />
        </div>
      </section>

      <section className="dark">
        <div className="container">
          <div className="section-eyebrow">Geography</div>
          <h2 className="section-h2">Four core markets. <em>One thesis.</em></h2>
          <MarketMap setPage={setPage} />
        </div>
      </section>

      <section className="light">
        <div className="container">
          <div className="section-eyebrow">Featured Case Study</div>
          <h2 className="section-h2">3540 E. Fifth Avenue — <em>before</em> & <em>after.</em></h2>
          <p style={{ fontSize: 16, color: 'var(--ink-faint)', maxWidth: 720, marginTop: 16 }}>
            Functionally obsolete truck repair facility · acquired $1.3M · ~$1.0M renovation · 10-year lease to a global fragrance manufacturer at ~12% cap rate.
          </p>
          <div style={{ marginTop: 56 }}>
            <BeforeAfter />
          </div>
        </div>
      </section>

      <section className="dark">
        <div className="container">
          <div className="section-eyebrow">Track Record</div>
          <h2 className="section-h2">Twenty years. <em>Zero</em> failed closings.</h2>
          <CaseGrid setPage={setPage} />
        </div>
      </section>

      <section className="light">
        <div className="container">
          <div className="section-eyebrow">For Brokers</div>
          <h2 className="section-h2">Submit a deal. Get a <em>graded score.</em></h2>
          <Scorecard />
        </div>
      </section>

      <section className="dark">
        <div className="container">
          <div className="section-eyebrow">How We Close</div>
          <h2 className="section-h2">Submit. Score. LOI. <em>Close.</em></h2>
          <CloseTimeline />
        </div>
      </section>

      <section className="dark" style={{ paddingTop: 40 }}>
        <div className="container" style={{ textAlign: 'center', padding: '60px 0' }}>
          <blockquote className="quote">
            I've worked with Oxford for about 13 years and we've completed half a dozen transactions together. They consistently perform as capable buyers.
          </blockquote>
          <div className="quote-cite"><b>Nathan Pealer</b> — Managing Director Investments, Marcus & Millichap</div>
        </div>
      </section>
    </>
  );
}

// ===================== SIMPLE PAGE STUBS =====================
function StubPage({ title, eyebrow, lede, children }) {
  return (
    <section className="light" style={{ paddingTop: 80 }}>
      <div className="container">
        <div className="section-eyebrow">{eyebrow}</div>
        <h2 className="section-h2">{title}</h2>
        {lede && <p style={{ fontSize: 18, lineHeight: 1.55, color: 'var(--ink-faint)', maxWidth: 720, marginTop: 24 }}>{lede}</p>}
        {children}
      </div>
    </section>
  );
}

function FirmPage() {
  return <StubPage eyebrow="The Firm" title={<>Private capital. <em>Permanent</em> holdings.</>}
    lede="Founded 2005 in Potomac, MD. Family-owned. 100% proprietary capital. Permanent holdings.">
    <p style={{ marginTop: 40, color: 'var(--ink)', maxWidth: 720, fontSize: 16, lineHeight: 1.7 }}>
      This page mirrors the live <i>The Firm</i> section — leadership bios for Eric and Gabriel Goldberg,
      criteria, and extended team. The interactive enhancements are concentrated on the homepage; this page
      keeps the live site's editorial restraint with reveal-on-scroll animations layered in.
    </p>
  </StubPage>;
}

function PortfolioPage() {
  return <StubPage eyebrow="Portfolio" title={<>27+ properties. <em>Four</em> markets.</>}
    lede="Filtered, photo-driven grid identical in IA to the live site, with the new map at top and animated load-in.">
    <div style={{ marginTop: 56 }}><MarketMap setPage={() => { }} /></div>
  </StubPage>;
}

function TrackPage() {
  return <StubPage eyebrow="Track Record" title={<>Performance. <em>Proven.</em></>}
    lede="Featured case (3540 E. Fifth Avenue) with the new before/after scrubber, then the live case grid.">
    <div style={{ marginTop: 56 }}><BeforeAfter /></div>
    <CaseGrid setPage={() => { }} />
  </StubPage>;
}

function BrokersPage() {
  return <StubPage eyebrow="For Brokers" title={<>One call. One <em>decision-maker.</em></>}
    lede="Investment Participation, Buyside Compensation, Commission Protection — same content as live, with the live scorecard demo and animated close timeline.">
    <Scorecard />
    <div style={{ marginTop: 56 }}><CloseTimeline /></div>
  </StubPage>;
}

function TenantsPage() {
  return <StubPage eyebrow="For Tenants" title={<>A landlord who <em>answers.</em></>}
    lede="Tenant Resources + Available Space + Maintenance Request — consolidated on a single page (currently three).">
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginTop: 56 }}>
      {[
        ['Available Space', 'Browse open spaces by market with live square-footage totals.'],
        ['Tenant Application', 'Online application with auto-save and document upload.'],
        ['Maintenance Request', 'Submit, track status, photo upload — local PM responds < 1 day.'],
      ].map(([t, d], i) => (
        <div key={i} style={{ padding: 28, background: 'var(--paper-2)', border: '1px solid var(--rule-light)' }}>
          <div className="section-eyebrow" style={{ color: 'var(--ink-faint)' }}>{String(i + 1).padStart(2, '0')}</div>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 26, margin: '12px 0 10px', fontWeight: 500, letterSpacing: '-0.015em' }}>{t}</h3>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-faint)', lineHeight: 1.55 }}>{d}</p>
        </div>
      ))}
    </div>
  </StubPage>;
}

function ContactPage() {
  return <StubPage eyebrow="Contact" title={<>Get in <em>touch.</em></>} lede="9510 Persimmon Tree Road, Suite 200 · Potomac, MD 20854 · 301.512.6125 · info@oxfordra.net">
  </StubPage>;
}

// ===================== FOOTER =====================
function Footer({ setPage }) {
  return (
    <footer className="footer">
      <div className="footer-grid">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ width: 30, height: 30, background: 'var(--gold)', color: 'var(--bg)', display: 'grid', placeItems: 'center', fontFamily: 'var(--serif)', fontWeight: 600 }}>O</span>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500, color: 'var(--paper)' }}>Oxford Realty Advisors</span>
          </div>
          <p style={{ margin: 0, color: 'var(--ink-dim)', fontSize: 14, lineHeight: 1.55, maxWidth: 380 }}>
            A family-owned real estate investment firm targeting value-add industrial properties across the
            Mid-Atlantic and Midwest. 100% proprietary capital. Permanent holdings.
          </p>
        </div>
        <div>
          <h5>Navigate</h5>
          <ul>
            <li><a onClick={() => setPage('firm')}>The Firm</a></li>
            <li><a onClick={() => setPage('portfolio')}>Portfolio</a></li>
            <li><a onClick={() => setPage('track')}>Track Record</a></li>
            <li><a onClick={() => setPage('brokers')}>Broker Network</a></li>
          </ul>
        </div>
        <div>
          <h5>For Tenants</h5>
          <ul>
            <li><a onClick={() => setPage('tenants')}>Tenant Resources</a></li>
            <li><a onClick={() => setPage('tenants')}>Find Available Space</a></li>
            <li><a>Maintenance Request</a></li>
          </ul>
        </div>
        <div>
          <h5>Connect</h5>
          <ul>
            <li><a>301.512.6125</a></li>
            <li><a>info@oxfordra.net</a></li>
            <li style={{ color: 'var(--ink-faint)', marginTop: 8, fontSize: 13 }}>9510 Persimmon Tree Rd, Ste 200<br />Potomac, MD 20854</li>
          </ul>
        </div>
      </div>
      <div className="fine">
        <span>© 2026 Oxford Realty Advisors, LLC</span>
        <span>Preview build · not affecting oxfordra.net</span>
      </div>
    </footer>
  );
}

// ===================== APP =====================
function App() {
  const [page, setPage] = useState('home');
  const [annoOn, setAnnoOn] = useState(true);
  useEffect(() => {
    document.body.classList.toggle('anno-on', annoOn);
  }, [annoOn]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [page]);

  return (
    <div data-screen-label={`oxford-${page}`}>
      <AnnoToggle on={annoOn} setOn={setAnnoOn} />
      <Nav page={page} setPage={setPage} />
      <main key={page}>
        {page === 'home' && <Home setPage={setPage} />}
        {page === 'firm' && <FirmPage />}
        {page === 'portfolio' && <PortfolioPage />}
        {page === 'track' && <TrackPage />}
        {page === 'brokers' && <BrokersPage />}
        {page === 'tenants' && <TenantsPage />}
        {page === 'contact' && <ContactPage />}
      </main>
      <Footer setPage={setPage} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
