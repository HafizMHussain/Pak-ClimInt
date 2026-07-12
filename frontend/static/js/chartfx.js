// Pak-ClimInt — shared chart FX layer. Loaded after Chart.js on both
// dashboard pages. Pure presentation: depth shadows, hover glow, cursor
// light-beam, glassmorphism tooltip and 3D tilt on chart boxes. It never
// touches the data — only how the same numbers are drawn.
(() => {
  if (typeof Chart === "undefined") return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ACCENT = "53,196,141";

  /* ---------- injected styles (glass tooltip + tilting boxes) ---------- */
  const style = document.createElement("style");
  style.textContent = `
    #glass-tip {
      position: fixed; z-index: 300; pointer-events: none; opacity: 0;
      transform: translate(-50%, calc(-100% - 16px));
      background: rgba(16, 25, 21, 0.82);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(${ACCENT}, 0.45); border-radius: 12px;
      padding: 0.55rem 0.85rem; font-size: 0.8rem; color: #e8f0ec;
      font-family: "Segoe UI", system-ui, sans-serif; max-width: 340px;
      box-shadow: 0 14px 38px rgba(0,0,0,0.55), 0 0 26px rgba(${ACCENT}, 0.13);
      transition: opacity 0.14s ease, left 0.07s linear, top 0.07s linear;
    }
    #glass-tip::after { /* caret */
      content: ""; position: absolute; left: 50%; bottom: -6px;
      width: 10px; height: 10px; transform: translateX(-50%) rotate(45deg);
      background: rgba(16, 25, 21, 0.82);
      border-right: 1px solid rgba(${ACCENT}, 0.45);
      border-bottom: 1px solid rgba(${ACCENT}, 0.45);
    }
    #glass-tip .gt-title {
      font-weight: 700; margin-bottom: 5px; color: #7df2c5;
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em;
    }
    #glass-tip .gt-line { display: flex; align-items: center; gap: 7px; line-height: 1.55; white-space: nowrap; }
    #glass-tip .gt-line i { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 auto; box-shadow: 0 0 8px currentColor; }
    #glass-tip .gt-sub { color: #9db3ab; padding-left: 16px; white-space: normal; font-size: 0.75rem; line-height: 1.5; }
    .chart-box { transition: transform 0.12s ease-out, border-color 0.2s, box-shadow 0.25s; will-change: transform; }
    .chart-box.tilted {
      border-color: rgba(${ACCENT}, 0.55) !important;
      box-shadow: 0 18px 44px rgba(0,0,0,0.45), 0 0 30px rgba(${ACCENT}, 0.10);
    }`;
  document.head.appendChild(style);

  /* ---------- glass tooltip (replaces the default canvas tooltip) ---------- */
  function glassTooltip(ctx2) {
    const { chart, tooltip } = ctx2;
    let el = document.getElementById("glass-tip");
    if (!el) { el = document.createElement("div"); el.id = "glass-tip"; document.body.appendChild(el); }
    if (!tooltip || tooltip.opacity === 0) { el.style.opacity = 0; return; }
    let html = "";
    const title = (tooltip.title || []).join(" · ");
    if (title) html += `<div class="gt-title">${title}</div>`;
    (tooltip.beforeBody || []).forEach((l) => (html += `<div class="gt-sub">${l}</div>`));
    (tooltip.body || []).forEach((b, i) => {
      const c = (tooltip.labelColors && tooltip.labelColors[i]) || {};
      let col = c.backgroundColor || c.borderColor;
      if (typeof col !== "string") col = "#35c48d";
      (b.lines || []).forEach((l, j) => {
        html += j === 0
          ? `<div class="gt-line"><i style="background:${col}; color:${col}"></i>${l}</div>`
          : `<div class="gt-sub">${l}</div>`;
      });
      (b.after || []).forEach((l) => (html += `<div class="gt-sub">${l}</div>`));
    });
    (tooltip.afterBody || []).forEach((l) => (html += `<div class="gt-sub">${l}</div>`));
    (tooltip.footer || []).forEach((l) => (html += `<div class="gt-sub">${l}</div>`));
    el.innerHTML = html;
    const r = chart.canvas.getBoundingClientRect();
    el.style.opacity = 1;
    el.style.left = r.left + tooltip.caretX + "px";
    el.style.top = r.top + tooltip.caretY + "px";
  }
  Chart.defaults.plugins.tooltip.enabled = false;
  Chart.defaults.plugins.tooltip.external = glassTooltip;
  // forgiving hover: snap to the nearest mark on the x axis, so the
  // tooltip/glow/beam appear even between bars, not only exactly on one
  Chart.defaults.interaction.mode = "nearest";
  Chart.defaults.interaction.intersect = false;
  Chart.defaults.interaction.axis = "x";

  /* ---------- depth: soft drop shadow under every mark ---------- */
  const depthFX = {
    id: "depthFX",
    beforeDatasetDraw(chart) {
      const ctx = chart.ctx;
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.38)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 5;
    },
    afterDatasetDraw(chart) { chart.ctx.restore(); },
  };

  /* ---------- hover glow: radial halo around the active mark ---------- */
  const hoverGlow = {
    id: "hoverGlow",
    afterDatasetsDraw(chart) {
      const active = chart.getActiveElements ? chart.getActiveElements() : [];
      if (!active.length) return;
      const ctx = chart.ctx;
      for (const a of active) {
        const el = a.element;
        const p = el.tooltipPosition ? el.tooltipPosition(true) : { x: el.x, y: el.y };
        if (p.x == null || p.y == null) continue;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 36);
        g.addColorStop(0, `rgba(${ACCENT}, 0.32)`);
        g.addColorStop(1, `rgba(${ACCENT}, 0)`);
        ctx.save();
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, 36, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    },
  };

  /* ---------- beam: vertical light column following the cursor ---------- */
  const beamFX = {
    id: "beamFX",
    beforeDatasetsDraw(chart) {
      if (!chart.scales || !chart.scales.x || !chart.chartArea) return;
      const active = chart.getActiveElements ? chart.getActiveElements() : [];
      if (!active.length) return;
      const x = active[0].element.x;
      if (x == null) return;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      const g = ctx.createLinearGradient(x - 26, 0, x + 26, 0);
      g.addColorStop(0, `rgba(${ACCENT}, 0)`);
      g.addColorStop(0.5, `rgba(${ACCENT}, 0.10)`);
      g.addColorStop(1, `rgba(${ACCENT}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - 26, top, 52, bottom - top);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(232, 240, 236, 0.30)";
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    },
  };

  Chart.register(depthFX, hoverGlow, beamFX);

  /* ---------- 3D tilt on the chart boxes (delegated — works for
       boxes created at any time) ---------- */
  if (!reduced) {
    document.addEventListener("mousemove", (e) => {
      const box = e.target.closest ? e.target.closest(".chart-box") : null;
      document.querySelectorAll(".chart-box.tilted").forEach((b) => {
        if (b !== box) { b.style.transform = ""; b.classList.remove("tilted"); }
      });
      if (!box) return;
      const r = box.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      box.classList.add("tilted");
      box.style.transform =
        `perspective(950px) rotateY(${(x * 3.5).toFixed(2)}deg) rotateX(${(-y * 3.5).toFixed(2)}deg) translateY(-3px)`;
    });
  }
})();
