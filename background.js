// Fanout – Background Service Worker

// ─── CHROME: auto-open side panel on icon click ───────────────────────────────
// Using bracket notation so Firefox's static linter doesn't flag the sidePanel API name.
const sidePanel = chrome['sidePanel'];
if (sidePanel?.setPanelBehavior) {
  sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// ─── FIREFOX: no sidePanel API — open as a new tab instead ───────────────────
if (!sidePanel) {
  chrome.action.onClicked.addListener((tab) => {
    chrome.storage.local.set({ fanout_sourceTabId: tab.id });
    chrome.tabs.create({
      url: chrome.runtime.getURL('panel.html') + '?tabId=' + tab.id,
    });
  });
}

// ─── MESSAGE BUS ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'fetchConversation') {
    // The panel sends no tabId — background finds the right tab itself.
    handleFetch().then(sendResponse).catch(err =>
      sendResponse({ success: false, error: err.message })
    );
    return true;
  }

  if (msg.action === 'setBadge') {
    chrome.action.setBadgeText({ text: String(msg.count || ''), tabId: msg.tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#0e7490', tabId: msg.tabId });
    return false;
  }
});

// ─── FETCH CONVERSATION ───────────────────────────────────────────────────────
async function handleFetch() {
  // From the background, lastFocusedWindow reliably finds the ChatGPT tab
  // next to the side panel — no ambiguity about "current window" context.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  let tab = activeTab;

  // If the active tab isn't a ChatGPT conversation, search all open tabs
  const isChatGPT = t => t?.url?.includes('chatgpt.com') || t?.url?.includes('chat.openai.com');
  const hasConv   = t => t?.url?.includes('/c/');

  if (!isChatGPT(tab) || !hasConv(tab)) {
    const all = await chrome.tabs.query({});
    tab = all.find(t => isChatGPT(t) && hasConv(t)) ?? null;
  }

  if (!tab) {
    return { success: false, error: 'No ChatGPT conversation found. Open a conversation (URL should contain /c/) and click Analyze.' };
  }

  if (!hasConv(tab)) {
    return { success: false, error: 'Navigate to a ChatGPT conversation first — the URL should contain /c/.' };
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const cid = location.pathname.match(/\/c\/([^/]+)/)?.[1];
        if (!cid) return { success: false, error: 'Could not find conversation ID in URL.' };

        try {
          const sessionResp = await fetch('/api/auth/session');
          if (!sessionResp.ok) return { success: false, error: 'Failed to retrieve session. Are you logged in?' };
          const session = await sessionResp.json();
          if (!session?.accessToken) return { success: false, error: 'No access token found. Please log in to ChatGPT.' };

          const convResp = await fetch(`/backend-api/conversation/${cid}`, {
            headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
          });

          if (convResp.status === 401) return { success: false, error: 'Session expired. Refresh the ChatGPT tab and try again.' };
          if (convResp.status === 429) return { success: false, error: 'Rate limited. Wait a moment and try again.' };
          if (!convResp.ok)           return { success: false, error: `ChatGPT API error: HTTP ${convResp.status}` };

          const data = await convResp.json();
          return { success: true, cid, data };
        } catch (e) {
          return { success: false, error: `Fetch failed: ${e.message}` };
        }
      },
    });
  } catch (e) {
    return { success: false, error: `Script injection failed: ${e.message}` };
  }

  const result = results?.[0]?.result ?? { success: false, error: 'Unexpected script error.' };
  // Include the tabId so the panel can update the toolbar badge
  if (result.success) result.tabId = tab.id;
  return result;
}
