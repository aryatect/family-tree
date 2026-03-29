import { getMembers, getMemberById, getState } from './data-store.js';
import { getImageUrl } from './google-drive.js';
import { formatDates, getInitials } from './utils.js';

const CARD_W = 200;
const CARD_H = 90;
const COUPLE_GAP = 10;
const H_SPACING = 60;
const V_SPACING = 120;
const SUBTREE_GAP = 120;

let svg, g, zoomBehavior;
let onSelectMember = null;
const fullName = (m) => `${m.firstName} ${m.lastName}`.trim();
let collapsedNodes = new Set();
let cardPositions = new Map();

let minimapSvg, minimapG, minimapViewbox;

export function initTree(container, onSelect) {
  onSelectMember = onSelect;
  svg = d3.select(container)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%');
  svg.append('defs');
  g = svg.append('g').attr('class', 'tree-canvas');
  zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 3])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
      updateMinimap(event.transform);
    });
  svg.call(zoomBehavior);

  // Create minimap
  const minimapWrap = document.createElement('div');
  minimapWrap.className = 'minimap';
  minimapWrap.id = 'minimap';
  container.appendChild(minimapWrap);
  minimapSvg = d3.select(minimapWrap).append('svg')
    .attr('width', '100%').attr('height', '100%');
  minimapG = minimapSvg.append('g');
  minimapViewbox = minimapSvg.append('rect')
    .attr('class', 'minimap-viewbox')
    .attr('fill', 'rgba(74, 111, 165, 0.15)')
    .attr('stroke', 'var(--color-primary)')
    .attr('stroke-width', 2)
    .attr('rx', 3);

  renderTree();
}

export function renderTree() {
  if (!g) return;
  g.selectAll('*').remove();
  cardPositions = new Map();

  const state = getState();
  if (!state || !state.members.length) {
    g.append('text').attr('x', 400).attr('y', 300)
      .attr('text-anchor', 'middle').attr('class', 'empty-text')
      .text('Click "Add Person" to start building your family tree');
    return;
  }

  const allNodes = computeFullLayout();
  drawGenerationLabels(allNodes);
  drawConnections(allNodes);
  drawNodes(allNodes);
  renderMinimap(allNodes);
}

// ============================================================
// PRE-COMPUTATION
// ============================================================

/**
 * Compute the set of members hidden due to collapse.
 * When a node is collapsed, ALL descendants (via childIds recursively)
 * are hidden. Spouses of hidden members are also hidden.
 */
function computeHiddenSet() {
  const hidden = new Set();
  const members = getMembers();

  function hideDescendants(parentId) {
    const parent = getMemberById(parentId);
    if (!parent) return;
    const allChildIds = new Set(parent.childIds || []);
    // Also include spouse's children
    for (const sid of parent.spouseIds) {
      const spouse = getMemberById(sid);
      if (spouse) for (const cid of (spouse.childIds || [])) allChildIds.add(cid);
    }
    for (const cid of allChildIds) {
      if (hidden.has(cid)) continue;
      hidden.add(cid);
      const child = getMemberById(cid);
      if (child) {
        // Hide the child's spouses too
        for (const sid of child.spouseIds) hidden.add(sid);
        // Recurse into child's descendants
        hideDescendants(cid);
      }
    }
  }

  for (const id of collapsedNodes) {
    hideDescendants(id);
  }

  return hidden;
}

/**
 * For each member, determine which "lineage root" they belong to
 * by walking UP through parents. A member belongs to the lineage
 * of the topmost ancestor reached.
 */
function assignLineage(members) {
  const lineageMap = new Map(); // memberId -> rootId
  const memberIds = new Set(members.map(m => m.id));

  function walkUp(memberId, visited) {
    if (visited.has(memberId)) return memberId;
    visited.add(memberId);
    const m = getMemberById(memberId);
    if (!m) return memberId;
    // Try father first, then mother
    if (m.fatherId && memberIds.has(m.fatherId)) return walkUp(m.fatherId, visited);
    if (m.motherId && memberIds.has(m.motherId)) return walkUp(m.motherId, visited);
    return memberId; // this is a root
  }

  for (const m of members) {
    if (!lineageMap.has(m.id)) {
      const rootId = walkUp(m.id, new Set());
      lineageMap.set(m.id, rootId);
    }
  }

  return lineageMap;
}

// ============================================================
// CLUSTER DISCOVERY
// ============================================================

function findClusters() {
  const members = getMembers();
  const visited = new Set();
  const clusters = [];
  for (const member of members) {
    if (visited.has(member.id)) continue;
    const cluster = [];
    const queue = [member.id];
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      const m = getMemberById(id);
      if (!m) continue;
      visited.add(id);
      cluster.push(m);
      for (const sid of (m.spouseIds || [])) if (!visited.has(sid)) queue.push(sid);
      for (const cid of (m.childIds || [])) if (!visited.has(cid)) queue.push(cid);
      if (m.fatherId && !visited.has(m.fatherId)) queue.push(m.fatherId);
      if (m.motherId && !visited.has(m.motherId)) queue.push(m.motherId);
    }
    clusters.push(cluster);
  }
  return clusters;
}

function findAllRoots(cluster) {
  const clusterIds = new Set(cluster.map(m => m.id));
  const roots = cluster.filter(m => {
    const hasFather = m.fatherId && clusterIds.has(m.fatherId);
    const hasMother = m.motherId && clusterIds.has(m.motherId);
    return !hasFather && !hasMother;
  });
  if (roots.length === 0) return [cluster[0]];

  // De-duplicate couples: if both spouses are roots, keep only one
  const rootIds = new Set(roots.map(r => r.id));
  const deduped = [];
  const handled = new Set();
  for (const r of roots) {
    if (handled.has(r.id)) continue;
    handled.add(r.id);
    for (const sid of r.spouseIds) {
      if (rootIds.has(sid)) handled.add(sid);
    }
    deduped.push(r);
  }
  return deduped;
}

// ============================================================
// MASTER LAYOUT
// ============================================================

function computeFullLayout() {
  const hidden = computeHiddenSet();
  const clusters = findClusters();
  const allNodes = [];
  let globalOffsetX = 0;

  for (const cluster of clusters) {
    // Filter out hidden members from the cluster
    const visibleCluster = cluster.filter(m => !hidden.has(m.id));
    if (visibleCluster.length === 0) continue;

    const roots = findAllRoots(visibleCluster);
    const lineageMap = assignLineage(visibleCluster);

    // Group visible members by their lineage root
    const lineageGroups = new Map(); // rootId -> Set of memberIds in this lineage
    for (const m of visibleCluster) {
      const rootId = lineageMap.get(m.id) || m.id;
      if (!lineageGroups.has(rootId)) lineageGroups.set(rootId, new Set());
      lineageGroups.get(rootId).add(m.id);
    }

    // Layout each root's subtree. Members only appear in their own lineage.
    // Spouses from other lineages are rendered next to their partner but
    // are NOT rendered again in their own lineage subtree.
    const subtreeLayouts = [];
    const rendered = new Set(); // globally rendered across subtrees

    for (const root of roots) {
      if (rendered.has(root.id)) continue;
      const myLineage = lineageGroups.get(root.id) || new Set();
      const { nodes, width } = layoutSubtree(root, myLineage, rendered, hidden);
      if (nodes.length > 0) subtreeLayouts.push({ nodes, width });
    }

    // Place subtrees side by side
    let clusterOffsetX = 0;
    for (const st of subtreeLayouts) {
      for (const node of st.nodes) {
        node.x += globalOffsetX + clusterOffsetX;
        node.centerX += globalOffsetX + clusterOffsetX;
        allNodes.push(node);
      }
      clusterOffsetX += st.width + SUBTREE_GAP;
    }
    globalOffsetX += clusterOffsetX + SUBTREE_GAP;
  }

  return allNodes;
}

// ============================================================
// SINGLE SUBTREE LAYOUT
// ============================================================

function layoutSubtree(rootMember, myLineage, rendered, hidden) {
  const nodes = [];
  const visited = new Set(rendered); // don't re-render already rendered
  const widthMap = new Map();

  computeWidth(rootMember.id, visited, widthMap, myLineage, hidden);

  visited.clear();
  for (const id of rendered) visited.add(id);

  assignPos(rootMember.id, 0, 0, visited, widthMap, nodes, myLineage, hidden);

  // Mark rendered
  for (const n of nodes) {
    rendered.add(n.member.id);
    if (n.spouse) rendered.add(n.spouse.id);
  }

  // Normalize x to start at 0
  let minX = Infinity, maxX = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.isCouple ? n.x + CARD_W * 2 + COUPLE_GAP : n.x + CARD_W);
  }
  const width = nodes.length > 0 ? maxX - minX : CARD_W;
  if (nodes.length > 0 && minX !== 0) {
    for (const n of nodes) { n.x -= minX; n.centerX -= minX; }
  }

  return { nodes, width };
}

function getNodeWidth(memberId) {
  const m = getMemberById(memberId);
  if (!m) return CARD_W;
  return m.spouseIds.length > 0 ? CARD_W * 2 + COUPLE_GAP : CARD_W;
}

/**
 * Get children of a couple. Children are always shown under their parents
 * regardless of lineage — the rendered/visited set prevents double rendering.
 */
function getCoupleChildren(memberId, myLineage, hidden) {
  const m = getMemberById(memberId);
  if (!m) return [];
  const childSet = new Set(m.childIds || []);
  for (const sid of m.spouseIds) {
    const spouse = getMemberById(sid);
    if (spouse) for (const cid of (spouse.childIds || [])) childSet.add(cid);
  }
  return [...childSet].filter(cid => !hidden.has(cid));
}

function computeWidth(memberId, visited, widthMap, myLineage, hidden) {
  if (visited.has(memberId) || hidden.has(memberId)) return widthMap.get(memberId) || CARD_W;
  visited.add(memberId);
  const m = getMemberById(memberId);
  if (!m) { widthMap.set(memberId, CARD_W); return CARD_W; }
  for (const sid of m.spouseIds) visited.add(sid);

  if (collapsedNodes.has(memberId)) {
    const w = getNodeWidth(memberId);
    widthMap.set(memberId, w);
    return w;
  }

  const children = getCoupleChildren(memberId, myLineage, hidden);
  if (children.length === 0) {
    const w = getNodeWidth(memberId);
    widthMap.set(memberId, w);
    return w;
  }

  let total = 0;
  for (const cid of children) total += computeWidth(cid, visited, widthMap, myLineage, hidden) + H_SPACING;
  total -= H_SPACING;

  const w = Math.max(getNodeWidth(memberId), total);
  widthMap.set(memberId, w);
  return w;
}

function assignPos(memberId, x, y, visited, widthMap, nodes, myLineage, hidden) {
  if (visited.has(memberId) || hidden.has(memberId)) return;
  visited.add(memberId);
  const member = getMemberById(memberId);
  if (!member) return;

  const subtreeW = widthMap.get(memberId) || CARD_W;
  const centerX = x + subtreeW / 2;
  for (const sid of member.spouseIds) visited.add(sid);

  const spouse = member.spouseIds.length > 0 ? getMemberById(member.spouseIds[0]) : null;
  if (spouse) {
    const coupleW = CARD_W * 2 + COUPLE_GAP;
    nodes.push({ member, x: centerX - coupleW / 2, y, isCouple: true, spouse, centerX });
  } else {
    nodes.push({ member, x: centerX - CARD_W / 2, y, isCouple: false, spouse: null, centerX });
  }

  if (!collapsedNodes.has(memberId)) {
    const children = getCoupleChildren(memberId, myLineage, hidden);
    if (children.length > 0) {
      let total = 0;
      for (const cid of children) total += (widthMap.get(cid) || CARD_W) + H_SPACING;
      total -= H_SPACING;
      let cx = centerX - total / 2;
      const cy = y + CARD_H + V_SPACING;
      for (const cid of children) {
        assignPos(cid, cx, cy, visited, widthMap, nodes, myLineage, hidden);
        cx += (widthMap.get(cid) || CARD_W) + H_SPACING;
      }
    }
  }
}

// ============================================================
// DRAWING
// ============================================================

function drawGenerationLabels(nodes) {
  if (nodes.length === 0) return;
  const genGroup = g.append('g').attr('class', 'generation-labels');

  // Group nodes by Y level (generation)
  const yLevels = new Map();
  for (const n of nodes) {
    const y = Math.round(n.y);
    if (!yLevels.has(y)) yLevels.set(y, []);
    yLevels.get(y).push(n);
  }

  // Sort by Y to assign generation numbers
  const sortedYs = [...yLevels.keys()].sort((a, b) => a - b);

  // Find leftmost x across all nodes
  let minX = Infinity;
  for (const n of nodes) minX = Math.min(minX, n.x);

  const genNames = ['Generation 1', 'Generation 2', 'Generation 3', 'Generation 4',
    'Generation 5', 'Generation 6', 'Generation 7', 'Generation 8'];

  for (let i = 0; i < sortedYs.length; i++) {
    const y = sortedYs[i];
    const label = genNames[i] || `Generation ${i + 1}`;

    genGroup.append('text')
      .attr('x', minX - 30)
      .attr('y', y + CARD_H / 2)
      .attr('text-anchor', 'end')
      .attr('class', 'gen-label')
      .text(label);

    // Faint horizontal line across the generation
    let maxX = -Infinity;
    for (const n of yLevels.get(y)) {
      maxX = Math.max(maxX, n.isCouple ? n.x + CARD_W * 2 + COUPLE_GAP : n.x + CARD_W);
    }
    genGroup.append('line')
      .attr('x1', minX - 20)
      .attr('y1', y + CARD_H + 15)
      .attr('x2', maxX + 20)
      .attr('y2', y + CARD_H + 15)
      .attr('class', 'gen-line');
  }
}

function drawConnections(nodes) {
  const connGroup = g.append('g').attr('class', 'connections');

  // Position map for every rendered card
  const posMap = new Map();
  for (const n of nodes) {
    posMap.set(n.member.id, {
      cx: n.isCouple ? n.x + CARD_W / 2 : n.centerX,
      cy: n.y + CARD_H / 2, x: n.x, y: n.y, centerX: n.centerX
    });
    if (n.spouse) {
      const sx = n.x + CARD_W + COUPLE_GAP;
      posMap.set(n.spouse.id, {
        cx: sx + CARD_W / 2, cy: n.y + CARD_H / 2, x: sx, y: n.y, centerX: sx + CARD_W / 2
      });
    }
  }

  const connectedChildren = new Set();

  // ── PASS 1: collect all planned parent→child connections ──
  const planned = [];
  for (const node of nodes) {
    // Spouse connector (draw immediately — no overlap risk)
    if (node.isCouple && node.spouse) {
      connGroup.append('line')
        .attr('x1', node.x + CARD_W).attr('y1', node.y + CARD_H / 2)
        .attr('x2', node.x + CARD_W + COUPLE_GAP).attr('y2', node.y + CARD_H / 2)
        .attr('class', 'conn-spouse');
    }

    if (collapsedNodes.has(node.member.id)) continue;
    const allChildIds = new Set(node.member.childIds || []);
    if (node.spouse) {
      for (const cid of (node.spouse.childIds || [])) allChildIds.add(cid);
    }

    const directChildren = [...allChildIds].filter(cid => {
      const cp = posMap.get(cid);
      return cp && Math.abs(cp.y - (node.y + CARD_H + V_SPACING)) < 5;
    });
    if (directChildren.length === 0) continue;

    const childCXs = directChildren.map(cid => posMap.get(cid).cx);
    const allXs = [...childCXs, node.centerX];
    const barMinX = Math.min(...allXs);
    const barMaxX = Math.max(...allXs);
    const baseMidY = node.y + CARD_H + V_SPACING / 2;

    planned.push({ node, directChildren, barMinX, barMaxX, baseMidY });
  }

  // ── PASS 2: assign lane offsets for overlapping horizontal bars ──
  const LANE_GAP = 12;
  // Group by baseMidY
  const byMidY = new Map();
  for (const p of planned) {
    const key = Math.round(p.baseMidY);
    if (!byMidY.has(key)) byMidY.set(key, []);
    byMidY.get(key).push(p);
  }

  for (const [, group] of byMidY) {
    if (group.length <= 1) { group[0].lane = 0; continue; }
    // Sort by barMinX for consistent lane assignment
    group.sort((a, b) => a.barMinX - b.barMinX);
    // Greedy lane assignment: find lowest lane that doesn't overlap
    for (const p of group) {
      let lane = 0;
      while (true) {
        const conflict = group.some(other =>
          other !== p && other.lane === lane &&
          other.barMinX < p.barMaxX && other.barMaxX > p.barMinX
        );
        if (!conflict) break;
        lane++;
      }
      p.lane = lane;
    }
    // Center the lanes around the base midY
    const maxLane = Math.max(...group.map(p => p.lane));
    for (const p of group) {
      p.midY = p.baseMidY + (p.lane - maxLane / 2) * LANE_GAP;
    }
  }
  // Ensure single-group items have midY set
  for (const p of planned) {
    if (p.midY == null) p.midY = p.baseMidY;
  }

  // ── PASS 3: draw with adjusted Y positions ──
  for (const p of planned) {
    const { node, directChildren, barMinX, barMaxX, midY } = p;

    // Vertical from parent down to midY
    connGroup.append('line')
      .attr('x1', node.centerX).attr('y1', node.y + CARD_H)
      .attr('x2', node.centerX).attr('y2', midY)
      .attr('class', 'conn-vertical');

    // Horizontal bar at midY
    if (barMaxX > barMinX) {
      connGroup.append('line')
        .attr('x1', barMinX).attr('y1', midY)
        .attr('x2', barMaxX).attr('y2', midY)
        .attr('class', 'conn-horizontal');
    }

    // Vertical from midY down to each child
    for (const cid of directChildren) {
      const cp = posMap.get(cid);
      connGroup.append('line')
        .attr('x1', cp.cx).attr('y1', midY)
        .attr('x2', cp.cx).attr('y2', cp.y)
        .attr('class', 'conn-vertical');
      connectedChildren.add(cid);
    }
  }

  // ── CROSS-SUBTREE connections (routed to avoid overlap) ──
  const members = getMembers();
  for (const m of members) {
    if (!posMap.has(m.id)) continue;
    if (connectedChildren.has(m.id)) continue;

    const parentIds = [m.fatherId, m.motherId].filter(pid => pid && posMap.has(pid));
    if (parentIds.length === 0) continue;

    const parentId = parentIds[0];
    const parentNode = nodes.find(n =>
      n.member.id === parentId || n.spouse?.id === parentId
    );
    if (!parentNode) continue;

    const childPos = posMap.get(m.id);
    const parentCenterX = parentNode.centerX;
    const parentBottomY = parentNode.y + CARD_H;

    // Routed stepped path: down from parent, horizontal, down to child
    // Route outside the tree to avoid crossing internal connections
    const routeY = parentBottomY + V_SPACING * 0.8;
    const path = d3.path();
    path.moveTo(parentCenterX, parentBottomY);
    path.lineTo(parentCenterX, routeY);
    path.lineTo(childPos.cx, routeY);
    path.lineTo(childPos.cx, childPos.y);

    connGroup.append('path')
      .attr('d', path.toString())
      .attr('class', 'conn-ancestry')
      .attr('fill', 'none');
  }
}

function drawNodes(nodes) {
  const nodeGroup = g.append('g').attr('class', 'nodes');
  for (const node of nodes) {
    drawCard(nodeGroup, node.member, node.x, node.y);
    if (node.isCouple && node.spouse) {
      drawCard(nodeGroup, node.spouse, node.x + CARD_W + COUPLE_GAP, node.y);
    }
  }
}

function drawCard(parent, member, x, y) {
  cardPositions.set(member.id, { x, y });

  const card = parent.append('g')
    .attr('class', `card card--${member.gender === 'F' ? 'female' : member.gender === 'O' ? 'other' : 'male'}`)
    .attr('transform', `translate(${x}, ${y})`)
    .style('cursor', 'pointer')
    .on('click', (event) => {
      event.stopPropagation();
      if (onSelectMember) onSelectMember(member.id);
    });

  // Tooltip on hover
  const tooltipLines = [fullName(member)];
  const dates = formatDates(member);
  if (dates) tooltipLines.push(dates);
  if (member.bio) tooltipLines.push(member.bio.length > 80 ? member.bio.substring(0, 77) + '...' : member.bio);
  const father = member.fatherId ? getMemberById(member.fatherId) : null;
  const mother = member.motherId ? getMemberById(member.motherId) : null;
  if (father) tooltipLines.push('Father: ' + fullName(father));
  if (mother) tooltipLines.push('Mother: ' + fullName(mother));
  const spouses = member.spouseIds.map(id => getMemberById(id)).filter(Boolean);
  if (spouses.length) tooltipLines.push('Spouse: ' + spouses.map(fullName).join(', '));
  card.append('title').text(tooltipLines.join('\n'));

  card.append('rect').attr('width', CARD_W).attr('height', CARD_H)
    .attr('rx', 10).attr('class', 'card-bg');
  card.append('rect').attr('width', 4).attr('height', CARD_H)
    .attr('rx', 2).attr('class', 'card-accent');

  const avatarG = card.append('g').attr('transform', `translate(36, ${CARD_H / 2})`);
  if (member.avatar) {
    avatarG.append('clipPath').attr('id', `clip-${member.id}`)
      .append('circle').attr('r', 22);
    avatarG.append('image')
      .attr('href', getImageUrl(member.avatar, 200))
      .attr('x', -22).attr('y', -22).attr('width', 44).attr('height', 44)
      .attr('clip-path', `url(#clip-${member.id})`)
      .attr('preserveAspectRatio', 'xMidYMid slice');
  } else {
    avatarG.append('circle').attr('r', 22).attr('class', 'avatar-placeholder');
    avatarG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('class', 'avatar-initials').text(getInitials(member));
  }

  const name = fullName(member);
  const maxNameLen = 18;
  card.append('text').attr('x', 68).attr('y', CARD_H / 2 - 10)
    .attr('class', 'card-name')
    .text(name.length > maxNameLen ? name.substring(0, maxNameLen - 1) + '…' : name);

  if (dates) {
    card.append('text').attr('x', 68).attr('y', CARD_H / 2 + 8)
      .attr('class', 'card-dates').text(dates);
  }

  // Relationship label (role)
  const roleLabel = getRoleLabel(member);
  if (roleLabel) {
    card.append('text').attr('x', 68).attr('y', CARD_H / 2 + 24)
      .attr('class', 'card-role').text(roleLabel);
  }

  // Collapse toggle for members with children
  const allChildIds = new Set(member.childIds || []);
  for (const sid of member.spouseIds) {
    const spouse = getMemberById(sid);
    if (spouse) for (const cid of (spouse.childIds || [])) allChildIds.add(cid);
  }
  if (allChildIds.size > 0) {
    // Check if this member OR any spouse is collapsed (couple state is shared)
    const isCollapsed = isCoupleCollapsed(member.id);
    const toggleG = card.append('g')
      .attr('transform', `translate(${CARD_W / 2}, ${CARD_H})`)
      .attr('class', 'collapse-toggle')
      .style('cursor', 'pointer')
      .on('click', (event) => {
        event.stopPropagation();
        toggleCoupleCollapse(member.id);
      });
    toggleG.append('circle').attr('r', 10).attr('class', 'toggle-circle');
    toggleG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('class', 'toggle-text')
      .text(isCollapsed ? '+' : '−');
  }
}

/** Check if a member or any of their spouses is collapsed */
function isCoupleCollapsed(memberId) {
  if (collapsedNodes.has(memberId)) return true;
  const m = getMemberById(memberId);
  if (m) {
    for (const sid of m.spouseIds) {
      if (collapsedNodes.has(sid)) return true;
    }
  }
  return false;
}

/** Toggle collapse for a member AND all their spouses in sync */
function toggleCoupleCollapse(memberId) {
  const m = getMemberById(memberId);
  const coupleIds = [memberId];
  if (m) for (const sid of m.spouseIds) coupleIds.push(sid);

  const shouldCollapse = !isCoupleCollapsed(memberId);
  for (const id of coupleIds) {
    if (shouldCollapse) collapsedNodes.add(id);
    else collapsedNodes.delete(id);
  }
  renderTree();
}

function getRoleLabel(member) {
  if (member.spouseIds.length > 0 && member.childIds.length > 0) {
    return member.gender === 'F' ? 'Mother' : member.gender === 'M' ? 'Father' : 'Parent';
  }
  if (member.spouseIds.length > 0) return 'Spouse';
  if (member.childIds.length > 0) {
    return member.gender === 'F' ? 'Mother' : member.gender === 'M' ? 'Father' : 'Parent';
  }
  return null;
}

// ============================================================
// NAVIGATION
// ============================================================

export function fitToScreen() {
  if (!svg || !g) return;
  const svgEl = svg.node();
  const bounds = g.node().getBBox();
  if (bounds.width === 0 || bounds.height === 0) return;
  const fw = svgEl.clientWidth, fh = svgEl.clientHeight, pad = 60;
  const scale = Math.min((fw - pad * 2) / bounds.width, (fh - pad * 2) / bounds.height, 1.5);
  const tx = fw / 2 - (bounds.x + bounds.width / 2) * scale;
  const ty = pad - bounds.y * scale + 20;
  svg.transition().duration(500)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

export function zoomToMember(memberId) {
  if (!svg || !g) return;
  const pos = cardPositions.get(memberId);
  if (!pos) return;
  const svgEl = svg.node();
  svg.transition().duration(500)
    .call(zoomBehavior.transform, d3.zoomIdentity
      .translate(svgEl.clientWidth / 2 - (pos.x + CARD_W / 2), svgEl.clientHeight / 2 - (pos.y + CARD_H / 2))
      .scale(1));
}

function renderMinimap(allNodes) {
  if (!minimapG) return;
  minimapG.selectAll('*').remove();
  if (allNodes.length === 0) return;

  // Compute bounds of tree
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of allNodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.isCouple ? n.x + CARD_W * 2 + COUPLE_GAP : n.x + CARD_W);
    maxY = Math.max(maxY, n.y + CARD_H);
  }
  const tw = maxX - minX, th = maxY - minY;
  if (tw === 0 || th === 0) return;

  const mmW = 180, mmH = 120;
  const pad = 10;
  const scale = Math.min((mmW - pad * 2) / tw, (mmH - pad * 2) / th);
  const ox = pad + ((mmW - pad * 2) - tw * scale) / 2 - minX * scale;
  const oy = pad + ((mmH - pad * 2) - th * scale) / 2 - minY * scale;

  minimapG.attr('transform', `translate(${ox}, ${oy}) scale(${scale})`);

  for (const n of allNodes) {
    minimapG.append('rect')
      .attr('x', n.x).attr('y', n.y)
      .attr('width', CARD_W).attr('height', CARD_H)
      .attr('rx', 4)
      .attr('fill', n.member.gender === 'F' ? 'var(--color-female)' : n.member.gender === 'M' ? 'var(--color-male)' : 'var(--color-other)')
      .attr('opacity', 0.6);
    if (n.isCouple && n.spouse) {
      minimapG.append('rect')
        .attr('x', n.x + CARD_W + COUPLE_GAP).attr('y', n.y)
        .attr('width', CARD_W).attr('height', CARD_H)
        .attr('rx', 4)
        .attr('fill', n.spouse.gender === 'F' ? 'var(--color-female)' : 'var(--color-male)')
        .attr('opacity', 0.6);
    }
  }

  // Store for viewbox calc
  minimapSvg.datum({ scale, ox, oy, minX, minY, tw, th });
  updateMinimap(d3.zoomTransform(svg.node()));
}

function updateMinimap(transform) {
  if (!minimapSvg || !minimapViewbox) return;
  const data = minimapSvg.datum();
  if (!data) return;

  const svgEl = svg.node();
  const vw = svgEl.clientWidth, vh = svgEl.clientHeight;

  // Inverse transform to find visible area in tree coords
  const x0 = -transform.x / transform.k;
  const y0 = -transform.y / transform.k;
  const w = vw / transform.k;
  const h = vh / transform.k;

  minimapViewbox
    .attr('x', x0 * data.scale + data.ox)
    .attr('y', y0 * data.scale + data.oy)
    .attr('width', w * data.scale)
    .attr('height', h * data.scale);
}

export function expandAll() { collapsedNodes.clear(); renderTree(); }

export function collapseAll() {
  for (const m of getMembers()) {
    if (m.childIds.length > 0) collapsedNodes.add(m.id);
  }
  renderTree();
}
