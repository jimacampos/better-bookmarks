import test from "node:test";
import assert from "node:assert/strict";
import { createStore, INBOX_ID, STORAGE_KEY, validateLibrary, matchesSearch, collectionTree, collectionSnapshot } from "../storage.js";

function harness(initial) {
  let data = initial === undefined ? {} : { [STORAGE_KEY]: structuredClone(initial) };
  let nextId = 0;
  let pending = Promise.resolve();
  let failure;
  const storage = {
    async get() { return structuredClone(data); },
    async set(value) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (failure) throw new Error(failure);
      data = { ...data, ...structuredClone(value) };
    }
  };
  const locks = {
    request(_name, fn) {
      const task = pending.then(fn);
      pending = task.catch(() => {});
      return task;
    }
  };
  return {
    storage,
    locks,
    store: createStore({ storage, locks, uuid: () => `id-${++nextId}`, now: () => "2026-01-02T03:04:05.000Z" }),
    failWrites(message) { failure = message; },
    snapshot() { return structuredClone(data); }
  };
}

test("saves exact URLs and reports existing collection for duplicates", async () => {
  const { store } = harness();
  const collection = await store.createCollection(" Work ");
  assert.deepEqual(await store.save("https://example.com/?q=1#one", " Example ", collection.id), { status: "saved", collection: "Work" });
  assert.deepEqual(await store.save("https://example.com/?q=1#one", "Other title", INBOX_ID), { status: "duplicate", collection: "Work" });
  await store.save("https://example.com/?q=2#one", "Query", INBOX_ID);
  await store.save("https://example.com/?q=1#two", "Fragment", INBOX_ID);
  const library = await store.read();
  assert.equal(library.entries.length, 3);
  assert.deepEqual(library.entries[0], {
    id: "id-2", title: "Example", url: "https://example.com/?q=1#one",
    collectionId: collection.id, savedAt: "2026-01-02T03:04:05.000Z"
  });
});

test("mutations preserve unrelated entries and validate collections", async () => {
  const { store } = harness();
  const work = await store.createCollection("Work");
  await assert.rejects(store.createCollection("  wOrK "), /already exists/);
  await assert.rejects(store.createCollection(" inbox "), /already exists/);
  await assert.rejects(store.renameCollection(INBOX_ID, "Other"), /cannot be renamed/);
  await store.save("https://one.example/", "One", INBOX_ID);
  await store.save("https://two.example/", "Two", INBOX_ID);
  const before = await store.read();
  const [one, two] = before.entries;
  await store.renameEntry(one.id, "New title");
  await store.moveEntry(one.id, work.id);
  await store.renameCollection(work.id, "Projects");
  const updated = await store.read();
  assert.equal(updated.entries[0].title, "New title");
  assert.equal(updated.entries[0].collectionId, work.id);
  assert.deepEqual(updated.entries[1], two);
  assert.equal(updated.collections[1].name, "Projects");
  await assert.rejects(store.moveEntry(one.id, "missing"), /no longer exists/);
  await assert.rejects(store.renameEntry(one.id, " "), /Enter a title/);
  await store.deleteEntry(one.id);
  assert.deepEqual((await store.read()).entries, [two]);
  await assert.rejects(store.deleteEntry(one.id), /no longer exists/);
});

test("failed writes do not report success or change persisted data", async () => {
  const h = harness();
  await h.store.save("https://one.example/", "One", INBOX_ID);
  const before = h.snapshot();
  h.failWrites("quota exceeded");
  await assert.rejects(h.store.save("https://two.example/", "Two", INBOX_ID), /quota exceeded/);
  await assert.rejects(h.store.createCollection("Work"), /quota exceeded/);
  assert.deepEqual(h.snapshot(), before);
});

test("rejects corrupted data without overwriting it", async () => {
  const bad = { version: 1, collections: [{ id: INBOX_ID, name: "Inbox" }], entries: [{ id: "bad", url: "https://example.com", title: "A", collectionId: "missing", savedAt: "2026-01-01" }] };
  const h = harness(bad);
  await assert.rejects(h.store.read(), /invalid/);
  await assert.rejects(h.store.save("https://other.example", "Other", INBOX_ID), /invalid/);
  assert.deepEqual(h.snapshot()[STORAGE_KEY], bad);
  assert.throws(() => validateLibrary({ ...bad, version: 3 }), /unsupported version/);
  assert.throws(() => validateLibrary({ version: 1, collections: [], entries: [] }), /invalid/);
});

test("serializes concurrent writes and duplicates across contexts", async () => {
  const h = harness();
  let id = 100;
  const second = createStore({ storage: h.storage, locks: h.locks, uuid: () => `second-${++id}` });
  const results = await Promise.all([
    h.store.save("https://example.com/a", "A", INBOX_ID),
    second.save("https://example.com/a", "Duplicate", INBOX_ID),
    h.store.save("https://example.com/b", "B", INBOX_ID),
    second.createCollection("Work")
  ]);
  assert.deepEqual(results.slice(0, 3).map((result) => result.status), ["saved", "duplicate", "saved"]);
  const library = await h.store.read();
  assert.equal(library.entries.length, 2);
  assert.equal(library.collections.length, 2);
});

test("rejects unsupported URLs and missing coordination capability", async () => {
  const h = harness();
  for (const url of ["chrome://settings", "file:///tmp/test", "javascript:alert(1)", "", undefined]) {
    await assert.rejects(h.store.save(url, "Test", INBOX_ID), /HTTP and HTTPS/);
  }
  const unlocked = createStore({ storage: h.storage });
  await assert.rejects(unlocked.save("https://example.com", "Example", INBOX_ID), /cannot safely coordinate/);
  assert.deepEqual(h.snapshot(), {});
});

test("details are optional on old links, editable and clearable without changing other fields", async () => {
  const h = harness();
  await h.store.save("https://example.com", "Example", INBOX_ID);
  const old = await h.store.read();
  const entry = old.entries[0];
  assert.equal(entry.description, undefined);
  await h.store.updateDetails(entry.id, " Useful\nreference ", " Work, work, , Web Design, WORK, Personal ");
  const updated = (await h.store.read()).entries[0];
  assert.deepEqual(updated, { ...entry, description: "Useful\nreference", tags: ["Work", "Web Design", "Personal"] });
  assert.equal(matchesSearch(updated, "REFERENCE"), true);
  assert.equal(matchesSearch(updated, "web design"), true);
  assert.equal(matchesSearch(entry, "example"), true);
  assert.equal(matchesSearch(entry, "missing"), false);
  await h.store.updateDetails(entry.id, "", "");
  assert.deepEqual((await h.store.read()).entries[0], { ...entry, description: "", tags: [] });
  await assert.rejects(h.store.updateDetails(entry.id, null, ""), /text description/);
  await assert.rejects(h.store.updateDetails(entry.id, "", []), /separated by commas/);
  await h.store.deleteEntry(entry.id);
  await assert.rejects(h.store.updateDetails(entry.id, "Gone", ""), /no longer exists/);
});

test("rejects invalid metadata rather than discarding existing data", async () => {
  const h = harness();
  await h.store.save("https://example.com", "Example", INBOX_ID);
  const original = await h.store.read();
  for (const fields of [
    { description: 5 }, { tags: "work" }, { tags: ["Work", "work"] },
    { tags: [" "] }, { tags: [" padded "] }, { tags: ["one,two"] }, { tags: [null] }
  ]) {
    const data = structuredClone(original);
    Object.assign(data.entries[0], fields);
    const bad = harness(data);
    await assert.rejects(bad.store.updateDetails(data.entries[0].id, "", ""), /invalid/);
    assert.deepEqual(bad.snapshot()[STORAGE_KEY], data);
  }
});

test("deletes only the confirmed collection and clears Inbox without removing it", async () => {
  const { store } = harness();
  const work = await store.createCollection("Work");
  await store.save("https://work.example", "Work", work.id);
  await store.save("https://inbox.example", "Inbox", INBOX_ID);
  const before = await store.read();
  await assert.rejects(store.deleteCollection(INBOX_ID, []), /cannot be deleted/);
  await store.deleteCollection(work.id, collectionSnapshot(before, work.id));
  assert.deepEqual((await store.read()).entries, [before.entries[1]]);
  assert.equal((await store.read()).collections.length, 1);
  await store.clearInbox([before.entries[1].id]);
  assert.deepEqual((await store.read()).entries, []);
  assert.deepEqual((await store.read()).collections, [{ id: INBOX_ID, name: "Inbox", parentId: null }]);
  const empty = await store.createCollection("Empty");
  await store.deleteCollection(empty.id, collectionSnapshot(await store.read(), empty.id));
  await assert.rejects(store.deleteCollection(empty.id, []), /no longer exists/);
});

test("stale confirmation refuses newly saved or moved entries, including same-count replacements", async () => {
  const h = harness();
  const work = await h.store.createCollection("Work");
  await h.store.save("https://one.example", "One", work.id);
  const one = (await h.store.read()).entries[0];
  const confirmation = collectionSnapshot(await h.store.read(), work.id);
  await h.store.save("https://two.example", "Two", work.id);
  const two = (await h.store.read()).entries[1];
  await assert.rejects(h.store.deleteCollection(work.id, confirmation), /changed/);
  await h.store.moveEntry(one.id, INBOX_ID);
  await assert.rejects(h.store.deleteCollection(work.id, confirmation), /changed/);
  await assert.rejects(h.store.clearInbox([]), /changed/);
  await h.store.deleteCollection(work.id, collectionSnapshot(await h.store.read(), work.id));
  assert.deepEqual((await h.store.read()).entries, [{ ...one, collectionId: INBOX_ID }]);
});

test("failed metadata and destructive writes preserve the entire persisted library", async () => {
  const h = harness();
  const work = await h.store.createCollection("Work");
  await h.store.save("https://work.example", "Work", work.id);
  await h.store.save("https://inbox.example", "Inbox", INBOX_ID);
  const before = h.snapshot();
  const [workEntry, inboxEntry] = before[STORAGE_KEY].entries;
  h.failWrites("quota exceeded");
  await assert.rejects(h.store.updateDetails(workEntry.id, "Description", "Tag"), /quota exceeded/);
  await assert.rejects(h.store.deleteCollection(work.id, collectionSnapshot(before[STORAGE_KEY], work.id)), /quota exceeded/);
  await assert.rejects(h.store.clearInbox([inboxEntry.id]), /quota exceeded/);
  assert.deepEqual(h.snapshot(), before);
});

test("concurrent saves cannot race past collection deletion confirmation", async () => {
  const h = harness();
  const work = await h.store.createCollection("Work");
  const confirmation = collectionSnapshot(await h.store.read(), work.id);
  const results = await Promise.allSettled([
    h.store.save("https://new.example", "New", work.id),
    h.store.deleteCollection(work.id, confirmation)
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /changed/);
  const entry = (await h.store.read()).entries[0];
  const nextConfirmation = collectionSnapshot(await h.store.read(), work.id);
  const moved = await Promise.allSettled([
    h.store.moveEntry(entry.id, INBOX_ID),
    h.store.deleteCollection(work.id, nextConfirmation)
  ]);
  assert.equal(moved[1].status, "rejected");
  assert.equal((await h.store.read()).entries[0].collectionId, INBOX_ID);
});

test("upgrades flat libraries only on successful writes and preserves metadata", async () => {
  const old = {
    version: 1, collections: [{ id: INBOX_ID, name: "Inbox" }, { id: "work", name: "Work" }],
    entries: [{ id: "one", title: "One", url: "https://one.example", collectionId: "work", savedAt: "2026-01-01", description: "Notes", tags: ["Tag"] }]
  };
  const h = harness(old);
  assert.equal((await h.store.read()).version, 2);
  assert.equal((await h.store.read()).collections[1].parentId, null);
  assert.deepEqual(h.snapshot()[STORAGE_KEY], old);
  await h.store.createCollection("Child", "work");
  assert.equal(h.snapshot()[STORAGE_KEY].version, 2);
  assert.deepEqual((await h.store.read()).entries, old.entries);
  const failed = harness(old);
  failed.failWrites("quota exceeded");
  await assert.rejects(failed.store.createCollection("Child", "work"), /quota exceeded/);
  assert.deepEqual(failed.snapshot()[STORAGE_KEY], old);
});

test("validates missing parents, cycles, Inbox rules and sibling collisions", async () => {
  const inbox = { id: INBOX_ID, name: "Inbox", parentId: null };
  for (const collections of [
    [inbox, { id: "a", name: "A", parentId: "missing" }],
    [inbox, { id: "a", name: "A", parentId: "a" }],
    [inbox, { id: "a", name: "A", parentId: "b" }, { id: "b", name: "B", parentId: "a" }],
    [inbox, { id: "a", name: "A", parentId: INBOX_ID }],
    [{ ...inbox, parentId: "a" }, { id: "a", name: "A", parentId: null }],
    [inbox, { id: "a", name: "A", parentId: null }, { id: "b", name: "a", parentId: null }]
  ]) {
    const data = { version: 2, collections, entries: [] };
    const h = harness(data);
    await assert.rejects(h.store.createCollection("New"), /invalid/);
    assert.deepEqual(h.snapshot()[STORAGE_KEY], data);
  }
});

test("nested paths, sibling names, rename and subtree moves preserve entry identity", async () => {
  const { store } = harness();
  const work = await store.createCollection("Work");
  const personal = await store.createCollection("Personal");
  const reading = await store.createCollection("Reading", work.id);
  await store.createCollection("Reading", personal.id);
  const deep = await store.createCollection("Deep", reading.id);
  await assert.rejects(store.createCollection(" reading ", work.id), /already exists/);
  await assert.rejects(store.createCollection("Bad", INBOX_ID), /cannot contain/);
  await assert.rejects(store.createCollection("Bad", "missing"), /no longer exists/);
  await assert.rejects(store.moveCollection(INBOX_ID, work.id), /cannot be moved/);
  await assert.rejects(store.moveCollection(work.id, deep.id), /descendant/);
  await assert.rejects(store.moveCollection(reading.id, reading.id), /itself/);
  await assert.rejects(store.moveCollection(reading.id, personal.id), /already exists/);
  await assert.rejects(store.moveCollection(work.id, INBOX_ID), /cannot contain/);
  await assert.rejects(store.moveCollection(work.id, "missing"), /no longer exists/);
  assert.deepEqual(await store.save("https://deep.example", "Deep", deep.id), { status: "saved", collection: "Work / Reading / Deep" });
  const before = (await store.read()).entries;
  await store.renameCollection(reading.id, "Books");
  await store.moveCollection(reading.id, personal.id);
  assert.deepEqual((await store.read()).entries, before);
  assert.deepEqual(await store.save("https://deep.example", "Duplicate", INBOX_ID), { status: "duplicate", collection: "Personal / Books / Deep" });
  await store.moveCollection(reading.id, null);
  assert.equal(collectionTree(await store.read()).find((c) => c.id === deep.id).path, "Books / Deep");
});

test("deletion snapshots detect empty descendants and reparented collections", async () => {
  const { store } = harness();
  const root = await store.createCollection("Root");
  const before = collectionSnapshot(await store.read(), root.id);
  const child = await store.createCollection("Child", root.id);
  await assert.rejects(store.deleteCollection(root.id, before), /changed/);
  const grandchild = await store.createCollection("Grandchild", child.id);
  const next = collectionSnapshot(await store.read(), root.id);
  await store.moveCollection(grandchild.id, root.id);
  await assert.rejects(store.deleteCollection(root.id, next), /changed/);
  await store.save("https://deep.example", "Deep", grandchild.id);
  await store.save("https://safe.example", "Safe", INBOX_ID);
  const safe = (await store.read()).entries[1];
  await store.deleteCollection(root.id, collectionSnapshot(await store.read(), root.id));
  assert.deepEqual((await store.read()).entries, [safe]);
  assert.deepEqual((await store.read()).collections, [{ id: INBOX_ID, name: "Inbox", parentId: null }]);
});

test("hierarchy traversal supports deep trees without recursive calls", () => {
  const collections = [{ id: INBOX_ID, name: "Inbox", parentId: null }];
  for (let i = 0; i < 1500; i++) collections.push({ id: `c${i}`, name: "N", parentId: i === 0 ? null : `c${i - 1}` });
  const data = validateLibrary({ version: 2, collections, entries: [] });
  const tree = collectionTree(data);
  assert.equal(tree.length, 1501);
  assert.equal(tree.at(-1).depth, 1499);
  assert.equal(collectionSnapshot(data, "c0").collections.length, 1500);
});

test("concurrent branch changes invalidate deletion and failed hierarchy writes preserve data", async () => {
  const h = harness();
  const root = await h.store.createCollection("Root");
  const branch = await h.store.createCollection("Branch");
  await h.store.save("https://branch.example", "Branch", branch.id);
  const confirmation = collectionSnapshot(await h.store.read(), root.id);
  const results = await Promise.allSettled([
    h.store.moveCollection(branch.id, root.id),
    h.store.deleteCollection(root.id, confirmation)
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /changed/);
  const before = h.snapshot();
  h.failWrites("quota exceeded");
  await assert.rejects(h.store.moveCollection(branch.id, null), /quota exceeded/);
  await assert.rejects(h.store.createCollection("Child", branch.id), /quota exceeded/);
  await assert.rejects(h.store.deleteCollection(root.id, collectionSnapshot(await h.store.read(), root.id)), /quota exceeded/);
  assert.deepEqual(h.snapshot(), before);
});
