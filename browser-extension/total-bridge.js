function findRefreshToken() {
  const candidates = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const value = storage.getItem(key) || "";
      if (/refresh[_-]?token/i.test(key) && value.length > 20) candidates.push(value);
      try {
        const parsed = JSON.parse(value);
        const visit = (item) => {
          if (!item || typeof item !== "object") return;
          for (const [name, child] of Object.entries(item)) {
            if (/refresh[_-]?token/i.test(name) && typeof child === "string" && child.length > 20) candidates.push(child);
            else visit(child);
          }
        };
        visit(parsed);
      } catch {}
    }
  }
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function reportSession() {
  const refreshToken = findRefreshToken();
  if (refreshToken) chrome.runtime.sendMessage({ type: "TOTAL_SESSION", refreshToken });
}

window.addEventListener("storage", reportSession);
document.addEventListener("visibilitychange", reportSession);
setInterval(reportSession, 2500);
reportSession();
