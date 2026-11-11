export const INBOX_ID = "inbox";
export const STORAGE_KEY = "library";
const LOCK_NAME = "better-bookmarks-library";

function emptyLibrary() {
  return { version: 2, collections: [{ id: INBOX_ID, name: "Inbox", parentId: null }], entries: [] };
}

function validString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSupportedUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function nameKey(name) {
  return name.trim().toLowerCase();
}

export function parseTags(value) {
  if (typeof value !== "string") throw new Error("Enter tags separated by commas.");
  const seen = new Set();
  return value.split(",").map((tag) => tag.trim()).filter((tag) => {
    const key = nameKey(tag);
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchesSearch(entry, query) {
  const text = query.toLowerCase();
  return [entry.title, entry.url, entry.description ?? "", ...(entry.tags ?? [])]
    .some((value) => value.toLowerCase().includes(text));
}

export function collectionTree(library) {
  const children = new Map();
  for (const collection of library.collections) {
    const parent = collection.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(collection);
  }
  const roots = children.get(null) ?? [];
  const stack = [...roots.filter((c) => c.id === INBOX_ID), ...roots.filter((c) => c.id !== INBOX_ID)]
    .reverse().map((collection) => ({ collection, depth: 0, path: collection.name }));
  const result = [];
  while (stack.length) {
    const item = stack.pop();
    result.push({ ...item.collection, depth: item.depth, path: item.path });
    const nested = children.get(item.collection.id) ?? [];
    for (let i = nested.length - 1; i >= 0; i--) {
      stack.push({ collection: nested[i], depth: item.depth + 1, path: `${item.path} / ${nested[i].name}` });
    }
  }
  return result;
}

export function collectionSnapshot(library, id) {
  const included = new Set([id]);
  const nodes = [];
  for (const collection of collectionTree(library)) {
    if (included.has(collection.id) || included.has(collection.parentId)) {
      included.add(collection.id);
      nodes.push([collection.id, collection.parentId ?? null]);
    }
  }
  return {
    collections: nodes.sort(([a], [b]) => a.localeCompare(b)),
    entries: library.entries.filter((entry) => included.has(entry.collectionId))
      .map((entry) => [entry.id, entry.collectionId]).sort(([a], [b]) => a.localeCompare(b))
  };
}

export function validateLibrary(data) {
  const invalid = () => { throw new Error("The saved library is invalid or uses an unsupported version. Existing data was not changed."); };
  if (!data || typeof data !== "object" || ![1, 2].includes(data.version) ||
      !Array.isArray(data.collections) || !Array.isArray(data.entries)) invalid();
  if (data.version === 1) {
    data = { ...data, version: 2, collections: data.collections.map((c) => ({ ...c, parentId: null })) };
  }
  const ids = new Set();
  const names = new Map();
  for (const collection of data.collections) {
    if (!collection || !validString(collection.id) || !validString(collection.name) ||
        collection.name !== collection.name.trim() || ids.has(collection.id) ||
        !(collection.parentId === null || validString(collection.parentId))) invalid();
    if (!names.has(collection.parentId)) names.set(collection.parentId, new Set());
    if (names.get(collection.parentId).has(nameKey(collection.name))) invalid();
    ids.add(collection.id);
    names.get(collection.parentId).add(nameKey(collection.name));
  }
  if (!data.collections.some((c) => c.id === INBOX_ID && c.name === "Inbox" && c.parentId === null)) invalid();
  for (const collection of data.collections) {
    if (collection.parentId !== null && (!ids.has(collection.parentId) || collection.parentId === INBOX_ID)) invalid();
  }
  if (collectionTree(data).length !== data.collections.length) invalid();
  const entryIds = new Set();
  const urls = new Set();
  for (const entry of data.entries) {
    if (!entry || !validString(entry.id) || entryIds.has(entry.id) ||
        !isSupportedUrl(entry.url) || urls.has(entry.url) || !validString(entry.title) ||
        !ids.has(entry.collectionId) || typeof entry.savedAt !== "string" ||
        !Number.isFinite(Date.parse(entry.savedAt))) invalid();
    if (entry.description !== undefined && typeof entry.description !== "string") invalid();
    if (entry.tags !== undefined) {
      if (!Array.isArray(entry.tags) ||
          entry.tags.some((tag) => !validString(tag) || tag !== tag.trim() || tag.includes(",")) ||
          new Set(entry.tags.map(nameKey)).size !== entry.tags.length) invalid();
    }
    entryIds.add(entry.id);
    urls.add(entry.url);
  }
  return data;
}

export function createStore({ storage, locks, uuid = () => crypto.randomUUID(), now = () => new Date().toISOString() }) {
  async function read() {
    const result = await storage.get(STORAGE_KEY);
    return result[STORAGE_KEY] === undefined ? emptyLibrary() : validateLibrary(result[STORAGE_KEY]);
  }

  async function mutate(operation) {
    if (!locks || typeof locks.request !== "function") {
      throw new Error("This browser cannot safely coordinate library changes. No changes were saved.");
    }
    return locks.request(LOCK_NAME, async () => {
      const library = await read();
      const result = operation(library);
      if (result.changed) {
        validateLibrary(library);
        await storage.set({ [STORAGE_KEY]: library });
      }
      return result.value;
    });
  }

  function requireCollection(library, id) {
    const collection = library.collections.find((item) => item.id === id);
    if (!collection) throw new Error("That collection no longer exists. Refresh and try again.");
    return collection;
  }

  function requireEntry(library, id) {
    const entry = library.entries.find((item) => item.id === id);
    if (!entry) throw new Error("That link no longer exists. Refresh and try again.");
    return entry;
  }

  function checkedName(library, name, parentId, exceptId) {
    if (typeof name !== "string" || !name.trim()) throw new Error("Enter a collection name.");
    const trimmed = name.trim();
    if (library.collections.some((item) => item.id !== exceptId && item.parentId === parentId && nameKey(item.name) === nameKey(trimmed))) {
      throw new Error("A collection with that name already exists.");
    }
    return trimmed;
  }

  function removeCollectionEntries(library, id, confirmedIds) {
    requireCollection(library, id);
    const currentIds = library.entries.filter((entry) => entry.collectionId === id).map((entry) => entry.id);
    if (!Array.isArray(confirmedIds) || confirmedIds.length !== currentIds.length ||
        new Set(confirmedIds).size !== confirmedIds.length ||
        currentIds.some((entryId) => !confirmedIds.includes(entryId))) {
      throw new Error("The collection's links changed. Review the library and confirm again.");
    }
    library.entries = library.entries.filter((entry) => entry.collectionId !== id);
  }

  return {
    read,
    save(url, title, collectionId) {
      return mutate((library) => {
        if (!isSupportedUrl(url)) throw new Error("Only ordinary HTTP and HTTPS pages can be saved.");
        const existing = library.entries.find((entry) => entry.url === url);
        if (existing) return { changed: false, value: { status: "duplicate", collection: collectionTree(library).find((c) => c.id === existing.collectionId).path } };
        requireCollection(library, collectionId);
        const entry = { id: uuid(), url, title: validString(title) ? title.trim() : url, collectionId, savedAt: now() };
        library.entries.push(entry);
        return { changed: true, value: { status: "saved", collection: collectionTree(library).find((c) => c.id === collectionId).path } };
      });
    },
    createCollection(name, parentId = null) {
      return mutate((library) => {
        if (parentId === INBOX_ID) throw new Error("Inbox cannot contain collections.");
        if (parentId !== null) requireCollection(library, parentId);
        const collection = { id: uuid(), name: checkedName(library, name, parentId), parentId };
        library.collections.push(collection);
        return { changed: true, value: collection };
      });
    },
    renameCollection(id, name) {
      return mutate((library) => {
        if (id === INBOX_ID) throw new Error("Inbox cannot be renamed.");
        const collection = requireCollection(library, id);
        collection.name = checkedName(library, name, collection.parentId, id);
        return { changed: true, value: collection };
      });
    },
    moveCollection(id, parentId) {
      return mutate((library) => {
        if (id === INBOX_ID) throw new Error("Inbox cannot be moved.");
        const collection = requireCollection(library, id);
        if (parentId === INBOX_ID) throw new Error("Inbox cannot contain collections.");
        if (parentId !== null) requireCollection(library, parentId);
        const subtree = collectionSnapshot(library, id);
        if (subtree.collections.some(([childId]) => childId === parentId)) throw new Error("A collection cannot be moved into itself or a descendant.");
        checkedName(library, collection.name, parentId, id);
        collection.parentId = parentId;
        return { changed: true };
      });
    },
    renameEntry(id, title) {
      return mutate((library) => {
        if (!validString(title)) throw new Error("Enter a title for the link.");
        requireEntry(library, id).title = title.trim();
        return { changed: true };
      });
    },
    updateDetails(id, description, tagsText) {
      return mutate((library) => {
        if (typeof description !== "string") throw new Error("Enter a text description.");
        const tags = parseTags(tagsText);
        const entry = requireEntry(library, id);
        entry.description = description.trim();
        entry.tags = tags;
        return { changed: true };
      });
    },
    deleteCollection(id, confirmedSnapshot) {
      return mutate((library) => {
        if (id === INBOX_ID) throw new Error("Inbox cannot be deleted. Clear its links instead.");
        requireCollection(library, id);
        const current = collectionSnapshot(library, id);
        if (JSON.stringify(current) !== JSON.stringify(confirmedSnapshot)) {
          throw new Error("The collection's links or subcollections changed. Review the library and confirm again.");
        }
        const removed = new Set(current.collections.map(([collectionId]) => collectionId));
        library.entries = library.entries.filter((entry) => !removed.has(entry.collectionId));
        library.collections = library.collections.filter((collection) => !removed.has(collection.id));
        return { changed: true };
      });
    },
    clearInbox(confirmedIds) {
      return mutate((library) => {
        removeCollectionEntries(library, INBOX_ID, confirmedIds);
        return { changed: true };
      });
    },
    moveEntry(id, collectionId) {
      return mutate((library) => {
        requireCollection(library, collectionId);
        requireEntry(library, id).collectionId = collectionId;
        return { changed: true };
      });
    },
    deleteEntry(id) {
      return mutate((library) => {
        requireEntry(library, id);
        library.entries = library.entries.filter((entry) => entry.id !== id);
        return { changed: true };
      });
    }
  };
}
