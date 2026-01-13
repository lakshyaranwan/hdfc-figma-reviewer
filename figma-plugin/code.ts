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
  
  // Skip hidden layers/elements
  if (!node.visible) return null;
  
  // Skip elements with opacity set to 0
  if ('opacity' in node && node.opacity === 0) return null;
  
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

// Extract new text from various suggestion patterns
function extractNewTextFromSuggestion(suggestion: string, title: string): string | null {
  const combined = `${title} ${suggestion}`;
  
  // Pattern: "Change 'old' to 'new'" or "Change "old" to "new""
  const changeToMatch = combined.match(/change\s+['"]([^'"]+)['"]\s+to\s+['"]([^'"]+)['"]/i);
  if (changeToMatch) return changeToMatch[2];
  
  // Pattern: "Update to 'new'" or similar
  const updateToMatch = combined.match(/(?:update|change|rename|replace)\s+(?:it\s+)?to\s+['"]([^'"]+)['"]/i);
  if (updateToMatch) return updateToMatch[1];
  
  // Pattern: "Use 'new text' instead"
  const useInsteadMatch = combined.match(/use\s+['"]([^'"]+)['"]\s+instead/i);
  if (useInsteadMatch) return useInsteadMatch[1];
  
  // Pattern: "Replace with 'new text'"
  const replaceWithMatch = combined.match(/replace\s+(?:it\s+)?with\s+['"]([^'"]+)['"]/i);
  if (replaceWithMatch) return replaceWithMatch[1];
  
  // Pattern: "'new text'" at end of suggestion for short ones
  const quotedAtEnd = combined.match(/['"]([^'"]{2,50})['"]\s*\.?\s*$/);
  if (quotedAtEnd && combined.toLowerCase().includes('change')) return quotedAtEnd[1];
  
  // Pattern: Fix typo suggestions - "should be 'correct'"
  const shouldBeMatch = combined.match(/should\s+be\s+['"]([^'"]+)['"]/i);
  if (shouldBeMatch) return shouldBeMatch[1];
  
  // Pattern: "Correct spelling: 'word'" or "Correct to 'word'"
  const correctMatch = combined.match(/correct(?:ed)?\s+(?:spelling[:\s]+)?(?:to\s+)?['"]([^'"]+)['"]/i);
  if (correctMatch) return correctMatch[1];
  
  return null;
}

// Extract color from suggestion (hex, rgb, or color names)
function extractColorFromSuggestion(suggestion: string): { r: number; g: number; b: number } | null {
  const lowerSuggestion = suggestion.toLowerCase();
  
  // Hex color
  const hexMatch = suggestion.match(/#([0-9a-fA-F]{6})/);
  if (hexMatch) {
    const hex = hexMatch[1];
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255
    };
  }
  
  // RGB pattern
  const rgbMatch = suggestion.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1]) / 255,
      g: parseInt(rgbMatch[2]) / 255,
      b: parseInt(rgbMatch[3]) / 255
    };
  }
  
  // Common color names
  const colorMap: { [key: string]: { r: number; g: number; b: number } } = {
    'red': { r: 1, g: 0, b: 0 },
    'green': { r: 0, g: 0.5, b: 0 },
    'blue': { r: 0, g: 0, b: 1 },
    'white': { r: 1, g: 1, b: 1 },
    'black': { r: 0, g: 0, b: 0 },
    'yellow': { r: 1, g: 1, b: 0 },
    'orange': { r: 1, g: 0.647, b: 0 },
    'purple': { r: 0.5, g: 0, b: 0.5 },
    'pink': { r: 1, g: 0.753, b: 0.796 },
    'gray': { r: 0.5, g: 0.5, b: 0.5 },
    'grey': { r: 0.5, g: 0.5, b: 0.5 },
  };
  
  for (const [name, color] of Object.entries(colorMap)) {
    if (lowerSuggestion.includes(name)) {
      return color;
    }
  }
  
  return null;
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
    const combinedText = `${title || ''} ${suggestion}`.toLowerCase();
    
    // ========== TEXT CHANGES (Priority for typo/text fixes) ==========
    if (targetNode.type === 'TEXT') {
      const textNode = targetNode as TextNode;
      
      // Try to extract new text from suggestion
      const newText = extractNewTextFromSuggestion(suggestion, title || '');
      if (newText) {
        try {
          // Load font before modifying text
          if (textNode.fontName !== figma.mixed) {
            await figma.loadFontAsync(textNode.fontName as FontName);
          } else {
            // Load fonts for all characters if mixed
            const len = textNode.characters.length;
            for (let i = 0; i < len; i++) {
              await figma.loadFontAsync(textNode.getRangeFontName(i, i + 1) as FontName);
            }
          }
          textNode.characters = newText;
          appliedChanges.push(`text changed to "${newText}"`);
        } catch (e) {
          console.error('Text update failed:', e);
        }
      }
      
      // Handle alignment suggestions
      if (appliedChanges.length === 0 && (combinedText.includes('align') || combinedText.includes('center'))) {
        try {
          if (textNode.fontName !== figma.mixed) {
            await figma.loadFontAsync(textNode.fontName as FontName);
          }
          if (combinedText.includes('center')) {
            textNode.textAlignHorizontal = 'CENTER';
            appliedChanges.push('text-align: center');
          } else if (combinedText.includes('left')) {
            textNode.textAlignHorizontal = 'LEFT';
            appliedChanges.push('text-align: left');
          } else if (combinedText.includes('right')) {
            textNode.textAlignHorizontal = 'RIGHT';
            appliedChanges.push('text-align: right');
          }
        } catch (e) {
          console.error('Alignment failed:', e);
        }
      }
      
      // Apply font size changes
      if (values.fontSize !== undefined) {
        try {
          if (textNode.fontName !== figma.mixed) {
            await figma.loadFontAsync(textNode.fontName as FontName);
          }
          textNode.fontSize = values.fontSize;
          appliedChanges.push(`font-size: ${values.fontSize}px`);
        } catch (e) {
          console.error('Font size change failed:', e);
        }
      }
      
      // Handle "increase/decrease font size" 
      if (appliedChanges.length === 0 && combinedText.includes('font') && (combinedText.includes('size') || combinedText.includes('larger') || combinedText.includes('smaller') || combinedText.includes('bigger'))) {
        try {
          if (textNode.fontName !== figma.mixed && textNode.fontSize !== figma.mixed) {
            await figma.loadFontAsync(textNode.fontName as FontName);
            const currentSize = textNode.fontSize as number;
            let newSize = currentSize;
            
            if (combinedText.includes('increase') || combinedText.includes('larger') || combinedText.includes('bigger')) {
              newSize = Math.round(currentSize * 1.2);
            } else if (combinedText.includes('decrease') || combinedText.includes('smaller') || combinedText.includes('reduce')) {
              newSize = Math.max(8, Math.round(currentSize * 0.85));
            }
            
            if (newSize !== currentSize) {
              textNode.fontSize = newSize;
              appliedChanges.push(`font-size: ${newSize}px`);
            }
          }
        } catch (e) {
          console.error('Font size adjustment failed:', e);
        }
      }
      
      // Handle font weight suggestions
      if (combinedText.includes('bold') || combinedText.includes('weight')) {
        try {
          if (textNode.fontName !== figma.mixed) {
            const currentFont = textNode.fontName as FontName;
            const boldStyle = combinedText.includes('bold') ? 'Bold' : currentFont.style;
            try {
              await figma.loadFontAsync({ family: currentFont.family, style: boldStyle });
              textNode.fontName = { family: currentFont.family, style: boldStyle };
              appliedChanges.push(`font-weight: ${boldStyle}`);
            } catch {
              // Bold variant might not exist
              console.log('Bold variant not available for this font');
            }
          }
        } catch (e) {
          console.error('Font weight change failed:', e);
        }
      }
    }
    
    // ========== COLOR CHANGES ==========
    if (combinedText.includes('color') || combinedText.includes('fill') || suggestion.includes('#')) {
      const color = extractColorFromSuggestion(suggestion) || values.color;
      if (color && 'fills' in targetNode) {
        const fillableNode = targetNode as GeometryMixin;
        fillableNode.fills = [{ type: 'SOLID', color: color }];
        appliedChanges.push(`fill color applied`);
      }
    }
    
    // ========== VISIBILITY CHANGES ==========
    if (values.visible !== undefined) {
      targetNode.visible = values.visible;
      appliedChanges.push(`visibility: ${values.visible ? 'shown' : 'hidden'}`);
    }
    
    // ========== LAYOUT/SPACING CHANGES ==========
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
        appliedChanges.push(`padding updated`);
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
    
    // ========== AUTO-LAYOUT CHANGES ==========
    if ('layoutMode' in targetNode && combinedText.includes('auto-layout')) {
      const frameNode = targetNode as FrameNode;
      if (combinedText.includes('horizontal') || combinedText.includes('row')) {
        frameNode.layoutMode = 'HORIZONTAL';
        appliedChanges.push('layout: horizontal');
      } else if (combinedText.includes('vertical') || combinedText.includes('column')) {
        frameNode.layoutMode = 'VERTICAL';
        appliedChanges.push('layout: vertical');
      }
    }
    
    // Handle alignment in auto-layout
    if ('primaryAxisAlignItems' in targetNode && combinedText.includes('center') && combinedText.includes('align')) {
      const frameNode = targetNode as FrameNode;
      frameNode.primaryAxisAlignItems = 'CENTER';
      frameNode.counterAxisAlignItems = 'CENTER';
      appliedChanges.push('alignment: centered');
    }
    
    // ========== RELATIVE ADJUSTMENTS ==========
    if (appliedChanges.length === 0) {
      // Increase/decrease padding
      if ((combinedText.includes('increase') || combinedText.includes('more') || combinedText.includes('add')) && combinedText.includes('padding')) {
        if ('paddingLeft' in targetNode) {
          const frameNode = targetNode as FrameNode;
          const increase = 8;
          frameNode.paddingLeft += increase;
          frameNode.paddingRight += increase;
          frameNode.paddingTop += increase;
          frameNode.paddingBottom += increase;
          appliedChanges.push(`increased padding by ${increase}px`);
        }
      }
      
      if ((combinedText.includes('decrease') || combinedText.includes('less') || combinedText.includes('reduce')) && combinedText.includes('padding')) {
        if ('paddingLeft' in targetNode) {
          const frameNode = targetNode as FrameNode;
          const decrease = 4;
          frameNode.paddingLeft = Math.max(0, frameNode.paddingLeft - decrease);
          frameNode.paddingRight = Math.max(0, frameNode.paddingRight - decrease);
          frameNode.paddingTop = Math.max(0, frameNode.paddingTop - decrease);
          frameNode.paddingBottom = Math.max(0, frameNode.paddingBottom - decrease);
          appliedChanges.push(`decreased padding by ${decrease}px`);
        }
      }
      
      // Increase/decrease spacing
      if ((combinedText.includes('increase') || combinedText.includes('more') || combinedText.includes('add')) && combinedText.includes('spacing')) {
        if ('itemSpacing' in targetNode) {
          const frameNode = targetNode as FrameNode;
          frameNode.itemSpacing += 8;
          appliedChanges.push(`increased spacing to ${frameNode.itemSpacing}px`);
        }
      }
      
      if ((combinedText.includes('decrease') || combinedText.includes('less') || combinedText.includes('reduce')) && combinedText.includes('spacing')) {
        if ('itemSpacing' in targetNode) {
          const frameNode = targetNode as FrameNode;
          frameNode.itemSpacing = Math.max(0, frameNode.itemSpacing - 4);
          appliedChanges.push(`decreased spacing to ${frameNode.itemSpacing}px`);
        }
      }
      
      // Corner radius adjustments
      if ((combinedText.includes('round') || combinedText.includes('radius')) && 'cornerRadius' in targetNode) {
        const roundable = targetNode as any;
        if (combinedText.includes('more') || combinedText.includes('increase')) {
          roundable.cornerRadius = (roundable.cornerRadius || 0) + 4;
          appliedChanges.push(`corner-radius: ${roundable.cornerRadius}px`);
        } else if (combinedText.includes('less') || combinedText.includes('decrease') || combinedText.includes('remove')) {
          roundable.cornerRadius = Math.max(0, (roundable.cornerRadius || 0) - 4);
          appliedChanges.push(`corner-radius: ${roundable.cornerRadius}px`);
        } else {
          // Just "add rounding" - set a default
          roundable.cornerRadius = 8;
          appliedChanges.push(`corner-radius: 8px`);
        }
      }
    }
    
    // If we made changes, notify and return success
    if (appliedChanges.length > 0) {
      figma.notify(`✅ Applied: ${appliedChanges.join(', ')}`);
      return { success: true, applied: appliedChanges };
    }
    
    // No changes could be applied automatically - select for manual edit
    figma.notify('ℹ️ Selecting element for manual edit');
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

// Remove automatic selection listener - selection is now captured on-demand
// when user clicks the selection box in the UI

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