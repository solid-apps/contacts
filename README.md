# contacts

A minimal **contacts app** for a Solid pod. Stores contacts as vCard JSON-LD
under `<pod>/public/contacts/` (one resource per person).

- **List / search** the contacts on your pod.
- **Add / edit / remove** a contact (name, emails, phones, note).
- **Import from phone** — uses the browser's [Contact Picker API]
  (`navigator.contacts.select`) where available (Chrome / Samsung Internet on
  Android). You pick which contacts to bring in; nothing is read without your
  tap.
- **Import .vcf** — load one or more vCard files; works in any browser.

Reads and writes use `window.xlogin.authFetch`, so sign in with the login pill
(bottom-right) first.

## Data model

Each contact is a JSON-LD resource using the [vCard ontology]
(`http://www.w3.org/2006/vcard/ns#`):

```json
{
  "@context": { "vcard": "http://www.w3.org/2006/vcard/ns#" },
  "@type": "vcard:Individual",
  "vcard:fn": "Ada Lovelace",
  "vcard:hasEmail": ["ada@example.org"],
  "vcard:hasTelephone": ["+44 20 7946 0000"]
}
```

## Notes

- Contacts are stored under `/public/contacts/`. On a **local-only** pod (e.g.
  the Android app) that is private to the device. If you expose your pod over a
  tunnel, lock this container down with an ACL — see the issue tracker for a
  follow-up to move it to a non-public, owner-only container by default.
- All URLs are resolved relative to this page, so it works whether the pod is at
  an origin root or behind a path.
- The Contact Picker API is a manual picker, not a background sync. A native
  bulk-sync bridge (read the whole address book at once) is tracked separately
  for the Android host app.

## License

AGPL-3.0-only.
