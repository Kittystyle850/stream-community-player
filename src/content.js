// ============================================================
//  Stream Community Player — Content Script
// ============================================================
"use strict";
(() => {
  const isVixcloud = location.hostname.includes("vixcloud");
  const isScHost = !isVixcloud && /streamingcommunity|streamingunity/i.test(location.hostname);
  const isTop = window.self === window.top;
  const isScIframe = isScHost && !isTop;
  const isExtensionContext = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;

  const _svgParser = new DOMParser();
  function safeSetSvg(element, svgString) {
    if (!element || !svgString) return;
    try {
      element.textContent = "";
      const doc = _svgParser.parseFromString(svgString, "image/svg+xml");
      const imported = document.importNode(doc.documentElement, true);
      element.appendChild(imported);
    } catch (e) {}
  }

  window.__vixbpWindowFs = false;
  const SETTINGS_CACHE = {};
  let settingsLoaded = false;
  const settingsWaiters = [];

  if (isExtensionContext) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.type !== "string") {
        if (msg && msg.action === "settingChanged") {
          SETTINGS_CACHE[msg.key] = msg.value;
        }
        return;
      }
      if (msg.type === "vixbp:window-fullscreen-changed") {
        window.__vixbpWindowFs = !!msg.inFullscreen;
        window.dispatchEvent(new CustomEvent("vixbp:fs-changed", {
          detail: { fullscreen: window.__vixbpWindowFs }
        }));
      }
      if (msg.type === "vixbp:parent-fullscreen-changed") {
        window.__vixbpParentFs = !!msg.inFullscreen;
      }
    });

    try {
      chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
        if (s) Object.assign(SETTINGS_CACHE, s);
        settingsLoaded = true;
        settingsWaiters.forEach(cb => { try { cb(); } catch {} });
      });
    } catch {}
  } else {
    settingsLoaded = true;
  }

  function withSettings(cb) {
    if (settingsLoaded) { cb(); return; }
    settingsWaiters.push(cb);
  }

  const fsExit = () => {
    if (document.fullscreenElement) {
      const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
      if (fn) { try { fn.call(document).catch(() => {}); } catch {} }
    }
    if (isExtensionContext) {
      try { chrome.runtime.sendMessage({ action: "exitFullscreen" }, () => {}); } catch {}
    }
    return Promise.resolve(true);
  };

  const fsToggle = () => {
    if (document.fullscreenElement || window.__vixbpWindowFs) {
      return fsExit();
    }
    const player = document.querySelector(".jwplayer") || document.documentElement;
    const fn = player.requestFullscreen || player.webkitRequestFullscreen || player.mozRequestFullScreen;
    if (!fn) {
      if (isExtensionContext) {
        try { chrome.runtime.sendMessage({ action: "enterFullscreen" }, () => {}); } catch {}
      }
      return Promise.resolve(false);
    }
    try {
      return Promise.resolve(fn.call(player))
        .then(() => true)
        .catch(() => {
          if (isExtensionContext) {
            try { chrome.runtime.sendMessage({ action: "enterFullscreen" }, () => {}); } catch {}
          }
          return false;
        });
    } catch (e) {
      return Promise.resolve(false);
    }
  };

  function requestPlayerFullscreenSync(video) {
    if (document.fullscreenElement || window.__vixbpWindowFs) return;

    try {
      if (typeof window.jwplayer === "function") {
        const jw = window.jwplayer();
        if (jw && typeof jw.setFullscreen === "function") {
          try { jw.setFullscreen(true); return; } catch {}
        }
      }
    } catch {}

    try {
      const player = document.querySelector(".jwplayer") || (video && video.parentElement);
      if (player) {
        const fn = player.requestFullscreen || player.webkitRequestFullscreen || player.mozRequestFullScreen;
        if (fn) {
          Promise.resolve(fn.call(player)).catch(() => {
            if (isExtensionContext) {
              try { chrome.runtime.sendMessage({ action: "enterFullscreen" }, () => {}); } catch {}
            }
          });
          return;
        }
      }
    } catch {}

    if (isExtensionContext) {
      try { chrome.runtime.sendMessage({ action: "enterFullscreen" }, () => {}); } catch {}
    }
  }

  // MASTER PLAYLIST CAPTURE
  if (isVixcloud) {
    window.__vixbpLastManifest = null;
    window.__vixbpRenditions = [];

    function parseMasterPlaylist(text) {
      if (!text || typeof text !== "string") return;
      const found = [];
      const seen = new Set();
      try {
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (/^#EXT-X-STREAM-INF/i.test(line)) {
            let urlLine = "";
            for (let j = i + 1; j < lines.length; j++) {
              const nxt = lines[j].trim();
              if (nxt && !nxt.startsWith("#")) { urlLine = nxt; break; }
            }
            if (!urlLine) continue;
            const rendMatch = urlLine.match(/rendition=(\d+p)/i);
            const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
            let label = null, height = 0;
            if (rendMatch) { label = rendMatch[1]; height = parseInt(label, 10); }
            else if (resMatch) { height = parseInt(resMatch[1], 10); label = height + "p"; }
            if (label && !seen.has(label)) {
              seen.add(label);
              found.push({ label, height, url: urlLine });
            }
          }
        }
      } catch {}
      found.sort((a, b) => a.height - b.height);
      window.__vixbpRenditions = found;
    }

    try {
      const _fetch = window.fetch;
      window.fetch = function (...args) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        const p = _fetch.apply(this, args);
        if (typeof url === "string" && /\/playlist\/\d+/.test(url) && !/type=/.test(url)) {
          window.__vixbpLastManifest = url;
          p.then(r => r.clone().text().then(parseMasterPlaylist).catch(() => {})).catch(() => {});
        }
        return p;
      };
    } catch {}

    try {
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, url, ...rest) {
        if (typeof url === "string" && /\/playlist\/\d+/.test(url) && !/type=/.test(url)) {
          window.__vixbpLastManifest = url;
          this.addEventListener("readystatechange", () => {
            if (this.readyState === 4 && this.status === 200) {
              try { parseMasterPlaylist(this.responseText); } catch {}
            }
          });
        }
        return _open.call(this, m, url, ...rest);
      };
    } catch {}
  }

  // BRIDGE (SC iframe)
  if (isScIframe) {
    window.addEventListener("message", (e) => {
      if (!e.origin || !e.origin.includes("vixcloud")) return;
      const data = e.data;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "vixbp:next-episode") {
        const curUrl = new URL(location.href);
        const curEp = curUrl.searchParams.get("e") || curUrl.searchParams.get("episode_id");
        const links = Array.from(document.querySelectorAll('a[href*="?e="], a[href*="?episode_id="]'));
        let idx = -1;
        for (let i = 0; i < links.length; i++) {
          try {
            const u = new URL(links[i].href, location.href);
            const ep = u.searchParams.get("e") || u.searchParams.get("episode_id");
            if (ep && ep === curEp) { idx = i; break; }
          } catch {}
        }
        if (idx !== -1 && idx < links.length - 1) location.href = links[idx + 1].href;
        return;
      }
      try { window.top.postMessage(data, "*"); } catch {}
    });
    return;
  }

  // CONTROLLER (SC top)
  if (isTop && isScHost) {
    function findNextUrl() {
      const curUrl = new URL(location.href);
      const curEp = curUrl.searchParams.get("e");
      const watchPath = curUrl.pathname;
      let links = Array.from(document.querySelectorAll(`a[href*="${watchPath}"]`)).filter(a => a.href.includes("?e="));
      if (!links.length) links = Array.from(document.querySelectorAll('a[href*="?e="]'));
      let idx = -1;
      for (let i = 0; i < links.length; i++) {
        try {
          const u = new URL(links[i].href);
          if (u.searchParams.get("e") === curEp) { idx = i; break; }
        } catch {}
      }
      if (idx === -1 || idx >= links.length - 1) return null;
      return links[idx + 1].href;
    }

    function broadcastToFrames(msg) {
      document.querySelectorAll("iframe").forEach(f => {
        try { f.contentWindow.postMessage(msg, "*"); } catch {}
      });
    }

    async function fetchEmbedSrc(epId, lang, titleId) {
      for (const u of [
        `/${lang}/iframe/${titleId}?episode_id=${epId}&next_episode=1&language=${lang}`,
        `/${lang}/iframe/${titleId}?episode_id=${epId}&language=${lang}`
      ]) {
        try {
          const r = await fetch(u, { credentials: "same-origin" });
          if (!r.ok) continue;
          const html = await r.text();
          const mm = html.match(/<iframe[^>]+src=["']([^"']*vixcloud[^"']*)["']/i);
          if (mm) return mm[1];
        } catch {}
      }
      return null;
    }

    async function performSpaSwap(urlObj, epId) {
      const m = urlObj.pathname.match(/\/([a-z]{2})\/watch\/(\d+)/i);
      if (!m) return false;
      const lang = m[1], titleId = m[2];
      try { history.pushState({}, "", urlObj.pathname + urlObj.search); } catch {}
      const embedUrl = await fetchEmbedSrc(epId, lang, titleId);
      if (!embedUrl) return false;
      broadcastToFrames({ type: "vixbp:load-embed-in-place", embedUrl });
      return true;
    }

    document.addEventListener("click", async (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const link = e.target.closest('a[href*="?e="], a[href*="?episode_id="]');
      if (!link || !link.href) return;
      let urlObj;
      try { urlObj = new URL(link.href); } catch { return; }
      const epId = urlObj.searchParams.get("e") || urlObj.searchParams.get("episode_id");
      if (!epId) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const ok = await performSpaSwap(urlObj, epId);
      if (!ok) location.href = urlObj.href;
    }, true);

    window.addEventListener("message", async (e) => {
      const data = e.data;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "vixbp:next-episode") {
        const nextUrl = findNextUrl();
        if (nextUrl) location.href = nextUrl; else location.reload();
      }
      if (data.type === "vixbp:get-next-embed") {
        const nextUrl = findNextUrl();
        if (!nextUrl) { broadcastToFrames({ type: "vixbp:next-embed-src", src: null }); return; }
        const u = new URL(nextUrl);
        const m = u.pathname.match(/\/([a-z]{2})\/watch\/(\d+)/i);
        if (!m) { broadcastToFrames({ type: "vixbp:next-embed-src", src: null }); return; }
        const src = await fetchEmbedSrc(u.searchParams.get("e"), m[1], m[2]);
        broadcastToFrames({ type: "vixbp:next-embed-src", src });
      }
    });
    return;
  }

  if (!isVixcloud) return;

  // PLAYER UI
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };

  const EMBED_ID = location.pathname.split("/").filter(Boolean).pop() || "unknown";
  const URL_PARAMS = new URLSearchParams(location.search);
  const EP_ID = URL_PARAMS.get("episode_id") || URL_PARAMS.get("e") || "0";
  const RESUME_CTX = `vix-${EMBED_ID}-${EP_ID}`;
  const RESUME_PFX = "vixbp-resume:";

  const HIDE_DELAY_MS = 3000;
  const SAVE_INTERVAL_MS = 5000;
  const RESUME_MIN_POS = 5;
  const RESUME_END_GAP = 10;

  const mk = (t, id) => { const e = document.createElement(t); if (id) e.id = id; return e; };
  const el = (tag, cls, opts = {}) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (opts.id) e.id = opts.id;
    if (opts.text != null) e.textContent = opts.text;
    if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
    if (opts.style) Object.assign(e.style, opts.style);
    if (opts.on) for (const evt in opts.on) e.addEventListener(evt, opts.on[evt]);
    if (opts.kids) e.append(...opts.kids);
    return e;
  };
  const fmt = (s) => {
    const t = Math.max(0, Math.floor(isFinite(s) ? s : 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const svg = (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${p}</svg>`;
  const IC = {
    play: svg('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>'),
    pause: svg('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="5" height="18" x="14" y="3" rx="1"/><rect width="5" height="18" x="5" y="3" rx="1"/></g>'),
    mute: svg('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM22 9l-6 6m0-6l6 6"/>'),
    vol: svg('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6m3.364 3.364a9 9 0 0 0 0-12.728"/>'),
    fsOn: svg('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/>'),
    fsOff: svg('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3m8 0v-3a2 2 0 0 1 2-2h3"/>'),
    settings: svg('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0a2.34 2.34 0 0 0 3.319 1.915a2.34 2.34 0 0 1 2.33 4.033a2.34 2.34 0 0 0 0 3.831a2.34 2.34 0 0 1-2.33 4.033a2.34 2.34 0 0 0-3.319 1.915a2.34 2.34 0 0 1-4.659 0a2.34 2.34 0 0 0-3.32-1.915a2.34 2.34 0 0 1-2.33-4.033a2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></g>'),
    restart: svg('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></g>'),
    close: svg('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/>'),
    next: svg('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"/><path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"/></g>'),
    seekFwd: svg('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></g>'),
    seekBwd: svg('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M19 12H5M11 6l-6 6 6 6"/></g>')
  };

  function findVideo() {
    const videos = document.querySelectorAll("video");
    let best = null, bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width * r.height > bestArea) { best = v; bestArea = r.width * r.height; }
    }
    return best || videos[0] || null;
  }

  function flashToast(wrap, text, pos = "bottom") {
    if (!wrap) return;
    wrap.querySelector(`.vixbp-toast[data-pos="${pos}"]`)?.remove();
    const t = mk("div");
    t.className = "vixbp-toast";
    t.dataset.pos = pos;
    t.textContent = text;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 500);
    }, 4000);
  }

  function mkBtn(id, iconHtml, tip) {
    const b = mk("button");
    b.className = "vixbp-btn";
    b.id = id;
    b.tabIndex = -1;
    const ico = document.createElement("span");
    ico.className = "vixbp-ico";
    if (iconHtml) safeSetSvg(ico, iconHtml);
    b.appendChild(ico);
    if (tip) {
      const t = document.createElement("span");
      t.className = "vixbp-tip";
      t.textContent = tip;
      b.appendChild(t);
    }
    return { btn: b, ico };
  }

  const setIcon = (ico, html) => { if (ico) safeSetSvg(ico, html); };

  const PRESERVE = [".next-episode", ".jw-icon-next", "[aria-label='Successivo']", "[aria-label='Prossimo episodio']"];
  function isPreserved(e) {
    if (!e) return false;
    for (const sel of PRESERVE) {
      try { if (e.matches(sel) || e.querySelector(sel)) return true; } catch {}
    }
    return false;
  }

  function hideNativeChrome(video, wrap) {
    if (!video || !wrap) return;
    const keep = new Set();
    keep.add(document.documentElement); keep.add(document.head); keep.add(document.body);
    let n = video;
    while (n) { keep.add(n); n = n.parentElement; }
    n = wrap;
    while (n) { keep.add(n); n = n.parentElement; }
    const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "NOSCRIPT", "HEAD", "HTML", "BODY"]);
    document.body.querySelectorAll("*").forEach((e) => {
      if (keep.has(e)) return;
      if (e.closest("#vixbp-wrap")) return;
      if (SKIP.has(e.tagName)) return;
      if (isPreserved(e)) {
        if (!e.__vixbpVH) { e.__vixbpVH = true; e.style.setProperty("opacity", "0", "important"); }
        return;
      }
      e.style.setProperty("display", "none", "important");
      e.style.setProperty("visibility", "hidden", "important");
    });
  }

  function findNativeNextButton() {
    return document.querySelector(".next-episode")
      || document.querySelector(".jw-icon-next")
      || document.querySelector("[aria-label='Successivo'], [aria-label='Prossimo episodio'], [aria-label='Next']");
  }

  function getJwPlayer() {
    if (typeof window.jwplayer !== "function") return null;
    try {
      const p = window.jwplayer();
      if (!p || typeof p.getQualityLevels !== "function") return null;
      return p;
    } catch { return null; }
  }

  function waitForJwPlayer(timeout = 8000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const p = getJwPlayer();
        if (p) return resolve(p);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  function waitForManifestInIframe(ifr, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        try {
          const w = ifr.contentWindow;
          if (w && w.__vixbpLastManifest) return resolve(w.__vixbpLastManifest);
        } catch {}
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function tryGetNextEmbedSrc(timeout = 5000) {
    return new Promise((resolve) => {
      let settled = false;
      const h = (e) => {
        const d = e.data;
        if (!d || d.type !== "vixbp:next-embed-src") return;
        if (settled) return;
        settled = true;
        window.removeEventListener("message", h);
        resolve(d.src || null);
      };
      window.addEventListener("message", h);
      try { window.parent.postMessage({ type: "vixbp:get-next-embed" }, "*"); } catch {}
      try { window.top.postMessage({ type: "vixbp:get-next-embed" }, "*"); } catch {}
      setTimeout(() => { if (!settled) { settled = true; window.removeEventListener("message", h); resolve(null); } }, timeout);
    });
  }

  async function performDynamicNext() {
    const src = await tryGetNextEmbedSrc();
    if (!src) return false;
    const hidden = document.createElement("iframe");
    hidden.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;border:0";
    hidden.src = src;
    document.body.appendChild(hidden);
    const manifest = await waitForManifestInIframe(hidden, 10000);
    try { hidden.remove(); } catch {}
    if (!manifest) return false;
    const jw = await waitForJwPlayer(5000);
    if (!jw || typeof jw.load !== "function") return false;
    try {
      jw.load([{ file: manifest }]);
      try { const u = new URL(src); history.pushState({}, "", u.pathname + u.search); } catch {}
      return true;
    } catch { return false; }
  }

  function tryUnmute(video, wrap, savedVol) {
    const targetVol = Math.max(0.01, Math.min(1, isNaN(savedVol) ? 1 : savedVol));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      flashToast(wrap, "🔊 Audio attivo", "top");
      if (SETTINGS_CACHE.autoFullscreen !== false) requestPlayerFullscreenSync(video);
    };

    try {
      video.muted = false;
      video.volume = targetVol;
      if (video.paused) video.play().catch(() => {});
    } catch {}

    setTimeout(() => {
      if (!video.muted && !video.paused) { finish(); return; }
      flashToast(wrap, "🔇 Clicca ovunque per attivare l'audio", "top");
      const h = (e) => {
        if (!e.isTrusted) return;
        document.removeEventListener("pointerdown", h, true);
        document.removeEventListener("keydown", h, true);
        document.removeEventListener("touchstart", h, true);
        try {
          video.muted = false;
          video.volume = targetVol;
          if (video.paused) video.play().catch(() => {});
          finish();
        } catch {}
      };
      document.addEventListener("pointerdown", h, true);
      document.addEventListener("keydown", h, true);
      document.addEventListener("touchstart", h, true);
    }, 500);
  }

  function buildUI(video) {
    if (video.__vixbpWrapped) return null;
    video.__vixbpWrapped = true;
    try { video.removeAttribute("controls"); } catch {}

    const wrap = mk("div", "vixbp-wrap");
    wrap.id = "vixbp-wrap";

    const container = video.parentElement || video;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    video.style.setProperty("width", "100%", "important");
    video.style.setProperty("height", "100%", "important");
    video.style.setProperty("object-fit", "contain", "important");
    video.style.setProperty("display", "block", "important");
    video.style.setProperty("background", "#000", "important");
    video.insertAdjacentElement("afterend", wrap);

    hideNativeChrome(video, wrap);
    [200, 500, 1500, 4000].forEach(t => setTimeout(() => hideNativeChrome(video, wrap), t));
    const mo = new MutationObserver(() => hideNativeChrome(video, wrap));
    mo.observe(document.body, { childList: true, subtree: true });

    let settings = { vol: 1, muted: false };
    try {
      const v = parseFloat(lsGet("vixbp-vol") ?? "1");
      settings.vol = isNaN(v) ? 1 : v;
      settings.muted = lsGet("vixbp-muted") === "true";
    } catch {}
    let lastNonZeroVol = settings.muted ? settings.vol || 1 : settings.vol;

    let isPanelOpen = false;
    let wasPlayingBeforePanel = false;
    let hideTimer = null;

    const controls = el("div", null, { id: "vixbp-controls" });
    const seekWrap = el("div", null, { id: "vixbp-seek-wrap" });
    const seekTrack = el("div", null, { id: "vixbp-seek-track" });
    const seekBuf = el("div", null, { id: "vixbp-seek-buf" });
    const seekFill = el("div", null, { id: "vixbp-seek-fill" });
    const seekThumb = el("div", null, { id: "vixbp-seek-thumb" });
    const seekTip = el("div", null, { id: "vixbp-seek-tip" });
    const seekTipLabel = el("div", null, { id: "vixbp-seek-time", text: "00:00" });
    seekTip.append(seekTipLabel);
    seekTrack.append(seekBuf, seekFill, seekThumb, seekTip);
    seekWrap.append(seekTrack);

    let seeking = false;
    const applySeek = (e) => {
      const r = seekTrack.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      if (video.duration) video.currentTime = p * video.duration;
      seekFill.style.width = (p * 100) + "%";
      seekThumb.style.left = (p * 100) + "%";
    };
    seekWrap.addEventListener("pointerdown", (e) => {
      if (isPanelOpen) return;
      seeking = true; seekWrap.classList.add("seeking");
      try { seekWrap.setPointerCapture(e.pointerId); } catch {}
      applySeek(e); e.preventDefault(); e.stopPropagation();
    });
    seekWrap.addEventListener("pointermove", (e) => {
      if (seeking) applySeek(e);
      const r = seekTrack.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      seekTipLabel.textContent = fmt(p * (video.duration || 0));
      seekTip.style.left = (p * 100) + "%";
      seekTip.classList.add("visible");
    });
    seekWrap.addEventListener("pointerleave", () => seekTip.classList.remove("visible"));
    seekWrap.addEventListener("pointerup", () => { seeking = false; seekWrap.classList.remove("seeking"); });

    const bar = el("div", null, { id: "vixbp-bar" });
    const { btn: btnPlay, ico: icoPlay } = mkBtn("vixbp-btn-play", IC.play, "Play/Pausa (Spazio)");
    const { btn: btnRestart } = mkBtn("vixbp-btn-restart", IC.restart, "Ricomincia (R)");
    const { btn: btnMute, ico: icoMute } = mkBtn("vixbp-btn-mute", settings.muted ? IC.mute : IC.vol, "Muto (M)");
    const { btn: btnNext } = mkBtn("vixbp-btn-next", IC.next, "Prossimo episodio (N)");
    const { btn: btnSettings } = mkBtn("vixbp-btn-settings", IC.settings, "Impostazioni");
    const { btn: btnFs, ico: icoFs } = mkBtn("vixbp-btn-fs", IC.fsOn, "Fullscreen (F)");

    const timeEl = el("div", null, { id: "vixbp-time", text: "00:00 / 00:00" });

    const volGroup = el("div", null, { id: "vixbp-vol-group" });
    const volPopup = el("div", null, { id: "vixbp-vol-popup" });
    const volPctEl = el("div", null, { id: "vixbp-vol-pct" });
    const volEl = mk("input");
    volEl.id = "vixbp-vol";
    volEl.type = "range"; volEl.min = 0; volEl.max = 100;
    volEl.value = settings.muted ? 0 : Math.round(settings.vol * 100);
    volEl.tabIndex = -1;
    volPctEl.textContent = (settings.muted ? 0 : Math.round(settings.vol * 100)) + "%";
    volPopup.append(volPctEl, volEl);
    volGroup.append(volPopup, btnMute);

    const updateVolUi = () => {
      const pct = video.muted || video.volume === 0 ? 0 : Math.round(video.volume * 100);
      volPctEl.textContent = pct + "%";
      volEl.value = pct;
      volEl.style.background = `linear-gradient(to top, var(--vb-accent) ${pct}%, rgba(255,255,255,.25) ${pct}%)`;
      setIcon(icoMute, (video.muted || video.volume === 0) ? IC.mute : IC.vol);
    };
    volEl.addEventListener("input", () => {
      const v = Number(volEl.value) / 100;
      video.volume = v;
      video.muted = v === 0;
      if (v > 0) lastNonZeroVol = v;
      updateVolUi();
      lsSet("vixbp-vol", String(v === 0 ? lastNonZeroVol : v));
      lsSet("vixbp-muted", String(video.muted));
    });

    bar.append(btnPlay, btnRestart, volGroup, timeEl, el("div", "vixbp-spacer"), btnNext, btnSettings, btnFs);
    controls.append(seekWrap, bar);

    const settingsPanel = el("div", "vixbp-panel", { id: "vixbp-settings" });
    const settingsInner = el("div", "vixbp-pn-inner");
    const settingsBar = el("div", "vixbp-pn-bar");
    const settingsTitle = el("div", "vixbp-pn-title");
    const settingsTitleIconWrap = el("span", "vixbp-ico");
    safeSetSvg(settingsTitleIconWrap, IC.settings);
    settingsTitle.append(settingsTitleIconWrap, el("span", { text: "Impostazioni" }));
    const settingsClose = el("button", "vixbp-pn-close");
    safeSetSvg(settingsClose, IC.close);
    settingsBar.append(settingsTitle, settingsClose);
    const settingsBody = el("div", "vixbp-pn-body");
    settingsInner.append(settingsBar, settingsBody);
    settingsPanel.append(settingsInner);

    function mkToggleRow(label, key, def, desc) {
      const row = el("div", "vixbp-arow");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;padding:6px 8px;margin:-6px -8px;border-radius:8px;";
      const txt = el("div", "vixbp-row-txt");
      txt.append(el("span", "vixbp-row-label", { text: label }));
      if (desc) txt.append(el("span", "vixbp-row-desc", { text: desc }));
      const sw = el("label", "vixbp-switch");
      const inp = mk("input"); inp.type = "checkbox";
      const cur = SETTINGS_CACHE[key] !== undefined ? SETTINGS_CACHE[key] : def;
      inp.checked = cur;
      const track = el("span", "vixbp-switch-track");
      const thumb = el("span", "vixbp-switch-thumb");
      sw.append(inp, track, thumb);
      inp.addEventListener("change", () => {
        if (isExtensionContext) {
          try { chrome.runtime.sendMessage({ action: "setSetting", key, value: inp.checked }); } catch {}
        }
        SETTINGS_CACHE[key] = inp.checked;
      });
      row.addEventListener("click", () => { inp.checked = !inp.checked; inp.dispatchEvent(new Event("change")); });
      sw.addEventListener("click", (e) => e.stopPropagation());
      row.append(txt, sw);
      row.addEventListener("mouseenter", () => { row.style.background = "var(--vb-accent-state-1)"; });
      row.addEventListener("mouseleave", () => { row.style.background = ""; });
      return row;
    }

    withSettings(() => {
      settingsBody.append(
        mkToggleRow("Ripresa automatica", "resume", true, "Riprende dall'ultima interruzione"),
        mkToggleRow("Autoplay prossimo", "autoNext", true, "Passa all'episodio successivo"),
        mkToggleRow("Fullscreen automatico", "autoFullscreen", true, "Entra in fullscreen all'avvio"),
        mkToggleRow("Audio automatico", "autoUnmute", true, "Attiva audio appena possibile"),
        mkToggleRow("Autoplay iniziale", "autoPlayInitial", true, "Avvia il video da solo")
      );
    });

    btnSettings.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !settingsPanel.classList.contains("open");
      if (willOpen) {
        isPanelOpen = true;
        if (!video.paused) { wasPlayingBeforePanel = true; video.pause(); }
        settingsPanel.classList.add("open");
      } else {
        settingsPanel.classList.remove("open");
        isPanelOpen = false;
        if (wasPlayingBeforePanel && video.paused) { video.play().catch(() => {}); wasPlayingBeforePanel = false; }
      }
    });
    settingsClose.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsPanel.classList.remove("open");
      isPanelOpen = false;
      if (wasPlayingBeforePanel && video.paused) { video.play().catch(() => {}); wasPlayingBeforePanel = false; }
    });

    const flash = el("div", "vixbp-flash");
    safeSetSvg(flash, IC.play);
    let flashTimer = null;
    const flashAt = (html, dur = 700) => {
      safeSetSvg(flash, html);
      flash.classList.add("on");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove("on"), dur);
    };

    const switching = el("div", null, { id: "vixbp-switching" });
    switching.append(
      el("div", "sw-spin"),
      el("div", "sw-txt", { text: "Caricamento prossimo episodio…" })
    );

    wrap.append(controls, flash, settingsPanel, switching);

    video.addEventListener("timeupdate", () => {
      if (seeking || !video.duration) return;
      const p = video.currentTime / video.duration * 100;
      seekFill.style.width = p + "%";
      seekThumb.style.left = p + "%";
      timeEl.textContent = fmt(video.currentTime) + " / " + fmt(video.duration);
    });
    video.addEventListener("progress", () => {
      if (!video.duration || !video.buffered.length) return;
      seekBuf.style.width = video.buffered.end(video.buffered.length - 1) / video.duration * 100 + "%";
    });
    video.addEventListener("play", () => {
      setIcon(icoPlay, IC.pause);
      wrap.classList.add("ui");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => wrap.classList.remove("ui"), HIDE_DELAY_MS);
    });
    video.addEventListener("pause", () => {
      setIcon(icoPlay, IC.play);
      wrap.classList.add("ui");
      clearTimeout(hideTimer);
    });
    video.addEventListener("volumechange", updateVolUi);
    video.addEventListener("loadedmetadata", () => {
      timeEl.textContent = fmt(video.currentTime) + " / " + fmt(video.duration);
      attemptResume();
    }, { once: true });
    video.addEventListener("ended", () => {
      if (SETTINGS_CACHE.autoNext !== false) triggerNext("auto");
    });

    const updateFsIcon = () => {
      const fs = !!(document.fullscreenElement || window.__vixbpWindowFs);
      setIcon(icoFs, fs ? IC.fsOff : IC.fsOn);
      wrap.classList.toggle("fs", fs);
    };
    window.addEventListener("vixbp:fs-changed", updateFsIcon);
    ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange"].forEach(ev => {
      document.addEventListener(ev, updateFsIcon);
    });
    updateFsIcon();

    const toggle = () => video.paused ? video.play().catch(() => {}) : video.pause();
    btnPlay.addEventListener("click", (e) => { e.stopPropagation(); if (isPanelOpen) return; toggle(); });
    btnRestart.addEventListener("click", (e) => { e.stopPropagation(); if (isPanelOpen) return; video.currentTime = 0; video.play().catch(() => {}); flashAt(IC.restart); });
    btnMute.addEventListener("click", (e) => {
      e.stopPropagation(); if (isPanelOpen) return;
      if (video.muted || video.volume === 0) { video.muted = false; video.volume = lastNonZeroVol; }
      else { if (video.volume > 0) lastNonZeroVol = video.volume; video.muted = true; }
      updateVolUi();
      lsSet("vixbp-vol", String(video.muted ? lastNonZeroVol : video.volume));
      lsSet("vixbp-muted", String(video.muted));
    });
    btnNext.addEventListener("click", (e) => { e.stopPropagation(); if (isPanelOpen) return; triggerNext("button"); });
    btnFs.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isPanelOpen) return;
      fsToggle();
    });

    let _nextBusy = false;
    async function triggerNext() {
      if (_nextBusy) return false;
      _nextBusy = true;
      flashAt(IC.next);
      switching.classList.add("on");

      const prevVol = video.volume || 1;
      const prevSpeed = video.playbackRate;

      let ok = false;
      try { ok = await performDynamicNext(); } catch { ok = false; }

      if (ok) {
        const onReady = () => {
          video.removeEventListener("loadedmetadata", onReady);
          video.removeEventListener("canplay", onReady);
          try { video.muted = false; video.volume = prevVol; video.playbackRate = prevSpeed; } catch {}
          video.play().catch(() => {
            try { video.muted = true; video.play().catch(() => {}); } catch {}
            tryUnmute(video, wrap, prevVol);
          });
          setTimeout(() => { switching.classList.remove("on"); flashToast(wrap, "▶ Prossimo episodio", "top"); }, 600);
        };
        video.addEventListener("loadedmetadata", onReady, { once: true });
        video.addEventListener("canplay", onReady, { once: true });
        setTimeout(() => { if (switching.classList.contains("on")) onReady(); }, 10000);
        _nextBusy = false;
        return true;
      }

      const src = await tryGetNextEmbedSrc();
      if (src) {
        window.postMessage({ type: "vixbp:load-embed-in-place", embedUrl: src }, "*");
        _nextBusy = false;
        return true;
      }

      const native = findNativeNextButton();
      if (native) { try { native.click(); _nextBusy = false; return true; } catch {} }

      try { window.parent.postMessage({ type: "vixbp:next-episode" }, "*"); } catch {}
      switching.classList.remove("on");
      _nextBusy = false;
      return false;
    }

    window.addEventListener("message", async (e) => {
      const d = e.data;
      if (!d || typeof d.type !== "string") return;
      if (d.type === "vixbp:load-embed-in-place") {
        switching.classList.add("on");
        try {
          const r = await fetch(d.embedUrl, { credentials: "include" });
          const html = await r.text();
          const m = html.match(/["'](https?:\/\/[^"']*\/playlist\/\d+[^"']*)["']/i)
                 || html.match(/["'](https?:\/\/[^"']*\.m3u8[^"']*)["']/i);
          if (!m) throw new Error("manifest non trovato");
          const jw = await waitForJwPlayer(8000);
          if (!jw) throw new Error("jwplayer non disponibile");
          jw.load([{ file: m[1] }]);
          const onReady = () => {
            video.removeEventListener("loadedmetadata", onReady);
            video.removeEventListener("canplay", onReady);
            const sv = settings.vol;
            try { video.muted = false; video.volume = sv; video.playbackRate = 1; } catch {}
            video.play().catch(() => {
              try { video.muted = true; video.play().catch(() => {}); } catch {}
              tryUnmute(video, wrap, sv);
            });
            setTimeout(() => { switching.classList.remove("on"); flashToast(wrap, "▶ Prossimo episodio", "top"); }, 600);
          };
          video.addEventListener("loadedmetadata", onReady, { once: true });
          video.addEventListener("canplay", onReady, { once: true });
          setTimeout(() => { if (switching.classList.contains("on")) onReady(); }, 10000);
        } catch {
          switching.classList.remove("on");
          try { window.parent.postMessage({ type: "vixbp:next-episode" }, "*"); } catch {}
        }
      }
    });

    const resumeKey = () => RESUME_PFX + RESUME_CTX;
    function attemptResume() {
      if (SETTINGS_CACHE.resume === false) return;
      if (!isFinite(video.duration)) return;
      const saved = parseFloat(lsGet(resumeKey()) ?? "");
      if (!saved || saved < RESUME_MIN_POS) return;
      if (video.duration - saved < RESUME_END_GAP) { lsDel(resumeKey()); return; }
      try {
        video.currentTime = saved;
        flashToast(wrap, `▶ Ripreso da ${fmt(saved)}`, "top");
      } catch {}
    }
    let saveTimer = null;
    const saveNow = () => {
      if (SETTINGS_CACHE.resume === false) return;
      if (!isFinite(video.currentTime) || video.currentTime <= RESUME_MIN_POS) { lsDel(resumeKey()); return; }
      if (isFinite(video.duration) && video.duration - video.currentTime < RESUME_END_GAP) return;
      lsSet(resumeKey(), String(video.currentTime));
    };
    video.addEventListener("play", () => { if (!saveTimer) saveTimer = setInterval(saveNow, SAVE_INTERVAL_MS); });
    video.addEventListener("pause", () => { clearInterval(saveTimer); saveTimer = null; saveNow(); });
    video.addEventListener("ended", () => { clearInterval(saveTimer); saveTimer = null; lsDel(resumeKey()); });
    window.addEventListener("beforeunload", saveNow);

    document.addEventListener("mousemove", (e) => {
      if (isPanelOpen) return;
      const r = wrap.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        wrap.classList.add("ui");
        clearTimeout(hideTimer);
        if (!video.paused) hideTimer = setTimeout(() => wrap.classList.remove("ui"), HIDE_DELAY_MS);
      }
    }, true);
    wrap.addEventListener("mouseleave", () => {
      if (isPanelOpen) return;
      if (!video.paused) { wrap.classList.remove("ui"); clearTimeout(hideTimer); }
    });

    video.addEventListener("click", (e) => {
      if (isPanelOpen) { e.stopPropagation(); e.preventDefault(); return; }
      toggle();
    }, true);
    video.addEventListener("dblclick", (e) => {
      if (isPanelOpen) return;
      btnFs.click();
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement?.tagName ?? "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      const k = (e.key || "").toLowerCase();

      if (e.key === "Escape" && document.fullscreenElement) {
        e.preventDefault();
        fsExit();
        return;
      }

      if (isPanelOpen) {
        if (e.key === "Escape") {
          settingsPanel.classList.remove("open");
          isPanelOpen = false;
          if (wasPlayingBeforePanel && video.paused) { video.play().catch(() => {}); wasPlayingBeforePanel = false; }
        }
        return;
      }

      if (e.key === " " || e.code === "Space") { e.preventDefault(); toggle(); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); flashAt(IC.seekFwd, 400); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); flashAt(IC.seekBwd, 400); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); video.muted = false; updateVolUi(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); video.muted = video.volume === 0; updateVolUi(); return; }
      if (k === "f") { e.preventDefault(); fsToggle(); return; }
      if (k === "m") { e.preventDefault(); btnMute.click(); return; }
      if (k === "r") { e.preventDefault(); btnRestart.click(); return; }
      if (k === "n") { e.preventDefault(); btnNext.click(); return; }
    }, true);

    const startAutoplay = () => {
      if (SETTINGS_CACHE.autoPlayInitial === false) return;

      try {
        video.muted = false;
        video.volume = settings.vol;
        const p = video.play();
        if (p && p.catch) {
          p.catch(() => {
            try { video.muted = true; video.play().catch(() => {}); } catch {}
            setTimeout(() => tryUnmute(video, wrap, settings.vol), 500);
          });
        }
      } catch {}

      if (SETTINGS_CACHE.autoFullscreen !== false) {
        setTimeout(() => requestPlayerFullscreenSync(video), 800);
      }
    };

    if (video.readyState >= 1) startAutoplay();
    else {
      video.addEventListener("loadedmetadata", startAutoplay, { once: true });
      video.addEventListener("canplay", startAutoplay, { once: true });
    }

    updateVolUi();

    wrap.__vixbpCleanup = () => {
      try { mo.disconnect(); } catch {}
      clearInterval(saveTimer);
      clearTimeout(hideTimer);
      clearTimeout(flashTimer);
      try { wrap.remove(); } catch {}
      try { video.__vixbpWrapped = false; } catch {}
    };

    return wrap;
  }

  let _videoWrapped = null;
  function tryWrapVideo() {
    if (_videoWrapped && document.contains(_videoWrapped) && _videoWrapped.__vixbpWrapped) return;
    const v = findVideo();
    if (v && !v.__vixbpWrapped) {
      _videoWrapped = v;
      try { buildUI(v); } catch (e) { console.warn("[SCP]", e); try { v.__vixbpWrapped = false; } catch {} }
    }
  }

  function bootstrap() {
    tryWrapVideo();
    const obs = new MutationObserver(() => tryWrapVideo());
    obs.observe(document.documentElement, { childList: true, subtree: true });
    let tries = 0;
    const iv = setInterval(() => {
      tryWrapVideo();
      if (_videoWrapped && document.contains(_videoWrapped) && _videoWrapped.__vixbpWrapped) { clearInterval(iv); return; }
      if (++tries > 200) clearInterval(iv);
    }, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();