const STORAGE_ENABLED_KEY = "cntStockOverlayEnabled";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ [STORAGE_ENABLED_KEY]: true });
});
