const API = "https://delta-carburant-api.onrender.com/api/v1";
let pending = null;

function extractRefreshToken(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return extractRefreshToken(JSON.parse(value)); } catch { return null; }
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (/refresh[_-]?token/i.test(key) && typeof child === "string" && child.length > 20) return child;
    const nested = extractRefreshToken(child);
    if (nested) return nested;
  }
  return null;
}

function notifyApp(message) {
  if (!pending?.appTabId) return;
  chrome.tabs.sendMessage(pending.appTabId, { source: "delta-total-extension", ...message }).catch(() => undefined);
}

async function finishIfReady() {
  if (!pending?.accessToken || (!pending?.refreshToken && !pending?.totalAccessToken) || pending.finishing) return;
  pending.finishing = true;
  try {
    if (pending.totalTabId) {
      try { await chrome.debugger.detach({ tabId: pending.totalTabId }); } catch {}
    }
    notifyApp({ type: "STATUS", message: "Session détectée. Connexion et extraction en cours…" });
    if (pending.refreshToken) {
      const response = await fetch(`${API}/total-mobility/reconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${pending.accessToken}` },
        body: JSON.stringify({ refreshToken: pending.refreshToken })
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "Connexion Total refusée");
    }
    const sync = await fetch(`${API}/total-mobility/${pending.totalAccessToken ? "sync-session" : "sync"}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pending.accessToken}` },
      body: JSON.stringify({ fromDate: "2026-08-01", accessToken: pending.totalAccessToken })
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

async function watchTotalAuthentication(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
    await chrome.debugger.sendCommand(target, "Network.enable");
  } catch (error) {
    notifyApp({ type: "STATUS", message: "Total est ouvert. Détection sécurisée de la session en cours…" });
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!pending || source.tabId !== pending.totalTabId) return;
  if (method === "Network.requestWillBeSent" || method === "Network.requestWillBeSentExtraInfo") {
    const headers = params?.request?.headers || params?.headers || {};
    const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
    if (typeof authorization === "string" && authorization.replace(/^Bearer\s+/i, "").length > 100) {
      pending.totalAccessToken = authorization.replace(/^Bearer\s+/i, "");
      void finishIfReady();
    }
    return;
  }
  if (method !== "Network.responseReceived") return;
  const response = params?.response;
  if (!response || !/(?:oauth|connect|token|login)/i.test(response.url || "")) return;
  try {
    const body = await chrome.debugger.sendCommand(source, "Network.getResponseBody", { requestId: params.requestId });
    const refreshToken = extractRefreshToken(body?.body);
    if (!refreshToken) return;
    pending.refreshToken = refreshToken;
    try { await chrome.debugger.detach(source); } catch {}
    void finishIfReady();
  } catch {}
});

chrome.debugger.onDetach.addListener((source) => {
  if (pending?.totalTabId === source.tabId && !pending.refreshToken) {
    notifyApp({ type: "STATUS", message: "Détection Total interrompue. Revenez au portail puis actualisez la page." });
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "START_RECONNECT") {
    pending = { accessToken: message.accessToken, appTabId: sender.tab?.id, finishing: false };
    notifyApp({ type: "STATUS", message: "Ouverture de Total… Connectez-vous si le portail le demande." });
    chrome.tabs.create({ url: "about:blank", active: true }).then(async (tab) => {
      if (!pending || !tab.id) return;
      pending.totalTabId = tab.id;
      await watchTotalAuthentication(tab.id);
      await chrome.tabs.update(tab.id, { url: "https://customer.fleet.totalenergies.com/tn/" });
    });
  }
  if (message?.type === "TOTAL_SESSION" && pending) {
    pending.refreshToken = message.refreshToken;
    void finishIfReady();
  }
});
