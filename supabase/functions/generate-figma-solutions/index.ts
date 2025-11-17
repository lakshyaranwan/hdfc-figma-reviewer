import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FeedbackItem {
  id: string;
  category: string;
  title: string;
  description: string;
  severity: string;
  location?: string;
}

interface SolutionItem extends FeedbackItem {
  solution: string;
  implementation_steps: string[];
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { feedback, fileKey } = await req.json();
    console.log('Generating solutions for feedback items:', feedback?.length);

    if (!feedback || !Array.isArray(feedback) || feedback.length === 0) {
      throw new Error('No feedback items provided');
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY not configured');
    }

    // Prepare feedback summary for AI
    const feedbackSummary = feedback.map((item: FeedbackItem) => ({
      title: item.title,
      description: item.description,
      category: item.category,
      severity: item.severity,
      location: item.location
    }));

    const prompt = `You are a UX/UI design expert. Below are design feedback items from a Figma file analysis. For each feedback item, provide:
1. A detailed solution explaining how to fix the issue
2. Step-by-step implementation instructions
3. Best practices to prevent similar issues

Feedback items:
${JSON.stringify(feedbackSummary, null, 2)}

Respond with a JSON array where each object has:
- All original fields from the feedback item
- solution: A detailed explanation of how to fix the issue (2-3 sentences)
- implementation_steps: An array of 3-5 specific, actionable steps

Focus on practical, implementable solutions that improve user experience and design consistency.`;

    console.log('Calling Lovable AI for solution generation');
    
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: 'You are a UX/UI design expert providing actionable solutions for design issues. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('Lovable AI error:', aiResponse.status, errorText);
      throw new Error(`AI request failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log('AI response received');

    let solutions: SolutionItem[];
    try {
      const content = aiData.choices[0].message.content;
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/```\n?([\s\S]*?)\n?```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      solutions = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      throw new Error('Failed to parse AI solutions');
    }

    console.log('Generated solutions for', solutions.length, 'feedback items');

    return new Response(
      JSON.stringify({ solutions }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in generate-figma-solutions:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to generate solutions';
    return new Response(
      JSON.stringify({ 
        error: errorMessage
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
