"""Bytes of the npm package: committed size at HEAD of the files listed in package.json "files". Prints shipped_bytes=<n>."""
import subprocess

EXACT = {
    "bin/normwind.mjs",
    "docs/reference/canonical-replacements.json",
    "docs/reference/canonical-replacements.md",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
}
GLOB_DIRS = ("lib", "lib/vendor")  # direct *.mjs children only

listing = subprocess.run(["git", "ls-tree", "-r", "-l", "-z", "HEAD"], capture_output=True, check=True).stdout
total = 0
for entry in listing.split(b"\0"):
    if not entry:
        continue
    meta, path = entry.decode("utf-8", "replace").split("\t", 1)
    size = meta.split()[3]
    if size == "-":
        continue
    parent, _, name = path.rpartition("/")
    if path in EXACT or (parent in GLOB_DIRS and name.endswith(".mjs")):
        total += int(size)
print(f"shipped_bytes={total}")
