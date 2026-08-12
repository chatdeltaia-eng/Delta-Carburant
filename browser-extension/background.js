const API = "https://delta-carburant-api.onrender.com/api/v1";
let pending = null;

function notifyApp(message) {
  if (!pending?.appTabId) return;
  chrome.tabs.sendMessage(pending.appTabId, { source: "delta-total-extension", ...message }).catch(() => undefined);
}

async function finishIfReady() {
  if (!pending?.accessToken || !pending?.refreshToken || pending.finishing) return;
  pending.finishing = true;
  try {
    notifyApp({ type: "STATUS", message: "Session détectée. Connexion et extraction en cours…" });
    const response = await fetch(`${API}/total-mobility/reconnect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pending.accessToken}` },
      body: JSON.stringify({ refreshToken: pending.refreshToken })
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "Connexion Total refusée");
    const sync = await fetch(`${API}/total-mobility/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pending.accessToken}` },
      body: JSON.stringify({ fromDate: "2026-08-01" })
    });
    if (!sync.ok) throw new Error("La connexion a réussi, mais l’extraction n’a pas pu démarrer.");
    const result = await sync.json();
    notifyApp({ type: "SUCCESS", message: `Total reconnecté : ${result.imported ?? 0} transaction(s) actualisée(s).` });
    pending = null;
  } catch (error) {
    pending.finishing = false;
    notifyApp({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "START_RECONNECT") {
    pending = { accessToken: message.accessToken, appTabId: sender.tab?.id, finishing: false };
    notifyApp({ type: "STATUS", message: "Ouverture de Total… Connectez-vous si le portail le demande." });
    chrome.tabs.create({ url: "https://customer.fleet.totalenergies.com/tn/", active: true });
  }
  if (message?.type === "TOTAL_SESSION" && pending) {
    pending.refreshToken = message.refreshToken;
    void finishIfReady();
  }
});
