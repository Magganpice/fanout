# Privacy Policy — Fanout

**Last updated: March 2026**

## The short version

Fanout does not collect, transmit, or store any of your data outside your own browser. Ever.

## What Fanout accesses

When you click **Analyze**, Fanout reads the current ChatGPT conversation from ChatGPT's own internal API using your existing browser session. This is the same data your browser already has — Fanout simply makes it visible in a structured way.

Specifically, Fanout reads:

- The conversation content and metadata for the currently open ChatGPT conversation
- Your ChatGPT session token, solely to authenticate the API request to ChatGPT's servers on your behalf

## What Fanout does with that data

- **Displays it to you** in the side panel
- **Stores a local history** of your last 20 analyzed conversations in your browser's local storage (`chrome.storage.local`) so you can revisit them without re-analyzing

That is all.

## What Fanout does not do

- Does not send any data to any external server
- Does not transmit your session token anywhere other than back to ChatGPT's own servers
- Does not collect analytics or usage data
- Does not use any third-party tracking, advertising, or analytics services
- Does not store anything in the cloud
- Does not share anything with anyone, including the developer

## Where your data lives

All stored data (conversation history) lives exclusively in your browser's local storage on your own machine. It is never synced, uploaded, or backed up anywhere. Uninstalling the extension permanently deletes it.

## Network requests

Fanout makes exactly two network requests when you click Analyze, both to ChatGPT's own servers (`chatgpt.com`):

1. `/api/auth/session` — to retrieve your session token
2. `/backend-api/conversation/{id}` — to retrieve the conversation data

No other network requests are made. Fanout has no backend, no database, and no servers of its own.

## Contact

For questions about this privacy policy, open an issue at [github.com/Magganpice/fanout](https://github.com/Magganpice/fanout).
