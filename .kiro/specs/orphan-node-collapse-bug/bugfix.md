# Bugfix Requirements Document

## Introduction

In the commit graph, collapsed "run"/"rollup" summary nodes ("N commits", rendered by `RunNodeComponent`) can appear as orphan nodes that misbehave. Three distinct defects have been observed when viewing a repository:

1. A rollup summary node reporting a large count (e.g. "35 commits") does not expand when clicked — clicking it has no visible effect.
2. Clicking that same summary node does not update the right-hand detail pane; it keeps showing whatever commit was previously selected.
3. A summary node containing only a single commit ("1 commit") is still rendered as a rollup, complete with the "click to expand" affordance, even though a single commit should not be presented as a foldable group.

These symptoms degrade the primary DAG browsing experience: the user cannot drill into the folded commits, cannot inspect them in the right pane, and is shown a misleading foldable node for a lone commit. This bugfix addresses the click/expand behavior of summary nodes, the right-pane update behavior when a summary node is clicked, and the incorrect rendering of single-commit rollups.

### Follow-up defects (discovered during manual verification of the first fix)

Manual verification of the first fix surfaced three further defects in the collapse/expand pipeline — one of them a regression introduced by that fix:

4. After expanding a rollup/run summary node, there is no longer any way to collapse it again, and the user can no longer manually collapse ANY foldable run of commits. Expand has become a permanent, one-way override of collapse (a regression from the first fix's expand-plumbing changes).
5. Expanding a rollup node leaves an orphan: one of the returned commits (the first commit of the expanded list) reappears with a missing/incorrect parent edge, so it looks like a second disconnected node. The fold/expand round-trip does not fully restore the edges.
6. Expanding a rollup/run sometimes un-folds only a single commit instead of the whole group — e.g. a "33 commits" rollup becomes "32 rolled up" rather than fully expanding.
7. A branch-rollup summary node's label (a long branch name) and/or its date-range line overflows the fixed-width node box, so the text runs past the node border instead of being truncated within it.

These follow-up defects break the reversibility and integrity of the collapse/expand interaction: the user can get stuck in an expanded state, the graph can be left with orphaned/disconnected nodes, and expansion can require many repeated clicks to fully reveal a group. Defect 7 is a minor presentational overflow on rollup nodes.

### Round 3: replacing the collapse model (discovered during manual verification of the second fix)

Rounds 1 and 2 patched the *existing* collapse model in place: auto-detected linear runs keyed by a membership-derived id (`__run__<head>__<tail>`), plus non-contiguous "branch rollups" that fold a branch's set of unique (non-shared) commits. Continued manual testing shows this model is still not sound:

- Collapsing into a rollup **still** produces orphaned/disconnected nodes, because a branch rollup folds a non-contiguous *set* of commits whose boundary edges cannot always be rerouted cleanly.
- Expand/collapse on the `main` trunk is **inconsistent** — it works sometimes and not others — because the rollup's identity is derived from its current membership boundaries, so any shift in the graph (or an adjacent region expanding) changes the id and desyncs the recorded expand/collapse state.
- The user can only fold where an auto-detected run *head* happens to offer a control; there is no way to fold an arbitrary region on demand.

Rather than keep patching, Round 3 **replaces** the collapse mechanism with an on-demand, contiguous-region model. Every eligible commit node exposes a collapse control; clicking it folds the single connected chain bounded by the nearest branch point below and the nearest merge point above (both exclusive). Because that region is a single chain with exactly one entry edge and one exit edge, folding it is inherently orphan-free. Collapse/expand state is keyed on the clicked commit's stable oid (the stable region identity), not on a boundary-derived run id, so the round-trip stays consistent as the graph shifts. This on-demand contiguous-region model **supersedes** both the auto-detected linear-run rollups and the non-contiguous branch rollups as the collapse mechanism. The defects, expected behavior, and preservation guarantees for this new model are captured in the numbered clauses below (sections 4–6 of each subsection).

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the user clicks a rollup summary node that reports a large count (e.g. "35 commits") THEN the system does not expand the node and no commits become visible
1.2 WHEN the user clicks a summary node (run or rollup) THEN the system does not update the right-hand detail pane and it continues showing the previously selected commit
1.3 WHEN a foldable group resolves to exactly one commit THEN the system renders it as a rollup summary node showing a "1 commit" count and a "click to expand" label
1.4 WHEN the user expands a rollup or run summary node THEN the system provides no way to collapse it again, and the user can no longer manually collapse any foldable run of commits (expand permanently overrides collapse)
1.5 WHEN the user expands a rollup summary node THEN the system reintroduces one of the commits (the first commit of the expanded list) with a missing or incorrect parent edge, leaving it disconnected as an orphan node
1.6 WHEN the user expands a rollup or run summary node THEN the system sometimes un-folds only a single commit instead of the whole group (e.g. a "33 commits" rollup becomes "32 rolled up")
1.7 WHEN a branch-rollup summary node with a long branch-name label (or a long date range) is rendered THEN the system displays the label text overflowing past the node's border rather than truncating it within the node box

1.8 WHEN the user collapses a branch or region into a rollup summary node THEN the system still leaves one or more orphaned/disconnected nodes because the rollup folds a non-contiguous set of commits whose boundary edges are not reliably rerouted
1.9 WHEN the user expands or collapses a region on the main trunk THEN the system behaves inconsistently (folding/unfolding works on some attempts but not others) because the rollup's identity is derived from shifting membership boundaries rather than a stable identity
1.10 WHEN the user wants to fold an arbitrary contiguous region of commits THEN the system offers a collapse control only on auto-detected linear-run heads, so the user cannot fold a region of their choosing on demand

### Expected Behavior (Correct)

2.1 WHEN the user clicks a rollup summary node that reports a large count THEN the system SHALL expand the node so the individual commits it represents become visible in the graph
2.2 WHEN the user clicks a summary node (run or rollup) THEN the system SHALL update the right-hand detail pane to reflect the click in a coherent way (either by selecting a representative commit from the group or by clearing/indicating no single commit is selected), rather than leaving a stale previously-selected commit displayed
2.3 WHEN a foldable group resolves to exactly one commit THEN the system SHALL render that commit as a normal commit node rather than as a rollup summary node with a "click to expand" label
2.4 WHEN the user expands a rollup or run summary node THEN the system SHALL allow the user to collapse it again, and SHALL continue to allow manual collapse of any foldable run of commits, so that expand and collapse are reversible and neither permanently overrides the other
2.5 WHEN the user expands a rollup summary node THEN the system SHALL restore every un-folded commit with the same edges it originally had — both between the un-folded commits and to the surrounding graph — so that no dangling or orphan node results from the collapse/expand round-trip
2.6 WHEN the user expands a rollup or run summary node THEN the system SHALL un-fold the entire group in a single action so that all commits it represents become visible at once, rather than removing one commit at a time
2.7 WHEN a branch-rollup summary node with a long branch-name label (or a long date range) is rendered THEN the system SHALL truncate the label within the node box (keeping the full name available on hover) so no text overflows the node's border

2.8 WHEN a commit node is displayed and the foldable contiguous region around it contains two or more commits THEN the system SHALL show a collapse control on that node, and WHEN that region contains fewer than two commits (a lone commit wedged directly between a branch point and a merge point) THEN the system SHALL show no collapse control
2.9 WHEN the user clicks a commit node's collapse control THEN the system SHALL fold the contiguous region formed by walking DOWN toward older commits/parents until (but excluding) the nearest branch point (a commit with two or more children) and walking UP toward newer commits/children until (but excluding) the nearest merge point (a commit with two or more parents), folding everything strictly between those boundaries into a single rollup node while the boundary commits remain visible as their own nodes
2.10 WHEN the user folds such a contiguous region THEN the system SHALL keep the DAG connected with no orphaned nodes by rerouting the single entry edge (from the branch point below) to the rollup and the single exit edge (to the merge point above) from the rollup, severing no side-branch edges
2.11 WHEN the user collapses or expands a region THEN the system SHALL key the collapse/expand state on the clicked commit's stable oid (the stable region identity) rather than a boundary-derived run id, so that the collapse/expand round-trip stays consistent even when the graph shifts or an adjacent region expands
2.12 WHEN the user interacts with the collapse mechanism THEN the system SHALL use this on-demand contiguous-region model in place of both the auto-detected linear-run rollups and the non-contiguous branch rollups
2.13 WHEN a repository is loaded THEN the system SHALL auto-collapse every contiguous region at or above the auto-collapse length under the on-demand contiguous-region model EXCEPT the currently checked-out branch's first-parent chain (the HEAD trunk — the ref where is_head is true, the same chain pinned to lane 0 in assignLanes), leaving that trunk expanded on load, while every eligible node still exposes a manual collapse control and any auto-collapsed region remains expandable
2.14 WHEN the on-demand contiguous-region collapse model is designed THEN the system SHALL structure it so a future per-branch fold/unfold control (e.g. driven by the existing BranchControl picker) can invoke the same collapse/expand mechanism; NOTE: wiring the branch picker to fold/unfold is a non-normative design constraint and is explicitly OUT OF SCOPE for this bugfix, deferred to a follow-up

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the user clicks a linear-run summary node whose expand path is already wired correctly THEN the system SHALL CONTINUE TO expand it into its individual commits
3.2 WHEN the user clicks a normal commit node THEN the system SHALL CONTINUE TO select that commit and update the right-hand detail pane to show its metadata, diff, and files
3.3 WHEN a foldable group contains two or more commits and meets the collapse criteria THEN the system SHALL CONTINUE TO render it as a single rollup/run summary node with the correct commit count and date range
3.4 WHEN branches are marked expanded, collapsed, or hidden via the branch controls THEN the system SHALL CONTINUE TO scope the graph and produce rollup nodes for collapsed branches as before
3.5 WHEN the user folds (collapses) a run or branch rollup THEN the system SHALL CONTINUE TO reroute all edges into and out of the folded commits through the summary node, keeping the DAG connected with no dangling edges
3.6 WHEN the user has neither expanded nor manually collapsed a group THEN the system SHALL CONTINUE TO auto-collapse long contiguous regions on load — PARTIALLY SUPERSEDED by Round 3: the auto-collapse heuristic (folding regions at or above the auto-collapse length) still applies on repo load, but is now scoped to the on-demand contiguous-region model (2.9–2.12) and exempts the checked-out branch's first-parent chain per 2.13, rather than folding auto-detected linear runs "as before"
3.7 WHEN the user expands a summary node and then takes no further action THEN the system SHALL CONTINUE TO keep all other summary nodes and unrelated commits in their current folded/unfolded state, expanding only the clicked group

3.8 WHEN a foldable region resolves to a single commit THEN the system SHALL CONTINUE TO render that commit as a normal commit node rather than a rollup, consistent with the earlier single-commit fix (2.3)
3.9 WHEN the user expands a folded region THEN the system SHALL CONTINUE TO restore every original edge and reveal the entire region in a single action, consistent with the earlier round-trip fixes (2.5, 2.6)
3.10 WHEN the user clicks a rollup summary node THEN the system SHALL CONTINUE TO select a representative commit from the region and update the right-hand detail pane, consistent with the earlier selection fix (2.2)
3.11 WHEN branches are marked hidden, collapsed, or expanded via the branch controls THEN the system SHALL CONTINUE TO scope the graph at the server-ref level as before, independent of the new on-demand region collapse mechanism
