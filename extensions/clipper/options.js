/* global chrome, document, fetch, URL */
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

const baseUrlInput = document.getElementById("baseUrl");
const tokenInput = document.getElementById("clipToken");
const statusLine = document.getElementById("status");

function setStatus(text) {
  statusLine.textContent = text;
}

function normalizedBaseUrl() {
  const raw = baseUrlInput.value.trim().replace(/\/+$/, "");
  const candidate = raw === "" ? DEFAULT_BASE_URL : raw;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base URL must be http(s)");
  }
  return candidate;
}

async function load() {
  const stored = await chrome.storage.local.get(["clipToken", "baseUrl"]);
  if (typeof stored.baseUrl === "string") {
    baseUrlInput.value = stored.baseUrl;
  } else {
    baseUrlInput.value = DEFAULT_BASE_URL;
  }
  if (typeof stored.clipToken === "string") {
    tokenInput.value = stored.clipToken;
  }
}

document.getElementById("save").addEventListener("click", async () => {
  try {
    const baseUrl = normalizedBaseUrl();
    await chrome.storage.local.set({
      baseUrl,
      clipToken: tokenInput.value.trim(),
    });
    baseUrlInput.value = baseUrl;
    setStatus("Saved.");
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
  }
});

document.getElementById("test").addEventListener("click", async () => {
  try {
    const baseUrl = normalizedBaseUrl();
    const response = await fetch(`${baseUrl}/api/health`, { method: "GET" });
    setStatus(
      response.ok
        ? `Tracker reachable at ${baseUrl}.`
        : `Tracker answered ${response.status} at ${baseUrl}.`,
    );
  } catch (error) {
    setStatus(`Tracker unreachable: ${error.message}`);
  }
});

void load();
