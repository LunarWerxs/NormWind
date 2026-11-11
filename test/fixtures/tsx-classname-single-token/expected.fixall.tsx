// Holds audit finding F-30: a class attribute in a .tsx file is a class list
// by position, so a lone arbitrary value in it is fixed by --fixall, not just
// reported (fix-then-audit used to never converge).
export const A = () => <div className="w-4" />;
export const B = () => <div className="flex w-4" />;
export const C = () => <div className="rounded-3xl items-center" />;
