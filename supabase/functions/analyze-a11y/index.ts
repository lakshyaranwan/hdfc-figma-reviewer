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
function buildSpatialSummary(flatNodes: any[]): string {
  const withPos = flatNodes.filter(n => n.x !== undefined && n.y !== undefined && n.textContent);
  if (withPos.length === 0) return "";

  // Sort top-to-bottom, left-to-right, take the first 40 meaningful text nodes
  const sorted = withPos
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, 40);

  const lines = sorted.map(n =>
    `  [y=${n.y} x=${n.x} ${n.w}×${n.h}] "${n.textContent}" (${n.type}${n.isComponent ? " COMPONENT" : ""}${n.inRepeatingGroup ? ` REPEATING×${n.repeatingSiblingCount}` : ""})`
  );
  return `SPATIAL CONTENT MAP (top-to-bottom reading order, text nodes only):\n${lines.join("\n")}`;
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
    const sample = members.slice(0, 5).map(m => m.textContent ? `"${m.textContent}"` : m.layerName).join(", ");
    summaries.push(`  - ${members.length} elements of size ${size} (e.g. ${sample}...)`);
  }

  if (summaries.length === 0) return "";
  return `DETECTED REPEATING INTERACTIVE GROUPS (grids, lists, chip rows — every member is likely focusable):\n${summaries.join("\n")}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { designData, checkType, fileName, pageName } = await req.json();

    console.log(`analyze-a11y: checkType=${checkType}, nodes=${designData?.length || 0}`);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    if (!designData || designData.length === 0) {
      throw new Error("No design data provided. Please select a frame in Figma.");
    }
    if (!["aria", "focus_order"].includes(checkType)) {
      throw new Error(`Unknown checkType: ${checkType}`);
    }

    const flatNodes = flattenDesignData(designData);
    console.log(`Flattened to ${flatNodes.length} nodes`);

    const spatialSummary   = buildSpatialSummary(flatNodes);
    const repeatingGroups  = findRepeatingGroups(flatNodes);
    const designContext    = JSON.stringify(flatNodes, null, 2);

    // ── Shared interactivity decision rules ─────────────────────────────────
    const interactivityRules = `
HOW TO DECIDE IF AN ELEMENT IS INTERACTIVE (apply universally, not just to known patterns):
1. isComponent=true → almost always interactive (it is a reusable UI component in Figma)
2. inRepeatingGroup=true → every member of the group is interactive (this is a grid/list/chip row — date cells, filter chips, nav tabs, menu items, list rows, thumbnails, etc.)
3. type=FRAME/INSTANCE with cornerRadius > 0 AND a solid fill AND it is a leaf or near-leaf → likely a button or card
4. textContent looks like a number 1–31 AND siblings share the same size AND they are arranged in a 7-column or grid layout → date picker cells, ALL are interactive gridcells
5. textContent matches action words (e.g. "Pay Now", "View Details", "Explore", "Add", "Submit", "Apply") → button
6. textContent matches navigation labels (e.g. "Home", "Bills", "Cards", "Profile") → navigation item
7. Small square/circle element with no text but with a solid fill next to interactive content → icon button
8. textContent matches a short label with a count like "Bills (6)" or "Offers(5)" → filter chip / tab
9. Three-dot / "⋮" / "..." text or icon inside a card → overflow menu button
10. Elements with very large fontSize (>= 24px) that describe a section → heading (role="heading")
11. isLeaf=true inside a card that has action siblings → listitem

IMPORTANT: Do NOT base decisions on layerName. It is a Figma internal name that is frequently wrong (e.g. "Frame 1234", "Group 5", "Rectangle"). Base all decisions on textContent, position, size, isComponent, inRepeatingGroup, cornerRadius, and fillTypes.`;

    let systemPrompt = "";
    let userPrompt   = "";

    if (checkType === "aria") {
      systemPrompt = `You are a senior accessibility engineer specialising in WCAG 2.1, ARIA 1.2, and mobile/web UI.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation, no preamble.
Start your response with [ and end with ].`;

      userPrompt = `Generate ARIA labels for every interactive or meaningful visual element in this Figma screen: "${pageName}" (file: "${fileName}").

${spatialSummary}

${repeatingGroups}

${interactivityRules}

ARIA LABEL QUALITY RULES:
- Use textContent as the label base — never the layerName
- Add context from sibling/parent nodes to make the label fully self-contained for a screen reader:
    "Pay Now button for Personal Loan EMI — ₹6,885.00 — OVERDUE"
    "Mom's Phone Bill — Mobile Postpaid — ₹885.00 — PAID — View Details button"
    "More options for Infinia Credit Card"
    "Bills & Recharges filter — 6 items"
    "October 4, 2024 — Wednesday — 1 event scheduled"
- For status badges: include the entity they annotate: "OVERDUE status for Personal Loan EMI"
- For icons with no text: describe the action from context ("Back", "Notifications — 2 unread", "Search")
- Skip purely decorative nodes: dividers, background rectangles, shadow layers, illustration frames

FULL NODE DATA:
${designContext}

Return a JSON array. Each item:
{
  "nodeId": "exact id",
  "nodeName": "layerName value",
  "textContent": "actual text if any",
  "role": "button | tab | navigation | listitem | gridcell | img | input | status | link | heading | menuitem | checkbox | radio | combobox",
  "ariaLabel": "Full descriptive label",
  "context": "How you inferred this (signals used: textContent, isComponent, inRepeatingGroup, position, siblings)"
}`;

    } else {
      // focus_order
      systemPrompt = `You are a senior accessibility engineer specialising in WCAG 2.1 focus management (SC 2.4.3) and keyboard navigation.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation, no preamble.
Start your response with [ and end with ].`;

      userPrompt = `Define a complete, logical keyboard focus order for this Figma screen: "${pageName}" (file: "${fileName}").

${spatialSummary}

${repeatingGroups}

${interactivityRules}

FOCUS ORDER CONSTRUCTION RULES:
1. Use x/y coordinates to determine reading order: lower y = earlier; same y → lower x = earlier
2. Every member of a repeating group (inRepeatingGroup=true) MUST be included — they are all interactive. Include them in spatial order (left-to-right, top-to-bottom within the group).
3. Every isComponent=true node should be evaluated — most are interactive.
4. Reading flow: header / top bar → global navigation → search → secondary controls → content area (left-to-right across columns, then top-to-bottom within each column) → bottom navigation / FAB
5. Within a card/list item: the item itself → primary action → secondary action → overflow menu
6. Skip non-interactive structural nodes: background frames, separators, decorative shapes, containers that only exist for layout

IMPORTANT: Do not hardcode assumptions about which patterns exist on this specific screen. Derive everything from the node data, the spatial map, and the interactivity rules above.

FULL NODE DATA:
${designContext}

Return a JSON array sorted by focusIndex. Each item:
{
  "nodeId": "exact id",
  "nodeName": "layerName value",
  "textContent": "actual text if any",
  "focusIndex": 1,
  "role": "button | tab | navigation | gridcell | input | link | listitem | menuitem | heading | checkbox | radio | combobox",
  "ariaLabel": "Descriptive label based on textContent + context",
  "rationale": "Why this focus position — cite x/y, isComponent, inRepeatingGroup, or sibling context"
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
