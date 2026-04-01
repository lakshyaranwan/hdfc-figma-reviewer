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
  nodeId?: string;
  suggestion?: string;
}

// Estimate token count from string length
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Robustly repair truncated JSON arrays of objects
function repairTruncatedJSON(raw: string): any[] {
  // Strategy 1: Find all complete JSON objects using brace counting
  const objects: any[] = [];
  let i = raw.indexOf('[');
  if (i === -1) i = 0; else i++;

  while (i < raw.length) {
    // Find next object start
    const objStart = raw.indexOf('{', i);
    if (objStart === -1) break;

    // Find matching close brace via counting
    let depth = 0;
    let inString = false;
    let escaped = false;
    let objEnd = -1;

    for (let j = objStart; j < raw.length; j++) {
      const ch = raw[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) { objEnd = j; break; } }
    }

    if (objEnd === -1) break; // incomplete object, skip

    const objStr = raw.slice(objStart, objEnd + 1);
    try {
      objects.push(JSON.parse(objStr));
    } catch (_e) {
      // skip malformed object
    }
    i = objEnd + 1;
  }

  if (objects.length === 0) {
    throw new Error("Could not extract any complete JSON objects from truncated response");
  }

  return objects;
}


function flattenDesignData(nodes: any[], maxDepth = 12): any[] {
  const flat: any[] = [];

  function traverse(node: any, path: string, depth: number, parentId?: string) {
    if (!node || depth > maxDepth) return;
    if (node.visible === false) return;
    if (node.opacity !== undefined && node.opacity === 0) return;

    // Use visible text content as path label for readability — not the layer name
    const displayLabel = node.characters?.trim() || node.type || "unknown";
    const currentPath = path ? `${path} > ${displayLabel}` : displayLabel;

    // Collect visible child IDs BEFORE recursion so the AI knows containment
    const childNodes = node.children || node.nodes;
    const visibleChildIds: string[] = [];
    if (Array.isArray(childNodes)) {
      for (const child of childNodes) {
        if (child && child.visible !== false && !(child.opacity !== undefined && child.opacity === 0)) {
          visibleChildIds.push(child.id);
        }
      }
    }

    const simplified: any = {
      id: node.id,
      type: node.type,
      path: currentPath,
      parentId: parentId || null,
    };

    // Include child IDs so the AI understands containment (what's inside what)
    if (visibleChildIds.length > 0) {
      simplified.childIds = visibleChildIds;
    }

    // Include text content
    if (node.characters) simplified.text = node.characters;

    // Include key style properties only (not full nested style objects)
    if (node.fills && Array.isArray(node.fills) && node.fills.length > 0) {
      simplified.fills = node.fills.map((f: any) => {
        let hex = f.hex;
        if (!hex && f.color) {
          hex = `#${Math.round(f.color.r*255).toString(16).padStart(2,'0')}${Math.round(f.color.g*255).toString(16).padStart(2,'0')}${Math.round(f.color.b*255).toString(16).padStart(2,'0')}`;
        }
        return {
          type: f.type,
          color: f.color ? `rgba(${Math.round(f.color.r*255)},${Math.round(f.color.g*255)},${Math.round(f.color.b*255)},${f.color.a ?? 1})` : undefined,
          hex,
        };
      });
    }
    if (node.fontSize) simplified.fontSize = node.fontSize;
    if (node.fontName) simplified.fontName = node.fontName;
    if (node.cornerRadius) simplified.cornerRadius = node.cornerRadius;
    if (node.opacity !== undefined && node.opacity !== 1) simplified.opacity = node.opacity;
    if (node.layoutMode) simplified.layoutMode = node.layoutMode;
    if (node.itemSpacing) simplified.itemSpacing = node.itemSpacing;
    if (node.paddingLeft || node.paddingTop || node.paddingRight || node.paddingBottom) {
      simplified.padding = { l: node.paddingLeft, t: node.paddingTop, r: node.paddingRight, b: node.paddingBottom };
    }

    // Prefer absolute position for accurate spatial reasoning
    if (node.absX !== undefined) {
      simplified.x = Math.round(node.absX);
      simplified.y = Math.round(node.absY);
    } else if (node.x !== undefined) {
      simplified.x = Math.round(node.x);
      simplified.y = Math.round(node.y);
    }

    // Include size
    if (node.absoluteBoundingBox) {
      simplified.size = { w: node.absoluteBoundingBox.width, h: node.absoluteBoundingBox.height };
    } else if (node.width !== undefined) {
      simplified.size = { w: node.width, h: node.height };
    }

    flat.push(simplified);

    // Recurse into children
    if (Array.isArray(childNodes)) {
      for (const child of childNodes) {
        traverse(child, currentPath, depth + 1, node.id);
      }
    }
  }

  for (const node of nodes) {
    traverse(node, "", 0);
  }

  return flat;
}

// Build a containment summary: for each container that has text descendants,
// show a tree of "SECTION contains: text1, text2, text3..."
// This is the KEY context the AI needs to stop saying "no summary" when there IS one.
function buildContainmentSummary(flatNodes: any[]): string {
  const nodeById = new Map<string, any>();
  const childrenOf = new Map<string, any[]>();
  for (const node of flatNodes) {
    nodeById.set(node.id, node);
    if (node.parentId) {
      if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
      childrenOf.get(node.parentId)!.push(node);
    }
  }

  // Recursively collect all text from descendants
  function collectAllText(nodeId: string, maxDepth = 10): string[] {
    if (maxDepth <= 0) return [];
    const texts: string[] = [];
    const children = childrenOf.get(nodeId) || [];
    for (const child of children) {
      if (child.text) texts.push(child.text);
      texts.push(...collectAllText(child.id, maxDepth - 1));
    }
    return texts;
  }

  const summaries: string[] = [];
  
  // Find containers with significant text content (sections, cards, etc.)
  for (const node of flatNodes) {
    if (node.type === 'TEXT') continue;
    const children = childrenOf.get(node.id);
    if (!children || children.length === 0) continue;
    
    const allText = collectAllText(node.id);
    if (allText.length < 2) continue; // skip containers with little content
    
    // Only show containers that are big enough to be meaningful sections
    const area = (node.size?.w || 0) * (node.size?.h || 0);
    if (area < 5000) continue;
    
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    const textPreview = allText.slice(0, 15).map(t => `"${t}"`).join(', ');
    const moreCount = allText.length > 15 ? ` (+${allText.length - 15} more)` : '';
    summaries.push(`[${topFrame}] Container id:${node.id} (${node.size?.w}x${node.size?.h}) contains ${allText.length} text elements: ${textPreview}${moreCount}`);
  }

  // Limit to top 50 most content-rich containers
  return summaries
    .sort((a, b) => {
      const countA = parseInt(a.match(/contains (\d+)/)?.[1] || '0');
      const countB = parseInt(b.match(/contains (\d+)/)?.[1] || '0');
      return countB - countA;
    })
    .slice(0, 50)
    .join('\n');
}

// Classify nodes as boilerplate (footer/header/nav/legal) vs primary content
// Uses position, size, and name patterns to determine importance
function classifyBoilerplate(flatNodes: any[]): any[] {
  // Find page dimensions from top-level frames
  const topFrames = flatNodes.filter(n => !n.parentId || n.path?.split(' > ').length <= 2);
  
  for (const node of flatNodes) {
    // Pattern-based boilerplate detection
    const nameAndText = `${node.name || ''} ${node.text || ''}`.toLowerCase();
    const isBoilerplateName = /\b(footer|header|nav|menu|legal|copyright|help|contact|social|status.?bar|tab.?bar|bottom.?nav|app.?bar|toolbar|disclaimer|terms|privacy|©)\b/i.test(nameAndText);
    
    // Size-based: very small nodes relative to their frame are likely decorative
    const area = (node.size?.w || 0) * (node.size?.h || 0);
    const isTiny = area > 0 && area < 400; // < 20x20
    
    // Compute salience score (higher = more important to review)
    let salience = 0;
    salience += Math.min(area / 1000, 100); // size contribution (capped)
    if (node.text) salience += 200; // text nodes are important
    if (node.fills?.some((f: any) => f.hex && classifyColor(f.hex))) salience += 300; // colored containers
    if (node.type === 'TEXT' && (node.fontSize || 0) > 16) salience += 100; // large text
    
    if (isBoilerplateName) {
      node._boilerplate = true;
      salience -= 500;
    }
    if (isTiny) salience -= 200;
    
    node._salience = Math.max(0, salience);
  }
  
  return flatNodes;
}

// Build a spatial layout summary per screen
// Groups nearby elements into visual "bands" so the AI understands what's next to what
// This solves the core problem: AI sees flat list, can't tell that radio buttons are below a label
function buildSpatialLayoutSummary(flatNodes: any[]): string {
  const frameNodes: Record<string, any[]> = {};
  for (const node of flatNodes) {
    if (!node.text && !node.fills?.length) continue; // only meaningful nodes
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!frameNodes[topFrame]) frameNodes[topFrame] = [];
    frameNodes[topFrame].push(node);
  }

  const summaries: string[] = [];

  for (const [frame, nodes] of Object.entries(frameNodes)) {
    // Sort by y position
    const sorted = [...nodes].sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    
    // Group into vertical bands (elements within 40px of each other are in the same visual group)
    const bands: any[][] = [];
    let currentBand: any[] = [];
    let lastY = -999;
    
    for (const node of sorted) {
      const y = node.y ?? 0;
      if (currentBand.length > 0 && y - lastY > 40) {
        bands.push(currentBand);
        currentBand = [];
      }
      currentBand.push(node);
      lastY = y;
    }
    if (currentBand.length > 0) bands.push(currentBand);

    // Build human-readable description of each band
    const bandDescriptions = bands.map((band, idx) => {
      const items: string[] = [];
      for (const node of band) {
        if (node.text) {
          const fontSize = node.fontSize ? ` (${node.fontSize}px)` : '';
          items.push(`TEXT: "${node.text}"${fontSize} [id:${node.id}]`);
        } else if (node.fills?.length && node.type !== 'TEXT') {
          const hex = node.fills[0]?.hex;
          const colorLabel = hex ? classifyColor(hex) : '';
          const size = node.size ? ` ${node.size.w}x${node.size.h}` : '';
          if (hex && colorLabel) {
            items.push(`CONTAINER: fill ${hex} ${colorLabel}${size} [id:${node.id}]`);
          }
        }
      }
      if (items.length === 0) return null;
      return `  Section ${idx + 1} (y≈${Math.round(band[0].y ?? 0)}):\n    ${items.join('\n    ')}`;
    }).filter(Boolean);

    if (bandDescriptions.length > 0) {
      summaries.push(`[${frame}] — ${bandDescriptions.length} visual sections:\n${bandDescriptions.join('\n')}`);
    }
  }

  return summaries.join('\n\n');
}

// Extract all visible text grouped by top-level frame
// IMPORTANT: Only show the actual displayed text (characters), NOT layer names.
function extractTextContent(flatNodes: any[]): string {
  const grouped: Record<string, { text: string; id: string; y: number }[]> = {};
  for (const node of flatNodes) {
    if (!node.text) continue;
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = [];
    grouped[topFrame].push({ text: node.text, id: node.id, y: node.y ?? 0 });
  }
  // Sort by y-position within each frame so AI reads top-to-bottom
  return Object.entries(grouped)
    .map(([frame, items]) => {
      items.sort((a, b) => a.y - b.y);
      return `[${frame}]\n${items.map(i => `"${i.text}" (id:${i.id})`).join('\n')}`;
    })
    .join('\n\n');
}

// Extract semantic context: pair container fills with their child text content
// Also classify the fill colour semantically (red=danger, green=success, etc.)
function classifyColor(hex: string): string {
  if (!hex) return '';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Red-ish (danger/error) — broadened to catch darker reds, HDFC reds, maroons
  if (r > 150 && g < 80 && b < 80) return '🔴 RED/DANGER';
  if (r > 180 && g < 100 && b < 100) return '🔴 RED/DANGER';
  if (r > 200 && g < 80) return '🔴 RED/DANGER';
  if (r > 140 && g < 60 && b < 60) return '🔴 RED/DANGER'; // deep/dark reds
  // Reddish with some green (like #cc3333, #e04040)
  if (r > 160 && r > g * 2 && r > b * 2) return '🔴 RED/DANGER';
  // Orange-ish (warning)
  if (r > 200 && g > 100 && g < 180 && b < 80) return '🟠 ORANGE/WARNING';
  // Green-ish (success) — broadened
  if (g > 120 && r < 150 && b < 150 && g > r && g > b) return '🟢 GREEN/SUCCESS';
  // Blue-ish (info)
  if (b > 150 && r < 120 && g < 180 && b > r) return '🔵 BLUE/INFO';
  // Yellow-ish (caution)
  if (r > 200 && g > 200 && b < 100) return '🟡 YELLOW/CAUTION';
  return '';
}

function extractSemanticContext(flatNodes: any[]): string {
  // Build a parent→children index using parentId for reliable lookups
  const nodeById = new Map<string, any>();
  const childrenOf = new Map<string, any[]>();
  for (const node of flatNodes) {
    nodeById.set(node.id, node);
    if (node.parentId) {
      if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
      childrenOf.get(node.parentId)!.push(node);
    }
  }

  // Recursively collect all text descendants of a node
  function collectTextDescendants(nodeId: string): string[] {
    const texts: string[] = [];
    const children = childrenOf.get(nodeId) || [];
    for (const child of children) {
      if (child.type === 'TEXT' && child.text) texts.push(child.text);
      texts.push(...collectTextDescendants(child.id));
    }
    return texts;
  }

  const grouped: Record<string, string[]> = {};

  for (const node of flatNodes) {
    if (node.type === 'TEXT') continue;
    if (!node.fills || !Array.isArray(node.fills) || node.fills.length === 0) continue;
    const hex = node.fills[0]?.hex;
    if (!hex) continue;

    const childTexts = collectTextDescendants(node.id);
    if (childTexts.length === 0) continue;

    const colorLabel = classifyColor(hex);
    // Only include semantically meaningful colours (not white/black/grey backgrounds)
    if (!colorLabel) continue;

    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = [];
    grouped[topFrame].push(`⚠️ Container (id:${node.id}) fill:${hex} ${colorLabel} contains text: ${childTexts.map(t => `"${t}"`).join(', ')}`);
  }

  return Object.entries(grouped)
    .map(([frame, pairs]) => `[${frame}]\n${pairs.join('\n')}`)
    .join('\n\n');
}

// Pre-compute page-level semantic clashes deterministically
// This catches contradictions the AI might miss from raw data
function computePageSemantics(flatNodes: any[]): string {
  const frames: Record<string, { texts: string[]; redNodes: any[]; greenNodes: any[] }> = {};

  for (const node of flatNodes) {
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!frames[topFrame]) frames[topFrame] = { texts: [], redNodes: [], greenNodes: [] };

    if (node.text) frames[topFrame].texts.push(node.text);

    if (!node.fills || node.type === 'TEXT') continue;
    for (const fill of node.fills) {
      if (!fill.hex) continue;
      const label = classifyColor(fill.hex);
      if (label.includes('RED/DANGER')) {
        frames[topFrame].redNodes.push({ id: node.id, hex: fill.hex, name: node.name, size: node.size });
      } else if (label.includes('GREEN/SUCCESS')) {
        frames[topFrame].greenNodes.push({ id: node.id, hex: fill.hex, name: node.name });
      }
    }
  }

  const clashes: string[] = [];
  for (const [frame, data] of Object.entries(frames)) {
    const allText = data.texts.join(' ').toLowerCase();
    const hasSuccessText = /(success|completed|done|sent|confirmed|initiated|congratulations|processed|approved)/.test(allText);
    const hasErrorText = /(error|failed|declined|rejected|denied|problem|issue)/.test(allText);

    if (hasSuccessText && data.redNodes.length > 0) {
      const redDetails = data.redNodes.map(n => `id:${n.id} fill:${n.hex} size:${n.size?.w}x${n.size?.h}`).join('; ');
      clashes.push(`🚨 CLASH on [${frame}]: Page contains SUCCESS text ("${data.texts.filter(t => /(success|completed|done|sent|confirmed|initiated|congratulations|processed|approved)/i.test(t)).slice(0, 3).join('", "')}") BUT has RED/DANGER containers: ${redDetails}. This is a CRITICAL semantic contradiction — flag as HIGH severity.`);
    }
    if (hasErrorText && data.greenNodes.length > 0) {
      const greenDetails = data.greenNodes.map(n => `id:${n.id} fill:${n.hex}`).join('; ');
      clashes.push(`🚨 CLASH on [${frame}]: Page contains ERROR text BUT has GREEN/SUCCESS containers: ${greenDetails}. Flag as HIGH severity.`);
    }
  }

  if (clashes.length === 0) return '';
  return clashes.join('\n');
}

// Extract all fill colours grouped by top-level frame
function extractColorContext(flatNodes: any[]): string {
  const grouped: Record<string, Set<string>> = {};
  for (const node of flatNodes) {
    if (!node.fills || !Array.isArray(node.fills)) continue;
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!grouped[topFrame]) grouped[topFrame] = new Set();
    for (const fill of node.fills) {
      if (fill.hex) grouped[topFrame].add(`${fill.hex} (${node.type}${node.name ? ': ' + node.name : ''}, id:${node.id})`);
    }
  }
  return Object.entries(grouped)
    .map(([frame, colors]) => `[${frame}]\n${[...colors].join('\n')}`)
    .join('\n\n');
}

// Build cross-screen comparison facts: find data inconsistencies across screens in a flow
// This is GENERIC — it doesn't rely on hardcoded labels. Instead it:
// 1. Finds all label→value pairs on each screen (label = short text, value = next text nearby)
// 2. Normalizes labels and compares values across screens
// 3. Also detects same data field showing different values (e.g. amount, name, account)
function buildCrossScreenFacts(flatNodes: any[]): string {
  // Group text nodes by top-level frame, sorted by y
  const frameTexts: Record<string, { text: string; id: string; y: number; x: number; fontSize?: number }[]> = {};
  for (const node of flatNodes) {
    if (!node.text) continue;
    const topFrame = node.path?.split(' > ')[0] || 'Unknown';
    if (!frameTexts[topFrame]) frameTexts[topFrame] = [];
    frameTexts[topFrame].push({ 
      text: node.text.trim(), 
      id: node.id, 
      y: node.y ?? 0, 
      x: node.x ?? 0,
      fontSize: node.fontSize 
    });
  }

  const frames = Object.keys(frameTexts);
  if (frames.length <= 1) return '';

  const facts: string[] = [];

  // Strategy 1: Generic label→value pair detection
  // A "label" is a short text (≤5 words) that looks like a field name
  // A "value" is the text node immediately after it (by y-position, within ~80px)
  const isLikelyLabel = (text: string): boolean => {
    const words = text.split(/\s+/);
    if (words.length > 5 || words.length === 0) return false;
    if (text.length > 40) return false;
    // Looks like a label if it ends with colon, or is short, or contains common label words
    if (text.endsWith(':')) return true;
    if (/^(from|to|amount|mode|type|method|name|account|bank|date|status|reference|ref|upi|ifsc|number|beneficiary|payee|transfer|payment|transaction|balance|fee|charge|total|net|gross)/i.test(text)) return true;
    // Short capitalized or title-case phrases are likely labels
    if (words.length <= 3 && /^[A-Z]/.test(text)) return true;
    return false;
  };

  const frameLabelValues: Record<string, Record<string, { value: string; rawLabel: string }>> = {};
  
  for (const [frame, nodes] of Object.entries(frameTexts)) {
    const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    frameLabelValues[frame] = {};
    
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      if (!isLikelyLabel(current.text)) continue;
      
      // Find the next text node that's close by (within 80px vertically or same y but to the right)
      for (let j = i + 1; j < Math.min(i + 4, sorted.length); j++) {
        const next = sorted[j];
        const yDist = Math.abs(next.y - current.y);
        if (yDist > 80) break;
        
        // Skip if next is also a label
        if (isLikelyLabel(next.text) && next.text.length < current.text.length) continue;
        
        // This is likely the value
        const normalizedLabel = current.text.replace(/[:：]/g, '').trim().toLowerCase();
        frameLabelValues[frame][normalizedLabel] = { 
          value: next.text, 
          rawLabel: current.text 
        };
        break;
      }
    }
  }

  // Compare same labels across frames
  const allLabels = new Set<string>();
  for (const lvs of Object.values(frameLabelValues)) {
    for (const label of Object.keys(lvs)) allLabels.add(label);
  }

  for (const label of allLabels) {
    const occurrences: { frame: string; value: string; rawLabel: string }[] = [];
    for (const [frame, lvs] of Object.entries(frameLabelValues)) {
      if (lvs[label]) occurrences.push({ frame, value: lvs[label].value, rawLabel: lvs[label].rawLabel });
    }
    if (occurrences.length > 1) {
      const uniqueValues = [...new Set(occurrences.map(o => o.value))];
      if (uniqueValues.length > 1) {
        facts.push(`DATA INCONSISTENCY: "${occurrences[0].rawLabel}" has different values across screens: ${occurrences.map(o => `"${o.value}" on [${o.frame}]`).join(' vs ')}. This breaks the story — if a user chose one value, the review/confirmation screen should show the same value.`);
      }
    }
  }

  // Strategy 2: Detect same distinctive value appearing with different labels
  // e.g. "NEFT" appearing as value of "Transfer Mode" on one screen and "Payment Type" on another
  // (This catches label renaming across screens)
  const valueToLabels: Record<string, { label: string; frame: string }[]> = {};
  for (const [frame, lvs] of Object.entries(frameLabelValues)) {
    for (const [label, { value }] of Object.entries(lvs)) {
      if (value.length < 2 || value.length > 30) continue; // skip very short/long values
      if (!valueToLabels[value]) valueToLabels[value] = [];
      valueToLabels[value].push({ label, frame });
    }
  }
  for (const [value, entries] of Object.entries(valueToLabels)) {
    if (entries.length > 1) {
      const uniqueLabels = [...new Set(entries.map(e => e.label))];
      if (uniqueLabels.length > 1) {
        facts.push(`LABEL INCONSISTENCY: The value "${value}" is labelled differently across screens: ${entries.map(e => `"${e.label}" on [${e.frame}]`).join(' vs ')}. Use consistent terminology.`);
      }
    }
  }

  // Log for debugging
  if (facts.length > 0) {
    console.log(`Cross-screen facts found: ${facts.length}`);
  } else {
    // Log what we found per frame for debugging
    for (const [frame, lvs] of Object.entries(frameLabelValues)) {
      const pairs = Object.entries(lvs).map(([k, v]) => `${k}="${v.value}"`).join(', ');
      if (pairs) console.log(`[${frame}] label-values: ${pairs}`);
    }
  }

  return facts.length > 0 ? facts.join('\n') : '';
}

// Chunk flat nodes by estimated token size
function chunkByTokens(nodes: any[], maxTokensPerChunk: number): any[][] {
  const chunks: any[][] = [];
  let currentChunk: any[] = [];
  let currentTokens = 0;

  for (const node of nodes) {
    const nodeTokens = estimateTokens(JSON.stringify(node));
    if (currentChunk.length > 0 && currentTokens + nodeTokens > maxTokensPerChunk) {
      chunks.push(currentChunk);
      currentChunk = [node];
      currentTokens = nodeTokens;
    } else {
      currentChunk.push(node);
      currentTokens += nodeTokens;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.length > 0 ? chunks : [[]];
}

// DB helpers for chunk tracking
async function storeChunks(supabaseUrl: string, serviceRoleKey: string, jobId: string, chunks: any[][]) {
  for (let i = 0; i < chunks.length; i++) {
    await fetch(`${supabaseUrl}/rest/v1/analysis_chunks`, {
      method: "POST",
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_id: jobId,
        chunk_index: i,
        chunk_data: { nodeCount: chunks[i].length },
        status: "pending",
      }),
    });
  }
}

async function updateChunkStatus(supabaseUrl: string, serviceRoleKey: string, jobId: string, chunkIndex: number, status: string, result?: any) {
  await fetch(`${supabaseUrl}/rest/v1/analysis_chunks?job_id=eq.${jobId}&chunk_index=eq.${chunkIndex}`, {
    method: "PATCH",
    headers: {
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status, ...(result ? { result } : {}) }),
  });
}

async function cleanupChunks(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  await fetch(`${supabaseUrl}/rest/v1/analysis_chunks?job_id=eq.${jobId}`, {
    method: "DELETE",
    headers: {
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    
    // Handle lightweight usage-tracking-only calls from the UI (contrast checks etc.)
    if (body._trackOnly) {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/plugin_usage`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
            body: JSON.stringify({
              user_name: body.fileName || "unknown",
              action: body.action || "a11y_contrast",
              node_count: body.nodeCount || 0,
              category_count: 1,
            }),
          });
        } catch (e) { /* ignore */ }
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    
    const { designData, prompt, categories, isCustom, fileName, pageName, ignoreChrome, dsContext } = body;
    
    console.log("Analyzing design from plugin");
    console.log("File:", fileName);
    console.log("Page:", pageName);
    console.log("Raw nodes received:", designData?.length || 0);
    console.log("Categories:", categories);
    console.log("Is custom prompt:", isCustom);
    console.log("DS context present:", !!dsContext);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    // Fetch selected AI model from settings (same as analyze-figma)
    let selectedModel = "google/gemini-2.5-flash";
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const settingsResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/app_settings?key=eq.ai_model&select=value`,
          {
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
        
        if (settingsResponse.ok) {
          const settings = await settingsResponse.json();
          if (settings && settings.length > 0 && settings[0].value) {
            selectedModel = settings[0].value;
            console.log("Using selected model:", selectedModel);
          }
        }
      } catch (error) {
        console.error("Error fetching model setting:", error);
      }
    }

    // Store usage info helper (same as analyze-figma)
    const storeUsageInfo = async (status: string, headers: Headers, error?: any) => {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
      try {
        const usage: any = {
          model: selectedModel,
          lastUsed: new Date().toISOString(),
          status,
        };
        const remaining = headers.get("x-ratelimit-remaining-tokens");
        const limit = headers.get("x-ratelimit-limit-tokens");
        const resetTime = headers.get("x-ratelimit-reset-tokens");
        if (remaining) usage.remaining = parseInt(remaining);
        if (limit) usage.limit = parseInt(limit);
        if (resetTime) usage.resetTime = resetTime;
        if (error) {
          const match = error.match(/Limit (\d+), Used (\d+)/);
          if (match) {
            usage.limit = parseInt(match[1]);
            usage.remaining = parseInt(match[1]) - parseInt(match[2]);
          }
        }
        await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            key: `model_usage_${selectedModel}`,
            value: JSON.stringify(usage),
          }),
        });
      } catch (e) {
        console.error("Error storing usage info:", e);
      }
    };

    if (!designData || designData.length === 0) {
      throw new Error("No design data provided. Please select a frame in Figma.");
    }

    // Step 1: Flatten deeply nested design data into simplified flat nodes
    const flatNodes = flattenDesignData(designData);
    // Step 1b: Classify boilerplate and compute salience scores
    classifyBoilerplate(flatNodes);
    console.log("Flattened to", flatNodes.length, "nodes");
    
    // Debug: check how many nodes have fills at all
    const nodesWithFills = flatNodes.filter((n: any) => n.fills && n.fills.length > 0);
    const nodesWithHex = flatNodes.filter((n: any) => n.fills?.some((f: any) => f.hex));
    const boilerplateCount = flatNodes.filter((n: any) => n._boilerplate).length;
    console.log(`Nodes with fills: ${nodesWithFills.length}, with hex: ${nodesWithHex.length}`);
    console.log(`Boilerplate nodes: ${boilerplateCount}`);
    
    // Log ALL colored container hex values (not just first 5) for debugging
    if (nodesWithHex.length > 0) {
      // Show largest containers with color first (most likely to be banners)
      const coloredContainers = nodesWithHex
        .filter((n: any) => n.type !== 'TEXT')
        .sort((a: any, b: any) => ((b.size?.w || 0) * (b.size?.h || 0)) - ((a.size?.w || 0) * (a.size?.h || 0)));
      const sample = coloredContainers.slice(0, 10).map((n: any) => {
        const hex = n.fills[0]?.hex;
        const classification = hex ? classifyColor(hex) : '';
        return `${n.id}(${n.type},${n.size?.w}x${n.size?.h}):${hex}${classification ? ' ' + classification : ''}`;
      });
      console.log(`Top colored containers: ${sample.join(', ')}`);
    } else if (nodesWithFills.length > 0) {
      const sample = nodesWithFills.slice(0, 3).map((n: any) => `${n.id}(${n.type}):${JSON.stringify(n.fills[0])}`);
      console.log(`Fills WITHOUT hex: ${sample.join(', ')}`);
    }
    console.log("Estimated total tokens:", estimateTokens(JSON.stringify(flatNodes)));

    // Step 2: Chunk by actual token size (not node count)
    const TOKEN_LIMIT = 80000; // ~80k tokens per chunk to stay well within 1M context
    const chunks = chunkByTokens(flatNodes, TOKEN_LIMIT);
    const isChunked = chunks.length > 1;
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`Split into ${chunks.length} chunk(s)`);

    // Store chunks in DB for tracking
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await storeChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunks);
        console.log(`Stored ${chunks.length} chunk records (job: ${jobId})`);
      } catch (e) {
        console.error("Error storing chunk records:", e);
      }
    }

    // Category setup
    const categoryLabels: Record<string, string> = {
      consistency: "Consistency across flows regarding UI",
      ux: "UX Review",
      ui: "UI Review",
      ux_writing: "Typos & Inconsistent UX Writing",
      high_level: "High Level Review About and the Why? Questioning the basics.",
    };

    let allowedCategories = categories || ["ux", "ui", "consistency"];
    if (isCustom) {
      allowedCategories = ["ux", "ui", "consistency", "ux_writing", "high_level", "improvement"];
    }
    // Design system category disabled for now
    // if (dsContext && !allowedCategories.includes("design_system")) {
    //   allowedCategories.push("design_system");
    // }

    const categoryOptions = allowedCategories.map((c: string) => `"${c}"`).join(" | ");

    const systemPrompt = `You are an expert UX/UI designer providing professional design feedback. CRITICAL: You MUST respond with ONLY a valid JSON array, no other text. Do not include markdown code blocks, explanations, or any text outside the JSON array. Start your response with [ and end with ].`;

    console.log(`Processing ${chunks.length} chunk(s) with AI model: ${selectedModel}`);
    let allFeedback: FeedbackItem[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkLabel = isChunked ? ` (chunk ${chunkIdx + 1}/${chunks.length})` : "";
      console.log(`Processing${chunkLabel}: ${chunk.length} nodes, ~${estimateTokens(JSON.stringify(chunk))} tokens`);

      // Scale items per category — ensure enough coverage
      const minPerCategory = 4;
      const itemsPerCategory = isChunked 
        ? Math.max(minPerCategory, Math.floor(10 / chunks.length))
        : Math.max(minPerCategory, Math.floor(60 / allowedCategories.length));

      // Strip internal fields from data sent to AI
      const chunkForAI = chunk.map((node: any) => {
        const { name, _boilerplate, _salience, ...rest } = node;
        return rest;
      });

      const baseContext = `I am a UI UX designer who lacks attention to details and makes mistakes. You are a UX/UI expert, my manager and my reviewer, analyzing my Figma designs. Analyze the following design data and provide detailed feedback.

Design Structure${chunkLabel} (node hierarchy with IDs - USE THESE EXACT IDs):
${JSON.stringify(chunkForAI, null, 2)}

CRITICAL NODE ID INSTRUCTIONS:
- You MUST use the EXACT node IDs from the list above
- Choose the MOST SPECIFIC node ID for each piece of feedback
- For a button issue, use the button's node ID, NOT its parent frame
- For a text issue, use the text layer's node ID, NOT the containing group
- The more specific the node, the better the comment placement will be

IMPORTANT: Do NOT reference internal layer/component names. Only analyze VISIBLE text content and visual properties.`;

      const formatInstructions = `
For each issue found, provide:
- A clear, actionable title (NO technical IDs or brackets - keep it human-readable)
- Detailed description of the issue AND specific actionable suggestions on how to fix it (NO technical IDs in the description)
- Severity (low, medium, high)
- The EXACT node ID from the structure above for the specific element this feedback applies to
- Component/frame name (user-friendly name only, NO technical IDs)

CRITICAL CATEGORY RESTRICTION: You MUST ONLY provide feedback for these categories: ${allowedCategories.join(", ")}
Only use these exact category values: ${categoryOptions}

CRITICAL BALANCE REQUIREMENT: Provide feedback distributed across ALL requested categories.
- Provide ${itemsPerCategory} feedback items for EACH category requested
- Do NOT skip any category

Format your response as a JSON array:
[{
  "category": ${categoryOptions},
  "title": "Issue title (clean, no IDs)",
  "description": "Detailed description with specific suggestions (clean, no IDs)",
  "suggestion": "Specific actionable fix",
  "severity": "low" | "medium" | "high",
  "location": "User-friendly component name",
  "nodeId": "exact_node_id_from_structure"
}]

CRITICAL: 
- NEVER include technical IDs like [123:456] in title or description
- Always include the nodeId field with the exact ID from the design structure
- For the location field, use ONLY user-friendly, descriptive names
- Do NOT flag "missing content" unless you can prove no text nodes exist in that area
- For EACH issue, include specific, actionable suggestions

${allowedCategories.includes("consistency") ? `
SPECIAL INSTRUCTIONS FOR CONSISTENCY REVIEW:
- Compare ALL screens/pages/flows for inconsistent patterns
- Look for text variations across similar elements
- Check for inconsistent heading styles, button labels, spacing
- Flag ALL instances of inconsistency
` : ""}

${allowedCategories.includes("ux_writing") ? `
SPECIAL INSTRUCTIONS FOR UX WRITING REVIEW:
- Scan ALL text content thoroughly
- Check EVERY button label, heading, paragraph, placeholder
- Look for typos, spelling errors, grammatical mistakes
- Identify inconsistent terminology
- Be comprehensive - catch ALL text issues
` : ""}`;

      const analysisPrompt = isCustom
        ? `${baseContext}\n\nUser's specific request: ${prompt}\n${formatInstructions}`
        : `${baseContext}\n\nProvide feedback in these categories:\n1. UX Issues - Navigation flows, user interactions, usability problems\n2. UI Issues - Visual design, typography, spacing, color usage\n3. Consistency Issues - Design pattern violations, inconsistent components\n4. Improvement Suggestions - Ways to enhance the design\n${formatInstructions}`;

      const promptTokens = estimateTokens(analysisPrompt + systemPrompt);
      console.log(`Chunk ${chunkIdx + 1} prompt tokens: ~${promptTokens}`);

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: analysisPrompt },
          ],
          max_tokens: 48000,
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error(`AI API error on chunk ${chunkIdx + 1}:`, errorText);
        await storeUsageInfo(
          aiResponse.status === 429 ? "rate_limited" : "error",
          aiResponse.headers,
          errorText
        );

        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try { await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "failed"); } catch (e) { /* ignore */ }
        }

        if (aiResponse.status === 400 && isChunked) {
          console.warn(`Chunk ${chunkIdx + 1} hit token limit, skipping...`);
          continue;
        }
        
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

      await storeUsageInfo("available", aiResponse.headers);
      const aiData = await aiResponse.json();
      const content = aiData.choices?.[0]?.message?.content;

      if (!content) {
        console.error(`No content in AI response for chunk ${chunkIdx + 1}`);
        if (isChunked) continue;
        throw new Error("No content in AI response");
      }

      try {
        let cleanContent = content.trim();
        if (cleanContent.startsWith("```json")) cleanContent = cleanContent.slice(7);
        else if (cleanContent.startsWith("```")) cleanContent = cleanContent.slice(3);
        if (cleanContent.endsWith("```")) cleanContent = cleanContent.slice(0, -3);
        cleanContent = cleanContent.trim();

        // Attempt JSON repair for truncated responses
        let chunkFeedback: FeedbackItem[];
        try {
          chunkFeedback = JSON.parse(cleanContent);
        } catch (_initialParseError) {
          console.warn(`Chunk ${chunkIdx + 1}: JSON truncated, attempting repair...`);
          chunkFeedback = repairTruncatedJSON(cleanContent);
          console.log(`Chunk ${chunkIdx + 1}: repair succeeded with ${chunkFeedback.length} items`);
        }
        if (!Array.isArray(chunkFeedback)) throw new Error("Response is not an array");

        allFeedback.push(...chunkFeedback);
        console.log(`Chunk ${chunkIdx + 1}: got ${chunkFeedback.length} feedback items`);

        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try { await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "completed", { count: chunkFeedback.length }); } catch (e) { /* ignore */ }
        }
      } catch (parseError) {
        console.error(`Failed to parse chunk ${chunkIdx + 1}:`, parseError);
        if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try { await updateChunkStatus(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId, chunkIdx, "parse_error"); } catch (e) { /* ignore */ }
        }
        if (!isChunked) throw new Error("Failed to parse AI analysis results");
        continue;
      }
    }

    // Clean up chunk records
    if (isChunked && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await cleanupChunks(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, jobId);
        console.log(`Cleaned up chunk records for job: ${jobId}`);
      } catch (e) {
        console.error("Error cleaning up chunks:", e);
      }
    }

    // Deduplicate: by nodeId first, then by fuzzy title similarity, then sort
    const seenNodeIds = new Set<string>();
    const seenTitleKeys = new Set<string>();
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    
    // Sort by severity first so we keep the highest severity version of duplicates
    allFeedback.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));
    
    allFeedback = allFeedback.filter(item => {
      // Dedup by nodeId: same node = same issue
      if (item.nodeId) {
        if (seenNodeIds.has(item.nodeId)) return false;
        seenNodeIds.add(item.nodeId);
      }
      
      // Dedup by normalized title: strip quotes, IDs, punctuation, lowercase
      const normalizedTitle = (item.title || '')
        .toLowerCase()
        .replace(/['"""''`]/g, '')
        .replace(/\b(send money\s*2|send money2)\b/g, 'PLACEHOLDER_TEXT') // normalize specific repeated phrases
        .replace(/\bid:[^\s,)]+/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      // Create a "signature" from the first 6 significant words
      const words = normalizedTitle.split(' ').filter(w => w.length > 2);
      const titleKey = words.slice(0, 6).join(' ');
      
      if (titleKey && seenTitleKeys.has(titleKey)) return false;
      if (titleKey) seenTitleKeys.add(titleKey);
      
      return true;
    });

    const categoryCount: Record<string, number> = {};
    allFeedback.forEach(item => {
      const cat = item.category || 'general';
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    });

    const feedback = allFeedback.map((item, index) => ({
      ...item,
      id: `feedback-${index}-${Date.now()}`,
    }));

    console.log(`Analysis complete: ${feedback.length} feedback items`);
    console.log("Category distribution:", categoryCount);

    // Track usage
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/plugin_usage`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({
            user_name: fileName || "unknown",
            action: "analyze",
            node_count: flatNodes.length,
            category_count: allowedCategories.length,
          }),
        });
      } catch (e) {
        console.error("Failed to track usage:", e);
      }
    }

    const summary = {
      total: feedback.length,
      high: feedback.filter(f => f.severity === "high").length,
      medium: feedback.filter(f => f.severity === "medium").length,
      low: feedback.filter(f => f.severity === "low").length,
      byCategory: categoryCount,
    };

    return new Response(
      JSON.stringify({ success: true, feedback, summary }),
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
