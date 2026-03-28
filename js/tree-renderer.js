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

// Maps memberId -> { x, y, centerX, w, h } for every rendered card
let cardPositions = new Map();

export function initTree(container, onSelect) {
  onSelectMember = onSelect;

  svg = d3.select(container)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%');

  const defs = svg.append('defs');
  defs.append('clipPath')
    .attr('id', 'avatar-clip')
    .append('circle')
    .attr('r', 22)
    .attr('cx', 0)
    .attr('cy', 0);

  g = svg.append('g').attr('class', 'tree-canvas');

  zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 3])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });

  svg.call(zoomBehavior);
  renderTree();
}

export function renderTree() {
  if (!g) return;
  g.selectAll('*').remove();
  cardPositions = new Map();

  const state = getState();
  if (!state || !state.members.length) {
    renderEmptyState();
    return;
  }

  const allNodes = computeFullLayout();
  drawConnections(allNodes);
  drawNodes(allNodes);
}

function renderEmptyState() {
  g.append('text')
    .attr('x', 400).attr('y', 300)
    .attr('text-anchor', 'middle')
    .attr('class', 'empty-text')
    .text('Click "Add Person" to start building your family tree');
}

// ============================================================
// LAYOUT ENGINE — supports multiple roots per cluster
// ============================================================

/**
 * Find all connected clusters via BFS across ALL relationship edges.
 */
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

/**
 * Within a cluster, find ALL root ancestors (members whose parents are
 * not in the data). Each root anchors its own subtree.
 */
function findAllRoots(cluster) {
  const clusterIds = new Set(cluster.map(m => m.id));
  const roots = cluster.filter(m => {
    const hasFather = m.fatherId && clusterIds.has(m.fatherId);
    const hasMother = m.motherId && clusterIds.has(m.motherId);
    return !hasFather && !hasMother;
  });
  if (roots.length === 0) return [cluster[0]];

  // De-duplicate: if both members of a couple are roots, keep only the
  // "primary" one (the one we'll draw on the left). We pick the one
  // who has children, or the male by convention, so the spouse renders
  // beside them automatically.
  const rootIds = new Set(roots.map(r => r.id));
  const deduped = [];
  const handled = new Set();
  for (const r of roots) {
    if (handled.has(r.id)) continue;
    handled.add(r.id);
    // If this root's spouse is also a root AND they share children, skip the spouse
    for (const sid of r.spouseIds) {
      if (rootIds.has(sid)) handled.add(sid);
    }
    deduped.push(r);
  }
  return deduped;
}

/**
 * Determine which root "owns" a member for layout purposes.
 * Walk upward through father/mother until we reach a root.
 */
function findOwningRoot(memberId, rootIds) {
  const visited = new Set();
  let current = getMemberById(memberId);
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    if (rootIds.has(current.id)) return current.id;
    // Walk up — prefer father, then mother
    const father = current.fatherId ? getMemberById(current.fatherId) : null;
    if (father) { current = father; continue; }
    const mother = current.motherId ? getMemberById(current.motherId) : null;
    if (mother) { current = mother; continue; }
    break;
  }
  return null;
}

/**
 * Master layout: lay out every cluster, within each cluster lay out
 * each root's subtree, placing subtrees side by side.
 */
function computeFullLayout() {
  const clusters = findClusters();
  const allNodes = [];
  let globalOffsetX = 0;

  for (const cluster of clusters) {
    const roots = findAllRoots(cluster);
    const rootIds = new Set(roots.map(r => r.id));
    // Also include spouses of roots so they aren't treated as separate
    for (const r of roots) {
      for (const sid of r.spouseIds) rootIds.add(sid);
    }

    // Layout each root's subtree independently
    const subtreeLayouts = [];
    const globalVisited = new Set(); // track across subtrees to avoid duplicates

    for (const root of roots) {
      if (globalVisited.has(root.id)) continue;
      const { nodes, width } = layoutSubtree(root, globalVisited);
      subtreeLayouts.push({ nodes, width });
    }

    // Place subtrees side by side within the cluster
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

/**
 * Layout a single subtree rooted at `rootMember`.
 * `globalVisited` prevents rendering the same person in multiple subtrees.
 */
function layoutSubtree(rootMember, globalVisited) {
  const nodes = [];
  const visited = new Set();
  const subtreeWidths = new Map();

  // Copy globalVisited so we respect already-rendered members
  for (const id of globalVisited) visited.add(id);

  computeSubtreeWidth(rootMember.id, visited, subtreeWidths);

  // Reset visited for position pass (but keep globalVisited exclusions)
  visited.clear();
  for (const id of globalVisited) visited.add(id);

  assignPositions(rootMember.id, 0, 0, visited, subtreeWidths, nodes);

  // Mark all rendered members as globally visited
  for (const n of nodes) {
    globalVisited.add(n.member.id);
    if (n.spouse) globalVisited.add(n.spouse.id);
  }

  // Normalize positions so subtree starts at x=0
  let minX = Infinity, maxX = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    const rightEdge = n.isCouple ? n.x + CARD_W * 2 + COUPLE_GAP : n.x + CARD_W;
    maxX = Math.max(maxX, rightEdge);
  }
  const width = nodes.length > 0 ? maxX - minX : CARD_W;
  if (nodes.length > 0 && minX !== 0) {
    for (const n of nodes) {
      n.x -= minX;
      n.centerX -= minX;
    }
  }

  return { nodes, width };
}

// ============================================================
// SUBTREE WIDTH COMPUTATION (recursive, top-down)
// ============================================================

function getNodeWidth(memberId) {
  const member = getMemberById(memberId);
  if (!member) return CARD_W;
  if (member.spouseIds.length > 0) return CARD_W * 2 + COUPLE_GAP;
  return CARD_W;
}

function getChildren(memberId) {
  const member = getMemberById(memberId);
  if (!member) return [];
  return [...new Set(member.childIds || [])];
}

function computeSubtreeWidth(memberId, visited, widthMap) {
  if (visited.has(memberId)) return widthMap.get(memberId) || CARD_W;
  visited.add(memberId);

  const member = getMemberById(memberId);
  if (!member) { widthMap.set(memberId, CARD_W); return CARD_W; }

  // Mark spouse as visited so they aren't processed as separate root
  for (const sid of member.spouseIds) visited.add(sid);

  if (collapsedNodes.has(memberId)) {
    const w = getNodeWidth(memberId);
    widthMap.set(memberId, w);
    return w;
  }

  const children = getChildren(memberId);
  // Also include spouse's children (in case children are only on spouse)
  for (const sid of member.spouseIds) {
    const spouse = getMemberById(sid);
    if (spouse) {
      for (const cid of (spouse.childIds || [])) {
        if (!children.includes(cid)) children.push(cid);
      }
    }
  }

  if (children.length === 0) {
    const w = getNodeWidth(memberId);
    widthMap.set(memberId, w);
    return w;
  }

  let totalChildWidth = 0;
  for (const cid of children) {
    totalChildWidth += computeSubtreeWidth(cid, visited, widthMap) + H_SPACING;
  }
  totalChildWidth -= H_SPACING;

  const nodeW = getNodeWidth(memberId);
  const w = Math.max(nodeW, totalChildWidth);
  widthMap.set(memberId, w);
  return w;
}

// ============================================================
// POSITION ASSIGNMENT (recursive, top-down)
// ============================================================

function assignPositions(memberId, x, y, visited, widthMap, nodes) {
  if (visited.has(memberId)) return;
  visited.add(memberId);

  const member = getMemberById(memberId);
  if (!member) return;

  const subtreeW = widthMap.get(memberId) || CARD_W;
  const centerX = x + subtreeW / 2;

  // Mark spouses visited
  for (const sid of member.spouseIds) visited.add(sid);

  // Position this member (and spouse if any)
  const spouse = member.spouseIds.length > 0 ? getMemberById(member.spouseIds[0]) : null;

  if (spouse) {
    const coupleW = CARD_W * 2 + COUPLE_GAP;
    const leftX = centerX - coupleW / 2;
    nodes.push({
      member, x: leftX, y, isCouple: true, spouse, centerX
    });
  } else {
    nodes.push({
      member, x: centerX - CARD_W / 2, y, isCouple: false, spouse: null, centerX
    });
  }

  // Collect all children (from this member + spouse)
  if (!collapsedNodes.has(memberId)) {
    const children = getChildren(memberId);
    if (spouse) {
      for (const cid of (spouse.childIds || [])) {
        if (!children.includes(cid)) children.push(cid);
      }
    }

    if (children.length > 0) {
      let totalChildWidth = 0;
      for (const cid of children) {
        totalChildWidth += (widthMap.get(cid) || CARD_W) + H_SPACING;
      }
      totalChildWidth -= H_SPACING;

      let childX = centerX - totalChildWidth / 2;
      const childY = y + CARD_H + V_SPACING;

      for (const cid of children) {
        const cw = widthMap.get(cid) || CARD_W;
        assignPositions(cid, childX, childY, visited, widthMap, nodes);
        childX += cw + H_SPACING;
      }
    }
  }
}

// ============================================================
// DRAWING
// ============================================================

function drawConnections(nodes) {
  const connGroup = g.append('g').attr('class', 'connections');

  // Build a position map for every rendered card (both primary and spouse)
  const posMap = new Map(); // memberId -> { cx, cy, x, y }
  for (const n of nodes) {
    posMap.set(n.member.id, {
      cx: n.isCouple ? n.x + CARD_W / 2 : n.centerX,
      cy: n.y + CARD_H / 2,
      x: n.x,
      y: n.y,
      centerX: n.centerX
    });
    if (n.spouse) {
      const spouseX = n.x + CARD_W + COUPLE_GAP;
      posMap.set(n.spouse.id, {
        cx: spouseX + CARD_W / 2,
        cy: n.y + CARD_H / 2,
        x: spouseX,
        y: n.y,
        centerX: spouseX + CARD_W / 2
      });
    }
  }

  for (const node of nodes) {
    // Spouse connector line
    if (node.isCouple && node.spouse) {
      const x1 = node.x + CARD_W;
      const x2 = node.x + CARD_W + COUPLE_GAP;
      const cy = node.y + CARD_H / 2;
      connGroup.append('line')
        .attr('x1', x1).attr('y1', cy)
        .attr('x2', x2).attr('y2', cy)
        .attr('class', 'conn-spouse');
    }

    // Parent-child connectors: draw from this node (as parent) to its children
    const parentMember = node.member;
    if (collapsedNodes.has(parentMember.id)) continue;

    // Gather all children of this couple
    const childIdsSet = new Set(parentMember.childIds || []);
    if (node.spouse) {
      for (const cid of (node.spouse.childIds || [])) childIdsSet.add(cid);
    }
    const childIds = [...childIdsSet];

    // Only draw from children that are actually rendered
    const renderedChildren = childIds.filter(cid => posMap.has(cid));
    if (renderedChildren.length === 0) continue;

    const parentY = node.y + CARD_H;
    const midY = node.y + CARD_H + V_SPACING / 2;

    // Vertical line down from couple center
    connGroup.append('line')
      .attr('x1', node.centerX).attr('y1', parentY)
      .attr('x2', node.centerX).attr('y2', midY)
      .attr('class', 'conn-vertical');

    const childCXs = renderedChildren.map(cid => posMap.get(cid).cx);

    if (childCXs.length > 0) {
      // Include parent centerX in horizontal bar range so line connects
      const allXs = [...childCXs, node.centerX];
      const minX = Math.min(...allXs);
      const maxX = Math.max(...allXs);

      if (maxX > minX) {
        connGroup.append('line')
          .attr('x1', minX).attr('y1', midY)
          .attr('x2', maxX).attr('y2', midY)
          .attr('class', 'conn-horizontal');
      }

      // Vertical drops to each child
      for (const cx of childCXs) {
        const childNode = renderedChildren.find(cid => posMap.get(cid).cx === cx);
        const childY = posMap.get(childNode)?.y ?? (node.y + CARD_H + V_SPACING);
        connGroup.append('line')
          .attr('x1', cx).attr('y1', midY)
          .attr('x2', cx).attr('y2', childY)
          .attr('class', 'conn-vertical');
      }
    }
  }

  // Cross-subtree spouse connectors: if a spouse was rendered in a different
  // subtree, draw a dashed line between them
  const members = getMembers();
  for (const m of members) {
    if (!posMap.has(m.id)) continue;
    for (const sid of m.spouseIds) {
      if (!posMap.has(sid)) continue;
      const p1 = posMap.get(m.id);
      const p2 = posMap.get(sid);
      // Only draw if they're NOT already rendered as a couple in the same node
      const alreadyCouple = nodes.some(n =>
        (n.member.id === m.id && n.spouse?.id === sid) ||
        (n.member.id === sid && n.spouse?.id === m.id)
      );
      if (!alreadyCouple && m.id < sid) { // m.id < sid to draw only once
        connGroup.append('line')
          .attr('x1', p1.cx).attr('y1', p1.cy)
          .attr('x2', p2.cx).attr('y2', p2.cy)
          .attr('class', 'conn-spouse');
      }
    }
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
  // Store position for zoom-to-member
  cardPositions.set(member.id, { x, y });

  const card = parent.append('g')
    .attr('class', `card card--${member.gender === 'F' ? 'female' : member.gender === 'O' ? 'other' : 'male'}`)
    .attr('transform', `translate(${x}, ${y})`)
    .style('cursor', 'pointer')
    .on('click', (event) => {
      event.stopPropagation();
      if (onSelectMember) onSelectMember(member.id);
    });

  card.append('rect')
    .attr('width', CARD_W).attr('height', CARD_H)
    .attr('rx', 10).attr('class', 'card-bg');

  card.append('rect')
    .attr('width', 4).attr('height', CARD_H)
    .attr('rx', 2).attr('class', 'card-accent');

  const avatarG = card.append('g')
    .attr('transform', `translate(36, ${CARD_H / 2})`);

  if (member.avatar) {
    avatarG.append('clipPath')
      .attr('id', `clip-${member.id}`)
      .append('circle').attr('r', 22);
    avatarG.append('image')
      .attr('href', getImageUrl(member.avatar, 200))
      .attr('x', -22).attr('y', -22)
      .attr('width', 44).attr('height', 44)
      .attr('clip-path', `url(#clip-${member.id})`)
      .attr('preserveAspectRatio', 'xMidYMid slice');
  } else {
    avatarG.append('circle').attr('r', 22).attr('class', 'avatar-placeholder');
    avatarG.append('text')
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('class', 'avatar-initials')
      .text(getInitials(member));
  }

  const name = `${member.firstName} ${member.lastName}`.trim();
  card.append('text')
    .attr('x', 68).attr('y', CARD_H / 2 - 8)
    .attr('class', 'card-name')
    .text(name.length > 14 ? name.substring(0, 13) + '…' : name);

  const dates = formatDates(member);
  if (dates) {
    card.append('text')
      .attr('x', 68).attr('y', CARD_H / 2 + 10)
      .attr('class', 'card-dates')
      .text(dates);
  }

  // Collapse toggle — show for members OR their spouses who have children
  const children = getChildren(member.id);
  if (children.length > 0) {
    const toggleG = card.append('g')
      .attr('transform', `translate(${CARD_W / 2}, ${CARD_H})`)
      .attr('class', 'collapse-toggle')
      .style('cursor', 'pointer')
      .on('click', (event) => {
        event.stopPropagation();
        toggleCollapse(member.id);
      });
    toggleG.append('circle').attr('r', 10).attr('class', 'toggle-circle');
    toggleG.append('text')
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
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

  const fullWidth = svgEl.clientWidth;
  const fullHeight = svgEl.clientHeight;
  const padding = 60;

  const scale = Math.min(
    (fullWidth - padding * 2) / bounds.width,
    (fullHeight - padding * 2) / bounds.height,
    1.5
  );

  const tx = fullWidth / 2 - (bounds.x + bounds.width / 2) * scale;
  const ty = padding - bounds.y * scale + 20;

  svg.transition().duration(500)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

export function zoomToMember(memberId) {
  if (!svg || !g) return;
  const pos = cardPositions.get(memberId);
  if (!pos) return;

  const svgEl = svg.node();
  const fullWidth = svgEl.clientWidth;
  const fullHeight = svgEl.clientHeight;
  const targetX = pos.x + CARD_W / 2;
  const targetY = pos.y + CARD_H / 2;

  svg.transition().duration(500)
    .call(zoomBehavior.transform,
      d3.zoomIdentity
        .translate(fullWidth / 2 - targetX, fullHeight / 2 - targetY)
        .scale(1));
}

export function expandAll() {
  collapsedNodes.clear();
  renderTree();
}

export function collapseAll() {
  const members = getMembers();
  for (const m of members) {
    if (m.childIds.length > 0) collapsedNodes.add(m.id);
  }
  renderTree();
}
