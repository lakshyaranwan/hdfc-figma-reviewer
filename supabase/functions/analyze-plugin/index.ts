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

    // Category setup
    let allowedCategories = categories || ["ux", "ui", "consistency"];
    if (isCustom) {
      allowedCategories = ["ux", "ui", "consistency", "ux_writing", "high_level", "improvement"];
    }
    if (dsContext && !allowedCategories.includes("design_system")) {
      allowedCategories.push("design_system");
    }

    const categoryOptions = allowedCategories.map((c: string) => `"${c}"`).join(" | ");

    // ─── SYSTEM PROMPT: always the same sharp reviewer persona ───
    const systemPrompt = `You are an expert UX/UI designer acting as a senior design manager reviewing a colleague's work.
You have an exceptionally sharp eye for detail: typos, inconsistent colors, misaligned elements, broken hierarchies, unclear labels, missing states, spacing issues.
You are direct, precise, and never skip real problems. You give specific, actionable feedback that names the exact element.
You NEVER report issues that do not exist in the data. Only flag real, observable problems backed by evidence in the design data.
CRITICAL: Respond with ONLY a valid JSON array. No markdown, no explanation, no text outside the array.
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

      // ─── BASE REVIEW PROMPT (always active, DS-independent) ───
      const baseReviewPrompt = `You are reviewing Figma design data as a senior UX/UI design manager.

DESIGN DATA${chunkLabel}:
${designContext}

File: ${fileName} | Page: ${pageName}

━━━ REVIEW MANDATE ━━━
Thoroughly review ALL elements. Produce ~${itemsPerCategory} issues per active category (total 30–60 for a full review).
Do NOT reduce output because a DS is attached — the core review must be complete regardless.

━━━ WHAT TO ALWAYS CHECK ━━━
1. TEXT — read every "text" field. Find typos, grammar errors, inconsistent casing, vague labels, ALL instances.
2. COLOUR — read every fills[].hex. Flag off-brand, low-contrast, or inconsistent colours.
3. HIERARCHY — compare fontSize values across headings and body text. Flag when sizes are too similar.
4. LABELS — if a button, field, or input has no readable label text node nearby, flag it.
5. ALIGNMENT — compare x/y/size values between sibling elements. Flag misalignment.
6. SPACING — compare padding values across similar components. Flag inconsistency.
7. CONSISTENCY — if two cards/buttons/chips serving the same purpose have different styles, flag both.
8. STATES — flag missing hover, disabled, loading, error, or empty states where logically expected.
9. VISUAL CLUTTER — flag elements competing for attention when they shouldn't.

━━━ FALSE POSITIVE PREVENTION (CRITICAL) ━━━
- ONLY report issues directly observable in the data above.
- If a label exists in the data (even nested), do NOT say it is missing. Read carefully.
- If colours are consistent, do NOT say they are inconsistent.
- Read text fields carefully before claiming a typo — confirm the error in the actual "text" value.
- NEVER invent or guess issues. Every issue must reference specific node IDs, values, or text from the data.

━━━ NODE ID RULES ━━━
Use the EXACT "id" value from each node for nodeId. Pick the most specific (deepest) relevant node.

${ignoreChrome
  ? `━━━ IGNORE CHROME ━━━
Skip: status bars, top nav bars, bottom nav bars, tab bars, headers, footers. Only review unique page content.
`
  : ""}

━━━ ACTIVE CATEGORIES (ONLY use these values) ━━━
${categoryOptions}

${
  allowedCategories.includes("consistency")
    ? `CONSISTENCY: Compare every repeated pattern — cards, buttons, chips, list items. Flag any that deviate from the dominant style.${dsContext ? " Also flag where the same DS component is used with inconsistent props across the screen." : ""}`
    : ""
}

${
  allowedCategories.includes("ux")
    ? `UX REVIEW: Evaluate user flows, task completion, CTA clarity, empty/error states, navigation logic, affordances, feedback loops.${dsContext ? " Flag where a DS component (bottom sheet, modal, toast) exists but a custom solution is used instead." : ""}`
    : ""
}

${
  allowedCategories.includes("ui")
    ? `UI REVIEW: Visual hierarchy, alignment, spacing, typography scale, colour application.
- Read EVERY fills[].hex. Flag colours that look wrong, off-brand, or inconsistent.
- Check fontSizes for hierarchy problems (body and heading same size = flag it).
${
  dsContext
    ? `- FALSE POSITIVE GUARD: nodes with "textStyleId" set are using DS text styles — do NOT flag those for typography deviation. Nodes with "fillStyleId" set are using DS colour tokens — do NOT flag for colour deviation.
- For nodes WITHOUT textStyleId/fillStyleId: check against DS token maps in the DS section below.`
    : ""
}`
    : ""
}

${
  allowedCategories.includes("ux_writing")
    ? `UX WRITING: Read every "text" field meticulously. Flag:
- Typos and spelling errors (check the actual text value, not the node name)
- Inconsistent capitalisation (e.g. "Submit" in one button vs "submit" in another)
- Unclear, vague, contradictory, or truncated labels
- Placeholder/lorem ipsum text left in production frames
Be exhaustive. Every text issue counts.`
    : ""
}

${
  allowedCategories.includes("high_level")
    ? `HIGH LEVEL: Question fundamentals — does this screen solve the right problem? Is the IA logical? Are there redundant steps or missing flows?`
    : ""
}

━━━ OUTPUT FORMAT ━━━
[{
  "category": ${categoryOptions},
  "title": "Short specific title naming the element (no node IDs)",
  "description": "What the problem is and why it matters — reference the actual text/hex/size value",
  "suggestion": "Exact fix with specific values, token names, or component names",
  "severity": "low" | "medium" | "high",
  "location": "Human-readable element name (no IDs)",
  "nodeId": "exact_id_from_data"
}]

RULES:
- NEVER put node IDs in title/description/location
- ALWAYS include nodeId with exact ID from design data
- NEVER fabricate issues not supported by the data`;

      // ─── DS ADDITIVE LAYER (injected AFTER base review, additive not replacing) ───
      const dsAuditSection = dsContext
        ? `

━━━ DESIGN SYSTEM AUDIT (ADDITIVE — run AFTER core review above) ━━━
A Design System is connected. After producing the full core review above, ALSO perform these DS-specific checks.
These are ADDITIONAL items on top of the core feedback. Do NOT reduce core UX/UI/writing feedback because of this section.

DS INVENTORY:
Components (${(dsContext.componentNames || []).length}): ${(dsContext.componentNames || []).slice(0, 80).join(", ")}
Colour tokens: ${
            dsContext.colorTokenMap && dsContext.colorTokenMap.length > 0
              ? dsContext.colorTokenMap
                  .slice(0, 60)
                  .map((t: any) => `${t.name}=${t.hex}`)
                  .join(", ")
              : (dsContext.colorNames || []).slice(0, 60).join(", ")
          }
Text styles: ${
            dsContext.textStyleMap && dsContext.textStyleMap.length > 0
              ? dsContext.textStyleMap
                  .slice(0, 25)
                  .map((t: any) => `${t.name}(${t.family} ${t.size}px ${t.weight})`)
                  .join(", ")
              : (dsContext.textStyleNames || []).slice(0, 25).join(", ")
          }
${dsContext.libraryNames?.length ? `Libraries: ${dsContext.libraryNames.join(", ")}` : ""}

DS AUDIT RULES:
1. COLOUR TOKENS — for nodes WITHOUT "fillStyleId": compare fills[].hex to the colour token map above.
   Find the closest token by colour distance. Flag as category "ui".
   Suggestion: "Replace #1C3FCA with DS colour token 'Primary/Blue-700' [#1C40CA] — nearest match."
   SKIP nodes that have "fillStyleId" set — they are already correct, do not flag them.

2. TEXT STYLES — for nodes WITHOUT "textStyleId": compare fontName+fontSize against DS text style map.
   Flag as "ui". Suggestion: "Replace Inter 16px Regular with DS text style 'Body/M Regular' — exact match."
   SKIP nodes that have "textStyleId" set — they are correct, do not flag them.

3. COMPONENT SUBSTITUTION — when a node looks like a custom-built version of a DS component (same shape/role/pattern), flag as "design_system".
   Suggestion: "Use DS component 'Button/Primary' instead of this custom frame — same shape and role."

4. DS CONSISTENCY — when the same element appears multiple times but one uses a DS component and another uses a custom frame, flag as "consistency".

CRITICAL: DS audit findings are additive. The core review items must still be present in full.`
        : "";

      const analysisPrompt = isCustom
        ? `${baseReviewPrompt}\n${dsAuditSection}\n\nAdditional focus requested by reviewer: ${prompt}`
        : `${baseReviewPrompt}\n${dsAuditSection}\n\n${prompt ? `Specific focus: ${prompt}` : ""}`;

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
        if (cleanContent.startsWith("```json")) cleanContent = cleanContent.slice(7);
        else if (cleanContent.startsWith("```")) cleanContent = cleanContent.slice(3);
        if (cleanContent.endsWith("```")) cleanContent = cleanContent.slice(0, -3);
        cleanContent = cleanContent.trim();

        const chunkFeedback: FeedbackItem[] = JSON.parse(cleanContent);
        if (!Array.isArray(chunkFeedback)) throw new Error("Response is not an array");

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
        if (!isChunked) throw new Error("Failed to parse AI analysis results");
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
