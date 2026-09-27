/* Side panel: an iframe of the real site. There's no second UI to maintain
 * here - a site fix reaches the extension without reinstalling it. The only
 * job of this file is the first-run username (kept in chrome.storage.sync so
 * it follows the person across machines) and forwarding the league id the
 * content script reports for the sleeper.com tab it's next to. */

const SITE_ORIGIN = "https://etanetan.github.io";
const SITE = `${SITE_ORIGIN}/sleeper-rankings/`;

const setup = document.getElementById("setup");
const frame = document.getElementById("frame");
const userInput = document.getElementById("user");

async function getUser() {
  const { sleeperUser } = await chrome.storage.sync.get("sleeperUser");
  return sleeperUser || null;
}

function frameUrl(user, leagueId) {
  const params = new URLSearchParams({ embed: "1" });
  if (user) params.set("user", user);
  if (leagueId) params.set("league", leagueId);
  return `${SITE}?${params.toString()}`;
}

async function showPanel(leagueId) {
  const user = await getUser();
  if (user) {
    setup.style.display = "none";
    frame.style.display = "block";
    frame.src = frameUrl(user, leagueId);
  } else {
    setup.style.display = "block";
    frame.style.display = "none";
  }
}

document.getElementById("go").addEventListener("click", async () => {
  const val = userInput.value.trim();
  if (!val) return;
  await chrome.storage.sync.set({ sleeperUser: val });
  showPanel();
});

// The content script on sleeper.com reports the league id whenever the tab
// navigates to a different league; forward it into the framed page so it
// switches leagues to match without the user re-picking it.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "sr-league") return;
  if (frame.contentWindow) {
    frame.contentWindow.postMessage(msg, SITE_ORIGIN);
  } else {
    showPanel(msg.id);
  }
});

showPanel();
