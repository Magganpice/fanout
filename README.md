# Fanout – ChatGPT Query Analyzer

A Chrome/Firefox extension that opens as a side panel alongside ChatGPT and reveals everything happening under the hood of a conversation: what the model searched for, what it cited, which domains it trusted, and what entities it identified.

![Fanout side panel showing query and citation analysis](screenshots/fanout-chatgpt-example.png)

## What it shows

For each prompt in a conversation, Fanout extracts:

| Section | What it contains |
|---|---|
| **Queries** | Search queries the AI generated, and any user-provided search terms |
| **Grouped Citations** | Web results pulled in via ChatGPT's search (the "fanout") |
| **Primary Citations** | The ranked sources cited inline in the response |
| **Footnote Sources** | Sources referenced in footnotes |
| **Entities** | Named entities the model identified in the response |
| **Supporting Sites** | Secondary sources linked to primary citations |
| **Image Searches** | Image carousel queries generated during the response |

A stats bar at the top summarises the model used, prompt count, total queries, citations, and unique domains at a glance. The **Domains tab** aggregates all cited domains by frequency across the whole conversation.

## Install

> Fanout is not yet in the Chrome Web Store. Install it manually:

1. [Download ZIP](https://github.com/Magganpice/fanout/archive/refs/heads/main.zip) and unzip it — keep the folder somewhere permanent
2. Open `chrome://extensions`
3. Enable **Developer Mode** (toggle, top right)
4. Click **Load Unpacked** → select the unzipped `fanout` folder
5. Navigate to any ChatGPT conversation and click the Fanout icon in the toolbar

## Requirements

- Google Chrome 116+ (for Side Panel support)
- An active ChatGPT account
- A conversation that used web search — the URL must contain `/c/`

## Features

- **Side panel UI** — stays open alongside ChatGPT as you navigate between conversations
- **Chronological order** — prompts appear in the order they were sent
- **Show / Hide sections** — toggle individual data types on or off per session
- **Live filter** — search across all sections simultaneously
- **Domain Insights tab** — ranked frequency table of every cited domain, broken down by citation type
- **History tab** — last 20 analyzed conversations stored locally, loadable with one click
- **Export** — unified CSV, full JSON, or Markdown
- **Citation quality indicators** — flags citations with missing or thin snippets
- **Toolbar badge** — shows citation count on the extension icon after analysis

## Privacy

Fanout runs entirely in your browser. It makes no external requests of its own — it reads your ChatGPT conversation data using your existing session, and stores history locally in `chrome.storage.local`. Nothing leaves your machine.

## How it works

When you click **Analyze**, Fanout reads the current conversation from ChatGPT's internal API using your active session — the same data your browser already has. It then parses the conversation graph to extract search metadata, citation references, and entity markers from each message node, grouping everything by the prompt that triggered it.

## Why this matters — optimizing for Query Fanout

When a user asks ChatGPT a question, the model rarely searches for exactly what was typed. Instead it **fans out** — autonomously generating a set of distinct search queries to gather information from multiple angles before composing its answer. A single user prompt like *"what are the best tools for technical SEO?"* might trigger five or six different queries behind the scenes, each pulling in different sources.

This has a significant implication for anyone who wants their content to appear in AI-generated responses: **you are not optimizing for one query, you are optimizing for a cluster of queries you cannot directly see.**

Fanout makes that cluster visible.

### How to use it for optimization

**1. Find the fanout for your topic**

Ask ChatGPT a question your target audience would realistically ask. Once it responds, click **Analyze**. Look at the Queries section — these are the actual search strings the model generated. This is the query space your content needs to live in, not just the question the user typed.

**2. Study the citation pattern**

Look at Grouped Citations and Primary Citations. These are the pages the model pulled in and ranked. Ask: what do these pages have in common? How are they structured? What do they cover that your content might not?

**3. Use the Domain Insights tab**

Switch to the Domains tab to see which domains appear repeatedly across the conversation. A domain cited in three different queries has a structural advantage — the model has effectively decided it is a reliable source for this topic area. Appearing once is a citation. Appearing across multiple fanout queries is authority.

**4. Run the same question multiple times**

The fanout is not perfectly deterministic. Run the same prompt two or three times in separate conversations and analyze each with Fanout. Queries that appear consistently across runs are the ones worth targeting first — they represent the model's stable understanding of what this topic requires. Use the History tab to compare past analyses side by side.

**5. Optimize for breadth, not just depth**

Traditional SEO rewards depth on a single keyword. LLM citation rewards **breadth across a topic cluster**. A page that partially answers four of the model's six fanout queries will outperform a page that perfectly answers one. Use the query list to find gaps in your existing content and either expand the page or build supporting content that covers the adjacent queries.

**6. Track which queries you are already winning**

Export the citations as CSV and cross-reference the domains against your own. If you appear as a Primary Citation for two out of six fanout queries, you know exactly which queries you are missing — and those become your content targets.

---

The underlying principle is straightforward: LLMs with web search do not retrieve pages, they retrieve answers to sub-questions. Fanout shows you what those sub-questions are.

## By Sam Steiner
