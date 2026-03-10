import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Track usage in plugin_usage table
async function trackUsage(supabaseUrl: string, serviceRoleKey: string, action: string, nodCount: number, fileName: string) {
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
        node_count: nodCount,
        category_count: 1,
      }),
    });
  } catch (e) {
    console.error("Failed to track usage:", e);
  }
}

// Flatten design tree into a flat list, carrying structural interactivity signals
function flattenDesignData(nodes: any[], maxDepth = 8): any[] {
  const flat: any[] = [];

  // Recursively collect all text strings from descendants (breadth-limited to 3 levels)
  function collectDescendantTexts(node: any, maxLevels = 3): string[] {
    const texts: string[] = [];
    function gather(n: any, level: number) {
      if (!n || level > maxLevels) return;
      if (n.visible === false || n.opacity === 0) return;
      if (n.characters) texts.push(n.characters.trim());
      const kids = n.children || n.nodes;
      if (Array.isArray(kids)) kids.forEach(k => gather(k, level + 1));
    }
    const kids = node.children || node.nodes;
    if (Array.isArray(kids)) kids.forEach(k => gather(k, 1));
    return texts.filter(Boolean);
  }

  function traverse(node: any, path: string, depth: number) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    // Use actual text content as the label in the path, not the layer name
    const displayLabel = node.characters?.trim() || node.name || node.type || "?";
    const currentPath = path ? `${path} > ${displayLabel}` : displayLabel;

    const n: any = {
      id: node.id,
      layerName: node.name,   // Figma layer name — may be wrong/generic, treat as a LAST RESORT only
      type: node.type,
      path: currentPath,
    };

    // TEXT CONTENT — primary source of truth for what the element says
    if (node.characters) n.textContent = node.characters.trim();
    if (node.fontSize)   n.fontSize = node.fontSize;

    // CHILD TEXTS — aggregate visible text from descendants for container nodes.
    // This is critical: if a component is named "NEFT" in the layer panel but its
    // visible child text says "UPI", childTexts will contain ["UPI", "NO COST"] etc.
    // Always prefer childTexts over layerName when building ariaLabel.
    if (!node.characters) {
      const childTexts = collectDescendantTexts(node, 3);
      if (childTexts.length > 0) n.childTexts = childTexts;
    }

    // Spatial data — used for reading order and grouping inference
    if (node.x !== undefined) n.x = Math.round(node.x);
    if (node.y !== undefined) n.y = Math.round(node.y);
    if (node.width  !== undefined) n.w = Math.round(node.width);
    if (node.height !== undefined) n.h = Math.round(node.height);

    if (node.layoutMode) n.layoutMode = node.layoutMode;

    // Visual signals that hint at interactivity
    if (node.cornerRadius !== undefined && node.cornerRadius > 0) n.cornerRadius = node.cornerRadius;
    if (Array.isArray(node.fills) && node.fills.length > 0) {
      n.fillTypes = node.fills.filter((f: any) => f.visible !== false).map((f: any) => f.type);
    }

    // Structural interactivity signals (set by the Figma plugin pre-pass)
    if (node._isComponent)         n.isComponent = true;       // Figma component/instance
    if (node._inRepeatingGroup)    n.inRepeatingGroup = true;  // Part of a grid/list pattern
    if (node._repeatingSiblingCount) n.repeatingSiblingCount = node._repeatingSiblingCount;
    if (node._isLeaf)              n.isLeaf = true;            // No children / only text children

    flat.push(n);

    const children = node.children || node.nodes;
    if (Array.isArray(children)) {
      for (const child of children) traverse(child, currentPath, depth + 1);
    }
  }

  for (const node of nodes) traverse(node, "", 0);
  return flat;
}

// Pre-compute a spatial overview so the AI understands the screen layout
// Returns ALL interactive candidates sorted by visual position (y then x)
function buildSpatialSummary(flatNodes: any[]): string {
  const withPos = flatNodes.filter(n => n.x !== undefined && n.y !== undefined);
  if (withPos.length === 0) return "";

  // Sort top-to-bottom, left-to-right — this is the canonical visual reading order
  const sorted = withPos
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, 80);

  const lines = sorted.map(n => {
    const label = n.textContent ? `"${n.textContent}"` : `[${n.type}]`;
    const flags = [
      n.isComponent ? "COMPONENT" : "",
      n.inRepeatingGroup ? `REPEATING×${n.repeatingSiblingCount}` : "",
      n.isLeaf ? "LEAF" : "",
      n.cornerRadius ? `r=${n.cornerRadius}` : "",
    ].filter(Boolean).join(" ");
    return `  [y=${n.y} x=${n.x} ${n.w}×${n.h}] ${label} type=${n.type}${flags ? " " + flags : ""}`;
  });
  return `FULL SPATIAL MAP — sorted by visual position (TOP→BOTTOM, LEFT→RIGHT). Use this as the ground truth for focus sequencing:\n${lines.join("\n")}`;
}

// Identify "repeating groups" — grids/lists of similar-sized nodes that are all likely interactive
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
    // Sort members spatially so we can show them in visual order
    const sortedMembers = [...members].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const sample = sortedMembers.slice(0, 6).map(m => m.textContent ? `"${m.textContent}"` : m.layerName).join(", ");
    summaries.push(`  - ${members.length} elements of size ${size} (visual order: ${sample}...)`);
  }

  if (summaries.length === 0) return "";
  return `DETECTED REPEATING INTERACTIVE GROUPS (grids, lists, chip rows — every member MUST be in focus order, sequenced by y then x):\n${summaries.join("\n")}`;
}

// Build visual zone boundaries to help AI understand screen structure
function buildVisualZones(flatNodes: any[]): string {
  const withPos = flatNodes.filter(n => n.x !== undefined && n.y !== undefined && n.w && n.h);
  if (withPos.length === 0) return "";

  const allYs = withPos.map(n => n.y + n.h);
  const maxY = Math.max(...allYs);
  const minY = Math.min(...withPos.map(n => n.y));

  // Heuristic zone detection based on vertical position
  const topZoneCutoff   = minY + (maxY - minY) * 0.12;  // top 12% = header/status bar
  const bottomZoneCutoff = maxY - (maxY - minY) * 0.10;  // bottom 10% = nav bar/tab bar

  const topZoneNodes    = withPos.filter(n => (n.y + n.h) <= topZoneCutoff);
  const bottomZoneNodes = withPos.filter(n => n.y >= bottomZoneCutoff);
  const contentNodes    = withPos.filter(n => n.y > topZoneCutoff && (n.y + n.h) < bottomZoneCutoff);

  const lines: string[] = [];
  lines.push(`VISUAL ZONES (used to determine focus order sections):`);
  lines.push(`  TOP ZONE    (y ≤ ${Math.round(topZoneCutoff)}): ${topZoneNodes.length} nodes — typically header / status bar / app bar`);
  lines.push(`  CONTENT     (${Math.round(topZoneCutoff)} < y < ${Math.round(bottomZoneCutoff)}): ${contentNodes.length} nodes — main scrollable content`);
  lines.push(`  BOTTOM ZONE (y ≥ ${Math.round(bottomZoneCutoff)}): ${bottomZoneNodes.length} nodes — typically bottom nav / tab bar / FAB`);
  lines.push(`  NOTE: Process focus TOP→BOTTOM across zones. Within a zone, process LEFT→RIGHT.`);

  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { designData, checkType, fileName, pageName, ignoreChrome } = await req.json();

    console.log(`analyze-a11y: checkType=${checkType}, nodes=${designData?.length || 0}`);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    if (!designData || designData.length === 0) {
      throw new Error("No design data provided. Please select a frame in Figma.");
    }
    if (!["aria", "focus_order"].includes(checkType)) {
      throw new Error(`Unknown checkType: ${checkType}`);
    }

    const flatNodes = flattenDesignData(designData);
    console.log(`Flattened to ${flatNodes.length} nodes`);

    const spatialSummary  = buildSpatialSummary(flatNodes);
    const repeatingGroups = findRepeatingGroups(flatNodes);
    const visualZones     = buildVisualZones(flatNodes);

    // ── Build parent-context map so the AI knows what surrounds each node ───
    // Map nodeId → list of ancestor textContents (closest first)
    const parentContextMap: Record<string, string[]> = {};
    function buildParentContext(nodes: any[], ancestors: string[] = []) {
      for (const n of nodes) {
        if (n.id) parentContextMap[n.id] = [...ancestors];
        const childAncestors = n.textContent
          ? [n.textContent, ...ancestors]
          : ancestors;
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

    // ── Shared interactivity decision rules ─────────────────────────────────
    const interactivityRules = `
HOW TO DECIDE IF AN ELEMENT IS INTERACTIVE (apply universally):
1. isComponent=true → almost always interactive (reusable UI component)
2. inRepeatingGroup=true → EVERY member is interactive (grids, lists, chip rows, date cells, tabs, nav items, thumbnails, etc.) — include ALL of them without exception
3. type=FRAME/INSTANCE with cornerRadius > 0 AND a solid fill AND leaf/near-leaf → likely a button or tappable card
4. textContent is a 1–2 digit number AND siblings share the same size in a 7-col or grid layout → date-picker cells — ALL are gridcells
5. textContent matches action words ("Pay Now", "View", "Apply", "Add", "Submit", "Explore", "Confirm") → button
6. textContent matches nav labels ("Home", "Bills", "Cards", "Profile", "Pay", "Offers") → navigation item
7. Small square/circle element (no text, solid fill) adjacent to interactive content → icon button
8. Short label with count like "Bills (6)" or "Offers(5)" → filter chip / tab
9. "⋮", "...", "more" inside a card → overflow menuitem
10. fontSize >= 20px describing a section → heading
11. isLeaf=true inside a card alongside action siblings → listitem / interactive card row
12. parentContext contains card-level info (amount, name, status) → use it to enrich the ariaLabel

CRITICAL: Do NOT use layerName as a decision signal. Layer names in Figma are often "Frame 1234" or "Group 5". Always use: textContent, position (x/y), size (w/h), isComponent, inRepeatingGroup, cornerRadius, fillTypes, parentContext.`;

    let systemPrompt = "";
    let userPrompt   = "";

    // Shared chrome-ignore instruction
    const ignoreChromeInstruction = ignoreChrome ? `
IGNORE CHROME / STRUCTURAL ELEMENTS:
- Do NOT annotate or include in results: status bars, app bars, top headers, bottom nav bars, tab bars, footers, navigation drawers, or any other shell/chrome element that wraps the main content.
- Only process the content area — the unique, screen-specific elements the designer controls.
` : "";

    if (checkType === "aria") {
      systemPrompt = `You are a senior accessibility engineer specialising in WCAG 2.1, ARIA 1.2, and mobile/web UI.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation, no preamble.
Start your response with [ and end with ].
Be deterministic: given the same input always produce the same output.`;

      userPrompt = `Generate ARIA labels for every interactive or meaningful visual element in this Figma screen: "${pageName}" (file: "${fileName}").

${spatialSummary}

${repeatingGroups}
${ignoreChromeInstruction}

${interactivityRules}

ARIA LABEL — TEXT SOURCE PRIORITY (follow strictly in this order):
1. Use `textContent` if the node itself has text. This is always correct.
2. If no `textContent`, use `childTexts` array — these are the ACTUAL visible strings rendered inside the component. This is the most important fix: a component named "NEFT" in the layer panel whose childTexts=["UPI","NO COST"] MUST be labelled "UPI — NO COST", NOT "NEFT". The layer name is a developer artefact, not visible to users.
3. If neither, use `parentContext` to infer what the element represents.
4. ONLY as a last resort with no other signals may you reference `layerName` — and even then, prefer describing the element's role/action over its layer name.

⚠️ CRITICAL EXAMPLE — Layer name vs visible text:
  BAD:  layerName="NEFT", childTexts=["UPI","NO COST"] → ariaLabel: "NEFT. Tap to select."  ← WRONG
  GOOD: layerName="NEFT", childTexts=["UPI","NO COST"] → ariaLabel: "UPI — No Cost. Tap to change payment method."  ← CORRECT

ARIA LABEL CONTENT PRIORITY (what information to include, in order of importance):
1. Person name / primary entity (e.g. "Anmol Sharma") — ALWAYS comes first if present in childTexts or parentContext
2. Key descriptor (e.g. account number, bank name, amount) — second
3. Action affordance (e.g. "Tap to change recipient", "Tap to view details") — last

⚠️ CRITICAL EXAMPLE — Person vs bank:
  BAD:  "Paying to State Bank of India. Tap to change recipient."  ← drops the person's name entirely
  GOOD: "Paying to Anmol Sharma — SBI Bank — Savings A/c: 9837...8252. Tap to change recipient."  ← person first

MORE GOOD LABEL EXAMPLES:
- "Pay Now button for Personal Loan EMI — ₹6,885.00 — OVERDUE"
- "Mom's Phone Bill — Mobile Postpaid — ₹885.00 — PAID — View Details button"
- "More options for Infinia Credit Card"
- "Bills & Recharges filter — 6 items"
- "October 4, 2024 — Wednesday"
- For status badges: include the entity they annotate: "OVERDUE status for Personal Loan EMI"
- For icons with no text: describe action from context ("Back", "Notifications — 2 unread", "Search")
- Skip purely decorative nodes: dividers, background rectangles, shadow layers, illustration frames with no meaning
- Be consistent: same element type always gets the same label pattern

FULL NODE DATA (includes parentContext for each node):
${designContext}

Return a JSON array. Each item:
{
  "nodeId": "exact id",
  "nodeName": "layerName value",
  "textContent": "actual text if any",
  "role": "button | tab | navigation | listitem | gridcell | img | input | status | link | heading | menuitem | checkbox | radio | combobox",
  "ariaLabel": "Full descriptive label",
  "context": "How you inferred this (signals used)"
}`;

    } else {
      // focus_order — visually driven, not layer-order driven
      systemPrompt = `You are a senior accessibility engineer specialising in WCAG 2.1 focus management (SC 2.4.3) and screen reader UX.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation, no preamble.
Start your response with [ and end with ].

CRITICAL PHILOSOPHY: You are sequencing focus for a BLIND USER navigating with a screen reader (e.g. TalkBack, VoiceOver). 
The Figma layer panel order is COMPLETELY IRRELEVANT — it often reflects design creation order, not UX intent.
You MUST determine order purely from visual/spatial data: x/y coordinates, element size, and UX patterns.
Think: "If I were visually impaired and tabbing through this screen, what is the most logical, intuitive order?"`;

      userPrompt = `Define a COMPLETE, VISUALLY-DRIVEN keyboard focus order for the Figma screen: "${pageName}" (file: "${fileName}").

${visualZones}

${spatialSummary}

${repeatingGroups}

${interactivityRules}
${ignoreChromeInstruction}

═══ FOCUS ORDER SEQUENCING RULES ═══

RULE 1 — VISUAL POSITION IS THE ONLY ORDERING SIGNAL
  - Sequence ENTIRELY by coordinates: lower y → gets earlier focus. Equal y (within 8px) → lower x gets earlier focus.
  - NEVER follow Figma layer panel order. Layer order is irrelevant.
  - NEVER skip an element because it appears "structural" in the layer panel.

RULE 2 — SCREEN READER READING PATTERN (top-left → bottom-right, zone by zone)
  Zone 1: TOP ZONE (header area) — back/close button → screen title → trailing action icons (e.g. search, filter)
  Zone 2: CONTENT ZONE (main body) — process row by row:
    - Each row: leftmost interactive → rightmost interactive → overflow/more button
    - Card groups: card heading → supporting text → primary action → secondary action → more-options
    - Filter/chip rows: left chip → next chip → ... → last chip
    - Scrollable lists: top item → second item → ... (all items, none skipped)
  Zone 3: BOTTOM ZONE (tab bar / nav) — leftmost tab → next tab → ... → rightmost tab
  Zone 4: Floating elements (FAB, modals, toasts) — sequenced by y position within viewport

RULE 3 — REPEATING GROUPS: ZERO EXCEPTIONS
  - If inRepeatingGroup=true, EVERY SINGLE member MUST appear in the focus list.
  - Order within the group: ascending y, then ascending x (left-to-right row by row).
  - Calendar grids: ALL cells sequenced row-by-row. A 7-column × 5-row grid = 35 entries minimum.
  - Chip rows / tab rows: left-to-right, ALL chips.
  - Card lists: top card to bottom card, ALL cards.

RULE 4 — COMPONENTS ARE ALWAYS INTERACTIVE
  - isComponent=true → include it. Components represent real UI controls (buttons, cards, list items, inputs).

RULE 5 — DECORATIVE EXCLUSIONS (the ONLY valid reasons to skip a node)
  - Pure background rectangles with no text and no interactivity signals
  - Divider lines / separators
  - Shadow/blur effect layers
  - Illustration/image frames that are purely visual with no action

RULE 6 — ARIA LABELS FROM CONTENT, NOT LAYER NAMES
  - ariaLabel MUST be derived from textContent + parentContext
  - Examples of good labels: "Pay Now, ₹6,885, Personal Loan EMI, OVERDUE"
  - Examples of bad labels: "Button 14", "Frame 456", "Group 3"

RULE 7 — WITHIN-CARD FOCUS ORDER
  When a card contains multiple interactive elements, the within-card order is:
  1. Card's primary label / heading (heading role, not interactive but announced)
  2. Supporting info text (if it adds meaningful context)
  3. Primary CTA button (e.g. "Pay Now", "View Details")
  4. Secondary action (e.g. "Set Reminder")
  5. Overflow / more-options button ("⋮")

FULL NODE DATA (use x/y coordinates for sequencing, parentContext for labels):
${designContext}

Return a JSON array sorted by focusIndex (1-based, no gaps). Each item MUST include:
{
  "nodeId": "exact node id from data",
  "nodeName": "layerName value",
  "textContent": "actual text content if present",
  "focusIndex": 1,
  "role": "button | tab | navigation | gridcell | input | link | listitem | menuitem | heading | checkbox | radio | combobox | img",
  "ariaLabel": "Full descriptive label using textContent and parentContext — NEVER use layer names",
  "visualPosition": "y=N x=N — cite the actual coordinates",
  "rationale": "Why included and where in visual flow (cite zone, y/x coords, isComponent or inRepeatingGroup flag)"
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
        max_tokens: 40000,
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

    let clean = content.trim();
    if (clean.startsWith("```json")) clean = clean.slice(7);
    else if (clean.startsWith("```")) clean = clean.slice(3);
    if (clean.endsWith("```")) clean = clean.slice(0, -3);
    clean = clean.trim();

    const results = JSON.parse(clean);
    if (!Array.isArray(results)) throw new Error("Response is not an array");

    console.log(`${checkType} analysis complete: ${results.length} items`);

    // Track usage for AI a11y checks
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
