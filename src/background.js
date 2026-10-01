// ============================================================
//  Stream Community Player — Background Service Worker
// ============================================================
"use strict";

const TARGET_PATTERNS = [
  "https://vixcloud.co/*",
  "https://*.vixcloud.co/*",
  "https://*.streamingcommunity.computer/*",
  "https://*.streamingcommunityz.pictures/*",
  "https://*.streamingcommunityz.website/*",
  "https://*.streamingcommunity*/*",
  "https://*.streamingunity.top/*",
  "https://*.streamingunity.*/*"
];

async function applyContentSettings() {
  for (const p of TARGET_PATTERNS) {
    try {
      await chrome.contentSettings.fullscreen.set({
        primaryPattern: p,
        setting: "allow"
      });
    } catch (e) {
      console.warn("[SCP] contentSettings fail:", p, e.message);
    }
  }
  console.log("[SCP] Content settings applicati per", TARGET_PATTERNS.length, "pattern");
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[SCP] Installato/aggiornato:", details.reason);
  applyContentSettings();
});

chrome.runtime.onStartup.addListener(applyContentSettings);
applyContentSettings();

// ---------- Fullscreen via Window API ----------
async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

async function setWindowFullscreen(tabId, on) {
  const tab = await getTab(tabId);
  if (!tab || tab.windowId == null) return false;
  try {
    await chrome.windows.update(tab.windowId, { state: on ? "fullscreen" : "normal" });
    return true;
  } catch (e) {
    console.warn("[SCP] setWindowFullscreen fail:", e.message);
    return false;
  }
}

async function isWindowFullscreen(tabId) {
  const tab = await getTab(tabId);
  if (!tab || tab.windowId == null) return false;
  try {
    const win = await chrome.windows.get(tab.windowId);
    return win.state === "fullscreen";
  } catch { return false; }
}

// ---------- Message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.action !== "string") return;
  const tabId = sender.tab?.id;

  switch (msg.action) {
    case "enterFullscreen":
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      setWindowFullscreen(tabId, true).then(ok => sendResponse({ ok }));
      return true;

    case "exitFullscreen":
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      setWindowFullscreen(tabId, false).then(ok => sendResponse({ ok }));
      return true;

    case "toggleFullscreen":
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      isWindowFullscreen(tabId).then(isFs =>
        setWindowFullscreen(tabId, !isFs).then(ok => sendResponse({ ok, fullscreen: !isFs }))
      );
      return true;

    case "isFullscreen":
      if (tabId == null) { sendResponse({ fullscreen: false }); return false; }
      isWindowFullscreen(tabId).then(fs => sendResponse({ fullscreen: fs }));
      return true;

    case "getSettings":
      chrome.storage.sync.get({
        autoFullscreen: true,
        autoUnmute: true,
        autoNext: true,
        autoPlayInitial: true,
        resume: true,
        seekSecs: 5,
        speed: 1
      }).then(s => sendResponse(s));
      return true;

    case "setSetting":
      if (typeof msg.key === "string") {
        chrome.storage.sync.set({ [msg.key]: msg.value })
          .then(() => {
            chrome.tabs.query({}).then(tabs => {
              tabs.forEach(t => {
                if (t.id) chrome.tabs.sendMessage(t.id, {
                  action: "settingChanged",
                  key: msg.key,
                  value: msg.value
                }).catch(() => {});
              });
            });
            sendResponse({ ok: true });
          });
        return true;
      }
      sendResponse({ ok: false });
      return false;
  }
});

// ---------- Propaga cambi fullscreen window a tutti i frame ----------
chrome.windows.onBoundsChanged.addListener(async (win) => {
  try {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, {
        type: "vixbp:window-fullscreen-changed",
        inFullscreen: win.state === "fullscreen"
      }).catch(() => {});
    }
  } catch {}
});