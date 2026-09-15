# Third-party notices

NormWind is MIT licensed (see `LICENSE`). This file lists source code vendored
into the repository from other MIT-licensed projects, as distinct from the
npm dependencies declared in `package.json`.

## `lib/vendor/tailwind-classname-groups.mjs`

Copied from [`eslint-plugin-tailwindcss`](https://github.com/francoismassart/eslint-plugin-tailwindcss)
v3.18.3's `lib/config/groups.js` (the Tailwind CSS utility-classname group
table `lib/shorthand-families.mjs` derives its shorthand-family data from).
`eslint-plugin-tailwindcss` 4.x replaced that static table with a live
Tailwind-engine query and no longer ships or exports an equivalent, so this
is a one-time snapshot rather than something a version bump can update -
see the header comment in the vendored file for details.

MIT License

Copyright (c) Francois Massart

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
