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


// Parse design property values from suggestion text
function parseDesignValues(suggestion: string): {
  padding?: { top?: number; right?: number; bottom?: number; left?: number; all?: number };
  spacing?: number;
  cornerRadius?: number;
  opacity?: number;
  fontSize?: number;
  width?: number;
  height?: number;
  color?: { r: number; g: number; b: number };
  visible?: boolean;
  text?: string;
} {
  const result: any = {};
  const lowerSuggestion = suggestion.toLowerCase();
  
  // Parse padding values
  const paddingAllMatch = suggestion.match(/padding[:\s]+(\d+)\s*px/i);
  const paddingDetailMatch = suggestion.match(/padding[:\s]+(\d+)\s*px?\s+(\d+)\s*px?\s+(\d+)\s*px?\s+(\d+)\s*px?/i);
  if (paddingDetailMatch) {
    result.padding = {
      top: parseInt(paddingDetailMatch[1]),
      right: parseInt(paddingDetailMatch[2]),
      bottom: parseInt(paddingDetailMatch[3]),
      left: parseInt(paddingDetailMatch[4])
    };
  } else if (paddingAllMatch) {
    result.padding = { all: parseInt(paddingAllMatch[1]) };
  }
  
  // Parse spacing/gap
  const spacingMatch = suggestion.match(/(?:spacing|gap|item-spacing)[:\s]+(\d+)\s*px/i);
  if (spacingMatch) result.spacing = parseInt(spacingMatch[1]);
  
  // Parse corner radius
  const radiusMatch = suggestion.match(/(?:corner[- ]?radius|border[- ]?radius|radius)[:\s]+(\d+)\s*px/i);
  if (radiusMatch) result.cornerRadius = parseInt(radiusMatch[1]);
  
  // Parse opacity
  const opacityPercentMatch = suggestion.match(/opacity[:\s]+(\d+)\s*%/i);
  const opacityDecimalMatch = suggestion.match(/opacity[:\s]+(0\.\d+)/i);
  if (opacityPercentMatch) result.opacity = parseInt(opacityPercentMatch[1]) / 100;
  else if (opacityDecimalMatch) result.opacity = parseFloat(opacityDecimalMatch[1]);
  
  // Parse font size
  const fontSizeMatch = suggestion.match(/font[- ]?size[:\s]+(\d+)\s*px/i);
  if (fontSizeMatch) result.fontSize = parseInt(fontSizeMatch[1]);
  
  // Parse dimensions
  const widthMatch = suggestion.match(/width[:\s]+(\d+)\s*px/i);
  const heightMatch = suggestion.match(/height[:\s]+(\d+)\s*px/i);
  if (widthMatch) result.width = parseInt(widthMatch[1]);
  if (heightMatch) result.height = parseInt(heightMatch[1]);
  
  // Parse hex color
  const hexMatch = suggestion.match(/#([0-9a-f]{6})/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    result.color = {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255
    };
  }
  
  // Parse visibility
  if (lowerSuggestion.includes('hide') || lowerSuggestion.includes('hidden') || lowerSuggestion.includes('remove')) {
    result.visible = false;
  } else if (lowerSuggestion.includes('show') || lowerSuggestion.includes('visible')) {
    result.visible = true;
  }
  
  return result;
}

// Apply a suggestion to a node with comprehensive design changes
async function applySuggestionToNode(nodeId: string | undefined, location: string | undefined, suggestion: string, title?: string): Promise<{ success: boolean; applied: string[] }> {
  const appliedChanges: string[] = [];
  
  try {
    let targetNode: SceneNode | null = null;
    
    // Try to find the node by ID
    if (nodeId) {
      targetNode = findNodeById(nodeId);
    }
    // Try by location/name
    if (!targetNode && location) {
      targetNode = findNodeByName(location);
    }
    // Use first selected node as fallback
    if (!targetNode && figma.currentPage.selection.length > 0) {
      targetNode = figma.currentPage.selection[0];
    }
    
    if (!targetNode) {
      figma.notify('⚠️ Could not find target element. Select it first.');
      return { success: false, applied: [] };
    }
    
    // Parse all design values from suggestion
    const values = parseDesignValues(suggestion);
    const lowerSuggestion = suggestion.toLowerCase();
    const lowerTitle = (title || '').toLowerCase();
    
    // Apply visibility changes
    if (values.visible !== undefined) {
      targetNode.visible = values.visible;
      appliedChanges.push(`visibility: ${values.visible ? 'shown' : 'hidden'}`);
    }
    
    // Apply padding (for frames/components)
    if (values.padding && 'paddingLeft' in targetNode) {
      const frameNode = targetNode as FrameNode;
      if (values.padding.all !== undefined) {
        frameNode.paddingLeft = values.padding.all;
        frameNode.paddingRight = values.padding.all;
        frameNode.paddingTop = values.padding.all;
        frameNode.paddingBottom = values.padding.all;
        appliedChanges.push(`padding: ${values.padding.all}px`);
      } else {
        if (values.padding.top !== undefined) frameNode.paddingTop = values.padding.top;
        if (values.padding.right !== undefined) frameNode.paddingRight = values.padding.right;
        if (values.padding.bottom !== undefined) frameNode.paddingBottom = values.padding.bottom;
        if (values.padding.left !== undefined) frameNode.paddingLeft = values.padding.left;
        appliedChanges.push(`padding: ${values.padding.top || 0} ${values.padding.right || 0} ${values.padding.bottom || 0} ${values.padding.left || 0}`);
      }
    }
    
    // Apply item spacing (for auto-layout frames)
    if (values.spacing !== undefined && 'itemSpacing' in targetNode) {
      const frameNode = targetNode as FrameNode;
      frameNode.itemSpacing = values.spacing;
      appliedChanges.push(`spacing: ${values.spacing}px`);
    }
    
    // Apply corner radius
    if (values.cornerRadius !== undefined && 'cornerRadius' in targetNode) {
      (targetNode as any).cornerRadius = values.cornerRadius;
      appliedChanges.push(`corner-radius: ${values.cornerRadius}px`);
    }
    
    // Apply opacity
    if (values.opacity !== undefined && 'opacity' in targetNode) {
      targetNode.opacity = values.opacity;
      appliedChanges.push(`opacity: ${Math.round(values.opacity * 100)}%`);
    }
    
    // Apply dimensions
    if (values.width !== undefined && 'resize' in targetNode) {
      const resizeNode = targetNode as FrameNode;
      resizeNode.resize(values.width, resizeNode.height);
      appliedChanges.push(`width: ${values.width}px`);
    }
    if (values.height !== undefined && 'resize' in targetNode) {
      const resizeNode = targetNode as FrameNode;
      resizeNode.resize(resizeNode.width, values.height);
      appliedChanges.push(`height: ${values.height}px`);
    }
    
    // Apply fill color
    if (values.color && 'fills' in targetNode) {
      const fillableNode = targetNode as GeometryMixin;
      fillableNode.fills = [{ type: 'SOLID', color: values.color }];
      appliedChanges.push(`fill color applied`);
    }
    
    // Apply font size (for text nodes)
    if (values.fontSize !== undefined && targetNode.type === 'TEXT') {
      const textNode = targetNode as TextNode;
      try {
        await figma.loadFontAsync(textNode.fontName as FontName);
        textNode.fontSize = values.fontSize;
        appliedChanges.push(`font-size: ${values.fontSize}px`);
      } catch (e) {
        console.error('Font load failed:', e);
      }
    }
    
    // Handle text-related suggestions for TEXT nodes
    if (targetNode.type === 'TEXT') {
      const textNode = targetNode as TextNode;
      
      // Rename/change text content
      const renameMatch = suggestion.match(/rename[d]?\s+(?:to\s+)?['"]([^'"]+)['"]/i) ||
                          suggestion.match(/change\s+(?:to\s+)?['"]([^'"]+)['"]/i) ||
                          suggestion.match(/update\s+(?:to\s+)?['"]([^'"]+)['"]/i) ||
                          suggestion.match(/replace\s+(?:with\s+)?['"]([^'"]+)['"]/i);
      if (renameMatch) {
        try {
          await figma.loadFontAsync(textNode.fontName as FontName);
          textNode.characters = renameMatch[1];
          appliedChanges.push(`text: "${renameMatch[1]}"`);
        } catch (e) {
          console.error('Text update failed:', e);
        }
      }
      
      // Handle alignment suggestions
      if (lowerSuggestion.includes('align') || lowerSuggestion.includes('center')) {
        try {
          await figma.loadFontAsync(textNode.fontName as FontName);
          if (lowerSuggestion.includes('center')) {
            textNode.textAlignHorizontal = 'CENTER';
            appliedChanges.push('text-align: center');
          } else if (lowerSuggestion.includes('left')) {
            textNode.textAlignHorizontal = 'LEFT';
            appliedChanges.push('text-align: left');
          } else if (lowerSuggestion.includes('right')) {
            textNode.textAlignHorizontal = 'RIGHT';
            appliedChanges.push('text-align: right');
          }
        } catch (e) {
          console.error('Alignment failed:', e);
        }
      }
    }
    
    // Handle auto-layout suggestions
    if ('layoutMode' in targetNode && lowerSuggestion.includes('auto-layout')) {
      const frameNode = targetNode as FrameNode;
      if (lowerSuggestion.includes('horizontal') || lowerSuggestion.includes('row')) {
        frameNode.layoutMode = 'HORIZONTAL';
        appliedChanges.push('layout: horizontal');
      } else if (lowerSuggestion.includes('vertical') || lowerSuggestion.includes('column')) {
        frameNode.layoutMode = 'VERTICAL';
        appliedChanges.push('layout: vertical');
      }
    }
    
    // Handle alignment in auto-layout
    if ('primaryAxisAlignItems' in targetNode) {
      const frameNode = targetNode as FrameNode;
      if (lowerSuggestion.includes('center') && lowerSuggestion.includes('align')) {
        frameNode.primaryAxisAlignItems = 'CENTER';
        frameNode.counterAxisAlignItems = 'CENTER';
        appliedChanges.push('alignment: centered');
      }
    }
    
    // If we made changes, notify and return success
    if (appliedChanges.length > 0) {
      figma.notify(`✅ Applied: ${appliedChanges.join(', ')}`);
      return { success: true, applied: appliedChanges };
    }
    
    // If no structured values found, try to interpret common phrases
    if (lowerSuggestion.includes('increase') || lowerSuggestion.includes('larger') || lowerSuggestion.includes('bigger')) {
      // Try to increase common properties by 20%
      if ('paddingLeft' in targetNode) {
        const frameNode = targetNode as FrameNode;
        const increase = Math.max(4, Math.round(frameNode.paddingLeft * 0.2));
        frameNode.paddingLeft += increase;
        frameNode.paddingRight += increase;
        frameNode.paddingTop += increase;
        frameNode.paddingBottom += increase;
        appliedChanges.push(`increased padding by ${increase}px`);
      } else if (targetNode.type === 'TEXT') {
        const textNode = targetNode as TextNode;
        if (textNode.fontSize !== figma.mixed) {
          await figma.loadFontAsync(textNode.fontName as FontName);
          const newSize = Math.round((textNode.fontSize as number) * 1.2);
          textNode.fontSize = newSize;
          appliedChanges.push(`font-size: ${newSize}px`);
        }
      }
    }
    
    if (lowerSuggestion.includes('decrease') || lowerSuggestion.includes('smaller') || lowerSuggestion.includes('reduce')) {
      if ('paddingLeft' in targetNode) {
        const frameNode = targetNode as FrameNode;
        const decrease = Math.max(2, Math.round(frameNode.paddingLeft * 0.2));
        frameNode.paddingLeft = Math.max(0, frameNode.paddingLeft - decrease);
        frameNode.paddingRight = Math.max(0, frameNode.paddingRight - decrease);
        frameNode.paddingTop = Math.max(0, frameNode.paddingTop - decrease);
        frameNode.paddingBottom = Math.max(0, frameNode.paddingBottom - decrease);
        appliedChanges.push(`decreased padding by ${decrease}px`);
      } else if (targetNode.type === 'TEXT') {
        const textNode = targetNode as TextNode;
        if (textNode.fontSize !== figma.mixed) {
          await figma.loadFontAsync(textNode.fontName as FontName);
          const newSize = Math.max(8, Math.round((textNode.fontSize as number) * 0.8));
          textNode.fontSize = newSize;
          appliedChanges.push(`font-size: ${newSize}px`);
        }
      }
    }
    
    if (appliedChanges.length > 0) {
      figma.notify(`✅ Applied: ${appliedChanges.join(', ')}`);
      return { success: true, applied: appliedChanges };
    }
    
    // No changes could be applied automatically
    figma.notify('ℹ️ This suggestion requires manual review - selecting element');
    figma.currentPage.selection = [targetNode];
    figma.viewport.scrollAndZoomIntoView([targetNode]);
    return { success: true, applied: ['focused element for manual edit'] };
    
  } catch (error) {
    console.error('Error applying suggestion:', error);
    figma.notify('❌ Error applying suggestion: ' + (error as Error).message);
    return { success: false, applied: [] };
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

  if (msg.type === 'apply-suggestion') {
    const result = await applySuggestionToNode(
      msg.nodeId,
      msg.location,
      msg.suggestion,
      msg.title
    );
    figma.ui.postMessage({
      type: 'apply-complete',
      success: result.success,
      itemId: msg.itemId,
      appliedChanges: result.applied,
      error: result.success ? null : 'Failed to apply suggestion'
    });
  }

  if (msg.type === 'focus-node') {
    let targetNode: SceneNode | null = null;
    
    // Try to find the node by ID first
    if (msg.nodeId) {
      targetNode = findNodeById(msg.nodeId);
    }
    
    // If not found, try by location/name
    if (!targetNode && msg.location) {
      targetNode = findNodeByName(msg.location);
    }
    
    if (targetNode) {
      // Select and zoom to the node
      figma.currentPage.selection = [targetNode];
      figma.viewport.scrollAndZoomIntoView([targetNode]);
      figma.notify(`🎯 Focused on: ${targetNode.name}`);
    } else {
      figma.notify('⚠️ Could not find the element. It may have been deleted or renamed.');
    }
  }

  if (msg.type === 'notify') {
    figma.notify(msg.message);
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};