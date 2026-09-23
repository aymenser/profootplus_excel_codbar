const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3001;

/* ============================================================
   USER-AGENT ROTATION
   A single fixed UA on every request is one of the easier signals
   Bing can use to fingerprint "this is a script, not a browser."
   Rotating across a handful of common real desktop UAs is free and
   makes traffic look a little less monolithic. This is not a fix
   for aggressive blocking — nothing free really is — but it costs
   nothing and can't hurt.
   ============================================================ */
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
function pickUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/* ============================================================
   BLOCK / CAPTCHA DETECTION
   A silent "no images found" is ambiguous: it could mean the query
   genuinely has no results, or it could mean Bing served a CAPTCHA /
   "unusual traffic" interstitial instead of a real results page. We
   want the client to be able to tell these apart and retry-with-
   backoff on the latter instead of falling straight to a low-
   confidence guess.

   IMPORTANT: this must fail SAFE. An earlier version of this check
   scanned only the first 20,000 characters for the "iusc" marker and
   treated its absence there as a block signal — but Bing's <head>,
   scripts, and page chrome can easily push the actual tile grid past
   that offset on legitimate, completely normal responses. That bug
   caused every real result to be misclassified as "blocked" and
   rejected with a 429, which is worse than not detecting blocks at
   all. So now: only ever mark something as blocked when we see an
   explicit, unambiguous block signal (captcha/challenge keywords, or
   a suspiciously tiny response body). We deliberately do NOT try to
   infer blocking from the *absence* of "iusc" anywhere in the page —
   that absence just means "parse this normally and let it come back
   as zero real candidates," which the rest of the pipeline already
   handles correctly (via the existing retry-with-looser-query logic
   on the client).
   ============================================================ */
function looksLikeBlockPage(html) {
    if (!html) return true;
    if (html.length < 500) return true; // real pages, blocked or not, are rarely this tiny — likely a network-level error page
    const lower = html.toLowerCase(); // scan the FULL response — block markers can appear anywhere, and false negatives here are cheap while false positives are expensive
    return (
        lower.includes('captcha') ||
        lower.includes('unusual traffic') ||
        lower.includes('automated queries') ||
        lower.includes('g-recaptcha') ||
        lower.includes('/challenge')
    );
}

/* ============================================================
   SINGLE-PAGE FETCH + PARSE
   Pulls one "batch" of tiles from Bing at a given offset (`first`).
   Bing's Images search server-renders roughly one batch per request;
   everything past that is loaded by client-side JS as the user
   scrolls, which a plain HTTP fetch never triggers. Requesting
   multiple offsets and merging is the closest a scraper (no paid
   API) can get to "what a human sees after scrolling."
   ============================================================ */
async function fetchBingPage(query, offset) {
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=${offset}&count=35&safeSearch=off&setmkt=en-US`;

    const res = await fetch(searchUrl, {
        headers: {
            'User-Agent': pickUserAgent(),
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
    });

    if (!res.ok) {
        return { html: null, error: `HTTP ${res.status}`, blocked: false };
    }

    const html = await res.text();
    if (looksLikeBlockPage(html)) {
        return { html: null, error: 'Bing served a block/CAPTCHA-like page', blocked: true };
    }

    return { html, error: null, blocked: false };
}

/* ============================================================
   ADULT-CONTENT FILTER
   safeSearch=off (see fetchBingPage) is there so legitimate but
   borderline apparel photos (swimwear, activewear) don't get
   wrongly filtered by Bing's own safe-search. The cost is that when
   a query returns few real matches, Bing can pad the result set with
   genuinely unrelated filler pulled from anywhere in its index —
   and with safe search off, that filler isn't curated either. A
   "Reebok fj4057" search coming back with an explicit image is not
   hypothetical; it happened. This is a hard, unconditional filter —
   it runs before anything else touches the tile (matching,
   verification, quick-picks preview), so flagged content can never
   reach any part of the pipeline or UI, regardless of query or
   brand/SKU match status.
   ============================================================ */
const ADULT_CONTENT_SIGNALS = [
    'porn', 'pornhub', 'xxx', 'xhamster', 'xvideos', 'redtube', 'youporn', 'brazzers',
    'hentai', 'nsfw', 'nude', 'nudes', 'naked', 'topless', 'hardcore', 'onlyfans',
    'playboy', 'escort', 'camgirl', 'fetish', 'bdsm', 'creampie', 'cumshot', 'blowjob',
    'gangbang', 'threesome', 'milf', 'anal sex', 'sex scene', 'sex video', 'jav555',
    'xhcdn', 'motherlesspics', 'babesandgirls', 'asiapornphoto', 'celeb.gate',
];
function looksLikeAdultContent(item) {
    const text = [item.title, item.url, item.murl, item.turl, item.purl].filter(Boolean).join(' ').toLowerCase();
    return ADULT_CONTENT_SIGNALS.some(sig => text.includes(sig));
}

function parseTiles(html) {
    const tileRegex = /class="iusc"[^>]*m="([^"]+)"/g;
    const items = [];
    let match;

    while ((match = tileRegex.exec(html)) !== null) {
        const jsonAttr = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');

        let parsed = null;
        try { parsed = JSON.parse(jsonAttr); } catch (e) { /* fall through to regex fallbacks below */ }

        const turl = parsed?.turl || (/"turl":"([^"]+)"/.exec(jsonAttr)?.[1] || '').replace(/\\\//g, '/');
        const murl = parsed?.murl || (/"murl":"([^"]+)"/.exec(jsonAttr)?.[1] || '').replace(/\\\//g, '/');
        const purl = parsed?.purl || (/"purl":"([^"]+)"/.exec(jsonAttr)?.[1] || '').replace(/\\\//g, '/');
        const title = parsed?.t || parsed?.pft || (/"t":"([^"]+)"/.exec(jsonAttr)?.[1] || '');

        const displayUrl = murl || turl;
        if (displayUrl) {
            items.push({ url: displayUrl, title, murl, turl, purl });
        }
    }
    return items;
}

// Bing's grid also renders a companion <img class="mimg" ... width=".." height=".."
// data-src="...thumbnail..."> tag right after each iusc block. Pulling width/
// height from there lets us reject tiny/placeholder/icon-sized tiles
// server-side, before the client ever downloads the full image — a free
// quality gate with zero extra network cost.
function parseTilesWithDims(html) {
    const items = [];
    const blockRegex = /class="iusc"[^>]*m="([^"]+)"[^>]*>[\s\S]{0,400}?<img[^>]*class="mimg"[^>]*width="(\d+)"[^>]*height="(\d+)"/g;
    const seen = new Set();
    let match;

    while ((match = blockRegex.exec(html)) !== null) {
        const jsonAttr = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const w = parseInt(match[2], 10);
        const h = parseInt(match[3], 10);

        let parsed = null;
        try { parsed = JSON.parse(jsonAttr); } catch (e) {}

        const turl = parsed?.turl || (/"turl":"([^"]+)"/.exec(jsonAttr)?.[1] || '').replace(/\\\//g, '/');
        const murl = parsed?.murl || (/"murl":"([^"]+)"/.exec(jsonAttr)?.[1] || '').replace(/\\\//g, '/');
        const purl = parsed?.purl || (/"purl":"([^"]+)"/.exec(jsonAttr)?.[1] || '').replace(/\\\//g, '/');
        const title = parsed?.t || parsed?.pft || (/"t":"([^"]+)"/.exec(jsonAttr)?.[1] || '');

        const displayUrl = murl || turl;
        if (displayUrl && !seen.has(displayUrl)) {
            seen.add(displayUrl);
            items.push({ url: displayUrl, title, murl, turl, purl, thumbW: w || null, thumbH: h || null });
        }
    }

    // Any tile the width/height-aware regex missed (layout variance,
    // Bing occasionally omits the mimg tag shape we expect) still gets
    // picked up by the plain parser so we don't lose candidates outright
    // — they just won't have thumbW/thumbH set.
    const plain = parseTiles(html);
    for (const item of plain) {
        if (!seen.has(item.url)) {
            seen.add(item.url);
            items.push(item);
        }
    }

    return items;
}

/* ============================================================
   MULTI-PAGE FETCH — the actual pagination fix.
   Fetches up to `pages` batches at increasing offsets and merges/
   dedupes them. This is what lets the proxy approximate "scroll a
   few times" instead of only ever seeing Bing's first render.
   ============================================================ */
async function fetchBingMultiPage(query, targetCount, maxPages) {
    const allItems = [];
    const seenUrls = new Set();
    let blockedAnyPage = false;
    let pagesFetched = 0;

    for (let page = 0; page < maxPages; page++) {
        const offset = page * 35;
        const { html, error, blocked } = await fetchBingPage(query, offset);
        pagesFetched++;

        if (blocked) {
            blockedAnyPage = true;
            break; // stop paging once blocked — further requests just burn the rate limit further
        }
        if (error || !html) break;

        const tiles = parseTilesWithDims(html).filter(item => !looksLikeAdultContent(item));
        if (tiles.length === 0) break; // ran past the last real page of results

        let addedThisPage = 0;
        for (const item of tiles) {
            if (!seenUrls.has(item.url)) {
                seenUrls.add(item.url);
                allItems.push(item);
                addedThisPage++;
            }
        }

        if (allItems.length >= targetCount) break;
        if (addedThisPage === 0) break; // page returned nothing new — later pages won't help either

        // Small randomized delay between page requests. Free, and reduces
        // how "bursty"/scripted the request pattern looks compared to
        // firing every offset back-to-back with zero spacing.
        await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
    }

    return { items: allItems, blocked: blockedAnyPage, pagesFetched };
}

app.get('/api/bing/search', async (req, res) => {
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query param "q".' });

    const max = Math.min(parseInt(limit, 10) || 10, 70); // raised ceiling since multi-page can genuinely produce more

    try {
        // Multi-page fetching doubles (or more) the request volume per
        // product, which directly raises block/rate-limit risk — and the
        // pipeline already runs several products concurrently (see
        // CONCURRENCY in pipeline.js), so this multiplies fast across a
        // batch. Given the earlier false-positive block detection made
        // this hard to evaluate honestly, default back to a single page
        // (matching the original, known-working behavior) and only pull
        // a second page when a caller explicitly asks for more than the
        // 35-per-page ceiling via `limit`. This keeps the pagination
        // capability available without silently doubling every request
        // a normal catalog run makes.
        const maxPages = max > 35 ? 2 : 1;
        const { items, blocked, pagesFetched } = await fetchBingMultiPage(q, max, maxPages);

        if (blocked && items.length === 0) {
            // Distinct status code from "genuinely no results" so the client
            // can retry-with-backoff instead of treating this as a dead end.
            return res.status(429).json({ error: 'Bing appears to be rate-limiting/blocking this request.', blocked: true });
        }

        if (!items.length) {
            const payload = { error: 'Bing: no image tiles found.' };
            return res.status(502).json(payload);
        }

        const payload = { query: q, images: items.slice(0, max), pagesFetched, blocked };

        // OFF-TOPIC SIGNAL (informational only — just flags the response
        // for the client's diagnosis text). If literally none of the
        // returned titles share a word with the query, this smells like
        // Bing backfilling a thin result set with unrelated filler rather
        // than a real match on "q".
        const queryTokens = q.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
        const hasAnyOverlap = queryTokens.length === 0 || items.some(it => {
            const t = (it.title || '').toLowerCase();
            return queryTokens.some(tok => t.includes(tok));
        });
        if (!hasAnyOverlap) payload.suspectedOffTopic = true;

        res.json(payload);
    } catch (err) {
        res.status(502).json({ error: `Failed to reach Bing: ${err.message}` });
    }
});

app.get('/api/health', (req, res) => res.json({ ok: true, proxyType: 'Bing Only (multi-page)' }));

app.listen(PORT, () => {
    console.log(`Pipeline API running at http://localhost:${PORT} (Bing only, multi-page — every request hits Bing fresh)`);
});