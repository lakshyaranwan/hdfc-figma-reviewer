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

// Track extracted node count to cap payload size
let _extractedNodeCount = 0;
const MAX_EXTRACTED_NODES = 2000;

// Extract design data from a node recursively
function extractNodeData(node: SceneNode, depth: number = 0): DesignNode | null {
  if (depth > 20) return null; // Safety limit only — allow full depth traversal
  if (_extractedNodeCount >= MAX_EXTRACTED_NODES) return null; // Cap total nodes
  
  // Skip hidden layers/elements
  if (!node.visible) return null;
  
  // Skip elements with opacity set to 0
  if ('opacity' in node && node.opacity === 0) return null;
  
  _extractedNodeCount++;
  
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

  // Visual details — include at ALL depths for thorough analysis
  {
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
  }

  // Text properties (always include - they're lightweight and important)
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
  if ('children' in node && _extractedNodeCount < MAX_EXTRACTED_NODES) {
    const children: DesignNode[] = [];
    for (const child of node.children) {
      if (_extractedNodeCount >= MAX_EXTRACTED_NODES) break;
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

  // Reset node counter before extraction
  _extractedNodeCount = 0;
  
  const nodes: DesignNode[] = [];
  for (const node of selection) {
    if (_extractedNodeCount >= MAX_EXTRACTED_NODES) break;
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

// Find a node by ID using Figma's direct lookup (O(1) instead of tree traversal)
function findNodeById(nodeId: string): SceneNode | null {
  try {
    const node = figma.getNodeById(nodeId);
    if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
      return node as SceneNode;
    }
  } catch (e) {
    // fallback silently
  }
  return null;
}

// Cache for node name lookups (populated during selection) - supports duplicate names
const _nodeNameCache: Map<string, string[]> = new Map();
// Store the root node IDs from the last analysis to disambiguate duplicates
let _analysisRootIds: string[] = [];

// Helper: check if a node is a descendant of any analysis root
function isDescendantOfRoot(node: BaseNode): boolean {
  if (_analysisRootIds.length === 0) return false;
  let current: BaseNode | null = node;
  while (current) {
    if (_analysisRootIds.includes(current.id)) return true;
    current = current.parent;
  }
  return false;
}

// Find a node by name - uses cache first, then limited search
function findNodeByName(name: string): SceneNode | null {
  // Check cache first
  const cachedIds = _nodeNameCache.get(name);
  if (cachedIds && cachedIds.length > 0) {
    // Prefer nodes that are descendants of the analysis root
    for (const id of cachedIds) {
      const node = findNodeById(id);
      if (node && isDescendantOfRoot(node)) return node;
    }
    // Fallback to first valid
    for (const id of cachedIds) {
      const node = findNodeById(id);
      if (node) return node;
    }
  }
  
  // Check current selection only (avoid full page scan)
  for (const node of figma.currentPage.selection) {
    if (node.name === name) return node;
    if ('findOne' in node) {
      const found = (node as FrameNode).findOne(n => n.name === name);
      if (found) {
        const existing = _nodeNameCache.get(name) || [];
        if (!existing.includes(found.id)) existing.push(found.id);
        _nodeNameCache.set(name, existing);
        return found;
      }
    }
  }
  return null;
}

// Build name cache from extracted nodes (supports multiple IDs per name)
function cacheNodeNames(nodes: DesignNode[]) {
  _nodeNameCache.clear();
  function walk(node: DesignNode) {
    if (node.name && node.id) {
      const existing = _nodeNameCache.get(node.name) || [];
      existing.push(node.id);
      _nodeNameCache.set(node.name, existing);
    }
    if (node.children) node.children.forEach(walk);
  }
  nodes.forEach(walk);
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

// ========== ACCESSIBILITY: Contrast Checking ==========

// Convert sRGB channel (0-1) to linear
function sRGBtoLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Relative luminance per WCAG 2.x
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * sRGBtoLinear(r) + 0.7152 * sRGBtoLinear(g) + 0.0722 * sRGBtoLinear(b);
}

// Contrast ratio between two luminances (returns value >= 1)
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Get the effective fill color from a node (solid only — gradients handled separately)
function getNodeFillColor(node: SceneNode): { r: number; g: number; b: number } | null {
  if (!('fills' in node)) return null;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return null;
  for (const fill of fills as readonly Paint[]) {
    if (fill.visible === false) continue;
    const opacity = fill.opacity ?? 1;
    if (fill.type === 'SOLID') {
      return { r: fill.color.r * opacity, g: fill.color.g * opacity, b: fill.color.b * opacity };
    }
  }
  return null;
}

// Check if a node has a gradient fill
function hasGradientFill(node: SceneNode): boolean {
  if (!('fills' in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return false;
  for (const fill of fills as readonly Paint[]) {
    if (fill.visible === false) continue;
    if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL' || fill.type === 'GRADIENT_ANGULAR' || fill.type === 'GRADIENT_DIAMOND') {
      return true;
    }
  }
  return false;
}

// Check if a node has an image fill (which we can't resolve to a color)
function hasImageFill(node: SceneNode): boolean {
  if (!('fills' in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return false;
  for (const fill of fills as readonly Paint[]) {
    if (fill.visible === false) continue;
    if (fill.type === 'IMAGE') return true;
  }
  return false;
}

// Walk up parent chain to find background color
// Returns null if background cannot be determined (image fills, no fills at all)
// Also returns gradientParentId if the background is a gradient (needs export-based sampling)
function getBackgroundColor(node: SceneNode): { r: number; g: number; b: number; gradientParentId?: string } | null {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    const sceneNode = current as SceneNode;
    // If a parent has an image fill, we can't determine the bg color
    if (hasImageFill(sceneNode)) return null;
    // Check for gradient fills — flag for export-based sampling
    if (hasGradientFill(sceneNode)) {
      return { r: -1, g: -1, b: -1, gradientParentId: sceneNode.id };
    }
    const color = getNodeFillColor(sceneNode);
    if (color) return color;
    current = current.parent;
  }
  // No background found at all - return null instead of assuming white
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

interface AccessibilityIssue {
  nodeId: string;
  nodeName: string;
  type: 'text_contrast' | 'icon_contrast';
  text: string;
  ratio: number;
  required: number;
  fgColor: string;
  bgColor: string;
  fontSize: number;
  pass: boolean;
}

// Run text contrast audit on selected nodes
// Returns solid-bg issues immediately; gradient-bg issues are sent to UI for async export-based sampling
function runTextContrastAudit(nodes: readonly SceneNode[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  const gradientChecks: { textNodeId: string; gradientParentId: string; fgColor: { r: number; g: number; b: number }; nodeName: string; text: string; fontSize: number }[] = [];

  function walk(node: SceneNode) {
    if (!node.visible) return;
    if ('opacity' in node && node.opacity === 0) return;

    if (node.type === 'TEXT') {
      const textNode = node as TextNode;
      const fgColor = getNodeFillColor(textNode);
      if (!fgColor) return; // no fill to check

      const bgColor = getBackgroundColor(textNode);
      if (!bgColor) return; // Can't determine background (image fill, etc.) - skip to avoid false positives

      const fontSize = textNode.fontSize !== figma.mixed ? (textNode.fontSize as number) : 14;

      // Gradient background — defer to export-based sampling
      if (bgColor.gradientParentId) {
        gradientChecks.push({
          textNodeId: textNode.id,
          gradientParentId: bgColor.gradientParentId,
          fgColor,
          nodeName: textNode.name,
          text: textNode.characters.substring(0, 60),
          fontSize: Math.round(fontSize),
        });
        return;
      }

      const fgLum = relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
      const bgLum = relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
      const ratio = contrastRatio(fgLum, bgLum);

      // WCAG AA: 4.5:1 for ALL text (no large text exception)
      const required = 4.5;

      issues.push({
        nodeId: textNode.id,
        nodeName: textNode.name,
        type: 'text_contrast',
        text: textNode.characters.substring(0, 60),
        ratio: Math.round(ratio * 100) / 100,
        required,
        fgColor: rgbToHex(fgColor.r, fgColor.g, fgColor.b),
        bgColor: rgbToHex(bgColor.r, bgColor.g, bgColor.b),
        fontSize: Math.round(fontSize),
        pass: ratio >= required,
      });
    }

    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        walk(child);
      }
    }
  }

  for (const node of nodes) {
    walk(node);
  }

  // Send gradient checks to UI for async export-based sampling
  if (gradientChecks.length > 0) {
    figma.ui.postMessage({ type: 'gradient-checks-pending', checks: gradientChecks });
    // Trigger exports for each gradient check
    for (const check of gradientChecks) {
      figma.ui.postMessage({
        type: 'trigger-gradient-export',
        textNodeId: check.textNodeId,
        gradientParentId: check.gradientParentId,
        fgColor: check.fgColor,
        nodeName: check.nodeName,
        text: check.text,
        fontSize: check.fontSize,
      });
    }
  }

  return issues;
}

// Icon / non-text contrast audit (3:1 for shapes, vectors, icons)
function runIconContrastAudit(nodes: readonly SceneNode[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  const iconTypes: string[] = ['VECTOR', 'STAR', 'POLYGON', 'ELLIPSE', 'RECTANGLE', 'LINE', 'BOOLEAN_OPERATION'];

  // Check if a vector node looks like an outlined text glyph (flattened text)
  function isOutlinedTextGlyph(node: SceneNode): boolean {
    if (node.type !== 'VECTOR') return false;
    const parent = node.parent;
    if (!parent || parent.type === 'PAGE' || parent.type === 'DOCUMENT') return false;

    // Single-character generic names like "Vector", letter names, or digit names suggest outlined text
    const name = node.name.trim();
    const isGenericName = name === 'Vector' || name.length === 1;

    // Check if parent is a group/frame with multiple similar small vectors (typical of outlined text)
    if ('children' in parent) {
      const siblings = (parent as FrameNode).children;
      if (siblings.length >= 2) {
        const vectorSiblings = siblings.filter(s => s.type === 'VECTOR' && s.visible);
        // If most siblings are vectors with generic names, this is likely outlined text
        if (vectorSiblings.length >= 2) {
          const genericCount = vectorSiblings.filter(s => s.name.trim() === 'Vector' || s.name.trim().length === 1).length;
          if (genericCount >= vectorSiblings.length * 0.5) return true;
        }
      }
    }

    // Very small vectors (< 24px in both dimensions) with generic "Vector" name inside a group
    if (isGenericName) {
      const w = 'width' in node ? (node as any).width : 0;
      const h = 'height' in node ? (node as any).height : 0;
      if (w < 24 && h < 24 && parent.type === 'GROUP') return true;
    }

    return false;
  }

  function walk(node: SceneNode) {
    if (!node.visible) return;
    if ('opacity' in node && node.opacity === 0) return;

    if (iconTypes.includes(node.type)) {
      // Skip vectors that are part of outlined/flattened text
      if (isOutlinedTextGlyph(node)) return;

      const fgColor = getNodeFillColor(node);
      if (!fgColor) return;

      const bgColor = getBackgroundColor(node);
      if (!bgColor) return; // Can't determine background - skip to avoid false positives
      const fgLum = relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
      const bgLum = relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
      const ratio = contrastRatio(fgLum, bgLum);
      const required = 3;

      const w = 'width' in node ? (node as any).width : 0;
      const h = 'height' in node ? (node as any).height : 0;

      issues.push({
        nodeId: node.id,
        nodeName: node.name,
        type: 'icon_contrast',
        text: `${Math.round(w)}×${Math.round(h)}`,
        ratio: Math.round(ratio * 100) / 100,
        required,
        fgColor: rgbToHex(fgColor.r, fgColor.g, fgColor.b),
        bgColor: rgbToHex(bgColor.r, bgColor.g, bgColor.b),
        fontSize: 0,
        pass: ratio >= required,
      });
    }

    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        walk(child);
      }
    }
  }

  for (const node of nodes) {
    walk(node);
  }

  return issues;
}

// Do NOT send initial selection data - selection is captured on-demand only
// when user clicks the selection box in the UI

// Handle messages from UI
figma.ui.onmessage = async (msg: any) => {
  if (msg.type === 'get-selection') {
    const data = getSelectionData();
    if (data.nodes) cacheNodeNames(data.nodes);
    _analysisRootIds = figma.currentPage.selection.map(n => n.id);
    figma.ui.postMessage({
      type: 'selection-data',
      data,
    });
  }

  if (msg.type === 'analyze') {
    // Send current selection data for analysis
    const selectionData = getSelectionData();
    if (selectionData.nodes) cacheNodeNames(selectionData.nodes);
    _analysisRootIds = figma.currentPage.selection.map(n => n.id);
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
      
      // Handle instance node IDs like "I9:123;456:789" - try each part
      if (!targetNode && (msg.nodeId.startsWith('I') || msg.nodeId.includes(';'))) {
        const cleanId = msg.nodeId.startsWith('I') ? msg.nodeId.substring(1) : msg.nodeId;
        const parts = cleanId.split(';');
        for (let i = parts.length - 1; i >= 0; i--) {
          targetNode = findNodeById(parts[i]);
          if (targetNode) break;
        }
      }
    }
    
    // Try the name cache - prefer nodes under the analysis root
    if (!targetNode && msg.location) {
      const cachedIds = _nodeNameCache.get(msg.location);
      if (cachedIds) {
        // Prefer descendant of analysis root
        for (const id of cachedIds) {
          const node = findNodeById(id);
          if (node && isDescendantOfRoot(node)) { targetNode = node; break; }
        }
        if (!targetNode) {
          for (const id of cachedIds) {
            const node = findNodeById(id);
            if (node) { targetNode = node; break; }
          }
        }
      }
      // Partial cache match - prefer descendants of root
      if (!targetNode) {
        const searchLower = msg.location.toLowerCase();
        let fallback: SceneNode | null = null;
        for (const [name, ids] of _nodeNameCache.entries()) {
          const nameLower = name.toLowerCase();
          if (nameLower === searchLower || nameLower.includes(searchLower) || searchLower.includes(nameLower)) {
            for (const id of ids) {
              const found = findNodeById(id);
              if (found && isDescendantOfRoot(found)) { targetNode = found; break; }
              if (found && !fallback) fallback = found;
            }
            if (targetNode) break;
          }
        }
        if (!targetNode && fallback) targetNode = fallback;
      }
    }
    
    // Try by location/name within current selection
    if (!targetNode && msg.location) {
      targetNode = findNodeByName(msg.location);
    }
    
    // Search the entire current page - prefer descendants of analysis root
    if (!targetNode && msg.location) {
      const searchName = msg.location.toLowerCase();
      try {
        let fallback: SceneNode | null = null;
        figma.currentPage.findOne(n => {
          const nLower = n.name.toLowerCase();
          const match = nLower === searchName || nLower.includes(searchName) || searchName.includes(nLower);
          if (match) {
            if (isDescendantOfRoot(n)) { targetNode = n; return true; }
            if (!fallback) fallback = n;
          }
          return false;
        });
        if (!targetNode && fallback) targetNode = fallback;
      } catch (e) {
        // Page-level search may fail on very large files
      }
    }
    
    if (targetNode) {
      figma.currentPage.selection = [targetNode];
      figma.viewport.scrollAndZoomIntoView([targetNode]);
      figma.notify(`🎯 Focused on: ${targetNode.name}`);
    } else {
      figma.notify('⚠️ Could not find the element. It may have been deleted or renamed.');
    }
  }

  if (msg.type === 'run-accessibility-check') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'accessibility-results', issues: [], error: 'No selection. Select a frame first.' });
      return;
    }
    const checkText = msg.checkText !== false;
    const checkIcon = msg.checkIcon !== false;
    const textIssues = checkText ? runTextContrastAudit(selection) : [];
    const iconIssues = checkIcon ? runIconContrastAudit(selection) : [];
    const issues = [...textIssues, ...iconIssues];
    figma.ui.postMessage({ type: 'accessibility-results', issues });
    const failCount = issues.filter(i => !i.pass).length;
    figma.notify(failCount > 0 ? `⚠️ ${failCount} contrast issue${failCount > 1 ? 's' : ''} found` : '✅ All elements pass contrast check');
  }

  if (msg.type === 'get-selection-for-a11y-ai') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'accessibility-results', issues: [], error: 'No selection. Select a frame first.' });
      return;
    }

    // Use a deeper extraction for A11y — more nodes, more depth, capture all interactive elements
    const A11Y_MAX_DEPTH = 12;
    const A11Y_MAX_NODES = 2000;
    let a11yNodeCount = 0;

    function extractA11yNode(node: SceneNode, depth: number, parentPathStr: string): any | null {
      if (depth > A11Y_MAX_DEPTH) return null;
      if (a11yNodeCount >= A11Y_MAX_NODES) return null;
      if (!node.visible) return null;
      if ('opacity' in node && node.opacity === 0) return null;

      a11yNodeCount++;

      const textContent = node.type === 'TEXT' ? (node as TextNode).characters.trim() : undefined;
      const pathLabel = textContent || node.name || node.type;
      const currentPath = parentPathStr ? `${parentPathStr} > ${pathLabel}` : pathLabel;

      const n: any = {
        id: node.id,
        name: node.name,   // Figma layer name — INTERNAL ONLY, never use as label content
        type: node.type,
        path: currentPath,
      };

      if (textContent) n.characters = textContent;
      if ('x' in node) n.x = Math.round((node as any).x);
      if ('y' in node) n.y = Math.round((node as any).y);
      if ('width' in node) n.width = Math.round((node as any).width);
      if ('height' in node) n.height = Math.round((node as any).height);
      if (node.type === 'TEXT') {
        const t = node as TextNode;
        if (t.fontSize !== figma.mixed) n.fontSize = t.fontSize;
      }
      if ('cornerRadius' in node && (node as any).cornerRadius !== figma.mixed) {
        n.cornerRadius = (node as any).cornerRadius;
      }
      if ('fills' in node && (node as any).fills !== figma.mixed) {
        const fills = (node as any).fills as readonly Paint[];
        n.fills = fills.filter(f => f.visible !== false).map(f => ({ type: f.type }));
      }
      if ('layoutMode' in node) n.layoutMode = (node as any).layoutMode;

      let childNodes: any[] = [];
      if ('children' in node && a11yNodeCount < A11Y_MAX_NODES) {
        for (const child of (node as FrameNode).children) {
          if (a11yNodeCount >= A11Y_MAX_NODES) break;
          const childData = extractA11yNode(child, depth + 1, currentPath);
          if (childData) childNodes.push(childData);
        }
        if (childNodes.length > 0) n.children = childNodes;
      }

      // Aggregate all visible text in subtree into allText — used by AI for label construction
      // This prevents the AI from falling back to layerName
      if (node.type !== 'TEXT') {
        const texts: { text: string; y: number; x: number }[] = [];
        function collectTexts(child: any) {
          if (child.characters) texts.push({ text: child.characters, y: child.y ?? 0, x: child.x ?? 0 });
          if (child.children) child.children.forEach(collectTexts);
        }
        childNodes.forEach(collectTexts);
        texts.sort((a, b) => a.y - b.y || a.x - b.x);
        if (texts.length > 0) n.allText = texts.map(t => t.text).join(' · ');
      }

      // Signal icon-only interactive elements (no text, roughly square, small, has fills)
      if (!textContent && !n.allText) {
        const w = n.width ?? 0;
        const h = n.height ?? 0;
        if (w > 0 && h > 0 && Math.abs(w - h) <= w * 0.3 && w <= 60 && n.fills && n.fills.length > 0) {
          n._isIconButton = true;
        }
      }

      return n;
    }

    a11yNodeCount = 0;
    const nodes: any[] = [];
    for (const node of selection) {
      if (a11yNodeCount >= A11Y_MAX_NODES) break;
      const data = extractA11yNode(node, 0, '');
      if (data) nodes.push(data);
    }

    // Post-process: annotate nodes with structural interactivity signals
    function annotateInteractivity(node: any, siblings: any[] = []): void {
      if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
        node._isComponent = true;
      }

      if (siblings.length >= 3) {
        const sameSizeCount = siblings.filter(s =>
          Math.abs((s.width || 0) - (node.width || 0)) < 10 &&
          Math.abs((s.height || 0) - (node.height || 0)) < 10
        ).length;
        if (sameSizeCount >= 3) {
          node._inRepeatingGroup = true;
          node._repeatingSiblingCount = sameSizeCount;
        }
      }

      const children = node.children || [];
      const hasOnlyTextChildren = children.length > 0 && children.every((c: any) => c.type === 'TEXT');
      if (hasOnlyTextChildren || children.length === 0) {
        node._isLeaf = true;
      }

      // Sort children by visual position (y then x) so the AI always
      // receives siblings in top-left → bottom-right order regardless
      // of how the designer stacked layers in Figma.
      if (children.length > 1) {
        children.sort((a: any, b: any) => {
          const ay = a.y ?? 0, by = b.y ?? 0;
          if (Math.abs(ay - by) > 8) return ay - by;   // Different rows
          return (a.x ?? 0) - (b.x ?? 0);              // Same row → left to right
        });
        node.children = children;
      }

      for (let i = 0; i < children.length; i++) {
        annotateInteractivity(children[i], children);
      }
    }

    for (const node of nodes) {
      annotateInteractivity(node, []);
    }

    // Also sort top-level nodes spatially before sending
    nodes.sort((a: any, b: any) => {
      const ay = a.y ?? 0, by = b.y ?? 0;
      if (Math.abs(ay - by) > 8) return ay - by;
      return (a.x ?? 0) - (b.x ?? 0);
    });

    figma.ui.postMessage({
      type: 'selection-for-a11y-ai',
      data: {
        nodes,
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
      },
      checkAria: msg.checkAria,
      checkFocus: msg.checkFocus,
    });
  }

  if (msg.type === 'write-a11y-annotations') {
    const results: any[] = msg.results || [];
    const checkType: string = msg.checkType;
    let annotated = 0;

    for (const item of results) {
      if (!item.nodeId) continue;
      const node = figma.getNodeById(item.nodeId) as SceneNode | null;
      if (!node) continue;

      try {
        if (checkType === 'aria') {
          // Write ARIA label + role as plugin data on the node
          node.setPluginData('ariaLabel', item.ariaLabel || '');
          node.setPluginData('ariaRole', item.role || '');
          node.setPluginData('ariaContext', item.context || '');
          annotated++;
        } else if (checkType === 'focus_order') {
          // Write focus index, role, aria label as plugin data
          node.setPluginData('focusIndex', String(item.focusIndex || ''));
          node.setPluginData('focusRole', item.role || '');
          node.setPluginData('focusAriaLabel', item.ariaLabel || '');
          node.setPluginData('focusRationale', item.rationale || '');
          annotated++;
        }
      } catch (e) {
        // Some nodes may not support plugin data (e.g. locked/external)
      }
    }

    const label = checkType === 'aria' ? 'ARIA labels' : 'focus order annotations';
    figma.notify(`✅ ${annotated} ${label} written to ${annotated === 1 ? 'element' : 'elements'}`);
    figma.ui.postMessage({
      type: 'a11y-ai-annotate-done',
      message: `${annotated} ${label} written to Figma`,
    });
  }

  if (msg.type === 'create-annotation') {
    try {
      const { interaction, role, label } = msg;

      // Get viewport center
      const vp = figma.viewport.center;

      // Card dimensions
      const CARD_WIDTH = 280;
      const CARD_PADDING = 16;
      const PILL_HEIGHT = 24;
      const TEXT_LINE_HEIGHT = 22;
      const SECTION_GAP = 16;

      // Calculate sections needed
      const sections: { pillText: string; pillColor: { r: number; g: number; b: number }; bodyText: string }[] = [];
      if (interaction) sections.push({ pillText: 'Interaction', pillColor: { r: 0.8, g: 0.33, b: 0.8 }, bodyText: interaction });
      if (role) sections.push({ pillText: 'Role/State', pillColor: { r: 0.2, g: 0.7, b: 0.4 }, bodyText: role });
      if (label) sections.push({ pillText: 'Label', pillColor: { r: 0.85, g: 0.35, b: 0.2 }, bodyText: label });

      if (sections.length === 0) return;

      // Estimate card height
      const sectionHeight = PILL_HEIGHT + 8 + TEXT_LINE_HEIGHT * 2; // pill + gap + ~2 lines of body text
      const totalHeight = CARD_PADDING * 2 + sections.length * sectionHeight + (sections.length - 1) * SECTION_GAP;

      // Create main card frame
      const card = figma.createFrame();
      card.name = '📝 A11y Annotation';
      card.resize(CARD_WIDTH, totalHeight);
      card.x = vp.x - CARD_WIDTH / 2;
      card.y = vp.y - totalHeight / 2;
      card.cornerRadius = 12;
      card.fills = [{ type: 'SOLID', color: { r: 0.18, g: 0.18, b: 0.2 } }];
      card.layoutMode = 'VERTICAL';
      card.paddingLeft = CARD_PADDING;
      card.paddingRight = CARD_PADDING;
      card.paddingTop = CARD_PADDING;
      card.paddingBottom = CARD_PADDING;
      card.itemSpacing = SECTION_GAP;
      card.primaryAxisSizingMode = 'AUTO';

      // Load font
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });

      for (const section of sections) {
        // Section container
        const sectionFrame = figma.createFrame();
        sectionFrame.name = section.pillText;
        sectionFrame.layoutMode = 'VERTICAL';
        sectionFrame.itemSpacing = 8;
        sectionFrame.fills = [];
        sectionFrame.layoutSizingHorizontal = 'FILL';
        sectionFrame.primaryAxisSizingMode = 'AUTO';

        // Pill
        const pill = figma.createFrame();
        pill.name = 'Pill';
        pill.layoutMode = 'HORIZONTAL';
        pill.paddingLeft = 12;
        pill.paddingRight = 12;
        pill.paddingTop = 4;
        pill.paddingBottom = 4;
        pill.cornerRadius = 12;
        pill.fills = [{ type: 'SOLID', color: section.pillColor }];
        pill.primaryAxisSizingMode = 'AUTO';
        pill.counterAxisSizingMode = 'AUTO';

        const pillText = figma.createText();
        pillText.fontName = { family: 'Inter', style: 'Semi Bold' };
        pillText.characters = section.pillText;
        pillText.fontSize = 11;
        pillText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        pill.appendChild(pillText);

        sectionFrame.appendChild(pill);

        // Body text
        const bodyText = figma.createText();
        bodyText.fontName = { family: 'Inter', style: 'Regular' };
        bodyText.characters = section.bodyText;
        bodyText.fontSize = 16;
        bodyText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        bodyText.layoutSizingHorizontal = 'FILL';
        bodyText.textAutoResize = 'HEIGHT';

        sectionFrame.appendChild(bodyText);
        card.appendChild(sectionFrame);
      }

      // Select and scroll to the annotation
      figma.currentPage.appendChild(card);
      figma.currentPage.selection = [card];
      figma.viewport.scrollAndZoomIntoView([card]);
      figma.notify('📝 Annotation placed at viewport center');
    } catch (e) {
      console.error('Annotation creation failed:', e);
      figma.notify('❌ Failed to create annotation: ' + (e as Error).message);
    }
  }

  if (msg.type === 'export-gradient-region') {
    // Export a gradient parent node's region under a text node for contrast sampling
    try {
      const textNode = figma.getNodeById(msg.textNodeId) as SceneNode | null;
      const gradientParent = figma.getNodeById(msg.gradientParentId) as SceneNode | null;
      if (!textNode || !gradientParent) {
        figma.ui.postMessage({ type: 'gradient-sample-result', textNodeId: msg.textNodeId, error: 'Node not found' });
        return;
      }

      // Hide text node temporarily so we only sample background
      const origVisible = textNode.visible;
      textNode.visible = false;

      let imageBytes: Uint8Array;
      try {
        imageBytes = await (gradientParent as any).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 0.25 } });
      } finally {
        textNode.visible = origVisible;
      }

      // Get bounding boxes to compute crop region
      const parentBB = (gradientParent as any).absoluteBoundingBox;
      const textBB = (textNode as any).absoluteBoundingBox;
      if (!parentBB || !textBB) {
        figma.ui.postMessage({ type: 'gradient-sample-result', textNodeId: msg.textNodeId, error: 'No bounding box' });
        return;
      }

      // Crop coordinates relative to exported image (which is at 0.25 scale)
      const scale = 0.25;
      const cropX = Math.max(0, Math.round((textBB.x - parentBB.x) * scale));
      const cropY = Math.max(0, Math.round((textBB.y - parentBB.y) * scale));
      const cropW = Math.max(1, Math.round(textBB.width * scale));
      const cropH = Math.max(1, Math.round(textBB.height * scale));

      // Send the image bytes + crop info to UI for canvas sampling
      figma.ui.postMessage({
        type: 'gradient-sample-result',
        textNodeId: msg.textNodeId,
        imageBytes: Array.from(imageBytes),
        cropX, cropY, cropW, cropH,
        fgColor: msg.fgColor
      });
    } catch (e) {
      figma.ui.postMessage({ type: 'gradient-sample-result', textNodeId: msg.textNodeId, error: (e as Error).message });
    }
  }

  if (msg.type === 'notify') {
    figma.notify(msg.message);
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};