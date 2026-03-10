import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Track usage in plugin_usage table
async function trackUsage(supabaseUrl: string, serviceRoleKey: string, action: string, nodeCount: number, fileName: string) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/plugin_usage`, {
      method: "POST",
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        user_name: fileName || "unknown",
        action,
        node_count: nodeCount,
        category_count: 1,
      }),
    });
  } catch (e) {
    console.error("Failed to track usage:", e);
  }
}

// Flatten design tree → flat list.
// KEY CHANGE: preserves `allText` (pre-aggregated visible text), renames node.name → layerName
// so the AI cannot confuse Figma internal layer names with visible content.
function flattenDesignData(nodes: any[], maxDepth = 8): any[] {
  const flat: any[] = [];

  function traverse(node: any, path: string, depth: number) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    // Use actual text content as path label — NOT the layer name
    const displayLabel = node.characters?.trim() || node.allText?.split(' · ')[0] || node.name || node.type || "?";
    const currentPath = path ? `${path} > ${displayLabel}` : displayLabel;

    const n: any = {
      id: node.id,
      // ⚠ LAYER NAME — internal Figma identifier. NEVER use as label content.
      layerName: node.name,
      type: node.type,
      path: currentPath,
    };

    // TEXT CONTENT — ground truth for what is visible on screen
    if (node.characters) n.textContent = node.characters.trim();

    // ALL TEXT — pre-aggregated readable text from entire subtree (use this for labels!)
    if (node.allText)    n.allText = node.allText;

    if (node.fontSize)   n.fontSize = node.fontSize;

    // Spatial data — used for reading order
    if (node.x !== undefined) n.x = Math.round(node.x);
    if (node.y !== undefined) n.y = Math.round(node.y);
    if (node.width  !== undefined) n.w = Math.round(node.width);
    if (node.height !== undefined) n.h = Math.round(node.height);

    if (node.layoutMode) n.layoutMode = node.layoutMode;

    // Visual interactivity signals
    if (node.cornerRadius !== undefined && node.cornerRadius > 0) n.cornerRadius = node.cornerRadius;
    if (Array.isArray(node.fills) && node.fills.length > 0) {
      n.fillTypes = node.fills.filter((f: any) => f.visible !== false).map((f: any) => f.type);
    }

    // Structural interactivity signals (set by Figma plugin pre-pass)
    if (node._isComponent)           n.isComponent = true;
    if (node._inRepeatingGroup)      n.inRepeatingGroup = true;
    if (node._repeatingSiblingCount) n.repeatingSiblingCount = node._repeatingSiblingCount;
    if (node._isLeaf)                n.isLeaf = true;
    if (node._isIconButton)          n.isIconButton = true;   // icon-only, no text

    flat.push(n);

    const children = node.children || node.nodes;
    if (Array.isArray(children)) {
      for (const child of children) traverse(child, currentPath, depth + 1);
    }
  }

  for (const node of nodes) traverse(node, "", 0);
  return flat;
}

// Pre-compute a spatial overview with allText included so the AI sees real content
function buildSpatialSummary(flatNodes: any[]): string {
  const withPos = flatNodes.filter(n => n.x !== undefined && n.y !== undefined);
  if (withPos.length === 0) return "";

  const sorted = withPos
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, 100);

  const lines = sorted.map(n => {
    // Prefer allText → textContent → [TYPE]  — never the layerName
    const label = n.allText
      ? `"${n.allText.slice(0, 60)}"`
      : n.textContent
        ? `"${n.textContent}"`
        : `[${n.type}]`;
    const flags = [
      n.isComponent ? "COMPONENT" : "",
      n.inRepeatingGroup ? `REPEATING×${n.repeatingSiblingCount}` : "",
      n.isLeaf ? "LEAF" : "",
      n.isIconButton ? "ICON_BTN" : "",
      n.cornerRadius ? `r=${n.cornerRadius}` : "",
    ].filter(Boolean).join(" ");
    return `  [y=${n.y} x=${n.x} ${n.w}×${n.h}] ${label} type=${n.type}${flags ? " " + flags : ""}`;
  });
  return `FULL SPATIAL MAP — sorted by visual position (TOP→BOTTOM, LEFT→RIGHT).\nIMPORTANT: 'label' is the VISIBLE TEXT (allText or textContent), NOT the layer name. Use it directly for ariaLabel.\n${lines.join("\n")}`;
}

// Repeating group summary
function findRepeatingGroups(flatNodes: any[]): string {
  const groups: Record<string, any[]> = {};
  for (const n of flatNodes) {
    if (!n.inRepeatingGroup || !n.w || !n.h) continue;
    const key = `${n.w}×${n.h}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(n);
  }

  const summaries: string[] = [];
  for (const [size, members] of Object.entries(groups)) {
    if (members.length < 3) continue;
    const sortedMembers = [...members].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const sample = sortedMembers.slice(0, 6)
      .map(m => m.allText || m.textContent || m.layerName)
      .join(", ");
    summaries.push(`  - ${members.length} elements of size ${size} (visible content: ${sample}...)`);
  }

  if (summaries.length === 0) return "";
  return `DETECTED REPEATING INTERACTIVE GROUPS (every member MUST be in focus order, sequenced y then x):\n${summaries.join("\n")}`;
}

// Visual zone detector
function buildVisualZones(flatNodes: any[]): string {
  const withPos = flatNodes.filter(n => n.x !== undefined && n.y !== undefined && n.w && n.h);
  if (withPos.length === 0) return "";

  const allYs = withPos.map(n => n.y + n.h);
  const maxY = Math.max(...allYs);
  const minY = Math.min(...withPos.map(n => n.y));

  const topZoneCutoff    = minY + (maxY - minY) * 0.12;
  const bottomZoneCutoff = maxY - (maxY - minY) * 0.10;

  const top    = withPos.filter(n => (n.y + n.h) <= topZoneCutoff);
  const bottom = withPos.filter(n => n.y >= bottomZoneCutoff);
  const content = withPos.filter(n => n.y > topZoneCutoff && (n.y + n.h) < bottomZoneCutoff);

  return [
    `VISUAL ZONES:`,
    `  TOP ZONE    (y ≤ ${Math.round(topZoneCutoff)}): ${top.length} nodes — header / status bar / app bar`,
    `  CONTENT     (${Math.round(topZoneCutoff)} < y < ${Math.round(bottomZoneCutoff)}): ${content.length} nodes — main scrollable content`,
    `  BOTTOM ZONE (y ≥ ${Math.round(bottomZoneCutoff)}): ${bottom.length} nodes — bottom nav / tab bar / FAB`,
    `  NOTE: Focus order: TOP ZONE first → CONTENT → BOTTOM ZONE.`,
  ].join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { designData, checkType, fileName, pageName, ignoreChrome, dsContext } = await req.json();

    console.log(`analyze-a11y: checkType=${checkType}, nodes=${designData?.length || 0}, dsContext=${!!dsContext}`);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!designData || designData.length === 0) throw new Error("No design data provided. Please select a frame in Figma.");
    if (!["aria", "focus_order"].includes(checkType)) throw new Error(`Unknown checkType: ${checkType}`);

    const flatNodes = flattenDesignData(designData);
    console.log(`Flattened to ${flatNodes.length} nodes`);

    const spatialSummary  = buildSpatialSummary(flatNodes);
    const repeatingGroups = findRepeatingGroups(flatNodes);
    const visualZones     = buildVisualZones(flatNodes);

    // Build parent-context map (closest ancestor text content, closest first)
    const parentContextMap: Record<string, string[]> = {};
    function buildParentContext(nodes: any[], ancestors: string[] = []) {
      for (const n of nodes) {
        if (n.id) parentContextMap[n.id] = [...ancestors];
        const childAncestors = n.textContent
          ? [n.textContent, ...ancestors]
          : (n.allText ? [n.allText, ...ancestors] : ancestors);
        if (n.children) buildParentContext(n.children, childAncestors);
      }
    }
    buildParentContext(designData);

    // Enrich flat nodes with parent context
    const enrichedNodes = flatNodes.map(n => ({
      ...n,
      parentContext: (parentContextMap[n.id] || []).slice(0, 3),
    }));

    const designContext = JSON.stringify(enrichedNodes, null, 2);

    // ── Chrome ignore instruction ─────────────────────────────────────────────
    const ignoreChromeInstruction = ignoreChrome ? `
IGNORE CHROME / STRUCTURAL ELEMENTS:
- Do NOT annotate or include: status bars, app bars, top headers, bottom nav bars, tab bars, footers, navigation drawers, or any shell/chrome.
- Only process the content area — the unique, screen-specific elements the designer controls.
` : "";

    // ── Shared interactivity decision rules ───────────────────────────────────
    const interactivityRules = `
HOW TO DECIDE IF AN ELEMENT IS INTERACTIVE:
1. isComponent=true → almost always interactive
2. inRepeatingGroup=true → EVERY member is interactive (grids, lists, chips, date cells, tabs, thumbnails) — include ALL
3. FRAME/INSTANCE with cornerRadius > 0 AND solid fill AND leaf/near-leaf → likely button or tappable card
4. allText matches action words ("Pay Now", "View", "Apply", "Submit", "Confirm", "Proceed") → button
5. allText matches nav labels ("Home", "Bills", "Cards", "Profile", "Pay") → navigation item
6. isIconButton=true → icon button (label from context/parentContext)
7. Short label with count like "Bills (6)" → filter chip / tab
8. "⋮", "...", "more" inside a card → overflow menuitem
9. fontSize >= 20 → likely heading (announced by screen reader)
10. isLeaf=true inside a card with action siblings → listitem / interactive card row`;

    // ── DS context injection ──────────────────────────────────────────────────
    const dsPromptSection = dsContext ? `
═══ DESIGN SYSTEM CONTEXT ═══
This screen uses a Design System. Use this to produce better ARIA labels and focus annotations.

Known icon component names from DS: ${(dsContext.iconNames || []).slice(0, 60).join(', ')}
Known component names: ${(dsContext.componentNames || []).slice(0, 60).join(', ')}

RULES:
1. When you see a node whose layerName matches a known DS icon name (e.g. "Icons/Arrow/Left/24/Dark"), infer its semantic meaning from the name and use that as the ARIA label. E.g. "Icons/Arrow/Left/24/Dark" in a header → label: "Back".
2. When you see "Icons/Notification/Bell/24" → label: "Notifications".
3. Use the DS component name structure (e.g. "Button/Primary", "Card/Transaction") to better infer the role and purpose of unlabelled components.
4. Do NOT use the DS component name as the literal ARIA label — infer the semantic meaning from context + name combined.
` : '';

    if (checkType === "aria") {
      systemPrompt = `You are a senior accessibility engineer specialising in WCAG 2.1, ARIA 1.2, and mobile banking UX.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation, no preamble.
Start your response with [ and end with ].
Be deterministic: given the same input always produce the same output.

YOUR MOST CRITICAL RULES:
- \`layerName\` is a Figma internal layer identifier (e.g. "NEFT", "Frame 1437256002", "Group 5"). It is NEVER label content.
- \`allText\` = the actual visible text content aggregated from the element's entire subtree. THIS is what screen readers announce. USE IT.
- \`textContent\` = visible text of a single TEXT node. Also usable.
- ALWAYS build ariaLabel from allText or textContent. NEVER from layerName.
- Labels must be natural spoken English — exactly what a screen reader should announce.`;

      userPrompt = `Generate ARIA labels for every interactive or meaningful visual element in this Figma screen: "${pageName}" (file: "${fileName}").

${spatialSummary}

${repeatingGroups}
${ignoreChromeInstruction}
${dsPromptSection}

${interactivityRules}

ARIA LABEL CONSTRUCTION RULES:

1. SOURCE OF TRUTH — always in this priority order:
   a. \`allText\` — pre-aggregated visible text from the entire subtree (MOST RELIABLE — use by default)
   b. \`textContent\` — visible text of a single text node
   c. \`parentContext\` — ancestor text for enrichment
   d. \`layerName\` — NEVER use for label content. Treat as an internal ID.

2. LABEL FORMULA for interactive elements:
   [Most important data] + [Supporting data] + [Action hint]
   Examples:
   - Recipient card (allText: "Anmol Sharma · SBI Bank · Savings A/c: 9837...") →
     "Paying to Anmol Sharma, SBI Bank. Tap to change recipient."
   - Payment method (allText: "UPI · NO COST") →
     "Payment method: UPI, No cost. Tap to change."
   - Amount field (allText: "₹15,010 · Fifteen thousand ten rupees only") →
     "Amount: ₹15,010. Tap to edit."
   - Bank account row (allText: "HDFC Bank · Savings A/c: ****8374 · Balance: ₹24,367.34") →
     "Paying from HDFC Bank, account ending 8374, balance ₹24,367.34. Tap to change."
   - Notification toggle (allText: "Send Notification · Optional") →
     "Send notification. Optional. Currently off."
   - Checkbox (allText: "Cyber Insurance: ₹10 added") →
     "Cyber Insurance: ₹10 added. Unchecked."
   - Back icon (isIconButton=true, parentContext="Send Money screen header") →
     "Back"
   - Pay Now button with parentContext showing "Personal Loan EMI · ₹6,885 · OVERDUE" →
     "Pay Now — Personal Loan EMI, ₹6,885, OVERDUE"

3. PRIORITY ORDER within a label:
   Person name > Amount/value > Account/ID details > Institution name > Action hint
   Never lead with the bank name if a person's name or amount is also present.

4. SKIP these entirely (no label needed):
   - Background rectangles, dividers, shadow layers, spacers
   - Static section headers that are purely visual (e.g. "Payment Method", "Paying From") unless collapsible/interactive
   - Status bar chrome (time, signal, battery)
   - Decorative illustrations or image frames
   - Any TEXT node whose content is already fully captured in its parent's allText label

5. CONTEXT FIELD — one sentence, designer-friendly:
   Good: "Tappable card — allText 'Anmol Sharma · SBI Bank' used to surface recipient as primary label."
   Bad: "isComponent=true, cornerRadius>0, contains descriptive text, used as button."

FULL NODE DATA (allText and parentContext are pre-computed — use them directly):
${designContext}

Return a JSON array. Each item:
{
  "nodeId": "exact id",
  "nodeName": "layerName value",
  "textContent": "actual text if any",
  "allText": "aggregated subtree text if any",
  "role": "button | tab | navigation | listitem | gridcell | img | input | status | link | heading | menuitem | checkbox | radio | combobox",
  "ariaLabel": "Full descriptive label — built from allText or textContent, NEVER from layerName",
  "context": "One sentence explaining the labelling choice (designer-facing)"
}`;

    } else {
      // focus_order
      systemPrompt = `You are a senior accessibility engineer specialising in WCAG 2.1 focus management (SC 2.4.3) and screen reader UX.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation, no preamble.
Start your response with [ and end with ].

CRITICAL PHILOSOPHY: You are sequencing focus for a BLIND USER navigating with a screen reader (TalkBack / VoiceOver).
The Figma layer panel order is COMPLETELY IRRELEVANT — it reflects design creation order, not UX intent.
Determine order PURELY from visual/spatial data: x/y coordinates, element size, and UX patterns.

YOUR MOST CRITICAL RULES:
- \`layerName\` is NEVER a label. Use \`allText\` or \`textContent\` for ALL ariaLabel values.
- A focus stop's ariaLabel must match what a screen reader would announce — real content, not layer names.
- Good ariaLabel: "Pay Now — Personal Loan EMI, ₹6,885, OVERDUE"
- Bad ariaLabel: "Button 14", "Frame 456", "NEFT", "Payment Methods"`;

      userPrompt = `Define a COMPLETE, VISUALLY-DRIVEN keyboard focus order for the Figma screen: "${pageName}" (file: "${fileName}").

${visualZones}

${spatialSummary}

${repeatingGroups}

${interactivityRules}
${ignoreChromeInstruction}

═══ FOCUS ORDER SEQUENCING RULES ═══

RULE 1 — VISUAL POSITION IS THE ONLY ORDERING SIGNAL
  - Sequence ENTIRELY by coordinates: lower y → earlier focus. Equal y (within 8px) → lower x first.
  - NEVER follow Figma layer panel order. Layer order is irrelevant.

RULE 2 — SCREEN READER READING PATTERN (top-left → bottom-right, zone by zone)
  Zone 1: TOP ZONE — back/close button → screen title → trailing action icons (search, filter)
  Zone 2: CONTENT ZONE — process row by row:
    - Each row: leftmost interactive → rightmost interactive → overflow/more button
    - Card groups: card heading → supporting text → primary action → secondary action → more-options
    - Filter/chip rows: left chip → next chip → ... → last chip
    - Scrollable lists: top item → next item → ... (ALL items, NONE skipped)
  Zone 3: BOTTOM ZONE — leftmost tab → next tab → ... → rightmost tab
  Zone 4: Floating elements (FAB, modals, toasts) — sequenced by y position

RULE 3 — REPEATING GROUPS: ZERO EXCEPTIONS
  - Every inRepeatingGroup=true member MUST appear in the focus list.
  - Order: ascending y, then ascending x (left-to-right, row by row).
  - Calendar grids: ALL cells. A 7×5 grid = 35 entries minimum.
  - Chip rows / tab rows: ALL chips, left to right.
  - Card lists: ALL cards, top to bottom.

RULE 4 — COMPONENTS ARE ALWAYS INTERACTIVE
  - isComponent=true → include it.

RULE 5 — MERGE TIGHTLY COUPLED ELEMENTS UNDER THEIR PARENT
  - If "HDFC Bank", "Savings A/c: ****8374", and "Balance: ₹24,367.34" are inside ONE tappable card,
    they get ONE focus stop — not three. The ariaLabel combines them:
    "Paying from HDFC Bank, account ending 8374, balance ₹24,367.34. Tap to change."
  - Merge when: parent isComponent=true or has cornerRadius>0 and contains all the sub-texts.

RULE 6 — LABELS COME FROM CONTENT, NEVER FROM LAYER NAMES
  - ariaLabel MUST be derived from allText (preferred), textContent, or parentContext.
  - For merged cards: combine the allText snippets of child elements.
    E.g. allText: "HDFC Bank · ****8374 · ₹24,367.34" →
    ariaLabel: "Paying from HDFC Bank, account ending 8374, balance ₹24,367.34. Tap to change."

RULE 7 — WITHIN-CARD FOCUS ORDER (when card is NOT merged into one stop)
  1. Primary label / heading
  2. Supporting info text (if it adds meaningful context)
  3. Primary CTA button
  4. Secondary action
  5. Overflow / more-options button

RULE 8 — WHAT TO EXCLUDE FROM FOCUS ORDER
  EXCLUDE: static section labels (e.g. "Payment Method", "Paying From" as visual-only headings),
  dividers, background shapes, decorative icons already covered by parent label, status bar,
  any element where isLeaf=false AND isComponent=false AND no allText AND cornerRadius=0 AND no fills.
  INCLUDE: everything else a sighted user can tap/click.

RULE 9 — RATIONALE FORMAT (designer-friendly, one sentence max)
  Good: "Interactive card — user selects recipient. Content zone. y=120."
  Good: "Primary CTA button. Bottom of content zone. y=680."
  Bad: "isComponent=true, child layerName 'NEFT' indicates selected value in a tappable card."

FULL NODE DATA (use allText for labels, x/y for sequencing, parentContext for enrichment):
${designContext}

Return a JSON array sorted by focusIndex (1-based, no gaps). Each item:
{
  "nodeId": "exact node id from data",
  "nodeName": "layerName value",
  "textContent": "actual text content if present",
  "allText": "aggregated subtree text if present",
  "focusIndex": 1,
  "role": "button | tab | navigation | gridcell | input | link | listitem | menuitem | heading | checkbox | radio | combobox | img",
  "ariaLabel": "Built from allText or textContent — NEVER from layerName",
  "visualPosition": "y=N x=N",
  "rationale": "One short sentence — designer-friendly, no internal Figma metadata"
}`;
    }

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 48000,
        temperature: 0,
        seed: 42,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", errorText);
      if (aiResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "AI rate limit exceeded. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (aiResponse.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI usage limit reached. Please check your Lovable workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error(`AI analysis failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in AI response");

    // Strip markdown fences
    let clean = content.trim();
    if (clean.startsWith("```json")) clean = clean.slice(7);
    else if (clean.startsWith("```")) clean = clean.slice(3);
    if (clean.endsWith("```")) clean = clean.slice(0, -3);
    clean = clean.trim();

    // Safety net: repair truncated JSON arrays (hit max_tokens mid-response)
    if (!clean.endsWith("]")) {
      const lastBrace = clean.lastIndexOf("}");
      const lastComma = clean.lastIndexOf(",");
      if (lastBrace > lastComma) {
        // Last object is complete — close the array
        clean = clean.slice(0, lastBrace + 1) + "]";
      } else if (lastComma > 0) {
        // Drop the incomplete last item
        clean = clean.slice(0, lastComma) + "]";
      } else {
        clean = "[]";
      }
    }

    const results = JSON.parse(clean);
    if (!Array.isArray(results)) throw new Error("Response is not an array");

    console.log(`${checkType} analysis complete: ${results.length} items`);

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      await trackUsage(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, `a11y_${checkType}`, flatNodes.length, fileName || "unknown");
    }

    return new Response(
      JSON.stringify({ success: true, results, checkType }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in analyze-a11y:", error);
    const msg = error instanceof Error ? error.message : "Analysis failed";
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
