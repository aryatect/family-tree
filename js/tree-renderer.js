import { getMembers, getMemberById, getState } from './data-store.js';
import { getImageUrl } from './google-drive.js';
import { formatDates, getInitials } from './utils.js';

const CARD_W = 180;
const CARD_H = 80;
const COUPLE_GAP = 10;
const H_SPACING = 60;
const V_SPACING = 120;

let svg, g, zoomBehavior;
let onSelectMember = null;
let collapsedNodes = new Set();

export function initTree(container, onSelect) {
  onSelectMember = onSelect;

  svg = d3.select(container)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%');

  // Defs for clip paths and patterns
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

  const state = getState();
  if (!state || !state.members.length) {
    renderEmptyState();
    return;
  }

  const allNodes = computeMultiRootLayout();
  drawConnections(allNodes);
  drawNodes(allNodes);
}

function renderEmptyState() {
  g.append('text')
    .attr('x', 400)
    .attr('y', 300)
    .attr('text-anchor', 'middle')
    .attr('class', 'empty-text')
    .text('Click "Add Person" to start building your family tree');
}

// --- Multi-root: find all connected clusters and lay them out side by side ---

function findClusters() {
  const members = getMembers();
  const visited = new Set();
  const clusters = [];

  for (const member of members) {
    if (visited.has(member.id)) continue;
    // BFS/DFS to find all connected members (via spouse, parent, child links)
    const cluster = [];
    const queue = [member.id];
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      const m = getMemberById(id);
      if (!m) continue;
      visited.add(id);
      cluster.push(m);
      // Traverse all relationship edges
      for (const sid of (m.spouseIds || [])) if (!visited.has(sid)) queue.push(sid);
      for (const cid of (m.childIds || [])) if (!visited.has(cid)) queue.push(cid);
      if (m.fatherId && !visited.has(m.fatherId)) queue.push(m.fatherId);
      if (m.motherId && !visited.has(m.motherId)) queue.push(m.motherId);
    }
    clusters.push(cluster);
  }
  return clusters;
}

function findClusterRoot(cluster) {
  // Find the topmost ancestor(s) — members with no parents within the cluster
  const clusterIds = new Set(cluster.map(m => m.id));
  const roots = cluster.filter(m => {
    const hasParentInCluster = (m.fatherId && clusterIds.has(m.fatherId)) ||
                               (m.motherId && clusterIds.has(m.motherId));
    return !hasParentInCluster;
  });

  if (roots.length === 0) return cluster[0]; // fallback: cycle, pick any

  // Among roots, prefer one that has children (more likely the patriarch/matriarch)
  // Also prefer one that is a "primary" (not a spouse-only node)
  const withChildren = roots.filter(m => m.childIds.length > 0);
  if (withChildren.length > 0) return withChildren[0];
  return roots[0];
}

function computeMultiRootLayout() {
  const clusters = findClusters();
  const allNodes = [];
  const CLUSTER_GAP = 100;
  let offsetX = 0;

  for (const cluster of clusters) {
    const root = findClusterRoot(cluster);
    const { nodes, width } = computeClusterLayout(root);

    // Shift all nodes in this cluster by offsetX
    for (const node of nodes) {
      node.x += offsetX;
      node.centerX += offsetX;
      allNodes.push(node);
    }

    offsetX += width + CLUSTER_GAP;
  }

  return allNodes;
}

// --- Layout computation for a single cluster ---

function computeClusterLayout(rootMember) {
  const nodes = [];
  const visited = new Set();
  const subtreeWidths = new Map();

  // First pass: compute subtree widths bottom-up
  computeSubtreeWidth(rootMember.id, visited, subtreeWidths);

  // Second pass: assign positions top-down
  visited.clear();
  assignPositions(rootMember.id, 0, 0, visited, subtreeWidths, nodes);

  // Calculate total width of this cluster
  let minX = Infinity, maxX = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    const rightEdge = n.isCouple ? n.x + CARD_W * 2 + COUPLE_GAP : n.x + CARD_W;
    maxX = Math.max(maxX, rightEdge);
  }
  const width = nodes.length > 0 ? maxX - minX : CARD_W;

  // Normalize so cluster starts at x=0
  if (minX !== 0 && nodes.length > 0) {
    for (const n of nodes) {
      n.x -= minX;
      n.centerX -= minX;
    }
  }

  return { nodes, width };
}

function getNodeWidth(memberId) {
  const member = getMemberById(memberId);
  if (!member) return CARD_W;
  // If has spouse, the couple takes more width
  if (member.spouseIds.length > 0) {
    return CARD_W * 2 + COUPLE_GAP;
  }
  return CARD_W;
}

function getChildren(memberId) {
  const member = getMemberById(memberId);
  if (!member) return [];
  // Collect all unique children from this member and their spouses
  const childSet = new Set(member.childIds || []);
  return [...childSet];
}

function computeSubtreeWidth(memberId, visited, widthMap) {
  if (visited.has(memberId)) return widthMap.get(memberId) || CARD_W;
  visited.add(memberId);

  // Also mark spouses as visited to avoid double-processing
  const member = getMemberById(memberId);
  if (!member) { widthMap.set(memberId, CARD_W); return CARD_W; }
  for (const sid of member.spouseIds) visited.add(sid);

  if (collapsedNodes.has(memberId)) {
    const w = getNodeWidth(memberId);
    widthMap.set(memberId, w);
    return w;
  }

  const children = getChildren(memberId);
  if (children.length === 0) {
    const w = getNodeWidth(memberId);
    widthMap.set(memberId, w);
    return w;
  }

  let totalChildWidth = 0;
  for (const cid of children) {
    totalChildWidth += computeSubtreeWidth(cid, visited, widthMap) + H_SPACING;
  }
  totalChildWidth -= H_SPACING; // remove trailing spacing

  const nodeW = getNodeWidth(memberId);
  const w = Math.max(nodeW, totalChildWidth);
  widthMap.set(memberId, w);
  return w;
}

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
      member,
      x: leftX,
      y,
      isCouple: true,
      spouse,
      centerX
    });
  } else {
    nodes.push({
      member,
      x: centerX - CARD_W / 2,
      y,
      isCouple: false,
      spouse: null,
      centerX
    });
  }

  // Position children
  if (!collapsedNodes.has(memberId)) {
    const children = getChildren(memberId);
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

// --- Drawing ---

function drawConnections(nodes) {
  const connGroup = g.append('g').attr('class', 'connections');
  const nodeMap = new Map();
  for (const n of nodes) {
    nodeMap.set(n.member.id, n);
    if (n.spouse) nodeMap.set(n.spouse.id, n);
  }

  for (const node of nodes) {
    // Spouse connector
    if (node.isCouple && node.spouse) {
      const x1 = node.x + CARD_W;
      const x2 = node.x + CARD_W + COUPLE_GAP;
      const cy = node.y + CARD_H / 2;
      connGroup.append('line')
        .attr('x1', x1).attr('y1', cy)
        .attr('x2', x2).attr('y2', cy)
        .attr('class', 'conn-spouse');
    }

    // Parent-child connectors
    if (!collapsedNodes.has(node.member.id)) {
      const children = getChildren(node.member.id);
      if (children.length > 0) {
        const parentY = node.y + CARD_H;
        const midY = node.y + CARD_H + V_SPACING / 2;
        const childY = node.y + CARD_H + V_SPACING;

        // Vertical line down from parent center
        connGroup.append('line')
          .attr('x1', node.centerX).attr('y1', parentY)
          .attr('x2', node.centerX).attr('y2', midY)
          .attr('class', 'conn-vertical');

        // Find child positions
        const childPositions = [];
        for (const cid of children) {
          const cn = nodeMap.get(cid);
          if (cn) childPositions.push(cn.centerX);
        }

        if (childPositions.length > 0) {
          // Horizontal bar
          const minX = Math.min(...childPositions);
          const maxX = Math.max(...childPositions);
          if (childPositions.length > 1) {
            connGroup.append('line')
              .attr('x1', minX).attr('y1', midY)
              .attr('x2', maxX).attr('y2', midY)
              .attr('class', 'conn-horizontal');
          }

          // Vertical drops to each child
          for (const cx of childPositions) {
            connGroup.append('line')
              .attr('x1', cx).attr('y1', midY)
              .attr('x2', cx).attr('y2', childY)
              .attr('class', 'conn-vertical');
          }
        }
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
  const card = parent.append('g')
    .attr('class', `card card--${member.gender === 'F' ? 'female' : member.gender === 'O' ? 'other' : 'male'}`)
    .attr('transform', `translate(${x}, ${y})`)
    .style('cursor', 'pointer')
    .on('click', (event) => {
      event.stopPropagation();
      if (onSelectMember) onSelectMember(member.id);
    });

  // Card background
  card.append('rect')
    .attr('width', CARD_W)
    .attr('height', CARD_H)
    .attr('rx', 10)
    .attr('class', 'card-bg');

  // Gender accent bar
  card.append('rect')
    .attr('width', 4)
    .attr('height', CARD_H)
    .attr('rx', 2)
    .attr('class', 'card-accent');

  // Avatar
  const avatarG = card.append('g')
    .attr('transform', `translate(36, ${CARD_H / 2})`);

  if (member.avatar) {
    avatarG.append('clipPath')
      .attr('id', `clip-${member.id}`)
      .append('circle')
      .attr('r', 22);

    avatarG.append('image')
      .attr('href', getImageUrl(member.avatar, 200))
      .attr('x', -22)
      .attr('y', -22)
      .attr('width', 44)
      .attr('height', 44)
      .attr('clip-path', `url(#clip-${member.id})`)
      .attr('preserveAspectRatio', 'xMidYMid slice');
  } else {
    avatarG.append('circle')
      .attr('r', 22)
      .attr('class', 'avatar-placeholder');

    avatarG.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('class', 'avatar-initials')
      .text(getInitials(member));
  }

  // Name
  const name = `${member.firstName} ${member.lastName}`.trim();
  card.append('text')
    .attr('x', 68)
    .attr('y', CARD_H / 2 - 8)
    .attr('class', 'card-name')
    .text(name.length > 14 ? name.substring(0, 13) + '…' : name);

  // Dates
  const dates = formatDates(member);
  if (dates) {
    card.append('text')
      .attr('x', 68)
      .attr('y', CARD_H / 2 + 10)
      .attr('class', 'card-dates')
      .text(dates);
  }

  // Collapse/expand toggle for nodes with children
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

    toggleG.append('circle')
      .attr('r', 10)
      .attr('class', 'toggle-circle');

    const isCollapsed = collapsedNodes.has(member.id);
    toggleG.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('class', 'toggle-text')
      .text(isCollapsed ? '+' : '−');
  }
}

function toggleCollapse(memberId) {
  if (collapsedNodes.has(memberId)) {
    collapsedNodes.delete(memberId);
  } else {
    collapsedNodes.add(memberId);
  }
  renderTree();
}

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
  const card = g.select(`.card`).filter(function () {
    return this.__memberId === memberId;
  });
  // Fallback: search all cards
  const allCards = g.selectAll('.card');
  let targetX = 0, targetY = 0, found = false;
  allCards.each(function () {
    const transform = d3.select(this).attr('transform');
    const match = transform.match(/translate\(([\d.-]+),\s*([\d.-]+)\)/);
    if (match) {
      // Check card text content for member name
      const nameEl = d3.select(this).select('.card-name');
      const member = getMemberById(memberId);
      if (member && nameEl.text().startsWith(member.firstName)) {
        targetX = parseFloat(match[1]) + CARD_W / 2;
        targetY = parseFloat(match[2]) + CARD_H / 2;
        found = true;
      }
    }
  });

  if (found) {
    const svgEl = svg.node();
    const fullWidth = svgEl.clientWidth;
    const fullHeight = svgEl.clientHeight;
    const scale = 1;
    svg.transition().duration(500)
      .call(zoomBehavior.transform,
        d3.zoomIdentity
          .translate(fullWidth / 2 - targetX * scale, fullHeight / 2 - targetY * scale)
          .scale(scale));
  }
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
