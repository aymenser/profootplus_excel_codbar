/* ============================================================
   STATE
   ============================================================ */
const state = {
    products: [],              // one pipeline item per product_colors row
    results: {},                // productId -> debug object (includes slotAssignments)
    filteredIndices: null,      // when attention filter is on: array of indices into state.products
};

const SLOTS = ['A', 'B', 'C', 'D', 'E'];
const SERVER_BASE = 'http://localhost:3001';

// Supabase is used only by this linking page for loading catalog/color
// records and committing the selected image URLs back to product_colors.images.
const SUPABASE_URL = 'https://vdibwjoenpzqydjttuvh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkaWJ3am9lbnB6cXlkanR0dXZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNTcyMjAsImV4cCI6MjEwNTczMzIyMH0.09j-rb0UxwTJKdS7QoRzk6JDjjTLLYhxYGi7C_uP6YY';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// How many products' pipelines run at the same time. Raising this speeds
// throughput but hits the Bing proxy harder; lower it if you see 502s.
const CONCURRENCY = 6;

const $ = (id) => document.getElementById(id);

/* ============================================================
   STATUS (rAF-batched so thousands of updates/sec don't cause
   thousands of style/layout reflows)
   ============================================================ */
let pendingStatusText = null;
function setStatus(text) {
    pendingStatusText = text;
    scheduleFlush();
}

let flushScheduled = false;
function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(() => {
        flushScheduled = false;
        if (pendingStatusText !== null) {
            const el = $('statusHeader');
            if (el) el.textContent = pendingStatusText;
            pendingStatusText = null;
        }
    });
}

/* ============================================================
   LIVE FILTERING — brand (dropdown, exact match), category
   (dropdown, exact match against shoes/tops/bottoms/general),
   and "needs attention" (empty or unverified slots).
   All three combine with AND logic.
   ============================================================ */
state.filters = { brand: 'all', category: 'all', attentionOnly: false, tier: 'all' };

function isAnyFilterActive() {
    return !!((state.filters.brand && state.filters.brand !== 'all') || (state.filters.category && state.filters.category !== 'all') || state.filters.attentionOnly || (state.filters.tier && state.filters.tier !== 'all'));
}

function productNeedsAttention(product) {
    const r = state.results[product.id];
    if (!r) return false; // still queued/processing — don't flag yet
    return !!(r._needsAttention || r.totalAssigned < 5);
}

// "Sort by Tier" — surfaces the products most worth a manual double
// check first. A single "worst filled slot" number is too blunt: it
// treats a 5/5 row with one weak slot the same as an all-weak 5/5 row,
// and it can't tell "1/5 filled with a great match" from "genuinely
// nothing usable yet." Instead we rank on an ordered set of criteria,
// each only breaking ties left by the one before it:
//
//   1. Still processing (no result yet)     — unknown, so first: needs eyes
//   2. Empty slot count, most empty first   — bigger gaps are more urgent
//   3. Used the unverified fallback path    — flagged over normal misses
//   4. Average confidence rank of filled    — worse *overall* quality first
//      slots (not just the single worst one)
//   5. Worst single filled slot             — breaks ties between rows
//      (highest/least-confident tier first)   with the same average
//   6. Product ID                           — stable, deterministic
//      (numeric-aware compare)                 final tiebreak
//
// This means "5/5 filled but mostly weak tiers" correctly outranks
// "5/5 filled, one so-so slot", and "0/5 filled" always outranks a
// product that has at least something usable.
state.sortByTier = false;

function productTierSortKey(product) {
    const r = state.results[product.id];

    const stillProcessing = !r || !r.slotAssignments ? 1 : 0;
    if (stillProcessing) {
        // Nothing else is knowable yet — sort these first, in stable
        // product order, ahead of anything with actual results.
        return { stillProcessing: 1, emptyCount: 5, fallbackUsed: 1, avgRank: -1, worstRank: -1 };
    }

    const filled = SLOTS.map(s => r.slotAssignments[s]).filter(Boolean);
    const emptyCount = SLOTS.length - filled.length;
    const fallbackUsed = r.fallbackUsed ? 1 : 0;

    if (filled.length === 0) {
        return { stillProcessing: 0, emptyCount, fallbackUsed, avgRank: CONFIDENCE_TIERS.length, worstRank: CONFIDENCE_TIERS.length };
    }

    const ranks = filled.map(a => confidenceRank(a.confidence));
    const avgRank = ranks.reduce((sum, v) => sum + v, 0) / ranks.length;
    const worstRank = Math.max(...ranks);

    return { stillProcessing: 0, emptyCount, fallbackUsed, avgRank, worstRank };
}

// Numeric-aware ID compare so "9" sorts before "10" (falls back to a
// plain string compare for non-numeric IDs).
function compareProductIds(a, b) {
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
}

function compareByTier(productA, productB) {
    const a = productTierSortKey(productA);
    const b = productTierSortKey(productB);

    // Worse-first ordering at every step: bigger number = needs more
    // attention = sorts earlier (return negative).
    if (a.stillProcessing !== b.stillProcessing) return b.stillProcessing - a.stillProcessing;
    if (a.emptyCount !== b.emptyCount) return b.emptyCount - a.emptyCount;
    if (a.fallbackUsed !== b.fallbackUsed) return b.fallbackUsed - a.fallbackUsed;
    if (a.avgRank !== b.avgRank) return b.avgRank - a.avgRank;
    if (a.worstRank !== b.worstRank) return b.worstRank - a.worstRank;
    return compareProductIds(productA.id, productB.id);
}

function rebuildFilteredIndices() {
    if (!isAnyFilterActive()) {
        state.filteredIndices = null;
        return;
    }
    const brandFilter = state.filters.brand;
    const catFilter = (state.filters.category || 'all').toLowerCase();
    const attentionOnly = state.filters.attentionOnly;
    const tierFilter = state.filters.tier;

    const indices = [];
    state.products.forEach((p, idx) => {
        if (brandFilter && brandFilter !== 'all' && p.brand !== brandFilter) return;
        if (catFilter && catFilter !== 'all' && normalizeCategoryBucket(p.category) !== catFilter) return;
        if (attentionOnly && !productNeedsAttention(p)) return;
        if (tierFilter && tierFilter !== 'all' && productTierBucket(p) !== tierFilter) return;
        indices.push(idx);
    });
    state.filteredIndices = indices;
}

function updateFilterCount() {
    const el = $('filterCount');
    if (!el) return;
    if (!isAnyFilterActive()) { el.textContent = ''; return; }
    const shown = state.filteredIndices ? state.filteredIndices.length : state.products.length;
    el.textContent = `${shown} of ${state.products.length} shown`;
}

// Called directly by filter UI controls — runs immediately.
function applyFiltersNow() {
    rebuildFilteredIndices();
    virtualList.refresh();
    updateFilterCount();
}

// Called from the pipeline as products finish / images change.
// Only touches the DOM list (expensive for big catalogs) when a
// filter is actually active, and batches rapid-fire calls into a
// single rAF-scheduled refresh instead of one per product.
let filterRefreshScheduled = false;
function requestFilterRefresh() {
    if (!isAnyFilterActive()) {
        state.filteredIndices = null;
        return;
    }
    if (filterRefreshScheduled) return;
    filterRefreshScheduled = true;
    requestAnimationFrame(() => {
        filterRefreshScheduled = false;
        applyFiltersNow();
    });
}

const CATEGORY_BUCKETS = ['shoes', 'tops', 'bottoms', 'general'];

// Catalog category text is free-form ("Sneakers", "Shirts", "Denim",
// "Footwear", plural/singular, different casing...), so requiring an
// exact match against the 4 fixed bucket names left the dropdown
// empty for any real-world file. This maps common variants to one of
// the 4 buckets; anything unrecognized still falls back to "general"
// so no product silently becomes unfilterable.
const CATEGORY_BUCKET_SYNONYMS = {
    shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'footwear', 'boot', 'boots', 'sandals', 'sandal', 'heels', 'trainers', 'trainer', 'cleats'],
    tops: ['top', 'tops', 'shirt', 'shirts', 't-shirt', 'tshirt', 'tee', 'tees', 'blouse', 'blouses', 'sweater', 'sweaters', 'hoodie', 'hoodies', 'jacket', 'jackets', 'coat', 'coats', 'sweatshirt', 'sweatshirts', 'polo', 'polos', 'outerwear'],
    bottoms: ['bottom', 'bottoms', 'pant', 'pants', 'jean', 'jeans', 'denim', 'trouser', 'trousers', 'short', 'shorts', 'skirt', 'skirts', 'legging', 'leggings', 'joggers', 'jogger'],
};

// Normalizes any raw category string down to one of CATEGORY_BUCKETS.
// Matches on a singularized, lowercased token so "Sneaker"/"Sneakers"/
// "SNEAKERS" all land in the same bucket. Falls back to 'general'.
function normalizeCategoryBucket(rawCategory) {
    const raw = (rawCategory || '').trim().toLowerCase();
    if (!raw) return 'general';
    if (CATEGORY_BUCKETS.includes(raw)) return raw;

    // check each word in a multi-word category value, not just the whole string
    const words = raw.split(/[\s/_-]+/).filter(Boolean);
    for (const [bucket, synonyms] of Object.entries(CATEGORY_BUCKET_SYNONYMS)) {
        if (words.some(w => synonyms.includes(w))) return bucket;
    }
    return 'general';
}

function populateCategoryOptions(items) {
    const sel = $('filterCategory');
    if (!sel) return;
    // Offer only the buckets actually present after normalization, so
    // e.g. "General" isn't shown for a catalog that's 100% shoes.
    const present = new Set(items.map(p => normalizeCategoryBucket(p.category)));
    const available = CATEGORY_BUCKETS.filter(c => present.has(c));
    sel.innerHTML = '<option value="all">All Categories</option>' +
        available.map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('');
}

function populateBrandOptions(items) {
    const sel = $('filterBrand');
    if (!sel) return;
    const brands = Array.from(new Set(items.map(p => (p.brand || '').trim()).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b));
    sel.innerHTML = '<option value="all">All Brands</option>' +
        brands.map(b => `<option value="${b.replace(/"/g, '&quot;')}">${b}</option>`).join('');
}

const filterBrandEl = $('filterBrand');
if (filterBrandEl) {
    filterBrandEl.addEventListener('change', () => {
        state.filters.brand = filterBrandEl.value;
        applyFiltersNow();
    });
}

const filterCategoryEl = $('filterCategory');
if (filterCategoryEl) {
    filterCategoryEl.addEventListener('change', () => {
        state.filters.category = filterCategoryEl.value;
        applyFiltersNow();
    });
}

const filterToggleEl = $('filterAttentionToggle');
if (filterToggleEl) {
    filterToggleEl.addEventListener('change', () => {
        state.filters.attentionOnly = filterToggleEl.checked;
        applyFiltersNow();
    });
}

const filterTierEl = $('filterTier');
if (filterTierEl) {
    filterTierEl.addEventListener('change', () => {
        state.filters.tier = filterTierEl.value;
        applyFiltersNow();
    });
}

const sortByTierBtn = $('sortByTierBtn');
if (sortByTierBtn) {
    sortByTierBtn.addEventListener('click', () => {
        state.sortByTier = !state.sortByTier;
        sortByTierBtn.setAttribute('aria-pressed', String(state.sortByTier));
        virtualList.refresh();
    });
}

const filterClearBtn = $('filterClearBtn');
if (filterClearBtn) {
    filterClearBtn.addEventListener('click', () => {
        state.filters = { brand: 'all', category: 'all', attentionOnly: false, tier: 'all' };
        if (filterBrandEl) filterBrandEl.value = 'all';
        if (filterCategoryEl) filterCategoryEl.value = 'all';
        if (filterToggleEl) filterToggleEl.checked = false;
        if (filterTierEl) filterTierEl.value = 'all';
        applyFiltersNow();
    });
}

const resetTrustBtn = $('resetTrustBtn');
if (resetTrustBtn) {
    resetTrustBtn.addEventListener('click', () => {
        const trust = loadLearnedTrust();
        const domainCount = Object.keys(trust).length;
        if (domainCount === 0) {
            resetTrustBtn.textContent = 'No learned data yet';
            setTimeout(() => { resetTrustBtn.textContent = 'Reset Learned Trust'; }, 1800);
            return;
        }
        if (!confirm(`Clear learned trust data for ${domainCount} domain(s)? This only affects ranking in this browser and can't be undone.`)) return;
        learnedDomainTrust = {};
        saveLearnedTrust();
        resetTrustBtn.textContent = `Cleared ${domainCount} domain(s)`;
        setTimeout(() => { resetTrustBtn.textContent = 'Reset Learned Trust'; }, 1800);
    });
}

/* ============================================================
   DATABASE LOAD + COMMIT PERSISTENCE
   ============================================================ */
function normalizeDbImages(images) {
    if (Array.isArray(images)) return images.filter(v => typeof v === 'string' && v.trim());
    if (typeof images === 'string') {
        try {
            const parsed = JSON.parse(images);
            if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string' && v.trim());
        } catch (e) {}
        return images.split(/\s*,\s*/).filter(Boolean);
    }
    return [];
}

function resetPipelineState(items) {
    state.products = items;
    state.productsById = new Map(items.map(p => [String(p.id), p]));
    state.results = {};
    state.filteredIndices = null;
    state.filters = { brand: 'all', category: 'all', attentionOnly: false, tier: 'all' };
    state.sortByTier = false;

    if (filterBrandEl) filterBrandEl.value = 'all';
    if (filterCategoryEl) filterCategoryEl.value = 'all';
    if (filterToggleEl) filterToggleEl.checked = false;
    if (filterTierEl) filterTierEl.value = 'all';
    if (sortByTierBtn) sortByTierBtn.setAttribute('aria-pressed', 'false');

    const filterBarEl = $('filterBar');
    if (filterBarEl) filterBarEl.style.display = items.length ? 'flex' : 'none';
    populateBrandOptions(items);
    populateCategoryOptions(items);
    populateTierFilterOptions();
    updateFilterCount();

    const copyLogContainerEl = $('copyLogContainer');
    if (copyLogContainerEl) copyLogContainerEl.innerHTML = '';

    virtualList.setItems(items);
}

async function loadCatalogForImageLinking() {
    const statusEl = $('statusHeader');
    const hintEl = $('pageHint');
    try {
        if (statusEl) statusEl.textContent = 'loading catalog…';
        if (hintEl) hintEl.textContent = 'Loading products and their colors from Supabase…';

        const { data, error } = await sb
            .from('products')
            .select(`
                id,
                designation,
                famille,
                sous_famille,
                product_colors (
                    id,
                    code_modele,
                    color,
                    images
                )
            `);
        if (error) throw error;

        const items = [];
        (data || []).forEach(product => {
            const colors = product.product_colors || [];
            colors.forEach((color, colorIndex) => {
                const designation = String(product.designation || '').trim();
                const codeModele = String(color.code_modele || '').trim();
                items.push({
                    // Pipeline identity is the COLOR row, not the parent product.
                    // This guarantees each color receives its own 5-image result.
                    id: String(color.id),
                    colorId: color.id,
                    parentProductId: product.id,
                    parentLabel: designation || `Product ${String(product.id).slice(0, 8)}`,
                    parentMeta: [product.famille, product.sous_famille].filter(Boolean).join(' · '),
                    brand: designation,
                    sku: codeModele,
                    category: [product.famille, product.sous_famille].filter(Boolean).join(' '),
                    color: String(color.color || `Color ${colorIndex + 1}`).trim(),
                    existingImages: normalizeDbImages(color.images),
                });
            });
        });

        resetPipelineState(items);
        if (hintEl) {
            const parentCount = new Set(items.map(x => String(x.parentProductId))).size;
            hintEl.textContent = `${parentCount} product(s) · ${items.length} color branch(es). Each color is searched independently and nothing is saved until you commit.`;
        }

        if (items.length === 0) {
            if (statusEl) statusEl.textContent = 'complete — no color rows found';
            renderCopyLogButton();
            return;
        }

        await runAllPipelines(items);
    } catch (err) {
        console.error('Catalog load failed:', err);
        if (statusEl) statusEl.textContent = 'error loading catalog';
        if (hintEl) hintEl.textContent = `Could not load products: ${err.message}`;
        const rows = $('productRows');
        if (rows) rows.innerHTML = `<div class="hint error-hint">Could not load products: ${escapeHtml(err.message)}</div>`;
        throw err;
    }
}

function imagesFromResult(productId) {
    const result = state.results[productId];
    if (!result || !result.slotAssignments) return [];
    return SLOTS
        .map(slot => result.slotAssignments[slot])
        .filter(Boolean)
        .map(a => a.url)
        .filter(Boolean);
}

function markCommitDirty(productId) {
    const result = state.results[productId];
    if (result) {
        result.dirty = true;
        result.committed = false;
    }
    const row = document.getElementById(`row-${String(productId)}`);
    const btn = row && row.querySelector('.rt-commit');
    if (btn) {
        btn.disabled = false;
        btn.textContent = 'Commit';
        btn.classList.remove('is-committed');
    }
}

async function commitColor(productId, buttonEl) {
    const product = state.productsById && state.productsById.get(String(productId));
    if (!product || !product.colorId) return { ok: false, skipped: true };

    const result = state.results[productId];
    if (!result) {
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = 'No result';
        }
        return { ok: false, skipped: true };
    }

    const images = imagesFromResult(productId);
    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Saving…';
    }
    try {
        // IMPORTANT: an UPDATE without .select() can return no row while still
        // producing no error (for example when the target row is filtered by
        // RLS). That used to make the UI show "✓ Committed" even though
        // nothing was actually changed in product_colors.
        const { data: updatedRows, error } = await sb
            .from('product_colors')
            .update({ images })
            .eq('id', product.colorId)
            .select('id, images');
        if (error) throw error;

        if (!updatedRows || updatedRows.length !== 1) {
            throw new Error(
                `Database update matched ${updatedRows ? updatedRows.length : 0} row(s) for product_colors.id=${product.colorId}. ` +
                `Check that this color row exists and that the Supabase RLS UPDATE/SELECT policies allow this browser session to modify it.`
            );
        }

        // Verify the returned database value too. This prevents a false-positive
        // success if the API accepted the request but the stored value differs.
        const savedImages = normalizeDbImages(updatedRows[0].images);
        if (JSON.stringify(savedImages) !== JSON.stringify(images)) {
            throw new Error(
                `Database returned a different images value for product_colors.id=${product.colorId} ` +
                `(expected ${images.length} image(s), got ${savedImages.length}).`
            );
        }

        result.committed = true;
        result.dirty = false;
        result.committedImages = savedImages.slice();
        result._statusText = `committed — ${savedImages.length}/5 image(s) saved to DB`;
        if (buttonEl) {
            buttonEl.textContent = '✓ Committed';
            buttonEl.classList.add('is-committed');
        }
        virtualList.updateProductStatus(productId, result._statusText);
        console.log(`Commit verified: product_colors.id=${product.colorId}`, savedImages);
        return { ok: true, productId, images: savedImages };
    } catch (err) {
        console.error(`Commit failed for color ${product.colorId}:`, err);
        result.committed = false;
        result.dirty = true;
        result._statusText = `save error: ${err.message}`;
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = 'Commit';
        }
        virtualList.updateProductStatus(productId, result._statusText);
        return { ok: false, productId, error: err };
    }
}

async function commitAll() {
    const btn = $('commitAllBtn');
    const status = $('commitAllStatus');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Committing…';
    }
    if (status) status.textContent = '';

    const items = state.products.slice();
    let saved = 0;
    let failed = 0;
    let skipped = 0;

    for (const product of items) {
        const result = state.results[product.id];
        if (!result) {
            skipped++;
            continue;
        }
        const row = document.getElementById(`row-${String(product.id)}`);
        const rowButton = row ? row.querySelector('.rt-commit') : null;
        const outcome = await commitColor(product.id, rowButton);
        if (outcome.ok) saved++;
        else if (outcome.skipped) skipped++;
        else failed++;
    }

    if (status) {
        status.textContent = `${saved} saved${failed ? ` · ${failed} failed` : ''}${skipped ? ` · ${skipped} skipped` : ''}`;
        status.classList.toggle('is-error', failed > 0);
    }
    if (btn) {
        btn.disabled = false;
        btn.textContent = failed ? 'Commit All (retry failed)' : 'Commit All';
    }

    return { saved, failed, skipped };
}

const commitAllBtn = $('commitAllBtn');
if (commitAllBtn) commitAllBtn.addEventListener('click', commitAll);

/* ============================================================
   SKU / QUERY NORMALIZATION
   ============================================================ */
// Catalog brand names are stored glued-together with no separators
// (e.g. "OnRunning", "TommyHilfiger", "TheNorthFace") because the
// source file has no spaces in that column. Nobody writes it that
// way in a real product listing, so searching for the glued string
// verbatim misses real matches. This splits any PascalCase brand
// into its real words automatically — it isn't a lookup table of
// known brands, so it works for brand names we've never seen before
// too (e.g. "NewBrandName" -> "New Brand Name").
function splitPascalCaseBrand(brand) {
    if (!brand) return brand;
    // Already has separators or spacing — leave it alone.
    if (/[\s\-_]/.test(brand)) return brand;
    // "TheNorthFace" -> "The North Face"; "3M" / "K2" style tokens
    // (no lowercase run) are left untouched since there's nothing to
    // split on.
    const split = brand.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return split;
}

// Short (<=3 letter) or otherwise easily-confused brand codes — e.g.
// "HM" (H&M), "Gap", "Lee" — are prone to false-positive substring
// matches against completely unrelated text ("HM_" as a car model
// code, "gap" as an English word, "lee" as a surname). Rather than
// hardcoding a brand list, we detect the risk generically: any brand
// token 3 characters or shorter, after splitting, is treated as
// "ambiguous" and matched with word boundaries instead of a loose
// substring check (see wordBoundaryIncludes below).
//
// Length alone misses longer brand names that are ALSO ordinary
// English words — "Peak" matched "Mountain Peak Wallpapers" and a
// video game called "PEAK" as real "Meta-Verified (Brand only)"
// hits, because the word "peak" is genuinely, correctly present as
// a whole word in that unrelated text; word-boundary matching alone
// can't tell a mountain from a shoe. This short curated list covers
// known offenders seen in practice; for these, brandMatches alone
// is not enough — see hasCategoryCorroboration below, which is the
// actual filter that rejects the mountain photos.
const COMMON_WORD_BRAND_TOKENS = new Set(['peak', 'champion', 'everlast', 'supreme', 'airwalk', 'head']);
function isAmbiguousBrandToken(token) {
    if (!token) return false;
    const clean = token.replace(/[^a-z0-9]/gi, '');
    return clean.length <= 3 || COMMON_WORD_BRAND_TOKENS.has(clean.toLowerCase());
}

// For ambiguous brand tokens, a bare word-boundary match isn't enough
// ("Peak" matches "Mountain Peak" just as validly as "Peak brand
// shoes") — also require at least one product/category-ish word
// nearby, so a coincidental dictionary-word hit with zero shopping
// context gets rejected instead of treated as a real brand mention.
const CATEGORY_CORROBORATION_KEYWORDS = {
    shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'footwear', 'boot', 'boots', 'cleat', 'cleats', 'runner', 'running', 'slide', 'slides', 'sandal', 'kicks'],
    tops: ['shirt', 'tee', 'hoodie', 'jacket', 'coat', 'sweater', 'top', 'jersey', 'vest', 'polo', 'sweatshirt'],
    bottoms: ['pant', 'pants', 'jean', 'jeans', 'short', 'shorts', 'trouser', 'trousers', 'legging', 'leggings', 'skirt'],
    general: ['apparel', 'clothing', 'sportswear', 'wear', 'sports', 'athletic', 'gear', 'collection', 'catalog', 'store', 'shop'],
};
function hasCategoryCorroboration(spacedMeta, catKey) {
    const keywords = CATEGORY_CORROBORATION_KEYWORDS[catKey] || CATEGORY_CORROBORATION_KEYWORDS.general;
    return keywords.some(kw => wordBoundaryIncludes(spacedMeta, kw));
}

function normalizeQuery(product) {
    const { brand: rawBrand, sku, category } = product;
    const brand = splitPascalCaseBrand(rawBrand);
    const baseQuery = `${brand} ${sku}`;
    const catLower = (category || '').toLowerCase() + ' ' + baseQuery.toLowerCase();

    let catKey = 'general';
    if (catLower.match(/shoe|sneaker|boot|cleat|runner|slide|sandal|kicks/)) catKey = 'shoes';
    else if (catLower.match(/shirt|tee|hoodie|jacket|coat|sweater|top|jersey|vest/)) catKey = 'tops';
    else if (catLower.match(/pant|jean|short|trouser|trousers|bottom|skirt|legging/)) catKey = 'bottoms';

    return { baseQuery, brand, rawBrand, sku, catKey };
}

/* ============================================================
   MATCH VERIFICATION
   SKU is split into parts (base code + variant suffix). Real
   listings rarely contain the full glued string, and often omit
   the brand name entirely, so we require the base SKU code OR
   brand — not a glued full-string match on both.

   Confidence tiers (best to worst) — used for slot priority and
   the "sort by tier" control:
     1. URL-Verified (100% Match)
     2. URL-Verified (Brand + SKU)
     3. URL-Verified (SKU only)
     4. Meta-Verified (Brand + Variant)
     5. Meta-Verified (Brand + SKU)
     6. Meta-Verified (SKU only)
     7. Meta-Verified (Brand only)   <- brand matched, SKU didn't;
                                        previously a hard reject
   ============================================================ */
const CONFIDENCE_TIERS = [
    'URL-Verified (100% Match)',
    'URL-Verified (Brand + SKU)',
    'URL-Verified (SKU only)',
    'Meta-Verified (Brand + Variant)',
    'Meta-Verified (Brand + SKU)',
    'Meta-Verified (SKU only)',
    'Meta-Verified (Brand only)',
    'Unverified (Best Effort)',
    'Unverified (Weak Match — Review)',
    'Manually Added',
];
function confidenceRank(confidence) {
    const i = CONFIDENCE_TIERS.indexOf(confidence);
    return i === -1 ? CONFIDENCE_TIERS.length : i; // unknown tiers sort last
}

/* ============================================================
   TIER FILTER — lets the filter bar narrow the product list down
   to a specific confidence tier (or "Empty (0/5)"), so you can e.g.
   pull up every product whose best slot is only "Meta-Verified (SKU
   only)" and give that batch a closer look. A product's tier bucket
   is its BEST (lowest-rank) filled slot — matching "what's the best
   evidence we actually have for this product" — with a dedicated
   "Empty (0/5)" bucket for products with nothing filled at all,
   since those have no tier to speak of.
   ============================================================ */
const TIER_FILTER_BUCKETS = ['empty', ...CONFIDENCE_TIERS];

function productTierBucket(product) {
    const r = state.results[product.id];
    if (!r || !r.slotAssignments) return null; // still processing — excluded from tier filter until we know
    const filled = SLOTS.map(s => r.slotAssignments[s]).filter(Boolean);
    if (filled.length === 0) return 'empty';
    const ranks = filled.map(a => confidenceRank(a.confidence));
    const bestRank = Math.min(...ranks);
    return CONFIDENCE_TIERS[bestRank] || null;
}

function populateTierFilterOptions() {
    const sel = $('filterTier');
    if (!sel) return;
    sel.innerHTML = '<option value="all">All Tiers</option>' +
        TIER_FILTER_BUCKETS.map(t => `<option value="${t === 'empty' ? 'empty' : t.replace(/"/g, '&quot;')}">${t === 'empty' ? 'Empty (0/5)' : t}</option>`).join('');
}

/* ============================================================
   AUTO-FILL POLICY — quality over quantity.
   "Meta-Verified (Brand only)" and "Unverified (Best Effort)" exist
   as "fill something rather than nothing" safety nets. Both are
   honest about being weak, so the question isn't "on or off" but
   "when is the risk acceptable" — which mostly comes down to SKU
   specificity (see skuIsSpecific/skuIsGeneric in verifyCandidateMatch):
   a brand-only match against a long alphanumeric SKU like
   "CW2288-111" is a reasonable bet; a brand-only match against a bare
   "874" is not — it's telling you almost nothing about which product
   this actually is.
   Turning any of these off means the tier still shows up in the
   quick picks strip / debug log (nothing is hidden), it just won't be
   silently written into a slot on your behalf.
   ============================================================ */
const AUTO_FILL_POLICY = {
    // false: never auto-fill "Brand only" matches.
    // 'specific-sku-only': auto-fill only when the product's SKU is
    //   long/alphanumeric enough that a brand-only match is a safe bet
    //   (this is the default — recovers most of the "0/5 despite good
    //   candidates" cases without reintroducing the generic-SKU risk).
    // true: always auto-fill "Brand only" matches, regardless of SKU.
    allowBrandOnlyAutoFill: 'specific-sku-only',
    allowBestEffortFallback: false,      // single unverified best-effort guess when nothing verifies
    requireStrictMatchForSlotA: true,    // slot A (primary/cover image) needs brand AND sku, never brand-only

    // RESCUE FOR SLOT A: requireStrictMatchForSlotA above is correct in
    // spirit (don't crown a "brand only" guess as the cover image when
    // something better exists) but it has a sharp edge — if literally
    // EVERY candidate for a product is a weak tier, slot A can never be
    // filled, which means the loop below never advances past index 0
    // and the whole row stays 0/5 forever, even though those same weak
    // candidates were perfectly identifiable, correct products by eye
    // in the quick picks strip. When true, if nothing at all could be
    // assigned because every valid candidate was blocked ONLY by the
    // slot-A strict bar, the best of those candidates is allowed in
    // after all rather than leaving the row completely blank. This can
    // only ever turn a 0/5 row into a non-empty one — if any stronger
    // candidate existed anywhere, it would already have filled slot A
    // in the normal pass above.
    rescueSlotAWhenNothingElseQualifies: true,

    // Once a product already has at least one real SKU-confirmed
    // match in a slot (anything at or above "Meta-Verified (SKU only)"
    // in CONFIDENCE_TIERS), further "Meta-Verified (Brand only)" /
    // "Unverified (Best Effort)" candidates are skipped instead of
    // being used to fill the remaining slots. Those risky tiers only
    // confirm the BRAND, not the specific product — once we already
    // have real proof this is the right item, using a brand-only match
    // to fill slot C/D/E risks showing a completely different product
    // in the same brand's lineup. An empty supporting slot (fixable
    // via the quick-picks strip) is safer than a confidently-wrong one.
    avoidRiskyFillWhenStrongMatchExists: true,

    minWidthPx: 200,                     // reject candidates below this width when we know the dimension
    minHeightPx: 200,

    // SCORED RESCUE FOR FULLY-EMPTY (0/5) PRODUCTS ONLY.
    // Fires only when the product ends this whole pipeline still at
    // 0/5 (nothing above — including the slot-A rescue and the
    // best-effort fallback — managed to fill anything). Rather than
    // grabbing the first loosely-brand-matching raw candidate (like
    // the plain best-effort fallback above does), this scores every
    // otherwise-rejected "brand only" / weak candidate on brand match,
    // category-word corroboration, domain trust, and title overlap,
    // and only auto-fills the top-ranked one or two IF they clear
    // rescueScoreMinimum. This is deliberately brand-match-required
    // (never SKU-only-generic, never "neither matched") specifically
    // to avoid cases like a completely different product in the same
    // brand's catalog (a bag instead of a hoodie) sneaking in — the
    // category-corroboration term scores that near zero and the floor
    // keeps it out.
    enableScoredZeroFillRescue: true,
    zeroFillRescueMaxSlots: 2,            // never more than 2 — see rationale below
    // A bare brand match with nothing else scores exactly 3 (see
    // scoreZeroFillCandidate) — that's "right brand, could be ANY
    // other product in their catalog" (a duffle bag when we want a
    // hoodie, a sunglasses line when we want a polo) and must NOT
    // clear the floor on its own. Requiring 5 means category-word
    // corroboration (+2) or a same-neighborhood SKU hit (+1) plus
    // decent domain trust is the practical minimum to pass.
    zeroFillRescueScoreMinimum: 5,
};

/* ============================================================
   DOMAIN TRUST
   Free substitute for a paid "verified retailer" data source: a
   short hand-picked list of domain patterns that are either
   generally reliable (official brand sites, major retailers) or
   generally noisy (reposting/knockoff/stock-mockup sites that
   commonly cause false-positive text matches). This is intentionally
   small and conservative — an unknown domain is neutral, not
   penalized, so this never becomes a blocklist that silently drops
   legitimate small retailers.
   This list is also augmented at runtime by learnedDomainTrust
   (see below), which adjusts scores based on your own manual
   corrections over time.
   ============================================================ */
const TRUSTED_DOMAIN_PATTERNS = [
    /nordstrom\./i, /zappos\./i, /footlocker\./i, /finishline\./i,
    /endclothing\./i, /ssense\./i, /net-a-porter\./i, /farfetch\./i,
    /macys\./i, /nike\.com/i, /adidas\.com/i, /jdsports\./i,
    /shopify\.com/i, /amazon\./i, /target\.com/i, /walmart\.com/i,
];
const NOISY_DOMAIN_PATTERNS = [
    /pinterest\./i, /alibaba\./i, /aliexpress\./i, /wish\.com/i,
    /dhgate\./i, /pinimg\.com/i, /favim\./i, /template\./i,
    /mockup/i, /shutterstock\./i, /istockphoto\./i, /alamy\./i,
    /dreamstime\./i, /depositphotos\./i,
];

function getHostname(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

// Runs purely client-side, in localStorage — no backend, no cost.
// Records how often a domain's images get manually rejected
// (cleared/replaced) vs kept, and folds that running ratio into
// future ranking. Starts neutral for every domain; only shifts once
// there's real correction history for it.
const LEARNED_TRUST_KEY = 'catalogPipeline.learnedDomainTrust.v1';
let learnedDomainTrust = null; // hostname -> { kept: n, rejected: n }

function loadLearnedTrust() {
    if (learnedDomainTrust) return learnedDomainTrust;
    try {
        const raw = localStorage.getItem(LEARNED_TRUST_KEY);
        learnedDomainTrust = raw ? JSON.parse(raw) : {};
    } catch (e) {
        learnedDomainTrust = {};
    }
    return learnedDomainTrust;
}

function saveLearnedTrust() {
    try { localStorage.setItem(LEARNED_TRUST_KEY, JSON.stringify(learnedDomainTrust || {})); } catch (e) {}
}

// Call whenever a specific URL is manually removed from a slot (a
// real signal that the auto-picked source was wrong) or manually
// added/kept (a soft positive signal). This is the feedback loop:
// domains that get corrected away from repeatedly will rank lower
// for every future product, without any hardcoded list maintenance.
function recordDomainOutcome(url, outcome) {
    const host = getHostname(url);
    if (!host) return;
    const trust = loadLearnedTrust();
    if (!trust[host]) trust[host] = { kept: 0, rejected: 0 };
    if (outcome === 'rejected') trust[host].rejected++;
    else if (outcome === 'kept') trust[host].kept++;
    saveLearnedTrust();
}

// Returns a small integer bump (-2..+2) folded into tier sorting.
// Static list gives an immediate baseline; learned corrections
// override/refine it once there's enough history (>=3 signals) for
// a given domain to be meaningful rather than noise from one
// isolated correction.
function domainTrustScore(url) {
    const host = getHostname(url);
    if (!host) return 0;

    let score = 0;
    if (TRUSTED_DOMAIN_PATTERNS.some(p => p.test(host))) score += 1;
    if (NOISY_DOMAIN_PATTERNS.some(p => p.test(host))) score -= 2;

    const trust = loadLearnedTrust();
    const rec = trust[host];
    if (rec) {
        const total = rec.kept + rec.rejected;
        if (total >= 3) {
            const rejectRate = rec.rejected / total;
            if (rejectRate >= 0.6) score -= 2;
            else if (rejectRate <= 0.15) score += 1;
        }
    }
    return score;
}

// SCORED ZERO-FILL RESCUE — see AUTO_FILL_POLICY.enableScoredZeroFillRescue.
// Only ever called on candidates that already failed strict
// verification (this product is 0/5), and only ever on ones that at
// least matched the brand (debugInfo.brandMatches) — never a bare
// SKU-only-generic or a "neither matched" reject. Composes signals
// that already exist elsewhere in the pipeline rather than inventing
// new ones:
//   +3  brand matched (required to even be considered — see caller)
//   +2  category-word corroboration (title/metadata mentions a word
//       from this product's category bucket — e.g. "hoodie", "jacket"
//       for tops). This is what keeps a same-brand-wrong-product
//       result (a bag when we want a hoodie) from scoring well: no
//       category overlap, no points, usually falls under the floor.
//   +1  SKU's leading alnum run appears anywhere in the metadata,
//       even though the full base SKU didn't (a near-miss, still
//       weak evidence but better than brand alone)
//   domainTrustScore(url) added as-is (typically -2..+2)
//   +1  image has known dimensions at or above a "real product photo"
//       size (600x600) rather than just clearing the thumbnail floor
function scoreZeroFillCandidate(item, verification, norm) {
    const debugInfo = (verification && verification.debugInfo) || {};
    if (!debugInfo.brandMatches) return -Infinity; // hard requirement, not just a bonus

    let score = 3; // base for the required brand match

    const combinedMeta = [item.title, item.murl, item.turl, item.purl].filter(Boolean).join(' ').toLowerCase();
    const spacedMeta = combinedMeta.replace(/[-_&]/g, ' ');
    if (hasCategoryCorroboration(spacedMeta, norm.catKey)) score += 2;

    const skuLeading = (debugInfo.baseSkuPart || '').slice(0, 4);
    if (skuLeading && skuLeading.length >= 4 && combinedMeta.replace(/[-_\s]/g, '').includes(skuLeading)) score += 1;

    score += domainTrustScore(item.url);

    if (item.thumbW && item.thumbH && item.thumbW >= 600 && item.thumbH >= 600) score += 1;

    return score;
}

// Loose "does this text contain this substring" matching is fine for
// longer brand names (little risk "nike" appears by accident), but
// short codes like "hm", "gap", "lee" show up constantly inside
// unrelated words/codes ("HM_" car model, "gap" the English word,
// "lee" as a surname). For anything <=3 characters we require a real
// word boundary instead of a raw substring — cuts out that whole
// class of false positive without a hardcoded brand list. We still
// also allow the letters to appear split by punctuation (e.g. "H&M",
// "H & M" both need to match the catalog brand "HM"), so ambiguous
// brands are checked both as a whole word AND as their letters
// separated by exactly one punctuation/space character.
function wordBoundaryIncludes(haystackWithSeparators, needle) {
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(haystackWithSeparators)) return true;
    if (needle.length >= 2 && needle.length <= 3) {
        // "hm" -> matches "h m", "h&m", "h.m", etc. Only for short
        // tokens — this is specifically the "H&M" style case.
        const spacedPattern = needle.split('').join('[^a-z0-9]?');
        if (new RegExp(`(?:^|[^a-z0-9])${spacedPattern}(?:$|[^a-z0-9])`, 'i').test(haystackWithSeparators)) return true;
    }
    return false;
}

function verifyCandidateMatch(item, brand, sku, catKey) {
    // Cheap, free quality gate: if Bing told us the thumbnail's real
    // dimensions (added server-side — see parseTilesWithDims), reject
    // anything under the configured floor before doing any text
    // matching at all. Placeholder icons, tiny social-share thumbs,
    // and broken-image stand-ins are common noise sources that pass
    // brand/SKU text checks purely by coincidence of surrounding page
    // content; a size floor catches a lot of them for free.
    if (item.thumbW && item.thumbH && (item.thumbW < AUTO_FILL_POLICY.minWidthPx || item.thumbH < AUTO_FILL_POLICY.minHeightPx)) {
        return {
            valid: false,
            reason: `thumbnail too small (${item.thumbW}x${item.thumbH}, floor is ${AUTO_FILL_POLICY.minWidthPx}x${AUTO_FILL_POLICY.minHeightPx})`,
            debugInfo: { title: item.title || '(no title)', url: item.url, rejectedForSize: true },
        };
    }

    const combinedMeta = [item.title, item.murl, item.turl, item.purl].filter(Boolean).join(' ').toLowerCase();
    const cleanMeta = combinedMeta.replace(/[-_\s]/g, '');
    const cleanBrand = brand ? brand.toLowerCase().replace(/[-_\s]/g, '') : '';

    const skuParts = sku ? sku.toLowerCase().split(/[-_\s]+/).filter(Boolean) : [];
    const baseSkuPart = skuParts.length
        ? skuParts.reduce((a, b) => (b.length > a.length ? b : a))
        : '';
    const otherSkuParts = skuParts.filter(p => p !== baseSkuPart);

    // SKU SPECIFICITY — a short, purely-numeric SKU segment (e.g. "874",
    // "500456", "T501") is common across totally unrelated products:
    // tool part numbers, model years, phone extensions, invoice IDs. A
    // long alphanumeric SKU (e.g. "CW2288-111", "NF0A3JPA") essentially
    // never collides by accident. Treating both the same way — "SKU
    // string found in metadata" being sufficient on its own, with no
    // brand corroboration required — is what let a Gap product's SKU
    // "500456" auto-match a completely unrelated tank/tool listing. A
    // SKU counts as "specific" if it mixes letters and digits (much
    // lower collision odds) OR is long enough on its own that a random
    // coincidence is unlikely even if purely numeric.
    const skuDigitsOnly = /^[0-9]+$/.test(baseSkuPart);
    const skuHasLetters = /[a-z]/i.test(baseSkuPart);
    const skuIsSpecific = baseSkuPart.length >= 6 || (skuHasLetters && baseSkuPart.length >= 4);
    const skuIsGeneric = baseSkuPart.length > 0 && !skuIsSpecific;

    // Ambiguous (short) brand tokens use word-boundary matching against
    // the metadata WITH separators (space-normalized) still in place
    // (so "hm" doesn't match inside "dpf95hm123"), everything else
    // uses the existing fast substring check on the fully-cleaned
    // string. "&" is folded to a space too so "H&M" still matches the
    // brand token "hm" (H&M's SKU catalog brand is stored as "HM").
    const brandIsAmbiguous = isAmbiguousBrandToken(cleanBrand);
    const spacedMeta = combinedMeta.replace(/[-_&]/g, ' ');
    const brandMatches = !!cleanBrand && (brandIsAmbiguous
        ? wordBoundaryIncludes(spacedMeta, cleanBrand)
        : cleanMeta.includes(cleanBrand));
    const skuMatches = !!baseSkuPart && cleanMeta.includes(baseSkuPart);

    const debugInfo = {
        title: item.title || '(no title)',
        url: item.url,
        cleanBrand, baseSkuPart, otherSkuParts,
        brandMatches, skuMatches, brandIsAmbiguous,
        skuIsSpecific, skuIsGeneric,
    };

    if (!skuMatches && !brandMatches) {
        return { valid: false, reason: 'neither brand nor base SKU found in metadata', debugInfo };
    }

    // The brand token is a common English word/dictionary term (see
    // COMMON_WORD_BRAND_TOKENS) and matched, but nothing ties this hit
    // to an actual product page — e.g. "peak" found only in "Mountain
    // Peak Wallpapers" or a video game title. Reject outright rather
    // than letting it through as "Brand only": there's no shopping
    // context here at all, so this isn't even a weak lead worth
    // showing in quick picks.
    if (brandIsAmbiguous && brandMatches && !skuMatches && !hasCategoryCorroboration(spacedMeta, catKey)) {
        debugInfo.rejectedForNoCategoryCorroboration = true;
        return { valid: false, reason: `brand token "${cleanBrand}" is a common word and matched with no product/category context nearby (likely coincidental, not a real ${cleanBrand} product page)`, debugInfo };
    }

    // Brand matched but the exact SKU didn't. Auto-fill is allowed when
    // the SKU is specific enough that "right brand, unconfirmed exact
    // model" is a reasonably safe bet (long/alphanumeric SKUs rarely
    // apply to more than one real product line) — but stays off for
    // generic/short SKUs, where a brand-only match gives almost no
    // information about which specific product this actually is.
    // Either way it's surfaced in the quick picks strip / debug log.
    if (baseSkuPart && !skuMatches && brandMatches) {
        debugInfo.suffixAlsoMatches = false;
        debugInfo.isExactUrlMatch = false;
        const allowThisOne = AUTO_FILL_POLICY.allowBrandOnlyAutoFill === true
            || (AUTO_FILL_POLICY.allowBrandOnlyAutoFill === 'specific-sku-only' && skuIsSpecific);
        if (!allowThisOne) {
            return { valid: false, reason: `brand matched but SKU did not${skuIsGeneric ? ' (and SKU is too generic for brand-only auto-fill)' : ''} — see quick picks`, confidence: 'Meta-Verified (Brand only)', debugInfo, eligibleForManualPicker: true };
        }
        return { valid: true, confidence: 'Meta-Verified (Brand only)', debugInfo };
    }
    if (baseSkuPart && !skuMatches) {
        return { valid: false, reason: 'base SKU present in product but not found in metadata', debugInfo };
    }
    if (!baseSkuPart && !brandMatches) {
        return { valid: false, reason: 'no usable SKU and brand not found in metadata', debugInfo };
    }

    // SKU matched, but brand DIDN'T — this is the "SKU only" family of
    // tiers. If the SKU is generic (short/purely-numeric), a bare
    // metadata match is not real evidence at all — it's exactly the
    // "500456 the Gap jeans" vs "500456 the tank part number" collision.
    // Require the SKU to be specific before allowing this tier to pass
    // without any brand corroboration whatsoever.
    if (!brandMatches && skuIsGeneric) {
        return { valid: false, reason: `SKU matched but brand did not, and SKU "${baseSkuPart}" is too generic/short to trust on its own (likely collision with an unrelated product) — see quick picks`, debugInfo, eligibleForManualPicker: true };
    }

    const suffixAlsoMatches = otherSkuParts.some(p => p.length >= 3 && cleanMeta.includes(p));
    const isExactUrlMatch = (item.murl || '').toLowerCase().includes(baseSkuPart) || (item.purl || '').toLowerCase().includes(baseSkuPart);

    let confidence = 'Meta-Verified (SKU only)';
    if (isExactUrlMatch && brandMatches && suffixAlsoMatches) confidence = 'URL-Verified (100% Match)';
    else if (isExactUrlMatch && brandMatches) confidence = 'URL-Verified (Brand + SKU)';
    else if (isExactUrlMatch) confidence = 'URL-Verified (SKU only)';
    else if (brandMatches && suffixAlsoMatches) confidence = 'Meta-Verified (Brand + Variant)';
    else if (brandMatches) confidence = 'Meta-Verified (Brand + SKU)';

    debugInfo.suffixAlsoMatches = suffixAlsoMatches;
    debugInfo.isExactUrlMatch = isExactUrlMatch;

    return { valid: true, confidence, debugInfo };
}

/* ============================================================
   SEARCH WINDOW — opens a real, live Bing Images search (the
   actual bing.com website, not our API) in a single reused
   window, so the user can drag a real result thumbnail back
   onto a slot. Reusing one named window means clicking a
   different product re-navigates it instead of piling up tabs.
   ============================================================ */
let bingSearchWindowRef = null;
function openBingSearchWindow(query) {
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`;

    // Snap THIS window to the left half of the screen, and the Bing
    // search window to the right half, so the two end up side-by-side
    // automatically — even if this window was previously maximized /
    // filling the whole screen.
    const halfW = Math.round(screen.availWidth / 2);
    const h = screen.availHeight;
    try {
        window.moveTo(0, 0);
        window.resizeTo(halfW, h);
    } catch (e) {
        // Some browsers block resizing a window that wasn't opened via
        // window.open() (e.g. a tab opened by navigating a URL). In
        // that case we just skip the resize and still open the pane.
    }

    const rightW = screen.availWidth - halfW;
    const left = halfW;
    if (bingSearchWindowRef && !bingSearchWindowRef.closed) {
        bingSearchWindowRef.location.href = url;
        try { bingSearchWindowRef.moveTo(left, 0); bingSearchWindowRef.resizeTo(rightW, h); } catch (e) {}
        bingSearchWindowRef.focus();
        return;
    }
    bingSearchWindowRef = window.open(
        url,
        'bingSearchPane',
        `left=${left},top=0,width=${rightW},height=${h}`
    );
}

/* ============================================================
   NETWORK / IMAGE HELPERS
   ============================================================ */
// A 429 from the proxy specifically means "Bing looked like a block/
// CAPTCHA page," not "this query has zero results" (see server.js
// looksLikeBlockPage). Those two cases used to be indistinguishable
// to the client, which meant a temporary block could get permanently
// misread as "nothing exists for this product." One retry after a
// short backoff costs nothing extra when we're not actually blocked
// (this path is never hit), and gives a real second chance when we
// are.
// Client-side backstop for the same filter server.js applies —
// defense in depth in case a cached/stale server response (from
// before this filter existed) is still being served, or another
// client hitting the same proxy doesn't have it. See server.js's
// looksLikeAdultContent for the full rationale; kept in sync here.
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

async function fetchFromBing(query, limit = 10, _isRetry = false) {
    try {
        const res = await fetch(`${SERVER_BASE}/api/bing/search?q=${encodeURIComponent(query)}&limit=${limit}`);

        if (res.status === 429 && !_isRetry) {
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
            return fetchFromBing(query, limit, true);
        }

        if (!res.ok) {
            let blocked = false;
            try { blocked = !!(await res.json()).blocked; } catch (e) {}
            return { images: [], error: `HTTP ${res.status}`, blocked };
        }
        const data = await res.json();
        const images = (data.images || []).filter(item => !looksLikeAdultContent(item));
        return { images, error: null, blocked: false, suspectedOffTopic: !!data.suspectedOffTopic };
    } catch (err) {
        return { images: [], error: err.message, blocked: false, suspectedOffTopic: false };
    }
}

function checkImageRenders(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
    });
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

// dHash (gradient/difference hash) instead of plain average-hash.
// aHash only compares each pixel to the image's overall average
// brightness, which is easily fooled by things that shift the whole
// image's brightness/contrast (a slightly different crop, a watermark
// overlay, a recompression) while leaving the actual picture content
// unchanged — two visually-different photos can land on the same
// aHash, and two near-identical photos can drift apart. dHash instead
// encodes how brightness *changes* moving left-to-right across each
// row, which is far more robust to those global shifts since it only
// cares about local gradients, not absolute brightness. Still just
// canvas pixel math — free, same cost as before, meaningfully more
// reliable for "is this actually the same product photo" comparisons.
async function averageHash(url) {
    try {
        const img = await loadImage(url);
        const w = 9, h = 8; // 9 columns so each row yields 8 left-right comparisons
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);

        const gray = [];
        for (let i = 0; i < data.length; i += 4) {
            gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
        }

        let hash = '';
        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w - 1; col++) {
                const left = gray[row * w + col];
                const right = gray[row * w + col + 1];
                hash += left > right ? '1' : '0';
            }
        }
        return { hash, dims: { w: img.naturalWidth, h: img.naturalHeight } };
    } catch (e) { return null; }
}

function hammingDistance(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
}

function cssEscape(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/* ============================================================
   VIRTUAL LIST
   Only a small window of product rows actually exists in the DOM
   at any time (recycled as the user scrolls). This is what lets
   the page stay smooth with thousands of products: DOM node count
   stays constant no matter how big the catalog is.
   ============================================================ */
/* ============================================================
   STANDARD LIST RENDERER (Replaces Virtual List)
   ============================================================ */
const virtualList = (function createStandardList() {
    const container = $('productRows');

    // Delegated click handler for the per-image delete ("×") button and
    // the "Search Window" button — bound once instead of re-attached on
    // every paint.
    container.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.slot-delete');
        if (delBtn) {
            const slotEl = delBtn.closest('.slot');
            const rowEl = delBtn.closest('.product-row');
            if (slotEl && rowEl) {
                clearSlot(rowEl.dataset.productId, slotEl.dataset.slot);
            }
            return;
        }

        const searchBtn = e.target.closest('.rt-search-window');
        if (searchBtn) {
            const rowEl = searchBtn.closest('.product-row');
            if (!rowEl) return;
            const product = state.productsById && state.productsById.get(rowEl.dataset.productId);
            if (!product) return;
            openBingSearchWindow(`${product.brand} ${product.sku}`.trim());
            return;
        }

        const commitBtn = e.target.closest('.rt-commit');
        if (commitBtn) {
            const rowEl = commitBtn.closest('.product-row');
            if (!rowEl) return;
            commitColor(rowEl.dataset.productId, commitBtn);
            return;
        }

        const retryBtn = e.target.closest('.rt-retry');
        if (retryBtn) {
            const rowEl = retryBtn.closest('.product-row');
            if (!rowEl) return;
            const productId = rowEl.dataset.productId;
            const product = state.productsById && state.productsById.get(productId);
            if (!product) return;
            retryProduct(product, retryBtn);
        }
    });

    // ------------------------------------------------------------
    // Extracting a usable image URL out of a browser drag payload.
    // Different sites/browsers populate different dataTransfer types
    // when you drag a thumbnail — Bing's grid in particular often
    // only fills text/html (a full <img> tag, sometimes pointing at
    // a proxied/thumbnail src) rather than text/uri-list, which is
    // why a plain "drag the small thumbnail" felt like it did
    // nothing before. We now check, in order: uri-list, plain text
    // that looks like a URL, then fall back to parsing an <img src>
    // or the first http(s) URL out of an HTML payload. This means a
    // straight drag off the small grid thumbnail works without first
    // opening/expanding the image.
    function extractDroppedImageUrl(dataTransfer) {
        const uriList = (dataTransfer.getData('text/uri-list') || '').trim().split('\n')[0].trim();
        if (uriList && /^https?:\/\//i.test(uriList)) return uriList;

        const plain = (dataTransfer.getData('text/plain') || '').trim();
        if (plain && /^https?:\/\//i.test(plain)) return plain;

        const html = dataTransfer.getData('text/html') || '';
        if (html) {
            const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (imgMatch && /^https?:\/\//i.test(imgMatch[1])) return imgMatch[1];
            const anyUrlMatch = html.match(/https?:\/\/[^\s"'<>]+/i);
            if (anyUrlMatch) return anyUrlMatch[0];
        }
        return null;
    }

    // Drag-and-drop: dragging an <img> out of a real Bing/Google Images
    // tab carries its image URL via one of several dataTransfer types
    // depending on the source site (see extractDroppedImageUrl above).
    // Dropping it on a slot — or anywhere in the row — assigns that
    // URL, same as a manual pick.
    //
    // dragenter/dragleave fire on every child-element boundary crossing,
    // not just when truly entering/leaving the target, so a naive toggle
    // flickers as the pointer moves over its own children. A small
    // per-element enter counter fixes that: the highlight only turns
    // off once the counter returns to zero.
    function bumpDragDepth(el, cls, delta) {
        const depth = Math.max(0, (parseInt(el.dataset.dragDepth, 10) || 0) + delta);
        el.dataset.dragDepth = String(depth);
        el.classList.toggle(cls, depth > 0);
        return depth;
    }

    container.addEventListener('dragenter', (e) => {
        // Internal slot-reorder drag takes priority over external highlight.
        if (dragState.active) return;
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        if (slotEl) {
            e.preventDefault();
            bumpDragDepth(slotEl, 'slot-dragover', 1);
        } else if (rowEl) {
            e.preventDefault();
        }
    });

    container.addEventListener('dragover', (e) => {
        if (dragState.active) return; // handled by internal reorder listeners below
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        if (!slotEl && !rowEl) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    container.addEventListener('dragleave', (e) => {
        if (dragState.active) return;
        const slotEl = e.target.closest('.slot');
        if (!slotEl) return;
        bumpDragDepth(slotEl, 'slot-dragover', -1);
    });

    container.addEventListener('drop', (e) => {
        if (dragState.active) return; // handled by internal reorder drop listener
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        if (!rowEl) return;
        e.preventDefault();
        if (slotEl) {
            slotEl.dataset.dragDepth = '0';
            slotEl.classList.remove('slot-dragover');
        }

        const productId = rowEl.dataset.productId;
        const url = extractDroppedImageUrl(e.dataTransfer);
        if (!url) {
            updateProductStatus(productId, 'drop ignored — no valid image URL in dragged item');
            return;
        }

        // Dropped directly on a specific slot -> that slot (bumping
        // whatever was there back one, compacting the rest). Dropped
        // anywhere else in the row -> the next open slot, or the last
        // slot if the row is already full.
        const targetSlot = slotEl ? slotEl.dataset.slot : (nextOpenSlot(productId) || SLOTS[SLOTS.length - 1]);
        assignDroppedImage(productId, targetSlot, url);
    });

    function assignDroppedImage(productId, slotKey, url) {
        const product = state.productsById && state.productsById.get(productId);
        if (!product) return;

        let result = state.results[productId];
        if (!result) {
            result = { id: productId, product, slotAssignments: {}, totalAssigned: 0, _needsAttention: true, _statusText: 'queued…' };
            state.results[productId] = result;
        }
        if (!result.slotAssignments) result.slotAssignments = {};
        result.slotAssignments[slotKey] = { url, confidence: 'Manually Added' };
        result.totalAssigned = SLOTS.filter(s => result.slotAssignments[s]).length;
        result._needsAttention = result.totalAssigned < 5;
        markCommitDirty(productId);

        // A human deliberately choosing this image (drag-drop or paste,
        // not an auto-pick) is a positive signal for its domain — feeds
        // the same learned-trust store that clearSlot penalizes.
        recordDomainOutcome(url, 'kept');

        updateSlot(productId, slotKey, { url, confidence: 'Manually Added' });
        updateProductStatus(productId, `${result.totalAssigned}/5 filled — image dropped in manually`);

        const norm = normalizeQuery(product);
        updateQuickPicks(productId, result._needsAttention, product, norm);
    }

    // ------------------------------------------------------------
    // PASTE — click/focus a slot (or anywhere in a row) then Ctrl/Cmd+V
    // a copied image link (or an actual copied image, e.g. from an
    // image editor / "Copy image" in a browser) to assign it, no
    // drag needed at all.
    // ------------------------------------------------------------
    let lastFocusedSlot = null; // { rowEl, slotEl }
    container.addEventListener('focusin', (e) => {
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        if (rowEl) lastFocusedSlot = { rowEl, slotEl: slotEl || null };
    });
    container.addEventListener('click', (e) => {
        // Clicking empty slot space focuses it (so paste has a target)
        // without interfering with the delete button / quick picks
        // click handlers already bound above.
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        if (rowEl) lastFocusedSlot = { rowEl, slotEl: slotEl || null };
    });

    document.addEventListener('paste', (e) => {
        if (!lastFocusedSlot || !lastFocusedSlot.rowEl || !lastFocusedSlot.rowEl.isConnected) return;
        const { rowEl, slotEl } = lastFocusedSlot;
        const productId = rowEl.dataset.productId;
        const cd = e.clipboardData;
        if (!cd) return;

        // Case 1: an actual image file was copied (e.g. "Copy image").
        const fileItem = Array.from(cd.items || []).find(it => it.kind === 'file' && it.type.startsWith('image/'));
        if (fileItem) {
            e.preventDefault();
            const file = fileItem.getAsFile();
            const reader = new FileReader();
            reader.onload = () => {
                const targetSlot = slotEl ? slotEl.dataset.slot : (nextOpenSlot(productId) || SLOTS[SLOTS.length - 1]);
                assignDroppedImage(productId, targetSlot, reader.result);
            };
            reader.readAsDataURL(file);
            return;
        }

        // Case 2: a copied image URL / link (plain text or HTML <img src>).
        const text = cd.getData('text/plain') || '';
        const html = cd.getData('text/html') || '';
        let url = /^https?:\/\/\S+/i.test(text.trim()) ? text.trim() : null;
        if (!url && html) {
            const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (imgMatch) url = imgMatch[1];
        }
        if (!url) return;
        e.preventDefault();
        const targetSlot = slotEl ? slotEl.dataset.slot : (nextOpenSlot(productId) || SLOTS[SLOTS.length - 1]);
        assignDroppedImage(productId, targetSlot, url);
    });

    // ------------------------------------------------------------
    // INTERNAL REORDER — dragging a filled slot onto another slot
    // (within the same row) swaps/reorders them instead of assigning
    // a new image. Removing a slot (the × button) already compacts
    // the remaining images left via clearSlot + this reorder logic
    // is what lets the user manually re-order after that, or any
    // time, by dragging one filled slot onto another position.
    // A custom drag-ghost thumbnail follows the cursor since the
    // native browser drag image can be unreliable for styled nodes.
    // ------------------------------------------------------------
    const dragState = { active: false, productId: null, fromSlot: null };
    let ghostEl = null;

    function ensureGhost(imgSrc) {
        if (!ghostEl) {
            ghostEl = document.createElement('div');
            ghostEl.className = 'drag-ghost';
            document.body.appendChild(ghostEl);
        }
        ghostEl.innerHTML = `<img src="${imgSrc}" alt="">`;
        ghostEl.style.display = 'block';
    }
    function moveGhost(x, y) {
        if (!ghostEl) return;
        ghostEl.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    }
    function hideGhost() {
        if (ghostEl) ghostEl.style.transform = 'translate(-9999px, -9999px)';
    }

    container.addEventListener('dragstart', (e) => {
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        const img = slotEl && slotEl.querySelector('.slot-body img');
        if (!slotEl || !rowEl || !img) return; // only filled slots are draggable="true"

        dragState.active = true;
        dragState.productId = rowEl.dataset.productId;
        dragState.fromSlot = slotEl.dataset.slot;
        slotEl.classList.add('slot-reorder-source');

        // Suppress the native drag ghost (use ours instead) — a 0-size
        // transparent image as the drag image hides the default one
        // in all major browsers.
        const blank = document.createElement('img');
        blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7';
        e.dataTransfer.setDragImage(blank, 0, 0);
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', img.src); } catch (err) {}

        ensureGhost(img.src);
        moveGhost(e.clientX, e.clientY);
    });

    container.addEventListener('drag', (e) => {
        if (!dragState.active) return;
        if (e.clientX === 0 && e.clientY === 0) return; // dragend fires a stray (0,0) event in some browsers
        moveGhost(e.clientX, e.clientY);
    });

    container.addEventListener('dragover', (e) => {
        if (!dragState.active) return;
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        if (!rowEl || rowEl.dataset.productId !== dragState.productId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        moveGhost(e.clientX, e.clientY);

        container.querySelectorAll('.slot-reorder-target').forEach(el => {
            if (el !== slotEl) el.classList.remove('slot-reorder-target');
        });
        if (slotEl && slotEl.dataset.slot !== dragState.fromSlot) {
            slotEl.classList.add('slot-reorder-target');
        }
    });

    container.addEventListener('drop', (e) => {
        if (!dragState.active) return;
        const slotEl = e.target.closest('.slot');
        const rowEl = e.target.closest('.product-row');
        e.preventDefault();
        if (slotEl) slotEl.classList.remove('slot-reorder-target');

        if (rowEl && rowEl.dataset.productId === dragState.productId) {
            const toSlot = slotEl ? slotEl.dataset.slot : null;
            if (toSlot && toSlot !== dragState.fromSlot) {
                reorderSlots(dragState.productId, dragState.fromSlot, toSlot);
            }
        }
    }, true); // capture: run before the external-drop listener above, which bails out via dragState.active anyway

    container.addEventListener('dragend', (e) => {
        const slotEl = e.target.closest('.slot');
        if (slotEl) slotEl.classList.remove('slot-reorder-source');
        container.querySelectorAll('.slot-reorder-target').forEach(el => el.classList.remove('slot-reorder-target'));
        dragState.active = false;
        dragState.productId = null;
        dragState.fromSlot = null;
        hideGhost();
    });

    // Reorders slot assignments within a product: removes the image
    // at fromSlot and re-inserts it at toSlot's position, shifting
    // everything in between over by one (like reordering a list) —
    // rather than a plain two-way swap, which would feel wrong when
    // dragging into a middle slot with other filled slots around it.
    function reorderSlots(productId, fromSlot, toSlot) {
        const d = state.results[productId];
        if (!d || !d.slotAssignments) return;

        const values = SLOTS.map(s => d.slotAssignments[s] || null);
        const fromIdx = SLOTS.indexOf(fromSlot);
        const toIdx = SLOTS.indexOf(toSlot);
        if (fromIdx === -1 || toIdx === -1) return;

        const [moved] = values.splice(fromIdx, 1);
        values.splice(toIdx, 0, moved);

        SLOTS.forEach((s, i) => {
            d.slotAssignments[s] = values[i];
            updateSlot(productId, s, values[i]);
        });
        markCommitDirty(productId);
        requestFilterRefresh();
    }

    function setItems(newItems) {
        // The DB loader already updates state; this method is intentionally
        // lightweight so the renderer has one stable entry point.
        refresh();
        updateFilterCount();
    }

    // Builds one <div class="slot-tier-badge"...> style commit button
    // for a color row and wires its click handler. Kept here (not in
    // createRowSkeleton) so it's easy to find alongside the other
    // per-row buttons wired in the container's delegated click handler.
    function buildCommitButtonHTML() {
        return `<button class="commit-row-btn rt-commit" type="button" title="Save this color's current images to the database">Commit</button>`;
    }

    function refresh() {
        container.innerHTML = '';

        const activeIndices = state.filteredIndices;
        let itemsToRender = activeIndices
            ? activeIndices.map(idx => state.products[idx])
            : state.products.slice();

        if (!itemsToRender || itemsToRender.length === 0) {
            if (state.products.length === 0) {
                container.innerHTML = '<div class="hint">Loading products…</div>';
            } else {
                container.innerHTML = '<div class="hint">No products match the current filters.</div>';
            }
            return;
        }

        if (state.sortByTier) {
            itemsToRender = itemsToRender.slice().sort(compareByTier);
        }

        // Group flat color-level items into per-product branches. Order
        // of first appearance is preserved (matches DB load order, or
        // whatever order sortByTier / filtering produced).
        const groups = [];
        const groupByParentId = new Map();
        itemsToRender.forEach(product => {
            const parentId = product.parentProductId != null ? product.parentProductId : product.id;
            let g = groupByParentId.get(parentId);
            if (!g) {
                g = { parentId, parentLabel: product.parentLabel || '', parentMeta: product.parentMeta || '', items: [] };
                groupByParentId.set(parentId, g);
                groups.push(g);
            }
            g.items.push(product);
        });

        const frag = document.createDocumentFragment();
        groups.forEach(g => {
            const groupEl = document.createElement('div');
            groupEl.className = 'product-group';
            groupEl.dataset.parentProductId = g.parentId;

            const head = document.createElement('div');
            head.className = 'product-group-head';
            head.innerHTML = `<div><span class="pg-name">${escapeHtml(g.parentLabel)}</span><span class="pg-meta">${escapeHtml(g.parentMeta)} &middot; ${g.items.length} color${g.items.length === 1 ? '' : 's'}</span></div>`;
            groupEl.appendChild(head);

            const colorsWrap = document.createElement('div');
            colorsWrap.className = 'product-group-colors product-rows';
            g.items.forEach(product => {
                const row = createRowSkeleton(product);
                paintRow(row, product);
                colorsWrap.appendChild(row);
            });
            groupEl.appendChild(colorsWrap);

            frag.appendChild(groupEl);
        });
        container.appendChild(frag);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function createRowSkeleton(product) {
        const row = document.createElement('div');
        row.className = 'product-row';
        row.id = `row-${product.id}`;
        row.dataset.productId = product.id;
        row.innerHTML = `
            <div class="row-head">
                <div class="row-title"><b class="rt-id"></b><span class="rt-name"></span><span class="cat-tag rt-cat"></span><span class="existing-badge rt-existing"></span></div>
                <div class="row-head-right">
                    <button class="search-window-btn rt-search-window" type="button" title="Open a real Bing Images search for this product in a side window">🔍 Search Window</button>
                    <button class="retry-btn rt-retry" type="button" title="Re-run sourcing for this product only, from scratch">↻ Try Again</button>
                    ${buildCommitButtonHTML()}
                    <div class="row-status rt-status">queued…</div>
                </div>
            </div>
            <div class="slots">
                ${SLOTS.map((s, idx) => `
                    <div class="slot" data-slot="${s}">
                        <div class="slot-head"><span>Image ${idx + 1}</span></div>
                        <div class="slot-body" tabindex="0"><div class="empty">pending…</div></div>
                        <div class="slot-drop-hint">Drop or paste<br>image to assign</div>
                    </div>
                `).join('')}
            </div>
            <div class="quick-picks" style="display:none;"></div>
        `;
        return row;
    }

    function paintRow(row, product) {
        row.querySelector('.rt-id').textContent = product.colorId || product.id;
        row.querySelector('.rt-name').textContent = ` ${product.color || 'Color'} · ${product.sku || 'No model code'} `;
        row.querySelector('.rt-cat').textContent = product.category || '—';
        const existing = row.querySelector('.rt-existing');
        if (existing) {
            const n = Array.isArray(product.existingImages) ? product.existingImages.length : 0;
            existing.textContent = n ? `DB: ${n}/5` : 'DB: empty';
            existing.classList.toggle('has-images', n > 0);
        }

        const result = state.results[product.id];
        const statusEl = row.querySelector('.rt-status');
        statusEl.textContent = result ? (result._statusText || 'queued…') : 'queued…';

        const norm = normalizeQuery(product);
        const needsAttention = !!(result && result._needsAttention);
        renderQuickPicks(product, norm, row);

        SLOTS.forEach((s) => {
            const slotEl = row.querySelector(`.slot[data-slot="${s}"]`);
            const assignment = result && result.slotAssignments ? result.slotAssignments[s] : null;
            paintSlot(slotEl, assignment);
        });
    }

    function paintSlot(slotEl, assignment) {
        if (!slotEl) return;
        const body = slotEl.querySelector('.slot-body');
        if (assignment) {
            const isManual = assignment.confidence === 'Manually Added';
            const isBestEffort = assignment.confidence === 'Unverified (Best Effort)';
            const isWeakRescue = assignment.confidence === 'Unverified (Weak Match — Review)';
            const isUnverified = isBestEffort || isWeakRescue;
            const badgeText = isManual ? 'Manual' : isWeakRescue ? 'Review' : isBestEffort ? 'Unverified' : (assignment.confidence || '').replace('Meta-Verified ', '').replace('URL-Verified ', '');
            body.innerHTML = `
                <button class="slot-delete" title="Remove image" type="button">×</button>
                ${badgeText ? `<span class="slot-tier-badge${isManual ? ' slot-tier-badge-manual' : ''}${isUnverified ? ' slot-tier-badge-unverified' : ''}" title="${assignment.confidence || ''}">${badgeText}</span>` : ''}
                <img src="${assignment.url}" alt="slot image" loading="lazy" decoding="async" draggable="false">
            `;
            slotEl.dataset.tier = String(confidenceRank(assignment.confidence));
            slotEl.setAttribute('draggable', 'true');
        } else {
            body.innerHTML = '<div class="empty">pending…</div>';
            delete slotEl.dataset.tier;
            slotEl.setAttribute('draggable', 'false');
        }
    }

    function updateProductStatus(productId, statusText) {
        const result = state.results[productId];
        if (result) result._statusText = statusText;
        const row = document.getElementById(`row-${productId}`);
        if (row) {
            const el = row.querySelector('.rt-status');
            if (el) el.textContent = statusText;
        }
    }

    function updateSlot(productId, slotKey, assignment) {
        const result = state.results[productId];
        if (result) {
            if (!result.slotAssignments) result.slotAssignments = {};
            result.slotAssignments[slotKey] = assignment;
        }
        const row = document.getElementById(`row-${productId}`);
        if (row) {
            const slotEl = row.querySelector(`.slot[data-slot="${slotKey}"]`);
            paintSlot(slotEl, assignment);
        }
    }

    function updateQuickPicks(productId, needsAttention, product, norm) {
        const result = state.results[productId];
        if (result) result._needsAttention = needsAttention;
        const row = document.getElementById(`row-${productId}`);
        if (row) renderQuickPicks(product, norm, row);
    }

    function getMountedRow(productId) {
        return document.getElementById(`row-${productId}`);
    }

    return {
        setItems,
        refresh,
        updateProductStatus,
        updateSlot,
        updateQuickPicks,
        getMountedRow,
    };
})();
/* ============================================================
   PIPELINE (per product) — returns a structured debug object
   ============================================================ */
async function runPipelineForProduct(product) {
    const debug = {
        id: product.id,
        brand: product.brand,
        sku: product.sku,
        category: product.category,
        startedAt: new Date().toISOString(),
        norm: null,
        product,
        rawCandidateCount: 0,
        fetchError: null,
        candidateEvaluations: [],
        slotAssignments: {},
        fallbackUsed: false,
        fallbackEvaluations: [],
        rescueUsedForSlotA: false,
        zeroFillRescueUsed: false,
        previewCandidates: [],
        totalAssigned: 0,
        finishedAt: null,
        finalNote: null,
        _statusText: 'normalizing…',
        _needsAttention: false,
    };
    state.results[product.id] = debug;

    const setRowStatus = (text) => virtualList.updateProductStatus(product.id, text);

    SLOTS.forEach(s => virtualList.updateSlot(product.id, s, null));
    setRowStatus('normalizing…');

    const norm = normalizeQuery(product);
    debug.norm = norm;

    setRowStatus('sourcing (Bing)…');
    // Multi-word brands are NOT wrapped in a single quoted phrase.
    // Quoting "On Running" as one exact phrase is fragile — common
    // English words in a brand name (like "On" and "Running") make
    // Bing's phrase-matching unreliable and prone to pulling in
    // totally unrelated results that just happen to contain those
    // words near each other. Each brand word gets its own quotes
    // instead (e.g. "On" "Running" "1WD30080554"), which keeps the
    // "must appear" guarantee per-word without forcing exact adjacency.
    const brandQueryPart = (norm.brand || '').trim().split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' ');
    let candidates, fetchError, initialSuspectedOffTopic;
    ({ images: candidates, error: fetchError, suspectedOffTopic: initialSuspectedOffTopic } = await fetchFromBing(`${brandQueryPart} "${norm.sku}"`, 30));
    debug.rawCandidateCount = candidates.length;
    debug.fetchError = fetchError;
    debug.retryUsed = false;
    debug.suspectedOffTopicSource = !!initialSuspectedOffTopic;

    if (fetchError) {
        setRowStatus(`error: ${fetchError}`);
    }

    // Safety net for products where the exact brand+SKU search comes
    // back thin or wildly off-topic (e.g. a SKU number that happens
    // to be indexed for something else entirely — fonts, car parts,
    // etc.). If we got very few raw results, or NONE of them even
    // mention the brand anywhere, retry once with a looser query
    // (brand + category, no SKU) so there's at least a shot at a
    // same-brand/same-type image instead of nothing at all.
    const cleanBrandCheck = (norm.brand || '').toLowerCase().replace(/[-_\s&]/g, '');
    function countBrandMentions(list) {
        return list.filter(c => {
            const meta = [c.title, c.murl, c.turl, c.purl].filter(Boolean).join(' ').toLowerCase().replace(/[-_\s&]/g, '');
            return cleanBrandCheck && meta.includes(cleanBrandCheck);
        }).length;
    }
    const initialBrandHits = countBrandMentions(candidates);
    if (!fetchError && (candidates.length < 5 || initialBrandHits === 0)) {
        setRowStatus('few/no on-brand results — retrying with a broader search…');
        const looseQuery = `${norm.brand} ${(product.category || '').trim()}`.trim();
        const retry = await fetchFromBing(looseQuery, 30);
        if (retry.suspectedOffTopic) debug.suspectedOffTopicSource = true;
        if (!retry.error && retry.images.length > 0) {
            // MERGE, don't replace. The original strict-query candidates
            // are the ONLY ones that can ever carry a SKU match — fully
            // discarding them in favor of the loose (SKU-less) retry
            // meant every candidate downstream was structurally capped
            // at "Brand only" at best, even when a real SKU-matching
            // photo existed in the original batch but just didn't make
            // the top of Bing's ranking for the strict query. Keeping
            // both pools means verification (and slot-A's strict bar)
            // still has a shot at a real SKU match, while the loose
            // batch adds extra brand-corroborated candidates on top.
            const existingUrls = new Set(candidates.map(c => c.url));
            const newFromRetry = retry.images.filter(c => c.url && !existingUrls.has(c.url));
            const retryBrandHits = countBrandMentions(retry.images);

            if (retryBrandHits > initialBrandHits || newFromRetry.length > 0) {
                candidates = [...candidates, ...newFromRetry];
                debug.rawCandidateCount = candidates.length;
                debug.retryUsed = true;
                debug.retryQuery = looseQuery;
                debug.retryMergedCount = newFromRetry.length;
            } else {
                debug.retryAttemptedButNotUsed = true;
                debug.retryQuery = looseQuery;
            }
        } else {
            debug.retryAttemptedButNotUsed = true;
            debug.retryQuery = looseQuery;
        }
    }

    setRowStatus(`verifying ${candidates.length} candidates…`);

    // Verify every candidate up front, then assign in confidence-tier
    // order (best matches first) rather than Bing's arbitrary return
    // order — otherwise an early low-confidence "Brand only" match
    // could take a slot ahead of a stronger SKU/URL-verified one that
    // happened to appear later in the results.
    const verifiedCandidates = [];
    const preAssignEvaluations = [];
    for (const item of candidates) {
        const targetUrl = item.url;
        const evalEntry = { title: item.title || '(no title)', url: item.url, murl: item.murl, purl: item.purl, turl: item.turl, steps: [] };

        if (!targetUrl) {
            evalEntry.steps.push('skipped: missing url');
            preAssignEvaluations.push(evalEntry);
            continue;
        }

        const verification = verifyCandidateMatch(item, norm.brand, norm.sku, norm.catKey);
        evalEntry.verification = verification;
        if (!verification.valid) {
            evalEntry.steps.push(`rejected: ${verification.reason}`);
            preAssignEvaluations.push(evalEntry);
            continue;
        }
        evalEntry.steps.push(`passed verification: ${verification.confidence}`);
        verifiedCandidates.push({ item, evalEntry, verification });
    }

    // Quick-picks preview — built AFTER verification, not sliced raw
    // off the top of `candidates`. A query with thin real results often
    // gets padded with completely off-topic filler (e.g. an ankle-x-ray
    // flood ahead of the actual shoe photos further down the list), so
    // grabbing the literal first 10 raw items can hand the user 10
    // pictures of the wrong THING entirely. Candidates that at least
    // matched the brand or SKU somewhere in their metadata go first;
    // raw top-of-list filler only fills in any remaining slots.
    const evalByUrl = new Map();
    preAssignEvaluations.forEach(e => evalByUrl.set(e.url, e));
    verifiedCandidates.forEach(({ evalEntry: e }) => evalByUrl.set(e.url, e));

    const relevantPreview = [];
    const fallbackPreview = [];
    for (const c of candidates) {
        if (!c.url) continue;
        const e = evalByUrl.get(c.url);
        const isRelevant = !!(e && e.verification && e.verification.debugInfo
            && (e.verification.debugInfo.brandMatches || e.verification.debugInfo.skuMatches));
        (isRelevant ? relevantPreview : fallbackPreview).push({ url: c.url, turl: c.turl, title: c.title });
    }
    debug.previewCandidates = [...relevantPreview, ...fallbackPreview].slice(0, 10);
    // Primary sort: confidence tier (unchanged). Secondary sort: domain
    // trust score — within the same tier, prefer candidates from known-
    // reliable domains (or domains your own manual corrections have
    // vouched for) over unknown/noisy ones. This never lets a low-tier
    // trusted-domain result beat a high-tier one; it only breaks ties
    // inside a tier, which is where domain quality actually matters
    // most (several "Meta-Verified (Brand + SKU)" candidates, pick the
    // one from the real retailer over the one from a repost site).
    verifiedCandidates.sort((a, b) => {
        const tierDiff = confidenceRank(a.verification.confidence) - confidenceRank(b.verification.confidence);
        if (tierDiff !== 0) return tierDiff;
        return domainTrustScore(b.item.url) - domainTrustScore(a.item.url);
    });

    const assignedHashes = [];
    const assignedUrls = new Set();
    let totalAssigned = 0;
    let strongTierAssigned = false; // true once a slot holds a real SKU-confirmed match

    // Confidence tiers considered too weak to trust as the primary/
    // cover image (slot A) even though they're fine for supporting
    // slots B-E — slot A is the one most likely to be treated
    // downstream as *the* canonical product photo, so it gets the
    // strictest bar.
    const WEAK_TIERS_FOR_SLOT_A = new Set([
        'Meta-Verified (Brand only)',
        'Meta-Verified (SKU only)',
        'Unverified (Best Effort)',
    ]);

    // Tiers that only confirm the BRAND, not the specific product —
    // see AUTO_FILL_POLICY.avoidRiskyFillWhenStrongMatchExists above.
    const RISKY_TIERS = new Set([
        'Meta-Verified (Brand only)',
        'Unverified (Best Effort)',
    ]);
    const STRONG_TIER_RANK_CUTOFF = confidenceRank('Meta-Verified (SKU only)');

    // Candidates that passed verification but were skipped ONLY because
    // of the slot-A strict-match rule (still totalAssigned === 0 at the
    // time). Kept aside so the rescue pass below can use them if nothing
    // else ever qualifies for slot A at all — see
    // AUTO_FILL_POLICY.rescueSlotAWhenNothingElseQualifies.
    const skippedForSlotA = [];

    // Shared by both the main pass and the rescue pass: render-check,
    // dedupe-check, then write into the next open slot.
    async function tryAssignCandidate(entry) {
        const { item, evalEntry, verification } = entry;
        let targetUrl = item.url;
        if (assignedUrls.has(targetUrl)) {
            evalEntry.steps.push('skipped: already assigned');
            return false;
        }

        let renders = await checkImageRenders(targetUrl);
        if (!renders && item.turl) {
            evalEntry.steps.push('main url failed to render, trying thumbnail (turl)');
            targetUrl = item.turl;
            renders = await checkImageRenders(targetUrl);
        }
        if (!renders) {
            evalEntry.steps.push('rejected: image did not render (main + thumbnail both broken)');
            return false;
        }
        evalEntry.steps.push(`image rendered ok (using ${targetUrl === item.url ? 'main url' : 'thumbnail url'})`);

        const imgData = await averageHash(targetUrl);
        if (imgData && imgData.hash) {
            // Threshold kept at 7 after the aHash->dHash switch: dHash is
            // 72 bits (9x8) vs the old 64-bit aHash, so 7 is now a
            // slightly tighter ~10% of bits (was ~11%) — still the same
            // "near duplicate, not just similar" cutoff, not loosened.
            const isDupe = assignedHashes.some(prevHash => hammingDistance(prevHash, imgData.hash) <= 7);
            if (isDupe) {
                evalEntry.steps.push('rejected: near-duplicate of an already-assigned image (hamming <= 7)');
                return false;
            }
            assignedHashes.push(imgData.hash);
            evalEntry.dims = imgData.dims;
        }

        assignedUrls.add(targetUrl);
        const slotKey = SLOTS[totalAssigned];
        virtualList.updateSlot(product.id, slotKey, { url: targetUrl, confidence: verification.confidence });
        debug.slotAssignments[slotKey] = { url: targetUrl, confidence: verification.confidence };
        evalEntry.steps.push(`ASSIGNED to slot ${slotKey}`);
        if (confidenceRank(verification.confidence) <= STRONG_TIER_RANK_CUTOFF) strongTierAssigned = true;
        totalAssigned++;
        return true;
    }

    for (const entry of verifiedCandidates) {
        const { evalEntry, verification } = entry;
        if (totalAssigned >= 5) {
            evalEntry.steps.push('skipped: all 5 slots already filled by higher- or equal-tier matches');
            debug.candidateEvaluations.push(evalEntry);
            continue;
        }

        if (totalAssigned === 0 && AUTO_FILL_POLICY.requireStrictMatchForSlotA && WEAK_TIERS_FOR_SLOT_A.has(verification.confidence)) {
            evalEntry.steps.push(`skipped for slot A: tier "${verification.confidence}" is below the strict bar required for the primary image slot (still eligible for slots B-E)`);
            skippedForSlotA.push(entry);
            debug.candidateEvaluations.push(evalEntry);
            continue;
        }

        if (AUTO_FILL_POLICY.avoidRiskyFillWhenStrongMatchExists && strongTierAssigned && RISKY_TIERS.has(verification.confidence)) {
            evalEntry.steps.push(`skipped: tier "${verification.confidence}" only confirms the brand, and this product already has a real SKU-confirmed match — leaving this slot empty rather than risking a different product's photo (see quick picks)`);
            debug.candidateEvaluations.push(evalEntry);
            continue;
        }

        await tryAssignCandidate(entry);
        debug.candidateEvaluations.push(evalEntry);
    }

    // Tracked for the debug log summary — how many otherwise-valid
    // candidates this product had that were blocked purely by the
    // slot-A strict bar, regardless of whether the rescue pass below
    // ends up using any of them.
    debug.slotARestrictedCandidateCount = skippedForSlotA.length;

    // RESCUE PASS — fires only when NOTHING could be assigned above, and
    // only because every valid candidate was blocked purely by the
    // slot-A strict bar. Two hard limits keep this safe:
    //
    // 1. Only "Meta-Verified (SKU only)" candidates are eligible — the
    //    exact SKU string was found in the page's own metadata, just
    //    without brand corroboration (e.g. the brand name was written
    //    differently, or omitted from the alt text). "Brand only"
    //    matches are excluded on purpose: they confirm nothing except
    //    that a page mentions the same brand, which could be ANY other
    //    product in that brand's entire catalog — rescuing with one of
    //    those doesn't reduce the blank-row problem, it just swaps a
    //    visible 0/5 for an invisible wrong-product 5/5.
    // 2. At most ONE slot (A) is ever filled this way, then the pass
    //    stops — it does not keep consuming further skipped candidates
    //    to fill B-E. Each skipped candidate can be a different
    //    underlying product, so using several of them back-to-back is
    //    exactly how a row ends up "5/5, every slot a different shoe."
    //    Slots B-E stay empty and go through the quick-picks strip
    //    instead, where a human actually looks at each one.
    const RESCUABLE_TIERS_FOR_SLOT_A = new Set(['Meta-Verified (SKU only)']);
    if (totalAssigned === 0 && AUTO_FILL_POLICY.rescueSlotAWhenNothingElseQualifies) {
        const rescueCandidate = skippedForSlotA.find(e => RESCUABLE_TIERS_FOR_SLOT_A.has(e.verification.confidence));
        if (rescueCandidate) {
            setRowStatus('no strict slot-A match found — rescuing with the best SKU-confirmed match…');
            rescueCandidate.evalEntry.steps.push('RESCUE: no candidate anywhere passed the strict slot-A bar for this product, so this SKU-confirmed (but brand-unconfirmed) match was allowed into slot A alone, rather than leaving the row fully blank — slots B-E are left for the quick picks strip');
            const assigned = await tryAssignCandidate(rescueCandidate);
            if (assigned) debug.rescueUsedForSlotA = true;
        }
    }

    // Preserve original candidate order in the debug log (skipped +
    // evaluated), rather than the tier-sorted assignment order.
    debug.candidateEvaluations = [...preAssignEvaluations, ...debug.candidateEvaluations]
        .sort((a, b) => candidates.findIndex(c => c.url === a.url) - candidates.findIndex(c => c.url === b.url));

    for (let i = totalAssigned; i < SLOTS.length; i++) {
        virtualList.updateSlot(product.id, SLOTS[i], null);
        debug.slotAssignments[SLOTS[i]] = null;
    }

    if (totalAssigned === 0) {
        debug.fallbackUsed = AUTO_FILL_POLICY.allowBestEffortFallback;
        let bestEffortAssigned = false;

        if (AUTO_FILL_POLICY.allowBestEffortFallback) {
            setRowStatus('no verified matches found — trying a best-effort single image…');

            // Even when nothing passes verification, leaving the row
            // completely blank is worse than a single clearly-labeled
            // "best guess" image the user can confirm or replace via the
            // quick picks strip. We pick the first raw candidate that at
            // least (a) renders and (b) isn't obviously unrelated (still
            // requires a loose brand-token overlap so we don't hand back
            // something totally random like a font ad) — never more than
            // one slot, and always tagged "Unverified" so it can't be
            // mistaken for a real match.
            const cleanBrandLoose = (norm.brand || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            for (const item of candidates) {
                if (!item.url) continue;
                const meta = [item.title, item.murl, item.turl, item.purl].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9]/g, '');
                const looseBrandHit = cleanBrandLoose && cleanBrandLoose.length > 3 && meta.includes(cleanBrandLoose);
                if (!looseBrandHit) continue;

                let targetUrl = item.url;
                let renders = await checkImageRenders(targetUrl);
                if (!renders && item.turl) {
                    targetUrl = item.turl;
                    renders = await checkImageRenders(targetUrl);
                }
                if (!renders) continue;

                virtualList.updateSlot(product.id, SLOTS[0], { url: targetUrl, confidence: 'Unverified (Best Effort)' });
                debug.slotAssignments[SLOTS[0]] = { url: targetUrl, confidence: 'Unverified (Best Effort)' };
                totalAssigned = 1;
                bestEffortAssigned = true;
                debug.fallbackEvaluations.push({ title: item.title || '(no title)', url: targetUrl, steps: ['ASSIGNED as best-effort (unverified) — brand text loosely present, image renders, nothing passed strict verification'] });
                break;
            }

            setRowStatus(bestEffortAssigned
                ? 'no verified matches — filled 1 slot as a best-effort guess, review recommended…'
                : 'no verified matches found — check quick picks below…');
        } else {
            // Policy default: don't auto-write an unverified guess into
            // a slot at all. The row stays honestly empty; every raw
            // candidate is still logged so the quick picks strip (and the
            // debug log) has full context to choose from.
            setRowStatus('no verified matches found — check quick picks below…');
        }

        // SCORED ZERO-FILL RESCUE — runs only if the product is STILL
        // 0/5 after everything above (including the plain best-effort
        // fallback, which is off by default and only fills 1 slot on a
        // loose brand-substring hit anyway). Unlike that fallback, this
        // scores every rejected-but-brand-matching candidate (see
        // scoreZeroFillCandidate) and only auto-fills the top 1-2 if
        // they clear zeroFillRescueScoreMinimum — candidates that are
        // the right brand but visibly the wrong product (a bag instead
        // of a hoodie, a different SKU's sunglasses line, etc.) score
        // too low on category corroboration to pass and are left for
        // the quick picks strip instead, same as before.
        if (totalAssigned === 0 && AUTO_FILL_POLICY.enableScoredZeroFillRescue) {
            const candidateByUrl = new Map(candidates.map(c => [c.url, c]));
            const scored = preAssignEvaluations
                .filter(e => e.verification && e.verification.debugInfo && e.verification.debugInfo.brandMatches)
                .map(e => {
                    const item = candidateByUrl.get(e.url);
                    if (!item) return null;
                    const score = scoreZeroFillCandidate(item, e.verification, norm);
                    return { item, evalEntry: e, score };
                })
                .filter(e => e && e.score >= AUTO_FILL_POLICY.zeroFillRescueScoreMinimum)
                .sort((a, b) => b.score - a.score);

            if (scored.length) {
                setRowStatus(`no strict matches — auto-filling top ${Math.min(scored.length, AUTO_FILL_POLICY.zeroFillRescueMaxSlots)} scored guess(es), review recommended…`);
            }

            for (const { item, evalEntry, score } of scored) {
                if (totalAssigned >= AUTO_FILL_POLICY.zeroFillRescueMaxSlots) break;
                if (assignedUrls.has(item.url)) continue;

                let targetUrl = item.url;
                let renders = await checkImageRenders(targetUrl);
                if (!renders && item.turl) {
                    targetUrl = item.turl;
                    renders = await checkImageRenders(targetUrl);
                }
                if (!renders) {
                    evalEntry.steps.push('zero-fill rescue: candidate scored above the floor but image did not render — skipped');
                    continue;
                }

                // Same dedupe-by-visual-hash guard as the main assignment
                // pass, so two rescue picks can't end up being near-
                // identical crops of the same photo.
                const imgData = await averageHash(targetUrl);
                if (imgData && imgData.hash) {
                    const isDupe = assignedHashes.some(prevHash => hammingDistance(prevHash, imgData.hash) <= 7);
                    if (isDupe) {
                        evalEntry.steps.push('zero-fill rescue: near-duplicate of an already-rescued image — skipped');
                        continue;
                    }
                    assignedHashes.push(imgData.hash);
                }

                assignedUrls.add(targetUrl);
                const slotKey = SLOTS[totalAssigned];
                const confidence = 'Unverified (Weak Match — Review)';
                virtualList.updateSlot(product.id, slotKey, { url: targetUrl, confidence });
                debug.slotAssignments[slotKey] = { url: targetUrl, confidence };
                evalEntry.steps.push(`zero-fill rescue: ASSIGNED to slot ${slotKey} (score ${score}) — brand matched, category-corroborated, nothing passed strict SKU verification; please double-check`);
                totalAssigned++;
                debug.zeroFillRescueUsed = true;
            }
        }

        for (const item of candidates.slice(0, 10)) {
            if (debug.fallbackEvaluations.some(e => e.url === item.url)) continue;
            const reason = AUTO_FILL_POLICY.allowBestEffortFallback
                ? 'not auto-assigned: fallback auto-fill disabled beyond the single best-effort slot, use the quick picks strip'
                : 'not auto-assigned: best-effort fallback auto-fill is turned off (AUTO_FILL_POLICY.allowBestEffortFallback), use the quick picks strip';
            debug.fallbackEvaluations.push({ title: item.title || '(no title)', url: item.url, steps: [reason] });
        }
    }

    debug.totalAssigned = totalAssigned;
    debug.dirty = true;
    debug.committed = false;
    debug.finishedAt = new Date().toISOString();
    debug.finalNote = totalAssigned === 0
        ? 'FAILED: no usable images found at all.'
        : (debug.zeroFillRescueUsed ? `Filled ${totalAssigned}/5 via scored zero-fill rescue (unverified — review recommended).`
            : (debug.fallbackUsed ? `Filled ${totalAssigned}/5 via unverified fallback.` : `Filled ${totalAssigned}/5 via verified matching.`));

    const finalStatus = `done — ${totalAssigned}/5 filled${debug.zeroFillRescueUsed ? ' (scored rescue — review)' : debug.fallbackUsed ? ' (fallback)' : ''}`;
    setRowStatus(finalStatus);

    const needsAttention = debug.fallbackUsed || debug.rescueUsedForSlotA || totalAssigned < 5;
    virtualList.updateQuickPicks(product.id, needsAttention, product, norm);

    requestFilterRefresh();

    return debug;
}

// Tracks product IDs currently re-running via the manual "Try Again"
// button, so a double-click (or clicking Retry while the initial
// batch run hasn't reached this product yet) can't kick off two
// overlapping pipelines for the same row stomping on each other's
// slot writes.
const retryingProductIds = new Set();

// Manual per-product retry. Every Bing request already hits fresh
// (no cache to invalidate), so this is just "run the same product
// through the pipeline again, isolated from the rest of the batch."
// Useful for the random-noise-result case: instead of waiting for a
// full re-run of the whole catalog, or hoping the built-in single
// auto-retry-on-thin-results kicks in, the user can force a clean
// second (or third) attempt at just the one row that came back bad,
// with the full 30-candidate search and full verification pass again.
async function retryProduct(product, buttonEl) {
    const productId = product.id;
    if (retryingProductIds.has(productId)) return; // already retrying — ignore extra clicks
    retryingProductIds.add(productId);

    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = '↻ Retrying…';
    }

    // Visibly reset the row first so it's obvious a fresh attempt is
    // running, rather than looking like nothing happened until the
    // new result lands.
    SLOTS.forEach(s => virtualList.updateSlot(productId, s, null));
    virtualList.updateProductStatus(productId, 'retrying — re-sourcing from scratch…');

    try {
        await runPipelineForProduct(product);
    } catch (e) {
        virtualList.updateProductStatus(productId, `error: ${e.message}`);
    } finally {
        retryingProductIds.delete(productId);
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = '↻ Try Again';
        }
        requestFilterRefresh();
    }
}

/* ============================================================
   CONCURRENT PIPELINE RUNNER
   Runs up to CONCURRENCY products at once instead of one at a
   time. This is what makes "thousands of products" finish in a
   reasonable amount of time — throughput scales with CONCURRENCY
   instead of being capped at 1 request round-trip at a time.
   ============================================================ */
async function runAllPipelines(items) {
    if (items.length === 0) return;
    setStatus(`processing 0/${items.length}…`);

    const progressTrack = $('progressBarTrack');
    const progressFill = $('progressBarFill');
    if (progressTrack && progressFill) {
        progressTrack.classList.add('is-active');
        progressFill.classList.remove('is-complete');
        progressFill.style.width = '0%';
    }

    let done = 0;
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const myIndex = nextIndex++;
            const product = items[myIndex];
            try {
                await runPipelineForProduct(product);
            } catch (e) {
                virtualList.updateProductStatus(product.id, `error: ${e.message}`);
            }
            done++;
            setStatus(`processing ${done}/${items.length}…`);
            if (progressFill) {
                progressFill.style.width = `${Math.round((done / items.length) * 100)}%`;
            }
        }
    }

    const workerCount = Math.min(CONCURRENCY, items.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    setStatus(`complete — ${items.length} product(s) processed`);
    if (progressFill) progressFill.classList.add('is-complete');
    updateFilterCount();
    renderCopyLogButton();
}

/* ============================================================
   QUICK PICKS — always-visible strip of the first 10 raw Bing
   candidates already fetched during the pipeline run (the same pool
   verifyCandidateMatch scored — no extra network request, no click
   needed to reveal it). Shown small, right under the 5 slots, for
   any product that isn't 5/5 filled yet. Click a thumb to drop it
   into the next open slot; click an already-added thumb again to
   pull it back out. This replaces the old "+ Add Manually" button,
   which required a click AND a fresh Bing fetch before you could see
   anything.
   ============================================================ */
function renderQuickPicks(product, norm, rowEl) {
    if (!rowEl) rowEl = virtualList.getMountedRow(product.id);
    if (!rowEl) return;
    const panel = rowEl.querySelector('.quick-picks');
    if (!panel) return;

    const d = state.results[product.id];
    const needsAttention = !!(d && d._needsAttention);

    if (!needsAttention) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    const preview = (d && d.previewCandidates) || [];
    panel.style.display = 'block';

    if (preview.length === 0) {
        panel.innerHTML = '<div class="quick-picks-hint">No raw candidates to preview yet — try 🔍 Search Window.</div>';
        return;
    }

    panel.innerHTML = `
        <div class="quick-picks-hint">Quick picks — top ${preview.length} raw results, click to add/remove:</div>
        <div class="quick-picks-grid" id="quickPicks-${cssEscape(product.id)}"></div>
    `;

    const grid = panel.querySelector('.quick-picks-grid');
    const frag = document.createDocumentFragment();
    preview.forEach((item, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'quick-pick-thumb';
        const usedSlotNow = d && SLOTS.find(s => d.slotAssignments[s] && d.slotAssignments[s].url === item.url);
        if (usedSlotNow) thumb.classList.add('quick-pick-thumb-used');
        thumb.innerHTML = `<img src="${item.turl || item.url}" alt="candidate ${i}" loading="lazy" decoding="async" title="${(item.title || '').replace(/"/g, '&quot;')}">`;
        thumb.addEventListener('click', () => {
            const dNow = state.results[product.id];
            if (!dNow) return;

            // Already assigned to a slot — tapping it again un-adds it.
            const usedSlot = SLOTS.find(s => dNow.slotAssignments[s] && dNow.slotAssignments[s].url === item.url);
            if (usedSlot) {
                clearSlot(product.id, usedSlot);
                thumb.classList.remove('quick-pick-thumb-used');
                return;
            }

            const slot = nextOpenSlot(product.id);
            if (!slot) {
                thumb.classList.add('quick-pick-thumb-full');
                setTimeout(() => thumb.classList.remove('quick-pick-thumb-full'), 700);
                return;
            }
            virtualList.updateSlot(product.id, slot, { url: item.url, confidence: 'Manually Added' });

            dNow.totalAssigned = SLOTS.filter(s => dNow.slotAssignments[s]).length;
            const stillNeedsAttention = dNow.totalAssigned < 5;
            dNow._needsAttention = stillNeedsAttention;
            virtualList.updateProductStatus(product.id, `${dNow.totalAssigned}/5 filled — added manually`);
            thumb.classList.add('quick-pick-thumb-used');
            requestFilterRefresh();

            if (!stillNeedsAttention) {
                // Row just hit 5/5 — hide the strip instead of leaving a
                // now-pointless picker open under a full row.
                renderQuickPicks(product, norm, rowEl);
            }
        });
        frag.appendChild(thumb);
    });
    grid.appendChild(frag);
}

function nextOpenSlot(productId) {
    const d = state.results[productId];
    if (!d) return SLOTS[0];
    for (const s of SLOTS) {
        if (!d.slotAssignments[s]) return s;
    }
    return null; // all 5 full
}

/* ============================================================
   DELETE / UN-ADD — clears a single slot (via the × button on
   an image, or by tapping an already-added thumb in the quick
   picks strip) and re-opens it for a new pick.
   ============================================================ */
function clearSlot(productId, slotKey) {
    const d = state.results[productId];
    if (!d) return;

    // Feed the correction back into learned domain trust: a manually-
    // cleared slot is a real human signal that this specific source
    // was wrong (or at least not good enough), regardless of what
    // confidence tier it auto-passed at. This is what lets domain
    // trust improve over time from actual usage instead of staying
    // fixed at the hardcoded static list.
    const clearedAssignment = d.slotAssignments && d.slotAssignments[slotKey];
    if (clearedAssignment && clearedAssignment.url && clearedAssignment.confidence !== 'Manually Added') {
        recordDomainOutcome(clearedAssignment.url, 'rejected');
    }

    // Remove the image at slotKey, then compact everything after it
    // left by one so there are no gaps between filled slots (e.g.
    // removing slot 3 of a full row shifts 4->3 and 5->4, leaving the
    // empty slot at the end rather than in the middle).
    const values = SLOTS.map(s => d.slotAssignments[s] || null);
    const idx = SLOTS.indexOf(slotKey);
    if (idx !== -1) {
        values.splice(idx, 1);
        values.push(null);
    }
    SLOTS.forEach((s, i) => {
        d.slotAssignments[s] = values[i];
        virtualList.updateSlot(productId, s, values[i]);
    });

    d.totalAssigned = SLOTS.filter(s => d.slotAssignments[s]).length;
    d._needsAttention = d.totalAssigned < 5;

    // Repaints the quick-picks strip too (thumb goes back to "not
    // added" state, or the strip reappears if this drop back below 5/5).
    virtualList.updateQuickPicks(productId, d._needsAttention, d.product, d.norm);
    virtualList.updateProductStatus(productId, `${d.totalAssigned}/5 filled — image removed`);

    requestFilterRefresh();
}

/* ============================================================
   COPY LOG — serializes state.results into a detailed text report
   ============================================================ */
function buildLogReport() {
    const lines = [];
    lines.push('='.repeat(70));
    lines.push('CATALOG IMAGE PIPELINE — DEBUG LOG');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Products processed: ${state.products.length}`);
    lines.push('='.repeat(70));

    /* --------------------------------------------------------
       SUMMARY SECTION — the questions you actually ask after a
       big batch run ("how many are empty", "why", "is it worth
       looking at") shouldn't require scrolling through thousands
       of lines of per-candidate detail to answer. This scans
       state.results once and prints the aggregate picture first.
       -------------------------------------------------------- */
    const allResults = state.products.map(p => state.results[p.id]).filter(Boolean);
    const fillCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const tierCounts = {};
    let eligibleButUnfilledSlots = 0; // candidates rejected specifically because auto-fill policy blocked their tier
    let genericSkuRejections = 0;
    let rescuedForSlotACount = 0; // products where slot A only got filled via the rescue pass
    let zeroFillRescueCount = 0;  // products that went from 0/5 to partially filled via the scored zero-fill rescue
    let suspectedOffTopicCount = 0; // products where Bing's own response looked like unrelated filler
    const emptyWithGoodCandidates = []; // 0/5 products that DO have eligibleForManualPicker candidates sitting there

    allResults.forEach(d => {
        const n = Math.min(5, Math.max(0, d.totalAssigned || 0));
        fillCounts[n] = (fillCounts[n] || 0) + 1;

        SLOTS.forEach(s => {
            const a = d.slotAssignments && d.slotAssignments[s];
            if (a) tierCounts[a.confidence] = (tierCounts[a.confidence] || 0) + 1;
        });

        if (d.rescueUsedForSlotA) rescuedForSlotACount++;
        if (d.zeroFillRescueUsed) zeroFillRescueCount++;
        if (d.suspectedOffTopicSource) suspectedOffTopicCount++;

        const eligibleCandidates = (d.candidateEvaluations || []).filter(c => c.verification && c.verification.eligibleForManualPicker);
        eligibleButUnfilledSlots += eligibleCandidates.length;
        genericSkuRejections += (d.candidateEvaluations || []).filter(c => c.verification && c.verification.debugInfo && c.verification.debugInfo.skuIsGeneric).length;

        if (n === 0 && eligibleCandidates.length > 0) {
            emptyWithGoodCandidates.push({ product: d.product, count: eligibleCandidates.length, best: eligibleCandidates[0] });
        }
    });

    lines.push('');
    lines.push('SUMMARY');
    lines.push('-'.repeat(70));
    lines.push(`  Fill-rate distribution:`);
    [5, 4, 3, 2, 1, 0].forEach(n => {
        const pct = allResults.length ? ((fillCounts[n] / allResults.length) * 100).toFixed(1) : '0.0';
        lines.push(`    ${n}/5 filled: ${fillCounts[n]} product(s)  (${pct}%)`);
    });

    lines.push('');
    lines.push(`  Assigned-slot tier breakdown (across all filled slots):`);
    CONFIDENCE_TIERS.forEach(t => {
        if (tierCounts[t]) lines.push(`    ${t}: ${tierCounts[t]}`);
    });

    lines.push('');
    lines.push(`  Candidates blocked by auto-fill policy (valid signal, but policy kept them out of a slot — see quick picks): ${eligibleButUnfilledSlots}`);
    lines.push(`  Candidates rejected for having a generic/short SKU with no brand corroboration: ${genericSkuRejections}`);
    if (rescuedForSlotACount > 0) {
        lines.push(`  ⚠ ${rescuedForSlotACount} product(s) had slot A rescued with a weaker-than-usual match (nothing else qualified) — worth a quick double-check, filter by "Needs attention" to find them.`);
    }
    if (zeroFillRescueCount > 0) {
        lines.push(`  ⚠ ${zeroFillRescueCount} product(s) went from fully empty (0/5) to partially filled via the scored zero-fill rescue (unverified, brand-matched-only guesses) — review these, they're tagged "Unverified (Weak Match — Review)" in their slots.`);
    }
    if (suspectedOffTopicCount > 0) {
        lines.push(`  ⚠ ${suspectedOffTopicCount} product(s) got a Bing response that shared no words at all with the query (likely off-topic filler, not real search results) — see the DIAGNOSIS line in each product's section below; re-running these later is usually more productive than adjusting matching rules.`);
    }

    if (emptyWithGoodCandidates.length > 0) {
        lines.push('');
        lines.push(`  ⚠ ${emptyWithGoodCandidates.length} product(s) are 0/5 filled BUT have quick-picks-eligible candidates waiting (policy-blocked, not "no images exist"):`);
        emptyWithGoodCandidates.slice(0, 25).forEach(({ product, count, best }) => {
            lines.push(`    - ${product.id} (${product.brand} ${product.sku}): ${count} eligible candidate(s), e.g. "${best.title}" [${best.verification.confidence}]`);
        });
        if (emptyWithGoodCandidates.length > 25) lines.push(`    ... and ${emptyWithGoodCandidates.length - 25} more (see per-product sections below, or filter by Tier = "Empty (0/5)" in the UI)`);
    } else if (fillCounts[0] > 0) {
        lines.push('');
        lines.push(`  ${fillCounts[0]} product(s) are 0/5 filled with NO quick-picks-eligible candidates either — these likely need a broader search or don't exist on Bing under this brand/SKU.`);
    }
    lines.push('-'.repeat(70));

    state.products.forEach(product => {
        const d = state.results[product.id];
        lines.push('');
        lines.push('-'.repeat(70));
        lines.push(`PRODUCT ${product.id} — ${product.brand} ${product.sku} (${product.category})`);
        lines.push('-'.repeat(70));

        if (!d) {
            lines.push('  (no result recorded — pipeline may not have run)');
            return;
        }

        lines.push(`  Started:  ${d.startedAt}`);
        lines.push(`  Finished: ${d.finishedAt}`);
        lines.push(`  Query used: "${d.norm.brand}" "${d.norm.sku}"  (base query: "${d.norm.baseQuery}", detected category key: ${d.norm.catKey}${d.norm.rawBrand && d.norm.rawBrand !== d.norm.brand ? `, brand split from catalog value "${d.norm.rawBrand}"` : ''})`);
        lines.push(`  Raw candidates fetched from Bing: ${d.rawCandidateCount}`);
        if (d.retryUsed) lines.push(`  RETRY: initial search was thin/off-brand, retried with broader query: "${d.retryQuery}" — merged in ${d.retryMergedCount || 0} new candidate(s) from the retry (original SKU-matching candidates were kept, not discarded)`);
        else if (d.retryAttemptedButNotUsed) lines.push(`  RETRY: initial search was thin/off-brand, retried with broader query: "${d.retryQuery}" — retry added nothing new, kept original results`);
        if (d.fetchError) lines.push(`  FETCH ERROR: ${d.fetchError}`);
        lines.push(`  Result: ${d.finalNote}`);
        lines.push(`  Slots filled: ${d.totalAssigned}/5${d.fallbackUsed ? ' (used unverified fallback)' : ''}${d.rescueUsedForSlotA ? ' (slot A rescued — see RESCUE note below, worth a quick look)' : ''}${d.zeroFillRescueUsed ? ' (scored zero-fill rescue — unverified, review recommended)' : ''}`);

        // "Why is this 0/5" auto-diagnosis — this is the exact question
        // that previously required manually grepping the whole log to
        // answer. If real candidates exist but were policy-blocked,
        // say so explicitly and point at the best one.
        if (d.totalAssigned === 0) {
            const eligible = (d.candidateEvaluations || []).filter(c => c.verification && c.verification.eligibleForManualPicker);
            if (eligible.length > 0) {
                lines.push(`  DIAGNOSIS: 0/5 filled, but ${eligible.length} candidate(s) were rejected only by auto-fill policy (not because they look wrong) — check the quick picks strip for this product. Best one: "${eligible[0].title}" [${eligible[0].verification.confidence}] -> ${eligible[0].url}`);
            } else if (d.slotARestrictedCandidateCount > 0) {
                const restricted = (d.candidateEvaluations || []).filter(c => c.verification
                    && ['Meta-Verified (Brand only)', 'Meta-Verified (SKU only)', 'Unverified (Best Effort)'].includes(c.verification.confidence)
                    && c.steps.some(s => s.includes('skipped for slot A')));
                const rescuableCount = restricted.filter(c => c.verification.confidence === 'Meta-Verified (SKU only)').length;
                if (rescuableCount === 0) {
                    lines.push(`  DIAGNOSIS: 0/5 filled — the only ${d.slotARestrictedCandidateCount} candidate(s) found were "Brand only" matches (same brand, unconfirmed model — could easily be a different product entirely), and those are excluded from auto-fill by design, not because anything looked broken. Check the quick picks strip and pick manually if one is actually the right item.`);
                } else {
                    lines.push(`  DIAGNOSIS: 0/5 filled — ${rescuableCount} SKU-confirmed candidate(s) existed and the rescue pass tried them, but none rendered or all were near-duplicates — check the quick picks strip for this product.`);
                }
            } else if ((d.candidateEvaluations || []).length === 0) {
                lines.push(`  DIAGNOSIS: 0/5 filled, and zero raw candidates were returned at all — likely a Bing fetch problem for this query, not a matching problem.`);
            } else if (d.suspectedOffTopicSource) {
                lines.push(`  DIAGNOSIS: 0/5 filled — Bing returned ${d.rawCandidateCount} result(s) but NONE shared a single word with the query (this smells like Bing backfilling a thin result set with unrelated filler, not a real "${d.product.brand} ${d.product.sku}" search) — re-running this product later, or checking it manually, is more likely to help than adjusting matching rules.`);
            } else {
                lines.push(`  DIAGNOSIS: 0/5 filled, and no candidates were even policy-eligible — genuinely thin/off-topic results for this brand+SKU, manual search recommended.`);
            }
        }

        lines.push('');
        lines.push('  Slot assignments:');
        SLOTS.forEach(s => {
            const a = d.slotAssignments[s];
            if (a) {
                lines.push(`    ${s}: ${a.confidence} -> ${a.url}`);
            } else {
                lines.push(`    ${s}: (empty)`);
            }
        });

        lines.push('');
        lines.push(`  Candidate-by-candidate evaluation (${d.candidateEvaluations.length} considered):`);
        d.candidateEvaluations.forEach((c, i) => {
            lines.push(`    [${i + 1}] "${c.title}"`);
            lines.push(`        url:  ${c.url}`);
            if (c.murl) lines.push(`        murl: ${c.murl}`);
            if (c.purl) lines.push(`        purl: ${c.purl}`);
            if (c.verification && c.verification.debugInfo) {
                const vi = c.verification.debugInfo;
                if (vi.rejectedForSize) {
                    lines.push(`        rejected for size (thumbnail below the ${AUTO_FILL_POLICY.minWidthPx}x${AUTO_FILL_POLICY.minHeightPx} floor)`);
                } else {
                    lines.push(`        computed: cleanBrand="${vi.cleanBrand}" baseSkuPart="${vi.baseSkuPart}" otherSkuParts=[${(vi.otherSkuParts || []).join(', ')}]${vi.skuIsGeneric !== undefined ? ` skuIsGeneric=${vi.skuIsGeneric}` : ''}${vi.skuIsSpecific !== undefined ? ` skuIsSpecific=${vi.skuIsSpecific}` : ''}`);
                    lines.push(`        brandMatches=${vi.brandMatches} skuMatches=${vi.skuMatches}${vi.suffixAlsoMatches !== undefined ? ` suffixAlsoMatches=${vi.suffixAlsoMatches}` : ''}${vi.isExactUrlMatch !== undefined ? ` isExactUrlMatch=${vi.isExactUrlMatch}` : ''}`);
                }
            }
            if (c.dims) lines.push(`        image dims: ${c.dims.w}x${c.dims.h}`);
            if (c.verification && c.verification.eligibleForManualPicker) {
                lines.push(`        ⚠ POLICY-BLOCKED, NOT REJECTED FOR QUALITY — this candidate matched at "${c.verification.confidence}" but AUTO_FILL_POLICY kept it out of a slot. Available in the quick picks strip.`);
            }
            c.steps.forEach(step => lines.push(`        - ${step}`));
        });

        if (d.fallbackUsed) {
            lines.push('');
            lines.push(`  FALLBACK evaluation (${d.fallbackEvaluations.length} considered, strict verification bypassed):`);
            d.fallbackEvaluations.forEach((c, i) => {
                lines.push(`    [${i + 1}] "${c.title}"`);
                lines.push(`        url: ${c.url}`);
                c.steps.forEach(step => lines.push(`        - ${step}`));
            });
        }
    });

    lines.push('');
    lines.push('='.repeat(70));
    lines.push('END OF LOG');
    lines.push('='.repeat(70));

    return lines.join('\n');
}

let copyLogResetTimer = null;

function renderCopyLogButton() {
    const container = $('copyLogContainer');
    if (!container) return;

    // Only build the button once; subsequent calls just refresh label/state,
    // so an in-progress click or fallback textarea isn't blown away mid-batch.
    let btn = $('copyLogBtn');
    let statusEl = $('copyLogStatus');
    if (!btn) {
        container.innerHTML = `<button id="copyLogBtn" class="copy-log-btn" type="button">📋 Copy Debug Log</button><span id="copyLogStatus" class="copy-log-status"></span>`;
        btn = $('copyLogBtn');
        statusEl = $('copyLogStatus');
        btn.addEventListener('click', handleCopyLogClick);
    }
}

async function handleCopyLogClick() {
    const btn = $('copyLogBtn');
    const statusEl = $('copyLogStatus');
    if (!btn || !statusEl) return;

    clearTimeout(copyLogResetTimer);
    statusEl.classList.remove('is-error');
    btn.disabled = true;
    const originalLabel = '📋 Copy Debug Log';
    btn.textContent = 'Copying…';

    const report = buildLogReport();

    try {
        await navigator.clipboard.writeText(report);
        btn.textContent = '✓ Copied';
        btn.classList.add('is-copied');
        statusEl.textContent = `${report.length.toLocaleString()} chars — ${state.products.length} product(s)`;
    } catch (err) {
        statusEl.classList.add('is-error');
        statusEl.textContent = 'Clipboard blocked — select & copy manually below';
        btn.textContent = originalLabel;

        let ta = $('copyLogFallback');
        if (!ta) {
            ta = document.createElement('textarea');
            ta.id = 'copyLogFallback';
            ta.className = 'copy-log-fallback';
            $('copyLogContainer').appendChild(ta);
        }
        ta.value = report;
        ta.style.display = 'block';
        ta.focus();
        ta.select();
    }

    btn.disabled = false;
    copyLogResetTimer = setTimeout(() => {
        btn.textContent = originalLabel;
        btn.classList.remove('is-copied');
        statusEl.textContent = '';
        statusEl.classList.remove('is-error');
    }, 2500);
}

/* ============================================================
   AUTO-LOAD FROM SUPABASE
   ============================================================ */
loadCatalogForImageLinking().catch(() => {});
