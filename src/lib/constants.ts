export const FORUM_PER_PAGE = 50;

/**
 * Gates for the "most active"/"most viewed" rankings on member pages. Both rank
 * threads the member *started*, so the sample size that matters is how many
 * threads they opened — not their post count, which is mostly replies elsewhere.
 */
export const MEMBER_RANKING_MIN_THREADS = 5;

/** A ranking of one or two entries isn't a ranking, it's just the member's threads. */
export const MEMBER_RANKING_MIN_ENTRIES = 3;
