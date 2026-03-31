// Fanout – Panel JS
// Data fetching, parsing, rendering, and export for the ChatGPT Query Analyzer.
// By Sam Steiner

/* ════════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════ */

const SECTIONS = {
  'Queries':           { key: 'q',  defaultOn: true  },
  'Grouped Citations': { key: 'st', defaultOn: true  },
  'Primary Citations': { key: 'l',  defaultOn: true  },
  'Footnote Sources':  { key: 'fn', defaultOn: true  },
  'Entities':          { key: 'en', defaultOn: true  },
  'Supporting Sites':  { key: 'sw', defaultOn: false },
  'Image Searches':    { key: 'ig', defaultOn: false },
};

const MAX_HISTORY = 20;
const STORAGE_KEY  = 'fanout_history';
const TAB_KEY      = 'fanout_sourceTabId';

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */

const state = {
  data: null,          // { title, cid, grps, stats, domains, timestamp }
  history: [],
  activeTab: 'analysis',
  sectionVis: {},          // section name → boolean (is it visible)
  searchQuery: '',
  expanded: new Set(), // set of group indices that are open
};

// Initialise column visibility from defaults
for (const [name, col] of Object.entries(SECTIONS)) {
  state.sectionVis[name] = col.defaultOn;
}

/* ════════════════════════════════════════════════════════════
   DOM SHORTCUTS
════════════════════════════════════════════════════════════ */

const $  = id  => document.getElementById(id);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls)              e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

/** Create an SVG element with optional child shapes */
const SVG_NS = 'http://www.w3.org/2000/svg';
function makeSVG(attrs, children = []) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  Object.entries(attrs).forEach(([k, v]) => svg.setAttribute(k, v));
  children.forEach(([tag, ca]) => {
    const c = document.createElementNS(SVG_NS, tag);
    Object.entries(ca).forEach(([k, v]) => c.setAttribute(k, v));
    svg.appendChild(c);
  });
  return svg;
}

/** Safe HTML escaping */
const esc = s =>
  s == null ? '' : String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ════════════════════════════════════════════════════════════
   DATA FETCHING
════════════════════════════════════════════════════════════ */

async function analyzeConversation() {
  setLoading(true);
  try {
    // Background finds the right tab itself — avoids side-panel window context issues
    const result = await chrome.runtime.sendMessage({ action: 'fetchConversation' });

    if (!result?.success) {
      showError(result?.error ?? 'Unknown error fetching conversation data.');
      return;
    }

    const grps    = parseConversation(result.data);
    const stats   = computeStats(grps);
    const domains = computeDomains(grps);

    state.data = {
      title:     result.data.title || 'Untitled Conversation',
      cid:       result.cid,
      grps,
      stats,
      domains,
      timestamp: Date.now(),
    };

    // Open all groups by default
    state.expanded = new Set(grps.map((_, i) => i));

    await saveToHistory(state.data);

    // Update toolbar badge with citation count (tabId returned in result)
    if (result.tabId) {
      chrome.runtime.sendMessage({ action: 'setBadge', count: stats.citations, tabId: result.tabId });
    }

    renderAll();

  } catch (e) {
    showError(e.message);
  } finally {
    setLoading(false);
  }
}

/* ════════════════════════════════════════════════════════════
   PARSING – converts raw ChatGPT API response into groups
════════════════════════════════════════════════════════════ */

/**
 * Traverse the conversation tree from root → leaf, returning node IDs in
 * chronological order. This ensures groups appear in the order the user
 * actually sent their messages, not the arbitrary order of data.mapping keys.
 */
function orderedNodeIds(mapping) {
  const allIds = new Set(Object.keys(mapping));

  // Root = node whose parent is absent or not in the mapping
  let rootId = null;
  for (const id of allIds) {
    const p = mapping[id].parent;
    if (!p || !allIds.has(p)) { rootId = id; break; }
  }
  if (!rootId) return [...allIds];

  const result  = [];
  const visited = new Set();

  // DFS — for branched conversations (regenerations) all branches are visited
  function walk(id) {
    if (!id || visited.has(id)) return;
    visited.add(id);
    result.push(id);
    (mapping[id].children || []).forEach(walk);
  }
  walk(rootId);

  // Catch any nodes unreachable from root (edge case)
  for (const id of allIds) if (!visited.has(id)) result.push(id);
  return result;
}

function parseConversation(data) {
  const groupMap = new Map();

  const fmtDate = t =>
    typeof t === 'number' ? new Date(t * 1000).toLocaleDateString() : t || '';

  /**
   * Add a citation to an array, deduplicating by URL/title key.
   * Returns true if the item was added.
   */
  const addCitation = (arr, seen, obj, type, rank = null, refIndex = null) => {
    const raw = obj.url || obj.title || obj.ti || '';
    const key = raw.trim().replace(/\/$/, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    arr.push({
      u:  obj.url   || '',
      t:  type,
      ti: obj.title || 'No Title',
      sn: obj.snippet || '',
      at: obj.attribution || '',
      dt: fmtDate(obj.pub_date),
      r:  rank,
      ri: refIndex ?? obj.refs?.[0]?.ref_index ?? null,
      // Snippet quality indicator
      sq: (obj.snippet?.length > 50) ? 'full' : (obj.snippet?.length > 0) ? 'partial' : 'none',
    });
    return true;
  };

  for (const id of orderedNodeIds(data.mapping)) {
    const node  = data.mapping[id];
    const meta  = node.message?.metadata;
    const cont  = node.message?.content;

    const queries = [], grouped = [], footnotes = [], primary = [], supporting = [];
    const entities = [], imgGroups = [];
    const seenGrouped = new Set(), seenPrimary = new Set();
    const seenFn = new Set(), seenSupporting = new Set();
    const seenEntities = new Set(), seenImgGroups = new Set();

    // ── Search queries ──────────────────────────────────────
    meta?.search_model_queries?.queries?.forEach(q =>
      queries.push({ t: q, ai: true })
    );
    meta?.search_queries?.forEach(q =>
      queries.push({ t: q.q, ai: false })
    );

    // ── Grouped citations (search result groups) ────────────
    meta?.search_result_groups?.forEach(g =>
      g.entries?.forEach(e => addCitation(grouped, seenGrouped, e, 'Grouped Citation'))
    );

    // ── Content references (sidebar, business map, footnotes) ─
    meta?.content_references?.forEach(ref => {
      if (ref.cite_map) {
        Object.values(ref.cite_map).forEach(v =>
          addCitation(grouped, seenGrouped, v, 'Sidebar Citation')
        );
      }
      if (ref.type === 'businesses_map' && ref.businesses) {
        ref.businesses.forEach(b =>
          addCitation(grouped, seenGrouped,
            { url: b.website_url, title: b.name, snippet: b.address, attribution: 'Map Result' },
            'Business')
        );
      }
      if ((ref.type === 'sources_footnote' || ref.type === 'sources_footnotes') && ref.sources) {
        ref.sources.forEach(src =>
          addCitation(footnotes, seenFn, src, 'Footnote')
        );
      }
    });

    // ── Primary citations + supporting websites ─────────────
    let rank = 1;
    meta?.content_references?.forEach(ref => {
      if (ref.type === 'grouped_webpages' && ref.items) {
        ref.items.forEach(item => {
          const refIdx = item.refs?.[0]?.ref_index ?? null;
          if (addCitation(primary, seenPrimary, item, 'Primary', rank)) rank++;
          item.supporting_websites?.forEach(s =>
            addCitation(supporting, seenSupporting, s, 'Supporting', null, refIdx)
          );
        });
      }
    });

    // ── Image results ───────────────────────────────────────
    meta?.image_results?.forEach(img =>
      addCitation(primary, seenPrimary,
        { url: img.url || img.content_url, title: img.title },
        'Image')
    );

    // ── Attachments ─────────────────────────────────────────
    meta?.attachments?.forEach(a =>
      addCitation(primary, seenPrimary, { url: a.url, title: a.name }, 'Attachment')
    );

    // ── Text: entities + image groups (Unicode PUA markers) ──
    let txt = '';
    if (cont?.parts) {
      txt = cont.parts.join('\n');

      // Image groups: \uE200image_group\uE202...\uE201
      const igRx = /\uE200image_group\uE202(.*?)\uE201/g;
      let m;
      while ((m = igRx.exec(txt)) !== null) {
        try {
          const raw = JSON.stringify(JSON.parse(m[1]));
          if (!seenImgGroups.has(raw)) {
            seenImgGroups.add(raw);
            imgGroups.push({ t: 'ImgGroup', ti: raw, sn: '', u: '' });
          }
        } catch {}
      }

      // Entities: \uE200entity\uE202...\uE201
      const entRx = /\uE200entity\uE202(.*?)\uE201/g;
      while ((m = entRx.exec(txt)) !== null) {
        try {
          const j    = JSON.parse(m[1]);
          const name = j[1];
          const type = j[0];
          const det  = j[3] ? JSON.stringify(j[3]) : '';
          if (name && !seenEntities.has(name)) {
            seenEntities.add(name);
            entities.push({ t: 'Entity', ti: name, sn: type + (det ? ' · ' + det : ''), u: '' });
          }
        } catch {}
      }
    }

    const hasData =
      queries.length || grouped.length || footnotes.length ||
      primary.length || supporting.length || entities.length || imgGroups.length ||
      (txt && node.message?.author?.role === 'assistant');

    if (!hasData) continue;

    // ── Find parent user prompt (walk up to 30 hops) ────────
    let parentId  = node.parent;
    let userPrompt = '[Conversation Start]';
    for (let hop = 0; hop < 30; hop++) {
      const p = data.mapping[parentId];
      if (!p) break;
      if (p.message?.author?.role === 'user') {
        const parts = p.message.content?.parts;
        userPrompt  = Array.isArray(parts) ? parts.join(' ') : String(parts || '');
        break;
      }
      parentId = p.parent;
    }

    if (!groupMap.has(userPrompt)) {
      groupMap.set(userPrompt, {
        p: userPrompt,
        q: [], st: [], fn: [], l: [], sw: [], en: [], ig: [], dc: [],
        txt: '',
        models: new Set(),
      });
    }

    const g = groupMap.get(userPrompt);
    g.q.push(...queries);
    g.st.push(...grouped);
    g.fn.push(...footnotes);
    g.l.push(...primary);
    g.sw.push(...supporting);
    g.en.push(...entities);
    g.ig.push(...imgGroups);

    if (node.message?.author?.role === 'assistant' && meta?.model_slug) {
      g.models.add(meta.model_slug);
    }
    if (txt && node.message?.author?.role === 'assistant') {
      g.txt += txt + '\n\n';
    }
  }

  // Add model info entry to each group
  groupMap.forEach(g => {
    if (g.models.size) {
      g.dc.unshift({
        t: 'Model', ti: Array.from(g.models).join(', '),
        sn: 'Generative model used in this turn', u: '',
      });
    }
  });

  return Array.from(groupMap.values());
}

/* ════════════════════════════════════════════════════════════
   ANALYTICS
════════════════════════════════════════════════════════════ */

function computeStats(grps) {
  const allCitations = grps.flatMap(g => [...g.l, ...g.st, ...g.fn, ...g.sw]);

  const domains = new Set(
    allCitations.map(x => {
      try { return new URL(x.u).hostname.replace(/^www\./, ''); }
      catch { return null; }
    }).filter(Boolean)
  );

  const models = [...new Set(
    grps.flatMap(g => g.dc.filter(d => d.t === 'Model').map(d => d.ti))
  )];

  return {
    prompts:      grps.length,
    queries:      grps.reduce((s, g) => s + g.q.length, 0),
    aiQueries:    grps.reduce((s, g) => s + g.q.filter(q => q.ai).length, 0),
    citations:    allCitations.length,
    uniqueDomains: domains.size,
    entities:     grps.reduce((s, g) => s + g.en.length, 0),
    models,
  };
}

function computeDomains(grps) {
  const freq = new Map();
  const typeBuckets = new Map(); // domain → { Primary: n, Grouped: n, ... }

  grps.forEach(g => {
    [
      ...g.l.map(x => ({ ...x, bucket: 'Primary' })),
      ...g.st.map(x => ({ ...x, bucket: 'Grouped' })),
      ...g.fn.map(x => ({ ...x, bucket: 'Footnote' })),
      ...g.sw.map(x => ({ ...x, bucket: 'Supporting' })),
    ].forEach(item => {
      if (!item.u) return;
      let domain;
      try { domain = new URL(item.u).hostname.replace(/^www\./, ''); }
      catch { return; }
      if (!domain) return;

      freq.set(domain, (freq.get(domain) || 0) + 1);

      if (!typeBuckets.has(domain)) {
        typeBuckets.set(domain, { Primary: 0, Grouped: 0, Footnote: 0, Supporting: 0 });
      }
      typeBuckets.get(domain)[item.bucket] =
        (typeBuckets.get(domain)[item.bucket] || 0) + 1;
    });
  });

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([domain, count]) => ({
      domain,
      count,
      buckets: typeBuckets.get(domain) || {},
    }));
}

/* ════════════════════════════════════════════════════════════
   HISTORY  (chrome.storage.local)
════════════════════════════════════════════════════════════ */

async function loadHistory() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    state.history = r[STORAGE_KEY] || [];
  } catch {
    state.history = [];
  }
}

async function saveToHistory(data) {
  const entry = {
    id:        data.cid,
    title:     data.title,
    timestamp: data.timestamp,
    grps:      data.grps,
    stats:     data.stats,
    domains:   data.domains,
  };

  state.history = state.history.filter(h => h.id !== entry.id);
  state.history.unshift(entry);
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(0, MAX_HISTORY);
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state.history });
  } catch (e) {
    console.warn('[Fanout] Failed to save history:', e);
  }
}

function loadFromHistory(idx) {
  const entry = state.history[idx];
  if (!entry) return;
  state.data = {
    title:     entry.title,
    cid:       entry.id,
    grps:      entry.grps,
    stats:     entry.stats,
    domains:   entry.domains,
    timestamp: entry.timestamp,
  };
  state.expanded = new Set(entry.grps.map((_, i) => i));
  state.activeTab = 'analysis';
  renderAll();
}

/* ════════════════════════════════════════════════════════════
   RENDERING – top-level orchestrator
════════════════════════════════════════════════════════════ */

function renderAll() {
  const { title, stats } = state.data;

  $('empty-state').classList.add('hidden');

  // Show persistent UI sections
  const convEl = $('conv-title');
  convEl.classList.remove('hidden');
  convEl.textContent = title;

  $('stats-bar').classList.remove('hidden');
  $('nav-tabs').classList.remove('hidden');

  renderStats(stats);
  renderActiveTab();
}

function renderActiveTab() {
  const content = $('tab-content');

  // Sync tab button active state
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === state.activeTab)
  );

  // Controls visibility: only for analysis tab
  const showControls = state.activeTab === 'analysis';
  $('controls').classList.toggle('hidden', !showControls);

  content.innerHTML = '';

  switch (state.activeTab) {
    case 'analysis': renderAnalysisTab(content); break;
    case 'domains':  renderDomainsTab(content);  break;
    case 'history':  renderHistoryTab(content);  break;
  }
}

/* ── STATS BAR ──────────────────────────────────────────── */

function renderStats(stats) {
  const bar = $('stats-bar');
  bar.innerHTML = '';

  if (stats.models.length) {
    const card = el('div', 'stat-card stat-card-model');
    card.title = stats.models.join(', ');
    card.appendChild(el('div', 'stat-value stat-value-model', stats.models.join(', ')));
    card.appendChild(el('div', 'stat-label', 'Model'));
    bar.appendChild(card);
  }

  const cards = [
    { value: stats.prompts,       label: 'Prompts' },
    { value: stats.queries,       label: 'Queries', sub: `${stats.aiQueries} AI` },
    { value: stats.citations,     label: 'Citations' },
    { value: stats.uniqueDomains, label: 'Domains' },
  ];

  cards.forEach(({ value, label, sub }) => {
    const card = el('div', 'stat-card');
    card.appendChild(el('div', 'stat-value', String(value)));
    const labelDiv = el('div', 'stat-label', label);
    if (sub) labelDiv.appendChild(el('span', 'stat-sub', sub));
    card.appendChild(labelDiv);
    bar.appendChild(card);
  });
}

/* ── ANALYSIS TAB ───────────────────────────────────────── */

function renderAnalysisTab(container) {
  container.innerHTML = '';
  const { grps } = state.data;
  const q = state.searchQuery.toLowerCase();

  const filtered = grps
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => {
      if (!q) return true;
      return (
        g.p.toLowerCase().includes(q) ||
        g.q.some(x => x.t.toLowerCase().includes(q)) ||
        g.l.some(x => x.ti.toLowerCase().includes(q) || x.u.toLowerCase().includes(q)) ||
        g.st.some(x => x.ti.toLowerCase().includes(q)) ||
        g.fn.some(x => x.ti.toLowerCase().includes(q) || x.u.toLowerCase().includes(q)) ||
        g.en.some(x => x.ti.toLowerCase().includes(q))
      );
    });

  if (!filtered.length) {
    container.appendChild(el('div', 'no-results', 'No results match your filter.'));
    return;
  }

  filtered.forEach(({ g, i }) => {
    container.appendChild(renderGroup(g, i));
  });
}

/* ── PROMPT GROUP ───────────────────────────────────────── */

function renderGroup(g, idx) {
  const expanded = state.expanded.has(idx);

  // Availability summary pills
  const pills = [];
  if (g.q.length)  pills.push(`${g.q.length} quer${g.q.length === 1 ? 'y' : 'ies'}`);
  if (g.l.length)  pills.push(`${g.l.length} citation${g.l.length === 1 ? '' : 's'}`);
  if (g.fn.length) pills.push(`${g.fn.length} footnote${g.fn.length === 1 ? '' : 's'}`);
  if (g.en.length) pills.push(`${g.en.length} entit${g.en.length === 1 ? 'y' : 'ies'}`);


  const promptText = g.p.length > 200 ? g.p.substring(0, 200) + '…' : g.p;

  const group = el('div', 'group');
  group.dataset.idx = idx;

  const header = el('div', 'group-header');

  const headerInner = el('div', 'group-header-inner');
  headerInner.appendChild(el('div', 'group-prompt', promptText));
  if (pills.length) {
    const metaDiv = el('div', 'group-meta');
    pills.forEach(p => metaDiv.appendChild(el('span', 'group-meta-pill', p)));
    headerInner.appendChild(metaDiv);
  }

  const chevron = el('div', `group-chevron${expanded ? ' open' : ''}`);
  chevron.appendChild(makeSVG(
    { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5' },
    [['polyline', { points: '6 9 12 15 18 9' }]]
  ));

  header.appendChild(headerInner);
  header.appendChild(chevron);

  header.addEventListener('click', () => {
    if (state.expanded.has(idx)) {
      state.expanded.delete(idx);
    } else {
      state.expanded.add(idx);
    }
    const updated = renderGroup(g, idx);
    group.replaceWith(updated);
  });

  group.appendChild(header);

  if (expanded) {
    const body = el('div', 'group-body');
    for (const [name, col] of Object.entries(SECTIONS)) {
      if (!state.sectionVis[name]) continue;
      const items = g[col.key];
      if (!items?.length) continue;
      body.appendChild(renderSection(name, items));
    }
    group.appendChild(body);
  }

  return group;
}

/* ── SECTION ────────────────────────────────────────────── */

function renderSection(name, items) {
  const section = el('div', 'section');

  // Deduplicate queries: if the same text appears as both AI and user, merge into one
  if (name === 'Queries') {
    const seen = new Map();
    const deduped = [];
    for (const item of items) {
      const key = item.t.trim().toLowerCase();
      if (seen.has(key)) {
        seen.get(key).both = true;
      } else {
        const copy = { ...item };
        seen.set(key, copy);
        deduped.push(copy);
      }
    }
    items = deduped;
  }

  const header = el('div', 'section-header');

  const copyBtn = el('button', 'btn-copy', 'Copy');
  copyBtn.title = 'Copy all URLs / values to clipboard';
  copyBtn.addEventListener('click', e => {
    e.stopPropagation();
    const text = items.map(x => x.u || x.t || x.ti).filter(Boolean).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
  });

  header.appendChild(el('span', 'section-title', name));
  header.appendChild(el('span', 'section-count', String(items.length)));
  header.appendChild(copyBtn);
  section.appendChild(header);

  const list = el('div', 'section-items');
  items.forEach(item => list.appendChild(renderItem(item)));
  section.appendChild(list);

  return section;
}

/* ── ITEM ───────────────────────────────────────────────── */

function renderItem(item) {
  const div = el('div', 'item');

  // Plain query (no URL, no title)
  if (item.t && !item.u && !item.ti) {
    if (item.both) {
      div.classList.add('item-both-query');
      div.appendChild(el('div', 'item-query-label', '🤖👤 User & AI Query'));
    } else {
      div.classList.add(item.ai ? 'item-ai-query' : 'item-user-query');
      div.appendChild(el('div', 'item-query-label', item.ai ? '🤖 AI-generated query' : '👤 User search query'));
    }
    div.appendChild(el('div', 'item-query-text', item.t));
    return div;
  }

  // Image group — parse JSON and show the image search queries
  if (item.t === 'ImgGroup') {
    let queries = [];
    let layout = '';
    try {
      const parsed = JSON.parse(item.ti);
      queries = Array.isArray(parsed.query) ? parsed.query : [];
      layout  = parsed.layout || '';
    } catch {}
    const imgTop = el('div', 'item-top');
    imgTop.appendChild(el('span', 'badge badge-ImgGroup', 'Image Search'));
    if (layout) imgTop.appendChild(el('span', 'item-date', layout));
    const imgQueries = el('div', 'imggroup-queries');
    queries.forEach(q => imgQueries.appendChild(el('span', 'imggroup-query', q)));
    div.appendChild(imgTop);
    div.appendChild(imgQueries);
    return div;
  }

  // Entity / Model (no URL)
  if (!item.u) {
    const typeClass = item.t.split(' ')[0];
    const entTop = el('div', 'item-top');
    entTop.appendChild(el('span', `badge badge-${typeClass}`, item.t));
    div.appendChild(entTop);
    div.appendChild(el('div', 'item-title', item.ti));
    if (item.sn) div.appendChild(el('div', 'item-snippet', item.sn));
    return div;
  }

  // Citation with URL
  const typeClass = item.t.split(' ')[0];
  let domain = '';
  try { domain = new URL(item.u).hostname.replace(/^www\./, ''); }
  catch {}

  const citTop = el('div', 'item-top');
  citTop.appendChild(el('span', `badge badge-${typeClass}`, item.t));
  if (item.r  != null) citTop.appendChild(el('span', 'item-rank', `#${item.r}`));
  if (item.ri != null) citTop.appendChild(el('span', 'item-ref', `Ref ${item.ri}`));
  if (item.dt)         citTop.appendChild(el('span', 'item-date', item.dt));
  div.appendChild(citTop);

  const titleDiv = el('div', 'item-title', item.ti);
  if (item.sq === 'none' || item.sq === 'partial') {
    titleDiv.appendChild(el('span', 'quality-none', item.sq === 'none' ? 'no preview' : 'thin'));
  }
  div.appendChild(titleDiv);

  const link = el('a', 'item-url', domain || item.u);
  link.href   = item.u;
  link.target = '_blank';
  link.rel    = 'noopener noreferrer';
  link.title  = item.u;
  div.appendChild(link);

  if (item.sn) div.appendChild(el('div', 'item-snippet', item.sn));
  if (item.at) div.appendChild(el('div', 'item-attr',    item.at));

  return div;
}

/* ── DOMAIN INSIGHTS TAB ────────────────────────────────── */

function renderDomainsTab(container) {
  const { domains } = state.data;

  if (!domains.length) {
    container.appendChild(el('div', 'no-results', 'No domain data available for this conversation.'));
    return;
  }

  const heading = el('div', 'tab-heading');
  heading.textContent = `${domains.length} unique domains cited`;
  container.appendChild(heading);

  const maxCount = domains[0].count;
  const list = el('div', 'domain-list');

  const BUCKET_COLORS = {
    Primary:    '#0e7490',
    Grouped:    '#22d3ee',
    Footnote:   '#a78bfa',
    Supporting: '#38bdf8',
  };

  domains.slice(0, 60).forEach(({ domain, count, buckets }, i) => {
    const pct = Math.round((count / maxCount) * 100);

    const row = el('div', 'domain-row');
    row.appendChild(el('div', 'domain-rank', String(i + 1)));

    const info = el('div', 'domain-info');
    info.appendChild(el('div', 'domain-name', domain));

    const bucketEntries = Object.entries(buckets).filter(([, n]) => n > 0);
    if (bucketEntries.length) {
      const breakdown = el('div', 'domain-breakdown');
      bucketEntries.forEach(([type, n]) => {
        const color = BUCKET_COLORS[type] || '#4a8c96';
        const pill  = el('span', 'domain-type-pill', `${type}\u00a0${n}`);
        pill.style.background = `${color}22`;
        pill.style.color      = BUCKET_COLORS[type] || '#7ecfdb';
        pill.style.border     = `1px solid ${color}44`;
        breakdown.appendChild(pill);
      });
      info.appendChild(breakdown);
    }

    const barWrap = el('div', 'domain-bar-wrap');
    barWrap.style.marginTop = '4px';
    const bar = el('div', 'domain-bar');
    bar.style.width = `${pct}%`;
    barWrap.appendChild(bar);
    info.appendChild(barWrap);

    row.appendChild(info);
    row.appendChild(el('div', 'domain-count', String(count)));
    list.appendChild(row);
  });

  container.appendChild(list);

  if (domains.length > 60) {
    const note = el('div', 'no-results');
    note.textContent = `Showing top 60 of ${domains.length} domains.`;
    container.appendChild(note);
  }

  // Export domains button
  const exportBtn = el('button', 'btn-secondary');
  exportBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Export Domains CSV`;
  exportBtn.addEventListener('click', () => {
    const csv = 'Rank,Domain,Total,Primary,Grouped,Footnote,Supporting\n' +
      domains.map((d, i) =>
        [i + 1, `"${d.domain}"`, d.count,
         d.buckets.Primary || 0, d.buckets.Grouped || 0,
         d.buckets.Footnote || 0, d.buckets.Supporting || 0
        ].join(',')
      ).join('\n');
    downloadFile(csv, 'fanout_domains.csv', 'text/csv');
  });
  container.appendChild(exportBtn);
}

/* ── HISTORY TAB ────────────────────────────────────────── */

function renderHistoryTab(container) {
  if (!state.history.length) {
    container.appendChild(el('div', 'no-results', 'No history yet. Analyze a conversation to get started.'));
    return;
  }

  const heading = el('div', 'tab-heading');
  heading.textContent = `${state.history.length} saved analysis${state.history.length === 1 ? '' : 'es'}`;
  container.appendChild(heading);

  const list = el('div', 'history-list');

  state.history.forEach((entry, i) => {
    const date = new Date(entry.timestamp).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const row = el('div', 'history-row');
    const info = el('div', 'history-info');
    info.appendChild(el('div', 'history-title', entry.title));
    const meta = el('div', 'history-meta',
      `${date} · ${entry.stats?.queries || 0} queries · ${entry.stats?.citations || 0} citations · ${entry.stats?.uniqueDomains || 0} domains`
    );
    info.appendChild(meta);
    row.appendChild(info);

    const loadBtn = el('button', 'btn-load', 'Load');
    loadBtn.addEventListener('click', () => loadFromHistory(i));
    row.appendChild(loadBtn);
    list.appendChild(row);
  });

  container.appendChild(list);

  const clearBtn = el('button', 'btn-danger', 'Clear History');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear all saved analysis history?')) return;
    state.history = [];
    await chrome.storage.local.remove(STORAGE_KEY);
    container.innerHTML = '';
    renderHistoryTab(container);
  });
  container.appendChild(clearBtn);
}

/* ════════════════════════════════════════════════════════════
   EXPORTS
════════════════════════════════════════════════════════════ */

function escCsv(val) {
  if (val == null) return '""';
  return '"' + String(val).replace(/"/g, '""') + '"';
}

function downloadFile(content, filename, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(title) {
  return (title || 'fanout').replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 50);
}

function exportCSV() {
  const { grps, title } = state.data;

  const rows = [
    ['Prompt', 'Section', 'Type', 'Title', 'URL', 'Snippet', 'Rank', 'RefIndex', 'Date', 'Attribution'],
  ];

  grps.forEach(g => {
    for (const [name, col] of Object.entries(SECTIONS)) {
      if (!state.sectionVis[name]) continue;
      g[col.key].forEach(item => {
        rows.push([
          g.p,
          name,
          item.t  || '',
          item.ti || item.t || '',
          item.u  || '',
          item.sn || '',
          item.r  ?? '',
          item.ri ?? '',
          item.dt || '',
          item.at || '',
        ]);
      });
    }
  });

  const csv = rows.map(r => r.map(escCsv).join(',')).join('\n');
  downloadFile(csv, `fanout_${safeName(title)}.csv`, 'text/csv');
}

function exportJSON() {
  const { grps, title, stats, cid, timestamp, domains } = state.data;
  const payload = { title, conversationId: cid, exportedAt: new Date(timestamp).toISOString(), stats, domains, groups: grps };
  downloadFile(JSON.stringify(payload, null, 2), `fanout_${safeName(title)}.json`, 'application/json');
}

function exportMarkdown() {
  const { grps, title } = state.data;
  let md = `# ${title}\n\n*Analyzed with [Fanout](https://github.com/samsteiner) by Sam Steiner*\n\n---\n\n`;

  grps.forEach((g, i) => {
    md += `## Prompt ${i + 1}\n\n> ${g.p}\n\n`;

    if (g.q.length) {
      md += `### Search Queries\n\n`;
      g.q.forEach(q => {
        md += `- ${q.t}${q.ai ? ' *(AI-generated)*' : ' *(user)*'}\n`;
      });
      md += '\n';
    }
    if (g.l.length) {
      md += `### Primary Citations\n\n`;
      g.l.forEach(x => { md += `- [${x.ti}](${x.u})\n`; });
      md += '\n';
    }
    if (g.fn.length) {
      md += `### Footnote Sources\n\n`;
      g.fn.forEach(x => { md += `- [${x.ti}](${x.u})\n`; });
      md += '\n';
    }
    if (g.en.length) {
      md += `### Entities\n\n`;
      g.en.forEach(x => { md += `- **${x.ti}** — ${x.sn}\n`; });
      md += '\n';
    }
    if (g.dc.length) {
      md += `### Model\n\n${g.dc[0].ti}\n\n`;
    }

    md += '---\n\n';
  });

  downloadFile(md, `fanout_${safeName(title)}.md`, 'text/markdown');
}

/* ════════════════════════════════════════════════════════════
   COLUMN TOGGLES
════════════════════════════════════════════════════════════ */

function renderColumnToggles() {
  const container = $('col-toggles');
  container.innerHTML = '';

  // ── Show / Hide All ──────────────────────────────────────
  const allLabel = document.createElement('label');
  allLabel.className = 'toggle-label toggle-label-all';

  const allCheckbox = document.createElement('input');
  allCheckbox.type = 'checkbox';
  allCheckbox.id   = 'toggle-all';

  const allChecked = Object.keys(SECTIONS).every(n => state.sectionVis[n]);
  const anyChecked = Object.keys(SECTIONS).some(n => state.sectionVis[n]);
  allCheckbox.checked       = allChecked;
  allCheckbox.indeterminate = !allChecked && anyChecked;

  allCheckbox.addEventListener('change', e => {
    const val = e.target.checked;
    for (const name of Object.keys(SECTIONS)) state.sectionVis[name] = val;
    renderColumnToggles(); // re-render to sync individual checkboxes
    if (state.data && state.activeTab === 'analysis') renderActiveTab();
  });

  const allSpan = document.createElement('span');
  allSpan.textContent = 'Show / Hide All';

  allLabel.appendChild(allCheckbox);
  allLabel.appendChild(allSpan);
  container.appendChild(allLabel);

  // ── Divider ──────────────────────────────────────────────
  const divider = document.createElement('div');
  divider.className = 'col-divider';
  container.appendChild(divider);

  // ── Individual toggles ───────────────────────────────────
  for (const name of Object.keys(SECTIONS)) {
    const label = document.createElement('label');
    label.className = 'toggle-label';

    const checkbox = document.createElement('input');
    checkbox.type    = 'checkbox';
    checkbox.checked = state.sectionVis[name];
    checkbox.dataset.col = name;

    checkbox.addEventListener('change', e => {
      state.sectionVis[name] = e.target.checked;
      // Update the "all" checkbox state without full re-render
      const allCb      = $('toggle-all');
      const allNowOn   = Object.keys(SECTIONS).every(n => state.sectionVis[n]);
      const anyNowOn   = Object.keys(SECTIONS).some(n => state.sectionVis[n]);
      allCb.checked       = allNowOn;
      allCb.indeterminate = !allNowOn && anyNowOn;
      if (state.data && state.activeTab === 'analysis') renderActiveTab();
    });

    const span = document.createElement('span');
    span.textContent = name;

    label.appendChild(checkbox);
    label.appendChild(span);
    container.appendChild(label);
  }
}

/* ════════════════════════════════════════════════════════════
   UI HELPERS
════════════════════════════════════════════════════════════ */

function setLoading(loading) {
  const btn = $('btn-analyze');
  if (loading) {
    $('tab-content').innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <div>Fetching conversation data…</div>
      </div>`;
    $('empty-state').classList.add('hidden');
    btn.textContent = 'Analyzing…';
    btn.disabled    = true;
  } else {
    btn.textContent = 'Analyze';
    btn.disabled    = false;
  }
}

function showError(msg) {
  $('empty-state').classList.add('hidden');
  const wrap = el('div', 'error-state');
  wrap.appendChild(el('div', 'error-icon', '⚠'));
  wrap.appendChild(el('div', 'error-msg', msg));
  const content = $('tab-content');
  content.innerHTML = '';
  content.appendChild(wrap);
}

/* ════════════════════════════════════════════════════════════
   DROPDOWN HELPERS
════════════════════════════════════════════════════════════ */

function toggleDropdown(_btnId, menuId) {
  const menu   = $(menuId);
  const isOpen = !menu.classList.contains('hidden');

  // Close all dropdowns first
  document.querySelectorAll('.col-dropdown, .export-menu').forEach(m =>
    m.classList.add('hidden')
  );

  if (!isOpen) menu.classList.remove('hidden');
}

// Close dropdowns when clicking outside
document.addEventListener('click', e => {
  const inside =
    e.target.closest('.col-toggle-wrap') ||
    e.target.closest('.export-menu-wrap');
  if (!inside) {
    document.querySelectorAll('.col-dropdown, .export-menu').forEach(m =>
      m.classList.add('hidden')
    );
  }
});

/* ════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════ */

async function init() {
  await loadHistory();
  renderColumnToggles();

  // ── Nav tabs ─────────────────────────────────────────────
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;

      if (state.data) {
        renderAll();
      } else if (state.activeTab === 'history') {
        $('empty-state').classList.add('hidden');
        $('nav-tabs').classList.remove('hidden');
        $('controls').classList.add('hidden');
        renderHistoryTab($('tab-content'));
      }
    });
  });

  // ── Analyze button ───────────────────────────────────────
  $('btn-analyze').addEventListener('click', analyzeConversation);

  // ── Search ───────────────────────────────────────────────
  const searchInput = $('search-input');
  const clearBtn    = $('btn-clear-search');

  searchInput.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    clearBtn.classList.toggle('hidden', !state.searchQuery);
    if (state.data) renderAnalysisTab($('tab-content'));
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value  = '';
    state.searchQuery  = '';
    clearBtn.classList.add('hidden');
    if (state.data) renderAnalysisTab($('tab-content'));
  });

  // ── Expand / Collapse all ────────────────────────────────
  $('btn-expand').addEventListener('click', () => {
    if (!state.data) return;
    state.expanded = new Set(state.data.grps.map((_, i) => i));
    renderAnalysisTab($('tab-content'));
  });

  $('btn-collapse').addEventListener('click', () => {
    state.expanded = new Set();
    if (state.data) renderAnalysisTab($('tab-content'));
  });

  // ── Dropdowns ────────────────────────────────────────────
  $('btn-cols').addEventListener('click', e => {
    e.stopPropagation();
    toggleDropdown('btn-cols', 'col-dropdown');
  });

  $('btn-export-toggle').addEventListener('click', e => {
    e.stopPropagation();
    toggleDropdown('btn-export-toggle', 'export-menu');
  });

  // ── Exports ──────────────────────────────────────────────
  $('btn-export-csv').addEventListener('click', () => {
    if (state.data) { exportCSV(); $('export-menu').classList.add('hidden'); }
  });
  $('btn-export-json').addEventListener('click', () => {
    if (state.data) { exportJSON(); $('export-menu').classList.add('hidden'); }
  });
  $('btn-export-md').addEventListener('click', () => {
    if (state.data) { exportMarkdown(); $('export-menu').classList.add('hidden'); }
  });

  // Show history tab if there's history but no active analysis
  if (state.history.length && !state.data) {
    $('nav-tabs').classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', init);
