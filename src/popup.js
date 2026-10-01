"use strict";

const KEYS = ["autoFullscreen", "autoUnmute", "autoPlayInitial", "autoNext", "resume"];
const DEFAULTS = {
  autoFullscreen: true,
  autoUnmute: true,
  autoPlayInitial: true,
  autoNext: true,
  resume: true
};

document.getElementById("version").textContent = chrome.runtime.getManifest().version;

chrome.storage.sync.get(DEFAULTS).then((s) => {
  for (const k of KEYS) {
    const el = document.getElementById(k);
    if (!el) continue;
    el.checked = s[k];
    el.addEventListener("change", () => {
      chrome.storage.sync.set({ [k]: el.checked });
    });
  }
});

// Stato: verifica contentSettings solo se disponibile (Chrome)
const status = document.getElementById("status");

function setStatus(ok, text) {
  status.className = ok ? "status ok" : "status warn";
  status.textContent = text;
}

if (chrome.contentSettings && chrome.contentSettings.fullscreen) {
  chrome.contentSettings.fullscreen
    .get({ primaryUrl: "https://vixcloud.co/" })
    .then((r) => {
      if (r.setting === "allow") setStatus(true, "✅ Estensione attiva e pronta");
      else setStatus(false, "⚠ Ricarica la pagina per attivare");
    })
    .catch(() => setStatus(true, "✅ Estensione attiva e pronta"));
} else {
  // Firefox: nessun contentSettings, mostra stato generico
  setStatus(true, "✅ Estensione attiva e pronta");
}
