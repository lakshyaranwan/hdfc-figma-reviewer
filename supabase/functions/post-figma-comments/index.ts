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
    const { fileKey, feedback } = await req.json();
    console.log('Posting comments to Figma file:', fileKey);
    console.log('Number of feedback items:', feedback.length);

    const FIGMA_TOKEN = Deno.env.get('FIGMA_ACCESS_TOKEN');
    if (!FIGMA_TOKEN) {
      throw new Error('FIGMA_ACCESS_TOKEN not configured');
    }

    // First, fetch the file to get valid node IDs
    console.log('Fetching Figma file structure...');
    const figmaResponse = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: {
        'X-Figma-Token': FIGMA_TOKEN,
      },
    });

    if (!figmaResponse.ok) {
      const errorText = await figmaResponse.text();
      console.error('Figma API error:', errorText);
      throw new Error(`Failed to fetch Figma file: ${figmaResponse.status}`);
    }

    const figmaData = await figmaResponse.json();
    
    // Extract canvas node IDs (these are the frames at the top level)
    const canvasNodes: string[] = [];
    if (figmaData.document?.children) {
      for (const canvas of figmaData.document.children) {
        if (canvas.children) {
          for (const frame of canvas.children) {
            if (frame.id) {
              canvasNodes.push(frame.id);
            }
          }
        }
      }
    }

    console.log('Found canvas nodes:', canvasNodes.length);
    
    if (canvasNodes.length === 0) {
      throw new Error('No valid nodes found in Figma file');
    }

    let commentsPosted = 0;
    const errors: string[] = [];

    // Post comments for each feedback item
    for (let i = 0; i < feedback.length; i++) {
      const item = feedback[i];
      
      try {
        // Use a different node for each comment to spread them out
        const nodeId = canvasNodes[i % canvasNodes.length];
        
        const commentText = `🤖 **AI Feedback - ${item.category.toUpperCase()}**\n\n**${item.title}**\n\nSeverity: ${item.severity.toUpperCase()}\n\n${item.description}${item.location ? `\n\n📍 Location: ${item.location}` : ''}`;

        console.log(`Posting comment ${i + 1}/${feedback.length} to node:`, nodeId);

        const commentResponse = await fetch(
          `https://api.figma.com/v1/files/${fileKey}/comments`,
          {
            method: 'POST',
            headers: {
              'X-Figma-Token': FIGMA_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: commentText,
              client_meta: {
                node_id: nodeId,
                node_offset: {
                  x: 0,
                  y: 0,
                }
              },
            }),
          }
        );

        if (commentResponse.ok) {
          commentsPosted++;
          console.log(`✓ Comment ${i + 1} posted successfully`);
        } else {
          const errorText = await commentResponse.text();
          console.error(`✗ Failed to post comment ${i + 1}:`, errorText);
          errors.push(`Comment ${i + 1}: ${errorText}`);
        }
        
        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (commentError) {
        console.error(`Error posting comment ${i + 1}:`, commentError);
        errors.push(`Comment ${i + 1}: ${commentError instanceof Error ? commentError.message : 'Unknown error'}`);
      }
    }

    console.log(`Posted ${commentsPosted}/${feedback.length} comments successfully`);

    return new Response(
      JSON.stringify({
        success: true,
        commentsPosted,
        total: feedback.length,
        errors: errors.length > 0 ? errors : undefined,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in post-figma-comments function:', error);
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
