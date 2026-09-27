/* Settings page: the Sleeper username (same chrome.storage.sync key the
 * side panel's first-run field uses - either one sets it for both) and
 * whether the background check (bg.js) should show a desktop notification
 * for a ruled-out starter, on by default. */
const userInput = document.getElementById("user");
const alertsInput = document.getElementById("alerts");
const status = document.getElementById("status");

async function load() {
  const { sleeperUser, sleeperAlerts } = await chrome.storage.sync.get(["sleeperUser", "sleeperAlerts"]);
  if (sleeperUser) userInput.value = sleeperUser;
  alertsInput.checked = sleeperAlerts !== false;   // default on
}

document.getElementById("save").addEventListener("click", async () => {
  const user = userInput.value.trim();
  await chrome.storage.sync.set({ sleeperUser: user, sleeperAlerts: alertsInput.checked });
  status.textContent = "Saved.";
  setTimeout(() => { status.textContent = ""; }, 2000);
});

load();
