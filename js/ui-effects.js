/* ====================================================================
   ERIS — Presentation effects
   Watches the DOM that app.js renders and adds motion on top of it:
   hero headline reveal, sliding nav indicator, KPI count-up, content
   reveal on scroll and workspace switch, and a theme cross-fade.
   Nothing here changes application state.
   ==================================================================== */

const root = document.documentElement;
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const prefersReduced = () => Boolean(reduceMotion?.matches);

root.classList.add("fx-ready", "fx-loading");

// ── Hero headline: rise word by word whenever the workspace changes ──
function initHeroTitle() {
  const title = document.getElementById("workspaceTitle");
  const description = document.getElementById("workspaceDescription");
  if (!title) return;

  const split = () => {
    const text = title.textContent.trim();
    if (title.dataset.fxText === text && title.querySelector(".fx-word")) return;
    title.dataset.fxText = text;
    title.setAttribute("aria-label", text);
    title.replaceChildren(...text.split(/\s+/).flatMap((word, i, words) => {
      const outer = document.createElement("span");
      outer.className = "fx-word";
      outer.setAttribute("aria-hidden", "true");
      const inner = document.createElement("span");
      inner.style.setProperty("--i", i);
      inner.textContent = word;
      outer.append(inner);
      return i < words.length - 1 ? [outer, document.createTextNode(" ")] : [outer];
    }));
    replay(description);
  };

  split();
  new MutationObserver(split).observe(title, { childList: true, characterData: true, subtree: true });
}

function replay(el, delay) {
  if (!el) return;
  el.classList.remove("fx-fade");
  if (delay !== undefined) el.style.setProperty("--fx-delay", `${delay}ms`);
  void el.offsetWidth; // restart the animation
  el.classList.add("fx-fade");
}

// ── Nav: one indicator that slides to the active workspace ──
function initNavIndicator() {
  const nav = document.getElementById("primaryNav");
  if (!nav) return;
  const indicator = document.createElement("span");
  indicator.className = "nav-indicator";
  indicator.setAttribute("aria-hidden", "true");
  nav.append(indicator);

  const place = () => {
    const active = nav.querySelector(".nav-tab-btn.active");
    if (!active || !nav.offsetParent) return;
    const inset = 10;
    indicator.style.width = `${Math.max(active.offsetWidth - inset * 2, 0)}px`;
    // The nav may wrap onto two rows: lift the indicator (anchored at the nav's bottom) to the active tab's row.
    const lift = active.offsetTop + active.offsetHeight - nav.clientHeight;
    indicator.style.transform = `translate(${active.offsetLeft + inset}px, ${Math.min(lift, 0)}px)`;
    if (!indicator.classList.contains("is-placed")) indicator.classList.add("is-placed");
    const left = active.offsetLeft - nav.scrollLeft;
    if (left < 0 || left + active.offsetWidth > nav.clientWidth) {
      nav.scrollTo({ left: active.offsetLeft - 24, behavior: prefersReduced() ? "auto" : "smooth" });
    }
  };

  place();
  // Enable the slide only after the first placement, so it does not sweep in on load.
  requestAnimationFrame(() => requestAnimationFrame(() => indicator.classList.add("is-ready")));
  // Only react to tab buttons changing class; the indicator's own class changes
  // would otherwise re-trigger this observer endlessly.
  new MutationObserver(records => {
    if (records.some(r => r.target.classList?.contains("nav-tab-btn"))) place();
  }).observe(nav, { attributes: true, attributeFilter: ["class", "hidden"], subtree: true }); // hidden: role gating re-wraps
  window.addEventListener("resize", place, { passive: true });
  document.fonts?.ready.then(place);
}

// ── KPI values count up from their previous number ──
function initCountUp() {
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  document.querySelectorAll(".kpi-value").forEach(el => {
    let shown = Number.parseInt(el.textContent, 10); // the number currently on screen
    let frame = 0;

    // Every mutation the observer sees is an app write: the animation's own frames are taken out of the queue
    // as they are written, so an app value that happens to equal the current frame is still honoured.
    const observer = new MutationObserver(() => {
      const text = el.textContent.trim();
      // Only plain integers count up; values like "5/6" or "—" are shown as written.
      if (/^\d+$/.test(text)) animateTo(Number(text));
      else { cancelAnimationFrame(frame); shown = Number.NaN; }
    });
    const writeFrame = value => {
      el.textContent = String(value);
      shown = value;
      observer.takeRecords();
    };

    const animateTo = target => {
      cancelAnimationFrame(frame);
      const from = Number.isFinite(shown) ? shown : 0;
      if (prefersReduced() || from === target) { shown = target; return; }
      const start = performance.now();
      const duration = Math.min(900, 380 + Math.abs(target - from) * 18);
      const step = now => {
        const t = Math.min((now - start) / duration, 1);
        writeFrame(t < 1 ? Math.round(from + (target - from) * easeOut(t)) : target);
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    observer.observe(el, { childList: true, characterData: true, subtree: true });
  });
}

// ── Content reveal: on scroll, and again each time a workspace opens ──
const REVEAL_SELECTOR = [
  ".tab-pane > :not(.grid-2col):not(.dashboard-grid):not(.modal-overlay)",
  ".tab-pane > .grid-2col > *",
  ".tab-pane > .dashboard-grid > * > *",
].join(", ");

function initReveal() {
  const targets = [...document.querySelectorAll(REVEAL_SELECTOR)];
  if (!("IntersectionObserver" in window) || prefersReduced()) return;

  let batchOffset = 420; // first batch waits for the hero headline
  const observer = new IntersectionObserver(entries => {
    let index = 0;
    entries
      .sort((a, b) => (a.target.compareDocumentPosition(b.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .forEach(entry => {
        const el = entry.target;
        if (entry.isIntersecting) {
          if (el.classList.contains("fx-in")) return;
          el.style.setProperty("--fx-delay", `${batchOffset + Math.min(index++, 6) * 80}ms`);
          el.classList.add("fx-in");
        } else if (!el.closest(".tab-pane.active")) {
          // Hidden with its workspace: reset so it reveals again next time.
          el.classList.remove("fx-in", "fx-settled");
        }
      });
    batchOffset = 0;
  }, { rootMargin: "0px", threshold: 0 });

  targets.forEach(el => {
    el.classList.add("fx-reveal");
    el.addEventListener("transitionend", event => {
      if (event.target === el && event.propertyName === "opacity" && el.classList.contains("fx-in")) {
        el.classList.add("fx-settled");
      }
    });
    observer.observe(el);
  });
}

// ── Hero chrome follows the headline on first load ──
function initHeroEntrance() {
  const actions = document.querySelector(".workspace-actions");
  const banner = document.getElementById("dataSourceBanner");
  replay(actions);
  replay(banner);
  window.setTimeout(() => root.classList.remove("fx-loading"), 50);
}

// ── Theme switch cross-fades instead of snapping ──
function initThemeCrossfade() {
  let timer = 0;
  document.addEventListener("click", event => {
    if (!event.target.closest?.("#themeToggleBtn") || prefersReduced()) return;
    root.classList.add("fx-theming");
    clearTimeout(timer);
    timer = window.setTimeout(() => root.classList.remove("fx-theming"), 560);
  }, true);
}

function init() {
  initHeroTitle();
  initHeroEntrance();
  initNavIndicator();
  initCountUp();
  initReveal();
  initThemeCrossfade();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
