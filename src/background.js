// ============================================================
//  Stream Community Player — Background (Chrome + Firefox)
// ============================================================
"use strict";

const IS_FIREFOX = typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL;

// ============================================================
//  FULLSCREEN (Chrome: contentSettings | Firefox: windows.update)
// ============================================================
async function enterFullscreen(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.windowId == null) return false;
    await chrome.windows.update(tab.windowId, { state: "fullscreen" });
    return true;
  } catch (e) {
    console.warn("[SCP] enterFullscreen fail:", e.message);
    return false;
  }
}

async function exitFullscreen(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.windowId == null) return false;
    await chrome.windows.update(tab.windowId, { state: "normal" });
    return true;
  } catch (e) {
    console.warn("[SCP] exitFullscreen fail:", e.message);
    return false;
  }
}

async function isFullscreen(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.windowId == null) return false;
    const win = await chrome.windows.get(tab.windowId);
    return win.state === "fullscreen";
  } catch { return false; }
}

// ============================================================
//  MESSAGE ROUTER
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.action !== "string") return;
  const tabId = sender.tab?.id;

  switch (msg.action) {
    case "enterFullscreen":
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      enterFullscreen(tabId).then(ok => sendResponse({ ok }));
      return true;

    case "exitFullscreen":
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      exitFullscreen(tabId).then(ok => sendResponse({ ok }));
      return true;

    case "toggleFullscreen":
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      isFullscreen(tabId).then(isFs =>
        (isFs ? exitFullscreen(tabId) : enterFullscreen(tabId))
          .then(ok => sendResponse({ ok, fullscreen: !isFs }))
      );
      return true;

    case "isFullscreen":
      if (tabId == null) { sendResponse({ fullscreen: false }); return false; }
      isFullscreen(tabId).then(fs => sendResponse({ fullscreen: fs }));
      return true;

    case "getSettings":
      chrome.storage.sync.get({
        autoFullscreen: true,
        autoUnmute: true,
        autoNext: true,
        autoPlayInitial: true,
        resume: true
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

// ============================================================
//  PROPAGA FULLSCREEN (Firefox non ha onBoundsChanged)
//  Usiamo un polling leggero ogni 500ms quando la finestra è attiva
// ============================================================
if (!IS_FIREFOX) {
  // Chrome: usa onBoundsChanged
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
} else {
  // Firefox: polling fallback
  let _lastState = {};
  setInterval(async () => {
    try {
      const wins = await browser.windows.getAll();
      for (const win of wins) {
        const wasFs = _lastState[win.id];
        const isFs = win.state === "fullscreen";
        if (wasFs !== isFs) {
          _lastState[win.id] = isFs;
          const tabs = await browser.tabs.query({ windowId: win.id });
          for (const tab of tabs) {
            if (!tab.id) continue;
            browser.tabs.sendMessage(tab.id, {
              type: "vixbp:window-fullscreen-changed",
              inFullscreen: isFs
            }).catch(() => {});
          }
        }
      }
    } catch {}
  }, 500);
}

console.log("[SCP] Background attivo (Firefox:", IS_FIREFOX, ")");