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

  function traverse(node: any, path: string, depth: number) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    // Use actual text content as the label in the path, not the layer name
    const displayLabel = node.characters?.trim() || node.name || node.type || "?";
    const currentPath = path ? `${path} > ${displayLabel}` : displayLabel;

    const n: any = {
      id: node.id,
      layerName: node.name,   // Figma layer name — may be wrong/generic, treat as a hint only
      type: node.type,
      path: currentPath,
    };

    // TEXT CONTENT — source of truth for what the element actually says
    if (node.characters) n.textContent = node.characters.trim();
    if (node.fontSize)   n.fontSize = node.fontSize;

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
Start your response with [ and end with ].`;

      userPrompt = `Generate ARIA labels for every interactive or meaningful visual element in this Figma screen: "${pageName}" (file: "${fileName}").

${spatialSummary}

${repeatingGroups}
${ignoreChromeInstruction}

${interactivityRules}

ARIA LABEL QUALITY RULES:
- Use textContent as the label base — never the layerName
- Use parentContext to enrich labels with card-level context:
    "Pay Now button for Personal Loan EMI — ₹6,885.00 — OVERDUE"
    "Mom's Phone Bill — Mobile Postpaid — ₹885.00 — PAID — View Details button"
    "More options for Infinia Credit Card"
    "Bills & Recharges filter — 6 items"
    "October 4, 2024 — Wednesday"
- For status badges: include the entity they annotate: "OVERDUE status for Personal Loan EMI"
- For icons with no text: describe action from context ("Back", "Notifications — 2 unread", "Search")
- Skip purely decorative nodes: dividers, background rectangles, shadow layers, illustration frames with no meaning

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
      // focus_order
      systemPrompt = `You are a senior accessibility engineer specialising in WCAG 2.1 focus management (SC 2.4.3) and keyboard navigation.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation, no preamble.
Start your response with [ and end with ].`;

      userPrompt = `Define a COMPLETE keyboard focus order for the Figma screen: "${pageName}" (file: "${fileName}").

${spatialSummary}

${repeatingGroups}

${interactivityRules}
${ignoreChromeInstruction}
FOCUS ORDER RULES:
1. Use x/y coordinates to sequence: lower y first; equal y → lower x first.
2. inRepeatingGroup=true: EVERY member MUST appear — no skipping. Include left-to-right, top-to-bottom within the group.
3. isComponent=true nodes must be evaluated individually — most are interactive.
4. Canonical reading flow:
   a. Status bar / notifications area (if present, top)
   b. Header / app bar (back button → title → trailing icons)
   c. Search / filter bar
   d. Primary section headings (role=heading, not focusable but useful as landmarks)
   e. Main content area — process each row/card in y-order:
      • Card/row container → primary CTA → secondary CTA → overflow "⋮"
   f. Floating action buttons (FAB), modals, drawers (if visible)
   g. Bottom navigation bar
5. Date/calendar grids: sequence cells row by row, left-to-right. A 5×7 grid → 35 entries.
6. Tab bars / chip rows: sequence left-to-right.
7. DO NOT skip items because they "seem structural" — if a node has isComponent or inRepeatingGroup, include it.
8. DO NOT include nodes that are purely layout containers, background fills, dividers, or decorative shapes with no text or interactivity signal.

FULL NODE DATA (includes parentContext for contextual labels):
${designContext}

Return a JSON array sorted by focusIndex (1-based). Each item:
{
  "nodeId": "exact id",
  "nodeName": "layerName value",
  "textContent": "actual text if any",
  "focusIndex": 1,
  "role": "button | tab | navigation | gridcell | input | link | listitem | menuitem | heading | checkbox | radio | combobox",
  "ariaLabel": "Descriptive label using textContent + parentContext",
  "rationale": "Brief reason: cite x/y coords, isComponent, inRepeatingGroup, or parent card info"
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
        max_tokens: 32000,
        temperature: 0,
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
