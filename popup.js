import { createStore, INBOX_ID, isSupportedUrl, STORAGE_KEY, collectionTree } from "./storage.js";

const store = createStore({ storage: chrome.storage.local, locks: navigator.locks });
const title = document.querySelector("#page-title");
const url = document.querySelector("#page-url");
const collection = document.querySelector("#collection");
const save = document.querySelector("#save");
const status = document.querySelector("#status");
let currentTab;
let libraryReady = false;
let saving = false;

function message(text, type = "error") {
  status.textContent = text;
  status.className = type;
}

function updateControls() {
  collection.disabled = !libraryReady || saving;
  save.disabled = !libraryReady || saving || !isSupportedUrl(currentTab?.url);
}

async function loadCollections() {
  try {
    const library = await store.read();
    const selected = collection.value || INBOX_ID;
    collection.replaceChildren();
    for (const item of collectionTree(library)) {
      collection.add(new Option(item.path, item.id));
    }
    collection.value = library.collections.some((item) => item.id === selected) ? selected : INBOX_ID;
    libraryReady = true;
  } catch (error) {
    libraryReady = false;
    message(`Could not load your library: ${error.message}`);
  }
  updateControls();
}

document.querySelector("#save-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || !libraryReady || !isSupportedUrl(currentTab?.url)) return;
  saving = true;
  updateControls();
  try {
    const result = await store.save(currentTab.url, currentTab.title, collection.value);
    message(result.status === "duplicate"
      ? `Already saved in ${result.collection}.`
      : `Saved to ${result.collection}. You can close this tab when you're ready.`, "success");
  } catch (error) {
    message(`Could not save this link: ${error.message}`);
  } finally {
    saving = false;
    updateControls();
  }
});

document.querySelector("#open-library").addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
  } catch (error) {
    message(`Could not open the library: ${error.message}`);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && STORAGE_KEY in changes) void loadCollections();
});

async function initialize() {
  await loadCollections();
  try {
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    title.textContent = currentTab?.title || "Page unavailable";
    url.textContent = currentTab?.url || "";
    if (!isSupportedUrl(currentTab?.url)) {
      message("This page cannot be saved. Open an ordinary HTTP or HTTPS page and try again.");
    }
  } catch (error) {
    title.textContent = "Page unavailable";
    message(`Could not read the current tab: ${error.message}`);
  }
  updateControls();
}

void initialize();
