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

  function traverse(node: any, path: string, depth: number, parentId?: string) {
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
      parentId: parentId || null,
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
        traverse(child, currentPath, depth + 1, node.id);
      }
    }
  }

  for (const node of nodes) {
    traverse(node, "", 0);
  }

  return flat;
}

// Extract all visible text grouped by top-level frame
// IMPORTANT: Only show the actual displayed text (characters), NOT layer names.
function extractTextContent(flatNodes: any[]): string {
  const grouped: Record<string, { text: string; id: string; y: number }[]> = {};
  for (const node of flatNodes) {
    if (!node.text) continue;
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = [];
    grouped[topFrame].push({ text: node.text, id: node.id, y: node.y ?? 0 });
  }
  // Sort by y-position within each frame so AI reads top-to-bottom
  return Object.entries(grouped)
    .map(([frame, items]) => {
      items.sort((a, b) => a.y - b.y);
      return `[${frame}]\n${items.map(i => `"${i.text}" (id:${i.id})`).join('\n')}`;
    })
    .join('\n\n');
}

// Extract semantic context: pair container fills with their child text content
// Also classify the fill colour semantically (red=danger, green=success, etc.)
function classifyColor(hex: string): string {
  if (!hex) return '';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Red-ish (danger/error)
  if (r > 180 && g < 100 && b < 100) return '🔴 RED/DANGER';
  if (r > 200 && g < 80) return '🔴 RED/DANGER';
  // Orange-ish (warning)
  if (r > 200 && g > 100 && g < 180 && b < 80) return '🟠 ORANGE/WARNING';
  // Green-ish (success)
  if (g > 150 && r < 150 && b < 150) return '🟢 GREEN/SUCCESS';
  // Blue-ish (info)
  if (b > 180 && r < 120 && g < 180) return '🔵 BLUE/INFO';
  // Yellow-ish (caution)
  if (r > 200 && g > 200 && b < 100) return '🟡 YELLOW/CAUTION';
  return '';
}

function extractSemanticContext(flatNodes: any[]): string {
  const grouped: Record<string, string[]> = {};

  for (const node of flatNodes) {
    if (node.type === 'TEXT') continue;
    if (!node.fills || !Array.isArray(node.fills) || node.fills.length === 0) continue;
    const hex = node.fills[0]?.hex;
    if (!hex) continue;

    // Find all text nodes that are children of this container
    const childTexts: string[] = [];
    for (const candidate of flatNodes) {
      if (candidate.type !== 'TEXT' || !candidate.text) continue;
      if (candidate.path?.startsWith(node.path + ' > ')) {
        childTexts.push(candidate.text);
      }
    }
    if (childTexts.length === 0) continue;

    const colorLabel = classifyColor(hex);
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = [];
    grouped[topFrame].push(`Container (id:${node.id}) fill:${hex}${colorLabel ? ' ← ' + colorLabel : ''} → text: ${childTexts.map(t => `"${t}"`).join(', ')}`);
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

CRITICAL DATA RULES:
1. The "text" field contains the ACTUAL VISIBLE TEXT displayed to users. The "name" field is an internal layer label created by designers — it is OFTEN WRONG, OUTDATED, or PLACEHOLDER. ALWAYS judge by "text" content. NEVER trust "name" for visible content analysis.
2. Every issue MUST cite a specific text string, hex colour, or node ID from the data. No theoretical issues.
3. ONE issue per node ID. NEVER report the same nodeId twice.
4. ONE issue per unique problem. If the same text appears in multiple places, report it ONCE.
5. Spread attention EVENLY across ALL screens/frames. Do NOT fixate on one screen.

WORKFLOW — CROSS-SCREEN COMPARISON:
Before writing issues, enumerate every top-level frame (screen). Then:
Step 1: Compare screens as a FLOW — coherent story? Logical transitions?
Step 2: Compare ACROSS screens — consistent styling? Same terminology?
Step 3: Review EACH screen individually for internal problems.

TWO-PASS STRATEGY:
PASS 1 — STAKEHOLDER GLANCE (HIGH + MEDIUM, ≥70%): Things a non-designer would spot.
PASS 2 — DESIGNER POLISH (LOW, ≤30%): Pixel-level refinements.

🚨 SEMANTIC CONTEXT IS YOUR MOST IMPORTANT SIGNAL:
The SEMANTIC CONTEXT section pairs each coloured container with the text inside it. Entries tagged with 🔴 RED/DANGER, 🟢 GREEN/SUCCESS etc. tell you the colour meaning.
LOOK FOR CLASHES: Red container + positive text ("Success", "Congratulations") = CRITICAL HIGH.
Green container + negative text ("Error", "Failed") = CRITICAL HIGH.
READ THIS SECTION LINE BY LINE BEFORE ANYTHING ELSE.

Severity definitions:
HIGH = Broken, embarrassing, or actively misleading. Examples: red banner saying "Success", placeholder text, colour-meaning clashes, typos, truncated words.
MEDIUM = Confusing or inconsistent across screens. Examples: same action called different names, inconsistent button styles.
LOW = Polish. Only a designer would notice. Examples: spacing, border radius, alignment.

NEVER FLAG:
Hover/focus/active states, animations, loading states, API data, scroll behaviour, keyboard nav, performance, touch targets. NEVER flag "missing confirmation" when a clear confirmation/success message already exists in the text.

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
REMINDER: "text" field = what the USER SEES. "name" field = internal layer label (IGNORE for content analysis).

Node hierarchy (use these exact IDs in nodeId field):
${designContext}

═══ ALL VISIBLE TEXT (sorted top-to-bottom per screen) ═══
These are the ACTUAL words displayed on screen. Read them carefully for typos, placeholders, truncation.
${textContent}

═══ ALL FILL COLOURS (with node IDs) ═══
${colorContent}

═══ 🚨 SEMANTIC CONTEXT — READ THIS FIRST (container fill → child text pairings) ═══
Each line pairs a container's background colour with the text displayed inside it.
Entries tagged 🔴 RED/DANGER + positive text = CRITICAL CLASH. Flag as HIGH immediately.
Entries tagged 🟢 GREEN/SUCCESS + negative text = CRITICAL CLASH. Flag as HIGH immediately.
${semanticContext}

${dsPromptSection}

${isCustom ? `User's specific request: ${prompt}\n` : ''}${ignoreChrome ? `IGNORE CHROME: Do NOT flag status bars, app bars, nav bars, tab bars, footers, or other shell elements. Only flag content-area issues.\n` : ''}

═══ PASS 1: STAKEHOLDER GLANCE (HIGH + MEDIUM) ═══
Scan ALL screens. For each screen, check these categories. Flag every violation with evidence.

TYPOS & TEXT ISSUES (check EVERY text node):
1. Spelling errors, grammatical errors, truncated words (e.g. "Transfera" instead of "Transfer", "Confrim" instead of "Confirm")
2. Placeholder/dev text: trailing digits ("Send Money2"), "lorem ipsum", "copy of", "untitled", "label", "text here", "heading"
3. Inconsistent terminology across screens: same action called different names (e.g. "Send" vs "Transfer")
4. Inconsistent capitalisation: some buttons Title Case, others ALL CAPS, others sentence case
5. Question marks in CTA labels, exclamation marks in error messages

COLOUR-CONTEXT CLASHES (cross-reference SEMANTIC CONTEXT section):
6. Red/orange container with positive text ("success", "confirmed", "approved", "congratulations")
7. Green container with negative text ("error", "failed", "declined", "warning")
8. Same semantic role (primary CTA, error, success) in DIFFERENT colours across screens
9. Celebratory text inside error-styled containers, or error text inside success-styled containers

COMPONENT & NAMING:
10. Default names still present: "Frame \\d+", "Group \\d+", "Rectangle \\d+", "Vector \\d+"
11. Same UI pattern (card, button, list item) built differently across screens instead of shared component

UX FLOW (compare screens as a journey):
12. Destructive/irreversible action with no confirmation step
13. Dead-end screens: no navigation, back button, or next action
14. Empty state with no guidance or call to action
15. Success/confirmation screen missing summary of what was confirmed
16. Progress indicators that skip steps or show inconsistent state

═══ PASS 2: DESIGNER POLISH (LOW) ═══
17. Inconsistent spacing between same type of element across screens
18. Alignment issues, border radius inconsistencies, padding mismatches

═══ DEDUPLICATION RULES ═══
- If the SAME text problem appears on the SAME nodeId, report it ONCE only.
- If the same issue type appears on DIFFERENT screens, you may report each instance but with DIFFERENT nodeIds.
- Prefer DIVERSE issues over MANY instances of the same problem.

═══ OUTPUT FORMAT ═══
CRITICAL CATEGORY RESTRICTION: Only use these category values: ${categoryOptions}
Aim for ${itemsPerCategory} items per category, distributed across ALL requested categories.
At least 70% of items MUST be HIGH or MEDIUM severity.

Use the MOST SPECIFIC node ID for each issue (the text layer, not the parent frame).
NEVER include technical IDs like [123:456] in title or description fields.
Every issue MUST cite the specific text string, hex colour, or node name that proves it.

[{
  "category": ${categoryOptions},
  "title": "Human-readable issue title (unique — no two items should have the same title)",
  "description": "What is wrong, citing specific evidence. If same issue in multiple places, list all locations here.",
  "suggestion": "Specific actionable fix",
  "severity": "low" | "medium" | "high",
  "location": "User-friendly component name",
  "nodeId": "exact_node_id_from_structure (UNIQUE — never reuse a nodeId)"
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
          max_tokens: 48000,
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

        // Attempt JSON repair for truncated responses
        let chunkFeedback: FeedbackItem[];
        try {
          chunkFeedback = JSON.parse(cleanContent);
        } catch (_initialParseError) {
          console.warn(`Chunk ${chunkIdx + 1}: JSON truncated, attempting repair...`);
          // Try closing the JSON array gracefully
          let repaired = cleanContent;
          // Remove trailing incomplete object/string
          repaired = repaired.replace(/,\s*\{[^}]*$/, '');   // remove last incomplete object
          repaired = repaired.replace(/,\s*"[^"]*$/, '');     // remove trailing incomplete string
          if (!repaired.endsWith(']')) {
            // Close any open object then close array
            const openBraces = (repaired.match(/\{/g) || []).length;
            const closeBraces = (repaired.match(/\}/g) || []).length;
            for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
            repaired += ']';
          }
          chunkFeedback = JSON.parse(repaired);
          console.log(`Chunk ${chunkIdx + 1}: repair succeeded with ${chunkFeedback.length} items`);
        }
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

    // Deduplicate: by nodeId first, then by fuzzy title similarity, then sort
    const seenNodeIds = new Set<string>();
    const seenTitleKeys = new Set<string>();
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    
    // Sort by severity first so we keep the highest severity version of duplicates
    allFeedback.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));
    
    allFeedback = allFeedback.filter(item => {
      // Dedup by nodeId: same node = same issue
      if (item.nodeId) {
        if (seenNodeIds.has(item.nodeId)) return false;
        seenNodeIds.add(item.nodeId);
      }
      
      // Dedup by normalized title: strip quotes, IDs, punctuation, lowercase
      const normalizedTitle = (item.title || '')
        .toLowerCase()
        .replace(/['"""''`]/g, '')
        .replace(/\b(send money\s*2|send money2)\b/g, 'PLACEHOLDER_TEXT') // normalize specific repeated phrases
        .replace(/\bid:[^\s,)]+/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      // Create a "signature" from the first 6 significant words
      const words = normalizedTitle.split(' ').filter(w => w.length > 2);
      const titleKey = words.slice(0, 6).join(' ');
      
      if (titleKey && seenTitleKeys.has(titleKey)) return false;
      if (titleKey) seenTitleKeys.add(titleKey);
      
      return true;
    });

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
