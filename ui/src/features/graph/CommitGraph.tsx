import React, { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import type { CommitNode, CommitEdge, RefLabel, GraphResponse, StatusSummary } from "../../api/client";
import CommitNodeComponent from "./CommitNodeComponent";
import SpecialNodeComponent from "./SpecialNodeComponent";

interface CommitGraphProps {
  graph: GraphResponse;
  status?: StatusSummary | null;
  selectedOid: string | null;
  onSelectCommit: (oid: string) => void;
}

/** Synthetic node id for the working-tree (working + staged) pseudo-node. */
export const WORKING_NODE_ID = "__working__";
/** Synthetic node id prefix for stash nodes: `__stash__<index>`. */
export const stashNodeId = (index: number) => `__stash__${index}`;
export const isWorkingId = (id: string) => id === WORKING_NODE_ID;
export const isStashId = (id: string) => id.startsWith("__stash__");
export const stashIndexFromId = (id: string) => Number(id.slice("__stash__".length));

const nodeTypes: NodeTypes = {
  commit: CommitNodeComponent,
  special: SpecialNodeComponent,
};

/**
 * Assign each commit a column (lane) using a simple topological lane algorithm.
 * Commits are already topologically sorted (newest first) from the server.
 */
function assignLanes(
  commits: CommitNode[],
  edges: CommitEdge[]
): Map<string, number> {
  const lanes = new Map<string, number>();
  const childToParents = new Map<string, string[]>();
  const parentToChildren = new Map<string, string[]>();

  for (const e of edges) {
    if (!childToParents.has(e.target)) childToParents.set(e.target, []);
    childToParents.get(e.target)!.push(e.source);
    if (!parentToChildren.has(e.source)) parentToChildren.set(e.source, []);
    parentToChildren.get(e.source)!.push(e.target);
  }

  const activeLanes: (string | null)[] = [];

  for (const commit of commits) {
    const oid = commit.oid;
    // Find a lane that this commit can reuse (from one of its children)
    let lane = -1;
    const children = parentToChildren.get(oid) ?? [];

    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] && children.includes(activeLanes[i]!)) {
        // Check if this child has already been assigned and this is the first parent
        const childLane = lanes.get(activeLanes[i]!);
        if (childLane === i && lane === -1) {
          lane = i;
        } else if (lane === -1) {
          lane = i;
        }
        activeLanes[i] = null;
        break;
      }
    }

    if (lane === -1) {
      // Find a free slot or push a new one
      const free = activeLanes.indexOf(null);
      lane = free === -1 ? activeLanes.length : free;
    }

    lanes.set(oid, lane);
    activeLanes[lane] = oid;
  }

  return lanes;
}

// Node card is ~110px tall at its largest (padding + ref badges + hash/date +
// summary + author). Keep ROW_HEIGHT comfortably above that so rows never overlap.
const ROW_HEIGHT = 120;
const LANE_WIDTH = 240;
const X_BASE = 24;
const Y_BASE = 24;

export default function CommitGraph({
  graph,
  status,
  selectedOid,
  onSelectCommit,
}: CommitGraphProps) {
  const refsByOid = useMemo(() => {
    const map = new Map<string, RefLabel[]>();
    for (const ref of graph.refs) {
      if (!map.has(ref.oid)) map.set(ref.oid, []);
      map.get(ref.oid)!.push(ref);
    }
    return map;
  }, [graph.refs]);

  const lanes = useMemo(
    () => assignLanes(graph.nodes, graph.edges),
    [graph.nodes, graph.edges]
  );

  // Row index of each commit oid, for positioning pseudo-nodes relative to
  // real commits (e.g. the working node just above its base commit).
  const indexByOid = useMemo(() => {
    const m = new Map<string, number>();
    graph.nodes.forEach((c, i) => m.set(c.oid, i));
    return m;
  }, [graph.nodes]);

  const laneOf = (oid: string) => lanes.get(oid) ?? 0;
  const posFor = (oid: string) => {
    const idx = indexByOid.get(oid);
    if (idx === undefined) return null;
    return {
      x: X_BASE + laneOf(oid) * LANE_WIDTH,
      y: Y_BASE + idx * ROW_HEIGHT,
    };
  };

  // The commit HEAD points at — the base for the working-tree pseudo-node.
  const headOid = useMemo(() => {
    const head = graph.refs.find((r) => r.is_head);
    return head?.oid ?? graph.nodes[0]?.oid ?? null;
  }, [graph.refs, graph.nodes]);

  const flowNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((commit, index) => ({
        id: commit.oid,
        type: "commit",
        position: {
          x: X_BASE + (lanes.get(commit.oid) ?? 0) * LANE_WIDTH,
          y: Y_BASE + index * ROW_HEIGHT,
        },
        data: {
          commit,
          refs: refsByOid.get(commit.oid) ?? [],
          selected: commit.oid === selectedOid,
          onSelect: onSelectCommit,
        },
        selected: commit.oid === selectedOid,
      })),
    [graph.nodes, lanes, refsByOid, selectedOid, onSelectCommit]
  );

  // Working-tree pseudo-node (working + staged) + one node per stash.
  const specialNodes: Node[] = useMemo(() => {
    if (!status) return [];
    const out: Node[] = [];

    // Working node: above HEAD, in HEAD's lane, only if the tree is dirty.
    if (status.is_dirty && headOid) {
      const base = posFor(headOid);
      if (base) {
        out.push({
          id: WORKING_NODE_ID,
          type: "special",
          position: { x: base.x, y: base.y - ROW_HEIGHT },
          data: {
            id: WORKING_NODE_ID,
            kind: "working",
            title: "Working tree",
            badges: [
              { label: "staged", value: status.staged_count },
              { label: "unstaged", value: status.unstaged_count },
            ],
            selected: selectedOid === WORKING_NODE_ID,
            onSelect: onSelectCommit,
          },
          selected: selectedOid === WORKING_NODE_ID,
        });
      }
    }

    // Stash nodes: placed to the right of their base commit's lane.
    status.stashes.forEach((stash) => {
      const anchor = stash.base_oid && posFor(stash.base_oid);
      const id = stashNodeId(stash.index);
      // If the base commit isn't in the loaded window, stack stashes in a
      // dedicated far-right column near the top so they're still visible.
      const pos = anchor
        ? { x: anchor.x + LANE_WIDTH, y: anchor.y - ROW_HEIGHT / 2 }
        : { x: X_BASE, y: Y_BASE + stash.index * ROW_HEIGHT };
      out.push({
        id,
        type: "special",
        position: pos,
        data: {
          id,
          kind: "stash",
          title: `stash@{${stash.index}}`,
          subtitle: stash.message,
          selected: selectedOid === id,
          onSelect: onSelectCommit,
        },
        selected: selectedOid === id,
      });
    });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, headOid, indexByOid, lanes, selectedOid, onSelectCommit]);

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        // source = parent (lower on screen), target = child (higher on screen).
        const sourceLane = lanes.get(e.source) ?? 0;
        const targetLane = lanes.get(e.target) ?? 0;

        // Same lane → straight vertical: parent emits from its top, child
        // receives at its bottom. Different lanes (branch/merge) → route through
        // the side facing the other lane so the line bends cleanly instead of
        // crossing over intervening nodes.
        let sourceHandle = "s-top";
        let targetHandle = "t-bottom";
        if (targetLane < sourceLane) {
          // child is to the LEFT of the parent
          sourceHandle = "s-left";
          targetHandle = "t-right";
        } else if (targetLane > sourceLane) {
          // child is to the RIGHT of the parent
          sourceHandle = "s-right";
          targetHandle = "t-left";
        }

        return {
          id: `${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          sourceHandle,
          targetHandle,
          type: "default",
          style: { stroke: "#30363d", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#30363d" },
        };
      }),
    [graph.edges, lanes]
  );

  // Dashed edges connecting pseudo-nodes to the commits they build on.
  const specialEdges: Edge[] = useMemo(() => {
    if (!status) return [];
    const out: Edge[] = [];

    if (status.is_dirty && headOid && indexByOid.has(headOid)) {
      out.push({
        id: `${WORKING_NODE_ID}-${headOid}`,
        source: WORKING_NODE_ID,
        target: headOid,
        sourceHandle: "s-bottom",
        targetHandle: "t-bottom",
        type: "default",
        style: { stroke: "#2f855a", strokeWidth: 2, strokeDasharray: "4 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#2f855a" },
      });
    }

    status.stashes.forEach((stash) => {
      if (stash.base_oid && indexByOid.has(stash.base_oid)) {
        const id = stashNodeId(stash.index);
        out.push({
          id: `${id}-${stash.base_oid}`,
          source: id,
          target: stash.base_oid,
          sourceHandle: "s-bottom",
          targetHandle: "t-bottom",
          type: "default",
          style: { stroke: "#b7791f", strokeWidth: 2, strokeDasharray: "4 3" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#b7791f" },
        });
      }
    });

    return out;
  }, [status, headOid, indexByOid]);

  const allNodes = useMemo(
    () => [...flowNodes, ...specialNodes],
    [flowNodes, specialNodes]
  );
  const allEdges = useMemo(
    () => [...flowEdges, ...specialEdges],
    [flowEdges, specialEdges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(allEdges);

  useEffect(() => {
    setNodes(allNodes);
    setEdges(allEdges);
  }, [allNodes, allEdges, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectCommit(node.id);
    },
    [onSelectCommit]
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-right"
        colorMode="dark"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          color="#21262d"
        />
        <Controls />
        <MiniMap
          nodeColor={(node) => {
            if (node.id === WORKING_NODE_ID) return "#34d399";
            if (isStashId(node.id)) return "#fbbf24";
            return node.selected ? "#58a6ff" : "#30363d";
          }}
          maskColor="rgba(13,17,23,0.7)"
        />
      </ReactFlow>
    </div>
  );
}
