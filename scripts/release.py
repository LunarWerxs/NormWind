#!/usr/bin/env python3
"""
NormWind release script.

Usage:
    python scripts/release.py <new-version> [--message "optional commit message"]

Example:
    python scripts/release.py 3.0.4
    python scripts/release.py 3.1.0 --message "feat: add new canonical rules"

What it does:
    0. Pre-flight (no mutation): runs the complete npm test gate and validates
       git state (on main, clean tree, not behind origin/main) and GitHub
       credentials.
    1. Bumps the version in package.json and syncs package-lock.json, then
       runs `npm publish --dry-run` at the new version to catch npm
       packaging/version-collision problems before anything is pushed (the
       bump is restored if the dry-run fails).
    2. Commits, tags, and pushes to GitHub (preferring GITHUB_TOKEN from the
       process environment, then the gh CLI keyring, then github_pat from .env)
    3. Creates a GitHub release via the API
    4. Waits for the "Release" GitHub Actions workflow (triggered by the tag
       push) to publish to npm with --provenance, then verifies the new
       version is live on the registry. Pass --publish-locally to publish
       from this machine instead (requires NODE_AUTH_TOKEN in .env).

Single source of truth:
    bin/normwind.mjs is the only CLI implementation. There is no longer a
    parallel "editable master" in scripts/. Edit bin/normwind.mjs directly.
"""

import argparse
import base64
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# --------------------------------------------------------------------------- #
# Paths                                                                        #
# --------------------------------------------------------------------------- #

ROOT = Path(__file__).resolve().parent.parent  # repo root
PACKAGE_JSON = ROOT / "package.json"
README_FILE = ROOT / "README.md"
ENV_FILE = ROOT / ".env"

GITHUB_REPO = "LunarWerxs/NormWind"
NPM_REGISTRY = "https://registry.npmjs.org/"


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #


def load_env(path: Path) -> dict[str, str]:
    """Parse a simple KEY=value .env file (no shell expansion)."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def release_notes_from_readme(new_version: str) -> str:
    """Build release notes from the matching detailed README changelog entry.

    A release without an authored changelog is a release-preparation error,
    not a reason to publish placeholder text. Explicit --release-notes and
    --release-notes-file values can still override this default.
    """
    readme = README_FILE.read_text(encoding="utf-8")
    version = re.escape(new_version)
    pattern = re.compile(
        rf"<details>\s*"
        rf"<summary><strong>v{version}</strong>(?P<summary>.*?)</summary>\s*"
        rf"(?:<br\s*/?>\s*)?"
        rf"(?P<body>.*?)\s*</details>",
        re.DOTALL,
    )
    match = pattern.search(readme)
    if not match:
        sys.exit(
            f"README.md has no detailed v{new_version} changelog entry. "
            "Author it before releasing, or pass --release-notes / "
            "--release-notes-file explicitly."
        )

    body = match.group("body").strip()
    if not body or not re.search(r"(?m)^-\s+\S", body):
        sys.exit(
            f"README.md's v{new_version} changelog entry has no bullet details. "
            "Author the actual changes before releasing."
        )

    summary_html = match.group("summary").strip()
    summary_text = html.unescape(re.sub(r"<[^>]+>", "", summary_html)).strip()
    summary_text = summary_text.removeprefix("—").strip()
    intro = f"## NormWind v{new_version}"
    if summary_text:
        intro += f"\n\n_{summary_text}_"

    tags = subprocess.run(
        ["git", "tag", "--sort=-version:refname"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    previous_tag = next(
        (
            tag.strip()
            for tag in tags.stdout.splitlines()
            if tag.strip() and tag.strip() != f"v{new_version}"
        ),
        None,
    )
    comparison = ""
    if previous_tag:
        comparison = (
            f"\n\n**Full comparison:** "
            f"[{previous_tag}...v{new_version}]"
            f"(https://github.com/{GITHUB_REPO}/compare/{previous_tag}...v{new_version})"
        )

    return f"{intro}\n\n{body}{comparison}"


def run(cmd: list[str], cwd: Path | None = None, env_extra: dict | None = None, display: str | None = None) -> str:
    """Run a subprocess, print command, raise on failure, return stdout.

    Pass `display` to override the echoed command line when the real one
    contains a credential that must not reach the console or logs."""
    print(f"  $ {display or ' '.join(cmd)}")
    merged_env = {**os.environ, **(env_extra or {})}
    result = subprocess.run(
        cmd,
        cwd=str(cwd or ROOT),
        capture_output=True,
        text=True,
        env=merged_env,
    )
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.returncode != 0:
        print(result.stderr.rstrip(), file=sys.stderr)
        sys.exit(f"Command failed with exit code {result.returncode}")
    return result.stdout.strip()


def run_streamed(cmd: list[str], cwd: Path | None = None, env_extra: dict | None = None) -> int:
    """Run a subprocess with output streamed live to the console as it runs.

    Unlike run(), this does not capture output, so the operator sees each
    line as it is produced (important for a long-running test suite).
    Returns the process return code instead of exiting on failure, so the
    caller can decide how to react.
    """
    print(f"  $ {' '.join(cmd)}")
    merged_env = {**os.environ, **(env_extra or {})}
    result = subprocess.run(
        cmd,
        cwd=str(cwd or ROOT),
        env=merged_env,
    )
    return result.returncode


def step(label: str) -> None:
    print(f"\n{'='*60}\n  {label}\n{'='*60}")


def github_api(method: str, path: str, body: dict | None, token: str) -> dict:
    """Make a GitHub REST API call and return the parsed JSON response."""
    url = f"https://api.github.com{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "normwind-release-script",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        sys.exit(f"GitHub API error {exc.code}: {body_text}")


# --------------------------------------------------------------------------- #
# Pre-flight checks                                                            #
# --------------------------------------------------------------------------- #


def gh_cli_token_fallback() -> str:
    """Best-effort: pull a token for the repo owner from the `gh` CLI keyring
    when .env has no github_pat. Returns "" when gh is absent or logged out."""
    owner = GITHUB_REPO.split("/")[0]
    for args in (["gh", "auth", "token", "--user", owner], ["gh", "auth", "token"]):
        try:
            result = subprocess.run(args, capture_output=True, text=True)
        except FileNotFoundError:
            return ""
        token = result.stdout.strip()
        if result.returncode == 0 and token:
            print(f"  Using the `gh` CLI credential for {owner}.")
            return token
    return ""


def assert_github_credentials(github_pat: str) -> None:
    step("0c/4  Validate GitHub credentials")
    repo = github_api("GET", f"/repos/{GITHUB_REPO}", None, github_pat)
    perms = repo.get("permissions") or {}
    if not perms.get("push"):
        sys.exit(
            f"The GitHub token authenticates but lacks push permission on {GITHUB_REPO}. "
            "Refresh github_pat in .env with a token that has write access "
            "(fine-grained PAT: Contents read/write), or `gh auth login`."
        )
    print(f"  Token OK: push access to {GITHUB_REPO} confirmed.")


def run_test_gate() -> None:
    step("0a/4  Run pre-push test suite")
    print("  $ npm test")
    if os.name == "nt":
        command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", "npm", "test"]
    else:
        command = ["npm", "test"]
    returncode = run_streamed(command, cwd=ROOT)
    if returncode != 0:
        sys.exit(
            "Test gate failed (npm test exited "
            f"{returncode}). See output above for which check failed. "
            "Fix the failing check and re-run release.py; nothing has "
            "been modified."
        )
    print("  Test suite passed.")


def assert_git_state() -> None:
    step("0b/4  Validate git state")

    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if branch != "main":
        sys.exit(
            f"Refusing to release from branch {branch!r}. "
            "Check out main first: git checkout main"
        )
    print(f"  On branch: {branch}")

    dirty = run(["git", "status", "--porcelain"])
    if dirty:
        sys.exit(
            "Working tree is not clean. Commit, stash, or discard your "
            "changes before releasing:\n" + dirty
        )
    print("  Working tree is clean.")

    run(["git", "fetch", "origin", "main", "--quiet"])
    behind_count = run(["git", "rev-list", "--count", "HEAD..origin/main"])
    if behind_count != "0":
        sys.exit(
            f"Local main is behind origin/main by {behind_count} commit(s). "
            "Pull first: git pull origin main"
        )
    print("  Local main is up to date with origin/main.")


def _npm_userconfig(npm_token: str) -> str:
    """Write a temporary .npmrc so the token never touches the project
    directory. Returns the path; caller is responsible for deleting it."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".npmrc", delete=False, encoding="utf-8") as f:
        f.write(f"//registry.npmjs.org/:_authToken={npm_token}\n")
        return f.name


def _npm_run(npm_args: list[str]) -> None:
    """Invoke npm with the given args, routing through cmd.exe on Windows
    since `npm` is a .cmd shim that Python's subprocess can't resolve
    without going through the shell."""
    if sys.platform == "win32":
        comspec = os.environ.get("ComSpec", "cmd.exe")
        run([comspec, "/d", "/s", "/c", "npm", *npm_args])
    else:
        run(["npm", *npm_args])


def npm_dry_run(npm_token: str) -> None:
    step("1b/4  npm publish dry run (at the new version)")
    tmp_npmrc = _npm_userconfig(npm_token)
    try:
        npm_args = [
            "publish",
            "--dry-run",
            f"--registry={NPM_REGISTRY}",
            "--access",
            "public",
            f"--userconfig={tmp_npmrc}",
        ]
        _npm_run(npm_args)
    finally:
        os.unlink(tmp_npmrc)
    print("  Dry run succeeded; npm publish is expected to work at the end of the release.")


# --------------------------------------------------------------------------- #
# Release steps                                                                #
# --------------------------------------------------------------------------- #


def bump_version(new_version: str) -> str:
    step("1/4  Bump version in package.json")
    pkg = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    old_version = pkg["version"]
    if old_version == new_version:
        print(f"  Already at {new_version}, nothing to bump.")
    else:
        pkg["version"] = new_version
        PACKAGE_JSON.write_text(
            json.dumps(pkg, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"  {old_version} -> {new_version}")

    print("  Syncing package-lock.json (npm install --package-lock-only)")
    _npm_run(["install", "--package-lock-only"])

    return old_version


def git_commit_tag_push(new_version: str, message: str, github_pat: str) -> None:
    step("2/4  Git commit, tag, and push")

    # The tree was clean at preflight and the release only owns these files.
    # Staging everything could accidentally commit an unrelated file created
    # by an editor or background process after that check.
    run(["git", "add", "--", "package.json", "package-lock.json"])
    run(["git", "commit", "-m", message])

    tag = f"v{new_version}"
    run(["git", "tag", tag])

    # Pass the PAT to this one git process through an ephemeral config
    # environment. It never appears in argv or .git/config, so an interruption
    # cannot leave a credential embedded in the repository's remote URL.
    basic_auth = base64.b64encode(
        f"x-access-token:{github_pat}".encode("utf-8")
    ).decode("ascii")
    git_auth_env = {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic_auth}",
    }
    run(
        ["git", "push", "--atomic", "origin", "main", tag],
        env_extra=git_auth_env,
        display=f"git push --atomic origin main {tag}",
    )

    print(f"  Pushed main + tag {tag}")


def create_github_release(new_version: str, release_body: str, github_pat: str) -> str:
    step("3/4  Create GitHub release")
    tag = f"v{new_version}"
    resp = github_api(
        "POST",
        f"/repos/{GITHUB_REPO}/releases",
        {
            "tag_name": tag,
            "name": tag,
            "body": release_body,
            "draft": False,
            "prerelease": False,
        },
        github_pat,
    )
    url = resp.get("html_url", "(unknown)")
    print(f"  Release created: {url}")
    return url


def npm_publish(new_version: str, npm_token: str) -> None:
    step("4/4  Publish to npm")
    tmp_npmrc = _npm_userconfig(npm_token)

    try:
        npm_args = [
            "publish",
            f"--registry={NPM_REGISTRY}",
            "--access",
            "public",
            f"--userconfig={tmp_npmrc}",
        ]
        try:
            _npm_run(npm_args)
        except SystemExit:
            print_publish_recovery_instructions(new_version)
            raise
    finally:
        os.unlink(tmp_npmrc)

    # Remove any .tgz artefact npm may have left in the repo directory.
    for tgz in ROOT.glob("*.tgz"):
        tgz.unlink()
        print(f"  Removed leftover tarball: {tgz.name}")


def await_actions_publish(new_version: str, github_pat: str) -> None:
    """Wait for the tag-triggered "Release" workflow to publish to npm, then
    confirm the version is actually live on the registry."""
    step("4/4  Await GitHub Actions npm publish")
    tag = f"v{new_version}"
    deadline = time.time() + 15 * 60
    run_id = None
    last_status = None

    while time.time() < deadline:
        if run_id is None:
            listing = github_api(
                "GET",
                f"/repos/{GITHUB_REPO}/actions/runs?event=push&branch={tag}&per_page=10",
                None,
                github_pat,
            )
            for candidate in listing.get("workflow_runs", []):
                if candidate.get("name") == "Release":
                    run_id = candidate["id"]
                    print(f"  Found workflow run: {candidate['html_url']}")
                    break
            if run_id is None:
                time.sleep(5)
                continue

        run_info = github_api(
            "GET", f"/repos/{GITHUB_REPO}/actions/runs/{run_id}", None, github_pat,
        )
        status = run_info.get("status")
        if status != last_status:
            print(f"  Workflow status: {status}")
            last_status = status
        if status == "completed":
            conclusion = run_info.get("conclusion")
            if conclusion != "success":
                sys.exit(
                    f"Release workflow finished with conclusion {conclusion!r}: "
                    f"{run_info.get('html_url')}\n"
                    "Inspect the logs, fix the problem, then either re-run the "
                    "workflow from the Actions UI (it re-publishes the same tag) "
                    f"or run: python scripts/release.py {new_version} --publish-locally"
                )
            break
        time.sleep(10)
    else:
        sys.exit(
            f"Timed out waiting for the Release workflow on tag {tag}. "
            f"Check https://github.com/{GITHUB_REPO}/actions and re-run it, or "
            f"use --publish-locally."
        )

    # Confirm registry visibility (propagation is usually seconds).
    registry_deadline = time.time() + 120
    while time.time() < registry_deadline:
        req = urllib.request.Request(
            "https://registry.npmjs.org/@lunawerx%2fnormwind",
            headers={"Accept": "application/vnd.npm.install-v1+json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                packument = json.loads(resp.read())
            if new_version in (packument.get("versions") or {}):
                print(f"  Verified: @lunawerx/normwind@{new_version} is live on npm.")
                return
        except urllib.error.URLError:
            pass
        time.sleep(5)

    sys.exit(
        f"The Release workflow succeeded but @lunawerx/normwind@{new_version} "
        "has not appeared on the registry after 2 minutes — check npm manually."
    )


def print_publish_recovery_instructions(new_version: str) -> None:
    tag = f"v{new_version}"
    print(
        "\n"
        "npm publish FAILED. The git tag and GitHub release for this "
        "version were already pushed, but the npm package was NOT "
        "published. To recover:\n"
        "\n"
        "  1. Delete the pushed tag:\n"
        f"       git push origin :refs/tags/{tag}\n"
        f"       git tag -d {tag}\n"
        "\n"
        "  2. Delete the GitHub release (the tag deletion above does not "
        "remove it):\n"
        f"       https://github.com/{GITHUB_REPO}/releases  (delete the {tag} release in the UI)\n"
        "     or via the API:\n"
        f"       gh release delete {tag} --repo {GITHUB_REPO} --yes\n"
        "\n"
        "  3. Fix the npm publish issue (auth token, network, version "
        "conflict, etc).\n"
        "\n"
        f"  4. Re-run: python scripts/release.py {new_version}\n"
        "     This is safe to re-run with the same version once the tag "
        "and release above are cleaned up.\n",
        file=sys.stderr,
    )


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #


def main() -> None:
    parser = argparse.ArgumentParser(description="Release @lunawerx/normwind to npm and GitHub.")
    parser.add_argument("version", help="New semver version, e.g. 3.0.4")
    parser.add_argument(
        "--message",
        "-m",
        default=None,
        help="Git commit message (default: auto-generated from version)",
    )
    parser.add_argument(
        "--release-notes",
        default=None,
        help="GitHub release body text (default: matching detailed README changelog)",
    )
    parser.add_argument(
        "--release-notes-file",
        default=None,
        help="Path to a Markdown file to use as the GitHub release body. Wins over --release-notes.",
    )
    parser.add_argument(
        "--publish-locally",
        action="store_true",
        help="Publish to npm from this machine (requires NODE_AUTH_TOKEN in .env) "
        "instead of waiting for the tag-triggered GitHub Actions publish.",
    )
    args = parser.parse_args()

    new_version = args.version.removeprefix("v")

    # Validate SemVer 2.0.0, including optional prerelease/build identifiers.
    semver_pattern = (
        r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
        r"(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
        r"(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
        r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    )
    if not re.fullmatch(semver_pattern, new_version):
        sys.exit(f"Invalid version: {new_version!r}  (expected e.g. 3.0.4)")

    # Load credentials.
    env = load_env(ENV_FILE)
    github_pat = (
        os.environ.get("GITHUB_TOKEN", "")
        or gh_cli_token_fallback()
        or env.get("github_pat", "")
    )
    npm_token = os.environ.get("NODE_AUTH_TOKEN", "") or env.get("NODE_AUTH_TOKEN", "")

    if not github_pat:
        sys.exit(
            "No GitHub credential was available. Run `gh auth login`, set "
            "GITHUB_TOKEN in the process environment, or add a fine-grained "
            f"PAT (Contents: read/write on {GITHUB_REPO}) to {ENV_FILE}."
        )
    # npm credentials are only needed on this machine for --publish-locally;
    # the normal path publishes from GitHub Actions using the NPM_TOKEN
    # repository secret. The pre-flight `npm publish --dry-run` never
    # contacts the registry with the token, so a placeholder is fine there.
    if args.publish_locally and not npm_token:
        sys.exit(
            "NODE_AUTH_TOKEN was not found in the process environment or "
            f"{ENV_FILE} (required for --publish-locally)"
        )

    commit_message = args.message or (f"release: publish {new_version}")

    if args.release_notes_file:
        notes_path = Path(args.release_notes_file).resolve()
        if not notes_path.exists():
            sys.exit(f"--release-notes-file does not exist: {notes_path}")
        release_notes = notes_path.read_text(encoding="utf-8")
    elif args.release_notes:
        release_notes = args.release_notes
    else:
        release_notes = release_notes_from_readme(new_version)

    print(f"\nReleasing @lunawerx/normwind v{new_version}\n")

    # Pre-flight checks below must all pass before we touch git. The npm
    # dry-run has to happen AFTER the local version bump — npm validates the
    # manifest version against the registry even in dry-run mode, so running
    # it at the old (already-published) version always fails. The bump is
    # local-only at that point; on dry-run failure it is restored so the
    # tree is left clean and nothing was pushed or published.
    run_test_gate()
    assert_git_state()
    assert_github_credentials(github_pat)

    try:
        bump_version(new_version)
        npm_dry_run(npm_token)
    except SystemExit:
        run(["git", "restore", "--", "package.json", "package-lock.json"])
        print(
            "Version preparation or npm publish dry-run failed. Restored package.json / "
            "package-lock.json; nothing was pushed or published.",
            file=sys.stderr,
        )
        raise

    git_commit_tag_push(new_version, commit_message, github_pat)
    create_github_release(new_version, release_notes, github_pat)
    if args.publish_locally:
        npm_publish(new_version, npm_token)
    else:
        await_actions_publish(new_version, github_pat)

    print(f"\nDone. v{new_version} is live on npm and GitHub.\n")


if __name__ == "__main__":
    main()
