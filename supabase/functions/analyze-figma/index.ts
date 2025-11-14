import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FeedbackItem {
  id: string;
  category: "ux" | "ui" | "consistency" | "improvement";
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  location?: string;
  nodeId?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { fileKey, nodeId, customPrompt } = await req.json();
    console.log('Analyzing Figma file:', fileKey);
    console.log('Target node:', nodeId || 'entire file');
    console.log('Custom prompt provided:', !!customPrompt);

    const FIGMA_TOKEN = Deno.env.get('FIGMA_ACCESS_TOKEN');
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');

    if (!FIGMA_TOKEN) {
      throw new Error('FIGMA_ACCESS_TOKEN not configured');
    }
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY not configured');
    }

    // Step 1: Fetch Figma file data (specific node or entire file)
    console.log('Fetching Figma file data...');
    console.log('File key:', fileKey);
    console.log('Node ID:', nodeId || 'entire file');
    
    let figmaUrl = `https://api.figma.com/v1/files/${fileKey}`;
    let figmaData;
    let targetData;
    
    if (nodeId) {
      // Fetch specific node
      console.log('Fetching specific node:', nodeId);
      figmaUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
      
      const figmaResponse = await fetch(figmaUrl, {
        headers: {
          'X-Figma-Token': FIGMA_TOKEN,
        },
      });

      if (!figmaResponse.ok) {
        const errorText = await figmaResponse.text();
        console.error('Figma API error:', errorText);
        throw new Error(`Failed to fetch Figma node: ${figmaResponse.status}`);
      }

      figmaData = await figmaResponse.json();
      
      // Extract the specific node data
      const nodeData = figmaData.nodes?.[nodeId];
      if (!nodeData || !nodeData.document) {
        console.error('Node data:', figmaData);
        throw new Error(`Node ${nodeId} not found in file`);
      }
      
      targetData = nodeData.document;
      console.log('Analyzing specific node:', targetData.name);
    } else {
      // Fetch entire file
      console.log('Fetching entire file');
      const figmaResponse = await fetch(figmaUrl, {
        headers: {
          'X-Figma-Token': FIGMA_TOKEN,
        },
      });

      if (!figmaResponse.ok) {
        const errorText = await figmaResponse.text();
        console.error('Figma API error:', errorText);
        throw new Error(`Failed to fetch Figma file: ${figmaResponse.status}`);
      }

      figmaData = await figmaResponse.json();
      targetData = figmaData.document;
      console.log('Analyzing entire file');
    }
    
    const canvasData = extractCanvasData(targetData);
    console.log('Canvas data extracted, node count:', canvasData.nodes.length);

    // Step 3: Analyze with Gemini AI
    console.log('Sending to AI for analysis...');
    
    const baseContext = `You are a UX/UI expert analyzing a Figma design. Analyze the following design data and provide detailed feedback.

Design Structure (showing node hierarchy with IDs):
${JSON.stringify(canvasData, null, 2)}

IMPORTANT: For each feedback item, identify the SPECIFIC node ID from the list above that the feedback applies to. Use the exact node ID provided.`;

    const formatInstructions = `
For each issue found, provide:
- A clear, actionable title
- Detailed description of the issue and how to fix it
- Severity (low, medium, high)
- The EXACT node ID from the structure above for the specific element this feedback applies to
- Component/frame name and path

Format your response as a JSON array of feedback items with this structure:
[{
  "category": "ux" | "ui" | "consistency" | "improvement",
  "title": "Issue title",
  "description": "Detailed description",
  "severity": "low" | "medium" | "high",
  "location": "Component/Frame name with path",
  "nodeId": "exact_node_id_from_structure"
}]

CRITICAL: Always include the nodeId field with the exact ID from the design structure. Choose the most specific, relevant node for each piece of feedback.

Provide 5-10 high-quality, actionable insights. Focus on the most impactful issues.`;

    const analysisPrompt = customPrompt 
      ? `${baseContext}\n\nUser's specific request: ${customPrompt}\n${formatInstructions}`
      : `${baseContext}\n\nProvide feedback in the following categories:
1. UX Issues - Navigation flows, user interactions, usability problems
2. UI Issues - Visual design, typography, spacing, color usage
3. Consistency Issues - Design pattern violations, inconsistent components
4. Improvement Suggestions - Ways to enhance the design\n${formatInstructions}`;

    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'You are an expert UX/UI designer providing professional design feedback. Always respond with valid JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.7,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', errorText);
      throw new Error(`AI analysis failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log('AI analysis complete');

    // Parse AI response
    let feedback: FeedbackItem[];
    try {
      const content = aiData.choices[0].message.content;
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\[[\s\S]*\]/);
      const jsonContent = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      feedback = JSON.parse(jsonContent);
      
      // Add unique IDs to feedback items
      feedback = feedback.map((item, index) => ({
        ...item,
        id: `feedback-${index}-${Date.now()}`,
      }));
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      throw new Error('Failed to parse AI feedback');
    }

    console.log('Generated feedback items:', feedback.length);

    return new Response(
      JSON.stringify({
        success: true,
        feedback,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in analyze-figma function:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

function extractCanvasData(document: any) {
  const nodes: Array<{ id: string; name: string; type: string; path: string }> = [];
  
  function traverse(node: any, path: string = '') {
    if (!node) return;
    
    const currentPath = path ? `${path} > ${node.name}` : node.name;
    
    // Include all interactive and visual elements
    if (node.type && node.id) {
      nodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
        path: currentPath,
      });
    }
    
    if (node.children) {
      node.children.forEach((child: any) => traverse(child, currentPath));
    }
  }
  
  traverse(document);
  
  return {
    name: document.name,
    nodes: nodes.slice(0, 100), // Include more nodes for better targeting
  };
}
