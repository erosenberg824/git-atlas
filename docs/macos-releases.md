# macOS release downloads

## Signing and Gatekeeper

The macOS application is **ad-hoc signed** during CI. Ad-hoc signing does not require a paid Apple Developer account and lets macOS verify that the application bundle has not been modified after signing.

It does **not** make the application an Apple-trusted download: the app is not signed with a Developer ID certificate and is not notarized by Apple. Gatekeeper may therefore show an “unidentified developer” warning the first time you open it.

To launch the app on macOS:

1. Download the `.dmg` from the GitHub release.
2. Verify its SHA-256 checksum using the matching `SHA256SUMS-macos-latest.txt` release asset.
3. Open the disk image and drag `git-atlas.app` to Applications.
4. The first time you launch it, right-click `git-atlas.app`, choose **Open**, and confirm **Open** in the dialog.

After approving it once, macOS normally allows the app to launch normally.

## Verifying checksums

The release workflow publishes SHA-256 checksums alongside the installers. On macOS, run:

```bash
shasum -a 256 git-atlas_<version>_aarch64.dmg
```

Compare the result with the corresponding entry in `SHA256SUMS-macos-latest.txt`. Do not install the file if the hashes do not match.

Checksums protect against accidental corruption and help detect a modified download, but they do not by themselves prove who built the file. Download the checksum file from the same GitHub release as the installer.

## Future notarized releases

Removing the Gatekeeper warning requires a paid Apple Developer Program membership, a Developer ID Application certificate, and Apple notarization. Until those are available, ad-hoc signing plus checksum verification is the supported release process.
