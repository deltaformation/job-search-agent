/* global chrome */
/**
 * Job Tracker Clipper — service worker.
 *
 * Click the toolbar button while viewing a posting: capture the tab's
 * rendered DOM (no cookies, no session access — the page you already
 * opened) and POST it to the local tracker with your clip token from the
 * options page. Badge shows OK, DUP, FAIL, or ERR.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

/**
 * Runs inside the tab via scripting.executeScript: only this function's own
 * source is serialized, so every value it needs is inlined below — it must
 * not reference worker-scope constants.
 */
function captureDom() {
  const html = document.documentElement.outerHTML;
  if (html.length > 5_000_000) {
    return { error: "page too large to clip" };
  }
  const selection = window.getSelection();
  const selectedText =
    selection === null ? "" : selection.toString().slice(0, 20_000);
  return {
    url: window.location.href,
    title: document.title,
    html,
    selectedText,
  };
}

async function setBadge(tabId, text, title) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
    if (text !== "") {
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: text === "OK" || text === "DUP" ? "#15803d" : "#b91c1c",
      });
    }
  } catch {
    // Badge failure must never break the clip itself.
  }
}

async function readSettings() {
  const stored = await chrome.storage.local.get(["clipToken", "baseUrl"]);
  const clipToken =
    typeof stored.clipToken === "string" ? stored.clipToken.trim() : "";
  let baseUrl =
    typeof stored.baseUrl === "string" && stored.baseUrl.trim() !== ""
      ? stored.baseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_BASE_URL;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
  } catch {
    baseUrl = DEFAULT_BASE_URL;
  }
  return { clipToken, baseUrl };
}

async function clipTab(tab) {
  if (tab?.id === undefined || tab.url === undefined) {
    return;
  }
  if (!/^https?:\/\//.test(tab.url)) {
    await setBadge(tab.id, "ERR", "Clip works on http(s) pages only");
    return;
  }
  const { clipToken, baseUrl } = await readSettings();
  if (clipToken === "") {
    await setBadge(tab.id, "?", "Set your clip token on the options page first");
    await chrome.runtime.openOptionsPage().catch(() => undefined);
    return;
  }
  await setBadge(tab.id, "…", "Clipping…");
  let captured;
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureDom,
    });
    captured = frame?.result;
  } catch (error) {
    await setBadge(tab.id, "ERR", `Capture failed: ${error.message}`);
    return;
  }
  if (captured === undefined || captured === null) {
    await setBadge(tab.id, "ERR", "Capture returned nothing");
    return;
  }
  if (typeof captured.error === "string") {
    await setBadge(tab.id, "ERR", captured.error);
    return;
  }
  let response;
  try {
    response = await fetch(`${baseUrl}/api/intake/clip`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${clipToken}`,
      },
      body: JSON.stringify(captured),
    });
  } catch (error) {
    await setBadge(
      tab.id,
      "ERR",
      `Tracker unreachable at ${baseUrl}: ${error.message}`,
    );
    return;
  }
  if (response.status === 401) {
    await setBadge(tab.id, "ERR", "Bad clip token — check the options page");
    return;
  }
  if (!response.ok) {
    await setBadge(tab.id, "ERR", `Clip rejected (${response.status})`);
    return;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    await setBadge(tab.id, "ERR", "Tracker returned invalid JSON");
    return;
  }
  if (result.outcome === "created") {
    await setBadge(tab.id, "OK", "Clipped to a NEW job card");
  } else if (result.outcome === "duplicate") {
    await setBadge(tab.id, "DUP", "Already tracked — opened nothing new");
  } else {
    const detail =
      typeof result.detail === "string" && result.detail !== ""
        ? result.detail
        : (result.reasonCode ?? "rejected");
    await setBadge(tab.id, "FAIL", `Clip rejected: ${detail}`);
  }
}

chrome.action.onClicked.addListener((tab) => {
  void clipTab(tab);
});
