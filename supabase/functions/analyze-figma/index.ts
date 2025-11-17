import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface FeedbackItem {
  id: string;
  category: "ux" | "ui" | "consistency" | "improvement" | "accessibility" | "design_system" | "ux_writing" | "high_level";
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  location?: string;
  nodeId?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { fileKey, nodeId, customPrompt, includeSuggestions = true } = await req.json();
    console.log("Analyzing Figma file:", fileKey);
    console.log("Target node:", nodeId || "entire file");
    console.log("Custom prompt provided:", !!customPrompt);
    console.log("Include suggestions:", includeSuggestions);

    const GLOBAL_FIGMA_TOKEN = Deno.env.get("FIGMA_ACCESS_TOKEN");
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    // Get the authorization header to identify the user
    const authHeader = req.headers.get("Authorization");
    let FIGMA_TOKEN = GLOBAL_FIGMA_TOKEN;

    // If user is authenticated, try to get their personal API key
    if (authHeader) {
      try {
        const supabaseClient = createClient(
          Deno.env.get("SUPABASE_URL") ?? "",
          Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user } } = await supabaseClient.auth.getUser();
        
        if (user) {
          const { data: apiKeyData } = await supabaseClient
            .from("user_api_keys")
            .select("figma_api_key")
            .eq("user_id", user.id)
            .maybeSingle();

          if (apiKeyData?.figma_api_key) {
            FIGMA_TOKEN = apiKeyData.figma_api_key;
            console.log("Using user's personal Figma API key");
          }
        }
      } catch (error) {
        console.error("Error fetching user API key:", error);
        // Fall back to global token
      }
    }

    if (!FIGMA_TOKEN) {
      throw new Error("FIGMA_ACCESS_TOKEN not configured. Please add your Figma API key in Settings.");
    }

    // Step 1: Fetch Figma file data (specific node or entire file)
    console.log("Fetching Figma file data...");
    console.log("File key:", fileKey);
    console.log("Node ID:", nodeId || "entire file");

    let figmaUrl = `https://api.figma.com/v1/files/${fileKey}`;
    let figmaData;
    let targetData;

    if (nodeId) {
      // Fetch specific node
      console.log("Fetching specific node:", nodeId);
      figmaUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;

      const figmaResponse = await fetch(figmaUrl, {
        headers: {
          "X-Figma-Token": FIGMA_TOKEN,
        },
      });

      if (!figmaResponse.ok) {
        const errorText = await figmaResponse.text();
        console.error("Figma API error:", errorText);
        throw new Error(`Failed to fetch Figma node: ${figmaResponse.status}`);
      }

      figmaData = await figmaResponse.json();

      // Extract the specific node data
      const nodeData = figmaData.nodes?.[nodeId];
      if (!nodeData || !nodeData.document) {
        console.error("Node data:", figmaData);
        throw new Error(`Node ${nodeId} not found in file`);
      }

      targetData = nodeData.document;
      console.log("Analyzing specific node:", targetData.name);
    } else {
      // Fetch entire file
      console.log("Fetching entire file");
      const figmaResponse = await fetch(figmaUrl, {
        headers: {
          "X-Figma-Token": FIGMA_TOKEN,
        },
      });

      if (!figmaResponse.ok) {
        const errorText = await figmaResponse.text();
        console.error("Figma API error:", errorText);
        throw new Error(`Failed to fetch Figma file: ${figmaResponse.status}`);
      }

      figmaData = await figmaResponse.json();
      targetData = figmaData.document;
      console.log("Analyzing entire file");
    }

    const canvasData = extractCanvasData(targetData);
    console.log("Canvas data extracted, node count:", canvasData.nodes.length);

    // Step 3: Analyze with Gemini AI
    console.log("Sending to AI for analysis...");

    const baseContext = `I am a UI UX designer who lacks attention to details and makes mistakes. You are a UX/UI expert, my manager and my reviewer, analyzing my Figma designs. Analyze the following design data and provide detailed feedback.

Design Structure (complete node hierarchy with IDs - USE THESE EXACT IDs):
${JSON.stringify(canvasData, null, 2)}

CRITICAL NODE ID INSTRUCTIONS:
- You MUST use the EXACT node IDs from the list above
- Choose the MOST SPECIFIC node ID for each piece of feedback
- For a button issue, use the button's node ID, NOT its parent frame
- For a text issue, use the text layer's node ID, NOT the containing group
- The more specific the node, the better the comment placement will be

Example: If you're giving feedback about a "Login Button", find the exact node ID for that button in the structure above (e.g., "123:456"), not the page frame (e.g., "9:1").`;

    // Map category labels to category IDs (case-insensitive)
    const categoryMapping: Record<string, string> = {
      "consistency across flows regarding ui": "consistency",
      "ux review": "ux",
      "ui review": "ui",
      "accessibility issues": "accessibility",
      "design system adherence": "design_system",
      "typos & inconsistent ux writing": "ux_writing",
      "high level review about and the why? questioning the basics.": "high_level",
    };

    // Extract selected categories from customPrompt
    let allowedCategories = ["ux", "ui", "consistency", "improvement"];
    if (customPrompt && customPrompt.includes("Provide me feedback on the following areas:")) {
      const areasText = customPrompt.split("Provide me feedback on the following areas:")[1];
      // Split only up to the first period (to avoid parsing the suggestions instruction)
      const categoriesOnly = areasText.split(/\. For each issue|\.$/)[0];
      const selectedAreas = categoriesOnly
        .toLowerCase()
        .split(",")
        .map((s: string) => s.trim());
      allowedCategories = selectedAreas
        .map((area: string) => categoryMapping[area] || area)
        .filter((cat: string) => cat);
      console.log("Selected areas from prompt:", selectedAreas);
      console.log("Filtered to categories:", allowedCategories);
    }

    const categoryOptions = allowedCategories.map((c: string) => `"${c}"`).join(" | ");

    const formatInstructions = `
For each issue found, provide:
- A clear, actionable title (NO technical IDs or brackets - keep it human-readable)
- Detailed description of the issue${includeSuggestions ? " AND specific actionable suggestions on how to fix it" : ""} (NO technical IDs in the description)
- Severity (low, medium, high)
- The EXACT node ID from the structure above for the specific element this feedback applies to
- Component/frame name (user-friendly name only, NO technical IDs like "9:123" - use descriptive names like "Login Button" or "Header Navigation")

CRITICAL CATEGORY RESTRICTION: You MUST ONLY provide feedback for these categories: ${allowedCategories.join(", ")}
Do NOT provide feedback for any other categories. Only use these exact category values: ${categoryOptions}

CRITICAL BALANCE REQUIREMENT: You MUST provide feedback EVENLY distributed across ALL requested categories.
- Provide 8-12 feedback items for EACH category requested
- Do NOT skip any category
- Do NOT heavily favor one category over others
- If analyzing ${allowedCategories.length} categories, aim for approximately ${Math.floor(80 / allowedCategories.length)} items per category

Format your response as a JSON array of feedback items with this structure:
[{
  "category": ${categoryOptions},
  "title": "Issue title (clean, no IDs)",
  "description": "Detailed description${includeSuggestions ? " with specific suggestions" : ""} (clean, no IDs)",
  "severity": "low" | "medium" | "high",
  "location": "User-friendly component name (e.g., 'Login Button', 'Navigation Bar')",
  "nodeId": "exact_node_id_from_structure"
}]

CRITICAL: 
- NEVER include technical IDs like [123:456] or (9:123) in title or description
- Always include the nodeId field with the exact ID from the design structure for technical purposes
- For the location field, use ONLY user-friendly, descriptive names - NO technical node IDs
- Keep all user-facing text clean and readable
- ONLY provide feedback for the requested categories: ${allowedCategories.join(", ")}
${includeSuggestions ? "- For EACH issue, include specific, actionable suggestions on how to fix it in the description" : ""}
- Example good title: "Improve button contrast for accessibility"
- Example bad title: "Improve button [123:456] contrast for accessibility"

${allowedCategories.includes("consistency") ? `
SPECIAL INSTRUCTIONS FOR CONSISTENCY REVIEW:
- Compare ALL screens/pages/flows for inconsistent patterns
- Look for text variations across similar elements (e.g., "Send Money" vs "Send Money2", "Sign In" vs "Login")
- Check for inconsistent heading styles, button labels, spacing, and component usage
- Identify any naming inconsistencies that appear to be mistakes or typos
- Compare similar UI patterns across different screens for visual consistency
- Flag ALL instances where the same element has different names, styles, or behaviors across screens
` : ""}

${allowedCategories.includes("ux_writing") ? `
SPECIAL INSTRUCTIONS FOR UX WRITING REVIEW:
- Scan ALL text content in the design thoroughly
- Check EVERY button label, heading, paragraph, placeholder text, and microcopy
- Look for typos, spelling errors, grammatical mistakes, and inconsistent capitalization
- Identify inconsistent terminology (e.g., "Sign In" vs "Login" vs "Log In")
- Flag ALL instances of poor UX writing, no matter how minor
- Be comprehensive - don't skip any text elements
` : ""}

Provide comprehensive feedback with NO HARD LIMIT on total items. Focus on thoroughness and balance across categories:
${allowedCategories.map(cat => `- ${cat}: Provide 8-12 detailed, actionable insights`).join('\n')}
${allowedCategories.includes("ux_writing") ? "- For UX writing reviews, be THOROUGH and catch ALL text issues including minor typos." : ""}
${allowedCategories.includes("consistency") ? "- For consistency reviews, compare across ALL screens and flows to catch variations and inconsistencies." : ""}
Ensure EVERY requested category has substantial feedback. Do not skip or under-represent any category.`;

    const analysisPrompt = customPrompt
      ? `${baseContext}\n\nUser's specific request: ${customPrompt}\n${formatInstructions}`
      : `${baseContext}\n\nProvide feedback in the following categories:
1. UX Issues - Navigation flows, user interactions, usability problems
2. UI Issues - Visual design, typography, spacing, color usage
3. Consistency Issues - Design pattern violations, inconsistent components
4. Improvement Suggestions - Ways to enhance the design\n${formatInstructions}`;

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an expert UX/UI designer providing professional design feedback. CRITICAL: You MUST respond with ONLY a valid JSON array, no other text. Do not include markdown code blocks, explanations, or any text outside the JSON array. Start your response with [ and end with ].",
          },
          { role: "user", content: analysisPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", errorText);
      throw new Error(`AI analysis failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log("AI analysis complete");

    // Parse AI response
    let feedback: FeedbackItem[];
    try {
      const content = aiData.choices[0].message.content;
      console.log("Raw AI response (first 500 chars):", content.substring(0, 500));
      
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\[[\s\S]*\]/);
      const jsonContent = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
      
      console.log("Extracted JSON (first 500 chars):", jsonContent.substring(0, 500));
      
      feedback = JSON.parse(jsonContent);

      // Validate feedback structure
      if (!Array.isArray(feedback)) {
        console.error("Feedback is not an array:", feedback);
        throw new Error("AI response is not an array of feedback items");
      }

      // Add unique IDs to feedback items
      feedback = feedback.map((item, index) => ({
        ...item,
        id: `feedback-${index}-${Date.now()}`,
      }));
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      console.error("Full AI response:", JSON.stringify(aiData, null, 2));
      throw new Error(`Failed to parse AI feedback: ${parseError instanceof Error ? parseError.message : "Unknown parsing error"}`);
    }

    console.log("Generated feedback items:", feedback.length);

    return new Response(
      JSON.stringify({
        success: true,
        feedback,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error in analyze-figma function:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

function extractCanvasData(document: any) {
  const nodes: Array<{
    id: string;
    name: string;
    type: string;
    path: string;
    text?: string; // Add text content for TEXT nodes
  }> = [];

  function traverse(node: any, path: string = "") {
    if (!node) return;

    // Skip hidden layers
    if (node.visible === false) {
      return;
    }

    const currentPath = path ? `${path} > ${node.name}` : node.name;

    // Include ALL nodes with IDs, especially interactive and leaf elements
    if (node.type && node.id) {
      const nodeData: any = {
        id: node.id,
        name: node.name,
        type: node.type,
        path: currentPath,
      };

      // For TEXT nodes, include the actual text content
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

  // Prioritize TEXT nodes for better typo detection
  const textNodes = nodes.filter(n => n.type === "TEXT" && n.text);
  const otherNodes = nodes.filter(n => n.type !== "TEXT" || !n.text);
  
  // Return up to 300 nodes total, with TEXT nodes first for better analysis
  const prioritizedNodes = [...textNodes, ...otherNodes].slice(0, 300);

  return {
    name: document.name,
    nodes: prioritizedNodes,
  };
}
