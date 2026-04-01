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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function flattenDesignData(nodes: any[], maxDepth = 8): any[] {
  const flat: any[] = [];

  function traverse(node: any, path: string, depth: number) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    const displayLabel = node.characters?.trim() || node.name || node.type || "unknown";
    const currentPath = path ? `${path} > ${displayLabel}` : displayLabel;

    const simplified: any = {
      id: node.id,
      name: node.name,
      type: node.type,
      path: currentPath,
    };

    if (node.characters) simplified.text = node.characters;

    if (node.fills && Array.isArray(node.fills) && node.fills.length > 0) {
      simplified.fills = node.fills.map((f: any) => {
        const hex = f.color
          ? `#${Math.round(f.color.r * 255).toString(16).padStart(2, "0")}${Math.round(f.color.g * 255).toString(16).padStart(2, "0")}${Math.round(f.color.b * 255).toString(16).padStart(2, "0")}`
          : undefined;
        return {
          type: f.type,
          color: f.color
            ? `rgba(${Math.round(f.color.r * 255)},${Math.round(f.color.g * 255)},${Math.round(f.color.b * 255)},${f.color.a ?? 1})`
            : undefined,
          hex,
        };
      });
    }

    if (node.fontSize) simplified.fontSize = node.fontSize;
    if (node.fontName) simplified.fontName = node.fontName;
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
      simplified.padding = {
        l: node.paddingLeft,
        t: node.paddingTop,
        r: node.paddingRight,
        b: node.paddingBottom,
      };
    }

    if (node.x !== undefined) simplified.x = Math.round(node.x);
    if (node.y !== undefined) simplified.y = Math.round(node.y);

    if (node.absoluteBoundingBox) {
      simplified.size = { w: node.absoluteBoundingBox.width, h: node.absoluteBoundingBox.height };
    } else if (node.width !== undefined) {
      simplified.size = { w: node.width, h: node.height };
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

async function storeChunks(supabaseUrl: string, serviceRoleKey: string, jobId: string, chunks: any[][]) {
  for (let i = 0; i < chunks.length; i++) {
    await fetch(`${supabaseUrl}/rest/v1/analysis_chunks`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
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

async function updateChunkStatus(
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
  chunkIndex: number,
  status: string,
  result?: any
) {
  await fetch(
    `${supabaseUrl}/rest/v1/analysis_chunks?job_id=eq.${jobId}&chunk_index=eq.${chunkIndex}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status, ...(result ? { result } : {}) }),
    }
  );
}

async function cleanupChunks(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  await fetch(`${supabaseUrl}/rest/v1/analysis_chunks?job_id=eq.${jobId}`, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Lightweight usage-tracking-only calls
    if (body._trackOnly) {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/plugin_usage`, {
            method: "POST",
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              user_name: body.fileName || "unknown",
              action: body.action || "a11y_contrast",
              node_count: body.nodeCount || 0,
              category_count: 1,
            }),
          });
        } catch (e) {
          /* ignore */
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { designData, prompt, categories, isCustom, fileName, pageName, ignoreChrome, dsContext } =
      body;

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

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!designData || designData.length === 0)
      throw new Error("No design data provided. Please select a frame in Figma.");

    // Flatten + chunk
    const flatNodes = flattenDesignData(designData);
    console.log("Flattened to", flatNodes.length, "nodes");
    console.log("Estimated total tokens:", estimateTokens(JSON.stringify(flatNodes)));

    const TOKEN_LIMIT = 80000;
    const chunks = chunkByTokens(flatNodes, TOKEN_LIMIT);
    const isChunked = chunks.length > 1;
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`Split into ${chunks.length} chunk(s)`);

    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await storeChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunks);
      } catch (e) {
        console.error("Error storing chunk records:", e);
      }
    }

    // Category setup — DS-independent, no design_system category
    let allowedCategories = categories || ["ux", "ui", "consistency"];
    if (isCustom) {
      allowedCategories = ["ux", "ui", "consistency", "ux_writing", "high_level", "improvement"];
    }

    const categoryOptions = allowedCategories.map((c: string) => `"${c}"`).join(" | ");

    // ─── SYSTEM PROMPT (restored from original high-quality version) ───
    const systemPrompt = `You are an expert UX/UI designer, acting as a manager and reviewer for a designer who lacks attention to detail.
You provide thorough, quality feedback - focus on real issues that matter.
CRITICAL: You MUST respond with ONLY a valid JSON array, no other text. 
Do not include markdown code blocks, explanations, or any text outside the JSON array.
Start your response with [ and end with ].`;

    let allFeedback: FeedbackItem[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkLabel = isChunked ? ` (chunk ${chunkIdx + 1}/${chunks.length})` : "";
      console.log(
        `Processing${chunkLabel}: ${chunk.length} nodes, ~${estimateTokens(JSON.stringify(chunk))} tokens`
      );

      const itemsPerCategory = isChunked ? Math.max(3, Math.floor(10 / chunks.length)) : 10;
      const designContext = JSON.stringify(chunk, null, 2);

      // ─── BASE REVIEW PROMPT — restored original high-quality structure ───
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
- Focus on GLARING, significant issues first — broken layouts, wrong colours, obvious typos, major hierarchy problems, missing states, poor contrast
- Do NOT flag minor nitpicks, slight spacing differences, or subjective style preferences
- Prioritise issues that would embarrass the designer in a stakeholder review
- Read EVERY text field character by character for typos and casing issues
- Check fills[].hex values for obvious colour problems (wrong brand colours, poor contrast, jarring combinations)
- Compare fontSize values across text nodes for clear hierarchy violations

Format as JSON array:
[{
  "category": ${categoryOptions},
  "title": "Issue title (clean, no IDs)",
  "description": "Detailed description with the actual text/hex/size value from the data (clean, no IDs)",
  "suggestion": "Specific actionable fix",
  "severity": "low" | "medium" | "high",
  "location": "User-friendly component name",
  "nodeId": "exact_node_id"
}]

CRITICAL: 
- NEVER include technical IDs in title or description
- Always include nodeId with exact ID from design data
- Location must be user-friendly names only
- NEVER fabricate issues — only flag what is directly observable in the data
- Before flagging a missing label: check every child node in that subtree first

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
` : ""}

${allowedCategories.includes("ux_writing") ? `
SPECIAL INSTRUCTIONS FOR UX WRITING REVIEW:
- Scan ALL text content thoroughly
- Check EVERY button label, heading, paragraph, placeholder
- Look for typos, spelling errors, grammatical mistakes
- Be comprehensive - catch ALL text issues
` : ""}`;

      const baseReviewPrompt = isCustom
        ? `${baseContext}\n\nUser's specific request: ${prompt}\n${formatInstructions}`
        : `${baseContext}\n\n${prompt}\n${formatInstructions}`;

      // DS layer disabled — reviews are independent of any design system
      const analysisPrompt = baseReviewPrompt;

      const promptTokens = estimateTokens(analysisPrompt + systemPrompt);
      console.log(`Chunk ${chunkIdx + 1} prompt tokens: ~${promptTokens}`);

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: analysisPrompt },
          ],
          max_tokens: 16000,
          temperature: 0,
          seed: 42,
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error(`AI API error on chunk ${chunkIdx + 1}:`, errorText);

        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "failed");
          } catch (e) {
            /* ignore */
          }
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
        // Strip markdown code fences
        if (cleanContent.startsWith("```json")) cleanContent = cleanContent.slice(7);
        else if (cleanContent.startsWith("```")) cleanContent = cleanContent.slice(3);
        if (cleanContent.endsWith("```")) cleanContent = cleanContent.slice(0, -3);
        cleanContent = cleanContent.trim();

        // Attempt 1: direct parse
        let chunkFeedback: FeedbackItem[] | null = null;
        try {
          const parsed = JSON.parse(cleanContent);
          if (Array.isArray(parsed)) chunkFeedback = parsed;
        } catch (_) {
          // fall through to repair
        }

        // Attempt 2: repair truncated JSON — find last complete object ending with }
        if (!chunkFeedback) {
          console.warn(`Chunk ${chunkIdx + 1}: direct parse failed, attempting JSON repair...`);
          // Find the last "}" that ends a complete top-level object in the array
          const lastBrace = cleanContent.lastIndexOf("}");
          if (lastBrace !== -1) {
            const repaired = cleanContent.slice(0, lastBrace + 1) + "]";
            // Find the opening bracket
            const openBracket = repaired.indexOf("[");
            const repairedSliced = openBracket !== -1 ? repaired.slice(openBracket) : repaired;
            try {
              const parsed = JSON.parse(repairedSliced);
              if (Array.isArray(parsed)) {
                chunkFeedback = parsed;
                console.log(`Chunk ${chunkIdx + 1}: repaired JSON, recovered ${parsed.length} items`);
              }
            } catch (_) {
              // repair also failed
            }
          }
        }

        // Attempt 3: extract all complete JSON objects from the string using regex
        if (!chunkFeedback) {
          console.warn(`Chunk ${chunkIdx + 1}: repair failed, attempting object extraction...`);
          const extracted: FeedbackItem[] = [];
          // Match top-level objects (simple heuristic: split by "},\n  {" pattern)
          const objectPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
          let match;
          while ((match = objectPattern.exec(cleanContent)) !== null) {
            try {
              const obj = JSON.parse(match[0]);
              if (obj && obj.category && obj.title) extracted.push(obj);
            } catch (_) { /* skip malformed */ }
          }
          if (extracted.length > 0) {
            chunkFeedback = extracted;
            console.log(`Chunk ${chunkIdx + 1}: extracted ${extracted.length} objects`);
          }
        }

        if (!chunkFeedback || chunkFeedback.length === 0) {
          console.error(`Chunk ${chunkIdx + 1}: all parse attempts failed. Raw content (first 500 chars):`, cleanContent.slice(0, 500));
          throw new Error("Failed to parse AI analysis results after all recovery attempts");
        }

        allFeedback.push(...chunkFeedback);
        console.log(`Chunk ${chunkIdx + 1}: got ${chunkFeedback.length} feedback items`);

        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "completed", {
              count: chunkFeedback.length,
            });
          } catch (e) {
            /* ignore */
          }
        }
      } catch (parseError) {
        console.error(`Failed to parse chunk ${chunkIdx + 1}:`, parseError);
        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            await updateChunkStatus(
              SUPABASE_URL,
              SUPABASE_SERVICE_ROLE_KEY,
              jobId,
              chunkIdx,
              "parse_error"
            );
          } catch (e) {
            /* ignore */
          }
        }
        if (!isChunked) throw parseError;
        continue;
      }
    }

    // Cleanup
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await cleanupChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId);
      } catch (e) {
        console.error("Error cleaning up chunks:", e);
      }
    }

    const categoryCount: Record<string, number> = {};
    allFeedback.forEach((item) => {
      const cat = item.category || "general";
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
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
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
      high: feedback.filter((f) => f.severity === "high").length,
      medium: feedback.filter((f) => f.severity === "medium").length,
      low: feedback.filter((f) => f.severity === "low").length,
      byCategory: categoryCount,
    };

    return new Response(JSON.stringify({ success: true, feedback, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Error in analyze-plugin:", error);
    const errorMessage = error instanceof Error ? error.message : "Analysis failed";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
