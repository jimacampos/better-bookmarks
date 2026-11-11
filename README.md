# Better Bookmarks

A small, local-only Chromium extension for saving links and finding them again. It does not use native browser bookmarks, fetch pages, or send library data to an external service.

Save a useful page, close its tab yourself, and retrieve it later from your library.

## Features

- Save the current page's title and exact URL to Inbox or a collection.
- Organize links in nested collections and move links or entire collection branches.
- Add optional descriptions and tags in the library.
- Search titles, URLs, descriptions, and tags with case-insensitive text matching.
- Reopen links, edit titles and details, and delete links or collection branches.
- Detect duplicate URLs without stripping query parameters or fragments.

Built for **desktop Chrome and Microsoft Edge** using Manifest V3, plain HTML/CSS, and JavaScript modules. No AI, accounts, backend, or cloud services are required.

## Install

No build step, dependency installation, or extension-store account is needed to run the extension.

1. In desktop Chrome, open `chrome://extensions`; in desktop Edge, open `edge://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select this folder.
3. Pin Better Bookmarks from the extensions menu if you want quick access.

Use the extension button on an HTTP or HTTPS page, select Inbox or a collection, and save. Wait for the confirmation before closing the page yourself. Open the library from the popup to search, manage collections and links, or open a saved link.

## Link details and collections

In the library, choose **Edit details** to add or clear an optional description and tags. Separate tags with commas; spaces within tags are allowed. Tags are trimmed and duplicates are combined ignoring capitalization, keeping the first spelling. Search matches titles, URLs, descriptions, and tags within the selected collection. The popup stays focused on quickly saving links.

### Nested collections

Choose a **Parent** when creating a collection, or leave **Top level** selected. Collections can be nested to any depth. Use the `+` / `-` controls to expand or collapse branches. Selecting a collection shows only its direct links; browsing and search do not include descendant links. **All links** includes everything.

Select a named collection and use **Collection parent** and **Change parent** to move its whole branch, or move it back to the top level. A collection cannot be moved into itself or its descendants. Names must be unique ignoring capitalization and surrounding whitespace among siblings; different parents can each contain a Reading collection. Popup and link-move dropdowns show full paths such as `Work / Reading`.

Select a named collection to **Delete collection**, or select Inbox to **Clear Inbox**. Confirming collection deletion permanently removes **all its subcollections and all their links**, even links not shown in the current view or search. The confirmation shows subtree totals. Inbox stays at the top level and cannot contain children, be moved, renamed, or deleted; it can only be cleared. There is no undo or backup. If the branch or link membership changes before deletion, review the refreshed library and confirm again.

Existing flat collections are preserved as top-level collections. The storage format is upgraded on the next successful change; after updating the extension, reopen any library pages that were already open.

## Data and privacy

The extension requests `activeTab` to read the current page when you open the popup and `storage` to save the library locally. It does not automatically close tabs. Browser-restricted pages and non-HTTP(S) URLs cannot be saved.

Each browser profile has its own independent library. **There is no backup, import, export, or sync yet.** Uninstalling the extension or removing its browser profile can delete the library. Extension storage has browser-defined limits; storage errors are shown in the extension.

URLs are stored exactly as captured, including query strings and fragments, which can contain sensitive information. A saved URL is not a copy of the page: the destination may change, disappear, or require signing in again.

## Development

Use **Node.js 22 or newer** and npm for the development checks. There are no package dependencies to install.

```sh
npm test
npm run check
```

`npm test` runs the storage and hierarchy tests using Node's built-in test runner. `npm run check` checks JavaScript syntax.

After changing files, click **Reload** on the browser's extensions page, then reopen the popup and any library tabs. Do not uninstall the extension to update it: uninstalling can remove your saved library.

### Project structure

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension metadata, permissions, and popup configuration |
| `popup.html`, `popup.js` | Save the active page and open the library |
| `library.html`, `library.js` | Browse, search, and manage links and collections |
| `storage.js` | Schema validation, hierarchy helpers, and serialized local-storage writes |
| `style.css` | Shared popup and library styles |
| `test/storage.test.js` | Data-layer regression tests |

### Manual smoke check

In both Chrome and Edge, save a page, save it again to check duplicate detection, and reopen it from the library. Create a nested collection, move a link into it, add details, and search for those details. Verify that restarting the browser preserves links. Use disposable links to check collection deletion: confirming removes the entire branch and its links.

## MVP boundaries

Import/export, automatic backup, browser-to-browser sync, native bookmark integration, and public extension-store distribution are not included. Firefox, Safari, and mobile browsers are not supported. The extension saves URLs, not page contents, sessions, or scroll positions.
