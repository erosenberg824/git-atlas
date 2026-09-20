pub mod graph;
pub mod commits;
pub mod diff;
pub mod tree;

use crate::error::AppError;

/// Resolve a ref name or OID string to a full OID hex string.
pub fn resolve_ref(repo: &git2::Repository, refspec: &str) -> Result<String, AppError> {
    // Try as a direct OID first
    if let Ok(oid) = git2::Oid::from_str(refspec) {
        return Ok(oid.to_string());
    }
    // Otherwise resolve as a reference name
    let obj = repo
        .revparse_single(refspec)
        .map_err(|_| AppError::NotFound(format!("ref not found: {refspec}")))?;
    Ok(obj.id().to_string())
}
