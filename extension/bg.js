/* MV3 background: opens the panel on the toolbar icon click.
 *
 * Chrome has a real side panel API and no click event is needed once panel
 * behavior is set. Firefox has no side_panel API, so the toolbar icon click
 * toggles its sidebar instead. Both branches are feature-detected so one
 * file works unmodified as Chrome's service worker and Firefox's background
 * script (the manifest sets both `background.service_worker` and
 * `background.scripts` to this file; each browser ignores the field it
 * doesn't understand). */

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
