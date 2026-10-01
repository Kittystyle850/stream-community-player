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