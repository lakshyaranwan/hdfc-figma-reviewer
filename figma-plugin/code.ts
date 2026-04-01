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

// Track extracted node count (no hard cap — chunking handles large payloads)
let _extractedNodeCount = 0;
const MAX_RECURSION_DEPTH = 12;

// Count total visible nodes in a subtree (for reporting)
function countVisibleNodes(node: SceneNode): number {
  if (!node.visible) return 0;
  if ('opacity' in node && node.opacity === 0) return 0;
  let count = 1;
  if ('children' in node) {
    for (const child of (node as FrameNode).children) {
      count += countVisibleNodes(child);
    }
  }
  return count;
}

// Extract design data from a node recursively
function extractNodeData(node: SceneNode, depth: number = 0): DesignNode | null {
  if (depth > MAX_RECURSION_DEPTH) return null;
  
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

  // Only include visual details for shallow nodes (top 4 levels)
  if (depth < 4) {
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

  // Text properties — ALWAYS include regardless of depth (critical for color/style audits)
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    baseData.characters = textNode.characters;
    if (textNode.fontSize !== figma.mixed) baseData.fontSize = textNode.fontSize;
    if (textNode.fontName !== figma.mixed) baseData.fontName = textNode.fontName;
    if (textNode.textAlignHorizontal) baseData.textAlignHorizontal = textNode.textAlignHorizontal;
    if (textNode.textAlignVertical) baseData.textAlignVertical = textNode.textAlignVertical;

    // ALWAYS capture fills for text nodes at any depth — needed for color token audit
    if (textNode.fills !== figma.mixed && (textNode.fills as readonly Paint[]).length > 0) {
      baseData.fills = (textNode.fills as readonly Paint[]).map(fill => {
        const r = 'color' in fill && fill.color ? Math.round(fill.color.r * 255) : 0;
        const g = 'color' in fill && fill.color ? Math.round(fill.color.g * 255) : 0;
        const b = 'color' in fill && fill.color ? Math.round(fill.color.b * 255) : 0;
        const hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
        return {
          type: fill.type,
          visible: fill.visible,
          opacity: fill.opacity,
          color: 'color' in fill ? fill.color : undefined,
          hex,
        };
      });
    }

    // Bound DS text style — if set, this node is already using a DS style correctly
    if (textNode.textStyleId && textNode.textStyleId !== figma.mixed) {
      (baseData as any).textStyleId = textNode.textStyleId;
      (baseData as any).textStyleName = figma.getStyleById(textNode.textStyleId as string)?.name || null;
    }
    // Bound DS color/fill style — if set, this fill is already a DS token
    if ('fillStyleId' in textNode && textNode.fillStyleId && textNode.fillStyleId !== figma.mixed) {
      (baseData as any).fillStyleId = textNode.fillStyleId;
      (baseData as any).fillStyleName = figma.getStyleById(textNode.fillStyleId as string)?.name || null;
    }
  }

  // Capture fill/stroke style IDs for non-text nodes too
  if (node.type !== 'TEXT') {
    if ('fillStyleId' in node && (node as any).fillStyleId && (node as any).fillStyleId !== figma.mixed) {
      (baseData as any).fillStyleId = (node as any).fillStyleId;
      (baseData as any).fillStyleName = figma.getStyleById((node as any).fillStyleId)?.name || null;
    }
    if ('strokeStyleId' in node && (node as any).strokeStyleId) {
      (baseData as any).strokeStyleId = (node as any).strokeStyleId;
      (baseData as any).strokeStyleName = figma.getStyleById((node as any).strokeStyleId)?.name || null;
    }
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

  // Reset node counter before extraction
  // Count total visible nodes across all selected frames
  let totalVisibleNodes = 0;
  for (const node of selection) {
    totalVisibleNodes += countVisibleNodes(node);
  }

  _extractedNodeCount = 0;
  
  const nodes: DesignNode[] = [];
  for (const node of selection) {
    const nodeData = extractNodeData(node);
    if (nodeData) nodes.push(nodeData);
  }

  console.log(`Extracted ${_extractedNodeCount} of ${totalVisibleNodes} visible nodes`);

  return {
    hasSelection: true,
    selectionCount: selection.length,
    extractedNodeCount: _extractedNodeCount,
    totalVisibleNodes,
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
            } catch (_e) {
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

// Get the effective fill color from a node (solid or gradient)
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
    // Handle gradients by averaging the color stops
    if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL' || fill.type === 'GRADIENT_ANGULAR' || fill.type === 'GRADIENT_DIAMOND') {
      const stops = (fill as GradientPaint).gradientStops;
      if (stops && stops.length > 0) {
        let r = 0, g = 0, b = 0;
        for (const stop of stops) {
          r += stop.color.r;
          g += stop.color.g;
          b += stop.color.b;
        }
        const n = stops.length;
        return { r: (r / n) * opacity, g: (g / n) * opacity, b: (b / n) * opacity };
      }
    }
  }
  return null;
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

// Check if a node has a gradient fill
function hasGradientFill(node: SceneNode): boolean {
  if (!('fills' in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return false;
  for (const fill of fills as readonly Paint[]) {
    if (fill.visible === false) continue;
    if (
      fill.type === 'GRADIENT_LINEAR' ||
      fill.type === 'GRADIENT_RADIAL' ||
      fill.type === 'GRADIENT_ANGULAR' ||
      fill.type === 'GRADIENT_DIAMOND'
    ) return true;
  }
  return false;
}

// Returns true if node has a fully-opaque solid fill that completely occludes anything behind it
function hasOpaqueSolidFill(node: SceneNode): boolean {
  if (!('fills' in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return false;
  for (const fill of fills as readonly Paint[]) {
    if (fill.visible === false) continue;
    if (fill.type === 'SOLID') {
      const fillOpacity = fill.opacity ?? 1;
      const nodeOpacity = ('opacity' in node) ? (node as any).opacity ?? 1 : 1;
      // Consider opaque if combined opacity >= 95%
      if (fillOpacity * nodeOpacity >= 0.95) return true;
    }
  }
  return false;
}

// Walk up parent chain to find background color
// Returns null if background cannot be determined (image fills, no fills at all, or gradient behind semi-transparent layer)
function getBackgroundColor(node: SceneNode): { r: number; g: number; b: number } | null {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    const sceneNode = current as SceneNode;
    // If a parent has an image fill, we can't determine the bg color
    if (hasImageFill(sceneNode)) return null;
    // Gradient fills: skip here (handled separately via pixel sampling)
    if (hasGradientFill(sceneNode)) return null;
    // Only return this color if the fill is fully opaque — semi-transparent fills
    // let the layers behind bleed through, so we can't rely on this color alone.
    if (hasOpaqueSolidFill(sceneNode)) {
      return getNodeFillColor(sceneNode);
    }
    current = current.parent;
  }
  // No background found at all - return null instead of assuming white
  return null;
}

// Walk up parent chain looking for the nearest ancestor with a gradient fill.
// Also returns the gradient parent if a semi-transparent solid fill sits between
// the text and the gradient (the gradient still bleeds through).
function getGradientBackgroundParent(node: SceneNode): SceneNode | null {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    const sceneNode = current as SceneNode;
    if (hasGradientFill(sceneNode)) return sceneNode;
    // Stop only if this layer is FULLY opaque — it completely hides what's behind it
    if (hasOpaqueSolidFill(sceneNode)) return null;
    // Semi-transparent fills don't fully occlude the gradient, keep walking
    current = current.parent;
  }
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

// Collect all TEXT nodes from a subtree
function collectTextNodes(nodes: readonly SceneNode[]): TextNode[] {
  const result: TextNode[] = [];
  function walk(node: SceneNode) {
    if (!node.visible) return;
    if ('opacity' in node && (node as any).opacity === 0) return;
    if (node.type === 'TEXT') result.push(node as TextNode);
    if ('children' in node) {
      for (const child of (node as FrameNode).children) walk(child);
    }
  }
  for (const node of nodes) walk(node);
  return result;
}

// Run text contrast audit on selected nodes (async to support gradient pixel-sampling)
async function runTextContrastAudit(nodes: readonly SceneNode[]): Promise<AccessibilityIssue[]> {
  const issues: AccessibilityIssue[] = [];
  const textNodes = collectTextNodes(nodes);

  for (const textNode of textNodes) {
    const fgColor = getNodeFillColor(textNode);
    if (!fgColor) continue;

    // Check if the background is a gradient — if so, use pixel sampling
    const gradientParent = getGradientBackgroundParent(textNode);
    if (gradientParent) {
      try {
        // Export the GRADIENT PARENT with the text node temporarily hidden,
        // so sampled pixels reflect only the background — not the text rendered on top.
        const wasVisible = textNode.visible;
        textNode.visible = false;
        let bytes: Uint8Array;
        try {
          bytes = await gradientParent.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
        } finally {
          textNode.visible = wasVisible; // always restore
        }
        const fgHex = rgbToHex(fgColor.r, fgColor.g, fgColor.b);
        const fontSize = textNode.fontSize !== figma.mixed ? (textNode.fontSize as number) : 14;

        // Compute text node's absolute bounds relative to the gradient parent
        const px = ('absoluteBoundingBox' in textNode && textNode.absoluteBoundingBox)
          ? textNode.absoluteBoundingBox.x - gradientParent.absoluteBoundingBox.x
          : textNode.x - ('x' in gradientParent ? gradientParent.x : 0);
        const py = ('absoluteBoundingBox' in textNode && textNode.absoluteBoundingBox)
          ? textNode.absoluteBoundingBox.y - gradientParent.absoluteBoundingBox.y
          : textNode.y - ('y' in gradientParent ? gradientParent.y : 0);
        const pw = 'width' in gradientParent ? gradientParent.width : 1;
        const ph = 'height' in gradientParent ? gradientParent.height : 1;
        const tw = textNode.width || pw;
        const th = textNode.height || ph;

        // Send image bytes + crop info to UI for pixel sampling
        figma.ui.postMessage({
          type: 'gradient-contrast-check',
          nodeId: textNode.id,
          nodeName: textNode.name,
          text: textNode.characters.substring(0, 60),
          fontSize: Math.round(fontSize),
          fgColor: fgHex,
          imageBytes: Array.from(bytes),
          // crop region as fractions [0,1] of the exported image
          cropX: Math.max(0, px / pw),
          cropY: Math.max(0, py / ph),
          cropW: Math.min(1, tw / pw),
          cropH: Math.min(1, th / ph),
        });
        // Result collected via canvas pixel-sampling in UI — skip pushing here
        continue;
      } catch (_e) {
        // Export failed — fall through to regular solid bg check
      }
    }

    const bgColor = getBackgroundColor(textNode);
    if (!bgColor) continue; // image fill or undetermined — skip
    const fgLum = relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
    const bgLum = relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
    const ratio = contrastRatio(fgLum, bgLum);

    // WCAG AA: 4.5:1 for ALL text (no large text exception)
    const fontSize = textNode.fontSize !== figma.mixed ? (textNode.fontSize as number) : 14;
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

  return issues;
}

// Module-level DS icon name set — populated from cache on startup and after each DS load
let _dsIconNames: Set<string> = new Set();

async function refreshDSIconNames(): Promise<void> {
  try {
    const raw = await figma.clientStorage.getAsync('ds_cache') as string | undefined;
    if (!raw) return;
    const ds = JSON.parse(raw);
    const names: string[] = (ds.summary && ds.summary.iconNames) ? ds.summary.iconNames : [];
    _dsIconNames = new Set(names);
  } catch (_e) {}
}

// Returns a trimmed DS context object safe to attach to AI messages (no credentials)
async function getDSContext(): Promise<any | null> {
  try {
    const raw = await figma.clientStorage.getAsync('ds_cache') as string | undefined;
    if (!raw) return null;
    const ds = JSON.parse(raw);
    const s = ds.summary || {};
    const slice = (arr: any[], n: number) => Array.isArray(arr) ? arr.slice(0, n) : [];
    return {
      componentNames:   slice(s.componentNames, 150),
      iconNames:        slice(s.iconNames, 100),
      colorNames:       slice(s.colorNames, 80),
      colorTokenMap:    s.colorTokenMap   || [],   // [{ name, hex }] for accurate AI matching
      textStyleNames:   slice(s.textStyleNames, 40),
      textStyleMap:     s.textStyleMap    || [],   // [{ name, family, size, weight }]
      effectStyleNames: slice(s.effectStyleNames, 20),
      libraryNames:     s.libraryNames || [],
      isCurrentFileOnly: ds.isCurrentFileOnly || false,
    };
  } catch (_e) { return null; }
}

// Icon / non-text contrast audit — only scans DS icon INSTANCES, not raw vectors
function runIconContrastAudit(nodes: readonly SceneNode[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];

  function isIconInstance(node: SceneNode): boolean {
    if (node.type !== 'INSTANCE') return false;
    const mc = (node as InstanceNode).mainComponent;
    if (!mc) return false;
    const name = mc.name.toLowerCase();
    // If DS is loaded, match against known icon names first, then fallback to heuristics
    if (_dsIconNames.size > 0) {
      return _dsIconNames.has(mc.name) ||
        name.indexOf('icon') !== -1 ||
        mc.name.indexOf('Icons/') === 0 ||
        mc.name.indexOf('ic_') === 0 ||
        mc.name.indexOf('Icon/') === 0;
    }
    // Fallback: name-based heuristic only
    return name.indexOf('icon') !== -1 || mc.name.indexOf('Icons/') === 0 || mc.name.indexOf('ic_') === 0 || mc.name.indexOf('Icon/') === 0;
  }

  // Walk into node children to find the first meaningful fill color.
  // Icon instances are containers — the actual fill is on an inner vector/shape.
  function getIconFillColor(node: SceneNode): { r: number; g: number; b: number } | null {
    // Try the node itself first
    const direct = getNodeFillColor(node);
    if (direct) return direct;

    // Recurse into children (limited depth)
    function walkForFill(n: SceneNode, depth: number): { r: number; g: number; b: number } | null {
      if (depth > 5) return null;
      if (!n.visible) return null;
      if ('opacity' in n && (n as any).opacity === 0) return null;
      const c = getNodeFillColor(n);
      if (c) return c;
      if ('children' in n) {
        for (const child of (n as FrameNode).children) {
          const found = walkForFill(child as SceneNode, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        const found = walkForFill(child as SceneNode, 0);
        if (found) return found;
      }
    }
    return null;
  }

  function checkIconContrast(node: InstanceNode): AccessibilityIssue | null {
    const fgColor = getIconFillColor(node);
    if (!fgColor) return null;
    const bgColor = getBackgroundColor(node);
    if (!bgColor) return null;
    const fgLum = relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
    const bgLum = relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
    const ratio = contrastRatio(fgLum, bgLum);
    const required = 3;
    const w = 'width' in node ? (node as any).width : 0;
    const h = 'height' in node ? (node as any).height : 0;
    return {
      nodeId: node.id,
      nodeName: node.name,
      type: 'icon_contrast',
      text: `${Math.round(w)}x${Math.round(h)}`,
      ratio: Math.round(ratio * 100) / 100,
      required,
      fgColor: rgbToHex(fgColor.r, fgColor.g, fgColor.b),
      bgColor: rgbToHex(bgColor.r, bgColor.g, bgColor.b),
      fontSize: 0,
      pass: ratio >= required,
    };
  }

  function auditNode(node: SceneNode) {
    if (!node.visible) return;
    if ('opacity' in node && (node as any).opacity === 0) return;

    if (isIconInstance(node)) {
      const result = checkIconContrast(node as InstanceNode);
      if (result) issues.push(result);
      return; // Don't recurse into icon internals
    }

    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        auditNode(child);
      }
    }
  }

  for (const node of nodes) auditNode(node);
  return issues;
}

// ============================================================
// DESIGN SYSTEM: Fetch full DS file via Figma REST API
// ============================================================

async function fetchAndCacheDS(fileKey: string, pat: string): Promise<void> {
  try {
    figma.notify('🔄 Loading design system from Figma API…');

    const response = await fetch(
      `https://api.figma.com/v1/files/${fileKey}?depth=2`,
      { headers: { 'X-Figma-Token': pat } }
    );

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        figma.notify('❌ Invalid PAT or no access to this file. Check your token.');
        figma.ui.postMessage({ type: 'ds-config-status', hasDS: false, error: 'Invalid token or no access to this Figma file. Make sure your Personal Access Token has read access.' });
      } else {
        figma.notify(`❌ Figma API error: ${response.status}`);
        figma.ui.postMessage({ type: 'ds-config-status', hasDS: false, error: `Figma API error ${response.status}` });
      }
      return;
    }

    const data = await response.json();
    const dsData = extractDSData(data, fileKey);

    await figma.clientStorage.setAsync('ds_file_key', fileKey);
    await figma.clientStorage.setAsync('figma_pat', pat);
    await figma.clientStorage.setAsync('ds_cache', JSON.stringify(dsData));
    await figma.clientStorage.setAsync('ds_cache_timestamp', String(Date.now()));

    figma.notify(`✅ DS loaded — ${dsData.componentCount} components · ${dsData.colorCount} colors · ${dsData.iconCount} icons`);
    const dsContextOnLoad = await getDSContext();
    figma.ui.postMessage({ type: 'ds-loaded', summary: dsData.summary, dsContext: dsContextOnLoad });

  } catch (e) {
    const msg = String(e);
    // A fetch TypeError usually means the domain is blocked by the sandbox
    const isNetworkBlock = msg.indexOf('TypeError') !== -1 || msg.indexOf('fetch') !== -1 || msg.indexOf('network') !== -1;
    if (isNetworkBlock) {
      figma.notify('❌ Network blocked. Re-import the plugin from manifest.json and try again.');
      figma.ui.postMessage({ type: 'ds-config-status', hasDS: false, error: 'Network request blocked. Please close the plugin, re-import it from the updated manifest.json in Figma (Plugins → Development → Import plugin from manifest), then try again.' });
    } else {
      figma.notify('❌ Failed to fetch DS file: ' + msg);
      figma.ui.postMessage({ type: 'ds-config-status', hasDS: false, error: msg });
    }
  }
}

function extractDSData(figmaFile: any, fileKey: string): any {
  // ── Styles from root-level styles map ─────────────────────────
  const paintStyles: any[] = [];
  const textStyles: any[] = [];
  const effectStyles: any[] = [];

  const stylesMap = figmaFile.styles || {};
  const styleKeys = Object.keys(stylesMap);
  for (let i = 0; i < styleKeys.length; i++) {
    const id = styleKeys[i];
    const s = stylesMap[id] as any;
    const entry = { id, name: s.name, key: s.key };
    if (s.styleType === 'FILL')   paintStyles.push(entry);
    if (s.styleType === 'TEXT')   textStyles.push(entry);
    if (s.styleType === 'EFFECT') effectStyles.push(entry);
  }

  // ── Components — walk all pages ───────────────────────────────
  const allComponents: any[] = [];
  const libraryMap: { [key: string]: any[] } = {};

  function walkNode(node: any, pageName: string): void {
    if (!node) return;
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      const entry = { key: node.key, name: node.name, page: pageName };
      allComponents.push(entry);
      if (!libraryMap[pageName]) libraryMap[pageName] = [];
      libraryMap[pageName].push(entry);
    }
    const children = node.children;
    if (children && children.length) {
      for (let i = 0; i < children.length; i++) {
        walkNode(children[i], pageName);
      }
    }
  }

  const pages = (figmaFile.document && figmaFile.document.children) ? figmaFile.document.children : [];
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageChildren = page.children || [];
    for (let c = 0; c < pageChildren.length; c++) {
      walkNode(pageChildren[c], page.name);
    }
  }

  // ── Icon components ─────────────────────────────────────────
  const iconComponents: any[] = [];
  for (let i = 0; i < allComponents.length; i++) {
    const comp = allComponents[i];
    if (
      comp.name.toLowerCase().indexOf('icon') !== -1 ||
      comp.name.indexOf('Icons/') === 0 ||
      comp.name.indexOf('ic_') === 0
    ) {
      iconComponents.push(comp);
    }
  }

  const colorNames: string[] = [];
  for (let i = 0; i < Math.min(paintStyles.length, 80); i++) colorNames.push(paintStyles[i].name);
  const textStyleNames: string[] = [];
  for (let i = 0; i < Math.min(textStyles.length, 40); i++) textStyleNames.push(textStyles[i].name);
  const effectStyleNames: string[] = [];
  for (let i = 0; i < Math.min(effectStyles.length, 20); i++) effectStyleNames.push(effectStyles[i].name);
  const componentNames: string[] = [];
  for (let i = 0; i < Math.min(allComponents.length, 150); i++) componentNames.push(allComponents[i].name);
  const iconNames: string[] = [];
  for (let i = 0; i < Math.min(iconComponents.length, 100); i++) iconNames.push(iconComponents[i].name);

  // ── Build color token map: extract hex values from document nodes that use each style ──
  // The styles map in the REST response doesn't include actual paint values — we need to
  // walk document nodes to find a node that references each style and extract its fill.
  const colorTokenMap: { name: string; hex: string }[] = [];
  const seenStyleIds = new Set<string>();

  function extractHexFromNode(node: any): string | null {
    const fills = node.fills;
    if (!Array.isArray(fills)) return null;
    for (const fill of fills) {
      if (fill.type === 'SOLID' && fill.color) {
        const { r, g, b } = fill.color;
        const toH = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
        return `#${toH(r)}${toH(g)}${toH(b)}`.toUpperCase();
      }
    }
    return null;
  }

  function walkForColorValues(node: any): void {
    if (!node) return;
    if (node.styles && node.styles.fill) {
      const styleId = node.styles.fill;
      if (!seenStyleIds.has(styleId)) {
        seenStyleIds.add(styleId);
        const styleEntry = stylesMap[styleId];
        if (styleEntry) {
          const hex = extractHexFromNode(node);
          if (hex) colorTokenMap.push({ name: styleEntry.name, hex });
        }
      }
    }
    const children = node.children;
    if (children && children.length) {
      for (let i = 0; i < children.length; i++) {
        if (colorTokenMap.length >= 80) break;
        walkForColorValues(children[i]);
      }
    }
  }

  if (colorTokenMap.length < 80) {
    const pages2 = (figmaFile.document && figmaFile.document.children) ? figmaFile.document.children : [];
    for (let p = 0; p < pages2.length && colorTokenMap.length < 80; p++) {
      const pageChildren2 = pages2[p].children || [];
      for (let c = 0; c < pageChildren2.length && colorTokenMap.length < 80; c++) {
        walkForColorValues(pageChildren2[c]);
      }
    }
  }

  return {
    fileKey,
    paintStyles,
    textStyles,
    effectStyles,
    allComponents,
    iconComponents,
    libraryMap,
    componentCount: allComponents.length,
    colorCount: paintStyles.length,
    iconCount: iconComponents.length,
    summary: {
      colorNames,
      colorTokenMap,
      textStyleNames,
      effectStyleNames,
      componentNames,
      iconNames,
      libraryNames: Object.keys(libraryMap),
    }
  };
}

async function loadDSFromCurrentFile(): Promise<void> {
  try {
    figma.notify('🔄 Scanning components used in this file…');

    // Capture local paint styles with actual hex color values
    const localPaintStylesFull = figma.getLocalPaintStyles();
    const paintStyles = localPaintStylesFull.map(s => ({ id: s.id, name: s.name, key: s.key }));

    // Build colorTokenMap: { name, hex } from local paint styles (direct access to fill values)
    const colorTokenMap: { name: string; hex: string }[] = [];
    for (const style of localPaintStylesFull.slice(0, 80)) {
      const paints = style.paints;
      for (const paint of paints) {
        if (paint.type === 'SOLID' && paint.color) {
          const { r, g, b } = paint.color;
          const toH = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
          colorTokenMap.push({ name: style.name, hex: `#${toH(r)}${toH(g)}${toH(b)}`.toUpperCase() });
          break;
        }
      }
    }

    // Capture local text styles with actual font metadata
    const localTextStylesFull = figma.getLocalTextStyles();
    const textStyles = localTextStylesFull.map(s => ({ id: s.id, name: s.name, key: s.key }));
    const textStyleMap: { name: string; family: string; size: number; weight: string }[] = [];
    for (const style of localTextStylesFull.slice(0, 40)) {
      const fontName = style.fontName as FontName;
      textStyleMap.push({
        name: style.name,
        family: fontName ? fontName.family : '',
        size: style.fontSize as number || 0,
        weight: fontName ? fontName.style : '',
      });
    }

    const effectStyles = figma.getLocalEffectStyles().map(s => ({ id: s.id, name: s.name, key: s.key }));
    const seen = new Set<string>();
    const allComponents: any[] = [];
    const instances = figma.currentPage.findAllWithCriteria({ types: ['INSTANCE'] });
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i] as InstanceNode;
      const mc = inst.mainComponent;
      if (mc && !seen.has(mc.key)) {
        seen.add(mc.key);
        allComponents.push({ key: mc.key, name: mc.name, page: mc.remote ? 'External Library' : 'This File' });
      }
    }
    const iconComponents: any[] = [];
    for (let i = 0; i < allComponents.length; i++) {
      const c = allComponents[i];
      if (c.name.toLowerCase().indexOf('icon') !== -1 || c.name.indexOf('Icons/') === 0 || c.name.indexOf('ic_') === 0 || c.name.indexOf('Icon/') === 0) {
        iconComponents.push(c);
      }
    }
    const colorNames = colorTokenMap.length > 0
      ? colorTokenMap.map(t => t.name)
      : paintStyles.slice(0, 80).map(s => s.name);
    const textStyleNames = textStyleMap.length > 0
      ? textStyleMap.map(t => t.name)
      : textStyles.slice(0, 40).map(s => s.name);
    const componentNames = allComponents.slice(0, 150).map(c => c.name);
    const iconNames = iconComponents.slice(0, 100).map(c => c.name);
    const dsData = {
      paintStyles, textStyles, effectStyles,
      allComponents, iconComponents, libraryMap: {},
      componentCount: allComponents.length,
      colorCount: paintStyles.length,
      iconCount: iconComponents.length,
      isCurrentFileOnly: true,
      summary: {
        colorNames,
        colorTokenMap,
        textStyleNames,
        textStyleMap,
        componentNames,
        iconNames,
        libraryNames: ['This file only'],
      }
    };
    await figma.clientStorage.setAsync('ds_cache', JSON.stringify(dsData));
    await figma.clientStorage.setAsync('ds_cache_timestamp', String(Date.now()));
    figma.notify(`✅ Loaded ${dsData.componentCount} components · ${colorTokenMap.length} color tokens from current file`);
    const dsContextOnLoad = await getDSContext();
    figma.ui.postMessage({ type: 'ds-loaded', summary: dsData.summary, dsContext: dsContextOnLoad });
  } catch (e) {
    figma.notify('❌ Failed to scan current file');
    figma.ui.postMessage({ type: 'ds-config-status', hasDS: false, error: String(e) });
  }
}

// On startup: check DS cache, populate icon name set, and notify UI
(async () => {
  await refreshDSIconNames();
  const cacheRaw = await figma.clientStorage.getAsync('ds_cache') as string | undefined;
  const cacheTimestampRaw = await figma.clientStorage.getAsync('ds_cache_timestamp') as string | undefined;
  const fileKey = await figma.clientStorage.getAsync('ds_file_key') as string | undefined;
  const cacheAge = cacheTimestampRaw ? Date.now() - parseInt(cacheTimestampRaw) : Infinity;
  const stale = cacheAge > 24 * 60 * 60 * 1000;
  let summary = null;
  if (cacheRaw) {
    try {
      summary = JSON.parse(cacheRaw).summary;
    } catch (_e) {}
  }
  const dsContext = cacheRaw ? await getDSContext() : null;
  figma.ui.postMessage({ type: 'ds-config-status', hasDS: !!cacheRaw, stale, fileKey, summary, dsContext });
})();

// Broadcast selection change to UI so annotation bar can update
figma.on('selectionchange', () => {
  const sel = figma.currentPage.selection;
  if (sel.length > 0) {
    const node = sel[0];
    figma.ui.postMessage({
      type: 'selection-node-changed',
      nodeId:   node.id,
      nodeName: node.name,
    });
  } else {
    figma.ui.postMessage({ type: 'selection-node-changed', nodeId: null, nodeName: null });
  }
});

// Handle messages from UI
figma.ui.onmessage = async (msg: any) => {
  if (msg.type === 'get-selection') {
    const data = getSelectionData();
    if (data.nodes) cacheNodeNames(data.nodes);
    _analysisRootIds = figma.currentPage.selection.map(n => n.id);
    const dsContext = await getDSContext();
    figma.ui.postMessage({
      type: 'selection-data',
      data,
      dsContext,
    });
  }

  if (msg.type === 'analyze') {
    // Send current selection data for analysis
    const selectionData = getSelectionData();
    if (selectionData.nodes) cacheNodeNames(selectionData.nodes);
    _analysisRootIds = figma.currentPage.selection.map(n => n.id);
    figma.notify(`📊 Extracting ${selectionData.extractedNodeCount} nodes from ${selectionData.selectionCount} selected frame(s)…`);
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
    // runTextContrastAudit is now async (gradient pixel-sampling via UI canvas)
    const textIssues = checkText ? await runTextContrastAudit(selection) : [];
    const iconIssues = checkIcon ? runIconContrastAudit(selection) : [];
    const issues = [...textIssues, ...iconIssues];
    figma.ui.postMessage({ type: 'accessibility-results', issues });
    const failCount = issues.filter(i => !i.pass).length;
    figma.notify(failCount > 0 ? `⚠️ ${failCount} contrast issue${failCount > 1 ? 's' : ''} found` : '✅ All elements pass contrast check');
  }

  // ============================================================
  // DESIGN SYSTEM: Fetch full DS via Figma REST API
  // ============================================================
  if (msg.type === 'save-ds-config') {
    if (!msg.fileKey || !msg.pat) {
      figma.ui.postMessage({ type: 'ds-config-status', hasDS: false, error: 'File key and PAT are required.' });
      return;
    }
    await fetchAndCacheDS(msg.fileKey, msg.pat);
    await refreshDSIconNames();
  }

  if (msg.type === 'refresh-ds-config') {
    const fileKey = await figma.clientStorage.getAsync('ds_file_key') as string | undefined;
    const pat = await figma.clientStorage.getAsync('figma_pat') as string | undefined;
    if (!fileKey || !pat) {
      figma.ui.postMessage({ type: 'ds-config-status', hasDS: false, error: 'No DS configured. Please connect first.' });
      return;
    }
    await fetchAndCacheDS(fileKey, pat);
    await refreshDSIconNames();
  }

  if (msg.type === 'load-ds-from-current-file') {
    await loadDSFromCurrentFile();
    await refreshDSIconNames();
  }

  if (msg.type === 'get-ds-config') {
    const cacheRaw = await figma.clientStorage.getAsync('ds_cache') as string | undefined;
    const cacheTimestampRaw = await figma.clientStorage.getAsync('ds_cache_timestamp') as string | undefined;
    const fileKey = await figma.clientStorage.getAsync('ds_file_key') as string | undefined;
    const stale = cacheTimestampRaw
      ? (Date.now() - parseInt(cacheTimestampRaw)) > 24 * 60 * 60 * 1000
      : true;
    let summary = null;
    if (cacheRaw) {
      try { summary = JSON.parse(cacheRaw).summary; } catch (_e) {}
    }
    figma.ui.postMessage({ type: 'ds-config-status', hasDS: !!cacheRaw, stale, fileKey, summary });
  }

  if (msg.type === 'disconnect-ds') {
    await figma.clientStorage.deleteAsync('ds_file_key');
    await figma.clientStorage.deleteAsync('figma_pat');
    await figma.clientStorage.deleteAsync('ds_cache');
    await figma.clientStorage.deleteAsync('ds_cache_timestamp');
    _dsIconNames = new Set();
    figma.ui.postMessage({ type: 'ds-config-status', hasDS: false });
  }

  if (msg.type === 'get-selection-for-a11y-ai') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'accessibility-results', issues: [], error: 'No selection. Select a frame first.' });
      return;
    }

    // Extract nodes for A11y analysis
    _extractedNodeCount = 0;
    const nodes: DesignNode[] = [];
    for (const node of selection) {
      if (_extractedNodeCount >= MAX_EXTRACTED_NODES) break;
      const nodeData = extractNodeData(node, 0);
      if (nodeData) nodes.push(nodeData);
    }

    // Use getDSContext() helper — returns only safe/trimmed summary data
    const dsContext = await getDSContext();

    figma.ui.postMessage({
      type: 'selection-for-a11y-ai',
      data: {
        nodes,
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
      },
      dsContext,
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

  // ============================================================
  // ANNOTATION: Draw visual annotation cards on the canvas
  // ============================================================
  if (msg.type === 'create-annotation') {
    const { nodeId, nodeName, interaction, role, label } = msg;

    try {
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

      // ── Constants ──────────────────────────────────────────
      const CARD_W       = 220;
      const CARD_PAD     = 14;
      const CARD_GAP     = 10;
      const CARD_RADIUS  = 10;
      const BG_COLOR     = { r: 0.125, g: 0.141, b: 0.173 }; // #1f2437
      const TEXT_WHITE   = { r: 0.96,  g: 0.965, b: 0.975 };
      const TEXT_MUTED   = { r: 0.55,  g: 0.56,  b: 0.60  };

      const PILL_CONFIGS: Record<string, { bg: {r:number,g:number,b:number}, text: {r:number,g:number,b:number}, label: string }> = {
        interaction: { bg: { r: 0.459, g: 0.176, b: 0.71  }, text: { r: 0.98, g: 0.95, b: 1.0  }, label: 'Interaction'  },
        role:        { bg: { r: 0.671, g: 0.290, b: 0.106 }, text: { r: 1.0,  g: 0.96, b: 0.93 }, label: 'Role/State'   },
        label:       { bg: { r: 0.247, g: 0.263, b: 0.863 }, text: { r: 0.92, g: 0.93, b: 1.0  }, label: 'Label'        },
      };

      // Helper: make a pill text node
      async function makePill(type: keyof typeof PILL_CONFIGS): Promise<FrameNode> {
        const cfg   = PILL_CONFIGS[type];
        const pill  = figma.createFrame();
        pill.name   = `Pill/${cfg.label}`;
        pill.cornerRadius = 20;
        pill.fills  = [{ type: 'SOLID', color: cfg.bg }];
        pill.layoutMode = 'HORIZONTAL';
        pill.primaryAxisSizingMode  = 'AUTO';
        pill.counterAxisSizingMode  = 'AUTO';
        pill.paddingLeft = pill.paddingRight  = 10;
        pill.paddingTop  = pill.paddingBottom = 4;

        const t = figma.createText();
        t.fontName = { family: 'Inter', style: 'Bold' };
        t.fontSize = 10;
        t.characters = cfg.label;
        t.fills = [{ type: 'SOLID', color: cfg.text }];
        pill.appendChild(t);
        return pill;
      }

      // Helper: make body text
      function makeBodyText(content: string): TextNode {
        const t = figma.createText();
        t.fontName = { family: 'Inter', style: 'Regular' };
        t.fontSize = 14;
        t.lineHeight = { value: 140, unit: 'PERCENT' };
        t.characters = content;
        t.fills = [{ type: 'SOLID', color: TEXT_WHITE }];
        t.textAutoResize = 'WIDTH_AND_HEIGHT';
        return t;
      }

      // Build one annotation card per filled field
      const entries: Array<{ type: keyof typeof PILL_CONFIGS; value: string }> = [];
      if (interaction) entries.push({ type: 'interaction', value: interaction });
      if (role)        entries.push({ type: 'role',        value: role });
      if (label)       entries.push({ type: 'label',       value: label });

      // Place cards in the centre of the current viewport so they appear
      // exactly where the designer is looking — no connector, no repositioning.
      const vp     = figma.viewport;
      const vpCx   = vp.center.x;
      const vpCy   = vp.center.y;

      // Stack cards vertically, centred on the viewport centre
      const totalCards = entries.length;
      const estimatedCardH = 90; // approximate before auto-layout resolves
      const totalH = totalCards * estimatedCardH + (totalCards - 1) * CARD_GAP;
      let curY = vpCy - totalH / 2;
      const startX = vpCx - CARD_W / 2;

      // Always append to the current page so cards are never clipped by a frame
      const page = figma.currentPage;

      const createdCards: FrameNode[] = [];

      for (const entry of entries) {
        const card = figma.createFrame();
        card.name  = `A11y Annotation · ${PILL_CONFIGS[entry.type].label}`;
        card.fills = [{ type: 'SOLID', color: BG_COLOR }];
        card.cornerRadius = CARD_RADIUS;
        card.layoutMode   = 'VERTICAL';
        card.primaryAxisSizingMode  = 'AUTO';
        card.counterAxisSizingMode  = 'FIXED';
        card.resize(CARD_W, 80);
        card.paddingLeft = card.paddingRight  = CARD_PAD;
        card.paddingTop  = card.paddingBottom = CARD_PAD;
        card.itemSpacing = 8;
        card.x = startX;
        card.y = curY;

        const pill = await makePill(entry.type);
        card.appendChild(pill);

        const body = makeBodyText(entry.value);
        card.appendChild(body);
        body.layoutSizingHorizontal = 'FILL';

        page.appendChild(card);
        createdCards.push(card);

        curY += estimatedCardH + CARD_GAP;
      }

      figma.ui.postMessage({ type: 'annotation-done', success: true });
      figma.notify(`✅ ${entries.length} annotation card${entries.length > 1 ? 's' : ''} placed`);

    } catch (e) {
      figma.ui.postMessage({ type: 'annotation-done', success: false, error: String(e) });
      figma.notify('❌ Failed to create annotation: ' + String(e));
    }
  }

  if (msg.type === 'notify') {
    figma.notify(msg.message);
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
