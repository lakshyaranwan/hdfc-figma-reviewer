import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    
    // Extract ALL node IDs from the entire tree (not just canvas nodes)
    const allNodes: string[] = [];
    const nodeNameMap: Record<string, string> = {};
    const nodeTypeMap: Record<string, string> = {};
    const nodeParentMap: Record<string, string> = {};
    
    function extractAllNodes(node: any, parentId?: string) {
      if (!node) return;
      if (node.id) {
        allNodes.push(node.id);
        nodeNameMap[node.id] = node.name || 'Unnamed';
        nodeTypeMap[node.id] = node.type || 'UNKNOWN';
        if (parentId) {
          nodeParentMap[node.id] = parentId;
        }
      }
      if (node.children) {
        node.children.forEach((child: any) => extractAllNodes(child, node.id));
      }
    }
    
    if (figmaData.document) {
      extractAllNodes(figmaData.document);
    }

    console.log('Total nodes found:', allNodes.length);
    console.log('Sample nodes:', allNodes.slice(0, 10));
    
    if (allNodes.length === 0) {
      throw new Error('No valid nodes found in Figma file');
    }

    // Helper function to find parent frame
    function findParentFrame(nodeId: string): string {
      let currentId = nodeId;
      let depth = 0;
      const maxDepth = 10; // Prevent infinite loops
      
      while (currentId && depth < maxDepth) {
        const parentId = nodeParentMap[currentId];
        if (!parentId) break;
        
        const parentType = nodeTypeMap[parentId];
        // Use parent if it's a FRAME, COMPONENT, or INSTANCE
        if (parentType === 'FRAME' || parentType === 'COMPONENT' || parentType === 'INSTANCE') {
          return parentId;
        }
        
        currentId = parentId;
        depth++;
      }
      
      return nodeId; // Return original if no frame found
    }

    let commentsPosted = 0;
    const errors: string[] = [];

    // Post comments for each feedback item
    for (let i = 0; i < feedback.length; i++) {
      const item = feedback[i];
      
      try {
        // Priority 1: Use the AI-provided node ID if it exists and is valid
        let nodeId = item.nodeId;
        let nodeFound = false;
        
        // Clean up instance notation from node IDs (Figma API doesn't accept them)
        // Convert "I9:27410;11530:113555;12190:118991" to the most specific node
        if (nodeId) {
          // Remove "I" prefix if present
          if (nodeId.startsWith('I')) {
            nodeId = nodeId.substring(1);
          }
          // For instance chains, try from most specific (last) to least specific (first)
          if (nodeId.includes(';')) {
            const parts = nodeId.split(';').filter((part: string) => !part.startsWith('0:'));
            // Try each part from most specific to least specific
            for (let i = parts.length - 1; i >= 0; i--) {
              if (allNodes.includes(parts[i])) {
                nodeId = parts[i];
                nodeFound = true;
                console.log(`✓ Using specific node from chain: ${nodeId} (${nodeNameMap[nodeId] || 'Unknown'})`);
                break;
              }
            }
            // If no valid node found in chain, use the last valid part
            if (!nodeFound) {
              nodeId = parts[parts.length - 1];
              console.log(`Cleaned node ID: ${item.nodeId} → ${nodeId}`);
            }
          } else {
            console.log(`Using simple node ID: ${nodeId}`);
          }
        }
        
        if (nodeId && allNodes.includes(nodeId)) {
          nodeFound = true;
          console.log(`✓ Using node ID: ${nodeId} (${nodeNameMap[nodeId] || 'Unknown'})`);
        } else if (nodeId) {
          console.log(`✗ Node ID ${nodeId} not found in file`);
        }
        
        // Priority 2: Try to find node by matching location name
        if (!nodeFound && item.location) {
          console.log(`Searching for node matching location: "${item.location}"`);
          const foundNodeId = findNodeByName(figmaData.document, item.location);
          if (foundNodeId && allNodes.includes(foundNodeId)) {
            nodeId = foundNodeId;
            nodeFound = true;
            console.log(`✓ Found node by name match: ${nodeId} (${nodeNameMap[nodeId]})`);
          }
        }
        
        // Priority 3: Use first available simple node (skip document root 0:0, 0:1)
        if (!nodeFound) {
          nodeId = allNodes.find(id => !id.startsWith('0:') && !id.includes(';')) || allNodes[2];
          console.log(`⚠ Using fallback node: ${nodeId} (${nodeNameMap[nodeId] || 'Unknown'})`);
        }
        
        // Try to use parent frame for better contextual placement
        // BUT ONLY if the specific node is too granular (like TEXT or small elements)
        const nodeType = nodeTypeMap[nodeId];
        let finalNodeId = nodeId;
        
        // Only use parent frame if the node is a leaf element (TEXT, VECTOR, etc.)
        // Keep FRAME, COMPONENT, INSTANCE nodes as they are more contextual
        const shouldUseParent = nodeType && !['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP'].includes(nodeType);
        
        if (shouldUseParent) {
          const contextualNodeId = findParentFrame(nodeId);
          if (contextualNodeId !== nodeId) {
            console.log(`📍 Using parent frame: ${contextualNodeId} (${nodeNameMap[contextualNodeId]}) instead of ${nodeId} (${nodeType})`);
            finalNodeId = contextualNodeId;
          }
        } else {
          console.log(`✓ Using specific node: ${nodeId} (${nodeType}) - no parent needed`);
        }
        
        const commentText = `🤖 **AI Feedback - ${item.category.toUpperCase()}**\n\n**${item.title}**\n\nSeverity: ${item.severity.toUpperCase()}\n\n${item.description}${item.location ? `\n\n📍 Component: ${item.location}` : ''}`;

        // Calculate offset to prevent overlapping comments
        // Group by node ID and spread them out better
        const commentsOnSameNode = feedback.slice(0, i).filter((f: any) => {
          const prevNodeId = f.nodeId || '';
          const prevFinalNode = shouldUseParent ? findParentFrame(prevNodeId) : prevNodeId;
          return prevFinalNode === finalNodeId;
        }).length;
        
        // Base offset starts at 50, with additional spacing for each comment on same node
        const offsetX = 50 + (commentsOnSameNode * 250); // Spread horizontally for same node
        const offsetY = 50 + (i * 120); // Stack vertically overall

        console.log(`Posting comment ${i + 1}/${feedback.length} to node: ${finalNodeId} (${nodeNameMap[finalNodeId] || 'Unknown'}) at offset (${offsetX}, ${offsetY})`);

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
                node_id: finalNodeId,
                node_offset: {
                  x: offsetX,
                  y: offsetY,
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

// Helper function to find node by name or partial match
function findNodeByName(node: any, searchName: string): string | null {
  if (!node) return null;
  
  const normalizedSearch = searchName.toLowerCase();
  const normalizedNodeName = (node.name || '').toLowerCase();
  
  // Check for exact or partial match
  if (normalizedNodeName.includes(normalizedSearch) || normalizedSearch.includes(normalizedNodeName)) {
    return node.id;
  }
  
  // Recursively search children
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeByName(child, searchName);
      if (found) return found;
    }
  }
  
  return null;
}
