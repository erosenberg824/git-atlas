# Requirements Document

## Introduction

This feature makes merge commits a first-class, collapsible node type in the git-atlas commit graph. Today the graph seeds from all refs and renders every reachable commit, folding only long linear stretches; merged-in branch history remains cluttered even when that work is complete and lives only behind a merge commit.

A merge commit `M` has a first parent `P1` (the mainline continuation) and one or more secondary parents `P2..Pn` (the merged-in branch tips). For each secondary parent `Pk`, the feature computes a secondary-path hide set — the commits reachable from `Pk` but not from `P1` — and hides it by default, leaving `M` visible as the expand point. The hide set is a branch-shaped sub-DAG, is orphan-safe by construction, and is recursive (a hidden path may contain its own inner merges that become collapsible in turn).

On load, the graph shows only the leaf frontiers (local branch tips and HEAD not reachable from any other local tip), collapsing everything already merged behind its merge node. All logic is client-side and topological over the already-loaded DAG; it requires no server round-trip. It coexists with the existing Round 3 region-collapse and coordinates with — but remains separate from — the branch panel. This requirements document is derived from the approved `design.md` and is traceable to it; it introduces no behavior beyond what the design specifies.

A follow-up round (Requirements 14–17) makes ref-carrying commits foldable: a commit that carries a branch, remote-branch, or tag ref is eligible for region collapse purely by graph topology (only the checked-out HEAD commit is exempt), fixing a defect where ref-carrying commits and their neighbors were denied expand/collapse controls. To ensure no ref silently disappears when folded, folded refs are surfaced as badges on the summary node (region rollup and merge-node affordance), with a distinct outline treatment for refs buried inside a fold versus a solid badge for a ref on the fold's head member.

A further follow-up round (Requirements 19–23) fixes fold-control placement and selection-boundary defects: the expand and collapse controls are made positionally consistent so a control does not jump when a node folds or expands, and the selected commit is no longer treated as a hard region boundary that silently strips expand/collapse controls from itself and its neighbors. When a fold hides the selected commit, selection follows the fold onto the resulting summary node. This round adds no new folding mechanism; it corrects placement and selection behavior over the existing Region_Collapse and merge secondary-path folds. A closing non-normative "Future / out of scope" subsection records ideas that are explicitly not part of this round.

A further follow-up round (Requirements 24–27) corrects on-screen defects that survived the placement round: the Fold_Control must not occlude the topmost content (the commit/merge date, or the run label) on any node type regardless of ref-badge presence; the expand affordance on the run summary node is moved into the same top-right corner as the commit/merge collapse control so fold and expand share one corner across all three node types; and fold-control eligibility is broadened so any node that participates in — or is adjacent to — a foldable region shows a control, not only the strict head of a region. This eligibility is purely topological and selection-invariant (the checked-out HEAD commit remains pinned), and activating the control on any eligible node folds the region that node belongs to. This round adds no new folding mechanism and leaves hide-set computation, orphan-safety, recursion, the leaf-tip default view, coexistence precedence, folded-ref surfacing, the HEAD exception, and selection-invariance unchanged.

## Glossary

- **Merge_Graph**: The client-side commit-graph view logic in `ui/src/features/graph/` responsible for merge secondary-path folding (the `collapse.ts` pure helpers, `CommitGraph.tsx` wiring, and `MergeNodeComponent`).
- **Merge_Node_Component**: The React Flow node type (`merge`) that renders a merge commit with its hidden-branch affordances.
- **Merge_Commit** (`M`): A commit with two or more parents.
- **First_Parent** (`P1`): `M.parents[0]`, the mainline continuation.
- **Secondary_Parent** (`Pk`): `M.parents[k]` for `k >= 1`, a merged-in branch tip.
- **Hide_Set**: For a merge `M` and secondary parent `Pk`, the set of commits reachable from `Pk` but not reachable from `P1`, restricted to in-graph commits: `reachable(Pk) \ reachable(P1)`.
- **Merge_Base**: A lowest common ancestor of `P1` and `Pk` over the loaded DAG; the floor of the Hide_Set.
- **Secondary_Path**: A folded/expandable group representing one merge's Hide_Set, keyed on `(mergeOid, parentIndex)` via `mergePathId(M, k)`.
- **Leaf_Tip**: A local branch tip or HEAD whose oid is not reachable from any other local branch tip or HEAD.
- **Default_View**: The initial fold seed computed by `leafTipVisibility`, showing only leaf-tip lines and folding merged lines behind their merge nodes.
- **Region_Collapse**: The existing Round 3 contiguous linear-region collapse mechanism.
- **Branch_Panel**: The `BranchControl` UI plus `branches.ts` logic that governs which refs are fetched from the server (`seed_refs`).
- **In_Graph**: A commit whose oid is present in the currently loaded `nodes` set.
- **Region_Around**: The `regionAround` pure helper that computes the maximal contiguous foldable chain of commits around an anchor for Region_Collapse.
- **Foldable_Predicate**: The `foldable(x)` topology test inside `regionAround` (and related helpers) that decides whether a commit may anchor or join a Region_Collapse.
- **Ref_Carrying_Commit**: An In_Graph commit that carries at least one branch, remote-branch, or tag ref (`refsByOid.get(oid)` is non-empty).
- **HEAD_Commit**: The single commit the checked-out `HEAD` ref points at (the ref whose `is_head` is true).
- **Summary_Node**: A folded-group render node — either a `RunNodeComponent` region/run rollup or a Merge_Node_Component hidden-branch affordance — that stands in for one or more hidden commits.
- **Head_Member**: The newest / first commit in a fold's ordered member list (`oids[0]`); the tip of the folded group.
- **Buried_Ref**: A ref on a non-head (interior) member of a fold.
- **Selected_Commit**: The commit currently selected in the graph (the `selectedOid` passed to `regionAround` / the Foldable_Predicate) that drives the right-hand detail pane.
- **Fold_Control**: The user-activated control that folds or expands a group — the expand control on a Summary_Node (region/run rollup or merge affordance) and the collapse control on a commit node that anchors a foldable Region_Collapse.
- **Eligible_Node**: An In_Graph commit that should render a Fold_Control because it participates in — or is adjacent to — a foldable Region_Collapse (a region `regionAround` returns with two or more members). The checked-out HEAD_Commit and any merge-hidden commit are never Eligible_Nodes.
- **Foldable_Node_Set**: The result of the `foldableNodeIds` pure helper — the set of Eligible_Nodes together with an `anchorFor` map from each Eligible_Node to the anchor `collapseRegion` uses to fold the Region_Collapse that node belongs to.

## Requirements

### Requirement 1: Merge Node Rendering and Hidden-Branch Affordance

**User Story:** As a user browsing the commit graph, I want merge commits to render as a distinct node type with a discoverable per-secondary-parent affordance, so that I can see how many commits are hidden behind each merged-in branch and reveal or re-hide them.

#### Acceptance Criteria

1. WHERE a commit has two or more parents, THE Merge_Graph SHALL render that commit using the Merge_Node_Component node type.
2. WHERE a Secondary_Path is folded, THE Merge_Node_Component SHALL display a discoverable affordance for that path showing a branch glyph and the count of commits hidden behind the path.
3. WHEN a user activates the affordance for a folded Secondary_Path, THE Merge_Graph SHALL expand that Secondary_Path and reveal its hidden commits.
4. WHERE a Secondary_Path is expanded, THE Merge_Node_Component SHALL display a collapse affordance for that path.
5. WHEN a user activates the collapse affordance for an expanded Secondary_Path, THE Merge_Graph SHALL fold that Secondary_Path.
6. THE Merge_Node_Component SHALL render one independent affordance per Secondary_Parent that has a non-empty Hide_Set.

### Requirement 2: Secondary-Path Hide-Set Computation

**User Story:** As a user, I want each merge's hidden set to contain exactly the commits unique to the merged-in branch, so that mainline history stays visible and only the merged-in work is hidden.

#### Acceptance Criteria

1. THE Merge_Graph SHALL compute the Hide_Set for a Merge_Commit `M` and Secondary_Parent `Pk` as the commits reachable from `Pk` but not reachable from `First_Parent`, restricted to In_Graph commits.
2. THE Merge_Graph SHALL exclude the First_Parent and every ancestor of the First_Parent from the Hide_Set.
3. THE Merge_Graph SHALL exclude the Merge_Commit itself from the Hide_Set so that the Merge_Commit remains visible as the expand point.
4. WHERE the Secondary_Parent is not reachable from the First_Parent, THE Merge_Graph SHALL include the Secondary_Parent in the Hide_Set.
5. WHERE the Secondary_Parent is reachable from the First_Parent, THE Merge_Graph SHALL exclude the Secondary_Parent from the Hide_Set.
6. THE Merge_Graph SHALL compute the Merge_Base of the First_Parent and Secondary_Parent from the loaded edges for display and floor purposes.
7. IF no common ancestor of the First_Parent and Secondary_Parent is present in the loaded window, THEN THE Merge_Graph SHALL report the Merge_Base as null without altering the Hide_Set.

### Requirement 3: Orphan-Safe Folding

**User Story:** As a user, I want folding a merged-in branch to never strand another commit, so that the graph remains connected and correct after every fold.

#### Acceptance Criteria

1. WHEN a Secondary_Path is folded, THE Merge_Graph SHALL keep every rendered commit outside the Hide_Set reachable in the resulting graph.
2. THE Merge_Graph SHALL treat the merge's secondary edge from the Secondary_Parent to the Merge_Commit as the only edge crossing the fold boundary from inside the Hide_Set to a visible commit.
3. WHEN a Secondary_Path is folded, THE Merge_Graph SHALL reroute the Secondary_Parent-to-Merge_Commit boundary edge onto the still-visible Merge_Commit.
4. WHEN a Secondary_Path is folded, THE Merge_Graph SHALL leave the First_Parent side of the graph unchanged.

### Requirement 4: Recursive Secondary Paths

**User Story:** As a user, I want to progressively reveal nested merged branches, so that I can explore merge history at any depth without losing the collapsed overview.

#### Acceptance Criteria

1. WHERE a Hide_Set contains an inner Merge_Commit, THE Merge_Graph SHALL keep that inner Merge_Commit unrendered while the enclosing Secondary_Path is folded.
2. WHEN an enclosing Secondary_Path is expanded, THE Merge_Graph SHALL render each inner Merge_Commit as an independently collapsible Merge_Node_Component.
3. WHEN newly-revealed commits become visible after an expansion, THE Merge_Graph SHALL recompute the Hide_Sets for the now-visible inner merges.

### Requirement 5: Default View on Load

**User Story:** As a user opening a repository, I want only the active un-merged lines shown by default, so that the initial graph is uncluttered and already-merged work is collapsed behind its merge nodes.

#### Acceptance Criteria

1. WHEN the graph loads, THE Merge_Graph SHALL identify Leaf_Tips as local branch tips and HEAD whose oid is not reachable from any other local branch tip or HEAD.
2. THE Merge_Graph SHALL exclude remote-tracking refs and tags from the comparison that determines whether a tip is reachable from another tip.
3. WHEN the graph loads, THE Merge_Graph SHALL fold a merge's Secondary_Path by default when none of the Hide_Set members is a Leaf_Tip.
4. WHEN the graph loads, THE Merge_Graph SHALL leave a merge's Secondary_Path expanded when any of the Hide_Set members is a Leaf_Tip.

### Requirement 6: Reversible, Stable-Keyed Fold State

**User Story:** As a user, I want expanding and collapsing merged branches to be reversible and stable across graph updates, so that my fold state survives live updates and window shifts.

#### Acceptance Criteria

1. WHEN a user folds and then expands and then folds a Secondary_Path, THE Merge_Graph SHALL produce an effective graph identical to the result of the first fold.
2. THE Merge_Graph SHALL key each Secondary_Path fold state on the stable merge oid via `mergePathId(mergeOid, parentIndex)`.
3. WHEN the loaded graph window shifts or a live update re-fetches the graph, THE Merge_Graph SHALL preserve each Secondary_Path fold state keyed on its merge oid.

### Requirement 7: Coexistence with Region-Collapse

**User Story:** As a user, I want merge folding and linear region-collapse to compose cleanly, so that a commit is never claimed by both controls at once and each control's membership stays disjoint.

#### Acceptance Criteria

1. WHERE a commit is eligible for both a Secondary_Path fold and a Region_Collapse, THE Merge_Graph SHALL apply the Secondary_Path fold in precedence over the Region_Collapse.
2. WHILE a commit is hidden behind a Secondary_Path, THE Merge_Graph SHALL exclude that commit from Region_Collapse seeding and offer no region control for it.
3. WHEN a Secondary_Path is expanded, THE Merge_Graph SHALL restore Region_Collapse candidacy for the now-visible commits.
4. THE Merge_Graph SHALL keep the membership of Secondary_Path folds and Region_Collapse folds disjoint.

### Requirement 8: Branch-Panel Coordination

**User Story:** As a user, I want the branch panel and the merge nodes to work at their own layers without fighting, so that fetching and client-side visibility remain predictable and I understand which control reveals which commits.

#### Acceptance Criteria

1. THE Branch_Panel SHALL govern which refs are fetched from the server by seeding `build_graph` with the shown ref set.
2. THE Merge_Graph SHALL govern secondary-path visibility only within the already-fetched set of In_Graph commits.
3. WHERE a branch is hidden in the Branch_Panel, THE Merge_Graph SHALL treat commits unique to that branch as not fetched and SHALL NOT reveal them through any merge affordance.
4. WHERE a commit is merge-hidden within the fetched set, THE Merge_Graph SHALL allow that commit to be revealed by expanding its Merge_Commit without a refetch.
5. WHERE the Branch_Panel fetches a branch whose tip is a Leaf_Tip, THE Merge_Graph SHALL keep that branch's line expanded in the Default_View.
6. WHERE the Branch_Panel fetches a branch whose tip is not a Leaf_Tip, THE Merge_Graph SHALL fold that branch behind its Merge_Commit in the Default_View while still allowing it to be revealed via the merge affordance.
7. THE Merge_Graph and THE Branch_Panel SHALL remain two separate controls.

### Requirement 9: Octopus Merges

**User Story:** As a user viewing an octopus merge, I want to reveal or hide each merged-in branch independently, so that I can inspect one merged line without disturbing the others.

#### Acceptance Criteria

1. WHERE a Merge_Commit has three or more parents, THE Merge_Graph SHALL compute one Hide_Set per Secondary_Parent.
2. WHERE a Merge_Commit has multiple Secondary_Parents with non-empty Hide_Sets, THE Merge_Node_Component SHALL provide one independently toggleable affordance per such Secondary_Parent.
3. WHEN a user expands one Secondary_Path of a multi-parent Merge_Commit, THE Merge_Graph SHALL reveal only the commits unique to that Secondary_Path.
4. WHERE two Secondary_Path Hide_Sets of the same Merge_Commit overlap, THE Merge_Graph SHALL hide any shared commit once.

### Requirement 10: Degenerate and Error Handling

**User Story:** As a user, I want boundary and degenerate cases to behave predictably, so that the graph stays correct and no fold ever strands a commit.

#### Acceptance Criteria

1. WHERE the Hide_Set for a Secondary_Parent is empty because the Secondary_Parent is fully reachable from the First_Parent, THE Merge_Graph SHALL create no Secondary_Path and display no affordance for that parent.
2. IF the Secondary_Parent is not an In_Graph commit, THEN THE Merge_Graph SHALL produce an empty Hide_Set for that parent and display no affordance for it.
3. IF a parent index is less than 1 or greater than or equal to the number of the merge's parents, THEN THE Merge_Graph SHALL produce no Secondary_Path for that index.
4. WHERE a folded Secondary_Path references a Merge_Commit whose oid is not present in the current loaded window, THE Merge_Graph SHALL treat the fold state as inert and SHALL NOT hide any visible commit or strand any commit.
5. WHEN a Merge_Commit whose fold state was inert re-enters the loaded window, THE Merge_Graph SHALL re-apply that fold state.
6. IF the loaded window omits the true Merge_Base, THEN THE Merge_Graph SHALL under-hide by keeping additional commits visible rather than stranding any commit.

### Requirement 11: Octopus Control Model Decision

**User Story:** As a maintainer, I want the octopus-merge control model recorded as a decided default, so that the implementation follows the design's resolved open question.

#### Acceptance Criteria

1. THE Merge_Graph SHALL adopt per-secondary-parent controls as the default model for octopus merges, providing one independently collapsible affordance per Secondary_Parent.

### Requirement 12: Coexistence Precedence Decision

**User Story:** As a maintainer, I want the coexistence precedence recorded as a decided default, so that merge-path folding consistently takes priority over region-collapse.

#### Acceptance Criteria

1. THE Merge_Graph SHALL adopt merge-path fold precedence over Region_Collapse as the default when a commit is eligible for both.

### Requirement 13: Leaf-Tip Default View Toggle

**User Story:** As a power user, I want a global toggle between the active-lines-only view and the full DAG, so that I can see everything without expanding each merge while keeping my per-merge fold state.

#### Acceptance Criteria

1. THE Merge_Graph SHALL provide a global toggle between an "Active lines only" mode and a "Full DAG" mode.
2. THE Merge_Graph SHALL set the "Active lines only" mode as the default state on load.
3. WHEN a user switches between the "Active lines only" and "Full DAG" modes, THE Merge_Graph SHALL flip the Default_View leaf-tip fold seed without discarding per-merge expand or collapse state.

### Requirement 14: Ref-Carrying Commits Are Foldable

**User Story:** As a user, I want commits that carry a branch, remote-branch, or tag ref to have expand/collapse controls, so that a ref no longer denies folding to itself or its neighbors.

#### Acceptance Criteria

1. THE Region_Around Foldable_Predicate SHALL determine foldability of a commit from graph topology alone: the commit has exactly one In_Graph parent, has exactly one In_Graph child, and is not the selected commit.
2. WHERE a commit is a Ref_Carrying_Commit, THE Region_Around Foldable_Predicate SHALL NOT treat the presence of a ref as a reason to make that commit non-foldable.
3. WHERE a commit is adjacent to a Ref_Carrying_Commit, THE Region_Around Foldable_Predicate SHALL NOT treat the neighbor's ref as a reason to make that commit non-foldable.
4. WHERE a Ref_Carrying_Commit satisfies the topological Foldable_Predicate, THE Merge_Graph SHALL offer an expand/collapse control for the Region_Collapse containing that commit.
5. WHERE a commit lies between two Ref_Carrying_Commits and satisfies the topological Foldable_Predicate, THE Merge_Graph SHALL include that commit in a Region_Collapse of two or more members and offer an expand/collapse control for it.

### Requirement 15: HEAD Commit Fold Exception

**User Story:** As a user, I want the checked-out commit to stay visible inline, so that my current position is never hidden inside a fold.

#### Acceptance Criteria

1. THE Region_Around Foldable_Predicate SHALL treat the HEAD_Commit as non-foldable.
2. THE Merge_Graph SHALL exclude the HEAD_Commit from membership of every Region_Collapse.
3. WHERE a ref other than the HEAD ref is present on a commit, THE Region_Around Foldable_Predicate SHALL NOT treat that ref as a reason to make the commit non-foldable.
4. WHERE the HEAD ref is a branch tip with zero In_Graph children, THE Merge_Graph SHALL keep the HEAD_Commit non-foldable by topology.

### Requirement 16: Folded Refs Surfaced on Summary Nodes

**User Story:** As a user, I want refs on folded commits to remain visible on the summary node, so that no branch, remote-branch, or tag silently disappears when a region or merged-in path is folded.

#### Acceptance Criteria

1. WHERE a Region_Collapse hides one or more Ref_Carrying_Commits, THE RunNodeComponent Summary_Node SHALL display a ref badge for each ref carried by a hidden commit.
2. WHERE a Secondary_Path Hide_Set hides one or more Ref_Carrying_Commits, THE Merge_Node_Component SHALL display a ref badge for each ref carried by a hidden commit on that path's affordance or summary.
3. THE Summary_Node SHALL display ref badges for branch, remote-branch, and tag refs carried by hidden commits.
4. WHERE a Summary_Node hides no Ref_Carrying_Commit, THE Merge_Graph SHALL display no folded-ref badge on that Summary_Node.

### Requirement 17: Head-vs-Buried Folded-Ref Badge Styling

**User Story:** As a user, I want to tell at a glance whether a folded ref sits at the tip of a fold or inside it, so that I understand where a hidden ref lives without expanding the fold.

#### Acceptance Criteria

1. WHERE a folded ref is carried by the fold's Head_Member, THE Summary_Node SHALL render that ref badge in the solid style used on a commit node.
2. WHERE a folded ref is a Buried_Ref, THE Summary_Node SHALL render that ref badge in an outline style distinct from the solid Head_Member badge style.
3. WHERE a folded ref is a Buried_Ref, THE Summary_Node SHALL provide a tooltip stating that the ref is inside the folded run.
4. THE Summary_Node SHALL distinguish a Head_Member ref from a Buried_Ref through badge styling alone, without a position number or count on the badge.

### Requirement 18: Auto-Collapse of Ref-Containing Regions on Load

**User Story:** As a user opening a repository, I want the on-load auto-collapse to fold long regions even when they contain ref-carrying commits, so that the initial graph stays uncluttered while every folded ref remains visible.

#### Acceptance Criteria

1. WHEN the graph loads, THE Merge_Graph SHALL permit the auto-collapse seed to fold a Region_Collapse that contains one or more Ref_Carrying_Commits.
2. WHEN the graph loads and a folded region contains a Ref_Carrying_Commit, THE Merge_Graph SHALL surface that commit's refs as badges on the Summary_Node so no ref disappears on load.
3. WHEN the graph loads, THE Merge_Graph SHALL continue to exempt the HEAD-trunk first-parent chain from the auto-collapse seed.

### Requirement 19: Consistent Fold-Control Placement

**User Story:** As a user, I want the expand and collapse controls to appear in the same place on a node, so that the control does not jump when a node transitions between folded and expanded.

#### Acceptance Criteria

1. THE Merge_Graph SHALL render the Fold_Control expand affordance on a Summary_Node (region/run rollup or merge affordance) in the top-right position of that node.
2. THE Merge_Graph SHALL render the Fold_Control collapse affordance on a commit node that anchors a foldable Region_Collapse in the top-right position of that node.
3. WHEN a node transitions between the folded state and the expanded state, THE Merge_Graph SHALL keep the Fold_Control in the same top-right position.

### Requirement 20: Selection Is Not a Region Boundary

**User Story:** As a user, I want selecting a commit to leave folding controls intact, so that inspecting a commit does not strip expand/collapse controls from that commit or its neighbors.

#### Acceptance Criteria

1. THE Foldable_Predicate SHALL NOT treat a commit as non-foldable on the basis that the commit is the Selected_Commit.
2. WHEN a user selects a commit, THE Merge_Graph SHALL keep the set of Region_Collapse regions identical to the set that existed before the selection.
3. WHEN a user selects a commit, THE Merge_Graph SHALL keep the Fold_Control present on every other commit that carried a Fold_Control before the selection.
4. WHEN a user selects a commit, THE Merge_Graph SHALL keep every neighbor's Region_Collapse membership unchanged.

### Requirement 21: Selected Commit Is Foldable

**User Story:** As a user, I want the commit I selected to still participate in folding, so that selecting a commit does not disqualify it from its own region control.

#### Acceptance Criteria

1. WHERE the Selected_Commit satisfies the topological Foldable_Predicate, THE Merge_Graph SHALL include the Selected_Commit in its Region_Collapse.
2. WHERE the Selected_Commit belongs to a Region_Collapse of two or more members, THE Merge_Graph SHALL offer a Fold_Control for that Selected_Commit.
3. THE Foldable_Predicate SHALL apply the same topology rule and HEAD_Commit exception to the Selected_Commit as to any other commit.

### Requirement 22: Folding a Region Containing the Selected Commit Moves Selection to the Summary Node

**User Story:** As a user, I want selection to follow a fold, so that folding a region that contains my selected commit keeps a coherent selection instead of stranding it on a hidden commit.

#### Acceptance Criteria

1. WHEN a user folds a Region_Collapse or a Secondary_Path whose members include the Selected_Commit, THE Merge_Graph SHALL move the selection to the resulting Summary_Node.
2. WHEN the selection moves to a Summary_Node, THE Merge_Graph SHALL update the right-hand detail pane to that Summary_Node's representative commit, which is the newest member of the fold.
3. WHERE a fold does not include the Selected_Commit, THE Merge_Graph SHALL leave the selection unchanged.

### Requirement 23: Selection-Boundary Removal Regression Guard

**User Story:** As a maintainer, I want removing the selection boundary to change nothing else, so that the fix introduces no orphans and does not alter existing fold membership.

#### Acceptance Criteria

1. WHEN the selection-based exclusion is removed from the Foldable_Predicate, THE Merge_Graph SHALL keep every rendered commit outside a Hide_Set reachable in the resulting graph.
2. THE Merge_Graph SHALL compute the same Hide_Set membership for every Secondary_Path as it did before the selection-based exclusion was removed.
3. THE Merge_Graph SHALL compute the same Region_Collapse membership, apart from ceasing to exclude the Selected_Commit, as it did before the selection-based exclusion was removed.
4. THE Merge_Graph SHALL continue to exempt the HEAD-trunk first-parent chain from the auto-collapse seed.
5. THE Merge_Graph SHALL continue to apply the topological Foldable_Predicate and the HEAD_Commit exception unchanged.

### Requirement 24: Fold Control Does Not Occlude Topmost Content

**User Story:** As a user, I want the fold control to never cover the commit date or run label, so that I can always read a node's topmost content whether or not it carries ref badges.

#### Acceptance Criteria

1. WHERE the Fold_Control is present on a CommitNodeComponent, THE CommitNodeComponent SHALL reserve horizontal space on its topmost content row (the hash/date row) at least equal to the rendered Fold_Control width so that no pixel of the commit date is overlapped by the Fold_Control.
2. WHERE the Fold_Control is present on a MergeNodeComponent, THE MergeNodeComponent SHALL reserve horizontal space on its topmost content row (the hash/date row) at least equal to the rendered Fold_Control width so that no pixel of the merge date is overlapped by the Fold_Control.
3. WHERE the Fold_Control is present on a RunNodeComponent, THE RunNodeComponent SHALL reserve horizontal space on its topmost content row (the label header row) at least equal to the rendered Fold_Control width so that no pixel of the run label is overlapped by the Fold_Control.
4. WHERE a commit or merge node carries no ref badge, THE Merge_Graph SHALL keep the date fully visible and not overlapped by the Fold_Control.
5. WHERE a commit or merge node carries one or more ref badges, THE Merge_Graph SHALL keep the date fully visible and not overlapped by the Fold_Control.

### Requirement 25: All Node Types Share the Top-Right Fold/Expand Corner

**User Story:** As a user, I want the fold and expand controls to sit in the same corner on every node type, so that the control does not move between corners across node types or across a fold/expand transition.

#### Acceptance Criteria

1. WHILE a CommitNodeComponent heads or belongs to a foldable Region_Collapse, THE CommitNodeComponent SHALL render its collapse Fold_Control in the node's top-right corner and at no other corner.
2. WHILE a MergeNodeComponent heads or belongs to a foldable Region_Collapse, THE MergeNodeComponent SHALL render its collapse Fold_Control in the node's top-right corner and at no other corner.
3. THE RunNodeComponent SHALL render its expand Fold_Control in the node's top-right corner and SHALL NOT render it in the top-left header row.
4. THE Merge_Graph SHALL render the fold affordance and the expand affordance in the same top-right corner across CommitNodeComponent, MergeNodeComponent, and RunNodeComponent.
5. WHEN a node transitions between the folded state and the expanded state, THE Merge_Graph SHALL keep the Fold_Control in the same top-right corner.
6. WHERE the RunNodeComponent supports a whole-node click to expand, THE RunNodeComponent SHALL retain that whole-node click while also rendering the visible expand affordance in the top-right corner.
7. THE top-right corner requirement SHALL apply only to the Fold_Control and SHALL NOT govern the placement of the MergeNodeComponent per-secondary-parent hidden-branch affordances.

### Requirement 26: Broadened Fold-Control Eligibility

**User Story:** As a user, I want every commit that belongs to or borders a foldable region to show a fold control, so that the control is not missing on mid-chain commits that are part of a perfectly foldable linear stretch.

#### Acceptance Criteria

1. THE Merge_Graph SHALL compute the Foldable_Node_Set from the loaded nodes, edges, and refs via the `foldableNodeIds` helper.
2. WHERE a commit participates in a foldable Region_Collapse of two or more members, THE Merge_Graph SHALL mark that commit as an Eligible_Node and render exactly one Fold_Control for it.
3. WHERE a commit is immediately adjacent in its lane to a foldable Region_Collapse of two or more members, THE Merge_Graph SHALL mark that commit as an Eligible_Node and render exactly one Fold_Control for it.
4. IF a commit is immediately adjacent to a foldable Region_Collapse but that commit is the HEAD_Commit or is merge-hidden, THEN THE Merge_Graph SHALL NOT mark that commit as an Eligible_Node and SHALL NOT render a Fold_Control for it.
5. THE `foldableNodeIds` helper SHALL determine Eligible_Node membership from graph topology alone and SHALL NOT consult the Selected_Commit.
6. THE `foldableNodeIds` helper SHALL produce a Foldable_Node_Set that is identical in membership for every possible Selected_Commit value on a fixed set of nodes, edges, and refs.
7. THE Merge_Graph SHALL exclude the HEAD_Commit from the Eligible_Node set.
8. WHILE a commit is merge-hidden, THE Merge_Graph SHALL exclude that commit from the Eligible_Node set.
9. IF the only available fold for a commit would collapse a Region_Collapse of a single member, THEN THE Merge_Graph SHALL NOT mark that commit as an Eligible_Node and SHALL NOT render a Fold_Control for it.

### Requirement 27: Activating the Control on Any Eligible Node Folds Its Region

**User Story:** As a user, I want clicking the fold control on any eligible node to fold the whole region that node belongs to, so that I do not have to find the region's head to fold it.

#### Acceptance Criteria

1. THE Foldable_Node_Set SHALL map each Eligible_Node to exactly one anchor oid of the Region_Collapse that node belongs to via its `anchorFor` map, such that every member of a given Region_Collapse maps to the identical anchor oid.
2. WHEN a user activates the Fold_Control on an Eligible_Node, THE Merge_Graph SHALL fold the Region_Collapse that node belongs to by calling `collapseRegion` with the anchor obtained from the `anchorFor` map for that node.
3. WHEN a user activates the Fold_Control on any two distinct members of the same Region_Collapse, THE Merge_Graph SHALL fold the identical set of member nodes in both cases, matching the set that folding from the region's anchor produces.
4. IF a user activates the Fold_Control on a node that is not present as a key in the `anchorFor` map, THEN THE Merge_Graph SHALL perform no fold operation and SHALL leave the current set of folded regions unchanged.
5. WHEN a user activates the Fold_Control on an Eligible_Node, THE Merge_Graph SHALL leave merge secondary-path folding unchanged.

## Future / Out of Scope

The following ideas are recorded for context and are explicitly **not** requirements to build in this round. They are non-normative and impose no obligation on the implementation.

- **Click a leaf/tip node to hide its whole branch line.** A future interaction could let a user click a Leaf_Tip node to fold that branch's entire line, rather than folding only behind merge nodes.
- **Reverse the working-directory pseudo-node edge direction.** A future change could render the working-tree pseudo-node as the "next" commit — an arrow pointing forward from HEAD to the working node — instead of the current edge direction.
