/* chrome.storage.local wrapped as the {getItem,setItem,removeItem} adapter
 * createLoader() (data.js) expects. Used to live inline in content.js;
 * pulled out here so the background script/service worker can use the same
 * loader (and the same player-dump cache) instead of re-fetching from
 * scratch on every alarm.
 *
 * Loaded as a plain script before content.js and before core.js/data.js in
 * the background script list, sharing top-level scope with them the same
 * way core.js and data.js already share scope with content.js and app.js -
 * see CLAUDE.md's Architecture section. */
const storage = {
  async getItem(key) {
    const obj = await chrome.storage.local.get(key);
    return obj[key] != null ? obj[key] : null;
  },
  async setItem(key, value) { await chrome.storage.local.set({ [key]: value }); },
  async removeItem(key) { await chrome.storage.local.remove(key); },
};
