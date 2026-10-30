Used for updating the actions and container images pinned by [GitHub Agentic Workflows](https://github.github.com/gh-aw/) (`gh aw`), and the `gh aw` CLI itself.

!!! warning "This feature is flagged as experimental"
  Experimental features might be changed at any time.
  <br /> <br />
  The `actions-lock.json` format is owned by the `gh aw` CLI, so Renovate's support may change - in a possibly breaking manner - as the format evolves.

`gh aw compile` compiles each agentic workflow (`.github/workflows/<name>.md`) into a regular GitHub Actions workflow (`.github/workflows/<name>.lock.yml`).
It caches the commit each action ref resolved to, and the digest each container image resolved to, in `.github/aw/actions-lock.json`, and pins the compiled workflows to those:

<!-- schema-validation-disable-next-block -->

```json
{
  "entries": {
    "actions/checkout@v7.0.1": {
      "repo": "actions/checkout",
      "version": "v7.0.1",
      "sha": "3d3c42e5aac5ba805825da76410c181273ba90b1"
    }
  },
  "containers": {
    "node:24": {
      "image": "node:24",
      "digest": "sha256:2c2ea524e648b91c8333ce246e3838fcf5b19ac70e45baac1a51b9207299749f",
      "pinned_image": "node:24@sha256:2c2ea524e648b91c8333ce246e3838fcf5b19ac70e45baac1a51b9207299749f"
    }
  }
}
```

The compiled workflows are generated files, so updating a `uses:` in them directly is undone by the next `gh aw compile`.
Instead, for each update Renovate:

1. updates the entry in `actions-lock.json`
1. rewrites the references to it in the workflow sources (`.github/workflows/**/*.md`, including shared imports), as `gh aw update` and `gh aw upgrade` do: `uses:` references to the action anywhere in the file, including example steps in the Markdown body, and image references within the frontmatter
1. once per branch, after writing all of the branch's updates, recompiles the workflows:

```sh
gh extension install github/gh-aw --pin <version>
gh aw compile --no-check-update
```

Renovate installs each version of the extension into a directory of its own below the [`cacheDir`](../../../self-hosted-configuration.md#cachedir), and points `gh` at it with `XDG_DATA_HOME`, so a version is downloaded only once, and is never replaced by another version.
Renovate reinstalls a version whose install was interrupted, and removes the versions which no repository used for 30 days.
If several Renovate processes share a `cacheDir`, then they can install the same version at the same time, which fails one of them with an artifact error until its next run.

Renovate commits the updated `actions-lock.json` together with the workflow sources and every `.github/workflows/*.lock.yml` that changed.
Renovate does not compile a repository without `actions-lock.json`, as `gh aw compile` writes it for every repository with agentic workflows.

Every update rewrites the references in all workflow sources, as they all share `actions-lock.json`.
If you split updates into branches by file with `matchFileNames`, a branch can still change the workflow sources of another one.

If the compiler pins the old version again, because a workflow source references it in a form Renovate could not rewrite, then Renovate reports an artifact error on the pull request rather than raising an update which the compiled workflows do not contain.

Renovate skips entries whose commit or digest is not valid, as there is nothing to re-pin.

#### Actions pinned to a commit in a workflow source

`gh aw compile` copies a `uses:` which is already pinned to a commit into the compiled workflow as it is, so `actions-lock.json` has no entry for it.
Renovate therefore also extracts these from the frontmatter of the workflow sources, and reads their version from the comment, as for the [`github-actions`](../github-actions/index.md) manager:

```yaml
---
steps:
  - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
---
```

Renovate updates the commit and the version in the comment, then recompiles the workflows in the same way.
A commit without a version comment is skipped as `unversioned-reference`, as there is no version to look a newer one up by.
A `uses:` with a tag is left to its entry in `actions-lock.json`.

#### `actions.lock`

If `.github/workflows/actions.lock` tracks a compiled workflow which Renovate recompiled, then the [`github-actions`](../github-actions/index.md#github-agentic-workflows) manager regenerates the lockfile for it with `gh actions-lock`, in the same branch.
If the `github-actions` manager is not enabled, then Renovate adds a notice to the pull request to run `gh actions-lock` on the branch instead.

`gh actions-lock` rewrites the pins of the compiled workflows to tag refs when it first adds them to the lockfile, while `gh aw compile` writes commit pins.
The first recompile after that therefore changes `actions.lock` more than the update itself.

The [`github-actions`](../github-actions/index.md) manager still extracts the compiled `.lock.yml` workflows, but skips their dependencies with the `generated-file` skip reason, because the next `gh aw compile` would undo any change to them.
If you disable this manager, then nothing updates the pins of your agentic workflows.

### Upgrading the `gh aw` CLI

The `github/gh-aw-actions/setup` (or `github/gh-aw/actions/setup`) action is released in lock-step with the CLI, so Renovate treats an update of it as an upgrade of the CLI, with the `gh-aw` `depType`.
For such an update, Renovate installs the new version of the CLI and runs:

```sh
gh aw upgrade --skip-extension-upgrade --no-actions --no-agent --no-mcp --no-skill
```

- `--skip-extension-upgrade`: stay on the version Renovate installed, rather than the latest release. `gh aw` hides this flag, as it is meant for its own use, and offers no other way to stop `gh aw upgrade` from upgrading itself. If a release drops it, then the upgrade fails with an artifact error, rather than raising an upgrade to another version
- `--no-actions`: leave the other actions to their own updates
- `--no-agent`, `--no-mcp`, `--no-skill`: do not add or refresh the Copilot agent, Copilot setup steps and dispatcher skill files. Run `gh aw upgrade` yourself to refresh them. These flags exist from v0.92.4, so an upgrade to an older release refreshes those files, and Renovate commits them too

Besides recompiling the workflows, `gh aw upgrade` applies the codemods of the new version to the workflow sources, which Renovate commits too.

Renovate does not update the other actions which are released with the CLI, like `github/gh-aw-actions/setup-cli`, nor the container images which the compiler injects at a tag of its own choosing, such as `ghcr.io/github/gh-aw-firewall/*`.
These move with the CLI upgrade, and lock file maintenance refreshes their digests.

### Lock file maintenance

With [`lockFileMaintenance`](../../../configuration-options.md#lockfilemaintenance) enabled, Renovate re-resolves the digest of every image tag recorded in `actions-lock.json`, as it may have moved upstream, without changing which versions the workflows use:

```sh
gh aw compile --no-check-update --force-refresh-container-pins
```

Renovate does not pass `--force-refresh-action-pins`, because it empties the cache of action pins, which drops any pin newer than the CLI's own back to the CLI's version.
Actions whose ref moved upstream are updated as digest updates instead.

### Version of the `gh aw` CLI

Unless the branch upgrades the CLI, Renovate compiles with the version of the CLI that the repository already uses, which it reads from the version of the setup action in `actions-lock.json`.
This keeps an update from also carrying the changes of a newer compiler.
If there is no such entry, then Renovate installs the latest release.

To use a different version, set the `ghAw` constraint:

```json
{
  "constraints": {
    "ghAw": "v1.0.1"
  }
}
```

The version must be a full release tag, as in the example above.

You can also control the `gh` CLI version using `constraints.gh`.

!!! note
  With [`binarySource=global`](../../../self-hosted-configuration.md#binarysource), Renovate does _not_ install or re-pin the extension, as Renovate uses the tools installed by your administrator's deployment.
  Both `gh` and the `gh-aw` extension must already be available, and specifying `ghAw` and `gh` in your repository's `constraints` will be ignored.
  Renovate therefore does not upgrade the CLI with this `binarySource`, and skips the setup action as `unsupported`: `gh aw compile` never pins it beyond the installed CLI, so the update would be undone.
  Upgrade the extension in your deployment instead.
  Updates of other actions and images are compiled with the installed CLI, which may add changes of its own when it differs from the version the repository was compiled with.

!!! note
  `gh aw compile` resolves refs which are not yet in `actions-lock.json` through the GitHub API, so it needs a token.
  Renovate passes the token in the same way as for the [`github-actions` lockfile](../github-actions/index.md#github-actions-lockfile-actionslock).
