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

    const systemPrompt = dsContext
      ? `You are an expert UX/UI designer and design systems specialist, acting as a senior design manager and reviewer.
You have deep knowledge of the attached Design System — you know every component, token, and pattern.
Your job: give thorough, specific feedback that actively references the DS. Every piece of feedback should either flag a DS deviation, confirm a correct usage, or provide DS-guided recommendations.
CRITICAL: You MUST respond with ONLY a valid JSON array, no other text.
Do not include markdown code blocks, explanations, or any text outside the JSON array.
Start your response with [ and end with ].`
      : `You are an expert UX/UI designer, acting as a manager and reviewer for a designer who lacks attention to detail.
You provide thorough, quality feedback - focus on real issues that matter.
CRITICAL: You MUST respond with ONLY a valid JSON array, no other text. 
Do not include markdown code blocks, explanations, or any text outside the JSON array.
Start your response with [ and end with ].`;

    // Process each chunk
    let allFeedback: FeedbackItem[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkLabel = isChunked ? ` (chunk ${chunkIdx + 1}/${chunks.length})` : "";
      console.log(`Processing${chunkLabel}: ${chunk.length} nodes, ~${estimateTokens(JSON.stringify(chunk))} tokens`);

      const itemsPerCategory = isChunked
        ? Math.max(3, Math.floor(10 / chunks.length))
        : 10;

      const designContext = JSON.stringify(chunk, null, 2);

      const baseContext = `I am a UI UX designer who lacks attention to details and makes mistakes. You are a UX/UI expert, my manager and my reviewer, analyzing my Figma designs.

Design Structure from Figma Plugin${chunkLabel} (flattened node list with IDs and paths):
${designContext}

File: ${fileName}
Page: ${pageName}

CRITICAL NODE ID INSTRUCTIONS:
- You MUST use the EXACT node IDs from the design data above
- Choose the MOST SPECIFIC node ID for each piece of feedback
- Include the nodeId field for every feedback item`;

      const formatInstructions = `
For each issue found, provide:
- A clear, actionable title (NO technical IDs or brackets)
- Detailed description with specific actionable suggestions
- Severity (low, medium, high)
- The EXACT node ID from the design data
- Component/frame name (user-friendly name only)
- A concrete suggestion field with the fix

CRITICAL CATEGORY RESTRICTION: Only use these categories: ${categoryOptions}

FEEDBACK GUIDELINES:
- Provide around ${itemsPerCategory} issues per category
- Focus on REAL, meaningful issues
- Do NOT skip any category

Format as JSON array:
[{
  "category": ${categoryOptions},
  "title": "Issue title (clean, no IDs)",
  "description": "Detailed description (clean, no IDs)",
  "suggestion": "Specific actionable fix",
  "severity": "low" | "medium" | "high",
  "location": "User-friendly component name",
  "nodeId": "exact_node_id"
}]

CRITICAL: 
- NEVER include technical IDs in title or description
- Always include nodeId with exact ID from design data
- Location must be user-friendly names only

${ignoreChrome ? `
IGNORE CHROME ELEMENTS:
- Do NOT provide any feedback on: status bars, app bars, headers, top navigation bars, bottom navigation bars, footers, navigation drawers, tab bars at the bottom/top of the screen, or any other structural chrome/shell elements.
- Only focus on the actual content area of the screen — the unique, page-specific content that the designer controls.
- If an issue exists exclusively in a header, footer, or nav bar, skip it entirely.
` : ""}

${allowedCategories.includes("consistency") ? `
SPECIAL INSTRUCTIONS FOR CONSISTENCY REVIEW:
- Compare ALL elements for inconsistent patterns
- Look for text variations, inconsistent styles, spacing
- Flag ALL instances of inconsistency
${dsContext ? `- CROSS-REFERENCE WITH DS: flag inconsistencies where the same DS component is used with different props/overrides across the screen (e.g. one card uses shadow, another doesn't). Also flag where a pattern is replicated in a custom frame instead of using the DS component consistently.` : ""}
` : ""}

${allowedCategories.includes("ux") ? `
SPECIAL INSTRUCTIONS FOR UX REVIEW:
- Review user flows, affordances, feedback states, empty states, error handling
- Check CTAs, hierarchy, navigation clarity, and task completion paths
${dsContext ? `- When a UX pattern could be solved by a DS component (e.g. a bottom sheet, a toast, a modal) but a custom solution is used instead, flag it. Reference the specific DS component name.` : ""}
` : ""}

      ${allowedCategories.includes("ui") ? `
SPECIAL INSTRUCTIONS FOR UI REVIEW:
- Review visual hierarchy, spacing, alignment, typography, and color usage

CRITICAL — AVOID FALSE POSITIVES ON STYLES ALREADY USING DS TOKENS:
- Each node in the design data may have a "textStyleId" / "textStyleName" field and/or a "fillStyleId" / "fillStyleName" field.
- If a node has "textStyleId" set (non-null), that text node is ALREADY using a bound DS text style. Do NOT flag it for typography deviation.
- If a node has "fillStyleId" set (non-null), that node is ALREADY using a bound DS color token. Do NOT flag it for color deviation.
- Only flag nodes that have fills/typography values BUT no bound style ID.

${dsContext ? `
- DS COLOR AUDIT: For every fill/color on nodes that do NOT have a fillStyleId, convert the hex field to compare against the DS color token map below.
  DS COLOR TOKEN MAP (TokenName=HexValue): [${
    (dsContext.colorTokenMap && dsContext.colorTokenMap.length > 0)
      ? dsContext.colorTokenMap.slice(0, 80).map((t: any) => `${t.name}=${t.hex}`).join(', ')
      : (dsContext.colorNames || []).slice(0, 60).join(', ')
  }]
  If the hex fill is NOT in this map, flag it as a "ui" issue.
  CRITICAL: In the "suggestion" field, name the CLOSEST color token by hex distance AND include its hex value.
  Format — suggestion: "Replace #1C3FCA with DS color token 'Primary/Blue-700' [#1C40CA] — nearest match by color."

- DS TYPOGRAPHY AUDIT: For every text node that does NOT have a textStyleId, check font family+size+weight against DS text styles.
  DS TEXT STYLE MAP (StyleName=Family SizePx Weight): [${
    (dsContext.textStyleMap && dsContext.textStyleMap.length > 0)
      ? dsContext.textStyleMap.slice(0, 30).map((t: any) => `${t.name}=${t.family} ${t.size}px ${t.weight}`).join(', ')
      : (dsContext.textStyleNames || []).slice(0, 30).join(', ')
  }]
  Flag deviations as "ui" issues. In the suggestion, name the closest matching text style AND its font/size/weight values.
  Format — suggestion: "Replace Inter 100px Bold with DS text style 'Heading/Display' (Inter 96px ExtraBold) — closest match."

- DS SPACING AUDIT: Check padding/margin values against DS spacing conventions. Flag non-standard values and suggest the nearest DS spacing increment.
` : `
- COLOR TOKEN SUGGESTIONS (no DS connected): For any fill color on a node that appears to be a raw custom hex (not a semantic value), note the hex value and suggest the designer assigns it a token. Use the hex field (e.g. "fills[0].hex") directly from the design data.
  Example: "Text color #1C3FCA is applied directly — consider defining it as a named color token for consistency."
`}
` : ""}

${allowedCategories.includes("ux_writing") ? `
SPECIAL INSTRUCTIONS FOR UX WRITING REVIEW:
- Scan ALL text content thoroughly
- Check EVERY button label, heading, paragraph, placeholder
- Look for typos, spelling errors, grammatical mistakes
- Be comprehensive - catch ALL text issues
` : ""}`;

      const dsPromptSection = dsContext ? `
═══ DESIGN SYSTEM CONTEXT ═══
This screen is built using a connected Design System. You have access to the full DS inventory. Your feedback MUST actively use this context.

DS INVENTORY:
- Components (${(dsContext.componentNames || []).length} total): ${(dsContext.componentNames || []).slice(0, 100).join(', ')}
- Icon components: ${(dsContext.iconNames || []).slice(0, 60).join(', ')}
- Color tokens (${(dsContext.colorTokenMap || dsContext.colorNames || []).length} total): ${
  (dsContext.colorTokenMap && dsContext.colorTokenMap.length > 0)
    ? dsContext.colorTokenMap.slice(0, 60).map((t: any) => `${t.name}=${t.hex}`).join(', ')
    : (dsContext.colorNames || []).slice(0, 60).join(', ')
}
- Text styles: ${(dsContext.textStyleMap && dsContext.textStyleMap.length > 0)
  ? dsContext.textStyleMap.slice(0, 30).map((t: any) => `${t.name}(${t.family} ${t.size}px ${t.weight})`).join(', ')
  : (dsContext.textStyleNames || []).slice(0, 30).join(', ')}
- Effect styles: ${(dsContext.effectStyleNames || []).slice(0, 10).join(', ')}
${dsContext.libraryNames?.length ? `- Libraries: ${dsContext.libraryNames.join(', ')}` : ""}

DS FEEDBACK RULES — apply to ALL categories, not just "design_system":
1. COMPONENT SUBSTITUTION: When a node appears to be a custom-built version of a DS component (matching shape, role, or pattern), flag it in "design_system" category. Name the exact DS component to use.
   Example suggestion: "Use DS component 'Button/Primary' instead of this custom frame — matches the shape and role exactly."
2. TOKEN DEVIATION (UI): ONLY flag color deviations on nodes that do NOT have a "fillStyleId" field. If a node has fillStyleId set, it is already using a DS color token — skip it.
   For nodes without fillStyleId: use the "hex" field in fills[] directly. Compare that hex to the DS COLOR TOKEN MAP and find the closest token.
   Example suggestion: "Replace fill #1C3FCA with DS color token 'Primary/Blue-700' [#1C40CA] — nearest brand color."
3. TEXT STYLE DEVIATION (UI): ONLY flag typography deviations on nodes that do NOT have a "textStyleId" field. If a node has textStyleId set, it is already using a DS text style — this is CORRECT usage, do NOT flag it.
   For nodes without textStyleId: check font family+size+weight against DS text styles.
   CRITICAL: If the node has textStyleId, it is 100% correct and must NOT be flagged — even if the font values seem unusual.
   Example suggestion: "Replace Inter 16px Regular with DS text style 'Body/M Regular' (Inter 16px Regular) — exact match."
4. CONSISTENCY VIA DS (Consistency): When the same UI pattern appears multiple times but one uses a DS component and another uses a custom frame — flag the inconsistency.
5. DS CORRECT USAGE: When a node has a textStyleId OR fillStyleId, it is using the DS correctly. Do NOT flag these as deviations.
6. ALWAYS be specific: cite exact DS token/style/component names AND their hex/size/weight values in every suggestion.

Use category "design_system" ONLY for structural component substitution issues. Use "ui" for token/style deviations.
` : '';


      const analysisPrompt = isCustom
        ? `${baseContext}\n\n${dsPromptSection}\n\nUser's specific request: ${prompt}\n${formatInstructions}`
        : `${baseContext}\n\n${dsPromptSection}\n\n${prompt}\n${formatInstructions}`;

      const promptTokens = estimateTokens(analysisPrompt + systemPrompt);
      console.log(`Chunk ${chunkIdx + 1} prompt tokens: ~${promptTokens}`);

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: analysisPrompt },
          ],
          max_tokens: 16000,
          temperature: 0,
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error(`AI API error on chunk ${chunkIdx + 1}:`, errorText);

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
