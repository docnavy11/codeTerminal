const $ = (id) => document.getElementById(id);
const DEFAULT_URL = "";

async function paint() {
  const s = await chrome.storage.local.get({ enabled: true, serverUrl: DEFAULT_URL });
  $("url").value = s.serverUrl;
  $("toggle").textContent = s.enabled ? "Turn off" : "Turn on";
  $("toggle").className = s.enabled ? "off" : "on";
  const badge = await chrome.action.getBadgeText({});
  const live = badge === "on";
  $("dot").classList.toggle("on", live);
  $("state").textContent = !s.serverUrl ? "not configured" : !s.enabled ? "disabled" : live ? "connected" : "connecting…";
  $("note").textContent = !s.serverUrl
    ? "Enter your server's /ext address, e.g. ws://127.0.0.1:8123/ext, then press Enter."
    : "Claude can read and drive every tab while this is on.";
}

$("toggle").onclick = async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  await chrome.storage.local.set({ enabled: !enabled });
  setTimeout(paint, 250);
};

// Saved as you type (debounced) and on Enter — not only on blur, which never
// fires if the popup is closed straight after typing.
let saveTimer = null;
async function save() {
  clearTimeout(saveTimer); saveTimer = null;
  const v = $("url").value.trim();
  await chrome.storage.local.set({ serverUrl: v || DEFAULT_URL, enabled: true });
  setTimeout(paint, 250);
}
$("url").oninput = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };
$("url").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } };
$("url").onchange = save;

paint();
setInterval(paint, 1500);
