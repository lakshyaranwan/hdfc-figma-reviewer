// This is the main plugin code that runs in Figma's sandbox
// It extracts design data directly from the selection - no API key needed!

figma.showUI(__html__, { width: 500, height: 700 });

// Types for design data extraction
interface DesignNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fills?: any[];
  strokes?: any[];
  effects?: any[];
  cornerRadius?: number;
  fontSize?: number;
  fontName?: any;
  characters?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  lineHeight?: any;
  letterSpacing?: any;
  children?: DesignNode[];
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  opacity?: number;
}

// Extract design data from a node recursively
function extractNodeData(node: SceneNode, depth: number = 0): DesignNode | null {
  if (depth > 10) return null; // Limit depth to prevent huge payloads
  
  const baseData: DesignNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };

  // Position and size
  if ('x' in node) baseData.x = Math.round(node.x);
  if ('y' in node) baseData.y = Math.round(node.y);
  if ('width' in node) baseData.width = Math.round(node.width);
  if ('height' in node) baseData.height = Math.round(node.height);

  // Visual properties
  if ('fills' in node && node.fills !== figma.mixed) {
    baseData.fills = (node.fills as readonly Paint[]).map(fill => ({
      type: fill.type,
      visible: fill.visible,
      opacity: fill.opacity,
      color: 'color' in fill ? fill.color : undefined,
    }));
  }

  if ('strokes' in node) {
    baseData.strokes = (node.strokes as readonly Paint[]).map(stroke => ({
      type: stroke.type,
      visible: stroke.visible,
      color: 'color' in stroke ? stroke.color : undefined,
    }));
  }

  if ('effects' in node) {
    baseData.effects = (node.effects as readonly Effect[]).map(effect => ({
      type: effect.type,
      visible: effect.visible,
      radius: 'radius' in effect ? effect.radius : undefined,
    }));
  }

  if ('cornerRadius' in node && node.cornerRadius !== figma.mixed) {
    baseData.cornerRadius = node.cornerRadius;
  }

  if ('opacity' in node) {
    baseData.opacity = node.opacity;
  }

  // Text properties
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    baseData.characters = textNode.characters;
    if (textNode.fontSize !== figma.mixed) baseData.fontSize = textNode.fontSize;
    if (textNode.fontName !== figma.mixed) baseData.fontName = textNode.fontName;
    if (textNode.textAlignHorizontal) baseData.textAlignHorizontal = textNode.textAlignHorizontal;
    if (textNode.textAlignVertical) baseData.textAlignVertical = textNode.textAlignVertical;
  }

  // Auto-layout properties
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    const frameNode = node as FrameNode;
    baseData.layoutMode = frameNode.layoutMode;
    baseData.primaryAxisAlignItems = frameNode.primaryAxisAlignItems;
    baseData.counterAxisAlignItems = frameNode.counterAxisAlignItems;
    baseData.paddingLeft = frameNode.paddingLeft;
    baseData.paddingRight = frameNode.paddingRight;
    baseData.paddingTop = frameNode.paddingTop;
    baseData.paddingBottom = frameNode.paddingBottom;
    baseData.itemSpacing = frameNode.itemSpacing;
  }

  // Children
  if ('children' in node) {
    const children: DesignNode[] = [];
    for (const child of node.children) {
      const childData = extractNodeData(child, depth + 1);
      if (childData) children.push(childData);
    }
    if (children.length > 0) baseData.children = children;
  }

  return baseData;
}

// Get current selection data
function getSelectionData() {
  const selection = figma.currentPage.selection;
  
  if (selection.length === 0) {
    return {
      hasSelection: false,
      nodes: [],
      pageName: figma.currentPage.name,
      fileName: figma.root.name,
    };
  }

  const nodes: DesignNode[] = [];
  for (const node of selection) {
    const nodeData = extractNodeData(node);
    if (nodeData) nodes.push(nodeData);
  }

  return {
    hasSelection: true,
    selectionCount: selection.length,
    nodes,
    pageName: figma.currentPage.name,
    fileName: figma.root.name,
  };
}

// Find a node by ID in the current page
function findNodeById(nodeId: string): SceneNode | null {
  return figma.currentPage.findOne(n => n.id === nodeId);
}

// Find a node by name in the selection or current page
function findNodeByName(name: string): SceneNode | null {
  // First check in current selection
  for (const node of figma.currentPage.selection) {
    if (node.name === name) return node;
    if ('findOne' in node) {
      const found = (node as FrameNode).findOne(n => n.name === name);
      if (found) return found;
    }
  }
  // Then check in the whole page
  return figma.currentPage.findOne(n => n.name === name);
}

// Post a comment as a sticky note near the target node
async function postCommentToNode(nodeId: string | undefined, location: string | undefined, title: string, description: string, severity: string): Promise<boolean> {
  try {
    let targetNode: SceneNode | null = null;
    
    // Try to find the node by ID first
    if (nodeId) {
      targetNode = findNodeById(nodeId);
    }
    
    // If not found, try by location/name
    if (!targetNode && location) {
      targetNode = findNodeByName(location);
    }
    
    // If still not found, use the first selected node
    if (!targetNode && figma.currentPage.selection.length > 0) {
      targetNode = figma.currentPage.selection[0];
    }
    
    if (!targetNode) {
      figma.notify('⚠️ Could not find target element. Select a frame first.');
      return false;
    }
    
    // Create a sticky note near the node
    const sticky = figma.createSticky();
    
    // Set sticky content
    const severityEmoji = severity === 'high' ? '🔴' : severity === 'medium' ? '🟡' : '🟢';
    sticky.text.characters = `${severityEmoji} ${title}\n\n${description}`;
    
    // Position the sticky near the target node
    if ('x' in targetNode && 'y' in targetNode) {
      const nodeWidth = 'width' in targetNode ? (targetNode as any).width : 100;
      sticky.x = targetNode.x + nodeWidth + 20;
      sticky.y = targetNode.y;
    }
    
    // Set sticky color based on severity
    if (severity === 'high') {
      sticky.authorVisible = true;
    }
    
    figma.notify('💬 Comment added as sticky note!');
    return true;
  } catch (error) {
    console.error('Error posting comment:', error);
    return false;
  }
}

// Apply a suggestion to a node (basic implementation)
async function applySuggestionToNode(nodeId: string | undefined, location: string | undefined, suggestion: string): Promise<boolean> {
  try {
    let targetNode: SceneNode | null = null;
    
    // Try to find the node
    if (nodeId) {
      targetNode = findNodeById(nodeId);
    }
    if (!targetNode && location) {
      targetNode = findNodeByName(location);
    }
    if (!targetNode && figma.currentPage.selection.length > 0) {
      targetNode = figma.currentPage.selection[0];
    }
    
    if (!targetNode) {
      figma.notify('⚠️ Could not find target element');
      return false;
    }
    
    // Parse the suggestion and try to apply common fixes
    const lowerSuggestion = suggestion.toLowerCase();
    
    // Apply padding fixes
    if (lowerSuggestion.includes('padding') && 'paddingLeft' in targetNode) {
      const frameNode = targetNode as FrameNode;
      const paddingMatch = suggestion.match(/(\d+)\s*px/);
      if (paddingMatch) {
        const padding = parseInt(paddingMatch[1]);
        frameNode.paddingLeft = padding;
        frameNode.paddingRight = padding;
        frameNode.paddingTop = padding;
        frameNode.paddingBottom = padding;
        figma.notify(`✅ Applied padding: ${padding}px`);
        return true;
      }
    }
    
    // Apply spacing fixes
    if (lowerSuggestion.includes('spacing') && 'itemSpacing' in targetNode) {
      const frameNode = targetNode as FrameNode;
      const spacingMatch = suggestion.match(/(\d+)\s*px/);
      if (spacingMatch) {
        frameNode.itemSpacing = parseInt(spacingMatch[1]);
        figma.notify(`✅ Applied spacing: ${spacingMatch[1]}px`);
        return true;
      }
    }
    
    // Apply corner radius fixes
    if (lowerSuggestion.includes('corner') || lowerSuggestion.includes('radius')) {
      if ('cornerRadius' in targetNode) {
        const radiusMatch = suggestion.match(/(\d+)\s*px/);
        if (radiusMatch) {
          (targetNode as any).cornerRadius = parseInt(radiusMatch[1]);
          figma.notify(`✅ Applied corner radius: ${radiusMatch[1]}px`);
          return true;
        }
      }
    }
    
    // Apply opacity fixes
    if (lowerSuggestion.includes('opacity') && 'opacity' in targetNode) {
      const opacityMatch = suggestion.match(/(\d+(?:\.\d+)?)\s*%?/) || suggestion.match(/0\.\d+/);
      if (opacityMatch) {
        let opacity = parseFloat(opacityMatch[1]);
        if (opacity > 1) opacity = opacity / 100;
        targetNode.opacity = opacity;
        figma.notify(`✅ Applied opacity: ${Math.round(opacity * 100)}%`);
        return true;
      }
    }
    
    // Apply font size fixes for text nodes
    if (lowerSuggestion.includes('font') && targetNode.type === 'TEXT') {
      const textNode = targetNode as TextNode;
      const sizeMatch = suggestion.match(/(\d+)\s*px/);
      if (sizeMatch) {
        await figma.loadFontAsync(textNode.fontName as FontName);
        textNode.fontSize = parseInt(sizeMatch[1]);
        figma.notify(`✅ Applied font size: ${sizeMatch[1]}px`);
        return true;
      }
    }
    
    // If no specific fix was applied, add a note
    figma.notify('ℹ️ Suggestion noted - manual review recommended');
    return true;
    
  } catch (error) {
    console.error('Error applying suggestion:', error);
    return false;
  }
}

// Send initial data to UI
figma.ui.postMessage({
  type: 'selection-data',
  data: getSelectionData(),
});

// Listen for selection changes
figma.on('selectionchange', () => {
  figma.ui.postMessage({
    type: 'selection-data',
    data: getSelectionData(),
  });
});

// Handle messages from UI
figma.ui.onmessage = async (msg: any) => {
  if (msg.type === 'get-selection') {
    figma.ui.postMessage({
      type: 'selection-data',
      data: getSelectionData(),
    });
  }

  if (msg.type === 'analyze') {
    // Send current selection data for analysis
    const selectionData = getSelectionData();
    figma.ui.postMessage({
      type: 'analyze-data',
      data: selectionData,
    });
  }

  if (msg.type === 'analysis-complete') {
    figma.notify('✅ Analysis complete! Review feedback below.');
  }

  if (msg.type === 'post-comment') {
    const success = await postCommentToNode(
      msg.nodeId,
      msg.location,
      msg.title,
      msg.description,
      msg.severity
    );
    figma.ui.postMessage({
      type: 'comment-posted',
      success,
      itemId: msg.itemId,
      error: success ? null : 'Failed to post comment'
    });
  }

  if (msg.type === 'apply-suggestion') {
    const success = await applySuggestionToNode(
      msg.nodeId,
      msg.location,
      msg.suggestion
    );
    figma.ui.postMessage({
      type: 'apply-complete',
      success,
      itemId: msg.itemId,
      error: success ? null : 'Failed to apply suggestion'
    });
  }

  if (msg.type === 'notify') {
    figma.notify(msg.message);
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};