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
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { designData, prompt, fileName, pageName } = await req.json();
    
    console.log("Analyzing design from plugin");
    console.log("File:", fileName);
    console.log("Page:", pageName);
    console.log("Nodes to analyze:", designData?.length || 0);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    if (!designData || designData.length === 0) {
      throw new Error("No design data provided. Please select a frame in Figma.");
    }

    // Build the analysis prompt
    const designContext = JSON.stringify(designData, null, 2);
    
    const systemPrompt = `You are an expert UX/UI designer providing professional design feedback. 
You are analyzing design data extracted directly from a Figma plugin.
CRITICAL: You MUST respond with ONLY a valid JSON array, no other text. 
Do not include markdown code blocks, explanations, or any text outside the JSON array.
Start your response with [ and end with ].`;

    const analysisPrompt = `Analyze this Figma design structure and provide detailed feedback.

Design Data (extracted from Figma):
${designContext}

User's Request: ${prompt}

For each issue found, provide feedback in this JSON format:
[{
  "category": "ux" | "ui" | "consistency" | "accessibility" | "typography" | "ux_writing",
  "title": "Clear, actionable issue title",
  "description": "Detailed description with specific suggestions for improvement",
  "severity": "low" | "medium" | "high",
  "location": "Component or element name where the issue was found"
}]

Guidelines:
- Focus on actionable, specific feedback
- Reference actual element names from the design data
- Prioritize high-impact issues
- Include concrete suggestions for each issue
- Be thorough but concise
- Consider colors, spacing, typography, layout, and hierarchy
- Check for accessibility issues (contrast, touch targets, etc.)
- Look for inconsistencies in the design

Provide 5-15 feedback items based on the complexity of the design.`;

    console.log("Sending to AI for analysis...");
    
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
        max_tokens: 8000,
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
    console.log("AI response received");

    const content = aiData.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("No content in AI response");
    }

    // Parse the JSON response
    let feedback: FeedbackItem[];
    try {
      // Clean up the response - remove markdown code blocks if present
      let cleanContent = content.trim();
      if (cleanContent.startsWith("```json")) {
        cleanContent = cleanContent.slice(7);
      } else if (cleanContent.startsWith("```")) {
        cleanContent = cleanContent.slice(3);
      }
      if (cleanContent.endsWith("```")) {
        cleanContent = cleanContent.slice(0, -3);
      }
      cleanContent = cleanContent.trim();
      
      feedback = JSON.parse(cleanContent);
      
      if (!Array.isArray(feedback)) {
        throw new Error("Response is not an array");
      }
    } catch (parseError) {
      console.error("Failed to parse AI response:", content);
      throw new Error("Failed to parse AI analysis results");
    }

    // Add IDs to feedback items
    feedback = feedback.map((item, index) => ({
      ...item,
      id: `feedback-${index}-${Date.now()}`,
    }));

    console.log(`Analysis complete: ${feedback.length} feedback items`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        feedback,
        summary: {
          total: feedback.length,
          high: feedback.filter(f => f.severity === "high").length,
          medium: feedback.filter(f => f.severity === "medium").length,
          low: feedback.filter(f => f.severity === "low").length,
        }
      }),
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
