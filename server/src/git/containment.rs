//! Commit → containing-refs ("contained in") computation.
//!
//! Answers the question "what is this commit included in?" — i.e. which
//! branches and tags have this commit in their ancestry. This is the inverse of
//! `git branch/tag --contains <oid>`, precomputed for *every* commit in one
//! pass so the commit pane can render the set in O(1) per lookup.
//!
//! ## Why this is a separate walk from `build_graph`
//!
//! `build_graph` seeds a single revwalk from `refs/*` all at once and
//! deduplicates OIDs (`seen.insert`). That merged stream throws away *which*
//! ref reached each commit, so containment cannot be recovered from it. Here we
//! instead walk each ref's ancestry independently and record membership.
//!
//! ## Direction
//!
//! Commits carry only *parent* links, never child/ref back-pointers. So
//! containment can only be computed by starting at ref tips and walking *down*
//! through parents — never from a commit walking up. Every OID visited while
//! walking ref R's ancestry is "contained in R" (R's tip included).
//!
//! ## Cost
//!
//! Per-ref ancestry walk: roughly O(refs × depth) worst case (many refs sharing
//! a long trunk re-walk that trunk). Acceptable because the result is cached in
//! `AppState` and only rebuilt when the ref set changes. If this becomes a
//! bottleneck on pathological repos, the reverse-topological set-propagation
//! variant (single pass, bitset per commit) is the next step.

use crate::error::AppError;
use git2::{Oid, Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;

use super::graph::RefKind;

/// One ref (branch/tag/remote) that contains a given commit. Deliberately a
/// slimmer sibling of `graph::RefLabel` — containment needs the ref identity
/// and its tip time (for "earliest release" ordering), not per-node data.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContainingRef {
    pub name: String,
    pub kind: RefKind,
    /// Whether this ref points *exactly at* the queried commit (a "tip"), as
    /// opposed to merely containing it in ancestry. Lets the UI split the
    /// "At this commit" tips from the broader "Contained in" list.
    pub is_tip: bool,
    /// Whether this is the repository's default branch (HEAD's branch). Lets the
    /// UI answer "is this on `main`?" prominently.
    pub is_default_branch: bool,
    /// Commit time (unix seconds) of the ref's tip — used to pick the *earliest*
    /// tag that contains the commit ("first released in vX").
    pub tip_ts: Option<i64>,
}

/// The full containment map: commit OID (hex) → refs that contain it.
pub type ContainmentMap = HashMap<String, Vec<ContainingRef>>;

/// A ref tip to seed a containment walk from: its short name, kind, resolved
/// commit OID, tip timestamp, and default-branch flag.
struct RefTip {
    name: String,
    kind: RefKind,
    oid: Oid,
    tip_ts: Option<i64>,
    is_default_branch: bool,
}

/// Collect every branch/tag/remote ref, peeled to the commit it ultimately
/// targets. Annotated tags are peeled through the tag object to the commit
/// (same rationale as `graph::collect_refs`). Refs that don't resolve to a
/// commit are skipped. HEAD itself is not seeded as its own ref — it's captured
/// via its branch, and `is_default_branch` marks that branch.
fn collect_ref_tips(repo: &Repository) -> Result<Vec<RefTip>, AppError> {
    let default_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_owned));

    let ref_names: Vec<String> = repo
        .references()
        .map_err(AppError::Git)?
        .filter_map(|r| r.ok())
        .filter_map(|r| r.name().map(str::to_owned))
        .collect();

    let mut tips = Vec::new();
    for name in ref_names {
        let reference = repo.find_reference(&name).map_err(AppError::Git)?;
        let (oid, tip_ts) = match reference.peel_to_commit() {
            Ok(commit) => (commit.id(), Some(commit.time().seconds())),
            Err(_) => continue,
        };

        let (short_name, kind) = if let Some(n) = name.strip_prefix("refs/heads/") {
            (n.to_string(), RefKind::Branch)
        } else if let Some(n) = name.strip_prefix("refs/remotes/") {
            (n.to_string(), RefKind::RemoteBranch)
        } else if let Some(n) = name.strip_prefix("refs/tags/") {
            (n.to_string(), RefKind::Tag)
        } else {
            continue;
        };

        let is_default_branch =
            matches!(kind, RefKind::Branch) && default_branch.as_deref() == Some(&short_name);

        tips.push(RefTip {
            name: short_name,
            kind,
            oid,
            tip_ts,
            is_default_branch,
        });
    }
    Ok(tips)
}

/// Compute the containment map for the whole repository: for each commit, the
/// set of refs (branches, remote branches, tags) that contain it in ancestry.
///
/// Pure and deterministic: no network, no global state, no reliance on the
/// current working directory beyond `repo` itself. `is_tip` is set for the ref
/// whose tip *is* the commit; every other contained commit gets `is_tip=false`.
pub fn compute_containment(repo: &Repository) -> Result<ContainmentMap, AppError> {
    let tips = collect_ref_tips(repo)?;
    let mut map: ContainmentMap = HashMap::new();

    for tip in &tips {
        let mut revwalk = repo.revwalk().map_err(AppError::Git)?;
        // TOPOLOGICAL keeps parents-after-children ordering; TIME is irrelevant
        // for membership but harmless. We only need the *set* of reachable OIDs.
        revwalk
            .set_sorting(Sort::TOPOLOGICAL)
            .map_err(AppError::Git)?;
        if revwalk.push(tip.oid).is_err() {
            continue; // tip disappeared mid-walk; skip defensively
        }

        for oid_result in revwalk {
            let oid = match oid_result {
                Ok(o) => o,
                Err(_) => break,
            };
            let is_tip = oid == tip.oid;
            map.entry(oid.to_string()).or_default().push(ContainingRef {
                name: tip.name.clone(),
                kind: tip.kind.clone(),
                is_tip,
                is_default_branch: tip.is_default_branch,
                tip_ts: tip.tip_ts,
            });
        }
    }

    Ok(map)
}

/// A stable fingerprint of the current ref set (name + resolved OID for every
/// ref). Used by the cache layer to detect when refs were added, deleted, or
/// moved so the containment map can be invalidated and rebuilt. Two repos with
/// identical ref→OID mappings produce the same hash regardless of iteration
/// order.
pub fn refs_fingerprint(repo: &Repository) -> Result<u64, AppError> {
    use std::hash::{Hash, Hasher};

    // Collect (name, oid) pairs, then sort so the hash is order-independent.
    let mut entries: Vec<(String, String)> = Vec::new();
    let refs = repo.references().map_err(AppError::Git)?;
    for r in refs.filter_map(|r| r.ok()) {
        let name = match r.name() {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Use the raw target (or peeled commit) so a moved ref changes the hash.
        let target = r
            .peel_to_commit()
            .map(|c| c.id().to_string())
            .or_else(|_| r.target().map(|o| o.to_string()).ok_or(()))
            .unwrap_or_default();
        entries.push((name, target));
    }
    entries.sort();

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    entries.hash(&mut hasher);
    Ok(hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature, Time};
    use std::path::PathBuf;

    fn temp_repo() -> (Repository, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "git-atlas-containment-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        (repo, dir)
    }

    /// Commit on current HEAD with a fixed timestamp; returns the new OID.
    fn commit(repo: &Repository, msg: &str, ts: i64) -> Oid {
        let dir = repo.workdir().unwrap();
        std::fs::write(dir.join("f.txt"), format!("{msg}\n")).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("f.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::new("t", "t@t.co", &Time::new(ts, 0)).unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(h) => vec![h.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    fn cleanup(dir: PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Names of refs containing `oid`, sorted for stable assertions.
    fn containing_names(map: &ContainmentMap, oid: Oid) -> Vec<String> {
        let mut names: Vec<String> = map
            .get(&oid.to_string())
            .map(|v| v.iter().map(|r| r.name.clone()).collect())
            .unwrap_or_default();
        names.sort();
        names.dedup();
        names
    }

    fn main_branch_name(repo: &Repository) -> String {
        if repo.find_reference("refs/heads/master").is_ok() {
            "master".into()
        } else {
            "main".into()
        }
    }

    #[test]
    fn empty_repo_yields_empty_map() {
        let (repo, dir) = temp_repo();
        let map = compute_containment(&repo).unwrap();
        assert!(map.is_empty());
        cleanup(dir);
    }

    #[test]
    fn linear_history_every_commit_contained_in_branch() {
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        let c2 = commit(&repo, "c2", 2000);
        let c3 = commit(&repo, "c3", 3000);
        let branch = main_branch_name(&repo);

        let map = compute_containment(&repo).unwrap();
        // All three commits are contained in the single branch.
        for c in [c1, c2, c3] {
            assert_eq!(containing_names(&map, c), vec![branch.clone()]);
        }
        cleanup(dir);
    }

    #[test]
    fn tip_flag_set_only_for_the_tip_commit() {
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        let c2 = commit(&repo, "c2", 2000); // tip
        let branch = main_branch_name(&repo);

        let map = compute_containment(&repo).unwrap();
        let tip_entry = &map[&c2.to_string()];
        assert!(
            tip_entry.iter().any(|r| r.name == branch && r.is_tip),
            "branch should be a tip at c2"
        );
        let older = &map[&c1.to_string()];
        assert!(
            older.iter().all(|r| !r.is_tip),
            "no ref is a tip at the older commit c1"
        );
        cleanup(dir);
    }

    #[test]
    fn commit_on_two_branches_is_contained_in_both() {
        let (repo, dir) = temp_repo();
        let base = commit(&repo, "base", 1000); // shared ancestor
        let main = main_branch_name(&repo);

        // feature branches off base, adds its own commit
        let base_commit = repo.find_commit(base).unwrap();
        repo.branch("feature", &base_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        let feat = commit(&repo, "feat", 2000);

        let map = compute_containment(&repo).unwrap();
        // base is on BOTH branches; feat only on feature.
        assert_eq!(
            containing_names(&map, base),
            {
                let mut v = vec![main.clone(), "feature".to_string()];
                v.sort();
                v
            },
            "shared base must be contained in both branches"
        );
        assert_eq!(containing_names(&map, feat), vec!["feature".to_string()]);
        cleanup(dir);
    }

    #[test]
    fn tags_lightweight_and_annotated_contain_ancestry() {
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        let c2 = commit(&repo, "c2", 2000);
        // lightweight tag on c2
        repo.tag_lightweight("v1", &repo.find_object(c2, None).unwrap(), false)
            .unwrap();
        // annotated tag on c2 as well (ref target is the tag object)
        let sig = Signature::new("t", "t@t.co", &Time::new(2000, 0)).unwrap();
        repo.tag(
            "v1-annot",
            &repo.find_object(c2, None).unwrap(),
            &sig,
            "release",
            false,
        )
        .unwrap();

        let map = compute_containment(&repo).unwrap();
        // c1 (ancestor of the tagged c2) is contained in both tags.
        let c1_names = containing_names(&map, c1);
        assert!(c1_names.contains(&"v1".to_string()), "got {c1_names:?}");
        assert!(
            c1_names.contains(&"v1-annot".to_string()),
            "annotated tag must contain ancestry; got {c1_names:?}"
        );
        // Both tags are tips at c2.
        let c2_refs = &map[&c2.to_string()];
        assert!(c2_refs
            .iter()
            .any(|r| r.name == "v1-annot" && r.is_tip && matches!(r.kind, RefKind::Tag)));
        cleanup(dir);
    }

    #[test]
    fn earliest_tag_is_derivable_from_tip_ts() {
        // Two releases: v1 (older) contains c1; v2 (newer) contains c1 and c2.
        // The UI derives "first released in v1" by picking the min tip_ts among
        // containing tags — verify the data supports that.
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        repo.tag_lightweight("v1", &repo.find_object(c1, None).unwrap(), false)
            .unwrap();
        let c2 = commit(&repo, "c2", 2000);
        repo.tag_lightweight("v2", &repo.find_object(c2, None).unwrap(), false)
            .unwrap();

        let map = compute_containment(&repo).unwrap();
        let c1_tags: Vec<&ContainingRef> = map[&c1.to_string()]
            .iter()
            .filter(|r| matches!(r.kind, RefKind::Tag))
            .collect();
        // c1 is in both v1 and v2; the earliest by tip_ts is v1.
        let earliest = c1_tags.iter().min_by_key(|r| r.tip_ts).unwrap();
        assert_eq!(earliest.name, "v1");
        // c2 is only in v2.
        let c2_tags: Vec<String> = map[&c2.to_string()]
            .iter()
            .filter(|r| matches!(r.kind, RefKind::Tag))
            .map(|r| r.name.clone())
            .collect();
        assert_eq!(c2_tags, vec!["v2".to_string()]);
        cleanup(dir);
    }

    #[test]
    fn default_branch_flagged() {
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        let main = main_branch_name(&repo);

        let map = compute_containment(&repo).unwrap();
        let entry = &map[&c1.to_string()];
        let branch_ref = entry.iter().find(|r| r.name == main).unwrap();
        assert!(
            branch_ref.is_default_branch,
            "HEAD's branch should be flagged as default"
        );
        cleanup(dir);
    }

    #[test]
    fn fingerprint_changes_when_ref_moves() {
        let (repo, dir) = temp_repo();
        commit(&repo, "c1", 1000);
        let fp1 = refs_fingerprint(&repo).unwrap();
        // Advancing the branch (new commit) must change the fingerprint.
        commit(&repo, "c2", 2000);
        let fp2 = refs_fingerprint(&repo).unwrap();
        assert_ne!(fp1, fp2, "moving HEAD's branch must change the fingerprint");
        // Recomputing without change is stable.
        assert_eq!(fp2, refs_fingerprint(&repo).unwrap());
        cleanup(dir);
    }

    #[test]
    fn fingerprint_changes_when_ref_added() {
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        let fp1 = refs_fingerprint(&repo).unwrap();
        repo.tag_lightweight("v1", &repo.find_object(c1, None).unwrap(), false)
            .unwrap();
        let fp2 = refs_fingerprint(&repo).unwrap();
        assert_ne!(fp1, fp2, "adding a tag must change the fingerprint");
        cleanup(dir);
    }
}
