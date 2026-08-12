window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "delta-carburant") return;
  if (event.data.type !== "RECONNECT_TOTAL") return;
  const accessToken = sessionStorage.getItem("delta_access");
  if (!accessToken) {
    window.postMessage({ source: "delta-total-extension", type: "ERROR", message: "Reconnectez-vous d’abord à Delta Carburant." }, "*");
    return;
  }
  chrome.runtime.sendMessage({ type: "START_RECONNECT", accessToken, appTabUrl: location.href });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.source !== "delta-total-extension") return;
  window.postMessage(message, "*");
});
