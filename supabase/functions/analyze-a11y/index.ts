import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Flatten deeply nested design data into a flat array of simplified nodes (visible only)
function flattenDesignData(nodes: any[], maxDepth = 8): any[] {
  const flat: any[] = [];

  function traverse(node: any, path: string, depth: number) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    const currentPath = path
      ? `${path} > ${node.name || node.type || "unknown"}`
      : node.name || node.type || "unknown";

    const simplified: any = {
      id: node.id,
      name: node.name,
      type: node.type,
      path: currentPath,
    };

    if (node.characters) simplified.text = node.characters;
    if (node.fontSize) simplified.fontSize = node.fontSize;
    if (node.x !== undefined) simplified.x = node.x;
    if (node.y !== undefined) simplified.y = node.y;
    if (node.width !== undefined) simplified.width = node.width;
    if (node.height !== undefined) simplified.height = node.height;
    if (node.layoutMode) simplified.layoutMode = node.layoutMode;

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

    const designContext = JSON.stringify(flatNodes, null, 2);

    let systemPrompt = "";
    let userPrompt = "";

    if (checkType === "aria") {
      systemPrompt = `You are an expert accessibility engineer specializing in WCAG 2.1 and ARIA best practices for mobile and web banking applications.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation.
Start your response with [ and end with ].`;

      userPrompt = `Analyze this Figma design from a screen called "${pageName}" in "${fileName}" and generate descriptive ARIA labels for every interactive or meaningful visual element.

Design nodes (flattened, with IDs, names, paths, types, positions, and text content):
${designContext}

Identify and generate ARIA labels for these element types:
- Buttons (e.g. Pay Now, View Details, Submit)
- Tabs and navigation items
- Calendar dates
- Cards (bill cards, event cards, promo banners)
- Icons (standalone or within interactive elements)
- Input fields and filters
- Overflow menus
- Status badges (Paid, Overdue, Scheduled, etc.)

Rules for ARIA label generation:
- Labels must be descriptive and screen-reader friendly — not just the visible text
- Include context (e.g. "Pay Now button for Personal Loan EMI — ₹4,200 due October 10")
- For icons, describe the action/meaning (e.g. "Notifications button with 3 unread alerts")
- For status badges, include the entity they belong to (e.g. "Paid status for Electricity Bill")
- For calendar dates, include full date context (e.g. "October 4, 2024 — 2 events scheduled")
- For cards, describe the content (e.g. "HDFC Credit Card bill — ₹12,500 due in 3 days")

Only include nodes that genuinely need ARIA labels (skip decorative/structural frames, separators, background shapes).

Return a JSON array where each item has:
{
  "nodeId": "exact_node_id_from_above",
  "nodeName": "original node name",
  "role": "button | tab | navigation | listitem | img | input | status | link | heading | checkbox | radiobutton | combobox | menuitem",
  "ariaLabel": "Full descriptive ARIA label string",
  "context": "Brief explanation of why this label was chosen",
  "path": "component path from design data"
}`;
    } else {
      // focus_order
      systemPrompt = `You are an expert accessibility engineer specializing in keyboard navigation, focus management, and WCAG 2.1 success criteria for mobile and web banking applications.
You MUST respond with ONLY a valid JSON array — no markdown, no explanation.
Start your response with [ and end with ].`;

      userPrompt = `Analyze this Figma design from a screen called "${pageName}" in "${fileName}" and define a logical keyboard focus order for all interactive elements.

Design nodes (flattened, with IDs, names, paths, types, positions x/y, and sizes):
${designContext}

Define the focus order following these principles:
- Move left-to-right, top-to-bottom following the natural reading flow
- Respect component hierarchy (e.g. a card's CTA comes after the card header)
- Global navigation → Search → Header actions (notifications, profile) → Page controls → Filters/tabs → Content areas → Cards and their actions → Overflow menus
- Skip purely decorative or structural elements (frames, backgrounds, dividers)
- Interactive elements include: buttons, tabs, links, inputs, selects, checkboxes, radio buttons, date pickers, overflow menus, cards with actions

For each interactive element, provide:
{
  "nodeId": "exact_node_id_from_above",
  "nodeName": "original node name",
  "focusIndex": 1,
  "role": "button | tab | navigation | input | link | checkbox | radiobutton | combobox | menuitem | listitem",
  "ariaLabel": "Short descriptive label for this element",
  "path": "component path from design data",
  "rationale": "Why this position in the focus order"
}

The focusIndex must start at 1 and increment sequentially. Return ALL interactive elements sorted by focusIndex.`;
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
        max_tokens: 16000,
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
