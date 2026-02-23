import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper function to fetch with retry logic for rate limits
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      lastResponse = response;
      
      if (response.status === 403 || response.status === 401) {
        return response;
      }
      
      if (response.status === 429) {
        if (attempt < maxRetries - 1) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.log(`Rate limited (attempt ${attempt + 1}/${maxRetries}). Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        } else {
          console.log(`Rate limit persists after ${maxRetries} attempts`);
          return response;
        }
      }
      
      return response;
    } catch (error) {
      lastError = error;
      console.error(`Fetch attempt ${attempt + 1} failed:`, error);
      if (attempt < maxRetries - 1) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  if (lastResponse) {
    return lastResponse;
  }
  
  throw lastError || new Error('Max retries exceeded');
}

interface FeedbackItem {
  id: string;
  category: "ux" | "ui" | "consistency" | "improvement" | "accessibility" | "design_system" | "ux_writing" | "high_level";
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  location?: string;
  nodeId?: string;
}

// Helper to estimate token count from a string
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Helper to chunk nodes into smaller groups
function chunkNodes(canvasData: { name: string; nodes: any[] }, maxTokens: number): Array<{ name: string; nodes: any[] }> {
  const fullJson = JSON.stringify(canvasData, null, 2);
  const totalTokens = estimateTokens(fullJson);
  
  if (totalTokens <= maxTokens) {
    return [canvasData];
  }
  
  // Calculate how many chunks we need
  const ratio = totalTokens / maxTokens;
  const numChunks = Math.ceil(ratio);
  const chunkSize = Math.ceil(canvasData.nodes.length / numChunks);
  
  const chunks: Array<{ name: string; nodes: any[] }> = [];
  for (let i = 0; i < canvasData.nodes.length; i += chunkSize) {
    chunks.push({
      name: canvasData.name,
      nodes: canvasData.nodes.slice(i, i + chunkSize),
    });
  }
  
  return chunks;
}

// Helper to store chunk records in DB
async function storeChunks(supabaseUrl: string, serviceRoleKey: string, jobId: string, chunks: any[]) {
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
        chunk_data: { nodeCount: chunks[i].nodes.length },
        status: "pending",
      }),
    });
  }
}

// Helper to update a chunk's status in DB
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

// Helper to delete all chunk records for a job
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
    const { fileKey, nodeId, customPrompt, includeSuggestions = true, figmaApiKey } = await req.json();
    console.log("Analyzing Figma file:", fileKey);
    console.log("Target node:", nodeId || "entire file");
    console.log("Custom prompt provided:", !!customPrompt);
    console.log("Include suggestions:", includeSuggestions);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    // Fetch selected AI model from settings
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

    const FIGMA_TOKEN = figmaApiKey || Deno.env.get("FIGMA_ACCESS_TOKEN");

    if (!FIGMA_TOKEN) {
      throw new Error("FIGMA_ACCESS_TOKEN not configured. Please add your Figma API key in Settings.");
    }

    // Step 1: Fetch Figma file data (specific node or entire file)
    console.log("Fetching Figma file data...");
    let figmaUrl = `https://api.figma.com/v1/files/${fileKey}`;
    let figmaData;
    let targetData;

    if (nodeId) {
      console.log("Fetching specific node:", nodeId);
      figmaUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;

      const figmaResponse = await fetchWithRetry(figmaUrl, {
        headers: { "X-Figma-Token": FIGMA_TOKEN },
      });

      if (!figmaResponse.ok) {
        const errorText = await figmaResponse.text();
        console.error("Figma API error:", errorText);
        
        if (figmaResponse.status === 403 || figmaResponse.status === 401) {
          return new Response(
            JSON.stringify({ error: "Invalid or expired Figma API key. Please update your API key in Settings." }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        if (figmaResponse.status === 429) {
          return new Response(
            JSON.stringify({ error: "Figma API rate limit exceeded after retries. Please wait 5-10 minutes before trying again." }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        throw new Error(`Failed to fetch Figma node: ${figmaResponse.status}`);
      }

      figmaData = await figmaResponse.json();
      const nodeData = figmaData.nodes?.[nodeId];
      if (!nodeData || !nodeData.document) {
        throw new Error(`Node ${nodeId} not found in file`);
      }
      targetData = nodeData.document;
      console.log("Analyzing specific node:", targetData.name);
    } else {
      console.log("Fetching entire file");
      const figmaResponse = await fetchWithRetry(figmaUrl, {
        headers: { "X-Figma-Token": FIGMA_TOKEN },
      });

      if (!figmaResponse.ok) {
        const errorText = await figmaResponse.text();
        console.error("Figma API error:", errorText);
        
        if (figmaResponse.status === 403 || figmaResponse.status === 401) {
          return new Response(
            JSON.stringify({ error: "Invalid or expired Figma API key. Please update your API key in Settings." }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        if (figmaResponse.status === 429) {
          return new Response(
            JSON.stringify({ error: "Figma API rate limit exceeded after retries. Please wait 5-10 minutes before trying again." }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        throw new Error(`Failed to fetch Figma file: ${figmaResponse.status}`);
      }

      figmaData = await figmaResponse.json();
      targetData = figmaData.document;
      console.log("Analyzing entire file");
    }

    const canvasData = extractCanvasData(targetData);
    console.log("Canvas data extracted, node count:", canvasData.nodes.length);

    // Step 2: Chunk data if too large for AI token limits
    const TOKEN_LIMIT = 12000;
    const chunks = chunkNodes(canvasData, TOKEN_LIMIT);
    const isChunked = chunks.length > 1;
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (isChunked) {
      console.log(`Data exceeds token limit. Split into ${chunks.length} chunks.`);
    }

    // Store chunks in DB for tracking (only when chunking)
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await storeChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunks);
        console.log(`Stored ${chunks.length} chunk records (job: ${jobId})`);
      } catch (e) {
        console.error("Error storing chunk records:", e);
      }
    }

    // Step 3: Build category and format instructions (shared across chunks)
    const categoryMapping: Record<string, string> = {
      "consistency across flows regarding ui": "consistency",
      "ux review": "ux",
      "ui review": "ui",
      "accessibility issues": "accessibility",
      "design system adherence": "design_system",
      "typos & inconsistent ux writing": "ux_writing",
      "high level review about and the why? questioning the basics.": "high_level",
    };

    let allowedCategories = ["ux", "ui", "consistency", "improvement"];
    if (customPrompt && customPrompt.includes("Provide me feedback on the following areas:")) {
      const areasText = customPrompt.split("Provide me feedback on the following areas:")[1];
      const categoriesOnly = areasText.split(/\. For each issue|\.$/)[0];
      const selectedAreas = categoriesOnly
        .toLowerCase()
        .split(",")
        .map((s: string) => s.trim());
      allowedCategories = selectedAreas
        .map((area: string) => categoryMapping[area] || area)
        .filter((cat: string) => cat);
      console.log("Filtered to categories:", allowedCategories);
    }

    const categoryOptions = allowedCategories.map((c: string) => `"${c}"`).join(" | ");

    // Store usage info helper
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

    // Step 4: Process each chunk with AI
    console.log(`Processing ${chunks.length} chunk(s) with AI model: ${selectedModel}`);
    let allFeedback: FeedbackItem[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkLabel = isChunked ? ` (chunk ${chunkIdx + 1}/${chunks.length})` : "";
      console.log(`Processing${chunkLabel}: ${chunk.nodes.length} nodes...`);

      // Adjust expected items per category based on chunk count
      const itemsPerCategory = isChunked 
        ? Math.max(3, Math.floor(8 / chunks.length))
        : Math.floor(80 / allowedCategories.length);

      const baseContext = `I am a UI UX designer who lacks attention to details and makes mistakes. You are a UX/UI expert, my manager and my reviewer, analyzing my Figma designs. Analyze the following design data and provide detailed feedback.

Design Structure${chunkLabel} (node hierarchy with IDs - USE THESE EXACT IDs):
${JSON.stringify(chunk, null, 2)}

CRITICAL NODE ID INSTRUCTIONS:
- You MUST use the EXACT node IDs from the list above
- Choose the MOST SPECIFIC node ID for each piece of feedback
- For a button issue, use the button's node ID, NOT its parent frame
- For a text issue, use the text layer's node ID, NOT the containing group
- The more specific the node, the better the comment placement will be`;

      const formatInstructions = `
For each issue found, provide:
- A clear, actionable title (NO technical IDs or brackets - keep it human-readable)
- Detailed description of the issue${includeSuggestions ? " AND specific actionable suggestions on how to fix it" : ""} (NO technical IDs in the description)
- Severity (low, medium, high)
- The EXACT node ID from the structure above for the specific element this feedback applies to
- Component/frame name (user-friendly name only, NO technical IDs)

CRITICAL CATEGORY RESTRICTION: You MUST ONLY provide feedback for these categories: ${allowedCategories.join(", ")}
Only use these exact category values: ${categoryOptions}

CRITICAL BALANCE REQUIREMENT: Provide feedback distributed across ALL requested categories.
- Provide ${itemsPerCategory} feedback items for EACH category requested
- Do NOT skip any category

Format your response as a JSON array:
[{
  "category": ${categoryOptions},
  "title": "Issue title (clean, no IDs)",
  "description": "Detailed description${includeSuggestions ? " with specific suggestions" : ""} (clean, no IDs)",
  "severity": "low" | "medium" | "high",
  "location": "User-friendly component name",
  "nodeId": "exact_node_id_from_structure"
}]

CRITICAL: 
- NEVER include technical IDs like [123:456] in title or description
- Always include the nodeId field with the exact ID from the design structure
- For the location field, use ONLY user-friendly, descriptive names
${includeSuggestions ? "- For EACH issue, include specific, actionable suggestions" : ""}

${allowedCategories.includes("consistency") ? `
SPECIAL INSTRUCTIONS FOR CONSISTENCY REVIEW:
- Compare ALL screens/pages/flows for inconsistent patterns
- Look for text variations across similar elements
- Check for inconsistent heading styles, button labels, spacing
- Flag ALL instances of inconsistency
` : ""}

${allowedCategories.includes("ux_writing") ? `
SPECIAL INSTRUCTIONS FOR UX WRITING REVIEW:
- Scan ALL text content thoroughly
- Check EVERY button label, heading, paragraph, placeholder
- Look for typos, spelling errors, grammatical mistakes
- Identify inconsistent terminology
- Be comprehensive - catch ALL text issues
` : ""}`;

      const analysisPrompt = customPrompt
        ? `${baseContext}\n\nUser's specific request: ${customPrompt}\n${formatInstructions}`
        : `${baseContext}\n\nProvide feedback in these categories:\n1. UX Issues - Navigation flows, user interactions, usability problems\n2. UI Issues - Visual design, typography, spacing, color usage\n3. Consistency Issues - Design pattern violations, inconsistent components\n4. Improvement Suggestions - Ways to enhance the design\n${formatInstructions}`;

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            {
              role: "system",
              content: "You are an expert UX/UI designer providing professional design feedback. CRITICAL: You MUST respond with ONLY a valid JSON array, no other text. Do not include markdown code blocks, explanations, or any text outside the JSON array. Start your response with [ and end with ].",
            },
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

        // Update chunk status to failed
        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "failed");
          } catch (e) { /* ignore */ }
        }

        // If it's a 400 (token limit), skip this chunk and continue with others
        if (aiResponse.status === 400 && isChunked) {
          console.warn(`Chunk ${chunkIdx + 1} hit token limit, skipping...`);
          continue;
        }

        throw new Error(`AI analysis failed: ${aiResponse.status}`);
      }

      await storeUsageInfo("available", aiResponse.headers);
      const aiData = await aiResponse.json();

      // Parse chunk feedback
      try {
        const content = aiData.choices[0].message.content;
        if (!content || content.trim() === "") {
          console.error(`Empty AI response for chunk ${chunkIdx + 1}`);
          if (isChunked) continue;
          throw new Error("AI response was empty.");
        }

        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\[[\s\S]*\]/);
        const jsonContent = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
        
        const chunkFeedback: FeedbackItem[] = JSON.parse(jsonContent);
        if (!Array.isArray(chunkFeedback)) {
          throw new Error("AI response is not an array");
        }

        allFeedback.push(...chunkFeedback);
        console.log(`Chunk ${chunkIdx + 1}: got ${chunkFeedback.length} feedback items`);

        // Update chunk status to completed
        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "completed", { count: chunkFeedback.length });
          } catch (e) { /* ignore */ }
        }
      } catch (parseError) {
        console.error(`Failed to parse chunk ${chunkIdx + 1}:`, parseError);
        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "parse_error");
          } catch (e) { /* ignore */ }
        }
        if (!isChunked) {
          throw new Error(`Failed to parse AI feedback: ${parseError instanceof Error ? parseError.message : "Unknown parsing error"}`);
        }
        // If chunked, skip this chunk and continue
        continue;
      }
    }

    // Step 5: Clean up chunk records from DB
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await cleanupChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId);
        console.log(`Cleaned up chunk records for job: ${jobId}`);
      } catch (e) {
        console.error("Error cleaning up chunks:", e);
      }
    }

    // Re-index feedback IDs
    const feedback = allFeedback.map((item, index) => ({
      ...item,
      id: `feedback-${index}-${Date.now()}`,
    }));

    console.log("Total feedback items:", feedback.length);

    return new Response(
      JSON.stringify({ success: true, feedback }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in analyze-figma function:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

function extractCanvasData(document: any) {
  const nodes: Array<{
    id: string;
    name: string;
    type: string;
    path: string;
    text?: string;
  }> = [];

  function traverse(node: any, path: string = "") {
    if (!node) return;
    if (node.visible === false) return;

    const currentPath = path ? `${path} > ${node.name}` : node.name;

    if (node.type && node.id) {
      const nodeData: any = {
        id: node.id,
        name: node.name,
        type: node.type,
        path: currentPath,
      };

      if (node.type === "TEXT" && node.characters) {
        nodeData.text = node.characters;
      }

      nodes.push(nodeData);
    }

    if (node.children) {
      node.children.forEach((child: any) => traverse(child, currentPath));
    }
  }

  traverse(document);

  const textNodes = nodes.filter(n => n.type === "TEXT" && n.text);
  const otherNodes = nodes.filter(n => n.type !== "TEXT" || !n.text);
  const prioritizedNodes = [...textNodes, ...otherNodes].slice(0, 300);

  return {
    name: document.name,
    nodes: prioritizedNodes,
  };
}
