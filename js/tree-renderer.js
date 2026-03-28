import { getMembers, getMemberById, getState } from './data-store.js';
import { getImageUrl } from './google-drive.js';
import { formatDates, getInitials } from './utils.js';

const CARD_W = 180;
const CARD_H = 80;
const COUPLE_GAP = 10;
const H_SPACING = 60;
const V_SPACING = 120;
const SUBTREE_GAP = 120;

let svg, g, zoomBehavior;
let onSelectMember = null;
let collapsedNodes = new Set();
let cardPositions = new Map();

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
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoomBehavior);
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
  drawConnections(allNodes);
  drawNodes(allNodes);
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
 * Get children of a couple, but only those belonging to myLineage
 * (children from other lineages are rendered in their own subtree).
 */
function getCoupleChildren(memberId, myLineage, hidden) {
  const m = getMemberById(memberId);
  if (!m) return [];
  const childSet = new Set(m.childIds || []);
  for (const sid of m.spouseIds) {
    const spouse = getMemberById(sid);
    if (spouse) for (const cid of (spouse.childIds || [])) childSet.add(cid);
  }
  // Only include children in our lineage and not hidden
  return [...childSet].filter(cid => myLineage.has(cid) && !hidden.has(cid));
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

  // Track which children have been connected to a parent (within-subtree)
  const connectedChildren = new Set();

  for (const node of nodes) {
    // Spouse connector
    if (node.isCouple && node.spouse) {
      connGroup.append('line')
        .attr('x1', node.x + CARD_W).attr('y1', node.y + CARD_H / 2)
        .attr('x2', node.x + CARD_W + COUPLE_GAP).attr('y2', node.y + CARD_H / 2)
        .attr('class', 'conn-spouse');
    }

    // Parent → child connectors (WITHIN subtree only)
    if (collapsedNodes.has(node.member.id)) continue;
    const allChildIds = new Set(node.member.childIds || []);
    if (node.spouse) {
      for (const cid of (node.spouse.childIds || [])) allChildIds.add(cid);
    }

    // Only connect to children rendered directly below (same subtree, y = node.y + CARD_H + V_SPACING)
    const directChildren = [...allChildIds].filter(cid => {
      const cp = posMap.get(cid);
      return cp && Math.abs(cp.y - (node.y + CARD_H + V_SPACING)) < 5;
    });

    if (directChildren.length === 0) continue;

    const parentY = node.y + CARD_H;
    const midY = node.y + CARD_H + V_SPACING / 2;

    connGroup.append('line')
      .attr('x1', node.centerX).attr('y1', parentY)
      .attr('x2', node.centerX).attr('y2', midY)
      .attr('class', 'conn-vertical');

    const childCXs = directChildren.map(cid => posMap.get(cid).cx);
    const allXs = [...childCXs, node.centerX];
    const minX = Math.min(...allXs);
    const maxX = Math.max(...allXs);

    if (maxX > minX) {
      connGroup.append('line')
        .attr('x1', minX).attr('y1', midY)
        .attr('x2', maxX).attr('y2', midY)
        .attr('class', 'conn-horizontal');
    }

    for (const cid of directChildren) {
      const cp = posMap.get(cid);
      connGroup.append('line')
        .attr('x1', cp.cx).attr('y1', midY)
        .attr('x2', cp.cx).attr('y2', cp.y)
        .attr('class', 'conn-vertical');
      connectedChildren.add(cid);
    }
  }

  // CROSS-SUBTREE parent-child connections:
  // For each rendered person who has parents also rendered but NOT connected above,
  // draw a curved ancestry line from the parent couple to the child.
  const members = getMembers();
  for (const m of members) {
    if (!posMap.has(m.id)) continue;
    if (connectedChildren.has(m.id)) continue; // already connected within subtree

    // Check if any parent is rendered
    const parentIds = [m.fatherId, m.motherId].filter(pid => pid && posMap.has(pid));
    if (parentIds.length === 0) continue;

    // Find the parent's couple node to get the couple center
    const parentId = parentIds[0];
    const parentNode = nodes.find(n =>
      n.member.id === parentId || n.spouse?.id === parentId
    );
    if (!parentNode) continue;

    const childPos = posMap.get(m.id);
    const parentCenterX = parentNode.centerX;
    const parentBottomY = parentNode.y + CARD_H;

    // Draw a curved path from parent to child
    const path = d3.path();
    path.moveTo(parentCenterX, parentBottomY);
    const midY = (parentBottomY + childPos.y) / 2;
    path.bezierCurveTo(
      parentCenterX, midY,
      childPos.cx, midY,
      childPos.cx, childPos.y
    );

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

  const name = `${member.firstName} ${member.lastName}`.trim();
  card.append('text').attr('x', 68).attr('y', CARD_H / 2 - 8)
    .attr('class', 'card-name')
    .text(name.length > 14 ? name.substring(0, 13) + '…' : name);

  const dates = formatDates(member);
  if (dates) {
    card.append('text').attr('x', 68).attr('y', CARD_H / 2 + 10)
      .attr('class', 'card-dates').text(dates);
  }

  // Collapse toggle for members with children
  const allChildIds = new Set(member.childIds || []);
  for (const sid of member.spouseIds) {
    const spouse = getMemberById(sid);
    if (spouse) for (const cid of (spouse.childIds || [])) allChildIds.add(cid);
  }
  if (allChildIds.size > 0) {
    const toggleG = card.append('g')
      .attr('transform', `translate(${CARD_W / 2}, ${CARD_H})`)
      .attr('class', 'collapse-toggle')
      .style('cursor', 'pointer')
      .on('click', (event) => {
        event.stopPropagation();
        toggleCollapse(member.id);
      });
    toggleG.append('circle').attr('r', 10).attr('class', 'toggle-circle');
    toggleG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('class', 'toggle-text')
      .text(collapsedNodes.has(member.id) ? '+' : '−');
  }
}

function toggleCollapse(memberId) {
  if (collapsedNodes.has(memberId)) collapsedNodes.delete(memberId);
  else collapsedNodes.add(memberId);
  renderTree();
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

export function expandAll() { collapsedNodes.clear(); renderTree(); }

export function collapseAll() {
  for (const m of getMembers()) {
    if (m.childIds.length > 0) collapsedNodes.add(m.id);
  }
  renderTree();
}
