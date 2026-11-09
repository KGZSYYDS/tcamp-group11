# UI sources and adaptations

## Magic UI — MIT

Upstream: https://github.com/magicuidesign/magicui
Pinned revision: `37ce829f18dd7d0a7219531a4249b664419933ea`

Adapted from `apps/www/registry/magicui/`:
- `ripple-button.tsx` → `components/calendar/ui/RippleButton.tsx`: button-local click waves, keyboard origin, cleanup, reduced motion.


MIT License

Copyright (c) Magic UI

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


## Design references (no copied source/assets)

- Sectograph: https://sectograph.com/ — full-day circular schedule. Our interval partitioning and paged collision tracks are implemented locally; do not imply Sectograph uses the same algorithm.
- Existing React Bits Dock / Animated Content and Motion Primitives remain in use; this file records additions in this revision.

The proposed night theme and its theme switch / border beam were removed after review. Layout fixes and Ripple Button remain.
