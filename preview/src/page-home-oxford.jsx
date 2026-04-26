// Oxford direction — "best of" combined home page.
// Editorial serif foundation (Atlas) + live monitor panel (Terminal)
// + draggable property tiles (Field), single oxblood accent.

const { useState: useState_ox, useRef: useRef_ox, useEffect: useEffect_ox } = React;

/* -----------------------------------------------------------
   Live monitor — ticks the ticker rows through with a typewriter
   reveal. Looks engineered, not animated-for-animation's-sake.
   ----------------------------------------------------------- */
function OxfordMonitor() {
  const D = window.OXFORD_DATA;
  const [tick, setTick] = useState_ox(0);
  const [flash, setFlash] = useState_ox(-1);

  useEffect_ox(() => {
    const id = setInterval(() => {
      const next = Math.floor(Math.random() * D.ticker.length);
      setFlash(next);
      setTick(t => t + 1);
      setTimeout(() => setFlash(-1), 600);
    }, 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="oxf-monitor">
      <div className="oxf-monitor-head">
        <span className="title">
          <span style={{color:'var(--accent)'}}>●</span>
          Portfolio · Live
        </span>
        <span className="live">Connected</span>
      </div>
      <div className="oxf-monitor-body">
        {D.ticker.slice(0, 7).map((row, i) => (
          <div
            key={i}
            className="oxf-line"
            style={{
              background: flash === i ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
              transition: 'background 400ms',
            }}
          >
            <span>
              <span className="key">{row[0]}</span>
              <div className="sub" style={{marginTop:3}}>{row[1]}</div>
            </span>
            <span className="val">{row[2]}</span>
            <span className={`delta ${row[4] === 'flat' ? 'flat' : ''}`}>
              {row[3] || '—'}
            </span>
          </div>
        ))}
      </div>
      <div className="oxf-monitor-foot">
        <span>Dry powder · <b>Available</b></span>
        <span>Next close · <b>30 days</b></span>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------
   Available-space field — draggable property tiles.
   Kept from Field direction but restyled to the Oxford palette
   (no bright fills, no hard shadows).
   ----------------------------------------------------------- */
function OxfordPropertyField() {
  const D = window.OXFORD_DATA;
  const stageRef = useRef_ox(null);
  const [sort, setSort] = useState_ox('grid');
  const tiles = useRef_ox(D.availability.map((a, i) => ({
    ...a,
    x: 0, y: 0, rot: 0,
    vx: 0, vy: 0,
    targetX: undefined, targetY: undefined, targetRot: 0,
    el: null, drag: false,
  }))).current;

  // Initial layout + physics loop
  useEffect_ox(() => {
    let raf;
    let initialized = false;
    const tick = () => {
      const stage = stageRef.current?.getBoundingClientRect();
      if (!stage || stage.width < 10) { raf = requestAnimationFrame(tick); return; }
      if (!initialized) {
        // Initial grid layout
        const cols = Math.min(tiles.length, 6);
        const cw = (stage.width - 60) / cols;
        tiles.forEach((t, i) => {
          t.x = 30 + (i % cols) * cw + cw/2 - 84;
          t.y = 80 + Math.floor(i / cols) * 130;
          t.targetX = t.x; t.targetY = t.y;
        });
        initialized = true;
      }
      tiles.forEach(t => {
        if (!t.drag) {
          if (t.targetX !== undefined) {
            const dx = t.targetX - t.x, dy = t.targetY - t.y;
            if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
              t.x += dx * 0.14; t.y += dy * 0.14;
              t.rot += ((t.targetRot ?? 0) - t.rot) * 0.14;
            }
          } else {
            t.x += t.vx; t.y += t.vy;
            t.vx *= 0.9; t.vy *= 0.9;
          }
          if (t.x < 8) { t.x = 8; t.vx *= -0.5; }
          if (t.y < 8) { t.y = 8; t.vy *= -0.5; }
          if (t.x > stage.width - 180) { t.x = stage.width - 180; t.vx *= -0.5; }
          if (t.y > stage.height - 120) { t.y = stage.height - 120; t.vy *= -0.5; }
        }
        if (t.el) t.el.style.transform = `translate(${t.x}px, ${t.y}px) rotate(${t.rot}deg)`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function applySort(mode) {
    setSort(mode);
    const stage = stageRef.current.getBoundingClientRect();
    if (mode === 'grid') {
      const cols = Math.min(tiles.length, 6);
      const cw = (stage.width - 60) / cols;
      tiles.forEach((t, i) => {
        t.drag = false; t.vx = 0; t.vy = 0;
        t.targetX = 30 + (i % cols) * cw + cw/2 - 84;
        t.targetY = 80 + Math.floor(i / cols) * 130;
        t.targetRot = 0;
      });
    } else if (mode === 'market') {
      const groups = {};
      tiles.forEach(tt => { groups[tt.loc] = groups[tt.loc] || []; groups[tt.loc].push(tt); });
      const keys = Object.keys(groups);
      tiles.forEach(t => {
        t.drag = false; t.vx = 0; t.vy = 0;
        const gi = keys.indexOf(t.loc);
        const pi = groups[t.loc].indexOf(t);
        const gw = stage.width / keys.length;
        t.targetX = gi * gw + gw/2 - 84;
        t.targetY = 80 + pi * 130;
        t.targetRot = 0;
      });
    } else if (mode === 'scatter') {
      tiles.forEach(t => {
        t.drag = false; t.vx = 0; t.vy = 0;
        t.targetX = 30 + Math.random() * (stage.width - 210);
        t.targetY = 70 + Math.random() * (stage.height - 200);
        t.targetRot = (Math.random() - 0.5) * 6;
      });
    }
  }

  return (
    <div className="oxf-field-stage" ref={stageRef}>
      <div className="grid-bg"/>
      <div className="hint">↔ drag to reposition · fling tiles · sort below</div>
      {tiles.map((t, i) => (
        <div
          className="oxf-tile"
          key={i}
          ref={(el) => t.el = el}
          onPointerDown={(e) => {
            const r = stageRef.current.getBoundingClientRect();
            t.drag = true;
            t.targetX = undefined; t.targetY = undefined;
            t.dragOffX = e.clientX - r.left - t.x;
            t.dragOffY = e.clientY - r.top - t.y;
            t.lastX = e.clientX; t.lastY = e.clientY;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!t.drag) return;
            const r = stageRef.current.getBoundingClientRect();
            t.x = e.clientX - r.left - t.dragOffX;
            t.y = e.clientY - r.top - t.dragOffY;
            t.vx = (e.clientX - t.lastX) * 0.5;
            t.vy = (e.clientY - t.lastY) * 0.5;
            t.lastX = e.clientX; t.lastY = e.clientY;
          }}
          onPointerUp={() => t.drag = false}
        >
          <div className="cat">{t.cat}</div>
          <div className="name">{t.name}</div>
          <div className="loc">{t.loc}</div>
          <div className="sf">{t.sf}</div>
        </div>
      ))}
      <div className="sort">
        {[['grid','Grid'],['market','By market'],['scatter','Scatter']].map(([k, l]) => (
          <button key={k} aria-pressed={sort===k} onClick={() => applySort(k)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------
   Home page
   ----------------------------------------------------------- */
function OxfordHome({ setPage }) {
  const D = window.OXFORD_DATA;

  return (
    <div>
      {/* Hero: editorial headline + live portfolio monitor */}
      <section className="oxf-hero">
        <div className="oxf-hero-inner">
          <div style={{display:'flex',flexDirection:'column',justifyContent:'center'}}>
            <div className="eyebrow">
              <span className="line"/>
              <span className="live-dot"/>
              <span>Oxford Realty Advisors · Est. 2005 · Potomac, MD</span>
            </div>
            <h1>
              Private capital for <em>industrial</em> real estate.
            </h1>
            <p className="lede">
              All-cash acquisitions. No committee. 30-day close. 100% family capital invested in
              value-add industrial and flex across the Mid-Atlantic and Midwest — held for generations.
            </p>
            <div className="actions">
              <button className="btn primary" onClick={() => setPage('brokers')}>Submit your deal</button>
              <button className="btn" onClick={() => setPage('space')}>Available space</button>
              <button className="btn" onClick={() => setPage('firm')}>Download overview</button>
            </div>
            <div className="stamp">
              <div><b>$1M–$10M</b>Deal size</div>
              <div><b>15% LTV</b>Portfolio-wide</div>
              <div><b>Zero</b>Failed closings since 2005</div>
            </div>
          </div>
          <OxfordMonitor/>
        </div>
      </section>

      {/* Mandate */}
      <section className="oxf-mandate">
        <div className="section-label">Mandate</div>
        <h2>
          We buy what institutional capital <em>overlooks</em> — at a basis that cannot be replicated.
        </h2>
      </section>

      {/* Headline metrics */}
      <section className="oxf-numbers">
        {D.metrics.map((m, i) => (
          <div className="metric" key={i}>
            <div className="metric-value"><em>{m.v}</em></div>
            <div className="metric-label">{m.l}</div>
          </div>
        ))}
      </section>

      {/* The Firm — editorial two-column */}
      <section className="oxf-edit">
        <div>
          <div className="section-label">The Firm</div>
          <h3>A private investment firm, built for generations.</h3>
        </div>
        <div className="body">
          <p>Founded in 2005, Oxford began as a commercial real estate advisory practice before recognizing
          the greatest opportunity lay in owning. Today we are a principal investor and operator with 600,000+ SF
          of shallow-bay industrial and flex across four core markets — acquired with 100% family capital,
          no outside investors, and no fund structure.</p>
          <p>We target the structural undersupply of functional Class B/C industrial in secondary markets,
          acquiring what institutional buyers avoid: high-vacancy assets with deferred maintenance, environmental
          complexity, or fractured ownership. Below-market leases reset at expiry, occupancy climbs through
          active management, and proceeds recycle into accretive acquisitions. A 15% portfolio LTV means
          all-cash closings on every deal — and the ability to hold through any cycle.</p>
        </div>
      </section>

      {/* Basis scrubber — reuse atlas variant */}
      <section className="container">
        <BasisScrubber variant="atlas"/>
      </section>

      {/* Geography — map + markets rail */}
      <section className="oxf-geo">
        <div className="head">
          <div className="section-label">Geography</div>
          <h2>Four markets. <em>One thesis.</em></h2>
        </div>
        <div className="oxf-geo-grid">
          <div className="oxf-geo-map">
            <div className="cap">Four core markets · Live</div>
            <MeshMap variant="atlas"/>
            <div className="legend">
              <span><b>●</b> Active market</span>
              <span>27+ properties</span>
              <span>600,000+ SF</span>
            </div>
          </div>
          <div className="oxf-markets">
            {D.markets.map((m, i) => (
              <div className="oxf-market" key={i}>
                <div className={`num ${m.n === 0 ? 'soon' : ''}`}>
                  {m.n > 0 ? String(m.n).padStart(2,'0') : 'soon'}
                </div>
                <div>
                  <h4>{m.name}</h4>
                  <p>{m.detail}</p>
                </div>
                <div className={`tag ${m.n === 0 ? 'soon' : ''}`}>
                  {m.n > 0 ? 'Active' : 'Pipeline'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Marquee — one engineered moment between narrative sections */}
      <section className="oxf-marquee" aria-hidden="true">
        <div className="track">
          {[1,2].map(rep => (
            <React.Fragment key={rep}>
              <span><em>600K+</em> sq ft</span><span className="sep">·</span>
              <span><em>140+</em> tenants</span><span className="sep">·</span>
              <span><em>27+</em> properties</span><span className="sep">·</span>
              <span><em>4</em> markets</span><span className="sep">·</span>
              <span><em>15%</em> LTV</span><span className="sep">·</span>
              <span><em>21+</em> years</span><span className="sep">·</span>
              <span><em>30</em> day close</span><span className="sep">·</span>
            </React.Fragment>
          ))}
        </div>
      </section>

      {/* Track record / cases */}
      <section className="oxf-cases">
        <div className="head">
          <div>
            <div className="section-label">Track Record</div>
            <h2>Proven value creation.</h2>
          </div>
          <button className="btn" onClick={() => setPage('track')}>All case studies →</button>
        </div>
        <div className="oxf-case-grid">
          {D.cases.map((c, i) => (
            <div className="oxf-case" key={i} onClick={() => setPage('track')}>
              <div className="img">
                <span className="marker">{String(i+1).padStart(2,'0')}</span>
                <span className="placeholder">[ property photograph ]</span>
              </div>
              <div className="meta">{c.loc}</div>
              <h3>{c.name}</h3>
              <div className="stats">
                {c.stats.map(([v, l], j) => (
                  <div className="stat" key={j}><b>{v}</b><span>{l}</span></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pull quote */}
      <section className="oxf-quote">
        <blockquote>
          I've worked with Oxford for about 13 years and we've completed half a dozen transactions together.
          They consistently perform as capable buyers — professional, easy to work with, and they never waste my time.
        </blockquote>
        <cite><b>Nathan Pealer</b> — Managing Director Investments, Marcus &amp; Millichap</cite>
      </section>

      {/* Available space — draggable field */}
      <section className="oxf-space">
        <div className="head">
          <div>
            <div className="section-label">Available Space</div>
            <h2>Current inventory, <em>across the network.</em></h2>
          </div>
          <button className="btn" onClick={() => setPage('space')}>See all space →</button>
        </div>
        <OxfordPropertyField/>
      </section>

      {/* Timeline */}
      <section className="oxf-timeline">
        <div className="section-label">History</div>
        <h2 style={{fontFamily:'var(--font-display)',fontSize:'clamp(40px,4.8vw,80px)',letterSpacing:'-0.035em',margin:'16px 0 0',fontWeight:400,lineHeight:0.98}}>
          Two decades of growth.
        </h2>
        <div className="oxf-tl-rail">
          {D.timeline.map((t, i) => (
            <div className="oxf-tl-step" key={i}>
              <div className="y">{t.y}</div>
              <div className="tag">{t.tag}</div>
              <p>{t.t}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Broker CTA */}
      <section className="oxf-broker">
        <div className="oxf-broker-box">
          <div>
            <div className="section-label">For Brokers</div>
            <h3>Submit. Score.<br/>LOI. <em>Close.</em></h3>
            <p className="lede">
              Four steps. Thirty days. We have never failed to close a deal under contract since 2005.
              Your commission is locked at LOI — never renegotiated.
            </p>
            <div className="actions">
              <button className="btn accent" onClick={() => setPage('brokers')}>Broker program →</button>
              <button className="btn" onClick={() => setPage('contact')}>Get in touch</button>
            </div>
          </div>
          <div className="oxf-steps">
            {[
              ['01','Submit','Day 1'],
              ['02','Score','48 hours'],
              ['03','LOI','72 hours'],
              ['04','Close','30 days'],
            ].map(([n,t,d], i) => (
              <div className="step" key={i}>
                <span className="n">{n}</span>
                <span className="t">{t}</span>
                <span className="d">{d}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

Object.assign(window, { OxfordHome, OxfordMonitor, OxfordPropertyField });
