// Values shared across modules that have no better home. Kept tiny on purpose:
// a grab-bag constants module is a smell once it grows.

// Tailwind's rem base. Canonicalization results depend on it, which is why the
// generated snapshot records it and refuses to load under a different one.
export const ROOT_FONT_SIZE_PX = 16;
