import { createStore, INBOX_ID, STORAGE_KEY, matchesSearch, collectionTree, collectionSnapshot } from "./storage.js";

const store = createStore({ storage: chrome.storage.local, locks: navigator.locks });
const collections = document.querySelector("#collections");
const entries = document.querySelector("#entries");
const search = document.querySelector("#search");
const status = document.querySelector("#status");
const title = document.querySelector("#view-title");
const count = document.querySelector("#count");
const deleteCollection = document.querySelector("#delete-collection");
const detailsDialog = document.querySelector("#details-dialog");
const detailsForm = document.querySelector("#details-form");
const descriptionInput = document.querySelector("#description");
const tagsInput = document.querySelector("#tags");
const detailsStatus = document.querySelector("#details-status");
const saveDetails = document.querySelector("#save-details");
const cancelDetails = document.querySelector("#cancel-details");
const parentInput = document.querySelector("#collection-parent");
const moveCollectionForm = document.querySelector("#move-collection");
const newParentInput = document.querySelector("#new-parent");
const collapsed = new Set();
let editingId;
let savingDetails = false;
let library;
let selected = null;
let refreshNumber = 0;

function message(text, type = "error") {
  status.textContent = text;
  status.className = type;
}

function button(text, className, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.className = className;
  element.addEventListener("click", action);
  return element;
}

async function perform(operation, success) {
  try {
    await operation();
    await refresh();
    message(success, "success");
  } catch (error) {
    message(`Could not update the library: ${error.message}`);
  }
}

function renderCollections() {
  collections.replaceChildren();
  const tree = collectionTree(library);
  const hidden = new Set();
  const items = [{ id: null, name: "All links", path: "All links", depth: 0 }, ...tree];
  for (const item of items) {
    if (item.parentId && (collapsed.has(item.parentId) || hidden.has(item.parentId))) {
      hidden.add(item.id);
      continue;
    }
    const row = document.createElement("div");
    row.className = "collection-row";
    row.style.marginLeft = `${item.depth * 14}px`;
    if (library.collections.some((c) => c.parentId === item.id) && item.id !== null) {
      const toggle = button(collapsed.has(item.id) ? "+" : "-", "tree-toggle", () => {
        if (collapsed.has(item.id)) collapsed.delete(item.id);
        else collapsed.add(item.id);
        renderCollections();
      });
      toggle.setAttribute("aria-expanded", String(!collapsed.has(item.id)));
      toggle.setAttribute("aria-label", `Expand or collapse ${item.path}`);
      row.append(toggle);
    }
    const choose = button(item.name, item.id === selected ? "collection-choice selected" : "collection-choice", () => {
      selected = item.id;
      render();
    });
    if (item.id === selected) choose.setAttribute("aria-current", "page");
    choose.title = item.path;
    choose.setAttribute("aria-label", item.path);
    row.append(choose);
    if (item.id !== null && item.id !== INBOX_ID) {
      const rename = button("Rename", "rename-collection", () => {
        const name = window.prompt("Rename collection:", item.name);
        if (name !== null) void perform(() => store.renameCollection(item.id, name), "Collection renamed.");
      });
      rename.setAttribute("aria-label", `Rename ${item.path}`);
      row.append(rename);
    }
    collections.append(row);
  }
  const previous = parentInput.value;
  parentInput.replaceChildren(new Option("Top level", ""));
  for (const item of tree) {
    if (item.id !== INBOX_ID) parentInput.add(new Option(item.path, item.id));
  }
  parentInput.value = tree.some((item) => item.id === previous && item.id !== INBOX_ID) ? previous : "";
  moveCollectionForm.hidden = selected === null || selected === INBOX_ID;
  if (!moveCollectionForm.hidden) {
    const subtree = new Set(collectionSnapshot(library, selected).collections.map(([id]) => id));
    newParentInput.replaceChildren(new Option("Top level", ""));
    for (const item of tree) {
      if (item.id !== INBOX_ID && !subtree.has(item.id)) newParentInput.add(new Option(item.path, item.id));
    }
    newParentInput.value = library.collections.find((c) => c.id === selected).parentId ?? "";
  }
}

function renderEntries() {
  const query = search.value.toLowerCase();
  const visible = library.entries.filter((entry) =>
    (selected === null || entry.collectionId === selected) &&
    matchesSearch(entry, query)
  ).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const tree = collectionTree(library);
  title.textContent = selected === null ? "All links" : tree.find((item) => item.id === selected).path;
  deleteCollection.hidden = selected === null;
  deleteCollection.textContent = selected === INBOX_ID ? "Clear Inbox" : "Delete collection";
  count.textContent = `${visible.length} ${visible.length === 1 ? "link" : "links"}`;
  entries.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? "No links match your search." : "No links here yet.";
    entries.append(empty);
    return;
  }
  for (const entry of visible) {
    const card = document.createElement("article");
    card.className = "card entry";
    const link = document.createElement("a");
    link.className = "entry-title";
    link.textContent = entry.title;
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const address = document.createElement("p");
    address.className = "url";
    address.textContent = entry.url;
    const description = document.createElement("p");
    description.className = "description";
    description.textContent = entry.description ?? "";
    description.hidden = !entry.description;
    const tags = document.createElement("div");
    tags.className = "tags";
    for (const tag of entry.tags ?? []) {
      const badge = document.createElement("span");
      badge.className = "tag";
      badge.textContent = tag;
      tags.append(badge);
    }
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${tree.find((item) => item.id === entry.collectionId).path} · Saved ${new Date(entry.savedAt).toLocaleString()}`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const rename = button("Edit title", "secondary", () => {
      const value = window.prompt("Edit saved title:", entry.title);
      if (value !== null) void perform(() => store.renameEntry(entry.id, value), "Title updated.");
    });
    rename.setAttribute("aria-label", `Edit title for ${entry.title}`);
    const moveLabel = document.createElement("label");
    moveLabel.textContent = "Move to";
    const move = document.createElement("select");
    move.setAttribute("aria-label", `Move ${entry.title} to collection`);
    for (const item of tree) move.add(new Option(item.path, item.id));
    move.value = entry.collectionId;
    move.addEventListener("change", () => {
      void perform(() => store.moveEntry(entry.id, move.value), "Link moved.").then(() => {
        if (move.isConnected) move.value = entry.collectionId;
      });
    });
    moveLabel.append(move);
    const remove = button("Delete", "danger", () => {
      if (window.confirm(`Delete “${entry.title}” from your library?`)) {
        void perform(() => store.deleteEntry(entry.id), "Link deleted.");
      }
    });
    remove.setAttribute("aria-label", `Delete ${entry.title}`);
    const details = button("Edit details", "secondary", () => {
      editingId = entry.id;
      document.querySelector("#details-title").textContent = entry.title;
      descriptionInput.value = entry.description ?? "";
      tagsInput.value = (entry.tags ?? []).join(", ");
      detailsStatus.textContent = "";
      detailsDialog.showModal();
      descriptionInput.focus();
    });
    details.setAttribute("aria-label", `Edit details for ${entry.title}`);
    actions.append(rename, details, moveLabel, remove);
    card.append(link, address, description, tags, meta, actions);
    entries.append(card);
  }
}

cancelDetails.addEventListener("click", () => detailsDialog.close());
detailsDialog.addEventListener("cancel", (event) => {
  if (savingDetails) event.preventDefault();
});
detailsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingDetails) return;
  savingDetails = true;
  saveDetails.disabled = true;
  cancelDetails.disabled = true;
  descriptionInput.disabled = true;
  tagsInput.disabled = true;
  detailsStatus.textContent = "";
  try {
    await store.updateDetails(editingId, descriptionInput.value, tagsInput.value);
    detailsDialog.close();
    await refresh();
    message("Link details updated.", "success");
  } catch (error) {
    const text = `Could not update link details: ${error.message}`;
    if (detailsDialog.open) detailsStatus.textContent = text;
    else message(text);
  } finally {
    savingDetails = false;
    saveDetails.disabled = false;
    cancelDetails.disabled = false;
    descriptionInput.disabled = false;
    tagsInput.disabled = false;
  }
});

deleteCollection.addEventListener("click", async () => {
  if (selected === null) return;
  const id = selected;
  const collection = library.collections.find((item) => item.id === id);
  const confirmedIds = library.entries.filter((entry) => entry.collectionId === id).map((entry) => entry.id);
  const snapshot = collectionSnapshot(library, id);
  const path = collectionTree(library).find((item) => item.id === collection.id).path;
  const action = id === INBOX_ID ? "Clear Inbox" : `Delete "${path}", including ${snapshot.collections.length - 1} subcollections`;
  if (!window.confirm(`${action} and permanently delete ${snapshot.entries.length} links? There is no undo or backup.${id === INBOX_ID ? " Inbox itself will remain." : ""}`)) return;
  deleteCollection.disabled = true;
  try {
    if (id === INBOX_ID) await store.clearInbox(confirmedIds);
    else await store.deleteCollection(id, snapshot);
    if (selected === id && id !== INBOX_ID) selected = null;
    await refresh();
    message(id === INBOX_ID ? "Inbox cleared." : "Collection and its links deleted.", "success");
  } catch (error) {
    try {
      await refresh();
    } catch (refreshError) {
      message(`Could not update the library: ${error.message} Could not refresh: ${refreshError.message}`);
      return;
    }
    message(`Could not update the library: ${error.message}`);
  } finally {
    deleteCollection.disabled = false;
  }
});

function render() {
  renderCollections();
  renderEntries();
}

async function refresh() {
  const request = ++refreshNumber;
  const next = await store.read();
  if (request !== refreshNumber) return;
  const previousAncestors = ancestors(library, selected);
  library = next;
  if (selected !== null && !library.collections.some((item) => item.id === selected)) selected = null;
  if (JSON.stringify(previousAncestors) !== JSON.stringify(ancestors(library, selected))) revealSelected();
  render();
}

function ancestors(data, id) {
  const byId = new Map((data?.collections ?? []).map((item) => [item.id, item]));
  const result = [];
  let parent = byId.get(id)?.parentId;
  while (parent) {
    result.push(parent);
    parent = byId.get(parent)?.parentId;
  }
  return result;
}

function revealSelected() {
  for (const parent of ancestors(library, selected)) collapsed.delete(parent);
}

moveCollectionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = selected;
  const parentId = newParentInput.value || null;
  await perform(() => store.moveCollection(id, parentId), "Collection moved.");
  revealSelected();
  renderCollections();
});

document.querySelector("#create-collection").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#collection-name");
  const name = input.value;
  try {
    const created = await store.createCollection(name, parentInput.value || null);
    selected = created.id;
    input.value = "";
    await refresh();
    revealSelected();
    renderCollections();
    message("Collection created.", "success");
  } catch (error) {
    message(`Could not create collection: ${error.message}`);
  }
});

search.addEventListener("input", () => { if (library) renderEntries(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && STORAGE_KEY in changes) {
    void refresh().catch((error) => message(`Could not load your library: ${error.message}`));
  }
});
void refresh().catch((error) => message(`Could not load your library: ${error.message}`));
