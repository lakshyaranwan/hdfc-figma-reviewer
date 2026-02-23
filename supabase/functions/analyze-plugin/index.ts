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

// Helper to estimate token count
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Chunk design data into smaller groups
function chunkDesignData(designData: any[], maxTokens: number): any[][] {
  const fullJson = JSON.stringify(designData, null, 2);
  const totalTokens = estimateTokens(fullJson);

  if (totalTokens <= maxTokens) {
    return [designData];
  }

  const ratio = totalTokens / maxTokens;
  const numChunks = Math.ceil(ratio);
  const chunkSize = Math.ceil(designData.length / numChunks);

  const chunks: any[][] = [];
  for (let i = 0; i < designData.length; i += chunkSize) {
    chunks.push(designData.slice(i, i + chunkSize));
  }
  return chunks;
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
    const { designData, prompt, categories, isCustom, fileName, pageName } = await req.json();
    
    console.log("Analyzing design from plugin");
    console.log("File:", fileName);
    console.log("Page:", pageName);
    console.log("Nodes to analyze:", designData?.length || 0);
    console.log("Categories:", categories);
    console.log("Is custom prompt:", isCustom);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    if (!designData || designData.length === 0) {
      throw new Error("No design data provided. Please select a frame in Figma.");
    }

    // Chunk design data if too large
    const TOKEN_LIMIT = 12000;
    const chunks = chunkDesignData(designData, TOKEN_LIMIT);
    const isChunked = chunks.length > 1;
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (isChunked) {
      console.log(`Design data too large. Split into ${chunks.length} chunks.`);
    }

    // Store chunks in DB for tracking
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await storeChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunks);
        console.log(`Stored ${chunks.length} chunk records (job: ${jobId})`);
      } catch (e) {
        console.error("Error storing chunk records:", e);
      }
    }

    // Category setup (shared across chunks)
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

    const categoryOptions = allowedCategories.map((c: string) => `"${c}"`).join(" | ");

    const systemPrompt = `You are an expert UX/UI designer, acting as a manager and reviewer for a designer who lacks attention to detail.
You provide thorough, quality feedback - focus on real issues that matter.
CRITICAL: You MUST respond with ONLY a valid JSON array, no other text. 
Do not include markdown code blocks, explanations, or any text outside the JSON array.
Start your response with [ and end with ].`;

    // Process each chunk
    let allFeedback: FeedbackItem[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkLabel = isChunked ? ` (chunk ${chunkIdx + 1}/${chunks.length})` : "";
      console.log(`Processing${chunkLabel}: ${chunk.length} nodes...`);

      const itemsPerCategory = isChunked
        ? Math.max(3, Math.floor(10 / chunks.length))
        : 10;

      const designContext = JSON.stringify(chunk, null, 2);

      const baseContext = `I am a UI UX designer who lacks attention to details and makes mistakes. You are a UX/UI expert, my manager and my reviewer, analyzing my Figma designs.

Design Structure from Figma Plugin${chunkLabel} (with node IDs):
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

      const analysisPrompt = isCustom
        ? `${baseContext}\n\nUser's specific request: ${prompt}\n${formatInstructions}`
        : `${baseContext}\n\n${prompt}\n${formatInstructions}`;

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

        // If 400 (token limit) on a chunk, skip and continue
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

      // Parse chunk feedback
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

    // Clean up chunk records from DB
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await cleanupChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId);
        console.log(`Cleaned up chunk records for job: ${jobId}`);
      } catch (e) {
        console.error("Error cleaning up chunks:", e);
      }
    }

    // Count items per category
    const categoryCount: Record<string, number> = {};
    allFeedback.forEach(item => {
      const cat = item.category || 'general';
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    });

    // Re-index feedback IDs
    const feedback = allFeedback.map((item, index) => ({
      ...item,
      id: `feedback-${index}-${Date.now()}`,
    }));

    console.log(`Analysis complete: ${feedback.length} feedback items`);
    console.log("Category distribution:", categoryCount);

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
