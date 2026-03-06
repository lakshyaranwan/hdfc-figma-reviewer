import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Flatten design data — prioritise text content over node names
function flattenDesignData(nodes: any[], maxDepth = 8): any[] {
  const flat: any[] = [];

  function traverse(node: any, path: string, depth: number) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    // Use actual text content for path labels when available
    const displayLabel = node.characters?.trim() || node.name || node.type || "unknown";
    const currentPath = path ? `${path} > ${displayLabel}` : displayLabel;

    const simplified: any = {
      id: node.id,
      // Provide both so AI can see discrepancy between layer name and actual content
      layerName: node.name,
      type: node.type,
      path: currentPath,
    };

    // TEXT CONTENT IS THE SOURCE OF TRUTH — always include it prominently
    if (node.characters) {
      simplified.textContent = node.characters.trim();
    }
    if (node.fontSize) simplified.fontSize = node.fontSize;

    // Spatial data — critical for reading order and inferring interactive elements
    if (node.x !== undefined) simplified.x = Math.round(node.x);
    if (node.y !== undefined) simplified.y = Math.round(node.y);
    if (node.width !== undefined) simplified.width = Math.round(node.width);
    if (node.height !== undefined) simplified.height = Math.round(node.height);

    if (node.layoutMode) simplified.layoutMode = node.layoutMode;

    // Corner radius helps identify interactive elements (rounded = likely tappable)
    if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
      simplified.cornerRadius = node.cornerRadius;
    }

    // Fill type hints (solid color vs image vs gradient)
    if (Array.isArray(node.fills) && node.fills.length > 0) {
      simplified.fillTypes = node.fills
        .filter((f: any) => f.visible !== false)
        .map((f: any) => f.type);
    }

    flat.push(simplified);

    const children = node.children || node.nodes;
    if (Array.isArray(children)) {
      for (const child of children) {
        traverse(child, currentPath, depth + 1);
      }
    }
  }

  for (const node of nodes) {
    traverse(node, "", 0);
  }

  return flat;
}

// Build a spatial summary to give the AI a high-level map of the screen layout
function buildSpatialSummary(nodes: any[]): string {
  const flat = flattenDesignData(nodes, 3); // shallow pass for layout overview
  
  // Group nodes into rough screen regions based on x position
  // Assume typical screen width ~375-1440px; split into left/right halves
  const withPos = flat.filter(n => n.x !== undefined && n.y !== undefined);
  if (withPos.length === 0) return "";

  const maxX = Math.max(...withPos.map(n => n.x + (n.width || 0)));
  const midX = maxX / 2;

  const leftRegion = withPos.filter(n => n.x < midX).slice(0, 20);
  const rightRegion = withPos.filter(n => n.x >= midX).slice(0, 20);

  const summarise = (group: any[]) =>
    group
      .map(n => `  [y=${n.y}, x=${n.x}, ${n.width}×${n.height}] ${n.textContent ? `"${n.textContent}"` : n.layerName} (${n.type})`)
      .join("\n");

  return `
SPATIAL LAYOUT OVERVIEW (left half | right half of screen):
LEFT REGION (x < ${Math.round(midX)}):
${summarise(leftRegion) || "  (empty)"}

RIGHT REGION (x >= ${Math.round(midX)}):
${summarise(rightRegion) || "  (empty)"}
`;
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

    const spatialSummary = buildSpatialSummary(designData);
    const designContext = JSON.stringify(flatNodes, null, 2);

    let systemPrompt = "";
    let userPrompt = "";

    if (checkType === "aria") {
      systemPrompt = `You are a senior accessibility engineer with deep expertise in WCAG 2.1, ARIA 1.2, and banking/fintech UI patterns.

CRITICAL RULES:
1. Always use the "textContent" field as the source of truth for what an element says. The "layerName" is a Figma layer name that is often wrong, generic, or auto-generated — NEVER use it as the basis for an ARIA label.
2. Use spatial position (x, y, width, height) to understand the visual layout and group related elements.
3. Infer element type from: corner radius (rounded = button/card), fontSize (large = heading), layoutMode, fill types, and textContent patterns.
4. NEVER skip calendar date cells — a grid of short numeric text nodes (1-31) inside a calendar-like parent is ALWAYS interactive.
5. You MUST respond with ONLY a valid JSON array — no markdown, no explanation. Start with [ and end with ].`;

      userPrompt = `Analyze this Figma screen: "${pageName}" from file "${fileName}".

${spatialSummary}

FULL NODE DATA (id, layerName, textContent, type, position, size):
${designContext}

YOUR TASK — generate descriptive ARIA labels for every interactive or meaningful visual element.

ELEMENT TYPES TO ALWAYS COVER (do not skip any):
1. Navigation bar items and tabs (use textContent for the label, not layer name)
2. Category filter chips/pills (e.g. "Money Transfer (2)", "Bills & Recharges (6)" — read the actual textContent)
3. CALENDAR WIDGET — this is critical:
   - The calendar grid (month/year header, prev/next month buttons, day-of-week headers, ALL date cells)
   - Each date cell showing a number (1-31) is a focusable button. Look for TEXT nodes with values 1-31 inside a grid-like structure.
   - Detect the month/year from nearby text (e.g. "October 2024") and construct "October 1, 2024" etc.
   - If a date has a dot indicator below it, label it as having events scheduled.
4. Buttons — use textContent ("Pay Now", "View Details") and include what entity/bill it belongs to by looking at sibling text nodes in the same card
5. Status badges — look for text like "PAID", "OVERDUE", "SCHEDULED", "SmartPay Set" and include parent entity context
6. Bill/event cards — the card itself as a listitem with a summary label
7. Overflow menus (⋮ three-dot buttons) — include which card they belong to
8. Amount text nodes within cards — these may need role="text" with full context
9. Promo/event banners and their CTAs

ARIA LABEL QUALITY RULES:
- Base ALL labels on textContent, never on layerName
- Add context from siblings: "Pay Now button for Personal Loan EMI — ₹6,885.00 — OVERDUE"
- For calendar: "October 4, 2024 — selected, Wednesday — 1 event" (infer from dot indicators)
- For filter chips: "Bills & Recharges filter — 6 items" (parse the number from textContent)
- For overflow menus: "More options for Mom's Phone Bill"
- Skip purely decorative dividers, background rectangles, shadow layers

Return JSON array, each item:
{
  "nodeId": "exact id from data",
  "nodeName": "the layerName value",
  "textContent": "actual text content if any",
  "role": "button | tab | navigation | listitem | img | input | status | link | heading | gridcell | menuitem",
  "ariaLabel": "Full descriptive ARIA label",
  "context": "Why this label + how you inferred it from textContent and position"
}`;

    } else {
      // focus_order
      systemPrompt = `You are a senior accessibility engineer specialising in keyboard navigation, focus management, and WCAG 2.1 success criteria 2.4.3 (Focus Order) for fintech/banking apps.

CRITICAL RULES:
1. Use "textContent" as the source of truth — not "layerName" which is a Figma internal name that may be wrong.
2. Use x/y coordinates to determine visual reading order. Lower y = higher on screen = earlier in focus order. For same y, lower x = earlier.
3. CALENDAR GRIDS ARE INTERACTIVE — every individual date cell in a calendar is a focusable element. Identify them by: numeric textContent (1-31), similar sizes, arranged in a 7-column grid pattern. Include ALL of them in sequence (left-to-right, row by row).
4. Think about the WHOLE screen layout spatially: what is on the LEFT side vs RIGHT side, what is at the TOP vs BOTTOM. Both sides of a two-column layout need coverage.
5. You MUST respond with ONLY a valid JSON array — no markdown, no explanation. Start with [ and end with ].`;

      userPrompt = `Analyze this Figma screen: "${pageName}" from file "${fileName}" and define a complete keyboard focus order.

${spatialSummary}

FULL NODE DATA (id, layerName, textContent, type, x, y, width, height):
${designContext}

SPATIAL READING ORDER RULES:
- Read the screen top-to-bottom, left-to-right
- For two-column layouts: header spans full width → left column content → right column content (OR interleaved if columns share the same y-range)
- The focus order should follow the DOM/visual flow a sighted user would naturally follow

REQUIRED FOCUS SEQUENCE for a typical HDFC Calendar 360 screen:
1. App/page header elements (back button, page title, header action buttons)
2. Date navigation row (previous month button → current month/date label → next month button → today label)
3. View toggle buttons (grid/list view switcher)
4. Category filter chips — ALL of them left to right (Money Transfer, Bills & Recharges, Cards, Loans, Investments, Offers, Notifications, Others...)
5. ← LEFT COLUMN: CALENDAR WIDGET (this is on the left side, do not skip it!)
   - Previous month arrow
   - Month/year heading (if interactive)
   - Next month arrow
   - Day-of-week column headers (SUN, MON, TUE, WED, THU, FRI, SAT) — these are usually not focusable, skip
   - ALL date cells row by row: row 1 (1,2,3,4,5,6,7) → row 2 (8,9,10...) → etc.
   - "Events" section heading
   - Event cards in the calendar panel and their CTAs
6. → RIGHT COLUMN: Bill/event cards (top-to-bottom)
   - Each card: card focus itself → action button (View Details / Pay Now) → overflow menu (⋮)
7. Add Event button (if present, usually top-right corner — include it in the header section)

LABEL RULES: Use textContent to build the label. E.g. a date cell with textContent "4" and a dot indicator → "October 4, 2024 — has events".

For each interactive element return:
{
  "nodeId": "exact id from data",
  "nodeName": "layerName value",
  "textContent": "actual text if any",
  "focusIndex": 1,
  "role": "button | tab | link | input | gridcell | menuitem | listitem | navigation",
  "ariaLabel": "Descriptive label based on textContent + context",
  "rationale": "Why this position — reference x/y coordinates and visual region"
}

focusIndex starts at 1 and increments sequentially. Return ALL interactive elements sorted by focusIndex. Do NOT skip the calendar.`;
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

    let cleanContent = content.trim();
    if (cleanContent.startsWith("```json")) cleanContent = cleanContent.slice(7);
    else if (cleanContent.startsWith("```")) cleanContent = cleanContent.slice(3);
    if (cleanContent.endsWith("```")) cleanContent = cleanContent.slice(0, -3);
    cleanContent = cleanContent.trim();

    const results = JSON.parse(cleanContent);
    if (!Array.isArray(results)) throw new Error("Response is not an array");

    console.log(`${checkType} analysis complete: ${results.length} items`);

    return new Response(
      JSON.stringify({ success: true, results, checkType }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in analyze-a11y:", error);
    const errorMessage = error instanceof Error ? error.message : "Analysis failed";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
