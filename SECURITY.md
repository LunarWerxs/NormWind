# Security policy

## Supported versions

Security fixes are applied to the latest NormWind release. Action users should follow the current major tag or pin the latest immutable release/commit.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** flow on the repository Security tab so details remain private. Do not open a public issue for a suspected vulnerability.

Include the affected version, runner operating system, a minimal reproduction, and the impact you believe is possible. Reports about scanning untrusted repositories, path handling, workflow-command injection, dependency loading, and autofix integrity are especially useful.

You can expect an acknowledgement within five business days. No vulnerability disclosure or bug-bounty payment is promised, but good-faith research will be handled respectfully.

## Action permissions and data handling

The Marketplace Action requires only repository contents read access supplied by `actions/checkout`. It does not request a GitHub token, call a NormWind service, or send source code or findings off the runner. Version 3.x audits only and does not modify the checked-out repository.

Action mode treats checked-out files as hostile input. It uses only its bundled parser, Tailwind runtime, and canonical snapshot; disables external repository tools and disk caching; removes GitHub tokens and arbitrary secrets from the scanner environment; confines source and theme-import reads to the workspace; rejects directory symlinks; and enforces file, byte, output-buffer, and execution-time limits. It also sets `NORMWIND_NO_PING=1` on the scanner subprocess, so the statement above holds without exception: Action mode never calls a NormWind service.

## CLI install ping

Outside Action mode, the local CLI makes one anonymous network call: a `GET` to `https://studio.connections.icu/v1/app/normwind/latest`, at most once every 24 hours per machine. The request carries only the running NormWind version, a coarse OS tag, and a random install id, nothing that identifies you, your files, or your project; see the README's "Privacy" section for the full disclosure and the opt-out. The endpoint doubles as the update check: it returns the same JSON shape as GitHub's `releases/latest` API for this repository.
