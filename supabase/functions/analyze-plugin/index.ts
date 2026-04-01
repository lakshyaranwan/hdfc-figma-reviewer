import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface FeedbackItem {
  id: string;
  category: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  location?: string;
  nodeId?: string;
  suggestion?: string;
}

// Estimate token count from string length
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Flatten deeply nested design data into a flat array of simplified nodes
function flattenDesignData(nodes: any[], maxDepth = 8): any[] {
  const flat: any[] = [];

  function traverse(node: any, path: string, depth: number) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    // Use visible text content as path label for readability — not the layer name
    const displayLabel = node.characters?.trim() || node.name || node.type || "unknown";
    const currentPath = path ? `${path} > ${displayLabel}` : displayLabel;

    const simplified: any = {
      id: node.id,
      name: node.name,
      type: node.type,
      path: currentPath,
    };

    // Include text content
    if (node.characters) simplified.text = node.characters;

    // Include key style properties only (not full nested style objects)
    if (node.fills && Array.isArray(node.fills) && node.fills.length > 0) {
      simplified.fills = node.fills.map((f: any) => {
        const hex = f.color ? `#${Math.round(f.color.r*255).toString(16).padStart(2,'0')}${Math.round(f.color.g*255).toString(16).padStart(2,'0')}${Math.round(f.color.b*255).toString(16).padStart(2,'0')}` : undefined;
        return {
          type: f.type,
          color: f.color ? `rgba(${Math.round(f.color.r*255)},${Math.round(f.color.g*255)},${Math.round(f.color.b*255)},${f.color.a ?? 1})` : undefined,
          hex,
        };
      });
    }
    if (node.fontSize) simplified.fontSize = node.fontSize;
    if (node.fontName) simplified.fontName = node.fontName;
    // Pass through bound DS style IDs — used to detect already-linked styles
    if (node.textStyleId) simplified.textStyleId = node.textStyleId;
    if (node.textStyleName) simplified.textStyleName = node.textStyleName;
    if (node.fillStyleId) simplified.fillStyleId = node.fillStyleId;
    if (node.fillStyleName) simplified.fillStyleName = node.fillStyleName;
    if (node.cornerRadius) simplified.cornerRadius = node.cornerRadius;
    if (node.opacity !== undefined && node.opacity !== 1) simplified.opacity = node.opacity;
    if (node.constraints) simplified.constraints = node.constraints;
    if (node.layoutMode) simplified.layoutMode = node.layoutMode;
    if (node.itemSpacing) simplified.itemSpacing = node.itemSpacing;
    if (node.paddingLeft || node.paddingTop || node.paddingRight || node.paddingBottom) {
      simplified.padding = { l: node.paddingLeft, t: node.paddingTop, r: node.paddingRight, b: node.paddingBottom };
    }

    // Include position (enables spatial reasoning in feedback)
    if (node.x !== undefined) simplified.x = Math.round(node.x);
    if (node.y !== undefined) simplified.y = Math.round(node.y);

    // Include size
    if (node.absoluteBoundingBox) {
      simplified.size = { w: node.absoluteBoundingBox.width, h: node.absoluteBoundingBox.height };
    } else if (node.width !== undefined) {
      simplified.size = { w: node.width, h: node.height };
    }

    flat.push(simplified);

    // Recurse into children
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

// Extract all visible text grouped by top-level frame
function extractTextContent(flatNodes: any[]): string {
  const grouped: Record<string, string[]> = {};
  for (const node of flatNodes) {
    if (!node.text) continue;
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = [];
    grouped[topFrame].push(`"${node.text}" (id:${node.id}, name:${node.name || '-'})`);
  }
  return Object.entries(grouped)
    .map(([frame, texts]) => `[${frame}]\n${texts.join('\n')}`)
    .join('\n\n');
}

// Extract semantic context: pair container fills with their child text content
function extractSemanticContext(flatNodes: any[]): string {
  // Build a map of node ID → node for quick lookup
  const nodeMap = new Map<string, any>();
  for (const node of flatNodes) nodeMap.set(node.id, node);

  // For every non-text node with fills, find text children by path prefix
  const semanticPairs: string[] = [];
  const grouped: Record<string, string[]> = {};

  for (const node of flatNodes) {
    if (node.type === 'TEXT') continue;
    if (!node.fills || !Array.isArray(node.fills) || node.fills.length === 0) continue;
    const hex = node.fills[0]?.hex;
    if (!hex) continue;

    // Find all text nodes that are children of this container (path starts with this node's path)
    const childTexts: string[] = [];
    for (const candidate of flatNodes) {
      if (candidate.type !== 'TEXT' || !candidate.text) continue;
      if (candidate.path?.startsWith(node.path + ' > ')) {
        childTexts.push(candidate.text);
      }
    }
    if (childTexts.length === 0) continue;

    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = [];
    grouped[topFrame].push(`Container "${node.name || node.type}" (id:${node.id}) fill:${hex} → text: ${childTexts.map(t => `"${t}"`).join(', ')}`);
  }

  return Object.entries(grouped)
    .map(([frame, pairs]) => `[${frame}]\n${pairs.join('\n')}`)
    .join('\n\n');
}

// Extract all fill colours grouped by top-level frame
function extractColorContext(flatNodes: any[]): string {
  const grouped: Record<string, Set<string>> = {};
  for (const node of flatNodes) {
    if (!node.fills || !Array.isArray(node.fills)) continue;
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = new Set();
    for (const fill of node.fills) {
      if (fill.hex) grouped[topFrame].add(`${fill.hex} (${node.type}${node.name ? ': ' + node.name : ''}, id:${node.id})`);
    }
  }
  return Object.entries(grouped)
    .map(([frame, colors]) => `[${frame}]\n${[...colors].join('\n')}`)
    .join('\n\n');
}

// Chunk flat nodes by estimated token size
function chunkByTokens(nodes: any[], maxTokensPerChunk: number): any[][] {
  const chunks: any[][] = [];
  let currentChunk: any[] = [];
  let currentTokens = 0;

  for (const node of nodes) {
    const nodeTokens = estimateTokens(JSON.stringify(node));
    if (currentChunk.length > 0 && currentTokens + nodeTokens > maxTokensPerChunk) {
      chunks.push(currentChunk);
      currentChunk = [node];
      currentTokens = nodeTokens;
    } else {
      currentChunk.push(node);
      currentTokens += nodeTokens;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.length > 0 ? chunks : [[]];
}

// DB helpers for chunk tracking
async function storeChunks(supabaseUrl: string, serviceRoleKey: string, jobId: string, chunks: any[][]) {
  for (let i = 0; i < chunks.length; i++) {
    await fetch(`${supabaseUrl}/rest/v1/analysis_chunks`, {
      method: "POST",
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_id: jobId,
        chunk_index: i,
        chunk_data: { nodeCount: chunks[i].length },
        status: "pending",
      }),
    });
  }
}

async function updateChunkStatus(supabaseUrl: string, serviceRoleKey: string, jobId: string, chunkIndex: number, status: string, result?: any) {
  await fetch(`${supabaseUrl}/rest/v1/analysis_chunks?job_id=eq.${jobId}&chunk_index=eq.${chunkIndex}`, {
    method: "PATCH",
    headers: {
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status, ...(result ? { result } : {}) }),
  });
}

async function cleanupChunks(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  await fetch(`${supabaseUrl}/rest/v1/analysis_chunks?job_id=eq.${jobId}`, {
    method: "DELETE",
    headers: {
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    
    // Handle lightweight usage-tracking-only calls from the UI (contrast checks etc.)
    if (body._trackOnly) {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/plugin_usage`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
            body: JSON.stringify({
              user_name: body.fileName || "unknown",
              action: body.action || "a11y_contrast",
              node_count: body.nodeCount || 0,
              category_count: 1,
            }),
          });
        } catch (e) { /* ignore */ }
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    
    const { designData, prompt, categories, isCustom, fileName, pageName, ignoreChrome, dsContext } = body;
    
    console.log("Analyzing design from plugin");
    console.log("File:", fileName);
    console.log("Page:", pageName);
    console.log("Raw nodes received:", designData?.length || 0);
    console.log("Categories:", categories);
    console.log("Is custom prompt:", isCustom);
    console.log("DS context present:", !!dsContext);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    // Fetch selected AI model from settings (same as analyze-figma)
    let selectedModel = "google/gemini-2.5-flash"; // default
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const settingsResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/app_settings?key=eq.ai_model&select=value`,
          {
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
        
        if (settingsResponse.ok) {
          const settings = await settingsResponse.json();
          if (settings && settings.length > 0 && settings[0].value) {
            selectedModel = settings[0].value;
            console.log("Using selected model:", selectedModel);
          }
        }
      } catch (error) {
        console.error("Error fetching model setting:", error);
      }
    }

    // Store usage info helper (same as analyze-figma)
    const storeUsageInfo = async (status: string, headers: Headers, error?: any) => {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
      try {
        const usage: any = {
          model: selectedModel,
          lastUsed: new Date().toISOString(),
          status,
        };
        const remaining = headers.get("x-ratelimit-remaining-tokens");
        const limit = headers.get("x-ratelimit-limit-tokens");
        const resetTime = headers.get("x-ratelimit-reset-tokens");
        if (remaining) usage.remaining = parseInt(remaining);
        if (limit) usage.limit = parseInt(limit);
        if (resetTime) usage.resetTime = resetTime;
        if (error) {
          const match = error.match(/Limit (\d+), Used (\d+)/);
          if (match) {
            usage.limit = parseInt(match[1]);
            usage.remaining = parseInt(match[1]) - parseInt(match[2]);
          }
        }
        await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            key: `model_usage_${selectedModel}`,
            value: JSON.stringify(usage),
          }),
        });
      } catch (e) {
        console.error("Error storing usage info:", e);
      }
    };

    if (!designData || designData.length === 0) {
      throw new Error("No design data provided. Please select a frame in Figma.");
    }

    // Step 1: Flatten deeply nested design data into simplified flat nodes
    const flatNodes = flattenDesignData(designData);
    console.log("Flattened to", flatNodes.length, "nodes");
    console.log("Estimated total tokens:", estimateTokens(JSON.stringify(flatNodes)));

    // Step 2: Chunk by actual token size (not node count)
    const TOKEN_LIMIT = 80000; // ~80k tokens per chunk to stay well within 1M context
    const chunks = chunkByTokens(flatNodes, TOKEN_LIMIT);
    const isChunked = chunks.length > 1;
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`Split into ${chunks.length} chunk(s)`);

    // Store chunks in DB for tracking
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await storeChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunks);
        console.log(`Stored ${chunks.length} chunk records (job: ${jobId})`);
      } catch (e) {
        console.error("Error storing chunk records:", e);
      }
    }

    // Category setup
    const categoryLabels: Record<string, string> = {
      consistency: "Consistency across flows regarding UI",
      ux: "UX Review",
      ui: "UI Review",
      ux_writing: "Typos & Inconsistent UX Writing",
      high_level: "High Level Review About and the Why? Questioning the basics.",
    };

    let allowedCategories = categories || ["ux", "ui", "consistency"];
    if (isCustom) {
      allowedCategories = ["ux", "ui", "consistency", "ux_writing", "high_level", "improvement"];
    }
    // Add design_system category when DS context is available
    if (dsContext && !allowedCategories.includes("design_system")) {
      allowedCategories.push("design_system");
    }

    const categoryOptions = allowedCategories.map((c: string) => `"${c}"`).join(" | ");

    const systemPrompt = `You are a senior product designer doing design QA. You review like a stakeholder would — you catch the things that would be embarrassing in a demo or confusing to a real user.

Every issue you raise MUST be proven by a specific node ID, text string, or colour value from the data provided. Never raise theoretical issues you cannot point to in the data.

You work in TWO PASSES:
PASS 1 — STAKEHOLDER GLANCE (HIGH and MEDIUM severity): Things a non-designer would spot in a 5-second look at the screen. These go first and get priority. Fill at least 70% of your output with these.
PASS 2 — DESIGNER POLISH (LOW severity): Pixel-level refinements only a designer would notice. These fill remaining slots AFTER Pass 1 is exhausted.

Severity definitions:
HIGH = Broken, embarrassing, or actively misleading. A stakeholder would call this out in a review. Examples: red banner saying "Success", placeholder text still visible, a CTA saying "Submit" for a delete action, green used for an error state.
MEDIUM = Confusing or inconsistent. A user would hesitate or be unsure. Examples: same action called different names on different screens, inconsistent button styles for the same role, unclear CTA labels.
LOW = Polish. Only a designer doing a pixel audit would notice. Examples: 1px spacing difference, border radius inconsistency, slight alignment offset, padding mismatch.

NEVER FLAG THESE (undetectable from static Figma data):
- Hover states, focus rings, active states, pressed states
- Animations, transitions, micro-interactions
- Loading states, skeleton screens, shimmer effects
- API responses, real data vs mock data
- Scroll behaviour, pull-to-refresh
- Keyboard navigation or screen reader behaviour
- Performance, load times, responsiveness
- Touch target sizes (unless visually obvious from bounding box)

Return ONLY a valid JSON array. No markdown. Start with [ end with ].`;

    console.log(`Processing ${chunks.length} chunk(s) with AI model: ${selectedModel}`);
    let allFeedback: FeedbackItem[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkLabel = isChunked ? ` (chunk ${chunkIdx + 1}/${chunks.length})` : "";
      console.log(`Processing${chunkLabel}: ${chunk.length} nodes, ~${estimateTokens(JSON.stringify(chunk))} tokens`);

      // Match analyze-figma: scale items per category by chunk count
      const itemsPerCategory = isChunked 
        ? Math.max(3, Math.floor(8 / chunks.length))
        : Math.floor(80 / allowedCategories.length);

      const designContext = JSON.stringify(chunk, null, 2);
      const textContent = extractTextContent(chunk);
      const colorContent = extractColorContext(chunk);
      const semanticContext = extractSemanticContext(chunk);

      const dsPromptSection = dsContext ? `
═══ DESIGN SYSTEM CONTEXT ═══
DS INVENTORY:
- Components (${(dsContext.componentNames || []).length}): ${(dsContext.componentNames || []).slice(0, 100).join(', ')}
- Color tokens (${(dsContext.colorTokenMap || dsContext.colorNames || []).length}): ${
  (dsContext.colorTokenMap && dsContext.colorTokenMap.length > 0)
    ? dsContext.colorTokenMap.slice(0, 80).map((t: any) => `${t.name}=${t.hex}`).join(', ')
    : (dsContext.colorNames || []).slice(0, 60).join(', ')
}
- Text styles: ${(dsContext.textStyleMap && dsContext.textStyleMap.length > 0)
  ? dsContext.textStyleMap.slice(0, 30).map((t: any) => `${t.name}(${t.family} ${t.size}px ${t.weight})`).join(', ')
  : (dsContext.textStyleNames || []).slice(0, 30).join(', ')}
${dsContext.libraryNames?.length ? `- Libraries: ${dsContext.libraryNames.join(', ')}` : ""}

DS RULES:
- Nodes with fillStyleId set are ALREADY using a DS color token — do NOT flag them.
- Nodes with textStyleId set are ALREADY using a DS text style — do NOT flag them.
- Only flag nodes WITHOUT these bound style IDs.
- For unbound fills, compare hex to DS COLOR TOKEN MAP and suggest the closest token.
- For unbound text, compare font/size/weight to DS text styles and suggest the closest style.
` : '';

      const analysisPrompt = `
═══ DESIGN DATA${chunkLabel} ═══
File: ${fileName} | Page: ${pageName}

Node hierarchy (use these exact IDs in nodeId field):
${designContext}

═══ ALL VISIBLE TEXT (with node IDs) ═══
${textContent}

═══ ALL FILL COLOURS (with node IDs) ═══
${colorContent}

═══ SEMANTIC CONTEXT (container fill → child text pairings) ═══
Use this to detect colour-meaning clashes. Each line shows a container's fill colour and the text inside it.
${semanticContext}

${dsPromptSection}

${isCustom ? `User's specific request: ${prompt}\n` : ''}${ignoreChrome ? `IGNORE CHROME: Do NOT flag status bars, app bars, nav bars, tab bars, footers, or other shell elements. Only flag content-area issues.\n` : ''}

═══ PASS 1: STAKEHOLDER GLANCE (HIGH + MEDIUM) ═══
Scan the data for these issues FIRST. These are embarrassing, confusing, or broken. Flag every violation you find.

COLOUR-CONTEXT CLASHES
1. Red or orange fill on a container whose child text says "success", "confirmed", "approved", "completed", "congratulations", or any positive outcome
2. Green fill on a container whose child text says "error", "failed", "declined", "rejected", "warning", or any negative outcome
3. High-contrast bold colour on elements named or labelled "disabled", "inactive", or "unavailable"
4. Muted/grey colour on a primary CTA or urgent action
5. Warning colour (amber/orange) on purely informational or neutral content
6. The same semantic role (primary CTA, error, warning, success) rendered in different colours across different screens

TEXT-CONTEXT CLASHES
7. Any text that looks like a dev/design default still in place: trailing digits ("Send Money 2", "Card 3"), "copy of", "untitled", "lorem ipsum", "placeholder", "label", "title", "text here", "item 1", "heading", "body text", "subtitle"
8. Any spelling or grammatical error in visible text
9. Inconsistent terminology: the same action or concept called different things across screens (e.g. "Send" vs "Transfer", "Cancel" vs "Back" for the same action)
10. Inconsistent capitalisation style for the same type of element (e.g. some buttons Title Case, others ALL CAPS, others sentence case)
11. Positive/celebratory text ("Congratulations", "Success", "Well done") inside error-styled or warning-styled containers
12. Negative text ("Failed", "Error", "Declined") inside success-styled or positive-styled containers
13. Urgent language ("Immediately", "Critical", "Urgent") in low-emphasis muted styling
14. Question marks in button labels — CTAs should be declarative, not questioning
15. Exclamation marks in error messages — feels aggressive to users

ICON-CONTEXT CLASHES
16. A node named or shaped like a delete/trash icon next to text saying "Save", "Confirm", or "Submit"
17. A checkmark/success icon in an error or warning context
18. A warning triangle icon in a success or confirmation context
19. A lock icon on elements labelled as public, open, or shared

STATE & STORYTELLING CLASHES
20. An empty state screen with no guidance, onboarding text, or call to action
21. A confirmation screen with no summary of what was confirmed
22. A form with a submit CTA but no visible required-field indicators or validation hints
23. Screens in a flow where the visual hierarchy (heading sizes, colours) changes dramatically and inconsistently
24. Progress indicators that skip steps or show inconsistent state across screens
25. A modal or overlay with no visible dismiss/close action

COMPONENT & NAMING
26. Any frame or component whose name matches default patterns: "Frame \\d+", "Group \\d+", "Rectangle \\d+", "Vector \\d+", "Image \\d+"
27. The same UI pattern (card, list item, header, button) implemented with different structures across screens instead of using a shared component
28. A component named "disabled" or "inactive" that uses full-opacity high-contrast fills
29. A component named "primary" that is visually subordinate to its siblings
30. A component named "error" or "destructive" using green or blue fills

UX FLOW
31. A destructive or irreversible action with no confirmation step visible in the data
32. A primary CTA whose label does not clearly describe the outcome ("Submit", "OK", "Continue" with no context)
33. Any screen that appears to be a dead end — no visible navigation, back button, or exit action
34. Truncated or cut-off text that appears incomplete based on the bounding box

═══ PASS 2: DESIGNER POLISH (LOW only) ═══
Only after completing Pass 1, fill remaining slots with these. These are refinements, not blockers.

35. Inconsistent spacing between the same type of element across screens
36. Elements slightly misaligned relative to their siblings based on bounding box data
37. Minor border radius inconsistencies across similar components
38. Inconsistent padding values in similar containers
39. Minor font size or weight variations in elements that should match

═══ OUTPUT FORMAT ═══
CRITICAL CATEGORY RESTRICTION: Only use these category values: ${categoryOptions}
Aim for ${itemsPerCategory} items per category, distributed across ALL requested categories.
At least 70% of items MUST be HIGH or MEDIUM severity (Pass 1). LOW severity items (Pass 2) fill the remainder.

Use the MOST SPECIFIC node ID for each issue (the text layer, not the parent frame).
NEVER include technical IDs like [123:456] in title or description fields.
Every issue MUST cite the specific text string, hex colour, or node name that proves it.

[{
  "category": ${categoryOptions},
  "title": "Human-readable issue title",
  "description": "What is wrong, citing the specific evidence (text/colour/name) from the data",
  "suggestion": "Specific actionable fix",
  "severity": "low" | "medium" | "high",
  "location": "User-friendly component name",
  "nodeId": "exact_node_id_from_structure"
}]`;

      const promptTokens = estimateTokens(analysisPrompt + systemPrompt);
      console.log(`Chunk ${chunkIdx + 1} prompt tokens: ~${promptTokens}`);

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: analysisPrompt },
          ],
          max_tokens: 16000,
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error(`AI API error on chunk ${chunkIdx + 1}:`, errorText);
        await storeUsageInfo(
          aiResponse.status === 429 ? "rate_limited" : "error",
          aiResponse.headers,
          errorText
        );

        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try { await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "failed"); } catch (e) { /* ignore */ }
        }

        if (aiResponse.status === 400 && isChunked) {
          console.warn(`Chunk ${chunkIdx + 1} hit token limit, skipping...`);
          continue;
        }
        
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

      await storeUsageInfo("available", aiResponse.headers);
      const aiData = await aiResponse.json();
      const content = aiData.choices?.[0]?.message?.content;

      if (!content) {
        console.error(`No content in AI response for chunk ${chunkIdx + 1}`);
        if (isChunked) continue;
        throw new Error("No content in AI response");
      }

      try {
        let cleanContent = content.trim();
        if (cleanContent.startsWith("```json")) cleanContent = cleanContent.slice(7);
        else if (cleanContent.startsWith("```")) cleanContent = cleanContent.slice(3);
        if (cleanContent.endsWith("```")) cleanContent = cleanContent.slice(0, -3);
        cleanContent = cleanContent.trim();
        
        const chunkFeedback: FeedbackItem[] = JSON.parse(cleanContent);
        if (!Array.isArray(chunkFeedback)) throw new Error("Response is not an array");

        allFeedback.push(...chunkFeedback);
        console.log(`Chunk ${chunkIdx + 1}: got ${chunkFeedback.length} feedback items`);

        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try { await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "completed", { count: chunkFeedback.length }); } catch (e) { /* ignore */ }
        }
      } catch (parseError) {
        console.error(`Failed to parse chunk ${chunkIdx + 1}:`, parseError);
        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try { await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "parse_error"); } catch (e) { /* ignore */ }
        }
        if (!isChunked) throw new Error("Failed to parse AI analysis results");
        continue;
      }
    }

    // Clean up chunk records
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await cleanupChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId);
        console.log(`Cleaned up chunk records for job: ${jobId}`);
      } catch (e) {
        console.error("Error cleaning up chunks:", e);
      }
    }

    // Deduplicate by title (case-insensitive) and sort high → medium → low
    const seen = new Set<string>();
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    allFeedback = allFeedback
      .filter(item => {
        const key = (item.title || '').toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

    const categoryCount: Record<string, number> = {};
    allFeedback.forEach(item => {
      const cat = item.category || 'general';
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    });

    const feedback = allFeedback.map((item, index) => ({
      ...item,
      id: `feedback-${index}-${Date.now()}`,
    }));

    console.log(`Analysis complete: ${feedback.length} feedback items`);
    console.log("Category distribution:", categoryCount);

    // Track usage
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/plugin_usage`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({
            user_name: fileName || "unknown",
            action: "analyze",
            node_count: flatNodes.length,
            category_count: allowedCategories.length,
          }),
        });
      } catch (e) {
        console.error("Failed to track usage:", e);
      }
    }

    const summary = {
      total: feedback.length,
      high: feedback.filter(f => f.severity === "high").length,
      medium: feedback.filter(f => f.severity === "medium").length,
      low: feedback.filter(f => f.severity === "low").length,
      byCategory: categoryCount,
    };

    return new Response(
      JSON.stringify({ success: true, feedback, summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error("Error in analyze-plugin:", error);
    const errorMessage = error instanceof Error ? error.message : "Analysis failed";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
