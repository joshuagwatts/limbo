/* LIMBO — bird-flock V-formation math (build 33).
 *
 * Pure functions, zero dependencies (no THREE), so node can unit-test them.
 * The flight axis is -Z: "forward" = most negative z. All clients run the
 * same math on the same broadcast positions, so every client assigns the
 * same leader and the same V slots — the formation is deterministic.
 */

export const FLOCK_R = 14;        // join radius: orbs this close flock
export const FLOCK_R_LEAVE = 19;  // leave radius (hysteresis: no flicker at the edge)
export const SLOT_DX = 4.5;       // lateral spacing per V rank
export const SLOT_DZ = 5.5;       // back spacing per V rank
export const SLOT_DY = 0.8;       // slight rise per V rank

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* Cluster members into flocks (transitive: A near B near C = one flock).
 * members: [{cid, x, y, z}] — cid is the per-session client UUID.
 * prevAssign: optional Map(cid -> flockKey) from the last tick; pairs that
 *   were flocked together stay together out to FLOCK_R_LEAVE (hysteresis).
 * Returns [{ key, members: [member...] }] with members sorted by cid.
 */
export function clusterOrbs(members, prevAssign) {
  const sorted = members.slice().sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const n = sorted.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  };
  const prevKey = (m) => (prevAssign ? prevAssign.get(m.cid) : undefined);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist3(sorted[i], sorted[j]);
      if (d <= FLOCK_R) { union(i, j); continue; }
      // Hysteresis: previously flocked pair holds together a little longer.
      if (d <= FLOCK_R_LEAVE) {
        const ki = prevKey(sorted[i]), kj = prevKey(sorted[j]);
        if (ki !== undefined && ki === kj) union(i, j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(sorted[i]);
  }
  let ki = 0;
  return [...groups.values()].map((members) => ({ key: 'f' + (ki++), members }));
}

/* Assign V slots inside one cluster.
 * Leader = furthest forward (min z) — the apex of the V, like migrating birds.
 * Everyone else, in cid order, takes alternating left/right slots falling
 * back and outward by rank: rank 1 = just behind the leader, rank 2 wider...
 * Returns { leader, slots: Map(cid -> {x, y, z}), order: [cids in slot order] }.
 */
export function assignVSlots(clusterMembers) {
  const members = clusterMembers.slice();
  let leader = members[0];
  for (const m of members) if (m.z < leader.z) leader = m;
  const rest = members.filter((m) => m !== leader).sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  const slots = new Map();
  const order = [];
  rest.forEach((m, i) => {
    const rank = Math.floor(i / 2) + 1;
    const side = i % 2 === 0 ? -1 : 1; // left, right, left, right…
    slots.set(m.cid, {
      x: leader.x + side * rank * SLOT_DX,
      y: leader.y + rank * SLOT_DY,
      z: leader.z + rank * SLOT_DZ,
    });
    order.push(m.cid);
  });
  return { leader, slots, order };
}

/* Full pass: cluster, then slot every multi-orb cluster.
 * Returns { flocks: [{key, leaderCid, slots: Map, order}], solo: [cids],
 *           assign: Map(cid -> flockKey) } — assign feeds the next tick's
 * hysteresis so the formation never jitters at the radius edge.
 */
export function computeFlocks(members, prevAssign) {
  const clusters = clusterOrbs(members, prevAssign);
  const flocks = [];
  const solo = [];
  const assign = new Map();
  for (const c of clusters) {
    if (c.members.length < 2) {
      solo.push(c.members[0].cid);
      continue;
    }
    const { leader, slots, order } = assignVSlots(c.members);
    for (const m of c.members) assign.set(m.cid, c.key);
    flocks.push({ key: c.key, leaderCid: leader.cid, slots, order });
  }
  return { flocks, solo, assign };
}
