/* MV3 background: opens the panel on the toolbar icon click, and checks
 * every league every 30 minutes for a starter who's been ruled out (or has
 * an empty slot) so the owner hears about it before kickoff instead of
 * finding out mid-week - the single most valuable thing this extension can
 * do without anyone opening anything.
 *
 * One file works unmodified as Chrome's service worker and Firefox's
 * background script (the manifest sets both `background.service_worker`
 * and `background.scripts`; each browser ignores the field it doesn't
 * understand) - but they load their dependencies differently. Chrome's
 * service worker only lists this file, so it pulls in core.js/data.js/
 * storage.js/alerts.js itself via importScripts; Firefox's
 * `background.scripts` lists all of them directly (a service worker has no
 * import statement of its own kind - importScripts is a Worker API, so the
 * guard below is a no-op there and this file just runs after the others,
 * sharing top-level scope with them the same way content.js does). */
if (typeof importScripts === "function") {
  importScripts("lib/core.js", "lib/data.js", "storage.js", "alerts.js");
}

if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

const ext = typeof browser !== "undefined" ? browser
          : (typeof chrome !== "undefined" ? chrome : null);
if (ext && ext.sidebarAction && ext.action) {
  ext.action.onClicked.addListener(() => {
    ext.sidebarAction.toggle();
  });
}

/* --------------------------------------------------------- alarm check */

const ALARM_NAME = "sr-check";
const ALERTED_KEY = "sr-alerted";

function scheduleAlarm() {
  if (chrome.alarms) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 30 });
}
if (chrome.runtime && chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(scheduleAlarm);
if (chrome.runtime && chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(scheduleAlarm);

async function loadAlerted() {
  try {
    const raw = await storage.getItem(ALERTED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

// MV3 can suspend the service worker the moment an event listener's
// callback returns, whether or not work it kicked off is still in flight -
// a bare `runCheck()` call from the alarm listener below wouldn't keep the
// worker alive for it. A concurrent run is also guarded against here: two
// overlapping runCheck() calls would both read the same on-disk `alerted`
// map before either had saved it, and whichever finished last would wipe
// out the other's newly-added keys, re-notifying for an already-seen
// problem next cycle. This flag only guards concurrent calls within the
// same live worker (it doesn't survive a worker restart), but two alarms
// 30 minutes apart genuinely overlapping would mean something's already
// badly wrong with the network, not something worth more machinery here.
let CHECK_IN_PROGRESS = false;

/* Every league, once: badges the toolbar icon with how many have a lineup
 * problem, and (when the owner has alerts on) notifies for any alert whose
 * key hasn't already fired. Nothing here should ever throw past this
 * function - a missed check beats a broken background page. */
async function runCheck() {
  if (CHECK_IN_PROGRESS) return;
  CHECK_IN_PROGRESS = true;
  try {
    const { sleeperUser } = await chrome.storage.sync.get("sleeperUser");
    if (!sleeperUser) {
      // No username set (or it was cleared in options) - nothing to
      // track, so the badge shouldn't keep showing a stale count from
      // whenever one was last configured.
      if (chrome.action) chrome.action.setBadgeText({ text: "" });
      return;
    }
    const { sleeperAlerts } = await chrome.storage.sync.get("sleeperAlerts");
    const alertsOn = sleeperAlerts !== false;   // default on

    const loader = createLoader({ storage });
    const data = await loader.loadData();
    const user = await loader.fetchUser(sleeperUser);
    if (!user) return;
    const leagues = await loader.fetchLeagues(user.user_id, data.leagueSeason);

    const alerted = await loadAlerted();
    let badLineups = 0;

    for (const lg of leagues) {
      let view;
      try { view = await loader.buildLeagueView(lg, user, data); }
      catch (e) { continue; }   // one bad league shouldn't cost the rest
      if (!view) continue;
      if (view.check && !view.check.ok) badLineups++;
      if (!alertsOn) continue;

      for (const a of alertsFor(view)) {
        if (alerted[a.key]) continue;
        try {
          // Awaited (not fired-and-forgotten): notifications.create()
          // returns a promise in MV3, and an async rejection from it
          // (permission revoked, a bad icon fetch, ...) would otherwise
          // slip past the try/catch below, which only sees synchronous
          // throws - and this alert would still get marked as shown.
          await chrome.notifications.create(a.key, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
            title: a.title,
            message: a.message,
          });
        } catch (e) { /* notifications permission or API missing */ }
        alerted[a.key] = { url: a.url, at: Date.now() };
      }
    }

    // Prune keys from past weeks - a key's week segment is the same NFL
    // week for every league this run (data.week), so anything else is
    // stale; weeks only move forward, so there's no "future week" to keep.
    const weekStr = String(data.week);
    for (const key in alerted) {
      if (key.split(":")[1] !== weekStr) delete alerted[key];
    }
    await storage.setItem(ALERTED_KEY, JSON.stringify(alerted));

    if (chrome.action) {
      chrome.action.setBadgeText({ text: badLineups > 0 ? String(badLineups) : "" });
      chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    }
  } catch (e) {
    // Fail silently - a missed check beats a broken background page. The
    // badge is deliberately left as it was: a transient failure (a flaky
    // fetch, a bad response) doesn't mean the leagues are actually fine
    // now, so keeping the last known count is more honest than clearing
    // it to blank.
  } finally {
    CHECK_IN_PROGRESS = false;
  }
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) return runCheck();
  });
}

// A notification's id is its alert key, which `alerted[key].url` (the same
// map runCheck just wrote) maps back to the league's Sleeper team page.
if (chrome.notifications) {
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    try {
      const alerted = await loadAlerted();
      const entry = alerted[notificationId];
      if (entry && entry.url) chrome.tabs.create({ url: entry.url });
    } catch (e) { /* ignore */ }
  });
}
